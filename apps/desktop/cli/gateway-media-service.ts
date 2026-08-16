import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

import { canonicalJsonSha256 } from "../core/canonical-json";
import type { ActiveGatewayCredential } from "./gateway-credential";
import {
  type GatewayGeneratedFile,
  type GatewayMediaArtifactBundle,
  type GatewayMediaArtifactStore,
  type GatewayMediaInputDigest,
  type GatewayMediaRoutingReceipt,
} from "./gateway-media-artifacts";
import {
  GATEWAY_MEDIA_CATALOG_URL,
  type GatewayJsonValue,
  type GatewayMediaCatalogView,
  type GatewayMediaKind,
  type GatewayMediaModel,
} from "./gateway-media-catalog";
import {
  gatewayProviderOptionsSummary,
  parseGatewayProviderOptions,
  type GatewayProviderOptions,
} from "./gateway-provider-options";
import { gatewayMediaBytesMatchType } from "./gateway-media-signature";

export const GATEWAY_MEDIA_API_BASE_URL = "https://ai-gateway.vercel.sh/v4/ai";
export const GATEWAY_MEDIA_UPLOAD_POLICY = "atet.gateway-media-cloud-upload.v1";
export const LEGACY_GATEWAY_MEDIA_UPLOAD_POLICY = "studio.gateway-media-cloud-upload.v1";

const MAXIMUM_IMAGE_INPUT_BYTES = 50 * 1024 * 1024;
const MAXIMUM_IMAGE_INPUT_TOTAL_BYTES = 200 * 1024 * 1024;
const MAXIMUM_REFERENCE_INPUT_BYTES = 256 * 1024 * 1024;
const MAXIMUM_REFERENCE_INPUT_TOTAL_BYTES = 512 * 1024 * 1024;
const MAXIMUM_TRANSCRIPTION_INPUT_BYTES = 256 * 1024 * 1024;
const MAXIMUM_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const MAXIMUM_VIDEO_OUTPUT_TOTAL_BYTES = 1024 * 1024 * 1024;
const DEFAULT_GATEWAY_RESPONSE_MAX_BYTES = 512 * 1024 * 1024;
const MAXIMUM_PROMPT_CHARACTERS = 100_000;
const MAXIMUM_TRANSCRIPT_CHARACTERS = 10_000_000;
const MAXIMUM_TRANSCRIPT_SEGMENTS = 100_000;
const MAXIMUM_TRANSCRIPT_TEXT_BYTES = 32 * 1024 * 1024;
const MAXIMUM_TRANSCRIPT_SEGMENT_TEXT_BYTES = 32 * 1024 * 1024;
const MAXIMUM_TRANSCRIPT_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAXIMUM_INPUTS = 32;
const DEFAULT_IMAGE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_SPEECH_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_VIDEO_TIMEOUT_MS = 20 * 60_000;
const MAXIMUM_DOWNLOAD_REDIRECTS = 5;

export type GatewayMediaExecutionErrorCode =
  | "cloud-consent-required"
  | "download-failed"
  | "input-too-large"
  | "invalid-request"
  | "invalid-response"
  | "model-kind-mismatch"
  | "model-not-found"
  | "model-operation-unsupported"
  | "provider-failed";

const ERROR_MESSAGES: Readonly<Record<GatewayMediaExecutionErrorCode, string>> = {
  "cloud-consent-required": "This Gateway media request requires explicit cloud-upload consent.",
  "download-failed": "The generated Gateway media output could not be downloaded safely.",
  "input-too-large": "The Gateway media input exceeds its upload limit.",
  "invalid-request": "The Gateway media request is invalid.",
  "invalid-response": "The Gateway media provider returned an invalid response.",
  "model-kind-mismatch": "The selected Gateway model has the wrong media kind.",
  "model-not-found": "The selected Gateway media model is not in the current catalog.",
  "model-operation-unsupported": "The selected Gateway model does not support this request shape or setting.",
  "provider-failed": "The Gateway media provider request failed.",
};

export class GatewayMediaExecutionError extends Error {
  readonly code: GatewayMediaExecutionErrorCode;
  readonly reconciliation: Readonly<{
    readonly failureSha256: string;
    readonly routing: GatewayMediaRoutingReceipt;
    readonly statusCode?: number;
  }> | undefined;

  constructor(
    code: GatewayMediaExecutionErrorCode,
    reconciliation?: Readonly<{
      readonly failureSha256: string;
      readonly routing: GatewayMediaRoutingReceipt;
      readonly statusCode?: number;
    }>,
  ) {
    super(ERROR_MESSAGES[code]);
    this.code = code;
    this.name = "GatewayMediaExecutionError";
    this.reconciliation = reconciliation;
  }
}

export interface GatewayUploadConsent {
  readonly acknowledgedAt: string;
  readonly allowCloudUpload: true;
  readonly policy:
    | typeof GATEWAY_MEDIA_UPLOAD_POLICY
    | typeof LEGACY_GATEWAY_MEDIA_UPLOAD_POLICY;
}

interface GatewayMediaInputFacts {
  readonly durationSeconds?: number;
  readonly height?: number;
  readonly width?: number;
}

export type GatewayMediaInput =
  | Readonly<{
    readonly data: Uint8Array;
    readonly facts?: GatewayMediaInputFacts;
    readonly mediaType: string;
    readonly url?: never;
  }>
  | Readonly<{
    readonly data?: never;
    readonly facts?: GatewayMediaInputFacts;
    readonly mediaType: string;
    readonly url: string;
  }>;

type GatewayInlineMediaInput = Extract<
  GatewayMediaInput,
  Readonly<{ readonly data: Uint8Array }>
>;

type GatewaySdkMediaInput = Uint8Array | string;

export interface GatewaySdkImageRequest {
  readonly abortSignal: AbortSignal;
  readonly aspectRatio?: string;
  readonly maxImagesPerCall?: number;
  readonly maxRetries: 0;
  readonly modelId: string;
  readonly n?: number;
  readonly prompt:
    | string
    | Readonly<{
      images: readonly GatewaySdkMediaInput[];
      mask?: GatewaySdkMediaInput;
      text?: string;
    }>;
  readonly providerOptions?: GatewayProviderOptions;
  readonly seed?: number;
  readonly size?: string;
}

export interface GatewaySdkLanguageImageRequest {
  readonly abortSignal: AbortSignal;
  readonly maxOutputTokens?: number;
  readonly maxRetries: 0;
  readonly messages?: readonly Readonly<{
    content: readonly (
      | Readonly<{ text: string; type: "text" }>
      | Readonly<{
        image: GatewaySdkMediaInput;
        mediaType: string;
        type: "image";
      }>
    )[];
    role: "user";
  }>[];
  readonly modelId: string;
  readonly prompt?: string;
  readonly providerOptions?: GatewayProviderOptions;
  readonly stopSequences?: readonly string[];
  readonly temperature?: number;
}

export interface GatewaySdkVideoRequest {
  readonly abortSignal: AbortSignal;
  readonly aspectRatio?: string;
  readonly download: GatewayMediaDownload;
  readonly duration?: number;
  readonly fps?: number;
  readonly frameImages?: readonly Readonly<{
    frameType: string;
    image: GatewaySdkMediaInput;
  }>[];
  readonly generateAudio?: boolean;
  readonly inputReferences?: readonly Readonly<{
    data: GatewaySdkMediaInput;
    mediaType: string;
  }>[];
  readonly maxRetries: 0;
  readonly maxVideosPerCall?: number;
  readonly modelId: string;
  readonly n?: number;
  readonly prompt:
    | string
    | Readonly<{
      image: GatewaySdkMediaInput;
      text?: string;
    }>;
  readonly providerOptions?: GatewayProviderOptions;
  readonly resolution?: string;
  readonly seed?: number;
}

export interface GatewaySdkSpeechRequest {
  readonly abortSignal: AbortSignal;
  readonly instructions?: string;
  readonly language?: string;
  readonly maxRetries: 0;
  readonly modelId: string;
  readonly outputFormat?: string;
  readonly providerOptions?: GatewayProviderOptions;
  readonly speed?: number;
  readonly text: string;
  readonly voice?: string;
}

export interface GatewaySdkTranscriptionRequest {
  readonly abortSignal: AbortSignal;
  readonly audio: Uint8Array;
  readonly maxRetries: 0;
  readonly modelId: string;
  readonly providerOptions?: GatewayProviderOptions;
}

export interface GatewayMediaSdk {
  generateImage(apiKey: string, request: GatewaySdkImageRequest): Promise<unknown>;
  generateLanguageImage(
    apiKey: string,
    request: GatewaySdkLanguageImageRequest,
  ): Promise<unknown>;
  generateSpeech(apiKey: string, request: GatewaySdkSpeechRequest): Promise<unknown>;
  generateVideo(apiKey: string, request: GatewaySdkVideoRequest): Promise<unknown>;
  transcribe(apiKey: string, request: GatewaySdkTranscriptionRequest): Promise<unknown>;
}

export type GatewayMediaDownload = (input: Readonly<{
  abortSignal?: AbortSignal;
  maximumBytes?: number;
  url: URL;
}>) => Promise<Readonly<{
  data: Uint8Array;
  mediaType: string | undefined;
}>>;

export type GatewayMediaFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface GatewayAiProvider {
  imageModel(modelId: string): unknown;
  languageModel(modelId: string): unknown;
  speech(modelId: string): unknown;
  transcription(modelId: string): unknown;
  video(modelId: string): unknown;
}

export interface GatewayAiSdkRuntime {
  createGateway(settings: Readonly<{
    apiKey: string;
    baseURL: typeof GATEWAY_MEDIA_API_BASE_URL;
    fetch: GatewayMediaFetch;
  }>): GatewayAiProvider;
  generateImage(input: Readonly<Record<string, unknown>>): Promise<unknown>;
  generateSpeech(input: Readonly<Record<string, unknown>>): Promise<unknown>;
  generateText(input: Readonly<Record<string, unknown>>): Promise<unknown>;
  generateVideo(input: Readonly<Record<string, unknown>>): Promise<unknown>;
  transcribe(input: Readonly<Record<string, unknown>>): Promise<unknown>;
}

type DynamicImport = (specifier: string) => Promise<unknown>;
type AsyncRecordFunction = (
  input: Readonly<Record<string, unknown>>,
) => Promise<unknown>;
type CreateGatewayFunction = (
  settings: Readonly<Record<string, unknown>>,
) => unknown;
type ModelFactory = (modelId: string) => unknown;

