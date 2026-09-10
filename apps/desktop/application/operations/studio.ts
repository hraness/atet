import { posix } from "node:path";

import { deepFreezeJson } from "../../../../src/code/json-snapshot";
import { validateStudioReceipt } from "../../../../src/studio";
import { canonicalJson } from "../../core/canonical-json";
import type { ApplicationContext } from "../context";
import { ApplicationError } from "../errors";
import type { OperationDefinition, OperationExecutionContext } from "../operation";
import { writeOperationCompletionCheckpoint } from "../operation-completion-checkpoint";
import {
  BoundStudioRunInputSchema, StudioRunInputSchema, StudioRunOutputSchema,
  type BoundStudioRunInput, type StudioHostControl, type StudioReconciliation, type StudioRunInput, type StudioRunOutput,
} from "../studio-port";
import { throwIfAborted } from "./shared";

const definitionIdentity = {
  kind: "slopcamera.studio.run", version: 1,
  inputSchemaId: "slopcamera.operation.studio.run.input/v1", outputSchemaId: "slopcamera.operation.studio.run.output/v1",
} as const;

function requirePort(application: ApplicationContext) {
  if (application.studioPort === undefined) throw new ApplicationError("unavailable", "This host has no trusted studio adapter.");
  return application.studioPort;
}

function boundInput(value: unknown): BoundStudioRunInput {
  const input = BoundStudioRunInputSchema.parse(value);
  if (canonicalJson(input.job) !== canonicalJson(input.plan.job)) throw new ApplicationError("conflict", "Studio request job disagrees with its exact plan.");
  if (input.plan.runtime === undefined) throw new ApplicationError("unavailable", "Studio execution requires an observed runtime binding.");
  return deepFreezeJson(input);
}

export function studioAuthorizationRequest(value: unknown) {
  const input = boundInput(value);
  return Object.freeze({ planSha256: input.plan.planSha256, bundleSha256: input.plan.bundleSha256, jobId: input.job.jobId });
}

/** Manifest closure and fixed runtime probing are inert with respect to authored source. */
export async function bindStudioRunInput(application: ApplicationContext, value: unknown, signal = new AbortController().signal, beforePublication?: () => Promise<void>): Promise<BoundStudioRunInput> {
  throwIfAborted(signal);
  const input = deepFreezeJson(StudioRunInputSchema.parse(value));
  const guard = async () => { throwIfAborted(signal); await application.hostResourceLease?.assertOwned(); await beforePublication?.(); throwIfAborted(signal); };
  await guard();
  const bound = boundInput(await requirePort(application).bind(input, signal, { inheritedFileDescriptors: application.hostResourceLease?.inheritedFileDescriptors ?? [], beforePublication: guard }));
  throwIfAborted(signal);
  if (canonicalJson(input.job) !== canonicalJson(bound.job) || input.bundle.path !== bound.bundle.path
    || ("sha256" in input.bundle && canonicalJson(input.bundle) !== canonicalJson(bound.bundle))
    || (input.plan !== undefined && canonicalJson(input.plan) !== canonicalJson(bound.plan))) {
    throw new ApplicationError("conflict", "Studio source, job, or runtime changed after planning.");
  }
  return bound;
}

/** The host verifies physical bytes; this boundary verifies their complete typed projection. */
export function validateStudioRunOutput(inputValue: unknown, outputValue: unknown): StudioRunOutput {
  const input = boundInput(inputValue);
  const output = StudioRunOutputSchema.parse(outputValue);
  const receipt = validateStudioReceipt({ plan: input.plan, receipt: output.document });
  const expected = new Map(receipt.outputs.map(item => [posix.join(posix.dirname(output.receipt.path), "outputs", item.path), item]));
  if (expected.size !== output.outputs.length) throw new ApplicationError("invalid-data", "Studio output references must cover every retained receipt artifact exactly once.");
  for (const item of output.outputs) {
    const artifact = expected.get(item.artifact.path);
    if (artifact === undefined || artifact.outputId !== item.outputId || artifact.sha256 !== item.artifact.sha256
      || artifact.bytes !== item.artifact.bytes || artifact.role !== item.role || artifact.format !== item.format) {
      throw new ApplicationError("invalid-data", "Studio output reference disagrees with its retained receipt artifact.");
    }
    expected.delete(item.artifact.path);
  }
  return deepFreezeJson(output);
}

