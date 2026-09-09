import { expect, test } from "bun:test"
import fc from "fast-check"
import { z } from "zod"
import { parseSpatialCameraTrack, sampleSpatialCameraTrack, SpatialCameraTrackSchema } from "./camera-track.js"
import { evaluateSpatialScene } from "./evaluate.js"
import { fixtureScene } from "./test-fixture.js"
import { spatialSceneSha256 } from "./identity.js"

const options = { cameraId: "camera_main", startUs: 17, frameRate: { numerator: 30000, denominator: 1001 }, frameCount: 20 }
test("camera exchange agrees with complete scene evaluation at independently sampled NTSC times", () => {
  const scene = { ...fixtureScene(), animations: [{ channelId: "channel_camera", targetId: "camera_main", property: "position", interpolation: "linear",
    keys: [{ timeUs: 0, value: [0, 0, 10] }, { timeUs: 1_000_000, value: [2, 1, 8] }] }] }
  const track = sampleSpatialCameraTrack(scene, options)
  expect(track.sceneSha256).toBe(spatialSceneSha256(scene))
  expect(track.samples[1]!.exactTimeUs).toEqual({ numerator: "100151", denominator: "3" })
  for (const sample of [...track.samples].reverse()) {
    expect(sample.camera).toEqual(evaluateSpatialScene(scene, { cameraId: options.cameraId, timeUs: sample.timeUs }).camera)
  }
  expect(Object.isFrozen(track.samples[0]!.camera.pose.position)).toBe(true)
  expect(parseSpatialCameraTrack(JSON.parse(JSON.stringify(track)))).toEqual(track)
})

test("camera track rejects clock drift, reordered frames, camera mixing and out-of-range sampling", () => {
  const track = sampleSpatialCameraTrack(fixtureScene(), options)
  const modified = JSON.parse(JSON.stringify(track)) as z.infer<typeof SpatialCameraTrackSchema>
  modified.samples[1]!.timeUs++
  expect(() => parseSpatialCameraTrack(modified)).toThrow(/clock/)
  expect(() => parseSpatialCameraTrack({ ...track, samples: [...track.samples].reverse() })).toThrow(/order/)
  expect(() => parseSpatialCameraTrack({ ...track, cameraId: "camera_other" })).toThrow(/identity/)
  expect(() => sampleSpatialCameraTrack(fixtureScene(), { ...options, frameCount: 2049 })).toThrow()
  expect(() => sampleSpatialCameraTrack(fixtureScene(), { ...options, startUs: 999999, frameCount: 2 })).toThrow(/half-open/)
  expect(() => sampleSpatialCameraTrack(fixtureScene(), { ...options, cameraId: "camera_absent" })).toThrow(/Unknown/)
  expect(() => sampleSpatialCameraTrack(fixtureScene(), { ...options, extra: true })).toThrow()
})

test("half-open sampling accepts quantization onto the endpoint, and rejects an exact endpoint", () => {
  const scene = { ...fixtureScene(), durationUs: 33367 }
  expect(sampleSpatialCameraTrack(scene, { ...options, startUs: 0, frameCount: 2 }).samples[1]!.timeUs).toBe(33367)
  expect(() => sampleSpatialCameraTrack(scene, { ...options, startUs: 33367, frameCount: 1 })).toThrow(/half-open/)
})

test("equivalent clocks produce identical tracks, preserve calibration and do not mutate source", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 120 }), fc.integer({ min: 0, max: 1000 }), (fps, startUs) => {
    const scene = fixtureScene(), before = JSON.stringify(scene)
    const clock = { ...options, startUs, frameCount: 1, frameRate: { numerator: fps, denominator: 1 } }
    const track = sampleSpatialCameraTrack(scene, clock)
    expect(sampleSpatialCameraTrack(scene, { ...clock, frameRate: { numerator: fps * 2, denominator: 2 } })).toEqual(track)
    expect(track.samples[0]!.camera.projection).toEqual(scene.cameras[0]!.projection)
    expect(JSON.stringify(scene)).toBe(before)
  }), { numRuns: 50 })
})
