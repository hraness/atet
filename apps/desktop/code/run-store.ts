import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { z } from "zod";
import { z as schema } from "zod";

import { ApplicationError } from "../application/errors";
import type { OperationDiscovery } from "../application/registry";
import {
  canonicalJson,
} from "../core/canonical-json";
import {
  CancellationRequestSchema,
  CreateRunRecordSchema,
  NODE_EXECUTION_PLAN_VERSION,
  NODE_PREPARATION_PLAN_VERSION,
  RUN_EVENT_VERSION,
  RUN_FENCE_VERSION,
  RUN_GRANT_VERSION,
  RUN_NODE_VERSION,
  RUN_OUTPUTS_VERSION,
  RUN_STORE_VERSION,
  RunEventSchema,
  RunFenceSchema,
  RunGrantSchema,
  RunNodeRecordSchema,
  RunOutputsSchema,
  RunRuntimeRecordSchema,
  RunSummarySchema,
  RunWorkflowRecordSchema,
  createNodeExecutionPlanHash,
  createNodeInputHash,
  createNodePreparationPlanHash,
  createRunNodeOutputDigest,
  createRunOutputsDigest,
  nodeRecordFilename,
  type CancellationRequest,
  type CreateRunRecord,
  type NewRunEvent,
  type NewRunGrant,
  type RunEvent,
  type RunFence,
  type RunGrant,
  type RunNodeRecord,
  type RunOutputs,
  type RunRuntimeRecord,
  type RunSummary,
  type RunWorkflowRecord,
} from "./run-contracts";
import {
  AuthoredWorkflowGraphV1Schema,
  NodeKeySchema,
  Sha256Schema,
  WorkflowNodePolicySchema,
  isComputeGraphNode,
  isOperationGraphNode,
  trustedComputePolicy,
  type AuthoredGraphNodeV1,
  type GraphPlanV1,
  type JsonValue,
  type WorkflowNodePolicy,
  type WorkflowOutputBinding,
} from "./contracts";
import { parseGraphPlan } from "./compiler";
import { projectReferenceValue } from "./reference-projection";

const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_STRUCTURED_FILE_BYTES = 32 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;
const MAX_JOURNAL_ENTRY_BYTES = 256 * 1024;
const MAX_JOURNAL_ENTRIES = 100_000;
const PHYSICAL_LOCK_WAIT_MS = 30_000;
const PHYSICAL_LOCK_RETRY_MS = 5;
const MAX_CACHED_CLAIM_SESSIONS = 16;
const MAX_CACHED_CLAIM_SESSION_BYTES = 64 * 1024 * 1024;
const MAX_CACHED_CLAIM_SESSION_TOTAL_BYTES = 128 * 1024 * 1024;
const CACHED_CLAIM_SESSION_FIXED_BYTES = 512;
const CACHED_IDENTITY_FIXED_BYTES = 256;
const CACHED_IDENTITY_SNAPSHOT_MAP_BYTES = 256;
const CACHED_IDENTITY_SNAPSHOT_BYTES = 256;
const CACHED_JOURNAL_FIXED_BYTES = 256;
const CACHED_FILE_SNAPSHOT_BYTES = 128;
const RETAINED_JSON_VALUE_BYTES = 64;
const RETAINED_GRANT_ID_BYTES = 128;

const CLAIM_FILE = ".claim.json";
const CLAIM_GENERATION_FILE = ".claim-generation.json";
const INITIALIZED_FILE = ".initialized.json";
const PHYSICAL_LOCK_FILE = ".run-store-lock.json";

interface ClaimSnapshot {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly size: number;
  readonly uid: number;
}

interface FileSnapshot extends ClaimSnapshot {
  readonly ctimeMs: number;
  readonly mtimeMs: number;
}

interface ExistingClaim {
  readonly fence: RunFence;
  readonly snapshot: ClaimSnapshot;
}

interface ValidatedRunIdentity {
  readonly bundleBytes: Uint8Array;
  readonly directory: string;
  readonly graphPlan: GraphPlanV1;
  readonly runtime: RunRuntimeRecord;
  readonly workflow: RunWorkflowRecord;
}

type ValidatedRunMetadata = Omit<ValidatedRunIdentity, "bundleBytes">;

interface CachedRunIdentity {
  readonly identity: ValidatedRunMetadata;
  readonly retainedBytes: number;
  readonly snapshots: ReadonlyMap<string, FileSnapshot>;
}

interface JournalAppendState<Cursor> {
  readonly cursor: Cursor;
  readonly entryCount: number;
  snapshot: FileSnapshot;
}

interface EventJournalCursor {
  readonly lastFenceGeneration: number;
  readonly lastSequence: number;
}

interface GrantJournalCursor {
  readonly grantIds: Set<string>;
}

interface CachedClaimSession {
  readonly eventJournal?: JournalAppendState<EventJournalCursor>;
  readonly fenceGeneration: number;
  readonly fenceToken: string;
  readonly grantJournal?: JournalAppendState<GrantJournalCursor>;
  readonly identity?: CachedRunIdentity;
  readonly retainedBytes: number;
}

export interface AcquireRunClaimOptions {
  readonly now?: () => Date;
  readonly owner: string;
  readonly processAlive?: (pid: number) => boolean;
  readonly staleAfterMs?: number;
}

export interface RunStoreOptions {
  /** Allows a smaller deterministic test budget, but cannot raise the production cap. */
  readonly claimSessionCacheBudgetBytes?: number;
  readonly root: string;
}

const InitializedRecordSchema = RunSummarySchema.pick({
  graphPlanSha256: true,
  runId: true,
  version: true,
});

const ClaimGenerationRecordSchema = RunRuntimeRecordSchema.pick({ version: true }).extend({
  generation: RunFenceSchema.shape.generation,
});

const PhysicalLockRecordSchema = schema.strictObject({
  acquiredAt: schema.string().datetime({ offset: true }),
  hostname: schema.string().min(1).max(255),
  pid: schema.number().int().positive().safe(),
  token: schema.string().uuid(),
  version: schema.literal(RUN_STORE_VERSION),
});

const TERMINAL_NODE_STATUSES = new Set<RunNodeRecord["status"]>([
  "ambiguous",
  "cancelled",
  "completed",
  "failed",
  "incompatible",
  "skipped",
]);

const TERMINAL_RUN_STATUSES = new Set<RunSummary["status"]>([
  "cancelled",
  "completed",
  "failed",
  "incompatible",
  "partial",
]);

const FORWARD_NODE_TRANSITIONS: Readonly<
  Record<RunNodeRecord["status"], ReadonlySet<RunNodeRecord["status"]>>
> = {
  "ambiguous": new Set(),
  "ambiguous-code": new Set(["cancelled", "incompatible"]),
  "approval-required": new Set(["approval-required", "cancelled", "preparing", "ready"]),
  "cancelled": new Set(),
  "completed": new Set(),
  "failed": new Set(),
  "incompatible": new Set(),
  "pending": new Set(["cancelled", "ready", "skipped"]),
  "preparing": new Set([
    "approval-required",
    "cancelled",
    "failed",
    "incompatible",
    "ready",
  ]),
  "ready": new Set([
    "approval-required",
    "cancelled",
    "failed",
    "incompatible",
    "preparing",
    "ready",
    "running",
  ]),
  "running": new Set([
    "ambiguous",
    "ambiguous-code",
    "cancelled",
    "completed",
    "failed",
    "incompatible",
    "ready",
  ]),
  "skipped": new Set(),
};

function errno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function privateFile(details: Stats): boolean {
  const expectedUid = currentUid();
  return details.isFile()
    && !details.isSymbolicLink()
    && (details.mode & 0o777) === 0o600
    && (expectedUid === undefined || details.uid === expectedUid);
}

function privateDirectory(details: Stats): boolean {
  const expectedUid = currentUid();
  return details.isDirectory()
    && !details.isSymbolicLink()
    && (details.mode & 0o777) === 0o700
    && (expectedUid === undefined || details.uid === expectedUid);
}

function snapshot(details: Stats): ClaimSnapshot {
  return {
    dev: details.dev,
    ino: details.ino,
    mode: details.mode,
    size: details.size,
    uid: details.uid,
  };
}

function fileSnapshot(details: Stats): FileSnapshot {
  return {
    ...snapshot(details),
    ctimeMs: details.ctimeMs,
    mtimeMs: details.mtimeMs,
  };
}

function sameSnapshot(left: ClaimSnapshot, right: ClaimSnapshot): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.uid === right.uid;
}

function sameFileSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return sameSnapshot(left, right)
    && left.ctimeMs === right.ctimeMs
    && left.mtimeMs === right.mtimeMs;
}

function samePhysicalFile(left: ClaimSnapshot, right: ClaimSnapshot): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.uid === right.uid;
}

function localProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !errno(error, "ESRCH");
  }
}

function equalCanonical(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function addRetainedBytes(...values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (total > Number.MAX_SAFE_INTEGER - value) return Number.MAX_SAFE_INTEGER;
    total += value;
  }
  return total;
}

function multiplyRetainedBytes(value: number, multiplier: number): number {
  if (value > Number.MAX_SAFE_INTEGER / multiplier) return Number.MAX_SAFE_INTEGER;
  return value * multiplier;
}

function retainedUtf8Bytes(value: string): number {
  return multiplyRetainedBytes(new TextEncoder().encode(value).byteLength, 2);
}

function retainedJsonValueCount(root: unknown): number {
  const pending: unknown[] = [root];
  const seen = new WeakSet<object>();
  let count = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) continue;
      seen.add(value);
    }
    count = addRetainedBytes(count, 1);
    if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
    } else if (typeof value === "object" && value !== null) {
      for (const item of Object.values(value)) pending.push(item);
    }
  }
  return count;
}

