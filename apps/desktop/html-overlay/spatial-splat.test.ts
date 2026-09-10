import { describe, expect, test } from "bun:test";

import { evaluateSpatialScene } from "../../../src/spatial-scene/evaluate";
import { parseSpatialScene, spatialAssetClosureDigests } from "../../../src/spatial-scene/identity";
import { fixtureEntity, fixtureScene } from "../../../src/spatial-scene/test-fixture";
import { spatialSpzAllocationBounds } from "../contracts/spatial-world";
import { createSpatialOverlayBatch } from "./spatial";

function fixture() {
  const source = fixtureScene(), base = fixtureEntity();
  const { geometry: _geometry, material: _material, ...identity } = base as Extract<typeof base, { kind: "mesh" }>;
  const scene = parseSpatialScene({ ...source, entities: [{ ...identity, kind: "splat", assetId: "asset_splat" }], assets: [{ assetId: "asset_splat", payload: { path: "world.spz", sha256: "a".repeat(64), bytes: 100 }, interpretation: { kind: "splat", format: "spz", sourceUp: "z", metersPerUnit: 2 }, dependencies: [], provenance: { source: "imported", description: "Original fixture" } }] });
  const snapshot = evaluateSpatialScene(scene, { timeUs: 0, cameraId: "camera_main" });
  const prepared = { kind: "splat", assetId: "asset_splat", entityId: "entity_box", assetManifestSha256: spatialAssetClosureDigests(scene.assets).asset_splat,
    resource: { name: "world", urlPath: "world.spz", sha256: "a".repeat(64), bytes: 100, mediaType: "application/octet-stream" },
    facts: { kind: "slopcamera.spz-admission", schemaVersion: 1, version: 3, splats: 2, shDegree: 0, fractionalBits: 12, antialiased: false, decompressedBytes: 56, ...spatialSpzAllocationBounds(2, 100, 56) } };
  return { snapshots: [snapshot], preparedAssets: [prepared], frameRate: { numerator: 30, denominator: 1 }, mode: { kind: "beauty" }, executionProfile: "three-spark-webgl2-hardware-v1" };
}
describe("closed Three/Spark lowering", () => {
  test("requires explicit hardware capability and rejects splat AOV claims", () => {
    const input = fixture();
    const { executionProfile: _profile, ...absentProfile } = input;
    for (const request of [absentProfile, { ...input, executionProfile: "three-webgl2-hardware-v1" }]) expect(() => createSpatialOverlayBatch(request)).toThrow("explicit Three/Spark");
    for (const kind of ["object-id", "axial-depth"]) expect(() => createSpatialOverlayBatch({ ...input, mode: { kind, coverage: { kind: "opaque" } } })).toThrow("unsupported");
  });
  test("binds raw axes/units and exact nonmonotonic sample order without a collider surface", () => {
    const input = fixture(), snapshot = input.snapshots[0]!;
    const result = createSpatialOverlayBatch({ ...input, snapshots: [{ ...snapshot, timeUs: 500_000 }, snapshot, { ...snapshot, timeUs: 500_000 }] });
    const payload = JSON.parse(result.authoring.html.match(/const input=(.*);\nconst canvas/u)![1]!) as { frames: { timeUs: number; objects: { matrix: number[] }[] }[] };
    expect(payload.frames.map(frame => frame.timeUs)).toEqual([500_000, 0, 500_000]);
    expect(payload.frames[0]).toEqual(payload.frames[2]);
    const matrix = payload.frames[0]!.objects[0]!.matrix;
    expect(matrix[0]).toBe(2); expect(matrix[6]).toBeCloseTo(-2); expect(matrix[9]).toBeCloseTo(2);
    expect(result.authoring.html).toContain("enableLod:false"); expect(result.authoring.html).toContain("if(hasFrameSplats)await spark.update");
    expect(result.authoring.html).toContain("spark.lastSortTime=0");
    expect(result.metadata.splatProfile?.kernel).toEqual({ antialiased: false, preBlurAmount: 0.3, blurAmount: 0 });
    expect(result.authoring.html).not.toContain("requestAnimationFrame(");
  });
  test("rejects stale payload, forged allocation and unsupported world transforms", () => {
    const input = fixture(), prepared = input.preparedAssets[0]!, snapshot = input.snapshots[0]!;
    expect(() => createSpatialOverlayBatch({ ...input, preparedAssets: [{ ...prepared, resource: { ...prepared.resource, sha256: "b".repeat(64) } }] })).toThrow("exact source payload");
    expect(() => createSpatialOverlayBatch({ ...input, preparedAssets: [{ ...prepared, facts: { ...prepared.facts, gpuBytesBound: 1 } }] })).toThrow("allocation");
    expect(() => createSpatialOverlayBatch({ ...input, preparedAssets: [{ ...prepared, facts: { ...prepared.facts, antialiased: true } }] })).toThrow();
    const entity = snapshot.entities[0]!;
    expect(() => createSpatialOverlayBatch({ ...input, snapshots: [{ ...snapshot, entities: [{ ...entity, worldMatrix: [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }] }] })).toThrow("uniform");
  });
  test("includes full framebuffer allocation in the aggregate GPU bound", () => {
    const input = fixture(), prepared = input.preparedAssets[0]!, snapshot = input.snapshots[0]!;
    const count = 500_000, decompressedBytes = 16 + count * 20;
    // Splat storage + 16 B/pixel would pass, but the real beauty/depth/default
    // framebuffer attachments already exceed that accounting at this size.
    expect(() => createSpatialOverlayBatch({ ...input,
      preparedAssets: [{ ...prepared, facts: { ...prepared.facts, splats: count, decompressedBytes, ...spatialSpzAllocationBounds(count, prepared.resource.bytes, decompressedBytes) } }],
      snapshots: [{ ...snapshot, camera: { ...snapshot.camera, projection: { ...snapshot.camera.projection, width: 3000, height: 2000 } } }],
    })).toThrow("aggregate splat/GPU/host");
  });
  test("metadata is retained in asset closure but cannot become visible geometry", () => {
    const source = fixtureScene();
    const asset = { assetId: "asset_metadata", payload: { path: "world.json", sha256: "a".repeat(64), bytes: 100 }, interpretation: { kind: "metadata", format: "json", schema: "slopcamera.spatial-world-import" }, dependencies: [], provenance: { source: "imported", description: "Original metadata" } };
    expect(parseSpatialScene({ ...source, assets: [asset] }).assets).toHaveLength(1);
    const base = fixtureEntity();
    expect(() => parseSpatialScene({ ...source, assets: [asset], entities: [{ ...base, geometry: { kind: "asset", assetId: "asset_metadata" } }] })).toThrow("requires a gltf");
    expect(() => parseSpatialScene({ ...source, assets: [{ ...asset, payload: { ...asset.payload, bytes: 1_048_577 } }] })).toThrow("one MiB");
  });
});
