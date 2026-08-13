import { describe, expect, test } from "bun:test";

import {
  deduplicateFrameFingerprints,
  differenceHash64,
  perceptualHashDistance,
  planSceneBatches,
  planSceneSampling,
  SCENE_BATCH_LIMITS,
} from "./scene-sampling";

const digest = "a".repeat(64);

describe("scene sampling", () => {
  test("partitions at evidence boundaries and maximum gaps with stable IDs", () => {
    const input = {
      boundaries: [
        { confidence: 0.7, kind: "event" as const, timeUs: 4_000_000 },
        { confidence: 0.9, kind: "motion" as const, timeUs: 4_000_000 },
      ],
      inputDigest: digest,
      maximumSceneDurationUs: 3_000_000,
      ranges: [{ endUs: 10_000_000, startUs: 0 }],
    };
    const plan = planSceneSampling(input);

    expect(plan.scenes.map(scene => scene.range)).toEqual([
      { endUs: 3_000_000, startUs: 0 },
      { endUs: 4_000_000, startUs: 3_000_000 },
      { endUs: 7_000_000, startUs: 4_000_000 },
      { endUs: 10_000_000, startUs: 7_000_000 },
    ]);
    expect(plan.scenes[2]?.boundaryConfidence).toBe(0.9);
    expect(plan.samples.find(sample => sample.requestedAssetTimeUs === 4_000_000)?.reasons)
      .toEqual(["boundary", "event", "motion"]);
    expect(planSceneSampling({ ...input, boundaries: [...input.boundaries].reverse() })).toEqual(plan);
    expect(new Set(plan.scenes.map(scene => scene.sceneId)).size).toBe(plan.scenes.length);
    expect(new Set(plan.samples.map(sample => sample.sampleId)).size).toBe(plan.samples.length);
  });

  test("coalesces coincident samples without losing their reasons", () => {
    const plan = planSceneSampling({
      boundaries: [],
      inputDigest: digest,
      maximumSceneDurationUs: 10,
      ranges: [{ endUs: 1, startUs: 0 }],
    });
    expect(plan.samples).toHaveLength(1);
    expect(plan.samples[0]?.reasons).toEqual(["boundary", "middle"]);
    const onlySample = plan.samples[0];
    expect(onlySample).toBeDefined();
    if (onlySample === undefined) throw new Error("Expected one planned sample.");
    expect(plan.scenes[0]?.sampleIds).toEqual([onlySample.sampleId]);
  });

  test("computes and compares 64-bit difference hashes", () => {
    const increasing = Uint8Array.from({ length: 72 }, (_, index) => index % 9);
    const decreasing = Uint8Array.from({ length: 72 }, (_, index) => 8 - index % 9);
    expect(differenceHash64(increasing)).toBe("0000000000000000");
    expect(differenceHash64(decreasing)).toBe("ffffffffffffffff");
    expect(perceptualHashDistance("0000000000000000", "ffffffffffffffff")).toBe(64);
    expect(perceptualHashDistance("0000000000000000", "0000000000000001")).toBe(1);
  });

  test("deduplicates storage evidence deterministically while retaining sample identities", () => {
    const frames = [
      { perceptualHash: "0000000000000000", sampleId: "sample_bbbbbbbb", sha256: "b".repeat(64) },
      { perceptualHash: "0000000000000001", sampleId: "sample_aaaaaaaa", sha256: "a".repeat(64) },
      { perceptualHash: "ffffffffffffffff", sampleId: "sample_cccccccc", sha256: "b".repeat(64) },
    ];
    const deduplicated = deduplicateFrameFingerprints(frames, 1);
    expect(deduplicated).toEqual([
      { canonicalSampleId: "sample_aaaaaaaa", exactContent: true, perceptualDistance: 0, sampleId: "sample_aaaaaaaa" },
      { canonicalSampleId: "sample_aaaaaaaa", exactContent: false, perceptualDistance: 1, sampleId: "sample_bbbbbbbb" },
      { canonicalSampleId: "sample_aaaaaaaa", exactContent: true, perceptualDistance: 64, sampleId: "sample_cccccccc" },
    ]);
    expect(deduplicateFrameFingerprints([...frames].reverse(), 1)).toEqual(deduplicated);
  });

  test("packs chronological scenes without exceeding gateway limits", () => {
    const scenes = Array.from({ length: 6 }, (_, index) => ({
      frames: Array.from({ length: 3 }, (_, frameIndex) => ({
        actualAssetTimeUs: index * 1_000_000 + (2 - frameIndex),
        bytes: 400_000,
        sampleId: `sample_${index}${frameIndex}aaaaaa`,
        sha256: `${index}`.repeat(64),
      })),
      rangeStartUs: index * 1_000_000,
      sceneId: `scene_${index}aaaaaaa`,
    }));
    const batches = planSceneBatches("f".repeat(64), [...scenes].reverse());
    expect(batches.map(batch => batch.batch.sceneIds.length)).toEqual([4, 2]);
    for (const { batch } of batches) {
      expect(batch.imageBytes).toBeLessThanOrEqual(SCENE_BATCH_LIMITS.imageBytes);
      expect(batch.imageCount).toBeLessThanOrEqual(SCENE_BATCH_LIMITS.imageCount);
      expect(batch.sceneIds.length).toBeLessThanOrEqual(SCENE_BATCH_LIMITS.sceneCount);
    }
    expect(planSceneBatches("f".repeat(64), scenes)).toEqual(batches);
    expect(batches[0]?.frames.slice(0, 3).map(frame => frame.actualAssetTimeUs))
      .toEqual([2, 1, 0].sort((left, right) => left - right));
  });
});
