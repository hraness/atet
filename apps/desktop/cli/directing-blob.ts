import { createHash, randomUUID } from "node:crypto";
import { join, relative } from "node:path";

import { presignUrl } from "@vercel/blob";
import { z } from "zod";

import type { ApplicationContext } from "../application/context";
import { GatewayMediaSourceReferenceSchema, type GatewayMediaSourceReference } from "../application/gateway-port";
import { canonicalJson } from "../core/canonical-json";
import { createNodeBundleFileSystem } from "../core/storage";
import { CliError } from "./errors";
import { gatewayMediaBytesMatchType } from "./gateway-media-signature";
import { withMutationLock } from "./mutation-lock";
import { ensurePhysicalPrivateDirectoryWithin } from "./paths";
import { resolveVerifiedProjectMedia } from "./project-media-integrity";

// Narrow API-v12 transport reviewed against @vercel/blob 2.8.0's api.ts,
// put.ts, del.ts, and signed-token.ts in https://github.com/vercel/storage.
// The SDK's network retry/environment overrides are not part of this adapter.
const API = "https://vercel.com/api/blob";
const LIMITS = { imageBytes: 30 * 1024 * 1024, entries: 2, receiptBytes: 64 * 1024, responseBytes: 32 * 1024, requestMs: 60_000, cleanupMs: 120_000, accessMs: 15 * 60_000 } as const;
const RECEIPT = "receipt.json";
const NOTICE = "Private reference hosting uses Vercel Blob operations, storage, and transfer billed separately from the Gateway generation budget. Expiring model access does not delete the stored object.";
const IdSchema = z.string().regex(/^direct_[a-z][a-z0-9_-]{0,63}$/u);
const TakeSchema = z.string().regex(/^take_[a-z][a-z0-9_-]{0,63}$/u);
const StoreSchema = z.string().regex(/^[A-Za-z0-9]{1,64}$/u);
const TimeSchema = z.number().int().safe().positive();
const EtagSchema = z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/u);
const SourceSchema = GatewayMediaSourceReferenceSchema.refine(source => ["image/png", "image/jpeg", "image/webp"].includes(source.mediaType) && source.bytes <= LIMITS.imageBytes, "Hosted directing references must be PNG, JPEG, or WebP images at most 30 MiB.");
const EntrySchema = z.strictObject({
  source: SourceSchema,
  pathname: z.string().regex(/^atet\/directing\/[a-f0-9]{32}\/[01]-[a-f0-9]{64}\.(?:png|jpg|webp)$/u),
  putStartedAt: TimeSchema,
  putCompletedAt: TimeSchema.optional(),
  etag: EtagSchema.optional(),
  accessExpiresAt: TimeSchema.optional(),
  verifiedAt: TimeSchema.optional(),
  cleanup: z.enum(["pending", "deleted", "uncertain"]),
  deleteStartedAt: TimeSchema.optional(),
  deletedAt: TimeSchema.optional(),
  failures: z.array(z.strictObject({ phase: z.enum(["put", "sign", "verify", "delete"]), at: TimeSchema })).max(32),
}).superRefine((entry, context) => {
  if ((entry.putCompletedAt === undefined) !== (entry.etag === undefined)) context.addIssue({ code: "custom", message: "Confirmed hosting uploads require their exact ETag." });
  if ((entry.cleanup === "deleted") !== (entry.deletedAt !== undefined)) context.addIssue({ code: "custom", message: "Deleted references require retained cleanup completion." });
});
export const DirectingBlobReceiptSchema = z.strictObject({
  kind: z.literal("atet.directing-blob"), schemaVersion: z.literal(1),
  directingId: IdSchema, attemptId: TakeSchema,
  namespace: z.string().regex(/^[a-f0-9]{32}$/u),
  storeId: StoreSchema, createdAt: TimeSchema, closedAt: TimeSchema.optional(),
  access: z.literal("private"), notice: z.literal(NOTICE),
  entries: z.array(EntrySchema).max(LIMITS.entries),
}).superRefine((receipt, context) => {
  for (const [index, entry] of receipt.entries.entries()) {
    const extension = entry.source.mediaType === "image/jpeg" ? "jpg" : entry.source.mediaType.slice(6);
    if (entry.pathname !== `atet/directing/${receipt.namespace}/${index}-${entry.source.sha256}.${extension}`) context.addIssue({ code: "custom", message: "A hosted object must bind this session's exact private namespace and source bytes." });
  }
});
export type DirectingBlobReceipt = z.infer<typeof DirectingBlobReceiptSchema>;
type Entry = z.infer<typeof EntrySchema>;

