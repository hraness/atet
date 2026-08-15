import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { z } from "zod";

import {
  RepositoryRelativePathSchema,
  Sha256Schema,
} from "../../../contracts";
import { canonicalJson } from "../../../core/canonical-json";
import type {
  ApplicationContext,
  ApplicationProcessRunOptions,
  ApplicationProcessRunResult,
  ApplicationProcessRunner,
} from "../../context";
import { ApplicationError } from "../../errors";
import type { OperationExecutionContext } from "../../operation";
import {
  ensurePhysicalPrivateDirectoryWithin,
  ensurePrivateDirectory,
} from "../../../cli/paths";
import { throwIfAborted } from "../shared";

export const MAXIMUM_MEDIA_INGEST_INPUT_BYTES = 4 * 1024 * 1024 * 1024 * 1024;
export const MAXIMUM_MEDIA_EFFECT_INPUT_BYTES = 512 * 1024 * 1024 * 1024;

export const MediaArtifactReferenceSchema = z.strictObject({
  bytes: z.number().int().safe().positive(),
  path: RepositoryRelativePathSchema,
  sha256: Sha256Schema,
});

/**
 * The path-only shape is the progressive authoring surface. A host planner
 * may replace it with the integrity-bound shape before hashing a node plan.
 */
export const MediaArtifactRequestSchema = z.union([
  z.strictObject({
    path: RepositoryRelativePathSchema,
  }),
  MediaArtifactReferenceSchema,
]);

export type MediaArtifactReference = z.infer<typeof MediaArtifactReferenceSchema>;
export type MediaArtifactRequest = z.infer<typeof MediaArtifactRequestSchema>;

export interface BoundRepositoryMedia {
  readonly absolutePath: string;
  readonly artifact: MediaArtifactReference;
  readonly expectedInput: {
    readonly bytes: number;
    readonly device: number;
    readonly inode: number;
    readonly modifiedAtMs: number;
    readonly sha256: string;
  };
}

export interface LoadedRepositoryMedia extends BoundRepositoryMedia {
  readonly data: Uint8Array;
}

interface PhysicalRepositoryEntry {
  readonly absolutePath: string;
  readonly device: number;
  readonly inode: number;
  readonly kind: "directory" | "file";
}

