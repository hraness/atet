import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import sharp from "sharp";
import { z } from "zod";

import type { ApplicationContext } from "../application/context";
import { DirectingEndpointSchema, directingPtsTimeUs, type DirectingEndpoint } from "../application/directing-contract";
import { GatewayMediaSourceReferenceSchema, type GatewayMediaSourceReference } from "../application/gateway-port";
import { loadRepositoryMedia } from "../application/operations/media/shared";
import { ProjectAssetV1Schema, ProjectEditPlanV1Schema, RepositoryRelativePathSchema, Sha256Schema, VideoProjectV1Schema, type ProjectAssetV1 } from "../contracts";
import { canonicalJson, sha256Hex } from "../core/canonical-json";
import { createDefaultProjectEditPlan } from "../core/project-plan";
import { createNodeBundleFileSystem } from "../core/storage";
import { CliError } from "./errors";
import { parseMediaProbe, type ProbedMedia } from "./media-ingest";
import { withMutationLock } from "./mutation-lock";
import { ensurePhysicalPrivateDirectoryWithin } from "./paths";
import { resolveVerifiedProjectMedia } from "./project-media-integrity";

const LIMITS = { videoBytes: 512 * 1024 * 1024, imageBytes: 30 * 1024 * 1024, probeBytes: 8 * 1024 * 1024, dimension: 4096, frames: 4000, durationUs: 60_000_000 } as const;
const INPUT_ARGUMENTS = ["-protocol_whitelist", "file", "-format_whitelist", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-max_pixels", String(LIMITS.dimension ** 2), "-threads", "2"] as const;
const artifactSchema = z.strictObject({ path: RepositoryRelativePathSchema, bytes: z.number().int().safe().positive(), sha256: Sha256Schema });
const endpointSchema = DirectingEndpointSchema.refine(endpoint => endpoint.frameIndex < LIMITS.frames, "Directing endpoint exceeds the 4000-frame media bound.");
export type { DirectingEndpoint } from "../application/directing-contract";
const colorSchema = z.strictObject({
  policy: z.enum(["bt709-to-srgb-v1", "untagged-8bit-yuv-assume-bt709-v1", "rgb-srgb-v1"]),
  observed: z.strictObject({ pixelFormat: z.string(), range: z.string().nullable(), transfer: z.string().nullable(), primaries: z.string().nullable(), matrix: z.string().nullable() }),
  assumptions: z.array(z.enum(["bt709-transfer", "bt709-primaries", "bt709-matrix", "limited-range", "srgb-transfer"])).max(5),
});
type ColorInterpretation = z.infer<typeof colorSchema>;
const endpointReceiptSchema = z.strictObject({
  kind: z.literal("atet.directing-endpoint"), schemaVersion: z.literal(1), requestSha256: Sha256Schema,
  position: z.enum(["first", "last"]), endpoint: endpointSchema,
  color: colorSchema,
  ffmpegVersion: z.string().min(1).max(512), ffprobeVersion: z.string().min(1).max(512),
});
const clipSchema = z.strictObject({
  shotId: z.string().min(1).max(128), attemptId: z.string().min(1).max(128),
  source: GatewayMediaSourceReferenceSchema, durationUs: z.number().int().positive().max(LIMITS.durationUs),
});
const assemblyInputSchema = z.strictObject({
  id: z.string().min(1).max(128), title: z.string().trim().min(1).max(512),
  clips: z.array(clipSchema).min(1).max(128), recipeSha256: Sha256Schema,
}).superRefine((input, context) => {
  if (new Set(input.clips.map(clip => clip.shotId)).size !== input.clips.length) context.addIssue({ code: "custom", message: "Assembly shot IDs must be unique." });
});
export type DirectingAssemblyInput = z.input<typeof assemblyInputSchema>;
export interface DirectingAssemblyResult {
  readonly projectId: string;
  readonly projectPath: string;
  readonly receipt: z.infer<typeof artifactSchema>;
}
const ASSEMBLY_TIMING_POLICY = "video-span-floor-cumulative-v1" as const;
const timingRangeSchema = z.strictObject({ startUs: z.number().int().safe().nonnegative(), endUs: z.number().int().safe().positive() }).refine(range => range.endUs > range.startUs);
const assemblyTimingSchema = z.strictObject({
  shotId: z.string(), attemptId: z.string(), sourceSha256: Sha256Schema, sourceDurationUs: z.number().int().positive(),
  videoAssetRange: timingRangeSchema, videoDurationSeconds: z.strictObject({ numerator: z.string().regex(/^[1-9]\d*$/u), denominator: z.number().int().positive() }),
  projectRange: timingRangeSchema,
  audio: z.array(z.strictObject({ streamIndex: z.number().int().nonnegative(), sourceAssetRange: timingRangeSchema, selectedAssetRange: timingRangeSchema.nullable(), trimmedBeforeUs: z.number().int().nonnegative(), trimmedAfterUs: z.number().int().nonnegative() })).max(7),
});
const assemblyIntentSchema = z.strictObject({
  kind: z.literal("atet.directing-assembly-intent"), schemaVersion: z.literal(2), requestSha256: Sha256Schema,
  input: assemblyInputSchema, project: VideoProjectV1Schema, plan: ProjectEditPlanV1Schema,
  colors: z.array(z.strictObject({ shotId: z.string(), sourceSha256: Sha256Schema, interpretation: colorSchema })).min(1).max(128),
  normalizations: z.array(artifactSchema).max(128),
  timingPolicy: z.literal(ASSEMBLY_TIMING_POLICY), timing: z.array(assemblyTimingSchema).min(1).max(128),
});
const normalizationSchema = z.strictObject({
  kind: z.literal("atet.directing-rgb-normalization"), schemaVersion: z.literal(1), requestSha256: Sha256Schema,
  input: GatewayMediaSourceReferenceSchema, output: GatewayMediaSourceReferenceSchema, color: colorSchema,
  codec: z.literal("libx264rgb-lossless-v1"), ffmpegVersion: z.string(), frameCount: z.number().int().positive().max(LIMITS.frames),
});
const frameSchema = z.object({
  media_type: z.string(), stream_index: z.number().int().nonnegative(),
  width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
  best_effort_timestamp: z.number().int().safe().optional(),
  duration: z.number().int().positive().optional(), pkt_duration: z.number().int().positive().optional(),
  pix_fmt: z.string().optional(), color_range: z.string().optional(), color_transfer: z.string().optional(), color_primaries: z.string().optional(), color_space: z.string().optional(),
  side_data_list: z.array(z.object({ side_data_type: z.string() })).max(16).optional(),
});
const streamSchema = z.object({
  index: z.number().int().nonnegative(), codec_type: z.string(), codec_name: z.string(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
  avg_frame_rate: z.string().optional(), r_frame_rate: z.string().optional(), duration: z.string().optional(), start_time: z.string().optional(),
  channels: z.number().int().positive().optional(), sample_rate: z.string().optional(),
  disposition: z.object({ attached_pic: z.number().int().min(0).max(1).optional(), still_image: z.number().int().min(0).max(1).optional(), timed_thumbnails: z.number().int().min(0).max(1).optional() }).optional(),
  tags: z.object({ DURATION: z.string().optional(), duration: z.string().optional() }).optional(),
  pix_fmt: z.string().optional(), time_base: z.string().optional(), color_range: z.string().optional(), color_transfer: z.string().optional(), color_primaries: z.string().optional(), color_space: z.string().optional(),
  side_data_list: z.array(z.object({ side_data_type: z.string() })).max(16).optional(),
});
const probeSchema = z.object({ streams: z.array(streamSchema).min(1).max(8), frames: z.array(frameSchema).min(1).max(16_000), format: z.object({ duration: z.string().optional(), format_name: z.string(), start_time: z.string().optional() }) });

function fail(message: string): never { throw new CliError("invalid-data", message); }
async function active(application: ApplicationContext, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new CliError("cancelled", "Directing media operation was cancelled.");
  await application.hostResourceLease?.assertOwned();
}
function repoPath(application: ApplicationContext, path: string): string {
  return RepositoryRelativePathSchema.parse(relative(application.paths.repositoryRoot, path));
}
async function directory(application: ApplicationContext, requested: string): Promise<string> {
  return await ensurePhysicalPrivateDirectoryWithin(await realpath(application.paths.repositoryRoot), requested);
}
async function mediaRoot(application: ApplicationContext): Promise<string> {
  return await directory(application, repoPath(application, join(dirname(application.paths.artifactRoot), "generated", "directing-media")));
}
async function fileBytes(path: string, maximumBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  if (signal.aborted) throw new CliError("cancelled", "Directing media read was cancelled.");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximumBytes)) fail("Directing media must be one bounded physical regular file.");
    const bytes = new Uint8Array(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      if (signal.aborted) throw new CliError("cancelled", "Directing media read was cancelled.");
      const read = await handle.read(bytes, offset, Math.min(256 * 1024, bytes.length - offset), offset);
      if (read.bytesRead === 0) throw new CliError("conflict", "Directing media changed during its read.");
      offset += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const leaf = await lstat(path, { bigint: true });
    if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.dev !== before.dev || leaf.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw new CliError("conflict", "Directing media changed during its read.");
    return bytes;
  } finally { await handle.close(); }
}
async function removeOwned(path: string, identity: { readonly dev: number; readonly ino: number }): Promise<void> {
  const current = await lstat(path);
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) throw new CliError("conflict", "Directing temporary file changed identity; retained for inspection.");
  await unlink(path);
}
async function withNativeOutput<Native, T>(root: string, prefix: string, suffix: string, run: (path: string) => Promise<Native>, body: (path: string, native: Native) => Promise<T>): Promise<T> {
  const path = join(root, `.${prefix}-${randomUUID()}.${suffix}`), parentIdentity = await lstat(root);
  let identity: { readonly dev: number; readonly ino: number } | undefined;
  let outcome: { success: true; value: T } | { success: false; error: unknown };
  try {
    let native: { success: true; value: Native } | { success: false; error: unknown };
    try { native = { success: true, value: await run(path) }; }
    catch (error) { native = { success: false, error }; }
    // The native child has settled. Capture its output before any downstream read or publication.
    try { identity = await lstat(path); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        if (!native.success) throw new AggregateError([native.error, error], "Directing native output failed and its identity could not be inspected.", { cause: native.error });
        throw error;
      }
    }
    if (!native.success) throw native.error;
    outcome = { success: true, value: await body(path, native.value) };
  }
  catch (error) { outcome = { success: false, error }; }
  try {
    const parent = await lstat(root);
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.dev !== parentIdentity.dev || parent.ino !== parentIdentity.ino) throw new CliError("conflict", "Directing decoder output parent changed; retaining uncertain temporary output.");
    if (identity !== undefined) await removeOwned(path, identity);
    else {
      let unexpected = false;
      try { await lstat(path); unexpected = true; }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      if (unexpected) throw new CliError("conflict", "Unowned directing temporary output appeared after native completion; retained for inspection.");
    }
  } catch (cleanupError) {
    if (!outcome.success) throw new AggregateError([outcome.error, cleanupError], "Directing endpoint failed and temporary cleanup also failed.", { cause: outcome.error });
    throw cleanupError;
  }
  if (!outcome.success) throw outcome.error;
  return outcome.value;
}
async function publishBytes(application: ApplicationContext, bytes: Uint8Array, extension: string, signal: AbortSignal): Promise<z.infer<typeof artifactSchema>> {
  await active(application, signal);
  const root = await mediaRoot(application), sha256 = createHash("sha256").update(bytes).digest("hex");
  const temporary = join(root, `.media-${randomUUID()}`), path = join(root, `${sha256}.${extension}`);
  const handle = await open(temporary, "wx", 0o600);
  const identity = await handle.stat();
  try {
    await handle.writeFile(bytes); await handle.sync(); await handle.close();
    const artifact = artifactSchema.parse({ path: repoPath(application, path), bytes: bytes.length, sha256 });
    const fs = createNodeBundleFileSystem(application.paths.repositoryRoot), beforeCopy = await lstat(temporary, { bigint: true });
    try { await fs.copyFileNoReplace!(repoPath(application, temporary), artifact.path, artifact, async () => await active(application, signal)); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.includes("Immutable bundle copy source changed or failed verification")) throw error;
      let diagnostic: string;
      try {
        const observed = await fs.inspectFile!(repoPath(application, temporary), bytes.length), afterCopy = await lstat(temporary, { bigint: true });
        diagnostic = `sourceBytes=${observed.bytes}/${artifact.bytes}, sourceSha256Matches=${observed.sha256 === artifact.sha256}, sourceInodeMatches=${beforeCopy.dev === afterCopy.dev && beforeCopy.ino === afterCopy.ino}, sourceMtimeMatches=${beforeCopy.mtimeNs === afterCopy.mtimeNs}, sourceCtimeMatches=${beforeCopy.ctimeNs === afterCopy.ctimeNs}`;
      } catch (inspectionError) { throw new AggregateError([error, inspectionError], "Directing immutable publication and source inspection failed.", { cause: error }); }
      const failure = new CliError("conflict", `Directing immutable publication failed: ${diagnostic}.`);
      failure.cause = error;
      throw failure;
    }
    return artifact;
  } finally {
    await handle.close();
    await removeOwned(temporary, identity);
  }
}
async function publishJson(application: ApplicationContext, path: string, value: unknown, signal: AbortSignal, assertCustody?: () => Promise<void>): Promise<z.infer<typeof artifactSchema>> {
  const text = `${canonicalJson(value)}\n`, artifact = artifactSchema.parse({ path: repoPath(application, path), bytes: Buffer.byteLength(text), sha256: sha256Hex(text) });
  const fs = createNodeBundleFileSystem(application.paths.repositoryRoot);
  await fs.writeTextNoReplace!(artifact.path, text, async () => { await active(application, signal); await assertCustody?.(); });
  await resolveVerifiedProjectMedia({ repositoryRoot: application.paths.repositoryRoot, path: artifact.path, expected: artifact, label: "Directing retained document" });
  await active(application, signal); await assertCustody?.();
  return artifact;
}
async function maybeJson(path: string): Promise<unknown | undefined> {
  try { return JSON.parse(await createNodeBundleFileSystem(dirname(path)).readText(basename(path), 8 * 1024 * 1024)) as unknown; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; }
}
async function capability(application: ApplicationContext, name: "ffmpeg" | "ffprobe"): Promise<{ command: string; version: string }> {
  const found = await application.capability(name);
  if (!found.available || found.command === undefined || found.version === undefined) throw new CliError("unavailable", `Directing media requires a versioned ${name} capability.`);
  return { command: found.command, version: found.version };
}
async function verifySource(application: ApplicationContext, source: GatewayMediaSourceReference, signal: AbortSignal): Promise<string> {
  await active(application, signal);
  return await resolveVerifiedProjectMedia({ repositoryRoot: application.paths.repositoryRoot, path: source.path, expected: source, label: "Directing source" });
}
async function retainVideo(application: ApplicationContext, input: GatewayMediaSourceReference, signal: AbortSignal): Promise<GatewayMediaSourceReference> {
  const source = GatewayMediaSourceReferenceSchema.parse(input);
  if (source.mediaType !== "video/mp4" && source.mediaType !== "video/quicktime") fail("Directing endpoints require self-contained MP4 or QuickTime video.");
  const loaded = await loadRepositoryMedia(application, { path: source.path, bytes: source.bytes, sha256: source.sha256 }, signal, LIMITS.videoBytes);
  if (loaded.data.length < 12 || Buffer.from(loaded.data.subarray(4, 8)).toString("ascii") !== "ftyp") fail("Directing video must be self-contained ISO-BMFF media.");
  const artifact = await publishBytes(application, loaded.data, "mp4", signal);
  return GatewayMediaSourceReferenceSchema.parse({ ...artifact, mediaType: source.mediaType });
}

