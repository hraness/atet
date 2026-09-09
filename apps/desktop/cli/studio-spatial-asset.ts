import { lstat, opendir } from "node:fs/promises";
import { join, relative } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { boundedCanonicalJsonSha256 } from "../../../src/code/canonical-json";
import { createBoundedJsonValueSnapshot } from "../../../src/code/json-snapshot";
import { SpatialAssetIdSchema, SpatialAssetInterpretationSchema, SpatialAssetManifestSchema, SpatialDigestSchema, SpatialPayloadSchema, type SpatialAssetManifest } from "../../../src/spatial-scene/contracts";
import { parseSpatialGlb, SPATIAL_GLB_PROFILE } from "../../../src/spatial-scene/gltf";
import { parseStudioPlan, StudioPathSchema, StudioRenderSchema, validateStudioReceipt } from "../../../src/studio";
import { ExactCapabilityBindingsSchema } from "../application/capability-binding";
import type { ApplicationContext } from "../application/context";
import { bindRepositoryMedia, loadRepositoryMedia, MediaArtifactReferenceSchema, type MediaArtifactReference } from "../application/operations/media/shared";
import { StudioRunOutputSchema } from "../application/studio-port";
import { createNodeBundleFileSystem } from "../core/storage";
import { CliError } from "./errors";
import { ensurePhysicalPrivateDirectoryWithin } from "./paths";
import { verifyStudioFramehash } from "./studio-encode";
import { studioBytesSha256, studioJson } from "./studio-files";
import { studioStorageRoot, type createStudioService } from "./studio-service";

const DOCUMENT_BYTES = 32 * 1024 * 1024;
const ASSET_BYTES = 128 * 1024 * 1024;
const hash = (value: unknown) => boundedCanonicalJsonSha256(value, { maximumBytes: DOCUMENT_BYTES, maximumDepth: 48, maximumValues: 1_000_000 });
const captured = (value: unknown) => createBoundedJsonValueSnapshot(value, DOCUMENT_BYTES, "studio asset document", { maximumDepth: 48, maximumValues: 1_000_000 }).value;
export const StudioSpatialAssetSelectionSchema = z.strictObject({
  jobId: z.string().regex(/^studio_[a-zA-Z0-9][a-zA-Z0-9_-]{0,120}$/u), outputId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u),
  representation: z.enum(["native", "encoded-video"]), frame: z.number().int().nonnegative().max(999_999).optional(),
}).refine(value => value.representation !== "encoded-video" || value.frame === undefined, "Encoded videos select the complete sequence, not one frame.");
export type StudioSpatialAssetSelection = z.infer<typeof StudioSpatialAssetSelectionSchema>;
export const StudioSpatialAssetReceiptSchema = z.strictObject({
  kind: z.literal("atet.studio-spatial-asset-receipt"), schemaVersion: z.literal(1),
  selection: StudioSpatialAssetSelectionSchema, assetId: SpatialAssetIdSchema,
  nativeReceipt: MediaArtifactReferenceSchema, planSha256: SpatialDigestSchema, bundleSha256: SpatialDigestSchema,
  nativeOutputsSha256: SpatialDigestSchema, encodeReceipt: MediaArtifactReferenceSchema.optional(),
  artifact: MediaArtifactReferenceSchema, payload: SpatialPayloadSchema, interpretation: SpatialAssetInterpretationSchema,
  compatibility: z.enum([SPATIAL_GLB_PROFILE, "atet.spatial-png-srgb8-v1", "atet.spatial-studio-rgb-video-v1"]),
}).superRefine((value, context) => {
  const image = value.compatibility === "atet.spatial-png-srgb8-v1" && value.interpretation.kind === "image" && value.interpretation.mimeType === "image/png";
  const model = value.compatibility === SPATIAL_GLB_PROFILE && value.interpretation.kind === "gltf" && value.interpretation.format === "glb";
  const video = value.compatibility === "atet.spatial-studio-rgb-video-v1" && value.interpretation.kind === "video";
  const extension = model ? "glb" : image ? "png" : video && value.interpretation.kind === "video" && value.interpretation.alpha === "straight" ? "mov" : "mp4";
  if ((!image && !model && !video) || video !== (value.selection.representation === "encoded-video") || video !== (value.encodeReceipt !== undefined)
    || value.payload.sha256 !== value.artifact.sha256 || value.payload.bytes !== value.artifact.bytes || value.payload.path !== `studio/${value.artifact.sha256}.${extension}`) {
    context.addIssue({ code: "custom", message: "Studio asset payload, interpretation, representation and compatibility evidence disagree." });
  }
});
export type StudioSpatialAssetReceipt = z.infer<typeof StudioSpatialAssetReceiptSchema>;
export interface StudioSpatialAssetAdmissionInput {
  readonly application: ApplicationContext;
  readonly service: Pick<ReturnType<typeof createStudioService>, "inspect">;
  readonly selection: StudioSpatialAssetSelection; readonly assetId: string; readonly signal: AbortSignal;
  beforePublication(): Promise<void>;
}
export interface StudioSpatialAssetAdmission {
  readonly asset: SpatialAssetManifest;
  readonly binding: { readonly assetId: string; readonly artifact: MediaArtifactReference };
  readonly receipt: MediaArtifactReference; readonly document: StudioSpatialAssetReceipt;
}

