import { z } from "zod";

import {
  IsoTimestampSchema,
  ProjectEditPlanV1Schema,
  ProjectRenderOutputPathSchema,
  RepositoryRelativePathSchema,
  Sha256Schema,
  VideoProjectIdSchema,
  VideoProjectV1Schema,
  type ProjectEditPlanV1,
  type VideoProjectV1,
} from "../contracts";
import {
  canonicalJson,
  canonicalJsonSha256,
  hashProjectEditPlan,
  hashProjectStructure,
} from "../core";
import {
  OrderedProjectEditV3Schema,
  ProjectEditBatchV3Schema,
} from "./operations/derive/edit-batch";
import {
  ProjectCommitManualZoomBindingV3Schema,
  ProjectCommitMetadataBindingV2Schema,
} from "./operations/project/commit-edits";
import {
  hashProjectGeneration,
  projectEditBasis,
  projectGenerationSha256FromHashes,
  ProjectEditBasisSchema,
  ProjectGenerationHashesSchema,
} from "./project-store";
import {
  ProjectEditRevisionArtifactSchema,
  ProjectRenderOutputReferenceSchema,
  ProjectRenderReceiptReferenceSchema,
} from "./receipts";

const MAXIMUM_CREATIVE_DOCUMENT_BYTES = 256 * 1024 * 1024;
const CREATIVE_CANDIDATE_ID_PREFIX = "candidate_";

export const CreativeVariantKeySchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

export const CreativeRenderNameSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);

export const CreativeCandidateIdSchema = z.string()
  .regex(/^candidate_[a-f0-9]{32}$/u);

export const CreativeCandidateNamespaceSchema = RepositoryRelativePathSchema
  .refine(
    value => /^iterations\/[a-f0-9]{64}\/candidates\/candidate_[a-f0-9]{32}$/u
      .test(value),
    "Creative candidate namespaces must be deterministic iteration paths.",
  );

export const CreativeImmutableArtifactSchema = z.strictObject({
  bytes: z.number().int().safe().positive().max(MAXIMUM_CREATIVE_DOCUMENT_BYTES),
  path: RepositoryRelativePathSchema,
  sha256: Sha256Schema,
});

const CreativeBaseV1BodySchema = z.strictObject({
  currentPlan: ProjectEditPlanV1Schema,
  editBasis: ProjectEditBasisSchema,
  generation: ProjectGenerationHashesSchema,
  kind: z.union([
    z.literal("atet.creative-base"),
    z.literal("studio.creative-base"),
  ]),
  project: VideoProjectV1Schema,
  projectId: VideoProjectIdSchema,
  schemaVersion: z.literal(1),
});

function creativeBaseDomainHash(
  body: z.infer<typeof CreativeBaseV1BodySchema>,
): string {
  return canonicalJsonSha256({
    domain: "studio.creative-base/v1",
    ...body,
  });
}

function validateCreativeBase(
  base: z.infer<typeof CreativeBaseV1BodySchema> & {
    readonly baseSha256: string;
  },
  context: z.RefinementCtx,
): void {
  const generation = hashProjectGeneration(base.project, base.currentPlan);
  const basis = projectEditBasis(base.project, base.currentPlan);
  if (
    base.projectId !== base.project.projectId
    || base.projectId !== base.editBasis.projectId
    || base.currentPlan.projectId !== base.projectId
  ) {
    context.addIssue({
      code: "custom",
      message: "Creative base project identities disagree.",
      path: ["projectId"],
    });
  }
  if (
    base.currentPlan.projectStructureSha256
      !== hashProjectStructure(base.project)
  ) {
    context.addIssue({
      code: "custom",
      message: "Creative base plan is not bound to its exact frozen project.",
      path: ["currentPlan", "projectStructureSha256"],
    });
  }
  if (canonicalJson(generation) !== canonicalJson(base.generation)) {
    context.addIssue({
      code: "custom",
      message: "Creative base generation does not match its frozen documents.",
      path: ["generation"],
    });
  }
  if (canonicalJson(basis) !== canonicalJson(base.editBasis)) {
    context.addIssue({
      code: "custom",
      message: "Creative base edit basis does not match its frozen documents.",
      path: ["editBasis"],
    });
  }
  if (
    base.generation.currentPlanSha256 !== base.editBasis.currentPlanSha256
    || base.generation.generationSha256 !== projectGenerationSha256FromHashes(
      base.generation,
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Creative base exact generation and append-tolerant basis disagree.",
      path: ["generation"],
    });
  }
  const body = CreativeBaseV1BodySchema.parse({
    currentPlan: base.currentPlan,
    editBasis: base.editBasis,
    generation: base.generation,
    kind: base.kind,
    project: base.project,
    projectId: base.projectId,
    schemaVersion: base.schemaVersion,
  });
  if (creativeBaseDomainHash(body) !== base.baseSha256) {
    context.addIssue({
      code: "custom",
      message: "Creative base hash does not match its exact frozen documents.",
      path: ["baseSha256"],
    });
  }
}

export const CreativeBaseV1Schema = CreativeBaseV1BodySchema.extend({
  baseSha256: Sha256Schema,
}).strict().superRefine(validateCreativeBase);

export type CreativeBaseV1 = z.infer<typeof CreativeBaseV1Schema>;

export function createCreativeBaseV1(input: {
  readonly currentPlan: ProjectEditPlanV1;
  readonly project: VideoProjectV1;
}): CreativeBaseV1 {
  const project = VideoProjectV1Schema.parse(input.project);
  const currentPlan = ProjectEditPlanV1Schema.parse(input.currentPlan);
  const body = CreativeBaseV1BodySchema.parse({
    currentPlan,
    editBasis: projectEditBasis(project, currentPlan),
    generation: hashProjectGeneration(project, currentPlan),
    kind: "atet.creative-base",
    project,
    projectId: project.projectId,
    schemaVersion: 1,
  });
  return CreativeBaseV1Schema.parse({
    ...body,
    baseSha256: creativeBaseDomainHash(body),
  });
}

