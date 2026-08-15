import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  createProcessLocalHostResourceCoordinator,
  type HostResourceClaim,
  type HostResourceCoordinator,
  type HostResourceLease,
  type HostResourceLeaseOptions,
} from "@hraness/atet/host-resources";

import { EXIT_CODE } from "./errors";
import type { GatewayMediaCatalogTransport } from "./gateway-media-catalog";
import type {
  GatewayMediaSdk,
  GatewaySdkImageRequest,
  GatewaySdkLanguageImageRequest,
  GatewaySdkSpeechRequest,
  GatewaySdkTranscriptionRequest,
  GatewaySdkVideoRequest,
} from "./gateway-media-service";
import { probeCapability } from "./capabilities";
import { runCli as runProductionCli } from "./commands";
import {
  BunProcessRunner,
  type CliIo,
  type ProcessRunner,
  type RunOptions,
} from "./io";
import type { RepositoryPaths } from "./paths";
import { createCliTestRunner } from "./run-cli-test-helper";

const runCli = createCliTestRunner(import.meta.url);

const API_KEY = "vck_gateway_command_test_key_that_must_not_escape_123";
const NOW = new Date("2026-07-23T12:00:00.000Z");
const IMAGE_PROMPT = "draw the private launch diagram";
const SPEECH_TEXT = "Ship the launch.";
const TRANSCRIPT_TEXT = "Hello world";
const PNG_BYTES = new Uint8Array(
  await readFile(join(import.meta.dir, "..", "assets", "icon.png")),
);
const INVALID_MP4_BYTES = Uint8Array.of(
  0x00, 0x00, 0x00, 0x0c,
  0x66, 0x74, 0x79, 0x70,
  0x69, 0x73, 0x6f, 0x6d,
);

function opaqueReceiptHash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((accept) => {
    resolve = accept;
  });
  if (resolve === undefined) throw new Error("Deferred resolver was not initialized.");
  return { promise, resolve };
}

interface HostResourceEvent {
  readonly claims: readonly HostResourceClaim[];
  readonly phase: "acquired" | "released";
  readonly ticket: string;
}

class RecordingHostResourceCoordinator implements HostResourceCoordinator {
  readonly #active = new Map<string, readonly HostResourceClaim[]>();
  readonly #coordinator: HostResourceCoordinator;
  readonly events: HostResourceEvent[] = [];
  readonly profile;
  readonly scope;

  constructor(coordinator: HostResourceCoordinator) {
    this.#coordinator = coordinator;
    this.profile = coordinator.profile;
    this.scope = coordinator.scope;
  }

  activeClaims(): readonly HostResourceClaim[] {
    const totals = new Map<string, number>();
    for (const claims of this.#active.values()) {
      for (const claim of claims) {
        totals.set(
          claim.resource,
          (totals.get(claim.resource) ?? 0) + claim.amount,
        );
      }
    }
    return [...totals]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([resource, amount]) => ({ amount, resource }));
  }

  async withLease<Value>(
    claims: readonly HostResourceClaim[],
    callback: (lease: HostResourceLease) => Value | Promise<Value>,
    options?: HostResourceLeaseOptions,
  ): Promise<Value> {
    return await this.#coordinator.withLease(claims, async (lease) => {
      this.#active.set(lease.ticket, lease.claims);
      this.events.push({ claims: lease.claims, phase: "acquired", ticket: lease.ticket });
      try {
        return await callback(lease);
      } finally {
        this.events.push({ claims: lease.claims, phase: "released", ticket: lease.ticket });
        this.#active.delete(lease.ticket);
      }
    }, options);
  }
}

class GatedGatewayInspectionRunner implements ProcessRunner {
  readonly #delegate: ProcessRunner | undefined;
  readonly #gatedInspection: number;
  readonly #releaseValidation: Promise<void>;
  readonly #validationStarted: Deferred<void>;
  readonly inspectionCapabilityInheritedFileDescriptors: (
    readonly (readonly number[])[]
  )[] = [];
  readonly validationCapabilityInheritedFileDescriptors: (readonly number[])[] = [];
  readonly validationInheritedFileDescriptors: (readonly number[])[] = [];
  #inspection = 0;

  constructor(
    validationStarted: Deferred<void>,
    releaseValidation: Promise<void>,
    options: Readonly<{
      delegate?: ProcessRunner;
      gatedInspection?: number;
    }> = {},
  ) {
    this.#delegate = options.delegate;
    this.#gatedInspection = options.gatedInspection ?? 1;
    this.#releaseValidation = releaseValidation;
    this.#validationStarted = validationStarted;
  }

  async run(
    argv: readonly [string, ...string[]],
    options: RunOptions = {},
  ): Promise<Readonly<{ exitCode: number; stderr: string; stdout: string }>> {
    if (argv.includes("-show_entries")) {
      this.#inspection += 1;
      this.inspectionCapabilityInheritedFileDescriptors.push(
        this.validationCapabilityInheritedFileDescriptors.slice(-2),
      );
      this.validationInheritedFileDescriptors.push(
        options.inheritedFileDescriptors ?? [],
      );
      if (this.#inspection === this.#gatedInspection) {
        this.#validationStarted.resolve();
        await this.#releaseValidation;
      }
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          format: {},
          streams: [{
            avg_frame_rate: "1/1",
            codec_type: "video",
            height: 32,
            r_frame_rate: "1/1",
            width: 32,
          }],
        }),
      };
    }
    if (argv.includes("-version")) {
      this.validationCapabilityInheritedFileDescriptors.push(
        options.inheritedFileDescriptors ?? [],
      );
      return { exitCode: 0, stderr: "", stdout: `${argv[0]} test-version\n` };
    }
    if (argv[0] === "ffmpeg") {
      return { exitCode: 0, stderr: "", stdout: "" };
    }
    if (this.#delegate !== undefined) {
      return await this.#delegate.run(argv, options);
    }
    return { exitCode: 127, stderr: `unexpected command: ${argv[0]}`, stdout: "" };
  }
}

function silentPcmWav(sampleCount = 800): Uint8Array {
  const bytes = new Uint8Array(44 + sampleCount * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, value: string): void => {
    for (const [index, character] of [...value].entries()) {
      bytes[offset + index] = character.charCodeAt(0);
    }
  };
  ascii(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8_000, true);
  view.setUint32(28, 16_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, sampleCount * 2, true);
  return bytes;
}

const WAV_BYTES = silentPcmWav();

class CapturingGatewaySdk implements GatewayMediaSdk {
  failVideo = false;
  invalidVideoOutput = false;
  readonly imageCalls: GatewaySdkImageRequest[] = [];
  readonly languageImageCalls: GatewaySdkLanguageImageRequest[] = [];
  readonly speechCalls: GatewaySdkSpeechRequest[] = [];
  readonly speechOutputBytes: Uint8Array;
  readonly transcriptionCalls: GatewaySdkTranscriptionRequest[] = [];
  readonly videoCalls: GatewaySdkVideoRequest[] = [];
  readonly videoOutputBytes: Uint8Array;

