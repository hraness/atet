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
import { executeAtomicRender } from "../../../cli/atomic-render";
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
import type { OperationDefinition } from "../../operation";
import { withOutputPublicationLease } from "../../output-publication-lease";
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
  "transmute.candidate-render-reuse-record/v1";

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
    z.literal("transmute.project-render-publication-precommit"),
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
  kind: z.literal("transmute.candidate-render-reuse-record"),
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
    kind: "transmute.project-render-publication-precommit",
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
    kind: "transmute.project-render-receipt-reference",
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
    kind: "transmute.candidate-render-reuse-record",
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

async function adoptCandidateRenderIfPresent(options: {
  readonly application: ApplicationContext;
  readonly beforePublication: () => Promise<void>;
  readonly exactPlan: Awaited<ReturnType<typeof loadExactProjectRenderPlan>>;
  readonly execution: ProjectRenderExecutionIdentity;
  readonly input: CandidateProjectRenderInput;
  readonly outputAbsolute: string;
  readonly publicationPrecommit?: ProjectRenderPublicationPrecommit;
  readonly signal: AbortSignal;
}): Promise<ProjectRenderOutput | null> {
  const currentReceiptRelative = receiptPath(
    options.execution.nodePlanSha256,
  );
  const currentReceiptAbsolute = join(
    options.exactPlan.directory,
    currentReceiptRelative,
  );
  const reuseRecordRelative = candidateRenderReuseRecordPath(options.input);
  const reuseRecordAbsolute = join(
    options.exactPlan.directory,
    reuseRecordRelative,
  );
  const [outputExists, currentReceiptExists, reuseRecordExists] =
    await Promise.all([
      pathExists(options.outputAbsolute),
      pathExists(currentReceiptAbsolute),
      pathExists(reuseRecordAbsolute),
    ]);
  if (!outputExists) {
    if (currentReceiptExists || reuseRecordExists) {
      throw new ApplicationError(
        "conflict",
        "Candidate render receipt or reuse record exists without its immutable output.",
      );
    }
    return null;
  }
  if (!currentReceiptExists && !reuseRecordExists) {
    if (options.publicationPrecommit !== undefined) {
      const precommit = options.publicationPrecommit;
      assertReceiptMatchesExactRender({
        execution: options.execution,
        input: options.input,
        outputAbsolute: options.outputAbsolute,
        receipt: precommit.receipt,
        renderPlanSha256: options.exactPlan.document.renderPlanSha256,
      });
      await resolveVerifiedProjectMedia({
        expected: precommit.receipt.output,
        label: "Interrupted candidate render output",
        path: options.input.output.path,
        repositoryRoot: options.exactPlan.directory,
      });
      const expectedContents = `${canonicalJson(precommit.receipt)}\n`;
      const published = await publishReceiptNoReplace({
        application: options.application,
        beforePublication: options.beforePublication,
        contents: expectedContents,
        execution: options.execution,
        input: options.input,
        signal: options.signal,
      });
      if (published.contents !== expectedContents) {
        throw new ApplicationError(
          "conflict",
          "Recovered candidate render receipt differs from its exact run-private publication precommit.",
        );
      }
      assertReceiptMatchesExactRender({
        execution: options.execution,
        input: options.input,
        outputAbsolute: options.outputAbsolute,
        receipt: published.receipt,
        renderPlanSha256: options.exactPlan.document.renderPlanSha256,
      });
      await resolveVerifiedProjectMedia({
        expected: published.receipt.output,
        label: "Recovered candidate render output",
        path: options.input.output.path,
        repositoryRoot: options.exactPlan.directory,
      });
      await publishCandidateRenderReuseRecord({
        exactPlan: options.exactPlan,
        input: options.input,
        outputAbsolute: options.outputAbsolute,
        receipt: published.receipt,
        receiptContents: published.contents,
      });
      return ProjectRenderOutputSchema.parse({
        output: published.receipt.output,
        receipt: receiptReference(
          published.contents,
          currentReceiptRelative,
          published.receipt.output,
          published.receipt.receiptSha256,
          options.execution.nodePlanSha256,
        ),
      });
    }
    throw new ApplicationError(
      "conflict",
      "Candidate render output exists without an exact receipt or reuse record.",
    );
  }

  let source: {
    readonly contents: string;
    readonly reference: ProjectRenderReceiptReference;
    readonly receipt: z.infer<typeof ProjectRenderReceiptV2Schema>;
  };
  if (reuseRecordExists) {
    const reusable = await readCandidateRenderReuseRecord({
      exactPlan: options.exactPlan,
      input: options.input,
      outputAbsolute: options.outputAbsolute,
    });
    source = {
      contents: reusable.receiptContents,
      reference: reusable.record.sourceReceipt,
      receipt: reusable.receipt,
    };
  } else {
    source = await readReceipt(
      options.application,
      options.input,
      options.execution,
    ).then(value => ({
      ...value,
      reference: receiptReference(
        value.contents,
        currentReceiptRelative,
        value.receipt.output,
        value.receipt.receiptSha256,
        options.execution.nodePlanSha256,
      ),
    }));
    assertReceiptMatchesReusableNodePlan({
      execution: options.execution,
      input: options.input,
      outputAbsolute: options.outputAbsolute,
      receipt: source.receipt,
      renderPlanSha256: options.exactPlan.document.renderPlanSha256,
    });
    await resolveVerifiedProjectMedia({
      expected: source.receipt.output,
      label: "Candidate render awaiting reuse record",
      path: options.input.output.path,
      repositoryRoot: options.exactPlan.directory,
    });
  }

  throwIfAborted(options.signal);
  await options.beforePublication();
  throwIfAborted(options.signal);
  await resolveVerifiedProjectMedia({
    expected: source.receipt.output,
    label: "Adopted candidate render output",
    path: options.input.output.path,
    repositoryRoot: options.exactPlan.directory,
  });

  if (currentReceiptExists) {
    const current = await readReceipt(
      options.application,
      options.input,
      options.execution,
    );
    assertReceiptMatchesReusableNodePlan({
      execution: options.execution,
      input: options.input,
      outputAbsolute: options.outputAbsolute,
      receipt: current.receipt,
      renderPlanSha256: options.exactPlan.document.renderPlanSha256,
    });
    if (canonicalJson(current.receipt.output) !== canonicalJson(source.receipt.output)) {
      throw new ApplicationError(
        "conflict",
        "Current candidate render receipt disagrees with reusable output evidence.",
      );
    }
  }

  if (!reuseRecordExists) {
    await publishCandidateRenderReuseRecord({
      exactPlan: options.exactPlan,
      input: options.input,
      outputAbsolute: options.outputAbsolute,
      receipt: source.receipt,
      receiptContents: source.contents,
    });
  }
  return ProjectRenderOutputSchema.parse({
    output: source.receipt.output,
    receipt: source.reference,
  });
}

