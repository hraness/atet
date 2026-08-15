import { z } from "zod";

import {
  AnalysisIdSchema,
  EditPlanIdSchema,
  ProjectEditPlanV1Schema,
  ProjectRenderInvocationSchema,
  ProjectRenderOutputPathSchema,
  ProjectRenderPlanV1Schema,
  ProjectRenderSyncPolicySchema,
  ProjectRenderToolchainSchema,
  RepositoryRelativePathSchema,
  Sha256Schema,
  VideoProjectV1Schema,
  VideoProjectIdSchema,
  type ProjectEditPlanV1,
  type ProjectRenderInvocation,
  type ProjectRenderSyncPolicy,
  type ProjectRenderToolchain,
  type VideoProjectV1,
} from "../contracts";
import {
  canonicalJsonSha256,
  hashProjectEditPlan,
  hashProjectStructure,
} from "../core";
import {
  ProjectEditBasisSchema,
  ProjectGenerationHashesSchema,
} from "./project-store";

export const ProjectEditCommitReceiptSchema = z.strictObject({
  editBasis: ProjectEditBasisSchema,
  generation: ProjectGenerationHashesSchema,
  operation: z.enum(["batch", "cut", "speed", "trim"]),
  planHash: Sha256Schema,
  planId: EditPlanIdSchema,
  projectId: VideoProjectIdSchema,
});

export const ProjectRenderPlanArtifactSchema = z.strictObject({
  bytes: z.number().int().safe().positive().max(256 * 1024 * 1024),
  path: RepositoryRelativePathSchema,
  sha256: Sha256Schema,
});

export const ProjectEditRevisionAspectSchema = z.enum(["16:9", "1:1", "9:16"]);

export const ProjectEditRevisionArtifactSchema = z.strictObject({
  bytes: z.number().int().safe().positive(),
  path: RepositoryRelativePathSchema,
  sha256: Sha256Schema,
});

export function hashProjectEditRevisionOutputGeometry(input: {
  readonly pixelHeight: number;
  readonly pixelWidth: number;
  readonly revisionSha256: string;
}): string {
  return canonicalJsonSha256({
    domain: "studio.project-edit-revision-output-geometry/v1",
    pixelHeight: input.pixelHeight,
    pixelWidth: input.pixelWidth,
    revisionSha256: input.revisionSha256,
  });
}

const ProjectEditRevisionDocumentBodySchema = z.strictObject({
  kind: z.union([
    z.literal("atet.project-edit-revision"),
    z.literal("transmute.project-edit-revision"),
    z.literal("studio.project-edit-revision"),
  ]),
  project: VideoProjectV1Schema,
  projectEditPlan: ProjectEditPlanV1Schema,
  projectEditPlanSha256: Sha256Schema,
  projectSha256: Sha256Schema,
  schemaVersion: z.literal(1),
});

function editRevisionDomainHash(
  body: z.infer<typeof ProjectEditRevisionDocumentBodySchema>,
): string {
  return canonicalJsonSha256({
    domain: "studio.project-edit-revision/v1",
    ...body,
  });
}

export const ProjectEditRevisionDocumentSchema =
  ProjectEditRevisionDocumentBodySchema.extend({
    revisionSha256: Sha256Schema,
  }).strict().superRefine((revision, context) => {
    if (canonicalJsonSha256(revision.project) !== revision.projectSha256) {
      context.addIssue({
        code: "custom",
        message: "Revision project hash does not match its frozen project.",
        path: ["projectSha256"],
      });
    }
    if (
      canonicalJsonSha256(revision.projectEditPlan)
        !== revision.projectEditPlanSha256
      || hashProjectEditPlan(revision.projectEditPlan)
        !== revision.projectEditPlanSha256
    ) {
      context.addIssue({
        code: "custom",
        message: "Revision edit-plan hash does not match its frozen plan.",
        path: ["projectEditPlanSha256"],
      });
    }
    if (
      revision.projectEditPlan.projectId !== revision.project.projectId
      || revision.projectEditPlan.projectStructureSha256
        !== hashProjectStructure(revision.project)
    ) {
      context.addIssue({
        code: "custom",
        message: "Revision edit plan is not structurally bound to its frozen project.",
        path: ["projectEditPlan"],
      });
    }
    const body = ProjectEditRevisionDocumentBodySchema.parse({
      kind: revision.kind,
      project: revision.project,
      projectEditPlan: revision.projectEditPlan,
      projectEditPlanSha256: revision.projectEditPlanSha256,
      projectSha256: revision.projectSha256,
      schemaVersion: revision.schemaVersion,
    });
    if (editRevisionDomainHash(body) !== revision.revisionSha256) {
      context.addIssue({
        code: "custom",
        message: "Revision domain hash does not match its frozen documents.",
        path: ["revisionSha256"],
      });
    }
  });

