import {
  canonicalJson,
  canonicalJsonSha256,
} from "../core/canonical-json";
import type {
  GatewayJsonValue,
  GatewayMediaExecutionMode,
  GatewayMediaModel,
} from "./gateway-media-catalog";

export type GatewayProviderOptions = Readonly<
  Record<string, Readonly<Record<string, GatewayJsonValue>>>
>;

const MAXIMUM_PROVIDER_OPTIONS_BYTES = 64 * 1024;
const MAXIMUM_PROVIDER_OPTIONS_DEPTH = 16;
const MAXIMUM_PROVIDER_OPTIONS_NODES = 4_096;
const MAXIMUM_PROVIDER_NAMESPACES = 64;

export type GatewayProviderHintModel = Pick<
  GatewayMediaModel,
  "executionMode" | "id" | "kind"
>;

export interface GatewayProviderParameterHints {
  readonly common: readonly string[];
  readonly providerOptions: Readonly<Record<string, readonly string[]>>;
  readonly rawProviderOptions: Readonly<{
    readonly flag: "--provider-options <json-file>";
    readonly maximumBytes: number;
    readonly policy: "bounded nested JSON; unknown and future fields pass through";
  }>;
}

interface ProviderNamespaceHint {
  readonly fields: readonly string[];
  readonly namespace: string;
}

const COMMON_PARAMETERS: Readonly<
  Record<GatewayMediaExecutionMode, readonly string[]>
> = {
  "image-model": [
    "prompt",
    "images",
    "mask",
    "n",
    "maxImagesPerCall",
    "size",
    "aspectRatio",
    "seed",
    "timeout",
    "allowCloudUpload",
  ],
  "language-image": [
    "prompt",
    "images",
    "maxOutputTokens",
    "temperature",
    "stopSequences",
    "timeout",
    "allowCloudUpload",
  ],
  "speech-model": [
    "text",
    "voice",
    "outputFormat",
    "instructions",
    "speed",
    "language",
    "timeout",
  ],
  "transcription-model": [
    "audio",
    "timeout",
    "allowCloudAudioUpload",
  ],
  "video-model": [
    "prompt",
    "image",
    "frameImages",
    "inputReferences",
    "n",
    "maxVideosPerCall",
    "aspectRatio",
    "resolution",
    "duration",
    "fps",
    "seed",
    "generateAudio",
    "timeout",
    "allowCloudUpload",
  ],
};

const GATEWAY_ROUTING_FIELDS = [
  "order",
  "only",
  "sort",
  "user",
  "tags",
  "byok",
  "zeroDataRetention",
  "disallowPromptTraining",
  "quotaEntityId",
  "has",
  "providerTimeouts",
  "serviceTier",
  "caching",
] as const;

const VIDEO_PROVIDER_HINTS: Readonly<
  Record<string, ProviderNamespaceHint>
> = {
  alibaba: {
    fields: [
      "negativePrompt",
      "audioUrl",
      "promptExtend",
      "shotType",
      "watermark",
      "audio",
      "referenceUrls",
      "media",
      "ratio",
      "pollIntervalMs",
      "pollTimeoutMs",
    ],
    namespace: "alibaba",
  },
  bytedance: {
    fields: [
      "watermark",
      "generateAudio",
      "cameraFixed",
      "returnLastFrame",
      "serviceTier",
      "draft",
      "lastFrameImage",
      "referenceImages",
      "referenceVideos",
      "referenceAudio",
      "pollIntervalMs",
      "pollTimeoutMs",
    ],
    namespace: "bytedance",
  },
  google: {
    fields: [
      "enhancePrompt",
      "negativePrompt",
      "personGeneration",
      "compressionQuality",
      "seed",
      "generateAudio",
      "gcsOutputDirectory",
      "referenceImages",
      "resizeMode",
      "pollIntervalMs",
      "pollTimeoutMs",
    ],
    namespace: "vertex",
  },
  klingai: {
    fields: [
      "mode",
      "negativePrompt",
      "sound",
      "cfgScale",
      "cameraControl",
      "multiShot",
      "shotType",
      "multiPrompt",
      "voiceList",
      "elementList",
      "imageTail",
      "staticMask",
      "dynamicMasks",
      "videoUrl",
      "characterOrientation",
      "keepOriginalSound",
      "watermarkEnabled",
      "pollIntervalMs",
      "pollTimeoutMs",
    ],
    namespace: "klingai",
  },
  xai: {
    fields: [
      "pollIntervalMs",
      "pollTimeoutMs",
      "resolution",
      "user",
      "mode",
      "videoUrl",
      "referenceImageUrls",
    ],
    namespace: "xai",
  },
};

