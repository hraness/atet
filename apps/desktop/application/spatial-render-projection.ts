import { z } from "zod";
import { HtmlOverlayExecutionProfileSchema } from "../html-overlay/execution-profile";

import { createBoundedJsonValueSnapshot, deepFreezeJson } from "../../../src/code/json-snapshot";
import { reduceSpatialFrameRate, spatialFrameCount } from "../../../src/spatial-scene/index";
import { SpatialDigestSchema, SpatialFrameRateSchema, SpatialShotIdSchema, SpatialShotV1Schema } from "../../../src/spatial-scene/contracts";
import { ProjectEditPlanV1Schema, VideoProjectV1Schema } from "../contracts/project";
import { RepositoryRelativePathSchema } from "../contracts/recording";
import { SPATIAL_PROJECT_LIMITS, SpatialProjectBasisSchema, SpatialProjectHeadV2Schema, SpatialProjectRevisionV2Schema } from "../contracts/spatial-project";
import { canonicalJson, canonicalJsonSha256, sha256Hex } from "../core/canonical-json";
import { hashProjectStructure } from "../core/project-plan";
import { compileProjectRenderPlan } from "../core/project-render-plan";
import { SpatialProjectContentsSchema, spatialProjectArtifact, spatialProjectContents, spatialProjectDocumentText, spatialProjectRevisionSha256, spatialShotSha256 } from "../core/spatial-project";
import { projectEditRevisionPath } from "../core/storage";
import { createProjectEditRevisionDocument, ProjectEditRevisionArtifactSchema } from "./receipts";
import type { SpatialProjectSnapshot } from "./spatial-project-store";

