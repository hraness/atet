import { join, relative } from "node:path";

import { z } from "zod";

import { createBoundedJsonValueSnapshot, deepFreezeJson } from "../../../src/code/json-snapshot";
import { SpatialDigestSchema, SpatialTimeUsSchema } from "../../../src/spatial-scene/contracts";
import { reduceSpatialFrameRate, spatialFrameCount } from "../../../src/spatial-scene/index";
import { VideoProjectIdSchema } from "../contracts/project";
import { RepositoryRelativePathSchema } from "../contracts/recording";
import { SPATIAL_COMPOSITOR_LIMITS } from "../contracts/spatial-compositor";
import { SpatialProjectBasisSchema } from "../contracts/spatial-project";
import { canonicalJson, canonicalJsonSha256, sha256Hex } from "../core/canonical-json";
import { hashProjectStructure } from "../core/project-plan";
import { compileProjectRenderPlan } from "../core/project-render-plan";
import { createNodeSpatialDurability, type SpatialDurabilityPort } from "../core/spatial-durability";
import { spatialProjectDocumentText, spatialShotSha256 } from "../core/spatial-project";
import { createNodeBundleFileSystem, type BundleFileSystem } from "../core/storage";
import { exactCapabilityByName } from "./capability-binding";
import { ApplicationError } from "./errors";
import { bindHtmlOverlayBrowserRuntime } from "./html-overlay-browser-runtime";
import type { OperationExecutionContext } from "./operation";
import { bindExpectedMediaCapabilities } from "./operations/media/capabilities";
import { type MediaArtifactReference } from "./operations/media/shared";
import { bindProjectRenderPlanInput } from "./operations/render/project-plan";
import { ProjectRenderSpatialBindingV1Schema } from "./operations/render/project-spatial-receipt";
import { throwIfAborted } from "./operations/shared";
import { hashProjectGeneration } from "./project-store";
import { hashProjectEditRevisionOutputGeometry, ProjectRenderPlanDocumentSchema, ProjectRenderPlanReferenceSchema, RenderableProjectEditRevisionReferenceSchema } from "./receipts";
import { createSpatialCompositorCadence } from "./spatial-compositor-cadence";
import { spatialProjectStorePorts } from "./spatial-project-authority";
import { readSpatialProjectAuthority } from "./spatial-project-store";
import { planSpatialRender, renderSpatialScene, SpatialRenderOutputSchema, SpatialRenderReceiptSchema, spatialRenderCapabilityNames, spatialShotRenderRequest, type SpatialRenderDependencies, type SpatialRenderPlan } from "./spatial-render";
import { createSpatialRenderProjection, SceneRenderProjectionV1Schema, SpatialMaterializedShotVideoSchema, SpatialProjectionOutputSchema, SpatialSceneProgramPolicySchema, type SpatialMaterializedShotVideo } from "./spatial-render-projection";

