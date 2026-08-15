import type { OperationDefinition } from "../../operation";
import {
  GatewaySpeechOperationInputSchema,
  GatewaySpeechOperationResultSchema,
  type GatewaySpeechOperationInput,
  type GatewaySpeechOperationResult,
} from "../../gateway-port";
import {
  executeGatewayOperation,
  gatewayOperationPolicy,
  summarizeGatewayOperation,
} from "./shared";

export const gatewaySpeechOperationDefinition = {
  inputSchema: GatewaySpeechOperationInputSchema,
  inputSchemaId: "atet.operation.gateway.speech.input/v1",
  kind: "gateway.speech",
  lifecycle: {
    kind: "paid-dispatch",
    execute: async (context, input) => {
      const output = await executeGatewayOperation(context, {
        operation: "speech",
        request: input,
      });
      return GatewaySpeechOperationResultSchema.parse(output);
    },
  },
  outputSchema: GatewaySpeechOperationResultSchema,
  outputSchemaId: "atet.operation.gateway.speech.output/v1",
  policy: gatewayOperationPolicy({
    maximumDurationMs: 5 * 60_000,
    mediaInput: false,
  }),
  receiptReference: output => output.receipt.path,
  summarize: output => summarizeGatewayOperation("gateway.speech", output),
  version: 1,
} satisfies OperationDefinition<
  "gateway.speech",
  GatewaySpeechOperationInput,
  GatewaySpeechOperationResult
>;
