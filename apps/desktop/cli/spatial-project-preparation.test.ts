import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import { fixtureScene } from "../../../src/spatial-scene/test-fixture";
import { spatialSceneSha256 } from "../../../src/spatial-scene/identity";
import { SpatialShotV1Schema } from "../../../src/spatial-scene/contracts";
import { editedPlan, syncedProject } from "../application/spatial-project-fixture.testing";
import { SpatialRenderRequestSchema } from "../application/spatial-render";
import { VideoProjectV1Schema } from "../contracts/project";
import { SpatialProjectHeadV2Schema, SpatialProjectRevisionV2Schema } from "../contracts/spatial-project";
import { spatialProjectArtifact, spatialProjectDocumentText, spatialProjectRevisionSha256 } from "../core/spatial-project";
import type { CliIo, ProcessRunner } from "./io";
import type { RepositoryPaths } from "./paths";
import { createCliTestRunner } from "./run-cli-test-helper";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const runCli = createCliTestRunner(import.meta.url);
async function put(root: string, path: string, contents: string) { const destination = join(root, path); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, contents); }
async function fixture(unverified = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "slopcamera-spatial-cli-preparation-"))); directories.push(root);
  const base = syncedProject();
  const project = VideoProjectV1Schema.parse({ ...base, placements: base.placements.map((placement, index) => index !== 1 || !unverified ? placement : {
    ...placement, sync: { ...placement.sync, provenance: { kind: "unverified", reason: "insufficient-evidence" } },
  }) });
  const projectEditPlan = editedPlan(project), scene = fixtureScene(), sceneSha256 = spatialSceneSha256(scene);
  const sceneArtifact = spatialProjectArtifact("scenes", spatialProjectDocumentText(scene));
  const shot = SpatialShotV1Schema.parse({ shotId: "shot_hero", sceneSha256, cameraId: scene.cameras[0]!.cameraId,
    range: { startUs: 0, endUs: 100_000 }, sceneStartUs: 0, playback: "once", overrides: [] });
  const revision = SpatialProjectRevisionV2Schema.parse({ kind: "slopcamera.spatial-project-revision", schemaVersion: 2, projectId: project.projectId,
    parent: { version: 1, sha256: "a".repeat(64) }, transactionId: `transaction_${"0".repeat(32)}`, legacy: { project, projectEditPlan },
    scenes: [{ sceneSha256, artifact: sceneArtifact }], shots: [shot], candidates: [], selections: [] });
  const head = SpatialProjectHeadV2Schema.parse({ kind: "slopcamera.spatial-project-head", schemaVersion: 2, projectId: project.projectId,
    projectRevisionSha256: spatialProjectRevisionSha256(revision), transactionId: revision.transactionId,
    revision: spatialProjectArtifact("revisions", spatialProjectDocumentText(revision)) });
  const paths: RepositoryPaths = { repositoryRoot: root, projectRoot: join(root, "artifacts", "slopcamera", "projects"),
    artifactRoot: join(root, "artifacts", "slopcamera", "recordings"), privateRoot: join(root, "artifacts", "slopcamera", "private"), desktopRoot: root };
  const projectDirectory = join(paths.projectRoot, project.projectId), headText = spatialProjectDocumentText(head);
  await put(projectDirectory, "project.json", headText);
  await put(projectDirectory, head.revision.path, spatialProjectDocumentText(revision));
  await put(projectDirectory, sceneArtifact.path, spatialProjectDocumentText(scene));
  const input = { expected: { version: 2, sha256: head.projectRevisionSha256 }, profile: { pixelWidth: 960, pixelHeight: 540,
    frameRate: { numerator: 30_000, denominator: 1_001 }, background: "#101820ff", colorSpace: "srgb" },
  policy: { kind: "full-frame-above-legacy-video-below-overlays", alpha: "straight" },
  delivery: { output: { path: "renders/directed-scene.mp4", maximumBytes: 268_435_456 }, syncPolicy: "require-verified", tier: "final" } };
  const calls: string[][] = [];
  const runner: ProcessRunner = { async run(argv) { calls.push([...argv]); return { exitCode: 1, stderr: "native work reached before delivery admission", stdout: "" }; } };
  async function execute(request: unknown = input, output = "prepared-render.json") {
    await put(root, "prepare.json", JSON.stringify(request));
    let stdout = "", stderr = "";
    const io: CliIo = { cwd: () => root, env: {}, now: () => new Date("2026-09-08T00:00:00Z"), platform: process.platform,
      stdout: value => { stdout += value; }, stderr: value => { stderr += value; } };
    const code = await runCli(["scene", "project", "prepare-render", project.projectId, "--input", "prepare.json", "--output", output, "--json"],
      { io, paths, runner, stateRoot: join(root, "state") });
    return { code, stdout, stderr };
  }
  return { root, projectDirectory, headText, input, calls, execute };
}

