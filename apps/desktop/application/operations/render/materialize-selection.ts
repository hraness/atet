import { z } from "zod";

import {
  canonicalJson,
  sha256Hex,
} from "../../../core";
import {
  createDeliveryMaterializationReceiptV1,
  CreativeRenderNameSchema,
  CreativeVariantKeySchema,
  DeliveryMaterializationReceiptReferenceV1Schema,
  DeliveryMaterializationReceiptV1Schema,
  deliveryMaterializationReceiptPath,
  deliveryMaterializationReceiptReferenceV1,
  VariantSelectionReferenceV1Schema,
  type DeliveryMaterializationReceiptV1,
} from "../../creative-iteration";
import {
  ProjectRenderOutputPathSchema,
} from "../../../contracts";
import type { ApplicationContext } from "../../context";
import { ApplicationError } from "../../errors";
import type { OperationDefinition } from "../../operation";
import { withOutputPublicationLease } from "../../output-publication-lease";
import { ProjectReferenceSchema, throwIfAborted } from "../shared";
import {
  creativeProjectFileSystem,
  loadCreativeCandidate,
  loadVariantMatrix,
  loadVariantSelection,
  publishCreativeDocument,
  verifyCandidateRender,
} from "../iteration/shared";
import { ProjectRenderOutputReferenceSchema } from "../../receipts";

const MaterializeVariantSelectionUnboundInputSchema = z.strictObject({
  deliveryKey: CreativeVariantKeySchema.default("delivery"),
  destinationPath: ProjectRenderOutputPathSchema.optional(),
  project: ProjectReferenceSchema,
  renderName: CreativeRenderNameSchema,
  selection: VariantSelectionReferenceV1Schema,
}).superRefine((input, context) => {
  if (input.project !== input.selection.base.projectId) {
    context.addIssue({
      code: "custom",
      message: "Delivery materialization project does not match its selection.",
      path: ["project"],
    });
  }
});

export const MaterializeVariantSelectionInputSchema =
  MaterializeVariantSelectionUnboundInputSchema.safeExtend({
    destinationPath: ProjectRenderOutputPathSchema,
  }).strict();

export const MaterializeVariantSelectionOutputSchema = z.strictObject({
  output: ProjectRenderOutputReferenceSchema,
  receipt: DeliveryMaterializationReceiptReferenceV1Schema,
});

export type MaterializeVariantSelectionInput = z.infer<
  typeof MaterializeVariantSelectionInputSchema
>;
export type MaterializeVariantSelectionOutput = z.infer<
  typeof MaterializeVariantSelectionOutputSchema
>;

export function defaultDeliveryMaterializationPath(input: {
  readonly deliveryKey: string;
  readonly renderName: string;
  readonly selectionSha256: string;
}): string {
  return ProjectRenderOutputPathSchema.parse(
    `renders/deliveries/selections/${input.selectionSha256}/${
      CreativeVariantKeySchema.parse(input.deliveryKey)
    }/${CreativeRenderNameSchema.parse(input.renderName)}.mp4`,
  );
}

