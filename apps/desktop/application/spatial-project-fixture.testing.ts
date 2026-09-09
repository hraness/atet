// Multi-stream media fixture mirrors project-render-plan tests. Referenced media
// bytes are synthetic; these tests verify migration and compositor planning.
import { EditPlanIdSchema, ProjectEditPlanV1Schema, VideoProjectV1Schema, type OverlayOperation, type VideoProjectV1 } from "../contracts";
import { createDefaultProjectEditPlan } from "../core/project-plan";

const HASH = "a".repeat(64);
const NOW = "2026-07-22T12:00:00.000Z";
const PROJECT_DURATION_US = 10_000_000;
type ProjectMediaSegment = VideoProjectV1["assets"][number]["streams"][number]["segments"][number];

function segment(
  path: string,
  streamIndex: number,
  assetStartUs: number,
  assetEndUs: number,
  fileStartUs: number,
): ProjectMediaSegment {
  return {
    assetRange: { endUs: assetEndUs, startUs: assetStartUs },
    bytes: 1_024,
    codec: streamIndex === 0 ? "h264" : "aac",
    container: "mov",
    fileRange: {
      endUs: fileStartUs + assetEndUs - assetStartUs,
      startUs: fileStartUs,
    },
    path,
    sha256: HASH,
    streamIndex,
  };
}

function enabledVideo(layer: number) {
  return {
    blendMode: "normal" as const,
    crop: { kind: "none" as const },
    enabled: true as const,
    fit: "contain" as const,
    layer,
    layout: { height: 1, kind: "normalized" as const, width: 1, x: 0, y: 0 },
    opacity: 1,
  };
}

export function syncedProject(): VideoProjectV1 {
  const referenceVideo = segment("fixtures/reference.mov", 0, 0, PROJECT_DURATION_US, 500_000);
  const referenceAudio = segment("fixtures/reference.mov", 1, 0, PROJECT_DURATION_US, 500_000);
  const cameraVideo = segment("fixtures/camera.mov", 0, 100_000, 10_200_000, 1_000_000);
  const cameraAudio = segment("fixtures/camera.mov", 1, 100_000, 10_200_000, 1_000_000);
  return VideoProjectV1Schema.parse({
    analyses: [],
    assets: [{
      assetId: "asset_reference001",
      createdAt: NOW,
      durationUs: PROJECT_DURATION_US,
      label: "Reference screen",
      role: "screen",
      source: {
        importedAt: NOW,
        kind: "imported",
        originalName: "reference.mov",
        sourceSha256: HASH,
      },
      streams: [{
        frameRate: 60,
        kind: "video",
        label: "Reference video",
        pixelHeight: 1_080,
        pixelWidth: 1_920,
        role: "screen",
        segments: [referenceVideo],
        streamId: "stream_reference_video",
      }, {
        channels: 2,
        kind: "audio",
        label: "System audio",
        role: "system-audio",
        sampleRateHz: 48_000,
        segments: [referenceAudio],
        streamId: "stream_reference_audio",
      }],
    }, {
      assetId: "asset_camera00001",
      createdAt: NOW,
      durationUs: 10_200_000,
      label: "Drifting camera",
      role: "camera",
      source: {
        importedAt: NOW,
        kind: "imported",
        originalName: "camera.mov",
        sourceSha256: HASH,
      },
      streams: [{
        frameRate: 30,
        kind: "video",
        label: "Camera video",
        pixelHeight: 1_080,
        pixelWidth: 1_920,
        role: "camera",
        segments: [cameraVideo],
        streamId: "stream_camera_video01",
      }, {
        channels: 1,
        kind: "audio",
        label: "Camera scratch audio",
        role: "other",
        sampleRateHz: 48_000,
        segments: [cameraAudio],
        streamId: "stream_camera_audio01",
      }],
    }],
    createdAt: NOW,
    currentEditPlanPath: "edits/current.json",
    kind: "atet.video-project",
    name: "Synchronized render",
    placements: [{
      assetId: "asset_reference001",
      assetRange: { endUs: PROJECT_DURATION_US, startUs: 0 },
      audio: [{
        presentation: { enabled: true, gainDb: 0, pan: 0 },
        streamId: "stream_reference_audio",
      }],
      enabled: true,
      placementId: "placement_reference001",
      sync: {
        anchors: [
          { assetTimeUs: 0, projectTimeUs: 0 },
          { assetTimeUs: PROJECT_DURATION_US, projectTimeUs: PROJECT_DURATION_US },
        ],
        provenance: { kind: "identity" },
      },
      video: [{ presentation: enabledVideo(0), streamId: "stream_reference_video" }],
    }, {
      assetId: "asset_camera00001",
      assetRange: { endUs: 10_200_000, startUs: 100_000 },
      audio: [{
        presentation: { enabled: true, gainDb: -3, pan: 0.25 },
        streamId: "stream_camera_audio01",
      }],
      enabled: true,
      placementId: "placement_camera00001",
      sync: {
        anchors: [
          { assetTimeUs: 100_000, projectTimeUs: 0 },
          { assetTimeUs: 5_150_000, projectTimeUs: 5_000_000 },
          { assetTimeUs: 10_200_000, projectTimeUs: PROJECT_DURATION_US },
        ],
        provenance: { kind: "manual", note: "Aligned from slate and corrected for drift." },
      },
      video: [{ presentation: enabledVideo(1), streamId: "stream_camera_video01" }],
    }],
    projectId: "project_renderplan01",
    referencePlacementId: "placement_reference001",
    schemaVersion: 1,
    timeline: { durationUs: PROJECT_DURATION_US, timebase: "microseconds" },
    updatedAt: NOW,
  });
}

export function editedPlan(project: VideoProjectV1, overlays: readonly OverlayOperation[] = []) {
  const plan = createDefaultProjectEditPlan(project, EditPlanIdSchema.parse("plan_renderplan01"), NOW);
  return ProjectEditPlanV1Schema.parse({
    ...plan,
    keep: [
      { endUs: 2_000_000, startUs: 0 },
      { endUs: PROJECT_DURATION_US, startUs: 4_000_000 },
    ],
    overlays,
    speed: [{ range: { endUs: 6_000_000, startUs: 4_000_000 }, rate: 2 }],
  });
}
