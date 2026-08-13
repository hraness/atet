import { describe, expect, test } from "bun:test";

import { AnalysisSubjectSchema } from "../contracts/analysis";
import {
  analyzeMusic,
  classifyChroma,
  computeChroma,
  detectMusicPresenceRegions,
  detectTempoRegions,
  estimateTempo,
  extractPcmFrameFeatures,
  type AnalyzeMusicInput,
  type PcmFrameFeatures,
} from "./music-analysis";

const SHA = "b".repeat(64);

function pulseFeatures(durationUs: number, beatTimesUs: readonly number[], hopUs = 10_000): PcmFrameFeatures[] {
  const beats = new Set(beatTimesUs.map(timeUs => Math.round(timeUs / hopUs)));
  return Array.from({ length: Math.ceil(durationUs / hopUs) }, (_, index) => ({
    chroma: [1, 0, 0, 0, 0.8, 0, 0, 0.7, 0, 0, 0, 0],
    endSample: index + 1,
    endUs: Math.min(durationUs, (index + 1) * hopUs),
    onsetStrength: beats.has(index) ? 1 : 0,
    peak: 1,
    rms: 0.2,
    startSample: index,
    startUs: index * hopUs,
    tonality: 0.8,
    zeroCrossingRate: 0.1,
  }));
}

function beats(startUs: number, endUs: number, intervalUs: number): number[] {
  const result: number[] = [];
  for (let timeUs = startUs; timeUs < endUs; timeUs += intervalUs) result.push(timeUs);
  return result;
}

function analysisInput(samples: readonly number[]): AnalyzeMusicInput {
  return {
    analysisId: "analysis_music00001",
    config: {
      hopSize: 256,
      minimumMusicUs: 500_000,
      sampleRateHz: 8_000,
      tempoWindowUs: 2_000_000,
      windowSize: 1_024,
    },
    createdAt: "2026-07-22T12:00:00.000Z",
    inputDigest: SHA,
    pcm: { sampleRateHz: 8_000, samples },
    subject: AnalysisSubjectSchema.parse({
      assetId: "asset_music000001",
      integritySha256: SHA,
      streamId: "stream_music000001",
    }),
    tool: { name: "studio", profile: "owned-pcm-v1", version: "0.1.0" },
  };
}

describe("music analysis", () => {
  test("extracts normalized PCM features and recognizes a sustained tone", () => {
    const sampleRateHz = 8_000;
    const samples = Array.from({ length: sampleRateHz * 2 }, (_, index) =>
      0.4 * Math.sin(2 * Math.PI * 261.625_565 * index / sampleRateHz));
    const features = extractPcmFrameFeatures(
      { sampleRateHz, samples },
      { hopSize: 256, windowSize: 1_024 },
    );
    const regions = detectMusicPresenceRegions(features, 500_000);

    expect(features[0]?.rms).toBeCloseTo(Math.SQRT1_2 * 0.4, 2);
    expect(features[0]?.chroma.indexOf(Math.max(...(features[0]?.chroma ?? [])))).toBe(0);
    expect(regions).toHaveLength(1);
    expect(regions[0]?.range.startUs).toBe(0);
    expect(regions[0]?.range.endUs).toBe(2_000_000);
  });

  test("estimates tempo and exposes a tempo change between windows", () => {
    const durationUs = 8_000_000;
    const beatTimes = [
      ...beats(200_000, 4_000_000, 500_000),
      ...beats(4_000_000, durationUs, 666_667),
    ];
    const features = pulseFeatures(durationUs, beatTimes);
    const first = estimateTempo(features, { startUs: 0, endUs: 4_000_000 });
    const regions = detectTempoRegions(
      features,
      [{ confidence: 1, range: { startUs: 0, endUs: durationUs } }],
      durationUs,
      4_000_000,
    );

    expect(first?.bpm).toBeCloseTo(120, 1);
    expect(first?.confidence).toBeGreaterThan(0.9);
    expect(regions).toHaveLength(2);
    expect(regions[0]?.changeFromPrevious).toBeNull();
    expect(regions[1]?.bpm).toBeWithin(88, 93);
    expect(regions[1]?.changeFromPrevious?.deltaBpm).toBeLessThan(-25);
    expect(regions[1]?.changeFromPrevious?.confidence).toBeGreaterThan(0.8);
  });

  test("classifies chroma into major and minor keys", () => {
    const cMajor = classifyChroma([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]);
    const aMinor = classifyChroma([6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
      .map((_, pitchClass, profile) => profile[(pitchClass - 9 + 12) % 12] ?? 0));

    expect(cMajor.key).toEqual({ kind: "key", mode: "major", pitchClass: 0 });
    expect(cMajor.confidence).toBeGreaterThan(0.8);
    expect(aMinor.key).toEqual({ kind: "key", mode: "minor", pitchClass: 9 });
  });

  test("produces a schema-valid analysis with bounded presence and key regions", () => {
    const sampleRateHz = 8_000;
    const samples = Array.from({ length: sampleRateHz * 3 }, (_, index) => {
      if (index < sampleRateHz / 2) return 0;
      return 0.18 * Math.sin(2 * Math.PI * 261.625_565 * index / sampleRateHz)
        + 0.14 * Math.sin(2 * Math.PI * 329.627_557 * index / sampleRateHz)
        + 0.12 * Math.sin(2 * Math.PI * 391.995_436 * index / sampleRateHz);
    });
    const analysis = analyzeMusic(analysisInput(samples));

    expect(analysis.durationUs).toBe(3_000_000);
    expect(analysis.musicRegions).toHaveLength(1);
    expect(analysis.keyRegions[0]?.key).toEqual({ kind: "key", mode: "major", pitchClass: 0 });
    expect(analysis.keyRegions.every(region => region.range.endUs <= analysis.durationUs)).toBe(true);
  });

  test("returns unknown for an empty chromagram", () => {
    expect(classifyChroma(Array.from({ length: 12 }, () => 0))).toEqual({
      alternate: null,
      confidence: 0,
      key: { kind: "unknown" },
    });
    expect(computeChroma([], 48_000)).toEqual(Array.from({ length: 12 }, () => 0));
  });
});
