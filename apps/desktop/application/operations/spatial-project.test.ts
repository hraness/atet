import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { parseSpatialScene, spatialSceneSha256 } from "../../../../src/spatial-scene/index";
import { SpatialCameraSchema, SpatialShotV1Schema } from "../../../../src/spatial-scene/contracts";
import { sha256Hex } from "../../core/canonical-json";
import { spatialProjectDocumentText, spatialShotSha256 } from "../../core/spatial-project";
import { hashProjectStructure } from "../../core/project-plan";
import { createNodeBundleFileSystem } from "../../core/storage";
import type { OperationExecutionContext } from "../operation";
import { hashProjectGeneration } from "../project-store";
import { editedPlan, syncedProject } from "../spatial-project-fixture.testing";
import { spatialProjectStorePorts } from "../spatial-project-authority";
import { commitSpatialProjectRevision } from "../spatial-project-store";
import {
  SpatialProjectAddShotInputSchema,
  SpatialProjectMigrateInputSchema,
  SpatialProjectPatchInputSchema,
  SpatialProjectRestoreInputSchema,
  SpatialProjectSnapshotInputSchema,
  spatialProjectAddCandidateOperationDefinition,
  spatialProjectAddShotOperationDefinition,
  spatialProjectMigrateOperationDefinition,
  spatialProjectPatchOperationDefinition,
  spatialProjectRestoreOperationDefinition,
  spatialProjectReconcileOperationDefinition,
  spatialProjectSelectCandidateOperationDefinition,
  spatialProjectSnapshotOperationDefinition,
} from "./spatial-project";
import { operationApplicationContext } from "./test-support";

