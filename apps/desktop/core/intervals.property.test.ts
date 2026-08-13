import { describe, expect } from "bun:test";
import { assertProperty, fc } from "../testing/property";

import type { SourceInterval } from "../contracts/edit";
import { intersectIntervals, subtractIntervals, unionIntervals } from "./intervals";

const intervalArbitrary = fc.tuple(
  fc.integer({ min: 0, max: 1_000_000 }),
  fc.integer({ min: 1, max: 100_000 }),
).map(([startUs, durationUs]): SourceInterval => ({ startUs, endUs: startUs + durationUs }));

describe("interval algebra", () => {
  assertProperty(fc.property(fc.array(intervalArbitrary), (intervals) => {
    const once = unionIntervals(intervals);
    expect(unionIntervals(once)).toEqual(once);
    for (let index = 1; index < once.length; index += 1) {
      expect(once[index]?.startUs).toBeGreaterThan(once[index - 1]?.endUs ?? -1);
    }
  }));

  assertProperty(fc.property(fc.array(intervalArbitrary), fc.array(intervalArbitrary), (left, right) => {
    expect(intersectIntervals(left, right)).toEqual(intersectIntervals(right, left));
  }));

  assertProperty(fc.property(fc.array(intervalArbitrary), fc.array(intervalArbitrary), (source, removed) => {
    expect(intersectIntervals(subtractIntervals(source, removed), removed)).toEqual([]);
  }));
});
