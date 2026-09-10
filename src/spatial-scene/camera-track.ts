import { z } from "zod"
import { deepFreezeJson } from "../code/json-snapshot.js"
import { SpatialCameraIdSchema, SpatialCameraSchema, SpatialDigestSchema, SpatialFrameRateSchema, SpatialTimeUsSchema } from "./contracts.js"
import { evaluateSpatialScene } from "./evaluate.js"
import { parseSpatialScene, parseSpatialValue, SpatialSceneError, spatialValueSha256 } from "./identity.js"
import { reduceSpatialFrameRate, spatialFrameSample } from "./time.js"

/** Export in bounded shot-sized chunks; source, sampling and projection stay explicit. */
export const SPATIAL_CAMERA_TRACK_MAX_FRAMES = 2_048
const clockSchema = z.strictObject({
  startUs: SpatialTimeUsSchema,
  frameRate: SpatialFrameRateSchema,
  frameCount: z.number().int().min(1).max(SPATIAL_CAMERA_TRACK_MAX_FRAMES),
})
const rationalSchema = z.strictObject({
  numerator: z.string().regex(/^(0|[1-9][0-9]{0,19})$/u),
  denominator: z.string().regex(/^[1-9][0-9]{0,6}$/u),
})
export const SpatialCameraTrackSchema = z.strictObject({
  kind: z.literal("slopcamera.spatial-camera-track"), schemaVersion: z.literal(1),
  sceneSha256: SpatialDigestSchema, cameraId: SpatialCameraIdSchema, clock: clockSchema,
  samples: z.array(z.strictObject({
    frameIndex: z.number().int().min(0).max(SPATIAL_CAMERA_TRACK_MAX_FRAMES - 1),
    timeUs: SpatialTimeUsSchema, exactTimeUs: rationalSchema, camera: SpatialCameraSchema,
  })).min(1).max(SPATIAL_CAMERA_TRACK_MAX_FRAMES),
})
type DeepReadonly<T> = T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> } : T
export type SpatialCameraTrack = DeepReadonly<z.infer<typeof SpatialCameraTrackSchema>>
const optionsSchema = clockSchema.extend({ cameraId: SpatialCameraIdSchema })
export type SampleSpatialCameraTrackOptions = z.infer<typeof optionsSchema>

function absoluteSample(frameIndex: number, clock: z.infer<typeof clockSchema>) {
  const sample = spatialFrameSample(frameIndex, 3_600_000_000, clock.frameRate)
  const denominator = BigInt(sample.exactTimeUs.denominator)
  return { frameIndex, timeUs: clock.startUs + sample.timeUs, exactTimeUs: {
    numerator: String(BigInt(clock.startUs) * denominator + BigInt(sample.exactTimeUs.numerator)),
    denominator: String(denominator),
  } }
}

/** Inert admission also rejects reordered frames, clock drift and mixed cameras. */
export function parseSpatialCameraTrack(input: unknown): SpatialCameraTrack {
  const track = parseSpatialValue(SpatialCameraTrackSchema, input, "camera track")
  const rate = reduceSpatialFrameRate(track.clock.frameRate)
  if (rate.numerator !== track.clock.frameRate.numerator || rate.denominator !== track.clock.frameRate.denominator
      || track.samples.length !== track.clock.frameCount) throw new SpatialSceneError("invalid-data", "Camera track clock or coverage is not canonical.")
  const first = track.samples[0]!.camera.projection
  for (const [index, sample] of track.samples.entries()) {
    const expected = absoluteSample(index, track.clock)
    if (sample.frameIndex !== index || sample.timeUs !== expected.timeUs
      || sample.exactTimeUs.numerator !== expected.exactTimeUs.numerator
      || sample.exactTimeUs.denominator !== expected.exactTimeUs.denominator
      || sample.camera.cameraId !== track.cameraId
      || sample.camera.projection.width !== first.width || sample.camera.projection.height !== first.height) {
      throw new SpatialSceneError("invalid-data", "Camera track must preserve exact clock, camera identity, order and image dimensions.")
    }
  }
  return deepFreezeJson(track)
}

/** Pure camera exchange. No assets are decoded and no native source is executed. */
export function sampleSpatialCameraTrack(sceneInput: unknown, optionsInput: unknown): SpatialCameraTrack {
  const scene = parseSpatialScene(sceneInput)
  const { cameraId, ...inputClock } = parseSpatialValue(optionsSchema, optionsInput, "camera track options")
  const clock = { ...inputClock, frameRate: reduceSpatialFrameRate(inputClock.frameRate) }
  const last = absoluteSample(clock.frameCount - 1, clock)
  if (BigInt(last.exactTimeUs.numerator) >= BigInt(scene.durationUs) * BigInt(last.exactTimeUs.denominator)) {
    throw new SpatialSceneError("invalid-data", "Camera samples exceed the half-open scene duration.")
  }
  const camera = scene.cameras.find(item => item.cameraId === cameraId)
  if (!camera) throw new SpatialSceneError("not-found", `Unknown camera ${cameraId}.`)
  // Camera channels have no entity/asset dependencies. Validate the original
  // scene once, then evaluate only this closed subset at each absolute time.
  const cameraScene = { ...scene, cameras: [camera], entities: [], assets: [], generators: [], overrides: [],
    animations: scene.animations.filter(channel => channel.targetId === cameraId) }
  return parseSpatialCameraTrack({ kind: "slopcamera.spatial-camera-track", schemaVersion: 1,
    sceneSha256: spatialValueSha256(scene), cameraId, clock,
    samples: Array.from({ length: clock.frameCount }, (_, frameIndex) => {
      const sample = absoluteSample(frameIndex, clock)
      return { ...sample, camera: evaluateSpatialScene(cameraScene, { cameraId, timeUs: sample.timeUs }).camera }
    }),
  })
}
