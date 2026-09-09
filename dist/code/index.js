// @bun
import {
  AtetCodeError,
  AtetDiagramCheckInputSchema,
  AtetDiagramCheckOutputSchema,
  AtetDiagramRenderInputSchema,
  AtetDiagramRenderOutputSchema,
  AtetImageGenerateInputSchema,
  AtetImageGenerateOutputSchema,
  AtetImageModelSchema,
  AtetImageVectorizeInputSchema,
  AtetImageVectorizeOutputSchema,
  AtetLintFindingSchema,
  AtetRenderArtifactsSchema,
  AtetVectorizeProvenanceSchema,
  AtetVectorizeQualityReceiptSchema,
  AtetVectorizeReceiptSchema,
  AtetWorkflowRunError,
  AuthoredGraphNodeV1Schema,
  AuthoredWorkflowGraphV1Schema,
  CompiledWorkflowGraphSchema,
  DEFAULT_GRAPH_COMPILER_LIMITS,
  GRAPH_ABI,
  GraphCompilerLimitsSchema,
  JsonValueSchema,
  MAX_WORKFLOW_RESULT_BYTES,
  MAX_WORKFLOW_RESULT_DEPTH,
  MAX_WORKFLOW_RESULT_VALUES,
  OperationDiscoverySchema,
  OperationKindSchema,
  OperationPolicySchema,
  PORTABLE_ATET_OPERATION_CONTRACTS,
  PORTABLE_ATET_OPERATION_KINDS,
  PUBLIC_ATET_WORKFLOW_PROJECTION,
  PUBLIC_WORKFLOW_REGISTRY_PROJECTION,
  PUBLIC_WORKFLOW_REGISTRY_PROJECTION_ID,
  PortableWorkflowBuilder,
  REQUIREMENT_ENVELOPE_VERSION,
  RequirementEnvelopeSchema,
  SerializedRefV1Schema,
  WORKFLOW_COMPILATION_HASH_DOMAIN,
  WORKFLOW_COMPILATION_VERSION,
  WORKFLOW_GRAPH_HASH_DOMAIN,
  WORKFLOW_GRAPH_VERSION,
  WORKFLOW_NODE_RECEIPT_HASH_DOMAIN,
  WORKFLOW_NODE_RECEIPT_VERSION,
  WORKFLOW_REF_BRAND,
  WORKFLOW_REF_VERSION,
  asAtetCodeError,
  atetCodeErrorMessage,
  boundedCanonicalJson,
  boundedCanonicalJsonSha256,
  buildWorkflow,
  buildWorkflowGraph,
  canonicalJson,
  canonicalJsonSha256,
  compileWorkflowGraph,
  createAtetCodeHost,
  createBoundedJsonSnapshot,
  createBoundedJsonValueSnapshot,
  createGraphHash,
  createPublicWorkflowRegistryProjection,
  createWorkflowCompilationHash,
  createWorkflowGraphHash,
  deepFreezeJson,
  definePortableWorkflowFragment,
  defineWorkflow,
  isPortableAtetOperationKind,
  runBuiltWorkflow,
  runWorkflow,
  seconds,
  sha256Hex
} from "../index-yghkr2fe.js";
import"../index-z1w83f81.js";

// src/spatial-scene/contracts.ts
import { z } from "zod";
var SPATIAL_SCENE_LIMITS = Object.freeze({
  sourceBytes: 2097152,
  sourceDepth: 32,
  sourceValues: 200000,
  entities: 4096,
  assets: 128,
  cameras: 64,
  channels: 4096,
  keysPerChannel: 4096,
  durationUs: 3600000000,
  patchOperations: 256
});
var SpatialDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
var stableId = (prefix) => z.string().min(prefix.length + 1).max(128).regex(new RegExp(`^${prefix}[a-zA-Z0-9][a-zA-Z0-9_-]*$`, "u"));
var SpatialSceneIdSchema = stableId("scene_");
var SpatialEntityIdSchema = stableId("entity_");
var SpatialCameraIdSchema = stableId("camera_");
var SpatialAssetIdSchema = stableId("asset_");
var SpatialGeneratorIdSchema = stableId("generator_");
var SpatialChannelIdSchema = stableId("channel_");
var SpatialShotIdSchema = stableId("shot_");
var finiteCoordinate = z.number().finite().min(-1e6).max(1e6);
var positiveDimension = z.number().finite().min(0.000001).max(1e6);
var unit = z.number().finite().min(0).max(1);
var SpatialTimeUsSchema = z.number().int().safe().min(0).max(SPATIAL_SCENE_LIMITS.durationUs);
var SpatialVec3Schema = z.tuple([finiteCoordinate, finiteCoordinate, finiteCoordinate]);
var SpatialQuaternionSchema = z.tuple([
  z.number().finite().min(-1).max(1),
  z.number().finite().min(-1).max(1),
  z.number().finite().min(-1).max(1),
  z.number().finite().min(-1).max(1)
]).refine((value) => Math.abs(value.reduce((sum, part) => sum + part * part, 0) - 1) <= 0.000001, "Rotation must be a unit quaternion in XYZW order.");
var SpatialTransformSchema = z.strictObject({
  position: SpatialVec3Schema,
  rotation: SpatialQuaternionSchema,
  scale: z.tuple([positiveDimension, positiveDimension, positiveDimension])
});
var SpatialPoseSchema = z.strictObject({
  position: SpatialVec3Schema,
  rotation: SpatialQuaternionSchema
});
var SpatialFrameRateSchema = z.strictObject({
  numerator: z.number().int().safe().min(1).max(1e6),
  denominator: z.number().int().safe().min(1).max(1e6)
}).refine((rate) => rate.numerator / rate.denominator <= 1000, "Frame rate exceeds 1,000 fps.");
var dimensions = {
  width: z.number().int().min(1).max(16384),
  height: z.number().int().min(1).max(16384)
};
var clipping = { near: positiveDimension, far: positiveDimension };
var SpatialProjectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("perspective"),
    ...dimensions,
    ...clipping,
    fx: positiveDimension,
    fy: positiveDimension,
    cx: finiteCoordinate,
    cy: finiteCoordinate
  }),
  z.strictObject({
    kind: z.literal("orthographic"),
    ...dimensions,
    ...clipping,
    left: finiteCoordinate,
    right: finiteCoordinate,
    top: finiteCoordinate,
    bottom: finiteCoordinate
  })
]).superRefine((projection, context) => {
  if (projection.far <= projection.near)
    context.addIssue({ code: "custom", message: "Far clipping must exceed near clipping." });
  if (projection.width * projection.height > 33554432)
    context.addIssue({ code: "custom", message: "Camera exceeds the 32-megapixel limit." });
  if (projection.kind === "orthographic" && (projection.right <= projection.left || projection.top <= projection.bottom)) {
    context.addIssue({ code: "custom", message: "Orthographic extents must have positive width and height." });
  }
});
var SpatialCameraSchema = z.strictObject({
  cameraId: SpatialCameraIdSchema,
  name: z.string().min(1).max(256),
  pose: SpatialPoseSchema,
  projection: SpatialProjectionSchema
});
var relativePath = z.string().min(1).max(1024).refine((value) => !value.startsWith("/") && !/[\\\u0000-\u001f]/u.test(value) && !/^[a-zA-Z]:/u.test(value) && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."), "Asset paths must be contained root-relative paths.");
var SpatialPayloadSchema = z.strictObject({
  path: relativePath,
  sha256: SpatialDigestSchema,
  bytes: z.number().int().safe().min(1).max(134217728)
});
var imageInterpretation = {
  ...dimensions,
  colorSpace: z.literal("srgb"),
  alpha: z.enum(["straight", "opaque"])
};
var SpatialAssetInterpretationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("image"), ...imageInterpretation, mimeType: z.enum(["image/png", "image/jpeg", "image/svg+xml"]) }),
  z.strictObject({ kind: z.literal("video"), ...imageInterpretation, durationUs: SpatialTimeUsSchema.refine((value) => value > 0), frameRate: SpatialFrameRateSchema }),
  z.strictObject({ kind: z.literal("diagram"), schemaVersion: z.literal(1), theme: z.enum(["light", "dark"]) }),
  z.strictObject({ kind: z.literal("gltf"), format: z.enum(["glb", "gltf"]), metersPerUnit: positiveDimension, sourceUp: z.enum(["x", "y", "z"]) }),
  z.strictObject({ kind: z.literal("font"), format: z.enum(["otf", "woff2"]), family: z.string().min(1).max(128) }),
  z.strictObject({ kind: z.literal("splat"), format: z.enum(["spz", "ply"]), metersPerUnit: positiveDimension, sourceUp: z.enum(["x", "y", "z"]) }),
  z.strictObject({ kind: z.literal("metadata"), format: z.literal("json"), schema: z.enum(["atet.spatial-world-import", "atet.world-labs-provenance"]) })
]);
var SpatialAssetManifestSchema = z.strictObject({
  assetId: SpatialAssetIdSchema,
  payload: SpatialPayloadSchema,
  interpretation: SpatialAssetInterpretationSchema,
  dependencies: z.array(SpatialAssetIdSchema).max(SPATIAL_SCENE_LIMITS.assets),
  provenance: z.strictObject({
    source: z.enum(["authored", "imported", "generated", "derived"]),
    description: z.string().min(1).max(2048),
    receiptSha256: SpatialDigestSchema.optional()
  })
});
var color = z.string().regex(/^#[a-fA-F0-9]{6}$/u);
var SpatialMaterialSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unlit"), color, opacity: unit }),
  z.strictObject({ kind: z.literal("standard"), color, opacity: unit, roughness: unit, metalness: unit })
]);
var SpatialGeometrySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("box"), size: z.tuple([positiveDimension, positiveDimension, positiveDimension]) }),
  z.strictObject({ kind: z.literal("sphere"), radius: positiveDimension }),
  z.strictObject({ kind: z.literal("plane"), width: positiveDimension, height: positiveDimension }),
  z.strictObject({ kind: z.literal("cylinder"), radius: positiveDimension, height: positiveDimension }),
  z.strictObject({
    kind: z.literal("asset"),
    assetId: SpatialAssetIdSchema,
    nodeIndex: z.number().int().min(0).max(65535).optional(),
    materialMode: z.enum(["entity", "source"]).optional(),
    clip: z.strictObject({ index: z.number().int().min(0).max(255), offsetUs: SpatialTimeUsSchema, playback: z.enum(["once", "loop", "freeze"]) }).optional()
  })
]);
var SpatialOriginSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("authored") }),
  z.strictObject({ kind: z.literal("generated"), generatorId: SpatialGeneratorIdSchema, key: z.string().min(1).max(256) })
]);
var SpatialPlacementSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("world") }),
  z.strictObject({ kind: z.literal("view"), cameraId: SpatialCameraIdSchema, units: z.enum(["pixels", "normalized"]), order: z.number().int().min(-4096).max(4096) })
]);
var entityBase = {
  entityId: SpatialEntityIdSchema,
  name: z.string().min(1).max(256),
  parentId: SpatialEntityIdSchema.nullable(),
  transform: SpatialTransformSchema,
  placement: SpatialPlacementSchema,
  origin: SpatialOriginSchema,
  visible: z.boolean()
};
var surfaceBase = {
  assetId: SpatialAssetIdSchema,
  width: positiveDimension,
  height: positiveDimension,
  fit: z.enum(["contain", "cover", "stretch"]),
  opacity: unit
};
var SpatialEntitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...entityBase, kind: z.literal("group") }),
  z.strictObject({ ...entityBase, kind: z.literal("mesh"), geometry: SpatialGeometrySchema, material: SpatialMaterialSchema }),
  z.strictObject({ ...entityBase, ...surfaceBase, kind: z.literal("image") }),
  z.strictObject({ ...entityBase, ...surfaceBase, kind: z.literal("diagram") }),
  z.strictObject({ ...entityBase, ...surfaceBase, kind: z.literal("video"), sourceOffsetUs: SpatialTimeUsSchema, playback: z.enum(["once", "loop", "freeze"]) }),
  z.strictObject({ ...entityBase, kind: z.literal("text"), text: z.string().max(16384), fontAssetId: SpatialAssetIdSchema, fontSize: positiveDimension, width: positiveDimension, color, align: z.enum(["left", "center", "right"]) }),
  z.strictObject({ ...entityBase, kind: z.literal("light"), light: z.enum(["ambient", "directional", "point"]), color, intensity: z.number().finite().min(0).max(1e5) }),
  z.strictObject({ ...entityBase, kind: z.literal("splat"), assetId: SpatialAssetIdSchema })
]);
var key = (value) => z.strictObject({ timeUs: SpatialTimeUsSchema, value });
var channelBase = { channelId: SpatialChannelIdSchema, targetId: z.union([SpatialEntityIdSchema, SpatialCameraIdSchema]) };
var SpatialAnimationSchema = z.discriminatedUnion("property", [
  z.strictObject({ ...channelBase, property: z.literal("position"), interpolation: z.enum(["step", "linear"]), keys: z.array(key(SpatialVec3Schema)).min(1).max(SPATIAL_SCENE_LIMITS.keysPerChannel) }),
  z.strictObject({ ...channelBase, property: z.literal("rotation"), interpolation: z.enum(["step", "slerp"]), keys: z.array(key(SpatialQuaternionSchema)).min(1).max(SPATIAL_SCENE_LIMITS.keysPerChannel) }),
  z.strictObject({ ...channelBase, property: z.literal("scale"), interpolation: z.enum(["step", "linear"]), keys: z.array(key(z.tuple([positiveDimension, positiveDimension, positiveDimension]))).min(1).max(SPATIAL_SCENE_LIMITS.keysPerChannel) }),
  z.strictObject({ ...channelBase, property: z.literal("opacity"), interpolation: z.enum(["step", "linear"]), keys: z.array(key(unit)).min(1).max(SPATIAL_SCENE_LIMITS.keysPerChannel) })
]);
var SpatialOverrideSchema = z.discriminatedUnion("property", [
  z.strictObject({ entityId: SpatialEntityIdSchema, property: z.literal("color"), value: color }),
  z.strictObject({ entityId: SpatialEntityIdSchema, property: z.literal("opacity"), value: unit }),
  z.strictObject({ entityId: SpatialEntityIdSchema, property: z.literal("transform"), value: SpatialTransformSchema })
]);
var SpatialGeneratorSchema = z.strictObject({
  generatorId: SpatialGeneratorIdSchema,
  sourceSha256: SpatialDigestSchema,
  closureSha256: SpatialDigestSchema,
  parametersSha256: SpatialDigestSchema,
  seed: z.number().int().safe().min(0).max(4294967295),
  outputSha256: SpatialDigestSchema,
  execution: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("qualified"), runtimeSha256: SpatialDigestSchema }),
    z.strictObject({ kind: z.literal("attempt"), attemptId: z.string().min(1).max(128), runtimeSha256: SpatialDigestSchema })
  ]),
  editableKeys: z.array(z.strictObject({ key: z.string().min(1).max(256), properties: z.array(z.enum(["color", "opacity", "transform"])).min(1).max(3) })).max(SPATIAL_SCENE_LIMITS.entities)
});
var SpatialSceneV1Schema = z.strictObject({
  kind: z.literal("atet.spatial-scene"),
  schemaVersion: z.literal(1),
  sceneId: SpatialSceneIdSchema,
  coordinates: z.literal("right-handed-y-up-meters"),
  durationUs: SpatialTimeUsSchema.refine((value) => value > 0),
  entities: z.array(SpatialEntitySchema).max(SPATIAL_SCENE_LIMITS.entities),
  cameras: z.array(SpatialCameraSchema).min(1).max(SPATIAL_SCENE_LIMITS.cameras),
  assets: z.array(SpatialAssetManifestSchema).max(SPATIAL_SCENE_LIMITS.assets),
  animations: z.array(SpatialAnimationSchema).max(SPATIAL_SCENE_LIMITS.channels),
  generators: z.array(SpatialGeneratorSchema).max(128),
  overrides: z.array(SpatialOverrideSchema).max(SPATIAL_SCENE_LIMITS.entities)
});
var SpatialPatchOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("add-asset"), asset: SpatialAssetManifestSchema }),
  z.strictObject({ kind: z.literal("replace-asset"), asset: SpatialAssetManifestSchema }),
  z.strictObject({ kind: z.literal("set-mesh-geometry"), entityId: SpatialEntityIdSchema, geometry: SpatialGeometrySchema }),
  z.strictObject({ kind: z.literal("rename-entity"), entityId: SpatialEntityIdSchema, name: z.string().min(1).max(256) }),
  z.strictObject({ kind: z.literal("reparent-entity"), entityId: SpatialEntityIdSchema, parentId: SpatialEntityIdSchema.nullable() }),
  z.strictObject({ kind: z.literal("set-transform"), entityId: SpatialEntityIdSchema, transform: SpatialTransformSchema }),
  z.strictObject({ kind: z.literal("set-color"), entityId: SpatialEntityIdSchema, color }),
  z.strictObject({ kind: z.literal("set-opacity"), entityId: SpatialEntityIdSchema, opacity: unit }),
  z.strictObject({ kind: z.literal("set-camera"), camera: SpatialCameraSchema }),
  z.strictObject({ kind: z.literal("set-channel"), channel: SpatialAnimationSchema }),
  z.strictObject({ kind: z.literal("remove-channel"), channelId: SpatialChannelIdSchema }),
  z.strictObject({ kind: z.literal("add-entity"), entity: SpatialEntitySchema }),
  z.strictObject({ kind: z.literal("remove-entity"), entityId: SpatialEntityIdSchema }),
  z.strictObject({ kind: z.literal("set-override"), override: SpatialOverrideSchema }),
  z.strictObject({ kind: z.literal("remove-override"), entityId: SpatialEntityIdSchema, property: z.enum(["color", "opacity", "transform"]) }),
  z.strictObject({ kind: z.literal("replace-generator-output"), generator: SpatialGeneratorSchema, entities: z.array(SpatialEntitySchema).max(SPATIAL_SCENE_LIMITS.entities) })
]);
var SpatialScenePatchV1Schema = z.strictObject({
  kind: z.literal("atet.spatial-scene-patch"),
  schemaVersion: z.literal(1),
  expectedSceneSha256: SpatialDigestSchema,
  operations: z.array(SpatialPatchOperationSchema).min(1).max(SPATIAL_SCENE_LIMITS.patchOperations)
});
var SpatialShotV1Schema = z.strictObject({
  shotId: SpatialShotIdSchema,
  sceneSha256: SpatialDigestSchema,
  cameraId: SpatialCameraIdSchema,
  range: z.strictObject({ startUs: SpatialTimeUsSchema, endUs: SpatialTimeUsSchema }),
  sceneStartUs: SpatialTimeUsSchema,
  playback: z.enum(["once", "loop", "freeze"]),
  overrides: z.array(SpatialOverrideSchema).max(SPATIAL_SCENE_LIMITS.entities),
  cameraPoseOverride: SpatialPoseSchema.optional()
}).refine((shot) => shot.range.endUs > shot.range.startUs, "Shot range must be nonempty and half-open.");
var matrixNumber = z.number().finite().min(-1000000000000).max(1000000000000);
var SpatialMatrixSchema = z.tuple([
  matrixNumber,
  matrixNumber,
  matrixNumber,
  matrixNumber,
  matrixNumber,
  matrixNumber,
  matrixNumber,
  matrixNumber,
  matrixNumber,
  matrixNumber,
  matrixNumber,
  matrixNumber,
  matrixNumber,
  matrixNumber,
  matrixNumber,
  matrixNumber
]);
var EvaluatedSpatialSceneSchema = z.strictObject({
  kind: z.literal("atet.spatial-snapshot"),
  schemaVersion: z.literal(1),
  sceneSha256: SpatialDigestSchema,
  stateSha256: SpatialDigestSchema,
  viewSha256: SpatialDigestSchema,
  timeUs: SpatialTimeUsSchema,
  camera: SpatialCameraSchema,
  entities: z.array(z.strictObject({
    entity: SpatialEntitySchema,
    worldMatrix: SpatialMatrixSchema,
    visible: z.boolean(),
    selectionId: z.number().int().min(1).max(SPATIAL_SCENE_LIMITS.entities)
  })).max(SPATIAL_SCENE_LIMITS.entities),
  assets: z.array(SpatialAssetManifestSchema).max(SPATIAL_SCENE_LIMITS.assets)
});

