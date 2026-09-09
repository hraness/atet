import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

import { fixtureCamera, fixtureScene } from "../../../../src/spatial-scene/test-fixture";
import type { ApplicationContext } from "../context";
import { ApplicationError } from "../errors";
import { bindHtmlOverlayBrowserRuntime } from "../html-overlay-browser-runtime";
import { createHtmlOverlayExecutionBundle } from "../html-overlay-integrity";
import type { OperationExecutionContext } from "../operation";
import type { OperationCheckpointExecutionIdentity } from "../operation-completion-checkpoint";
import { renderSpatialScene, SpatialRenderReceiptSchema, SpatialRenderFailure, type SpatialRenderResult } from "../spatial-render";
import { canonicalJson, sha256Hex } from "../../core/canonical-json";
import { bindSpatialRenderInput, executeSpatialRender, recoverSpatialRenderAttempt, recoverSpatialRenderOutput, type SpatialRenderOperationDependencies } from "./spatial-render";
import { publishContentAddressedMedia, type MediaArtifactReference } from "./media/shared";

const request = { cameraId: "camera_main", selection: { kind: "frame", timeUs: 0 }, mode: { kind: "beauty" } } as const;
const identity: OperationCheckpointExecutionIdentity = {
  kind: "scene.render", version: 1, inputSchemaId: "atet.operation.scene.render.input/v1", outputSchemaId: "atet.operation.scene.render.output/v1",
  nodeKey: "render", nodePlanSha256: "a".repeat(64), runId: "run_spatial_operation",
};
const bindRuntime: typeof bindHtmlOverlayBrowserRuntime = async (capability, signal) => await bindHtmlOverlayBrowserRuntime(capability, signal, { allowUnverifiedRuntimeForTesting: true });
const dependencies: SpatialRenderOperationDependencies = { bindBrowserRuntime: bindRuntime,
  render: async (context, input) => await renderSpatialScene(context, input, { bindBrowserRuntime: bindRuntime }) };
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atet-spatial-render-operation-")));
  const privateRoot = join(root, "artifacts", "atet", "private");
  const workspace = join(privateRoot, "node-workspace");
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const binary = join(root, "browser"); await writeFile(binary, "browser-fixture", { mode: 0o700 });
  const camera = fixtureCamera();
  const scene = { ...fixtureScene(), cameras: [{ ...camera, projection: { ...camera.projection, width: 8, height: 4 } }] };
  const sourcePath = join(root, "original.scene.json");
  await writeFile(sourcePath, JSON.stringify(scene, null, 2));
  let renders = 0;
  const capabilityRequests: string[] = [];
  const application: ApplicationContext = {
    paths: { repositoryRoot: root, privateRoot, artifactRoot: join(root, "artifacts", "atet", "recordings"), desktopRoot: root, projectRoot: join(root, "artifacts", "atet", "projects") },
    clock: { now: () => new Date(), timestampMilliseconds: () => Date.now() },
    capability: async name => { capabilityRequests.push(name); return name === "html-browser" ? { name, available: true, command: binary, version: "test" } : { name, available: false }; },
    capabilities: async () => [], runner: { run: async () => { throw new Error("Frame render must not run FFmpeg."); } },
    htmlOverlayRenderer: { renderFrames: async rendered => {
      renders++;
      const frames = join(rendered.outputDirectory, "frames"); await mkdir(frames);
      const count = rendered.authoring.timing.durationUs / 1_000_000;
      const bytes = await sharp({ create: { width: rendered.authoring.canvas.width, height: rendered.authoring.canvas.height, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 0.5 } } }).png().toBuffer();
      for (let index = 0; index < count; index++) await writeFile(join(frames, `frame-${String(index).padStart(8, "0")}.png`), bytes);
      const bundle = createHtmlOverlayExecutionBundle(rendered.authoring, rendered.browserRuntime);
      return { frameCount: count, framePattern: join(frames, "frame-%08d.png"), executionIntegrity: bundle.integrity, libraryLocks: bundle.libraryLocks };
    } },
  };
  const context: OperationExecutionContext = { application, abortSignal: new AbortController().signal, workflow: { ...identity, workspaceDirectory: workspace, beforePublication: async () => {} } };
  const input = await bindSpatialRenderInput(application, { source: { path: "original.scene.json" }, request }, context.abortSignal, bindRuntime);
  return { root, sourcePath, scene, input, context, application, workspace, capabilityRequests, renders: () => renders };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function withFixture(run: (f: Fixture) => Promise<void>) {
  const f = await fixture();
  try { await run(f); } finally { await rm(f.root, { recursive: true, force: true }); }
}
async function json(f: Fixture, artifact: MediaArtifactReference): Promise<unknown> { return JSON.parse(await readFile(join(f.root, artifact.path), "utf8")); }
async function publishJson(f: Fixture, value: unknown): Promise<MediaArtifactReference> {
  const text = `${canonicalJson(value)}\n`, sha256 = sha256Hex(text);
  const path = `artifacts/atet/generated/media-operations/outputs/${sha256}.json`;
  await writeFile(join(f.root, path), text);
  return { path, sha256, bytes: Buffer.byteLength(text) };
}
async function receipt(f: Fixture, output: SpatialRenderResult) { return SpatialRenderReceiptSchema.parse(await json(f, output.receipt)); }