/** Imports exactly the caller-named still; never uploads it or reads neighboring files. */
export async function importDirectingAnchor(application: ApplicationContext, path: string, signal: AbortSignal): Promise<GatewayMediaSourceReference> {
  await active(application, signal);
  const resolved = resolve(application.paths.repositoryRoot, path);
  if (await realpath(dirname(resolved)) !== dirname(resolved)) throw new CliError("unsafe-path", "Directing anchors require physical parent directories.");
  const bytes = await fileBytes(resolved, LIMITS.imageBytes, signal);
  const metadata = await sharp(bytes, { limitInputPixels: LIMITS.dimension ** 2, failOn: "error", animated: true }).metadata();
  const extension = metadata.format === "jpeg" ? "jpg" : metadata.format;
  if (!extension || !["png", "jpg", "webp"].includes(extension) || metadata.pages !== undefined && metadata.pages !== 1 || !metadata.width || !metadata.height || metadata.width > LIMITS.dimension || metadata.height > LIMITS.dimension || metadata.orientation !== undefined && metadata.orientation !== 1) fail("Directing anchors require a single unrotated PNG, JPEG, or WebP image no larger than 4096 pixels per side.");
  await sharp(bytes, { limitInputPixels: LIMITS.dimension ** 2, failOn: "error" }).raw().toBuffer();
  const artifact = await publishBytes(application, bytes, extension, signal);
  return GatewayMediaSourceReferenceSchema.parse({ ...artifact, mediaType: metadata.format === "jpeg" ? "image/jpeg" : `image/${metadata.format}`, facts: { width: metadata.width, height: metadata.height } });
}

