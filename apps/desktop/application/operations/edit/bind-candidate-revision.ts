import { z } from "zod";

import {
  Yuv420pDimensionSchema,
} from "../../../contracts";
import {
  hashProjectEditRevisionOutputGeometry,
  RenderableProjectEditRevisionReferenceSchema,
} from "../../receipts";
import {
  CreativeCandidateRevisionReferenceV1Schema,
} from "../../creative-iteration";
import type { OperationDefinition } from "../../operation";
import { throwIfAborted } from "../shared";

export const BindCandidateRevisionInputSchema = z.strictObject({
  pixelHeight: Yuv420pDimensionSchema,
  pixelWidth: Yuv420pDimensionSchema,
  revision: CreativeCandidateRevisionReferenceV1Schema,
});

export const BindCandidateRevisionOutputSchema = z.strictObject({
  revision: RenderableProjectEditRevisionReferenceSchema,
});

export type BindCandidateRevisionInput = z.infer<
  typeof BindCandidateRevisionInputSchema
>;
export type BindCandidateRevisionOutput = z.infer<
  typeof BindCandidateRevisionOutputSchema
>;

export const bindCandidateRevisionOperationDefinition = {
  inputSchema: BindCandidateRevisionInputSchema,
  inputSchemaId: "studio.operation.edit.bind-candidate-revision.input/v1",
  kind: "edit.bind-candidate-revision",
  lifecycle: {
    kind: "pure",
    execute: (context, input) => {
      throwIfAborted(context.abortSignal);
      const outputGeometrySha256 = hashProjectEditRevisionOutputGeometry({
        pixelHeight: input.pixelHeight,
        pixelWidth: input.pixelWidth,
        revisionSha256: input.revision.revisionSha256,
      });
      return Promise.resolve(BindCandidateRevisionOutputSchema.parse({
        revision: {
          artifact: input.revision.artifact,
          baseGeneration: input.revision.base.generation,
          kind: "atet.project-edit-revision-reference",
          outputGeometrySha256,
          pixelHeight: input.pixelHeight,
          pixelWidth: input.pixelWidth,
          planId: input.revision.planId,
          projectEditPlanSha256: input.revision.projectEditPlanSha256,
          projectId: input.revision.projectId,
          projectSha256: input.revision.projectSha256,
          projectStructureSha256: input.revision.projectStructureSha256,
          revisionSha256: input.revision.revisionSha256,
          schemaVersion: 1,
        },
      }));
    },
  },
  outputSchema: BindCandidateRevisionOutputSchema,
  outputSchemaId: "studio.operation.edit.bind-candidate-revision.output/v1",
  policy: {
    cache: "content-addressed",
    cancellable: true,
    effect: "pure",
    maxDurationMs: 5_000,
    maxFanOut: 0,
    maxInputBytes: 32 * 1024,
    maxOutputBytes: 32 * 1024,
    preparation: [],
    resources: [{ amount: 1, resource: "cpu" }],
    resume: "deterministic",
  },
  summarize: output => ({
    fields: {
      outputGeometrySha256: output.revision.outputGeometrySha256,
      revisionSha256: output.revision.revisionSha256,
    },
    kind: "edit.bind-candidate-revision",
  }),
  version: 1,
} satisfies OperationDefinition<
  "edit.bind-candidate-revision",
  BindCandidateRevisionInput,
  BindCandidateRevisionOutput
>;
