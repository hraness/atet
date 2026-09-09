import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { dirname, join, posix, relative } from "node:path";

import { z } from "zod";

import { createBoundedJsonValueSnapshot } from "../../../../src/code/json-snapshot";
import { SPATIAL_SCENE_LIMITS, SpatialAssetIdSchema, SpatialDigestSchema } from "../../../../src/spatial-scene/contracts";
import { parseSpatialScene, spatialSceneSha256 } from "../../../../src/spatial-scene/identity";
import { spatialAssetClosureDigests } from "../../../../src/spatial-scene/identity";
import { evaluateSpatialScene } from "../../../../src/spatial-scene/evaluate";
import { ensurePhysicalPrivateDirectoryWithin } from "../../cli/paths";
import { canonicalJson, canonicalJsonSha256, sha256Hex } from "../../core/canonical-json";
import { createNodeSpatialDurability } from "../../core/spatial-durability";
import { createNodeBundleFileSystem, saveImmutableText } from "../../core/storage";
import { createSpatialOverlayBatch, PreparedSpatialAssetSchema, SPATIAL_OVERLAY_LIMITS } from "../../html-overlay/spatial";
import { assertHtmlOverlayGpuEvidenceProfile, HtmlOverlayGpuEvidenceSchema } from "../../html-overlay/execution-profile";
import { createHtmlOverlayExecutionBundle, HtmlOverlayExecutionIntegritySchema } from "../html-overlay-integrity";
import { exactCapabilityByName } from "../capability-binding";
import type { ApplicationContext } from "../context";
import { ApplicationError } from "../errors";
import { bindHtmlOverlayBrowserRuntime, HtmlOverlayBrowserRuntimeBindingSchema } from "../html-overlay-browser-runtime";
import type { OperationDefinition, OperationExecutionContext } from "../operation";
import { writeOperationCompletionCheckpoint } from "../operation-completion-checkpoint";
import { SpatialRenderRequestSchema, SpatialRenderOutputSchema, SpatialRenderReceiptSchema, SpatialRenderFailure, SPATIAL_RENDER_LIMITS, renderSpatialScene, planSpatialRender, verifySpatialEncodedVideo, spatialRenderCapabilityNames } from "../spatial-render";
import type { OperationCheckpointExecutionIdentity } from "../operation-completion-checkpoint";
import { MediaCapabilityBindingsSchema, bindExpectedMediaCapabilities } from "./media/capabilities";
import {
  MediaArtifactReferenceSchema, MediaArtifactRequestSchema, bindRepositoryMedia, loadRepositoryMedia,
  createMediaOperationWorkspace, publishContentAddressedMedia, type MediaArtifactReference, type MediaOperationWorkspace,
} from "./media/shared";
import { throwIfAborted } from "./shared";

const MAXIMUM_ASSET_BYTES = 256 * 1024 * 1024;
const AssetBindingSchema = z.strictObject({ assetId: SpatialAssetIdSchema, artifact: MediaArtifactReferenceSchema });
const requestShape = z.strictObject({
  source: MediaArtifactRequestSchema,
  assets: z.array(AssetBindingSchema).max(SPATIAL_SCENE_LIMITS.assets).optional(),
  request: SpatialRenderRequestSchema,
  sceneSha256: SpatialDigestSchema.optional(),
  capabilityBindings: MediaCapabilityBindingsSchema.optional(),
  browserRuntime: HtmlOverlayBrowserRuntimeBindingSchema.optional(),
});
const captured = (input: unknown) => createBoundedJsonValueSnapshot(input, 16 * 1024 * 1024, "spatial render request", { maximumDepth: 48, maximumValues: 500_000 }).value;
export const SpatialRenderInputSchema = z.preprocess(captured, requestShape);
export const BoundSpatialRenderInputSchema = z.preprocess(captured, requestShape.extend({
  source: MediaArtifactReferenceSchema,
  assets: z.array(AssetBindingSchema).max(SPATIAL_SCENE_LIMITS.assets),
  sceneSha256: SpatialDigestSchema,
  capabilityBindings: MediaCapabilityBindingsSchema,
  browserRuntime: HtmlOverlayBrowserRuntimeBindingSchema,
}));
export type SpatialRenderInput = z.infer<typeof SpatialRenderInputSchema>;
export type BoundSpatialRenderInput = z.infer<typeof BoundSpatialRenderInputSchema>;

function sourceDocument(data: Uint8Array) {
  try { return parseSpatialScene(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data))); }
  catch (error) { throw new ApplicationError("invalid-data", `Invalid spatial source: ${error instanceof Error ? error.message : String(error)}`); }
}

