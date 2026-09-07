import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  sep,
} from "node:path";

import { Cause, Context, Effect, Exit, Option, Ref } from "effect";
import { z } from "zod";

import {
  ProjectRenderTargetSchema,
  ProjectRenderOutputRequestSchema,
  ProjectRenderSyncPolicySchema,
  ProjectRenderToolIdentitySchema,
  ProjectRenderToolchainSchema,
  resolveProjectRenderTarget,
  type ProjectRenderToolIdentity,
  type ProjectRenderToolchain,
  type ProjectRenderPlanV1,
} from "../../../contracts";
import {
  canonicalJson,
  canonicalJsonSha256,
  sha256Hex,
} from "../../../core";
import { AtomicRenderPlatform, executeAtomicRenderEffect } from "../../../cli/atomic-render-effects";
import { AtomicRenderPlatformLive } from "../../../cli/atomic-render-platform";
import {
  buildProjectFfmpegInvocation,
  reverifyProjectRenderInputs,
} from "../../../cli/project-renderer";
import {
  resolveVerifiedProjectMedia,
} from "../../../cli/project-media-integrity";
import {
  ensurePhysicalPrivateDirectoryWithin,
} from "../../../cli/paths";
import type {
  ApplicationCapability,
  ApplicationContext,
  ApplicationProcessRunner,
} from "../../context";
import {
  ExactCapabilityApplicationRunner,
  bindExactCapability,
} from "../../capability-binding";
import { ApplicationError, errorMessage } from "../../errors";
import type { OperationDefinition, OperationExecutionContext } from "../../operation";
import {
  operationBoundary,
  operationExitValue,
  operationFinally,
  operationValidation,
  runStandaloneOperation,
  type OperationEffectFailure,
  type OperationFailurePhase,
} from "../../operation-effects";
import { withOutputPublicationLeaseEffect } from "../../output-publication-lease";
import {
  ProjectRenderOutputReferenceSchema,
  ProjectRenderPlanReferenceSchema,
  ProjectRenderReceiptReferenceSchema,
  ProjectRenderReceiptV2Schema,
  createProjectRenderReceiptV2,
  type ProjectRenderOutputReference,
  type ProjectRenderReceiptReference,
} from "../../receipts";
import { throwIfAborted } from "../shared";
import {
  CandidateProjectRendererAbiSchema,
  CandidateProjectRenderInputSchema,
  assertCurrentCandidateProjectRendererAbi,
  type CandidateProjectRenderInput,
} from "./bind-candidate-output";
import {
  exactProjectDirectory,
  loadExactProjectRenderPlan,
} from "./project-plan";

const PROJECT_RENDER_MAX_DURATION_MS = 6 * 60 * 60_000;
const PROJECT_RENDER_PRECOMMIT_FILE =
  "project-render-publication-precommit.v1.json";
const PROJECT_RENDER_PRECOMMIT_MAXIMUM_BYTES = 256 * 1_024;
const PROJECT_RENDER_PRECOMMIT_DOMAIN =
  "studio.project-render-publication-precommit/v1";
const CANDIDATE_RENDER_REUSE_RECORD_DOMAIN =
  "atet.candidate-render-reuse-record/v1";

class ProjectRenderServices extends Context.Tag("@atet/local/ProjectRenderServices")<
  ProjectRenderServices, ApplicationContext
>() { }

/** Finite native verification/publication must settle before its enclosing lease can close. */
function renderBoundary<A>(
  phase: OperationFailurePhase,
  execute: () => A | Promise<A>,
): Effect.Effect<A, OperationEffectFailure> {
  return Effect.uninterruptible(operationBoundary(phase, execute));
}

function renderValidation<A>(evaluate: () => A): Effect.Effect<A, OperationEffectFailure> {
  return operationValidation("project", evaluate);
}

/** Join every admitted native read while retaining Promise.all's first rejection identity. */
function renderPathsExist(paths: readonly string[]): Effect.Effect<readonly boolean[], OperationEffectFailure> {
  return Effect.uninterruptible(Effect.gen(function*() {
    const firstFailure = yield* Ref.make(Option.none<number>());
    const results = yield* Effect.forEach(paths, (path, index) => Effect.tap(
      Effect.exit(renderBoundary("publication", () => pathExists(path))),
      exit => Exit.isSuccess(exit) ? Effect.void : Ref.update(firstFailure, current =>
        Option.isNone(current) ? Option.some(index) : current),
    ), { concurrency: "unbounded" });
    const selected = yield* Ref.get(firstFailure);
    if (Option.isSome(selected)) {
      const first = results[selected.value];
      if (first !== undefined && Exit.isFailure(first)) {
        const otherCauses = results.reduce<Cause.Cause<OperationEffectFailure>>((cause, result, index) =>
          index === selected.value || Exit.isSuccess(result) ? cause : Cause.parallel(cause, result.cause), Cause.empty);
        // Select only the first native rejection at the public boundary. Later
        // failures are retained privately by the same native-finally envelope.
        if (Cause.isEmpty(otherCauses)) return yield* Effect.failCause(first.cause);
        return yield* operationFinally(Effect.failCause(otherCauses), Effect.asVoid(first));
      }
    }
    return yield* Effect.forEach(results, result => result);
  }));
}