function cachedIdentityRetainedBytes(
  identity: ValidatedRunMetadata,
  snapshots: ReadonlyMap<string, FileSnapshot>,
): number {
  let retainedBytes = addRetainedBytes(
    CACHED_IDENTITY_FIXED_BYTES,
    CACHED_IDENTITY_SNAPSHOT_MAP_BYTES,
    retainedUtf8Bytes(identity.directory),
  );
  for (const path of snapshots.keys()) {
    retainedBytes = addRetainedBytes(
      retainedBytes,
      CACHED_IDENTITY_SNAPSHOT_BYTES,
      retainedUtf8Bytes(path),
    );
  }
  for (const [filename, value] of [
    ["graph-plan.json", identity.graphPlan],
    ["runtime.json", identity.runtime],
    ["workflow.json", identity.workflow],
  ] as const) {
    const path = join(identity.directory, filename);
    const retainedSnapshot = snapshots.get(path);
    if (retainedSnapshot === undefined) {
      throw new ApplicationError("internal", `Run identity snapshot is missing: ${path}`);
    }
    retainedBytes = addRetainedBytes(
      retainedBytes,
      multiplyRetainedBytes(retainedSnapshot.size, 2),
      multiplyRetainedBytes(retainedJsonValueCount(value), RETAINED_JSON_VALUE_BYTES),
    );
  }
  return retainedBytes;
}

function cachedClaimSessionRetainedBytes(
  runId: string,
  session: Omit<CachedClaimSession, "retainedBytes">,
): number {
  let retainedBytes = addRetainedBytes(
    CACHED_CLAIM_SESSION_FIXED_BYTES,
    retainedUtf8Bytes(runId),
    retainedUtf8Bytes(session.fenceToken),
    session.identity?.retainedBytes ?? 0,
  );
  if (session.eventJournal !== undefined) {
    retainedBytes = addRetainedBytes(
      retainedBytes,
      CACHED_JOURNAL_FIXED_BYTES,
      CACHED_FILE_SNAPSHOT_BYTES,
    );
  }
  if (session.grantJournal !== undefined) {
    retainedBytes = addRetainedBytes(
      retainedBytes,
      CACHED_JOURNAL_FIXED_BYTES,
      CACHED_FILE_SNAPSHOT_BYTES,
      multiplyRetainedBytes(
        session.grantJournal.cursor.grantIds.size,
        RETAINED_GRANT_ID_BYTES,
      ),
    );
  }
  return retainedBytes;
}

function sortedOperationIdentities(
  graphPlan: GraphPlanV1,
): RunRuntimeRecord["operations"] {
  const identities = new Map<string, RunRuntimeRecord["operations"][number]>();
  for (const node of graphPlan.graph.nodes) {
    if (!isOperationGraphNode(node)) continue;
    const operation = node.executor.operation;
    const key = `${operation.kind}@${String(operation.version)}`;
    identities.set(key, operation);
  }
  return [...identities.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, identity]) => identity);
}

function sortedComputeIdentities(
  graphPlan: GraphPlanV1,
): RunRuntimeRecord["computes"] {
  const identities = new Map<string, RunRuntimeRecord["computes"][number]>();
  for (const node of graphPlan.graph.nodes) {
    if (!isComputeGraphNode(node)) continue;
    identities.set(node.executor.compute.key, node.executor.compute);
  }
  return [...identities.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, identity]) => identity);
}

function normalizedPolicy(policy: WorkflowNodePolicy): WorkflowNodePolicy {
  return WorkflowNodePolicySchema.parse({
    ...policy,
    preparation: [...policy.preparation].sort((left, right) => left.localeCompare(right)),
    resources: [...policy.resources].sort((left, right) => (
      left.resource.localeCompare(right.resource)
    )),
  });
}

function operationDiscovery(
  graphPlan: GraphPlanV1,
  node: AuthoredGraphNodeV1,
): OperationDiscovery {
  if (!isOperationGraphNode(node)) {
    throw new ApplicationError(
      "invalid-data",
      `Compute node ${node.key} has no application operation discovery.`,
    );
  }
  const discovery = graphPlan.registry.discovery.find(item => (
    item.kind === node.executor.operation.kind
    && item.version === node.executor.operation.version
  ));
  if (discovery === undefined) {
    throw new ApplicationError(
      "invalid-data",
      `Graph plan has no registered identity for node ${node.key}.`,
    );
  }
  return discovery;
}

function nodePolicy(
  graphPlan: GraphPlanV1,
  node: AuthoredGraphNodeV1,
): WorkflowNodePolicy {
  if (isOperationGraphNode(node)) {
    return operationDiscovery(graphPlan, node).policy;
  }
  if (isComputeGraphNode(node)) {
    return trustedComputePolicy(node.executor.compute);
  }
  throw new ApplicationError("internal", `Unknown node executor for ${node.key}.`);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_NOFOLLOW | constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeNoReplace(path: string, value: string | Uint8Array): Promise<void> {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJsonNoReplace(path: string, value: unknown): Promise<void> {
  await writeNoReplace(path, `${canonicalJson(value)}\n`);
}

async function publishNoReplace(path: string, value: string | Uint8Array): Promise<void> {
  const directory = dirname(path);
  const temporary = join(directory, `.publish-${randomUUID()}`);
  await writeNoReplace(temporary, value);
  try {
    await link(temporary, path);
    await syncDirectory(directory);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async function publishJsonNoReplace(path: string, value: unknown): Promise<void> {
  await publishNoReplace(path, `${canonicalJson(value)}\n`);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.replace-${randomUUID()}`);
  await writeJsonNoReplace(temporary, value);
  try {
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function readBoundedPhysicalBytes(
  path: string,
  maximumBytes = MAX_STRUCTURED_FILE_BYTES,
): Promise<Uint8Array> {
  let pathDetails: Stats;
  try {
    pathDetails = await lstat(path);
  } catch (error) {
    if (errno(error, "ENOENT")) {
      throw new ApplicationError("not-found", `Run artifact does not exist: ${path}`);
    }
    throw error;
  }
  if (!privateFile(pathDetails) || pathDetails.size > maximumBytes) {
    throw new ApplicationError(
      "unsafe-path",
      `Run artifact must be a bounded private physical file: ${path}`,
    );
  }
  const handle = await open(path, constants.O_NOFOLLOW | constants.O_RDONLY);
  try {
    const before = await handle.stat();
    if (!sameSnapshot(snapshot(pathDetails), snapshot(before))) {
      throw new ApplicationError("conflict", `Run artifact changed before read: ${path}`);
    }
    const bytes = new Uint8Array(await handle.readFile());
    const after = await handle.stat();
    if (
      !sameSnapshot(snapshot(before), snapshot(after))
      || bytes.byteLength !== before.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      throw new ApplicationError("conflict", `Run artifact changed during read: ${path}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new ApplicationError("invalid-data", `Run artifact is not UTF-8 (${path}): ${String(error)}`);
  }
}

async function readBoundedPhysical(path: string): Promise<string> {
  return decodeUtf8(await readBoundedPhysicalBytes(path), path);
}

async function readJsonUnknown(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readBoundedPhysical(path)) as unknown;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError("invalid-data", `Run artifact is not JSON: ${path}`);
  }
}

async function readJson<Schema extends z.ZodType>(
  path: string,
  validator: Schema,
): Promise<z.infer<Schema>> {
  try {
    return validator.parse(await readJsonUnknown(path));
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw new ApplicationError("invalid-data", `Run artifact failed validation (${path}): ${String(error)}`);
  }
}

function completeJournalPrefix(bytes: Uint8Array): Uint8Array {
  const lastNewline = bytes.lastIndexOf(0x0a);
  return lastNewline < 0 ? bytes.subarray(0, 0) : bytes.subarray(0, lastNewline + 1);
}

function parseJournalBytes<Schema extends z.ZodType>(
  bytes: Uint8Array,
  path: string,
  validator: Schema,
): readonly z.infer<Schema>[] {
  const complete = completeJournalPrefix(bytes);
  if (complete.byteLength === 0) return Object.freeze([]);
  const lines = decodeUtf8(complete, path).split("\n");
  lines.pop();
  if (lines.length > MAX_JOURNAL_ENTRIES) {
    throw new ApplicationError(
      "invalid-data",
      `Run journal exceeds ${String(MAX_JOURNAL_ENTRIES)} entries: ${path}`,
    );
  }
  return Object.freeze(lines.map((line, index) => {
    try {
      return validator.parse(JSON.parse(line) as unknown);
    } catch (error) {
      throw new ApplicationError(
        "invalid-data",
        `Invalid run journal entry ${String(index + 1)} (${path}): ${String(error)}`,
      );
    }
  }));
}

async function readJsonLines<Schema extends z.ZodType>(
  path: string,
  validator: Schema,
): Promise<readonly z.infer<Schema>[]> {
  return parseJournalBytes(
    await readBoundedPhysicalBytes(path, MAX_JOURNAL_BYTES),
    path,
    validator,
  );
}

async function appendJournalEntry<Schema extends z.ZodType, Result, Cursor>(
  path: string,
  validator: Schema,
  validate: (entries: readonly z.infer<Schema>[]) => Cursor,
  create: (context: {
    readonly cursor: Cursor;
    readonly entryCount: number;
  }) => {
    readonly entry: z.infer<Schema>;
    readonly result: Result;
  },
  advance: (cursor: Cursor, entry: z.infer<Schema>) => Cursor,
  cached?: JournalAppendState<Cursor>,
): Promise<{
  readonly result: Result;
  readonly state: JournalAppendState<Cursor>;
}> {
  const details = await lstat(path);
  if (!privateFile(details) || details.size > MAX_JOURNAL_BYTES) {
    throw new ApplicationError(
      "unsafe-path",
      `Run journal must be a bounded private physical file: ${path}`,
    );
  }
  const handle = await open(path, constants.O_NOFOLLOW | constants.O_RDWR);
  try {
    const opened = await handle.stat();
    if (!sameSnapshot(snapshot(details), snapshot(opened))) {
      throw new ApplicationError("conflict", `Run journal changed before append: ${path}`);
    }
    const mayReuse = cached !== undefined
      && sameFileSnapshot(cached.snapshot, fileSnapshot(details))
      && sameFileSnapshot(cached.snapshot, fileSnapshot(opened));
    let completeBytes: number;
    let cursor: Cursor;
    let entryCount: number;
    if (mayReuse) {
      completeBytes = opened.size;
      cursor = cached.cursor;
      entryCount = cached.entryCount;
    } else {
      const bytes = new Uint8Array(await handle.readFile());
      if (bytes.byteLength > MAX_JOURNAL_BYTES) {
        throw new ApplicationError("invalid-data", `Run journal exceeds its byte limit: ${path}`);
      }
      const complete = completeJournalPrefix(bytes);
      const entries = parseJournalBytes(bytes, path, validator);
      cursor = validate(entries);
      entryCount = entries.length;
      completeBytes = complete.byteLength;
      if (bytes.byteLength !== completeBytes) {
        await handle.truncate(completeBytes);
        await handle.sync();
      }
    }
    if (entryCount >= MAX_JOURNAL_ENTRIES) {
      throw new ApplicationError(
        "conflict",
        `Run journal already contains ${String(MAX_JOURNAL_ENTRIES)} entries.`,
      );
    }
    const created = create({ cursor, entryCount });
    const entry = validator.parse(created.entry);
    const encoded = new TextEncoder().encode(`${canonicalJson(entry)}\n`);
    if (encoded.byteLength > MAX_JOURNAL_ENTRY_BYTES) {
      throw new ApplicationError("invalid-data", "Run journal entry exceeds its byte limit.");
    }
    if (completeBytes + encoded.byteLength > MAX_JOURNAL_BYTES) {
      throw new ApplicationError("conflict", "Run journal has reached its byte limit.");
    }
    let written = 0;
    while (written < encoded.byteLength) {
      const result = await handle.write(
        encoded,
        written,
        encoded.byteLength - written,
        completeBytes + written,
      );
      if (result.bytesWritten < 1) {
        throw new ApplicationError("unavailable", `Run journal append made no progress: ${path}`);
      }
      written += result.bytesWritten;
    }
    await handle.sync();
    const persisted = await handle.stat();
    if (
      !samePhysicalFile(snapshot(opened), snapshot(persisted))
      || persisted.size !== completeBytes + encoded.byteLength
    ) {
      throw new ApplicationError("conflict", `Run journal changed during append: ${path}`);
    }
    return {
      result: created.result,
      state: {
        cursor: advance(cursor, entry),
        entryCount: entryCount + 1,
        snapshot: fileSnapshot(persisted),
      },
    };
  } finally {
    await handle.close();
  }
}

function validateEventSequence(
  events: readonly RunEvent[],
  runId: string,
): EventJournalCursor {
  let previousGeneration = 0;
  for (const [index, event] of events.entries()) {
    if (event.runId !== runId || event.sequence !== index + 1) {
      throw new ApplicationError("invalid-data", `Run event sequence is inconsistent for ${runId}.`);
    }
    if (event.fenceGeneration < previousGeneration) {
      throw new ApplicationError("invalid-data", `Run event fence generation regressed for ${runId}.`);
    }
    previousGeneration = event.fenceGeneration;
  }
  return {
    lastFenceGeneration: previousGeneration,
    lastSequence: events.at(-1)?.sequence ?? 0,
  };
}

function validateGrantLedger(
  grants: readonly RunGrant[],
  runId: string,
  graphPlanSha256: string,
): GrantJournalCursor {
  const ids = new Set<string>();
  for (const grant of grants) {
    if (grant.runId !== runId || grant.graphPlanSha256 !== graphPlanSha256) {
      throw new ApplicationError("invalid-data", `Run grant identity is inconsistent for ${runId}.`);
    }
    if (ids.has(grant.grantId)) {
      throw new ApplicationError("invalid-data", `Run grant ID is duplicated: ${grant.grantId}`);
    }
    ids.add(grant.grantId);
  }
  return { grantIds: ids };
}

function countsFor(records: readonly RunNodeRecord[]): RunSummary["counts"] {
  return {
    cancelled: records.filter(record => record.status === "cancelled").length,
    completed: records.filter(record => record.status === "completed").length,
    failed: records.filter(record => (
    record.status === "failed"
      || record.status === "incompatible"
      || record.status === "ambiguous"
    )).length,
    pending: records.filter(record => (
      record.status === "pending"
      || record.status === "ready"
      || record.status === "preparing"
      || record.status === "running"
      || record.status === "approval-required"
      || record.status === "ambiguous-code"
    )).length,
    skipped: records.filter(record => record.status === "skipped").length,
  };
}

function isSerializedOutputReference(
  value: WorkflowOutputBinding,
): value is Extract<WorkflowOutputBinding, { readonly $ref: unknown }> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.hasOwn(value, "$ref");
}

