import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  createDefaultHostResourceCoordinator,
  HOST_RESOURCE_MAX_WAIT_MILLISECONDS,
  HostResourceError,
  type HostResourceCoordinator,
  type HostResourceLease,
} from "@hraness/atet/host-resources";

import type { ApplicationContext } from "../application/context";
import { ApplicationError } from "../application/errors";
import type { OperationRegistry } from "../application/registry";
import { canonicalJson } from "../core/canonical-json";
import { createApplicationNodePlanner } from "../code/application-node-planner";
import { compileGraphPlan } from "../code/compiler";
import {
  isComputeGraphNode,
  isOperationGraphNode,
  type GraphPlanV1,
  type WorkflowNodePolicy,
} from "../code/contracts";
import {
  RUN_STORE_VERSION,
  type NewRunGrant,
  type RunEvent,
  type RunGrant,
  type RunNodeRecord,
  type RunSummary,
  type RunWorkflowRecord,
} from "../code/run-contracts";
import { RunStore } from "../code/run-store";
import {
  createHostApplicationBuildIdentity,
  createWorkflowRuntimeIdentity,
} from "../code/runtime-identity";
import {
  DurableWorkflowScheduler,
  type SchedulerComputeRuntime,
  type SchedulerAuthorization,
  type SchedulerRunResult,
} from "../code/scheduler";
import { restoreWorkflowSourceBundle } from "../code/source-bundle";
import {
  startCodeWorkerPool,
  type CodeWorkerPool,
} from "../code/worker-client";
import {
  codePreparationHostResourceClaims,
  replayComputeWorkerPoolSize,
} from "./command-host-resources";

const RUN_DIRECTORY = "workflow-runs";
const EVENT_POLL_MILLISECONDS = 100;

async function withCodePreparationHostResources<Value>(
  coordinator: HostResourceCoordinator,
  callback: (lease: HostResourceLease) => Promise<Value>,
  options: {
    readonly signal?: AbortSignal;
    readonly waitTimeoutMilliseconds?: number;
  } = {},
): Promise<Value> {
  try {
    return await coordinator.withLease(
      codePreparationHostResourceClaims(coordinator),
      async lease => {
        await lease.assertOwned();
        return await callback(lease);
      },
      {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        waitTimeoutMilliseconds: options.waitTimeoutMilliseconds
          ?? HOST_RESOURCE_MAX_WAIT_MILLISECONDS,
      },
    );
  } catch (error) {
    if (!(error instanceof HostResourceError)) throw error;
    switch (error.code) {
      case "WAIT_ABORTED":
        throw new ApplicationError("cancelled", error.message);
      case "OWNERSHIP_LOST":
        throw new ApplicationError("conflict", error.message);
      case "INVALID_CLAIMS":
      case "INVALID_PROFILE":
      case "PROFILE_MISMATCH":
      case "UNSAFE_STATE":
      case "UNSUPPORTED_PLATFORM":
      case "WAIT_TIMEOUT":
        throw new ApplicationError("unavailable", error.message, {
          hostResourceCode: error.code,
        });
    }
  }
}

export interface CreateWorkflowRunOptions {
  readonly application: ApplicationContext;
  readonly bundleBytes: Uint8Array;
  readonly graphPlan: GraphPlanV1;
  readonly registry: OperationRegistry;
  readonly sourceLocator: string;
}

export interface CreatedWorkflowRun {
  readonly runId: string;
  readonly store: RunStore;
  readonly summary: RunSummary;
}

export interface RunWorkflowOptions {
  readonly application: ApplicationContext;
  readonly compute?: SchedulerComputeRuntime;
  readonly hostResourceCoordinator?: HostResourceCoordinator;
  readonly jobs: number;
  readonly onEvent?: (event: RunEvent) => void;
  readonly replayAmbiguousCode?: readonly string[];
  readonly registry: OperationRegistry;
  readonly runId: string;
  readonly store?: RunStore;
}