const ProjectRenderExecutionIdentitySchema = z.strictObject({
  nodeKey: z.string()
    .min(1)
    .max(255)
    .regex(
      /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*(?:\/[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*)*$/u,
    ),
  nodePlanSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  runId: z.string().regex(/^run_[a-z0-9][a-z0-9_-]{5,95}$/u),
});

const ProjectRenderPublicationPrecommitBodySchema = z.strictObject({
  kind: z.union([
    z.literal("atet.project-render-publication-precommit"),
    z.literal("studio.project-render-publication-precommit"),
  ]),
  receipt: ProjectRenderReceiptV2Schema,
  receiptContentsSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  schemaVersion: z.literal(1),
});

const ProjectRenderPublicationPrecommitSchema =
  ProjectRenderPublicationPrecommitBodySchema.extend({
    precommitSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict().superRefine((precommit, context) => {
    const receiptContents = `${canonicalJson(precommit.receipt)}\n`;
    if (sha256Hex(receiptContents) !== precommit.receiptContentsSha256) {
      context.addIssue({
        code: "custom",
        message: "Render publication precommit receipt digest is invalid.",
        path: ["receiptContentsSha256"],
      });
    }
    const body = ProjectRenderPublicationPrecommitBodySchema.parse({
      kind: precommit.kind,
      receipt: precommit.receipt,
      receiptContentsSha256: precommit.receiptContentsSha256,
      schemaVersion: precommit.schemaVersion,
    });
    if (
      canonicalJsonSha256({
        domain: PROJECT_RENDER_PRECOMMIT_DOMAIN,
        ...body,
      }) !== precommit.precommitSha256
    ) {
      context.addIssue({
        code: "custom",
        message: "Render publication precommit domain digest is invalid.",
        path: ["precommitSha256"],
      });
    }
  });

type ProjectRenderPublicationPrecommit = z.infer<
  typeof ProjectRenderPublicationPrecommitSchema
>;

const CandidateRenderReuseRecordBodyV1Schema = z.strictObject({
  derivationSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  kind: z.union([
    z.literal("atet.candidate-render-reuse-record"),
  ]),
  output: ProjectRenderOutputReferenceSchema,
  rendererAbi: CandidateProjectRendererAbiSchema,
  schemaVersion: z.literal(1),
  sourceReceipt: ProjectRenderReceiptReferenceSchema,
});

const CandidateRenderReuseRecordV1Schema =
  CandidateRenderReuseRecordBodyV1Schema.extend({
    recordSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict().superRefine((record, context) => {
    const body = CandidateRenderReuseRecordBodyV1Schema.parse({
      derivationSha256: record.derivationSha256,
      inputSha256: record.inputSha256,
      kind: record.kind,
      output: record.output,
      rendererAbi: record.rendererAbi,
      schemaVersion: record.schemaVersion,
      sourceReceipt: record.sourceReceipt,
    });
    if (
      record.output.projectId !== record.sourceReceipt.projectId
      || record.output.revisionSha256 !== record.sourceReceipt.revisionSha256
      || record.output.sha256 !== record.sourceReceipt.outputSha256
      || canonicalJsonSha256({
        domain: CANDIDATE_RENDER_REUSE_RECORD_DOMAIN,
        ...body,
      }) !== record.recordSha256
    ) {
      context.addIssue({
        code: "custom",
        message: "Candidate render reuse record is not bound to its exact output and source receipt.",
      });
    }
  });

type CandidateRenderReuseRecordV1 = z.infer<
  typeof CandidateRenderReuseRecordV1Schema
>;

const ProjectRenderUnboundInputSchema = z.strictObject({
  binding: ProjectRenderToolchainSchema.optional(),
  output: ProjectRenderOutputRequestSchema,
  plan: ProjectRenderPlanReferenceSchema,
  syncPolicy: ProjectRenderSyncPolicySchema,
});

const ProjectRenderUnboundInputSchemaV2 = z.strictObject({
  binding: ProjectRenderToolchainSchema.optional(),
  output: ProjectRenderOutputRequestSchema,
  plan: ProjectRenderPlanReferenceSchema,
  syncPolicy: ProjectRenderSyncPolicySchema,
  target: ProjectRenderTargetSchema,
});

export const ProjectRenderInputSchema = z.strictObject({
  binding: ProjectRenderToolchainSchema,
  output: ProjectRenderOutputRequestSchema,
  plan: ProjectRenderPlanReferenceSchema,
  syncPolicy: ProjectRenderSyncPolicySchema,
});

export const ProjectRenderInputSchemaV2 = z.strictObject({
  binding: ProjectRenderToolchainSchema,
  output: ProjectRenderOutputRequestSchema,
  plan: ProjectRenderPlanReferenceSchema,
  syncPolicy: ProjectRenderSyncPolicySchema,
  target: ProjectRenderTargetSchema,
});

export const ProjectRenderInputSchemaV3 = CandidateProjectRenderInputSchema;

export const ProjectRenderOutputSchema = z.strictObject({
  output: ProjectRenderOutputReferenceSchema,
  receipt: ProjectRenderReceiptReferenceSchema,
}).superRefine((output, context) => {
  if (
    output.output.projectId !== output.receipt.projectId
    || output.output.revisionSha256 !== output.receipt.revisionSha256
    || output.output.sha256 !== output.receipt.outputSha256
  ) {
    context.addIssue({
      code: "custom",
      message: "Project render output and receipt references disagree.",
    });
  }
});

export type ProjectRenderInput = z.infer<typeof ProjectRenderInputSchema>;
export type ProjectRenderInputV2 = z.infer<typeof ProjectRenderInputSchemaV2>;
export type ProjectRenderInputV3 = z.infer<typeof ProjectRenderInputSchemaV3>;
export type ProjectRenderOutput = z.infer<typeof ProjectRenderOutputSchema>;

type AnyProjectRenderInput =
  | ProjectRenderInput
  | ProjectRenderInputV2
  | ProjectRenderInputV3;

export interface ProjectRenderExecutionIdentity {
  readonly nodeKey: string;
  readonly nodePlanSha256: string;
  readonly runId: string;
}

export interface ProjectRenderReconciliationControl {
  readonly abortSignal: AbortSignal;
  readonly beforePublication: () => Promise<void>;
}

export type ProjectRenderReconciliation =
  | {
    readonly kind: "completed";
    readonly output: ProjectRenderOutput;
  }
  | {
    readonly kind: "retry";
  }
  | {
    readonly kind: "conflict";
    readonly message: string;
  };

async function exactToolIdentity(
  capability: ApplicationCapability,
  name: ProjectRenderToolIdentity["name"],
  required: boolean,
): Promise<ProjectRenderToolIdentity | null> {
  if (
    !capability.available
    || capability.command === undefined
    || capability.command === ""
  ) {
    if (!required) return null;
    throw new ApplicationError(
      "unavailable",
      `${name} is unavailable: ${capability?.reason ?? "capability was not probed"}`,
      { capability: name },
    );
  }
  if (capability.version === undefined || capability.version.trim() === "") {
    throw new ApplicationError(
      "unavailable",
      `${name} did not provide an exact probed version identity.`,
      { capability: name },
    );
  }
  return ProjectRenderToolIdentitySchema.parse(
    await bindExactCapability(capability),
  );
}

export async function bindProjectRenderToolchain(
  application: ApplicationContext,
): Promise<ProjectRenderToolchain> {
  const [ffmpeg, ffprobe, rsvgConvert] = await Promise.all([
    application.capability("ffmpeg").then(capability => (
      exactToolIdentity(capability, "ffmpeg", true)
    )),
    application.capability("ffprobe").then(capability => (
      exactToolIdentity(capability, "ffprobe", true)
    )),
    application.capability("rsvg-convert").then(capability => (
      exactToolIdentity(capability, "rsvg-convert", false)
    )),
  ]);
  return ProjectRenderToolchainSchema.parse({
    ffmpeg,
    ffprobe,
    rsvgConvert,
  });
}

/**
 * Adds the host-probed toolchain to exact operation input before the scheduler
 * hashes its node plan. Authored workflows cannot substitute another binary.
 */
export async function bindProjectRenderInput(
  application: ApplicationContext,
  resolvedInput: unknown,
): Promise<ProjectRenderInput> {
  const requested = ProjectRenderUnboundInputSchema.parse(resolvedInput);
  const binding = await bindProjectRenderToolchain(application);
  if (
    requested.binding !== undefined
    && canonicalJson(requested.binding) !== canonicalJson(binding)
  ) {
    throw new ApplicationError(
      "conflict",
      "Project render tool binding changed after exact node planning.",
    );
  }
  return ProjectRenderInputSchema.parse({
    ...requested,
    binding,
  });
}

export async function bindProjectRenderInputV2(
  application: ApplicationContext,
  resolvedInput: unknown,
): Promise<ProjectRenderInputV2> {
  const requested = ProjectRenderUnboundInputSchemaV2.parse(resolvedInput);
  const binding = await bindProjectRenderToolchain(application);
  if (
    requested.binding !== undefined
    && canonicalJson(requested.binding) !== canonicalJson(binding)
  ) {
    throw new ApplicationError(
      "conflict",
      "Project render tool binding changed after exact node planning.",
    );
  }
  return ProjectRenderInputSchemaV2.parse({
    ...requested,
    binding,
  });
}

export async function bindProjectRenderInputV3(
  application: ApplicationContext,
  resolvedInput: unknown,
): Promise<ProjectRenderInputV3> {
  const requested = CandidateProjectRenderInputSchema.parse(resolvedInput);
  assertCurrentCandidateProjectRendererAbi(requested.derivation.rendererAbi);
  const binding = await bindProjectRenderToolchain(application);
  if (canonicalJson(requested.binding) !== canonicalJson(binding)) {
    throw new ApplicationError(
      "conflict",
      "Candidate render tool binding changed after exact node planning.",
    );
  }
  return ProjectRenderInputSchemaV3.parse({
    ...requested,
    binding,
    derivation: {
      ...requested.derivation,
      binding,
    },
  });
}

async function bindAnyProjectRenderInput(
  application: ApplicationContext,
  resolvedInput: unknown,
): Promise<AnyProjectRenderInput> {
  if (
    typeof resolvedInput === "object"
    && resolvedInput !== null
    && "derivation" in resolvedInput
  ) {
    return await bindProjectRenderInputV3(application, resolvedInput);
  }
  if (
    typeof resolvedInput === "object"
    && resolvedInput !== null
    && "target" in resolvedInput
  ) {
    return await bindProjectRenderInputV2(application, resolvedInput);
  }
  return await bindProjectRenderInput(application, resolvedInput);
}

function assertProjectRenderTarget(
  input: AnyProjectRenderInput,
  plan: ProjectRenderPlanV1,
): void {
  if (!("target" in input)) return;
  const expected = resolveProjectRenderTarget(input.target);
  if (
    plan.output.frameRate !== expected.frameRate
    || plan.output.pixelHeight !== expected.pixelHeight
    || plan.output.pixelWidth !== expected.pixelWidth
  ) {
    throw new ApplicationError(
      "conflict",
      "Project render plan geometry does not match its exact canvas target.",
      {
        actual: {
          frameRate: plan.output.frameRate,
          pixelHeight: plan.output.pixelHeight,
          pixelWidth: plan.output.pixelWidth,
        },
        expected,
      },
    );
  }
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (
    pathFromRoot !== ".."
    && !pathFromRoot.startsWith(`..${sep}`)
    && !isAbsolute(pathFromRoot)
  );
}

async function exactWorkflowWorkspace(
  application: ApplicationContext,
  requested: string,
): Promise<string> {
  const [privateRoot, details] = await Promise.all([
    realpath(application.paths.privateRoot),
    lstat(requested),
  ]);
  if (
    details.isSymbolicLink()
    || !details.isDirectory()
    || (details.mode & 0o077) !== 0
  ) {
    throw new ApplicationError(
      "unsafe-path",
      "Workflow render workspace must be a private physical directory.",
    );
  }
  const workspace = await realpath(requested);
  if (!isWithin(privateRoot, workspace) || workspace === privateRoot) {
    throw new ApplicationError(
      "unsafe-path",
      "Workflow render workspace must remain beneath the application private root.",
    );
  }
  return workspace;
}

function expectedWorkflowWorkspacePath(
  application: ApplicationContext,
  executionValue: ProjectRenderExecutionIdentity,
): string {
  const execution = ProjectRenderExecutionIdentitySchema.parse(executionValue);
  return join(
    application.paths.privateRoot,
    "workflow-runs",
    execution.runId,
    "staging",
    sha256Hex(execution.nodeKey),
    execution.nodePlanSha256,
  );
}

async function exactRunWorkflowWorkspace(
  application: ApplicationContext,
  execution: ProjectRenderExecutionIdentity,
  requested: string,
): Promise<string> {
  const workspace = await exactWorkflowWorkspace(application, requested);
  const expected = await realpath(expectedWorkflowWorkspacePath(
    application,
    execution,
  ));
  if (workspace !== expected) {
    throw new ApplicationError(
      "unsafe-path",
      "Workflow render workspace does not match its exact run and node plan.",
    );
  }
  return workspace;
}

function workflowRunner(
  runner: ApplicationProcessRunner,
  workspaceDirectory: string,
): ApplicationProcessRunner {
  return {
    run: async (argv, options = {}) => await runner.run(argv, {
      ...options,
      cwd: workspaceDirectory,
    }),
  };
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return false;
    throw error;
  }
}

function createPublicationPrecommit(
  receipt: z.infer<typeof ProjectRenderReceiptV2Schema>,
): ProjectRenderPublicationPrecommit {
  const receiptContentsSha256 = sha256Hex(`${canonicalJson(receipt)}\n`);
  const body = ProjectRenderPublicationPrecommitBodySchema.parse({
    kind: "atet.project-render-publication-precommit",
    receipt,
    receiptContentsSha256,
    schemaVersion: 1,
  });
  return ProjectRenderPublicationPrecommitSchema.parse({
    ...body,
    precommitSha256: canonicalJsonSha256({
      domain: PROJECT_RENDER_PRECOMMIT_DOMAIN,
      ...body,
    }),
  });
}

async function readPublicationPrecommit(
  workspace: string,
): Promise<ProjectRenderPublicationPrecommit | null> {
  const path = join(workspace, PROJECT_RENDER_PRECOMMIT_FILE);
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY
        | (constants.O_NOFOLLOW ?? 0)
        | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return null;
    throw error;
  }
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.nlink !== 1
      || before.size < 1
      || before.size > PROJECT_RENDER_PRECOMMIT_MAXIMUM_BYTES
      || (before.mode & 0o777) !== 0o600
    ) {
      throw new ApplicationError(
        "invalid-data",
        "Project render publication precommit is unsafe or exceeds its size bound.",
      );
    }
    const contents = await handle.readFile("utf8");
    const after = await handle.stat();
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      throw new ApplicationError(
        "conflict",
        "Project render publication precommit changed while it was read.",
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(contents) as unknown;
    } catch {
      throw new ApplicationError(
        "invalid-data",
        "Project render publication precommit is not valid JSON.",
      );
    }
    const precommit = ProjectRenderPublicationPrecommitSchema.parse(value);
    if (contents !== `${canonicalJson(precommit)}\n`) {
      throw new ApplicationError(
        "invalid-data",
        "Project render publication precommit is not canonical immutable JSON.",
      );
    }
    return precommit;
  } finally {
    await handle.close();
  }
}

async function publishPublicationPrecommit(
  workspace: string,
  precommit: ProjectRenderPublicationPrecommit,
): Promise<ProjectRenderPublicationPrecommit> {
  const target = join(workspace, PROJECT_RENDER_PRECOMMIT_FILE);
  const contents = `${canonicalJson(precommit)}\n`;
  const temporary = join(
    workspace,
    `.project-render-precommit-${randomUUID()}.tmp`,
  );
  let created = false;
  const handle = await open(
    temporary,
    constants.O_CREAT
      | constants.O_EXCL
      | constants.O_WRONLY
      | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    try {
      await link(temporary, target);
      created = true;
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) throw error;
    }
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    });
  }
  if (created) await syncDirectory(workspace);
  const published = await readPublicationPrecommit(workspace);
  if (published === null) {
    throw new ApplicationError(
      "conflict",
      "Project render publication precommit disappeared after publication.",
    );
  }
  return published;
}

