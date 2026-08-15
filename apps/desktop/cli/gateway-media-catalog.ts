import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

import { canonicalJson, canonicalJsonSha256 } from "../core/canonical-json";

export const GATEWAY_MEDIA_CATALOG_URL = "https://ai-gateway.vercel.sh/v1/models";
export const GATEWAY_MEDIA_KINDS = [
  "image",
  "speech",
  "transcription",
  "video",
] as const;

export type GatewayMediaKind = (typeof GATEWAY_MEDIA_KINDS)[number];
export type GatewayMediaExecutionMode =
  | "image-model"
  | "language-image"
  | "speech-model"
  | "transcription-model"
  | "video-model";
export type GatewayCatalogModelType = GatewayMediaKind | "language";
export type GatewayJsonValue =
  | boolean
  | null
  | number
  | string
  | readonly GatewayJsonValue[]
  | { readonly [key: string]: GatewayJsonValue };

export interface GatewayMediaModel {
  readonly capabilities: Readonly<Record<string, GatewayJsonValue>> | null;
  readonly created: number | null;
  readonly description: string;
  readonly executionMode: GatewayMediaExecutionMode;
  readonly gatewayType: GatewayCatalogModelType;
  readonly id: string;
  readonly kind: GatewayMediaKind;
  readonly modalities: Readonly<{
    input: readonly string[];
    output: readonly string[];
  }>;
  readonly name: string;
  readonly ownedBy: string;
  readonly pricing: Readonly<Record<string, GatewayJsonValue>>;
  readonly released: number | null;
  readonly supportedParameters: readonly string[];
  readonly tags: readonly string[];
}

export interface GatewayCatalogValidators {
  readonly etag?: string;
  readonly lastModified?: string;
}

export interface GatewayMediaCatalogSnapshot {
  readonly fetchedAt: string;
  readonly kind:
    | "atet.gateway-media-catalog"
    | "transmute.gateway-media-catalog"
    | "studio.gateway-media-catalog";
  readonly models: readonly GatewayMediaModel[];
  readonly schemaVersion: 1;
  readonly snapshotId: `sha256:${string}`;
  readonly validatedAt: string;
  readonly validators?: GatewayCatalogValidators;
}

export interface GatewayMediaCatalogView {
  readonly snapshot: GatewayMediaCatalogSnapshot;
  readonly source: "disk" | "memory" | "network";
  readonly status: "fresh" | "stale";
}

export interface GatewayMediaModelSummary {
  readonly executionMode: GatewayMediaExecutionMode;
  readonly id: string;
  readonly kind: GatewayMediaKind;
  readonly name: string;
  readonly operations: readonly string[];
}

export type GatewayCatalogRefresh =
  | Readonly<{
    fetchedAt?: string;
    payload: unknown;
    status: "modified";
    validators?: GatewayCatalogValidators;
  }>
  | Readonly<{
    validatedAt?: string;
    status: "not-modified";
    validators?: GatewayCatalogValidators;
  }>;

export interface GatewayMediaCatalogTransport {
  refresh(
    validators: GatewayCatalogValidators | undefined,
    signal: AbortSignal | undefined,
  ): Promise<GatewayCatalogRefresh>;
}

export interface GatewayMediaCatalogSnapshotStore {
  read(): Promise<unknown>;
  write(snapshot: GatewayMediaCatalogSnapshot): Promise<void>;
}

export type GatewayCatalogFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type GatewayMediaCatalogErrorCode =
  | "catalog-invalid"
  | "catalog-unavailable"
  | "invalid-request";

const CATALOG_RESPONSE_MAX_BYTES = 6 * 1024 * 1024;
const CATALOG_STORE_MAX_BYTES = 6 * 1024 * 1024;
const CATALOG_MODEL_LIMIT = 1_000;
const CATALOG_JSON_MAX_DEPTH = 16;
const CATALOG_JSON_MAX_NODES = 50_000;
const DEFAULT_CATALOG_TIMEOUT_MS = 20_000;
const DEFAULT_FRESH_MS = 5 * 60_000;
const DEFAULT_STALE_MS = 24 * 60 * 60_000;

