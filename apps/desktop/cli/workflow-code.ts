import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
} from "node:path";

import { z } from "zod";

import type { ApplicationContext } from "../application/context";
import { ApplicationError } from "../application/errors";
import type {
  OperationDescription,
  OperationDiscovery,
  OperationRegistry,
} from "../application/registry";
import type { GraphPlanV1 } from "../code/contracts";
import {
  TRUSTED_CODE_WARNING,
  planBuiltInWorkflow,
  planCodeWorkflow,
  prepareCodeWorkflowRun,
} from "../code/planning";
import { checkAndBundleWorkflowSource } from "../code/source-bundle";
import type { BuiltInWorkflow } from "../workflows";

const MAXIMUM_WORKFLOW_INPUT_BYTES = 4 * 1024 * 1024;

export interface WorkflowPlanSummary {
  readonly bounds: GraphPlanV1["envelope"]["bounds"];
  readonly computeKeys: GraphPlanV1["envelope"]["computeKeys"];
  readonly effects: GraphPlanV1["envelope"]["effects"];
  readonly graphPlanSha256: string;
  readonly initialSubjects: GraphPlanV1["staticBindings"]["initialSubjects"];
  readonly operationKinds: GraphPlanV1["envelope"]["operationKinds"];
  readonly outputs: GraphPlanV1["graph"]["outputs"];
  readonly preparation: GraphPlanV1["envelope"]["preparation"];
  readonly resources: GraphPlanV1["envelope"]["resources"];
  readonly topologicalWaves: GraphPlanV1["topologicalWaves"];
  readonly unresolved: GraphPlanV1["envelope"]["unresolved"];
  readonly warning: string;
  readonly workflow: {
    readonly id: string;
    readonly version: number;
  };
}

