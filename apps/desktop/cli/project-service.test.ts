import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ProjectAssetV1Schema,
  RecordingManifestV1Schema,
  type RecordingManifestV1,
} from "../contracts";
import {
  createNodeBundleFileSystem,
  hashProjectStructure,
  saveRecordingManifest,
} from "../core";
import { testManifest } from "../core/test-support";
import { openRecording, type OpenRecording } from "./bundle-service";
import { CliError } from "./errors";
import {
  addAssetToProject,
  createProjectFromRecording,
  loadCurrentProjectPlan,
  openProject,
} from "./project-service";

const NOW = new Date("2026-07-22T15:00:00.000Z");
const LATER = new Date("2026-07-22T15:01:00.000Z");
const HASH = "a".repeat(64);

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject.");
}

function cameraRecordingManifest(): RecordingManifestV1 {
  const base = testManifest();
  return RecordingManifestV1Schema.parse({
    ...base,
    sources: {
      ...base.sources,
      cameras: [{
        cameraId: "camera-external",
        frameRate: 30,
        label: "External camera",
        pixelSize: { height: 1_080, width: 1_920 },
        position: "external",
      }],
    },
    tracks: [...base.tracks, {
      enabled: true,
      kind: "camera-video",
      label: "External camera",
      segments: [{
        codec: "h264",
        container: "mov",
        containerTrackIdentity: { containerTrackId: "camera-0", kind: "verified" },
        endUs: base.timeline.durationUs,
        fileRange: { endUs: 10_250_000, startUs: 250_000 },
        integrity: { bytes: 200, sha256: HASH, state: "verified" },
        path: "media/camera.mov",
        segmentId: "segment_camera001",
        startUs: 0,
        streamIndex: 0,
        timing: {
          kind: "legacy-estimate",
          nativeRange: { endUs: 11_000_000, startUs: 1_000_000 },
          reason: "recording-manifest-v1-container-duration",
        },
      }],
      source: { cameraId: "camera-external" },
      trackId: "track_camera001",
    }],
  });
}

async function recordingFixture(repositoryRoot: string): Promise<OpenRecording> {
  const recordingRoot = join(repositoryRoot, "artifacts", "transmute", "recordings", "rec_example001");
  await mkdir(recordingRoot, { recursive: true });
  await saveRecordingManifest(createNodeBundleFileSystem(recordingRoot), cameraRecordingManifest());
  return await openRecording(join(repositoryRoot, "artifacts", "transmute", "recordings"), "rec_example001");
}

function importedCameraAsset(timestamp = LATER.toISOString()) {
  return ProjectAssetV1Schema.parse({
    assetId: "asset_imported01",
    createdAt: timestamp,
    durationUs: 4_000_000,
    label: "Second angle",
    role: "camera",
    source: {
      importedAt: timestamp,
      kind: "imported",
      originalName: "second-angle.mov",
      sourceSha256: HASH,
    },
    streams: [{
      frameRate: 24,
      kind: "video",
      label: "Second angle video",
      pixelHeight: 1_080,
      pixelWidth: 1_920,
      role: "camera",
      segments: [{
        assetRange: { endUs: 4_000_000, startUs: 0 },
        bytes: 200,
        codec: "h264",
        container: "mov",
        fileRange: { endUs: 4_000_000, startUs: 0 },
        path: "artifacts/transmute/projects/project_multicam1/imports/second-angle.mov",
        sha256: HASH,
        streamIndex: 0,
      }],
      streamId: "stream_imported_video01",
    }, {
      channels: 2,
      kind: "audio",
      label: "Second angle scratch audio",
      role: "other",
      sampleRateHz: 48_000,
      segments: [{
        assetRange: { endUs: 4_000_000, startUs: 0 },
        bytes: 200,
        codec: "aac",
        container: "mov",
        fileRange: { endUs: 4_000_000, startUs: 0 },
        path: "artifacts/transmute/projects/project_multicam1/imports/second-angle.mov",
        sha256: HASH,
        streamIndex: 1,
      }],
      streamId: "stream_imported_audio01",
    }],
  });
}

