import { describe, expect, test } from "bun:test";

import {
  faceFramingViewport,
  mapSourceFaceRectToPreparedLayer,
  planFaceFraming,
  simplifyFaceFramingKeyframes,
  unionNormalizedFaceRects,
} from "./face-framing";

const framingConfig = {
  gapPolicy: { kind: "hold", maximumHoldUs: 1_000_000, whenExpired: "fallback" },
  headroomRatio: 0.2,
  maximumZoom: 5,
  paddingRatio: 0.25,
  requireAllSelectedFaces: true,
  simplificationTolerance: 0,
  smoothingTimeUs: 500_000,
} as const;

function preparedFrame(assetTimeUs: number, detections: readonly Readonly<Record<string, unknown>>[]) {
  return {
    assetTimeUs,
    detections,
    space: "prepared-video-layer-normalized-v1",
    state: "analyzed",
  };
}

function tracked(trackId: string, x: number, y = 0.25) {
  return {
    confidence: 0.9,
    rect: { height: 0.2, width: 0.1, x, y },
    trackId,
  };
}

describe("face layer mapping and framing", () => {
  test("maps crop and contain letterboxing into prepared-layer space", () => {
    const mapped = mapSourceFaceRectToPreparedLayer(
      { height: 0.2, width: 0.2, x: 0.4, y: 0.4 },
      {
        crop: { bottom: 0, kind: "normalized-insets", left: 0.25, right: 0.25, top: 0 },
        fit: "contain",
        layerPixelHeight: 1_000,
        layerPixelWidth: 1_000,
        sourceDisplayAspect: 2,
      },
    );
    expect(mapped).not.toBeNull();
    expect(mapped!.x).toBeCloseTo(0.3);
    expect(mapped!.width).toBeCloseTo(0.4);
    expect(mapped!.y).toBeCloseTo(0.4);
  });

  test("clips a cover-mapped face and omits a fully covered face", () => {
    const mapping = {
      crop: { kind: "none" },
      fit: "cover",
      layerPixelHeight: 1_000,
      layerPixelWidth: 1_000,
      sourceDisplayAspect: 2,
    } as const;
    expect(mapSourceFaceRectToPreparedLayer(
      { height: 0.2, width: 0.2, x: 0, y: 0.4 },
      mapping,
    )).toBeNull();
    const partiallyVisible = mapSourceFaceRectToPreparedLayer(
      { height: 0.2, width: 0.2, x: 0.2, y: 0.4 },
      mapping,
    );
    expect(partiallyVisible).not.toBeNull();
    expect(partiallyVisible!.x).toBe(0);
    expect(partiallyVisible!.width).toBeGreaterThan(0);
  });

  test("unions multiple faces and adds padding plus headroom", () => {
    const union = unionNormalizedFaceRects([
      { height: 0.2, width: 0.1, x: 0.1, y: 0.3 },
      { height: 0.2, width: 0.1, x: 0.7, y: 0.3 },
    ]);
    expect(union).toEqual({ height: 0.2, width: 0.7, x: 0.1, y: 0.3 });
    const viewport = faceFramingViewport([union], framingConfig);
    expect(viewport.width).toBe(viewport.height);
    expect(viewport.x).toBeGreaterThanOrEqual(0);
    expect(viewport.x + viewport.width).toBeLessThanOrEqual(1);
  });

  test("plans a multi-face group, holds a short loss, then falls back", () => {
    const frames = [
      preparedFrame(0, [tracked("face_00000001", 0.1), tracked("face_00000002", 0.7)]),
      preparedFrame(500_000, [tracked("face_00000001", 0.15)]),
      preparedFrame(2_000_000, []),
    ];
    const keyframes = planFaceFraming({
      config: framingConfig,
      frames,
      range: { endUs: 3_000_000, startUs: 0 },
      trackIds: ["face_00000001", "face_00000002"],
    });
    expect(keyframes.some(keyframe => keyframe.source === "observed")).toBe(true);
    expect(keyframes.some(keyframe => keyframe.source === "held")).toBe(true);
    expect(keyframes.some(keyframe => keyframe.source === "fallback")).toBe(true);
    expect(keyframes[0]?.assetTimeUs).toBe(0);
    expect(keyframes.at(-1)?.assetTimeUs).toBe(3_000_000);
  });

  test("can make missing selected faces a hard error", () => {
    expect(() => planFaceFraming({
      config: { ...framingConfig, gapPolicy: { kind: "fail" } },
      frames: [preparedFrame(0, [])],
      range: { endUs: 1_000_000, startUs: 0 },
      trackIds: ["face_00000001"],
    })).toThrow("unavailable");
  });

  test("smooths zoom logarithmically and removes redundant geometric steps", () => {
    const keyframes = planFaceFraming({
      config: {
        ...framingConfig,
        headroomRatio: 0,
        maximumZoom: 10,
        paddingRatio: 0,
        requireAllSelectedFaces: false,
        smoothingTimeUs: 1_000_000,
      },
      frames: [
        preparedFrame(0, [{
          ...tracked("face_00000001", 0.25, 0.25),
          rect: { height: 0.5, width: 0.5, x: 0.25, y: 0.25 },
        }]),
        preparedFrame(1_000_000, [{
          ...tracked("face_00000001", 0.45, 0.45),
          rect: { height: 0.1, width: 0.1, x: 0.45, y: 0.45 },
        }]),
      ],
      range: { endUs: 2_000_000, startUs: 0 },
      trackIds: ["face_00000001"],
    });
    const smoothed = keyframes.find(keyframe => keyframe.assetTimeUs === 1_000_000);
    const alpha = 1 - Math.exp(-1);
    expect(smoothed?.zoom).toBeCloseTo(Math.exp(Math.log(2) + alpha * (Math.log(10) - Math.log(2))));

    const simplified = simplifyFaceFramingKeyframes([
      {
        assetTimeUs: 0,
        source: "observed",
        viewport: { height: 1, width: 1, x: 0, y: 0 },
        visibleTrackIds: ["face_00000001"],
        zoom: 1,
      },
      {
        assetTimeUs: 1_000_000,
        source: "observed",
        viewport: { height: 0.5, width: 0.5, x: 0.25, y: 0.25 },
        visibleTrackIds: ["face_00000001"],
        zoom: 2,
      },
      {
        assetTimeUs: 2_000_000,
        source: "observed",
        viewport: { height: 0.25, width: 0.25, x: 0.375, y: 0.375 },
        visibleTrackIds: ["face_00000001"],
        zoom: 4,
      },
    ], 1e-12);
    expect(simplified.map(keyframe => keyframe.assetTimeUs)).toEqual([0, 2_000_000]);
  });
});