interface ProbedVideo {
  readonly media: ProbedMedia;
  readonly stream: z.infer<typeof streamSchema>;
  readonly frames: readonly z.infer<typeof frameSchema>[];
  readonly numerator: number;
  readonly denominator: number;
  readonly colorFilter: string;
  readonly color: ColorInterpretation;
}
async function probeVideo(application: ApplicationContext, source: GatewayMediaSourceReference, command: string, signal: AbortSignal): Promise<ProbedVideo> {
  const path = await verifySource(application, source, signal);
  const result = await application.runner.run([command, "-v", "error", ...INPUT_ARGUMENTS, "-show_streams", "-show_format", "-show_frames", "-show_entries", "frame=media_type,stream_index,width,height,pix_fmt,color_range,color_transfer,color_primaries,color_space,best_effort_timestamp,duration,pkt_duration:frame_side_data=side_data_type", "-of", "json", path], { abortSignal: signal, timeoutMs: 120_000, maxOutputBytes: LIMITS.probeBytes });
  await verifySource(application, source, signal);
  if (result.exitCode !== 0) throw new CliError("subprocess", "FFprobe could not inspect directing video.");
  const parsed = probeSchema.parse(JSON.parse(result.stdout) as unknown);
  const media = parseMediaProbe(JSON.stringify({ format: parsed.format, streams: parsed.streams.map(({ pix_fmt: _pixels, time_base: _base, color_range: _range, color_transfer: _transfer, color_primaries: _primaries, color_space: _matrix, side_data_list: _sideData, ...stream }) => stream) }));
  const videos = media.streams.filter(stream => stream.codec_type === "video");
  if (videos.length !== 1 || media.durationUs > LIMITS.durationUs) fail("Directing clips require exactly one playable video stream and at most 60 seconds.");
  const stream = parsed.streams.find(candidate => candidate.index === videos[0]!.index)!;
  if (!stream.width || !stream.height || stream.width > LIMITS.dimension || stream.height > LIMITS.dimension) fail("Directing video dimensions exceed 4096 pixels per side.");
  const base = /^([1-9]\d{0,8})\/([1-9]\d{0,8})$/u.exec(stream.time_base ?? "");
  if (base === null) fail("Directing video requires an exact bounded rational time base.");
  const frames = parsed.frames.filter(frame => frame.media_type === "video" && frame.stream_index === stream.index);
  if (frames.length < 1 || frames.length > LIMITS.frames || frames.some((frame, index) => frame.best_effort_timestamp === undefined || index > 0 && frame.best_effort_timestamp <= frames[index - 1]!.best_effort_timestamp!)) fail("Directing video requires 1–4000 strictly ordered presentation timestamps.");
  if (frames.some(frame => frame.width !== stream.width || frame.height !== stream.height)) fail("Directing video must retain fixed dimensions for every decoded frame.");
  const final = frames.at(-1)!, finalDuration = final.duration ?? final.pkt_duration;
  if (finalDuration === undefined) fail("Directing video must retain the last frame's presentation duration.");
  const coverage = (BigInt(final.best_effort_timestamp!) + BigInt(finalDuration) - BigInt(frames[0]!.best_effort_timestamp!)) * BigInt(base[1]!) * 1_000_000n;
  const videoDurationUs = videos[0]!.assetRange.endUs - videos[0]!.assetRange.startUs;
  if (coverage <= 0n || coverage > BigInt(LIMITS.durationUs) * BigInt(base[2]!) || Math.abs(Number(coverage) / Number(base[2]) - videoDurationUs) > 1) fail(`Directing video presentation coverage (${Number(coverage) / Number(base[2])}us) differs from its bounded media duration (${videoDurationUs}us).`);
  if ([...(stream.side_data_list ?? []), ...frames.flatMap(frame => frame.side_data_list ?? [])].some(side => /mastering display|content light|dolby|dovi|hdr|ambient viewing environment/iu.test(side.side_data_type))) fail("Directing video with HDR metadata requires a separately qualified tone-mapping policy.");
  const missing = (value: string | undefined) => value === undefined || value === "unknown" || value === "unspecified";
  const observed = { pixelFormat: stream.pix_fmt ?? "unknown", range: stream.color_range ?? null, transfer: stream.color_transfer ?? null, primaries: stream.color_primaries ?? null, matrix: stream.color_space ?? null };
  const assumptions: ColorInterpretation["assumptions"] = [];
  let colorFilter: string, policy: ColorInterpretation["policy"];
  if (["yuv420p", "yuv422p", "yuv444p"].includes(stream.pix_fmt ?? "")) {
    if ([stream, ...frames].some(value => [value.color_transfer, value.color_primaries, value.color_space].some(tag => !missing(tag) && tag !== "bt709") || value.pix_fmt !== undefined && value.pix_fmt !== stream.pix_fmt)) fail("Directing YUV video requires 8-bit BT.709-compatible SDR metadata; conflicting, HDR, and changing formats are rejected.");
    if (!missing(stream.color_range) && stream.color_range !== "tv" && stream.color_range !== "pc") fail("Directing YUV video has an unsupported color range.");
    if (frames.some(frame => !missing(frame.color_range) && frame.color_range !== (stream.color_range === "pc" ? "pc" : "tv"))) fail("Directing YUV frame range conflicts with the retained source interpretation.");
    if (missing(stream.color_transfer)) assumptions.push("bt709-transfer");
    if (missing(stream.color_primaries)) assumptions.push("bt709-primaries");
    if (missing(stream.color_space)) assumptions.push("bt709-matrix");
    if (missing(stream.color_range)) assumptions.push("limited-range");
    policy = assumptions.length === 0 ? "bt709-to-srgb-v1" : "untagged-8bit-yuv-assume-bt709-v1";
    // Missing SDR tags are a retained interpretation, never evidence that HDR has been tone mapped.
    colorFilter = `colorspace=ispace=bt709:itrc=bt709:iprimaries=bt709:irange=${stream.color_range === "pc" ? "pc" : "tv"}:space=bt709:trc=iec61966-2-1:primaries=bt709:range=pc:format=yuv444p,format=rgb24`;
  } else {
    if (!["rgb24", "bgr24", "gbrp"].includes(stream.pix_fmt ?? "") || [stream, ...frames].some(value => value.pix_fmt !== undefined && value.pix_fmt !== stream.pix_fmt || !missing(value.color_transfer) && value.color_transfer !== "iec61966-2-1" || !missing(value.color_primaries) && value.color_primaries !== "bt709" || !missing(value.color_space) && value.color_space !== "gbr")) fail("Directing RGB video requires fixed opaque qualified 8-bit SDR sRGB pixels.");
    if ([stream, ...frames].some(value => !missing(value.color_range) && value.color_range !== "pc")) fail("Directing RGB video requires consistent full-range pixels.");
    colorFilter = "format=rgb24";
    policy = "rgb-srgb-v1";
    if (missing(stream.color_transfer)) assumptions.push("srgb-transfer");
  }
  return { media, stream, frames, numerator: Number(base[1]), denominator: Number(base[2]), colorFilter, color: colorSchema.parse({ policy, observed, assumptions }) };
}

