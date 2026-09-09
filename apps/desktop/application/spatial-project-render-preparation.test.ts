import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, test } from "bun:test";
import sharp from "sharp";

import { SpatialShotV1Schema } from "../../../src/spatial-scene/contracts";
import { spatialSceneSha256 } from "../../../src/spatial-scene/identity";
import { fixtureCamera, fixtureScene } from "../../../src/spatial-scene/test-fixture";
import { ProjectEditPlanV1Schema, VideoProjectV1Schema } from "../contracts/project";
import { SpatialProjectHeadV2Schema, SpatialProjectRevisionV2Schema } from "../contracts/spatial-project";
import { canonicalJson, canonicalJsonSha256, sha256Hex } from "../core/canonical-json";
import { compileProjectRenderPlan } from "../core/project-render-plan";
import { createNodeSpatialDurability } from "../core/spatial-durability";
import { spatialProjectArtifact, spatialProjectDocumentText, spatialProjectRevisionSha256 } from "../core/spatial-project";
import { createNodeBundleFileSystem } from "../core/storage";
import type { ApplicationContext } from "./context";
import { ApplicationError } from "./errors";
import { bindHtmlOverlayBrowserRuntime } from "./html-overlay-browser-runtime";
import { createHtmlOverlayExecutionBundle } from "./html-overlay-integrity";
import type { OperationExecutionContext } from "./operation";
import { bindProjectRenderInputV4 } from "./operations/render/project";
import { hashProjectGeneration } from "./project-store";
import { ProjectEditRevisionDocumentSchema, ProjectRenderPlanDocumentSchema } from "./receipts";
import { createSpatialCompositorCadence } from "./spatial-compositor-cadence";
import { editedPlan, syncedProject } from "./spatial-project-fixture.testing";
import { prepareSpatialProjectRender, SpatialProjectRenderPreparationInputSchema, SpatialProjectRenderPreparationOutputSchema, type SpatialProjectRenderPreparationOutput } from "./spatial-project-render-preparation";
import { planSpatialRender, SpatialRenderReceiptSchema, spatialShotRenderRequest } from "./spatial-render";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const profile = { pixelWidth: 8, pixelHeight: 4, frameRate: { numerator: 30_000, denominator: 1_001 }, background: "#000000ff", colorSpace: "srgb" } as const;
const policy = { kind: "full-frame-above-legacy-video-below-overlays", alpha: "straight" } as const;
const renderDependencies = { bindBrowserRuntime: async (...args: Parameters<typeof bindHtmlOverlayBrowserRuntime>) => await bindHtmlOverlayBrowserRuntime(args[0], args[1], { allowUnverifiedRuntimeForTesting: true }) };
async function put(root: string, path: string, contents: string | Uint8Array) {
  const destination = join(root, path); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, contents); return destination;
}
async function fixture(options: { shotCount?: number; durationUs?: number; width?: number; secondWidth?: number; overlap?: boolean; baseSpeed?: number; legacyLayoutWidth?: number; effect?: "clicks" | "cursor" | "keystrokes" | "typedText"; onRender?: () => Promise<void> } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atet-spatial-project-preparation-"))); directories.push(root);
  const legacy = syncedProject(), media = "synthetic legacy media fixture", mediaSha = sha256Hex(media);
  const project = VideoProjectV1Schema.parse({ ...legacy,
    placements: options.legacyLayoutWidth === undefined ? legacy.placements : legacy.placements.map(placement => ({ ...placement,
      video: placement.video.map(video => ({ ...video, presentation: { ...video.presentation,
        layout: { kind: "output-pixels", x: 0, y: 0, width: options.legacyLayoutWidth, height: 4 } } })) })),
    assets: legacy.assets.map(asset => ({ ...asset, streams: asset.streams.map(stream => ({ ...stream,
    segments: stream.segments.map(segment => ({ ...segment, sha256: mediaSha, bytes: Buffer.byteLength(media) })) })) })) });
  const originalPlan = editedPlan(project);
  const effects = {
    clicks: { enabled: true, color: "#ff0000", durationUs: 100_000, radiusPx: 10, style: "ring" },
    cursor: { enabled: true, scale: 1, smoothing: { algorithm: "none", strength: 0 }, style: "dot" },
    keystrokes: { enabled: true, holdUs: 100_000, maxKeys: 4, position: "bottom-left", secureText: "hide" },
    typedText: { enabled: true, idleTimeoutUs: 100_000, maxCharacters: 100, placement: "caption", secureText: "hide" },
  };
  const projectEditPlan = ProjectEditPlanV1Schema.parse({ ...originalPlan, baseSpeed: options.baseSpeed ?? originalPlan.baseSpeed,
    effects: options.effect === undefined ? originalPlan.effects : { ...originalPlan.effects, [options.effect]: effects[options.effect] } });
  const projectRoot = join(root, "artifacts", "atet", "projects"), projectDirectory = join(projectRoot, project.projectId);
  const camera = fixtureCamera();
  const scene = { ...fixtureScene(), durationUs: 10_000_000, cameras: [{ ...camera, projection: { ...camera.projection, width: options.width ?? 8, height: 4 } },
    ...(options.secondWidth === undefined ? [] : [{ ...camera, cameraId: "camera_second", projection: { ...camera.projection, width: options.secondWidth, height: 4 } }])] };
  const sceneSha256 = spatialSceneSha256(scene), sceneArtifact = spatialProjectArtifact("scenes", spatialProjectDocumentText(scene));
  const durationUs = options.durationUs ?? 100_000;
  const shots = Array.from({ length: options.shotCount ?? 1 }, (_, index) => SpatialShotV1Schema.parse({ shotId: `shot_${index}`, sceneSha256, cameraId: index > 0 && options.secondWidth !== undefined ? "camera_second" : "camera_main",
    range: { startUs: options.overlap === true ? 0 : index * durationUs, endUs: options.overlap === true ? durationUs : (index + 1) * durationUs }, sceneStartUs: 0, playback: "loop", overrides: [] }));
  const revision = SpatialProjectRevisionV2Schema.parse({ kind: "atet.spatial-project-revision", schemaVersion: 2, projectId: project.projectId,
    parent: { version: 1, sha256: "a".repeat(64) }, transactionId: `transaction_${"0".repeat(32)}`, legacy: { project, projectEditPlan },
    scenes: [{ sceneSha256, artifact: sceneArtifact }], shots, candidates: [], selections: [] });
  const head = SpatialProjectHeadV2Schema.parse({ kind: "atet.spatial-project-head", schemaVersion: 2, projectId: project.projectId, projectRevisionSha256: spatialProjectRevisionSha256(revision),
    revision: spatialProjectArtifact("revisions", spatialProjectDocumentText(revision)), transactionId: revision.transactionId });
  await put(projectDirectory, head.revision.path, spatialProjectDocumentText(revision));
  await put(projectDirectory, sceneArtifact.path, spatialProjectDocumentText(scene));
  const headText = spatialProjectDocumentText(head); await put(projectDirectory, "project.json", headText);
  for (const path of ["fixtures/reference.mov", "fixtures/camera.mov"]) await put(root, path, media);
  const privateRoot = join(root, "artifacts", "atet", "private"); await mkdir(privateRoot, { recursive: true });
  for (const name of ["ffmpeg", "ffprobe", "html-browser"]) { const path = await put(root, `bin/${name}`, "test capability"); await chmod(path, 0o700); }
  let held = true, renderCalls = 0, capabilityCalls = 0;
  const application: ApplicationContext = {
    paths: { repositoryRoot: root, projectRoot, privateRoot, desktopRoot: root, artifactRoot: join(root, "artifacts", "atet", "recordings") },
    spatialProjectCustody: { projectDirectory, projectId: project.projectId, async assertHeld() { if (!held) throw new Error("revoked project custody"); }, async assertLegacyTransactionSettled() {} },
    clock: { now: () => new Date("2026-09-08T00:00:00Z"), timestampMilliseconds: () => 0 }, capabilities: () => Promise.resolve([]),
    capability: async name => { capabilityCalls++; return name === "rsvg-convert" ? { name, available: false } : { name, available: true, command: join(root, "bin", name), version: "test fixture1" }; },
    htmlOverlayRenderer: { async renderFrames(request) {
      renderCalls++; await options.onRender?.();
      const directory = join(request.outputDirectory, "frames"); await mkdir(directory);
      const count = request.authoring.timing.durationUs / 1_000_000;
      const png = await sharp({ create: { width: request.authoring.canvas.width, height: request.authoring.canvas.height, channels: 4, background: { r: 255, g: 10, b: 50, alpha: 0.5 } } }).png().toBuffer();
      for (let index = 0; index < count; index++) await writeFile(join(directory, `frame-${String(index).padStart(8, "0")}.png`), png);
      const bundle = createHtmlOverlayExecutionBundle(request.authoring, request.browserRuntime);
      return { executionIntegrity: bundle.integrity, libraryLocks: bundle.libraryLocks, frameCount: count, framePattern: join(directory, "frame-%08d.png") };
    } },
    runner: { async run(argv) {
      if (argv.includes("-show_frames")) {
        const plan = planSpatialRender(scene, spatialShotRenderRequest(shots[0]!, profile.frameRate)), rate = profile.frameRate;
        return { exitCode: 0, stderr: "", stdout: JSON.stringify({ streams: [{ index: 0, codec_type: "video", codec_name: "qtrle", width: 8, height: 4, pix_fmt: "argb",
          r_frame_rate: "30000/1001", avg_frame_rate: "30000/1001", time_base: "1/30000", start_pts: 0, duration_ts: plan.samples.length * rate.denominator, nb_frames: String(plan.samples.length) }],
        frames: plan.samples.map((_, index) => ({ stream_index: 0, pts: index * rate.denominator, duration: rate.denominator, best_effort_timestamp: index * rate.denominator })) }) };
      }
      await writeFile(argv.at(-1)!, "injected qtrle bytes; native timing verified separately"); return { exitCode: 0, stdout: "", stderr: "" };
    } },
  };
  const controller = new AbortController(), context: OperationExecutionContext = { application, abortSignal: controller.signal };
  const input = { project: project.projectId, expected: { version: 2, sha256: head.projectRevisionSha256 }, profile, policy };
  return { root, projectDirectory, context, input, headText, project, projectEditPlan, controller, revoke: () => { held = false; }, counts: () => ({ renderCalls, capabilityCalls }) };
}
function requested(prepared: SpatialProjectRenderPreparationOutput) {
  return { plan: prepared.plan, spatial: prepared.spatial, output: { path: "renders/prepared.mp4", maximumBytes: 1024 * 1024 }, syncPolicy: "allow-unverified",
    target: { canvas: { kind: "custom", frameRate: profile.frameRate.numerator / profile.frameRate.denominator, pixelWidth: profile.pixelWidth, pixelHeight: profile.pixelHeight }, tier: "final" } };
}