/**
 * Verified-receipt reconciliation for a previously dispatched exact render
 * node. If the public output was durably committed immediately before a
 * crash, the immutable run-private precommit authorizes only the matching
 * receipt to be finalized.
 */
export async function reconcileProjectRender(
  application: ApplicationContext,
  inputValue: unknown,
  execution: ProjectRenderExecutionIdentity,
  control: ProjectRenderReconciliationControl,
): Promise<ProjectRenderReconciliation> {
  try {
    throwIfAborted(control.abortSignal);
    const input = await bindAnyProjectRenderInput(application, inputValue);
    const directory = await exactProjectDirectory(
      application,
      input.plan.projectId,
    );
    const outputAbsolute = join(directory, input.output.path);
    if (isCandidateProjectRenderInput(input)) {
      return await withOutputPublicationLease(
        application,
        {
          outputPath: input.output.path,
          projectId: input.plan.projectId,
        },
        async () => {
          const exactPlan = await loadExactProjectRenderPlan(
            application,
            input.plan,
          );
          assertProjectRenderTarget(input, exactPlan.document.plan);
          const workspace = await expectedWorkflowWorkspaceIfPresent(
            application,
            execution,
          );
          const precommit = workspace === null
            ? null
            : await readPublicationPrecommit(workspace);
          if (precommit !== null) {
            assertReceiptMatchesExactRender({
              execution,
              input,
              outputAbsolute,
              receipt: precommit.receipt,
              renderPlanSha256: exactPlan.document.renderPlanSha256,
            });
          }
          const adopted = await adoptCandidateRenderIfPresent({
            application,
            beforePublication: control.beforePublication,
            exactPlan,
            execution,
            input,
            outputAbsolute,
            ...(precommit === null
              ? {}
              : { publicationPrecommit: precommit }),
            signal: control.abortSignal,
          });
          if (adopted !== null) {
            return { kind: "completed", output: adopted };
          }
          return { kind: "retry" };
        },
      );
    }
    const receiptRelative = receiptPath(execution.nodePlanSha256);
    const receiptAbsolute = join(directory, receiptRelative);
    const [outputExists, receiptExists] = await Promise.all([
      pathExists(outputAbsolute),
      pathExists(receiptAbsolute),
    ]);
    const workspace = await expectedWorkflowWorkspaceIfPresent(
      application,
      execution,
    );
    const precommit = workspace === null
      ? null
      : await readPublicationPrecommit(workspace);
    if (!outputExists && !receiptExists && precommit === null) {
      return { kind: "retry" };
    }
    if (!outputExists && receiptExists) {
      return {
        kind: "conflict",
        message: "Project render has a partial output/receipt publication.",
      };
    }

    const exactPlan = await loadExactProjectRenderPlan(application, input.plan);
    assertProjectRenderTarget(input, exactPlan.document.plan);
    throwIfAborted(control.abortSignal);
    if (precommit !== null) {
      assertReceiptMatchesExactRender({
        execution,
        input,
        outputAbsolute,
        receipt: precommit.receipt,
        renderPlanSha256: exactPlan.document.renderPlanSha256,
      });
    }
    if (!outputExists) return { kind: "retry" };

    let published: {
      readonly contents: string;
      readonly receipt: z.infer<typeof ProjectRenderReceiptV2Schema>;
    };
    if (!receiptExists) {
      if (precommit === null) {
        return {
          kind: "conflict",
          message: "Project render output exists without its exact run-private publication precommit.",
        };
      }
      await resolveVerifiedProjectMedia({
        expected: precommit.receipt.output,
        label: "Interrupted project render output",
        path: input.output.path,
        repositoryRoot: directory,
      });
      published = await publishReceiptNoReplace({
        application,
        beforePublication: control.beforePublication,
        contents: `${canonicalJson(precommit.receipt)}\n`,
        execution,
        input,
        signal: control.abortSignal,
      });
    } else {
      published = await readReceipt(application, input, execution);
    }
    const { contents, receipt } = published;
    assertReceiptMatchesExactRender({
      execution,
      input,
      outputAbsolute,
      receipt,
      renderPlanSha256: exactPlan.document.renderPlanSha256,
    });
    if (
      precommit !== null
      && canonicalJson(precommit.receipt) !== canonicalJson(receipt)
    ) {
      return {
        kind: "conflict",
        message: "Project render receipt differs from its exact run-private publication precommit.",
      };
    }
    await resolveVerifiedProjectMedia({
      expected: receipt.output,
      label: "Reconciled project render output",
      path: input.output.path,
      repositoryRoot: directory,
    });
    const reference = receiptReference(
      contents,
      receiptRelative,
      receipt.output,
      receipt.receiptSha256,
      execution.nodePlanSha256,
    );
    return {
      kind: "completed",
      output: ProjectRenderOutputSchema.parse({
        output: receipt.output,
        receipt: reference,
      }),
    };
  } catch (error) {
    return {
      kind: "conflict",
      message: errorMessage(error),
    };
  }
}