// src/spatial-scene/identity.ts
class SpatialSceneError extends AtetCodeError {
  path;
  constructor(code, message, path = "scene") {
    super(code, message, { path });
    this.name = "SpatialSceneError";
    this.path = path;
  }
}
var limits = { maximumDepth: SPATIAL_SCENE_LIMITS.sourceDepth, maximumValues: SPATIAL_SCENE_LIMITS.sourceValues };
function parseSpatialValue(schema, input, name) {
  try {
    const captured = createBoundedJsonValueSnapshot(input, SPATIAL_SCENE_LIMITS.sourceBytes, name, limits);
    const parsed = schema.safeParse(captured.value);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new SpatialSceneError("invalid-data", issue?.message ?? `Invalid ${name}.`, `${name}.${issue?.path.join(".") ?? ""}`);
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof SpatialSceneError)
      throw error;
    throw new SpatialSceneError("invalid-data", error instanceof Error ? error.message : `Invalid ${name}.`, name);
  }
}
function spatialValueSha256(input) {
  return createBoundedJsonSnapshot(input, SPATIAL_SCENE_LIMITS.sourceBytes, "spatial identity", limits).sha256;
}
function spatialStateValueSha256(input) {
  return createBoundedJsonSnapshot(input, SPATIAL_SCENE_LIMITS.sourceBytes * 4, "spatial state identity", {
    maximumDepth: SPATIAL_SCENE_LIMITS.sourceDepth + 4,
    maximumValues: SPATIAL_SCENE_LIMITS.sourceValues + SPATIAL_SCENE_LIMITS.entities * 24
  }).sha256;
}
function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function sortSpatialBy(items, id) {
  return [...items].sort((a, b) => compare(id(a), id(b)));
}
function unique(items, id, path) {
  const result = new Map;
  for (const item of items) {
    const key2 = id(item);
    if (result.has(key2))
      throw new SpatialSceneError("invalid-data", `Duplicate identity ${key2}.`, path);
    result.set(key2, item);
  }
  return result;
}
function requireReference(map, id, path) {
  const result = map.get(id);
  if (result === undefined)
    throw new SpatialSceneError("invalid-data", `Missing reference ${id}.`, path);
  return result;
}
function spatialTopologicalIds(edges, name) {
  const done = new Set;
  const active = new Set;
  const result = [];
  for (const id of edges.keys()) {
    const pending = [{ id, exit: false }];
    while (pending.length) {
      const next = pending.pop();
      if (next.exit) {
        active.delete(next.id);
        done.add(next.id);
        result.push(next.id);
        continue;
      }
      if (done.has(next.id))
        continue;
      if (active.has(next.id))
        throw new SpatialSceneError("invalid-data", `Cycle at ${next.id}.`, name);
      const dependencies = requireReference(edges, next.id, name);
      active.add(next.id);
      pending.push({ id: next.id, exit: true });
      for (const dependency of dependencies)
        pending.push({ id: dependency, exit: false });
    }
  }
  return Object.freeze(result);
}
function generatedSpatialEntityId(generatorId, key2) {
  SpatialGeneratorIdSchema.parse(generatorId);
  if (typeof key2 !== "string" || key2.length < 1 || key2.length > 256)
    throw new SpatialSceneError("invalid-data", "Generator keys must contain 1\u2013256 characters.");
  return `entity_${spatialValueSha256({ domain: "atet.generated-entity.v1", generatorId, key: key2 })}`;
}
function normalizeEntity(entity) {
  if (entity.kind === "mesh")
    return { ...entity, material: { ...entity.material, color: entity.material.color.toLowerCase() } };
  if (entity.kind === "text" || entity.kind === "light")
    return { ...entity, color: entity.color.toLowerCase() };
  return entity;
}
function normalizeAsset(asset) {
  if (asset.interpretation.kind !== "video")
    return asset;
  const rate = asset.interpretation.frameRate;
  let { numerator: divisor, denominator: remainder } = rate;
  while (remainder !== 0) {
    const next = divisor % remainder;
    divisor = remainder;
    remainder = next;
  }
  return { ...asset, interpretation: { ...asset.interpretation, frameRate: { numerator: rate.numerator / divisor, denominator: rate.denominator / divisor } } };
}
function spatialGeneratorOutputSha256(input) {
  const entities = parseSpatialValue(SpatialEntitySchema.array().max(SPATIAL_SCENE_LIMITS.entities), input, "generator output");
  unique(entities, (item) => item.entityId, "generator output");
  return spatialValueSha256({ domain: "atet.generator-output.v1", entities: sortSpatialBy(entities.map(normalizeEntity), (item) => item.entityId) });
}
function spatialAssetManifestSha256(input, dependencyDigests = {}) {
  const asset = normalizeAsset(parseSpatialValue(SpatialAssetManifestSchema, input, "asset manifest"));
  const captured = createBoundedJsonValueSnapshot(dependencyDigests, SPATIAL_SCENE_LIMITS.sourceBytes, "dependency identities", limits).value;
  if (captured === null || Array.isArray(captured) || typeof captured !== "object")
    throw new SpatialSceneError("invalid-data", "Dependency digests must be an object.");
  unique(asset.dependencies, (item) => item, "asset.dependencies");
  const dependencies = [...asset.dependencies].sort(compare).map((assetId) => {
    const sha256 = captured[assetId];
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256))
      throw new SpatialSceneError("invalid-data", `Missing dependency digest for ${assetId}.`);
    return { assetId, sha256 };
  });
  return spatialValueSha256({ domain: "atet.asset-manifest.v1", payload: { sha256: asset.payload.sha256, bytes: asset.payload.bytes }, interpretation: asset.interpretation, dependencies });
}
function spatialAssetClosureDigests(assets) {
  const map = unique(assets, (asset) => asset.assetId, "assets");
  const order = spatialTopologicalIds(new Map(assets.map((asset) => [asset.assetId, asset.dependencies])), "asset dependencies");
  const digests = Object.create(null);
  for (const id of order)
    digests[id] = spatialAssetManifestSha256(map.get(id), digests);
  return Object.freeze(digests);
}
function spatialPropertySupported(entity, property) {
  if ((property === "color" || property === "opacity") && entity.kind === "mesh" && entity.geometry.kind === "asset" && entity.geometry.materialMode === "source")
    return false;
  if (property === "opacity")
    return ["mesh", "image", "video", "diagram"].includes(entity.kind);
  if (property === "color")
    return ["mesh", "text", "light"].includes(entity.kind);
  return true;
}
function validateSpatialOverrides(scene, overrides) {
  const entities = new Map(scene.entities.map((entity) => [entity.entityId, entity]));
  const generators = new Map(scene.generators.map((generator) => [generator.generatorId, generator]));
  unique(overrides, (override) => `${override.entityId}:${override.property}`, "overrides");
  for (const override of overrides) {
    const entity = requireReference(entities, override.entityId, "overrides");
    if (!spatialPropertySupported(entity, override.property))
      throw new SpatialSceneError("conflict", `Entity ${entity.entityId} does not support ${override.property}.`, "overrides");
    if (entity.origin.kind === "generated") {
      const origin = entity.origin;
      const generator = requireReference(generators, origin.generatorId, "overrides");
      if (!generator.editableKeys.some((item) => item.key === origin.key && item.properties.includes(override.property))) {
        throw new SpatialSceneError("conflict", `Undeclared override ${origin.key}.${override.property}.`, "overrides");
      }
    }
    const properties = override.property === "transform" ? ["position", "rotation", "scale"] : [override.property];
    if (scene.animations.some((channel) => channel.targetId === entity.entityId && properties.includes(channel.property))) {
      throw new SpatialSceneError("conflict", `Animation and override both write ${entity.entityId}.${override.property}.`, "overrides");
    }
  }
}
function parseSpatialScene(input) {
  const parsed = parseSpatialValue(SpatialSceneV1Schema, input, "scene");
  const scene = {
    ...parsed,
    entities: sortSpatialBy(parsed.entities.map(normalizeEntity), (item) => item.entityId),
    cameras: sortSpatialBy(parsed.cameras, (item) => item.cameraId),
    assets: sortSpatialBy(parsed.assets.map(normalizeAsset).map((asset) => ({ ...asset, dependencies: [...asset.dependencies].sort(compare) })), (item) => item.assetId),
    animations: sortSpatialBy(parsed.animations, (item) => item.channelId),
    generators: sortSpatialBy(parsed.generators.map((generator) => ({ ...generator, editableKeys: sortSpatialBy(generator.editableKeys.map((item) => ({ ...item, properties: [...item.properties].sort(compare) })), (item) => item.key) })), (item) => item.generatorId),
    overrides: sortSpatialBy(parsed.overrides.map((item) => item.property === "color" ? { ...item, value: item.value.toLowerCase() } : item), (item) => `${item.entityId}:${item.property}`)
  };
  const entities = unique(scene.entities, (entity) => entity.entityId, "entities");
  const cameras = unique(scene.cameras, (camera) => camera.cameraId, "cameras");
  const assets = unique(scene.assets, (asset) => asset.assetId, "assets");
  const generators = unique(scene.generators, (generator) => generator.generatorId, "generators");
  unique(scene.animations, (channel) => channel.channelId, "animations");
  unique(scene.animations, (channel) => `${channel.targetId}:${channel.property}`, "animation writers");
  let payloadBytes = 0;
  for (const asset of scene.assets) {
    unique(asset.dependencies, (id) => id, "asset dependencies");
    payloadBytes += asset.payload.bytes;
    if (payloadBytes > 268435456)
      throw new SpatialSceneError("invalid-data", "Asset closure exceeds 256 MiB.", "assets");
    if ((asset.interpretation.kind === "image" || asset.interpretation.kind === "video") && asset.interpretation.width * asset.interpretation.height > 33554432)
      throw new SpatialSceneError("invalid-data", "Asset exceeds the 32-megapixel limit.", "assets");
    if (asset.interpretation.kind === "metadata" && asset.payload.bytes > 1048576)
      throw new SpatialSceneError("invalid-data", "Retained metadata exceeds one MiB.", "assets");
  }
  spatialTopologicalIds(new Map(scene.assets.map((asset) => [asset.assetId, asset.dependencies])), "asset dependencies");
  spatialTopologicalIds(new Map(scene.entities.map((entity) => [entity.entityId, entity.parentId === null ? [] : [entity.parentId]])), "entity hierarchy");
  const generatedKeys = new Set;
  for (const entity of scene.entities) {
    if (entity.placement.kind === "view")
      requireReference(cameras, entity.placement.cameraId, "placement");
    if (entity.parentId !== null) {
      const parent = requireReference(entities, entity.parentId, "parent");
      const a = parent.placement, b = entity.placement;
      if (a.kind !== b.kind || a.kind === "view" && b.kind === "view" && (a.cameraId !== b.cameraId || a.units !== b.units))
        throw new SpatialSceneError("invalid-data", "Parent and child must share their world or view coordinate domain.", "placement");
    }
    if (entity.origin.kind === "generated") {
      const { generatorId, key: key2 } = entity.origin;
      requireReference(generators, generatorId, "origin");
      if (entity.entityId !== generatedSpatialEntityId(generatorId, key2))
        throw new SpatialSceneError("invalid-data", "Generated entity identity must derive from its generator and stable key.", "origin");
      const identity = `${generatorId}:${key2}`;
      if (generatedKeys.has(identity))
        throw new SpatialSceneError("invalid-data", "Duplicate generator output key.", "origin");
      generatedKeys.add(identity);
    }
    const reference = entity.kind === "mesh" && entity.geometry.kind === "asset" ? { assetId: entity.geometry.assetId, kind: "gltf" } : entity.kind === "text" ? { assetId: entity.fontAssetId, kind: "font" } : ("assetId" in entity) ? { assetId: entity.assetId, kind: entity.kind } : undefined;
    if (reference) {
      const asset = requireReference(assets, reference.assetId, "entity asset");
      if (asset.interpretation.kind !== reference.kind)
        throw new SpatialSceneError("invalid-data", `Entity ${entity.entityId} requires a ${reference.kind} asset.`, "entity asset");
      if (entity.kind === "video" && asset.interpretation.kind === "video" && entity.sourceOffsetUs >= asset.interpretation.durationUs)
        throw new SpatialSceneError("invalid-data", "Video source offset must precede its duration.", "sourceOffsetUs");
    }
  }
  for (const generator of scene.generators) {
    unique(generator.editableKeys, (item) => item.key, "generator editable keys");
    for (const editable of generator.editableKeys) {
      unique(editable.properties, (item) => item, "generator editable properties");
      const entity = entities.get(generatedSpatialEntityId(generator.generatorId, editable.key));
      if (!entity)
        throw new SpatialSceneError("conflict", `Orphan editable key ${editable.key}.`, "generators");
      if (editable.properties.some((property) => !spatialPropertySupported(entity, property)))
        throw new SpatialSceneError("invalid-data", `Editable key ${editable.key} declares an unsupported property.`, "generators");
    }
    const retained = scene.entities.filter((entity) => entity.origin.kind === "generated" && entity.origin.generatorId === generator.generatorId);
    if (spatialGeneratorOutputSha256(retained) !== generator.outputSha256)
      throw new SpatialSceneError("conflict", "Retained generator output does not match its pinned digest.", "generators");
  }
  for (const channel of scene.animations) {
    const entity = entities.get(channel.targetId);
    if (entity === undefined) {
      requireReference(cameras, channel.targetId, "animation target");
      if (channel.property !== "position" && channel.property !== "rotation")
        throw new SpatialSceneError("invalid-data", "Camera animation supports only position and rotation.", "animations");
    } else {
      if (!spatialPropertySupported(entity, channel.property))
        throw new SpatialSceneError("invalid-data", `Unsupported ${channel.property} animation.`, "animations");
      if (entity.origin.kind === "generated") {
        const origin = entity.origin;
        const control = channel.property === "opacity" ? "opacity" : "transform";
        if (!generators.get(origin.generatorId).editableKeys.some((item) => item.key === origin.key && item.properties.includes(control)))
          throw new SpatialSceneError("conflict", `Generated animation requires declared ${control} control.`, "animations");
      }
    }
    let previous = -1;
    for (const key2 of channel.keys) {
      if (key2.timeUs <= previous || key2.timeUs > scene.durationUs)
        throw new SpatialSceneError("invalid-data", "Animation keys must be strictly ordered within scene duration.", "animations");
      previous = key2.timeUs;
    }
  }
  validateSpatialOverrides(scene, scene.overrides);
  return deepFreezeJson(scene);
}
function spatialSceneSha256(input) {
  return spatialValueSha256(parseSpatialScene(input));
}