/** Whole-program admission, before any browser starts. Staging is conservatively summed even though shots render sequentially. */
export const SPATIAL_PROJECT_RENDER_PREPARATION_LIMITS = Object.freeze({
  shots: 64, frames: 1_800, pixels: 1_100_000_000, stagingBytes: 8 * 1024 ** 3,
  retainedVideoBytes: 1024 ** 3, sourceDocumentBytes: 2 * 1024 ** 2, sourceDocumentsBytes: 32 * 1024 ** 2,
  receiptBytes: 1024 ** 2, receiptsBytes: 16 * 1024 ** 2, outputDocumentBytes: 32 * 1024 ** 2,
});
const capture = (value: unknown, bytes: number, label: string) => createBoundedJsonValueSnapshot(value, bytes, label, { maximumDepth: 48, maximumValues: 1_000_000 }).value;
export const SpatialProjectRenderPreparationInputSchema = z.preprocess(value => capture(value, 64 * 1024, "spatial project render preparation input"), z.strictObject({
  project: VideoProjectIdSchema, expected: SpatialProjectBasisSchema,
  profile: SpatialProjectionOutputSchema, policy: SpatialSceneProgramPolicySchema,
}));
export const SpatialProjectRenderPreparationOutputSchema = z.preprocess(value => capture(value, SPATIAL_PROJECT_RENDER_PREPARATION_LIMITS.outputDocumentBytes, "spatial project render preparation output"), z.strictObject({
  sourceBasis: SpatialProjectBasisSchema, projection: SceneRenderProjectionV1Schema, projectionSha256: SpatialDigestSchema,
  materializedShots: z.array(SpatialMaterializedShotVideoSchema).max(SPATIAL_PROJECT_RENDER_PREPARATION_LIMITS.shots),
  revisionReference: RenderableProjectEditRevisionReferenceSchema, plan: ProjectRenderPlanReferenceSchema, spatial: ProjectRenderSpatialBindingV1Schema,
}).superRefine((value, context) => {
  if (value.sourceBasis.version !== 2 || value.sourceBasis.sha256 !== value.projection.source.projectRevisionSha256
    || value.projectionSha256 !== value.spatial.projectionSha256 || canonicalJson(value.projection) !== canonicalJson(value.spatial.projection)
    || canonicalJson(value.materializedShots) !== canonicalJson(value.projection.shots.map(shot => shot.materialized))
    || value.plan.planSha256 !== value.projection.compositionPlanSha256 || value.plan.revisionSha256 !== value.revisionReference.revisionSha256
    || value.revisionReference.revisionSha256 !== value.projection.derivedV1RevisionSha256
    || canonicalJson(value.revisionReference.artifact) !== canonicalJson(value.projection.derivedV1Revision)
    || value.plan.projectId !== value.projection.source.projectId || value.revisionReference.projectId !== value.plan.projectId) context.addIssue({ code: "custom", message: "Prepared render must preserve one exact source, projection, revision and plan identity." });
  if (value.plan.projectSha256 !== value.revisionReference.projectSha256 || value.plan.projectEditPlanSha256 !== value.revisionReference.projectEditPlanSha256
    || value.plan.outputGeometrySha256 !== value.revisionReference.outputGeometrySha256) context.addIssue({ code: "custom", message: "Prepared plan must retain the exact derived V1 project, edit plan and output geometry hashes." });
}));
export type SpatialProjectRenderPreparationInput = z.infer<typeof SpatialProjectRenderPreparationInputSchema>;
export type SpatialProjectRenderPreparationOutput = z.infer<typeof SpatialProjectRenderPreparationOutputSchema>;
/** Trusted host test seams only; neither ports nor renderer dependencies are accepted in the request. */
export interface SpatialProjectRenderPreparationDependencies {
  readonly renderDependencies?: SpatialRenderDependencies;
  readonly repositoryFileSystem?: BundleFileSystem;
  readonly durability?: SpatialDurabilityPort;
}
function checked(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ApplicationError("conflict", message);
}
function failureMessages(error: unknown, depth = 0): string[] {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 4_096);
  return error instanceof AggregateError && depth < 4
    ? [message, ...error.errors.slice(0, 16).flatMap(child => failureMessages(child, depth + 1))].slice(0, 32)
    : [message];
}
function verifyReceipt(plan: SpatialRenderPlan, result: z.infer<typeof SpatialRenderOutputSchema>, receipt: z.infer<typeof SpatialRenderReceiptSchema>, original: MediaArtifactReference) {
  checked(receipt.sceneSha256 === plan.sceneSha256 && receipt.requestSha256 === plan.requestSha256
    && canonicalJson(receipt.request) === canonicalJson(plan.request) && canonicalJson(receipt.samples.map(sample => sample.sample)) === canonicalJson(plan.samples)
    && canonicalJson(receipt.source.originalSceneArtifact) === canonicalJson(original)
    && canonicalJson(receipt.source.canonicalScene) === canonicalJson(result.sceneSource)
    && canonicalJson(receipt.source.retainedAssets) === canonicalJson(result.retainedAssets)
    && canonicalJson(receipt.render) === canonicalJson(result.render) && canonicalJson(receipt.output) === canonicalJson(result.artifact)
    && result.render.kind === "video" && result.render.frameCount === plan.samples.length
    && result.render.width === plan.width && result.render.height === plan.height
    && receipt.color.output === "srgb" && receipt.color.alpha === "straight"
    && receipt.calibratedSourceDimensions.width === plan.width && receipt.calibratedSourceDimensions.height === plan.height,
  "Rendered shot receipt does not bind its exact immutable source, request, samples and output.");
}

