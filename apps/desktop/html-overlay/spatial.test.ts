import { describe, expect, test } from "bun:test";

import { EvaluatedSpatialSceneSchema, type EvaluatedSpatialScene, type SpatialEntity } from "../../../src/spatial-scene/contracts";
import { spatialAssetClosureDigests } from "../../../src/spatial-scene/identity";
import { IDENTITY_MATRIX, composeTransform } from "../../../src/spatial-scene/math";
import { canonicalJson, canonicalJsonSha256 } from "../core/canonical-json";
import { HTML_OVERLAY_MAX_HTML_BYTES, htmlOverlayFrameCount } from "./contracts";
import {
  createSpatialOverlayBatch, decodeSpatialAxialDepth, spatialSelectionColor,
  spatialTextRasterContentSha256, spatialWebGlProjection, PreparedSpatialAssetSchema,
  spatialVideoRasterContentSha256,
  spatialGeometryContentSha256,
  SPATIAL_DEPTH_MAX_CODE, SPATIAL_OVERLAY_LIMITS, type PreparedSpatialAsset,
} from "./spatial";

const digest = "a".repeat(64);
const transform = { position: [0, 0, -3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } as const;
function mesh(): SpatialEntity {
  return { kind: "mesh", entityId: "entity_box", name: "Box", parentId: null, transform,
    placement: { kind: "world" }, origin: { kind: "authored" }, visible: true,
    geometry: { kind: "box", size: [1, 1, 1] }, material: { kind: "unlit", color: "#123456", opacity: 1 } };
}
function snapshot(entity: SpatialEntity = mesh()): EvaluatedSpatialScene {
  return EvaluatedSpatialSceneSchema.parse({ kind: "atet.spatial-snapshot", schemaVersion: 1,
    sceneSha256: digest, stateSha256: digest, viewSha256: digest, timeUs: 0,
    camera: { cameraId: "camera_main", name: "Main", pose: { position: [1, 2, 3], rotation: [0, 0, 0, 1] },
      projection: { kind: "perspective", width: 320, height: 180, fx: 260, fy: 240, cx: 143, cy: 81, near: 0.1, far: 100 } },
    entities: [{ entity, worldMatrix: composeTransform(transform), selectionId: 17, visible: true }], assets: [] });
}
function request(snapshots: readonly EvaluatedSpatialScene[] = [snapshot()]) {
  return { snapshots, frameRate: { numerator: 30_000, denominator: 1_001 }, mode: { kind: "beauty" } } as const;
}
function rasterFixture(kind: "image" | "video" | "diagram" | "text" = "image") {
  const base = mesh();
  const entity: SpatialEntity = kind === "text"
    ? { ...base, kind: "text", text: "Hello", fontAssetId: "asset_source", fontSize: 24, width: 2, color: "#aabbcc", align: "left" }
    : { ...base, kind, assetId: "asset_source", width: 2, height: 1, fit: "contain", opacity: 1,
      ...(kind === "video" ? { sourceOffsetUs: 0, playback: "once" as const } : {}) } as SpatialEntity;
  // Remove properties from the mesh union before strict parsing.
  const { geometry: _geometry, material: _material, ...clean } = entity as SpatialEntity & { geometry?: unknown; material?: unknown };
  const frame = snapshot(clean as SpatialEntity);
  const interpretation = kind === "image" ? { kind, width: 4, height: 2, colorSpace: "srgb", alpha: "straight", mimeType: "image/png" }
    : kind === "video" ? { kind, width: 4, height: 2, colorSpace: "srgb", alpha: "straight", durationUs: 1_000_000, frameRate: { numerator: 30_000, denominator: 1_001 } }
    : kind === "diagram" ? { kind, schemaVersion: 1, theme: "light" }
    : { kind: "font", format: "woff2", family: "Fixture" };
  const withAsset = EvaluatedSpatialSceneSchema.parse({ ...frame, assets: [{
    assetId: "asset_source", payload: { path: "source.bin", sha256: digest, bytes: 100 }, interpretation,
    dependencies: [], provenance: { source: "authored", description: "Original fixture" },
  }] });
  const prepared: PreparedSpatialAsset = {
    kind: "raster", assetId: "asset_source", entityId: "entity_box", timeUs: null,
    assetManifestSha256: spatialAssetClosureDigests(withAsset.assets).asset_source!,
    width: 4, height: 2, alpha: "straight",
    resource: { name: "surface", urlPath: "surface.png", mediaType: "image/png", bytes: 100, sha256: digest },
  };
  return { frame: withAsset, prepared };
}
function embedded(batch: ReturnType<typeof createSpatialOverlayBatch>): Record<string, unknown> {
  const text = batch.authoring.html.match(/const input=(.*);\nconst canvas/u)?.[1];
  if (text === undefined) throw new Error("Missing embedded payload");
  return JSON.parse(text) as Record<string, unknown>;
}

describe("immutable spatial snapshot lowering", () => {
  test("preserves rational delivery rate and explicit times through index-only transport", () => {
    const frames = [snapshot(), { ...snapshot(), timeUs: 33_366 }, { ...snapshot(), timeUs: 66_733 }];
    const result = createSpatialOverlayBatch(request(frames));
    expect(result.metadata.frameRate).toEqual({ numerator: 30_000, denominator: 1_001 });
    expect(result.metadata.frames.map(frame => frame.timeUs)).toEqual([0, 33_366, 66_733]);
    expect(result.authoring.timing).toEqual({ fps: 1, durationUs: 3_000_000 });
    expect(htmlOverlayFrameCount(result.authoring.timing)).toBe(3);
    expect(result.authoring.libraries).toEqual(["three"]);
    expect(result.authoring.html).toContain("AtetOverlay.onFrame(({frame:index})");
    expect(result.authoring.html).not.toContain("timeMs");
    expect(result.authoring.html).not.toContain("requestAnimationFrame(");
    expect(result.metadata.frames[0]?.camera.pose.position).toEqual([1, 2, 3]);
    expect(result.metadata.color.toneMapping).toBe("none");
  });

  test("uses absolute matrices and final material; does not rebuild parent hierarchy", () => {
    const frame = snapshot();
    const result = createSpatialOverlayBatch(request([{ ...frame, entities: [{ ...frame.entities[0]!, worldMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, 8, 9, 1] }] }]));
    const payload = embedded(result) as { frames: { objects: { matrix: number[]; material: unknown }[] }[] };
    expect(payload.frames[0]!.objects[0]!.matrix.slice(12)).toEqual([7, 8, 9, 1]);
    expect(payload.frames[0]!.objects[0]!.material).toEqual({ kind: "unlit", color: "#123456", opacity: 1 });
    expect(result.authoring.html).toContain("mesh.matrix.fromArray(object.matrix)");
  });

  test("snapshot order may be nonmonotonic and repeats preserve exact state", () => {
    const a = snapshot(), b = { ...snapshot(), timeUs: 600_000 };
    const result = createSpatialOverlayBatch(request([b, a, b]));
    expect(result.metadata.frames.map(frame => frame.timeUs)).toEqual([600_000, 0, 600_000]);
    const payload = embedded(result) as { frames: unknown[] };
    expect(payload.frames[0]).toEqual(payload.frames[2]);
  });

  test("embedding cannot close script tags, and generated module parses", () => {
    const frame = snapshot({ ...mesh(), name: "</script><script>alert('x')</script>\u2028" });
    const result = createSpatialOverlayBatch(request([frame]));
    expect(result.authoring.html).not.toContain("alert('x')");
    const module = result.authoring.html.match(/<script type="module">([\s\S]*)<\/script>/u)?.[1];
    expect(module).toBeDefined();
    expect(() => new Bun.Transpiler({ loader: "js" }).transformSync(module!)).not.toThrow();
  });

  test("rejects getters and oversized batches before schema traversal", () => {
    let invoked = false;
    expect(() => createSpatialOverlayBatch({ get snapshots() { invoked = true; return []; } })).toThrow();
    expect(invoked).toBe(false);
    expect(() => createSpatialOverlayBatch(request(Array.from({ length: SPATIAL_OVERLAY_LIMITS.frames + 1 }, () => snapshot())))).toThrow();
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
    expect(() => createSpatialOverlayBatch(cyclic)).toThrow();
  });

  test("rejects mixed dimensions, duplicate selections, invalid affine matrices, and unused preparation", () => {
    const frame = snapshot();
    expect(() => createSpatialOverlayBatch(request([frame, { ...frame, camera: { ...frame.camera, projection: { ...frame.camera.projection, width: 640 } } }]))).toThrow("dimensions");
    expect(() => createSpatialOverlayBatch(request([{ ...frame, entities: [frame.entities[0]!, frame.entities[0]!] }]))).toThrow("unique");
    expect(() => createSpatialOverlayBatch(request([{ ...frame, entities: [{ ...frame.entities[0]!, worldMatrix: [1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }] }]))).toThrow("affine");
    expect(() => createSpatialOverlayBatch({ ...request(), preparedAssets: [rasterFixture().prepared] })).toThrow("unused");
  });

  test("all unavailable representations fail before any browser admission", () => {
    for (const kind of ["image", "video", "diagram", "text"] as const) {
      expect(() => createSpatialOverlayBatch(request([rasterFixture(kind).frame]))).toThrow("prepared representation");
    }
    const { geometry: _geometry, material: _material, ...base } = mesh() as Extract<SpatialEntity, { kind: "mesh" }>;
    expect(() => createSpatialOverlayBatch(request([snapshot({ ...base, kind: "splat", assetId: "asset_source" })]))).toThrow("Splat");
  });
});

describe("prepared surface and geometry boundary", () => {
  test("ordinary dense geometry crosses the private resource boundary without expanding the HTML cap", () => {
    const entity = { ...mesh(), kind: "mesh" as const, geometry: { kind: "asset" as const, assetId: "asset_city" },
      material: { kind: "unlit" as const, color: "#ffffff", opacity: 1 } };
    const asset = { assetId: "asset_city", payload: { path: "city.glb", bytes: 831_384, sha256: digest },
      interpretation: { kind: "gltf", format: "glb", metersPerUnit: 1, sourceUp: "y" }, dependencies: [], provenance: { source: "authored", description: "Original dense city fixture" } };
    const frame = EvaluatedSpatialSceneSchema.parse({ ...snapshot(entity), assets: [asset] });
    const primitives = [{ positions: Array.from({ length: 108_000 }, (_, index) => index / 108_001), matrix: [...IDENTITY_MATRIX] }];
    const bytes = new TextEncoder().encode(canonicalJson(primitives));
    expect(bytes.byteLength).toBeGreaterThan(HTML_OVERLAY_MAX_HTML_BYTES);
    const prepared = { kind: "geometry", assetId: "asset_city", entityId: entity.entityId,
      assetManifestSha256: spatialAssetClosureDigests(frame.assets).asset_city!, entityGeometrySha256: spatialGeometryContentSha256(entity), timeUs: null, primitives };
    expect(() => createSpatialOverlayBatch({ ...request([frame]), preparedAssets: [prepared] })).toThrow();
    const resource = { name: "city-geometry", urlPath: "city.json", mediaType: "application/json", bytes: bytes.byteLength, sha256: canonicalJsonSha256(primitives), transport: "fetch" as const };
    const result = createSpatialOverlayBatch({ ...request([frame, { ...frame, timeUs: 500_000 }, frame]), preparedAssets: [{ ...prepared, resource }] });
    expect(result.authoring.resources).toEqual([resource]);
    expect(result.metadata.costs.htmlBytes).toBeLessThan(30_000);
    expect(result.metadata.costs.resourceBytes).toBe(bytes.byteLength);
    expect(embedded(result).geometry).toEqual({});
    expect(embedded(result).geometryResources).toMatchObject([{ key: "asset_city:entity_box:all:static", resource }]);
    expect(result.metadata.frames.map(value => value.timeUs)).toEqual([0, 500_000, 0]);
    for (const changed of [{ sha256: digest }, { bytes: bytes.byteLength - 1 }, { mediaType: "application/octet-stream" }]) {
      expect(() => createSpatialOverlayBatch({ ...request([frame]), preparedAssets: [{ ...prepared, resource: { ...resource, ...changed } }] })).toThrow("exact canonical validated primitives");
    }
    const invalid = [{ ...primitives[0], positions: [NaN, 0, 0, 1, 0, 0, 0, 1, 0] }];
    expect(() => createSpatialOverlayBatch({ ...request([frame]), preparedAssets: [{ ...prepared, resource, primitives: invalid }] })).toThrow();
  });

  test("binds exact resource and interpretation digest, with centered contain and cover", () => {
    const { frame, prepared } = rasterFixture();
    const result = createSpatialOverlayBatch({ ...request([frame]), preparedAssets: [prepared] });
    expect(result.authoring.resources).toEqual([prepared.resource]);
    expect(result.authoring.html).toContain(`/.atet-overlay/assets/${digest}/surface.png`);
    expect(result.metadata.frames[0]?.objects[0]?.representation).toBe("prepared-image-raster");
    expect(() => createSpatialOverlayBatch({ ...request([frame]), preparedAssets: [{ ...prepared, assetManifestSha256: "b".repeat(64) }] })).toThrow("stale");
    expect(() => createSpatialOverlayBatch({ ...request([frame]), preparedAssets: [{ ...prepared, resource: { ...prepared.resource, mediaType: "image/svg+xml" } }] })).toThrow("PNG or JPEG");
  });

  test("video requires exact snapshot and source timestamps", () => {
    const { frame, prepared } = rasterFixture("video");
    expect(() => createSpatialOverlayBatch({ ...request([frame]), preparedAssets: [prepared] })).toThrow("exact snapshot time");
    const result = createSpatialOverlayBatch({ ...request([frame]), preparedAssets: [{ ...prepared, timeUs: 0, sourceTimeUs: 100_100, entityContentSha256: spatialVideoRasterContentSha256(frame.entities[0]!.entity as Extract<SpatialEntity, { kind: "video" }>) }] });
    expect(result.metadata.preparation[0]?.sourceTimeUs).toBe(100_100);
  });

  test("text preparation binds glyph layout rather than just font payload", () => {
    const { frame, prepared } = rasterFixture("text");
    expect(() => createSpatialOverlayBatch({ ...request([frame]), preparedAssets: [prepared] })).toThrow("exact text");
    const entity = frame.entities[0]!.entity as Extract<SpatialEntity, { kind: "text" }>;
    const bound = { ...prepared, entityContentSha256: spatialTextRasterContentSha256(entity) };
    expect(createSpatialOverlayBatch({ ...request([frame]), preparedAssets: [bound] }).metadata.frames[0]?.objects[0]?.representation).toBe("prepared-text-raster");
    const edited = { ...frame, entities: [{ ...frame.entities[0]!, entity: { ...entity, text: "Changed" } }] };
    expect(() => createSpatialOverlayBatch({ ...request([edited]), preparedAssets: [bound] })).toThrow("exact text");
  });

  test("geometry schema rejects malformed triangles, UVs, and indices", () => {
    const geometry = { kind: "geometry", assetId: "asset_source", entityId: "entity_box", entityGeometrySha256: digest, assetManifestSha256: digest, timeUs: null,
      primitives: [{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], matrix: IDENTITY_MATRIX }] };
    expect(PreparedSpatialAssetSchema.safeParse(geometry).success).toBe(true);
    expect(PreparedSpatialAssetSchema.safeParse({ ...geometry, primitives: [{ ...geometry.primitives[0], indices: [0, 1, 3] }] }).success).toBe(false);
    expect(PreparedSpatialAssetSchema.safeParse({ ...geometry, primitives: [{ ...geometry.primitives[0], normals: [0, 0, 1] }] }).success).toBe(false);
  });
});