function disableAiSdkWarningLogging(): void {
  (
    globalThis as typeof globalThis & {
      AI_SDK_LOG_WARNINGS?: false;
    }
  ).AI_SDK_LOG_WARNINGS = false;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!isObject(value) || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseFunction(
  value: unknown,
): AsyncRecordFunction {
  if (typeof value !== "function") {
    throw new GatewayMediaExecutionError("provider-failed");
  }
  return value as AsyncRecordFunction;
}

async function defaultGatewayAiSdkRuntime(
  importModule: DynamicImport | undefined,
): Promise<GatewayAiSdkRuntime> {
  let aiModule: unknown;
  let gatewayModule: unknown;
  try {
    [aiModule, gatewayModule] = await Promise.all([
      importModule === undefined ? import("ai-v7") : importModule("ai-v7"),
      importModule === undefined
        ? import("@ai-sdk/gateway-v4")
        : importModule("@ai-sdk/gateway-v4"),
    ]);
  } catch {
    throw new GatewayMediaExecutionError("provider-failed");
  }
  if (!isObject(aiModule) || !isObject(gatewayModule)) {
    throw new GatewayMediaExecutionError("provider-failed");
  }
  const generateImage = parseFunction(aiModule.generateImage);
  const generateSpeech = parseFunction(aiModule.generateSpeech);
  const generateText = parseFunction(aiModule.generateText);
  const generateVideo = parseFunction(aiModule.experimental_generateVideo);
  const transcribe = parseFunction(aiModule.transcribe);
  if (typeof gatewayModule.createGateway !== "function") {
    throw new GatewayMediaExecutionError("provider-failed");
  }
  const createGateway = gatewayModule.createGateway as CreateGatewayFunction;
  return {
    createGateway: (settings) => {
      const provider = createGateway(settings);
      if (
        !isObject(provider)
        || typeof provider.imageModel !== "function"
        || typeof provider.languageModel !== "function"
        || typeof provider.speech !== "function"
        || typeof provider.transcription !== "function"
        || typeof provider.video !== "function"
      ) {
        throw new GatewayMediaExecutionError("provider-failed");
      }
      const imageModel = provider.imageModel as ModelFactory;
      const languageModel = provider.languageModel as ModelFactory;
      const speech = provider.speech as ModelFactory;
      const transcription = provider.transcription as ModelFactory;
      const video = provider.video as ModelFactory;
      return {
        imageModel: modelId => imageModel.call(provider, modelId),
        languageModel: modelId => languageModel.call(provider, modelId),
        speech: modelId => speech.call(provider, modelId),
        transcription: modelId => transcription.call(provider, modelId),
        video: modelId => video.call(provider, modelId),
      };
    },
    generateImage,
    generateSpeech,
    generateText,
    generateVideo,
    transcribe,
  };
}

/**
 * Loads AI SDK 7 lazily so catalog and local-only commands do not initialize a
 * provider client. The string-valued import seam also keeps tests independent
 * of the installed SDK while the desktop package's dependency upgrade lands.
 */
export function createAiSdkGatewayMediaSdk(options: Readonly<{
  fetch?: GatewayMediaFetch;
  importModule?: DynamicImport;
  loadRuntime?: () => Promise<GatewayAiSdkRuntime>;
  maximumResponseBytes?: number;
}> = {}): GatewayMediaSdk {
  let runtimePromise: Promise<GatewayAiSdkRuntime> | undefined;
  const loadRuntime = async (): Promise<GatewayAiSdkRuntime> => {
    runtimePromise ??= options.loadRuntime === undefined
      ? defaultGatewayAiSdkRuntime(options.importModule)
      : options.loadRuntime();
    return await runtimePromise;
  };
  const gatewayFetch = createFixedGatewayMediaApiFetch({
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.maximumResponseBytes === undefined
      ? {}
      : { maximumResponseBytes: options.maximumResponseBytes }),
  });
  const provider = async (
    apiKey: string,
    signal: AbortSignal,
  ): Promise<Readonly<{ provider: GatewayAiProvider; runtime: GatewayAiSdkRuntime }>> => {
    // AI SDK logs raw provider warnings by default. Atet persists only
    // allowlisted warning types and message hashes, so disable the SDK logger
    // before loading or invoking its runtime.
    disableAiSdkWarningLogging();
    const runtime = await loadRuntime();
    assertProviderDispatchActive(signal);
    return {
      provider: runtime.createGateway({
        apiKey,
        baseURL: GATEWAY_MEDIA_API_BASE_URL,
        fetch: gatewayFetch,
      }),
      runtime,
    };
  };
  return {
    generateImage: async (apiKey, request) => {
      const loaded = await provider(apiKey, request.abortSignal);
      assertProviderDispatchActive(request.abortSignal);
      const { modelId, ...settings } = request;
      return await loaded.runtime.generateImage({
        ...settings,
        model: loaded.provider.imageModel(modelId),
      });
    },
    generateLanguageImage: async (apiKey, request) => {
      const loaded = await provider(apiKey, request.abortSignal);
      assertProviderDispatchActive(request.abortSignal);
      const { modelId, ...settings } = request;
      return await loaded.runtime.generateText({
        ...settings,
        model: loaded.provider.languageModel(modelId),
      });
    },
    generateSpeech: async (apiKey, request) => {
      const loaded = await provider(apiKey, request.abortSignal);
      assertProviderDispatchActive(request.abortSignal);
      const { modelId, ...settings } = request;
      return await loaded.runtime.generateSpeech({
        ...settings,
        model: loaded.provider.speech(modelId),
      });
    },
    generateVideo: async (apiKey, request) => {
      const loaded = await provider(apiKey, request.abortSignal);
      assertProviderDispatchActive(request.abortSignal);
      const { modelId, ...settings } = request;
      return await loaded.runtime.generateVideo({
        ...settings,
        model: loaded.provider.video(modelId),
      });
    },
    transcribe: async (apiKey, request) => {
      const loaded = await provider(apiKey, request.abortSignal);
      assertProviderDispatchActive(request.abortSignal);
      const { modelId, ...settings } = request;
      return await loaded.runtime.transcribe({
        ...settings,
        model: loaded.provider.transcription(modelId),
      });
    },
  };
}

function gatewayRequestUrl(input: RequestInfo | URL): URL {
  try {
    if (input instanceof Request) return new URL(input.url);
    if (input instanceof URL) return new URL(input.href);
    return new URL(input, GATEWAY_MEDIA_API_BASE_URL);
  } catch {
    throw new GatewayMediaExecutionError("provider-failed");
  }
}

async function boundedGatewayResponse(
  response: Response,
  maximumResponseBytes: number,
): Promise<Response> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (Number.isFinite(bytes) && bytes > maximumResponseBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new GatewayMediaExecutionError("invalid-response");
    }
  }
  if (response.body === null) return response;
  const reader = response.body.getReader();
  let bytesRead = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel: async reason => await reader.cancel(reason),
    pull: async (controller) => {
      try {
        const next = await reader.read();
        if (next.done) {
          controller.close();
          reader.releaseLock();
          return;
        }
        bytesRead += next.value.byteLength;
        if (bytesRead > maximumResponseBytes) {
          await reader.cancel().catch(() => undefined);
          controller.error(new GatewayMediaExecutionError("invalid-response"));
          return;
        }
        controller.enqueue(next.value);
      } catch {
        controller.error(new GatewayMediaExecutionError("invalid-response"));
      }
    },
  });
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/**
 * A credential-bearing SDK request may reach only the pinned Gateway v4 media
 * prefix. Redirects fail closed, and a counting stream bounds every response
 * without buffering long-running video SSE responses in memory.
 */
export function createFixedGatewayMediaApiFetch(options: Readonly<{
  fetch?: GatewayMediaFetch;
  maximumResponseBytes?: number;
}> = {}): GatewayMediaFetch {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const maximumResponseBytes = options.maximumResponseBytes
    ?? DEFAULT_GATEWAY_RESPONSE_MAX_BYTES;
  if (
    !Number.isSafeInteger(maximumResponseBytes)
    || maximumResponseBytes < 1
    || maximumResponseBytes > 1024 * 1024 * 1024
  ) {
    throw new GatewayMediaExecutionError("invalid-request");
  }
  const expected = new URL(GATEWAY_MEDIA_API_BASE_URL);
  return async (input, init) => {
    const url = gatewayRequestUrl(input);
    if (
      url.origin !== expected.origin
      || (
        url.pathname !== expected.pathname
        && !url.pathname.startsWith(`${expected.pathname}/`)
      )
      || url.username !== ""
      || url.password !== ""
    ) {
      throw new GatewayMediaExecutionError("provider-failed");
    }
    let response: Response;
    try {
      const base = input instanceof Request
        ? new Request(url.href, input)
        : new Request(url.href);
      const canonicalRequest = new Request(base, { ...init, redirect: "error" });
      response = await fetchImplementation(canonicalRequest);
    } catch (error) {
      if (error instanceof GatewayMediaExecutionError) throw error;
      throw new GatewayMediaExecutionError("provider-failed");
    }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      throw new GatewayMediaExecutionError("provider-failed");
    }
    return await boundedGatewayResponse(response, maximumResponseBytes);
  };
}

function combineAbortSignals(
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

function settleBeforeAbort<Result>(
  operation: Promise<Result>,
  signal: AbortSignal,
  errorCode: GatewayMediaExecutionErrorCode,
): Promise<Result> {
  if (signal.aborted) return Promise.reject(new GatewayMediaExecutionError(errorCode));
  return new Promise<Result>((resolveResult, rejectResult) => {
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      settle();
    };
    const abort = (): void => finish(() => rejectResult(new GatewayMediaExecutionError(errorCode)));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void operation.then(
      value => finish(() => resolveResult(value)),
      error => finish(() => rejectResult(error)),
    );
  });
}

function assertProviderDispatchActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new GatewayMediaExecutionError("provider-failed");
  }
}

async function readBoundedDownload(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (Number.isFinite(bytes) && bytes > maximumBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new GatewayMediaExecutionError("download-failed");
    }
  }
  if (response.body === null) {
    throw new GatewayMediaExecutionError("download-failed");
  }
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
        throw new GatewayMediaExecutionError("download-failed");
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

interface GatewayResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

type GatewayHostnameResolver = (
  hostname: string,
) => Promise<readonly GatewayResolvedAddress[]>;

type GatewayPinnedHttpsRequest = (
  url: URL,
  input: Readonly<{
    abortSignal: AbortSignal;
    addresses: readonly GatewayResolvedAddress[];
  }>,
) => Promise<Response>;

const BLOCKED_DOWNLOAD_ADDRESSES = (() => {
  const ipv4 = new BlockList();
  const ipv6 = new BlockList();
  for (const [address, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const) {
    ipv4.addSubnet(address, prefix, "ipv4");
  }
  for (const [address, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["::ffff:0:0", 96],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001:db8::", 32],
    ["2001::", 23],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8],
  ] as const) {
    ipv6.addSubnet(address, prefix, "ipv6");
  }
  return { ipv4, ipv6 };
})();

function normalizedDownloadHostname(url: URL): string {
  const raw = url.hostname.toLocaleLowerCase("en-US").replace(/\.+$/u, "");
  const hostname = raw.startsWith("[") && raw.endsWith("]")
    ? raw.slice(1, -1)
    : raw;
  if (
    hostname.length === 0
    || hostname.includes("%")
    || hostname === "localhost"
    || hostname === "localhost.localdomain"
    || [".localhost", ".local", ".internal", ".home", ".lan"]
      .some(suffix => hostname.endsWith(suffix))
  ) {
    throw new GatewayMediaExecutionError("download-failed");
  }
  return hostname;
}

function assertPublicDownloadAddress(address: GatewayResolvedAddress): void {
  const family = isIP(address.address);
  if (
    family !== address.family
    || (
      family === 4
        ? BLOCKED_DOWNLOAD_ADDRESSES.ipv4.check(address.address, "ipv4")
        : BLOCKED_DOWNLOAD_ADDRESSES.ipv6.check(address.address, "ipv6")
    )
  ) {
    throw new GatewayMediaExecutionError("download-failed");
  }
}

async function assertSafeDownloadTarget(
  url: URL,
  resolveHostname: GatewayHostnameResolver,
  signal: AbortSignal,
): Promise<readonly GatewayResolvedAddress[]> {
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
  ) {
    throw new GatewayMediaExecutionError("download-failed");
  }
  const hostname = normalizedDownloadHostname(url);
  const literalFamily = isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    const address = {
      address: hostname,
      family: literalFamily,
    } as const;
    assertPublicDownloadAddress(address);
    return [address];
  }
  let addresses: readonly GatewayResolvedAddress[];
  try {
    const resolution = resolveHostname(hostname);
    addresses = await new Promise<readonly GatewayResolvedAddress[]>(
      (resolvePromise, reject) => {
        const abort = (): void => reject(
          new GatewayMediaExecutionError("download-failed"),
        );
        if (signal.aborted) {
          abort();
          return;
        }
        signal.addEventListener("abort", abort, { once: true });
        void resolution.then(
          value => {
            signal.removeEventListener("abort", abort);
            resolvePromise(value);
          },
          error => {
            signal.removeEventListener("abort", abort);
            reject(
              error instanceof Error
                ? error
                : new Error("DNS lookup failed."),
            );
          },
        );
      },
    );
  } catch {
    throw new GatewayMediaExecutionError("download-failed");
  }
  if (addresses.length === 0 || addresses.length > 64) {
    throw new GatewayMediaExecutionError("download-failed");
  }
  for (const address of addresses) assertPublicDownloadAddress(address);
  return addresses;
}

