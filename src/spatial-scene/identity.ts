import type { z } from "zod"
import { AtetCodeError } from "../code/errors.js"
import { createBoundedJsonSnapshot, createBoundedJsonValueSnapshot, deepFreezeJson } from "../code/json-snapshot.js"
import {
  SPATIAL_SCENE_LIMITS, SpatialAssetManifestSchema, SpatialEntitySchema,
  SpatialGeneratorIdSchema, SpatialSceneV1Schema,
  type SpatialAnimation, type SpatialAssetManifest, type SpatialEntity,
  type SpatialOverride, type SpatialSceneV1,
} from "./contracts.js"

export class SpatialSceneError extends AtetCodeError {
  readonly path: string
  constructor(code: "invalid-data" | "conflict" | "not-found", message: string, path = "scene") {
    super(code, message, { path })
    this.name = "SpatialSceneError"
    this.path = path
  }
}

const limits = { maximumDepth: SPATIAL_SCENE_LIMITS.sourceDepth, maximumValues: SPATIAL_SCENE_LIMITS.sourceValues }

/** Foreign objects are captured without invoking getters before schema parsing. */
export function parseSpatialValue<Schema extends z.ZodType>(schema: Schema, input: unknown, name: string): z.infer<Schema> {
  try {
    const captured = createBoundedJsonValueSnapshot(input, SPATIAL_SCENE_LIMITS.sourceBytes, name, limits)
    const parsed = schema.safeParse(captured.value)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      throw new SpatialSceneError("invalid-data", issue?.message ?? `Invalid ${name}.`, `${name}.${issue?.path.join(".") ?? ""}`)
    }
    return parsed.data
  } catch (error) {
    if (error instanceof SpatialSceneError) throw error
    throw new SpatialSceneError("invalid-data", error instanceof Error ? error.message : `Invalid ${name}.`, name)
  }
}

export function spatialValueSha256(input: unknown): string {
  return createBoundedJsonSnapshot(input, SPATIAL_SCENE_LIMITS.sourceBytes, "spatial identity", limits).sha256
}

/** Derived matrices add at most 22 scalar/container values per authored entity. */
export function spatialStateValueSha256(input: unknown): string {
  return createBoundedJsonSnapshot(input, SPATIAL_SCENE_LIMITS.sourceBytes * 4, "spatial state identity", {
    maximumDepth: SPATIAL_SCENE_LIMITS.sourceDepth + 4,
    maximumValues: SPATIAL_SCENE_LIMITS.sourceValues + SPATIAL_SCENE_LIMITS.entities * 24,
  }).sha256
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }
export function sortSpatialBy<T>(items: readonly T[], id: (item: T) => string): T[] {
  return [...items].sort((a, b) => compare(id(a), id(b)))
}

function unique<T>(items: readonly T[], id: (item: T) => string, path: string): Map<string, T> {
  const result = new Map<string, T>()
  for (const item of items) {
    const key = id(item)
    if (result.has(key)) throw new SpatialSceneError("invalid-data", `Duplicate identity ${key}.`, path)
    result.set(key, item)
  }
  return result
}

function requireReference<T>(map: ReadonlyMap<string, T>, id: string, path: string): T {
  const result = map.get(id)
  if (result === undefined) throw new SpatialSceneError("invalid-data", `Missing reference ${id}.`, path)
  return result
}

/** Iterative traversal bounds hierarchy and dependency checks without recursive stack use. */
export function spatialTopologicalIds(edges: ReadonlyMap<string, readonly string[]>, name: string): readonly string[] {
  const done = new Set<string>()
  const active = new Set<string>()
  const result: string[] = []
  for (const id of edges.keys()) {
    const pending: { id: string; exit: boolean }[] = [{ id, exit: false }]
    while (pending.length) {
      const next = pending.pop()!
      if (next.exit) { active.delete(next.id); done.add(next.id); result.push(next.id); continue }
      if (done.has(next.id)) continue
      if (active.has(next.id)) throw new SpatialSceneError("invalid-data", `Cycle at ${next.id}.`, name)
      const dependencies = requireReference(edges, next.id, name)
      active.add(next.id)
      pending.push({ id: next.id, exit: true })
      for (const dependency of dependencies) pending.push({ id: dependency, exit: false })
    }
  }
  return Object.freeze(result)
}

