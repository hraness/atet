import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import sharp from "sharp";
import { z } from "zod";

import { createBoundedJsonSnapshot, deepFreezeJson } from "../../../src/code/json-snapshot";
import {
  SpatialAssetIdSchema, SpatialCameraIdSchema, SpatialDigestSchema, SpatialFrameRateSchema, SpatialOverrideSchema, SpatialPoseSchema,
  SpatialTimeUsSchema, SpatialShotV1Schema, type SpatialSceneV1,
} from "../../../src/spatial-scene/contracts";
import { evaluateSpatialScene } from "../../../src/spatial-scene/evaluate";
import { parseSpatialScene, parseSpatialValue, spatialAssetClosureDigests, spatialSceneSha256 } from "../../../src/spatial-scene/identity";
import { reduceSpatialFrameRate, spatialFrameCount, spatialFrameSample, spatialOutputDuration, type SpatialRational } from "../../../src/spatial-scene/time";
import { canonicalJson, canonicalJsonSha256 } from "../core/canonical-json";
import { createNodeSpatialDurability, type SpatialDurabilityPort } from "../core/spatial-durability";
import { SpatialShotRenderClockSchema, spatialShotSceneTime } from "../core/spatial-shot-clock";
import { createSpatialOverlayBatch, SpatialRenderModeSchema } from "../html-overlay/spatial";
import { exactCapabilityByName } from "./capability-binding";
import { ApplicationError } from "./errors";
import { bindHtmlOverlayBrowserRuntime, HtmlOverlayBrowserRuntimeBindingSchema, type HtmlOverlayBrowserRuntimeBinding } from "./html-overlay-browser-runtime";
import { createHtmlOverlayExecutionBundle, HtmlOverlayExecutionIntegritySchema } from "./html-overlay-integrity";
import type { OperationExecutionContext } from "./operation";
import { assertMediaCapabilities, bindExpectedMediaCapabilities, MediaCapabilityBindingsSchema, mediaCapabilityCommand, mediaCapabilityRunner, type MediaCapabilityName } from "./operations/media/capabilities";
import { AbortBoundApplicationRunner, createMediaOperationWorkspace, MediaArtifactReferenceSchema, publishContentAddressedMedia, publishContentAddressedReceipt, type MediaArtifactReference } from "./operations/media/shared";
import { throwIfAborted } from "./operations/shared";
import { withPreparedSpatialAssets } from "./spatial-assets";

/** Conservative admission limits, including an uncompressed worst-case staging estimate. */
export const SPATIAL_RENDER_LIMITS = Object.freeze({
  frames: 1_800, contactSheetFrames: 64, batchFrames: 32, dimension: 8_192,
  framePixels: 33_554_432, totalPixels: 1_100_000_000, entitySamples: 262_144,
  sourceBytes: 256 * 1024 * 1024, pngBytes: 6 * 1024 * 1024 * 1024,
  outputBytes: 256 * 1024 * 1024, metadataBytes: 32 * 1024 * 1024,
  stagingBytes: 8 * 1024 * 1024 * 1024, probeBytes: 2 * 1024 * 1024,
  nativeTimeoutMs: 120_000,
});

export const SpatialRenderRequestSchema = z.strictObject({
  cameraId: SpatialCameraIdSchema,
  overrides: z.array(SpatialOverrideSchema).max(4_096).optional(),
  cameraPoseOverride: SpatialPoseSchema.optional(),
  selection: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("frame"), timeUs: SpatialTimeUsSchema }),
    z.strictObject({ kind: z.literal("video"),
      range: z.strictObject({ startUs: SpatialTimeUsSchema, endUs: SpatialTimeUsSchema }),
      frameRate: SpatialFrameRateSchema.overwrite(reduceSpatialFrameRate),
      clock: SpatialShotRenderClockSchema.optional(),
    }),
    z.strictObject({ kind: z.literal("contact-sheet"),
      timesUs: z.array(SpatialTimeUsSchema).min(1).max(SPATIAL_RENDER_LIMITS.contactSheetFrames),
      columns: z.number().int().min(1).max(16),
      cellWidth: z.number().int().min(1).max(2_048),
      cellHeight: z.number().int().min(1).max(2_048),
      /** Resampling is a presentation operation after calibrated scene rendering. */
      fit: z.literal("contain").default("contain"),
    }),
  ]),
  mode: SpatialRenderModeSchema,
});
export type SpatialRenderRequest = z.infer<typeof SpatialRenderRequestSchema>;

/** One canonical request identity shared by V2 projection production and receipt verification. */
export function spatialShotRenderRequest(shotInput: unknown, frameRateInput: unknown): SpatialRenderRequest {
  const shot = parseSpatialValue(SpatialShotV1Schema, shotInput, "spatial shot");
  const frameRate = reduceSpatialFrameRate(frameRateInput);
  return deepFreezeJson(SpatialRenderRequestSchema.parse({ cameraId: shot.cameraId, overrides: shot.overrides,
    ...(shot.cameraPoseOverride === undefined ? {} : { cameraPoseOverride: shot.cameraPoseOverride }),
    mode: { kind: "beauty" }, selection: { kind: "video", frameRate,
      range: { startUs: 0, endUs: shot.range.endUs - shot.range.startUs },
      clock: { kind: "shot", sceneStartUs: shot.sceneStartUs, playback: shot.playback },
    },
  }));
}
export interface SpatialRenderSample {
  readonly index: number;
  readonly timeUs: number;
  readonly exactTimeUs: SpatialRational;
}
export interface SpatialRenderPlan {
  readonly scene: SpatialSceneV1;
  readonly sceneSha256: string;
  readonly request: SpatialRenderRequest;
  readonly requestSha256: string;
  readonly samples: readonly SpatialRenderSample[];
  readonly width: number;
  readonly height: number;
  readonly outputWidth: number;
  readonly outputHeight: number;
  readonly outputDurationUs?: SpatialRational;
  readonly costs: { readonly sourceBytes: number; readonly renderPixels: number; readonly pngBytesBound: number; readonly outputBytesBound: number; readonly stagingBytesBound: number };
}