const ERROR_MESSAGES: Readonly<Record<GatewayMediaCatalogErrorCode, string>> = {
  "catalog-invalid": "The Vercel AI Gateway media catalog is invalid.",
  "catalog-unavailable": "The Vercel AI Gateway media catalog is unavailable.",
  "invalid-request": "The media catalog request is invalid.",
};

export class GatewayMediaCatalogError extends Error {
  readonly code: GatewayMediaCatalogErrorCode;

  constructor(code: GatewayMediaCatalogErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
    this.name = "GatewayMediaCatalogError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMediaKind(value: unknown): value is GatewayMediaKind {
  return GATEWAY_MEDIA_KINDS.some(kind => kind === value);
}

function isCatalogModelType(value: unknown): value is GatewayCatalogModelType {
  return isMediaKind(value) || value === "language";
}

function parseCanonicalTimestamp(value: unknown): string {
  if (typeof value !== "string") throw new GatewayMediaCatalogError("catalog-invalid");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new GatewayMediaCatalogError("catalog-invalid");
  }
  return value;
}

function parseBoundedString(
  value: unknown,
  maximumLength: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string"
    || value.length > maximumLength
    || (!allowEmpty && value.length === 0)
    || [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (
        codePoint <= 8
        || codePoint === 11
        || codePoint === 12
        || (codePoint >= 14 && codePoint <= 31)
        || codePoint === 127
      );
    })
  ) {
    throw new GatewayMediaCatalogError("catalog-invalid");
  }
  return value;
}

function parseStringArray(
  value: unknown,
  maximumItems: number,
  maximumItemLength: number,
): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new GatewayMediaCatalogError("catalog-invalid");
  }
  const parsed = value.map(item => parseBoundedString(item, maximumItemLength));
  if (new Set(parsed).size !== parsed.length) {
    throw new GatewayMediaCatalogError("catalog-invalid");
  }
  return parsed;
}

interface JsonParseBudget {
  nodes: number;
}

function parseGatewayJson(
  value: unknown,
  budget: JsonParseBudget,
  depth = 0,
): GatewayJsonValue {
  budget.nodes += 1;
  if (budget.nodes > CATALOG_JSON_MAX_NODES || depth > CATALOG_JSON_MAX_DEPTH) {
    throw new GatewayMediaCatalogError("catalog-invalid");
  }
  if (
    value === null
    || typeof value === "boolean"
    || typeof value === "string"
  ) {
    return typeof value === "string"
      ? parseBoundedString(value, 32_768, true)
      : value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new GatewayMediaCatalogError("catalog-invalid");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (value.length > 4_096) throw new GatewayMediaCatalogError("catalog-invalid");
    return value.map(item => parseGatewayJson(item, budget, depth + 1));
  }
  if (!isRecord(value) || Object.keys(value).length > 2_048) {
    throw new GatewayMediaCatalogError("catalog-invalid");
  }
  const parsed: Record<string, GatewayJsonValue> = Object.create(null) as Record<
    string,
    GatewayJsonValue
  >;
  for (const [key, item] of Object.entries(value)) {
    const parsedKey = parseBoundedString(key, 256);
    parsed[parsedKey] = parseGatewayJson(item, budget, depth + 1);
  }
  return parsed;
}

function parseJsonRecord(
  value: unknown,
  optional = false,
): Readonly<Record<string, GatewayJsonValue>> | null {
  if (optional && (value === undefined || value === null)) return null;
  if (!isRecord(value)) throw new GatewayMediaCatalogError("catalog-invalid");
  return parseGatewayJson(value, { nodes: 0 }) as Readonly<
    Record<string, GatewayJsonValue>
  >;
}