function pinnedLookup(
  addresses: readonly GatewayResolvedAddress[],
): LookupFunction {
  return (_hostname, options, callback) => {
    const requestedFamily = options.family;
    const compatible = addresses.filter(address => (
      requestedFamily === undefined
      || requestedFamily === 0
      || requestedFamily === address.family
    ));
    if (compatible.length === 0) {
      const error: NodeJS.ErrnoException =
        new Error("No validated address matches the requested family.");
      error.code = "ENOTFOUND";
      callback(error, "", 0);
      return;
    }
    if (options.all) {
      callback(
        null,
        compatible.map(address => ({
          address: address.address,
          family: address.family,
        })),
      );
      return;
    }
    const selected = compatible[0]!;
    callback(null, selected.address, selected.family);
  };
}

function pinnedHttpsRequest(
  url: URL,
  input: Readonly<{
    abortSignal: AbortSignal;
    addresses: readonly GatewayResolvedAddress[];
  }>,
): Promise<Response> {
  return new Promise<Response>((resolvePromise, reject) => {
    const request = httpsRequest(url, {
      agent: false,
      headers: {
        accept: "video/*,audio/*,image/*,application/octet-stream",
      },
      lookup: pinnedLookup(input.addresses),
      method: "GET",
      signal: input.abortSignal,
    }, response => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status > 599) {
        response.destroy();
        reject(new GatewayMediaExecutionError("download-failed"));
        return;
      }
      try {
        const headers = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          const name = response.rawHeaders[index];
          const value = response.rawHeaders[index + 1];
          if (name !== undefined && value !== undefined) headers.append(name, value);
        }
        const forbidsBody = status === 204
          || status === 304
          || (status >= 100 && status < 200);
        if (forbidsBody) response.resume();
        resolvePromise(new Response(
          forbidsBody
            ? null
            : Readable.toWeb(response) as unknown as ReadableStream<Uint8Array>,
          {
            headers,
            status,
            ...(response.statusMessage === undefined
              ? {}
              : { statusText: response.statusMessage }),
          },
        ));
      } catch {
        response.destroy();
        reject(new GatewayMediaExecutionError("download-failed"));
      }
    });
    request.once("error", () => {
      reject(new GatewayMediaExecutionError("download-failed"));
    });
    request.end();
  });
}

async function fetchSafeDownload(
  initialUrl: URL,
  input: Readonly<{
    abortSignal: AbortSignal;
    request: GatewayPinnedHttpsRequest;
    resolveHostname: GatewayHostnameResolver;
  }>,
): Promise<Response> {
  let currentUrl = initialUrl;
  const redirectStatuses = new Set([301, 302, 303, 307, 308]);
  for (
    let redirectCount = 0;
    redirectCount <= MAXIMUM_DOWNLOAD_REDIRECTS;
    redirectCount += 1
  ) {
    const addresses = await assertSafeDownloadTarget(
      currentUrl,
      input.resolveHostname,
      input.abortSignal,
    );
    let response: Response;
    try {
      response = await input.request(currentUrl, {
        abortSignal: input.abortSignal,
        addresses,
      });
    } catch (error) {
      if (error instanceof GatewayMediaExecutionError) throw error;
      throw new GatewayMediaExecutionError("download-failed");
    }
    const location = response.headers.get("location");
    if (redirectStatuses.has(response.status) && location !== null) {
      await response.body?.cancel().catch(() => undefined);
      if (redirectCount === MAXIMUM_DOWNLOAD_REDIRECTS) {
        throw new GatewayMediaExecutionError("download-failed");
      }
      try {
        currentUrl = new URL(location, currentUrl);
      } catch {
        throw new GatewayMediaExecutionError("download-failed");
      }
      continue;
    }
    if (
      !response.ok
      || response.redirected
      || (response.status >= 300 && response.status < 400)
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new GatewayMediaExecutionError("download-failed");
    }
    return response;
  }
  throw new GatewayMediaExecutionError("download-failed");
}

export function createBoundedGatewayMediaDownload(options: Readonly<{
  maximumBytes?: number;
  request?: GatewayPinnedHttpsRequest;
  resolveHostname?: GatewayHostnameResolver;
  timeoutMs?: number;
}> = {}): GatewayMediaDownload {
  const request = options.request ?? pinnedHttpsRequest;
  const resolveHostname = options.resolveHostname
    ?? (async hostname => (await lookup(hostname, {
      all: true,
      verbatim: true,
    })).flatMap(answer => (
      answer.family === 4 || answer.family === 6
        ? [{ address: answer.address, family: answer.family }]
        : []
    )));
  const maximumBytes = options.maximumBytes ?? MAXIMUM_DOWNLOAD_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_VIDEO_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(maximumBytes)
    || maximumBytes < 1
    || maximumBytes > 1024 * 1024 * 1024
    || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > 30 * 60_000
  ) {
    throw new GatewayMediaExecutionError("invalid-request");
  }
  return async ({ abortSignal, maximumBytes: requestMaximumBytes, url }) => {
    const effectiveMaximumBytes = requestMaximumBytes === undefined
      ? maximumBytes
      : Math.min(maximumBytes, requestMaximumBytes);
    if (
      !Number.isSafeInteger(effectiveMaximumBytes)
      || effectiveMaximumBytes < 1
    ) {
      throw new GatewayMediaExecutionError("download-failed");
    }
    const combined = combineAbortSignals(abortSignal, timeoutMs);
    try {
      const response = await settleBeforeAbort(fetchSafeDownload(url, {
          abortSignal: combined.signal,
          request,
          resolveHostname,
        }), combined.signal, "download-failed");
      return {
        data: await settleBeforeAbort(
          readBoundedDownload(response, effectiveMaximumBytes),
          combined.signal,
          "download-failed",
        ),
        mediaType: response.headers.get("content-type")?.split(";", 1)[0]?.trim(),
      };
    } catch (error) {
      if (error instanceof GatewayMediaExecutionError) throw error;
      throw new GatewayMediaExecutionError("download-failed");
    } finally {
      combined.dispose();
    }
  };
}

export function createAggregateGatewayMediaDownload(
  download: GatewayMediaDownload,
  options: Readonly<{
    maximumFileBytes?: number;
    maximumTotalBytes?: number;
  }> = {},
): GatewayMediaDownload {
  const maximumFileBytes = options.maximumFileBytes ?? MAXIMUM_DOWNLOAD_BYTES;
  const maximumTotalBytes = options.maximumTotalBytes
    ?? MAXIMUM_VIDEO_OUTPUT_TOTAL_BYTES;
  if (
    !Number.isSafeInteger(maximumFileBytes)
    || maximumFileBytes < 1
    || maximumFileBytes > MAXIMUM_DOWNLOAD_BYTES
    || !Number.isSafeInteger(maximumTotalBytes)
    || maximumTotalBytes < 1
    || maximumTotalBytes > MAXIMUM_VIDEO_OUTPUT_TOTAL_BYTES
  ) {
    throw new GatewayMediaExecutionError("invalid-request");
  }
  let remainingBytes = maximumTotalBytes;
  let previous = Promise.resolve();
  return input => {
    const current = previous.then(async () => {
      if (input.abortSignal?.aborted === true || remainingBytes < 1) {
        throw new GatewayMediaExecutionError("download-failed");
      }
      const result = await download({
        ...input,
        maximumBytes: Math.min(maximumFileBytes, remainingBytes),
      });
      if (result.data.byteLength < 1 || result.data.byteLength > remainingBytes) {
        throw new GatewayMediaExecutionError("download-failed");
      }
      remainingBytes -= result.data.byteLength;
      return result;
    });
    previous = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  };
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw new GatewayMediaExecutionError("invalid-request");
  }
}

function parseString(
  value: unknown,
  maximumLength: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string"
    || value.length > maximumLength
    || (!allowEmpty && value.trim().length === 0)
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
    throw new GatewayMediaExecutionError("invalid-request");
  }
  return value;
}

function parseOptionalString(
  value: unknown,
  maximumLength: number,
): string | undefined {
  return value === undefined ? undefined : parseString(value, maximumLength);
}

function parseSafeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new GatewayMediaExecutionError("invalid-request");
  }
  return value as number;
}

function parseOptionalSafeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  return value === undefined ? undefined : parseSafeInteger(value, minimum, maximum);
}

function parseOptionalNumber(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum
  ) {
    throw new GatewayMediaExecutionError("invalid-request");
  }
  return value;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new GatewayMediaExecutionError("invalid-request");
  }
  return value;
}

function parseModelId(value: unknown): string {
  const id = parseString(value, 256);
  if (!id.includes("/") || /\s/u.test(id) || id.startsWith("/") || id.endsWith("/")) {
    throw new GatewayMediaExecutionError("invalid-request");
  }
  return id;
}

function parseMediaType(value: unknown): string {
  const mediaType = parseString(value, 128).toLocaleLowerCase("en-US");
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/iu.test(mediaType)) {
    throw new GatewayMediaExecutionError("invalid-request");
  }
  return mediaType;
}

function parseRemoteMediaInputUrl(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 8_192) {
    throw new GatewayMediaExecutionError("invalid-request");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GatewayMediaExecutionError("invalid-request");
  }
  if (
    url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || url.hash !== ""
  ) {
    throw new GatewayMediaExecutionError("invalid-request");
  }
  try {
    const hostname = normalizedDownloadHostname(url);
    const family = isIP(hostname);
    if (family === 4 || family === 6) {
      assertPublicDownloadAddress({ address: hostname, family });
    }
  } catch {
    throw new GatewayMediaExecutionError("invalid-request");
  }
  return url.href;
}

function gatewayInputByteLength(input: GatewayMediaInput): number {
  return input.data?.byteLength ?? 0;
}

function gatewaySdkInput(input: GatewayMediaInput): GatewaySdkMediaInput {
  return input.data ?? input.url;
}

function gatewayInputSource(input: GatewayMediaInput): "base64" | "url" {
  return input.url === undefined ? "base64" : "url";
}

function parseInput(
  value: unknown,
  maximumBytes: number,
  allowedPrefixes: readonly string[],
): GatewayMediaInput {
  if (!isRecord(value)) throw new GatewayMediaExecutionError("invalid-request");
  assertAllowedKeys(value, new Set(["data", "facts", "mediaType", "url"]));
  const data = value.data instanceof Uint8Array ? value.data : undefined;
  const hasData = data !== undefined;
  const hasUrl = value.url !== undefined;
  if (hasData === hasUrl) {
    throw new GatewayMediaExecutionError("invalid-request");
  }
  if (data !== undefined && data.byteLength < 1) {
    throw new GatewayMediaExecutionError("invalid-request");
  }
  if (data !== undefined && data.byteLength > maximumBytes) {
    throw new GatewayMediaExecutionError("input-too-large");
  }
  const mediaType = parseMediaType(value.mediaType);
  if (!allowedPrefixes.some(prefix => mediaType.startsWith(prefix))) {
    throw new GatewayMediaExecutionError("invalid-request");
  }
  if (data !== undefined && !gatewayMediaBytesMatchType(data, mediaType)) {
    throw new GatewayMediaExecutionError("invalid-request");
  }
  let facts: GatewayMediaInput["facts"];
  if (value.facts !== undefined) {
    if (!isRecord(value.facts)) {
      throw new GatewayMediaExecutionError("invalid-request");
    }
    assertAllowedKeys(value.facts, new Set([
      "durationSeconds",
      "height",
      "width",
    ]));
    const durationSeconds = parseOptionalNumber(
      value.facts.durationSeconds,
      0.000_001,
      1_000_000_000,
    );
    const height = parseOptionalSafeInteger(value.facts.height, 1, 1_000_000);
    const width = parseOptionalSafeInteger(value.facts.width, 1, 1_000_000);
    facts = {
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
      ...(height === undefined ? {} : { height }),
      ...(width === undefined ? {} : { width }),
    };
  }
  return data !== undefined
    ? {
        data,
        ...(facts === undefined ? {} : { facts }),
        mediaType,
      }
    : {
        ...(facts === undefined ? {} : { facts }),
        mediaType,
        url: parseRemoteMediaInputUrl(value.url),
      };
}

