import { createHash, randomUUID } from "node:crypto";
import { constants, watch, type FSWatcher } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

import { z } from "zod";

import {
  chromium,
  type Browser,
  type JSHandle,
  type LaunchOptions,
  type Page,
  type Route,
} from "playwright-core";

import type {
  BoundHtmlOverlayResource,
  HtmlOverlayFrameRenderRequest,
  HtmlOverlayFrameRenderResult,
  HtmlOverlayRenderer,
} from "../application/html-overlay-renderer";
import { ApplicationError } from "../application/errors";
import {
  assertHtmlOverlayBrowserRuntimeManifest,
  inspectSupportedHtmlOverlayMacBrowserProvenance,
  inspectHtmlOverlayBrowserRuntime,
  type HtmlOverlayBrowserRuntimeBinding,
  type HtmlOverlayBrowserRuntimeEntry,
} from "../application/html-overlay-browser-runtime";
import {
  HTML_OVERLAY_RENDERER_CONTRACT,
  createHtmlOverlayExecutionBundle,
} from "../application/html-overlay-integrity";
import { canonicalJson } from "../core/canonical-json";
import {
  createHtmlOverlayRuntimeFrame,
  htmlOverlayAssetLocalUrl,
  htmlOverlayFrameCount,
  htmlOverlayLibraryLocalUrl,
  type HtmlOverlayLibraryLock,
  type HtmlOverlayRuntimeFrame,
} from "../html-overlay";
import { BunProcessRunner, type RunResult } from "./io";

const DOCUMENT_URL = HTML_OVERLAY_RENDERER_CONTRACT.documentUrl;
const SYNTHETIC_ORIGIN = new URL(DOCUMENT_URL).origin;
const MAXIMUM_DIAGNOSTICS = 32;
const MAXIMUM_DIAGNOSTIC_LENGTH = 1_000;
const MAXIMUM_LIBRARY_BYTES = 4 * 1024 * 1024;
const DEFAULT_BROWSER_STEP_TIMEOUT_MS = 60_000;
const MAXIMUM_BROWSER_STEP_TIMEOUT_MS = 5 * 60_000;
const BROWSER_CLEANUP_TIMEOUT_MS = 30_000;
const BROWSER_RUNTIME_FLAGS_TIMEOUT_MS = 60_000;
const BROWSER_RUNTIME_FLAGS_MAXIMUM_OUTPUT_BYTES = 16 * 1024;
const MACOS_BROWSER_RUNTIME_SNAPSHOT_ANCHOR = "/private/tmp";
const BROWSER_RUNTIME_SNAPSHOT_PREFIX = ".transmute-browser-runtime-";
const BROWSER_RUNTIME_SNAPSHOT_NAME = /^\.transmute-browser-runtime-[A-Za-z0-9]{6}$/u;
const BROWSER_RUNTIME_SNAPSHOT_RECLAIM_PREFIX = ".transmute-browser-reclaim-";
const BROWSER_RUNTIME_SNAPSHOT_RECLAIM_NAME = /^\.transmute-browser-reclaim-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const BROWSER_RUNTIME_SNAPSHOT_LEASE_FILE = ".transmute-runtime-lease.json";
const BROWSER_RUNTIME_SNAPSHOT_LEASE_MAXIMUM_BYTES = 4 * 1024;
const BROWSER_RUNTIME_SNAPSHOT_STALE_AFTER_MS = 5 * 60_000;
const BROWSER_RUNTIME_SNAPSHOT_MAXIMUM_SCAN_ENTRIES = 4_096;
const BROWSER_RUNTIME_SNAPSHOT_MAXIMUM_CANDIDATES = 64;
const BROWSER_RUNTIME_SNAPSHOT_MAXIMUM_OPEN_STATE_PROBES = 4;
const BROWSER_RUNTIME_SNAPSHOT_MAXIMUM_RECLAIMS = 4;

const BrowserRuntimeSnapshotLeaseBase = {
  acquiredAt: z.string().datetime({ offset: true }),
  hostname: z.string().min(1).max(255),
  pid: z.number().int().positive(),
  schemaVersion: z.literal(1),
  token: z.string().uuid(),
} as const;
const BrowserRuntimeSnapshotLeaseSchema = z.discriminatedUnion("state", [
  z.strictObject({
    ...BrowserRuntimeSnapshotLeaseBase,
    state: z.literal("active"),
  }),
  z.strictObject({
    ...BrowserRuntimeSnapshotLeaseBase,
    releasedAt: z.string().datetime({ offset: true }),
    state: z.literal("released"),
  }),
]);
type BrowserRuntimeSnapshotLease = Readonly<
  z.infer<typeof BrowserRuntimeSnapshotLeaseSchema>
>;

interface HtmlOverlayHostController {
  renderFrame(frame: HtmlOverlayRuntimeFrame): Promise<void>;
  securityViolationCount(): number;
}

interface PreparedRoute {
  readonly body: Buffer;
  readonly contentType: string;
}

export interface PlaywrightHtmlOverlayRendererOptions {
  readonly browserStepTimeoutMs?: number;
  readonly cacheRoot: string;
  readonly fetch?: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  readonly frameTimeoutMs?: number;
  readonly launch?: (options: LaunchOptions) => Promise<Browser>;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function boundedDiagnostic(value: string): string {
  return value.replaceAll(/\s+/gu, " ").trim().slice(0, MAXIMUM_DIAGNOSTIC_LENGTH);
}

function cancellationReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new ApplicationError(
        "cancelled",
        "HTML overlay browser rendering was cancelled.",
      );
}

export async function boundedBrowserStep<T>(
  start: () => Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  label: string,
  onLateSuccess?: (value: T) => Promise<void> | void,
): Promise<T> {
  if (signal.aborted) throw cancellationReason(signal);
  const task = start();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener = (): void => undefined;
  const stopWaiting = (): void => {
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = undefined;
    removeAbortListener();
    removeAbortListener = (): void => undefined;
  };
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new ApplicationError(
        "unavailable",
        `HTML overlay browser ${label} exceeded ${String(timeoutMs)}ms.`,
      ));
    }, timeoutMs);
  });
  const cancelled = new Promise<never>((_, reject) => {
    const onAbort = (): void => reject(cancellationReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([cancelled, task, timedOut]);
  } catch (error) {
    stopWaiting();
    if (onLateSuccess !== undefined) {
      let cleanupTimeout: ReturnType<typeof setTimeout> | undefined;
      const lateCleanup = task.then(
        async value => await onLateSuccess(value),
        () => undefined,
      );
      try {
        await Promise.race([
          lateCleanup,
          new Promise<void>(resolve => {
            cleanupTimeout = setTimeout(resolve, timeoutMs);
          }),
        ]);
      } finally {
        if (cleanupTimeout !== undefined) clearTimeout(cleanupTimeout);
      }
    }
    throw error;
  } finally {
    stopWaiting();
  }
}

async function htmlWithHostImports(
  page: Page,
  html: string,
  importMap: Readonly<{ readonly imports: Readonly<Record<string, string>> }>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string> {
  const authoredMaps = await boundedBrowserStep(
    async () => await page.evaluate((authoredHtml) => {
      const document = new DOMParser().parseFromString(
        authoredHtml,
        "text/html",
      );
      return [...document.querySelectorAll("script")]
        .filter(script => (
          script.getAttribute("type")?.trim().toLowerCase() === "importmap"
        ))
        .map(script => script.textContent ?? "");
    }, html),
    signal,
    timeoutMs,
    "authored document parsing",
  );
  if (authoredMaps.length > 1) {
    throw new ApplicationError("invalid-data", "HTML overlays may declare at most one import map.");
  }
  if (authoredMaps.length === 1) {
    let authored: unknown;
    try {
      authored = JSON.parse(authoredMaps[0]!);
    } catch {
      throw new ApplicationError("invalid-data", "The authored HTML overlay import map is invalid JSON.");
    }
    if (canonicalJson(authored) !== canonicalJson(importMap)) {
      throw new ApplicationError(
        "invalid-data",
        "The authored import map must exactly match the overlay's approved library selection.",
      );
    }
  }
  return await boundedBrowserStep(
    async () => await page.evaluate((input) => {
      const document = new DOMParser().parseFromString(input.html, "text/html");
      for (const script of document.querySelectorAll("script")) {
        if (
          script.getAttribute("type")?.trim().toLowerCase() === "importmap"
        ) {
          script.remove();
        }
      }
      const map = document.createElement("script");
      map.type = "importmap";
      map.textContent = JSON.stringify(input.importMap);
      const style = document.createElement("style");
      style.textContent = [
        ":root { color-scheme: light; }",
        "html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }",
        "*, *::before, *::after { box-sizing: border-box; }",
      ].join("\\n");
      document.head.prepend(style);
      document.head.prepend(map);
      return `<!doctype html>${document.documentElement.outerHTML}`;
    }, { html, importMap }),
    signal,
    timeoutMs,
    "host document preparation",
  );
}

async function ensurePrivateCacheRoot(path: string): Promise<string> {
  await mkdir(path, { mode: 0o700, recursive: true });
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isDirectory() || (details.mode & 0o077) !== 0) {
    throw new ApplicationError(
      "unsafe-path",
      "The HTML-overlay module cache must be a private physical directory.",
    );
  }
  return path;
}

function isFileSystemError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

async function assertPathAbsent(path: string, label: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return;
    throw error;
  }
  throw new ApplicationError(
    "conflict",
    `${label} already exists; Transmute will not replace it.`,
  );
}