export interface CheckedWorkflowSource {
  readonly bundleSha256: string;
  readonly bytes: number;
  readonly dependencyGraphSha256: string;
  readonly entrypoint: string;
  readonly importedModules: readonly string[];
  readonly runtime: {
    readonly bunRevision: string;
    readonly bunVersion: string;
    readonly format: "esm";
    readonly target: "bun";
  };
  readonly sourceSha256: string;
  readonly warning: string;
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function missing(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "ENOENT";
}

async function physicalRepositoryRoot(repositoryRoot: string): Promise<{
  readonly lexical: string;
  readonly physical: string;
}> {
  const lexical = resolve(repositoryRoot);
  const details = await lstat(lexical);
  if (!details.isDirectory()) {
    throw new ApplicationError("unsafe-path", "The repository root must be a directory.");
  }
  return {
    lexical,
    physical: await realpath(lexical),
  };
}

function repositoryRelativePath(
  lexicalRoot: string,
  requested: string,
): { readonly absolute: string; readonly relativePath: string } {
  const absolute = resolve(lexicalRoot, requested);
  const relativePath = relative(lexicalRoot, absolute);
  if (
    relativePath === ""
    || relativePath.startsWith("..")
    || isAbsolute(relativePath)
  ) {
    throw new ApplicationError(
      "unsafe-path",
      `Path must name a file inside the repository: ${requested}`,
    );
  }
  return { absolute, relativePath };
}

async function physicalRepositoryFile(
  repositoryRoot: string,
  requested: string,
  maximumBytes: number,
): Promise<{
  readonly handle: Awaited<ReturnType<typeof open>>;
  readonly path: string;
  readonly size: number;
}> {
  const root = await physicalRepositoryRoot(repositoryRoot);
  const candidate = repositoryRelativePath(root.lexical, requested);
  const expectedPhysical = resolve(root.physical, candidate.relativePath);
  const details = await lstat(candidate.absolute);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new ApplicationError(
      "unsafe-path",
      `Input must be a physical regular file: ${requested}`,
    );
  }
  const physical = await realpath(candidate.absolute);
  if (
    physical !== expectedPhysical
    || !isWithin(root.physical, physical)
  ) {
    throw new ApplicationError(
      "unsafe-path",
      `Input crosses a symbolic link outside its repository path: ${requested}`,
    );
  }
  if (details.size > maximumBytes) {
    throw new ApplicationError(
      "invalid-data",
      `Input exceeds ${String(maximumBytes)} bytes: ${requested}`,
    );
  }
  const handle = await open(
    physical,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  const opened = await handle.stat();
  if (
    !opened.isFile()
    || opened.dev !== details.dev
    || opened.ino !== details.ino
    || opened.size !== details.size
  ) {
    await handle.close();
    throw new ApplicationError(
      "conflict",
      `Input changed while it was being opened: ${requested}`,
    );
  }
  return { handle, path: physical, size: opened.size };
}

export async function readWorkflowInput(
  application: ApplicationContext,
  requested: string,
): Promise<unknown> {
  const opened = await physicalRepositoryFile(
    application.paths.repositoryRoot,
    requested,
    MAXIMUM_WORKFLOW_INPUT_BYTES,
  );
  try {
    const bytes = await opened.handle.readFile();
    const final = await opened.handle.stat();
    if (final.size !== opened.size || bytes.byteLength !== opened.size) {
      throw new ApplicationError(
        "conflict",
        `Workflow input changed while it was being read: ${requested}`,
      );
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ApplicationError(
        "invalid-data",
        `Workflow input is not valid UTF-8: ${requested}`,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new ApplicationError(
        "invalid-data",
        `Workflow input is not valid JSON: ${requested}`,
        { reason: String(error) },
      );
    }
  } finally {
    await opened.handle.close();
  }
}

export function workflowPlanSummary(plan: GraphPlanV1): WorkflowPlanSummary {
  return {
    bounds: plan.envelope.bounds,
    computeKeys: plan.envelope.computeKeys,
    effects: plan.envelope.effects,
    graphPlanSha256: plan.graphPlanSha256,
    initialSubjects: plan.staticBindings.initialSubjects,
    operationKinds: plan.envelope.operationKinds,
    outputs: plan.graph.outputs,
    preparation: plan.envelope.preparation,
    resources: plan.envelope.resources,
    topologicalWaves: plan.topologicalWaves,
    unresolved: plan.envelope.unresolved,
    warning: TRUSTED_CODE_WARNING,
    workflow: {
      id: plan.graph.workflow.id,
      version: plan.graph.workflow.version,
    },
  };
}

export function humanWorkflowPlan(summary: WorkflowPlanSummary): string {
  const waves = summary.topologicalWaves
    .map((wave, index) => `wave ${String(index + 1)} ${wave.join(" ")}`)
    .join("\n");
  return [
    `${summary.workflow.id}@${String(summary.workflow.version)} ${summary.graphPlanSha256}`,
    `${String(summary.bounds.nodes)} nodes, ${String(summary.topologicalWaves.length)} waves`,
    `operations ${summary.operationKinds.join(" ") || "none"}`,
    `compute ${summary.computeKeys.join(" ") || "none"}`,
    `unresolved ${summary.unresolved.join(" ") || "none"}`,
    waves,
    `warning ${summary.warning}`,
  ].filter(line => line !== "").join("\n");
}

export function operationDiscoveryList(
  registry: OperationRegistry,
): readonly OperationDiscovery[] {
  return registry.list();
}

export function operationDiscovery(
  registry: OperationRegistry,
  requested: string,
): OperationDescription {
  const matches = registry.list().filter(operation => (
    operation.kind === requested
    || `${operation.kind}@${String(operation.version)}` === requested
  ));
  if (matches.length === 0) {
    throw new ApplicationError("not-found", `Unknown registered operation: ${requested}`);
  }
  if (matches.length > 1) {
    throw new ApplicationError(
      "conflict",
      `Operation ${requested} has multiple versions; use <kind>@<version>.`,
    );
  }
  const match = matches[0]!;
  return registry.describe(match.kind, match.version);
}

export function humanOperation(operation: OperationDiscovery): string {
  return [
    `${operation.kind}@${String(operation.version)}`,
    `schemas ${operation.inputSchemaId} -> ${operation.outputSchemaId}`,
    `lifecycle ${operation.lifecycle}`,
    `effect ${operation.policy.effect}; resume ${operation.policy.resume}; cache ${operation.policy.cache}`,
    `resources ${operation.policy.resources.map(claim => `${claim.resource}:${String(claim.amount)}`).join(" ") || "none"}`,
    `preparation ${operation.policy.preparation.join(" ") || "none"}`,
    `bounds input=${String(operation.policy.maxInputBytes)} output=${String(operation.policy.maxOutputBytes)} durationMs=${String(operation.policy.maxDurationMs)} fanOut=${String(operation.policy.maxFanOut)}`,
  ].join("\n");
}

export function humanOperationList(
  operations: readonly OperationDiscovery[],
): string {
  return operations.map(operation => (
    `${operation.kind}@${String(operation.version)}\t${operation.policy.effect}\t${operation.lifecycle}`
  )).join("\n");
}

export function workflowCatalogEntry(workflow: BuiltInWorkflow) {
  return {
    description: workflow.description,
    id: workflow.id,
    inputSchemaId: workflow.inputSchemaId,
    title: workflow.title,
    version: workflow.version,
  } as const;
}

export function workflowCatalogDescription(workflow: BuiltInWorkflow) {
  return {
    ...workflowCatalogEntry(workflow),
    inputJsonSchema: {
      ...z.toJSONSchema(workflow.inputSchema),
      $id: workflow.inputSchemaId,
    },
  } as const;
}

export function humanWorkflow(workflow: BuiltInWorkflow): string {
  return [
    `${workflow.id}@${String(workflow.version)} — ${workflow.title}`,
    workflow.description,
    `input ${workflow.inputSchemaId}`,
  ].join("\n");
}

export async function planCustomWorkflow(options: {
  readonly application: ApplicationContext;
  readonly inputPath: string;
  readonly registry: OperationRegistry;
  readonly sourcePath: string;
}) {
  const workflowInput = await readWorkflowInput(
    options.application,
    options.inputPath,
  );
  return await planCodeWorkflow({
    application: options.application,
    entryPath: resolve(
      options.application.paths.repositoryRoot,
      options.sourcePath,
    ),
    registry: options.registry,
    workflowInput,
  });
}

export async function prepareCustomWorkflowRun(options: {
  readonly application: ApplicationContext;
  readonly inputPath: string;
  readonly registry: OperationRegistry;
  readonly sourcePath: string;
}) {
  const workflowInput = await readWorkflowInput(
    options.application,
    options.inputPath,
  );
  return await prepareCodeWorkflowRun({
    application: options.application,
    entryPath: resolve(
      options.application.paths.repositoryRoot,
      options.sourcePath,
    ),
    registry: options.registry,
    workflowInput,
  });
}

export async function planCatalogWorkflow(options: {
  readonly application: ApplicationContext;
  readonly inputPath: string;
  readonly registry: OperationRegistry;
  readonly workflow: BuiltInWorkflow;
}) {
  return await planBuiltInWorkflow({
    application: options.application,
    registry: options.registry,
    workflow: options.workflow,
    workflowInput: await readWorkflowInput(
      options.application,
      options.inputPath,
    ),
  });
}

export async function checkCustomWorkflow(options: {
  readonly application: ApplicationContext;
  readonly sourcePath: string;
}): Promise<CheckedWorkflowSource> {
  const bundle = await checkAndBundleWorkflowSource({
    allowedRoot: options.application.paths.repositoryRoot,
    entryPath: resolve(
      options.application.paths.repositoryRoot,
      options.sourcePath,
    ),
    ...(options.application.hostResourceLease === undefined
      ? {}
      : {
          inheritedHostResourceFileDescriptor:
            options.application.hostResourceLease.inheritedFileDescriptor,
        }),
  });
  return {
    bundleSha256: bundle.sha256,
    bytes: bundle.bytes.byteLength,
    dependencyGraphSha256: bundle.dependencyGraphSha256,
    entrypoint: bundle.entryRelativePath,
    importedModules: bundle.importedPaths,
    runtime: {
      bunRevision: bundle.identity.bunRevision,
      bunVersion: bundle.identity.bunVersion,
      format: bundle.identity.format,
      target: bundle.identity.target,
    },
    sourceSha256: bundle.sourceSha256,
    warning: TRUSTED_CODE_WARNING,
  };
}

function workflowIdForPath(path: string): string {
  const withoutExtension = basename(path, extname(path))
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
  return /^[a-z]/u.test(withoutExtension)
    ? withoutExtension.slice(0, 128)
    : `workflow-${withoutExtension || "custom"}`.slice(0, 128);
}

function workflowTemplate(path: string): string {
  const id = workflowIdForPath(path);
  const defaultOutput = `renders/${id}/final.mp4`;
  return `import { z } from "zod";
import { defineWorkflow } from "@hraness/atet/local/code";

const EvenDimensionSchema = z.number()
  .int()
  .safe()
  .positive()
  .max(16_384)
  .refine(value => value % 2 === 0, "H.264 output dimensions must be even.");

const RenderSchema = z.strictObject({
  background: z.string()
    .regex(/^#[a-fA-F0-9]{6}(?:[a-fA-F0-9]{2})?$/u)
    .default("#000000"),
  frameRate: z.number().finite().positive().max(240).default(30),
  maximumBytes: z.number()
    .int()
    .safe()
    .positive()
    .max(1_099_511_627_776)
    .default(8 * 1_024 * 1_024 * 1_024),
  output: z.string()
    .min(12)
    .max(512)
    .regex(
      /^renders\\/(?:[A-Za-z0-9_-]+\\/)*[A-Za-z0-9_-]+\\.mp4$/u,
      "Expected a lowercase .mp4 path below renders/.",
    )
    .default(${JSON.stringify(defaultOutput)}),
  pixelHeight: EvenDimensionSchema.default(1_080),
  pixelWidth: EvenDimensionSchema.default(1_920),
  syncPolicy: z.enum(["require-verified", "allow-unverified"])
    .default("require-verified"),
}).prefault({});

const InputSchema = z.strictObject({
  project: z.string().regex(/^project_[A-Za-z0-9][A-Za-z0-9_-]*$/u),
  render: RenderSchema,
});

export default defineWorkflow({
  id: ${JSON.stringify(id)},
  inputSchema: InputSchema,
  inputSchemaId: ${JSON.stringify(`atet.workflow.${id}.input/v1`)},
  version: 1,
  build(workflow, input) {
    const project = workflow.project.snapshot("project", input.project);
    const revision = workflow.project.freezeRevision("revision", {
      pixelHeight: input.render.pixelHeight,
      pixelWidth: input.render.pixelWidth,
      project,
    });
    const renderPlan = workflow.render.plan("render-plan", {
      revision,
      settings: {
        background: input.render.background,
        frameRate: input.render.frameRate,
      },
    });
    const render = workflow.render.project("render", {
      output: {
        maximumBytes: input.render.maximumBytes,
        path: input.render.output,
      },
      plan: renderPlan,
      syncPolicy: input.render.syncPolicy,
    });
    return { render, renderPlan, revision: revision.revision };
  },
});
`;
}

async function ensurePhysicalParentWithinRepository(
  repositoryRoot: string,
  requested: string,
): Promise<string> {
  const root = await physicalRepositoryRoot(repositoryRoot);
  const candidate = repositoryRelativePath(root.lexical, requested);
  const segments = relative(root.lexical, dirname(candidate.absolute))
    .split(/[\\/]/u)
    .filter(segment => segment !== "" && segment !== ".");
  let lexicalDirectory = root.lexical;
  let physicalDirectory = root.physical;
  for (const segment of segments) {
    lexicalDirectory = resolve(lexicalDirectory, segment);
    physicalDirectory = resolve(physicalDirectory, segment);
    try {
      const details = await lstat(lexicalDirectory);
      if (details.isSymbolicLink() || !details.isDirectory()) {
        throw new ApplicationError(
          "unsafe-path",
          `Workflow parent must contain only physical directories: ${requested}`,
        );
      }
    } catch (error) {
      if (!missing(error)) throw error;
      await mkdir(lexicalDirectory, { mode: 0o700 });
    }
    if (await realpath(lexicalDirectory) !== physicalDirectory) {
      throw new ApplicationError(
        "unsafe-path",
        `Workflow parent crosses a symbolic link: ${requested}`,
      );
    }
  }
  return candidate.absolute;
}

export async function initializeWorkflowSource(
  application: ApplicationContext,
  requested: string,
): Promise<{ readonly bytes: number; readonly path: string }> {
  const path = await ensurePhysicalParentWithinRepository(
    application.paths.repositoryRoot,
    requested,
  );
  if (![".ts", ".tsx", ".mts", ".cts"].includes(extname(path).toLowerCase())) {
    throw new ApplicationError(
      "usage",
      "Workflow source should use a TypeScript extension (.ts, .tsx, .mts, or .cts).",
    );
  }
  const source = workflowTemplate(path);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      path,
      constants.O_WRONLY
        | constants.O_CREAT
        | constants.O_EXCL
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new ApplicationError(
        "conflict",
        `Workflow source already exists; code init never overwrites: ${requested}`,
      );
    }
    throw error;
  }
  try {
    await handle.writeFile(source, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {
    bytes: Buffer.byteLength(source),
    path: relative(application.paths.repositoryRoot, path),
  };
}