export function createProjectEditRevisionDocument(
  projectInput: VideoProjectV1,
  planInput: ProjectEditPlanV1,
): z.infer<typeof ProjectEditRevisionDocumentSchema> {
  const project = VideoProjectV1Schema.parse(projectInput);
  const projectEditPlan = ProjectEditPlanV1Schema.parse(planInput);
  const body = ProjectEditRevisionDocumentBodySchema.parse({
    kind: "atet.project-edit-revision",
    project,
    projectEditPlan,
    projectEditPlanSha256: canonicalJsonSha256(projectEditPlan),
    projectSha256: canonicalJsonSha256(project),
    schemaVersion: 1,
  });
  return ProjectEditRevisionDocumentSchema.parse({
    ...body,
    revisionSha256: editRevisionDomainHash(body),
  });
}

export const ProjectEditRevisionReferenceSchema = z.strictObject({
  analysisId: AnalysisIdSchema,
  analysisSha256: Sha256Schema,
  artifact: ProjectEditRevisionArtifactSchema,
  aspect: ProjectEditRevisionAspectSchema,
  baseGeneration: ProjectGenerationHashesSchema,
  derivationSha256: Sha256Schema,
  kind: z.union([
    z.literal("atet.project-edit-revision-reference"),
    z.literal("transmute.project-edit-revision-reference"),
    z.literal("studio.project-edit-revision-reference"),
  ]),
  outputGeometrySha256: Sha256Schema,
  pixelHeight: z.number().int().safe().positive().max(16_384),
  pixelWidth: z.number().int().safe().positive().max(16_384),
  planId: EditPlanIdSchema,
  projectEditPlanSha256: Sha256Schema,
  projectId: VideoProjectIdSchema,
  projectSha256: Sha256Schema,
  projectStructureSha256: Sha256Schema,
  revisionSha256: Sha256Schema,
  schemaVersion: z.literal(1),
}).superRefine((reference, context) => {
  if (
    reference.artifact.path
    !== `edits/revisions/${reference.artifact.sha256}.json`
  ) {
    context.addIssue({
      code: "custom",
      message: "Revision artifact path must be addressed by its physical SHA-256.",
      path: ["artifact", "path"],
    });
  }
  if (reference.baseGeneration.projectSha256 !== reference.projectSha256) {
    context.addIssue({
      code: "custom",
      message: "Revision frozen project does not match its checked base generation.",
      path: ["projectSha256"],
    });
  }
  if (
    reference.outputGeometrySha256
    !== hashProjectEditRevisionOutputGeometry(reference)
  ) {
    context.addIssue({
      code: "custom",
      message: "Revision output geometry is not bound to its immutable revision identity.",
      path: ["outputGeometrySha256"],
    });
  }
  const expectedAspect = {
    "16:9": 16 / 9,
    "1:1": 1,
    "9:16": 9 / 16,
  }[reference.aspect];
  if (
    Math.abs(reference.pixelWidth / reference.pixelHeight - expectedAspect)
    > 1e-12
  ) {
    context.addIssue({
      code: "custom",
      message: "Revision output dimensions do not match its reviewed aspect.",
      path: ["aspect"],
    });
  }
});

