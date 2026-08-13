import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { dlopen, ptr } from "bun:ffi";

export type WorkerProcessStartIdentityStatus =
  | "exact-live-worker"
  | "different-or-dead"
  | "unknown";

type ProcessRecordInspection =
  | { readonly status: "alive"; readonly rawStartIdentity: string }
  | { readonly status: "dead" | "unknown" };

type DarwinProcessIdentityRecordReader = (
  processId: number,
) => Uint8Array | null;

const DARWIN_PROC_PID_T_BSDINFO_WITH_UNIQID = 18;
const DARWIN_PROC_BSDINFO_SIZE = 136;
const DARWIN_PROC_UNIQIDENTIFIERINFO_SIZE = 56;
const DARWIN_PROC_BSDINFO_WITH_UNIQID_SIZE =
  DARWIN_PROC_BSDINFO_SIZE + DARWIN_PROC_UNIQIDENTIFIERINFO_SIZE;
const DARWIN_PROC_BSDINFO_FLAGS_OFFSET = 0;
const DARWIN_PROC_BSDINFO_STATUS_OFFSET = 4;
const DARWIN_PROC_BSDINFO_PID_OFFSET = 12;
const DARWIN_PROC_BSDINFO_START_SECONDS_OFFSET = 120;
const DARWIN_PROC_BSDINFO_START_MICROSECONDS_OFFSET = 128;
const DARWIN_PROC_UNIQUE_ID_OFFSET = 16;
const DARWIN_PROC_ID_VERSION_OFFSET = 32;
const DARWIN_PROC_FLAG_INEXIT = 0x4;
const DARWIN_PROCESS_STATUS_IDLE = 1;
const DARWIN_PROCESS_STATUS_RUNNING = 2;
const DARWIN_PROCESS_STATUS_SLEEPING = 3;
const DARWIN_PROCESS_STATUS_STOPPED = 4;
const DARWIN_PROCESS_STATUS_ZOMBIE = 5;
const DARWIN_PROCESS_INSPECTION_ATTEMPTS = 3;
const PROCESS_START_IDENTITY_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_PATTERN =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

let cachedBootIdentity: string | undefined;
let cachedDarwinProcPidInfo:
  | ((processId: number, flavor: number, buffer: Uint8Array) => number)
  | undefined;
let cachedProcessGroupFunctions: {
  readonly getProcessGroup: (processId: number) => number;
  readonly setProcessGroup: (processId: number, groupId: number) => number;
} | undefined;

