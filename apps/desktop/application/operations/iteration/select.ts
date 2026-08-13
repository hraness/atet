import { z } from "zod";

import { canonicalJson } from "../../../core";
import {
  createVariantSelectionV1,
  CreativeVariantKeySchema,
  variantSelectionPath,
  variantSelectionReferenceV1,
  VariantSelectionEvidenceV1Schema,
  VariantSelectionReferenceV1Schema,
  VariantSelectionV1Schema,
  VariantMatrixReferenceV1Schema,
} from "../../creative-iteration";
import { ApplicationError } from "../../errors";
import type { OperationDefinition } from "../../operation";
import { ProjectReferenceSchema, throwIfAborted } from "../shared";
import {
  creativeProjectFileSystem,
  loadCreativeCandidate,
  loadVariantMatrix,
  publishCreativeDocument,
  verifyCandidateRender,
} from "./shared";

export const SelectVariantInputSchema = z.strictObject({
  evidence: VariantSelectionEvidenceV1Schema.optional(),
  matrix: VariantMatrixReferenceV1Schema,
  project: ProjectReferenceSchema,
  variantKey: CreativeVariantKeySchema,
}).superRefine((input, context) => {
  if (input.project !== input.matrix.base.projectId) {
    context.addIssue({
      code: "custom",
      message: "Variant selection project does not match its matrix base.",
      path: ["project"],
    });
  }
});

export const SelectVariantOutputSchema = VariantSelectionReferenceV1Schema;

export type SelectVariantInput = z.infer<typeof SelectVariantInputSchema>;
export type SelectVariantOutput = z.infer<typeof SelectVariantOutputSchema>;

export const selectVariantOperationDefinition = {
  inputSchema: SelectVariantInputSchema,
  inputSchemaId: "studio.operation.iteration.select.input/v1",
  kind: "iteration.select",
  lifecycle: {
    kind: "local-artifact",
    execute: async (context, input) => {
      throwIfAborted(context.abortSignal);
      const fileSystem = await creativeProjectFileSystem(
        context.application,
        input.project,
      );
      const matrix = await loadVariantMatrix({
        fileSystem,
        reference: input.matrix,
      });
      let chosenDocument;
      const chosenReference = matrix.candidates.find(candidate => (
        candidate.candidate.variantKey === input.variantKey
      ));
      if (chosenReference === undefined) {
        throw new ApplicationError(
          "not-found",
          `Variant matrix does not contain variant key: ${input.variantKey}`,
        );
      }
      for (const candidateReference of matrix.candidates) {
        throwIfAborted(context.abortSignal);
        const document = await loadCreativeCandidate({
          fileSystem,
          reference: candidateReference,
        });
        if (
          candidateReference.candidate.candidateId
            === chosenReference.candidate.candidateId
        ) {
          if (canonicalJson(candidateReference) !== canonicalJson(chosenReference)) {
            throw new ApplicationError(
              "conflict",
              "Chosen candidate is not an exact member of the closed matrix.",
            );
          }
          chosenDocument = document;
        }
      }
      if (chosenDocument === undefined) {
        throw new ApplicationError(
          "conflict",
          "Chosen candidate artifact could not be verified from the closed matrix.",
        );
      }
      for (const render of chosenDocument.renders) {
        throwIfAborted(context.abortSignal);
        await verifyCandidateRender({
          candidate: chosenDocument,
          fileSystem,
          render,
        });
      }
      const selection = createVariantSelectionV1({
        candidate: chosenDocument,
        chosen: chosenReference,
        ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
        matrix: input.matrix,
      });
      throwIfAborted(context.abortSignal);
      await context.workflow?.beforePublication();
      throwIfAborted(context.abortSignal);
      const artifact = await publishCreativeDocument({
        document: selection,
        fileSystem,
        path: variantSelectionPath({
          baseSha256: selection.base.baseSha256,
          selectionSha256: selection.selectionSha256,
        }),
        schema: VariantSelectionV1Schema,
      });
      return variantSelectionReferenceV1({ artifact, selection });
    },
  },
  outputSchema: SelectVariantOutputSchema,
  outputSchemaId: "studio.operation.iteration.select.output/v1",
  policy: {
    cache: "content-addressed",
    cancellable: true,
    effect: "local-derived-write",
    maxDurationMs: 30_000,
    maxFanOut: 0,
    maxInputBytes: 32 * 1024,
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
      candidateId: output.chosenCandidateId,
      matrixSha256: output.matrixSha256,
      selectionSha256: output.selectionSha256,
    },
    kind: "iteration.select",
  }),
  version: 1,
} satisfies OperationDefinition<
  "iteration.select",
  SelectVariantInput,
  SelectVariantOutput
>;