/** Materializes an immutable V2 camera program under caller-owned read custody. Never changes project.json or invents a workflow identity. */
export async function prepareSpatialProjectRender(context: OperationExecutionContext, input: unknown, dependencies: SpatialProjectRenderPreparationDependencies = {}): Promise<SpatialProjectRenderPreparationOutput> {
  const request = SpatialProjectRenderPreparationInputSchema.parse(input);
  if (request.expected.version !== 2 || request.policy.alpha !== "straight") throw new ApplicationError("unsupported-plan", "Spatial project preparation requires an exact V2 basis and the qualified straight-alpha qtrle profile.");
  const ports = await spatialProjectStorePorts(context.application, request.project);
  const projectDirectory = context.application.spatialProjectCustody!.projectDirectory;
  const repositoryRoot = context.application.paths.repositoryRoot;
  const repositoryFileSystem = dependencies.repositoryFileSystem ?? createNodeBundleFileSystem(repositoryRoot);
  const durability = dependencies.durability ?? createNodeSpatialDurability(repositoryRoot);
  const repositoryPath = (path: string) => RepositoryRelativePathSchema.parse(relative(repositoryRoot, join(projectDirectory, path)));
  const fence = async () => { await ports.custody.assertHeld(); await context.application.hostResourceLease?.assertOwned(); throwIfAborted(context.abortSignal); };
  const publicationFence = async () => { await context.workflow?.beforePublication(); await fence(); };
  await fence();
  const snapshot = await readSpatialProjectAuthority(ports);
  checked(snapshot.version === 2 && canonicalJson(snapshot.basis) === canonicalJson(request.expected), "Spatial project render preparation requires the exact current V2 project basis.");
  await fence();
  const profile = { ...request.profile, frameRate: reduceSpatialFrameRate(request.profile.frameRate) };
  const shots = [...snapshot.contents.shots].sort((a, b) => a.range.startUs - b.range.startUs || a.shotId.localeCompare(b.shotId));
  const limits = SPATIAL_PROJECT_RENDER_PREPARATION_LIMITS;
  const legacyPlan = snapshot.contents.legacy.projectEditPlan;
  if (legacyPlan.zooms.length > 0 || legacyPlan.effects.clicks.enabled || legacyPlan.effects.cursor.enabled
    || legacyPlan.effects.keystrokes.enabled || legacyPlan.effects.typedText.enabled) throw new ApplicationError("unsupported-plan",
    "Spatial project preparation does not yet retain recording metadata required by zooms, clicks, cursor, keystrokes or typedText effects. These effects cannot be projected yet.");
  // The final movie includes the whole frozen legacy timeline, even when its scene shots are tiny.
  // Compile cuts, base speed, segment speeds, layouts and camera bindings before any native work.
  const legacyRenderPlan = compileProjectRenderPlan(snapshot.contents.legacy.project, legacyPlan, {
    background: profile.background, pixelWidth: profile.pixelWidth, pixelHeight: profile.pixelHeight,
    frameRate: profile.frameRate.numerator / profile.frameRate.denominator,
  });
  checked(SpatialTimeUsSchema.safeParse(legacyRenderPlan.output.durationUs).success && legacyRenderPlan.output.durationUs > 0,
    "Full project output duration exceeds spatial compositor cadence admission.");
  checked(profile.frameRate.numerator <= 2_147_483_647 && profile.frameRate.denominator <= 2_147_483_647
    && spatialFrameCount(legacyRenderPlan.output.durationUs, profile.frameRate) <= SPATIAL_COMPOSITOR_LIMITS.frames,
  "Full project output exceeds the compositor frame or container cadence admission.");
  checked(snapshot.revision.scenes.every(scene => scene.artifact.bytes <= limits.sourceDocumentBytes)
    && snapshot.revision.scenes.reduce((bytes, scene) => bytes + scene.artifact.bytes, 0) <= limits.sourceDocumentsBytes,
  "Retained scene documents exceed the spatial compositor admission budget.");
  checked(shots.length <= limits.shots, "Spatial project exceeds the admitted total shot count.");
  let previousEnd = 0;
  const planned = shots.map(shot => {
    checked(shot.range.startUs >= previousEnd, "Full-frame camera-program preparation rejects overlapping shot ranges."); previousEnd = shot.range.endUs;
    const scene = snapshot.contents.scenes.find(source => source.sceneSha256 === shot.sceneSha256);
    const source = snapshot.revision.scenes.find(source => source.sceneSha256 === shot.sceneSha256);
    checked(scene !== undefined && source !== undefined && source.artifact.bytes <= limits.sourceDocumentBytes, "Shot source is absent or exceeds native source-document admission.");
    const plan = planSpatialRender(scene.document, spatialShotRenderRequest(shot, profile.frameRate, profile.executionProfile));
    checked(plan.width === profile.pixelWidth && plan.height === profile.pixelHeight, "Shot calibrated dimensions must match the requested profile; preparation does not resize cameras.");
    return { shot, plan, original: { ...source.artifact, path: repositoryPath(source.artifact.path) } };
  });
  const sum = (value: (plan: SpatialRenderPlan) => number) => planned.reduce((total, item) => total + value(item.plan), 0);
  checked(sum(plan => plan.samples.length) <= limits.frames && sum(plan => plan.costs.renderPixels) <= limits.pixels
    && sum(plan => plan.costs.stagingBytesBound) <= limits.stagingBytes && sum(plan => plan.costs.outputBytesBound) <= limits.retainedVideoBytes,
  "Spatial project exceeds aggregate frame, pixel, staging or retained-video admission.");
  const published: MediaArtifactReference[] = [], materializedShots: SpatialMaterializedShotVideo[] = [];
  let uncertainPublication: MediaArtifactReference | undefined, totalReceiptBytes = 0;
  const copy = async (source: MediaArtifactReference, path: string) => {
    checked(repositoryFileSystem.copyFileNoReplace !== undefined, "Repository storage requires immutable exact-copy publication.");
    const destination = { ...source, path: repositoryPath(path) };
    await publicationFence(); uncertainPublication = destination;
    await repositoryFileSystem.copyFileNoReplace(source.path, destination.path, source, publicationFence);
    await durability.syncExactFile(destination.path, destination);
    published.push(destination); uncertainPublication = undefined;
  };
  try {
    for (const { shot, plan, original } of planned) {
      await fence();
      const capabilityBindings = await bindExpectedMediaCapabilities(context.application, spatialRenderCapabilityNames(plan), undefined);
      const browserRuntime = await (dependencies.renderDependencies?.bindBrowserRuntime ?? bindHtmlOverlayBrowserRuntime)(exactCapabilityByName(capabilityBindings, "html-browser"), context.abortSignal);
      await fence();
      const result = SpatialRenderOutputSchema.parse(capture(await renderSpatialScene(context, { scene: plan.scene, assetRoot: projectDirectory, request: plan.request, originalSceneArtifact: original, capabilityBindings, browserRuntime }, dependencies.renderDependencies), limits.outputDocumentBytes, "rendered spatial shot"));
      // The service result remains useful evidence even if project-local installation subsequently fails.
      published.push(result.artifact, result.receipt, result.sceneSource, ...result.retainedAssets.map(asset => asset.artifact));
      totalReceiptBytes += result.receipt.bytes;
      checked(result.receipt.bytes <= limits.receiptBytes && totalReceiptBytes <= limits.receiptsBytes, "Retained shot receipts exceed the spatial compositor admission budget.");
      const receiptText = await repositoryFileSystem.readText(result.receipt.path, limits.receiptBytes);
      checked(Buffer.byteLength(receiptText) === result.receipt.bytes && sha256Hex(receiptText) === result.receipt.sha256, "Spatial shot receipt bytes changed after rendering.");
      const receipt = SpatialRenderReceiptSchema.parse(capture(JSON.parse(receiptText), limits.outputDocumentBytes, "spatial shot receipt"));
      verifyReceipt(plan, result, receipt, original);
      const encoded = result.render.encodedEvidence;
      checked(encoded !== undefined && encoded.colorSpace === "srgb" && canonicalJson(encoded.frameRate) === canonicalJson(profile.frameRate), "Shot encoding must retain the exact rational rate and straight-alpha color profile.");
      const artifact = { ...result.artifact, path: `spatial/outputs/${result.artifact.sha256}.mov` };
      await copy(result.artifact, artifact.path);
      await copy(result.receipt, `spatial/receipts/${result.receipt.sha256}.json`);
      materializedShots.push(SpatialMaterializedShotVideoSchema.parse({ shotId: shot.shotId, shotSha256: spatialShotSha256(shot), sceneSha256: shot.sceneSha256,
        receiptSha256: result.receipt.sha256, artifact, pixelWidth: plan.width, pixelHeight: plan.height, frameRate: encoded.frameRate,
        frameCount: encoded.frameCount, alpha: encoded.alpha, colorSpace: encoded.colorSpace, codec: encoded.codec, container: encoded.container, streamIndex: encoded.streamIndex }));
    }
    const derived = createSpatialRenderProjection({ snapshot, materializedShots, policy: request.policy, output: profile });
    checked(derived.renderPlan.output.durationUs === legacyRenderPlan.output.durationUs, "Spatial projection changed the preflighted legacy output clock.");
    const revisionText = spatialProjectDocumentText(derived.revision);
    const revisionArtifact = { ...derived.projection.derivedV1Revision, path: repositoryPath(derived.projection.derivedV1Revision.path) };
    checked(repositoryFileSystem.writeTextNoReplace !== undefined, "Repository storage requires immutable revision publication.");
    await publicationFence(); uncertainPublication = revisionArtifact;
    await repositoryFileSystem.writeTextNoReplace(revisionArtifact.path, revisionText, publicationFence);
    await durability.syncExactFile(revisionArtifact.path, revisionArtifact);
    published.push(revisionArtifact); uncertainPublication = undefined;
    const revisionReference = RenderableProjectEditRevisionReferenceSchema.parse({ kind: "atet.project-edit-revision-reference", schemaVersion: 1,
      artifact: derived.projection.derivedV1Revision, baseGeneration: hashProjectGeneration(derived.revision.project, derived.revision.projectEditPlan),
      outputGeometrySha256: hashProjectEditRevisionOutputGeometry({ ...profile, revisionSha256: derived.revision.revisionSha256 }),
      pixelWidth: profile.pixelWidth, pixelHeight: profile.pixelHeight, planId: derived.revision.projectEditPlan.planId, projectId: request.project,
      projectEditPlanSha256: derived.revision.projectEditPlanSha256, projectSha256: derived.revision.projectSha256,
      projectStructureSha256: hashProjectStructure(derived.revision.project), revisionSha256: derived.revision.revisionSha256 });
    const planInput = await bindProjectRenderPlanInput(context.application, { revision: revisionReference, settings: { background: profile.background, frameRate: profile.frameRate.numerator / profile.frameRate.denominator } });
    checked(planInput.metadataBindings?.length === 0, "Spatial projection cannot depend on mutable recording metadata.");
    // Preserve the prospective immutable plan address across publication/readback failures.
    const planDocument = ProjectRenderPlanDocumentSchema.parse({ kind: "atet.project-render-plan-document", schemaVersion: 1, plan: derived.renderPlan,
      outputGeometrySha256: revisionReference.outputGeometrySha256, projectEditPlanSha256: derived.revision.projectEditPlanSha256,
      projectSha256: derived.revision.projectSha256, revisionSha256: derived.revision.revisionSha256, renderPlanSha256: canonicalJsonSha256(derived.renderPlan) });
    const planText = spatialProjectDocumentText(planDocument), planSha = sha256Hex(planText);
    await publicationFence(); uncertainPublication = { path: repositoryPath(`renders/plans/${planSha}.json`), sha256: planSha, bytes: Buffer.byteLength(planText) };
    const plan = ProjectRenderPlanReferenceSchema.parse({ kind: "atet.project-render-plan-reference", schemaVersion: 1,
      artifact: { path: `renders/plans/${planSha}.json`, sha256: planSha, bytes: Buffer.byteLength(planText) },
      projectId: request.project, outputGeometrySha256: revisionReference.outputGeometrySha256, planSha256: derived.renderPlan.planSha256,
      projectEditPlanSha256: derived.revision.projectEditPlanSha256, projectSha256: derived.revision.projectSha256,
      renderPlanSha256: planDocument.renderPlanSha256, revisionSha256: derived.revision.revisionSha256 });
    await repositoryFileSystem.writeTextNoReplace(repositoryPath(plan.artifact.path), planText, publicationFence);
    published.push({ ...plan.artifact, path: repositoryPath(plan.artifact.path) });
    checked(plan.planSha256 === derived.projection.compositionPlanSha256 && plan.artifact.sha256 === planSha, "Immutable compositor planning differs from the exact spatial projection.");
    await durability.syncExactFile(repositoryPath(plan.artifact.path), plan.artifact);
    uncertainPublication = undefined;
    await fence();
    const current = await readSpatialProjectAuthority(ports);
    checked(canonicalJson(current.basis) === canonicalJson(snapshot.basis), "Project authority changed during spatial render preparation; retained artifacts still describe the original snapshot.");
    await fence();
    const spatial = { projection: derived.projection, projectionSha256: derived.projectionSha256, cadence: createSpatialCompositorCadence({ ...derived, plan: derived.renderPlan }) };
    return deepFreezeJson(SpatialProjectRenderPreparationOutputSchema.parse({ sourceBasis: snapshot.basis, projection: derived.projection, projectionSha256: derived.projectionSha256, materializedShots, revisionReference, plan, spatial }));
  } catch (error) {
    const failure = new ApplicationError(error instanceof ApplicationError ? error.code : "internal", error instanceof Error ? error.message : "Spatial project render preparation failed.", {
      spatialProjectRenderPreparation: { sourceBasis: snapshot.basis, published, materializedShots, errors: failureMessages(error), ...(uncertainPublication === undefined ? {} : { uncertainPublication }),
        ...(error instanceof ApplicationError ? { causeDetails: error.details } : {}) },
    });
    failure.cause = error;
    throw failure;
  }
}
