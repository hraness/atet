import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  AudioAlignmentAnalysisV1Schema,
  EditPlanV1Schema,
  FaceAnalysisV1Schema,
  MusicAnalysisV1Schema,
  ProjectInactivityAnalysisV1Schema,
  ProjectEditPlanV1Schema,
  RecordingManifestV1Schema,
  RepositoryRelativePathSchema,
  SceneAnalysisV1Schema,
  Sha256Schema,
  SpeechAnalysisV1Schema,
  VideoProjectV1Schema,
  type AudioAlignmentAnalysisV1,
  type EditPlanV1,
  type FaceAnalysisV1,
  type MusicAnalysisV1,
  type ProjectInactivityAnalysisV1,
  type ProjectEditPlanV1,
  type RecordingManifestV1,
  type SceneAnalysisV1,
  type SpeechAnalysisV1,
  type VideoProjectV1,
} from "../contracts";
import { canonicalJson, sha256Hex } from "./canonical-json";

export const RECORDING_MANIFEST_PATH = "manifest.json";
export const VIDEO_PROJECT_PATH = "project.json";
export const CURRENT_PROJECT_EDIT_PLAN_PATH = "edits/current.json";
const MAXIMUM_STRUCTURED_FILE_BYTES = 256 * 1024 * 1024;
const IMMUTABLE_COPY_TEMP_PREFIX = ".transmute-copy-";

export interface BundleFileSystem {
  /**
   * Inspect a physical regular file without following a leaf symlink.
   * Implementations may omit binary support when they are used only for
   * structured in-memory tests.
   */
  inspectFile?(path: string): Promise<BundleFileIntegrity>;
  readText(path: string): Promise<string>;
  writeTextAtomic(path: string, contents: string): Promise<void>;
  /**
   * Install a new physical file without replacing an existing path.
   *
   * This is optional because lightweight read/write adapters do not need to
   * support immutable publication. Callers that publish content-addressed
   * artifacts must require it explicitly.
   */
  writeTextNoReplace?(
    path: string,
    contents: string,
  ): Promise<"created" | "exists">;
  /**
   * Copy one exact bundle file using atomic no-replace publication. The final
   * path remains absent until the complete bytes are durable. Existing
   * identical bytes are accepted for deterministic recovery; different bytes
   * always fail.
   */
  copyFileNoReplace?(
    sourcePath: string,
    destinationPath: string,
    expected: BundleFileIntegrity,
  ): Promise<"created" | "exists">;
}

export interface BundleFileIntegrity {
  readonly bytes: number;
  readonly sha256: string;
}

/** Publish canonical immutable text and verify the physical winner. */
export async function saveImmutableText(
  fileSystem: BundleFileSystem,
  path: string,
  contents: string,
  expectedSha256: string,
): Promise<"created" | "exists"> {
  RepositoryRelativePathSchema.parse(path);
  const sha256 = Sha256Schema.parse(expectedSha256);
  if (sha256Hex(contents) !== sha256) {
    throw new Error(`Immutable text hash mismatch for ${path}.`);
  }
  if (fileSystem.writeTextNoReplace === undefined) {
    throw new Error("Bundle file system does not support immutable no-replace publication.");
  }
  const disposition = await fileSystem.writeTextNoReplace(path, contents);
  const published = await fileSystem.readText(path);
  if (published !== contents || sha256Hex(published) !== sha256) {
    throw new Error(
      disposition === "exists"
        ? `Immutable path already contains different bytes: ${path}`
        : `Immutable publication failed read-back verification: ${path}`,
    );
  }
  return disposition;
}

export function editPlanPath(planId: string): string {
  return RepositoryRelativePathSchema.parse(`edits/${planId}.json`);
}

export function projectEditRevisionPath(artifactSha256: string): string {
  const sha256 = Sha256Schema.parse(artifactSha256);
  return RepositoryRelativePathSchema.parse(`edits/revisions/${sha256}.json`);
}

