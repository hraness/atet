import { expect, test } from "bun:test";
import { SpatialProjectHeadV2Schema, SpatialProjectRevisionV2Schema } from "../contracts/spatial-project";
import { spatialProjectArtifact, spatialProjectContents, spatialProjectDocumentText, spatialProjectRevisionSha256 } from "../core/spatial-project";
import { editedPlan, syncedProject } from "./spatial-project-fixture.testing";
import { createSpatialRenderProjection } from "./spatial-render-projection";
import { createSpatialCompositorCadence } from "./spatial-compositor-cadence";
import { canonicalJsonSha256 } from "../core/canonical-json";

function fixture() {
  const project = syncedProject();
  const revision = SpatialProjectRevisionV2Schema.parse({ kind: "atet.spatial-project-revision", schemaVersion: 2,
    projectId: project.projectId, parent: { version: 1, sha256: "a".repeat(64) }, transactionId: `transaction_${"0".repeat(32)}`,
    legacy: { project, projectEditPlan: editedPlan(project) }, scenes: [], shots: [], candidates: [], selections: [] });
  const head = SpatialProjectHeadV2Schema.parse({ kind: "atet.spatial-project-head", schemaVersion: 2, projectId: project.projectId,
    projectRevisionSha256: spatialProjectRevisionSha256(revision), revision: spatialProjectArtifact("revisions", spatialProjectDocumentText(revision)), transactionId: revision.transactionId });
  return createSpatialRenderProjection({ snapshot: { version: 2, head, revision, headText: spatialProjectDocumentText(head), basis: { version: 2, sha256: head.projectRevisionSha256 }, contents: spatialProjectContents(revision, []) },
    materializedShots: [], policy: { kind: "full-frame-above-legacy-video-below-overlays", alpha: "straight" },
    output: { pixelWidth: 640, pixelHeight: 480, frameRate: { numerator: 30000, denominator: 1001 }, background: "#000000ff", colorSpace: "srgb" } });
}
test("exact compositor cadence binds full projection, exact plan and authored duration without changing V1 identities", () => {
  const result = fixture();
  const before = canonicalJsonSha256(result);
  const binding = createSpatialCompositorCadence({ ...result, plan: result.renderPlan });
  expect(binding.cadence.frameRate).toEqual({ numerator: 30000, denominator: 1001 });
  expect(binding.cadence.durationUs).toBe(7_000_000);
  expect(binding.cadence.frameCount).toBe(210);
  expect(binding.cadence.compositionPlanSha256).toBe(result.renderPlan.planSha256);
  expect(binding.cadence.projectionSha256).toBe(result.projectionSha256);
  expect(canonicalJsonSha256(result)).toBe(before);
  expect(Object.isFrozen(binding.cadence.frameRate)).toBe(true);
});
test("cadence rejects forged projection and stale or internally changed V1 plans", () => {
  const result = fixture();
  expect(() => createSpatialCompositorCadence({ ...result, projectionSha256: "b".repeat(64), plan: result.renderPlan })).toThrow("projection digest");
  expect(() => createSpatialCompositorCadence({ ...result, plan: { ...result.renderPlan, output: { ...result.renderPlan.output, frameRate: 30 } } })).toThrow("composition hash");
  expect(() => createSpatialCompositorCadence({ ...result, plan: { ...result.renderPlan, output: { ...result.renderPlan.output, pixelWidth: 800 } } })).toThrow("output");
});
