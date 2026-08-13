import { createHash } from "node:crypto";
import { spawn as spawnNode, type ChildProcess } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

import { ApplicationError } from "../application/errors";
import {
  canonicalJson,
  sha256Hex,
} from "../core/canonical-json";
import type { WorkflowBundleIdentity as GraphWorkflowBundleIdentity } from "./contracts";
import { typecheckWorkflowSnapshot } from "./source-typecheck";
import { captureWorkerProcessStartIdentity } from "./worker-process-identity";

export const WORKFLOW_ALLOWED_BARE_IMPORTS = Object.freeze([
  "@hraness/transmute/local/code",
  "@hraness/transmute/local/code/advanced",
  "@hraness/transmute/local/code/workflows",
  "@hraness/transmute/local/html-overlay",
  "zod",
]);

const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_MODULES = 512;
const MAX_TOTAL_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_IMPORT_EDGES = 4_096;
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
const MAX_BUNDLER_DIAGNOSTIC_BYTES = 64 * 1024;
const MAX_BUNDLER_DURATION_MS = 60_000;
const MAX_TIMER_DURATION_MS = 2_147_483_647;
const BUNDLER_GUARDIAN_HANDSHAKE_MS = 2_000;
const BUNDLER_GUARDIAN_DIAGNOSTIC_BYTES = 2_000;

const BUNDLE_SUBPROCESS_SOURCE = String.raw`
import { fstatSync } from "node:fs";
const processIdentity = await import(process.argv[5]);
processIdentity.establishCurrentWorkerProcessGroup();
const preparationLeaseFd = Number(process.argv[3]);
if (
  !Number.isSafeInteger(preparationLeaseFd)
  || preparationLeaseFd < 0
  || (preparationLeaseFd > 0 && preparationLeaseFd < 3)
) {
  throw new Error("Workflow bundler preparation lease descriptor is invalid.");
}
if (preparationLeaseFd !== 0) fstatSync(preparationLeaseFd);
process.stdout.write("ready\n");
const startupGate = await Bun.stdin.text();
if (startupGate !== "start\n") {
  throw new Error("Workflow bundler did not receive its exact startup gate.");
}
const request = JSON.parse(await Bun.file(process.argv[1]).text());
const maximumBundleBytes = Number(process.argv[4]);
if (!Number.isSafeInteger(maximumBundleBytes) || maximumBundleBytes < 1) {
  throw new Error("Workflow bundler output byte limit is invalid.");
}
const plugin = {
  name: "transmute-workflow-allowlisted-imports",
  setup(build) {
    for (const [specifier, path] of Object.entries(request.aliases)) {
      const escaped = specifier.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
      build.onResolve({ filter: new RegExp("^" + escaped + "$") }, () => ({ path }));
    }
  },
};
const built = await Bun.build({
  entrypoints: [request.entryPath],
  format: "esm",
  minify: false,
  packages: "bundle",
  plugins: [plugin],
  sourcemap: "none",
  splitting: false,
  target: "bun",
  treeShaking: false,
});
if (!built.success || built.outputs.length !== 1 || built.outputs[0]?.kind !== "entry-point") {
  console.error(JSON.stringify({
    logs: built.logs.map(log => log.message),
    outputs: built.outputs.map(output => ({ kind: output.kind, path: output.path })),
  }));
  process.exit(65);
}
const output = built.outputs[0];
if (
  !Number.isSafeInteger(output.size)
  || output.size < 0
  || output.size > maximumBundleBytes
) {
  console.error("Workflow bundle exceeds " + String(maximumBundleBytes) + " bytes.");
  process.exit(66);
}
await Bun.write(process.argv[2], output);
`;