export async function loadRecordingManifest(
  fileSystem: BundleFileSystem,
  path = RECORDING_MANIFEST_PATH,
): Promise<RecordingManifestV1> {
  RepositoryRelativePathSchema.parse(path);
  const input: unknown = JSON.parse(await fileSystem.readText(path));
  return RecordingManifestV1Schema.parse(input);
}

export async function saveRecordingManifest(
  fileSystem: BundleFileSystem,
  manifest: RecordingManifestV1,
  path = RECORDING_MANIFEST_PATH,
): Promise<void> {
  RepositoryRelativePathSchema.parse(path);
  const parsed = RecordingManifestV1Schema.parse(manifest);
  await fileSystem.writeTextAtomic(path, `${canonicalJson(parsed)}\n`);
}

export async function loadEditPlan(fileSystem: BundleFileSystem, path: string): Promise<EditPlanV1> {
  RepositoryRelativePathSchema.parse(path);
  const input: unknown = JSON.parse(await fileSystem.readText(path));
  return EditPlanV1Schema.parse(input);
}

export async function saveEditPlan(
  fileSystem: BundleFileSystem,
  plan: EditPlanV1,
  path = editPlanPath(plan.planId),
): Promise<void> {
  RepositoryRelativePathSchema.parse(path);
  const parsed = EditPlanV1Schema.parse(plan);
  await fileSystem.writeTextAtomic(path, `${canonicalJson(parsed)}\n`);
}

export async function loadVideoProject(
  fileSystem: BundleFileSystem,
  path = VIDEO_PROJECT_PATH,
): Promise<VideoProjectV1> {
  RepositoryRelativePathSchema.parse(path);
  const input: unknown = JSON.parse(await fileSystem.readText(path));
  return VideoProjectV1Schema.parse(input);
}

export async function saveVideoProject(
  fileSystem: BundleFileSystem,
  project: VideoProjectV1,
  path = VIDEO_PROJECT_PATH,
): Promise<void> {
  RepositoryRelativePathSchema.parse(path);
  const parsed = VideoProjectV1Schema.parse(project);
  await fileSystem.writeTextAtomic(path, `${canonicalJson(parsed)}\n`);
}

export async function loadProjectEditPlan(
  fileSystem: BundleFileSystem,
  path = CURRENT_PROJECT_EDIT_PLAN_PATH,
): Promise<ProjectEditPlanV1> {
  RepositoryRelativePathSchema.parse(path);
  const input: unknown = JSON.parse(await fileSystem.readText(path));
  return ProjectEditPlanV1Schema.parse(input);
}

export async function saveProjectEditPlan(
  fileSystem: BundleFileSystem,
  plan: ProjectEditPlanV1,
  path = CURRENT_PROJECT_EDIT_PLAN_PATH,
): Promise<void> {
  RepositoryRelativePathSchema.parse(path);
  const parsed = ProjectEditPlanV1Schema.parse(plan);
  await fileSystem.writeTextAtomic(path, `${canonicalJson(parsed)}\n`);
}

/**
 * Publish canonical revision bytes exactly once under their physical hash.
 *
 * A retry is accepted only when the already-published bytes are identical.
 * The mutable current-plan pointer is intentionally outside this operation.
 */
export async function saveProjectEditRevision(
  fileSystem: BundleFileSystem,
  contents: string,
  expectedArtifactSha256: string,
): Promise<string> {
  const sha256 = Sha256Schema.parse(expectedArtifactSha256);
  const actualSha256 = sha256Hex(contents);
  if (actualSha256 !== sha256) {
    throw new Error(
      `Project edit revision artifact hash mismatch: expected ${sha256}, received ${actualSha256}.`,
    );
  }
  if (fileSystem.writeTextNoReplace === undefined) {
    throw new Error("Bundle file system does not support immutable no-replace publication.");
  }
  const path = projectEditRevisionPath(sha256);
  const disposition = await fileSystem.writeTextNoReplace(path, contents);
  const installed = await fileSystem.readText(path);
  if (installed !== contents) {
    throw new Error(
      disposition === "exists"
        ? `Project edit revision path already contains different bytes: ${path}`
        : `Published project edit revision failed read-back verification: ${path}`,
    );
  }
  return path;
}

