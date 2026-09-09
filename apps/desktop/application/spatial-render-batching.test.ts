import { expect, test } from "bun:test";
import { z } from "zod";

import { evaluateSpatialScene } from "../../../src/spatial-scene/evaluate";
import { spatialAssetClosureDigests } from "../../../src/spatial-scene/identity";
import { IDENTITY_MATRIX } from "../../../src/spatial-scene/math";
import { fixtureAsset, fixtureEntity, fixtureScene } from "../../../src/spatial-scene/test-fixture";
import { HTML_OVERLAY_MAX_HTML_BYTES } from "../html-overlay/contracts";
import { createSpatialOverlayBatch, spatialGeometryContentSha256, SPATIAL_OVERLAY_LIMITS, type PreparedSpatialAsset } from "../html-overlay/spatial";
import { partitionSpatialRenderWindow, spatialBatchSerializationLimit } from "./spatial-render";

const profile = "three-webgl2-hardware-v1" as const;
const mode = { kind: "beauty" } as const;
const frameRate = { numerator: 1, denominator: 1 };

test("hardware serialization partitions actual oversized HTML while legacy bytes and rejection stay fixed", () => {
  const scene = { ...fixtureScene(), entities: Array.from({ length: 160 }, (_, index) => fixtureEntity(`entity_${index}`)) };
  const snapshots = Array.from({ length: 32 }, (_, index) => evaluateSpatialScene(scene, { cameraId: "camera_main", timeUs: (31 - index) * 1_000 }));
  const input = { snapshots, mode, frameRate, preparedAssets: [] };
  expect(() => createSpatialOverlayBatch(input)).toThrow();
  expect(() => partitionSpatialRenderWindow(input)).toThrow();
  const parts = partitionSpatialRenderWindow({ ...input, executionProfile: profile });
  expect(parts.length).toBeGreaterThan(1);
  expect(parts.flatMap(part => part.batch.metadata.frames.map(frame => frame.timeUs))).toEqual(snapshots.map(frame => frame.timeUs));
  expect(parts.map(part => [part.offset, part.length])).toEqual(partitionSpatialRenderWindow({ ...input, executionProfile: profile }).map(part => [part.offset, part.length]));
  expect(parts.map(part => part.offset)).toEqual(parts.map((_, index) => parts.slice(0, index).reduce((sum, part) => sum + part.length, 0)));
  for (const part of parts) expect(Buffer.byteLength(part.batch.authoring.html)).toBeLessThanOrEqual(HTML_OVERLAY_MAX_HTML_BYTES);
  const small = { ...input, snapshots: snapshots.slice(0, 1) };
  expect(partitionSpatialRenderWindow(small)).toEqual([{ offset: 0, length: 1, preparedAssets: [], batch: createSpatialOverlayBatch(small) }]);
});

test("partitioned timed surfaces retain only referenced resources and preserve the full source closure", () => {
  const asset = fixtureAsset();
  const mesh = fixtureEntity("entity_image");
  if (mesh.kind !== "mesh") throw new Error("Expected mesh fixture");
  const { geometry: _geometry, material: _material, ...base } = mesh;
  const scene = { ...fixtureScene(), assets: [asset], entities: [
    ...Array.from({ length: 160 }, (_, index) => fixtureEntity(`entity_${index}`)),
    { ...base, kind: "image" as const, assetId: asset.assetId, width: 2, height: 1, fit: "contain" as const, opacity: 1 },
  ] };
  const snapshots = Array.from({ length: 32 }, (_, index) => evaluateSpatialScene(scene, { cameraId: "camera_main", timeUs: (31 - index) * 1_000 }));
  const preparedAssets: PreparedSpatialAsset[] = snapshots.map(snapshot => ({ kind: "raster", assetId: asset.assetId, entityId: base.entityId,
    timeUs: snapshot.timeUs, assetManifestSha256: spatialAssetClosureDigests(scene.assets)[asset.assetId]!, width: 2, height: 1, alpha: "straight",
    resource: { name: `surface_${snapshot.timeUs}`, urlPath: `surface_${snapshot.timeUs}.png`, mediaType: "image/png", bytes: 100, sha256: "a".repeat(64) },
  }));
  const parts = partitionSpatialRenderWindow({ snapshots, mode, frameRate, preparedAssets, executionProfile: profile });
  expect(parts.length).toBeGreaterThan(1);
  for (const part of parts) {
    const times = snapshots.slice(part.offset, part.offset + part.length).map(snapshot => snapshot.timeUs);
    expect(part.preparedAssets.map(asset => asset.kind === "splat" ? null : asset.timeUs)).toEqual(times);
    expect(part.batch.authoring.resources.map(resource => resource.name).sort()).toEqual(times.map(time => `surface_${time}`).sort());
    expect(part.batch.metadata.preparation.map(asset => asset.assetManifestSha256)).toEqual(times.map(() => spatialAssetClosureDigests(scene.assets)[asset.assetId]!));
  }
});

