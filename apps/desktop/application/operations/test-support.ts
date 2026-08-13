import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  EditPlanIdSchema,
  RecordingManifestV1Schema,
  VideoProjectV1Schema,
  type RecordingManifestV1,
  type VideoProjectV1,
} from "../../contracts";
import {
  createDefaultProjectEditPlan,
  createNodeBundleFileSystem,
  saveProjectEditPlan,
  saveRecordingManifest,
  saveVideoProject,
} from "../../core";
import { testManifest } from "../../core/test-support";
import type { ApplicationContext } from "../context";

export const OPERATION_TEST_NOW = new Date("2026-07-23T15:00:00.000Z");
export const OPERATION_TEST_LATER = new Date("2026-07-23T15:01:00.000Z");
export const OPERATION_TEST_HASH = "a".repeat(64);

export function operationTestProject(): VideoProjectV1 {
  return VideoProjectV1Schema.parse({
    analyses: [],
    assets: [{
      assetId: "asset_operation01",
      createdAt: OPERATION_TEST_NOW.toISOString(),
      durationUs: 10_000_000,
      label: "Operation fixture",
      role: "screen",
      source: {
        importedAt: OPERATION_TEST_NOW.toISOString(),
        kind: "imported",
        originalName: "fixture.mp4",
        sourceSha256: OPERATION_TEST_HASH,
      },
      streams: [{
        frameRate: 30,
        kind: "video",
        label: "Fixture video",
        pixelHeight: 1_080,
        pixelWidth: 1_920,
        role: "screen",
        segments: [{
          assetRange: { endUs: 10_000_000, startUs: 0 },
          bytes: 7,
          codec: "h264",
          container: "mp4",
          fileRange: { endUs: 10_000_000, startUs: 0 },
          path: "fixtures/operation.mp4",
          sha256: OPERATION_TEST_HASH,
          streamIndex: 0,
        }],
        streamId: "stream_operation01",
      }, {
        channels: 2,
        kind: "audio",
        label: "Fixture audio",
        role: "music",
        sampleRateHz: 48_000,
        segments: [{
          assetRange: { endUs: 10_000_000, startUs: 0 },
          bytes: 7,
          codec: "aac",
          container: "mp4",
          fileRange: { endUs: 10_000_000, startUs: 0 },
          path: "fixtures/operation.mp4",
          sha256: OPERATION_TEST_HASH,
          streamIndex: 1,
        }],
        streamId: "stream_operation02",
      }],
    }],
    createdAt: OPERATION_TEST_NOW.toISOString(),
    currentEditPlanPath: "edits/current.json",
    kind: "studio.video-project",
    name: "Operation fixture",
    placements: [{
      assetId: "asset_operation01",
      assetRange: { endUs: 10_000_000, startUs: 0 },
      audio: [{
        presentation: {
          enabled: true,
          gainDb: 0,
          pan: 0,
        },
        streamId: "stream_operation02",
      }],
      enabled: true,
      placementId: "placement_operation01",
      sync: {
        anchors: [
          { assetTimeUs: 0, projectTimeUs: 0 },
          { assetTimeUs: 10_000_000, projectTimeUs: 10_000_000 },
        ],
        provenance: { kind: "identity" },
      },
      video: [{
        presentation: {
          blendMode: "normal",
          crop: { kind: "none" },
          enabled: true,
          fit: "fill",
          layer: 0,
          layout: {
            height: 1,
            kind: "normalized",
            width: 1,
            x: 0,
            y: 0,
          },
          opacity: 1,
        },
        streamId: "stream_operation01",
      }],
    }],
    projectId: "project_operation01",
    referencePlacementId: "placement_operation01",
    schemaVersion: 1,
    timeline: { durationUs: 10_000_000, timebase: "microseconds" },
    updatedAt: OPERATION_TEST_NOW.toISOString(),
  });
}