async function loadPersistedComputePool(options: {
  readonly application: ApplicationContext;
  readonly currentApplicationBuild: string;
  readonly inheritedHostResourceFileDescriptor?: number;
  readonly maximumWorkers: number;
  readonly registry: OperationRegistry;
  readonly runId: string;
  readonly store: RunStore;
}): Promise<CodeWorkerPool> {
  const [graphPlan, bundleBytes] = await Promise.all([
    options.store.graphPlan(options.runId),
    options.store.bundle(options.runId),
  ]);
  if (
    graphPlan.runtime.externals.kind === "deny-all"
    && graphPlan.runtime.externals.modules.length !== 0
  ) {
    throw new ApplicationError(
      "incompatible",
      "A deny-all trusted-code runtime cannot contain external modules.",
    );
  }
  const bundle = restoreWorkflowSourceBundle({
    bundle: graphPlan.bundle,
    bytes: bundleBytes,
    externalModules: graphPlan.runtime.externals.modules,
  });
  const currentRuntime = await createWorkflowRuntimeIdentity({
    applicationBuild: options.currentApplicationBuild,
    bundle,
  });
  if (canonicalJson(currentRuntime) !== canonicalJson(graphPlan.runtime)) {
    throw new ApplicationError(
      "incompatible",
      "The trusted-code runtime changed since this run was planned.",
      {
        current: currentRuntime,
        planned: graphPlan.runtime,
      },
    );
  }
  const recompiled = compileGraphPlan({
    bundle: graphPlan.bundle,
    graph: graphPlan.graph,
    limits: graphPlan.limits,
    registry: options.registry,
    runtime: currentRuntime,
    staticBindings: graphPlan.staticBindings,
    workflowInput: graphPlan.workflowInput,
  });
  if (canonicalJson(recompiled) !== canonicalJson(graphPlan)) {
    throw new ApplicationError(
      "incompatible",
      "Persisted trusted code no longer compiles to the exact authorized graph plan.",
    );
  }
  return await startCodeWorkerPool({
    bundle,
    expectedBuild: {
      graph: graphPlan.graph,
      input: graphPlan.workflowInput,
    },
    ...(options.inheritedHostResourceFileDescriptor === undefined
      ? {}
      : {
          inheritedHostResourceFileDescriptor:
            options.inheritedHostResourceFileDescriptor,
        }),
    maximumWorkers: options.maximumWorkers,
    registry: options.registry,
    temporaryRoot: options.application.paths.privateRoot,
    workflowInput: graphPlan.workflowInput,
    workflowInputMode: "parsed",
  });
}

export interface WorkflowRunDetails {
  readonly graphPlanSha256: string;
  readonly nodes: readonly RunNodeRecord[];
  readonly outputs: unknown;
  readonly summary: RunSummary;
  readonly workflow: RunWorkflowRecord["workflow"];
}

function schedulerOwner(): string {
  return `atet-cli:${String(process.pid)}:${randomUUID()}`;
}

function runId(): string {
  return `run_${randomUUID().replaceAll("-", "")}`;
}

function operationRuntimeIdentities(
  graphPlan: GraphPlanV1,
): Extract<
  GraphPlanV1["graph"]["nodes"][number]["executor"],
  { readonly kind: "operation" }
>["operation"][] {
  type Identity = Extract<
    GraphPlanV1["graph"]["nodes"][number]["executor"],
    { readonly kind: "operation" }
  >["operation"];
  const identities = new Map<string, Identity>();
  for (const node of graphPlan.graph.nodes) {
    if (!isOperationGraphNode(node)) continue;
    const operation = node.executor.operation;
    identities.set(
      `${operation.kind}@${String(operation.version)}`,
      operation,
    );
  }
  return [...identities.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, identity]) => identity);
}

function computeRuntimeIdentities(
  graphPlan: GraphPlanV1,
) {
  const identities = new Map<
    string,
    Extract<
      GraphPlanV1["graph"]["nodes"][number]["executor"],
      { readonly kind: "compute" }
    >["compute"]
  >();
  for (const node of graphPlan.graph.nodes) {
    if (isComputeGraphNode(node)) {
      identities.set(node.executor.compute.key, node.executor.compute);
    }
  }
  return [...identities.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, identity]) => identity);
}

export function workflowRunStore(application: ApplicationContext): RunStore {
  return new RunStore({
    root: join(application.paths.privateRoot, RUN_DIRECTORY),
  });
}

export async function createWorkflowRun(
  options: CreateWorkflowRunOptions,
): Promise<CreatedWorkflowRun> {
  const store = workflowRunStore(options.application);
  const createdRunId = runId();
  const summary = await store.create({
    bundleBytes: new Uint8Array(options.bundleBytes),
    graphPlan: options.graphPlan,
    runId: createdRunId,
    runtime: {
      computes: computeRuntimeIdentities(options.graphPlan),
      operations: operationRuntimeIdentities(options.graphPlan),
      runtime: options.graphPlan.runtime,
      version: RUN_STORE_VERSION,
    },
    sourceLocator: options.sourceLocator,
    workflow: {
      bundle: options.graphPlan.bundle,
      sourceLocator: options.sourceLocator,
      workflow: options.graphPlan.graph.workflow,
    },
  });
  return { runId: createdRunId, store, summary };
}

