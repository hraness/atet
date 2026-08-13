import { describe, expect, test } from "bun:test";

import {
  ProjectCameraMoveSchema,
  ProjectAssetV1Schema,
  ProjectEditPlanV1Schema,
  ProjectPlacementV1Schema,
  ProjectSyncMapSchema,
  ProjectVideoCropSchema,
  VideoProjectV1Schema,
} from "./project";
import { CameraPoseSchema } from "./edit";

const HASH = "0".repeat(64);
const NOW = "2026-07-22T12:00:00.000Z";

function segment(path: string, streamIndex: number) {
  return {
    assetRange: { endUs: 10_000_000, startUs: 0 },
    bytes: 1_000,
    codec: streamIndex === 0 ? "h264" : "aac",
    container: "mov",
    fileRange: { endUs: 10_500_000, startUs: 500_000 },
    path,
    sha256: HASH,
    streamIndex,
  };
}

function cameraAsset() {
  return ProjectAssetV1Schema.parse({
    assetId: "asset_camera001",
    createdAt: NOW,
    durationUs: 10_000_000,
    label: "Camera one",
    role: "camera",
    source: {
      importedAt: NOW,
      kind: "imported",
      originalName: "camera.mov",
      sourceSha256: HASH,
    },
    streams: [
      {
        frameRate: 30,
        kind: "video",
        label: "Camera video",
        pixelHeight: 1080,
        pixelWidth: 1920,
        role: "camera",
        segments: [segment("imports/camera.mov", 0)],
        streamId: "stream_camera_video01",
      },
      {
        channels: 2,
        kind: "audio",
        label: "Camera scratch audio",
        role: "other",
        sampleRateHz: 48_000,
        segments: [segment("imports/camera.mov", 1)],
        streamId: "stream_camera_audio01",
      },
    ],
  });
}

function cameraPlacement() {
  return ProjectPlacementV1Schema.parse({
    assetId: "asset_camera001",
    assetRange: { endUs: 10_000_000, startUs: 0 },
    audio: [{
      presentation: { enabled: true, gainDb: 0, pan: 0 },
      streamId: "stream_camera_audio01",
    }],
    enabled: true,
    placementId: "placement_camera001",
    sync: {
      anchors: [
        { assetTimeUs: 0, projectTimeUs: 1_000_000 },
        { assetTimeUs: 10_000_000, projectTimeUs: 11_000_000 },
      ],
      provenance: { kind: "manual", note: "clap" },
    },
    video: [{
      presentation: {
        blendMode: "normal",
        crop: { kind: "none" },
        enabled: true,
        fit: "contain",
        layer: 1,
        layout: { height: 1, kind: "normalized", width: 1, x: 0, y: 0 },
        opacity: 1,
      },
      streamId: "stream_camera_video01",
    }],
  });
}

function project() {
  return {
    analyses: [],
    assets: [cameraAsset()],
    createdAt: NOW,
    currentEditPlanPath: "edits/current.json",
    kind: "transmute.video-project",
    name: "Performance",
    placements: [cameraPlacement()],
    projectId: "project_example001",
    referencePlacementId: "placement_camera001",
    schemaVersion: 1,
    timeline: { durationUs: 11_000_000, timebase: "microseconds" },
    updatedAt: NOW,
  } as const;
}