test("prepares a real materialized shot through V4 binding while preserving the true legacy revision and mixed audio", async () => {
  const value = await fixture();
  const result = await prepareSpatialProjectRender(value.context, value.input, { renderDependencies });
  expect(SpatialProjectRenderPreparationOutputSchema.parse(result)).toEqual(result);
  expect(result.materializedShots).toHaveLength(1);
  expect(result.materializedShots[0]!.frameCount).toBe(3);
  expect(result.materializedShots[0]!.frameRate).toEqual(profile.frameRate);
  const revision = ProjectEditRevisionDocumentSchema.parse(JSON.parse(await readFile(join(value.projectDirectory, result.revisionReference.artifact.path), "utf8")));
  expect(result.revisionReference.baseGeneration).toEqual(hashProjectGeneration(revision.project, revision.projectEditPlan));
  expect(result.revisionReference.revisionSha256).not.toBe(result.sourceBasis.sha256);
  expect(revision.projectEditPlan.keep).toEqual(value.projectEditPlan.keep);
  expect(revision.projectEditPlan.speed).toEqual(value.projectEditPlan.speed);
  const plan = ProjectRenderPlanDocumentSchema.parse(JSON.parse(await readFile(join(value.projectDirectory, result.plan.artifact.path), "utf8")));
  const baseline = compileProjectRenderPlan(value.project, value.projectEditPlan, { pixelWidth: 8, pixelHeight: 4, frameRate: 30_000 / 1_001, background: profile.background });
  expect(canonicalJson(plan.plan.audioSlices)).toEqual(canonicalJson(baseline.audioSlices));
  expect(plan.plan.output.durationUs).toBe(baseline.output.durationUs);
  expect(await readFile(join(value.projectDirectory, "project.json"), "utf8")).toBe(value.headText);
  const bound = await bindProjectRenderInputV4(value.context.application, requested(result));
  expect(bound.spatial).toEqual(result.spatial);
  const receipt = SpatialRenderReceiptSchema.parse(JSON.parse(await readFile(join(value.projectDirectory, `spatial/receipts/${result.materializedShots[0]!.receiptSha256}.json`), "utf8")));
  expect(receipt.workflow).toBeUndefined();
  expect(receipt.source.originalSceneArtifact?.path).toContain("spatial/scenes/");
  expect(Object.isFrozen(result.spatial.projection.shots)).toBe(true);
});

