import { z } from "zod";

import { createBoundedJsonSnapshot } from "../../../src/code/json-snapshot";
import {
  EvaluatedSpatialSceneSchema,
  SpatialAssetIdSchema,
  SpatialDigestSchema,
  SpatialEntityIdSchema,
  SpatialFrameRateSchema,
  SpatialMaterialSchema,
  SpatialMatrixSchema,
  SpatialProjectionSchema,
  SpatialTimeUsSchema,
  type EvaluatedSpatialScene,
  type SpatialCamera,
  type SpatialEntity,
  type SpatialProjection,
} from "../../../src/spatial-scene/contracts";
import { cameraMathView, invertTransform, type Mat4 } from "../../../src/spatial-scene/math";
import { spatialAssetClosureDigests } from "../../../src/spatial-scene/identity";
import { canonicalJson, canonicalJsonSha256 } from "../core/canonical-json";
import {
  HtmlOverlayAuthoringInputSchema,
  HtmlOverlayDeclaredResourceSchema,
  HtmlOverlayDeclaredResourcesSchema,
  type HtmlOverlayDeclaredResource,
} from "./contracts";
import { htmlOverlayAssetLocalUrl, serializeHtmlOverlayImportMap } from "./libraries";

export const SPATIAL_OVERLAY_LIMITS = Object.freeze({
  frames: 32,
  requestBytes: 16 * 1024 * 1024,
  requestValues: 1_000_000,
  preparedAssets: 1_024,
  primitivesPerAsset: 256,
  verticesPerPrimitive: 65_536,
  trianglesPerFrame: 100_000,
  drawCallsPerFrame: 2_048,
  decodedTexturePixels: 67_108_864,
});

const alphaSchema = z.enum(["straight", "opaque"]);
const textureShape = {
  resource: HtmlOverlayDeclaredResourceSchema,
  width: z.number().int().min(1).max(8_192),
  height: z.number().int().min(1).max(8_192),
  alpha: alphaSchema,
};
const samplerSchema = z.strictObject({
  wrapS: z.union([z.literal(33071), z.literal(33648), z.literal(10497)]),
  wrapT: z.union([z.literal(33071), z.literal(33648), z.literal(10497)]),
  magFilter: z.union([z.literal(9728), z.literal(9729)]).optional(),
  minFilter: z.union([z.literal(9728), z.literal(9729), z.literal(9984), z.literal(9985), z.literal(9986), z.literal(9987)]).optional(),
});
const finiteGeometry = z.number().finite().min(-1e6).max(1e6);
const primitiveSchema = z.strictObject({
  positions: z.array(finiteGeometry).min(9).max(SPATIAL_OVERLAY_LIMITS.verticesPerPrimitive * 3),
  normals: z.array(finiteGeometry).min(9).max(SPATIAL_OVERLAY_LIMITS.verticesPerPrimitive * 3).optional(),
  uvs: z.array(finiteGeometry).min(6).max(SPATIAL_OVERLAY_LIMITS.verticesPerPrimitive * 2).optional(),
  indices: z.array(z.number().int().min(0).max(SPATIAL_OVERLAY_LIMITS.verticesPerPrimitive - 1)).min(3)
    .max(SPATIAL_OVERLAY_LIMITS.trianglesPerFrame * 3).optional(),
  matrix: SpatialMatrixSchema,
  sourceNodeIndex: z.number().int().min(0).max(65_535).optional(),
  sourcePrimitiveIndex: z.number().int().min(0).max(65_535).optional(),
  doubleSided: z.boolean().optional(),
  alphaCutoff: z.number().finite().min(0).max(1).optional(),
  alphaMode: z.enum(["OPAQUE", "MASK", "BLEND"]).optional(),
  linearColor: z.tuple([z.number().finite().min(0).max(1), z.number().finite().min(0).max(1), z.number().finite().min(0).max(1)]).optional(),
  /** Host-resolved final material; omitted means the entity's material. */
  material: SpatialMaterialSchema.optional(),
  texture: z.strictObject({ ...textureShape, flipY: z.boolean().optional(), sampler: samplerSchema.optional() }).optional(),
}).superRefine((primitive, context) => {
  const vertices = primitive.positions.length / 3;
  if (!Number.isInteger(vertices)
    || (primitive.indices === undefined ? vertices % 3 !== 0 : primitive.indices.length % 3 !== 0)
    || primitive.indices?.some(index => index >= vertices)
    || (primitive.normals !== undefined && primitive.normals.length !== primitive.positions.length)
    || (primitive.uvs !== undefined && primitive.uvs.length !== vertices * 2)
    || (primitive.texture !== undefined && primitive.uvs === undefined)) {
    context.addIssue({ code: "custom", message: "Prepared geometry must contain complete triangles, matching attributes, and in-range indices; textured geometry requires UVs." });
  }
  try { invertTransform(primitive.matrix); } catch {
    context.addIssue({ code: "custom", message: "Prepared geometry matrices must be finite invertible affine transforms." });
  }
});