function assertNormalizedClock(original: ProbedVideo, normalized: ProbedVideo): void {
  if (normalized.stream.codec_name !== "h264" || normalized.stream.pix_fmt !== "gbrp" || normalized.stream.color_transfer !== "iec61966-2-1" || normalized.stream.color_primaries !== "bt709" || normalized.stream.color_space !== "gbr" || normalized.stream.color_range !== "pc") fail("Lossless RGB derivative does not declare the required sRGB interpretation.");
  if (normalized.frames.length !== original.frames.length || normalized.stream.width !== original.stream.width || normalized.stream.height !== original.stream.height || Math.abs(normalized.media.durationUs - original.media.durationUs) > 1) fail("Lossless RGB derivative changed media geometry, duration, or frame count.");
  for (const [index, frame] of normalized.frames.entries()) {
    if (BigInt(frame.best_effort_timestamp!) * BigInt(normalized.numerator) * BigInt(original.denominator) !== BigInt(original.frames[index]!.best_effort_timestamp!) * BigInt(original.numerator) * BigInt(normalized.denominator)) fail("Lossless RGB derivative changed a native presentation timestamp.");
  }
  const videoRange = (video: ProbedVideo) => video.media.streams.filter(stream => stream.codec_type === "video").map(stream => ({ assetRange: stream.assetRange, fileRange: stream.fileRange }));
  if (canonicalJson(videoRange(normalized)) !== canonicalJson(videoRange(original))) fail("Lossless RGB derivative changed the video presentation range.");
  const finalDuration = (video: ProbedVideo) => BigInt(video.frames.at(-1)!.duration ?? video.frames.at(-1)!.pkt_duration!);
  if (finalDuration(normalized) * BigInt(normalized.numerator) * BigInt(original.denominator) !== finalDuration(original) * BigInt(original.numerator) * BigInt(normalized.denominator)) fail("Lossless RGB derivative changed the final video frame duration.");
  const audio = (video: ProbedVideo) => video.media.streams.filter(stream => stream.codec_type === "audio").map(stream => ({ codec: stream.codec_name, channels: stream.channels, sampleRate: stream.sample_rate, assetRange: stream.assetRange, fileRange: stream.fileRange }));
  if (canonicalJson(audio(normalized)) !== canonicalJson(audio(original))) fail("Lossless RGB derivative changed copied audio streams or their clock.");
}

