import { z } from "zod";

import {
  ProjectEditPlanV1Schema,
  VideoProjectV1Schema,
  type ProjectEditPlanV1,
  type VideoProjectV1,
} from "../../../contracts";
import type { OperationDefinition } from "../../operation";
import { openLeasedProjectSnapshot } from "../../project-publication-lease";
import {
  assertProjectGeneration,
  ProjectEditBasisSchema,
  ProjectGenerationHashesSchema,
  type ProjectEditBasis,
  type ProjectGenerationHashes,
} from "../../project-store";
import {
  ProjectReferenceSchema,
  throwIfAborted,
} from "../shared";

export const ProjectSnapshotInputSchema = z.strictObject({
  project: ProjectReferenceSchema,
});

export const ProjectSnapshotOutputSchema = z.strictObject({
  currentPlan: ProjectEditPlanV1Schema,
  editBasis: ProjectEditBasisSchema,
  generation: ProjectGenerationHashesSchema,
  project: VideoProjectV1Schema,
});

export type ProjectSnapshotInput = z.infer<typeof ProjectSnapshotInputSchema>;
export interface ProjectSnapshotOutput {
  readonly currentPlan: ProjectEditPlanV1;
  readonly editBasis: ProjectEditBasis;
  readonly generation: ProjectGenerationHashes;
  readonly project: VideoProjectV1;
}

export const projectSnapshotOperationDefinition: OperationDefinition<
  "project.snapshot",
  ProjectSnapshotInput,
  ProjectSnapshotOutput
> = {
  inputSchema: ProjectSnapshotInputSchema,
  inputSchemaId: "atet.operation.project.snapshot.input/v1",
  kind: "project.snapshot",
  lifecycle: {
    kind: "local-artifact",
    execute: async (context, input) => {
      throwIfAborted(context.abortSignal);
      const snapshot = await openLeasedProjectSnapshot(
        context.application,
        input.project,
      );
      assertProjectGeneration(
        context.expectedProjectGeneration,
        snapshot.generation,
      );
      throwIfAborted(context.abortSignal);
      return {
        currentPlan: snapshot.plan,
        editBasis: snapshot.editBasis,
        generation: snapshot.generation,
        project: snapshot.project,
      };
    },
  },
  outputSchema: ProjectSnapshotOutputSchema,
  outputSchemaId: "atet.operation.project.snapshot.output/v1",
  policy: {
    cache: "none",
    cancellable: true,
    effect: "local-read",
    maxDurationMs: 30_000,
    maxFanOut: 0,
    maxInputBytes: 1_024,
    maxOutputBytes: 64 * 1024 * 1024,
    preparation: ["project-state"],
    resources: [{ amount: 1, resource: "local-io" }],
    resume: "deterministic",
  },
  summarize: output => ({
    fields: {
      currentPlanSha256: output.generation.currentPlanSha256,
      generationSha256: output.generation.generationSha256,
      projectId: output.project.projectId,
      projectSha256: output.generation.projectSha256,
    },
    kind: "project.snapshot",
  }),
  version: 1,
};
