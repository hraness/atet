import { describe, expect, test } from "bun:test";

import { EditPlanV1Schema, OverlayOperationSchema, OverlaySourceSchema, ZoomOperationSchema } from "./edit";
import { testPlan } from "../core/test-support";

const HASH = "1".repeat(64);
const provenance = { kind: "imported", originalName: "asset.png", sourceSha256: HASH } as const;

describe("overlay source structure", () => {
  test("static sources reject playback settings", () => {
    expect(() => OverlaySourceSchema.parse({
      asset: { bytes: 1, mediaType: "image/png", path: "assets/picture.png", provenance, sha256: HASH },
      kind: "image",
      playback: { endBehavior: "loop", playbackRate: 1, sourceInUs: 0, sourceOutUs: 1 },
    })).toThrow();
  });

  test("animated sources require bounded playback and an audio policy", () => {
    expect(() => OverlaySourceSchema.parse({
      asset: { bytes: 1, mediaType: "image/gif", path: "assets/animation.gif", provenance, sha256: HASH },
      kind: "gif",
    })).toThrow();
    const animated = OverlaySourceSchema.parse({
      asset: { bytes: 1, mediaType: "image/gif", path: "assets/animation.gif", provenance, sha256: HASH },
      audioPolicy: { kind: "mute" },
      kind: "gif",
      playback: { endBehavior: "loop", playbackRate: 1, sourceInUs: 0, sourceOutUs: 1_000_000 },
    });
    expect(animated.kind).toBe("gif");
    if (animated.kind !== "gif") throw new Error("Expected GIF playback.");
    expect(animated.playback).toMatchObject({ audioStreamIndex: null, videoStreamIndex: null });
    expect(OverlaySourceSchema.parse({
      ...animated,
      playback: { ...animated.playback, audioStreamIndex: 7, videoStreamIndex: 4 },
    })).toMatchObject({ playback: { audioStreamIndex: 7, videoStreamIndex: 4 } });
  });

  test("validates combined overlay transitions", () => {
    const operation = {
      anchor: "center",
      entrance: { durationUs: 600, easing: { kind: "linear" }, kind: "fade" },
      exit: { durationUs: 600, easing: { kind: "linear" }, kind: "fade" },
      intrinsicSize: { height: 64, width: 64 },
      opacity: 1,
      overlayId: "overlay_example1",
      position: { x: 0, y: 0 },
      range: { endUs: 1_000, startUs: 0 },
      rotationDegrees: 0,
      scale: 1,
      size: { kind: "intrinsic" },
      source: {
        asset: { bytes: 1, mediaType: "image/png", path: "assets/picture.png", provenance, sha256: HASH },
        kind: "image",
      },
      zIndex: 1,
    };
    expect(() => OverlayOperationSchema.parse(operation)).toThrow(/entrance and exit/u);
  });

  test("makes overlay placement explicitly output-pixel based", () => {
    const overlay = OverlayOperationSchema.parse({
      anchor: "center",
      entrance: { kind: "none" },
      exit: { kind: "none" },
      intrinsicSize: { height: 64, width: 64 },
      opacity: 1,
      overlayId: "overlay_example2",
      position: { x: 20, y: 30 },
      range: { endUs: 1_000, startUs: 0 },
      rotationDegrees: 0,
      scale: 1,
      size: { kind: "intrinsic" },
      source: {
        asset: { bytes: 1, mediaType: "image/png", path: "assets/picture.png", provenance, sha256: HASH },
        kind: "image",
      },
      zIndex: 1,
    });
    expect(overlay.coordinateSpace).toBe("output-pixels");
    expect(overlay.blendMode).toBe("normal");
    expect(overlay.crop).toEqual({ kind: "none" });
    expect(overlay.fit).toBe("fill");
    expect(overlay.mask).toEqual({ kind: "none" });
    expect(overlay.motion).toEqual({ kind: "none" });
  });

  test("accepts complete visual controls for static and animated overlay media", () => {
    const operation = OverlayOperationSchema.parse({
      anchor: "bottom-right",
      blendMode: "screen",
      crop: { bottom: 0.2, kind: "normalized-insets", left: 0.1, right: 0.1, top: 0.2 },
      entrance: { kind: "none" },
      exit: { kind: "none" },
      fit: "cover",
      intrinsicSize: { height: 360, width: 640 },
      mask: { kind: "rounded-rectangle", radiusPx: 24 },
      motion: {
        keyframes: [
          {
            easing: { kind: "ease-in-out" },
            offset: 0,
            opacityMultiplier: 0,
            positionOffset: { x: -50, y: 10 },
            rotationOffsetDegrees: -5,
            scaleMultiplier: 0.8,
          },
          {
            easing: { kind: "linear" },
            offset: 1,
            opacityMultiplier: 1,
            positionOffset: { x: 0, y: 0 },
            rotationOffsetDegrees: 0,
            scaleMultiplier: 1,
          },
        ],
        kind: "keyframes",
        timeline: "visible-output",
      },
      opacity: 0.8,
      overlayId: "overlay_visual01",
      position: { x: -32, y: -32 },
      range: { endUs: 2_000_000, startUs: 0 },
      rotationDegrees: 10,
      scale: 1,
      size: { height: 360, kind: "pixels", width: 640 },
      source: {
        asset: { bytes: 1, mediaType: "image/gif", path: "assets/animation.gif", provenance, sha256: HASH },
        audioPolicy: { kind: "mute" },
        kind: "gif",
        playback: { endBehavior: "freeze-end", playbackRate: 0.5, sourceInUs: 100_000, sourceOutUs: 900_000 },
      },
      zIndex: 2,
    });

    expect(operation).toMatchObject({ blendMode: "screen", fit: "cover" });
    expect(operation.motion.kind).toBe("keyframes");
  });

  test("rejects crop and motion keyframes that cannot be rendered deterministically", () => {
    const base = {
      anchor: "center",
      entrance: { kind: "none" },
      exit: { kind: "none" },
      intrinsicSize: { height: 64, width: 64 },
      opacity: 1,
      overlayId: "overlay_invalid1",
      position: { x: 0, y: 0 },
      range: { endUs: 1_000, startUs: 0 },
      rotationDegrees: 0,
      scale: 1,
      size: { kind: "intrinsic" },
      source: {
        asset: { bytes: 1, mediaType: "image/png", path: "assets/picture.png", provenance, sha256: HASH },
        kind: "image",
      },
      zIndex: 1,
    } as const;
    expect(() => OverlayOperationSchema.parse({
      ...base,
      crop: { bottom: 0, kind: "normalized-insets", left: 0.6, right: 0.4, top: 0 },
    })).toThrow(/leave visible content/u);
    expect(() => OverlayOperationSchema.parse({
      ...base,
      motion: {
        keyframes: [
          {
            easing: { kind: "linear" },
            offset: 0.25,
            opacityMultiplier: 1,
            positionOffset: { x: 0, y: 0 },
            rotationOffsetDegrees: 0,
            scaleMultiplier: 1,
          },
          {
            easing: { kind: "linear" },
            offset: 1,
            opacityMultiplier: 1,
            positionOffset: { x: 0, y: 0 },
            rotationOffsetDegrees: 0,
            scaleMultiplier: 1,
          },
        ],
        kind: "keyframes",
        timeline: "visible-output",
      },
    })).toThrow(/begin at offset 0/u);
  });

  test("rejects combined transform scale that can exhaust renderer geometry", () => {
    expect(() => OverlayOperationSchema.parse({
      anchor: "center",
      entrance: { durationUs: 1, easing: { kind: "linear" }, fromScale: 32, kind: "scale" },
      exit: { kind: "none" },
      intrinsicSize: { height: 1, width: 1 },
      motion: {
        keyframes: [
          { easing: { kind: "linear" }, offset: 0, opacityMultiplier: 1, positionOffset: { x: 0, y: 0 }, rotationOffsetDegrees: 0, scaleMultiplier: 128 },
          { easing: { kind: "linear" }, offset: 1, opacityMultiplier: 1, positionOffset: { x: 0, y: 0 }, rotationOffsetDegrees: 0, scaleMultiplier: 128 },
        ],
        kind: "keyframes",
        timeline: "visible-output",
      },
      opacity: 1,
      overlayId: "overlay_hugescale",
      position: { x: 0, y: 0 },
      range: { endUs: 2, startUs: 0 },
      rotationDegrees: 0,
      scale: 128,
      size: { height: 1, kind: "pixels", width: 1 },
      source: {
        asset: { bytes: 1, mediaType: "image/png", path: "assets/picture.png", provenance, sha256: HASH },
        kind: "image",
      },
      zIndex: 1,
    })).toThrow(/render safety limit/u);
  });
});

