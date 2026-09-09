import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpatialSceneStarter, parseSpatialCameraTrack, sampleSpatialCameraTrack } from "../../../src/spatial-scene";
import type { ApplicationContext } from "../application/context";
import { operationApplicationContext } from "../application/operations/test-support";
import { executeSpatialSceneCommand } from "./spatial-scene-service";

const command = { kind: "spatial-scene", action: "camera-track", path: "scene.json", request: "sampling.json", output: "track.json", json: true } as const;
const sampling = { cameraId: "camera_hero", startUs: 17, frameRate: { numerator: 24000, denominator: 1001 }, frameCount: 3 };

async function fixture(run: (application: ApplicationContext, root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atet-camera-track-")));
  try {
    await writeFile(join(root, command.path), JSON.stringify(createSpatialSceneStarter()));
    await writeFile(join(root, command.request), JSON.stringify(sampling));
    await run(operationApplicationContext(root), root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

function lease(assertOwned: () => Promise<void>): NonNullable<ApplicationContext["hostResourceLease"]> {
  return { assertOwned, claims: [], inheritedFileDescriptor: 0, inheritedFileDescriptors: [],
    profile: { id: "atet-camera-track-test", capacities: [] }, ticket: "camera-track-test" };
}

test("camera-track cancellation is checked before reading any source", async () => await fixture(async (application, root) => {
  await expect(executeSpatialSceneCommand(application, { ...command, path: "missing.json" }, AbortSignal.abort()))
    .rejects.toMatchObject({ code: "cancelled" });
  expect((await readdir(root)).sort()).toEqual(["sampling.json", "scene.json"]);
}));

test("camera-track cancellation during its publication lease check leaves no output or staging file", async () => await fixture(async (application, root) => {
  const controller = new AbortController();
  let checks = 0;
  const guarded = { ...application, hostResourceLease: lease(async () => {
    checks++;
    await Promise.resolve();
    controller.abort();
  }) };
  await expect(executeSpatialSceneCommand(guarded, command, controller.signal)).rejects.toMatchObject({ code: "cancelled" });
  expect(checks).toBe(1);
  expect((await readdir(root)).sort()).toEqual(["sampling.json", "scene.json"]);
}));

test("camera-track lost publication custody leaves no output", async () => await fixture(async (application, root) => {
  const guarded = { ...application, hostResourceLease: lease(async () => { throw new Error("Lease lost"); }) };
  await expect(executeSpatialSceneCommand(guarded, command, new AbortController().signal)).rejects.toThrow("Lease lost");
  expect((await readdir(root)).sort()).toEqual(["sampling.json", "scene.json"]);
}));

test("camera-track cancellation at completion does not report success or delete published evidence", async () => await fixture(async (application, root) => {
  const controller = new AbortController();
  let checks = 0;
  const guarded = { ...application, hostResourceLease: lease(async () => {
    if (++checks === 2) controller.abort();
  }) };
  await expect(executeSpatialSceneCommand(guarded, command, controller.signal)).rejects.toMatchObject({ code: "cancelled" });
  expect(checks).toBe(2);
  expect(parseSpatialCameraTrack(JSON.parse(await readFile(join(root, command.output), "utf8"))).clock).toEqual({
    startUs: sampling.startUs, frameRate: sampling.frameRate, frameCount: sampling.frameCount,
  });
}));

test("camera-track publishes the exact sampled clock and retains an existing result", async () => await fixture(async (application, root) => {
  const original = await readFile(join(root, command.path), "utf8");
  const output = await executeSpatialSceneCommand(application, command, new AbortController().signal);
  const bytes = await readFile(join(root, command.output), "utf8"), track = parseSpatialCameraTrack(JSON.parse(bytes));
  expect(track).toEqual(sampleSpatialCameraTrack(JSON.parse(original), sampling));
  expect(output).toMatchObject({ path: join(root, command.output), sceneSha256: track.sceneSha256, clock: track.clock, executed: false });
  await expect(executeSpatialSceneCommand(application, command)).rejects.toThrow("exists");
  expect(await readFile(join(root, command.output), "utf8")).toBe(bytes);
  expect(await readFile(join(root, command.path), "utf8")).toBe(original);
}));
