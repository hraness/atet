import { describe, expect, test } from "bun:test";

import {
  ProjectCameraKeyframeSchema,
  ProjectCameraMoveSchema,
  ProjectCameraSegmentSchema,
  type CameraPose,
  type ProjectCameraMove,
} from "../contracts";
import {
  cameraPoseToNormalizedViewport,
  evaluateCameraMovePose,
  evaluateEasingProgress,
  interpolateCameraPose,
} from "./project-camera";
import {
  buildProjectCameraSpatialIndex,
  evaluateProjectCameraSpatialViewportAt,
  projectCameraSpatialLayer,
  projectCameraSpatialLayerAtOutputTime,
} from "./project-camera-spatial";

const HASH = "c".repeat(64);

function move(): ProjectCameraMove {
  return ProjectCameraMoveSchema.parse({
    binding: { geometrySha256: HASH, syncSha256: HASH },
    cameraMoveId: "camera_evaluate1",
    keyframes: [{
      outgoingEasing: { kind: "linear" },
      pose: {
        centerX: 0.25,
        centerY: 0.5,
        space: "prepared-video-layer-normalized-v1",
        zoom: 2,
      },
      projectTimeUs: 1_000_000,
    }, {
      outgoingEasing: { kind: "linear" },
      pose: {
        centerX: 0.75,
        centerY: 0.5,
        space: "prepared-video-layer-normalized-v1",
        zoom: 8,
      },
      projectTimeUs: 5_000_000,
    }],
    origin: { kind: "manual" },
    placementId: "placement_evaluate1",
    projectRange: { endUs: 5_000_000, startUs: 1_000_000 },
    streamId: "stream_evaluate01",
  });
}

describe("camera interpolation", () => {
  test("interpolates zoom logarithmically while panning the normalized center", () => {
    const midpoint = evaluateCameraMovePose(move(), 3_000_000);
    expect(midpoint.centerX).toBeCloseTo(0.5, 12);
    expect(midpoint.centerY).toBe(0.5);
    expect(midpoint.zoom).toBeCloseTo(4, 12);
    const viewport = cameraPoseToNormalizedViewport(midpoint);
    expect(viewport.height).toBeCloseTo(0.25, 12);
    expect(viewport.width).toBeCloseTo(0.25, 12);
    expect(viewport.x).toBeCloseTo(0.375, 12);
    expect(viewport.y).toBeCloseTo(0.375, 12);
  });

  test("uses outgoing easing from the path's left keyframe", () => {
    const item = move();
    const eased = ProjectCameraMoveSchema.parse({
      ...item,
      keyframes: [{
        ...item.keyframes[0],
        outgoingEasing: { kind: "ease-in" },
      }, item.keyframes[1]],
    });
    expect(evaluateCameraMovePose(eased, 3_000_000).centerX).toBeCloseTo(0.375, 12);
  });

  test("implements cubic-bezier timeline progress by inverting x like CSS", () => {
    const value = evaluateEasingProgress({
      kind: "cubic-bezier",
      x1: 0.42,
      x2: 1,
      y1: 0,
      y2: 1,
    }, 0.5);
    expect(value).toBeCloseTo(0.3153568, 6);
    expect(value).not.toBeCloseTo(0.125, 3);
  });
});

test("valid camera endpoints stay renderable throughout representative easing paths", () => {
  const poses: readonly CameraPose[] = [{
    centerX: 0.5,
    centerY: 0.5,
    space: "prepared-video-layer-normalized-v1",
    zoom: 1,
  }, {
    centerX: 0.9,
    centerY: 0.1,
    space: "prepared-video-layer-normalized-v1",
    zoom: 5,
  }, {
    centerX: 0.05,
    centerY: 0.95,
    space: "prepared-video-layer-normalized-v1",
    zoom: 10,
  }];
  for (let index = 0; index + 1 < poses.length; index += 1) {
    for (let step = 0; step <= 100; step += 1) {
      const pose = interpolateCameraPose(
        poses[index]!,
        poses[index + 1]!,
        { kind: "ease-in-out" },
        step / 100,
      );
      const viewport = cameraPoseToNormalizedViewport(pose);
      expect(viewport.x).toBeGreaterThanOrEqual(-1e-12);
      expect(viewport.y).toBeGreaterThanOrEqual(-1e-12);
      expect(viewport.x + viewport.width).toBeLessThanOrEqual(1 + 1e-12);
      expect(viewport.y + viewport.height).toBeLessThanOrEqual(1 + 1e-12);
    }
  }
});

