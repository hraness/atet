import type { SpatialAssetManifest, SpatialCamera, SpatialEntity, SpatialGenerator, SpatialSceneV1 } from "./contracts.js"
import { generatedSpatialEntityId, spatialGeneratorOutputSha256 } from "./identity.js"

export const fixtureTransform = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } as const
export function fixtureEntity(entityId = "entity_box"): SpatialEntity {
  return { entityId, kind: "mesh", name: "Box", parentId: null, transform: fixtureTransform,
    origin: { kind: "authored" }, placement: { kind: "world" }, visible: true,
    geometry: { kind: "box", size: [2, 4, 6] }, material: { kind: "unlit", color: "#aa00ff", opacity: 1 } }
}
export function fixtureCamera(cameraId = "camera_main"): SpatialCamera {
  return { cameraId, name: "Main", pose: { position: [0, 0, 10], rotation: [0, 0, 0, 1] },
    projection: { kind: "perspective", width: 960, height: 540, fx: 800, fy: 700, cx: 411, cy: 287, near: 0.1, far: 100 } }
}
export function fixtureAsset(assetId = "asset_image"): SpatialAssetManifest {
  return { assetId, payload: { path: "assets/image.png", sha256: "a".repeat(64), bytes: 100 },
    interpretation: { kind: "image", mimeType: "image/png", width: 32, height: 32, colorSpace: "srgb", alpha: "straight" },
    dependencies: [], provenance: { source: "authored", description: "Fixture" } }
}
export function fixtureScene(): SpatialSceneV1 {
  return { kind: "slopcamera.spatial-scene", schemaVersion: 1, sceneId: "scene_fixture", coordinates: "right-handed-y-up-meters", durationUs: 1_000_000,
    entities: [fixtureEntity()], cameras: [fixtureCamera()], assets: [], generators: [], animations: [], overrides: [] }
}
export function fixtureGenerated(): { entity: SpatialEntity; generator: SpatialGenerator } {
  const entity: SpatialEntity = { ...fixtureEntity(generatedSpatialEntityId("generator_tiles", "tile-0")), origin: { kind: "generated", generatorId: "generator_tiles", key: "tile-0" } }
  return { entity, generator: { generatorId: "generator_tiles", sourceSha256: "1".repeat(64), closureSha256: "2".repeat(64), parametersSha256: "3".repeat(64), seed: 42,
    outputSha256: spatialGeneratorOutputSha256([entity]), execution: { kind: "qualified", runtimeSha256: "4".repeat(64) }, editableKeys: [{ key: "tile-0", properties: ["color", "transform"] }] } }
}
