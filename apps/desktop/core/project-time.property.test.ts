import { expect } from "bun:test";
import { assertProperty, fc } from "../testing/property";

import {
  ProjectEditPlanV1Schema,
  ProjectPlacementV1Schema,
  ProjectSyncMapSchema,
  type ProjectPlacementV1,
} from "../contracts/project";
import {
  assetToProjectUs,
  buildProjectOutputTimeMap,
  interpolateMicroseconds,
  mapPlacementToOutputSlices,
  mapProjectIntervalToAssetSlices,
  projectIntervalHasCompleteSyncCoverage,
  projectToAssetUs,
} from "./project-time";

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function halfUpRatio(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return quotient + (remainder * 2n >= denominator ? 1n : 0n);
}

function placement(
  placementId: "placement_property_ref" | "placement_property_target",
  assetStartUs: number,
  assetEndUs: number,
  projectEndUs: number,
): ProjectPlacementV1 {
  return ProjectPlacementV1Schema.parse({
    assetId: placementId === "placement_property_ref" ? "asset_property_ref" : "asset_property_target",
    assetRange: { endUs: assetEndUs, startUs: assetStartUs },
    audio: [],
    enabled: true,
    placementId,
    sync: {
      anchors: [
        { assetTimeUs: assetStartUs, projectTimeUs: 0 },
        { assetTimeUs: assetEndUs, projectTimeUs: projectEndUs },
      ],
      provenance: { kind: "manual" },
    },
    video: [],
  });
}

assertProperty(fc.property(
  fc.integer({ min: 1, max: MAX_SAFE }),
  fc.integer({ min: 1, max: MAX_SAFE }),
  fc.integer({ min: 0, max: MAX_SAFE }),
  (inputDurationUs, outputDurationUs, seed) => {
    const value = seed % inputDurationUs;
    const expected = Number(halfUpRatio(
      BigInt(value) * BigInt(outputDurationUs),
      BigInt(inputDurationUs),
    ));
    expect(interpolateMicroseconds(value, 0, inputDurationUs, 0, outputDurationUs)).toBe(expected);
  },
));

assertProperty(fc.property(
  fc.array(fc.tuple(
    fc.integer({ min: 1, max: 10_000 }),
    fc.integer({ min: 1, max: 10_000 }),
  ), { minLength: 1, maxLength: 32 }),
  fc.integer({ min: 0, max: 1_000_000 }),
  fc.integer({ min: 1, max: 1_000_000 }),
  (deltas, startSeed, lengthSeed) => {
    let assetTimeUs = 0;
    let projectTimeUs = 0;
    const anchors = [{
      assetTimeUs,
      projectTimeUs,
    }];
    for (const [assetDeltaUs, projectDeltaUs] of deltas) {
      assetTimeUs += assetDeltaUs;
      projectTimeUs += projectDeltaUs;
      anchors.push({ assetTimeUs, projectTimeUs });
    }
    const item = ProjectPlacementV1Schema.parse({
      assetId: "asset_property_target",
      assetRange: { endUs: assetTimeUs, startUs: 0 },
      audio: [],
      enabled: true,
      placementId: "placement_property_target",
      sync: {
        anchors,
        provenance: { kind: "manual" },
      },
      video: [],
    });
    const startUs = startSeed % (projectTimeUs + 2);
    const range = {
      endUs: startUs + 1 + (lengthSeed % (projectTimeUs + 2)),
      startUs,
    };
    const mappedProjectUs = mapProjectIntervalToAssetSlices(
      item,
      range,
    ).reduce(
      (total, slice) => (
        total + slice.project.endUs - slice.project.startUs
      ),
      0,
    );
    expect(projectIntervalHasCompleteSyncCoverage(item.sync, range)).toBe(
      mappedProjectUs === range.endUs - range.startUs,
    );
  },
));