interface PhysicalRepositoryPath {
  readonly absolutePath: string;
  readonly entries: readonly PhysicalRepositoryEntry[];
  readonly leaf: Stats;
  readonly lexicalRoot: string;
  readonly path: string;
  readonly repositoryRoot: string;
  readonly root: PhysicalRepositoryEntry;
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === ""
    || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function noEntry(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "ENOENT";
}

function samePhysicalEntry(
  details: Pick<Stats, "dev" | "ino">,
  identity: Pick<PhysicalRepositoryEntry, "device" | "inode">,
): boolean {
  return details.dev === identity.device && details.ino === identity.inode;
}

function physicalEntry(
  absolutePath: string,
  details: Stats,
  kind: PhysicalRepositoryEntry["kind"],
): PhysicalRepositoryEntry {
  return {
    absolutePath,
    device: details.dev,
    inode: details.ino,
    kind,
  };
}

function repositoryMediaNotFound(path: string): ApplicationError {
  return new ApplicationError(
    "not-found",
    `Repository media does not exist: ${path}`,
  );
}

async function existingRealpath(path: string, requestedPath: string): Promise<string> {
  return await realpath(path).catch((error: unknown) => {
    if (noEntry(error)) throw repositoryMediaNotFound(requestedPath);
    throw error;
  });
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function readAndHashOpenFile(
  handle: FileHandle,
  bytes: number,
  signal: AbortSignal,
  loadBytes: boolean,
): Promise<Readonly<{
  readonly data?: Uint8Array;
  readonly sha256: string;
}>> {
  const hash = createHash("sha256");
  const data = loadBytes ? new Uint8Array(bytes) : undefined;
  const buffer = data ?? Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  while (offset < bytes) {
    throwIfAborted(signal);
    const bufferOffset = data === undefined ? 0 : offset;
    const result = await handle.read(
      buffer,
      bufferOffset,
      Math.min(1024 * 1024, bytes - offset),
      offset,
    );
    if (result.bytesRead === 0) break;
    hash.update(
      buffer.subarray(bufferOffset, bufferOffset + result.bytesRead),
    );
    offset += result.bytesRead;
  }
  if (offset !== bytes) {
    throw new ApplicationError(
      "conflict",
      "Media ended while its integrity was being recorded.",
    );
  }
  return {
    ...(data === undefined ? {} : { data }),
    sha256: hash.digest("hex"),
  };
}

async function physicalRepositoryPath(
  application: ApplicationContext,
  requestedPath: string,
): Promise<PhysicalRepositoryPath> {
  const path = RepositoryRelativePathSchema.parse(requestedPath);
  const lexicalRoot = resolve(application.paths.repositoryRoot);
  const rootDetails = await lstat(lexicalRoot);
  if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
    throw new ApplicationError(
      "unsafe-path",
      "The repository root must be a physical directory.",
    );
  }
  const repositoryRoot = await realpath(lexicalRoot);
  const physicalRootDetails = await lstat(repositoryRoot);
  if (
    physicalRootDetails.isSymbolicLink()
    || !physicalRootDetails.isDirectory()
    || !samePhysicalEntry(physicalRootDetails, {
      device: rootDetails.dev,
      inode: rootDetails.ino,
    })
  ) {
    throw new ApplicationError(
      "unsafe-path",
      "The repository root changed while its physical identity was resolved.",
    );
  }
  const root = physicalEntry(repositoryRoot, physicalRootDetails, "directory");
  const candidate = resolve(repositoryRoot, path);
  if (!isWithin(repositoryRoot, candidate) || candidate === repositoryRoot) {
    throw new ApplicationError(
      "unsafe-path",
      `Repository media escaped its repository: ${path}`,
    );
  }
  const absolutePath = await existingRealpath(candidate, path);
  if (
    !isWithin(repositoryRoot, absolutePath)
    || absolutePath === repositoryRoot
    || resolve(absolutePath) !== candidate
  ) {
    throw new ApplicationError(
      "unsafe-path",
      `Repository media paths must not traverse symlinks: ${path}`,
    );
  }
  let current = repositoryRoot;
  const parts = path.split("/");
  const entries: PhysicalRepositoryEntry[] = [];
  let leaf: Stats | undefined;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const details = await lstat(current).catch((error: unknown) => {
      if (noEntry(error)) throw repositoryMediaNotFound(path);
      throw error;
    });
    if (details.isSymbolicLink()) {
      throw new ApplicationError(
        "unsafe-path",
        `Repository media paths must not traverse symlinks: ${path}`,
      );
    }
    const isLeaf = index === parts.length - 1;
    if ((!isLeaf && !details.isDirectory()) || (isLeaf && !details.isFile())) {
      throw new ApplicationError(
        "unsafe-path",
        `Repository media must resolve to a physical regular file: ${path}`,
      );
    }
    entries.push(physicalEntry(
      current,
      details,
      isLeaf ? "file" : "directory",
    ));
    if (isLeaf) leaf = details;
  }
  const confirmedPath = await existingRealpath(candidate, path);
  if (confirmedPath !== absolutePath || current !== absolutePath) {
    throw new ApplicationError(
      "conflict",
      "Repository media changed while its physical path was being resolved.",
    );
  }
  if (leaf === undefined) {
    throw new ApplicationError(
      "internal",
      "Repository media resolution produced no file.",
    );
  }
  return {
    absolutePath,
    entries,
    leaf,
    lexicalRoot,
    path,
    repositoryRoot,
    root,
  };
}

async function assertPhysicalRepositoryPath(
  identity: PhysicalRepositoryPath,
  opened: Stats,
): Promise<void> {
  const rootDetails = await lstat(identity.lexicalRoot).catch(
    (error: unknown) => {
      if (noEntry(error)) {
        throw new ApplicationError(
          "conflict",
          "The repository root changed while media was being verified.",
        );
      }
      throw error;
    },
  );
  if (
    rootDetails.isSymbolicLink()
    || !rootDetails.isDirectory()
    || !samePhysicalEntry(rootDetails, identity.root)
  ) {
    throw new ApplicationError(
      "conflict",
      "The repository root changed while media was being verified.",
    );
  }
  const [repositoryRoot, absolutePath] = await Promise.all([
    realpath(identity.lexicalRoot),
    realpath(resolve(identity.repositoryRoot, identity.path)),
  ]).catch(() => {
    throw new ApplicationError(
      "conflict",
      "Repository media changed while its physical identity was being verified.",
    );
  });
  if (
    repositoryRoot !== identity.repositoryRoot
    || absolutePath !== identity.absolutePath
  ) {
    throw new ApplicationError(
      "conflict",
      "Repository media changed while its physical identity was being verified.",
    );
  }
  for (const entry of identity.entries) {
    const details = await lstat(entry.absolutePath).catch(() => {
      throw new ApplicationError(
        "conflict",
        "Repository media changed while its physical identity was being verified.",
      );
    });
    if (
      details.isSymbolicLink()
      || (entry.kind === "directory" && !details.isDirectory())
      || (entry.kind === "file" && !details.isFile())
      || !samePhysicalEntry(details, entry)
    ) {
      throw new ApplicationError(
        "conflict",
        "Repository media changed while its physical identity was being verified.",
      );
    }
  }
  if (
    !opened.isFile()
    || opened.dev !== identity.leaf.dev
    || opened.ino !== identity.leaf.ino
    || opened.size !== identity.leaf.size
    || opened.mtimeMs !== identity.leaf.mtimeMs
    || opened.ctimeMs !== identity.leaf.ctimeMs
  ) {
    throw new ApplicationError(
      "conflict",
      "Repository media changed while its descriptor was being verified.",
    );
  }
}

