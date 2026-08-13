import { describe, expect, test } from "bun:test";

import { ActiveGatewayCredential } from "./gateway-credential";
import type {
  GatewayMediaArtifactBundle,
  GatewayMediaArtifactStore,
  GatewayMediaReceipt,
} from "./gateway-media-artifacts";
import {
  parseGatewayMediaCatalog,
  type GatewayMediaCatalogView,
} from "./gateway-media-catalog";
import {
  createAiSdkGatewayMediaSdk,
  createAggregateGatewayMediaDownload,
  createBoundedGatewayMediaDownload,
  createFixedGatewayMediaApiFetch,
  createGatewayMediaService,
  GATEWAY_MEDIA_API_BASE_URL,
  GATEWAY_MEDIA_UPLOAD_POLICY,
  GatewayMediaExecutionError,
  LEGACY_GATEWAY_MEDIA_UPLOAD_POLICY,
  type GatewayAiSdkRuntime,
  type GatewayMediaSdk,
  type GatewayMediaDispatchEvent,
  type GatewayMediaFetch,
  type GatewaySdkImageRequest,
  type GatewaySdkLanguageImageRequest,
  type GatewaySdkSpeechRequest,
  type GatewaySdkTranscriptionRequest,
  type GatewaySdkVideoRequest,
} from "./gateway-media-service";

const NOW = new Date("2026-07-23T12:00:00.000Z");
const API_KEY = "vck_gateway_secret_that_must_never_leak_12345";
const consent = {
  acknowledgedAt: NOW.toISOString(),
  allowCloudUpload: true,
  policy: GATEWAY_MEDIA_UPLOAD_POLICY,
} as const;
const PNG_BYTES = Uint8Array.of(
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
);
const JPEG_BYTES = Uint8Array.of(0xff, 0xd8, 0xff);
const WEBP_BYTES = new TextEncoder().encode("RIFFxxxxWEBP");
const MP4_BYTES = Uint8Array.of(
  0x00, 0x00, 0x00, 0x0c,
  0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d,
);
const MP3_BYTES = new TextEncoder().encode("ID3");
const WAV_BYTES = new TextEncoder().encode("RIFFxxxxWAVE");

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise rejection.");
}

function deferred<Value>(): Readonly<{
  promise: Promise<Value>;
  resolve(value: Value): void;
}> {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  };
}

function row(
  type: "image" | "language" | "speech" | "transcription" | "video",
  id: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    created: 1,
    description: id,
    id,
    modalities: {
      input: type === "transcription" ? ["audio"] : ["text"],
      output: type === "image"
        ? ["image"]
        : type === "video"
          ? ["video"]
          : type === "speech"
            ? ["audio"]
            : ["text"],
    },
    name: id,
    owned_by: id.split("/")[0],
    pricing: {},
    type,
    ...overrides,
  };
}

function catalogViewFromRows(
  rows: readonly Readonly<Record<string, unknown>>[],
): GatewayMediaCatalogView {
  return {
    snapshot: parseGatewayMediaCatalog({
      data: rows,
    }, { fetchedAt: NOW.toISOString() }),
    source: "memory",
    status: "fresh",
  };
}

function catalogView(): GatewayMediaCatalogView {
  return catalogViewFromRows([
        row("image", "bfl/flux"),
        row("language", "google/gemini-image", {
          modalities: { input: ["text", "image"], output: ["text", "image"] },
          tags: ["image-generation", "vision"],
        }),
        row("speech", "openai/tts"),
        row("transcription", "openai/whisper"),
        row("transcription", "openai/gpt-realtime-whisper", {
          tags: ["websocket-realtime", "websocket-transcription"],
        }),
        row("video", "google/veo"),
  ]);
}

function activeCredential(): ActiveGatewayCredential {
  return new ActiveGatewayCredential("AI_GATEWAY_API_KEY", API_KEY);
}

class CapturingArtifactStore implements GatewayMediaArtifactStore {
  readonly calls: Parameters<GatewayMediaArtifactStore["commit"]>[0][] = [];

  commit(
    input: Parameters<GatewayMediaArtifactStore["commit"]>[0],
  ): Promise<GatewayMediaArtifactBundle> {
    this.calls.push(input);
    const receipt: GatewayMediaReceipt = {
      catalog: input.catalog,
      createdAt: input.createdAt,
      inputs: input.inputs,
      kind: "studio.gateway-media-receipt",
      localValidation: {
        decodeValidatedOutputs: input.files.length,
        signatureOnlyOutputs: 0,
        status: "decode-passed",
      },
      model: input.model,
      nextCommands: [],
      operation: input.operation,
      outputs: [],
      request: input.request,
      routing: input.routing,
      ...(input.sampleFulfillment === undefined
        ? {}
        : {
            sampleFulfillment: {
              ...input.sampleFulfillment,
              status: input.sampleFulfillment.produced
                === input.sampleFulfillment.requested
                ? "complete"
                : input.sampleFulfillment.produced
                    < input.sampleFulfillment.requested
                  ? "partial"
                  : "overproduced",
            },
          }),
      schemaVersion: 1,
      warnings: input.warnings,
    };
    return Promise.resolve({
      directory: "/generated/run",
      outputs: [],
      receipt,
      receiptPath: "/generated/run/receipt.json",
    });
  }
}

class DeadlineBoundArtifactStore extends CapturingArtifactStore {
  activeCommits = 0;
  readonly started: Promise<void>;
  #startedResolve: (() => void) | undefined;

  constructor() {
    super();
    this.started = new Promise<void>((resolve) => {
      this.#startedResolve = resolve;
    });
  }

  override commit(
    input: Parameters<GatewayMediaArtifactStore["commit"]>[0],
  ): Promise<GatewayMediaArtifactBundle> {
    this.calls.push(input);
    this.activeCommits += 1;
    this.#startedResolve?.();
    return new Promise((_resolve, reject) => {
      let active = true;
      const abort = (): void => {
        if (!active) return;
        active = false;
        this.activeCommits -= 1;
        reject(new Error("artifact commit deadline reached"));
      };
      if (input.signal.aborted) abort();
      else input.signal.addEventListener("abort", abort, { once: true });
    });
  }
}

class CapturingSdk implements GatewayMediaSdk {
  imageFailure: unknown = undefined;
  imageNeverSettles = false;
  imageMediaType = "image/png";
  readonly imageCalls: GatewaySdkImageRequest[] = [];
  readonly languageImageCalls: GatewaySdkLanguageImageRequest[] = [];
  readonly speechCalls: GatewaySdkSpeechRequest[] = [];
  readonly transcriptionCalls: GatewaySdkTranscriptionRequest[] = [];
  speechMediaType = "audio/mpeg";
  readonly videoCalls: GatewaySdkVideoRequest[] = [];
  videoMediaType = "video/mp4";
  throwWithSecret = false;

