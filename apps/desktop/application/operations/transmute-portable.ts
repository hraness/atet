import {
  PORTABLE_TRANSMUTE_OPERATION_CONTRACTS,
  PORTABLE_TRANSMUTE_OPERATION_KINDS,
  PUBLIC_WORKFLOW_REGISTRY_PROJECTION,
  type PortableTransmuteOperationKind,
} from "@hraness/transmute/code/advanced";
import {
  executeTransmuteOperation,
  executeTransmuteOperationWithLease,
  parseTransmuteOperationInput,
  type TransmuteOperationDependencies,
} from "@hraness/transmute/operations";
import { createHash } from "node:crypto";
import { constants, type BigIntStats, type Stats } from "node:fs";
import {
  type FileHandle,
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  ensurePrivateDirectory,
  ensurePhysicalPrivateDirectoryWithin,
} from "../../cli/paths";
import { withMutationLock } from "../../cli/mutation-lock";
import { sha256Hex } from "../../core/canonical-json";
import { createNodeBundleFileSystem } from "../../core/storage";
import type {
  ApplicationContext,
  ApplicationHostResourceLease,
} from "../context";
import { ApplicationError } from "../errors";
import type {
  OperationDefinition,
  OperationExecutionContext,
  OperationLifecycle,
} from "../operation";
import { MAXIMUM_DIAGRAM_SOURCE_BYTES } from "./transmute-visuals";
import { bindRepositoryMedia } from "./media/shared";

type PortableOperationContract =
  typeof PORTABLE_TRANSMUTE_OPERATION_CONTRACTS[PortableTransmuteOperationKind];

const portableOperationContracts = Object.freeze(
  PORTABLE_TRANSMUTE_OPERATION_KINDS.map(
    kind => PORTABLE_TRANSMUTE_OPERATION_CONTRACTS[kind],
  ),
);

const PORTABLE_OPERATION_COUNT = 4;

type PortableExecutor = (
  kind: PortableTransmuteOperationKind,
  input: unknown,
  dependencies?: TransmuteOperationDependencies,
) => Promise<unknown>;

type PortableLeasedExecutor = (
  kind: PortableTransmuteOperationKind,
  input: unknown,
  lease: ApplicationHostResourceLease,
  dependencies?: TransmuteOperationDependencies,
) => Promise<unknown>;

export interface TransmutePortableOperationDependencies {
  readonly execute?: PortableExecutor;
  readonly executeWithLease?: PortableLeasedExecutor;
  readonly parseInput?: (
    kind: PortableTransmuteOperationKind,
    input: unknown,
  ) => unknown;
}

const NONLOCAL_PATH_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/u;

function unsafePath(name: string): never {
  throw new ApplicationError(
    "unsafe-path",
    `${name} must be a bounded local path inside the repository or an explicit absolute caller path.`,
  );
}

function resolvePortablePath(
  repositoryRootValue: string,
  value: unknown,
  name: string,
): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 4_096
    || value.includes("\0")
    || NONLOCAL_PATH_PATTERN.test(value)
    || value.startsWith("\\\\")
    || value.startsWith("//")
  ) {
    return unsafePath(name);
  }
  if (isAbsolute(value)) return normalize(value);

  let repositoryRoot: string;
  let absolutePath: string;
  try {
    repositoryRoot = resolve(repositoryRootValue);
    absolutePath = resolve(repositoryRoot, value);
  } catch {
    return unsafePath(name);
  }
  const repositoryRelativePath = relative(repositoryRoot, absolutePath);
  if (
    repositoryRelativePath === ".."
    || repositoryRelativePath.startsWith(`..${sep}`)
    || isAbsolute(repositoryRelativePath)
  ) {
    return unsafePath(name);
  }
  return absolutePath;
}

function inputRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApplicationError(
      "invalid-data",
      "Portable Transmute operation input must be an object.",
    );
  }
  return value as Readonly<Record<string, unknown>>;
}

function resolvePortableOperationPaths(
  repositoryRoot: string,
  kind: PortableTransmuteOperationKind,
  value: unknown,
): Readonly<Record<string, unknown>> {
  const input = inputRecord(value);
  switch (kind) {
    case "transmute.diagram.check":
      return {
        ...input,
        path: resolvePortablePath(repositoryRoot, input.path, "path"),
      };
    case "transmute.diagram.render":
      return {
        ...input,
        path: resolvePortablePath(repositoryRoot, input.path, "path"),
        ...(input.outDirectory === undefined
          ? {}
          : {
              outDirectory: resolvePortablePath(
                repositoryRoot,
                input.outDirectory,
                "outDirectory",
              ),
            }),
      };
    case "transmute.image.vectorize":
      return {
        ...input,
        inputPath: resolvePortablePath(
          repositoryRoot,
          input.inputPath,
          "inputPath",
        ),
        outputPath: resolvePortablePath(
          repositoryRoot,
          input.outputPath,
          "outputPath",
        ),
      };
    case "transmute.image.generate":
      return {
        ...input,
        outputPath: resolvePortablePath(
          repositoryRoot,
          input.outputPath,
          "outputPath",
        ),
      };
  }
}

