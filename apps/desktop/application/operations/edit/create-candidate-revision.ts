import { z } from "zod";

import {
  canonicalJson,
  canonicalJsonSha256,
  hashProjectEditPlan,
  hashProjectStructure,
  saveProjectEditRevision,
  sha256Hex,
} from "../../../core";
import {
  CandidateRevisionHostBindingsV1Schema,
  CandidateProjectEditBatchV3Schema,
  canonicalCandidateRevisionHostBindingsV1,
  candidateRevisionDerivationSha256,
  createCreativeBaseV1,
  createCreativeCandidateIdentityV1,
  CreativeBaseV1Schema,
  CreativeCandidateIdentityV1Schema,
  CreativeCandidateRevisionReferenceV1Schema,
  creativeBaseIdentityV1,
  CreativeVariantKeySchema,
} from "../../creative-iteration";
import type { ApplicationContext } from "../../context";
import { ApplicationError } from "../../errors";
import type { OperationDefinition } from "../../operation";
import {
  assertProjectEditBasis,
  openProjectSnapshot,
} from "../../project-store";
import {
  createProjectEditRevisionDocument,
  ProjectEditRevisionDocumentSchema,
} from "../../receipts";
import {
  bindProjectCommitEditsInputV3FromSnapshot,
  deriveProjectEditPlanV3,
  revalidateProjectEditBindingsV3,
} from "../project/commit-edits";
import { ProjectSnapshotOutputSchema } from "../project/snapshot";
import {
  ProjectReferenceSchema,
  throwIfAborted,
} from "../shared";

const MAXIMUM_PROJECT_EDIT_REVISION_BYTES = 256 * 1024 * 1024;

function logicalCandidateRevisionTimestamp(base: z.infer<
  typeof CreativeBaseV1Schema
>): string {
  return Date.parse(base.currentPlan.updatedAt) >= Date.parse(base.project.updatedAt)
    ? base.currentPlan.updatedAt
    : base.project.updatedAt;
}

const CreateCandidateRevisionExactUnboundInputSchema = z.strictObject({
  base: CreativeBaseV1Schema,
  batch: CandidateProjectEditBatchV3Schema,
  bindings: CandidateRevisionHostBindingsV1Schema.optional(),
  candidate: CreativeCandidateIdentityV1Schema,
  project: ProjectReferenceSchema,
  updatedAt: z.string().datetime({ offset: true }).optional(),
}).superRefine((input, context) => {
  if (
    input.project !== input.base.projectId
    || !input.candidate.namespace.startsWith(
      `iterations/${input.base.baseSha256}/`,
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Candidate revision project, base, and namespace disagree.",
    });
  }
  if (
    input.updatedAt !== undefined
    && Date.parse(input.updatedAt) < Date.parse(
      logicalCandidateRevisionTimestamp(input.base),
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Candidate revision time cannot precede its frozen project or edit plan.",
      path: ["updatedAt"],
    });
  }
});

export const CreateCandidateRevisionRequestSchema = z.strictObject({
  batch: CandidateProjectEditBatchV3Schema,
  project: ProjectReferenceSchema,
  snapshot: ProjectSnapshotOutputSchema,
  updatedAt: z.string().datetime({ offset: true }).optional(),
  variantKey: CreativeVariantKeySchema,
}).superRefine((input, context) => {
  if (input.project !== input.snapshot.project.projectId) {
    context.addIssue({
      code: "custom",
      message: "Candidate revision project does not match its frozen snapshot.",
      path: ["project"],
    });
  }
});

export type CreateCandidateRevisionRequest = z.infer<
  typeof CreateCandidateRevisionRequestSchema
>;

const CreateCandidateRevisionUnboundInputSchema = z.union([
  CreateCandidateRevisionRequestSchema,
  CreateCandidateRevisionExactUnboundInputSchema,
]);

export const CreateCandidateRevisionInputSchema =
  CreateCandidateRevisionExactUnboundInputSchema.safeExtend({
    bindings: CandidateRevisionHostBindingsV1Schema,
    updatedAt: z.string().datetime({ offset: true }),
  }).strict();