function parseInputArray(
  value: unknown,
  options: Readonly<{
    allowedPrefixes: readonly string[];
    maximumBytes: number;
    maximumTotalBytes: number;
  }>,
): readonly GatewayMediaInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAXIMUM_INPUTS) {
    throw new GatewayMediaExecutionError("invalid-request");
  }
  const inputs = value.map(item => parseInput(
    item,
    options.maximumBytes,
    options.allowedPrefixes,
  ));
  if (
    inputs.reduce((sum, input) => sum + gatewayInputByteLength(input), 0)
    > options.maximumTotalBytes
  ) {
    throw new GatewayMediaExecutionError("input-too-large");
  }
  return inputs;
}

function parseConsent(
  value: unknown,
  now: Date,
): GatewayUploadConsent {
  if (!isRecord(value)) {
    throw new GatewayMediaExecutionError("cloud-consent-required");
  }
  assertAllowedKeys(value, new Set([
    "acknowledgedAt",
    "allowCloudUpload",
    "policy",
  ]));
  if (
    value.allowCloudUpload !== true
    || (
      value.policy !== GATEWAY_MEDIA_UPLOAD_POLICY
      && value.policy !== LEGACY_GATEWAY_MEDIA_UPLOAD_POLICY
    )
    || typeof value.acknowledgedAt !== "string"
  ) {
    throw new GatewayMediaExecutionError("cloud-consent-required");
  }
  const acknowledgedMs = Date.parse(value.acknowledgedAt);
  const nowMs = now.getTime();
  if (
    !Number.isFinite(acknowledgedMs)
    || new Date(acknowledgedMs).toISOString() !== value.acknowledgedAt
    || acknowledgedMs < nowMs - 15 * 60_000
    || acknowledgedMs > nowMs + 60_000
  ) {
    throw new GatewayMediaExecutionError("cloud-consent-required");
  }
  return {
    acknowledgedAt: value.acknowledgedAt,
    allowCloudUpload: true,
    policy: value.policy,
  };
}

function parseProviderOptions(
  value: unknown,
): GatewayProviderOptions | undefined {
  if (value === undefined) return undefined;
  try {
    return parseGatewayProviderOptions(value);
  } catch {
    throw new GatewayMediaExecutionError("invalid-request");
  }
}

function inputDigest(
  input: GatewayMediaInput,
  role: string,
): GatewayMediaInputDigest {
  const content = input.data ?? new TextEncoder().encode(input.url);
  return {
    bytes: gatewayInputByteLength(input),
    mediaType: input.mediaType,
    role,
    sha256: createHash("sha256").update(content).digest("hex"),
    source: input.url === undefined ? "inline" : "url",
  };
}

function requestSummary(
  fields: Readonly<Record<string, GatewayJsonValue>>,
  prompt: string | undefined,
  providerOptions: GatewayProviderOptions | undefined,
): Readonly<Record<string, GatewayJsonValue>> {
  const provider = providerOptions === undefined
    ? undefined
    : gatewayProviderOptionsSummary(providerOptions);
  return {
    ...fields,
    ...(prompt === undefined
      ? {}
      : {
          promptCharacters: prompt.length,
          promptSha256: createHash("sha256").update(prompt, "utf8").digest("hex"),
        }),
    ...(provider === undefined
      ? {}
      : {
          providerNamespaces: provider.namespaces,
          providerOptionsSha256: provider.sha256,
        }),
  };
}

function optionalSummaryValue(
  value: boolean | number | string | undefined,
): GatewayJsonValue | undefined {
  return value;
}

function cleanSummary(
  value: Readonly<Record<string, GatewayJsonValue | undefined>>,
): Readonly<Record<string, GatewayJsonValue>> {
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, GatewayJsonValue] => entry[1] !== undefined,
    ),
  );
}

function parseWarning(value: unknown): string {
  let message: string;
  if (typeof value === "string") {
    message = value;
  } else if (isObject(value) && typeof value.message === "string") {
    message = value.message;
  } else if (isObject(value) && typeof value.details === "string") {
    message = value.details;
  } else {
    message = "Provider warning";
  }
  const warningTypes = new Set([
    "other",
    "unsupported-setting",
    "unsupported-tool",
  ]);
  const type = isObject(value)
    && typeof value.type === "string"
    && warningTypes.has(value.type)
    ? value.type
    : "provider-warning";
  return `${type} sha256:${createHash("sha256").update(message).digest("hex")}`;
}

function parseWarnings(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new GatewayMediaExecutionError("invalid-response");
  }
  return value.map(parseWarning);
}

function boundedMetadataString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, 256)
    : undefined;
}

function opaqueMetadataDigest(value: unknown): string | undefined {
  const bounded = boundedMetadataString(value);
  return bounded === undefined
    ? undefined
    : `sha256:${createHash("sha256").update(bounded, "utf8").digest("hex")}`;
}

function knownCredentialType(value: unknown): string | undefined {
  const bounded = boundedMetadataString(value);
  return bounded !== undefined && new Set([
    "api-key",
    "oauth",
    "oidc",
    "service-account",
    "unknown",
  ]).has(bounded)
    ? bounded
    : undefined;
}

function parseGatewayRoutingMetadata(
  providerMetadata: unknown,
): GatewayMediaRoutingReceipt {
  const gateway = isObject(providerMetadata) && isObject(providerMetadata.gateway)
    ? providerMetadata.gateway
    : undefined;
  const allAttempts = gateway !== undefined && Array.isArray(gateway.attempts)
    ? gateway.attempts
    : [];
  const rawAttempts = allAttempts.slice(0, 32);
  const attempts = rawAttempts.flatMap((value) => {
    if (!isObject(value)) return [];
    const configuredTimeoutMs = typeof value.configuredTimeoutMs === "number"
      && Number.isSafeInteger(value.configuredTimeoutMs)
      && value.configuredTimeoutMs >= 0
      ? value.configuredTimeoutMs
      : undefined;
    const statusCode = typeof value.statusCode === "number"
      && Number.isSafeInteger(value.statusCode)
      && value.statusCode >= 0
      && value.statusCode <= 999
      ? value.statusCode
      : undefined;
    const provider = opaqueMetadataDigest(value.provider);
    const error = boundedMetadataString(value.error);
    const credentialType = knownCredentialType(value.credentialType);
    const model = opaqueMetadataDigest(value.model);
    return [{
      ...(configuredTimeoutMs === undefined ? {} : { configuredTimeoutMs }),
      ...(credentialType === undefined ? {} : { credentialType }),
      ...(error === undefined
        ? {}
        : {
            error: `sha256:${createHash("sha256")
              .update(error, "utf8")
              .digest("hex")}`,
          }),
      ...(model === undefined ? {} : { model }),
      ...(provider === undefined ? {} : { provider }),
      ...(typeof value.providerTimeout === "boolean"
        ? { providerTimeout: value.providerTimeout }
        : {}),
      ...(statusCode === undefined ? {} : { statusCode }),
      ...(typeof value.success === "boolean" ? { success: value.success } : {}),
    }];
  });
  const directProvider = opaqueMetadataDigest(gateway?.provider);
  const providers = [
    ...(directProvider === undefined ? [] : [directProvider]),
    ...attempts.flatMap(attempt => (
      attempt.provider === undefined ? [] : [attempt.provider]
    )),
  ];
  const uniqueProviders = [...new Set(providers)];
  const generationId = opaqueMetadataDigest(gateway?.generationId);
  return {
    attemptCount: allAttempts.length,
    attempts,
    attemptsTruncated: allAttempts.length !== attempts.length,
    clientMaxRetries: 0,
    gatewayProviderFailover: "may-attempt-multiple-providers",
    ...(generationId === undefined ? {} : { generationId }),
    providerCount: uniqueProviders.length,
    providers: uniqueProviders.slice(0, 32),
    providersTruncated: uniqueProviders.length > 32,
  };
}

function parseGeneratedFile(
  value: unknown,
  allowedPrefixes: readonly string[],
): GatewayGeneratedFile {
  if (
    !isObject(value)
    || typeof value.mediaType !== "string"
    || !(value.uint8Array instanceof Uint8Array)
    || value.uint8Array.byteLength < 1
  ) {
    throw new GatewayMediaExecutionError("invalid-response");
  }
  const mediaType = parseMediaType(value.mediaType);
  if (!allowedPrefixes.some(prefix => mediaType.startsWith(prefix))) {
    throw new GatewayMediaExecutionError("invalid-response");
  }
  if (!gatewayMediaBytesMatchType(value.uint8Array, mediaType)) {
    throw new GatewayMediaExecutionError("invalid-response");
  }
  return {
    mediaType,
    uint8Array: value.uint8Array,
  };
}

function parseGeneratedFiles(
  result: unknown,
  pluralKey: "images" | "videos",
  allowedPrefixes: readonly string[],
): Readonly<{
  files: readonly GatewayGeneratedFile[];
  routing: GatewayMediaRoutingReceipt;
  warnings: readonly string[];
}> {
  if (!isObject(result) || !Array.isArray(result[pluralKey])) {
    throw new GatewayMediaExecutionError("invalid-response");
  }
  const values = result[pluralKey];
  if (values.length < 1 || values.length > 32) {
    throw new GatewayMediaExecutionError("invalid-response");
  }
  return {
    files: values.map(value => parseGeneratedFile(value, allowedPrefixes)),
    routing: parseGatewayRoutingMetadata(result.providerMetadata),
    warnings: parseWarnings(result.warnings),
  };
}

function validateTimeout(value: number | undefined, fallback: number): number {
  const timeout = value ?? fallback;
  if (
    !Number.isSafeInteger(timeout)
    || timeout < 1_000
    || timeout > 30 * 60_000
  ) {
    throw new GatewayMediaExecutionError("invalid-request");
  }
  return timeout;
}

interface CommonRequest {
  readonly consent: GatewayUploadConsent;
  readonly model: string;
  readonly providerOptions?: GatewayProviderOptions;
}

interface ParsedImageRequest extends CommonRequest {
  readonly aspectRatio?: string;
  readonly images: readonly GatewayMediaInput[];
  readonly mask?: GatewayMediaInput;
  readonly maxImagesPerCall?: number;
  readonly maxOutputTokens?: number;
  readonly n?: number;
  readonly prompt: string;
  readonly seed?: number;
  readonly size?: string;
  readonly stopSequences?: readonly string[];
  readonly temperature?: number;
}

function parseOptionalStringArray(
  value: unknown,
  maximumItems: number,
  maximumItemLength: number,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new GatewayMediaExecutionError("invalid-request");
  }
  return value.map(item => parseString(item, maximumItemLength));
}

