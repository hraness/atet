import { expect, test } from "bun:test";

import { parseSpatialScene, spatialFrameCount, spatialSceneSha256 } from "../../../src/spatial-scene/index";
import { SpatialShotV1Schema } from "../../../src/spatial-scene/contracts";
import { SpatialProjectHeadV2Schema, SpatialProjectRevisionV2Schema } from "../contracts/spatial-project";
import { sha256Hex } from "../core/canonical-json";
import { compileProjectRenderPlan } from "../core/project-render-plan";
import { spatialProjectArtifact, spatialProjectContents, spatialProjectDocumentText, spatialProjectRevisionSha256, spatialShotSha256 } from "../core/spatial-project";
import { createProjectEditRevisionDocument } from "./receipts";
import { editedPlan, syncedProject } from "./spatial-project-fixture.testing";
import { SceneRenderProjectionV1Schema, createSpatialRenderProjection, spatialProjectionEncoderFrameRate, type SpatialMaterializedShotVideo, type SpatialProjectionOutput } from "./spatial-render-projection";
import type { SpatialProjectSnapshot } from "./spatial-project-store";

const output: SpatialProjectionOutput = { pixelWidth: 640, pixelHeight: 480, frameRate: { numerator: 30_000, denominator: 1_001 }, background: "#000000ff", colorSpace: "srgb" };
const policy = { kind: "full-frame-above-legacy-video-below-overlays" as const, alpha: "straight" as const };
const document = parseSpatialScene({
  kind: "atet.spatial-scene", schemaVersion: 1, sceneId: "scene_projection", coordinates: "right-handed-y-up-meters", durationUs: 10_000_000,
  entities: [], assets: [], animations: [], overrides: [], generators: [],
  cameras: [{ cameraId: "camera_main", name: "Main", pose: { position: [0, 0, 5], rotation: [0, 0, 0, 1] }, projection: { kind: "perspective", width: 640, height: 480, near: 0.1, far: 100, fx: 500, fy: 500, cx: 320, cy: 240 } }],
});
function fixture(ranges = [{ startUs: 0, endUs: 7_000_000 }]) {
  const project = syncedProject();
  const projectEditPlan = editedPlan(project);
  const source = { document, sceneSha256: spatialSceneSha256(document) };
  const shots = ranges.map((range, index) => SpatialShotV1Schema.parse({ shotId: `shot_${index}`, sceneSha256: source.sceneSha256, cameraId: "camera_main", range, sceneStartUs: 0, playback: "once", overrides: [] }));
  const revision = SpatialProjectRevisionV2Schema.parse({
    kind: "atet.spatial-project-revision", schemaVersion: 2, projectId: project.projectId, parent: { version: 1, sha256: "a".repeat(64) }, transactionId: `transaction_${"0".repeat(32)}`,
    legacy: { project, projectEditPlan }, scenes: [{ sceneSha256: source.sceneSha256, artifact: spatialProjectArtifact("scenes", spatialProjectDocumentText(source.document)) }], shots, candidates: [], selections: [],
  });
  const head = SpatialProjectHeadV2Schema.parse({ kind: "atet.spatial-project-head", schemaVersion: 2, projectId: project.projectId, projectRevisionSha256: spatialProjectRevisionSha256(revision), revision: spatialProjectArtifact("revisions", spatialProjectDocumentText(revision)), transactionId: revision.transactionId });
  const snapshot: SpatialProjectSnapshot = { version: 2, head, revision, headText: spatialProjectDocumentText(head), basis: { version: 2, sha256: head.projectRevisionSha256 }, contents: spatialProjectContents(revision, [source]) };
  const materializedShots: SpatialMaterializedShotVideo[] = shots.map(shot => {
    const sha256 = sha256Hex(shot.shotId);
    return {
      shotId: shot.shotId, shotSha256: spatialShotSha256(shot), sceneSha256: shot.sceneSha256, receiptSha256: "b".repeat(64),
      artifact: { path: `spatial/outputs/${sha256}.mov`, sha256, bytes: 1_024 },
      pixelWidth: output.pixelWidth, pixelHeight: output.pixelHeight, frameRate: output.frameRate,
      frameCount: spatialFrameCount(shot.range.endUs - shot.range.startUs, output.frameRate),
      alpha: "straight", colorSpace: "srgb", codec: "qtrle", container: "mov", streamIndex: 0,
    };
  });
  return { snapshot, materializedShots, output, policy };
}

