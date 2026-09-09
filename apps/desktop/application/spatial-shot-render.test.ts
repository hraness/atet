import { expect, test } from "bun:test";
import { fixtureCamera, fixtureScene } from "../../../src/spatial-scene/test-fixture";
import { spatialSceneSha256 } from "../../../src/spatial-scene/identity";
import { planSpatialRender, spatialShotRenderRequest } from "./spatial-render";

const scene = { ...fixtureScene(), durationUs: 1_000_000, cameras: [{ ...fixtureCamera(), projection: { ...fixtureCamera().projection, width: 8, height: 4 } }] };
const shot = { shotId: "shot_clock", sceneSha256: spatialSceneSha256(scene), cameraId: "camera_main", overrides: [], sceneStartUs: 125000,
  range: { startUs: 4000000, endUs: 7000000 }, playback: "loop" };
test("explicit GPU profile changes request identity while preserving exact shot and sample clocks", () => {
  const legacyRequest = spatialShotRenderRequest(shot, { numerator: 30_000, denominator: 1_001 });
  expect(Object.hasOwn(legacyRequest, "executionProfile")).toBe(false);
  const hardwareRequest = spatialShotRenderRequest(shot, { numerator: 30_000, denominator: 1_001 }, "three-webgl2-hardware-v1");
  expect(hardwareRequest).toEqual({ ...legacyRequest, executionProfile: "three-webgl2-hardware-v1" });
  const legacy = planSpatialRender(scene, legacyRequest), hardware = planSpatialRender(scene, hardwareRequest);
  expect(hardware.sceneSha256).toBe(legacy.sceneSha256);
  expect(hardware.requestSha256).not.toBe(legacy.requestSha256);
  expect(hardware.samples).toEqual(legacy.samples);
});
test("canonical shot requests bind explicit clocks, source offset, camera pose and overrides", () => {
  const pose: { position: [number, number, number]; rotation: [number, number, number, number] } = { position: [1, 2, 3], rotation: [0, 0, 0, 1] };
  const request = spatialShotRenderRequest({ ...shot, cameraPoseOverride: pose }, { numerator: 60000, denominator: 2002 });
  expect(request.selection).toEqual({ kind: "video", range: { startUs: 0, endUs: 3000000 }, frameRate: { numerator: 30000, denominator: 1001 }, clock: { kind: "shot", sceneStartUs: 125000, playback: "loop" } });
  expect(request.cameraPoseOverride).toEqual(pose);
  expect(request.overrides).toEqual([]);
  expect(Object.isFrozen(request.selection)).toBe(true);
  expect(request.mode).toEqual({ kind: "beauty" });
});
test("loop/freeze shot samples preserve output count while using mapped scene clocks", () => {
  const loop = planSpatialRender(scene, spatialShotRenderRequest(shot, { numerator: 2, denominator: 1 }));
  expect(loop.samples.map(sample => sample.timeUs)).toEqual([125000, 625000, 125000, 625000, 125000, 625000]);
  expect(loop.outputDurationUs).toEqual({ numerator: "3000000", denominator: "1" });
  const freeze = planSpatialRender(scene, spatialShotRenderRequest({ ...shot, playback: "freeze" }, { numerator: 2, denominator: 1 }));
  expect(freeze.samples.map(sample => sample.timeUs)).toEqual([125000, 625000, 1000000, 1000000, 1000000, 1000000]);
  expect(freeze.samples[2]!.exactTimeUs).toEqual({ numerator: "1000000", denominator: "1" });
  expect(freeze.samples.length).toBe(loop.samples.length);
});
test("once shot validates full authored extent and relative zero before sampling", () => {
  expect(() => planSpatialRender(scene, spatialShotRenderRequest({ ...shot, playback: "once" }, { numerator: 1, denominator: 1 }))).toThrow("Once shot duration");
  const request = spatialShotRenderRequest({ ...shot, playback: "once", range: { startUs: 1000000, endUs: 1875000 } }, { numerator: 3, denominator: 1 });
  const plan = planSpatialRender(scene, request);
  expect(plan.samples[1]).toEqual({ index: 1, timeUs: 458333, exactTimeUs: { numerator: "1375000", denominator: "3" } });
  expect(() => planSpatialRender(scene, { ...request, selection: { ...request.selection, range: { startUs: 1, endUs: 500000 } } })).toThrow("relative time zero");
});
test("loop wrap retains a sub-microsecond remainder instead of using rounded author time", () => {
  const source = { ...scene, durationUs: 333333 };
  const request = spatialShotRenderRequest({ ...shot, sceneSha256: spatialSceneSha256(source), sceneStartUs: 0, range: { startUs: 0, endUs: 1000000 } }, { numerator: 3, denominator: 1 });
  const plan = planSpatialRender(source, request);
  expect(plan.samples).toEqual([
    { index: 0, timeUs: 0, exactTimeUs: { numerator: "0", denominator: "1" } },
    { index: 1, timeUs: 0, exactTimeUs: { numerator: "1", denominator: "3" } },
    { index: 2, timeUs: 1, exactTimeUs: { numerator: "2", denominator: "3" } },
  ]);
});
