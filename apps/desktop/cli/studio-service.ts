import { randomUUID } from "node:crypto";
import { join, relative } from "node:path";
import { z } from "zod";
import {
  parseStudioJob, parseStudioPlan, parseStudioSourceBundle, planStudioJob, studioRuntimeSha256, studioSourceBundleSha256,
  validateStudioReceipt, type StudioJob, type StudioPlan, type StudioReceipt, type StudioSourceBundle,
} from "../../../src/studio";
import type { ApplicationContext } from "../application/context";
import {
  MediaArtifactReferenceSchema, type MediaArtifactReference, type MediaArtifactRequest,
} from "../application/operations/media/shared";
import {
  BoundStudioRunInputSchema, StudioRunOutputSchema, type ApplicationStudioPort, type StudioBindingControl, type StudioRunOutput,
} from "../application/studio-port";
import { createNodeBundleFileSystem, type BundleFileSystem } from "../core/storage";
import { CliError } from "./errors";
import { withMutationLock } from "./mutation-lock";
import { ensurePhysicalPrivateDirectoryWithin, ensurePrivateDirectory } from "./paths";
import { withStudioProcessCustody } from "./studio-custody";
import {
  copyStudioSource, inspectStudioOutputs, inventoryStudioFiles, studioJson, verifyStudioSource,
} from "./studio-files";
import { validateStudioOutputMedia } from "./studio-output-validation";
import { NativeStudioProcess, type StudioProcessPort } from "./studio-process";
import { probeStudioRuntime, studioDriverArgv, type StudioRuntimeSelection } from "./studio-runtime";

export interface StudioServiceOptions {
  readonly application: ApplicationContext; readonly selection: StudioRuntimeSelection;
  readonly process?: StudioProcessPort;
}
export interface StudioExecutionControl {
  readonly signal: AbortSignal; readonly allowTrustedCode: true;
  readonly inheritedFileDescriptors?: readonly number[];
  readonly workflow?: { readonly runId: string; readonly nodeKey: string; readonly nodePlanSha256: string };
  /** Host monotonic deadline shared by native rendering and all output verification. */
  readonly deadlineAt?: number;
  beforePublication(): Promise<void>;
}

const completionSchema = z.strictObject({
  kind: z.literal("slopcamera.studio-completion"), schemaVersion: z.literal(1), attemptId: z.string(), planSha256: z.string(),
  startedAt: z.iso.datetime({ offset: true }), finishedAt: z.iso.datetime({ offset: true }),
  exitCode: z.number().int().nullable(), custody: z.enum(["closed", "unknown"]),
  failure: z.enum(["cancelled", "timeout", "output-limit", "spawn", "descendants"]).optional(),
});

async function optionalJson(fs: BundleFileSystem, path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await fs.readText(path, 32 * 1024 * 1024)) as unknown; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}
async function immutableJson(fs: BundleFileSystem, path: string, value: unknown, fence: () => Promise<void>): Promise<void> {
  const text = studioJson(value), disposition = await fs.writeTextNoReplace!(path, text, fence);
  if (disposition !== "created" && await fs.readText(path) !== text) throw new CliError("conflict", `Retained studio document differs: ${path}`);
}
export async function studioStorageRoot(application: ApplicationContext): Promise<string> {
  await ensurePrivateDirectory(application.paths.privateRoot);
  return await ensurePhysicalPrivateDirectoryWithin(application.paths.privateRoot, "studio");
}

export async function readRetainedStudioBundle(application: ApplicationContext, job: StudioJob, requested?: MediaArtifactRequest): Promise<{ readonly bundle: StudioSourceBundle; readonly sourceRoot: string; readonly reference: MediaArtifactReference }> {
  const root = await studioStorageRoot(application), directory = join(root, "bundles", job.bundleSha256);
  const path = relative(application.paths.repositoryRoot, join(directory, "bundle.json"));
  if (requested !== undefined && requested.path !== path) throw new CliError("unsafe-path", "Studio execution requires the exact retained bundle manifest returned by studio bundle.");
  const fs = createNodeBundleFileSystem(application.paths.repositoryRoot), integrity = await fs.inspectFile!(path, 1024 * 1024);
  if (requested !== undefined && "sha256" in requested && (requested.sha256 !== integrity.sha256 || requested.bytes !== integrity.bytes)) throw new CliError("conflict", "Retained studio manifest bytes changed.");
  const bundle = parseStudioSourceBundle(JSON.parse(await fs.readText(path, 1024 * 1024)) as unknown);
  if (studioSourceBundleSha256(bundle) !== job.bundleSha256) throw new CliError("conflict", "Studio bundle digest differs from the requested job.");
  const sourceRoot = join(directory, "source");
  await verifyStudioSource(sourceRoot, bundle);
  return { bundle, sourceRoot, reference: MediaArtifactReferenceSchema.parse({ path, ...integrity }) };
}

