import { expect, test } from "bun:test";
import { link, mkdir, mkdtemp, open, rename, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import fc from "fast-check";

import { parseSpatialScene, spatialSceneSha256 } from "../../../src/spatial-scene/index";
import { SpatialShotV1Schema } from "../../../src/spatial-scene/contracts";
import { SpatialProjectHeadV2Schema, SpatialProjectSettlementV1Schema, type SpatialProjectSceneSource } from "../contracts/spatial-project";
import { VideoProjectV1Schema } from "../contracts/project";
import { canonicalJson, sha256Hex } from "../core/canonical-json";
import { compileProjectRenderPlan } from "../core/project-render-plan";
import { hashProjectStructure } from "../core/project-plan";
import { createNodeSpatialDurability } from "../core/spatial-durability";
import { addSpatialCandidate, applySpatialProjectScenePatch, selectSpatialCandidate, spatialProjectArtifact, spatialProjectDocumentText, spatialProjectRevisionSha256, spatialShotSha256 } from "../core/spatial-project";
import { createNodeBundleFileSystem, loadVideoProject, type BundleFileSystem } from "../core/storage";
import { editedPlan, syncedProject } from "./spatial-project-fixture.testing";
import { hashProjectGeneration } from "./project-store";
import { commitSpatialProjectRevision, loadSpatialProject, migrateSpatialProject, readSpatialProjectAuthority, reconcileSpatialProjectCommit, type SpatialProjectCommitResult, type SpatialProjectStorePorts } from "./spatial-project-store";

const transaction = (value: number) => `transaction_${value.toString(16).padStart(32, "0")}`;
const document = parseSpatialScene({
  kind: "slopcamera.spatial-scene", schemaVersion: 1, sceneId: "scene_example", coordinates: "right-handed-y-up-meters", durationUs: 10_000_000,
  entities: [{ entityId: "entity_cube", kind: "mesh", name: "Cube", parentId: null, transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, placement: { kind: "world" }, origin: { kind: "authored" }, visible: true, geometry: { kind: "box", size: [1, 1, 1] }, material: { kind: "unlit", color: "#ffffff", opacity: 1 } }],
  cameras: [{ cameraId: "camera_main", name: "Main", pose: { position: [0, 0, 5], rotation: [0, 0, 0, 1] }, projection: { kind: "perspective", width: 640, height: 480, near: 0.1, far: 100, fx: 500, fy: 500, cx: 320, cy: 240 } }],
  assets: [], animations: [], generators: [], overrides: [],
});
const sceneSha256 = spatialSceneSha256(document);
const source: SpatialProjectSceneSource = { sceneSha256, document: structuredClone(document) as SpatialProjectSceneSource["document"] };
const shots = ["shot_a", "shot_b"].map(shotId => SpatialShotV1Schema.parse({ shotId, sceneSha256, cameraId: "camera_main", range: { startUs: 0, endUs: 5_000_000 }, sceneStartUs: 0, playback: "once", overrides: [] }));
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "slopcamera-spatial-authority-"));
  const fs = createNodeBundleFileSystem(directory);
  const project = syncedProject();
  const plan = editedPlan(project);
  await fs.writeTextAtomic("project.json", spatialProjectDocumentText(project));
  await fs.writeTextAtomic("edits/current.json", spatialProjectDocumentText(plan));
  const ports: SpatialProjectStorePorts = { fileSystem: fs, durability: createNodeSpatialDurability(directory), custody: { assertHeld: async () => {}, assertLegacyTransactionSettled: async () => {} } };
  const expected = { version: 1 as const, sha256: hashProjectGeneration(project, plan).generationSha256 };
  const options = { ports, expected, transactionId: transaction(1), scenes: [source], shots };
  return { directory, fs, project, plan, ports, options };
}
async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const value = await fixture();
  try { await run(value); } finally { await rm(value.directory, { recursive: true, force: true }); }
}
function completed(result: SpatialProjectCommitResult) {
  if (result.kind !== "completed") throw new Error(JSON.stringify(result));
  return result;
}
function ambiguous(result: SpatialProjectCommitResult) {
  if (result.kind !== "ambiguous") throw new Error(JSON.stringify(result));
  return result;
}
function countHeadWrites(fs: BundleFileSystem) {
  let count = 0;
  return { count: () => count, fs: { ...fs,
    writeTextAtomic: async (path: string, text: string) => { if (path === "project.json") count++; await fs.writeTextAtomic(path, text); },
    writeTextAtomicGuarded: async (path: string, text: string, beforeReplace: () => Promise<void>) => await fs.writeTextAtomicGuarded!(path, text, async () => { await beforeReplace(); if (path === "project.json") count++; }),
  } };
}
async function edit(f: Fixture, id: number, name: string, all = true) {
  const current = await loadSpatialProject(f.fs);
  return await commitSpatialProjectRevision({ ports: f.ports, expected: current.basis, transactionId: transaction(id), change: value => applySpatialProjectScenePatch(value.contents, { kind: "slopcamera.spatial-scene-patch", schemaVersion: 1, expectedSceneSha256: value.contents.shots[0]!.sceneSha256, operations: [{ kind: "rename-entity", entityId: "entity_cube", name }] }, all ? { kind: "all" } : { kind: "shots", shotIds: ["shot_a"] }).contents });
}