const BUNDLER_RETIREMENT_GUARDIAN_SOURCE = String.raw`
import { closeSync, fstatSync, lstatSync } from "node:fs";
import { rm } from "node:fs/promises";

const LEASE_FD = 3;
const DIRECTORY_FD = 4;
const POLL_MS = 20;
const CLEANUP_DEADLINE_MS = 5_000;

function argument(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value === "") {
    throw new Error("Missing workflow-bundler guardian argument: " + name);
  }
  return value;
}

const processId = Number(argument("--bundler-pid"));
if (!Number.isSafeInteger(processId) || processId < 2) {
  throw new Error("Workflow-bundler guardian requires a positive process ID.");
}
const expectedIdentity = argument("--bundler-start-identity");
const directoryPath = argument("--directory");
const hasLease = argument("--has-lease") === "true";
const identity = await import(argument("--identity-module"));
const parsedIdentity = identity.parseWorkerProcessStartIdentity(expectedIdentity);
if (hasLease) {
  fstatSync(LEASE_FD);
  const locking = await import(argument("--host-resource-lock-module"));
  if (!locking.tryLockHostResourceDescriptor(LEASE_FD)) {
    throw new Error("Workflow-bundler guardian could not prove inherited lease ownership.");
  }
}
const pinnedDirectory = fstatSync(DIRECTORY_FD, { bigint: true });
if (!pinnedDirectory.isDirectory() || (pinnedDirectory.mode & 0o77n) !== 0n) {
  throw new Error("Workflow-bundler guardian directory descriptor is unsafe.");
}

function sameDirectoryIdentity(details) {
  return (
    details.isDirectory()
    && !details.isSymbolicLink()
    && details.dev === pinnedDirectory.dev
    && details.ino === pinnedDirectory.ino
    && (details.mode & 0o77n) === 0n
  );
}

async function waitForExactDeath() {
  while (
    identity.workerProcessStartIdentityStatus(processId, parsedIdentity)
      !== "different-or-dead"
  ) {
    await Bun.sleep(POLL_MS);
  }
}

async function terminateExactBundler() {
  while (true) {
    const status = identity.workerProcessStartIdentityStatus(
      processId,
      parsedIdentity,
    );
    if (status === "different-or-dead") {
      await waitForExactDeath();
      return;
    }
    if (status === "unknown" || !identity.guardianPinsWorkerProcessId(processId)) {
      await Bun.sleep(POLL_MS);
      continue;
    }
    try {
      process.kill(processId, "SIGKILL");
    } catch (error) {
      if (
        typeof error === "object"
        && error !== null
        && "code" in error
        && Reflect.get(error, "code") === "ESRCH"
      ) return;
      await Bun.sleep(POLL_MS);
      continue;
    }
    break;
  }
  await waitForExactDeath();
}

async function removePinnedDirectory() {
  const deadline = Date.now() + CLEANUP_DEADLINE_MS;
  while (true) {
    let lexical;
    try {
      lexical = lstatSync(directoryPath, { bigint: true });
    } catch (error) {
      if (
        typeof error === "object"
        && error !== null
        && "code" in error
        && Reflect.get(error, "code") === "ENOENT"
      ) return;
      throw error;
    }
    if (!sameDirectoryIdentity(lexical)) {
      throw new Error("Workflow-bundler guardian directory identity changed.");
    }
    try {
      await rm(directoryPath, { force: true, recursive: true });
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      // Filesystems can expose a short ENOTEMPTY/EBUSY tail while recursive
      // deletion drains. Reattest the pinned identity before each retry.
      await Bun.sleep(POLL_MS);
    }
  }
}

await identity.joinAndPinWorkerProcessGroup(processId, parsedIdentity);
let leaseOpen = hasLease;
const releaseLease = () => {
  if (!leaseOpen) return;
  leaseOpen = false;
  closeSync(LEASE_FD);
};
let settling = false;
let input = "";
const settle = async (killBundler, protocolError) => {
  if (settling) return;
  settling = true;
  let failure = protocolError;
  let exactDeathProven = false;
  try {
    if (killBundler) {
      await terminateExactBundler();
      exactDeathProven = true;
    } else if (
      identity.workerProcessStartIdentityStatus(processId, parsedIdentity)
        !== "different-or-dead"
    ) {
      await terminateExactBundler();
      exactDeathProven = true;
      failure = new Error(
        "Workflow-bundler guardian received completion before exact child death.",
      );
    } else {
      exactDeathProven = true;
    }
  } catch (error) {
    failure ??= error;
  }
  if (!exactDeathProven) {
    // Identity uncertainty is never permission to drop machine capacity while
    // the exact child may still be live. Remain fail-closed for supervision.
    process.stderr.write(
      String(failure instanceof Error ? failure.message : failure) + "\n",
    );
    return;
  }
  // The exact bundler is gone. Release scarce machine capacity before scratch
  // deletion, whose failures are bounded and cannot retain a lease.
  releaseLease();
  try {
    await removePinnedDirectory();
  } catch (error) {
    failure ??= error;
  }
  try {
    closeSync(DIRECTORY_FD);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) {
    process.stderr.write(
      String(failure instanceof Error ? failure.message : failure) + "\n",
    );
    process.exit(1);
  }
  process.exit(0);
};

process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  input += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  if (input.length > 64 || !"complete\n".startsWith(input)) {
    void settle(true, new Error("Workflow-bundler guardian received invalid control input."));
    return;
  }
  if (input === "complete\n") void settle(false);
});
process.stdin.once("end", () => {
  void settle(input !== "complete\n");
});
process.stdin.once("error", error => {
  void settle(true, error);
});
for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void settle(true);
  });
}
// The caller may crash after handoff. Closed diagnostic pipes are not a
// retirement failure and must not preempt exact kill-and-cleanup ownership.
process.stdout.on("error", () => undefined);
process.stderr.on("error", () => undefined);
process.stdout.write("ready\n");
`;

export interface WorkflowBundleIdentity {
  readonly bunRevision: string;
  readonly bunVersion: string;
  readonly format: "esm";
  readonly minify: false;
  readonly packages: "bundle";
  readonly schemaVersion: 1;
  readonly sourcemap: "none";
  readonly target: "bun";
  readonly treeShaking: false;
}

export interface WorkflowSourceBundle {
  readonly bytes: Uint8Array;
  readonly dependencyGraphSha256: string;
  readonly entryPath: string;
  readonly entryRelativePath: string;
  readonly externalImports: readonly {
    readonly resolvedPath: string;
    readonly specifier: string;
  }[];
  readonly identity: WorkflowBundleIdentity;
  readonly importedPaths: readonly string[];
  readonly sha256: string;
  readonly sourceSha256: string;
}

export interface BundleWorkflowSourceOptions {
  /**
   * Runs immediately before a previously validated source path is opened.
   * Primarily useful for deterministic file-kind replacement-race audits.
   */
  readonly beforeSourceFileOpened?: (sourcePath: string) => Promise<void> | void;
  /**
   * Runs after a source descriptor is pinned and validated but before its
   * bytes are read. Primarily useful for deterministic replacement-race
   * audits.
   */
  readonly afterSourceFileOpened?: (sourcePath: string) => Promise<void> | void;
  /**
   * Runs only after every local module has been copied into the private,
   * immutable build snapshot. Primarily useful for deterministic audit tests
   * and progress instrumentation.
   */
  readonly afterSourceSnapshot?: () => Promise<void> | void;
  /** Runs after the exact bundler PID is captured. Intended for lifecycle audits. */
  readonly afterBundlerStarted?: (details: {
    readonly processId: number;
    readonly processStartIdentity: string;
    readonly temporaryDirectory: string;
  }) => Promise<void> | void;
  /**
   * Runs after the guardian has pinned the exact gated bundler, inherited the
   * machine lease and cleanup authority, and before the startup gate opens.
   * Intended for deterministic caller-crash audits.
   */
  readonly afterBundlerRetirementGuardianReady?: (details: {
    readonly processId: number;
    readonly processStartIdentity: string;
    readonly temporaryDirectory: string;
  }) => Promise<void> | void;
  readonly allowedBareImports?: readonly string[];
  readonly allowedRoot: string;
  readonly bareImportResolutionRoot?: string;
  readonly entryPath: string;
  /** Combined CPU/local-I/O kernel lease copied into the short-lived bundler. */
  readonly inheritedHostResourceFileDescriptor?: number;
  readonly maximumBundleBytes?: number;
  readonly maximumBundlerDurationMs?: number;
  readonly maximumImportEdges?: number;
  readonly maximumModules?: number;
  readonly maximumSourceBytes?: number;
  readonly maximumTotalSourceBytes?: number;
}

export interface RestoreWorkflowSourceBundleOptions {
  readonly bundle: GraphWorkflowBundleIdentity;
  readonly bytes: Uint8Array;
  readonly externalModules: readonly string[];
}

export const WORKFLOW_BUNDLE_IDENTITY = Object.freeze({
  bunRevision: Bun.revision,
  bunVersion: Bun.version,
  format: "esm" as const,
  minify: false as const,
  packages: "bundle" as const,
  schemaVersion: 1 as const,
  sourcemap: "none" as const,
  target: "bun" as const,
  treeShaking: false as const,
}) satisfies WorkflowBundleIdentity;