export const CreativeBaseIdentityV1Schema = z.strictObject({
  baseSha256: Sha256Schema,
  editBasis: ProjectEditBasisSchema,
  generation: ProjectGenerationHashesSchema,
  projectId: VideoProjectIdSchema,
  schemaVersion: z.literal(1),
}).superRefine((base, context) => {
  if (
    base.projectId !== base.editBasis.projectId
    || base.generation.currentPlanSha256 !== base.editBasis.currentPlanSha256
    || base.generation.generationSha256
      !== projectGenerationSha256FromHashes(base.generation)
  ) {
    context.addIssue({
      code: "custom",
      message: "Creative base identity does not describe one project generation.",
    });
  }
});

export type CreativeBaseIdentityV1 = z.infer<
  typeof CreativeBaseIdentityV1Schema
>;

export function creativeBaseIdentityV1(
  baseInput: CreativeBaseV1,
): CreativeBaseIdentityV1 {
  const base = CreativeBaseV1Schema.parse(baseInput);
  return CreativeBaseIdentityV1Schema.parse({
    baseSha256: base.baseSha256,
    editBasis: base.editBasis,
    generation: base.generation,
    projectId: base.projectId,
    schemaVersion: 1,
  });
}

export function creativeCandidateId(input: {
  readonly baseSha256: string;
  readonly variantKey: string;
}): string {
  const baseSha256 = Sha256Schema.parse(input.baseSha256);
  const variantKey = CreativeVariantKeySchema.parse(input.variantKey);
  return CreativeCandidateIdSchema.parse(
    `${CREATIVE_CANDIDATE_ID_PREFIX}${canonicalJsonSha256({
      baseSha256,
      domain: "studio.creative-candidate-id/v1",
      variantKey,
    }).slice(0, 32)}`,
  );
}

export function creativeCandidateNamespace(input: {
  readonly baseSha256: string;
  readonly candidateId: string;
}): string {
  const baseSha256 = Sha256Schema.parse(input.baseSha256);
  const candidateId = CreativeCandidateIdSchema.parse(input.candidateId);
  return CreativeCandidateNamespaceSchema.parse(
    `iterations/${baseSha256}/candidates/${candidateId}`,
  );
}

export const CreativeCandidateIdentityV1Schema = z.strictObject({
  candidateId: CreativeCandidateIdSchema,
  namespace: CreativeCandidateNamespaceSchema,
  variantKey: CreativeVariantKeySchema,
}).superRefine((candidate, context) => {
  const parts = candidate.namespace.split("/");
  const baseSha256 = parts[1];
  if (
    baseSha256 === undefined
    || creativeCandidateId({
      baseSha256,
      variantKey: candidate.variantKey,
    }) !== candidate.candidateId
    || parts.at(-1) !== candidate.candidateId
  ) {
    context.addIssue({
      code: "custom",
      message: "Creative candidate identity is not stable within its namespace.",
    });
  }
});

export type CreativeCandidateIdentityV1 = z.infer<
  typeof CreativeCandidateIdentityV1Schema
>;

export function createCreativeCandidateIdentityV1(input: {
  readonly base: CreativeBaseV1 | CreativeBaseIdentityV1;
  readonly variantKey: string;
}): CreativeCandidateIdentityV1 {
  const base = "currentPlan" in input.base
    ? creativeBaseIdentityV1(input.base)
    : CreativeBaseIdentityV1Schema.parse(input.base);
  const candidateId = creativeCandidateId({
    baseSha256: base.baseSha256,
    variantKey: input.variantKey,
  });
  return CreativeCandidateIdentityV1Schema.parse({
    candidateId,
    namespace: creativeCandidateNamespace({
      baseSha256: base.baseSha256,
      candidateId,
    }),
    variantKey: input.variantKey,
  });
}

export const CandidateRevisionHostBindingsV1Schema = z.strictObject({
  manualZoomBindings: z.array(
    ProjectCommitManualZoomBindingV3Schema,
  ).max(10_000),
  metadataBinding: ProjectCommitMetadataBindingV2Schema.nullable(),
}).superRefine((bindings, context) => {
  const zoomIds = bindings.manualZoomBindings.map(binding => binding.zoomId);
  if (new Set(zoomIds).size !== zoomIds.length) {
    context.addIssue({
      code: "custom",
      message: "Candidate revision manual zoom bindings must have unique zoom IDs.",
      path: ["manualZoomBindings"],
    });
  }
  for (let index = 1; index < zoomIds.length; index += 1) {
    if (zoomIds[index - 1]!.localeCompare(zoomIds[index]!) >= 0) {
      context.addIssue({
        code: "custom",
        message: "Candidate revision manual zoom bindings must be sorted by zoom ID.",
        path: ["manualZoomBindings", index, "zoomId"],
      });
      break;
    }
  }
});

export type CandidateRevisionHostBindingsV1 = z.infer<
  typeof CandidateRevisionHostBindingsV1Schema
>;

/**
 * Creative comparison includes the frozen baseline. It therefore uses the
 * complete V3 edit language while admitting the one canonical empty batch.
 */
export const CandidateProjectEditBatchV3Schema = z.strictObject({
  kind: z.union([
    z.literal("atet.project-edit-batch"),
    z.literal("studio.project-edit-batch"),
  ]),
  ordered: z.array(OrderedProjectEditV3Schema).max(10_000),
  schemaVersion: z.literal(3),
  sha256: Sha256Schema,
}).superRefine((batch, context) => {
  if (
    canonicalJsonSha256({
      kind: batch.kind,
      ordered: batch.ordered,
      schemaVersion: batch.schemaVersion,
    }) !== batch.sha256
  ) {
    context.addIssue({
      code: "custom",
      message: "Candidate V3 edit batch hash does not match its ordered edits.",
      path: ["sha256"],
    });
  }
  if (batch.ordered.length > 0 && !ProjectEditBatchV3Schema.safeParse(batch).success) {
    context.addIssue({
      code: "custom",
      message: "Candidate edits must satisfy the complete V3 batch contract.",
    });
  }
});

export type CandidateProjectEditBatchV3 = z.infer<
  typeof CandidateProjectEditBatchV3Schema
>;

