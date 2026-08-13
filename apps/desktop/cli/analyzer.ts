import { CliError } from "./errors";
import type { ProcessRunner } from "./io";

export interface DetectedInterval {
  readonly endUs: number;
  readonly startUs: number;
}

interface OpenDetection {
  readonly startUs: number;
  durationUs?: number;
}

function secondsToMicroseconds(value: string, label: string): number {
  const seconds = Number(value);
  const microseconds = Math.round(seconds * 1_000_000);
  if (!Number.isFinite(seconds) || !Number.isSafeInteger(microseconds) || microseconds < 0) {
    throw new CliError("invalid-data", `Invalid ${label} timestamp from FFmpeg: ${value}`);
  }
  return microseconds;
}

function parseDetections(
  output: string,
  labels: Readonly<{ readonly duration: RegExp; readonly end: RegExp; readonly start: RegExp }>,
  mediaDurationUs?: number,
): readonly DetectedInterval[] {
  const intervals: DetectedInterval[] = [];
  let open: OpenDetection | undefined;
  for (const line of output.split(/\r?\n/u)) {
    const start = labels.start.exec(line);
    if (start?.groups?.value !== undefined) {
      open = { startUs: secondsToMicroseconds(start.groups.value, "start") };
      continue;
    }
    const duration = labels.duration.exec(line);
    if (duration?.groups?.value !== undefined && open !== undefined) {
      open.durationUs = secondsToMicroseconds(duration.groups.value, "duration");
      continue;
    }
    const end = labels.end.exec(line);
    if (end?.groups?.value !== undefined && open !== undefined) {
      const endUs = secondsToMicroseconds(end.groups.value, "end");
      if (endUs >= open.startUs) intervals.push({ endUs, startUs: open.startUs });
      open = undefined;
    }
  }
  if (open !== undefined) {
    const endUs = open.durationUs === undefined
      ? mediaDurationUs
      : open.startUs + open.durationUs;
    if (endUs !== undefined && endUs >= open.startUs) intervals.push({ endUs, startUs: open.startUs });
  }
  return intervals;
}

const NUMBER = String.raw`(?<value>[0-9]+(?:\.[0-9]+)?)`;

export function parseFreezeDetectOutput(
  output: string,
  mediaDurationUs?: number,
): readonly DetectedInterval[] {
  return parseDetections(output, {
    duration: new RegExp(String.raw`(?:lavfi\.freezedetect\.)?freeze_duration\s*[:=]\s*${NUMBER}`, "u"),
    end: new RegExp(String.raw`(?:lavfi\.freezedetect\.)?freeze_end\s*[:=]\s*${NUMBER}`, "u"),
    start: new RegExp(String.raw`(?:lavfi\.freezedetect\.)?freeze_start\s*[:=]\s*${NUMBER}`, "u"),
  }, mediaDurationUs);
}

export function parseSilenceDetectOutput(
  output: string,
  mediaDurationUs?: number,
): readonly DetectedInterval[] {
  return parseDetections(output, {
    duration: new RegExp(String.raw`silence_duration\s*[:=]\s*${NUMBER}`, "u"),
    end: new RegExp(String.raw`silence_end\s*[:=]\s*${NUMBER}`, "u"),
    start: new RegExp(String.raw`silence_start\s*[:=]\s*${NUMBER}`, "u"),
  }, mediaDurationUs);
}

export interface MediaProbeSummary {
  readonly durationUs: number;
  readonly hasAudio: boolean;
}

export interface VisualMediaProbeSummary {
  readonly audioEndUs: number | null;
  readonly audioStartUs: number;
  readonly audioStreamIndex: number | null;
  readonly durationUs: number | null;
  readonly hasAudio: boolean;
  readonly pixelHeight: number;
  readonly pixelWidth: number;
  readonly videoStartUs: number;
  readonly videoStreamIndex: number;
}

function signedSecondsToMicroseconds(value: string, label: string): number {
  const seconds = Number(value);
  const microseconds = Math.round(seconds * 1_000_000);
  if (!Number.isFinite(seconds) || !Number.isSafeInteger(microseconds)) {
    throw new CliError("invalid-data", `Invalid ${label} timestamp from FFprobe: ${value}`);
  }
  return microseconds;
}