// This is the retained encoder's closed v1 evidence shape. Admission rederives
// source/settings identity and verifies its files; it does not bind or run tools.
const encodeRequestSchema = z.strictObject({
  kind: z.literal("atet.studio-encode-request"), schemaVersion: z.literal(1), planSha256: SpatialDigestSchema, nativeReceipt: MediaArtifactReferenceSchema,
  jobId: z.string(), outputId: z.string(), render: StudioRenderSchema,
  frames: z.array(z.strictObject({ path: StudioPathSchema, frame: z.number().int().nonnegative(), sha256: SpatialDigestSchema, bytes: z.number().int().safe().positive() })).min(1).max(216_000),
  profile: z.enum(["rgb8-lossless-h264-v1", "rgba8-lossless-qtrle-v1"]), conversion: z.enum(["identity-uint8", "ffmpeg-no-dither-uint16-to-uint8-v1"]),
  colorSpace: z.literal("srgb"), alpha: z.enum(["opaque", "straight"]), tools: ExactCapabilityBindingsSchema,
  limits: z.strictObject({ timeoutMs: z.number().int().positive().max(300_000), maximumOutputBytes: z.number().int().positive().max(512 * 1024 * 1024) }),
});
const encodeReceiptSchema = z.strictObject({
  kind: z.literal("atet.studio-encode-receipt"), schemaVersion: z.literal(1), requestSha256: SpatialDigestSchema, request: encodeRequestSchema,
  artifact: MediaArtifactReferenceSchema, verification: z.strictObject({ frameCount: z.number().int().positive(), canonicalFrameSha256: SpatialDigestSchema,
    sourceFramehash: MediaArtifactReferenceSchema, videoFramehash: MediaArtifactReferenceSchema, probe: MediaArtifactReferenceSchema }),
});
const encodedProbeSchema = z.object({ streams: z.array(z.object({
  codec_type: z.literal("video"), codec_name: z.string(), pix_fmt: z.string(), width: z.number().int(), height: z.number().int(),
  avg_frame_rate: z.string().max(32), time_base: z.string().max(32), start_pts: z.literal(0), duration_ts: z.number().int().safe().positive(), nb_read_frames: z.string().max(16),
  color_range: z.string().max(32).optional(), color_space: z.string().max(32).optional(), color_transfer: z.string().max(32).optional(), color_primaries: z.string().max(32).optional(),
})).length(1) });
const absent = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
function unsupported(message: string): never { throw new CliError("unsupported-plan", message); }
function conflict(message: string): never { throw new CliError("conflict", message); }

/** Untagged pixels use the authored sRGB interpretation; conflicting explicit tags reject. */
function assertSrgbPngTags(bytes: Uint8Array): void {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.length < 33 || data.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") unsupported("Expected a bounded PNG image.");
  let cursor = 8, count = 0;
  while (cursor < data.length) {
    if (++count > 65_536 || cursor + 12 > data.length) unsupported("PNG chunk envelope exceeds its bounded profile.");
    const length = data.readUInt32BE(cursor), type = data.toString("ascii", cursor + 4, cursor + 8);
    if (length > data.length - cursor - 12) unsupported("PNG chunk exceeds its retained bytes.");
    if (type === "gAMA" && (length !== 4 || data.readUInt32BE(cursor + 8) !== 45455)) unsupported("PNG gamma contradicts its declared sRGB interpretation.");
    if (type === "cHRM" && (length !== 32 || [31270,32900,64000,33000,30000,60000,15000,6000].some((value, i) => data.readUInt32BE(cursor + 8 + i * 4) !== value))) unsupported("PNG primaries contradict its declared sRGB interpretation.");
    if (type === "sRGB" && (length !== 1 || data[cursor + 8]! > 3)) unsupported("PNG sRGB intent is invalid.");
    cursor += length + 12;
  }
}