/** The source grants access only to its bounded, root-contained declared closure. */
export async function bindSpatialRenderInput(application: ApplicationContext, input: unknown, signal = new AbortController().signal, bindRuntime: typeof bindHtmlOverlayBrowserRuntime = bindHtmlOverlayBrowserRuntime): Promise<BoundSpatialRenderInput> {
  const parsed = SpatialRenderInputSchema.parse(input);
  const source = await loadRepositoryMedia(application, parsed.source, signal, SPATIAL_SCENE_LIMITS.sourceBytes);
  const scene = sourceDocument(source.data);
  const plan = planSpatialRender(scene, parsed.request);
  const sceneSha256 = spatialSceneSha256(scene);
  if (parsed.sceneSha256 !== undefined && parsed.sceneSha256 !== sceneSha256) throw new ApplicationError("conflict", "Scene source changed after planning.");
  if (scene.assets.reduce((sum, asset) => sum + asset.payload.bytes, 0) > MAXIMUM_ASSET_BYTES) throw new ApplicationError("invalid-data", "Scene asset closure exceeds 256 MiB.");
  const supplied = parsed.assets === undefined ? undefined : new Map(parsed.assets.map(item => [item.assetId, item.artifact]));
  if (supplied !== undefined && (supplied.size !== parsed.assets!.length || supplied.size !== scene.assets.length || scene.assets.some(asset => !supplied.has(asset.assetId)))) throw new ApplicationError("invalid-data", "Asset bindings must name every declared asset exactly once.");
  const assets: z.infer<typeof AssetBindingSchema>[] = [];
  for (const asset of scene.assets) {
    const request = supplied?.get(asset.assetId) ?? {
      ...asset.payload, path: posix.join(posix.dirname(source.artifact.path), asset.payload.path),
    };
    if (request.sha256 !== asset.payload.sha256 || request.bytes !== asset.payload.bytes) throw new ApplicationError("conflict", `Asset ${asset.assetId} does not match its source manifest.`);
    const bound = await bindRepositoryMedia(application, request, signal, asset.payload.bytes);
    assets.push({ assetId: asset.assetId, artifact: bound.artifact });
  }
  const capabilityBindings = await bindExpectedMediaCapabilities(application, spatialRenderCapabilityNames(plan), parsed.capabilityBindings);
  const browserRuntime = await bindRuntime(exactCapabilityByName(capabilityBindings, "html-browser"), signal);
  if (parsed.browserRuntime !== undefined && canonicalJson(parsed.browserRuntime) !== canonicalJson(browserRuntime)) throw new ApplicationError("conflict", "Browser runtime changed after scene planning.");
  return BoundSpatialRenderInputSchema.parse({ ...parsed, source: source.artifact, assets, sceneSha256, capabilityBindings, browserRuntime });
}

async function writePrivateFile(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

const definitionIdentity = {
  kind: "scene.render", version: 1,
  inputSchemaId: "atet.operation.scene.render.input/v1", outputSchemaId: "atet.operation.scene.render.output/v1",
} as const;

const ATTEMPT_FILE = "spatial-render-attempt.v1.json";
const RESULT_FILE = "spatial-render-result.v1.json";
const MAXIMUM_MARKER_BYTES = 2 * 1024 * 1024;
const executionIdentitySchema = z.strictObject({
  kind: z.literal("scene.render"), version: z.literal(1),
  inputSchemaId: z.literal(definitionIdentity.inputSchemaId), outputSchemaId: z.literal(definitionIdentity.outputSchemaId),
  nodeKey: z.string().min(1).max(255), nodePlanSha256: SpatialDigestSchema, runId: z.string().min(1).max(256),
});
const markerBase = { schemaVersion: z.literal(1), identity: executionIdentitySchema, inputSha256: SpatialDigestSchema };
const attemptSchema = z.strictObject({ ...markerBase, kind: z.literal("atet.spatial-render-operation-attempt"), originalSceneArtifact: MediaArtifactReferenceSchema });
const resultSchema = z.strictObject({ ...markerBase, kind: z.literal("atet.spatial-render-operation-result"), output: SpatialRenderOutputSchema });

/** Trusted test ports are never part of a serialized render request. */
export interface SpatialRenderOperationDependencies {
  readonly bindBrowserRuntime?: typeof bindHtmlOverlayBrowserRuntime;
  readonly createWorkspace?: typeof createMediaOperationWorkspace;
  readonly createDirectory?: typeof mkdtemp;
  readonly removeDirectory?: (path: string) => Promise<void>;
  readonly publishOriginal?: typeof publishContentAddressedMedia;
  readonly render?: typeof renderSpatialScene;
  readonly checkpoint?: typeof writeOperationCompletionCheckpoint;
}
function originalArtifact(application: ApplicationContext, source: MediaArtifactReference): MediaArtifactReference {
  return MediaArtifactReferenceSchema.parse({ bytes: source.bytes, sha256: source.sha256,
    path: relative(application.paths.repositoryRoot, join(dirname(application.paths.artifactRoot), "generated/media-operations/outputs", `${source.sha256}.json`)) });
}
function operationIdentity(context: OperationExecutionContext) {
  const workflow = context.workflow;
  return workflow === undefined ? undefined : executionIdentitySchema.parse({ ...definitionIdentity,
    nodeKey: workflow.nodeKey, nodePlanSha256: workflow.nodePlanSha256, runId: workflow.runId });
}
async function immutableMarker(application: ApplicationContext, workspace: string, path: string, value: unknown): Promise<"created" | "exists"> {
  const text = `${canonicalJson(value)}\n`;
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAXIMUM_MARKER_BYTES) throw new ApplicationError("invalid-data", "Spatial render recovery marker exceeds its byte budget.");
  const digest = sha256Hex(text);
  const disposition = await saveImmutableText(createNodeBundleFileSystem(workspace), path, text, digest);
  await createNodeSpatialDurability(application.paths.repositoryRoot).syncExactFile(relative(application.paths.repositoryRoot, join(workspace, path)), { bytes, sha256: digest });
  return disposition;
}