const transaction = (number: number): string => `transaction_${number.toString(16).padStart(32, "0")}`;
const document = parseSpatialScene({
  kind: "atet.spatial-scene", schemaVersion: 1, sceneId: "scene_operation", coordinates: "right-handed-y-up-meters", durationUs: 10_000_000,
  entities: [], assets: [], animations: [], overrides: [], generators: [],
  cameras: [{ cameraId: "camera_main", name: "Main", pose: { position: [0, 0, 5], rotation: [0, 0, 0, 1] }, projection: { kind: "perspective", width: 640, height: 480, near: 0.1, far: 100, fx: 500, fy: 500, cx: 320, cy: 240 } }],
});
const sceneSha256 = spatialSceneSha256(document);
const shot = SpatialShotV1Schema.parse({ shotId: "shot_main", sceneSha256, cameraId: "camera_main", range: { startUs: 0, endUs: 5_000_000 }, sceneStartUs: 0, playback: "once", overrides: [] });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "atet-spatial-operation-"));
  const project = syncedProject();
  const plan = editedPlan(project);
  const application = operationApplicationContext(root);
  const directory = join(application.paths.projectRoot, project.projectId);
  const fs = createNodeBundleFileSystem(directory);
  await fs.writeTextAtomic("project.json", spatialProjectDocumentText(project));
  await fs.writeTextAtomic("edits/current.json", spatialProjectDocumentText(plan));
  let held = true;
  let unsettled = false;
  let assertions = 0;
  const context: OperationExecutionContext = {
    abortSignal: new AbortController().signal,
    application: { ...application, spatialProjectCustody: {
      projectDirectory: directory, projectId: project.projectId,
      assertHeld: async () => { assertions++; if (!held) throw new Error("publication lease expired"); },
      assertLegacyTransactionSettled: async () => { if (unsettled) throw new Error("legacy transaction unsettled"); },
    } },
  };
  return { root, fs, project, context, release: () => { held = false; }, unsettle: () => { unsettled = true; }, assertions: () => assertions, migrate: SpatialProjectMigrateInputSchema.parse({ project: project.projectId, expected: { version: 1, sha256: hashProjectGeneration(project, plan).generationSha256 }, transactionId: transaction(1), scenes: [{ document, sceneSha256 }], shots: [shot] }) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function withFixture(execute: (fixture: Fixture) => Promise<void>): Promise<void> {
  const value = await fixture();
  try { await execute(value); } finally { await rm(value.root, { recursive: true, force: true }); }
}
async function snapshot(f: Fixture) { return await spatialProjectSnapshotOperationDefinition.lifecycle.execute(f.context, { project: f.project.projectId }); }

test("spatial operation input contains no executable callback, path authority, or implicit retarget scope", () => {
  expect(() => SpatialProjectSnapshotInputSchema.parse({ project: "project_renderplan01" })).not.toThrow();
  expect(() => SpatialProjectSnapshotInputSchema.parse({ project: "../project_renderplan01" })).toThrow();
  expect(() => SpatialProjectSnapshotInputSchema.parse({ project: "project_renderplan01", projectDirectory: "/tmp" })).toThrow();
  expect(() => SpatialProjectPatchInputSchema.parse({ project: "project_renderplan01", change: "return project" })).toThrow();
  expect(() => SpatialProjectAddShotInputSchema.parse({ project: "project_renderplan01", shot })).toThrow();
});

test("bounded input capture rejects accessors without invoking them and retains JSON Schema projection", () => {
  let called = false;
  const input = Object.defineProperty({}, "project", { enumerable: true, get: () => { called = true; return "project_renderplan01"; } });
  expect(() => SpatialProjectSnapshotInputSchema.parse(input)).toThrow();
  expect(called).toBe(false);
  const schema = z.toJSONSchema(SpatialProjectSnapshotInputSchema);
  expect(schema.type).toBe("object");
  expect(schema.additionalProperties).toBe(false);
});

test("authority adapter rejects missing, mismatched and expired custody without acquiring a nested lock", async () => withFixture(async f => {
  const { spatialProjectCustody: _custody, ...without } = f.context.application;
  await expect(spatialProjectStorePorts(without, f.project.projectId)).rejects.toThrow("existing publication lease");
  await expect(spatialProjectStorePorts(f.context.application, "project_another01")).rejects.toThrow("does not match");
  f.release();
  await expect(snapshot(f)).rejects.toThrow("expired");
}));

test("snapshot captures V1 under caller custody, migration publishes checked V2 with identical legacy values", async () => withFixture(async f => {
  const before = await snapshot(f);
  expect(before.version).toBe(1);
  const migrated = await spatialProjectMigrateOperationDefinition.lifecycle.execute(f.context, f.migrate);
  expect(migrated.kind).toBe("completed");
  const after = await snapshot(f);
  expect(after.version).toBe(2);
  expect(after.legacy).toEqual(before.legacy);
  expect(after.scenes[0]!.sceneSha256).toBe(sceneSha256);
  expect(f.assertions()).toBeGreaterThan(4);
  f.unsettle();
  expect((await snapshot(f)).version).toBe(2);
}));

test("snapshot enforces optional exact basis without crossing the workflow publication boundary", async () => withFixture(async f => {
  let crossed = 0;
  const context: OperationExecutionContext = { ...f.context, workflow: { beforePublication: async () => { crossed++; }, nodeKey: "snapshot", nodePlanSha256: "a".repeat(64), runId: "run_snapshot", workspaceDirectory: f.root } };
  const output = await spatialProjectSnapshotOperationDefinition.lifecycle.execute(context, { project: f.project.projectId, expected: f.migrate.expected });
  expect(output.basis).toEqual(f.migrate.expected);
  await expect(spatialProjectSnapshotOperationDefinition.lifecycle.execute(context, { project: f.project.projectId, expected: { version: 1, sha256: "f".repeat(64) } })).rejects.toThrow("stale");
  expect(crossed).toBe(0);
}));

test("patch reports semantic diff only after completion and stale whole-project basis remains conflict", async () => withFixture(async f => {
  expect((await spatialProjectMigrateOperationDefinition.lifecycle.execute(f.context, f.migrate)).kind).toBe("completed");
  const current = await snapshot(f);
  const input = SpatialProjectPatchInputSchema.parse({ project: f.project.projectId, expected: current.basis, transactionId: transaction(2), patch: { kind: "atet.spatial-scene-patch", schemaVersion: 1, expectedSceneSha256: sceneSha256, operations: [{ kind: "set-camera", camera: { ...document.cameras[0], name: "Directed camera" } }] }, retarget: { kind: "all" } });
  const result = await spatialProjectPatchOperationDefinition.lifecycle.execute(f.context, input);
  expect(result.kind).toBe("completed");
  if (result.kind === "completed") expect(result.diff?.affectedShotIds).toEqual(["shot_main"]);
  const stale = await spatialProjectPatchOperationDefinition.lifecycle.execute(f.context, { ...input, transactionId: transaction(3) });
  expect(stale.kind).toBe("conflict");
  expect("diff" in stale).toBe(false);
}));

test("add-shot binds existing immutable source and rejects duplicate identity without head replacement", async () => withFixture(async f => {
  expect((await spatialProjectMigrateOperationDefinition.lifecycle.execute(f.context, f.migrate)).kind).toBe("completed");
  const before = await snapshot(f);
  const input = SpatialProjectAddShotInputSchema.parse({ project: f.project.projectId, expected: before.basis, transactionId: transaction(2), shot: { ...shot, shotId: "shot_other" } });
  expect((await spatialProjectAddShotOperationDefinition.lifecycle.execute(f.context, input)).kind).toBe("completed");
  const current = await snapshot(f);
  expect(current.shots).toHaveLength(2);
  const duplicate = await spatialProjectAddShotOperationDefinition.lifecycle.execute(f.context, { ...input, expected: current.basis, transactionId: transaction(3) });
  expect(duplicate.kind).toBe("precommit");
  expect((await snapshot(f)).basis).toEqual(current.basis);
}));

test("candidate registration verifies exact bytes and selection is a separate source-bound mutation", async () => withFixture(async f => {
  expect((await spatialProjectMigrateOperationDefinition.lifecycle.execute(f.context, f.migrate)).kind).toBe("completed");
  const before = await snapshot(f);
  const contents = "fixture media";
  const digest = sha256Hex(contents);
  const path = `spatial/outputs/${digest}.png`;
  await f.fs.writeTextNoReplace!(path, contents);
  const candidate = { candidateId: "candidate_preview", derivation: { shotId: shot.shotId, shotSha256: spatialShotSha256(shot), sceneSha256, recipeSha256: "a".repeat(64) }, outputs: [{ path, bytes: contents.length, sha256: digest }] };
  expect((await spatialProjectAddCandidateOperationDefinition.lifecycle.execute(f.context, { project: f.project.projectId, expected: before.basis, transactionId: transaction(2), candidate })).kind).toBe("completed");
  const registered = await snapshot(f);
  expect(registered.selections).toHaveLength(0);
  expect((await spatialProjectSelectCandidateOperationDefinition.lifecycle.execute(f.context, { project: f.project.projectId, expected: registered.basis, transactionId: transaction(3), candidateId: candidate.candidateId })).kind).toBe("completed");
  expect((await snapshot(f)).selections).toEqual([{ shotId: "shot_main", candidateId: "candidate_preview", status: "current" }]);
}));

test("explicit reconcile returns an immutable completion proof without changing authority", async () => withFixture(async f => {
  const first = await spatialProjectMigrateOperationDefinition.lifecycle.execute(f.context, f.migrate);
  if (first.kind !== "completed") throw new Error("Migration fixture failed.");
  const before = await f.fs.readText("project.json");
  const result = await spatialProjectReconcileOperationDefinition.lifecycle.execute(f.context, { project: f.project.projectId, attempt: first.attempt });
  expect(result.kind).toBe("completed");
  if (result.kind === "completed") expect(spatialProjectReconcileOperationDefinition.receiptReference?.(result)).toBe(result.settlement.path);
  expect(spatialProjectReconcileOperationDefinition.receiptReference?.({ projectId: f.project.projectId, kind: "ambiguous", attempt: first.attempt, message: "uncertain" })).toBeUndefined();
  expect(await f.fs.readText("project.json")).toBe(before);
  expect(spatialProjectReconcileOperationDefinition.policy.resume).toBe("ambiguous-after-dispatch");
}));

test("restore requires explicit source, target and scope and captures hostile descriptors before validation", () => {
  const request = { project: "project_renderplan01", expected: { version: 2, sha256: "a".repeat(64) }, transactionId: transaction(9), expectedSceneSha256: "b".repeat(64), restoreSceneSha256: "c".repeat(64), retarget: { kind: "all" } };
  expect(spatialProjectDocumentText(SpatialProjectRestoreInputSchema.parse(request))).toBe(spatialProjectDocumentText(request));
  const { retarget: _retarget, ...missingScope } = request;
  expect(() => SpatialProjectRestoreInputSchema.parse(missingScope)).toThrow();
  let calls = 0;
  expect(() => SpatialProjectRestoreInputSchema.parse({ ...request, get restoreSceneSha256() { calls++; return "c".repeat(64); } })).toThrow();
  expect(calls).toBe(0);
});

test("one-shot then all-shot restore preserves current media and retained history and restores selected-candidate validity", async () => withFixture(async f => {
  await spatialProjectMigrateOperationDefinition.lifecycle.execute(f.context, { ...f.migrate, shots: [shot, { ...shot, shotId: "shot_other" }] });
  const original = await snapshot(f), bytes = "retained candidate payload", digest = sha256Hex(bytes), path = `spatial/outputs/${digest}.png`;
  await f.fs.writeTextNoReplace!(path, bytes);
  const candidate = { candidateId: "candidate_restore", derivation: { shotId: shot.shotId, shotSha256: spatialShotSha256(shot), sceneSha256, recipeSha256: "a".repeat(64) }, outputs: [{ path, bytes: bytes.length, sha256: digest }] };
  await spatialProjectAddCandidateOperationDefinition.lifecycle.execute(f.context, { project: f.project.projectId, expected: original.basis, transactionId: transaction(2), candidate });
  await spatialProjectSelectCandidateOperationDefinition.lifecycle.execute(f.context, { project: f.project.projectId, expected: (await snapshot(f)).basis, transactionId: transaction(3), candidateId: candidate.candidateId });
  await spatialProjectPatchOperationDefinition.lifecycle.execute(f.context, { project: f.project.projectId, expected: (await snapshot(f)).basis, transactionId: transaction(4),
    patch: { kind: "atet.spatial-scene-patch", schemaVersion: 1, expectedSceneSha256: sceneSha256, operations: [{ kind: "set-camera", camera: SpatialCameraSchema.parse({ ...document.cameras[0]!, name: "Changed camera" }) }] }, retarget: { kind: "all" } });
  const changed = await snapshot(f), changedDigest = changed.shots[0]!.sceneSha256;
  expect(changed.selections[0]!.status).toBe("stale");
  const restored = await spatialProjectRestoreOperationDefinition.lifecycle.execute(f.context, { project: f.project.projectId, expected: changed.basis, transactionId: transaction(5), expectedSceneSha256: changedDigest, restoreSceneSha256: sceneSha256, retarget: { kind: "shots", shotIds: [shot.shotId] } });
  expect(restored.kind).toBe("completed");
  if (restored.kind !== "completed") throw new Error("Restore fixture failed");
  expect(restored.diff).toEqual({ beforeSceneSha256: changedDigest, afterSceneSha256: sceneSha256, affectedShotIds: [shot.shotId], untouchedShotIds: ["shot_other"], selectedCandidates: [{ shotId: shot.shotId, candidateId: candidate.candidateId, status: "current" }] });
  expect(spatialProjectRestoreOperationDefinition.receiptReference?.(restored)).toBe(restored.settlement.path);
  const one = await snapshot(f);
  expect(one.shots.find(value => value.shotId === "shot_other")!.sceneSha256).toBe(changedDigest);
  expect(one.legacy).toEqual(original.legacy);
  expect(one.scenes).toEqual(changed.scenes);
  expect(one.candidates).toEqual(changed.candidates);
  const all = await spatialProjectRestoreOperationDefinition.lifecycle.execute(f.context, { project: f.project.projectId, expected: one.basis, transactionId: transaction(6), expectedSceneSha256: changedDigest, restoreSceneSha256: sceneSha256, retarget: { kind: "all" } });
  expect(all.kind).toBe("completed");
  if (all.kind === "completed") expect(all.diff?.affectedShotIds).toEqual(["shot_other"]);
  const final = await snapshot(f);
  expect(final.shots.every(value => value.sceneSha256 === sceneSha256)).toBe(true);
  expect(final.scenes).toHaveLength(2);
  expect(final.basis).not.toEqual(original.basis);
  expect(final.legacy).toEqual(original.legacy);
}));

test("restore conflicts with a concurrent audio revision and invalid sources never replace the head", async () => withFixture(async f => {
  await spatialProjectMigrateOperationDefinition.lifecycle.execute(f.context, f.migrate);
  const original = await snapshot(f);
  await spatialProjectPatchOperationDefinition.lifecycle.execute(f.context, { project: f.project.projectId, expected: original.basis, transactionId: transaction(2),
    patch: { kind: "atet.spatial-scene-patch", schemaVersion: 1, expectedSceneSha256: sceneSha256, operations: [{ kind: "set-camera", camera: SpatialCameraSchema.parse({ ...document.cameras[0]!, name: "Changed camera" }) }] }, retarget: { kind: "all" } });
  const before = await snapshot(f), ports = await spatialProjectStorePorts(f.context.application, f.project.projectId);
  const audio = await commitSpatialProjectRevision({ ports, expected: before.basis, transactionId: transaction(3), change: current => {
    const project = { ...current.contents.legacy.project, placements: current.contents.legacy.project.placements.map(placement => ({ ...placement,
      audio: placement.audio.map(stream => ({ ...stream, presentation: stream.presentation.enabled ? { ...stream.presentation, gainDb: -12 } : stream.presentation })),
    })) };
    return { ...current.contents, legacy: { project, projectEditPlan: { ...current.contents.legacy.projectEditPlan, projectStructureSha256: hashProjectStructure(project) } } };
  } });
  expect(audio.kind).toBe("completed");
  const head = await f.fs.readText("project.json"), restore = { project: f.project.projectId, expected: before.basis, transactionId: transaction(4), expectedSceneSha256: before.shots[0]!.sceneSha256, restoreSceneSha256: sceneSha256, retarget: { kind: "all" as const } };
  const stale = await spatialProjectRestoreOperationDefinition.lifecycle.execute(f.context, restore);
  expect(stale.kind).toBe("conflict"); expect("diff" in stale).toBe(false);
  expect(await f.fs.readText("project.json")).toBe(head);
  const current = await snapshot(f);
  for (const invalid of [{ restoreSceneSha256: "f".repeat(64) }, { expectedSceneSha256: sceneSha256 }, { retarget: { kind: "shots" as const, shotIds: ["shot_absent"] } }]) {
    const result = await spatialProjectRestoreOperationDefinition.lifecycle.execute(f.context, { ...restore, expected: current.basis, transactionId: transaction(5), ...invalid });
    expect(result.kind).toBe("precommit"); expect("diff" in result).toBe(false);
    expect(await f.fs.readText("project.json")).toBe(head);
  }
}));
