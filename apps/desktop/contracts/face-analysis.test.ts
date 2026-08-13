import { describe, expect, test } from "bun:test";

import { FaceAnalysisV1Schema, NormalizedTopLeftRectSchema } from "./analysis";

const HASH = "a".repeat(64);

function faceAnalysis(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    analysisId: "analysis_faces001",
    backend: {
      architecture: "arm64",
      kind: "apple-vision",
      osBuild: "25A123",
      requestRevision: 3,
      runtimeVersion: "26.0",
    },
    config: {
      sampleIntervalUs: 1_000_000,
      tracking: {
        iouWeight: 0.6,
        maximumCenterDistance: 0.25,
        maximumFacesPerFrame: 16,
        maximumGapUs: 1_000_000,
        minimumConfidence: 0.5,
        minimumIou: 0.1,
      },
    },
    coordinateSpace: {
      encodedPixelHeight: 1080,
      encodedPixelWidth: 1920,
      mirroredHorizontally: false,
      origin: "top-left",
      pixelHeight: 1080,
      pixelWidth: 1920,
      rotationDegrees: 0,
      sampleAspectRatio: { denominator: 1, numerator: 1 },
      units: "normalized",
      xAxis: "right",
      yAxis: "down",
    },
    coverage: {
      analyzedFrames: 2,
      failedFrames: 0,
      range: { endUs: 2_000_000, startUs: 0 },
      requestedFrames: 2,
    },
    createdAt: "2026-07-23T12:00:00.000Z",
    durationUs: 2_000_000,
    inputDigest: HASH,
    kind: "studio.face-analysis",
    privacy: {
      biometricIdentification: "not-performed",
      execution: "local-only",
      storedEvidence: "bounding-boxes-only",
      tracking: "geometry-continuity-only",
    },
    results: [
      {
        assetTimeUs: 0,
        detections: [{
          confidence: 0.9,
          rect: { height: 0.2, width: 0.1, x: 0.1, y: 0.2 },
          trackId: "face_00000001",
        }],
        discardedDetections: 0,
        state: "analyzed",
      },
      {
        assetTimeUs: 1_000_000,
        detections: [{
          confidence: 0.85,
          rect: { height: 0.2, width: 0.1, x: 0.15, y: 0.2 },
          trackId: "face_00000001",
        }],
        discardedDetections: 0,
        state: "analyzed",
      },
    ],
    schemaVersion: 1,
    subject: {
      assetId: "asset_example001",
      integritySha256: HASH,
      streamId: "stream_example001",
    },
    tool: { name: "studio", profile: "face-boxes-v1", version: "0.1.0" },
    tracks: [{
      firstSeenAssetTimeUs: 0,
      lastSeenAssetTimeUs: 1_000_000,
      maximumObservedGapUs: 1_000_000,
      observationCount: 2,
      trackId: "face_00000001",
    }],
    ...overrides,
  };
}

describe("face analysis contracts", () => {
  test("accepts local geometry-only multi-frame evidence", () => {
    expect(FaceAnalysisV1Schema.parse(faceAnalysis())).toMatchObject({
      kind: "studio.face-analysis",
      privacy: {
        biometricIdentification: "not-performed",
        tracking: "geometry-continuity-only",
      },
    });
  });

  test("rejects biometric or landmark payload additions", () => {
    const input = faceAnalysis() as Record<string, unknown>;
    expect(FaceAnalysisV1Schema.safeParse({ ...input, identities: [{ name: "someone" }] }).success).toBe(false);
    const results = structuredClone(input.results) as Record<string, unknown>[];
    const first = results[0]!;
    const detections = first.detections as Record<string, unknown>[];
    detections[0] = { ...detections[0], landmarks: [] };
    expect(FaceAnalysisV1Schema.safeParse({ ...input, results }).success).toBe(false);
  });

  test("cross-checks coverage, track summaries, gaps, and orientation", () => {
    const input = faceAnalysis() as Record<string, unknown>;
    expect(FaceAnalysisV1Schema.safeParse({
      ...input,
      coverage: { analyzedFrames: 1, failedFrames: 0, range: { endUs: 2_000_000, startUs: 0 }, requestedFrames: 2 },
    }).success).toBe(false);
    expect(FaceAnalysisV1Schema.safeParse({
      ...input,
      tracks: [{
        firstSeenAssetTimeUs: 0,
        lastSeenAssetTimeUs: 1_000_000,
        maximumObservedGapUs: 0,
        observationCount: 2,
        trackId: "face_00000001",
      }],
    }).success).toBe(false);
    expect(FaceAnalysisV1Schema.safeParse({
      ...input,
      coordinateSpace: {
        ...(input.coordinateSpace as Record<string, unknown>),
        rotationDegrees: 90,
      },
    }).success).toBe(false);
  });

  test("enforces normalized top-left frame bounds", () => {
    expect(NormalizedTopLeftRectSchema.safeParse({ height: 0.2, width: 0.2, x: 0.8, y: 0.8 }).success).toBe(true);
    expect(NormalizedTopLeftRectSchema.safeParse({ height: 0.2, width: 0.2, x: 0.81, y: 0.8 }).success)
      .toBe(false);
    expect(NormalizedTopLeftRectSchema.safeParse({ height: 0, width: 0.2, x: 0, y: 0 }).success).toBe(false);
  });
});
