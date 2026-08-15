import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPTURE_HELPER_VERSION,
  CAPTURE_PROTOCOL_VERSION,
  parseCaptureEvent,
  SegmentCompletionSchema,
  type CaptureOptions,
} from "../capture/protocol";
import { EditPlanIdSchema, RecordingManifestV3Schema } from "../contracts";
import {
  compileRenderPlan,
  createDefaultEditPlan,
  createNodeBundleFileSystem,
  loadRecordingManifest,
} from "../core";
import {
  CAPTURE_INTEGRITY_CHUNK_BYTES,
  CAPTURE_MEDIA_PROBE_TIMEOUT_MS,
  CaptureBundleWriter,
  CaptureMediaVerifier,
  hashCaptureOutputChunks,
} from "./capture-bundle";
import type { ProcessRunner, RunOptions, RunResult } from "./io";

const CAPTURE_OPTIONS: CaptureOptions = {
  camera: { kind: "default" },
  displays: { kind: "all" },
  excludedBundleIdentifiers: ["com.hraness.atet"],
  interactionEventProcessIdentifier: null,
  metadata: true,
  microphone: { kind: "default" },
  strictSources: false,
  systemAudio: true,
  typedText: false,
  typedTextFocusIdentities: null,
};

const PERMISSIONS = {
  accessibility: "authorized",
  camera: "authorized",
  inputMonitoring: "authorized",
  microphone: "authorized",
  screenCapture: "authorized",
  systemAudio: "authorized",
  windowMetadata: "authorized",
} as const;

const SOURCES = {
  audio: [
    { audioSourceId: "system-audio", channels: 2, kind: "system", label: "System", sampleRateHz: 48_000 },
    { audioSourceId: "microphone", channels: 1, kind: "microphone", label: "Mic", sampleRateHz: 48_000 },
  ],
  cameras: [{
    cameraId: "camera-1",
    frameRate: 30,
    label: "Camera",
    pixelSize: { height: 1_080, width: 1_920 },
    position: "front",
  }],
  displays: [
    {
      bounds: { height: 1_080, width: 1_920, x: 0, y: 0 },
      displayId: "display-primary",
      isPrimary: true,
      label: "Primary",
      pixelSize: { height: 2_160, width: 3_840 },
      refreshRateHz: 60,
      scaleFactor: 2,
    },
    {
      bounds: { height: 1_024, width: 1_280, x: -1_280, y: 0 },
      displayId: "display-left",
      isPrimary: false,
      label: "Left",
      pixelSize: { height: 1_024, width: 1_280 },
      refreshRateHz: 60,
      scaleFactor: 1,
    },
  ],
} as const;

const HOT_PLUGGED_PRIMARY = {
  ...SOURCES.displays[0],
  displayId: "display-hot-plugged",
  label: "Hot-plugged",
} as const;

class ProbeRunner implements ProcessRunner {
  readonly #cameraDurationUs: number;

  constructor(cameraDurationUs = 950_000) {
    this.#cameraDurationUs = cameraDurationUs;
  }