test("V1 migration freezes exact media composition, independent audio, cuts, speed and identity", async () => withFixture(async f => {
  const before = await f.fs.readText("project.json");
  const beforePlan = await f.fs.readText("edits/current.json");
  const result = completed(await migrateSpatialProject(f.options));
  const current = await loadSpatialProject(f.fs);
  expect(current.basis).toEqual({ version: 2, sha256: result.projectRevisionSha256 });
  expect(spatialProjectDocumentText(current.contents.legacy.project)).toBe(before);
  expect(spatialProjectDocumentText(current.contents.legacy.projectEditPlan)).toBe(beforePlan);
  expect(compileProjectRenderPlan(current.contents.legacy.project, current.contents.legacy.projectEditPlan)).toEqual(compileProjectRenderPlan(f.project, f.plan));
  expect(await f.fs.readText("edits/current.json")).toBe(beforePlan);
  await expect(loadVideoProject(f.fs)).rejects.toThrow();
  expect(VideoProjectV1Schema.safeParse(JSON.parse(current.headText)).success).toBe(false);
}));

test("V2 never consults historical V1 plan or legacy transaction state", async () => withFixture(async f => {
  completed(await migrateSpatialProject(f.options));
  const before = await loadSpatialProject(f.fs);
  await f.fs.writeTextAtomic("edits/current.json", "corrupt obsolete plan");
  const ports = { ...f.ports, custody: { ...f.ports.custody, assertLegacyTransactionSettled: async () => { throw new Error("obsolete transaction state"); } } };
  expect(await readSpatialProjectAuthority(ports)).toEqual(before);
}));

test("migration requires settled V1 transaction and existing held publication custody", async () => withFixture(async f => {
  for (const method of ["assertHeld", "assertLegacyTransactionSettled"] as const) {
    const counter = countHeadWrites(f.fs);
    const ports = { ...f.ports, fileSystem: counter.fs, custody: { ...f.ports.custody, [method]: async () => { throw new Error("custody rejected"); } } };
    expect((await migrateSpatialProject({ ...f.options, ports })).kind).toBe("precommit");
    expect(counter.count()).toBe(0);
  }
}));

test("one-shot and all-shot retarget are explicit and retain prior immutable documents", async () => withFixture(async f => {
  completed(await migrateSpatialProject(f.options));
  const before = await loadSpatialProject(f.fs);
  completed(await edit(f, 2, "One", false));
  const one = await loadSpatialProject(f.fs);
  expect(one.contents.shots[0]!.sceneSha256).not.toBe(sceneSha256);
  expect(one.contents.shots[1]!.sceneSha256).toBe(sceneSha256);
  expect(JSON.parse(await f.fs.readText(before.head.revision.path))).toEqual(before.revision);
  const changed = applySpatialProjectScenePatch(one.contents, { kind: "slopcamera.spatial-scene-patch", schemaVersion: 1, expectedSceneSha256: sceneSha256, operations: [{ kind: "rename-entity", entityId: "entity_cube", name: "Remaining uses" }] }, { kind: "all" });
  expect(changed.diff.affectedShotIds).toEqual(["shot_b"]);
  expect(changed.diff.untouchedShotIds).toEqual(["shot_a"]);
  expect(changed.contents.scenes).toHaveLength(3);
  expect(() => applySpatialProjectScenePatch(one.contents, { kind: "slopcamera.spatial-scene-patch", schemaVersion: 1, expectedSceneSha256: sceneSha256, operations: [{ kind: "rename-entity", entityId: "entity_cube", name: "Invalid scope" }] }, { kind: "shots", shotIds: ["shot_a"] })).toThrow("exact source");
}));