export function createEmptyCandidateProjectEditBatchV3(): CandidateProjectEditBatchV3 {
  const body = {
    kind: "atet.project-edit-batch" as const,
    ordered: [],
    schemaVersion: 3 as const,
  };
  return CandidateProjectEditBatchV3Schema.parse({
    ...body,
    sha256: canonicalJsonSha256(body),
  });
}

export function canonicalCandidateRevisionHostBindingsV1(input: {
  readonly manualZoomBindings?: readonly z.infer<
    typeof ProjectCommitManualZoomBindingV3Schema
  >[];
  readonly metadataBinding?: z.infer<
    typeof ProjectCommitMetadataBindingV2Schema
  > | null;
}): CandidateRevisionHostBindingsV1 {
  return CandidateRevisionHostBindingsV1Schema.parse({
    manualZoomBindings: [...(input.manualZoomBindings ?? [])]
      .sort((left, right) => left.zoomId.localeCompare(right.zoomId)),
    metadataBinding: input.metadataBinding ?? null,
  });
}

export function candidateRevisionDerivationSha256(input: {
  readonly baseSha256: string;
  readonly batch: CandidateProjectEditBatchV3;
  readonly bindings: CandidateRevisionHostBindingsV1;
  readonly candidate: CreativeCandidateIdentityV1;
  readonly projectEditPlanSha256: string;
  readonly revisionSha256: string;
  readonly updatedAt: string;
}): string {
  return canonicalJsonSha256({
    baseSha256: Sha256Schema.parse(input.baseSha256),
    batch: CandidateProjectEditBatchV3Schema.parse(input.batch),
    bindings: CandidateRevisionHostBindingsV1Schema.parse(input.bindings),
    candidate: CreativeCandidateIdentityV1Schema.parse(input.candidate),
    domain: "studio.creative-candidate-revision-derivation/v1",
    projectEditPlanSha256: Sha256Schema.parse(input.projectEditPlanSha256),
    revisionSha256: Sha256Schema.parse(input.revisionSha256),
    updatedAt: IsoTimestampSchema.parse(input.updatedAt),
  });
}

export const CreativeCandidateRevisionReferenceV1Schema = z.strictObject({
  artifact: ProjectEditRevisionArtifactSchema,
  base: CreativeBaseIdentityV1Schema,
  batchSha256: Sha256Schema,
  bindingsSha256: Sha256Schema,
  candidate: CreativeCandidateIdentityV1Schema,
  derivationSha256: Sha256Schema,
  kind: z.union([
    z.literal("atet.creative-candidate-revision-reference"),
    z.literal("studio.creative-candidate-revision-reference"),
  ]),
  planId: ProjectEditPlanV1Schema.shape.planId,
  projectEditPlanSha256: Sha256Schema,
  projectId: VideoProjectIdSchema,
  projectSha256: Sha256Schema,
  projectStructureSha256: Sha256Schema,
  revisionSha256: Sha256Schema,
  schemaVersion: z.literal(1),
  updatedAt: IsoTimestampSchema,
}).superRefine((revision, context) => {
  if (
    revision.artifact.path
      !== `edits/revisions/${revision.artifact.sha256}.json`
    || revision.base.projectId !== revision.projectId
    || revision.base.generation.projectSha256 !== revision.projectSha256
    || !revision.candidate.namespace.startsWith(
      `iterations/${revision.base.baseSha256}/`,
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Candidate revision reference identities or artifact path disagree.",
    });
  }
});

export type CreativeCandidateRevisionReferenceV1 = z.infer<
  typeof CreativeCandidateRevisionReferenceV1Schema
>;

export const CreativeCandidateRenderV1Schema = z.strictObject({
  name: CreativeRenderNameSchema,
  output: ProjectRenderOutputReferenceSchema,
  receipt: ProjectRenderReceiptReferenceSchema,
}).superRefine((render, context) => {
  if (
    render.output.projectId !== render.receipt.projectId
    || render.output.revisionSha256 !== render.receipt.revisionSha256
    || render.output.sha256 !== render.receipt.outputSha256
  ) {
    context.addIssue({
      code: "custom",
      message: "Creative candidate render output and verified receipt disagree.",
    });
  }
});

export type CreativeCandidateRenderV1 = z.infer<
  typeof CreativeCandidateRenderV1Schema
>;

function validateCanonicalRenders(
  renders: readonly CreativeCandidateRenderV1[],
  context: z.RefinementCtx,
  path: readonly (number | string)[],
): void {
  for (let index = 1; index < renders.length; index += 1) {
    if (renders[index - 1]!.name.localeCompare(renders[index]!.name) >= 0) {
      context.addIssue({
        code: "custom",
        message: "Creative candidate render names must be unique and sorted.",
        path: [...path, index, "name"],
      });
      break;
    }
  }
}

const CreativeCandidateV1BodySchema = z.strictObject({
  base: CreativeBaseV1Schema,
  batch: CandidateProjectEditBatchV3Schema,
  bindings: CandidateRevisionHostBindingsV1Schema,
  candidate: CreativeCandidateIdentityV1Schema,
  kind: z.union([
    z.literal("atet.creative-candidate"),
    z.literal("studio.creative-candidate"),
  ]),
  renders: z.array(CreativeCandidateRenderV1Schema).max(16),
  revision: CreativeCandidateRevisionReferenceV1Schema,
  schemaVersion: z.literal(1),
  updatedAt: IsoTimestampSchema,
});

function creativeCandidateDomainHash(
  body: z.infer<typeof CreativeCandidateV1BodySchema>,
): string {
  return canonicalJsonSha256({
    domain: "studio.creative-candidate/v1",
    ...body,
  });
}