export async function executeSpatialRender(context: OperationExecutionContext, input: SpatialRenderInput, dependencies: SpatialRenderOperationDependencies = {}) {
  if (context.workflow !== undefined) BoundSpatialRenderInputSchema.parse(input);
  const bound = await bindSpatialRenderInput(context.application, input, context.abortSignal, dependencies.bindBrowserRuntime);
  const source = await loadRepositoryMedia(context.application, bound.source, context.abortSignal, SPATIAL_SCENE_LIMITS.sourceBytes);
  const scene = sourceDocument(source.data);
  const identity = operationIdentity(context), inputSha256 = canonicalJsonSha256(bound);
  let workspace: MediaOperationWorkspace | undefined, directory: string | undefined;
  let completed: z.infer<typeof SpatialRenderOutputSchema> | undefined, uncertainPublication: MediaArtifactReference | undefined;
  let stage = "preparation", failure: unknown, failed = false, resultRetentionAttempted = false;
  const cleanupErrors: unknown[] = [], retained: MediaArtifactReference[] = [];
  const beforePublication = async () => {
    await context.application.hostResourceLease?.assertOwned();
    throwIfAborted(context.abortSignal);
  };
  try {
    workspace = await (dependencies.createWorkspace ?? createMediaOperationWorkspace)(context);
    if (identity !== undefined) {
      await context.workflow!.beforePublication();
      await beforePublication();
      const disposition = await immutableMarker(context.application, workspace.path, ATTEMPT_FILE, attemptSchema.parse({
        kind: "atet.spatial-render-operation-attempt", schemaVersion: 1, identity, inputSha256,
        originalSceneArtifact: originalArtifact(context.application, source.artifact),
      }));
      if (disposition === "exists") throw new ApplicationError("ambiguous", "This exact spatial render attempt already started; reconcile its retained evidence instead of rendering again.");
    }
    directory = await (dependencies.createDirectory ?? mkdtemp)(join(workspace.path, "spatial-source-"));
    const assetRoot = await ensurePhysicalPrivateDirectoryWithin(directory, "assets");
    const writtenPaths = new Map<string, string>();
    for (const asset of scene.assets) {
      const artifact = bound.assets.find(item => item.assetId === asset.assetId)!.artifact;
      const loaded = await loadRepositoryMedia(context.application, artifact, context.abortSignal, asset.payload.bytes);
      const previous = writtenPaths.get(asset.payload.path);
      if (previous !== undefined) {
        if (previous !== artifact.sha256) throw new ApplicationError("conflict", "Two scene assets declare different bytes at one path.");
        continue;
      }
      const parent = dirname(asset.payload.path);
      if (parent !== ".") await ensurePhysicalPrivateDirectoryWithin(assetRoot, parent);
      await writePrivateFile(join(assetRoot, asset.payload.path), loaded.data);
      writtenPaths.set(asset.payload.path, artifact.sha256);
    }
    const originalPath = join(directory, "original.scene.json");
    await writePrivateFile(originalPath, source.data);
    stage = "source-publication";
    uncertainPublication = originalArtifact(context.application, source.artifact);
    const originalSceneArtifact = (await (dependencies.publishOriginal ?? publishContentAddressedMedia)({ context, beforePublication, extension: ".json", stagedPath: originalPath, maximumBytes: SPATIAL_SCENE_LIMITS.sourceBytes })).artifact;
    if (canonicalJson(originalSceneArtifact) !== canonicalJson(uncertainPublication)) throw new ApplicationError("incompatible", "Published original spatial source differs from its prospective content address.");
    await createNodeSpatialDurability(context.application.paths.repositoryRoot).syncExactFile(originalSceneArtifact.path, originalSceneArtifact);
    retained.push(originalSceneArtifact);
    uncertainPublication = undefined;
    stage = "render";
    completed = SpatialRenderOutputSchema.parse(createBoundedJsonValueSnapshot(await (dependencies.render ?? renderSpatialScene)(context, {
      scene, assetRoot, request: bound.request, originalSceneArtifact,
      capabilityBindings: bound.capabilityBindings, browserRuntime: bound.browserRuntime,
    }), MAXIMUM_MARKER_BYTES, "completed spatial render").value);
    stage = "checkpoint";
    if (identity !== undefined) {
      resultRetentionAttempted = true;
      await immutableMarker(context.application, workspace.path, RESULT_FILE, resultSchema.parse({
        kind: "atet.spatial-render-operation-result", schemaVersion: 1, identity, inputSha256, output: completed,
      }));
    }
    await (dependencies.checkpoint ?? writeOperationCompletionCheckpoint)(context, definitionIdentity, completed);
  } catch (error) {
    failure = error; failed = true;
    if (error instanceof SpatialRenderFailure) {
      uncertainPublication ??= error.evidence.uncertainPublication;
      if (completed === undefined && error.evidence.completion !== undefined) completed = SpatialRenderOutputSchema.parse(createBoundedJsonValueSnapshot(error.evidence.completion, MAXIMUM_MARKER_BYTES, "spatial failure completion").value);
    }
    if (completed !== undefined && identity !== undefined && workspace !== undefined && !resultRetentionAttempted) {
      // Retain a service completion even when its own cleanup failed. This is
      // immutable evidence publication, never render or provider replay.
      resultRetentionAttempted = true;
      try { await immutableMarker(context.application, workspace.path, RESULT_FILE, resultSchema.parse({
        kind: "atet.spatial-render-operation-result", schemaVersion: 1, identity, inputSha256, output: completed,
      })); } catch (settlementError) { cleanupErrors.push(settlementError); }
    }
  }
  finally {
    if (directory !== undefined) try { await (dependencies.removeDirectory ?? (async path => { await rm(path, { recursive: true, force: true }); }))(directory); } catch (error) { cleanupErrors.push(error); }
    if (workspace !== undefined) try { await workspace.dispose(); } catch (error) { cleanupErrors.push(error); }
  }
  if (failed || cleanupErrors.length > 0) {
    const cause = cleanupErrors.length === 0 ? failure : new AggregateError([...(failed ? [failure] : []), ...cleanupErrors], "Spatial render operation failed during execution or cleanup.");
    const evidence = {
      stage: failed ? stage : "cleanup", retainedInputArtifacts: retained,
      ...(uncertainPublication === undefined ? {} : { uncertainPublication }), ...(completed === undefined ? {} : { completion: completed }),
      ...(identity === undefined || workspace === undefined ? {} : { attemptPath: relative(context.application.paths.repositoryRoot, join(workspace.path, ATTEMPT_FILE)) }),
      ...(failure instanceof ApplicationError ? { causeDetails: failure.details } : {}),
    };
    const error = new ApplicationError(uncertainPublication !== undefined || completed !== undefined ? "ambiguous" : failure instanceof ApplicationError ? failure.code : "internal",
      cause instanceof Error ? cause.message : "Spatial rendering failed.", { spatialRenderOperation: evidence, cleanupErrors: cleanupErrors.map(error => error instanceof Error ? error.message : String(error)) });
    error.cause = cause;
    throw error;
  }
  if (completed === undefined) throw new ApplicationError("internal", "Spatial rendering completed without an output.");
  return completed;
}

