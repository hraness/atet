import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import {
  basename,
  isAbsolute,
  join,
  resolve,
  sep,
} from "node:path";

import { z } from "zod";

import { canonicalJson } from "../core/canonical-json";
import type {
  ApplicationCapability,
  ApplicationCapabilityName,
  ApplicationContext,
  ApplicationProcessRunOptions,
  ApplicationProcessRunResult,
  ApplicationProcessRunner,
} from "./context";
import { ApplicationError } from "./errors";

const MAXIMUM_CAPABILITY_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const CAPABILITY_HASH_BUFFER_BYTES = 1024 * 1024;
const CAPABILITY_PIN_DIRECTORY = "capability-pins-v1";

export const ExactCapabilityBindingSchema = z.strictObject({
  bytes: z.number().int().safe().positive().max(
    MAXIMUM_CAPABILITY_EXECUTABLE_BYTES,
  ),
  command: z.string().min(1).max(4_096).refine(
    command => !command.includes("\0"),
    "Capability commands cannot contain NUL bytes.",
  ),
  executablePath: z.string().min(1).max(4_096).refine(
    path => isAbsolute(path) && !path.includes("\0"),
    "Capability executable paths must be absolute and NUL-free.",
  ),
  executableSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  name: z.string().min(1).max(128),
  version: z.string().min(1).max(512),
});

export const ExactCapabilityBindingsSchema = z.array(
  ExactCapabilityBindingSchema,
).max(32).superRefine((bindings, context) => {
  for (let index = 0; index < bindings.length; index += 1) {
    const previous = bindings[index - 1];
    if (
      previous !== undefined
      && previous.name.localeCompare(bindings[index]!.name) >= 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Exact capability bindings must have unique sorted names.",
        path: [index, "name"],
      });
    }
  }
});

export type ExactCapabilityBinding = z.infer<
  typeof ExactCapabilityBindingSchema
>;

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function resolveExecutable(command: string): Promise<string> {
  const requested = command.includes(sep)
    ? resolve(command)
    : Bun.which(command);
  if (requested === null || requested === "") {
    throw new ApplicationError(
      "unavailable",
      `Capability executable cannot be resolved: ${command}`,
    );
  }
  try {
    return await realpath(requested);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      throw new ApplicationError(
        "unavailable",
        `Capability executable no longer exists: ${command}`,
      );
    }
    throw error;
  }
}