// src/spatial-scene/evaluate.ts
import { z as z2 } from "zod";

// src/spatial-scene/math.ts
var MAX_ABS_COMPONENT = 1000000000000;
var MAX_IMAGE_DIMENSION = 1e6;
var AFFINE_TOLERANCE = 0.000000000001;
var RIGID_TOLERANCE = 0.00000001;
var MIN_RELATIVE_DETERMINANT = 0.000000000001;
function number(value, label) {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_ABS_COMPONENT) {
    throw new RangeError(`${label} must be finite with magnitude <= ${MAX_ABS_COMPONENT}`);
  }
  return value;
}
function values(value, length, label) {
  if (!Array.isArray(value) || value.length !== length)
    throw new RangeError(`${label} must have ${length} components`);
  for (let index = 0;index < length; index++)
    number(value[index], `${label}[${index}]`);
}
function vec2(x, y) {
  return Object.freeze([number(x, "x"), number(y, "y")]);
}
function vec3(x, y, z2) {
  return Object.freeze([number(x, "x"), number(y, "y"), number(z2, "z")]);
}
function matrix(value) {
  values(value, 16, "matrix");
  return Object.freeze(value);
}
function affine(value) {
  values(value, 16, "transform");
  if (Math.abs(value[3]) > AFFINE_TOLERANCE || Math.abs(value[7]) > AFFINE_TOLERANCE || Math.abs(value[11]) > AFFINE_TOLERANCE || Math.abs(value[15] - 1) > AFFINE_TOLERANCE) {
    throw new RangeError("transform must be affine with bottom row [0,0,0,1]");
  }
}
var IDENTITY_MATRIX = matrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function normalizeQuaternion(q) {
  values(q, 4, "quaternion");
  const length = Math.hypot(...q);
  if (length === 0)
    throw new RangeError("quaternion must be nonzero");
  return Object.freeze([q[0] / length, q[1] / length, q[2] / length, q[3] / length]);
}
function composeTransform(transform) {
  values(transform.position, 3, "position");
  values(transform.scale, 3, "scale");
  const [x, y, z2, w] = normalizeQuaternion(transform.rotation);
  const [sx, sy, sz] = transform.scale;
  return matrix([
    (1 - 2 * (y * y + z2 * z2)) * sx,
    2 * (x * y + z2 * w) * sx,
    2 * (x * z2 - y * w) * sx,
    0,
    2 * (x * y - z2 * w) * sy,
    (1 - 2 * (x * x + z2 * z2)) * sy,
    2 * (y * z2 + x * w) * sy,
    0,
    2 * (x * z2 + y * w) * sz,
    2 * (y * z2 - x * w) * sz,
    (1 - 2 * (x * x + y * y)) * sz,
    0,
    ...transform.position,
    1
  ]);
}
function multiplyTransforms(parent, local) {
  affine(parent);
  affine(local);
  const output = new Array(16).fill(0);
  for (let col = 0;col < 4; col++) {
    for (let row = 0;row < 3; row++) {
      output[col * 4 + row] = parent[row] * local[col * 4] + parent[4 + row] * local[col * 4 + 1] + parent[8 + row] * local[col * 4 + 2] + (col === 3 ? parent[12 + row] : 0);
    }
  }
  output[15] = 1;
  return matrix(output);
}
function invertTransform(transform) {
  affine(transform);
  const scale = Math.max(...[0, 1, 2, 4, 5, 6, 8, 9, 10].map((index) => Math.abs(transform[index])));
  if (scale === 0)
    throw new RangeError("transform is singular");
  const [a, b, c, d, e, f, g, h, i] = [0, 4, 8, 1, 5, 9, 2, 6, 10].map((index) => transform[index] / scale);
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) <= MIN_RELATIVE_DETERMINANT)
    throw new RangeError("transform is singular or ill-conditioned");
  const factor = 1 / det / scale;
  const r00 = (e * i - f * h) * factor, r01 = (c * h - b * i) * factor, r02 = (b * f - c * e) * factor;
  const r10 = (f * g - d * i) * factor, r11 = (a * i - c * g) * factor, r12 = (c * d - a * f) * factor;
  const r20 = (d * h - e * g) * factor, r21 = (b * g - a * h) * factor, r22 = (a * e - b * d) * factor;
  const [tx, ty, tz] = [transform[12], transform[13], transform[14]];
  return matrix([
    r00,
    r10,
    r20,
    0,
    r01,
    r11,
    r21,
    0,
    r02,
    r12,
    r22,
    0,
    -(r00 * tx + r01 * ty + r02 * tz),
    -(r10 * tx + r11 * ty + r12 * tz),
    -(r20 * tx + r21 * ty + r22 * tz),
    1
  ]);
}
function transformPoint(transform, point) {
  affine(transform);
  values(point, 3, "point");
  return apply(transform, point, true);
}
function transformDirection(transform, direction) {
  affine(transform);
  values(direction, 3, "direction");
  return apply(transform, direction, false);
}
function apply(m, v, translate) {
  return vec3(m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + (translate ? m[12] : 0), m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + (translate ? m[13] : 0), m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + (translate ? m[14] : 0));
}
function slerpQuaternion(from, to, t) {
  number(t, "t");
  if (t < 0 || t > 1)
    throw new RangeError("t must be in [0,1]");
  const a = normalizeQuaternion(from);
  const normalizedTo = normalizeQuaternion(to);
  let dot = a.reduce((sum, value, index) => sum + value * normalizedTo[index], 0);
  const b = dot < 0 ? normalizedTo.map((value) => -value) : normalizedTo;
  dot = Math.min(1, Math.max(0, Math.abs(dot)));
  let left = 1 - t, right = t;
  if (dot < 0.9995) {
    const angle = Math.acos(dot), sine = Math.sin(angle);
    left = Math.sin((1 - t) * angle) / sine;
    right = Math.sin(t * angle) / sine;
  }
  return normalizeQuaternion([
    left * a[0] + right * b[0],
    left * a[1] + right * b[1],
    left * a[2] + right * b[2],
    left * a[3] + right * b[3]
  ]);
}
function projection(p) {
  for (const value of [p.width, p.height]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_IMAGE_DIMENSION)
      throw new RangeError("image dimensions must be positive bounded integers");
  }
  number(p.near, "near");
  number(p.far, "far");
  if (p.near <= 0 || p.far <= p.near)
    throw new RangeError("clipping requires 0 < near < far");
  if (p.kind === "perspective") {
    for (const key2 of ["fx", "fy", "cx", "cy"])
      number(p[key2], key2);
    if (p.fx <= 0 || p.fy <= 0)
      throw new RangeError("focal lengths in pixels must be positive");
  } else if (p.kind === "orthographic") {
    for (const key2 of ["left", "right", "bottom", "top"])
      number(p[key2], key2);
    if (p.left >= p.right || p.bottom >= p.top)
      throw new RangeError("orthographic extents must be ordered");
  } else {
    throw new RangeError("unsupported projection");
  }
}
function camera(camera2) {
  projection(camera2.projection);
  const m = camera2.cameraToWorld;
  affine(m);
  const columns = [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]];
  for (let i = 0;i < 3; i++) {
    for (let j = i;j < 3; j++) {
      const dot = columns[i].reduce((sum, value, index) => sum + value * columns[j][index], 0);
      if (Math.abs(dot - (i === j ? 1 : 0)) > RIGID_TOLERANCE)
        throw new RangeError("camera pose must be rigid without scale or shear");
    }
  }
  const determinant = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
  if (determinant <= 0)
    throw new RangeError("camera pose must preserve handedness");
}
function projectPoint(view, worldPoint) {
  camera(view);
  values(worldPoint, 3, "world point");
  const local = apply(invertTransform(view.cameraToWorld), worldPoint, true);
  const depthMeters = -local[2];
  if (depthMeters <= 0)
    return null;
  const p = view.projection;
  const pixel = p.kind === "perspective" ? vec2(p.fx * local[0] / depthMeters + p.cx, p.cy - p.fy * local[1] / depthMeters) : vec2((local[0] - p.left) / (p.right - p.left) * p.width, (p.top - local[1]) / (p.top - p.bottom) * p.height);
  return Object.freeze({
    pixel,
    depthMeters,
    insideImage: pixel[0] >= 0 && pixel[0] < p.width && pixel[1] >= 0 && pixel[1] < p.height,
    insideClip: depthMeters >= p.near && depthMeters <= p.far
  });
}
function unprojectPixel(view, pixel, depthMeters) {
  camera(view);
  values(pixel, 2, "pixel");
  number(depthMeters, "depth");
  if (depthMeters <= 0)
    throw new RangeError("axial depth must be positive");
  const p = view.projection;
  const local = p.kind === "perspective" ? [(pixel[0] - p.cx) / p.fx * depthMeters, (p.cy - pixel[1]) / p.fy * depthMeters, -depthMeters] : [p.left + pixel[0] / p.width * (p.right - p.left), p.top - pixel[1] / p.height * (p.top - p.bottom), -depthMeters];
  values(local, 3, "unprojected local point");
  return apply(view.cameraToWorld, local, true);
}
function pixelRay(view, pixel) {
  camera(view);
  values(pixel, 2, "pixel");
  const p = view.projection;
  const x = p.kind === "perspective" ? (pixel[0] - p.cx) / p.fx : p.left + pixel[0] / p.width * (p.right - p.left);
  const y = p.kind === "perspective" ? (p.cy - pixel[1]) / p.fy : p.top - pixel[1] / p.height * (p.top - p.bottom);
  const length = p.kind === "perspective" ? Math.hypot(x, y, 1) : 1;
  const origin = apply(view.cameraToWorld, p.kind === "perspective" ? [0, 0, 0] : vec3(x, y, 0), true);
  const direction = apply(view.cameraToWorld, p.kind === "perspective" ? vec3(x / length, y / length, -1 / length) : [0, 0, -1], false);
  return Object.freeze({
    origin,
    direction,
    nearDistanceMeters: number(p.near * length, "near ray distance"),
    farDistanceMeters: number(p.far * length, "far ray distance")
  });
}
function transformBounds(transform, bounds) {
  affine(transform);
  values(bounds.min, 3, "bounds min");
  values(bounds.max, 3, "bounds max");
  if (bounds.min.some((value, index) => value > bounds.max[index]))
    throw new RangeError("bounds must have min <= max");
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let mask = 0;mask < 8; mask++) {
    const point = apply(transform, [mask & 1 ? bounds.max[0] : bounds.min[0], mask & 2 ? bounds.max[1] : bounds.min[1], mask & 4 ? bounds.max[2] : bounds.min[2]], true);
    for (let index = 0;index < 3; index++) {
      min[index] = Math.min(min[index], point[index]);
      max[index] = Math.max(max[index], point[index]);
    }
  }
  return Object.freeze({ min: vec3(min[0], min[1], min[2]), max: vec3(max[0], max[1], max[2]) });
}
function cameraMathView(camera2) {
  return Object.freeze({ projection: camera2.projection, cameraToWorld: composeTransform({ ...camera2.pose, scale: [1, 1, 1] }) });
}