const PORTABLE_INPUT_SNAPSHOT_ROOT = "portable-operation-inputs/v1";
const PORTABLE_OUTPUT_LEASE_ROOT = "portable-output-publication-leases";
const MAXIMUM_VECTOR_SOURCE_BYTES =
  PORTABLE_TRANSMUTE_OPERATION_CONTRACTS["transmute.image.vectorize"]
    .policy.maxInputBytes;
const portableOutputLeaseTails = new Map<string, Promise<void>>();

interface PortableSnapshotIdentity {
  readonly bytes: number;
  readonly device: number;
  readonly inode: number;
  readonly modifiedAtMs: number;
  readonly path: string;
  readonly sha256: string;
}

interface PinnedPortableSnapshot {
  readonly assertUnchanged: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly descriptor: number;
  readonly input: Readonly<Record<string, unknown>>;
}

function repositoryRelativePath(
  repositoryRootValue: string,
  absolutePathValue: string,
  name: string,
): string {
  const repositoryRoot = resolve(repositoryRootValue);
  const absolutePath = resolve(absolutePathValue);
  const repositoryPath = relative(repositoryRoot, absolutePath);
  if (
    repositoryPath === ""
    || repositoryPath === ".."
    || repositoryPath.startsWith(`..${sep}`)
    || isAbsolute(repositoryPath)
  ) {
    throw new ApplicationError(
      "unsafe-path",
      `${name} must resolve to a physical file inside the repository for durable workflow execution.`,
    );
  }
  return repositoryPath;
}

function pathWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === ""
    || (
      fromRoot !== ".."
      && !fromRoot.startsWith(`..${sep}`)
      && !isAbsolute(fromRoot)
    );
}

function commonPhysicalBundleRoot(
  sourcePath: string,
  privateRoot: string,
): string {
  let root = dirname(resolve(sourcePath));
  const destination = resolve(privateRoot);
  while (!pathWithin(root, destination)) {
    const parent = dirname(root);
    if (parent === root) {
      throw new ApplicationError(
        "unsafe-path",
        "Portable operation source and private storage do not share a local filesystem root.",
      );
    }
    root = parent;
  }
  return root;
}

function noEntry(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "ENOENT";
}

function portableOutputTarget(
  kind: PortableTransmuteOperationKind,
  input: Readonly<Record<string, unknown>>,
): string | undefined {
  if (kind === "transmute.diagram.render") {
    if (typeof input.outDirectory === "string") return input.outDirectory;
    return typeof input.path === "string" ? dirname(input.path) : undefined;
  }
  if (
    kind === "transmute.image.generate"
    || kind === "transmute.image.vectorize"
  ) {
    return typeof input.outputPath === "string" ? input.outputPath : undefined;
  }
  return undefined;
}

async function canonicalPhysicalOutputTarget(
  targetValue: string,
  directoryTarget: boolean,
): Promise<string> {
  const target = resolve(targetValue);
  const missing: string[] = [];
  let existing = target;
  let details;
  while (true) {
    try {
      details = await lstat(existing);
      break;
    } catch (error) {
      if (!noEntry(error)) throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(basename(existing));
      existing = parent;
    }
  }
  if (details.isSymbolicLink() && missing.length === 0 && !directoryTarget) {
    throw new ApplicationError(
      "unsafe-path",
      "Portable operation file outputs must not replace an existing symlink.",
    );
  }
  const physicalExisting = await realpath(existing);
  const physicalDetails = await lstat(physicalExisting);
  if (
    physicalDetails.isSymbolicLink()
    || (
      missing.length > 0 || directoryTarget
        ? !physicalDetails.isDirectory()
        : !physicalDetails.isFile()
    )
    || (
      !details.isSymbolicLink()
      && (
        physicalDetails.dev !== details.dev
        || physicalDetails.ino !== details.ino
      )
    )
  ) {
    throw new ApplicationError(
      "unsafe-path",
      "Portable operation output target ancestry changed during canonicalization.",
    );
  }
  return resolve(physicalExisting, ...missing);
}