test("only exact serialization byte-limit failures qualify for pure partitioning", () => {
  const htmlLimit = z.string().max(HTML_OVERLAY_MAX_HTML_BYTES);
  const htmlError = z.object({ html: htmlLimit }).safeParse({ html: "x".repeat(HTML_OVERLAY_MAX_HTML_BYTES + 1) });
  if (htmlError.success) throw new Error("Expected HTML overflow");
  expect(spatialBatchSerializationLimit(htmlError.error)).toBe(true);
  expect(spatialBatchSerializationLimit(new z.ZodError([{ code: "custom", path: ["html"], message: `HTML overlay documents may not exceed ${HTML_OVERLAY_MAX_HTML_BYTES} UTF-8 bytes.` }]))).toBe(true);
  for (const name of ["Spatial overlay request", "Spatial overlay metadata"]) expect(spatialBatchSerializationLimit(new Error(`${name} contains more than ${SPATIAL_OVERLAY_LIMITS.requestBytes} bytes.`))).toBe(true);
  for (const error of [new Error("GPU context lost"), new Error("Spatial overlay request contains more than 1000000 values."),
    new Error("Spatial overlay metadata contains more than 1024 bytes."),
    new z.ZodError([{ code: "custom", path: ["html"], message: "Unsupported module" }]),
    new z.ZodError([...htmlError.error.issues, { code: "custom", path: ["resources"], message: "Undeclared asset" }]),
    new z.ZodError([]),
  ]) expect(spatialBatchSerializationLimit(error)).toBe(false);
});

test("single-frame geometry overflow fails closed even after an earlier pure partition could fit", () => {
  const mesh = fixtureEntity();
  if (mesh.kind !== "mesh") throw new Error("Expected mesh fixture");
  const asset = { ...fixtureAsset("asset_mesh"), interpretation: { kind: "gltf" as const, format: "glb" as const, metersPerUnit: 1, sourceUp: "y" as const } };
  const entity = { ...mesh, geometry: { kind: "asset" as const, assetId: asset.assetId, materialMode: "entity" as const } };
  const scene = { ...fixtureScene(), entities: [entity], assets: [asset] };
  const snapshots = [0, 1].map(timeUs => evaluateSpatialScene(scene, { cameraId: "camera_main", timeUs }));
  const preparedAssets: PreparedSpatialAsset[] = snapshots.map(snapshot => ({ kind: "geometry", assetId: asset.assetId, entityId: mesh.entityId,
    entityGeometrySha256: spatialGeometryContentSha256(entity), assetManifestSha256: spatialAssetClosureDigests(scene.assets)[asset.assetId]!, timeUs: snapshot.timeUs,
    primitives: [{ positions: Array.from({ length: snapshot.timeUs === 0 ? 9 : 90_000 }, () => 0.1234567890123456), matrix: IDENTITY_MATRIX }],
  }));
  expect(partitionSpatialRenderWindow({ snapshots: snapshots.slice(0, 1), preparedAssets: preparedAssets.slice(0, 1), mode, frameRate, executionProfile: profile })).toHaveLength(1);
  let failure: unknown;
  try { partitionSpatialRenderWindow({ snapshots, preparedAssets, mode, frameRate, executionProfile: profile }); } catch (error) { failure = error; }
  expect(spatialBatchSerializationLimit(failure)).toBe(true);
});

test("a later invalid partition rejects the whole pure window without masking its capability failure", () => {
  const scene = { ...fixtureScene(), entities: Array.from({ length: 160 }, (_, index) => fixtureEntity(`entity_${index}`)) };
  const frame = evaluateSpatialScene(scene, { cameraId: "camera_main", timeUs: 0 });
  const bad = { ...frame, camera: { ...frame.camera, projection: { ...frame.camera.projection, width: 961 } } };
  expect(() => partitionSpatialRenderWindow({ snapshots: [...Array.from({ length: 31 }, () => frame), bad], mode, frameRate, executionProfile: profile })).toThrow();
});