async function inspectRepositoryMedia(
  application: ApplicationContext,
  input: MediaArtifactRequest,
  signal: AbortSignal,
  maximumBytes: number,
  loadBytes: boolean,
): Promise<BoundRepositoryMedia | LoadedRepositoryMedia> {
  throwIfAborted(signal);
  const request = MediaArtifactRequestSchema.parse(input);
  const physical = await physicalRepositoryPath(application, request.path);
  if (
    physical.leaf.isSymbolicLink()
    || !physical.leaf.isFile()
    || !Number.isSafeInteger(physical.leaf.size)
    || physical.leaf.size <= 0
    || physical.leaf.size > maximumBytes
  ) {
    throw new ApplicationError(
      "invalid-data",
      `Media must contain 1 through ${String(maximumBytes)} bytes.`,
    );
  }
  const handle = await open(
    physical.absolutePath,
    constants.O_RDONLY
      | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await handle.stat();
    const exactBefore = await handle.stat({ bigint: true });
    if (
      !before.isFile()
      || !exactBefore.isFile()
      || before.dev !== physical.leaf.dev
      || before.ino !== physical.leaf.ino
      || before.size !== physical.leaf.size
      || before.mtimeMs !== physical.leaf.mtimeMs
      || before.ctimeMs !== physical.leaf.ctimeMs
    ) {
      throw new ApplicationError(
        "conflict",
        "Media changed while its descriptor was being opened.",
      );
    }
    await assertPhysicalRepositoryPath(physical, before);
    const inspected = await readAndHashOpenFile(
      handle,
      before.size,
      signal,
      loadBytes,
    );
    const after = await handle.stat();
    const exactAfter = await handle.stat({ bigint: true });
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
      || exactAfter.dev !== exactBefore.dev
      || exactAfter.ino !== exactBefore.ino
      || exactAfter.size !== exactBefore.size
      || exactAfter.mtimeNs !== exactBefore.mtimeNs
      || exactAfter.ctimeNs !== exactBefore.ctimeNs
    ) {
      throw new ApplicationError(
        "conflict",
        "Media changed while its integrity was being recorded.",
      );
    }
    await assertPhysicalRepositoryPath(physical, after);
    const artifact = MediaArtifactReferenceSchema.parse({
      bytes: before.size,
      path: relative(physical.repositoryRoot, physical.absolutePath),
      sha256: inspected.sha256,
    });
    if (
      "bytes" in request
      && (
        request.bytes !== artifact.bytes
        || request.sha256 !== artifact.sha256
      )
    ) {
      throw new ApplicationError(
        "conflict",
        "Media no longer matches its integrity-bound workflow input.",
        {
          actualBytes: artifact.bytes,
          actualSha256: artifact.sha256,
          expectedBytes: request.bytes,
          expectedSha256: request.sha256,
          path: artifact.path,
        },
      );
    }
    return {
      absolutePath: physical.absolutePath,
      artifact,
      ...(inspected.data === undefined ? {} : { data: inspected.data }),
      expectedInput: {
        bytes: before.size,
        device: before.dev,
        inode: before.ino,
        modifiedAtMs: before.mtimeMs,
        sha256: inspected.sha256,
      },
    };
  } finally {
    await handle.close();
  }
}