export const PreparedSpatialAssetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("raster"),
    assetId: SpatialAssetIdSchema,
    assetManifestSha256: SpatialDigestSchema,
    entityId: SpatialEntityIdSchema,
    /** null is a static surface. Video frames must name the exact snapshot time. */
    timeUs: SpatialTimeUsSchema.nullable(),
    sourceTimeUs: SpatialTimeUsSchema.optional(),
    sourceFrameIndex: z.number().int().min(0).max(216_000).optional(),
    sourcePresentationTimeUs: SpatialTimeUsSchema.optional(),
    sourcePts: z.number().int().safe().min(0).optional(),
    sourceTimeBase: z.strictObject({ numerator: z.string().regex(/^[1-9]\d{0,15}$/u), denominator: z.string().regex(/^[1-9]\d{0,15}$/u) }).optional(),
    sourceTimestamp: z.string().max(64).regex(/^\d+(?:\.\d{1,9})?$/u).optional(),
    sourceExactTimeUs: z.strictObject({ numerator: z.string().regex(/^(?:0|[1-9]\d{0,23})$/u), denominator: z.string().regex(/^[1-9]\d{0,8}$/u) }).optional(),
    entityContentSha256: SpatialDigestSchema.optional(),
    ...textureShape,
  }),
  z.strictObject({
    kind: z.literal("geometry"),
    assetId: SpatialAssetIdSchema,
    entityId: SpatialEntityIdSchema,
    entityGeometrySha256: SpatialDigestSchema,
    assetManifestSha256: SpatialDigestSchema,
    nodeIndex: z.number().int().min(0).max(65_535).optional(),
    timeUs: SpatialTimeUsSchema.nullable(),
    primitives: z.array(primitiveSchema).min(1).max(SPATIAL_OVERLAY_LIMITS.primitivesPerAsset),
  }),
]);

export const SpatialCoverageSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("opaque") }),
  z.strictObject({ kind: z.literal("alpha-threshold"), threshold: z.number().finite().gt(0).max(1) }),
]);
export const SpatialRenderModeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("beauty") }),
  z.strictObject({ kind: z.literal("object-id"), coverage: SpatialCoverageSchema }),
  z.strictObject({ kind: z.literal("axial-depth"), coverage: SpatialCoverageSchema }),
]);

export const SpatialOverlayBatchInputSchema = z.strictObject({
  snapshots: z.array(EvaluatedSpatialSceneSchema).min(1).max(SPATIAL_OVERLAY_LIMITS.frames),
  frameRate: SpatialFrameRateSchema,
  mode: SpatialRenderModeSchema,
  preparedAssets: z.array(PreparedSpatialAssetSchema).max(SPATIAL_OVERLAY_LIMITS.preparedAssets).default([]),
});
type DeepReadonly<T> = T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> } : T;
export type PreparedSpatialAsset = DeepReadonly<z.infer<typeof PreparedSpatialAssetSchema>>;
export type SpatialRenderMode = DeepReadonly<z.infer<typeof SpatialRenderModeSchema>>;
export type SpatialOverlayBatchInput = DeepReadonly<z.input<typeof SpatialOverlayBatchInputSchema>>;
type PreparedRaster = Extract<PreparedSpatialAsset, { kind: "raster" }>;
type PreparedGeometry = Extract<PreparedSpatialAsset, { kind: "geometry" }>;
type Material = DeepReadonly<z.infer<typeof SpatialMaterialSchema>>;
type Texture = DeepReadonly<z.infer<typeof primitiveSchema>["texture"]>;

/** Text preparation draws white glyphs; final color is applied by the scene material. */
export function spatialTextRasterContentSha256(entity: Extract<SpatialEntity, { kind: "text" }>): string {
  return canonicalJsonSha256({ domain: "atet.spatial-text-raster.v1", text: entity.text, fontAssetId: entity.fontAssetId,
    fontSize: entity.fontSize, width: entity.width, align: entity.align });
}
export function spatialGeometryContentSha256(entity: Extract<SpatialEntity, { kind: "mesh" }>): string {
  return canonicalJsonSha256({ domain: "atet.spatial-geometry-binding.v1", geometry: entity.geometry });
}
export function spatialVideoRasterContentSha256(entity: Extract<SpatialEntity, { kind: "video" }>): string {
  return canonicalJsonSha256({ domain: "atet.spatial-video-binding.v1", assetId: entity.assetId, sourceOffsetUs: entity.sourceOffsetUs, playback: entity.playback });
}

export class SpatialOverlayCapabilityError extends Error {
  readonly code = "unsupported-capability";
  constructor(readonly capability: string, message: string) {
    super(message);
    this.name = "SpatialOverlayCapabilityError";
  }
}

/** Exact byte-order encoding. Zero RGB with zero alpha is always no-hit. */
export function spatialSelectionColor(selectionId: number): readonly [number, number, number] {
  if (!Number.isInteger(selectionId) || selectionId < 1 || selectionId > 4_096) {
    throw new RangeError("Selection IDs must be integers in [1,4096].");
  }
  return Object.freeze([Math.floor(selectionId / 65_536), Math.floor(selectionId / 256) % 256, selectionId % 256]);
}

export const SPATIAL_DEPTH_MAX_CODE = 16_777_215;
/** Decode an RGBA8 sample; byte values are data, never color-converted. */
export function decodeSpatialAxialDepth(rgba: readonly number[], near: number, far: number): number | null {
  if (rgba.length !== 4 || rgba.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)
    || !Number.isFinite(near) || !Number.isFinite(far) || near <= 0 || far <= near) {
    throw new RangeError("Expected RGBA8 bytes and positive ordered clipping distances.");
  }
  const code = rgba[0]! * 65_536 + rgba[1]! * 256 + rgba[2]!;
  if (rgba[3] === 0 && code === 0) return null;
  if (rgba[3] !== 255 || code === 0) throw new RangeError("Malformed axial-depth validity or code.");
  return Math.min(far, Math.max(near, near + (code - 1) / (SPATIAL_DEPTH_MAX_CODE - 1) * (far - near)));
}

/** WebGL clip projection, with unequal focal lengths and off-center principal point. */
export function spatialWebGlProjection(projection: SpatialProjection): Mat4 {
  const p = SpatialProjectionSchema.parse(projection);
  if (p.kind === "perspective") {
    return Object.freeze([
      2 * p.fx / p.width, 0, 0, 0,
      0, 2 * p.fy / p.height, 0, 0,
      1 - 2 * p.cx / p.width, 2 * p.cy / p.height - 1, -(p.far + p.near) / (p.far - p.near), -1,
      0, 0, -2 * p.far * p.near / (p.far - p.near), 0,
    ]);
  }
  return Object.freeze([
    2 / (p.right - p.left), 0, 0, 0,
    0, 2 / (p.top - p.bottom), 0, 0,
    0, 0, -2 / (p.far - p.near), 0,
    -(p.right + p.left) / (p.right - p.left), -(p.top + p.bottom) / (p.top - p.bottom),
    -(p.far + p.near) / (p.far - p.near), 1,
  ]);
}