interface PhysicalFileIdentity {
  readonly ctimeNs: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
  readonly size: bigint;
}

function physicalFileIdentity(details: BigIntStats): PhysicalFileIdentity {
  return {
    ctimeNs: details.ctimeNs,
    dev: details.dev,
    ino: details.ino,
    mtimeNs: details.mtimeNs,
    size: details.size,
  };
}

function samePhysicalFileIdentity(
  left: PhysicalFileIdentity,
  right: PhysicalFileIdentity,
): boolean {
  return (
    left.ctimeNs === right.ctimeNs
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mtimeNs === right.mtimeNs
    && left.size === right.size
  );
}

function changedPhysicalFile(path: string): ApplicationError {
  return new ApplicationError(
    "invalid-data",
    `Workflow file changed while its exact bytes were being captured: ${path}`,
  );
}

async function assertPathReferencesIdentity(
  path: string,
  expected: PhysicalFileIdentity,
): Promise<string> {
  try {
    const [physicalPath, details] = await Promise.all([
      realpath(path),
      lstat(path, { bigint: true }),
    ]);
    if (
      !details.isFile()
      || details.isSymbolicLink()
      || details.dev !== expected.dev
      || details.ino !== expected.ino
    ) {
      throw changedPhysicalFile(path);
    }
    return physicalPath;
  } catch (error) {
    if (error instanceof ApplicationError) throw error;
    throw changedPhysicalFile(path);
  }
}