/** Admit an existing native output or completed encode into the existing scene asset contract. */
export async function admitStudioSpatialAsset(input: StudioSpatialAssetAdmissionInput): Promise<StudioSpatialAssetAdmission> {
  const selection = StudioSpatialAssetSelectionSchema.parse(captured(input.selection)), assetId = SpatialAssetIdSchema.parse(input.assetId);
  const { application, signal } = input;
  const fence = async () => {
    if (signal.aborted) throw new CliError("cancelled", "Studio asset admission was cancelled.");
    await application.hostResourceLease?.assertOwned(); await input.beforePublication(); await application.hostResourceLease?.assertOwned();
    if (signal.aborted) throw new CliError("cancelled", "Studio asset admission was cancelled.");
  };
  await fence();
  const native = StudioRunOutputSchema.parse(await input.service.inspect(selection.jobId));
  const root = await studioStorageRoot(application), jobRoot = join(root, "jobs", selection.jobId), jobFs = createNodeBundleFileSystem(jobRoot);
  const plan = parseStudioPlan(JSON.parse(await jobFs.readText("plan.json", DOCUMENT_BYTES)) as unknown);
  const original = validateStudioReceipt({ plan, receipt: native.document });
  if (original.state !== "succeeded" || original.jobId !== selection.jobId) unsupported("Scene assets require a successful retained Studio job.");
  const expectedReceiptPath = relative(application.paths.repositoryRoot, join(jobRoot, "receipt.json"));
  if (native.receipt.path !== expectedReceiptPath) conflict("Native receipt is outside its exact retained job.");
  const evidence: MediaArtifactReference[] = [];
  const load = async (reference: MediaArtifactReference, maximumBytes = DOCUMENT_BYTES) => {
    const result = await loadRepositoryMedia(application, reference, signal, maximumBytes); evidence.push(result.artifact); return result.data;
  };
  const json = async (reference: MediaArtifactReference) => captured(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await load(reference))) as unknown);
  if (studioJson(await json(native.receipt)) !== studioJson(original)) conflict("Native receipt bytes disagree with inspection.");
  const spec = plan.job.outputs.find(item => item.id === selection.outputId);
  if (spec === undefined) unsupported("The requested output ID is not declared by this Studio job.");
  const selected = original.outputs.filter(item => item.outputId === selection.outputId).sort((a, b) => (a.frame ?? 0) - (b.frame ?? 0));
  let artifact: MediaArtifactReference, interpretation: StudioSpatialAssetReceipt["interpretation"], compatibility: StudioSpatialAssetReceipt["compatibility"], encodeReceipt: MediaArtifactReference | undefined;
  let extension: string;
  if (selection.representation === "native") {
    if (spec.kind === "sequence" ? selection.frame === undefined : selection.frame !== undefined) unsupported("Native sequences require an exact --frame; native files do not accept --frame.");
    const files = selected.filter(item => selection.frame === undefined || item.frame === selection.frame);
    if (files.length !== 1) unsupported("The selection must name exactly one retained output file.");
    const file = files[0]!;
    artifact = MediaArtifactReferenceSchema.parse({ path: relative(application.paths.repositoryRoot, join(jobRoot, "outputs", file.path)), sha256: file.sha256, bytes: file.bytes });
    const bytes = await load(artifact, ASSET_BYTES);
    if (spec.format === "glb" && spec.interpretation.kind === "model") {
      if (spec.interpretation.sourceSpace.handedness !== "right") unsupported("Spatial GLB admission requires declared right-handed source coordinates.");
      const space = spec.interpretation.sourceSpace;
      const metersPerUnit = { meters: 1, centimeters: 0.01, millimeters: 0.001 }[space.units];
      try {
        const geometry = parseSpatialGlb(bytes).evaluate({ metersPerUnit, sourceUp: space.upAxis, timeUs: 0, materialMode: "source" });
        for (const image of geometry.images) {
          if (image.mimeType === "image/png") assertSrgbPngTags(image.bytes);
          const decoder = sharp(image.bytes, { limitInputPixels: 33_554_432, failOn: "warning" }), metadata = await decoder.metadata();
          if ((metadata.format !== "png" && metadata.format !== "jpeg") || (metadata.pages ?? 1) !== 1 || metadata.orientation !== undefined && metadata.orientation !== 1
            || metadata.depth !== "uchar" || metadata.icc !== undefined || metadata.width !== image.width || metadata.height !== image.height || image.width > 8192 || image.height > 8192) unsupported("GLB base-color textures must fit the scene's unrotated 8-bit SDR image profile.");
          await decoder.raw().toBuffer();
        }
      } catch (error) {
        unsupported(`GLB is outside ${SPATIAL_GLB_PROFILE}: ${error instanceof Error ? error.message.slice(0, 2_048) : "invalid GLB"}. Keep detailed rigs and unsupported materials in native Studio.`);
      }
      interpretation = { kind: "gltf", format: "glb", metersPerUnit, sourceUp: space.upAxis };
      compatibility = SPATIAL_GLB_PROFILE; extension = "glb";
    } else if (spec.format === "png" && spec.interpretation.kind === "raster") {
      const info = spec.interpretation, render = plan.job.render!;
      if (info.semantic !== "color" || info.colorSpace !== "srgb" || info.dataType !== "uint8" || !["opaque", "straight"].includes(info.alpha)
        || info.channels.join(",") !== (info.alpha === "straight" ? "R,G,B,A" : "R,G,B")) unsupported("Spatial images require an 8-bit sRGB RGB or straight RGBA PNG; preserve higher precision and data passes as native outputs.");
      assertSrgbPngTags(bytes);
      const image = sharp(bytes, { limitInputPixels: 33_554_432, failOn: "warning" }), metadata = await image.metadata();
      if (metadata.format !== "png" || (metadata.pages ?? 1) !== 1 || metadata.orientation !== undefined && metadata.orientation !== 1 || metadata.depth !== "uchar" || metadata.icc !== undefined
        || metadata.width !== render.width || metadata.height !== render.height || metadata.width > 8192 || metadata.height > 8192 || metadata.channels !== info.channels.length || Boolean(metadata.hasAlpha) !== (info.alpha === "straight")) unsupported("PNG pixels, dimensions or color metadata differ from the supported scene interpretation.");
      await image.raw().toBuffer();
      interpretation = { kind: "image", mimeType: "image/png", width: render.width, height: render.height, colorSpace: "srgb", alpha: info.alpha === "straight" ? "straight" : "opaque" };
      compatibility = "atet.spatial-png-srgb8-v1"; extension = "png";
    } else unsupported("Native scene admission currently supports GLB and color PNG. Use explicit studio encode before admitting a PNG sequence as video.");
  } else {
    const raster = spec.interpretation, render = plan.job.render;
    if (spec.kind !== "sequence" || spec.format !== "png" || raster.kind !== "raster" || render === undefined || raster.semantic !== "color" || raster.colorSpace !== "srgb"
      || !["uint8", "uint16"].includes(raster.dataType) || !["opaque", "straight"].includes(raster.alpha) || raster.channels.join(",") !== (raster.alpha === "straight" ? "R,G,B,A" : "R,G,B")) unsupported("Encoded-video admission requires a declared sRGB PNG sequence and its completed studio encode receipt.");
    const candidates: { receipt: MediaArtifactReference; document: z.infer<typeof encodeReceiptSchema> }[] = [];
    let entries = 0, documentBytes = 0;
    let derivatives;
    try {
      const path = join(jobRoot, "derivatives"), stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) conflict("Studio derivatives require the exact physical job directory.");
      derivatives = await opendir(path);
    } catch (error) { if (!absent(error)) throw error; }
    if (derivatives !== undefined) {
      for await (const entry of derivatives) {
        await fence();
        if (++entries > 64 || !entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name)) conflict("Studio derivative inventory is invalid or exceeds 64 entries.");
        const path = `derivatives/${entry.name}/receipt.json`;
        let integrity;
        try { integrity = await jobFs.inspectFile!(path, DOCUMENT_BYTES - documentBytes); } catch (error) { if (absent(error)) continue; throw error; }
        documentBytes += integrity.bytes;
        const receipt = { path: relative(application.paths.repositoryRoot, join(jobRoot, path)), ...integrity };
        const document = encodeReceiptSchema.parse(await json(receipt));
        if (document.requestSha256 !== entry.name || hash(document.request) !== entry.name || document.request.jobId !== selection.jobId) conflict("Retained encode identity differs from its exact job and request directory.");
        if (document.request.outputId === selection.outputId) candidates.push({ receipt, document });
      }
    }
    if (candidates.length === 0) unsupported("No completed encoded video exists for this output. Run studio encode explicitly first.");
    if (candidates.length !== 1) conflict(`More than one completed encode matches; choose an unambiguous retained job. Matching request identities: ${candidates.map(item => item.document.requestSha256).join(", ")}`);
    const candidate = candidates[0]!, encoded = candidate.document, request = encoded.request, alpha = raster.alpha === "straight";
    encodeReceipt = candidate.receipt;
    const frames = selected.map(item => ({ path: item.path, frame: item.frame!, sha256: item.sha256, bytes: item.bytes }));
    const expected = { ...request, planSha256: plan.planSha256, nativeReceipt: native.receipt, jobId: selection.jobId, outputId: selection.outputId, render, frames,
      profile: alpha ? "rgba8-lossless-qtrle-v1" : "rgb8-lossless-h264-v1", conversion: raster.dataType === "uint16" ? "ffmpeg-no-dither-uint16-to-uint8-v1" : "identity-uint8", colorSpace: "srgb", alpha: alpha ? "straight" : "opaque",
      limits: { timeoutMs: Math.min(plan.job.limits.timeoutSeconds * 1000, 300_000), maximumOutputBytes: Math.min(plan.job.limits.maximumOutputBytes, 512 * 1024 * 1024) } };
    if (hash(expected) !== encoded.requestSha256 || request.tools.length !== 2 || !request.tools.some(tool => tool.name === "ffmpeg") || !request.tools.some(tool => tool.name === "ffprobe")) conflict("Encoded video no longer matches its native sources, settings or tool evidence.");
    const directory = join(jobRoot, "derivatives", encoded.requestSha256), fs = createNodeBundleFileSystem(directory);
    const intent = { path: relative(application.paths.repositoryRoot, join(directory, "intent.json")), ...await fs.inspectFile!("intent.json", DOCUMENT_BYTES) };
    if (studioJson(await json(intent)) !== studioJson({ kind: "atet.studio-encode-intent", schemaVersion: 1, requestSha256: encoded.requestSha256, request })) conflict("Encode receipt differs from its retained immutable intent.");
    extension = alpha ? "mov" : "mp4";
    const files = [[encoded.artifact, `video.${extension}`], [encoded.verification.sourceFramehash, "source.framehash"], [encoded.verification.videoFramehash, "video.framehash"], [encoded.verification.probe, "probe.json"]] as const;
    for (const [reference, name] of files) if (reference.path !== relative(application.paths.repositoryRoot, join(directory, name))) conflict("Encode evidence is outside its exact derivative directory.");
    artifact = encoded.artifact;
    const video = await load(artifact, Math.min(ASSET_BYTES, request.limits.maximumOutputBytes));
    if (video.length < 12 || new TextDecoder().decode(video.subarray(4, 8)) !== "ftyp") unsupported("Encoded video must be self-contained ISO-BMFF MP4 or QuickTime.");
    const text = async (ref: MediaArtifactReference) => new TextDecoder("utf-8", { fatal: true }).decode(await load(ref, 4_194_304));
    const firstHash = verifyStudioFramehash(await text(encoded.verification.sourceFramehash), render, alpha);
    if (firstHash !== encoded.verification.canonicalFrameSha256 || firstHash !== verifyStudioFramehash(await text(encoded.verification.videoFramehash), render, alpha)
      || encoded.verification.frameCount !== frames.length) conflict("Encoded pixel evidence differs from the retained native sequence.");
    const stream = encodedProbeSchema.parse(await json(encoded.verification.probe)).streams[0]!;
    const rate = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(stream.avg_frame_rate), base = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(stream.time_base);
    const matchesColor = alpha
      ? (stream.color_transfer === undefined || ["unknown", "iec61966-2-1"].includes(stream.color_transfer))
        && (stream.color_primaries === undefined || ["unknown", "bt709"].includes(stream.color_primaries))
        && (stream.color_space === undefined || ["unknown", "gbr"].includes(stream.color_space))
        && (stream.color_range === undefined || ["unknown", "pc"].includes(stream.color_range))
      : stream.color_range === "pc" && stream.color_space === "gbr" && stream.color_transfer === "iec61966-2-1" && stream.color_primaries === "bt709";
    if (rate === null || base === null || stream.width !== render.width || stream.height !== render.height || stream.codec_name !== (alpha ? "qtrle" : "h264") || stream.pix_fmt !== (alpha ? "argb" : "gbrp")
      || !matchesColor || stream.nb_read_frames !== String(frames.length) || BigInt(rate[1]!) * BigInt(render.frameRate.denominator) !== BigInt(rate[2]!) * BigInt(render.frameRate.numerator)
      || BigInt(stream.duration_ts) * BigInt(base[1]!) * BigInt(render.frameRate.numerator) !== BigInt(frames.length) * BigInt(render.frameRate.denominator) * BigInt(base[2]!)) conflict("Encoded probe evidence differs from the source's exact video clock and pixel profile.");
    const n = BigInt(frames.length) * BigInt(render.frameRate.denominator) * 1_000_000n, d = BigInt(render.frameRate.numerator);
    interpretation = { kind: "video", width: render.width, height: render.height, colorSpace: "srgb", alpha: alpha ? "straight" : "opaque", durationUs: Number((2n * n + d) / (2n * d)), frameRate: render.frameRate };
    compatibility = "atet.spatial-studio-rgb-video-v1";
  }
  const document = StudioSpatialAssetReceiptSchema.parse({ kind: "atet.studio-spatial-asset-receipt", schemaVersion: 1, selection, assetId,
    nativeReceipt: native.receipt, planSha256: plan.planSha256, bundleSha256: plan.bundleSha256, nativeOutputsSha256: hash(selected),
    ...(encodeReceipt === undefined ? {} : { encodeReceipt }), artifact, payload: { path: `studio/${artifact.sha256}.${extension}`, sha256: artifact.sha256, bytes: artifact.bytes }, interpretation, compatibility });
  const verify = async () => {
    await fence();
    if (studioJson(StudioRunOutputSchema.parse(await input.service.inspect(selection.jobId))) !== studioJson(native)
      || studioJson(parseStudioPlan(JSON.parse(await jobFs.readText("plan.json", DOCUMENT_BYTES)) as unknown)) !== studioJson(plan)) conflict("Native source provenance changed during asset admission.");
    for (const reference of evidence) await bindRepositoryMedia(application, reference, signal, Math.max(ASSET_BYTES, DOCUMENT_BYTES));
  };
  await verify();
  const directory = await ensurePhysicalPrivateDirectoryWithin(root, `assets/${hash(document)}`), fs = createNodeBundleFileSystem(directory), serialized = studioJson(document);
  const disposition = await fs.writeTextNoReplace!("receipt.json", serialized, verify);
  if (disposition !== "created" && await fs.readText("receipt.json", DOCUMENT_BYTES) !== serialized) conflict("Retained scene asset admission receipt conflicts with its immutable identity.");
  await verify();
  const receipt = MediaArtifactReferenceSchema.parse({ path: relative(application.paths.repositoryRoot, join(directory, "receipt.json")), ...await fs.inspectFile!("receipt.json", DOCUMENT_BYTES) });
  if (receipt.sha256 !== studioBytesSha256(serialized) || receipt.bytes !== Buffer.byteLength(serialized)) conflict("Retained admission receipt changed before completion.");
  await fence();
  const asset = SpatialAssetManifestSchema.parse({ assetId, payload: document.payload, interpretation: document.interpretation, dependencies: [],
    provenance: { source: selection.representation === "encoded-video" ? "derived" : "generated", description: `Studio ${selection.jobId}/${selection.outputId}${selection.frame === undefined ? "" : ` frame ${selection.frame}`}; ${compatibility}`, receiptSha256: receipt.sha256 } });
  return { asset, binding: { assetId, artifact }, receipt, document };
}