test("V4 rejects a self-consistent physical receipt and projection whose request no longer matches its source shot", async () => {
  const value = await fixture();
  const result = await prepareSpatialProjectRender(value.context, value.input, { renderDependencies });
  const materialized = result.materializedShots[0]!;
  const receipt = SpatialRenderReceiptSchema.parse(JSON.parse(await readFile(join(value.projectDirectory, `spatial/receipts/${materialized.receiptSha256}.json`), "utf8")));
  const altered = { ...receipt, request: { ...receipt.request, cameraId: "camera_altered" } };
  const text = spatialProjectDocumentText(altered), digest = sha256Hex(text);
  await put(value.projectDirectory, `spatial/receipts/${digest}.json`, text);
  const projection = structuredClone(result.projection); projection.shots[0]!.materialized.receiptSha256 = digest;
  const projectionSha256 = canonicalJsonSha256({ domain: "atet.scene-render-projection/v1", projection });
  const planDocument = ProjectRenderPlanDocumentSchema.parse(JSON.parse(await readFile(join(value.projectDirectory, result.plan.artifact.path), "utf8")));
  const spatial = { projection, projectionSha256, cadence: createSpatialCompositorCadence({ projection, projectionSha256, plan: planDocument.plan }) };
  await expect(bindProjectRenderInputV4(value.context.application, { ...requested(result), spatial })).rejects.toThrow("different camera, overrides or exact source clock");
});