function parseImageRequest(value: unknown, now: Date): ParsedImageRequest {
  if (!isRecord(value)) throw new GatewayMediaExecutionError("invalid-request");
  assertAllowedKeys(value, new Set([
    "aspectRatio",
    "consent",
    "images",
    "mask",
    "maxImagesPerCall",
    "maxOutputTokens",
    "model",
    "n",
    "prompt",
    "providerOptions",
    "seed",
    "size",
    "stopSequences",
    "temperature",
  ]));
  const size = parseOptionalString(value.size, 32);
  const aspectRatio = parseOptionalString(value.aspectRatio, 32);
  if (
    (size !== undefined && !/^[1-9]\d{0,5}x[1-9]\d{0,5}$/u.test(size))
    || (aspectRatio !== undefined && !/^[1-9]\d{0,5}:[1-9]\d{0,5}$/u.test(aspectRatio))
    || (size !== undefined && aspectRatio !== undefined)
  ) {
    throw new GatewayMediaExecutionError("invalid-request");
  }
  const images = parseInputArray(value.images, {
    allowedPrefixes: ["image/"],
    maximumBytes: MAXIMUM_IMAGE_INPUT_BYTES,
    maximumTotalBytes: MAXIMUM_IMAGE_INPUT_TOTAL_BYTES,
  });
  const mask = value.mask === undefined
    ? undefined
    : parseInput(value.mask, MAXIMUM_IMAGE_INPUT_BYTES, ["image/"]);
  if (
    mask !== undefined
    && images.reduce(
      (sum, input) => sum + gatewayInputByteLength(input),
      gatewayInputByteLength(mask),
    )
      > MAXIMUM_IMAGE_INPUT_TOTAL_BYTES
  ) {
    throw new GatewayMediaExecutionError("input-too-large");
  }
  if (mask !== undefined && images.length === 0) {
    throw new GatewayMediaExecutionError("invalid-request");
  }
  const maxImagesPerCall = parseOptionalSafeInteger(value.maxImagesPerCall, 1, 32);
  const maxOutputTokens = parseOptionalSafeInteger(value.maxOutputTokens, 1, 1_000_000);
  const n = parseOptionalSafeInteger(value.n, 1, 32);
  if (
    (n ?? 1) > 1
    && (
      maxImagesPerCall === undefined
      || maxImagesPerCall < (n ?? 1)
    )
  ) {
    throw new GatewayMediaExecutionError("invalid-request");
  }
  const providerOptions = parseProviderOptions(value.providerOptions);
  const seed = parseOptionalSafeInteger(value.seed, 0, 0xffff_ffff);
  const stopSequences = parseOptionalStringArray(value.stopSequences, 64, 1_024);
  const temperature = parseOptionalNumber(value.temperature, 0, 100);
  return {
    ...(aspectRatio === undefined ? {} : { aspectRatio }),
    consent: parseConsent(value.consent, now),
    images,
    ...(mask === undefined ? {} : { mask }),
    ...(maxImagesPerCall === undefined ? {} : { maxImagesPerCall }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    model: parseModelId(value.model),
    ...(n === undefined ? {} : { n }),
    prompt: parseString(
      value.prompt,
      MAXIMUM_PROMPT_CHARACTERS,
      images.length > 0,
    ),
    ...(providerOptions === undefined ? {} : { providerOptions }),
    ...(seed === undefined ? {} : { seed }),
    ...(size === undefined ? {} : { size }),
    ...(stopSequences === undefined ? {} : { stopSequences }),
    ...(temperature === undefined ? {} : { temperature }),
  };
}

interface ParsedVideoFrame {
  readonly frameType: string;
  readonly image: GatewayMediaInput;
}

interface ParsedVideoRequest extends CommonRequest {
  readonly aspectRatio?: string;
  readonly duration?: number;
  readonly fps?: number;
  readonly frameImages: readonly ParsedVideoFrame[];
  readonly generateAudio?: boolean;
  readonly inputReferences: readonly GatewayMediaInput[];
  readonly maxVideosPerCall?: number;
  readonly n?: number;
  readonly prompt: string;
  readonly promptImage?: GatewayMediaInput;
  readonly resolution?: string;
  readonly seed?: number;
}

function parseVideoFrames(value: unknown): readonly ParsedVideoFrame[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAXIMUM_INPUTS) {
    throw new GatewayMediaExecutionError("invalid-request");
  }
  const frames = value.map((frame): ParsedVideoFrame => {
    if (!isRecord(frame)) throw new GatewayMediaExecutionError("invalid-request");
    assertAllowedKeys(frame, new Set(["frameType", "image"]));
    const rawFrameType = parseString(frame.frameType, 64);
    const frameType = rawFrameType === "first"
      ? "first_frame"
      : rawFrameType === "last"
        ? "last_frame"
        : rawFrameType;
    if (frameType !== "first_frame" && frameType !== "last_frame") {
      throw new GatewayMediaExecutionError("invalid-request");
    }
    return {
      frameType,
      image: parseInput(frame.image, MAXIMUM_IMAGE_INPUT_BYTES, ["image/"]),
    };
  });
  if (
    frames.reduce(
      (sum, frame) => sum + gatewayInputByteLength(frame.image),
      0,
    )
    > MAXIMUM_IMAGE_INPUT_TOTAL_BYTES
    || new Set(frames.map(frame => frame.frameType)).size !== frames.length
  ) {
    throw new GatewayMediaExecutionError(
      frames.reduce(
        (sum, frame) => sum + gatewayInputByteLength(frame.image),
        0,
      )
        > MAXIMUM_IMAGE_INPUT_TOTAL_BYTES
        ? "input-too-large"
        : "invalid-request",
    );
  }
  return frames;
}

function parseVideoRequest(value: unknown, now: Date): ParsedVideoRequest {
  if (!isRecord(value)) throw new GatewayMediaExecutionError("invalid-request");
  assertAllowedKeys(value, new Set([
    "aspectRatio",
    "consent",
    "duration",
    "fps",
    "frameImages",
    "generateAudio",
    "inputReferences",
    "maxVideosPerCall",
    "model",
    "n",
    "prompt",
    "promptImage",
    "providerOptions",
    "resolution",
    "seed",
  ]));
  const aspectRatio = parseOptionalString(value.aspectRatio, 32);
  const resolution = parseOptionalString(value.resolution, 32);
  if (
    (aspectRatio !== undefined && !/^[1-9]\d{0,5}:[1-9]\d{0,5}$/u.test(aspectRatio))
    || (resolution !== undefined && !/^(?:[1-9]\d{0,5}x[1-9]\d{0,5}|[1-9]\d{2,4}p|[1-9]\d{0,2}k)$/iu.test(resolution))
  ) {
    throw new GatewayMediaExecutionError("invalid-request");
  }
  const promptImage = value.promptImage === undefined
    ? undefined
    : parseInput(value.promptImage, MAXIMUM_IMAGE_INPUT_BYTES, ["image/"]);
  const frameImages = parseVideoFrames(value.frameImages);
  const inputReferences = parseInputArray(value.inputReferences, {
    allowedPrefixes: ["audio/", "image/", "video/"],
    maximumBytes: MAXIMUM_REFERENCE_INPUT_BYTES,
    maximumTotalBytes: MAXIMUM_REFERENCE_INPUT_TOTAL_BYTES,
  });
  const providerOptions = parseProviderOptions(value.providerOptions);
  if (
    (frameImages.length > 0 && inputReferences.length > 0)
    || (
      promptImage !== undefined
      && frameImages.some(frame => frame.frameType === "first_frame")
    )
    || (
      frameImages.some(frame => frame.frameType === "last_frame")
      && promptImage === undefined
      && !frameImages.some(frame => frame.frameType === "first_frame")
    )
  ) {
    throw new GatewayMediaExecutionError("invalid-request");
  }
  const duration = parseOptionalNumber(value.duration, 0.01, 3_600);
  const fps = parseOptionalNumber(value.fps, 0.01, 1_000);
  const generateAudio = parseOptionalBoolean(value.generateAudio);
  const maxVideosPerCall = parseOptionalSafeInteger(value.maxVideosPerCall, 1, 32);
  const n = parseOptionalSafeInteger(value.n, 1, 32);
  if (
    (n ?? 1) > 1
    && (
      maxVideosPerCall === undefined
      || maxVideosPerCall < (n ?? 1)
    )
  ) {
    throw new GatewayMediaExecutionError("invalid-request");
  }
  const seed = parseOptionalSafeInteger(value.seed, 0, 0xffff_ffff);
  return {
    ...(aspectRatio === undefined ? {} : { aspectRatio }),
    consent: parseConsent(value.consent, now),
    ...(duration === undefined ? {} : { duration }),
    ...(fps === undefined ? {} : { fps }),
    frameImages,
    ...(generateAudio === undefined ? {} : { generateAudio }),
    inputReferences,
    ...(maxVideosPerCall === undefined ? {} : { maxVideosPerCall }),
    model: parseModelId(value.model),
    ...(n === undefined ? {} : { n }),
    prompt: parseString(
      value.prompt,
      MAXIMUM_PROMPT_CHARACTERS,
      promptImage !== undefined
        || frameImages.length > 0
        || inputReferences.length > 0,
    ),
    ...(promptImage === undefined ? {} : { promptImage }),
    ...(providerOptions === undefined ? {} : { providerOptions }),
    ...(resolution === undefined ? {} : { resolution }),
    ...(seed === undefined ? {} : { seed }),
  };
}

interface ParsedSpeechRequest extends CommonRequest {
  readonly instructions?: string;
  readonly language?: string;
  readonly outputFormat?: string;
  readonly speed?: number;
  readonly text: string;
  readonly voice?: string;
}

function parseSpeechRequest(value: unknown, now: Date): ParsedSpeechRequest {
  if (!isRecord(value)) throw new GatewayMediaExecutionError("invalid-request");
  assertAllowedKeys(value, new Set([
    "consent",
    "instructions",
    "language",
    "model",
    "outputFormat",
    "providerOptions",
    "speed",
    "text",
    "voice",
  ]));
  const outputFormat = parseOptionalString(value.outputFormat, 64);
  if (outputFormat !== undefined && !/^[a-z0-9][a-z0-9._+-]*$/iu.test(outputFormat)) {
    throw new GatewayMediaExecutionError("invalid-request");
  }
  const instructions = parseOptionalString(value.instructions, MAXIMUM_PROMPT_CHARACTERS);
  const language = parseOptionalString(value.language, 64);
  const providerOptions = parseProviderOptions(value.providerOptions);
  const speed = parseOptionalNumber(value.speed, 0.01, 100);
  const voice = parseOptionalString(value.voice, 256);
  return {
    consent: parseConsent(value.consent, now),
    ...(instructions === undefined ? {} : { instructions }),
    ...(language === undefined ? {} : { language }),
    model: parseModelId(value.model),
    ...(outputFormat === undefined ? {} : { outputFormat }),
    ...(providerOptions === undefined ? {} : { providerOptions }),
    ...(speed === undefined ? {} : { speed }),
    text: parseString(value.text, MAXIMUM_PROMPT_CHARACTERS),
    ...(voice === undefined ? {} : { voice }),
  };
}

interface ParsedTranscriptionRequest extends CommonRequest {
  readonly audio: GatewayInlineMediaInput;
}

function parseTranscriptionRequest(
  value: unknown,
  now: Date,
): ParsedTranscriptionRequest {
  if (!isRecord(value)) throw new GatewayMediaExecutionError("invalid-request");
  assertAllowedKeys(value, new Set([
    "audio",
    "consent",
    "model",
    "providerOptions",
  ]));
  const providerOptions = parseProviderOptions(value.providerOptions);
  const audio = parseInput(
    value.audio,
    MAXIMUM_TRANSCRIPTION_INPUT_BYTES,
    ["audio/"],
  );
  if (audio.url !== undefined) {
    throw new GatewayMediaExecutionError("invalid-request");
  }
  return {
    audio,
    consent: parseConsent(value.consent, now),
    model: parseModelId(value.model),
    ...(providerOptions === undefined ? {} : { providerOptions }),
  };
}

interface TranscriptionSegment {
  readonly endSecond: number;
  readonly startSecond: number;
  readonly text: string;
}

interface ParsedTranscriptionResult {
  readonly durationInSeconds?: number;
  readonly language?: string;
  readonly routing: GatewayMediaRoutingReceipt;
  readonly segments: readonly TranscriptionSegment[];
  readonly text: string;
  readonly warnings: readonly string[];
}

function parseTranscriptionResult(
  value: unknown,
): ParsedTranscriptionResult {
  if (
    !isObject(value)
    || typeof value.text !== "string"
    || value.text.length > MAXIMUM_TRANSCRIPT_CHARACTERS
    || !Array.isArray(value.segments)
    || value.segments.length > MAXIMUM_TRANSCRIPT_SEGMENTS
  ) {
    throw new GatewayMediaExecutionError("invalid-response");
  }
  if (Buffer.byteLength(value.text, "utf8") > MAXIMUM_TRANSCRIPT_TEXT_BYTES) {
    throw new GatewayMediaExecutionError("invalid-response");
  }
  let segmentTextBytes = 0;
  const segments = value.segments.map((segment): TranscriptionSegment => {
    if (
      !isObject(segment)
      || typeof segment.text !== "string"
      || segment.text.length > 100_000
      || typeof segment.startSecond !== "number"
      || typeof segment.endSecond !== "number"
      || !Number.isFinite(segment.startSecond)
      || !Number.isFinite(segment.endSecond)
      || segment.startSecond < 0
      || segment.endSecond < segment.startSecond
      || segment.endSecond > 1_000_000_000
    ) {
      throw new GatewayMediaExecutionError("invalid-response");
    }
    segmentTextBytes += Buffer.byteLength(segment.text, "utf8");
    if (segmentTextBytes > MAXIMUM_TRANSCRIPT_SEGMENT_TEXT_BYTES) {
      throw new GatewayMediaExecutionError("invalid-response");
    }
    return {
      endSecond: segment.endSecond,
      startSecond: segment.startSecond,
      text: segment.text,
    };
  });
  const language = value.language === undefined
    ? undefined
    : parseString(value.language, 64);
  const durationInSeconds = value.durationInSeconds === undefined
    ? undefined
    : parseOptionalNumber(value.durationInSeconds, 0, 1_000_000_000);
  if (
    segments.some((segment, index) => (
      (
        index > 0
        && segment.startSecond < segments[index - 1]!.startSecond
      )
      || (
        durationInSeconds !== undefined
        && segment.endSecond > durationInSeconds + 0.001
      )
    ))
  ) {
    throw new GatewayMediaExecutionError("invalid-response");
  }
  return {
    ...(durationInSeconds === undefined ? {} : { durationInSeconds }),
    ...(language === undefined ? {} : { language }),
    routing: parseGatewayRoutingMetadata(value.providerMetadata),
    segments,
    text: value.text,
    warnings: parseWarnings(value.warnings),
  };
}

