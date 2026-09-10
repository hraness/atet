import { z } from "zod";

import { createBoundedJsonValueSnapshot } from "../../../../../src/code/json-snapshot";
import { SpatialDigestSchema } from "../../../../../src/spatial-scene/contracts";
import { RepositoryRelativePathSchema } from "../../../contracts/recording";
import { SpatialCompositorCadenceBindingV1Schema, SpatialCompositorTimingVerificationV1Schema } from "../../../contracts/spatial-compositor";
import { canonicalJson, canonicalJsonSha256 } from "../../../core/canonical-json";
import { assertSpatialCompositorCadence } from "../../../core/spatial-compositor";
import { ProjectRenderOutputReferenceSchema, ProjectRenderReceiptV2Schema } from "../../receipts";
import { SceneRenderProjectionV1Schema } from "../../spatial-render-projection";

export const PROJECT_SPATIAL_RECEIPT_MAXIMUM_BYTES = 32 * 1024 * 1024;
export const ProjectRenderSpatialBindingV1Schema = z.strictObject({
  projection: SceneRenderProjectionV1Schema,
  projectionSha256: SpatialDigestSchema,
  cadence: SpatialCompositorCadenceBindingV1Schema,
}).superRefine((value, context) => {
  try {
    const cadence = assertSpatialCompositorCadence(value.cadence);
    if (canonicalJsonSha256({ domain: "slopcamera.scene-render-projection/v1", projection: value.projection }) !== value.projectionSha256
      || cadence.cadence.projectionSha256 !== value.projectionSha256
      || cadence.cadence.compositionPlanSha256 !== value.projection.compositionPlanSha256
      || canonicalJson(cadence.cadence.frameRate) !== canonicalJson(value.projection.output.frameRate)) throw new Error("Spatial projection and cadence identities disagree.");
  } catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid spatial compositor binding." }); }
});

const receiptBodySchema = z.strictObject({
  kind: z.literal("slopcamera.spatial-project-render-receipt"), schemaVersion: z.literal(1),
  /** Existing execution identities keep their V2 meaning inside this distinct authority envelope. */
  execution: ProjectRenderReceiptV2Schema,
  spatial: ProjectRenderSpatialBindingV1Schema,
  timing: SpatialCompositorTimingVerificationV1Schema,
});
const receiptShape = receiptBodySchema.extend({ receiptSha256: SpatialDigestSchema }).superRefine((receipt, context) => {
  const { receiptSha256, ...body } = receipt;
  if (canonicalJsonSha256({ domain: "slopcamera.spatial-project-render-receipt/v1", ...body }) !== receiptSha256
    || receipt.execution.projectId !== receipt.spatial.projection.source.projectId
    || receipt.execution.revisionSha256 !== receipt.spatial.projection.derivedV1RevisionSha256
    || receipt.execution.plan.planSha256 !== receipt.spatial.projection.compositionPlanSha256
    || receipt.timing.cadenceSha256 !== receipt.spatial.cadence.cadenceSha256
    || receipt.timing.frameCount !== receipt.spatial.cadence.cadence.frameCount
    || receipt.timing.authoredDurationUs !== receipt.spatial.cadence.cadence.durationUs
    || receipt.timing.video.pixelWidth !== receipt.spatial.projection.output.pixelWidth
    || receipt.timing.video.pixelHeight !== receipt.spatial.projection.output.pixelHeight
    || canonicalJson(receipt.timing.frameRate) !== canonicalJson(receipt.spatial.cadence.cadence.frameRate)) {
    context.addIssue({ code: "custom", message: "Spatial render receipt does not bind its exact authority, execution and measured cadence." });
  }
});
const capture = (input: unknown) => createBoundedJsonValueSnapshot(input, PROJECT_SPATIAL_RECEIPT_MAXIMUM_BYTES, "spatial compositor receipt", { maximumDepth: 64, maximumValues: 1_000_000 }).value;
export const ProjectSpatialRenderReceiptV1Schema = z.preprocess(capture, receiptShape);
export type ProjectSpatialRenderReceiptV1 = z.infer<typeof ProjectSpatialRenderReceiptV1Schema>;
export function createProjectSpatialRenderReceipt(input: Omit<z.infer<typeof receiptBodySchema>, "kind" | "schemaVersion">): ProjectSpatialRenderReceiptV1 {
  const body = receiptBodySchema.parse({ ...input, kind: "slopcamera.spatial-project-render-receipt", schemaVersion: 1 });
  return ProjectSpatialRenderReceiptV1Schema.parse({ ...body, receiptSha256: canonicalJsonSha256({ domain: "slopcamera.spatial-project-render-receipt/v1", ...body }) });
}
export const ProjectSpatialRenderReceiptReferenceSchema = z.strictObject({
  kind: z.literal("slopcamera.spatial-project-render-receipt-reference"), schemaVersion: z.literal(1),
  projectId: ProjectRenderOutputReferenceSchema.shape.projectId,
  revisionSha256: SpatialDigestSchema, projectRevisionSha256: SpatialDigestSchema,
  projectionSha256: SpatialDigestSchema, cadenceSha256: SpatialDigestSchema,
  nodePlanSha256: SpatialDigestSchema, outputSha256: SpatialDigestSchema, receiptSha256: SpatialDigestSchema,
  sha256: SpatialDigestSchema, bytes: z.number().int().positive().max(PROJECT_SPATIAL_RECEIPT_MAXIMUM_BYTES),
  path: RepositoryRelativePathSchema,
}).superRefine((reference, context) => {
  if (reference.path !== `renders/receipts/${reference.nodePlanSha256}.spatial.json`) context.addIssue({ code: "custom", message: "Spatial receipt path must bind the exact node plan." });
});
export const ProjectRenderOutputSchemaV4 = z.strictObject({ output: ProjectRenderOutputReferenceSchema, receipt: ProjectSpatialRenderReceiptReferenceSchema }).superRefine((result, context) => {
  if (result.output.projectId !== result.receipt.projectId || result.output.revisionSha256 !== result.receipt.revisionSha256 || result.output.sha256 !== result.receipt.outputSha256) context.addIssue({ code: "custom", message: "Spatial compositor output and receipt disagree." });
});
export type ProjectRenderOutputV4 = z.infer<typeof ProjectRenderOutputSchemaV4>;
