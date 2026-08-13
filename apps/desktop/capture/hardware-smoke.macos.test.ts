import { createHash, randomUUID } from "node:crypto";
import { lstat, open, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import { expect, test } from "bun:test";

import {
  loadRecordingEvents,
  openRecording,
} from "../cli/bundle-service";
import {
  createNodeBundleFileSystem,
  loadRecordingManifest,
} from "../core";
import { BunProcessRunner, type ProcessRunner, type RunOptions, type RunResult } from "../cli/io";
import {
  CaptureHelperRecordingController,
  type RecordingSnapshot,
} from "../cli/recording-controller";
import {
  defaultArtifactRoot,
  discoverRepositoryRoot,
  ensurePrivateDirectory,
  resolveSafePath,
} from "../cli/paths";
import { buildCaptureHelper } from "./build";
import {
  parseCaptureHelperProbe,
  type CaptureEvent,
  type CaptureHelperProbe,
  type SegmentCompletion,
} from "./protocol";
import {
  HARDWARE_SMOKE_ACTIVE_SEGMENT_MS,
  HARDWARE_SMOKE_MAX_CONTAINER_DURATION_SPREAD_US,
  HARDWARE_SMOKE_MIN_ACTIVE_SEGMENT_US,
  HARDWARE_SMOKE_MIN_NATIVE_PAUSE_US,
  HARDWARE_SMOKE_PAUSE_MS,
  hardwareSmokeRequested,
  parseHardwareSmokeConfig,
  type HardwareSmokeConfig,
} from "./hardware-smoke-config";
import {
  type HardwareMetadataEvidenceExpectation,
  verifyHardwareMetadataEvidence,
  type HardwareMetadataEvidenceSummary,
} from "./hardware-metadata-evidence";
import {
  startInteractionFixture,
  type InteractionFixtureController,
  type InteractionFixtureReceipt,
} from "./interaction-fixture";

const HELPER_PROBE_TIMEOUT_MS = 10_000;
const TOOL_PROBE_TIMEOUT_MS = 10_000;
const FFPROBE_FILE_TIMEOUT_MS = 15_000;
const HELPER_REQUEST_TIMEOUT_MS = 60_000;
const HARDWARE_SMOKE_TIMEOUT_MS = 10 * 60_000;
const MAXIMUM_PROBE_OUTPUT_BYTES = 64 * 1024;

const HARDWARE_SMOKE_ENABLED =
  process.platform === "darwin"
  && hardwareSmokeRequested(process.env);

type CapturedStream = SegmentCompletion["displays"][number]["streams"][number];
type SegmentCompletedEvent = Extract<CaptureEvent, {
  readonly event: "segment-completed";
}>;

interface CapturedStreamReference {
  readonly path: string;
  readonly stream: CapturedStream;
}

interface FfprobeStream {
  readonly codecName: string;
  readonly index: number;
  readonly type: "audio" | "video";
}

interface FfprobeSummary {
  readonly durationSeconds: number;
  readonly streams: readonly FfprobeStream[];
}

interface PhysicalFileIntegrity {
  readonly bytes: number;
  readonly sha256: string;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isWithin(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === ""
    || (!value.startsWith("..") && !isAbsolute(value));
}

function spread(values: readonly number[], label: string): number {
  if (values.length === 0) {
    throw new Error(`Hardware smoke found no ${label}.`);
  }
  return Math.max(...values) - Math.min(...values);
}

function parseJson(stdout: string, label: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
}

async function probeCaptureHelper(
  runner: ProcessRunner,
  executable: string,
): Promise<CaptureHelperProbe> {
  const result = await runner.run(
    [executable, "--json"],
    {
      env: { LANG: "en_US.UTF-8", PATH: "/usr/bin:/bin" },
      maxOutputBytes: MAXIMUM_PROBE_OUTPUT_BYTES,
      timeoutMs: HELPER_PROBE_TIMEOUT_MS,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Capture helper probe failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    );
  }
  if (Buffer.byteLength(result.stdout) > MAXIMUM_PROBE_OUTPUT_BYTES) {
    throw new Error("Capture helper probe exceeded its output bound.");
  }
  return parseCaptureHelperProbe(
    parseJson(result.stdout, "Capture helper probe"),
  );
}

async function resolveExecutable(
  runner: ProcessRunner,
  label: string,
  candidates: readonly (string | null | undefined)[],
  versionArguments: readonly string[],
): Promise<string> {
  for (const candidate of [...new Set(candidates)]) {
    if (candidate === undefined || candidate === null || candidate === "") {
      continue;
    }
    try {
      const result = await runner.run(
        [candidate, ...versionArguments],
        {
          maxOutputBytes: 32_000,
          timeoutMs: TOOL_PROBE_TIMEOUT_MS,
        },
      );
      if (result.exitCode === 0) return candidate;
    } catch {
      // Continue through the complete bounded candidate list.
    }
  }
  throw new Error(`${label} is required for the real capture hardware smoke.`);
}

function requireAuthorized(
  probe: CaptureHelperProbe,
  names: readonly (keyof CaptureHelperProbe["permissions"])[],
): void {
  const missing = names.filter((name) => probe.permissions[name] !== "authorized");
  if (missing.length === 0) return;
  throw new Error(
    `Hardware smoke requires pre-authorized permissions before start: ${
      missing.map((name) => `${name}=${probe.permissions[name]}`).join(", ")
    }. Run Transmute interactively to grant them.`,
  );
}

function requireHardwarePreconditions(
  probe: CaptureHelperProbe,
  config: HardwareSmokeConfig,
): void {
  const missingCapabilities = [
    !probe.capabilities.availableSources && "availableSources",
    !probe.capabilities.displayRecording && "displayRecording",
    !probe.capabilities.interruptionDiagnostics && "interruptionDiagnostics",
    !probe.capabilities.metadata && "metadata",
    config.systemAudio && !probe.capabilities.systemAudio && "systemAudio",
    config.camera && !probe.capabilities.camera && "camera",
    config.microphone && !probe.capabilities.microphone && "microphone",
  ].filter((value): value is string => typeof value === "string");
  if (missingCapabilities.length > 0) {
    throw new Error(
      `Capture helper omits requested capabilities: ${missingCapabilities.join(", ")}.`,
    );
  }

  requireAuthorized(probe, [
    "accessibility",
    "inputMonitoring",
    "screenCapture",
    "windowMetadata",
    ...(config.systemAudio ? ["systemAudio" as const] : []),
    ...(config.camera ? ["camera" as const] : []),
    ...(config.microphone ? ["microphone" as const] : []),
  ]);

  if (probe.availableSources.displays.length < config.minimumDisplays) {
    throw new Error(
      `Hardware smoke requires at least ${config.minimumDisplays} display(s); the helper found ${
        probe.availableSources.displays.length
      }.`,
    );
  }
  if (
    config.systemAudio
    && !probe.availableSources.audio.some(({ kind }) => kind === "system")
  ) {
    throw new Error("Hardware smoke requested system audio, but its source is absent.");
  }
  if (config.camera && probe.availableSources.cameras.length === 0) {
    throw new Error("Hardware smoke requested a camera, but no default camera is present.");
  }
  if (
    config.microphone
    && !probe.availableSources.audio.some(({ kind }) => kind === "microphone")
  ) {
    throw new Error(
      "Hardware smoke requested a microphone, but no default microphone is present.",
    );
  }
}

function boundedFfprobeRunner(runner: ProcessRunner): ProcessRunner {
  return {
    run(
      argv: readonly [string, ...string[]],
      options: RunOptions = {},
    ): Promise<RunResult> {
      return runner.run(argv, {
        ...options,
        timeoutMs: Math.min(
          options.timeoutMs ?? FFPROBE_FILE_TIMEOUT_MS,
          FFPROBE_FILE_TIMEOUT_MS,
        ),
      });
    },
  };
}

function capturedStreams(segment: SegmentCompletion): readonly CapturedStreamReference[] {
  return [
    ...segment.displays.flatMap(({ path, streams }) =>
      streams.map((stream) => ({ path, stream }))
    ),
    ...(segment.camera.availability === "recorded"
      ? segment.camera.streams.map((stream) => ({
          path: segment.camera.availability === "recorded"
            ? segment.camera.path
            : "",
          stream,
        }))
      : []),
    ...(segment.microphone.availability === "recorded"
      ? segment.microphone.streams.map((stream) => ({
          path: segment.microphone.availability === "recorded"
            ? segment.microphone.path
            : "",
          stream,
        }))
      : []),
  ];
}

function assertRawSegment(
  segment: SegmentCompletion,
  selectedSources: RecordingSnapshot["sources"],
  config: HardwareSmokeConfig,
): void {
  const displayIds = [...segment.displays.map(({ display }) => display.displayId)]
    .sort();
  expect(displayIds).toEqual(
    [...selectedSources.displays.map(({ displayId }) => displayId)].sort(),
  );

  const streams = capturedStreams(segment);
  const count = (role: CapturedStream["role"]): number =>
    streams.filter(({ stream }) => stream.role === role).length;
  expect(count("display-video")).toBe(selectedSources.displays.length);
  expect(count("system-audio")).toBe(config.systemAudio ? 1 : 0);
  expect(count("camera-video")).toBe(config.camera ? 1 : 0);
  expect(count("microphone-audio")).toBe(config.microphone ? 1 : 0);
  expect(count("unclassified-audio")).toBe(0);

  expect(segment.camera.availability).toBe(config.camera ? "recorded" : "unavailable");
  if (!config.camera && segment.camera.availability === "unavailable") {
    expect(segment.camera.reason).toBe("disabled");
  }
  expect(segment.microphone.availability)
    .toBe(config.microphone ? "recorded" : "unavailable");
  if (!config.microphone && segment.microphone.availability === "unavailable") {
    expect(segment.microphone.reason).toBe("disabled");
  }

  expect(segment.diagnostics.filter(({ recoverable }) => !recoverable)).toEqual([]);
  expect(segment.metadata.length).toBeGreaterThan(0);
  expect(segment.metadata.every(({ droppedEvents }) => droppedEvents === 0))
    .toBeTrue();
  expect(segment.metadata.some(({ eventKinds, recordCount }) =>
    eventKinds.includes("lifecycle.marker") && recordCount > 0
  )).toBeTrue();

  for (const { stream } of streams) {
    const timing = stream.timing;
    expect(timing, `${stream.role} must publish v2 sample timing`).toBeDefined();
    if (timing === undefined) {
      throw new Error(`Real ${stream.role} stream omitted v2 sample timing.`);
    }
    expect(timing.sampleCount).toBeGreaterThan(0);
    expect(timing.bufferCount).toBeGreaterThan(0);
    expect(timing.presentation.maximumSampleDurationUs).toBeGreaterThan(0);
    expect(timing.clockAnchors.first.ptsUs)
      .toBe(timing.presentation.firstPtsUs);
    expect(timing.clockAnchors.end.ptsUs)
      .toBe(timing.presentation.endPtsUs);
    expect(timing.clockAnchors.first.uncertaintyUs).toBeGreaterThan(0);
    expect(timing.clockAnchors.end.uncertaintyUs).toBeGreaterThan(0);
    expect(timing.clockAnchors.end.nativeTimeUs)
      .toBeGreaterThan(timing.clockAnchors.first.nativeTimeUs);
    expect(timing.presentation.endPtsUs)
      .toBeGreaterThan(timing.presentation.lastPtsUs);
    expect(timing.presentation.lastPtsUs)
      .toBeGreaterThanOrEqual(timing.presentation.firstPtsUs);
    const nativeSpanUs =
      timing.clockAnchors.end.nativeTimeUs
      - timing.clockAnchors.first.nativeTimeUs;
    const presentationSpanUs =
      timing.presentation.endPtsUs - timing.presentation.firstPtsUs;
    expect(
      Math.abs(nativeSpanUs - presentationSpanUs),
      `${stream.role} sample-clock anchor residual`,
    ).toBeLessThanOrEqual(
      timing.clockAnchors.first.uncertaintyUs
        + timing.clockAnchors.end.uncertaintyUs
        + 2,
    );
  }

  const containerDurations = [
    ...segment.displays.map(({ containerDurationUs }) => containerDurationUs),
    ...(segment.camera.availability === "recorded"
      ? [segment.camera.containerDurationUs]
      : []),
    ...(segment.microphone.availability === "recorded"
      ? [segment.microphone.containerDurationUs]
      : []),
  ];
  expect(
    spread(containerDurations, "container durations"),
    "supplemental container-duration spread",
  ).toBeLessThanOrEqual(HARDWARE_SMOKE_MAX_CONTAINER_DURATION_SPREAD_US);
}

function parseFfprobeSummary(stdout: string): FfprobeSummary {
  const value = parseJson(stdout, "FFprobe");
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("FFprobe output must be an object.");
  }
  const object = value as Readonly<Record<string, unknown>>;
  if (!Array.isArray(object.streams)) {
    throw new Error("FFprobe output omits streams.");
  }
  const streams = object.streams.map((item): FfprobeStream => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("FFprobe emitted an invalid stream.");
    }
    const stream = item as Readonly<Record<string, unknown>>;
    if (
      typeof stream.index !== "number"
      || !Number.isSafeInteger(stream.index)
      || stream.index < 0
      || typeof stream.codec_name !== "string"
      || stream.codec_name === ""
      || (stream.codec_type !== "audio" && stream.codec_type !== "video")
    ) {
      throw new Error("FFprobe emitted an incomplete stream.");
    }
    return {
      codecName: stream.codec_name,
      index: stream.index,
      type: stream.codec_type,
    };
  });
  if (
    typeof object.format !== "object"
    || object.format === null
    || Array.isArray(object.format)
  ) {
    throw new Error("FFprobe output omits its format.");
  }
  const duration = Number(
    (object.format as Readonly<Record<string, unknown>>).duration,
  );
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("FFprobe output has no positive duration.");
  }
  return { durationSeconds: duration, streams };
}

