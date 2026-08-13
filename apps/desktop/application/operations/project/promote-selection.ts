import { z } from "zod";

import {
  canonicalJson,
  canonicalJsonSha256,
  hashProjectEditPlan,
  loadProjectEditPlan,
  loadVideoProject,
  sha256Hex,
} from "../../../core";
import {
  commitProjectStateTransaction,
  loadProjectStateTransactionSettlement,
} from "../../../cli/project-state-transaction";
import {
  createEditorialPromotionReceiptV1,
  EditorialPromotionReceiptReferenceV1Schema,
  EditorialPromotionReceiptV1Schema,
  editorialPromotionReceiptPath,
  editorialPromotionReceiptReferenceV1,
  type EditorialPromotionReceiptReferenceV1,
  type EditorialPromotionReceiptV1,
} from "../../creative-iteration";
import type { ApplicationContext } from "../../context";
import { ApplicationError } from "../../errors";
import type {
  OperationDefinition,
  OperationExecutionContext,
} from "../../operation";
import {
  assertProjectEditBasis,
  openProjectSnapshot,
  projectEditBasis,
  projectMatchesEditBasis,
  type OpenProjectSnapshot,
} from "../../project-store";
import { ProjectReferenceSchema, throwIfAborted } from "../shared";
import {
  loadCandidateRevision,
  loadCreativeCandidate,
  loadVariantMatrix,
  loadVariantSelection,
  publishCreativeDocument,
} from "../iteration/shared";
import {
  VariantSelectionReferenceV1Schema,
} from "../../creative-iteration";

export const PromoteVariantSelectionRequestSchema = z.strictObject({
  selection: VariantSelectionReferenceV1Schema,
});

export const PromoteVariantSelectionInputSchema = z.strictObject({
  project: ProjectReferenceSchema,
  selection: VariantSelectionReferenceV1Schema,
}).superRefine((input, context) => {
  if (input.project !== input.selection.base.projectId) {
    context.addIssue({
      code: "custom",
      message: "Editorial promotion project does not match its selection base.",
      path: ["project"],
    });
  }
});

export const PromoteVariantSelectionOutputSchema =
  EditorialPromotionReceiptReferenceV1Schema;

export type PromoteVariantSelectionRequest = z.infer<
  typeof PromoteVariantSelectionRequestSchema
>;
export type PromoteVariantSelectionInput = z.infer<
  typeof PromoteVariantSelectionInputSchema
>;
export type PromoteVariantSelectionOutput = z.infer<
  typeof PromoteVariantSelectionOutputSchema
>;