export const CreateCandidateRevisionOutputSchema =
  CreativeCandidateRevisionReferenceV1Schema;

export type CreateCandidateRevisionInput = z.infer<
  typeof CreateCandidateRevisionInputSchema
>;
export type CreateCandidateRevisionOutput = z.infer<
  typeof CreateCandidateRevisionOutputSchema
>;

/**
 * Resolve every recording-backed V3 edit binding before exact node planning.
 * A supplied binding is accepted only when it equals the host result.
 */
export async function bindCreateCandidateRevisionInput(
  application: ApplicationContext,
  input: unknown,
): Promise<CreateCandidateRevisionInput> {
  const unbound = CreateCandidateRevisionUnboundInputSchema.parse(input);
  const requested = "snapshot" in unbound
    ? (() => {
        const base = createCreativeBaseV1({
          currentPlan: unbound.snapshot.currentPlan,
          project: unbound.snapshot.project,
        });
        if (
          canonicalJson(base.editBasis)
            !== canonicalJson(unbound.snapshot.editBasis)
          || canonicalJson(base.generation)
            !== canonicalJson(unbound.snapshot.generation)
        ) {
          throw new ApplicationError(
            "conflict",
            "Candidate revision snapshot hashes do not match its exact documents.",
          );
        }
        return CreateCandidateRevisionExactUnboundInputSchema.parse({
          base,
          batch: unbound.batch,
          candidate: createCreativeCandidateIdentityV1({
            base,
            variantKey: unbound.variantKey,
          }),
          project: unbound.project,
          updatedAt: unbound.updatedAt,
        });
      })()
    : unbound;
  const updatedAt = requested.updatedAt
    ?? logicalCandidateRevisionTimestamp(requested.base);
  if (
    Date.parse(updatedAt) < Date.parse(
      logicalCandidateRevisionTimestamp(requested.base),
    )
  ) {
    throw new ApplicationError(
      "conflict",
      "Candidate revision time cannot precede its frozen project or edit plan.",
    );
  }
  const snapshot = await openProjectSnapshot(
    application.paths.projectRoot,
    requested.project,
  );
  assertProjectEditBasis(requested.base.editBasis, snapshot);
  const bindings = requested.batch.ordered.length === 0
    ? canonicalCandidateRevisionHostBindingsV1({})
    : await bindProjectCommitEditsInputV3FromSnapshot(
        application,
        {
          batch: requested.batch,
          basis: requested.base.editBasis,
          project: requested.project,
          updatedAt,
        },
        snapshot,
      ).then(boundCommit => canonicalCandidateRevisionHostBindingsV1({
        ...(boundCommit.manualZoomBindings === undefined
          ? {}
          : { manualZoomBindings: boundCommit.manualZoomBindings }),
        ...(boundCommit.metadataBinding === undefined
          ? {}
          : { metadataBinding: boundCommit.metadataBinding }),
      }));
  if (
    requested.bindings !== undefined
    && canonicalJson(requested.bindings) !== canonicalJson(bindings)
  ) {
    throw new ApplicationError(
      "conflict",
      "Candidate revision host bindings changed after exact node planning.",
    );
  }
  return CreateCandidateRevisionInputSchema.parse({
    ...requested,
    bindings,
    updatedAt,
  });
}

