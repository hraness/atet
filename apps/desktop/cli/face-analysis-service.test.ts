import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import {
  FaceAnalysisConfigSchema,
  VideoProjectV1Schema,
  type VideoProjectV1,
} from "../contracts";
import {
  createNodeBundleFileSystem,
  loadAnalysisArtifact,
  loadVideoProject,
  saveVideoProject,
  sha256Hex,
} from "../core";
import { CliError } from "./errors";
import {
  analyzeAndPersistProjectFaces,
  listFaceTrackSummaries,
  loadVerifiedProjectFaceAnalysis,
  parseCompletedFaceAnalyzerRun,
  probeFaceAnalyzerVideoTrackOrdinal,
} from "./face-analysis-service";
import type { ProcessRunner, RunResult } from "./io";
import type { OpenProject } from "./project-service";

const CREATED_AT = "2026-07-22T12:00:00.000Z";
const UPDATED_AT = new Date("2026-07-22T12:01:00.000Z");
const FIRST_MEDIA = "first face media fixture";
const SECOND_MEDIA = "second face media fixture";

const CONFIG = FaceAnalysisConfigSchema.parse({
  sampleIntervalUs: 500_000,
  tracking: {
    iouWeight: 0.7,
    maximumCenterDistance: 0.3,
    maximumFacesPerFrame: 8,
    maximumGapUs: 600_000,
    minimumConfidence: 0.6,
    minimumIou: 0.05,
  },
});

function valueAfter(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  if (index < 0 || argv[index + 1] === undefined) throw new Error(`Missing ${name}`);
  return argv[index + 1]!;
}

function backend() {
  return {
    architecture: "arm64",
    helperVersion: "1.0.0",
    implementation: "apple-vision",
    offline: true,
    osBuild: "25A123",
    operatingSystem: "macOS 26.0",
    request: "VNDetectFaceRectanglesRequest",
    revision: 3,
    runtimeVersion: "macOS 26.0",
  } as const;
}

function orientation() {
  return {
    encodedPixelHeight: 1080,
    encodedPixelWidth: 1920,
    mirroredHorizontally: false,
    origin: "top-left",
    pixelHeight: 1080,
    pixelWidth: 1920,
    preferredTransform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
    rotationDegrees: 0,
    sampleAspectRatio: { denominator: 1, numerator: 1 },
    units: "normalized",
    visionOrientation: "up",
    xAxis: "right",
    yAxis: "down",
  } as const;
}

function helperTranscript(argv: readonly string[], pts: readonly number[]): string {
  const startUs = Number(valueAfter(argv, "--start-us"));
  const endUs = Number(valueAfter(argv, "--end-us"));
  const maximumFacesPerFrame = Number(valueAfter(argv, "--max-faces-per-frame"));
  const maximumFrames = Number(valueAfter(argv, "--max-frames"));
  const maximumOutputBytes = Number(valueAfter(argv, "--max-output-bytes"));
  const minimumConfidence = Number(valueAfter(argv, "--minimum-confidence"));
  const sampleIntervalUs = Number(valueAfter(argv, "--sample-interval-us"));
  const videoTrackOrdinal = Number(valueAfter(argv, "--video-track-ordinal"));
  const frames = pts.map((ptsUs, sampleIndex) => ({
    durationUs: 33_333,
    event: "frame",
    faces: [{
      bounds: {
        height: 0.2,
        width: 0.2,
        x: 0.2 + sampleIndex * 0.01,
        y: 0.2,
      },
      confidence: 0.9,
      detectionIndex: 0,
    }],
    kind: "studio.face-analysis",
    ptsUs,
    sampleIndex,
    schemaVersion: 1,
  }));
  return [
    {
      backend: backend(),
      event: "started",
      kind: "studio.face-analysis",
      limits: {
        endUs,
        maximumFacesPerFrame,
        maximumFrames,
        maximumOutputBytes,
        minimumConfidence,
        sampleIntervalUs,
        startUs,
      },
      orientation: orientation(),
      schemaVersion: 1,
      track: {
        nominalFrameRate: 30,
        persistentTrackId: 42,
        totalVideoTracks: 2,
        videoTrackOrdinal,
      },
    },
    ...frames,
    {
      event: "completed",
      faceDetections: frames.length,
      firstPtsUs: frames[0]?.ptsUs ?? null,
      framesAnalyzed: frames.length,
      framesRead: frames.length * 2,
      kind: "studio.face-analysis",
      lastPtsUs: frames.at(-1)?.ptsUs ?? null,
      schemaVersion: 1,
    },
  ].map(event => JSON.stringify(event)).join("\n") + "\n";
}

