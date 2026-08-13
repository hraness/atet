import { z } from "zod";

import {
  Yuv420pDimensionSchema,
} from "../../../contracts";
import {
  canonicalJson,
  canonicalJsonSha256,
  hashProjectStructure,
  saveProjectEditRevision,
  sha256Hex,
} from "../../../core";
import { ApplicationError } from "../../errors";
import type { OperationDefinition } from "../../operation";
import {
  assertProjectEditBasis,
  openProjectSnapshot,
  ProjectEditBasisSchema,
} from "../../project-store";
import {
  createProjectEditRevisionDocument,
  hashProjectEditRevisionOutputGeometry,
  ProjectEditRevisionDocumentSchema,
  RenderableProjectEditRevisionReferenceSchema,
} from "../../receipts";
import {
  ProjectReferenceSchema,
  throwIfAborted,
} from "../shared";

const MAXIMUM_PROJECT_EDIT_REVISION_BYTES = 256 * 1024 * 1024;

export const FreezeProjectEditRevisionInputSchema = z.strictObject({
  basis: ProjectEditBasisSchema,
  pixelHeight: Yuv420pDimensionSchema,
  pixelWidth: Yuv420pDimensionSchema,
  project: ProjectReferenceSchema,
});

export const FreezeProjectEditRevisionOutputSchema =
  RenderableProjectEditRevisionReferenceSchema;

export type FreezeProjectEditRevisionInput = z.infer<
  typeof FreezeProjectEditRevisionInputSchema
>;
export type FreezeProjectEditRevisionOutput = z.infer<
  typeof FreezeProjectEditRevisionOutputSchema
>;

export const freezeProjectEditRevisionOperationDefinition = {
  inputSchema: FreezeProjectEditRevisionInputSchema,
  inputSchemaId: "studio.operation.edit.freeze-revision.input/v1",
  kind: "edit.freeze-revision",
  lifecycle: {
    kind: "local-artifact",
    execute: async (context, input) => {
      throwIfAborted(context.abortSignal);
      const snapshot = await openProjectSnapshot(
        context.application.paths.projectRoot,
        input.project,
      );
      assertProjectEditBasis(input.basis, snapshot);

      const publicationSnapshot = await openProjectSnapshot(
        context.application.paths.projectRoot,
        snapshot.project.projectId,
      );
      assertProjectEditBasis(input.basis, publicationSnapshot);
      const revision = createProjectEditRevisionDocument(
        publicationSnapshot.project,
        publicationSnapshot.plan,
      );
      const contents = `${canonicalJson(revision)}\n`;
      const artifactSha256 = sha256Hex(contents);
      const artifactBytes = new TextEncoder().encode(contents).byteLength;
      if (artifactBytes > MAXIMUM_PROJECT_EDIT_REVISION_BYTES) {
        throw new ApplicationError(
          "unsupported-plan",
          "Frozen project edit revision exceeds the 256 MiB structured-artifact limit.",
          { artifactBytes },
        );
      }
      throwIfAborted(context.abortSignal);
      await context.workflow?.beforePublication();
      const path = await saveProjectEditRevision(
        publicationSnapshot.openProject.fileSystem,
        contents,
        artifactSha256,
      );

      const publishedText = await publicationSnapshot.openProject.fileSystem
        .readText(path);
      let publishedInput: unknown;
      try {
        publishedInput = JSON.parse(publishedText) as unknown;
      } catch {
        throw new ApplicationError(
          "conflict",
          "Published project edit revision is not valid JSON.",
        );
      }
      const published = ProjectEditRevisionDocumentSchema.parse(publishedInput);
      if (
        publishedText !== contents
        || sha256Hex(publishedText) !== artifactSha256
        || canonicalJsonSha256(published.project) !== revision.projectSha256
        || canonicalJsonSha256(published.projectEditPlan)
          !== revision.projectEditPlanSha256
        || published.revisionSha256 !== revision.revisionSha256
      ) {
        throw new ApplicationError(
          "conflict",
          "Published project edit revision failed content-addressed verification.",
        );
      }
      const finalSnapshot = await openProjectSnapshot(
        context.application.paths.projectRoot,
        snapshot.project.projectId,
      );
      assertProjectEditBasis(input.basis, finalSnapshot);
      const outputGeometrySha256 =
        hashProjectEditRevisionOutputGeometry({
          pixelHeight: input.pixelHeight,
          pixelWidth: input.pixelWidth,
          revisionSha256: revision.revisionSha256,
        });
      return FreezeProjectEditRevisionOutputSchema.parse({
        artifact: {
          bytes: artifactBytes,
          path,
          sha256: artifactSha256,
        },
        baseGeneration: publicationSnapshot.generation,
        kind: "transmute.project-edit-revision-reference",
        outputGeometrySha256,
        pixelHeight: input.pixelHeight,
        pixelWidth: input.pixelWidth,
        planId: publicationSnapshot.plan.planId,
        projectEditPlanSha256: revision.projectEditPlanSha256,
        projectId: publicationSnapshot.project.projectId,
        projectSha256: revision.projectSha256,
        projectStructureSha256: hashProjectStructure(publicationSnapshot.project),
        revisionSha256: revision.revisionSha256,
        schemaVersion: 1,
      });
    },
  },
  outputSchema: FreezeProjectEditRevisionOutputSchema,
  outputSchemaId: "studio.operation.edit.freeze-revision.output/v1",
  policy: {
    cache: "content-addressed",
    cancellable: true,
    effect: "local-derived-write",
    maxDurationMs: 30_000,
    maxFanOut: 0,
    maxInputBytes: 8_192,
    maxOutputBytes: 8_192,
    preparation: ["project-state"],
    resources: [
      { amount: 1, resource: "cpu" },
      { amount: 1, resource: "local-io" },
      { amount: 1, resource: "project-publication" },
    ],
    resume: "deterministic",
  },
  summarize: output => ({
    fields: {
      artifactSha256: output.artifact.sha256,
      outputGeometrySha256: output.outputGeometrySha256,
      pixelHeight: output.pixelHeight,
      pixelWidth: output.pixelWidth,
      projectId: output.projectId,
      revisionSha256: output.revisionSha256,
    },
    kind: "edit.freeze-revision",
  }),
  version: 1,
} satisfies OperationDefinition<
  "edit.freeze-revision",
  FreezeProjectEditRevisionInput,
  FreezeProjectEditRevisionOutput
>;