  constructor(
    speechOutputBytes: Uint8Array,
    videoOutputBytes: Uint8Array,
  ) {
    this.speechOutputBytes = speechOutputBytes;
    this.videoOutputBytes = videoOutputBytes;
  }

  generateImage(apiKey: string, request: GatewaySdkImageRequest): Promise<unknown> {
    if (apiKey !== API_KEY) return Promise.reject(new Error("wrong test credential"));
    this.imageCalls.push(request);
    return Promise.resolve({
      images: [{
        mediaType: "image/png",
        uint8Array: PNG_BYTES,
      }],
      warnings: [],
    });
  }

  generateLanguageImage(
    apiKey: string,
    request: GatewaySdkLanguageImageRequest,
  ): Promise<unknown> {
    if (apiKey !== API_KEY) return Promise.reject(new Error("wrong test credential"));
    this.languageImageCalls.push(request);
    return Promise.resolve({
      files: [{
        mediaType: "image/png",
        uint8Array: PNG_BYTES,
      }],
      warnings: [],
    });
  }

  generateSpeech(apiKey: string, request: GatewaySdkSpeechRequest): Promise<unknown> {
    if (apiKey !== API_KEY) return Promise.reject(new Error("wrong test credential"));
    this.speechCalls.push(request);
    return Promise.resolve({
      audio: {
        mediaType: "audio/mpeg",
        uint8Array: this.speechOutputBytes,
      },
      warnings: [],
    });
  }

  generateVideo(apiKey: string, request: GatewaySdkVideoRequest): Promise<unknown> {
    if (apiKey !== API_KEY) return Promise.reject(new Error("wrong test credential"));
    this.videoCalls.push(request);
    if (this.failVideo) {
      return Promise.reject(Object.assign(
        new Error(`simulated provider failure ${API_KEY}`),
        {
          generationId: "generation_command_failure",
          providerMetadata: {
            gateway: {
              attempts: [{
                error: `raw provider error ${API_KEY}`,
                provider: "test-provider",
                statusCode: 503,
                success: false,
              }],
            },
          },
          statusCode: 503,
        },
      ));
    }
    return Promise.resolve({
      videos: [{
        mediaType: "video/mp4",
        uint8Array: this.invalidVideoOutput
          ? INVALID_MP4_BYTES
          : this.videoOutputBytes,
      }],
      warnings: [],
    });
  }

  transcribe(
    apiKey: string,
    request: GatewaySdkTranscriptionRequest,
  ): Promise<unknown> {
    if (apiKey !== API_KEY) return Promise.reject(new Error("wrong test credential"));
    this.transcriptionCalls.push(request);
    return Promise.resolve({
      durationInSeconds: 2.5,
      language: "en",
      segments: [
        { endSecond: 1.25, startSecond: 0, text: "Hello" },
        { endSecond: 2.5, startSecond: 1.25, text: "world" },
      ],
      text: TRANSCRIPT_TEXT,
      warnings: [],
    });
  }
}

class StallingImageGatewaySdk extends CapturingGatewaySdk {
  readonly #providerRelease: Promise<void>;
  readonly #providerStarted: Deferred<void>;

  constructor(
    providerStarted: Deferred<void>,
    providerRelease: Promise<void>,
  ) {
    super(WAV_BYTES, INVALID_MP4_BYTES);
    this.#providerRelease = providerRelease;
    this.#providerStarted = providerStarted;
  }

  override async generateImage(
    apiKey: string,
    request: GatewaySdkImageRequest,
  ): Promise<unknown> {
    const result = super.generateImage(apiKey, request);
    this.#providerStarted.resolve();
    await this.#providerRelease;
    return await result;
  }
}

interface CliResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface GatewayCommandFixture {
  readonly stateRoot: string;
  readonly catalogCalls: { value: number };
  readonly downloadCalls: { value: number };
  execute(
    argv: readonly string[],
    options?: Readonly<{ stdin?: string }>,
  ): Promise<CliResult>;
  readonly networkCalls: { value: number };
  readonly paths: RepositoryPaths;
  readonly root: string;
  readonly sdk: CapturingGatewaySdk;
}

function modelRow(
  type: "image" | "speech" | "transcription" | "video",
  id: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const output = type === "image"
    ? ["image"]
    : type === "video"
      ? ["video"]
      : type === "speech"
        ? ["audio"]
        : ["text"];
  return {
    created: 1,
    description: `${id} command-test model`,
    id,
    modalities: {
      input: type === "transcription" ? ["audio"] : ["text"],
      output,
    },
    name: id,
    object: "model",
    owned_by: id.split("/")[0],
    pricing: {},
    released: 2,
    tags: [],
    type,
    ...overrides,
  };
}

function catalogPayload(): Readonly<Record<string, unknown>> {
  return {
    data: [
      modelRow("image", "bfl/flux-command"),
      modelRow("video", "klingai/kling-command", {
        video_capabilities: {
          generate_audio: true,
          supported_durations_seconds: [4, 8],
          supported_operations: [
            "text-to-video",
            "image-to-video",
            "first-last-frame-to-video",
          ],
        },
      }),
      modelRow("speech", "xai/speech-command"),
      modelRow("transcription", "openai/whisper-command", {
        modalities: { input: ["audio"], output: ["text"] },
      }),
    ],
    object: "list",
  };
}