  generateImage(apiKey: string, request: GatewaySdkImageRequest): Promise<unknown> {
    if (this.imageNeverSettles) return new Promise(() => undefined);
    if (this.imageFailure !== undefined) {
      return Promise.reject(
        this.imageFailure instanceof Error
          ? this.imageFailure
          : new Error("Non-error image failure."),
      );
    }
    if (this.throwWithSecret) return Promise.reject(new Error(`bad ${apiKey}`));
    this.imageCalls.push(request);
    return Promise.resolve({
      images: [{
        mediaType: this.imageMediaType,
        uint8Array: PNG_BYTES,
      }],
      warnings: [{
        message: `warning accidentally contained ${apiKey}; draw a clean diagram; must not enter the receipt`,
        type: "unsupported-setting",
      }],
    });
  }

  generateLanguageImage(
    _apiKey: string,
    request: GatewaySdkLanguageImageRequest,
  ): Promise<unknown> {
    this.languageImageCalls.push(request);
    return Promise.resolve({
      files: [{
        mediaType: "image/png",
        uint8Array: PNG_BYTES,
      }],
      warnings: [],
    });
  }

  generateSpeech(
    _apiKey: string,
    request: GatewaySdkSpeechRequest,
  ): Promise<unknown> {
    this.speechCalls.push(request);
    return Promise.resolve({
      audio: {
        mediaType: this.speechMediaType,
        uint8Array: MP3_BYTES,
      },
      warnings: [],
    });
  }

  generateVideo(
    _apiKey: string,
    request: GatewaySdkVideoRequest,
  ): Promise<unknown> {
    this.videoCalls.push(request);
    return Promise.resolve({
      videos: [{
        mediaType: this.videoMediaType,
        uint8Array: MP4_BYTES,
      }],
      warnings: [],
    });
  }

  transcribe(
    _apiKey: string,
    request: GatewaySdkTranscriptionRequest,
  ): Promise<unknown> {
    this.transcriptionCalls.push(request);
    return Promise.resolve({
      durationInSeconds: 2,
      language: "en",
      segments: [{ endSecond: 2, startSecond: 0, text: "hello" }],
      text: "hello",
      warnings: [],
    });
  }
}

function testService(options: Readonly<{
  artifactStore?: CapturingArtifactStore;
  catalog?: GatewayMediaCatalogView;
  catalogCalls?: { value: number };
  credentialCalls?: { value: number };
  credentialTimes?: Date[];
  dispatchEvents?: GatewayMediaDispatchEvent[];
  loadCredential?: (credentialAt: Date) => Promise<ActiveGatewayCredential>;
  now?: () => Date;
  onDispatch?: (event: GatewayMediaDispatchEvent) => Promise<void> | void;
  sdk?: CapturingSdk;
}> = {}) {
  const artifactStore = options.artifactStore ?? new CapturingArtifactStore();
  const sdk = options.sdk ?? new CapturingSdk();
  const catalog = options.catalog ?? catalogView();
  const service = createGatewayMediaService({
    artifactStore,
    catalog: {
      get: () => {
        if (options.catalogCalls !== undefined) options.catalogCalls.value += 1;
        return Promise.resolve(catalog);
      },
    },
    download: () => Promise.resolve({
      data: Uint8Array.of(1),
      mediaType: "video/mp4",
    }),
    loadCredential: options.loadCredential ?? ((credentialAt) => {
      if (options.credentialCalls !== undefined) options.credentialCalls.value += 1;
      options.credentialTimes?.push(credentialAt);
      return Promise.resolve(activeCredential());
    }),
    now: options.now ?? (() => NOW),
    ...(options.onDispatch !== undefined
      ? { onDispatch: options.onDispatch }
      : options.dispatchEvents === undefined
        ? {}
        : {
            onDispatch: (event: GatewayMediaDispatchEvent) => {
              options.dispatchEvents?.push(event);
            },
          }),
    sdk,
  });
  return { artifactStore, sdk, service };
}

