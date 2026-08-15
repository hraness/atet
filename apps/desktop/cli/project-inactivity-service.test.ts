import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { RecordingManifestV1Schema, VideoProjectV1Schema } from "../contracts";
import {
  createNodeBundleFileSystem,
  loadAnalysisArtifact,
  saveRecordingManifest,
  saveVideoProject,
} from "../core";
import { testManifest } from "../core/test-support";
import { openRecording } from "./bundle-service";
import { CliError } from "./errors";
import type { ProcessRunner, RunResult } from "./io";
import {
  DEFAULT_PROJECT_INACTIVITY_CONFIG,
  analyzeAndPersistProjectInactivity,
} from "./project-inactivity-service";
import { createProjectFromRecording, type OpenProject } from "./project-service";

const NOW = new Date("2026-07-22T15:00:00.000Z");
const LATER = new Date("2026-07-22T15:01:00.000Z");

class InactivityRunner implements ProcessRunner {
  readonly calls: Array<readonly [string, ...string[]]> = [];

  run(argv: readonly [string, ...string[]]): Promise<RunResult> {
    this.calls.push(argv);
    if (argv[0] === "ffprobe-test") {
      return Promise.resolve({ exitCode: 0, stderr: "", stdout: '{"format":{"duration":"10.0"}}' });
    }
    if (argv.includes("-vf")) {
      return Promise.resolve({
        exitCode: 0,
        stderr: "freeze_start: 1.0\nfreeze_end: 9.0\n",
        stdout: "",
      });
    }
    return Promise.resolve({
      exitCode: 0,
      stderr: "silence_start: 2.0\nsilence_end: 8.0\n",
      stdout: "",
    });
  }
}

function sha256(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject.");
}

async function projectFixture(repositoryRoot: string): Promise<OpenProject> {
  const recordingDirectory = join(repositoryRoot, "artifacts", "atet", "recordings", "rec_example001");
  await mkdir(join(recordingDirectory, "media"), { recursive: true });
  await mkdir(join(recordingDirectory, "events"), { recursive: true });
  const mediaContents = "media";
  await Promise.all([
    writeFile(join(recordingDirectory, "media", "segment-1.mp4"), mediaContents),
    writeFile(join(recordingDirectory, "media", "segment-left.mp4"), mediaContents),
  ]);
  const event = `${JSON.stringify({
    button: "left",
    clickCount: 1,
    displayId: "display-primary",
    nativeTimeUs: 6_000_000,
    phase: "down",
    position: { x: 100, y: 200 },
    sequence: 0,
    sourceTimeUs: 5_000_000,
    type: "mouse.click",
  })}\n`;
  await writeFile(join(recordingDirectory, "events", "interactions.jsonl"), event);
  const baseManifest = testManifest();
  const manifest = RecordingManifestV1Schema.parse({
    ...baseManifest,
    eventStreams: [{
      endUs: 5_000_000,
      eventKinds: ["mouse.click"],
      eventStreamId: "events_interactions01",
      integrity: { bytes: Buffer.byteLength(event), sha256: sha256(event), state: "verified" },
      path: "events/interactions.jsonl",
      recordCount: 1,
      startUs: 5_000_000,
    }],
    tracks: baseManifest.tracks.map(track => ({
      ...track,
      segments: track.segments.map(segment => ({
        ...segment,
        integrity: {
          bytes: Buffer.byteLength(mediaContents),
          sha256: sha256(mediaContents),
          state: "verified" as const,
        },
      })),
    })),
  });
  await saveRecordingManifest(createNodeBundleFileSystem(recordingDirectory), manifest);
  const recording = await openRecording(
    join(repositoryRoot, "artifacts", "atet", "recordings"),
    manifest.recordingId,
  );
  const project = await createProjectFromRecording({
    id: "project_inactive01",
    now: NOW,
    projectRoot: join(repositoryRoot, "artifacts", "atet", "projects"),
    recording,
    repositoryRoot,
  });
  const drifted = VideoProjectV1Schema.parse({
    ...project.project,
    placements: project.project.placements.map(placement => ({
      ...placement,
      sync: {
        anchors: [
          { assetTimeUs: 0, projectTimeUs: 0 },
          { assetTimeUs: 10_000_000, projectTimeUs: 9_000_000 },
        ],
        provenance: { kind: "manual", note: "fixture drift" },
      },
    })),
  });
  await saveVideoProject(project.fileSystem, drifted);
  return { ...project, project: drifted };
}

