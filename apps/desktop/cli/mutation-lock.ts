import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { link, lstat, open, opendir, realpath, unlink, type FileHandle } from "node:fs/promises";
import { hostname, uptime } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { CliError } from "./errors";
import { environmentWithoutGatewayCredentials } from "./io";

export const MUTATION_LOCK_FILE = ".transmute-mutation.lock";
export const MUTATION_LOCK_TEMP_PREFIX = `${MUTATION_LOCK_FILE}.acquire-`;

const MAX_OWNER_BYTES = 16_384;
const DEFAULT_STALE_AFTER_MS = 30_000;
const MAX_TEMP_FILES_PER_CLEANUP = 4;
const MAX_DIRECTORY_ENTRIES_PER_CLEANUP = 256;
const BOOT_TIME_SAFETY_MARGIN_MS = 5_000;
const MACOS_LSOF_PATH = "/usr/sbin/lsof";

type ArtifactOpenState = "closed" | "open" | "unknown";

const MutationLockOwnerSchema = z.object({
  acquiredAt: z.string().datetime({ offset: true }),
  command: z.string().min(1).max(512),
  hostname: z.string().min(1).max(255),
  pid: z.number().int().positive(),
  schemaVersion: z.literal(1),
  token: z.string().uuid(),
}).strict();

type MutationLockOwner = z.infer<typeof MutationLockOwnerSchema>;

interface LockSnapshot {
  readonly ctimeMs: number;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly nlink: number;
  readonly size: number;
  readonly uid: number;
}

type ExistingLock =
  | { readonly kind: "malformed"; readonly snapshot: LockSnapshot }
  | { readonly kind: "missing" }
  | { readonly kind: "unsafe" }
  | { readonly kind: "valid"; readonly owner: MutationLockOwner; readonly snapshot: LockSnapshot };

export interface MutationLockOptions {
  readonly command: string;
  readonly legacyArtifactOpenState?: (path: string) => Promise<ArtifactOpenState>;
  readonly label: string;
  readonly now?: () => Date;
  readonly processAlive?: (pid: number) => boolean;
  readonly staleAfterMs?: number;
}

function errno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function snapshotOf(value: {
  readonly ctimeMs: number;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly nlink: number;
  readonly size: number;
  readonly uid: number;
}): LockSnapshot {
  return {
    ctimeMs: value.ctimeMs,
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    mtimeMs: value.mtimeMs,
    nlink: value.nlink,
    size: value.size,
    uid: value.uid,
  };
}

function sameSnapshot(left: LockSnapshot, right: LockSnapshot): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.uid === right.uid
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function ownedPrivateFile(details: {
  isFile(): boolean;
  isSymbolicLink(): boolean;
  readonly mode: number;
  readonly uid: number;
}): boolean {
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return details.isFile()
    && !details.isSymbolicLink()
    && (details.mode & 0o777) === 0o600
    && (expectedUid === undefined || details.uid === expectedUid);
}

async function defaultArtifactOpenState(path: string): Promise<ArtifactOpenState> {
  if (process.platform !== "darwin") return "unknown";
  return await new Promise(resolve => {
    execFile(
      MACOS_LSOF_PATH,
      ["-F", "p", "--", path],
      {
        encoding: "utf8",
        env: environmentWithoutGatewayCredentials(process.env),
        maxBuffer: 32_768,
        timeout: 1_000,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(/^p[0-9]+$/mu.test(stdout) ? "open" : "unknown");
          return;
        }
        if (error.code === 1 && stderr.trim() === "") {
          resolve("closed");
          return;
        }
        resolve("unknown");
      },
    );
  });
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errno(error, "ESRCH")) return false;
    return true;
  }
}

async function physicalBundleDirectory(bundleDirectory: string): Promise<string> {
  let details;
  try {
    details = await lstat(bundleDirectory);
  } catch (error) {
    if (errno(error, "ENOENT")) {
      throw new CliError("not-found", `Mutation target does not exist: ${bundleDirectory}`);
    }
    throw error;
  }
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new CliError("unsafe-path", `Mutation target must be a physical directory: ${bundleDirectory}`);
  }
  return await realpath(bundleDirectory);
}

