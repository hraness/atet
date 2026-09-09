import { z } from "zod";

import {
  SpatialDigestSchema,
  SpatialSceneV1Schema,
  SpatialShotIdSchema,
  SpatialShotV1Schema,
} from "../../../src/spatial-scene/contracts";
import { RepositoryRelativePathSchema } from "./recording";
import { ProjectEditPlanV1Schema, VideoProjectIdSchema, VideoProjectV1Schema } from "./project";

export const SPATIAL_PROJECT_LIMITS = Object.freeze({
  documentBytes: 32 * 1024 * 1024,
  totalSceneBytes: 128 * 1024 * 1024,
  scenes: 128,
  shots: 1_024,
  candidates: 1_024,
  payloadBytes: 256 * 1024 * 1024,
});
export const SpatialTransactionIdSchema = z.string().regex(/^transaction_[a-f0-9]{32}$/u);
export const SpatialProjectBasisSchema = z.strictObject({
  version: z.union([z.literal(1), z.literal(2)]),
  sha256: SpatialDigestSchema,
});
export const SpatialProjectArtifactSchema = z.strictObject({
  path: z.string().regex(/^spatial\/(?:scenes|revisions|attempts|receipts)\/[a-f0-9]{64}\.json$/u),
  sha256: SpatialDigestSchema,
  bytes: z.number().int().positive().max(SPATIAL_PROJECT_LIMITS.documentBytes),
}).superRefine((artifact, context) => {
  if (!artifact.path.endsWith(`/${artifact.sha256}.json`)) {
    context.addIssue({ code: "custom", message: "Artifact path must name its exact byte digest." });
  }
});
export const SpatialSceneReferenceSchema = z.strictObject({
  sceneSha256: SpatialDigestSchema,
  artifact: SpatialProjectArtifactSchema.refine(value => value.path.startsWith("spatial/scenes/")),
});
/** These are frozen V1 values. Migration never rewrites their identity or hash domain. */
export const SpatialProjectLegacySchema = z.strictObject({
  project: VideoProjectV1Schema,
  projectEditPlan: ProjectEditPlanV1Schema,
});
export const SpatialCandidateIdSchema = z.string().regex(/^candidate_[a-zA-Z0-9_-]{1,128}$/u);
export const SpatialCandidateSchema = z.strictObject({
  candidateId: SpatialCandidateIdSchema,
  derivation: z.strictObject({
    shotId: SpatialShotIdSchema,
    shotSha256: SpatialDigestSchema,
    sceneSha256: SpatialDigestSchema,
    recipeSha256: SpatialDigestSchema,
  }),
  outputs: z.array(z.strictObject({
    path: RepositoryRelativePathSchema.refine(path => /^spatial\/outputs\/[a-f0-9]{64}\.[a-z0-9]{1,8}$/u.test(path), "Candidate outputs must be content-addressed spatial artifacts."),
    sha256: SpatialDigestSchema,
    bytes: z.number().int().positive().max(SPATIAL_PROJECT_LIMITS.payloadBytes),
  }).superRefine((output, context) => {
    if (!output.path.startsWith(`spatial/outputs/${output.sha256}.`)) context.addIssue({ code: "custom", message: "Candidate path must name its payload digest." });
  })).min(1).max(16),
});
export const SpatialCandidateSelectionSchema = z.strictObject({
  shotId: SpatialShotIdSchema,
  candidateId: SpatialCandidateIdSchema,
});
export const SpatialProjectRevisionV2Schema = z.strictObject({
  kind: z.literal("atet.spatial-project-revision"),
  schemaVersion: z.literal(2),
  projectId: VideoProjectIdSchema,
  parent: SpatialProjectBasisSchema,
  transactionId: SpatialTransactionIdSchema,
  legacy: SpatialProjectLegacySchema,
  scenes: z.array(SpatialSceneReferenceSchema).max(SPATIAL_PROJECT_LIMITS.scenes),
  shots: z.array(SpatialShotV1Schema).max(SPATIAL_PROJECT_LIMITS.shots),
  candidates: z.array(SpatialCandidateSchema).max(SPATIAL_PROJECT_LIMITS.candidates),
  selections: z.array(SpatialCandidateSelectionSchema).max(SPATIAL_PROJECT_LIMITS.shots),
}).superRefine((revision, context) => {
  if (revision.projectId !== revision.legacy.project.projectId
    || revision.projectId !== revision.legacy.projectEditPlan.projectId) {
    context.addIssue({ code: "custom", message: "Frozen media and spatial project identities must match." });
  }
  for (const ids of [revision.scenes.map(value => value.sceneSha256), revision.shots.map(value => value.shotId),
    revision.candidates.map(value => value.candidateId), revision.selections.map(value => value.shotId)]) {
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "Duplicate project identity." });
  }
  if (revision.scenes.reduce((total, scene) => total + scene.artifact.bytes, 0) > SPATIAL_PROJECT_LIMITS.totalSceneBytes) {
    context.addIssue({ code: "custom", message: "Project scene byte budget exceeded." });
  }
  for (const shot of revision.shots) {
    if (!revision.scenes.some(scene => scene.sceneSha256 === shot.sceneSha256)) context.addIssue({ code: "custom", message: "Shot references an absent scene." });
    if (shot.range.endUs > revision.legacy.project.timeline.durationUs) context.addIssue({ code: "custom", message: "Shot exceeds the project clock." });
  }
  for (const candidate of revision.candidates) {
    if (!revision.scenes.some(scene => scene.sceneSha256 === candidate.derivation.sceneSha256)
      || !revision.shots.some(shot => shot.shotId === candidate.derivation.shotId)) {
      context.addIssue({ code: "custom", message: "Candidate derivation is not retained in this project." });
    }
  }
  for (const selection of revision.selections) {
    if (!revision.shots.some(shot => shot.shotId === selection.shotId)
      || !revision.candidates.some(candidate => candidate.candidateId === selection.candidateId
        && candidate.derivation.shotId === selection.shotId)) {
      context.addIssue({ code: "custom", message: "Selection must bind a candidate for its exact shot." });
    }
  }
});
export const SpatialProjectHeadV2Schema = z.strictObject({
  kind: z.literal("atet.spatial-project-head"),
  schemaVersion: z.literal(2),
  projectId: VideoProjectIdSchema,
  projectRevisionSha256: SpatialDigestSchema,
  revision: SpatialProjectArtifactSchema.refine(value => value.path.startsWith("spatial/revisions/")),
  transactionId: SpatialTransactionIdSchema,
});
export const SpatialProjectAttemptV1Schema = z.strictObject({
  kind: z.literal("atet.spatial-project-attempt"),
  schemaVersion: z.literal(1),
  beforeHeadSha256: SpatialDigestSchema,
  expected: SpatialProjectBasisSchema,
  after: SpatialProjectHeadV2Schema,
});
export const SpatialProjectSettlementV1Schema = z.strictObject({
  kind: z.literal("atet.spatial-project-settlement"),
  schemaVersion: z.literal(1),
  attempt: SpatialProjectArtifactSchema.refine(value => value.path.startsWith("spatial/attempts/")),
  headSha256: SpatialDigestSchema,
});
export const SpatialProjectSceneSourceSchema = z.strictObject({
  sceneSha256: SpatialDigestSchema,
  document: SpatialSceneV1Schema,
});
export const SpatialShotRetargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("all") }),
  z.strictObject({ kind: z.literal("shots"), shotIds: z.array(SpatialShotIdSchema).min(1).max(SPATIAL_PROJECT_LIMITS.shots) }),
]);
export const SpatialProjectSceneDiffSchema = z.strictObject({
  beforeSceneSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  afterSceneSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  affectedShotIds: z.array(SpatialShotIdSchema).max(SPATIAL_PROJECT_LIMITS.shots),
  untouchedShotIds: z.array(SpatialShotIdSchema).max(SPATIAL_PROJECT_LIMITS.shots),
  selectedCandidates: z.array(SpatialCandidateSelectionSchema.extend({ status: z.enum(["current", "stale"]) })).max(SPATIAL_PROJECT_LIMITS.shots),
});
/** Publication evidence is shared with run receipts and browser consumers. */
export const SpatialProjectMutationOutputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ projectId: VideoProjectIdSchema, kind: z.literal("completed"), attempt: SpatialProjectArtifactSchema, settlement: SpatialProjectArtifactSchema.refine(value => value.path.startsWith("spatial/receipts/")), projectRevisionSha256: z.string().regex(/^[a-f0-9]{64}$/u), currentHeadMatches: z.boolean(), diff: SpatialProjectSceneDiffSchema.optional() }),
  z.strictObject({ projectId: VideoProjectIdSchema, kind: z.literal("conflict"), message: z.string().max(65_536), attempt: SpatialProjectArtifactSchema.optional() }),
  z.strictObject({ projectId: VideoProjectIdSchema, kind: z.literal("precommit"), message: z.string().max(65_536), attempt: SpatialProjectArtifactSchema.optional() }),
  z.strictObject({ projectId: VideoProjectIdSchema, kind: z.literal("ambiguous"), message: z.string().max(65_536), attempt: SpatialProjectArtifactSchema }),
]);

