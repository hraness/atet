import { z } from "zod";

import {
  canonicalJson,
  canonicalJsonSha256,
  assertProjectCameraMoveBindings,
  hashProjectEditPlan,
  hashProjectStructure,
  normalizeProjectEditPlan,
  saveProjectEditRevision,
  sha256Hex,
} from "../../../core";
import { ApplicationError } from "../../errors";
import type { OperationDefinition } from "../../operation";
import {
  assertProjectGeneration,
  openProjectSnapshot,
} from "../../project-store";
import {
  createProjectEditRevisionDocument,
  hashProjectEditRevisionOutputGeometry,
  ProjectEditRevisionDocumentSchema,
  ProjectEditRevisionReferenceSchema,
} from "../../receipts";
import {
  FaceFollowRevisionDraftSchema,
} from "../derive/follow-faces";
import {
  ProjectReferenceSchema,
  throwIfAborted,
} from "../shared";

const MAXIMUM_PROJECT_EDIT_REVISION_BYTES = 256 * 1024 * 1024;

export const CreateProjectEditRevisionInputSchema = z.strictObject({
  draft: FaceFollowRevisionDraftSchema,
  project: ProjectReferenceSchema,
});

export type CreateProjectEditRevisionInput = z.infer<
  typeof CreateProjectEditRevisionInputSchema
>;
export type CreateProjectEditRevisionOutput = z.infer<
  typeof ProjectEditRevisionReferenceSchema
>;

function assertDraftMatchesSnapshot(
  snapshot: Awaited<ReturnType<typeof openProjectSnapshot>>,
  draft: z.infer<typeof FaceFollowRevisionDraftSchema>,
): void {
  assertProjectGeneration(
    draft.provenance.baseGeneration.generationSha256,
    snapshot.generation,
  );
  const structureSha256 = hashProjectStructure(snapshot.project);
  if (
    draft.provenance.projectId !== snapshot.project.projectId
    || draft.provenance.projectStructureSha256 !== structureSha256
    || snapshot.plan.projectStructureSha256 !== structureSha256
    || draft.provenance.basePlanId !== snapshot.plan.planId
  ) {
    throw new ApplicationError(
      "conflict",
      "Face-follow draft does not match the current project structure and base plan.",
    );
  }
  const reference = snapshot.project.analyses.find(
    candidate => candidate.analysisId === draft.provenance.analysisId,
  );
  if (
    reference?.kind !== "faces"
    || reference.sha256 !== draft.provenance.analysisSha256
    || reference.subjectIntegritySha256
      !== draft.provenance.subjectIntegritySha256
  ) {
    throw new ApplicationError(
      "conflict",
      "Face-follow draft analysis provenance is not current.",
    );
  }
  if (
    snapshot.plan.cameraMoves.some(
      move => move.cameraMoveId === draft.cameraMove.cameraMoveId,
    )
  ) {
    throw new ApplicationError(
      "conflict",
      "Face-follow draft camera move already exists in the base plan.",
    );
  }
  assertProjectCameraMoveBindings(snapshot.project, draft.cameraMove);
  const expectedPlan = normalizeProjectEditPlan({
    ...snapshot.plan,
    cameraMoves: [...snapshot.plan.cameraMoves, draft.cameraMove],
    planId: draft.plan.planId,
  });
  if (
    hashProjectEditPlan(expectedPlan) !== draft.planSha256
    || canonicalJsonSha256(expectedPlan) !== canonicalJsonSha256(draft.plan)
  ) {
    throw new ApplicationError(
      "conflict",
      "Face-follow draft contains changes outside its reviewed camera move.",
    );
  }
}

export const createProjectEditRevisionOperationDefinition = {
  inputSchema: CreateProjectEditRevisionInputSchema,
  inputSchemaId: "atet.operation.edit.create-revision.input/v1",
  kind: "edit.create-revision",
  lifecycle: {
    kind: "local-artifact",
    execute: async (context, input) => {
      throwIfAborted(context.abortSignal);
      const snapshot = await openProjectSnapshot(
        context.application.paths.projectRoot,
        input.project,
      );
      assertProjectGeneration(
        context.expectedProjectGeneration,
        snapshot.generation,
      );
      assertDraftMatchesSnapshot(snapshot, input.draft);
      throwIfAborted(context.abortSignal);

      // Recheck the full project/current-plan generation immediately before
      // immutable publication. The caller owns the outer publication lease.
      const publicationSnapshot = await openProjectSnapshot(
        context.application.paths.projectRoot,
        snapshot.project.projectId,
      );
      assertProjectGeneration(
        snapshot.generation.generationSha256,
        publicationSnapshot.generation,
      );
      const revision = createProjectEditRevisionDocument(
        publicationSnapshot.project,
        input.draft.plan,
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
      assertProjectGeneration(
        snapshot.generation.generationSha256,
        finalSnapshot.generation,
      );
      const outputGeometrySha256 = hashProjectEditRevisionOutputGeometry({
        pixelHeight: input.draft.pixelHeight,
        pixelWidth: input.draft.pixelWidth,
        revisionSha256: revision.revisionSha256,
      });
      return ProjectEditRevisionReferenceSchema.parse({
        analysisId: input.draft.provenance.analysisId,
        analysisSha256: input.draft.provenance.analysisSha256,
        artifact: {
          bytes: artifactBytes,
          path,
          sha256: artifactSha256,
        },
        aspect: input.draft.provenance.parameters.aspect,
        baseGeneration: input.draft.provenance.baseGeneration,
        derivationSha256: input.draft.derivationSha256,
        kind: "atet.project-edit-revision-reference",
        outputGeometrySha256,
        pixelHeight: input.draft.pixelHeight,
        pixelWidth: input.draft.pixelWidth,
        planId: input.draft.plan.planId,
        projectEditPlanSha256: revision.projectEditPlanSha256,
        projectId: snapshot.project.projectId,
        projectSha256: revision.projectSha256,
        projectStructureSha256: input.draft.provenance.projectStructureSha256,
        revisionSha256: revision.revisionSha256,
        schemaVersion: 1,
      });
    },
  },
  outputSchema: ProjectEditRevisionReferenceSchema,
  outputSchemaId: "atet.operation.edit.create-revision.output/v1",
  policy: {
    cache: "content-addressed",
    cancellable: true,
    effect: "local-derived-write",
    maxDurationMs: 30_000,
    maxFanOut: 0,
    maxInputBytes: 32 * 1024 * 1024,
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
      aspect: output.aspect,
      artifactSha256: output.artifact.sha256,
      projectEditPlanSha256: output.projectEditPlanSha256,
      projectId: output.projectId,
      revisionSha256: output.revisionSha256,
    },
    kind: "edit.create-revision",
  }),
  version: 1,
} satisfies OperationDefinition<
  "edit.create-revision",
  CreateProjectEditRevisionInput,
  CreateProjectEditRevisionOutput
>;