async function readExistingLock(path: string): Promise<ExistingLock> {
  let pathDetails;
  try {
    pathDetails = await lstat(path);
  } catch (error) {
    if (errno(error, "ENOENT")) return { kind: "missing" };
    throw error;
  }
  if (!ownedPrivateFile(pathDetails) || pathDetails.size > MAX_OWNER_BYTES) return { kind: "unsafe" };
  const pathSnapshot = snapshotOf(pathDetails);
  if (pathDetails.size === 0) return { kind: "malformed", snapshot: pathSnapshot };

  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = snapshotOf(await handle.stat());
    if (!sameSnapshot(pathSnapshot, before)) return { kind: "unsafe" };
    const text = await handle.readFile({ encoding: "utf8" });
    const after = snapshotOf(await handle.stat());
    if (!sameSnapshot(before, after)) return { kind: "unsafe" };
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      return { kind: "malformed", snapshot: after };
    }
    const parsed = MutationLockOwnerSchema.safeParse(value);
    return parsed.success
      ? { kind: "valid", owner: parsed.data, snapshot: after }
      : { kind: "malformed", snapshot: after };
  } catch (error) {
    if (errno(error, "ENOENT")) return { kind: "missing" };
    if (errno(error, "ELOOP")) return { kind: "unsafe" };
    throw error;
  } finally {
    await handle?.close();
  }
}

async function unlinkIfSame(path: string, expected: LockSnapshot): Promise<boolean> {
  let current;
  try {
    current = await lstat(path);
  } catch (error) {
    if (errno(error, "ENOENT")) return true;
    throw error;
  }
  if (current.isSymbolicLink() || !current.isFile()) return false;
  if (!sameSnapshot(snapshotOf(current), expected)) return false;
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if (errno(error, "ENOENT")) return true;
    throw error;
  }
}

async function provablyUnheldLegacyArtifact(
  path: string,
  snapshot: LockSnapshot,
  options: MutationLockOptions,
  now: Date,
): Promise<boolean> {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const ageMs = now.getTime() - Math.max(snapshot.ctimeMs, snapshot.mtimeMs);
  if (ageMs < staleAfterMs) return false;
  const estimatedBootTimeMs = Date.now() - uptime() * 1_000;
  if (snapshot.ctimeMs < estimatedBootTimeMs - BOOT_TIME_SAFETY_MARGIN_MS) return true;
  return await (options.legacyArtifactOpenState ?? defaultArtifactOpenState)(path) === "closed";
}

async function reclaimConflictingLock(
  path: string,
  options: MutationLockOptions,
  now: Date,
): Promise<{ readonly owner: MutationLockOwner | undefined; readonly retry: boolean }> {
  const existing = await readExistingLock(path);
  if (existing.kind === "missing") return { owner: undefined, retry: true };
  if (existing.kind === "unsafe") return { owner: undefined, retry: false };
  if (existing.kind === "malformed") {
    if (
      existing.snapshot.nlink !== 1
      || !await provablyUnheldLegacyArtifact(path, existing.snapshot, options, now)
    ) {
      return { owner: undefined, retry: false };
    }
    return { owner: undefined, retry: await unlinkIfSame(path, existing.snapshot) };
  }
  const ageMs = now.getTime() - Date.parse(existing.owner.acquiredAt);
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  if (
    ageMs < staleAfterMs
    || existing.owner.hostname !== hostname()
    || (options.processAlive ?? defaultProcessAlive)(existing.owner.pid)
  ) {
    return { owner: existing.owner, retry: false };
  }
  return {
    owner: existing.owner,
    retry: await unlinkIfSame(path, existing.snapshot),
  };
}

function busyError(options: MutationLockOptions, owner: MutationLockOwner | undefined): CliError {
  return new CliError(
    "conflict",
    `Another mutation is already in progress for ${options.label}.`,
    {
      ...(owner === undefined ? {} : {
        acquiredAt: owner.acquiredAt,
        command: owner.command,
        hostname: owner.hostname,
        pid: owner.pid,
      }),
      target: options.label,
    },
  );
}

async function discardStagedOwner(path: string, handle: FileHandle): Promise<void> {
  let snapshot: LockSnapshot | undefined;
  try {
    snapshot = snapshotOf(await handle.stat());
  } catch {
    // A unique acquisition temp that cannot be identified is safe to leave for
    // bounded stale-temp cleanup; never unlink an unverified replacement.
  }
  try {
    await handle.close();
  } finally {
    if (snapshot !== undefined) await unlinkIfSame(path, snapshot).catch(() => false);
  }
}

