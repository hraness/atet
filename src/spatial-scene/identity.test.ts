import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { parseSpatialScene, spatialSceneSha256, spatialAssetManifestSha256, generatedSpatialEntityId, spatialGeneratorOutputSha256 } from "./identity.js"
import { fixtureAsset, fixtureCamera, fixtureEntity, fixtureGenerated, fixtureScene } from "./test-fixture.js"
import { inspectSpatialScene } from "./inspect.js"
import { applySpatialScenePatch } from "./patch.js"
import { evaluateSpatialScene, validateSpatialShot } from "./evaluate.js"

describe("bounded spatial identity", () => {
  test("captures strict plain JSON without getters, prototype behavior, cycles or excessive values", () => {
    let invoked = false
    const getter = { ...fixtureScene(), get surprise() { invoked = true; return 1 } }
    for (const input of [getter, Object.assign(Object.create({ surprise: true }) as object, fixtureScene()), { ...fixtureScene(), surprise: true }, { ...fixtureScene(), durationUs: NaN }, { ...fixtureScene(), durationUs: Infinity }]) expect(() => parseSpatialScene(input)).toThrow()
    expect(invoked).toBe(false)
    const cyclic: Record<string, unknown> = { ...fixtureScene() }; cyclic.self = cyclic
    expect(() => parseSpatialScene(cyclic)).toThrow()
    const array = [fixtureEntity()]; Object.defineProperty(array, "extra", { value: 1, enumerable: true })
    expect(() => parseSpatialScene({ ...fixtureScene(), entities: array })).toThrow()
    expect(() => parseSpatialScene({ ...fixtureScene(), extra: "x".repeat(2_097_153) })).toThrow()
    expect(() => parseSpatialScene({ ...fixtureScene(), entities: Array.from({ length: 4097 }, (_, i) => fixtureEntity(`entity_${i}`)) })).toThrow()
    let deep: unknown = 0; for (let i = 0; i < 33; i++) deep = { deep }
    expect(() => parseSpatialScene({ ...fixtureScene(), deep })).toThrow()
  })

  test("normalization is permutation invariant, frozen, detached and idempotent", () => {
    fc.assert(fc.property(fc.uniqueArray(fc.integer({ min: 0, max: 1000 }), { minLength: 1, maxLength: 30 }), ids => {
      const entities = ids.map(id => fixtureEntity(`entity_${id}`))
      const input = { ...fixtureScene(), entities }
      const parsed = parseSpatialScene(input)
      expect(spatialSceneSha256(input)).toBe(spatialSceneSha256({ ...input, entities: [...entities].reverse() }))
      expect(parseSpatialScene(parsed)).toEqual(parsed)
      expect(spatialSceneSha256(JSON.parse(JSON.stringify(parsed)))).toBe(spatialSceneSha256(parsed))
      expect(Object.isFrozen(parsed.entities[0]!.transform.position)).toBe(true)
      expect(parsed.entities).not.toBe(entities)
    }), { numRuns: 60, seed: 4201 })
  })

  test("asset identity binds interpretation and dependency closure, excludes relocation and description", () => {
    const asset = fixtureAsset()
    const digest = spatialAssetManifestSha256(asset)
    expect(spatialAssetManifestSha256({ ...asset, payload: { ...asset.payload, path: "other/image.png" }, provenance: { source: "imported", description: "Moved" } })).toBe(digest)
    expect(spatialAssetManifestSha256({ ...asset, interpretation: { ...asset.interpretation, width: 64 } })).not.toBe(digest)
    expect(spatialAssetManifestSha256({ ...asset, payload: { ...asset.payload, sha256: "b".repeat(64) } })).not.toBe(digest)
    const dependent = { ...asset, dependencies: ["asset_texture"] }
    expect(() => spatialAssetManifestSha256(dependent)).toThrow()
    expect(spatialAssetManifestSha256(dependent, { asset_texture: "a".repeat(64) })).not.toBe(spatialAssetManifestSha256(dependent, { asset_texture: "b".repeat(64) }))
  })

  test("rejects duplicate identities, missing refs, dependency and hierarchy cycles, placement crossings", () => {
    const scene = fixtureScene(), box = fixtureEntity(), second = fixtureEntity("entity_second"), asset = fixtureAsset()
    const invalid = [
      { entities: [box, box] }, { cameras: [fixtureCamera(), fixtureCamera()] }, { assets: [asset, asset] },
      { entities: [{ ...box, parentId: "entity_absent" }] },
      { entities: [{ ...box, parentId: second.entityId }, { ...second, parentId: box.entityId }] },
      { assets: [{ ...asset, dependencies: [asset.assetId] }] },
      { assets: [{ ...asset, dependencies: ["asset_missing"] }] },
      { entities: [box, { ...second, parentId: box.entityId, placement: { kind: "view", cameraId: "camera_main", units: "pixels", order: 0 } }] },
      { entities: [{ ...box, placement: { kind: "view", cameraId: "camera_missing", units: "pixels", order: 0 } }] },
      { entities: [{ ...box, geometry: { kind: "asset", assetId: asset.assetId } }], assets: [asset] },
      { assets: [{ ...asset, dependencies: ["asset_second", "asset_second"] }, fixtureAsset("asset_second")] },
    ]
    for (const patch of invalid) expect(() => parseSpatialScene({ ...scene, ...patch })).toThrow()
  })

  test("generated IDs survive order changes, output digests bind retained bytes and declarations stay closed", () => {
    const { entity, generator } = fixtureGenerated()
    const scene = { ...fixtureScene(), entities: [entity], generators: [generator] }
    expect(parseSpatialScene(scene).entities[0]!.entityId).toBe(generatedSpatialEntityId(generator.generatorId, "tile-0"))
    expect(generatedSpatialEntityId(generator.generatorId, "tile-0")).not.toBe(generatedSpatialEntityId(generator.generatorId, "tile-1"))
    expect(spatialGeneratorOutputSha256([entity])).toBe(generator.outputSha256)
    for (const patch of [
      { entities: [{ ...entity, name: "Unretained edit" }] },
      { entities: [{ ...entity, entityId: "entity_wrong" }] },
      { generators: [{ ...generator, editableKeys: [{ key: "absent", properties: ["color"] }] }] },
      { overrides: [{ entityId: entity.entityId, property: "opacity", value: 0.5 }] },
      { overrides: [{ entityId: "entity_missing", property: "color", value: "#ffffff" }] },
    ]) expect(() => parseSpatialScene({ ...scene, ...patch })).toThrow()
    expect(parseSpatialScene({ ...scene, overrides: [{ entityId: entity.entityId, property: "color", value: "#FFFFFF" }] }).overrides[0]).toMatchObject({ value: "#ffffff" })
  })

  test("animation keys, targets, semantic properties and writers are validated", () => {
    const channel = { channelId: "channel_move", targetId: "entity_box", property: "position", interpolation: "linear", keys: [{ timeUs: 0, value: [0, 0, 0] }, { timeUs: 1_000_000, value: [1, 2, 3] }] }
    expect(parseSpatialScene({ ...fixtureScene(), animations: [channel] }).animations).toHaveLength(1)
    for (const animations of [
      [channel, { ...channel, channelId: "channel_other" }],
      [{ ...channel, targetId: "entity_absent" }],
      [{ ...channel, keys: [...channel.keys].reverse() }],
      [{ ...channel, keys: [channel.keys[0], channel.keys[0]] }],
      [{ ...channel, keys: [{ timeUs: 1_000_001, value: [0, 0, 0] }] }],
      [{ ...channel, targetId: "camera_main", property: "scale" }],
    ]) expect(() => parseSpatialScene({ ...fixtureScene(), animations })).toThrow()
    expect(() => parseSpatialScene({ ...fixtureScene(), animations: [channel], overrides: [{ entityId: "entity_box", property: "transform", value: fixtureEntity().transform }] })).toThrow()
  })

  test("source-material GLB entities expose only effective controls and reject invisible material writes", () => {
    const scene = parseSpatialScene({
      ...fixtureScene(),
      assets: [{ ...fixtureAsset("asset_model"), interpretation: { kind: "gltf", format: "glb", metersPerUnit: 1, sourceUp: "y" } }],
      entities: [{ ...fixtureEntity(), geometry: { kind: "asset", assetId: "asset_model", materialMode: "source" } }],
    })
    expect(inspectSpatialScene(scene).entities[0]!.editableControls).toEqual(["transform"])
    const patch = (operations: unknown[]) => ({ kind: "slopcamera.spatial-scene-patch", schemaVersion: 1, expectedSceneSha256: spatialSceneSha256(scene), operations })
    for (const property of ["color", "opacity"] as const) {
      const override = property === "color" ? { entityId: "entity_box", property, value: "#ffffff" } : { entityId: "entity_box", property, value: 0.5 }
      const operation = property === "color" ? { kind: "set-color", entityId: "entity_box", color: "#ffffff" } : { kind: "set-opacity", entityId: "entity_box", opacity: 0.5 }
      expect(() => applySpatialScenePatch(scene, patch([operation]))).toThrow("Unsupported override")
      expect(() => parseSpatialScene({ ...scene, overrides: [override] })).toThrow("does not support")
      expect(() => evaluateSpatialScene(scene, { timeUs: 0, cameraId: "camera_main", overrides: [override] })).toThrow("does not support")
      expect(() => validateSpatialShot(scene, { shotId: "shot_main", sceneSha256: spatialSceneSha256(scene), cameraId: "camera_main", range: { startUs: 0, endUs: 1_000_000 }, sceneStartUs: 0, playback: "once", overrides: [override] })).toThrow("does not support")
    }
    expect(() => parseSpatialScene({ ...scene, animations: [{ channelId: "channel_fade", targetId: "entity_box", property: "opacity", interpolation: "linear", keys: [{ timeUs: 0, value: 0 }, { timeUs: 1_000_000, value: 1 }] }] })).toThrow("Unsupported opacity")
    const moved = applySpatialScenePatch(scene, patch([{ kind: "set-transform", entityId: "entity_box", transform: { ...fixtureEntity().transform, position: [1, 2, 3] } }])).scene
    expect(moved.entities[0]!.transform.position).toEqual([1, 2, 3])
  })

  test("entity-material GLB meshes retain supported visible color and opacity controls", () => {
    for (const materialMode of [undefined, "entity"] as const) {
      const scene = parseSpatialScene({
        ...fixtureScene(),
        assets: [{ ...fixtureAsset("asset_model"), interpretation: { kind: "gltf", format: "glb", metersPerUnit: 1, sourceUp: "y" } }],
        entities: [{ ...fixtureEntity(), geometry: { kind: "asset", assetId: "asset_model", ...(materialMode === undefined ? {} : { materialMode }) } }],
      })
      expect(inspectSpatialScene(scene).entities[0]!.editableControls).toEqual(["color", "opacity", "transform"])
      const changed = applySpatialScenePatch(scene, { kind: "slopcamera.spatial-scene-patch", schemaVersion: 1, expectedSceneSha256: spatialSceneSha256(scene), operations: [{ kind: "set-color", entityId: "entity_box", color: "#abcdef" }, { kind: "set-opacity", entityId: "entity_box", opacity: 0.5 }] }).scene.entities[0]!
      expect(changed.kind === "mesh" && changed.material).toMatchObject({ color: "#abcdef", opacity: 0.5 })
    }
  })
})
