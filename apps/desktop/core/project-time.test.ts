import { describe, expect, test } from "bun:test";

import {
  ProjectEditPlanV1Schema,
  ProjectPlacementV1Schema,
  type ProjectPlacementV1,
} from "../contracts/project";
import {
  assetToProjectUs,
  buildProjectOutputTimeMap,
  interpolateMicroseconds,
  mapAssetIntervalToProjectSlices,
  mapPlacementToOutputSlices,
  mapProjectIntervalToAssetSlices,
  outputToProjectUs,
  projectIntervalHasCompleteSyncCoverage,
  projectToAssetUs,
  projectToOutputUs,
} from "./project-time";

function placement(
  placementId: string,
  assetStartUs: number,
  assetEndUs: number,
  projectStartUs: number,
  projectEndUs: number,
  middle?: { readonly assetTimeUs: number; readonly projectTimeUs: number },
): ProjectPlacementV1 {
  return ProjectPlacementV1Schema.parse({
    assetId: `asset_${placementId.slice("placement_".length)}`,
    assetRange: { endUs: assetEndUs, startUs: assetStartUs },
    audio: [],
    enabled: true,
    placementId,
    sync: {
      anchors: [
        { assetTimeUs: assetStartUs, projectTimeUs: projectStartUs },
        ...(middle === undefined ? [] : [middle]),
        { assetTimeUs: assetEndUs, projectTimeUs: projectEndUs },
      ],
      provenance: { kind: "identity" },
    },
    video: [],
  });
}

function projectPlan() {
  return ProjectEditPlanV1Schema.parse({
    baseSpeed: 1,
    cameraMoves: [],
    createdAt: "2026-07-22T12:00:00.000Z",
    effects: {
      clicks: { enabled: false },
      cursor: { enabled: false },
      keystrokes: { enabled: false },
      metadataPlacementId: null,
      typedText: { enabled: false },
    },
    derivations: [],
    keep: [
      { endUs: 3_000_000, startUs: 0 },
      { endUs: 10_000_000, startUs: 5_000_000 },
    ],
    kind: "studio.project-edit-plan",
    overlays: [],
    planId: "plan_project001",
    projectId: "project_example001",
    projectStructureSha256: "0".repeat(64),
    schemaVersion: 1,
    speed: [{ range: { endUs: 7_000_000, startUs: 5_000_000 }, rate: 2 }],
    timelineDurationUs: 10_000_000,
    updatedAt: "2026-07-22T12:00:00.000Z",
    zooms: [],
  });
}

describe("integer project-clock interpolation", () => {
  test("uses BigInt intermediates at the safe-integer boundary", () => {
    expect(interpolateMicroseconds(
      6_741_340_037_608_303,
      715_127_093_197_038,
      8_069_291_904_140_261,
      741_535_967_110_056,
      8_899_627_976_476_437,
    )).toBe(7_426_509_846_861_382);
  });

  test("maps every persisted sync anchor exactly in both directions", () => {
    const item = placement(
      "placement_camera01",
      1_000_000,
      11_100_000,
      0,
      10_000_000,
      { assetTimeUs: 6_060_000, projectTimeUs: 5_000_000 },
    );
    for (const anchor of item.sync.anchors) {
      expect(assetToProjectUs(item.sync, anchor.assetTimeUs)).toBe(anchor.projectTimeUs);
      expect(projectToAssetUs(item.sync, anchor.projectTimeUs)).toBe(anchor.assetTimeUs);
    }
    expect(assetToProjectUs(item.sync, item.assetRange.startUs - 1)).toBeNull();
    expect(projectToAssetUs(item.sync, 10_000_001)).toBeNull();
  });
});

test("maps intervals across alignment-anchor boundaries without losing clock provenance", () => {
  const item = placement(
    "placement_camera02",
    1_000_000,
    11_100_000,
    0,
    10_000_000,
    { assetTimeUs: 6_060_000, projectTimeUs: 5_000_000 },
  );
  const slices = mapProjectIntervalToAssetSlices(item, { startUs: 4_000_000, endUs: 6_000_000 });
  expect(slices).toEqual([
    {
      asset: { startUs: 5_048_000, endUs: 6_060_000 },
      placementId: item.placementId,
      project: { startUs: 4_000_000, endUs: 5_000_000 },
    },
    {
      asset: { startUs: 6_060_000, endUs: 7_068_000 },
      placementId: item.placementId,
      project: { startUs: 5_000_000, endUs: 6_000_000 },
    },
  ]);
  expect(mapAssetIntervalToProjectSlices(item, { startUs: 5_048_000, endUs: 7_068_000 }))
    .toEqual(slices);
});

test("checks complete sync coverage with the same integer edge semantics as slice mapping", () => {
  const item = placement(
    "placement_sparseclock01",
    0,
    2,
    0,
    10,
    { assetTimeUs: 1, projectTimeUs: 5 },
  );
  for (const range of [
    { endUs: 10, startUs: 0 },
    { endUs: 5, startUs: 0 },
    { endUs: 2, startUs: 1 },
    { endUs: 9, startUs: 1 },
    { endUs: 11, startUs: 1 },
  ]) {
    const mappedUs = mapProjectIntervalToAssetSlices(item, range).reduce(
      (total, slice) => (
        total + slice.project.endUs - slice.project.startUs
      ),
      0,
    );
    expect(projectIntervalHasCompleteSyncCoverage(item.sync, range)).toBe(
      mappedUs === range.endUs - range.startUs,
    );
  }
});

test("composes alignment with one global cut and speed map for every placement", () => {
  const reference = placement("placement_reference01", 0, 10_000_000, 0, 10_000_000);
  const camera = placement("placement_camera03", 1_000_000, 11_100_000, 0, 10_000_000);
  const map = buildProjectOutputTimeMap(projectPlan());

  expect(map.durationUs).toBe(7_000_000);
  expect(projectToOutputUs(map, 4_000_000)).toBeNull();
  expect(projectToOutputUs(map, 5_000_000)).toBe(3_000_000);
  expect(projectToOutputUs(map, 6_000_000)).toBe(3_500_000);
  expect(outputToProjectUs(map, 3_500_000)).toBe(6_000_000);

  const referenceSlices = mapPlacementToOutputSlices(reference, map);
  const cameraSlices = mapPlacementToOutputSlices(camera, map);
  expect(referenceSlices.map(({ project, output, speed }) => ({ output, project, speed })))
    .toEqual(cameraSlices.map(({ project, output, speed }) => ({ output, project, speed })));
  expect(referenceSlices.map(({ project }) => project)).toEqual([
    { startUs: 0, endUs: 3_000_000 },
    { startUs: 5_000_000, endUs: 7_000_000 },
    { startUs: 7_000_000, endUs: 10_000_000 },
  ]);
  expect(cameraSlices.map(({ asset }) => asset)).toEqual([
    { startUs: 1_000_000, endUs: 4_030_000 },
    { startUs: 6_050_000, endUs: 8_070_000 },
    { startUs: 8_070_000, endUs: 11_100_000 },
  ]);
});
