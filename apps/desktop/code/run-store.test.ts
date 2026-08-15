import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { OperationRegistry } from "../application/registry";
import type { OperationDefinition } from "../application/operation";
import {
  CODE_WORKER_ABI,
  GRAPH_ABI,
  GRAPH_COMPILER_ABI,
  GRAPH_SCHEDULER_ABI,
  trustedComputePolicy,
  type WorkflowBundleIdentity,
  type WorkflowRuntimeIdentity,
} from "./contracts";
import { compileGraphPlan } from "./compiler";
import { defineCompute } from "./define-workflow";
import { WorkflowGraphBuilder } from "./graph-builder";
import {
  CancellationRequestSchema,
  NODE_EXECUTION_PLAN_VERSION,
  NODE_PREPARATION_PLAN_VERSION,
  RUN_EVENT_VERSION,
  RUN_FENCE_VERSION,
  RUN_GRANT_VERSION,
  RUN_NODE_VERSION,
  RUN_OUTPUTS_VERSION,
  RUN_STORE_VERSION,
  NodeExecutionPlanSchema,
  NodePreparationPlanSchema,
  RunEventSchema,
  RunFenceSchema,
  RunGrantSchema,
  RunNodeRecordSchema,
  RunOutputsSchema,
  RunRuntimeRecordSchema,
  RunSummarySchema,
  createNodeExecutionPlanHash,
  createNodeInputHash,
  createNodePreparationPlanHash,
  createRunNodeOutputDigest,
  createRunOutputsDigest,
  nodeRecordFilename,
  type CreateRunRecord,
  type NodeExecutionPlan,
  type NodePreparationPlan,
  type RunFence,
  type RunNodeRecord,
} from "./run-contracts";
import { RunStore } from "./run-store";

const temporaryDirectories: string[] = [];
const HEX = "0".repeat(64);

async function temporaryDirectory(): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "atet-run-store-")));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async directory => {
    await rm(directory, { force: true, recursive: true });
  }));
});

