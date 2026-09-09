import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";

import {
  planWorldLabsGeneration, WORLD_LABS_MODEL, WORLD_LABS_TEXT_CREDITS,
  WorldLabsAttemptSummarySchema, WorldLabsBudgetSchema, WorldLabsGenerationInputSchema,
  WorldLabsIdSchema, WorldLabsRetainedSchema, WorldLabsWorldMetadataSchema,
  WorldLabsProviderRequestSchema, WorldLabsProvenanceSchema,
  type WorldLabsAttemptSummary, type WorldLabsService,
} from "../application/world-labs-port";
import { canonicalJson, canonicalJsonSha256 } from "../core/canonical-json";
import { createNodeBundleFileSystem } from "../core/storage";
import { createBoundedGatewayMediaDownload, type GatewayMediaDownload } from "./gateway-media-service";

const ORIGIN = "https://api.worldlabs.ai";
const ROOT = "artifacts/atet/generated/worlds";
const JSON_BYTES = 256 * 1024;
const ASSET_BYTES = 128 * 1024 * 1024;
const API_TIMEOUT_MS = 120_000;

export type WorldLabsErrorCode = "invalid-request" | "permission-required" | "credential-unavailable"
  | "budget-exhausted" | "price-mismatch" | "conflict" | "attempt-unavailable" | "provider-unavailable"
  | "invalid-response" | "download-failed" | "unsafe-artifact";
export type WorldLabsFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
const ERRORS: Readonly<Record<WorldLabsErrorCode, string>> = {
  "invalid-request": "The World Labs request is invalid.",
  "permission-required": "World Labs requires a separate adapter grant for this action.",
  "credential-unavailable": "Set WORLDLABS_API_KEY in the command environment.",
  "budget-exhausted": "The named World Labs budget has no unreserved generation slot. Ambiguous reservations remain charged against the local limit.",
  "price-mismatch": "World Labs reported a cost above the pinned estimate. This named budget is quarantined; inspect its settled costs and reauthorize current pricing before any new paid study.",
  "conflict": "World Labs attempt or budget evidence conflicts. Generation is never automatically resubmitted.",
  "attempt-unavailable": "The World Labs attempt could not be read.",
  "provider-unavailable": "World Labs could not be reached safely. Resume the retained operation; do not repeat generation.",
  "invalid-response": "World Labs returned unsupported or conflicting evidence.",
  "download-failed": "The generated world could not be retained within the safe download limits. Resume the operation to retry read-only retention.",
  "unsafe-artifact": "World Labs artifact storage failed its physical path or integrity checks.",
};
export class WorldLabsError extends Error {
  constructor(readonly code: WorldLabsErrorCode) { super(ERRORS[code]); this.name = "WorldLabsError"; }
}
function fail(code: WorldLabsErrorCode): never { throw new WorldLabsError(code); }
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const missing = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
const RequestRecordSchema = z.strictObject({
  kind: z.literal("atet.world-labs-request"), schemaVersion: z.literal(1),
  input: WorldLabsGenerationInputSchema, budget: WorldLabsBudgetSchema,
  createdAt: z.iso.datetime(), requestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  request: WorldLabsProviderRequestSchema,
});
const OperationRecordSchema = z.strictObject({
  operationId: WorldLabsIdSchema, source: z.enum(["dispatch", "operator-recovery"]),
});
const ReservationSchema = z.strictObject({
  attemptId: WorldLabsIdSchema, requestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  reservedCredits: z.literal(WORLD_LABS_TEXT_CREDITS),
});
const ReservationBindingSchema = z.strictObject({
  budgetId: WorldLabsIdSchema, slot: z.number().int().safe().nonnegative().max(632),
});
const CompletionSchema = z.strictObject({
  status: z.enum(["failed", "succeeded"]), operationId: WorldLabsIdSchema,
  responseSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  settledCredits: z.number().int().safe().nonnegative().optional(),
});
const SettledCostSchema = z.strictObject({
  operationId: WorldLabsIdSchema, reservedCredits: z.literal(WORLD_LABS_TEXT_CREDITS),
  settledCredits: z.number().int().safe().nonnegative(),
});
const PriceMismatchSchema = z.strictObject({
  kind: z.literal("atet.world-labs-price-mismatch"), schemaVersion: z.literal(1),
  budgetId: WorldLabsIdSchema, attemptId: WorldLabsIdSchema, operationId: WorldLabsIdSchema,
  reservedCredits: z.literal(WORLD_LABS_TEXT_CREDITS),
  settledCredits: z.number().int().safe().min(WORLD_LABS_TEXT_CREDITS + 1),
  responseSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
const RawWorldSchema = z.object({
  world_id: WorldLabsIdSchema.optional(), id: WorldLabsIdSchema.optional(),
  model: z.literal(WORLD_LABS_MODEL),
  display_name: z.string().min(1).max(256),
  assets: z.object({
    splats: z.object({
      spz_urls: z.record(z.string().max(32), z.string().max(8_192)),
      semantics_metadata: z.object({
        ground_plane_offset: z.number().finite().min(-1_000_000).max(1_000_000).nullish(),
        metric_scale_factor: z.number().finite().positive().max(1_000_000).nullish(),
      }).nullish(),
    }),
    mesh: z.object({ collider_mesh_url: z.string().max(8_192) }),
  }),
}).refine(world => (world.world_id !== undefined || world.id !== undefined)
  && (world.world_id === undefined || world.id === undefined || world.world_id === world.id));
const RawOperationSchema = z.object({
  operation_id: WorldLabsIdSchema, done: z.boolean(),
  error: z.object({ code: z.number().int(), message: z.string().max(16_000) }).nullish(),
  cost: z.object({ total_credits: z.number().int().safe().nonnegative() }).nullish(),
  response: z.unknown().optional(),
});
type RawOperation = z.infer<typeof RawOperationSchema>;

function parse<Value>(schema: z.ZodType<Value>, value: unknown, code: WorldLabsErrorCode): Value {
  const result = schema.safeParse(value);
  return result.success ? result.data : fail(code);
}

function assetUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { return fail("invalid-response"); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== ""
    || (url.port !== "" && url.port !== "443")) fail("invalid-response");
  return url;
}

function worldPayload(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  if (!("world" in value)) return value;
  // Current reference uses a flat World; the documented quickstart also uses
  // a {world: World} envelope. Never select one of two competing identities.
  if ("world_id" in value || "id" in value || "assets" in value || "model" in value) fail("invalid-response");
  return value.world;
}

async function boundedJson(response: Response): Promise<{ value: unknown; sha256: string }> {
  if (!response.ok || response.redirected || response.status >= 300 || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    return fail("provider-unavailable");
  }
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > JSON_BYTES)) {
    await response.body.cancel().catch(() => undefined); fail("invalid-response");
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > JSON_BYTES) { await reader.cancel().catch(() => undefined); fail("invalid-response"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown, sha256: sha256(bytes) }; }
  catch { return fail("invalid-response"); }
}

