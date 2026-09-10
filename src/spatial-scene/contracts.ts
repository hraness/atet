import { z } from "zod"

export const SPATIAL_SCENE_LIMITS = Object.freeze({
  sourceBytes: 2_097_152,
  sourceDepth: 32,
  sourceValues: 200_000,
  entities: 4_096,
  assets: 128,
  cameras: 64,
  channels: 4_096,
  keysPerChannel: 4_096,
  durationUs: 3_600_000_000,
  patchOperations: 256,
})

export const SpatialDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u)
const stableId = (prefix: string) => z.string().min(prefix.length + 1).max(128)
  .regex(new RegExp(`^${prefix}[a-zA-Z0-9][a-zA-Z0-9_-]*$`, "u"))
export const SpatialSceneIdSchema = stableId("scene_")
export const SpatialEntityIdSchema = stableId("entity_")
export const SpatialCameraIdSchema = stableId("camera_")
export const SpatialAssetIdSchema = stableId("asset_")
export const SpatialGeneratorIdSchema = stableId("generator_")
export const SpatialChannelIdSchema = stableId("channel_")
export const SpatialShotIdSchema = stableId("shot_")
const finiteCoordinate = z.number().finite().min(-1_000_000).max(1_000_000)
const positiveDimension = z.number().finite().min(0.000001).max(1_000_000)
const unit = z.number().finite().min(0).max(1)
export const SpatialTimeUsSchema = z.number().int().safe().min(0).max(SPATIAL_SCENE_LIMITS.durationUs)
export const SpatialVec3Schema = z.tuple([finiteCoordinate, finiteCoordinate, finiteCoordinate])
export const SpatialQuaternionSchema = z.tuple([
  z.number().finite().min(-1).max(1), z.number().finite().min(-1).max(1),
  z.number().finite().min(-1).max(1), z.number().finite().min(-1).max(1),
]).refine(value => Math.abs(value.reduce((sum, part) => sum + part * part, 0) - 1) <= 1e-6,
  "Rotation must be a unit quaternion in XYZW order.")
export const SpatialTransformSchema = z.strictObject({
  position: SpatialVec3Schema,
  rotation: SpatialQuaternionSchema,
  scale: z.tuple([positiveDimension, positiveDimension, positiveDimension]),
})
export const SpatialPoseSchema = z.strictObject({
  position: SpatialVec3Schema,
  rotation: SpatialQuaternionSchema,
})
export const SpatialFrameRateSchema = z.strictObject({
  numerator: z.number().int().safe().min(1).max(1_000_000),
  denominator: z.number().int().safe().min(1).max(1_000_000),
}).refine(rate => rate.numerator / rate.denominator <= 1_000, "Frame rate exceeds 1,000 fps.")
const dimensions = {
  width: z.number().int().min(1).max(16_384),
  height: z.number().int().min(1).max(16_384),
}
const clipping = { near: positiveDimension, far: positiveDimension }
export const SpatialProjectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("perspective"), ...dimensions, ...clipping,
    fx: positiveDimension, fy: positiveDimension,
    cx: finiteCoordinate, cy: finiteCoordinate,
  }),
  z.strictObject({
    kind: z.literal("orthographic"), ...dimensions, ...clipping,
    left: finiteCoordinate, right: finiteCoordinate,
    top: finiteCoordinate, bottom: finiteCoordinate,
  }),
]).superRefine((projection, context) => {
  if (projection.far <= projection.near) context.addIssue({ code: "custom", message: "Far clipping must exceed near clipping." })
  if (projection.width * projection.height > 33_554_432) context.addIssue({ code: "custom", message: "Camera exceeds the 32-megapixel limit." })
  if (projection.kind === "orthographic" && (projection.right <= projection.left || projection.top <= projection.bottom)) {
    context.addIssue({ code: "custom", message: "Orthographic extents must have positive width and height." })
  }
})
export const SpatialCameraSchema = z.strictObject({
  cameraId: SpatialCameraIdSchema,
  name: z.string().min(1).max(256),
  pose: SpatialPoseSchema,
  projection: SpatialProjectionSchema,
})

