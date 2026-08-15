import { describe, expect, test } from "bun:test";

import { AnalysisSubjectSchema } from "../contracts/analysis";
import {
  analyzeAudioAlignment,
  envelopeCorrelationAtLag,
  type AnalyzeAudioAlignmentInput,
} from "./audio-alignment";

const SHA = "a".repeat(64);

function signal(length: number): number[] {
  let state = 0x1234_5678;
  return Array.from({ length }, (_, index) => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return (state / 0xffff_ffff - 0.5) + 0.25 * Math.sin(index * 0.173);
  });
}

function shifted(reference: readonly number[], offsetSamples: number): number[] {
  return [...Array.from({ length: offsetSamples }, () => 0), ...reference];
}

function stretched(reference: readonly number[], offsetSamples: number, scale: number): number[] {
  const length = offsetSamples + Math.ceil(reference.length * scale);
  return Array.from({ length }, (_, targetIndex) => {
    const sourcePosition = (targetIndex - offsetSamples) / scale;
    if (sourcePosition < 0 || sourcePosition >= reference.length - 1) return 0;
    const leftIndex = Math.floor(sourcePosition);
    const fraction = sourcePosition - leftIndex;
    return (reference[leftIndex] ?? 0) * (1 - fraction) + (reference[leftIndex + 1] ?? 0) * fraction;
  });
}

function input(reference: readonly number[], target: readonly number[]): AnalyzeAudioAlignmentInput {
  return {
    analysisId: "analysis_alignment001",
    config: {
      analysisSampleRateHz: 48_000,
      maxDriftPpm: 5_000,
      minimumOverlapUs: 1_000_000,
      windowUs: 600_000,
    },
    createdAt: "2026-07-22T12:00:00.000Z",
    inputDigest: SHA,
    options: { distinctPeakUs: 200_000, maxOffsetUs: 1_000_000, minimumCorrelation: 0.5 },
    reference: AnalysisSubjectSchema.parse({
      assetId: "asset_reference01",
      integritySha256: SHA,
      streamId: "stream_reference01",
    }),
    referenceEnvelope: { hopUs: 10_000, values: reference },
    target: AnalysisSubjectSchema.parse({
      assetId: "asset_target0001",
      integritySha256: SHA,
      streamId: "stream_target0001",
    }),
    targetEnvelope: { hopUs: 10_000, values: target },
    tool: { name: "studio", profile: "numeric-envelope-v1", version: "0.1.0" },
  };
}

describe("audio alignment", () => {
  test("uses a positive lag when the target feature occurs later", () => {
    const reference = signal(700);
    const result = analyzeAudioAlignment(input(reference, shifted(reference, 25)));
    expect(result.kind).toBe("atet.audio-alignment-analysis");

    expect(result.result.status).toBe("matched");
    if (result.result.status !== "matched") throw new Error("Expected a matched alignment.");
    expect(result.result.candidates[0]?.initialOffsetUs).toBe(250_000);
    expect(result.result.candidates[0]?.confidence).toBeGreaterThan(0.8);
    expect(result.matches.length).toBeGreaterThanOrEqual(2);
  });

  test("fits clock drift from local envelope matches", () => {
    const reference = signal(1_200);
    const result = analyzeAudioAlignment(input(reference, stretched(reference, 12, 1.002)));

    expect(result.result.status).toBe("matched");
    if (result.result.status !== "matched") throw new Error("Expected a matched alignment.");
    expect(result.result.candidates[0]?.initialOffsetUs).toBeWithin(100_000, 140_000);
    expect(result.result.candidates[0]?.driftPpm).toBeWithin(500, 3_500);
    expect(result.result.candidates[0]?.maxResidualUs).toBeLessThanOrEqual(20_000);
  });

  test("reports competing periodic peaks as ambiguous", () => {
    const periodic = Array.from({ length: 800 }, (_, index) => index % 20 < 4 ? 1 : 0);
    const result = analyzeAudioAlignment({
      ...input(periodic, periodic),
      options: { ambiguityMargin: 0.02, distinctPeakUs: 150_000, maxOffsetUs: 500_000, minimumCorrelation: 0.8 },
    });

    expect(result.result.status).toBe("ambiguous");
    if (result.result.status !== "ambiguous") throw new Error("Expected ambiguous alignment.");
    expect(result.result.candidates.length).toBeGreaterThanOrEqual(2);
    expect(result.result.candidates.every(candidate => !candidate.autoApplicable)).toBe(true);
  });

  test("distinguishes silent input from a low correlation", () => {
    const result = analyzeAudioAlignment(input(Array.from({ length: 200 }, () => 0), signal(200)));
    expect(result.result).toMatchObject({ reason: "silent-input", status: "no-match" });
  });

  test("exposes normalized correlation for numeric feature adapters", () => {
    expect(envelopeCorrelationAtLag([1, 2, 4, 8], [0, 1, 2, 4, 8], 1).score).toBeCloseTo(1, 12);
    expect(envelopeCorrelationAtLag([1, 2, 3], [3, 2, 1], 0).score).toBeCloseTo(-1, 12);
  });
});
