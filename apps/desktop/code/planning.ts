import { ApplicationError } from "../application/errors";
import type { ApplicationContext } from "../application/context";
import { openLeasedProjectSnapshot } from "../application/project-publication-lease";
import type { OperationRegistry } from "../application/registry";
import { canonicalJson, sha256Hex } from "../core/canonical-json";
import type { BuiltInWorkflow } from "../workflows";
import {
  STATIC_BINDINGS_VERSION,
  StaticBindingsSchema,
  isComputeGraphNode,
  isOperationGraphNode,
  type GraphPlanV1,
  type InitialSubjectBinding,
  type WorkflowBundleIdentity,
} from "./contracts";
import { compileGraphPlan } from "./compiler";
import {
  collectDeclaredFileCandidates,
  collectLiteralFileCandidates,
  mergeFileCandidateDescriptors,
} from "./file-candidate-provenance";
import {
  createHostApplicationBuildIdentity,
  createWorkflowRuntimeIdentity,
} from "./runtime-identity";
import {
  checkAndBundleWorkflowSource,
  workflowBundleContract,
  type WorkflowSourceBundle,
} from "./source-bundle";
import {
  startCodeWorker,
  startCodeWorkerPool,
  type CodeWorkerPool,
  type CodeWorkerSession,
} from "./worker-client";

export const TRUSTED_CODE_WARNING = [
  "Trusted code mode is not a sandbox.",
  "Workflow TypeScript runs with the current user's filesystem, process, and network authority.",
].join(" ");

export interface PlanCodeWorkflowOptions {
  readonly application: ApplicationContext;
  readonly applicationBuild?: string;
  readonly bunExecutable?: string;
  readonly entryPath: string;
  readonly registry: OperationRegistry;
  readonly workflowInput: unknown;
}

export interface PlannedCodeWorkflow {
  readonly bundle: WorkflowSourceBundle;
  readonly diagnostics: {
    readonly stderr: string;
    readonly stdout: string;
  };
  readonly plan: GraphPlanV1;
  readonly warning: string;
}

export interface PreparedCodeWorkflowRun extends PlannedCodeWorkflow {
  startWorkerPool(
    maximumWorkers: number,
    options?: {
      readonly inheritedHostResourceFileDescriptor?: number;
    },
  ): Promise<CodeWorkerPool>;
  readonly worker: CodeWorkerSession;
}

export interface PlannedBuiltInWorkflow {
  readonly bundleBytes: Uint8Array;
  readonly plan: GraphPlanV1;
}

function projectReference(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const project: unknown = Reflect.get(input, "project");
  return typeof project === "string" ? project : undefined;
}

async function staticBindings(
  application: ApplicationContext,
  graph: GraphPlanV1["graph"],
  workflowInput: GraphPlanV1["workflowInput"],
) {
  const references = new Set<string>();
  for (const node of graph.nodes) {
    if (
      !isOperationGraphNode(node)
      || node.executor.operation.kind !== "project.snapshot"
    ) continue;
    const reference = projectReference(node.input);
    if (reference !== undefined) references.add(reference);
  }
  const initialSubjects: InitialSubjectBinding[] = [];
  for (const reference of [...references].sort()) {
    const snapshot = await openLeasedProjectSnapshot(application, reference);
    initialSubjects.push({
      descriptorSha256: sha256Hex(
        `studio.workflow.project-binding/v1\0${canonicalJson({
          id: snapshot.project.projectId,
          planSha256: snapshot.generation.currentPlanSha256,
          projectSha256: snapshot.generation.projectSha256,
        })}`,
      ),
      id: snapshot.project.projectId,
      kind: "project",
      planSha256: snapshot.generation.currentPlanSha256,
      projectSha256: snapshot.generation.projectSha256,
    });
  }
  return StaticBindingsSchema.parse({
    candidates: mergeFileCandidateDescriptors([
      collectLiteralFileCandidates(graph),
      collectDeclaredFileCandidates(workflowInput),
    ]),
    initialSubjects,
    version: STATIC_BINDINGS_VERSION,
  });
}

