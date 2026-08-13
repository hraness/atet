import { z } from "zod";

import {
  CreativeRenderNameSchema,
  CreativeVariantKeySchema,
  VariantMatrixReferenceV1Schema,
  VariantSelectionEvidenceV1Schema,
} from "../application";
import { defineWorkflow } from "../code/public";
import { ProjectRenderOutputPathSchema } from "../contracts";

const RESERVED_DELIVERY_PATH_PREFIX = "renders/deliveries/selections/";

const CreativeDeliveryInputSchema = z.strictObject({
  deliveryKey: CreativeVariantKeySchema,
  destinationPath: ProjectRenderOutputPathSchema.optional(),
  renderName: CreativeRenderNameSchema,
});

export const CreativeSelectionInputSchema = z.strictObject({
  deliveries: z.array(CreativeDeliveryInputSchema).max(16).default([]),
  evidence: VariantSelectionEvidenceV1Schema.optional(),
  matrix: VariantMatrixReferenceV1Schema,
  promote: z.boolean().default(false),
  variantKey: CreativeVariantKeySchema,
}).superRefine((input, context) => {
  const destinations = input.deliveries
    .map(delivery => delivery.destinationPath)
    .filter(destination => destination !== undefined);
  if (new Set(destinations).size !== destinations.length) {
    context.addIssue({
      code: "custom",
      message: "Creative selection delivery destinations must be unique.",
      path: ["deliveries"],
    });
  }
  for (const [index, delivery] of input.deliveries.entries()) {
    if (delivery.destinationPath?.startsWith(RESERVED_DELIVERY_PATH_PREFIX)) {
      context.addIssue({
        code: "custom",
        message: "Explicit creative delivery paths cannot use the implicit delivery namespace.",
        path: ["deliveries", index, "destinationPath"],
      });
    }
  }
  const deliveryKeys = input.deliveries.map(delivery => delivery.deliveryKey);
  if (new Set(deliveryKeys).size !== deliveryKeys.length) {
    context.addIssue({
      code: "custom",
      message: "Creative selection delivery keys must be unique.",
      path: ["deliveries"],
    });
  }
});

/**
 * Record one explicit matrix choice, with optional CAS promotion and delivery
 * copies as separate downstream effects.
 */
export const creativeSelection = defineWorkflow({
  id: "creative-selection",
  inputSchema: CreativeSelectionInputSchema,
  inputSchemaId: "studio.workflow.creative-selection.input/v1",
  version: 1,
  build(workflow, input) {
    const matrix = workflow.iteration.matrixFromReference(input.matrix);
    const selection = workflow.iteration.select("selection", {
      ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
      matrix,
      variantKey: input.variantKey,
    });
    const deliveries = input.deliveries.map(delivery => (
      workflow.namespace("deliveries").namespace(delivery.deliveryKey)
        .iteration.materialize("materialize", {
        deliveryKey: delivery.deliveryKey,
        ...(delivery.destinationPath === undefined
          ? {}
          : { destinationPath: delivery.destinationPath }),
        renderName: delivery.renderName,
        selection,
      }).result
    ));
    const result = {
      deliveries,
      ...(input.promote
        ? { promotion: workflow.iteration.promote("promotion", selection) }
        : {}),
      selection: selection.reference,
    };
    return result;
  },
});
