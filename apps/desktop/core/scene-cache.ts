import { canonicalJsonSha256 } from "./canonical-json";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const SCENE_ID_PATTERN = /^scene_[a-z0-9][a-z0-9_-]{7,63}$/u;
const SAMPLE_ID_PATTERN = /^sample_[a-z0-9][a-z0-9_-]{7,63}$/u;

export interface SceneBatchCacheIdentity {
  readonly inputDigest: string;
  readonly model: {
    readonly aiSdkVersion: string;
    readonly gateway: "vercel-ai-gateway";
    readonly promptSha256: string;
    readonly promptVersion: string;
    readonly requestedModel: string;
    readonly samplingVersion: string;
  };
  readonly samples: readonly {
    readonly actualAssetTimeUs: number;
    readonly sampleId: string;
    readonly sha256: string;
  }[];
  readonly sceneIds: readonly string[];
}

function requireSha256(value: string, label: string): void {
  if (!SHA256_PATTERN.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

function requireBoundedText(value: string, label: string, maximum: number): void {
  if (value.length < 1 || value.length > maximum || containsControlCharacter(value)) {
    throw new TypeError(`${label} must be bounded printable text.`);
  }
}

export function sceneBatchCacheKey(identity: SceneBatchCacheIdentity): string {
  requireSha256(identity.inputDigest, "Cache inputDigest");
  requireSha256(identity.model.promptSha256, "Cache promptSha256");
  requireBoundedText(identity.model.aiSdkVersion, "Cache aiSdkVersion", 128);
  requireBoundedText(identity.model.promptVersion, "Cache promptVersion", 128);
  requireBoundedText(identity.model.requestedModel, "Cache requestedModel", 256);
  requireBoundedText(identity.model.samplingVersion, "Cache samplingVersion", 128);
  if (identity.sceneIds.length < 1 || identity.sceneIds.length > 4) {
    throw new TypeError("A scene cache batch must contain between one and four scenes.");
  }
  if (new Set(identity.sceneIds).size !== identity.sceneIds.length || identity.sceneIds.some(id => !SCENE_ID_PATTERN.test(id))) {
    throw new TypeError("Cache scene IDs must be unique opaque scene identifiers.");
  }
  if (identity.samples.length < 1 || identity.samples.length > 12) {
    throw new TypeError("A scene cache batch must contain between one and twelve samples.");
  }
  if (new Set(identity.samples.map(sample => sample.sampleId)).size !== identity.samples.length) {
    throw new TypeError("Cache sample IDs must be unique.");
  }
  const samples = [...identity.samples].sort((left, right) => left.sampleId.localeCompare(right.sampleId));
  for (const sample of samples) {
    if (!SAMPLE_ID_PATTERN.test(sample.sampleId)) throw new TypeError("Cache sample IDs must be opaque sample identifiers.");
    if (!Number.isSafeInteger(sample.actualAssetTimeUs) || sample.actualAssetTimeUs < 0) {
      throw new TypeError("Cache sample times must be nonnegative safe integers.");
    }
    requireSha256(sample.sha256, "Cache sample sha256");
  }
  return canonicalJsonSha256({
    inputDigest: identity.inputDigest,
    model: identity.model,
    samples,
    sceneIds: identity.sceneIds,
    version: 1,
  });
}

export type SceneBatchState = "ambiguous" | "complete" | "dispatching" | "failed" | "planned";

export interface SceneBatchStateRecord {
  readonly batchKey: string;
  readonly errorCode: string | null;
  readonly imageBytes: number;
  readonly imageCount: number;
  readonly sceneIds: readonly string[];
  readonly state: SceneBatchState;
}

export type SceneBatchEvent =
  | { readonly kind: "dispatch" }
  | { readonly kind: "complete" }
  | {
    readonly errorCode: string;
    readonly kind: "fail";
    readonly outcome: "ambiguous" | "definitive";
  }
  | {
    readonly acknowledgement: "explicit-user-retry";
    readonly kind: "retry";
  };

function requireStateRecord(batch: SceneBatchStateRecord): void {
  requireSha256(batch.batchKey, "Scene batch key");
  if (!Number.isSafeInteger(batch.imageBytes) || batch.imageBytes < 0 || batch.imageBytes > 6_000_000) {
    throw new TypeError("Scene batch imageBytes is outside its contract.");
  }
  if (!Number.isSafeInteger(batch.imageCount) || batch.imageCount < 1 || batch.imageCount > 12) {
    throw new TypeError("Scene batch imageCount is outside its contract.");
  }
  if (batch.sceneIds.length < 1 || batch.sceneIds.length > 4 || batch.sceneIds.some(id => !SCENE_ID_PATTERN.test(id))) {
    throw new TypeError("Scene batch sceneIds is outside its contract.");
  }
  const errorExpected = batch.state === "ambiguous" || batch.state === "failed";
  if (errorExpected !== (batch.errorCode !== null)) {
    throw new TypeError("Scene batch failure states and error codes are inconsistent.");
  }
  if (batch.errorCode !== null && !ERROR_CODE_PATTERN.test(batch.errorCode)) {
    throw new TypeError("Scene batch errorCode must be a bounded machine-readable code.");
  }
}

function illegalTransition(batch: SceneBatchStateRecord, event: SceneBatchEvent): never {
  throw new TypeError(`Scene batch cannot transition from ${batch.state} with ${event.kind}.`);
}

export function transitionSceneBatch(
  batch: SceneBatchStateRecord,
  event: SceneBatchEvent,
): SceneBatchStateRecord {
  requireStateRecord(batch);
  if (event.kind === "dispatch") {
    if (batch.state !== "planned") return illegalTransition(batch, event);
    return { ...batch, errorCode: null, state: "dispatching" };
  }
  if (event.kind === "complete") {
    if (batch.state !== "dispatching") return illegalTransition(batch, event);
    return { ...batch, errorCode: null, state: "complete" };
  }
  if (event.kind === "fail") {
    if (batch.state !== "dispatching") return illegalTransition(batch, event);
    if (!ERROR_CODE_PATTERN.test(event.errorCode)) {
      throw new TypeError("Scene batch errorCode must be a bounded machine-readable code.");
    }
    return {
      ...batch,
      errorCode: event.errorCode,
      state: event.outcome === "ambiguous" ? "ambiguous" : "failed",
    };
  }
  if (event.acknowledgement !== "explicit-user-retry") {
    throw new TypeError("Retrying a scene batch requires explicit acknowledgement.");
  }
  if (batch.state !== "failed" && batch.state !== "ambiguous") return illegalTransition(batch, event);
  return { ...batch, errorCode: null, state: "planned" };
}

export interface CompletedSceneBatchCacheEntry {
  readonly batchKey: string;
  readonly payloadSha256: string;
  readonly schemaVersion: 1;
  readonly state: "complete";
}

export function reusableSceneBatchCacheEntry(
  expectedBatchKey: string,
  candidate: CompletedSceneBatchCacheEntry | null,
): CompletedSceneBatchCacheEntry | null {
  requireSha256(expectedBatchKey, "Expected scene batch key");
  if (candidate === null || candidate.schemaVersion !== 1 || candidate.state !== "complete") return null;
  requireSha256(candidate.batchKey, "Cached scene batch key");
  requireSha256(candidate.payloadSha256, "Cached scene batch payloadSha256");
  return candidate.batchKey === expectedBatchKey ? candidate : null;
}