type LoweredMesh = Readonly<{
  kind: "mesh";
  entityId: string;
  selectionId: number;
  matrix: Mat4;
  placement: SpatialEntity["placement"];
  geometry: Exclude<Extract<SpatialEntity, { kind: "mesh" }>["geometry"], { kind: "asset" }> | { readonly kind: "prepared"; readonly key: string; readonly primitive: number };
  material: Material;
  textureName?: string;
  textureAlpha?: "straight" | "opaque";
  uvScale: readonly [number, number];
  uvOffset: readonly [number, number];
  surfaceScale: readonly [number, number];
  flipViewUv: boolean;
  doubleSided: boolean;
  alphaCutoff: number;
  alphaMode?: "OPAQUE" | "MASK" | "BLEND";
  linearColor?: readonly [number, number, number];
  textureOptions?: Readonly<{ readonly flipY?: boolean; readonly sampler?: DeepReadonly<z.infer<typeof samplerSchema>> }>;
}>;
type LoweredLight = Readonly<{
  kind: "light";
  entityId: string;
  matrix: Mat4;
  light: "ambient" | "point" | "directional";
  color: string;
  intensity: number;
}>;

function unsupported(capability: string, message: string): never {
  throw new SpatialOverlayCapabilityError(capability, message);
}

function preparedKey(asset: PreparedSpatialAsset): string {
  return asset.kind === "raster"
    ? `${asset.assetId}:${asset.entityId}:${asset.timeUs === null ? "static" : String(asset.timeUs)}`
    : `${asset.assetId}:${asset.entityId}:${asset.nodeIndex === undefined ? "all" : String(asset.nodeIndex)}:${asset.timeUs === null ? "static" : String(asset.timeUs)}`;
}

function assertRasterResource(texture: NonNullable<Texture>): void {
  if (texture.resource.mediaType !== "image/png" && texture.resource.mediaType !== "image/jpeg") {
    unsupported("prepared-raster-format", "Prepared surfaces must be validated PNG or JPEG resources; SVG, video, fonts, and diagram JSON require host preparation.");
  }
  if (texture.resource.bytes === 0) throw new RangeError("Prepared raster resources must be nonempty.");
}

function assertCoverage(mode: SpatialRenderMode, material: Material, texture: Texture, alphaMode?: "OPAQUE" | "MASK" | "BLEND"): void {
  if (mode.kind !== "beauty" && mode.coverage.kind === "opaque"
    && alphaMode !== "MASK"
    && (material.opacity !== 1 || texture?.alpha === "straight")) {
    unsupported("opaque-coverage", "Opaque auxiliary passes require opaque materials and opaque textures. Select an explicit alpha threshold for translucent surfaces.");
  }
}

function fitSurface(width: number, height: number, raster: PreparedRaster, fit: "contain" | "cover" | "stretch") {
  const aspect = raster.width / raster.height;
  const target = width / height;
  let surfaceScale: [number, number] = [1, 1];
  let uvScale: [number, number] = [1, 1];
  if (fit === "contain") surfaceScale = aspect > target ? [1, target / aspect] : [aspect / target, 1];
  if (fit === "cover") uvScale = aspect > target ? [target / aspect, 1] : [1, aspect / target];
  return { surfaceScale, uvScale, uvOffset: [(1 - uvScale[0]) / 2, (1 - uvScale[1]) / 2] as const };
}

function geometryTriangleCount(mesh: LoweredMesh, geometries: ReadonlyMap<string, PreparedGeometry>): number {
  switch (mesh.geometry.kind) {
    case "box": return 12;
    case "plane": return 2;
    case "sphere": return 960;
    case "cylinder": return 128;
    case "prepared": {
      const primitive = geometries.get(mesh.geometry.key)!.primitives[mesh.geometry.primitive]!;
      return primitive.indices === undefined ? primitive.positions.length / 9 : primitive.indices.length / 3;
    }
  }
}

