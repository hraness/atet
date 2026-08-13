import { describe, expect, test } from "bun:test";

import {
  gatewayProviderParameterHints,
  gatewayProviderOptionsSummary,
  parseGatewayProviderOptions,
} from "./gateway-provider-options";
import type {
  GatewayMediaExecutionMode,
  GatewayMediaKind,
} from "./gateway-media-catalog";

function hintModel(
  id: string,
  kind: GatewayMediaKind,
  executionMode: GatewayMediaExecutionMode,
) {
  return { executionMode, id, kind };
}

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

describe("Gateway provider options", () => {
  test("preserves arbitrary bounded nested JSON and produces a deterministic secret-free summary", () => {
    const parsed = parseGatewayProviderOptions({
      google: {
        imageConfig: {
          aspectRatio: "16:9",
          imageSize: "4K",
          nested: [{ enabled: true }, null, 3.5],
        },
      },
      xai: {
        pollIntervalMs: 1_000,
        raw: { futureParameter: "supported without a client release" },
      },
    });
    expect(parsed).toEqual({
      google: {
        imageConfig: {
          aspectRatio: "16:9",
          imageSize: "4K",
          nested: [{ enabled: true }, null, 3.5],
        },
      },
      xai: {
        pollIntervalMs: 1_000,
        raw: { futureParameter: "supported without a client release" },
      },
    });
    const summary = gatewayProviderOptionsSummary(parsed);
    expect(summary.namespaces).toEqual(["google", "xai"]);
    expect(summary.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(summary)).not.toContain("futureParameter");
    expect(gatewayProviderOptionsSummary(parseGatewayProviderOptions({
      xai: parsed.xai,
      google: parsed.google,
    }))).toEqual(summary);
  });

  test("rejects non-object namespaces, dangerous keys, excessive depth, and excessive bytes", () => {
    expect(() => parseGatewayProviderOptions({ xai: 3 })).toThrow("bounded nested JSON");
    expect(() => parseGatewayProviderOptions(JSON.parse(
      '{"xai":{"__proto__":{"polluted":true}}}',
    ))).toThrow("bounded nested JSON");
    let nested: unknown = true;
    for (let index = 0; index < 20; index += 1) nested = { nested };
    expect(() => parseGatewayProviderOptions({ xai: nested })).toThrow("bounded nested JSON");
    expect(() => parseGatewayProviderOptions({
      xai: { prompt: "x".repeat(70 * 1024) },
    })).toThrow("bounded nested JSON");
    for (const options of [
      { vertex: { sampleCount: 2 } },
      { bytedance: { maxImages: 4 } },
      { future: { nested: { number_of_videos: 3 } } },
    ]) {
      expect(() => parseGatewayProviderOptions(options))
        .toThrow("first-class count");
    }
    expect(() => parseGatewayProviderOptions({
      gateway: { models: ["fallback/model"] },
    })).toThrow("model fallbacks");
  });

  test("discovers every generic request parameter by media execution mode", () => {
    expect(gatewayProviderParameterHints(
      hintModel("openai/gpt-image-1", "image", "image-model"),
    ).common).toEqual([
      "prompt", "images", "mask", "n", "maxImagesPerCall", "size",
      "aspectRatio", "seed", "timeout", "allowCloudUpload",
    ]);
    expect(gatewayProviderParameterHints(
      hintModel("google/gemini-3.1-flash-image", "image", "language-image"),
    ).common).toEqual([
      "prompt", "images", "maxOutputTokens", "temperature", "stopSequences",
      "timeout", "allowCloudUpload",
    ]);
    expect(gatewayProviderParameterHints(
      hintModel("google/veo-3.1-generate-001", "video", "video-model"),
    ).common).toEqual([
      "prompt", "image", "frameImages", "inputReferences", "n",
      "maxVideosPerCall", "aspectRatio", "resolution", "duration", "fps",
      "seed", "generateAudio", "timeout", "allowCloudUpload",
    ]);
    expect(gatewayProviderParameterHints(
      hintModel("xai/grok-tts", "speech", "speech-model"),
    ).common).toEqual([
      "text", "voice", "outputFormat", "instructions", "speed", "language",
      "timeout",
    ]);
    expect(gatewayProviderParameterHints(
      hintModel("xai/grok-stt", "transcription", "transcription-model"),
    ).common).toEqual(["audio", "timeout", "allowCloudAudioUpload"]);
  });

  test("selects the complete video provider vocabulary without unrelated namespaces", () => {
    const cases = [
      {
        fields: [
          "enhancePrompt", "negativePrompt", "personGeneration",
          "compressionQuality", "seed", "generateAudio",
          "gcsOutputDirectory", "referenceImages", "resizeMode",
          "pollIntervalMs", "pollTimeoutMs",
        ],
        id: "google/veo-3.1-generate-001",
        namespace: "vertex",
      },
      {
        fields: [
          "mode", "negativePrompt", "sound", "cfgScale", "cameraControl",
          "multiShot", "shotType", "multiPrompt", "voiceList", "elementList",
          "imageTail", "staticMask", "dynamicMasks", "videoUrl",
          "characterOrientation", "keepOriginalSound", "watermarkEnabled",
          "pollIntervalMs", "pollTimeoutMs",
        ],
        id: "klingai/kling-v3.0-i2v",
        namespace: "klingai",
      },
      {
        fields: [
          "negativePrompt", "audioUrl", "promptExtend", "shotType",
          "watermark", "audio", "referenceUrls", "media", "ratio",
          "pollIntervalMs", "pollTimeoutMs",
        ],
        id: "alibaba/wan-v2.7-r2v",
        namespace: "alibaba",
      },
      {
        fields: [
          "watermark", "generateAudio", "cameraFixed", "returnLastFrame",
          "serviceTier", "draft", "lastFrameImage", "referenceImages",
          "referenceVideos", "referenceAudio", "pollIntervalMs",
          "pollTimeoutMs",
        ],
        id: "bytedance/seedance-2.0",
        namespace: "bytedance",
      },
      {
        fields: [
          "pollIntervalMs", "pollTimeoutMs", "resolution", "user", "mode",
          "videoUrl", "referenceImageUrls",
        ],
        id: "xai/grok-imagine-video",
        namespace: "xai",
      },
    ] as const;
    for (const item of cases) {
      const options = gatewayProviderParameterHints(
        hintModel(item.id, "video", "video-model"),
      ).providerOptions;
      expect(options).toEqual({
        gateway: GATEWAY_ROUTING_FIELDS,
        [item.namespace]: item.fields,
      });
    }
  });

  test("selects all current image provider vocabularies, including language-image mode", () => {
    const cases = [
      ["openai/gpt-image-1.5", "openai", [
        "quality", "background", "outputFormat", "outputCompression", "user",
        "style", "moderation", "inputFidelity",
      ]],
      ["bfl/flux-2-pro", "blackForestLabs", [
        "width", "height", "outputFormat", "steps", "guidance",
        "imagePrompt", "imagePromptStrength", "promptUpsampling", "raw",
        "safetyTolerance", "pollIntervalMillis", "pollTimeoutMillis",
        "webhookUrl", "webhookSecret",
      ]],
      ["google/imagen-4.0-generate-001", "vertex", [
        "negativePrompt", "personGeneration", "safetySetting", "addWatermark",
        "storageUri", "sampleImageSize",
      ]],
      ["bytedance/seedream-5.0-pro", "bytedance", [
        "watermark", "outputFormat", "size", "sequentialImageGeneration",
        "optimizePromptMode",
      ]],
      ["xai/grok-imagine-image", "xai", [
        "resolution", "quality", "aspect_ratio", "output_format", "sync_mode",
        "user",
      ]],
      ["prodia/flux-fast-schnell", "prodia", [
        "steps", "width", "height", "stylePreset", "loras", "progressive",
      ]],
      ["quiverai/arrow-1.1", "quiverai", [
        "operation", "instructions", "temperature", "topP", "presencePenalty",
        "maxOutputTokens", "autoCrop", "targetSize",
      ]],
      ["recraft/recraft-v4.1", "recraft", ["*"]],
    ] as const;
    for (const [id, namespace, fields] of cases) {
      expect(gatewayProviderParameterHints(
        hintModel(id, "image", "image-model"),
      ).providerOptions).toEqual({
        gateway: GATEWAY_ROUTING_FIELDS,
        [namespace]: fields,
      });
    }
    expect(gatewayProviderParameterHints(
      hintModel("google/gemini-3.1-flash-image", "image", "language-image"),
    ).providerOptions).toEqual({
      gateway: GATEWAY_ROUTING_FIELDS,
      google: [
        "responseModalities", "imageConfig", "imageConfig.aspectRatio",
        "imageConfig.imageSize",
      ],
    });
  });

  test("discovers speech and transcription options and keeps a raw escape hatch", () => {
    expect(gatewayProviderParameterHints(
      hintModel("openai/tts-1", "speech", "speech-model"),
    ).providerOptions).toEqual({
      gateway: GATEWAY_ROUTING_FIELDS,
      openai: ["instructions", "response_format", "speed"],
    });
    expect(gatewayProviderParameterHints(
      hintModel("xai/grok-tts", "speech", "speech-model"),
    ).providerOptions.xai).toEqual([
      "sampleRate", "bitRate", "optimizeStreamingLatency", "textNormalization",
    ]);
    expect(gatewayProviderParameterHints(
      hintModel("openai/gpt-4o-transcribe", "transcription", "transcription-model"),
    ).providerOptions.openai).toEqual([
      "include", "language", "prompt", "temperature",
      "timestampGranularities", "streaming",
    ]);
    const xai = gatewayProviderParameterHints(
      hintModel("xai/grok-stt", "transcription", "transcription-model"),
    );
    expect(xai.providerOptions.xai).toEqual([
      "audioFormat", "sampleRate", "language", "format", "multichannel",
      "channels", "diarize", "keyterm", "fillerWords", "streaming",
    ]);
    expect(xai.rawProviderOptions).toEqual({
      flag: "--provider-options <json-file>",
      maximumBytes: 64 * 1024,
      policy: "bounded nested JSON; unknown and future fields pass through",
    });
  });

  test("unknown providers retain Gateway routing and raw options instead of guessing", () => {
    const hints = gatewayProviderParameterHints(
      hintModel("future/video-model", "video", "video-model"),
    );
    expect(hints.providerOptions).toEqual({ gateway: GATEWAY_ROUTING_FIELDS });
    expect(hints.rawProviderOptions.maximumBytes).toBe(64 * 1024);
  });
});
