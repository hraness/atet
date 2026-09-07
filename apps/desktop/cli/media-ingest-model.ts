import { z } from "zod";
import {
  ProjectAssetRoleSchema, ProjectAssetV1Schema, ProjectMediaStreamSchema,
  RepositoryRelativePathSchema, type ProjectAssetV1,
} from "../contracts";
import { CliError } from "./errors";
import type { ProcessRunner } from "./io";
import type { MediaIngestDurability } from "./media-ingest-platform";

export const MAX_MEDIA_BYTES = 4 * 1024 * 1024 * 1024 * 1024;
export const MAX_PROBE_BYTES = 4 * 1024 * 1024;
export const MAX_PROBE_TIMEOUT_MS = 2 * 60_000;
export const SELF_CONTAINED_MEDIA_INPUT_ARGUMENTS = [
  "-protocol_whitelist",
  "file",
  "-format_whitelist",
  [
    "aac",
    "ac3",
    "aiff",
    "alaw",
    "amr",
    "ape",
    "apng",
    "asf",
    "au",
    "av1",
    "avi",
    "bmp_pipe",
    "caf",
    "dv",
    "eac3",
    "flac",
    "flv",
    "g722",
    "g726",
    "gif",
    "gsm",
    "h261",
    "h263",
    "h264",
    "hevc",
    "ircam",
    "ivf",
    "jpeg_pipe",
    "m4v",
    "matroska",
    "mov",
    "mp3",
    "mpeg",
    "mpegts",
    "mpegvideo",
    "mulaw",
    "mxf",
    "nut",
    "ogg",
    "oma",
    "opus",
    "png_pipe",
    "rawvideo",
    "rm",
    "vvc",
    "w64",
    "wav",
    "webm",
    "webp_pipe",
    "tiff_pipe",
    "yuv4mpegpipe",
  ].join(","),
] as const;

const ProbeStreamSchema = z.strictObject({
  avg_frame_rate: z.string().optional(),
  channels: z.number().int().positive().optional(),
  codec_name: z.string().min(1),
  codec_type: z.string().min(1).max(64),
  duration: z.string().optional(),
  disposition: z.strictObject({
    attached_pic: z.union([z.boolean(), z.number().int().min(0).max(1)]).optional(),
    still_image: z.union([z.boolean(), z.number().int().min(0).max(1)]).optional(),
    timed_thumbnails: z.union([z.boolean(), z.number().int().min(0).max(1)]).optional(),
  }).optional(),
  height: z.number().int().positive().optional(),
  index: z.number().int().nonnegative(),
  r_frame_rate: z.string().optional(),
  sample_rate: z.string().optional(),
  start_time: z.string().optional(),
  tags: z.strictObject({
    DURATION: z.string().optional(),
    duration: z.string().optional(),
  }).optional(),
  width: z.number().int().positive().optional(),
});

const ProbeOutputSchema = z.strictObject({
  format: z.strictObject({
    duration: z.string().optional(),
    format_name: z.string().min(1),
    start_time: z.string().optional(),
  }),
  programs: z.array(z.never()).max(0).optional(),
  stream_groups: z.array(z.never()).max(0).optional(),
  streams: z.array(ProbeStreamSchema).min(1).max(256),
});

export interface ProbedMediaStream extends z.infer<typeof ProbeStreamSchema> {
  readonly assetRange: Readonly<{ readonly endUs: number; readonly startUs: number }>;
  readonly fileRange: Readonly<{ readonly endUs: number; readonly startUs: number }>;
}

export interface ProbedMedia {
  readonly container: string;
  readonly durationUs: number;
  readonly streams: readonly ProbedMediaStream[];
}

function decimalDurationToUs(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const seconds = Number(value);
  const microseconds = Math.round(seconds * 1_000_000);
  return Number.isFinite(seconds) && Number.isSafeInteger(microseconds) && microseconds > 0
    ? microseconds
    : null;
}

function decimalTimestampToUs(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const seconds = Number(value);
  const microseconds = Math.round(seconds * 1_000_000);
  return Number.isFinite(seconds) && Number.isSafeInteger(microseconds) ? microseconds : null;
}