describe("video-project stream and placement integrity", () => {
  test("reads the Transmute project identity for compatibility", () => {
    const parsed = VideoProjectV1Schema.parse({
      ...project(),
      kind: "studio.video-project",
    });
    expect(parsed.kind).toBe("studio.video-project");
  });

  test("keeps co-clocked camera video and audio under one placement", () => {
    const parsed = VideoProjectV1Schema.parse(project());
    expect(parsed.assets[0]?.streams.map(stream => stream.kind)).toEqual(["video", "audio"]);
    expect(String(parsed.placements[0]?.video[0]?.streamId)).toBe("stream_camera_video01");
    expect(String(parsed.placements[0]?.audio[0]?.streamId)).toBe("stream_camera_audio01");
  });

  test("requires combined project video crop insets to leave visible content", () => {
    expect(() => ProjectVideoCropSchema.parse({
      bottom: 0,
      kind: "normalized-insets",
      left: 0.6,
      right: 0.4,
      top: 0,
    })).toThrow(/horizontal crop insets/u);
    expect(() => ProjectVideoCropSchema.parse({
      bottom: 0.5,
      kind: "normalized-insets",
      left: 0,
      right: 0,
      top: 0.5,
    })).toThrow(/vertical crop insets/u);
    expect(() => ProjectVideoCropSchema.parse({
      bottom: 0.49,
      kind: "normalized-insets",
      left: 0.49,
      right: 0.49,
      top: 0.49,
    })).not.toThrow();
  });

  test("rejects stream configuration duplication and wrong stream kinds", () => {
    const placement = cameraPlacement();
    expect(() => ProjectPlacementV1Schema.parse({
      ...placement,
      video: [...placement.video, placement.video[0]],
    })).toThrow(/at most once/u);
    expect(() => VideoProjectV1Schema.parse({
      ...project(),
      placements: [{
        ...placement,
        audio: [{ presentation: { enabled: false }, streamId: "stream_camera_video01" }],
      }],
    })).toThrow(/unknown audio stream/u);
  });

  test("requires every logical stream sharing a file to agree on whole-file integrity", () => {
    const asset = cameraAsset();
    expect(() => ProjectAssetV1Schema.parse({
      ...asset,
      streams: asset.streams.map((stream, index) => index === 1
        ? {
            ...stream,
            segments: stream.segments.map(segmentValue => ({
              ...segmentValue,
              sha256: "f".repeat(64),
            })),
          }
        : stream),
    })).toThrow(/agree on whole-file integrity/u);
  });

  test("rejects placements outside their asset or project timelines", () => {
    const placement = cameraPlacement();
    expect(() => VideoProjectV1Schema.parse({
      ...project(),
      placements: [{
        ...placement,
        assetRange: { endUs: 10_000_001, startUs: 0 },
        sync: {
          ...placement.sync,
          anchors: [
            placement.sync.anchors[0],
            { assetTimeUs: 10_000_001, projectTimeUs: 11_000_000 },
          ],
        },
      }],
    })).toThrow(/exceeds its asset duration/u);
    expect(() => VideoProjectV1Schema.parse({
      ...project(),
      timeline: { durationUs: 10_999_999, timebase: "microseconds" },
    })).toThrow(/exceeds the project timeline/u);
  });

  test("requires strictly increasing sync anchors at placement endpoints", () => {
    expect(() => ProjectSyncMapSchema.parse({
      anchors: [
        { assetTimeUs: 0, projectTimeUs: 1_000_000 },
        { assetTimeUs: 5_000_000, projectTimeUs: 6_000_000 },
        { assetTimeUs: 4_000_000, projectTimeUs: 7_000_000 },
      ],
      provenance: { kind: "manual" },
    })).toThrow(/asset times must increase/u);
    const placement = cameraPlacement();
    expect(() => ProjectPlacementV1Schema.parse({
      ...placement,
      sync: {
        ...placement.sync,
        anchors: [
          { assetTimeUs: 1, projectTimeUs: 1_000_000 },
          placement.sync.anchors[1],
        ],
      },
    })).toThrow(/first and last sync anchors/u);
  });
});

test("validates project edit cuts and speed against one project clock", () => {
  const base = {
    baseSpeed: 1,
    cameraMoves: [],
    createdAt: NOW,
    derivations: [],
    effects: {
      clicks: { enabled: false },
      cursor: { enabled: false },
      keystrokes: { enabled: false },
      metadataPlacementId: null,
      typedText: { enabled: false },
    },
    keep: [{ endUs: 5_000_000, startUs: 0 }, { endUs: 11_000_000, startUs: 6_000_000 }],
    kind: "studio.project-edit-plan",
    overlays: [],
    planId: "plan_example001",
    projectId: "project_example001",
    projectStructureSha256: HASH,
    schemaVersion: 1,
    speed: [{ range: { endUs: 8_000_000, startUs: 6_000_000 }, rate: 2 }],
    timelineDurationUs: 11_000_000,
    updatedAt: NOW,
    zooms: [],
  } as const;
  expect(() => ProjectEditPlanV1Schema.parse(base)).not.toThrow();
  expect(() => ProjectEditPlanV1Schema.parse({
    ...base,
    speed: [{ range: { endUs: 6_500_000, startUs: 4_500_000 }, rate: 2 }],
  })).toThrow(/contained in one keep interval/u);

  const zoom = {
    displayId: "display-primary",
    easing: { kind: "linear" },
    enterDurationUs: 0,
    exitDurationUs: 0,
    kind: "manual",
    range: { endUs: 4_000_000, startUs: 1_000_000 },
    scale: 2,
    target: { kind: "point", point: { x: 100, y: 100 } },
    zoomId: "zoom_example001",
  } as const;
  expect(() => ProjectEditPlanV1Schema.parse({
    ...base,
    zooms: [{ operation: zoom, placementId: "placement_camera001" }, {
      operation: {
        ...zoom,
        range: { endUs: 5_000_000, startUs: 3_000_000 },
        zoomId: "zoom_example002",
      },
      placementId: "placement_camera001",
    }],
  })).toThrow(/same placement and display must not overlap/u);
  expect(() => ProjectEditPlanV1Schema.parse({
    ...base,
    zooms: [{ operation: zoom, placementId: "placement_camera001" }, {
      operation: {
        ...zoom,
        displayId: "display-secondary",
        range: { endUs: 5_000_000, startUs: 3_000_000 },
        zoomId: "zoom_example002",
      },
      placementId: "placement_camera001",
    }],
  })).not.toThrow();
});