function digestIdentity(kind: string, value: string): string {
  return createHash("sha256")
    .update(kind, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function positiveProcessId(processId: number): number {
  if (!Number.isSafeInteger(processId) || processId < 2) {
    throw new Error("Code-worker process identity requires a positive worker PID.");
  }
  return processId;
}

function processGroupFunctions(): {
  readonly getProcessGroup: (processId: number) => number;
  readonly setProcessGroup: (processId: number, groupId: number) => number;
} {
  if (cachedProcessGroupFunctions !== undefined) {
    return cachedProcessGroupFunctions;
  }
  const libraryPath = process.platform === "darwin"
    ? "/usr/lib/libSystem.B.dylib"
    : process.platform === "linux"
      ? "libc.so.6"
      : undefined;
  if (libraryPath === undefined) {
    throw new Error(
      `Code-worker process groups are unsupported on ${process.platform}.`,
    );
  }
  const library = dlopen(libraryPath, {
    getpgid: {
      args: ["int"],
      returns: "int",
    },
    setpgid: {
      args: ["int", "int"],
      returns: "int",
    },
  } as const);
  cachedProcessGroupFunctions = {
    getProcessGroup: processId => library.symbols.getpgid(processId),
    setProcessGroup: (processId, groupId) => (
      library.symbols.setpgid(processId, groupId)
    ),
  };
  return cachedProcessGroupFunctions;
}

/**
 * Make the worker a process-group leader before any authored module executes.
 * A process-group leader cannot move to another group or create a new session.
 */
export function establishCurrentWorkerProcessGroup(): void {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  const processId = positiveProcessId(process.pid);
  const groups = processGroupFunctions();
  const result = groups.setProcessGroup(0, 0);
  if (
    result !== 0
    && groups.getProcessGroup(0) !== processId
  ) {
    throw new Error("Code worker could not establish its stable process group.");
  }
  if (groups.getProcessGroup(0) !== processId) {
    throw new Error("Code worker process group does not match its process ID.");
  }
}

/**
 * Join the guardian to the exact worker's group. Keeping the guardian in that
 * group pins the numeric worker PID in the kernel until retirement settles,
 * closing the identity-check-to-signal reuse race.
 */
export async function joinAndPinWorkerProcessGroup(
  workerProcessId: number,
  expectedIdentity: string,
  timeoutMilliseconds = 2_000,
): Promise<void> {
  const processId = positiveProcessId(workerProcessId);
  const identity = parseWorkerProcessStartIdentity(expectedIdentity);
  const groups = processGroupFunctions();
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const status = workerProcessStartIdentityStatus(processId, identity);
    if (status === "different-or-dead") {
      throw new Error("Exact code worker exited before its process group was pinned.");
    }
    if (status === "exact-live-worker") {
      groups.setProcessGroup(0, processId);
      if (
        groups.getProcessGroup(0) === processId
        && groups.getProcessGroup(processId) === processId
        && workerProcessStartIdentityStatus(processId, identity)
          === "exact-live-worker"
      ) {
        return;
      }
    }
    await Bun.sleep(20);
  }
  throw new Error("Timed out pinning the exact code-worker process group.");
}

export function guardianPinsWorkerProcessId(workerProcessId: number): boolean {
  if (process.platform !== "linux" && process.platform !== "darwin") return false;
  try {
    const processId = positiveProcessId(workerProcessId);
    return processGroupFunctions().getProcessGroup(0) === processId;
  } catch {
    return false;
  }
}

function processIsDefinitelyMissing(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return false;
  } catch (error) {
    return (
      typeof error === "object"
      && error !== null
      && "code" in error
      && Reflect.get(error, "code") === "ESRCH"
    );
  }
}

function commandText(command: string, arguments_: readonly string[]): string {
  return execFileSync(command, arguments_, {
    encoding: "utf8",
    env: {
      LANG: "C",
      LC_ALL: "C",
      NODE_ENV: "production",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      TZ: "UTC",
    },
    timeout: 2_000,
  }).trim();
}

function bootIdentity(): string {
  if (cachedBootIdentity !== undefined) return cachedBootIdentity;
  let source: string;
  if (process.platform === "linux") {
    source = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (!UUID_PATTERN.test(source)) {
      throw new Error("Linux boot identity is malformed.");
    }
  } else if (process.platform === "darwin") {
    source = commandText("/usr/sbin/sysctl", [
      "-n",
      "kern.bootsessionuuid",
    ]).toLowerCase();
    if (!UUID_PATTERN.test(source)) {
      throw new Error("macOS boot identity is malformed.");
    }
  } else {
    throw new Error(
      `Code-worker process identity is unsupported on ${process.platform}.`,
    );
  }
  cachedBootIdentity = digestIdentity("transmute-worker-boot", source);
  return cachedBootIdentity;
}

function inspectLinuxProcessRecord(raw: string): ProcessRecordInspection {
  // Field 2 (`comm`) may contain spaces and parentheses. Its final `) ` is the
  // only safe boundary before field 3; field 22 (`starttime`) is then index 19.
  const commandEnd = raw.lastIndexOf(") ");
  if (commandEnd < 2) return { status: "unknown" };
  const fields = raw.slice(commandEnd + 2).trim().split(/\s+/u);
  const state = fields[0];
  if (state === "Z" || state === "X" || state === "x") {
    return { status: "dead" };
  }
  if (
    state !== "R"
    && state !== "S"
    && state !== "D"
    && state !== "T"
    && state !== "t"
    && state !== "W"
    && state !== "K"
    && state !== "P"
    && state !== "I"
  ) {
    return { status: "unknown" };
  }
  const startTicks = fields[19];
  if (startTicks === undefined || !/^[1-9][0-9]{0,31}$/u.test(startTicks)) {
    return { status: "unknown" };
  }
  return { status: "alive", rawStartIdentity: startTicks };
}