export interface DirectingBlobSession {
  readonly receiptPath: string;
  resolveSourceUrl(source: GatewayMediaSourceReference, data: Uint8Array, signal: AbortSignal): Promise<string>;
  /** Uses its own bounded cancellation scope so generation cancellation still permits cleanup. */
  cleanup(): Promise<DirectingBlobReceipt>;
  inspect(): Promise<DirectingBlobReceipt>;
}
export interface DirectingBlobOptions {
  readonly application: ApplicationContext;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly signal: AbortSignal;
  readonly directingId: string;
  readonly attemptId: string;
  /** Injected transport for deterministic tests; production uses native fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

function failure(message: string, code: "invalid-data" | "authorization-required" | "conflict" | "ambiguous" | "cancelled" | "unavailable" = "unavailable"): never { throw new CliError(code, message); }
function token(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (value.length > 16_384 || !/^[A-Za-z0-9_.-]+$/u.test(value)) failure("Blob credential has an unsupported format.", "authorization-required");
  return value;
}
function credentials(environment: DirectingBlobOptions["environment"]): { storeId: string; token: string } {
  const oidc = token(environment.VERCEL_OIDC_TOKEN), configuredStore = environment.BLOB_STORE_ID?.replace(/^store_/u, "");
  if (oidc !== undefined && configuredStore !== undefined) {
    const parsed = StoreSchema.safeParse(configuredStore);
    if (!parsed.success) failure("BLOB_STORE_ID is invalid.", "authorization-required");
    return { storeId: parsed.data, token: oidc };
  }
  const readWrite = token(environment.BLOB_READ_WRITE_TOKEN);
  const match = /^vercel_blob_rw_([A-Za-z0-9]{1,64})_[A-Za-z0-9]+$/u.exec(readWrite ?? "");
  if (readWrite === undefined || match === null) failure("Reference hosting requires BLOB_STORE_ID with VERCEL_OIDC_TOKEN, or BLOB_READ_WRITE_TOKEN for an existing private store.", "authorization-required");
  if (configuredStore !== undefined && configuredStore !== match[1]) failure("Blob token and configured store identity differ.", "authorization-required");
  return { storeId: match[1]!, token: readWrite };
}
function sourceIdentity(source: GatewayMediaSourceReference): string {
  return canonicalJson({ path: source.path, bytes: source.bytes, sha256: source.sha256, mediaType: source.mediaType });
}
function privateUrl(storeId: string, pathname: string): string { return `https://${storeId.toLowerCase()}.private.blob.vercel-storage.com/${pathname}`; }
function exactPrivateUrl(value: string, storeId: string, pathname: string, signed: boolean): URL {
  const parsed = new URL(value), expected = new URL(privateUrl(storeId, pathname));
  if (parsed.origin !== expected.origin || parsed.pathname !== expected.pathname || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "" || (!signed && parsed.search !== "")) failure("Blob returned a reference outside the exact private object scope.", "conflict");
  if (signed) {
    const keys = [...parsed.searchParams.keys()];
    if (!parsed.searchParams.has("vercel-blob-delegation") || !parsed.searchParams.has("vercel-blob-signature") || new Set(keys).size !== keys.length || keys.some(key => !["cache", "vercel-blob-delegation", "vercel-blob-signature", "vercel-blob-valid-until"].includes(key))) failure("Blob returned an unsupported signed reference scope.", "conflict");
  }
  return parsed;
}

async function readBounded(response: Response, maximum: number, signal: AbortSignal): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) { await response.body?.cancel(); failure("Blob response exceeds its byte limit.", "invalid-data"); }
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      total += part.value.length;
      if (total > maximum) failure("Blob response exceeds its byte limit.", "invalid-data");
      chunks.push(part.value);
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
    return output;
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Private immutable copies with short-lived, memory-only model access. No provisioning. */
export async function createDirectingBlobSession(options: DirectingBlobOptions): Promise<DirectingBlobSession> {
  const directingId = IdSchema.parse(options.directingId), attemptId = TakeSchema.parse(options.attemptId);
  const { application } = options, request = options.fetch ?? globalThis.fetch;
  const parent = await ensurePhysicalPrivateDirectoryWithin(application.paths.repositoryRoot, relative(application.paths.repositoryRoot, application.paths.privateRoot));
  const directory = await ensurePhysicalPrivateDirectoryWithin(parent, `directing-blob/${directingId}/${attemptId}`);
  const fs = createNodeBundleFileSystem(directory), receiptPath = relative(application.paths.repositoryRoot, join(directory, RECEIPT));
  const now = () => application.clock.now().getTime();
  const read = async (): Promise<DirectingBlobReceipt> => {
    const parsed = DirectingBlobReceiptSchema.parse(JSON.parse(await fs.readText(RECEIPT, LIMITS.receiptBytes)) as unknown);
    if (parsed.directingId !== directingId || parsed.attemptId !== attemptId) failure("Blob receipt belongs to a different directing attempt.", "conflict");
    return parsed;
  };
  await withMutationLock(directory, { command: "direct reference hosting", label: "Directing reference hosting" }, async lease => {
    try { await read(); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      const auth = credentials(options.environment);
      const receipt = DirectingBlobReceiptSchema.parse({ kind: "atet.directing-blob", schemaVersion: 1, directingId, attemptId, namespace: randomUUID().replaceAll("-", ""), storeId: auth.storeId, createdAt: now(), access: "private", notice: NOTICE, entries: [] });
      await fs.writeTextNoReplace!(RECEIPT, `${canonicalJson(receipt)}\n`, lease.assertOwned);
    }
  });

  const mutate = async <T>(execute: (receipt: DirectingBlobReceipt, save: () => Promise<void>, assertOwned: () => Promise<void>) => Promise<T>): Promise<T> =>
    await withMutationLock(directory, { command: "direct reference hosting", label: "Directing reference hosting" }, async lease => {
      const receipt = await read();
      const save = async () => { await fs.writeTextAtomicGuarded!(RECEIPT, `${canonicalJson(DirectingBlobReceiptSchema.parse(receipt))}\n`, lease.assertOwned); };
      return await execute(receipt, save, lease.assertOwned);
    });
  const api = async (receipt: DirectingBlobReceipt, pathname: string, method: "GET" | "PUT" | "POST", body: string | Uint8Array | undefined, headers: Record<string, string>, signal: AbortSignal, assertOwned: () => Promise<void>): Promise<{ status: number; data: Uint8Array }> => {
    const auth = credentials(options.environment);
    if (auth.storeId !== receipt.storeId) failure("Blob credentials don't match the retained store.", "authorization-required");
    await assertOwned();
    signal.throwIfAborted();
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(LIMITS.requestMs)]);
    const response = await request(`${API}${pathname}`, { method, redirect: "error", signal: bounded,
      headers: { authorization: `Bearer ${auth.token}`, "x-vercel-blob-store-id": auth.storeId, "x-api-version": "12", "x-api-blob-request-id": `${auth.storeId}:${randomUUID()}`, "x-api-blob-request-attempt": "0", ...headers },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : Buffer.from(body) }),
    });
    return { status: response.status, data: await readBounded(response, LIMITS.responseBytes, bounded) };
  };
  const signedGet = async (receipt: DirectingBlobReceipt, entry: Entry, signal: AbortSignal, assertOwned: () => Promise<void>): Promise<string> => {
    const validUntil = now() + LIMITS.accessMs;
    const issued = await api(receipt, "/signed-token", "POST", JSON.stringify({ pathname: entry.pathname, operations: ["get"], validUntil }), { "content-type": "application/json" }, signal, assertOwned);
    if (issued.status !== 200) failure("Blob could not grant temporary model access.");
    const material = z.object({ delegationToken: z.string().min(1).max(16_384), clientSigningToken: z.string().min(1).max(4096), validUntil: TimeSchema }).parse(JSON.parse(new TextDecoder().decode(issued.data)) as unknown);
    // Decode only scope assertions; server authorization remains authoritative.
    const encoded = material.delegationToken.split(".")[0]!;
    const scope = z.object({ storeId: z.string(), pathname: z.string(), operations: z.array(z.string()), validUntil: TimeSchema }).parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown);
    if (scope.storeId.replace(/^store_/u, "") !== receipt.storeId || scope.pathname !== entry.pathname || scope.operations.length !== 1 || scope.operations[0] !== "get" || scope.validUntil !== validUntil || material.validUntil !== validUntil) failure("Blob signing material exceeds the exact temporary read scope.", "conflict");
    const signed = await presignUrl(material, { operation: "get", pathname: entry.pathname, access: "private", validUntil, useCache: false });
    const url = exactPrivateUrl(signed.presignedUrl, receipt.storeId, entry.pathname, true).href;
    entry.accessExpiresAt = validUntil;
    return url;
  };
  const verifyGet = async (receipt: DirectingBlobReceipt, entry: Entry, url: string, signal: AbortSignal): Promise<{ found: false } | { found: true; etag: string }> => {
    exactPrivateUrl(url, receipt.storeId, entry.pathname, true);
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(LIMITS.requestMs)]);
    const response = await request(url, { method: "GET", redirect: "error", signal: bounded, headers: { "cache-control": "no-cache" } });
    if (response.status === 404) { await response.body?.cancel(); return { found: false }; }
    if (response.status !== 200) { await response.body?.cancel(); failure("Private hosted reference could not be verified."); }
    const bytes = await readBounded(response, entry.source.bytes, bounded);
    const etag = EtagSchema.parse(response.headers.get("etag"));
    if (bytes.length !== entry.source.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.source.sha256 || response.headers.get("content-type")?.split(";")[0]?.trim() !== entry.source.mediaType || (entry.etag !== undefined && entry.etag !== etag)) failure("Private hosted reference differs from the retained source bytes or object identity.", "conflict");
    return { found: true, etag };
  };
  const verifyPrivateAccess = async (receipt: DirectingBlobReceipt, entry: Entry, signal: AbortSignal): Promise<void> => {
    const response = await request(privateUrl(receipt.storeId, entry.pathname), { method: "GET", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(LIMITS.requestMs)]) });
    await response.body?.cancel();
    if (![401, 403, 404].includes(response.status)) failure("Hosted reference is not proven private without temporary authorization.", "conflict");
  };
  const markFailure = (entry: Entry, phase: "put" | "sign" | "verify" | "delete") => {
    if (entry.failures.length < 32) entry.failures.push({ phase, at: now() });
  };

  return {
    receiptPath,
    inspect: read,
    resolveSourceUrl: async (input, data, signal) => {
      const source = SourceSchema.parse(input);
      if (!(data instanceof Uint8Array) || data.length !== source.bytes) failure("Reference hosting requires the exact retained image bytes.", "invalid-data");
      const uploadBytes = new Uint8Array(data);
      if (createHash("sha256").update(uploadBytes).digest("hex") !== source.sha256 || !gatewayMediaBytesMatchType(uploadBytes, source.mediaType)) failure("Reference hosting requires the exact retained image bytes.", "invalid-data");
      await resolveVerifiedProjectMedia({ repositoryRoot: application.paths.repositoryRoot, path: source.path, expected: source, label: "Directing hosted reference" });
      const activeSignal = AbortSignal.any([options.signal, signal]);
      return await mutate(async (receipt, save, assertOwned) => {
        activeSignal.throwIfAborted();
        if (receipt.closedAt !== undefined) failure("This reference-hosting session is closed; use a new take for another generation.", "conflict");
        let entry = receipt.entries.find(value => sourceIdentity(value.source) === sourceIdentity(source));
        if (entry === undefined) {
          if (receipt.entries.length >= LIMITS.entries) failure("One directing take may host at most two exact image references.", "invalid-data");
          const extension = source.mediaType === "image/jpeg" ? "jpg" : source.mediaType.slice(6);
          entry = { source, pathname: `atet/directing/${receipt.namespace}/${receipt.entries.length}-${source.sha256}.${extension}`, putStartedAt: now(), cleanup: "pending", failures: [] };
          receipt.entries.push(entry);
          await save(); // Durable exact upload intent precedes the only PUT.
          try {
            const uploaded = await api(receipt, `/?${new URLSearchParams({ pathname: entry.pathname })}`, "PUT", uploadBytes,
              { "content-type": source.mediaType, "x-content-type": source.mediaType, "x-vercel-blob-access": "private", "x-add-random-suffix": "0", "x-allow-overwrite": "0", "x-cache-control-max-age": "60" }, activeSignal, assertOwned);
            if (uploaded.status < 200 || uploaded.status > 299) failure("Private reference upload did not complete.");
            const result = z.object({ url: z.string().max(2048), pathname: z.string().max(512), contentType: z.string().max(128), etag: EtagSchema }).parse(JSON.parse(new TextDecoder().decode(uploaded.data)) as unknown);
            exactPrivateUrl(result.url, receipt.storeId, entry.pathname, false);
            if (result.pathname !== entry.pathname || result.contentType !== source.mediaType) failure("Blob upload response differs from the exact reference scope.", "conflict");
            entry.putCompletedAt = now(); entry.etag = result.etag;
            await save();
          } catch {
            markFailure(entry, "put"); await save();
            failure(`Reference upload is uncertain. Retained cleanup evidence: ${receiptPath}. No upload retry was made.`, "ambiguous");
          }
        } else if (entry.putCompletedAt === undefined) {
          failure(`A previous upload may exist. Run reference cleanup for this take; it will not be uploaded again. Evidence: ${receiptPath}.`, "ambiguous");
        }
        let phase: "sign" | "verify" = "sign";
        try {
          const url = await signedGet(receipt, entry, activeSignal, assertOwned);
          await save();
          phase = "verify";
          if (!(await verifyGet(receipt, entry, url, activeSignal)).found) failure("Uploaded private reference is absent.", "conflict");
          await verifyPrivateAccess(receipt, entry, activeSignal);
          entry.verifiedAt = now(); await save();
          return url;
        } catch {
          markFailure(entry, phase); await save();
          failure(`Private reference access could not be verified. Retained cleanup evidence: ${receiptPath}.`, "unavailable");
        }
      });
    },
    cleanup: async () => {
      const cleanupSignal = AbortSignal.timeout(LIMITS.cleanupMs);
      return await mutate(async (receipt, save, assertOwned) => {
        receipt.closedAt ??= now(); await save();
        for (const entry of receipt.entries) {
          if (entry.cleanup === "deleted") continue;
          try {
            const url = await signedGet(receipt, entry, cleanupSignal, assertOwned);
            await save();
            const observed = await verifyGet(receipt, entry, url, cleanupSignal);
            if (!observed.found) {
              if (entry.putCompletedAt === undefined) failure("An ambiguous upload's absence cannot prove that its remote write settled.", "ambiguous");
              entry.cleanup = "deleted"; entry.deletedAt = now(); await save(); continue;
            }
            // Verification can recover an exact object after a lost PUT response.
            entry.etag = observed.etag; entry.putCompletedAt ??= now(); entry.verifiedAt = now();
            entry.deleteStartedAt = now(); await save();
            const deleted = await api(receipt, "/delete", "POST", JSON.stringify({ urls: [entry.pathname] }), { "content-type": "application/json", "x-if-match": observed.etag }, cleanupSignal, assertOwned);
            if (deleted.status < 200 || deleted.status > 299) failure("Private reference deletion did not complete.");
            const absent = await verifyGet(receipt, entry, url, cleanupSignal);
            if (absent.found) failure("The private reference is still readable after deletion.", "ambiguous");
            entry.cleanup = "deleted"; entry.deletedAt = now(); await save();
          } catch {
            entry.cleanup = "uncertain"; markFailure(entry, "delete"); await save();
          }
        }
        return DirectingBlobReceiptSchema.parse(receipt);
      });
    },
  };
}