async function normalizeForAssembly(application: ApplicationContext, source: GatewayMediaSourceReference, original: ProbedVideo, signal: AbortSignal, requireRetainedReceipt = false): Promise<{ source: GatewayMediaSourceReference; probe: ProbedVideo; receipt?: z.infer<typeof artifactSchema> }> {
  if (original.color.policy === "rgb-srgb-v1") return { source, probe: original };
  const root = await mediaRoot(application), ffmpeg = await capability(application, "ffmpeg"), ffprobe = await capability(application, "ffprobe");
  const requestSha256 = sha256Hex(canonicalJson({ kind: "atet.directing-rgb-normalization", schemaVersion: 1, source, color: original.color, ffmpegVersion: ffmpeg.version, codec: "libx264rgb-lossless-v1" }));
  const receiptPath = join(root, `rgb-${requestSha256}.json`);
  return await withMutationLock(await directory(application, repoPath(application, join(root, `rgb-${requestSha256}`))), { command: "directing RGB normalization", label: "Directing RGB normalization" }, async lease => {
    const previous = await maybeJson(receiptPath);
    if (previous !== undefined) {
      const prior = normalizationSchema.parse(previous);
      if (prior.requestSha256 !== requestSha256 || prior.ffmpegVersion !== ffmpeg.version || canonicalJson(prior.input) !== canonicalJson(source) || canonicalJson(prior.color) !== canonicalJson(original.color)) throw new CliError("conflict", "RGB normalization receipt differs from its source interpretation.");
      const probe = await probeVideo(application, prior.output, ffprobe.command, signal);
      if (prior.frameCount !== probe.frames.length) throw new CliError("conflict", "RGB normalization receipt differs from its decoded frame count.");
      assertNormalizedClock(original, probe);
      const receipt = await publishJson(application, receiptPath, prior, signal, lease.assertOwned);
      return { source: prior.output, probe, receipt };
    }
    if (requireRetainedReceipt) throw new CliError("conflict", "Retained assembly normalization is unavailable for the current toolchain; recovery cannot re-encode media.");
    return await withNativeOutput(root, "rgb", "mp4", async temporary => {
      const path = await verifySource(application, source, signal);
      return await application.runner.run([ffmpeg.command, "-v", "error", "-nostdin", "-copyts", "-filter_threads", "1", ...INPUT_ARGUMENTS, "-i", path,
        "-map", `0:${original.stream.index}`, "-map", "0:a?", "-vf", original.colorFilter, "-fps_mode", "passthrough", "-enc_time_base", `${original.numerator}/${original.denominator}`,
        "-c:v", "libx264rgb", "-preset", "veryfast", "-crf", "0", "-bf", "0", "-threads:v", "2", "-pix_fmt", "rgb24", "-color_range", "pc", "-color_primaries", "bt709", "-color_trc", "iec61966-2-1", "-colorspace", "rgb",
        "-c:a", "copy", "-video_track_timescale", String(original.denominator), "-avoid_negative_ts", "disabled", "-fs", String(LIMITS.videoBytes - 1024 * 1024), "-f", "mp4", "-n", temporary], { abortSignal: signal, timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 });
    }, async (temporary, result) => {
      await verifySource(application, source, signal);
      if (result.exitCode !== 0) throw new CliError("subprocess", "Lossless RGB assembly normalization requires FFmpeg libx264rgb and compatible copied audio.");
      const bytes = await fileBytes(temporary, LIMITS.videoBytes, signal), artifact = await publishBytes(application, bytes, "mp4", signal);
      const output = GatewayMediaSourceReferenceSchema.parse({ ...artifact, mediaType: "video/mp4" });
      const probe = await probeVideo(application, output, ffprobe.command, signal);
      assertNormalizedClock(original, probe);
      const measured = GatewayMediaSourceReferenceSchema.parse({ ...output, facts: { durationSeconds: probe.media.durationUs / 1_000_000, width: probe.stream.width, height: probe.stream.height } });
      const receipt = await publishJson(application, receiptPath, normalizationSchema.parse({ kind: "atet.directing-rgb-normalization", schemaVersion: 1, requestSha256, input: source, output: measured, color: original.color,
        codec: "libx264rgb-lossless-v1", ffmpegVersion: ffmpeg.version, frameCount: probe.frames.length }), signal, lease.assertOwned);
      return { source: measured, probe, receipt };
    });
  });
}

