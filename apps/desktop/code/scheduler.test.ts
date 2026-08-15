import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import {
  createProcessLocalHostResourceCoordinator,
  HOST_RESOURCE_MAX_WAIT_MILLISECONDS,
  type HostResourceClaim,
  type HostResourceCoordinator,
} from "@hraness/atet/host-resources";

import type { ApplicationContext } from "../application/context";
import { ApplicationError } from "../application/errors";
import { withProjectPublicationLease } from "../application/project-publication-lease";
import { MUTATION_LOCK_FILE } from "../cli/mutation-lock";
import {
  type OperationDefinition,
  type OperationExecutionContext,
  type OperationPolicy,
  type OperationResumeClass,
} from "../application/operation";
import { OperationRegistry } from "../application/registry";
import { canonicalJson } from "../core/canonical-json";
import {
  CODE_WORKER_ABI,
  GRAPH_ABI,
  GRAPH_COMPILER_ABI,
  GRAPH_SCHEDULER_ABI,
  type Ref,
  type WorkflowBundleIdentity,
  type WorkflowRuntimeIdentity,
} from "./contracts";
import { compileGraphPlan } from "./compiler";
import { defineCompute } from "./define-workflow";
import { WorkflowGraphBuilder } from "./graph-builder";
import {
  NODE_EXECUTION_PLAN_VERSION,
  NODE_PREPARATION_PLAN_VERSION,
  RUN_STORE_VERSION,
  createNodeExecutionPlanHash,
  createNodeInputHash,
  createNodePreparationPlanHash,
  type CreateRunRecord,
  type NodeExecutionPlan,
  type NodePreparationPlan,
  type RunNodeRecord,
} from "./run-contracts";
import { RunStore } from "./run-store";
import {
  DurableWorkflowScheduler,
  type DurableWorkflowSchedulerOptions,
  type SchedulerAuthorization,
  type SchedulerComputeExecutor,
  type SchedulerComputeExecutorLease,
  type SchedulerNodePlanner,
} from "./scheduler";

const temporaryDirectories: string[] = [];
const HEX = "0".repeat(64);

setDefaultTimeout(15_000);

const schedulerTestHostResources: HostResourceCoordinator = {
  profile: {
    capacities: [],
    id: "scheduler-test-host-resources",
  },
  scope: "process",
  withLease: async (claims, callback) => await callback({
    assertOwned: () => Promise.resolve(),
    claims,
    inheritedFileDescriptor: 0,
    profile: schedulerTestHostResources.profile,
    ticket: "scheduler-test-ticket",
  }),
};

const InputSchema = z.strictObject({
  dependencies: z.array(z.strictObject({
    id: z.string(),
    value: z.number(),
  })).optional(),
  fail: z.boolean().optional(),
  id: z.string(),
  project: z.string().optional(),
  selected: z.number().optional(),
  value: z.number(),
});

const OutputSchema = z.strictObject({
  id: z.string(),
  value: z.number(),
});

type FixtureInput = z.infer<typeof InputSchema>;
type FixtureOutput = z.infer<typeof OutputSchema>;

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  reject(reason?: unknown): void;
  resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function computeExecutorLease(
  executor: SchedulerComputeExecutor,
  release: () => Promise<void> | void = () => undefined,
): SchedulerComputeExecutorLease {
  let released = false;
  return {
    executor,
    release: async () => {
      if (released) return;
      released = true;
      await release();
    },
  };
}