function parseEpochSeconds(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new GatewayMediaCatalogError("catalog-invalid");
  }
  return value as number;
}

function parseModalities(value: unknown): GatewayMediaModel["modalities"] {
  if (!isRecord(value)) throw new GatewayMediaCatalogError("catalog-invalid");
  return {
    input: parseStringArray(value.input, 16, 64),
    output: parseStringArray(value.output, 16, 64),
  };
}

function parseCatalogModel(value: unknown): GatewayMediaModel | null {
  if (!isRecord(value) || !isCatalogModelType(value.type)) return null;
  const gatewayType = value.type;
  const tags = parseStringArray(value.tags, 256, 128);
  const modalities = parseModalities(value.modalities);
  const isLanguageImage = gatewayType === "language"
    && tags.includes("image-generation")
    && modalities.output.includes("image");
  if (gatewayType === "language" && !isLanguageImage) return null;
  const kind: GatewayMediaKind = gatewayType === "language"
    ? "image"
    : gatewayType;
  const id = parseBoundedString(value.id, 256);
  if (
    !id.includes("/")
    || /\s/u.test(id)
    || id.startsWith("/")
    || id.endsWith("/")
  ) {
    throw new GatewayMediaCatalogError("catalog-invalid");
  }
  const capabilities = parseJsonRecord(value[`${gatewayType}_capabilities`], true);
  const executionMode: GatewayMediaExecutionMode = isLanguageImage
    ? "language-image"
    : kind === "image"
      ? "image-model"
      : kind === "speech"
        ? "speech-model"
        : kind === "transcription"
          ? "transcription-model"
          : "video-model";
  return {
    capabilities,
    created: parseEpochSeconds(value.created),
    description: parseBoundedString(value.description, 32_768, true),
    executionMode,
    gatewayType,
    id,
    kind,
    modalities,
    name: parseBoundedString(value.name, 512),
    ownedBy: parseBoundedString(value.owned_by, 256),
    pricing: parseJsonRecord(value.pricing) ?? {},
    released: parseEpochSeconds(value.released),
    supportedParameters: parseStringArray(value.supported_parameters, 256, 128),
    tags,
  };
}

function modelSort(
  left: GatewayMediaModel,
  right: GatewayMediaModel,
): number {
  return left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id);
}

function snapshotDigest(models: readonly GatewayMediaModel[]): `sha256:${string}` {
  return `sha256:${canonicalJsonSha256([...models].sort(modelSort))}`;
}

export function parseGatewayMediaCatalog(
  value: unknown,
  timestamps: Readonly<{
    fetchedAt: string;
    validatedAt?: string;
    validators?: GatewayCatalogValidators;
  }>,
): GatewayMediaCatalogSnapshot {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length > CATALOG_MODEL_LIMIT) {
    throw new GatewayMediaCatalogError("catalog-invalid");
  }
  const models: GatewayMediaModel[] = [];
  const ids = new Set<string>();
  for (const row of value.data) {
    const model = parseCatalogModel(row);
    if (model === null) continue;
    if (ids.has(model.id)) throw new GatewayMediaCatalogError("catalog-invalid");
    ids.add(model.id);
    models.push(model);
  }
  if (models.length === 0) throw new GatewayMediaCatalogError("catalog-invalid");
  models.sort(modelSort);
  const fetchedAt = parseCanonicalTimestamp(timestamps.fetchedAt);
  const validatedAt = parseCanonicalTimestamp(timestamps.validatedAt ?? fetchedAt);
  if (Date.parse(validatedAt) < Date.parse(fetchedAt)) {
    throw new GatewayMediaCatalogError("catalog-invalid");
  }
  const validators = parseValidators(timestamps.validators);
  return {
    fetchedAt,
    kind: "atet.gateway-media-catalog",
    models,
    schemaVersion: 1,
    snapshotId: snapshotDigest(models),
    validatedAt,
    ...(validators === undefined ? {} : { validators }),
  };
}

