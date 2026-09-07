import { Effect, Exit, Option, Ref } from "effect";
import { ProjectAssetRoleSchema } from "../contracts";
import {
  operationFinally, operationResource, operationValidation, type OperationEffectFailure,
} from "../application/operation-effects";
import { CliError } from "./errors";
import type { ProcessRunner } from "./io";
import {
  MAX_MEDIA_BYTES, importedAsset, parseMediaProbe,
  type IngestedProjectMedia, type IngestProjectMediaOptions, type ProbedMedia, type StagedMediaImport,
} from "./media-ingest-model";
import { MediaIngestPlatform, type MediaIngestPlatformService } from "./media-ingest-platform";

type Program<A> = Effect.Effect<A, OperationEffectFailure, MediaIngestPlatform>;
type FileIdentity = StagedMediaImport["identity"];

function hasCode(failure: OperationEffectFailure, code: string): boolean {
  return failure.cause instanceof Error && "code" in failure.cause && failure.cause.code === code;
}

function privateImportsDirectory(projectDirectory: string): Program<string> {
  return Effect.gen(function*() {
    const platform = yield* MediaIngestPlatform;
    yield* platform.ensurePrivateDirectory(projectDirectory);
    const root = yield* platform.realpath(projectDirectory);
    const imports = yield* platform.importsPath(root);
    const created = yield* platform.lstat(imports).pipe(
      Effect.flatMap(details => operationValidation("media", () => {
        if (details.isSymbolicLink() || !details.isDirectory()) {
          throw new CliError("unsafe-path", `Project imports path is not a physical directory: ${imports}`);
        }
        return false;
      })),
      Effect.catchAll(failure => hasCode(failure, "ENOENT")
        ? Effect.as(platform.mkdir(imports), true)
        : Effect.fail(failure)),
    );
    const actual = yield* platform.realpath(imports);
    yield* platform.assertWithin(root, actual, "Project imports directory escaped its project.");
    if (created) yield* platform.syncDirectory(root);
    return actual;
  });
}

/** A substituted/ambiguous path is retained, never treated as owned cleanup. */
function removeStagedImport(
  platform: MediaIngestPlatformService,
  temporary: string,
  imports: string,
  identity: FileIdentity,
): Effect.Effect<void, OperationEffectFailure> {
  return Effect.uninterruptible(Effect.gen(function*() {
    const details = yield* platform.lstat(temporary).pipe(
      Effect.map(Option.some),
      Effect.catchAll(failure => hasCode(failure, "ENOENT") ? Effect.succeed(Option.none()) : Effect.fail(failure)),
    );
    if (Option.isSome(details)) {
      yield* operationValidation("cleanup", () => {
        if (!details.value.isFile() || details.value.isSymbolicLink()
          || details.value.dev !== identity.dev || details.value.ino !== identity.ino) {
          throw new CliError("conflict", "Staged media identity changed before cleanup; retaining the unowned entry.");
        }
      });
      yield* platform.remove(temporary);
    }
    yield* platform.syncDirectory(imports);
  }));
}

