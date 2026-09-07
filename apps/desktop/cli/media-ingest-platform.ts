import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, type Stats } from "node:fs";
import { type FileHandle, lstat, link, mkdir, open, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform, Writable } from "node:stream";
import { Cause, Context, Effect, Layer } from "effect";
import {
  operationBoundary, operationResource, operationValidation, type OperationEffectFailure,
} from "../application/operation-effects";
import { RepositoryRelativePathSchema } from "../contracts";
import { CliError } from "./errors";
import type { ProcessRunner, RunResult } from "./io";
import {
  MAX_MEDIA_BYTES, MAX_PROBE_BYTES, MAX_PROBE_TIMEOUT_MS,
  SELF_CONTAINED_MEDIA_INPUT_ARGUMENTS,
} from "./media-ingest-model";
import { ensurePrivateDirectory } from "./paths";
import { verifyPhysicalProjectMedia } from "./project-media-integrity";

export interface MediaIngestDurability {
  syncDirectory(path: string): Promise<void>;
  syncFile(handle: FileHandle, path: string): Promise<void>;
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

type Native<A> = Effect.Effect<A, OperationEffectFailure>;
export interface MediaIngestPlatformService {
  realpath(path: string): Native<string>;
  sourcePath(path: string): Native<string>;
  importsPath(root: string): Native<string>;
  temporaryPath(imports: string, name: string): Native<string>;
  destinationPath(imports: string, sha256: string): Native<string>;
  assertWithin(root: string, candidate: string, message: string): Native<void>;
  assetLocation(root: string, destination: string, source: string): Native<Readonly<{
    path: ReturnType<typeof RepositoryRelativePathSchema.parse>; label: string;
  }>>;
  lstat(path: string): Native<Stats>;
  ensurePrivateDirectory(path: string): Native<void>;
  mkdir(path: string): Native<void>;
  uniqueName(): Native<string>;
  openSource(path: string): Native<FileHandle>;
  openTemporary(path: string): Native<FileHandle>;
  stat(handle: FileHandle): Native<Stats>;
  close(handle: FileHandle): Native<void>;
  copy(source: FileHandle, staged: FileHandle): Native<Readonly<{ bytes: number; sha256: string }>>;
  syncFile(handle: FileHandle, path: string): Native<void>;
  syncDirectory(path: string): Native<void>;
  remove(path: string): Native<void>;
  link(source: string, destination: string): Native<void>;
  verify(path: string, expected: Readonly<{ bytes: number; sha256: string }>, label: string): Native<void>;
  probe(ffprobe: string, runner: ProcessRunner, path: string): Native<RunResult>;
}

export class MediaIngestPlatform extends Context.Tag("@atet/local/MediaIngestPlatform")<
  MediaIngestPlatform, MediaIngestPlatformService
>() { }

/** Each admitted foreign call retains custody until its actual settlement. */
function native<A>(execute: () => A | Promise<A>): Native<A> {
  return Effect.uninterruptible(operationBoundary("media", execute));
}

interface NativeStreamFailure {
  readonly cause: unknown;
  readonly signal: Error;
}

type CopyObservation =
  | Readonly<{ success: true; bytes: number; sha256: string }>
  | Readonly<{ success: false; cause: unknown; prior: readonly NativeStreamFailure[] }>;

function fileHandleReadStream(handle: FileHandle, recordFailure: (cause: unknown) => Error) {
  let pending = Promise.resolve();
  // The built-in stream owns backpressure, but borrows the numeric descriptor.
  // FileHandle.createReadStream adds a second close/ref owner on pinned Bun.
  // With an fd supplied, the empty path is never opened.
  const stream = createReadStream("", {
    fd: handle.fd, autoClose: false, highWaterMark: 65_536,
    fs: {
      read(_fd: number, buffer: Buffer, offset: number, length: number, position: number | null, callback: (error: Error | null, bytesRead: number, buffer: Buffer) => void) {
        pending = handle.read(buffer, offset, length, position).then(
          result => callback(null, result.bytesRead, result.buffer),
          (cause: unknown) => callback(recordFailure(cause), 0, buffer),
        );
      },
      close(_fd: number, callback: (error: Error | null) => void) { callback(null); },
    },
  });
  return { stream, settle: async () => { await pending; } };
}

function fileHandleWriteStream(handle: FileHandle, recordFailure: (cause: unknown) => Error): {
  readonly stream: Writable;
  readonly settle: () => Promise<void>;
} {
  let position = 0;
  let pending = Promise.resolve();
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const writeAll = async (): Promise<void> => {
        let offset = 0;
        while (offset < chunk.byteLength) {
          const result = await handle.write(chunk, offset, chunk.byteLength - offset, position + offset);
          if (result.bytesWritten <= 0) {
            throw new Error("Media import made no progress while writing its staged file.");
          }
          offset += result.bytesWritten;
        }
        position += chunk.byteLength;
      };
      pending = writeAll().then(() => callback(), (cause: unknown) => callback(recordFailure(cause)));
    },
  });
  return { stream, settle: async () => { await pending; } };
}

