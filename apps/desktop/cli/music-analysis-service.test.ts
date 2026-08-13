import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { VideoProjectV1Schema, type VideoProjectV1 } from "../contracts";
import {
  canonicalJson,
  createNodeBundleFileSystem,
  loadAnalysisArtifact,
  loadVideoProject,
  saveVideoProject,
  sha256Hex,
} from "../core";
import type { ProcessRunner, RunResult } from "./io";
import {
  analyzeAndPersistProjectMusic,
  readMonoFloat32PcmBounded,
  withDecodedMusicPcm,
  type AnalyzeAndPersistProjectMusicOptions,
} from "./music-analysis-service";
import type { OpenProject } from "./project-service";

const MEDIA_CONTENT = "fixture";
const MEDIA_SHA256 = sha256Hex(MEDIA_CONTENT);
const CREATED_AT = "2026-07-22T12:00:00.000Z";
const UPDATED_AT = new Date("2026-07-22T12:01:00.000Z");

function floatBytes(samples: readonly number[]): Buffer {
  const bytes = Buffer.alloc(samples.length * Float32Array.BYTES_PER_ELEMENT);
  for (const [index, sample] of samples.entries()) bytes.writeFloatLE(sample, index * 4);
  return bytes;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject.");
}

class PcmWritingRunner implements ProcessRunner {
  calls = 0;
  private readonly bytes: Uint8Array;
  private readonly exitCode: number;

  constructor(bytes: Uint8Array, exitCode = 0) {
    this.bytes = bytes;
    this.exitCode = exitCode;
  }

  async run(argv: readonly [string, ...string[]]): Promise<RunResult> {
    this.calls += 1;
    const output = argv.at(-1)!;
    await writeFile(output, this.bytes);
    return { exitCode: this.exitCode, stderr: this.exitCode === 0 ? "" : "decode failed", stdout: "" };
  }
}

function fixtureProject(mediaPath: string): VideoProjectV1 {
  return VideoProjectV1Schema.parse({
    analyses: [],
    assets: [{
      assetId: "asset_musicfixture",
      createdAt: CREATED_AT,
      durationUs: 2_000_000,
      label: "Music take",
      role: "music",
      source: {
        importedAt: CREATED_AT,
        kind: "imported",
        originalName: "take.mov",
        sourceSha256: MEDIA_SHA256,
      },
      streams: [{
        channels: 2,
        kind: "audio",
        label: "Music audio",
        role: "music",
        sampleRateHz: 48_000,
        segments: [{
          assetRange: { endUs: 2_000_000, startUs: 0 },
          bytes: Buffer.byteLength(MEDIA_CONTENT),
          codec: "aac",
          container: "mov",
          fileRange: { endUs: 2_000_000, startUs: 0 },
          path: mediaPath,
          sha256: MEDIA_SHA256,
          streamIndex: 0,
        }],
        streamId: "stream_musicfixture",
      }],
    }],
    createdAt: CREATED_AT,
    currentEditPlanPath: "edits/current.json",
    kind: "studio.video-project",
    name: "Music fixture",
    placements: [{
      assetId: "asset_musicfixture",
      assetRange: { endUs: 2_000_000, startUs: 0 },
      audio: [{
        presentation: { enabled: true, gainDb: 0, pan: 0 },
        streamId: "stream_musicfixture",
      }],
      enabled: true,
      placementId: "placement_musicfixture",
      sync: {
        anchors: [
          { assetTimeUs: 0, projectTimeUs: 0 },
          { assetTimeUs: 2_000_000, projectTimeUs: 2_000_000 },
        ],
        provenance: { kind: "identity" },
      },
      video: [],
    }],
    projectId: "project_musicfixture",
    referencePlacementId: "placement_musicfixture",
    schemaVersion: 1,
    timeline: { durationUs: 2_000_000, timebase: "microseconds" },
    updatedAt: CREATED_AT,
  });
}

async function createFixture(): Promise<{
  readonly project: OpenProject;
  readonly repositoryRoot: string;
}> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "transmute-music-service-"));
  const mediaDirectory = join(repositoryRoot, "imports");
  const projectDirectory = join(repositoryRoot, "artifacts", "transmute", "projects", "project_musicfixture");
  await mkdir(mediaDirectory, { recursive: true });
  await mkdir(projectDirectory, { recursive: true });
  const media = join(mediaDirectory, "take.mov");
  await writeFile(media, MEDIA_CONTENT);
  const project = fixtureProject(relative(repositoryRoot, media));
  const fileSystem = createNodeBundleFileSystem(projectDirectory);
  await saveVideoProject(fileSystem, project);
  return {
    project: {
      directory: { id: project.projectId, modifiedAt: CREATED_AT, path: projectDirectory },
      fileSystem,
      project,
    },
    repositoryRoot,
  };
}

function serviceOptions(
  project: OpenProject,
  repositoryRoot: string,
  runner: ProcessRunner,
): AnalyzeAndPersistProjectMusicOptions {
  return {
    analysisId: "analysis_musicservice1",
    config: {
      hopSize: 256,
      minimumMusicUs: 250_000,
      sampleRateHz: 8_000,
      tempoWindowUs: 1_000_000,
      windowSize: 1_024,
    },
    ffmpeg: "/usr/bin/ffmpeg",
    now: UPDATED_AT,
    project,
    repositoryRoot,
    runner,
    source: "asset_musicfixture:stream_musicfixture",
    toolVersion: "0.1.0-test",
  };
}