describe("Gateway media execution service", () => {
  test("forwards every AI SDK image parameter exactly and redacts credentials from receipts", async () => {
    const { artifactStore, sdk, service } = testService();
    await service.generateImage({
      aspectRatio: "16:9",
      consent: {
        ...consent,
        policy: LEGACY_GATEWAY_MEDIA_UPLOAD_POLICY,
      },
      images: [{ data: PNG_BYTES, mediaType: "image/png" }],
      mask: { data: PNG_BYTES, mediaType: "image/png" },
      maxImagesPerCall: 2,
      model: "bfl/flux",
      n: 2,
      prompt: "draw a clean diagram",
      providerOptions: {
        blackForestLabs: {
          future: { nested: [true, 3, "value"] },
          secretLookingValue: "must not enter the receipt",
        },
      },
      seed: 42,
    });

    expect(sdk.imageCalls).toHaveLength(1);
    expect(sdk.imageCalls[0]).toMatchObject({
      aspectRatio: "16:9",
      maxImagesPerCall: 2,
      maxRetries: 0,
      modelId: "bfl/flux",
      n: 2,
      prompt: {
        images: [PNG_BYTES],
        mask: PNG_BYTES,
        text: "draw a clean diagram",
      },
      providerOptions: {
        blackForestLabs: {
          future: { nested: [true, 3, "value"] },
          secretLookingValue: "must not enter the receipt",
        },
      },
      seed: 42,
    });
    expect(sdk.imageCalls[0]?.abortSignal).toBeInstanceOf(AbortSignal);
    const artifactCall = artifactStore.calls[0];
    expect(artifactCall?.warnings).toHaveLength(1);
    expect(artifactCall?.warnings[0]).toMatch(
      /^unsupported-setting sha256:[a-f0-9]{64}$/u,
    );
    expect(JSON.stringify(artifactCall)).not.toContain(API_KEY);
    expect(JSON.stringify(artifactCall)).not.toContain("draw a clean diagram");
    expect(JSON.stringify(artifactCall)).not.toContain("must not enter the receipt");
    expect(artifactCall?.request).toMatchObject({
      aspectRatio: "16:9",
      maxImagesPerCall: 2,
      n: 2,
      providerNamespaces: ["blackForestLabs"],
      seed: 42,
    });
  });

  test("keeps the request deadline active through a non-settling artifact commit", async () => {
    const artifactStore = new DeadlineBoundArtifactStore();
    const { service } = testService({ artifactStore });
    const pending = service.generateImage({
      consent,
      model: "bfl/flux",
      prompt: "deadline-bound artifact validation",
    }, { timeoutMs: 1_000 });

    await artifactStore.started;
    expect(await rejection(pending)).toMatchObject({
      message: "artifact commit deadline reached",
    });
    expect(artifactStore.calls).toHaveLength(1);
    expect(artifactStore.calls[0]?.signal.aborted).toBe(true);
    expect(artifactStore.activeCommits).toBe(0);
  });

  test("cancellation during a delayed dispatch hook prevents every paid media SDK call", async () => {
    const invocations: readonly Readonly<{
      invoke(
        service: ReturnType<typeof createGatewayMediaService>,
        signal: AbortSignal,
      ): Promise<unknown>;
      operation: GatewayMediaDispatchEvent["operation"];
    }>[] = [
      {
        invoke: (service, signal) => service.generateImage({
          consent,
          model: "bfl/flux",
          prompt: "cancel before image dispatch",
        }, { signal }),
        operation: "image.generate",
      },
      {
        invoke: (service, signal) => service.generateSpeech({
          consent,
          model: "openai/tts",
          text: "cancel before speech dispatch",
        }, { signal }),
        operation: "speech.generate",
      },
      {
        invoke: (service, signal) => service.generateVideo({
          consent,
          model: "google/veo",
          prompt: "cancel before video dispatch",
        }, { signal }),
        operation: "video.generate",
      },
      {
        invoke: (service, signal) => service.transcribe({
          audio: { data: WAV_BYTES, mediaType: "audio/wav" },
          consent,
          model: "openai/whisper",
        }, { signal }),
        operation: "transcription.create",
      },
    ];

    for (const invocation of invocations) {
      const entered = deferred<void>();
      const release = deferred<void>();
      const controller = new AbortController();
      const sdk = new CapturingSdk();
      const { service } = testService({
        onDispatch: async (event) => {
          expect(event.operation).toBe(invocation.operation);
          entered.resolve(undefined);
          await release.promise;
        },
        sdk,
      });
      const pending = invocation.invoke(service, controller.signal);
      await entered.promise;
      controller.abort(new Error("cancelled while dispatch receipt was pending"));
      release.resolve(undefined);

      expect(await rejection(pending)).toMatchObject({ code: "provider-failed" });
      expect([
        ...sdk.imageCalls,
        ...sdk.languageImageCalls,
        ...sdk.speechCalls,
        ...sdk.transcriptionCalls,
        ...sdk.videoCalls,
      ]).toHaveLength(0);
    }
  });

  test("cancellation during credential loading prevents dispatch hooks and paid SDK calls", async () => {
    const credentialStarted = deferred<void>();
    const releaseCredential = deferred<ActiveGatewayCredential>();
    const controller = new AbortController();
    const sdk = new CapturingSdk();
    let dispatches = 0;
    const { service } = testService({
      loadCredential: () => {
        credentialStarted.resolve(undefined);
        return releaseCredential.promise;
      },
      onDispatch: () => {
        dispatches += 1;
      },
      sdk,
    });
    const pending = service.generateImage({
      consent,
      model: "bfl/flux",
      prompt: "cancel while loading the credential",
    }, { signal: controller.signal });
    await credentialStarted.promise;
    controller.abort(new Error("cancelled while credential loading was pending"));
    releaseCredential.resolve(activeCredential());

    expect(await rejection(pending)).toMatchObject({ code: "provider-failed" });
    expect(dispatches).toBe(0);
    expect(sdk.imageCalls).toHaveLength(0);
  });

  test("forwards public HTTPS media inputs without persisting their URLs", async () => {
    const artifactStore = new CapturingArtifactStore();
    const { sdk, service } = testService({ artifactStore });
    const imageUrl = "https://cdn.example/source.png?signature=image-secret";
    const maskUrl = "https://cdn.example/mask.png?signature=mask-secret";
    await service.generateImage({
      consent,
      images: [{ mediaType: "image/png", url: imageUrl }],
      mask: { mediaType: "image/png", url: maskUrl },
      model: "bfl/flux",
      prompt: "remote edit",
    });
    expect(sdk.imageCalls[0]?.prompt).toEqual({
      images: [imageUrl],
      mask: maskUrl,
      text: "remote edit",
    });

    const firstFrameUrl =
      "https://cdn.example/first.png?signature=first-secret";
    const lastFrameUrl =
      "https://cdn.example/last.png?signature=last-secret";
    await service.generateVideo({
      consent,
      frameImages: [
        {
          frameType: "first",
          image: { mediaType: "image/png", url: firstFrameUrl },
        },
        {
          frameType: "last",
          image: { mediaType: "image/png", url: lastFrameUrl },
        },
      ],
      model: "google/veo",
      prompt: "remote frames",
    });
    const videoReferenceUrl =
      "https://cdn.example/source.mp4?signature=video-secret";
    await service.generateVideo({
      consent,
      inputReferences: [{
        mediaType: "video/mp4",
        url: videoReferenceUrl,
      }],
      model: "google/veo",
      prompt: "remote reference",
    });
    expect(sdk.videoCalls[0]?.frameImages).toEqual([
      { frameType: "first_frame", image: firstFrameUrl },
      { frameType: "last_frame", image: lastFrameUrl },
    ]);
    expect(sdk.videoCalls[1]?.inputReferences).toEqual([{
      data: videoReferenceUrl,
      mediaType: "video/mp4",
    }]);
    const durable = JSON.stringify(artifactStore.calls);
    for (const url of [
      imageUrl,
      maskUrl,
      firstFrameUrl,
      lastFrameUrl,
      videoReferenceUrl,
    ]) {
      expect(durable).not.toContain(url);
    }
    expect(artifactStore.calls.flatMap(call => call.inputs).every(
      input => input.source === "url" && input.bytes === 0,
    )).toBe(true);
  });

  test("executes tagged language-model image generators through generateText files", async () => {
    const artifactStore = new CapturingArtifactStore();
    const { sdk, service } = testService({ artifactStore });
    await service.generateImage({
      consent,
      images: [{ data: JPEG_BYTES, mediaType: "image/jpeg" }],
      maxOutputTokens: 2_048,
      model: "google/gemini-image",
      prompt: "edit this image",
      providerOptions: {
        google: {
          imageConfig: { aspectRatio: "16:9", imageSize: "4K" },
        },
      },
      stopSequences: ["done"],
      temperature: 0.7,
    });

    expect(sdk.imageCalls).toHaveLength(0);
    expect(sdk.languageImageCalls).toHaveLength(1);
    expect(sdk.languageImageCalls[0]).toMatchObject({
      maxOutputTokens: 2_048,
      maxRetries: 0,
      messages: [{
        content: [
          { text: "edit this image", type: "text" },
          {
            image: JPEG_BYTES,
            mediaType: "image/jpeg",
            type: "image",
          },
        ],
        role: "user",
      }],
      modelId: "google/gemini-image",
      providerOptions: {
        google: {
          imageConfig: { aspectRatio: "16:9", imageSize: "4K" },
        },
      },
      stopSequences: ["done"],
      temperature: 0.7,
    });
  });

  test("forwards the complete AI SDK 7 video request surface", async () => {
    const { sdk, service } = testService();
    await service.generateVideo({
      aspectRatio: "16:9",
      consent,
      duration: 8,
      fps: 24,
      generateAudio: true,
      inputReferences: [
        { data: WEBP_BYTES, mediaType: "image/webp" },
        { data: MP4_BYTES, mediaType: "video/mp4" },
      ],
      maxVideosPerCall: 3,
      model: "google/veo",
      n: 3,
      prompt: "camera orbit",
      promptImage: { data: PNG_BYTES, mediaType: "image/png" },
      providerOptions: {
        google: {
          negativePrompt: "blur",
          personGeneration: "allow_adult",
        },
      },
      resolution: "4k",
      seed: 99,
    });

    expect(sdk.videoCalls).toHaveLength(1);
    expect(sdk.videoCalls[0]).toMatchObject({
      aspectRatio: "16:9",
      duration: 8,
      fps: 24,
      generateAudio: true,
      inputReferences: [
        { data: WEBP_BYTES, mediaType: "image/webp" },
        { data: MP4_BYTES, mediaType: "video/mp4" },
      ],
      maxRetries: 0,
      maxVideosPerCall: 3,
      modelId: "google/veo",
      n: 3,
      prompt: { image: PNG_BYTES, text: "camera orbit" },
      providerOptions: {
        google: {
          negativePrompt: "blur",
          personGeneration: "allow_adult",
        },
      },
      resolution: "4k",
      seed: 99,
    });
    expect(typeof sdk.videoCalls[0]?.download).toBe("function");

    await service.generateVideo({
      consent,
      frameImages: [
        {
          frameType: "first",
          image: { data: PNG_BYTES, mediaType: "image/png" },
        },
        {
          frameType: "last",
          image: { data: JPEG_BYTES, mediaType: "image/jpeg" },
        },
      ],
      model: "google/veo",
      prompt: "",
    });
    expect(sdk.videoCalls[1]).toMatchObject({
      frameImages: [
        { frameType: "first_frame", image: PNG_BYTES },
        { frameType: "last_frame", image: JPEG_BYTES },
      ],
      maxRetries: 0,
      modelId: "google/veo",
      prompt: "",
    });
  });

  test("forwards every speech setting and transcribes bounded audio", async () => {
    const artifactStore = new CapturingArtifactStore();
    const { sdk, service } = testService({ artifactStore });
    await service.generateSpeech({
      consent,
      instructions: "Speak clearly.",
      language: "en",
      model: "openai/tts",
      outputFormat: "mp3",
      providerOptions: { openai: { responseFormat: "mp3" } },
      speed: 1.25,
      text: "Hello",
      voice: "alloy",
    });
    expect(sdk.speechCalls[0]).toMatchObject({
      instructions: "Speak clearly.",
      language: "en",
      maxRetries: 0,
      modelId: "openai/tts",
      outputFormat: "mp3",
      providerOptions: { openai: { responseFormat: "mp3" } },
      speed: 1.25,
      text: "Hello",
      voice: "alloy",
    });

    const result = await service.transcribe({
      audio: { data: WAV_BYTES, mediaType: "audio/wav" },
      consent,
      model: "openai/whisper",
      providerOptions: { openai: { language: "en", temperature: 0 } },
    });
    expect(sdk.transcriptionCalls[0]).toMatchObject({
      audio: WAV_BYTES,
      maxRetries: 0,
      modelId: "openai/whisper",
      providerOptions: { openai: { language: "en", temperature: 0 } },
    });
    expect(result).toMatchObject({
      durationInSeconds: 2,
      language: "en",
      segments: [{ endSecond: 2, startSecond: 0, text: "hello" }],
      text: "hello",
    });
    const transcriptFiles = artifactStore.calls.at(-1)?.files;
    expect(transcriptFiles?.map(file => file.mediaType)).toEqual([
      "application/json",
      "text/plain",
      "application/x-subrip",
      "text/vtt",
    ]);
    const decode = (index: number) => new TextDecoder().decode(
      transcriptFiles?.[index]?.uint8Array,
    );
    expect(decode(1)).toBe("hello\n");
    expect(decode(2)).toBe("1\n00:00:00,000 --> 00:00:02,000\nhello\n");
    expect(decode(3)).toBe("WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nhello\n");
  });

  test("escapes subtitle structure while preserving the canonical transcript", async () => {
    const artifactStore = new CapturingArtifactStore();
    const sdk = new CapturingSdk();
    sdk.transcribe = (_apiKey, request) => {
      sdk.transcriptionCalls.push(request);
      return Promise.resolve({
        durationInSeconds: 2,
        language: "en",
        segments: [{
          endSecond: 2,
          startSecond: 0,
          text: "line one\n<cue>&\u0001",
        }],
        text: "line one\n<cue>&\u0001",
        warnings: [],
      });
    };
    const { service } = testService({ artifactStore, sdk });
    await service.transcribe({
      audio: { data: WAV_BYTES, mediaType: "audio/wav" },
      consent,
      model: "openai/whisper",
    });
    const files = artifactStore.calls[0]?.files;
    const text = new TextDecoder().decode(files?.[1]?.uint8Array);
    const srt = new TextDecoder().decode(files?.[2]?.uint8Array);
    const vtt = new TextDecoder().decode(files?.[3]?.uint8Array);
    expect(text).toBe("line one\n<cue>&\u0001\n");
    expect(srt).toBe(
      "1\n00:00:00,000 --> 00:00:02,000\nline one &lt;cue&gt;&amp; \n",
    );
    expect(vtt).toBe(
      "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nline one &lt;cue&gt;&amp; \n",
    );
  });

  test("rejects missing consent, wrong model kinds, and excessive inputs before credential or provider access", async () => {
    const catalogCalls = { value: 0 };
    const credentialCalls = { value: 0 };
    const { sdk, service } = testService({ catalogCalls, credentialCalls });
    expect(await rejection(service.generateImage({
      model: "bfl/flux",
      prompt: "no consent",
    }))).toMatchObject({ code: "cloud-consent-required" });
    expect(catalogCalls.value).toBe(0);
    expect(await rejection(service.generateVideo({
      consent,
      model: "bfl/flux",
      prompt: "wrong kind",
    }))).toMatchObject({ code: "model-kind-mismatch" });
    expect(credentialCalls.value).toBe(0);
    expect(await rejection(service.generateImage({
      consent,
      images: Array.from({ length: 33 }, () => ({
        data: Uint8Array.of(1),
        mediaType: "image/png",
      })),
      model: "bfl/flux",
      prompt: "too many",
    }))).toMatchObject({ code: "invalid-request" });
    expect(await rejection(service.generateVideo({
      consent,
      frameImages: [{
        frameType: "first",
        image: { data: Uint8Array.of(1), mediaType: "image/png" },
      }],
      inputReferences: [{
        data: Uint8Array.of(2),
        mediaType: "image/png",
      }],
      model: "google/veo",
      prompt: "",
    }))).toMatchObject({ code: "invalid-request" });
    expect(await rejection(service.generateVideo({
      consent,
      frameImages: [
        {
          frameType: "first",
          image: { data: Uint8Array.of(1), mediaType: "image/png" },
        },
        {
          frameType: "first_frame",
          image: { data: Uint8Array.of(2), mediaType: "image/png" },
        },
      ],
      model: "google/veo",
      prompt: "",
    }))).toMatchObject({ code: "invalid-request" });
    expect(await rejection(service.transcribe({
      audio: { data: WAV_BYTES, mediaType: "audio/wav" },
      consent,
      model: "openai/gpt-realtime-whisper",
    }))).toMatchObject({ code: "model-operation-unsupported" });
    expect(sdk.imageCalls).toHaveLength(0);
    expect(sdk.transcriptionCalls).toHaveLength(0);
  });

  test("enforces live model capabilities before credential access or SDK dispatch", async () => {
    const capabilityCatalog = catalogViewFromRows([
      row("video", "strict/video", {
        modalities: {
          input: ["text", "image", "audio", "video"],
          output: ["video"],
        },
        video_capabilities: {
          generate_audio: false,
          input_limits: {
            image: {
              max_count: 2,
              max_dimension_pixels: 2_048,
              max_file_size_mb: 1,
              max_aspect_ratio: "2:1",
              min_dimension_pixels: 64,
              min_aspect_ratio: "1:2",
              supported_formats: ["png"],
              supported_sources: ["BASE64"],
            },
            max_total_inputs: 2,
            text: { max_chars: 64 },
          },
          max_sample_count: 2,
          supported_aspect_ratios: ["16:9"],
          supported_durations_seconds: [4, 8],
          supported_fps: [24, 30],
          supported_operations: ["text-to-video", "image-to-video"],
          supported_resolutions: ["1080p", "4k"],
        },
      }),
    ]);
    const credentialCalls = { value: 0 };
    const { sdk, service } = testService({
      catalog: capabilityCatalog,
      credentialCalls,
    });
    const validImage = {
      data: PNG_BYTES,
      facts: { height: 1_024, width: 1_024 },
      mediaType: "image/png",
    };
    const invalidRequests = [
      { duration: 6 },
      { fps: 60 },
      { generateAudio: true },
      { resolution: "8k" },
      { aspectRatio: "4:3" },
      { n: 3, maxVideosPerCall: 3 },
      {
        promptImage: {
          ...validImage,
          facts: { height: 32, width: 32 },
        },
      },
      {
        promptImage: {
          data: PNG_BYTES,
          mediaType: "image/png",
        },
      },
      {
        promptImage: {
          ...validImage,
          data: JPEG_BYTES,
          mediaType: "image/jpeg",
        },
      },
    ] as const;
    for (const request of invalidRequests) {
      expect(await rejection(service.generateVideo({
        consent,
        model: "strict/video",
        prompt: "bounded request",
        ...request,
      }))).toMatchObject({ code: "model-operation-unsupported" });
    }
    expect(credentialCalls.value).toBe(0);
    expect(sdk.videoCalls).toHaveLength(0);

    const urlOnlyCatalog = catalogViewFromRows([
      row("video", "url-only/video", {
        video_capabilities: {
          input_limits: {
            image: {
              supported_formats: ["png"],
              supported_sources: ["url"],
            },
          },
          supported_operations: ["image-to-video"],
        },
      }),
    ]);
    const urlOnly = testService({
      catalog: urlOnlyCatalog,
      credentialCalls,
      sdk,
    }).service;
    expect(await rejection(urlOnly.generateVideo({
      consent,
      model: "url-only/video",
      prompt: "inline is unsupported",
      promptImage: validImage,
    }))).toMatchObject({ code: "model-operation-unsupported" });
    const remoteUrl = "https://cdn.example/frame.png?signature=secret";
    const remoteBundle = await urlOnly.generateVideo({
      consent,
      model: "url-only/video",
      prompt: "remote source",
      promptImage: {
        mediaType: "image/png",
        url: remoteUrl,
      },
    });
    expect(credentialCalls.value).toBe(1);
    expect(sdk.videoCalls).toHaveLength(1);
    expect(sdk.videoCalls[0]?.prompt).toEqual({
      image: remoteUrl,
      text: "remote source",
    });
    expect(remoteBundle.receipt.inputs).toMatchObject([{
      bytes: 0,
      mediaType: "image/png",
      role: "prompt-image",
      source: "url",
    }]);
    expect(remoteBundle.receipt.inputs[0]?.sha256)
      .toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(remoteBundle.receipt)).not.toContain(remoteUrl);
    expect(await rejection(urlOnly.generateVideo({
      consent,
      model: "url-only/video",
      prompt: "unsafe remote source",
      promptImage: {
        mediaType: "image/png",
        url: "https://127.0.0.1/private.png",
      },
    }))).toMatchObject({ code: "invalid-request" });
  });

  test("accepts normalized capabilities and records explicit partial sample fulfillment", async () => {
    const catalog = catalogViewFromRows([
      row("video", "strict/video", {
        video_capabilities: {
          generate_audio: false,
          input_limits: {
            image: {
              max_count: 1,
              max_dimension_pixels: 2_048,
              min_dimension_pixels: 64,
              supported_formats: ["png"],
              supported_sources: ["base64"],
            },
          },
          max_sample_count: 2,
          supported_durations_seconds: [8],
          supported_fps: [24],
          supported_operations: ["image-to-video"],
          supported_resolutions: ["4k"],
        },
      }),
    ]);
    const artifactStore = new CapturingArtifactStore();
    const { sdk, service } = testService({ artifactStore, catalog });
    const bundle = await service.generateVideo({
      consent,
      duration: 8,
      fps: 24,
      generateAudio: false,
      maxVideosPerCall: 2,
      model: "strict/video",
      n: 2,
      prompt: "normalized resolution",
      promptImage: {
        data: PNG_BYTES,
        facts: { height: 1_024, width: 1_024 },
        mediaType: "image/png",
      },
      resolution: "4K",
    });
    expect(sdk.videoCalls).toHaveLength(1);
    expect(bundle.receipt.sampleFulfillment).toEqual({
      produced: 1,
      requested: 2,
      status: "partial",
    });
    expect(artifactStore.calls[0]?.sampleFulfillment).toEqual({
      produced: 1,
      requested: 2,
    });
  });

  test("rejects ambiguous frame shapes and implicit multi-call batching before catalog access", async () => {
    const catalogCalls = { value: 0 };
    const credentialCalls = { value: 0 };
    const { sdk, service } = testService({ catalogCalls, credentialCalls });
    expect(await rejection(service.generateVideo({
      consent,
      frameImages: [{
        frameType: "last",
        image: { data: JPEG_BYTES, mediaType: "image/jpeg" },
      }],
      model: "google/veo",
      prompt: "",
    }))).toMatchObject({ code: "invalid-request" });
    expect(await rejection(service.generateImage({
      consent,
      model: "bfl/flux",
      n: 2,
      prompt: "would otherwise fan out",
    }))).toMatchObject({ code: "invalid-request" });
    expect(await rejection(service.generateVideo({
      consent,
      maxVideosPerCall: 1,
      model: "google/veo",
      n: 2,
      prompt: "would otherwise fan out",
    }))).toMatchObject({ code: "invalid-request" });
    expect(catalogCalls.value).toBe(0);
    expect(credentialCalls.value).toBe(0);
    expect(sdk.imageCalls).toHaveLength(0);
    expect(sdk.videoCalls).toHaveLength(0);
  });

  test("wraps provider failures without reflecting key material", async () => {
    const sdk = new CapturingSdk();
    sdk.throwWithSecret = true;
    const { service } = testService({ sdk });
    let error: unknown;
    try {
      await service.generateImage({
        consent,
        model: "bfl/flux",
        prompt: "fail",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "provider-failed" });
    expect(String(error)).not.toContain(API_KEY);
  });

  test("hard-settles a non-cooperative SDK at the request deadline", async () => {
    const sdk = new CapturingSdk();
    sdk.imageNeverSettles = true;
    const startedAt = performance.now();
    expect(await rejection(testService({ sdk }).service.generateImage({
      consent,
      model: "bfl/flux",
      prompt: "never settles",
    }, { timeoutMs: 1_000 }))).toMatchObject({ code: "provider-failed" });
    expect(performance.now() - startedAt).toBeLessThan(2_500);
  });

  test("persists bounded reconciliation metadata for failed paid dispatches", async () => {
    const sdk = new CapturingSdk();
    sdk.imageFailure = Object.assign(
      new Error(`provider body contained ${API_KEY}`),
      {
        generationId: `generation_${API_KEY}`,
        providerMetadata: {
          gateway: {
            attempts: Array.from({ length: 40 }, (_, index) => ({
              error: `provider secret error ${index}`,
              credentialType: API_KEY,
              model: `model-${index}-${API_KEY}`,
              provider: `provider-${index}-${API_KEY}`,
              statusCode: 503,
              success: false,
            })),
            provider: `gateway-router-${API_KEY}`,
          },
        },
        statusCode: 503,
      },
    );
    const error = await rejection(testService({ sdk }).service.generateImage({
      consent,
      model: "bfl/flux",
      prompt: "fail with reconciliation",
    }));
    expect(error).toMatchObject({
      code: "provider-failed",
      reconciliation: {
        routing: {
          attemptCount: 40,
          attemptsTruncated: true,
          clientMaxRetries: 0,
          generationId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
          gatewayProviderFailover: "may-attempt-multiple-providers",
          providerCount: 33,
          providersTruncated: true,
        },
        statusCode: 503,
      },
    });
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain("provider secret error");
    if (
      !(error instanceof GatewayMediaExecutionError)
      || error.reconciliation === undefined
    ) {
      throw new Error("Expected a Gateway reconciliation error.");
    }
    const reconciliation = error.reconciliation;
    expect(reconciliation.failureSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(reconciliation.routing.attempts).toHaveLength(32);
    expect(reconciliation.routing.attempts[0]?.error)
      .toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(reconciliation.routing.attempts[0]?.credentialType).toBeUndefined();
    expect(reconciliation.routing.attempts[0]?.model)
      .toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(reconciliation.routing.attempts[0]?.provider)
      .toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(reconciliation.routing.providers).toHaveLength(32);
  });

  test("rejects successful provider bodies whose media kind is wrong", async () => {
    const imageSdk = new CapturingSdk();
    imageSdk.imageMediaType = "text/html";
    expect(await rejection(testService({ sdk: imageSdk }).service.generateImage({
      consent,
      model: "bfl/flux",
      prompt: "draw",
    }))).toMatchObject({ code: "invalid-response" });

    const videoSdk = new CapturingSdk();
    videoSdk.videoMediaType = "audio/mpeg";
    expect(await rejection(testService({ sdk: videoSdk }).service.generateVideo({
      consent,
      model: "google/veo",
      prompt: "move",
    }))).toMatchObject({ code: "invalid-response" });

    const speechSdk = new CapturingSdk();
    speechSdk.speechMediaType = "image/png";
    expect(await rejection(testService({ sdk: speechSdk }).service.generateSpeech({
      consent,
      model: "openai/tts",
      text: "hello",
    }))).toMatchObject({ code: "invalid-response" });
  });

  test("publishes durable dispatch state immediately before the SDK call", async () => {
    const events: GatewayMediaDispatchEvent[] = [];
    const sdk = new CapturingSdk();
    const originalGenerateVideo = sdk.generateVideo.bind(sdk);
    sdk.generateVideo = (apiKey, request) => {
      expect(events).toEqual([{
        model: "google/veo",
        operation: "video.generate",
        startedAt: NOW.toISOString(),
      }]);
      return originalGenerateVideo(apiKey, request);
    };
    const { service } = testService({ dispatchEvents: events, sdk });
    await service.generateVideo({
      consent,
      model: "google/veo",
      prompt: "dispatch",
    });
    expect(events).toHaveLength(1);
  });

  test("rechecks credential time at the actual dispatch boundary", async () => {
    const requestedAt = new Date("2026-07-23T12:00:00.000Z");
    const dispatchAt = new Date("2026-07-23T12:04:59.000Z");
    const times = [requestedAt, dispatchAt];
    const credentialTimes: Date[] = [];
    const events: GatewayMediaDispatchEvent[] = [];
    const { service } = testService({
      credentialTimes,
      dispatchEvents: events,
      now: () => times.shift() ?? dispatchAt,
    });
    await service.generateSpeech({
      consent,
      model: "openai/tts",
      text: "dispatch freshness",
    });
    expect(credentialTimes).toEqual([dispatchAt]);
    expect(events).toEqual([{
      model: "openai/tts",
      operation: "speech.generate",
      startedAt: dispatchAt.toISOString(),
    }]);
  });
});

describe("AI SDK Gateway adapter", () => {
  test("pins the v4 Gateway origin, creates kind-specific models, and forwards request fields", async () => {
    const settings: Readonly<Record<string, unknown>>[] = [];
    const calls: Readonly<Record<string, unknown>>[] = [];
    const warningGlobal = globalThis as typeof globalThis & {
      AI_SDK_LOG_WARNINGS?: false | (() => void);
    };
    warningGlobal.AI_SDK_LOG_WARNINGS = () => {
      throw new Error("Raw AI SDK warning logger must be disabled.");
    };
    let warningLoggingSuppressed = false;
    const runtime: GatewayAiSdkRuntime = {
      createGateway: (value) => {
        settings.push(value);
        return {
          imageModel: id => `image:${id}`,
          languageModel: id => `language:${id}`,
          speech: id => `speech:${id}`,
          transcription: id => `transcription:${id}`,
          video: id => `video:${id}`,
        };
      },
      generateImage: (input) => {
        calls.push(input);
        return Promise.resolve({});
      },
      generateSpeech: (input) => {
        calls.push(input);
        return Promise.resolve({});
      },
      generateText: (input) => {
        warningLoggingSuppressed = warningGlobal.AI_SDK_LOG_WARNINGS === false;
        calls.push(input);
        return Promise.resolve({});
      },
      generateVideo: (input) => {
        calls.push(input);
        return Promise.resolve({});
      },
      transcribe: (input) => {
        calls.push(input);
        return Promise.resolve({});
      },
    };
    const sdk = createAiSdkGatewayMediaSdk({
      loadRuntime: () => Promise.resolve(runtime),
    });
    const signal = new AbortController().signal;
    await sdk.generateLanguageImage(API_KEY, {
      abortSignal: signal,
      maxRetries: 0,
      modelId: "google/gemini-image",
      prompt: "draw",
      temperature: 0.5,
    });
    expect(settings).toHaveLength(1);
    expect(settings[0]).toMatchObject({
      apiKey: API_KEY,
      baseURL: GATEWAY_MEDIA_API_BASE_URL,
    });
    expect(typeof settings[0]?.fetch).toBe("function");
    expect(warningLoggingSuppressed).toBe(true);
    expect(calls).toEqual([{
      abortSignal: signal,
      maxRetries: 0,
      model: "language:google/gemini-image",
      prompt: "draw",
      temperature: 0.5,
    }]);
    expect("modelId" in (calls[0] ?? {})).toBe(false);
  });

  test("accepts the Gateway package's callable provider shape through the lazy module loader", async () => {
    const calls: Readonly<Record<string, unknown>>[] = [];
    const provider = Object.assign(
      (modelId: string) => `language:${modelId}`,
      {
        imageModel: (modelId: string) => `image:${modelId}`,
        languageModel: (modelId: string) => `language:${modelId}`,
        speech: (modelId: string) => `speech:${modelId}`,
        transcription: (modelId: string) => `transcription:${modelId}`,
        video: (modelId: string) => `video:${modelId}`,
      },
    );
    const sdk = createAiSdkGatewayMediaSdk({
      importModule: specifier => Promise.resolve(
        specifier === "ai-v7"
          ? {
              experimental_generateVideo: () => Promise.resolve({}),
              generateImage: (input: Readonly<Record<string, unknown>>) => {
                calls.push(input);
                return Promise.resolve({});
              },
              generateSpeech: () => Promise.resolve({}),
              generateText: () => Promise.resolve({}),
              transcribe: () => Promise.resolve({}),
            }
          : { createGateway: () => provider },
      ),
    });
    const signal = new AbortController().signal;
    await sdk.generateImage(API_KEY, {
      abortSignal: signal,
      maxRetries: 0,
      modelId: "bfl/flux",
      prompt: "draw",
    });
    expect(calls).toEqual([{
      abortSignal: signal,
      maxRetries: 0,
      model: "image:bfl/flux",
      prompt: "draw",
    }]);
  });

  test("cancellation during lazy runtime loading prevents every paid AI SDK invocation", async () => {
    const invocations: readonly ((
      sdk: GatewayMediaSdk,
      signal: AbortSignal,
    ) => Promise<unknown>)[] = [
      (sdk, signal) => sdk.generateImage(API_KEY, {
        abortSignal: signal,
        maxRetries: 0,
        modelId: "bfl/flux",
        prompt: "image",
      }),
      (sdk, signal) => sdk.generateLanguageImage(API_KEY, {
        abortSignal: signal,
        maxRetries: 0,
        modelId: "google/gemini-image",
        prompt: "language image",
      }),
      (sdk, signal) => sdk.generateSpeech(API_KEY, {
        abortSignal: signal,
        maxRetries: 0,
        modelId: "openai/tts",
        text: "speech",
      }),
      (sdk, signal) => sdk.generateVideo(API_KEY, {
        abortSignal: signal,
        download: () => Promise.resolve({
          data: MP4_BYTES,
          mediaType: "video/mp4",
        }),
        maxRetries: 0,
        modelId: "google/veo",
        prompt: "video",
      }),
      (sdk, signal) => sdk.transcribe(API_KEY, {
        abortSignal: signal,
        audio: WAV_BYTES,
        maxRetries: 0,
        modelId: "openai/whisper",
      }),
    ];

    for (const invoke of invocations) {
      const runtimeStarted = deferred<void>();
      const releaseRuntime = deferred<GatewayAiSdkRuntime>();
      let providerCreations = 0;
      let paidCalls = 0;
      const runtime: GatewayAiSdkRuntime = {
        createGateway: () => {
          providerCreations += 1;
          return {
            imageModel: modelId => modelId,
            languageModel: modelId => modelId,
            speech: modelId => modelId,
            transcription: modelId => modelId,
            video: modelId => modelId,
          };
        },
        generateImage: () => {
          paidCalls += 1;
          return Promise.resolve({});
        },
        generateSpeech: () => {
          paidCalls += 1;
          return Promise.resolve({});
        },
        generateText: () => {
          paidCalls += 1;
          return Promise.resolve({});
        },
        generateVideo: () => {
          paidCalls += 1;
          return Promise.resolve({});
        },
        transcribe: () => {
          paidCalls += 1;
          return Promise.resolve({});
        },
      };
      const sdk = createAiSdkGatewayMediaSdk({
        loadRuntime: () => {
          runtimeStarted.resolve(undefined);
          return releaseRuntime.promise;
        },
      });
      const controller = new AbortController();
      const pending = invoke(sdk, controller.signal);
      await runtimeStarted.promise;
      controller.abort(new Error("cancelled while loading the AI SDK runtime"));
      releaseRuntime.resolve(runtime);

      expect(await rejection(pending)).toMatchObject({ code: "provider-failed" });
      expect(providerCreations).toBe(0);
      expect(paidCalls).toBe(0);
    }
  });
});

describe("fixed Gateway SDK transport", () => {
  test("pins the v4 prefix, forbids redirects, and bounds the streaming response", async () => {
    const calls: Request[] = [];
    const fetchImplementation: GatewayMediaFetch = (input) => {
      calls.push(input as Request);
      return Promise.resolve(new Response(Uint8Array.of(1, 2, 3, 4)));
    };
    const gatewayFetch = createFixedGatewayMediaApiFetch({
      fetch: fetchImplementation,
      maximumResponseBytes: 3,
    });
    const response = await gatewayFetch(
      `${GATEWAY_MEDIA_API_BASE_URL}/video-model`,
    );
    expect(calls[0]?.redirect).toBe("error");
    expect(await rejection(response.arrayBuffer())).toMatchObject({
      code: "invalid-response",
    });
    expect(await rejection(gatewayFetch("https://example.com/v4/ai/video-model")))
      .toMatchObject({ code: "provider-failed" });
    expect(calls).toHaveLength(1);

    const redirecting = createFixedGatewayMediaApiFetch({
      fetch: () => Promise.resolve(new Response(null, {
        headers: { location: "https://example.com" },
        status: 302,
      })),
    });
    expect(await rejection(redirecting(
      `${GATEWAY_MEDIA_API_BASE_URL}/image-model`,
    ))).toMatchObject({ code: "provider-failed" });
  });

  test("forwards only the validated canonical URL when foreign input mutates during coercion", async () => {
    let reads = 0;
    const hostile = {
      toString: () => {
        reads += 1;
        return reads === 1
          ? `${GATEWAY_MEDIA_API_BASE_URL}/image-model`
          : "https://attacker.invalid/steal";
      },
    } as unknown as string;
    const forwarded: Request[] = [];
    const gatewayFetch = createFixedGatewayMediaApiFetch({
      fetch: (input) => {
        forwarded.push(input as Request);
        return Promise.resolve(new Response("{}"));
      },
    });

    await gatewayFetch(hostile, { headers: { authorization: "Bearer secret" } });

    expect(reads).toBe(1);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toBeInstanceOf(Request);
    expect(forwarded[0]?.url).toBe(`${GATEWAY_MEDIA_API_BASE_URL}/image-model`);
    expect(forwarded[0]?.headers.get("authorization")).toBe("Bearer secret");
  });
});

describe("bounded Gateway output download", () => {
  test("serializes downloads and enforces one aggregate byte budget", async () => {
    const maximums: number[] = [];
    let active = 0;
    let maximumActive = 0;
    const aggregate = createAggregateGatewayMediaDownload(async input => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      maximums.push(input.maximumBytes ?? -1);
      await Promise.resolve();
      active -= 1;
      return {
        data: Uint8Array.of(1, 2, 3),
        mediaType: "video/mp4",
      };
    }, {
      maximumFileBytes: 4,
      maximumTotalBytes: 5,
    });
    const results = await Promise.allSettled([
      aggregate({ url: new URL("https://cdn.example/one") }),
      aggregate({ url: new URL("https://cdn.example/two") }),
    ]);
    expect(results.map(result => result.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(maximums).toEqual([4, 2]);
    expect(maximumActive).toBe(1);
  });

  test("accepts bounded HTTPS bytes and rejects HTTP or oversized bodies", async () => {
    const publicResolver = () => Promise.resolve([
      { address: "8.8.8.8", family: 4 as const },
    ]);
    let requestedAddresses: readonly Readonly<{
      address: string;
      family: 4 | 6;
    }>[] = [];
    const download = createBoundedGatewayMediaDownload({
      request: (_url, input) => {
        requestedAddresses = input.addresses;
        return Promise.resolve(new Response(Uint8Array.of(1, 2, 3), {
          headers: { "content-type": "video/mp4" },
        }));
      },
      maximumBytes: 3,
      resolveHostname: publicResolver,
    });
    expect(await download({ url: new URL("https://cdn.example/video") })).toEqual({
      data: Uint8Array.of(1, 2, 3),
      mediaType: "video/mp4",
    });
    expect(requestedAddresses).toEqual([
      { address: "8.8.8.8", family: 4 },
    ]);
    expect(await rejection(download({ url: new URL("http://cdn.example/video") })))
      .toMatchObject({ code: "download-failed" });

    const oversized = createBoundedGatewayMediaDownload({
      request: () => Promise.resolve(new Response(Uint8Array.of(1, 2, 3, 4))),
      maximumBytes: 3,
      resolveHostname: publicResolver,
    });
    expect(await rejection(oversized({ url: new URL("https://cdn.example/video") })))
      .toMatchObject({ code: "download-failed" });
  });

  test("applies the request timeout to DNS resolution before any connection", async () => {
    let requests = 0;
    const download = createBoundedGatewayMediaDownload({
      request: () => {
        requests += 1;
        return Promise.resolve(new Response(Uint8Array.of(1)));
      },
      resolveHostname: () => new Promise(() => undefined),
      timeoutMs: 20,
    });
    expect(await rejection(download({
      url: new URL("https://resolver-never-returns.example/video"),
    }))).toMatchObject({ code: "download-failed" });
    expect(requests).toBe(0);
  });

  test("hard-settles a non-cooperative pinned request", async () => {
    const download = createBoundedGatewayMediaDownload({
      request: () => new Promise(() => undefined),
      resolveHostname: () => Promise.resolve([{ address: "8.8.8.8", family: 4 }]),
      timeoutMs: 20,
    });
    const startedAt = performance.now();
    expect(await rejection(download({
      url: new URL("https://request-never-returns.example/video"),
    }))).toMatchObject({ code: "download-failed" });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  test("blocks private, local, DNS-resolved private, and redirect targets before fetching them", async () => {
    let calls = 0;
    const download = createBoundedGatewayMediaDownload({
      request: () => {
        calls += 1;
        return Promise.resolve(new Response(Uint8Array.of(1)));
      },
      resolveHostname: () => Promise.resolve([
        { address: "10.0.0.7", family: 4 },
      ]),
    });
    for (const value of [
      "https://127.0.0.1/file",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/file",
      "https://camera.local/file",
      "https://private.example/file",
    ]) {
      expect(await rejection(download({ url: new URL(value) })))
        .toMatchObject({ code: "download-failed" });
    }
    expect(calls).toBe(0);

    const redirecting = createBoundedGatewayMediaDownload({
      request: () => {
        calls += 1;
        return Promise.resolve(new Response(null, {
          headers: { location: "https://localhost/private" },
          status: 302,
        }));
      },
      resolveHostname: () => Promise.resolve([
        { address: "8.8.8.8", family: 4 },
      ]),
    });
    expect(await rejection(redirecting({
      url: new URL("https://cdn.example/video"),
    }))).toMatchObject({ code: "download-failed" });
    expect(calls).toBe(1);
  });
});