function escapeEmbeddedJson(value: unknown): string {
  return canonicalJson(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function calibratedCamera(camera: SpatialCamera) {
  return {
    cameraToWorld: cameraMathView(camera).cameraToWorld,
    projection: spatialWebGlProjection(camera.projection),
    near: camera.projection.near,
    far: camera.projection.far,
    kind: camera.projection.kind,
  };
}

/**
 * Pure lowering. The integer overlay clock transports frame indices only. The
 * exact scene times and rational delivery rate remain in the returned metadata.
 * No file reads, loaders, generator execution, or GPU work occur here.
 */
export function createSpatialOverlayBatch(input: unknown) {
  const captured = createBoundedJsonSnapshot(input, SPATIAL_OVERLAY_LIMITS.requestBytes, "Spatial overlay request", {
    maximumDepth: 48, maximumValues: SPATIAL_OVERLAY_LIMITS.requestValues,
  });
  const request = SpatialOverlayBatchInputSchema.parse(captured.value);
  const first = request.snapshots[0]!;
  const width = first.camera.projection.width;
  const height = first.camera.projection.height;
  const prepared = new Map<string, PreparedSpatialAsset>();
  const geometries = new Map<string, PreparedGeometry>();
  const resources = new Map<string, HtmlOverlayDeclaredResource>();
  const textures = new Map<string, { readonly width: number; readonly height: number; readonly alpha: "straight" | "opaque" }>();
  const usedPrepared = new Set<string>();
  const bindTexture = (texture: NonNullable<Texture>): void => {
    assertRasterResource(texture);
    const existing = resources.get(texture.resource.name);
    if (existing !== undefined && canonicalJson(existing) !== canonicalJson(texture.resource)) {
      throw new RangeError("Prepared texture resource names must identify one immutable resource.");
    }
    const dimensions = { width: texture.width, height: texture.height, alpha: texture.alpha };
    const priorDimensions = textures.get(texture.resource.name);
    if (priorDimensions !== undefined && canonicalJson(priorDimensions) !== canonicalJson(dimensions)) {
      throw new RangeError("Prepared texture dimensions and alpha semantics must agree for one resource.");
    }
    textures.set(texture.resource.name, dimensions);
    resources.set(texture.resource.name, texture.resource);
  };
  for (const asset of request.preparedAssets) {
    const key = preparedKey(asset);
    if (prepared.has(key)) throw new RangeError(`Duplicate prepared asset binding: ${key}`);
    prepared.set(key, asset);
    if (asset.kind === "geometry") geometries.set(key, asset);
  }
  const frameEvidence: Array<{
    readonly sceneSha256: string; readonly stateSha256: string; readonly viewSha256: string; readonly timeUs: number;
    readonly camera: SpatialCamera;
    readonly objects: ReadonlyArray<{ readonly entityId: string; readonly selectionId: number; readonly representation: string; readonly placement: "world" | "view"; readonly assetManifestSha256?: string }>;
  }> = [];
  const frames = request.snapshots.map((snapshot: EvaluatedSpatialScene) => {
    if (snapshot.camera.projection.width !== width || snapshot.camera.projection.height !== height) {
      throw new RangeError("A spatial overlay batch requires identical calibrated output dimensions.");
    }
    const manifests = new Map(snapshot.assets.map(asset => [asset.assetId, asset]));
    const manifestDigests = spatialAssetClosureDigests(snapshot.assets);
    if (manifests.size !== snapshot.assets.length) throw new RangeError("Snapshot asset IDs must be unique.");
    const ids = new Set<string>();
    const selections = new Set<number>();
    const objects: (LoweredMesh | LoweredLight)[] = [];
    const evidence: Array<{ entityId: string; selectionId: number; representation: string; placement: "world" | "view"; assetManifestSha256?: string }> = [];
    const bindAsset = (assetId: string, key: string): PreparedSpatialAsset => {
      const manifest = manifests.get(assetId);
      if (manifest === undefined) throw new RangeError(`Snapshot has no manifest for ${assetId}.`);
      const asset = prepared.get(key);
      if (asset === undefined) unsupported(`prepare-${manifest.interpretation.kind}`, `No exact prepared representation for ${key}.`);
      if (asset.assetManifestSha256 !== manifestDigests[assetId]) {
        throw new RangeError(`Prepared asset manifest identity is stale for ${assetId}.`);
      }
      usedPrepared.add(key);
      return asset;
    };
    for (const entry of [...snapshot.entities].sort((a, b) => a.selectionId - b.selectionId)) {
      const entity = entry.entity;
      if (ids.has(entity.entityId) || selections.has(entry.selectionId)) throw new RangeError("Snapshot entity and selection IDs must be unique.");
      ids.add(entity.entityId); selections.add(entry.selectionId);
      invertTransform(entry.worldMatrix);
      if (entity.kind === "splat") unsupported("splat", "Splat rendering requires a separately qualified representation adapter.");
      if (entity.kind === "group") continue;
      if (entity.kind === "light") {
        if (entity.placement.kind !== "world") unsupported("view-light", "Lights require world placement.");
        if (entry.visible) objects.push({ kind: "light", entityId: entity.entityId, matrix: entry.worldMatrix, light: entity.light, color: entity.color, intensity: entity.intensity });
        continue;
      }
      // Capability checks include invisible/off-camera entities, so changing
      // visibility or cameras cannot discover an unplanned loader during render.
      const base = { kind: "mesh" as const, entityId: entity.entityId, selectionId: entry.selectionId, matrix: entry.worldMatrix, placement: entity.placement };
      const unitFit = { uvScale: [1, 1] as const, uvOffset: [0, 0] as const, surfaceScale: [1, 1] as const, flipViewUv: false, doubleSided: true, alphaCutoff: 0 };
      let meshes: LoweredMesh[];
      let representation: string;
      let assetManifestSha256: string | undefined;
      if (entity.kind === "mesh") {
        if (entity.geometry.kind === "asset") {
          const baseKey = `${entity.geometry.assetId}:${entity.entityId}:${entity.geometry.nodeIndex === undefined ? "all" : String(entity.geometry.nodeIndex)}`;
          const timedKey = `${baseKey}:${String(snapshot.timeUs)}`;
          const key = prepared.has(timedKey) ? timedKey : `${baseKey}:static`;
          const asset = bindAsset(entity.geometry.assetId, key);
          if (asset.kind !== "geometry" || manifests.get(asset.assetId)!.interpretation.kind !== "gltf") {
            unsupported("prepared-geometry-kind", "Asset meshes require prepared glTF geometry.");
          }
          if (asset.entityGeometrySha256 !== spatialGeometryContentSha256(entity) || (entity.geometry.clip !== undefined && asset.timeUs !== snapshot.timeUs)) {
            throw new RangeError("Prepared geometry must bind the exact entity geometry, material policy, clip, and sample time.");
          }
          assetManifestSha256 = asset.assetManifestSha256;
          representation = asset.timeUs === null ? "prepared-static-triangle-mesh" : "prepared-evaluated-triangle-mesh";
          const materialMode = entity.geometry.materialMode;
          meshes = asset.primitives.map((primitive, index) => {
            if (primitive.texture !== undefined) bindTexture(primitive.texture);
            const material = primitive.material ?? entity.material;
            if (materialMode === "source" && primitive.material === undefined) throw new RangeError("Source-material geometry requires the exact resolved source material for every primitive.");
            if (materialMode !== "source" && (primitive.material !== undefined || primitive.texture !== undefined || primitive.linearColor !== undefined)) {
              throw new RangeError("Entity-material meshes must not receive source material or texture overrides.");
            }
            assertCoverage(request.mode, material, primitive.texture, primitive.alphaMode);
            return { ...base, ...unitFit, geometry: { kind: "prepared", key, primitive: index }, material,
              doubleSided: primitive.doubleSided ?? true, alphaCutoff: primitive.alphaCutoff ?? 0,
              ...(primitive.alphaMode === undefined ? {} : { alphaMode: primitive.alphaMode }),
              ...(primitive.linearColor === undefined ? {} : { linearColor: primitive.linearColor }),
              ...(primitive.texture === undefined ? {} : { textureName: primitive.texture.resource.name, textureAlpha: primitive.texture.alpha,
                textureOptions: { ...(primitive.texture.flipY === undefined ? {} : { flipY: primitive.texture.flipY }),
                  ...(primitive.texture.sampler === undefined ? {} : { sampler: primitive.texture.sampler }) } }) };
          });
        } else {
          assertCoverage(request.mode, entity.material, undefined);
          representation = `primitive-${entity.geometry.kind}`;
          meshes = [{ ...base, ...unitFit, geometry: entity.geometry, material: entity.material }];
        }
      } else {
        const assetId = entity.kind === "text" ? entity.fontAssetId : entity.assetId;
        const timedKey = `${assetId}:${entity.entityId}:${String(snapshot.timeUs)}`;
        const key = prepared.has(timedKey) ? timedKey : `${assetId}:${entity.entityId}:static`;
        const asset = bindAsset(assetId, key);
        if (asset.kind !== "raster") unsupported("prepared-raster-kind", "Image, diagram, video, and text entities require prepared raster surfaces.");
        const expected = entity.kind === "text" ? "font" : entity.kind;
        if (manifests.get(assetId)!.interpretation.kind !== expected) throw new RangeError(`Prepared surface asset kind does not match ${entity.kind}.`);
        if (entity.kind === "video" && (asset.timeUs !== snapshot.timeUs || asset.sourceTimeUs === undefined || asset.entityContentSha256 !== spatialVideoRasterContentSha256(entity))) {
          unsupported("video-exact-frame", "Video surfaces require a prepared frame with exact snapshot time and source timestamp.");
        }
        if (entity.kind === "text" && asset.entityContentSha256 !== spatialTextRasterContentSha256(entity)) {
          throw new RangeError("Prepared text raster must bind the exact text, font, size, width, and alignment.");
        }
        bindTexture(asset);
        assetManifestSha256 = asset.assetManifestSha256;
        representation = `prepared-${entity.kind}-raster`;
        const surfaceWidth = entity.width;
        const surfaceHeight = entity.kind === "text" ? surfaceWidth * asset.height / asset.width : entity.height;
        const material: Material = { kind: "unlit", color: entity.kind === "text" ? entity.color : "#ffffff", opacity: entity.kind === "text" ? 1 : entity.opacity };
        assertCoverage(request.mode, material, asset);
        meshes = [{ ...base, geometry: { kind: "plane", width: surfaceWidth, height: surfaceHeight }, material,
          textureName: asset.resource.name, textureAlpha: asset.alpha, ...fitSurface(surfaceWidth, surfaceHeight, asset, entity.kind === "text" ? "stretch" : entity.fit),
          flipViewUv: entity.placement.kind === "view", doubleSided: true, alphaCutoff: 0 }];
      }
      if (!entry.visible || (entity.placement.kind === "view" && entity.placement.cameraId !== snapshot.camera.cameraId)) continue;
      objects.push(...meshes);
      evidence.push({ entityId: entity.entityId, selectionId: entry.selectionId, representation, placement: entity.placement.kind,
        ...(assetManifestSha256 === undefined ? {} : { assetManifestSha256 }) });
    }
    const meshes = objects.filter((object): object is LoweredMesh => object.kind === "mesh");
    const triangles = meshes.reduce((sum, mesh) => sum + geometryTriangleCount(mesh, geometries), 0);
    if (meshes.length > SPATIAL_OVERLAY_LIMITS.drawCallsPerFrame || triangles > SPATIAL_OVERLAY_LIMITS.trianglesPerFrame) {
      throw new RangeError("Spatial overlay exceeds its per-frame draw-call or triangle budget.");
    }
    frameEvidence.push({ sceneSha256: snapshot.sceneSha256, stateSha256: snapshot.stateSha256, viewSha256: snapshot.viewSha256,
      timeUs: snapshot.timeUs, camera: snapshot.camera, objects: evidence });
    return { camera: calibratedCamera(snapshot.camera), objects };
  });
  if (usedPrepared.size !== prepared.size) throw new RangeError("Prepared assets must be referenced by this exact batch; unused bindings are rejected.");
  const declaredResources = HtmlOverlayDeclaredResourcesSchema.parse([...resources.values()]);
  const decodedTexturePixels = [...textures.values()].reduce((sum, texture) => sum + texture.width * texture.height, 0);
  if (decodedTexturePixels > SPATIAL_OVERLAY_LIMITS.decodedTexturePixels) throw new RangeError("Prepared textures exceed the decoded pixel budget.");
  const payload = {
    mode: request.mode,
    frames,
    geometry: Object.fromEntries([...geometries].map(([key, asset]) => [key, asset.primitives])),
    textures: declaredResources.map(resource => ({ ...textures.get(resource.name)!, name: resource.name, url: htmlOverlayAssetLocalUrl(resource) })),
  };
  const html = spatialDocument(escapeEmbeddedJson(payload));
  const authoring = HtmlOverlayAuthoringInputSchema.parse({
    kind: "atet.html-overlay", schemaVersion: 1, canvas: { width, height, deviceScaleFactor: 1 },
    html, libraries: ["three"], parameters: {}, resources: declaredResources, seed: 0,
    timing: { fps: 1, durationUs: frames.length * 1_000_000 },
  });
  const metadataValue = {
    kind: "atet.spatial-overlay-batch", schemaVersion: 1,
    renderer: "three-webgl2-snapshot-v1", mode: request.mode,
    frameRate: request.frameRate,
    transport: { kind: "frame-index-only", fps: 1, frameCount: frames.length },
    color: request.mode.kind === "beauty"
      ? { source: "srgb", working: "linear-srgb", compositing: "linear-half-float-premultiplied", output: "srgb", alpha: "straight-png", toneMapping: "none" }
      : { source: "rgba8-data", working: "rgba8-data", output: "rgba8-data", alpha: "binary-validity", toneMapping: "none" },
    rasterization: { antialias: false, sampling: "single-pixel-center", surfaces: "authored-primitives-double-sided; prepared-mesh-explicit-sidedness", transparentOrdering: "three-object-sort" },
    selectionEncoding: { channels: "RGB-big-endian-uint24", noHit: [0, 0, 0, 0] },
    depthEncoding: {
      channels: "RGB-big-endian-uint24", noHit: [0, 0, 0, 0], validAlpha: 255,
      formula: "near + (code - 1) / 16777214 * (far - near)", units: "positive-camera-axial-meters",
      viewSurfaces: "mask-to-no-hit", quantizationSteps: 16_777_214,
      toleranceMeters: frameEvidence.map(frame => Math.max(2 * (frame.camera.projection.far - frame.camera.projection.near) / 16_777_214, frame.camera.projection.far * 2 ** -20, 1e-6)),
    },
    cameraConvention: "camera-to-world; column-major; XYZW; local-minus-Z; top-left-image-boundary; pixel-centers-i+0.5,j+0.5",
    viewConvention: "top-left-image-boundary; X-right,Y-down; normalized-XY-scaled-by-output-dimensions; order-after-world",
    preparation: request.preparedAssets.map(asset => ({ key: preparedKey(asset), assetManifestSha256: asset.assetManifestSha256,
      ...(asset.kind === "raster" && asset.sourceTimeUs !== undefined ? { sourceTimeUs: asset.sourceTimeUs } : {}),
      ...(asset.kind === "raster" && asset.sourceFrameIndex !== undefined ? { sourceFrameIndex: asset.sourceFrameIndex } : {}),
      ...(asset.kind === "raster" && asset.sourcePresentationTimeUs !== undefined ? { sourcePresentationTimeUs: asset.sourcePresentationTimeUs } : {}),
      ...(asset.kind === "raster" && asset.sourcePts !== undefined ? { sourcePts: asset.sourcePts } : {}),
      ...(asset.kind === "raster" && asset.sourceTimeBase !== undefined ? { sourceTimeBase: asset.sourceTimeBase } : {}),
      ...(asset.kind === "raster" && asset.sourceTimestamp !== undefined ? { sourceTimestamp: asset.sourceTimestamp } : {}),
      ...(asset.kind === "raster" && asset.sourceExactTimeUs !== undefined ? { sourceExactTimeUs: asset.sourceExactTimeUs } : {}),
    })),
    costs: { requestBytes: captured.bytes, htmlBytes: new TextEncoder().encode(html).byteLength,
      decodedTexturePixels, resourceBytes: declaredResources.reduce((sum, resource) => sum + resource.bytes, 0),
      note: "Each batch uses one isolated browser render; scenes and frame-local GPU objects are rebuilt for every selected snapshot. These are admission counts, not measured GPU performance." },
    frames: frameEvidence,
  };
  const metadata = createBoundedJsonSnapshot(metadataValue, SPATIAL_OVERLAY_LIMITS.requestBytes, "Spatial overlay metadata");
  return Object.freeze({ authoring: Object.freeze(authoring), metadata: metadata.value as unknown as DeepReadonly<typeof metadataValue>, metadataSha256: metadata.sha256 });
}

function spatialDocument(payload: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}canvas{display:block;width:100%;height:100%}</style>
<script type="importmap">${serializeHtmlOverlayImportMap(["three"])}</script></head><body><canvas></canvas>
<script type="module">
import * as THREE from "three";
const input=${payload};
const canvas=document.querySelector("canvas");
const renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:false,premultipliedAlpha:true,preserveDrawingBuffer:true});
renderer.setPixelRatio(1);renderer.setSize(AtetOverlay.width,AtetOverlay.height,false);
renderer.setClearColor(0x000000,0);renderer.outputColorSpace=THREE.SRGBColorSpace;
renderer.toneMapping=THREE.NoToneMapping;renderer.autoClear=false;
let beautyTarget=null,outputScene=null,outputCamera=null,outputGeometry=null,outputMaterial=null;
if(input.mode.kind==="beauty"){
  if(!renderer.extensions.has("EXT_color_buffer_float"))throw new Error("Spatial SDR beauty requires renderable half-float linear color for correct alpha compositing.");
  beautyTarget=new THREE.WebGLRenderTarget(AtetOverlay.width,AtetOverlay.height,{type:THREE.HalfFloatType,format:THREE.RGBAFormat,colorSpace:THREE.LinearSRGBColorSpace,minFilter:THREE.NearestFilter,magFilter:THREE.NearestFilter,depthBuffer:true,stencilBuffer:false});
  outputGeometry=new THREE.PlaneGeometry(2,2);
  outputMaterial=new THREE.RawShaderMaterial({depthTest:false,depthWrite:false,blending:THREE.NoBlending,transparent:false,toneMapped:false,dithering:false,
    uniforms:{linearPremultiplied:{value:beautyTarget.texture}},
    vertexShader:"precision highp float;attribute vec3 position;attribute vec2 uv;varying vec2 sampleUv;void main(){sampleUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}",
    fragmentShader:"precision highp float;uniform sampler2D linearPremultiplied;varying vec2 sampleUv;vec3 toSrgb(vec3 v){return mix(12.92*v,1.055*pow(max(v,vec3(0.0)),vec3(1.0/2.4))-0.055,step(vec3(0.0031308),v));}void main(){vec4 c=texture2D(linearPremultiplied,sampleUv);if(c.a<=0.0){gl_FragColor=vec4(0.0);return;}gl_FragColor=vec4(toSrgb(c.rgb/c.a)*c.a,c.a);}",
  });
  outputScene=new THREE.Scene();const outputMesh=new THREE.Mesh(outputGeometry,outputMaterial);outputMesh.frustumCulled=false;outputScene.add(outputMesh);outputCamera=new THREE.Camera();
}
const textures=new Map();let disposed=false;let contextFailure=null;
const loseContext=event=>{event.preventDefault();contextFailure=new Error("Spatial WebGL context was lost.");};
canvas.addEventListener("webglcontextlost",loseContext);
const initialization=(async()=>{
  for(const item of input.textures){
    const texture=await new THREE.TextureLoader().loadAsync(item.url);
    if(disposed){texture.dispose();throw new Error("Spatial renderer was disposed during texture preparation.");}
    if(texture.image.width!==item.width||texture.image.height!==item.height){texture.dispose();throw new Error("Prepared raster dimensions changed.");}
    texture.colorSpace=THREE.SRGBColorSpace;texture.generateMipmaps=false;
    texture.minFilter=THREE.LinearFilter;texture.magFilter=THREE.LinearFilter;
    texture.wrapS=THREE.ClampToEdgeWrapping;texture.wrapT=THREE.ClampToEdgeWrapping;
    textures.set(item.name,texture);
  }
})().catch(error=>{for(const texture of textures.values())texture.dispose();textures.clear();throw error;});
AtetOverlay.ready(initialization);
const vertexShader=\`precision highp float;
uniform mat4 projectionMatrix;uniform mat4 modelViewMatrix;
attribute vec3 position;attribute vec2 uv;
varying vec2 surfaceUv;varying float axialDepth;
void main(){vec4 p=modelViewMatrix*vec4(position,1.0);surfaceUv=uv;axialDepth=-p.z;gl_Position=projectionMatrix*p;}\`;
const fragmentShader=\`precision highp float;
uniform sampler2D surfaceMap;uniform bool hasMap;uniform bool textureOpaque;uniform vec2 uvScale;uniform vec2 uvOffset;uniform bool flipViewUv;
uniform float opacity;uniform float threshold;uniform bool isMask;uniform float maskCutoff;uniform vec3 selection;uniform float nearClip;uniform float farClip;uniform int mode;
varying vec2 surfaceUv;varying float axialDepth;
void main(){vec2 uv=surfaceUv;if(flipViewUv)uv.y=1.0-uv.y;uv=uv*uvScale+uvOffset;
float alpha=opacity*(hasMap&&!textureOpaque?texture2D(surfaceMap,uv).a:1.0);if(isMask){if(alpha<maskCutoff)discard;alpha=1.0;}if(alpha<threshold)discard;
if(mode==0){gl_FragColor=vec4(selection,1.0);return;}if(mode==2){gl_FragColor=vec4(0.0);return;}
float code=1.0+floor(clamp((axialDepth-nearClip)/(farClip-nearClip),0.0,1.0)*16777214.0+0.5);
float high=floor(code/65536.0);float middle=floor((code-high*65536.0)/256.0);float low=code-high*65536.0-middle*256.0;
gl_FragColor=vec4(vec3(high,middle,low)/255.0,1.0);}\`;
function makeGeometry(object,track){
  const g=object.geometry;let geometry;
  if(g.kind==="box")geometry=new THREE.BoxGeometry(...g.size);
  else if(g.kind==="sphere")geometry=new THREE.SphereGeometry(g.radius,32,16);
  else if(g.kind==="plane")geometry=new THREE.PlaneGeometry(g.width*object.surfaceScale[0],g.height*object.surfaceScale[1]);
  else if(g.kind==="cylinder")geometry=new THREE.CylinderGeometry(g.radius,g.radius,g.height,32);
  else{const p=input.geometry[g.key][g.primitive];geometry=new THREE.BufferGeometry();
    geometry.setAttribute("position",new THREE.Float32BufferAttribute(p.positions,3));
    if(p.normals)geometry.setAttribute("normal",new THREE.Float32BufferAttribute(p.normals,3));
    if(p.uvs)geometry.setAttribute("uv",new THREE.Float32BufferAttribute(p.uvs,2));
    if(p.indices)geometry.setIndex(p.indices);if(!p.normals)geometry.computeVertexNormals();}
  return track(geometry);
}
function makeMaterial(object,frame,track){
  const m=object.material;const originalMap=object.textureName===undefined?null:textures.get(object.textureName);
  const map=originalMap===null?null:track(originalMap.clone());
  if(map){
    const options=object.textureOptions;
    if(options?.flipY!==undefined)map.flipY=options.flipY;
    if(options?.sampler){const s=options.sampler;
      const wraps={33071:THREE.ClampToEdgeWrapping,33648:THREE.MirroredRepeatWrapping,10497:THREE.RepeatWrapping};
      const filters={9728:THREE.NearestFilter,9729:THREE.LinearFilter,9984:THREE.NearestMipmapNearestFilter,9985:THREE.LinearMipmapNearestFilter,9986:THREE.NearestMipmapLinearFilter,9987:THREE.LinearMipmapLinearFilter};
      map.wrapS=wraps[s.wrapS];map.wrapT=wraps[s.wrapT];map.magFilter=filters[s.magFilter??9729];map.minFilter=filters[s.minFilter??9987];map.generateMipmaps=(s.minFilter??9987)>=9984;
    }map.needsUpdate=true;
  }
  const view=object.placement.kind==="view";
  if(input.mode.kind!=="beauty"){
    const id=object.selectionId;
    return track(new THREE.RawShaderMaterial({vertexShader,fragmentShader,side:object.doubleSided?THREE.DoubleSide:THREE.FrontSide,
      transparent:false,blending:THREE.NoBlending,depthWrite:!view,depthTest:!view,toneMapped:false,dithering:false,
      uniforms:{surfaceMap:{value:map},hasMap:{value:map!==null},textureOpaque:{value:object.textureAlpha==="opaque"},uvScale:{value:new THREE.Vector2(...object.uvScale)},
      uvOffset:{value:new THREE.Vector2(...object.uvOffset)},flipViewUv:{value:object.flipViewUv},opacity:{value:m.opacity},
      threshold:{value:input.mode.coverage.kind==="opaque"?1:input.mode.coverage.threshold},isMask:{value:object.alphaMode==="MASK"},maskCutoff:{value:object.alphaCutoff},
      selection:{value:new THREE.Vector3(Math.floor(id/65536)/255,(Math.floor(id/256)%256)/255,(id%256)/255)},
      nearClip:{value:frame.camera.near},farClip:{value:frame.camera.far},mode:{value:input.mode.kind==="object-id"?0:view?2:1}}}));
  }
  if(map){map.repeat.fromArray(object.uvScale);map.offset.fromArray(object.uvOffset);
    if(object.flipViewUv){map.repeat.y*=-1;map.offset.y+=object.uvScale[1];}map.needsUpdate=true;}
  const transparent=object.alphaMode===undefined?object.alphaCutoff===0&&(m.opacity<1||object.textureAlpha==="straight"):object.alphaMode==="BLEND";
  const options={color:m.color,opacity:m.opacity,transparent,map,
    side:object.doubleSided?THREE.DoubleSide:THREE.FrontSide,alphaTest:object.alphaCutoff,depthTest:!view,depthWrite:!view&&!transparent,toneMapped:false};
  const material=track(m.kind==="unlit"?new THREE.MeshBasicMaterial(options):new THREE.MeshStandardMaterial({...options,roughness:m.roughness,metalness:m.metalness}));
  if(object.linearColor)material.color.setRGB(...object.linearColor,THREE.LinearSRGBColorSpace);
  return material;
}
function makeCamera(data){
  const camera=data.kind==="perspective"?new THREE.PerspectiveCamera():new THREE.OrthographicCamera();camera.matrixAutoUpdate=false;camera.matrix.fromArray(data.cameraToWorld);
  camera.projectionMatrix.fromArray(data.projection);camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  camera.updateMatrixWorld(true);return camera;
}
AtetOverlay.onFrame(({frame:index})=>{
  if(disposed)throw new Error("Spatial renderer is disposed.");if(contextFailure)throw contextFailure;
  const frame=input.frames[index];if(!frame)throw new Error("Spatial frame index is outside the immutable batch.");
  const disposable=[];const track=value=>(disposable.push(value),value);
  try{
    const world=new THREE.Scene();const view=new THREE.Scene();const camera=makeCamera(frame.camera);
    const viewCamera=new THREE.OrthographicCamera(0,AtetOverlay.width,0,AtetOverlay.height,0.01,2000002);viewCamera.position.z=1000001;viewCamera.updateMatrixWorld(true);
    for(const object of frame.objects){
      if(object.kind==="light"){
        const light=object.light==="ambient"?new THREE.AmbientLight(object.color,object.intensity):object.light==="point"?new THREE.PointLight(object.color,object.intensity):new THREE.DirectionalLight(object.color,object.intensity);
        light.matrixAutoUpdate=false;light.matrix.fromArray(object.matrix);world.add(light);
        if(object.light==="directional"){const target=new THREE.Object3D();target.position.set(0,0,-1).applyMatrix4(light.matrix);world.add(target);light.target=target;}
        continue;
      }
      const mesh=new THREE.Mesh(makeGeometry(object,track),makeMaterial(object,frame,track));mesh.name=object.entityId;
      mesh.matrixAutoUpdate=false;mesh.matrix.fromArray(object.matrix);
      if(object.geometry.kind==="prepared")mesh.matrix.multiply(new THREE.Matrix4().fromArray(input.geometry[object.geometry.key][object.geometry.primitive].matrix));
      if(object.placement.kind==="view"){
        if(object.placement.units==="normalized")mesh.matrix.premultiply(new THREE.Matrix4().makeScale(AtetOverlay.width,AtetOverlay.height,1));
        mesh.renderOrder=object.placement.order;mesh.frustumCulled=false;view.add(mesh);
      }else world.add(mesh);
    }
    renderer.setRenderTarget(beautyTarget);renderer.clear(true,true,true);renderer.render(world,camera);renderer.clearDepth();renderer.render(view,viewCamera);
    if(beautyTarget){renderer.setRenderTarget(null);renderer.clear(true,true,true);renderer.render(outputScene,outputCamera);}
    if(contextFailure)throw contextFailure;
  }finally{for(const resource of disposable)resource.dispose();}
});
addEventListener("pagehide",()=>{disposed=true;canvas.removeEventListener("webglcontextlost",loseContext);for(const texture of textures.values())texture.dispose();textures.clear();beautyTarget?.dispose();outputGeometry?.dispose();outputMaterial?.dispose();renderer.dispose();renderer.forceContextLoss();});
</script></body></html>`;
}