test("documented frame, contact sheet and rational video request shapes parse without hidden defaults", () => {
  const base = { cameraId: "camera_hero", mode: { kind: "beauty" } };
  for (const selection of [
    { kind: "frame", timeUs: 1_000_000 },
    { kind: "contact-sheet", timesUs: [0, 1_000_000, 2_000_000], columns: 3, cellWidth: 320, cellHeight: 180, fit: "contain" },
    { kind: "video", range: { startUs: 0, endUs: 4_000_000 }, frameRate: { numerator: 30_000, denominator: 1_001 } },
  ]) expect(spatialProjectDocumentText(SpatialRenderRequestSchema.parse({ ...base, selection }))).toBe(spatialProjectDocumentText({ ...base, selection }));
});

test("CLI rejects invalid delivery bytes and odd compositor dimensions before touching native capabilities", async () => {
  const value = await fixture();
  for (const request of [
    { ...value.input, delivery: { ...value.input.delivery, output: { ...value.input.delivery.output, maximumBytes: 268_435_457 } } },
    { ...value.input, profile: { ...value.input.profile, pixelWidth: 959 } },
  ]) {
    expect((await value.execute(request)).code).not.toBe(0);
    expect(value.calls).toEqual([]);
  }
  expect(await readFile(join(value.projectDirectory, "project.json"), "utf8")).toBe(value.headText);
});

test("existing prepared JSON rejects before project preparation and preserves the file", async () => {
  const value = await fixture(); await put(value.root, "prepared-render.json", "retained existing prepared request");
  const result = await value.execute();
  expect(result.stderr).toContain("already exists"); expect(result.code).not.toBe(0); expect(value.calls).toEqual([]);
  expect(await readFile(join(value.root, "prepared-render.json"), "utf8")).toBe("retained existing prepared request");
});

test("an occupied final delivery path rejects before expensive scene materialization", async () => {
  const value = await fixture(); await put(value.projectDirectory, value.input.delivery.output.path, "existing final delivery");
  const result = await value.execute();
  expect(result.code).not.toBe(0); expect(result.stderr).toContain("exists"); expect(value.calls).toEqual([]);
  expect(await readFile(join(value.projectDirectory, value.input.delivery.output.path), "utf8")).toBe("existing final delivery");
  expect((await readdir(join(value.projectDirectory, "spatial"))).sort()).toEqual(["revisions", "scenes"]);
});

test("a redirected final delivery ancestor rejects before expensive scene materialization", async () => {
  const value = await fixture(); await mkdir(join(value.root, "elsewhere")); await symlink(join(value.root, "elsewhere"), join(value.projectDirectory, "renders"));
  const result = await value.execute();
  expect(result.code).not.toBe(0); expect(value.calls).toEqual([]); expect(result.stderr).toMatch(/physical|symlink|redirect|unsafe/iu);
  expect(await readdir(join(value.root, "elsewhere"))).toEqual([]);
});

test("prepared output cannot alias the final video through a directory symlink", async () => {
  const value = await fixture(); await mkdir(join(value.projectDirectory, "renders"));
  await symlink(value.projectDirectory, join(value.root, "project-alias"));
  const result = await value.execute(value.input, "project-alias/renders/directed-scene.mp4");
  expect(result.code).not.toBe(0); expect(result.stderr).toMatch(/distinct|same|alias/iu); expect(value.calls).toEqual([]);
  expect(await readdir(join(value.projectDirectory, "renders"))).toEqual([]);
});

test("require-verified rejects known unverified source synchronization before scene materialization", async () => {
  const value = await fixture(true), result = await value.execute();
  expect(result.code).not.toBe(0); expect(result.stderr).toMatch(/unverified|synchronization/iu); expect(value.calls).toEqual([]);
  expect((await readdir(join(value.projectDirectory, "spatial"))).sort()).toEqual(["revisions", "scenes"]);
});