async function canonicalizePortableOutputTarget(
  kind: PortableTransmuteOperationKind,
  input: Readonly<Record<string, unknown>>,
  repositoryRoot?: string,
): Promise<Readonly<Record<string, unknown>>> {
  const target = portableOutputTarget(kind, input);
  if (target === undefined) return input;
  const canonical = await canonicalPhysicalOutputTarget(
    target,
    kind === "transmute.diagram.render",
  );
  if (
    repositoryRoot !== undefined
    && !pathWithin(await realpath(repositoryRoot), canonical)
  ) {
    throw new ApplicationError(
      "unsafe-path",
      "Repository-relative portable output resolved outside the physical repository root.",
    );
  }
  return kind === "transmute.diagram.render"
    ? { ...input, outDirectory: canonical }
    : { ...input, outputPath: canonical };
}

function portableOutputIsRepositoryRelative(
  kind: PortableTransmuteOperationKind,
  input: Readonly<Record<string, unknown>>,
): boolean {
  const target = portableOutputTarget(kind, input);
  return target !== undefined && !isAbsolute(target);
}

export function transmutePortableOutputPublicationParent(
  kind: PortableTransmuteOperationKind,
  inputValue: unknown,
): string | undefined {
  const input = inputRecord(inputValue);
  const target = portableOutputTarget(kind, input);
  if (target === undefined) return undefined;
  const parent = kind === "transmute.diagram.render"
    ? target
    : dirname(target);
  return normalize(parent).normalize("NFC").toLowerCase();
}

async function portableOutputLeaseDirectory(
  application: ApplicationContext,
  publicationParent: string,
): Promise<string> {
  let physicalMutationRoot: string;
  if (application.machineStateRoot !== undefined) {
    await ensurePrivateDirectory(application.machineStateRoot);
    physicalMutationRoot = await realpath(application.machineStateRoot);
  } else {
    const repositoryRoot = resolve(application.paths.repositoryRoot);
    const privateRoot = repositoryRelativePath(
      repositoryRoot,
      application.paths.privateRoot,
      "Application private root",
    );
    physicalMutationRoot = await ensurePhysicalPrivateDirectoryWithin(
      repositoryRoot,
      privateRoot,
    );
  }
  const leaseRoot = await ensurePhysicalPrivateDirectoryWithin(
    physicalMutationRoot,
    PORTABLE_OUTPUT_LEASE_ROOT,
  );
  const key = sha256Hex(
    `transmute.portable-output-publication-lease/v1\0${publicationParent}`,
  );
  return await ensurePhysicalPrivateDirectoryWithin(leaseRoot, key);
}

async function withPortableOutputQueue<Value>(
  key: string,
  execute: () => Promise<Value>,
): Promise<Value> {
  const previous = portableOutputLeaseTails.get(key) ?? Promise.resolve();
  const result = previous.then(execute);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  portableOutputLeaseTails.set(key, settled);
  try {
    return await result;
  } finally {
    if (portableOutputLeaseTails.get(key) === settled) {
      portableOutputLeaseTails.delete(key);
    }
  }
}

async function withPortableOutputPublicationLease<Value>(
  application: ApplicationContext,
  publicationParent: string,
  execute: () => Promise<Value>,
): Promise<Value> {
  const directory = await portableOutputLeaseDirectory(
    application,
    publicationParent,
  );
  return await withPortableOutputQueue(directory, async () =>
    await withMutationLock(directory, {
      command: "workflow:transmute-portable",
      label: publicationParent.slice(0, 512),
      now: application.clock.now,
    }, execute));
}

