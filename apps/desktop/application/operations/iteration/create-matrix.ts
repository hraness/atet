import { z } from "zod";

import {
  createVariantMatrixV1,
  CreativeCandidateReferenceV1Schema,
  variantMatrixPath,
  variantMatrixReferenceV1,
  VariantMatrixReferenceV1Schema,
  VariantMatrixV1Schema,
} from "../../creative-iteration";
import { ApplicationError } from "../../errors";
import type { OperationDefinition } from "../../operation";
import { ProjectReferenceSchema, throwIfAborted } from "../shared";
import {
  creativeProjectFileSystem,
  loadCreativeCandidate,
  publishCreativeDocument,
} from "./shared";

export const CreateVariantMatrixInputSchema = z.strictObject({
  candidates: z.array(CreativeCandidateReferenceV1Schema).min(1).max(16),
  project: ProjectReferenceSchema,
}).superRefine((input, context) => {
  if (input.candidates.some(candidate => candidate.base.projectId !== input.project)) {
    context.addIssue({
      code: "custom",
      message: "Variant matrix project must match every candidate base.",
      path: ["project"],
    });
  }
});

export const CreateVariantMatrixOutputSchema = VariantMatrixReferenceV1Schema;

export type CreateVariantMatrixInput = z.infer<
  typeof CreateVariantMatrixInputSchema
>;
export type CreateVariantMatrixOutput = z.infer<
  typeof CreateVariantMatrixOutputSchema
>;

export const createVariantMatrixOperationDefinition = {
  inputSchema: CreateVariantMatrixInputSchema,
  inputSchemaId: "studio.operation.iteration.create-matrix.input/v1",
  kind: "iteration.create-matrix",
  lifecycle: {
    kind: "local-artifact",
    execute: async (context, input) => {
      throwIfAborted(context.abortSignal);
      const first = input.candidates[0]!;
      const fileSystem = await creativeProjectFileSystem(
        context.application,
        input.project,
      );
      for (const candidate of input.candidates) {
        throwIfAborted(context.abortSignal);
        if (
          candidate.base.projectId !== first.base.projectId
          || candidate.base.baseSha256 !== first.base.baseSha256
        ) {
          throw new ApplicationError(
            "conflict",
            "Variant matrix candidates must come from one frozen project base.",
          );
        }
        await loadCreativeCandidate({ fileSystem, reference: candidate });
      }
      const matrix = createVariantMatrixV1({
        base: first.base,
        candidates: input.candidates,
      });
      throwIfAborted(context.abortSignal);
      await context.workflow?.beforePublication();
      throwIfAborted(context.abortSignal);
      const artifact = await publishCreativeDocument({
        document: matrix,
        fileSystem,
        path: variantMatrixPath({
          baseSha256: matrix.base.baseSha256,
          matrixSha256: matrix.matrixSha256,
        }),
        schema: VariantMatrixV1Schema,
      });
      return variantMatrixReferenceV1({ artifact, matrix });
    },
  },
  outputSchema: CreateVariantMatrixOutputSchema,
  outputSchemaId: "studio.operation.iteration.create-matrix.output/v1",
  policy: {
    cache: "content-addressed",
    cancellable: true,
    effect: "local-derived-write",
    maxDurationMs: 30_000,
    maxFanOut: 0,
    maxInputBytes: 256 * 1024,
    maxOutputBytes: 16 * 1024,
    preparation: [],
    resources: [
      { amount: 1, resource: "cpu" },
      { amount: 1, resource: "local-io" },
    ],
    resume: "deterministic",
  },
  summarize: output => ({
    fields: {
      candidateCount: output.candidateCount,
      candidateSetSha256: output.candidateSetSha256,
      matrixSha256: output.matrixSha256,
    },
    kind: "iteration.create-matrix",
  }),
  version: 1,
} satisfies OperationDefinition<
  "iteration.create-matrix",
  CreateVariantMatrixInput,
  CreateVariantMatrixOutput
>;