/** Uses decoded frame order and native PTS; never estimates an endpoint from nominal FPS. */
export async function extractDirectingEndpoint(application: ApplicationContext, input: GatewayMediaSourceReference, position: "first" | "last", signal: AbortSignal): Promise<DirectingEndpoint> {
  const source = GatewayMediaSourceReferenceSchema.parse(input);
  const requestedPosition = z.enum(["first", "last"]).parse(position);
  await verifySource(application, source, signal);
  const requestSha256 = sha256Hex(canonicalJson({ kind: "atet.directing-endpoint-request", schemaVersion: 1, colorPolicy: "sdr-video-color-v1", source: { path: source.path, bytes: source.bytes, sha256: source.sha256, mediaType: source.mediaType }, position: requestedPosition }));
  const root = await mediaRoot(application), receiptPath = join(root, `endpoint-${requestSha256}.json`);
  return await withMutationLock(await directory(application, repoPath(application, join(root, `endpoint-${requestSha256}`))), { command: "directing endpoint", label: "Directing endpoint" }, async lease => {
    const previous = await maybeJson(receiptPath);
    if (previous !== undefined) {
      const receipt = endpointReceiptSchema.parse(previous);
      if (receipt.requestSha256 !== requestSha256 || receipt.position !== requestedPosition || receipt.endpoint.source.sha256 !== source.sha256 || receipt.endpoint.source.path !== source.path || receipt.endpoint.source.bytes !== source.bytes || receipt.endpoint.source.mediaType !== source.mediaType) throw new CliError("conflict", "Directing endpoint receipt differs from its request.");
      await verifySource(application, receipt.endpoint.image, signal);
      await active(application, signal); await lease.assertOwned();
      return receipt.endpoint;
    }
    const retained = await retainVideo(application, source, signal);
    const [ffmpeg, ffprobe] = await Promise.all([capability(application, "ffmpeg"), capability(application, "ffprobe")]);
    const probe = await probeVideo(application, retained, ffprobe.command, signal);
    const frameIndex = requestedPosition === "first" ? 0 : probe.frames.length - 1, value = probe.frames[frameIndex]!.best_effort_timestamp!;
    const temporary = join(root, `.endpoint-${randomUUID()}.png`), sourcePath = await verifySource(application, retained, signal);
    const parentIdentity = await lstat(root);
    let identity: { readonly dev: number; readonly ino: number } | undefined;
    let failed = false, failure: unknown, completed: DirectingEndpoint | undefined;
    try {
      // The runner must settle its native child before this scope releases output custody.
      const result = await application.runner.run([ffmpeg.command, "-hide_banner", "-loglevel", "info", "-nostdin", "-copyts", "-filter_threads", "1", ...INPUT_ARGUMENTS, "-i", sourcePath,
        "-map", `0:${probe.stream.index}`, "-vf", `select=eq(n\\,${frameIndex}),showinfo,${probe.colorFilter}`, "-fps_mode", "passthrough", "-frames:v", "1", "-threads:v", "1", "-an", "-sn", "-dn", "-f", "image2", "-n", temporary], { abortSignal: signal, timeoutMs: 120_000, maxOutputBytes: 1024 * 1024 });
      await verifySource(application, retained, signal);
      await verifySource(application, source, signal);
      if (result.exitCode !== 0) throw new CliError("subprocess", "FFmpeg could not decode the directing endpoint.");
      identity = await lstat(temporary);
      const base = /Parsed_showinfo_[^\n]*config in time_base:\s*(\d+)\/(\d+)/u.exec(result.stderr);
      const pts = /Parsed_showinfo_[^\n]*\bn:\s*0\s+pts:\s*(-?\d+)/u.exec(result.stderr);
      if (!base || !pts || BigInt(pts[1]!) * BigInt(base[1]!) * BigInt(probe.denominator) !== BigInt(value) * BigInt(probe.numerator) * BigInt(base[2]!)) fail("FFmpeg did not decode the exact probed source PTS.");
      const bytes = await fileBytes(temporary, LIMITS.imageBytes, signal);
      const metadata = await sharp(bytes, { limitInputPixels: LIMITS.dimension ** 2, failOn: "error" }).metadata();
      if (metadata.format !== "png" || metadata.width !== probe.stream.width || metadata.height !== probe.stream.height) fail("Directing endpoint dimensions differ from the source.");
      await sharp(bytes, { limitInputPixels: LIMITS.dimension ** 2, failOn: "error" }).raw().toBuffer();
      const artifact = await publishBytes(application, bytes, "png", signal);
      const endpoint = endpointSchema.parse({
        image: { ...artifact, mediaType: "image/png", facts: { width: metadata.width, height: metadata.height } },
        source: { ...source, facts: { durationSeconds: probe.media.durationUs / 1_000_000, width: probe.stream.width, height: probe.stream.height } },
        frameIndex, pts: { value: String(value), timeBaseNumerator: probe.numerator, timeBaseDenominator: probe.denominator },
        timeUs: directingPtsTimeUs({ value: String(value), timeBaseNumerator: probe.numerator, timeBaseDenominator: probe.denominator }),
      });
      await publishJson(application, receiptPath, endpointReceiptSchema.parse({ kind: "atet.directing-endpoint", schemaVersion: 1, requestSha256, position: requestedPosition, endpoint, color: probe.color, ffmpegVersion: ffmpeg.version, ffprobeVersion: ffprobe.version }), signal, lease.assertOwned);
      completed = endpoint;
    } catch (error) { failed = true; failure = error; }
    // Settle cleanup separately so it cannot discard the primary native failure.
    try {
      const parent = await lstat(root);
      if (!parent.isDirectory() || parent.isSymbolicLink() || parent.dev !== parentIdentity.dev || parent.ino !== parentIdentity.ino) throw new CliError("conflict", "Directing decoder output parent changed; retaining uncertain temporary output.");
      if (identity === undefined) {
        try { identity = await lstat(temporary); }
        catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      }
      if (identity !== undefined) await removeOwned(temporary, identity);
    } catch (cleanupError) {
      if (failed) throw new AggregateError([failure, cleanupError], "Directing endpoint failed and temporary cleanup also failed.", { cause: failure });
      throw cleanupError;
    }
    if (failed) throw failure;
    return completed!;
  });
}