test("projection retains mixed audio, sync, cuts and speed and retimes source shot exactly once", () => {
  const input = fixture();
  const before = spatialProjectDocumentText(input.snapshot);
  const original = input.snapshot.contents.legacy;
  const baseline = compileProjectRenderPlan(original.project, original.projectEditPlan, { frameRate: output.frameRate.numerator / output.frameRate.denominator, pixelWidth: output.pixelWidth, pixelHeight: output.pixelHeight, background: output.background });
  const result = createSpatialRenderProjection(input);
  expect(spatialProjectDocumentText(input.snapshot)).toBe(before);
  expect(result.renderPlan.audioSlices).toEqual(baseline.audioSlices);
  expect(spatialProjectDocumentText(result.renderPlan.videoSlices.filter(slice => !slice.assetId.startsWith("asset_spatial_")))).toBe(spatialProjectDocumentText(baseline.videoSlices));
  expect(result.renderPlan.overlays).toEqual(baseline.overlays);
  expect(spatialProjectDocumentText(result.revision.projectEditPlan.keep)).toBe(spatialProjectDocumentText(original.projectEditPlan.keep));
  expect(spatialProjectDocumentText(result.revision.projectEditPlan.speed)).toBe(spatialProjectDocumentText(original.projectEditPlan.speed));
  expect(result.revision.projectEditPlan.baseSpeed).toBe(original.projectEditPlan.baseSpeed);
  expect(result.renderPlan.output.durationUs).toBe(7_000_000);
  expect(result.renderPlan.output.durationUs).toBe(baseline.output.durationUs);
  const scenes = result.renderPlan.videoSlices.filter(slice => slice.assetId.startsWith("asset_spatial_"));
  expect(scenes.map(slice => ({ source: slice.fileRange, project: slice.projectRange, output: slice.outputRange, speed: slice.projectSpeed }))).toEqual([
    { source: { startUs: 0, endUs: 2_000_000 }, project: { startUs: 0, endUs: 2_000_000 }, output: { startUs: 0, endUs: 2_000_000 }, speed: 1 },
    { source: { startUs: 4_000_000, endUs: 6_000_000 }, project: { startUs: 4_000_000, endUs: 6_000_000 }, output: { startUs: 2_000_000, endUs: 3_000_000 }, speed: 2 },
    { source: { startUs: 6_000_000, endUs: 7_000_000 }, project: { startUs: 6_000_000, endUs: 7_000_000 }, output: { startUs: 3_000_000, endUs: 4_000_000 }, speed: 1 },
  ]);
  expect(scenes.every(slice => slice.presentation.enabled && slice.presentation.layer === 2)).toBe(true);
  expect(result.revision.project.placements.filter(placement => placement.placementId.startsWith("placement_spatial_")).every(placement => placement.audio.length === 0)).toBe(true);
});

test("outer V2 binding and exact rational encoder contract never replace the V1 revision hash meaning", () => {
  const input = fixture();
  const result = createSpatialRenderProjection(input);
  expect(result.projection.source.projectRevisionSha256).toBe(input.snapshot.basis.sha256);
  expect(result.projection.derivedV1RevisionSha256).toBe(result.revision.revisionSha256);
  expect(result.projection.derivedV1RevisionSha256).not.toBe(input.snapshot.basis.sha256);
  expect(result.revision).toEqual(createProjectEditRevisionDocument(result.revision.project, result.revision.projectEditPlan));
  expect(result.projection.output.frameRate).toEqual({ numerator: 30_000, denominator: 1_001 });
  expect(result.projection.legacyFrameRateAdapter).toEqual({ kind: "numeric-ratio-for-planning-only", value: 30_000 / 1_001, requiredEncoderArgument: "30000/1001" });
  expect(spatialProjectionEncoderFrameRate({ numerator: 60_000, denominator: 2_002 })).toBe("30000/1001");
  expect(result.projection.compositionPlanSha256).toBe(result.renderPlan.planSha256);
  expect(sha256Hex(spatialProjectDocumentText(result.revision))).toBe(result.projection.derivedV1Revision.sha256);
  expect(createSpatialRenderProjection(input).projectionSha256).toBe(result.projectionSha256);
});

test("policy is explicit; overlapping full-frame shots reject and gaps retain original media", () => {
  expect(() => createSpatialRenderProjection(fixture([{ startUs: 0, endUs: 5_000_000 }, { startUs: 4_000_000, endUs: 8_000_000 }]))).toThrow("overlapping");
  const input = fixture([{ startUs: 0, endUs: 1_000_000 }, { startUs: 7_000_000, endUs: 9_000_000 }]);
  const result = createSpatialRenderProjection(input);
  const scenes = result.renderPlan.videoSlices.filter(slice => slice.assetId.startsWith("asset_spatial_"));
  expect(scenes.some(slice => slice.projectRange.startUs < 7_000_000 && slice.projectRange.endUs > 1_000_000)).toBe(false);
  expect(spatialProjectDocumentText(result.revision.project.assets.slice(0, input.snapshot.contents.legacy.project.assets.length))).toBe(spatialProjectDocumentText(input.snapshot.contents.legacy.project.assets));
  expect(result.projection.policy).toEqual(policy);
});

test("stale source, shot, output geometry, frame count, alpha and missing materialization fail closed", () => {
  const input = fixture();
  for (const invalid of [
    { shotSha256: "f".repeat(64) }, { sceneSha256: "f".repeat(64) }, { pixelWidth: 800 },
    { frameCount: input.materializedShots[0]!.frameCount - 1 }, { alpha: "opaque" as const },
    { frameRate: { numerator: 30, denominator: 1 } },
  ]) expect(() => createSpatialRenderProjection({ ...input, materializedShots: [{ ...input.materializedShots[0]!, ...invalid }] })).toThrow();
  expect(() => createSpatialRenderProjection({ ...input, materializedShots: [] })).toThrow("exactly one");
  expect(() => createSpatialRenderProjection({ ...input, snapshot: { ...input.snapshot, basis: { version: 2, sha256: "f".repeat(64) } } })).toThrow("exact verified");
});

test("projection parsing rejects cross-field receipt tampering and never invokes a foreign input getter", () => {
  const input = fixture();
  const result = createSpatialRenderProjection(input);
  expect(() => SceneRenderProjectionV1Schema.parse({ ...result.projection, legacyFrameRateAdapter: { ...result.projection.legacyFrameRateAdapter, requiredEncoderArgument: "30/1" } })).toThrow("frame-rate");
  expect(() => SceneRenderProjectionV1Schema.parse({ ...result.projection, derivedV1Revision: { ...result.projection.derivedV1Revision, path: "project.json" } })).toThrow("immutable");
  let invoked = false;
  const foreign = Object.defineProperty({ ...input }, "snapshot", { enumerable: true, get: () => { invoked = true; return input.snapshot; } });
  expect(() => createSpatialRenderProjection(foreign)).toThrow();
  expect(invoked).toBe(false);
});