async function readBoundedPhysicalFile(options: {
  readonly admitBytes?: (byteLength: number) => void;
  readonly afterOpen?: () => Promise<void> | void;
  readonly expectedPhysicalPath?: string;
  readonly maximumBytes: number;
  readonly path: string;
  readonly tooLargeMessage: string;
}): Promise<Uint8Array> {
  const handle = await open(
    options.path,
    constants.O_RDONLY
      | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const beforeDetails = await handle.stat({ bigint: true });
    if (!beforeDetails.isFile()) throw changedPhysicalFile(options.path);
    if (beforeDetails.size > BigInt(options.maximumBytes)) {
      throw new ApplicationError("invalid-data", options.tooLargeMessage);
    }
    const before = physicalFileIdentity(beforeDetails);
    const beforePhysicalPath = await assertPathReferencesIdentity(options.path, before);
    if (
      options.expectedPhysicalPath !== undefined
      && beforePhysicalPath !== options.expectedPhysicalPath
    ) {
      throw changedPhysicalFile(options.path);
    }
    options.admitBytes?.(Number(before.size));
    await options.afterOpen?.();

    // Allocation follows the descriptor size proof. Positional reads keep the
    // snapshot pinned to this exact inode even if the path is replaced.
    const bytes = new Uint8Array(Number(before.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (result.bytesRead === 0) throw changedPhysicalFile(options.path);
      offset += result.bytesRead;
    }

    const afterDetails = await handle.stat({ bigint: true });
    const after = physicalFileIdentity(afterDetails);
    if (!afterDetails.isFile() || !samePhysicalFileIdentity(before, after)) {
      throw changedPhysicalFile(options.path);
    }
    const afterPhysicalPath = await assertPathReferencesIdentity(options.path, after);
    if (afterPhysicalPath !== beforePhysicalPath) {
      throw changedPhysicalFile(options.path);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function waitForBundlerStartup(options: {
  readonly exit: Promise<number>;
  readonly stream: ReadableStream<Uint8Array>;
}): Promise<void> {
  const reader = options.stream.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new ApplicationError(
      "subprocess",
      "Workflow bundler exceeded its startup handshake deadline.",
    )), BUNDLER_GUARDIAN_HANDSHAKE_MS);
  });
  const exited = options.exit.then(exitCode => {
    throw new ApplicationError(
      "subprocess",
      `Workflow bundler exited during startup (exit ${String(exitCode)}).`,
    );
  });
  void exited.catch(() => undefined);
  let bytes = new Uint8Array(0);
  try {
    while (true) {
      const next = await Promise.race([reader.read(), deadline, exited]);
      if (next.done) {
        throw new ApplicationError(
          "subprocess",
          "Workflow bundler closed its startup handshake stream.",
        );
      }
      const combined = new Uint8Array(bytes.byteLength + next.value.byteLength);
      combined.set(bytes);
      combined.set(next.value, bytes.byteLength);
      bytes = combined;
      if (bytes.byteLength > 64) {
        throw new ApplicationError(
          "subprocess",
          "Workflow bundler exceeded its startup handshake byte limit.",
        );
      }
      const text = new TextDecoder().decode(bytes);
      if (text === "ready\n") return;
      if (!"ready\n".startsWith(text)) {
        throw new ApplicationError(
          "subprocess",
          "Workflow bundler returned an invalid startup handshake.",
        );
      }
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function readBoundedBundlerDiagnostic(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<{ readonly overflowed: boolean; readonly text: string }> {
  const reader = stream.getReader();
  const diagnostic = new Uint8Array(MAX_BUNDLER_DIAGNOSTIC_BYTES);
  let byteLength = 0;
  const cancel = (): void => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = diagnostic.byteLength - byteLength;
      if (next.value.byteLength > remaining) {
        await reader.cancel("Workflow bundler diagnostic byte limit exceeded.")
          .catch(() => undefined);
        return {
          overflowed: true,
          text: new TextDecoder().decode(diagnostic.subarray(0, byteLength)),
        };
      }
      diagnostic.set(next.value, byteLength);
      byteLength += next.value.byteLength;
    }
    return {
      overflowed: false,
      text: new TextDecoder().decode(diagnostic.subarray(0, byteLength)),
    };
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

interface BundlerRetirementGuardian {
  /** Confirms exact child death, removes scratch, and releases the guardian. */
  complete(): Promise<void>;
  /** Rejects if the preinstalled guardian disappears before settlement. */
  readonly failure: Promise<never>;
  /** Parent EOF transfers exact retirement and cleanup after a boundary error. */
  retireDetached(): boolean;
}

function childExit(child: ChildProcess): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise(resolveExit => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

function boundedGuardianDiagnostic(child: ChildProcess): () => string {
  let diagnostic = Buffer.alloc(0);
  child.stderr?.on("data", (chunk: Uint8Array) => {
    diagnostic = Buffer.concat([diagnostic, chunk])
      .subarray(-BUNDLER_GUARDIAN_DIAGNOSTIC_BYTES);
  });
  return () => diagnostic.toString("utf8").trim();
}

async function waitForGuardianLine(options: {
  readonly child: ChildProcess;
  readonly diagnostic: () => string;
  readonly exit: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  readonly expected: string;
  readonly phase: string;
}): Promise<void> {
  const output = options.child.stdout;
  if (output === null) {
    throw new ApplicationError(
      "subprocess",
      "Workflow-bundler retirement guardian has no output stream.",
    );
  }
  await new Promise<void>((resolveLine, rejectLine) => {
    let bytes = Buffer.alloc(0);
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      output.removeListener("data", onData);
      if (error === undefined) resolveLine();
      else rejectLine(error);
    };
    const onData = (chunk: Uint8Array): void => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.byteLength > 64) {
        settle(new ApplicationError(
          "subprocess",
          `Workflow-bundler retirement guardian exceeded its ${options.phase} response bound.`,
        ));
        return;
      }
      const text = bytes.toString("utf8");
      if (text === options.expected) settle();
      else if (!options.expected.startsWith(text)) {
        settle(new ApplicationError(
          "subprocess",
          `Workflow-bundler retirement guardian returned an invalid ${options.phase} response.`,
        ));
      }
    };
    const timer = setTimeout(() => settle(new ApplicationError(
      "subprocess",
      `Workflow-bundler retirement guardian exceeded its ${options.phase} deadline.`,
    )), BUNDLER_GUARDIAN_HANDSHAKE_MS);
    output.on("data", onData);
    void options.exit.then(result => {
      const detail = options.diagnostic();
      settle(new ApplicationError(
        "subprocess",
        `Workflow-bundler retirement guardian exited during ${options.phase} (code ${String(result.code)}, signal ${String(result.signal)})${detail === "" ? "." : `: ${detail}`}`,
      ));
    });
  });
}

async function startBundlerRetirementGuardian(options: {
  readonly bunExecutable: string;
  readonly directory: string;
  readonly inheritedHostResourceFileDescriptor: number;
  readonly processId: number;
  readonly processStartIdentity: string;
}): Promise<BundlerRetirementGuardian> {
  const directory = await open(
    options.directory,
    constants.O_RDONLY
      | (constants.O_DIRECTORY ?? 0)
      | (constants.O_NOFOLLOW ?? 0),
  );
  let guardian: ChildProcess;
  try {
    guardian = spawnNode(
      options.bunExecutable,
      [
        "-e",
        BUNDLER_RETIREMENT_GUARDIAN_SOURCE,
        "guardian",
        "--bundler-pid",
        String(options.processId),
        "--bundler-start-identity",
        options.processStartIdentity,
        "--directory",
        options.directory,
        "--has-lease",
        options.inheritedHostResourceFileDescriptor === 0 ? "false" : "true",
        "--identity-module",
        pathToFileURL(join(import.meta.dir, "worker-process-identity.ts")).href,
        "--host-resource-lock-module",
        pathToFileURL(join(
          import.meta.dir,
          "../../../src/host-resource-posix.ts",
        )).href,
      ],
      {
        env: {
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          PATH: dirname(options.bunExecutable),
        },
        stdio: [
          "pipe",
          "pipe",
          "pipe",
          options.inheritedHostResourceFileDescriptor === 0
            ? "ignore"
            : options.inheritedHostResourceFileDescriptor,
          directory.fd,
        ],
      },
    );
  } finally {
    await directory.close();
  }
  if (
    guardian.stdin === null
    || guardian.stdout === null
    || guardian.stderr === null
  ) {
    guardian.kill("SIGKILL");
    throw new ApplicationError(
      "subprocess",
      "Workflow-bundler retirement guardian did not expose its control streams.",
    );
  }
  const exit = childExit(guardian);
  const diagnostic = boundedGuardianDiagnostic(guardian);
  try {
    await waitForGuardianLine({
      child: guardian,
      diagnostic,
      exit,
      expected: "ready\n",
      phase: "startup",
    });
  } catch (error) {
    guardian.kill("SIGKILL");
    await exit;
    throw error;
  }
  guardian.stdout.resume();
  let settlementRequested: "complete" | "retire" | undefined;
  const failure = new Promise<never>((_resolve, reject) => {
    void exit.then(result => {
      if (settlementRequested !== undefined) return;
      const detail = diagnostic();
      reject(new ApplicationError(
        "subprocess",
        `Workflow-bundler retirement guardian exited before bundling settled (code ${String(result.code)}, signal ${String(result.signal)})${detail === "" ? "." : `: ${detail}`}`,
      ));
    });
  });
  void failure.catch(() => undefined);

  return {
    complete: async () => {
      if (settlementRequested === "retire") {
        throw new ApplicationError(
          "conflict",
          "Workflow-bundler guardian already owns detached retirement.",
        );
      }
      if (settlementRequested === undefined) {
        settlementRequested = "complete";
        if (guardian.exitCode === null && guardian.signalCode === null) {
          await new Promise<void>((resolveWrite, rejectWrite) => {
            const control = guardian.stdin;
            if (control === null) {
              rejectWrite(new Error("Workflow-bundler guardian control pipe is missing."));
              return;
            }
            const onError = (error: Error): void => rejectWrite(error);
            control.once("error", onError);
            control.end("complete\n", () => {
              control.removeListener("error", onError);
              resolveWrite();
            });
          }).catch(error => {
            if (guardian.exitCode === null && guardian.signalCode === null) throw error;
          });
        }
      }
      const result = await exit;
      if (result.code !== 0) {
        const detail = diagnostic();
        throw new ApplicationError(
          "subprocess",
          `Workflow-bundler retirement guardian failed (code ${String(result.code)}, signal ${String(result.signal)})${detail === "" ? "." : `: ${detail}`}`,
        );
      }
    },
    failure,
    retireDetached: () => {
      if (settlementRequested !== undefined) return settlementRequested === "retire";
      if (guardian.exitCode !== null || guardian.signalCode !== null) return false;
      settlementRequested = "retire";
      // The guardian was installed before the bundler's start gate. Closing
      // this liveness pipe transfers exact kill, post-death lease release, and
      // bounded scratch cleanup even if the caller itself is terminating.
      guardian.stdin?.destroy();
      guardian.stdout?.destroy();
      guardian.stderr?.destroy();
      guardian.unref();
      return true;
    },
  };
}

async function bareImportAliases(
  imports: readonly string[],
  resolutionRoot: string,
): Promise<Readonly<Record<string, string>>> {
  const aliases: Record<string, string> = {};
  for (const specifier of imports) {
    if (specifier === "bun" || specifier.startsWith("node:")) continue;
    try {
      const resolvedPath = await Bun.resolve(specifier, resolutionRoot);
      aliases[specifier] = resolvedPath;
    } catch (error) {
      throw new ApplicationError(
        "not-found",
        `Could not resolve allowlisted workflow import ${specifier}: ${String(error)}`,
      );
    }
  }
  return aliases;
}

export function restoreWorkflowSourceBundle(
  options: RestoreWorkflowSourceBundleOptions,
): WorkflowSourceBundle {
  const bytes = new Uint8Array(options.bytes);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (
    bytes.byteLength !== options.bundle.bytes
    || actualSha256 !== options.bundle.bundleSha256
  ) {
    throw new ApplicationError(
      "invalid-data",
      "Persisted workflow bundle bytes do not match their graph-plan identity.",
      {
        actualBytes: bytes.byteLength,
        actualSha256,
        expectedBytes: options.bundle.bytes,
        expectedSha256: options.bundle.bundleSha256,
      },
    );
  }
  if (options.externalModules.length !== 0) {
    throw new ApplicationError(
      "incompatible",
      "This code-worker ABI accepts only self-contained persisted workflow bundles.",
    );
  }
  return Object.freeze({
    bytes,
    dependencyGraphSha256: options.bundle.dependencyGraphSha256,
    entryPath: options.bundle.entrypoint,
    entryRelativePath: options.bundle.entrypoint,
    externalImports: [],
    identity: WORKFLOW_BUNDLE_IDENTITY,
    importedPaths: [],
    sha256: options.bundle.bundleSha256,
    sourceSha256: options.bundle.sourceSha256,
  });
}

async function buildWorkflowBundle(
  entryRelativePath: string,
  modules: readonly CapturedSourceModule[],
  aliases: Readonly<Record<string, string>>,
  configSearchPath: string,
  includeRuntimeTypes: boolean,
  semanticCheck: boolean,
  inheritedHostResourceFileDescriptor: number,
  maximumBundleBytes: number,
  maximumBundlerDurationMs: number,
  afterSourceSnapshot?: () => Promise<void> | void,
  afterBundlerStarted?: BundleWorkflowSourceOptions["afterBundlerStarted"],
  afterBundlerRetirementGuardianReady?: BundleWorkflowSourceOptions["afterBundlerRetirementGuardianReady"],
): Promise<Uint8Array> {
  // The runtime identity records this Bun, so bundling must not silently
  // switch to a different PATH-resolved executable.
  const bunExecutable = process.execPath;
  const directory = await mkdtemp(join(tmpdir(), "transmute-workflow-bundle-"));
  await chmod(directory, 0o700);
  const requestPath = join(directory, "request.json");
  const outputPath = join(directory, "workflow.bundle.js");
  const sourceRoot = join(directory, "source");
  let guardianOwnsCleanup = false;
  try {
    await mkdir(sourceRoot, { mode: 0o700 });
    for (const module of modules) {
      const target = join(sourceRoot, module.relativePath);
      if (!isWithin(sourceRoot, target)) {
        throw new ApplicationError(
          "internal",
          `Captured workflow source escaped its private snapshot: ${module.relativePath}`,
        );
      }
      await mkdir(dirname(target), { mode: 0o700, recursive: true });
      await writeFile(target, module.source, { flag: "wx", mode: 0o400 });
    }
    const entryPath = join(sourceRoot, entryRelativePath);
    await afterSourceSnapshot?.();
    if (semanticCheck) {
      typecheckWorkflowSnapshot({
        aliases,
        configSearchPath,
        entryPath,
        includeRuntimeTypes,
        sourceRoot,
      });
    }
    await writeFile(
      requestPath,
      `${canonicalJson({ aliases, entryPath })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    const child = Bun.spawn(
      [
        bunExecutable,
        "-e",
        BUNDLE_SUBPROCESS_SOURCE,
        requestPath,
        outputPath,
        inheritedHostResourceFileDescriptor === 0 ? "0" : "3",
        String(maximumBundleBytes),
        pathToFileURL(join(import.meta.dir, "worker-process-identity.ts")).href,
      ],
      {
        cwd: sourceRoot,
        env: {
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          PATH: dirname(bunExecutable),
          TMPDIR: directory,
        },
        stdio: [
          "pipe",
          "pipe",
          "pipe",
          ...(inheritedHostResourceFileDescriptor === 0
            ? []
            : [inheritedHostResourceFileDescriptor]),
        ],
      },
    );
    const exitPromise = child.exited;
    const terminate = (): void => {
      try {
        child.kill("SIGKILL");
      } catch {
        // A process that exited between the boundary failure and this signal
        // already released its resources.
      }
    };
    const processId = child.pid;
    if (!Number.isSafeInteger(processId) || processId < 2) {
      terminate();
      await exitPromise;
      throw new ApplicationError(
        "subprocess",
        "Workflow bundler did not expose a valid process ID.",
      );
    }
    let processStartIdentity: string;
    try {
      processStartIdentity = process.platform === "win32"
        ? "0".repeat(64)
        : captureWorkerProcessStartIdentity(processId);
    } catch (error) {
      terminate();
      await exitPromise;
      throw error;
    }
    const diagnosticAbort = new AbortController();
    const diagnosticPromise = readBoundedBundlerDiagnostic(
      child.stderr,
      diagnosticAbort.signal,
    );
    void diagnosticPromise.catch(() => undefined);
    let guardian: BundlerRetirementGuardian | undefined;
    try {
      if (process.platform !== "win32") {
        guardian = await startBundlerRetirementGuardian({
          bunExecutable,
          directory,
          inheritedHostResourceFileDescriptor,
          processId,
          processStartIdentity,
        });
        // From this acknowledgement onward, caller EOF is a durable transfer.
        // The child is still behind its exact startup gate.
        guardianOwnsCleanup = true;
      }
      const startup = waitForBundlerStartup({
        exit: exitPromise,
        stream: child.stdout,
      });
      void startup.catch(() => undefined);
      await (guardian === undefined
        ? startup
        : Promise.race([startup, guardian.failure]));
      await afterBundlerStarted?.({
        processId,
        processStartIdentity,
        temporaryDirectory: directory,
      });
      if (guardian !== undefined) {
        await afterBundlerRetirementGuardianReady?.({
          processId,
          processStartIdentity,
          temporaryDirectory: directory,
        });
      }
      await child.stdin.write("start\n");
      await child.stdin.flush();
      await child.stdin.end();
    } catch (error) {
      diagnosticAbort.abort(error);
      const transferred = guardian?.retireDetached() ?? false;
      if (transferred) {
        child.unref();
      } else {
        guardianOwnsCleanup = false;
        terminate();
        await Promise.allSettled([exitPromise, diagnosticPromise]);
      }
      throw new ApplicationError(
        "subprocess",
        `Workflow bundler startup gate failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const diagnosticBoundary = diagnosticPromise.then(diagnostic => {
      if (diagnostic.overflowed) {
        throw new ApplicationError(
          "invalid-data",
          `Workflow bundler diagnostic exceeds ${String(MAX_BUNDLER_DIAGNOSTIC_BYTES)} bytes.`,
        );
      }
      return diagnostic;
    });
    void diagnosticBoundary.catch(() => undefined);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const deadlinePromise = new Promise<never>((_resolve, reject) => {
      deadline = setTimeout(() => {
        reject(new ApplicationError(
          "unavailable",
          `Workflow bundler exceeded ${String(maximumBundlerDurationMs)} milliseconds.`,
        ));
      }, maximumBundlerDurationMs);
    });
    let exitCode: number;
    let diagnostic: Awaited<typeof diagnosticPromise>;
    try {
      [exitCode, diagnostic] = await Promise.race([
        Promise.all([exitPromise, diagnosticBoundary]),
        deadlinePromise,
        ...(guardian === undefined ? [] : [guardian.failure]),
      ]);
    } catch (error) {
      diagnosticAbort.abort(error);
      const transferred = guardian?.retireDetached() ?? false;
      if (transferred) {
        child.unref();
      } else {
        guardianOwnsCleanup = false;
        terminate();
        await Promise.allSettled([exitPromise, diagnosticPromise]);
      }
      throw error;
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
    }
    let terminalError: Error | undefined;
    let output: Uint8Array | undefined;
    if (exitCode !== 0) {
      terminalError = new ApplicationError(
        "invalid-data",
        `Workflow bundle failed: ${
          diagnostic.text.trim() || `exit ${String(exitCode)}`
        }`,
      );
    } else {
      try {
        output = await readBoundedPhysicalFile({
          maximumBytes: maximumBundleBytes,
          path: outputPath,
          tooLargeMessage: `Workflow bundle exceeds ${String(maximumBundleBytes)} bytes.`,
        });
      } catch (error) {
        terminalError = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (guardian !== undefined) {
      try {
        await guardian.complete();
      } catch (guardianError) {
        if (terminalError === undefined) throw guardianError;
        throw new AggregateError(
          [terminalError, guardianError],
          "Workflow bundling and its retirement guardian both failed.",
        );
      }
    }
    if (terminalError !== undefined) throw terminalError;
    if (output === undefined) {
      throw new ApplicationError("internal", "Workflow bundler omitted its output bytes.");
    }
    return output;
  } finally {
    if (!guardianOwnsCleanup) {
      await rm(directory, { force: true, recursive: true });
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

async function physicalFileWithin(root: string, requested: string): Promise<string> {
  const lexical = resolve(requested);
  if (!isWithin(root, lexical)) {
    throw new ApplicationError("unsafe-path", `Workflow source escapes its allowed root: ${requested}`);
  }
  const details = await lstat(lexical);
  if (details.isSymbolicLink() || !details.isFile()) {
    throw new ApplicationError("unsafe-path", `Workflow source must be a physical regular file: ${requested}`);
  }
  const physical = await realpath(lexical);
  if (!isWithin(root, physical) || physical !== lexical) {
    throw new ApplicationError("unsafe-path", `Workflow source crosses a symbolic link: ${requested}`);
  }
  if (!SOURCE_EXTENSIONS.has(extname(physical))) {
    throw new ApplicationError("usage", `Workflow source has an unsupported extension: ${extname(physical)}`);
  }
  return physical;
}

function allowedBareImport(specifier: string, allowlist: ReadonlySet<string>): boolean {
  if (specifier.startsWith("node:") || specifier === "bun") return true;
  return allowlist.has(specifier);
}

function containsNonliteralDynamicImport(source: Uint8Array): boolean {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  type Mode =
    | { readonly kind: "block-comment" }
    | { readonly kind: "code"; braceDepth: number | undefined }
    | { readonly kind: "line-comment" }
    | { readonly kind: "quoted"; readonly quote: "'" | "\"" }
    | { readonly kind: "template" };
  const modes: Mode[] = [{ kind: "code", braceDepth: undefined }];
  let index = 0;

  while (index < text.length) {
    const mode = modes.at(-1)!;
    const character = text[index]!;
    const next = text[index + 1];
    if (mode.kind === "line-comment") {
      index += 1;
      if (character === "\n" || character === "\r") modes.pop();
      continue;
    }
    if (mode.kind === "block-comment") {
      index += 1;
      if (character === "*" && next === "/") {
        index += 1;
        modes.pop();
      }
      continue;
    }
    if (mode.kind === "quoted") {
      index += 1;
      if (character === "\\") index += 1;
      else if (character === mode.quote) modes.pop();
      continue;
    }
    if (mode.kind === "template") {
      index += 1;
      if (character === "\\") {
        index += 1;
      } else if (character === "`") {
        modes.pop();
      } else if (character === "$" && next === "{") {
        index += 1;
        modes.push({ kind: "code", braceDepth: 1 });
      }
      continue;
    }

    if (character === "/" && next === "/") {
      modes.push({ kind: "line-comment" });
      index += 2;
      continue;
    }
    if (character === "/" && next === "*") {
      modes.push({ kind: "block-comment" });
      index += 2;
      continue;
    }
    if (character === "'" || character === "\"") {
      modes.push({ kind: "quoted", quote: character });
      index += 1;
      continue;
    }
    if (character === "`") {
      modes.push({ kind: "template" });
      index += 1;
      continue;
    }
    if (mode.braceDepth !== undefined && character === "{") {
      mode.braceDepth += 1;
      index += 1;
      continue;
    }
    if (mode.braceDepth !== undefined && character === "}") {
      mode.braceDepth -= 1;
      index += 1;
      if (mode.braceDepth === 0) modes.pop();
      continue;
    }
    if (
      text.startsWith("import", index)
      && !/[A-Za-z0-9_$]/u.test(text[index - 1] ?? "")
      && !/[A-Za-z0-9_$]/u.test(text[index + "import".length] ?? "")
    ) {
      let lookahead = index + "import".length;
      while (lookahead < text.length) {
        if (/\s/u.test(text[lookahead]!)) {
          lookahead += 1;
          continue;
        }
        if (text.startsWith("//", lookahead)) {
          const newline = text.indexOf("\n", lookahead + 2);
          lookahead = newline === -1 ? text.length : newline + 1;
          continue;
        }
        if (text.startsWith("/*", lookahead)) {
          const end = text.indexOf("*/", lookahead + 2);
          lookahead = end === -1 ? text.length : end + 2;
          continue;
        }
        break;
      }
      if (text[lookahead] === "(") return true;
      index = lookahead;
      continue;
    }
    index += 1;
  }
  return false;
}

interface ScannedSourceGraph {
  readonly bareImports: readonly string[];
  readonly dependencyGraphSha256: string;
  readonly importedPaths: readonly string[];
  readonly modules: readonly CapturedSourceModule[];
  readonly sourceSha256: string;
}

interface CapturedSourceModule {
  readonly relativePath: string;
  readonly source: Uint8Array;
}

async function scanSourceGraph(options: {
  readonly afterSourceFileOpened?: (sourcePath: string) => Promise<void> | void;
  readonly beforeSourceFileOpened?: (sourcePath: string) => Promise<void> | void;
  readonly allowedBareImports: ReadonlySet<string>;
  readonly allowedRoot: string;
  readonly entryPath: string;
  readonly maximumImportEdges: number;
  readonly maximumModules: number;
  readonly maximumSourceBytes: number;
  readonly maximumTotalSourceBytes: number;
}): Promise<ScannedSourceGraph> {
  const transpiler = new Bun.Transpiler({ loader: "tsx" });
  const pending = [options.entryPath];
  const visited = new Set<string>();
  const bareImports = new Set<string>();
  let importEdgeCount = 0;
  let totalSourceBytes = 0;
  const modules = new Map<string, {
    readonly bytes: number;
    readonly sha256: string;
    readonly source: Uint8Array;
  }>();
  while (pending.length > 0) {
    const sourcePath = pending.pop()!;
    if (visited.has(sourcePath)) continue;
    if (visited.size >= options.maximumModules) {
      throw new ApplicationError("invalid-data", `Workflow source exceeds ${String(options.maximumModules)} modules.`);
    }
    visited.add(sourcePath);
    const sourceRelativePath = relative(options.allowedRoot, sourcePath);
    const afterSourceFileOpened = options.afterSourceFileOpened;
    await options.beforeSourceFileOpened?.(sourcePath);
    const source = await readBoundedPhysicalFile({
      admitBytes: byteLength => {
        if (byteLength > options.maximumTotalSourceBytes - totalSourceBytes) {
          throw new ApplicationError(
            "invalid-data",
            `Workflow source exceeds ${String(options.maximumTotalSourceBytes)} total bytes.`,
          );
        }
        totalSourceBytes += byteLength;
      },
      ...(afterSourceFileOpened === undefined
        ? {}
        : { afterOpen: async () => await afterSourceFileOpened(sourcePath) }),
      expectedPhysicalPath: sourcePath,
      maximumBytes: options.maximumSourceBytes,
      path: sourcePath,
      tooLargeMessage:
        `Workflow module exceeds ${String(options.maximumSourceBytes)} bytes: ${sourceRelativePath}`,
    });
    modules.set(sourceRelativePath, {
      bytes: source.byteLength,
      sha256: createHash("sha256").update(source).digest("hex"),
      source,
    });
    if (containsNonliteralDynamicImport(source)) {
      throw new ApplicationError(
        "unsupported-plan",
        "Workflow modules cannot use dynamic-import: <nonliteral>",
      );
    }
    let imports: ReturnType<Bun.Transpiler["scanImports"]>;
    try {
      imports = transpiler.scanImports(source);
    } catch (error) {
      throw new ApplicationError("invalid-data", `Could not parse workflow module ${sourcePath}: ${String(error)}`);
    }
    const semanticImports = ts.preProcessFile(
      new TextDecoder().decode(source),
      true,
      true,
    ).importedFiles.map(imported => imported.fileName);
    const moduleImportEdgeCount = Math.max(imports.length, semanticImports.length);
    if (moduleImportEdgeCount > options.maximumImportEdges - importEdgeCount) {
      throw new ApplicationError(
        "invalid-data",
        `Workflow source exceeds ${String(options.maximumImportEdges)} import edges.`,
      );
    }
    importEdgeCount += moduleImportEdgeCount;
    const staticSpecifiers = new Set<string>();
    for (const imported of imports) {
      if (
        imported.kind === "dynamic-import"
        || imported.kind === "require-call"
        || imported.kind === "require-resolve"
      ) {
        throw new ApplicationError(
          "unsupported-plan",
          `Workflow modules cannot use ${imported.kind}: ${imported.path || "<nonliteral>"}`,
        );
      }
      staticSpecifiers.add(imported.path);
    }
    for (const specifier of semanticImports) staticSpecifiers.add(specifier);
    for (const specifier of staticSpecifiers) {
      if (specifier.includes("@hraness/transmute/local/code/testing")) {
        throw new ApplicationError("unsupported-plan", "Production workflows cannot import @hraness/transmute/local/code/testing.");
      }
      if (!specifier.startsWith(".") && !isAbsolute(specifier)) {
        if (!allowedBareImport(specifier, options.allowedBareImports)) {
          throw new ApplicationError("unsupported-plan", `Workflow bare import is not allowlisted: ${specifier}`);
        }
        bareImports.add(specifier);
        continue;
      }
      let resolvedImport: string;
      try {
        resolvedImport = await Bun.resolve(specifier, dirname(sourcePath));
      } catch (error) {
        throw new ApplicationError(
          "not-found",
          `Could not resolve workflow import ${specifier} from ${sourcePath}: ${String(error)}`,
        );
      }
      pending.push(await physicalFileWithin(options.allowedRoot, resolvedImport));
    }
  }
  const importedPaths = Object.freeze([...visited].sort());
  const moduleDescriptors = [...modules]
    .map(([path, value]) => ({
      bytes: value.bytes,
      path,
      sha256: value.sha256,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const entryDescriptor = modules.get(relative(options.allowedRoot, options.entryPath));
  if (entryDescriptor === undefined) {
    throw new ApplicationError("internal", "Workflow source scan omitted its entry module.");
  }
  return Object.freeze({
    bareImports: Object.freeze([...bareImports].sort()),
    dependencyGraphSha256: sha256Hex(
      `studio.workflow.source-graph/v1\0${canonicalJson(moduleDescriptors)}`,
    ),
    importedPaths,
    modules: Object.freeze(
      [...modules]
        .map(([relativePath, value]) => Object.freeze({
          relativePath,
          source: value.source,
        }))
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    ),
    sourceSha256: entryDescriptor.sha256,
  });
}

async function bundleWorkflowSourceInternal(
  options: BundleWorkflowSourceOptions,
  semanticCheck: boolean,
): Promise<WorkflowSourceBundle> {
  const lexicalRoot = resolve(options.allowedRoot);
  const rootDetails = await lstat(lexicalRoot);
  if (rootDetails.isSymbolicLink() || !rootDetails.isDirectory()) {
    throw new ApplicationError("unsafe-path", "Workflow source root must be a physical directory.");
  }
  const allowedRoot = await realpath(lexicalRoot);
  const requestedEntry = resolve(lexicalRoot, options.entryPath);
  if (!isWithin(lexicalRoot, requestedEntry)) {
    throw new ApplicationError(
      "unsafe-path",
      `Workflow source escapes its allowed root: ${options.entryPath}`,
    );
  }
  const entryPath = await physicalFileWithin(
    allowedRoot,
    resolve(allowedRoot, relative(lexicalRoot, requestedEntry)),
  );
  const maximumModules = options.maximumModules ?? MAX_SOURCE_MODULES;
  const maximumSourceBytes = options.maximumSourceBytes ?? MAX_SOURCE_BYTES;
  const maximumTotalSourceBytes =
    options.maximumTotalSourceBytes ?? MAX_TOTAL_SOURCE_BYTES;
  const maximumImportEdges =
    options.maximumImportEdges ?? MAX_SOURCE_IMPORT_EDGES;
  const maximumBundleBytes = options.maximumBundleBytes ?? MAX_BUNDLE_BYTES;
  const maximumBundlerDurationMs =
    options.maximumBundlerDurationMs ?? MAX_BUNDLER_DURATION_MS;
  const inheritedHostResourceFileDescriptor =
    options.inheritedHostResourceFileDescriptor ?? 0;
  if (
    !Number.isSafeInteger(inheritedHostResourceFileDescriptor)
    || inheritedHostResourceFileDescriptor < 0
    || (
      inheritedHostResourceFileDescriptor > 0
      && inheritedHostResourceFileDescriptor < 3
    )
  ) {
    throw new ApplicationError(
      "usage",
      "Workflow bundling requires one safe inherited host-resource descriptor.",
    );
  }
  for (const [label, value] of [
    ["module", maximumModules],
    ["import edge", maximumImportEdges],
    ["source byte", maximumSourceBytes],
    ["total source byte", maximumTotalSourceBytes],
    ["bundle byte", maximumBundleBytes],
    ["bundler duration millisecond", maximumBundlerDurationMs],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new ApplicationError("usage", `Workflow ${label} limit must be a positive safe integer.`);
    }
  }
  if (maximumBundlerDurationMs > MAX_TIMER_DURATION_MS) {
    throw new ApplicationError(
      "usage",
      `Workflow bundler duration cannot exceed ${String(MAX_TIMER_DURATION_MS)} milliseconds.`,
    );
  }
  const allowedBareImports = options.allowedBareImports ?? WORKFLOW_ALLOWED_BARE_IMPORTS;
  const allowedBareImportSet = new Set(allowedBareImports);
  const sourceGraph = await scanSourceGraph({
    ...(options.afterSourceFileOpened === undefined
      ? {}
      : { afterSourceFileOpened: options.afterSourceFileOpened }),
    ...(options.beforeSourceFileOpened === undefined
      ? {}
      : { beforeSourceFileOpened: options.beforeSourceFileOpened }),
    allowedBareImports: allowedBareImportSet,
    allowedRoot,
    entryPath,
    maximumImportEdges,
    maximumModules,
    maximumSourceBytes,
    maximumTotalSourceBytes,
  });
  const aliasSpecifiers = new Set(sourceGraph.bareImports);
  const aliases = await bareImportAliases(
    [...aliasSpecifiers].sort(),
    resolve(options.bareImportResolutionRoot ?? import.meta.dir),
  );
  const entryRelativePath = relative(allowedRoot, entryPath);
  const bytes = await buildWorkflowBundle(
    entryRelativePath,
    sourceGraph.modules,
    aliases,
    resolve(options.bareImportResolutionRoot ?? import.meta.dir),
    (
      sourceGraph.bareImports.some(specifier => (
        specifier === "bun" || specifier.startsWith("node:")
      ))
      || sourceGraph.modules.some(module => (
        /\b(?:Bun|process)\b/u.test(new TextDecoder().decode(module.source))
      ))
    ),
    semanticCheck,
    inheritedHostResourceFileDescriptor,
    maximumBundleBytes,
    maximumBundlerDurationMs,
    options.afterSourceSnapshot,
    options.afterBundlerStarted,
    options.afterBundlerRetirementGuardianReady,
  );
  if (bytes.byteLength > maximumBundleBytes) {
    throw new ApplicationError("invalid-data", `Workflow bundle exceeds ${String(maximumBundleBytes)} bytes.`);
  }
  return Object.freeze({
    bytes,
    dependencyGraphSha256: sourceGraph.dependencyGraphSha256,
    entryPath,
    entryRelativePath,
    externalImports: Object.freeze([]),
    identity: WORKFLOW_BUNDLE_IDENTITY,
    importedPaths: sourceGraph.importedPaths,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sourceSha256: sourceGraph.sourceSha256,
  });
}

/**
 * Low-level exact bundling primitive. Production custom-code entry points use
 * checkAndBundleWorkflowSource so syntax, import policy, and semantic types are
 * all proved over the same captured bytes.
 */
export async function bundleWorkflowSource(
  options: BundleWorkflowSourceOptions,
): Promise<WorkflowSourceBundle> {
  return await bundleWorkflowSourceInternal(options, false);
}

export async function checkAndBundleWorkflowSource(
  options: BundleWorkflowSourceOptions,
): Promise<WorkflowSourceBundle> {
  return await bundleWorkflowSourceInternal(options, true);
}

export function workflowBundleContract(
  bundle: WorkflowSourceBundle,
): GraphWorkflowBundleIdentity {
  return {
    bundleSha256: bundle.sha256,
    bytes: bundle.bytes.byteLength,
    dependencyGraphSha256: bundle.dependencyGraphSha256,
    entrypoint: bundle.entryRelativePath,
    sourceSha256: bundle.sourceSha256,
  };
}