function durationTagToMicroseconds(value: unknown, label: string): number | null {
  if (typeof value !== "string") return null;
  const match = /^(?<hours>[0-9]+):(?<minutes>[0-5][0-9]):(?<seconds>[0-5][0-9])(?:\.(?<fraction>[0-9]{1,9}))?$/u.exec(value);
  if (match?.groups === undefined) {
    throw new CliError("invalid-data", `Invalid ${label} duration tag from FFprobe: ${value}`);
  }
  const wholeSeconds = Number(match.groups.hours) * 3_600
    + Number(match.groups.minutes) * 60
    + Number(match.groups.seconds);
  const fraction = match.groups.fraction ?? "";
  const fractionalMicroseconds = Math.round(Number(`0.${fraction}`) * 1_000_000);
  const microseconds = wholeSeconds * 1_000_000 + fractionalMicroseconds;
  if (!Number.isSafeInteger(microseconds) || microseconds <= 0) {
    throw new CliError("invalid-data", `Invalid ${label} duration tag from FFprobe: ${value}`);
  }
  return microseconds;
}

function streamDurationUs(stream: Readonly<Record<string, unknown>>, label: string): number | null {
  if (typeof stream.duration === "string" && stream.duration !== "N/A") {
    const durationUs = secondsToMicroseconds(stream.duration, `${label} duration`);
    if (durationUs <= 0) throw new CliError("invalid-data", `FFprobe reported a non-positive ${label} duration.`);
    return durationUs;
  }
  const tags = stream.tags;
  if (tags === undefined) return null;
  if (typeof tags !== "object" || tags === null || Array.isArray(tags)) {
    throw new CliError("invalid-data", `FFprobe reported invalid ${label} stream tags.`);
  }
  const tagRecord = tags as Readonly<Record<string, unknown>>;
  return durationTagToMicroseconds(tagRecord.DURATION ?? tagRecord.duration, label);
}

function probeStreamIndex(stream: Readonly<Record<string, unknown>>, label: string): number {
  if (!Number.isSafeInteger(stream.index) || (stream.index as number) < 0) {
    throw new CliError("invalid-data", `FFprobe ${label} stream omits a valid absolute index.`);
  }
  return stream.index as number;
}

function isAttachedPicture(stream: Readonly<Record<string, unknown>>): boolean {
  const disposition = stream.disposition;
  if (disposition === undefined) return false;
  if (typeof disposition !== "object" || disposition === null || Array.isArray(disposition)) {
    throw new CliError("invalid-data", "FFprobe video stream has an invalid disposition.");
  }
  const attached = (disposition as Readonly<Record<string, unknown>>).attached_pic;
  if (attached === undefined || attached === false || attached === 0) return false;
  if (attached === true || attached === 1) return true;
  throw new CliError("invalid-data", "FFprobe video stream has an invalid attached-picture disposition.");
}

function selectLowestIndexedStream(
  streams: readonly Readonly<Record<string, unknown>>[],
  type: "audio" | "video",
): { readonly index: number; readonly stream: Readonly<Record<string, unknown>> } | undefined {
  return streams
    .filter(stream => stream.codec_type === type && (type !== "video" || !isAttachedPicture(stream)))
    .map(stream => ({ index: probeStreamIndex(stream, type), stream }))
    .sort((left, right) => left.index - right.index)[0];
}

function parseMediaSummaryJson(stdout: string): MediaProbeSummary {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new CliError("invalid-data", "FFprobe duration output is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliError("invalid-data", "FFprobe duration output must be an object.");
  }
  const format = (value as Readonly<Record<string, unknown>>).format;
  if (typeof format !== "object" || format === null || Array.isArray(format)) {
    throw new CliError("invalid-data", "FFprobe duration output omits format.");
  }
  const duration = (format as Readonly<Record<string, unknown>>).duration;
  if (typeof duration !== "string") {
    throw new CliError("invalid-data", "FFprobe duration output omits duration.");
  }
  const streams = (value as Readonly<Record<string, unknown>>).streams;
  if (streams !== undefined && !Array.isArray(streams)) {
    throw new CliError("invalid-data", "FFprobe duration output has invalid streams.");
  }
  const hasAudio = Array.isArray(streams) && streams.some(stream => (
    typeof stream === "object"
    && stream !== null
    && !Array.isArray(stream)
    && (stream as Readonly<Record<string, unknown>>).codec_type === "audio"
  ));
  return { durationUs: secondsToMicroseconds(duration, "duration"), hasAudio };
}