async function snapshotPortableSource(
  application: ApplicationContext,
  absoluteSourcePath: string,
  kind: "diagram" | "vector",
  maximumBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const lexicalRepositoryRoot = resolve(application.paths.repositoryRoot);
  const privateRoot = repositoryRelativePath(
    lexicalRepositoryRoot,
    application.paths.privateRoot,
    "Application private root",
  );
  const physicalPrivateRoot = await ensurePhysicalPrivateDirectoryWithin(
    lexicalRepositoryRoot,
    privateRoot,
  );
  const lexicalSourcePath = resolve(absoluteSourcePath);
  const lexicalRepositorySourcePath = pathWithin(
    lexicalRepositoryRoot,
    lexicalSourcePath,
  )
    ? relative(lexicalRepositoryRoot, lexicalSourcePath)
    : undefined;
  const boundRepositorySource = lexicalRepositorySourcePath === undefined
    ? undefined
    : await bindRepositoryMedia(
        application,
        { path: lexicalRepositorySourcePath },
        signal,
        maximumBytes,
      );
  let physicalSource: string;
  if (boundRepositorySource !== undefined) {
    physicalSource = boundRepositorySource.absolutePath;
  } else {
    const lexicalSource = await lstat(lexicalSourcePath);
    if (
      lexicalSource.isSymbolicLink()
      || !lexicalSource.isFile()
      || lexicalSource.size < 1
      || lexicalSource.size > maximumBytes
    ) {
      throw new ApplicationError(
        "invalid-data",
        "Portable operation source must be a bounded physical file.",
      );
    }
    physicalSource = await realpath(lexicalSourcePath);
    const physicalSourceDetails = await lstat(physicalSource);
    if (
      physicalSourceDetails.isSymbolicLink()
      || !physicalSourceDetails.isFile()
      || physicalSourceDetails.dev !== lexicalSource.dev
      || physicalSourceDetails.ino !== lexicalSource.ino
    ) {
      throw new ApplicationError(
        "unsafe-path",
        "Portable operation source ancestry changed during physical resolution.",
      );
    }
  }
  const bundleRoot = commonPhysicalBundleRoot(
    physicalSource,
    physicalPrivateRoot,
  );
  const sourcePath = relative(bundleRoot, physicalSource);
  const fileSystem = createNodeBundleFileSystem(bundleRoot);
  if (
    fileSystem.copyFileNoReplace === undefined
    || fileSystem.inspectFile === undefined
  ) {
    throw new ApplicationError(
      "internal",
      "Portable operation input snapshots require immutable file storage.",
    );
  }
  const sourceArtifact = boundRepositorySource !== undefined
    ? boundRepositorySource.artifact
    : await (async () => {
        const inspected = await fileSystem.inspectFile!(sourcePath);
        if (inspected.bytes < 1 || inspected.bytes > maximumBytes) {
          throw new ApplicationError(
            "invalid-data",
            "Portable operation source exceeds its registered byte limit.",
          );
        }
        return inspected;
      })();
  const extension = kind === "diagram" ? ".diagram.json" : ".image";
  const absoluteSnapshotPath = resolve(physicalPrivateRoot, join(
    PORTABLE_INPUT_SNAPSHOT_ROOT,
    kind,
    `${sourceArtifact.sha256}${extension}`,
  ));
  const snapshotPath = relative(bundleRoot, absoluteSnapshotPath);
  if (sourcePath !== snapshotPath) {
    await fileSystem.copyFileNoReplace(
      sourcePath,
      snapshotPath,
      sourceArtifact,
    );
  }
  const snapshotHandle = await open(
    absoluteSnapshotPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let snapshotIdentity: Readonly<{ readonly dev: number; readonly ino: number }>;
  try {
    const before = await snapshotHandle.stat();
    if (!before.isFile()) {
      throw new ApplicationError(
        "unsafe-path",
        "Portable operation input snapshot must remain a physical file.",
      );
    }
    if ((before.mode & 0o777) !== 0o400) {
      await snapshotHandle.chmod(0o400);
    }
    const after = await snapshotHandle.stat();
    if (
      !after.isFile()
      || after.dev !== before.dev
      || after.ino !== before.ino
      || (after.mode & 0o777) !== 0o400
    ) {
      throw new ApplicationError(
        "conflict",
        "Portable operation input snapshot changed while it was made read-only.",
      );
    }
    snapshotIdentity = { dev: after.dev, ino: after.ino };
  } finally {
    await snapshotHandle.close();
  }
  const namedSnapshot = await lstat(absoluteSnapshotPath);
  if (
    namedSnapshot.isSymbolicLink()
    || !namedSnapshot.isFile()
    || namedSnapshot.dev !== snapshotIdentity.dev
    || namedSnapshot.ino !== snapshotIdentity.ino
    || (namedSnapshot.mode & 0o777) !== 0o400
  ) {
    throw new ApplicationError(
      "conflict",
      "Portable operation input snapshot path changed after publication.",
    );
  }
  const snapshot = await fileSystem.inspectFile(snapshotPath);
  if (
    snapshot.bytes !== sourceArtifact.bytes
    || snapshot.sha256 !== sourceArtifact.sha256
  ) {
    throw new ApplicationError(
      "conflict",
      "Portable operation input snapshot does not match its bound source bytes.",
    );
  }
  return absoluteSnapshotPath;
}

async function assertPortableSnapshotIntegrity(
  application: ApplicationContext,
  kind: PortableTransmuteOperationKind,
  input: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<PortableSnapshotIdentity | undefined> {
  const source = kind === "transmute.diagram.check"
    || kind === "transmute.diagram.render"
    ? input.path
    : kind === "transmute.image.vectorize"
      ? input.inputPath
      : undefined;
  if (typeof source !== "string") return undefined;
  const lexicalRepositoryRoot = resolve(application.paths.repositoryRoot);
  const lexicalPrivateRoot = resolve(application.paths.privateRoot);
  if (
    lexicalPrivateRoot === lexicalRepositoryRoot
    || !pathWithin(lexicalRepositoryRoot, lexicalPrivateRoot)
  ) return undefined;
  const privateRoot = repositoryRelativePath(
    lexicalRepositoryRoot,
    lexicalPrivateRoot,
    "Application private root",
  );
  const physicalRepositoryRoot = await realpath(lexicalRepositoryRoot);
  const stablePhysicalPrivateRoot = resolve(
    physicalRepositoryRoot,
    privateRoot,
  );
  const resolvedSource = resolve(source);
  const stableSourcePath = pathWithin(lexicalRepositoryRoot, resolvedSource)
    ? resolve(
        physicalRepositoryRoot,
        relative(lexicalRepositoryRoot, resolvedSource),
      )
    : resolvedSource;
  const snapshotRoot = resolve(
    stablePhysicalPrivateRoot,
    PORTABLE_INPUT_SNAPSHOT_ROOT,
  );
  const snapshotRelativePath = relative(snapshotRoot, stableSourcePath);
  if (
    snapshotRelativePath === ""
    || snapshotRelativePath === ".."
    || snapshotRelativePath.startsWith(`..${sep}`)
    || isAbsolute(snapshotRelativePath)
  ) return undefined;

  let currentPhysicalPrivateRoot: string;
  try {
    currentPhysicalPrivateRoot = await realpath(application.paths.privateRoot);
  } catch {
    throw new ApplicationError(
      "conflict",
      "Portable operation private snapshot storage changed after execution planning.",
    );
  }
  let currentPrivateRoot: Stats;
  let stablePrivateRoot: Stats;
  try {
    [currentPrivateRoot, stablePrivateRoot] = await Promise.all([
      lstat(application.paths.privateRoot),
      lstat(stablePhysicalPrivateRoot),
    ]);
  } catch {
    throw new ApplicationError(
      "conflict",
      "Portable operation private snapshot storage changed after execution planning.",
    );
  }
  if (
    currentPhysicalPrivateRoot !== stablePhysicalPrivateRoot
    || currentPrivateRoot.isSymbolicLink()
    || !currentPrivateRoot.isDirectory()
    || stablePrivateRoot.isSymbolicLink()
    || !stablePrivateRoot.isDirectory()
    || currentPrivateRoot.dev !== stablePrivateRoot.dev
    || currentPrivateRoot.ino !== stablePrivateRoot.ino
  ) {
    throw new ApplicationError(
      "conflict",
      "Portable operation private snapshot storage changed after execution planning.",
    );
  }

  const sourceKind = kind === "transmute.image.vectorize"
    ? "vector"
    : "diagram";
  const expectedSuffix = sourceKind === "diagram" ? ".diagram.json" : ".image";
  const expectedPrefix = basename(source).slice(0, -expectedSuffix.length);
  const expectedRelativePrefix = `${sourceKind}${sep}`;
  if (
    !snapshotRelativePath.startsWith(expectedRelativePrefix)
    || snapshotRelativePath.slice(expectedRelativePrefix.length).includes(sep)
    || !basename(source).endsWith(expectedSuffix)
    || !/^[a-f0-9]{64}$/u.test(expectedPrefix)
  ) {
    throw new ApplicationError(
      "unsafe-path",
      "Portable operation input snapshot has an invalid content-addressed path.",
    );
  }
  const repositoryPath = repositoryRelativePath(
    physicalRepositoryRoot,
    stableSourcePath,
    "Portable operation input snapshot",
  );
  const before = await lstat(stableSourcePath);
  if (
    before.isSymbolicLink()
    || !before.isFile()
    || (before.mode & 0o777) !== 0o400
  ) {
    throw new ApplicationError(
      "conflict",
      "Portable operation input snapshot is no longer a read-only physical file.",
    );
  }
  const inspected = await bindRepositoryMedia(
    application,
    { path: repositoryPath },
    signal,
    sourceKind === "diagram"
      ? MAXIMUM_DIAGRAM_SOURCE_BYTES
      : MAXIMUM_VECTOR_SOURCE_BYTES,
  );
  const after = await lstat(stableSourcePath);
  if (
    inspected.artifact.sha256 !== expectedPrefix
    || after.isSymbolicLink()
    || !after.isFile()
    || after.dev !== before.dev
    || after.ino !== before.ino
    || (after.mode & 0o777) !== 0o400
  ) {
    throw new ApplicationError(
      "conflict",
      "Portable operation input snapshot changed after execution planning.",
      {
        actualSha256: inspected.artifact.sha256,
        expectedSha256: expectedPrefix,
        path: repositoryPath,
      },
    );
  }
  return {
    bytes: inspected.artifact.bytes,
    device: inspected.expectedInput.device,
    inode: inspected.expectedInput.inode,
    modifiedAtMs: inspected.expectedInput.modifiedAtMs,
    path: stableSourcePath,
    sha256: expectedPrefix,
  };
}

function sameExactSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function hashOpenSnapshot(
  handle: FileHandle,
  bytes: number,
): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  while (offset < bytes) {
    const read = await handle.read(
      buffer,
      0,
      Math.min(buffer.byteLength, bytes - offset),
      offset,
    );
    if (read.bytesRead === 0) break;
    hash.update(buffer.subarray(0, read.bytesRead));
    offset += read.bytesRead;
  }
  if (offset !== bytes) {
    throw new ApplicationError(
      "conflict",
      "Portable operation input snapshot ended while its descriptor was pinned.",
    );
  }
  return hash.digest("hex");
}

async function openPinnedPortableSnapshot(
  application: ApplicationContext,
  kind: PortableTransmuteOperationKind,
  input: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<PinnedPortableSnapshot | undefined> {
  const expected = await assertPortableSnapshotIntegrity(
    application,
    kind,
    input,
    signal,
  );
  if (expected === undefined) return undefined;
  if (process.platform === "win32") {
    throw new ApplicationError(
      "unavailable",
      "Descriptor-pinned portable operation inputs require a POSIX host.",
    );
  }
  const handle = await open(
    expected.path,
    constants.O_RDONLY
      | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const [opened, exactBefore] = await Promise.all([
      handle.stat(),
      handle.stat({ bigint: true }),
    ]);
    if (
      !opened.isFile()
      || !exactBefore.isFile()
      || opened.dev !== expected.device
      || opened.ino !== expected.inode
      || opened.size !== expected.bytes
      || opened.mtimeMs !== expected.modifiedAtMs
      || (opened.mode & 0o777) !== 0o400
      || await hashOpenSnapshot(handle, expected.bytes) !== expected.sha256
    ) {
      throw new ApplicationError(
        "conflict",
        "Portable operation input snapshot changed while its descriptor was pinned.",
      );
    }
    const descriptorPath = `/dev/fd/${String(handle.fd)}`;
    const processPath = kind === "transmute.image.vectorize"
      ? "/dev/fd/3"
      : descriptorPath;
    const pinnedInput = kind === "transmute.image.vectorize"
      ? { ...input, inputPath: processPath }
      : { ...input, path: processPath };
    return {
      assertUnchanged: async () => {
        const [exactAfter, namedAfter, sha256] = await Promise.all([
          handle.stat({ bigint: true }),
          lstat(expected.path),
          hashOpenSnapshot(handle, expected.bytes),
        ]);
        if (
          !sameExactSnapshot(exactBefore, exactAfter)
          || namedAfter.isSymbolicLink()
          || !namedAfter.isFile()
          || namedAfter.dev !== expected.device
          || namedAfter.ino !== expected.inode
          || (namedAfter.mode & 0o777) !== 0o400
          || sha256 !== expected.sha256
        ) {
          throw new ApplicationError(
            "ambiguous",
            "Portable operation input snapshot changed during execution; output publication is ambiguous.",
          );
        }
      },
      close: async () => await handle.close(),
      descriptor: handle.fd,
      input: pinnedInput,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function restorePlannedDiagramSource(
  kind: PortableTransmuteOperationKind,
  output: unknown,
  plannedInput: Readonly<Record<string, unknown>>,
): unknown {
  if (
    kind !== "transmute.diagram.render"
    || typeof output !== "object"
    || output === null
    || Array.isArray(output)
  ) return output;
  const outputRecord = output as Readonly<Record<string, unknown>>;
  const artifacts = outputRecord.artifacts;
  if (
    typeof artifacts !== "object"
    || artifacts === null
    || Array.isArray(artifacts)
    || typeof plannedInput.path !== "string"
  ) return output;
  const artifactRecord = artifacts as Readonly<Record<string, unknown>>;
  return {
    ...outputRecord,
    artifacts: { ...artifactRecord, spec: plannedInput.path },
  };
}

/**
 * Resolves portable v2 paths and pins every mutable source to an immutable,
 * content-addressed private file before the scheduler hashes its exact input.
 */
export async function bindTransmutePortableOperationInputV2(
  application: ApplicationContext,
  kind: PortableTransmuteOperationKind,
  inputValue: unknown,
  signal: AbortSignal = new AbortController().signal,
): Promise<unknown> {
  const contract = PORTABLE_TRANSMUTE_OPERATION_CONTRACTS[kind];
  const input = contract.inputSchema.parse(inputValue);
  const repositoryBoundOutput = portableOutputIsRepositoryRelative(
    kind,
    inputRecord(input),
  );
  const resolved = await canonicalizePortableOutputTarget(
    kind,
    resolvePortableOperationPaths(
      application.paths.repositoryRoot,
      kind,
      input,
    ),
    repositoryBoundOutput ? application.paths.repositoryRoot : undefined,
  );
  switch (kind) {
    case "transmute.diagram.check":
      return contract.inputSchema.parse({
        ...resolved,
        path: await snapshotPortableSource(
          application,
          String(resolved.path),
          "diagram",
          MAXIMUM_DIAGRAM_SOURCE_BYTES,
          signal,
        ),
      });
    case "transmute.diagram.render": {
      const sourcePath = String(resolved.path);
      return contract.inputSchema.parse({
        ...resolved,
        // Once the source is moved into private storage, retain the original
        // default output directory explicitly so rendering semantics do not
        // move with it.
        outDirectory: resolved.outDirectory ?? dirname(sourcePath),
        path: await snapshotPortableSource(
          application,
          sourcePath,
          "diagram",
          MAXIMUM_DIAGRAM_SOURCE_BYTES,
          signal,
        ),
      });
    }
    case "transmute.image.vectorize":
      return contract.inputSchema.parse({
        ...resolved,
        inputPath: await snapshotPortableSource(
          application,
          String(resolved.inputPath),
          "vector",
          MAXIMUM_VECTOR_SOURCE_BYTES,
          signal,
        ),
      });
    case "transmute.image.generate":
      return contract.inputSchema.parse(resolved);
  }
}

function contractDiscovery(contract: PortableOperationContract) {
  return {
    inputSchemaId: contract.inputSchemaId,
    kind: contract.kind,
    lifecycle: contract.lifecycle,
    outputSchemaId: contract.outputSchemaId,
    policy: contract.policy,
    version: contract.version,
  } as const;
}

function hasImmutablePolicy(value: {
  readonly policy: {
    readonly preparation: readonly unknown[];
    readonly resources: readonly object[];
  };
}): boolean {
  return Object.isFrozen(value.policy)
    && Object.isFrozen(value.policy.preparation)
    && Object.isFrozen(value.policy.resources)
    && value.policy.resources.every(resource => Object.isFrozen(resource));
}

function assertPortableProjectionIntegrity(): void {
  const contractKinds = Object.keys(PORTABLE_TRANSMUTE_OPERATION_CONTRACTS)
    .sort((left, right) => left.localeCompare(right));
  const portableKinds = [...PORTABLE_TRANSMUTE_OPERATION_KINDS]
    .sort((left, right) => left.localeCompare(right));
  const discoveries = portableOperationContracts
    .map(contractDiscovery)
    .sort((left, right) => (
      left.kind.localeCompare(right.kind) || left.version - right.version
    ));
  if (
    PORTABLE_TRANSMUTE_OPERATION_KINDS.length !== PORTABLE_OPERATION_COUNT
    || !isDeepStrictEqual(contractKinds, portableKinds)
    || !Object.isFrozen(PORTABLE_TRANSMUTE_OPERATION_CONTRACTS)
    || !Object.isFrozen(PUBLIC_WORKFLOW_REGISTRY_PROJECTION)
    || !Object.isFrozen(PUBLIC_WORKFLOW_REGISTRY_PROJECTION.discovery)
    || portableOperationContracts.some(contract => (
      !Object.isFrozen(contract)
      || !hasImmutablePolicy(contract)
    ))
    || PUBLIC_WORKFLOW_REGISTRY_PROJECTION.discovery.some(operation => (
      !Object.isFrozen(operation)
      || !hasImmutablePolicy(operation)
    ))
    || !isDeepStrictEqual(
      discoveries,
      PUBLIC_WORKFLOW_REGISTRY_PROJECTION.discovery,
    )
  ) {
    throw new ApplicationError(
      "incompatible",
      "The shared portable Transmute contracts drifted from their public workflow projection.",
    );
  }
}

async function executePortableOperation(
  context: OperationExecutionContext,
  contract: PortableOperationContract,
  input: unknown,
  dependencies: TransmutePortableOperationDependencies,
): Promise<unknown> {
  const schemaInput = contract.inputSchema.parse(input);
  const pathResolvedInput = resolvePortableOperationPaths(
    context.application.paths.repositoryRoot,
    contract.kind,
    schemaInput,
  );
  const resolvedInput = await canonicalizePortableOutputTarget(
    contract.kind,
    pathResolvedInput,
    portableOutputIsRepositoryRelative(
      contract.kind,
      inputRecord(schemaInput),
    )
      ? context.application.paths.repositoryRoot
      : undefined,
  );
  if (
    portableOutputTarget(contract.kind, pathResolvedInput)
    !== portableOutputTarget(contract.kind, resolvedInput)
  ) {
    throw new ApplicationError(
      "conflict",
      "Portable operation output target is no longer its canonical execution-planned path.",
    );
  }
  const execute = async (): Promise<unknown> => {
    const revalidatedInput = await canonicalizePortableOutputTarget(
      contract.kind,
      resolvedInput,
    );
    if (
      portableOutputTarget(contract.kind, revalidatedInput)
      !== portableOutputTarget(contract.kind, resolvedInput)
    ) {
      throw new ApplicationError(
        "conflict",
        "Portable operation output target changed before dispatch.",
      );
    }
    const pinned = await openPinnedPortableSnapshot(
      context.application,
      contract.kind,
      resolvedInput,
      context.abortSignal,
    );
    try {
      const executionInput = pinned?.input ?? resolvedInput;
      const parsedInput = (dependencies.parseInput ?? parseTransmuteOperationInput)(
        contract.kind,
        executionInput,
      );
      const inheritedFileDescriptors = [
        ...(pinned === undefined ? [] : [pinned.descriptor]),
        ...(context.application.hostResourceLease?.inheritedFileDescriptors ?? []),
      ].filter((descriptor, index, descriptors) => (
        descriptors.indexOf(descriptor) === index
      ));
      const executionDependencies: TransmuteOperationDependencies = {
        signal: context.abortSignal,
        ...(inheritedFileDescriptors.length === 0
          ? {}
          : { inheritedFileDescriptors }),
      };
      const output = context.application.hostResourceLease === undefined
        ? await (dependencies.execute ?? executeTransmuteOperation)(
            contract.kind,
            parsedInput,
            executionDependencies,
          )
        : await (dependencies.executeWithLease ?? executeTransmuteOperationWithLease)(
            contract.kind,
            parsedInput,
            context.application.hostResourceLease,
            executionDependencies,
          );
      await pinned?.assertUnchanged();
      return contract.outputSchema.parse(restorePlannedDiagramSource(
        contract.kind,
        output,
        resolvedInput,
      ));
    } finally {
      await pinned?.close();
    }
  };
  const publicationParent = transmutePortableOutputPublicationParent(
    contract.kind,
    resolvedInput,
  );
  return publicationParent === undefined
    ? await execute()
    : await withPortableOutputPublicationLease(
        context.application,
        publicationParent,
        execute,
      );
}

function createPortableLifecycle(
  contract: PortableOperationContract,
  dependencies: TransmutePortableOperationDependencies,
): OperationLifecycle<unknown, unknown> {
  const execute = async (
    context: OperationExecutionContext,
    input: unknown,
  ): Promise<unknown> => await executePortableOperation(
    context,
    contract,
    input,
    dependencies,
  );
  return {
    execute,
    kind: contract.lifecycle,
  };
}

export function createTransmutePortableOperationDefinitions(
  dependencies: TransmutePortableOperationDependencies = {},
): readonly OperationDefinition[] {
  assertPortableProjectionIntegrity();
  return Object.freeze(portableOperationContracts.map(contract => ({
    inputSchema: contract.inputSchema,
    inputSchemaId: contract.inputSchemaId,
    kind: contract.kind,
    lifecycle: createPortableLifecycle(contract, dependencies),
    outputSchema: contract.outputSchema,
    outputSchemaId: contract.outputSchemaId,
    policy: contract.policy,
    summarize: () => ({ fields: {}, kind: contract.kind }),
    version: contract.version,
  })));
}

export const transmutePortableOperationDefinitions =
  createTransmutePortableOperationDefinitions();
