import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";
import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import { installGuardianSignalHandlers } from "./worker-lease-guardian";
import {
  captureWorkerProcessStartIdentity,
  inspectDarwinWorkerProcessIdentityForTest,
  inspectDarwinWorkerProcessWithReaderForTest,
  inspectLinuxWorkerProcessRecordForTest,
  parseWorkerProcessStartIdentity,
  workerProcessStartIdentityStatus,
} from "./worker-process-identity";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "transmute-worker-guardian-"));
  temporaryDirectories.push(directory);
  return directory;
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child: ChildProcess): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  if (childHasExited(child)) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise(resolveExit => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (childHasExited(child)) return;
  child.kill("SIGKILL");
  await waitForChildExit(child);
}

function firstLine(stream: Readable): Promise<string> {
  stream.setEncoding("utf8");
  return new Promise((resolveLine, rejectLine) => {
    let buffered = "";
    const cleanup = (): void => {
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    const onData = (chunk: string): void => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline === -1) return;
      cleanup();
      resolveLine(buffered.slice(0, newline));
    };
    const onEnd = (): void => {
      cleanup();
      rejectLine(new Error("Guardian ended before its ready handshake."));
    };
    const onError = (error: Error): void => {
      cleanup();
      rejectLine(error);
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}

function startIdleWorker(): ChildProcess {
  const identityModule = pathToFileURL(
    join(import.meta.dir, "worker-process-identity.ts"),
  ).href;
  return spawn(process.execPath, ["-e", `
    import { establishCurrentWorkerProcessGroup } from ${JSON.stringify(identityModule)};
    establishCurrentWorkerProcessGroup();
    setInterval(() => {}, 1000);
  `], {
    stdio: "ignore",
  });
}

function startGuardian(options: {
  readonly directory: string;
  readonly workerProcessId: number;
  readonly workerStartIdentity: string;
}): ChildProcess {
  const leasePath = join(options.directory, "lease");
  const leaseFileDescriptor = openSync(leasePath, "w+");
  try {
    return spawn(process.execPath, [
      "run",
      join(import.meta.dir, "worker-lease-guardian.ts"),
      "--worker-pid",
      String(options.workerProcessId),
      "--worker-start-identity",
      options.workerStartIdentity,
    ], {
      env: {
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PATH: dirname(process.execPath),
      },
      stdio: ["pipe", "pipe", "pipe", leaseFileDescriptor],
    });
  } finally {
    closeSync(leaseFileDescriptor);
  }
}

function linuxStat(state: string, startTicks = "424242"): string {
  const fieldsBeforeStart = Array.from(
    { length: 18 },
    (_, index) => String(index + 1),
  );
  return `42 (worker ) name) ${[
    state,
    ...fieldsBeforeStart,
    startTicks,
  ].join(" ")}`;
}

function darwinProcessIdentity(
  processId: number,
  options: {
    readonly flags?: number;
    readonly idVersion?: number;
    readonly startMicroseconds?: bigint;
    readonly startSeconds?: bigint;
    readonly status?: number;
    readonly uniqueId?: bigint;
  } = {},
): Buffer {
  const buffer = Buffer.alloc(192);
  buffer.writeUInt32LE(options.flags ?? 0, 0);
  buffer.writeUInt32LE(options.status ?? 2, 4);
  buffer.writeUInt32LE(processId, 12);
  buffer.writeBigUInt64LE(options.startSeconds ?? 1_722_000_000n, 120);
  buffer.writeBigUInt64LE(options.startMicroseconds ?? 123_456n, 128);
  buffer.writeBigUInt64LE(options.uniqueId ?? 101n, 136 + 16);
  buffer.writeUInt32LE(options.idVersion ?? 7, 136 + 32);
  return buffer;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("code-worker process start identity", () => {
  test("parses Linux start ticks only from a recognized live process", () => {
    expect(inspectLinuxWorkerProcessRecordForTest(linuxStat("R"))).toEqual({
      rawStartIdentity: "424242",
      status: "alive",
    });
    expect(inspectLinuxWorkerProcessRecordForTest(linuxStat("Z"))).toEqual({
      status: "dead",
    });
    expect(inspectLinuxWorkerProcessRecordForTest(linuxStat("Q"))).toEqual({
      status: "unknown",
    });
    expect(inspectLinuxWorkerProcessRecordForTest("42 (worker) R")).toEqual({
      status: "unknown",
    });
  });

  test("uses the macOS kernel unique ID as well as subsecond start time", () => {
    const first = darwinProcessIdentity(42, { uniqueId: 101n });
    const second = darwinProcessIdentity(42, { uniqueId: 102n });
    expect(inspectDarwinWorkerProcessIdentityForTest(first, 42)).toEqual({
      rawStartIdentity: "101:7:1722000000:123456",
      status: "alive",
    });
    expect(inspectDarwinWorkerProcessIdentityForTest(second, 42)).toEqual({
      rawStartIdentity: "102:7:1722000000:123456",
      status: "alive",
    });
    expect(inspectDarwinWorkerProcessIdentityForTest(first, 43)).toEqual({
      status: "unknown",
    });
    expect(
      inspectDarwinWorkerProcessIdentityForTest(
        darwinProcessIdentity(42, { status: 5 }),
        42,
      ),
    ).toEqual({ status: "dead" });
  });

  test("keeps persistent macOS kernel-read uncertainty distinct from death", () => {
    let attempts = 0;
    expect(
      inspectDarwinWorkerProcessWithReaderForTest(
        42,
        () => {
          attempts += 1;
          return Buffer.alloc(8);
        },
        () => false,
      ),
    ).toEqual({ status: "unknown" });
    expect(attempts).toBe(3);
  });

  test("strictly validates serialized identities", () => {
    const identity = "a".repeat(64);
    expect(parseWorkerProcessStartIdentity(identity)).toBe(identity);
    for (const malformed of [
      "",
      "a".repeat(63),
      "A".repeat(64),
      "g".repeat(64),
    ]) {
      expect(() => parseWorkerProcessStartIdentity(malformed)).toThrow(
        "process start identity is malformed",
      );
    }
  });

  test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
    "reattests one exact live process and rejects a different start",
    async () => {
      const first = startIdleWorker();
      const second = startIdleWorker();
      await Promise.all([once(first, "spawn"), once(second, "spawn")]);
      try {
        const firstProcessId = first.pid;
        const secondProcessId = second.pid;
        if (firstProcessId === undefined || secondProcessId === undefined) {
          throw new Error("Idle workers did not expose process IDs.");
        }
        const firstIdentity = captureWorkerProcessStartIdentity(firstProcessId);
        const secondIdentity = captureWorkerProcessStartIdentity(secondProcessId);
        expect(firstIdentity).not.toBe(secondIdentity);
        expect(
          workerProcessStartIdentityStatus(firstProcessId, firstIdentity),
        ).toBe("exact-live-worker");
        expect(
          workerProcessStartIdentityStatus(firstProcessId, secondIdentity),
        ).toBe("different-or-dead");
        await terminateChild(first);
        expect(
          workerProcessStartIdentityStatus(firstProcessId, firstIdentity),
        ).toBe("different-or-dead");
      } finally {
        await Promise.all([terminateChild(first), terminateChild(second)]);
      }
    },
  );
});

describe("code-worker lease guardian", () => {
  test("keeps signal handlers installed throughout asynchronous retirement", () => {
    const signals = new EventEmitter();
    let retirementStarted = false;
    let retirementStarts = 0;
    installGuardianSignalHandlers(signals, () => {
      if (retirementStarted) return;
      retirementStarted = true;
      retirementStarts += 1;
    });

    signals.emit("SIGTERM");
    signals.emit("SIGTERM");
    signals.emit("SIGINT");

    expect(retirementStarts).toBe(1);
    expect(signals.listenerCount("SIGTERM")).toBe(1);
    expect(signals.listenerCount("SIGINT")).toBe(1);
  });

  test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
    "fails closed when the PID does not match the supplied start identity",
    async () => {
      const directory = temporaryDirectory();
      const worker = startIdleWorker();
      const otherWorker = startIdleWorker();
      await Promise.all([once(worker, "spawn"), once(otherWorker, "spawn")]);
      const workerProcessId = worker.pid;
      const otherWorkerProcessId = otherWorker.pid;
      if (workerProcessId === undefined || otherWorkerProcessId === undefined) {
        throw new Error("Idle workers did not expose process IDs.");
      }
      const guardian = startGuardian({
        directory,
        workerProcessId,
        workerStartIdentity:
          captureWorkerProcessStartIdentity(otherWorkerProcessId),
      });
      let diagnostics = "";
      guardian.stderr?.setEncoding("utf8");
      guardian.stderr?.on("data", (chunk: string) => {
        diagnostics += chunk;
      });
      try {
        const result = await waitForChildExit(guardian);
        expect(result.code).toBe(1);
        expect(diagnostics).toContain(
          "could not attest the exact live worker process",
        );
        expect(
          workerProcessStartIdentityStatus(
            workerProcessId,
            captureWorkerProcessStartIdentity(workerProcessId),
          ),
        ).toBe("exact-live-worker");
      } finally {
        await Promise.all([
          terminateChild(guardian),
          terminateChild(worker),
          terminateChild(otherWorker),
        ]);
      }
    },
  );

  test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
    "kills only the attested worker before releasing its lease",
    async () => {
      const directory = temporaryDirectory();
      const worker = startIdleWorker();
      await once(worker, "spawn");
      const workerProcessId = worker.pid;
      if (workerProcessId === undefined) {
        throw new Error("Idle worker did not expose a process ID.");
      }
      const workerStartIdentity =
        captureWorkerProcessStartIdentity(workerProcessId);
      const guardian = startGuardian({
        directory,
        workerProcessId,
        workerStartIdentity,
      });
      try {
        const output = guardian.stdout;
        if (output === null) throw new Error("Guardian stdout is unavailable.");
        expect(await firstLine(output)).toBe("ready");
        guardian.stdin?.end();
        const [guardianResult] = await Promise.all([
          waitForChildExit(guardian),
          waitForChildExit(worker),
        ]);
        expect(guardianResult).toEqual({ code: 0, signal: null });
        expect(
          workerProcessStartIdentityStatus(
            workerProcessId,
            workerStartIdentity,
          ),
        ).toBe("different-or-dead");
      } finally {
        await Promise.all([terminateChild(guardian), terminateChild(worker)]);
      }
    },
  );
});
