import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Fiber } from "effect";

import {
  operationBoundary,
  operationExitValue,
  operationFinally,
  runStandaloneOperation,
  type OperationEffectFailure,
} from "../application/operation-effects";
import {
  AtomicRenderPlatform,
  executeAtomicRenderEffect,
  type AtomicRenderPlatformService,
  type AtomicRenderRequest,
} from "./atomic-render-effects";
import { nativeAtomicRenderPlatform } from "./atomic-render-platform";
import type { RunResult } from "./io";

function failure(cause: unknown): OperationEffectFailure {
  return { _tag: "OperationBoundaryFailure", phase: "cleanup", cause };
}

function priorEvidence(cause: Cause.Cause<OperationEffectFailure>): { values: unknown[]; interrupted: boolean } {
  const values: unknown[] = [];
  let interrupted = Cause.isInterrupted(cause);
  for (const failure of Cause.failures(cause)) {
    values.push(failure.cause);
    if (failure.priorCause !== undefined) {
      const prior = priorEvidence(failure.priorCause);
      values.push(...prior.values);
      interrupted ||= prior.interrupted;
    }
  }
  return { values, interrupted };
}

function request(directory: string): AtomicRenderRequest {
  const finalOutputPath = join(directory, "output.mp4");
  return {
    argv: ["ffmpeg", "-y", finalOutputPath],
    failureLabel: "Fixture render failed",
    finalOutputPath,
    maximumOutputBytes: 1024,
    runner: {
      run: async argv => {
        await fs.writeFile(argv.at(-1)!, "encoded output");
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    },
  };
}

function render(input: AtomicRenderRequest, platform: AtomicRenderPlatformService) {
  return executeAtomicRenderEffect(input, { prepare: () => Effect.void })
    .pipe(Effect.provideService(AtomicRenderPlatform, platform));
}

test("final native publication rejects revoked custody and mutations made during the final fence", async () => {
  for (const attack of ["revoke", "rewrite", "symlink"] as const) {
    const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "slopcamera-final-render-fence-")));
    try {
      const input = request(directory);
      const external = join(directory, "external.mp4");
      await fs.writeFile(external, "other output");
      const result = await Effect.runPromiseExit(render({ ...input, requireFreshOutput: true, beforeNativePublish: async staged => {
        if (attack === "revoke") throw new Error("custody revoked");
        if (attack === "rewrite") await fs.writeFile(staged, "changed output");
        else { await fs.rm(staged); await fs.symlink(external, staged); }
      } }, nativeAtomicRenderPlatform));
      expect(Exit.isFailure(result)).toBe(true);
      await expect(fs.lstat(input.finalOutputPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(external, "utf8")).toBe("other output");
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
});

async function flushInterruption(): Promise<void> {
  // An event-loop fence, not a timer racing the native operation under test.
  await new Promise<void>(resolve => { setImmediate(resolve); });
}

async function outcome(promise: Promise<unknown>) {
  return await promise.then(
    value => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
}

test("interruption joins the real descriptor verification before close or staging cleanup", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "slopcamera-hash-custody-"));
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const nativeOpen = fs.open;
  const events: string[] = [];
  let stagingPath: string | undefined;
  const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await nativeOpen(...args);
    if (args[0] !== stagingPath) return handle;
    const sync = handle.sync.bind(handle);
    const close = handle.close.bind(handle);
    handle.sync = async () => {
      events.push("verify:held");
      entered.resolve();
      await release.promise;
      await sync();
      events.push("verify:resumed");
    };
    handle.close = async () => {
      events.push("descriptor:close");
      await close();
    };
    return handle;
  });
  const platform: AtomicRenderPlatformService = {
    ...nativeAtomicRenderPlatform,
    stage: (input, companion) => Effect.tap(nativeAtomicRenderPlatform.stage(input, companion), staging => Effect.sync(() => {
      stagingPath = staging.path;
    })),
    cleanup: staging => Effect.zipRight(Effect.sync(() => { events.push("staging:cleanup"); }), nativeAtomicRenderPlatform.cleanup(staging)),
  };
  const fiber = Effect.runFork(render(request(directory), platform));
  try {
    await entered.promise;
    await Effect.runPromise(Fiber.interruptFork(fiber));
    await flushInterruption();
    expect(events).toEqual(["verify:held"]);
    release.resolve();
    expect(Exit.isFailure(await Effect.runPromise(Fiber.await(fiber)))).toBe(true);
    expect(events).toEqual(["verify:held", "verify:resumed", "descriptor:close", "staging:cleanup"]);
    expect(await fs.readdir(directory)).toEqual([]);
  } finally {
    release.resolve();
    await Effect.runPromise(Fiber.interrupt(fiber));
    openSpy.mockRestore();
    await fs.rm(directory, { force: true, recursive: true });
  }
});