export function generatedSpatialEntityId(generatorId: string, key: string): string {
  SpatialGeneratorIdSchema.parse(generatorId)
  if (typeof key !== "string" || key.length < 1 || key.length > 256) throw new SpatialSceneError("invalid-data", "Generator keys must contain 1–256 characters.")
  return `entity_${spatialValueSha256({ domain: "atet.generated-entity.v1", generatorId, key })}`
}

function normalizeEntity(entity: SpatialEntity): SpatialEntity {
  if (entity.kind === "mesh") return { ...entity, material: { ...entity.material, color: entity.material.color.toLowerCase() } }
  if (entity.kind === "text" || entity.kind === "light") return { ...entity, color: entity.color.toLowerCase() }
  return entity
}

function normalizeAsset(asset: SpatialAssetManifest): SpatialAssetManifest {
  if (asset.interpretation.kind !== "video") return asset
  const rate = asset.interpretation.frameRate
  let divisor = rate.numerator, remainder = rate.denominator
  while (remainder !== 0) { const next = divisor % remainder; divisor = remainder; remainder = next }
  return { ...asset, interpretation: { ...asset.interpretation, frameRate: { numerator: rate.numerator / divisor, denominator: rate.denominator / divisor } } }
}

/** Hash retained authored entities before overrides or evaluation; no source is executed. */
export function spatialGeneratorOutputSha256(input: unknown): string {
  const entities = parseSpatialValue(SpatialEntitySchema.array().max(SPATIAL_SCENE_LIMITS.entities), input, "generator output")
  unique(entities, item => item.entityId, "generator output")
  return spatialValueSha256({ domain: "atet.generator-output.v1", entities: sortSpatialBy(entities.map(normalizeEntity), item => item.entityId) })
}

/** Locators and descriptive provenance are excluded; interpretation and dependency digests are bound. */
export function spatialAssetManifestSha256(input: unknown, dependencyDigests: Readonly<Record<string, string>> = {}): string {
  const asset = normalizeAsset(parseSpatialValue(SpatialAssetManifestSchema, input, "asset manifest"))
  const captured = createBoundedJsonValueSnapshot(dependencyDigests, SPATIAL_SCENE_LIMITS.sourceBytes, "dependency identities", limits).value
  if (captured === null || Array.isArray(captured) || typeof captured !== "object") throw new SpatialSceneError("invalid-data", "Dependency digests must be an object.")
  unique(asset.dependencies, item => item, "asset.dependencies")
  const dependencies = [...asset.dependencies].sort(compare).map(assetId => {
    const sha256 = (captured as Readonly<Record<string, unknown>>)[assetId]
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256)) throw new SpatialSceneError("invalid-data", `Missing dependency digest for ${assetId}.`)
    return { assetId, sha256 }
  })
  return spatialValueSha256({ domain: "atet.asset-manifest.v1", payload: { sha256: asset.payload.sha256, bytes: asset.payload.bytes }, interpretation: asset.interpretation, dependencies })
}

export function spatialAssetClosureDigests(assets: readonly SpatialAssetManifest[]): Readonly<Record<string, string>> {
  const map = unique(assets, asset => asset.assetId, "assets")
  const order = spatialTopologicalIds(new Map(assets.map(asset => [asset.assetId, asset.dependencies])), "asset dependencies")
  const digests: Record<string, string> = Object.create(null) as Record<string, string>
  for (const id of order) digests[id] = spatialAssetManifestSha256(map.get(id)!, digests)
  return Object.freeze(digests)
}

export function spatialPropertySupported(entity: SpatialEntity, property: SpatialOverride["property"] | SpatialAnimation["property"]): boolean {
  if ((property === "color" || property === "opacity") && entity.kind === "mesh"
    && entity.geometry.kind === "asset" && entity.geometry.materialMode === "source") return false
  if (property === "opacity") return ["mesh", "image", "video", "diagram"].includes(entity.kind)
  if (property === "color") return ["mesh", "text", "light"].includes(entity.kind)
  return true
}