// src/spatial-scene/evaluate.ts
var EvaluatedOptionsSchema = z2.strictObject({
  timeUs: SpatialTimeUsSchema,
  cameraId: SpatialCameraIdSchema,
  overrides: z2.array(SpatialOverrideSchema).max(SPATIAL_SCENE_LIMITS.entities).optional(),
  cameraPoseOverride: SpatialPoseSchema.optional()
});
function mergeSpatialOverrides(sceneOverrides, shotOverrides) {
  const effective = new Map(sceneOverrides.map((override) => [`${override.entityId}:${override.property}`, override]));
  const seen = new Set;
  for (const override of shotOverrides) {
    const key2 = `${override.entityId}:${override.property}`;
    if (seen.has(key2))
      throw new SpatialSceneError("conflict", `Duplicate shot override ${key2}.`, "shot.overrides");
    seen.add(key2);
    effective.set(key2, override);
  }
  return deepFreezeJson(sortSpatialBy([...effective.values()], (item) => `${item.entityId}:${item.property}`));
}
function applySpatialEntityOverride(entity, override) {
  if (!spatialPropertySupported(entity, override.property))
    throw new SpatialSceneError("conflict", `Unsupported override ${entity.entityId}.${override.property}.`);
  if (override.property === "transform")
    return { ...entity, transform: override.value };
  if (override.property === "color") {
    const color2 = override.value.toLowerCase();
    if (entity.kind === "mesh")
      return { ...entity, material: { ...entity.material, color: color2 } };
    if (entity.kind === "text" || entity.kind === "light")
      return { ...entity, color: color2 };
  }
  if (override.property === "opacity") {
    if (entity.kind === "mesh")
      return { ...entity, material: { ...entity.material, opacity: override.value } };
    if (entity.kind === "image" || entity.kind === "diagram" || entity.kind === "video")
      return { ...entity, opacity: override.value };
  }
  throw new SpatialSceneError("conflict", `Unsupported override ${entity.entityId}.${override.property}.`);
}
function sampleChannel(channel, timeUs) {
  const keys = channel.keys;
  if (timeUs <= keys[0].timeUs)
    return keys[0].value;
  if (timeUs >= keys[keys.length - 1].timeUs)
    return keys[keys.length - 1].value;
  let lower = 0, upper = keys.length - 1;
  while (upper - lower > 1) {
    const middle = Math.floor((lower + upper) / 2);
    if (keys[middle].timeUs <= timeUs)
      lower = middle;
    else
      upper = middle;
  }
  const a = keys[lower], b = keys[upper];
  if (channel.interpolation === "step")
    return a.value;
  const t = (timeUs - a.timeUs) / (b.timeUs - a.timeUs);
  if (channel.property === "rotation") {
    return slerpQuaternion(channel.keys[lower].value, channel.keys[upper].value, t);
  }
  if (typeof a.value === "number" && typeof b.value === "number")
    return a.value + (b.value - a.value) * t;
  const av = a.value, bv = b.value;
  return av.map((value, index) => value + (bv[index] - value) * t);
}
function validateSpatialShot(sceneInput, shotInput) {
  const scene = parseSpatialScene(sceneInput);
  const shot = parseSpatialValue(SpatialShotV1Schema, shotInput, "shot");
  if (shot.sceneSha256 !== spatialValueSha256(scene))
    throw new SpatialSceneError("conflict", "Shot pins another scene revision.", "shot.sceneSha256");
  if (!scene.cameras.some((camera2) => camera2.cameraId === shot.cameraId))
    throw new SpatialSceneError("invalid-data", "Shot camera is absent from its scene.", "shot.cameraId");
  if (shot.sceneStartUs >= scene.durationUs)
    throw new SpatialSceneError("invalid-data", "Shot scene start must precede scene duration.", "shot.sceneStartUs");
  if (shot.playback === "once" && shot.sceneStartUs + shot.range.endUs - shot.range.startUs > scene.durationUs)
    throw new SpatialSceneError("invalid-data", "Once playback exceeds scene duration.", "shot.range");
  validateSpatialOverrides(scene, mergeSpatialOverrides(scene.overrides, shot.overrides));
  if (shot.cameraPoseOverride && scene.animations.some((channel) => channel.targetId === shot.cameraId))
    throw new SpatialSceneError("conflict", "Camera animation and shot pose override both own camera pose.", "shot.cameraPoseOverride");
  return deepFreezeJson(shot);
}
function evaluateSpatialScene(sceneInput, options) {
  const scene = parseSpatialScene(sceneInput);
  const capturedOptions = parseSpatialValue(EvaluatedOptionsSchema, options, "evaluation options");
  const timeUs = capturedOptions.timeUs;
  if (timeUs > scene.durationUs)
    throw new SpatialSceneError("invalid-data", "Evaluation time exceeds scene duration.", "timeUs");
  let camera2 = scene.cameras.find((item) => item.cameraId === capturedOptions.cameraId);
  if (!camera2)
    throw new SpatialSceneError("not-found", `Unknown camera ${capturedOptions.cameraId}.`, "cameraId");
  const overrides = mergeSpatialOverrides(scene.overrides, capturedOptions.overrides ?? []);
  validateSpatialOverrides(scene, overrides);
  if (capturedOptions.cameraPoseOverride && scene.animations.some((channel) => channel.targetId === camera2.cameraId))
    throw new SpatialSceneError("conflict", "Camera animation conflicts with camera pose override.", "cameraPoseOverride");
  const entities = new Map(scene.entities.map((entity) => [entity.entityId, entity]));
  for (const channel of scene.animations) {
    const value = sampleChannel(channel, timeUs);
    if (channel.targetId === camera2.cameraId) {
      camera2 = { ...camera2, pose: { ...camera2.pose, [channel.property]: value } };
    } else {
      const entity = entities.get(channel.targetId);
      if (!entity)
        continue;
      if (channel.property === "opacity")
        entities.set(entity.entityId, applySpatialEntityOverride(entity, { entityId: entity.entityId, property: "opacity", value }));
      else
        entities.set(entity.entityId, { ...entity, transform: { ...entity.transform, [channel.property]: value } });
    }
  }
  for (const override of overrides)
    entities.set(override.entityId, applySpatialEntityOverride(entities.get(override.entityId), override));
  if (capturedOptions.cameraPoseOverride)
    camera2 = { ...camera2, pose: capturedOptions.cameraPoseOverride };
  const matrices = new Map;
  const visibility = new Map;
  const order = spatialTopologicalIds(new Map(scene.entities.map((entity) => [entity.entityId, entity.parentId === null ? [] : [entity.parentId]])), "entity hierarchy");
  for (const id of order) {
    const entity = entities.get(id);
    try {
      const local = composeTransform(entity.transform);
      matrices.set(id, entity.parentId === null ? local : multiplyTransforms(matrices.get(entity.parentId), local));
    } catch (error) {
      throw new SpatialSceneError("invalid-data", error instanceof Error ? error.message : "Invalid evaluated transform.", `entities.${id}.transform`);
    }
    visibility.set(id, entity.visible && (entity.parentId === null || visibility.get(entity.parentId) === true));
  }
  const evaluated = scene.entities.map((source, index) => ({
    entity: entities.get(source.entityId),
    worldMatrix: matrices.get(source.entityId),
    visible: visibility.get(source.entityId),
    selectionId: index + 1
  }));
  const assetDigests = spatialAssetClosureDigests(scene.assets);
  const stateSha256 = spatialStateValueSha256({ domain: "atet.spatial-state.v1", timeUs, entities: evaluated, assetDigests });
  const viewSha256 = spatialValueSha256({ domain: "atet.spatial-view.v1", stateSha256, camera: camera2 });
  const result = EvaluatedSpatialSceneSchema.parse({
    kind: "atet.spatial-snapshot",
    schemaVersion: 1,
    sceneSha256: spatialValueSha256(scene),
    stateSha256,
    viewSha256,
    timeUs,
    camera: camera2,
    entities: evaluated.map((item) => ({ ...item, visible: item.visible && (item.entity.placement.kind === "world" || item.entity.placement.cameraId === camera2.cameraId) })),
    assets: scene.assets
  });
  return deepFreezeJson(result);
}