interface PreparedBrowserRuntimeSnapshot {
  readonly anchorIdentity: SnapshotAnchorIdentity;
  readonly anchorPath: string;
  readonly browserHome: string;
  readonly browserTemporaryDirectory: string;
  readonly containerChildren: readonly SnapshotDirectChildIdentity[];
  readonly containerIdentity: SnapshotPathIdentity;
  readonly directory: string;
  readonly executablePath: string;
  readonly identity: readonly SnapshotPathIdentity[];
  readonly lease: BrowserRuntimeSnapshotLease;
  readonly leaseHandle: FileHandle;
  readonly leaseIdentity: SnapshotLeaseFileIdentity;
  readonly runtimeEntries: readonly HtmlOverlayBrowserRuntimeEntry[];
  readonly runtimeImmutable: boolean;
  readonly runtimeRoot: string;
}

interface SnapshotAnchorIdentity {
  readonly dev: string;
  readonly gid: string;
  readonly ino: string;
  readonly mode: number;
  readonly path: string;
  readonly uid: string;
}

interface SnapshotPathIdentity {
  readonly ctimeNs: string;
  readonly dev: string;
  readonly ino: string;
  readonly mode: number;
  readonly path: string;
  readonly size: string;
}

interface SnapshotDirectChildIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly kind: "directory" | "file" | "other" | "symlink";
  readonly mode: number;
  readonly name: string;
}

function sameSnapshotPathNodeIdentity(
  left: SnapshotPathIdentity,
  right: SnapshotPathIdentity,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size;
}

function snapshotEntryPath(
  runtimeRoot: string,
  entryPath: string,
): string {
  return entryPath === "."
    ? runtimeRoot
    : join(runtimeRoot, ...entryPath.split("/"));
}

async function copyRuntimeEntry(
  sourceRoot: string,
  runtimeRoot: string,
  entry: HtmlOverlayBrowserRuntimeEntry,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw cancellationReason(signal);
  const source = snapshotEntryPath(sourceRoot, entry.path);
  const destination = snapshotEntryPath(runtimeRoot, entry.path);
  if (entry.kind === "directory") {
    // Keep directories writable while descendants are materialized. Exact
    // source modes are restored from the leaves upward after the copy.
    await mkdir(destination, { mode: 0o700 });
    if (signal.aborted) throw cancellationReason(signal);
    return;
  }
  if (entry.kind === "symlink") {
    await symlink(entry.target, destination);
    if (signal.aborted) throw cancellationReason(signal);
    const copied = await lstat(destination);
    if (!copied.isSymbolicLink()) {
      throw new ApplicationError("conflict", "Browser runtime symlink copy failed.");
    }
    return;
  }
  const sourceHandle = await open(
    source,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let destinationHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const sourceBefore = await sourceHandle.stat();
    if (
      !sourceBefore.isFile()
      || sourceBefore.size !== entry.bytes
      || (sourceBefore.mode & 0o7777) !== entry.mode
    ) {
      throw new ApplicationError(
        "conflict",
        `Browser runtime file changed before snapshot copy: ${entry.path}`,
      );
    }
    destinationHandle = await open(
      destination,
      constants.O_CREAT
        | constants.O_EXCL
        | constants.O_WRONLY
        | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
    let offset = 0;
    while (offset < sourceBefore.size) {
      if (signal.aborted) throw cancellationReason(signal);
      const result = await sourceHandle.read(
        buffer,
        0,
        Math.min(buffer.byteLength, sourceBefore.size - offset),
        offset,
      );
      if (result.bytesRead === 0) {
        throw new ApplicationError(
          "conflict",
          `Browser runtime file ended during snapshot copy: ${entry.path}`,
        );
      }
      let written = 0;
      while (written < result.bytesRead) {
        if (signal.aborted) throw cancellationReason(signal);
        const writeResult = await destinationHandle.write(
          buffer,
          written,
          result.bytesRead - written,
          offset + written,
        );
        if (writeResult.bytesWritten === 0) {
          throw new ApplicationError("internal", "Browser runtime snapshot copy made no progress.");
        }
        written += writeResult.bytesWritten;
      }
      offset += result.bytesRead;
    }
    const sourceAfter = await sourceHandle.stat();
    if (
      sourceBefore.dev !== sourceAfter.dev
      || sourceBefore.ino !== sourceAfter.ino
      || sourceBefore.size !== sourceAfter.size
      || sourceBefore.mode !== sourceAfter.mode
      || sourceBefore.mtimeMs !== sourceAfter.mtimeMs
    ) {
      throw new ApplicationError(
        "conflict",
        `Browser runtime file changed during snapshot copy: ${entry.path}`,
      );
    }
    await destinationHandle.chmod(entry.mode);
  } finally {
    await destinationHandle?.close().catch(() => undefined);
    await sourceHandle.close();
  }
}

async function captureBrowserRuntimeSnapshotIdentity(
  runtimeRoot: string,
  entries: readonly HtmlOverlayBrowserRuntimeEntry[],
  signal: AbortSignal,
): Promise<readonly SnapshotPathIdentity[]> {
  const identities: SnapshotPathIdentity[] = [];
  for (const entry of entries) {
    if (signal.aborted) throw cancellationReason(signal);
    const details = await lstat(snapshotEntryPath(runtimeRoot, entry.path), {
      bigint: true,
    });
    identities.push({
      ctimeNs: details.ctimeNs.toString(),
      dev: details.dev.toString(),
      ino: details.ino.toString(),
      mode: Number(details.mode & 0o177777n),
      path: entry.path,
      size: details.size.toString(),
    });
  }
  return identities;
}

async function captureBrowserRuntimeSnapshotContainerIdentity(
  directory: string,
  signal: AbortSignal,
): Promise<SnapshotPathIdentity> {
  if (signal.aborted) throw cancellationReason(signal);
  const details = await lstat(directory, { bigint: true });
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new ApplicationError(
      "conflict",
      "The private browser runtime snapshot container is no longer a physical directory.",
    );
  }
  return {
    ctimeNs: details.ctimeNs.toString(),
    dev: details.dev.toString(),
    ino: details.ino.toString(),
    mode: Number(details.mode & 0o177777n),
    path: "<snapshot-container>",
    size: details.size.toString(),
  };
}

async function captureBrowserRuntimeSnapshotDirectChildren(
  directory: string,
  signal: AbortSignal,
): Promise<readonly SnapshotDirectChildIdentity[]> {
  if (signal.aborted) throw cancellationReason(signal);
  const names = (await readdir(directory)).sort();
  const identities: SnapshotDirectChildIdentity[] = [];
  for (const name of names) {
    if (signal.aborted) throw cancellationReason(signal);
    const details = await lstat(join(directory, name), { bigint: true });
    identities.push({
      dev: details.dev.toString(),
      ino: details.ino.toString(),
      kind: details.isSymbolicLink()
        ? "symlink"
        : details.isDirectory()
          ? "directory"
          : details.isFile() ? "file" : "other",
      mode: Number(details.mode & 0o177777n),
      name,
    });
  }
  return Object.freeze(identities);
}

async function inspectBrowserRuntimeSnapshotAnchor(
  path: string,
  requireRootOwnedStickyAnchor: boolean,
  signal: AbortSignal,
): Promise<SnapshotAnchorIdentity> {
  if (signal.aborted) throw cancellationReason(signal);
  const [details, physicalPath] = await Promise.all([
    lstat(path, { bigint: true }),
    realpath(path),
  ]);
  if (
    details.isSymbolicLink()
    || !details.isDirectory()
    || physicalPath !== path
  ) {
    throw new ApplicationError(
      "unsafe-path",
      "The browser runtime snapshot anchor must be a physical directory.",
    );
  }
  if (
    requireRootOwnedStickyAnchor
    && (
      details.uid !== 0n
      || (details.mode & 0o1000n) === 0n
      || (details.mode & 0o002n) === 0n
    )
  ) {
    throw new ApplicationError(
      "unsafe-path",
      "The macOS browser runtime snapshot anchor must be root-owned, sticky, and world-writable.",
    );
  }
  return {
    dev: details.dev.toString(),
    gid: details.gid.toString(),
    ino: details.ino.toString(),
    mode: Number(details.mode & 0o177777n),
    path,
    uid: details.uid.toString(),
  };
}

async function browserRuntimeSnapshotAnchor(
  cacheRootInput: string,
  signal: AbortSignal,
): Promise<SnapshotAnchorIdentity> {
  if (process.platform === "darwin") {
    return await inspectBrowserRuntimeSnapshotAnchor(
      MACOS_BROWSER_RUNTIME_SNAPSHOT_ANCHOR,
      true,
      signal,
    );
  }
  return await inspectBrowserRuntimeSnapshotAnchor(
    await ensurePrivateCacheRoot(cacheRootInput),
    false,
    signal,
  );
}