export function bindMaterializeVariantSelectionInput(
  _application: ApplicationContext,
  input: unknown,
): MaterializeVariantSelectionInput {
  const request = MaterializeVariantSelectionUnboundInputSchema.parse(input);
  return MaterializeVariantSelectionInputSchema.parse({
    ...request,
    destinationPath: request.destinationPath
      ?? defaultDeliveryMaterializationPath({
        deliveryKey: request.deliveryKey,
        renderName: request.renderName,
        selectionSha256: request.selection.selectionSha256,
      }),
  });
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function loadExistingMaterialization(input: {
  readonly fileSystem: Awaited<ReturnType<typeof creativeProjectFileSystem>>;
  readonly path: string;
}): Promise<{
  readonly artifact: {
    readonly bytes: number;
    readonly path: string;
    readonly sha256: string;
  };
  readonly receipt: DeliveryMaterializationReceiptV1;
} | null> {
  let contents: string;
  try {
    contents = await input.fileSystem.readText(input.path);
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
      "Delivery materialization receipt is not valid JSON.",
    );
  }
  const receipt = DeliveryMaterializationReceiptV1Schema.parse(value);
  if (contents !== `${canonicalJson(receipt)}\n`) {
    throw new ApplicationError(
      "invalid-data",
      "Delivery materialization receipt is not canonical immutable JSON.",
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

export const materializeVariantSelectionOperationDefinition = {
  inputSchema: MaterializeVariantSelectionInputSchema,
  inputSchemaId: "studio.operation.render.materialize-selection.input/v1",
  kind: "render.materialize-selection",
  lifecycle: {
    kind: "local-artifact",
    execute: async (context, input) => {
      throwIfAborted(context.abortSignal);
      const fileSystem = await creativeProjectFileSystem(
        context.application,
        input.project,
      );
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
          "Delivery selection is not an exact member of its closed matrix.",
        );
      }
      const candidate = await loadCreativeCandidate({
        fileSystem,
        reference: chosen,
      });
      const render = candidate.renders.find(item => item.name === input.renderName);
      if (render === undefined) {
        throw new ApplicationError(
          "not-found",
          `Selected candidate has no verified render named ${input.renderName}.`,
        );
      }
      if (!selection.result.renders.some(result => (
        result.name === render.name
        && result.outputSha256 === render.output.sha256
        && result.receiptSha256 === render.receipt.receiptSha256
      ))) {
        throw new ApplicationError(
          "conflict",
          "Selected render hashes are absent from the immutable selection result.",
        );
      }
      await verifyCandidateRender({ candidate, fileSystem, render });
      if (render.output.path === input.destinationPath) {
        throw new ApplicationError(
          "conflict",
          "Delivery materialization requires a new output path.",
        );
      }
      const receipt = createDeliveryMaterializationReceiptV1({
        candidate: chosen,
        destinationPath: input.destinationPath,
        renderName: input.renderName,
        selection: input.selection,
        source: render.output,
      });
      const receiptPath = deliveryMaterializationReceiptPath(
        receipt.materializationSha256,
      );
      throwIfAborted(context.abortSignal);
      return await withOutputPublicationLease(
        context.application,
        {
          outputPath: input.destinationPath,
          projectId: input.project,
        },
        async () => {
          const existing = await loadExistingMaterialization({
            fileSystem,
            path: receiptPath,
          });
          if (existing !== null) {
            if (canonicalJson(existing.receipt) !== canonicalJson(receipt)) {
              throw new ApplicationError(
                "conflict",
                "Delivery materialization receipt path contains another result.",
              );
            }
            if (fileSystem.inspectFile === undefined) {
              throw new ApplicationError(
                "internal",
                "Project storage does not support delivery verification.",
              );
            }
            const integrity = await fileSystem.inspectFile(input.destinationPath);
            if (
              integrity.bytes !== receipt.destination.bytes
              || integrity.sha256 !== receipt.destination.sha256
            ) {
              throw new ApplicationError(
                "conflict",
                "Existing materialized delivery no longer matches its receipt.",
              );
            }
            const reference = deliveryMaterializationReceiptReferenceV1(existing);
            return MaterializeVariantSelectionOutputSchema.parse({
              output: receipt.destination,
              receipt: reference,
            });
          }
          if (fileSystem.copyFileNoReplace === undefined) {
            throw new ApplicationError(
              "internal",
              "Project storage does not support immutable delivery materialization.",
            );
          }
          throwIfAborted(context.abortSignal);
          await context.workflow?.beforePublication();
          throwIfAborted(context.abortSignal);
          await fileSystem.copyFileNoReplace(
            render.output.path,
            input.destinationPath,
            render.output,
          );
          // Copy publication is the point of no return. Finalize its deterministic
          // receipt even if cancellation arrives immediately afterward.
          const artifact = await publishCreativeDocument({
            document: receipt,
            fileSystem,
            path: receiptPath,
            schema: DeliveryMaterializationReceiptV1Schema,
          });
          const reference = deliveryMaterializationReceiptReferenceV1({
            artifact,
            receipt,
          });
          return MaterializeVariantSelectionOutputSchema.parse({
            output: receipt.destination,
            receipt: reference,
          });
        },
      );
    },
  },
  outputSchema: MaterializeVariantSelectionOutputSchema,
  outputSchemaId: "studio.operation.render.materialize-selection.output/v1",
  policy: {
    cache: "none",
    cancellable: true,
    effect: "local-derived-write",
    maxDurationMs: 6 * 60 * 60_000,
    maxFanOut: 0,
    maxInputBytes: 32 * 1024,
    maxOutputBytes: 32 * 1024,
    preparation: ["local-media"],
    resources: [
      { amount: 1, resource: "local-io" },
      { amount: 1, resource: "output-publication" },
    ],
    resume: "deterministic",
  },
  receiptReference: output => output.receipt.artifact.path,
  summarize: output => ({
    fields: {
      materializationSha256: output.receipt.materializationSha256,
      outputPath: output.output.path,
      outputSha256: output.output.sha256,
      selectionSha256: output.receipt.selectionSha256,
    },
    kind: "render.materialize-selection",
  }),
  version: 1,
} satisfies OperationDefinition<
  "render.materialize-selection",
  MaterializeVariantSelectionInput,
  MaterializeVariantSelectionOutput
>;
