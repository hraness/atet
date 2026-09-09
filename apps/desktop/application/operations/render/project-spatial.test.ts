import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, test } from "bun:test";

import { VideoProjectV1Schema } from "../../../contracts";
import { SpatialProjectHeadV2Schema, SpatialProjectRevisionV2Schema } from "../../../contracts/spatial-project";
import { canonicalJson, canonicalJsonSha256, sha256Hex } from "../../../core/canonical-json";
import { spatialProjectArtifact, spatialProjectContents, spatialProjectDocumentText, spatialProjectRevisionSha256 } from "../../../core/spatial-project";
import type { ApplicationContext } from "../../context";
import { hashProjectEditRevisionOutputGeometry, ProjectRenderPlanDocumentSchema, ProjectRenderPlanReferenceSchema } from "../../receipts";
import { createSpatialCompositorCadence } from "../../spatial-compositor-cadence";
import { editedPlan, syncedProject } from "../../spatial-project-fixture.testing";
import { createSpatialRenderProjection } from "../../spatial-render-projection";
import {
  bindProjectRenderInputV4, projectRenderOperationDefinitionV4, ProjectRenderInputSchemaV4,
  reconcileProjectRenderV4, type ProjectRenderInputV4,
} from "./project";
import { createProjectSpatialRenderReceipt, ProjectSpatialRenderReceiptV1Schema } from "./project-spatial-receipt";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const execution = { nodeKey: "render", nodePlanSha256: "b".repeat(64), runId: "run_spatial_render01" };
const renderedBytes = Buffer.from("injected spatial compositor bytes; native probe is injected separately\n");
async function put(root: string, path: string, value: string | Uint8Array) {
  const absolute = join(root, path); await mkdir(dirname(absolute), { recursive: true }); await writeFile(absolute, value); return absolute;
}
async function fixture(options: { badTiming?: boolean; failFence?: boolean; revokeAfterPrecommit?: boolean; badGeometry?: boolean; badPixelFormat?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atet-project-spatial-"))); directories.push(root);
  const sourceMedia = Buffer.from("retained source media fixture\n"), sourceSha = sha256Hex(sourceMedia.toString());
  const original = syncedProject();
  const project = VideoProjectV1Schema.parse({ ...original, assets: original.assets.map(asset => ({ ...asset,
    streams: asset.streams.map(stream => ({ ...stream, segments: stream.segments.map(segment => ({ ...segment, sha256: sourceSha, bytes: sourceMedia.length })) })),
  })) });
  const projectEditPlan = editedPlan(project), projectRoot = join(root, "artifacts", "atet", "projects"), projectDirectory = join(projectRoot, project.projectId);
  await mkdir(projectDirectory, { recursive: true });
  for (const name of ["reference.mov", "camera.mov"]) await put(root, `fixtures/${name}`, sourceMedia);
  const revision = SpatialProjectRevisionV2Schema.parse({ kind: "atet.spatial-project-revision", schemaVersion: 2, projectId: project.projectId,
    parent: { version: 1, sha256: "a".repeat(64) }, transactionId: `transaction_${"0".repeat(32)}`, legacy: { project, projectEditPlan }, scenes: [], shots: [], candidates: [], selections: [] });
  const head = SpatialProjectHeadV2Schema.parse({ kind: "atet.spatial-project-head", schemaVersion: 2, projectId: project.projectId,
    projectRevisionSha256: spatialProjectRevisionSha256(revision), revision: spatialProjectArtifact("revisions", spatialProjectDocumentText(revision)), transactionId: revision.transactionId });
  const projected = createSpatialRenderProjection({ snapshot: { version: 2, head, revision, headText: spatialProjectDocumentText(head), basis: { version: 2, sha256: head.projectRevisionSha256 },
    contents: spatialProjectContents(revision, []) }, materializedShots: [], policy: { kind: "full-frame-above-legacy-video-below-overlays", alpha: "straight" },
  output: { pixelWidth: 640, pixelHeight: 480, frameRate: { numerator: 30_000, denominator: 1_001 }, background: "#000000ff", colorSpace: "srgb" } });
  await put(projectDirectory, head.revision.path, spatialProjectDocumentText(revision));
  await put(projectDirectory, projected.projection.derivedV1Revision.path, spatialProjectDocumentText(projected.revision));
  const outputGeometrySha256 = hashProjectEditRevisionOutputGeometry({ pixelWidth: 640, pixelHeight: 480, revisionSha256: projected.revision.revisionSha256 });
  const document = ProjectRenderPlanDocumentSchema.parse({ kind: "atet.project-render-plan-document", schemaVersion: 1, plan: projected.renderPlan, outputGeometrySha256,
    projectEditPlanSha256: projected.revision.projectEditPlanSha256, projectSha256: projected.revision.projectSha256, revisionSha256: projected.revision.revisionSha256, renderPlanSha256: canonicalJsonSha256(projected.renderPlan) });
  const planText = `${canonicalJson(document)}\n`, artifact = { path: `renders/plans/${sha256Hex(planText)}.json`, sha256: sha256Hex(planText), bytes: Buffer.byteLength(planText) };
  await put(projectDirectory, artifact.path, planText);
  const plan = ProjectRenderPlanReferenceSchema.parse({ kind: "atet.project-render-plan-reference", schemaVersion: 1, artifact, projectId: project.projectId, outputGeometrySha256,
    revisionSha256: projected.revision.revisionSha256, projectSha256: projected.revision.projectSha256, projectEditPlanSha256: projected.revision.projectEditPlanSha256,
    planSha256: projected.renderPlan.planSha256, renderPlanSha256: canonicalJsonSha256(projected.renderPlan) });
  const cadence = createSpatialCompositorCadence({ ...projected, plan: projected.renderPlan });
  const privateRoot = join(root, "artifacts", "atet", "private"); await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  const workspace = join(privateRoot, "workflow-runs", execution.runId, "staging", sha256Hex(execution.nodeKey), execution.nodePlanSha256);
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const command = await put(root, "bin/native-fixture", "native fixture\n");
  await chmod(command, 0o700);
  const calls: string[][] = [];
  const application: ApplicationContext = {
    paths: { repositoryRoot: root, privateRoot, projectRoot, artifactRoot: join(root, "artifacts", "atet", "recordings"), desktopRoot: root },
    clock: { now: () => new Date("2026-09-08T00:00:00Z"), timestampMilliseconds: () => 0 }, capabilities: () => Promise.resolve([]),
    capability: async name => name === "rsvg-convert" ? { name, available: false } : { name, available: true, command, version: "fixture1" },
    runner: { async run(argv) {
      calls.push([...argv]);
      if (argv.includes("-select_streams")) {
        const video = argv[argv.indexOf("-select_streams") + 1] === "v:0";
        return { exitCode: 0, stderr: "", stdout: JSON.stringify(video
          ? { streams: [{ codec_type: "video", codec_name: "h264", width: options.badGeometry === true ? 320 : 640, height: 480, pix_fmt: options.badPixelFormat === true ? "yuv444p" : "yuv420p", time_base: "1/30000", start_pts: 0, duration_ts: cadence.cadence.frameCount * 1_001,
            avg_frame_rate: "30000/1001", r_frame_rate: "30000/1001", nb_frames: String(cadence.cadence.frameCount), nb_read_frames: String(cadence.cadence.frameCount) }],
          frames: Array.from({ length: cadence.cadence.frameCount }, (_, index) => ({ best_effort_timestamp: index * 1_001 + (options.badTiming === true && index === 1 ? 1 : 0) })) }
          : { streams: [{ codec_type: "audio", codec_name: "aac", time_base: "1/48000", start_pts: 0, duration_ts: projected.renderPlan.output.durationUs * 48_000 / 1_000_000, sample_rate: "48000" }] }) };
      }
      await writeFile(argv.at(-1)!, renderedBytes);
      return { exitCode: 0, stderr: "", stdout: "" };
    } },
  };
  const requested = { plan, output: { path: "renders/spatial.mp4", maximumBytes: 1024 * 1024 }, syncPolicy: "allow-unverified", target: { canvas: { kind: "custom", frameRate: 30_000 / 1_001, pixelWidth: 640, pixelHeight: 480 }, tier: "final" },
    spatial: { projection: projected.projection, projectionSha256: projected.projectionSha256, cadence } };
  const input = await bindProjectRenderInputV4(application, requested);
  const beforePublication = async () => {
    if (options.failFence === true || options.revokeAfterPrecommit === true && (await readdir(workspace)).includes("spatial-project-render-precommit.v1.json")) throw new Error("injected revoked publication fence");
  };
  const context = { application, abortSignal: new AbortController().signal, workflow: { ...execution, workspaceDirectory: workspace, beforePublication } };
  return { root, projectDirectory, application, context, input, projected, workspace, calls, beforePublication };
}

test("V4 binds historical immutable authority without reading or rewriting V1 project files", async () => {
  const value = await fixture();
  expect(ProjectRenderInputSchemaV4.parse(value.input)).toEqual(value.input);
  expect(value.input.spatial.projection.source.projectRevisionSha256).not.toBe(value.input.plan.revisionSha256);
  expect(await readdir(value.projectDirectory)).not.toContain("project.json");
  expect(await bindProjectRenderInputV4(value.application, value.input)).toEqual(value.input);
});

test("V4 preserves getters, stale projection, stale derivation and mismatched target rejection before execution", async () => {
  const value = await fixture(); let invoked = 0;
  expect(() => ProjectRenderInputSchemaV4.parse({ get spatial() { invoked++; return value.input.spatial; } })).toThrow();
  expect(invoked).toBe(0);
  expect(() => ProjectRenderInputSchemaV4.parse({ ...value.input, spatial: { ...value.input.spatial, projectionSha256: "f".repeat(64) } })).toThrow();
  expect(() => ProjectRenderInputSchemaV4.parse({ ...value.input, target: { ...value.input.target, canvas: { kind: "custom", pixelWidth: 640, pixelHeight: 480, frameRate: 30 } } })).toThrow();
  const forged = structuredClone(value.input);
  forged.spatial.projection.source.projectRevisionSha256 = "f".repeat(64);
  forged.spatial.projectionSha256 = canonicalJsonSha256({ domain: "atet.scene-render-projection/v1", projection: forged.spatial.projection });
  forged.spatial.cadence = createSpatialCompositorCadence({ projection: forged.spatial.projection, projectionSha256: forged.spatial.projectionSha256, plan: value.projected.renderPlan });
  await expect(bindProjectRenderInputV4(value.application, forged)).rejects.toThrow("authority");
  expect(value.calls).toEqual([]);
});

test("V4 verifies real staging identity and native cadence before atomically publishing an outer receipt", async () => {
  const value = await fixture();
  const result = await projectRenderOperationDefinitionV4.lifecycle.execute(value.context, value.input);
  expect(await readFile(join(value.projectDirectory, result.output.path))).toEqual(renderedBytes);
  const receipt = ProjectSpatialRenderReceiptV1Schema.parse(JSON.parse(await readFile(join(value.projectDirectory, result.receipt.path), "utf8")));
  expect(receipt.execution.schemaVersion).toBe(2);
  expect(receipt.spatial).toEqual(value.input.spatial);
  expect(receipt.timing.frameRate).toEqual({ numerator: 30_000, denominator: 1_001 });
  expect(receipt.timing.video).toEqual({ pixelWidth: 640, pixelHeight: 480, pixelFormat: "yuv420p" });
  expect(result.receipt.projectRevisionSha256).toBe(value.projected.projection.source.projectRevisionSha256);
  expect(value.calls.filter(call => call.includes("-select_streams"))).toHaveLength(2);
  const encoding = value.calls.find(call => call.includes("-filter_complex_script"))!;
  expect(encoding).toContain("30000/1001");
  expect(await readdir(value.projectDirectory)).not.toContain("project.json");
  const recovered = await reconcileProjectRenderV4(value.application, value.input, execution, { abortSignal: new AbortController().signal, beforePublication: value.beforePublication });
  expect(recovered).toEqual({ kind: "completed", output: result });
});

test("wrong encoded PTS, geometry or pixel format, or a revoked final fence leave no public output or receipt", async () => {
  for (const options of [{ badTiming: true }, { badGeometry: true }, { badPixelFormat: true }, { failFence: true }]) {
    const value = await fixture(options);
    await expect(projectRenderOperationDefinitionV4.lifecycle.execute(value.context, value.input)).rejects.toThrow();
    expect(await readdir(join(value.projectDirectory, "renders"))).not.toContain("spatial.mp4");
    expect(await readdir(join(value.projectDirectory, "renders", "receipts"))).toEqual([]);
    expect(await readdir(value.workspace)).not.toContain("spatial-project-render-precommit.v1.json");
  }
});

test("V4 recovery completes only exact precommitted bytes and rejects substituted authority", async () => {
  const value = await fixture();
  const result = await projectRenderOperationDefinitionV4.lifecycle.execute(value.context, value.input);
  await rm(join(value.projectDirectory, result.receipt.path));
  const control = { abortSignal: new AbortController().signal, beforePublication: value.beforePublication };
  expect(await reconcileProjectRenderV4(value.application, value.input, execution, control)).toEqual({ kind: "completed", output: result });
  await writeFile(join(value.projectDirectory, result.output.path), "corrupt bytes");
  expect((await reconcileProjectRenderV4(value.application, value.input, execution, control)).kind).toBe("conflict");
});

test("distinct outer receipt hash binds full cadence and rejects cross-envelope tampering", async () => {
  const value = await fixture();
  const result = await projectRenderOperationDefinitionV4.lifecycle.execute(value.context, value.input);
  const receipt = ProjectSpatialRenderReceiptV1Schema.parse(JSON.parse(await readFile(join(value.projectDirectory, result.receipt.path), "utf8")));
  expect(createProjectSpatialRenderReceipt({ execution: receipt.execution, spatial: receipt.spatial, timing: receipt.timing })).toEqual(receipt);
  expect(() => ProjectSpatialRenderReceiptV1Schema.parse({ ...receipt, timing: { ...receipt.timing, frameCount: receipt.timing.frameCount - 1 } })).toThrow();
  expect(() => createProjectSpatialRenderReceipt({ execution: receipt.execution, spatial: receipt.spatial,
    timing: { ...receipt.timing, video: { ...receipt.timing.video, pixelWidth: 320 } } })).toThrow("measured cadence");
  const forged = { ...value.input, output: { ...value.input.output, maximumBytes: 512 * 1024 * 1024 } } as ProjectRenderInputV4;
  expect(() => ProjectRenderInputSchemaV4.parse(forged)).toThrow("256 MiB");
});

test("V4 recovery rejects correctly timed output whose measured dimensions no longer match its projection", async () => {
  const options = { badGeometry: false }, value = await fixture(options);
  const result = await projectRenderOperationDefinitionV4.lifecycle.execute(value.context, value.input);
  await rm(join(value.projectDirectory, result.receipt.path));
  options.badGeometry = true;
  const recovered = await reconcileProjectRenderV4(value.application, value.input, execution, { abortSignal: new AbortController().signal, beforePublication: value.beforePublication });
  expect(recovered.kind).toBe("conflict");
  if (recovered.kind === "conflict") expect(recovered.message).toContain("dimensions or pixel format");
  expect(await readdir(join(value.projectDirectory, "renders", "receipts"))).toEqual([]);
});

test("custody revoked after durable precommit cannot link the public output or discard precommit evidence", async () => {
  const value = await fixture({ revokeAfterPrecommit: true });
  await expect(projectRenderOperationDefinitionV4.lifecycle.execute(value.context, value.input)).rejects.toThrow("revoked publication fence");
  expect(await readdir(join(value.projectDirectory, "renders"))).not.toContain("spatial.mp4");
  expect(await readdir(join(value.projectDirectory, "renders", "receipts"))).toEqual([]);
  expect(await readdir(value.workspace)).toContain("spatial-project-render-precommit.v1.json");
  const result = await reconcileProjectRenderV4(value.application, value.input, execution, { abortSignal: new AbortController().signal, beforePublication: async () => {} });
  expect(result.kind).toBe("conflict");
});

test("recovery rechecks custody at the final receipt link after output durability work", async () => {
  const value = await fixture();
  const rendered = await projectRenderOperationDefinitionV4.lifecycle.execute(value.context, value.input);
  await rm(join(value.projectDirectory, rendered.receipt.path));
  let calls = 0;
  const result = await reconcileProjectRenderV4(value.application, value.input, execution, { abortSignal: new AbortController().signal,
    async beforePublication() { calls++; if (calls === 2) throw new Error("revoked during output durability"); } });
  expect(result.kind).toBe("conflict");
  expect(calls).toBe(2);
  expect(await readdir(join(value.projectDirectory, "renders", "receipts"))).toEqual([]);
  expect(await readFile(join(value.projectDirectory, rendered.output.path))).toEqual(renderedBytes);
  const completed = await reconcileProjectRenderV4(value.application, value.input, execution, { abortSignal: new AbortController().signal, beforePublication: async () => {} });
  expect(completed).toEqual({ kind: "completed", output: rendered });
});