test.each([undefined, null, false, new Error("abort cleanup")])(
  "a failed abort (%p) still joins a process acquired immediately before interruption",
  async abortFailure => {
    const directory = await fs.mkdtemp(join(tmpdir(), "slopcamera-process-custody-"));
    const acquired = Promise.withResolvers<void>();
    const handoff = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const completion = Promise.withResolvers<RunResult>();
    const executionFailure = new Error("held encoder failure");
    const events: string[] = [];
    const input = { ...request(directory), runner: { run: () => completion.promise } };
    const platform: AtomicRenderPlatformService = {
      ...nativeAtomicRenderPlatform,
      start: (staging, options) => Effect.flatMap(nativeAtomicRenderPlatform.start(staging, options), process => Effect.as(
        operationBoundary("media", async () => { acquired.resolve(); await handoff.promise; }),
        {
          result: process.result,
          abort: () => Effect.zipRight(Effect.sync(() => { events.push("abort"); aborted.resolve(); }), Effect.fail(failure(abortFailure))),
          detach: () => Effect.zipRight(Effect.sync(() => { events.push("detach"); }), process.detach()),
        },
      )),
      cleanup: staging => Effect.zipRight(Effect.sync(() => { events.push("cleanup"); }), nativeAtomicRenderPlatform.cleanup(staging)),
    };
    const fiber = Effect.runFork(render(input, platform));
    const originalKeys = abortFailure instanceof Error ? Reflect.ownKeys(abortFailure) : [];
    try {
      await acquired.promise;
      await Effect.runPromise(Fiber.interruptFork(fiber));
      handoff.resolve();
      await aborted.promise;
      await flushInterruption();
      expect(events).toEqual(["abort"]);
      completion.reject(executionFailure);
      const exit = await Effect.runPromise(Fiber.await(fiber));
      const projected = await outcome(Promise.resolve().then(() => operationExitValue(exit)));
      expect(projected.status).toBe("rejected");
      if (projected.status === "rejected") expect(Object.is(projected.reason, abortFailure)).toBe(true);
      expect(events).toEqual(["abort", "detach", "cleanup"]);
      if (Exit.isFailure(exit)) {
        const failures = Array.from(Cause.failures(exit.cause));
        expect(failures).toHaveLength(1);
        const evidence = priorEvidence(exit.cause);
        expect(evidence.values.some(value => value === executionFailure)).toBe(true);
        expect(evidence.interrupted).toBe(true);
      }
      if (abortFailure instanceof Error) expect(Reflect.ownKeys(abortFailure)).toEqual(originalKeys);
    } finally {
      handoff.resolve();
      completion.resolve({ exitCode: 0, stderr: "", stdout: "" });
      await Effect.runPromise(Fiber.interrupt(fiber));
      await fs.rm(directory, { force: true, recursive: true });
    }
  },
);