describe("project inactivity analysis", () => {
  test("intersects every enabled screen and audio stream and protects mapped recording interactions", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-project-inactivity-"));
    try {
      const project = await projectFixture(repositoryRoot);
      const runner = new InactivityRunner();
      const result = await analyzeAndPersistProjectInactivity({
        analysisId: "analysis_inactive01",
        artifactRoot: join(repositoryRoot, "artifacts", "atet", "recordings"),
        config: {
          ...DEFAULT_PROJECT_INACTIVITY_CONFIG,
          edgeHandleUs: 0,
          interactionHandleUs: 450_000,
          minimumCutUs: 1_000_000,
        },
        ffmpeg: "ffmpeg-test",
        ffmpegVersion: "ffmpeg fixture",
        ffprobe: "ffprobe-test",
        now: LATER,
        project,
        repositoryRoot,
        runner,
        toolVersion: "test",
      });

      expect(result.analysis.kind).toBe("atet.project-inactivity-analysis");
      expect(result.analysis.displays).toHaveLength(2);
      expect(result.analysis.audio).toHaveLength(2);
      expect(result.analysis.displays.map(item => item.intervals[0]?.projectRange)).toEqual([
        { endUs: 8_100_000, startUs: 900_000 },
        { endUs: 8_100_000, startUs: 900_000 },
      ]);
      expect(result.analysis.audio.map(item => item.intervals[0]?.projectRange)).toEqual([
        { endUs: 7_200_000, startUs: 1_800_000 },
        { endUs: 7_200_000, startUs: 1_800_000 },
      ]);
      expect(result.analysis.interactions).toEqual([{
        assetRange: { endUs: 5_000_001, startUs: 5_000_000 },
        projectRange: { endUs: 4_500_001, startUs: 4_500_000 },
        source: "mouse.click",
      }]);
      expect(result.analysis.result).toEqual({
        candidateCount: 1,
        protectedInteractionCount: 1,
        recommendedRanges: [
          { endUs: 4_050_000, startUs: 1_800_000 },
          { endUs: 7_200_000, startUs: 4_950_001 },
        ],
      });
      expect(result.analysis.referenceRecording).toMatchObject({
        placementId: project.project.referencePlacementId,
        recordingId: "rec_example001",
      });
      expect(runner.calls.filter(call => call.includes("-vf"))).toHaveLength(2);
      expect(runner.calls.filter(call => call.includes("-af"))).toHaveLength(2);
      expect(result.reference).toMatchObject({
        audioStreams: 2,
        displayStreams: 2,
        kind: "inactivity",
        recommendedRanges: 2,
      });
      expect(await loadAnalysisArtifact(project.fileSystem, result.analysisPath)).toEqual(result.analysis);
      expect(result.project.analyses.at(-1)).toEqual(result.reference);
      const duplicate = await rejection(analyzeAndPersistProjectInactivity({
        analysisId: "analysis_inactive01",
        artifactRoot: join(repositoryRoot, "artifacts", "atet", "recordings"),
        ffmpeg: "ffmpeg-test",
        ffmpegVersion: "ffmpeg fixture",
        ffprobe: "ffprobe-test",
        now: LATER,
        project: { ...project, project: result.project },
        repositoryRoot,
        runner,
        toolVersion: "test",
      }));
      expect(duplicate).toBeInstanceOf(CliError);
      expect(duplicate).toMatchObject({ code: "conflict" });
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("omits audio probes and evidence when silence protection is disabled", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-project-inactivity-no-audio-"));
    try {
      const project = await projectFixture(repositoryRoot);
      const runner = new InactivityRunner();
      const result = await analyzeAndPersistProjectInactivity({
        analysisId: "analysis_inactive02",
        artifactRoot: join(repositoryRoot, "artifacts", "atet", "recordings"),
        config: {
          ...DEFAULT_PROJECT_INACTIVITY_CONFIG,
          edgeHandleUs: 0,
          interactionHandleUs: 0,
          minimumCutUs: 1_000_000,
          requireAudioSilence: false,
        },
        ffmpeg: "ffmpeg-test",
        ffmpegVersion: "ffmpeg fixture",
        ffprobe: "ffprobe-test",
        now: LATER,
        project,
        repositoryRoot,
        runner,
        toolVersion: "test",
      });

      expect(result.analysis.audio).toEqual([]);
      expect(runner.calls.filter(call => call.includes("-af"))).toHaveLength(0);
      expect(result.analysis.result.recommendedRanges).toEqual([
        { endUs: 4_500_000, startUs: 900_000 },
        { endUs: 8_100_000, startUs: 4_500_001 },
      ]);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("rejects project media symlinks that resolve outside the repository", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-project-inactivity-path-"));
    const outsideRoot = await mkdtemp(join(tmpdir(), "atet-project-inactivity-outside-"));
    try {
      const project = await projectFixture(repositoryRoot);
      const mediaPath = join(
        repositoryRoot,
        "artifacts",
        "atet",
        "recordings",
        "rec_example001",
        "media",
        "segment-left.mp4",
      );
      const outside = join(outsideRoot, "outside.mp4");
      await writeFile(outside, "outside");
      await unlink(mediaPath);
      await symlink(outside, mediaPath);

      const error = await rejection(analyzeAndPersistProjectInactivity({
        analysisId: "analysis_inactive03",
        artifactRoot: join(repositoryRoot, "artifacts", "atet", "recordings"),
        config: { ...DEFAULT_PROJECT_INACTIVITY_CONFIG, requireAudioSilence: false },
        ffmpeg: "ffmpeg-test",
        ffmpegVersion: "ffmpeg fixture",
        ffprobe: "ffprobe-test",
        now: LATER,
        project,
        repositoryRoot,
        runner: new InactivityRunner(),
        toolVersion: "test",
      }));
      expect(error).toBeInstanceOf(CliError);
      expect(error).toMatchObject({ code: "unsafe-path" });
    } finally {
      await Promise.all([
        rm(repositoryRoot, { force: true, recursive: true }),
        rm(outsideRoot, { force: true, recursive: true }),
      ]);
    }
  });
});