function stageImport(projectDirectory: string, sourcePath: string): Program<StagedMediaImport> {
  return Effect.gen(function*() {
    const platform = yield* MediaIngestPlatform;
    const source = yield* platform.sourcePath(sourcePath);
    const before = yield* platform.lstat(source).pipe(Effect.catchAll(() => operationValidation("media", () => {
      throw new CliError("not-found", `Media source does not exist: ${sourcePath}`);
    })));
    yield* operationValidation("media", () => {
      if (before.isSymbolicLink() || !before.isFile()) {
        throw new CliError("unsafe-path", `Media source must be a physical regular file: ${sourcePath}`);
      }
      if (before.size <= 0 || before.size > MAX_MEDIA_BYTES) {
        throw new CliError("invalid-data", `Media source must contain 1 through ${MAX_MEDIA_BYTES} bytes.`);
      }
    });
    const imports = yield* privateImportsDirectory(projectDirectory);
    const temporary = yield* platform.temporaryPath(imports, yield* platform.uniqueName());
    const owned = yield* Ref.make(Option.none<FileIdentity>());
    const staged = yield* Ref.make(Option.none<StagedMediaImport>());
    const removeOwned = Effect.gen(function*() {
      const identity = yield* Ref.get(owned);
      if (Option.isSome(identity)) yield* removeStagedImport(platform, temporary, imports, identity.value);
    });
    const result = yield* Effect.exit(operationResource(
      platform.openSource(source),
      sourceHandle => Effect.gen(function*() {
        const prepared = yield* Effect.exit(Effect.gen(function*() {
          const opened = yield* platform.stat(sourceHandle);
          yield* operationValidation("media", () => {
            if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
              throw new CliError("conflict", "Media source changed before it was imported.");
            }
          });
          const copied = yield* operationResource(
            platform.openTemporary(temporary),
            temporaryHandle => Effect.gen(function*() {
              const identity = yield* platform.stat(temporaryHandle);
              yield* operationValidation("media", () => {
                if (!identity.isFile()) throw new CliError("unsafe-path", "Staged media must be a physical regular file.");
              });
              yield* Ref.set(owned, Option.some({ dev: identity.dev, ino: identity.ino }));
              const copy = yield* platform.copy(sourceHandle, temporaryHandle);
              const after = yield* platform.stat(sourceHandle);
              yield* operationValidation("media", () => {
                if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
                  || copy.bytes !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
                  throw new CliError("conflict", "Media source changed while it was being imported.");
                }
              });
              // The original descriptor is still open: never reopen the staged path for fsync.
              yield* platform.syncFile(temporaryHandle, temporary);
              return { ...copy, identity: { dev: identity.dev, ino: identity.ino } };
            }),
            handle => platform.close(handle),
          );
          return {
            absolutePath: yield* platform.destinationPath(imports, copied.sha256),
            bytes: copied.bytes, sha256: copied.sha256, identity: copied.identity,
            temporaryPath: temporary, importsDirectory: imports,
          };
        }));
        if (Exit.isFailure(prepared)) return yield* operationFinally(prepared, removeOwned);
        yield* Ref.set(staged, Option.some(prepared.value));
        return prepared.value;
      }),
      handle => platform.close(handle),
    ));
    if (Exit.isFailure(result) && Option.isSome(yield* Ref.get(staged))) {
      // A source-close failure cannot strand an otherwise completed stage. Keep
      // that close failure public, even if compensating cleanup also fails.
      yield* operationFinally(removeOwned, result);
    }
    return yield* result;
  });
}

export function probeProjectMediaProgram(ffprobe: string, runner: ProcessRunner, path: string): Program<ProbedMedia> {
  return Effect.gen(function*() {
    const platform = yield* MediaIngestPlatform;
    const result = yield* platform.probe(ffprobe, runner, path);
    return yield* operationValidation("media", () => {
      if (result.exitCode !== 0) {
        throw new CliError("subprocess", `FFprobe could not inspect imported media: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
      }
      return parseMediaProbe(result.stdout);
    });
  });
}

function commitImport(imported: StagedMediaImport): Program<boolean> {
  return Effect.uninterruptible(Effect.gen(function*() {
    const platform = yield* MediaIngestPlatform;
    return yield* Effect.gen(function*() {
      yield* platform.link(imported.temporaryPath, imported.absolutePath);
      yield* platform.syncDirectory(imported.importsDirectory);
      return true;
    }).pipe(Effect.catchAll(failure => {
      if (!hasCode(failure, "EEXIST")) return Effect.fail(failure);
      return platform.verify(imported.absolutePath, imported, `Content-addressed media ${imported.sha256}`).pipe(
        Effect.catchAll(verificationFailure => verificationFailure.cause instanceof CliError && verificationFailure.cause.code === "unsafe-path"
          ? Effect.fail(verificationFailure)
          : operationValidation("media", () => { throw new CliError("conflict", `Content-addressed media collision for ${imported.sha256}.`); })),
        Effect.as(false),
      );
    }));
  }));
}

export function ingestProjectMediaProgram(options: IngestProjectMediaOptions): Program<IngestedProjectMedia> {
  return Effect.gen(function*() {
    const platform = yield* MediaIngestPlatform;
    const role = yield* operationValidation("media", () => ProjectAssetRoleSchema.parse(options.role));
    const [repositoryRoot, projectDirectory] = yield* Effect.all([
      platform.realpath(options.repositoryRoot), platform.realpath(options.projectDirectory),
    ], { concurrency: "unbounded" }).pipe(Effect.catchAll(() => operationValidation("media", () => {
      throw new CliError("not-found", "Project media import requires existing repository and project directories.");
    })));
    yield* platform.assertWithin(repositoryRoot, projectDirectory, "Project media import directory is outside the repository.");
    return yield* operationResource(
      stageImport(projectDirectory, options.sourcePath),
      imported => Effect.gen(function*() {
        const probe = yield* probeProjectMediaProgram(options.ffprobe, options.runner, imported.temporaryPath);
        const location = yield* platform.assetLocation(repositoryRoot, imported.absolutePath, options.sourcePath);
        const asset = yield* operationValidation("media", () => importedAsset(options, role, imported, probe, location.path, location.label));
        const created = yield* commitImport(imported);
        return { absolutePath: imported.absolutePath, asset, created };
      }),
      imported => removeStagedImport(platform, imported.temporaryPath, imported.importsDirectory, imported.identity),
    );
  });
}