test.each([false, true])("native process settlement joins an active poll and retains its late failure (%s)", async failPoll => {
  const directory = await fs.mkdtemp(join(tmpdir(), "slopcamera-poll-custody-"));
  const polling = Promise.withResolvers<void>();
  const releasePoll = Promise.withResolvers<void>();
  const completion = Promise.withResolvers<RunResult>();
  const events: string[] = [];
  const platform: AtomicRenderPlatformService = {
    ...nativeAtomicRenderPlatform,
    start: (staging, input) => Effect.map(nativeAtomicRenderPlatform.start(staging, input), process => ({
      ...process,
      detach: () => Effect.zipRight(Effect.sync(() => { events.push("detach"); }), process.detach()),
    })),
    outputSize: () => operationBoundary("media", async () => {
      events.push("poll:held");
      polling.resolve();
      await releasePoll.promise;
      events.push("poll:settled");
      if (failPoll) throw undefined;
      return null;
    }),
    cleanup: staging => Effect.zipRight(Effect.sync(() => { events.push("cleanup"); }), nativeAtomicRenderPlatform.cleanup(staging)),
  };
  const fiber = Effect.runFork(render({ ...request(directory), runner: { run: () => completion.promise } }, platform));
  try {
    await polling.promise;
    completion.reject(false);
    await flushInterruption();
    expect(events).toEqual(["poll:held"]);
    releasePoll.resolve();
    const exit = await Effect.runPromise(Fiber.await(fiber));
    const projected = await outcome(Promise.resolve().then(() => operationExitValue(exit)));
    expect(projected.status).toBe("rejected");
    if (projected.status === "rejected") {
      if (failPoll) expect(projected.reason).toMatchObject({ code: "unavailable" });
      else expect(projected.reason).toBe(false);
    }
    if (failPoll && Exit.isFailure(exit)) {
      const evidence = priorEvidence(exit.cause);
      expect(evidence.values).toContain(undefined);
      expect(evidence.values).toContain(false);
    }
    expect(events).toEqual(["poll:held", "poll:settled", "detach", "cleanup"]);
  } finally {
    releasePoll.resolve();
    completion.resolve({ exitCode: 0, stderr: "", stdout: "" });
    await Effect.runPromise(Fiber.interrupt(fiber));
    await fs.rm(directory, { force: true, recursive: true });
  }
});

test.each([undefined, null, false, new Error("temporary cleanup")])(
  "native temporary cleanup retains its selected rejection (%p) without decorating errors",
  async cleanupFailure => {
    const directory = await fs.mkdtemp(join(tmpdir(), "slopcamera-cleanup-precedence-"));
    const primary = new Error("private earlier execution sentinel");
    const keys = cleanupFailure instanceof Error ? Reflect.ownKeys(cleanupFailure) : [];
    try {
      const platform: AtomicRenderPlatformService = {
        ...nativeAtomicRenderPlatform,
        cleanup: staging => operationFinally(nativeAtomicRenderPlatform.cleanup(staging), Effect.fail(failure(cleanupFailure))),
      };
      const observed = await outcome(runStandaloneOperation(render({
        ...request(directory), runner: { run: () => Promise.reject(primary) },
      }, platform)));
      expect(observed.status).toBe("rejected");
      if (observed.status === "rejected") {
        expect(Object.is(observed.reason, cleanupFailure)).toBe(true);
        expect(String(observed.reason)).not.toContain("private earlier execution sentinel");
      }
      if (cleanupFailure instanceof Error) expect(Reflect.ownKeys(cleanupFailure)).toEqual(keys);
      expect(await fs.readdir(directory)).toEqual([]);
    } finally {
      await fs.rm(directory, { force: true, recursive: true });
    }
  },
);

test("successful undefined is distinct from rejected undefined at the compatibility root", async () => {
  expect(await outcome(runStandaloneOperation(operationFinally(Effect.void, Effect.void))))
    .toEqual({ status: "fulfilled", value: undefined });
  expect(await outcome(runStandaloneOperation(operationFinally(Effect.void, Effect.fail(failure(undefined))))))
    .toEqual({ status: "rejected", reason: undefined });
});