// Native renderer behavior is covered by spatial-render.test.ts; these cases own
// the operation's exact capability, publication/recovery, and cleanup boundaries.
test("frame operation binds only its required browser capability and recovers after original path disappears", async () => withFixture(async f => {
  expect(f.input.capabilityBindings.map(item => item.name)).toEqual(["html-browser"]);
  const output = await executeSpatialRender(f.context, f.input, dependencies);
  await rm(f.sourcePath);
  expect(await recoverSpatialRenderOutput(f.application, f.input, output, identity, f.context.abortSignal)).toEqual(output);
  expect(f.capabilityRequests.every(name => name === "html-browser")).toBe(true);
  expect(f.renders()).toBe(1);
  expect(await readdir(f.workspace)).toEqual(expect.arrayContaining(["spatial-render-attempt.v1.json", "spatial-render-result.v1.json", "operation-completion.v1.json"]));
}));

test("post-publication source failure retains prospective artifact and blocks blind replay", async () => withFixture(async f => {
  let error: unknown;
  try { await executeSpatialRender(f.context, f.input, { ...dependencies, publishOriginal: async options => { await publishContentAddressedMedia(options); throw new Error("source directory sync failed after link"); } }); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(ApplicationError);
  const applicationError = error as ApplicationError;
  expect(applicationError.code).toBe("ambiguous");
  const evidence = applicationError.details?.spatialRenderOperation as { uncertainPublication: MediaArtifactReference };
  expect(evidence.uncertainPublication.sha256).toBe(f.input.source.sha256);
  expect(await readFile(join(f.root, evidence.uncertainPublication.path), "utf8")).toBe(await readFile(f.sourcePath, "utf8"));
  expect(await recoverSpatialRenderAttempt(f.application, f.input, identity, f.workspace, f.context.abortSignal)).toMatchObject({ kind: "ambiguous" });
  await expect(executeSpatialRender(f.context, f.input, dependencies)).rejects.toMatchObject({ code: "ambiguous" });
  expect(f.renders()).toBe(0);
}));

test("completed render survives checkpoint failure and is recovered from its durable exact result", async () => withFixture(async f => {
  let error: unknown;
  try { await executeSpatialRender(f.context, f.input, { ...dependencies, checkpoint: async () => { throw new Error("checkpoint unavailable"); } }); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(ApplicationError);
  const evidence = (error as ApplicationError).details?.spatialRenderOperation as { completion: Awaited<ReturnType<typeof executeSpatialRender>> };
  expect(evidence.completion.receipt).toBeDefined();
  expect(await readdir(f.workspace)).not.toContain("operation-completion.v1.json");
  await rm(f.sourcePath);
  const recovered = await recoverSpatialRenderAttempt(f.application, f.input, identity, f.workspace, f.context.abortSignal);
  expect(recovered.kind).toBe("completed");
  if (recovered.kind !== "completed") throw new Error("Expected retained completion.");
  expect(recovered.output).toEqual(evidence.completion);
  expect(f.renders()).toBe(1);
}));

test("workspace custody settles after mkdtemp failure and preserves render plus both cleanup failures", async () => withFixture(async f => {
  let disposed = 0;
  const createWorkspace = async () => ({ path: f.workspace, dispose: async () => { disposed++; } });
  const { workflow: _workflow, ...standalone } = f.context;
  await expect(executeSpatialRender(standalone, f.input, {
    ...dependencies, createWorkspace, createDirectory: async () => { throw new Error("mkdtemp failed"); },
  })).rejects.toThrow("mkdtemp failed");
  expect(disposed).toBe(1);
  let error: unknown;
  try { await executeSpatialRender(standalone, f.input, {
    ...dependencies, createWorkspace: async () => ({ path: f.workspace, dispose: async () => { disposed++; throw new Error("dispose failed"); } }),
    render: async () => { throw new Error("render failed"); }, removeDirectory: async () => { throw new Error("rm failed"); },
  }); } catch (caught) { error = caught; }
  expect(disposed).toBe(2);
  expect(error).toBeInstanceOf(ApplicationError);
  const cause = (error as ApplicationError).cause as AggregateError;
  expect(cause).toBeInstanceOf(AggregateError);
  expect(cause.errors.map(value => (value as Error).message)).toEqual(["render failed", "rm failed", "dispose failed"]);
}));

test("missing attempt is retryable but corrupt, wrong-identity, and cancelled attempt recovery fail closed", async () => withFixture(async f => {
  expect(await recoverSpatialRenderAttempt(f.application, f.input, identity, f.workspace, f.context.abortSignal)).toEqual({ kind: "retry" });
  await executeSpatialRender(f.context, f.input, dependencies);
  await expect(recoverSpatialRenderAttempt(f.application, f.input, { ...identity, nodeKey: "other" }, f.workspace, f.context.abortSignal)).rejects.toThrow("another exact");
  const cancelled = new AbortController(); cancelled.abort();
  await expect(recoverSpatialRenderAttempt(f.application, f.input, identity, f.workspace, cancelled.signal)).rejects.toMatchObject({ code: "cancelled" });
  await writeFile(join(f.workspace, "spatial-render-attempt.v1.json"), "{}");
  await expect(recoverSpatialRenderAttempt(f.application, f.input, identity, f.workspace, f.context.abortSignal)).rejects.toThrow("canonical");
}));

test("recovery rejects foreign output getters before parsing and proves primary frame equality", async () => withFixture(async f => {
  let called = 0;
  await expect(recoverSpatialRenderOutput(f.application, f.input, { get artifact() { called++; return {}; } }, identity, f.context.abortSignal)).rejects.toThrow();
  expect(called).toBe(0);
  const output = await executeSpatialRender(f.context, f.input, dependencies);
  const original = await receipt(f, output);
  const different = await publishJson(f, { unrelated: "payload" });
  const changed = { ...original, output: different };
  const modified = { ...output, artifact: different, receipt: await publishJson(f, changed) };
  await expect(recoverSpatialRenderOutput(f.application, f.input, modified, identity, f.context.abortSignal)).rejects.toThrow("Primary spatial frame");
}));

test("recovery rederives batch metadata, execution integrity, library locks, manifests, and sample partitions", async () => withFixture(async f => {
  const output = await executeSpatialRender(f.context, f.input, dependencies);
  const original = await receipt(f, output);
  const originalBatch = await json(f, original.batches[0]!);
  const changes: readonly { label: string; apply(value: Record<string, unknown>): void }[] = [
    { label: "metadata", apply: value => { const metadata = value.metadata as { frames: { stateSha256: string }[] }; metadata.frames[0]!.stateSha256 = "f".repeat(64); } },
    { label: "integrity", apply: value => { (value.executionIntegrity as { rootSha256: string }).rootSha256 = "f".repeat(64); } },
    { label: "locks", apply: value => { (value.libraryLocks as { version: string }[])[0]!.version = "0.0.0"; } },
    { label: "partition", apply: value => { (value.samples as { sample: { index: number } }[])[0]!.sample.index = 1; } },
    { label: "manifest", apply: value => { (value.preparation as { sourceManifests: unknown }).sourceManifests = { asset_invented: "f".repeat(64) }; } },
    { label: "prepared digest", apply: value => { (value.preparation as { preparedSha256: string }).preparedSha256 = "f".repeat(64); } },
  ];
  for (const change of changes) {
    const batch = structuredClone(originalBatch) as Record<string, unknown>;
    change.apply(batch);
    const artifact = await publishJson(f, batch);
    const changed = { ...original, batches: [artifact], costs: { ...original.costs, actualBatchMetadataBytes: artifact.bytes } };
    const modified = { ...output, receipt: await publishJson(f, changed) };
    await expect(recoverSpatialRenderOutput(f.application, f.input, modified, identity, f.context.abortSignal), change.label).rejects.toMatchObject({ code: "incompatible" });
  }
  expect(f.renders()).toBe(1);
}));


test("recovery verifies all ordered contact-sheet sample partitions across multiple batches", async () => withFixture(async f => {
  const input = await bindSpatialRenderInput(f.application, { source: f.input.source, request: { ...request,
    selection: { kind: "contact-sheet", timesUs: Array.from({ length: 33 }, (_, index) => index * 1_000), columns: 8, cellWidth: 8, cellHeight: 4 } } }, f.context.abortSignal, bindRuntime);
  const output = await executeSpatialRender(f.context, input, dependencies);
  expect(await recoverSpatialRenderOutput(f.application, input, output, identity, f.context.abortSignal)).toEqual(output);
  const original = await receipt(f, output);
  expect(original.batches).toHaveLength(2);
  const modified = { ...output, receipt: await publishJson(f, { ...original, batches: [...original.batches].reverse() }) };
  await expect(recoverSpatialRenderOutput(f.application, input, modified, identity, f.context.abortSignal)).rejects.toMatchObject({ code: "incompatible" });
  expect(f.renders()).toBe(2);
}));


test("service publication uncertainty remains ambiguous and service cleanup retains proven completion", async () => {
  await withFixture(async f => {
    const prospective = { path: `artifacts/atet/generated/media-operations/outputs/${"b".repeat(64)}.png`, bytes: 1, sha256: "b".repeat(64) };
    await expect(executeSpatialRender(f.context, f.input, { ...dependencies, render: async () => {
      throw new SpatialRenderFailure(new Error("frame link uncertainty"), { attemptId: "00000000-0000-4000-8000-000000000001", stage: "publication", published: [], uncertainPublication: prospective });
    } })).rejects.toMatchObject({ code: "ambiguous", details: { spatialRenderOperation: { uncertainPublication: prospective } } });
    expect((await recoverSpatialRenderAttempt(f.application, f.input, identity, f.workspace, f.context.abortSignal)).kind).toBe("ambiguous");
  });
  await withFixture(async f => {
    await expect(executeSpatialRender(f.context, f.input, { ...dependencies, render: async (context, input) => {
      const output = await renderSpatialScene(context, input, { bindBrowserRuntime: bindRuntime });
      throw new SpatialRenderFailure(new Error("service cleanup failed"), { attemptId: "00000000-0000-4000-8000-000000000002", stage: "cleanup", published: [output.artifact, output.receipt], completion: output });
    } })).rejects.toMatchObject({ code: "ambiguous" });
    expect((await recoverSpatialRenderAttempt(f.application, f.input, identity, f.workspace, f.context.abortSignal)).kind).toBe("completed");
    expect(f.renders()).toBe(1);
  });
});