function inspectDarwinProcessIdentity(
  raw: Uint8Array,
  expectedProcessId: number,
): ProcessRecordInspection {
  if (raw.byteLength < DARWIN_PROC_BSDINFO_WITH_UNIQID_SIZE) {
    return { status: "unknown" };
  }
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const flags = view.getUint32(DARWIN_PROC_BSDINFO_FLAGS_OFFSET, true);
  const status = view.getUint32(DARWIN_PROC_BSDINFO_STATUS_OFFSET, true);
  const processId = view.getUint32(DARWIN_PROC_BSDINFO_PID_OFFSET, true);
  if (processId !== expectedProcessId) return { status: "unknown" };
  if (
    status === DARWIN_PROCESS_STATUS_ZOMBIE
    || (flags & DARWIN_PROC_FLAG_INEXIT) !== 0
  ) {
    return { status: "dead" };
  }
  if (
    status !== DARWIN_PROCESS_STATUS_IDLE
    && status !== DARWIN_PROCESS_STATUS_RUNNING
    && status !== DARWIN_PROCESS_STATUS_SLEEPING
    && status !== DARWIN_PROCESS_STATUS_STOPPED
  ) {
    return { status: "unknown" };
  }
  const startSeconds = view.getBigUint64(
    DARWIN_PROC_BSDINFO_START_SECONDS_OFFSET,
    true,
  );
  const startMicroseconds = view.getBigUint64(
    DARWIN_PROC_BSDINFO_START_MICROSECONDS_OFFSET,
    true,
  );
  const uniqueId = view.getBigUint64(
    DARWIN_PROC_BSDINFO_SIZE + DARWIN_PROC_UNIQUE_ID_OFFSET,
    true,
  );
  const idVersion = view.getUint32(
    DARWIN_PROC_BSDINFO_SIZE + DARWIN_PROC_ID_VERSION_OFFSET,
    true,
  );
  if (
    startSeconds === 0n
    || startMicroseconds >= 1_000_000n
    || uniqueId === 0n
    || idVersion === 0
  ) {
    return { status: "unknown" };
  }
  return {
    status: "alive",
    rawStartIdentity:
      `${uniqueId}:${String(idVersion)}:${startSeconds}:${startMicroseconds}`,
  };
}

function darwinProcPidInfo():
  ((processId: number, flavor: number, buffer: Uint8Array) => number) | null {
  if (cachedDarwinProcPidInfo !== undefined) return cachedDarwinProcPidInfo;
  try {
    const library = dlopen("/usr/lib/libproc.dylib", {
      proc_pidinfo: {
        args: ["int", "int", "u64", "ptr", "int"],
        returns: "int",
      },
    } as const);
    cachedDarwinProcPidInfo = (processId, flavor, buffer) =>
      library.symbols.proc_pidinfo(
        processId,
        flavor,
        0,
        ptr(buffer),
        buffer.byteLength,
      );
  } catch {
    return null;
  }
  return cachedDarwinProcPidInfo;
}

function inspectDarwinProcessWithReader(
  processId: number,
  readRecord: DarwinProcessIdentityRecordReader,
  isDefinitelyMissing: (processId: number) => boolean,
): ProcessRecordInspection {
  for (
    let attempt = 0;
    attempt < DARWIN_PROCESS_INSPECTION_ATTEMPTS;
    attempt += 1
  ) {
    try {
      const raw = readRecord(processId);
      if (raw !== null) {
        const record = inspectDarwinProcessIdentity(raw, processId);
        if (record.status !== "unknown") return record;
      }
    } catch {
      // A failed kernel read is uncertain and receives the same bounded retry.
    }
    if (isDefinitelyMissing(processId)) return { status: "dead" };
  }
  return { status: "unknown" };
}