describe("project creation from recording bundles", () => {
  test("persists every co-clocked screen, camera, and audio stream with an identity placement", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "transmute-project-service-"));
    try {
      const recording = await recordingFixture(repositoryRoot);
      const projectRoot = join(repositoryRoot, "artifacts", "transmute", "projects");
      const created = await createProjectFromRecording({
        id: "project_multicam1",
        name: "Multi-angle demo",
        now: NOW,
        projectRoot,
        recording,
        repositoryRoot,
      });

      expect(String(created.project.projectId)).toBe("project_multicam1");
      expect(created.project.kind).toBe("transmute.video-project");
      expect(created.project.name).toBe("Multi-angle demo");
      expect(created.project.assets).toHaveLength(1);
      const asset = created.project.assets[0]!;
      expect(asset.streams.map(stream => [stream.kind, stream.role])).toEqual([
        ["video", "screen"],
        ["video", "screen"],
        ["audio", "system-audio"],
        ["audio", "microphone"],
        ["video", "camera"],
      ]);
      expect(new Set(asset.streams.map(stream => stream.streamId)).size).toBe(5);
      expect(asset.streams.flatMap(stream => stream.segments.map(segment => segment.path)))
        .toEqual([
          "artifacts/transmute/recordings/rec_example001/media/segment-1.mp4",
          "artifacts/transmute/recordings/rec_example001/media/segment-left.mp4",
          "artifacts/transmute/recordings/rec_example001/media/segment-1.mp4",
          "artifacts/transmute/recordings/rec_example001/media/segment-1.mp4",
          "artifacts/transmute/recordings/rec_example001/media/camera.mov",
        ]);
      expect(asset.streams.find(({ role }) => role === "camera")?.segments[0]?.fileRange).toEqual({
        endUs: 10_250_000,
        startUs: 250_000,
      });

      const placement = created.project.placements[0]!;
      expect(placement.sync).toEqual({
        anchors: [
          { assetTimeUs: 0, projectTimeUs: 0 },
          { assetTimeUs: 10_000_000, projectTimeUs: 10_000_000 },
        ],
        provenance: { kind: "identity" },
      });
      expect(placement.video.map(({ presentation }) => presentation.enabled ? {
        fit: presentation.fit,
        layer: presentation.layer,
        layout: presentation.layout,
      } : presentation)).toEqual([
        { fit: "fill", layer: 0, layout: { height: 1, kind: "normalized", width: 1, x: 0, y: 0 } },
        { fit: "fill", layer: 1, layout: { height: 1, kind: "normalized", width: 1, x: 0, y: 0 } },
        { fit: "contain", layer: 100, layout: { height: 0.28, kind: "normalized", width: 0.28, x: 0.7, y: 0.7 } },
      ]);
      expect(placement.audio).toHaveLength(2);

      const plan = await loadCurrentProjectPlan(created);
      expect(plan.keep).toEqual([{ endUs: 10_000_000, startUs: 0 }]);
      expect(plan.projectStructureSha256).toBe(hashProjectStructure(created.project));
      const reopened = await openProject(projectRoot, "project_multi");
      expect(reopened.directory).toEqual(created.directory);
      expect(reopened.project).toEqual(created.project);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("rejects active recordings and recording paths outside the declared repository", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "transmute-project-boundary-"));
    try {
      const recording = await recordingFixture(repositoryRoot);
      const projectRoot = join(repositoryRoot, "artifacts", "transmute", "projects");
      const active: OpenRecording = {
        ...recording,
        manifest: RecordingManifestV1Schema.parse({ ...recording.manifest, state: "recording" }),
      };
      const activeFailure = await rejection(createProjectFromRecording({
        id: "project_active001",
        now: NOW,
        projectRoot,
        recording: active,
        repositoryRoot,
      }));
      expect(activeFailure).toBeInstanceOf(CliError);
      expect(activeFailure).toMatchObject({ code: "conflict" });

      const outsideFailure = await rejection(createProjectFromRecording({
        id: "project_outside01",
        now: NOW,
        projectRoot,
        recording,
        repositoryRoot: join(repositoryRoot, "different-root"),
      }));
      expect(outsideFailure).toBeInstanceOf(CliError);
      expect(outsideFailure).toMatchObject({ code: "unsafe-path" });
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });
});