async function assertBrowserRuntimeSnapshotIdentity(
  snapshot: PreparedBrowserRuntimeSnapshot,
  entries: readonly HtmlOverlayBrowserRuntimeEntry[],
  label: string,
  signal: AbortSignal,
): Promise<void> {
  const current = await captureBrowserRuntimeSnapshotIdentity(
    snapshot.runtimeRoot,
    entries,
    signal,
  );
  const rootHasLaunchManagedCtime = snapshot.runtimeImmutable
    && entries[0]?.kind === "directory";
  const comparable = (entry: SnapshotPathIdentity | undefined) => (
    rootHasLaunchManagedCtime && entry?.path === "."
      ? { ...entry, ctimeNs: "macos-launch-managed" }
      : entry
  );
  if (
    canonicalJson(current.map(comparable))
    !== canonicalJson(snapshot.identity.map(comparable))
  ) {
    const changedIndex = current.findIndex((entry, index) => (
      canonicalJson(comparable(entry))
      !== canonicalJson(comparable(snapshot.identity[index]))
    ));
    const changed = changedIndex === -1 ? undefined : current[changedIndex];
    throw new ApplicationError(
      "conflict",
      `Browser runtime snapshot identity changed ${label}${changed === undefined ? "" : ` at ${changed.path}`}; refusing to accept the render.`,
      {
        after: changed,
        before: changedIndex === -1 ? undefined : snapshot.identity[changedIndex],
      },
    );
  }
}

async function assertBrowserRuntimeSnapshotContainerIdentity(
  snapshot: PreparedBrowserRuntimeSnapshot,
  label: string,
  signal: AbortSignal,
): Promise<void> {
  const current = await captureBrowserRuntimeSnapshotContainerIdentity(
    snapshot.directory,
    signal,
  );
  if (canonicalJson(current) !== canonicalJson(snapshot.containerIdentity)) {
    throw new ApplicationError(
      "conflict",
      `Browser runtime snapshot container identity changed ${label}; refusing to accept the render.`,
      { after: current, before: snapshot.containerIdentity },
    );
  }
}

async function assertBrowserRuntimeSnapshotAnchorIdentity(
  snapshot: PreparedBrowserRuntimeSnapshot,
  label: string,
  signal: AbortSignal,
): Promise<void> {
  const current = await inspectBrowserRuntimeSnapshotAnchor(
    snapshot.anchorPath,
    process.platform === "darwin",
    signal,
  );
  if (canonicalJson(current) !== canonicalJson(snapshot.anchorIdentity)) {
    throw new ApplicationError(
      "conflict",
      `Browser runtime snapshot anchor identity changed ${label}; refusing to accept the render.`,
      { after: current, before: snapshot.anchorIdentity },
    );
  }
}

interface SnapshotLeaseFileIdentity {
  readonly ctimeMs: number;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly nlink: number;
  readonly size: number;
  readonly uid: number;
}

export type SnapshotTreeOpenState = "closed" | "open" | "unknown";

export interface BrowserRuntimeSnapshotScavengeOptions {
  readonly anchorPath: string;
  readonly currentUid?: number;
  readonly now?: () => Date;
  readonly processAlive?: (pid: number) => boolean;
  readonly releaseAndRemove?: (path: string) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly staleAfterMs?: number;
  readonly treeOpenState?: (
    path: string,
    signal: AbortSignal,
  ) => Promise<SnapshotTreeOpenState>;
}

function snapshotLeaseFileIdentity(details: {
  readonly ctimeMs: number;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly mtimeMs: number;
  readonly nlink: number;
  readonly size: number;
  readonly uid: number;
}): SnapshotLeaseFileIdentity {
  return {
    ctimeMs: details.ctimeMs,
    dev: details.dev,
    ino: details.ino,
    mode: details.mode,
    mtimeMs: details.mtimeMs,
    nlink: details.nlink,
    size: details.size,
    uid: details.uid,
  };
}

function sameSnapshotLeaseFileIdentity(
  left: SnapshotLeaseFileIdentity,
  right: SnapshotLeaseFileIdentity,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameSnapshotLeaseNodeIdentity(
  left: SnapshotLeaseFileIdentity,
  right: SnapshotLeaseFileIdentity,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.uid === right.uid;
}

function defaultSnapshotOwnerProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isFileSystemError(error, "ESRCH");
  }
}

export function classifySnapshotTreeOpenStateResult(
  result: Readonly<Pick<RunResult, "exitCode" | "stderr" | "stdout">>,
): SnapshotTreeOpenState {
  if (/^p[0-9]+$/mu.test(result.stdout)) return "open";
  return result.exitCode === 1
    && result.stdout.trim() === ""
    && result.stderr.trim() === ""
    ? "closed"
    : "unknown";
}

async function defaultSnapshotTreeOpenState(
  path: string,
  signal: AbortSignal,
): Promise<SnapshotTreeOpenState> {
  if (process.platform !== "darwin") return "unknown";
  if (signal.aborted) throw cancellationReason(signal);
  try {
    const result = await new BunProcessRunner().run([
      "/usr/sbin/lsof",
      "-Fp",
      "+D",
      path,
    ], {
      abortSignal: signal,
      env: {
        LANG: "C",
        LC_ALL: "C",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      },
      maxOutputBytes: 32 * 1024,
      stdin: "ignore",
      timeoutMs: 5_000,
    });
    if (signal.aborted) throw cancellationReason(signal);
    return classifySnapshotTreeOpenStateResult(result);
  } catch {
    if (signal.aborted) throw cancellationReason(signal);
    return "unknown";
  }
}