function subtitleTimestamp(
  seconds: number,
  separator: "," | ".",
): string {
  const totalMilliseconds = Math.round(seconds * 1_000);
  const hours = Math.floor(totalMilliseconds / 3_600_000);
  const minutes = Math.floor(totalMilliseconds / 60_000) % 60;
  const wholeSeconds = Math.floor(totalMilliseconds / 1_000) % 60;
  const milliseconds = totalMilliseconds % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}${separator}${String(milliseconds).padStart(3, "0")}`;
}

function safeSubtitleText(value: string): string {
  let printableValue = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    printableValue += (
      codePoint <= 8
      || codePoint === 11
      || codePoint === 12
      || (codePoint >= 14 && codePoint <= 31)
      || codePoint === 127
    )
      ? " "
      : character;
  }
  return printableValue
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll(/\r\n?|\n/gu, " ");
}

function subtitleBody(
  result: ParsedTranscriptionResult,
  format: "srt" | "vtt",
): string {
  const separator = format === "srt" ? "," : ".";
  const cues = result.segments.map((segment, index) => [
    ...(format === "srt" ? [String(index + 1)] : []),
    `${subtitleTimestamp(segment.startSecond, separator)} --> ${subtitleTimestamp(segment.endSecond, separator)}`,
    safeSubtitleText(segment.text),
  ].join("\n")).join("\n\n");
  const body = cues.length === 0 ? "" : `${cues}\n`;
  return format === "vtt" ? `WEBVTT\n\n${body}` : body.length === 0 ? "\n" : body;
}

function transcriptFiles(
  result: ParsedTranscriptionResult,
): readonly GatewayGeneratedFile[] {
  const body = {
    ...(result.durationInSeconds === undefined
      ? {}
      : { durationInSeconds: result.durationInSeconds }),
    ...(result.language === undefined ? {} : { language: result.language }),
    segments: result.segments,
    text: result.text,
  };
  const encoder = new TextEncoder();
  let totalBytes = 0;
  const files: GatewayGeneratedFile[] = [];
  const append = (mediaType: string, contents: string): void => {
    const uint8Array = encoder.encode(contents);
    totalBytes += uint8Array.byteLength;
    if (totalBytes > MAXIMUM_TRANSCRIPT_ARTIFACT_BYTES) {
      throw new GatewayMediaExecutionError("invalid-response");
    }
    files.push({ mediaType, uint8Array });
  };
  append("application/json", `${JSON.stringify(body)}\n`);
  append(
    "text/plain",
    result.text.endsWith("\n") ? result.text : `${result.text}\n`,
  );
  append("application/x-subrip", subtitleBody(result, "srt"));
  append("text/vtt", subtitleBody(result, "vtt"));
  return files;
}

interface CatalogCache {
  get(input: Readonly<{
    freshness: "allow-stale" | "require-fresh";
    signal?: AbortSignal;
  }>): Promise<GatewayMediaCatalogView>;
}

async function modelCatalog(
  cache: CatalogCache,
  modelId: string,
  expectedKind: GatewayMediaKind,
  signal: AbortSignal | undefined,
): Promise<Readonly<{
  catalog: GatewayMediaCatalogView;
  model: GatewayMediaModel;
}>> {
  const catalog = await cache.get({
    freshness: "require-fresh",
    ...(signal === undefined ? {} : { signal }),
  });
  const model = catalog.snapshot.models.find(item => item.id === modelId);
  if (model === undefined) throw new GatewayMediaExecutionError("model-not-found");
  if (model.kind !== expectedKind) {
    throw new GatewayMediaExecutionError("model-kind-mismatch");
  }
  return { catalog, model };
}

function unsupportedModelSetting(): never {
  throw new GatewayMediaExecutionError("model-operation-unsupported");
}

function capabilityStringList(
  capabilities: GatewayMediaModel["capabilities"],
  name: string,
): readonly string[] | undefined {
  const value = capabilities?.[name];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    return unsupportedModelSetting();
  }
  return value.filter((item): item is string => typeof item === "string");
}

function capabilityNumberList(
  capabilities: GatewayMediaModel["capabilities"],
  name: string,
): readonly number[] | undefined {
  const value = capabilities?.[name];
  if (value === undefined || value === null) return undefined;
  if (
    !Array.isArray(value)
    || value.some(item => typeof item !== "number" || !Number.isFinite(item))
  ) {
    return unsupportedModelSetting();
  }
  return value.filter(
    (item): item is number => typeof item === "number" && Number.isFinite(item),
  );
}

function capabilityNumber(
  value: Readonly<Record<string, unknown>>,
  name: string,
): number | undefined {
  const candidate = value[name];
  if (candidate === undefined || candidate === null) return undefined;
  if (
    typeof candidate !== "number"
    || !Number.isFinite(candidate)
    || candidate < 0
  ) {
    return unsupportedModelSetting();
  }
  return candidate;
}

function capabilityInteger(
  value: Readonly<Record<string, unknown>>,
  name: string,
): number | undefined {
  const candidate = capabilityNumber(value, name);
  if (candidate !== undefined && !Number.isSafeInteger(candidate)) {
    return unsupportedModelSetting();
  }
  return candidate;
}

function assertSupportedOperation(
  model: GatewayMediaModel,
  candidates: readonly string[],
): void {
  const supported = capabilityStringList(
    model.capabilities,
    "supported_operations",
  );
  if (
    supported !== undefined
    && !candidates.some(candidate => supported.includes(candidate))
  ) {
    unsupportedModelSetting();
  }
}

function assertListedString(
  capabilities: GatewayMediaModel["capabilities"],
  name: string,
  value: string | undefined,
): void {
  const supported = capabilityStringList(capabilities, name);
  if (
    value !== undefined
    && supported !== undefined
    && !supported.some(candidate => (
      candidate.toLocaleLowerCase("en-US")
      === value.toLocaleLowerCase("en-US")
    ))
  ) {
    unsupportedModelSetting();
  }
}

function assertListedNumber(
  capabilities: GatewayMediaModel["capabilities"],
  name: string,
  value: number | undefined,
): void {
  const supported = capabilityNumberList(capabilities, name);
  if (
    value !== undefined
    && supported !== undefined
    && !supported.includes(value)
  ) {
    unsupportedModelSetting();
  }
}

function formatAliases(mediaType: string): readonly string[] {
  const aliases: Readonly<Record<string, readonly string[]>> = {
    "audio/aac": ["aac"],
    "audio/flac": ["flac"],
    "audio/mp4": ["m4a", "mp4"],
    "audio/mpeg": ["mp3", "mpeg"],
    "audio/ogg": ["ogg"],
    "audio/opus": ["ogg", "opus"],
    "audio/wav": ["wav"],
    "audio/webm": ["webm"],
    "image/avif": ["avif"],
    "image/bmp": ["bmp"],
    "image/gif": ["gif"],
    "image/jpeg": ["jpeg", "jpg"],
    "image/png": ["png"],
    "image/tiff": ["tif", "tiff"],
    "image/webp": ["webp"],
    "video/mp4": ["mp4"],
    "video/quicktime": ["mov", "quicktime"],
    "video/webm": ["webm"],
    "video/x-matroska": ["mkv", "matroska"],
  };
  return aliases[mediaType] ?? [mediaType.split("/").at(-1) ?? mediaType];
}

function capabilityAspectRatio(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") unsupportedModelSetting();
  const match = /^([1-9]\d*):([1-9]\d*)$/u.exec(value);
  if (match === null) unsupportedModelSetting();
  const ratio = Number(match[1]) / Number(match[2]);
  return Number.isFinite(ratio) && ratio > 0
    ? ratio
    : unsupportedModelSetting();
}

function assertInputLimits(
  model: GatewayMediaModel,
  prompt: string,
  inputs: readonly GatewayMediaInput[],
): void {
  const rawLimits = model.capabilities?.input_limits;
  if (rawLimits === undefined || rawLimits === null) return;
  if (!isRecord(rawLimits)) unsupportedModelSetting();
  const limits = rawLimits as Readonly<Record<string, unknown>>;
  const maximumTotal = capabilityInteger(limits, "max_total_inputs");
  if (maximumTotal !== undefined && inputs.length > maximumTotal) {
    unsupportedModelSetting();
  }
  const textLimits = limits.text;
  if (textLimits !== undefined && textLimits !== null) {
    if (!isRecord(textLimits)) unsupportedModelSetting();
    const maximumCharacters = capabilityInteger(textLimits, "max_chars");
    if (
      maximumCharacters !== undefined
      && prompt.length > maximumCharacters
    ) {
      unsupportedModelSetting();
    }
  }
  for (const kind of ["audio", "image", "video"] as const) {
    const matching = inputs.filter(input => input.mediaType.startsWith(`${kind}/`));
    if (matching.length === 0) continue;
    const inlineInputs = matching.filter(input => input.url === undefined);
    const rawKindLimits = limits[kind];
    if (rawKindLimits === undefined || rawKindLimits === null) {
      unsupportedModelSetting();
    }
    if (!isRecord(rawKindLimits)) unsupportedModelSetting();
    const kindLimits = rawKindLimits as Readonly<Record<string, unknown>>;
    if (
      inlineInputs.some(input => (
        (kind === "image" || kind === "video")
          ? input.facts?.width === undefined || input.facts.height === undefined
          : input.facts?.durationSeconds === undefined
      ))
      || (
        kind === "video"
        && inlineInputs.some(input => input.facts?.durationSeconds === undefined)
      )
    ) {
      unsupportedModelSetting();
    }
    const maximumCount = capabilityInteger(kindLimits, "max_count");
    if (maximumCount !== undefined && matching.length > maximumCount) {
      unsupportedModelSetting();
    }
    const maximumFileSizeMb = capabilityNumber(
      kindLimits,
      "max_file_size_mb",
    );
    if (
      maximumFileSizeMb !== undefined
      && inlineInputs.some(
        input => gatewayInputByteLength(input) > maximumFileSizeMb * 1024 * 1024,
      )
    ) {
      unsupportedModelSetting();
    }
    const minimumDimension = capabilityInteger(
      kindLimits,
      "min_dimension_pixels",
    );
    const maximumDimension = capabilityInteger(
      kindLimits,
      "max_dimension_pixels",
    );
    const minimumAspectRatio = capabilityAspectRatio(
      kindLimits.min_aspect_ratio,
    );
    const maximumAspectRatio = capabilityAspectRatio(
      kindLimits.max_aspect_ratio,
    );
    if (
      (kind === "image" || kind === "video")
      && inlineInputs.some((input) => {
        const width = input.facts!.width!;
        const height = input.facts!.height!;
        const aspectRatio = width / height;
        return (
          (minimumDimension !== undefined
            && (width < minimumDimension || height < minimumDimension))
          || (maximumDimension !== undefined
            && (width > maximumDimension || height > maximumDimension))
          || (minimumAspectRatio !== undefined
            && aspectRatio < minimumAspectRatio)
          || (maximumAspectRatio !== undefined
            && aspectRatio > maximumAspectRatio)
        );
      })
    ) {
      unsupportedModelSetting();
    }
    const minimumDuration = capabilityNumber(
      kindLimits,
      "min_duration_seconds",
    );
    const maximumDuration = capabilityNumber(
      kindLimits,
      "max_duration_seconds",
    );
    if (
      (kind === "audio" || kind === "video")
      && inlineInputs.some((input) => {
        const duration = input.facts!.durationSeconds!;
        return (
          (minimumDuration !== undefined && duration < minimumDuration)
          || (maximumDuration !== undefined && duration > maximumDuration)
        );
      })
    ) {
      unsupportedModelSetting();
    }
    const supportedFormats = kindLimits.supported_formats;
    if (supportedFormats !== undefined && supportedFormats !== null) {
      if (
        !Array.isArray(supportedFormats)
        || supportedFormats.some(item => typeof item !== "string")
      ) {
        unsupportedModelSetting();
      }
      const normalized = supportedFormats
        .filter((item): item is string => typeof item === "string")
        .map(item => item.toLocaleLowerCase("en-US"));
      if (
        matching.some(input => !formatAliases(input.mediaType).some(
          format => normalized.includes(format),
        ))
      ) {
        unsupportedModelSetting();
      }
    }
    const supportedSources = kindLimits.supported_sources;
    if (supportedSources !== undefined && supportedSources !== null) {
      if (
        !Array.isArray(supportedSources)
        || supportedSources.some(item => typeof item !== "string")
      ) {
        unsupportedModelSetting();
      }
      const normalizedSources = supportedSources
        .filter((item): item is string => typeof item === "string")
        .map(item => item.toLocaleLowerCase("en-US"));
      if (
        matching.some(input => (
          gatewayInputSource(input) === "url"
            ? !normalizedSources.includes("url")
            : !normalizedSources.includes("base64")
              && !normalizedSources.includes("buffer")
        ))
      ) {
        unsupportedModelSetting();
      }
    }
  }
}

function assertMaximumSamples(
  model: GatewayMediaModel,
  count: number | undefined,
): void {
  if (count === undefined || model.capabilities === null) return;
  const maximum = capabilityInteger(
    model.capabilities,
    "max_sample_count",
  );
  if (maximum !== undefined && count > maximum) unsupportedModelSetting();
}

function assertImageCapabilities(
  model: GatewayMediaModel,
  request: ParsedImageRequest,
): void {
  const operationCandidates = request.mask !== undefined
    ? ["inpainting", "image-editing", "image-to-image"]
    : request.images.length > 0
      ? ["image-to-image", "image-editing"]
      : ["text-to-image"];
  assertSupportedOperation(model, operationCandidates);
  assertListedString(
    model.capabilities,
    "supported_aspect_ratios",
    request.aspectRatio,
  );
  const supportedSizes = capabilityStringList(
    model.capabilities,
    "supported_sizes",
  ) ?? capabilityStringList(model.capabilities, "supported_resolutions");
  if (
    request.size !== undefined
    && supportedSizes !== undefined
    && !supportedSizes.some(candidate => (
      candidate.toLocaleLowerCase("en-US")
      === request.size!.toLocaleLowerCase("en-US")
    ))
  ) {
    unsupportedModelSetting();
  }
  assertMaximumSamples(model, request.n ?? 1);
  assertInputLimits(
    model,
    request.prompt,
    [
      ...request.images,
      ...(request.mask === undefined ? [] : [request.mask]),
    ],
  );
}

function assertVideoCapabilities(
  model: GatewayMediaModel,
  request: ParsedVideoRequest,
): void {
  const hasLastFrame = request.frameImages.some(
    frame => frame.frameType === "last_frame",
  );
  const visualReferences = request.inputReferences.filter(
    reference => !reference.mediaType.startsWith("audio/"),
  );
  const hasVideoReference = visualReferences.some(
    reference => reference.mediaType.startsWith("video/"),
  );
  const operationCandidates = visualReferences.length > 0
    ? [
        "reference-to-video",
        ...(hasVideoReference
          ? ["motion-control", "video-editing", "extend-video"]
          : []),
      ]
    : hasLastFrame
      ? ["first-last-frame", "first-last-frame-to-video"]
      : request.promptImage !== undefined || request.frameImages.length > 0
        ? ["image-to-video"]
        : ["text-to-video"];
  assertSupportedOperation(model, operationCandidates);
  assertListedString(
    model.capabilities,
    "supported_aspect_ratios",
    request.aspectRatio,
  );
  assertListedString(
    model.capabilities,
    "supported_resolutions",
    request.resolution?.toLocaleLowerCase("en-US"),
  );
  assertListedNumber(
    model.capabilities,
    "supported_durations_seconds",
    request.duration,
  );
  assertListedNumber(model.capabilities, "supported_fps", request.fps);
  if (
    request.generateAudio === true
    && model.capabilities?.generate_audio === false
  ) {
    unsupportedModelSetting();
  }
  assertMaximumSamples(model, request.n ?? 1);
  assertInputLimits(
    model,
    request.prompt,
    [
      ...(request.promptImage === undefined ? [] : [request.promptImage]),
      ...request.frameImages.map(frame => frame.image),
      ...request.inputReferences,
    ],
  );
}

function catalogReceipt(
  catalog: GatewayMediaCatalogView,
): Readonly<{ snapshotId: string; status: "fresh" | "stale" }> {
  return {
    snapshotId: catalog.snapshot.snapshotId,
    status: catalog.status,
  };
}

function providerFailureReconciliation(
  error: unknown,
): NonNullable<GatewayMediaExecutionError["reconciliation"]> {
  let candidate: unknown = error;
  let generationId: string | undefined;
  let providerMetadata: unknown;
  let statusCode: number | undefined;
  for (let depth = 0; depth < 4 && candidate !== undefined; depth += 1) {
    if (!isObject(candidate)) break;
    try {
      generationId ??= opaqueMetadataDigest(candidate.generationId);
      if (
        statusCode === undefined
        && typeof candidate.statusCode === "number"
        && Number.isSafeInteger(candidate.statusCode)
        && candidate.statusCode >= 0
        && candidate.statusCode <= 999
      ) {
        statusCode = candidate.statusCode;
      }
      if (providerMetadata === undefined) {
        if (isObject(candidate.providerMetadata)) {
          providerMetadata = candidate.providerMetadata;
        } else if (isObject(candidate.data)) {
          providerMetadata = isObject(candidate.data.providerMetadata)
            ? candidate.data.providerMetadata
            : isObject(candidate.data.gateway)
              ? { gateway: candidate.data.gateway }
              : undefined;
        }
      }
      candidate = candidate.cause;
    } catch {
      break;
    }
  }
  const parsedRouting = parseGatewayRoutingMetadata(providerMetadata);
  const routing = generationId === undefined || parsedRouting.generationId !== undefined
    ? parsedRouting
    : { ...parsedRouting, generationId };
  const failureSource = error instanceof Error
    ? `${error.name}\u0000${error.message}`
    : typeof error === "string"
      ? error
      : typeof error;
  return {
    failureSha256: createHash("sha256")
      .update(failureSource, "utf8")
      .digest("hex"),
    routing,
    ...(statusCode === undefined ? {} : { statusCode }),
  };
}

async function providerCall<Result>(
  credential: ActiveGatewayCredential,
  operation: (apiKey: string) => Promise<Result>,
): Promise<Result> {
  try {
    return await credential.withApiKey(operation);
  } catch (error) {
    if (
      error instanceof GatewayMediaExecutionError
      && (error.code === "invalid-response" || error.code === "download-failed")
    ) {
      throw error;
    }
    throw new GatewayMediaExecutionError(
      "provider-failed",
      providerFailureReconciliation(error),
    );
  }
}

export interface GatewayMediaService {
  generateImage(
    request: unknown,
    options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
  ): Promise<GatewayMediaArtifactBundle>;
  generateSpeech(
    request: unknown,
    options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
  ): Promise<GatewayMediaArtifactBundle>;
  generateVideo(
    request: unknown,
    options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
  ): Promise<GatewayMediaArtifactBundle>;
  transcribe(
    request: unknown,
    options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
  ): Promise<Readonly<ParsedTranscriptionResult & {
    artifact: GatewayMediaArtifactBundle;
  }>>;
}

export interface GatewayMediaDispatchEvent {
  readonly model: string;
  readonly operation:
    | "image.generate"
    | "speech.generate"
    | "transcription.create"
    | "video.generate";
  readonly startedAt: string;
}

export function createGatewayMediaService(options: Readonly<{
  artifactStore: GatewayMediaArtifactStore;
  catalog: CatalogCache;
  download?: GatewayMediaDownload;
  loadCredential(now: Date): Promise<ActiveGatewayCredential>;
  now?: () => Date;
  onDispatch?: (event: GatewayMediaDispatchEvent) => Promise<void> | void;
  sdk: GatewayMediaSdk;
}>): GatewayMediaService {
  const now = options.now ?? (() => new Date());
  const download = options.download ?? createBoundedGatewayMediaDownload();
  return {
    generateImage: async (requestValue, execution = {}) => {
      const startedAt = now();
      const request = parseImageRequest(requestValue, startedAt);
      const catalog = await modelCatalog(
        options.catalog,
        request.model,
        "image",
        execution.signal,
      );
      const isLanguageImage = catalog.model.executionMode === "language-image";
      if (
        isLanguageImage
        && (
          request.aspectRatio !== undefined
          || request.mask !== undefined
          || request.maxImagesPerCall !== undefined
          || request.n !== undefined
          || request.seed !== undefined
          || request.size !== undefined
        )
      ) {
        throw new GatewayMediaExecutionError("invalid-request");
      }
      if (
        !isLanguageImage
        && (
          request.maxOutputTokens !== undefined
          || request.stopSequences !== undefined
          || request.temperature !== undefined
        )
      ) {
        throw new GatewayMediaExecutionError("invalid-request");
      }
      if (
        isLanguageImage
        && request.images.length > 0
        && !catalog.model.modalities.input.includes("image")
      ) {
        throw new GatewayMediaExecutionError("model-operation-unsupported");
      }
      assertImageCapabilities(catalog.model, request);
      const dispatchAt = now();
      const credential = await options.loadCredential(dispatchAt);
      const timeout = combineAbortSignals(
        execution.signal,
        validateTimeout(execution.timeoutMs, DEFAULT_IMAGE_TIMEOUT_MS),
      );
      try {
        assertProviderDispatchActive(timeout.signal);
        await options.onDispatch?.({
          model: request.model,
          operation: "image.generate",
          startedAt: dispatchAt.toISOString(),
        });
        assertProviderDispatchActive(timeout.signal);
        const result = await settleBeforeAbort(providerCall(credential, async apiKey => {
          assertProviderDispatchActive(timeout.signal);
          if (isLanguageImage) {
            const sdkResult = await options.sdk.generateLanguageImage(apiKey, {
              abortSignal: timeout.signal,
              ...(request.maxOutputTokens === undefined
                ? {}
                : { maxOutputTokens: request.maxOutputTokens }),
              maxRetries: 0,
              ...(request.images.length === 0
                ? { prompt: request.prompt }
                : {
                    messages: [{
                      content: [
                        { text: request.prompt, type: "text" },
                        ...request.images.map(image => ({
                          image: gatewaySdkInput(image),
                          mediaType: image.mediaType,
                          type: "image" as const,
                        })),
                      ],
                      role: "user" as const,
                    }],
                  }),
              modelId: request.model,
              ...(request.providerOptions === undefined
                ? {}
                : { providerOptions: request.providerOptions }),
              ...(request.stopSequences === undefined
                ? {}
                : { stopSequences: request.stopSequences }),
              ...(request.temperature === undefined
                ? {}
                : { temperature: request.temperature }),
            });
            if (!isObject(sdkResult) || !Array.isArray(sdkResult.files)) {
              throw new GatewayMediaExecutionError("invalid-response");
            }
            if (sdkResult.files.length < 1 || sdkResult.files.length > 32) {
              throw new GatewayMediaExecutionError("invalid-response");
            }
            return {
              files: sdkResult.files.map(
                value => parseGeneratedFile(value, ["image/"]),
              ),
              routing: parseGatewayRoutingMetadata(sdkResult.providerMetadata),
              warnings: parseWarnings(sdkResult.warnings),
            };
          }
          const sdkResult = await options.sdk.generateImage(apiKey, {
              abortSignal: timeout.signal,
              ...(request.aspectRatio === undefined
                ? {}
                : { aspectRatio: request.aspectRatio }),
              ...(request.maxImagesPerCall === undefined
                ? {}
                : { maxImagesPerCall: request.maxImagesPerCall }),
              maxRetries: 0,
              modelId: request.model,
              ...(request.n === undefined ? {} : { n: request.n }),
              prompt: request.images.length === 0 && request.mask === undefined
                ? request.prompt
                : {
                    images: request.images.map(gatewaySdkInput),
                    ...(request.mask === undefined
                      ? {}
                      : { mask: gatewaySdkInput(request.mask) }),
                    text: request.prompt,
                  },
              ...(request.providerOptions === undefined
                ? {}
                : { providerOptions: request.providerOptions }),
              ...(request.seed === undefined ? {} : { seed: request.seed }),
              ...(request.size === undefined ? {} : { size: request.size }),
            });
            return parseGeneratedFiles(sdkResult, "images", ["image/"]);
        }), timeout.signal, "provider-failed");
        const inputs = [
          ...request.images.map((input, index) => inputDigest(input, `image.${index + 1}`)),
          ...(request.mask === undefined ? [] : [inputDigest(request.mask, "mask")]),
        ];
        return await options.artifactStore.commit({
          catalog: catalogReceipt(catalog.catalog),
          createdAt: startedAt.toISOString(),
          files: result.files,
          inputs,
          mediaKind: "image",
          model: request.model,
          operation: "image.generate",
          request: requestSummary(cleanSummary({
            aspectRatio: optionalSummaryValue(request.aspectRatio),
            maxImagesPerCall: optionalSummaryValue(request.maxImagesPerCall),
            maxOutputTokens: optionalSummaryValue(request.maxOutputTokens),
            n: optionalSummaryValue(request.n),
            seed: optionalSummaryValue(request.seed),
            size: optionalSummaryValue(request.size),
            stopSequencesCount: request.stopSequences?.length,
            stopSequencesSha256: request.stopSequences === undefined
              ? undefined
              : canonicalJsonSha256(request.stopSequences),
            temperature: optionalSummaryValue(request.temperature),
          }), request.prompt, request.providerOptions),
          routing: result.routing,
          signal: timeout.signal,
          sampleFulfillment: {
            produced: result.files.length,
            requested: request.n ?? 1,
          },
          warnings: result.warnings,
        });
      } finally {
        timeout.dispose();
      }
    },
    generateSpeech: async (requestValue, execution = {}) => {
      const startedAt = now();
      const request = parseSpeechRequest(requestValue, startedAt);
      const catalog = await modelCatalog(
        options.catalog,
        request.model,
        "speech",
        execution.signal,
      );
      const dispatchAt = now();
      const credential = await options.loadCredential(dispatchAt);
      const timeout = combineAbortSignals(
        execution.signal,
        validateTimeout(execution.timeoutMs, DEFAULT_SPEECH_TIMEOUT_MS),
      );
      try {
        assertProviderDispatchActive(timeout.signal);
        await options.onDispatch?.({
          model: request.model,
          operation: "speech.generate",
          startedAt: dispatchAt.toISOString(),
        });
        assertProviderDispatchActive(timeout.signal);
        const result = await settleBeforeAbort(providerCall(credential, async apiKey => {
          assertProviderDispatchActive(timeout.signal);
          const sdkResult = await options.sdk.generateSpeech(apiKey, {
            abortSignal: timeout.signal,
            ...(request.instructions === undefined
              ? {}
              : { instructions: request.instructions }),
            ...(request.language === undefined ? {} : { language: request.language }),
            maxRetries: 0,
            modelId: request.model,
            ...(request.outputFormat === undefined
              ? {}
              : { outputFormat: request.outputFormat }),
            ...(request.providerOptions === undefined
              ? {}
              : { providerOptions: request.providerOptions }),
            ...(request.speed === undefined ? {} : { speed: request.speed }),
            text: request.text,
            ...(request.voice === undefined ? {} : { voice: request.voice }),
          });
          if (!isObject(sdkResult)) {
            throw new GatewayMediaExecutionError("invalid-response");
          }
          return {
            files: [parseGeneratedFile(sdkResult.audio, ["audio/"])],
            routing: parseGatewayRoutingMetadata(sdkResult.providerMetadata),
            warnings: parseWarnings(sdkResult.warnings),
          };
        }), timeout.signal, "provider-failed");
        return await options.artifactStore.commit({
          catalog: catalogReceipt(catalog.catalog),
          createdAt: startedAt.toISOString(),
          files: result.files,
          inputs: [],
          mediaKind: "speech",
          model: request.model,
          operation: "speech.generate",
          request: requestSummary(cleanSummary({
            instructionsCharacters: request.instructions?.length,
            instructionsSha256: request.instructions === undefined
              ? undefined
              : createHash("sha256")
                .update(request.instructions, "utf8")
                .digest("hex"),
            language: optionalSummaryValue(request.language),
            outputFormat: optionalSummaryValue(request.outputFormat),
            speed: optionalSummaryValue(request.speed),
            textCharacters: request.text.length,
            textSha256: createHash("sha256")
              .update(request.text, "utf8")
              .digest("hex"),
            voice: optionalSummaryValue(request.voice),
          }), undefined, request.providerOptions),
          routing: result.routing,
          signal: timeout.signal,
          warnings: result.warnings,
        });
      } finally {
        timeout.dispose();
      }
    },
    generateVideo: async (requestValue, execution = {}) => {
      const startedAt = now();
      const request = parseVideoRequest(requestValue, startedAt);
      const catalog = await modelCatalog(
        options.catalog,
        request.model,
        "video",
        execution.signal,
      );
      assertVideoCapabilities(catalog.model, request);
      const dispatchAt = now();
      const credential = await options.loadCredential(dispatchAt);
      const timeout = combineAbortSignals(
        execution.signal,
        validateTimeout(execution.timeoutMs, DEFAULT_VIDEO_TIMEOUT_MS),
      );
      const requestDownload = createAggregateGatewayMediaDownload(download);
      try {
        assertProviderDispatchActive(timeout.signal);
        await options.onDispatch?.({
          model: request.model,
          operation: "video.generate",
          startedAt: dispatchAt.toISOString(),
        });
        assertProviderDispatchActive(timeout.signal);
        const result = await settleBeforeAbort(providerCall(credential, async apiKey => {
          assertProviderDispatchActive(timeout.signal);
          const sdkResult = await options.sdk.generateVideo(apiKey, {
            abortSignal: timeout.signal,
            ...(request.aspectRatio === undefined
              ? {}
              : { aspectRatio: request.aspectRatio }),
            download: requestDownload,
            ...(request.duration === undefined ? {} : { duration: request.duration }),
            ...(request.fps === undefined ? {} : { fps: request.fps }),
            ...(request.frameImages.length === 0
              ? {}
              : {
                  frameImages: request.frameImages.map(frame => ({
                    frameType: frame.frameType,
                    image: gatewaySdkInput(frame.image),
                  })),
                }),
            ...(request.generateAudio === undefined
              ? {}
              : { generateAudio: request.generateAudio }),
            ...(request.inputReferences.length === 0
              ? {}
              : {
                  inputReferences: request.inputReferences.map(reference => ({
                    data: gatewaySdkInput(reference),
                    mediaType: reference.mediaType,
                  })),
                }),
            maxRetries: 0,
            ...(request.maxVideosPerCall === undefined
              ? {}
              : { maxVideosPerCall: request.maxVideosPerCall }),
            modelId: request.model,
            ...(request.n === undefined ? {} : { n: request.n }),
            prompt: request.promptImage === undefined
              ? request.prompt
              : {
                  image: gatewaySdkInput(request.promptImage),
                  ...(request.prompt.length === 0 ? {} : { text: request.prompt }),
                },
            ...(request.providerOptions === undefined
              ? {}
              : { providerOptions: request.providerOptions }),
            ...(request.resolution === undefined
              ? {}
              : { resolution: request.resolution }),
            ...(request.seed === undefined ? {} : { seed: request.seed }),
          });
          return parseGeneratedFiles(sdkResult, "videos", ["video/"]);
        }), timeout.signal, "provider-failed");
        const inputs = [
          ...(request.promptImage === undefined
            ? []
            : [inputDigest(request.promptImage, "prompt-image")]),
          ...request.frameImages.map((frame, index) => inputDigest(
            frame.image,
            `frame.${index + 1}.${frame.frameType}`,
          )),
          ...request.inputReferences.map((reference, index) => inputDigest(
            reference,
            `reference.${index + 1}`,
          )),
        ];
        return await options.artifactStore.commit({
          catalog: catalogReceipt(catalog.catalog),
          createdAt: startedAt.toISOString(),
          files: result.files,
          inputs,
          mediaKind: "video",
          model: request.model,
          operation: "video.generate",
          request: requestSummary(cleanSummary({
            aspectRatio: optionalSummaryValue(request.aspectRatio),
            duration: optionalSummaryValue(request.duration),
            fps: optionalSummaryValue(request.fps),
            frameTypes: request.frameImages.map(frame => frame.frameType),
            generateAudio: optionalSummaryValue(request.generateAudio),
            maxVideosPerCall: optionalSummaryValue(request.maxVideosPerCall),
            n: optionalSummaryValue(request.n),
            resolution: optionalSummaryValue(request.resolution),
            seed: optionalSummaryValue(request.seed),
          }), request.prompt, request.providerOptions),
          routing: result.routing,
          signal: timeout.signal,
          sampleFulfillment: {
            produced: result.files.length,
            requested: request.n ?? 1,
          },
          warnings: result.warnings,
        });
      } finally {
        timeout.dispose();
      }
    },
    transcribe: async (requestValue, execution = {}) => {
      const startedAt = now();
      const request = parseTranscriptionRequest(requestValue, startedAt);
      const catalog = await modelCatalog(
        options.catalog,
        request.model,
        "transcription",
        execution.signal,
      );
      if (catalog.model.tags.includes("websocket-realtime")) {
        throw new GatewayMediaExecutionError("model-operation-unsupported");
      }
      const dispatchAt = now();
      const credential = await options.loadCredential(dispatchAt);
      const timeout = combineAbortSignals(
        execution.signal,
        validateTimeout(execution.timeoutMs, DEFAULT_TRANSCRIPTION_TIMEOUT_MS),
      );
      try {
        assertProviderDispatchActive(timeout.signal);
        await options.onDispatch?.({
          model: request.model,
          operation: "transcription.create",
          startedAt: dispatchAt.toISOString(),
        });
        assertProviderDispatchActive(timeout.signal);
        const result = await settleBeforeAbort(providerCall(credential, async apiKey => {
          assertProviderDispatchActive(timeout.signal);
          const sdkResult = await options.sdk.transcribe(apiKey, {
            abortSignal: timeout.signal,
            audio: request.audio.data,
            maxRetries: 0,
            modelId: request.model,
            ...(request.providerOptions === undefined
              ? {}
              : { providerOptions: request.providerOptions }),
          });
          return parseTranscriptionResult(sdkResult);
        }), timeout.signal, "provider-failed");
        const artifact = await options.artifactStore.commit({
          catalog: catalogReceipt(catalog.catalog),
          createdAt: startedAt.toISOString(),
          files: transcriptFiles(result),
          inputs: [inputDigest(request.audio, "audio")],
          mediaKind: "transcription",
          model: request.model,
          operation: "transcription.create",
          request: requestSummary({}, undefined, request.providerOptions),
          routing: result.routing,
          signal: timeout.signal,
          warnings: result.warnings,
        });
        return { ...result, artifact };
      } finally {
        timeout.dispose();
      }
    },
  };
}

export const GATEWAY_MEDIA_ENDPOINTS = {
  catalog: GATEWAY_MEDIA_CATALOG_URL,
  media: GATEWAY_MEDIA_API_BASE_URL,
} as const;
