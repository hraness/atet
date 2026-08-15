import type { OperationDefinition } from "../../operation";
import {
  GatewayImageOperationInputSchema,
  GatewayImageOperationResultSchema,
  type GatewayImageOperationInput,
  type GatewayImageOperationResult,
} from "../../gateway-port";
import {
  executeGatewayOperation,
  gatewayOperationPolicy,
  summarizeGatewayOperation,
} from "./shared";

export const gatewayImageOperationDefinition = {
  inputSchema: GatewayImageOperationInputSchema,
  inputSchemaId: "atet.operation.gateway.image.input/v1",
  kind: "gateway.image",
  lifecycle: {
    kind: "paid-dispatch",
    execute: async (context, input) => {
      const output = await executeGatewayOperation(context, {
        operation: "image",
        request: input,
      });
      return GatewayImageOperationResultSchema.parse(output);
    },
  },
  outputSchema: GatewayImageOperationResultSchema,
  outputSchemaId: "atet.operation.gateway.image.output/v1",
  policy: gatewayOperationPolicy({
    maximumDurationMs: 5 * 60_000,
    mediaInput: true,
  }),
  receiptReference: output => output.receipt.path,
  summarize: output => summarizeGatewayOperation("gateway.image", output),
  version: 1,
} satisfies OperationDefinition<
  "gateway.image",
  GatewayImageOperationInput,
  GatewayImageOperationResult
>;
