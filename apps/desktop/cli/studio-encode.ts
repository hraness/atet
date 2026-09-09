import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { z } from "zod";
import { boundedCanonicalJsonSha256 } from "../../../src/code/canonical-json";
import { parseStudioPlan, STUDIO_LIMITS, validateStudioReceipt, type StudioPlan } from "../../../src/studio";
import { bindExactCapabilities, ExactCapabilityApplicationRunner, assertExactCapabilityExecutable, type ExactCapabilityBinding } from "../application/capability-binding";
import type { ApplicationContext } from "../application/context";
import type { MediaArtifactReference } from "../application/operations/media/shared";
import { StudioRunOutputSchema } from "../application/studio-port";
import { createNodeBundleFileSystem } from "../core/storage";
import { CliError } from "./errors";
import { withMutationLock } from "./mutation-lock";
import { ensurePhysicalPrivateDirectoryWithin } from "./paths";
import { withStudioProcessCustody } from "./studio-custody";
import { inventoryStudioFiles, readStudioFileEdges, studioJson } from "./studio-files";
import { NativeStudioProcess, studioChildEnvironment, type StudioProcessPort } from "./studio-process";
import { studioStorageRoot, type createStudioService } from "./studio-service";

const DOCUMENT_BYTES = 32 * 1024 * 1024;
const digest = (value: unknown) => boundedCanonicalJsonSha256(value, { maximumBytes: DOCUMENT_BYTES, maximumDepth: 48, maximumValues: 1_000_000 });
type Render = NonNullable<StudioPlan["job"]["render"]>;
type Profile = "rgb8-lossless-h264-v1" | "rgba8-lossless-qtrle-v1";

interface EncodeRequest {
  readonly kind: "atet.studio-encode-request"; readonly schemaVersion: 1;
  readonly planSha256: string; readonly nativeReceipt: MediaArtifactReference;
  readonly jobId: string; readonly outputId: string; readonly render: Render;
  readonly frames: readonly { readonly path: string; readonly frame: number; readonly sha256: string; readonly bytes: number }[];
  readonly profile: Profile;
  readonly conversion: "identity-uint8" | "ffmpeg-no-dither-uint16-to-uint8-v1";
  readonly colorSpace: "srgb"; readonly alpha: "opaque" | "straight";
  readonly tools: readonly ExactCapabilityBinding[];
  readonly limits: { readonly timeoutMs: number; readonly maximumOutputBytes: number };
}
export interface StudioEncodeReceipt {
  readonly kind: "atet.studio-encode-receipt"; readonly schemaVersion: 1;
  readonly requestSha256: string; readonly request: EncodeRequest;
  readonly artifact: MediaArtifactReference;
  readonly verification: {
    readonly frameCount: number; readonly canonicalFrameSha256: string;
    readonly sourceFramehash: MediaArtifactReference; readonly videoFramehash: MediaArtifactReference;
    readonly probe: MediaArtifactReference;
  };
}
export interface StudioEncodeInput {
  readonly application: ApplicationContext;
  readonly service: Pick<ReturnType<typeof createStudioService>, "inspect">;
  readonly jobId: string; readonly outputId: string; readonly signal: AbortSignal;
  beforePublication(): Promise<void>;
  readonly process?: StudioProcessPort;
}