// src/spatial-scene/patch.ts
function diffCollection(collection, before, after, identify) {
  const old = new Map(before.map((item) => [identify(item), item]));
  const current = new Map(after.map((item) => [identify(item), item]));
  const result = [];
  for (const id of [...new Set([...old.keys(), ...current.keys()])].sort()) {
    const a = old.get(id), b = current.get(id);
    if (a === undefined || b === undefined) {
      result.push({ kind: a === undefined ? "added" : "removed", collection, id, properties: Object.keys(a ?? b).sort() });
    } else {
      const aRecord = a, bRecord = b;
      const properties = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter((key2) => spatialValueSha256(Object.hasOwn(a, key2) ? { value: aRecord[key2] } : {}) !== spatialValueSha256(Object.hasOwn(b, key2) ? { value: bRecord[key2] } : {}));
      if (properties.length)
        result.push({ kind: "changed", collection, id, properties });
    }
  }
  return result;
}
function applySpatialScenePatch(sceneInput, patchInput) {
  const original = parseSpatialScene(sceneInput);
  const patch = parseSpatialValue(SpatialScenePatchV1Schema, patchInput, "scene patch");
  if (patch.expectedSceneSha256 !== spatialValueSha256(original))
    throw new SpatialSceneError("conflict", "Scene revision changed; inspect and rebase the patch.", "expectedSceneSha256");
  const entities = new Map(original.entities.map((entity) => [entity.entityId, entity]));
  const assets = new Map(original.assets.map((asset) => [asset.assetId, asset]));
  const addressedGeometry = new Set, replacedGenerators = new Set;
  const cameras = new Map(original.cameras.map((camera2) => [camera2.cameraId, camera2]));
  const animations = new Map(original.animations.map((channel) => [channel.channelId, channel]));
  const generators = new Map(original.generators.map((generator) => [generator.generatorId, generator]));
  const overrides = new Map(original.overrides.map((override) => [`${override.entityId}:${override.property}`, override]));
  function authored(id) {
    const entity = entities.get(id);
    if (!entity)
      throw new SpatialSceneError("not-found", `Entity ${id} does not exist.`, "operations");
    if (entity.origin.kind !== "authored")
      throw new SpatialSceneError("conflict", "Generated entities can be edited only through declared overrides or retained output replacement.", "operations");
    return entity;
  }
  for (const operation of patch.operations) {
    switch (operation.kind) {
      case "add-asset":
        if (assets.has(operation.asset.assetId))
          throw new SpatialSceneError("conflict", `Asset ${operation.asset.assetId} already exists.`);
        assets.set(operation.asset.assetId, operation.asset);
        break;
      case "replace-asset":
        if (!assets.has(operation.asset.assetId))
          throw new SpatialSceneError("not-found", `Asset ${operation.asset.assetId} does not exist.`);
        assets.set(operation.asset.assetId, operation.asset);
        break;
      case "set-mesh-geometry": {
        const entity = authored(operation.entityId);
        if (entity.kind !== "mesh")
          throw new SpatialSceneError("conflict", "Geometry replacement requires an authored mesh wrapper.");
        entities.set(operation.entityId, { ...entity, geometry: operation.geometry });
        addressedGeometry.add(operation.entityId);
        break;
      }
      case "rename-entity":
        entities.set(operation.entityId, { ...authored(operation.entityId), name: operation.name });
        break;
      case "reparent-entity":
        entities.set(operation.entityId, { ...authored(operation.entityId), parentId: operation.parentId });
        break;
      case "set-transform":
        entities.set(operation.entityId, { ...authored(operation.entityId), transform: operation.transform });
        break;
      case "set-color":
        entities.set(operation.entityId, applySpatialEntityOverride(authored(operation.entityId), { entityId: operation.entityId, property: "color", value: operation.color }));
        break;
      case "set-opacity":
        entities.set(operation.entityId, applySpatialEntityOverride(authored(operation.entityId), { entityId: operation.entityId, property: "opacity", value: operation.opacity }));
        break;
      case "set-camera":
        cameras.set(operation.camera.cameraId, operation.camera);
        break;
      case "set-channel":
        animations.set(operation.channel.channelId, operation.channel);
        break;
      case "remove-channel":
        if (!animations.delete(operation.channelId))
          throw new SpatialSceneError("not-found", `Channel ${operation.channelId} does not exist.`);
        break;
      case "add-entity":
        if (entities.has(operation.entity.entityId))
          throw new SpatialSceneError("conflict", `Entity ${operation.entity.entityId} already exists.`);
        if (operation.entity.origin.kind !== "authored")
          throw new SpatialSceneError("conflict", "Add generated entities through retained generator output replacement.");
        entities.set(operation.entity.entityId, operation.entity);
        if (operation.entity.kind === "mesh")
          addressedGeometry.add(operation.entity.entityId);
        break;
      case "remove-entity":
        authored(operation.entityId);
        entities.delete(operation.entityId);
        break;
      case "set-override":
        overrides.set(`${operation.override.entityId}:${operation.override.property}`, operation.override);
        break;
      case "remove-override":
        if (!overrides.delete(`${operation.entityId}:${operation.property}`))
          throw new SpatialSceneError("not-found", "Override does not exist.");
        break;
      case "replace-generator-output": {
        const generatorId = operation.generator.generatorId;
        replacedGenerators.add(generatorId);
        for (const entity of entities.values())
          if (entity.origin.kind === "generated" && entity.origin.generatorId === generatorId)
            entities.delete(entity.entityId);
        for (const entity of operation.entities) {
          if (entity.origin.kind !== "generated" || entity.origin.generatorId !== generatorId)
            throw new SpatialSceneError("conflict", "Generator replacement must contain only its own retained output.");
          if (entities.has(entity.entityId))
            throw new SpatialSceneError("conflict", `Generator output collides with ${entity.entityId}.`);
          entities.set(entity.entityId, entity);
        }
        generators.set(generatorId, operation.generator);
        break;
      }
    }
  }
  const scene = parseSpatialScene({ ...original, assets: [...assets.values()], entities: [...entities.values()], cameras: [...cameras.values()], animations: [...animations.values()], generators: [...generators.values()], overrides: [...overrides.values()] });
  const beforeAssets = new Map(original.assets.map((asset) => [asset.assetId, asset]));
  const oldClosure = spatialAssetClosureDigests(original.assets), newClosure = spatialAssetClosureDigests(scene.assets);
  for (const entity of scene.entities) {
    const assetId = entity.kind === "mesh" && entity.geometry.kind === "asset" ? entity.geometry.assetId : entity.kind === "text" ? entity.fontAssetId : ("assetId" in entity) ? entity.assetId : undefined;
    if (assetId === undefined)
      continue;
    if (entity.origin.kind === "generated" && oldClosure[assetId] !== undefined && oldClosure[assetId] !== newClosure[assetId] && !replacedGenerators.has(entity.origin.generatorId)) {
      throw new SpatialSceneError("conflict", "Changing a generated part's asset closure requires explicit retained generator output replacement.");
    }
    if (entity.kind === "mesh" && entity.geometry.kind === "asset" && (entity.geometry.nodeIndex !== undefined || entity.geometry.clip !== undefined) && beforeAssets.has(assetId) && beforeAssets.get(assetId).payload.sha256 !== assets.get(assetId).payload.sha256 && !addressedGeometry.has(entity.entityId) && !(entity.origin.kind === "generated" && replacedGenerators.has(entity.origin.generatorId))) {
      throw new SpatialSceneError("conflict", "Replacing addressed GLB bytes requires explicit set-mesh-geometry with the new local node/clip addresses; internal correspondence is not inferred.");
    }
  }
  const diff = [
    ...diffCollection("assets", original.assets, scene.assets, (asset) => asset.assetId),
    ...diffCollection("entities", original.entities, scene.entities, (entity) => entity.entityId),
    ...diffCollection("cameras", original.cameras, scene.cameras, (camera2) => camera2.cameraId),
    ...diffCollection("animations", original.animations, scene.animations, (channel) => channel.channelId),
    ...diffCollection("generators", original.generators, scene.generators, (generator) => generator.generatorId),
    ...diffCollection("overrides", original.overrides, scene.overrides, (override) => `${override.entityId}:${override.property}`)
  ];
  return deepFreezeJson({ scene, sceneSha256: spatialValueSha256(scene), diff });
}

// src/spatial-scene/inspect.ts
function localBounds(entity) {
  let half;
  if (entity.kind === "mesh") {
    switch (entity.geometry.kind) {
      case "asset":
        return { status: "unknown", reason: "requires-asset-decoding" };
      case "box":
        half = entity.geometry.size.map((value) => value / 2);
        break;
      case "plane":
        half = [entity.geometry.width / 2, entity.geometry.height / 2, 0];
        break;
      case "sphere":
        half = [entity.geometry.radius, entity.geometry.radius, entity.geometry.radius];
        break;
      case "cylinder":
        half = [entity.geometry.radius, entity.geometry.height / 2, entity.geometry.radius];
        break;
    }
  } else if (entity.kind === "image" || entity.kind === "diagram" || entity.kind === "video")
    half = [entity.width / 2, entity.height / 2, 0];
  else
    return { status: "unknown", reason: entity.kind === "text" ? "requires-text-layout" : entity.kind === "splat" ? "requires-asset-decoding" : "no-surface" };
  return { min: [-half[0], -half[1], -half[2]], max: half };
}
function inspectSpatialScene(input) {
  const scene = parseSpatialScene(input);
  const snapshot = evaluateSpatialScene(scene, { timeUs: 0, cameraId: scene.cameras[0].cameraId });
  const digests = spatialAssetClosureDigests(scene.assets);
  return deepFreezeJson({
    sceneId: scene.sceneId,
    sceneSha256: spatialValueSha256(scene),
    durationUs: scene.durationUs,
    entities: snapshot.entities.map(({ entity, worldMatrix }) => {
      const origin = entity.origin;
      const declared = origin.kind === "generated" ? scene.generators.find((generator) => generator.generatorId === origin.generatorId).editableKeys.find((item) => item.key === origin.key)?.properties ?? [] : ["color", "opacity", "transform"].filter((property) => spatialPropertySupported(entity, property));
      const animatedProperties = scene.animations.filter((channel) => channel.targetId === entity.entityId).map((channel) => channel.property);
      const editableControls = declared.filter((property) => !animatedProperties.some((animated) => animated === property || property === "transform" && ["position", "rotation", "scale"].includes(animated)));
      const local = localBounds(entity);
      const bounds = "status" in local ? local : { status: "authored-enclosure", coordinateDomain: entity.placement, atTimeUs: 0, bounds: transformBounds(worldMatrix, local) };
      const assetIds = entity.kind === "mesh" && entity.geometry.kind === "asset" ? [entity.geometry.assetId] : entity.kind === "text" ? [entity.fontAssetId] : ("assetId" in entity) ? [entity.assetId] : [];
      return { entityId: entity.entityId, name: entity.name, kind: entity.kind, origin, parentId: entity.parentId, placement: entity.placement, editableControls, animatedProperties, assetIds, bounds };
    }),
    cameras: scene.cameras,
    assets: scene.assets.map((manifest) => ({ assetId: manifest.assetId, manifestSha256: digests[manifest.assetId], manifest })),
    generators: scene.generators
  });
}

// src/spatial-scene/time.ts
function gcd(a, b) {
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}
function rational(numerator, denominator) {
  const divisor = gcd(numerator, denominator);
  return Object.freeze({ numerator: String(numerator / divisor), denominator: String(denominator / divisor) });
}
function integer(input, name) {
  if (!Number.isSafeInteger(input) || input < 0)
    throw new SpatialSceneError("invalid-data", `${name} must be a nonnegative safe integer.`);
  return BigInt(input);
}
function duration(input) {
  const value = parseSpatialValue(SpatialTimeUsSchema, input, "durationUs");
  if (value === 0)
    throw new SpatialSceneError("invalid-data", "Output duration must be positive.");
  return BigInt(value);
}
function reduceSpatialFrameRate(input) {
  const rate = parseSpatialValue(SpatialFrameRateSchema, input, "frame rate");
  const divisor = Number(gcd(BigInt(rate.numerator), BigInt(rate.denominator)));
  return Object.freeze({ numerator: rate.numerator / divisor, denominator: rate.denominator / divisor });
}
function spatialFrameCount(durationUs, rateInput) {
  const end = duration(durationUs), rate = reduceSpatialFrameRate(rateInput);
  const numerator = end * BigInt(rate.numerator), denominator = 1000000n * BigInt(rate.denominator);
  return Number((numerator + denominator - 1n) / denominator);
}
function spatialFrameSample(frameIndex, durationUs, rateInput) {
  const index = integer(frameIndex, "frameIndex"), end = duration(durationUs), rate = reduceSpatialFrameRate(rateInput);
  const numerator = index * 1000000n * BigInt(rate.denominator), denominator = BigInt(rate.numerator);
  if (numerator >= end * denominator)
    throw new SpatialSceneError("invalid-data", "Frame lies outside the half-open duration before quantization.", "frameIndex");
  const timeUs = Number((2n * numerator + denominator) / (2n * denominator));
  return deepFreezeJson({ frameIndex, timeUs, exactTimeUs: rational(numerator, denominator) });
}
function spatialOutputDuration(durationUs, rateInput) {
  const rate = reduceSpatialFrameRate(rateInput);
  return rational(BigInt(spatialFrameCount(durationUs, rate)) * 1000000n * BigInt(rate.denominator), BigInt(rate.numerator));
}

// src/spatial-scene/authoring.ts
function createSpatialSceneStarter() {
  const transform = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
  const common = { parentId: null, placement: { kind: "world" }, origin: { kind: "authored" }, visible: true };
  return parseSpatialScene({
    kind: "atet.spatial-scene",
    schemaVersion: 1,
    sceneId: "scene_starter",
    coordinates: "right-handed-y-up-meters",
    durationUs: 4000000,
    entities: [
      {
        ...common,
        entityId: "entity_product",
        name: "Product",
        kind: "mesh",
        transform,
        geometry: { kind: "box", size: [1.4, 1.4, 1.4] },
        material: { kind: "standard", color: "#3674ee", opacity: 1, roughness: 0.35, metalness: 0.1 }
      },
      {
        ...common,
        entityId: "entity_pedestal",
        name: "Pedestal",
        kind: "mesh",
        transform: { ...transform, position: [0, -0.9, 0] },
        geometry: { kind: "cylinder", radius: 1.15, height: 0.35 },
        material: { kind: "standard", color: "#cbd5e1", opacity: 1, roughness: 0.7, metalness: 0 }
      },
      {
        ...common,
        entityId: "entity_fill",
        name: "Fill",
        kind: "light",
        transform,
        light: "ambient",
        color: "#ffffff",
        intensity: 2
      },
      {
        ...common,
        entityId: "entity_key",
        name: "Key",
        kind: "light",
        transform: { ...transform, position: [3, 4, 5] },
        light: "directional",
        color: "#ffffff",
        intensity: 3
      }
    ],
    cameras: [{
      cameraId: "camera_hero",
      name: "Hero",
      pose: { position: [0, 0.3, 5], rotation: [0, 0, 0, 1] },
      projection: { kind: "perspective", width: 960, height: 540, fx: 650, fy: 650, cx: 480, cy: 270, near: 0.1, far: 100 }
    }],
    animations: [{
      channelId: "channel_turn",
      targetId: "entity_product",
      property: "rotation",
      interpolation: "slerp",
      keys: [{ timeUs: 0, value: [0, 0, 0, 1] }, { timeUs: 2000000, value: [0, 0.7071067811865475, 0, 0.7071067811865476] }, { timeUs: 4000000, value: [0, 1, 0, 0] }]
    }],
    assets: [],
    generators: [],
    overrides: []
  });
}

