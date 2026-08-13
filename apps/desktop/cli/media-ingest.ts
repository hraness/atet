import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  link,
  mkdir,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, Writable } from "node:stream";

import { z } from "zod";

import {
  ProjectAssetRoleSchema,
  ProjectAssetV1Schema,
  ProjectMediaStreamSchema,
  RepositoryRelativePathSchema,
  type ProjectAssetV1,
} from "../contracts";
import { CliError } from "./errors";
import type { ProcessRunner } from "./io";
import { ensurePrivateDirectory } from "./paths";
import { verifyPhysicalProjectMedia } from "./project-media-integrity";

const MAX_MEDIA_BYTES = 4 * 1024 * 1024 * 1024 * 1024;
const MAX_PROBE_BYTES = 4 * 1024 * 1024;
const MAX_PROBE_TIMEOUT_MS = 2 * 60_000;
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

export async function probeProjectMedia(
  ffprobe: string,
  runner: ProcessRunner,
  path: string,
): Promise<ProbedMedia> {
  const result = await runner.run([
    ffprobe,
    "-v", "error",
    ...SELF_CONTAINED_MEDIA_INPUT_ARGUMENTS,
    "-show_entries", "format=duration,format_name,start_time:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels,start_time,duration:stream_disposition=attached_pic,still_image,timed_thumbnails:stream_tags=duration",
    "-of", "json",
    path,
  ], {
    maxOutputBytes: MAX_PROBE_BYTES,
    timeoutMs: MAX_PROBE_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw new CliError("subprocess", `FFprobe could not inspect imported media: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
  return parseMediaProbe(result.stdout);
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

export interface MediaIngestDurability {
  syncDirectory(path: string): Promise<void>;
  syncFile(handle: FileHandle, path: string): Promise<void>;
}

async function syncPhysicalDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const details = await directory.stat();
    if (!details.isDirectory()) {
      throw new CliError("unsafe-path", `Media durability path is not a physical directory: ${path}`);
    }
    await directory.sync();
  } finally {
    await directory.close();
  }
}

const DEFAULT_MEDIA_INGEST_DURABILITY: MediaIngestDurability = {
  syncDirectory: syncPhysicalDirectory,
  syncFile: async handle => await handle.sync(),
};

async function privateImportsDirectory(
  projectDirectory: string,
  durability: MediaIngestDurability,
): Promise<string> {
  await ensurePrivateDirectory(projectDirectory);
  const root = await realpath(projectDirectory);
  const imports = join(root, "imports");
  let created = false;
  try {
    const details = await lstat(imports);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new CliError("unsafe-path", `Project imports path is not a physical directory: ${imports}`);
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    await mkdir(imports, { mode: 0o700 });
    created = true;
  }
  const actual = await realpath(imports);
  if (!isWithin(root, actual)) throw new CliError("unsafe-path", "Project imports directory escaped its project.");
  // The imported file and its own directory entries are synced below. When
  // imports is new, its name also has to be durable in the project directory.
  if (created) await durability.syncDirectory(root);
  return actual;
}

async function removeStagedImport(
  temporaryPath: string,
  importsDirectory: string,
  durability: MediaIngestDurability,
): Promise<void> {
  await rm(temporaryPath, { force: true });
  await durability.syncDirectory(importsDirectory);
}

function fileHandleWriteStream(handle: FileHandle): Writable {
  let position = 0;
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const writeAll = async (): Promise<void> => {
        let offset = 0;
        while (offset < chunk.byteLength) {
          const result = await handle.write(
            chunk,
            offset,
            chunk.byteLength - offset,
            position + offset,
          );
          if (result.bytesWritten <= 0) {
            throw new Error("Media import made no progress while writing its staged file.");
          }
          offset += result.bytesWritten;
        }
        position += chunk.byteLength;
      };
      void writeAll().then(() => callback(), callback);
    },
  });
}

interface StagedMediaImport {
  readonly absolutePath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly temporaryPath: string;
  commit(): Promise<boolean>;
  dispose(): Promise<void>;
}

async function stageImport(
  projectDirectory: string,
  sourcePath: string,
  durability: MediaIngestDurability,
): Promise<StagedMediaImport> {
  const source = resolve(sourcePath);
  let before;
  try {
    before = await lstat(source);
  } catch {
    throw new CliError("not-found", `Media source does not exist: ${sourcePath}`);
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new CliError("unsafe-path", `Media source must be a physical regular file: ${sourcePath}`);
  }
  if (before.size <= 0 || before.size > MAX_MEDIA_BYTES) {
    throw new CliError("invalid-data", `Media source must contain 1 through ${MAX_MEDIA_BYTES} bytes.`);
  }
  const imports = await privateImportsDirectory(projectDirectory, durability);
  const temporary = join(imports, `.import-${randomUUID()}.tmp`);
  const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    const opened = await sourceHandle.stat();
    if (
      !opened.isFile()
      || opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
    ) {
      throw new CliError("conflict", "Media source changed before it was imported.");
    }
    const temporaryHandle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
      0o600,
    );
    try {
      await pipeline(
        sourceHandle.createReadStream({ autoClose: false }),
        new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            bytes += chunk.byteLength;
            if (bytes > MAX_MEDIA_BYTES) return callback(new Error("Media source exceeded its size bound while reading."));
            hash.update(chunk);
            callback(null, chunk);
          },
        }),
        fileHandleWriteStream(temporaryHandle),
      );
      const after = await sourceHandle.stat();
      if (
        after.dev !== opened.dev
        || after.ino !== opened.ino
        || after.size !== opened.size
        || bytes !== opened.size
        || after.mtimeMs !== opened.mtimeMs
        || after.ctimeMs !== opened.ctimeMs
      ) {
        throw new CliError("conflict", "Media source changed while it was being imported.");
      }
      // Sync the still-open staged inode before its first durable name can be
      // published. Closing and reopening by path would permit an inode swap.
      await durability.syncFile(temporaryHandle, temporary);
    } finally {
      await temporaryHandle.close();
    }
    const sha256 = hash.digest("hex");
    // Imported project media is keyed only by its immutable bytes. Keeping a
    // source-provided extension in the key would allow identical content under
    // a second filename to create an unreferenced duplicate blob.
    const destination = join(imports, `${sha256}.media`);
    return {
      absolutePath: destination,
      bytes,
      async commit() {
        try {
          await link(temporary, destination);
          await durability.syncDirectory(imports);
          return true;
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
          try {
            await verifyPhysicalProjectMedia(
              destination,
              { bytes, sha256 },
              `Content-addressed media ${sha256}`,
            );
          } catch (verificationError) {
            if (verificationError instanceof CliError && verificationError.code === "unsafe-path") {
              throw verificationError;
            }
            throw new CliError("conflict", `Content-addressed media collision for ${sha256}.`);
          }
          return false;
        }
      },
      dispose: async () => await removeStagedImport(temporary, imports, durability),
      sha256,
      temporaryPath: temporary,
    };
  } catch (error) {
    await removeStagedImport(temporary, imports, durability);
    throw error;
  } finally {
    await sourceHandle.close();
  }
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

export async function ingestProjectMedia(options: IngestProjectMediaOptions): Promise<IngestedProjectMedia> {
  const role = ProjectAssetRoleSchema.parse(options.role);
  let repositoryRoot: string;
  let projectDirectory: string;
  try {
    [repositoryRoot, projectDirectory] = await Promise.all([
      realpath(options.repositoryRoot),
      realpath(options.projectDirectory),
    ]);
  } catch {
    throw new CliError("not-found", "Project media import requires existing repository and project directories.");
  }
  if (!isWithin(repositoryRoot, projectDirectory)) {
    throw new CliError("unsafe-path", "Project media import directory is outside the repository.");
  }
  const imported = await stageImport(
    projectDirectory,
    options.sourcePath,
    options.durability ?? DEFAULT_MEDIA_INGEST_DURABILITY,
  );
  try {
    const probe = await probeProjectMedia(options.ffprobe, options.runner, imported.temporaryPath);
    const repositoryPath = relative(repositoryRoot, imported.absolutePath);
    if (!isWithin(repositoryRoot, imported.absolutePath) || isAbsolute(repositoryPath)) {
      throw new CliError("unsafe-path", "Imported media destination is outside the repository.");
    }
    const path = RepositoryRelativePathSchema.parse(repositoryPath);
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
      label: basename(options.sourcePath),
      role,
      source: {
        importedAt: options.now.toISOString(),
        kind: "imported",
        originalName: basename(options.sourcePath),
        sourceSha256: imported.sha256,
      },
      streams,
    });
    const created = await imported.commit();
    return { absolutePath: imported.absolutePath, asset, created };
  } finally {
    await imported.dispose();
  }
}