const projectRenderLifecycle = {
  kind: "local-artifact",
  execute: async (context, parsedInput) => {
    const workflow = context.workflow;
    if (workflow === undefined) {
      throw new ApplicationError(
        "conflict",
        "Workflow project rendering requires an exact run-private execution context.",
      );
    }
    throwIfAborted(context.abortSignal);
    const input = await bindAnyProjectRenderInput(
      context.application,
      parsedInput,
    );
    const exactPlan = await loadExactProjectRenderPlan(
      context.application,
      input.plan,
    );
    assertProjectRenderTarget(input, exactPlan.document.plan);
    if (
      input.syncPolicy === "require-verified"
      && exactPlan.document.plan.warnings.some(
        warning => warning.code === "unverified-sync",
      )
    ) {
      throw new ApplicationError(
        "conflict",
        "Project render plan contains unverified placement synchronization.",
      );
    }
    const workspace = await exactRunWorkflowWorkspace(
      context.application,
      {
        nodeKey: workflow.nodeKey,
        nodePlanSha256: workflow.nodePlanSha256,
        runId: workflow.runId,
      },
      workflow.workspaceDirectory,
    );
    const capabilityRunner = new ExactCapabilityApplicationRunner(
      context.application.runner,
      [
        input.binding.ffmpeg,
        input.binding.ffprobe,
        ...(input.binding.rsvgConvert === null
          ? []
          : [input.binding.rsvgConvert]),
      ],
      context.application.paths.privateRoot,
    );
    const runner = workflowRunner(capabilityRunner, workspace);
    const outputParent = await ensurePhysicalPrivateDirectoryWithin(
      exactPlan.directory,
      dirname(input.output.path),
    );
    const outputAbsolute = join(exactPlan.directory, input.output.path);
    if (dirname(outputAbsolute) !== outputParent) {
      throw new ApplicationError(
        "unsafe-path",
        "Project render output parent did not resolve to its physical directory.",
      );
    }
    const receiptRelative = receiptPath(workflow.nodePlanSha256);
    const receiptAbsolute = join(exactPlan.directory, receiptRelative);
    await ensurePhysicalPrivateDirectoryWithin(
      exactPlan.directory,
      dirname(receiptRelative),
    );
    if (exactPlan.fileSystem.writeTextNoReplace === undefined) {
      throw new ApplicationError(
        "internal",
        "Project storage does not support immutable render-receipt publication.",
      );
    }
    if (!isCandidateProjectRenderInput(input)) {
      await requireFreshPublicationTargets(
        outputAbsolute,
        receiptAbsolute,
      );
    }

    return await withOutputPublicationLease(
      context.application,
      {
        outputPath: input.output.path,
        projectId: input.plan.projectId,
      },
      async () => {
        if (isCandidateProjectRenderInput(input)) {
          const adopted = await adoptCandidateRenderIfPresent({
            application: context.application,
            beforePublication: () => workflow.beforePublication(),
            exactPlan,
            execution: {
              nodeKey: workflow.nodeKey,
              nodePlanSha256: workflow.nodePlanSha256,
              runId: workflow.runId,
            },
            input,
            outputAbsolute,
            signal: context.abortSignal,
          });
          if (adopted !== null) return adopted;
        }
        await requireFreshPublicationTargets(
          outputAbsolute,
          receiptAbsolute,
        );
        const built = await buildProjectFfmpegInvocation(
          exactPlan.document.plan,
          {
            ffmpeg: input.binding.ffmpeg.executablePath,
            ffprobe: input.binding.ffprobe.executablePath,
            outputPath: outputAbsolute,
            projectDirectory: exactPlan.directory,
            ...("target" in input
              ? { renderTier: input.target.tier }
              : {}),
            repositoryRoot: context.application.paths.repositoryRoot,
            ...(input.binding.rsvgConvert === null
              ? {}
              : {
                  rsvgConvert: input.binding.rsvgConvert.executablePath,
                  rsvgConvertVersion: input.binding.rsvgConvert.version,
                }),
            runner,
            workspaceDirectory: workspace,
          },
        );
        throwIfAborted(context.abortSignal);
        let prepared:
          | {
            readonly contents: string;
            readonly output: ProjectRenderOutputReference;
            readonly precommit: ProjectRenderPublicationPrecommit;
          }
          | undefined;
        await executeAtomicRender({
          abortSignal: context.abortSignal,
          argv: built.argv,
          beforePublish: async outputIntegrity => {
            await reverifyProjectRenderInputs(built.pinnedInputs);
            throwIfAborted(context.abortSignal);
            // This is the final cancellation/lease fence. Once the exact
            // receipt is durably precommitted, output and receipt
            // publication form one recoverable point-of-no-return sequence.
            await workflow.beforePublication();
            const output = ProjectRenderOutputReferenceSchema.parse({
              ...outputIntegrity,
              kind: "transmute.project-render-output-reference",
              path: input.output.path,
              planArtifactSha256: input.plan.artifact.sha256,
              projectId: input.plan.projectId,
              revisionSha256: input.plan.revisionSha256,
              schemaVersion: 1,
            });
            const candidate = createPublicationPrecommit(
              createProjectRenderReceiptV2({
                createdAt: context.application.clock.now().toISOString(),
                inputSha256: canonicalJsonSha256(input),
                invocation: built.invocation,
                output,
                plan: input.plan,
                run: {
                  nodeKey: workflow.nodeKey,
                  nodePlanSha256: workflow.nodePlanSha256,
                  runId: workflow.runId,
                },
                syncPolicy: input.syncPolicy,
                toolchain: input.binding,
              }),
            );
            const precommit = await publishPublicationPrecommit(
              workspace,
              candidate,
            );
            assertReceiptMatchesExactRender({
              execution: {
                nodeKey: workflow.nodeKey,
                nodePlanSha256: workflow.nodePlanSha256,
                runId: workflow.runId,
              },
              input,
              outputAbsolute,
              receipt: precommit.receipt,
              renderPlanSha256: exactPlan.document.renderPlanSha256,
            });
            if (
              precommit.receipt.output.bytes !== output.bytes
              || precommit.receipt.output.sha256 !== output.sha256
            ) {
              throw new ApplicationError(
                "conflict",
                "Existing project render precommit describes different rendered bytes.",
              );
            }
            prepared = {
              contents: `${canonicalJson(precommit.receipt)}\n`,
              output: precommit.receipt.output,
              precommit,
            };
          },
          companion: {
            finalPath: receiptAbsolute,
            publish: async outputIntegrity => {
              // Deliberately do not recheck cancellation or the workflow
              // fence after the public output link. Recovery relies on this
              // callback or reconciliation finalizing the prepared receipt.
              if (
                prepared === undefined
                || prepared.output.bytes !== outputIntegrity.bytes
                || prepared.output.sha256 !== outputIntegrity.sha256
              ) {
                throw new ApplicationError(
                  "internal",
                  "Project render output committed without its exact prepared receipt.",
                );
              }
              await publishReceiptNoReplace({
                application: context.application,
                contents: prepared.contents,
                execution: {
                  nodeKey: workflow.nodeKey,
                  nodePlanSha256: workflow.nodePlanSha256,
                  runId: workflow.runId,
                },
                input,
              });
            },
          },
          failureLabel: "FFmpeg workflow project render failed",
          finalOutputPath: outputAbsolute,
          maximumOutputBytes: input.output.maximumBytes,
          requireFreshOutput: true,
          runner,
          stagingDirectory: workspace,
          timeoutMs: PROJECT_RENDER_MAX_DURATION_MS,
        });
        if (prepared === undefined) {
          throw new ApplicationError(
            "internal",
            "Project render completed without an exact publication precommit.",
          );
        }
        const published = await readReceipt(
          context.application,
          input,
          {
            nodeKey: workflow.nodeKey,
            nodePlanSha256: workflow.nodePlanSha256,
            runId: workflow.runId,
          },
        );
        if (published.contents !== prepared.contents) {
          throw new ApplicationError(
            "conflict",
            "Published project render receipt contains different bytes.",
          );
        }
        if (isCandidateProjectRenderInput(input)) {
          await publishCandidateRenderReuseRecord({
            exactPlan,
            input,
            outputAbsolute,
            receipt: published.receipt,
            receiptContents: published.contents,
          });
        }
        return ProjectRenderOutputSchema.parse({
          output: prepared.output,
          receipt: receiptReference(
            prepared.contents,
            receiptRelative,
            prepared.output,
            prepared.precommit.receipt.receiptSha256,
            workflow.nodePlanSha256,
          ),
        });
      },
    );
  },
} satisfies OperationDefinition<
  "render.project",
  unknown,
  ProjectRenderOutput
>["lifecycle"];

export const projectRenderOperationDefinition = {
  inputSchema: ProjectRenderInputSchema,
  inputSchemaId: "studio.operation.render.project.input/v1",
  kind: "render.project",
  lifecycle: projectRenderLifecycle,
  outputSchema: ProjectRenderOutputSchema,
  outputSchemaId: "studio.operation.render.project.output/v1",
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
  inputSchemaId: "studio.operation.render.project.input/v2",
  lifecycle: projectRenderLifecycle,
  outputSchemaId: "studio.operation.render.project.output/v2",
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
  inputSchemaId: "studio.operation.render.project.input/v3",
  lifecycle: projectRenderLifecycle,
  outputSchemaId: "studio.operation.render.project.output/v3",
  version: 3,
} satisfies OperationDefinition<
  "render.project",
  ProjectRenderInputV3,
  ProjectRenderOutput
>;