const IMAGE_PROVIDER_HINTS: Readonly<
  Record<string, ProviderNamespaceHint>
> = {
  bfl: {
    fields: [
      "width",
      "height",
      "outputFormat",
      "steps",
      "guidance",
      "imagePrompt",
      "imagePromptStrength",
      "promptUpsampling",
      "raw",
      "safetyTolerance",
      "pollIntervalMillis",
      "pollTimeoutMillis",
      "webhookUrl",
      "webhookSecret",
    ],
    namespace: "blackForestLabs",
  },
  bytedance: {
    fields: [
      "watermark",
      "outputFormat",
      "size",
      "sequentialImageGeneration",
      "optimizePromptMode",
    ],
    namespace: "bytedance",
  },
  google: {
    fields: [
      "negativePrompt",
      "personGeneration",
      "safetySetting",
      "addWatermark",
      "storageUri",
      "sampleImageSize",
    ],
    namespace: "vertex",
  },
  openai: {
    fields: [
      "quality",
      "background",
      "outputFormat",
      "outputCompression",
      "user",
      "style",
      "moderation",
      "inputFidelity",
    ],
    namespace: "openai",
  },
  prodia: {
    fields: [
      "steps",
      "width",
      "height",
      "stylePreset",
      "loras",
      "progressive",
    ],
    namespace: "prodia",
  },
  quiverai: {
    fields: [
      "operation",
      "instructions",
      "temperature",
      "topP",
      "presencePenalty",
      "maxOutputTokens",
      "autoCrop",
      "targetSize",
    ],
    namespace: "quiverai",
  },
  recraft: {
    fields: ["*"],
    namespace: "recraft",
  },
  xai: {
    fields: [
      "resolution",
      "quality",
      "aspect_ratio",
      "output_format",
      "sync_mode",
      "user",
    ],
    namespace: "xai",
  },
};

const LANGUAGE_IMAGE_PROVIDER_HINTS: Readonly<
  Record<string, ProviderNamespaceHint>
> = {
  google: {
    fields: [
      "responseModalities",
      "imageConfig",
      "imageConfig.aspectRatio",
      "imageConfig.imageSize",
    ],
    namespace: "google",
  },
};

const SPEECH_PROVIDER_HINTS: Readonly<
  Record<string, ProviderNamespaceHint>
> = {
  openai: {
    fields: ["instructions", "response_format", "speed"],
    namespace: "openai",
  },
  xai: {
    fields: [
      "sampleRate",
      "bitRate",
      "optimizeStreamingLatency",
      "textNormalization",
    ],
    namespace: "xai",
  },
};

const TRANSCRIPTION_PROVIDER_HINTS: Readonly<
  Record<string, ProviderNamespaceHint>
> = {
  openai: {
    fields: [
      "include",
      "language",
      "prompt",
      "temperature",
      "timestampGranularities",
      "streaming",
    ],
    namespace: "openai",
  },
  xai: {
    fields: [
      "audioFormat",
      "sampleRate",
      "language",
      "format",
      "multichannel",
      "channels",
      "diarize",
      "keyterm",
      "fillerWords",
      "streaming",
    ],
    namespace: "xai",
  },
};

const RAW_PROVIDER_OPTIONS_HINT = {
  flag: "--provider-options <json-file>",
  maximumBytes: MAXIMUM_PROVIDER_OPTIONS_BYTES,
  policy: "bounded nested JSON; unknown and future fields pass through",
} as const;

function modelProvider(modelId: string): string {
  return modelId.slice(0, modelId.indexOf("/")).toLocaleLowerCase("en-US");
}

function providerHintForModel(
  model: GatewayProviderHintModel,
): ProviderNamespaceHint | undefined {
  const provider = modelProvider(model.id);
  switch (model.executionMode) {
    case "image-model":
      return IMAGE_PROVIDER_HINTS[provider];
    case "language-image":
      return LANGUAGE_IMAGE_PROVIDER_HINTS[provider];
    case "speech-model":
      return SPEECH_PROVIDER_HINTS[provider];
    case "transcription-model":
      return TRANSCRIPTION_PROVIDER_HINTS[provider];
    case "video-model":
      return VIDEO_PROVIDER_HINTS[provider];
  }
}