test("one output-time evaluator applies zoom keyframes and camera-segment precedence", () => {
  const placementId = "placement_spatial01";
  const streamId = "stream_spatial0001";
  const index = buildProjectCameraSpatialIndex({
    cameraKeyframes: [{
      displayId: "display-primary",
      easing: { kind: "linear" },
      layerPixelHeight: 100,
      layerPixelWidth: 200,
      outputTimeUs: 0,
      placementId,
      scale: 1,
      sourceTimeUs: 0,
      streamId,
      viewport: { height: 100, width: 200, x: 0, y: 0 },
      zoomId: "zoom_spatial0001",
    }, {
      displayId: "display-primary",
      easing: { kind: "linear" },
      layerPixelHeight: 100,
      layerPixelWidth: 200,
      outputTimeUs: 10_000_000,
      placementId,
      scale: 2,
      sourceTimeUs: 10_000_000,
      streamId,
      viewport: { height: 50, width: 100, x: 50, y: 25 },
      zoomId: "zoom_spatial0001",
    }].map(value => ProjectCameraKeyframeSchema.parse(value)),
    cameraSegments: [ProjectCameraSegmentSchema.parse({
      assetRange: { endUs: 4_000_000, startUs: 2_000_000 },
      cameraMoveId: "camera_spatial001",
      geometrySha256: HASH,
      layerPixelHeight: 100,
      layerPixelWidth: 200,
      outputRange: { endUs: 4_000_000, startUs: 2_000_000 },
      placementId,
      projectRange: { endUs: 4_000_000, startUs: 2_000_000 },
      streamId,
      syncSha256: HASH,
      transforms: [{
        activeProjectRange: { endUs: 4_000_000, startUs: 2_000_000 },
        fromPose: {
          centerX: 0.25,
          centerY: 0.5,
          space: "prepared-video-layer-normalized-v1",
          zoom: 2,
        },
        interpolationProjectRange: {
          endUs: 4_000_000,
          startUs: 2_000_000,
        },
        outgoingEasing: { kind: "linear" },
        toPose: {
          centerX: 0.25,
          centerY: 0.5,
          space: "prepared-video-layer-normalized-v1",
          zoom: 2,
        },
      }],
    })],
  });
  const layer = projectCameraSpatialLayer(index, placementId, streamId);
  const viewportAt = (outputTimeUs: number) => (
    evaluateProjectCameraSpatialViewportAt(
      projectCameraSpatialLayerAtOutputTime(layer, outputTimeUs),
      { outputTimeUs, pixelHeight: 100, pixelWidth: 200 },
    )
  );

  expect(viewportAt(1_000_000)).toEqual({
    height: 95,
    width: 190,
    x: 5,
    y: 2.5,
  });
  expect(viewportAt(3_000_000)).toEqual({
    height: 50,
    width: 100,
    x: 0,
    y: 25,
  });
  expect(viewportAt(4_000_000)).toEqual({
    height: 80,
    width: 160,
    x: 20,
    y: 10,
  });
});

