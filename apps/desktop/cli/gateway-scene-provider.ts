import type { z } from "zod";

import {
  GeneratedSceneBatchSchema,
  redactedSceneProviderError,
  SceneProviderError,
  SCENE_SYSTEM_PROMPT,
  type SceneApiDescription,
  type SceneDescriptionProvider,
  type SceneProviderRequest,
  type SceneProviderResult,
  validateSceneProviderRequest,
} from "@hraness/atet/scene";

import type { ActiveGatewayCredential } from "./gateway-credential";

export const VERCEL_SCENE_GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v4/ai";

const GATEWAY_ORIGIN = "https://ai-gateway.vercel.sh";
const MAXIMUM_GATEWAY_RESPONSE_BYTES = 4_000_000;
const DEFAULT_SCENE_GATEWAY_TIMEOUT_MS = 120_000;
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

type GatewayFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface AiSdkResult {
  readonly output?: unknown;
  readonly response?: unknown;
  readonly usage?: unknown;
}

export interface SceneAiSdkModule {
  readonly Output: {
    object(input: {
      readonly description: string;
      readonly name: string;
      readonly schema: z.ZodType;
    }): unknown;
  };
  createGateway(settings: {
    readonly apiKey: string;
    readonly baseURL: string;
    readonly fetch: GatewayFetch;
  }): { languageModel(model: string): unknown };
  generateText(options: Readonly<Record<string, unknown>>): Promise<AiSdkResult>;
}

export type SceneAiSdkLoader = () => Promise<SceneAiSdkModule>;

async function loadAiSdk(): Promise<SceneAiSdkModule> {
  const [gatewayValue, aiValue]: readonly unknown[] = await Promise.all([
    import("@ai-sdk/gateway-v4"),
    import("ai-v7"),
  ]);
  if (
    typeof gatewayValue !== "object"
    || gatewayValue === null
    || !("createGateway" in gatewayValue)
    || typeof gatewayValue.createGateway !== "function"
    || typeof aiValue !== "object"
    || aiValue === null
    || !("generateText" in aiValue)
    || typeof aiValue.generateText !== "function"
    || !("Output" in aiValue)
    || typeof aiValue.Output !== "object"
    || aiValue.Output === null
    || !("object" in aiValue.Output)
    || typeof aiValue.Output.object !== "function"
  ) {
    throw new Error("The AI SDK scene provider is unavailable.");
  }
  return {
    Output: aiValue.Output as SceneAiSdkModule["Output"],
    createGateway: gatewayValue.createGateway as SceneAiSdkModule["createGateway"],
    generateText: aiValue.generateText as SceneAiSdkModule["generateText"],
  };
}

function requestUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") return new URL(input);
  return new URL(input instanceof URL ? input.href : input.url);
}

function base64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  let chunk = "";
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const value = (bytes[index]! << 16)
      | (bytes[index + 1]! << 8)
      | bytes[index + 2]!;
    chunk += BASE64_ALPHABET.charAt((value >>> 18) & 63)
      + BASE64_ALPHABET.charAt((value >>> 12) & 63)
      + BASE64_ALPHABET.charAt((value >>> 6) & 63)
      + BASE64_ALPHABET.charAt(value & 63);
    if (chunk.length >= 16_384) {
      chunks.push(chunk);
      chunk = "";
    }
  }
  const remaining = bytes.length - index;
  if (remaining === 1) {
    const value = bytes[index]! << 16;
    chunk += BASE64_ALPHABET.charAt((value >>> 18) & 63)
      + BASE64_ALPHABET.charAt((value >>> 12) & 63)
      + "==";
  } else if (remaining === 2) {
    const value = (bytes[index]! << 16) | (bytes[index + 1]! << 8);
    chunk += BASE64_ALPHABET.charAt((value >>> 18) & 63)
      + BASE64_ALPHABET.charAt((value >>> 12) & 63)
      + BASE64_ALPHABET.charAt((value >>> 6) & 63)
      + "=";
  }
  chunks.push(chunk);
  return chunks.join("");
}

