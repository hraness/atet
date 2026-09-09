import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplicationOperationRegistry } from "../application/default-registry";
import { SpatialProjectSnapshotOutputSchema } from "../application/operations/spatial-project";
import { createOperationProjectFixture, operationApplicationContext } from "../application/operations/test-support";
import { withSpatialProjectLease } from "../application/spatial-project-lease";
import { canonicalJson } from "../core/canonical-json";
import { parseCliArgs } from "./args";
import { commitProjectStateTransaction, recoverProjectStateTransaction } from "./project-state-transaction";
import { executeSpatialProjectCommand } from "./spatial-project-service";
import { bindSpatialCliExecutionProfile, executeSpatialSceneCommand, readSpatialJson } from "./spatial-scene-service";

async function fixture<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "atet-scene-cli-"));
  try { return await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("CLI hardware selection is closed and cannot replace retained request policy", () => {
  const profile = "three-webgl2-hardware-v1";
  const legacy = { cameraId: "camera_hero", mode: { kind: "beauty" } };
  expect(bindSpatialCliExecutionProfile(legacy, undefined)).toBe(legacy);
  expect(bindSpatialCliExecutionProfile(legacy, profile)).toEqual({ ...legacy, executionProfile: profile });
  expect(() => bindSpatialCliExecutionProfile({ ...legacy, executionProfile: "three-spark-webgl2-hardware-v1" }, profile)).toThrow("differs");
  for (const invalid of [null, [], 42]) expect(() => bindSpatialCliExecutionProfile(invalid, profile)).toThrow("JSON object");
  for (const action of ["plan", "render"]) {
    expect(parseCliArgs(["scene", action, "scene.json", "--request", "render.json", "--profile", profile])).toMatchObject({ executionProfile: profile });
    expect(() => parseCliArgs(["scene", action, "scene.json", "--request", "render.json", "--profile", "auto"])).toThrow("--profile requires");
  }
  expect(parseCliArgs(["scene", "project", "prepare-render", "project_fixture", "--input", "prepare.json", "--output", "render.json", "--profile", profile])).toMatchObject({ executionProfile: profile });
});

test("CLI prepared composition requires explicit delivery files", () => {
  expect(parseCliArgs(["scene", "project", "prepare-render", "project_fixture", "--input", "prepare.json", "--output", "prepared.json", "--json"])).toEqual({ kind: "spatial-project", action: "prepare-render", project: "project_fixture", input: "prepare.json", output: "prepared.json", json: true });
  expect(() => parseCliArgs(["scene", "project", "prepare-render", "project_fixture", "--input", "prepare.json"])).toThrow("requires --input and --output");
});

test.skipIf(process.platform === "win32")("scene JSON rejects a FIFO without waiting for a writer", async () => await fixture(async root => {
  const path = join(root, "blocked.json");
  const result = Bun.spawnSync(["mkfifo", path]);
  expect(result.exitCode).toBe(0);
  await expect(readSpatialJson(path)).rejects.toThrow("regular JSON file");
}));

test("CLI scene source workflow retains the old source and prevents accidental overwrite", async () => await fixture(async root => {
  const application = operationApplicationContext(root);
  const init = parseCliArgs(["scene", "init", "source.json", "--json"]);
  if (init.kind !== "spatial-scene") throw new Error("Wrong command");
  await executeSpatialSceneCommand(application, init);
  const original = await readFile(join(root, "source.json"), "utf8");
  await expect(executeSpatialSceneCommand(application, init)).rejects.toThrow("exists");
  const inspect = parseCliArgs(["scene", "inspect", "source.json", "--json"]);
  if (inspect.kind !== "spatial-scene") throw new Error("Wrong command");
  const report = await executeSpatialSceneCommand(application, inspect) as { readonly sceneSha256: string };
  await writeFile(join(root, "patch.json"), JSON.stringify({ kind: "atet.spatial-scene-patch", schemaVersion: 1, expectedSceneSha256: report.sceneSha256, operations: [{ kind: "rename-entity", entityId: "entity_product", name: "New name" }] }));
  const patch = parseCliArgs(["scene", "patch", "source.json", "--patch", "patch.json", "--output", "edited.json"]);
  if (patch.kind !== "spatial-scene") throw new Error("Wrong command");
  await executeSpatialSceneCommand(application, patch);
  expect(await readFile(join(root, "source.json"), "utf8")).toBe(original);
  expect(await readFile(join(root, "edited.json"), "utf8")).toContain("New name");
  expect(() => parseCliArgs(["scene", "evaluate", "source.json", "--camera", "camera_hero", "--time-us", "NaN"])).toThrow();
}));

test("CLI V2 migration uses one real lease and makes legacy journals incapable of restoring V1", async () => await fixture(async root => {
  const f = await createOperationProjectFixture(root);
  const application = operationApplicationContext(root);
  const project = f.project.projectId;
  await commitProjectStateTransaction({ fileSystem: f.fileSystem, before: { project: f.project, plan: f.plan }, after: { project: f.project, plan: f.plan }, transactionId: `transaction_${"2".repeat(32)}` });
  const settledJournal = JSON.parse(await f.fileSystem.readText("state/project-transaction.json")) as Record<string, unknown>;
  const before = SpatialProjectSnapshotOutputSchema.parse(await executeSpatialProjectCommand(application, { kind: "spatial-project", action: "snapshot", project, json: true }));
  await writeFile(join(root, "migrate.json"), JSON.stringify({ expected: before.basis, transactionId: `transaction_${"1".repeat(32)}`, scenes: [], shots: [] }));
  const migrated = await executeSpatialProjectCommand(application, { kind: "spatial-project", action: "migrate", project, input: "migrate.json", json: true }) as { readonly kind: string };
  expect(migrated.kind).toBe("completed");
  const head = await f.fileSystem.readText("project.json");
  // A valid journal with real generation artifacts would restore V1 without
  // the version guard; this is stronger than a malformed-marker rejection.
  const { active: _active, ...pendingJournal } = settledJournal;
  await f.fileSystem.writeTextAtomic("state/project-transaction.json", canonicalJson({ ...pendingJournal, phase: "prepare" }));
  await expect(recoverProjectStateTransaction(f.fileSystem)).rejects.toThrow("spatial V2 authority");
  expect(await f.fileSystem.readText("project.json")).toBe(head);
  await f.fileSystem.writeTextAtomic("edits/current.json", "obsolete and corrupt");
  const after = SpatialProjectSnapshotOutputSchema.parse(await executeSpatialProjectCommand(application, { kind: "spatial-project", action: "snapshot", project, json: true }));
  expect(after.version).toBe(2);
  expect(after.legacy).toEqual(before.legacy);
  const registry = createApplicationOperationRegistry();
  let expired: (() => Promise<void>) | undefined;
  await withSpatialProjectLease(application, project, async leased => {
    expired = leased.spatialProjectCustody!.assertHeld;
    await expect(withSpatialProjectLease(leased, project, async () => 0)).rejects.toThrow("nested");
    await registry.execute({ application: leased, abortSignal: new AbortController().signal }, { kind: "spatial.project.snapshot", version: 1, input: { project, expected: after.basis } });
  });
  await expect(expired!()).rejects.toThrow("ended");
}));
