import { describe, expect } from "bun:test";
import { assertProperty, fc } from "../testing/property";

import { envelopeCorrelationAtLag } from "./audio-alignment";

describe("audio-alignment properties", () => {
  assertProperty(fc.property(
    fc.array(fc.double({ min: -1_000, max: 1_000, noNaN: true }), { minLength: 2, maxLength: 128 }),
    fc.array(fc.double({ min: -1_000, max: 1_000, noNaN: true }), { minLength: 2, maxLength: 128 }),
    fc.integer({ min: -64, max: 64 }),
    (reference, target, lag) => {
      const forward = envelopeCorrelationAtLag(reference, target, lag);
      const reverse = envelopeCorrelationAtLag(target, reference, -lag);
      expect(forward.score).toBeGreaterThanOrEqual(-1);
      expect(forward.score).toBeLessThanOrEqual(1);
      expect(forward.overlapSamples).toBe(reverse.overlapSamples);
      expect(forward.score).toBeCloseTo(reverse.score, 10);
    },
  ));

  assertProperty(fc.property(
    fc.array(fc.double({ min: -1_000, max: 1_000, noNaN: true }), { minLength: 2, maxLength: 128 }),
    fc.double({ min: -1_000, max: 1_000, noNaN: true }),
    (values, translation) => {
      const translated = values.map(value => value + translation);
      expect(envelopeCorrelationAtLag(values, translated, 0).score).toBeCloseTo(
        envelopeCorrelationAtLag(values, values, 0).score,
        9,
      );
    },
  ));
});