export const SpatialSceneProgramPolicySchema = z.strictObject({
  kind: z.literal("full-frame-above-legacy-video-below-overlays"),
  alpha: z.enum(["opaque", "straight"]),
});
export const SpatialProjectionOutputSchema = z.strictObject({
  executionProfile: HtmlOverlayExecutionProfileSchema.optional(),
  pixelWidth: z.number().int().positive().max(16_384),
  pixelHeight: z.number().int().positive().max(16_384),
  frameRate: SpatialFrameRateSchema,
  background: z.string().regex(/^#[a-fA-F0-9]{6}ff$/u),
  /** Canvas transfer; final codec conversion is separately recorded by the encoder. */
  colorSpace: z.literal("srgb"),
}).superRefine((output, context) => {
  if (output.pixelWidth * output.pixelHeight > 33_554_432 || output.frameRate.numerator / output.frameRate.denominator > 240) context.addIssue({ code: "custom", message: "Projection exceeds the existing compositor dimensions or frame-rate limit." });
});
export const SpatialMaterializedShotVideoSchema = z.strictObject({
  shotId: SpatialShotIdSchema,
  shotSha256: SpatialDigestSchema,
  sceneSha256: SpatialDigestSchema,
  receiptSha256: SpatialDigestSchema,
  artifact: z.strictObject({
    path: RepositoryRelativePathSchema.refine(path => /^spatial\/outputs\/[a-f0-9]{64}\.(?:mov|mp4|webm)$/u.test(path)),
    sha256: SpatialDigestSchema,
    bytes: z.number().int().positive().max(256 * 1024 * 1024),
  }).superRefine((artifact, context) => {
    if (!artifact.path.startsWith(`spatial/outputs/${artifact.sha256}.`)) context.addIssue({ code: "custom", message: "Materialized shot path must name its exact payload digest." });
  }),
  pixelWidth: z.number().int().positive().max(16_384),
  pixelHeight: z.number().int().positive().max(16_384),
  frameRate: SpatialFrameRateSchema,
  frameCount: z.number().int().positive().max(864_000),
  alpha: z.enum(["opaque", "straight"]),
  colorSpace: z.literal("srgb"),
  codec: z.enum(["qtrle", "h264", "vp9", "prores"]),
  container: z.enum(["mov", "mp4", "webm"]),
  streamIndex: z.number().int().min(0).max(255),
}).superRefine((video, context) => {
  if (!video.artifact.path.endsWith(`.${video.container}`)) context.addIssue({ code: "custom", message: "Materialized shot extension and container must match." });
  if (((video.codec === "qtrle" || video.codec === "prores") && video.container !== "mov")
    || (video.codec === "vp9" && video.container !== "webm")
    || (video.codec === "h264" && video.container === "webm")) context.addIssue({ code: "custom", message: "Materialized codec and container are incompatible." });
  if (video.alpha === "straight" && (video.container !== "mov" || video.codec !== "qtrle")) context.addIssue({ code: "custom", message: "The initial straight-alpha projection requires the qualified qtrle MOV profile." });
});
export const SceneRenderProjectionV1Schema = z.strictObject({
  kind: z.literal("atet.scene-render-projection"),
  schemaVersion: z.literal(1),
  source: SpatialProjectHeadV2Schema,
  policy: SpatialSceneProgramPolicySchema,
  output: SpatialProjectionOutputSchema,
  shots: z.array(z.strictObject({ shot: SpatialShotV1Schema, materialized: SpatialMaterializedShotVideoSchema })).max(1_024),
  legacyFrameRateAdapter: z.strictObject({
    kind: z.literal("numeric-ratio-for-planning-only"),
    value: z.number().positive().max(240),
    requiredEncoderArgument: z.string().regex(/^[1-9][0-9]*\/[1-9][0-9]*$/u),
  }),
  derivedV1RevisionSha256: SpatialDigestSchema,
  derivedV1Revision: ProjectEditRevisionArtifactSchema,
  compositionPlanSha256: SpatialDigestSchema,
}).superRefine((projection, context) => {
  const rate = reduceSpatialFrameRate(projection.output.frameRate);
  if (canonicalJson(rate) !== canonicalJson(projection.output.frameRate)
    || projection.legacyFrameRateAdapter.value !== rate.numerator / rate.denominator
    || projection.legacyFrameRateAdapter.requiredEncoderArgument !== `${rate.numerator}/${rate.denominator}`) context.addIssue({ code: "custom", message: "Projection frame-rate identities must agree exactly." });
  if (projection.derivedV1Revision.path !== projectEditRevisionPath(projection.derivedV1Revision.sha256)) context.addIssue({ code: "custom", message: "Derived V1 revision must use its immutable byte-digest path." });
  const seen = new Set<string>();
  let endUs = 0;
  for (const { shot, materialized } of projection.shots) {
    if (seen.has(shot.shotId) || shot.range.startUs < endUs) context.addIssue({ code: "custom", message: "Projection shots must be unique, ordered, and nonoverlapping." });
    seen.add(shot.shotId);
    endUs = shot.range.endUs;
    if (materialized.shotId !== shot.shotId || materialized.shotSha256 !== spatialShotSha256(shot)
      || materialized.sceneSha256 !== shot.sceneSha256 || materialized.alpha !== projection.policy.alpha
      || materialized.pixelWidth !== projection.output.pixelWidth || materialized.pixelHeight !== projection.output.pixelHeight
      || materialized.colorSpace !== projection.output.colorSpace
      || canonicalJson(materialized.frameRate) !== canonicalJson(rate)
      || materialized.frameCount !== spatialFrameCount(shot.range.endUs - shot.range.startUs, rate)) context.addIssue({ code: "custom", message: "Projection materialized shot does not match its exact authored shot and output profile." });
  }
});
export type SpatialMaterializedShotVideo = z.infer<typeof SpatialMaterializedShotVideoSchema>;
export type SpatialProjectionOutput = z.infer<typeof SpatialProjectionOutputSchema>;
export type SpatialSceneProgramPolicy = z.infer<typeof SpatialSceneProgramPolicySchema>;
export type SceneRenderProjectionV1 = z.infer<typeof SceneRenderProjectionV1Schema>;
const ProjectionRequestSchema = z.strictObject({
  snapshot: z.strictObject({
    version: z.literal(2), basis: SpatialProjectBasisSchema,
    headText: z.string().max(SPATIAL_PROJECT_LIMITS.documentBytes),
    head: SpatialProjectHeadV2Schema, revision: SpatialProjectRevisionV2Schema,
    contents: SpatialProjectContentsSchema,
  }),
  materializedShots: z.array(SpatialMaterializedShotVideoSchema).max(SPATIAL_PROJECT_LIMITS.shots),
  policy: SpatialSceneProgramPolicySchema,
  output: SpatialProjectionOutputSchema,
});

export function spatialProjectionEncoderFrameRate(rateInput: unknown): string {
  const rate = reduceSpatialFrameRate(rateInput);
  return `${rate.numerator}/${rate.denominator}`;
}

/**
 * Pure lowering from verified V2 authority and already-materialized, receipt-bound
 * source-clock shot videos. This function never reads a mutable project or starts
 * a render. The caller verifies the supplied physical videos/receipts before use.
 *
 * New video placements enter the logical source clock before the V1 compositor
 * applies global cuts and speed once. V1 overlays are intentionally preserved:
 * appending a shot as an overlay would incorrectly use compressed output time.
 */
export function createSpatialRenderProjection(input: {
  readonly snapshot: SpatialProjectSnapshot;
  readonly materializedShots: readonly SpatialMaterializedShotVideo[];
  readonly policy: SpatialSceneProgramPolicy;
  readonly output: SpatialProjectionOutput;
}) {
  const request = ProjectionRequestSchema.parse(createBoundedJsonValueSnapshot(input, SPATIAL_PROJECT_LIMITS.totalSceneBytes + 2 * SPATIAL_PROJECT_LIMITS.documentBytes, "spatial projection input", { maximumDepth: 48, maximumValues: 2_000_000 }).value);
  const head = request.snapshot.head;
  const aggregate = request.snapshot.revision;
  if (request.snapshot.version !== 2 || request.snapshot.basis.version !== 2
    || request.snapshot.basis.sha256 !== head.projectRevisionSha256
    || spatialProjectRevisionSha256(aggregate) !== head.projectRevisionSha256
    || aggregate.projectId !== head.projectId || aggregate.transactionId !== head.transactionId
    || canonicalJson(spatialProjectArtifact("revisions", spatialProjectDocumentText(aggregate))) !== canonicalJson(head.revision)) throw new Error("Render projection requires the exact verified V2 aggregate and head.");
  const contents = spatialProjectContents(aggregate, request.snapshot.contents.scenes);
  const references = contents.scenes.map(scene => ({ sceneSha256: scene.sceneSha256, artifact: spatialProjectArtifact("scenes", spatialProjectDocumentText(scene.document)) }));
  if (canonicalJson(references) !== canonicalJson(aggregate.scenes)) throw new Error("Render projection scene sources do not match the immutable aggregate.");
  const policy = SpatialSceneProgramPolicySchema.parse(request.policy);
  const rawOutput = SpatialProjectionOutputSchema.parse(request.output);
  const output = { ...rawOutput, frameRate: reduceSpatialFrameRate(rawOutput.frameRate) };
  const videos = request.materializedShots.map(video => SpatialMaterializedShotVideoSchema.parse(video));
  if (videos.length !== contents.shots.length || new Set(videos.map(video => video.shotId)).size !== videos.length) throw new Error("Projection requires exactly one materialized video per shot.");
  const shots = [...contents.shots].sort((a, b) => a.range.startUs - b.range.startUs || a.shotId.localeCompare(b.shotId));
  for (let index = 1; index < shots.length; index++) if (shots[index]!.range.startUs < shots[index - 1]!.range.endUs) throw new Error("Full-frame camera-program projection rejects overlapping shot ranges.");
  const base = contents.legacy;
  const layers = base.project.placements.flatMap(placement => placement.enabled ? placement.video.flatMap(video => video.presentation.enabled ? [video.presentation.layer] : []) : []);
  const layer = Math.max(-1, ...layers) + 1;
  if (!Number.isSafeInteger(layer)) throw new Error("No safe integer video layer remains above legacy video.");
  const numericFrameRate = output.frameRate.numerator / output.frameRate.denominator;
  const assets = [...base.project.assets];
  const placements = [...base.project.placements];
  const boundShots: z.infer<typeof SceneRenderProjectionV1Schema>["shots"] = [];
  for (const shot of shots) {
    const materialized = videos.find(video => video.shotId === shot.shotId);
    if (materialized === undefined || materialized.shotSha256 !== spatialShotSha256(shot)
      || materialized.sceneSha256 !== shot.sceneSha256) throw new Error("Materialized video does not bind the exact shot and source scene.");
    const durationUs = shot.range.endUs - shot.range.startUs;
    if (materialized.pixelWidth !== output.pixelWidth || materialized.pixelHeight !== output.pixelHeight
      || materialized.alpha !== policy.alpha || materialized.colorSpace !== output.colorSpace
      || canonicalJson(reduceSpatialFrameRate(materialized.frameRate)) !== canonicalJson(output.frameRate)
      || materialized.frameCount !== spatialFrameCount(durationUs, output.frameRate)) throw new Error("Materialized shot does not match the exact source duration and render profile.");
    const key = spatialShotSha256(shot).slice(0, 48);
    const assetId = `asset_spatial_${key}`;
    const placementId = `placement_spatial_${key}`;
    const streamId = `stream_spatial_${key}`;
    if (assets.some(asset => asset.assetId === assetId || asset.streams.some(stream => stream.streamId === streamId))
      || placements.some(placement => placement.placementId === placementId)) throw new Error("Derived spatial identity collides with a retained media identity.");
    assets.push(VideoProjectV1Schema.shape.assets.element.parse({
      assetId, createdAt: base.project.updatedAt, durationUs, label: `Spatial shot ${shot.shotId}`, role: "b-roll",
      source: { kind: "generated", generator: "atet.spatial-render-projection", generatorVersion: "1", sourceSha256: materialized.shotSha256 },
      streams: [{ streamId, label: `Spatial shot ${shot.shotId}`, kind: "video", role: "b-roll", frameRate: numericFrameRate, pixelWidth: output.pixelWidth, pixelHeight: output.pixelHeight,
        segments: [{ assetRange: { startUs: 0, endUs: durationUs }, fileRange: { startUs: 0, endUs: durationUs }, ...materialized.artifact, codec: materialized.codec, container: materialized.container, streamIndex: materialized.streamIndex }] }],
    }));
    placements.push({
      placementId: placementId as typeof placements[number]["placementId"], assetId: assetId as typeof placements[number]["assetId"],
      assetRange: { startUs: 0, endUs: durationUs }, enabled: true, audio: [],
      sync: { anchors: [{ assetTimeUs: 0, projectTimeUs: shot.range.startUs }, { assetTimeUs: durationUs, projectTimeUs: shot.range.endUs }], provenance: { kind: "identity" } },
      video: [{ streamId: streamId as typeof base.project.assets[number]["streams"][number]["streamId"], presentation: { enabled: true, blendMode: "normal", crop: { kind: "none" }, fit: "fill", layer, layout: { kind: "normalized", x: 0, y: 0, width: 1, height: 1 }, opacity: 1 } }],
    });
    boundShots.push({ shot: SpatialShotV1Schema.parse(shot), materialized: { ...materialized, frameRate: reduceSpatialFrameRate(materialized.frameRate) } });
  }
  const project = VideoProjectV1Schema.parse({ ...base.project, assets, placements });
  const plan = ProjectEditPlanV1Schema.parse({ ...base.projectEditPlan, projectStructureSha256: hashProjectStructure(project) });
  const revision = createProjectEditRevisionDocument(project, plan);
  const revisionText = spatialProjectDocumentText(revision);
  const artifactSha256 = sha256Hex(revisionText);
  const renderPlan = compileProjectRenderPlan(project, plan, { frameRate: numericFrameRate, pixelWidth: output.pixelWidth, pixelHeight: output.pixelHeight, background: output.background });
  const projection = SceneRenderProjectionV1Schema.parse({
    kind: "atet.scene-render-projection", schemaVersion: 1, source: head, policy, output, shots: boundShots,
    legacyFrameRateAdapter: { kind: "numeric-ratio-for-planning-only", value: numericFrameRate, requiredEncoderArgument: spatialProjectionEncoderFrameRate(output.frameRate) },
    derivedV1RevisionSha256: revision.revisionSha256,
    derivedV1Revision: { bytes: new TextEncoder().encode(revisionText).byteLength, sha256: artifactSha256, path: projectEditRevisionPath(artifactSha256) },
    compositionPlanSha256: renderPlan.planSha256,
  });
  return deepFreezeJson({ projection, projectionSha256: canonicalJsonSha256({ domain: "atet.scene-render-projection/v1", projection }), revision, renderPlan });
}