const relativePath = z.string().min(1).max(1_024).refine(value =>
  !value.startsWith("/") && !/[\\\u0000-\u001f]/u.test(value)
  && !/^[a-zA-Z]:/u.test(value)
  && value.split("/").every(part => part !== "" && part !== "." && part !== ".."),
"Asset paths must be contained root-relative paths.")
export const SpatialPayloadSchema = z.strictObject({
  path: relativePath,
  sha256: SpatialDigestSchema,
  bytes: z.number().int().safe().min(1).max(134_217_728),
})
const imageInterpretation = {
  ...dimensions,
  colorSpace: z.literal("srgb"),
  alpha: z.enum(["straight", "opaque"]),
}
export const SpatialAssetInterpretationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("image"), ...imageInterpretation, mimeType: z.enum(["image/png", "image/jpeg", "image/svg+xml"]) }),
  z.strictObject({ kind: z.literal("video"), ...imageInterpretation, durationUs: SpatialTimeUsSchema.refine(value => value > 0), frameRate: SpatialFrameRateSchema }),
  z.strictObject({ kind: z.literal("diagram"), schemaVersion: z.literal(1), theme: z.enum(["light", "dark"]) }),
  z.strictObject({ kind: z.literal("gltf"), format: z.enum(["glb", "gltf"]), metersPerUnit: positiveDimension, sourceUp: z.enum(["x", "y", "z"]) }),
  z.strictObject({ kind: z.literal("font"), format: z.enum(["otf", "woff2"]), family: z.string().min(1).max(128) }),
  z.strictObject({ kind: z.literal("splat"), format: z.enum(["spz", "ply"]), metersPerUnit: positiveDimension, sourceUp: z.enum(["x", "y", "z"]) }),
  z.strictObject({ kind: z.literal("metadata"), format: z.literal("json"), schema: z.enum(["slopcamera.spatial-world-import", "slopcamera.world-labs-provenance"]) }),
])
export const SpatialAssetManifestSchema = z.strictObject({
  assetId: SpatialAssetIdSchema,
  payload: SpatialPayloadSchema,
  interpretation: SpatialAssetInterpretationSchema,
  dependencies: z.array(SpatialAssetIdSchema).max(SPATIAL_SCENE_LIMITS.assets),
  provenance: z.strictObject({
    source: z.enum(["authored", "imported", "generated", "derived"]),
    description: z.string().min(1).max(2_048),
    receiptSha256: SpatialDigestSchema.optional(),
  }),
})
const color = z.string().regex(/^#[a-fA-F0-9]{6}$/u)
export const SpatialMaterialSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unlit"), color, opacity: unit }),
  z.strictObject({ kind: z.literal("standard"), color, opacity: unit, roughness: unit, metalness: unit }),
])
export const SpatialGeometrySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("box"), size: z.tuple([positiveDimension, positiveDimension, positiveDimension]) }),
  z.strictObject({ kind: z.literal("sphere"), radius: positiveDimension }),
  z.strictObject({ kind: z.literal("plane"), width: positiveDimension, height: positiveDimension }),
  z.strictObject({ kind: z.literal("cylinder"), radius: positiveDimension, height: positiveDimension }),
  z.strictObject({ kind: z.literal("asset"), assetId: SpatialAssetIdSchema, nodeIndex: z.number().int().min(0).max(65_535).optional(), materialMode: z.enum(["entity", "source"]).optional(),
    clip: z.strictObject({ index: z.number().int().min(0).max(255), offsetUs: SpatialTimeUsSchema, playback: z.enum(["once", "loop", "freeze"]) }).optional(),
  }),
])
export const SpatialOriginSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("authored") }),
  z.strictObject({ kind: z.literal("generated"), generatorId: SpatialGeneratorIdSchema, key: z.string().min(1).max(256) }),
])
export const SpatialPlacementSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("world") }),
  z.strictObject({ kind: z.literal("view"), cameraId: SpatialCameraIdSchema, units: z.enum(["pixels", "normalized"]), order: z.number().int().min(-4_096).max(4_096) }),
])
const entityBase = {
  entityId: SpatialEntityIdSchema,
  name: z.string().min(1).max(256),
  parentId: SpatialEntityIdSchema.nullable(),
  transform: SpatialTransformSchema,
  placement: SpatialPlacementSchema,
  origin: SpatialOriginSchema,
  visible: z.boolean(),
}
const surfaceBase = {
  assetId: SpatialAssetIdSchema,
  width: positiveDimension,
  height: positiveDimension,
  fit: z.enum(["contain", "cover", "stretch"]),
  opacity: unit,
}
export const SpatialEntitySchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...entityBase, kind: z.literal("group") }),
  z.strictObject({ ...entityBase, kind: z.literal("mesh"), geometry: SpatialGeometrySchema, material: SpatialMaterialSchema }),
  z.strictObject({ ...entityBase, ...surfaceBase, kind: z.literal("image") }),
  z.strictObject({ ...entityBase, ...surfaceBase, kind: z.literal("diagram") }),
  z.strictObject({ ...entityBase, ...surfaceBase, kind: z.literal("video"), sourceOffsetUs: SpatialTimeUsSchema, playback: z.enum(["once", "loop", "freeze"]) }),
  z.strictObject({ ...entityBase, kind: z.literal("text"), text: z.string().max(16_384), fontAssetId: SpatialAssetIdSchema, fontSize: positiveDimension, width: positiveDimension, color, align: z.enum(["left", "center", "right"]) }),
  z.strictObject({ ...entityBase, kind: z.literal("light"), light: z.enum(["ambient", "directional", "point"]), color, intensity: z.number().finite().min(0).max(100_000) }),
  z.strictObject({ ...entityBase, kind: z.literal("splat"), assetId: SpatialAssetIdSchema }),
])

