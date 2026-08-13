import { expect } from "bun:test";
import { assertProperty, fc } from "../testing/property";

import { faceFramingViewport } from "./face-framing";
import { associateFaceDetections } from "./face-tracks";

const trackingConfig = {
  iouWeight: 0.5,
  maximumCenterDistance: 0.3,
  maximumFacesPerFrame: 16,
  maximumGapUs: 2_000_000,
  minimumConfidence: 0,
  minimumIou: 0,
} as const;

const faceArbitrary = fc.record({
  confidence: fc.double({ min: 0, max: 1, noNaN: true }),
  height: fc.double({ min: 0.02, max: 0.25, noNaN: true }),
  width: fc.double({ min: 0.02, max: 0.25, noNaN: true }),
  xUnit: fc.double({ min: 0, max: 1, noNaN: true }),
  yUnit: fc.double({ min: 0, max: 1, noNaN: true }),
}).map(({ confidence, height, width, xUnit, yUnit }) => ({
  confidence,
  rect: {
    height,
    width,
    x: xUnit * (1 - width),
    y: yUnit * (1 - height),
  },
}));

assertProperty(fc.property(
  fc.array(fc.array(faceArbitrary, { maxLength: 8 }), { maxLength: 20 }),
  (detectionsByFrame) => {
    const frames = detectionsByFrame.map((detections, index) => ({
      assetTimeUs: index * 500_000,
      detections,
    }));
    const expected = associateFaceDetections(frames, trackingConfig);
    const permuted = associateFaceDetections(
      [...frames].reverse().map(frame => ({ ...frame, detections: [...frame.detections].reverse() })),
      trackingConfig,
    );
    expect(permuted).toEqual(expected);
    for (const result of expected.results) {
      const ids = result.detections.map(detection => detection.trackId);
      expect(new Set(ids).size).toBe(ids.length);
      for (const detection of result.detections) {
        expect(detection.rect.x).toBeGreaterThanOrEqual(0);
        expect(detection.rect.y).toBeGreaterThanOrEqual(0);
        expect(detection.rect.x + detection.rect.width).toBeLessThanOrEqual(1);
        expect(detection.rect.y + detection.rect.height).toBeLessThanOrEqual(1);
      }
    }
  },
));

assertProperty(fc.property(
  fc.array(faceArbitrary.map(face => face.rect), { minLength: 1, maxLength: 16 }),
  fc.double({ min: 1, max: 10, noNaN: true }),
  fc.double({ min: 0, max: 1, noNaN: true }),
  fc.double({ min: 0, max: 1, noNaN: true }),
  (rects, maximumZoom, paddingRatio, headroomRatio) => {
    const viewport = faceFramingViewport(rects, {
      gapPolicy: { kind: "fallback" },
      headroomRatio,
      maximumZoom,
      paddingRatio,
      requireAllSelectedFaces: false,
      simplificationTolerance: 0.001,
      smoothingTimeUs: 100_000,
    });
    expect(viewport.width).toBe(viewport.height);
    expect(viewport.width).toBeGreaterThanOrEqual(1 / maximumZoom - 1e-12);
    expect(viewport.x).toBeGreaterThanOrEqual(0);
    expect(viewport.y).toBeGreaterThanOrEqual(0);
    expect(viewport.x + viewport.width).toBeLessThanOrEqual(1);
    expect(viewport.y + viewport.height).toBeLessThanOrEqual(1);
  },
));
