import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { HostResourceCoordinator } from "@hraness/atet/host-resources";

import { parseSpatialScene, spatialSceneSha256 } from "../../../src/spatial-scene/index";
import { createApplicationOperationRegistry } from "../application/default-registry";
import { OperationRegistry } from "../application/registry";
import { operationApplicationContext, createOperationProjectFixture } from "../application/operations/test-support";
import {
  SpatialProjectMutationOutputSchema, SpatialProjectSnapshotOutputSchema,
  spatialProjectMigrateOperationDefinition, spatialProjectSnapshotOperationDefinition,
  type SpatialProjectMutationOutput,
} from "../application/operations/spatial-project";
import { withSpatialProjectLease } from "../application/spatial-project-lease";
import { spatialProjectStorePorts } from "../application/spatial-project-authority";
import { migrateSpatialProject, readSpatialProjectAuthority } from "../application/spatial-project-store";
import { spatialProjectArtifact, spatialProjectDocumentText } from "../core/spatial-project";
import { SpatialProjectBasisSchema } from "../contracts/spatial-project";
import { createApplicationNodePlanner } from "./application-node-planner";
import { buildWorkflow, defineCompute, defineWorkflow } from "./define-workflow";
import { planBuiltInWorkflow } from "./planning";
import { compileGraphPlan } from "./compiler";
import { WorkflowBuilder } from "./semantic-builder";
import { isComputeGraphNode, isOperationGraphNode, type GraphPlanV1, type WorkflowOutputValue } from "./contracts";
import { RunStore } from "./run-store";
import { RUN_STORE_VERSION, RunNodeRecordSchema } from "./run-contracts";
import { DurableWorkflowScheduler, type DurableWorkflowSchedulerOptions } from "./scheduler";

setDefaultTimeout(20_000);
const transaction = (n: number) => `transaction_${n.toString(16).padStart(32, "0")}`;
const scene = {
  kind: "atet.spatial-scene", schemaVersion: 1, sceneId: "scene_graph", coordinates: "right-handed-y-up-meters", durationUs: 1_000_000,
  entities: [{ kind: "mesh", entityId: "entity_box", name: "Box", parentId: null, transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    placement: { kind: "world" }, origin: { kind: "authored" }, visible: true, geometry: { kind: "box", size: [1, 1, 1] }, material: { kind: "unlit", color: "#aa00ff", opacity: 1 } }],
  cameras: [{ cameraId: "camera_main", name: "Main", pose: { position: [0, 0, 5], rotation: [0, 0, 0, 1] }, projection: { kind: "perspective", width: 640, height: 480, fx: 500, fy: 500, cx: 320, cy: 240, near: 0.1, far: 100 } }],
  assets: [], animations: [], overrides: [], generators: [],
} as const;
parseSpatialScene(scene);
const sceneSha256 = spatialSceneSha256(scene);
const shot = { shotId: "shot_graph", sceneSha256, cameraId: "camera_main", range: { startUs: 0, endUs: 1_000_000 }, sceneStartUs: 0, playback: "once", overrides: [] } as const;
const host: HostResourceCoordinator = {
  profile: { capacities: [], id: "spatial-integration" }, scope: "process",
  withLease: async (claims, execute) => await execute({ assertOwned: async () => {}, claims, inheritedFileDescriptor: 0, profile: host.profile, ticket: "spatial-integration" }),
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "atet-spatial-graph-"));
  const project = await createOperationProjectFixture(root);
  const application = operationApplicationContext(root);
  return { root, application, ...project };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function withFixture(execute: (value: Fixture) => Promise<void>) {
  const f = await fixture();
  try { await execute(f); } finally { await rm(f.root, { recursive: true, force: true }); }
}
async function plan(f: Fixture, registry: OperationRegistry, build: (builder: WorkflowBuilder) => WorkflowOutputValue) {
  const definition = defineWorkflow({ id: "spatial-integration", version: 1, inputSchemaId: "test.spatial-workflow-input/v1", inputSchema: z.strictObject({}), build });
  return await planBuiltInWorkflow({ application: f.application, applicationBuild: "spatial-integration", registry, workflowInput: {}, workflow: {
    ...definition, description: "Spatial integration test", title: "Spatial integration test",
    build: (discovery, input) => buildWorkflow(definition, discovery, input),
  } });
}
async function createRun(f: Fixture, registry: OperationRegistry, planned: { readonly plan: GraphPlanV1; readonly bundleBytes: Uint8Array }, runId: string) {
  const store = new RunStore({ root: join(f.root, "runs") });
  const graph = planned.plan.graph;
  await store.create({ graphPlan: planned.plan, bundleBytes: new Uint8Array(planned.bundleBytes), runId,
    runtime: { version: RUN_STORE_VERSION, runtime: planned.plan.runtime,
      operations: [...new Map(graph.nodes.filter(isOperationGraphNode).map(node => [`${node.executor.operation.kind}@${node.executor.operation.version}`, node.executor.operation])).values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.version - b.version),
      computes: [...new Map(graph.nodes.filter(isComputeGraphNode).map(node => [node.executor.compute.key, node.executor.compute])).values()].sort((a, b) => a.key.localeCompare(b.key)),
    }, sourceLocator: "spatial-integration.ts", workflow: { bundle: planned.plan.bundle, sourceLocator: "spatial-integration.ts", workflow: graph.workflow } });
  return { store, scheduler: (overrides: Partial<DurableWorkflowSchedulerOptions> = {}) => new DurableWorkflowScheduler({
    application: f.application, authorization: { authorizeEffect: async () => true, authorizePreparation: async () => true, grantedBy: "spatial-integration" },
    cancellationPollMs: 5, currentApplicationBuild: "spatial-integration", hostResourceCoordinator: host,
    hostLimits: { maxJobs: 2, maxWallClockMs: 15_000 }, nodePlanner: createApplicationNodePlanner(f.application), owner: "spatial-integration", registry, store, ...overrides,
  }) };
}