// src/spatial-scene/gltf.ts
import { z as z3 } from "zod";
var SPATIAL_GLB_PROFILE = "atet.glb-triangles-trs-pbr-basecolor-v1";
var SPATIAL_GLB_LIMITS = Object.freeze({
  bytes: 134217728,
  jsonBytes: 2097152,
  jsonValues: 200000,
  jsonDepth: 32,
  nodes: 4096,
  meshes: 256,
  primitives: 256,
  verticesPerPrimitive: 65536,
  triangles: 1e5,
  decodedAccessorValues: 2000000,
  accessors: 4096,
  bufferViews: 4096,
  materials: 256,
  images: 128,
  imageBytes: 16777216,
  imageTotalBytes: 33554432,
  imagePixels: 67108864,
  clips: 256,
  channels: 4096,
  animationKeys: 4096,
  durationSeconds: 3600
});
var finite = z3.number().finite().min(-1e6).max(1e6);
var index = z3.number().int().min(0).max(65535);
var unit2 = z3.number().finite().min(0).max(1);
var vec32 = z3.tuple([finite, finite, finite]);
var quaternion = z3.tuple([unit2.min(-1), unit2.min(-1), unit2.min(-1), unit2.min(-1)]);
var metadata = { name: z3.string().max(1024).optional(), extras: z3.unknown().optional(), extensions: z3.never().optional() };
var byteOffset = z3.number().int().min(0).max(SPATIAL_GLB_LIMITS.bytes);
var textureInfo = z3.strictObject({ ...metadata, index, texCoord: z3.literal(0).optional() });
var samplerSchema = z3.strictObject({
  ...metadata,
  magFilter: z3.union([z3.literal(9728), z3.literal(9729)]).optional(),
  minFilter: z3.union([z3.literal(9728), z3.literal(9729), z3.literal(9984), z3.literal(9985), z3.literal(9986), z3.literal(9987)]).optional(),
  wrapS: z3.union([z3.literal(33071), z3.literal(33648), z3.literal(10497)]).default(10497),
  wrapT: z3.union([z3.literal(33071), z3.literal(33648), z3.literal(10497)]).default(10497)
});
var nodeSchema = z3.strictObject({
  ...metadata,
  children: z3.array(index).max(SPATIAL_GLB_LIMITS.nodes).default([]),
  mesh: index.optional(),
  translation: vec32.optional(),
  rotation: quaternion.optional(),
  scale: vec32.optional(),
  matrix: z3.array(finite).length(16).optional()
});
var accessorSchema = z3.strictObject({
  ...metadata,
  bufferView: index,
  byteOffset: byteOffset.default(0),
  componentType: z3.union([z3.literal(5121), z3.literal(5123), z3.literal(5125), z3.literal(5126)]),
  normalized: z3.boolean().default(false),
  count: z3.number().int().min(1).max(SPATIAL_GLB_LIMITS.triangles * 3),
  type: z3.enum(["SCALAR", "VEC2", "VEC3", "VEC4"]),
  min: z3.array(finite).min(1).max(4).optional(),
  max: z3.array(finite).min(1).max(4).optional()
});
var gltfSchema = z3.strictObject({
  ...metadata,
  asset: z3.strictObject({ version: z3.literal("2.0"), minVersion: z3.literal("2.0").optional(), generator: z3.string().max(1024).optional(), copyright: z3.string().max(4096).optional(), extras: z3.unknown().optional(), extensions: z3.never().optional() }),
  extensionsUsed: z3.array(z3.never()).optional(),
  extensionsRequired: z3.array(z3.never()).optional(),
  buffers: z3.array(z3.strictObject({ ...metadata, byteLength: z3.number().int().min(1).max(SPATIAL_GLB_LIMITS.bytes) })).length(1),
  bufferViews: z3.array(z3.strictObject({ ...metadata, buffer: z3.literal(0), byteOffset: byteOffset.default(0), byteLength: z3.number().int().min(1).max(SPATIAL_GLB_LIMITS.bytes), byteStride: z3.number().int().min(4).max(252).optional(), target: z3.union([z3.literal(34962), z3.literal(34963)]).optional() })).max(SPATIAL_GLB_LIMITS.bufferViews),
  accessors: z3.array(accessorSchema).max(SPATIAL_GLB_LIMITS.accessors),
  scene: index.optional(),
  scenes: z3.array(z3.strictObject({ ...metadata, nodes: z3.array(index).min(1).max(SPATIAL_GLB_LIMITS.nodes) })).min(1).max(128),
  nodes: z3.array(nodeSchema).min(1).max(SPATIAL_GLB_LIMITS.nodes),
  meshes: z3.array(z3.strictObject({ ...metadata, primitives: z3.array(z3.strictObject({
    ...metadata,
    attributes: z3.strictObject({ POSITION: index, NORMAL: index.optional(), TEXCOORD_0: index.optional() }),
    indices: index.optional(),
    material: index.optional(),
    mode: z3.literal(4).default(4)
  })).min(1).max(SPATIAL_GLB_LIMITS.primitives) })).min(1).max(SPATIAL_GLB_LIMITS.meshes),
  materials: z3.array(z3.strictObject({
    ...metadata,
    pbrMetallicRoughness: z3.strictObject({ ...metadata, baseColorFactor: z3.tuple([unit2, unit2, unit2, unit2]).default([1, 1, 1, 1]), metallicFactor: unit2.default(1), roughnessFactor: unit2.default(1), baseColorTexture: textureInfo.optional() }).optional(),
    alphaMode: z3.enum(["OPAQUE", "MASK", "BLEND"]).default("OPAQUE"),
    alphaCutoff: unit2.default(0.5),
    doubleSided: z3.boolean().default(false),
    emissiveFactor: z3.tuple([z3.literal(0), z3.literal(0), z3.literal(0)]).optional()
  })).max(SPATIAL_GLB_LIMITS.materials).default([]),
  images: z3.array(z3.strictObject({ ...metadata, bufferView: index, mimeType: z3.enum(["image/png", "image/jpeg"]) })).max(SPATIAL_GLB_LIMITS.images).default([]),
  textures: z3.array(z3.strictObject({ ...metadata, source: index, sampler: index.optional() })).max(SPATIAL_GLB_LIMITS.images).default([]),
  samplers: z3.array(samplerSchema).max(SPATIAL_GLB_LIMITS.images).default([]),
  animations: z3.array(z3.strictObject({
    ...metadata,
    samplers: z3.array(z3.strictObject({ ...metadata, input: index, output: index, interpolation: z3.enum(["STEP", "LINEAR"]).default("LINEAR") })).min(1).max(SPATIAL_GLB_LIMITS.channels),
    channels: z3.array(z3.strictObject({ ...metadata, sampler: index, target: z3.strictObject({ ...metadata, node: index, path: z3.enum(["translation", "rotation", "scale"]) }) })).min(1).max(SPATIAL_GLB_LIMITS.channels)
  })).max(SPATIAL_GLB_LIMITS.clips).default([])
});
var optionsSchema = z3.strictObject({
  metersPerUnit: z3.number().finite().min(0.000001).max(1e6),
  sourceUp: z3.enum(["x", "y", "z"]),
  nodeIndex: index.optional(),
  materialMode: z3.enum(["source", "entity"]).default("entity"),
  timeUs: z3.number().int().min(0).max(3600000000),
  clip: z3.strictObject({ index, offsetUs: z3.number().int().min(0).max(3600000000), playback: z3.enum(["once", "loop", "freeze"]) }).optional()
});
function fail(message, path = "glb") {
  throw new SpatialSceneError("invalid-data", `${SPATIAL_GLB_PROFILE}: ${message}`, path);
}
function at(array, index2, path) {
  return array[index2] ?? fail(`Missing index ${index2}.`, path);
}
function schemaValue(schema, input, name) {
  const captured = createBoundedJsonValueSnapshot(input, SPATIAL_GLB_LIMITS.jsonBytes, name, { maximumDepth: SPATIAL_GLB_LIMITS.jsonDepth, maximumValues: SPATIAL_GLB_LIMITS.jsonValues });
  const result = schema.safeParse(captured.value);
  if (!result.success) {
    const issue = result.error.issues[0];
    return fail(`Unsupported or invalid field: ${issue?.message ?? "invalid data"}.`, `${name}.${issue?.path.join(".") ?? ""}`);
  }
  return result.data;
}
function normalizedRotation(value, path) {
  if (value.length !== 4 || Math.abs(Math.hypot(...value) - 1) > 0.00001)
    fail("Rotation must be a unit XYZW quaternion.", path);
  return normalizeQuaternion(value);
}
function safeMatrix(value, path) {
  try {
    invertTransform(value);
  } catch {
    fail("Node transform must be an invertible affine matrix.", path);
  }
  return value;
}
function nodeTransform(node, path) {
  if (node.matrix) {
    if (node.translation || node.rotation || node.scale)
      fail("Node matrix and TRS cannot be combined.", path);
    const matrix2 = safeMatrix(Object.freeze([...node.matrix]), path);
    const axes = [[matrix2[0], matrix2[1], matrix2[2]], [matrix2[4], matrix2[5], matrix2[6]], [matrix2[8], matrix2[9], matrix2[10]]];
    for (let a = 0;a < 3; a++)
      for (let b = a + 1;b < 3; b++) {
        const left = axes[a], right = axes[b];
        const dot = left.reduce((sum, value, i) => sum + value * right[i], 0);
        if (Math.abs(dot) > Math.hypot(...left) * Math.hypot(...right) * 0.000001)
          fail("Node matrix contains unsupported shear.", path);
      }
    return matrix2;
  }
  const rotation = normalizedRotation(node.rotation ?? [0, 0, 0, 1], path);
  return safeMatrix(composeTransform({ position: node.translation ?? [0, 0, 0], rotation, scale: node.scale ?? [1, 1, 1] }), path);
}
function imageHeader(bytes, mimeType) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 0, height = 0;
  if (mimeType === "image/png") {
    if (bytes.length < 45 || [137, 80, 78, 71, 13, 10, 26, 10].some((value, i) => bytes[i] !== value))
      fail("Embedded image MIME does not match a PNG signature.");
    let cursor = 8, chunks = 0, hasData = false, ended = false;
    while (cursor < bytes.length) {
      if (++chunks > 65536 || cursor + 12 > bytes.length)
        fail("Malformed PNG chunk envelope.");
      const length = data.getUint32(cursor), type = data.getUint32(cursor + 4);
      if (length > bytes.length - cursor - 12)
        fail("PNG chunk exceeds its image view.");
      if (cursor === 8) {
        if (type !== 1229472850 || length !== 13)
          fail("PNG must begin with IHDR.");
        width = data.getUint32(cursor + 8);
        height = data.getUint32(cursor + 12);
      } else if (type === 1229472850)
        fail("Duplicate PNG IHDR.");
      if (type === 1633899596)
        fail("Animated PNG textures are unsupported.");
      if (type === 1229209940)
        hasData = true;
      cursor += 12 + length;
      if (type === 1229278788) {
        if (length !== 0 || cursor !== bytes.length)
          fail("PNG IEND must end its image view.");
        ended = true;
        break;
      }
    }
    if (!hasData || !ended)
      fail("PNG requires IDAT and IEND chunks.");
  } else {
    if (bytes.length < 10 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217)
      fail("Embedded image MIME does not match a complete JPEG envelope.");
    let cursor = 2, segments = 0;
    while (cursor + 4 <= bytes.length) {
      if (++segments > 65536 || bytes[cursor++] !== 255)
        fail("Malformed JPEG marker.");
      while (bytes[cursor] === 255)
        cursor++;
      const marker = bytes[cursor++];
      if (marker === 218 || marker === 217)
        break;
      if (marker === 0 || marker === 216 || marker >= 208 && marker <= 215)
        fail("Unexpected JPEG standalone marker.");
      if (cursor + 2 > bytes.length)
        fail("Truncated JPEG segment.");
      const length = data.getUint16(cursor);
      if (length < 2 || cursor + length > bytes.length)
        fail("JPEG segment exceeds its image view.");
      if ([192, 193, 194].includes(marker)) {
        if (width !== 0 || length < 8 || bytes[cursor + 2] !== 8 || ![1, 3].includes(bytes[cursor + 7]))
          fail("JPEG requires one 8-bit grayscale or RGB frame.");
        height = data.getUint16(cursor + 3);
        width = data.getUint16(cursor + 5);
      } else if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker))
        fail("JPEG frame encoding is unsupported.");
      cursor += length;
    }
  }
  if (width < 1 || height < 1 || width > 8192 || height > 8192 || width * height > SPATIAL_GLB_LIMITS.imagePixels)
    fail("Embedded image dimensions exceed the decoded pixel profile.");
  return { width, height };
}
function readAccessors(document, binary) {
  let totalValues = 0;
  const data = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  for (const [index2, view] of document.bufferViews.entries()) {
    if (view.byteOffset + view.byteLength > document.buffers[0].byteLength)
      fail("Buffer view exceeds the declared BIN payload.", `bufferViews.${index2}`);
    if (view.byteStride !== undefined && view.byteStride % 4 !== 0)
      fail("Vertex stride must be a multiple of four.", `bufferViews.${index2}`);
  }
  return Object.freeze(document.accessors.map((accessor, index2) => {
    const path = `accessors.${index2}`;
    const view = at(document.bufferViews, accessor.bufferView, path);
    const bytes = accessor.componentType === 5121 ? 1 : accessor.componentType === 5123 ? 2 : 4;
    const components = accessor.type === "SCALAR" ? 1 : Number(accessor.type.slice(3));
    const stride = view.byteStride ?? components * bytes;
    if (accessor.byteOffset % bytes !== 0 || (view.byteOffset + accessor.byteOffset) % bytes !== 0 || stride < components * bytes || stride % bytes !== 0)
      fail("Accessor alignment or stride is invalid.", path);
    if (accessor.byteOffset + (accessor.count - 1) * stride + components * bytes > view.byteLength)
      fail("Accessor exceeds its buffer view.", path);
    if (accessor.normalized && (accessor.componentType === 5125 || accessor.componentType === 5126))
      fail("Only unsigned byte/short UVs support normalized storage in this profile.", path);
    totalValues += accessor.count * components;
    if (totalValues > SPATIAL_GLB_LIMITS.decodedAccessorValues)
      fail("Decoded accessor budget exceeded.", path);
    const values2 = [];
    const low = new Array(components).fill(Infinity), high = new Array(components).fill(-Infinity);
    for (let element = 0;element < accessor.count; element++)
      for (let component = 0;component < components; component++) {
        const offset = view.byteOffset + accessor.byteOffset + element * stride + component * bytes;
        const raw = accessor.componentType === 5121 ? data.getUint8(offset) : accessor.componentType === 5123 ? data.getUint16(offset, true) : accessor.componentType === 5125 ? data.getUint32(offset, true) : data.getFloat32(offset, true);
        if (!Number.isFinite(raw))
          fail("Accessor contains nonfinite data.", path);
        low[component] = Math.min(low[component], raw);
        high[component] = Math.max(high[component], raw);
        values2.push(accessor.normalized ? raw / (accessor.componentType === 5121 ? 255 : 65535) : raw);
      }
    for (const [declared, computed, label] of [[accessor.min, low, "min"], [accessor.max, high, "max"]]) {
      if (declared !== undefined && (declared.length !== components || declared.some((value, component) => Math.abs(value - computed[component]) > 0.000001 * Math.max(1, Math.abs(value)))))
        fail(`Accessor ${label} does not match decoded values.`, path);
    }
    return Object.freeze({ source: accessor, components, values: Object.freeze(values2) });
  }));
}
function validateViewRoles(document) {
  const roles = new Map, vertexAccessors = new Map;
  const assign = (viewIndex, role) => {
    const previous = roles.get(viewIndex);
    if (previous !== undefined && previous !== role)
      fail(`Buffer view mixes ${previous} and ${role} data.`, `bufferViews.${viewIndex}`);
    roles.set(viewIndex, role);
  };
  const accessor = (index2, role) => {
    const source = at(document.accessors, index2, "accessors");
    assign(source.bufferView, role);
    if (role === "vertex") {
      const ids = vertexAccessors.get(source.bufferView) ?? new Set;
      ids.add(index2);
      vertexAccessors.set(source.bufferView, ids);
    }
  };
  for (const mesh of document.meshes)
    for (const primitive of mesh.primitives) {
      for (const index2 of Object.values(primitive.attributes))
        if (index2 !== undefined)
          accessor(index2, "vertex");
      if (primitive.indices !== undefined)
        accessor(primitive.indices, "index");
    }
  for (const clip of document.animations)
    for (const sampler of clip.samplers) {
      accessor(sampler.input, "animation");
      accessor(sampler.output, "animation");
    }
  for (const image of document.images)
    assign(image.bufferView, "image");
  for (const [viewIndex, ids] of vertexAccessors)
    if (ids.size > 1 && at(document.bufferViews, viewIndex, "bufferViews").byteStride === undefined)
      fail("Shared vertex-attribute views require an explicit stride.", `bufferViews.${viewIndex}`);
}
function cleanSampler(sampler) {
  return Object.freeze({
    wrapS: sampler?.wrapS ?? 10497,
    wrapT: sampler?.wrapT ?? 10497,
    ...sampler?.magFilter === undefined ? {} : { magFilter: sampler.magFilter },
    ...sampler?.minFilter === undefined ? {} : { minFilter: sampler.minFilter }
  });
}
function materials(document) {
  for (const texture of document.textures) {
    at(document.images, texture.source, "textures.source");
    if (texture.sampler !== undefined)
      at(document.samplers, texture.sampler, "textures.sampler");
  }
  return deepFreezeJson(document.materials.map((material) => {
    const pbr = material.pbrMetallicRoughness;
    const texture = pbr?.baseColorTexture === undefined ? undefined : at(document.textures, pbr.baseColorTexture.index, "baseColorTexture");
    return {
      baseColorLinear: pbr?.baseColorFactor ?? [1, 1, 1, 1],
      metalness: pbr?.metallicFactor ?? 1,
      roughness: pbr?.roughnessFactor ?? 1,
      alphaMode: material.alphaMode,
      alphaCutoff: material.alphaCutoff,
      doubleSided: material.doubleSided,
      ...texture === undefined ? {} : { baseColorTexture: { imageIndex: texture.source, sampler: cleanSampler(texture.sampler === undefined ? undefined : document.samplers[texture.sampler]) } }
    };
  }));
}
function readMeshes(document, accessors) {
  const sources = materials(document);
  const defaultMaterial = { baseColorLinear: [1, 1, 1, 1], metalness: 1, roughness: 1, alphaMode: "OPAQUE", alphaCutoff: 0.5, doubleSided: false };
  let primitiveCount = 0, triangles = 0;
  return deepFreezeJson(document.meshes.map((mesh, meshIndex) => mesh.primitives.map((primitive, primitiveIndex) => {
    const path = `meshes.${meshIndex}.primitives.${primitiveIndex}`;
    if (++primitiveCount > SPATIAL_GLB_LIMITS.primitives)
      fail("Source primitive count exceeds this profile.", path);
    const positions = at(accessors, primitive.attributes.POSITION, path);
    const normals = primitive.attributes.NORMAL === undefined ? undefined : at(accessors, primitive.attributes.NORMAL, path);
    const uvs = primitive.attributes.TEXCOORD_0 === undefined ? undefined : at(accessors, primitive.attributes.TEXCOORD_0, path);
    const indices = primitive.indices === undefined ? undefined : at(accessors, primitive.indices, path);
    if (positions.source.type !== "VEC3" || positions.source.componentType !== 5126 || positions.source.normalized || positions.source.min === undefined || positions.source.max === undefined || positions.source.count > SPATIAL_GLB_LIMITS.verticesPerPrimitive)
      fail("POSITION requires bounded float32 VEC3 with declared min/max.", path);
    for (const attribute of [positions, normals, uvs])
      if (attribute !== undefined) {
        const view = document.bufferViews[attribute.source.bufferView];
        if ((view.byteOffset + attribute.source.byteOffset) % 4 !== 0 || attribute.source.byteOffset % 4 !== 0 || view.target !== undefined && view.target !== 34962)
          fail("Vertex attributes require four-byte alignment and ARRAY_BUFFER target.", path);
        const componentBytes = attribute.source.componentType === 5121 ? 1 : attribute.source.componentType === 5123 ? 2 : 4;
        if ((view.byteStride ?? attribute.components * componentBytes) % 4 !== 0)
          fail("Every vertex attribute element must remain four-byte aligned.", path);
        if (attribute.source.count !== positions.source.count || attribute.values.some((value) => Math.abs(value) > 1e6))
          fail("Vertex attributes require matching counts and bounded coordinates.", path);
      }
    if (normals) {
      if (normals.source.type !== "VEC3" || normals.source.componentType !== 5126 || normals.source.normalized)
        fail("NORMAL requires float32 VEC3.", path);
      for (let i = 0;i < normals.values.length; i += 3)
        if (Math.abs(Math.hypot(...normals.values.slice(i, i + 3)) - 1) > 0.0001)
          fail("Normals must be unit vectors.", path);
    }
    if (uvs && (uvs.source.type !== "VEC2" || uvs.source.componentType !== 5126 && !([5121, 5123].includes(uvs.source.componentType) && uvs.source.normalized)))
      fail("TEXCOORD_0 requires float32 or normalized unsigned byte/short VEC2.", path);
    if (indices) {
      const view = document.bufferViews[indices.source.bufferView];
      if (indices.source.type !== "SCALAR" || ![5121, 5123, 5125].includes(indices.source.componentType) || indices.source.normalized || view.byteStride !== undefined || view.target !== undefined && view.target !== 34963)
        fail("Triangle indices require tightly packed unsigned scalar storage.", path);
      const restart = indices.source.componentType === 5121 ? 255 : indices.source.componentType === 5123 ? 65535 : 4294967295;
      if (indices.values.some((value) => value >= positions.source.count || value === restart))
        fail("Triangle index is out of range or reserved for primitive restart.", path);
    }
    const vertices = indices?.values.length ?? positions.source.count;
    if (vertices % 3 !== 0)
      fail("TRIANGLES require complete index or vertex triples.", path);
    triangles += vertices / 3;
    if (triangles > SPATIAL_GLB_LIMITS.triangles)
      fail("Source triangle budget exceeded.", path);
    const material = primitive.material === undefined ? defaultMaterial : at(sources, primitive.material, path);
    if (material.baseColorTexture && uvs === undefined)
      fail("Base-color textures require TEXCOORD_0.", path);
    return { positions: positions.values, ...normals === undefined ? {} : { normals: normals.values }, ...uvs === undefined ? {} : { uvs: uvs.values }, ...indices === undefined ? {} : { indices: indices.values }, material };
  })));
}
function hierarchy(document) {
  const parents = document.nodes.map(() => null);
  for (const [index2, node] of document.nodes.entries()) {
    nodeTransform(node, `nodes.${index2}`);
    if (node.mesh !== undefined)
      at(document.meshes, node.mesh, `nodes.${index2}.mesh`);
    const seen2 = new Set;
    for (const child of node.children) {
      at(document.nodes, child, `nodes.${index2}.children`);
      if (seen2.has(child) || parents[child] !== null)
        fail("Nodes may have only one parent and unique child references.", `nodes.${index2}`);
      seen2.add(child);
      parents[child] = index2;
    }
  }
  const roots = document.nodes.map((_, index2) => index2).filter((index2) => parents[index2] === null);
  const order = [], seen = new Set, pending = [...roots];
  while (pending.length) {
    const index2 = pending.pop();
    if (seen.has(index2))
      fail("Node hierarchy contains a cycle.");
    seen.add(index2);
    order.push(index2);
    pending.push(...document.nodes[index2].children);
  }
  if (seen.size !== document.nodes.length)
    fail("Node hierarchy contains a cycle.");
  for (const scene2 of document.scenes) {
    const unique2 = new Set;
    for (const index2 of scene2.nodes) {
      at(document.nodes, index2, "scenes.nodes");
      if (parents[index2] !== null || unique2.has(index2))
        fail("Scene roots must be unique nodes without parents.");
      unique2.add(index2);
    }
  }
  if (document.scene === undefined && document.scenes.length !== 1)
    fail("Multiple scenes require an explicit glTF default scene.");
  const scene = at(document.scenes, document.scene ?? 0, "scene");
  const reachable = new Set, visit = [...scene.nodes];
  while (visit.length) {
    const index2 = visit.pop();
    reachable.add(index2);
    visit.push(...document.nodes[index2].children);
  }
  return { parents: Object.freeze(parents), order: Object.freeze(order), reachable };
}
function animationDurations(document, accessors) {
  let totalChannels = 0;
  return Object.freeze(document.animations.map((clip, clipIndex) => {
    totalChannels += clip.channels.length;
    if (totalChannels > SPATIAL_GLB_LIMITS.channels)
      fail("Animation channel budget exceeded.");
    let duration2 = 0;
    for (const sampler of clip.samplers) {
      const input = at(accessors, sampler.input, "animation input"), output = at(accessors, sampler.output, "animation output");
      if (input.source.type !== "SCALAR" || input.source.componentType !== 5126 || input.source.normalized || input.source.count > SPATIAL_GLB_LIMITS.animationKeys || input.source.min === undefined || input.source.max === undefined)
        fail("Animation input requires bounded float32 scalar seconds with min/max.");
      if (output.source.componentType !== 5126 || output.source.normalized || output.source.count !== input.source.count)
        fail("Animation output must be float32 with matching key count.");
      for (const accessor of [input, output]) {
        const view = document.bufferViews[accessor.source.bufferView];
        if (view.byteStride !== undefined || view.target !== undefined)
          fail("Animation data must be tightly packed without a GPU buffer target.");
      }
      let previous = -1;
      for (const time of input.values) {
        if (time < 0 || time <= previous || time > SPATIAL_GLB_LIMITS.durationSeconds)
          fail("Animation times must be strictly ordered nonnegative seconds within the duration profile.");
        previous = time;
      }
      duration2 = Math.max(duration2, previous);
    }
    const writers = new Set;
    for (const channel of clip.channels) {
      const node = at(document.nodes, channel.target.node, "animation target");
      if (node.matrix)
        fail("Animated nodes must use TRS, never a matrix.");
      const key2 = `${channel.target.node}:${channel.target.path}`;
      if (writers.has(key2))
        fail("Animation has multiple writers for one node property.", `animations.${clipIndex}`);
      writers.add(key2);
      const sampler = at(clip.samplers, channel.sampler, "animation sampler");
      const output = accessors[sampler.output];
      if (output.source.type !== (channel.target.path === "rotation" ? "VEC4" : "VEC3"))
        fail("Animation output arity does not match its target property.");
      if (channel.target.path === "rotation")
        for (let i = 0;i < output.values.length; i += 4)
          normalizedRotation(output.values.slice(i, i + 4), "animation rotation");
      else if (output.values.some((value) => Math.abs(value) > 1e6 || channel.target.path === "scale" && value === 0))
        fail("Animation transform values are unbounded or singular.");
      if (channel.target.path === "scale" && sampler.interpolation === "LINEAR") {
        for (let i = 3;i < output.values.length; i++)
          if (Math.sign(output.values[i]) !== Math.sign(output.values[i - 3]))
            fail("Linear scale animation crosses a singular transform.");
      }
    }
    return duration2;
  }));
}

