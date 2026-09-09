import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApplicationContext } from "../context";
import { createApplicationOperationRegistry } from "../default-registry";
import type { OperationExecutionContext } from "../operation";
import { readOperationCompletionCheckpoint } from "../operation-completion-checkpoint";
import { StudioRunInputSchema, type ApplicationStudioPort, type StudioHostControl } from "../studio-port";
import { reconcileLocalVerifiedReceiptOperation } from "../verified-receipt-reconciliation";
import { bindStudioRunInput, executeStudioRun, reconcileStudioRun, studioRunOperationDefinition, validateStudioRunOutput } from "./studio";
import { studioOperationFixture } from "./studio-test-support";
import { operationApplicationContext } from "./test-support";

function checkpointIdentity(context: OperationExecutionContext) {
  return { kind: studioRunOperationDefinition.kind, version: 1, inputSchemaId: studioRunOperationDefinition.inputSchemaId, outputSchemaId: studioRunOperationDefinition.outputSchemaId, nodeKey: context.workflow!.nodeKey, nodePlanSha256: context.workflow!.nodePlanSha256, runId: context.workflow!.runId };
}

async function withHost(callback: (host: { context: OperationExecutionContext; calls: { bind: number; execute: number; reconcile: number; guard: number }; port: ApplicationStudioPort }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "atet-studio-operation-"));
  const { input, output } = studioOperationFixture();
  const calls = { bind: 0, execute: 0, reconcile: 0, guard: 0 };
  const port: ApplicationStudioPort = { bind: async () => { calls.bind++; return input; }, execute: async () => { calls.execute++; return output; }, reconcile: async () => { calls.reconcile++; return { kind: "completed", output }; } };
  const application: ApplicationContext = { ...operationApplicationContext(root), studioPort: port };
  const workspaceDirectory = join(application.paths.privateRoot, "studio-operation-test");
  await mkdir(workspaceDirectory, { recursive: true, mode: 0o700 });
  const context: OperationExecutionContext = { application, abortSignal: new AbortController().signal, workflow: {
    nodeKey: "native", nodePlanSha256: "b".repeat(64), runId: "run_studiofixture", workspaceDirectory, beforePublication: async () => { calls.guard++; },
  } };
  try { await callback({ context, calls, port }); } finally { await rm(root, { recursive: true, force: true }); }
}

test("studio discovery is closed, complete, and separates the host authorization from authored input", () => {
  const registry = createApplicationOperationRegistry();
  const definition = registry.describe("atet.studio.run", 1);
  expect(definition.inputJsonSchema.type).toBe("object");
  expect(definition.outputJsonSchema.type).toBe("object");
  expect(definition.policy).toMatchObject({ resume: "verified-receipt", effect: "local-derived-write" });
  const { input } = studioOperationFixture();
  expect(() => StudioRunInputSchema.parse({ ...input, allowTrustedCode: true })).toThrow();
  expect(() => StudioRunInputSchema.parse({ ...input, executable: "/bin/sh" })).toThrow();
  let reads = 0;
  expect(() => StudioRunInputSchema.parse({ ...input, get surprise() { reads++; return 1; } })).toThrow();
  expect(reads).toBe(0);
});

test("binding never executes authored code and rejects changed plan/job/source from the host", async () => {
  await withHost(async ({ context, calls, port }) => {
    const { input } = studioOperationFixture();
    expect(await bindStudioRunInput(context.application, { bundle: { path: input.bundle.path }, job: input.job })).toEqual(input);
    expect(calls.execute).toBe(0);
    await expect(bindStudioRunInput(context.application, { ...input, bundle: { ...input.bundle, bytes: input.bundle.bytes + 1 } })).rejects.toThrow("changed");
    const changed = { ...input, job: { ...input.job, jobId: "studio_other" } };
    port.bind = async () => changed;
    await expect(bindStudioRunInput(context.application, input)).rejects.toThrow("disagrees");
  });
});

test("generic host availability cannot authorize native source execution", async () => {
  await withHost(async ({ context, calls }) => {
    await expect(executeStudioRun(context, studioOperationFixture().input)).rejects.toThrow("explicit trusted-current-user");
    expect(calls.execute).toBe(0);
    const denied = { ...context, application: { ...context.application, studioAuthorization: { authorize: async () => false } } };
    await expect(executeStudioRun(denied, studioOperationFixture().input)).rejects.toThrow("explicit trusted-current-user");
    expect(calls.execute).toBe(0);
  });
});