class FaceRunner implements ProcessRunner {
  readonly calls: (readonly string[])[] = [];

  run(argv: readonly [string, ...string[]]): Promise<RunResult> {
    this.calls.push(argv);
    if (argv[0] === "ffprobe-test") {
      const path = argv.at(-1)!;
      const target = path.endsWith("second.mov") ? 5 : 2;
      return Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          streams: [
            { codec_type: "audio", index: 0 },
            { codec_type: "video", index: target === 2 ? 2 : 4 },
            { codec_type: "video", index: target === 2 ? 4 : 5 },
          ],
        }),
      });
    }
    if (argv[0] === "face-analyzer-test") {
      const start = Number(valueAfter(argv, "--start-us"));
      return Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: helperTranscript(argv, [start, start + 500_000]),
      });
    }
    return Promise.reject(new Error(`Unexpected process: ${argv.join(" ")}`));
  }
}

function fixtureProject(firstPath: string, secondPath: string): VideoProjectV1 {
  return VideoProjectV1Schema.parse({
    analyses: [],
    assets: [{
      assetId: "asset_facefixture",
      createdAt: CREATED_AT,
      durationUs: 2_000_000,
      label: "Camera take",
      role: "camera",
      source: {
        importedAt: CREATED_AT,
        kind: "imported",
        originalName: "camera.mov",
        sourceSha256: sha256Hex(`${FIRST_MEDIA}${SECOND_MEDIA}`),
      },
      streams: [{
        frameRate: 30,
        kind: "video",
        label: "Camera",
        pixelHeight: 1080,
        pixelWidth: 1920,
        role: "camera",
        segments: [{
          assetRange: { endUs: 1_000_000, startUs: 0 },
          bytes: Buffer.byteLength(FIRST_MEDIA),
          codec: "h264",
          container: "mov",
          fileRange: { endUs: 1_100_000, startUs: 100_000 },
          path: firstPath,
          sha256: sha256Hex(FIRST_MEDIA),
          streamIndex: 2,
        }, {
          assetRange: { endUs: 2_000_000, startUs: 1_000_000 },
          bytes: Buffer.byteLength(SECOND_MEDIA),
          codec: "h264",
          container: "mov",
          fileRange: { endUs: 3_000_000, startUs: 2_000_000 },
          path: secondPath,
          sha256: sha256Hex(SECOND_MEDIA),
          streamIndex: 5,
        }],
        streamId: "stream_facefixture",
      }],
    }],
    createdAt: CREATED_AT,
    currentEditPlanPath: null,
    kind: "studio.video-project",
    name: "Face fixture",
    placements: [{
      assetId: "asset_facefixture",
      assetRange: { endUs: 2_000_000, startUs: 0 },
      audio: [],
      enabled: true,
      placementId: "placement_facefixture",
      sync: {
        anchors: [
          { assetTimeUs: 0, projectTimeUs: 0 },
          { assetTimeUs: 2_000_000, projectTimeUs: 2_000_000 },
        ],
        provenance: { kind: "identity" },
      },
      video: [{
        presentation: {
          blendMode: "normal",
          crop: { kind: "none" },
          enabled: true,
          fit: "contain",
          layer: 0,
          layout: { height: 1, kind: "normalized", width: 1, x: 0, y: 0 },
          opacity: 1,
        },
        streamId: "stream_facefixture",
      }],
    }],
    projectId: "project_facefixture",
    referencePlacementId: "placement_facefixture",
    schemaVersion: 1,
    timeline: { durationUs: 2_000_000, timebase: "microseconds" },
    updatedAt: CREATED_AT,
  });
}