test("scene patch cannot overwrite a concurrent media/audio project revision", async () => withFixture(async f => {
  completed(await migrateSpatialProject(f.options));
  const prior = await loadSpatialProject(f.fs);
  completed(await commitSpatialProjectRevision({ ports: f.ports, expected: prior.basis, transactionId: transaction(2), change: current => {
    const project = VideoProjectV1Schema.parse({ ...current.contents.legacy.project, placements: current.contents.legacy.project.placements.map((placement, index) => index === 0 ? { ...placement, audio: placement.audio.map(audio => ({ ...audio, presentation: { ...audio.presentation, gainDb: -6 } })) } : placement) });
    return { ...current.contents, legacy: { project, projectEditPlan: { ...current.contents.legacy.projectEditPlan, projectStructureSha256: hashProjectStructure(project) } } };
  } }));
  const stale = await commitSpatialProjectRevision({ ports: f.ports, expected: prior.basis, transactionId: transaction(3), change: current => current.contents });
  expect(stale.kind).toBe("conflict");
  expect((await loadSpatialProject(f.fs)).contents.shots[0]!.sceneSha256).toBe(sceneSha256);
}));

test("final CAS rechecks the whole V1 plan after attempt publication", async () => withFixture(async f => {
  const counter = countHeadWrites(f.fs);
  const fs: BundleFileSystem = { ...counter.fs, writeTextNoReplace: async (path, text) => {
    const result = await f.fs.writeTextNoReplace!(path, text);
    if (path.startsWith("spatial/attempts/")) await f.fs.writeTextAtomic("edits/current.json", spatialProjectDocumentText({ ...f.plan, baseSpeed: 1.5 }));
    return result;
  } };
  const result = await migrateSpatialProject({ ...f.options, ports: { ...f.ports, fileSystem: fs } });
  expect(result.kind).toBe("conflict");
  expect("attempt" in result && result.attempt).toBeDefined();
  expect(counter.count()).toBe(0);
}));

test("custody revocation or cancellation during final authority read prevents every head write", async () => {
  for (const mode of ["lease", "cancel"] as const) await withFixture(async f => {
    let reads = 0;
    let held = true;
    const controller = new AbortController();
    const counter = countHeadWrites(f.fs);
    const fs: BundleFileSystem = { ...counter.fs, readText: async path => {
      const text = await f.fs.readText(path);
      if (path === "edits/current.json" && ++reads === 2) {
        if (mode === "lease") held = false;
        else controller.abort();
      }
      return text;
    } };
    const ports = { ...f.ports, fileSystem: fs, custody: { ...f.ports.custody, assertHeld: async () => { if (!held) throw new Error("revoked during final read"); } } };
    const result = await migrateSpatialProject({ ...f.options, ports, signal: controller.signal });
    expect(result.kind).toBe("precommit");
    expect(counter.count()).toBe(0);
    expect(VideoProjectV1Schema.safeParse(JSON.parse(await f.fs.readText("project.json"))).success).toBe(true);
  });
});