async function copyMedia(source: FileHandle, staged: FileHandle): Promise<CopyObservation> {
  const hash = createHash("sha256");
  let bytes = 0;
  const failures: NativeStreamFailure[] = [];
  const recordFailure = (cause: unknown): Error => {
    // Callback streams interpret falsey errors as success. Keep rejection
    // presence separately from the real Error used only as a stream signal.
    const signal = cause instanceof Error ? cause : new Error("Native media I/O failed.");
    failures.push({ cause, signal });
    return signal;
  };
  const reader = fileHandleReadStream(source, recordFailure);
  const writer = fileHandleWriteStream(staged, recordFailure);
  const result = await pipeline(
    reader.stream,
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength;
        if (bytes > MAX_MEDIA_BYTES) return callback(new Error("Media source exceeded its size bound while reading."));
        hash.update(chunk);
        callback(null, chunk);
      },
    }),
    writer.stream,
  ).then(() => ({ success: true as const }), (cause: unknown) => ({ success: false as const, cause }));
  // Destruction stops new stream admission, not already-issued native I/O.
  // Join both before the operation owner closes descriptors or removes staging.
  await Promise.all([reader.settle(), writer.settle()]);
  if (!result.success) {
    const selected = failures.find(failure => result.cause === failure.signal);
    return {
      success: false, cause: selected === undefined ? result.cause : selected.cause,
      prior: failures.filter(failure => failure !== selected),
    };
  }
  const [first, ...prior] = failures;
  if (first !== undefined) return { success: false, cause: first.cause, prior };
  return { success: true, bytes, sha256: hash.digest("hex") };
}

export function createMediaIngestPlatform(durability?: MediaIngestDurability): MediaIngestPlatformService {
  return {
    realpath: path => native(() => realpath(path)),
    sourcePath: path => operationValidation("media", () => resolve(path)),
    importsPath: root => operationValidation("media", () => join(root, "imports")),
    temporaryPath: (imports, name) => operationValidation("media", () => join(imports, name)),
    destinationPath: (imports, sha256) => operationValidation("media", () => join(imports, `${sha256}.media`)),
    assertWithin: (root, candidate, message) => operationValidation("media", () => {
      if (!isWithin(root, candidate)) throw new CliError("unsafe-path", message);
    }),
    assetLocation: (root, destination, source) => operationValidation("media", () => {
      const repositoryPath = relative(root, destination);
      if (!isWithin(root, destination) || isAbsolute(repositoryPath)) {
        throw new CliError("unsafe-path", "Imported media destination is outside the repository.");
      }
      return { path: RepositoryRelativePathSchema.parse(repositoryPath), label: basename(source) };
    }),
    lstat: path => native(() => lstat(path)),
    ensurePrivateDirectory: path => native(() => ensurePrivateDirectory(path)),
    mkdir: path => native(() => mkdir(path, { mode: 0o700 })),
    uniqueName: () => operationValidation("media", () => `.import-${randomUUID()}.tmp`),
    openSource: path => native(() => open(path, constants.O_RDONLY | constants.O_NOFOLLOW)),
    openTemporary: path => native(() => open(path, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600)),
    stat: handle => native(() => handle.stat()),
    close: handle => native(() => handle.close()),
    copy: (source, staged) => native(() => copyMedia(source, staged)).pipe(Effect.flatMap(result => result.success
      ? Effect.succeed({ bytes: result.bytes, sha256: result.sha256 })
      : Effect.fail({
          _tag: "OperationBoundaryFailure" as const,
          phase: "media" as const,
          cause: result.cause,
          ...(result.prior.length === 0 ? {} : { priorCause: result.prior.reduce<Cause.Cause<OperationEffectFailure>>(
            (prior, failure) => Cause.sequential(prior, Cause.fail({
              _tag: "OperationBoundaryFailure", phase: "media", cause: failure.cause,
            })), Cause.empty,
          ) }),
        }))),
    syncFile: (handle, path) => native(() => durability === undefined ? handle.sync() : durability.syncFile(handle, path)),
    syncDirectory: path => durability === undefined
      ? operationResource(
          native(() => open(path, constants.O_RDONLY | constants.O_NOFOLLOW)),
          directory => Effect.gen(function*() {
            const details = yield* native(() => directory.stat());
            yield* operationValidation("media", () => {
              if (!details.isDirectory()) throw new CliError("unsafe-path", `Media durability path is not a physical directory: ${path}`);
            });
            yield* native(() => directory.sync());
          }),
          directory => native(() => directory.close()),
        )
      : native(() => durability.syncDirectory(path)),
    remove: path => native(() => rm(path, { force: true })),
    link: (source, destination) => native(() => link(source, destination)),
    verify: (path, expected, label) => native(() => verifyPhysicalProjectMedia(path, expected, label)),
    probe: (ffprobe, runner, path) => native(() => runner.run([
      ffprobe,
      "-v", "error",
      ...SELF_CONTAINED_MEDIA_INPUT_ARGUMENTS,
      "-show_entries", "format=duration,format_name,start_time:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels,start_time,duration:stream_disposition=attached_pic,still_image,timed_thumbnails:stream_tags=duration",
      "-of", "json", path,
    ], { maxOutputBytes: MAX_PROBE_BYTES, timeoutMs: MAX_PROBE_TIMEOUT_MS })),
  };
}

export const MediaIngestPlatformLive = (durability?: MediaIngestDurability): Layer.Layer<MediaIngestPlatform> =>
  Layer.succeed(MediaIngestPlatform, createMediaIngestPlatform(durability));