/**
 * Returns a compact, model-aware parameter vocabulary for agent discovery.
 * These are hints, not an allowlist: execution still forwards any bounded
 * provider-options JSON so new Gateway fields do not require a CLI release.
 */
export function gatewayProviderParameterHints(
  model: GatewayProviderHintModel,
): GatewayProviderParameterHints {
  const provider = providerHintForModel(model);
  return {
    common: COMMON_PARAMETERS[model.executionMode],
    providerOptions: provider === undefined
      ? { gateway: GATEWAY_ROUTING_FIELDS }
      : {
          gateway: GATEWAY_ROUTING_FIELDS,
          [provider.namespace]: provider.fields,
        },
    rawProviderOptions: RAW_PROVIDER_OPTIONS_HINT,
  };
}

export class GatewayProviderOptionsError extends Error {
  constructor(
    message = "Gateway provider options must be bounded nested JSON objects.",
  ) {
    super(message);
    this.name = "GatewayProviderOptionsError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseKey(value: string): string {
  const normalized = value
    .replaceAll("_", "")
    .replaceAll("-", "")
    .toLocaleLowerCase("en-US");
  if (
    normalized === "samplecount"
    || normalized === "maximages"
    || normalized === "numimages"
    || normalized === "numvideos"
    || normalized === "numberofimages"
    || normalized === "numberofvideos"
  ) {
    throw new GatewayProviderOptionsError(
      `Provider option ${value} is not supported; use the first-class count parameter so catalog limits and receipts remain accurate.`,
    );
  }
  if (
    value.length < 1
    || value.length > 128
    || [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
    || value === "__proto__"
    || value === "constructor"
    || value === "prototype"
  ) {
    throw new GatewayProviderOptionsError();
  }
  return value;
}

interface ParseBudget {
  nodes: number;
}

function parseJsonValue(
  value: unknown,
  budget: ParseBudget,
  depth: number,
): GatewayJsonValue {
  budget.nodes += 1;
  if (
    budget.nodes > MAXIMUM_PROVIDER_OPTIONS_NODES
    || depth > MAXIMUM_PROVIDER_OPTIONS_DEPTH
  ) {
    throw new GatewayProviderOptionsError();
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new GatewayProviderOptionsError();
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") {
    if (
      value.length > 16_384
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
      throw new GatewayProviderOptionsError();
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 1_024) throw new GatewayProviderOptionsError();
    return value.map(item => parseJsonValue(item, budget, depth + 1));
  }
  if (!isRecord(value) || Object.keys(value).length > 1_024) {
    throw new GatewayProviderOptionsError();
  }
  const parsed: Record<string, GatewayJsonValue> = Object.create(null) as Record<
    string,
    GatewayJsonValue
  >;
  for (const [key, item] of Object.entries(value)) {
    parsed[parseKey(key)] = parseJsonValue(item, budget, depth + 1);
  }
  return parsed;
}

export function parseGatewayProviderOptions(
  value: unknown,
): GatewayProviderOptions {
  if (!isRecord(value) || Object.keys(value).length > MAXIMUM_PROVIDER_NAMESPACES) {
    throw new GatewayProviderOptionsError();
  }
  const parsed: Record<string, Readonly<Record<string, GatewayJsonValue>>> =
    Object.create(null) as Record<
      string,
      Readonly<Record<string, GatewayJsonValue>>
    >;
  const budget = { nodes: 0 };
  for (const [namespace, options] of Object.entries(value)) {
    if (!isRecord(options)) throw new GatewayProviderOptionsError();
    parsed[parseKey(namespace)] = parseJsonValue(
      options,
      budget,
      1,
    ) as Readonly<Record<string, GatewayJsonValue>>;
  }
  if (
    new TextEncoder().encode(canonicalJson(parsed)).byteLength
    > MAXIMUM_PROVIDER_OPTIONS_BYTES
  ) {
    throw new GatewayProviderOptionsError();
  }
  if (
    parsed.gateway !== undefined
    && Object.hasOwn(parsed.gateway, "models")
  ) {
    throw new GatewayProviderOptionsError(
      "Gateway model fallbacks are not supported for paid media jobs because each fallback requires independent catalog validation and durable accounting.",
    );
  }
  return parsed;
}

export function gatewayProviderOptionsSummary(
  value: GatewayProviderOptions,
): Readonly<{
  namespaces: readonly string[];
  sha256: string;
}> {
  return {
    namespaces: Object.keys(value).sort(),
    sha256: canonicalJsonSha256(value),
  };
}
