import { z } from "zod"
import { deepFreezeJson } from "../code/json-snapshot.js"
import {
  EvaluatedSpatialSceneSchema, SPATIAL_SCENE_LIMITS, SpatialCameraIdSchema, SpatialOverrideSchema, SpatialPoseSchema,
  SpatialShotV1Schema, SpatialTimeUsSchema,
  type EvaluatedSpatialScene, type SpatialAnimation, type SpatialCamera, type SpatialEntity,
  type SpatialOverride, type SpatialPose, type SpatialShotV1,
} from "./contracts.js"
import {
  parseSpatialScene, parseSpatialValue, sortSpatialBy, spatialAssetClosureDigests,
  SpatialSceneError, spatialPropertySupported, spatialStateValueSha256, spatialTopologicalIds, spatialValueSha256, validateSpatialOverrides,
} from "./identity.js"
import { composeTransform, multiplyTransforms, slerpQuaternion, type Mat4 } from "./math.js"

export interface EvaluateSpatialSceneOptions {
  readonly timeUs: number
  readonly cameraId: string
  readonly overrides?: readonly SpatialOverride[]
  readonly cameraPoseOverride?: SpatialPose
}

const EvaluatedOptionsSchema = z.strictObject({
  timeUs: SpatialTimeUsSchema, cameraId: SpatialCameraIdSchema,
  overrides: z.array(SpatialOverrideSchema).max(SPATIAL_SCENE_LIMITS.entities).optional(),
  cameraPoseOverride: SpatialPoseSchema.optional(),
})

export function mergeSpatialOverrides(sceneOverrides: readonly SpatialOverride[], shotOverrides: readonly SpatialOverride[]): readonly SpatialOverride[] {
  const effective = new Map(sceneOverrides.map(override => [`${override.entityId}:${override.property}`, override]))
  const seen = new Set<string>()
  for (const override of shotOverrides) {
    const key = `${override.entityId}:${override.property}`
    if (seen.has(key)) throw new SpatialSceneError("conflict", `Duplicate shot override ${key}.`, "shot.overrides")
    seen.add(key)
    effective.set(key, override)
  }
  return deepFreezeJson(sortSpatialBy([...effective.values()], item => `${item.entityId}:${item.property}`))
}

export function applySpatialEntityOverride(entity: SpatialEntity, override: SpatialOverride): SpatialEntity {
  if (!spatialPropertySupported(entity, override.property)) throw new SpatialSceneError("conflict", `Unsupported override ${entity.entityId}.${override.property}.`)
  if (override.property === "transform") return { ...entity, transform: override.value }
  if (override.property === "color") {
    const color = override.value.toLowerCase()
    if (entity.kind === "mesh") return { ...entity, material: { ...entity.material, color } }
    if (entity.kind === "text" || entity.kind === "light") return { ...entity, color }
  }
  if (override.property === "opacity") {
    if (entity.kind === "mesh") return { ...entity, material: { ...entity.material, opacity: override.value } }
    if (entity.kind === "image" || entity.kind === "diagram" || entity.kind === "video") return { ...entity, opacity: override.value }
  }
  throw new SpatialSceneError("conflict", `Unsupported override ${entity.entityId}.${override.property}.`)
}

function sampleChannel(channel: SpatialAnimation, timeUs: number): number | readonly number[] {
  const keys = channel.keys
  if (timeUs <= keys[0]!.timeUs) return keys[0]!.value
  if (timeUs >= keys[keys.length - 1]!.timeUs) return keys[keys.length - 1]!.value
  let lower = 0, upper = keys.length - 1
  while (upper - lower > 1) {
    const middle = Math.floor((lower + upper) / 2)
    if (keys[middle]!.timeUs <= timeUs) lower = middle
    else upper = middle
  }
  const a = keys[lower]!, b = keys[upper]!
  if (channel.interpolation === "step") return a.value
  const t = (timeUs - a.timeUs) / (b.timeUs - a.timeUs)
  if (channel.property === "rotation") {
    return slerpQuaternion(channel.keys[lower]!.value, channel.keys[upper]!.value, t)
  }
  if (typeof a.value === "number" && typeof b.value === "number") return a.value + (b.value - a.value) * t
  const av = a.value as readonly number[], bv = b.value as readonly number[]
  return av.map((value, index) => value + (bv[index]! - value) * t)
}