export const CreativeCandidateV1Schema = CreativeCandidateV1BodySchema.extend({
  candidateSha256: Sha256Schema,
}).strict().superRefine((candidate, context) => {
  validateCanonicalRenders(candidate.renders, context, ["renders"]);
  const base = creativeBaseIdentityV1(candidate.base);
  if (
    canonicalJson(base) !== canonicalJson(candidate.revision.base)
    || canonicalJson(candidate.candidate)
      !== canonicalJson(candidate.revision.candidate)
    || candidate.batch.sha256 !== candidate.revision.batchSha256
    || canonicalJsonSha256(candidate.bindings)
      !== candidate.revision.bindingsSha256
    || candidate.updatedAt !== candidate.revision.updatedAt
  ) {
    context.addIssue({
      code: "custom",
      message: "Creative candidate derivation does not match its revision reference.",
    });
  }
  const expectedDerivation = candidateRevisionDerivationSha256({
    baseSha256: candidate.base.baseSha256,
    batch: candidate.batch,
    bindings: candidate.bindings,
    candidate: candidate.candidate,
    projectEditPlanSha256: candidate.revision.projectEditPlanSha256,
    revisionSha256: candidate.revision.revisionSha256,
    updatedAt: candidate.updatedAt,
  });
  if (expectedDerivation !== candidate.revision.derivationSha256) {
    context.addIssue({
      code: "custom",
      message: "Creative candidate revision derivation hash is invalid.",
      path: ["revision", "derivationSha256"],
    });
  }
  if (candidate.renders.some(render => (
    render.output.projectId !== candidate.base.projectId
    || render.output.revisionSha256 !== candidate.revision.revisionSha256
  ))) {
    context.addIssue({
      code: "custom",
      message: "Creative candidate renders must belong to its one revision.",
      path: ["renders"],
    });
  }
  const body = CreativeCandidateV1BodySchema.parse({
    base: candidate.base,
    batch: candidate.batch,
    bindings: candidate.bindings,
    candidate: candidate.candidate,
    kind: candidate.kind,
    renders: candidate.renders,
    revision: candidate.revision,
    schemaVersion: candidate.schemaVersion,
    updatedAt: candidate.updatedAt,
  });
  if (creativeCandidateDomainHash(body) !== candidate.candidateSha256) {
    context.addIssue({
      code: "custom",
      message: "Creative candidate hash does not match its complete derivation.",
      path: ["candidateSha256"],
    });
  }
});

export type CreativeCandidateV1 = z.infer<typeof CreativeCandidateV1Schema>;

export function createCreativeCandidateV1(input: {
  readonly base: CreativeBaseV1;
  readonly batch: CandidateProjectEditBatchV3;
  readonly bindings: CandidateRevisionHostBindingsV1;
  readonly candidate: CreativeCandidateIdentityV1;
  readonly renders: readonly CreativeCandidateRenderV1[];
  readonly revision: CreativeCandidateRevisionReferenceV1;
  readonly updatedAt: string;
}): CreativeCandidateV1 {
  const body = CreativeCandidateV1BodySchema.parse({
    ...input,
    kind: "atet.creative-candidate",
    renders: [...input.renders]
      .sort((left, right) => left.name.localeCompare(right.name)),
    schemaVersion: 1,
  });
  return CreativeCandidateV1Schema.parse({
    ...body,
    candidateSha256: creativeCandidateDomainHash(body),
  });
}

export function creativeCandidatePath(input: {
  readonly baseSha256: string;
  readonly candidateId: string;
  readonly candidateSha256: string;
}): string {
  return RepositoryRelativePathSchema.parse(
    `${creativeCandidateNamespace(input)}/${Sha256Schema.parse(
      input.candidateSha256,
    )}.json`,
  );
}

export const CreativeCandidateReferenceV1Schema = z.strictObject({
  artifact: CreativeImmutableArtifactSchema,
  base: CreativeBaseIdentityV1Schema,
  candidate: CreativeCandidateIdentityV1Schema,
  candidateSha256: Sha256Schema,
  kind: z.union([
    z.literal("atet.creative-candidate-reference"),
    z.literal("studio.creative-candidate-reference"),
  ]),
  renderSetSha256: Sha256Schema,
  revisionSha256: Sha256Schema,
  schemaVersion: z.literal(1),
}).superRefine((reference, context) => {
  const expectedPath = creativeCandidatePath({
    baseSha256: reference.base.baseSha256,
    candidateId: reference.candidate.candidateId,
    candidateSha256: reference.candidateSha256,
  });
  if (
    reference.artifact.path !== expectedPath
    || !reference.candidate.namespace.startsWith(
      `iterations/${reference.base.baseSha256}/`,
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Creative candidate reference path or namespace is invalid.",
    });
  }
});

export type CreativeCandidateReferenceV1 = z.infer<
  typeof CreativeCandidateReferenceV1Schema
>;

export function creativeCandidateRenderSetSha256(
  rendersInput: readonly CreativeCandidateRenderV1[],
): string {
  const renders = [...rendersInput]
    .map(render => CreativeCandidateRenderV1Schema.parse(render))
    .sort((left, right) => left.name.localeCompare(right.name));
  return creativeCandidateRenderSummarySetSha256(
    renders.map(render => ({
      name: render.name,
      outputSha256: render.output.sha256,
      receiptSha256: render.receipt.receiptSha256,
    })),
  );
}

