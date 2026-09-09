import { join } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { STUDIO_LIMITS, type StudioJob, type StudioOutputArtifact } from "../../../src/studio";
import type { ApplicationContext } from "../application/context";
import { bindExactCapability } from "../application/capability-binding";
import { readStudioBytes, readStudioFileEdges } from "./studio-files";
import { inspectStudioExrHeader } from "./studio-exr";
import type { StudioProcessPort } from "./studio-process";

export interface StudioOutputValidation {
  readonly outputId: string; readonly path: string;
  readonly validation: "decoded-raster" | "decoded-video" | "decoded-audio" | "format-header" | "opaque-cache" | "inert-source";
  readonly width?: number; readonly height?: number; readonly frameCount?: number;
}

const probeSchema = z.object({ streams: z.array(z.object({
  codec_type: z.string(), codec_name: z.string().optional(), width: z.number().int().optional(), height: z.number().int().optional(),
  pix_fmt: z.string().optional(), avg_frame_rate: z.string().optional(), nb_read_frames: z.string().optional(),
  sample_rate: z.string().optional(), channels: z.number().int().optional(), time_base: z.string().max(32).optional(),
})).max(32), format: z.object({ format_name: z.string().min(1).max(128) }), frames: z.array(z.object({
  best_effort_timestamp: z.number().int().safe(), duration: z.number().int().safe().positive().optional(), pkt_duration: z.number().int().safe().positive().optional(),
  width: z.number().int().positive(), height: z.number().int().positive(), pix_fmt: z.string().min(1).max(64),
})).max(STUDIO_LIMITS.frames).optional() });