test("all dimensions, basis, overlap and aggregate work are admitted before native capabilities or browser work", async () => {
  for (const parameters of [{ width: 16 }, { shotCount: 2, secondWidth: 16 }, { shotCount: 65 }, { shotCount: 2, overlap: true }]) {
    const value = await fixture(parameters);
    await expect(prepareSpatialProjectRender(value.context, value.input, { renderDependencies })).rejects.toThrow();
    expect(value.counts()).toEqual({ renderCalls: 0, capabilityCalls: 0 });
    expect((await readdir(join(value.projectDirectory, "spatial"))).sort()).toEqual(["revisions", "scenes"]);
  }
  const aggregate = await fixture({ shotCount: 8, durationUs: 1_000_000 });
  await expect(prepareSpatialProjectRender(aggregate.context, { ...aggregate.input, profile: { ...profile, frameRate: { numerator: 240, denominator: 1 } } }, { renderDependencies })).rejects.toThrow("aggregate");
  expect(aggregate.counts()).toEqual({ renderCalls: 0, capabilityCalls: 0 });
  const value = await fixture();
  for (const input of [{ ...value.input, expected: { version: 2, sha256: "f".repeat(64) } }, { ...value.input, policy: { ...policy, alpha: "opaque" } }]) {
    await expect(prepareSpatialProjectRender(value.context, input, { renderDependencies })).rejects.toThrow();
  }
  expect(value.counts()).toEqual({ renderCalls: 0, capabilityCalls: 0 });
});

