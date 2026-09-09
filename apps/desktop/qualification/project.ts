/** Opt-in real V4 workflow and CLI preparation qualification. Requires the sole host browser lane. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { arch, cpus, release, totalmem } from "node:os";
import { join, relative, resolve } from "node:path";

import sharp from "sharp";
import { createDefaultHostResourceCoordinator } from "@hraness/atet/host-resources";

import { parseSpatialScene, spatialSceneSha256 } from "../../../src/spatial-scene/index";
import { SpatialShotV1Schema } from "../../../src/spatial-scene/contracts";
import type { ApplicationCapability, ApplicationContext } from "../application/context";
import { createApplicationOperationRegistry } from "../application/default-registry";
import { bindProjectRenderInputV4, ProjectRenderOutputSchemaV4, reconcileProjectRenderV4 } from "../application/operations/render/project";
import { ProjectSpatialRenderReceiptV1Schema } from "../application/operations/render/project-spatial-receipt";
import { SpatialProjectMutationOutputSchema, SpatialProjectSnapshotOutputSchema } from "../application/operations/spatial-project";
import { hashProjectEditRevisionOutputGeometry, ProjectRenderPlanDocumentSchema, ProjectRenderPlanReferenceSchema } from "../application/receipts";
import { createSpatialCompositorCadence } from "../application/spatial-compositor-cadence";
import { spatialProjectStorePorts } from "../application/spatial-project-authority";
import { withSpatialProjectLease } from "../application/spatial-project-lease";
import { readSpatialProjectAuthority } from "../application/spatial-project-store";
import { planSpatialRender, SpatialRenderOutputSchema, SpatialRenderReceiptSchema, spatialShotRenderRequest } from "../application/spatial-render";
import { createSpatialRenderProjection, SpatialMaterializedShotVideoSchema } from "../application/spatial-render-projection";
import { BunProcessRunner } from "../cli/io";
import { PlaywrightHtmlOverlayRenderer } from "../cli/html-overlay-renderer";
import { commandHostResourceClaims } from "../cli/command-host-resources";
import { executeSpatialProjectCommand } from "../cli/spatial-project-service";
import { createWorkflowRun, runWorkflow } from "../cli/workflow-runs";
import { planBuiltInWorkflow } from "../code/planning";
import { OverlayOperationSchema, ProjectEditPlanV1Schema, VideoProjectV1Schema, EditPlanIdSchema } from "../contracts";
import { canonicalJson, canonicalJsonSha256, sha256Hex } from "../core/canonical-json";
import { createDefaultProjectEditPlan } from "../core/project-plan";
import { spatialProjectDocumentText, spatialShotSha256 } from "../core/spatial-project";
import { createNodeBundleFileSystem, saveProjectEditPlan, saveVideoProject } from "../core/storage";
import { builtInWorkflow } from "../workflows";

const repositoryRoot = await realpath(resolve(import.meta.dir, "../../.."));
assert.equal(process.argv.length, 3, "Usage: bun apps/desktop/qualification/project.ts <exact-shot-scene-report.json>");
const sourceReportPath = relative(repositoryRoot, resolve(repositoryRoot, process.argv[2]!));
const repositoryFileSystem = createNodeBundleFileSystem(repositoryRoot);
const reportInput: unknown = JSON.parse(await repositoryFileSystem.readText(sourceReportPath, 32 * 1024 * 1024));
assert.ok(typeof reportInput === "object" && reportInput !== null && "results" in reportInput);
const results = reportInput.results;
assert.ok(typeof results === "object" && results !== null && "rational" in results);
const sceneResult = SpatialRenderOutputSchema.parse(results.rational);
const receiptText = await repositoryFileSystem.readText(sceneResult.receipt.path, sceneResult.receipt.bytes);
assert.equal(Buffer.byteLength(receiptText), sceneResult.receipt.bytes);
assert.equal(sha256Hex(receiptText), sceneResult.receipt.sha256);
const sceneReceipt = SpatialRenderReceiptSchema.parse(JSON.parse(receiptText));
assert.deepEqual(sceneReceipt.output, sceneResult.artifact);
const sourceText = await repositoryFileSystem.readText(sceneResult.sceneSource.path, sceneResult.sceneSource.bytes);
assert.equal(Buffer.byteLength(sourceText), sceneResult.sceneSource.bytes); assert.equal(sha256Hex(sourceText), sceneResult.sceneSource.sha256);
const scene = parseSpatialScene(JSON.parse(sourceText));
const frameRate = { numerator: 30_000, denominator: 1_001 }, sourceDurationUs = 1_001_000;
const shot = SpatialShotV1Schema.parse({ shotId: "shot_qualified", sceneSha256: spatialSceneSha256(scene), cameraId: "camera_main",
  range: { startUs: 100_100, endUs: 300_300 }, sceneStartUs: 0, playback: "once", overrides: [] });
const request = spatialShotRenderRequest(shot, frameRate), scenePlan = planSpatialRender(scene, request);
assert.deepEqual(sceneReceipt.request, request, "Only an actual render with this exact shot clock is reusable; never relabel an earlier receipt.");
assert.equal(sceneReceipt.requestSha256, scenePlan.requestSha256);
assert.deepEqual(sceneReceipt.samples.map(sample => sample.sample), scenePlan.samples);
assert.equal(sceneResult.render.width, 320); assert.equal(sceneResult.render.height, 180);
assert.equal(sceneResult.render.frameCount, 6);
await repositoryFileSystem.inspectFile!(sceneResult.artifact.path, sceneResult.artifact.bytes).then(value => assert.deepEqual(value, { bytes: sceneResult.artifact.bytes, sha256: sceneResult.artifact.sha256 }));

const root = join(repositoryRoot, "artifacts", "spatial-project-qualification", new Date().toISOString().replaceAll(":", "-"));
await mkdir(root, { recursive: true, mode: 0o700 });
console.log(JSON.stringify({ event: "project-qualification-start", root, sourceReport: sourceReportPath }));
const projectRoot = join(root, "projects"), projectId = "project_spatialqualified", projectDirectory = join(projectRoot, projectId);
await mkdir(projectDirectory, { recursive: true, mode: 0o700 });
const fs = createNodeBundleFileSystem(projectDirectory), native = new BunProcessRunner();
const commands: { argv: readonly string[]; exitCode: number; milliseconds: number }[] = [];
const runner: ApplicationContext["runner"] = { async run(argv, options) {
  const start = performance.now(), result = await native.run(argv, options);
  commands.push({ argv, exitCode: result.exitCode, milliseconds: performance.now() - start });
  return result;
} };
const started = performance.now(), ffmpeg = Bun.which("ffmpeg") ?? "/opt/homebrew/bin/ffmpeg", ffprobe = Bun.which("ffprobe") ?? "/opt/homebrew/bin/ffprobe";
async function run(argv: readonly [string, ...string[]]): Promise<string> {
  const result = await runner.run(argv, { cwd: root, stdin: "ignore", timeoutMs: 120_000, maxOutputBytes: 4 * 1024 * 1024 });
  assert.equal(result.exitCode, 0, result.stderr); return result.stdout;
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const capabilities: ApplicationCapability[] = [];
for (const [name, command] of [["ffmpeg", ffmpeg], ["ffprobe", ffprobe]] as const) {
  capabilities.push({ name, available: true, command, version: (await run([command, "-version"])).split("\n")[0]! });
}
const application: ApplicationContext = {
  paths: { repositoryRoot, projectRoot, privateRoot: join(root, "private"), artifactRoot: join(root, "recordings"), desktopRoot: join(repositoryRoot, "apps", "desktop") },
  clock: { now: () => new Date(), timestampMilliseconds: Date.now }, runner,
  capability: async name => capabilities.find(value => value.name === name) ?? { name, available: false }, capabilities: async () => capabilities,
};
const baseVideo = join(root, "base.mov");
await run([ffmpeg, "-v", "error", "-nostdin", "-threads", "1", "-stream_loop", "4", "-i", join(repositoryRoot, sceneResult.artifact.path),
  "-an", "-frames:v", "30", "-vf", "hue=s=0", "-filter_threads", "1", "-r", "30000/1001", "-c:v", "qtrle", "-pix_fmt", "argb", "-video_track_timescale", "30000", baseVideo]);
const baseProbe: unknown = JSON.parse(await run([ffprobe, "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
  "stream=codec_name,avg_frame_rate,nb_read_frames,width,height,time_base,duration_ts", "-of", "json", baseVideo]));
assert.ok(typeof baseProbe === "object" && baseProbe !== null && "streams" in baseProbe && Array.isArray(baseProbe.streams));
assert.deepEqual(baseProbe.streams, [{ codec_name: "qtrle", width: 320, height: 180, avg_frame_rate: "30000/1001", time_base: "1/30000", duration_ts: 30030, nb_read_frames: "30" }]);
const baseBytes = await readFile(baseVideo), baseSha256 = hash(baseBytes);
const audioPath = join(root, "original-tones.wav"), sampleRate = 48_000, sampleCount = sourceDurationUs * sampleRate / 1_000_000;
const frequencies = [431, 1733, 701, 997, 1291];
const audio = Buffer.alloc(44 + sampleCount * 2);
audio.write("RIFF"); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8); audio.writeUInt32LE(16, 16);
audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(sampleRate, 24); audio.writeUInt32LE(sampleRate * 2, 28);
audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write("data", 36); audio.writeUInt32LE(sampleCount * 2, 40);
for (let index = 0; index < sampleCount; index++) {
  const time = index / sampleRate, frequency = frequencies[time < .3003 ? 0 : time < .4004 ? 1 : time < .6006 ? 2 : time < .8008 ? 3 : 4]!;
  audio.writeInt16LE(Math.round(.4 * 32767 * Math.sin(2 * Math.PI * frequency * time)), 44 + index * 2);
}
await writeFile(audioPath, audio);
const audioSha256 = hash(audio), now = new Date().toISOString(), range = { startUs: 0, endUs: sourceDurationUs };
const source = (name: string, digest: string) => ({ kind: "imported", importedAt: now, originalName: name, sourceSha256: digest });
const segment = (path: string, bytes: number, sha256: string, codec: string, container: string) => ({ path: relative(repositoryRoot, path), bytes, sha256, codec, container, streamIndex: 0, assetRange: range, fileRange: range });
const sync = { anchors: [{ assetTimeUs: 0, projectTimeUs: 0 }, { assetTimeUs: sourceDurationUs, projectTimeUs: sourceDurationUs }], provenance: { kind: "identity" } };
const project = VideoProjectV1Schema.parse({ kind: "atet.video-project", schemaVersion: 1, projectId, name: "Qualified scene source clock", createdAt: now, updatedAt: now,
  currentEditPlanPath: "edits/current.json", timeline: { durationUs: sourceDurationUs, timebase: "microseconds" }, analyses: [], referencePlacementId: "placement_video001",
  assets: [{ assetId: "asset_video001", createdAt: now, durationUs: sourceDurationUs, label: "Actual desaturated scene footage", role: "screen", source: source("base.mov", baseSha256),
    streams: [{ kind: "video", streamId: "stream_video001", label: "Video", role: "screen", pixelWidth: 320, pixelHeight: 180, frameRate: 30_000 / 1_001, segments: [segment(baseVideo, baseBytes.length, baseSha256, "qtrle", "mov")] }] },
  { assetId: "asset_audio001", createdAt: now, durationUs: sourceDurationUs, label: "Original clock-coded tones", role: "music", source: source("original-tones.wav", audioSha256),
    streams: [{ kind: "audio", streamId: "stream_audio001", label: "Audio", role: "music", channels: 1, sampleRateHz: sampleRate, segments: [segment(audioPath, audio.length, audioSha256, "pcm_s16le", "wav")] }] }],
  placements: [{ placementId: "placement_video001", assetId: "asset_video001", assetRange: range, enabled: true, sync, audio: [], video: [{ streamId: "stream_video001", presentation: {
    enabled: true, blendMode: "normal", crop: { kind: "none" }, fit: "fill", layer: 0, layout: { kind: "normalized", x: 0, y: 0, width: 1, height: 1 }, opacity: 1 } }] },
  { placementId: "placement_audio001", assetId: "asset_audio001", assetRange: range, enabled: true, sync, video: [], audio: [{ streamId: "stream_audio001", presentation: { enabled: true, gainDb: 0, pan: 0 } }] }],
});
const overlayPath = "assets/qualified-overlay.png"; await mkdir(join(projectDirectory, "assets"), { mode: 0o700 });
const overlayBytes = await sharp({ create: { width: 24, height: 16, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 1 } } }).png().toBuffer();
await writeFile(join(projectDirectory, overlayPath), overlayBytes);
const overlay = OverlayOperationSchema.parse({ overlayId: "overlay_qualified", anchor: "top-left", position: { x: 8, y: 8 },
  intrinsicSize: { width: 24, height: 16 }, size: { kind: "intrinsic" }, opacity: 1, rotationDegrees: 0, scale: 1, zIndex: 0, range,
  entrance: { kind: "none" }, exit: { kind: "none" }, source: { kind: "image", asset: { path: overlayPath, bytes: overlayBytes.length, sha256: hash(overlayBytes), mediaType: "image/png",
    provenance: { kind: "imported", originalName: "qualified-overlay.png", sourceSha256: hash(overlayBytes) } } } });
const projectEditPlan = ProjectEditPlanV1Schema.parse({ ...createDefaultProjectEditPlan(project, EditPlanIdSchema.parse("plan_qualified"), now),
  keep: [{ startUs: 0, endUs: 300_300 }, { startUs: 400_400, endUs: sourceDurationUs }], speed: [{ range: { startUs: 600_600, endUs: 800_800 }, rate: 2 }], overlays: [overlay] });
await saveVideoProject(fs, project); await saveProjectEditPlan(fs, projectEditPlan);
for (const retained of sceneResult.retainedAssets) await repositoryFileSystem.copyFileNoReplace!(retained.artifact.path, relative(repositoryRoot, join(projectDirectory, retained.originalPath)), retained.artifact);
const registry = createApplicationOperationRegistry();
const snapshot = await withSpatialProjectLease(application, projectId, async leased => {
  const context = { application: leased, abortSignal: new AbortController().signal };
  const before = SpatialProjectSnapshotOutputSchema.parse((await registry.execute(context, { kind: "spatial.project.snapshot", version: 1, input: { project: projectId } })).output);
  const migrated = SpatialProjectMutationOutputSchema.parse((await registry.execute(context, { kind: "spatial.project.migrate", version: 1, input: {
    project: projectId, expected: before.basis, transactionId: `transaction_${randomUUID().replaceAll("-", "")}`, scenes: [{ sceneSha256: spatialSceneSha256(scene), document: scene }], shots: [shot],
  } })).output);
  assert.equal(migrated.kind, "completed");
  const authority = await readSpatialProjectAuthority(await spatialProjectStorePorts(leased, projectId));
  assert.equal(authority.version, 2); if (authority.version !== 2) throw new Error("Migration failed."); return authority;
}, undefined, "mutation");
const materialized = SpatialMaterializedShotVideoSchema.parse({ shotId: shot.shotId, shotSha256: spatialShotSha256(shot), sceneSha256: shot.sceneSha256,
  receiptSha256: sceneResult.receipt.sha256, artifact: { ...sceneResult.artifact, path: `spatial/outputs/${sceneResult.artifact.sha256}.mov` },
  pixelWidth: 320, pixelHeight: 180, frameCount: 6, frameRate, alpha: "straight", colorSpace: "srgb", codec: "qtrle", container: "mov", streamIndex: 0 });
await repositoryFileSystem.copyFileNoReplace!(sceneResult.artifact.path, relative(repositoryRoot, join(projectDirectory, materialized.artifact.path)), sceneResult.artifact);
await repositoryFileSystem.copyFileNoReplace!(sceneResult.receipt.path, relative(repositoryRoot, join(projectDirectory, `spatial/receipts/${sceneResult.receipt.sha256}.json`)), sceneResult.receipt);
const projected = createSpatialRenderProjection({ snapshot, materializedShots: [materialized], policy: { kind: "full-frame-above-legacy-video-below-overlays", alpha: "straight" },
  output: { pixelWidth: 320, pixelHeight: 180, frameRate, background: "#101820ff", colorSpace: "srgb" } });
assert.equal(projected.renderPlan.output.durationUs, 800_800); assert.equal(projected.renderPlan.audioSlices.some(slice => slice.projectSpeed === 2), true);
assert.equal(projected.renderPlan.videoSlices.filter(slice => slice.assetId.startsWith("asset_spatial_")).length, 1);
assert.ok(projected.renderPlan.overlays.length > 0);
await fs.writeTextNoReplace!(projected.projection.derivedV1Revision.path, spatialProjectDocumentText(projected.revision));
const outputGeometrySha256 = hashProjectEditRevisionOutputGeometry({ pixelWidth: 320, pixelHeight: 180, revisionSha256: projected.revision.revisionSha256 });
const document = ProjectRenderPlanDocumentSchema.parse({ kind: "atet.project-render-plan-document", schemaVersion: 1, plan: projected.renderPlan, outputGeometrySha256,
  projectEditPlanSha256: projected.revision.projectEditPlanSha256, projectSha256: projected.revision.projectSha256, revisionSha256: projected.revision.revisionSha256, renderPlanSha256: canonicalJsonSha256(projected.renderPlan) });
const text = spatialProjectDocumentText(document), artifact = { path: `renders/plans/${sha256Hex(text)}.json`, sha256: sha256Hex(text), bytes: Buffer.byteLength(text) };
await fs.writeTextNoReplace!(artifact.path, text);
const plan = ProjectRenderPlanReferenceSchema.parse({ kind: "atet.project-render-plan-reference", schemaVersion: 1, artifact, projectId, outputGeometrySha256,
  projectEditPlanSha256: projected.revision.projectEditPlanSha256, projectSha256: projected.revision.projectSha256, revisionSha256: projected.revision.revisionSha256,
  renderPlanSha256: canonicalJsonSha256(projected.renderPlan), planSha256: projected.renderPlan.planSha256 });
const cadence = createSpatialCompositorCadence({ ...projected, plan: projected.renderPlan });
assert.equal(cadence.cadence.frameCount, 24);
const input = await bindProjectRenderInputV4(application, { plan, spatial: { projection: projected.projection, projectionSha256: projected.projectionSha256, cadence },
  output: { path: "renders/qualified.mp4", maximumBytes: 16 * 1024 * 1024 }, syncPolicy: "require-verified",
  target: { canvas: { kind: "custom", pixelWidth: 320, pixelHeight: 180, frameRate: 30_000 / 1_001 }, tier: "final" } });
await writeFile(join(root, "prepared-render.json"), `${canonicalJson(input)}\n`);
const workflow = builtInWorkflow("directed-scene"); assert.ok(workflow);
const planned = await planBuiltInWorkflow({ application, registry, workflow, workflowInput: input });
const created = await createWorkflowRun({ application, registry, ...planned, graphPlan: planned.plan, sourceLocator: "builtin:directed-scene@1" });
console.log(JSON.stringify({ event: "project-qualification-workflow", runId: created.runId, graphPlanSha256: planned.plan.graphPlanSha256 }));
const headText = await fs.readText("project.json"), currentPlanText = await fs.readText("edits/current.json");
const result = await runWorkflow({ application, registry, runId: created.runId, store: created.store, jobs: 1 });
await writeFile(join(root, "scheduler-result.json"), `${JSON.stringify(result, null, 2)}\n`);
await writeFile(join(root, "native-commands.json"), `${JSON.stringify(commands, null, 2)}\n`);
assert.equal(result.summary.status, "completed", "Actual durable scheduler must complete the V4 node.");
const outputs = await created.store.outputs(created.runId); assert.ok(outputs);
const output = ProjectRenderOutputSchemaV4.parse((outputs.outputs as Record<string, unknown>).render);
const receipt = ProjectSpatialRenderReceiptV1Schema.parse(JSON.parse(await fs.readText(output.receipt.path, output.receipt.bytes)));
assert.equal(receipt.execution.run.runId, created.runId); assert.equal(receipt.timing.frameCount, 24);
assert.deepEqual(receipt.timing.frameRate, frameRate); assert.ok(["38438", "38439"].includes(receipt.timing.audio.durationTs));
assert.equal(await fs.readText("project.json"), headText); assert.equal(await fs.readText("edits/current.json"), currentPlanText);
const nativeOutput = join(projectDirectory, output.output.path);
const decodedPath = join(root, "decoded-audio.f32le");
await run([ffmpeg, "-v", "error", "-nostdin", "-i", nativeOutput, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-c:a", "pcm_f32le", "-f", "f32le", decodedPath]);
const decoded = await readFile(decodedPath);
const tonalChecks = [.15, .40, .55, .70].map((center, index) => {
  const target = [431, 701, 997, 1291][index]!, length = 1920, start = Math.round((center - .02) * sampleRate);
  const powers = frequencies.map(frequency => {
    let sine = 0, cosine = 0;
    for (let n = 0; n < length; n++) { const value = decoded.readFloatLE((start + n) * 4); sine += value * Math.sin(2 * Math.PI * frequency * n / sampleRate); cosine += value * Math.cos(2 * Math.PI * frequency * n / sampleRate); }
    return Math.hypot(sine, cosine) / length;
  });
  const wanted = powers[frequencies.indexOf(target)]!;
  assert.ok(wanted > .08 && wanted > 5 * Math.max(...powers.filter((_, frequencyIndex) => frequencies[frequencyIndex] !== target)), "Decoded audio must preserve source-clock cut and speed exactly once.");
  return { center, targetHz: target, amplitudes: powers };
});
const frameChecks = [];
for (const index of [1, 4]) {
  const framePath = join(root, `frame-${index}.png`);
  await run([ffmpeg, "-v", "error", "-nostdin", "-i", nativeOutput, "-vf", `select=eq(n\\,${index})`, "-frames:v", "1", framePath]);
  const { data, info } = await sharp(framePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (12 * info.width + 12) * info.channels;
  assert.ok(data[offset + 1]! > 180 && data[offset + 1]! > data[offset]! + 100 && data[offset + 1]! > data[offset + 2]! + 100, "Retained green overlay must appear above scene and legacy footage.");
  let saturated = 0;
  for (let pixel = 0; pixel < data.length; pixel += info.channels) if (Math.max(data[pixel]!, data[pixel + 1]!, data[pixel + 2]!) - Math.min(data[pixel]!, data[pixel + 1]!, data[pixel + 2]!) > 65) saturated++;
  frameChecks.push({ index, saturated, framePath });
}
assert.ok(frameChecks[1]!.saturated > frameChecks[0]!.saturated + 100, "Authored colored scene shot must appear over retained grayscale footage at its source-clock placement.");
const beforeResumeCommands = commands.length;
const resumed = await runWorkflow({ application, registry, runId: created.runId, store: created.store, jobs: 1 });
assert.equal(resumed.summary.status, "completed"); assert.equal(commands.slice(beforeResumeCommands).filter(command => command.argv.includes("-filter_complex_script")).length, 0);
const recovered = await reconcileProjectRenderV4(application, input, receipt.execution.run, { abortSignal: new AbortController().signal, beforePublication: async () => {} });
assert.deepEqual(recovered, { kind: "completed", output });
assert.equal(await fs.readText("project.json"), headText); assert.equal(await fs.readText("edits/current.json"), currentPlanText);
console.log(JSON.stringify({ event: "project-qualification-compositor-verified", runId: created.runId, frameCount: receipt.timing.frameCount, tonalChecks, frameChecks }));
await writeFile(join(root, "compositor-report.json"), `${JSON.stringify({
  scope: "independently prepared V4 compositor; CLI preparation not yet qualified",
  runId: created.runId, output, timing: receipt.timing, tonalChecks, frameChecks,
  resumedWithoutEncode: true, reconciled: true, projectHeadAndLegacyPlanUnchanged: true,
  commands,
}, null, 2)}\n`);
// Exercise the production preparation adapter after independently qualifying its
// exact compositor inputs. This starts one genuine six-frame browser render.
const browserCommand = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
capabilities.push({ name: "html-browser", available: true, command: browserCommand, version: (await run([browserCommand, "--version"])).trim() });
const actualRenderer = new PlaywrightHtmlOverlayRenderer({ cacheRoot: join(root, "cli-browser-cache"), browserStepTimeoutMs: 60_000, frameTimeoutMs: 30_000 });
let preparedBrowserFrames = 0;
const prepareApplication: ApplicationContext = { ...application, htmlOverlayRenderer: { async renderFrames(value, signal) {
  const rendered = await actualRenderer.renderFrames(value, signal); preparedBrowserFrames += rendered.frameCount; return rendered;
} } };
const prepareRequestPath = join(root, "prepare-request.json"), preparedDeliveryPath = join(root, "cli-prepared-render.json");
await writeFile(prepareRequestPath, `${canonicalJson({ project: projectId, expected: snapshot.basis, profile: projected.projection.output,
  policy: projected.projection.policy, delivery: { output: { path: "renders/cli-qualified.mp4", maximumBytes: 16 * 1024 * 1024 }, syncPolicy: "require-verified", tier: "final" } })}\n`);
const prepareCommand = { kind: "spatial-project" as const, action: "prepare-render" as const, project: projectId,
  input: relative(repositoryRoot, prepareRequestPath), output: relative(repositoryRoot, preparedDeliveryPath), json: true };
const coordinator = createDefaultHostResourceCoordinator();
console.log(JSON.stringify({ event: "project-qualification-cli-preparation", request: prepareRequestPath, preparedDelivery: preparedDeliveryPath }));
const cliPreparation = await coordinator.withLease(commandHostResourceClaims(prepareCommand, coordinator), async lease => {
  await lease.assertOwned();
  return await executeSpatialProjectCommand({ ...prepareApplication, hostResourceLease: {
    assertOwned: () => lease.assertOwned(), claims: lease.claims, inheritedFileDescriptor: lease.inheritedFileDescriptor,
    inheritedFileDescriptors: [lease.inheritedFileDescriptor], profile: lease.profile, ticket: lease.ticket,
  }, runner: { async run(argv, options = {}) {
    await lease.assertOwned();
    return await runner.run(argv, { ...options, inheritedFileDescriptors: [...new Set([...(options.inheritedFileDescriptors ?? []), lease.inheritedFileDescriptor])] });
  } } }, prepareCommand);
});
assert.equal(preparedBrowserFrames, 6, "Production CLI preparation must render exactly six genuine browser frames.");
const cliInput = await bindProjectRenderInputV4(application, JSON.parse(await repositoryFileSystem.readText(relative(repositoryRoot, preparedDeliveryPath), 16 * 1024 * 1024)));
assert.deepEqual(cliInput.spatial.projection.shots[0]!.shot, shot);
assert.notEqual(cliInput.spatial.projection.shots[0]!.materialized.receiptSha256, sceneResult.receipt.sha256, "CLI preparation must retain its own genuine render receipt.");
const cliPlanned = await planBuiltInWorkflow({ application, registry, workflow, workflowInput: cliInput });
const cliCreated = await createWorkflowRun({ application, registry, ...cliPlanned, graphPlan: cliPlanned.plan, sourceLocator: "builtin:directed-scene@1" });
console.log(JSON.stringify({ event: "project-qualification-cli-workflow", runId: cliCreated.runId, graphPlanSha256: cliPlanned.plan.graphPlanSha256, preparedBrowserFrames }));
const cliRun = await runWorkflow({ application, registry, runId: cliCreated.runId, store: cliCreated.store, jobs: 1, hostResourceCoordinator: coordinator });
await writeFile(join(root, "cli-scheduler-result.json"), `${JSON.stringify(cliRun, null, 2)}\n`);
assert.equal(cliRun.summary.status, "completed");
const cliOutputs = await cliCreated.store.outputs(cliCreated.runId); assert.ok(cliOutputs);
const cliOutput = ProjectRenderOutputSchemaV4.parse((cliOutputs.outputs as Record<string, unknown>).render);
const cliReceipt = ProjectSpatialRenderReceiptV1Schema.parse(JSON.parse(await fs.readText(cliOutput.receipt.path, cliOutput.receipt.bytes)));
assert.equal(cliReceipt.timing.frameCount, 24); assert.deepEqual(cliReceipt.timing.frameRate, frameRate);
const cliNativeOutput = join(projectDirectory, cliOutput.output.path), cliDecodedPath = join(root, "cli-decoded-audio.f32le");
await run([ffmpeg, "-v", "error", "-nostdin", "-i", cliNativeOutput, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-c:a", "pcm_f32le", "-f", "f32le", cliDecodedPath]);
assert.deepEqual(await readFile(cliDecodedPath), decoded, "CLI preparation and final composition preserve the independently qualified cut/speed audio.");
for (const frame of frameChecks) {
  const actualPath = join(root, `cli-frame-${frame.index}.png`);
  await run([ffmpeg, "-v", "error", "-nostdin", "-i", cliNativeOutput, "-vf", `select=eq(n\\,${frame.index})`, "-frames:v", "1", actualPath]);
  assert.deepEqual(await sharp(actualPath).raw().toBuffer(), await sharp(frame.framePath).raw().toBuffer(), "Actual CLI preparation must preserve the qualified scene, source clock and overlay pixels.");
}
assert.equal(await fs.readText("project.json"), headText); assert.equal(await fs.readText("edits/current.json"), currentPlanText);
const report = { kind: "atet.spatial-project-qualification", schemaVersion: 1, passed: true, sourceReport: sourceReportPath, sourceSceneRender: sceneResult,
  qualificationScriptSha256: hash(await readFile(import.meta.path)),
  projectId, runId: created.runId, graphPlanSha256: planned.plan.graphPlanSha256, applicationBuild: planned.plan.runtime.applicationBuild,
  output, receipt, projection: projected.projection, cadence, baseProbe, tonalChecks, frameChecks, commands,
  productionPreparation: { preparedBrowserFrames, result: cliPreparation, request: prepareRequestPath, preparedDelivery: preparedDeliveryPath,
    runId: cliCreated.runId, graphPlanSha256: cliPlanned.plan.graphPlanSha256, output: cliOutput, receipt: cliReceipt },
  measurements: { elapsedMilliseconds: performance.now() - started, processMemory: process.memoryUsage(), processResourceUsage: process.resourceUsage() },
  machine: { model: cpus()[0]?.model, cores: cpus().length, memoryBytes: totalmem(), architecture: arch(), kernel: release() },
  limits: ["320×180 actual mixed shot, 1.001 s retained source program, 0.8008 s final compositor. This does not replace the 15 s 1080p or ten-minute cadence qualifications.",
    "The first compositor uses an exact retained shot receipt. The second runs production CLI preparation with six new browser frames and compares decoded audio/pixels. Both run the real builtin scheduler, actual FFmpeg and preserve V2 authority."] };
await writeFile(join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ passed: true, report: join(root, "report.json"), runId: created.runId, frames: receipt.timing.frameCount }, null, 2));