test("keeps an exact interior keyframe active in the narrowed metadata path", () => {
  const placementId = "placement_spatial03";
  const streamId = "stream_spatial0003";
  const keyframe = (
    outputTimeUs: number,
    width: number,
    x: number,
  ) => ProjectCameraKeyframeSchema.parse({
    displayId: "display-primary",
    easing: { kind: "linear" },
    layerPixelHeight: 100,
    layerPixelWidth: 200,
    outputTimeUs,
    placementId,
    scale: 200 / width,
    sourceTimeUs: outputTimeUs,
    streamId,
    viewport: {
      height: width / 2,
      width,
      x,
      y: (100 - width / 2) / 2,
    },
    zoomId: "zoom_spatial0003",
  });
  const index = buildProjectCameraSpatialIndex({
    cameraKeyframes: [
      keyframe(0, 200, 0),
      keyframe(1_000_000, 100, 50),
      keyframe(2_000_000, 50, 75),
    ],
    cameraSegments: [],
  });
  const layer = projectCameraSpatialLayer(index, placementId, streamId);
  const narrowed = projectCameraSpatialLayerAtOutputTime(layer, 1_000_000);

  expect(evaluateProjectCameraSpatialViewportAt(narrowed, {
    outputTimeUs: 1_000_000,
    pixelHeight: 100,
    pixelWidth: 200,
  })).toEqual({
    height: 50,
    width: 100,
    x: 50,
    y: 25,
  });
});

test("uses the post-cut keyframe at duplicate output timestamps", () => {
  const placementId = "placement_spatial05";
  const streamId = "stream_spatial0005";
  const keyframe = (
    outputTimeUs: number,
    sourceTimeUs: number,
    width: number,
    x: number,
  ) => ProjectCameraKeyframeSchema.parse({
    displayId: "display-primary",
    easing: { kind: "linear" },
    layerPixelHeight: 100,
    layerPixelWidth: 200,
    outputTimeUs,
    placementId,
    scale: 200 / width,
    sourceTimeUs,
    streamId,
    viewport: {
      height: width / 2,
      width,
      x,
      y: (100 - width / 2) / 2,
    },
    zoomId: "zoom_spatial0005",
  });
  const index = buildProjectCameraSpatialIndex({
    cameraKeyframes: [
      keyframe(0, 0, 200, 0),
      keyframe(1_000_000, 1_000_000, 160, 20),
      keyframe(1_000_000, 3_000_000, 80, 60),
      keyframe(2_000_000, 4_000_000, 50, 75),
    ],
    cameraSegments: [],
  });
  const layer = projectCameraSpatialLayer(index, placementId, streamId);
  const narrowed = projectCameraSpatialLayerAtOutputTime(layer, 1_000_000);
  const input = {
    outputTimeUs: 1_000_000,
    pixelHeight: 100,
    pixelWidth: 200,
  };

  expect(evaluateProjectCameraSpatialViewportAt(layer, input)).toEqual({
    height: 40,
    width: 80,
    x: 60,
    y: 30,
  });
  expect(evaluateProjectCameraSpatialViewportAt(narrowed, input)).toEqual(
    evaluateProjectCameraSpatialViewportAt(layer, input),
  );
});