test("a short shot cannot bypass whole-composition cadence admission or frozen legacy compilation", async () => {
  const slow = await fixture({ baseSpeed: 0.001 });
  const legacy = compileProjectRenderPlan(slow.project, slow.projectEditPlan, { pixelWidth: 8, pixelHeight: 4, frameRate: 240 });
  // Cuts retain six seconds at base speed and two seconds at the explicit 2x rate.
  expect(legacy.output.durationUs).toBe(6_001_000_000);
  await expect(prepareSpatialProjectRender(slow.context, { ...slow.input, profile: { ...profile, frameRate: { numerator: 240, denominator: 1 } } }, { renderDependencies }))
    .rejects.toThrow("Full project output duration exceeds spatial compositor cadence admission");
  const layout = await fixture({ legacyLayoutWidth: 16 });
  await expect(prepareSpatialProjectRender(layout.context, layout.input, { renderDependencies })).rejects.toThrow("exceeds the project render output");
  for (const value of [slow, layout]) {
    expect(value.counts()).toEqual({ renderCalls: 0, capabilityCalls: 0 });
    expect((await readdir(join(value.projectDirectory, "spatial"))).sort()).toEqual(["revisions", "scenes"]);
    expect(await readFile(join(value.projectDirectory, "project.json"), "utf8")).toBe(value.headText);
  }
});

test("descriptor-safe request capture and cancellation preserve the head without starting rendering", async () => {
  let invoked = 0;
  expect(() => SpatialProjectRenderPreparationInputSchema.parse({ get project() { invoked++; return "project_adversary"; } })).toThrow();
  expect(invoked).toBe(0);
  const value = await fixture(); value.controller.abort();
  await expect(prepareSpatialProjectRender(value.context, value.input, { renderDependencies })).rejects.toThrow();
  expect(value.counts().renderCalls).toBe(0);
  expect(await readFile(join(value.projectDirectory, "project.json"), "utf8")).toBe(value.headText);
});

test("recording metadata effects fail explicitly before any browser work", async () => {
  for (const effect of ["clicks", "cursor", "keystrokes", "typedText"] as const) {
    const value = await fixture({ effect });
    await expect(prepareSpatialProjectRender(value.context, value.input, { renderDependencies })).rejects.toThrow("recording metadata required by zooms, clicks, cursor, keystrokes or typedText");
    expect(value.counts()).toEqual({ renderCalls: 0, capabilityCalls: 0 });
  }
});

test("authentic caller workflow identity and publication fence reach the retained shot receipt", async () => {
  const value = await fixture();
  const workspace = join(value.context.application.paths.privateRoot, "preparation-fixture"); await mkdir(workspace, { mode: 0o700 });
  let fences = 0;
  const identity = { nodeKey: "prepare", runId: "run_preparation_fixture", nodePlanSha256: "b".repeat(64) };
  const result = await prepareSpatialProjectRender({ ...value.context, workflow: { ...identity, workspaceDirectory: workspace, async beforePublication() { fences++; } } }, value.input, { renderDependencies });
  const receipt = SpatialRenderReceiptSchema.parse(JSON.parse(await readFile(join(value.projectDirectory, `spatial/receipts/${result.materializedShots[0]!.receiptSha256}.json`), "utf8")));
  expect(receipt.workflow).toEqual(identity);
  expect(fences).toBeGreaterThan(4);
  expect(await readdir(workspace)).toEqual([]);
});