async function stageOwner(
  directory: string,
  owner: MutationLockOwner,
): Promise<{ readonly handle: FileHandle; readonly path: string }> {
  const path = join(directory, `${MUTATION_LOCK_TEMP_PREFIX}${randomUUID()}.tmp`);
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, { encoding: "utf8" });
    await handle.sync();
    return { handle, path };
  } catch (error) {
    await discardStagedOwner(path, handle);
    throw error;
  }
}

function acquisitionTempName(name: string): boolean {
  return name.startsWith(MUTATION_LOCK_TEMP_PREFIX)
    && name.endsWith(".tmp")
    && name.length <= MUTATION_LOCK_TEMP_PREFIX.length + 64;
}

async function cleanupAbandonedAcquisitionTemps(
  directory: string,
  options: MutationLockOptions,
  now: Date,
): Promise<void> {
  let entries;
  try {
    entries = await opendir(directory);
  } catch {
    return;
  }
  let inspectedEntries = 0;
  let matchingEntries = 0;
  try {
    for await (const entry of entries) {
      inspectedEntries += 1;
      if (inspectedEntries > MAX_DIRECTORY_ENTRIES_PER_CLEANUP) break;
      if (!acquisitionTempName(entry.name)) continue;
      matchingEntries += 1;
      if (matchingEntries > MAX_TEMP_FILES_PER_CLEANUP) break;
      const path = join(directory, entry.name);
      let details;
      try {
        details = await lstat(path);
      } catch {
        continue;
      }
      if (
        !ownedPrivateFile(details)
        || details.nlink !== 1
        || details.size > MAX_OWNER_BYTES
      ) {
        continue;
      }
      const snapshot = snapshotOf(details);
      if (await provablyUnheldLegacyArtifact(path, snapshot, options, now)) {
        await unlinkIfSame(path, snapshot).catch(() => false);
      }
    }
  } catch {
    // Temp hygiene must never make an otherwise safe lock acquisition fail.
  } finally {
    try {
      await entries.close();
    } catch {
      // Async directory iteration may already have closed the handle.
    }
  }
}

async function acquire(
  bundleDirectory: string,
  options: MutationLockOptions,
): Promise<{ readonly handle: FileHandle; readonly path: string; readonly snapshot: LockSnapshot }> {
  const directory = await physicalBundleDirectory(bundleDirectory);
  const path = join(directory, MUTATION_LOCK_FILE);
  const now = (options.now ?? (() => new Date()))();
  const owner = MutationLockOwnerSchema.parse({
    acquiredAt: now.toISOString(),
    command: options.command,
    hostname: hostname(),
    pid: process.pid,
    schemaVersion: 1,
    token: randomUUID(),
  });
  await cleanupAbandonedAcquisitionTemps(directory, options, now);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const staged = await stageOwner(directory, owner);
    let claimed = false;
    try {
      await link(staged.path, path);
      claimed = true;
    } catch (error) {
      await discardStagedOwner(staged.path, staged.handle);
      if (!errno(error, "EEXIST")) throw error;
      const conflict = await reclaimConflictingLock(path, options, now);
      if (conflict.retry && attempt < 2) continue;
      throw busyError(options, conflict.owner);
    }
    try {
      await unlink(staged.path).catch(() => undefined);
      const snapshot = snapshotOf(await staged.handle.stat());
      const published = await lstat(path);
      if (!ownedPrivateFile(published) || !sameSnapshot(snapshot, snapshotOf(published))) {
        throw new CliError("unsafe-path", `Published mutation lock changed during acquisition: ${path}`);
      }
      return { handle: staged.handle, path, snapshot };
    } catch (error) {
      const snapshot = snapshotOf(await staged.handle.stat());
      await staged.handle.close().catch(() => undefined);
      if (claimed) await unlinkIfSame(path, snapshot).catch(() => false);
      throw error;
    }
  }
  const existing = await readExistingLock(path);
  throw busyError(options, existing.kind === "valid" ? existing.owner : undefined);
}

export async function withMutationLock<T>(
  bundleDirectory: string,
  options: MutationLockOptions,
  mutate: () => Promise<T>,
): Promise<T> {
  const lease = await acquire(bundleDirectory, options);
  try {
    return await mutate();
  } finally {
    try {
      await lease.handle.close();
    } finally {
      await unlinkIfSame(lease.path, lease.snapshot);
    }
  }
}