export async function bindRepositoryMedia(
  application: ApplicationContext,
  input: MediaArtifactRequest,
  signal: AbortSignal,
  maximumBytes: number,
): Promise<BoundRepositoryMedia> {
  return await inspectRepositoryMedia(
    application,
    input,
    signal,
    maximumBytes,
    false,
  );
}

export async function loadRepositoryMedia(
  application: ApplicationContext,
  input: MediaArtifactRequest,
  signal: AbortSignal,
  maximumBytes: number,
): Promise<LoadedRepositoryMedia> {
  const loaded = await inspectRepositoryMedia(
    application,
    input,
    signal,
    maximumBytes,
    true,
  );
  if (!("data" in loaded)) {
    throw new ApplicationError(
      "internal",
      "Repository media loading returned no pinned bytes.",
    );
  }
  return loaded;
}

export class AbortBoundApplicationRunner implements ApplicationProcessRunner {
  readonly #runner: ApplicationProcessRunner;
  readonly #signal: AbortSignal;

  constructor(runner: ApplicationProcessRunner, signal: AbortSignal) {
    this.#runner = runner;
    this.#signal = signal;
  }

  async run(
    argv: readonly [string, ...string[]],
    options: ApplicationProcessRunOptions = {},
  ): Promise<ApplicationProcessRunResult> {
    throwIfAborted(this.#signal);
    return await this.#runner.run(argv, {
      ...options,
      abortSignal: this.#signal,
    });
  }
}

export interface MediaOperationWorkspace {
  readonly path: string;
  dispose(): Promise<void>;
}

async function assertPrivateWorkspace(
  application: ApplicationContext,
  path: string,
): Promise<string> {
  await ensurePrivateDirectory(application.paths.privateRoot);
  const [privateRoot, details] = await Promise.all([
    realpath(application.paths.privateRoot),
    lstat(path),
  ]);
  if (
    details.isSymbolicLink()
    || !details.isDirectory()
    || (details.mode & 0o077) !== 0
  ) {
    throw new ApplicationError(
      "unsafe-path",
      "Media-operation staging must be a private physical directory.",
    );
  }
  const physical = await realpath(path);
  if (!isWithin(privateRoot, physical) || physical === privateRoot) {
    throw new ApplicationError(
      "unsafe-path",
      "Media-operation staging escaped the application private root.",
    );
  }
  return physical;
}

export async function createMediaOperationWorkspace(
  context: OperationExecutionContext,
): Promise<MediaOperationWorkspace> {
  const supplied = context.workflow?.workspaceDirectory;
  if (supplied !== undefined) {
    return {
      dispose: () => Promise.resolve(),
      path: await assertPrivateWorkspace(context.application, supplied),
    };
  }
  await ensurePrivateDirectory(context.application.paths.privateRoot);
  const path = await ensurePhysicalPrivateDirectoryWithin(
    context.application.paths.privateRoot,
    `media-operations/${randomUUID()}`,
  );
  return {
    dispose: async () => await rm(path, { force: true, recursive: true }),
    path: await assertPrivateWorkspace(context.application, path),
  };
}

async function generatedDirectory(
  application: ApplicationContext,
  category: "outputs" | "receipts",
): Promise<string> {
  return await ensurePhysicalPrivateDirectoryWithin(
    application.paths.repositoryRoot,
    relative(
      application.paths.repositoryRoot,
      join(dirname(application.paths.artifactRoot), `generated/media-operations/${category}`),
    ),
  );
}

async function digestPhysicalAbsoluteFile(
  application: ApplicationContext,
  absolutePath: string,
  signal: AbortSignal,
  maximumBytes: number,
): Promise<MediaArtifactReference> {
  const repositoryRoot = await realpath(application.paths.repositoryRoot);
  const resolved = resolve(absolutePath);
  if (!isWithin(repositoryRoot, resolved) || resolved === repositoryRoot) {
    throw new ApplicationError(
      "unsafe-path",
      "Published media must remain inside the repository.",
    );
  }
  const details = await lstat(resolved);
  if (
    details.isSymbolicLink()
    || !details.isFile()
    || details.nlink !== 1
    || !Number.isSafeInteger(details.size)
    || details.size <= 0
    || details.size > maximumBytes
  ) {
    throw new ApplicationError(
      "invalid-data",
      "Published media is unsafe, empty, multiply linked, or too large.",
    );
  }
  const handle = await open(
    resolved,
    constants.O_RDONLY
      | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.dev !== details.dev
      || before.ino !== details.ino
      || before.size !== details.size
      || before.nlink !== 1
    ) {
      throw new ApplicationError(
        "conflict",
        "Published media changed while it was being opened.",
      );
    }
    const { sha256 } = await readAndHashOpenFile(
      handle,
      before.size,
      signal,
      false,
    );
    const after = await handle.stat();
    if (
      after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.nlink !== before.nlink
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) {
      throw new ApplicationError(
        "conflict",
        "Published media changed while it was being verified.",
      );
    }
    return MediaArtifactReferenceSchema.parse({
      bytes: before.size,
      path: relative(repositoryRoot, resolved),
      sha256,
    });
  } finally {
    await handle.close();
  }
}

