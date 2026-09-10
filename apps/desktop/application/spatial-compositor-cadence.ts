import { createBoundedJsonValueSnapshot } from "../../../src/code/json-snapshot";
import { spatialFrameCount } from "../../../src/spatial-scene/time";
import { ProjectRenderPlanV1Schema } from "../contracts/project-render";
import { canonicalJsonSha256 } from "../core/canonical-json";
import { assertSpatialCompositorCadence, spatialCompositorCadenceSha256 } from "../core/spatial-compositor";
import { SceneRenderProjectionV1Schema } from "./spatial-render-projection";

/** Bind a verified projection to its exact V1 plan without rewriting either document. */
export function createSpatialCompositorCadence(input: { readonly projection: unknown; readonly projectionSha256: string; readonly plan: unknown }) {
  const projection = SceneRenderProjectionV1Schema.parse(createBoundedJsonValueSnapshot(input.projection, 16 * 1024 * 1024, "spatial render projection", { maximumDepth: 48, maximumValues: 1_000_000 }).value);
  const plan = ProjectRenderPlanV1Schema.parse(createBoundedJsonValueSnapshot(input.plan, 64 * 1024 * 1024, "spatial composition plan", { maximumDepth: 48, maximumValues: 2_000_000 }).value);
  if (canonicalJsonSha256({ domain: "slopcamera.scene-render-projection/v1", projection }) !== input.projectionSha256) throw new Error("Spatial render projection digest mismatch.");
  if (projection.compositionPlanSha256 !== plan.planSha256
    || projection.output.pixelWidth !== plan.output.pixelWidth || projection.output.pixelHeight !== plan.output.pixelHeight
    || projection.output.background !== plan.output.background) throw new Error("Spatial projection output does not match its composition plan.");
  const cadence = {
    kind: "slopcamera.spatial-compositor-cadence" as const, schemaVersion: 1 as const,
    projectionSha256: input.projectionSha256, compositionPlanSha256: plan.planSha256,
    frameRate: projection.output.frameRate, durationUs: plan.output.durationUs,
    frameCount: spatialFrameCount(plan.output.durationUs, projection.output.frameRate),
  };
  return assertSpatialCompositorCadence({ cadence, cadenceSha256: spatialCompositorCadenceSha256(cadence) }, plan);
}
