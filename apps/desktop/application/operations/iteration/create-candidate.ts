import { z } from "zod";

import {
  canonicalJson,
  canonicalJsonSha256,
  hashProjectEditPlan,
} from "../../../core";
import {
  CandidateProjectEditBatchV3Schema,
  CandidateRevisionHostBindingsV1Schema,
  createCreativeCandidateV1,
  CreativeBaseV1Schema,
  CreativeCandidateIdentityV1Schema,
  CreativeCandidateReferenceV1Schema,
  CreativeCandidateRenderV1Schema,
  CreativeCandidateRevisionReferenceV1Schema,
  CreativeCandidateV1Schema,
  creativeBaseIdentityV1,
  creativeCandidatePath,
  creativeCandidateReferenceV1,
  CreativeVariantKeySchema,
} from "../../creative-iteration";
import type { ApplicationContext } from "../../context";
import { ApplicationError } from "../../errors";
import type { OperationDefinition } from "../../operation";
import { ProjectSnapshotOutputSchema } from "../project/snapshot";
import { ProjectReferenceSchema, throwIfAborted } from "../shared";
import {
  bindCreateCandidateRevisionInput,
} from "../edit/create-candidate-revision";
import { deriveProjectEditPlanV3 } from "../project/commit-edits";
import {
  creativeProjectFileSystem,
  loadCreativeDocument,
  publishCreativeDocument,
  verifyCandidateRender,
} from "./shared";
import { ProjectEditRevisionDocumentSchema } from "../../receipts";

export const CreateCreativeCandidateRequestSchema = z.strictObject({
  batch: CandidateProjectEditBatchV3Schema,
  project: ProjectReferenceSchema,
  renders: z.array(CreativeCandidateRenderV1Schema).max(16),
  revision: CreativeCandidateRevisionReferenceV1Schema,
  snapshot: ProjectSnapshotOutputSchema,
  variantKey: CreativeVariantKeySchema,
});

export const CreateCreativeCandidateInputSchema = z.strictObject({
  base: CreativeBaseV1Schema,
  batch: CandidateProjectEditBatchV3Schema,
  bindings: CandidateRevisionHostBindingsV1Schema,
  candidate: CreativeCandidateIdentityV1Schema,
  project: ProjectReferenceSchema,
  renders: z.array(CreativeCandidateRenderV1Schema).max(16),
  revision: CreativeCandidateRevisionReferenceV1Schema,
  updatedAt: z.string().datetime({ offset: true }),
}).superRefine((input, context) => {
  if (
    input.project !== input.base.projectId
    || input.project !== input.revision.projectId
  ) {
    context.addIssue({
      code: "custom",
      message: "Creative candidate project, base, and revision disagree.",
      path: ["project"],
    });
  }
});

export const CreateCreativeCandidateOutputSchema =
  CreativeCandidateReferenceV1Schema;

export type CreateCreativeCandidateRequest = z.infer<
  typeof CreateCreativeCandidateRequestSchema
>;
export type CreateCreativeCandidateInput = z.infer<
  typeof CreateCreativeCandidateInputSchema
>;
export type CreateCreativeCandidateOutput = z.infer<
  typeof CreateCreativeCandidateOutputSchema
>;

export async function bindCreateCreativeCandidateInput(
  application: ApplicationContext,
  input: unknown,
): Promise<CreateCreativeCandidateInput> {
  const exact = CreateCreativeCandidateInputSchema.safeParse(input);
  if (exact.success) return exact.data;
  const request = CreateCreativeCandidateRequestSchema.parse(input);
  if (request.project !== request.snapshot.project.projectId) {
    throw new ApplicationError(
      "conflict",
      "Creative candidate project does not match its snapshot.",
    );
  }
  const boundRevision = await bindCreateCandidateRevisionInput(application, {
    batch: request.batch,
    project: request.project,
    snapshot: request.snapshot,
    updatedAt: request.revision.updatedAt,
    variantKey: request.variantKey,
  });
  if (
    canonicalJson(boundRevision.candidate)
      !== canonicalJson(request.revision.candidate)
    || canonicalJson(creativeBaseIdentityV1(boundRevision.base))
      !== canonicalJson(request.revision.base)
    || boundRevision.batch.sha256 !== request.revision.batchSha256
    || canonicalJsonSha256(boundRevision.bindings)
      !== request.revision.bindingsSha256
  ) {
    throw new ApplicationError(
      "conflict",
      "Creative candidate request does not reproduce its exact candidate revision.",
    );
  }
  return CreateCreativeCandidateInputSchema.parse({
    base: boundRevision.base,
    batch: boundRevision.batch,
    bindings: boundRevision.bindings,
    candidate: boundRevision.candidate,
    project: request.project,
    renders: request.renders,
    revision: request.revision,
    updatedAt: boundRevision.updatedAt,
  });
}