test("post-link copy uncertainty retains the exact destination and complete source evidence", async () => {
  const value = await fixture(), fs = createNodeBundleFileSystem(value.root);
  const result = await prepareSpatialProjectRender(value.context, value.input, { renderDependencies, repositoryFileSystem: { ...fs,
    async copyFileNoReplace(source, destination, expected) { await fs.copyFileNoReplace!(source, destination, expected); throw new Error("injected after exact copy link"); },
  } }).catch(error => error as unknown);
  expect(result).toBeInstanceOf(ApplicationError);
  const details = (result as ApplicationError).details as { spatialProjectRenderPreparation: { published: { path: string }[]; uncertainPublication: { path: string; sha256: string; bytes: number } } };
  const evidence = details.spatialProjectRenderPreparation;
  expect(evidence.published.some(item => item.path.includes("receipts"))).toBe(true);
  expect(evidence.uncertainPublication.path).toContain("spatial/outputs/");
  await createNodeSpatialDurability(value.root).syncExactFile(evidence.uncertainPublication.path, evidence.uncertainPublication);
  expect(await readFile(join(value.projectDirectory, "project.json"), "utf8")).toBe(value.headText);
});

test("existing exact immutable winners still require explicit durability and later custody revocation blocks completion", async () => {
  const value = await fixture(); let fileSyncs = 0;
  const durability = createNodeSpatialDurability(value.root);
  const dependencies = { renderDependencies, durability: { async syncExactFile(path: string, expected: { bytes: number; sha256: string }) { fileSyncs++; await durability.syncExactFile(path, expected); } } };
  const first = await prepareSpatialProjectRender(value.context, value.input, dependencies);
  expect(fileSyncs).toBe(4);
  await prepareSpatialProjectRender(value.context, value.input, dependencies);
  expect(fileSyncs).toBe(8);
  const revoked = await fixture({ onRender: async () => { revoked.revoke(); } });
  await expect(prepareSpatialProjectRender(revoked.context, revoked.input, { renderDependencies })).rejects.toThrow("revoked");
  expect(await readFile(join(revoked.projectDirectory, "project.json"), "utf8")).toBe(revoked.headText);
  expect(canonicalJson(first.sourceBasis)).toBe(canonicalJson(value.input.expected));
});

test("revocation inside final immutable copy and document guards prevents destination publication", async () => {
  for (const boundary of ["copy", "plan"] as const) {
    const value = await fixture(), fs = createNodeBundleFileSystem(value.root);
    const repositoryFileSystem = { ...fs,
      async copyFileNoReplace(source: string, destination: string, expected: { bytes: number; sha256: string }, guard?: () => Promise<void>) {
        return await fs.copyFileNoReplace!(source, destination, expected, async () => { if (boundary === "copy") value.revoke(); await guard?.(); });
      },
      async writeTextNoReplace(path: string, text: string, guard?: () => Promise<void>) {
        return await fs.writeTextNoReplace!(path, text, async () => { if (boundary === "plan" && path.includes("renders/plans/")) value.revoke(); await guard?.(); });
      },
    };
    await expect(prepareSpatialProjectRender(value.context, value.input, { renderDependencies, repositoryFileSystem })).rejects.toThrow("revoked");
    const destination = join(value.projectDirectory, boundary === "copy" ? "spatial/outputs" : "renders/plans");
    expect((await readdir(destination).catch(() => [] as string[])).filter(path => !path.startsWith("."))).toEqual([]);
    expect(await readFile(join(value.projectDirectory, "project.json"), "utf8")).toBe(value.headText);
  }
});

test("durability and cleanup failures retain each cause and the exact potentially installed artifact", async () => {
  const value = await fixture();
  const result = await prepareSpatialProjectRender(value.context, value.input, { renderDependencies,
    durability: { async syncExactFile() { throw new AggregateError([new Error("injected file sync failure"), new Error("injected descriptor close failure")], "injected durability failure"); } },
  }).catch(error => error as unknown);
  expect(result).toBeInstanceOf(ApplicationError);
  const failure = result as ApplicationError;
  expect(failure.cause).toBeInstanceOf(AggregateError);
  const evidence = (failure.details as { spatialProjectRenderPreparation: { errors: string[]; uncertainPublication: { path: string; bytes: number; sha256: string } } }).spatialProjectRenderPreparation;
  expect(evidence.errors).toEqual(["injected durability failure", "injected file sync failure", "injected descriptor close failure"]);
  await createNodeSpatialDurability(value.root).syncExactFile(evidence.uncertainPublication.path, evidence.uncertainPublication);
});