  run(argv: readonly [string, ...string[]]): Promise<RunResult> {
    const path = argv.at(-1) ?? "";
    const streams = path.includes("primary") || path.includes(HOT_PLUGGED_PRIMARY.displayId)
      ? [
          {
            codec_name: "h264",
            codec_type: "video",
            duration: "0.999900",
            id: "0x1",
            index: 0,
            start_time: "0.125000",
            time_base: "1/1000000",
          },
          {
            codec_name: "aac",
            codec_type: "audio",
            duration: "0.999800",
            id: "0x2",
            index: 1,
            start_time: "0.125250",
            time_base: "1/1000000",
          },
          {
            codec_name: "aac",
            codec_type: "audio",
            duration: "1.000000",
            id: "0x3",
            index: 2,
            start_time: "0.124000",
            time_base: "1/1000000",
          },
        ]
      : path.includes("microphone")
        ? [{
            codec_name: "aac",
            codec_type: "audio",
            duration: "0.999800",
            id: "0x1",
            index: 0,
            start_pts: "1024",
            time_base: "1/48000",
          }]
        : path.includes("camera")
          ? [{
              codec_name: "h264",
              codec_type: "video",
              duration: (this.#cameraDurationUs / 1_000_000).toFixed(6),
              id: "0x1",
              index: 0,
              start_time: "2.000000",
              time_base: "1/1000000",
            }, {
              codec_name: "tmcd",
              codec_type: "data",
              id: "0x2",
              index: 1,
            }]
          : [{
              codec_name: "h264",
              codec_type: "video",
              duration: "1.000000",
              id: "0x1",
              index: 0,
              start_time: "-0.250000",
              time_base: "1/1000000",
            }];
    return Promise.resolve({ exitCode: 0, stderr: "", stdout: JSON.stringify({ streams }) });
  }
}

class RejectLeftDisplayProbeRunner extends ProbeRunner {
  override run(argv: readonly [string, ...string[]]): Promise<RunResult> {
    if ((argv.at(-1) ?? "").includes("display-left")) {
      return Promise.reject(new Error("injected second-display verification failure"));
    }
    return super.run(argv);
  }
}

function streamTiming(
  nativeStartUs: number,
  durationUs: number,
  maximumSampleDurationUs: number,
  firstPtsUs: number,
) {
  const endPtsUs = firstPtsUs + durationUs;
  return {
    bufferCount: 30,
    clockAnchors: {
      end: { nativeTimeUs: nativeStartUs + durationUs, ptsUs: endPtsUs, uncertaintyUs: 100 },
      first: { nativeTimeUs: nativeStartUs, ptsUs: firstPtsUs, uncertaintyUs: 100 },
    },
    presentation: {
      endPtsUs,
      firstPtsUs,
      lastPtsUs: endPtsUs - maximumSampleDurationUs,
      maximumSampleDurationUs,
    },
    sampleCount: 30,
  };
}

interface SegmentOptions {
  readonly cameraDurationUs?: number;
  readonly systemAudioNativeOffsetUs?: number;
}

function segment(index: number, options: SegmentOptions = {}) {
  const startUs = index * 1_000_000;
  const nativeStartUs = 1_000_000 + index * 2_000_000;
  const suffix = String(index + 1).padStart(4, "0");
  const cameraDurationUs = options.cameraDurationUs ?? 950_000;
  const systemAudioNativeOffsetUs = options.systemAudioNativeOffsetUs ?? 150;
  return SegmentCompletionSchema.parse({
    camera: {
      availability: "recorded",
      containerDurationUs: cameraDurationUs,
      container: "mov",
      deviceId: "camera-1",
      label: "Camera",
      path: `segments/${suffix}/camera.mov`,
      streams: [{
        codec: "h264",
        mapping: "exact",
        role: "camera-video",
        streamIndex: 0,
        timing: streamTiming(nativeStartUs + 50, cameraDurationUs, 33_334, 8_000_000),
        trackId: 1,
      }],
    },
    clock: {
      end: { nativeTimeUs: nativeStartUs + 1_000_000, sourceTimeUs: startUs + 1_000_000 },
      kind: "mach-continuous-microseconds",
      start: { nativeTimeUs: nativeStartUs, sourceTimeUs: startUs },
    },
    diagnostics: [],
    displays: [
      {
        containerDurationUs: 1_000_000,
        container: "mp4",
        display: {
          bounds: SOURCES.displays[0].bounds,
          displayId: "display-primary",
          isPrimary: true,
          pixelHeight: 2_160,
          pixelWidth: 3_840,
          scaleFactor: 2,
        },
        path: `segments/${suffix}/display-primary.mp4`,
        streams: [
          {
            codec: "h264",
            mapping: "exact",
            role: "display-video",
            streamIndex: 9,
            timing: streamTiming(nativeStartUs + 100, 999_900, 16_667, 5_000_000),
            trackId: 1,
          },
          {
            channels: 2,
            codec: "aac",
            mapping: "exact",
            role: "system-audio",
            sampleRateHz: 48_000,
            streamIndex: 8,
            timing: streamTiming(
              nativeStartUs + systemAudioNativeOffsetUs,
              999_800,
              21_334,
              9_000_000,
            ),
            trackId: 2,
          },
          {
            channels: 2,
            codec: "aac",
            mapping: "provisional",
            role: "unclassified-audio",
            sampleRateHz: 48_000,
            streamIndex: 10,
            trackId: 3,
          },
        ],
      },
      {
        containerDurationUs: 1_000_000,
        container: "mp4",
        display: {
          bounds: SOURCES.displays[1].bounds,
          displayId: "display-left",
          isPrimary: false,
          pixelHeight: 1_024,
          pixelWidth: 1_280,
          scaleFactor: 1,
        },
        path: `segments/${suffix}/display-left.mp4`,
        streams: [{
          codec: "h264",
          mapping: "exact",
          role: "display-video",
          streamIndex: 4,
          timing: streamTiming(nativeStartUs, 1_000_000, 16_667, -250_000),
          trackId: 1,
        }],
      },
    ],
    index,
    metadata: [{
      droppedEvents: index,
      eventKinds: ["cursor.sample", "window.snapshot"],
      path: `events/segment-${suffix}.jsonl`,
      recordCount: 1,
    }],
    microphone: {
      availability: "recorded",
      containerDurationUs: 999_800,
      container: "m4a",
      deviceId: "microphone",
      label: "Mic",
      path: `segments/${suffix}/microphone.m4a`,
      streams: [{
        channels: 1,
        codec: "aac",
        mapping: "exact",
        role: "microphone-audio",
        sampleRateHz: 48_000,
        streamIndex: 7,
        timing: streamTiming(nativeStartUs + 200, 999_800, 21_334, 3_000_000),
        trackId: 1,
      }],
    },
    sources: SOURCES,
  });
}

function hotPluggedSegment(index: number) {
  const current = segment(index);
  const currentPrimary = current.displays.find(({ display }) => display.isPrimary);
  if (currentPrimary === undefined) throw new Error("Expected primary display fixture.");
  const suffix = String(index + 1).padStart(4, "0");
  return SegmentCompletionSchema.parse({
    ...current,
    displays: [{
      ...currentPrimary,
      display: {
        ...currentPrimary.display,
        bounds: HOT_PLUGGED_PRIMARY.bounds,
        displayId: HOT_PLUGGED_PRIMARY.displayId,
        pixelHeight: HOT_PLUGGED_PRIMARY.pixelSize.height,
        pixelWidth: HOT_PLUGGED_PRIMARY.pixelSize.width,
        scaleFactor: HOT_PLUGGED_PRIMARY.scaleFactor,
      },
      path: `segments/${suffix}/${HOT_PLUGGED_PRIMARY.displayId}.mp4`,
    }],
    sources: {
      ...current.sources,
      displays: [HOT_PLUGGED_PRIMARY],
    },
  });
}

async function materializeSegment(root: string, value: ReturnType<typeof segment>): Promise<void> {
  for (const path of [
    ...value.displays.map(({ path }) => path),
    ...(value.camera.availability === "recorded" ? [value.camera.path] : []),
    ...(value.microphone.availability === "recorded" ? [value.microphone.path] : []),
    ...value.metadata.map(({ path }) => path),
  ]) {
    const absolute = join(root, path);
    await mkdir(absolute.slice(0, absolute.lastIndexOf("/")), { recursive: true });
    await writeFile(absolute, path.endsWith(".jsonl") ? "{}\n" : `media:${path}`);
  }
}

async function assertCaptureSyncPublicationRejected(
  options: {
    readonly diagnosticCode: "capture-track-duration-drift" | "capture-track-onset-skew";
    readonly runner: ProbeRunner;
    readonly segment: ReturnType<typeof segment>;
  },
): Promise<void> {
  const temporary = await mkdtemp(join(tmpdir(), "atet-bundle-sync-rejection-test-"));
  const recordingRoot = join(temporary, "rec_sync_rejection");
  const configured = parseCaptureEvent({
    availableSources: SOURCES,
    event: "configured",
    lastInterruption: null,
    options: CAPTURE_OPTIONS,
    permissions: PERMISSIONS,
    protocolVersion: CAPTURE_PROTOCOL_VERSION,
    requestId: "configure-sync-rejection",
    sources: SOURCES,
    state: "ready",
  });
  if (configured.event !== "configured") throw new Error("Expected configured event.");
  const writer = new CaptureBundleWriter({
    bundleRoot: recordingRoot,
    captureOptions: CAPTURE_OPTIONS,
    configured,
    helperVersion: CAPTURE_HELPER_VERSION,
    now: () => new Date("2026-07-22T12:00:00.000Z"),
    recordingId: "rec_sync_rejection",
    toolVersion: "0.1.0",
    verifier: new CaptureMediaVerifier({ ffprobe: "ffprobe-test", runner: options.runner }),
  });
  try {
    await writer.initialize();
    await writer.setState("recording");
    await materializeSegment(recordingRoot, options.segment);
    await writer.appendSegment(options.segment, null);

    const measured = writer.manifest.tracks
      .flatMap(({ segments }) => segments)
      .find(({ timing }) => timing.kind === "measured" && timing.status === "out-of-tolerance");
    expect(measured?.timing).toMatchObject({ kind: "measured", status: "out-of-tolerance" });
    expect(writer.manifest.diagnostics.map(({ code }) => code)).toContain(options.diagnosticCode);

    expect(writer.setState("stopped", options.segment.clock.end.sourceTimeUs)).rejects.toMatchObject({
      code: "invalid-data",
      details: {
        diagnosticCode: "capture-sync-publication-rejected",
        violationCount: 1,
      },
    });

    const manifest = await loadRecordingManifest(createNodeBundleFileSystem(recordingRoot));
    expect(manifest.state).toBe("failed");
    expect(manifest.diagnostics.find(({ code }) => code === "capture-sync-publication-rejected")).toMatchObject({
      code: "capture-sync-publication-rejected",
      level: "error",
    });
    const preserved = manifest.tracks
      .flatMap(({ segments }) => segments)
      .find(({ segmentId }) => segmentId === measured?.segmentId);
    expect(preserved).toEqual(measured);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}

test("hashes capture output through bounded repeated reads", async () => {
  const bytes = Buffer.alloc(CAPTURE_INTEGRITY_CHUNK_BYTES * 2 + 37);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
  const requestedLengths: number[] = [];
  const reader = {
    read(buffer: Buffer, offset: number, length: number, position: number) {
      requestedLengths.push(length);
      const bytesRead = Math.min(length, 32_767, bytes.length - position);
      bytes.copy(buffer, offset, position, position + bytesRead);
      return Promise.resolve({ buffer, bytesRead });
    },
  };

  expect(await hashCaptureOutputChunks(reader, bytes.length)).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
  expect(requestedLengths.length).toBeGreaterThan(2);
  expect(Math.max(...requestedLengths)).toBeLessThanOrEqual(CAPTURE_INTEGRITY_CHUNK_BYTES);
});

test("bounds finalized timing probes and rejects helper/file span mismatches", async () => {
  let observedOptions: RunOptions | undefined;
  const boundedRunner: ProcessRunner = {
    run(argv, options) {
      observedOptions = options;
      return new ProbeRunner().run(argv);
    },
  };
  const display = segment(0).displays[1]!;
  await new CaptureMediaVerifier({ ffprobe: "ffprobe-test", runner: boundedRunner })
    .verify("/tmp/display-left.mp4", display.streams);
  expect(observedOptions).toMatchObject({
    maxOutputBytes: 1_000_000,
    timeoutMs: CAPTURE_MEDIA_PROBE_TIMEOUT_MS,
  });

  const mismatchedRunner: ProcessRunner = {
    run() {
      return Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({ streams: [{
          codec_name: "h264",
          codec_type: "video",
          duration: "1.100000",
          id: "0x1",
          index: 0,
          start_time: "0.000000",
          time_base: "1/1000000",
        }] }),
      });
    },
  };
  expect(
    new CaptureMediaVerifier({ ffprobe: "ffprobe-test", runner: mismatchedRunner })
      .verify("/tmp/display-left.mp4", display.streams),
  ).rejects.toMatchObject({
    code: "invalid-data",
    details: { diagnosticCode: "timing-evidence-mismatch" },
  });
});