async function requireFreshPublicationTargets(
  outputPath: string,
  receiptPath: string,
): Promise<void> {
  const [outputExists, receiptExists] = await Promise.all([
    pathExists(outputPath),
    pathExists(receiptPath),
  ]);
  if (outputExists || receiptExists) {
    throw new ApplicationError(
      "conflict",
      "Project render output or exact-run receipt already exists; immutable publication never replaces either path.",
      { outputExists, receiptExists },
    );
  }
}

function isCandidateProjectRenderInput(
  input: AnyProjectRenderInput,
): input is CandidateProjectRenderInput {
  return "derivation" in input;
}

function candidateRenderReuseRecordPath(
  input: CandidateProjectRenderInput,
): string {
  return `renders/receipts/derivations/${input.derivation.derivationSha256}.json`;
}

function receiptPath(nodePlanSha256: string): string {
  return `renders/receipts/${nodePlanSha256}.json`;
}

function receiptReference(
  contents: string,
  path: string,
  output: ProjectRenderOutputReference,
  receiptSha256: string,
  nodePlanSha256: string,
): ProjectRenderReceiptReference {
  return ProjectRenderReceiptReferenceSchema.parse({
    bytes: new TextEncoder().encode(contents).byteLength,
    kind: "atet.project-render-receipt-reference",
    nodePlanSha256,
    outputSha256: output.sha256,
    path,
    projectId: output.projectId,
    receiptSha256,
    revisionSha256: output.revisionSha256,
    schemaVersion: 2,
    sha256: sha256Hex(contents),
  });
}