async function createFixture(): Promise<GatewayCommandFixture> {
  const root = await mkdtemp(join(tmpdir(), "atet-gateway-commands-"));
  const paths: RepositoryPaths = {
    artifactRoot: join(root, "artifacts", "atet", "recordings"),
    desktopRoot: join(root, "apps", "desktop"),
    privateRoot: join(root, "artifacts", "atet", "private"),
    projectRoot: join(root, "artifacts", "atet", "projects"),
    repositoryRoot: root,
  };
  const stateRoot = join(root, ".atet-state");
  await mkdir(paths.privateRoot, { mode: 0o700, recursive: true });
  const processRunner = new BunProcessRunner();
  const ffmpeg = (await probeCapability(
    processRunner,
    resolve(import.meta.dir, ".."),
    {},
    "ffmpeg",
  )).command;
  if (ffmpeg === undefined) {
    throw new Error("Gateway command tests require FFmpeg.");
  }
  const speechOutputPath = join(root, "generated-speech.mp3");
  const videoOutputPath = join(root, "generated-video.mp4");
  const [speechRender, videoRender] = await Promise.all([
    processRunner.run([
      ffmpeg,
      "-hide_banner", "-nostdin", "-v", "error",
      "-f", "lavfi",
      "-i", "anullsrc=channel_layout=mono:sample_rate=8000",
      "-t", "0.1",
      "-c:a", "libmp3lame",
      "-y",
      speechOutputPath,
    ]),
    processRunner.run([
      ffmpeg,
      "-hide_banner", "-nostdin", "-v", "error",
      "-f", "lavfi",
      "-i", "color=c=black:s=16x16:r=10:d=0.2",
      "-an",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-y",
      videoOutputPath,
    ]),
  ]);
  if (speechRender.exitCode !== 0 || videoRender.exitCode !== 0) {
    throw new Error("Could not create deterministic Gateway output fixtures.");
  }
  const sdk = new CapturingGatewaySdk(
    new Uint8Array(await readFile(speechOutputPath)),
    new Uint8Array(await readFile(videoOutputPath)),
  );
  const catalogCalls = { value: 0 };
  const downloadCalls = { value: 0 };
  const networkCalls = { value: 0 };
  const gatewayCatalogTransport: GatewayMediaCatalogTransport = {
    refresh: () => {
      catalogCalls.value += 1;
      return Promise.resolve({
        payload: catalogPayload(),
        status: "modified",
      });
    },
  };

  return {
    stateRoot,
    catalogCalls,
    downloadCalls,
    execute: async (argv, options = {}) => {
      let stderr = "";
      let stdout = "";
      const io: CliIo = {
        cwd: () => root,
        env: { AI_GATEWAY_API_KEY: API_KEY },
        now: () => new Date(NOW),
        platform: "darwin",
        ...(options.stdin === undefined
          ? {}
          : {
              readStdin: () => Promise.resolve(
                new TextEncoder().encode(options.stdin),
              ),
            }),
        stderr: value => {
          stderr += value;
        },
        stdout: value => {
          stdout += value;
        },
      };
      const exitCode = await runCli(argv, {
        stateRoot,
        fetch: () => {
          networkCalls.value += 1;
          return Promise.reject(new Error("unexpected network request"));
        },
        gatewayCatalogTransport,
        gatewayMediaDownload: () => {
          downloadCalls.value += 1;
          return Promise.reject(new Error("unexpected generated-media download"));
        },
        gatewayMediaSdk: sdk,
        io,
        paths,
      });
      return { exitCode, stderr, stdout };
    },
    networkCalls,
    paths,
    root,
    sdk,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an object.");
  }
  return value as Record<string, unknown>;
}

function parseJsonRecord(source: string): Record<string, unknown> {
  return asRecord(JSON.parse(source) as unknown);
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`Expected ${key} to be a string.`);
  return field;
}

function requiredArray(value: Record<string, unknown>, key: string): readonly unknown[] {
  const field = value[key];
  if (!Array.isArray(field)) throw new Error(`Expected ${key} to be an array.`);
  return field;
}

async function readRelative(
  fixture: GatewayCommandFixture,
  path: string,
): Promise<string> {
  return await readFile(resolve(fixture.root, path), "utf8");
}

async function configureGatewayKey(
  _fixture: GatewayCommandFixture,
): Promise<Record<string, unknown>> {
  return { configured: true, source: "AI_GATEWAY_API_KEY" };
}

function outputWithMediaType(
  summary: Record<string, unknown>,
  mediaType: string,
): Record<string, unknown> {
  const output = requiredArray(summary, "outputs")
    .map(asRecord)
    .find(candidate => candidate.mediaType === mediaType);
  if (output === undefined) throw new Error(`Missing ${mediaType} output.`);
  return output;
}

function gatewayImageWorkflowSource(source: Readonly<{
  bytes: number;
  mediaType: string;
  path: string;
  sha256: string;
}>): string {
  return `import { z } from "zod";
import { defineWorkflow } from "@hraness/atet/local/code";

export default defineWorkflow({
  id: "gateway-resource-phases",
  inputSchema: z.strictObject({}),
  inputSchemaId: "atet.test.gateway-resource-phases.input/v1",
  version: 1,
  build(workflow) {
    return {
      image: workflow.gateway.image("image", {
        images: [${JSON.stringify(source)}],
        model: "bfl/flux-command",
        prompt: "Preserve the reference while testing resource phases.",
      }),
    };
  },
});
`;
}