function rational(numerator: bigint, denominator: bigint): SpatialRational {
  let a = numerator, b = denominator;
  while (b !== 0n) { const rest = a % b; a = b; b = rest; }
  return { numerator: String(numerator / a), denominator: String(denominator / a) };
}
function checked(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ApplicationError("invalid-data", message);
}
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Source-clock samples are computed independently in BigInt and quantized exactly once. */
export function planSpatialRender(sceneInput: unknown, requestInput: unknown): SpatialRenderPlan {
  const scene = parseSpatialScene(sceneInput);
  const request = parseSpatialValue(SpatialRenderRequestSchema, requestInput, "spatial render request");
  const camera = scene.cameras.find(item => item.cameraId === request.cameraId);
  checked(camera !== undefined, "Spatial render camera is absent from the scene.");
  const { width, height } = camera.projection;
  checked(width <= SPATIAL_RENDER_LIMITS.dimension && height <= SPATIAL_RENDER_LIMITS.dimension, "Spatial render dimensions exceed the renderer profile.");
  const selection = request.selection;
  let samples: SpatialRenderSample[], outputDurationUs: SpatialRational | undefined;
  if (selection.kind === "video") {
    checked(selection.range.endUs > selection.range.startUs, "Video range must be nonempty.");
    if (selection.clock === undefined) checked(selection.range.endUs <= scene.durationUs, "Video range must be contained in the scene clock.");
    else {
      checked(selection.range.startUs === 0, "Shot video range must begin at relative time zero.");
      checked(selection.clock.sceneStartUs < scene.durationUs, "Shot scene start must precede scene duration.");
      if (selection.clock.playback === "once") checked(selection.clock.sceneStartUs + selection.range.endUs <= scene.durationUs, "Once shot duration exceeds the scene clock.");
    }
    const duration = selection.range.endUs - selection.range.startUs;
    const count = spatialFrameCount(duration, selection.frameRate);
    checked(count <= SPATIAL_RENDER_LIMITS.frames, "Spatial video exceeds the frame-count limit.");
    samples = Array.from({ length: count }, (_, index) => {
      const relativeSample = spatialFrameSample(index, duration, selection.frameRate);
      if (selection.clock !== undefined) return { index, ...spatialShotSceneTime({ clock: selection.clock, relativeTimeUs: relativeSample.exactTimeUs, sceneDurationUs: scene.durationUs }) };
      const denominator = BigInt(relativeSample.exactTimeUs.denominator);
      const numerator = BigInt(selection.range.startUs) * denominator + BigInt(relativeSample.exactTimeUs.numerator);
      return { index, exactTimeUs: rational(numerator, denominator), timeUs: Number((2n * numerator + denominator) / (2n * denominator)) };
    });
    outputDurationUs = spatialOutputDuration(duration, selection.frameRate);
  } else {
    const times = selection.kind === "frame" ? [selection.timeUs] : selection.timesUs;
    checked(times.every(time => time <= scene.durationUs), "A selected frame is outside the scene clock.");
    samples = times.map((timeUs, index) => ({ index, timeUs, exactTimeUs: { numerator: String(timeUs), denominator: "1" } }));
  }
  const outputWidth = selection.kind === "contact-sheet" ? selection.columns * selection.cellWidth : width;
  const outputHeight = selection.kind === "contact-sheet" ? Math.ceil(samples.length / selection.columns) * selection.cellHeight : height;
  checked(outputWidth <= SPATIAL_RENDER_LIMITS.dimension && outputHeight <= SPATIAL_RENDER_LIMITS.dimension
    && outputWidth * outputHeight <= SPATIAL_RENDER_LIMITS.framePixels, "Spatial output exceeds its dimension or pixel budget.");
  checked(scene.entities.length * samples.length <= SPATIAL_RENDER_LIMITS.entitySamples, "Spatial render exceeds its evaluated entity-sample budget.");
  const sourceBytes = scene.assets.reduce((sum, asset) => sum + asset.payload.bytes, 0);
  const renderPixels = width * height * samples.length;
  // PNG deflate overhead and qtrle literal overhead are covered before native execution.
  const pngBytesBound = (width * height * 5 + height * 8 + 65_536) * samples.length;
  // Video compression is content-dependent. This is an enforced output ceiling,
  // not a promise that every admitted scene compresses below it. A truncated
  // encode cannot publish: complete encoded count/timestamps are verified.
  const outputBytesBound = selection.kind === "video" ? Math.min(SPATIAL_RENDER_LIMITS.outputBytes, pngBytesBound + 1024 * 1024) : outputWidth * outputHeight * 5 + outputHeight * 8 + 65_536;
  const stagingBytesBound = sourceBytes + pngBytesBound + outputBytesBound + SPATIAL_RENDER_LIMITS.metadataBytes;
  checked(sourceBytes <= SPATIAL_RENDER_LIMITS.sourceBytes, "Spatial source closure exceeds its byte budget.");
  checked(renderPixels <= SPATIAL_RENDER_LIMITS.totalPixels && pngBytesBound <= SPATIAL_RENDER_LIMITS.pngBytes, "Spatial frame staging exceeds its pixel or byte budget; reduce resolution or range.");
  checked(outputBytesBound <= SPATIAL_RENDER_LIMITS.outputBytes && stagingBytesBound <= SPATIAL_RENDER_LIMITS.stagingBytes, "Spatial output exceeds its conservative byte budget.");
  // Semantic override validation is pure and precedes capability or resource admission.
  evaluateSpatialScene(scene, { cameraId: request.cameraId, timeUs: samples[0]!.timeUs,
    ...(request.overrides === undefined ? {} : { overrides: request.overrides }),
    ...(request.cameraPoseOverride === undefined ? {} : { cameraPoseOverride: request.cameraPoseOverride }),
  });
  return deepFreezeJson({ scene, sceneSha256: spatialSceneSha256(scene), request, requestSha256: canonicalJsonSha256(request), samples,
    width, height, outputWidth, outputHeight, ...(outputDurationUs === undefined ? {} : { outputDurationUs }),
    costs: { sourceBytes, renderPixels, pngBytesBound, outputBytesBound, stagingBytesBound },
  });
}

