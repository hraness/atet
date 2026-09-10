import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { applySpatialScenePatch } from "./patch.js"
import { spatialAssetClosureDigests, spatialGeneratorOutputSha256, spatialSceneSha256 } from "./identity.js"
import { fixtureAsset, fixtureEntity, fixtureGenerated, fixtureScene } from "./test-fixture.js"

function patch(scene: unknown, operations: unknown[]) {
  return { kind: "slopcamera.spatial-scene-patch", schemaVersion: 1, expectedSceneSha256: spatialSceneSha256(scene), operations }
}

describe("typed atomic authored scene patches", () => {
  test("compare-and-swap and failed closure leave source untouched", () => {
    const scene = fixtureScene(), before = JSON.stringify(scene)
    expect(() => applySpatialScenePatch(scene, { ...patch(scene, [{ kind: "rename-entity", entityId: "entity_box", name: "New" }]), expectedSceneSha256: "f".repeat(64) })).toThrow()
    expect(() => applySpatialScenePatch(scene, patch(scene, [{ kind: "rename-entity", entityId: "entity_box", name: "New" }, { kind: "reparent-entity", entityId: "entity_box", parentId: "entity_absent" }]))).toThrow()
    expect(JSON.stringify(scene)).toBe(before)
  })

  test("no-op identity, inverse rename and unrelated edit commutativity laws", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 10000 }), seed => {
      const scene = { ...fixtureScene(), entities: [fixtureEntity(), fixtureEntity("entity_second")] }
      const renameA = { kind: "rename-entity", entityId: "entity_box", name: `Name ${seed}` }
      const renameB = { kind: "rename-entity", entityId: "entity_second", name: `Second ${seed}` }
      const ab = applySpatialScenePatch(scene, patch(scene, [renameA, renameB]))
      const ba = applySpatialScenePatch(scene, patch(scene, [renameB, renameA]))
      expect(ab).toEqual(ba)
      const inverse = applySpatialScenePatch(ab.scene, patch(ab.scene, [{ ...renameA, name: "Box" }, { ...renameB, name: "Box" }]))
      expect(inverse.sceneSha256).toBe(spatialSceneSha256(scene))
      const noop = applySpatialScenePatch(ab.scene, patch(ab.scene, [renameA]))
      expect(noop.sceneSha256).toBe(ab.sceneSha256)
      expect(noop.diff).toEqual([])
      expect(ab.diff).toEqual([{ kind: "changed", collection: "entities", id: "entity_box", properties: ["name"] }, { kind: "changed", collection: "entities", id: "entity_second", properties: ["name"] }])
    }), { numRuns: 40, seed: 4203 })
  })

  test("transactions may repair intermediate closure but cannot leave orphans", () => {
    const scene = { ...fixtureScene(), entities: [fixtureEntity(), { ...fixtureEntity("entity_child"), parentId: "entity_box" }] }
    expect(() => applySpatialScenePatch(scene, patch(scene, [{ kind: "remove-entity", entityId: "entity_box" }]))).toThrow()
    const removed = applySpatialScenePatch(scene, patch(scene, [{ kind: "remove-entity", entityId: "entity_box" }, { kind: "remove-entity", entityId: "entity_child" }]))
    expect(removed.scene.entities).toEqual([])
    expect(removed.diff.map(item => item.kind)).toEqual(["removed", "removed"])
  })

  test("generator edits preserve retained output and orphan overrides require explicit resolution", () => {
    const { entity, generator } = fixtureGenerated()
    const scene = { ...fixtureScene(), entities: [entity], generators: [generator], overrides: [{ entityId: entity.entityId, property: "color" as const, value: "#0000ff" }] }
    expect(() => applySpatialScenePatch(scene, patch(scene, [{ kind: "set-color", entityId: entity.entityId, color: "#ffffff" }]))).toThrow()
    const output = { ...entity, name: "New retained output" }
    const replacement = { kind: "replace-generator-output", generator: { ...generator, outputSha256: spatialGeneratorOutputSha256([output]) }, entities: [output] }
    const updated = applySpatialScenePatch(scene, patch(scene, [replacement]))
    expect(updated.scene.overrides).toEqual(scene.overrides)
    expect(updated.scene.entities[0]!.name).toBe("New retained output")
    const empty = { kind: "replace-generator-output", generator: { ...generator, editableKeys: [], outputSha256: spatialGeneratorOutputSha256([]) }, entities: [] }
    expect(() => applySpatialScenePatch(scene, patch(scene, [empty]))).toThrow()
    expect(applySpatialScenePatch(scene, patch(scene, [empty, { kind: "remove-override", entityId: entity.entityId, property: "color" }])).scene.entities).toEqual([])
  })

  test("generated transitive asset changes require explicit retained output replacement", () => {
    const generated = fixtureGenerated()
    if (generated.entity.kind !== "mesh") throw new Error("Generated fixture must be a mesh.")
    const dependency = fixtureAsset("asset_texture")
    const meshAsset = { ...fixtureAsset("asset_mesh"), payload: { path: "assets/mesh.glb", sha256: "b".repeat(64), bytes: 200 },
      interpretation: { kind: "gltf" as const, format: "glb" as const, metersPerUnit: 1, sourceUp: "y" as const }, dependencies: [dependency.assetId] }
    const entity = { ...generated.entity, geometry: { kind: "asset" as const, assetId: meshAsset.assetId, materialMode: "entity" as const } }
    const generator = { ...generated.generator, outputSha256: spatialGeneratorOutputSha256([entity]) }
    const scene = { ...fixtureScene(), entities: [entity], generators: [generator], assets: [meshAsset, dependency] }
    const original = JSON.stringify(scene)
    const replacement = { kind: "replace-asset", asset: { ...dependency, payload: { ...dependency.payload, sha256: "c".repeat(64) } } }
    expect(() => applySpatialScenePatch(scene, patch(scene, [replacement]))).toThrow("asset closure requires explicit retained generator output replacement")
    expect(JSON.stringify(scene)).toBe(original)
    const result = applySpatialScenePatch(scene, patch(scene, [replacement, { kind: "replace-generator-output", generator, entities: [entity] }]))
    expect(result.scene.entities).toEqual(scene.entities)
    expect(result.scene.generators).toEqual(scene.generators)
    expect(result.scene.assets.find(asset => asset.assetId === meshAsset.assetId)).toEqual(meshAsset)
    expect(spatialAssetClosureDigests(result.scene.assets)[meshAsset.assetId]).not.toBe(spatialAssetClosureDigests(scene.assets)[meshAsset.assetId])
    expect(result.diff).toEqual([{ kind: "changed", collection: "assets", id: dependency.assetId, properties: ["payload"] }])
  })

  test("patch parser rejects unknown operations, unsafe shape, duplicate additions and oversize batches", () => {
    const scene = fixtureScene()
    for (const operations of [[{ kind: "execute", source: "throw Error()" }], [{ kind: "add-entity", entity: fixtureEntity() }], Array.from({ length: 257 }, () => ({ kind: "rename-entity", entityId: "entity_box", name: "Box" }))]) expect(() => applySpatialScenePatch(scene, patch(scene, operations))).toThrow()
  })
})