describe("project camera move contracts", () => {
  const pose = {
    centerX: 0.5,
    centerY: 0.5,
    space: "prepared-video-layer-normalized-v1",
    zoom: 2,
  } as const;
  const move = {
    binding: { geometrySha256: HASH, syncSha256: HASH },
    cameraMoveId: "camera_manual001",
    keyframes: [{
      outgoingEasing: { kind: "ease-in-out" },
      pose,
      projectTimeUs: 1_000_000,
    }, {
      outgoingEasing: { kind: "linear" },
      pose: { ...pose, centerX: 0.7, zoom: 2.5 },
      projectTimeUs: 4_000_000,
    }],
    origin: { kind: "manual" },
    placementId: "placement_camera001",
    projectRange: { endUs: 4_000_000, startUs: 1_000_000 },
    streamId: "stream_camera_video01",
  } as const;

  test("keeps every normalized viewport inside the prepared video layer", () => {
    expect(() => CameraPoseSchema.parse(pose)).not.toThrow();
    expect(() => CameraPoseSchema.parse({ ...pose, centerX: 0.2, zoom: 1 })).toThrow(/centerX/u);
    expect(() => CameraPoseSchema.parse({ ...pose, centerY: 0.95, zoom: 2 })).toThrow(/centerY/u);
    expect(() => CameraPoseSchema.parse({ ...pose, zoom: 10.01 })).toThrow();
  });

  test("requires exact, strictly increasing path endpoints", () => {
    expect(() => ProjectCameraMoveSchema.parse(move)).not.toThrow();
    expect(() => ProjectCameraMoveSchema.parse({
      ...move,
      keyframes: [
        { ...move.keyframes[0], projectTimeUs: 1_000_001 },
        move.keyframes[1],
      ],
    })).toThrow(/exactly match/u);
    expect(() => ProjectCameraMoveSchema.parse({
      ...move,
      keyframes: [
        move.keyframes[0],
        { ...move.keyframes[1], projectTimeUs: 1_000_000 },
      ],
    })).toThrow(/increase strictly/u);
  });

  test("rejects overlaps and discontinuous adjacent moves on one layer", () => {
    const base = ProjectEditPlanV1Schema.parse({
      baseSpeed: 1,
      cameraMoves: [move],
      createdAt: NOW,
      derivations: [],
      effects: {
        clicks: { enabled: false },
        cursor: { enabled: false },
        keystrokes: { enabled: false },
        metadataPlacementId: null,
        typedText: { enabled: false },
      },
      keep: [{ endUs: 11_000_000, startUs: 0 }],
      kind: "studio.project-edit-plan",
      overlays: [],
      planId: "plan_camera_moves",
      projectId: "project_example001",
      projectStructureSha256: HASH,
      schemaVersion: 1,
      speed: [],
      timelineDurationUs: 11_000_000,
      updatedAt: NOW,
      zooms: [],
    });
    expect(() => ProjectEditPlanV1Schema.parse({
      ...base,
      cameraMoves: [move, {
        ...move,
        cameraMoveId: "camera_overlap01",
        keyframes: [
          { ...move.keyframes[0], projectTimeUs: 3_000_000 },
          { ...move.keyframes[1], projectTimeUs: 5_000_000 },
        ],
        projectRange: { endUs: 5_000_000, startUs: 3_000_000 },
      }],
    })).toThrow(/must not overlap/u);
    expect(() => ProjectEditPlanV1Schema.parse({
      ...base,
      cameraMoves: [move, {
        ...move,
        cameraMoveId: "camera_adjacent1",
        keyframes: [
          { ...move.keyframes[0], projectTimeUs: 4_000_000 },
          { ...move.keyframes[1], projectTimeUs: 5_000_000 },
        ],
        projectRange: { endUs: 5_000_000, startUs: 4_000_000 },
      }],
    })).toThrow(/share their endpoint pose/u);
  });
});