async function readBrowserRuntimeSnapshotLease(
  candidate: string,
  expectedUid: number,
): Promise<Readonly<{
  directoryIdentity: SnapshotLeaseFileIdentity;
  lease: BrowserRuntimeSnapshotLease;
  leaseIdentity: SnapshotLeaseFileIdentity;
}> | undefined> {
  const directoryDetails = await lstat(candidate);
  if (
    directoryDetails.isSymbolicLink()
    || !directoryDetails.isDirectory()
    || directoryDetails.uid !== expectedUid
    || (directoryDetails.mode & 0o777) !== 0o700
    || await realpath(candidate) !== candidate
  ) return undefined;
  const leasePath = join(candidate, BROWSER_RUNTIME_SNAPSHOT_LEASE_FILE);
  const leaseDetails = await lstat(leasePath);
  if (
    leaseDetails.isSymbolicLink()
    || !leaseDetails.isFile()
    || leaseDetails.uid !== expectedUid
    || leaseDetails.nlink !== 1
    || (leaseDetails.mode & 0o777) !== 0o600
    || leaseDetails.size < 1
    || leaseDetails.size > BROWSER_RUNTIME_SNAPSHOT_LEASE_MAXIMUM_BYTES
  ) return undefined;
  const leaseIdentity = snapshotLeaseFileIdentity(leaseDetails);
  const handle = await open(
    leasePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = snapshotLeaseFileIdentity(await handle.stat());
    if (!sameSnapshotLeaseFileIdentity(leaseIdentity, before)) return undefined;
    const text = await handle.readFile({ encoding: "utf8" });
    const after = snapshotLeaseFileIdentity(await handle.stat());
    if (!sameSnapshotLeaseFileIdentity(before, after)) return undefined;
    const parsed = BrowserRuntimeSnapshotLeaseSchema.safeParse(
      JSON.parse(text) as unknown,
    );
    if (!parsed.success) return undefined;
    return {
      directoryIdentity: snapshotLeaseFileIdentity(directoryDetails),
      lease: parsed.data,
      leaseIdentity: after,
    };
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

async function releaseAndRemoveStaleBrowserRuntimeSnapshot(
  path: string,
): Promise<void> {
  await removeQuarantinedBrowserRuntimeSnapshot(path, true);
}

async function removeQuarantinedBrowserRuntimeSnapshot(
  path: string,
  releaseImmutableFlags: boolean,
): Promise<void> {
  if (releaseImmutableFlags) {
    await setBrowserRuntimePathImmutable(
      path,
      false,
      true,
      new AbortController().signal,
    );
  }
  const leasePath = join(path, BROWSER_RUNTIME_SNAPSHOT_LEASE_FILE);
  const names = (await readdir(path)).sort();
  const hasLease = names.includes(BROWSER_RUNTIME_SNAPSHOT_LEASE_FILE);
  const leaseBytes = hasLease ? await readFile(leasePath) : undefined;
  for (const name of names) {
    if (name === BROWSER_RUNTIME_SNAPSHOT_LEASE_FILE) continue;
    await rm(join(path, name), { force: true, recursive: true });
  }
  const remaining = (await readdir(path)).sort();
  const expectedRemaining = hasLease
    ? [BROWSER_RUNTIME_SNAPSHOT_LEASE_FILE]
    : [];
  if (canonicalJson(remaining) !== canonicalJson(expectedRemaining)) {
    throw new ApplicationError(
      "conflict",
      "Browser runtime quarantine changed during lease-last cleanup; its recovery marker was preserved.",
    );
  }
  if (hasLease) await unlink(leasePath);
  try {
    await rmdir(path);
  } catch (error) {
    try {
      await lstat(path);
    } catch (inspectionError) {
      if (isFileSystemError(inspectionError, "ENOENT")) return;
      throw error;
    }
    if (leaseBytes !== undefined) {
      try {
        const replacement = await open(
          leasePath,
          constants.O_CREAT
            | constants.O_EXCL
            | constants.O_WRONLY
            | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        try {
          await replacement.writeFile(leaseBytes);
          await replacement.sync();
        } finally {
          await replacement.close();
        }
      } catch {
        // Preserve the original cleanup failure; a concurrently changed
        // quarantine is never recursively retried without a new validation.
      }
    }
    throw error;
  }
}

export async function scavengeStaleBrowserRuntimeSnapshots(
  options: BrowserRuntimeSnapshotScavengeOptions,
): Promise<readonly string[]> {
  const signal = options.signal ?? new AbortController().signal;
  if (signal.aborted) throw cancellationReason(signal);
  const currentUid = options.currentUid
    ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  if (currentUid === undefined) return [];
  const now = (options.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) return [];
  const staleAfterMs = options.staleAfterMs
    ?? BROWSER_RUNTIME_SNAPSHOT_STALE_AFTER_MS;
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 0) return [];
  const processAlive = options.processAlive ?? defaultSnapshotOwnerProcessAlive;
  const treeOpenState = options.treeOpenState ?? defaultSnapshotTreeOpenState;
  const releaseAndRemove = options.releaseAndRemove
    ?? releaseAndRemoveStaleBrowserRuntimeSnapshot;
  const names: string[] = [];
  let directory;
  try {
    directory = await opendir(options.anchorPath);
  } catch {
    if (signal.aborted) throw cancellationReason(signal);
    return [];
  }
  let scannedEntries = 0;
  try {
    for await (const entry of directory) {
      if (signal.aborted) throw cancellationReason(signal);
      scannedEntries += 1;
      if (scannedEntries > BROWSER_RUNTIME_SNAPSHOT_MAXIMUM_SCAN_ENTRIES) break;
      if (
        !BROWSER_RUNTIME_SNAPSHOT_NAME.test(entry.name)
        && !BROWSER_RUNTIME_SNAPSHOT_RECLAIM_NAME.test(entry.name)
      ) continue;
      names.push(entry.name);
      if (names.length >= BROWSER_RUNTIME_SNAPSHOT_MAXIMUM_CANDIDATES) break;
    }
  } catch {
    if (signal.aborted) throw cancellationReason(signal);
    return [];
  } finally {
    try {
      await directory.close();
    } catch {
      // Node and Bun may close a directory automatically when its async
      // iterator finishes or is stopped early.
    }
  }
  const reclaimed: string[] = [];
  let openStateProbes = 0;
  for (const name of names.sort()) {
    if (signal.aborted) throw cancellationReason(signal);
    if (
      reclaimed.length >= BROWSER_RUNTIME_SNAPSHOT_MAXIMUM_RECLAIMS
      || openStateProbes >= BROWSER_RUNTIME_SNAPSHOT_MAXIMUM_OPEN_STATE_PROBES
    ) break;
    const candidate = join(options.anchorPath, name);
    let quarantineCommitted = false;
    let quarantineValidated = false;
    try {
      const observed = await readBrowserRuntimeSnapshotLease(candidate, currentUid);
      if (signal.aborted) throw cancellationReason(signal);
      if (observed === undefined) continue;
      const ageMs = now.getTime() - Date.parse(observed.lease.acquiredAt);
      const releasedRecovery = BROWSER_RUNTIME_SNAPSHOT_RECLAIM_NAME.test(name)
        && observed.lease.state === "released";
      if (
        observed.lease.hostname !== hostname()
        || (
          !releasedRecovery
          && (ageMs < staleAfterMs || processAlive(observed.lease.pid))
        )
      ) continue;
      openStateProbes += 1;
      if (await treeOpenState(candidate, signal) !== "closed") continue;
      if (signal.aborted) throw cancellationReason(signal);
      const current = await readBrowserRuntimeSnapshotLease(candidate, currentUid);
      if (signal.aborted) throw cancellationReason(signal);
      if (
        current === undefined
        || !sameSnapshotLeaseFileIdentity(
          current.directoryIdentity,
          observed.directoryIdentity,
        )
        || !sameSnapshotLeaseFileIdentity(
          current.leaseIdentity,
          observed.leaseIdentity,
        )
        || canonicalJson(current.lease) !== canonicalJson(observed.lease)
      ) continue;

      // The outer container stays mutable by design; only the verified runtime
      // tree is recursively immutable. Move the pathname atomically before any
      // flag clearing or recursive deletion can touch it.
      const quarantine = join(
        options.anchorPath,
        `${BROWSER_RUNTIME_SNAPSHOT_RECLAIM_PREFIX}${randomUUID()}`,
      );
      await assertPathAbsent(quarantine, "The browser runtime reclaim path");
      if (signal.aborted) throw cancellationReason(signal);
      await rename(candidate, quarantine);
      quarantineCommitted = true;
      const quarantined = await readBrowserRuntimeSnapshotLease(
        quarantine,
        currentUid,
      );
      if (signal.aborted && quarantined === undefined) {
        throw cancellationReason(signal);
      }
      if (
        quarantined === undefined
        || !sameSnapshotLeaseNodeIdentity(
          quarantined.directoryIdentity,
          current.directoryIdentity,
        )
        || !sameSnapshotLeaseFileIdentity(
          quarantined.leaseIdentity,
          current.leaseIdentity,
        )
        || canonicalJson(quarantined.lease) !== canonicalJson(current.lease)
      ) {
        throw new ApplicationError(
          "conflict",
          "A browser runtime snapshot changed while it was atomically quarantined; the moved tree was preserved.",
        );
      }
      quarantineValidated = true;

      // After the atomic rename succeeds, this exact path can never collide
      // with a new runtime container. Re-prove that no descendant was opened
      // across the first lsof/rename gap, using a fresh cleanup signal so a
      // caller abort cannot skip this safety decision.
      const cleanupSignal = new AbortController().signal;
      if (await treeOpenState(quarantine, cleanupSignal) !== "closed") {
        if (signal.aborted) throw cancellationReason(signal);
        continue;
      }

      // Finish deletion only after the post-quarantine open-tree proof, then
      // propagate any caller cancellation.
      await releaseAndRemove(quarantine);
      reclaimed.push(candidate);
      if (signal.aborted) throw cancellationReason(signal);
    } catch (error) {
      if (signal.aborted) throw cancellationReason(signal);
      if (quarantineCommitted && !quarantineValidated) throw error;
      // Hygiene must never make a safe new snapshot fail. Ambiguous, unsafe,
      // live, open, or concurrently changed candidates are preserved.
    }
  }
  if (signal.aborted) throw cancellationReason(signal);
  return Object.freeze(reclaimed);
}

async function createBrowserRuntimeSnapshotLease(
  directory: string,
): Promise<Readonly<{
  handle: FileHandle;
  identity: SnapshotLeaseFileIdentity;
  lease: BrowserRuntimeSnapshotLease;
}>> {
  const handle = await open(
    join(directory, BROWSER_RUNTIME_SNAPSHOT_LEASE_FILE),
    constants.O_CREAT
      | constants.O_EXCL
      | constants.O_WRONLY
      | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const lease = BrowserRuntimeSnapshotLeaseSchema.parse({
      acquiredAt: new Date().toISOString(),
      hostname: hostname(),
      pid: process.pid,
      schemaVersion: 1,
      state: "active",
      token: randomUUID(),
    });
    await handle.writeFile(`${canonicalJson(lease)}\n`, { encoding: "utf8" });
    await handle.sync();
    return {
      handle,
      identity: snapshotLeaseFileIdentity(await handle.stat()),
      lease,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function setBrowserRuntimePathImmutable(
  path: string,
  immutable: boolean,
  recursive: boolean,
  signal: AbortSignal,
): Promise<void> {
  if (process.platform !== "darwin") {
    throw new ApplicationError(
      "internal",
      "Signed HTML-overlay browser snapshots require macOS filesystem flags.",
    );
  }
  if (signal.aborted) throw cancellationReason(signal);
  let result: RunResult;
  try {
    result = await new BunProcessRunner().run([
      "/usr/bin/chflags",
      ...(recursive ? ["-R", "-P"] : []),
      immutable ? "uchg" : "nouchg",
      path,
    ], {
      abortSignal: signal,
      env: {
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        PATH: "/usr/bin:/bin",
      },
      maxOutputBytes: BROWSER_RUNTIME_FLAGS_MAXIMUM_OUTPUT_BYTES,
      stdin: "ignore",
      timeoutMs: BROWSER_RUNTIME_FLAGS_TIMEOUT_MS,
    });
  } catch (error) {
    if (signal.aborted) throw cancellationReason(signal);
    throw new ApplicationError(
      "unavailable",
      `Could not ${immutable ? "protect" : "release"} the private browser runtime snapshot.`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  }
  if (signal.aborted) throw cancellationReason(signal);
  if (result.exitCode !== 0) {
    throw new ApplicationError(
      "unavailable",
      `Could not ${immutable ? "protect" : "release"} the private browser runtime snapshot.`,
      {
        exitCode: result.exitCode,
        stderr: boundedDiagnostic(result.stderr),
      },
    );
  }
}

interface BrowserRuntimeSnapshotRemoval {
  readonly containerChildren?: readonly SnapshotDirectChildIdentity[] | undefined;
  readonly containerIdentity?: SnapshotPathIdentity | undefined;
  readonly directory: string;
  readonly lease?: BrowserRuntimeSnapshotLease | undefined;
  readonly leaseHandle?: FileHandle | undefined;
  readonly leaseIdentity?: SnapshotLeaseFileIdentity | undefined;
  readonly releaseAndRemove?: ((path: string) => Promise<void>) | undefined;
  readonly identity?: readonly SnapshotPathIdentity[] | undefined;
  readonly runtimeEntries?: readonly HtmlOverlayBrowserRuntimeEntry[] | undefined;
  readonly runtimeImmutable: boolean;
  readonly runtimeRoot: string;
}

async function markBrowserRuntimeSnapshotLeaseReleased(
  quarantine: string,
  lease: BrowserRuntimeSnapshotLease,
): Promise<BrowserRuntimeSnapshotLease> {
  const released = BrowserRuntimeSnapshotLeaseSchema.parse(
    lease.state === "released"
      ? lease
      : {
          ...lease,
          releasedAt: new Date().toISOString(),
          state: "released",
        },
  );
  const temporary = join(
    quarantine,
    `.transmute-runtime-release-${randomUUID()}.tmp`,
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
    await handle.writeFile(`${canonicalJson(released)}\n`, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, join(quarantine, BROWSER_RUNTIME_SNAPSHOT_LEASE_FILE));
    const directoryHandle = await open(quarantine, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : 0;
  const observed = await readBrowserRuntimeSnapshotLease(quarantine, currentUid);
  if (
    observed === undefined
    || canonicalJson(observed.lease) !== canonicalJson(released)
  ) {
    throw new ApplicationError(
      "conflict",
      "Browser runtime cleanup could not authenticate its released lease marker.",
    );
  }
  return released;
}

export async function removeBrowserRuntimeSnapshot(
  snapshot: Readonly<BrowserRuntimeSnapshotRemoval>,
): Promise<void> {
  const closeLease = async (): Promise<void> => {
    await snapshot.leaseHandle?.close().catch(() => undefined);
  };
  if (join(snapshot.directory, basename(snapshot.runtimeRoot)) !== snapshot.runtimeRoot) {
    await closeLease();
    throw new ApplicationError(
      "unsafe-path",
      "Browser runtime cleanup received a root outside its snapshot container.",
    );
  }
  let containerChildren = snapshot.containerChildren;
  let containerIdentity = snapshot.containerIdentity;
  try {
    containerIdentity ??= await captureBrowserRuntimeSnapshotContainerIdentity(
      snapshot.directory,
      new AbortController().signal,
    );
    containerChildren ??= await captureBrowserRuntimeSnapshotDirectChildren(
      snapshot.directory,
      new AbortController().signal,
    );
  } catch (error) {
    await closeLease();
    if (isFileSystemError(error, "ENOENT")) return;
    throw error;
  }
  const quarantine = join(
    dirname(snapshot.directory),
    `${BROWSER_RUNTIME_SNAPSHOT_RECLAIM_PREFIX}${randomUUID()}`,
  );
  await assertPathAbsent(quarantine, "The browser runtime reclaim path");
  try {
    await rename(snapshot.directory, quarantine);
  } catch (error) {
    await closeLease();
    throw error;
  }
  try {
    const movedContainer = await captureBrowserRuntimeSnapshotContainerIdentity(
      quarantine,
      new AbortController().signal,
    );
    if (!sameSnapshotPathNodeIdentity(movedContainer, containerIdentity)) {
      throw new ApplicationError(
        "conflict",
        "A browser runtime cleanup target changed while it was atomically quarantined; the moved tree was preserved.",
      );
    }
    const movedChildren = await captureBrowserRuntimeSnapshotDirectChildren(
      quarantine,
      new AbortController().signal,
    );
    if (canonicalJson(movedChildren) !== canonicalJson(containerChildren)) {
      throw new ApplicationError(
        "conflict",
        "Browser runtime cleanup children changed while their container was atomically quarantined; the moved tree was preserved.",
      );
    }
    const hasRuntimeBinding = snapshot.identity !== undefined
      || snapshot.runtimeEntries !== undefined;
    if (
      hasRuntimeBinding
      && (snapshot.identity === undefined || snapshot.runtimeEntries === undefined)
    ) {
      throw new ApplicationError(
        "internal",
        "Browser runtime cleanup received an incomplete runtime-tree binding.",
      );
    }
    if (snapshot.identity !== undefined && snapshot.runtimeEntries !== undefined) {
      const movedRuntimeIdentity = await captureBrowserRuntimeSnapshotIdentity(
        join(quarantine, basename(snapshot.runtimeRoot)),
        snapshot.runtimeEntries,
        new AbortController().signal,
      );
      const rootHasLaunchManagedCtime = snapshot.runtimeImmutable
        && snapshot.runtimeEntries[0]?.kind === "directory";
      const comparable = (entry: SnapshotPathIdentity | undefined) => (
        rootHasLaunchManagedCtime && entry?.path === "."
          ? { ...entry, ctimeNs: "macos-launch-managed" }
          : entry
      );
      if (
        canonicalJson(movedRuntimeIdentity.map(comparable))
        !== canonicalJson(snapshot.identity.map(comparable))
      ) {
        throw new ApplicationError(
          "conflict",
          "Browser runtime cleanup descendants changed before immutable flags could be cleared; the moved tree was preserved.",
        );
      }
    }
    const hasLeaseBinding = snapshot.lease !== undefined
      || snapshot.leaseHandle !== undefined
      || snapshot.leaseIdentity !== undefined;
    if (
      hasLeaseBinding
      && (
        snapshot.lease === undefined
        || snapshot.leaseHandle === undefined
        || snapshot.leaseIdentity === undefined
      )
    ) {
      throw new ApplicationError(
        "internal",
        "Browser runtime cleanup received an incomplete lease binding.",
      );
    }
    if (
      snapshot.lease !== undefined
      && snapshot.leaseHandle !== undefined
      && snapshot.leaseIdentity !== undefined
    ) {
      const heldLeaseIdentity = snapshotLeaseFileIdentity(
        await snapshot.leaseHandle.stat(),
      );
      const currentUid = typeof process.getuid === "function"
        ? process.getuid()
        : snapshot.leaseIdentity.uid;
      const movedLease = await readBrowserRuntimeSnapshotLease(
        quarantine,
        currentUid,
      );
      if (
        !sameSnapshotLeaseFileIdentity(
          heldLeaseIdentity,
          snapshot.leaseIdentity,
        )
        || movedLease === undefined
        || !sameSnapshotLeaseFileIdentity(
          movedLease.leaseIdentity,
          snapshot.leaseIdentity,
        )
        || canonicalJson(movedLease.lease) !== canonicalJson(snapshot.lease)
      ) {
        throw new ApplicationError(
          "conflict",
          "A browser runtime lease changed while its container was atomically quarantined; the moved tree was preserved.",
        );
      }
      await markBrowserRuntimeSnapshotLeaseReleased(
        quarantine,
        snapshot.lease,
      );
    }
    await closeLease();
    await (snapshot.releaseAndRemove
      ?? (async path => await removeQuarantinedBrowserRuntimeSnapshot(
        path,
        snapshot.runtimeImmutable,
      )))(quarantine);
  } finally {
    await closeLease();
  }
}

async function assertNoBrowserRuntimeMutationEvents(
  mutations: ReadonlySet<string>,
  label: string,
): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve));
  if (mutations.size > 0) {
    throw new ApplicationError(
      "conflict",
      `Browser runtime filesystem changed ${label}: ${[...mutations].sort().slice(0, 8).join(", ")}`,
    );
  }
}

function discardProvenLaunchManagedRootMetadataEvent(
  mutations: Set<string>,
  runtimeName: string,
): void {
  // Darwin/FSEvents reports Gatekeeper's app-root metadata update as either a
  // change or rename. Call this only after the immutable container's exact
  // ctime identity has been re-proved; an actual child rename changes that
  // ctime and fails before this event can be discarded.
  mutations.delete(`change:${runtimeName}`);
  mutations.delete(`rename:${runtimeName}`);
}

async function prepareBrowserRuntimeSnapshot(
  cacheRootInput: string,
  binding: HtmlOverlayBrowserRuntimeBinding,
  signal: AbortSignal,
): Promise<PreparedBrowserRuntimeSnapshot> {
  if (signal.aborted) throw cancellationReason(signal);
  const anchorBefore = await browserRuntimeSnapshotAnchor(cacheRootInput, signal);
  await scavengeStaleBrowserRuntimeSnapshots({
    anchorPath: anchorBefore.path,
    signal,
  });
  const sourceBefore = await inspectHtmlOverlayBrowserRuntime(
    binding.sourceRoot,
    binding.manifest.layout,
    binding.manifest.executableRelativePath,
    signal,
  );
  assertHtmlOverlayBrowserRuntimeManifest(
    sourceBefore,
    binding.manifest,
    "before its private snapshot",
  );
  const directory = await mkdtemp(join(
    anchorBefore.path,
    BROWSER_RUNTIME_SNAPSHOT_PREFIX,
  ));
  await chmod(directory, 0o700);
  const [directoryDetails, anchorIdentity] = await Promise.all([
    lstat(directory),
    inspectBrowserRuntimeSnapshotAnchor(
      anchorBefore.path,
      process.platform === "darwin",
      signal,
    ),
  ]);
  if (canonicalJson(anchorIdentity) !== canonicalJson(anchorBefore)) {
    await rm(directory, { force: true, recursive: true });
    throw new ApplicationError(
      "conflict",
      "The browser runtime snapshot anchor changed while its unique container was created.",
    );
  }
  if (
    directoryDetails.isSymbolicLink()
    || !directoryDetails.isDirectory()
    || (directoryDetails.mode & 0o777) !== 0o700
  ) {
    await rm(directory, { force: true, recursive: true });
    throw new ApplicationError(
      "unsafe-path",
      "The browser runtime snapshot directory is not private and physical.",
    );
  }
  const runtimeName = binding.manifest.layout === "macos-app-bundle"
    ? basename(binding.sourceRoot)
    : "browser";
  if (
    runtimeName === ""
    || runtimeName === "."
    || runtimeName === ".."
    || runtimeName.includes("/")
  ) {
    await rm(directory, { force: true, recursive: true });
    throw new ApplicationError("unsafe-path", "Browser runtime has an unsafe root name.");
  }
  const runtimeRoot = join(directory, runtimeName);
  let leaseBinding: Readonly<{
    handle: FileHandle;
    identity: SnapshotLeaseFileIdentity;
    lease: BrowserRuntimeSnapshotLease;
  }> | undefined;
  let runtimeImmutable = false;
  try {
    leaseBinding = await createBrowserRuntimeSnapshotLease(directory);
    for (const entry of binding.manifest.entries) {
      await copyRuntimeEntry(binding.sourceRoot, runtimeRoot, entry, signal);
    }
    for (const entry of [...binding.manifest.entries].reverse()) {
      if (entry.kind === "directory") {
        await chmod(snapshotEntryPath(runtimeRoot, entry.path), entry.mode);
      }
    }
    const [sourceAfter, snapshot] = await Promise.all([
      inspectHtmlOverlayBrowserRuntime(
        binding.sourceRoot,
        binding.manifest.layout,
        binding.manifest.executableRelativePath,
        signal,
      ),
      inspectHtmlOverlayBrowserRuntime(
        runtimeRoot,
        binding.manifest.layout,
        binding.manifest.executableRelativePath,
        signal,
      ),
    ]);
    assertHtmlOverlayBrowserRuntimeManifest(
      sourceAfter,
      sourceBefore,
      "while its private snapshot was copied",
    );
    assertHtmlOverlayBrowserRuntimeManifest(
      snapshot,
      binding.manifest,
      "inside its private snapshot",
    );
    if (binding.provenance.kind === "verified-macos-code-signature") {
      const snapshotProvenance = await inspectSupportedHtmlOverlayMacBrowserProvenance(
        runtimeRoot,
        snapshotEntryPath(
          runtimeRoot,
          binding.manifest.executableRelativePath,
        ),
        signal,
      );
      if (canonicalJson(snapshotProvenance) !== canonicalJson(binding.provenance)) {
        throw new ApplicationError(
          "conflict",
          "Private browser runtime snapshot changed its signed distribution identity.",
        );
      }
      const browserHome = join(directory, "home");
      const browserTemporaryDirectory = join(directory, "tmp");
      await mkdir(browserHome, { mode: 0o700 });
      await mkdir(browserTemporaryDirectory, { mode: 0o700 });
      runtimeImmutable = true;
      await setBrowserRuntimePathImmutable(runtimeRoot, true, true, signal);
      const identity = await captureBrowserRuntimeSnapshotIdentity(
        runtimeRoot,
        binding.manifest.entries,
        signal,
      );
      const containerIdentity = await captureBrowserRuntimeSnapshotContainerIdentity(
        directory,
        signal,
      );
      const containerChildren = await captureBrowserRuntimeSnapshotDirectChildren(
        directory,
        signal,
      );
      return {
        anchorIdentity,
        anchorPath: anchorBefore.path,
        browserHome,
        browserTemporaryDirectory,
        containerChildren,
        containerIdentity,
        directory,
        executablePath: snapshotEntryPath(
          runtimeRoot,
          binding.manifest.executableRelativePath,
        ),
        identity,
        lease: leaseBinding.lease,
        leaseHandle: leaseBinding.handle,
        leaseIdentity: leaseBinding.identity,
        runtimeEntries: binding.manifest.entries,
        runtimeImmutable,
        runtimeRoot,
      };
    }
    const browserHome = join(directory, "home");
    const browserTemporaryDirectory = join(directory, "tmp");
    await mkdir(browserHome, { mode: 0o700 });
    await mkdir(browserTemporaryDirectory, { mode: 0o700 });
    const identity = await captureBrowserRuntimeSnapshotIdentity(
      runtimeRoot,
      binding.manifest.entries,
      signal,
    );
    const containerIdentity = await captureBrowserRuntimeSnapshotContainerIdentity(
      directory,
      signal,
    );
    const containerChildren = await captureBrowserRuntimeSnapshotDirectChildren(
      directory,
      signal,
    );
    return {
      anchorIdentity,
      anchorPath: anchorBefore.path,
      browserHome,
      browserTemporaryDirectory,
      containerChildren,
      containerIdentity,
      directory,
      executablePath: snapshotEntryPath(
        runtimeRoot,
        binding.manifest.executableRelativePath,
      ),
      identity,
      lease: leaseBinding.lease,
      leaseHandle: leaseBinding.handle,
      leaseIdentity: leaseBinding.identity,
      runtimeEntries: binding.manifest.entries,
      runtimeImmutable,
      runtimeRoot,
    };
  } catch (error) {
    await removeBrowserRuntimeSnapshot({
      directory,
      lease: leaseBinding?.lease,
      leaseHandle: leaseBinding?.handle,
      leaseIdentity: leaseBinding?.identity,
      runtimeImmutable,
      runtimeRoot,
    });
    throw error;
  }
}

async function verifyBrowserRuntimeSnapshot(
  snapshot: PreparedBrowserRuntimeSnapshot,
  binding: HtmlOverlayBrowserRuntimeBinding,
  label: string,
  signal: AbortSignal,
): Promise<void> {
  const current = await inspectHtmlOverlayBrowserRuntime(
    snapshot.runtimeRoot,
    binding.manifest.layout,
    binding.manifest.executableRelativePath,
    signal,
  );
  assertHtmlOverlayBrowserRuntimeManifest(current, binding.manifest, label);
}

async function boundedBestEffortBrowserCleanup(
  label: string,
  start: () => Promise<unknown>,
): Promise<void> {
  try {
    await boundedBrowserStep(
      start,
      new AbortController().signal,
      BROWSER_CLEANUP_TIMEOUT_MS,
      label,
    );
  } catch {
    // The render result is already decided. Cleanup stays bounded and
    // deliberately cannot replace the primary render or cancellation error.
  }
}

async function verifyCachedLibrary(
  path: string,
  lock: HtmlOverlayLibraryLock,
): Promise<Buffer | undefined> {
  try {
    const details = await lstat(path);
    if (
      details.isSymbolicLink()
      || !details.isFile()
      || details.size !== lock.bytes
      || details.size > MAXIMUM_LIBRARY_BYTES
    ) {
      return undefined;
    }
    const bytes = await readFile(path);
    return sha256(bytes) === lock.sha256 ? bytes : undefined;
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

async function publishCachedLibrary(
  cacheRoot: string,
  path: string,
  bytes: Buffer,
): Promise<void> {
  const temporary = join(cacheRoot, `.module-${randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function responseBytes(
  response: Response,
  maximumBytes: number,
): Promise<Buffer> {
  if (!response.ok) {
    throw new ApplicationError(
      "unavailable",
      `Approved overlay library download failed with HTTP ${String(response.status)}.`,
    );
  }
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new ApplicationError("invalid-data", "Approved overlay library exceeds its byte limit.");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new ApplicationError("unavailable", "Approved overlay library returned no response body.");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new ApplicationError("invalid-data", "Approved overlay library exceeds its byte limit.");
    }
    chunks.push(result.value);
  }
  return Buffer.concat(chunks, total);
}

async function exactResourceBytes(
  resource: BoundHtmlOverlayResource,
): Promise<Buffer> {
  const details = await lstat(resource.absolutePath);
  if (
    details.isSymbolicLink()
    || !details.isFile()
    || details.size !== resource.bytes
  ) {
    throw new ApplicationError(
      "conflict",
      `HTML-overlay resource changed before browser rendering: ${resource.name}`,
    );
  }
  const bytes = await readFile(resource.absolutePath);
  if (sha256(bytes) !== resource.sha256) {
    throw new ApplicationError(
      "conflict",
      `HTML-overlay resource changed before browser rendering: ${resource.name}`,
    );
  }
  return bytes;
}

function contentSecurityPolicy(): string {
  return HTML_OVERLAY_RENDERER_CONTRACT.contentSecurityPolicy.join("; ");
}

async function fulfillPreparedRoute(
  route: Route,
  routes: ReadonlyMap<string, PreparedRoute>,
  onBlocked: () => void,
): Promise<void> {
  const requestedUrl = new URL(route.request().url());
  const prepared = requestedUrl.origin === SYNTHETIC_ORIGIN
    ? routes.get(requestedUrl.pathname)
    : undefined;
  if (prepared === undefined) {
    onBlocked();
    await route.abort("blockedbyclient");
    return;
  }
  await route.fulfill({
    body: prepared.body,
    contentType: prepared.contentType,
    headers: {
      "Cache-Control": "no-store",
      "Content-Security-Policy": contentSecurityPolicy(),
      "Cross-Origin-Resource-Policy": "same-origin",
    },
    status: 200,
  });
}

export class PlaywrightHtmlOverlayRenderer implements HtmlOverlayRenderer {
  readonly #browserStepTimeoutMs: number;
  readonly #cacheRoot: string;
  readonly #fetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
  readonly #frameTimeoutMs: number;
  readonly #launch: (options: LaunchOptions) => Promise<Browser>;

  constructor(options: PlaywrightHtmlOverlayRendererOptions) {
    const browserStepTimeoutMs = options.browserStepTimeoutMs
      ?? DEFAULT_BROWSER_STEP_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(browserStepTimeoutMs)
      || browserStepTimeoutMs < 100
      || browserStepTimeoutMs > MAXIMUM_BROWSER_STEP_TIMEOUT_MS
    ) {
      throw new ApplicationError(
        "usage",
        `HTML overlay browser step timeout must be an integer from 100 through ${String(MAXIMUM_BROWSER_STEP_TIMEOUT_MS)}ms.`,
      );
    }
    this.#browserStepTimeoutMs = browserStepTimeoutMs;
    const frameTimeoutMs = options.frameTimeoutMs ?? browserStepTimeoutMs;
    if (
      !Number.isSafeInteger(frameTimeoutMs)
      || frameTimeoutMs < 100
      || frameTimeoutMs > MAXIMUM_BROWSER_STEP_TIMEOUT_MS
    ) {
      throw new ApplicationError(
        "usage",
        `HTML overlay frame timeout must be an integer from 100 through ${String(MAXIMUM_BROWSER_STEP_TIMEOUT_MS)}ms.`,
      );
    }
    this.#frameTimeoutMs = frameTimeoutMs;
    this.#cacheRoot = options.cacheRoot;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#launch = options.launch ?? (
      async launchOptions => await chromium.launch(launchOptions)
    );
  }

  async #libraryBytes(
    lock: HtmlOverlayLibraryLock,
    signal: AbortSignal,
  ): Promise<Buffer> {
    const cacheRoot = await ensurePrivateCacheRoot(this.#cacheRoot);
    const path = join(cacheRoot, `${lock.sha256}.mjs`);
    const cached = await verifyCachedLibrary(path, lock);
    if (cached !== undefined) return cached;
    const response = await this.#fetch(lock.url, {
      redirect: "error",
      signal,
    });
    const bytes = await responseBytes(response, Math.min(lock.bytes, MAXIMUM_LIBRARY_BYTES));
    if (bytes.byteLength !== lock.bytes || sha256(bytes) !== lock.sha256) {
      throw new ApplicationError(
        "conflict",
        `Approved overlay library bytes do not match the lock: ${lock.specifier}`,
      );
    }
    await publishCachedLibrary(cacheRoot, path, bytes);
    const published = await verifyCachedLibrary(path, lock);
    if (published === undefined) {
      throw new ApplicationError("conflict", "Approved overlay library cache publication failed.");
    }
    return published;
  }

  async renderFrames(
    request: HtmlOverlayFrameRenderRequest,
    signal: AbortSignal,
  ): Promise<HtmlOverlayFrameRenderResult> {
    if (signal.aborted) throw cancellationReason(signal);
    const execution = createHtmlOverlayExecutionBundle(
      request.authoring,
      request.browserRuntime,
    );
    const locks = execution.libraryLocks;
    const [libraryBodies, resourceBodies] = await Promise.all([
      Promise.all(locks.map(async lock => await this.#libraryBytes(lock, signal))),
      Promise.all(request.resources.map(async resource => await exactResourceBytes(resource))),
    ]);
    const routes = new Map<string, PreparedRoute>();
    const importMap = execution.importMap;
    routes.set(new URL(DOCUMENT_URL).pathname, {
      body: Buffer.from("<!doctype html><html><head></head><body></body></html>"),
      contentType: "text/html; charset=utf-8",
    });
    locks.forEach((lock, index) => {
      routes.set(htmlOverlayLibraryLocalUrl(lock), {
        body: libraryBodies[index]!,
        contentType: "text/javascript; charset=utf-8",
      });
    });
    request.resources.forEach((resource, index) => {
      routes.set(htmlOverlayAssetLocalUrl(resource), {
        body: resourceBodies[index]!,
        contentType: resource.mediaType,
      });
    });

    const finalFrameDirectory = join(request.outputDirectory, "frames");
    await assertPathAbsent(
      finalFrameDirectory,
      "The HTML-overlay frame directory",
    );
    const stagingFrameDirectory = await mkdtemp(
      join(request.outputDirectory, ".html-overlay-frames-"),
    );
    const frameCount = htmlOverlayFrameCount(request.authoring.timing);
    const diagnostics: string[] = [];
    const pageErrors: string[] = [];
    let browserRuntimeSnapshot: PreparedBrowserRuntimeSnapshot | undefined;
    const browserRuntimeWatchers: FSWatcher[] = [];
    const browserRuntimeMutations = new Set<string>();
    let renderFailure: Readonly<{ error: unknown }> | undefined;
    let renderResult: HtmlOverlayFrameRenderResult | undefined;
    try {
      const preparedBrowserRuntime = await prepareBrowserRuntimeSnapshot(
        this.#cacheRoot,
        request.browserRuntime,
        signal,
      );
      browserRuntimeSnapshot = preparedBrowserRuntime;
      const runtimeName = basename(preparedBrowserRuntime.runtimeRoot);
      const snapshotName = basename(preparedBrowserRuntime.directory);
      const anchorWatcher = watch(
        preparedBrowserRuntime.anchorPath,
        { persistent: false },
        (eventType, filename) => {
          const path = filename?.toString() ?? "<snapshot-anchor>";
          if (path === snapshotName) {
            browserRuntimeMutations.add(`anchor-${eventType}:${path}`);
          }
        },
      );
      anchorWatcher.on("error", error => {
        browserRuntimeMutations.add(`anchor-watch-error:${error.message}`);
      });
      browserRuntimeWatchers.push(anchorWatcher);
      const containerWatcher = watch(
        preparedBrowserRuntime.directory,
        { persistent: false, recursive: process.platform === "darwin" },
        (eventType, filename) => {
          const path = filename?.toString().replaceAll("\\", "/")
            ?? "<snapshot-container>";
          if (
            path === "home"
            || path.startsWith("home/")
            || path === "tmp"
            || path.startsWith("tmp/")
          ) return;
          if (path === runtimeName && eventType === "change") {
            // Gatekeeper may change the app root's first-launch metadata. The
            // immutable parent and its exact ctime identity independently
            // prove that this pathname was never removed or replaced.
            return;
          }
          if (
            request.browserRuntime.provenance.kind === "test-only-unverified"
            && request.browserRuntime.manifest.layout === "single-executable"
            && path === runtimeName
            && eventType === "rename"
          ) {
            // Darwin reports synthetic rename events for accesses to the
            // test-only single-file fixture. Production rejects this layout;
            // its exact path identity still detects fixture substitution.
            return;
          }
          if (path === runtimeName || path.startsWith(`${runtimeName}/`)) {
            browserRuntimeMutations.add(`${eventType}:${path}`);
            return;
          }
          browserRuntimeMutations.add(`${eventType}:${path}`);
        },
      );
      containerWatcher.on("error", error => {
        browserRuntimeMutations.add(`watch-error:${error.message}`);
      });
      browserRuntimeWatchers.push(containerWatcher);
      await new Promise<void>(resolve => setTimeout(resolve, 25));
      if (signal.aborted) throw cancellationReason(signal);
      // FSEvents can deliver the just-created direct-child notification after
      // both watches attach. Clear that bounded baseline before re-verifying
      // every manifest and path identity. A swap during this window changes
      // the already-captured container ctime and therefore fails below.
      browserRuntimeMutations.clear();
      let browser: Browser | undefined;
      try {
        await verifyBrowserRuntimeSnapshot(
          preparedBrowserRuntime,
          request.browserRuntime,
          "immediately before launch",
          signal,
        );
        await assertBrowserRuntimeSnapshotIdentity(
          preparedBrowserRuntime,
          request.browserRuntime.manifest.entries,
          "immediately before launch",
          signal,
        );
        await assertBrowserRuntimeSnapshotContainerIdentity(
          preparedBrowserRuntime,
          "immediately before launch",
          signal,
        );
        await assertBrowserRuntimeSnapshotAnchorIdentity(
          preparedBrowserRuntime,
          "immediately before launch",
          signal,
        );
        discardProvenLaunchManagedRootMetadataEvent(
          browserRuntimeMutations,
          runtimeName,
        );
        await assertNoBrowserRuntimeMutationEvents(
          browserRuntimeMutations,
          "before browser launch",
        );
        const launchedBrowser = await boundedBrowserStep(
          async () => await this.#launch({
            args: [...HTML_OVERLAY_RENDERER_CONTRACT.launch.args],
            env: {
              ...HTML_OVERLAY_RENDERER_CONTRACT.environment.fixed,
              HOME: preparedBrowserRuntime.browserHome,
              TMPDIR: preparedBrowserRuntime.browserTemporaryDirectory,
            },
            executablePath: preparedBrowserRuntime.executablePath,
            headless: HTML_OVERLAY_RENDERER_CONTRACT.launch.headless,
            timeout: this.#browserStepTimeoutMs,
          }),
          signal,
          this.#browserStepTimeoutMs,
          "launch",
          async lateBrowser => {
            await boundedBestEffortBrowserCleanup(
              "late browser close",
              async () => await lateBrowser.close(),
            );
          },
        );
        browser = launchedBrowser;
        await verifyBrowserRuntimeSnapshot(
          preparedBrowserRuntime,
          request.browserRuntime,
          "during browser launch",
          signal,
        );
        await assertBrowserRuntimeSnapshotIdentity(
          preparedBrowserRuntime,
          request.browserRuntime.manifest.entries,
          "during browser launch",
          signal,
        );
        await assertBrowserRuntimeSnapshotContainerIdentity(
          preparedBrowserRuntime,
          "during browser launch",
          signal,
        );
        await assertBrowserRuntimeSnapshotAnchorIdentity(
          preparedBrowserRuntime,
          "during browser launch",
          signal,
        );
        discardProvenLaunchManagedRootMetadataEvent(
          browserRuntimeMutations,
          runtimeName,
        );
        await assertNoBrowserRuntimeMutationEvents(
          browserRuntimeMutations,
          "during browser launch",
        );
        const contextContract = HTML_OVERLAY_RENDERER_CONTRACT.browserContext;
        const context = await boundedBrowserStep(
          async () => await launchedBrowser.newContext({
            acceptDownloads: contextContract.acceptDownloads,
            colorScheme: contextContract.colorScheme,
            deviceScaleFactor: request.authoring.canvas.deviceScaleFactor,
            locale: contextContract.locale,
            offline: contextContract.offline,
            permissions: [...contextContract.permissions],
            reducedMotion: contextContract.reducedMotion,
            serviceWorkers: contextContract.serviceWorkers,
            timezoneId: contextContract.timezoneId,
            viewport: {
              height: request.authoring.canvas.height,
              width: request.authoring.canvas.width,
            },
          }),
          signal,
          this.#browserStepTimeoutMs,
          "context creation",
        );
        try {
          let blockedRequestCount = 0;
          let childFrameCount = 0;
          let policyViolationCount = 0;
          let unexpectedPageCount = 0;
          await boundedBrowserStep(
            async () => await context.route("**/*", async route => {
              await fulfillPreparedRoute(
                route,
                routes,
                () => {
                  blockedRequestCount += 1;
                },
              );
            }),
            signal,
            this.#browserStepTimeoutMs,
            "route installation",
          );
          const page = await boundedBrowserStep(
            async () => await context.newPage(),
            signal,
            this.#browserStepTimeoutMs,
            "page creation",
          );
          context.on("page", (candidate) => {
            if (candidate === page) return;
            unexpectedPageCount += 1;
            void candidate.close().catch(() => undefined);
          });
          page.on("frameattached", (frame) => {
            if (frame !== page.mainFrame()) {
              childFrameCount += 1;
            }
          });
          page.on("console", (message) => {
            const messageText = message.text();
            if (
              message.type() === "error"
              && messageText.includes("Content Security Policy")
            ) {
              policyViolationCount += 1;
            }
            if (
              diagnostics.length < MAXIMUM_DIAGNOSTICS
              && (message.type() === "error" || message.type() === "warning")
            ) {
              diagnostics.push(boundedDiagnostic(`${message.type()}: ${messageText}`));
            }
          });
          page.on("pageerror", (error) => {
            if (pageErrors.length < MAXIMUM_DIAGNOSTICS) {
              pageErrors.push(boundedDiagnostic(error.message));
            }
          });
          const assertNoDeniedBrowserActivity = async (
            host: JSHandle<HtmlOverlayHostController>,
          ): Promise<void> => {
            const securityViolationCount = await boundedBrowserStep(
              async () => await host.evaluate(
                controller => controller.securityViolationCount(),
              ),
              signal,
              this.#browserStepTimeoutMs,
              "policy inspection",
            );
            if (
              blockedRequestCount > 0
              || childFrameCount > 0
              || policyViolationCount > 0
              || unexpectedPageCount > 0
              || securityViolationCount > 0
            ) {
              throw new ApplicationError(
                "invalid-data",
                "HTML overlay attempted undeclared browser access.",
                {
                  blockedRequestCount,
                  childFrameCount,
                  policyViolationCount,
                  securityViolationCount,
                  unexpectedPageCount,
                },
              );
            }
          };
          const runtimeSource = execution.runtimeSource;
          await boundedBrowserStep(
            async () => await page.goto(DOCUMENT_URL, {
              timeout: this.#browserStepTimeoutMs,
              waitUntil: "load",
            }),
            signal,
            this.#browserStepTimeoutMs,
            "initial navigation",
          );
          const host = await boundedBrowserStep(
            async () => await page.evaluateHandle<HtmlOverlayHostController>(
              runtimeSource,
            ),
            signal,
            this.#browserStepTimeoutMs,
            "runtime installation",
          );
          try {
            const html = await htmlWithHostImports(
              page,
              request.authoring.html,
              importMap,
              signal,
              this.#browserStepTimeoutMs,
            );
            // document.open(), which powers setContent(), preserves this
            // Window. Installing the runtime first lets authored scripts
            // register ready/onFrame callbacks during initial evaluation.
            await boundedBrowserStep(
              async () => await page.setContent(html, {
                timeout: this.#browserStepTimeoutMs,
                waitUntil: "load",
              }),
              signal,
              this.#browserStepTimeoutMs,
              "document load",
            );
            await assertNoDeniedBrowserActivity(host);
            for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
              if (signal.aborted) throw cancellationReason(signal);
              const frame = createHtmlOverlayRuntimeFrame(
                frameIndex,
                request.authoring.canvas,
                request.authoring.timing,
              );
              await boundedBrowserStep(
                async () => await host.evaluate(
                  async (
                    controller,
                    nextFrame,
                  ) => await controller.renderFrame(nextFrame),
                  frame,
                ),
                signal,
                this.#frameTimeoutMs,
                `frame ${String(frameIndex)} evaluation`,
              );
              await assertNoDeniedBrowserActivity(host);
              if (pageErrors.length > 0) {
                throw new ApplicationError(
                  "invalid-data",
                  `HTML overlay failed during frame ${String(frameIndex)}: ${pageErrors.join(" | ")}`,
                );
              }
              await boundedBrowserStep(
                async () => await page.screenshot({
                  omitBackground: HTML_OVERLAY_RENDERER_CONTRACT.screenshot.omitBackground,
                  path: join(
                    stagingFrameDirectory,
                    `frame-${String(frameIndex).padStart(8, "0")}.png`,
                  ),
                  scale: HTML_OVERLAY_RENDERER_CONTRACT.screenshot.scale,
                  type: HTML_OVERLAY_RENDERER_CONTRACT.screenshot.type,
                }),
                signal,
                this.#browserStepTimeoutMs,
                `frame ${String(frameIndex)} screenshot`,
              );
              await assertNoDeniedBrowserActivity(host);
            }
          } finally {
            await boundedBestEffortBrowserCleanup(
              "host handle disposal",
              async () => await host.dispose(),
            );
          }
        } finally {
          await boundedBestEffortBrowserCleanup(
            "context close",
            async () => await context.close(),
          );
        }
      } catch (error) {
        if (signal.aborted) throw cancellationReason(signal);
        if (error instanceof ApplicationError) throw error;
        const suffix = diagnostics.length === 0
          ? ""
          : ` Browser diagnostics: ${diagnostics.join(" | ")}`;
        throw new ApplicationError(
          "invalid-data",
          `HTML overlay browser rendering failed.${suffix}`,
          { cause: error instanceof Error ? error.message : String(error) },
        );
      } finally {
        const launchedBrowser = browser;
        if (launchedBrowser !== undefined) {
          await boundedBestEffortBrowserCleanup(
            "browser close",
            async () => await launchedBrowser.close(),
          );
        }
      }
      await verifyBrowserRuntimeSnapshot(
        preparedBrowserRuntime,
        request.browserRuntime,
        "through browser shutdown",
        signal,
      );
      await assertBrowserRuntimeSnapshotIdentity(
        preparedBrowserRuntime,
        request.browserRuntime.manifest.entries,
        "through browser shutdown",
        signal,
      );
      await assertBrowserRuntimeSnapshotContainerIdentity(
        preparedBrowserRuntime,
        "through browser shutdown",
        signal,
      );
      await assertBrowserRuntimeSnapshotAnchorIdentity(
        preparedBrowserRuntime,
        "through browser shutdown",
        signal,
      );
      discardProvenLaunchManagedRootMetadataEvent(
        browserRuntimeMutations,
        runtimeName,
      );
      await assertNoBrowserRuntimeMutationEvents(
        browserRuntimeMutations,
        "through browser shutdown",
      );
      renderResult = {
        executionIntegrity: execution.integrity,
        frameCount,
        framePattern: join(finalFrameDirectory, "frame-%08d.png"),
        libraryLocks: locks,
      };
    } catch (error) {
      renderFailure = { error };
      await rm(stagingFrameDirectory, { force: true, recursive: true })
        .catch(() => undefined);
    } finally {
      for (const watcher of browserRuntimeWatchers) watcher.close();
      if (browserRuntimeSnapshot !== undefined) {
        try {
          await removeBrowserRuntimeSnapshot(browserRuntimeSnapshot);
        } catch (cleanupError) {
          renderFailure ??= { error: cleanupError };
        }
      }
    }
    if (renderFailure !== undefined) {
      await rm(stagingFrameDirectory, { force: true, recursive: true })
        .catch(() => undefined);
      throw renderFailure.error;
    }
    if (renderResult === undefined) {
      throw new ApplicationError(
        "internal",
        "HTML overlay rendering completed without a result or failure.",
      );
    }
    await rename(stagingFrameDirectory, finalFrameDirectory);
    return renderResult;
  }
}