type AnalysisArtifact =
  | AudioAlignmentAnalysisV1
  | FaceAnalysisV1
  | ProjectInactivityAnalysisV1
  | MusicAnalysisV1
  | SceneAnalysisV1
  | SpeechAnalysisV1;

export async function loadAnalysisArtifact(
  fileSystem: BundleFileSystem,
  path: string,
): Promise<AnalysisArtifact> {
  RepositoryRelativePathSchema.parse(path);
  const input: unknown = JSON.parse(await fileSystem.readText(path));
  for (const schema of [
    AudioAlignmentAnalysisV1Schema,
    FaceAnalysisV1Schema,
    ProjectInactivityAnalysisV1Schema,
    MusicAnalysisV1Schema,
    SceneAnalysisV1Schema,
    SpeechAnalysisV1Schema,
  ] as const) {
    const parsed = schema.safeParse(input);
    if (parsed.success) return parsed.data;
  }
  throw new Error(`Analysis artifact does not match a supported schema: ${path}`);
}

export async function saveAnalysisArtifact(
  fileSystem: BundleFileSystem,
  artifact: AnalysisArtifact,
  path: string,
): Promise<void> {
  RepositoryRelativePathSchema.parse(path);
  const schemas = [
    AudioAlignmentAnalysisV1Schema,
    FaceAnalysisV1Schema,
    ProjectInactivityAnalysisV1Schema,
    MusicAnalysisV1Schema,
    SceneAnalysisV1Schema,
    SpeechAnalysisV1Schema,
  ] as const;
  const parsed = schemas.map(schema => schema.safeParse(artifact)).find(result => result.success);
  if (parsed === undefined || !parsed.success) {
    throw new Error("Analysis artifact does not match a supported schema.");
  }
  await fileSystem.writeTextAtomic(path, `${canonicalJson(parsed.data)}\n`);
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}