/** The single capability selection rule shared by exact planning and execution. */
export function spatialRenderCapabilityNames(plan: SpatialRenderPlan): readonly MediaCapabilityName[] {
  return Object.freeze(plan.request.selection.kind === "video" || plan.scene.assets.some(asset => asset.interpretation.kind === "video")
    ? ["ffmpeg", "ffprobe", "html-browser"] as const : ["html-browser"] as const);
}

export interface SpatialEncodedVideoEvidence {
  readonly codec: "qtrle";
  readonly container: "mov";
  readonly pixelFormat: "argb";
  readonly alpha: "straight";
  readonly colorSpace: "srgb" | "rgba8-data";
  readonly streamIndex: number;
  readonly frameRate: { readonly numerator: number; readonly denominator: number };
  readonly frameCount: number;
  readonly timeBase: SpatialRational;
  readonly firstPts: string;
  readonly lastPts: string;
  readonly endPts: string;
  readonly outputDurationUs: SpatialRational;
}
export interface SpatialRetainedAsset {
  readonly assetId: string;
  readonly manifestSha256: string;
  readonly originalPath: string;
  readonly artifact: MediaArtifactReference;
}
export interface SpatialRenderResult {
  readonly artifact: MediaArtifactReference;
  readonly receipt: MediaArtifactReference;
  readonly sceneSource: MediaArtifactReference;
  readonly retainedAssets: readonly SpatialRetainedAsset[];
  readonly render: {
    readonly kind: SpatialRenderRequest["selection"]["kind"];
    readonly frameCount: number;
    readonly width: number;
    readonly height: number;
    readonly frameRate?: { readonly numerator: number; readonly denominator: number } | undefined;
    readonly encodedEvidence?: SpatialEncodedVideoEvidence | undefined;
  };
}
const rationalSchema = z.strictObject({ numerator: z.string().regex(/^(?:0|[1-9]\d{0,23})$/u), denominator: z.string().regex(/^[1-9]\d{0,12}$/u) });
const countSchema = z.number().int().min(1).max(SPATIAL_RENDER_LIMITS.frames);
const pixelDimensionSchema = z.number().int().min(1).max(SPATIAL_RENDER_LIMITS.dimension);
const byteCountSchema = z.number().int().safe().min(0).max(SPATIAL_RENDER_LIMITS.stagingBytes);
const encodedEvidenceSchema = z.strictObject({
  codec: z.literal("qtrle"), container: z.literal("mov"), pixelFormat: z.literal("argb"), alpha: z.literal("straight"),
  colorSpace: z.enum(["srgb", "rgba8-data"]), streamIndex: z.number().int().min(0),
  frameRate: SpatialFrameRateSchema, frameCount: countSchema, timeBase: rationalSchema,
  firstPts: z.string().regex(/^0$/u), lastPts: z.string().regex(/^\d{1,24}$/u), endPts: z.string().regex(/^\d{1,24}$/u), outputDurationUs: rationalSchema,
});
const retainedAssetSchema = z.strictObject({ assetId: SpatialAssetIdSchema, manifestSha256: SpatialDigestSchema,
  originalPath: z.string().min(1).max(1_024), artifact: MediaArtifactReferenceSchema });
const renderSummarySchema = z.strictObject({ kind: z.enum(["frame", "video", "contact-sheet"]), frameCount: countSchema,
  width: pixelDimensionSchema, height: pixelDimensionSchema, frameRate: SpatialFrameRateSchema.optional(), encodedEvidence: encodedEvidenceSchema.optional(),
}).superRefine((value, context) => {
  if (value.kind === "video") {
    if (value.frameRate === undefined || value.encodedEvidence === undefined || value.encodedEvidence.frameCount !== value.frameCount
      || canonicalJson(value.frameRate) !== canonicalJson(value.encodedEvidence.frameRate)) context.addIssue({ code: "custom", message: "Video summary requires matching encoded rate and frame-count evidence." });
  } else if (value.frameRate !== undefined || value.encodedEvidence !== undefined || value.kind === "frame" && value.frameCount !== 1) {
    context.addIssue({ code: "custom", message: "Raster summary must not claim encoded-video evidence." });
  }
});
export const SpatialRenderOutputSchema = z.strictObject({ artifact: MediaArtifactReferenceSchema, receipt: MediaArtifactReferenceSchema,
  sceneSource: MediaArtifactReferenceSchema, retainedAssets: z.array(retainedAssetSchema).max(128), render: renderSummarySchema });
