import { describe, expect, test } from "bun:test";

import {
  EditPlanIdSchema,
  ProjectEditPlanV1Schema,
  VideoProjectV1Schema,
  type OverlayOperation,
  type VideoProjectV1,
} from "../contracts";
import {
  createDefaultProjectEditPlan,
  hashPlacementSync,
  rebaseProjectEditPlan,
} from "./project-plan";
import {
  hashProjectCameraGeometry,
  hashProjectCameraSync,
} from "./project-camera";
import {
  assertProjectRenderPlanComposition,
  compileProjectRenderPlan,
} from "./project-render-plan";

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

function syncedProject(): VideoProjectV1 {
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
    kind: "studio.video-project",
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

function editedPlan(project: VideoProjectV1, overlays: readonly OverlayOperation[] = []) {
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

test("rejects rebasing an analysis-derived edit across a changed placement sync map", () => {
  const previous = syncedProject();
  const placement = previous.placements[1]!;
  const base = createDefaultProjectEditPlan(
    previous,
    EditPlanIdSchema.parse("plan_stalerebase01"),
    NOW,
  );
  expect(base.kind).toBe("transmute.project-edit-plan");
  const plan = ProjectEditPlanV1Schema.parse({
    ...base,
    derivations: [{
      decisionId: "decision_stalerebase01",
      operation: "cut",
      origin: {
        analysisId: "analysis_stalerebase01",
        assetId: placement.assetId,
        assetRange: { endUs: 2_000_000, startUs: 1_000_000 },
        kind: "asset-analysis",
        placementId: placement.placementId,
        syncMapSha256: hashPlacementSync(placement),
      },
      projectRange: { endUs: 2_000_000, startUs: 1_000_000 },
    }],
    keep: [{ endUs: 1_000_000, startUs: 0 }, { endUs: PROJECT_DURATION_US, startUs: 2_000_000 }],
  });
  const next = VideoProjectV1Schema.parse({
    ...previous,
    placements: previous.placements.map(candidate => candidate.placementId === placement.placementId
      ? {
          ...candidate,
          sync: {
            anchors: [
              { assetTimeUs: 100_000, projectTimeUs: 0 },
              { assetTimeUs: 5_150_000, projectTimeUs: 5_100_000 },
              { assetTimeUs: 10_200_000, projectTimeUs: PROJECT_DURATION_US },
            ],
            provenance: { kind: "manual", note: "corrected" },
          },
        }
      : candidate),
  });
  expect(() => rebaseProjectEditPlan(previous, next, plan, NOW)).toThrow(/stale/u);
});

test("rejects retaining a filler cut when another audible placement is enabled or realigned", () => {
  const fullyAudible = syncedProject();
  const cameraPlacement = fullyAudible.placements[1]!;
  const previous = VideoProjectV1Schema.parse({
    ...fullyAudible,
    placements: fullyAudible.placements.map(placement => placement.placementId === cameraPlacement.placementId
      ? { ...placement, enabled: false }
      : placement),
  });
  const sourcePlacement = previous.placements[0]!;
  const base = createDefaultProjectEditPlan(
    previous,
    EditPlanIdSchema.parse("plan_audio_protection01"),
    NOW,
  );
  const plan = ProjectEditPlanV1Schema.parse({
    ...base,
    derivations: [{
      decisionId: "decision_audio_protection01",
      operation: "cut",
      origin: {
        analysisId: "analysis_audio_protection01",
        assetId: sourcePlacement.assetId,
        assetRange: { endUs: 2_000_000, startUs: 1_000_000 },
        kind: "asset-analysis",
        placementId: sourcePlacement.placementId,
        syncMapSha256: hashPlacementSync(sourcePlacement),
      },
      projectRange: { endUs: 2_000_000, startUs: 1_000_000 },
    }],
    keep: [{ endUs: 1_000_000, startUs: 0 }, { endUs: PROJECT_DURATION_US, startUs: 2_000_000 }],
  });

  expect(() => rebaseProjectEditPlan(previous, fullyAudible, plan, NOW))
    .toThrow(/enabled-audio protection structure changed/iu);

  const realigned = VideoProjectV1Schema.parse({
    ...fullyAudible,
    placements: fullyAudible.placements.map(placement => placement.placementId === cameraPlacement.placementId
      ? {
          ...placement,
          sync: {
            ...placement.sync,
            provenance: { kind: "manual", note: "newly refined alignment" },
          },
        }
      : placement),
  });
  const audiblePlan = ProjectEditPlanV1Schema.parse({
    ...plan,
    projectStructureSha256: createDefaultProjectEditPlan(
      fullyAudible,
      EditPlanIdSchema.parse("plan_audio_protection02"),
      NOW,
    ).projectStructureSha256,
  });
  expect(() => rebaseProjectEditPlan(fullyAudible, realigned, audiblePlan, NOW))
    .toThrow(/enabled-audio protection structure changed/iu);
});

test("independently verifies the composition hash on persisted project render plans", () => {
  const project = syncedProject();
  const render = compileProjectRenderPlan(project, editedPlan(project));
  expect(render.kind).toBe("transmute.project-render-plan");
  expect(assertProjectRenderPlanComposition(render)).toEqual(render);
  expect(() => assertProjectRenderPlanComposition({
    ...render,
    output: {
      ...render.output,
      background: "#112233ff",
    },
  })).toThrow(/composition hash mismatch/u);
});

function imageOverlay(): OverlayOperation {
  return {
    anchor: "center",
    coordinateSpace: "output-pixels",
    entrance: { durationUs: 100_000, easing: { kind: "ease-out" }, kind: "fade" },
    exit: { durationUs: 100_000, easing: { kind: "ease-in" }, kind: "fade" },
    intrinsicSize: { height: 180, width: 320 },
    opacity: 0.9,
    overlayId: "overlay_renderplan01",
    position: { x: 120, y: 80 },
    range: { endUs: 8_000_000, startUs: 1_000_000 },
    rotationDegrees: 0,
    scale: 1,
    size: { height: 180, kind: "pixels", width: 320 },
    source: {
      asset: {
        bytes: 100,
        mediaType: "image/png",
        path: "assets/callout.png",
        provenance: { kind: "imported", originalName: "callout.png", sourceSha256: HASH },
        sha256: HASH,
      },
      kind: "image",
    },
    zIndex: 10,
  };
}

describe("project render plan synchronization", () => {
  test("rejects unsafe output geometry and pixel layouts outside the canvas", () => {
    const project = syncedProject();
    const plan = editedPlan(project);
    expect(() => compileProjectRenderPlan(project, plan, {
      pixelHeight: 16_384,
      pixelWidth: 16_384,
    })).toThrow(/dimensions/u);

    const outside = VideoProjectV1Schema.parse({
      ...project,
      placements: project.placements.map((placement, placementIndex) => placementIndex === 0
        ? {
            ...placement,
            video: placement.video.map(configured => ({
              ...configured,
              presentation: {
                ...configured.presentation,
                layout: { height: 400, kind: "output-pixels" as const, width: 400, x: 1_000, y: 500 },
              },
            })),
          }
        : placement),
    });
    const outsidePlan = editedPlan(outside);
    expect(() => compileProjectRenderPlan(outside, outsidePlan, {
      pixelHeight: 720,
      pixelWidth: 1_280,
    })).toThrow(/exceeds the project render output/u);
  });

  test("applies one global cut and speed map to identity and drift-corrected placements", () => {
    const project = syncedProject();
    const render = compileProjectRenderPlan(project, editedPlan(project), {
      background: "#101820ff",
      frameRate: 30,
      pixelHeight: 720,
      pixelWidth: 1_280,
    });

    expect(render.output).toEqual({
      background: "#101820ff",
      durationUs: 7_000_000,
      frameRate: 30,
      pixelHeight: 720,
      pixelWidth: 1_280,
    });
    const reference = render.videoSlices.filter(slice => slice.placementId === "placement_reference001");
    const camera = render.videoSlices.filter(slice => slice.placementId === "placement_camera00001");
    expect(reference.map(slice => ({
      output: slice.outputRange,
      project: slice.projectRange,
      speed: slice.projectSpeed,
    }))).toEqual([{
      output: { endUs: 2_000_000, startUs: 0 },
      project: { endUs: 2_000_000, startUs: 0 },
      speed: 1,
    }, {
      output: { endUs: 3_000_000, startUs: 2_000_000 },
      project: { endUs: 6_000_000, startUs: 4_000_000 },
      speed: 2,
    }, {
      output: { endUs: 7_000_000, startUs: 3_000_000 },
      project: { endUs: 10_000_000, startUs: 6_000_000 },
      speed: 1,
    }]);
    expect(camera.map(slice => slice.assetRange)).toEqual([
      { endUs: 2_120_000, startUs: 100_000 },
      { endUs: 5_150_000, startUs: 4_140_000 },
      { endUs: 6_160_000, startUs: 5_150_000 },
      { endUs: 10_200_000, startUs: 6_160_000 },
    ]);
    expect(camera.map(slice => slice.outputRange)).toEqual([
      { endUs: 2_000_000, startUs: 0 },
      { endUs: 2_500_000, startUs: 2_000_000 },
      { endUs: 3_000_000, startUs: 2_500_000 },
      { endUs: 7_000_000, startUs: 3_000_000 },
    ]);
    expect(render.audioSlices
      .filter(slice => slice.placementId === "placement_reference001")
      .map(slice => slice.outputRange)).toEqual(reference.map(slice => slice.outputRange));
    expect(render.audioSlices
      .filter(slice => slice.placementId === "placement_camera00001")
      .map(slice => slice.outputRange)).toEqual(camera.map(slice => slice.outputRange));
    expect([...render.videoSlices, ...render.audioSlices].every(slice => (
      slice.bytes === 1_024 && slice.sha256 === HASH
    ))).toBe(true);
    expect(render.warnings).toEqual([]);
  });

  test("keeps overlay playback continuous in visible-output time across cuts and speed changes", () => {
    const project = syncedProject();
    const render = compileProjectRenderPlan(project, editedPlan(project, [imageOverlay()]));

    expect(render.overlays.map(({ outputRange, playbackOffsetUs, projectRange, visibleDurationUs }) => ({
      outputRange,
      playbackOffsetUs,
      projectRange,
      visibleDurationUs,
    }))).toEqual([{
      outputRange: { endUs: 2_000_000, startUs: 1_000_000 },
      playbackOffsetUs: 0,
      projectRange: { endUs: 2_000_000, startUs: 1_000_000 },
      visibleDurationUs: 4_000_000,
    }, {
      outputRange: { endUs: 3_000_000, startUs: 2_000_000 },
      playbackOffsetUs: 1_000_000,
      projectRange: { endUs: 6_000_000, startUs: 4_000_000 },
      visibleDurationUs: 4_000_000,
    }, {
      outputRange: { endUs: 5_000_000, startUs: 3_000_000 },
      playbackOffsetUs: 2_000_000,
      projectRange: { endUs: 8_000_000, startUs: 6_000_000 },
      visibleDurationUs: 4_000_000,
    }]);
  });

  test("splits manual camera motion at cuts, speed changes, sync anchors, and media slices", () => {
    const project = syncedProject();
    const placement = project.placements.find(
      candidate => candidate.placementId === "placement_camera00001",
    )!;
    const streamId = placement.video[0]!.streamId;
    const base = editedPlan(project);
    const plan = ProjectEditPlanV1Schema.parse({
      ...base,
      cameraMoves: [{
        binding: {
          geometrySha256: hashProjectCameraGeometry(project, placement.placementId, streamId),
          syncSha256: hashProjectCameraSync(placement),
        },
        cameraMoveId: "camera_renderpath1",
        keyframes: [{
          outgoingEasing: {
            kind: "cubic-bezier",
            x1: 0.42,
            x2: 0.58,
            y1: 0,
            y2: 1,
          },
          pose: {
            centerX: 0.25,
            centerY: 0.5,
            space: "prepared-video-layer-normalized-v1",
            zoom: 2,
          },
          projectTimeUs: 0,
        }, {
          outgoingEasing: { kind: "linear" },
          pose: {
            centerX: 0.5,
            centerY: 0.5,
            space: "prepared-video-layer-normalized-v1",
            zoom: 2,
          },
          projectTimeUs: 5_000_000,
        }, {
          outgoingEasing: { kind: "linear" },
          pose: {
            centerX: 0.75,
            centerY: 0.5,
            space: "prepared-video-layer-normalized-v1",
            zoom: 4,
          },
          projectTimeUs: PROJECT_DURATION_US,
        }],
        origin: { kind: "manual" },
        placementId: placement.placementId,
        projectRange: { endUs: PROJECT_DURATION_US, startUs: 0 },
        streamId,
      }],
    });
    const render = compileProjectRenderPlan(project, plan, {
      frameRate: 30,
      pixelHeight: 720,
      pixelWidth: 1_280,
    });

    expect(render.cameraSegments.map(segment => ({
      assetRange: segment.assetRange,
      outputRange: segment.outputRange,
      projectRange: segment.projectRange,
    }))).toEqual([
      {
        assetRange: { endUs: 2_120_000, startUs: 100_000 },
        outputRange: { endUs: 2_000_000, startUs: 0 },
        projectRange: { endUs: 2_000_000, startUs: 0 },
      },
      {
        assetRange: { endUs: 5_150_000, startUs: 4_140_000 },
        outputRange: { endUs: 2_500_000, startUs: 2_000_000 },
        projectRange: { endUs: 5_000_000, startUs: 4_000_000 },
      },
      {
        assetRange: { endUs: 6_160_000, startUs: 5_150_000 },
        outputRange: { endUs: 3_000_000, startUs: 2_500_000 },
        projectRange: { endUs: 6_000_000, startUs: 5_000_000 },
      },
      {
        assetRange: { endUs: 10_200_000, startUs: 6_160_000 },
        outputRange: { endUs: 7_000_000, startUs: 3_000_000 },
        projectRange: { endUs: 10_000_000, startUs: 6_000_000 },
      },
    ]);
    expect(render.cameraSegments[0]?.transforms[0]?.interpolationProjectRange)
      .toEqual({ endUs: 5_000_000, startUs: 0 });
    expect(render.cameraSegments[1]?.transforms[0]?.interpolationProjectRange)
      .toEqual({ endUs: 5_000_000, startUs: 0 });
    expect(render.cameraSegments[2]?.transforms[0]?.interpolationProjectRange)
      .toEqual({ endUs: 10_000_000, startUs: 5_000_000 });
    expect(render.cameraSegments.every(segment => (
      segment.layerPixelWidth === 1_280 && segment.layerPixelHeight === 720
    ))).toBe(true);
    expect(render.cameraSegments.some(segment => (
      segment.projectRange.startUs < 4_000_000 && segment.projectRange.endUs > 2_000_000
    ))).toBe(false);
  });
});

test("reports provisional timing, missing source coverage, and disabled placements without inventing media", () => {
  const base = syncedProject();
  const gapStartUs = 4_140_000;
  const gapEndUs = 6_160_000;
  const project = VideoProjectV1Schema.parse({
    ...base,
    assets: base.assets.map(asset => asset.assetId !== "asset_camera00001" ? asset : {
      ...asset,
      streams: asset.streams.map(stream => ({
        ...stream,
        segments: [
          segment("fixtures/camera-part-1.mov", stream.kind === "video" ? 0 : 1, 100_000, gapStartUs, 0),
          segment("fixtures/camera-part-2.mov", stream.kind === "video" ? 0 : 1, gapEndUs, 10_200_000, 0),
        ],
      })),
    }),
    placements: [
      base.placements[0],
      {
        ...base.placements[1],
        sync: {
          ...base.placements[1]!.sync,
          provenance: { kind: "unverified", reason: "initial-placement" },
        },
      },
      {
        ...base.placements[1],
        enabled: false,
        placementId: "placement_disabled001",
      },
    ],
  });
  const plan = createDefaultProjectEditPlan(project, EditPlanIdSchema.parse("plan_renderplan02"), NOW);
  const render = compileProjectRenderPlan(project, plan);

  expect(render.warnings.map(({ code, placementId }) => ({ code, placementId: String(placementId) }))).toEqual([{
    code: "unverified-sync",
    placementId: "placement_camera00001",
  }, {
    code: "missing-media-coverage",
    placementId: "placement_camera00001",
  }, {
    code: "disabled-placement",
    placementId: "placement_disabled001",
  }]);
  const targetVideo = render.videoSlices.filter(slice => slice.placementId === "placement_camera00001");
  expect(targetVideo.map(slice => slice.projectRange)).toEqual([
    { endUs: 4_000_000, startUs: 0 },
    { endUs: 10_000_000, startUs: 6_000_000 },
  ]);
  expect([...render.videoSlices, ...render.audioSlices]
    .some(slice => slice.placementId === "placement_disabled001")).toBe(false);
});

test("rejects an edit plan after the project structure changes", () => {
  const project = syncedProject();
  const plan = editedPlan(project);
  const changed = VideoProjectV1Schema.parse({
    ...project,
    placements: project.placements.map(placement => (
      placement.placementId === "placement_camera00001"
        ? { ...placement, enabled: false }
        : placement
    )),
  });
  expect(() => compileProjectRenderPlan(changed, plan)).toThrow(/out of sync/u);
});