/**
 * The render boundary depends only on the frozen project/edit documents and
 * their output geometry. Face-analysis provenance remains available on the
 * richer face-follow reference but is not required for a generic revision.
 */
export const RenderableProjectEditRevisionReferenceSchema = z.strictObject({
  artifact: ProjectEditRevisionArtifactSchema,
  baseGeneration: ProjectGenerationHashesSchema,
  kind: z.union([
    z.literal("atet.project-edit-revision-reference"),
    z.literal("transmute.project-edit-revision-reference"),
    z.literal("studio.project-edit-revision-reference"),
  ]),
  outputGeometrySha256: Sha256Schema,
  pixelHeight: z.number().int().safe().positive().max(16_384),
  pixelWidth: z.number().int().safe().positive().max(16_384),
  planId: EditPlanIdSchema,
  projectEditPlanSha256: Sha256Schema,
  projectId: VideoProjectIdSchema,
  projectSha256: Sha256Schema,
  projectStructureSha256: Sha256Schema,
  revisionSha256: Sha256Schema,
  schemaVersion: z.literal(1),
}).superRefine((reference, context) => {
  if (
    reference.artifact.path
    !== `edits/revisions/${reference.artifact.sha256}.json`
  ) {
    context.addIssue({
      code: "custom",
      message: "Revision artifact path must be addressed by its physical SHA-256.",
      path: ["artifact", "path"],
    });
  }
  if (reference.baseGeneration.projectSha256 !== reference.projectSha256) {
    context.addIssue({
      code: "custom",
      message: "Revision frozen project does not match its checked base generation.",
      path: ["projectSha256"],
    });
  }
  if (
    reference.outputGeometrySha256
    !== hashProjectEditRevisionOutputGeometry(reference)
  ) {
    context.addIssue({
      code: "custom",
      message: "Revision output geometry is not bound to its immutable revision identity.",
      path: ["outputGeometrySha256"],
    });
  }
});

export const ProjectEditRevisionRenderInputSchema = z.union([
  ProjectEditRevisionReferenceSchema,
  RenderableProjectEditRevisionReferenceSchema,
]);

export const ProjectRenderPlanDocumentSchema = z.strictObject({
  kind: z.union([
    z.literal("atet.project-render-plan-document"),
    z.literal("transmute.project-render-plan-document"),
    z.literal("studio.project-render-plan-document"),
  ]),
  outputGeometrySha256: Sha256Schema,
  plan: ProjectRenderPlanV1Schema,
  projectEditPlanSha256: Sha256Schema,
  projectSha256: Sha256Schema,
  renderPlanSha256: Sha256Schema,
  revisionSha256: Sha256Schema,
  schemaVersion: z.literal(1),
}).superRefine((document, context) => {
  if (
    document.plan.projectEditPlanSha256 !== document.projectEditPlanSha256
  ) {
    context.addIssue({
      code: "custom",
      message: "Render plan document edit identity does not match its plan.",
      path: ["projectEditPlanSha256"],
    });
  }
  if (canonicalJsonSha256(document.plan) !== document.renderPlanSha256) {
    context.addIssue({
      code: "custom",
      message: "Render plan document hash does not match its complete plan.",
      path: ["renderPlanSha256"],
    });
  }
  if (
    document.outputGeometrySha256
    !== hashProjectEditRevisionOutputGeometry({
      pixelHeight: document.plan.output.pixelHeight,
      pixelWidth: document.plan.output.pixelWidth,
      revisionSha256: document.revisionSha256,
    })
  ) {
    context.addIssue({
      code: "custom",
      message: "Render plan output geometry is not bound to its immutable revision.",
      path: ["outputGeometrySha256"],
    });
  }
});

