import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { VideoProjectV1Schema, type VideoProjectV1 } from "../contracts";
import type {
  SceneDescriptionProvider,
  SceneProviderRequest,
} from "@hraness/transmute/scene";
import { BunProcessRunner, type ProcessRunner, type RunResult } from "./io";
import {
  SCENE_EXTRACTION_CONCURRENCY,
  analyzeProjectScenes,
  parseExtractedFramePtsTimeUs,
  parseSceneDetectionLog,
  resolveVideoAnalysisSubject,
} from "./scene-analysis-service";

const NOW = "2026-07-22T12:00:00.000Z";
const MEDIA_CONTENT = "fixture";
const MEDIA_SHA256 = createHash("sha256").update(MEDIA_CONTENT).digest("hex");
const FFMPEG = Bun.which("ffmpeg");

function fixtureProject(mediaPath: string): VideoProjectV1 {
  return VideoProjectV1Schema.parse({
    analyses: [],
    assets: [{
      assetId: "asset_scenefixture",
      createdAt: NOW,
      durationUs: 3_000_000,
      label: "Screen take",
      role: "screen",
      source: { importedAt: NOW, kind: "imported", originalName: "screen.mov", sourceSha256: MEDIA_SHA256 },
      streams: [{
        frameRate: 30,
        kind: "video",
        label: "Screen",
        pixelHeight: 1080,
        pixelWidth: 1920,
        role: "screen",
        segments: [{
          assetRange: { endUs: 3_000_000, startUs: 0 },
          bytes: Buffer.byteLength(MEDIA_CONTENT),
          codec: "h264",
          container: "mov",
          fileRange: { endUs: 3_500_000, startUs: 500_000 },
          path: mediaPath,
          sha256: MEDIA_SHA256,
          streamIndex: 2,
        }],
        streamId: "stream_scenefixture",
      }],
    }],
    createdAt: NOW,
    currentEditPlanPath: "edits/current.json",
    kind: "studio.video-project",
    name: "Scene fixture",
    placements: [{
      assetId: "asset_scenefixture",
      assetRange: { endUs: 3_000_000, startUs: 0 },
      audio: [],
      enabled: true,
      placementId: "placement_scenefixture",
      sync: {
        anchors: [{ assetTimeUs: 0, projectTimeUs: 0 }, { assetTimeUs: 3_000_000, projectTimeUs: 3_000_000 }],
        provenance: { kind: "identity" },
      },
      video: [{
        presentation: {
          blendMode: "normal",
          crop: { kind: "none" },
          enabled: true,
          fit: "fill",
          layer: 0,
          layout: { height: 1, kind: "normalized", width: 1, x: 0, y: 0 },
          opacity: 1,
        },
        streamId: "stream_scenefixture",
      }],
    }],
    projectId: "project_scenefixture",
    referencePlacementId: "placement_scenefixture",
    schemaVersion: 1,
    timeline: { durationUs: 3_000_000, timebase: "microseconds" },
    updatedAt: NOW,
  });
}

function nativeVideoProject(
  mediaPath: string,
  bytes: number,
  sha256: string,
  durationUs: number,
  frameRate: number,
  originalName: string,
): VideoProjectV1 {
  const project = fixtureProject(mediaPath);
  const asset = project.assets[0]!;
  const stream = asset.streams[0]!;
  const segment = stream.segments[0]!;
  return VideoProjectV1Schema.parse({
    ...project,
    assets: [{
      ...asset,
      durationUs,
      source: {
        ...asset.source,
        originalName,
        sourceSha256: sha256,
      },
      streams: [{
        ...stream,
        frameRate,
        segments: [{
          ...segment,
          assetRange: { endUs: durationUs, startUs: 0 },
          bytes,
          container: "mp4",
          fileRange: { endUs: durationUs, startUs: 0 },
          sha256,
          streamIndex: 0,
        }],
      }],
    }],
    placements: [{
      ...project.placements[0]!,
      assetRange: { endUs: durationUs, startUs: 0 },
      sync: {
        anchors: [
          { assetTimeUs: 0, projectTimeUs: 0 },
          { assetTimeUs: durationUs, projectTimeUs: durationUs },
        ],
        provenance: { kind: "identity" },
      },
    }],
    timeline: { durationUs, timebase: "microseconds" },
  });
}