export function createNodeBundleFileSystem(
  bundleRoot: string,
  options: Readonly<{
    readonly duringFileInspectionForTesting?: (input: Readonly<{
      readonly attempt: 1 | 2;
      readonly path: string;
    }>) => Promise<void>;
  }> = {},
): BundleFileSystem {
  const lexicalRoot = resolve(bundleRoot);

  async function physicalRoot(): Promise<string> {
    await mkdir(lexicalRoot, { mode: 0o700, recursive: true });
    const details = await lstat(lexicalRoot);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new Error(`Bundle root must be a physical directory: ${lexicalRoot}`);
    }
    return await realpath(lexicalRoot);
  }

  async function safePath(path: string, createParent: boolean): Promise<string> {
    const relativePath = RepositoryRelativePathSchema.parse(path);
    const root = await physicalRoot();
    const candidate = resolve(root, relativePath);
    if (!isWithin(root, candidate)) throw new Error(`Bundle path escapes its root: ${path}`);
    const parentRelative = relative(root, dirname(candidate));
    const parentParts = parentRelative === "" ? [] : parentRelative.split(sep);
    let physicalParent = root;
    for (const part of parentParts) {
      const next = join(physicalParent, part);
      try {
        const details = await lstat(next);
        if (details.isSymbolicLink() || !details.isDirectory()) {
          throw new Error(`Bundle path requires physical directories: ${path}`);
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        if (!createParent) throw error;
        try {
          await mkdir(next, { mode: 0o700 });
        } catch (mkdirError) {
          // Concurrent immutable publishers may create the same private
          // parent. Verify the winner below instead of treating that race as
          // a publication failure.
          if (!(
            mkdirError instanceof Error
            && "code" in mkdirError
            && mkdirError.code === "EEXIST"
          )) {
            throw mkdirError;
          }
        }
        const created = await lstat(next);
        if (created.isSymbolicLink() || !created.isDirectory()) {
          throw new Error(`Bundle directory creation was redirected: ${path}`);
        }
      }
      physicalParent = next;
    }
    return join(physicalParent, basename(candidate));
  }

  async function readPhysicalText(path: string): Promise<string> {
    const target = await safePath(path, false);
    const lexical = await lstat(target);
    if (
      lexical.isSymbolicLink()
      || !lexical.isFile()
      || lexical.size > MAXIMUM_STRUCTURED_FILE_BYTES
    ) {
      throw new Error(`Bundle file must be a bounded physical regular file: ${path}`);
    }
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (
        !before.isFile()
        || before.dev !== lexical.dev
        || before.ino !== lexical.ino
        || before.size !== lexical.size
      ) {
        throw new Error(`Bundle file changed before it was read: ${path}`);
      }
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (
        bytes.byteLength !== before.size
        || after.dev !== before.dev
        || after.ino !== before.ino
        || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs
        || after.ctimeMs !== before.ctimeMs
      ) {
        throw new Error(`Bundle file changed while it was read: ${path}`);
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } finally {
      await handle.close();
    }
  }

  async function inspectPhysicalFile(path: string): Promise<BundleFileIntegrity> {
    const target = await safePath(path, false);
    const lexical = await lstat(target);
    if (lexical.isSymbolicLink() || !lexical.isFile()) {
      throw new Error(`Bundle file must be a physical regular file: ${path}`);
    }
    async function assertTargetStillNamesOpenedFile(
      expected: Readonly<{ readonly dev: number; readonly ino: number }>,
    ): Promise<void> {
      const current = await lstat(target).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          return null;
        }
        throw error;
      });
      if (
        current === null
        || current.isSymbolicLink()
        || !current.isFile()
        || current.dev !== expected.dev
        || current.ino !== expected.ino
      ) {
        throw new Error(`Bundle file changed while it was inspected: ${path}`);
      }
    }
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const buffer = Buffer.allocUnsafe(256 * 1024);
      for (const attempt of [1, 2] as const) {
        const before = await handle.stat();
        if (
          !before.isFile()
          || before.dev !== lexical.dev
          || before.ino !== lexical.ino
          || before.size !== lexical.size
        ) {
          throw new Error(`Bundle file changed before it was inspected: ${path}`);
        }
        const digest = createHash("sha256");
        let bytes = 0;
        while (true) {
          // Positional reads keep both bounded attempts pinned to byte zero on
          // the same already-verified inode.
          const result = await handle.read(
            buffer,
            0,
            buffer.byteLength,
            bytes,
          );
          if (result.bytesRead === 0) break;
          digest.update(buffer.subarray(0, result.bytesRead));
          bytes += result.bytesRead;
          if (!Number.isSafeInteger(bytes)) {
            throw new Error(`Bundle file exceeds safe byte accounting: ${path}`);
          }
        }
        await options.duringFileInspectionForTesting?.({ attempt, path });
        const after = await handle.stat();
        // Reading may update atime. Every other content, identity, ownership,
        // allocation, and creation field must remain fixed.
        const nonLinkSnapshotStayedStable = (
          bytes === before.size
          && after.isFile()
          && after.dev === before.dev
          && after.ino === before.ino
          && after.mode === before.mode
          && after.uid === before.uid
          && after.gid === before.gid
          && after.rdev === before.rdev
          && after.size === before.size
          && after.blksize === before.blksize
          && after.blocks === before.blocks
          && after.mtimeMs === before.mtimeMs
          && after.birthtimeMs === before.birthtimeMs
        );
        if (
          nonLinkSnapshotStayedStable
          && after.nlink === before.nlink
          && after.ctimeMs === before.ctimeMs
        ) {
          await assertTargetStillNamesOpenedFile(after);
          return {
            bytes,
            sha256: Sha256Schema.parse(digest.digest("hex")),
          };
        }
        const stagingLinkWasCleaned = (
          attempt === 1
          && nonLinkSnapshotStayedStable
          && after.ctimeMs !== before.ctimeMs
          && before.nlink >= 2
          && after.nlink === before.nlink - 1
        );
        if (!stagingLinkWasCleaned) {
          throw new Error(`Bundle file changed while it was inspected: ${path}`);
        }
        await assertTargetStillNamesOpenedFile(after);
      }
      throw new Error(`Bundle file changed while it was inspected: ${path}`);
    } finally {
      await handle.close();
    }
  }

  return {
    inspectFile: inspectPhysicalFile,
    readText: readPhysicalText,
    async writeTextAtomic(path, contents) {
      const target = await safePath(path, true);
      const temporary = `${target}.tmp-${randomUUID()}`;
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(contents, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
      const directoryHandle = await open(dirname(target), "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    },
    async writeTextNoReplace(path, contents) {
      const target = await safePath(path, true);
      const temporary = `${target}.tmp-${randomUUID()}`;
      const handle = await open(temporary, "wx", 0o600);
      let disposition: "created" | "exists" | undefined;
      let cleanupError: Error | undefined;
      try {
        try {
          await handle.writeFile(contents, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await link(temporary, target);
          disposition = "created";
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
            throw error;
          }
          disposition = "exists";
        }
      } finally {
        try {
          await unlink(temporary);
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            cleanupError = error instanceof Error
              ? error
              : new Error(String(error));
          }
        }
      }
      if (cleanupError !== undefined) throw cleanupError;
      if (disposition === undefined) {
        throw new Error(`Immutable publication did not resolve a disposition: ${path}`);
      }
      if (disposition === "created") {
        const directoryHandle = await open(dirname(target), "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      }
      return disposition;
    },
    async copyFileNoReplace(sourcePath, destinationPath, expectedInput) {
      const expected = {
        bytes: zSafeBytes(expectedInput.bytes),
        sha256: Sha256Schema.parse(expectedInput.sha256),
      };
      if (sourcePath === destinationPath) {
        throw new Error("Immutable bundle copy requires a distinct destination path.");
      }
      const source = await safePath(sourcePath, false);
      const destination = await safePath(destinationPath, true);
      const lexicalSource = await lstat(source);
      if (lexicalSource.isSymbolicLink() || !lexicalSource.isFile()) {
        throw new Error(`Immutable bundle copy source is not a physical file: ${sourcePath}`);
      }
      const sourceHandle = await open(
        source,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const temporary = join(
        dirname(destination),
        `${IMMUTABLE_COPY_TEMP_PREFIX}${randomUUID()}.tmp`,
      );
      let temporaryHandle: FileHandle | undefined;
      let ownsTemporary = false;
      let createdIdentity:
        | { readonly dev: number; readonly ino: number }
        | undefined;
      try {
        const sourceBefore = await sourceHandle.stat();
        if (
          !sourceBefore.isFile()
          || sourceBefore.dev !== lexicalSource.dev
          || sourceBefore.ino !== lexicalSource.ino
          || sourceBefore.size !== lexicalSource.size
        ) {
          throw new Error(`Immutable bundle copy source changed before opening: ${sourcePath}`);
        }
        try {
          const destinationIntegrity = await inspectPhysicalFile(destinationPath);
          if (
            destinationIntegrity.bytes !== expected.bytes
            || destinationIntegrity.sha256 !== expected.sha256
          ) {
            throw new Error(
              `Immutable bundle copy destination contains different bytes: ${destinationPath}`,
            );
          }
          return "exists";
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error;
          }
        }

        // A killed copier may leave this private stage behind, but can never
        // expose partial bytes under the immutable destination name.
        temporaryHandle = await open(
          temporary,
          constants.O_CREAT
            | constants.O_EXCL
            | constants.O_WRONLY
            | constants.O_NOFOLLOW,
          0o600,
        );
        ownsTemporary = true;
        const temporaryBefore = await temporaryHandle.stat();
        const digest = createHash("sha256");
        const buffer = Buffer.allocUnsafe(256 * 1024);
        let bytes = 0;
        while (true) {
          const result = await sourceHandle.read(
            buffer,
            0,
            buffer.byteLength,
            null,
          );
          if (result.bytesRead === 0) break;
          digest.update(buffer.subarray(0, result.bytesRead));
          let written = 0;
          while (written < result.bytesRead) {
            const write = await temporaryHandle.write(
              buffer,
              written,
              result.bytesRead - written,
              null,
            );
            if (write.bytesWritten < 1) {
              throw new Error("Immutable bundle copy made no write progress.");
            }
            written += write.bytesWritten;
          }
          bytes += result.bytesRead;
          if (!Number.isSafeInteger(bytes)) {
            throw new Error(`Bundle file exceeds safe byte accounting: ${sourcePath}`);
          }
        }
        const [sourceAfter, temporaryAfter] = await Promise.all([
          sourceHandle.stat(),
          temporaryHandle.stat(),
        ]);
        const copiedSha256 = Sha256Schema.parse(digest.digest("hex"));
        if (
          bytes !== expected.bytes
          || copiedSha256 !== expected.sha256
          || sourceAfter.dev !== sourceBefore.dev
          || sourceAfter.ino !== sourceBefore.ino
          || sourceAfter.size !== sourceBefore.size
          || sourceAfter.mtimeMs !== sourceBefore.mtimeMs
          || sourceAfter.ctimeMs !== sourceBefore.ctimeMs
          || temporaryAfter.dev !== temporaryBefore.dev
          || temporaryAfter.ino !== temporaryBefore.ino
          || temporaryAfter.size !== bytes
        ) {
          throw new Error(`Immutable bundle copy source changed or failed verification: ${sourcePath}`);
        }
        await temporaryHandle.sync();
        await temporaryHandle.close();
        temporaryHandle = undefined;
        const staged = await lstat(temporary);
        if (
          staged.isSymbolicLink()
          || !staged.isFile()
          || staged.dev !== temporaryAfter.dev
          || staged.ino !== temporaryAfter.ino
          || staged.size !== temporaryAfter.size
        ) {
          throw new Error(`Immutable bundle copy staging path changed: ${destinationPath}`);
        }

        let disposition: "created" | "exists";
        try {
          await link(temporary, destination);
          createdIdentity = {
            dev: temporaryAfter.dev,
            ino: temporaryAfter.ino,
          };
          disposition = "created";
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
            throw error;
          }
          disposition = "exists";
        }
        const destinationIntegrity = await inspectPhysicalFile(destinationPath);
        if (
          destinationIntegrity.bytes !== expected.bytes
          || destinationIntegrity.sha256 !== expected.sha256
        ) {
          throw new Error(
            disposition === "exists"
              ? `Immutable bundle copy destination contains different bytes: ${destinationPath}`
              : `Immutable bundle copy failed read-back verification: ${destinationPath}`,
          );
        }
        if (disposition === "created") {
          await syncParentDirectory(destination);
        }
        return disposition;
      } catch (error) {
        if (createdIdentity !== undefined) {
          const current = await lstat(destination).catch((lstatError: unknown) => {
            if (
              lstatError instanceof Error
              && "code" in lstatError
              && lstatError.code === "ENOENT"
            ) return null;
            throw lstatError;
          });
          if (
            current !== null
            && !current.isSymbolicLink()
            && current.isFile()
            && current.dev === createdIdentity.dev
            && current.ino === createdIdentity.ino
          ) {
            await unlink(destination);
            await syncParentDirectory(destination);
          }
        }
        throw error;
      } finally {
        if (temporaryHandle !== undefined) {
          await temporaryHandle.close().catch(() => undefined);
        }
        if (ownsTemporary) {
          await unlink(temporary).catch((error: unknown) => {
            if (
              error instanceof Error
              && "code" in error
              && error.code === "ENOENT"
            ) return;
            throw error;
          });
        }
        await sourceHandle.close();
      }
    },
  };
}

function zSafeBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("File byte count must be a nonnegative safe integer.");
  }
  return value;
}

async function syncParentDirectory(path: string): Promise<void> {
  const handle = await open(dirname(path), "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