function migration(builder: WorkflowBuilder, project: Fixture["project"]["projectId"]) {
  const before = builder.spatialProject.snapshot("before", { project });
  const migrated = builder.spatialProject.migrate("migrate", { project, expected: before.select("basis"), transactionId: transaction(1), scenes: [{ document: scene, sceneSha256 }], shots: [shot] });
  return { before, migrated };
}

test("typed spatial workflow snapshots, migrates, patches, and reads its completed dependency basis", async () => withFixture(async f => {
  const registry = createApplicationOperationRegistry();
  const planned = await plan(f, registry, builder => {
    const { before, migrated } = migration(builder, f.project.projectId);
    const patched = builder.spatialProject.patch("patch", {
      project: f.project.projectId, expected: { version: 2, sha256: migrated.select("projectRevisionSha256") }, transactionId: transaction(2),
      patch: { kind: "atet.spatial-scene-patch", schemaVersion: 1, expectedSceneSha256: sceneSha256, operations: [{ kind: "set-color", entityId: "entity_box", color: "#00ff00" }] }, retarget: { kind: "all" },
    });
    const after = builder.spatialProject.snapshot("after", { project: f.project.projectId, expected: { version: 2, sha256: patched.select("projectRevisionSha256") } });
    return { before, migrated, patched, after };
  });
  expect(planned.plan.staticBindings.initialSubjects).toHaveLength(1);
  expect(planned.plan.staticBindings.initialSubjects[0]).toMatchObject({ kind: "spatial-project", schemaVersion: 2, id: f.project.projectId, basis: { version: 1 } });
  const run = await createRun(f, registry, planned, "run_spatial_chain");
  const result = await run.scheduler().run("run_spatial_chain");
  expect(result.summary.status).toBe("completed");
  const before = SpatialProjectSnapshotOutputSchema.parse((await run.store.node("run_spatial_chain", "before")).output?.value);
  const after = SpatialProjectSnapshotOutputSchema.parse((await run.store.node("run_spatial_chain", "after")).output?.value);
  const patch = SpatialProjectMutationOutputSchema.parse((await run.store.node("run_spatial_chain", "patch")).output?.value);
  expect(before.version).toBe(1);
  expect(after.version).toBe(2);
  expect(after.legacy).toEqual(before.legacy);
  expect(patch.kind).toBe("completed");
  if (patch.kind !== "completed") throw new Error("Expected completed patch.");
  expect(after.basis).toEqual({ version: 2, sha256: patch.projectRevisionSha256 });
  expect(patch.diff?.affectedShotIds).toEqual([shot.shotId]);
  const updated = after.scenes.find(source => source.sceneSha256 === after.shots[0]?.sceneSha256);
  expect(updated?.document.entities[0]).toMatchObject({ material: { color: "#00ff00" } });
  expect((await run.store.node("run_spatial_chain", "after")).executionPlan?.exactInput).toMatchObject({ expected: after.basis });
  expect((await run.store.node("run_spatial_chain", "patch")).output?.receiptReference).toBe(patch.settlement.path);
}));

test("plan-time spatial snapshot rejects a later project generation without mutation", async () => withFixture(async f => {
  const registry = createApplicationOperationRegistry();
  const planned = await plan(f, registry, builder => ({ current: builder.spatialProject.snapshot("current", { project: f.project.projectId }) }));
  await withSpatialProjectLease(f.application, f.project.projectId, async application => {
    const ports = await spatialProjectStorePorts(application, f.project.projectId);
    const before = await readSpatialProjectAuthority(ports);
    expect((await migrateSpatialProject({ ports, expected: before.basis, transactionId: transaction(3), scenes: [], shots: [] })).kind).toBe("completed");
  }, undefined, "mutation");
  const head = await f.fileSystem.readText("project.json");
  const run = await createRun(f, registry, planned, "run_spatial_stale");
  await run.scheduler().run("run_spatial_stale");
  expect(await run.store.node("run_spatial_stale", "current")).toMatchObject({ status: "failed", failure: { code: "conflict" } });
  expect(await f.fileSystem.readText("project.json")).toBe(head);
}));