async function verifyExistingContentAddress(
  application: ApplicationContext,
  path: string,
  expected: Pick<MediaArtifactReference, "bytes" | "sha256">,
  signal: AbortSignal,
  maximumBytes: number,
): Promise<void> {
  const actual = await digestPhysicalAbsoluteFile(
    application,
    path,
    signal,
    maximumBytes,
  );
  if (
    actual.bytes !== expected.bytes
    || actual.sha256 !== expected.sha256
  ) {
    throw new ApplicationError(
      "conflict",
      "A content-addressed media destination contains different bytes.",
      {
        actualBytes: actual.bytes,
        actualSha256: actual.sha256,
        expectedBytes: expected.bytes,
        expectedSha256: expected.sha256,
      },
    );
  }
}

export async function publishContentAddressedMedia(options: {
  readonly context: OperationExecutionContext;
  readonly extension: string;
  readonly maximumBytes: number;
  readonly stagedPath: string;
}): Promise<{
  readonly artifact: MediaArtifactReference;
  readonly created: boolean;
}> {
  const staged = await digestPhysicalAbsoluteFile(
    options.context.application,
    options.stagedPath,
    options.context.abortSignal,
    options.maximumBytes,
  );
  if (!/^\.[a-z0-9]{1,12}$/u.test(options.extension)) {
    throw new ApplicationError("internal", "Media output extension is invalid.");
  }
  const directory = await generatedDirectory(
    options.context.application,
    "outputs",
  );
  const destination = join(
    directory,
    `${staged.sha256}${options.extension}`,
  );
  await options.context.workflow?.beforePublication();
  throwIfAborted(options.context.abortSignal);
  let created = false;
  try {
    await link(options.stagedPath, destination);
    created = true;
    await syncDirectory(directory);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
    await verifyExistingContentAddress(
      options.context.application,
      destination,
      staged,
      options.context.abortSignal,
      options.maximumBytes,
    );
  }
  await rm(options.stagedPath, { force: true });
  return {
    artifact: MediaArtifactReferenceSchema.parse({
      ...staged,
      path: relative(
        await realpath(options.context.application.paths.repositoryRoot),
        destination,
      ),
    }),
    created,
  };
}

export async function publishContentAddressedReceipt(options: {
  readonly context: OperationExecutionContext;
  readonly receipt: unknown;
  readonly workspace: MediaOperationWorkspace;
}): Promise<MediaArtifactReference> {
  const source = `${canonicalJson(options.receipt)}\n`;
  const sourceBytes = new TextEncoder().encode(source);
  if (sourceBytes.byteLength < 1 || sourceBytes.byteLength > 1024 * 1024) {
    throw new ApplicationError(
      "invalid-data",
      "Media operation receipt exceeds its one-megabyte bound.",
    );
  }
  const sha256 = createHash("sha256").update(sourceBytes).digest("hex");
  const temporary = join(
    options.workspace.path,
    `.receipt-${randomUUID()}.json`,
  );
  const handle = await open(
    temporary,
    constants.O_CREAT
      | constants.O_EXCL
      | constants.O_WRONLY
      | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(sourceBytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await generatedDirectory(
    options.context.application,
    "receipts",
  );
  const destination = join(directory, `${sha256}.json`);
  await options.context.workflow?.beforePublication();
  throwIfAborted(options.context.abortSignal);
  try {
    await link(temporary, destination);
    await syncDirectory(directory);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
    await verifyExistingContentAddress(
      options.context.application,
      destination,
      { bytes: sourceBytes.byteLength, sha256 },
      options.context.abortSignal,
      1024 * 1024,
    );
  } finally {
    await rm(temporary, { force: true });
  }
  return MediaArtifactReferenceSchema.parse({
    bytes: sourceBytes.byteLength,
    path: relative(
      await realpath(options.context.application.paths.repositoryRoot),
      destination,
    ),
    sha256,
  });
}
