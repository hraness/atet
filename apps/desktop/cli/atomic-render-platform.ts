import { createHash, randomUUID } from "node:crypto";
import { constants, linkSync, lstatSync, renameSync, type Stats } from "node:fs";
import { link, lstat, open, realpath, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { Effect, Exit, Layer } from "effect";

import {
  operationBoundary,
  operationResource,
  operationValidation,
  type OperationEffectFailure,
} from "../application/operation-effects";
import {
  AtomicRenderPlatform,
  type AtomicRenderOutput,
  type AtomicRenderPlatformService,
  type AtomicRenderRequest,
  type AtomicRenderStaging,
} from "./atomic-render-effects";
import { CliError } from "./errors";

function missingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function stagePath(request: AtomicRenderRequest, companionPath?: string): Promise<AtomicRenderStaging> {
  if (request.argv.at(-1) !== request.finalOutputPath) {
    throw new CliError("internal", "Render invocation output does not match its requested final path.");
  }
  if (companionPath === request.finalOutputPath) {
    throw new CliError("internal", "Render output and companion paths must be distinct.");
  }
  if (!Number.isSafeInteger(request.maximumOutputBytes) || request.maximumOutputBytes < 1) {
    throw new CliError("invalid-data", "Render output byte limit must be a positive safe integer.");
  }
  const extension = extname(request.finalOutputPath) || ".media";
  let directory = dirname(request.finalOutputPath);
  if (request.stagingDirectory !== undefined) {
    const staging = await lstat(request.stagingDirectory);
    if (staging.isSymbolicLink() || !staging.isDirectory() || (staging.mode & 0o077) !== 0) {
      throw new CliError("unsafe-path", "Atomic render staging must be a private physical directory.");
    }
    directory = await realpath(request.stagingDirectory);
  }
  const path = join(directory, `.atet-render-${randomUUID()}.tmp${extension}`);
  const argv: [string, ...string[]] = [...request.argv];
  const overwriteIndex = argv.indexOf("-y");
  if (overwriteIndex < 0) {
    throw new CliError("internal", "Atomic render invocation must contain FFmpeg's overwrite flag.");
  }
  // FFmpeg must exclusively create the absent private path, never follow a prepositioned link.
  argv[overwriteIndex] = "-n";
  argv[argv.length - 1] = path;
  return { argv, path };
}

function syncDirectory(path: string): Effect.Effect<void, OperationEffectFailure> {
  return operationResource(
    operationBoundary("publication", () => open(path, constants.O_RDONLY)),
    directory => Effect.uninterruptible(operationBoundary("publication", () => directory.sync())),
    directory => operationBoundary("cleanup", () => directory.close()),
  );
}

async function hashOpenedOutput(
  handle: FileHandle,
  lexical: Awaited<ReturnType<typeof lstat>>,
): Promise<AtomicRenderOutput> {
  const opened = await handle.stat();
  if (!opened.isFile() || opened.dev !== lexical.dev || opened.ino !== lexical.ino
    || opened.size !== lexical.size || opened.nlink !== 1) {
    throw new CliError("conflict", "Render output changed before it could be committed.");
  }
  await handle.chmod(0o600);
  await handle.sync();
  const beforeHash = await handle.stat();
  if (beforeHash.size !== opened.size || beforeHash.dev !== opened.dev || beforeHash.ino !== opened.ino
    || beforeHash.nlink !== 1 || !Number.isSafeInteger(beforeHash.size)) {
    throw new CliError("conflict", "Render output changed while it was being committed.");
  }
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  while (bytes < beforeHash.size) {
    const read = await handle.read(buffer, 0, Math.min(buffer.byteLength, beforeHash.size - bytes), bytes);
    if (read.bytesRead === 0) break;
    hash.update(buffer.subarray(0, read.bytesRead));
    bytes += read.bytesRead;
  }
  const afterHash = await handle.stat();
  if (bytes !== beforeHash.size || afterHash.size !== beforeHash.size || afterHash.dev !== beforeHash.dev
    || afterHash.ino !== beforeHash.ino || afterHash.nlink !== 1 || afterHash.mtimeMs !== beforeHash.mtimeMs
    || afterHash.ctimeMs !== beforeHash.ctimeMs) {
    throw new CliError("conflict", "Render output changed while its integrity was being recorded.");
  }
  return { bytes, sha256: hash.digest("hex") };
}

export const nativeAtomicRenderPlatform: AtomicRenderPlatformService = {
  stage: (request, companionPath) => operationBoundary("workspace", () => stagePath(request, companionPath)),
  start: (staging, request) => operationValidation("media", () => {
    const controller = new AbortController();
    const signal = request.abortSignal;
    const forward = (): void => { controller.abort(signal?.reason); };
    signal?.addEventListener("abort", forward, { once: true });
    if (signal?.aborted === true) forward();
    try {
      // Observe immediately, including primitive rejections. No second evaluation dispatches work.
      const completion = request.runner.run(staging.argv, {
        abortSignal: controller.signal,
        maxOutputBytes: 1_000_000,
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      }).then(
        result => Exit.succeed(result),
        (cause: unknown) => Exit.fail<OperationEffectFailure>({
          _tag: "OperationBoundaryFailure", phase: "media", cause,
        }),
      );
      return {
        result: Effect.flatMap(Effect.promise(() => completion), exit => exit),
        abort: (reason?: unknown) => operationValidation("cleanup", () => controller.abort(reason)),
        detach: () => operationValidation("cleanup", () => signal?.removeEventListener("abort", forward)),
      };
    } catch (error) {
      signal?.removeEventListener("abort", forward);
      throw error;
    }
  }),
  outputSize: staging => operationBoundary("media", async () => {
    try { return (await lstat(staging.path)).size; }
    catch (error) { if (missingFile(error)) return null; throw error; }
  }),
  verify: (staging, request) => Effect.gen(function*() {
    const lexical = yield* operationBoundary("media", () => lstat(staging.path));
    yield* operationValidation("media", () => {
      if (lexical.isSymbolicLink() || !lexical.isFile() || lexical.size <= 0 || lexical.nlink !== 1) {
        throw new CliError("invalid-data", "Renderer produced an unsafe, empty, or multiply-linked output file.");
      }
      if (lexical.size > request.maximumOutputBytes) {
        throw new CliError("invalid-data", "Renderer output exceeds its configured byte limit.");
      }
    });
    return yield* operationResource(
      operationBoundary("media", () => open(staging.path, constants.O_RDWR | constants.O_NOFOLLOW)),
      // The foreign multi-step descriptor use must settle before close. A
      // cancelled Promise wait does not stop native stat/sync/read continuations.
      handle => Effect.uninterruptible(operationBoundary("media", () => hashOpenedOutput(handle, lexical))),
      handle => operationBoundary("cleanup", () => handle.close()),
    );
  }),
  publish: (staging, request) => Effect.gen(function*() {
    yield* operationBoundary("publication", async () => {
      if (request.beforeNativePublish !== undefined) {
        const before = lstatSync(staging.path, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(request.maximumOutputBytes)) throw new CliError("conflict", "Guarded render stage is unsafe.");
        const parents = new Map<string, Stats>();
        for (const path of [staging.path, request.finalOutputPath]) {
          for (let directory = dirname(path);; directory = dirname(directory)) {
            const snapshot = lstatSync(directory);
            if (!snapshot.isDirectory() || snapshot.isSymbolicLink()) throw new CliError("unsafe-path", "Guarded render publication parent is unsafe.");
            parents.set(directory, snapshot);
            if (dirname(directory) === directory) break;
          }
        }
        await request.beforeNativePublish(staging.path);
        for (const [path, previous] of parents) {
          const current = lstatSync(path);
          if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== previous.dev || current.ino !== previous.ino) throw new CliError("conflict", "Render publication parent changed during its final custody check.");
        }
        const after = lstatSync(staging.path, { bigint: true });
        if (!after.isFile() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
          || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || after.nlink !== 1n || after.mode !== before.mode) throw new CliError("conflict", "Render stage changed during its final custody check.");
        try {
          if (request.requireFreshOutput === true) linkSync(staging.path, request.finalOutputPath);
          else renameSync(staging.path, request.finalOutputPath);
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new CliError("conflict", `Render output was created concurrently: ${request.finalOutputPath}`);
          throw error;
        }
        if (request.requireFreshOutput === true) await rm(staging.path);
        return;
      }
      if (request.requireFreshOutput === true) {
        try { await link(staging.path, request.finalOutputPath); }
        catch (error) {
          if (error instanceof Error && "code" in error && error.code === "EEXIST") {
            throw new CliError("conflict", `Render output was created concurrently: ${request.finalOutputPath}`);
          }
          throw error;
        }
        await rm(staging.path);
      } else {
        await rename(staging.path, request.finalOutputPath);
      }
    });
    yield* syncDirectory(dirname(request.finalOutputPath));
  }),
  invalidateCompanion: path => Effect.gen(function*() {
    yield* operationBoundary("publication", () => rm(path, { force: true }));
    yield* syncDirectory(dirname(path));
  }),
  cleanup: staging => operationBoundary("cleanup", () => rm(staging.path, { force: true })),
};

export const AtomicRenderPlatformLive = Layer.succeed(AtomicRenderPlatform, nativeAtomicRenderPlatform);