export function createWorldLabsService(options: Readonly<{
  repositoryRoot: string;
  /** Private adapter dependency; never put a credential in a request or receipt. */
  loadCredential?: () => Promise<string>;
  fetch?: WorldLabsFetch;
  download?: GatewayMediaDownload;
  now?: () => Date;
  /** Recheck adapter-owned host custody immediately before writes or dispatch. */
  assertOwned?: () => Promise<void>;
}>): WorldLabsService {
  const root = options.repositoryRoot;
  const fileSystem = createNodeBundleFileSystem(root);
  const fetch = options.fetch ?? globalThis.fetch;
  // This existing transport resolves and pins public DNS addresses on every hop,
  // bounds redirects and bytes, and sends no credential/cookie headers.
  const download = options.download ?? createBoundedGatewayMediaDownload({ maximumBytes: ASSET_BYTES, timeoutMs: API_TIMEOUT_MS });
  const now = options.now ?? (() => new Date());
  const loadCredential = options.loadCredential ?? (async () => process.env["WORLDLABS_API_KEY"] ?? "");
  const attemptPath = (id: string): string => `${ROOT}/attempts/${parse(WorldLabsIdSchema, id, "invalid-request")}`;

  async function physical(): Promise<void> {
    if (!isAbsolute(root) || await realpath(root) !== root || !(await lstat(root)).isDirectory()) fail("unsafe-artifact");
  }
  async function read<Value>(path: string, schema: z.ZodType<Value>): Promise<Value | undefined> {
    await physical();
    let raw: string;
    try { raw = await fileSystem.readText(path, JSON_BYTES); }
    catch (error) { if (missing(error)) return undefined; return fail("unsafe-artifact"); }
    try { return parse(schema, JSON.parse(raw) as unknown, "conflict"); }
    catch { return fail("conflict"); }
  }
  function assertNotAborted(signal?: AbortSignal): void {
    if (signal?.aborted === true) fail("provider-unavailable");
  }
  async function assertActive(signal?: AbortSignal): Promise<void> {
    assertNotAborted(signal);
    await options.assertOwned?.();
    assertNotAborted(signal);
  }
  async function publish(path: string, value: unknown, signal?: AbortSignal): Promise<"created" | "exists"> {
    await assertActive(signal);
    await physical();
    const bytes = `${canonicalJson(value)}\n`;
    if (Buffer.byteLength(bytes) > JSON_BYTES) fail("invalid-response");
    try { return await fileSystem.writeTextNoReplace!(path, bytes, () => assertActive(signal)); }
    catch { return fail("unsafe-artifact"); }
  }
  async function publishExact(path: string, value: unknown, signal?: AbortSignal): Promise<void> {
    if (await publish(path, value, signal) === "exists") {
      const original = await fileSystem.readText(path, JSON_BYTES);
      if (original !== `${canonicalJson(value)}\n`) fail("conflict");
    }
  }
  // Newly created ancestors must also be durable before an irreversible POST.
  async function syncAncestors(path: string): Promise<void> {
    let directory = dirname(join(root, path));
    while (true) {
      if (await realpath(directory) !== directory) fail("unsafe-artifact");
      const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await handle.sync(); } finally { await handle.close(); }
      if (directory === root) break;
      directory = dirname(directory);
    }
  }
  async function requestRecord(id: string) {
    const record = await read(`${attemptPath(id)}/request.json`, RequestRecordSchema);
    if (record === undefined) return fail("attempt-unavailable");
    if (record.input.attemptId !== id || planWorldLabsGeneration(record.input).requestSha256 !== record.requestSha256
      || canonicalJsonSha256(record.request) !== record.requestSha256) fail("conflict");
    return record;
  }
  async function credential(): Promise<string> {
    let value: string;
    try { value = await loadCredential(); } catch { return fail("credential-unavailable"); }
    if (typeof value !== "string" || value.length < 1 || value.length > 8_192 || /[\s\u0000-\u001f\u007f]/u.test(value)) fail("credential-unavailable");
    return value;
  }
  async function assertBudgetAvailable(budgetId: string): Promise<void> {
    const mismatch = await read(`${ROOT}/budgets/${budgetId}/price-mismatch.json`, PriceMismatchSchema);
    if (mismatch !== undefined) {
      if (mismatch.budgetId !== budgetId) fail("conflict");
      fail("price-mismatch");
    }
  }
  async function api(path: string, key: string, signal: AbortSignal | undefined, body?: unknown, beforePost?: () => Promise<void>) {
    const timeout = AbortSignal.timeout(API_TIMEOUT_MS);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    try {
      await assertActive(combined);
      await beforePost?.();
      const response = await fetch(`${ORIGIN}/marble/v1/${path}`, {
        method: body === undefined ? "GET" : "POST", redirect: "error", signal: combined,
        headers: { "WLT-Api-Key": key, "Content-Type": "application/json", accept: "application/json" },
        ...(body === undefined ? {} : { body: canonicalJson(body) }),
      });
      return await boundedJson(response);
    } catch (error) {
      if (error instanceof WorldLabsError) throw error;
      return fail("provider-unavailable");
    }
  }
  async function reserve(record: z.infer<typeof RequestRecordSchema>, signal?: AbortSignal): Promise<void> {
    await assertBudgetAvailable(record.budget.budgetId);
    const path = `${ROOT}/budgets/${record.budget.budgetId}`;
    await publishExact(`${path}/budget.json`, record.budget, signal);
    const reservation = { attemptId: record.input.attemptId, requestSha256: record.requestSha256, reservedCredits: WORLD_LABS_TEXT_CREDITS };
    const slots = Math.floor(record.budget.maximumCredits / WORLD_LABS_TEXT_CREDITS);
    for (let slot = 0; slot < slots; slot += 1) {
      const reservationPath = `${path}/reservation-${slot}.json`;
      if (await publish(reservationPath, reservation, signal) === "created") {
        await publishExact(`${attemptPath(record.input.attemptId)}/reservation.json`, { budgetId: record.budget.budgetId, slot }, signal);
        await syncAncestors(reservationPath);
        return;
      }
    }
    fail("budget-exhausted");
  }
  async function inspect(input: Readonly<{ attemptId: string }>): Promise<WorldLabsAttemptSummary> {
    const record = await requestRecord(input.attemptId);
    const path = attemptPath(input.attemptId);
    const operation = await read(`${path}/operation.json`, OperationRecordSchema);
    const completed = await read(`${path}/completion.json`, CompletionSchema);
    const retained = await read(`${path}/retained.json`, WorldLabsRetainedSchema);
    const settledCost = await read(`${path}/cost.json`, SettledCostSchema);
    const priceMismatch = await read(`${ROOT}/budgets/${record.budget.budgetId}/price-mismatch.json`, PriceMismatchSchema);
    if (priceMismatch !== undefined && priceMismatch.budgetId !== record.budget.budgetId) fail("conflict");
    if (settledCost !== undefined && settledCost.operationId !== operation?.operationId) fail("conflict");
    if (completed?.settledCredits !== undefined && completed.settledCredits !== settledCost?.settledCredits) fail("conflict");
    const reservation = await read(`${path}/reservation.json`, ReservationBindingSchema);
    if (reservation !== undefined) {
      const budget = await read(`${ROOT}/budgets/${reservation.budgetId}/budget.json`, WorldLabsBudgetSchema);
      const reserved = await read(`${ROOT}/budgets/${reservation.budgetId}/reservation-${reservation.slot}.json`, ReservationSchema);
      if (canonicalJson(budget ?? null) !== canonicalJson(record.budget) || reservation.budgetId !== record.budget.budgetId
        || reservation.slot >= Math.floor(record.budget.maximumCredits / WORLD_LABS_TEXT_CREDITS)
        || reserved?.attemptId !== input.attemptId || reserved.requestSha256 !== record.requestSha256) fail("conflict");
    }
    if (completed !== undefined && completed.operationId !== operation?.operationId) fail("conflict");
    if (retained !== undefined) {
      if (completed?.status !== "succeeded" || operation === undefined) fail("conflict");
      const world = await read(`${path}/world.json`, WorldLabsWorldMetadataSchema);
      if (world === undefined || canonicalJsonSha256(world) !== completed.responseSha256
        || canonicalJsonSha256(retained.world) !== completed.responseSha256) fail("conflict");
      for (const asset of [retained.splat, retained.collider, retained.provenance]) {
        if (!asset.path.startsWith(`${path}/`)) fail("conflict");
        const actual = await fileSystem.inspectFile!(asset.path, asset.bytes);
        if (actual.bytes !== asset.bytes || actual.sha256 !== asset.sha256) fail("conflict");
      }
      const provenance = await read(retained.provenance.path, WorldLabsProvenanceSchema);
      if (provenance === undefined || sha256(Buffer.from(`${canonicalJson(provenance)}\n`)) !== retained.provenance.sha256
        || provenance.attemptId !== input.attemptId || provenance.operationId !== operation?.operationId
        || provenance.operationBinding !== operation.source || provenance.requestSha256 !== record.requestSha256
        || canonicalJsonSha256(provenance.world) !== completed.responseSha256
        || provenance.settledCredits !== (completed.settledCredits ?? null)) fail("conflict");
      for (const role of ["splat", "collider"] as const) {
        const declared = provenance.assets[role], actual = retained[role];
        if (declared.path !== actual.path || declared.bytes !== actual.bytes || declared.sha256 !== actual.sha256) fail("conflict");
      }
    }
    const dispatched = await read(`${path}/dispatch.json`, z.strictObject({ requestSha256: z.literal(record.requestSha256) }));
    if ((dispatched !== undefined || operation !== undefined) && reservation === undefined) fail("conflict");
    if (operation !== undefined && dispatched === undefined) fail("conflict");
    return parse(WorldLabsAttemptSummarySchema, {
      kind: "atet.world-labs-attempt", schemaVersion: 1, attemptId: input.attemptId,
      requestSha256: record.requestSha256, model: WORLD_LABS_MODEL, quality: record.input.quality,
      status: retained !== undefined ? "retained" : completed?.status === "failed" ? "failed"
        : operation !== undefined ? "pending" : dispatched !== undefined ? "ambiguous" : "prepared",
      reservedCredits: reservation === undefined ? null : WORLD_LABS_TEXT_CREDITS,
      ...(operation === undefined ? {} : { operationId: operation.operationId }),
      ...(settledCost === undefined ? {} : { settledCredits: settledCost.settledCredits }),
      ...(priceMismatch === undefined ? {} : { budgetQuarantined: true }),
      ...(retained === undefined ? {} : { retained }),
    }, "conflict");
  }
  async function saveAsset(path: string, bytes: Uint8Array, extension: "spz" | "glb", signal?: AbortSignal) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > ASSET_BYTES) fail("download-failed");
    // Full bounded decoding belongs to the saved-world importer, after paid bytes
    // have been retained. A container failure never causes another generation.
    const expected = { bytes: bytes.length, sha256: sha256(bytes) };
    const target = `${path}/${expected.sha256}.${extension}`;
    const temporary = `${path}/.download-${randomUUID()}`;
    await assertActive(signal);
    await physical();
    if (await realpath(join(root, path)) !== join(root, path)) fail("unsafe-artifact");
    const handle = await open(join(root, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    try { await fileSystem.copyFileNoReplace!(temporary, target, expected, () => assertActive(signal)); }
    finally { await unlink(join(root, temporary)); }
    return { ...expected, path: target };
  }
  async function acceptOperation(id: string, parsed: { value: unknown; sha256: string }, signal?: AbortSignal): Promise<WorldLabsAttemptSummary> {
    // Returned provider identity and known charges are recovery evidence. Drain
    // them under the owned lease even when caller cancellation has arrived.
    await options.assertOwned?.();
    const record = await requestRecord(id);
    const binding = await read(`${attemptPath(id)}/operation.json`, OperationRecordSchema);
    const operation = parse(RawOperationSchema, parsed.value, "invalid-response");
    if (binding?.operationId !== operation.operation_id) fail("conflict");
    if (operation.done && operation.cost != null) {
      const actual = operation.cost.total_credits;
      if (actual > WORLD_LABS_TEXT_CREDITS) {
        const mismatchPath = `${ROOT}/budgets/${record.budget.budgetId}/price-mismatch.json`;
        await publish(mismatchPath, parse(PriceMismatchSchema, {
          kind: "atet.world-labs-price-mismatch", schemaVersion: 1,
          budgetId: record.budget.budgetId, attemptId: id, operationId: operation.operation_id,
          reservedCredits: WORLD_LABS_TEXT_CREDITS, settledCredits: actual, responseSha256: parsed.sha256,
        }, "invalid-response"));
        await syncAncestors(mismatchPath);
      }
      await publishExact(`${attemptPath(id)}/cost.json`, {
        operationId: operation.operation_id, reservedCredits: WORLD_LABS_TEXT_CREDITS, settledCredits: actual,
      });
    }
    await assertActive(signal);
    if (!operation.done) return await inspect({ attemptId: id });
    const path = attemptPath(id);
    // A later terminal snapshot may omit a cost already journaled before
    // cancellation or failed retention. Success and failure retain that charge.
    const knownCost = await read(`${path}/cost.json`, SettledCostSchema);
    if (knownCost !== undefined && knownCost.operationId !== operation.operation_id) fail("conflict");
    const settledCredits = knownCost?.settledCredits;
    if (operation.error != null) {
      await publishExact(`${path}/completion.json`, {
        status: "failed", operationId: operation.operation_id, responseSha256: parsed.sha256,
        ...(settledCredits === undefined ? {} : { settledCredits }),
      }, signal);
      return await inspect({ attemptId: id });
    }
    const returnedWorld = worldPayload(operation.response);
    let worldResponseSha256 = parsed.sha256;
    let worldResult = RawWorldSchema.safeParse(returnedWorld);
    if (!worldResult.success) {
      const partial = parse(z.object({ world_id: WorldLabsIdSchema.optional(), id: WorldLabsIdSchema.optional(), model: z.string().nullish(), display_name: z.string().nullish() }), returnedWorld, "invalid-response");
      const worldId = partial.world_id ?? partial.id;
      // Some documented operation snapshots omit nullable World fields. Only
      // the authenticated fixed-origin World endpoint may fill those fields.
      if (worldId === undefined || (partial.world_id !== undefined && partial.id !== undefined && partial.world_id !== partial.id)
        || (partial.model != null && partial.model !== WORLD_LABS_MODEL)) fail("invalid-response");
      const hydrated = await api(`worlds/${worldId}`, await credential(), signal);
      worldResponseSha256 = hydrated.sha256;
      worldResult = RawWorldSchema.safeParse(worldPayload(hydrated.value));
      if (!worldResult.success || (worldResult.data.world_id ?? worldResult.data.id) !== worldId) fail("invalid-response");
    }
    const world = worldResult.data;
    const worldMetadata = parse(WorldLabsWorldMetadataSchema, {
      worldId: world.world_id ?? world.id, model: world.model, displayName: world.display_name,
      semanticsMetadata: {
        groundPlaneOffset: world.assets.splats.semantics_metadata?.ground_plane_offset ?? null,
        metricScaleFactor: world.assets.splats.semantics_metadata?.metric_scale_factor ?? null,
      },
    }, "invalid-response");
    // Bind stable returned identity before any download; signed URLs are kept in
    // memory only and their digests record the exact transfer provenance.
    await publishExact(`${path}/world.json`, worldMetadata, signal);
    const selected = world.assets.splats.spz_urls[record.input.quality];
    if (selected === undefined) fail("invalid-response");
    const splatUrl = assetUrl(selected);
    const colliderUrl = assetUrl(world.assets.mesh.collider_mesh_url);
    const activeSignal = signal ?? new AbortController().signal;
    let splatBytes: Uint8Array;
    try {
      splatBytes = (await download({ abortSignal: activeSignal, maximumBytes: ASSET_BYTES, url: splatUrl })).data;
    } catch { return fail("download-failed"); }
    const splat = await saveAsset(path, splatBytes, "spz", signal);
    let colliderBytes: Uint8Array;
    try { colliderBytes = (await download({ abortSignal: activeSignal, maximumBytes: ASSET_BYTES, url: colliderUrl })).data; }
    catch { return fail("download-failed"); }
    if (splatBytes.length + colliderBytes.length > 256 * 1024 * 1024 - JSON_BYTES) fail("download-failed");
    const collider = await saveAsset(path, colliderBytes, "glb", signal);
    const provenanceValue = parse(WorldLabsProvenanceSchema, {
      kind: "atet.world-labs-provenance", schemaVersion: 1,
      attemptId: id, operationId: operation.operation_id, request: planWorldLabsGeneration(record.input).request,
      operationBinding: binding.source,
      requestSha256: record.requestSha256, responseSha256: parsed.sha256, worldResponseSha256,
      reservedCredits: WORLD_LABS_TEXT_CREDITS, settledCredits: settledCredits ?? null,
      world: worldMetadata, quality: record.input.quality,
      assets: { splat: { ...splat, sourceUrlSha256: canonicalJsonSha256(splatUrl.href) }, collider: { ...collider, sourceUrlSha256: canonicalJsonSha256(colliderUrl.href) } },
      reproducibility: "retained-assets-only", normalization: "caller-must-declare-and-verify",
      assetValidation: "retained-bytes-unvalidated", clientGenerationAttempts: 1,
      capabilityLosses: ["static-radiance-field", "no-object-semantics", "no-material-editability", "collider-is-approximate"],
    }, "invalid-response");
    const provenanceText = `${canonicalJson(provenanceValue)}\n`;
    const provenance = { path: `${path}/${sha256(Buffer.from(provenanceText))}.json`, bytes: Buffer.byteLength(provenanceText), sha256: sha256(Buffer.from(provenanceText)) };
    await publishExact(provenance.path, provenanceValue, signal);
    // Completion may be recovered after fresh signed URLs have been returned;
    // its immutable identity excludes incidental response timestamps/URL bytes.
    const completion = {
      status: "succeeded", operationId: operation.operation_id,
      responseSha256: canonicalJsonSha256(worldMetadata),
      ...(settledCredits === undefined ? {} : { settledCredits }),
    } as const;
    await publishExact(`${path}/completion.json`, completion, signal);
    const retained = { splat, collider, provenance, world: worldMetadata };
    if (await publish(`${path}/retained.json`, retained, signal) === "exists") {
      // Another read-only resume may have won with different signed-URL digest;
      // read and verify that complete retained closure instead of overwriting it.
      const winner = await inspect({ attemptId: id });
      if (winner.retained?.splat.sha256 !== splat.sha256 || winner.retained.collider.sha256 !== collider.sha256) fail("conflict");
      return winner;
    }
    return await inspect({ attemptId: id });
  }
  async function poll(id: string, signal?: AbortSignal): Promise<WorldLabsAttemptSummary> {
    const summary = await inspect({ attemptId: id });
    if (summary.status === "retained" || summary.status === "failed") return summary;
    if (summary.operationId === undefined) fail("conflict");
    const response = await api(`operations/${summary.operationId}`, await credential(), signal);
    return await acceptOperation(id, response, signal);
  }
  return {
    plan: value => planWorldLabsGeneration(parse(WorldLabsGenerationInputSchema, value, "invalid-request")),
    inspect,
    async generate(value, adapter) {
      const plan = planWorldLabsGeneration(parse(WorldLabsGenerationInputSchema, value, "invalid-request"));
      if (adapter?.grant?.allowPaidGeneration !== true) fail("permission-required");
      const budget = parse(WorldLabsBudgetSchema, { budgetId: adapter.grant.budgetId, maximumCredits: adapter.grant.maximumCredits }, "invalid-request");
      if (adapter.signal?.aborted === true) fail("provider-unavailable");
      const key = await credential();
      await assertBudgetAvailable(budget.budgetId);
      const path = attemptPath(plan.input.attemptId);
      const record = parse(RequestRecordSchema, {
        kind: "atet.world-labs-request", schemaVersion: 1, input: plan.input, budget,
        createdAt: now().toISOString(), requestSha256: plan.requestSha256, request: plan.request,
      }, "invalid-request");
      if (await publish(`${path}/request.json`, record, adapter.signal) !== "created") fail("conflict");
      await reserve(record, adapter.signal);
      await publishExact(`${path}/dispatch.json`, { requestSha256: plan.requestSha256 }, adapter.signal);
      await syncAncestors(`${path}/dispatch.json`);
      const admitted = await inspect({ attemptId: plan.input.attemptId });
      if (admitted.status !== "ambiguous" || admitted.requestSha256 !== plan.requestSha256) fail("conflict");
      // From this point onward every failure is potentially billable. There is
      // deliberately one POST call and no retry/release of the reservation.
      // A known price mismatch fences subsequent local admissions. Calls that
      // crossed this last check concurrently cannot be recalled at the provider.
      const response = await api("worlds:generate", key, adapter.signal, plan.request, () => assertBudgetAvailable(budget.budgetId));
      const operation: RawOperation = parse(RawOperationSchema, response.value, "invalid-response");
      // Preserve the returned operation even when cancellation arrived after
      // provider acceptance. This secret-free recovery write is intentionally
      // drained before observing cancellation again.
      await publishExact(`${path}/operation.json`, { operationId: operation.operation_id, source: "dispatch" });
      return await acceptOperation(plan.input.attemptId, response, adapter.signal);
    },
    async resume(input, adapter) {
      if (adapter?.allowProviderRead !== true) fail("permission-required");
      return await poll(input.attemptId, adapter.signal);
    },
    async recover(input, adapter) {
      if (adapter?.allowOperationRecovery !== true) fail("permission-required");
      const id = parse(WorldLabsIdSchema, input.operationId, "invalid-request");
      const summary = await inspect({ attemptId: input.attemptId });
      if (summary.status !== "ambiguous" && summary.operationId !== id) fail("conflict");
      if (summary.operationId === id) return await poll(input.attemptId, adapter.signal);
      const response = await api(`operations/${id}`, await credential(), adapter.signal);
      const operation = parse(RawOperationSchema, response.value, "invalid-response");
      if (operation.operation_id !== id) fail("conflict");
      await publishExact(`${attemptPath(input.attemptId)}/operation.json`, { operationId: id, source: "operator-recovery" });
      return await acceptOperation(input.attemptId, response, adapter.signal);
    },
  };
}