describe("qualified auxiliary passes", () => {
  test("ID channels are exact and depth has explicit no-hit and axial calibration", () => {
    expect(spatialSelectionColor(17)).toEqual([0, 0, 17]);
    expect(spatialSelectionColor(4096)).toEqual([0, 16, 0]);
    expect(() => spatialSelectionColor(0)).toThrow();
    expect(decodeSpatialAxialDepth([0, 0, 0, 0], 0.1, 100)).toBeNull();
    expect(decodeSpatialAxialDepth([0, 0, 1, 255], 0.1, 100)).toBe(0.1);
    expect(decodeSpatialAxialDepth([255, 255, 255, 255], 0.1, 100)).toBe(100);
    expect(() => decodeSpatialAxialDepth([1, 1, 1, 128], 0.1, 100)).toThrow("validity");
    expect(SPATIAL_DEPTH_MAX_CODE).toBe(16_777_215);
    // Shrunk property regression: endpoint arithmetic must not exceed far by one ULP.
    expect(decodeSpatialAxialDepth([255, 255, 255, 255], 1.27542893399241, 3.2761189048599824)).toBe(3.2761189048599824);
    const result = createSpatialOverlayBatch({ ...request(), mode: { kind: "axial-depth", coverage: { kind: "opaque" } } });
    expect(result.metadata.color.output).toBe("rgba8-data");
    expect(result.metadata.depthEncoding.units).toBe("positive-camera-axial-meters");
    expect(result.metadata.depthEncoding.viewSurfaces).toBe("mask-to-no-hit");
    expect(result.authoring.html).toContain("THREE.NoBlending");
    expect(result.authoring.html).toContain("antialias:false");
  });

  test("straight alpha requires explicit threshold; view surfaces retain selection without invented metric depth", () => {
    const { frame, prepared } = rasterFixture();
    const withView = { ...frame, entities: [{ ...frame.entities[0]!, entity: { ...frame.entities[0]!.entity,
      placement: { kind: "view", cameraId: "camera_main", units: "pixels", order: 10 } } }] };
    expect(() => createSpatialOverlayBatch({ ...request([frame]), preparedAssets: [prepared], mode: { kind: "object-id", coverage: { kind: "opaque" } } })).toThrow("alpha threshold");
    const result = createSpatialOverlayBatch({ ...request(), snapshots: [withView], preparedAssets: [prepared], mode: { kind: "object-id", coverage: { kind: "alpha-threshold", threshold: 0.5 } } });
    expect(result.metadata.frames[0]?.objects[0]?.placement).toBe("view");
    expect(result.metadata.frames[0]?.objects[0]?.selectionId).toBe(17);
  });

  test("projection matrix preserves non-square focal calibration and off-center principal point", () => {
    const p = snapshot().camera.projection;
    const m = spatialWebGlProjection(p);
    expect(m[0]).toBe(520 / 320);
    expect(m[5]).toBe(480 / 180);
    expect(m[8]).toBe(1 - 286 / 320);
    expect(m[9]).toBe(162 / 180 - 1);
    expect(m[11]).toBe(-1);
  });
});