export type SpatialRenderOutput = z.infer<typeof SpatialRenderOutputSchema>;
export const SpatialRenderReceiptSchema = z.strictObject({
  kind: z.literal("atet.spatial-render-receipt"), schemaVersion: z.literal(1), attemptId: z.string().uuid(), sceneSha256: SpatialDigestSchema,
  source: z.strictObject({ canonicalScene: MediaArtifactReferenceSchema, canonicalization: z.literal("parsed-spatial-scene-v1"),
    originalSceneArtifact: MediaArtifactReferenceSchema.optional(), retainedAssets: z.array(retainedAssetSchema).max(128), sourceManifests: z.record(SpatialAssetIdSchema, SpatialDigestSchema) }),
  request: SpatialRenderRequestSchema, requestSha256: SpatialDigestSchema,
  samples: z.array(z.strictObject({ sample: z.strictObject({ index: z.number().int().min(0).max(SPATIAL_RENDER_LIMITS.frames - 1), timeUs: SpatialTimeUsSchema, exactTimeUs: rationalSchema }),
    stateSha256: SpatialDigestSchema, viewSha256: SpatialDigestSchema, pngSha256: SpatialDigestSchema, pngBytes: byteCountSchema })).min(1).max(SPATIAL_RENDER_LIMITS.frames),
  render: renderSummarySchema, output: MediaArtifactReferenceSchema,
  batches: z.array(MediaArtifactReferenceSchema).min(1).max(Math.ceil(SPATIAL_RENDER_LIMITS.frames / SPATIAL_RENDER_LIMITS.batchFrames)),
  frameArtifacts: z.array(MediaArtifactReferenceSchema).max(SPATIAL_RENDER_LIMITS.contactSheetFrames),
  runtime: z.strictObject({ artifact: MediaArtifactReferenceSchema, rootSha256: SpatialDigestSchema, capabilities: MediaCapabilityBindingsSchema,
    renderer: z.literal("three-webgl2-snapshot-v1"), threeVersion: z.literal("0.185.1") }),
  color: z.strictObject({ output: z.enum(["srgb", "rgba8-data"]), alpha: z.enum(["straight", "binary-validity"]), toneMapping: z.literal("none") }),
  timing: z.strictObject({ sourceClock: z.literal("absolute-rational-microseconds"), quantization: z.literal("independent-nearest-microsecond-ties-positive"),
    encodedClock: z.literal("zero-based-uniform-frame-intervals"), outputDurationUs: rationalSchema.optional() }),
  calibratedSourceDimensions: z.strictObject({ width: pixelDimensionSchema, height: pixelDimensionSchema }),
  contactSheet: z.strictObject({ fit: z.literal("contain"), resampling: z.enum(["lanczos3", "nearest-data"]), calibratedProjectionResized: z.literal(false) }).optional(),
  encodedProbe: MediaArtifactReferenceSchema.optional(),
  workflow: z.strictObject({ nodeKey: z.string().min(1).max(255), nodePlanSha256: SpatialDigestSchema, runId: z.string().min(1).max(128) }).optional(),
  costs: z.strictObject({ sourceBytes: byteCountSchema, renderPixels: z.number().int().min(1).max(SPATIAL_RENDER_LIMITS.totalPixels), pngBytesBound: byteCountSchema,
    outputBytesBound: byteCountSchema, stagingBytesBound: byteCountSchema, actualPngBytes: byteCountSchema, actualBatchMetadataBytes: byteCountSchema }),
});
export type SpatialRenderReceipt = z.infer<typeof SpatialRenderReceiptSchema>;
export interface SpatialRenderInput {
  readonly scene: unknown;
  /** Adapter-owned root, not a path selected by the serialized render request. */
  readonly assetRoot: string;
  readonly request: unknown;
  readonly capabilityBindings?: z.infer<typeof MediaCapabilityBindingsSchema>;
  readonly browserRuntime?: HtmlOverlayBrowserRuntimeBinding;
  /** Exact original bytes retained by the source-loading adapter, distinct from canonical scene JSON. */
  readonly originalSceneArtifact?: MediaArtifactReference;
}
/** Trusted injection seam for deterministic host tests; never serialized or registered as an operation. */
export interface SpatialRenderDependencies {
  readonly bindBrowserRuntime?: typeof bindHtmlOverlayBrowserRuntime;
  readonly publishMedia?: typeof publishContentAddressedMedia;
  readonly publishReceipt?: typeof publishContentAddressedReceipt;
  readonly durability?: SpatialDurabilityPort;
}
export interface SpatialRenderFailureEvidence {
  readonly attemptId: string;
  readonly stage: "preparation" | "render" | "encode" | "publication" | "cleanup";
  readonly published: readonly MediaArtifactReference[];
  /** Destination may have been linked before an I/O failure. Reconcile; never retry blindly. */
  readonly uncertainPublication?: MediaArtifactReference;
  readonly completion?: SpatialRenderResult;
}
export class SpatialRenderFailure extends ApplicationError {
  readonly evidence: SpatialRenderFailureEvidence;
  constructor(error: unknown, evidence: SpatialRenderFailureEvidence, cleanupErrors: readonly unknown[] = []) {
    super(error instanceof ApplicationError ? error.code : "internal", error instanceof Error ? error.message : "Spatial rendering failed.", {
      spatialRender: evidence,
      cleanupErrors: cleanupErrors.map(item => item instanceof Error ? item.message : String(item)),
    });
    this.name = "SpatialRenderFailure";
    this.evidence = deepFreezeJson(evidence);
    this.cause = error;
  }
}