async function createFixture(): Promise<{
  readonly firstMedia: string;
  readonly project: OpenProject;
  readonly projectDirectory: string;
  readonly repositoryRoot: string;
}> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "transmute-face-service-"));
  const mediaDirectory = join(repositoryRoot, "imports");
  const projectDirectory = join(repositoryRoot, "artifacts", "transmute", "projects", "project_facefixture");
  await mkdir(mediaDirectory, { recursive: true });
  await mkdir(projectDirectory, { recursive: true });
  const firstMedia = join(mediaDirectory, "first.mov");
  const secondMedia = join(mediaDirectory, "second.mov");
  await writeFile(firstMedia, FIRST_MEDIA);
  await writeFile(secondMedia, SECOND_MEDIA);
  const project = fixtureProject(
    relative(repositoryRoot, firstMedia),
    relative(repositoryRoot, secondMedia),
  );
  const fileSystem = createNodeBundleFileSystem(projectDirectory);
  await saveVideoProject(fileSystem, project);
  return {
    firstMedia,
    project: {
      directory: { id: project.projectId, modifiedAt: CREATED_AT, path: projectDirectory },
      fileSystem,
      project,
    },
    projectDirectory,
    repositoryRoot,
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject.");
}

describe("face analysis service", () => {
  test("maps an absolute FFmpeg stream index to a zero-based video ordinal", async () => {
    const runner: ProcessRunner = {
      run(argv) {
        expect(argv).toEqual([
          "ffprobe-test",
          "-v", "error",
          "-show_entries", "stream=index,codec_type",
          "-of", "json",
          "/physical/take.mov",
        ]);
        return Promise.resolve({
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            streams: [
              { codec_type: "audio", index: 0 },
              { codec_type: "video", index: 2 },
              { codec_type: "data", index: 3 },
              { codec_type: "video", index: 5 },
            ],
          }),
        });
      },
    };
    expect(await probeFaceAnalyzerVideoTrackOrdinal({
      absolutePath: "/physical/take.mov",
      ffprobe: "ffprobe-test",
      runner,
      streamIndex: 5,
    })).toEqual({ ordinal: 1, totalVideoTracks: 2 });
  });

  test("rejects partial/error and non-monotonic analyzer transcripts", () => {
    const argv = [
      "face-analyzer-test",
      "--start-us", "0",
      "--end-us", "1000000",
      "--sample-interval-us", "500000",
      "--max-faces-per-frame", "8",
      "--max-frames", "3",
      "--max-output-bytes", "67108864",
      "--minimum-confidence", "0.6",
      "--video-track-ordinal", "0",
    ];
    const expected = {
      endUs: 1_000_000,
      maximumFacesPerFrame: 8,
      maximumFrames: 3,
      minimumConfidence: 0.6,
      sampleIntervalUs: 500_000,
      startUs: 0,
      totalVideoTracks: 2,
      videoTrackOrdinal: 0,
    };
    const valid = helperTranscript(argv, [0, 500_000]);
    const events = valid.trimEnd().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    events.splice(-1, 0, {
      code: "vision-failed",
      event: "error",
      kind: "studio.face-analysis",
      message: "failed after partial output",
      schemaVersion: 1,
    });
    expect(() => parseCompletedFaceAnalyzerRun(
      events.map(event => JSON.stringify(event)).join("\n") + "\n",
      expected,
    )).toThrow("failed after partial output");

    const duplicatePts = valid.trimEnd().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    duplicatePts[2]!.ptsUs = 0;
    expect(() => parseCompletedFaceAnalyzerRun(
      duplicatePts.map(event => JSON.stringify(event)).join("\n") + "\n",
      expected,
    )).toThrow("unordered or out-of-range");
  });

  test("analyzes every verified segment, persists an immutable sidecar, and lists bounded tracks", async () => {
    const fixture = await createFixture();
    try {
      const runner = new FaceRunner();
      const result = await analyzeAndPersistProjectFaces({
        analysisId: "analysis_facefixture001",
        config: CONFIG,
        faceAnalyzer: "face-analyzer-test",
        ffprobe: "ffprobe-test",
        now: UPDATED_AT,
        project: fixture.project,
        repositoryRoot: fixture.repositoryRoot,
        runner,
        source: "asset_facefixture:stream_facefixture",
      });
      expect(result.reference).toMatchObject({
        analysisId: "analysis_facefixture001",
        analyzedFrames: 4,
        assetId: "asset_facefixture",
        kind: "faces",
        localOnly: true,
        streamId: "stream_facefixture",
        trackCount: 1,
      });
      expect(result.analysis.kind).toBe("transmute.face-analysis");
      expect(result.analysis.results.map(frame => frame.assetTimeUs)).toEqual([
        0,
        500_000,
        1_000_000,
        1_500_000,
      ]);
      expect(result.analysis.privacy).toEqual({
        biometricIdentification: "not-performed",
        execution: "local-only",
        storedEvidence: "bounding-boxes-only",
        tracking: "geometry-continuity-only",
      });
      expect(runner.calls.map(call => call[0])).toEqual([
        "ffprobe-test",
        "face-analyzer-test",
        "ffprobe-test",
        "face-analyzer-test",
      ]);
      const helpers = runner.calls.filter(call => call[0] === "face-analyzer-test");
      expect(valueAfter(helpers[0]!, "--input")).toEndWith("/imports/first.mov");
      expect(valueAfter(helpers[0]!, "--video-track-ordinal")).toBe("0");
      expect(valueAfter(helpers[1]!, "--video-track-ordinal")).toBe("1");

      expect(await loadAnalysisArtifact(fixture.project.fileSystem, result.analysisPath)).toEqual(result.analysis);
      const persistedProject = await loadVideoProject(fixture.project.fileSystem);
      expect(persistedProject.analyses).toEqual([result.reference]);
      const loaded = await loadVerifiedProjectFaceAnalysis({
        analysisId: result.analysis.analysisId,
        project: { ...fixture.project, project: persistedProject },
      });
      expect(loaded.analysis).toEqual(result.analysis);

      const listed = listFaceTrackSummaries({
        analysis: loaded.analysis,
        atUs: 1_100_000,
        limit: 1,
        minimumConfidence: 0.8,
        minimumDurationUs: 1_000_000,
      });
      expect(listed).toMatchObject({
        analysisId: "analysis_facefixture001",
        atUs: 1_100_000,
        returned: 1,
        totalMatched: 1,
        tracks: [{
          observationCount: 4,
          sample: { assetTimeUs: 1_000_000, distanceUs: 100_000 },
          trackId: "face_00000001",
          visibleDurationUs: 1_500_000,
        }],
      });
    } finally {
      await rm(fixture.repositoryRoot, { force: true, recursive: true });
    }
  });

  test("re-hashes media after FFprobe and never invokes the helper after an intervening change", async () => {
    const fixture = await createFixture();
    try {
      let helperCalls = 0;
      const runner: ProcessRunner = {
        async run(argv) {
          if (argv[0] === "ffprobe-test") {
            await writeFile(fixture.firstMedia, "changed media same-ish");
            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify({
                streams: [
                  { codec_type: "audio", index: 0 },
                  { codec_type: "video", index: 2 },
                ],
              }),
            };
          }
          helperCalls += 1;
          throw new Error("helper must not run");
        },
      };
      const error = await rejection(analyzeAndPersistProjectFaces({
        analysisId: "analysis_facefixture002",
        config: CONFIG,
        faceAnalyzer: "face-analyzer-test",
        ffprobe: "ffprobe-test",
        now: UPDATED_AT,
        project: fixture.project,
        repositoryRoot: fixture.repositoryRoot,
        runner,
        source: "asset_facefixture:stream_facefixture",
      }));
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe("invalid-data");
      expect(helperCalls).toBe(0);
      expect((await loadVideoProject(fixture.project.fileSystem)).analyses).toEqual([]);
    } finally {
      await rm(fixture.repositoryRoot, { force: true, recursive: true });
    }
  });

  test("rejects a sidecar whose bytes no longer match its compact project reference", async () => {
    const fixture = await createFixture();
    try {
      const result = await analyzeAndPersistProjectFaces({
        analysisId: "analysis_facefixture003",
        config: CONFIG,
        faceAnalyzer: "face-analyzer-test",
        ffprobe: "ffprobe-test",
        now: UPDATED_AT,
        project: fixture.project,
        repositoryRoot: fixture.repositoryRoot,
        runner: new FaceRunner(),
        source: "asset_facefixture:stream_facefixture",
      });
      const absoluteSidecar = join(fixture.projectDirectory, result.analysisPath);
      const prior = await readFile(absoluteSidecar, "utf8");
      await writeFile(absoluteSidecar, `${prior.trimEnd()} \n`);
      const error = await rejection(loadVerifiedProjectFaceAnalysis({
        analysisId: result.analysis.analysisId,
        project: { ...fixture.project, project: result.project },
      }));
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toContain("SHA-256");
    } finally {
      await rm(fixture.repositoryRoot, { force: true, recursive: true });
    }
  });
});