test("a trusted compute cannot mint a new spatial project basis", async () => withFixture(async f => {
  const registry = createApplicationOperationRegistry();
  const baseline = await plan(f, registry, builder => ({ before: builder.spatialProject.snapshot("before", { project: f.project.projectId }) }));
  const builder = WorkflowBuilder.create(registry);
  const before = builder.spatialProject.snapshot("before", { project: f.project.projectId });
  const invented = { version: 2 as const, sha256: "f".repeat(64) };
  const compute = defineCompute({ key: "test.spatial-minted-basis", inputSchema: z.strictObject({}), inputSchemaId: "test.spatial-compute-input/v1", outputSchema: SpatialProjectBasisSchema,
    outputSchemaId: "test.spatial-compute-basis/v1", maxInputBytes: 1_024, maxOutputBytes: 1_024, maxDurationMs: 1_000, run: () => SpatialProjectBasisSchema.parse(invented) });
  const basis = builder.compute("invent", compute, {}, { after: [before] });
  const mutation = builder.spatialProject.migrate("mutation", { project: f.project.projectId, expected: basis, transactionId: transaction(4), scenes: [], shots: [] });
  const graph = builder.build(baseline.plan.graph.workflow, { before, mutation });
  const graphPlan = compileGraphPlan({ bundle: baseline.plan.bundle, graph, registry, runtime: baseline.plan.runtime, workflowInput: {}, staticBindings: baseline.plan.staticBindings });
  const run = await createRun(f, registry, { plan: graphPlan, bundleBytes: baseline.bundleBytes }, "run_spatial_minted");
  const head = await f.fileSystem.readText("project.json");
  await expect(run.scheduler({ compute: { kind: "fresh", executor: { bundleSha256: graphPlan.bundle.bundleSha256, execute: async () => invented } } }).run("run_spatial_minted")).rejects.toMatchObject({ code: "authorization-required" });
  expect((await run.store.node("run_spatial_minted", "invent")).status).toBe("completed");
  expect((await run.store.node("run_spatial_minted", "mutation")).startedAt).toBeUndefined();
  expect(await f.fileSystem.readText("project.json")).toBe(head);
}));

for (const kind of ["ambiguous", "precommit", "conflict"] as const) {
  test(`scheduler persists exact ${kind} attempt evidence even when cancellation arrives`, async () => withFixture(async f => {
    const registry = new OperationRegistry();
    const entered = deferred();
    const attempt = spatialProjectArtifact("attempts", spatialProjectDocumentText({ fixture: kind }));
    const disposition: SpatialProjectMutationOutput = { projectId: f.project.projectId, kind, attempt, message: `injected ${kind} after custody admission` };
    registry.register(spatialProjectSnapshotOperationDefinition);
    registry.register({ ...spatialProjectMigrateOperationDefinition, lifecycle: { kind: "project-transaction", execute: async context => {
      await context.workflow?.beforePublication();
      await new Promise<void>(resolve => {
        if (context.abortSignal.aborted) resolve();
        else context.abortSignal.addEventListener("abort", () => resolve(), { once: true });
        entered.resolve();
      });
      return disposition;
    } } });
    const planned = await plan(f, registry, builder => {
      const { before, migrated } = migration(builder, f.project.projectId);
      const after = builder.spatialProject.snapshot("after", { project: f.project.projectId, expected: { version: 2, sha256: migrated.select("projectRevisionSha256") } });
      return { before, migrated, after };
    });
    const runId = `run_spatial_${kind}`;
    const run = await createRun(f, registry, planned, runId);
    const running = run.scheduler().run(runId);
    await entered.promise;
    await run.store.requestCancellation(runId, "spatial cancellation fixture");
    await running;
    const persisted = RunNodeRecordSchema.parse(await run.store.node(runId, "migrate"));
    expect(persisted.status).toBe(kind === "ambiguous" ? "ambiguous" : "failed");
    expect(persisted.failure?.code).toBe(kind === "ambiguous" ? "ambiguous" : "conflict");
    expect(persisted.failure?.spatialPublication).toEqual(disposition);
    expect(persisted.output).toBeUndefined();
    expect((await run.store.node(runId, "after")).status).not.toBe("completed");
    const reopened = new RunStore({ root: join(f.root, "runs") });
    expect((await reopened.node(runId, "migrate")).failure?.spatialPublication).toEqual(disposition);
  }));
}