type SpatialReadonly<T> = T extends string | number | boolean | null | undefined | bigint | symbol
  ? T : T extends object ? { readonly [Key in keyof T]: SpatialReadonly<T[Key]> } : T;
export type SpatialProjectArtifact = SpatialReadonly<z.infer<typeof SpatialProjectArtifactSchema>>;
export type SpatialProjectBasis = SpatialReadonly<z.infer<typeof SpatialProjectBasisSchema>>;
export type SpatialProjectHeadV2 = SpatialReadonly<z.infer<typeof SpatialProjectHeadV2Schema>>;
export type SpatialProjectRevisionV2 = SpatialReadonly<z.infer<typeof SpatialProjectRevisionV2Schema>>;
export type SpatialProjectLegacy = SpatialReadonly<z.infer<typeof SpatialProjectLegacySchema>>;
export type SpatialProjectSceneSource = SpatialReadonly<z.infer<typeof SpatialProjectSceneSourceSchema>>;
export type SpatialCandidate = SpatialReadonly<z.infer<typeof SpatialCandidateSchema>>;
export type SpatialShotRetarget = SpatialReadonly<z.infer<typeof SpatialShotRetargetSchema>>;
export type SpatialProjectMutationOutput = z.infer<typeof SpatialProjectMutationOutputSchema>;