function localPreparationAllowed(policy: WorkflowNodePolicy): boolean {
  const automaticallyAllowed = new Set([
    "local-media",
    "project-state",
  ]);
  return policy.preparation.every(requirement => (
    automaticallyAllowed.has(requirement)
  ));
}

function localEffectAllowed(policy: WorkflowNodePolicy): boolean {
  return policy.effect !== "paid-cloud"
    && policy.effect !== "live-control";
}

function localCliAuthorization(): SchedulerAuthorization {
  return {
    authorizeEffect: request => Promise.resolve(
      localEffectAllowed(request.policy),
    ),
    authorizePreparation: request => Promise.resolve(
      localPreparationAllowed(request.policy),
    ),
    grantedBy: "atet-local-cli",
  };
}

async function readNewEvents(
  store: RunStore,
  runIdValue: string,
  afterSequence: number,
  emit: (event: RunEvent) => void,
): Promise<number> {
  let events: readonly RunEvent[];
  try {
    events = await store.events(runIdValue);
  } catch (error) {
    if (error instanceof ApplicationError && error.code === "conflict") {
      return afterSequence;
    }
    throw error;
  }
  let latest = afterSequence;
  for (const event of events) {
    if (event.sequence <= afterSequence) continue;
    emit(event);
    latest = Math.max(latest, event.sequence);
  }
  return latest;
}

export async function runWorkflow(
  options: RunWorkflowOptions,
): Promise<SchedulerRunResult> {
  const store = options.store ?? workflowRunStore(options.application);
  const hostResourceCoordinator = options.hostResourceCoordinator
    ?? createDefaultHostResourceCoordinator();
  const currentApplicationBuild = await withCodePreparationHostResources(
    hostResourceCoordinator,
    async lease => await createHostApplicationBuildIdentity(
      options.application,
      lease.inheritedFileDescriptor < 3
        ? {}
        : { inheritedFileDescriptors: [lease.inheritedFileDescriptor] },
    ),
  );
  const replayNodeKeys = options.replayAmbiguousCode ?? [];
  if (options.compute !== undefined && replayNodeKeys.length > 0) {
    throw new ApplicationError(
      "usage",
      "A workflow run cannot use a fresh code worker and persisted compute replay together.",
    );
  }
  let replayLoadStarted = false;
  const compute: SchedulerComputeRuntime | undefined = replayNodeKeys.length === 0
    ? options.compute
    : {
      kind: "replay" as const,
      load: async ({ signal, waitTimeoutMilliseconds }) => {
        if (replayLoadStarted) {
          throw new ApplicationError(
            "conflict",
            "The persisted trusted-code worker pool was already loaded.",
          );
        }
        replayLoadStarted = true;
        const replayPool = await withCodePreparationHostResources(
          hostResourceCoordinator,
          async lease => await loadPersistedComputePool({
            application: options.application,
            currentApplicationBuild,
            inheritedHostResourceFileDescriptor: lease.inheritedFileDescriptor,
            maximumWorkers: replayComputeWorkerPoolSize(
              options.jobs,
              replayNodeKeys,
              hostResourceCoordinator,
            ),
            registry: options.registry,
            runId: options.runId,
            store,
          }),
          { signal, waitTimeoutMilliseconds },
        );
        return {
          executor: replayPool,
          release: async () => await replayPool.close(),
        };
      },
      nodeKeys: replayNodeKeys,
    };
  const scheduler = new DurableWorkflowScheduler({
    application: options.application,
    authorization: localCliAuthorization(),
    currentApplicationBuild,
    ...(compute === undefined ? {} : { compute }),
    hostLimits: {
      maxJobs: options.jobs,
    },
    hostResourceCoordinator,
    jobs: options.jobs,
    nodePlanner: createApplicationNodePlanner(options.application),
    owner: schedulerOwner(),
    registry: options.registry,
    store,
  });
  if (options.onEvent === undefined) return await scheduler.run(options.runId);

  const outcome = scheduler.run(options.runId).then(
    result => ({ kind: "result" as const, result }),
    (error: unknown) => ({ error, kind: "error" as const }),
  );
  let sequence = 0;
  while (true) {
    const settled = await Promise.race([
      outcome,
      new Promise<undefined>(resolveDelay => {
        setTimeout(resolveDelay, EVENT_POLL_MILLISECONDS);
      }),
    ]);
    sequence = await readNewEvents(
      store,
      options.runId,
      sequence,
      options.onEvent,
    );
    if (settled === undefined) continue;
    if (settled.kind === "error") throw settled.error;
    return settled.result;
  }
}