test("exact authorization, physical descriptors, and publication fence reach execution and completion", async () => {
  await withHost(async ({ context, calls, port }) => {
    const { input, output } = studioOperationFixture();
    let observed: StudioHostControl | undefined;
    port.execute = async (bound, control) => { calls.execute++; expect(bound).toEqual(input); expect(control.allowTrustedCode).toBe(true); observed = control; await control.beforePublication(); return output; };
    const authorized = { ...context, application: { ...context.application,
      studioAuthorization: { authorize: async (request: { planSha256: string; bundleSha256: string; jobId: string }) => { expect(request).toEqual({ planSha256: input.plan.planSha256, bundleSha256: input.plan.bundleSha256, jobId: input.job.jobId }); return true; } },
      hostResourceLease: { claims: [], profile: { id: "test", capacities: [] }, ticket: "fixture", inheritedFileDescriptor: 9, inheritedFileDescriptors: [9], assertOwned: async () => undefined },
    } } satisfies OperationExecutionContext;
    expect(await executeStudioRun(authorized, input)).toEqual(output);
    expect(observed?.inheritedFileDescriptors).toEqual([9]);
    expect(calls.execute).toBe(1);
    expect(calls.guard).toBeGreaterThanOrEqual(3);
    const checkpoint = await readOperationCompletionCheckpoint({ privateRoot: context.application.paths.privateRoot, workspaceDirectory: context.workflow!.workspaceDirectory, expected: checkpointIdentity(context) });
    expect(checkpoint?.output).toEqual(output);
  });
});

test("cancellation during authorization prevents dispatch", async () => {
  await withHost(async ({ context, calls }) => {
    const controller = new AbortController();
    const authorized = { ...context, abortSignal: controller.signal, application: { ...context.application, studioAuthorization: { authorize: async () => { controller.abort(); return true; } } } };
    await expect(executeStudioRun(authorized, studioOperationFixture().input)).rejects.toThrow();
    expect(calls.execute).toBe(0);
  });
});

test("output references cannot omit, duplicate, relocate, or relabel retained outputs", () => {
  const { input, output } = studioOperationFixture();
  expect(validateStudioRunOutput(input, output)).toEqual(output);
  for (const outputs of [[], [...output.outputs, ...output.outputs], [{ ...output.outputs[0]!, artifact: { ...output.outputs[0]!.artifact, path: "elsewhere/part.step" } }], [{ ...output.outputs[0]!, artifact: { ...output.outputs[0]!.artifact, sha256: "b".repeat(64) } }], [{ ...output.outputs[0]!, outputId: "different" }]]) {
    expect(() => validateStudioRunOutput(input, { ...output, outputs })).toThrow();
  }
});

test("missing workflow checkpoint reconciles native receipts and never retries trusted code", async () => {
  await withHost(async ({ context, calls, port }) => {
    const { input, output } = studioOperationFixture();
    const request = { abortSignal: context.abortSignal, beforePublication: context.workflow!.beforePublication, exactInput: input, identity: checkpointIdentity(context), workspaceDirectory: context.workflow!.workspaceDirectory };
    const recovered = await reconcileLocalVerifiedReceiptOperation(context.application, request);
    expect(recovered).toMatchObject({ kind: "completed", output });
    expect(calls.execute).toBe(0);
    port.reconcile = async () => ({ kind: "ambiguous", message: "No authoritative native receipt." });
    expect(await reconcileLocalVerifiedReceiptOperation(context.application, request)).toMatchObject({ kind: "ambiguous" });
    expect(calls.execute).toBe(0);
  });
});

test("recovery rejects conflicting checkpoints and preserves unknown custody without executing", async () => {
  await withHost(async ({ context, calls, port }) => {
    const { input, output } = studioOperationFixture();
    expect(await reconcileStudioRun(context, input, { ...output, receipt: { ...output.receipt, sha256: "c".repeat(64) } })).toMatchObject({ kind: "incompatible" });
    port.reconcile = async () => ({ kind: "completed", output: { ...output, document: { ...output.document, state: "unknown-custody", custody: "unknown", exitCode: null, failure: { code: "custody", message: "Native ownership unresolved." } } } });
    expect(await reconcileStudioRun(context, input)).toMatchObject({ kind: "ambiguous" });
    const authorized = { ...context, application: { ...context.application, studioAuthorization: { authorize: async () => true } } };
    port.execute = async () => { calls.execute++; const recovered = await port.reconcile(input, {} as StudioHostControl); if (recovered.kind !== "completed") throw new Error("fixture"); return recovered.output; };
    await expect(executeStudioRun(authorized, input)).rejects.toMatchObject({ code: "ambiguous", details: { receipt: output.receipt, state: "unknown-custody" } });
    expect(calls.execute).toBe(1);
  });
});