const key = <T extends z.ZodType>(value: T) => z.strictObject({ timeUs: SpatialTimeUsSchema, value })
const channelBase = { channelId: SpatialChannelIdSchema, targetId: z.union([SpatialEntityIdSchema, SpatialCameraIdSchema]) }
export const SpatialAnimationSchema = z.discriminatedUnion("property", [
  z.strictObject({ ...channelBase, property: z.literal("position"), interpolation: z.enum(["step", "linear"]), keys: z.array(key(SpatialVec3Schema)).min(1).max(SPATIAL_SCENE_LIMITS.keysPerChannel) }),
  z.strictObject({ ...channelBase, property: z.literal("rotation"), interpolation: z.enum(["step", "slerp"]), keys: z.array(key(SpatialQuaternionSchema)).min(1).max(SPATIAL_SCENE_LIMITS.keysPerChannel) }),
  z.strictObject({ ...channelBase, property: z.literal("scale"), interpolation: z.enum(["step", "linear"]), keys: z.array(key(z.tuple([positiveDimension, positiveDimension, positiveDimension]))).min(1).max(SPATIAL_SCENE_LIMITS.keysPerChannel) }),
  z.strictObject({ ...channelBase, property: z.literal("opacity"), interpolation: z.enum(["step", "linear"]), keys: z.array(key(unit)).min(1).max(SPATIAL_SCENE_LIMITS.keysPerChannel) }),
])
export const SpatialOverrideSchema = z.discriminatedUnion("property", [
  z.strictObject({ entityId: SpatialEntityIdSchema, property: z.literal("color"), value: color }),
  z.strictObject({ entityId: SpatialEntityIdSchema, property: z.literal("opacity"), value: unit }),
  z.strictObject({ entityId: SpatialEntityIdSchema, property: z.literal("transform"), value: SpatialTransformSchema }),
])
export const SpatialGeneratorSchema = z.strictObject({
  generatorId: SpatialGeneratorIdSchema,
  sourceSha256: SpatialDigestSchema,
  closureSha256: SpatialDigestSchema,
  parametersSha256: SpatialDigestSchema,
  seed: z.number().int().safe().min(0).max(0xffff_ffff),
  outputSha256: SpatialDigestSchema,
  execution: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("qualified"), runtimeSha256: SpatialDigestSchema }),
    z.strictObject({ kind: z.literal("attempt"), attemptId: z.string().min(1).max(128), runtimeSha256: SpatialDigestSchema }),
  ]),
  editableKeys: z.array(z.strictObject({ key: z.string().min(1).max(256), properties: z.array(z.enum(["color", "opacity", "transform"])).min(1).max(3) })).max(SPATIAL_SCENE_LIMITS.entities),
})
export const SpatialSceneV1Schema = z.strictObject({
  kind: z.literal("slopcamera.spatial-scene"),
  schemaVersion: z.literal(1),
  sceneId: SpatialSceneIdSchema,
  coordinates: z.literal("right-handed-y-up-meters"),
  durationUs: SpatialTimeUsSchema.refine(value => value > 0),
  entities: z.array(SpatialEntitySchema).max(SPATIAL_SCENE_LIMITS.entities),
  cameras: z.array(SpatialCameraSchema).min(1).max(SPATIAL_SCENE_LIMITS.cameras),
  assets: z.array(SpatialAssetManifestSchema).max(SPATIAL_SCENE_LIMITS.assets),
  animations: z.array(SpatialAnimationSchema).max(SPATIAL_SCENE_LIMITS.channels),
  generators: z.array(SpatialGeneratorSchema).max(128),
  overrides: z.array(SpatialOverrideSchema).max(SPATIAL_SCENE_LIMITS.entities),
})