function isWorkflowOutputArray(
  value: WorkflowOutputBinding,
): value is readonly WorkflowOutputBinding[] {
  return Array.isArray(value);
}

function resolveOutputBinding(
  binding: WorkflowOutputBinding,
  recordsByKey: ReadonlyMap<string, RunNodeRecord>,
  digests: Record<string, string>,
): JsonValue | undefined {
  if (isSerializedOutputReference(binding)) {
    const record = recordsByKey.get(binding.$ref.nodeKey);
    if (record?.status !== "completed" || record.output === undefined) return undefined;
    digests[record.nodeKey] = record.output.digestSha256;
    return projectReferenceValue(binding, record.output.value);
  }
  if (isWorkflowOutputArray(binding)) {
    const output: JsonValue[] = [];
    for (const item of binding) {
      const resolved = resolveOutputBinding(item, recordsByKey, digests);
      if (resolved === undefined) return undefined;
      output.push(resolved);
    }
    return output;
  }
  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(binding).sort(([left], [right]) => (
    left.localeCompare(right)
  ))) {
    const resolved = resolveOutputBinding(item, recordsByKey, digests);
    if (resolved === undefined) return undefined;
    output[key] = resolved;
  }
  return output;
}

function derivedRunStatus(records: readonly RunNodeRecord[]): RunSummary["status"] {
  if (records.some(record => record.status === "approval-required")) return "approval-required";
  if (records.some(record => record.status === "ambiguous-code")) return "ambiguous-code";
  if (records.some(record => (
    record.status === "pending"
    || record.status === "ready"
    || record.status === "preparing"
    || record.status === "running"
  ))) return "running";
  const counts = countsFor(records);
  if (counts.cancelled > 0) return "cancelled";
  if (counts.failed === 0 && counts.skipped === 0 && counts.completed === records.length) {
    return "completed";
  }
  if (records.some(record => record.status === "incompatible") && counts.completed === 0) {
    return "incompatible";
  }
  if (counts.completed > 0) return "partial";
  return "failed";
}

export class RunStore {
  // Another RunStore instance may release a claim without notifying this one,
  // so claim-local acceleration is bounded independently of release.
  readonly #cachedClaimSessions = new Map<string, CachedClaimSession>();
  #cachedClaimSessionBytes = 0;
  readonly #claimSessionCacheBudgetBytes: number;
  readonly #root: string;

  constructor(options: RunStoreOptions) {
    const cacheBudgetBytes = options.claimSessionCacheBudgetBytes
      ?? MAX_CACHED_CLAIM_SESSION_TOTAL_BYTES;
    if (
      !Number.isSafeInteger(cacheBudgetBytes)
      || cacheBudgetBytes < 0
      || cacheBudgetBytes > MAX_CACHED_CLAIM_SESSION_TOTAL_BYTES
    ) {
      throw new ApplicationError(
        "usage",
        `Run claim-session cache budget must be a safe integer from 0 through ${String(MAX_CACHED_CLAIM_SESSION_TOTAL_BYTES)}.`,
      );
    }
    this.#claimSessionCacheBudgetBytes = cacheBudgetBytes;
    this.#root = resolve(options.root);
  }