function inspectDarwinProcess(processId: number): ProcessRecordInspection {
  return inspectDarwinProcessWithReader(
    processId,
    (targetProcessId) => {
      const inspect = darwinProcPidInfo();
      if (inspect === null) return null;
      const processInfo = Buffer.alloc(DARWIN_PROC_BSDINFO_WITH_UNIQID_SIZE);
      const bytesRead = inspect(
        targetProcessId,
        DARWIN_PROC_PID_T_BSDINFO_WITH_UNIQID,
        processInfo,
      );
      if (bytesRead !== DARWIN_PROC_BSDINFO_WITH_UNIQID_SIZE) return null;
      return processInfo;
    },
    processIsDefinitelyMissing,
  );
}

function inspectProcess(processId: number): ProcessRecordInspection {
  try {
    if (process.platform === "linux") {
      return inspectLinuxProcessRecord(
        readFileSync(`/proc/${processId}/stat`, "utf8").trim(),
      );
    }
    if (process.platform === "darwin") {
      return inspectDarwinProcess(processId);
    }
    return { status: "unknown" };
  } catch (error) {
    if (
      processIsDefinitelyMissing(processId)
      || (
        process.platform === "linux"
        && typeof error === "object"
        && error !== null
        && "code" in error
        && Reflect.get(error, "code") === "ENOENT"
      )
    ) {
      return { status: "dead" };
    }
    return { status: "unknown" };
  }
}

function identityFor(
  processId: number,
  rawStartIdentity: string,
): string {
  return digestIdentity(
    "transmute-worker-process-start",
    `${bootIdentity()}\0${String(processId)}\0${rawStartIdentity}`,
  );
}

export function parseWorkerProcessStartIdentity(value: string): string {
  if (!PROCESS_START_IDENTITY_PATTERN.test(value)) {
    throw new Error("Code-worker process start identity is malformed.");
  }
  return value;
}

/** Capture one exact live worker identity; PID alone is never sufficient. */
export function captureWorkerProcessStartIdentity(
  workerProcessId: number,
): string {
  const processId = positiveProcessId(workerProcessId);
  const inspection = inspectProcess(processId);
  if (inspection.status !== "alive") {
    throw new Error("Exact live code-worker process identity is unavailable.");
  }
  return identityFor(processId, inspection.rawStartIdentity);
}

/**
 * Reattest the PID before observing or signaling it. Persistent uncertainty is
 * distinct from death so a guardian retains its inherited lease fail closed.
 */
export function workerProcessStartIdentityStatus(
  workerProcessId: number,
  expectedIdentity: string,
): WorkerProcessStartIdentityStatus {
  let processId: number;
  let identity: string;
  try {
    processId = positiveProcessId(workerProcessId);
    identity = parseWorkerProcessStartIdentity(expectedIdentity);
  } catch {
    return "unknown";
  }
  const inspection = inspectProcess(processId);
  if (inspection.status !== "alive") {
    return inspection.status === "dead" ? "different-or-dead" : "unknown";
  }
  try {
    return identityFor(processId, inspection.rawStartIdentity) === identity
      ? "exact-live-worker"
      : "different-or-dead";
  } catch {
    return "unknown";
  }
}

export function inspectLinuxWorkerProcessRecordForTest(
  raw: string,
): ProcessRecordInspection {
  return inspectLinuxProcessRecord(raw);
}

export function inspectDarwinWorkerProcessIdentityForTest(
  raw: Uint8Array,
  expectedProcessId: number,
): ProcessRecordInspection {
  return inspectDarwinProcessIdentity(raw, expectedProcessId);
}

export function inspectDarwinWorkerProcessWithReaderForTest(
  processId: number,
  readRecord: DarwinProcessIdentityRecordReader,
  isDefinitelyMissing: (processId: number) => boolean,
): ProcessRecordInspection {
  return inspectDarwinProcessWithReader(
    processId,
    readRecord,
    isDefinitelyMissing,
  );
}