async function probeMediaFile(
  runner: ProcessRunner,
  ffprobe: string,
  absolutePath: string,
): Promise<FfprobeSummary> {
  const result = await runner.run(
    [
      ffprobe,
      "-v", "error",
      "-show_entries", "format=duration:stream=index,codec_name,codec_type",
      "-of", "json",
      absolutePath,
    ],
    {
      maxOutputBytes: 1_000_000,
      timeoutMs: FFPROBE_FILE_TIMEOUT_MS,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `FFprobe rejected ${absolutePath}: ${
        result.stderr.trim() || `exit ${result.exitCode}`
      }`,
    );
  }
  return parseFfprobeSummary(result.stdout);
}

async function hashPhysicalFile(
  absolutePath: string,
): Promise<PhysicalFileIntegrity> {
  const hash = createHash("sha256");
  const handle = await open(absolutePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  try {
    for (;;) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        bytes,
      );
      if (bytesRead === 0) break;
      bytes += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return { bytes, sha256: hash.digest("hex") };
}

function expectedStreamType(
  kind: "camera-video" | "display-video" | "microphone-audio" | "system-audio",
): "audio" | "video" {
  return kind.endsWith("-video") ? "video" : "audio";
}

async function assertFinalizedBundle(
  recordingRoot: string,
  expectedDisplayIds: readonly string[],
  completed: readonly SegmentCompletion[],
  config: HardwareSmokeConfig,
  interactionReceipt: InteractionFixtureReceipt | undefined,
  runner: ProcessRunner,
  ffprobe: string,
): Promise<HardwareMetadataEvidenceSummary> {
  const manifest = await loadRecordingManifest(
    createNodeBundleFileSystem(recordingRoot),
  );
  expect(manifest.schemaVersion).toBe(3);
  expect(manifest.state).toBe("stopped");
  expect(manifest.diagnostics.filter(({ level }) => level === "error")).toEqual([]);
  if (manifest.schemaVersion !== 3) {
    throw new Error("Real hardware capture did not produce manifest v3.");
  }
  expect(manifest.timeline.nativeClock.kind)
    .toBe("mach-continuous-microseconds");
  expect(manifest.timeline.nativeClock.segments.map(({ index }) => index))
    .toEqual([0, 1]);

  const tracksByKind = (
    kind: "camera-video" | "display-video" | "microphone-audio" | "system-audio",
  ) => manifest.tracks.filter((track) => track.kind === kind);
  expect(
    tracksByKind("display-video").map(({ source }) =>
      "displayId" in source ? source.displayId : ""
    ).sort(),
  ).toEqual([...expectedDisplayIds].sort());
  expect(tracksByKind("system-audio")).toHaveLength(config.systemAudio ? 1 : 0);
  expect(tracksByKind("camera-video")).toHaveLength(config.camera ? 1 : 0);
  expect(tracksByKind("microphone-audio")).toHaveLength(config.microphone ? 1 : 0);

  const expectedTracks = manifest.tracks.filter(({ kind }) =>
    kind === "display-video"
    || (kind === "system-audio" && config.systemAudio)
    || (kind === "camera-video" && config.camera)
    || (kind === "microphone-audio" && config.microphone)
  );
  expect(expectedTracks.length).toBe(
    expectedDisplayIds.length
      + Number(config.systemAudio)
      + Number(config.camera)
      + Number(config.microphone),
  );

  const probeCache = new Map<string, Promise<FfprobeSummary>>();
  const integrityCache = new Map<string, Promise<PhysicalFileIntegrity>>();
  for (const track of expectedTracks) {
    expect(track.segments).toHaveLength(2);
    for (const segment of track.segments) {
      expect(segment.integrity).toMatchObject({
        state: "verified",
      });
      if (segment.integrity.state === "verified") {
        expect(segment.integrity.bytes).toBeGreaterThan(0);
      }
      expect(segment.containerTrackIdentity.kind).toBe("verified");
      expect(segment.timing.kind).toBe("measured");
      if (segment.timing.kind === "measured") {
        expect(segment.timing.policy).toBe("capture-sync-v1");
        expect(segment.timing.status).toBe("within-tolerance");
        expect(Math.abs(segment.timing.onsetSkewUs))
          .toBeLessThanOrEqual(segment.timing.tolerance.onsetSkewUs);
        expect(Math.abs(segment.timing.durationDriftUs))
          .toBeLessThanOrEqual(segment.timing.tolerance.durationDriftUs);
      }

      const absolute = await resolveSafePath(recordingRoot, segment.path);
      const details = await lstat(absolute);
      expect(details.isFile()).toBeTrue();
      expect(details.isSymbolicLink()).toBeFalse();
      expect(details.size).toBeGreaterThan(0);
      let probed = probeCache.get(absolute);
      if (probed === undefined) {
        probed = probeMediaFile(runner, ffprobe, absolute);
        probeCache.set(absolute, probed);
      }
      const summary = await probed;
      expect(summary.durationSeconds).toBeGreaterThan(0);
      expect(summary.streams.some(({ codecName, index, type }) =>
        index === segment.streamIndex
        && type === expectedStreamType(track.kind)
        && codecName === segment.codec
      )).toBeTrue();
      if (segment.integrity.state === "verified") {
        let physicalIntegrity = integrityCache.get(absolute);
        if (physicalIntegrity === undefined) {
          physicalIntegrity = hashPhysicalFile(absolute);
          integrityCache.set(absolute, physicalIntegrity);
        }
        expect(await physicalIntegrity).toEqual({
          bytes: segment.integrity.bytes,
          sha256: segment.integrity.sha256,
        });
      }
    }
  }

  expect(manifest.eventStreams.length).toBeGreaterThanOrEqual(2);
  expect(manifest.eventStreams.every(({ integrity }) =>
    integrity.state === "verified"
  )).toBeTrue();
  expect(manifest.eventStreams.some(({ eventKinds, recordCount }) =>
    eventKinds.includes("lifecycle.marker") && recordCount > 0
  )).toBeTrue();

  const recording = await openRecording(
    dirname(recordingRoot),
    manifest.recordingId,
  );
  const events = await loadRecordingEvents(recording);
  const interaction:
    HardwareMetadataEvidenceExpectation["interaction"] = (() => {
      if (!config.interactions) return { kind: "none" };
      if (interactionReceipt === undefined) {
        throw new Error(
          "Owned interaction capture omitted its fixture receipt.",
        );
      }
      return { kind: "owned-fixture", receipt: interactionReceipt };
    })();
  const segmentCoverage = completed.map((segment) => {
    const retainedStreams = [
      ...segment.displays.flatMap(({ streams }) => streams),
      ...(segment.camera.availability === "recorded"
        ? segment.camera.streams
        : []),
      ...(segment.microphone.availability === "recorded"
        ? segment.microphone.streams
        : []),
    ].filter((stream): stream is CapturedStream & {
      readonly timing: NonNullable<CapturedStream["timing"]>;
    } => stream.timing !== undefined);
    if (retainedStreams.length === 0) {
      throw new Error(
        `Capture segment ${String(segment.index)} omitted retained stream timing.`,
      );
    }
    const firstRetainedSampleNativeTimeUs = Math.min(
      ...retainedStreams.map(({ timing }) => Math.max(
        0,
        timing.clockAnchors.first.nativeTimeUs
          - timing.clockAnchors.first.uncertaintyUs,
      )),
    );
    const lastRetainedSampleNativeTimeUs = Math.max(
      ...retainedStreams.map(({ timing }) => (
        timing.clockAnchors.end.nativeTimeUs
        - (
          timing.presentation.endPtsUs
          - timing.presentation.lastPtsUs
        )
        + timing.clockAnchors.end.uncertaintyUs
      )),
    );
    return {
      firstRetainedSampleNativeTimeUs,
      lastRetainedSampleNativeTimeUs,
      segmentId: `segment_${String(segment.index + 1).padStart(8, "0")}`,
    };
  });
  return verifyHardwareMetadataEvidence(events, {
    expectedDisplayIds,
    interaction,
    segmentCoverage,
    typedText: config.typedText
      ? { kind: "owned-fixture" }
      : { kind: "disabled" },
  });
}

async function closeForCleanup(
  controller: CaptureHelperRecordingController | undefined,
): Promise<void> {
  if (controller === undefined) return;
  try {
    await controller.close();
  } catch (error) {
    process.stderr.write(
      `Hardware-smoke controller cleanup failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
}

function recordingRootFrom(snapshot: RecordingSnapshot): string {
  if (snapshot.recordingRoot === null) {
    throw new Error("Capture controller did not return a recording root.");
  }
  return snapshot.recordingRoot;
}

test.skipIf(!HARDWARE_SMOKE_ENABLED)(
  "records, pauses, resumes, and verifies a real synchronized macOS bundle",
  async () => {
    const config = parseHardwareSmokeConfig(process.env);
    const runner = new BunProcessRunner();
    const repositoryRoot = await discoverRepositoryRoot(import.meta.dir);
    const artifactRoot = defaultArtifactRoot(repositoryRoot);
    const runRoot = join(
      artifactRoot,
      ".hardware-smoke",
      randomUUID(),
    );
    let controller: CaptureHelperRecordingController | undefined;
    let interactionFixture: InteractionFixtureController | undefined;
    let interactionReceipt: InteractionFixtureReceipt | undefined;
    let recordingRoot: string | undefined;
    let passed = false;
    let artifactSafetyEstablished = false;
    let runRootCreated = false;

    try {
      const [{ path: captureHelper }, ffprobe, git] = await Promise.all([
        buildCaptureHelper(),
        resolveExecutable(
          runner,
          "FFprobe",
          [
            Bun.which("ffprobe"),
            "/opt/homebrew/bin/ffprobe",
            "/usr/local/bin/ffprobe",
            "/opt/local/bin/ffprobe",
          ],
          ["-version"],
        ),
        resolveExecutable(
          runner,
          "Git",
          [Bun.which("git"), "/usr/bin/git", "/opt/homebrew/bin/git"],
          ["--version"],
        ),
      ]);
      const probe = await probeCaptureHelper(runner, captureHelper);
      requireHardwarePreconditions(probe, config);

      await ensurePrivateDirectory(runRoot);
      runRootCreated = true;
      const ignored = await runner.run(
        [
          git,
          "-C", repositoryRoot,
          "check-ignore",
          "--quiet",
          "--",
          relative(repositoryRoot, runRoot),
        ],
        { maxOutputBytes: 32_000, timeoutMs: TOOL_PROBE_TIMEOUT_MS },
      );
      if (ignored.exitCode !== 0) {
        throw new Error(
          `Hardware-smoke artifact root is not ignored by Git: ${runRoot}`,
        );
      }
      artifactSafetyEstablished = true;

      if (config.interactions) {
        interactionFixture = await startInteractionFixture({
          executable: captureHelper,
          fixtureId: randomUUID().toLocaleLowerCase("en-US"),
        });
      }

      const rawEvents: CaptureEvent[] = [];
      controller = new CaptureHelperRecordingController({
        artifactRoot: runRoot,
        executable: captureHelper,
        ffprobeExecutable: ffprobe,
        io: { now: () => new Date() },
        onCaptureEvent: (event: CaptureEvent) => {
          rawEvents.push(event);
        },
        requestTimeoutMs: HELPER_REQUEST_TIMEOUT_MS,
        runner: boundedFfprobeRunner(runner),
      });

      const started = await controller.start({
        camera: config.camera ? { kind: "default" } : { kind: "disabled" },
        displays: { kind: "all" },
        interactionEventProcessIdentifier:
          interactionFixture?.publicFocusIdentity.processId ?? null,
        microphone: config.microphone ? { kind: "default" } : { kind: "disabled" },
        strictInputs: true,
        systemAudio: config.systemAudio,
        typedText: config.typedText,
        typedTextFocusIdentities: config.typedText
          && interactionFixture !== undefined
          ? [interactionFixture.publicFocusIdentity]
          : null,
      });
      expect(started.state).toBe("recording");
      recordingRoot = recordingRootFrom(started);
      const [physicalRunRoot, physicalRecordingRoot] = await Promise.all([
        realpath(runRoot),
        realpath(recordingRoot),
      ]);
      expect(isWithin(physicalRunRoot, physicalRecordingRoot)).toBeTrue();

      const firstSegmentWaitStartedAt = performance.now();
      if (interactionFixture !== undefined) {
        interactionReceipt = await interactionFixture.exercise();
      }
      await wait(Math.max(
        0,
        HARDWARE_SMOKE_ACTIVE_SEGMENT_MS
          - (performance.now() - firstSegmentWaitStartedAt),
      ));
      const paused = await controller.pause();
      expect(paused).toMatchObject({
        completedSegmentCount: 1,
        state: "paused",
      });
      const pausedLogicalTimeUs = paused.logicalTimeUs;
      await wait(HARDWARE_SMOKE_PAUSE_MS);
      const stillPaused = await controller.status();
      expect(stillPaused.state).toBe("paused");
      expect(stillPaused.logicalTimeUs).toBe(pausedLogicalTimeUs);

      const resumed = await controller.resume();
      expect(resumed.state).toBe("recording");
      await wait(HARDWARE_SMOKE_ACTIVE_SEGMENT_MS);
      const stopped = await controller.stop();
      expect(stopped).toMatchObject({
        completedSegmentCount: 2,
        state: "idle",
      });
      await controller.close();
      if (interactionFixture !== undefined) {
        await interactionFixture.close();
        interactionFixture = undefined;
      }

      const completed = rawEvents
        .filter((event): event is SegmentCompletedEvent =>
          event.event === "segment-completed"
        )
        .map(({ segment }) => segment)
        .sort((left, right) => left.index - right.index);
      expect(completed.map(({ index }) => index)).toEqual([0, 1]);
      const first = completed[0];
      const second = completed[1];
      if (first === undefined || second === undefined) {
        throw new Error("Capture helper did not emit two segment completions.");
      }
      for (const segment of completed) {
        const activeDurationUs =
          segment.clock.end.sourceTimeUs - segment.clock.start.sourceTimeUs;
        expect(activeDurationUs)
          .toBeGreaterThanOrEqual(HARDWARE_SMOKE_MIN_ACTIVE_SEGMENT_US);
        expect(
          segment.clock.end.nativeTimeUs - segment.clock.start.nativeTimeUs,
        ).toBe(activeDurationUs);
        assertRawSegment(segment, started.sources, config);
      }
      expect(second.clock.start.sourceTimeUs)
        .toBe(first.clock.end.sourceTimeUs);
      expect(
        second.clock.start.nativeTimeUs - first.clock.end.nativeTimeUs,
      ).toBeGreaterThanOrEqual(HARDWARE_SMOKE_MIN_NATIVE_PAUSE_US);

      const metadataEvidence = await assertFinalizedBundle(
        recordingRoot,
        started.sources.displays.map(({ displayId }) => displayId),
        completed,
        config,
        interactionReceipt,
        runner,
        ffprobe,
      );
      process.stderr.write(
        `Hardware metadata evidence: ${JSON.stringify(metadataEvidence)}\n`,
      );
      passed = true;
    } finally {
      await closeForCleanup(controller);
      try {
        await interactionFixture?.close();
      } catch (error) {
        process.stderr.write(
          `Hardware-smoke fixture cleanup failed: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      }
      const keep =
        artifactSafetyEstablished
        && !(config.typedText && !passed)
        && (
          config.keepArtifacts === "always"
          || (config.keepArtifacts === "on-failure" && !passed)
        );
      if (
        artifactSafetyEstablished
        && runRootCreated
        && config.typedText
        && !passed
      ) {
        process.stderr.write(
          "Hardware-smoke typed-text evidence failed and will not be retained.\n",
        );
      }
      if (keep && runRootCreated) {
        process.stderr.write(
          `Hardware-smoke evidence retained at ${recordingRoot ?? runRoot}\n`,
        );
      } else if (runRootCreated) {
        await rm(runRoot, { force: true, recursive: true });
      }
    }
  },
  HARDWARE_SMOKE_TIMEOUT_MS,
);