function durationTagToUs(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const match = /^(?<hours>[0-9]+):(?<minutes>[0-5][0-9]):(?<seconds>[0-5][0-9])(?:\.(?<fraction>[0-9]{1,9}))?$/u.exec(value);
  if (match?.groups === undefined) return null;
  const wholeSeconds = Number(match.groups.hours) * 3_600
    + Number(match.groups.minutes) * 60
    + Number(match.groups.seconds);
  const fraction = match.groups.fraction ?? "";
  const microseconds = wholeSeconds * 1_000_000 + Math.round(Number(`0.${fraction}`) * 1_000_000);
  return Number.isSafeInteger(microseconds) && microseconds > 0 ? microseconds : null;
}

function safeTimeSum(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new CliError("invalid-data", `${label} exceeds the supported timestamp range.`);
  }
  return result;
}

function rational(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = /^(?<numerator>[0-9]+)\/(?<denominator>[0-9]+)?$/u.exec(value);
  if (match?.groups?.numerator === undefined) return null;
  const numerator = Number(match.groups.numerator);
  const denominator = Number(match.groups.denominator ?? "1");
  const result = numerator / denominator;
  return Number.isFinite(result) && result > 0 ? result : null;
}

export function parseMediaProbe(input: string): ProbedMedia {
  let json: unknown;
  try {
    json = JSON.parse(input) as unknown;
  } catch {
    throw new CliError("invalid-data", "FFprobe media output is not valid JSON.");
  }
  const parsed = ProbeOutputSchema.safeParse(json);
  if (!parsed.success) {
    throw new CliError("invalid-data", `FFprobe media output is invalid: ${parsed.error.issues[0]?.message ?? "unknown error"}`);
  }
  const playableStreams = parsed.data.streams.filter(
    (stream): stream is typeof stream & { readonly codec_type: "audio" | "video" } => (
      (stream.codec_type === "audio" || stream.codec_type === "video")
      && (
        stream.codec_type !== "video"
        || (
          stream.disposition?.attached_pic !== 1
          && stream.disposition?.attached_pic !== true
          && stream.disposition?.still_image !== 1
          && stream.disposition?.still_image !== true
          && stream.disposition?.timed_thumbnails !== 1
          && stream.disposition?.timed_thumbnails !== true
        )
      )
    ),
  );
  if (playableStreams.length === 0) {
    throw new CliError("invalid-data", "Media contains no playable audio or video streams after attached pictures are excluded.");
  }
  if (playableStreams.length > 64) {
    throw new CliError("invalid-data", "Media contains more than 64 playable audio/video streams.");
  }
  const formatDurationUs = decimalDurationToUs(parsed.data.format.duration);
  if (
    formatDurationUs === null
    && playableStreams.every(stream => (
      decimalDurationToUs(stream.duration) === null
      && durationTagToUs(stream.tags?.DURATION ?? stream.tags?.duration) === null
    ))
  ) {
    throw new CliError("invalid-data", "Media has no positive finite duration.");
  }
  const formatStartUs = decimalTimestampToUs(parsed.data.format.start_time);
  const explicitStarts = playableStreams.flatMap(stream => {
    const startUs = decimalTimestampToUs(stream.start_time);
    return startUs === null ? [] : [startUs];
  });
  const clockOriginUs = Math.min(formatStartUs ?? Number.POSITIVE_INFINITY, ...explicitStarts);
  const commonOriginUs = Number.isFinite(clockOriginUs) ? clockOriginUs : 0;
  const formatEndUs = formatDurationUs === null
    ? null
    : safeTimeSum(formatStartUs ?? commonOriginUs, formatDurationUs, "Media format duration");
  const streams: ProbedMediaStream[] = [];
  for (const stream of playableStreams) {
    if (stream.codec_type === "video") {
      if (stream.width === undefined || stream.height === undefined) {
        throw new CliError("invalid-data", `Video stream ${stream.index} omits pixel dimensions.`);
      }
      if ((rational(stream.avg_frame_rate) ?? rational(stream.r_frame_rate)) === null) {
        throw new CliError("invalid-data", `Video stream ${stream.index} omits a positive frame rate.`);
      }
    } else {
      if (stream.channels === undefined || !/^[1-9][0-9]*$/u.test(stream.sample_rate ?? "")) {
        throw new CliError("invalid-data", `Audio stream ${stream.index} omits channel or sample-rate facts.`);
      }
    }
    const nativeStartUs = decimalTimestampToUs(stream.start_time) ?? formatStartUs ?? commonOriginUs;
    const startUs = nativeStartUs - commonOriginUs;
    if (!Number.isSafeInteger(startUs) || startUs < 0) {
      throw new CliError("invalid-data", `Stream ${stream.index} has an invalid start time.`);
    }
    const streamDurationUs = decimalDurationToUs(stream.duration)
      ?? durationTagToUs(stream.tags?.DURATION ?? stream.tags?.duration)
      ?? (formatEndUs === null ? null : formatEndUs - nativeStartUs);
    if (streamDurationUs === null || !Number.isSafeInteger(streamDurationUs) || streamDurationUs <= 0) {
      throw new CliError("invalid-data", `Stream ${stream.index} has no positive finite duration.`);
    }
    const endUs = safeTimeSum(startUs, streamDurationUs, `Stream ${stream.index} duration`);
    streams.push({
      ...stream,
      assetRange: { endUs, startUs },
      fileRange: { endUs, startUs },
    });
  }
  const formatCoverageEndUs = formatEndUs === null ? 0 : formatEndUs - commonOriginUs;
  const durationUs = Math.max(formatCoverageEndUs, ...streams.map(stream => stream.assetRange.endUs));
  if (!Number.isSafeInteger(durationUs) || durationUs <= 0) {
    throw new CliError("invalid-data", "Media has no positive finite duration.");
  }
  return {
    container: parsed.data.format.format_name.split(",")[0]!,
    durationUs,
    streams,
  };
}