/** Missing durable attempt proves no publication was admitted; an existing attempt never authorizes replay. */
export async function recoverSpatialRenderAttempt(application: ApplicationContext, exactInput: unknown, identityInput: OperationCheckpointExecutionIdentity,
  workspaceDirectory: string, signal: AbortSignal): Promise<{ kind: "retry" } | { kind: "ambiguous"; message: string } | { kind: "completed"; output: z.infer<typeof SpatialRenderOutputSchema>; receiptReference: string; summary: { artifactSha256: string; frameCount: number } }> {
  throwIfAborted(signal);
  const input = BoundSpatialRenderInputSchema.parse(exactInput);
  const identity = executionIdentitySchema.parse(createBoundedJsonValueSnapshot(identityInput, 2_048, "spatial recovery identity").value);
  const workspace = await createMediaOperationWorkspace({ application, abortSignal: signal, workflow: { ...identity, workspaceDirectory, beforePublication: async () => { throw new ApplicationError("internal", "Read-only spatial attempt recovery must not publish."); } } });
  const fs = createNodeBundleFileSystem(workspace.path);
  const read = async (path: string) => {
    let text: string;
    try { text = await fs.readText(path, MAXIMUM_MARKER_BYTES); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
    const value = createBoundedJsonValueSnapshot(JSON.parse(text), MAXIMUM_MARKER_BYTES, "spatial recovery marker").value;
    if (text !== `${canonicalJson(value)}\n`) throw new ApplicationError("incompatible", "Spatial recovery marker is not canonical immutable JSON.");
    await createNodeSpatialDurability(application.paths.repositoryRoot).syncExactFile(relative(application.paths.repositoryRoot, join(workspace.path, path)), { bytes: new TextEncoder().encode(text).length, sha256: sha256Hex(text) });
    return value;
  };
  const attemptValue = await read(ATTEMPT_FILE);
  if (attemptValue === undefined) return { kind: "retry" };
  const attempt = attemptSchema.parse(attemptValue);
  if (canonicalJson(attempt.identity) !== canonicalJson(identity) || attempt.inputSha256 !== canonicalJsonSha256(input)
    || canonicalJson(attempt.originalSceneArtifact) !== canonicalJson(originalArtifact(application, input.source))) throw new ApplicationError("incompatible", "Spatial attempt belongs to another exact execution or input.");
  const resultValue = await read(RESULT_FILE);
  throwIfAborted(signal);
  if (resultValue === undefined) return { kind: "ambiguous", message: "Spatial rendering started but has no verified completion; preserve its original source and immutable artifacts. Automatic replay is disabled." };
  const result = resultSchema.parse(resultValue);
  if (canonicalJson(result.identity) !== canonicalJson(identity) || result.inputSha256 !== attempt.inputSha256) throw new ApplicationError("incompatible", "Spatial retained result belongs to another exact execution.");
  const output = await recoverSpatialRenderOutput(application, input, result.output, identity, signal);
  return { kind: "completed", output, receiptReference: output.receipt.path, summary: { artifactSha256: output.artifact.sha256, frameCount: output.render.frameCount } };
}

export const spatialRenderOperationDefinition = {
  ...definitionIdentity,
  inputSchema: SpatialRenderInputSchema, outputSchema: SpatialRenderOutputSchema,
  lifecycle: { kind: "local-artifact", execute: executeSpatialRender },
  policy: {
    cache: "exact-run", cancellable: true, effect: "local-derived-write", maxDurationMs: 900_000,
    maxFanOut: 0, maxInputBytes: 16 * 1024 * 1024, maxOutputBytes: 2 * 1024 * 1024,
    preparation: ["local-media"], resources: [
      { amount: 1, resource: "cpu" }, { amount: 1, resource: "local-io" }, { amount: 1, resource: "browser" },
      { amount: 1, resource: "ffmpeg" }, { amount: 1, resource: "output-publication" },
    ], resume: "verified-receipt",
  },
  receiptReference: output => output.receipt.path,
  summarize: output => ({ kind: "scene.render", fields: { artifactSha256: output.artifact.sha256, frameCount: output.render.frameCount } }),
} satisfies OperationDefinition<"scene.render", SpatialRenderInput, z.infer<typeof SpatialRenderOutputSchema>>;

/** Reconcile immutable evidence without reopening mutable original paths or rendering again. */
export async function recoverSpatialRenderOutput(application: ApplicationContext, exactInput: unknown, outputInput: unknown,
  identityInput: OperationCheckpointExecutionIdentity, signal: AbortSignal) {
  throwIfAborted(signal);
  const identity = executionIdentitySchema.parse(createBoundedJsonValueSnapshot(identityInput, 2_048, "spatial recovery identity").value);
  const input = BoundSpatialRenderInputSchema.parse(exactInput);
  const output = SpatialRenderOutputSchema.parse(createBoundedJsonValueSnapshot(outputInput, MAXIMUM_MARKER_BYTES, "spatial recovery output").value);
  const equal = (left: unknown, right: unknown, message: string) => {
    if (left === undefined || right === undefined) { if (left !== right) throw new ApplicationError("incompatible", message); return; }
    if (canonicalJson(left) !== canonicalJson(right)) throw new ApplicationError("incompatible", message);
  };
  const durability = createNodeSpatialDurability(application.paths.repositoryRoot);
  const readJson = async (artifact: z.infer<typeof MediaArtifactReferenceSchema>, maximumBytes: number) => {
    throwIfAborted(signal);
    const loaded = await loadRepositoryMedia(application, artifact, signal, maximumBytes);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(loaded.data);
    const value = createBoundedJsonValueSnapshot(JSON.parse(text), maximumBytes, "spatial immutable recovery JSON", { maximumDepth: 48, maximumValues: 2_000_000 }).value;
    if (text !== `${canonicalJson(value)}\n`) throw new ApplicationError("incompatible", "Spatial recovery artifact is not canonical immutable JSON.");
    await durability.syncExactFile(artifact.path, artifact);
    return value;
  };
  const receipt = SpatialRenderReceiptSchema.parse(await readJson(output.receipt, 1024 * 1024));
  equal(receipt.output, output.artifact, "Spatial checkpoint output differs from its receipt.");
  equal(receipt.source.canonicalScene, output.sceneSource, "Spatial canonical source differs from its receipt.");
  equal(receipt.source.retainedAssets, output.retainedAssets, "Spatial retained closure differs from its receipt.");
  equal(receipt.render, output.render, "Spatial render summary differs from its receipt.");
  equal(receipt.workflow, { nodeKey: identity.nodeKey, nodePlanSha256: identity.nodePlanSha256, runId: identity.runId }, "Spatial receipt belongs to another workflow node.");
  const original = receipt.source.originalSceneArtifact;
  if (original === undefined || original.sha256 !== input.source.sha256 || original.bytes !== input.source.bytes) throw new ApplicationError("incompatible", "Spatial receipt does not retain the exact original source bytes.");
  const originalScene = sourceDocument((await loadRepositoryMedia(application, original, signal, SPATIAL_SCENE_LIMITS.sourceBytes)).data);
  await durability.syncExactFile(original.path, original);
  const scene = parseSpatialScene(await readJson(output.sceneSource, SPATIAL_SCENE_LIMITS.sourceBytes + 1));
  equal(scene, originalScene, "Spatial canonical source disagrees with its original bytes.");
  const plan = planSpatialRender(scene, input.request);
  equal(receipt.sceneSha256, input.sceneSha256, "Spatial receipt is for another authored scene.");
  equal(plan.sceneSha256, input.sceneSha256, "Spatial source identity does not match the exact input.");
  equal(receipt.request, plan.request, "Spatial receipt has a different render request.");
  equal(receipt.requestSha256, plan.requestSha256, "Spatial request digest is invalid.");
  assertHtmlOverlayGpuEvidenceProfile(plan.request.executionProfile, receipt.runtime.gpuEvidence);
  equal(receipt.source.sourceManifests, spatialAssetClosureDigests(scene.assets), "Spatial manifest closure digest is invalid.");
  if (output.retainedAssets.length !== scene.assets.length || new Set(output.retainedAssets.map(asset => asset.assetId)).size !== scene.assets.length) throw new ApplicationError("incompatible", "Spatial retained asset closure is incomplete or duplicated.");
  if (input.assets.length !== scene.assets.length || new Set(input.assets.map(asset => asset.assetId)).size !== scene.assets.length) throw new ApplicationError("incompatible", "Bound spatial asset closure is incomplete or duplicated.");
  for (const manifest of scene.assets) {
    const asset = output.retainedAssets.find(item => item.assetId === manifest.assetId);
    const boundAsset = input.assets.find(item => item.assetId === manifest.assetId);
    if (asset === undefined || boundAsset === undefined || asset.originalPath !== manifest.payload.path
      || asset.manifestSha256 !== receipt.source.sourceManifests[manifest.assetId]
      || asset.artifact.sha256 !== manifest.payload.sha256 || asset.artifact.bytes !== manifest.payload.bytes
      || boundAsset.artifact.sha256 !== manifest.payload.sha256 || boundAsset.artifact.bytes !== manifest.payload.bytes) throw new ApplicationError("incompatible", "Spatial retained asset does not match its exact source.");
    await bindRepositoryMedia(application, asset.artifact, signal, manifest.payload.bytes);
    await durability.syncExactFile(asset.artifact.path, asset.artifact);
  }
  equal(await readJson(receipt.runtime.artifact, SPATIAL_RENDER_LIMITS.metadataBytes), input.browserRuntime, "Spatial runtime bytes differ from the exact input.");
  equal(receipt.runtime.rootSha256, input.browserRuntime.manifest.rootSha256, "Spatial runtime root differs from the exact input.");
  equal(receipt.runtime.capabilities, input.capabilityBindings, "Spatial native capabilities differ from the exact input.");
  equal(input.capabilityBindings.map(capability => capability.name), spatialRenderCapabilityNames(plan), "Spatial capabilities do not match the exact required capability set.");
  equal(receipt.calibratedSourceDimensions, { width: plan.width, height: plan.height }, "Spatial calibrated source dimensions differ from the plan.");
  equal(receipt.color, { output: plan.request.mode.kind === "beauty" ? "srgb" : "rgba8-data", alpha: plan.request.mode.kind === "beauty" ? "straight" : "binary-validity", toneMapping: "none" }, "Spatial output color evidence differs from the request.");
  equal(receipt.timing.outputDurationUs, plan.outputDurationUs, "Spatial output duration differs from the exact frame clock.");
  equal(receipt.contactSheet, plan.request.selection.kind === "contact-sheet" ? { fit: "contain", resampling: plan.request.mode.kind === "beauty" ? "lanczos3" : "nearest-data", calibratedProjectionResized: false } : undefined, "Spatial contact sheet policy differs from the exact request.");
  if (receipt.samples.length !== plan.samples.length || output.render.frameCount !== plan.samples.length
    || output.render.width !== plan.outputWidth || output.render.height !== plan.outputHeight || output.render.kind !== plan.request.selection.kind) throw new ApplicationError("incompatible", "Spatial output dimensions or sample count differ from the plan.");
  const evaluatedSample = (index: number) => {
    const sample = plan.samples[index]!;
    const evidence = receipt.samples[index]!;
    equal(evidence.sample, sample, "Spatial sample timestamp differs from its absolute clock.");
    const state = evaluateSpatialScene(scene, { cameraId: plan.request.cameraId, timeUs: sample.timeUs,
      ...(plan.request.overrides === undefined ? {} : { overrides: plan.request.overrides }),
      ...(plan.request.cameraPoseOverride === undefined ? {} : { cameraPoseOverride: plan.request.cameraPoseOverride }),
    });
    equal(evidence.stateSha256, state.stateSha256, "Spatial evaluated state differs from its authored source.");
    equal(evidence.viewSha256, state.viewSha256, "Spatial evaluated camera differs from its render request.");
    return state;
  };
  await bindRepositoryMedia(application, output.artifact, signal, plan.costs.outputBytesBound);
  await durability.syncExactFile(output.artifact.path, output.artifact);
  const batchSchema = z.strictObject({
    gpuEvidence: HtmlOverlayGpuEvidenceSchema.optional(),
    metadata: z.unknown(), metadataSha256: SpatialDigestSchema, executionIntegrity: HtmlOverlayExecutionIntegritySchema,
    libraryLocks: z.array(z.unknown()).min(1).max(3), preparedAssets: z.array(PreparedSpatialAssetSchema).max(SPATIAL_OVERLAY_LIMITS.preparedAssets),
    preparation: z.strictObject({ kind: z.literal("atet.spatial-asset-preparation"), schemaVersion: z.literal(1), sourceManifests: z.record(SpatialAssetIdSchema, SpatialDigestSchema),
      preparedSha256: SpatialDigestSchema, sourceBytes: z.number().int().safe().min(0).max(MAXIMUM_ASSET_BYTES), outputBytes: z.number().int().safe().min(0).max(MAXIMUM_ASSET_BYTES), profiles: z.array(z.string().min(1).max(256)).max(1_024) }),
    samples: SpatialRenderReceiptSchema.shape.samples,
  });
  if ((plan.request.executionProfile === undefined && receipt.batches.length !== Math.ceil(plan.samples.length / SPATIAL_RENDER_LIMITS.batchFrames))
    || new Set(receipt.batches.map(batch => batch.path)).size !== receipt.batches.length) throw new ApplicationError("incompatible", "Spatial batch partitions are incomplete or duplicated.");
  let metadataBytes = 0, offset = 0;
  for (const artifact of receipt.batches) {
    metadataBytes += artifact.bytes;
    if (metadataBytes > SPATIAL_RENDER_LIMITS.metadataBytes) throw new ApplicationError("incompatible", "Spatial batch closure exceeds its total metadata budget.");
    const batch = batchSchema.parse(await readJson(artifact, SPATIAL_RENDER_LIMITS.metadataBytes));
    const length = plan.request.executionProfile === undefined ? Math.min(SPATIAL_RENDER_LIMITS.batchFrames, plan.samples.length - offset) : batch.samples.length;
    if (length < 1 || length > SPATIAL_RENDER_LIMITS.batchFrames || offset + length > plan.samples.length
      || Math.floor(offset / SPATIAL_RENDER_LIMITS.batchFrames) !== Math.floor((offset + length - 1) / SPATIAL_RENDER_LIMITS.batchFrames)) throw new ApplicationError("incompatible", "Spatial batch crosses its exact bounded preparation window.");
    const snapshots = plan.samples.slice(offset, offset + length).map((_, index) => evaluatedSample(offset + index));
    const expectedBatch = createSpatialOverlayBatch({ snapshots,
      ...(plan.request.executionProfile === undefined ? {} : { executionProfile: plan.request.executionProfile }),
      mode: plan.request.mode, frameRate: plan.request.selection.kind === "video" ? plan.request.selection.frameRate : { numerator: 1, denominator: 1 }, preparedAssets: batch.preparedAssets });
    equal(batch.metadata, expectedBatch.metadata, "Spatial batch metadata differs from the exact scene samples.");
    equal(batch.metadataSha256, expectedBatch.metadataSha256, "Spatial batch metadata digest is invalid.");
    const execution = createHtmlOverlayExecutionBundle(expectedBatch.authoring, input.browserRuntime, plan.request.executionProfile);
    assertHtmlOverlayGpuEvidenceProfile(plan.request.executionProfile, batch.gpuEvidence);
    equal(batch.gpuEvidence, receipt.runtime.gpuEvidence, "Spatial batch hardware identity differs from its completion receipt.");
    equal(batch.executionIntegrity, execution.integrity, "Spatial batch execution integrity differs from its exact authored runtime.");
    equal(batch.libraryLocks, execution.libraryLocks, "Spatial batch library locks differ from the qualified runtime.");
    equal(batch.samples, receipt.samples.slice(offset, offset + length), "Spatial batch sample partition differs from the completion receipt.");
    equal(batch.preparation.sourceManifests, receipt.source.sourceManifests, "Spatial batch source manifest closure is invalid.");
    equal(batch.preparation.preparedSha256, canonicalJsonSha256(batch.preparedAssets), "Spatial batch prepared content digest is invalid.");
    equal(batch.preparation.sourceBytes, scene.assets.reduce((sum, asset) => sum + asset.payload.bytes, 0), "Spatial batch source byte count is invalid.");
    if (plan.request.executionProfile !== undefined) equal(batch.preparation.outputBytes, expectedBatch.authoring.resources.reduce((sum, resource) => sum + resource.bytes, 0), "Spatial batch prepared resource byte count is invalid.");
    offset += length;
  }
  if (offset !== plan.samples.length) throw new ApplicationError("incompatible", "Spatial batch partitions do not cover every exact sample.");
  equal(receipt.costs, { ...plan.costs, actualPngBytes: receipt.samples.reduce((sum, sample) => sum + sample.pngBytes, 0), actualBatchMetadataBytes: metadataBytes }, "Spatial receipt costs differ from its exact retained artifact counts.");
  if (receipt.costs.actualPngBytes > plan.costs.pngBytesBound || receipt.samples.some(sample => sample.pngBytes < 1)) throw new ApplicationError("incompatible", "Spatial frame byte accounting exceeds the admitted bound.");
  for (const [index, artifact] of receipt.frameArtifacts.entries()) {
    await bindRepositoryMedia(application, artifact, signal, plan.costs.pngBytesBound);
    await durability.syncExactFile(artifact.path, artifact);
    const sample = receipt.samples[index];
    if (sample === undefined || artifact.sha256 !== sample.pngSha256 || artifact.bytes !== sample.pngBytes) throw new ApplicationError("incompatible", "Retained frame differs from the rendered sample.");
  }
  if (plan.request.selection.kind === "frame") equal(output.artifact, receipt.frameArtifacts[0], "Primary spatial frame must equal its retained sample artifact.");
  if (plan.request.selection.kind === "video") {
    if (receipt.frameArtifacts.length !== 0) throw new ApplicationError("incompatible", "Spatial video must not claim unrelated retained frame artifacts.");
    if (receipt.encodedProbe === undefined) throw new ApplicationError("incompatible", "Spatial video lacks actual encoded evidence.");
    equal(verifySpatialEncodedVideo(plan, await readJson(receipt.encodedProbe, SPATIAL_RENDER_LIMITS.probeBytes)), output.render.encodedEvidence, "Spatial encoded timing evidence does not match the retained probe.");
  } else if (receipt.frameArtifacts.length !== plan.samples.length || receipt.encodedProbe !== undefined) throw new ApplicationError("incompatible", "Spatial raster output lacks exact retained frame evidence.");
  throwIfAborted(signal);
  return output;
}

export { SpatialRenderRequestSchema, SpatialRenderOutputSchema };