export async function createOperationProjectFixture(repositoryRoot: string) {
  const project = operationTestProject();
  const projectRoot = join(repositoryRoot, "artifacts", "transmute", "projects");
  const projectDirectory = join(projectRoot, project.projectId);
  await mkdir(projectDirectory, { recursive: true });
  const fileSystem = createNodeBundleFileSystem(projectDirectory);
  const plan = createDefaultProjectEditPlan(
    project,
    EditPlanIdSchema.parse("plan_operation01"),
    OPERATION_TEST_NOW.toISOString(),
  );
  await saveProjectEditPlan(fileSystem, plan);
  await saveVideoProject(fileSystem, project);
  return {
    fileSystem,
    plan,
    project,
    projectDirectory,
    projectRoot,
  };
}

export async function createOperationRecordingProjectFixture(
  repositoryRoot: string,
  options: {
    readonly manifest?: RecordingManifestV1;
    readonly project?: (project: VideoProjectV1) => VideoProjectV1;
  } = {},
) {
  const manifest = RecordingManifestV1Schema.parse(
    options.manifest ?? {
      ...testManifest(),
      capture: {
        ...testManifest().capture,
        typedText: "enabled",
      },
    },
  );
  const imported = operationTestProject();
  const recordingProject = VideoProjectV1Schema.parse({
    ...imported,
    assets: imported.assets.map(asset => ({
      ...asset,
      source: {
        kind: "recording",
        recordingId: manifest.recordingId,
        trackIds: manifest.tracks.map(track => track.trackId),
      },
    })),
  });
  const project = VideoProjectV1Schema.parse(
    options.project?.(recordingProject) ?? recordingProject,
  );
  const projectRoot = join(repositoryRoot, "artifacts", "transmute", "projects");
  const projectDirectory = join(projectRoot, project.projectId);
  const recordingRoot = join(
    repositoryRoot,
    "artifacts",
    "transmute",
    "recordings",
  );
  const recordingDirectory = join(recordingRoot, manifest.recordingId);
  await Promise.all([
    mkdir(projectDirectory, { recursive: true }),
    mkdir(recordingDirectory, { recursive: true }),
  ]);
  const fileSystem = createNodeBundleFileSystem(projectDirectory);
  const recordingFileSystem = createNodeBundleFileSystem(recordingDirectory);
  const plan = createDefaultProjectEditPlan(
    project,
    EditPlanIdSchema.parse("plan_operation01"),
    OPERATION_TEST_NOW.toISOString(),
  );
  await Promise.all([
    saveProjectEditPlan(fileSystem, plan),
    saveRecordingManifest(recordingFileSystem, manifest),
    saveVideoProject(fileSystem, project),
  ]);
  return {
    fileSystem,
    manifest,
    plan,
    project,
    projectDirectory,
    projectRoot,
    recordingDirectory,
    recordingFileSystem,
    recordingRoot,
  };
}

export function operationApplicationContext(
  repositoryRoot: string,
  options: {
    readonly capabilities?: ApplicationContext["capabilities"];
    readonly capability?: ApplicationContext["capability"];
    readonly now?: Date;
  } = {},
): ApplicationContext {
  const capabilities = options.capabilities ?? (() => Promise.resolve([]));
  return {
    capabilities,
    capability: options.capability ?? (async name => (
      (await capabilities()).find(candidate => candidate.name === name) ?? {
        available: false,
        name,
        reason: "Capability was not configured for this test context.",
      }
    )),
    clock: {
      now: () => options.now ?? OPERATION_TEST_LATER,
      timestampMilliseconds: () => (
        options.now ?? OPERATION_TEST_LATER
      ).getTime(),
    },
    paths: {
      artifactRoot: join(repositoryRoot, "artifacts", "transmute", "recordings"),
      desktopRoot: join(repositoryRoot, "projects", "transmute", "apps", "desktop"),
      privateRoot: join(repositoryRoot, "artifacts", "transmute", "private"),
      projectRoot: join(repositoryRoot, "artifacts", "transmute", "projects"),
      repositoryRoot,
    },
    runner: {
      run: () => Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }),
    },
  };
}