/** One property writer per interval; a transform override owns position, rotation and scale. */
export function validateSpatialOverrides(scene: SpatialSceneV1, overrides: readonly SpatialOverride[]): void {
  const entities = new Map(scene.entities.map(entity => [entity.entityId, entity]))
  const generators = new Map(scene.generators.map(generator => [generator.generatorId, generator]))
  unique(overrides, override => `${override.entityId}:${override.property}`, "overrides")
  for (const override of overrides) {
    const entity = requireReference(entities, override.entityId, "overrides")
    if (!spatialPropertySupported(entity, override.property)) throw new SpatialSceneError("conflict", `Entity ${entity.entityId} does not support ${override.property}.`, "overrides")
    if (entity.origin.kind === "generated") {
      const origin = entity.origin
      const generator = requireReference(generators, origin.generatorId, "overrides")
      if (!generator.editableKeys.some(item => item.key === origin.key && item.properties.includes(override.property))) {
        throw new SpatialSceneError("conflict", `Undeclared override ${origin.key}.${override.property}.`, "overrides")
      }
    }
    const properties = override.property === "transform" ? ["position", "rotation", "scale"] : [override.property]
    if (scene.animations.some(channel => channel.targetId === entity.entityId && properties.includes(channel.property))) {
      throw new SpatialSceneError("conflict", `Animation and override both write ${entity.entityId}.${override.property}.`, "overrides")
    }
  }
}