function parseValidators(
  validators: GatewayCatalogValidators | undefined,
): GatewayCatalogValidators | undefined {
  if (validators === undefined) return undefined;
  const etag = validators.etag === undefined
    ? undefined
    : parseBoundedString(validators.etag, 1_024);
  const lastModified = validators.lastModified === undefined
    ? undefined
    : parseBoundedString(validators.lastModified, 1_024);
  if (etag === undefined && lastModified === undefined) return undefined;
  return {
    ...(etag === undefined ? {} : { etag }),
    ...(lastModified === undefined ? {} : { lastModified }),
  };
}

export function parseGatewayMediaCatalogSnapshot(
  value: unknown,
): GatewayMediaCatalogSnapshot {
  if (
    !isRecord(value)
    || (
      value.kind !== "atet.gateway-media-catalog"
      && value.kind !== "transmute.gateway-media-catalog"
      && value.kind !== "studio.gateway-media-catalog"
    )
    || value.schemaVersion !== 1
    || !Array.isArray(value.models)
    || typeof value.snapshotId !== "string"
  ) {
    throw new GatewayMediaCatalogError("catalog-invalid");
  }
  const envelope = {
    data: value.models.map(model => {
      if (
        !isRecord(model)
        || !isMediaKind(model.kind)
        || !isCatalogModelType(model.gatewayType)
      ) {
        throw new GatewayMediaCatalogError("catalog-invalid");
      }
      return {
        created: model.created,
        description: model.description,
        id: model.id,
        modalities: model.modalities,
        name: model.name,
        object: "model",
        owned_by: model.ownedBy,
        pricing: model.pricing,
        released: model.released,
        supported_parameters: model.supportedParameters,
        tags: model.tags,
        type: model.gatewayType,
        [`${model.gatewayType}_capabilities`]: model.capabilities,
      };
    }),
  };
  const snapshotValidators = isRecord(value.validators)
    ? {
        ...(typeof value.validators.etag === "string"
          ? { etag: value.validators.etag }
          : {}),
        ...(typeof value.validators.lastModified === "string"
          ? { lastModified: value.validators.lastModified }
          : {}),
      }
    : undefined;
  const snapshot = parseGatewayMediaCatalog(envelope, {
    fetchedAt: value.fetchedAt as string,
    validatedAt: value.validatedAt as string,
    ...(snapshotValidators === undefined
      ? {}
      : { validators: snapshotValidators }),
  });
  if (snapshot.snapshotId !== value.snapshotId) {
    throw new GatewayMediaCatalogError("catalog-invalid");
  }
  return { ...snapshot, kind: value.kind };
}

function supportedOperations(model: GatewayMediaModel): readonly string[] {
  if (model.kind === "transcription") {
    if (model.tags.includes("websocket-realtime")) {
      return ["streaming-transcription"];
    }
    if (model.tags.includes("websocket-transcription")) {
      return ["batch-transcription", "streaming-transcription"];
    }
    return ["batch-transcription"];
  }
  const operations = model.capabilities?.supported_operations;
  return Array.isArray(operations)
    ? operations.filter((item): item is string => typeof item === "string")
    : [];
}

export function listGatewayMediaModels(
  snapshot: GatewayMediaCatalogSnapshot,
  options: Readonly<{
    kind?: GatewayMediaKind;
    limit?: number;
    query?: string;
  }> = {},
): readonly GatewayMediaModelSummary[] {
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new GatewayMediaCatalogError("invalid-request");
  }
  const query = options.query?.trim().toLocaleLowerCase("en-US");
  if (query !== undefined && query.length > 256) {
    throw new GatewayMediaCatalogError("invalid-request");
  }
  return snapshot.models
    .filter(model => options.kind === undefined || model.kind === options.kind)
    .filter(model => query === undefined || query.length === 0 || (
      model.id.toLocaleLowerCase("en-US").includes(query)
      || model.name.toLocaleLowerCase("en-US").includes(query)
      || model.description.toLocaleLowerCase("en-US").includes(query)
    ))
    .slice(0, limit)
    .map(model => ({
      executionMode: model.executionMode,
      id: model.id,
      kind: model.kind,
      name: model.name,
      operations: supportedOperations(model),
    }));
}

