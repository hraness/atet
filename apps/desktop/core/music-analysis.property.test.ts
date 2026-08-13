import { describe, expect } from "bun:test";
import { assertProperty, fc } from "../testing/property";

import {
  classifyChroma,
  detectMusicPresenceRegions,
  extractPcmFrameFeatures,
} from "./music-analysis";

const C_MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88] as const;

describe("music-analysis properties", () => {
  assertProperty(fc.property(fc.integer({ min: 0, max: 11 }), (transposition) => {
    const chroma = C_MAJOR_PROFILE.map((_, pitchClass) =>
      C_MAJOR_PROFILE[(pitchClass - transposition + 12) % 12] ?? 0);
    const classification = classifyChroma(chroma);
    expect(classification.key).toEqual({ kind: "key", mode: "major", pitchClass: transposition });
  }));

  assertProperty(fc.property(
    fc.array(fc.double({ min: -1, max: 1, noNaN: true }), { maxLength: 256 }),
    fc.integer({ min: 8, max: 64 }),
    fc.integer({ min: 1, max: 32 }),
    (samples, windowSize, hopSize) => {
      const features = extractPcmFrameFeatures(
        { sampleRateHz: 8_000, samples },
        { hopSize, windowSize },
      );
      for (let index = 0; index < features.length; index += 1) {
        const frame = features[index]!;
        expect(frame.chroma).toHaveLength(12);
        expect(frame.startUs).toBeLessThan(frame.endUs);
        expect(frame.rms).toBeGreaterThanOrEqual(0);
        if (index > 0) expect(frame.startUs).toBeGreaterThan(features[index - 1]!.startUs);
      }
      const regions = detectMusicPresenceRegions(features, 0);
      for (let index = 1; index < regions.length; index += 1) {
        expect(regions[index]!.range.startUs).toBeGreaterThanOrEqual(regions[index - 1]!.range.endUs);
      }
    },
  ));
});