export function creativeCandidateRenderSummarySetSha256(
  rendersInput: readonly {
    readonly name: string;
    readonly outputSha256: string;
    readonly receiptSha256: string;
  }[],
): string {
  const renders = [...rendersInput].map(render => ({
    name: CreativeRenderNameSchema.parse(render.name),
    outputSha256: Sha256Schema.parse(render.outputSha256),
    receiptSha256: Sha256Schema.parse(render.receiptSha256),
  }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return canonicalJsonSha256({
    domain: "studio.creative-candidate-render-set/v1",
    renders,
  });
}

export function creativeCandidateReferenceV1(input: {
  readonly artifact: z.infer<typeof CreativeImmutableArtifactSchema>;
  readonly candidate: CreativeCandidateV1;
}): CreativeCandidateReferenceV1 {
  const candidate = CreativeCandidateV1Schema.parse(input.candidate);
  return CreativeCandidateReferenceV1Schema.parse({
    artifact: input.artifact,
    base: creativeBaseIdentityV1(candidate.base),
    candidate: candidate.candidate,
    candidateSha256: candidate.candidateSha256,
    kind: "atet.creative-candidate-reference",
    renderSetSha256: creativeCandidateRenderSetSha256(candidate.renders),
    revisionSha256: candidate.revision.revisionSha256,
    schemaVersion: 1,
  });
}

function compareCandidateReferences(
  left: CreativeCandidateReferenceV1,
  right: CreativeCandidateReferenceV1,
): number {
  return left.candidate.candidateId.localeCompare(right.candidate.candidateId);
}

export function variantCandidateSetSha256(
  candidatesInput: readonly CreativeCandidateReferenceV1[],
): string {
  const candidates = [...candidatesInput]
    .map(candidate => CreativeCandidateReferenceV1Schema.parse(candidate))
    .sort(compareCandidateReferences);
  return canonicalJsonSha256({
    candidates,
    domain: "studio.variant-candidate-set/v1",
  });
}

const VariantMatrixV1BodySchema = z.strictObject({
  base: CreativeBaseIdentityV1Schema,
  candidateSetSha256: Sha256Schema,
  candidates: z.array(CreativeCandidateReferenceV1Schema).min(1).max(16),
  kind: z.union([
    z.literal("atet.variant-matrix"),
    z.literal("studio.variant-matrix"),
  ]),
  schemaVersion: z.literal(1),
});

function variantMatrixDomainHash(
  body: z.infer<typeof VariantMatrixV1BodySchema>,
): string {
  return canonicalJsonSha256({
    domain: "studio.variant-matrix/v1",
    ...body,
  });
}

export const VariantMatrixV1Schema = VariantMatrixV1BodySchema.extend({
  matrixSha256: Sha256Schema,
}).strict().superRefine((matrix, context) => {
  for (let index = 0; index < matrix.candidates.length; index += 1) {
    const candidate = matrix.candidates[index]!;
    if (canonicalJson(candidate.base) !== canonicalJson(matrix.base)) {
      context.addIssue({
        code: "custom",
        message: "Variant matrix candidates must share the matrix base.",
        path: ["candidates", index, "base"],
      });
    }
    const previous = matrix.candidates[index - 1];
    if (
      previous !== undefined
      && compareCandidateReferences(previous, candidate) >= 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Variant matrix candidate IDs must be unique and sorted.",
        path: ["candidates", index, "candidate", "candidateId"],
      });
    }
  }
  if (variantCandidateSetSha256(matrix.candidates) !== matrix.candidateSetSha256) {
    context.addIssue({
      code: "custom",
      message: "Variant matrix candidate-set hash is invalid.",
      path: ["candidateSetSha256"],
    });
  }
  const body = VariantMatrixV1BodySchema.parse({
    base: matrix.base,
    candidateSetSha256: matrix.candidateSetSha256,
    candidates: matrix.candidates,
    kind: matrix.kind,
    schemaVersion: matrix.schemaVersion,
  });
  if (variantMatrixDomainHash(body) !== matrix.matrixSha256) {
    context.addIssue({
      code: "custom",
      message: "Variant matrix hash does not match its closed candidate set.",
      path: ["matrixSha256"],
    });
  }
});

export type VariantMatrixV1 = z.infer<typeof VariantMatrixV1Schema>;

export function createVariantMatrixV1(input: {
  readonly base: CreativeBaseIdentityV1;
  readonly candidates: readonly CreativeCandidateReferenceV1[];
}): VariantMatrixV1 {
  const candidates = [...input.candidates]
    .map(candidate => CreativeCandidateReferenceV1Schema.parse(candidate))
    .sort(compareCandidateReferences);
  const body = VariantMatrixV1BodySchema.parse({
    base: input.base,
    candidateSetSha256: variantCandidateSetSha256(candidates),
    candidates,
    kind: "atet.variant-matrix",
    schemaVersion: 1,
  });
  return VariantMatrixV1Schema.parse({
    ...body,
    matrixSha256: variantMatrixDomainHash(body),
  });
}

export function variantMatrixPath(input: {
  readonly baseSha256: string;
  readonly matrixSha256: string;
}): string {
  return RepositoryRelativePathSchema.parse(
    `iterations/${Sha256Schema.parse(input.baseSha256)}/matrices/${
      Sha256Schema.parse(input.matrixSha256)
    }.json`,
  );
}

export const VariantMatrixReferenceV1Schema = z.strictObject({
  artifact: CreativeImmutableArtifactSchema,
  base: CreativeBaseIdentityV1Schema,
  candidateCount: z.number().int().safe().min(1).max(16),
  candidateSetSha256: Sha256Schema,
  kind: z.union([
    z.literal("atet.variant-matrix-reference"),
    z.literal("studio.variant-matrix-reference"),
  ]),
  matrixSha256: Sha256Schema,
  schemaVersion: z.literal(1),
}).superRefine((reference, context) => {
  if (reference.artifact.path !== variantMatrixPath({
    baseSha256: reference.base.baseSha256,
    matrixSha256: reference.matrixSha256,
  })) {
    context.addIssue({
      code: "custom",
      message: "Variant matrix reference path is not content-addressed.",
      path: ["artifact", "path"],
    });
  }
});

export type VariantMatrixReferenceV1 = z.infer<
  typeof VariantMatrixReferenceV1Schema
>;

export function variantMatrixReferenceV1(input: {
  readonly artifact: z.infer<typeof CreativeImmutableArtifactSchema>;
  readonly matrix: VariantMatrixV1;
}): VariantMatrixReferenceV1 {
  const matrix = VariantMatrixV1Schema.parse(input.matrix);
  return VariantMatrixReferenceV1Schema.parse({
    artifact: input.artifact,
    base: matrix.base,
    candidateCount: matrix.candidates.length,
    candidateSetSha256: matrix.candidateSetSha256,
    kind: "atet.variant-matrix-reference",
    matrixSha256: matrix.matrixSha256,
    schemaVersion: 1,
  });
}

export const VariantSelectionEvidenceScoreV1Schema = z.strictObject({
  criterion: z.string().min(1).max(128),
  score: z.number().finite().min(-1_000_000).max(1_000_000),
});

export const VariantSelectionEvidenceV1Schema = z.strictObject({
  rationale: z.string().min(1).max(8_192),
  scores: z.array(VariantSelectionEvidenceScoreV1Schema).max(64).optional(),
}).superRefine((evidence, context) => {
  const scores = evidence.scores ?? [];
  for (let index = 1; index < scores.length; index += 1) {
    if (scores[index - 1]!.criterion.localeCompare(scores[index]!.criterion) >= 0) {
      context.addIssue({
        code: "custom",
        message: "Selection evidence criteria must be unique and sorted.",
        path: ["scores", index, "criterion"],
      });
      break;
    }
  }
});