export function bindPromoteVariantSelectionInput(
  _application: ApplicationContext,
  input: unknown,
): PromoteVariantSelectionInput {
  const exact = PromoteVariantSelectionInputSchema.safeParse(input);
  if (exact.success) return exact.data;
  const request = PromoteVariantSelectionRequestSchema.parse(input);
  return PromoteVariantSelectionInputSchema.parse({
    project: request.selection.base.projectId,
    selection: request.selection,
  });
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function loadExistingPromotion(input: {
  readonly path: string;
  readonly snapshot: OpenProjectSnapshot;
}): Promise<{
  readonly artifact: {
    readonly bytes: number;
    readonly path: string;
    readonly sha256: string;
  };
  readonly receipt: EditorialPromotionReceiptV1;
} | null> {
  let contents: string;
  try {
    contents = await input.snapshot.openProject.fileSystem.readText(input.path);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch {
    throw new ApplicationError(
      "invalid-data",
      "Editorial promotion receipt is not valid JSON.",
    );
  }
  const receipt = EditorialPromotionReceiptV1Schema.parse(value);
  if (contents !== `${canonicalJson(receipt)}\n`) {
    throw new ApplicationError(
      "invalid-data",
      "Editorial promotion receipt is not canonical immutable JSON.",
    );
  }
  return {
    artifact: {
      bytes: new TextEncoder().encode(contents).byteLength,
      path: input.path,
      sha256: sha256Hex(contents),
    },
    receipt,
  };
}

export function promotionRecoveryMatches(
  receiptInput: EditorialPromotionReceiptV1,
  snapshot: OpenProjectSnapshot,
): boolean {
  const receipt = EditorialPromotionReceiptV1Schema.parse(receiptInput);
  return hashProjectEditPlan(snapshot.plan) === receipt.promotedPlanSha256
    && projectMatchesEditBasis(receipt.promotedBasis, snapshot);
}

async function verifiedPromotionDocuments(
  context: Pick<OperationExecutionContext, "abortSignal" | "application">,
  input: PromoteVariantSelectionInput,
  snapshot: OpenProjectSnapshot,
) {
  const fileSystem = snapshot.openProject.fileSystem;
  const selection = await loadVariantSelection({
    fileSystem,
    reference: input.selection,
  });
  const matrix = await loadVariantMatrix({
    fileSystem,
    reference: selection.matrix,
  });
  const chosen = matrix.candidates.find(candidate => (
    candidate.candidate.candidateId === selection.chosen.candidate.candidateId
  ));
  if (
    chosen === undefined
    || canonicalJson(chosen) !== canonicalJson(selection.chosen)
  ) {
    throw new ApplicationError(
      "conflict",
      "Editorial promotion selection is not an exact member of its closed matrix.",
    );
  }
  throwIfAborted(context.abortSignal);
  const candidate = await loadCreativeCandidate({
    fileSystem,
    reference: chosen,
  });
  const revision = await loadCandidateRevision({ candidate, fileSystem });
  if (
    candidate.candidateSha256 !== selection.result.candidateSha256
    || candidate.revision.revisionSha256 !== selection.result.revisionSha256
  ) {
    throw new ApplicationError(
      "conflict",
      "Editorial promotion selection result hashes do not match the chosen candidate.",
    );
  }
  const receipt = createEditorialPromotionReceiptV1({
    base: selection.base,
    candidate: chosen,
    frozenProject: candidate.base.project,
    promotedPlan: revision.projectEditPlan,
    selection: input.selection,
  });
  return { candidate, receipt, revision, selection };
}

async function exactPromotionTransactionSettled(input: {
  readonly receipt: EditorialPromotionReceiptV1;
  readonly snapshot: OpenProjectSnapshot;
}): Promise<boolean> {
  const transaction = await loadProjectStateTransactionSettlement(
    input.snapshot.openProject.fileSystem,
    input.receipt.transactionId,
  );
  if (
    transaction === null
    || transaction.active !== "after"
    || transaction.transactionId !== input.receipt.transactionId
    || transaction.after.plan.sha256
      !== input.receipt.promotedPlanSha256
  ) {
    return false;
  }
  const [plan, project] = await Promise.all([
    loadProjectEditPlan(
      input.snapshot.openProject.fileSystem,
      transaction.after.plan.path,
    ),
    loadVideoProject(
      input.snapshot.openProject.fileSystem,
      transaction.after.project.path,
    ),
  ]);
  if (
    canonicalJsonSha256(plan) !== transaction.after.plan.sha256
    || canonicalJsonSha256(project) !== transaction.after.project.sha256
    || hashProjectEditPlan(plan) !== input.receipt.promotedPlanSha256
  ) {
    return false;
  }
  return projectMatchesEditBasis(input.receipt.promotedBasis, {
    editBasis: projectEditBasis(project, plan),
    project,
  });
}

async function publishPromotionReceipt(input: {
  readonly receipt: EditorialPromotionReceiptV1;
  readonly snapshot: OpenProjectSnapshot;
}): Promise<EditorialPromotionReceiptReferenceV1> {
  const path = editorialPromotionReceiptPath({
    baseSha256: input.receipt.base.baseSha256,
  });
  const artifact = await publishCreativeDocument({
    document: input.receipt,
    fileSystem: input.snapshot.openProject.fileSystem,
    path,
    schema: EditorialPromotionReceiptV1Schema,
  });
  return editorialPromotionReceiptReferenceV1({
    artifact,
    receipt: input.receipt,
  });
}

export const promoteVariantSelectionOperationDefinition = {
  inputSchema: PromoteVariantSelectionInputSchema,
  inputSchemaId: "studio.operation.project.promote-selection.input/v1",
  kind: "project.promote-selection",
  lifecycle: {
    kind: "project-transaction",
    execute: async (context, input) => {
      throwIfAborted(context.abortSignal);
      let snapshot = await openProjectSnapshot(
        context.application.paths.projectRoot,
        input.project,
      );
      const verified = await verifiedPromotionDocuments(
        context,
        input,
        snapshot,
      );
      const receiptPath = editorialPromotionReceiptPath({
        baseSha256: verified.receipt.base.baseSha256,
      });
      const existing = await loadExistingPromotion({ path: receiptPath, snapshot });
      if (existing !== null) {
        if (
          existing.receipt.selection.selectionSha256
            !== input.selection.selectionSha256
          || existing.receipt.promotionSha256
            !== verified.receipt.promotionSha256
        ) {
          throw new ApplicationError(
            "conflict",
            "Another selection already won promotion for this frozen base.",
          );
        }
        return editorialPromotionReceiptReferenceV1(existing);
      }

      if (await exactPromotionTransactionSettled({
        receipt: verified.receipt,
        snapshot,
      })) {
        await context.workflow?.beforePublication();
        return await publishPromotionReceipt({
          receipt: verified.receipt,
          snapshot,
        });
      }

      if (promotionRecoveryMatches(verified.receipt, snapshot)) {
        const baseline = verified.receipt.promotedPlanSha256
          === verified.receipt.base.generation.currentPlanSha256;
        if (
          !baseline
          && !await exactPromotionTransactionSettled({
            receipt: verified.receipt,
            snapshot,
          })
        ) {
          throw new ApplicationError(
            "conflict",
            "Current plan matches the selected bytes without this promotion's exact settled transaction.",
          );
        }
        await context.workflow?.beforePublication();
        return await publishPromotionReceipt({
          receipt: verified.receipt,
          snapshot,
        });
      }
      assertProjectEditBasis(verified.receipt.base.editBasis, snapshot);
      throwIfAborted(context.abortSignal);
      await context.workflow?.beforePublication();
      throwIfAborted(context.abortSignal);
      snapshot = await openProjectSnapshot(
        context.application.paths.projectRoot,
        input.project,
      );
      assertProjectEditBasis(verified.receipt.base.editBasis, snapshot);

      if (
        hashProjectEditPlan(snapshot.plan)
        !== verified.receipt.promotedPlanSha256
      ) {
        await commitProjectStateTransaction({
          after: {
            plan: verified.revision.projectEditPlan,
            project: snapshot.project,
          },
          before: {
            plan: snapshot.plan,
            project: snapshot.project,
          },
          fileSystem: snapshot.openProject.fileSystem,
          transactionId: verified.receipt.transactionId,
        });
        snapshot = await openProjectSnapshot(
          context.application.paths.projectRoot,
          input.project,
        );
      }
      if (!promotionRecoveryMatches(verified.receipt, snapshot)) {
        throw new ApplicationError(
          "conflict",
          "Editorial promotion transaction did not install the selected plan.",
        );
      }
      return await publishPromotionReceipt({
        receipt: verified.receipt,
        snapshot,
      });
    },
  },
  outputSchema: PromoteVariantSelectionOutputSchema,
  outputSchemaId: "studio.operation.project.promote-selection.output/v1",
  policy: {
    cache: "none",
    cancellable: true,
    effect: "project-mutation",
    maxDurationMs: 30_000,
    maxFanOut: 0,
    maxInputBytes: 32 * 1024,
    maxOutputBytes: 16 * 1024,
    preparation: ["project-state"],
    resources: [
      { amount: 1, resource: "cpu" },
      { amount: 1, resource: "local-io" },
      { amount: 1, resource: "project-publication" },
    ],
    resume: "recoverable-transaction",
  },
  receiptReference: output => output.artifact.path,
  summarize: output => ({
    fields: {
      projectId: output.projectId,
      promotedPlanSha256: output.promotedPlanSha256,
      promotionSha256: output.promotionSha256,
      selectionSha256: output.selectionSha256,
    },
    kind: "project.promote-selection",
  }),
  version: 1,
} satisfies OperationDefinition<
  "project.promote-selection",
  PromoteVariantSelectionInput,
  PromoteVariantSelectionOutput
>;

export type PromoteVariantSelectionReconciliation =
  | {
    readonly kind: "completed";
    readonly output: PromoteVariantSelectionOutput;
  }
  | { readonly kind: "retry" }
  | { readonly kind: "conflict"; readonly message: string };

/**
 * Reconcile only authoritative promotion evidence. Receipt finalization is
 * retried when the exact deterministic transaction settled after a crash.
 */
export async function reconcileVariantSelectionPromotion(
  application: ApplicationContext,
  inputValue: unknown,
): Promise<PromoteVariantSelectionReconciliation> {
  try {
    const input = bindPromoteVariantSelectionInput(application, inputValue);
    const snapshot = await openProjectSnapshot(
      application.paths.projectRoot,
      input.project,
    );
    const abortController = new AbortController();
    const verified = await verifiedPromotionDocuments(
      { abortSignal: abortController.signal, application },
      input,
      snapshot,
    );
    const path = editorialPromotionReceiptPath({
      baseSha256: verified.receipt.base.baseSha256,
    });
    const existing = await loadExistingPromotion({ path, snapshot });
    if (existing !== null) {
      if (
        existing.receipt.selection.selectionSha256
          !== input.selection.selectionSha256
        || existing.receipt.promotionSha256 !== verified.receipt.promotionSha256
      ) {
        return {
          kind: "conflict",
          message: "Editorial promotion receipt does not match the requested selection.",
        };
      }
      return {
        kind: "completed",
        output: editorialPromotionReceiptReferenceV1(existing),
      };
    }
    if (await exactPromotionTransactionSettled({
      receipt: verified.receipt,
      snapshot,
    })) {
      return { kind: "retry" };
    }
    if (promotionRecoveryMatches(verified.receipt, snapshot)) {
      const baseline = verified.receipt.promotedPlanSha256
        === verified.receipt.base.generation.currentPlanSha256;
      if (
        baseline
        || await exactPromotionTransactionSettled({
          receipt: verified.receipt,
          snapshot,
        })
      ) {
        return { kind: "retry" };
      }
      return {
        kind: "conflict",
        message: "Selected plan is current without the exact promotion transaction.",
      };
    }
    if (projectMatchesEditBasis(verified.receipt.base.editBasis, snapshot)) {
      return { kind: "retry" };
    }
    return {
      kind: "conflict",
      message: "Project state no longer matches the promotion base or selected result.",
    };
  } catch (error) {
    return {
      kind: "conflict",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