export function inspectGatewayMediaModel(
  snapshot: GatewayMediaCatalogSnapshot,
  id: string,
): GatewayMediaModel | null {
  return snapshot.models.find(model => model.id === id) ?? null;
}

function mergeValidators(
  current: GatewayCatalogValidators | undefined,
  next: GatewayCatalogValidators | undefined,
): GatewayCatalogValidators | undefined {
  return parseValidators({
    ...(current ?? {}),
    ...(next ?? {}),
  });
}

function parseCacheOptions(options: Readonly<{
  freshMs?: number;
  staleMs?: number;
}>): Readonly<{ freshMs: number; staleMs: number }> {
  const freshMs = options.freshMs ?? DEFAULT_FRESH_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  if (
    !Number.isSafeInteger(freshMs)
    || !Number.isSafeInteger(staleMs)
    || freshMs < 0
    || staleMs < freshMs
  ) {
    throw new GatewayMediaCatalogError("invalid-request");
  }
  return { freshMs, staleMs };
}

export function createGatewayMediaCatalogCache(options: Readonly<{
  freshMs?: number;
  now?: () => number;
  snapshotStore?: GatewayMediaCatalogSnapshotStore;
  staleMs?: number;
  transport: GatewayMediaCatalogTransport;
}>): Readonly<{
  get(input?: Readonly<{
    forceRefresh?: boolean;
    freshness?: "allow-stale" | "require-fresh";
    signal?: AbortSignal;
  }>): Promise<GatewayMediaCatalogView>;
}> {
  const { freshMs, staleMs } = parseCacheOptions(options);
  const now = options.now ?? Date.now;
  let cached:
    | Readonly<{ snapshot: GatewayMediaCatalogSnapshot; source: "disk" | "memory" | "network" }>
    | undefined;
  let storeLoad: Promise<void> | undefined;
  let refreshFlight: Promise<GatewayMediaCatalogView> | undefined;

  const loadStoredSnapshot = (): Promise<void> => {
    storeLoad ??= (async () => {
      if (options.snapshotStore === undefined) return;
      try {
        const value = await options.snapshotStore.read();
        if (value !== null) {
          cached = {
            snapshot: parseGatewayMediaCatalogSnapshot(value),
            source: "disk",
          };
        }
      } catch {
        // A corrupt or inaccessible cache is never authority. Refresh below.
      }
    })();
    return storeLoad;
  };

  const cachedView = (
    freshness: "allow-stale" | "require-fresh",
  ): GatewayMediaCatalogView | null => {
    if (cached === undefined) return null;
    const age = now() - Date.parse(cached.snapshot.validatedAt);
    if (age >= 0 && age <= freshMs) {
      return { snapshot: cached.snapshot, source: cached.source, status: "fresh" };
    }
    if (freshness === "allow-stale" && age >= 0 && age <= staleMs) {
      return { snapshot: cached.snapshot, source: cached.source, status: "stale" };
    }
    return null;
  };

  const callerAbortError = (signal: AbortSignal): Error => (
    signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The catalog request was aborted.", "AbortError")
  );
  const throwIfCallerAborted = (signal: AbortSignal | undefined): void => {
    if (signal?.aborted === true) throw callerAbortError(signal);
  };

  const awaitWithCallerSignal = async <Value>(
    promise: Promise<Value>,
    signal: AbortSignal | undefined,
  ): Promise<Value> => {
    if (signal === undefined) return await promise;
    if (signal.aborted) throw callerAbortError(signal);
    return await new Promise<Value>((resolve, reject) => {
      const abort = (): void => reject(callerAbortError(signal));
      signal.addEventListener("abort", abort, { once: true });
      void promise.then(
        value => {
          signal.removeEventListener("abort", abort);
          resolve(value);
        },
        error => {
          signal.removeEventListener("abort", abort);
          reject(
            error instanceof Error
              ? error
              : new GatewayMediaCatalogError("catalog-unavailable"),
          );
        },
      );
    });
  };

  const refresh = (): Promise<GatewayMediaCatalogView> => {
    if (refreshFlight !== undefined) return refreshFlight;
    const current = (async (): Promise<GatewayMediaCatalogView> => {
      const refreshed = await options.transport.refresh(
        cached?.snapshot.validators,
        undefined,
      );
      if (refreshed.status === "not-modified") {
        if (cached === undefined) {
          throw new GatewayMediaCatalogError("catalog-invalid");
        }
        const validatedAt = parseCanonicalTimestamp(
          refreshed.validatedAt ?? new Date(now()).toISOString(),
        );
        const validators = mergeValidators(
          cached.snapshot.validators,
          refreshed.validators,
        );
        const snapshot: GatewayMediaCatalogSnapshot = {
          ...cached.snapshot,
          kind: "atet.gateway-media-catalog",
          validatedAt,
          ...(validators === undefined ? {} : { validators }),
        };
        cached = { snapshot, source: "network" };
        await options.snapshotStore?.write(snapshot).catch(() => undefined);
        return { snapshot, source: "network", status: "fresh" };
      }
      const fetchedAt = refreshed.fetchedAt ?? new Date(now()).toISOString();
      const snapshot = parseGatewayMediaCatalog(refreshed.payload, {
        fetchedAt,
        ...(refreshed.validators === undefined
          ? {}
          : { validators: refreshed.validators }),
      });
      cached = { snapshot, source: "network" };
      await options.snapshotStore?.write(snapshot).catch(() => undefined);
      return { snapshot, source: "network", status: "fresh" };
    })();
    refreshFlight = current;
    void current.finally(() => {
      if (refreshFlight === current) refreshFlight = undefined;
    }).catch(() => undefined);
    return current;
  };

  return {
    get: async (input = {}) => {
      throwIfCallerAborted(input.signal);
      await awaitWithCallerSignal(loadStoredSnapshot(), input.signal);
      const freshness = input.freshness ?? "allow-stale";
      if (!input.forceRefresh) {
        const available = cachedView("require-fresh");
        if (available !== null) return available;
      }
      try {
        return await awaitWithCallerSignal(refresh(), input.signal);
      } catch (error) {
        throwIfCallerAborted(input.signal);
        const available = cachedView(freshness);
        if (available !== null) return available;
        if (error instanceof GatewayMediaCatalogError) throw error;
        throw new GatewayMediaCatalogError("catalog-unavailable");
      }
    },
  };
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (Number.isFinite(bytes) && bytes > maximumBytes) {
      throw new GatewayMediaCatalogError("catalog-invalid");
    }
  }
  if (response.body === null) throw new GatewayMediaCatalogError("catalog-invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new GatewayMediaCatalogError("catalog-invalid");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function combinedAbortSignal(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): Readonly<{ dispose(): void; signal: AbortSignal }> {
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted === true) abortFromCaller();
  callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    },
    signal: controller.signal,
  };
}

