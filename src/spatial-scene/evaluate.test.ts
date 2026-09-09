import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { evaluateSpatialScene, validateSpatialShot } from "./evaluate.js"
import { spatialSceneSha256 } from "./identity.js"
import { inspectSpatialScene } from "./inspect.js"
import { fixtureAsset, fixtureCamera, fixtureEntity, fixtureScene, fixtureTransform } from "./test-fixture.js"

describe("immutable absolute-time spatial evaluation", () => {
  test("maximum entity count has a bounded derived identity budget for its matrices", () => {
    const scene = { ...fixtureScene(), entities: Array.from({ length: 4096 }, (_, index) => fixtureEntity(`entity_${index}`)) }
    const snapshot = evaluateSpatialScene(scene, { timeUs: 0, cameraId: "camera_main" })
    expect(snapshot.entities).toHaveLength(4096)
    expect(snapshot.entities.at(-1)!.selectionId).toBe(4096)
    expect(snapshot.stateSha256).toMatch(/^[a-f0-9]{64}$/u)
  })

  test("repeat, reverse and arbitrary samples agree without advancing shared state", () => {
    const scene = { ...fixtureScene(), animations: [
      { channelId: "channel_move", targetId: "entity_box", property: "position", interpolation: "linear", keys: [{ timeUs: 0, value: [0, 0, 0] }, { timeUs: 1_000_000, value: [10, 20, -30] }] },
      { channelId: "channel_opacity", targetId: "entity_box", property: "opacity", interpolation: "linear", keys: [{ timeUs: 100_000, value: 0 }, { timeUs: 900_000, value: 1 }] },
    ] }
    const before = JSON.stringify(scene)
    const samples = [0, 1_000_000, 250_000, 500_000, 0, 750_000, 500_000].map(timeUs => evaluateSpatialScene(scene, { timeUs, cameraId: "camera_main" }))
    expect(samples[0]).toEqual(samples[4])
    expect(samples[3]).toEqual(samples[6])
    expect(samples[3]!.entities[0]!.worldMatrix.slice(12, 15)).toEqual([5, 10, -15])
    expect(samples[3]!.entities[0]!.entity).toMatchObject({ material: { opacity: 0.5 } })
    expect(Object.isFrozen(samples[0]!.entities[0]!.entity.transform.position)).toBe(true)
    expect(JSON.stringify(scene)).toBe(before)
    fc.assert(fc.property(fc.integer({ min: 0, max: 1_000_000 }), timeUs => {
      const a = evaluateSpatialScene(scene, { timeUs, cameraId: "camera_main" })
      evaluateSpatialScene(scene, { timeUs: 1_000_000 - timeUs, cameraId: "camera_main" })
      expect(a).toEqual(evaluateSpatialScene(scene, { timeUs, cameraId: "camera_main" }))
      expect(a.entities[0]!.worldMatrix[12]).toBeCloseTo(timeUs / 100_000, 10)
    }), { numRuns: 50, seed: 4202 })
  })

  test("step boundaries and shortest arc quaternion interpolation are explicit", () => {
    const scene = { ...fixtureScene(), animations: [
      { channelId: "channel_move", targetId: "entity_box", property: "position", interpolation: "step", keys: [{ timeUs: 200_000, value: [1, 0, 0] }, { timeUs: 500_000, value: [2, 0, 0] }] },
      { channelId: "channel_turn", targetId: "entity_box", property: "rotation", interpolation: "slerp", keys: [{ timeUs: 0, value: [0, 0, 0, 1] }, { timeUs: 1_000_000, value: [0, 1, 0, 0] }] },
    ] }
    expect(evaluateSpatialScene(scene, { timeUs: 0, cameraId: "camera_main" }).entities[0]!.entity.transform.position).toEqual([1, 0, 0])
    expect(evaluateSpatialScene(scene, { timeUs: 499_999, cameraId: "camera_main" }).entities[0]!.entity.transform.position).toEqual([1, 0, 0])
    const midpoint = evaluateSpatialScene(scene, { timeUs: 500_000, cameraId: "camera_main" }).entities[0]!
    expect(midpoint.entity.transform.position).toEqual([2, 0, 0])
    expect(midpoint.entity.transform.rotation[1]).toBeCloseTo(Math.SQRT1_2, 12)
    expect(midpoint.worldMatrix[0]).toBeCloseTo(0, 12)
  })

  test("camera changes affect only view identity, entity overrides affect state, shot precedence is explicit", () => {
    const scene = { ...fixtureScene(), cameras: [fixtureCamera(), fixtureCamera("camera_second")], overrides: [{ entityId: "entity_box", property: "color", value: "#ff0000" }] }
    const base = evaluateSpatialScene(scene, { timeUs: 0, cameraId: "camera_main" })
    const moved = evaluateSpatialScene(scene, { timeUs: 0, cameraId: "camera_main", cameraPoseOverride: { position: [5, 0, 10], rotation: [0, 0, 0, 1] } })
    const second = evaluateSpatialScene(scene, { timeUs: 0, cameraId: "camera_second" })
    expect(moved.stateSha256).toBe(base.stateSha256)
    expect(moved.viewSha256).not.toBe(base.viewSha256)
    expect(second.stateSha256).toBe(base.stateSha256)
    expect(second.viewSha256).not.toBe(base.viewSha256)
    const override = evaluateSpatialScene(scene, { timeUs: 0, cameraId: "camera_main", overrides: [{ entityId: "entity_box", property: "color", value: "#0000ff" }] })
    expect(override.entities[0]!.entity).toMatchObject({ material: { color: "#0000ff" } })
    expect(override.stateSha256).not.toBe(base.stateSha256)
    expect(base.entities[0]!.entity).toMatchObject({ material: { color: "#ff0000" } })
    expect(() => evaluateSpatialScene(scene, { timeUs: 0, cameraId: "camera_main", overrides: [{ entityId: "entity_box", property: "color", value: "#0000ff" }, { entityId: "entity_box", property: "color", value: "#ffffff" }] })).toThrow()
  })

  test("hierarchy composes affine matrices and inherited visibility, view domains remain isolated", () => {
    const scene = { ...fixtureScene(), cameras: [fixtureCamera(), fixtureCamera("camera_other")], entities: [
      { ...fixtureEntity("entity_parent"), visible: false, transform: { ...fixtureTransform, position: [3, 4, 5], scale: [2, 3, 4] } },
      { ...fixtureEntity("entity_child"), parentId: "entity_parent", transform: { ...fixtureTransform, position: [1, 2, 3] } },
      { ...fixtureEntity("entity_view"), placement: { kind: "view", cameraId: "camera_other", units: "pixels", order: 0 } },
    ] }
    const snapshot = evaluateSpatialScene(scene, { timeUs: 0, cameraId: "camera_main" })
    const child = snapshot.entities.find(item => item.entity.entityId === "entity_child")!
    expect(child.worldMatrix.slice(12, 15)).toEqual([5, 10, 17])
    expect(child.visible).toBe(false)
    expect(snapshot.entities.find(item => item.entity.entityId === "entity_view")!.visible).toBe(false)
    expect(evaluateSpatialScene(scene, { timeUs: 0, cameraId: "camera_other" }).entities.find(item => item.entity.entityId === "entity_view")!.visible).toBe(true)
  })

  test("invalid evaluation options and camera writer conflicts fail before producing snapshots", () => {
    const scene = fixtureScene()
    for (const options of [{ timeUs: -1, cameraId: "camera_main" }, { timeUs: 1_000_001, cameraId: "camera_main" }, { timeUs: 0.1, cameraId: "camera_main" }, { timeUs: 0, cameraId: "camera_absent" }, { timeUs: 0, cameraId: "camera_main", advanceSimulation: true }]) expect(() => evaluateSpatialScene(scene, options)).toThrow()
    const animatedCamera = { ...scene, animations: [{ channelId: "channel_camera", targetId: "camera_main", property: "position", interpolation: "linear", keys: [{ timeUs: 0, value: [1, 2, 3] }] }] }
    expect(() => evaluateSpatialScene(animatedCamera, { timeUs: 0, cameraId: "camera_main", cameraPoseOverride: fixtureCamera().pose })).toThrow()
  })

  test("shot validation pins exact source, camera and playable range", () => {
    const scene = fixtureScene()
    const shot = { shotId: "shot_main", sceneSha256: spatialSceneSha256(scene), cameraId: "camera_main", range: { startUs: 2_000_000, endUs: 3_000_000 }, sceneStartUs: 0, playback: "once" as const, overrides: [] }
    expect(validateSpatialShot(scene, shot)).toEqual(shot)
    for (const patch of [{ sceneSha256: "f".repeat(64) }, { cameraId: "camera_absent" }, { sceneStartUs: 1_000_000 }, { range: { startUs: 0, endUs: 1_000_001 } }]) expect(() => validateSpatialShot(scene, { ...shot, ...patch })).toThrow()
    expect(validateSpatialShot(scene, { ...shot, playback: "loop", range: { startUs: 0, endUs: 2_000_000 } }).playback).toBe("loop")
  })

  test("inspection reports authored bounds and never claims decoded GLB bounds", () => {
    const box = inspectSpatialScene(fixtureScene()).entities[0]!
    expect(box.bounds).toEqual({ status: "authored-enclosure", coordinateDomain: { kind: "world" }, atTimeUs: 0, bounds: { min: [-1, -2, -3], max: [1, 2, 3] } })
    expect(box.editableControls).toEqual(["color", "opacity", "transform"])
    const asset = { ...fixtureAsset("asset_model"), interpretation: { kind: "gltf", format: "glb", metersPerUnit: 1, sourceUp: "y" } }
    const scene = { ...fixtureScene(), assets: [asset], entities: [{ ...fixtureEntity(), geometry: { kind: "asset", assetId: "asset_model" } }] }
    const inspection = inspectSpatialScene(scene)
    expect(inspection.entities[0]!.bounds).toEqual({ status: "unknown", reason: "requires-asset-decoding" })
    expect(inspection.entities[0]!.assetIds).toEqual(["asset_model"])
  })
})