export function validateSpatialShot(sceneInput: unknown, shotInput: unknown): SpatialShotV1 {
  const scene = parseSpatialScene(sceneInput)
  const shot = parseSpatialValue(SpatialShotV1Schema, shotInput, "shot")
  if (shot.sceneSha256 !== spatialValueSha256(scene)) throw new SpatialSceneError("conflict", "Shot pins another scene revision.", "shot.sceneSha256")
  if (!scene.cameras.some(camera => camera.cameraId === shot.cameraId)) throw new SpatialSceneError("invalid-data", "Shot camera is absent from its scene.", "shot.cameraId")
  if (shot.sceneStartUs >= scene.durationUs) throw new SpatialSceneError("invalid-data", "Shot scene start must precede scene duration.", "shot.sceneStartUs")
  if (shot.playback === "once" && shot.sceneStartUs + shot.range.endUs - shot.range.startUs > scene.durationUs) throw new SpatialSceneError("invalid-data", "Once playback exceeds scene duration.", "shot.range")
  validateSpatialOverrides(scene, mergeSpatialOverrides(scene.overrides, shot.overrides))
  if (shot.cameraPoseOverride && scene.animations.some(channel => channel.targetId === shot.cameraId)) throw new SpatialSceneError("conflict", "Camera animation and shot pose override both own camera pose.", "shot.cameraPoseOverride")
  return deepFreezeJson(shot)
}

/** Absolute time evaluation produces one immutable snapshot; calls share no mutable state. */
export function evaluateSpatialScene(sceneInput: unknown, options: EvaluateSpatialSceneOptions): EvaluatedSpatialScene {
  const scene = parseSpatialScene(sceneInput)
  // Capture the complete options object before inspecting optional properties.
  const capturedOptions = parseSpatialValue(
    // Explicit object schema also rejects unsupported simulation or executable fields.
    EvaluatedOptionsSchema, options, "evaluation options",
  )
  const timeUs = capturedOptions.timeUs
  if (timeUs > scene.durationUs) throw new SpatialSceneError("invalid-data", "Evaluation time exceeds scene duration.", "timeUs")
  let camera = scene.cameras.find(item => item.cameraId === capturedOptions.cameraId)
  if (!camera) throw new SpatialSceneError("not-found", `Unknown camera ${capturedOptions.cameraId}.`, "cameraId")
  const overrides = mergeSpatialOverrides(scene.overrides, capturedOptions.overrides ?? [])
  validateSpatialOverrides(scene, overrides)
  if (capturedOptions.cameraPoseOverride && scene.animations.some(channel => channel.targetId === camera!.cameraId)) throw new SpatialSceneError("conflict", "Camera animation conflicts with camera pose override.", "cameraPoseOverride")
  const entities = new Map(scene.entities.map(entity => [entity.entityId, entity]))
  for (const channel of scene.animations) {
    const value = sampleChannel(channel, timeUs)
    if (channel.targetId === camera.cameraId) {
      camera = { ...camera, pose: { ...camera.pose, [channel.property]: value } } as SpatialCamera
    } else {
      const entity = entities.get(channel.targetId)
      if (!entity) continue // Other cameras do not affect the requested view.
      if (channel.property === "opacity") entities.set(entity.entityId, applySpatialEntityOverride(entity, { entityId: entity.entityId, property: "opacity", value: value as number }))
      else entities.set(entity.entityId, { ...entity, transform: { ...entity.transform, [channel.property]: value } } as SpatialEntity)
    }
  }
  for (const override of overrides) entities.set(override.entityId, applySpatialEntityOverride(entities.get(override.entityId)!, override))
  if (capturedOptions.cameraPoseOverride) camera = { ...camera, pose: capturedOptions.cameraPoseOverride }
  const matrices = new Map<string, Mat4>()
  const visibility = new Map<string, boolean>()
  const order = spatialTopologicalIds(new Map(scene.entities.map(entity => [entity.entityId, entity.parentId === null ? [] : [entity.parentId]])), "entity hierarchy")
  for (const id of order) {
    const entity = entities.get(id)!
    try {
      const local = composeTransform(entity.transform)
      matrices.set(id, entity.parentId === null ? local : multiplyTransforms(matrices.get(entity.parentId)!, local))
    } catch (error) {
      throw new SpatialSceneError("invalid-data", error instanceof Error ? error.message : "Invalid evaluated transform.", `entities.${id}.transform`)
    }
    visibility.set(id, entity.visible && (entity.parentId === null || visibility.get(entity.parentId) === true))
  }
  const evaluated = scene.entities.map((source, index) => ({
    entity: entities.get(source.entityId)!, worldMatrix: matrices.get(source.entityId)!,
    visible: visibility.get(source.entityId)!, selectionId: index + 1,
  }))
  // The state identity excludes camera choice, camera pose, asset locator and provenance.
  const assetDigests = spatialAssetClosureDigests(scene.assets)
  const stateSha256 = spatialStateValueSha256({ domain: "slopcamera.spatial-state.v1", timeUs, entities: evaluated, assetDigests })
  const viewSha256 = spatialValueSha256({ domain: "slopcamera.spatial-view.v1", stateSha256, camera })
  const result = EvaluatedSpatialSceneSchema.parse({
    kind: "slopcamera.spatial-snapshot", schemaVersion: 1, sceneSha256: spatialValueSha256(scene),
    stateSha256, viewSha256, timeUs, camera,
    entities: evaluated.map(item => ({ ...item, visible: item.visible && (item.entity.placement.kind === "world" || item.entity.placement.cameraId === camera.cameraId) })),
    assets: scene.assets,
  })
  return deepFreezeJson(result)
}