export function createHttpGatewayMediaCatalogTransport(options: Readonly<{
  fetch?: GatewayCatalogFetch;
  timeoutMs?: number;
}> = {}): GatewayMediaCatalogTransport {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new GatewayMediaCatalogError("invalid-request");
  }
  return {
    refresh: async (validators, signal) => {
      const combined = combinedAbortSignal(signal, timeoutMs);
      try {
        const response = await fetchImplementation(GATEWAY_MEDIA_CATALOG_URL, {
          headers: {
            accept: "application/json",
            ...(validators?.etag === undefined
              ? {}
              : { "if-none-match": validators.etag }),
            ...(validators?.lastModified === undefined
              ? {}
              : { "if-modified-since": validators.lastModified }),
          },
          method: "GET",
          redirect: "error",
          signal: combined.signal,
        });
        if (
          response.redirected
          || (
            response.status >= 300
            && response.status < 400
            && response.status !== 304
          )
        ) {
          throw new GatewayMediaCatalogError("catalog-unavailable");
        }
        const responseValidators = parseValidators({
          ...(response.headers.get("etag") === null
            ? {}
            : { etag: response.headers.get("etag")! }),
          ...(response.headers.get("last-modified") === null
            ? {}
            : { lastModified: response.headers.get("last-modified")! }),
        });
        if (response.status === 304) {
          return {
            status: "not-modified",
            ...(responseValidators === undefined
              ? {}
              : { validators: responseValidators }),
          };
        }
        if (response.status !== 200) {
          throw new GatewayMediaCatalogError("catalog-unavailable");
        }
        const bytes = await readBoundedResponse(response, CATALOG_RESPONSE_MAX_BYTES);
        let payload: unknown;
        try {
          payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
        } catch {
          throw new GatewayMediaCatalogError("catalog-invalid");
        }
        return {
          payload,
          status: "modified",
          ...(responseValidators === undefined
            ? {}
            : { validators: responseValidators }),
        };
      } catch (error) {
        if (error instanceof GatewayMediaCatalogError) throw error;
        throw new GatewayMediaCatalogError("catalog-unavailable");
      } finally {
        combined.dispose();
      }
    },
  };
}

