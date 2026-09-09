import { z } from "zod";

import { createBoundedJsonValueSnapshot } from "../../../src/code/json-snapshot";
import { StudioJobSchema, StudioOutputFormatSchema, StudioOutputRoleSchema, StudioPlanSchema, StudioReceiptSchema, STUDIO_LIMITS, type StudioJob, type StudioPlan } from "../../../src/studio";
import { MediaArtifactReferenceSchema, MediaArtifactRequestSchema } from "./operations/media/shared";

const capture = (value: unknown) => value === undefined ? undefined : createBoundedJsonValueSnapshot(value, 64 * 1024 * 1024, "studio host document", { maximumDepth: 48, maximumValues: 1_000_000 }).value;
const request = z.strictObject({
  /** Must name a retained studioRoot/bundles/<bundleSha256>/bundle.json. */
  bundle: MediaArtifactRequestSchema,
  job: StudioJobSchema,
  plan: StudioPlanSchema.optional(),
});
export const StudioRunInputSchema = z.preprocess(capture, request);
export const BoundStudioRunInputSchema = z.preprocess(capture, request.extend({ bundle: MediaArtifactReferenceSchema, plan: StudioPlanSchema }));
export const StudioRunOutputSchema = z.preprocess(capture, z.strictObject({
  receipt: MediaArtifactReferenceSchema,
  document: StudioReceiptSchema,
  outputs: z.array(z.strictObject({ artifact: MediaArtifactReferenceSchema, outputId: z.string().min(1).max(128), role: StudioOutputRoleSchema, format: StudioOutputFormatSchema })).max(STUDIO_LIMITS.outputFiles),
}));
export interface StudioRunInput { readonly bundle: z.infer<typeof MediaArtifactRequestSchema>; readonly job: StudioJob; readonly plan?: StudioPlan | undefined; }
export interface BoundStudioRunInput { readonly bundle: z.infer<typeof MediaArtifactReferenceSchema>; readonly job: StudioJob; readonly plan: StudioPlan; }
export type StudioRunOutput = z.infer<typeof StudioRunOutputSchema>;

export interface StudioAuthorizationRequest {
  readonly planSha256: string;
  readonly bundleSha256: string;
  readonly jobId: string;
}
/** Explicit host envelope. Generic workflow approval never grants this permission. */
export interface ApplicationStudioAuthorization {
  authorize(request: StudioAuthorizationRequest): Promise<boolean>;
}
export interface StudioBindingControl {
  readonly inheritedFileDescriptors: readonly number[];
  beforePublication(): Promise<void>;
}
export interface StudioHostControl extends StudioBindingControl {
  readonly signal: AbortSignal;
  readonly workspaceDirectory: string;
  /** Exact physical lease descriptors inherited by every native descendant. */
  readonly inheritedFileDescriptors: readonly number[];
  readonly identity: { readonly runId: string; readonly nodeKey: string; readonly nodePlanSha256: string };
  beforePublication(): Promise<void>;
}
export type StudioReconciliation =
  | { readonly kind: "completed"; readonly output: StudioRunOutput }
  | { readonly kind: "ambiguous" | "incompatible"; readonly message: string };

/** Fixed engine dispatch and runtime paths belong to this host-constructed adapter. */
export interface ApplicationStudioPort {
  /** Reads only the retained manifest's explicit source/ closure and probes a fixed owned runtime. Never executes authored code. */
  bind(input: StudioRunInput, signal: AbortSignal, control?: StudioBindingControl): Promise<BoundStudioRunInput>;
  /** Revalidates bound source/runtime, keeps native custody until settled, and fences every publication. */
  execute(input: BoundStudioRunInput, control: StudioHostControl & { readonly allowTrustedCode: true }): Promise<StudioRunOutput>;
  /** Verifies exact retained receipts. Missing/uncertain state never authorizes another execution. */
  reconcile(input: BoundStudioRunInput, control: StudioHostControl): Promise<StudioReconciliation>;
}
