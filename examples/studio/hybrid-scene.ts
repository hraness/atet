import { z } from "zod";
import {
  parseSpatialScene, parseSpatialValue, SpatialAssetIdSchema, SpatialAssetManifestSchema, SpatialCameraSchema, SpatialPayloadSchema,
  type SpatialSceneV1,
} from "@hraness/slopcamera/code";

/** Retained manifests and explicit host bindings; importing this authoring example is inert. */
const boundAssetSchema = z.strictObject({
  asset: SpatialAssetManifestSchema,
  binding: z.strictObject({ assetId: SpatialAssetIdSchema, artifact: SpatialPayloadSchema }),
}).refine(value => value.asset.assetId === value.binding.assetId && value.asset.payload.sha256 === value.binding.artifact.sha256
  && value.asset.payload.bytes === value.binding.artifact.bytes, "Asset binding must identify its exact retained payload.");
const inputSchema = z.strictObject({
  panel: boundAssetSchema, font: boundAssetSchema, city: boundAssetSchema.optional(),
  camera: SpatialCameraSchema.optional(), motion: z.enum(["locked", "reveal", "portal-loop"]).default("reveal"),
  durationUs: z.number().int().min(1).max(4_000_000).default(4_000_000),
});
export type HybridWorldSceneInput = z.input<typeof inputSchema>;
export const HYBRID_PANEL = Object.freeze({ center: Object.freeze([2.3, 1.47, -0.837] as const), width: 1.35, height: 2.4 });
export const HYBRID_PANEL_CAMERA = SpatialCameraSchema.parse({ cameraId: "camera_panel", name: "Calibrated world panel",
  pose: { position: [2.3, 1.47, 1.2255], rotation: [0,0,0,1] },
  projection: { kind: "perspective", width: 720, height: 1280, fx: 1100, fy: 1100, cx: 360, cy: 640, near: 0.03, far: 100 } });
Object.freeze(HYBRID_PANEL_CAMERA.pose.position); Object.freeze(HYBRID_PANEL_CAMERA.pose.rotation);
Object.freeze(HYBRID_PANEL_CAMERA.pose); Object.freeze(HYBRID_PANEL_CAMERA.projection); Object.freeze(HYBRID_PANEL_CAMERA);
const common = { parentId: null, placement: { kind: "world" }, origin: { kind: "authored" }, visible: true };
const transform = (position: readonly number[]) => ({ position: [...position], rotation: [0,0,0,1], scale: [1,1,1] });
const unlit = (color: string) => ({ kind: "unlit", color, opacity: 1 });
function lookAt(position: number[], target: readonly number[]) {
  const x = position[0]! - target[0]!, y = position[1]! - target[1]!, z = position[2]! - target[2]!;
  const yaw = Math.atan2(x,z) / 2, pitch = -Math.atan2(y,Math.hypot(x,z)) / 2;
  return { position, rotation: [Math.cos(yaw)*Math.sin(pitch), Math.sin(yaw)*Math.cos(pitch), -Math.sin(yaw)*Math.sin(pitch), Math.cos(yaw)*Math.cos(pitch)] };
}