function invocationMatchesExactRender(
  invocation: z.infer<typeof ProjectRenderReceiptV2Schema>["invocation"],
  outputAbsolute: string,
  renderPlanSha256: string,
): boolean {
  const filterIndex = invocation.arguments.indexOf("-filter_complex_script");
  const filterArgument = filterIndex < 0
    ? undefined
    : invocation.arguments[filterIndex + 1];
  const normalizedFilterPath = invocation.filterGraph.path.split("/").join(sep);
  return invocation.arguments.at(-1) === outputAbsolute
    && invocation.outputPath !== ""
    && invocation.renderPlanSha256 === renderPlanSha256
    && filterArgument !== undefined
    && filterArgument.endsWith(`${sep}${normalizedFilterPath}`);
}

function assertReceiptMatchesReusableRender(options: {
  readonly input: AnyProjectRenderInput;
  readonly outputAbsolute: string;
  readonly receipt: z.infer<typeof ProjectRenderReceiptV2Schema>;
  readonly renderPlanSha256: string;
}): void {
  const receipt = options.receipt;
  if (
    receipt.inputSha256 !== canonicalJsonSha256(options.input)
    || canonicalJson(receipt.plan) !== canonicalJson(options.input.plan)
    || receipt.syncPolicy !== options.input.syncPolicy
    || canonicalJson(receipt.toolchain)
      !== canonicalJson(options.input.binding)
    || receipt.output.path !== options.input.output.path
    || receipt.output.bytes > options.input.output.maximumBytes
    || receipt.invocation.outputPath !== options.input.output.path
    || !invocationMatchesExactRender(
      receipt.invocation,
      options.outputAbsolute,
      options.renderPlanSha256,
    )
  ) {
    throw new ApplicationError(
      "conflict",
      "Project render receipt is not reusable for the exact input, plan, toolchain, and invocation.",
    );
  }
}

function assertReceiptMatchesExactRender(options: {
  readonly execution: ProjectRenderExecutionIdentity;
  readonly input: AnyProjectRenderInput;
  readonly outputAbsolute: string;
  readonly receipt: z.infer<typeof ProjectRenderReceiptV2Schema>;
  readonly renderPlanSha256: string;
}): void {
  assertReceiptMatchesReusableRender(options);
  const execution = ProjectRenderExecutionIdentitySchema.parse(
    options.execution,
  );
  if (
    options.receipt.run.runId !== execution.runId
    || options.receipt.run.nodeKey !== execution.nodeKey
    || options.receipt.run.nodePlanSha256 !== execution.nodePlanSha256
  ) {
    throw new ApplicationError(
      "conflict",
      "Project render receipt is not bound to the exact input, run, plan, toolchain, and invocation.",
    );
  }
}

async function expectedWorkflowWorkspaceIfPresent(
  application: ApplicationContext,
  execution: ProjectRenderExecutionIdentity,
): Promise<string | null> {
  const expected = expectedWorkflowWorkspacePath(application, execution);
  try {
    return await exactWorkflowWorkspace(application, expected);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return null;
    throw error;
  }
}