/** Framehash streams carry hashes, never raw pixels; rows are checked without allocating a frame array. */
export function verifyStudioFramehash(text: string, render: Render, alpha: boolean): string {
  const count = render.endFrameExclusive - render.startFrame;
  const expectedBytes = render.width * render.height * (alpha ? 4 : 3);
  let rows = 0, timeBase = false, dimensions = false, algorithm = false;
  const hash = createHash("sha256");
  for (const line of text.matchAll(/[^\r\n]+/gu)) {
    const value = line[0].trim();
    if (value.startsWith("#")) {
      if (value === "#hash: SHA256") algorithm = true;
      if (value.startsWith("#tb ")) {
        const match = /^#tb 0: (\d+)\/(\d+)$/u.exec(value);
        if (timeBase || match === null || BigInt(match[1]!) === 0n || BigInt(match[2]!) === 0n || BigInt(match[1]!) * BigInt(render.frameRate.numerator) !== BigInt(match[2]!) * BigInt(render.frameRate.denominator)) throw new CliError("invalid-data", "Encoded framehash clock differs from the source cadence.");
        timeBase = true;
      }
      if (value.startsWith("#dimensions ")) {
        if (dimensions || value !== `#dimensions 0: ${render.width}x${render.height}`) throw new CliError("invalid-data", "Encoded framehash dimensions differ.");
        dimensions = true;
      }
      continue;
    }
    const match = /^(\d+),\s*(-?\d+),\s*(-?\d+),\s*(\d+),\s*(\d+),\s*([a-f0-9]{64})$/u.exec(value);
    if (match === null || Number(match[1]) !== 0 || Number(match[2]) !== rows || Number(match[3]) !== rows || Number(match[4]) !== 1 || Number(match[5]) !== expectedBytes || rows >= count) throw new CliError("invalid-data", "Encoded frames have unexpected timing, size, or coverage.");
    hash.update(`${rows}:${expectedBytes}:${match[6]}\n`);
    rows++;
  }
  if (!algorithm || !timeBase || !dimensions || rows !== count) throw new CliError("invalid-data", "Encoded framehash is incomplete.");
  return hash.digest("hex");
}

const probeSchema = z.object({ streams: z.array(z.object({
  codec_type: z.string(), codec_name: z.string(), pix_fmt: z.string(), width: z.number().int(), height: z.number().int(),
  avg_frame_rate: z.string(), time_base: z.string(), start_pts: z.number().int().safe(), duration_ts: z.number().int().safe(), nb_read_frames: z.string(),
  color_range: z.string().optional(), color_space: z.string().optional(), color_transfer: z.string().optional(), color_primaries: z.string().optional(),
})).length(1) });
function verifyProbe(text: string, request: EncodeRequest): void {
  const stream = probeSchema.parse(JSON.parse(text) as unknown).streams[0]!;
  const r = request.render, count = r.endFrameExclusive - r.startFrame;
  const ratio = (value: string) => { const match = /^(\d+)\/(\d+)$/u.exec(value); if (match === null || match[2] === "0") throw new CliError("invalid-data", "Invalid encoded media clock."); return [BigInt(match[1]!), BigInt(match[2]!)] as const; };
  const fps = ratio(stream.avg_frame_rate), tb = ratio(stream.time_base);
  const opaque = request.alpha === "opaque";
  if (stream.codec_type !== "video" || stream.codec_name !== (opaque ? "h264" : "qtrle") || stream.pix_fmt !== (opaque ? "gbrp" : "argb")
    || stream.width !== r.width || stream.height !== r.height || stream.nb_read_frames !== String(count) || stream.start_pts !== 0
    || fps[0] * BigInt(r.frameRate.denominator) !== fps[1] * BigInt(r.frameRate.numerator)
    || BigInt(stream.duration_ts) * tb[0] * BigInt(r.frameRate.numerator) !== BigInt(count) * BigInt(r.frameRate.denominator) * tb[1]
    || opaque && (stream.color_range !== "pc" || stream.color_space !== "gbr" || stream.color_transfer !== "iec61966-2-1" || stream.color_primaries !== "bt709")) throw new CliError("invalid-data", "Encoded video differs from its declared clock, pixels, codec, or color profile.", { observed: stream, render: r });
}

