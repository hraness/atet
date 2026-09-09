import { createHash, randomUUID } from "node:crypto";
import { constants, fstatSync, linkSync, lstatSync, readSync, renameSync, type BigIntStats, type Stats } from "node:fs";
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
const IMMUTABLE_COPY_TEMP_PREFIX = ".atet-copy-";

export interface BundleFileSystem {
  /**
   * Inspect a physical regular file without following a leaf symlink.
   * Implementations may omit binary support when they are used only for
   * structured in-memory tests.
   */
  inspectFile?(path: string, maximumBytes?: number): Promise<BundleFileIntegrity>;
  readText(path: string, maximumBytes?: number): Promise<string>;
  writeTextAtomic(path: string, contents: string): Promise<void>;
  /** Revalidate caller custody after staging and immediately before rename dispatch. */
  writeTextAtomicGuarded?(path: string, contents: string, beforeReplace: () => Promise<void>): Promise<void>;
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
    beforePublication?: () => Promise<void>,
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
    beforePublication?: () => Promise<void>,
  ): Promise<"created" | "exists">;
}

export interface BundleFileIntegrity {
  readonly bytes: number;
  readonly sha256: string;
}

export type AtetPersistenceDocument =
  | AnalysisArtifact
  | EditPlanV1
  | ProjectEditPlanV1
  | RecordingManifestV1
  | VideoProjectV1;

/**
 * Project a parsed mutable persistence document to the exact identity that a
 * current Atet writer will put on disk. Callers that authenticate immutable
 * predecessor bytes must do that before invoking this projection.
 */
export function canonicalAtetPersistenceDocument<
  Value extends AtetPersistenceDocument,