test("zoom transitions must fit the source range", () => {
  expect(() => ZoomOperationSchema.parse({
    displayId: "display-primary",
    easing: { kind: "ease-in-out" },
    enterDurationUs: 600,
    exitDurationUs: 600,
    kind: "manual",
    range: { endUs: 1_000, startUs: 0 },
    scale: 2,
    target: { kind: "point", point: { x: 1, y: 1 } },
    zoomId: "zoom_example01",
  })).toThrow(/enter and exit/u);
});

test("same-display zooms cannot overlap while different displays remain independent", () => {
  const zoom = {
    displayId: "display-primary",
    easing: { kind: "linear" },
    enterDurationUs: 0,
    exitDurationUs: 0,
    kind: "manual",
    range: { endUs: 2_000_000, startUs: 1_000_000 },
    scale: 2,
    target: { kind: "point", point: { x: 100, y: 100 } },
    zoomId: "zoom_example01",
  } as const;
  expect(() => EditPlanV1Schema.parse({
    ...testPlan(),
    zooms: [zoom, { ...zoom, range: { endUs: 2_500_000, startUs: 1_500_000 }, zoomId: "zoom_example02" }],
  })).toThrow(/must not overlap/u);
  expect(() => EditPlanV1Schema.parse({
    ...testPlan(),
    zooms: [zoom, { ...zoom, displayId: "display-left", zoomId: "zoom_example02" }],
  })).not.toThrow();
});