test("adds imported media as an explicitly unverified placement and rebases the full-tail plan", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "transmute-project-add-"));
  try {
    const projectRoot = join(repositoryRoot, "artifacts", "transmute", "projects");
    const created = await createProjectFromRecording({
      id: "project_multicam1",
      now: NOW,
      projectRoot,
      recording: await recordingFixture(repositoryRoot),
      repositoryRoot,
    });
    const result = await addAssetToProject(created, importedCameraAsset(), 9_000_000, LATER);

    expect(result.placement.sync).toEqual({
      anchors: [
        { assetTimeUs: 0, projectTimeUs: 9_000_000 },
        { assetTimeUs: 4_000_000, projectTimeUs: 13_000_000 },
      ],
      provenance: { kind: "unverified", reason: "initial-placement" },
    });
    expect(result.placement.video[0]?.presentation).toMatchObject({
      enabled: true,
      fit: "contain",
      layer: 200,
      layout: { height: 0.28, kind: "normalized", width: 0.28, x: 0.7, y: 0.7 },
    });
    expect(result.project.timeline.durationUs).toBe(13_000_000);
    expect(result.plan.keep).toEqual([{ endUs: 13_000_000, startUs: 0 }]);
    expect(result.plan.projectStructureSha256).toBe(hashProjectStructure(result.project));

    const reopened = await openProject(projectRoot, "project_multicam1");
    expect(reopened.project).toEqual(result.project);
    expect(await loadCurrentProjectPlan(reopened)).toEqual(result.plan);
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
});

test("keeps every video stream disabled when an imported asset has an audio-only role", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "transmute-project-audio-role-"));
  try {
    const projectRoot = join(repositoryRoot, "artifacts", "transmute", "projects");
    const created = await createProjectFromRecording({
      id: "project_audiorole1",
      now: NOW,
      projectRoot,
      recording: await recordingFixture(repositoryRoot),
      repositoryRoot,
    });
    const audioRoleAsset = ProjectAssetV1Schema.parse({
      ...importedCameraAsset(),
      label: "Audio with embedded artwork",
      role: "portable-audio",
    });

    const result = await addAssetToProject(created, audioRoleAsset, 0, LATER);

    expect(result.placement.video.map(item => ({
      ...item,
      streamId: String(item.streamId),
    }))).toEqual([{
      presentation: { enabled: false },
      streamId: "stream_imported_video01",
    }]);
    expect(result.placement.audio.map(item => ({
      ...item,
      streamId: String(item.streamId),
    }))).toEqual([{
      presentation: { enabled: true, gainDb: 0, pan: 0 },
      streamId: "stream_imported_audio01",
    }]);
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
});

test("reuses content-identical imported assets across invocation timestamps", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "transmute-project-reimport-"));
  try {
    const projectRoot = join(repositoryRoot, "artifacts", "transmute", "projects");
    const created = await createProjectFromRecording({
      id: "project_multicam1",
      now: NOW,
      projectRoot,
      recording: await recordingFixture(repositoryRoot),
      repositoryRoot,
    });
    const first = await addAssetToProject(created, importedCameraAsset(), 9_000_000, LATER);
    const reopened = await openProject(projectRoot, "project_multicam1");
    const later = new Date("2026-07-22T15:05:00.000Z");
    const second = await addAssetToProject(
      reopened,
      importedCameraAsset(later.toISOString()),
      14_000_000,
      later,
    );

    expect(first.project.assets).toHaveLength(2);
    expect(second.project.assets).toHaveLength(2);
    expect(second.project.assets.find(asset => asset.assetId === "asset_imported01"))
      .toEqual(first.project.assets.find(asset => asset.assetId === "asset_imported01"));
    expect(second.placement).toMatchObject({
      assetId: "asset_imported01",
      placementId: "placement_imported01_2",
    });
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
});