>(value: Value): Value {
  const kind = value.kind.replace(/^studio\./u, "atet.");
  if ("tool" in value && value.kind.endsWith(".recording-bundle")) {
    if (kind === value.kind && value.tool.name === "atet") return value;
    return {
      ...value,
      kind,
      tool: { ...value.tool, name: "atet" },
    } as Value;
  }
  return kind === value.kind ? value : { ...value, kind } as Value;
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
  const parsed = RecordingManifestV1Schema.parse(canonicalAtetPersistenceDocument(
    RecordingManifestV1Schema.parse(manifest),
  ));
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
  const parsed = EditPlanV1Schema.parse(canonicalAtetPersistenceDocument(
    EditPlanV1Schema.parse(plan),
  ));
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
  const parsed = VideoProjectV1Schema.parse(canonicalAtetPersistenceDocument(
    VideoProjectV1Schema.parse(project),
  ));
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
  const parsed = ProjectEditPlanV1Schema.parse(canonicalAtetPersistenceDocument(
    ProjectEditPlanV1Schema.parse(plan),
  ));
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

export type AnalysisArtifact =
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
    if (parsed.success) return parsed.data as AnalysisArtifact;
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
  await fileSystem.writeTextAtomic(
    path,
    `${canonicalJson(canonicalAtetPersistenceDocument(parsed.data))}\n`,
  );
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

  async function readPhysicalText(path: string, maximumBytes = MAXIMUM_STRUCTURED_FILE_BYTES): Promise<string> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > MAXIMUM_STRUCTURED_FILE_BYTES) throw new RangeError("Invalid structured file byte limit.");
    const target = await safePath(path, false);
    const lexical = await lstat(target);
    if (
      lexical.isSymbolicLink()
      || !lexical.isFile()
      || lexical.size > maximumBytes
    ) {
      throw new Error(`Bundle file must be a bounded physical regular file: ${path}`);
    }
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
      // Read at most the admitted size plus one byte. A concurrent append must
      // not turn readFile into an unbounded allocation before the final stat.
      const buffer = Buffer.alloc(before.size + 1);
      let count = 0;
      while (count < buffer.byteLength) {
        const result = await handle.read(buffer, count, Math.min(256 * 1024, buffer.byteLength - count), count);
        if (result.bytesRead === 0) break;
        count += result.bytesRead;
      }
      const bytes = buffer.subarray(0, count);
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

  async function inspectPhysicalFile(path: string, maximumBytes = Number.MAX_SAFE_INTEGER): Promise<BundleFileIntegrity> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new RangeError("Invalid physical file byte limit.");
    const target = await safePath(path, false);
    const lexical = await lstat(target);
    if (lexical.isSymbolicLink() || !lexical.isFile() || lexical.size > maximumBytes) {
      throw new Error(`Bundle file must be a physical regular file: ${path}`);
    }
    const sameNonLinkSnapshot = (before: Stats, after: Stats): boolean => (
      after.isFile()
      && after.dev === before.dev && after.ino === before.ino
      && after.mode === before.mode && after.uid === before.uid && after.gid === before.gid
      && after.rdev === before.rdev && after.size === before.size
      && after.blksize === before.blksize && after.blocks === before.blocks
      && after.mtimeMs === before.mtimeMs && after.birthtimeMs === before.birthtimeMs
    );
    async function assertTargetStillNamesOpenedFile(
      expected: Stats,
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
        || !sameNonLinkSnapshot(expected, current)
        || current.nlink !== expected.nlink
        || current.ctimeMs !== expected.ctimeMs
      ) {
        throw new Error(`Bundle file changed while it was inspected: ${path}`);
      }
    }
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const buffer = Buffer.allocUnsafe(256 * 1024);
      let retrySnapshot: Stats | undefined;
      let retryDigest: string | undefined;
      for (const attempt of [1, 2] as const) {
        const before = await handle.stat();
        if (
          !before.isFile()
          || before.dev !== lexical.dev
          || before.ino !== lexical.ino
          || before.size !== lexical.size
          || (retrySnapshot !== undefined && (
            !sameNonLinkSnapshot(retrySnapshot, before)
            || before.nlink !== retrySnapshot.nlink
            || before.ctimeMs !== retrySnapshot.ctimeMs
          ))
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
            Math.min(buffer.byteLength, maximumBytes - bytes + 1),
            bytes,
          );
          if (result.bytesRead === 0) break;
          digest.update(buffer.subarray(0, result.bytesRead));
          bytes += result.bytesRead;
          if (!Number.isSafeInteger(bytes) || bytes > maximumBytes) {
            throw new Error(`Bundle file exceeds safe byte accounting: ${path}`);
          }
        }
        await options.duringFileInspectionForTesting?.({ attempt, path });
        const after = await handle.stat();
        // Reading may update atime. A ctime transition invalidates this read;
        // one fresh, stable pass must independently reproduce its exact bytes.
        const nonLinkSnapshotStayedStable = bytes === before.size && sameNonLinkSnapshot(before, after);
        const sha256 = digest.digest("hex");
        if (retryDigest !== undefined && retryDigest !== sha256) {
          throw new Error(`Bundle file changed while it was inspected: ${path}`);
        }
        if (
          nonLinkSnapshotStayedStable
          && after.nlink === before.nlink
          && after.ctimeMs === before.ctimeMs
        ) {
          await assertTargetStillNamesOpenedFile(after);
          return {
            bytes,
            sha256: Sha256Schema.parse(sha256),
          };
        }
        const metadataRequiresFreshRead = (
          attempt === 1
          && nonLinkSnapshotStayedStable
          && after.ctimeMs !== before.ctimeMs
          && (after.nlink === before.nlink || (before.nlink >= 2 && after.nlink === before.nlink - 1))
        );
        if (!metadataRequiresFreshRead) {
          throw new Error(`Bundle file changed while it was inspected: ${path}`);
        }
        await assertTargetStillNamesOpenedFile(after);
        retrySnapshot = after;
        retryDigest = sha256;
      }
      throw new Error(`Bundle file changed while it was inspected: ${path}`);
    } finally {
      await handle.close();
    }
  }

  async function immutableLink(temporary: string, target: string): Promise<"created" | "exists"> {
    try { await link(temporary, target); return "created"; }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") return "exists";
      throw error;
    }
  }

  async function guardedImmutableLink(temporary: string, target: string, expected: BundleFileIntegrity, beforePublication: () => Promise<void>): Promise<"created" | "exists"> {
    const handle = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let staged: BigIntStats;
    try {
      staged = fstatSync(handle.fd, { bigint: true });
      if (!staged.isFile() || staged.size !== BigInt(expected.bytes) || staged.nlink !== 1n || (staged.mode & 0o777n) !== 0o600n) throw new Error("Immutable stage is not a private exact-sized regular file.");
      const digest = createHash("sha256"), buffer = Buffer.allocUnsafe(256 * 1024);
      let bytes = 0;
      while (bytes < expected.bytes) {
        const count = readSync(handle.fd, buffer, 0, Math.min(buffer.length, expected.bytes - bytes), bytes);
        if (count === 0) throw new Error("Immutable stage ended during verification.");
        digest.update(buffer.subarray(0, count)); bytes += count;
      }
      const after = fstatSync(handle.fd, { bigint: true });
      if (digest.digest("hex") !== expected.sha256 || after.size !== staged.size || after.mtimeNs !== staged.mtimeNs || after.ctimeNs !== staged.ctimeNs) throw new Error("Immutable stage changed during verification.");
    } finally { await handle.close(); }
    const parents = [];
    for (let directory = dirname(target);; directory = dirname(directory)) {
      const snapshot = lstatSync(directory, { bigint: true });
      if (!snapshot.isDirectory() || snapshot.isSymbolicLink()) throw new Error("Immutable publication parent is unsafe.");
      parents.push({ directory, snapshot });
      if (dirname(directory) === directory) break;
    }
    await beforePublication();
    for (const item of parents) {
      const current = lstatSync(item.directory, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== item.snapshot.dev || current.ino !== item.snapshot.ino) throw new Error("Immutable publication parent changed during custody check.");
    }
    const current = lstatSync(temporary, { bigint: true });
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== staged.dev || current.ino !== staged.ino || current.size !== staged.size
      || current.mtimeNs !== staged.mtimeNs || current.ctimeNs !== staged.ctimeNs || current.nlink !== 1n || current.mode !== staged.mode) throw new Error("Immutable stage changed during custody check.");
    // Complete physical revalidation and no-replace dispatch share one synchronous turn.
    try { linkSync(temporary, target); return "created"; }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") return "exists";
      throw error;
    }
  }

  return {
    inspectFile: inspectPhysicalFile,
    readText: readPhysicalText,
    async writeTextAtomicGuarded(path, contents, beforeReplace) {
      const target = await safePath(path, true);
      const parent = await lstat(dirname(target));
      const temporary = `${target}.tmp-${randomUUID()}`;
      const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
      let identity: Stats | undefined;
      let stagedSnapshot: BigIntStats;
      try {
        try {
          identity = await handle.stat();
          await handle.writeFile(contents, "utf8"); await handle.sync();
          const expectedBytes = Buffer.from(contents, "utf8");
          const actualBytes = Buffer.allocUnsafe(Math.min(expectedBytes.length, 256 * 1024));
          let offset = 0;
          while (offset < expectedBytes.length) {
            const count = readSync(handle.fd, actualBytes, 0, Math.min(actualBytes.length, expectedBytes.length - offset), offset);
            if (count === 0 || !actualBytes.subarray(0, count).equals(expectedBytes.subarray(offset, offset + count))) throw new Error("Guarded atomic publication stage differs from the requested bytes.");
            offset += count;
          }
          stagedSnapshot = fstatSync(handle.fd, { bigint: true });
          if (!stagedSnapshot.isFile() || stagedSnapshot.size !== BigInt(expectedBytes.length) || stagedSnapshot.nlink !== 1n) throw new Error("Guarded atomic publication stage metadata is invalid.");
        }
        finally { await handle.close(); }
        const checked = await safePath(path, false);
        const currentParent = await lstat(dirname(checked));
        const staged = await lstat(temporary);
        if (checked !== target || parent.dev !== currentParent.dev || parent.ino !== currentParent.ino
          || !staged.isFile() || staged.isSymbolicLink() || staged.dev !== identity.dev || staged.ino !== identity.ino) {
          throw new Error("Guarded atomic publication path changed during staging.");
        }
        const parents = [];
        for (let directory = dirname(target);; directory = dirname(directory)) {
          const snapshot = lstatSync(directory, { bigint: true });
          if (!snapshot.isDirectory() || snapshot.isSymbolicLink()) throw new Error("Guarded atomic publication parent is unsafe.");
          parents.push({ directory, snapshot });
          if (dirname(directory) === directory) break;
        }
        await beforeReplace();
        // The asynchronous custody check may yield to other filesystem users.
        // Revalidate the complete physical path and staged content metadata,
        // then dispatch synchronously without another JavaScript await gap.
        for (const item of parents) {
          const current = lstatSync(item.directory, { bigint: true });
          if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== item.snapshot.dev || current.ino !== item.snapshot.ino) throw new Error("Guarded atomic publication parent changed during custody check.");
        }
        const finalStage = lstatSync(temporary, { bigint: true });
        if (!finalStage.isFile() || finalStage.isSymbolicLink() || finalStage.dev !== stagedSnapshot.dev || finalStage.ino !== stagedSnapshot.ino
          || finalStage.size !== stagedSnapshot.size || finalStage.mtimeNs !== stagedSnapshot.mtimeNs || finalStage.ctimeNs !== stagedSnapshot.ctimeNs
          || finalStage.nlink !== 1n || finalStage.mode !== stagedSnapshot.mode) throw new Error("Guarded atomic publication stage changed during custody check.");
        renameSync(temporary, target);
        const directoryHandle = await open(dirname(target), constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      } finally {
        const staged = await lstat(temporary).catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
          throw error;
        });
        if (staged !== undefined && identity !== undefined && staged.dev === identity.dev && staged.ino === identity.ino && !staged.isSymbolicLink()) await unlink(temporary);
      }
    },
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
    async writeTextNoReplace(path, contents, beforePublication) {
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
        if (beforePublication === undefined) disposition = await immutableLink(temporary, target);
        else {
          if (await safePath(path, false) !== target) throw new Error("Immutable publication path changed during staging.");
          disposition = await guardedImmutableLink(temporary, target, { bytes: Buffer.byteLength(contents), sha256: sha256Hex(contents) }, beforePublication);
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
    async copyFileNoReplace(sourcePath, destinationPath, expectedInput, beforePublication) {
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
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
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
          || sourceBefore.size !== expected.bytes
        ) {
          throw new Error(`Immutable bundle copy source changed before opening: ${sourcePath}`);
        }
        let existingIntegrity: BundleFileIntegrity | undefined;
        try { existingIntegrity = await inspectPhysicalFile(destinationPath, expected.bytes); }
        catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        if (existingIntegrity !== undefined) {
          if (
            existingIntegrity.bytes !== expected.bytes
            || existingIntegrity.sha256 !== expected.sha256
          ) {
            throw new Error(
              `Immutable bundle copy destination contains different bytes: ${destinationPath}`,
            );
          }
          await beforePublication?.();
          return "exists";
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
            Math.min(buffer.byteLength, expected.bytes - bytes + 1),
            null,
          );
          if (result.bytesRead === 0) break;
          if (bytes + result.bytesRead > expected.bytes) throw new Error(`Immutable bundle copy source grew beyond its exact byte limit: ${sourcePath}`);
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
        if (beforePublication === undefined) disposition = await immutableLink(temporary, destination);
        else {
          if (await safePath(destinationPath, false) !== destination) throw new Error("Immutable copy destination changed during staging.");
          disposition = await guardedImmutableLink(temporary, destination, expected, beforePublication);
        }
        if (disposition === "created") {
          createdIdentity = {
            dev: temporaryAfter.dev,
            ino: temporaryAfter.ino,
          };
        }
        const destinationIntegrity = await inspectPhysicalFile(destinationPath, expected.bytes);
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