async function cacheEntries(project: OpenProject): Promise<readonly string[]> {
  try {
    return await readdir(join(project.directory.path, "analysis", "cache"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

describe("bounded PCM reading", () => {
  test("streams finite little-endian floats without reading beyond its byte bound", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "transmute-music-pcm-"));
    const path = join(temporary, "audio.f32le");
    try {
      await writeFile(path, floatBytes([0, -0.5, 0.25, 1]));
      const pcm = await readMonoFloat32PcmBounded(path, { maxBytes: 16, sampleRateHz: 8_000 });
      expect(pcm).toEqual({ sampleRateHz: 8_000, samples: [0, -0.5, 0.25, 1] });

      expect(String(await rejection(readMonoFloat32PcmBounded(path, { maxBytes: 12 }))))
        .toMatch(/resource bound/u);
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("rejects partial and non-finite float samples", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "transmute-music-invalid-pcm-"));
    const path = join(temporary, "audio.f32le");
    try {
      await writeFile(path, Uint8Array.from([1, 2, 3]));
      expect(String(await rejection(readMonoFloat32PcmBounded(path)))).toMatch(/partial float/u);
      await writeFile(path, floatBytes([Number.NaN]));
      expect(String(await rejection(readMonoFloat32PcmBounded(path)))).toMatch(/non-finite/u);
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });
});

test("persists a validated immutable music sidecar and compact project reference", async () => {
  const fixture = await createFixture();
  const sampleRateHz = 8_000;
  const samples = Array.from({ length: sampleRateHz * 2 }, (_, index) =>
    0.18 * Math.sin(2 * Math.PI * 261.625_565 * index / sampleRateHz)
    + 0.14 * Math.sin(2 * Math.PI * 329.627_557 * index / sampleRateHz)
    + 0.12 * Math.sin(2 * Math.PI * 391.995_436 * index / sampleRateHz));
  const runner = new PcmWritingRunner(floatBytes(samples));
  try {
    const result = await analyzeAndPersistProjectMusic(
      serviceOptions(fixture.project, fixture.repositoryRoot, runner),
    );

    expect(result.analysis.kind).toBe("transmute.music-analysis");
    expect(result.analysis.durationUs).toBe(2_000_000);
    expect(result.analysis.musicRegions.length).toBeGreaterThan(0);
    expect(result.analysis.keyRegions.length).toBeGreaterThan(0);
    expect(result.reference).toMatchObject({
      analysisId: result.analysis.analysisId,
      assetId: "asset_musicfixture",
      keyRegions: result.analysis.keyRegions.length,
      kind: "music",
      musicRegions: result.analysis.musicRegions.length,
      streamId: "stream_musicfixture",
      tempoRegions: result.analysis.tempoRegions.length,
    });
    expect(result.reference.sha256).toBe(sha256Hex(`${canonicalJson(result.analysis)}\n`));

    const artifact = await loadAnalysisArtifact(fixture.project.fileSystem, result.analysisPath);
    expect(artifact).toEqual(result.analysis);
    const persistedProject = await loadVideoProject(fixture.project.fileSystem);
    expect(persistedProject).toEqual(result.project);
    expect(persistedProject.analyses).toEqual([result.reference]);
    expect(await cacheEntries(fixture.project)).toEqual([]);

    const artifactBefore = await readFile(join(fixture.project.directory.path, result.analysisPath));
    expect(String(await rejection(analyzeAndPersistProjectMusic(
      serviceOptions(fixture.project, fixture.repositoryRoot, runner),
    )))).toMatch(/will not be overwritten/u);
    expect(await readFile(join(fixture.project.directory.path, result.analysisPath))).toEqual(artifactBefore);
    expect(runner.calls).toBe(1);
  } finally {
    await rm(fixture.repositoryRoot, { force: true, recursive: true });
  }
});

test("removes decoded PCM when bounded reading or downstream analysis fails", async () => {
  const fixture = await createFixture();
  try {
    const oversizedRunner = new PcmWritingRunner(floatBytes([0, 0, 0, 0, 0]));
    expect(String(await rejection(analyzeAndPersistProjectMusic({
      ...serviceOptions(fixture.project, fixture.repositoryRoot, oversizedRunner),
      maxDecodedPcmBytes: 16,
    })))).toMatch(/resource bound/u);
    expect(await cacheEntries(fixture.project)).toEqual([]);

    const stream = fixture.project.project.assets[0]!.streams[0]!;
    if (stream.kind !== "audio") throw new Error("Fixture stream is not audio.");
    const callbackRunner = new PcmWritingRunner(floatBytes(Array.from({ length: 16_000 }, () => 0.1)));
    expect(String(await rejection(withDecodedMusicPcm({
      ffmpeg: "/usr/bin/ffmpeg",
      projectDirectory: fixture.project.directory.path,
      repositoryRoot: fixture.repositoryRoot,
      runner: callbackRunner,
      stream,
    }, () => {
      throw new Error("analysis failed");
    })))).toContain("analysis failed");
    expect(await cacheEntries(fixture.project)).toEqual([]);
  } finally {
    await rm(fixture.repositoryRoot, { force: true, recursive: true });
  }
});

test("rejects a successful decoder process that returns truncated timeline coverage", async () => {
  const fixture = await createFixture();
  try {
    const truncated = new PcmWritingRunner(floatBytes([0]));
    const failure = await rejection(analyzeAndPersistProjectMusic(
      serviceOptions(fixture.project, fixture.repositoryRoot, truncated),
    ));
    expect(String(failure)).toMatch(/incomplete PCM timeline coverage/u);
    expect(await cacheEntries(fixture.project)).toEqual([]);
    expect((await loadVideoProject(fixture.project.fileSystem)).analyses).toEqual([]);
  } finally {
    await rm(fixture.repositoryRoot, { force: true, recursive: true });
  }
});