class SpatialGlbModel {
  profile = SPATIAL_GLB_PROFILE;
  nodeCount;
  clipDurationsSeconds;
  #state;
  constructor(state) {
    this.#state = state;
    this.nodeCount = state.document.nodes.length;
    this.clipDurationsSeconds = state.clipDurations;
    Object.freeze(this);
  }
  static parse(input) {
    if (!(input instanceof Uint8Array) || input.byteLength < 28 || input.byteLength > SPATIAL_GLB_LIMITS.bytes || input.buffer instanceof SharedArrayBuffer)
      fail("Expected bounded, non-shared GLB bytes.");
    const bytes = Uint8Array.from(input);
    const header = new DataView(bytes.buffer);
    if (header.getUint32(0, true) !== 1179937895 || header.getUint32(4, true) !== 2 || header.getUint32(8, true) !== bytes.length)
      fail("Invalid GLB 2.0 header or total length.");
    const jsonLength = header.getUint32(12, true);
    if (header.getUint32(16, true) !== 1313821514 || jsonLength % 4 !== 0 || jsonLength < 4 || jsonLength > SPATIAL_GLB_LIMITS.jsonBytes || 20 + jsonLength + 8 > bytes.length)
      fail("Expected bounded first JSON chunk and following BIN chunk.");
    const binHeader = 20 + jsonLength, binLength = header.getUint32(binHeader, true);
    if (header.getUint32(binHeader + 4, true) !== 5130562 || binLength % 4 !== 0 || binHeader + 8 + binLength !== bytes.length)
      fail("Expected exactly one BIN chunk and no trailing chunks.");
    let json;
    try {
      json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(20, binHeader)));
    } catch {
      return fail("GLB JSON must be valid UTF-8 JSON.");
    }
    const document = schemaValue(gltfSchema, json, "gltf");
    const payloadLength = document.buffers[0].byteLength;
    if (payloadLength > binLength || binLength - payloadLength > 3)
      fail("Declared BIN length does not match its padding.");
    const binary = bytes.subarray(binHeader + 8);
    if (binary.subarray(payloadLength).some((byte) => byte !== 0))
      fail("BIN padding must contain zero bytes.");
    validateViewRoles(document);
    const accessors = readAccessors(document, binary);
    const meshPrimitives = readMeshes(document, accessors);
    const graph = hierarchy(document);
    const clipDurations = animationDurations(document, accessors);
    let totalImageBytes = 0, totalPixels = 0;
    const images = document.images.map((image, imageIndex) => {
      const view = at(document.bufferViews, image.bufferView, "images.bufferView");
      if (view.byteStride !== undefined || view.target !== undefined || view.byteLength > SPATIAL_GLB_LIMITS.imageBytes)
        fail("Embedded images require bounded untargeted byte views.");
      totalImageBytes += view.byteLength;
      if (totalImageBytes > SPATIAL_GLB_LIMITS.imageTotalBytes)
        fail("Embedded image byte budget exceeded.");
      const imageBytes = binary.slice(view.byteOffset, view.byteOffset + view.byteLength);
      const dimensions2 = imageHeader(imageBytes, image.mimeType);
      totalPixels += dimensions2.width * dimensions2.height;
      if (totalPixels > SPATIAL_GLB_LIMITS.imagePixels)
        fail("Embedded decoded image pixel budget exceeded.");
      return Object.freeze({ imageIndex, mimeType: image.mimeType, ...dimensions2, bytes: imageBytes });
    });
    return new SpatialGlbModel({ document: deepFreezeJson(document), accessors, meshPrimitives, images: Object.freeze(images), ...graph, clipDurations });
  }
  evaluate(input) {
    const options = schemaValue(optionsSchema, input, "glb evaluation");
    const state = this.#state, document = state.document;
    if (options.nodeIndex !== undefined && !state.reachable.has(options.nodeIndex))
      fail("Selected node is absent from the default scene.", "nodeIndex");
    let sourceTimeSeconds = null;
    const animated = new Map;
    if (options.clip !== undefined) {
      const clip = at(document.animations, options.clip.index, "clip.index");
      const duration2 = state.clipDurations[options.clip.index];
      const requested = (options.timeUs + options.clip.offsetUs) / 1e6;
      if (options.clip.offsetUs / 1e6 > duration2)
        fail("Clip source offset exceeds its duration.");
      if (options.clip.playback === "once" && requested > duration2)
        fail("Once clip playback exceeds its duration.");
      sourceTimeSeconds = options.clip.playback === "loop" ? duration2 === 0 ? 0 : requested % duration2 : Math.min(requested, duration2);
      for (const channel of clip.channels) {
        const sampler = clip.samplers[channel.sampler], times = state.accessors[sampler.input].values, output = state.accessors[sampler.output];
        let lower = 0, upper = times.length - 1;
        if (sourceTimeSeconds <= times[0])
          upper = 0;
        else if (sourceTimeSeconds >= times[upper])
          lower = upper;
        else
          while (upper - lower > 1) {
            const middle = Math.floor((lower + upper) / 2);
            if (times[middle] <= sourceTimeSeconds)
              lower = middle;
            else
              upper = middle;
          }
        const left = output.values.slice(lower * output.components, (lower + 1) * output.components);
        let value = left;
        if (sampler.interpolation === "LINEAR" && upper !== lower) {
          const right = output.values.slice(upper * output.components, (upper + 1) * output.components);
          const t = (sourceTimeSeconds - times[lower]) / (times[upper] - times[lower]);
          value = channel.target.path === "rotation" ? slerpQuaternion(left, right, t) : left.map((part, index2) => part + (right[index2] - part) * t);
        }
        const pose = animated.get(channel.target.node) ?? {};
        if (channel.target.path === "rotation")
          pose.rotation = normalizedRotation(value, "evaluated clip rotation");
        else
          pose[channel.target.path] = value;
        animated.set(channel.target.node, pose);
      }
    }
    const rotation = options.sourceUp === "x" ? [0, 0, Math.SQRT1_2, Math.SQRT1_2] : options.sourceUp === "z" ? [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] : [0, 0, 0, 1];
    const conversion = composeTransform({ position: [0, 0, 0], rotation, scale: [options.metersPerUnit, options.metersPerUnit, options.metersPerUnit] });
    const matrices = new Map;
    for (const index2 of state.order) {
      const node = document.nodes[index2], overrides = animated.get(index2);
      const local = overrides ? nodeTransform({ ...node, ...overrides }, `nodes.${index2}`) : nodeTransform(node, `nodes.${index2}`);
      const parent = state.parents[index2];
      matrices.set(index2, multiplyTransforms(parent === null ? conversion : matrices.get(parent), local));
    }
    const selected = new Set;
    if (options.nodeIndex === undefined)
      for (const index2 of state.reachable)
        selected.add(index2);
    else {
      const pending = [options.nodeIndex];
      while (pending.length) {
        const index2 = pending.pop();
        selected.add(index2);
        pending.push(...document.nodes[index2].children);
      }
    }
    const primitives = [], imageIds = new Set;
    let triangles = 0;
    for (const sourceNodeIndex of [...selected].sort((a, b) => a - b)) {
      const node = document.nodes[sourceNodeIndex];
      if (node.mesh === undefined)
        continue;
      const matrix2 = safeMatrix(matrices.get(sourceNodeIndex), `nodes.${sourceNodeIndex}`);
      for (const [sourcePrimitiveIndex, primitive] of state.meshPrimitives[node.mesh].entries()) {
        if (primitives.length >= SPATIAL_GLB_LIMITS.primitives)
          fail("Instanced primitive budget exceeded.");
        triangles += (primitive.indices?.length ?? primitive.positions.length / 3) / 3;
        if (triangles > SPATIAL_GLB_LIMITS.triangles)
          fail("Instanced triangle budget exceeded.");
        const bounds2 = vertexBounds(primitive.positions, primitive.indices, matrix2);
        const { material, ...geometry } = primitive;
        if (options.materialMode === "source" && material.baseColorTexture)
          imageIds.add(material.baseColorTexture.imageIndex);
        primitives.push({ ...geometry, matrix: matrix2, bounds: bounds2, sourceNodeIndex, sourcePrimitiveIndex, ...options.materialMode === "source" ? { material } : {} });
      }
    }
    if (primitives.length === 0)
      fail("Selected scene or subtree contains no triangle geometry.");
    const bounds = combineBounds(primitives.map((primitive) => primitive.bounds));
    const images = [...imageIds].sort((a, b) => a - b).map((index2) => {
      const image = state.images[index2];
      return Object.freeze({ ...image, bytes: image.bytes.slice() });
    });
    return Object.freeze({ profile: SPATIAL_GLB_PROFILE, primitives: deepFreezeJson(primitives), images: Object.freeze(images), bounds, sourceTimeSeconds });
  }
}
function vertexBounds(positions, indices, matrix2) {
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  const count = indices?.length ?? positions.length / 3;
  for (let index2 = 0;index2 < count; index2++) {
    const offset = (indices?.[index2] ?? index2) * 3;
    const point = transformPoint(matrix2, [positions[offset], positions[offset + 1], positions[offset + 2]]);
    for (let axis = 0;axis < 3; axis++) {
      low[axis] = Math.min(low[axis], point[axis]);
      high[axis] = Math.max(high[axis], point[axis]);
    }
  }
  return deepFreezeJson({ min: low, max: high });
}
function combineBounds(bounds) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const bound of bounds)
    for (let axis = 0;axis < 3; axis++) {
      min[axis] = Math.min(min[axis], bound.min[axis]);
      max[axis] = Math.max(max[axis], bound.max[axis]);
    }
  return deepFreezeJson({ min, max });
}
function parseSpatialGlb(bytes) {
  return SpatialGlbModel.parse(bytes);
}
function evaluateSpatialGlb(model, options) {
  if (!(model instanceof SpatialGlbModel))
    fail("Evaluation requires a parsed GLB model.");
  return model.evaluate(options);
}
// src/code/index.ts
function compileWorkflowGraph2(options) {
  return compileWorkflowGraph({
    graph: options.graph,
    ...options.limits === undefined ? {} : { limits: options.limits },
    projection: PUBLIC_WORKFLOW_REGISTRY_PROJECTION
  });
}
export {
  validateSpatialShot,
  validateSpatialOverrides,
  unprojectPixel,
  transformPoint,
  transformDirection,
  transformBounds,
  spatialValueSha256,
  spatialTopologicalIds,
  spatialStateValueSha256,
  spatialSceneSha256,
  spatialPropertySupported,
  spatialOutputDuration,
  spatialGeneratorOutputSha256,
  spatialFrameSample,
  spatialFrameCount,
  spatialAssetManifestSha256,
  spatialAssetClosureDigests,
  sortSpatialBy,
  slerpQuaternion,
  sha256Hex,
  seconds,
  runWorkflow,
  runBuiltWorkflow,
  reduceSpatialFrameRate,
  projectPoint,
  pixelRay,
  parseSpatialValue,
  parseSpatialScene,
  parseSpatialGlb,
  normalizeQuaternion,
  multiplyTransforms,
  mergeSpatialOverrides,
  isPortableAtetOperationKind,
  invertTransform,
  inspectSpatialScene,
  generatedSpatialEntityId,
  evaluateSpatialScene,
  evaluateSpatialGlb,
  defineWorkflow,
  definePortableWorkflowFragment,
  createWorkflowGraphHash,
  createWorkflowCompilationHash,
  createSpatialSceneStarter,
  createPublicWorkflowRegistryProjection,
  createGraphHash,
  createAtetCodeHost,
  composeTransform,
  compileWorkflowGraph2 as compileWorkflowGraph,
  canonicalJsonSha256,
  canonicalJson,
  cameraMathView,
  buildWorkflowGraph,
  buildWorkflow,
  boundedCanonicalJsonSha256,
  boundedCanonicalJson,
  atetCodeErrorMessage,
  asAtetCodeError,
  applySpatialScenePatch,
  applySpatialEntityOverride,
  WORKFLOW_REF_VERSION,
  WORKFLOW_REF_BRAND,
  WORKFLOW_NODE_RECEIPT_VERSION,
  WORKFLOW_NODE_RECEIPT_HASH_DOMAIN,
  WORKFLOW_GRAPH_VERSION,
  WORKFLOW_GRAPH_HASH_DOMAIN,
  WORKFLOW_COMPILATION_VERSION,
  WORKFLOW_COMPILATION_HASH_DOMAIN,
  SpatialVec3Schema,
  SpatialTransformSchema,
  SpatialTimeUsSchema,
  SpatialShotV1Schema,
  SpatialShotIdSchema,
  SpatialSceneV1Schema,
  SpatialScenePatchV1Schema,
  SpatialSceneIdSchema,
  SpatialSceneError,
  SpatialQuaternionSchema,
  SpatialProjectionSchema,
  SpatialPoseSchema,
  SpatialPlacementSchema,
  SpatialPayloadSchema,
  SpatialPatchOperationSchema,
  SpatialOverrideSchema,
  SpatialOriginSchema,
  SpatialMatrixSchema,
  SpatialMaterialSchema,
  SpatialGlbModel,
  SpatialGeometrySchema,
  SpatialGeneratorSchema,
  SpatialGeneratorIdSchema,
  SpatialFrameRateSchema,
  SpatialEntitySchema,
  SpatialEntityIdSchema,
  SpatialDigestSchema,
  SpatialChannelIdSchema,
  SpatialCameraSchema,
  SpatialCameraIdSchema,
  SpatialAssetManifestSchema,
  SpatialAssetInterpretationSchema,
  SpatialAssetIdSchema,
  SpatialAnimationSchema,
  SerializedRefV1Schema,
  SPATIAL_SCENE_LIMITS,
  SPATIAL_GLB_PROFILE,
  SPATIAL_GLB_LIMITS,
  RequirementEnvelopeSchema,
  REQUIREMENT_ENVELOPE_VERSION,
  PortableWorkflowBuilder,
  PUBLIC_WORKFLOW_REGISTRY_PROJECTION_ID,
  PUBLIC_WORKFLOW_REGISTRY_PROJECTION,
  PUBLIC_ATET_WORKFLOW_PROJECTION,
  PORTABLE_ATET_OPERATION_KINDS,
  PORTABLE_ATET_OPERATION_CONTRACTS,
  OperationPolicySchema,
  OperationKindSchema,
  OperationDiscoverySchema,
  MAX_WORKFLOW_RESULT_VALUES,
  MAX_WORKFLOW_RESULT_DEPTH,
  MAX_WORKFLOW_RESULT_BYTES,
  MAX_IMAGE_DIMENSION,
  MAX_ABS_COMPONENT,
  JsonValueSchema,
  IDENTITY_MATRIX,
  GraphCompilerLimitsSchema,
  GRAPH_ABI,
  EvaluatedSpatialSceneSchema,
  DEFAULT_GRAPH_COMPILER_LIMITS,
  CompiledWorkflowGraphSchema,
  AuthoredWorkflowGraphV1Schema,
  AuthoredGraphNodeV1Schema,
  AtetWorkflowRunError,
  AtetVectorizeReceiptSchema,
  AtetVectorizeQualityReceiptSchema,
  AtetVectorizeProvenanceSchema,
  AtetRenderArtifactsSchema,
  AtetLintFindingSchema,
  AtetImageVectorizeOutputSchema,
  AtetImageVectorizeInputSchema,
  AtetImageModelSchema,
  AtetImageGenerateOutputSchema,
  AtetImageGenerateInputSchema,
  AtetDiagramRenderOutputSchema,
  AtetDiagramRenderInputSchema,
  AtetDiagramCheckOutputSchema,
  AtetDiagramCheckInputSchema,
  AtetCodeError
};