export const createCreativeCandidateOperationDefinition = {
  inputSchema: CreateCreativeCandidateInputSchema,
  inputSchemaId: "atet.operation.iteration.create-candidate.input/v1",
  kind: "iteration.create-candidate",
  lifecycle: {
    kind: "local-artifact",
    execute: async (context, input) => {
      throwIfAborted(context.abortSignal);
      const fileSystem = await creativeProjectFileSystem(
        context.application,
        input.project,
      );
      const revision = await loadCreativeDocument({
        artifact: input.revision.artifact,
        fileSystem,
        label: "Creative candidate revision",
        schema: ProjectEditRevisionDocumentSchema,
      });
      if (
        revision.revisionSha256 !== input.revision.revisionSha256
        || revision.projectEditPlanSha256
          !== input.revision.projectEditPlanSha256
        || revision.projectSha256 !== input.base.generation.projectSha256
      ) {
        throw new ApplicationError(
          "conflict",
          "Creative candidate revision does not match its frozen base and reference.",
        );
      }
      const expectedPlan = await deriveProjectEditPlanV3({
        abortSignal: context.abortSignal,
        application: context.application,
        batch: input.batch,
        manualZoomBindings: input.bindings.manualZoomBindings,
        ...(input.bindings.metadataBinding === null
          ? {}
          : { metadataBinding: input.bindings.metadataBinding }),
        plan: input.base.currentPlan,
        project: input.base.project,
        updatedAt: input.updatedAt,
      });
      if (
        hashProjectEditPlan(expectedPlan) !== revision.projectEditPlanSha256
        || canonicalJson(expectedPlan) !== canonicalJson(revision.projectEditPlan)
      ) {
        throw new ApplicationError(
          "conflict",
          "Creative candidate revision was not derived by its declared V3 batch and bindings.",
        );
      }
      const candidate = createCreativeCandidateV1({
        base: input.base,
        batch: input.batch,
        bindings: input.bindings,
        candidate: input.candidate,
        renders: input.renders,
        revision: input.revision,
        updatedAt: input.updatedAt,
      });
      for (const render of candidate.renders) {
        throwIfAborted(context.abortSignal);
        await verifyCandidateRender({ candidate, fileSystem, render });
      }
      throwIfAborted(context.abortSignal);
      await context.workflow?.beforePublication();
      throwIfAborted(context.abortSignal);
      const path = creativeCandidatePath({
        baseSha256: candidate.base.baseSha256,
        candidateId: candidate.candidate.candidateId,
        candidateSha256: candidate.candidateSha256,
      });
      const artifact = await publishCreativeDocument({
        document: candidate,
        fileSystem,
        path,
        schema: CreativeCandidateV1Schema,
      });
      return creativeCandidateReferenceV1({ artifact, candidate });
    },
  },
  outputSchema: CreateCreativeCandidateOutputSchema,
  outputSchemaId: "atet.operation.iteration.create-candidate.output/v1",
  policy: {
    cache: "content-addressed",
    cancellable: true,
    effect: "local-derived-write",
    maxDurationMs: 30_000,
    maxFanOut: 0,
    maxInputBytes: 128 * 1024 * 1024,
    maxOutputBytes: 16 * 1024,
    preparation: ["project-state", "local-media"],
    resources: [
      { amount: 1, resource: "cpu" },
      { amount: 1, resource: "local-io" },
    ],
    resume: "deterministic",
  },
  summarize: output => ({
    fields: {
      candidateId: output.candidate.candidateId,
      candidateSha256: output.candidateSha256,
      revisionSha256: output.revisionSha256,
    },
    kind: "iteration.create-candidate",
  }),
  version: 1,
} satisfies OperationDefinition<
  "iteration.create-candidate",
  CreateCreativeCandidateInput,
  CreateCreativeCandidateOutput
>;