export function sceneFrameDataUrl(
  mediaType: "image/jpeg" | "image/png" | "image/webp",
  bytes: Uint8Array,
): string {
  return `data:${mediaType};base64,${base64(bytes)}`;
}

async function boundedResponse(response: Response): Promise<Response> {
  if (response.redirected || (response.status >= 300 && response.status < 400)) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("Scene Gateway redirects are forbidden.");
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (Number.isFinite(parsed) && parsed > MAXIMUM_GATEWAY_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Scene Gateway response exceeded its byte bound.");
    }
  }
  if (response.body === null) return response;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytesRead += next.value.byteLength;
      if (bytesRead > MAXIMUM_GATEWAY_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Scene Gateway response exceeded its byte bound.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export function createFixedSceneGatewayFetch(
  upstream: GatewayFetch = globalThis.fetch,
): GatewayFetch {
  return async (input, init) => {
    const url = requestUrl(input);
    if (
      url.origin !== GATEWAY_ORIGIN
      || url.username !== ""
      || url.password !== ""
      || (url.pathname !== "/v4/ai" && !url.pathname.startsWith("/v4/ai/"))
    ) {
      throw new Error("Scene Gateway request target is forbidden.");
    }
    const base = input instanceof Request
      ? new Request(url.href, input)
      : new Request(url.href);
    const canonicalRequest = new Request(base, { ...init, redirect: "error" });
    return await boundedResponse(await upstream(canonicalRequest));
  };
}

function userMessage(request: SceneProviderRequest): Readonly<Record<string, unknown>> {
  const content: Readonly<Record<string, unknown>>[] = [{
    text: `Describe exactly ${request.scenes.length} scenes. Frames within each scene are chronological.`,
    type: "text",
  }];
  for (const scene of request.scenes) {
    content.push({ text: `Scene ${scene.sceneId} begins.`, type: "text" });
    for (const [index, frame] of scene.frames.entries()) {
      content.push({
        text: `Frame ${index + 1} at ${frame.actualAssetTimeUs} microseconds.`,
        type: "text",
      });
      content.push({
        image: sceneFrameDataUrl(frame.mediaType, frame.bytes),
        mediaType: frame.mediaType,
        type: "image",
      });
    }
    content.push({ text: `Scene ${scene.sceneId} ends.`, type: "text" });
  }
  return { content, role: "user" };
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function tokenCount(value: unknown, key: "inputTokens" | "outputTokens"): number {
  const selected = record(value)?.[key];
  return Number.isSafeInteger(selected) && (selected as number) >= 0
    ? selected as number
    : 0;
}

function resolvedModel(value: unknown): string | null {
  const modelId = record(value)?.modelId;
  return typeof modelId === "string"
    && modelId.length >= 1
    && modelId.length <= 256
    && ![...modelId].some(character => (character.codePointAt(0) ?? 0) <= 31)
    ? modelId
    : null;
}

export function parseSceneProviderOutput(
  request: SceneProviderRequest,
  value: unknown,
): readonly SceneApiDescription[] {
  const parsed = GeneratedSceneBatchSchema.safeParse(value);
  if (!parsed.success) throw new SceneProviderError("invalid-response");
  const expectedIds = new Set(request.scenes.map(scene => scene.sceneId));
  const returnedIds = new Set<string>();
  const descriptions: SceneApiDescription[] = [];
  for (const scene of parsed.data.scenes) {
    if (!expectedIds.has(scene.sceneId) || returnedIds.has(scene.sceneId)) {
      throw new SceneProviderError("invalid-response");
    }
    returnedIds.add(scene.sceneId);
    descriptions.push({
      description: { ...scene.description, trust: "untrusted-model-output" },
      sceneId: scene.sceneId,
    });
  }
  if (returnedIds.size !== expectedIds.size) {
    throw new SceneProviderError("invalid-response");
  }
  const bySceneId = new Map(descriptions.map(item => [item.sceneId, item]));
  return request.scenes.map((scene) => {
    const description = bySceneId.get(scene.sceneId);
    if (description === undefined) throw new SceneProviderError("invalid-response");
    return description;
  });
}

export interface GatewaySceneProviderOptions {
  readonly credential: ActiveGatewayCredential;
  readonly fetch?: GatewayFetch;
  readonly loadAiSdk?: SceneAiSdkLoader;
  readonly timeoutMs?: number;
}

function boundedTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_SCENE_GATEWAY_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new SceneProviderError("invalid-request");
  }
  return timeoutMs;
}

