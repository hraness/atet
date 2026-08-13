import { fstatSync } from "node:fs";

import {
  guardianPinsWorkerProcessId,
  joinAndPinWorkerProcessGroup,
  parseWorkerProcessStartIdentity,
  workerProcessStartIdentityStatus,
} from "./worker-process-identity";

const POLL_MILLISECONDS = 20;
const INHERITED_LEASE_FILE_DESCRIPTOR = 3;

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value === "") {
    throw new Error(`Missing code-worker lease-guardian argument: ${name}`);
  }
  return value;
}

function positiveProcessId(value: string): number {
  const processId = Number(value);
  if (!Number.isSafeInteger(processId) || processId < 2) {
    throw new Error("Code-worker lease guardian requires a positive worker PID.");
  }
  return processId;
}

async function waitForWorkerExit(
  processId: number,
  expectedIdentity: string,
): Promise<void> {
  while (
    workerProcessStartIdentityStatus(processId, expectedIdentity)
    !== "different-or-dead"
  ) {
    // Unknown identity is not evidence of death. Retain the inherited lease
    // until the exact worker is absent or its PID belongs to another process.
    await Bun.sleep(POLL_MILLISECONDS);
  }
}

async function terminateWorker(
  processId: number,
  expectedIdentity: string,
): Promise<void> {
  while (true) {
    const status = workerProcessStartIdentityStatus(
      processId,
      expectedIdentity,
    );
    if (status === "different-or-dead") return;
    if (status === "unknown") {
      await Bun.sleep(POLL_MILLISECONDS);
      continue;
    }
    if (!guardianPinsWorkerProcessId(processId)) {
      // Losing the kernel pin is uncertainty, never permission to signal a
      // reusable numeric PID or release the inherited machine lease.
      await Bun.sleep(POLL_MILLISECONDS);
      continue;
    }
    try {
      // The start identity was reattested immediately before signaling, and
      // this guardian's membership in the worker-led process group keeps that
      // numeric PID allocated across the check-to-signal boundary.
      process.kill(processId, "SIGKILL");
    } catch (error) {
      if (
        typeof error === "object"
        && error !== null
        && "code" in error
        && Reflect.get(error, "code") === "ESRCH"
      ) {
        return;
      }
      // Permission or transient kernel errors are uncertainty, not permission
      // to release the lease. Retry while the exact process remains attested.
      await Bun.sleep(POLL_MILLISECONDS);
      continue;
    }
    break;
  }
  // Retain the inherited kernel lease until the worker is observably gone.
  await waitForWorkerExit(processId, expectedIdentity);
}

type GuardianSignalSource = {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
};

export function installGuardianSignalHandlers(
  signalSource: GuardianSignalSource,
  settle: () => void,
): void {
  // Handlers stay installed while asynchronous retirement is in flight. A
  // repeated signal must not restore the default action and drop the lease.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    signalSource.on(signal, settle);
  }
}

async function main(): Promise<void> {
  if (process.platform === "win32") {
    throw new Error("Code-worker lease guardians require POSIX descriptors.");
  }
  const workerProcessId = positiveProcessId(argument("--worker-pid"));
  const workerStartIdentity = parseWorkerProcessStartIdentity(
    argument("--worker-start-identity"),
  );
  fstatSync(INHERITED_LEASE_FILE_DESCRIPTOR);
  if (
    workerProcessStartIdentityStatus(workerProcessId, workerStartIdentity)
    !== "exact-live-worker"
  ) {
    throw new Error(
      "Code-worker lease guardian could not attest the exact live worker process.",
    );
  }
  await joinAndPinWorkerProcessGroup(
    workerProcessId,
    workerStartIdentity,
  );

  let completed = false;
  let settling = false;
  let input = "";
  const settle = async (killWorker: boolean): Promise<void> => {
    if (settling) return;
    settling = true;
    if (killWorker) {
      await terminateWorker(workerProcessId, workerStartIdentity);
    }
    process.exit(0);
  };

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    input += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (input.length > 64 || (!"complete\n".startsWith(input) && input !== "complete\n")) {
      void settle(true);
      return;
    }
    if (input === "complete\n") {
      completed = true;
      void settle(false);
    }
  });
  process.stdin.once("end", () => {
    void settle(!completed);
  });
  process.stdin.once("error", () => {
    void settle(true);
  });
  installGuardianSignalHandlers(process, () => {
    void settle(true);
  });

  const workerPoll = setInterval(() => {
    if (
      workerProcessStartIdentityStatus(workerProcessId, workerStartIdentity)
      === "different-or-dead"
    ) {
      void settle(false);
    }
  }, POLL_MILLISECONDS);
  workerPoll.unref();
  process.stdout.write("ready\n");
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