export async function probeMediaSummary(
  ffprobe: string,
  runner: ProcessRunner,
  path: string,
): Promise<MediaProbeSummary> {
  const result = await runner.run([
    ffprobe,
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type",
    "-of", "json",
    path,
  ], { maxOutputBytes: 32_000 });
  if (result.exitCode !== 0) {
    throw new CliError("subprocess", `FFprobe failed for ${path}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
  return parseMediaSummaryJson(result.stdout);
}

export async function probeVisualMediaSummary(
  ffprobe: string,
  runner: ProcessRunner,
  path: string,
): Promise<VisualMediaProbeSummary> {
  const result = await runner.run([
    ffprobe,
    "-v", "error",
    "-show_entries", "format=duration,start_time:stream=index,codec_type,width,height,duration,start_time:stream_disposition=attached_pic:stream_tags=duration",
    "-of", "json",
    path,
  ], { maxOutputBytes: 32_000 });
  if (result.exitCode !== 0) {
    throw new CliError("subprocess", `FFprobe failed for ${path}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new CliError("invalid-data", "FFprobe visual-media output is not valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliError("invalid-data", "FFprobe visual-media output must be an object.");
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (!Array.isArray(record.streams)) {
    throw new CliError("invalid-data", "FFprobe visual-media output omits streams.");
  }
  const streams = record.streams.filter((stream): stream is Readonly<Record<string, unknown>> => (
    typeof stream === "object" && stream !== null && !Array.isArray(stream)
  ));
  const selectedVideo = selectLowestIndexedStream(streams, "video");
  if (selectedVideo === undefined) {
    throw new CliError("invalid-data", "Overlay media has no non-attached visual video stream.");
  }
  const video = selectedVideo.stream;
  const selectedAudio = selectLowestIndexedStream(streams, "audio");
  const audio = selectedAudio?.stream;
  const pixelWidth = video?.width;
  const pixelHeight = video?.height;
  if (
    !Number.isSafeInteger(pixelWidth)
    || !Number.isSafeInteger(pixelHeight)
    || (pixelWidth as number) <= 0
    || (pixelHeight as number) <= 0
    || (pixelWidth as number) > 16_384
    || (pixelHeight as number) > 16_384
    || (pixelWidth as number) * (pixelHeight as number) > 134_217_728
  ) {
    throw new CliError("invalid-data", "Overlay intrinsic dimensions exceed the 16384-pixel or 128-megapixel safety limit.");
  }
  const format = record.format;
  const formatDuration = typeof format === "object" && format !== null && !Array.isArray(format)
    ? (format as Readonly<Record<string, unknown>>).duration
    : undefined;
  const startTime = video?.start_time;
  const formatStartTime = typeof format === "object" && format !== null && !Array.isArray(format)
    ? (format as Readonly<Record<string, unknown>>).start_time
    : undefined;
  const hasAudio = selectedAudio !== undefined;
  const formatStartUs = typeof formatStartTime === "string" && formatStartTime !== "N/A"
    ? signedSecondsToMicroseconds(formatStartTime, "format start")
    : 0;
  const videoStartUs = typeof startTime === "string" && startTime !== "N/A"
    ? signedSecondsToMicroseconds(startTime, "video start") - formatStartUs
    : 0;
  const audioStartUs = typeof audio?.start_time === "string" && audio.start_time !== "N/A"
    ? signedSecondsToMicroseconds(audio.start_time, "audio start") - formatStartUs
    : videoStartUs;
  const audioDurationUs = audio === undefined ? null : streamDurationUs(audio, "audio");
  const formatDurationUs = typeof formatDuration === "string" && formatDuration !== "N/A"
    ? secondsToMicroseconds(formatDuration, "format duration")
    : null;
  const normalizedFormatEndUs = formatDurationUs !== null && formatDurationUs > 0
    ? formatDurationUs
    : null;
  const audioEndUs = !hasAudio
    ? null
    : audioDurationUs === null
      ? normalizedFormatEndUs
      : audioStartUs + audioDurationUs;
  if (audioEndUs !== null && (!Number.isSafeInteger(audioEndUs) || audioEndUs <= audioStartUs)) {
    throw new CliError("invalid-data", "FFprobe reported an invalid audio stream end timestamp.");
  }
  const explicitVideoDurationUs = streamDurationUs(video, "video");
  const formatBoundedVideoDurationUs = normalizedFormatEndUs === null
    ? null
    : normalizedFormatEndUs - videoStartUs;
  const durationUs = explicitVideoDurationUs
    ?? (formatBoundedVideoDurationUs !== null && Number.isSafeInteger(formatBoundedVideoDurationUs) && formatBoundedVideoDurationUs > 0
      ? formatBoundedVideoDurationUs
      : null);
  return {
    audioEndUs,
    audioStartUs,
    audioStreamIndex: selectedAudio?.index ?? null,
    durationUs,
    hasAudio,
    pixelHeight: pixelHeight as number,
    pixelWidth: pixelWidth as number,
    videoStartUs,
    videoStreamIndex: selectedVideo.index,
  };
}

export async function probeMediaDuration(
  ffprobe: string,
  runner: ProcessRunner,
  path: string,
): Promise<number> {
  return (await probeMediaSummary(ffprobe, runner, path)).durationUs;
}

export interface MediaAnalyzerOptions {
  readonly ffmpeg: string;
  readonly ffprobe: string;
  readonly runner: ProcessRunner;
}

export class FfmpegInactivityAnalyzer {
  readonly #ffmpeg: string;
  readonly #ffprobe: string;
  readonly #runner: ProcessRunner;

  constructor(options: MediaAnalyzerOptions) {
    this.#ffmpeg = options.ffmpeg;
    this.#ffprobe = options.ffprobe;
    this.#runner = options.runner;
  }

  async duration(path: string): Promise<number> {
    return await probeMediaDuration(this.#ffprobe, this.#runner, path);
  }

  async freeze(
    path: string,
    streamIndex: number,
    minDurationUs: number,
    motionThreshold: number,
    sourceOffsetUs = 0,
  ): Promise<readonly DetectedInterval[]> {
    const durationUs = await this.duration(path);
    const result = await this.#runner.run([
      this.#ffmpeg,
      "-hide_banner",
      "-nostdin",
      "-i", path,
      "-map", `0:${streamIndex}`,
      "-vf", `freezedetect=n=${motionThreshold}:d=${minDurationUs / 1_000_000},metadata=mode=print`,
      "-an",
      "-f", "null",
      "-",
    ], { maxOutputBytes: 1_000_000 });
    if (result.exitCode !== 0) {
      throw new CliError("subprocess", `FFmpeg freeze analysis failed for ${path}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    }
    return parseFreezeDetectOutput(`${result.stdout}\n${result.stderr}`, durationUs).map(({ startUs, endUs }) => ({
      endUs: endUs + sourceOffsetUs,
      startUs: startUs + sourceOffsetUs,
    }));
  }

  async silence(
    path: string,
    streamIndex: number,
    minDurationUs: number,
    sourceOffsetUs = 0,
  ): Promise<readonly DetectedInterval[]> {
    const durationUs = await this.duration(path);
    const result = await this.#runner.run([
      this.#ffmpeg,
      "-hide_banner",
      "-nostdin",
      "-i", path,
      "-map", `0:${streamIndex}`,
      "-af", `silencedetect=noise=-45dB:d=${minDurationUs / 1_000_000},ametadata=mode=print`,
      "-vn",
      "-f", "null",
      "-",
    ], { maxOutputBytes: 1_000_000 });
    if (result.exitCode !== 0) {
      throw new CliError("subprocess", `FFmpeg silence analysis failed for ${path}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
    }
    return parseSilenceDetectOutput(`${result.stdout}\n${result.stderr}`, durationUs).map(({ startUs, endUs }) => ({
      endUs: endUs + sourceOffsetUs,
      startUs: startUs + sourceOffsetUs,
    }));
  }
}