async function hashPhysicalExecutable(
  executablePath: string,
  label: string,
): Promise<{ readonly bytes: number; readonly sha256: string }> {
  let handle;
  try {
    handle = await open(
      executablePath,
      constants.O_RDONLY
        | (constants.O_NOFOLLOW ?? 0)
        | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      throw new ApplicationError(
        "conflict",
        `Capability executable disappeared before use: ${label}`,
      );
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || (before.mode & 0o111) === 0
      || !Number.isSafeInteger(before.size)
      || before.size < 1
      || before.size > MAXIMUM_CAPABILITY_EXECUTABLE_BYTES
    ) {
      throw new ApplicationError(
        "unsafe-path",
        `Capability executable is unsafe, non-executable, or oversized: ${label}`,
      );
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CAPABILITY_HASH_BUFFER_BYTES);
    let offset = 0;
    while (offset < before.size) {
      const result = await handle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, before.size - offset),
        offset,
      );
      if (result.bytesRead === 0) break;
      hash.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    const currentPath = await realpath(executablePath);
    // Deliberately ignore ctime: creating a verified hard link changes only the
    // link-count metadata on the shared inode. The open handle, inode, size,
    // mode, mtime, and complete byte hash remain the executable identity.
    if (
      currentPath !== executablePath
      || offset !== before.size
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mode !== after.mode
      || before.mtimeMs !== after.mtimeMs
    ) {
      throw new ApplicationError(
        "conflict",
        `Capability executable changed while its bytes were verified: ${label}`,
      );
    }
    return {
      bytes: before.size,
      sha256: hash.digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

async function ensurePrivateDirectory(path: string): Promise<string> {
  try {
    await mkdir(path, { mode: 0o700, recursive: true });
  } catch (error) {
    if (!isFileSystemError(error, "EEXIST")) throw error;
  }
  const details = await lstat(path);
  if (
    details.isSymbolicLink()
    || !details.isDirectory()
    || (details.mode & 0o077) !== 0
  ) {
    throw new ApplicationError(
      "unsafe-path",
      `Capability pin directory must be a private physical directory: ${path}`,
    );
  }
  return await realpath(path);
}

async function ensureCapabilityPinDirectory(
  privateRoot: string,
  binding: ExactCapabilityBinding,
): Promise<{
  readonly directory: string;
  readonly pinPath: string;
  readonly root: string;
}> {
  const physicalPrivateRoot = await ensurePrivateDirectory(privateRoot);
  const root = await ensurePrivateDirectory(
    join(physicalPrivateRoot, CAPABILITY_PIN_DIRECTORY),
  );
  const directory = await ensurePrivateDirectory(
    join(root, binding.executableSha256),
  );
  const executableName = basename(binding.executablePath);
  if (
    executableName === ""
    || executableName === "."
    || executableName === ".."
    || executableName.length > 255
  ) {
    throw new ApplicationError(
      "unsafe-path",
      `Capability executable has an unsafe leaf name: ${binding.name}`,
    );
  }
  return {
    directory,
    pinPath: join(directory, executableName),
    root,
  };
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function verifyPinnedExecutable(
  path: string,
  binding: ExactCapabilityBinding,
): Promise<void> {
  const lexical = await lstat(path);
  if (
    lexical.isSymbolicLink()
    || !lexical.isFile()
    || (lexical.mode & 0o777) !== 0o500
  ) {
    throw new ApplicationError(
      "unsafe-path",
      `Pinned capability executable is not immutable and private: ${binding.name}`,
    );
  }
  const identity = await hashPhysicalExecutable(
    path,
    `pinned ${binding.name}`,
  );
  if (
    identity.bytes !== binding.bytes
    || identity.sha256 !== binding.executableSha256
  ) {
    throw new ApplicationError(
      "conflict",
      `Pinned capability executable does not match its exact binding: ${binding.name}`,
    );
  }
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array,
  position: number,
): Promise<void> {
  let written = 0;
  while (written < bytes.byteLength) {
    const result = await handle.write(
      bytes,
      written,
      bytes.byteLength - written,
      position + written,
    );
    if (result.bytesWritten === 0) {
      throw new ApplicationError(
        "internal",
        "Capability pin write made no progress.",
      );
    }
    written += result.bytesWritten;
  }
}

/**
 * Copies the exact opened executable descriptor into a trusted private path.
 * A rename-over of the original pathname after it is opened cannot alter the
 * bytes copied or the pathname ultimately delegated for execution.
 */
async function materializePinnedExecutable(
  privateRoot: string,
  binding: ExactCapabilityBinding,
): Promise<string> {
  const pin = await ensureCapabilityPinDirectory(privateRoot, binding);
  const source = await open(
    binding.executablePath,
    constants.O_RDONLY
      | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_NONBLOCK ?? 0),
  );
  const temporaryPath = join(
    pin.root,
    `.pin-${binding.executableSha256}-${randomUUID()}`,
  );
  let temporary:
    | Awaited<ReturnType<typeof open>>
    | undefined;
  try {
    const before = await source.stat();
    if (
      !before.isFile()
      || (before.mode & 0o111) === 0
      || before.size !== binding.bytes
    ) {
      throw new ApplicationError(
        "conflict",
        `Capability executable metadata changed before pinning: ${binding.name}`,
      );
    }

    try {
      await verifyPinnedExecutable(pin.pinPath, binding);
      // The source itself must still match the binding on every launch, even
      // when its already-materialized private pin can be reused.
      const sourceHash = createHash("sha256");
      const sourceBuffer = Buffer.allocUnsafe(
        CAPABILITY_HASH_BUFFER_BYTES,
      );
      let sourceOffset = 0;
      while (sourceOffset < before.size) {
        const result = await source.read(
          sourceBuffer,
          0,
          Math.min(
            sourceBuffer.byteLength,
            before.size - sourceOffset,
          ),
          sourceOffset,
        );
        if (result.bytesRead === 0) break;
        sourceHash.update(
          sourceBuffer.subarray(0, result.bytesRead),
        );
        sourceOffset += result.bytesRead;
      }
      const after = await source.stat();
      if (
        sourceOffset !== binding.bytes
        || sourceHash.digest("hex") !== binding.executableSha256
        || before.dev !== after.dev
        || before.ino !== after.ino
        || before.size !== after.size
        || before.mode !== after.mode
        || before.mtimeMs !== after.mtimeMs
      ) {
        throw new ApplicationError(
          "conflict",
          `Capability executable bytes changed before subprocess launch: ${binding.name}`,
        );
      }
      return pin.pinPath;
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    }

    temporary = await open(
      temporaryPath,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_WRONLY
        | (constants.O_NOFOLLOW ?? 0),
      0o700,
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CAPABILITY_HASH_BUFFER_BYTES);
    let offset = 0;
    while (offset < before.size) {
      const result = await source.read(
        buffer,
        0,
        Math.min(buffer.byteLength, before.size - offset),
        offset,
      );
      if (result.bytesRead === 0) break;
      const chunk = buffer.subarray(0, result.bytesRead);
      hash.update(chunk);
      await writeAll(temporary, chunk, offset);
      offset += result.bytesRead;
    }
    const after = await source.stat();
    if (
      offset !== binding.bytes
      || hash.digest("hex") !== binding.executableSha256
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mode !== after.mode
      || before.mtimeMs !== after.mtimeMs
    ) {
      throw new ApplicationError(
        "conflict",
        `Capability executable changed while its private pin was created: ${binding.name}`,
      );
    }
    await temporary.sync();
    await temporary.chmod(0o500);
    await temporary.sync();
    await temporary.close();
    temporary = undefined;

    try {
      await link(temporaryPath, pin.pinPath);
      await unlink(temporaryPath);
      await syncDirectory(pin.directory);
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) throw error;
      await unlink(temporaryPath);
    }
    await verifyPinnedExecutable(pin.pinPath, binding);
    return pin.pinPath;
  } finally {
    await source.close();
    if (temporary !== undefined) {
      await temporary.close().catch(() => undefined);
    }
    await unlink(temporaryPath).catch(error => {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    });
  }
}

export async function bindExactCapability(
  capability: ApplicationCapability,
): Promise<ExactCapabilityBinding> {
  if (
    !capability.available
    || capability.command === undefined
    || capability.command === ""
  ) {
    throw new ApplicationError(
      "unavailable",
      `${capability.name} is unavailable: ${
        capability.reason ?? "capability was not probed"
      }`,
      { capability: capability.name },
    );
  }
  const executablePath = await resolveExecutable(capability.command);
  const identity = await hashPhysicalExecutable(
    executablePath,
    capability.name,
  );
  return ExactCapabilityBindingSchema.parse({
    bytes: identity.bytes,
    command: capability.command,
    executablePath,
    executableSha256: identity.sha256,
    name: capability.name,
    version: capability.version ?? "unknown",
  });
}

export async function bindExactCapabilities(
  application: ApplicationContext,
  names: readonly ApplicationCapabilityName[],
): Promise<readonly ExactCapabilityBinding[]> {
  const uniqueNames = [...new Set(names)].sort();
  const bound = await Promise.all(uniqueNames.map(async name => {
    const capability = await application.capability(name);
    if (capability.name !== name) {
      throw new ApplicationError(
        "internal",
        `Capability resolver returned ${capability.name} when ${name} was requested.`,
        { requestedCapability: name, returnedCapability: capability.name },
      );
    }
    return await bindExactCapability(capability);
  }));
  return ExactCapabilityBindingsSchema.parse(bound);
}

export async function assertExactCapabilityBindings(
  application: ApplicationContext,
  expected: readonly ExactCapabilityBinding[],
  names: readonly ApplicationCapabilityName[],
): Promise<void> {
  const current = await bindExactCapabilities(application, names);
  if (canonicalJson(expected) !== canonicalJson(current)) {
    throw new ApplicationError(
      "conflict",
      "A capability executable, path, bytes, command, or version changed after exact node planning.",
    );
  }
}

/**
 * Revalidates one already-bound executable directly from its physical path.
 * Use this at effect boundaries that cannot delegate through
 * ExactCapabilityApplicationRunner, such as a browser automation library.
 */
export async function assertExactCapabilityExecutable(
  expected: ExactCapabilityBinding,
): Promise<void> {
  const binding = ExactCapabilityBindingSchema.parse(expected);
  const current = await hashPhysicalExecutable(
    binding.executablePath,
    binding.name,
  );
  if (
    current.bytes !== binding.bytes
    || current.sha256 !== binding.executableSha256
  ) {
    throw new ApplicationError(
      "conflict",
      `Capability executable bytes changed before launch: ${binding.name}`,
    );
  }
}

export function exactCapabilityByName(
  bindings: readonly ExactCapabilityBinding[],
  name: string,
): ExactCapabilityBinding {
  const binding = bindings.find(candidate => candidate.name === name);
  if (binding === undefined) {
    throw new ApplicationError(
      "internal",
      `Required exact capability was not bound: ${name}`,
    );
  }
  return binding;
}

/**
 * Revalidates the exact executable bytes immediately before each delegated
 * subprocess launch. A verified private content-addressed pin, rather than
 * the mutable probed pathname or PATH alias, is forwarded to the runner.
 */
export class ExactCapabilityApplicationRunner
implements ApplicationProcessRunner {
  readonly #bindings: readonly ExactCapabilityBinding[];
  readonly #privateRoot: string;
  readonly #runner: ApplicationProcessRunner;

  constructor(
    runner: ApplicationProcessRunner,
    bindings: readonly ExactCapabilityBinding[],
    privateRoot: string,
  ) {
    this.#runner = runner;
    this.#bindings = ExactCapabilityBindingsSchema.parse(bindings);
    if (!isAbsolute(privateRoot) || privateRoot.includes("\0")) {
      throw new ApplicationError(
        "unsafe-path",
        "Capability pin root must be an absolute NUL-free path.",
      );
    }
    this.#privateRoot = privateRoot;
  }

  async run(
    argv: readonly [string, ...string[]],
    options?: ApplicationProcessRunOptions,
  ): Promise<ApplicationProcessRunResult> {
    const binding = this.#bindings.find(candidate => (
      argv[0] === candidate.command
      || argv[0] === candidate.executablePath
    ));
    if (binding === undefined) {
      throw new ApplicationError(
        "conflict",
        `Exact capability runner rejected an unbound executable: ${argv[0]}`,
      );
    }
    const pinnedExecutable = await materializePinnedExecutable(
      this.#privateRoot,
      binding,
    );
    return await this.#runner.run(
      [pinnedExecutable, ...argv.slice(1)],
      options,
    );
  }
}