export const ProjectRenderPlanReferenceSchema = z.strictObject({
  artifact: ProjectRenderPlanArtifactSchema,
  kind: z.union([
    z.literal("atet.project-render-plan-reference"),
    z.literal("transmute.project-render-plan-reference"),
    z.literal("studio.project-render-plan-reference"),
  ]),
  outputGeometrySha256: Sha256Schema,
  planSha256: Sha256Schema,
  projectEditPlanSha256: Sha256Schema,
  projectId: VideoProjectIdSchema,
  projectSha256: Sha256Schema,
  renderPlanSha256: Sha256Schema,
  revisionSha256: Sha256Schema,
  schemaVersion: z.literal(1),
}).superRefine((reference, context) => {
  if (
    reference.artifact.path
    !== `renders/plans/${reference.artifact.sha256}.json`
  ) {
    context.addIssue({
      code: "custom",
      message: "Render plan artifact path must be addressed by its physical SHA-256.",
      path: ["artifact", "path"],
    });
  }
});

export const ProjectRenderOutputReferenceSchema = z.strictObject({
  bytes: z.number().int().safe().positive(),
  kind: z.union([
    z.literal("atet.project-render-output-reference"),
    z.literal("transmute.project-render-output-reference"),
    z.literal("studio.project-render-output-reference"),
  ]),
  path: ProjectRenderOutputPathSchema,
  planArtifactSha256: Sha256Schema,
  projectId: VideoProjectIdSchema,
  revisionSha256: Sha256Schema,
  schemaVersion: z.literal(1),
  sha256: Sha256Schema,
});

