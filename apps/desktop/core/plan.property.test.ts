import { describe, expect } from "bun:test";
import { assertProperty, fc } from "../testing/property";

import { EditPlanV1Schema } from "../contracts/edit";
import { hashEditPlan, normalizeEditPlan } from "./plan";
import { testPlan } from "./test-support";

const intervalArbitrary = fc.tuple(
  fc.integer({ min: 0, max: 9_999_999 }),
  fc.integer({ min: 1, max: 2_000_000 }),
).map(([startUs, durationUs]) => ({ startUs, endUs: Math.min(10_000_000, startUs + durationUs) }));

describe("edit-plan normalization", () => {
  assertProperty(fc.property(fc.array(intervalArbitrary, { maxLength: 30 }), (keep) => {
    const plan = normalizeEditPlan({ ...testPlan(), keep });
    expect(EditPlanV1Schema.safeParse(plan).success).toBe(true);
    for (let index = 1; index < plan.keep.length; index += 1) {
      expect(plan.keep[index]?.startUs).toBeGreaterThan(plan.keep[index - 1]?.endUs ?? -1);
    }
    expect(normalizeEditPlan(plan)).toEqual(plan);
  }));

  assertProperty(fc.property(fc.array(intervalArbitrary, { maxLength: 30 }), (keep) => {
    const base = testPlan();
    expect(hashEditPlan({ ...base, keep })).toBe(hashEditPlan({ ...base, keep: [...keep].reverse() }));
  }));
});