/** One four-second explanation lives on a real plane in the same meter-based city. */
export function createHybridWorldScene(input: unknown): {
  readonly scene: SpatialSceneV1; readonly bindings: readonly z.infer<typeof boundAssetSchema>["binding"][];
} {
  const value = parseSpatialValue(inputSchema, input, "hybrid world scene"), camera = value.camera ?? HYBRID_PANEL_CAMERA;
  const panel = value.panel.asset.interpretation, font = value.font.asset.interpretation;
  if (panel.kind !== "video" && panel.kind !== "image" && panel.kind !== "diagram") throw new Error("Panel requires explicit video, image or diagram media.");
  if (panel.kind === "video" && panel.durationUs < value.durationUs) throw new Error("Panel video must cover the complete authored segment; no implicit looping.");
  if (font.kind !== "font" || font.format !== "otf") throw new Error("The example requires a declared OTF font.");
  if (value.city && (value.city.asset.interpretation.kind !== "gltf" || value.city.asset.interpretation.format !== "glb")) throw new Error("City requires an admitted GLB profile.");
  const x = HYBRID_PANEL.center[0], y = HYBRID_PANEL.center[1], z = HYBRID_PANEL.center[2];
  const box = (id: string, name: string, position: number[], size: number[], color: string) => ({ ...common,
    entityId: `entity_${id}`, kind: "mesh", name, geometry: { kind: "box", size }, material: unlit(color), transform: transform(position) });
  const label = (id: string, text: string, atY: number, fontSize: number, color: string) => ({ ...common,
    entityId: `entity_${id}`, kind: "text", name: text, fontAssetId: value.font.asset.assetId, text, fontSize, width: 1.12, color, align: "center", transform: transform([x,atY,z+0.016]) });
  const entities: unknown[] = [
    // All surfaces are world-space. The copper frame and foreground post have
    // actual thickness; a later camera move can reveal and occlude their edges.
    box("panel_back", "Midnight panel matte", [x,y,z-0.04], [1.44,2.49,0.07], "#091723"),
    box("panel_left", "Copper left edge", [x-0.71,y,z+0.005], [0.035,2.51,0.10], "#bf8a56"),
    box("panel_right", "Copper right edge", [x+0.71,y,z+0.005], [0.035,2.51,0.10], "#bf8a56"),
    box("panel_top", "Copper top edge", [x,y+1.25,z+0.005], [1.455,0.035,0.10], "#ddba7c"),
    box("panel_bottom", "Copper bottom edge", [x,y-1.25,z+0.005], [1.455,0.035,0.10], "#9b683f"),
    { ...common, entityId: "entity_panel_media", kind: panel.kind, name: "Retained explanation in world space", assetId: value.panel.asset.assetId,
      width: 1.26, height: 0.70875, fit: "contain", opacity: 1, transform: transform([x,y+0.02,z+0.013]),
      ...(panel.kind === "video" ? { sourceOffsetUs: 0, playback: "once" } : {}) },
    label("eyebrow", "DESIGN FOR SHADE", y+0.98, 0.063, "#80c6c3"),
    label("title", "FOLLOW THE LIGHT", y+0.76, 0.095, "#f2eee3"),
    label("caption", "Shade intercepts sunlight.", y-0.64, 0.058, "#d5e5de"),
    label("note", "An illustrative energy split", y-0.80, 0.046, "#83a4ad"),
    label("footer", "SUNLIGHT  /  SHADE  /  COMFORT", y-1.08, 0.034, "#809399"),
    box("depth_post", "Foreground copper depth cue", [x+0.70,y-0.21,z+0.50], [0.048,2.32,0.065], "#7f573a"),
    { ...common, entityId: "entity_ambient", kind: "light", name: "Soft sky", light: "ambient", color: "#d5e6ef", intensity: 1.3, transform: transform([0,0,0]) },
    { ...common, entityId: "entity_sun", kind: "light", name: "Warm afternoon", light: "directional", color: "#ffe0b0", intensity: 2.4,
      transform: { ...transform([5,8,5]), ...lookAt([5,8,5],[0,0,0]) } },
    box("sky", "Warm blue horizon", [0,10,-50], [150,100,0.10], "#acbec0"),
  ];
  if (value.city) entities.push({ ...common, entityId: "entity_shared_city", kind: "mesh", name: "Retained native city preview LOD",
    geometry: { kind: "asset", assetId: value.city.asset.assetId, materialMode: "source" }, material: unlit("#ffffff"), transform: transform([0,0,0]) });
  else entities.push(box("ground", "Qualification ground", [0,-0.04,0], [80,0.08,80], "#d0cabd"));
  const assets = [value.panel,value.font,...(value.city ? [value.city] : [])];
  // A portal loop returns to the exact authored pose for a match cut into a
  // native shot; its final five percent is a held camera, never extrapolation.
  // Dense bounded keys preserve the eased turn instead of reversing velocity
  // abruptly at a sparse peak. They still evaluate solely from absolute time.
  const fractions = Array.from({ length: 41 }, (_, index) => index/40);
  const times = [...new Set(fractions.map(t => Math.round(t*value.durationUs)))];
  const poses = times.map(timeUs => {
    const t = timeUs/value.durationUs;
    const progress = value.motion === "portal-loop" ? t <= 0.55 ? (t-0.25)/0.30 : (0.95-t)/0.40 : (t-0.25)/0.75;
    const u = Math.max(0,Math.min(1,progress));
    const ease = u*u*(3-2*u);
    const start = camera.pose.position, end = [4.5,2.7,4.4];
    return ease === 0 ? camera.pose : lookAt(start.map((n,i) => n+(end[i]!-n)*ease), [x-0.35*ease,y+0.1*ease,z]);
  });
  const animations = value.motion === "locked" ? [] : [
    { channelId: "channel_reveal_position", targetId: camera.cameraId, property: "position", interpolation: "linear", keys: times.map((timeUs,i) => ({ timeUs,value: poses[i]!.position })) },
    { channelId: "channel_reveal_rotation", targetId: camera.cameraId, property: "rotation", interpolation: "slerp", keys: times.map((timeUs,i) => ({ timeUs,value: poses[i]!.rotation })) },
  ];
  const scene = parseSpatialScene({ kind: "slopcamera.spatial-scene", schemaVersion: 1, sceneId: "scene_hybrid_world_explainer", coordinates: "right-handed-y-up-meters",
    durationUs: value.durationUs, cameras: [camera], assets: assets.map(item => item.asset), entities, animations, generators: [], overrides: [] });
  return { scene, bindings: assets.map(item => item.binding) };
}