async function prepareCodeWorkflow(
  options: PlanCodeWorkflowOptions,
): Promise<PreparedCodeWorkflowRun> {
  const applicationBuild = options.applicationBuild
    ?? await createHostApplicationBuildIdentity(options.application);
  const bundle = await checkAndBundleWorkflowSource({
    allowedRoot: options.application.paths.repositoryRoot,
    entryPath: options.entryPath,
    ...(options.application.hostResourceLease === undefined
      ? {}
      : {
          inheritedHostResourceFileDescriptor:
            options.application.hostResourceLease.inheritedFileDescriptor,
        }),
  });
  const worker = await startCodeWorker({
    ...(options.bunExecutable === undefined ? {} : { bunExecutable: options.bunExecutable }),
    bundle,
    ...(options.application.hostResourceLease === undefined
      ? {}
      : {
          inheritedHostResourceFileDescriptor:
            options.application.hostResourceLease.inheritedFileDescriptor,
        }),
    temporaryRoot: options.application.paths.privateRoot,
  });
  try {
    const built = await worker.build(options.registry, options.workflowInput);
    const runtime = await createWorkflowRuntimeIdentity({
      applicationBuild,
      bundle,
    });
    const provisional = compileGraphPlan({
      bundle: workflowBundleContract(bundle),
      graph: built.graph,
      registry: options.registry,
      runtime,
      workflowInput: built.input,
    });
    const plan = compileGraphPlan({
      bundle: workflowBundleContract(bundle),
      graph: built.graph,
      registry: options.registry,
      runtime,
      staticBindings: await staticBindings(
        options.application,
        provisional.graph,
        provisional.workflowInput,
      ),
      workflowInput: built.input,
    });
    let workerTransferred = false;
    return {
      bundle,
      diagnostics: built.diagnostics,
      plan,
      startWorkerPool: async (maximumWorkers, poolOptions = {}) => {
        if (workerTransferred) {
          throw new ApplicationError(
            "conflict",
            "The prepared code worker was already transferred to a worker pool.",
          );
        }
        workerTransferred = true;
        return await startCodeWorkerPool({
          ...(options.bunExecutable === undefined
            ? {}
            : { bunExecutable: options.bunExecutable }),
          bundle,
          expectedBuild: built,
          initialWorker: {
            build: built,
            session: worker,
          },
          ...(poolOptions.inheritedHostResourceFileDescriptor === undefined
            ? {}
            : {
                inheritedHostResourceFileDescriptor:
                  poolOptions.inheritedHostResourceFileDescriptor,
              }),
          maximumWorkers,
          registry: options.registry,
          temporaryRoot: options.application.paths.privateRoot,
          workflowInput: options.workflowInput,
        });
      },
      warning: TRUSTED_CODE_WARNING,
      worker,
    };
  } catch (error) {
    await worker.close().catch(() => undefined);
    throw error;
  }
}

export async function prepareCodeWorkflowRun(
  options: PlanCodeWorkflowOptions,
): Promise<PreparedCodeWorkflowRun> {
  return await prepareCodeWorkflow(options);
}

export async function planCodeWorkflow(
  options: PlanCodeWorkflowOptions,
): Promise<PlannedCodeWorkflow> {
  const prepared = await prepareCodeWorkflow(options);
  try {
    return {
      bundle: prepared.bundle,
      diagnostics: prepared.diagnostics,
      plan: prepared.plan,
      warning: prepared.warning,
    };
  } finally {
    await prepared.worker.close();
  }
}

export interface PlanBuiltInWorkflowOptions {
  readonly application: ApplicationContext;
  readonly applicationBuild?: string;
  readonly registry: OperationRegistry;
  readonly workflow: BuiltInWorkflow;
  readonly workflowInput: unknown;
}

export async function planBuiltInWorkflow(
  options: PlanBuiltInWorkflowOptions,
): Promise<PlannedBuiltInWorkflow> {
  const applicationBuild = options.applicationBuild
    ?? await createHostApplicationBuildIdentity(options.application);
  const built = options.workflow.build(options.registry, options.workflowInput);
  if (built.graph.nodes.some(isComputeGraphNode)) {
    throw new ApplicationError(
      "unsupported-plan",
      "Built-in workflows cannot register trusted compute callbacks in a synthetic bundle.",
    );
  }
  const bundleBytes = new TextEncoder().encode(`${canonicalJson({
    id: options.workflow.id,
    inputSchemaId: options.workflow.inputSchemaId,
    version: options.workflow.version,
  })}\n`);
  const bundleSha256 = sha256Hex(new TextDecoder().decode(bundleBytes));
  const bundle: WorkflowBundleIdentity = {
    bundleSha256,
    bytes: bundleBytes.byteLength,
    dependencyGraphSha256: bundleSha256,
    entrypoint: `builtin:${options.workflow.id}@${String(options.workflow.version)}`,
    sourceSha256: bundleSha256,
  };
  const runtime = {
    ...(await createWorkflowRuntimeIdentity({
      applicationBuild,
      bundle: {
        bytes: bundleBytes,
        dependencyGraphSha256: bundleSha256,
        entryPath: `builtin:${options.workflow.id}`,
        entryRelativePath: `builtin:${options.workflow.id}`,
        externalImports: [],
        identity: {
          bunRevision: Bun.revision,
          bunVersion: Bun.version,
          format: "esm" as const,
          minify: false as const,
          packages: "bundle" as const,
          schemaVersion: 1 as const,
          sourcemap: "none" as const,
          target: "bun" as const,
          treeShaking: false as const,
        },
        importedPaths: [],
        sha256: bundleSha256,
        sourceSha256: bundleSha256,
      },
    })),
    externals: {
      kind: "deny-all" as const,
      modules: [],
      policySha256: sha256Hex("studio.workflow.builtin-externals/v1"),
    },
  };
  const provisional = compileGraphPlan({
    bundle,
    graph: built.graph,
    registry: options.registry,
    runtime,
    workflowInput: built.input,
  });
  return {
    bundleBytes,
    plan: compileGraphPlan({
      bundle,
      graph: built.graph,
      registry: options.registry,
      runtime,
      staticBindings: await staticBindings(
        options.application,
        provisional.graph,
        provisional.workflowInput,
      ),
      workflowInput: built.input,
    }),
  };
}

export function assertPlanHash(plan: GraphPlanV1, requested: string | undefined): void {
  if (requested !== undefined && requested !== plan.graphPlanSha256) {
    throw new ApplicationError(
      "conflict",
      "The requested graph plan hash does not match current code, inputs, bindings, or runtime.",
      {
        actual: plan.graphPlanSha256,
        requested,
      },
    );
  }
}