test("bounds cubic-bezier overshoot for legacy zoom and camera segments", () => {
  const placementId = "placement_spatial04";
  const streamId = "stream_spatial0004";
  const easing = {
    kind: "cubic-bezier" as const,
    x1: 0.25,
    x2: 0.75,
    y1: -10,
    y2: -10,
  };
  const keyframes = [{
    displayId: "display-primary",
    easing,
    layerPixelHeight: 100,
    layerPixelWidth: 200,
    outputTimeUs: 0,
    placementId,
    scale: 1,
    sourceTimeUs: 0,
    streamId,
    viewport: { height: 100, width: 200, x: 0, y: 0 },
    zoomId: "zoom_spatial0004",
  }, {
    displayId: "display-primary",
    easing,
    layerPixelHeight: 100,
    layerPixelWidth: 200,
    outputTimeUs: 2_000_000,
    placementId,
    scale: 2,
    sourceTimeUs: 2_000_000,
    streamId,
    viewport: { height: 50, width: 100, x: 50, y: 25 },
    zoomId: "zoom_spatial0004",
  }].map(value => ProjectCameraKeyframeSchema.parse(value));
  const segment = ProjectCameraSegmentSchema.parse({
    assetRange: { endUs: 2_000_000, startUs: 0 },
    cameraMoveId: "camera_spatial004",
    geometrySha256: HASH,
    layerPixelHeight: 100,
    layerPixelWidth: 200,
    outputRange: { endUs: 2_000_000, startUs: 0 },
    placementId,
    projectRange: { endUs: 2_000_000, startUs: 0 },
    streamId,
    syncSha256: HASH,
    transforms: [{
      activeProjectRange: { endUs: 2_000_000, startUs: 0 },
      fromPose: {
        centerX: 0.5,
        centerY: 0.5,
        space: "prepared-video-layer-normalized-v1",
        zoom: 1,
      },
      interpolationProjectRange: { endUs: 2_000_000, startUs: 0 },
      outgoingEasing: easing,
      toPose: {
        centerX: 0.5,
        centerY: 0.5,
        space: "prepared-video-layer-normalized-v1",
        zoom: 2,
      },
    }],
  });
  const legacy = projectCameraSpatialLayer(
    buildProjectCameraSpatialIndex({
      cameraKeyframes: keyframes,
      cameraSegments: [],
    }),
    placementId,
    streamId,
  );
  const manual = projectCameraSpatialLayer(
    buildProjectCameraSpatialIndex({
      cameraKeyframes: [],
      cameraSegments: [segment],
    }),
    placementId,
    streamId,
  );

  expect(evaluateProjectCameraSpatialViewportAt(legacy, {
    outputTimeUs: 1_000_000,
    pixelHeight: 100,
    pixelWidth: 200,
  })).toEqual({ height: 100, width: 200, x: 0, y: 0 });
  expect(evaluateProjectCameraSpatialViewportAt(manual, {
    outputTimeUs: 1_000_000,
    pixelHeight: 100,
    pixelWidth: 200,
  })).toEqual({ height: 100, width: 200, x: 0, y: 0 });
});

test("selects the post-cut segment at an adjacent speed boundary", () => {
  const placementId = "placement_spatial02";
  const streamId = "stream_spatial0002";
  const transform = {
    activeProjectRange: { endUs: 8_000_000, startUs: 0 },
    fromPose: {
      centerX: 0.5,
      centerY: 0.5,
      space: "prepared-video-layer-normalized-v1" as const,
      zoom: 1,
    },
    interpolationProjectRange: { endUs: 8_000_000, startUs: 0 },
    outgoingEasing: { kind: "linear" as const },
    toPose: {
      centerX: 0.5,
      centerY: 0.5,
      space: "prepared-video-layer-normalized-v1" as const,
      zoom: 4,
    },
  };
  const segment = (
    cameraMoveId: string,
    projectRange: { readonly endUs: number; readonly startUs: number },
    outputRange: { readonly endUs: number; readonly startUs: number },
  ) => ProjectCameraSegmentSchema.parse({
    assetRange: projectRange,
    cameraMoveId,
    geometrySha256: HASH,
    layerPixelHeight: 100,
    layerPixelWidth: 200,
    outputRange,
    placementId,
    projectRange,
    streamId,
    syncSha256: HASH,
    transforms: [{
      ...transform,
      activeProjectRange: projectRange,
    }],
  });
  const index = buildProjectCameraSpatialIndex({
    cameraKeyframes: [],
    cameraSegments: [
      segment(
        "camera_spatial002",
        { endUs: 2_000_000, startUs: 0 },
        { endUs: 1_000_000, startUs: 0 },
      ),
      segment(
        "camera_spatial003",
        { endUs: 8_000_000, startUs: 4_000_000 },
        { endUs: 5_000_000, startUs: 1_000_000 },
      ),
    ],
  });
  const layer = projectCameraSpatialLayer(index, placementId, streamId);
  const active = projectCameraSpatialLayerAtOutputTime(layer, 1_000_000);
  const viewport = evaluateProjectCameraSpatialViewportAt(active, {
    outputTimeUs: 1_000_000,
    pixelHeight: 100,
    pixelWidth: 200,
  });

  expect(active?.segments[0]?.projectRange).toEqual({
    endUs: 8_000_000,
    startUs: 4_000_000,
  });
  expect(viewport).toEqual({
    height: 50,
    width: 100,
    x: 50,
    y: 25,
  });
});