export function parseSpatialScene(input: unknown): SpatialSceneV1 {
  const parsed = parseSpatialValue(SpatialSceneV1Schema, input, "scene")
  const scene: SpatialSceneV1 = {
    ...parsed,
    entities: sortSpatialBy(parsed.entities.map(normalizeEntity), item => item.entityId),
    cameras: sortSpatialBy(parsed.cameras, item => item.cameraId),
    assets: sortSpatialBy(parsed.assets.map(normalizeAsset).map(asset => ({ ...asset, dependencies: [...asset.dependencies].sort(compare) })), item => item.assetId),
    animations: sortSpatialBy(parsed.animations, item => item.channelId),
    generators: sortSpatialBy(parsed.generators.map(generator => ({ ...generator, editableKeys: sortSpatialBy(generator.editableKeys.map(item => ({ ...item, properties: [...item.properties].sort(compare) })), item => item.key) })), item => item.generatorId),
    overrides: sortSpatialBy(parsed.overrides.map(item => item.property === "color" ? { ...item, value: item.value.toLowerCase() } : item), item => `${item.entityId}:${item.property}`),
  }
  const entities = unique(scene.entities, entity => entity.entityId, "entities")
  const cameras = unique(scene.cameras, camera => camera.cameraId, "cameras")
  const assets = unique(scene.assets, asset => asset.assetId, "assets")
  const generators = unique(scene.generators, generator => generator.generatorId, "generators")
  unique(scene.animations, channel => channel.channelId, "animations")
  unique(scene.animations, channel => `${channel.targetId}:${channel.property}`, "animation writers")
  let payloadBytes = 0
  for (const asset of scene.assets) {
    unique(asset.dependencies, id => id, "asset dependencies")
    payloadBytes += asset.payload.bytes
    if (payloadBytes > 268_435_456) throw new SpatialSceneError("invalid-data", "Asset closure exceeds 256 MiB.", "assets")
    if ((asset.interpretation.kind === "image" || asset.interpretation.kind === "video") && asset.interpretation.width * asset.interpretation.height > 33_554_432) throw new SpatialSceneError("invalid-data", "Asset exceeds the 32-megapixel limit.", "assets")
  }
  spatialTopologicalIds(new Map(scene.assets.map(asset => [asset.assetId, asset.dependencies])), "asset dependencies")
  spatialTopologicalIds(new Map(scene.entities.map(entity => [entity.entityId, entity.parentId === null ? [] : [entity.parentId]])), "entity hierarchy")
  const generatedKeys = new Set<string>()
  for (const entity of scene.entities) {
    if (entity.placement.kind === "view") requireReference(cameras, entity.placement.cameraId, "placement")
    if (entity.parentId !== null) {
      const parent = requireReference(entities, entity.parentId, "parent")
      const a = parent.placement, b = entity.placement
      if (a.kind !== b.kind || (a.kind === "view" && b.kind === "view" && (a.cameraId !== b.cameraId || a.units !== b.units))) throw new SpatialSceneError("invalid-data", "Parent and child must share their world or view coordinate domain.", "placement")
    }
    if (entity.origin.kind === "generated") {
      const { generatorId, key } = entity.origin
      requireReference(generators, generatorId, "origin")
      if (entity.entityId !== generatedSpatialEntityId(generatorId, key)) throw new SpatialSceneError("invalid-data", "Generated entity identity must derive from its generator and stable key.", "origin")
      const identity = `${generatorId}:${key}`
      if (generatedKeys.has(identity)) throw new SpatialSceneError("invalid-data", "Duplicate generator output key.", "origin")
      generatedKeys.add(identity)
    }
    const reference = entity.kind === "mesh" && entity.geometry.kind === "asset" ? { assetId: entity.geometry.assetId, kind: "gltf" }
      : entity.kind === "text" ? { assetId: entity.fontAssetId, kind: "font" }
      : "assetId" in entity ? { assetId: entity.assetId, kind: entity.kind } : undefined
    if (reference) {
      const asset = requireReference(assets, reference.assetId, "entity asset")
      if (asset.interpretation.kind !== reference.kind) throw new SpatialSceneError("invalid-data", `Entity ${entity.entityId} requires a ${reference.kind} asset.`, "entity asset")
      if (entity.kind === "video" && asset.interpretation.kind === "video" && entity.sourceOffsetUs >= asset.interpretation.durationUs) throw new SpatialSceneError("invalid-data", "Video source offset must precede its duration.", "sourceOffsetUs")
    }
  }
  for (const generator of scene.generators) {
    unique(generator.editableKeys, item => item.key, "generator editable keys")
    for (const editable of generator.editableKeys) {
      unique(editable.properties, item => item, "generator editable properties")
      const entity = entities.get(generatedSpatialEntityId(generator.generatorId, editable.key))
      if (!entity) throw new SpatialSceneError("conflict", `Orphan editable key ${editable.key}.`, "generators")
      if (editable.properties.some(property => !spatialPropertySupported(entity, property))) throw new SpatialSceneError("invalid-data", `Editable key ${editable.key} declares an unsupported property.`, "generators")
    }
    const retained = scene.entities.filter(entity => entity.origin.kind === "generated" && entity.origin.generatorId === generator.generatorId)
    if (spatialGeneratorOutputSha256(retained) !== generator.outputSha256) throw new SpatialSceneError("conflict", "Retained generator output does not match its pinned digest.", "generators")
  }
  for (const channel of scene.animations) {
    const entity = entities.get(channel.targetId)
    if (entity === undefined) {
      requireReference(cameras, channel.targetId, "animation target")
      if (channel.property !== "position" && channel.property !== "rotation") throw new SpatialSceneError("invalid-data", "Camera animation supports only position and rotation.", "animations")
    } else {
      if (!spatialPropertySupported(entity, channel.property)) throw new SpatialSceneError("invalid-data", `Unsupported ${channel.property} animation.`, "animations")
      if (entity.origin.kind === "generated") {
        const origin = entity.origin
        const control = channel.property === "opacity" ? "opacity" : "transform"
        if (!generators.get(origin.generatorId)!.editableKeys.some(item => item.key === origin.key && item.properties.includes(control))) throw new SpatialSceneError("conflict", `Generated animation requires declared ${control} control.`, "animations")
      }
    }
    let previous = -1
    for (const key of channel.keys) {
      if (key.timeUs <= previous || key.timeUs > scene.durationUs) throw new SpatialSceneError("invalid-data", "Animation keys must be strictly ordered within scene duration.", "animations")
      previous = key.timeUs
    }
  }
  validateSpatialOverrides(scene, scene.overrides)
  // Freeze the normalized, validated authored document without any renderer or host effects.
  return deepFreezeJson(scene)
}

export function spatialSceneSha256(input: unknown): string {
  return spatialValueSha256(parseSpatialScene(input))
}
