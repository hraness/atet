import type { OperationDefinition } from "../../operation";
import {
  GatewayTranscriptionOperationInputSchema,
  GatewayTranscriptionOperationResultSchema,
  type GatewayTranscriptionOperationInput,
  type GatewayTranscriptionOperationResult,
} from "../../gateway-port";
import {
  executeGatewayOperation,
  gatewayOperationPolicy,
  summarizeGatewayOperation,
} from "./shared";

export const gatewayTranscriptionOperationDefinition = {
  inputSchema: GatewayTranscriptionOperationInputSchema,
  inputSchemaId: "atet.operation.gateway.transcription.input/v1",
  kind: "gateway.transcription",
  lifecycle: {
    kind: "paid-dispatch",
    execute: async (context, input) => {
      const output = await executeGatewayOperation(context, {
        operation: "transcription",
        request: input,
      });
      return GatewayTranscriptionOperationResultSchema.parse(output);
    },
  },
  outputSchema: GatewayTranscriptionOperationResultSchema,
  outputSchemaId: "atet.operation.gateway.transcription.output/v1",
  policy: gatewayOperationPolicy({
    maximumDurationMs: 10 * 60_000,
    mediaInput: true,
  }),
  receiptReference: output => output.receipt.path,
  summarize: output =>
    summarizeGatewayOperation("gateway.transcription", output),
  version: 1,
} satisfies OperationDefinition<
  "gateway.transcription",
  GatewayTranscriptionOperationInput,
  GatewayTranscriptionOperationResult
>;