export async function approveWorkflowRun(options: {
  readonly application: ApplicationContext;
  readonly nodeKey: string;
  readonly planHash: string;
  readonly planKind: "effect" | "preparation";
  readonly runId: string;
}): Promise<RunGrant> {
  const store = workflowRunStore(options.application);
  const owner = schedulerOwner();
  const fence = await store.acquireClaim(options.runId, { owner });
  try {
    const [graphPlan, node] = await Promise.all([
      store.graphPlan(options.runId),
      store.node(options.runId, options.nodeKey),
    ]);
    if (node.status !== "approval-required") {
      throw new ApplicationError(
        "conflict",
        `Node ${options.nodeKey} is not awaiting approval.`,
      );
    }
    const common = {
      createdAt: new Date().toISOString(),
      graphPlanSha256: graphPlan.graphPlanSha256,
      grantedBy: "atet-local-cli",
      grantId: randomUUID(),
      nodeKey: options.nodeKey,
    } as const;
    let grant: NewRunGrant;
    if (options.planKind === "preparation") {
      const actual = node.preparationPlan?.preparationPlanSha256;
      if (actual !== options.planHash) {
        throw new ApplicationError(
          "conflict",
          "The preparation approval hash does not match the pending node plan.",
          { actual, requested: options.planHash },
        );
      }
      grant = {
        ...common,
        kind: "preparation",
        preparationPlanSha256: options.planHash,
      };
    } else {
      const actual = node.executionPlan?.nodePlanSha256;
      if (actual !== options.planHash) {
        throw new ApplicationError(
          "conflict",
          "The effect approval hash does not match the pending node plan.",
          { actual, requested: options.planHash },
        );
      }
      grant = {
        ...common,
        kind: "effect",
        nodePlanSha256: options.planHash,
      };
    }
    return await store.appendGrant(fence, grant);
  } finally {
    await store.releaseClaim(fence).catch(() => undefined);
  }
}

export async function cancelWorkflowRun(options: {
  readonly application: ApplicationContext;
  readonly runId: string;
}) {
  return await workflowRunStore(options.application).requestCancellation(
    options.runId,
    "atet-local-cli",
  );
}

export async function listWorkflowRuns(
  application: ApplicationContext,
  limit: number,
): Promise<readonly RunSummary[]> {
  return (await workflowRunStore(application).list()).slice(0, limit);
}

export async function workflowRunDetails(options: {
  readonly application: ApplicationContext;
  readonly nodes: "all" | "failed";
  readonly runId: string;
}): Promise<WorkflowRunDetails> {
  const store = workflowRunStore(options.application);
  const [summary, workflow, records, outputs] = await Promise.all([
    store.summary(options.runId),
    store.workflow(options.runId),
    store.nodes(options.runId),
    store.outputs(options.runId),
  ]);
  const visibleNodes = options.nodes === "all"
    ? records
    : records.filter(record => [
      "ambiguous",
      "ambiguous-code",
      "approval-required",
      "failed",
      "incompatible",
    ].includes(record.status));
  return {
    graphPlanSha256: summary.graphPlanSha256,
    nodes: visibleNodes,
    outputs: outputs?.outputs ?? null,
    summary,
    workflow: workflow.workflow,
  };
}

export function humanRunSummary(
  result: SchedulerRunResult,
): string {
  const summary = result.summary;
  const lines = [
    `${summary.runId} ${summary.status} ${summary.graphPlanSha256}`,
    `nodes completed=${String(summary.counts.completed)} failed=${String(summary.counts.failed)} skipped=${String(summary.counts.skipped)} pending=${String(summary.counts.pending)} cancelled=${String(summary.counts.cancelled)}`,
  ];
  if (result.pause !== undefined) {
    const option = result.pause.phase === "effect"
      ? "--node-plan"
      : "--preparation-plan";
    lines.push(
      `next atet runs approve ${summary.runId} ${result.pause.nodeKey} ${option} ${result.pause.planSha256}`,
      `then atet runs resume ${summary.runId}`,
    );
  } else if (
    summary.status !== "completed"
    && summary.status !== "cancelled"
  ) {
    lines.push(`next atet runs show ${summary.runId} --nodes failed`);
  }
  return lines.join("\n");
}
