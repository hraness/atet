import { createBoundedJsonValueSnapshot, deepFreezeJson } from "../../../src/code/json-snapshot";
import { SpatialCompositorCadenceBindingV1Schema, type SpatialCompositorCadenceBindingV1 } from "../contracts/spatial-compositor";
import type { ProjectRenderPlanV1 } from "../contracts/project-render";
import { canonicalJsonSha256 } from "./canonical-json";
import { assertProjectRenderPlanComposition } from "./project-render-plan";

export function spatialCompositorCadenceSha256(cadence: SpatialCompositorCadenceBindingV1["cadence"]): string {
  return canonicalJsonSha256({ domain: "slopcamera.spatial-compositor-cadence/v1", cadence });
}

/** Recheck at the native boundary even when the caller previously bound a projection. */
export function assertSpatialCompositorCadence(input: unknown, plan?: ProjectRenderPlanV1): SpatialCompositorCadenceBindingV1 {
  const binding = SpatialCompositorCadenceBindingV1Schema.parse(createBoundedJsonValueSnapshot(input, 4096, "spatial compositor cadence", { maximumDepth: 8, maximumValues: 100 }).value);
  if (binding.cadenceSha256 !== spatialCompositorCadenceSha256(binding.cadence)) throw new Error("Spatial compositor cadence digest mismatch.");
  if (plan !== undefined) {
    assertProjectRenderPlanComposition(plan);
    if (plan.planSha256 !== binding.cadence.compositionPlanSha256
      || plan.output.durationUs !== binding.cadence.durationUs
      || plan.output.frameRate !== binding.cadence.frameRate.numerator / binding.cadence.frameRate.denominator) throw new Error("Spatial compositor cadence does not bind the exact V1 composition plan.");
  }
  return deepFreezeJson(binding);
}