function importedStreamRole(
  assetRole: z.infer<typeof ProjectAssetRoleSchema>,
  streamKind: "audio" | "video",
): string {
  if (streamKind === "video") {
    if (assetRole === "camera") return "camera";
    if (assetRole === "b-roll") return "b-roll";
    if (assetRole === "screen") return "screen";
    return "other";
  }
  if (
    assetRole === "system-audio"
    || assetRole === "microphone"
    || assetRole === "portable-audio"
    || assetRole === "music"
    || assetRole === "dialogue"
  ) return assetRole;
  return "other";
}

export interface IngestProjectMediaOptions {
  /** @internal Injectable durability boundary for focused fault and ordering tests. */
  readonly durability?: MediaIngestDurability;
  readonly ffprobe: string;
  readonly now: Date;
  readonly projectDirectory: string;
  readonly repositoryRoot: string;
  readonly role: z.input<typeof ProjectAssetRoleSchema>;
  readonly runner: ProcessRunner;
  readonly sourcePath: string;
}

export interface IngestedProjectMedia {
  readonly absolutePath: string;
  readonly asset: ProjectAssetV1;
  readonly created: boolean;
}

export interface StagedMediaImport {
  readonly absolutePath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly temporaryPath: string;
  readonly importsDirectory: string;
  readonly identity: Readonly<{ dev: number; ino: number }>;
}

export function importedAsset(
  options: IngestProjectMediaOptions,
  role: z.infer<typeof ProjectAssetRoleSchema>,
  imported: StagedMediaImport,
  probe: ProbedMedia,
  path: z.infer<typeof RepositoryRelativePathSchema>,
  label: string,
): ProjectAssetV1 {
  const assetId = `asset_${imported.sha256.slice(0, 24)}`;
  const streams = probe.streams.map(stream => {
    const base = {
      label: `${stream.codec_type} stream ${stream.index}`,
      segments: [{
        assetRange: stream.assetRange,
        bytes: imported.bytes,
        codec: stream.codec_name,
        container: probe.container,
        fileRange: stream.fileRange,
        path,
        sha256: imported.sha256,
        streamIndex: stream.index,
      }],
      streamId: `stream_${imported.sha256.slice(0, 20)}_${stream.index}`,
    };
    if (stream.codec_type === "video") {
      return ProjectMediaStreamSchema.parse({
        ...base,
        frameRate: rational(stream.avg_frame_rate) ?? rational(stream.r_frame_rate)!,
        kind: "video",
        pixelHeight: stream.height,
        pixelWidth: stream.width,
        role: importedStreamRole(role, "video"),
      });
    }
    return ProjectMediaStreamSchema.parse({
      ...base,
      channels: stream.channels,
      kind: "audio",
      role: importedStreamRole(role, "audio"),
      sampleRateHz: Number(stream.sample_rate),
    });
  });
  const asset = ProjectAssetV1Schema.parse({
    assetId,
    createdAt: options.now.toISOString(),
    durationUs: probe.durationUs,
    label: label,
    role,
    source: {
      importedAt: options.now.toISOString(),
      kind: "imported",
      originalName: label,
      sourceSha256: imported.sha256,
    },
    streams,
  });
  return asset;
}
