import type {
  GatewayOperationName,
  GatewayOperationResult,
  GatewayPortRequest,
} from "../../gateway-port";
import {
  dispatchGatewayOperation,
  gatewayRequestId,
} from "../../gateway-port";
import { ApplicationError } from "../../errors";
import type {
  BoundedOperationSummary,
  OperationExecutionContext,
  OperationKind,
  OperationPolicy,
} from "../../operation";
import { throwIfAborted } from "../shared";

const GATEWAY_COMMON_RESOURCES = [
  { amount: 1, resource: "network" },
  { amount: 1, resource: "paid-call" },
  { amount: 1, resource: "output-publication" },
] as const;

export function gatewayOperationPolicy(
  options: Readonly<{
    maximumDurationMs: number;
    mediaInput: boolean;
  }>,
): OperationPolicy {
  return {
    cache: "exact-run",
    cancellable: true,
    effect: "paid-cloud",
    maxDurationMs: options.maximumDurationMs,
    maxFanOut: 0,
    maxInputBytes: 512 * 1024,
    maxOutputBytes: 256 * 1024,
    preparation: options.mediaInput
      ? ["local-media", "provider-options"]
      : ["provider-options"],
    // Exact media preparation and generated-output decode validation are
    // short host-port phases. They acquire CPU/FFmpeg/local-I/O directly
    // instead of pinning those pools across the paid provider wait.
    resources: GATEWAY_COMMON_RESOURCES,
    resume: "ambiguous-after-dispatch",
  };
}

function exactWorkflowIdentity(
  context: OperationExecutionContext,
  operation: GatewayOperationName,
): string {
  const workflow = context.workflow;
  if (workflow === undefined) {
    throw new ApplicationError(
      "authorization-required",
      "Paid Gateway operations require an exact workflow node plan and approval.",
      { operation },
    );
  }
  return gatewayRequestId({
    nodeKey: workflow.nodeKey,
    nodePlanSha256: workflow.nodePlanSha256,
    operation,
    runId: workflow.runId,
  });
}

export async function executeGatewayOperation(
  context: OperationExecutionContext,
  request: GatewayPortRequest,
): Promise<GatewayOperationResult> {
  throwIfAborted(context.abortSignal);
  const workflow = context.workflow;
  const requestId = exactWorkflowIdentity(context, request.operation);
  if (workflow === undefined) {
    throw new ApplicationError(
      "authorization-required",
      "Paid Gateway operations require an exact workflow node plan and approval.",
      { operation: request.operation },
    );
  }
  // This is the final safe point before the host durably records a paid
  // dispatch intent. It rechecks both the run fence and cancellation marker.
  await workflow.beforePublication();
  throwIfAborted(context.abortSignal);
  return await dispatchGatewayOperation(context.application, {
    beforePublication: async () => {
      await workflow.beforePublication();
    },
    request,
    requestId,
    signal: context.abortSignal,
  });
}

export function summarizeGatewayOperation(
  kind: Extract<OperationKind, `gateway.${string}`>,
  output: GatewayOperationResult,
): BoundedOperationSummary {
  return {
    fields: {
      bytes: output.outputs.reduce(
        (total, artifact) => total + artifact.bytes,
        0,
      ),
      model: output.model,
      outputs: output.outputs.length,
      receipt: output.receipt.path,
      requestId: output.requestId,
      ...(output.operation === "transcription"
        ? {
            characters: output.transcript.characters,
            durationSeconds: output.transcript.durationSeconds,
            segments: output.transcript.segments,
          }
        : {}),
    },
    kind,
  };
}
