import { describe, expect, test } from "bun:test";

import { associateFaceDetections } from "./face-tracks";

const config = {
  iouWeight: 0.6,
  maximumCenterDistance: 0.3,
  maximumFacesPerFrame: 16,
  maximumGapUs: 2_000_000,
  minimumConfidence: 0.5,
  minimumIou: 0.05,
} as const;

function face(x: number, y = 0.2) {
  return { confidence: 0.9, rect: { height: 0.2, width: 0.1, x, y } };
}

describe("face geometry association", () => {
  test("keeps two crossing faces on their predicted motion paths", () => {
    const associated = associateFaceDetections([
      { assetTimeUs: 0, detections: [face(0.1), face(0.7)] },
      { assetTimeUs: 1_000_000, detections: [face(0.5), face(0.3)] },
      { assetTimeUs: 2_000_000, detections: [face(0.25), face(0.55)] },
    ], config);
    expect(associated.tracks).toHaveLength(2);
    const last = associated.results[2]!;
    expect(last.detections.map(detection => [String(detection.trackId), detection.rect.x])).toEqual([
      ["face_00000001", 0.55],
      ["face_00000002", 0.25],
    ]);
  });

  test("bridges bounded gaps and starts a new track after expiration", () => {
    const associated = associateFaceDetections([
      { assetTimeUs: 0, detections: [face(0.1)] },
      { assetTimeUs: 1_000_000, detections: [] },
      { assetTimeUs: 2_000_000, detections: [face(0.12)] },
      { assetTimeUs: 5_000_001, detections: [face(0.13)] },
    ], config);
    expect(String(associated.results[2]!.detections[0]?.trackId)).toBe("face_00000001");
    expect(String(associated.results[3]!.detections[0]?.trackId)).toBe("face_00000002");
    expect(associated.tracks.map(track => track.observationCount)).toEqual([2, 1]);
  });

  test("caps faces by confidence and records all discarded detections", () => {
    const associated = associateFaceDetections([{
      assetTimeUs: 0,
      detections: [
        { ...face(0.1), confidence: 0.9 },
        { ...face(0.3), confidence: 0.8 },
        { ...face(0.5), confidence: 0.4 },
      ],
    }], { ...config, maximumFacesPerFrame: 1 });
    expect(associated.results[0]).toMatchObject({
      detections: [{ confidence: 0.9 }],
      discardedDetections: 2,
    });
  });

  test("rejects duplicate sample times", () => {
    expect(() => associateFaceDetections([
      { assetTimeUs: 0, detections: [] },
      { assetTimeUs: 0, detections: [] },
    ], config)).toThrow("must be unique");
  });
});