function disableAiSdkWarningLogging(): void {
  (
    globalThis as typeof globalThis & {
      AI_SDK_LOG_WARNINGS?: false;
    }
  ).AI_SDK_LOG_WARNINGS = false;
}

function assertSceneDispatchActive(signal: AbortSignal): void {
  if (signal.aborted) throw new SceneProviderError("aborted");
}

function callerSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function createGatewaySceneProvider(
  options: GatewaySceneProviderOptions,
): SceneDescriptionProvider {
  const loader = options.loadAiSdk ?? loadAiSdk;
  const gatewayFetch = createFixedSceneGatewayFetch(options.fetch ?? globalThis.fetch);
  const timeoutMs = boundedTimeout(options.timeoutMs);
  return {
    describe: async (requestInput, signal): Promise<SceneProviderResult> => {
      const request = validateSceneProviderRequest(requestInput);
      let dispatched = false;
      let timedOut = false;
      const controller = new AbortController();
      const abortFromCaller = (): void => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abortFromCaller, { once: true });
      if (callerSignalAborted(signal)) {
        signal?.removeEventListener("abort", abortFromCaller);
        throw new SceneProviderError("aborted");
      }
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const interrupted = new Promise<never>((_resolve, reject) => {
        const rejectInterrupted = (): void => reject(
          dispatched
            ? new SceneProviderError(
                timedOut ? "gateway-outcome-unknown" : "aborted",
                "ambiguous",
              )
            : new SceneProviderError(
                timedOut ? "gateway-unavailable" : "aborted",
              ),
        );
        controller.signal.addEventListener("abort", rejectInterrupted, { once: true });
        if (controller.signal.aborted) rejectInterrupted();
      });
      try {
        const operation = (async (): Promise<SceneProviderResult> => {
          disableAiSdkWarningLogging();
          const ai = await loader();
          assertSceneDispatchActive(controller.signal);
          return await options.credential.withApiKey(async (apiKey) => {
            assertSceneDispatchActive(controller.signal);
            const gateway = ai.createGateway({
              apiKey,
              baseURL: VERCEL_SCENE_GATEWAY_BASE_URL,
              fetch: gatewayFetch,
            });
            const output = ai.Output.object({
              description: "One bounded, observable description for every supplied scene identifier.",
              name: "atet_scene_descriptions",
              schema: GeneratedSceneBatchSchema,
            });
            assertSceneDispatchActive(controller.signal);
            dispatched = true;
            const result: AiSdkResult = await ai.generateText({
              abortSignal: controller.signal,
              maxOutputTokens: 4_096,
              maxRetries: 0,
              messages: [userMessage(request)],
              model: gateway.languageModel(request.model),
              output,
              providerOptions: {
                gateway: {
                  disallowPromptTraining: true,
                  tags: ["atet", "scene-analysis", "v1"],
                  zeroDataRetention: true,
                },
              },
              system: SCENE_SYSTEM_PROMPT,
              temperature: 0,
            });
            return {
              descriptions: parseSceneProviderOutput(request, result.output),
              resolvedModel: resolvedModel(result.response),
              usage: {
                inputTokens: tokenCount(result.usage, "inputTokens"),
                outputTokens: tokenCount(result.usage, "outputTokens"),
                uploadedBytes: request.imageBytes,
                uploadedImages: request.imageCount,
              },
            };
          });
        })();
        return await Promise.race([operation, interrupted]);
      } catch (error) {
        throw redactedSceneProviderError(error, dispatched);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abortFromCaller);
      }
    },
  };
}