function fixture(): CreateRunRecord {
  const definition = {
    inputSchema: z.strictObject({ value: z.number().int() }),
    inputSchemaId: "test.input/v1",
    kind: "project.snapshot",
    lifecycle: {
      kind: "pure",
      execute: (_context, input) => Promise.resolve({ value: input.value + 1 }),
    },
    outputSchema: z.strictObject({ value: z.number().int() }),
    outputSchemaId: "test.output/v1",
    policy: {
      cache: "content-addressed",
      cancellable: true,
      effect: "pure",
      maxDurationMs: 1_000,
      maxFanOut: 1,
      maxInputBytes: 1_024,
      maxOutputBytes: 1_024,
      preparation: [],
      resources: [{ amount: 1, resource: "cpu" }],
      resume: "deterministic",
    },
    summarize: output => ({ fields: { value: output.value }, kind: "project.snapshot" }),
    version: 1,
  } satisfies OperationDefinition<"project.snapshot", { value: number }, { value: number }>;
  const registry = new OperationRegistry();
  registry.register(definition);
  const builder = WorkflowGraphBuilder.create(registry);
  const output = builder.operationByKind<{ value: number }>("snapshot", {
    input: { value: 1 },
    kind: "project.snapshot",
    version: 1,
  });
  const workflow = {
    id: "run-store-fixture",
    inputSchemaId: "test.workflow-input/v1",
    version: 1,
  } as const;
  const graph = builder.build(workflow, { output });
  const bundleBytes = new TextEncoder().encode("export default {};\n");
  const bundle: WorkflowBundleIdentity = {
    bundleSha256: createHash("sha256").update(bundleBytes).digest("hex"),
    bytes: bundleBytes.byteLength,
    dependencyGraphSha256: HEX,
    entrypoint: "fixture.ts",
    sourceSha256: "1".repeat(64),
  };
  const runtimeIdentity: WorkflowRuntimeIdentity = {
    applicationBuild: "test",
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
  const runId = "run_store01";
  return {
    bundleBytes,
    graphPlan,
    runId,
    runtime: {
      computes: [],
      operations: [{ kind: "project.snapshot", version: 1 }],
      runtime: runtimeIdentity,
      version: RUN_STORE_VERSION,
    },
    sourceLocator: "fixture.ts",
    workflow: {
      bundle,
      sourceLocator: "fixture.ts",
      workflow,
    },
  };
}

function computeFixture(): CreateRunRecord {
  const registry = new OperationRegistry();
  const builder = WorkflowGraphBuilder.create(registry);
  const compute = defineCompute({
    inputSchema: z.strictObject({ value: z.number().int() }),
    inputSchemaId: "test.compute-input/v1",
    key: "test.compute-replay",
    maxDurationMs: 1_000,
    maxInputBytes: 1_024,
    maxOutputBytes: 1_024,
    outputSchema: z.strictObject({ value: z.number().int() }),
    outputSchemaId: "test.compute-output/v1",
    run: input => ({ value: input.value + 1 }),
  });
  const output = builder.compute("compute", compute, { value: 1 });
  const workflow = {
    id: "run-store-compute-fixture",
    inputSchemaId: "test.compute-workflow-input/v1",
    version: 1,
  } as const;
  const graph = builder.build(workflow, { output });
  const bundleBytes = new TextEncoder().encode("export default { compute: true };\n");
  const bundle: WorkflowBundleIdentity = {
    bundleSha256: createHash("sha256").update(bundleBytes).digest("hex"),
    bytes: bundleBytes.byteLength,
    dependencyGraphSha256: "4".repeat(64),
    entrypoint: "compute-fixture.ts",
    sourceSha256: "5".repeat(64),
  };
  const runtimeIdentity: WorkflowRuntimeIdentity = {
    applicationBuild: "test",
    bunRevision: Bun.revision,
    bunVersion: Bun.version,
    bundlerConfigurationSha256: "6".repeat(64),
    bundlerName: "bun",
    bundlerRevision: Bun.revision,
    bundlerVersion: Bun.version,
    codeWorkerAbi: CODE_WORKER_ABI,
    compilerAbi: GRAPH_COMPILER_ABI,
    externals: {
      kind: "deny-all",
      modules: [],
      policySha256: "7".repeat(64),
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
  const node = graphPlan.graph.nodes[0]!;
  if (node.executor.kind !== "compute") {
    throw new Error("Expected the compute fixture node to use a compute executor.");
  }
  return {
    bundleBytes,
    graphPlan,
    runId: "run_compute01",
    runtime: {
      computes: [node.executor.compute],
      operations: [],
      runtime: runtimeIdentity,
      version: RUN_STORE_VERSION,
    },
    sourceLocator: "compute-fixture.ts",
    workflow: {
      bundle,
      sourceLocator: "compute-fixture.ts",
      workflow,
    },
  };
}

function plans(input: CreateRunRecord): {
  readonly execution: NodeExecutionPlan;
  readonly preparation: NodePreparationPlan;
} {
  const node = input.graphPlan.graph.nodes[0]!;
  if (node.executor.kind !== "operation") {
    throw new Error("Expected the fixture node to use an operation executor.");
  }
  const operation = node.executor.operation;
  const discovery = input.graphPlan.registry.discovery.find(item => (
    item.kind === operation.kind
    && item.version === operation.version
  ))!;
  const preparationUnsigned: Omit<NodePreparationPlan, "preparationPlanSha256"> = {
    executor: node.executor,
    graphPlanSha256: input.graphPlan.graphPlanSha256,
    inputDescriptors: {},
    nodeKey: node.key,
    requestedPreparation: [],
    upperDurationMs: discovery.policy.maxDurationMs,
    upperInputBytes: discovery.policy.maxInputBytes,
    version: NODE_PREPARATION_PLAN_VERSION,
  };
  const preparation = {
    ...preparationUnsigned,
    preparationPlanSha256: createNodePreparationPlanHash(preparationUnsigned),
  };
  const exactInput = { value: 1 } as const;
  const executionUnsigned: Omit<NodeExecutionPlan, "nodePlanSha256"> = {
    dependencyOutputDigests: {},
    executor: node.executor,
    exactInput,
    graphPlanSha256: input.graphPlan.graphPlanSha256,
    inputSha256: createNodeInputHash(exactInput),
    nodeKey: node.key,
    policy: discovery.policy,
    preparationPlanSha256: preparation.preparationPlanSha256,
    publicationKeys: [],
    version: NODE_EXECUTION_PLAN_VERSION,
  };
  return {
    execution: {
      ...executionUnsigned,
      nodePlanSha256: createNodeExecutionPlanHash(executionUnsigned),
    },
    preparation,
  };
}

function computePlans(input: CreateRunRecord): {
  readonly execution: NodeExecutionPlan;
  readonly preparation: NodePreparationPlan;
} {
  const node = input.graphPlan.graph.nodes[0]!;
  if (node.executor.kind !== "compute") {
    throw new Error("Expected the fixture node to use a compute executor.");
  }
  const policy = trustedComputePolicy(node.executor.compute);
  const preparationUnsigned: Omit<NodePreparationPlan, "preparationPlanSha256"> = {
    executor: node.executor,
    graphPlanSha256: input.graphPlan.graphPlanSha256,
    inputDescriptors: {},
    nodeKey: node.key,
    requestedPreparation: [],
    upperDurationMs: policy.maxDurationMs,
    upperInputBytes: policy.maxInputBytes,
    version: NODE_PREPARATION_PLAN_VERSION,
  };
  const preparation: NodePreparationPlan = {
    ...preparationUnsigned,
    preparationPlanSha256: createNodePreparationPlanHash(preparationUnsigned),
  };
  const exactInput = { value: 1 } as const;
  const executionUnsigned: Omit<NodeExecutionPlan, "nodePlanSha256"> = {
    dependencyOutputDigests: {},
    executor: node.executor,
    exactInput,
    graphPlanSha256: input.graphPlan.graphPlanSha256,
    inputSha256: createNodeInputHash(exactInput),
    nodeKey: node.key,
    policy,
    preparationPlanSha256: preparation.preparationPlanSha256,
    publicationKeys: [],
    version: NODE_EXECUTION_PLAN_VERSION,
  };
  return {
    execution: {
      ...executionUnsigned,
      nodePlanSha256: createNodeExecutionPlanHash(executionUnsigned),
    },
    preparation,
  };
}

async function interruptComputeNode(
  store: RunStore,
  input: CreateRunRecord,
  fence: RunFence,
): Promise<RunNodeRecord> {
  let ready = await store.node(input.runId, "compute");
  if (ready.preparationPlan === undefined || ready.executionPlan === undefined) {
    const preparing: RunNodeRecord = { ...ready, status: "preparing" };
    await store.writeNode(fence, preparing);
    const nodePlans = computePlans(input);
    ready = {
      ...preparing,
      executionPlan: nodePlans.execution,
      preparationPlan: nodePlans.preparation,
      status: "ready",
    };
    await store.writeNode(fence, ready);
  }
  const attempt = ready.attempt + 1;
  const startedAt = new Date(Date.UTC(2026, 6, 23, 12, 0, attempt)).toISOString();
  const running: RunNodeRecord = {
    ...ready,
    attempt,
    startedAt,
    status: "running",
  };
  await store.writeNode(fence, running);
  const interrupted: RunNodeRecord = {
    ...running,
    failure: {
      code: "ambiguous",
      message: "Trusted compute was interrupted.",
      retryable: false,
    },
    finishedAt: new Date(Date.parse(startedAt) + 1).toISOString(),
    status: "ambiguous-code",
  };
  await store.writeNode(fence, interrupted);
  return interrupted;
}

async function expectRejection(
  promise: Promise<unknown>,
  expectedMessage: string,
): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected rejection containing: ${expectedMessage}`);
  } catch (error) {
    expect(String(error)).toContain(expectedMessage);
  }
}

async function completeFixtureNode(
  store: RunStore,
  input: CreateRunRecord,
  fence: RunFence,
): Promise<RunNodeRecord> {
  const initial = await store.node(input.runId, "snapshot");
  const preparing: RunNodeRecord = {
    ...initial,
    status: "preparing",
  };
  await store.writeNode(fence, preparing);
  const nodePlans = plans(input);
  const ready: RunNodeRecord = {
    ...preparing,
    executionPlan: nodePlans.execution,
    preparationPlan: nodePlans.preparation,
    status: "ready",
  };
  await store.writeNode(fence, ready);
  const startedAt = new Date().toISOString();
  const running: RunNodeRecord = {
    ...ready,
    attempt: 1,
    startedAt,
    status: "running",
  };
  await store.writeNode(fence, running);
  const completed: RunNodeRecord = {
    ...running,
    finishedAt: new Date(Date.parse(startedAt) + 1).toISOString(),
    output: {
      digestSha256: createRunNodeOutputDigest({ value: 2 }),
      summary: { value: 2 },
      value: { value: 2 },
    },
    status: "completed",
  };
  await store.writeNode(fence, completed);
  return completed;
}

describe("durable workflow run store", () => {
  test("fails closed on predecessor machine-local run state", () => {
    const input = fixture();
    const node = input.graphPlan.graph.nodes[0]!;
    const nodePlans = plans(input);
    const timestamp = "2026-07-23T12:00:00.000Z";
    const currentRecords: readonly {
      readonly current: unknown;
      readonly legacyVersion: string;
      readonly schema: z.ZodType;
    }[] = [
      {
        current: input.runtime,
        legacyVersion: "transmute-run-store-v2",
        schema: RunRuntimeRecordSchema,
      },
      {
        current: nodePlans.preparation,
        legacyVersion: "transmute-node-preparation-plan-v2",
        schema: NodePreparationPlanSchema,
      },
      {
        current: nodePlans.execution,
        legacyVersion: "transmute-node-execution-plan-v2",
        schema: NodeExecutionPlanSchema,
      },
      {
        current: {
          attempt: 0,
          dependencies: node.dependencies,
          executionPlan: nodePlans.execution,
          executor: node.executor,
          nodeKey: node.key,
          preparationPlan: nodePlans.preparation,
          status: "ready",
          version: RUN_NODE_VERSION,
        },
        legacyVersion: "transmute-run-node-v2",
        schema: RunNodeRecordSchema,
      },
      {
        current: {
          acquiredAt: timestamp,
          generation: 1,
          hostname: "localhost",
          owner: "owner",
          pid: 1,
          runId: input.runId,
          token: "00000000-0000-4000-8000-000000000001",
          version: RUN_FENCE_VERSION,
        },
        legacyVersion: "transmute-run-fence-v2",
        schema: RunFenceSchema,
      },
      {
        current: {
          details: {},
          fenceGeneration: 1,
          kind: "run-claimed",
          runId: input.runId,
          sequence: 1,
          timestamp,
          version: RUN_EVENT_VERSION,
        },
        legacyVersion: "transmute-run-event-v2",
        schema: RunEventSchema,
      },
      {
        current: {
          createdAt: timestamp,
          graphPlanSha256: input.graphPlan.graphPlanSha256,
          grantedBy: "owner",
          grantId: "00000000-0000-4000-8000-000000000002",
          kind: "graph-policy",
          runId: input.runId,
          scopes: ["local-read"],
          version: RUN_GRANT_VERSION,
        },
        legacyVersion: "transmute-run-grant-v2",
        schema: RunGrantSchema,
      },
      {
        current: {
          requestedAt: timestamp,
          requestedBy: "owner",
          runId: input.runId,
          version: RUN_STORE_VERSION,
        },
        legacyVersion: "transmute-run-store-v2",
        schema: CancellationRequestSchema,
      },
      {
        current: {
          counts: { cancelled: 0, completed: 0, failed: 0, pending: 1, skipped: 0 },
          graphPlanSha256: input.graphPlan.graphPlanSha256,
          runId: input.runId,
          status: "planned",
          updatedAt: timestamp,
          version: RUN_STORE_VERSION,
        },
        legacyVersion: "transmute-run-store-v2",
        schema: RunSummarySchema,
      },
      {
        current: {
          graphPlanSha256: input.graphPlan.graphPlanSha256,
          nodeOutputDigests: {},
          outputs: {},
          outputsSha256: createRunOutputsDigest({}),
          runId: input.runId,
          version: RUN_OUTPUTS_VERSION,
        },
        legacyVersion: "transmute-run-outputs-v2",
        schema: RunOutputsSchema,
      },
    ];

    for (const { current, legacyVersion, schema: contract } of currentRecords) {
      expect(contract.safeParse(current).success).toBe(true);
      expect(contract.safeParse({
        ...(current as Readonly<Record<string, unknown>>),
        version: legacyVersion,
      }).success).toBe(false);
    }
    expect(JSON.stringify(currentRecords.map(record => record.current)))
      .not.toMatch(/(?:studio|transmute)[.-]/u);
  });

  test("persists exact private identities and initializes digest-addressed nodes", async () => {
    const root = await temporaryDirectory();
    const store = new RunStore({ root });
    const input = fixture();
    const summary = await store.create(input);

    expect(summary).toMatchObject({
      counts: { completed: 0, failed: 0, pending: 1 },
      runId: input.runId,
      status: "planned",
    });
    expect(await store.list()).toEqual([summary]);
    expect((await store.graphPlan(input.runId)).graphPlanSha256).toBe(input.graphPlan.graphPlanSha256);
    expect(await store.bundle(input.runId)).toEqual(input.bundleBytes);
    expect(await store.node(input.runId, "snapshot")).toMatchObject({
      attempt: 0,
      nodeKey: "snapshot",
      status: "ready",
    });
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, input.runId))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(root, input.runId, "workflow.bundle.js"))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(root, input.runId, "nodes", nodeRecordFilename("snapshot")))).mode & 0o777)
      .toBe(0o600);
  });

  test("allocates deterministic private staging only for the exact fenced node plan", async () => {
    const root = await temporaryDirectory();
    const store = new RunStore({ root });
    const input = fixture();
    await store.create(input);
    const fence = await store.acquireClaim(input.runId, { owner: "staging-writer" });
    try {
      const current = await store.node(input.runId, "snapshot");
      const nodePlans = plans(input);
      const preparing: RunNodeRecord = { ...current, status: "preparing" };
      await store.writeNode(fence, preparing);
      await store.writeNode(fence, {
        ...preparing,
        executionPlan: nodePlans.execution,
        preparationPlan: nodePlans.preparation,
        status: "ready",
      });
      const first = await store.stagingDirectory(
        fence,
        "snapshot",
        nodePlans.execution.nodePlanSha256,
      );
      const second = await store.stagingDirectory(
        fence,
        "snapshot",
        nodePlans.execution.nodePlanSha256,
      );
      expect(second).toBe(first);
      expect(first).toEndWith(
        `${nodeRecordFilename("snapshot").slice(0, -".json".length)}/${nodePlans.execution.nodePlanSha256}`,
      );
      expect((await lstat(first)).mode & 0o777).toBe(0o700);
      expect(store.stagingDirectory(
        fence,
        "snapshot",
        "f".repeat(64),
      )).rejects.toThrow("exact execution plan");
    } finally {
      await store.releaseClaim(fence);
    }
  });

  test("rejects inconsistent creation identities and bounded bundle violations", async () => {
    const root = await temporaryDirectory();
    const input = fixture();
    expect(new RunStore({ root }).create({
      ...input,
      runtime: { ...input.runtime, operations: [] },
    })).rejects.toThrow("operation identities");

    const otherRoot = await temporaryDirectory();
    expect(new RunStore({ root: otherRoot }).create({
      ...input,
      bundleBytes: new Uint8Array(16 * 1024 * 1024 + 1),
    })).rejects.toThrow("exceeds");
  });

  test("hash-verifies graph plans and exact bundle bytes on every identity read", async () => {
    const root = await temporaryDirectory();
    const store = new RunStore({ root });
    const input = fixture();
    await store.create(input);
    const planPath = join(root, input.runId, "graph-plan.json");
    const plan = JSON.parse(await readFile(planPath, "utf8")) as Record<string, unknown>;
    plan.workflowInput = { changed: true };
    await writeFile(planPath, `${JSON.stringify(plan)}\n`);
    expect(store.graphPlan(input.runId)).rejects.toThrow("hash");

    const otherRoot = await temporaryDirectory();
    const otherStore = new RunStore({ root: otherRoot });
    await otherStore.create(input);
    await appendFile(join(otherRoot, input.runId, "workflow.bundle.js"), "tampered");
    expect(otherStore.graphPlan(input.runId)).rejects.toThrow("bundle bytes");
  });

  test("admits one owner, increments fences, and rejects a stale writer", async () => {
    const root = await temporaryDirectory();
    const store = new RunStore({ root });
    const input = fixture();
    await store.create(input);
    const first = await store.acquireClaim(input.runId, { owner: "first" });
    expect(store.acquireClaim(input.runId, { owner: "second" })).rejects.toThrow("already claimed");

    await completeFixtureNode(store, input, first);
    await store.releaseClaim(first);

    const second = await store.acquireClaim(input.runId, { owner: "second" });
    expect(second.generation).toBe(first.generation + 1);
    expect(store.writeNode(first, await store.node(input.runId, "snapshot"))).rejects.toThrow("stale");
    await store.releaseClaim(second);
  });

  test("fails closed when immutable run identity changes under an active claim", async () => {
    const root = await temporaryDirectory();
    const store = new RunStore({ root });
    const input = fixture();
    await store.create(input);
    const fence = await store.acquireClaim(input.runId, { owner: "writer" });
    const current = await store.node(input.runId, "snapshot");

    await appendFile(join(root, input.runId, "workflow.bundle.js"), "tampered");

    expect(store.writeNode(fence, current)).rejects.toThrow(
      "identity changed while its claim was active",
    );
    await store.releaseClaim(fence);
  });

  test("does not let a rejected stale fence evict the active claim identity", async () => {
    const root = await temporaryDirectory();
    const store = new RunStore({ root });
    const input = fixture();
    await store.create(input);
    const stale = await store.acquireClaim(input.runId, { owner: "stale" });
    await store.releaseClaim(stale);
    const active = await store.acquireClaim(input.runId, { owner: "active" });
    const current = await store.node(input.runId, "snapshot");

    expect(store.assertFence(stale)).rejects.toThrow("stale");
    await appendFile(join(root, input.runId, "workflow.bundle.js"), "tampered");
    expect(store.writeNode(active, current)).rejects.toThrow(
      "identity changed while its claim was active",
    );
    await store.releaseClaim(active);
  });

  test("bounds cached claim sessions with deterministic eviction", async () => {
    const root = await temporaryDirectory();
    const cachingStore = new RunStore({ root });
    const claims: { readonly fence: RunFence; readonly input: CreateRunRecord }[] = [];
    let firstNode: RunNodeRecord | undefined;
    for (let index = 0; index < 17; index += 1) {
      const input = { ...fixture(), runId: `run_cache_${String(index).padStart(2, "0")}` };
      await cachingStore.create(input);
      const fence = await cachingStore.acquireClaim(input.runId, { owner: `owner-${String(index)}` });
      claims.push({ fence, input });
      if (index === 0) firstNode = await cachingStore.node(input.runId, "snapshot");
    }
    const first = claims[0];
    if (first === undefined || firstNode === undefined) throw new Error("Expected the first claim.");

    await appendFile(join(root, first.input.runId, "workflow.bundle.js"), "tampered");
    expect(cachingStore.writeNode(first.fence, firstNode)).rejects.toThrow(
      "Persisted workflow bundle bytes changed",
    );

    const releasingStore = new RunStore({ root });
    await Promise.all(claims.map(async ({ fence }) => releasingStore.releaseClaim(fence)));
  });

  test("evicts claim sessions by retained bytes and falls back to full validation", async () => {
    const root = await temporaryDirectory();
    const cachingStore = new RunStore({
      claimSessionCacheBudgetBytes: 32 * 1024,
      root,
    });
    const claims: {
      readonly fence: RunFence;
      readonly input: CreateRunRecord;
      readonly node: RunNodeRecord;
    }[] = [];
    for (let index = 0; index < 2; index += 1) {
      const input = { ...fixture(), runId: `run_bytes_${String(index)}` };
      await cachingStore.create(input);
      const fence = await cachingStore.acquireClaim(input.runId, {
        owner: `owner-${String(index)}`,
      });
      claims.push({
        fence,
        input,
        node: await cachingStore.node(input.runId, "snapshot"),
      });
    }
    const oldest = claims[0];
    const newest = claims[1];
    if (oldest === undefined || newest === undefined) {
      throw new Error("Expected two byte-weighted claim sessions.");
    }

    await appendFile(join(root, oldest.input.runId, "workflow.bundle.js"), "tampered");
    expect(cachingStore.writeNode(oldest.fence, oldest.node)).rejects.toThrow(
      "Persisted workflow bundle bytes changed",
    );
    await appendFile(join(root, newest.input.runId, "workflow.bundle.js"), "tampered");
    expect(cachingStore.writeNode(newest.fence, newest.node)).rejects.toThrow(
      "identity changed while its claim was active",
    );

    const releasingStore = new RunStore({ root });
    await Promise.all(claims.map(async ({ fence }) => releasingStore.releaseClaim(fence)));
  });

  test("reclaims only an injected provably abandoned owner and preserves cancellation", async () => {
    const root = await temporaryDirectory();
    const store = new RunStore({ root });
    const input = fixture();
    await store.create(input);
    const acquiredAt = new Date("2026-07-23T12:00:00.000Z");
    const first = await store.acquireClaim(input.runId, {
      now: () => acquiredAt,
      owner: "abandoned",
    });
    const reclaimed = await store.acquireClaim(input.runId, {
      now: () => new Date(acquiredAt.getTime() + 1),
      owner: "reclaimer",
      processAlive: () => false,
      staleAfterMs: 0,
    });
    expect(reclaimed.generation).toBe(first.generation + 1);
    expect(store.appendEvent(first, {
      details: {},
      kind: "run-status",
      timestamp: acquiredAt.toISOString(),
    })).rejects.toThrow("stale");

    const [left, right] = await Promise.all([
      store.requestCancellation(input.runId, "agent", acquiredAt),
      new RunStore({ root }).requestCancellation(input.runId, "other"),
    ]);
    expect(left).toEqual(right);
    expect(await store.cancellation(input.runId)).toEqual(left);
    await store.releaseClaim(reclaimed);
  });

  test("does not strand a published claim when its first journal append fails", async () => {
    const root = await temporaryDirectory();
    const store = new RunStore({ root });
    const input = fixture();
    await store.create(input);
    const eventsPath = join(root, input.runId, "events.jsonl");
    await writeFile(eventsPath, "{\"broken\":true}\n");
    expect(store.acquireClaim(input.runId, { owner: "failed" })).rejects.toThrow(
      "journal entry",
    );
    expect(lstat(join(root, input.runId, ".claim.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await writeFile(eventsPath, "");
    const recovered = await store.acquireClaim(input.runId, { owner: "recovered" });
    expect(recovered.generation).toBe(2);
    await store.releaseClaim(recovered);
  });

  test("recovers a torn journal tail before the next append", async () => {
    const root = await temporaryDirectory();
    const store = new RunStore({ root });
    const input = fixture();
    await store.create(input);
    const fence = await store.acquireClaim(input.runId, { owner: "writer" });
    const eventsPath = join(root, input.runId, "events.jsonl");
    await appendFile(eventsPath, "{\"kind\":\"node-status\"");
    expect((await store.events(input.runId)).map(event => event.sequence)).toEqual([1]);
    await store.appendEvent(fence, {
      details: { status: "running" },
      kind: "run-status",
      timestamp: new Date().toISOString(),
    });
    expect((await store.events(input.runId)).map(event => event.sequence)).toEqual([1, 2]);
    expect(await readFile(eventsPath, "utf8")).not.toContain("{\"kind\":\"node-status\"");
    await store.releaseClaim(fence);
  });

  test("falls back to full event validation when cached journal metadata changes", async () => {
    const root = await temporaryDirectory();
    const store = new RunStore({ root });
    const input = fixture();
    await store.create(input);
    const fence = await store.acquireClaim(input.runId, { owner: "writer" });
    const eventsPath = join(root, input.runId, "events.jsonl");
    const persisted = await readFile(eventsPath, "utf8");
    await writeFile(eventsPath, persisted.replace('"sequence":1', '"sequence":2'));

    expect(store.appendEvent(fence, {
      details: {},
      kind: "run-status",
      timestamp: new Date().toISOString(),
    })).rejects.toThrow("sequence is inconsistent");
    await store.releaseClaim(fence);
  });

  test("rejects an oversized journal before deriving or appending another entry", async () => {
    const root = await temporaryDirectory();
    const store = new RunStore({ root });
    const input = fixture();
    await store.create(input);
    const fence = await store.acquireClaim(input.runId, { owner: "writer" });
    await truncate(join(root, input.runId, "events.jsonl"), 32 * 1024 * 1024 + 1);
    expect(store.events(input.runId)).rejects.toThrow("bounded");
    expect(store.appendEvent(fence, {
      details: {},
      kind: "run-status",
      timestamp: new Date().toISOString(),
    })).rejects.toThrow("bounded");
    await store.releaseClaim(fence);
  });

  test("serializes journal sequence allocation across RunStore instances", async () => {
    const root = await temporaryDirectory();
    const firstStore = new RunStore({ root });
    const secondStore = new RunStore({ root });
    const input = fixture();
    await firstStore.create(input);
    const fence = await firstStore.acquireClaim(input.runId, { owner: "shared-fence" });
    await Promise.all(Array.from({ length: 24 }, async (_, index) => {
      const store = index % 2 === 0 ? firstStore : secondStore;
      await store.appendEvent(fence, {
        details: { index },
        kind: "run-status",
        timestamp: new Date().toISOString(),
      });
    }));
    expect((await firstStore.events(input.runId)).map(event => event.sequence))
      .toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
    await secondStore.releaseClaim(fence);
  });

  test("rejects illegal transitions, identity drift, and invalid semantic plan hashes", async () => {
    const root = await temporaryDirectory();
    const store = new RunStore({ root });
    const input = fixture();
    await store.create(input);
    const fence = await store.acquireClaim(input.runId, { owner: "writer" });
    const current = await store.node(input.runId, "snapshot");
    const nodePlans = plans(input);
    const impossibleStartedAt = new Date().toISOString();
    expect(store.writeNode(fence, {
      ...current,
      attempt: 1,
      executionPlan: nodePlans.execution,
      finishedAt: new Date(Date.parse(impossibleStartedAt) + 1).toISOString(),
      output: {
        digestSha256: createRunNodeOutputDigest({ value: 2 }),
        summary: { value: 2 },
        value: { value: 2 },
      },
      preparationPlan: nodePlans.preparation,
      startedAt: impossibleStartedAt,
      status: "completed",
    })).rejects.toThrow("Illegal");
    expect(store.writeNode(fence, {
      ...current,
      executor: {
        kind: "operation",
        operation: { kind: "analysis.faces", version: 1 },
      },
    })).rejects.toThrow("identity");
    expect(store.writeNode(fence, {
      ...current,
      preparationPlan: {
        ...nodePlans.preparation,
        preparationPlanSha256: HEX,
      },
      status: "approval-required",
    })).rejects.toThrow("digest");

    const preparing: RunNodeRecord = { ...current, status: "preparing" };
    await store.writeNode(fence, preparing);
    const ready: RunNodeRecord = {
      ...preparing,
      executionPlan: nodePlans.execution,
      preparationPlan: nodePlans.preparation,
      status: "ready",
    };
    await store.writeNode(fence, ready);
    const startedAt = new Date().toISOString();
    const running: RunNodeRecord = {
      ...ready,
      attempt: 1,
      startedAt,
      status: "running",
    };
    await store.writeNode(fence, running);
    expect(store.writeNode(fence, {
      ...running,
      finishedAt: new Date(Date.parse(startedAt) + 1).toISOString(),
      output: {
        digestSha256: HEX,
        summary: { value: 2 },
        value: { value: 2 },
      },
      status: "completed",
    })).rejects.toThrow("Output digest");
    await store.releaseClaim(fence);
  });

  test("publishes only verified terminal summaries and immutable outputs", async () => {
    const root = await temporaryDirectory();
    const store = new RunStore({ root });
    const input = fixture();
    const initialSummary = await store.create(input);
    const fence = await store.acquireClaim(input.runId, { owner: "writer" });
    const node = await completeFixtureNode(store, input, fence);
    const updatedAt = new Date(Date.parse(initialSummary.updatedAt) + 10_000).toISOString();
    const summary = {
      counts: {
        cancelled: 0,
        completed: 1,
        failed: 0,
        pending: 0,
        skipped: 0,
      },
      finishedAt: node.finishedAt!,
      graphPlanSha256: input.graphPlan.graphPlanSha256,
      outputs: { output: { value: 2 } },
      runId: input.runId,
      startedAt: node.startedAt!,
      status: "completed",
      updatedAt,
      version: RUN_STORE_VERSION,
    } as const;
    expect(store.writeSummary(fence, {
      ...summary,
      counts: { ...summary.counts, completed: 0, pending: 1 },
    })).rejects.toThrow("counts");
    await store.writeSummary(fence, summary);
    expect(await store.summary(input.runId)).toEqual(summary);
    expect(await store.outputs(input.runId)).toMatchObject({
      nodeOutputDigests: { snapshot: node.output!.digestSha256 },
      outputs: summary.outputs,
    });
    expect((await lstat(join(root, input.runId, "outputs.json"))).mode & 0o777).toBe(0o600);
    expect(store.writeSummary(fence, {
      ...summary,
      updatedAt: new Date(Date.parse(updatedAt) + 1).toISOString(),
    })).rejects.toThrow("immutable");
    await store.releaseClaim(fence);
  });

  test("appends plan-bound grants and monotonically ordered fenced events", async () => {
    const root = await temporaryDirectory();
    const store = new RunStore({ root });
    const input = fixture();
    await store.create(input);
    const fence = await store.acquireClaim(input.runId, { owner: "approver" });
    const grant = await store.appendGrant(fence, {
      createdAt: new Date().toISOString(),
      graphPlanSha256: input.graphPlan.graphPlanSha256,
      grantedBy: "approver",
      grantId: randomUUID(),
      kind: "graph-policy",
      scopes: ["local-read"],
    });
    expect(grant.version).toBe(RUN_GRANT_VERSION);
    expect(await store.grants(input.runId)).toEqual([grant]);
    await store.appendEvent(fence, {
      details: { status: "running" },
      kind: "run-status",
      timestamp: new Date().toISOString(),
    });
    expect((await store.events(input.runId)).map(event => event.sequence)).toEqual([1, 2]);
    await store.releaseClaim(fence);
  });

  test("refreshes a cached grant cursor after another store appends", async () => {
    const root = await temporaryDirectory();
    const firstStore = new RunStore({ root });
    const secondStore = new RunStore({ root });
    const input = fixture();
    await firstStore.create(input);
    const fence = await firstStore.acquireClaim(input.runId, { owner: "approver" });
    const firstGrant = {
      createdAt: new Date().toISOString(),
      graphPlanSha256: input.graphPlan.graphPlanSha256,
      grantedBy: "first",
      grantId: randomUUID(),
      kind: "graph-policy",
      scopes: ["local-read"] as string[],
    } as const;
    const secondGrant = {
      ...firstGrant,
      grantedBy: "second",
      grantId: randomUUID(),
    };
    await firstStore.appendGrant(fence, firstGrant);
    expect(firstStore.appendGrant(fence, firstGrant)).rejects.toThrow(
      "Run grant already exists",
    );
    await secondStore.appendGrant(fence, secondGrant);

    expect(firstStore.appendGrant(fence, secondGrant)).rejects.toThrow(
      "Run grant already exists",
    );
    expect(await firstStore.grants(input.runId)).toHaveLength(2);
    await secondStore.releaseClaim(fence);
  });

  test("binds trusted-compute replay grants to the exact node plan and next attempt", async () => {
    const root = await temporaryDirectory();
    const store = new RunStore({ root });
    const input = computeFixture();
    await store.create(input);
    const fence = await store.acquireClaim(input.runId, { owner: "compute-approver" });
    const interrupted = await interruptComputeNode(store, input, fence);
    const authored = input.graphPlan.graph.nodes[0]!;
    if (
      authored.executor.kind !== "compute"
      || interrupted.executionPlan === undefined
    ) {
      throw new Error("Expected an interrupted compute node with an execution plan.");
    }
    const nextAttempt = interrupted.attempt + 1;
    const exactGrant = {
      attempt: nextAttempt,
      bundleSha256: input.graphPlan.bundle.bundleSha256,
      computeKey: authored.executor.compute.key,
      createdAt: new Date().toISOString(),
      graphPlanSha256: input.graphPlan.graphPlanSha256,
      grantedBy: "compute-approver",
      grantId: randomUUID(),
      kind: "compute-replay",
      nodeKey: authored.key,
      nodePlanSha256: interrupted.executionPlan.nodePlanSha256,
    } as const;

    await expectRejection(
      store.reopenComputeNode(fence, authored.key),
      `attempt ${String(nextAttempt)}`,
    );
    await expectRejection(store.appendGrant(fence, {
      ...exactGrant,
      grantId: randomUUID(),
      nodePlanSha256: "8".repeat(64),
    }), "exact next attempt");
    await expectRejection(store.appendGrant(fence, {
      ...exactGrant,
      grantId: randomUUID(),
      nodeKey: "missing",
    }), "unknown node");
    await expectRejection(store.appendGrant(fence, {
      ...exactGrant,
      attempt: nextAttempt + 1,
      grantId: randomUUID(),
    }), "exact next attempt");
    await expectRejection(store.appendGrant(fence, {
      ...exactGrant,
      computeKey: "test.wrong-compute",
      grantId: randomUUID(),
    }), "exact next attempt");
    await expectRejection(store.appendGrant(fence, {
      ...exactGrant,
      bundleSha256: "9".repeat(64),
      grantId: randomUUID(),
    }), "different bundle");

    const persistedGrant = await store.appendGrant(fence, exactGrant);
    expect(persistedGrant).toMatchObject({
      attempt: 2,
      computeKey: authored.executor.compute.key,
      nodeKey: authored.key,
      nodePlanSha256: interrupted.executionPlan.nodePlanSha256,
    });
    const reopened = await store.reopenComputeNode(fence, authored.key);
    expect(reopened).toMatchObject({
      attempt: 1,
      executionPlan: { nodePlanSha256: interrupted.executionPlan.nodePlanSha256 },
      nodeKey: authored.key,
      status: "ready",
    });
    expect(reopened.failure).toBeUndefined();
    expect(reopened.finishedAt).toBeUndefined();

    const interruptedAgain = await interruptComputeNode(store, input, fence);
    expect(interruptedAgain).toMatchObject({ attempt: 2, status: "ambiguous-code" });
    await expectRejection(
      store.reopenComputeNode(fence, authored.key),
      "attempt 3",
    );
    await expectRejection(store.appendGrant(fence, {
      ...exactGrant,
      grantId: randomUUID(),
    }), "exact next attempt");

    const thirdAttemptGrant = await store.appendGrant(fence, {
      ...exactGrant,
      attempt: 3,
      grantId: randomUUID(),
    });
    expect(thirdAttemptGrant).toMatchObject({ attempt: 3 });
    expect(await store.reopenComputeNode(fence, authored.key)).toMatchObject({
      attempt: 2,
      status: "ready",
    });
    expect((await store.grants(input.runId)).filter(grant => grant.kind === "compute-replay"))
      .toHaveLength(2);
    await store.releaseClaim(fence);
  });

  test("rejects unsafe directory ownership and substituted node directories", async () => {
    const root = await temporaryDirectory();
    await chmod(root, 0o755);
    expect(new RunStore({ root }).create(fixture())).rejects.toThrow("0700");
    await chmod(root, 0o700);

    const store = new RunStore({ root });
    const input = fixture();
    await store.create(input);
    const nodes = join(root, input.runId, "nodes");
    const displaced = join(root, input.runId, "nodes-displaced");
    await rename(nodes, displaced);
    await symlink(displaced, nodes);
    expect(store.nodes(input.runId)).rejects.toThrow("physical 0700");
  });

  test("rejects a symbolic-link component before creating a run root", async () => {
    const base = await temporaryDirectory();
    const physical = await temporaryDirectory();
    const linked = join(base, "linked");
    await symlink(physical, linked);
    expect(new RunStore({ root: join(linked, "runs") }).create(fixture()))
      .rejects.toThrow("non-physical directory component");
  });
});