/** Descriptor-bound, bounded read. Parent paths and the named leaf must retain physical identity. */
async function readPhysical(path: string, maximumBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  checked(await realpath(path) === path, "Spatial render files must have physical paths.");
  const parents: { path: string; dev: number; ino: number }[] = [];
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const stat = await lstat(parent);
    checked(stat.isDirectory() && !stat.isSymbolicLink(), "Spatial render file parent is unsafe.");
    parents.push({ path: parent, dev: stat.dev, ino: stat.ino });
    if (dirname(parent) === parent) break;
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    throwIfAborted(signal);
    const before = await handle.stat();
    checked(before.isFile() && before.nlink === 1 && Number.isSafeInteger(before.size) && before.size > 0 && before.size <= maximumBytes, "Spatial render file is empty, unsafe, or exceeds its byte budget.");
    const bytes = new Uint8Array(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      throwIfAborted(signal);
      const { bytesRead } = await handle.read(bytes, offset, Math.min(1_048_576, bytes.length - offset), offset);
      checked(bytesRead > 0, "Spatial render file changed during capture.");
      offset += bytesRead;
    }
    const after = await handle.stat(), named = await lstat(path);
    checked(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs
      && named.dev === before.dev && named.ino === before.ino && named.nlink === 1 && !named.isSymbolicLink(), "Spatial render file identity changed during capture.");
    for (const parent of parents) {
      const current = await lstat(parent.path);
      checked(current.isDirectory() && !current.isSymbolicLink() && current.dev === parent.dev && current.ino === parent.ino, "Spatial render parent identity changed during capture.");
    }
    return bytes;
  } finally { await handle.close(); }
}
async function stageBytes(path: string, bytes: Uint8Array): Promise<void> {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function stageJson(path: string, input: unknown, maximumBytes: number): Promise<Uint8Array> {
  const captured = createBoundedJsonSnapshot(input, maximumBytes - 1, "Spatial render evidence", { captureCanonicalText: true });
  const bytes = new TextEncoder().encode(`${captured.canonicalText!}\n`);
  await stageBytes(path, bytes);
  return bytes;
}
async function verifyPng(bytes: Uint8Array, width: number, height: number): Promise<void> {
  const decoder = sharp(bytes, { failOn: "warning", limitInputPixels: SPATIAL_RENDER_LIMITS.framePixels });
  const metadata = await decoder.metadata();
  checked(metadata.format === "png" && metadata.width === width && metadata.height === height && metadata.depth === "uchar"
    && (metadata.pages === undefined || metadata.pages === 1) && metadata.icc === undefined
    && metadata.orientation === undefined, "Renderer PNG must be a single calibrated 8-bit frame without an unqualified color profile.");
  // Fully decode before accepting renderer bytes. This preserves data-pass channel values.
  const decoded = await decoder.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  checked(decoded.info.channels === 4 && decoded.data.length === width * height * 4, "Renderer PNG did not decode to its declared RGBA raster.");
}

const integerText = z.union([z.number().int().safe(), z.string().regex(/^-?(?:0|[1-9]\d{0,23})$/u)]).transform(String);
const probeSchema = z.strictObject({
  programs: z.array(z.never()).max(0).optional(),
  stream_groups: z.array(z.never()).max(0).optional(),
  streams: z.array(z.object({ index: z.number().int().min(0), codec_type: z.string(), codec_name: z.string(),
    width: z.number().int().positive(), height: z.number().int().positive(), pix_fmt: z.string(),
    r_frame_rate: z.string(), avg_frame_rate: z.string(), time_base: z.string(), start_pts: integerText,
    duration_ts: integerText, nb_frames: integerText,
  })).min(1).max(2),
  frames: z.array(z.object({ stream_index: z.number().int().min(0), pts: integerText,
    best_effort_timestamp: integerText.optional(), pkt_duration: integerText.optional(), duration: integerText.optional(),
  })).min(1).max(SPATIAL_RENDER_LIMITS.frames),
});
function ratio(text: string): { numerator: bigint; denominator: bigint } {
  checked(/^[1-9]\d{0,12}\/[1-9]\d{0,12}$/u.test(text), "Encoded stream has an invalid exact rational.");
  const [numerator, denominator] = text.split("/");
  return { numerator: BigInt(numerator!), denominator: BigInt(denominator!) };
}
/** Qualifies actual ffprobe packet timestamps rather than inferring delivery from requested fps. */
export function verifySpatialEncodedVideo(plan: SpatialRenderPlan, probeInput: unknown): SpatialEncodedVideoEvidence {
  checked(plan.request.selection.kind === "video", "Encoded evidence requires a video plan.");
  const captured = createBoundedJsonSnapshot(probeInput, SPATIAL_RENDER_LIMITS.probeBytes, "Spatial video probe");
  const probe = probeSchema.parse(captured.value), stream = probe.streams[0]!;
  const rate = plan.request.selection.frameRate, count = plan.samples.length;
  checked(probe.streams.length === 1 && stream.codec_type === "video" && stream.codec_name === "qtrle" && stream.pix_fmt === "argb"
    && stream.width === plan.width && stream.height === plan.height, "Encoded spatial video differs from the qualified qtrle/ARGB profile.");
  for (const value of [stream.r_frame_rate, stream.avg_frame_rate]) {
    const actual = ratio(value);
    checked(actual.numerator * BigInt(rate.denominator) === actual.denominator * BigInt(rate.numerator), "Encoded frame rate differs from the exact requested rate.");
  }
  const timeBase = ratio(stream.time_base);
  checked(probe.frames.length === count && BigInt(stream.nb_frames) === BigInt(count) && BigInt(stream.start_pts) === 0n, "Encoded stream frame count or start timestamp is incorrect.");
  const durationNumerator = BigInt(rate.denominator) * timeBase.denominator;
  const durationDenominator = BigInt(rate.numerator) * timeBase.numerator;
  checked(durationNumerator % durationDenominator === 0n, "Encoded stream time base cannot represent every exact frame timestamp.");
  const ticks = durationNumerator / durationDenominator;
  for (const [index, frame] of probe.frames.entries()) {
    const expectedPts = BigInt(index) * ticks;
    checked(frame.stream_index === stream.index && BigInt(frame.pts) === expectedPts
      && (frame.best_effort_timestamp === undefined || BigInt(frame.best_effort_timestamp) === expectedPts), "Encoded frame timestamps drift, reorder, or skip a sample.");
    for (const duration of [frame.duration, frame.pkt_duration]) {
      checked(duration === undefined || BigInt(duration) === ticks, "Encoded frame duration differs from the exact cadence.");
    }
  }
  checked(BigInt(stream.duration_ts) === BigInt(count) * ticks, "Encoded stream endpoint differs from its complete exact frame interval.");
  return deepFreezeJson({ codec: "qtrle", container: "mov", pixelFormat: "argb", alpha: "straight", colorSpace: plan.request.mode.kind === "beauty" ? "srgb" : "rgba8-data",
    streamIndex: stream.index, frameRate: rate, frameCount: count, timeBase: rational(timeBase.numerator, timeBase.denominator),
    firstPts: probe.frames[0]!.pts, lastPts: probe.frames.at(-1)!.pts, endPts: stream.duration_ts, outputDurationUs: plan.outputDurationUs!,
  });
}

export async function renderSpatialScene(context: OperationExecutionContext, input: SpatialRenderInput, dependencies: SpatialRenderDependencies = {}): Promise<SpatialRenderResult> {
  const plan = planSpatialRender(input.scene, input.request);
  const assetRoot = input.assetRoot;
  const expectedCapabilities = input.capabilityBindings === undefined ? undefined : parseSpatialValue(MediaCapabilityBindingsSchema, input.capabilityBindings, "render capabilities");
  const expectedRuntime = input.browserRuntime === undefined ? undefined : HtmlOverlayBrowserRuntimeBindingSchema.parse(
    createBoundedJsonSnapshot(input.browserRuntime, SPATIAL_RENDER_LIMITS.metadataBytes, "Expected browser runtime").value,
  );
  const sourceManifests = spatialAssetClosureDigests(plan.scene.assets);
  const originalSceneArtifact = input.originalSceneArtifact === undefined ? undefined : parseSpatialValue(MediaArtifactReferenceSchema, input.originalSceneArtifact, "original scene artifact");
  const attemptId = randomUUID(), published: MediaArtifactReference[] = [];
  const durability = dependencies.durability ?? createNodeSpatialDurability(context.application.paths.repositoryRoot);
  let stage: SpatialRenderFailureEvidence["stage"] = "preparation", uncertainPublication: MediaArtifactReference | undefined;
  let completed: SpatialRenderResult | undefined, failure: unknown, failed = false;
  const cleanupErrors: unknown[] = [];
  const workspace = await createMediaOperationWorkspace(context);
  let directory: string | undefined;
  const assertCustody = async () => { await context.application.hostResourceLease?.assertOwned(); throwIfAborted(context.abortSignal); };
  try {
    await assertCustody();
    if (originalSceneArtifact !== undefined) {
      const bytes = await readPhysical(join(context.application.paths.repositoryRoot, originalSceneArtifact.path), 2_097_152, context.abortSignal);
      checked(bytes.length === originalSceneArtifact.bytes && sha256(bytes) === originalSceneArtifact.sha256
        && spatialSceneSha256(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))) === plan.sceneSha256,
      "Original scene artifact does not preserve the exact source or canonical scene authority.");
    }
    directory = await mkdtemp(join(workspace.path, "spatial-render-"));
    checked(await realpath(directory) === directory, "Spatial render workspace must be physical.");
    const frameDirectory = join(directory, "source-frames");
    await mkdir(frameDirectory, { mode: 0o700 });
    const names = spatialRenderCapabilityNames(plan);
    await assertMediaCapabilities(context, context.application, expectedCapabilities, names);
    const capabilities = await bindExpectedMediaCapabilities(context.application, names, expectedCapabilities);
    const runtime = await (dependencies.bindBrowserRuntime ?? bindHtmlOverlayBrowserRuntime)(exactCapabilityByName(capabilities, "html-browser"), context.abortSignal);
    if (expectedRuntime !== undefined) {
      checked(canonicalJson(runtime) === canonicalJson(expectedRuntime), "Browser runtime changed after render planning.");
    } else checked(context.workflow === undefined, "Workflow rendering requires a bound complete browser runtime.");
    const renderer = context.application.htmlOverlayRenderer;
    checked(renderer !== undefined, "The application does not provide the qualified spatial browser renderer.");
    const runner = new AbortBoundApplicationRunner(mediaCapabilityRunner(context.application, capabilities), context.abortSignal);
    const ports = { runner, ...(names.includes("ffmpeg") ? { ffmpegCommand: mediaCapabilityCommand(capabilities, "ffmpeg"), ffprobeCommand: mediaCapabilityCommand(capabilities, "ffprobe") } : {}) };
    const retainedSources: { assetId: string; manifestSha256: string; originalPath: string; stagedPath: string; bytes: number }[] = [];
    const batchFiles: string[] = [], sampleEvidence: { sample: SpatialRenderSample; stateSha256: string; viewSha256: string; pngSha256: string; pngBytes: number }[] = [];
    let pngBytes = 0, metadataBytes = 0;
    for (let offset = 0; offset < plan.samples.length; offset += SPATIAL_RENDER_LIMITS.batchFrames) {
      await assertCustody();
      const samples = plan.samples.slice(offset, offset + SPATIAL_RENDER_LIMITS.batchFrames);
      const snapshots = samples.map(sample => evaluateSpatialScene(plan.scene, { cameraId: plan.request.cameraId, timeUs: sample.timeUs,
        ...(plan.request.overrides === undefined ? {} : { overrides: plan.request.overrides }),
        ...(plan.request.cameraPoseOverride === undefined ? {} : { cameraPoseOverride: plan.request.cameraPoseOverride }),
      }));
      const batchDirectory = join(directory, `batch-${offset}`);
      await mkdir(batchDirectory, { mode: 0o700 });
      stage = "preparation";
      await withPreparedSpatialAssets({ snapshots, exactSceneTimesUs: samples.map(sample => sample.exactTimeUs), assetRoot, workspaceParent: directory }, ports, context.abortSignal, async prepared => {
        checked(canonicalJson(prepared.receipt.sourceManifests) === canonicalJson(sourceManifests), "Asset preparation did not bind the complete source closure.");
        if (offset === 0) {
          for (const source of prepared.sources) {
            const bytes = await readPhysical(source.absolutePath, source.manifest.payload.bytes, context.abortSignal);
            checked(bytes.length === source.manifest.payload.bytes && sha256(bytes) === source.manifest.payload.sha256
              && source.manifestSha256 === sourceManifests[source.manifest.assetId], "Retained asset differs from its prepared source manifest.");
            const stagedPath = join(directory!, `retained-${source.manifest.assetId}.bin`);
            await stageBytes(stagedPath, bytes);
            retainedSources.push({ assetId: source.manifest.assetId, manifestSha256: source.manifestSha256, originalPath: source.manifest.payload.path, stagedPath, bytes: bytes.length });
          }
          checked(retainedSources.length === plan.scene.assets.length && new Set(retainedSources.map(source => source.assetId)).size === retainedSources.length, "Retained source closure is incomplete or duplicated.");
        }
        const batch = createSpatialOverlayBatch({ snapshots, mode: plan.request.mode,
          frameRate: plan.request.selection.kind === "video" ? plan.request.selection.frameRate : { numerator: 1, denominator: 1 }, preparedAssets: prepared.preparedAssets });
        const bundle = createHtmlOverlayExecutionBundle(batch.authoring, runtime);
        checked(bundle.libraryLocks.length === 1 && bundle.libraryLocks[0]!.specifier === "three" && bundle.libraryLocks[0]!.version === "0.185.1", "Spatial renderer library profile is not the qualified Three.js 0.185.1 lock.");
        stage = "render";
        const rendered = await renderer.renderFrames({ authoring: batch.authoring, browserRuntime: runtime, outputDirectory: batchDirectory, resources: prepared.resources }, context.abortSignal);
        await assertCustody();
        const integrity = parseSpatialValue(HtmlOverlayExecutionIntegritySchema, rendered.executionIntegrity, "Renderer execution integrity");
        checked(canonicalJson(integrity) === canonicalJson(bundle.integrity) && canonicalJson(rendered.libraryLocks) === canonicalJson(bundle.libraryLocks), "Renderer returned execution or library integrity different from the bound input.");
        const expectedPattern = join(batchDirectory, "frames", "frame-%08d.png");
        checked(rendered.frameCount === samples.length && rendered.framePattern === expectedPattern, "Renderer frame count or output location differs from the planned batch.");
        const entries = await readdir(join(batchDirectory, "frames"));
        checked(entries.length === samples.length, "Renderer produced an unexpected frame directory entry.");
        for (const [index, sample] of samples.entries()) {
          const bytes = await readPhysical(join(batchDirectory, "frames", frameName(index)), plan.costs.pngBytesBound, context.abortSignal);
          pngBytes += bytes.length;
          checked(pngBytes <= plan.costs.pngBytesBound, "Rendered PNG bytes exceeded the admitted staging estimate.");
          await verifyPng(bytes, plan.width, plan.height);
          await stageBytes(join(frameDirectory, frameName(sample.index)), bytes);
          sampleEvidence.push({ sample, stateSha256: snapshots[index]!.stateSha256, viewSha256: snapshots[index]!.viewSha256, pngSha256: sha256(bytes), pngBytes: bytes.length });
        }
        const metadataPath = join(directory!, `batch-${offset}.json`);
        const bytes = await stageJson(metadataPath, { preparedAssets: prepared.preparedAssets, metadata: batch.metadata, metadataSha256: batch.metadataSha256, executionIntegrity: integrity,
          libraryLocks: bundle.libraryLocks, preparation: prepared.receipt, samples: sampleEvidence.slice(offset) }, SPATIAL_RENDER_LIMITS.metadataBytes);
        metadataBytes += bytes.length;
        checked(metadataBytes <= SPATIAL_RENDER_LIMITS.metadataBytes, "Spatial batch evidence exceeded its total byte budget.");
        batchFiles.push(metadataPath);
      });
      await rm(batchDirectory, { recursive: true });
    }
    stage = "encode";
    const outputPath = join(directory, plan.request.selection.kind === "video" ? "output.mov" : "output.png");
    let encodedEvidence: SpatialEncodedVideoEvidence | undefined, probePath: string | undefined;
    if (plan.request.selection.kind === "video") {
      const rate = plan.request.selection.frameRate;
      const result = await runner.run([mediaCapabilityCommand(capabilities, "ffmpeg"), "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
        "-framerate", `${rate.numerator}/${rate.denominator}`, "-start_number", "0", "-i", join(frameDirectory, "frame-%08d.png"),
        "-frames:v", String(plan.samples.length), "-an", "-c:v", "qtrle", "-pix_fmt", "argb", "-fps_mode", "passthrough",
        "-enc_time_base", `${rate.denominator}/${rate.numerator}`, "-video_track_timescale", String(rate.numerator),
        "-movflags", "+faststart", "-fs", String(plan.costs.outputBytesBound), outputPath],
      { cwd: directory, stdin: "ignore", timeoutMs: SPATIAL_RENDER_LIMITS.nativeTimeoutMs, maxOutputBytes: 64 * 1024 });
      checked(result.exitCode === 0, `Spatial qtrle encoding failed: ${result.stderr.slice(0, 2_048)}`);
      await readPhysical(outputPath, plan.costs.outputBytesBound, context.abortSignal);
      const probe = await runner.run([mediaCapabilityCommand(capabilities, "ffprobe"), "-v", "error", "-show_streams", "-show_frames", "-show_entries",
        "stream=index,codec_type,codec_name,width,height,pix_fmt,r_frame_rate,avg_frame_rate,time_base,start_pts,duration_ts,nb_frames,color_space,color_transfer,color_primaries,color_range:frame=stream_index,pts,best_effort_timestamp,pkt_duration,duration", "-of", "json", outputPath],
      { cwd: directory, stdin: "ignore", timeoutMs: SPATIAL_RENDER_LIMITS.nativeTimeoutMs, maxOutputBytes: SPATIAL_RENDER_LIMITS.probeBytes });
      checked(probe.exitCode === 0 && Buffer.byteLength(probe.stdout) <= SPATIAL_RENDER_LIMITS.probeBytes, "Spatial encoded-video probing failed or exceeded its byte budget.");
      const value: unknown = JSON.parse(probe.stdout);
      encodedEvidence = verifySpatialEncodedVideo(plan, value);
      probePath = join(directory, "encoded-probe.json");
      await stageJson(probePath, value, SPATIAL_RENDER_LIMITS.probeBytes);
    } else if (plan.request.selection.kind === "contact-sheet") {
      const selection = plan.request.selection;
      const tiles: { input: Buffer; top: number; left: number }[] = [];
      for (const sample of plan.samples) {
        const bytes = await readPhysical(join(frameDirectory, frameName(sample.index)), plan.costs.pngBytesBound, context.abortSignal);
        const tile = await sharp(bytes).resize(selection.cellWidth, selection.cellHeight, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 }, kernel: plan.request.mode.kind === "beauty" ? "lanczos3" : "nearest" }).png().toBuffer();
        tiles.push({ input: tile, left: sample.index % selection.columns * selection.cellWidth, top: Math.floor(sample.index / selection.columns) * selection.cellHeight });
      }
      const bytes = await sharp({ create: { width: plan.outputWidth, height: plan.outputHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(tiles).png().toBuffer();
      checked(bytes.length <= plan.costs.outputBytesBound, "Contact sheet exceeded its admitted output-byte estimate.");
      await stageBytes(outputPath, bytes);
    } else {
      await stageBytes(outputPath, await readPhysical(join(frameDirectory, frameName(0)), plan.costs.outputBytesBound, context.abortSignal));
    }
    await assertCustody();
    const scenePath = join(directory, "scene.json"), runtimePath = join(directory, "runtime.json");
    const sceneBytes = await stageJson(scenePath, plan.scene, 2_097_153);
    const runtimeBytes = await stageJson(runtimePath, runtime, SPATIAL_RENDER_LIMITS.metadataBytes);
    checked(metadataBytes + sceneBytes.length + runtimeBytes.length <= SPATIAL_RENDER_LIMITS.metadataBytes, "Combined spatial source/runtime/batch evidence exceeds the admitted metadata budget.");
    stage = "publication";
    const publish = async (stagedPath: string, extension: string, maximumBytes: number): Promise<MediaArtifactReference> => {
      const bytes = await readPhysical(stagedPath, maximumBytes, context.abortSignal);
      uncertainPublication = prospective(context, "outputs", extension, bytes);
      const result = await (dependencies.publishMedia ?? publishContentAddressedMedia)({ context, stagedPath, extension, maximumBytes, beforePublication: assertCustody });
      checked(canonicalJson(result.artifact) === canonicalJson(uncertainPublication), "Published spatial artifact differs from its staged content address.");
      published.push(result.artifact);
      await assertCustody();
      await durability.syncExactFile(result.artifact.path, result.artifact);
      await assertCustody();
      uncertainPublication = undefined;
      return result.artifact;
    };
    if (originalSceneArtifact !== undefined) {
      await assertCustody();
      await durability.syncExactFile(originalSceneArtifact.path, originalSceneArtifact);
    }
    const sceneSource = await publish(scenePath, ".json", 2_097_153);
    const runtimeArtifact = await publish(runtimePath, ".json", SPATIAL_RENDER_LIMITS.metadataBytes);
    const retainedAssets: SpatialRetainedAsset[] = [];
    for (const source of retainedSources) retainedAssets.push({ assetId: source.assetId, manifestSha256: source.manifestSha256, originalPath: source.originalPath,
      artifact: await publish(source.stagedPath, ".bin", source.bytes) });
    const batches: MediaArtifactReference[] = [];
    for (const path of batchFiles) batches.push(await publish(path, ".json", SPATIAL_RENDER_LIMITS.metadataBytes));
    const encodedProbe = probePath === undefined ? undefined : await publish(probePath, ".json", SPATIAL_RENDER_LIMITS.probeBytes);
    const artifact = await publish(outputPath, plan.request.selection.kind === "video" ? ".mov" : ".png", plan.costs.outputBytesBound);
    const frameArtifacts: MediaArtifactReference[] = [];
    if (plan.request.selection.kind === "frame") frameArtifacts.push(artifact);
    else if (plan.request.selection.kind === "contact-sheet") {
      for (const sample of plan.samples) frameArtifacts.push(await publish(join(frameDirectory, frameName(sample.index)), ".png", plan.costs.pngBytesBound));
    }
    const render: SpatialRenderResult["render"] = { kind: plan.request.selection.kind, frameCount: plan.samples.length, width: plan.outputWidth, height: plan.outputHeight,
      ...(encodedEvidence === undefined ? {} : { frameRate: encodedEvidence.frameRate, encodedEvidence }) };
    const receiptValue = SpatialRenderReceiptSchema.parse({
      kind: "atet.spatial-render-receipt", schemaVersion: 1, attemptId, sceneSha256: plan.sceneSha256,
      source: { canonicalScene: sceneSource, canonicalization: "parsed-spatial-scene-v1", ...(originalSceneArtifact === undefined ? {} : { originalSceneArtifact }), retainedAssets, sourceManifests },
      request: plan.request, requestSha256: plan.requestSha256, samples: sampleEvidence, render, output: artifact, batches, frameArtifacts,
      runtime: { artifact: runtimeArtifact, rootSha256: runtime.manifest.rootSha256, capabilities, renderer: "three-webgl2-snapshot-v1", threeVersion: "0.185.1" },
      color: { output: plan.request.mode.kind === "beauty" ? "srgb" : "rgba8-data", alpha: plan.request.mode.kind === "beauty" ? "straight" : "binary-validity", toneMapping: "none" },
      timing: { sourceClock: "absolute-rational-microseconds", quantization: "independent-nearest-microsecond-ties-positive", encodedClock: "zero-based-uniform-frame-intervals",
        ...(plan.outputDurationUs === undefined ? {} : { outputDurationUs: plan.outputDurationUs }) },
      calibratedSourceDimensions: { width: plan.width, height: plan.height },
      ...(plan.request.selection.kind === "contact-sheet" ? { contactSheet: { fit: "contain", resampling: plan.request.mode.kind === "beauty" ? "lanczos3" : "nearest-data", calibratedProjectionResized: false } } : {}),
      ...(encodedProbe === undefined ? {} : { encodedProbe }),
      ...(context.workflow === undefined ? {} : { workflow: { nodeKey: context.workflow.nodeKey, nodePlanSha256: context.workflow.nodePlanSha256, runId: context.workflow.runId } }),
      costs: { ...plan.costs, actualPngBytes: pngBytes, actualBatchMetadataBytes: metadataBytes },
    });
    const receiptBytes = new TextEncoder().encode(`${canonicalJson(receiptValue)}\n`);
    checked(receiptBytes.length <= 1024 * 1024, "Spatial completion receipt exceeds its byte budget.");
    uncertainPublication = prospective(context, "receipts", ".json", receiptBytes);
    const receipt = await (dependencies.publishReceipt ?? publishContentAddressedReceipt)({ context, receipt: receiptValue, workspace: { path: directory, dispose: () => Promise.resolve() }, beforePublication: assertCustody });
    checked(canonicalJson(receipt) === canonicalJson(uncertainPublication), "Published spatial receipt differs from its staged content address.");
    published.push(receipt);
    await assertCustody();
    await durability.syncExactFile(receipt.path, receipt);
    uncertainPublication = undefined;
    completed = deepFreezeJson(SpatialRenderOutputSchema.parse({ artifact, receipt, sceneSource, retainedAssets, render }));
  } catch (error) { failure = error; failed = true; }
  finally {
    // Every render/preparation/native promise has settled before staging is removed.
    if (directory !== undefined) try { await rm(directory, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
    try { await workspace.dispose(); } catch (error) { cleanupErrors.push(error); }
  }
  if (failed || cleanupErrors.length > 0) throw new SpatialRenderFailure(failed ? failure : cleanupErrors[0], {
    attemptId, stage: failed ? stage : "cleanup", published,
    ...(uncertainPublication === undefined ? {} : { uncertainPublication }), ...(completed === undefined ? {} : { completion: completed }),
  }, cleanupErrors);
  checked(completed !== undefined, "Spatial render did not produce completion evidence.");
  return completed;
}

function frameName(index: number): string { return `frame-${String(index).padStart(8, "0")}.png`; }
function prospective(context: OperationExecutionContext, category: "outputs" | "receipts", extension: string, bytes: Uint8Array): MediaArtifactReference {
  const digest = sha256(bytes);
  return MediaArtifactReferenceSchema.parse({ sha256: digest, bytes: bytes.length,
    path: relative(context.application.paths.repositoryRoot, join(dirname(context.application.paths.artifactRoot), `generated/media-operations/${category}`, `${digest}${extension}`)),
  });
}