test("native guarded replacement refuses revoked custody or cancellation after temporary file staging", async () => {
  for (const mode of ["lease", "cancel"] as const) await withFixture(async f => {
    let held = true;
    let dispatched = 0;
    let guardReached = 0;
    const controller = new AbortController();
    const before = await f.fs.readText("project.json");
    const fs: BundleFileSystem = { ...f.fs, writeTextAtomicGuarded: async (path, text, beforeReplace) => await f.fs.writeTextAtomicGuarded!(path, text, async () => {
      guardReached++;
      if (mode === "lease") held = false;
      else controller.abort();
      await beforeReplace();
      dispatched++;
    }) };
    const ports = { ...f.ports, fileSystem: fs, custody: { ...f.ports.custody, assertHeld: async () => { if (!held) throw new Error("revoked during native staging"); } } };
    const result = await migrateSpatialProject({ ...f.options, ports, signal: controller.signal });
    expect(result.kind).toBe("precommit");
    expect(guardReached).toBe(1);
    expect(dispatched).toBe(0);
    expect(await f.fs.readText("project.json")).toBe(before);
  });
});

test("unguarded filesystem adapters cannot publish a V2 head", async () => withFixture(async f => {
  const { writeTextAtomicGuarded: _guarded, ...fs } = f.fs;
  const result = await migrateSpatialProject({ ...f.options, ports: { ...f.ports, fileSystem: fs } });
  expect(result.kind).toBe("precommit");
  if (result.kind === "precommit") expect(result.message).toContain("guarded atomic-replace");
}));

test("structured resource bounds are checked before parsing or allocating source text", async () => withFixture(async f => {
  let read = false;
  const fs: BundleFileSystem = { ...f.fs, inspectFile: async () => ({ bytes: 32 * 1024 * 1024 + 1, sha256: "f".repeat(64) }), readText: async () => { read = true; throw new Error("unbounded read"); } };
  await expect(loadSpatialProject(fs)).rejects.toThrow("byte budget");
  expect(read).toBe(false);
}));

test("registered selected candidate becomes explicitly stale after source/camera edit", async () => withFixture(async f => {
  completed(await migrateSpatialProject(f.options));
  const current = await loadSpatialProject(f.fs);
  const bytes = "derived image fixture";
  const digest = sha256Hex(bytes);
  const path = `spatial/outputs/${digest}.png`;
  await f.fs.writeTextNoReplace!(path, bytes);
  const candidate = { candidateId: "candidate_a", derivation: { shotId: "shot_a", shotSha256: spatialShotSha256(current.contents.shots[0]), sceneSha256, recipeSha256: "f".repeat(64) }, outputs: [{ path, sha256: digest, bytes: bytes.length }] };
  completed(await commitSpatialProjectRevision({ ports: f.ports, expected: current.basis, transactionId: transaction(2), change: value => selectSpatialCandidate(addSpatialCandidate(value.contents, candidate), "candidate_a") }));
  const selected = await loadSpatialProject(f.fs);
  const patched = applySpatialProjectScenePatch(selected.contents, { kind: "slopcamera.spatial-scene-patch", schemaVersion: 1, expectedSceneSha256: sceneSha256, operations: [{ kind: "set-camera", camera: { ...document.cameras[0], pose: { position: [1, 0, 5], rotation: [0, 0, 0, 1] } } }] }, { kind: "shots", shotIds: ["shot_a"] });
  expect(patched.diff.selectedCandidates).toEqual([{ candidateId: "candidate_a", shotId: "shot_a", status: "stale" }]);
  expect(() => selectSpatialCandidate(patched.contents, "candidate_a")).toThrow("current");
  expect(patched.contents.selections).toEqual(selected.contents.selections);
  expect(() => addSpatialCandidate(current.contents, { ...candidate, outputs: [{ path: "project.json", sha256: digest, bytes: bytes.length }] })).toThrow();
}));