const ProjectRenderReceiptV2BodyBaseSchema = z.strictObject({
  createdAt: z.string().datetime({ offset: true }),
  inputSha256: Sha256Schema,
  invocation: ProjectRenderInvocationSchema,
  invocationSha256: Sha256Schema,
  kind: z.union([
    z.literal("atet.project-render-receipt"),
    z.literal("transmute.project-render-receipt"),
    z.literal("studio.project-render-receipt"),
  ]),
  output: ProjectRenderOutputReferenceSchema,
  plan: ProjectRenderPlanReferenceSchema,
  projectId: VideoProjectIdSchema,
  revisionSha256: Sha256Schema,
  run: z.strictObject({
    nodeKey: z.string()
      .min(1)
      .max(255)
      .regex(/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*(?:\/[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*)*$/u),
    nodePlanSha256: Sha256Schema,
    runId: z.string().regex(/^run_[a-z0-9][a-z0-9_-]{5,95}$/u),
  }),
  schemaVersion: z.literal(2),
  syncPolicy: ProjectRenderSyncPolicySchema,
  toolchain: ProjectRenderToolchainSchema,
});

function validateProjectRenderReceiptBody(
  receipt: z.infer<typeof ProjectRenderReceiptV2BodyBaseSchema>,
  context: z.RefinementCtx,
): void {
  if (
    canonicalJsonSha256(receipt.invocation) !== receipt.invocationSha256
    || receipt.invocation.renderPlanSha256 !== receipt.plan.renderPlanSha256
  ) {
    context.addIssue({
      code: "custom",
      message: "Render receipt invocation is not bound to its exact plan.",
      path: ["invocationSha256"],
    });
  }
  if (
    receipt.output.projectId !== receipt.projectId
    || receipt.plan.projectId !== receipt.projectId
    || receipt.output.revisionSha256 !== receipt.revisionSha256
    || receipt.plan.revisionSha256 !== receipt.revisionSha256
    || receipt.output.planArtifactSha256 !== receipt.plan.artifact.sha256
  ) {
    context.addIssue({
      code: "custom",
      message: "Render receipt project, revision, plan, and output identities disagree.",
    });
  }
}

const ProjectRenderReceiptV2BodySchema =
  ProjectRenderReceiptV2BodyBaseSchema.superRefine(
    validateProjectRenderReceiptBody,
  );

function projectRenderReceiptDomainHash(
  body: z.infer<typeof ProjectRenderReceiptV2BodySchema>,
): string {
  return canonicalJsonSha256({
    domain: "studio.project-render-receipt/v2",
    ...body,
  });
}

export const ProjectRenderReceiptV2Schema =
  ProjectRenderReceiptV2BodyBaseSchema.extend({
    receiptSha256: Sha256Schema,
  }).strict().superRefine((receipt, context) => {
    validateProjectRenderReceiptBody(receipt, context);
    const body = ProjectRenderReceiptV2BodySchema.parse({
      createdAt: receipt.createdAt,
      inputSha256: receipt.inputSha256,
      invocation: receipt.invocation,
      invocationSha256: receipt.invocationSha256,
      kind: receipt.kind,
      output: receipt.output,
      plan: receipt.plan,
      projectId: receipt.projectId,
      revisionSha256: receipt.revisionSha256,
      run: receipt.run,
      schemaVersion: receipt.schemaVersion,
      syncPolicy: receipt.syncPolicy,
      toolchain: receipt.toolchain,
    });
    if (
      projectRenderReceiptDomainHash(body) !== receipt.receiptSha256
    ) {
      context.addIssue({
        code: "custom",
        message: "Render receipt domain hash does not match its exact execution.",
        path: ["receiptSha256"],
      });
    }
  });

export function createProjectRenderReceiptV2(input: {
  readonly createdAt: string;
  readonly inputSha256: string;
  readonly invocation: ProjectRenderInvocation;
  readonly output: z.infer<typeof ProjectRenderOutputReferenceSchema>;
  readonly plan: z.infer<typeof ProjectRenderPlanReferenceSchema>;
  readonly run: {
    readonly nodeKey: string;
    readonly nodePlanSha256: string;
    readonly runId: string;
  };
  readonly syncPolicy: ProjectRenderSyncPolicy;
  readonly toolchain: ProjectRenderToolchain;
}): z.infer<typeof ProjectRenderReceiptV2Schema> {
  const body = ProjectRenderReceiptV2BodySchema.parse({
    ...input,
    invocationSha256: canonicalJsonSha256(input.invocation),
    kind: "atet.project-render-receipt",
    projectId: input.plan.projectId,
    revisionSha256: input.plan.revisionSha256,
    schemaVersion: 2,
  });
  return ProjectRenderReceiptV2Schema.parse({
    ...body,
    receiptSha256: projectRenderReceiptDomainHash(body),
  });
}

export const ProjectRenderReceiptReferenceSchema = z.strictObject({
  bytes: z.number().int().safe().positive().max(256 * 1024 * 1024),
  kind: z.union([
    z.literal("atet.project-render-receipt-reference"),
    z.literal("transmute.project-render-receipt-reference"),
    z.literal("studio.project-render-receipt-reference"),
  ]),
  nodePlanSha256: Sha256Schema,
  outputSha256: Sha256Schema,
  path: RepositoryRelativePathSchema,
  projectId: VideoProjectIdSchema,
  receiptSha256: Sha256Schema,
  revisionSha256: Sha256Schema,
  schemaVersion: z.literal(2),
  sha256: Sha256Schema,
}).superRefine((reference, context) => {
  if (
    reference.path
    !== `renders/receipts/${reference.nodePlanSha256}.json`
  ) {
    context.addIssue({
      code: "custom",
      message: "Render receipt path must be bound to its exact node plan.",
      path: ["path"],
    });
  }
});

export type ProjectEditRevisionDocument = z.infer<typeof ProjectEditRevisionDocumentSchema>;
export type RenderableProjectEditRevisionReference = z.infer<
  typeof RenderableProjectEditRevisionReferenceSchema
>;
export type ProjectEditRevisionRenderInput = z.infer<
  typeof ProjectEditRevisionRenderInputSchema
>;
export type ProjectRenderPlanDocument = z.infer<typeof ProjectRenderPlanDocumentSchema>;
export type ProjectRenderPlanReference = z.infer<typeof ProjectRenderPlanReferenceSchema>;
export type ProjectRenderOutputReference = z.infer<typeof ProjectRenderOutputReferenceSchema>;
export type ProjectRenderReceiptReference = z.infer<typeof ProjectRenderReceiptReferenceSchema>;
