import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluateSpatialScene } from "../../../src/spatial-scene/evaluate";
import { parseSpatialScene, spatialAssetClosureDigests } from "../../../src/spatial-scene/identity";
import { fixtureScene } from "../../../src/spatial-scene/test-fixture";
import { createSpatialOverlayBatch } from "../html-overlay/spatial";
import { canonicalJsonSha256 } from "../core/canonical-json";
import { withPreparedSpatialAssets } from "./spatial-assets";
import { SavedSpatialWorldImportInputSchema, importSavedSpatialWorld, SpatialWorldImportError } from "./spatial-world-import";
import { originalSpz, originalWorldCollider } from "./spatial-world-fixture.testing";

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
async function setup(collider = true, provider = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atet-world-import-test-"))); temporary.push(root);
  const sourceRoot = join(root, "source"), destinationRoot = join(root, "destination"); await mkdir(sourceRoot); await mkdir(destinationRoot);
  const put = async (path: string, bytes: Uint8Array) => { await writeFile(join(sourceRoot, path), bytes); return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }; };
  const splat = await put("world.spz", originalSpz().compressed);
  const proxy = collider ? await put("collider.glb", originalWorldCollider()) : undefined;
  const request = { display_name: "Original fixture", model: "marble-1.1", permission: { public: false }, world_prompt: { text_prompt: "Original synthetic world fixture", type: "text" } };
  const providerValue = { kind: "atet.world-labs-provenance", schemaVersion: 1, attemptId: "attempt-original", operationId: "operation-original", operationBinding: "dispatch", request, requestSha256: canonicalJsonSha256(request), responseSha256: "a".repeat(64), reservedCredits: 1580, settledCredits: 1580,
    world: { worldId: "saved-world", model: "marble-1.1", displayName: "Original fixture", semanticsMetadata: { groundPlaneOffset: null, metricScaleFactor: null } }, quality: "100k", assets: { splat: { ...splat, sourceUrlSha256: "b".repeat(64) }, collider: { ...proxy, sourceUrlSha256: "c".repeat(64) } }, reproducibility: "retained-assets-only", normalization: "caller-must-declare-and-verify", assetValidation: "retained-bytes-unvalidated", clientGenerationAttempts: 1, capabilityLosses: ["static-radiance-field", "no-object-semantics", "no-material-editability", "collider-is-approximate"] };
  const receipt = provider ? await put("provider.json", new TextEncoder().encode(JSON.stringify(providerValue))) : undefined;
  const input = { splat, ...(proxy === undefined ? {} : { collider: proxy }), identities: { assetId: "asset_world", ...(proxy === undefined ? {} : { colliderAssetId: "asset_collider" }), entityId: "entity_world", name: "Saved world" }, normalization: { metersPerUnit: 0.5, sourceUp: "z", sourceHandedness: "right", transform: { position: [2, 3, 4], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } }, provenance: { kind: provider ? "worldlabs-marble" : "saved", description: "Original synthetic world fixture", ...(receipt === undefined ? {} : { receipt, worldId: "saved-world" }) } };
  return { root, sourceRoot, destinationRoot, input, signal: new AbortController().signal };
}
describe("saved world import and exact source closure", () => {
  test("saved SPZ alone keeps absence of physics explicit", async () => {
    const fixture = await setup(false); const output = await importSavedSpatialWorld(fixture);
    expect(output.manifest.collider).toBeNull(); expect(output.manifest.capabilities.physics).toBe("unavailable"); expect(output.assets).toHaveLength(2);
    expect(output.entity.transform).toEqual(SavedSpatialWorldImportInputSchema.parse(fixture.input).normalization.transform);
    for (const asset of output.assets) expect(createHash("sha256").update(await readFile(join(fixture.destinationRoot, asset.payload.path))).digest("hex")).toBe(asset.payload.sha256);
  });
  test("retains collider and complete metadata after original source disappears", async () => {
    const fixture = await setup(true, true); const output = await importSavedSpatialWorld(fixture); expect(output.assets).toHaveLength(4);
    expect(output.manifest.collider?.role).toBe("approximate-collider"); expect(output.manifest.capabilities.physics).toBe("unvalidated");
    const scene = parseSpatialScene({ ...fixtureScene(), entities: [output.entity], assets: output.assets });
    expect(Object.keys(spatialAssetClosureDigests(scene.assets))).toHaveLength(4);
    await rm(fixture.sourceRoot, { recursive: true });
    const snapshot = evaluateSpatialScene(scene, { timeUs: 0, cameraId: "camera_main" });
    const result = await withPreparedSpatialAssets({ snapshots: [snapshot], assetRoot: fixture.destinationRoot, workspaceParent: fixture.destinationRoot }, { runner: { run: async () => { throw new Error("No native decoder is needed for retained SPZ admission."); } } }, fixture.signal, async prepared => {
      expect(prepared.sources).toHaveLength(4); expect(prepared.preparedAssets).toHaveLength(1);
      return createSpatialOverlayBatch({ snapshots: [snapshot], preparedAssets: prepared.preparedAssets, frameRate: { numerator: 30, denominator: 1 }, mode: { kind: "beauty" }, executionProfile: "three-spark-webgl2-hardware-v1" });
    });
    expect(result.authoring.libraries).toEqual(["@sparkjsdev/spark", "three", "three/addons/postprocessing/Pass.js"]);
    expect(result.authoring.html).toContain("await spark.update({scene:world,camera})");
    expect(result.authoring.html).toContain("camera.near=data.near;camera.far=data.far");
    expect(result.metadata.frames[0]?.objects).toHaveLength(1);
  });
  test("legacy dispatch and recovery receipts retain their exact bytes through offline import", async () => {
    for (const operationBinding of ["dispatch", "operator-recovery"] as const) {
      const fixture = await setup(true, true), receipt = fixture.input.provenance.receipt!;
      const value = JSON.parse(await readFile(join(fixture.sourceRoot, receipt.path), "utf8"));
      value.operationBinding = operationBinding;
      value.settledCredits = operationBinding === "dispatch" ? 1580 : null;
      if (operationBinding === "operator-recovery") value.worldResponseSha256 = "d".repeat(64);
      const bytes = Buffer.from(JSON.stringify(value));
      await writeFile(join(fixture.sourceRoot, receipt.path), bytes);
      fixture.input.provenance.receipt = { ...receipt, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      const output = await importSavedSpatialWorld(fixture);
      const metadata = output.assets.find(asset => asset.interpretation.kind === "metadata" && asset.interpretation.schema === "atet.world-labs-provenance")!;
      expect(await readFile(join(fixture.destinationRoot, metadata.payload.path))).toEqual(bytes);
      expect(metadata.payload.sha256).toBe(fixture.input.provenance.receipt.sha256);
      expect(output.manifest.provenance.kind).toBe("worldlabs-marble");
    }
  });
  test("idempotent import reuses exact immutable outputs", async () => {
    const fixture = await setup(); expect(await importSavedSpatialWorld(fixture)).toEqual(await importSavedSpatialWorld(fixture));
  });
  test("reserves retained manifest bytes before admitting the complete source closure", async () => {
    const fixture = await setup();
    const input = { ...fixture.input, splat: { ...fixture.input.splat, bytes: 128 * 1024 * 1024 }, collider: { ...fixture.input.collider!, bytes: 128 * 1024 * 1024 } };
    await expect(importSavedSpatialWorld({ ...fixture, input })).rejects.toThrow("including its retained manifest");
    expect(await readdir(fixture.destinationRoot)).toEqual([]);
  });
  test("retained provider metadata must still satisfy its complete schema and request digest before rendering", async () => {
    const fixture = await setup(true, true), output = await importSavedSpatialWorld(fixture);
    const metadata = output.assets.find(asset => asset.interpretation.kind === "metadata" && asset.interpretation.schema === "atet.world-labs-provenance")!;
    const value = JSON.parse(await readFile(join(fixture.destinationRoot, metadata.payload.path), "utf8")); value.request.world_prompt.text_prompt = "tampered retained request";
    const bytes = Buffer.from(JSON.stringify(value)); await writeFile(join(fixture.destinationRoot, metadata.payload.path), bytes);
    const assets = output.assets.map(asset => asset.assetId === metadata.assetId ? { ...asset, payload: { ...asset.payload, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } } : asset);
    const scene = parseSpatialScene({ ...fixtureScene(), entities: [output.entity], assets });
    let called = false;
    await expect(withPreparedSpatialAssets({ snapshots: [evaluateSpatialScene(scene, { timeUs: 0, cameraId: "camera_main" })], assetRoot: fixture.destinationRoot, workspaceParent: fixture.destinationRoot }, { runner: { run: async () => { throw new Error("Native work must not start for invalid provenance."); } } }, fixture.signal, async () => { called = true; })).rejects.toThrow("request digest");
    expect(called).toBe(false);
  });
  test("requires generated provenance and rejects cross-world or cross-asset receipts before publication", async () => {
    for (const field of ["world", "splat", "collider", "request"] as const) {
      const fixture = await setup(true, true), receipt = fixture.input.provenance.receipt!;
      const value = JSON.parse(await readFile(join(fixture.sourceRoot, receipt.path), "utf8"));
      if (field === "world") value.world.worldId = "different-world";
      else if (field === "request") value.request.world_prompt.text_prompt = "changed request";
      else value.assets[field].sha256 = "d".repeat(64);
      const bytes = Buffer.from(JSON.stringify(value)); await writeFile(join(fixture.sourceRoot, receipt.path), bytes);
      fixture.input.provenance.receipt = { ...receipt, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      await expect(importSavedSpatialWorld(fixture)).rejects.toThrow(); expect(await readdir(fixture.destinationRoot)).toEqual([]);
    }
    const fixture = await setup(true, true);
    expect(() => SavedSpatialWorldImportInputSchema.parse({ ...fixture.input, provenance: { kind: "worldlabs-marble", description: "missing evidence" } })).toThrow("requires");
  });
  test("captures hostile getters without evaluating them and rejects unpaired collider", async () => {
    const fixture = await setup(); let calls = 0;
    expect(() => SavedSpatialWorldImportInputSchema.parse({ ...fixture.input, get normalization() { calls++; return fixture.input.normalization; } })).toThrow(); expect(calls).toBe(0);
    expect(() => SavedSpatialWorldImportInputSchema.parse({ ...fixture.input, collider: undefined })).toThrow();
  });
  test("tampered, symlinked, and unsupported source files cause no publication", async () => {
    for (const kind of ["tamper", "symlink"] as const) {
      const fixture = await setup(false);
      if (kind === "tamper") await writeFile(join(fixture.sourceRoot, fixture.input.splat.path), "different");
      else { await rm(join(fixture.sourceRoot, fixture.input.splat.path)); await symlink("/dev/zero", join(fixture.sourceRoot, fixture.input.splat.path)); }
      await expect(importSavedSpatialWorld(fixture)).rejects.toThrow(); expect(await readdir(fixture.destinationRoot)).toEqual([]);
    }
  });
  test("failure after immutable publication retains exact evidence and clears private staging", async () => {
    const fixture = await setup(); let guards = 0;
    try { await importSavedSpatialWorld({ ...fixture, beforePublication: async () => { if (++guards === 3) throw new Error("custody lost"); } }); throw new Error("Expected publication failure"); }
    catch (error) {
      expect(error).toBeInstanceOf(SpatialWorldImportError);
      const retained = (error as SpatialWorldImportError).published; expect(retained).toHaveLength(1);
      expect(await readFile(join(fixture.destinationRoot, retained[0]!.path))).toEqual(originalSpz().compressed);
    }
    expect((await readdir(fixture.destinationRoot)).some(name => name.startsWith(".atet-world-import"))).toBe(false);
  });
});