export function createStudioService(options: StudioServiceOptions) {
  const application = options.application, native = options.process ?? new NativeStudioProcess();
  const applicationFence = async () => { await application.hostResourceLease?.assertOwned(); };
  const withCustody = async <T>(signal: AbortSignal, fence: () => Promise<void>, execute: (process: StudioProcessPort) => Promise<T>): Promise<T> => {
    if (application.machineStateRoot === undefined) throw new CliError("unavailable", "Native studio execution requires machine-wide custody storage.");
    await ensurePrivateDirectory(application.machineStateRoot);
    return await withStudioProcessCustody({ machineStateRoot: application.machineStateRoot, process: native, label: "SLOPCAMERA native studio", signal, fence }, execute);
  };

  const plan = async (jobInput: unknown): Promise<StudioPlan> => {
    const job = parseStudioJob(jobInput), retained = await readRetainedStudioBundle(application, job);
    return planStudioJob({ bundle: retained.bundle, job });
  };

  const bind = async (jobInput: unknown, signal: AbortSignal, requested?: MediaArtifactRequest, expected?: StudioPlan, control?: StudioBindingControl): Promise<StudioPlan> => {
    const job = parseStudioJob(jobInput), retained = await readRetainedStudioBundle(application, job, requested);
    const root = await studioStorageRoot(application), workingRoot = await ensurePhysicalPrivateDirectoryWithin(root, `probes/probe_${randomUUID()}`);
    const fence = async () => { await applicationFence(); await control?.beforePublication(); };
    const inheritedFileDescriptors = control?.inheritedFileDescriptors ?? application.hostResourceLease?.inheritedFileDescriptors;
    return await withCustody(signal, fence, async process => {
      const runtime = await probeStudioRuntime({ engine: retained.bundle.engine, selection: options.selection, workingRoot, process, signal, fence,
        ...(inheritedFileDescriptors === undefined ? {} : { inheritedFileDescriptors }) });
      const bound = planStudioJob({ bundle: retained.bundle, job, runtime: runtime.identity });
      if (expected !== undefined && bound.planSha256 !== parseStudioPlan(expected).planSha256) throw new CliError("incompatible", "Studio source, settings or observed runtime changed after planning.");
      await immutableJson(createNodeBundleFileSystem(workingRoot), "probe.json", runtime.identity, fence);
      return bound;
    });
  };

  const inspect = async (jobId: string): Promise<StudioRunOutput> => {
    if (!/^studio_[a-zA-Z0-9][a-zA-Z0-9_-]{0,120}$/u.test(jobId)) throw new CliError("invalid-data", "Invalid studio job ID.");
    const root = await studioStorageRoot(application), directory = join(root, "jobs", jobId), fs = createNodeBundleFileSystem(directory);
    const planned = parseStudioPlan(await optionalJson(fs, "plan.json"));
    const receipt = validateStudioReceipt({ plan: planned, receipt: await optionalJson(fs, "receipt.json") });
    const artifacts = await inspectStudioOutputs(join(directory, "outputs"), planned.job);
    if (studioJson(artifacts) !== studioJson(receipt.outputs)) throw new CliError("conflict", "Studio output files differ from the retained receipt.");
    await verifyStudioSource(join(directory, "source"), planned.bundle);
    const receiptPath = relative(application.paths.repositoryRoot, join(directory, "receipt.json"));
    const integrity = await createNodeBundleFileSystem(application.paths.repositoryRoot).inspectFile!(receiptPath, 32 * 1024 * 1024);
    return StudioRunOutputSchema.parse({ receipt: { path: receiptPath, ...integrity }, document: receipt,
      outputs: receipt.outputs.map(item => ({ outputId: item.outputId, role: item.role, format: item.format,
        artifact: { path: relative(application.paths.repositoryRoot, join(directory, "outputs", item.path)), sha256: item.sha256, bytes: item.bytes } })) });
  };

  const runOnce = async (jobInput: unknown, control: StudioExecutionControl, expected?: StudioPlan): Promise<StudioRunOutput> => {
    if (control.allowTrustedCode !== true) throw new CliError("authorization-required", "Native source requires explicit --allow-trusted-code authorization.");
    if (control.signal.aborted) throw new CliError("cancelled", "Studio execution cancelled before dispatch.");
    const job = parseStudioJob(jobInput), retained = await readRetainedStudioBundle(application, job);
    const root = await studioStorageRoot(application), directory = await ensurePhysicalPrivateDirectoryWithin(root, `jobs/${job.jobId}`);
    return await withMutationLock(directory, { command: "studio run", label: job.jobId }, async lease => {
      const fence = async () => { await applicationFence(); await control.beforePublication(); await lease.assertOwned(); };
      const terminalFence = async () => { await lease.assertOwned(); };
      const fs = createNodeBundleFileSystem(directory), priorPlan = await optionalJson(fs, "plan.json"), priorReceipt = await optionalJson(fs, "receipt.json");
      if (priorPlan !== undefined) {
        const previous = parseStudioPlan(priorPlan);
        const now = planStudioJob({ bundle: retained.bundle, job, runtime: previous.runtime });
        if (previous.planSha256 !== now.planSha256 || expected !== undefined && previous.planSha256 !== expected.planSha256) throw new CliError("conflict", "Studio job ID already binds a different plan. Retain it and choose a new job ID.");
        if (priorReceipt !== undefined) {
          await fence();
          const previousReceipt = validateStudioReceipt({ plan: previous, receipt: priorReceipt });
          if (previousReceipt.state !== "succeeded") throw new CliError(previousReceipt.state === "unknown-custody" ? "ambiguous" : "subprocess", "Studio job did not complete successfully; its retained failure will not be rerun automatically.", { jobId: job.jobId, state: previousReceipt.state });
          return await inspect(job.jobId);
        }
        throw new CliError("ambiguous", "Studio job has retained execution intent without a receipt. Inspect and reconcile it; it will not be rerun automatically.");
      }
      const sourceRoot = await ensurePhysicalPrivateDirectoryWithin(directory, "source"), outputRoot = await ensurePhysicalPrivateDirectoryWithin(directory, "outputs"), workingRoot = await ensurePhysicalPrivateDirectoryWithin(directory, "working");
      await copyStudioSource(retained.sourceRoot, sourceRoot, retained.bundle, fence);
      await verifyStudioSource(sourceRoot, retained.bundle);
      if ((await inventoryStudioFiles(outputRoot, job.limits.maximumOutputFiles, job.limits.maximumOutputBytes)).length !== 0) throw new CliError("conflict", "Studio output directory already contains unreceipted files.");
      return await withCustody(control.signal, fence, async supervised => {
        let unknownCustody = false;
        const process: StudioProcessPort = { run: async (argv, processOptions) => {
          try {
            const observed = await supervised.run(argv, processOptions);
            if (observed.custody === "unknown") unknownCustody = true;
            return observed;
          } catch (error) { unknownCustody = true; throw error; }
        } };
        const runtime = await probeStudioRuntime({ engine: retained.bundle.engine, selection: options.selection, workingRoot, process, signal: control.signal, fence,
          ...(control.inheritedFileDescriptors === undefined ? {} : { inheritedFileDescriptors: control.inheritedFileDescriptors }) });
        const planned = planStudioJob({ bundle: retained.bundle, job, runtime: runtime.identity });
        if (expected !== undefined && planned.planSha256 !== parseStudioPlan(expected).planSha256) throw new CliError("incompatible", "Native runtime differs from the bound studio plan.");
        if (planned.readiness !== "authorization-required") throw new CliError("unavailable", "The installed native runtime has not reported every capability required by this job.", { checks: planned.capabilityChecks });
        const attemptId = `attempt_${randomUUID()}`, startedAt = application.clock.now().toISOString();
        await immutableJson(fs, "plan.json", planned, fence);
        await immutableJson(fs, "intent.json", { kind: "slopcamera.studio-intent", schemaVersion: 1, attemptId, startedAt, planSha256: planned.planSha256,
          ...(control.workflow === undefined ? {} : { workflow: control.workflow }) }, fence);
        await immutableJson(fs, "working/request.json", { bundle: retained.bundle, job, sourceRoot, outputRoot, workingRoot }, fence);
        let budgetFailure: { readonly stage: string; readonly code: string } | undefined;
        const assertBudget = async () => {
          let stage = "publication-fence";
          try {
            await fence();
            stage = "output-inventory";
            await inventoryStudioFiles(outputRoot, job.limits.maximumOutputFiles, job.limits.maximumOutputBytes, "live");
            stage = "working-inventory";
            await inventoryStudioFiles(workingRoot, job.limits.maximumOutputFiles + 2048, job.limits.maximumOutputBytes + 64 * 1024 * 1024, "live");
          } catch (error) {
            const code = error instanceof Error && "code" in error && typeof error.code === "string"
              && ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "ELOOP"].includes(error.code) ? error.code : "inventory-or-fence-rejected";
            budgetFailure ??= { stage, code };
            throw error;
          }
        };
        await assertBudget();
        const result = await process.run(studioDriverArgv(runtime, retained.bundle.engine, { request: join(workingRoot, "request.json") }), {
          cwd: workingRoot, env: runtime.environment, timeoutMs: Math.max(1, Math.ceil(Math.min(job.limits.timeoutSeconds * 1000, (control.deadlineAt ?? Infinity) - performance.now()))), maximumLogBytes: 4_194_304,
          signal: control.signal, assertBudget,
          ...(control.inheritedFileDescriptors === undefined ? {} : { inheritedFileDescriptors: control.inheritedFileDescriptors }),
          onSpawn: async pid => await immutableJson(fs, "process.json", { attemptId, processGroup: pid, planSha256: planned.planSha256 }, fence),
        });
        const finishedAt = application.clock.now().toISOString();
        await immutableJson(fs, "completion.json", { kind: "slopcamera.studio-completion", schemaVersion: 1, attemptId, planSha256: planned.planSha256, startedAt, finishedAt,
          exitCode: result.exitCode, custody: result.custody, ...(result.failure === undefined ? {} : { failure: result.failure }) }, terminalFence);
        await fs.writeTextNoReplace!("stdout.log", result.stdout, terminalFence);
        await fs.writeTextNoReplace!("stderr.log", result.stderr, terminalFence);
        if (budgetFailure !== undefined) await immutableJson(fs, "budget-failure.json", {
          kind: "slopcamera.studio-budget-failure", schemaVersion: 1, planSha256: planned.planSha256, ...budgetFailure,
        }, terminalFence);
        let outputs: StudioReceipt["outputs"] = [], validationFailure = false;
        let validationStage = "output-inventory";
        try {
          outputs = await inspectStudioOutputs(outputRoot, job);
          validationStage = "source-integrity";
          await verifyStudioSource(sourceRoot, retained.bundle);
          await verifyStudioSource(retained.sourceRoot, retained.bundle);
          if (result.custody === "closed" && result.exitCode === 0 && result.failure === undefined) {
            validationStage = "media-validation";
            const verified = await validateStudioOutputMedia({ application, process, root: outputRoot, job, outputs, signal: control.signal, cwd: workingRoot, env: runtime.environment, fence,
              ...(control.inheritedFileDescriptors === undefined ? {} : { inheritedFileDescriptors: control.inheritedFileDescriptors }) });
            validationStage = "runtime-identity";
            const after = await probeStudioRuntime({ engine: retained.bundle.engine, selection: options.selection, workingRoot, process, signal: control.signal, fence,
              ...(control.inheritedFileDescriptors === undefined ? {} : { inheritedFileDescriptors: control.inheritedFileDescriptors }) });
            if (studioRuntimeSha256(after.identity) !== planned.runtimeSha256) throw new Error("Studio runtime changed during execution.");
            validationStage = "working-inventory";
            await inventoryStudioFiles(workingRoot, job.limits.maximumOutputFiles + 2048, job.limits.maximumOutputBytes + 64 * 1024 * 1024);
            validationStage = "output-recheck";
            const rechecked = await inspectStudioOutputs(outputRoot, job);
            if (studioJson(outputs) !== studioJson(rechecked)) throw new Error("Studio outputs changed during validation.");
            validationStage = "validation-publication";
            await immutableJson(fs, "validation.json", { kind: "slopcamera.studio-output-validation", schemaVersion: 1, planSha256: planned.planSha256, runtimeSha256: planned.runtimeSha256, artifacts: outputs, outputs: verified }, fence);
          }
        } catch {
          validationFailure = true;
          // A closed set of host stages records the failed check without persisting foreign exceptions or native output.
          await immutableJson(fs, "validation-failure.json", { kind: "slopcamera.studio-validation-failure", schemaVersion: 1,
            planSha256: planned.planSha256, stage: validationStage, custody: unknownCustody ? "unknown" : "closed",
            cancelled: control.signal.aborted }, terminalFence);
        }
        const state = unknownCustody ? "unknown-custody" : result.exitCode === 0 && result.failure === undefined && !validationFailure && !control.signal.aborted ? "succeeded" : "failed";
        const failureCode = unknownCustody ? "custody" : (control.deadlineAt ?? Infinity) <= performance.now() || result.failure === "timeout" ? "deadline" : control.signal.aborted || result.failure === "cancelled" ? "cancelled" : validationFailure ? "validation" : "subprocess";
        const receiptInput = {
          kind: "slopcamera.studio-receipt", schemaVersion: 1, jobId: job.jobId, attemptId, planSha256: planned.planSha256,
          bundleSha256: planned.bundleSha256, jobSha256: planned.jobSha256, runtime: runtime.identity, runtimeSha256: planned.runtimeSha256,
          startedAt, finishedAt: application.clock.now().toISOString(), outputs, state, custody: unknownCustody ? "unknown" : "closed",
          exitCode: result.exitCode, ...(state === "succeeded" ? {} : { failure: { code: failureCode, message: "Native studio execution did not qualify for successful publication. Retain its private diagnostics and partial evidence." } }),
        };
        let document: StudioReceipt;
        try { document = validateStudioReceipt({ plan: planned, receipt: receiptInput }); }
        catch (error) {
          if (state !== "succeeded") throw error;
          document = validateStudioReceipt({ plan: planned, receipt: { ...receiptInput, state: "failed", custody: "closed", failure: { code: "validation", message: "Native outputs do not cover the complete declared job. Retain the partial evidence and use a new job for a revised attempt." } } });
        }
        await immutableJson(fs, "receipt.json", document, document.state === "succeeded" ? async () => {
          if (control.signal.aborted) throw new CliError("cancelled", "Studio success publication was cancelled; retain its completed validation checkpoint.");
          await fence();
        } : terminalFence);
        if (document.state !== "succeeded") throw new CliError(document.state === "unknown-custody" ? "ambiguous" : "subprocess", "Studio job did not complete successfully; its receipt and private diagnostics are retained.", { jobId: job.jobId, receipt: relative(application.paths.repositoryRoot, join(directory, "receipt.json")), state: document.state });
        return await inspect(job.jobId);
      });
    });
  };

  const run = async (jobInput: unknown, control: StudioExecutionControl, expected?: StudioPlan): Promise<StudioRunOutput> => {
    const job = parseStudioJob(jobInput), controller = new AbortController();
    const deadlineAt = Math.min(control.deadlineAt ?? Infinity, performance.now() + job.limits.timeoutSeconds * 1000);
    const abort = () => controller.abort();
    control.signal.addEventListener("abort", abort, { once: true });
    if (control.signal.aborted) abort();
    const timer = setTimeout(abort, Math.max(1, Math.ceil(deadlineAt - performance.now())));
    try { return await runOnce(job, { ...control, signal: controller.signal, deadlineAt }, expected); }
    finally { clearTimeout(timer); control.signal.removeEventListener("abort", abort); }
  };

  /** Recover only the post-validation publication window. Earlier ambiguity never authorizes rerendering. */
  const reconcile = async (jobId: string, fence: () => Promise<void> = applicationFence, expectedPlanSha256?: string): Promise<StudioRunOutput> => {
    if (!/^studio_[a-zA-Z0-9][a-zA-Z0-9_-]{0,120}$/u.test(jobId)) throw new CliError("invalid-data", "Invalid studio job ID.");
    const root = await studioStorageRoot(application), directory = join(root, "jobs", jobId), fs = createNodeBundleFileSystem(directory);
    return await withMutationLock(directory, { command: "studio reconcile", label: jobId }, async lease => {
      const guard = async () => { await fence(); await lease.assertOwned(); };
      const planned = parseStudioPlan(await optionalJson(fs, "plan.json"));
      if (expectedPlanSha256 !== undefined && planned.planSha256 !== expectedPlanSha256) throw new CliError("conflict", "Retained studio plan differs from the requested recovery identity.");
      if (await optionalJson(fs, "receipt.json") !== undefined) { await guard(); return await inspect(jobId); }
      const completion = completionSchema.parse(await optionalJson(fs, "completion.json"));
      const validation = z.object({ kind: z.literal("slopcamera.studio-output-validation"), schemaVersion: z.literal(1), planSha256: z.string(), runtimeSha256: z.string(), artifacts: z.array(z.unknown()).max(25_000) }).parse(await optionalJson(fs, "validation.json"));
      if (completion.planSha256 !== planned.planSha256 || completion.custody !== "closed" || completion.exitCode !== 0 || completion.failure !== undefined
        || validation.planSha256 !== planned.planSha256 || validation.runtimeSha256 !== planned.runtimeSha256) throw new CliError("ambiguous", "Studio execution lacks a matching closed successful completion and validation checkpoint.");
      await verifyStudioSource(join(directory, "source"), planned.bundle);
      const outputs = await inspectStudioOutputs(join(directory, "outputs"), planned.job);
      if (studioJson(outputs) !== studioJson(validation.artifacts)) throw new CliError("conflict", "Studio outputs changed after the retained validation checkpoint.");
      const receipt = validateStudioReceipt({ plan: planned, receipt: {
        kind: "slopcamera.studio-receipt", schemaVersion: 1, jobId, attemptId: completion.attemptId, planSha256: planned.planSha256,
        bundleSha256: planned.bundleSha256, jobSha256: planned.jobSha256, runtime: planned.runtime, runtimeSha256: planned.runtimeSha256,
        startedAt: completion.startedAt, finishedAt: application.clock.now().toISOString(), outputs, state: "succeeded", custody: "closed", exitCode: 0,
      } });
      await immutableJson(fs, "receipt.json", receipt, guard);
      return await inspect(jobId);
    });
  };

  const port: ApplicationStudioPort = {
    bind: async (input, signal, control) => {
      const planned = await bind(input.job, signal, input.bundle, input.plan, control);
      const retained = await readRetainedStudioBundle(application, planned.job, input.bundle);
      return BoundStudioRunInputSchema.parse({ bundle: retained.reference, job: planned.job, plan: planned });
    },
    execute: async (input, control) => await run(input.job, { signal: control.signal, allowTrustedCode: control.allowTrustedCode,
      inheritedFileDescriptors: control.inheritedFileDescriptors, workflow: control.identity, beforePublication: () => control.beforePublication() }, input.plan),
    reconcile: async (input, control) => {
      try {
        await control.beforePublication();
        const result = await reconcile(input.job.jobId, () => control.beforePublication(), input.plan.planSha256);
        if (result.document.planSha256 !== input.plan.planSha256 || result.document.state !== "succeeded") return { kind: "incompatible", message: "Retained studio result differs from the bound successful plan." };
        return { kind: "completed", output: result };
      } catch { return { kind: "ambiguous", message: "No complete verified studio receipt exists. Native execution will not be resubmitted automatically." }; }
    },
  };
  return { plan, bind, run, inspect, reconcile, port };
}
