import type { OperationDefinition } from "../../operation";
import {
  GatewayVideoOperationInputSchema,
  GatewayVideoOperationResultSchema,
  type GatewayVideoOperationInput,
  type GatewayVideoOperationResult,
} from "../../gateway-port";
import {
  executeGatewayOperation,
  gatewayOperationPolicy,
  summarizeGatewayOperation,
} from "./shared";

export const gatewayVideoOperationDefinition = {
  inputSchema: GatewayVideoOperationInputSchema,
  inputSchemaId: "studio.operation.gateway.video.input/v1",
  kind: "gateway.video",
  lifecycle: {
    kind: "paid-dispatch",
    execute: async (context, input) => {
      const output = await executeGatewayOperation(context, {
        operation: "video",
        request: input,
      });
      return GatewayVideoOperationResultSchema.parse(output);
    },
  },
  outputSchema: GatewayVideoOperationResultSchema,
  outputSchemaId: "studio.operation.gateway.video.output/v1",
  policy: gatewayOperationPolicy({
    maximumDurationMs: 20 * 60_000,
    mediaInput: true,
  }),
  receiptReference: output => output.receipt.path,
  summarize: output => summarizeGatewayOperation("gateway.video", output),
  version: 1,
} satisfies OperationDefinition<
  "gateway.video",
  GatewayVideoOperationInput,
  GatewayVideoOperationResult
>;
