import { expect, test } from "bun:test";
import { assertProperty, fc } from "../testing/property";

import {
  ProjectEditPlanV1Schema,
  SpeedRangeSchema,
  type ProjectEditPlanV1,
  type SourceInterval,
} from "../contracts";
import { intersectIntervals, subtractIntervals, unionIntervals } from "./intervals";
import { normalizeProjectEditPlan } from "./project-plan";

const PLAN_HASH = "a".repeat(64);

function basePlan(): ProjectEditPlanV1 {
  return ProjectEditPlanV1Schema.parse({
    baseSpeed: 1,
    cameraMoves: [],
    createdAt: "2026-07-24T12:00:00.000Z",
    derivations: [],
    effects: {
      clicks: { enabled: false },
      cursor: { enabled: false },
      keystrokes: { enabled: false },
      metadataPlacementId: null,
      typedText: { enabled: false },
    },
    keep: [{ endUs: 1_000, startUs: 0 }],
    kind: "studio.project-edit-plan",
    overlays: [],
    planId: "plan_speedproperty01",
    projectId: "project_speedproperty01",
    projectStructureSha256: PLAN_HASH,
    schemaVersion: 1,
    speed: [],
    timelineDurationUs: 1_000,
    updatedAt: "2026-07-24T12:00:00.000Z",
    zooms: [],
  });
}

function referenceSpeedNormalization(
  ranges: ProjectEditPlanV1["speed"],
  keep: readonly SourceInterval[],
  baseSpeed: number,
): ProjectEditPlanV1["speed"] {
  let overlaid: ProjectEditPlanV1["speed"] = [];
  for (const candidate of ranges) {
    const speed = SpeedRangeSchema.parse(candidate);
    overlaid = [
      ...overlaid.flatMap(existing => (
        subtractIntervals([existing.range], [speed.range])
          .map(range => ({ range, rate: existing.rate }))
      )),
      speed,
    ];
  }
  const clipped = overlaid
    .flatMap(speed => (
      intersectIntervals([speed.range], keep)
        .map(range => ({ range, rate: speed.rate }))
    ))
    .filter(speed => speed.rate !== baseSpeed)
    .sort((left, right) => (
      left.range.startUs - right.range.startUs
      || left.range.endUs - right.range.endUs
    ));
  const merged: { range: SourceInterval; rate: number }[] = [];
  for (const speed of clipped) {
    const prior = merged.at(-1);
    if (
      prior !== undefined
      && prior.rate === speed.rate
      && prior.range.endUs === speed.range.startUs
    ) {
      merged[merged.length - 1] = {
        range: {
          endUs: speed.range.endUs,
          startUs: prior.range.startUs,
        },
        rate: speed.rate,
      };
    } else {
      merged.push(speed);
    }
  }
  return merged;
}

const intervalArbitrary = fc
  .tuple(
    fc.integer({ min: 0, max: 999 }),
    fc.integer({ min: 1, max: 1_000 }),
  )
  .map(([startUs, lengthUs]) => ({
    endUs: Math.min(1_000, startUs + lengthUs),
    startUs,
  }));

assertProperty(fc.property(
  fc.array(intervalArbitrary, { maxLength: 30 }),
  fc.array(fc.record({
    range: intervalArbitrary,
    rate: fc.integer({ min: 1, max: 8 }),
  }), { maxLength: 30 }),
  (keepInput, speed) => {
    const keep = unionIntervals(keepInput);
    const normalized = normalizeProjectEditPlan({
      ...basePlan(),
      keep,
      speed,
    });
    expect(normalized.speed).toEqual(
      referenceSpeedNormalization(speed, keep, 1),
    );
    expect(normalizeProjectEditPlan(normalized)).toEqual(normalized);
  },
));

test("normalizes the maximum dense disjoint speed plan inside the operation budget", () => {
  const speed = Array.from({ length: 10_000 }, (_, index) => ({
    range: { endUs: index + 1, startUs: index },
    rate: index % 2 === 0 ? 2 : 3,
  }));
  const normalized = normalizeProjectEditPlan({
    ...basePlan(),
    keep: [{ endUs: 10_000, startUs: 0 }],
    speed,
    timelineDurationUs: 10_000,
  });
  expect(normalized.speed).toHaveLength(10_000);
}, 5_000);