assertProperty(fc.property(
  fc.integer({ min: 1_000, max: 20_000_000 }),
  fc.integer({ min: 1_000, max: 20_000_000 }),
  fc.array(fc.integer({ min: 0, max: 20_000_000 }), { minLength: 2, maxLength: 50 }),
  (assetDurationUs, projectDurationUs, seeds) => {
    const sync = ProjectSyncMapSchema.parse({
      anchors: [
        { assetTimeUs: 0, projectTimeUs: 0 },
        { assetTimeUs: assetDurationUs, projectTimeUs: projectDurationUs },
      ],
      provenance: { kind: "identity" },
    });
    const assetTimes = seeds
      .map(seed => seed % (assetDurationUs + 1))
      .sort((left, right) => left - right);
    const projectTimes = assetTimes.map(timeUs => assetToProjectUs(sync, timeUs));
    for (let index = 1; index < projectTimes.length; index += 1) {
      expect(projectTimes[index]).toBeGreaterThanOrEqual(projectTimes[index - 1] ?? -1);
    }
    const roundTrips = projectTimes.map(timeUs => projectToAssetUs(sync, timeUs ?? -1));
    for (let index = 0; index < roundTrips.length; index += 1) {
      const original = assetTimes[index] ?? 0;
      const roundTrip = roundTrips[index];
      expect(roundTrip).not.toBeNull();
      expect(Math.abs((roundTrip ?? 0) - original))
        .toBeLessThanOrEqual(Math.ceil(assetDurationUs / projectDurationUs) + 1);
      if (index > 0) expect(roundTrip).toBeGreaterThanOrEqual(roundTrips[index - 1] ?? -1);
    }
    expect(assetToProjectUs(sync, 0)).toBe(0);
    expect(assetToProjectUs(sync, assetDurationUs)).toBe(projectDurationUs);
    expect(projectToAssetUs(sync, projectDurationUs)).toBe(assetDurationUs);
  },
));

assertProperty(fc.property(
  fc.integer({ min: 1_000_000, max: 20_000_000 }),
  fc.integer({ min: -50_000, max: 50_000 }),
  fc.integer({ min: 0, max: 20_000_000 }),
  fc.integer({ min: 1, max: 5_000_000 }),
  (projectDurationUs, driftUs, startSeed, lengthSeed) => {
    const assetDurationUs = projectDurationUs + driftUs;
    fc.pre(assetDurationUs > 0);
    const startUs = startSeed % Math.max(1, projectDurationUs - 1);
    const lengthUs = 1 + lengthSeed % (projectDurationUs - startUs);
    const endUs = startUs + lengthUs;
    const item = placement("placement_property_target", 0, assetDurationUs, projectDurationUs);
    const slices = mapProjectIntervalToAssetSlices(item, { endUs, startUs });
    fc.pre(slices.length > 0);
    expect(slices[0]?.project.startUs).toBe(startUs);
    expect(slices.at(-1)?.project.endUs).toBe(endUs);
    for (let index = 1; index < slices.length; index += 1) {
      expect(slices[index]?.project.startUs).toBe(slices[index - 1]?.project.endUs);
      expect(slices[index]?.asset.startUs).toBe(slices[index - 1]?.asset.endUs);
    }
  },
));

assertProperty(fc.property(
  fc.integer({ min: 100, max: 2_000_000 }),
  fc.integer({ min: 100, max: 2_000_000 }),
  fc.integer({ min: 100, max: 2_000_000 }),
  fc.integer({ min: -100, max: 100 }),
  (prefixUs, cutUs, suffixUs, driftUs) => {
    const projectDurationUs = prefixUs + cutUs + suffixUs;
    const targetDurationUs = projectDurationUs + driftUs;
    fc.pre(targetDurationUs > 0);
    const keep = [
      { endUs: prefixUs, startUs: 0 },
      { endUs: projectDurationUs, startUs: prefixUs + cutUs },
    ];
    const plan = ProjectEditPlanV1Schema.parse({
      baseSpeed: 1,
      cameraMoves: [],
      createdAt: "2026-07-22T12:00:00.000Z",
      derivations: [],
      effects: {
        clicks: { enabled: false },
        cursor: { enabled: false },
        keystrokes: { enabled: false },
        metadataPlacementId: null,
        typedText: { enabled: false },
      },
      keep,
      kind: "studio.project-edit-plan",
      overlays: [],
      planId: "plan_property001",
      projectId: "project_property001",
      projectStructureSha256: "0".repeat(64),
      schemaVersion: 1,
      speed: [{ range: keep[1]!, rate: 2 }],
      timelineDurationUs: projectDurationUs,
      updatedAt: "2026-07-22T12:00:00.000Z",
      zooms: [],
    });
    const map = buildProjectOutputTimeMap(plan);
    const reference = placement("placement_property_ref", 0, projectDurationUs, projectDurationUs);
    const target = placement("placement_property_target", 0, targetDurationUs, projectDurationUs);
    const referenceSlices = mapPlacementToOutputSlices(reference, map);
    const targetSlices = mapPlacementToOutputSlices(target, map);
    const sharedClock = (slice: (typeof referenceSlices)[number]) => ({
      output: slice.output,
      project: slice.project,
      speed: slice.speed,
    });
    expect(referenceSlices.map(sharedClock)).toEqual(targetSlices.map(sharedClock));
    expect(referenceSlices.some(slice => (
      slice.project.startUs < prefixUs + cutUs && slice.project.endUs > prefixUs
    ))).toBe(false);
  },
));