  async #physicalRoot(): Promise<string> {
    const absolute = this.#root;
    const parsed = parse(absolute);
    const segments = absolute.slice(parsed.root.length).split("/").filter(Boolean);
    let current = parsed.root;
    for (const segment of segments) {
      current = join(current, segment);
      let details: Stats;
      try {
        details = await lstat(current);
      } catch (error) {
        if (!errno(error, "ENOENT")) throw error;
        try {
          await mkdir(current, { mode: 0o700 });
        } catch (mkdirError) {
          if (!errno(mkdirError, "EEXIST")) throw mkdirError;
        }
        details = await lstat(current);
      }
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new ApplicationError(
          "unsafe-path",
          `Run root crosses a non-physical directory component: ${current}`,
        );
      }
    }
    const rootDetails = await lstat(absolute);
    if (!privateDirectory(rootDetails)) {
      throw new ApplicationError(
        "unsafe-path",
        `Run root must be an owner-only physical directory (0700): ${absolute}`,
      );
    }
    if (await realpath(absolute) !== absolute) {
      throw new ApplicationError("unsafe-path", `Run root crosses a symbolic link: ${absolute}`);
    }
    return absolute;
  }

  async #runDirectory(runId: string, mustExist = true): Promise<string> {
    const parsedRunId = RunFenceSchema.shape.runId.parse(runId);
    const root = await this.#physicalRoot();
    const directory = join(root, parsedRunId);
    if (mustExist) {
      const details = await lstat(directory).catch(error => {
        if (errno(error, "ENOENT")) {
          throw new ApplicationError("not-found", `Workflow run does not exist: ${parsedRunId}`);
        }
        throw error;
      });
      if (!privateDirectory(details) || await realpath(directory) !== directory) {
        throw new ApplicationError(
          "unsafe-path",
          `Workflow run must be an owner-only physical directory (0700): ${parsedRunId}`,
        );
      }
    }
    return directory;
  }

  async #nodeDirectory(directory: string): Promise<string> {
    return await this.#privateChildDirectory(directory, "nodes");
  }

  async #privateChildDirectory(directory: string, name: string): Promise<string> {
    const child = join(directory, name);
    const details = await lstat(child);
    if (!privateDirectory(details) || await realpath(child) !== child) {
      throw new ApplicationError(
        "unsafe-path",
        `Run ${name} storage must be a physical 0700 directory.`,
      );
    }
    return child;
  }

  async #ensurePrivateChildDirectory(
    directory: string,
    name: string,
  ): Promise<string> {
    const child = join(directory, name);
    try {
      await mkdir(child, { mode: 0o700 });
    } catch (error) {
      if (!errno(error, "EEXIST")) throw error;
    }
    return await this.#privateChildDirectory(directory, name);
  }

  async #withPhysicalLock<Value>(
    runId: string,
    work: (directory: string) => Promise<Value>,
  ): Promise<Value> {
    const directory = await this.#runDirectory(runId);
    const lockPath = join(directory, PHYSICAL_LOCK_FILE);
    const lock = PhysicalLockRecordSchema.parse({
      acquiredAt: new Date().toISOString(),
      hostname: hostname(),
      pid: process.pid,
      token: randomUUID(),
      version: RUN_STORE_VERSION,
    });
    const deadline = Date.now() + PHYSICAL_LOCK_WAIT_MS;
    let acquiredSnapshot: ClaimSnapshot | undefined;
    while (acquiredSnapshot === undefined) {
      try {
        await publishJsonNoReplace(lockPath, lock);
        acquiredSnapshot = snapshot(await lstat(lockPath));
      } catch (error) {
        if (!errno(error, "EEXIST")) throw error;
        let existing: z.infer<typeof PhysicalLockRecordSchema>;
        let details: Stats | undefined;
        try {
          details = await lstat(lockPath);
          existing = await readJson(lockPath, PhysicalLockRecordSchema);
        } catch (readError) {
          const current = await lstat(lockPath).catch(() => undefined);
          if (
            details === undefined
            ||
            current === undefined
            || !sameSnapshot(snapshot(details), snapshot(current))
          ) {
            if (Date.now() >= deadline) {
              throw new ApplicationError(
                "conflict",
                `Timed out waiting for run serialization: ${runId}`,
              );
            }
            await delay(PHYSICAL_LOCK_RETRY_MS);
            continue;
          }
          if (
            errno(readError, "ENOENT")
            || (
              readError instanceof ApplicationError
              && (readError.code === "not-found" || readError.code === "conflict")
            )
          ) {
            if (Date.now() >= deadline) {
              throw new ApplicationError(
                "conflict",
                `Timed out waiting for run serialization: ${runId}`,
              );
            }
            await delay(PHYSICAL_LOCK_RETRY_MS);
            continue;
          }
          throw new ApplicationError(
            "unsafe-path",
            `Run serialization lock is malformed: ${String(readError)}`,
          );
        }
        if (existing.hostname === hostname() && !localProcessAlive(existing.pid)) {
          const currentLock = await lstat(lockPath).catch(() => undefined);
          if (
            currentLock !== undefined
            && sameSnapshot(snapshot(details), snapshot(currentLock))
          ) {
            await unlink(lockPath);
            await syncDirectory(directory);
            continue;
          }
        }
        if (Date.now() >= deadline) {
          throw new ApplicationError("conflict", `Timed out waiting for run serialization: ${runId}`);
        }
        await delay(PHYSICAL_LOCK_RETRY_MS);
      }
    }
    try {
      return await work(directory);
    } finally {
      const current = await lstat(lockPath).catch(() => undefined);
      if (current !== undefined && sameSnapshot(acquiredSnapshot, snapshot(current))) {
        const persisted = await readJson(lockPath, PhysicalLockRecordSchema).catch(() => undefined);
        if (persisted?.token === lock.token) {
          await unlink(lockPath).catch(() => undefined);
          await syncDirectory(directory).catch(() => undefined);
        }
      }
    }
  }

  async #readIdentity(directory: string, runId: string): Promise<ValidatedRunIdentity> {
    await this.#privateChildDirectory(directory, "staging");
    let graphPlan: GraphPlanV1;
    try {
      graphPlan = parseGraphPlan(await readJsonUnknown(join(directory, "graph-plan.json")));
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError("invalid-data", `Persisted graph plan is invalid: ${String(error)}`);
    }
    const initialized = await readJson(join(directory, INITIALIZED_FILE), InitializedRecordSchema);
    if (
      initialized.runId !== runId
      || initialized.graphPlanSha256 !== graphPlan.graphPlanSha256
    ) {
      throw new ApplicationError("invalid-data", "Run initialization identity is inconsistent.");
    }
    const storedGraph = await readJson(
      join(directory, "graph.json"),
      AuthoredWorkflowGraphV1Schema,
    );
    if (!equalCanonical(storedGraph, graphPlan.graph)) {
      throw new ApplicationError("invalid-data", "Persisted authored graph differs from its graph plan.");
    }
    const workflow = await readJson(
      join(directory, "workflow.json"),
      RunWorkflowRecordSchema,
    );
    if (
      !equalCanonical(workflow.bundle, graphPlan.bundle)
      || !equalCanonical(workflow.workflow, graphPlan.graph.workflow)
    ) {
      throw new ApplicationError("invalid-data", "Persisted workflow identity differs from its graph plan.");
    }
    const runtime = await readJson(join(directory, "runtime.json"), RunRuntimeRecordSchema);
    if (
      !equalCanonical(runtime.runtime, graphPlan.runtime)
      || !equalCanonical(runtime.computes, sortedComputeIdentities(graphPlan))
      || !equalCanonical(runtime.operations, sortedOperationIdentities(graphPlan))
    ) {
      throw new ApplicationError("invalid-data", "Persisted runtime identity differs from its graph plan.");
    }
    const bundleBytes = await readBoundedPhysicalBytes(
      join(directory, "workflow.bundle.js"),
      MAX_BUNDLE_BYTES,
    );
    const bundleSha256 = createHash("sha256").update(bundleBytes).digest("hex");
    if (
      bundleBytes.byteLength !== graphPlan.bundle.bytes
      || bundleSha256 !== graphPlan.bundle.bundleSha256
    ) {
      throw new ApplicationError("invalid-data", "Persisted workflow bundle bytes changed.");
    }
    return { bundleBytes, directory, graphPlan, runtime, workflow };
  }

  #identityArtifactPaths(directory: string): readonly string[] {
    return [
      join(directory, "graph-plan.json"),
      join(directory, INITIALIZED_FILE),
      join(directory, "graph.json"),
      join(directory, "workflow.json"),
      join(directory, "runtime.json"),
      join(directory, "workflow.bundle.js"),
    ];
  }

  async #identitySnapshots(directory: string): Promise<ReadonlyMap<string, FileSnapshot>> {
    const entries = await Promise.all(this.#identityArtifactPaths(directory).map(async path => {
      const details = await lstat(path);
      if (!privateFile(details)) {
        throw new ApplicationError(
          "unsafe-path",
          `Run identity must be stored in a private physical file: ${path}`,
        );
      }
      return [path, fileSnapshot(details)] as const;
    }));
    return new Map(entries);
  }

  #sameIdentitySnapshots(
    left: ReadonlyMap<string, FileSnapshot>,
    right: ReadonlyMap<string, FileSnapshot>,
  ): boolean {
    if (left.size !== right.size) return false;
    for (const [path, expected] of left) {
      const actual = right.get(path);
      if (actual === undefined || !sameFileSnapshot(expected, actual)) return false;
    }
    return true;
  }

  async #readStableIdentity(
    directory: string,
    runId: string,
  ): Promise<CachedRunIdentity> {
    const before = await this.#identitySnapshots(directory);
    const validated = await this.#readIdentity(directory, runId);
    const after = await this.#identitySnapshots(directory);
    if (!this.#sameIdentitySnapshots(before, after)) {
      throw new ApplicationError(
        "conflict",
        `Run identity changed while it was validated: ${runId}`,
      );
    }
    // The snapshots still cover the bundle file on every fenced operation. Keep
    // only parsed metadata here so one cache entry cannot retain 16 MiB of bytes.
    const identity: ValidatedRunMetadata = {
      directory: validated.directory,
      graphPlan: validated.graphPlan,
      runtime: validated.runtime,
      workflow: validated.workflow,
    };
    return {
      identity,
      retainedBytes: cachedIdentityRetainedBytes(identity, after),
      snapshots: after,
    };
  }

  #claimSession(fence: RunFence): CachedClaimSession | undefined {
    const cached = this.#cachedClaimSessions.get(fence.runId);
    if (
      cached === undefined
      || cached.fenceGeneration !== fence.generation
      || cached.fenceToken !== fence.token
    ) return undefined;
    this.#cachedClaimSessions.delete(fence.runId);
    this.#cachedClaimSessions.set(fence.runId, cached);
    return cached;
  }

  #deleteCachedClaimSession(runId: string): void {
    const cached = this.#cachedClaimSessions.get(runId);
    if (cached === undefined) return;
    this.#cachedClaimSessions.delete(runId);
    this.#cachedClaimSessionBytes = Math.max(
      0,
      this.#cachedClaimSessionBytes - cached.retainedBytes,
    );
  }

  #cacheClaimSession(
    fence: RunFence,
    update: Partial<Omit<
      CachedClaimSession,
      "fenceGeneration" | "fenceToken" | "retainedBytes"
    >>,
  ): void {
    const current = this.#claimSession(fence);
    const candidate = {
      ...(current?.eventJournal === undefined
        ? {}
        : { eventJournal: current.eventJournal }),
      ...(current?.grantJournal === undefined
        ? {}
        : { grantJournal: current.grantJournal }),
      ...(current?.identity === undefined ? {} : { identity: current.identity }),
      ...update,
      fenceGeneration: fence.generation,
      fenceToken: fence.token,
    } satisfies Omit<CachedClaimSession, "retainedBytes">;
    const retainedBytes = cachedClaimSessionRetainedBytes(fence.runId, candidate);
    this.#deleteCachedClaimSession(fence.runId);
    if (
      retainedBytes > MAX_CACHED_CLAIM_SESSION_BYTES
      || retainedBytes > this.#claimSessionCacheBudgetBytes
    ) return;
    this.#cachedClaimSessions.set(fence.runId, { ...candidate, retainedBytes });
    this.#cachedClaimSessionBytes = addRetainedBytes(
      this.#cachedClaimSessionBytes,
      retainedBytes,
    );
    while (
      this.#cachedClaimSessions.size > MAX_CACHED_CLAIM_SESSIONS
      || this.#cachedClaimSessionBytes > this.#claimSessionCacheBudgetBytes
    ) {
      const oldest = this.#cachedClaimSessions.keys().next().value;
      if (oldest === undefined) break;
      this.#deleteCachedClaimSession(oldest);
    }
  }

  #clearClaimSessionForFence(fence: RunFence): void {
    const cached = this.#cachedClaimSessions.get(fence.runId);
    if (
      cached?.fenceGeneration === fence.generation
      && cached.fenceToken === fence.token
    ) this.#deleteCachedClaimSession(fence.runId);
  }

  async #identityForFence(
    directory: string,
    fence: RunFence,
  ): Promise<ValidatedRunMetadata> {
    const cached = this.#claimSession(fence)?.identity;
    if (cached !== undefined) {
      const current = await this.#identitySnapshots(directory);
      if (!this.#sameIdentitySnapshots(cached.snapshots, current)) {
        this.#clearClaimSessionForFence(fence);
        throw new ApplicationError(
          "conflict",
          `Run identity changed while its claim was active: ${fence.runId}`,
        );
      }
      return cached.identity;
    }
    const stable = await this.#readStableIdentity(directory, fence.runId);
    this.#cacheClaimSession(fence, { identity: stable });
    return stable.identity;
  }

  async #identity(runId: string): Promise<ValidatedRunIdentity> {
    const directory = await this.#runDirectory(runId);
    return await this.#readIdentity(directory, runId);
  }

  async create(input: CreateRunRecord): Promise<RunSummary> {
    const submitted = CreateRunRecordSchema.parse(input);
    const graphPlan = parseGraphPlan(submitted.graphPlan);
    if (submitted.bundleBytes.byteLength > MAX_BUNDLE_BYTES) {
      throw new ApplicationError(
        "invalid-data",
        `Workflow bundle exceeds ${String(MAX_BUNDLE_BYTES)} bytes.`,
      );
    }
    const bundleSha256 = createHash("sha256").update(submitted.bundleBytes).digest("hex");
    if (
      submitted.bundleBytes.byteLength !== graphPlan.bundle.bytes
      || bundleSha256 !== graphPlan.bundle.bundleSha256
      || !equalCanonical(submitted.workflow.bundle, graphPlan.bundle)
    ) {
      throw new ApplicationError("invalid-data", "Workflow bundle identity or bytes do not match.");
    }
    if (
      !equalCanonical(submitted.workflow.workflow, graphPlan.graph.workflow)
      || submitted.workflow.sourceLocator !== submitted.sourceLocator
    ) {
      throw new ApplicationError("invalid-data", "Workflow source identity does not match the graph plan.");
    }
    if (
      !equalCanonical(submitted.runtime.runtime, graphPlan.runtime)
      || !equalCanonical(
        submitted.runtime.computes,
        sortedComputeIdentities(graphPlan),
      )
      || !equalCanonical(submitted.runtime.operations, sortedOperationIdentities(graphPlan))
    ) {
      throw new ApplicationError("invalid-data", "Workflow runtime or operation identities do not match.");
    }

    const directory = await this.#runDirectory(submitted.runId, false);
    const root = dirname(directory);
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (errno(error, "EEXIST")) {
        throw new ApplicationError("conflict", `Workflow run already exists: ${submitted.runId}`);
      }
      throw error;
    }
    await syncDirectory(root);
    if (!privateDirectory(await lstat(directory))) {
      throw new ApplicationError("unsafe-path", "New workflow run directory is not private.");
    }
    await mkdir(join(directory, "nodes"), { mode: 0o700 });
    await mkdir(join(directory, "staging"), { mode: 0o700 });
    await writeJsonNoReplace(join(directory, "runtime.json"), submitted.runtime);
    await writeJsonNoReplace(join(directory, "workflow.json"), submitted.workflow);
    await writeNoReplace(join(directory, "workflow.bundle.js"), submitted.bundleBytes);
    await writeJsonNoReplace(join(directory, "graph.json"), graphPlan.graph);
    await writeJsonNoReplace(join(directory, "graph-plan.json"), graphPlan);
    await writeNoReplace(join(directory, "events.jsonl"), "");
    await writeNoReplace(join(directory, "grants.jsonl"), "");

    const nodeDirectory = await this.#nodeDirectory(directory);
    for (const node of graphPlan.graph.nodes) {
      const nodeRecord = RunNodeRecordSchema.parse({
        attempt: 0,
        dependencies: node.dependencies,
        executor: node.executor,
        nodeKey: node.key,
        status: node.dependencies.length === 0 ? "ready" : "pending",
        version: RUN_NODE_VERSION,
      });
      await writeJsonNoReplace(join(nodeDirectory, nodeRecordFilename(node.key)), nodeRecord);
    }
    const now = new Date().toISOString();
    const summary = RunSummarySchema.parse({
      counts: {
        cancelled: 0,
        completed: 0,
        failed: 0,
        pending: graphPlan.graph.nodes.length,
        skipped: 0,
      },
      graphPlanSha256: graphPlan.graphPlanSha256,
      runId: submitted.runId,
      status: "planned",
      updatedAt: now,
      version: RUN_STORE_VERSION,
    });
    await writeJsonNoReplace(join(directory, "summary.json"), summary);
    await writeJsonNoReplace(join(directory, INITIALIZED_FILE), {
      graphPlanSha256: graphPlan.graphPlanSha256,
      runId: submitted.runId,
      version: RUN_STORE_VERSION,
    });
    await syncDirectory(nodeDirectory);
    await syncDirectory(join(directory, "staging"));
    await syncDirectory(directory);
    return summary;
  }

  async list(): Promise<readonly RunSummary[]> {
    const root = await this.#physicalRoot();
    const entries = await readdir(root, { withFileTypes: true });
    const summaries: RunSummary[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !entry.name.startsWith("run_")) continue;
      try {
        const directory = await this.#runDirectory(entry.name);
        const initialized = await readJson(join(directory, INITIALIZED_FILE), InitializedRecordSchema);
        const summary = await readJson(join(directory, "summary.json"), RunSummarySchema);
        if (
          initialized.runId !== summary.runId
          || initialized.graphPlanSha256 !== summary.graphPlanSha256
        ) continue;
        summaries.push(summary);
      } catch {
        // Incomplete or corrupt creations are recovery evidence, not discoverable runs.
      }
    }
    return Object.freeze(summaries.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
  }

  async graphPlan(runId: string): Promise<GraphPlanV1> {
    return (await this.#identity(runId)).graphPlan;
  }

  async graph(runId: string) {
    return (await this.#identity(runId)).graphPlan.graph;
  }

  async workflow(runId: string): Promise<RunWorkflowRecord> {
    return (await this.#identity(runId)).workflow;
  }

  async runtime(runId: string): Promise<RunRuntimeRecord> {
    return (await this.#identity(runId)).runtime;
  }

  async bundle(runId: string): Promise<Uint8Array> {
    return new Uint8Array((await this.#identity(runId)).bundleBytes);
  }

  /**
   * Resolves one durable private workspace bound to the current fenced
   * node-execution plan. The path is host-owned and never serialized into
   * authored graph input.
   */
  async stagingDirectory(
    fence: RunFence,
    nodeKey: string,
    nodePlanSha256: string,
  ): Promise<string> {
    const parsedFence = RunFenceSchema.parse(fence);
    const parsedNodeKey = NodeKeySchema.parse(nodeKey);
    const parsedNodePlanSha256 = Sha256Schema.parse(nodePlanSha256);
    return await this.#withPhysicalLock(parsedFence.runId, async directory => {
      await this.#assertFenceIn(directory, parsedFence);
      const identity = await this.#identityForFence(directory, parsedFence);
      const record = await readJson(
        join(
          await this.#nodeDirectory(directory),
          nodeRecordFilename(parsedNodeKey),
        ),
        RunNodeRecordSchema,
      );
      if (
        record.nodeKey !== parsedNodeKey
        || record.executionPlan?.nodePlanSha256 !== parsedNodePlanSha256
      ) {
        throw new ApplicationError(
          "conflict",
          `Node staging identity does not match its exact execution plan: ${parsedNodeKey}`,
        );
      }
      const staging = await this.#privateChildDirectory(
        identity.directory,
        "staging",
      );
      const nodeDigest = nodeRecordFilename(parsedNodeKey).slice(0, -".json".length);
      const nodeDirectory = await this.#ensurePrivateChildDirectory(
        staging,
        nodeDigest,
      );
      const planDirectory = await this.#ensurePrivateChildDirectory(
        nodeDirectory,
        parsedNodePlanSha256,
      );
      await syncDirectory(nodeDirectory);
      await syncDirectory(staging);
      return planDirectory;
    });
  }

  async summary(runId: string): Promise<RunSummary> {
    const identity = await this.#identity(runId);
    const summary = await readJson(join(identity.directory, "summary.json"), RunSummarySchema);
    if (
      summary.runId !== runId
      || summary.graphPlanSha256 !== identity.graphPlan.graphPlanSha256
    ) {
      throw new ApplicationError("invalid-data", "Run summary identity is inconsistent.");
    }
    if (summary.outputs !== undefined) {
      const outputs = await this.outputs(runId);
      if (outputs === undefined || !equalCanonical(outputs.outputs, summary.outputs)) {
        throw new ApplicationError("invalid-data", "Run summary output identity is inconsistent.");
      }
    }
    if (TERMINAL_RUN_STATUSES.has(summary.status)) {
      const records = await this.#loadNodes(identity);
      if (
        !equalCanonical(summary.counts, countsFor(records))
        || summary.status !== derivedRunStatus(records)
        || summary.finishedAt === undefined
      ) {
        throw new ApplicationError("invalid-data", "Terminal run summary is inconsistent with node state.");
      }
    }
    return summary;
  }

  async #loadNodes(identity: ValidatedRunMetadata): Promise<readonly RunNodeRecord[]> {
    const nodeDirectory = await this.#nodeDirectory(identity.directory);
    const records = await Promise.all(identity.graphPlan.graph.nodes.map(async node => (
      await readJson(
        join(nodeDirectory, nodeRecordFilename(node.key)),
        RunNodeRecordSchema,
      )
    )));
    const recordsByKey = new Map(records.map(record => [record.nodeKey, record]));
    if (recordsByKey.size !== identity.graphPlan.graph.nodes.length) {
      throw new ApplicationError("invalid-data", "Run node identities are duplicated or missing.");
    }
    for (const node of identity.graphPlan.graph.nodes) {
      const record = recordsByKey.get(node.key);
      if (record === undefined) {
        throw new ApplicationError("invalid-data", `Run is missing authored node ${node.key}.`);
      }
      this.#validateNodeRecord(identity.graphPlan, node, record, recordsByKey);
    }
    return Object.freeze(records);
  }

  async #loadNodeContext(
    identity: ValidatedRunMetadata,
    nodeKey: string,
  ): Promise<{
    readonly authored: AuthoredGraphNodeV1;
    readonly record: RunNodeRecord;
    readonly recordsByKey: ReadonlyMap<string, RunNodeRecord>;
  }> {
    const authored = identity.graphPlan.graph.nodes.find(node => node.key === nodeKey);
    if (authored === undefined) {
      throw new ApplicationError("not-found", `Workflow run node does not exist: ${nodeKey}`);
    }
    const nodeDirectory = await this.#nodeDirectory(identity.directory);
    const authoredByKey = new Map(
      identity.graphPlan.graph.nodes.map(node => [node.key, node]),
    );
    const relevant = new Set<string>();
    const pending = [authored.key];
    while (pending.length > 0) {
      const key = pending.pop();
      if (key === undefined || relevant.has(key)) continue;
      const node = authoredByKey.get(key);
      if (node === undefined) {
        throw new ApplicationError("invalid-data", `Run graph is missing dependency ${key}.`);
      }
      relevant.add(key);
      pending.push(...node.dependencies);
    }
    const relevantKeys = [...relevant];
    const records = await Promise.all(relevantKeys.map(async key => (
      await readJson(
        join(nodeDirectory, nodeRecordFilename(key)),
        RunNodeRecordSchema,
      )
    )));
    const recordsByKey = new Map(records.map(record => [record.nodeKey, record]));
    if (recordsByKey.size !== relevantKeys.length) {
      throw new ApplicationError(
        "invalid-data",
        `Run node context contains duplicated or missing identities: ${nodeKey}`,
      );
    }
    for (const key of relevantKeys) {
      const record = recordsByKey.get(key);
      const expected = authoredByKey.get(key);
      if (record === undefined || expected === undefined) {
        throw new ApplicationError("invalid-data", `Run is missing authored node ${key}.`);
      }
      this.#validateNodeRecord(identity.graphPlan, expected, record, recordsByKey);
    }
    const record = recordsByKey.get(authored.key);
    if (record === undefined) {
      throw new ApplicationError("invalid-data", `Run is missing authored node ${authored.key}.`);
    }
    return {
      authored,
      record,
      recordsByKey,
    };
  }

  #validateNodeRecord(
    graphPlan: GraphPlanV1,
    authored: AuthoredGraphNodeV1,
    record: RunNodeRecord,
    recordsByKey: ReadonlyMap<string, RunNodeRecord>,
  ): void {
    if (
      record.nodeKey !== authored.key
      || !equalCanonical(record.dependencies, authored.dependencies)
      || !equalCanonical(record.executor, authored.executor)
    ) {
      throw new ApplicationError("invalid-data", `Persisted node identity changed: ${authored.key}`);
    }
    const policy = nodePolicy(graphPlan, authored);
    if (record.executionPlan !== undefined && record.preparationPlan === undefined) {
      throw new ApplicationError(
        "invalid-data",
        `Execution plan has no preparation plan for node ${authored.key}.`,
      );
    }
    if (record.preparationPlan !== undefined) {
      const { preparationPlanSha256, ...unsigned } = record.preparationPlan;
      if (
        record.preparationPlan.version !== NODE_PREPARATION_PLAN_VERSION
        || preparationPlanSha256 !== createNodePreparationPlanHash(unsigned)
        || record.preparationPlan.graphPlanSha256 !== graphPlan.graphPlanSha256
        || record.preparationPlan.nodeKey !== authored.key
        || !equalCanonical(record.preparationPlan.executor, authored.executor)
        || !equalCanonical(
          record.preparationPlan.requestedPreparation,
          [...policy.preparation].sort((left, right) => left.localeCompare(right)),
        )
        || record.preparationPlan.upperDurationMs > policy.maxDurationMs
        || record.preparationPlan.upperInputBytes > policy.maxInputBytes
      ) {
        throw new ApplicationError(
          "invalid-data",
          `Preparation plan digest or identity is invalid for node ${authored.key}.`,
        );
      }
    }
    if (record.executionPlan !== undefined) {
      const { nodePlanSha256, ...unsigned } = record.executionPlan;
      const expectedDependencyDigests = Object.fromEntries(
        [...authored.dependencies].sort((left, right) => left.localeCompare(right)).map(key => {
          const dependency = recordsByKey.get(key);
          if (dependency?.status !== "completed" || dependency.output === undefined) {
            throw new ApplicationError(
              "invalid-data",
              `Execution plan for ${authored.key} references incomplete dependency ${key}.`,
            );
          }
          return [key, dependency.output.digestSha256];
        }),
      );
      const publicationKeys = [...record.executionPlan.publicationKeys]
        .sort((left, right) => left.localeCompare(right));
      if (
        record.executionPlan.version !== NODE_EXECUTION_PLAN_VERSION
        || nodePlanSha256 !== createNodeExecutionPlanHash(unsigned)
        || record.executionPlan.inputSha256 !== createNodeInputHash(record.executionPlan.exactInput)
        || record.executionPlan.graphPlanSha256 !== graphPlan.graphPlanSha256
        || record.executionPlan.nodeKey !== authored.key
        || record.executionPlan.preparationPlanSha256
          !== record.preparationPlan?.preparationPlanSha256
        || !equalCanonical(record.executionPlan.executor, authored.executor)
        || !equalCanonical(record.executionPlan.policy, normalizedPolicy(policy))
        || !equalCanonical(record.executionPlan.dependencyOutputDigests, expectedDependencyDigests)
        || !equalCanonical(record.executionPlan.publicationKeys, publicationKeys)
        || new Set(publicationKeys).size !== publicationKeys.length
      ) {
        throw new ApplicationError(
          "invalid-data",
          `Execution plan digest or identity is invalid for node ${authored.key}.`,
        );
      }
    }
    if (
      record.output !== undefined
      && record.output.digestSha256 !== createRunNodeOutputDigest(record.output.value)
    ) {
      throw new ApplicationError("invalid-data", `Output digest is invalid for node ${authored.key}.`);
    }
  }

  async node(runId: string, nodeKey: string): Promise<RunNodeRecord> {
    const parsedKey = NodeKeySchema.parse(nodeKey);
    const identity = await this.#identity(runId);
    return (await this.#loadNodeContext(identity, parsedKey)).record;
  }

  async nodes(runId: string): Promise<readonly RunNodeRecord[]> {
    const identity = await this.#identity(runId);
    return await this.#loadNodes(identity);
  }

  async events(runId: string): Promise<readonly RunEvent[]> {
    const directory = await this.#runDirectory(runId);
    const events = await readJsonLines(join(directory, "events.jsonl"), RunEventSchema);
    validateEventSequence(events, runId);
    return events;
  }

  async grants(runId: string): Promise<readonly RunGrant[]> {
    const identity = await this.#identity(runId);
    const grants = await readJsonLines(join(identity.directory, "grants.jsonl"), RunGrantSchema);
    validateGrantLedger(grants, runId, identity.graphPlan.graphPlanSha256);
    return grants;
  }

  async outputs(runId: string): Promise<RunOutputs | undefined> {
    const identity = await this.#identity(runId);
    const outputPath = join(identity.directory, "outputs.json");
    const outputs = await readJson(outputPath, RunOutputsSchema).catch(error => {
      if (error instanceof ApplicationError && error.code === "not-found") return undefined;
      throw error;
    });
    if (outputs === undefined) return undefined;
    if (
      outputs.runId !== runId
      || outputs.graphPlanSha256 !== identity.graphPlan.graphPlanSha256
      || outputs.outputsSha256 !== createRunOutputsDigest(outputs.outputs)
    ) {
      throw new ApplicationError("invalid-data", "Persisted run outputs have an invalid identity.");
    }
    const records = await this.#loadNodes(identity);
    const recordsByKey = new Map(records.map(record => [record.nodeKey, record]));
    const digests: Record<string, string> = {};
    const resolved = resolveOutputBinding(identity.graphPlan.graph.outputs, recordsByKey, digests);
    if (
      resolved === undefined
      || !equalCanonical(outputs.outputs, resolved)
      || !equalCanonical(outputs.nodeOutputDigests, digests)
    ) {
      throw new ApplicationError("invalid-data", "Persisted run outputs differ from completed nodes.");
    }
    return outputs;
  }

  async #existingClaimIn(directory: string): Promise<ExistingClaim | undefined> {
    const path = join(directory, CLAIM_FILE);
    let details: Stats;
    try {
      details = await lstat(path);
    } catch (error) {
      if (errno(error, "ENOENT")) return undefined;
      throw error;
    }
    const fence = await readJson(path, RunFenceSchema);
    return { fence, snapshot: snapshot(details) };
  }

  async #assertFenceIn(directory: string, fence: RunFence): Promise<RunFence> {
    const parsed = RunFenceSchema.parse(fence);
    const existing = await this.#existingClaimIn(directory);
    if (
      existing === undefined
      || existing.fence.generation !== parsed.generation
      || existing.fence.token !== parsed.token
      || existing.fence.owner !== parsed.owner
      || existing.fence.runId !== parsed.runId
    ) {
      this.#clearClaimSessionForFence(parsed);
      throw new ApplicationError("conflict", `Workflow run fence is stale: ${parsed.runId}`);
    }
    return parsed;
  }

  async #appendEventIn(
    directory: string,
    fence: RunFence,
    input: NewRunEvent,
  ): Promise<RunEvent> {
    const cached = this.#claimSession(fence)?.eventJournal;
    const appended = await appendJournalEntry(
      join(directory, "events.jsonl"),
      RunEventSchema,
      entries => validateEventSequence(entries, fence.runId),
      ({ cursor }) => {
        if (fence.generation < cursor.lastFenceGeneration) {
          throw new ApplicationError(
            "invalid-data",
            `Run event fence generation regressed for ${fence.runId}.`,
          );
        }
        const event = RunEventSchema.parse({
          ...input,
          fenceGeneration: fence.generation,
          runId: fence.runId,
          sequence: cursor.lastSequence + 1,
          version: RUN_EVENT_VERSION,
        });
        return { entry: event, result: event };
      },
      (_cursor, event) => ({
        lastFenceGeneration: event.fenceGeneration,
        lastSequence: event.sequence,
      }),
      cached,
    );
    this.#cacheClaimSession(fence, { eventJournal: appended.state });
    return appended.result;
  }

  async acquireClaim(runId: string, options: AcquireRunClaimOptions): Promise<RunFence> {
    return await this.#withPhysicalLock(runId, async directory => {
      const stableIdentity = await this.#readStableIdentity(directory, runId);
      const now = (options.now ?? (() => new Date()))();
      const staleAfterMs = options.staleAfterMs ?? 30_000;
      if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 0) {
        throw new ApplicationError("usage", "Run claim stale interval must be a nonnegative safe integer.");
      }
      const existing = await this.#existingClaimIn(directory);
      let previousGeneration = existing?.fence.generation ?? 0;
      if (existing !== undefined) {
        const age = now.getTime() - Date.parse(existing.fence.acquiredAt);
        const ownerAlive = existing.fence.hostname !== hostname()
          || (options.processAlive ?? localProcessAlive)(existing.fence.pid);
        if (age < staleAfterMs || ownerAlive) {
          throw new ApplicationError("conflict", `Workflow run is already claimed: ${runId}`, {
            acquiredAt: existing.fence.acquiredAt,
            owner: existing.fence.owner,
            pid: existing.fence.pid,
          });
        }
        const current = await lstat(join(directory, CLAIM_FILE)).catch(() => undefined);
        if (current === undefined || !sameSnapshot(existing.snapshot, snapshot(current))) {
          throw new ApplicationError("conflict", `Workflow run claim changed during reclaim: ${runId}`);
        }
        await unlink(join(directory, CLAIM_FILE));
        await syncDirectory(directory);
      }
      // No live claim remains under the physical lock, so an entry left behind
      // by a release through another RunStore instance cannot describe this session.
      this.#deleteCachedClaimSession(runId);

      const generationRecord = await readJson(
        join(directory, CLAIM_GENERATION_FILE),
        ClaimGenerationRecordSchema,
      ).catch(error => {
        if (error instanceof ApplicationError && error.code === "not-found") return undefined;
        throw error;
      });
      previousGeneration = Math.max(previousGeneration, generationRecord?.generation ?? 0);
      const generation = previousGeneration + 1;
      const fence = RunFenceSchema.parse({
        acquiredAt: now.toISOString(),
        generation,
        hostname: hostname(),
        owner: options.owner,
        pid: process.pid,
        runId,
        token: randomUUID(),
        version: RUN_FENCE_VERSION,
      });

      // Reserve the generation before the claim can become visible. A crash may skip a
      // generation, but can never reuse one.
      await writeJsonAtomic(join(directory, CLAIM_GENERATION_FILE), {
        generation,
        version: RUN_STORE_VERSION,
      });
      try {
        await publishJsonNoReplace(join(directory, CLAIM_FILE), fence);
        await this.#appendEventIn(directory, fence, {
          details: { owner: fence.owner },
          kind: "run-claimed",
          timestamp: fence.acquiredAt,
        });
        this.#cacheClaimSession(fence, { identity: stableIdentity });
        return fence;
      } catch (error) {
        this.#clearClaimSessionForFence(fence);
        const published = await this.#existingClaimIn(directory).catch(() => undefined);
        if (
          published?.fence.token === fence.token
          && published.fence.generation === fence.generation
        ) {
          const current = await lstat(join(directory, CLAIM_FILE)).catch(() => undefined);
          if (current !== undefined && sameSnapshot(published.snapshot, snapshot(current))) {
            await unlink(join(directory, CLAIM_FILE)).catch(() => undefined);
            await syncDirectory(directory).catch(() => undefined);
          }
        }
        throw error;
      }
    });
  }

  async assertFence(fence: RunFence): Promise<void> {
    const parsed = RunFenceSchema.parse(fence);
    await this.#assertFenceIn(await this.#runDirectory(parsed.runId), parsed);
  }

  async releaseClaim(fence: RunFence): Promise<void> {
    const parsed = RunFenceSchema.parse(fence);
    await this.#withPhysicalLock(parsed.runId, async directory => {
      await this.#assertFenceIn(directory, parsed);
      const existing = await this.#existingClaimIn(directory);
      if (existing === undefined) {
        throw new ApplicationError("conflict", `Workflow run fence is stale: ${parsed.runId}`);
      }
      const current = await lstat(join(directory, CLAIM_FILE));
      if (!sameSnapshot(existing.snapshot, snapshot(current))) {
        throw new ApplicationError(
          "conflict",
          `Workflow run claim changed during release: ${parsed.runId}`,
        );
      }
      await unlink(join(directory, CLAIM_FILE));
      await syncDirectory(directory);
      this.#clearClaimSessionForFence(parsed);
    });
  }

  async appendEvent(fence: RunFence, input: NewRunEvent): Promise<RunEvent> {
    const parsed = RunFenceSchema.parse(fence);
    return await this.#withPhysicalLock(parsed.runId, async directory => {
      await this.#assertFenceIn(directory, parsed);
      if (input.nodeKey !== undefined) {
        const identity = await this.#identityForFence(directory, parsed);
        if (!identity.graphPlan.graph.nodes.some(node => node.key === input.nodeKey)) {
          throw new ApplicationError("invalid-data", `Run event names an unknown node: ${input.nodeKey}`);
        }
      }
      return await this.#appendEventIn(directory, parsed, input);
    });
  }

  #validateTransition(
    graphPlan: GraphPlanV1,
    authored: AuthoredGraphNodeV1,
    current: RunNodeRecord,
    next: RunNodeRecord,
    recordsByKey: ReadonlyMap<string, RunNodeRecord>,
  ): void {
    if (TERMINAL_NODE_STATUSES.has(current.status)) {
      if (!equalCanonical(current, next)) {
        throw new ApplicationError(
          "conflict",
          `Terminal run node ${current.nodeKey} is immutable.`,
        );
      }
      return;
    }
    if (!FORWARD_NODE_TRANSITIONS[current.status].has(next.status)) {
      throw new ApplicationError(
        "invalid-data",
        `Illegal run node transition ${current.status} -> ${next.status} for ${current.nodeKey}.`,
      );
    }
    const expectedAttempt = current.status === "ready" && next.status === "running"
      ? current.attempt + 1
      : current.attempt;
    if (next.attempt !== expectedAttempt) {
      throw new ApplicationError(
        "invalid-data",
        `Run node attempt changed outside ready -> running for ${current.nodeKey}.`,
      );
    }
    if (
      current.preparationPlan !== undefined
      && !equalCanonical(current.preparationPlan, next.preparationPlan)
    ) {
      throw new ApplicationError("conflict", `Preparation plan changed for ${current.nodeKey}.`);
    }
    if (
      current.executionPlan !== undefined
      && !equalCanonical(current.executionPlan, next.executionPlan)
    ) {
      throw new ApplicationError("conflict", `Execution plan changed for ${current.nodeKey}.`);
    }
    if (
      !(current.status === "ready" && next.status === "running")
      && current.startedAt !== next.startedAt
    ) {
      throw new ApplicationError("invalid-data", `Run node startedAt changed illegally: ${current.nodeKey}`);
    }
    if (
      current.status === "ready"
      && next.status === "running"
      && current.startedAt !== undefined
      && Date.parse(next.startedAt!) < Date.parse(current.startedAt)
    ) {
      throw new ApplicationError("invalid-data", `Run node startedAt regressed: ${current.nodeKey}`);
    }
    if (
      current.status === "pending"
      && next.status === "ready"
      && authored.dependencies.some(key => recordsByKey.get(key)?.status !== "completed")
    ) {
      throw new ApplicationError(
        "invalid-data",
        `Run node ${current.nodeKey} became ready before all dependencies completed.`,
      );
    }
    if (current.status === "running" && next.status === "ready") {
      const resume = nodePolicy(graphPlan, authored).resume;
      if (
        resume !== "deterministic"
        && resume !== "verified-receipt"
        && resume !== "recoverable-transaction"
      ) {
        throw new ApplicationError(
          "conflict",
          `Interrupted node ${current.nodeKey} cannot be retried under ${resume}.`,
        );
      }
    }
  }

  async writeNode(fence: RunFence, node: RunNodeRecord): Promise<void> {
    const parsedFence = RunFenceSchema.parse(fence);
    await this.#withPhysicalLock(parsedFence.runId, async directory => {
      await this.#assertFenceIn(directory, parsedFence);
      const parsedNode = RunNodeRecordSchema.parse(node);
      const identity = await this.#identityForFence(directory, parsedFence);
      const context = await this.#loadNodeContext(identity, parsedNode.nodeKey);
      const nextByKey = new Map(context.recordsByKey);
      nextByKey.set(parsedNode.nodeKey, parsedNode);
      this.#validateTransition(
        identity.graphPlan,
        context.authored,
        context.record,
        parsedNode,
        nextByKey,
      );
      this.#validateNodeRecord(
        identity.graphPlan,
        context.authored,
        parsedNode,
        nextByKey,
      );
      const nodeDirectory = await this.#nodeDirectory(directory);
      await writeJsonAtomic(
        join(nodeDirectory, nodeRecordFilename(parsedNode.nodeKey)),
        parsedNode,
      );
    });
  }

  async writeSummary(fence: RunFence, summary: RunSummary): Promise<void> {
    const parsedFence = RunFenceSchema.parse(fence);
    await this.#withPhysicalLock(parsedFence.runId, async directory => {
      await this.#assertFenceIn(directory, parsedFence);
      const parsedSummary = RunSummarySchema.parse(summary);
      const identity = await this.#identityForFence(directory, parsedFence);
      if (
        parsedSummary.runId !== parsedFence.runId
        || parsedSummary.graphPlanSha256 !== identity.graphPlan.graphPlanSha256
      ) {
        throw new ApplicationError("invalid-data", "Run summary identity is inconsistent.");
      }
      const current = await readJson(join(directory, "summary.json"), RunSummarySchema);
      if (TERMINAL_RUN_STATUSES.has(current.status)) {
        if (!equalCanonical(current, parsedSummary)) {
          throw new ApplicationError("conflict", "Terminal run summary is immutable.");
        }
        return;
      }
      if (Date.parse(parsedSummary.updatedAt) < Date.parse(current.updatedAt)) {
        throw new ApplicationError("invalid-data", "Run summary updatedAt regressed.");
      }
      if (
        current.startedAt !== undefined
        && parsedSummary.startedAt !== current.startedAt
      ) {
        throw new ApplicationError("invalid-data", "Run summary startedAt changed.");
      }
      if (parsedSummary.status !== "planned" && parsedSummary.startedAt === undefined) {
        throw new ApplicationError("invalid-data", "Started run summaries require startedAt.");
      }
      const terminal = TERMINAL_RUN_STATUSES.has(parsedSummary.status);
      if (terminal !== (parsedSummary.finishedAt !== undefined)) {
        throw new ApplicationError(
          "invalid-data",
          "Only terminal run summaries require finishedAt.",
        );
      }
      const records = await this.#loadNodes(identity);
      if (!equalCanonical(parsedSummary.counts, countsFor(records))) {
        throw new ApplicationError("invalid-data", "Run summary counts do not match node state.");
      }
      const expectedStatus = derivedRunStatus(records);
      if (parsedSummary.status !== expectedStatus) {
        throw new ApplicationError(
          "invalid-data",
          `Run summary status ${parsedSummary.status} does not match ${expectedStatus}.`,
        );
      }

      if (parsedSummary.status === "completed") {
        const digests: Record<string, string> = {};
        const recordsByKey = new Map(records.map(record => [record.nodeKey, record]));
        const expectedOutputs = resolveOutputBinding(
          identity.graphPlan.graph.outputs,
          recordsByKey,
          digests,
        );
        if (
          expectedOutputs === undefined
          || parsedSummary.outputs === undefined
          || !equalCanonical(parsedSummary.outputs, expectedOutputs)
        ) {
          throw new ApplicationError(
            "invalid-data",
            "Completed run outputs do not match the authored output bindings.",
          );
        }
        const outputRecord = RunOutputsSchema.parse({
          graphPlanSha256: identity.graphPlan.graphPlanSha256,
          nodeOutputDigests: digests,
          outputs: expectedOutputs,
          outputsSha256: createRunOutputsDigest(expectedOutputs),
          runId: parsedFence.runId,
          version: RUN_OUTPUTS_VERSION,
        });
        try {
          await publishJsonNoReplace(join(directory, "outputs.json"), outputRecord);
        } catch (error) {
          if (!errno(error, "EEXIST")) throw error;
          const existing = await readJson(join(directory, "outputs.json"), RunOutputsSchema);
          if (!equalCanonical(existing, outputRecord)) {
            throw new ApplicationError("conflict", "Run outputs were already published differently.");
          }
        }
      } else if (parsedSummary.outputs !== undefined) {
        throw new ApplicationError("invalid-data", "Only completed runs may publish outputs.");
      }
      await writeJsonAtomic(join(directory, "summary.json"), parsedSummary);
    });
  }

  async appendGrant(fence: RunFence, grant: NewRunGrant): Promise<RunGrant> {
    const parsedFence = RunFenceSchema.parse(fence);
    return await this.#withPhysicalLock(parsedFence.runId, async directory => {
      await this.#assertFenceIn(directory, parsedFence);
      const identity = await this.#identityForFence(directory, parsedFence);
      const parsedGrant = RunGrantSchema.parse({
        ...grant,
        runId: parsedFence.runId,
        version: RUN_GRANT_VERSION,
      });
      if (parsedGrant.graphPlanSha256 !== identity.graphPlan.graphPlanSha256) {
        throw new ApplicationError("invalid-data", "Run grant targets a different graph plan.");
      }
      if (
        "nodeKey" in parsedGrant
        && !identity.graphPlan.graph.nodes.some(node => node.key === parsedGrant.nodeKey)
      ) {
        throw new ApplicationError("invalid-data", `Run grant targets unknown node ${parsedGrant.nodeKey}.`);
      }
      if (
        parsedGrant.kind === "compute-replay"
        && parsedGrant.bundleSha256 !== identity.graphPlan.bundle.bundleSha256
      ) {
        throw new ApplicationError("invalid-data", "Compute replay grant targets a different bundle.");
      }
      if (parsedGrant.kind === "compute-replay") {
        const authored = identity.graphPlan.graph.nodes.find(
          node => node.key === parsedGrant.nodeKey,
        );
        if (authored === undefined || !isComputeGraphNode(authored)) {
          throw new ApplicationError(
            "invalid-data",
            `Compute replay grant targets a non-compute node: ${parsedGrant.nodeKey}`,
          );
        }
        const records = await this.#loadNodes(identity);
        const record = records.find(node => node.nodeKey === parsedGrant.nodeKey);
        if (
          record?.status !== "ambiguous-code"
          || record.executionPlan === undefined
          || parsedGrant.computeKey !== authored.executor.compute.key
          || parsedGrant.nodePlanSha256 !== record.executionPlan.nodePlanSha256
          || parsedGrant.attempt !== record.attempt + 1
        ) {
          throw new ApplicationError(
            "conflict",
            `Compute replay grant does not match the exact next attempt for ${parsedGrant.nodeKey}.`,
          );
        }
      }
      const cached = this.#claimSession(parsedFence)?.grantJournal;
      const appended = await appendJournalEntry(
        join(directory, "grants.jsonl"),
        RunGrantSchema,
        entries => validateGrantLedger(
          entries,
          parsedFence.runId,
          identity.graphPlan.graphPlanSha256,
        ),
        ({ cursor }) => {
          if (cursor.grantIds.has(parsedGrant.grantId)) {
            throw new ApplicationError("conflict", `Run grant already exists: ${parsedGrant.grantId}`);
          }
          return { entry: parsedGrant, result: parsedGrant };
        },
        (cursor, persisted) => {
          cursor.grantIds.add(persisted.grantId);
          return cursor;
        },
        cached,
      );
      this.#cacheClaimSession(parsedFence, { grantJournal: appended.state });
      return appended.result;
    });
  }

  async reopenComputeNode(fence: RunFence, nodeKey: string): Promise<RunNodeRecord> {
    const parsedFence = RunFenceSchema.parse(fence);
    const parsedKey = NodeKeySchema.parse(nodeKey);
    return await this.#withPhysicalLock(parsedFence.runId, async directory => {
      await this.#assertFenceIn(directory, parsedFence);
      const identity = await this.#identityForFence(directory, parsedFence);
      const authored = identity.graphPlan.graph.nodes.find(
        node => node.key === parsedKey,
      );
      if (authored === undefined || !isComputeGraphNode(authored)) {
        throw new ApplicationError(
          "invalid-data",
          `Only a trusted compute node may be reopened: ${parsedKey}`,
        );
      }
      const records = await this.#loadNodes(identity);
      const current = records.find(node => node.nodeKey === parsedKey);
      if (
        current?.status !== "ambiguous-code"
        || current.executionPlan === undefined
      ) {
        throw new ApplicationError(
          "conflict",
          `Compute node is not awaiting an explicit replay: ${parsedKey}`,
        );
      }
      const grants = await readJsonLines(
        join(directory, "grants.jsonl"),
        RunGrantSchema,
      );
      validateGrantLedger(
        grants,
        parsedFence.runId,
        identity.graphPlan.graphPlanSha256,
      );
      const authorized = grants.some(grant => (
        grant.kind === "compute-replay"
        && grant.nodeKey === parsedKey
        && grant.attempt === current.attempt + 1
        && grant.bundleSha256 === identity.graphPlan.bundle.bundleSha256
        && grant.computeKey === authored.executor.compute.key
        && grant.nodePlanSha256 === current.executionPlan?.nodePlanSha256
      ));
      if (!authorized) {
        throw new ApplicationError(
          "authorization-required",
          `Compute node ${parsedKey} requires an exact replay grant for attempt ${String(current.attempt + 1)}.`,
        );
      }
      const retained: Record<string, unknown> = { ...current };
      delete retained.failure;
      delete retained.finishedAt;
      const reopened = RunNodeRecordSchema.parse({
        ...retained,
        status: "ready",
      });
      const recordsByKey = new Map(records.map(record => [
        record.nodeKey,
        record.nodeKey === parsedKey ? reopened : record,
      ]));
      this.#validateNodeRecord(
        identity.graphPlan,
        authored,
        reopened,
        recordsByKey,
      );
      await writeJsonAtomic(
        join(
          await this.#nodeDirectory(directory),
          nodeRecordFilename(parsedKey),
        ),
        reopened,
      );
      return reopened;
    });
  }

  async requestCancellation(
    runId: string,
    requestedBy: string,
    now = new Date(),
  ): Promise<CancellationRequest> {
    return await this.#withPhysicalLock(runId, async directory => {
      await this.#readIdentity(directory, runId);
      const path = join(directory, "cancel-request.json");
      const existing = await readJson(path, CancellationRequestSchema).catch(error => {
        if (error instanceof ApplicationError && error.code === "not-found") return undefined;
        throw error;
      });
      if (existing !== undefined) return existing;
      const request = CancellationRequestSchema.parse({
        requestedAt: now.toISOString(),
        requestedBy,
        runId,
        version: RUN_STORE_VERSION,
      });
      try {
        await publishJsonNoReplace(path, request);
        return request;
      } catch (error) {
        const published = await readJson(path, CancellationRequestSchema).catch(() => undefined);
        if (published !== undefined) return published;
        throw error;
      }
    });
  }

  async cancellation(runId: string): Promise<CancellationRequest | undefined> {
    const directory = await this.#runDirectory(runId);
    return await readJson(join(directory, "cancel-request.json"), CancellationRequestSchema)
      .then(request => {
        if (request.runId !== runId) {
          throw new ApplicationError("invalid-data", "Cancellation request targets a different run.");
        }
        return request;
      })
      .catch(error => {
        if (error instanceof ApplicationError && error.code === "not-found") return undefined;
        throw error;
      });
  }
}