export const createCandidateRevisionOperationDefinition = {
  inputSchema: CreateCandidateRevisionInputSchema,
  inputSchemaId: "atet.operation.edit.create-candidate-revision.input/v1",
  kind: "edit.create-candidate-revision",
  lifecycle: {
    kind: "local-artifact",
    execute: async (context, input) => {
      throwIfAborted(context.abortSignal);
      const snapshot = await openProjectSnapshot(
        context.application.paths.projectRoot,
        input.project,
      );
      assertProjectEditBasis(input.base.editBasis, snapshot);
      const nextPlan = await deriveProjectEditPlanV3({
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
      const nextPlanSha256 = hashProjectEditPlan(nextPlan);
      const revision = createProjectEditRevisionDocument(
        input.base.project,
        nextPlan,
      );
      const contents = `${canonicalJson(revision)}\n`;
      const artifactSha256 = sha256Hex(contents);
      const artifactBytes = new TextEncoder().encode(contents).byteLength;
      if (artifactBytes > MAXIMUM_PROJECT_EDIT_REVISION_BYTES) {
        throw new ApplicationError(
          "unsupported-plan",
          "Creative candidate revision exceeds the 256 MiB structured-artifact limit.",
          { artifactBytes },
        );
      }

      await revalidateProjectEditBindingsV3({
        abortSignal: context.abortSignal,
        application: context.application,
        batch: input.batch,
        manualZoomBindings: input.bindings.manualZoomBindings,
        ...(input.bindings.metadataBinding === null
          ? {}
          : { metadataBinding: input.bindings.metadataBinding }),
        project: input.base.project,
      });
      throwIfAborted(context.abortSignal);
      await context.workflow?.beforePublication();
      throwIfAborted(context.abortSignal);
      const publicationSnapshot = await openProjectSnapshot(
        context.application.paths.projectRoot,
        input.project,
      );
      assertProjectEditBasis(input.base.editBasis, publicationSnapshot);
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
          "Published creative candidate revision is not valid JSON.",
        );
      }
      const published = ProjectEditRevisionDocumentSchema.parse(publishedInput);
      if (
        publishedText !== contents
        || sha256Hex(publishedText) !== artifactSha256
        || published.revisionSha256 !== revision.revisionSha256
        || published.projectSha256 !== input.base.generation.projectSha256
        || published.projectEditPlanSha256 !== nextPlanSha256
      ) {
        throw new ApplicationError(
          "conflict",
          "Published creative candidate revision failed immutable verification.",
        );
      }
      const finalSnapshot = await openProjectSnapshot(
        context.application.paths.projectRoot,
        input.project,
      );
      assertProjectEditBasis(input.base.editBasis, finalSnapshot);
      const bindingsSha256 = canonicalJsonSha256(input.bindings);
      const derivationSha256 = candidateRevisionDerivationSha256({
        baseSha256: input.base.baseSha256,
        batch: input.batch,
        bindings: input.bindings,
        candidate: input.candidate,
        projectEditPlanSha256: revision.projectEditPlanSha256,
        revisionSha256: revision.revisionSha256,
        updatedAt: input.updatedAt,
      });
      return CreateCandidateRevisionOutputSchema.parse({
        artifact: {
          bytes: artifactBytes,
          path,
          sha256: artifactSha256,
        },
        base: creativeBaseIdentityV1(input.base),
        batchSha256: input.batch.sha256,
        bindingsSha256,
        candidate: input.candidate,
        derivationSha256,
        kind: "atet.creative-candidate-revision-reference",
        planId: nextPlan.planId,
        projectEditPlanSha256: revision.projectEditPlanSha256,
        projectId: input.base.projectId,
        projectSha256: revision.projectSha256,
        projectStructureSha256: hashProjectStructure(input.base.project),
        revisionSha256: revision.revisionSha256,
        schemaVersion: 1,
        updatedAt: input.updatedAt,
      });
    },
  },
  outputSchema: CreateCandidateRevisionOutputSchema,
  outputSchemaId: "atet.operation.edit.create-candidate-revision.output/v1",
  policy: {
    cache: "content-addressed",
    cancellable: true,
    effect: "local-derived-write",
    maxDurationMs: 90_000,
    maxFanOut: 0,
    maxInputBytes: 128 * 1024 * 1024,
    maxOutputBytes: 16 * 1024,
    preparation: ["project-state", "recording-metadata"],
    resources: [
      { amount: 1, resource: "cpu" },
      { amount: 1, resource: "local-io" },
    ],
    resume: "deterministic",
  },
  summarize: output => ({
    fields: {
      candidateId: output.candidate.candidateId,
      derivationSha256: output.derivationSha256,
      projectId: output.projectId,
      revisionSha256: output.revisionSha256,
    },
    kind: "edit.create-candidate-revision",
  }),
  version: 1,
} satisfies OperationDefinition<
  "edit.create-candidate-revision",
  CreateCandidateRevisionInput,
  CreateCandidateRevisionOutput
>;