test("rejects stopped publication while preserving measured onset-skew evidence", async () => {
  await assertCaptureSyncPublicationRejected({
    diagnosticCode: "capture-track-onset-skew",
    runner: new ProbeRunner(),
    segment: segment(0, { systemAudioNativeOffsetUs: 100_100 }),
  });
});

test("rejects stopped publication while preserving measured duration-drift evidence", async () => {
  await assertCaptureSyncPublicationRejected({
    diagnosticCode: "capture-track-duration-drift",
    runner: new ProbeRunner(900_000),
    segment: segment(0, { cameraDurationUs: 900_000 }),
  });
});

test("replaces preflight permissions and selected sources with post-request evidence", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-bundle-environment-test-"));
  const recordingRoot = join(temporary, "rec_environment001");
  const configured = parseCaptureEvent({
    availableSources: SOURCES,
    event: "configured",
    lastInterruption: null,
    options: CAPTURE_OPTIONS,
    permissions: { ...PERMISSIONS, camera: "not-determined", microphone: "not-determined" },
    protocolVersion: CAPTURE_PROTOCOL_VERSION,
    requestId: "configure-environment",
    sources: SOURCES,
    state: "ready",
  });
  if (configured.event !== "configured") throw new Error("Expected configured event.");
  const writer = new CaptureBundleWriter({
    bundleRoot: recordingRoot,
    captureOptions: CAPTURE_OPTIONS,
    configured,
    helperVersion: CAPTURE_HELPER_VERSION,
    now: () => new Date("2026-07-22T12:00:00.000Z"),
    recordingId: "rec_environment001",
    toolVersion: "0.1.0",
  });
  const freshPermissions = {
    ...PERMISSIONS,
    camera: "authorized",
    microphone: "denied",
  } as const;
  const selectedSources = {
    ...SOURCES,
    audio: SOURCES.audio.filter(({ kind }) => kind === "system"),
    cameras: [],
    displays: [{ ...SOURCES.displays[1], isPrimary: true }],
  };
  try {
    await writer.initialize();
    await writer.setCaptureEnvironment(freshPermissions, selectedSources);

    const manifest = await loadRecordingManifest(createNodeBundleFileSystem(recordingRoot));
    expect(manifest.kind).toBe("atet.recording-bundle");
    expect(manifest.tool.name).toBe("atet");
    expect(manifest.permissions).toEqual(freshPermissions);
    expect(manifest.sources).toEqual(selectedSources);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("persists completion interruption evidence without leaking available inventory", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-bundle-interruption-test-"));
  const recordingRoot = join(temporary, "rec_interruption001");
  const availableSources = {
    ...SOURCES,
    cameras: [{
      cameraId: "available-camera",
      frameRate: 30,
      label: "Available but unselected",
      pixelSize: { height: 720, width: 1_280 },
      position: "external",
    }],
  } as const;
  const configured = parseCaptureEvent({
    availableSources,
    event: "configured",
    lastInterruption: null,
    options: CAPTURE_OPTIONS,
    permissions: PERMISSIONS,
    protocolVersion: CAPTURE_PROTOCOL_VERSION,
    requestId: "configure-interruption",
    sources: SOURCES,
    state: "ready",
  });
  if (configured.event !== "configured") throw new Error("Expected configured event.");
  const writer = new CaptureBundleWriter({
    bundleRoot: recordingRoot,
    captureOptions: CAPTURE_OPTIONS,
    configured,
    helperVersion: CAPTURE_HELPER_VERSION,
    now: () => new Date("2026-07-22T12:00:00.000Z"),
    recordingId: "rec_interruption001",
    toolVersion: "0.1.0",
    verifier: new CaptureMediaVerifier({
      ffprobe: "ffprobe-test",
      runner: new ProbeRunner(),
    }),
  });
  const completed = segment(0);
  const interruption = {
    code: "screen-stream-stopped",
    nativeTimeUs: completed.clock.end.nativeTimeUs,
    recoverable: true,
    segmentIndex: completed.index,
    source: "screen",
    sourceId: "display-primary",
    sourceTimeUs: completed.clock.end.sourceTimeUs,
  } as const;
  try {
    await writer.initialize();
    await writer.setState("recording");
    await materializeSegment(recordingRoot, completed);
    await writer.appendSegment(completed, interruption);

    const manifest = await loadRecordingManifest(
      createNodeBundleFileSystem(recordingRoot),
    );
    expect(manifest).toMatchObject({
      interruptions: [interruption],
      schemaVersion: 3,
      sources: SOURCES,
    });
    expect(manifest.diagnostics.some((diagnostic) => (
      diagnostic.code === "capture-interruption-screen-stream-stopped"
      && diagnostic.count === 1
      && diagnostic.firstSourceTimeUs === interruption.sourceTimeUs
      && diagnostic.lastSourceTimeUs === interruption.sourceTimeUs
      && diagnostic.level === "warning"
    ))).toBeTrue();
    expect(manifest.sources).not.toEqual(availableSources);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("preserves an interrupted completion frontier without admitting partially verified media", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-bundle-rejected-segment-test-"));
  const recordingRoot = join(temporary, "rec_rejected_segment001");
  const configured = parseCaptureEvent({
    availableSources: SOURCES,
    event: "configured",
    lastInterruption: null,
    options: CAPTURE_OPTIONS,
    permissions: PERMISSIONS,
    protocolVersion: CAPTURE_PROTOCOL_VERSION,
    requestId: "configure-rejected-segment",
    sources: SOURCES,
    state: "ready",
  });
  if (configured.event !== "configured") throw new Error("Expected configured event.");
  const writer = new CaptureBundleWriter({
    bundleRoot: recordingRoot,
    captureOptions: CAPTURE_OPTIONS,
    configured,
    helperVersion: CAPTURE_HELPER_VERSION,
    now: () => new Date("2026-07-22T12:00:00.000Z"),
    recordingId: "rec_rejected_segment001",
    toolVersion: "0.1.0",
    verifier: new CaptureMediaVerifier({
      ffprobe: "ffprobe-test",
      runner: new RejectLeftDisplayProbeRunner(),
    }),
  });
  const completed = segment(0);
  const interruption = {
    code: "screen-stream-stopped",
    nativeTimeUs: completed.clock.end.nativeTimeUs,
    recoverable: true,
    segmentIndex: completed.index,
    source: "screen",
    sourceId: "display-left",
    sourceTimeUs: completed.clock.end.sourceTimeUs,
  } as const;
  try {
    await writer.initialize();
    await writer.setState("recording");
    await materializeSegment(recordingRoot, completed);
    let failure: unknown;
    try {
      await writer.appendSegment(completed, interruption);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);

    await writer.recordFailedSegmentCompletion(completed, interruption, failure);
    await writer.recordFailedSegmentCompletion(completed, interruption, failure);

    const manifest = await loadRecordingManifest(
      createNodeBundleFileSystem(recordingRoot),
    );
    expect(manifest).toMatchObject({
      eventStreams: [],
      interruptions: [interruption],
      state: "failed",
      timeline: {
        durationUs: completed.clock.end.sourceTimeUs,
        nativeClock: {
          segments: [{
            index: completed.index,
            nativeRange: {
              endUs: completed.clock.end.nativeTimeUs,
              startUs: completed.clock.start.nativeTimeUs,
            },
            sourceRange: {
              endUs: completed.clock.end.sourceTimeUs,
              startUs: completed.clock.start.sourceTimeUs,
            },
          }],
        },
      },
      tracks: [],
    });
    const publicationFailures = manifest.diagnostics.filter(({ code }) =>
      code === "capture-segment-publication-failed"
    );
    expect(publicationFailures).toHaveLength(1);
    expect(publicationFailures[0]).toMatchObject({
      count: 1,
      firstSourceTimeUs: completed.clock.end.sourceTimeUs,
      lastSourceTimeUs: completed.clock.end.sourceTimeUs,
      level: "error",
    });
    const interruptionDiagnostics = manifest.diagnostics.filter(({ code }) =>
      code === "capture-interruption-screen-stream-stopped"
    );
    expect(interruptionDiagnostics).toHaveLength(1);
    expect(interruptionDiagnostics[0]).toMatchObject({
      count: 1,
      level: "warning",
    });
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("records one failed prepared-start interruption before fatal settlement", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-bundle-failure-interruption-test-"));
  const recordingRoot = join(temporary, "rec_failure_interruption001");
  const configured = parseCaptureEvent({
    availableSources: SOURCES,
    event: "configured",
    lastInterruption: null,
    options: CAPTURE_OPTIONS,
    permissions: PERMISSIONS,
    protocolVersion: CAPTURE_PROTOCOL_VERSION,
    requestId: "configure-failure-interruption",
    sources: SOURCES,
    state: "ready",
  });
  if (configured.event !== "configured") throw new Error("Expected configured event.");
  const writer = new CaptureBundleWriter({
    bundleRoot: recordingRoot,
    captureOptions: CAPTURE_OPTIONS,
    configured,
    helperVersion: CAPTURE_HELPER_VERSION,
    now: () => new Date("2026-07-22T12:00:00.000Z"),
    recordingId: "rec_failure_interruption001",
    toolVersion: "0.1.0",
  });
  const interruption = {
    code: "camera-runtime-error",
    nativeTimeUs: 10_000_000,
    recoverable: false,
    segmentIndex: 0,
    source: "camera",
    sourceId: "camera-1",
    sourceTimeUs: 0,
  } as const;
  try {
    await writer.initialize();
    await writer.setState("recording");
    await writer.recordFailureInterruption(interruption);
    await writer.recordFailureInterruption(interruption);

    const manifest = await loadRecordingManifest(
      createNodeBundleFileSystem(recordingRoot),
    );
    expect(manifest).toMatchObject({
      interruptions: [interruption],
      state: "failed",
      timeline: { durationUs: 0 },
    });
    expect(manifest.diagnostics.find(({ code }) =>
      code === "capture-interruption-camera-runtime-error"
    )).toMatchObject({ count: 1, level: "error" });
    expect(writer.recordFailureInterruption({
      ...interruption,
      code: "camera-recording-failed",
    })).rejects.toMatchObject({ code: "invalid-data" });
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("resume preserves historical displays and one stable primary across hot-plugging", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-bundle-resume-sources-test-"));
  const recordingRoot = join(temporary, "rec_resume_sources001");
  const configured = parseCaptureEvent({
    availableSources: SOURCES,
    event: "configured",
    lastInterruption: null,
    options: CAPTURE_OPTIONS,
    permissions: PERMISSIONS,
    protocolVersion: CAPTURE_PROTOCOL_VERSION,
    requestId: "configure-resume-sources",
    sources: SOURCES,
    state: "ready",
  });
  if (configured.event !== "configured") throw new Error("Expected configured event.");
  const writer = new CaptureBundleWriter({
    bundleRoot: recordingRoot,
    captureOptions: CAPTURE_OPTIONS,
    configured,
    helperVersion: CAPTURE_HELPER_VERSION,
    now: () => new Date("2026-07-22T12:00:00.000Z"),
    recordingId: "rec_resume_sources001",
    toolVersion: "0.1.0",
    verifier: new CaptureMediaVerifier({ ffprobe: "ffprobe-test", runner: new ProbeRunner() }),
  });
  const completed = segment(0);
  const resumed = hotPluggedSegment(1);
  try {
    await writer.initialize();
    await writer.setState("recording");
    await materializeSegment(recordingRoot, completed);
    await writer.appendSegment(completed, null);
    await writer.setState("paused", completed.clock.end.sourceTimeUs);

    await writer.setCaptureEnvironment(PERMISSIONS, {
      ...SOURCES,
      displays: [HOT_PLUGGED_PRIMARY],
    });

    const resumedManifest = await loadRecordingManifest(createNodeBundleFileSystem(recordingRoot));
    expect(resumedManifest.sources.displays.map(({ displayId }) => displayId)).toEqual([
      "display-primary",
      "display-left",
      "display-hot-plugged",
    ]);
    expect(resumedManifest.sources.displays.filter(({ isPrimary }) => isPrimary).map(({ displayId }) => displayId))
      .toEqual(["display-primary"]);
    expect(resumedManifest.sources.displays.find(({ displayId }) => displayId === "display-hot-plugged")?.isPrimary)
      .toBe(false);

    await writer.setState("recording", completed.clock.end.sourceTimeUs);
    await materializeSegment(recordingRoot, resumed);
    await writer.appendSegment(resumed, null);
    await writer.setState("stopped", resumed.clock.end.sourceTimeUs);

    const finalManifest = await loadRecordingManifest(createNodeBundleFileSystem(recordingRoot));
    expect(() => RecordingManifestV3Schema.parse(finalManifest)).not.toThrow();
    expect(finalManifest.sources.displays.filter(({ isPrimary }) => isPrimary).map(({ displayId }) => displayId))
      .toEqual(["display-primary"]);
    const resumedReferenceTrack = finalManifest.tracks.find((track) =>
      track.kind === "display-video"
      && track.source.displayId === HOT_PLUGGED_PRIMARY.displayId
    );
    if (resumedReferenceTrack === undefined) throw new Error("Missing resumed display reference track.");
    const resumedTimings = finalManifest.tracks.flatMap(({ segments }) =>
      segments.flatMap(({ timing }) =>
        timing.kind === "measured" && timing.captureSegmentIndex === resumed.index
          ? [timing]
          : []
      )
    );
    expect(resumedTimings.length).toBeGreaterThan(0);
    expect(resumedTimings.every(({ referenceTrackId }) => referenceTrackId === resumedReferenceTrack.trackId))
      .toBe(true);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("finalizes two displays, shared audio, camera, metadata, and pause/resume segments", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-bundle-test-"));
  const recordingRoot = join(temporary, "rec_bundle001");
  const configured = parseCaptureEvent({
    availableSources: SOURCES,
    event: "configured",
    lastInterruption: null,
    options: CAPTURE_OPTIONS,
    permissions: PERMISSIONS,
    protocolVersion: CAPTURE_PROTOCOL_VERSION,
    requestId: "configure-1",
    sources: SOURCES,
    state: "ready",
  });
  if (configured.event !== "configured") throw new Error("Expected configured event.");
  const writer = new CaptureBundleWriter({
    bundleRoot: recordingRoot,
    captureOptions: CAPTURE_OPTIONS,
    configured,
    helperVersion: CAPTURE_HELPER_VERSION,
    now: () => new Date("2026-07-22T12:00:00.000Z"),
    recordingId: "rec_bundle001",
    toolVersion: "0.1.0",
    verifier: new CaptureMediaVerifier({ ffprobe: "ffprobe-test", runner: new ProbeRunner() }),
  });
  try {
    await writer.initialize();
    await writer.setState("recording");
    for (const value of [segment(0), segment(1)]) {
      await materializeSegment(recordingRoot, value);
      await writer.appendSegment(value, null);
      await writer.setState(
        value.index === 0 ? "paused" : "recording",
        value.clock.end.sourceTimeUs,
      );
      if (value.index === 0) {
        await writer.setCaptureEnvironment(PERMISSIONS, {
          ...SOURCES,
          displays: [SOURCES.displays[0]],
        });
        expect(writer.manifest.sources.displays.map(({ displayId }) => displayId))
          .toEqual(["display-primary", "display-left"]);
      }
    }
    await writer.setState("stopped", 2_000_000);

    const manifest = await loadRecordingManifest(createNodeBundleFileSystem(recordingRoot));
    expect(manifest.state).toBe("stopped");
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.timeline.durationUs).toBe(2_000_000);
    if (manifest.schemaVersion !== 3) throw new Error("Expected a measured v3 manifest.");
    expect(manifest.timeline.nativeClock.segments).toEqual([
      {
        index: 0,
        nativeRange: { endUs: 2_000_000, startUs: 1_000_000 },
        sourceRange: { endUs: 1_000_000, startUs: 0 },
      },
      {
        index: 1,
        nativeRange: { endUs: 4_000_000, startUs: 3_000_000 },
        sourceRange: { endUs: 2_000_000, startUs: 1_000_000 },
      },
    ]);
    expect(manifest.sources.displays).toHaveLength(2);
    expect(manifest.tracks.map(({ kind }) => kind).sort()).toEqual([
      "camera-video",
      "display-video",
      "display-video",
      "microphone-audio",
      "system-audio",
    ]);
    expect(manifest.tracks.every(({ segments }) => segments.length === 2)).toBeTrue();
    expect(manifest.tracks.flatMap(({ segments }) => segments).map(({ streamIndex }) => streamIndex)).not.toContain(9);
    expect(manifest.eventStreams).toHaveLength(2);
    expect(manifest.diagnostics.find(({ code }) => code === "metadata-dropped-events")).toMatchObject({ count: 1 });

    const primary = manifest.tracks.find((track) =>
      track.kind === "display-video" && track.source.displayId === "display-primary"
    );
    if (primary === undefined) throw new Error("Missing primary display track.");
    const primarySegment = primary.segments[0]!;
    expect(primarySegment.fileRange).toEqual({ endUs: 1_000_900, startUs: 1_000 });
    expect(primarySegment.timing).toMatchObject({
      captureSegmentIndex: 0,
      durationDriftPpm: 0,
      durationDriftUs: 0,
      evidence: {
        file: {
          containerOriginPtsUs: 124_000,
          endPtsUs: 1_124_900,
          firstPtsUs: 125_000,
        },
        helper: {
          containerDurationUs: 1_000_000,
          presentation: { firstPtsUs: 5_000_000 },
        },
      },
      onsetSkewUs: 0,
      status: "within-tolerance",
    });
    const systemAudio = manifest.tracks.find(({ kind }) => kind === "system-audio");
    expect(systemAudio?.segments[0]?.fileRange).toEqual({ endUs: 1_001_050, startUs: 1_250 });
    const microphone = manifest.tracks.find(({ kind }) => kind === "microphone-audio");
    expect(microphone?.segments[0]?.timing).toMatchObject({
      evidence: {
        file: {
          containerOriginPtsUs: 21_333,
          firstPtsUs: 21_333,
        },
      },
    });
    const audioTrackIds = manifest.tracks.filter((track) =>
      track.kind === "system-audio" || track.kind === "microphone-audio"
    ).map(({ trackId }) => trackId);
    const plan = createDefaultEditPlan(
      manifest,
      EditPlanIdSchema.parse("plan_bundle001"),
      "2026-07-22T12:00:00.000Z",
    );
    const render = compileRenderPlan(manifest, plan, [], {
      audioTrackIds,
      camera: { kind: "none" },
      displayTrackId: primary.trackId,
      frameRate: 60,
      pixelHeight: 1_080,
      pixelWidth: 1_920,
    });
    expect(render.sourceSegments.filter(({ trackId }) => trackId === primary.trackId)).toHaveLength(2);
    expect(render.sourceSegments.some(({ streamIndex }) => streamIndex === 1)).toBeTrue();
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});