/** Fixed media conversion only: this operation never executes the retained authored source. */
export async function encodeStudioSequence(input: StudioEncodeInput): Promise<{ readonly artifact: MediaArtifactReference; readonly receipt: MediaArtifactReference; readonly document: StudioEncodeReceipt }> {
  const { application } = input;
  if (!/^studio_[a-zA-Z0-9][a-zA-Z0-9_-]{0,120}$/u.test(input.jobId)) throw new CliError("invalid-data", "Invalid studio job ID.");
  if (application.hostResourceLease === undefined || application.machineStateRoot === undefined) throw new CliError("unavailable", "Studio encoding requires admitted host resources and machine process custody.");
  const hostLease = application.hostResourceLease;
  const initialFence = async () => { if (input.signal.aborted) throw new CliError("cancelled", "Studio encoding was cancelled."); await hostLease.assertOwned(); await input.beforePublication(); if (input.signal.aborted) throw new CliError("cancelled", "Studio encoding was cancelled."); };
  await initialFence();
  const native = StudioRunOutputSchema.parse(await input.service.inspect(input.jobId));
  const root = await studioStorageRoot(application), jobRoot = join(root, "jobs", input.jobId);
  const jobFs = createNodeBundleFileSystem(jobRoot);
  const plan = parseStudioPlan(JSON.parse(await jobFs.readText("plan.json", DOCUMENT_BYTES)) as unknown);
  const original = validateStudioReceipt({ plan, receipt: native.document });
  if (original.state !== "succeeded" || original.jobId !== input.jobId) throw new CliError("invalid-data", "Only successful retained studio jobs can be encoded.");
  const repositoryFs = createNodeBundleFileSystem(application.paths.repositoryRoot);
  const nativePath = relative(application.paths.repositoryRoot, join(jobRoot, "receipt.json"));
  const actualReceipt = await repositoryFs.inspectFile!(nativePath, DOCUMENT_BYTES);
  if (native.receipt.path !== nativePath || native.receipt.bytes !== actualReceipt.bytes || native.receipt.sha256 !== actualReceipt.sha256
    || studioJson(original) !== studioJson(JSON.parse(await jobFs.readText("receipt.json", DOCUMENT_BYTES)) as unknown)) throw new CliError("conflict", "Native studio receipt identity changed.");
  const output = plan.job.outputs.find(item => item.id === input.outputId), render = plan.job.render;
  if (output === undefined || output.kind !== "sequence" || output.format !== "png" || output.interpretation.kind !== "raster" || render === undefined) throw new CliError("unsupported-plan", "Studio encode requires a declared PNG frame sequence.");
  const raster = output.interpretation, alpha = raster.alpha === "straight";
  if (raster.semantic !== "color" || raster.colorSpace !== "srgb" || !["opaque", "straight"].includes(raster.alpha)
    || !["uint8", "uint16"].includes(raster.dataType) || raster.channels.join(",") !== (alpha ? "R,G,B,A" : "R,G,B")) throw new CliError("unsupported-plan", "Studio encode supports only explicit sRGB RGB or straight RGBA integer color sequences.");
  const frames = original.outputs.filter(item => item.outputId === input.outputId).sort((a, b) => a.frame! - b.frame!).map(item => ({ path: item.path, frame: item.frame!, sha256: item.sha256, bytes: item.bytes }));
  const sourceFs = createNodeBundleFileSystem(join(jobRoot, "outputs"));
  const verifySource = async () => {
    await initialFence();
    if (studioJson(await input.service.inspect(input.jobId)) !== studioJson(native)
      || studioJson(parseStudioPlan(JSON.parse(await jobFs.readText("plan.json", DOCUMENT_BYTES)) as unknown)) !== studioJson(plan)) throw new CliError("conflict", "Native studio source provenance changed during encoding.");
    for (const frame of frames) {
      const found = await sourceFs.inspectFile!(frame.path, frame.bytes);
      const { first } = await readStudioFileEdges(join(jobRoot, "outputs", frame.path), frame.bytes, 33);
      if (found.bytes !== frame.bytes || found.sha256 !== frame.sha256 || first.length < 33 || first.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
        || first.toString("ascii", 12, 16) !== "IHDR" || first.readUInt32BE(16) !== render.width || first.readUInt32BE(20) !== render.height
        || first[24] !== (raster.dataType === "uint16" ? 16 : 8) || first[25] !== (alpha ? 6 : 2)) throw new CliError("conflict", "Native PNG bytes or sample layout differ from the retained declaration.");
    }
  };
  await verifySource();
  const tools = await bindExactCapabilities(application, ["ffmpeg", "ffprobe"]);
  const request: EncodeRequest = {
    kind: "atet.studio-encode-request", schemaVersion: 1, planSha256: plan.planSha256, nativeReceipt: native.receipt,
    jobId: input.jobId, outputId: input.outputId, render, frames,
    profile: alpha ? "rgba8-lossless-qtrle-v1" : "rgb8-lossless-h264-v1",
    conversion: raster.dataType === "uint16" ? "ffmpeg-no-dither-uint16-to-uint8-v1" : "identity-uint8", colorSpace: "srgb", alpha: alpha ? "straight" : "opaque", tools,
    limits: { timeoutMs: Math.min(plan.job.limits.timeoutSeconds * 1000, 300_000), maximumOutputBytes: Math.min(plan.job.limits.maximumOutputBytes, 512 * 1024 * 1024) },
  };
  const requestSha256 = digest(request);
  const directory = await ensurePhysicalPrivateDirectoryWithin(jobRoot, `derivatives/${requestSha256}`);
  return await withMutationLock(directory, { command: "studio encode", label: input.jobId }, async lease => {
    const deadline = performance.now() + request.limits.timeoutMs;
    const fence = async () => { await initialFence(); await lease.assertOwned(); if (performance.now() >= deadline) throw new CliError("cancelled", "Studio encode aggregate deadline exceeded."); };
    const fs = createNodeBundleFileSystem(directory);
    const optional = async (path: string) => { try { return await fs.readText(path, DOCUMENT_BYTES); } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined; throw error; } };
    const intent = studioJson({ kind: "atet.studio-encode-intent", schemaVersion: 1, requestSha256, request });
    const previous = await optional("intent.json");
    if (previous !== undefined && previous !== intent) throw new CliError("conflict", "Retained studio encode intent differs from verified source and settings.");
    const video = alpha ? "video.mov" : "video.mp4";
    let existingVideo: { readonly bytes: number; readonly sha256: string } | undefined;
    try { existingVideo = await fs.inspectFile!(video, request.limits.maximumOutputBytes); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    if (previous === undefined && existingVideo !== undefined) throw new CliError("conflict", "A studio video without its exact intent cannot be adopted.");
    if (previous !== undefined && existingVideo === undefined) throw new CliError("ambiguous", "Interrupted studio encoding has no verifiable video. The retained intent cannot authorize another encode.");
    if (previous === undefined) await fs.writeTextNoReplace!("intent.json", intent, fence);
    for (const child of ["work/home", "work/tmp", "work/blender-user"]) await ensurePhysicalPrivateDirectoryWithin(directory, child);
    const artifact = async (path: string, maximumBytes = DOCUMENT_BYTES): Promise<MediaArtifactReference> => ({ path: relative(application.paths.repositoryRoot, join(directory, path)), ...await fs.inspectFile!(path, maximumBytes) });
    const retainText = async (path: string, text: string) => { const prior = await optional(path); if (prior !== undefined && prior !== text) throw new CliError("conflict", `Retained studio encode evidence differs: ${path}`); if (prior === undefined) await fs.writeTextNoReplace!(path, text, fence); return await artifact(path); };
    const assertBudget = async () => { await fence(); await inventoryStudioFiles(directory, 64, request.limits.maximumOutputBytes + 4 * DOCUMENT_BYTES); };
    return await withStudioProcessCustody({ machineStateRoot: application.machineStateRoot!, process: input.process ?? new NativeStudioProcess(), label: `encode ${input.jobId}/${input.outputId}`, signal: input.signal, fence }, async supervised => {
      const runner = new ExactCapabilityApplicationRunner({ run: async (argv, options) => {
        await fence();
        const result = await supervised.run(argv, { cwd: directory, env: studioChildEnvironment(argv[0], join(directory, "work"), 1), timeoutMs: Math.max(1, Math.floor(deadline - performance.now())), maximumLogBytes: options?.maxOutputBytes ?? 65_536,
          signal: input.signal, inheritedFileDescriptors: hostLease.inheritedFileDescriptors, assertBudget });
        if (result.custody !== "closed" || result.failure !== undefined || result.exitCode !== 0) throw new CliError(result.custody !== "closed" ? "ambiguous" : input.signal.aborted ? "cancelled" : "subprocess", `Studio encode process failed (${result.failure ?? "exit"}); retained intent and output remain available for inspection.`);
        if (result.stderr.trim() !== "") throw new CliError("invalid-data", "Studio encoder reported unexpected diagnostics; the derivative was not published.");
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      } }, tools, application.paths.privateRoot);
      const ffmpeg = tools.find(tool => tool.name === "ffmpeg")!.command, ffprobe = tools.find(tool => tool.name === "ffprobe")!.command;
      const count = render.endFrameExclusive - render.startFrame, rate = `${render.frameRate.numerator}/${render.frameRate.denominator}`, timeBase = `${render.frameRate.denominator}/${render.frameRate.numerator}`;
      const format = alpha ? "rgba" : "rgb24";
      const base = ["-v", "error", "-nostdin", "-threads", "1", "-filter_threads", "1", "-protocol_whitelist", "file,pipe", "-max_pixels", String(STUDIO_LIMITS.pixels)];
      const source = ["-f", "image2", "-framerate", rate, "-start_number", String(render.startFrame), "-start_number_range", "1", "-pattern_type", "sequence", "-i", `${join(jobRoot, "outputs").replaceAll("%", "%%")}/${output.pathPattern}`];
      const videoInput = ["-format_whitelist", "mov", "-enable_drefs", "0", "-use_absolute_path", "0"];
      // PNGs need not carry color tags. Apply the retained authored interpretation
      // to decoded frames as well as the encoder; x264 otherwise inherits unknowns.
      const conversion = ["-map", "0:v:0", "-frames:v", String(count), "-an", "-sws_flags", "accurate_rnd+bitexact+full_chroma_int", "-sws_dither", "none", "-vf", `format=${format},setparams=range=full:color_primaries=bt709:color_trc=iec61966-2-1:colorspace=gbr`, "-fps_mode", "passthrough", "-enc_time_base", timeBase];
      const hashArgs = ["-c:v", "rawvideo", "-threads:v", "1", "-pix_fmt", format, "-f", "framehash", "-hash", "sha256", "pipe:1"];
      const logLimit = Math.min(4_194_304, count * 160 + 16_384);
      const sourceText = (await runner.run([ffmpeg, ...base, ...source, ...conversion, ...hashArgs], { maxOutputBytes: logLimit })).stdout;
      const canonicalFrameSha256 = verifyStudioFramehash(sourceText, render, alpha);
      const sourceFramehash = await retainText("source.framehash", sourceText);
      if (existingVideo === undefined) {
        await verifySource();
        await runner.run([ffmpeg, ...base, ...source, ...conversion,
          ...(alpha ? ["-c:v", "qtrle", "-pix_fmt", "argb"] : ["-c:v", "libx264rgb", "-preset", "veryfast", "-crf", "0", "-bf", "0", "-pix_fmt", "rgb24"]),
          "-threads:v", "1", "-color_range", "pc", "-color_primaries", "bt709", "-color_trc", "iec61966-2-1", "-colorspace", "rgb", "-video_track_timescale", String(render.frameRate.numerator),
          "-avoid_negative_ts", "disabled", "-fs", String(request.limits.maximumOutputBytes), "-f", alpha ? "mov" : "mp4", "-n", join(directory, video)]);
      }
      const before = await artifact(video, request.limits.maximumOutputBytes);
      const probeText = (await runner.run([ffprobe, "-v", "error", "-threads", "1", "-protocol_whitelist", "file", "-max_pixels", String(STUDIO_LIMITS.pixels), ...videoInput, "-count_frames", "-show_entries", "stream=codec_type,codec_name,pix_fmt,width,height,avg_frame_rate,time_base,start_pts,duration_ts,nb_read_frames,color_range,color_space,color_transfer,color_primaries", "-of", "json", join(directory, video)], { maxOutputBytes: 65_536 })).stdout;
      const probe = await retainText("probe.json", probeText);
      verifyProbe(probeText, request);
      const videoText = (await runner.run([ffmpeg, ...base, ...videoInput, "-i", join(directory, video), ...conversion, ...hashArgs], { maxOutputBytes: logLimit })).stdout;
      if (verifyStudioFramehash(videoText, render, alpha) !== canonicalFrameSha256) throw new CliError("invalid-data", "Decoded studio video pixels differ from the canonical source frames.");
      await verifySource();
      for (const tool of tools) await assertExactCapabilityExecutable(tool);
      if (studioJson(before) !== studioJson(await artifact(video, request.limits.maximumOutputBytes))) throw new CliError("conflict", "Studio video changed during verification.");
      const document: StudioEncodeReceipt = { kind: "atet.studio-encode-receipt", schemaVersion: 1, requestSha256, request, artifact: before,
        verification: { frameCount: count, canonicalFrameSha256, sourceFramehash, videoFramehash: await retainText("video.framehash", videoText), probe } };
      await assertBudget();
      const receipt = await retainText("receipt.json", studioJson(document));
      await fence();
      return { artifact: before, receipt, document };
    });
  });
}