const mediaFormats = {
  mp4: { demuxer: "mov", names: ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"] },
  mov: { demuxer: "mov", names: ["mov", "mp4", "m4a", "3gp", "3g2", "mj2"] },
  webm: { demuxer: "matroska", names: ["matroska", "webm"] },
  wav: { demuxer: "wav", names: ["wav"] }, flac: { demuxer: "flac", names: ["flac"] }, mp3: { demuxer: "mp3", names: ["mp3"] },
  exr: { demuxer: "exr_pipe", names: ["exr_pipe"] },
} as const;
type ProbedFormat = keyof typeof mediaFormats;
// The portable contract can describe higher precision, but this verified video
// delivery profile is RGB(A)8 only. Preserve uint16 PNG and float EXR masters;
// 10/12/16-bit and floating video need separately qualified format profiles.
const rgb8VideoPixels = new Set(["rgb24", "bgr24", "gbrp", "yuv420p", "yuv422p", "yuv444p", "yuvj420p", "yuvj422p", "yuvj444p"]);
const rgba8VideoPixels = new Set(["rgba", "bgra", "argb", "abgr", "gbrap", "yuva420p", "yuva422p", "yuva444p"]);

function mediaInputArguments(format: ProbedFormat): readonly string[] {
  const { demuxer } = mediaFormats[format];
  return ["-protocol_whitelist", "file", "-format_whitelist", demuxer, "-f", demuxer,
    ...(demuxer === "mov" ? ["-enable_drefs", "0", "-use_absolute_path", "0"] : []),
    "-max_pixels", String(STUDIO_LIMITS.pixels), "-threads", "1"];
}

/** Each rational timestamp may be quantized by less than one container tick; drift cannot accumulate. */
function validateVideoClock(probe: z.infer<typeof probeSchema>, render: NonNullable<StudioJob["render"]>): void {
  const stream = probe.streams[0]!, frames = probe.frames;
  const base = /^([1-9]\d{0,8})\/([1-9]\d{0,8})$/u.exec(stream.time_base ?? "");
  const count = render.endFrameExclusive - render.startFrame;
  if (base === null || frames?.length !== count) throw new Error("Studio video requires every decoded timestamp and a bounded exact time base.");
  const denominator = BigInt(render.frameRate.numerator) * BigInt(base[1]!);
  const step = BigInt(render.frameRate.denominator) * BigInt(base[2]!);
  // A clock coarser than a frame cannot establish every individual frame boundary.
  if (step < denominator) throw new Error("Studio video time base cannot represent its declared frame cadence.");
  const matches = (ticks: number, index: number, quantizedValues = 1n) => {
    const delta = BigInt(ticks) * denominator - BigInt(index) * step;
    return delta > -denominator * quantizedValues && delta < denominator * quantizedValues;
  };
  for (const [index, frame] of frames.entries()) {
    if (index === 0 && frame.best_effort_timestamp !== 0 || index > 0 && frame.best_effort_timestamp <= frames[index - 1]!.best_effort_timestamp
      || !matches(frame.best_effort_timestamp, index) || frame.width !== render.width || frame.height !== render.height || frame.pix_fmt !== stream.pix_fmt) {
      throw new Error("Studio decoded frames differ from their zero-based rational clock or fixed pixel profile.");
    }
    const duration = frame.duration ?? frame.pkt_duration;
    if (frame.duration !== undefined && frame.pkt_duration !== undefined && frame.duration !== frame.pkt_duration) throw new Error("Studio decoded frame durations disagree.");
    // Matroska quantizes nominal duration independently of PTS. Their sum has two
    // bounded quantization errors, while each PTS and duration must still match on its own.
    if (duration !== undefined && (!matches(duration, 1) || !Number.isSafeInteger(frame.best_effort_timestamp + duration) || !matches(frame.best_effort_timestamp + duration, index + 1, 2n))) {
      throw new Error("Studio decoded frame duration differs from its rational end boundary.");
    }
    if (index === count - 1 && duration === undefined) throw new Error("Studio video requires the final decoded frame duration to prove end coverage.");
  }
}

/** Observed pixel/stream properties are checked; native units and cache meaning remain declared source semantics. */
export async function validateStudioOutputMedia(input: {
  readonly application: ApplicationContext; readonly process: StudioProcessPort; readonly root: string;
  readonly job: StudioJob; readonly outputs: readonly StudioOutputArtifact[]; readonly signal: AbortSignal;
  readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly inheritedFileDescriptors?: readonly number[];
  readonly fence: () => Promise<void>;
}): Promise<readonly StudioOutputValidation[]> {
  const evidence: StudioOutputValidation[] = [];
  for (const artifact of input.outputs) {
    if (input.signal.aborted) throw new Error("Studio output validation cancelled.");
    await input.fence();
    const output = input.job.outputs.find(output => output.id === artifact.outputId)!;
    const path = join(input.root, artifact.path);
    if (artifact.format === "png") {
      const bytes = await readStudioBytes(path, artifact, 272 * 1024 * 1024);
      const metadata = await sharp(bytes, { failOn: "error", limitInputPixels: 33_554_432, animated: true }).metadata();
      const interpretation = output.interpretation;
      if (interpretation.kind !== "raster" || metadata.format !== "png" || (metadata.pages ?? 1) !== 1
        || metadata.width !== input.job.render?.width || metadata.height !== input.job.render.height
        || metadata.channels !== interpretation.channels.length
        || Boolean(metadata.hasAlpha) !== ["straight", "premultiplied"].includes(interpretation.alpha)
        || (interpretation.dataType === "uint16" ? metadata.depth !== "ushort" : metadata.depth !== "uchar")) throw new Error(`Studio PNG profile differs from its declaration: ${artifact.path}`);
      await sharp(bytes, { failOn: "error", limitInputPixels: 33_554_432 }).raw().toBuffer();
      evidence.push({ outputId: output.id, path: artifact.path, validation: "decoded-raster", width: metadata.width, height: metadata.height, frameCount: 1 });
    } else if (["mp4", "mov", "webm", "wav", "flac", "mp3", "exr"].includes(artifact.format)) {
      if (artifact.format === "exr") {
        const header = inspectStudioExrHeader((await readStudioFileEdges(path, artifact.bytes, 1_048_576)).first);
        const interpretation = output.interpretation;
        if (interpretation.kind !== "raster" || header.width !== input.job.render?.width || header.height !== input.job.render.height
          || header.channels.some(channel => channel.dataType !== interpretation.dataType)
          || header.channels.map(channel => channel.name).sort().join("\0") !== [...interpretation.channels].sort().join("\0")
          || header.channels.some(channel => channel.name === "A") !== ["straight", "premultiplied"].includes(interpretation.alpha)) throw new Error("Studio EXR channel/type/alpha profile differs from its declaration.");
      }
      const format = artifact.format as ProbedFormat, video = ["mp4", "mov", "webm"].includes(format);
      const capability = await bindExactCapability(await input.application.capability("ffprobe"));
      const entries = "stream=codec_type,codec_name,width,height,pix_fmt,avg_frame_rate,nb_read_frames,sample_rate,channels,time_base:format=format_name"
        + (video ? ":frame=best_effort_timestamp,duration,pkt_duration,width,height,pix_fmt:frame_side_data=" : "");
      const result = await input.process.run([capability.executablePath, "-v", "error", ...mediaInputArguments(format), "-count_frames", "-show_streams", "-show_format",
        ...(video ? ["-show_frames"] : []), "-show_entries", entries, "-of", "json=compact=1", path], {
        cwd: input.cwd, env: input.env, timeoutMs: Math.min(input.job.limits.timeoutSeconds * 1000, 300_000), maximumLogBytes: 4_194_304,
        signal: input.signal, ...(input.inheritedFileDescriptors === undefined ? {} : { inheritedFileDescriptors: input.inheritedFileDescriptors }),
      });
      if (result.exitCode !== 0 || result.failure !== undefined || result.custody !== "closed" || result.stderr.trim() !== "") throw new Error(`Studio output does not fully decode: ${artifact.path}`);
      const probe = probeSchema.parse(JSON.parse(result.stdout) as unknown);
      const names = probe.format.format_name.split(","), allowed: readonly string[] = mediaFormats[format].names;
      if (!names.includes(mediaFormats[format].demuxer) || names.some(name => !allowed.includes(name))) throw new Error("Studio media container differs from its declared format family.");
      const interpretation = output.interpretation;
      if (probe.streams.length !== 1) throw new Error("Studio outputs require exactly one declared media stream.");
      const stream = probe.streams[0]!;
      if (interpretation.kind === "audio") {
        if (stream.codec_type !== "audio" || stream.sample_rate !== String(interpretation.sampleRate) || stream.channels !== interpretation.channels || !(Number(stream.nb_read_frames) > 0)) throw new Error("Studio audio differs from its declared profile.");
        evidence.push({ outputId: output.id, path: artifact.path, validation: "decoded-audio" });
      } else {
        const render = input.job.render;
        if (interpretation.kind !== "raster" || render === undefined || stream.codec_type !== "video" || stream.width !== render.width || stream.height !== render.height) throw new Error("Studio raster differs from its dimensions or type.");
        const frameCount = artifact.format === "exr" ? 1 : render.endFrameExclusive - render.startFrame;
        if (stream.nb_read_frames !== String(frameCount)) throw new Error("Studio decoded frame count differs from its exact interval.");
        if (artifact.format !== "exr") {
          const rate = /^([1-9]\d{0,8})\/([1-9]\d{0,8})$/u.exec(stream.avg_frame_rate ?? "");
          if (rate === null || BigInt(rate[1]!) * BigInt(render.frameRate.denominator) !== BigInt(rate[2]!) * BigInt(render.frameRate.numerator)) throw new Error("Studio video cadence differs from its exact rational clock.");
          const pixels = stream.pix_fmt ?? "", alpha = rgba8VideoPixels.has(pixels);
          if (!rgb8VideoPixels.has(pixels) && !alpha || interpretation.dataType !== "uint8"
            || interpretation.channels.join(",") !== (alpha ? "R,G,B,A" : "R,G,B")) {
            throw new Error("Studio video requires a verified 8-bit RGB/RGBA delivery profile; retain higher precision in PNG or EXR masters.");
          }
          if (alpha !== ["straight", "premultiplied"].includes(interpretation.alpha)) throw new Error("Studio video alpha differs from its declaration.");
          validateVideoClock(probe, render);
        }
        evidence.push({ outputId: output.id, path: artifact.path, validation: artifact.format === "exr" ? "decoded-raster" : "decoded-video", width: render.width, height: render.height, frameCount });
      }
    } else if (artifact.format === "cache") evidence.push({ outputId: output.id, path: artifact.path, validation: "opaque-cache" });
    else if (artifact.format === "py") evidence.push({ outputId: output.id, path: artifact.path, validation: "inert-source" });
    else {
      // Native formats are retained as native authority. This checks framing, not a universal semantic round trip.
      const { first: bytes, last } = await readStudioFileEdges(path, artifact.bytes);
      const valid = artifact.format === "glb" ? bytes.length >= 20 && bytes.toString("ascii", 0, 4) === "glTF" && bytes.readUInt32LE(4) === 2 && bytes.readUInt32LE(8) === artifact.bytes
        : artifact.format === "blend" ? bytes.toString("ascii", 0, 7) === "BLENDER" || bytes.subarray(0, 4).equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))
          : artifact.format === "step" ? bytes.toString("ascii").includes("ISO-10303-21;") && last.toString("ascii").includes("END-ISO-10303-21;")
            : artifact.format === "usdc" ? bytes.toString("ascii", 0, 8) === "PXR-USDC" : artifact.format === "usda" ? bytes.toString("ascii", 0, 9) === "#usda 1.0"
              : artifact.format === "usd" && (bytes.toString("ascii", 0, 8) === "PXR-USDC" || bytes.toString("ascii", 0, 9) === "#usda 1.0");
      if (!valid) throw new Error(`Studio native output has invalid format framing: ${artifact.path}`);
      evidence.push({ outputId: output.id, path: artifact.path, validation: "format-header" });
    }
  }
  return evidence;
}