function projectAsset(source: GatewayMediaSourceReference, probe: ProbedMedia, timestamp: string): ProjectAssetV1 {
  const suffix = source.sha256.slice(0, 24);
  const rate = (value: string | undefined) => {
    const parts = /^(\d+)\/(\d+)$/u.exec(value ?? "");
    return parts === null || Number(parts[1]) <= 0 || Number(parts[2]) <= 0 ? undefined : Number(parts[1]) / Number(parts[2]);
  };
  return ProjectAssetV1Schema.parse({
    assetId: `asset_${suffix}`, createdAt: timestamp, durationUs: probe.durationUs, label: `Directed clip ${suffix}`, role: "b-roll",
    source: { kind: "generated", generator: "atet.directing", generatorVersion: "1", sourceSha256: source.sha256 },
    streams: probe.streams.map(stream => ({
      streamId: `stream_${suffix}_${stream.index}`, label: `${stream.codec_type} ${stream.index}`, kind: stream.codec_type,
      ...(stream.codec_type === "video" ? { role: "b-roll", pixelWidth: stream.width, pixelHeight: stream.height,
        frameRate: rate(stream.avg_frame_rate) ?? rate(stream.r_frame_rate) } : { role: "other", channels: stream.channels, sampleRateHz: Number(stream.sample_rate) }),
      segments: [{ path: source.path, bytes: source.bytes, sha256: source.sha256, codec: stream.codec_name, container: probe.container, streamIndex: stream.index, assetRange: stream.assetRange, fileRange: stream.fileRange }],
    })),
  });
}