function sparseVfrProject(mediaPath: string, bytes: number, sha256: string): VideoProjectV1 {
  return nativeVideoProject(
    mediaPath,
    bytes,
    sha256,
    2_600_000,
    10,
    "sparse-vfr.mp4",
  );
}

class SceneRunner implements ProcessRunner {
  static readonly DECODED_FRAME_PTS_US = [
    500_000,
    800_000,
    1_100_000,
    1_900_000,
    2_100_000,
    3_000_000,
  ] as const;

  readonly #delayMs: number;
  readonly #jpegMarker: number;
  #activeExtractions = 0;
  #maximumActiveExtractions = 0;
  #mutableCalls: [string, ...string[]][] = [];

  constructor(delayMs = 0, jpegMarker = 1) {
    this.#delayMs = delayMs;
    this.#jpegMarker = jpegMarker;
  }

  get maximumActiveExtractions(): number {
    return this.#maximumActiveExtractions;
  }

  get recordedCalls(): readonly (readonly string[])[] {
    return this.#mutableCalls;
  }

  async run(argv: readonly [string, ...string[]]): Promise<RunResult> {
    this.#mutableCalls.push([...argv] as [string, ...string[]]);
    if (argv.at(-1) === "-" && !argv.includes("framecrc")) {
      return { exitCode: 0, stderr: "[showinfo] n:1 pts:42 pts_time:1.500 pos:99", stdout: "" };
    }
    const seekIndex = argv.indexOf("-ss");
    const seekTimeUs = Math.round(Number(argv[seekIndex + 1]) * 1_000_000);
    const durationIndex = argv.indexOf("-t");
    const extractionEndUs = seekTimeUs + Math.round(Number(argv[durationIndex + 1]) * 1_000_000);
    const decodedTimesUs = SceneRunner.DECODED_FRAME_PTS_US
      .filter(candidate => candidate >= seekTimeUs && candidate < extractionEndUs);
    if (argv.includes("framecrc")) {
      const selectedTimesUs = argv.includes("-frames:v")
        ? decodedTimesUs.slice(0, 1)
        : decodedTimesUs;
      return {
        exitCode: 0,
        stderr: "",
        stdout: [
          "#tb 0: 1/1000000",
          ...selectedTimesUs.map(timestamp =>
            `0, ${timestamp}, ${timestamp}, 1, 4, 0x00000000`),
        ].join("\n"),
      };
    }
    const decodedTimeUs = decodedTimesUs[0];
    const jpegOutput = argv.find(argument => argument.endsWith(".jpg"));
    const grayOutput = argv.find(argument => argument.endsWith(".gray"));
    if (jpegOutput === undefined || grayOutput === undefined) throw new Error("Missing derived frame outputs.");
    this.#activeExtractions += 1;
    this.#maximumActiveExtractions = Math.max(this.#maximumActiveExtractions, this.#activeExtractions);
    try {
      if (this.#delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, this.#delayMs));
      }
      if (decodedTimeUs !== undefined) {
        await Promise.all([
          writeFile(grayOutput, Uint8Array.from({ length: 72 }, (_, index) => index)),
          writeFile(jpegOutput, Uint8Array.from([0xff, 0xd8, this.#jpegMarker, 2, 3, 0xff, 0xd9])),
        ]);
      }
    } finally {
      this.#activeExtractions -= 1;
    }
    return {
      exitCode: 0,
      stderr: decodedTimeUs === undefined
        ? "[Parsed_showinfo_1] config in time_base: 1/1000000"
        : [
            "[Parsed_showinfo_1] config in time_base: 1/1000000",
            `[Parsed_showinfo_1] n: 0 pts: ${decodedTimeUs} pts_time:${decodedTimeUs / 1_000_000}`,
          ].join("\n"),
      stdout: "",
    };
  }
}

function sceneProvider(onCall: (request: SceneProviderRequest) => void): SceneDescriptionProvider {
  return {
    describe: (request) => {
      onCall(request);
      return Promise.resolve({
    descriptions: request.scenes.map(scene => ({
      description: {
        activities: ["editing"],
        contentKind: "screen",
        modelConfidence: 0.9,
        setting: "desktop",
        subjects: ["application window"],
        summary: "A desktop application is visible.",
        title: "Desktop",
        trust: "untrusted-model-output",
        visibleTextSummary: "No reliable text transcription.",
      },
      sceneId: scene.sceneId,
    })),
    resolvedModel: "google/gemini-3-flash",
    usage: {
      inputTokens: 12,
      outputTokens: 6,
      uploadedBytes: request.scenes.flatMap(scene => scene.frames)
        .reduce((total, frame) => total + frame.bytes.byteLength, 0),
      uploadedImages: request.scenes.flatMap(scene => scene.frames).length,
    },
      });
    },
  };
}

async function executeNativeSceneAnalysis(options: {
  readonly analysisId: string;
  readonly durationUs: number;
  readonly frameRate: number;
  readonly media: string;
  readonly originalName: string;
  readonly projectDirectory: string;
  readonly repositoryRoot: string;
  readonly sceneThreshold?: number;
}) {
  if (FFMPEG === null) throw new Error("FFmpeg unexpectedly unavailable.");
  const mediaBytes = await readFile(options.media);
  const mediaSha256 = createHash("sha256").update(mediaBytes).digest("hex");
  const nativeRunner = new BunProcessRunner();
  const calls: {
    readonly argv: readonly [string, ...string[]];
    readonly maxOutputBytes: number | undefined;
  }[] = [];
  const runner: ProcessRunner = {
    run: async (argv, runOptions) => {
      calls.push({ argv, maxOutputBytes: runOptions?.maxOutputBytes });
      return await nativeRunner.run(argv, runOptions);
    },
  };
  const result = await analyzeProjectScenes({
    acknowledgedAt: NOW,
    analysisId: options.analysisId,
    createdAt: NOW,
    execute: true,
    ffmpeg: FFMPEG,
    maximumSceneDurationUs: options.durationUs,
    model: "google/gemini-3-flash",
    project: nativeVideoProject(
      relative(options.repositoryRoot, options.media),
      mediaBytes.byteLength,
      mediaSha256,
      options.durationUs,
      options.frameRate,
      options.originalName,
    ),
    projectDirectory: options.projectDirectory,
    provider: sceneProvider(() => {}),
    repositoryRoot: options.repositoryRoot,
    runner,
    sceneThreshold: options.sceneThreshold ?? 1,
    source: "asset_scenefixture:stream_scenefixture",
  });
  if (result.kind !== "complete") throw new Error("Expected completed native scene analysis.");
  return { calls, result };
}

describe("scene analysis service", () => {
  test("resolves video identities and maps FFmpeg file timestamps into asset time", () => {
    const project = fixtureProject("imports/screen.mov");
    const resolved = resolveVideoAnalysisSubject(project, "asset_scenefixture:stream_scenefixture");
    expect(resolved.subject.integritySha256).toHaveLength(64);
    const segment = resolved.stream.segments[0]!;
    expect(parseSceneDetectionLog("pts_time:0.5 pts_time:1.5 pts_time:3.5", segment, 0.35))
      .toEqual([{ confidence: 0.35, kind: "visual", timeUs: 1_000_000 }]);
    expect(parseExtractedFramePtsTimeUs(
      [
        "[Parsed_showinfo_1 @ 0x01] config in time_base: 1/1000000, frame_rate: 2/1",
        "[Parsed_showinfo_1 @ 0x01] n:   0 pts: 3000000 pts_time:3 duration:500000",
      ].join("\n"),
    )).toBe(3_000_000);
    expect(parseExtractedFramePtsTimeUs(
      [
        "[Parsed_showinfo_1 @ 0x01] config in time_base: 1/16384, frame_rate: 2/1",
        "[Parsed_showinfo_1 @ 0x01] n:   0 pts: 49152 pts_time:3 duration:8192",
      ].join("\n"),
    )).toBeNull();
    expect(() => resolveVideoAnalysisSubject(project, "asset_scenefixture:missing"))
      .toThrow(/Unknown video stream/u);

    const changedMapping = VideoProjectV1Schema.parse({
      ...project,
      assets: project.assets.map(asset => asset.assetId !== "asset_scenefixture" ? asset : {
        ...asset,
        streams: asset.streams.map(stream => stream.streamId !== "stream_scenefixture" ? stream : {
          ...stream,
          segments: stream.segments.map(candidate => ({
            ...candidate,
            bytes: candidate.bytes + 1,
            codec: "hevc",
            fileRange: { endUs: candidate.fileRange.endUs + 1, startUs: candidate.fileRange.startUs + 1 },
          })),
        }),
      }),
    });
    expect(resolveVideoAnalysisSubject(changedMapping, "asset_scenefixture:stream_scenefixture")
      .subject.integritySha256).not.toBe(resolved.subject.integritySha256);
  });

  test("plans locally by default and uploads only bounded derived JPEG samples when executed", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "transmute-scenes-"));
    const projectDirectory = join(repositoryRoot, "artifacts", "transmute", "projects", "project_scenefixture");
    const mediaDirectory = join(repositoryRoot, "imports");
    await Promise.all([mkdir(projectDirectory, { recursive: true }), mkdir(mediaDirectory, { recursive: true })]);
    const media = join(mediaDirectory, "screen.mov");
    await writeFile(media, MEDIA_CONTENT);
    const project = fixtureProject(relative(repositoryRoot, media));
    try {
      const dryRunner = new SceneRunner();
      const dryRun = await analyzeProjectScenes({
        acknowledgedAt: NOW,
        analysisId: "analysis_scenefixture",
        createdAt: NOW,
        execute: false,
        ffmpeg: "/usr/bin/ffmpeg",
        maximumSceneDurationUs: 2_000_000,
        model: "google/gemini-3-flash",
        project,
        projectDirectory,
        repositoryRoot,
        runner: dryRunner,
        sceneThreshold: 0.35,
        source: "asset_scenefixture:stream_scenefixture",
      });
      expect(dryRun.kind).toBe("planned");
      expect(dryRunner.recordedCalls).toHaveLength(1);

      const runner = new SceneRunner(5);
      let providerCalls = 0;
      const provider = sceneProvider(() => {
        providerCalls += 1;
      });
      const executed = await analyzeProjectScenes({
        acknowledgedAt: NOW,
        analysisId: "analysis_scenefixture",
        createdAt: NOW,
        execute: true,
        ffmpeg: "/usr/bin/ffmpeg",
        maximumSceneDurationUs: 2_000_000,
        model: "google/gemini-3-flash",
        project,
        projectDirectory,
        provider,
        repositoryRoot,
        runner,
        sceneThreshold: 0.35,
        source: "asset_scenefixture:stream_scenefixture",
      });
      expect(executed.kind).toBe("complete");
      if (executed.kind !== "complete") throw new Error("Expected completed scene analysis.");
      expect(executed.analysis.kind).toBe("transmute.scene-analysis");
      expect(executed.analysis.scenes).toHaveLength(2);
      expect(executed.analysis.batches.every(batch => batch.state === "complete")).toBe(true);
      expect(executed.analysis.samples).toHaveLength(6);
      expect(executed.analysis.samples.map(sample => String(sample.sampleId)))
        .toEqual(executed.plan.samples.map(sample => String(sample.sampleId)));
      expect(executed.analysis.usage.uploadedImages).toBe(2);
      expect(executed.analysis.samples.every(sample => sample.path.endsWith(`${sample.sha256}.jpg`))).toBe(true);
      expect(runner.recordedCalls.length).toBeGreaterThan(1 + executed.analysis.samples.length);
      const jpegCalls = runner.recordedCalls
        .filter(call => call.some(argument => argument.endsWith(".jpg")));
      expect(jpegCalls).toHaveLength(executed.analysis.samples.length);
      expect(jpegCalls.every(call => call.some(
        (argument, index) => argument === "-pix_fmt" && call[index + 1] === "yuvj420p",
      ))).toBe(true);
      expect(jpegCalls.every(call =>
        call.includes("-copyts")
        && call.includes("-start_at_zero")
        && call.includes("-seek_timestamp")
      )).toBe(true);
      const discoveryCalls = runner.recordedCalls
        .filter(call => call.includes("framecrc"));
      expect(discoveryCalls.length).toBeGreaterThan(executed.analysis.samples.length);
      expect(discoveryCalls.every(call =>
        call.includes("-copyts")
        && call.includes("-start_at_zero")
        && call.includes("-seek_timestamp")
      )).toBe(true);
      const extractionSeekTimes = discoveryCalls.flatMap(call => call.flatMap(
        (argument, index) => argument === "-ss" ? [call[index + 1]] : [],
      ));
      expect(extractionSeekTimes).toContain("3.499999");
      expect(extractionSeekTimes).toContain("3.249999");
      expect(extractionSeekTimes).toContain("2.999999");
      const finalRequestedSample = executed.analysis.samples
        .find(sample => sample.requestedAssetTimeUs === 2_999_999);
      expect(finalRequestedSample?.actualAssetTimeUs).toBe(2_500_000);
      expect(runner.maximumActiveExtractions).toBeGreaterThan(1);
      expect(runner.maximumActiveExtractions).toBeLessThanOrEqual(SCENE_EXTRACTION_CONCURRENCY);

      const cached = await analyzeProjectScenes({
        acknowledgedAt: NOW,
        analysisId: "analysis_scenecached",
        createdAt: NOW,
        execute: true,
        ffmpeg: "/usr/bin/ffmpeg",
        maximumSceneDurationUs: 2_000_000,
        model: "google/gemini-3-flash",
        project,
        projectDirectory,
        provider,
        repositoryRoot,
        runner: new SceneRunner(),
        sceneThreshold: 0.35,
        source: "asset_scenefixture:stream_scenefixture",
      });
      expect(cached.kind).toBe("complete");
      if (cached.kind !== "complete") throw new Error("Expected cached scene analysis.");
      expect(providerCalls).toBe(1);
      expect(cached.analysis.scenes).toEqual(executed.analysis.scenes);
      expect(cached.analysis.usage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        uploadedBytes: 0,
        uploadedImages: 0,
      });

      const changedFrames = await analyzeProjectScenes({
        acknowledgedAt: NOW,
        analysisId: "analysis_sceneframechange",
        createdAt: NOW,
        execute: true,
        ffmpeg: "/usr/bin/ffmpeg",
        maximumSceneDurationUs: 2_000_000,
        model: "google/gemini-3-flash",
        project,
        projectDirectory,
        provider,
        repositoryRoot,
        runner: new SceneRunner(0, 9),
        sceneThreshold: 0.35,
        source: "asset_scenefixture:stream_scenefixture",
      });
      expect(changedFrames.kind).toBe("complete");
      if (changedFrames.kind !== "complete") throw new Error("Expected changed-frame scene analysis.");
      expect(providerCalls).toBe(2);
      expect(changedFrames.analysis.samples.map(sample => sample.path))
        .not.toEqual(executed.analysis.samples.map(sample => sample.path));
      for (const sample of [...executed.analysis.samples, ...changedFrames.analysis.samples]) {
        expect((await readFile(join(repositoryRoot, sample.path))).byteLength).toBe(sample.bytes);
      }

      const batchKey = executed.analysis.batches[0]!.batchKey;
      const cacheTarget = join(projectDirectory, "analysis", "scene-cache", `${batchKey}.json`);
      await rm(cacheTarget, { force: true });
      await mkdir(cacheTarget);
      const cacheWriteFailure = await analyzeProjectScenes({
        acknowledgedAt: NOW,
        analysisId: "analysis_scenecachefailure",
        createdAt: NOW,
        execute: true,
        ffmpeg: "/usr/bin/ffmpeg",
        maximumSceneDurationUs: 2_000_000,
        model: "google/gemini-3-flash",
        project,
        projectDirectory,
        provider,
        repositoryRoot,
        runner: new SceneRunner(),
        sceneThreshold: 0.35,
        source: "asset_scenefixture:stream_scenefixture",
      });
      expect(cacheWriteFailure.kind).toBe("complete");
      if (cacheWriteFailure.kind !== "complete") throw new Error("Expected completed scene analysis.");
      expect(providerCalls).toBe(3);
      expect(cacheWriteFailure.analysis.batches.every(batch => batch.state === "complete")).toBe(true);
      expect(cacheWriteFailure.analysis.scenes).toEqual(executed.analysis.scenes);
      expect(cacheWriteFailure.analysis.usage).toEqual(executed.analysis.usage);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test.skipIf(FFMPEG === null)("extracts the actual final PTS from a sparse VFR source", async () => {
    if (FFMPEG === null) throw new Error("FFmpeg unexpectedly unavailable.");
    const repositoryRoot = await mkdtemp(join(tmpdir(), "transmute-scenes-vfr-"));
    const projectDirectory = join(repositoryRoot, "artifacts", "transmute", "projects", "project_scenefixture");
    const mediaDirectory = join(repositoryRoot, "imports");
    await Promise.all([mkdir(projectDirectory, { recursive: true }), mkdir(mediaDirectory, { recursive: true })]);
    const media = join(mediaDirectory, "sparse-vfr.mp4");
    const nativeRunner = new BunProcessRunner();
    try {
      const generated = await nativeRunner.run([
        FFMPEG,
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi",
        "-i", "testsrc2=size=160x90:rate=10:duration=0.6",
        "-vf", [
          "settb=expr=1/1000000,",
          "setpts='if(eq(N,0),0,",
          "if(eq(N,1),300000,",
          "if(eq(N,2),600000,",
          "if(eq(N,3),2500000,2600000))))'",
        ].join(""),
        "-frames:v", "5",
        "-fps_mode", "passthrough",
        "-c:v", "libx264",
        "-bf", "0",
        "-pix_fmt", "yuv420p",
        "-video_track_timescale", "1000000",
        media,
      ], { maxOutputBytes: 1_000_000 });
      expect(generated.exitCode).toBe(0);
      const mediaBytes = await readFile(media);
      const mediaSha256 = createHash("sha256").update(mediaBytes).digest("hex");
      const calls: {
        readonly argv: readonly [string, ...string[]];
        readonly maxOutputBytes: number | undefined;
      }[] = [];
      const runner: ProcessRunner = {
        run: async (argv, options) => {
          calls.push({ argv, maxOutputBytes: options?.maxOutputBytes });
          return await nativeRunner.run(argv, options);
        },
      };
      const result = await analyzeProjectScenes({
        acknowledgedAt: NOW,
        analysisId: "analysis_sparsevfr",
        createdAt: NOW,
        execute: true,
        ffmpeg: FFMPEG,
        maximumSceneDurationUs: 3_000_000,
        model: "google/gemini-3-flash",
        project: sparseVfrProject(relative(repositoryRoot, media), mediaBytes.byteLength, mediaSha256),
        projectDirectory,
        provider: sceneProvider(() => {}),
        repositoryRoot,
        runner,
        sceneThreshold: 1,
        source: "asset_scenefixture:stream_scenefixture",
      });
      expect(result.kind).toBe("complete");
      if (result.kind !== "complete") throw new Error("Expected completed VFR scene analysis.");
      const endSample = result.analysis.samples
        .find(sample => sample.requestedAssetTimeUs === 2_599_999);
      if (endSample === undefined) throw new Error("Missing sparse-end VFR sample.");
      expect(endSample.actualAssetTimeUs).toBe(2_500_000);
      expect((await readFile(join(repositoryRoot, endSample.path))).byteLength).toBe(endSample.bytes);

      const extractionCalls = calls.filter(call => call.argv.includes("-filter_complex"));
      expect(extractionCalls.every(call => call.maxOutputBytes === 1_000_000)).toBe(true);
      expect(extractionCalls.every(call =>
        call.argv.some(argument => argument.endsWith(".jpg"))
        && call.argv.some(argument => argument.endsWith(".gray"))
      )).toBe(true);
      const discoveryCalls = calls.filter(call => call.argv.includes("framecrc"));
      expect(discoveryCalls.every(call => call.maxOutputBytes === 1_000_000)).toBe(true);
      const sparseEndCall = discoveryCalls.find(call =>
        call.argv.some((argument, index) => argument === "-ss" && call.argv[index + 1] === "2.349999")
      );
      expect(sparseEndCall).toBeDefined();
      expect(sparseEndCall?.argv.indexOf("-copyts")).toBeLessThan(sparseEndCall?.argv.indexOf("-ss") ?? -1);
      expect(sparseEndCall?.argv.indexOf("-start_at_zero"))
        .toBeLessThan(sparseEndCall?.argv.indexOf("-ss") ?? -1);
      expect(sparseEndCall?.argv.indexOf("-seek_timestamp")).toBeLessThan(sparseEndCall?.argv.indexOf("-ss") ?? -1);
      expect(sparseEndCall?.argv.indexOf("-ss")).toBeLessThan(sparseEndCall?.argv.indexOf("-i") ?? -1);
      const sparseEndExtraction = extractionCalls.find(call =>
        call.argv.some((argument, index) => argument === "-ss" && call.argv[index + 1] === "2.5")
      );
      expect(sparseEndExtraction).toBeDefined();
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test.skipIf(FFMPEG === null)("selects the closest predecessor from a dense CFR fallback window", async () => {
    if (FFMPEG === null) throw new Error("FFmpeg unexpectedly unavailable.");
    const repositoryRoot = await mkdtemp(join(tmpdir(), "transmute-scenes-cfr-"));
    const projectDirectory = join(repositoryRoot, "artifacts", "transmute", "projects", "project_scenefixture");
    const mediaDirectory = join(repositoryRoot, "imports");
    await Promise.all([mkdir(projectDirectory, { recursive: true }), mkdir(mediaDirectory, { recursive: true })]);
    const media = join(mediaDirectory, "dense-cfr.mp4");
    const nativeRunner = new BunProcessRunner();
    try {
      const generated = await nativeRunner.run([
        FFMPEG,
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi",
        "-i", "testsrc2=size=160x90:rate=30:duration=1",
        "-c:v", "libx264",
        "-bf", "0",
        "-pix_fmt", "yuv420p",
        "-video_track_timescale", "1000000",
        media,
      ], { maxOutputBytes: 1_000_000 });
      expect(generated.exitCode).toBe(0);

      const { calls, result } = await executeNativeSceneAnalysis({
        analysisId: "analysis_densecfr",
        durationUs: 1_000_000,
        frameRate: 30,
        media,
        originalName: "dense-cfr.mp4",
        projectDirectory,
        repositoryRoot,
      });
      const endSample = result.analysis.samples
        .find(sample => sample.requestedAssetTimeUs === 999_999);
      if (endSample === undefined) throw new Error("Missing dense-CFR end sample.");
      expect(endSample.actualAssetTimeUs).toBe(966_667);
      expect(endSample.actualAssetTimeUs).not.toBe(766_667);

      const fallbackDiscovery = calls.find(call =>
        call.argv.includes("framecrc")
        && call.argv.some((argument, index) =>
          argument === "-ss" && call.argv[index + 1] === "0.749999")
      );
      expect(fallbackDiscovery).toBeDefined();
      const exactExtraction = calls.find(call =>
        call.argv.includes("-filter_complex")
        && call.argv.some((argument, index) =>
          argument === "-ss" && call.argv[index + 1] === "0.966667")
      );
      expect(exactExtraction).toBeDefined();
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test.skipIf(FFMPEG === null)("normalizes a non-zero native media origin before mapping PTS", async () => {
    if (FFMPEG === null) throw new Error("FFmpeg unexpectedly unavailable.");
    const repositoryRoot = await mkdtemp(join(tmpdir(), "transmute-scenes-origin-"));
    const projectDirectory = join(repositoryRoot, "artifacts", "transmute", "projects", "project_scenefixture");
    const mediaDirectory = join(repositoryRoot, "imports");
    await Promise.all([mkdir(projectDirectory, { recursive: true }), mkdir(mediaDirectory, { recursive: true })]);
    const media = join(mediaDirectory, "nonzero-origin.mp4");
    const nativeRunner = new BunProcessRunner();
    try {
      const generated = await nativeRunner.run([
        FFMPEG,
        "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "lavfi",
        "-i", "color=c=black:size=160x90:rate=4:duration=1",
        "-f", "lavfi",
        "-i", "color=c=white:size=160x90:rate=4:duration=1",
        "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[video]",
        "-map", "[video]",
        "-c:v", "libx264",
        "-bf", "0",
        "-pix_fmt", "yuv420p",
        "-video_track_timescale", "1000000",
        "-output_ts_offset", "5",
        media,
      ], { maxOutputBytes: 1_000_000 });
      expect(generated.exitCode).toBe(0);

      const { calls, result } = await executeNativeSceneAnalysis({
        analysisId: "analysis_nonzeroorigin",
        durationUs: 2_000_000,
        frameRate: 4,
        media,
        originalName: "nonzero-origin.mp4",
        projectDirectory,
        repositoryRoot,
        sceneThreshold: 0.1,
      });
      expect(result.plan.scenes.map(scene => scene.range)).toEqual([
        { endUs: 1_000_000, startUs: 0 },
        { endUs: 2_000_000, startUs: 1_000_000 },
      ]);
      expect(result.analysis.samples.map(sample => ({
        actualAssetTimeUs: sample.actualAssetTimeUs,
        requestedAssetTimeUs: sample.requestedAssetTimeUs,
      }))).toEqual([
        { actualAssetTimeUs: 0, requestedAssetTimeUs: 0 },
        { actualAssetTimeUs: 250_000, requestedAssetTimeUs: 499_999 },
        { actualAssetTimeUs: 750_000, requestedAssetTimeUs: 999_999 },
        { actualAssetTimeUs: 1_000_000, requestedAssetTimeUs: 1_000_000 },
        { actualAssetTimeUs: 1_250_000, requestedAssetTimeUs: 1_499_999 },
        { actualAssetTimeUs: 1_750_000, requestedAssetTimeUs: 1_999_999 },
      ]);
      expect(calls.filter(call =>
        call.argv.includes("framecrc") || call.argv.includes("-filter_complex")
      ).every(call => call.argv.includes("-copyts") && call.argv.includes("-start_at_zero")))
        .toBe(true);
      const detection = calls.find(call =>
        call.argv.some(argument => argument.includes("select='gt(scene,0.1)'"))
      );
      expect(detection?.argv.includes("-copyts")).toBe(true);
      expect(detection?.argv.includes("-start_at_zero")).toBe(true);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test.skipIf(process.platform === "win32")("rejects a redirected scene-frame ancestor before extraction", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "transmute-scenes-symlink-"));
    const projectDirectory = join(repositoryRoot, "artifacts", "transmute", "projects", "project_scenefixture");
    const mediaDirectory = join(repositoryRoot, "imports");
    const outside = join(repositoryRoot, "outside");
    await Promise.all([
      mkdir(projectDirectory, { recursive: true }),
      mkdir(mediaDirectory, { recursive: true }),
      mkdir(outside),
    ]);
    const media = join(mediaDirectory, "screen.mov");
    await writeFile(media, MEDIA_CONTENT);
    await symlink(outside, join(projectDirectory, "analysis"));
    const runner = new SceneRunner();
    let providerCalls = 0;
    try {
      expect(analyzeProjectScenes({
        acknowledgedAt: NOW,
        analysisId: "analysis_scenesymlink",
        createdAt: NOW,
        execute: true,
        ffmpeg: "/usr/bin/ffmpeg",
        maximumSceneDurationUs: 2_000_000,
        model: "google/gemini-3-flash",
        project: fixtureProject(relative(repositoryRoot, media)),
        projectDirectory,
        provider: sceneProvider(() => { providerCalls += 1; }),
        repositoryRoot,
        runner,
        sceneThreshold: 0.35,
        source: "asset_scenefixture:stream_scenefixture",
      })).rejects.toThrow(/physical components/u);
      expect(runner.recordedCalls).toHaveLength(1);
      expect(providerCalls).toBe(0);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });
});