export const SpatialPatchOperationSchema = z.discriminatedUnion("kind", [
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
  z.strictObject({ kind: z.literal("replace-generator-output"), generator: SpatialGeneratorSchema, entities: z.array(SpatialEntitySchema).max(SPATIAL_SCENE_LIMITS.entities) }),
])
export const SpatialScenePatchV1Schema = z.strictObject({
  kind: z.literal("slopcamera.spatial-scene-patch"),
  schemaVersion: z.literal(1),
  expectedSceneSha256: SpatialDigestSchema,
  operations: z.array(SpatialPatchOperationSchema).min(1).max(SPATIAL_SCENE_LIMITS.patchOperations),
})
export const SpatialShotV1Schema = z.strictObject({
  shotId: SpatialShotIdSchema,
  sceneSha256: SpatialDigestSchema,
  cameraId: SpatialCameraIdSchema,
  range: z.strictObject({ startUs: SpatialTimeUsSchema, endUs: SpatialTimeUsSchema }),
  sceneStartUs: SpatialTimeUsSchema,
  playback: z.enum(["once", "loop", "freeze"]),
  overrides: z.array(SpatialOverrideSchema).max(SPATIAL_SCENE_LIMITS.entities),
  cameraPoseOverride: SpatialPoseSchema.optional(),
}).refine(shot => shot.range.endUs > shot.range.startUs, "Shot range must be nonempty and half-open.")

const matrixNumber = z.number().finite().min(-1e12).max(1e12)
export const SpatialMatrixSchema = z.tuple([
  matrixNumber, matrixNumber, matrixNumber, matrixNumber,
  matrixNumber, matrixNumber, matrixNumber, matrixNumber,
  matrixNumber, matrixNumber, matrixNumber, matrixNumber,
  matrixNumber, matrixNumber, matrixNumber, matrixNumber,
])
export const EvaluatedSpatialSceneSchema = z.strictObject({
  kind: z.literal("slopcamera.spatial-snapshot"),
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
    selectionId: z.number().int().min(1).max(SPATIAL_SCENE_LIMITS.entities),
  })).max(SPATIAL_SCENE_LIMITS.entities),
  assets: z.array(SpatialAssetManifestSchema).max(SPATIAL_SCENE_LIMITS.assets),
})

type DeepReadonly<T> = T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> } : T
export type SpatialSceneV1 = DeepReadonly<z.infer<typeof SpatialSceneV1Schema>>
export type SpatialEntity = DeepReadonly<z.infer<typeof SpatialEntitySchema>>
export type SpatialCamera = DeepReadonly<z.infer<typeof SpatialCameraSchema>>
export type SpatialProjection = DeepReadonly<z.infer<typeof SpatialProjectionSchema>>
export type SpatialTransform = DeepReadonly<z.infer<typeof SpatialTransformSchema>>
export type SpatialPose = DeepReadonly<z.infer<typeof SpatialPoseSchema>>
export type SpatialAssetManifest = DeepReadonly<z.infer<typeof SpatialAssetManifestSchema>>
export type SpatialAnimation = DeepReadonly<z.infer<typeof SpatialAnimationSchema>>
export type SpatialOverride = DeepReadonly<z.infer<typeof SpatialOverrideSchema>>
export type SpatialGenerator = DeepReadonly<z.infer<typeof SpatialGeneratorSchema>>
export type SpatialFrameRate = DeepReadonly<z.infer<typeof SpatialFrameRateSchema>>
export type SpatialScenePatchV1 = DeepReadonly<z.infer<typeof SpatialScenePatchV1Schema>>
export type SpatialPatchOperation = DeepReadonly<z.infer<typeof SpatialPatchOperationSchema>>
export type SpatialShotV1 = DeepReadonly<z.infer<typeof SpatialShotV1Schema>>
export type EvaluatedSpatialScene = DeepReadonly<z.infer<typeof EvaluatedSpatialSceneSchema>>