/** Publishes one ordinary editable project; its initial assembly remains bound to accepted bytes. */
export async function assembleDirectingClips(application: ApplicationContext, request: DirectingAssemblyInput, signal: AbortSignal): Promise<DirectingAssemblyResult> {
  const input = assemblyInputSchema.parse(request);
  await active(application, signal);
  const requestSha256 = sha256Hex(canonicalJson({ kind: "atet.directing-assembly", schemaVersion: 2, colorPolicy: "sdr-rgb-assembly-v1", timingPolicy: ASSEMBLY_TIMING_POLICY, input }));
  const root = await mediaRoot(application), projectId = `project_directing_${requestSha256.slice(0, 40)}`;
  const projectDirectory = join(application.paths.projectRoot, projectId), intentPath = join(root, `assembly-${requestSha256}.intent.json`);
  return await withMutationLock(await directory(application, repoPath(application, join(root, `assembly-${requestSha256}`))), { command: "directing assembly", label: "Directing assembly" }, async lease => {
    for (const clip of input.clips) await verifySource(application, clip.source, signal);
    const previous = await maybeJson(intentPath);
    const priorIntent = previous === undefined ? undefined : assemblyIntentSchema.parse(previous);
    if (priorIntent !== undefined && (priorIntent.requestSha256 !== requestSha256 || canonicalJson(priorIntent.input) !== canonicalJson(input) || priorIntent.project.projectId !== projectId)) throw new CliError("conflict", "Directing assembly intent differs from the exact accepted selection.");
    // A saved intent is a recovery draft, not authority for placement or receipt
    // content. Derive every field again from accepted bytes and current policies.
    const ffprobe = await capability(application, "ffprobe"), timestamp = priorIntent?.project.createdAt ?? application.clock.now().toISOString();
    const assets: ProjectAssetV1[] = [], placements: unknown[] = [], colors: z.infer<typeof assemblyIntentSchema>["colors"] = [], normalizations: z.infer<typeof assemblyIntentSchema>["normalizations"] = [], timing: z.infer<typeof assemblyIntentSchema>["timing"] = [];
    let offset = 0, cumulativeNumerator = 0n, cumulativeDenominator = 1n;
    for (const [index, clip] of input.clips.entries()) {
      const retained = await retainVideo(application, clip.source, signal), probe = await probeVideo(application, retained, ffprobe.command, signal);
      if (Math.abs(probe.media.durationUs - clip.durationUs) > 1) fail("Accepted clip duration differs from its actual media duration.");
      const normalized = await normalizeForAssembly(application, retained, probe, signal, priorIntent !== undefined);
      const asset = projectAsset(normalized.source, normalized.probe.media, timestamp);
      if (normalized.receipt !== undefined && !normalizations.some(receipt => receipt.sha256 === normalized.receipt!.sha256)) normalizations.push(normalized.receipt);
      colors.push({ shotId: clip.shotId, sourceSha256: clip.source.sha256, interpretation: probe.color });
      if (!assets.some(candidate => candidate.assetId === asset.assetId)) assets.push(asset);
      const video = probe.media.streams.find(stream => stream.codec_type === "video")!, videoAssetRange = video.assetRange;
      const finalFrame = probe.frames.at(-1)!;
      const durationNumerator = (BigInt(finalFrame.best_effort_timestamp!) + BigInt(finalFrame.duration ?? finalFrame.pkt_duration!) - BigInt(probe.frames[0]!.best_effort_timestamp!)) * BigInt(probe.numerator);
      const durationDenominator = BigInt(probe.denominator), start = offset;
      cumulativeNumerator = cumulativeNumerator * durationDenominator + durationNumerator * cumulativeDenominator;
      cumulativeDenominator *= durationDenominator;
      let a = cumulativeNumerator, b = cumulativeDenominator;
      while (b !== 0n) { const remainder = a % b; a = b; b = remainder; }
      cumulativeNumerator /= a; cumulativeDenominator /= a;
      // Never round a cut up past an exact CFR sample time. Floor the cumulative
      // rational clock once per boundary, so rounding error cannot accumulate.
      offset = Number(cumulativeNumerator * 1_000_000n / cumulativeDenominator);
      if (!Number.isSafeInteger(offset) || offset <= start) fail("Directed video span cannot be represented in the project microsecond clock.");
      const audio = probe.media.streams.filter(stream => stream.codec_type === "audio").map(stream => {
        const startUs = Math.max(stream.assetRange.startUs, videoAssetRange.startUs), endUs = Math.min(stream.assetRange.endUs, videoAssetRange.endUs);
        return { streamIndex: stream.index, sourceAssetRange: stream.assetRange, selectedAssetRange: endUs > startUs ? { startUs, endUs } : null,
          trimmedBeforeUs: Math.max(0, Math.min(stream.assetRange.endUs, videoAssetRange.startUs) - stream.assetRange.startUs),
          trimmedAfterUs: Math.max(0, stream.assetRange.endUs - Math.max(stream.assetRange.startUs, videoAssetRange.endUs)) };
      });
      timing.push(assemblyTimingSchema.parse({ shotId: clip.shotId, attemptId: clip.attemptId, sourceSha256: clip.source.sha256, sourceDurationUs: probe.media.durationUs,
        videoAssetRange, videoDurationSeconds: { numerator: String(durationNumerator), denominator: probe.denominator }, projectRange: { startUs: start, endUs: offset }, audio }));
      placements.push({
        placementId: `placement_${requestSha256.slice(0, 24)}_${index}`, assetId: asset.assetId, assetRange: videoAssetRange, enabled: true,
        sync: { anchors: [{ assetTimeUs: videoAssetRange.startUs, projectTimeUs: start }, { assetTimeUs: videoAssetRange.endUs, projectTimeUs: offset }], provenance: { kind: "manual", note: `Directed shot ${clip.shotId}; accepted attempt ${clip.attemptId}; video span cut with audio trimmed to the selected video span.` } },
        video: asset.streams.filter(stream => stream.kind === "video").map(stream => ({ streamId: stream.streamId, presentation: { enabled: true, blendMode: "normal", crop: { kind: "none" }, fit: "contain", layer: 0, layout: { kind: "normalized", x: 0, y: 0, width: 1, height: 1 }, opacity: 1 } })),
        audio: asset.streams.filter(stream => stream.kind === "audio" && stream.segments.some(segment => segment.assetRange.startUs < videoAssetRange.endUs && segment.assetRange.endUs > videoAssetRange.startUs)).map(stream => ({ streamId: stream.streamId, presentation: { enabled: true, gainDb: 0, pan: 0 } })),
      });
    }
    const project = VideoProjectV1Schema.parse({ kind: "atet.video-project", schemaVersion: 1, projectId, name: input.title, createdAt: timestamp, updatedAt: timestamp, analyses: [], assets, placements,
      referencePlacementId: `placement_${requestSha256.slice(0, 24)}_0`, currentEditPlanPath: "edits/current.json", timeline: { durationUs: offset, timebase: "microseconds" } });
    const plan = createDefaultProjectEditPlan(project, ProjectEditPlanV1Schema.shape.planId.parse(`plan_${requestSha256.slice(0, 40)}`), timestamp);
    const intent = assemblyIntentSchema.parse({ kind: "atet.directing-assembly-intent", schemaVersion: 2, requestSha256, input, project, plan, colors, normalizations, timingPolicy: ASSEMBLY_TIMING_POLICY, timing });
    if (priorIntent !== undefined && canonicalJson(priorIntent) !== canonicalJson(intent)) throw new CliError("conflict", "Retained directing assembly intent differs from the verified canonical derivation.");
    await publishJson(application, intentPath, intent, signal, lease.assertOwned);
    // Resume only these exact retained documents; edited or unknown generations conflict.
    for (const receipt of intent.normalizations) await resolveVerifiedProjectMedia({ repositoryRoot: application.paths.repositoryRoot, path: receipt.path, expected: receipt, label: "Assembled color normalization receipt" });
    for (const asset of intent.project.assets) for (const stream of asset.streams) for (const segment of stream.segments) await resolveVerifiedProjectMedia({ repositoryRoot: application.paths.repositoryRoot, path: segment.path, expected: segment, label: "Assembled clip" });
    await directory(application, repoPath(application, projectDirectory));
    await directory(application, repoPath(application, join(projectDirectory, "edits")));
    const publishedPlan = await publishJson(application, join(projectDirectory, "edits/current.json"), intent.plan, signal, lease.assertOwned);
    const publishedProject = await publishJson(application, join(projectDirectory, "project.json"), intent.project, signal, lease.assertOwned);
    const receipt = await publishJson(application, join(root, `assembly-${requestSha256}.json`), {
      kind: "atet.directing-assembly-receipt", schemaVersion: 2, requestSha256, recipeSha256: input.recipeSha256,
      projectId, project: publishedProject, plan: publishedPlan, clips: input.clips, durationUs: intent.project.timeline.durationUs, colors: intent.colors, normalizations: intent.normalizations, timingPolicy: intent.timingPolicy, timing: intent.timing,
    }, signal, lease.assertOwned);
    return { projectId, projectPath: publishedProject.path, receipt };
  });
}