export const VariantSelectionResultV1Schema = z.strictObject({
  candidateSha256: Sha256Schema,
  renders: z.array(z.strictObject({
    name: CreativeRenderNameSchema,
    outputSha256: Sha256Schema,
    receiptSha256: Sha256Schema,
  })).max(16),
  revisionSha256: Sha256Schema,
}).superRefine((result, context) => {
  for (let index = 1; index < result.renders.length; index += 1) {
    if (
      result.renders[index - 1]!.name.localeCompare(
        result.renders[index]!.name,
      ) >= 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Selection result render names must be unique and sorted.",
        path: ["renders", index, "name"],
      });
      break;
    }
  }
});

const VariantSelectionV1BodySchema = z.strictObject({
  base: CreativeBaseIdentityV1Schema,
  chosen: CreativeCandidateReferenceV1Schema,
  evidence: VariantSelectionEvidenceV1Schema.optional(),
  kind: z.union([
    z.literal("atet.variant-selection"),
    z.literal("studio.variant-selection"),
  ]),
  matrix: VariantMatrixReferenceV1Schema,
  result: VariantSelectionResultV1Schema,
  schemaVersion: z.literal(1),
});

function variantSelectionDomainHash(
  body: z.infer<typeof VariantSelectionV1BodySchema>,
): string {
  return canonicalJsonSha256({
    domain: "studio.variant-selection/v1",
    ...body,
  });
}

export const VariantSelectionV1Schema = VariantSelectionV1BodySchema.extend({
  selectionSha256: Sha256Schema,
}).strict().superRefine((selection, context) => {
  if (
    canonicalJson(selection.base) !== canonicalJson(selection.matrix.base)
    || canonicalJson(selection.base) !== canonicalJson(selection.chosen.base)
    || selection.result.candidateSha256 !== selection.chosen.candidateSha256
    || selection.result.revisionSha256 !== selection.chosen.revisionSha256
    || creativeCandidateRenderSummarySetSha256(selection.result.renders)
      !== selection.chosen.renderSetSha256
  ) {
    context.addIssue({
      code: "custom",
      message: "Variant selection base, chosen candidate, and result disagree.",
    });
  }
  const body = VariantSelectionV1BodySchema.parse({
    base: selection.base,
    chosen: selection.chosen,
    ...(selection.evidence === undefined
      ? {}
      : { evidence: selection.evidence }),
    kind: selection.kind,
    matrix: selection.matrix,
    result: selection.result,
    schemaVersion: selection.schemaVersion,
  });
  if (variantSelectionDomainHash(body) !== selection.selectionSha256) {
    context.addIssue({
      code: "custom",
      message: "Variant selection hash does not match its exact decision.",
      path: ["selectionSha256"],
    });
  }
});

export type VariantSelectionV1 = z.infer<typeof VariantSelectionV1Schema>;

export function createVariantSelectionV1(input: {
  readonly candidate: CreativeCandidateV1;
  readonly chosen: CreativeCandidateReferenceV1;
  readonly evidence?: z.infer<typeof VariantSelectionEvidenceV1Schema>;
  readonly matrix: VariantMatrixReferenceV1;
}): VariantSelectionV1 {
  const candidate = CreativeCandidateV1Schema.parse(input.candidate);
  const renders = candidate.renders.map(render => ({
    name: render.name,
    outputSha256: render.output.sha256,
    receiptSha256: render.receipt.receiptSha256,
  }));
  const evidence = input.evidence === undefined
    ? undefined
    : VariantSelectionEvidenceV1Schema.parse({
        ...input.evidence,
        ...(input.evidence.scores === undefined
          ? {}
          : {
              scores: [...input.evidence.scores].sort((left, right) => (
                left.criterion.localeCompare(right.criterion)
              )),
            }),
      });
  const body = VariantSelectionV1BodySchema.parse({
    base: input.matrix.base,
    chosen: input.chosen,
    ...(evidence === undefined ? {} : { evidence }),
    kind: "atet.variant-selection",
    matrix: input.matrix,
    result: {
      candidateSha256: candidate.candidateSha256,
      renders,
      revisionSha256: candidate.revision.revisionSha256,
    },
    schemaVersion: 1,
  });
  return VariantSelectionV1Schema.parse({
    ...body,
    selectionSha256: variantSelectionDomainHash(body),
  });
}

export function variantSelectionPath(input: {
  readonly baseSha256: string;
  readonly selectionSha256: string;
}): string {
  return RepositoryRelativePathSchema.parse(
    `iterations/${Sha256Schema.parse(input.baseSha256)}/selections/${
      Sha256Schema.parse(input.selectionSha256)
    }.json`,
  );
}

export const VariantSelectionReferenceV1Schema = z.strictObject({
  artifact: CreativeImmutableArtifactSchema,
  base: CreativeBaseIdentityV1Schema,
  chosenCandidateId: CreativeCandidateIdSchema,
  chosenCandidateSha256: Sha256Schema,
  kind: z.union([
    z.literal("atet.variant-selection-reference"),
    z.literal("studio.variant-selection-reference"),
  ]),
  matrixSha256: Sha256Schema,
  revisionSha256: Sha256Schema,
  schemaVersion: z.literal(1),
  selectionSha256: Sha256Schema,
}).superRefine((reference, context) => {
  if (reference.artifact.path !== variantSelectionPath({
    baseSha256: reference.base.baseSha256,
    selectionSha256: reference.selectionSha256,
  })) {
    context.addIssue({
      code: "custom",
      message: "Variant selection reference path is not content-addressed.",
      path: ["artifact", "path"],
    });
  }
});

export type VariantSelectionReferenceV1 = z.infer<
  typeof VariantSelectionReferenceV1Schema
>;