function controlFor(context: OperationExecutionContext): StudioHostControl {
  const workflow = context.workflow;
  if (workflow === undefined) throw new ApplicationError("unavailable", "Studio workflow execution requires an exact durable node workspace.");
  return {
    signal: context.abortSignal,
    workspaceDirectory: workflow.workspaceDirectory,
    identity: { runId: workflow.runId, nodeKey: workflow.nodeKey, nodePlanSha256: workflow.nodePlanSha256 },
    inheritedFileDescriptors: context.application.hostResourceLease?.inheritedFileDescriptors ?? [],
    beforePublication: async () => {
      throwIfAborted(context.abortSignal);
      await context.application.hostResourceLease?.assertOwned();
      await workflow.beforePublication();
      throwIfAborted(context.abortSignal);
    },
  };
}

function assertSucceeded(output: StudioRunOutput): void {
  if (output.document.state === "succeeded") return;
  throw new ApplicationError(output.document.state === "unknown-custody" ? "ambiguous" : "subprocess",
    output.document.state === "unknown-custody" ? "Studio native process custody is unresolved; inspect the retained receipt before further execution." : "Studio job failed; inspect its retained receipt.",
    { receipt: output.receipt, state: output.document.state });
}

export async function executeStudioRun(context: OperationExecutionContext, value: StudioRunInput): Promise<StudioRunOutput> {
  const control = controlFor(context);
  const original = boundInput(value);
  const input = await bindStudioRunInput(context.application, original, context.abortSignal, control.beforePublication);
  if (input.plan.readiness !== "authorization-required") throw new ApplicationError("unavailable", "Studio runtime has unavailable or unverified required capabilities.");
  const authorization = context.application.studioAuthorization;
  if (authorization === undefined || !await authorization.authorize(studioAuthorizationRequest(input))) {
    throw new ApplicationError("authorization-required", "This exact studio plan requires explicit trusted-current-user code authorization from the host.");
  }
  await control.beforePublication();
  const output = validateStudioRunOutput(input, await requirePort(context.application).execute(input, { ...control, allowTrustedCode: true }));
  assertSucceeded(output);
  await control.beforePublication();
  await writeOperationCompletionCheckpoint(context, definitionIdentity, output);
  return output;
}

/** Reconciliation never invokes authored source and never returns permission to retry. */
export async function reconcileStudioRun(context: OperationExecutionContext, exactInput: unknown, checkpointOutput?: unknown): Promise<StudioReconciliation> {
  const input = boundInput(exactInput);
  const control = controlFor(context);
  throwIfAborted(control.signal);
  const recovered = await requirePort(context.application).reconcile(input, control);
  throwIfAborted(control.signal);
  if (recovered.kind !== "completed") return recovered;
  const output = validateStudioRunOutput(input, recovered.output);
  if (output.document.state !== "succeeded") return { kind: "ambiguous", message: "Studio retained job did not complete successfully; no automatic execution is allowed." };
  if (checkpointOutput !== undefined && canonicalJson(StudioRunOutputSchema.parse(checkpointOutput)) !== canonicalJson(output)) {
    return { kind: "incompatible", message: "Studio checkpoint disagrees with the authoritative native job receipt." };
  }
  return { kind: "completed", output };
}

export const studioRunOperationDefinition = {
  ...definitionIdentity,
  inputSchema: StudioRunInputSchema, outputSchema: StudioRunOutputSchema,
  lifecycle: { kind: "local-artifact", execute: executeStudioRun },
  policy: {
    cache: "exact-run", cancellable: true, effect: "local-derived-write", maxDurationMs: 6 * 60 * 60 * 1000,
    maxFanOut: 0, maxInputBytes: 64 * 1024 * 1024, maxOutputBytes: 64 * 1024 * 1024,
    preparation: ["local-media"], resources: [
      { amount: 1, resource: "cpu" }, { amount: 1, resource: "local-io" },
      { amount: 1, resource: "ffmpeg" }, { amount: 1, resource: "output-publication" },
    ], resume: "verified-receipt",
  },
  receiptReference: output => output.receipt.path,
  summarize: output => ({ kind: "slopcamera.studio.run", fields: { jobId: output.document.jobId, planSha256: output.document.planSha256, state: output.document.state, outputs: output.outputs.length } }),
} satisfies OperationDefinition<"slopcamera.studio.run", StudioRunInput, StudioRunOutput>;