test("camera/asset closure and byte tampering fail before any head dispatch", async () => withFixture(async f => {
  const counter = countHeadWrites(f.fs);
  const ports = { ...f.ports, fileSystem: counter.fs };
  const invalid = await migrateSpatialProject({ ...f.options, ports, shots: [{ ...shots[0]!, cameraId: "camera_absent" }] });
  expect(invalid.kind).toBe("precommit");
  const image = parseSpatialScene({ ...document, assets: [{ assetId: "asset_picture", payload: { path: "images/picture.png", bytes: 7, sha256: sha256Hex("correct") }, interpretation: { kind: "image", width: 1, height: 1, colorSpace: "srgb", alpha: "opaque", mimeType: "image/png" }, dependencies: [], provenance: { source: "imported", description: "Explicit fixture" } }] });
  const digest = spatialSceneSha256(image);
  await f.fs.writeTextAtomic("images/picture.png", "corrupt");
  expect((await migrateSpatialProject({ ...f.options, ports, scenes: [{ document: structuredClone(image) as SpatialProjectSceneSource["document"], sceneSha256: digest }], shots: shots.map(shot => ({ ...shot, sceneSha256: digest })) })).kind).toBe("precommit");
  expect(counter.count()).toBe(0);
}));

test("no-replace link uncertainty is precommit; retry syncs identical existing artifacts", async () => withFixture(async f => {
  let injected = false;
  const fs: BundleFileSystem = { ...f.fs, writeTextNoReplace: async (path, text) => {
    if (injected || !path.startsWith("spatial/revisions/")) return await f.fs.writeTextNoReplace!(path, text);
    injected = true;
    const target = join(f.directory, path);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.injected`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await link(temporary, target);
    await unlink(temporary);
    throw new Error("lost link acknowledgement before ancestor fsync");
  } };
  expect((await migrateSpatialProject({ ...f.options, ports: { ...f.ports, fileSystem: fs } })).kind).toBe("precommit");
  expect((await readSpatialProjectAuthority(f.ports)).version).toBe(1);
  const synced: string[] = [];
  completed(await migrateSpatialProject({ ...f.options, ports: { ...f.ports, durability: { syncExactFile: async (path, expected) => { synced.push(path); await f.ports.durability.syncExactFile(path, expected); } } } }));
  expect(synced.some(path => path.startsWith("spatial/revisions/"))).toBe(true);
  expect(synced).toContain("project.json");
}));

test("exact-existing-file durability failure prevents head publication", async () => withFixture(async f => {
  const counter = countHeadWrites(f.fs);
  const ports = { ...f.ports, fileSystem: counter.fs, durability: { syncExactFile: async (path: string) => { if (path.startsWith("spatial/scenes/")) throw new Error("ancestor sync unavailable"); } } };
  expect((await migrateSpatialProject({ ...f.options, ports })).kind).toBe("precommit");
  expect(counter.count()).toBe(0);
}));

test("post-dispatch failure before rename stays ambiguous and is never replayed", async () => withFixture(async f => {
  const before = await f.fs.readText("project.json");
  const fs: BundleFileSystem = { ...f.fs, writeTextAtomicGuarded: async (_path, _text, beforeReplace) => { await beforeReplace(); throw new Error("write failed before rename"); } };
  const result = ambiguous(await migrateSpatialProject({ ...f.options, ports: { ...f.ports, fileSystem: fs } }));
  const counter = countHeadWrites(f.fs);
  expect((await reconcileSpatialProjectCommit({ ports: { ...f.ports, fileSystem: counter.fs }, attempt: result.attempt })).kind).toBe("ambiguous");
  expect(counter.count()).toBe(0);
  expect(await f.fs.readText("project.json")).toBe(before);
}));

test("real rename before ancestor sync requires exact-head durability reconciliation", async () => withFixture(async f => {
  const fs: BundleFileSystem = { ...f.fs, writeTextAtomicGuarded: async (path, text, beforeReplace) => {
    const temporary = join(f.directory, "head-fault.tmp");
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await beforeReplace();
    await rename(temporary, join(f.directory, path));
    throw new Error("lost rename acknowledgement before ancestor sync");
  } };
  const result = ambiguous(await migrateSpatialProject({ ...f.options, ports: { ...f.ports, fileSystem: fs } }));
  const blocked = { ...f.ports, durability: { syncExactFile: async () => { throw new Error("fsync unavailable"); } } };
  expect((await reconcileSpatialProjectCommit({ ports: blocked, attempt: result.attempt })).kind).toBe("ambiguous");
  const counter = countHeadWrites(f.fs);
  completed(await reconcileSpatialProjectCommit({ ports: { ...f.ports, fileSystem: counter.fs }, attempt: result.attempt }));
  expect(counter.count()).toBe(0);
}));

test("head readback failure and receipt publication failure retain resolvable attempt evidence", async () => {
  for (const mode of ["readback", "receipt"] as const) await withFixture(async f => {
    let dispatched = false;
    const fs: BundleFileSystem = { ...f.fs,
      writeTextAtomicGuarded: async (path, text, beforeReplace) => { await f.fs.writeTextAtomicGuarded!(path, text, beforeReplace); dispatched = true; },
      readText: async path => { if (mode === "readback" && dispatched && path === "project.json") throw new Error("readback unavailable"); return await f.fs.readText(path); },
      writeTextNoReplace: async (path, text) => { if (mode === "receipt" && path.startsWith("spatial/receipts/")) throw new Error("receipt unavailable"); return await f.fs.writeTextNoReplace!(path, text); },
    };
    const result = ambiguous(await migrateSpatialProject({ ...f.options, ports: { ...f.ports, fileSystem: fs } }));
    completed(await reconcileSpatialProjectCommit({ ports: f.ports, attempt: result.attempt }));
  });
});

test("cancellation before dispatch retains attempted artifacts without writing a head", async () => withFixture(async f => {
  const controller = new AbortController();
  const counter = countHeadWrites(f.fs);
  const fs: BundleFileSystem = { ...counter.fs, writeTextNoReplace: async (path, text) => { const result = await f.fs.writeTextNoReplace!(path, text); if (path.startsWith("spatial/attempts/")) controller.abort(); return result; } };
  const result = await migrateSpatialProject({ ...f.options, ports: { ...f.ports, fileSystem: fs }, signal: controller.signal });
  expect(result.kind).toBe("precommit");
  expect("attempt" in result && result.attempt).toBeDefined();
  expect(counter.count()).toBe(0);
}));

test("cancellation after dispatch drains publication and preserves completion evidence", async () => withFixture(async f => {
  const controller = new AbortController();
  const fs: BundleFileSystem = { ...f.fs, writeTextAtomicGuarded: async (path, text, beforeReplace) => {
    await f.fs.writeTextAtomicGuarded!(path, text, beforeReplace);
    controller.abort();
  } };
  const result = completed(await migrateSpatialProject({ ...f.options, ports: { ...f.ports, fileSystem: fs }, signal: controller.signal }));
  expect(controller.signal.aborted).toBe(true);
  completed(await reconcileSpatialProjectCommit({ ports: f.ports, attempt: result.attempt }));
}));

test("uncertain old attempt cannot overwrite later head; completed receipt can prove old commit", async () => {
  for (const receipt of [false, true]) await withFixture(async f => {
    const fs: BundleFileSystem = receipt ? f.fs : { ...f.fs, writeTextAtomicGuarded: async (path, text, beforeReplace) => { await f.fs.writeTextAtomicGuarded!(path, text, beforeReplace); throw new Error("acknowledgement lost"); } };
    const first = await migrateSpatialProject({ ...f.options, ports: { ...f.ports, fileSystem: fs } });
    const attempt = receipt ? completed(first).attempt : ambiguous(first).attempt;
    completed(await edit(f, 2, "Later head"));
    const later = await f.fs.readText("project.json");
    const counter = countHeadWrites(f.fs);
    const result = await reconcileSpatialProjectCommit({ ports: { ...f.ports, fileSystem: counter.fs }, attempt });
    expect(result.kind).toBe(receipt ? "completed" : "ambiguous");
    if (result.kind === "completed") expect(result.currentHeadMatches).toBe(false);
    expect(await f.fs.readText("project.json")).toBe(later);
    expect(counter.count()).toBe(0);
  });
});

test("source bytes, receipt bytes, attempt fields and hostile immutable paths fail closed", async () => {
  for (const mode of ["source", "receipt", "attempt", "path"] as const) await withFixture(async f => {
    const result = completed(await migrateSpatialProject(f.options));
    const current = await loadSpatialProject(f.fs);
    if (mode === "source") {
      await f.fs.writeTextAtomic(current.revision.scenes[0]!.artifact.path, "tampered source");
      await expect(loadSpatialProject(f.fs)).rejects.toThrow("integrity");
    } else if (mode === "receipt") {
      const text = spatialProjectDocumentText(SpatialProjectSettlementV1Schema.parse({ kind: "slopcamera.spatial-project-settlement", schemaVersion: 1, attempt: result.attempt, headSha256: sha256Hex(current.headText) }));
      await f.fs.writeTextAtomic(spatialProjectArtifact("receipts", text).path, "corrupt receipt");
    } else if (mode === "attempt") await f.fs.writeTextAtomic(result.attempt.path, "corrupt attempt");
    else {
      expect(() => SpatialProjectHeadV2Schema.parse({ ...current.head, revision: { ...current.head.revision, path: "../escape.json" } })).toThrow();
      return;
    }
    expect((await reconcileSpatialProjectCommit({ ports: f.ports, attempt: result.attempt })).kind).toBe("ambiguous");
  });
});

test("production file boundary rejects symlink leaf and ancestor paths", async () => withFixture(async f => {
  const data = "proof";
  await f.fs.writeTextAtomic("actual/proof.txt", data);
  await symlink(join(f.directory, "actual/proof.txt"), join(f.directory, "leaf.txt"));
  await symlink(join(f.directory, "actual"), join(f.directory, "redirected"));
  for (const path of ["leaf.txt", "redirected/proof.txt"]) {
    await expect(f.ports.durability.syncExactFile(path, { bytes: data.length, sha256: sha256Hex(data) })).rejects.toThrow();
    await expect(f.fs.readText(path)).rejects.toThrow();
  }
  await expect(f.ports.durability.syncExactFile("actual/proof.txt", { bytes: data.length, sha256: "0".repeat(64) })).rejects.toThrow("digest");
}));

test("unknown core values never invoke foreign getters during hashing, patching or candidate parsing", async () => withFixture(async f => {
  completed(await migrateSpatialProject(f.options));
  const current = await loadSpatialProject(f.fs);
  let invoked = false;
  const foreign = Object.defineProperty({}, "kind", { enumerable: true, get: () => { invoked = true; return "untrusted"; } });
  for (const action of [
    () => spatialShotSha256(foreign),
    () => spatialProjectRevisionSha256(foreign),
    () => spatialProjectDocumentText(foreign),
    () => applySpatialProjectScenePatch(current.contents, foreign, { kind: "all" }),
    () => addSpatialCandidate(current.contents, foreign),
  ]) expect(action).toThrow();
  expect(invoked).toBe(false);
}));

test("production identity envelope rejects a foreign legacy head, V2 head and attempt", async () => withFixture(async f => {
  const foreignPorts = { ...f.ports, projectId: "project_foreign01" };
  await expect(readSpatialProjectAuthority(foreignPorts)).rejects.toThrow("another project");
  const result = completed(await migrateSpatialProject(f.options));
  await expect(readSpatialProjectAuthority(foreignPorts)).rejects.toThrow("another project");
  const reconciled = await reconcileSpatialProjectCommit({ ports: foreignPorts, attempt: result.attempt });
  expect(reconciled.kind).toBe("ambiguous");
  if (reconciled.kind === "ambiguous") expect(reconciled.message).toContain("another project");
}));

test("retarget laws preserve frozen media and unselected shots for arbitrary directed names", async () => withFixture(async f => {
  completed(await migrateSpatialProject(f.options));
  const current = await loadSpatialProject(f.fs);
  fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 128 }), name => {
    const before = canonicalJson(current.contents);
    const result = applySpatialProjectScenePatch(current.contents, { kind: "slopcamera.spatial-scene-patch", schemaVersion: 1, expectedSceneSha256: sceneSha256, operations: [{ kind: "rename-entity", entityId: "entity_cube", name }] }, { kind: "shots", shotIds: ["shot_a"] });
    expect(canonicalJson(current.contents)).toBe(before);
    expect(result.contents.legacy).toEqual(current.contents.legacy);
    expect(result.contents.shots[1]).toEqual(current.contents.shots[1]);
    expect(result.diff.affectedShotIds).toEqual(["shot_a"]);
  }), { numRuns: 50 });
}));