export function variantSelectionReferenceV1(input: {
  readonly artifact: z.infer<typeof CreativeImmutableArtifactSchema>;
  readonly selection: VariantSelectionV1;
}): VariantSelectionReferenceV1 {
  const selection = VariantSelectionV1Schema.parse(input.selection);
  return VariantSelectionReferenceV1Schema.parse({
    artifact: input.artifact,
    base: selection.base,
    chosenCandidateId: selection.chosen.candidate.candidateId,
    chosenCandidateSha256: selection.chosen.candidateSha256,
    kind: "atet.variant-selection-reference",
    matrixSha256: selection.matrix.matrixSha256,
    revisionSha256: selection.result.revisionSha256,
    schemaVersion: 1,
    selectionSha256: selection.selectionSha256,
  });
}

const EditorialPromotionReceiptV1BodySchema = z.strictObject({
  base: CreativeBaseIdentityV1Schema,
  candidate: CreativeCandidateReferenceV1Schema,
  kind: z.union([
    z.literal("atet.editorial-promotion-receipt"),
    z.literal("studio.editorial-promotion-receipt"),
  ]),
  promotedBasis: ProjectEditBasisSchema,
  promotedPlanId: ProjectEditPlanV1Schema.shape.planId,
  promotedPlanSha256: Sha256Schema,
  schemaVersion: z.literal(1),
  selection: VariantSelectionReferenceV1Schema,
  transactionId: z.string().regex(/^transaction_[a-f0-9]{32}$/u),
});

function editorialPromotionDomainHash(
  body: z.infer<typeof EditorialPromotionReceiptV1BodySchema>,
): string {
  return canonicalJsonSha256({
    domain: "studio.editorial-promotion-receipt/v1",
    ...body,
  });
}

export const EditorialPromotionReceiptV1Schema =
  EditorialPromotionReceiptV1BodySchema.extend({
    promotionSha256: Sha256Schema,
  }).strict().superRefine((receipt, context) => {
    if (
      canonicalJson(receipt.base) !== canonicalJson(receipt.selection.base)
      || canonicalJson(receipt.base) !== canonicalJson(receipt.candidate.base)
      || receipt.selection.chosenCandidateSha256
        !== receipt.candidate.candidateSha256
      || receipt.promotedBasis.currentPlanSha256
        !== receipt.promotedPlanSha256
    ) {
      context.addIssue({
        code: "custom",
        message: "Editorial promotion receipt identities disagree.",
      });
    }
    const body = EditorialPromotionReceiptV1BodySchema.parse({
      base: receipt.base,
      candidate: receipt.candidate,
      kind: receipt.kind,
      promotedBasis: receipt.promotedBasis,
      promotedPlanId: receipt.promotedPlanId,
      promotedPlanSha256: receipt.promotedPlanSha256,
      schemaVersion: receipt.schemaVersion,
      selection: receipt.selection,
      transactionId: receipt.transactionId,
    });
    if (editorialPromotionDomainHash(body) !== receipt.promotionSha256) {
      context.addIssue({
        code: "custom",
        message: "Editorial promotion receipt hash is invalid.",
        path: ["promotionSha256"],
      });
    }
  });

export type EditorialPromotionReceiptV1 = z.infer<
  typeof EditorialPromotionReceiptV1Schema
>;

export function editorialPromotionTransactionId(selectionSha256: string): string {
  return `transaction_${canonicalJsonSha256({
    domain: "studio.editorial-promotion-transaction/v1",
    selectionSha256: Sha256Schema.parse(selectionSha256),
  }).slice(0, 32)}`;
}

export function createEditorialPromotionReceiptV1(input: {
  readonly base: CreativeBaseIdentityV1;
  readonly candidate: CreativeCandidateReferenceV1;
  readonly promotedPlan: ProjectEditPlanV1;
  readonly selection: VariantSelectionReferenceV1;
  readonly frozenProject: VideoProjectV1;
}): EditorialPromotionReceiptV1 {
  const promotedPlan = ProjectEditPlanV1Schema.parse(input.promotedPlan);
  const frozenProject = VideoProjectV1Schema.parse(input.frozenProject);
  const body = EditorialPromotionReceiptV1BodySchema.parse({
    base: input.base,
    candidate: input.candidate,
    kind: "atet.editorial-promotion-receipt",
    promotedBasis: projectEditBasis(frozenProject, promotedPlan),
    promotedPlanId: promotedPlan.planId,
    promotedPlanSha256: hashProjectEditPlan(promotedPlan),
    schemaVersion: 1,
    selection: input.selection,
    transactionId: editorialPromotionTransactionId(
      input.selection.selectionSha256,
    ),
  });
  return EditorialPromotionReceiptV1Schema.parse({
    ...body,
    promotionSha256: editorialPromotionDomainHash(body),
  });
}

export function editorialPromotionReceiptPath(input: {
  readonly baseSha256: string;
}): string {
  return RepositoryRelativePathSchema.parse(
    `iterations/${Sha256Schema.parse(input.baseSha256)}/promotions/editorial.json`,
  );
}

export const EditorialPromotionReceiptReferenceV1Schema = z.strictObject({
  artifact: CreativeImmutableArtifactSchema,
  kind: z.union([
    z.literal("atet.editorial-promotion-receipt-reference"),
    z.literal("studio.editorial-promotion-receipt-reference"),
  ]),
  projectId: VideoProjectIdSchema,
  promotedPlanSha256: Sha256Schema,
  promotionSha256: Sha256Schema,
  schemaVersion: z.literal(1),
  selectionSha256: Sha256Schema,
}).superRefine((reference, context) => {
  const segments = reference.artifact.path.split("/");
  if (
    segments[0] !== "iterations"
    || segments[2] !== "promotions"
    || segments[3] !== "editorial.json"
  ) {
    context.addIssue({
      code: "custom",
      message: "Editorial promotion receipt reference path is invalid.",
      path: ["artifact", "path"],
    });
  }
});

export type EditorialPromotionReceiptReferenceV1 = z.infer<
  typeof EditorialPromotionReceiptReferenceV1Schema
>;

