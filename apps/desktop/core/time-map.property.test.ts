import { describe, expect } from "bun:test";
import { assertProperty, fc } from "../testing/property";

import { normalizeEditPlan } from "./plan";
import { testPlan } from "./test-support";
import { buildSourceTimeMap, outputToSourceUs, sourceToOutputUs } from "./time-map";

describe("source/output time mapping", () => {
  assertProperty(fc.property(
    fc.integer({ min: 2, max: 10_000_000 }),
    fc.double({ min: 0.25, max: 16, noNaN: true }),
    fc.integer({ min: 0, max: 10_000_000 }),
    (durationUs, rate, sampleSeed) => {
      const base = testPlan();
      const plan = normalizeEditPlan({
        ...base,
        baseSpeed: rate,
        keep: [{ startUs: 0, endUs: durationUs }],
        sourceDurationUs: durationUs,
        speed: [],
      });
      const map = buildSourceTimeMap(plan);
      const sourceTimeUs = Math.min(durationUs, sampleSeed % (durationUs + 1));
      const outputTimeUs = sourceToOutputUs(map, sourceTimeUs);
      expect(outputTimeUs).not.toBeNull();
      const roundTrip = outputToSourceUs(map, outputTimeUs ?? 0);
      expect(roundTrip).not.toBeNull();
      expect(Math.abs((roundTrip ?? 0) - sourceTimeUs)).toBeLessThanOrEqual(Math.ceil(rate) + 1);
    },
  ));

  assertProperty(fc.property(fc.array(fc.integer({ min: 0, max: 10_000_000 }), { minLength: 2, maxLength: 50 }), (samples) => {
    const map = buildSourceTimeMap(testPlan());
    const ordered = [...samples].sort((left, right) => left - right);
    const mapped = ordered.map((sample) => sourceToOutputUs(map, sample) ?? -1);
    for (let index = 1; index < mapped.length; index += 1) {
      expect(mapped[index]).toBeGreaterThanOrEqual(mapped[index - 1] ?? -1);
    }
  }));
});