describe("Gateway CLI commands", () => {
  test("releases local media capacity during provider waits and reacquires it for validation", async () => {
    const root = await mkdtemp(join(tmpdir(), "atet-gateway-resource-phases-"));
    const paths: RepositoryPaths = {
      artifactRoot: join(root, "artifacts", "atet", "recordings"),
      desktopRoot: join(root, "projects", "atet", "apps", "desktop"),
      privateRoot: join(root, "artifacts", "atet", "private"),
      projectRoot: join(root, "artifacts", "atet", "projects"),
      repositoryRoot: root,
    };
    const stateRoot = join(root, ".atet-state");
    const providerStarted = deferred<void>();
    const releaseProvider = deferred<void>();
    const validationStarted = deferred<void>();
    const releaseValidation = deferred<void>();
    const sdk = new StallingImageGatewaySdk(
      providerStarted,
      releaseProvider.promise,
    );
    const runner = new GatedGatewayInspectionRunner(
      validationStarted,
      releaseValidation.promise,
    );
    const coordinator = new RecordingHostResourceCoordinator(
      createProcessLocalHostResourceCoordinator({
        profile: {
          capacities: [
            { limit: 1, resource: "cpu" },
            { limit: 1, resource: "ffmpeg" },
            { limit: 1, resource: "local-io" },
            { limit: 1, resource: "network" },
            { limit: 1, resource: "paid-call" },
          ],
          id: "atet.cli-test/gateway-resource-phases/v1",
        },
      }),
    );
    let commandPromise: Promise<CliResult> | undefined;
    const execute = async (
      argv: readonly string[],
      stdin?: string,
    ): Promise<CliResult> => {
      let stderr = "";
      let stdout = "";
      const io: CliIo = {
        cwd: () => root,
        env: { AI_GATEWAY_API_KEY: API_KEY },
        now: () => new Date(NOW),
        platform: "darwin",
        ...(stdin === undefined
          ? {}
          : {
              readStdin: () => Promise.resolve(
                new TextEncoder().encode(stdin),
              ),
            }),
        stderr: value => {
          stderr += value;
        },
        stdout: value => {
          stdout += value;
        },
      };
      const exitCode = await runProductionCli(argv, {
        stateRoot,
        gatewayCatalogTransport: {
          refresh: () => Promise.resolve({
            payload: catalogPayload(),
            status: "modified",
          }),
        },
        gatewayMediaDownload: () => Promise.reject(
          new Error("unexpected generated-media download"),
        ),
        gatewayMediaSdk: sdk,
        hostResourceCoordinator: coordinator,
        io,
        paths,
        runner,
      });
      return { exitCode, stderr, stdout };
    };
    const localClaims: readonly HostResourceClaim[] = [
      { amount: 1, resource: "cpu" },
      { amount: 1, resource: "ffmpeg" },
      { amount: 1, resource: "local-io" },
    ];
    try {
      await mkdir(paths.privateRoot, { mode: 0o700, recursive: true });
      commandPromise = execute([
        "ai",
        "image",
        "generate",
        "--model",
        "bfl/flux-command",
        "--prompt",
        IMAGE_PROMPT,
        "--json",
      ]);
      await Promise.race([
        providerStarted.promise,
        commandPromise.then((result) => {
          throw new Error(
            `Gateway command settled before provider dispatch: ${result.stderr}`,
          );
        }),
      ]);
      expect(coordinator.activeClaims()).toEqual([
        { amount: 1, resource: "network" },
        { amount: 1, resource: "paid-call" },
      ]);

      await coordinator.withLease(localClaims, async (lease) => {
        await lease.assertOwned();
        expect(coordinator.activeClaims()).toEqual([
          { amount: 1, resource: "cpu" },
          { amount: 1, resource: "ffmpeg" },
          { amount: 1, resource: "local-io" },
          { amount: 1, resource: "network" },
          { amount: 1, resource: "paid-call" },
        ]);
      });
      expect(coordinator.activeClaims()).toEqual([
        { amount: 1, resource: "network" },
        { amount: 1, resource: "paid-call" },
      ]);

      releaseProvider.resolve();
      await Promise.race([
        validationStarted.promise,
        commandPromise.then((result) => {
          throw new Error(
            `Gateway command settled before local validation: ${result.stderr}`,
          );
        }),
      ]);
      expect(coordinator.activeClaims()).toEqual([
        { amount: 1, resource: "cpu" },
        { amount: 1, resource: "ffmpeg" },
        { amount: 1, resource: "local-io" },
        { amount: 1, resource: "network" },
        { amount: 1, resource: "paid-call" },
      ]);
      expect(runner.validationInheritedFileDescriptors).toHaveLength(1);
      expect(runner.validationInheritedFileDescriptors[0]).toHaveLength(2);
      expect(new Set(runner.validationInheritedFileDescriptors[0]).size).toBe(2);
      expect(runner.validationCapabilityInheritedFileDescriptors).toHaveLength(2);
      expect(runner.validationCapabilityInheritedFileDescriptors.every(
        descriptors => (
          descriptors.length === 2 && new Set(descriptors).size === 2
        ),
      )).toBe(true);

      releaseValidation.resolve();
      const result = await commandPromise;
      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(parseJsonRecord(result.stdout)).toMatchObject({
        localValidation: {
          decodeValidatedOutputs: 1,
          status: "decode-passed",
        },
      });
      expect(coordinator.activeClaims()).toEqual([]);

      const localEvents = coordinator.events.filter(event => (
        event.claims.some(claim => claim.resource === "ffmpeg")
      ));
      expect(localEvents.map(event => event.phase)).toEqual([
        "acquired",
        "released",
        "acquired",
        "released",
      ]);
    } finally {
      releaseProvider.resolve();
      releaseValidation.resolve();
      if (commandPromise !== undefined) await Promise.allSettled([commandPromise]);
      await rm(root, { force: true, recursive: true });
    }
  });

  test("phase-splits Code Mode Gateway preparation, provider wait, and validation", async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), "atet-code-gateway-resource-phases-")),
    );
    const paths: RepositoryPaths = {
      artifactRoot: join(root, "artifacts", "atet", "recordings"),
      desktopRoot: join(root, "projects", "atet", "apps", "desktop"),
      privateRoot: join(root, "artifacts", "atet", "private"),
      projectRoot: join(root, "artifacts", "atet", "projects"),
      repositoryRoot: root,
    };
    const stateRoot = join(root, ".atet-state");
    const providerStarted = deferred<void>();
    const releaseProvider = deferred<void>();
    const outputValidationStarted = deferred<void>();
    const releaseOutputValidation = deferred<void>();
    const sdk = new StallingImageGatewaySdk(
      providerStarted,
      releaseProvider.promise,
    );
    const runner = new GatedGatewayInspectionRunner(
      outputValidationStarted,
      releaseOutputValidation.promise,
      {
        delegate: new BunProcessRunner(),
        gatedInspection: 3,
      },
    );
    const coordinator = new RecordingHostResourceCoordinator(
      createProcessLocalHostResourceCoordinator({
        profile: {
          capacities: [
            { limit: 1, resource: "cpu" },
            { limit: 1, resource: "ffmpeg" },
            { limit: 1, resource: "local-io" },
            { limit: 1, resource: "network" },
            { limit: 1, resource: "paid-call" },
          ],
          id: "atet.cli-test/code-gateway-resource-phases/v1",
        },
      }),
    );
    let finalResume: Promise<CliResult> | undefined;
    const execute = async (
      argv: readonly string[],
      stdin?: string,
    ): Promise<CliResult> => {
      let stderr = "";
      let stdout = "";
      const io: CliIo = {
        cwd: () => root,
        env: { AI_GATEWAY_API_KEY: API_KEY },
        now: () => new Date(NOW),
        platform: process.platform,
        ...(stdin === undefined
          ? {}
          : {
              readStdin: () => Promise.resolve(
                new TextEncoder().encode(stdin),
              ),
            }),
        stderr: value => {
          stderr += value;
        },
        stdout: value => {
          stdout += value;
        },
      };
      const exitCode = await runProductionCli(argv, {
        stateRoot,
        fetch: () => Promise.reject(new Error("unexpected network request")),
        gatewayCatalogTransport: {
          refresh: () => Promise.resolve({
            payload: catalogPayload(),
            status: "modified",
          }),
        },
        gatewayMediaDownload: () => Promise.reject(
          new Error("unexpected generated-media download"),
        ),
        gatewayMediaSdk: sdk,
        hostResourceCoordinator: coordinator,
        io,
        paths,
        runner,
      });
      return { exitCode, stderr, stdout };
    };
    const localClaims: readonly HostResourceClaim[] = [
      { amount: 1, resource: "cpu" },
      { amount: 1, resource: "ffmpeg" },
      { amount: 1, resource: "local-io" },
    ];
    const runDetails = async (runId: string): Promise<Record<string, unknown>> => {
      const result = await execute([
        "runs", "show", runId, "--nodes", "all", "--json",
      ]);
      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      return parseJsonRecord(result.stdout);
    };
    try {
      const inputDirectory = join(root, "inputs");
      await Promise.all([
        mkdir(paths.privateRoot, { mode: 0o700, recursive: true }),
        mkdir(inputDirectory, { mode: 0o700, recursive: true }),
      ]);
      const imagePath = join(inputDirectory, "source.png");
      await writeFile(imagePath, PNG_BYTES, { mode: 0o600 });
      await writeFile(
        join(root, "gateway-workflow.ts"),
        gatewayImageWorkflowSource({
          bytes: PNG_BYTES.byteLength,
          mediaType: "image/png",
          path: "inputs/source.png",
          sha256: createHash("sha256").update(PNG_BYTES).digest("hex"),
        }),
        { mode: 0o600 },
      );
      await writeFile(join(root, "gateway-input.json"), "{}\n", {
        mode: 0o600,
      });
      const created = await execute([
        "code", "run", "gateway-workflow.ts",
        "--input", "gateway-input.json",
        "--jobs", "1",
        "--json",
      ]);
      expect(created).toMatchObject({ exitCode: 0, stderr: "" });
      const createdSummary = asRecord(parseJsonRecord(created.stdout).summary);
      expect(createdSummary.status).toBe("approval-required");
      const runId = requiredString(createdSummary, "runId");

      const preparationNode = asRecord(requiredArray(
        await runDetails(runId),
        "nodes",
      )[0]);
      const preparationPlan = asRecord(preparationNode.preparationPlan);
      expect(await execute([
        "runs", "approve", runId, "image",
        "--preparation-plan",
        requiredString(preparationPlan, "preparationPlanSha256"),
        "--json",
      ])).toMatchObject({ exitCode: 0, stderr: "" });

      const prepared = await execute([
        "runs", "resume", runId, "--jobs", "1", "--json",
      ]);
      expect(prepared).toMatchObject({ exitCode: 0, stderr: "" });
      expect(asRecord(parseJsonRecord(prepared.stdout).summary).status)
        .toBe("approval-required");
      expect(runner.validationInheritedFileDescriptors).toHaveLength(1);
      expect(runner.validationInheritedFileDescriptors[0]).toHaveLength(1);
      expect(runner.inspectionCapabilityInheritedFileDescriptors[0])
        .toHaveLength(2);
      expect(runner.inspectionCapabilityInheritedFileDescriptors[0]?.every(
        descriptors => descriptors.length === 1,
      )).toBe(true);

      const effectNode = asRecord(requiredArray(
        await runDetails(runId),
        "nodes",
      )[0]);
      const executionPlan = asRecord(effectNode.executionPlan);
      expect(await execute([
        "runs", "approve", runId, "image",
        "--node-plan",
        requiredString(executionPlan, "nodePlanSha256"),
        "--json",
      ])).toMatchObject({ exitCode: 0, stderr: "" });

      finalResume = execute([
        "runs", "resume", runId, "--jobs", "1", "--json",
      ]);
      await Promise.race([
        providerStarted.promise,
        finalResume.then((result) => {
          throw new Error(
            `Code Mode Gateway command settled before provider dispatch: ${result.stderr}`,
          );
        }),
      ]);
      expect(runner.validationInheritedFileDescriptors).toHaveLength(2);
      expect(runner.validationInheritedFileDescriptors[1]).toHaveLength(2);
      expect(new Set(runner.validationInheritedFileDescriptors[1]).size).toBe(2);
      expect(runner.inspectionCapabilityInheritedFileDescriptors[1])
        .toHaveLength(2);
      expect(runner.inspectionCapabilityInheritedFileDescriptors[1]?.every(
        descriptors => (
          descriptors.length === 2 && new Set(descriptors).size === 2
        ),
      )).toBe(true);
      expect(coordinator.activeClaims()).toEqual([
        { amount: 1, resource: "network" },
        { amount: 1, resource: "paid-call" },
      ]);

      await coordinator.withLease(localClaims, async (lease) => {
        await lease.assertOwned();
        expect(coordinator.activeClaims()).toEqual([
          { amount: 1, resource: "cpu" },
          { amount: 1, resource: "ffmpeg" },
          { amount: 1, resource: "local-io" },
          { amount: 1, resource: "network" },
          { amount: 1, resource: "paid-call" },
        ]);
      });
      expect(coordinator.activeClaims()).toEqual([
        { amount: 1, resource: "network" },
        { amount: 1, resource: "paid-call" },
      ]);

      releaseProvider.resolve();
      await Promise.race([
        outputValidationStarted.promise,
        finalResume.then((result) => {
          throw new Error(
            `Code Mode Gateway command settled before output validation: ${result.stderr}`,
          );
        }),
      ]);
      expect(coordinator.activeClaims()).toEqual([
        { amount: 1, resource: "cpu" },
        { amount: 1, resource: "ffmpeg" },
        { amount: 1, resource: "local-io" },
        { amount: 1, resource: "network" },
        { amount: 1, resource: "paid-call" },
      ]);
      expect(runner.validationInheritedFileDescriptors).toHaveLength(3);
      expect(runner.validationInheritedFileDescriptors[2]).toHaveLength(2);
      expect(new Set(runner.validationInheritedFileDescriptors[2]).size).toBe(2);
      expect(runner.inspectionCapabilityInheritedFileDescriptors[2])
        .toHaveLength(2);
      expect(runner.inspectionCapabilityInheritedFileDescriptors[2]?.every(
        descriptors => (
          descriptors.length === 2 && new Set(descriptors).size === 2
        ),
      )).toBe(true);

      releaseOutputValidation.resolve();
      const completed = await finalResume;
      expect(completed).toMatchObject({ exitCode: 0, stderr: "" });
      expect(asRecord(parseJsonRecord(completed.stdout).summary).status)
        .toBe("completed");
      expect(coordinator.activeClaims()).toEqual([]);
      const localEvents = coordinator.events.filter(event => (
        event.claims.some(claim => claim.resource === "ffmpeg")
      ));
      expect(localEvents.map(event => event.phase)).toEqual([
        "acquired",
        "released",
        "acquired",
        "released",
        "acquired",
        "released",
        "acquired",
        "released",
      ]);
    } finally {
      releaseProvider.resolve();
      releaseOutputValidation.resolve();
      if (finalResume !== undefined) await Promise.allSettled([finalResume]);
      await rm(root, { force: true, recursive: true });
    }
  }, 120_000);

  test("discovers dynamic models and publishes compact model-aware parameter hints", async () => {
    const fixture = await createFixture();
    try {
      const listed = await fixture.execute([
        "ai",
        "models",
        "list",
        "--type",
        "video",
        "--json",
      ]);
      expect(listed).toMatchObject({ exitCode: 0, stderr: "" });
      const list = parseJsonRecord(listed.stdout);
      expect(list.count).toBe(1);
      const models = requiredArray(list, "models").map(asRecord);
      expect(models).toHaveLength(1);
      expect(models[0]).toMatchObject({
        executionMode: "video-model",
        id: "klingai/kling-command",
        kind: "video",
      });

      const shown = await fixture.execute([
        "ai",
        "models",
        "show",
        "klingai/kling-command",
        "--json",
      ]);
      expect(shown).toMatchObject({ exitCode: 0, stderr: "" });
      const details = parseJsonRecord(shown.stdout);
      const parameters = asRecord(details.parameterInput);
      const common = requiredArray(parameters, "common");
      expect(common).toContain("frameImages");
      expect(common).toContain("generateAudio");
      expect(common).toContain("inputReferences");
      expect(common).toContain("resolution");
      const providerOptions = asRecord(parameters.providerOptions);
      const gatewayOptions = providerOptions.gateway;
      const klingOptions = providerOptions.klingai;
      expect(Array.isArray(gatewayOptions) && gatewayOptions.includes("zeroDataRetention")).toBe(true);
      expect(Array.isArray(gatewayOptions) && gatewayOptions.includes("providerTimeouts")).toBe(true);
      expect(Array.isArray(klingOptions) && klingOptions.includes("cameraControl")).toBe(true);
      expect(Array.isArray(klingOptions) && klingOptions.includes("multiShot")).toBe(true);
      expect(Array.isArray(klingOptions) && klingOptions.includes("pollTimeoutMs")).toBe(true);
      expect(asRecord(parameters.rawProviderOptions)).toMatchObject({
        flag: "--provider-options <json-file>",
        maximumBytes: 65_536,
      });
      expect(fixture.catalogCalls.value).toBe(1);
      expect(fixture.networkCalls.value).toBe(0);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("forwards image, legal video, speech, and transcription requests and commits durable artifacts", async () => {
    const fixture = await createFixture();
    try {
      await configureGatewayKey(fixture);
      const inputRoot = join(fixture.root, "inputs");
      await mkdir(inputRoot, { mode: 0o700 });
      await Promise.all([
        writeFile(join(inputRoot, "source.png"), PNG_BYTES, { mode: 0o600 }),
        writeFile(join(inputRoot, "mask.png"), PNG_BYTES, { mode: 0o600 }),
        writeFile(join(inputRoot, "last.png"), PNG_BYTES, { mode: 0o600 }),
        writeFile(join(inputRoot, "audio.wav"), WAV_BYTES, { mode: 0o600 }),
        writeFile(
          join(inputRoot, "image-options.json"),
          JSON.stringify({
            blackForestLabs: {
              guidance: 3.5,
              privateControl: "provider-control-token",
              steps: 24,
            },
          }),
          { mode: 0o600 },
        ),
        writeFile(
          join(inputRoot, "video-options.json"),
          JSON.stringify({
            gateway: {
              order: ["fal"],
              zeroDataRetention: true,
            },
            klingai: {
              cameraControl: {
                config: { horizontal: 2.5 },
                type: "horizontal",
              },
              mode: "pro",
              multiShot: true,
            },
          }),
          { mode: 0o600 },
        ),
        writeFile(
          join(inputRoot, "speech-options.json"),
          JSON.stringify({
            xai: {
              sampleRate: 24_000,
              textNormalization: "on",
            },
          }),
          { mode: 0o600 },
        ),
        writeFile(
          join(inputRoot, "transcription-options.json"),
          JSON.stringify({
            openai: {
              language: "en",
              temperature: 0,
              timestampGranularities: ["segment"],
            },
          }),
          { mode: 0o600 },
        ),
      ]);

      const image = await fixture.execute([
        "ai",
        "image",
        "generate",
        "--model",
        "bfl/flux-command",
        "--prompt",
        IMAGE_PROMPT,
        "--image",
        "inputs/source.png",
        "--mask",
        "inputs/mask.png",
        "--count",
        "2",
        "--max-per-call",
        "2",
        "--aspect-ratio",
        "1:1",
        "--seed",
        "42",
        "--provider-options",
        "inputs/image-options.json",
        "--allow-cloud-upload",
        "--json",
      ]);
      expect(image).toMatchObject({ exitCode: 0, stderr: "" });
      expect(fixture.sdk.imageCalls).toHaveLength(1);
      expect(fixture.sdk.imageCalls[0]).toMatchObject({
        aspectRatio: "1:1",
        maxImagesPerCall: 2,
        maxRetries: 0,
        modelId: "bfl/flux-command",
        n: 2,
        prompt: {
          text: IMAGE_PROMPT,
        },
        providerOptions: {
          blackForestLabs: {
            guidance: 3.5,
            privateControl: "provider-control-token",
            steps: 24,
          },
        },
        seed: 42,
      });
      const imagePrompt = fixture.sdk.imageCalls[0]?.prompt;
      expect(typeof imagePrompt).toBe("object");
      if (typeof imagePrompt === "object") {
        expect(imagePrompt.images).toEqual([PNG_BYTES]);
        expect(imagePrompt.mask).toEqual(PNG_BYTES);
      }
      expect(fixture.sdk.imageCalls[0]?.abortSignal).toBeInstanceOf(AbortSignal);
      const imageSummary = parseJsonRecord(image.stdout);
      expect(requiredArray(imageSummary, "outputs")).toHaveLength(1);
      expect(outputWithMediaType(imageSummary, "image/png")).toMatchObject({
        bytes: PNG_BYTES.byteLength,
      });
      expect(imageSummary.sampleFulfillment).toEqual({
        produced: 1,
        requested: 2,
        status: "partial",
      });
      const completedJobSource = await readRelative(
        fixture,
        requiredString(imageSummary, "jobPath"),
      );
      expect(parseJsonRecord(completedJobSource)).toMatchObject({
        chargeMayHaveOccurred: true,
        model: "bfl/flux-command",
        noAtetRetry: true,
        operation: "image.generate",
        state: "completed",
      });
      const imageReceiptSource = await readRelative(
        fixture,
        requiredString(imageSummary, "receiptPath"),
      );
      expect(`${image.stdout}${completedJobSource}${imageReceiptSource}`).not.toContain(API_KEY);
      expect(`${completedJobSource}${imageReceiptSource}`).not.toContain(IMAGE_PROMPT);
      expect(`${completedJobSource}${imageReceiptSource}`).not.toContain("provider-control-token");

      const video = await fixture.execute([
        "ai",
        "video",
        "generate",
        "--model",
        "klingai/kling-command",
        "--prompt",
        "pan from the terminal to the preview",
        "--frame",
        "first=inputs/source.png",
        "--frame",
        "last=inputs/last.png",
        "--count",
        "2",
        "--max-per-call",
        "2",
        "--aspect-ratio",
        "16:9",
        "--resolution",
        "1080p",
        "--duration",
        "8",
        "--fps",
        "24",
        "--seed",
        "99",
        "--generate-audio",
        "true",
        "--provider-options",
        "inputs/video-options.json",
        "--allow-cloud-upload",
        "--json",
      ]);
      expect(video).toMatchObject({ exitCode: 0, stderr: "" });
      expect(fixture.sdk.videoCalls).toHaveLength(1);
      expect(fixture.sdk.videoCalls[0]).toMatchObject({
        aspectRatio: "16:9",
        duration: 8,
        fps: 24,
        frameImages: [
          { frameType: "first_frame" },
          { frameType: "last_frame" },
        ],
        generateAudio: true,
        maxRetries: 0,
        maxVideosPerCall: 2,
        modelId: "klingai/kling-command",
        n: 2,
        prompt: "pan from the terminal to the preview",
        providerOptions: {
          gateway: {
            order: ["fal"],
            zeroDataRetention: true,
          },
          klingai: {
            cameraControl: {
              config: { horizontal: 2.5 },
              type: "horizontal",
            },
            mode: "pro",
            multiShot: true,
          },
        },
        resolution: "1080p",
        seed: 99,
      });
      const videoCall = fixture.sdk.videoCalls[0];
      expect(videoCall?.frameImages?.map(frame => frame.image))
        .toEqual([PNG_BYTES, PNG_BYTES]);
      expect(fixture.sdk.videoCalls[0]?.abortSignal).toBeInstanceOf(AbortSignal);
      expect(typeof fixture.sdk.videoCalls[0]?.download).toBe("function");
      const videoSummary = parseJsonRecord(video.stdout);
      expect(outputWithMediaType(videoSummary, "video/mp4")).toMatchObject({
        bytes: fixture.sdk.videoOutputBytes.byteLength,
      });
      expect(videoSummary.sampleFulfillment).toEqual({
        produced: 1,
        requested: 2,
        status: "partial",
      });

      const remoteFrameUrl =
        "https://cdn.example/private-frame.png?signature=must-not-persist";
      const remoteVideo = await fixture.execute([
        "ai",
        "video",
        "generate",
        "--model",
        "klingai/kling-command",
        "--prompt",
        "animate the remote frame",
        "--image",
        remoteFrameUrl,
        "--allow-cloud-upload",
        "--json",
      ]);
      expect(remoteVideo).toMatchObject({ exitCode: 0, stderr: "" });
      expect(fixture.sdk.videoCalls).toHaveLength(2);
      expect(fixture.sdk.videoCalls[1]?.prompt).toEqual({
        image: remoteFrameUrl,
        text: "animate the remote frame",
      });
      const remoteVideoSummary = parseJsonRecord(remoteVideo.stdout);
      const remoteVideoReceipt = await readRelative(
        fixture,
        requiredString(remoteVideoSummary, "receiptPath"),
      );
      expect(`${remoteVideo.stdout}${remoteVideoReceipt}`)
        .not.toContain(remoteFrameUrl);
      const remoteVideoInput = asRecord(requiredArray(
        parseJsonRecord(remoteVideoReceipt),
        "inputs",
      )[0]);
      expect(remoteVideoInput).toMatchObject({
        bytes: 0,
        mediaType: "image/png",
        role: "prompt-image",
        source: "url",
      });
      expect(requiredString(remoteVideoInput, "sha256"))
        .toMatch(/^[a-f0-9]{64}$/u);

      const speech = await fixture.execute([
        "ai",
        "speech",
        "generate",
        "--model",
        "xai/speech-command",
        "--text",
        SPEECH_TEXT,
        "--instructions",
        "Speak with calm confidence.",
        "--voice",
        "Ara",
        "--format",
        "mp3",
        "--language",
        "en",
        "--speed",
        "1.25",
        "--provider-options",
        "inputs/speech-options.json",
        "--json",
      ]);
      expect(speech).toMatchObject({ exitCode: 0, stderr: "" });
      expect(fixture.sdk.speechCalls).toHaveLength(1);
      expect(fixture.sdk.speechCalls[0]).toMatchObject({
        instructions: "Speak with calm confidence.",
        language: "en",
        maxRetries: 0,
        modelId: "xai/speech-command",
        outputFormat: "mp3",
        providerOptions: {
          xai: {
            sampleRate: 24_000,
            textNormalization: "on",
          },
        },
        speed: 1.25,
        text: SPEECH_TEXT,
        voice: "Ara",
      });
      const speechSummary = parseJsonRecord(speech.stdout);
      expect(outputWithMediaType(speechSummary, "audio/mpeg")).toMatchObject({
        bytes: fixture.sdk.speechOutputBytes.byteLength,
      });
      const speechReceipt = parseJsonRecord(await readRelative(
        fixture,
        requiredString(speechSummary, "receiptPath"),
      ));
      const speechRequest = asRecord(speechReceipt.request);
      expect(speechRequest).toMatchObject({
        instructionsCharacters: 27,
      });
      expect(requiredString(speechRequest, "instructionsSha256"))
        .toMatch(/^[a-f0-9]{64}$/u);
      expect(requiredString(speechRequest, "textSha256"))
        .toMatch(/^[a-f0-9]{64}$/u);
      expect(JSON.stringify(speechReceipt))
        .not.toContain("Speak with calm confidence.");
      const speechJob = parseJsonRecord(await readRelative(
        fixture,
        requiredString(speechSummary, "jobPath"),
      ));
      const speechJobRequest = asRecord(speechJob.request);
      expect(speechRequest.instructionsSha256)
        .toBe(speechJobRequest.instructionsSha256);
      expect(speechRequest.textSha256).toBe(speechJobRequest.textSha256);

      const transcription = await fixture.execute([
        "ai",
        "transcribe",
        "inputs/audio.wav",
        "--model",
        "openai/whisper-command",
        "--format",
        "all",
        "--provider-options",
        "inputs/transcription-options.json",
        "--allow-cloud-audio-upload",
        "--json",
      ]);
      expect(transcription).toMatchObject({ exitCode: 0, stderr: "" });
      expect(fixture.sdk.transcriptionCalls).toHaveLength(1);
      expect(fixture.sdk.transcriptionCalls[0]).toMatchObject({
        audio: Uint8Array.of(82, 73, 70, 70),
        maxRetries: 0,
        modelId: "openai/whisper-command",
        providerOptions: {
          openai: {
            language: "en",
            temperature: 0,
            timestampGranularities: ["segment"],
          },
        },
      });
      const transcriptionSummary = parseJsonRecord(transcription.stdout);
      expect(requiredArray(transcriptionSummary, "outputs")
        .map(asRecord)
        .map(output => output.mediaType)
        .sort()).toEqual([
          "application/json",
          "application/x-subrip",
          "text/plain",
          "text/vtt",
        ]);
      const jsonOutput = outputWithMediaType(transcriptionSummary, "application/json");
      const textOutput = outputWithMediaType(transcriptionSummary, "text/plain");
      const srtOutput = outputWithMediaType(transcriptionSummary, "application/x-subrip");
      const vttOutput = outputWithMediaType(transcriptionSummary, "text/vtt");
      expect(requiredString(jsonOutput, "path")).toEndWith(".json");
      expect(requiredString(textOutput, "path")).toEndWith(".txt");
      expect(requiredString(srtOutput, "path")).toEndWith(".srt");
      expect(requiredString(vttOutput, "path")).toEndWith(".vtt");
      expect(parseJsonRecord(
        await readRelative(fixture, requiredString(jsonOutput, "path")),
      )).toMatchObject({
        durationInSeconds: 2.5,
        language: "en",
        text: TRANSCRIPT_TEXT,
      });
      expect(await readRelative(fixture, requiredString(textOutput, "path")))
        .toBe(`${TRANSCRIPT_TEXT}\n`);
      expect(await readRelative(fixture, requiredString(srtOutput, "path")))
        .toBe(
          "1\n00:00:00,000 --> 00:00:01,250\nHello\n\n"
          + "2\n00:00:01,250 --> 00:00:02,500\nworld\n",
        );
      expect(await readRelative(fixture, requiredString(vttOutput, "path")))
        .toBe(
          "WEBVTT\n\n00:00:00.000 --> 00:00:01.250\nHello\n\n"
          + "00:00:01.250 --> 00:00:02.500\nworld\n",
        );

      expect(fixture.sdk.languageImageCalls).toHaveLength(0);
      expect(fixture.downloadCalls.value).toBe(0);
      expect(fixture.networkCalls.value).toBe(0);
      expect(JSON.stringify(transcriptionSummary)).not.toContain(API_KEY);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  }, 30_000);

  test("rejects every media reference before catalog, credential, or SDK dispatch without acknowledgement", async () => {
    const fixture = await createFixture();
    try {
      await writeFile(join(fixture.root, "reference.png"), Uint8Array.of(1), {
        mode: 0o600,
      });
      await writeFile(join(fixture.root, "voice.wav"), Uint8Array.of(2), {
        mode: 0o600,
      });
      const attempts = [
        ["ai", "image", "generate", "--model", "bfl/flux-command", "--image", "reference.png", "--json"],
        ["ai", "video", "generate", "--model", "klingai/kling-command", "--image", "reference.png", "--json"],
        ["ai", "video", "generate", "--model", "klingai/kling-command", "--image", "https://cdn.example/reference.png", "--json"],
        ["ai", "transcribe", "voice.wav", "--model", "openai/whisper-command", "--json"],
      ] as const;
      for (const argv of attempts) {
        const result = await fixture.execute(argv);
        expect(result.exitCode).toBe(EXIT_CODE.usage);
        const failure = asRecord(parseJsonRecord(result.stderr).error);
        expect(failure.code).toBe("usage");
        expect(requiredString(failure, "message")).toContain("explicit");
      }
      expect(fixture.catalogCalls.value).toBe(0);
      expect(fixture.sdk.imageCalls).toHaveLength(0);
      expect(fixture.sdk.languageImageCalls).toHaveLength(0);
      expect(fixture.sdk.videoCalls).toHaveLength(0);
      expect(fixture.sdk.speechCalls).toHaveLength(0);
      expect(fixture.sdk.transcriptionCalls).toHaveLength(0);
      expect(fixture.networkCalls.value).toBe(0);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("fully decodes acknowledged local media before catalog or credential access", async () => {
    const fixture = await createFixture();
    try {
      await writeFile(
        join(fixture.root, "truncated.png"),
        Uint8Array.of(
          0x89, 0x50, 0x4e, 0x47,
          0x0d, 0x0a, 0x1a, 0x0a,
        ),
        { mode: 0o600 },
      );
      const result = await fixture.execute([
        "ai",
        "image",
        "generate",
        "--model",
        "bfl/flux-command",
        "--image",
        "truncated.png",
        "--allow-cloud-upload",
        "--json",
      ]);
      expect(result.exitCode).toBe(EXIT_CODE["invalid-data"]);
      expect(asRecord(parseJsonRecord(result.stderr).error))
        .toMatchObject({ code: "invalid-data" });
      expect(fixture.catalogCalls.value).toBe(0);
      expect(fixture.sdk.imageCalls).toHaveLength(0);
      expect(fixture.sdk.languageImageCalls).toHaveLength(0);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("leaves one ambiguous no-retry job after a dispatched SDK failure", async () => {
    const fixture = await createFixture();
    try {
      await configureGatewayKey(fixture);
      fixture.sdk.failVideo = true;
      const failed = await fixture.execute([
        "ai",
        "video",
        "generate",
        "--model",
        "klingai/kling-command",
        "--prompt",
        "this request fails after dispatch",
        "--json",
      ]);
      expect(failed).toMatchObject({
        exitCode: EXIT_CODE.unavailable,
        stdout: "",
      });
      expect(failed.stderr).not.toContain(API_KEY);
      const failure = asRecord(parseJsonRecord(failed.stderr).error);
      expect(failure).toMatchObject({
        code: "unavailable",
      });
      const details = asRecord(failure.details);
      expect(details).toMatchObject({
        jobState: "ambiguous",
        noAtetRetry: true,
      });
      expect(fixture.sdk.videoCalls).toHaveLength(1);
      const jobSource = await readRelative(
        fixture,
        requiredString(details, "jobPath"),
      );
      expect(jobSource).not.toContain(API_KEY);
      const job = parseJsonRecord(jobSource);
      expect(requiredString(job, "ambiguity"))
        .toContain("may have reached one or more paid providers");
      expect(requiredString(job, "interruptionSemantics"))
        .toContain("must not be retried by Atet");
      expect(job).toMatchObject({
        chargeMayHaveOccurred: true,
        failure: {
          code: "unavailable",
          message: "The Gateway media provider request failed.",
        },
        model: "klingai/kling-command",
        noAtetRetry: true,
        operation: "video.generate",
        state: "ambiguous",
      });
      const gatewayReconciliation = asRecord(
        asRecord(job.failure).gatewayReconciliation,
      );
      expect(gatewayReconciliation).toMatchObject({
        failureSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        routing: {
          attemptCount: 1,
          attempts: [{
            error: opaqueReceiptHash(`raw provider error ${API_KEY}`),
            provider: opaqueReceiptHash("test-provider"),
            statusCode: 503,
            success: false,
          }],
          attemptsTruncated: false,
          clientMaxRetries: 0,
          gatewayProviderFailover: "may-attempt-multiple-providers",
          generationId: opaqueReceiptHash("generation_command_failure"),
          providerCount: 1,
          providers: [opaqueReceiptHash("test-provider")],
          providersTruncated: false,
        },
        statusCode: 503,
      });
      expect(JSON.stringify(gatewayReconciliation)).not.toContain(API_KEY);
      expect(fixture.downloadCalls.value).toBe(0);
      expect(fixture.networkCalls.value).toBe(0);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("preserves but quarantines generated media that fails local decode", async () => {
    const fixture = await createFixture();
    try {
      await configureGatewayKey(fixture);
      fixture.sdk.invalidVideoOutput = true;
      const failed = await fixture.execute([
        "ai",
        "video",
        "generate",
        "--model",
        "klingai/kling-command",
        "--prompt",
        "provider returns a truncated container",
        "--json",
      ]);
      expect(failed).toMatchObject({
        exitCode: EXIT_CODE["invalid-data"],
        stdout: "",
      });
      const failure = asRecord(parseJsonRecord(failed.stderr).error);
      const details = asRecord(failure.details);
      expect(details).toMatchObject({
        artifactCommitted: true,
        jobState: "ambiguous",
        localValidation: {
          decodeValidatedOutputs: 0,
          signatureOnlyOutputs: 0,
          status: "decode-failed",
        },
        noAtetRetry: true,
      });
      const receipt = parseJsonRecord(await readRelative(
        fixture,
        requiredString(details, "artifactReceiptPath"),
      ));
      expect(receipt).toMatchObject({
        localValidation: {
          status: "decode-failed",
        },
        nextCommands: [],
      });
      expect(requiredArray(receipt, "outputs")).toHaveLength(1);
      expect(fixture.sdk.videoCalls).toHaveLength(1);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  }, 30_000);
});