export function editorialPromotionReceiptReferenceV1(input: {
  readonly artifact: z.infer<typeof CreativeImmutableArtifactSchema>;
  readonly receipt: EditorialPromotionReceiptV1;
}): EditorialPromotionReceiptReferenceV1 {
  const receipt = EditorialPromotionReceiptV1Schema.parse(input.receipt);
  return EditorialPromotionReceiptReferenceV1Schema.parse({
    artifact: input.artifact,
    kind: "atet.editorial-promotion-receipt-reference",
    projectId: receipt.base.projectId,
    promotedPlanSha256: receipt.promotedPlanSha256,
    promotionSha256: receipt.promotionSha256,
    schemaVersion: 1,
    selectionSha256: receipt.selection.selectionSha256,
  });
}

const DeliveryMaterializationReceiptV1BodySchema = z.strictObject({
  candidate: CreativeCandidateReferenceV1Schema,
  destination: ProjectRenderOutputReferenceSchema,
  kind: z.union([
    z.literal("atet.delivery-materialization-receipt"),
    z.literal("studio.delivery-materialization-receipt"),
  ]),
  renderName: CreativeRenderNameSchema,
  schemaVersion: z.literal(1),
  selection: VariantSelectionReferenceV1Schema,
  source: ProjectRenderOutputReferenceSchema,
});

function deliveryMaterializationDomainHash(
  body: z.infer<typeof DeliveryMaterializationReceiptV1BodySchema>,
): string {
  return canonicalJsonSha256({
    domain: "studio.delivery-materialization-receipt/v1",
    ...body,
  });
}

export const DeliveryMaterializationReceiptV1Schema =
  DeliveryMaterializationReceiptV1BodySchema.extend({
    materializationSha256: Sha256Schema,
  }).strict().superRefine((receipt, context) => {
    if (
      receipt.source.path === receipt.destination.path
      || receipt.source.bytes !== receipt.destination.bytes
      || receipt.source.sha256 !== receipt.destination.sha256
      || receipt.source.projectId !== receipt.destination.projectId
      || receipt.source.revisionSha256 !== receipt.destination.revisionSha256
      || receipt.source.planArtifactSha256
        !== receipt.destination.planArtifactSha256
      || canonicalJson(receipt.candidate.base)
        !== canonicalJson(receipt.selection.base)
      || receipt.candidate.candidate.candidateId
        !== receipt.selection.chosenCandidateId
      || receipt.candidate.candidateSha256
        !== receipt.selection.chosenCandidateSha256
      || receipt.candidate.revisionSha256
        !== receipt.selection.revisionSha256
      || receipt.source.projectId !== receipt.selection.base.projectId
      || receipt.source.revisionSha256 !== receipt.selection.revisionSha256
    ) {
      context.addIssue({
        code: "custom",
        message: "Delivery materialization does not preserve the selected render provenance and bytes.",
      });
    }
    const body = DeliveryMaterializationReceiptV1BodySchema.parse({
      candidate: receipt.candidate,
      destination: receipt.destination,
      kind: receipt.kind,
      renderName: receipt.renderName,
      schemaVersion: receipt.schemaVersion,
      selection: receipt.selection,
      source: receipt.source,
    });
    if (
      deliveryMaterializationDomainHash(body)
        !== receipt.materializationSha256
    ) {
      context.addIssue({
        code: "custom",
        message: "Delivery materialization receipt hash is invalid.",
        path: ["materializationSha256"],
      });
    }
  });

export type DeliveryMaterializationReceiptV1 = z.infer<
  typeof DeliveryMaterializationReceiptV1Schema
>;

export function createDeliveryMaterializationReceiptV1(input: {
  readonly candidate: CreativeCandidateReferenceV1;
  readonly destinationPath: string;
  readonly renderName: string;
  readonly selection: VariantSelectionReferenceV1;
  readonly source: z.infer<typeof ProjectRenderOutputReferenceSchema>;
}): DeliveryMaterializationReceiptV1 {
  const source = ProjectRenderOutputReferenceSchema.parse(input.source);
  const body = DeliveryMaterializationReceiptV1BodySchema.parse({
    candidate: input.candidate,
    destination: {
      ...source,
      path: ProjectRenderOutputPathSchema.parse(input.destinationPath),
    },
    kind: "atet.delivery-materialization-receipt",
    renderName: input.renderName,
    schemaVersion: 1,
    selection: input.selection,
    source,
  });
  return DeliveryMaterializationReceiptV1Schema.parse({
    ...body,
    materializationSha256: deliveryMaterializationDomainHash(body),
  });
}

export function deliveryMaterializationReceiptPath(
  materializationSha256Input: string,
): string {
  const materializationSha256 = Sha256Schema.parse(
    materializationSha256Input,
  );
  return RepositoryRelativePathSchema.parse(
    `renders/materializations/${materializationSha256}.json`,
  );
}

export const DeliveryMaterializationReceiptReferenceV1Schema = z.strictObject({
  artifact: CreativeImmutableArtifactSchema,
  destination: ProjectRenderOutputReferenceSchema,
  kind: z.union([
    z.literal("atet.delivery-materialization-receipt-reference"),
    z.literal("studio.delivery-materialization-receipt-reference"),
  ]),
  materializationSha256: Sha256Schema,
  schemaVersion: z.literal(1),
  selectionSha256: Sha256Schema,
}).superRefine((reference, context) => {
  if (
    reference.artifact.path
      !== deliveryMaterializationReceiptPath(reference.materializationSha256)
  ) {
    context.addIssue({
      code: "custom",
      message: "Delivery materialization receipt path is not content-addressed.",
      path: ["artifact", "path"],
    });
  }
});

export type DeliveryMaterializationReceiptReferenceV1 = z.infer<
  typeof DeliveryMaterializationReceiptReferenceV1Schema
>;

export function deliveryMaterializationReceiptReferenceV1(input: {
  readonly artifact: z.infer<typeof CreativeImmutableArtifactSchema>;
  readonly receipt: DeliveryMaterializationReceiptV1;
}): DeliveryMaterializationReceiptReferenceV1 {
  const receipt = DeliveryMaterializationReceiptV1Schema.parse(input.receipt);
  return DeliveryMaterializationReceiptReferenceV1Schema.parse({
    artifact: input.artifact,
    destination: receipt.destination,
    kind: "atet.delivery-materialization-receipt-reference",
    materializationSha256: receipt.materializationSha256,
    schemaVersion: 1,
    selectionSha256: receipt.selection.selectionSha256,
  });
}