async function settleWithin<Value>(
  promise: Promise<Value>,
  timeoutMs = 4_500,
): Promise<Value> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Promise did not settle within ${String(timeoutMs)}ms.`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "atet-scheduler-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async directory => {
    await rm(directory, { force: true, recursive: true });
  }));
});

const application: ApplicationContext = {
  capabilities: () => Promise.resolve([]),
  capability: name => Promise.resolve({ available: false, name }),
  clock: {
    now: () => new Date(),
    timestampMilliseconds: () => Date.now(),
  },
  paths: {
    artifactRoot: "/tmp",
    desktopRoot: "/tmp",
    privateRoot: "/tmp",
    projectRoot: "/tmp",
    repositoryRoot: "/tmp",
  },
  runner: {
    run: () => Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }),
  },
};

const allowAll: SchedulerAuthorization = {
  authorizeEffect: () => Promise.resolve(true),
  authorizePreparation: () => Promise.resolve(true),
  grantedBy: "scheduler-test",
};

const passThroughPlanner: SchedulerNodePlanner = {
  plan: request => Promise.resolve({
    exactInput: request.resolvedInput,
    publicationKeys: [],
  }),
  prepare: request => Promise.resolve({
    inputDescriptors: request.resolvedInput,
  }),
};

function policy(
  overrides: Partial<OperationPolicy> = {},
): OperationPolicy {
  return {
    cache: "exact-run",
    cancellable: true,
    effect: "pure",
    maxDurationMs: 5_000,
    maxFanOut: 1,
    maxInputBytes: 64 * 1_024,
    maxOutputBytes: 64 * 1_024,
    preparation: [],
    resources: [{ amount: 1, resource: "cpu" }],
    resume: "deterministic",
    ...overrides,
  };
}

function registryFixture(
  execute: (
    context: Parameters<OperationDefinition["lifecycle"]["execute"]>[0],
    input: FixtureInput,
  ) => Promise<FixtureOutput>,
  policyOverrides: Partial<OperationPolicy> = {},
  resume: OperationResumeClass = "deterministic",
): OperationRegistry {
  const registry = new OperationRegistry();
  const definition = {
    inputSchema: InputSchema,
    inputSchemaId: "test.scheduler-input/v1",
    kind: "derive.edit-batch",
    lifecycle: {
      execute,
      kind: "pure",
    },
    outputSchema: OutputSchema,
    outputSchemaId: "test.scheduler-output/v1",
    policy: policy({ ...policyOverrides, resume }),
    summarize: output => ({
      fields: { id: output.id, value: output.value },
      kind: "derive.edit-batch",
    }),
    version: 1,
  } satisfies OperationDefinition<
    "derive.edit-batch",
    FixtureInput,
    FixtureOutput
  >;
  registry.register(definition);
  return registry;
}

interface GraphNodeFixture {
  readonly dependencies?: readonly string[];
  readonly fail?: boolean;
  readonly id: string;
  readonly project?: string;
  readonly selectedDependency?: string;
  readonly value?: number;
}

async function createRun(
  registry: OperationRegistry,
  nodes: readonly GraphNodeFixture[],
  runId: string,
  options: {
    readonly projectFinalOutputs?: boolean;
    readonly storeFactory?: (root: string) => RunStore;
  } = {},
): Promise<{
  readonly graphPlan: CreateRunRecord["graphPlan"];
  readonly store: RunStore;
}> {
  const root = await temporaryDirectory();
  const store = options.storeFactory?.(root) ?? new RunStore({ root });
  const builder = WorkflowGraphBuilder.create(registry);
  const refs = new Map<string, Ref<FixtureOutput>>();
  for (const node of nodes) {
    const dependencies = (node.dependencies ?? []).map((key) => {
      const reference = refs.get(key);
      if (reference === undefined) {
        throw new Error(`Fixture dependency ${key} must be declared before ${node.id}.`);
      }
      return reference;
    });
    const selected = node.selectedDependency === undefined
      ? undefined
      : refs.get(node.selectedDependency)?.select("value");
    if (node.selectedDependency !== undefined && selected === undefined) {
      throw new Error(
        `Fixture dependency ${node.selectedDependency} must be declared before ${node.id}.`,
      );
    }
    refs.set(node.id, builder.operationByKind<FixtureOutput>(node.id, {
      input: {
        ...(dependencies.length === 0 ? {} : { dependencies }),
        ...(node.fail === undefined ? {} : { fail: node.fail }),
        id: node.id,
        ...(node.project === undefined ? {} : { project: node.project }),
        ...(selected === undefined ? {} : { selected }),
        value: node.value ?? 1,
      },
      kind: "derive.edit-batch",
      version: 1,
    }));
  }
  const outputs = Object.fromEntries(
    [...refs.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, reference]) => [
        key,
        options.projectFinalOutputs ? reference.select("value") : reference,
      ]),
  );
  const graph = builder.build({
    id: "scheduler-fixture",
    inputSchemaId: "test.scheduler-workflow-input/v1",
    version: 1,
  }, outputs);
  const bundleBytes = new TextEncoder().encode("export default {};\n");
  const bundle: WorkflowBundleIdentity = {
    bundleSha256: createHash("sha256").update(bundleBytes).digest("hex"),
    bytes: bundleBytes.byteLength,
    dependencyGraphSha256: HEX,
    entrypoint: "scheduler-fixture.ts",
    sourceSha256: "1".repeat(64),
  };
  const runtimeIdentity: WorkflowRuntimeIdentity = {
    applicationBuild: "scheduler-test",
    bunRevision: Bun.revision,
    bunVersion: Bun.version,
    bundlerConfigurationSha256: "2".repeat(64),
    bundlerName: "bun",
    bundlerRevision: Bun.revision,
    bundlerVersion: Bun.version,
    codeWorkerAbi: CODE_WORKER_ABI,
    compilerAbi: GRAPH_COMPILER_ABI,
    externals: {
      kind: "deny-all",
      modules: [],
      policySha256: "3".repeat(64),
    },
    graphAbi: GRAPH_ABI,
    schedulerAbi: GRAPH_SCHEDULER_ABI,
  };
  const graphPlan = compileGraphPlan({
    bundle,
    graph,
    registry,
    runtime: runtimeIdentity,
    workflowInput: {},
  });
  await store.create({
    bundleBytes,
    graphPlan,
    runId,
    runtime: {
      computes: [],
      operations: [{ kind: "derive.edit-batch", version: 1 }],
      runtime: runtimeIdentity,
      version: RUN_STORE_VERSION,
    },
    sourceLocator: "scheduler-fixture.ts",
    workflow: {
      bundle,
      sourceLocator: "scheduler-fixture.ts",
      workflow: graph.workflow,
    },
  });
  return { graphPlan, store };
}

const COMPUTE_KEY = "test.scheduler.compute";

async function createComputeRun(
  registry: OperationRegistry,
  runId: string,
  computeNodeIds: readonly string[] = ["compute"],
): Promise<{
  readonly graphPlan: CreateRunRecord["graphPlan"];
  readonly store: RunStore;
}> {
  const root = await temporaryDirectory();
  const store = new RunStore({ root });
  const builder = WorkflowGraphBuilder.create(registry);
  const compute = defineCompute({
    inputSchema: InputSchema,
    inputSchemaId: "test.scheduler-compute-input/v1",
    key: COMPUTE_KEY,
    maxDurationMs: 5_000,
    maxInputBytes: 64 * 1_024,
    maxOutputBytes: 64 * 1_024,
    outputSchema: OutputSchema,
    outputSchemaId: "test.scheduler-compute-output/v1",
    run: input => ({ id: input.id, value: input.value + 1 }),
  });
  const computes = new Map(computeNodeIds.map((nodeKey, index) => [
    nodeKey,
    builder.compute(nodeKey, compute, {
      id: nodeKey,
      value: index + 2,
    }),
  ]));
  const computed = computes.get(computeNodeIds[0] ?? "");
  if (computed === undefined) throw new Error("Compute fixture requires at least one node.");
  const dependent = builder.operationByKind<FixtureOutput>("dependent", {
    input: {
      dependencies: [computed],
      id: "dependent",
      value: 4,
    },
    kind: "derive.edit-batch",
    version: 1,
  });
  const graph = builder.build({
    id: "scheduler-compute-fixture",
    inputSchemaId: "test.scheduler-compute-workflow-input/v1",
    version: 1,
  }, {
    ...Object.fromEntries(computes),
    dependent,
  });
  const bundleBytes = new TextEncoder().encode("export default {};\n");
  const bundle: WorkflowBundleIdentity = {
    bundleSha256: createHash("sha256").update(bundleBytes).digest("hex"),
    bytes: bundleBytes.byteLength,
    dependencyGraphSha256: HEX,
    entrypoint: "scheduler-compute-fixture.ts",
    sourceSha256: "1".repeat(64),
  };
  const runtimeIdentity: WorkflowRuntimeIdentity = {
    applicationBuild: "scheduler-test",
    bunRevision: Bun.revision,
    bunVersion: Bun.version,
    bundlerConfigurationSha256: "2".repeat(64),
    bundlerName: "bun",
    bundlerRevision: Bun.revision,
    bundlerVersion: Bun.version,
    codeWorkerAbi: CODE_WORKER_ABI,
    compilerAbi: GRAPH_COMPILER_ABI,
    externals: {
      kind: "deny-all",
      modules: [],
      policySha256: "3".repeat(64),
    },
    graphAbi: GRAPH_ABI,
    schedulerAbi: GRAPH_SCHEDULER_ABI,
  };
  const graphPlan = compileGraphPlan({
    bundle,
    graph,
    registry,
    runtime: runtimeIdentity,
    workflowInput: {},
  });
  await store.create({
    bundleBytes,
    graphPlan,
    runId,
    runtime: {
      computes: [...new Map(graph.nodes.flatMap(node => (
        node.executor.kind === "compute"
          ? [[node.executor.compute.key, node.executor.compute] as const]
          : []
      ))).values()],
      operations: [{ kind: "derive.edit-batch", version: 1 }],
      runtime: runtimeIdentity,
      version: RUN_STORE_VERSION,
    },
    sourceLocator: "scheduler-compute-fixture.ts",
    workflow: {
      bundle,
      sourceLocator: "scheduler-compute-fixture.ts",
      workflow: graph.workflow,
    },
  });
  return { graphPlan, store };
}

function scheduler(
  store: RunStore,
  registry: OperationRegistry,
  overrides: Partial<DurableWorkflowSchedulerOptions> = {},
): DurableWorkflowScheduler {
  return new DurableWorkflowScheduler({
    application,
    authorization: allowAll,
    cancellationPollMs: 5,
    currentApplicationBuild: "scheduler-test",
    hostResourceCoordinator: schedulerTestHostResources,
    hostLimits: {
      maxJobs: 4,
      resources: {
        cpu: 4,
        vision: 1,
      },
    },
    nodePlanner: passThroughPlanner,
    owner: "scheduler-test",
    registry,
    store,
    ...overrides,
  });
}

class CountingNodeReadRunStore extends RunStore {
  nodeListReads = 0;

  override async nodes(runId: string): Promise<readonly RunNodeRecord[]> {
    this.nodeListReads += 1;
    return await super.nodes(runId);
  }
}

describe("durable workflow scheduler", () => {
  // This durable-filesystem semantic ceiling detects hangs, not latency.
  test("prepares each ready node once while serial admission drains a wide graph", async () => {
    const nodeCount = 64;
    let executions = 0;
    const registry = registryFixture((_context, input) => {
      executions += 1;
      return Promise.resolve({ id: input.id, value: input.value });
    });
    const runId = "run_wide_serial_admission01";
    const run = await createRun(
      registry,
      Array.from({ length: nodeCount }, (_, index) => ({
        id: `root-${String(index).padStart(3, "0")}`,
      })),
      runId,
    );

    const result = await scheduler(run.store, registry, {
      hostLimits: {
        maxJobs: 1,
        resources: { cpu: 1 },
      },
    }).run(runId);
    const events = await run.store.events(runId);
    const nodeEvents = events.filter(event => event.kind === "node-status");

    expect(result.summary.status).toBe("completed");
    expect(executions).toBe(nodeCount);
    expect(nodeEvents).toHaveLength(nodeCount * 4);
    expect(events).toHaveLength(nodeCount * 4 + 3);
    for (let index = 0; index < nodeCount; index += 1) {
      const nodeKey = `root-${String(index).padStart(3, "0")}`;
      expect(nodeEvents
        .filter(event => event.nodeKey === nodeKey)
        .map(event => event.details.status))
        .toEqual(["preparing", "ready", "running", "completed"]);
    }
  }, 120_000);

  test("cancels cleanly when the durable marker appears at final admission", async () => {
    const runId = "run_cancel_at_final_admission";
    let executions = 0;
    class CancellationAtAdmissionStore extends RunStore {
      #requested = false;

      override async assertFence(fence: Parameters<RunStore["assertFence"]>[0]): Promise<void> {
        await super.assertFence(fence);
        if (this.#requested) return;
        const record = await this.node(runId, "only");
        if (record.status !== "ready" || record.executionPlan === undefined) return;
        this.#requested = true;
        await this.requestCancellation(runId, "final-admission-test");
      }
    }
    const registry = registryFixture((_context, input) => {
      executions += 1;
      return Promise.resolve({ id: input.id, value: input.value });
    });
    const run = await createRun(registry, [{ id: "only" }], runId, {
      storeFactory: root => new CancellationAtAdmissionStore({ root }),
    });

    const result = await scheduler(run.store, registry, {
      hostLimits: { maxJobs: 1, resources: { cpu: 1 } },
    }).run(runId);

    expect(result.summary.status).toBe("cancelled");
    expect(executions).toBe(0);
    expect((await run.store.node(runId, "only")).status).toBe("cancelled");
  });

  test("lets host admission remain queued for a six-hour operation deadline", async () => {
    let observedWaitTimeoutMilliseconds: number | undefined;
    const longRunningHostResources: HostResourceCoordinator = {
      profile: {
        capacities: [{ limit: 4, resource: "cpu" }],
        id: "scheduler-long-running-host-resources",
      },
      scope: "process",
      withLease: async (claims, callback, options) => {
        observedWaitTimeoutMilliseconds = options?.waitTimeoutMilliseconds;
        return await callback({
          assertOwned: () => Promise.resolve(),
          claims,
          inheritedFileDescriptor: 0,
          profile: longRunningHostResources.profile,
          ticket: "scheduler-long-running-ticket",
        });
      },
    };
    const registry = registryFixture((_context, input) => Promise.resolve({
      id: input.id,
      value: input.value,
    }), {
      maxDurationMs: 6 * 60 * 60 * 1_000,
    });
    const runId = "run_long_host_admission01";
    const run = await createRun(registry, [{ id: "long-render" }], runId);

    const result = await scheduler(run.store, registry, {
      hostResourceCoordinator: longRunningHostResources,
      hostLimits: {
        maxJobs: 1,
        maxWallClockMs: 6 * 60 * 60 * 1_000,
        resources: { cpu: 1 },
      },
    }).run(runId);

    expect(result.summary.status).toBe("completed");
    expect(HOST_RESOURCE_MAX_WAIT_MILLISECONDS).toBeGreaterThanOrEqual(
      6 * 60 * 60 * 1_000,
    );
    expect(observedWaitTimeoutMilliseconds).toBeGreaterThan(5 * 60_000);
    expect(observedWaitTimeoutMilliseconds).toBeLessThanOrEqual(
      6 * 60 * 60 * 1_000,
    );
  });

  test("claims the complete physical pools for every FFmpeg operation", async () => {
    let observedApplicationClaims: readonly HostResourceClaim[] | undefined;
    let observedClaims: readonly HostResourceClaim[] | undefined;
    const ffmpegHostResources: HostResourceCoordinator = {
      profile: {
        capacities: [
          { limit: 4, resource: "cpu" },
          { limit: 2, resource: "ffmpeg" },
          { limit: 1, resource: "video-encode" },
        ],
        id: "scheduler-ffmpeg-host-resources",
      },
      scope: "machine",
      withLease: async (claims, callback) => {
        observedClaims = claims;
        return await callback({
          assertOwned: () => Promise.resolve(),
          claims,
          inheritedFileDescriptor: 0,
          profile: ffmpegHostResources.profile,
          ticket: "scheduler-ffmpeg-ticket",
        });
      },
    };
    const registry = registryFixture((context, input) => {
      observedApplicationClaims = context.application.hostResourceLease?.claims;
      return Promise.resolve({
        id: input.id,
        value: input.value,
      });
    }, {
      resources: [
        { amount: 1, resource: "cpu" },
        { amount: 1, resource: "ffmpeg" },
      ],
    });
    const runId = "run_ffmpeg_host_claim01";
    const run = await createRun(registry, [{ id: "ffmpeg" }], runId);

    const result = await scheduler(run.store, registry, {
      hostResourceCoordinator: ffmpegHostResources,
    }).run(runId);

    expect(result.summary.status).toBe("completed");
    expect(observedClaims).toEqual([
      { amount: 4, resource: "cpu" },
      { amount: 2, resource: "ffmpeg" },
    ]);
    expect(observedApplicationClaims).toEqual(observedClaims);
  });

  test("executes fresh trusted compute and then admits its dependent operation", async () => {
    let dependentExecutions = 0;
    let computeExecutions = 0;
    let workflowContext: OperationExecutionContext["workflow"];
    const registry = registryFixture(async (context, input) => {
      dependentExecutions += 1;
      workflowContext = context.workflow;
      await context.workflow?.beforePublication();
      return {
        id: input.id,
        value: input.value + (input.dependencies ?? [])
          .reduce((sum, dependency) => sum + dependency.value, 0),
      };
    });
    const run = await createComputeRun(registry, "run_compute01");
    const inheritedHostResources: HostResourceCoordinator = {
      profile: {
        capacities: [],
        id: "scheduler-inherited-host-resources",
      },
      scope: "machine",
      withLease: async (claims, callback) => await callback({
        assertOwned: () => Promise.resolve(),
        claims,
        inheritedFileDescriptor: 42,
        profile: inheritedHostResources.profile,
        ticket: "scheduler-inherited-ticket",
      }),
    };
    const executor: SchedulerComputeExecutor = {
      bundleSha256: run.graphPlan.bundle.bundleSha256,
      execute: (request) => {
        computeExecutions += 1;
        expect(request).toMatchObject({
          computeKey: COMPUTE_KEY,
          inheritedHostResourceFileDescriptor: 42,
          input: { id: "compute", value: 2 },
          nodeKey: "compute",
          replayAcknowledged: false,
        });
        return Promise.resolve({ id: "compute", value: 3 });
      },
    };

    const result = await scheduler(run.store, registry, {
      compute: { executor, kind: "fresh" },
      hostResourceCoordinator: inheritedHostResources,
    }).run("run_compute01");

    expect(result.summary.status).toBe("completed");
    expect(computeExecutions).toBe(1);
    expect(dependentExecutions).toBe(1);
    const computeNode = await run.store.node("run_compute01", "compute");
    expect(computeNode.output?.value).toEqual({ id: "compute", value: 3 });
    expect(computeNode.executionPlan?.publicationKeys).toEqual([]);
    expect((await run.store.node("run_compute01", "dependent")).output?.value)
      .toEqual({ id: "dependent", value: 7 });
    const dependentNode = await run.store.node("run_compute01", "dependent");
    expect(workflowContext).toMatchObject({
      nodeKey: "dependent",
      nodePlanSha256: dependentNode.executionPlan?.nodePlanSha256,
      runId: "run_compute01",
    });
    expect(workflowContext?.workspaceDirectory).toContain(
      dependentNode.executionPlan?.nodePlanSha256,
    );
    expect((await run.store.grants("run_compute01")).filter(grant => (
      grant.kind === "compute-replay"
    ))).toEqual([]);
  });

  test("ordinary resume marks interrupted trusted compute ambiguous while dependents stay pending", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    let dependentExecutions = 0;
    const registry = registryFixture((_context, input) => {
      dependentExecutions += 1;
      return Promise.resolve({ id: input.id, value: input.value });
    });
    const run = await createComputeRun(registry, "run_compute02");
    const executor: SchedulerComputeExecutor = {
      bundleSha256: run.graphPlan.bundle.bundleSha256,
      execute: async () => {
        started.resolve();
        await release.promise;
        return { id: "compute", value: 3 };
      },
    };
    const firstRun = scheduler(run.store, registry, {
      compute: { executor, kind: "fresh" },
    }).run("run_compute02");
    await started.promise;
    expect((await run.store.node("run_compute02", "compute")).status).toBe("running");
    const takeover = await run.store.acquireClaim("run_compute02", {
      now: () => new Date(Date.now() + 60_000),
      owner: "compute-takeover",
      processAlive: () => false,
      staleAfterMs: 0,
    });
    release.resolve();
    let staleError: unknown;
    try {
      await firstRun;
    } catch (error) {
      staleError = error;
    }
    expect(staleError).toBeInstanceOf(ApplicationError);
    expect(staleError).toHaveProperty("message", expect.stringContaining("stale"));
    await run.store.releaseClaim(takeover);

    const resumed = await scheduler(run.store, registry).run("run_compute02");

    expect(resumed.summary.status).toBe("ambiguous-code");
    const ambiguous = await run.store.node("run_compute02", "compute");
    expect(ambiguous).toMatchObject({
      attempt: 1,
      failure: {
        code: "ambiguous",
      },
      status: "ambiguous-code",
    });
    expect(ambiguous.failure?.message).toContain("explicit exact-bundle replay");
    expect((await run.store.node("run_compute02", "dependent")).status).toBe("pending");
    expect(dependentExecutions).toBe(0);
  });

  test("explicit replay appends an exact grant before lazy loading and completes dependents", async () => {
    let dependentExecutions = 0;
    let loaderCalls = 0;
    let replayExecutions = 0;
    const registry = registryFixture((_context, input) => {
      dependentExecutions += 1;
      return Promise.resolve({
        id: input.id,
        value: input.value + (input.dependencies ?? [])
          .reduce((sum, dependency) => sum + dependency.value, 0),
      });
    });
    const run = await createComputeRun(registry, "run_compute03");
    const paused = await scheduler(run.store, registry).run("run_compute03");
    expect(paused.summary.status).toBe("ambiguous-code");
    const ambiguous = await run.store.node("run_compute03", "compute");
    expect(ambiguous.executionPlan).toBeDefined();

    const replayExecutor: SchedulerComputeExecutor = {
      bundleSha256: run.graphPlan.bundle.bundleSha256,
      execute: (request) => {
        replayExecutions += 1;
        expect(request).toMatchObject({
          computeKey: COMPUTE_KEY,
          input: { id: "compute", value: 2 },
          nodeKey: "compute",
          replayAcknowledged: true,
        });
        return Promise.resolve({ id: "compute", value: 3 });
      },
    };
    const resumed = await scheduler(run.store, registry, {
      compute: {
        kind: "replay",
        load: async () => {
          loaderCalls += 1;
          const grants = (await run.store.grants("run_compute03")).filter(grant => (
            grant.kind === "compute-replay"
          ));
          expect(grants).toHaveLength(1);
          expect(grants[0]).toMatchObject({
            attempt: ambiguous.attempt + 1,
            bundleSha256: run.graphPlan.bundle.bundleSha256,
            computeKey: COMPUTE_KEY,
            graphPlanSha256: run.graphPlan.graphPlanSha256,
            kind: "compute-replay",
            nodeKey: "compute",
            nodePlanSha256: ambiguous.executionPlan?.nodePlanSha256,
          });
          return computeExecutorLease(replayExecutor);
        },
        nodeKeys: ["compute"],
      },
    }).run("run_compute03");

    expect(resumed.summary.status).toBe("completed");
    expect(loaderCalls).toBe(1);
    expect(replayExecutions).toBe(1);
    expect(dependentExecutions).toBe(1);
    expect((await run.store.node("run_compute03", "compute")).attempt).toBe(2);
    expect((await run.store.node("run_compute03", "dependent")).output?.value)
      .toEqual({ id: "dependent", value: 7 });
  });

  test("durable cancellation bounds replay loading and releases the run fence", async () => {
    const registry = registryFixture((_context, input) => Promise.resolve({
      id: input.id,
      value: input.value,
    }));
    const runId = "run_replay_load_cancellation";
    const run = await createComputeRun(registry, runId);
    expect((await scheduler(run.store, registry).run(runId)).summary.status)
      .toBe("ambiguous-code");

    const loadStarted = deferred<void>();
    let observedSignal: AbortSignal | undefined;
    let observedWaitTimeoutMilliseconds: number | undefined;
    const maxWallClockMs = 30_000;
    const resumedPromise = scheduler(run.store, registry, {
      compute: {
        kind: "replay",
        load: async ({ signal, waitTimeoutMilliseconds }) => {
          observedSignal = signal;
          observedWaitTimeoutMilliseconds = waitTimeoutMilliseconds;
          loadStarted.resolve();
          return await new Promise<SchedulerComputeExecutorLease>((_resolve, reject) => {
            const rejectCancelled = () => reject(
              signal.reason instanceof Error
                ? signal.reason
                : new ApplicationError("cancelled", "Replay load cancelled."),
            );
            signal.addEventListener("abort", rejectCancelled, { once: true });
            if (signal.aborted) rejectCancelled();
          });
        },
        nodeKeys: ["compute"],
      },
      hostLimits: {
        maxJobs: 1,
        maxWallClockMs,
        resources: { cpu: 1 },
      },
    }).run(runId);
    await Promise.race([
      loadStarted.promise,
      resumedPromise.then((result) => {
        throw new Error(
          `Scheduler settled ${result.summary.status} before replay loading started.`,
        );
      }),
    ]);
    await run.store.requestCancellation(runId, "test");
    const resumed = await settleWithin(resumedPromise);

    expect(resumed.summary.status).toBe("cancelled");
    expect(observedSignal?.aborted).toBe(true);
    expect(observedWaitTimeoutMilliseconds).toBeGreaterThan(0);
    expect(observedWaitTimeoutMilliseconds).toBeLessThanOrEqual(maxWallClockMs);
    const nextFence = await run.store.acquireClaim(runId, {
      owner: "after-replay-load-cancellation",
    });
    await run.store.releaseClaim(nextFence);
  }, 12_000);

  test("releases a late replay executor after durable cancellation returned", async () => {
    const registry = registryFixture((_context, input) => Promise.resolve({
      id: input.id,
      value: input.value,
    }));
    const runId = "run_replay_load_late_cancellation";
    const run = await createComputeRun(registry, runId);
    expect((await scheduler(run.store, registry).run(runId)).summary.status)
      .toBe("ambiguous-code");

    const loadStarted = deferred<void>();
    const releaseLoad = deferred<void>();
    const executorReleased = deferred<void>();
    const executor: SchedulerComputeExecutor = {
      bundleSha256: run.graphPlan.bundle.bundleSha256,
      execute: () => Promise.reject(new Error("Late replay executor must not run.")),
    };
    const resumedPromise = scheduler(run.store, registry, {
      compute: {
        kind: "replay",
        load: async () => {
          loadStarted.resolve();
          await releaseLoad.promise;
          return computeExecutorLease(executor, () => executorReleased.resolve());
        },
        nodeKeys: ["compute"],
      },
      hostLimits: {
        maxJobs: 1,
        maxWallClockMs: 30_000,
        resources: { cpu: 1 },
      },
    }).run(runId);
    await Promise.race([
      loadStarted.promise,
      resumedPromise.then((result) => {
        throw new Error(
          `Scheduler settled ${result.summary.status} before late replay loading started.`,
        );
      }),
    ]);
    await run.store.requestCancellation(runId, "test");
    const resumed = await settleWithin(resumedPromise);
    expect(resumed.summary.status).toBe("cancelled");
    const nextFence = await run.store.acquireClaim(runId, {
      owner: "after-late-replay-load-cancellation",
    });
    await run.store.releaseClaim(nextFence);

    releaseLoad.resolve();
    await settleWithin(executorReleased.promise);
  }, 12_000);

  test("an interrupted replay requires a new attempt-bound replay grant", async () => {
    let dependentExecutions = 0;
    const registry = registryFixture((_context, input) => {
      dependentExecutions += 1;
      return Promise.resolve({
        id: input.id,
        value: input.value + (input.dependencies ?? [])
          .reduce((sum, dependency) => sum + dependency.value, 0),
      });
    });
    const run = await createComputeRun(registry, "run_compute04");
    expect((await scheduler(run.store, registry).run("run_compute04")).summary.status)
      .toBe("ambiguous-code");

    const interruptedExecutor: SchedulerComputeExecutor = {
      bundleSha256: run.graphPlan.bundle.bundleSha256,
      execute: (request) => {
        expect(request.replayAcknowledged).toBe(true);
        return Promise.reject(new ApplicationError("unavailable", "worker disconnected"));
      },
    };
    const interrupted = await scheduler(run.store, registry, {
      compute: {
        kind: "replay",
        load: () => Promise.resolve(computeExecutorLease(interruptedExecutor)),
        nodeKeys: ["compute"],
      },
    }).run("run_compute04");

    expect(interrupted.summary.status).toBe("ambiguous-code");
    const interruptedNode = await run.store.node("run_compute04", "compute");
    expect(interruptedNode).toMatchObject({
      attempt: 2,
      failure: {
        code: "ambiguous",
      },
      status: "ambiguous-code",
    });
    expect(interruptedNode.failure?.message).toContain("worker disconnected");
    expect((await run.store.grants("run_compute04")).filter(grant => (
      grant.kind === "compute-replay"
    )).map(grant => grant.attempt)).toEqual([2]);

    const successfulExecutor: SchedulerComputeExecutor = {
      bundleSha256: run.graphPlan.bundle.bundleSha256,
      execute: (request) => {
        expect(request.replayAcknowledged).toBe(true);
        return Promise.resolve({ id: "compute", value: 3 });
      },
    };
    const completed = await scheduler(run.store, registry, {
      compute: {
        kind: "replay",
        load: () => Promise.resolve(computeExecutorLease(successfulExecutor)),
        nodeKeys: ["compute"],
      },
    }).run("run_compute04");

    expect(completed.summary.status).toBe("completed");
    expect((await run.store.node("run_compute04", "compute")).attempt).toBe(3);
    expect((await run.store.grants("run_compute04")).filter(grant => (
      grant.kind === "compute-replay"
    )).map(grant => grant.attempt)).toEqual([2, 3]);
    expect(dependentExecutions).toBe(1);
  }, 15_000);

  test("a replay executor runs only explicitly acknowledged compute node keys", async () => {
    const executions: string[] = [];
    const registry = registryFixture((_context, input) => Promise.resolve({
      id: input.id,
      value: input.value + (input.dependencies ?? [])
        .reduce((sum, dependency) => sum + dependency.value, 0),
    }));
    const run = await createComputeRun(
      registry,
      "run_compute05",
      ["first", "second"],
    );
    const initial = await scheduler(run.store, registry).run("run_compute05");
    expect(initial.summary.status).toBe("ambiguous-code");
    expect((await run.store.node("run_compute05", "first")).status)
      .toBe("ambiguous-code");
    expect((await run.store.node("run_compute05", "second")).status)
      .toBe("ambiguous-code");

    const executor: SchedulerComputeExecutor = {
      bundleSha256: run.graphPlan.bundle.bundleSha256,
      execute: request => {
        executions.push(request.nodeKey);
        const input = InputSchema.parse(request.input);
        return Promise.resolve({ id: input.id, value: input.value + 1 });
      },
    };
    const replayed = await scheduler(run.store, registry, {
      compute: {
        kind: "replay",
        load: () => Promise.resolve(computeExecutorLease(executor)),
        nodeKeys: ["first"],
      },
    }).run("run_compute05");

    expect(replayed.summary.status).toBe("ambiguous-code");
    expect(executions).toEqual(["first"]);
    expect((await run.store.node("run_compute05", "first")).status).toBe("completed");
    expect((await run.store.node("run_compute05", "second")).status)
      .toBe("ambiguous-code");
    expect((await run.store.grants("run_compute05")).filter(grant => (
      grant.kind === "compute-replay"
    )).map(grant => grant.nodeKey)).toEqual(["first"]);
  }, 15_000);

  test("overlaps independent nodes and starts a join only after both outputs verify", async () => {
    const releases = new Map([
      ["a", deferred<void>()],
      ["b", deferred<void>()],
    ]);
    const rootsStarted = deferred<void>();
    const joinStarted = deferred<void>();
    const starts: string[] = [];
    const registry = registryFixture(async (_context, input) => {
      starts.push(input.id);
      if (starts.filter(id => id === "a" || id === "b").length === 2) {
        rootsStarted.resolve();
      }
      if (input.id === "join") joinStarted.resolve();
      await releases.get(input.id)?.promise;
      return {
        id: input.id,
        value: input.value + (input.dependencies ?? [])
          .reduce((sum, dependency) => sum + dependency.value, 0),
      };
    });
    const run = await createRun(registry, [
      { id: "a", value: 1 },
      { id: "b", value: 2 },
      { dependencies: ["a", "b"], id: "join", value: 3 },
    ], "run_overlap01");

    const resultPromise = scheduler(run.store, registry).run("run_overlap01");
    await rootsStarted.promise;
    expect(starts).toHaveLength(2);
    expect([...starts].sort()).toEqual(["a", "b"]);
    expect(starts).not.toContain("join");
    releases.get("a")?.resolve();
    releases.get("b")?.resolve();
    await joinStarted.promise;
    const result = await resultPromise;

    expect(result.summary.status).toBe("completed");
    expect(starts).toHaveLength(3);
    expect([...starts.slice(0, 2)].sort()).toEqual(["a", "b"]);
    expect(starts[2]).toBe("join");
    expect((await run.store.node("run_overlap01", "join")).output?.value)
      .toEqual({ id: "join", value: 6 });
  });

  test("resolves typed output projections while binding the full producer digest", async () => {
    const registry = registryFixture((_context, input) => Promise.resolve({
      id: input.id,
      value: input.value + (input.selected ?? 0),
    }));
    const run = await createRun(registry, [
      { id: "source", value: 7 },
      { id: "projected", selectedDependency: "source", value: 2 },
    ], "run_project01");

    const result = await scheduler(run.store, registry).run("run_project01");

    expect(result.summary.status).toBe("completed");
    expect((await run.store.node("run_project01", "projected")).output?.value)
      .toEqual({ id: "projected", value: 9 });
    const sourceDigest = (await run.store.node("run_project01", "source")).output?.digestSha256;
    expect((await run.store.node("run_project01", "projected"))
      .executionPlan?.dependencyOutputDigests.source).toBe(sourceDigest);
  });

  test("projects typed references in terminal summaries and durable outputs", async () => {
    const registry = registryFixture((_context, input) => Promise.resolve({
      id: input.id,
      value: input.value,
    }));
    const run = await createRun(
      registry,
      [{ id: "source", value: 7 }],
      "run_project02",
      { projectFinalOutputs: true },
    );

    const result = await scheduler(run.store, registry).run("run_project02");

    expect(result.summary.outputs).toEqual({ source: 7 });
    expect((await run.store.outputs("run_project02"))?.outputs).toEqual({
      source: 7,
    });
  });

  test("admits resource vectors atomically and requested jobs only reduce host concurrency", async () => {
    const releases = new Map([
      ["a", deferred<void>()],
      ["b", deferred<void>()],
      ["c", deferred<void>()],
    ]);
    const started = new Map([
      ["a", deferred<void>()],
      ["b", deferred<void>()],
      ["c", deferred<void>()],
    ]);
    let active = 0;
    let maximumActive = 0;
    const registry = registryFixture(async (_context, input) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      started.get(input.id)?.resolve();
      await releases.get(input.id)?.promise;
      active -= 1;
      return { id: input.id, value: input.value };
    }, {
      resources: [
        { amount: 1, resource: "cpu" },
        { amount: 1, resource: "vision" },
      ],
    });
    const run = await createRun(registry, [
      { id: "a" },
      { id: "b" },
      { id: "c" },
    ], "run_resource01");
    const resultPromise = scheduler(run.store, registry, {
      hostLimits: {
        maxJobs: 3,
        resources: { cpu: 3, vision: 1 },
      },
      jobs: 99,
    }).run("run_resource01");

    await started.get("a")?.promise;
    expect(maximumActive).toBe(1);
    expect((await run.store.node("run_resource01", "b")).status).toBe("ready");
    releases.get("a")?.resolve();
    await started.get("b")?.promise;
    expect(maximumActive).toBe(1);
    releases.get("b")?.resolve();
    await started.get("c")?.promise;
    releases.get("c")?.resolve();

    expect((await resultPromise).summary.status).toBe("completed");
    expect(maximumActive).toBe(1);
  });

  test("serializes project renders independently of low, default, or high host ceilings", async () => {
    const ceilings = [
      { cpu: 1, ffmpeg: 1, label: "low" },
      { cpu: 4, ffmpeg: 2, label: "default" },
      { cpu: 8, ffmpeg: 4, label: "high" },
    ] as const;
    for (const ceiling of ceilings) {
      const releases = new Map([
        ["a", deferred<void>()],
        ["b", deferred<void>()],
      ]);
      const started = new Map([
        ["a", deferred<void>()],
        ["b", deferred<void>()],
      ]);
      let active = 0;
      let maximumActive = 0;
      const registry = registryFixture(async (_context, input) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        started.get(input.id)!.resolve();
        await releases.get(input.id)!.promise;
        active -= 1;
        return { id: input.id, value: input.value };
      }, {
        resources: [
          { amount: 1, resource: "cpu" },
          { amount: 1, resource: "ffmpeg" },
          { amount: 1, resource: "project-render" },
        ],
      });
      const runId = `run_render_slot_${ceiling.label}`;
      const run = await createRun(registry, [{ id: "a" }, { id: "b" }], runId);
      const resultPromise = scheduler(run.store, registry, {
        hostLimits: {
          maxJobs: 2,
          resources: {
            cpu: ceiling.cpu,
            ffmpeg: ceiling.ffmpeg,
          },
        },
      }).run(runId);

      await started.get("a")!.promise;
      expect((await run.store.node(runId, "b")).status).toBe("ready");
      releases.get("a")!.resolve();
      await started.get("b")!.promise;
      releases.get("b")!.resolve();

      expect((await resultPromise).summary.status).toBe("completed");
      expect(maximumActive).toBe(1);
    }
  });

  test("holds exclusive publication keys across otherwise independent work", async () => {
    const releases = new Map([
      ["a", deferred<void>()],
      ["b", deferred<void>()],
    ]);
    const started = new Map([
      ["a", deferred<void>()],
      ["b", deferred<void>()],
    ]);
    let active = 0;
    let maximumActive = 0;
    const registry = registryFixture(async (_context, input) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      started.get(input.id)?.resolve();
      await releases.get(input.id)?.promise;
      active -= 1;
      return { id: input.id, value: input.value };
    });
    const run = await createRun(registry, [{ id: "a" }, { id: "b" }], "run_publish01");
    const exclusivePlanner: SchedulerNodePlanner = {
      ...passThroughPlanner,
      plan: request => Promise.resolve({
        exactInput: request.resolvedInput,
        publicationKeys: ["output:/shared/demo.mp4"],
      }),
    };
    const resultPromise = scheduler(run.store, registry, {
      nodePlanner: exclusivePlanner,
    }).run("run_publish01");

    await started.get("a")?.promise;
    expect((await run.store.node("run_publish01", "b")).status).toBe("ready");
    releases.get("a")?.resolve();
    await started.get("b")?.promise;
    releases.get("b")?.resolve();

    expect((await resultPromise).summary.status).toBe("completed");
    expect(maximumActive).toBe(1);
  });

  test("marks a claim larger than a host ceiling incompatible without partial admission", async () => {
    let executions = 0;
    const registry = registryFixture((_context, input) => {
      executions += 1;
      return Promise.resolve({ id: input.id, value: input.value });
    }, {
      resources: [
        { amount: 2, resource: "cpu" },
        { amount: 1, resource: "local-io" },
      ],
    });
    const run = await createRun(registry, [{ id: "oversized" }], "run_ceiling01");

    const result = await scheduler(run.store, registry, {
      hostLimits: {
        maxJobs: 2,
        resources: { cpu: 1, "local-io": 4 },
      },
    }).run("run_ceiling01");

    expect(result.summary.status).toBe("incompatible");
    expect((await run.store.node("run_ceiling01", "oversized")).status).toBe("incompatible");
    expect(executions).toBe(0);
  });

  test("durably marks an incompatible executor set before performing any effect", async () => {
    let executions = 0;
    const planningRegistry = registryFixture((_context, input) => {
      executions += 1;
      return Promise.resolve({ id: input.id, value: input.value });
    });
    const run = await createRun(planningRegistry, [
      { id: "root" },
      { dependencies: ["root"], id: "dependent" },
    ], "run_compat001");

    const result = await scheduler(run.store, new OperationRegistry()).run("run_compat001");

    expect(result.summary.status).toBe("incompatible");
    expect((await run.store.node("run_compat001", "root")).status).toBe("incompatible");
    expect((await run.store.node("run_compat001", "dependent")).status).toBe("skipped");
    expect(executions).toBe(0);
  });

  test("propagates a failed dependency chain without one complete scan per node", async () => {
    const nodeCount = 32;
    const registry = registryFixture((_context, input) => {
      if (input.fail) throw new Error("deterministic root failure");
      return Promise.resolve({ id: input.id, value: input.value });
    });
    let store: CountingNodeReadRunStore | undefined;
    const nodes = Array.from({ length: nodeCount }, (_, index): GraphNodeFixture => {
      const id = `chain-${String(index).padStart(3, "0")}`;
      return {
        ...(index === 0
          ? { fail: true }
          : { dependencies: [`chain-${String(index - 1).padStart(3, "0")}`] }),
        id,
      };
    });
    const run = await createRun(registry, nodes, "run_failed_chain01", {
      storeFactory: root => {
        store = new CountingNodeReadRunStore({ root });
        return store;
      },
    });

    const result = await scheduler(run.store, registry, {
      hostLimits: { maxJobs: 1, resources: { cpu: 1 } },
    }).run("run_failed_chain01");

    expect(result.summary.status).toBe("failed");
    expect((await run.store.node("run_failed_chain01", "chain-031")).status).toBe("skipped");
    if (store === undefined) throw new Error("Expected the counting run store.");
    expect(store.nodeListReads).toBeLessThan(nodeCount / 2);
  });

  test("rejects a plan bound to a different application build before any effect", async () => {
    let executions = 0;
    const registry = registryFixture((_context, input) => {
      executions += 1;
      return Promise.resolve({ id: input.id, value: input.value });
    });
    const run = await createRun(registry, [{ id: "root" }], "run_build_mismatch");

    const result = await scheduler(run.store, registry, {
      currentApplicationBuild: "different-application-build",
    }).run("run_build_mismatch");

    expect(result.summary.status).toBe("incompatible");
    expect((await run.store.node("run_build_mismatch", "root")).status)
      .toBe("incompatible");
    expect(executions).toBe(0);
  });

  test("rejects exact input that exceeds its prepared upper byte bound before any effect", async () => {
    let executions = 0;
    const registry = registryFixture((_context, input) => {
      executions += 1;
      return Promise.resolve({ id: input.id, value: input.value });
    });
    const runId = "run_exact_input_bound";
    const run = await createRun(registry, [{ id: "bounded-input" }], runId);
    const underBoundPlanner: SchedulerNodePlanner = {
      prepare: request => Promise.resolve({
        inputDescriptors: request.resolvedInput,
        upperInputBytes: 8,
      }),
      plan: () => Promise.resolve({
        exactInput: {
          id: "x".repeat(256),
          value: 1,
        },
        publicationKeys: [],
      }),
    };

    try {
      await scheduler(run.store, registry, {
        nodePlanner: underBoundPlanner,
      }).run(runId);
      throw new Error("Expected exact-input bound rejection.");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid-data" });
      if (!(error instanceof Error)) {
        throw new TypeError("Expected an exact-input bound error.");
      }
      expect(error.message).toContain(
        "Exact input for node bounded-input",
      );
    }
    const record = await run.store.node(runId, "bounded-input");
    expect(record).toMatchObject({
      failure: {
        code: "invalid-data",
      },
      status: "failed",
    });
    expect(record.executionPlan).toBeUndefined();
    expect(executions).toBe(0);
  });

  test("resumes a legacy markless plan whose host-bound exact input exceeds its authored byte estimate", async () => {
    let executions = 0;
    const registry = registryFixture((_context, input) => {
      executions += 1;
      return Promise.resolve({ id: input.id, value: input.value });
    });
    const runId = "run_legacy_input_bound";
    const run = await createRun(registry, [{ id: "legacy-input" }], runId);
    const node = run.graphPlan.graph.nodes[0]!;
    if (node.executor.kind !== "operation") {
      throw new TypeError("Expected an operation fixture.");
    }
    const operation = registry.get(
      node.executor.operation.kind,
      node.executor.operation.version,
    ).discovery;
    const preparationUnsigned: Omit<
      NodePreparationPlan,
      "preparationPlanSha256"
    > = {
      executor: node.executor,
      graphPlanSha256: run.graphPlan.graphPlanSha256,
      inputDescriptors: { bytes: 8 },
      nodeKey: node.key,
      requestedPreparation: [...operation.policy.preparation],
      upperDurationMs: operation.policy.maxDurationMs,
      upperInputBytes: 8,
      version: NODE_PREPARATION_PLAN_VERSION,
    };
    const preparation: NodePreparationPlan = {
      ...preparationUnsigned,
      preparationPlanSha256: createNodePreparationPlanHash(
        preparationUnsigned,
      ),
    };
    const exactInput = {
      id: "legacy-input",
      selected: 42,
      value: 1,
    };
    expect(new TextEncoder().encode(canonicalJson(exactInput)).byteLength)
      .toBeGreaterThan(preparation.upperInputBytes);
    const executionUnsigned: Omit<
      NodeExecutionPlan,
      "nodePlanSha256"
    > = {
      dependencyOutputDigests: {},
      exactInput,
      executor: node.executor,
      graphPlanSha256: run.graphPlan.graphPlanSha256,
      inputSha256: createNodeInputHash(exactInput),
      nodeKey: node.key,
      policy: {
        ...operation.policy,
        preparation: [...operation.policy.preparation],
        resources: [...operation.policy.resources],
      },
      preparationPlanSha256: preparation.preparationPlanSha256,
      publicationKeys: [],
      version: NODE_EXECUTION_PLAN_VERSION,
    };
    const execution: NodeExecutionPlan = {
      ...executionUnsigned,
      nodePlanSha256: createNodeExecutionPlanHash(executionUnsigned),
    };
    const fence = await run.store.acquireClaim(runId, {
      owner: "legacy-input-bound-fixture",
    });
    try {
      const initial = await run.store.node(runId, node.key);
      const preparing: RunNodeRecord = {
        ...initial,
        status: "preparing",
      };
      await run.store.writeNode(fence, preparing);
      await run.store.writeNode(fence, {
        ...preparing,
        executionPlan: execution,
        preparationPlan: preparation,
        status: "ready",
      });
    } finally {
      await run.store.releaseClaim(fence);
    }

    const result = await scheduler(run.store, registry).run(runId);

    expect(result.summary.status).toBe("completed");
    expect(executions).toBe(1);
    expect((await run.store.node(runId, node.key)).output?.value).toEqual({
      id: "legacy-input",
      value: 1,
    });
  });

  test("skips only failed dependents while completing independent branches", async () => {
    const starts: string[] = [];
    const registry = registryFixture((_context, input) => {
      starts.push(input.id);
      if (input.fail === true) {
        return Promise.reject(new ApplicationError("invalid-data", `failed ${input.id}`));
      }
      return Promise.resolve({
        id: input.id,
        value: input.value + (input.dependencies ?? [])
          .reduce((sum, dependency) => sum + dependency.value, 0),
      });
    });
    const run = await createRun(registry, [
      { fail: true, id: "failed" },
      { id: "independent", value: 2 },
      { dependencies: ["failed"], id: "blocked" },
      { dependencies: ["independent"], id: "continued" },
    ], "run_isolate01");

    const result = await scheduler(run.store, registry).run("run_isolate01");

    expect(result.summary.status).toBe("partial");
    expect(result.summary.counts).toEqual({
      cancelled: 0,
      completed: 2,
      failed: 1,
      pending: 0,
      skipped: 1,
    });
    expect(starts.sort()).toEqual(["continued", "failed", "independent"]);
    expect((await run.store.node("run_isolate01", "blocked")).status).toBe("skipped");
  });

  test("persists exact preparation and effect approvals and resumes only after matching grants", async () => {
    let executions = 0;
    const registry = registryFixture((_context, input) => {
      executions += 1;
      return Promise.resolve({ id: input.id, value: input.value });
    }, {
      preparation: ["local-media"],
    });
    const run = await createRun(registry, [{ id: "approval" }], "run_approve01");
    const denyBoth: SchedulerAuthorization = {
      authorizeEffect: () => Promise.resolve(false),
      authorizePreparation: () => Promise.resolve(false),
      grantedBy: "approval-test",
    };

    const paused = await scheduler(run.store, registry, {
      authorization: denyBoth,
    }).run("run_approve01");

    expect(paused.summary.status).toBe("approval-required");
    expect(paused.pause).toMatchObject({
      nodeKey: "approval",
      phase: "preparation",
    });
    expect(executions).toBe(0);
    const approvalFence = await run.store.acquireClaim("run_approve01", {
      owner: "approver",
    });
    await run.store.appendGrant(approvalFence, {
      createdAt: new Date().toISOString(),
      graphPlanSha256: run.graphPlan.graphPlanSha256,
      grantedBy: "approver",
      grantId: randomUUID(),
      kind: "preparation",
      nodeKey: "approval",
      preparationPlanSha256: paused.pause?.planSha256 ?? "",
    });
    await run.store.releaseClaim(approvalFence);

    const effectPaused = await scheduler(run.store, registry, {
      authorization: denyBoth,
    }).run("run_approve01");

    expect(effectPaused.summary.status).toBe("approval-required");
    expect(effectPaused.pause).toMatchObject({
      nodeKey: "approval",
      phase: "effect",
    });
    expect(executions).toBe(0);
    const effectFence = await run.store.acquireClaim("run_approve01", {
      owner: "effect-approver",
    });
    await run.store.appendGrant(effectFence, {
      createdAt: new Date().toISOString(),
      graphPlanSha256: run.graphPlan.graphPlanSha256,
      grantedBy: "effect-approver",
      grantId: randomUUID(),
      kind: "effect",
      nodeKey: "approval",
      nodePlanSha256: effectPaused.pause?.planSha256 ?? "",
    });
    await run.store.releaseClaim(effectFence);

    const resumed = await scheduler(run.store, registry, {
      authorization: denyBoth,
    }).run("run_approve01");
    expect(resumed.summary.status).toBe("completed");
    expect(executions).toBe(1);
  });

  test("honors a durable cancellation marker, aborts cancellable work, and starts no queued node", async () => {
    const started = deferred<void>();
    const starts: string[] = [];
    const registry = registryFixture((context, input) => {
      starts.push(input.id);
      started.resolve();
      return new Promise<FixtureOutput>((_resolve, reject) => {
        context.abortSignal.addEventListener("abort", () => {
          reject(new ApplicationError("cancelled", "test cancellation"));
        }, { once: true });
      });
    });
    const run = await createRun(registry, [
      { id: "a" },
      { id: "b" },
    ], "run_cancel01");
    const resultPromise = scheduler(run.store, registry, {
      hostLimits: {
        maxJobs: 1,
        resources: { cpu: 1 },
      },
    }).run("run_cancel01");
    await started.promise;
    await run.store.requestCancellation("run_cancel01", "test");

    const result = await resultPromise;

    expect(result.summary.status).toBe("cancelled");
    expect(result.summary.counts.cancelled).toBe(2);
    expect(starts).toEqual(["a"]);
  });

  test("durable cancellation removes a non-cancellable node's queued host-admission ticket", async () => {
    const underlying = createProcessLocalHostResourceCoordinator({
      profile: {
        capacities: [{ limit: 1, resource: "cpu" }],
        id: "scheduler-cancel-noncancellable-admission",
      },
    });
    const externalEntered = deferred<void>();
    const releaseExternal = deferred<void>();
    const admissionRequested = deferred<void>();
    const external = underlying.withLease(
      [{ amount: 1, resource: "cpu" }],
      async () => {
        externalEntered.resolve();
        await releaseExternal.promise;
      },
    );
    await externalEntered.promise;
    const observedCoordinator: HostResourceCoordinator = {
      profile: underlying.profile,
      scope: underlying.scope,
      withLease: (claims, callback, options) => {
        const waiting = underlying.withLease(claims, callback, options);
        admissionRequested.resolve();
        return waiting;
      },
    };
    let executions = 0;
    const registry = registryFixture((_context, input) => {
      executions += 1;
      return Promise.resolve({ id: input.id, value: input.value });
    }, { cancellable: false });
    const runId = "run_cancel_waiting_noncancellable";
    const run = await createRun(registry, [{ id: "queued" }], runId);
    const resultPromise = scheduler(run.store, registry, {
      hostLimits: { maxJobs: 1, resources: { cpu: 1 } },
      hostResourceCoordinator: observedCoordinator,
    }).run(runId);
    try {
      await admissionRequested.promise;
      await run.store.requestCancellation(runId, "test");
      const result = await settleWithin(resultPromise);
      expect(result.summary.status).toBe("cancelled");
      expect(executions).toBe(0);
      expect((await run.store.node(runId, "queued")).status).toBe("cancelled");
    } finally {
      releaseExternal.resolve();
      await external;
    }
  });

  test("durable cancellation does not make compute ambiguous before host admission", async () => {
    const underlying = createProcessLocalHostResourceCoordinator({
      profile: {
        capacities: [{ limit: 1, resource: "cpu" }],
        id: "scheduler-cancel-compute-admission",
      },
    });
    const externalEntered = deferred<void>();
    const releaseExternal = deferred<void>();
    const admissionRequested = deferred<void>();
    const external = underlying.withLease(
      [{ amount: 1, resource: "cpu" }],
      async () => {
        externalEntered.resolve();
        await releaseExternal.promise;
      },
    );
    await externalEntered.promise;
    const observedCoordinator: HostResourceCoordinator = {
      profile: underlying.profile,
      scope: underlying.scope,
      withLease: (claims, callback, options) => {
        const waiting = underlying.withLease(claims, callback, options);
        admissionRequested.resolve();
        return waiting;
      },
    };
    const registry = registryFixture((_context, input) => Promise.resolve({
      id: input.id,
      value: input.value,
    }));
    const runId = "run_cancel_waiting_compute";
    const run = await createComputeRun(registry, runId);
    let executions = 0;
    const executor: SchedulerComputeExecutor = {
      bundleSha256: run.graphPlan.bundle.bundleSha256,
      execute: () => {
        executions += 1;
        return Promise.resolve({ id: "compute", value: 3 });
      },
    };
    const resultPromise = scheduler(run.store, registry, {
      compute: { executor, kind: "fresh" },
      hostLimits: { maxJobs: 1, resources: { cpu: 1 } },
      hostResourceCoordinator: observedCoordinator,
    }).run(runId);
    try {
      await admissionRequested.promise;
      await run.store.requestCancellation(runId, "test");
      const result = await settleWithin(resultPromise);
      expect(result.summary.status).toBe("cancelled");
      expect(executions).toBe(0);
      expect(await run.store.node(runId, "compute")).toMatchObject({
        failure: { code: "cancelled" },
        status: "cancelled",
      });
    } finally {
      releaseExternal.resolve();
      await external;
    }
  });

  test("durable cancellation lets admitted non-cancellable work complete", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    let executionSignal: AbortSignal | undefined;
    const registry = registryFixture(async (context, input) => {
      executionSignal = context.abortSignal;
      started.resolve();
      await release.promise;
      return { id: input.id, value: input.value };
    }, { cancellable: false });
    const runId = "run_cancel_admitted_noncancellable";
    const run = await createRun(registry, [{ id: "admitted" }], runId);
    const resultPromise = scheduler(run.store, registry, {
      hostLimits: { maxJobs: 1, resources: { cpu: 1 } },
    }).run(runId);
    await started.promise;
    await run.store.requestCancellation(runId, "test");
    await Bun.sleep(25);
    expect(executionSignal?.aborted).toBe(false);
    release.resolve();
    const result = await settleWithin(resultPromise);
    expect(result.summary.status).toBe("completed");
    expect((await run.store.node(runId, "admitted")).status).toBe("completed");
    expect((await run.store.summary(runId)).status).toBe("completed");
  });

  test("the workflow deadline releases claims held by never-settling lifecycle ports", async () => {
    for (const phase of [
      "prepare",
      "plan",
      "authorize-preparation",
      "authorize-effect",
    ] as const) {
      let invocations = 0;
      function neverSettles<Value>(): Promise<Value> {
        invocations += 1;
        return new Promise<Value>(() => undefined);
      }
      const registry = registryFixture((_context, input) => Promise.resolve({
        id: input.id,
        value: input.value,
      }), phase === "authorize-preparation"
        ? { preparation: ["local-media"] }
        : {});
      const runId = `run_port_${phase.replaceAll("-", "_")}`;
      const run = await createRun(registry, [{ id: "port" }], runId);
      const planner: SchedulerNodePlanner = {
        plan: request => phase === "plan"
          ? neverSettles()
          : passThroughPlanner.plan(request),
        prepare: request => phase === "prepare"
          ? neverSettles()
          : passThroughPlanner.prepare(request),
      };
      const authorization: SchedulerAuthorization = {
        authorizeEffect: request => phase === "authorize-effect"
          ? neverSettles()
          : allowAll.authorizeEffect(request),
        authorizePreparation: request => phase === "authorize-preparation"
          ? neverSettles()
          : allowAll.authorizePreparation(request),
        grantedBy: "never-settling-port-test",
      };

      const result = await settleWithin(scheduler(run.store, registry, {
        authorization,
        hostLimits: {
          maxJobs: 1,
          maxWallClockMs: 1_000,
          resources: { cpu: 1 },
        },
        nodePlanner: planner,
      }).run(runId), 3_500);

      expect(invocations).toBe(1);
      expect(result.summary.status).toBe("cancelled");
      expect((await run.store.node(runId, "port")).status).toBe("cancelled");
      const nextFence = await run.store.acquireClaim(runId, {
        owner: `after-${phase}`,
      });
      await run.store.releaseClaim(nextFence);
    }
  }, 20_000);

  test("hard-bounds a cancellable executor that ignores abort and releases its admission claims", async () => {
    const signals = new Map<string, AbortSignal>();
    const starts: string[] = [];
    const registry = registryFixture((context, input) => {
      signals.set(input.id, context.abortSignal);
      starts.push(input.id);
      if (input.id === "a") {
        return new Promise<FixtureOutput>(() => undefined);
      }
      return Promise.resolve({ id: input.id, value: input.value });
    }, {
      maxDurationMs: 300,
    });
    const run = await createRun(registry, [
      { id: "a" },
      { id: "b" },
    ], "run_node_deadline01");
    const exclusivePlanner: SchedulerNodePlanner = {
      ...passThroughPlanner,
      plan: request => Promise.resolve({
        exactInput: request.resolvedInput,
        publicationKeys: ["output:/shared/deadline.mp4"],
      }),
    };

    const result = await settleWithin(scheduler(run.store, registry, {
      hostLimits: {
        maxJobs: 2,
        resources: { cpu: 2 },
      },
      nodePlanner: exclusivePlanner,
    }).run("run_node_deadline01"));

    expect(result.summary.status).toBe("partial");
    expect(starts).toEqual(["a", "b"]);
    expect(signals.get("a")?.aborted).toBe(true);
    expect((await run.store.node("run_node_deadline01", "a"))).toMatchObject({
      failure: {
        code: "unavailable",
        message: "Operation exceeded its registered duration bound.",
      },
      status: "failed",
    });
    expect((await run.store.node("run_node_deadline01", "b")).status).toBe("completed");
  }, 10_000);

  test("a timed-out project operation retains its publication lease until the executor settles", async () => {
    const projectRoot = await temporaryDirectory();
    const projectId = "project_deadline_lease";
    const projectDirectory = join(projectRoot, projectId);
    await mkdir(projectDirectory, { mode: 0o700 });
    const started = deferred<void>();
    const release = deferred<void>();
    const lateSettled = deferred<void>();
    let latePublicationError: unknown;
    const registry = registryFixture(async (context, input) => {
      started.resolve();
      await release.promise;
      try {
        await context.workflow?.beforePublication();
        return { id: input.id, value: input.value };
      } catch (error) {
        latePublicationError = error;
        throw error;
      } finally {
        lateSettled.resolve();
      }
    }, {
      effect: "project-mutation",
      maxDurationMs: 300,
      resources: [{ amount: 1, resource: "project-publication" }],
    }, "recoverable-transaction");
    const run = await createRun(registry, [{
      id: "project-write",
      project: projectId,
    }], "run_node_deadline_lease");
    const projectPlanner: SchedulerNodePlanner = {
      ...passThroughPlanner,
      plan: request => Promise.resolve({
        exactInput: request.resolvedInput,
        publicationKeys: [`project:${projectId}`],
      }),
    };
    const projectApplication: ApplicationContext = {
      ...application,
      paths: {
        ...application.paths,
        projectRoot,
      },
    };

    const resultPromise = scheduler(run.store, registry, {
      application: projectApplication,
      nodePlanner: projectPlanner,
    }).run("run_node_deadline_lease");
    await settleWithin(started.promise);
    const result = await settleWithin(resultPromise);

    expect(result.summary.status).toBe("failed");
    expect((await run.store.node("run_node_deadline_lease", "project-write")).status)
      .toBe("failed");
    expect(await readdir(projectDirectory)).toContain(MUTATION_LOCK_FILE);
    let competingPublicationEntered = false;
    const competingPublication = withProjectPublicationLease(
      projectApplication,
      "derive.edit-batch",
      { project: projectId },
      () => {
        competingPublicationEntered = true;
        return Promise.resolve();
      },
    );
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(competingPublicationEntered).toBe(false);
    release.resolve();
    await settleWithin(lateSettled.promise);
    await settleWithin(competingPublication);
    expect(competingPublicationEntered).toBe(true);
    expect(await readdir(projectDirectory)).not.toContain(MUTATION_LOCK_FILE);
    expect(latePublicationError).toBeInstanceOf(ApplicationError);
    expect(latePublicationError).toHaveProperty(
      "message",
      "Workflow node deadline expired before publication.",
    );
  }, 10_000);

  test("a project transaction that passes its publication gate stays reconcilable and leased after timeout", async () => {
    const projectRoot = await temporaryDirectory();
    const projectId = "project_late_publication";
    const projectDirectory = join(projectRoot, projectId);
    await mkdir(projectDirectory, { mode: 0o700 });
    const publicationGatePassed = deferred<void>();
    const releasePublication = deferred<void>();
    const operationSettled = deferred<void>();
    let publicationCommitted = false;
    const registry = registryFixture(async (context, input) => {
      try {
        await context.workflow?.beforePublication();
        publicationGatePassed.resolve();
        await releasePublication.promise;
        publicationCommitted = true;
        return { id: input.id, value: input.value };
      } finally {
        operationSettled.resolve();
      }
    }, {
      effect: "project-mutation",
      maxDurationMs: 300,
      resources: [{ amount: 1, resource: "project-publication" }],
    }, "recoverable-transaction");
    const run = await createRun(registry, [{
      id: "project-write",
      project: projectId,
    }], "run_late_publication");
    const projectApplication: ApplicationContext = {
      ...application,
      paths: {
        ...application.paths,
        projectRoot,
      },
    };
    const firstPlanner: SchedulerNodePlanner = {
      ...passThroughPlanner,
      plan: request => Promise.resolve({
        exactInput: request.resolvedInput,
        publicationKeys: [`project:${projectId}`],
      }),
      reconcile: () => new Promise(() => undefined),
    };

    const firstResultPromise = scheduler(run.store, registry, {
      application: projectApplication,
      hostLimits: {
        maxJobs: 1,
        maxWallClockMs: 5_000,
        resources: {
          cpu: 1,
          "project-publication": 1,
        },
      },
      nodePlanner: firstPlanner,
    }).run("run_late_publication");
    await settleWithin(Promise.race([
      publicationGatePassed.promise,
      firstResultPromise.then(result => {
        throw new Error(
          `Scheduler settled ${result.summary.status} before the project publication gate.`,
        );
      }),
    ]), 7_000);
    const firstResult = await settleWithin(firstResultPromise, 8_000);

    expect(firstResult.summary.status).toBe("running");
    expect((await run.store.node("run_late_publication", "project-write")).status)
      .toBe("running");
    expect(publicationCommitted).toBe(false);
    expect(await readdir(projectDirectory)).toContain(MUTATION_LOCK_FILE);

    let competingPublicationEntered = false;
    const competingPublication = withProjectPublicationLease(
      projectApplication,
      "derive.edit-batch",
      { project: projectId },
      () => {
        competingPublicationEntered = true;
        return Promise.resolve();
      },
    );
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(competingPublicationEntered).toBe(false);

    releasePublication.resolve();
    await settleWithin(operationSettled.promise, 7_000);
    await settleWithin(competingPublication, 7_000);
    expect(publicationCommitted).toBe(true);
    expect(competingPublicationEntered).toBe(true);

    const resumed = await scheduler(run.store, registry, {
      application: projectApplication,
      nodePlanner: {
        ...firstPlanner,
        reconcile: () => Promise.resolve({
          kind: "completed",
          output: { id: "project-write", value: 1 },
          summary: { id: "project-write", value: 1 },
        }),
      },
    }).run("run_late_publication");
    expect(resumed.summary.status).toBe("completed");
  }, 20_000);

  test("hard-bounds a non-cancellable live executor as ambiguous without aborting it", async () => {
    let liveSignal: AbortSignal | undefined;
    let executions = 0;
    const registry = registryFixture((context) => {
      executions += 1;
      liveSignal = context.abortSignal;
      return new Promise<FixtureOutput>(() => undefined);
    }, {
      cancellable: false,
      effect: "live-control",
      maxDurationMs: 300,
      resources: [{ amount: 1, resource: "capture-device" }],
    }, "non-resumable-live");
    const run = await createRun(registry, [{ id: "live" }], "run_node_deadline02");

    const result = await settleWithin(
      scheduler(run.store, registry).run("run_node_deadline02"),
    );

    expect(result.summary.status).toBe("failed");
    expect(liveSignal?.aborted).toBe(false);
    expect((await run.store.node("run_node_deadline02", "live"))).toMatchObject({
      failure: {
        code: "ambiguous",
        message: "Operation exceeded its duration bound after dispatch.",
      },
      status: "ambiguous",
    });
    expect(executions).toBe(1);

    const resumed = await settleWithin(
      scheduler(run.store, registry).run("run_node_deadline02"),
    );
    expect(resumed.summary.status).toBe("failed");
    expect(executions).toBe(1);
  }, 10_000);

  test("the workflow wall-clock deadline bounds a never-settling executor and cancels queued work", async () => {
    const started = deferred<void>();
    let runningSignal: AbortSignal | undefined;
    const starts: string[] = [];
    const registry = registryFixture((context, input) => {
      starts.push(input.id);
      if (input.id === "a") {
        runningSignal = context.abortSignal;
        started.resolve();
        return new Promise<FixtureOutput>(() => undefined);
      }
      return Promise.resolve({ id: input.id, value: input.value });
    }, {
      maxDurationMs: 5_000,
    });
    const run = await createRun(registry, [
      { id: "a" },
      { id: "b" },
    ], "run_workflow_deadline01");
    const resultPromise = scheduler(run.store, registry, {
      hostLimits: {
        maxJobs: 1,
        maxWallClockMs: 2_500,
        resources: { cpu: 1 },
      },
    }).run("run_workflow_deadline01");

    await settleWithin(started.promise);
    const result = await settleWithin(resultPromise);

    expect(result.summary.status).toBe("cancelled");
    expect(starts).toEqual(["a"]);
    expect(runningSignal?.aborted).toBe(true);
    expect((await run.store.node("run_workflow_deadline01", "a"))).toMatchObject({
      failure: {
        code: "unavailable",
        message: "Operation exceeded the workflow wall-clock bound.",
      },
      status: "failed",
    });
    expect((await run.store.node("run_workflow_deadline01", "b")).status).toBe("cancelled");
  }, 10_000);

  test("reuses digest-verified completion without replaying its operation", async () => {
    let executions = 0;
    const registry = registryFixture((_context, input) => {
      executions += 1;
      return Promise.resolve({ id: input.id, value: input.value });
    });
    const run = await createRun(registry, [{ id: "once" }], "run_reuse001");
    expect((await scheduler(run.store, registry).run("run_reuse001")).summary.status)
      .toBe("completed");
    expect((await scheduler(run.store, registry).run("run_reuse001")).summary.status)
      .toBe("completed");
    expect(executions).toBe(1);
    expect((await run.store.events("run_reuse001")).some(event => (
      event.kind === "node-reused" && event.nodeKey === "once"
    ))).toBe(true);
  });

  test("reconciles an interrupted receipt-backed operation instead of replaying it", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    let executions = 0;
    let reconciliations = 0;
    let reconciliationWorkspaceDirectory: string | undefined;
    const registry = registryFixture(async (_context, input) => {
      executions += 1;
      started.resolve();
      await release.promise;
      return { id: input.id, value: input.value };
    }, {
      effect: "local-derived-write",
    }, "verified-receipt");
    const run = await createRun(registry, [{ id: "receipt" }], "run_receipt01");
    const firstRun = scheduler(run.store, registry).run("run_receipt01");
    await started.promise;
    const stolenFence = await run.store.acquireClaim("run_receipt01", {
      now: () => new Date(Date.now() + 60_000),
      owner: "receipt-takeover",
      processAlive: () => false,
      staleAfterMs: 0,
    });
    release.resolve();
    let staleError: unknown;
    try {
      await firstRun;
    } catch (error) {
      staleError = error;
    }
    expect(staleError).toBeInstanceOf(ApplicationError);
    await run.store.releaseClaim(stolenFence);

    const reconcilePlanner: SchedulerNodePlanner = {
      ...passThroughPlanner,
      reconcile: (request) => {
        reconciliations += 1;
        reconciliationWorkspaceDirectory = request.workspaceDirectory;
        return Promise.resolve({
          kind: "completed",
          output: { id: "receipt", value: 1 },
          receiptReference: "receipts/receipt.json",
          summary: { id: "receipt", value: 1 },
        });
      },
    };
    const underlyingCoordinator = createProcessLocalHostResourceCoordinator({
      profile: {
        capacities: [{ limit: 1, resource: "cpu" }],
        id: "scheduler-reconciliation-admission",
      },
    });
    const externalEntered = deferred<void>();
    const releaseExternal = deferred<void>();
    const admissionRequested = deferred<void>();
    const external = underlyingCoordinator.withLease(
      [{ amount: 1, resource: "cpu" }],
      async () => {
        externalEntered.resolve();
        await releaseExternal.promise;
      },
    );
    await externalEntered.promise;
    const trackingCoordinator: HostResourceCoordinator = {
      profile: underlyingCoordinator.profile,
      scope: underlyingCoordinator.scope,
      withLease: async (claims, callback, options) => {
        admissionRequested.resolve();
        return await underlyingCoordinator.withLease(claims, callback, options);
      },
    };
    const resumedPromise = scheduler(run.store, registry, {
      hostResourceCoordinator: trackingCoordinator,
      nodePlanner: reconcilePlanner,
    }).run("run_receipt01");
    await admissionRequested.promise;
    expect(reconciliations).toBe(0);
    releaseExternal.resolve();
    const [resumed] = await Promise.all([
      settleWithin(resumedPromise),
      settleWithin(external),
    ]);

    expect(resumed.summary.status).toBe("completed");
    expect(executions).toBe(1);
    expect(reconciliations).toBe(1);
    expect(reconciliationWorkspaceDirectory).toContain("staging");
    expect((await run.store.node("run_receipt01", "receipt")).output?.receiptReference)
      .toBe("receipts/receipt.json");
  });

  test("reconciles verified and transactional errors after the publication gate before terminal failure", async () => {
    for (const [index, resume] of ([
      "verified-receipt",
      "recoverable-transaction",
    ] as const).entries()) {
      let executions = 0;
      let reconciliations = 0;
      const registry = registryFixture(async (context) => {
        executions += 1;
        await context.workflow?.beforePublication();
        throw new ApplicationError("subprocess", "failed after authoritative publication");
      }, {
        effect: resume === "verified-receipt"
          ? "local-derived-write"
          : "project-mutation",
      }, resume);
      const runId = `run_post_publish_${String(index)}`;
      const run = await createRun(registry, [{ id: "published" }], runId);
      const reconcilePlanner: SchedulerNodePlanner = {
        ...passThroughPlanner,
        reconcile: () => {
          reconciliations += 1;
          return Promise.resolve({
            kind: "completed",
            output: { id: "published", value: 1 },
            receiptReference: `receipts/${resume}.json`,
            summary: { id: "published", value: 1 },
          });
        },
      };

      const result = await scheduler(run.store, registry, {
        nodePlanner: reconcilePlanner,
      }).run(runId);

      expect(result.summary.status).toBe("completed");
      expect(executions).toBe(1);
      expect(reconciliations).toBe(1);
      expect((await run.store.node(runId, "published"))).toMatchObject({
        output: {
          receiptReference: `receipts/${resume}.json`,
        },
        status: "completed",
      });
    }
  });

  test("a never-settling interrupted-node reconciliation releases the run claim", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const registry = registryFixture(async (_context, input) => {
      started.resolve();
      await release.promise;
      return { id: input.id, value: input.value };
    }, {
      effect: "local-derived-write",
    }, "verified-receipt");
    const run = await createRun(registry, [{ id: "receipt" }], "run_reconcile_deadline");
    const firstRun = scheduler(run.store, registry).run("run_reconcile_deadline");
    await started.promise;
    const takeover = await run.store.acquireClaim("run_reconcile_deadline", {
      now: () => new Date(Date.now() + 60_000),
      owner: "reconciliation-takeover",
      processAlive: () => false,
      staleAfterMs: 0,
    });
    release.resolve();
    let staleError: unknown;
    try {
      await firstRun;
    } catch (error) {
      staleError = error;
    }
    expect(staleError).toBeInstanceOf(ApplicationError);
    expect(staleError).toHaveProperty("message", expect.stringContaining("stale"));
    await run.store.releaseClaim(takeover);

    let reconciliationStarted = false;
    let reconciliationSignal: AbortSignal | undefined;
    let latePublicationFence: (() => Promise<void>) | undefined;
    const result = await settleWithin(scheduler(run.store, registry, {
      hostLimits: {
        maxJobs: 1,
        maxWallClockMs: 1_000,
        resources: { cpu: 1 },
      },
      nodePlanner: {
        ...passThroughPlanner,
        reconcile: (request) => {
          reconciliationStarted = true;
          reconciliationSignal = request.abortSignal;
          latePublicationFence = request.beforePublication;
          return new Promise(() => undefined);
        },
      },
    }).run("run_reconcile_deadline"), 3_500);

    expect(reconciliationStarted).toBe(true);
    expect(result.summary.status).toBe("running");
    expect((await run.store.node("run_reconcile_deadline", "receipt")).status)
      .toBe("running");
    expect(reconciliationSignal?.aborted).toBe(true);
    const nextFence = await run.store.acquireClaim("run_reconcile_deadline", {
      owner: "after-reconciliation-deadline",
    });
    await run.store.releaseClaim(nextFence);
    if (latePublicationFence === undefined) {
      throw new Error("Expected a reconciliation publication fence.");
    }
    expect(latePublicationFence()).rejects.toMatchObject({
      code: "cancelled",
    });
  }, 10_000);

  test("durable cancellation aborts reconciliation and fences every late publication", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const registry = registryFixture(async (_context, input) => {
      started.resolve();
      await release.promise;
      return { id: input.id, value: input.value };
    }, {
      effect: "local-derived-write",
    }, "verified-receipt");
    const runId = "run_reconcile_cancel";
    const run = await createRun(registry, [{ id: "receipt" }], runId);
    const firstRun = scheduler(run.store, registry).run(runId);
    await started.promise;
    const takeover = await run.store.acquireClaim(runId, {
      now: () => new Date(Date.now() + 60_000),
      owner: "reconciliation-cancel-takeover",
      processAlive: () => false,
      staleAfterMs: 0,
    });
    release.resolve();
    let staleError: unknown;
    try {
      await firstRun;
    } catch (error) {
      staleError = error;
    }
    expect(staleError).toBeInstanceOf(ApplicationError);
    await run.store.releaseClaim(takeover);

    const reconciliationEntered = deferred<void>();
    let reconciliationSignal: AbortSignal | undefined;
    let latePublicationFence: (() => Promise<void>) | undefined;
    const resultPromise = scheduler(run.store, registry, {
      hostLimits: {
        maxJobs: 1,
        maxWallClockMs: 10_000,
        resources: { cpu: 1 },
      },
      nodePlanner: {
        ...passThroughPlanner,
        reconcile: (request) => {
          reconciliationSignal = request.abortSignal;
          latePublicationFence = request.beforePublication;
          reconciliationEntered.resolve();
          return new Promise(() => undefined);
        },
      },
    }).run(runId);
    await settleWithin(reconciliationEntered.promise);
    await run.store.requestCancellation(runId, "reconciliation-test");
    const result = await settleWithin(resultPromise);

    expect(result.summary.status).toBe("running");
    expect(reconciliationSignal?.aborted).toBe(true);
    if (latePublicationFence === undefined) {
      throw new Error("Expected a reconciliation publication fence.");
    }
    expect(latePublicationFence()).rejects.toMatchObject({
      code: "cancelled",
    });
    const nextFence = await run.store.acquireClaim(runId, {
      owner: "after-reconciliation-cancellation",
    });
    await run.store.releaseClaim(nextFence);
  }, 10_000);

  test("a stale fence cannot publish, and interrupted paid or live effects never replay", async () => {
    for (const scenario of [
      {
        effect: "paid-cloud",
        id: "paid",
        resources: [
          { amount: 1, resource: "network" },
          { amount: 1, resource: "paid-call" },
        ],
        resume: "ambiguous-after-dispatch",
        runId: "run_paid001",
      },
      {
        effect: "live-control",
        id: "live",
        resources: [{ amount: 1, resource: "capture-device" }],
        resume: "non-resumable-live",
        runId: "run_live001",
      },
    ] as const) {
      const started = deferred<void>();
      const release = deferred<void>();
      let executions = 0;
      const registry = registryFixture(async (_context, input) => {
        executions += 1;
        started.resolve();
        await release.promise;
        return { id: input.id, value: input.value };
      }, {
        effect: scenario.effect,
        resources: scenario.resources,
      }, scenario.resume);
      const run = await createRun(registry, [{ id: scenario.id }], scenario.runId);
      const firstRun = scheduler(run.store, registry).run(scenario.runId);
      await started.promise;
      const stolenFence = await run.store.acquireClaim(scenario.runId, {
        now: () => new Date(Date.now() + 60_000),
        owner: "takeover",
        processAlive: () => false,
        staleAfterMs: 0,
      });
      release.resolve();
      let staleError: unknown;
      try {
        await firstRun;
      } catch (error) {
        staleError = error;
      }
      expect(staleError).toBeInstanceOf(ApplicationError);
      expect(staleError).toHaveProperty("message", expect.stringContaining("stale"));
      expect((await run.store.node(scenario.runId, scenario.id)).output).toBeUndefined();
      await run.store.releaseClaim(stolenFence);

      const resumed = await scheduler(run.store, registry).run(scenario.runId);

      expect(resumed.summary.status).toBe("failed");
      expect((await run.store.node(scenario.runId, scenario.id)).status).toBe("ambiguous");
      expect(executions).toBe(1);
    }
  });
});
