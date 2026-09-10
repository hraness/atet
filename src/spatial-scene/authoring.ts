import { parseSpatialScene } from "./identity.js"
import type { SpatialSceneV1 } from "./contracts.js"

/** A complete editable source with stable part names and a calibrated camera. */
export function createSpatialSceneStarter(): SpatialSceneV1 {
  const transform = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }
  const common = { parentId: null, placement: { kind: "world" }, origin: { kind: "authored" }, visible: true }
  return parseSpatialScene({
    kind: "slopcamera.spatial-scene", schemaVersion: 1, sceneId: "scene_starter",
    coordinates: "right-handed-y-up-meters", durationUs: 4_000_000,
    entities: [
      { ...common, entityId: "entity_product", name: "Product", kind: "mesh", transform,
        geometry: { kind: "box", size: [1.4, 1.4, 1.4] }, material: { kind: "standard", color: "#3674ee", opacity: 1, roughness: 0.35, metalness: 0.1 } },
      { ...common, entityId: "entity_pedestal", name: "Pedestal", kind: "mesh", transform: { ...transform, position: [0, -0.9, 0] },
        geometry: { kind: "cylinder", radius: 1.15, height: 0.35 }, material: { kind: "standard", color: "#cbd5e1", opacity: 1, roughness: 0.7, metalness: 0 } },
      { ...common, entityId: "entity_fill", name: "Fill", kind: "light", transform,
        light: "ambient", color: "#ffffff", intensity: 2 },
      { ...common, entityId: "entity_key", name: "Key", kind: "light", transform: { ...transform, position: [3, 4, 5] },
        light: "directional", color: "#ffffff", intensity: 3 },
    ],
    cameras: [{ cameraId: "camera_hero", name: "Hero", pose: { position: [0, 0.3, 5], rotation: [0, 0, 0, 1] },
      projection: { kind: "perspective", width: 960, height: 540, fx: 650, fy: 650, cx: 480, cy: 270, near: 0.1, far: 100 } }],
    animations: [{ channelId: "channel_turn", targetId: "entity_product", property: "rotation", interpolation: "slerp",
      keys: [{ timeUs: 0, value: [0, 0, 0, 1] }, { timeUs: 2_000_000, value: [0, 0.7071067811865475, 0, 0.7071067811865476] }, { timeUs: 4_000_000, value: [0, 1, 0, 0] }] }],
    assets: [], generators: [], overrides: [],
  })
}