function errno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function createFileGatewayMediaCatalogSnapshotStore(
  path: string,
): GatewayMediaCatalogSnapshotStore {
  if (!isAbsolute(path)) throw new GatewayMediaCatalogError("invalid-request");
  return {
    read: async () => {
      let handle: Awaited<ReturnType<typeof open>> | null = null;
      try {
        handle = await open(
          path,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
        );
        const details = await handle.stat();
        if (!details.isFile() || details.size > CATALOG_STORE_MAX_BYTES) {
          throw new GatewayMediaCatalogError("catalog-invalid");
        }
        const source = await handle.readFile({ encoding: "utf8" });
        try {
          return JSON.parse(source) as unknown;
        } catch {
          throw new GatewayMediaCatalogError("catalog-invalid");
        }
      } catch (error) {
        if (errno(error, "ENOENT")) return null;
        if (error instanceof GatewayMediaCatalogError) throw error;
        throw new GatewayMediaCatalogError("catalog-unavailable");
      } finally {
        await handle?.close().catch(() => undefined);
      }
    },
    write: async (snapshot) => {
      const parent = dirname(path);
      const temporaryPath = `${path}.${randomUUID()}.tmp`;
      let handle: Awaited<ReturnType<typeof open>> | null = null;
      try {
        await mkdir(parent, { mode: 0o700, recursive: true });
        const parentDetails = await lstat(parent);
        if (parentDetails.isSymbolicLink() || !parentDetails.isDirectory()) {
          throw new GatewayMediaCatalogError("catalog-unavailable");
        }
        await chmod(parent, 0o700);
        const source = `${canonicalJson(snapshot)}\n`;
        if (new TextEncoder().encode(source).byteLength > CATALOG_STORE_MAX_BYTES) {
          throw new GatewayMediaCatalogError("catalog-invalid");
        }
        handle = await open(
          temporaryPath,
          constants.O_CREAT
            | constants.O_EXCL
            | constants.O_WRONLY
            | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        await handle.writeFile(source, { encoding: "utf8" });
        await handle.sync();
        await handle.close();
        handle = null;
        await rename(temporaryPath, path);
        await syncDirectory(parent);
      } catch (error) {
        if (error instanceof GatewayMediaCatalogError) throw error;
        throw new GatewayMediaCatalogError("catalog-unavailable");
      } finally {
        await handle?.close().catch(() => undefined);
        await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    },
  };
}