async function publishReceiptNoReplace(options: {
  readonly application: ApplicationContext;
  readonly beforePublication?: () => Promise<void>;
  readonly contents: string;
  readonly execution: ProjectRenderExecutionIdentity;
  readonly input: AnyProjectRenderInput;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly contents: string;
  readonly receipt: z.infer<typeof ProjectRenderReceiptV2Schema>;
}> {
  const plan = await loadExactProjectRenderPlan(
    options.application,
    options.input.plan,
  );
  if (plan.fileSystem.writeTextNoReplace === undefined) {
    throw new ApplicationError(
      "internal",
      "Project storage does not support immutable render-receipt publication.",
    );
  }
  const path = receiptPath(options.execution.nodePlanSha256);
  if (options.signal !== undefined) throwIfAborted(options.signal);
  await options.beforePublication?.();
  if (options.signal !== undefined) throwIfAborted(options.signal);
  const disposition = await plan.fileSystem.writeTextNoReplace(
    path,
    options.contents,
  );
  const published = await readReceipt(
    options.application,
    options.input,
    options.execution,
  );
  if (published.contents !== options.contents) {
    throw new ApplicationError(
      "conflict",
      disposition === "exists"
        ? "Project render receipt path already contains different bytes."
        : "Published project render receipt contains different bytes.",
    );
  }
  return published;
}

async function readReceipt(
  application: ApplicationContext,
  input: AnyProjectRenderInput,
  execution: ProjectRenderExecutionIdentity,
): Promise<{
  readonly contents: string;
  readonly receipt: z.infer<typeof ProjectRenderReceiptV2Schema>;
}> {
  const plan = await loadExactProjectRenderPlan(application, input.plan);
  const path = receiptPath(execution.nodePlanSha256);
  const contents = await plan.fileSystem.readText(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw new ApplicationError(
      "conflict",
      "Existing project render receipt is not valid JSON.",
    );
  }
  const receipt = ProjectRenderReceiptV2Schema.parse(parsed);
  if (contents !== `${canonicalJson(receipt)}\n`) {
    throw new ApplicationError(
      "conflict",
      "Existing project render receipt is not its canonical V2 document.",
    );
  }
  return { contents, receipt };
}

function createCandidateRenderReuseRecord(options: {
  readonly input: CandidateProjectRenderInput;
  readonly receipt: z.infer<typeof ProjectRenderReceiptV2Schema>;
  readonly receiptContents: string;
}): CandidateRenderReuseRecordV1 {
  const sourceReceipt = receiptReference(
    options.receiptContents,
    receiptPath(options.receipt.run.nodePlanSha256),
    options.receipt.output,
    options.receipt.receiptSha256,
    options.receipt.run.nodePlanSha256,
  );
  const body = CandidateRenderReuseRecordBodyV1Schema.parse({
    derivationSha256: options.input.derivation.derivationSha256,
    inputSha256: canonicalJsonSha256(options.input),
    kind: "atet.candidate-render-reuse-record",
    output: options.receipt.output,
    rendererAbi: options.input.derivation.rendererAbi,
    schemaVersion: 1,
    sourceReceipt,
  });
  return CandidateRenderReuseRecordV1Schema.parse({
    ...body,
    recordSha256: canonicalJsonSha256({
      domain: CANDIDATE_RENDER_REUSE_RECORD_DOMAIN,
      ...body,
    }),
  });
}

async function readReceiptReference(options: {
  readonly fileSystem: Awaited<ReturnType<
    typeof loadExactProjectRenderPlan
  >>["fileSystem"];
  readonly reference: ProjectRenderReceiptReference;
}): Promise<{
  readonly contents: string;
  readonly receipt: z.infer<typeof ProjectRenderReceiptV2Schema>;
}> {
  const contents = await options.fileSystem.readText(options.reference.path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw new ApplicationError(
      "conflict",
      "Candidate render source receipt is not valid JSON.",
    );
  }
  const receipt = ProjectRenderReceiptV2Schema.parse(parsed);
  if (
    contents !== `${canonicalJson(receipt)}\n`
    || new TextEncoder().encode(contents).byteLength !== options.reference.bytes
    || sha256Hex(contents) !== options.reference.sha256
    || receipt.receiptSha256 !== options.reference.receiptSha256
    || receipt.run.nodePlanSha256 !== options.reference.nodePlanSha256
    || receipt.output.projectId !== options.reference.projectId
    || receipt.output.revisionSha256 !== options.reference.revisionSha256
    || receipt.output.sha256 !== options.reference.outputSha256
  ) {
    throw new ApplicationError(
      "conflict",
      "Candidate render source receipt does not match its immutable reference.",
    );
  }
  return { contents, receipt };
}

async function readCandidateRenderReuseRecord(options: {
  readonly exactPlan: Awaited<ReturnType<typeof loadExactProjectRenderPlan>>;
  readonly input: CandidateProjectRenderInput;
  readonly outputAbsolute: string;
}): Promise<{
  readonly record: CandidateRenderReuseRecordV1;
  readonly receipt: z.infer<typeof ProjectRenderReceiptV2Schema>;
  readonly receiptContents: string;
}> {
  const path = candidateRenderReuseRecordPath(options.input);
  const contents = await options.exactPlan.fileSystem.readText(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw new ApplicationError(
      "conflict",
      "Candidate render reuse record is not valid JSON.",
    );
  }
  const record = CandidateRenderReuseRecordV1Schema.parse(parsed);
  if (
    contents !== `${canonicalJson(record)}\n`
    || record.derivationSha256 !== options.input.derivation.derivationSha256
    || record.inputSha256 !== canonicalJsonSha256(options.input)
    || record.rendererAbi !== options.input.derivation.rendererAbi
  ) {
    throw new ApplicationError(
      "conflict",
      "Candidate render reuse record does not match the exact derivation.",
    );
  }
  const source = await readReceiptReference({
    fileSystem: options.exactPlan.fileSystem,
    reference: record.sourceReceipt,
  });
  assertReceiptMatchesReusableRender({
    input: options.input,
    outputAbsolute: options.outputAbsolute,
    receipt: source.receipt,
    renderPlanSha256: options.exactPlan.document.renderPlanSha256,
  });
  if (canonicalJson(record.output) !== canonicalJson(source.receipt.output)) {
    throw new ApplicationError(
      "conflict",
      "Candidate render reuse record output differs from its source receipt.",
    );
  }
  await resolveVerifiedProjectMedia({
    expected: record.output,
    label: "Reusable candidate render output",
    path: options.input.output.path,
    repositoryRoot: options.exactPlan.directory,
  });
  return {
    record,
    receipt: source.receipt,
    receiptContents: source.contents,
  };
}

async function publishCandidateRenderReuseRecord(options: {
  readonly exactPlan: Awaited<ReturnType<typeof loadExactProjectRenderPlan>>;
  readonly input: CandidateProjectRenderInput;
  readonly outputAbsolute: string;
  readonly receipt: z.infer<typeof ProjectRenderReceiptV2Schema>;
  readonly receiptContents: string;
}): Promise<CandidateRenderReuseRecordV1> {
  if (options.exactPlan.fileSystem.writeTextNoReplace === undefined) {
    throw new ApplicationError(
      "internal",
      "Project storage does not support immutable candidate render reuse records.",
    );
  }
  const record = createCandidateRenderReuseRecord(options);
  const contents = `${canonicalJson(record)}\n`;
  await ensurePhysicalPrivateDirectoryWithin(
    options.exactPlan.directory,
    dirname(candidateRenderReuseRecordPath(options.input)),
  );
  await options.exactPlan.fileSystem.writeTextNoReplace(
    candidateRenderReuseRecordPath(options.input),
    contents,
  );
  const published = await readCandidateRenderReuseRecord({
    exactPlan: options.exactPlan,
    input: options.input,
    outputAbsolute: options.outputAbsolute,
  });
  return published.record;
}

function assertReceiptMatchesReusableNodePlan(options: {
  readonly execution: ProjectRenderExecutionIdentity;
  readonly input: CandidateProjectRenderInput;
  readonly outputAbsolute: string;
  readonly receipt: z.infer<typeof ProjectRenderReceiptV2Schema>;
  readonly renderPlanSha256: string;
}): void {
  assertReceiptMatchesReusableRender(options);
  const execution = ProjectRenderExecutionIdentitySchema.parse(
    options.execution,
  );
  if (
    options.receipt.run.nodeKey !== execution.nodeKey
    || options.receipt.run.nodePlanSha256 !== execution.nodePlanSha256
  ) {
    throw new ApplicationError(
      "conflict",
      "Reusable candidate render receipt path is not bound to the current node plan.",
    );
  }
}

function adoptCandidateRenderIfPresent(options: {
  readonly application: ApplicationContext;
  readonly beforePublication: () => Promise<void>;
  readonly exactPlan: Awaited<ReturnType<typeof loadExactProjectRenderPlan>>;
  readonly execution: ProjectRenderExecutionIdentity;
  readonly input: CandidateProjectRenderInput;
  readonly outputAbsolute: string;
  readonly publicationPrecommit?: ProjectRenderPublicationPrecommit;
  readonly signal: AbortSignal;
}): Effect.Effect<ProjectRenderOutput | null, OperationEffectFailure> {
  return Effect.gen(function*() {
    const currentReceiptRelative = receiptPath(options.execution.nodePlanSha256);
    const currentReceiptAbsolute = join(options.exactPlan.directory, currentReceiptRelative);
    const reuseRecordAbsolute = join(options.exactPlan.directory, candidateRenderReuseRecordPath(options.input));
    const [outputExists, currentReceiptExists, reuseRecordExists] = yield* renderPathsExist([
      options.outputAbsolute, currentReceiptAbsolute, reuseRecordAbsolute,
    ]);
    if (!outputExists) {
      yield* renderValidation(() => {
        if (currentReceiptExists || reuseRecordExists) {
          throw new ApplicationError("conflict", "Candidate render receipt or reuse record exists without its immutable output.");
        }
      });
      return null;
    }
    if (!currentReceiptExists && !reuseRecordExists) {
      const precommit = yield* renderValidation(() => {
        if (options.publicationPrecommit === undefined) {
          throw new ApplicationError("conflict", "Candidate render output exists without an exact receipt or reuse record.");
        }
        assertReceiptMatchesExactRender({
          execution: options.execution, input: options.input, outputAbsolute: options.outputAbsolute,
          receipt: options.publicationPrecommit.receipt,
          renderPlanSha256: options.exactPlan.document.renderPlanSha256,
        });
        return options.publicationPrecommit;
      });
      yield* renderBoundary("publication", () => resolveVerifiedProjectMedia({
        expected: precommit.receipt.output,
        label: "Interrupted candidate render output",
        path: options.input.output.path,
        repositoryRoot: options.exactPlan.directory,
      }));
      const expectedContents = `${canonicalJson(precommit.receipt)}\n`;
      const published = yield* renderBoundary("publication", () => publishReceiptNoReplace({
        application: options.application, beforePublication: options.beforePublication,
        contents: expectedContents, execution: options.execution, input: options.input, signal: options.signal,
      }));
      yield* renderValidation(() => {
        if (published.contents !== expectedContents) {
          throw new ApplicationError("conflict", "Recovered candidate render receipt differs from its exact run-private publication precommit.");
        }
        assertReceiptMatchesExactRender({
          execution: options.execution, input: options.input, outputAbsolute: options.outputAbsolute,
          receipt: published.receipt, renderPlanSha256: options.exactPlan.document.renderPlanSha256,
        });
      });
      yield* renderBoundary("publication", () => resolveVerifiedProjectMedia({
        expected: published.receipt.output, label: "Recovered candidate render output",
        path: options.input.output.path, repositoryRoot: options.exactPlan.directory,
      }));
      yield* renderBoundary("publication", () => publishCandidateRenderReuseRecord({
        exactPlan: options.exactPlan, input: options.input, outputAbsolute: options.outputAbsolute,
        receipt: published.receipt, receiptContents: published.contents,
      }));
      return yield* renderValidation(() => ProjectRenderOutputSchema.parse({
        output: published.receipt.output,
        receipt: receiptReference(published.contents, currentReceiptRelative, published.receipt.output,
          published.receipt.receiptSha256, options.execution.nodePlanSha256),
      }));
    }

    const source = yield* Effect.gen(function*() {
      if (reuseRecordExists) {
        const reusable = yield* renderBoundary("publication", () => readCandidateRenderReuseRecord({
          exactPlan: options.exactPlan, input: options.input, outputAbsolute: options.outputAbsolute,
        }));
        return { contents: reusable.receiptContents, reference: reusable.record.sourceReceipt, receipt: reusable.receipt };
      }
      const current = yield* renderBoundary("publication", () => readReceipt(options.application, options.input, options.execution));
      yield* renderValidation(() => assertReceiptMatchesReusableNodePlan({
        execution: options.execution, input: options.input, outputAbsolute: options.outputAbsolute,
        receipt: current.receipt, renderPlanSha256: options.exactPlan.document.renderPlanSha256,
      }));
      yield* renderBoundary("publication", () => resolveVerifiedProjectMedia({
        expected: current.receipt.output, label: "Candidate render awaiting reuse record",
        path: options.input.output.path, repositoryRoot: options.exactPlan.directory,
      }));
      return {
        ...current,
        reference: receiptReference(current.contents, currentReceiptRelative, current.receipt.output,
          current.receipt.receiptSha256, options.execution.nodePlanSha256),
      };
    });

    // Adoption retains its two cancellation checks; it has no fresh-encoding final-fence exception.
    yield* renderValidation(() => throwIfAborted(options.signal));
    yield* renderBoundary("publication", options.beforePublication);
    yield* renderValidation(() => throwIfAborted(options.signal));
    yield* renderBoundary("publication", () => resolveVerifiedProjectMedia({
      expected: source.receipt.output, label: "Adopted candidate render output",
      path: options.input.output.path, repositoryRoot: options.exactPlan.directory,
    }));
    if (currentReceiptExists) {
      const current = yield* renderBoundary("publication", () => readReceipt(options.application, options.input, options.execution));
      yield* renderValidation(() => {
        assertReceiptMatchesReusableNodePlan({
          execution: options.execution, input: options.input, outputAbsolute: options.outputAbsolute,
          receipt: current.receipt, renderPlanSha256: options.exactPlan.document.renderPlanSha256,
        });
        if (canonicalJson(current.receipt.output) !== canonicalJson(source.receipt.output)) {
          throw new ApplicationError("conflict", "Current candidate render receipt disagrees with reusable output evidence.");
        }
      });
    }
    if (!reuseRecordExists) {
      yield* renderBoundary("publication", () => publishCandidateRenderReuseRecord({
        exactPlan: options.exactPlan, input: options.input, outputAbsolute: options.outputAbsolute,
        receipt: source.receipt, receiptContents: source.contents,
      }));
    }
    return yield* renderValidation(() => ProjectRenderOutputSchema.parse({ output: source.receipt.output, receipt: source.reference }));
  });
}

/**
 * Verified-receipt reconciliation for a previously dispatched exact render
 * node. If the public output was durably committed immediately before a
 * crash, the immutable run-private precommit authorizes only the matching
 * receipt to be finalized.
 */
function reconcileProjectRenderProgram(
  inputValue: unknown,
  execution: ProjectRenderExecutionIdentity,
  control: ProjectRenderReconciliationControl,
): Effect.Effect<ProjectRenderReconciliation, OperationEffectFailure, ProjectRenderServices> {
  return Effect.gen(function*() {
    const application = yield* ProjectRenderServices;
    yield* renderValidation(() => throwIfAborted(control.abortSignal));
    const input = yield* renderBoundary("input", () => bindAnyProjectRenderInput(application, inputValue));
    const directory = yield* renderBoundary("project", () => exactProjectDirectory(application, input.plan.projectId));
    const outputAbsolute = join(directory, input.output.path);
    if (isCandidateProjectRenderInput(input)) {
      return yield* withOutputPublicationLeaseEffect(application, {
        outputPath: input.output.path, projectId: input.plan.projectId,
      }, Effect.gen(function*() {
        const exactPlan = yield* renderBoundary("project", () => loadExactProjectRenderPlan(application, input.plan));
        yield* renderValidation(() => assertProjectRenderTarget(input, exactPlan.document.plan));
        const workspace = yield* renderBoundary("workspace", () => expectedWorkflowWorkspaceIfPresent(application, execution));
        const precommit = workspace === null ? null : yield* renderBoundary("publication", () => readPublicationPrecommit(workspace));
        if (precommit !== null) {
          yield* renderValidation(() => assertReceiptMatchesExactRender({
            execution, input, outputAbsolute, receipt: precommit.receipt,
            renderPlanSha256: exactPlan.document.renderPlanSha256,
          }));
        }
        const adopted = yield* adoptCandidateRenderIfPresent({
          application, beforePublication: control.beforePublication, exactPlan, execution, input, outputAbsolute,
          ...(precommit === null ? {} : { publicationPrecommit: precommit }),
          signal: control.abortSignal,
        });
        return adopted === null ? { kind: "retry" as const } : { kind: "completed" as const, output: adopted };
      }));
    }

    // Legacy exact-receipt recovery retains its separate idempotent/no-replace path.
    const receiptRelative = receiptPath(execution.nodePlanSha256);
    const receiptAbsolute = join(directory, receiptRelative);
    const [outputExists, receiptExists] = yield* renderPathsExist([outputAbsolute, receiptAbsolute]);
    const workspace = yield* renderBoundary("workspace", () => expectedWorkflowWorkspaceIfPresent(application, execution));
    const precommit = workspace === null ? null : yield* renderBoundary("publication", () => readPublicationPrecommit(workspace));
    if (!outputExists && !receiptExists && precommit === null) return { kind: "retry" };
    if (!outputExists && receiptExists) {
      return { kind: "conflict", message: "Project render has a partial output/receipt publication." };
    }
    const exactPlan = yield* renderBoundary("project", () => loadExactProjectRenderPlan(application, input.plan));
    yield* renderValidation(() => {
      assertProjectRenderTarget(input, exactPlan.document.plan);
      throwIfAborted(control.abortSignal);
      if (precommit !== null) {
        assertReceiptMatchesExactRender({
          execution, input, outputAbsolute, receipt: precommit.receipt,
          renderPlanSha256: exactPlan.document.renderPlanSha256,
        });
      }
    });
    if (!outputExists) return { kind: "retry" };
    if (!receiptExists && precommit === null) {
      return { kind: "conflict", message: "Project render output exists without its exact run-private publication precommit." };
    }
    const published = yield* Effect.gen(function*() {
      if (receiptExists) return yield* renderBoundary("publication", () => readReceipt(application, input, execution));
      const exactPrecommit = yield* renderValidation(() => {
        if (precommit === null) throw new ApplicationError("conflict", "Project render output exists without its exact run-private publication precommit.");
        return precommit;
      });
      yield* renderBoundary("publication", () => resolveVerifiedProjectMedia({
        expected: exactPrecommit.receipt.output, label: "Interrupted project render output",
        path: input.output.path, repositoryRoot: directory,
      }));
      return yield* renderBoundary("publication", () => publishReceiptNoReplace({
        application, beforePublication: control.beforePublication,
        contents: `${canonicalJson(exactPrecommit.receipt)}\n`, execution, input, signal: control.abortSignal,
      }));
    });
    const { contents, receipt } = published;
    yield* renderValidation(() => assertReceiptMatchesExactRender({
      execution, input, outputAbsolute, receipt, renderPlanSha256: exactPlan.document.renderPlanSha256,
    }));
    if (precommit !== null && canonicalJson(precommit.receipt) !== canonicalJson(receipt)) {
      return { kind: "conflict", message: "Project render receipt differs from its exact run-private publication precommit." };
    }
    yield* renderBoundary("publication", () => resolveVerifiedProjectMedia({
      expected: receipt.output, label: "Reconciled project render output",
      path: input.output.path, repositoryRoot: directory,
    }));
    return yield* renderValidation(() => ({
      kind: "completed" as const,
      output: ProjectRenderOutputSchema.parse({
        output: receipt.output,
        receipt: receiptReference(contents, receiptRelative, receipt.output, receipt.receiptSha256, execution.nodePlanSha256),
      }),
    }));
  });
}

/** Closed local composition boundary; expected native failures retain the existing conflict projection. */
export function reconcileProjectRenderEffect(
  application: ApplicationContext,
  inputValue: unknown,
  execution: ProjectRenderExecutionIdentity,
  control: ProjectRenderReconciliationControl,
): Effect.Effect<ProjectRenderReconciliation> {
  const program = reconcileProjectRenderProgram(inputValue, execution, control)
    .pipe(Effect.provideService(ProjectRenderServices, application));
  return Effect.map(Effect.exit(program), exit => {
    try {
      return operationExitValue(exit);
    } catch (error) {
      return { kind: "conflict" as const, message: errorMessage(error) };
    }
  });
}

export async function reconcileProjectRender(
  application: ApplicationContext,
  inputValue: unknown,
  execution: ProjectRenderExecutionIdentity,
  control: ProjectRenderReconciliationControl,
): Promise<ProjectRenderReconciliation> {
  return await runStandaloneOperation(reconcileProjectRenderEffect(application, inputValue, execution, control));
}

function projectRenderProgram(
  context: OperationExecutionContext,
  parsedInput: unknown,
): Effect.Effect<ProjectRenderOutput, OperationEffectFailure, ProjectRenderServices | AtomicRenderPlatform> {
  return Effect.gen(function*() {
    const application = yield* ProjectRenderServices;
    const workflow = yield* renderValidation(() => {
      if (context.workflow === undefined) {
        throw new ApplicationError("conflict", "Workflow project rendering requires an exact run-private execution context.");
      }
      throwIfAborted(context.abortSignal);
      return context.workflow;
    });
    const input = yield* renderBoundary("input", () => bindAnyProjectRenderInput(application, parsedInput));
    const exactPlan = yield* renderBoundary("project", () => loadExactProjectRenderPlan(application, input.plan));
    yield* renderValidation(() => {
      assertProjectRenderTarget(input, exactPlan.document.plan);
      if (input.syncPolicy === "require-verified" && exactPlan.document.plan.warnings.some(warning => warning.code === "unverified-sync")) {
        throw new ApplicationError("conflict", "Project render plan contains unverified placement synchronization.");
      }
    });
    const execution = { nodeKey: workflow.nodeKey, nodePlanSha256: workflow.nodePlanSha256, runId: workflow.runId };
    const workspace = yield* renderBoundary("workspace", () => exactRunWorkflowWorkspace(application, execution, workflow.workspaceDirectory));
    const runner = yield* renderValidation(() => workflowRunner(new ExactCapabilityApplicationRunner(
      application.runner,
      [input.binding.ffmpeg, input.binding.ffprobe, ...(input.binding.rsvgConvert === null ? [] : [input.binding.rsvgConvert])],
      application.paths.privateRoot,
    ), workspace));
    const outputParent = yield* renderBoundary("workspace", () => ensurePhysicalPrivateDirectoryWithin(exactPlan.directory, dirname(input.output.path)));
    const outputAbsolute = join(exactPlan.directory, input.output.path);
    yield* renderValidation(() => {
      if (dirname(outputAbsolute) !== outputParent) {
        throw new ApplicationError("unsafe-path", "Project render output parent did not resolve to its physical directory.");
      }
    });
    const receiptRelative = receiptPath(workflow.nodePlanSha256);
    const receiptAbsolute = join(exactPlan.directory, receiptRelative);
    yield* renderBoundary("workspace", () => ensurePhysicalPrivateDirectoryWithin(exactPlan.directory, dirname(receiptRelative)));
    yield* renderValidation(() => {
      if (exactPlan.fileSystem.writeTextNoReplace === undefined) {
        throw new ApplicationError("internal", "Project storage does not support immutable render-receipt publication.");
      }
    });
    if (!isCandidateProjectRenderInput(input)) {
      yield* renderBoundary("publication", () => requireFreshPublicationTargets(outputAbsolute, receiptAbsolute));
    }
    return yield* withOutputPublicationLeaseEffect(application, {
      outputPath: input.output.path, projectId: input.plan.projectId,
    }, Effect.gen(function*() {
      if (isCandidateProjectRenderInput(input)) {
        const adopted = yield* adoptCandidateRenderIfPresent({
          application, beforePublication: () => workflow.beforePublication(), exactPlan, execution, input, outputAbsolute,
          signal: context.abortSignal,
        });
        if (adopted !== null) return adopted;
      }
      yield* renderBoundary("publication", () => requireFreshPublicationTargets(outputAbsolute, receiptAbsolute));
      const built = yield* renderBoundary("media", () => buildProjectFfmpegInvocation(exactPlan.document.plan, {
        ffmpeg: input.binding.ffmpeg.executablePath,
        ffprobe: input.binding.ffprobe.executablePath,
        outputPath: outputAbsolute,
        projectDirectory: exactPlan.directory,
        ...("target" in input ? { renderTier: input.target.tier } : {}),
        repositoryRoot: application.paths.repositoryRoot,
        ...(input.binding.rsvgConvert === null ? {} : {
          rsvgConvert: input.binding.rsvgConvert.executablePath,
          rsvgConvertVersion: input.binding.rsvgConvert.version,
        }),
        runner, workspaceDirectory: workspace,
      }));
      yield* renderValidation(() => throwIfAborted(context.abortSignal));
      const rendered = yield* executeAtomicRenderEffect({
        abortSignal: context.abortSignal,
        argv: built.argv,
        failureLabel: "FFmpeg workflow project render failed",
        finalOutputPath: outputAbsolute,
        maximumOutputBytes: input.output.maximumBytes,
        requireFreshOutput: true,
        runner,
        stagingDirectory: workspace,
        timeoutMs: PROJECT_RENDER_MAX_DURATION_MS,
      }, {
        prepare: outputIntegrity => Effect.gen(function*() {
          yield* renderBoundary("publication", () => reverifyProjectRenderInputs(built.pinnedInputs));
          yield* renderValidation(() => throwIfAborted(context.abortSignal));
          // The atomic owner masks before this final fence. A successful fence
          // starts the recoverable precommit/output/receipt sequence.
          yield* renderBoundary("publication", () => workflow.beforePublication());
          const candidate = yield* renderValidation(() => {
            const output = ProjectRenderOutputReferenceSchema.parse({
              ...outputIntegrity,
              kind: "atet.project-render-output-reference",
              path: input.output.path,
              planArtifactSha256: input.plan.artifact.sha256,
              projectId: input.plan.projectId,
              revisionSha256: input.plan.revisionSha256,
              schemaVersion: 1,
            });
            return createPublicationPrecommit(createProjectRenderReceiptV2({
              createdAt: application.clock.now().toISOString(),
              inputSha256: canonicalJsonSha256(input),
              invocation: built.invocation,
              output, plan: input.plan, run: execution,
              syncPolicy: input.syncPolicy, toolchain: input.binding,
            }));
          });
          const precommit = yield* renderBoundary("publication", () => publishPublicationPrecommit(workspace, candidate));
          return yield* renderValidation(() => {
            assertReceiptMatchesExactRender({
              execution, input, outputAbsolute, receipt: precommit.receipt,
              renderPlanSha256: exactPlan.document.renderPlanSha256,
            });
            if (precommit.receipt.output.bytes !== outputIntegrity.bytes || precommit.receipt.output.sha256 !== outputIntegrity.sha256) {
              throw new ApplicationError("conflict", "Existing project render precommit describes different rendered bytes.");
            }
            return { contents: `${canonicalJson(precommit.receipt)}\n`, output: precommit.receipt.output, precommit };
          });
        }),
        companion: {
          finalPath: receiptAbsolute,
          publish: (prepared, outputIntegrity) => Effect.gen(function*() {
            // No new cancellation/fence after the public link. Recovery relies
            // on this callback or reconciliation finalizing the exact receipt.
            yield* renderValidation(() => {
              if (prepared.output.bytes !== outputIntegrity.bytes || prepared.output.sha256 !== outputIntegrity.sha256) {
                throw new ApplicationError("internal", "Project render output committed without its exact prepared receipt.");
              }
            });
            yield* renderBoundary("publication", () => publishReceiptNoReplace({
              application, contents: prepared.contents, execution, input,
            }));
          }),
        },
      });
      const prepared = rendered.prepared;
      const published = yield* renderBoundary("publication", () => readReceipt(application, input, execution));
      yield* renderValidation(() => {
        if (published.contents !== prepared.contents) {
          throw new ApplicationError("conflict", "Published project render receipt contains different bytes.");
        }
      });
      if (isCandidateProjectRenderInput(input)) {
        yield* renderBoundary("publication", () => publishCandidateRenderReuseRecord({
          exactPlan, input, outputAbsolute, receipt: published.receipt, receiptContents: published.contents,
        }));
      }
      return yield* renderValidation(() => ProjectRenderOutputSchema.parse({
        output: prepared.output,
        receipt: receiptReference(prepared.contents, receiptRelative, prepared.output,
          prepared.precommit.receipt.receiptSha256, workflow.nodePlanSha256),
      }));
    }));
  });
}

function projectRenderEffect(
  context: OperationExecutionContext,
  input: unknown,
): Effect.Effect<ProjectRenderOutput, OperationEffectFailure> {
  return projectRenderProgram(context, input).pipe(
    Effect.provideService(ProjectRenderServices, context.application),
    Effect.provide(AtomicRenderPlatformLive),
  );
}

const projectRenderLifecycle = {
  kind: "local-artifact",
  execute: async (context, input) => await runStandaloneOperation(projectRenderEffect(context, input)),
  executeEffect: projectRenderEffect,
} satisfies OperationDefinition<"render.project", unknown, ProjectRenderOutput>["lifecycle"];

export const projectRenderOperationDefinition = {
  inputSchema: ProjectRenderInputSchema,
  inputSchemaId: "atet.operation.render.project.input/v1",
  kind: "render.project",
  lifecycle: projectRenderLifecycle,
  outputSchema: ProjectRenderOutputSchema,
  outputSchemaId: "atet.operation.render.project.output/v1",
  policy: {
    cache: "exact-run",
    cancellable: true,
    effect: "local-derived-write",
    maxDurationMs: PROJECT_RENDER_MAX_DURATION_MS,
    maxFanOut: 0,
    maxInputBytes: 32 * 1_024,
    maxOutputBytes: 16 * 1_024,
    preparation: [],
    resources: [
      { amount: 1, resource: "cpu" },
      { amount: 1, resource: "local-io" },
      { amount: 1, resource: "ffmpeg" },
      { amount: 1, resource: "output-publication" },
    ],
    resume: "verified-receipt",
  },
  receiptReference: output => output.receipt.path,
  summarize: output => ({
    fields: {
      bytes: output.output.bytes,
      outputPath: output.output.path,
      outputSha256: output.output.sha256,
      projectId: output.output.projectId,
      receiptPath: output.receipt.path,
      revisionSha256: output.output.revisionSha256,
    },
    kind: "render.project",
  }),
  version: 1,
} satisfies OperationDefinition<
  "render.project",
  ProjectRenderInput,
  ProjectRenderOutput
>;

export const projectRenderOperationDefinitionV2 = {
  ...projectRenderOperationDefinition,
  inputSchema: ProjectRenderInputSchemaV2,
  inputSchemaId: "atet.operation.render.project.input/v2",
  lifecycle: projectRenderLifecycle,
  outputSchemaId: "atet.operation.render.project.output/v2",
  policy: {
    ...projectRenderOperationDefinition.policy,
    resources: [
      { amount: 1, resource: "cpu" },
      { amount: 1, resource: "local-io" },
      { amount: 1, resource: "ffmpeg" },
      { amount: 1, resource: "output-publication" },
      // FFmpeg owns one decoder pool per distinct input in addition to its
      // filter and encoder pools. Until the host can bind one execution-wide
      // thread budget into both the recipe and scheduler claim, this explicit
      // capacity-one resource serializes v2 project renders independently of
      // the host's ordinary CPU and FFmpeg ceilings.
      { amount: 1, resource: "project-render" },
    ],
  },
  version: 2,
} satisfies OperationDefinition<
  "render.project",
  ProjectRenderInputV2,
  ProjectRenderOutput
>;

export const projectRenderOperationDefinitionV3 = {
  ...projectRenderOperationDefinitionV2,
  inputSchema: ProjectRenderInputSchemaV3,
  inputSchemaId: "atet.operation.render.project.input/v3",
  lifecycle: projectRenderLifecycle,
  outputSchemaId: "atet.operation.render.project.output/v3",
  version: 3,
} satisfies OperationDefinition<
  "render.project",
  ProjectRenderInputV3,
  ProjectRenderOutput
>;
