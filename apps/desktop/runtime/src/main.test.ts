import { afterEach, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { ATET_DESKTOP_PROTOCOL_VERSION } from "../../contracts";
import {
  HostResponseSchema,
  MAX_HOST_LINE_BYTES,
  MAX_PENDING_HOST_REQUESTS,
} from "./host-protocol";
import {
  resolveRuntimeRepositoryRoot,
  runGatewayProtocol,
  type RuntimeGatewayService,
} from "./main";

const temporaryDirectories: string[] = [];

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => resolvePromise?.(),
  };
}

async function rejectedError(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("Expected operation to reject with an Error.");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => await rm(path, {
    force: true,
    recursive: true,
  })));
});

async function fixture(): Promise<{ readonly executable: string; readonly home: string; readonly runtime: string }> {
  const home = await mkdtemp(join(tmpdir(), "atet-runtime-home-"));
  temporaryDirectories.push(home);
  const runtime = join(home, "packaged", "Contents", "Resources", "runtime");
  await mkdir(join(runtime, "bin"), { recursive: true });
  const executable = join(runtime, "bin", "atet-gateway");
  await writeFile(executable, "gateway\n");
  return { executable, home: await realpath(home), runtime };
}

function hostRequest(id: string, payload: unknown = {}): string {
  return JSON.stringify({
    command: "atet.runtime.snapshot",
    id,
    payload,
  });
}

async function runProtocolChunks(
  chunks: readonly (string | Uint8Array)[],
): Promise<{
  readonly handled: readonly unknown[];
  readonly responses: readonly ReturnType<typeof HostResponseSchema.parse>[];
}> {
  const handled: unknown[] = [];
  const lines: string[] = [];
  const service: RuntimeGatewayService = {
    close: () => Promise.resolve(),
    handle: (requestValue) => {
      handled.push(requestValue);
      return Promise.reject(new Error("deliberate test rejection"));
    },
    initialize: () => Promise.resolve(),
  };
  await runGatewayProtocol({
    createService: () => service,
    input: Readable.from(chunks),
    writeLine: (line) => {
      lines.push(line);
      return Promise.resolve();
    },
  });
  return {
    handled,
    responses: lines.map((line) => HostResponseSchema.parse(JSON.parse(line) as unknown)),
  };
}

test("explicit workspace configuration wins without requiring a source checkout", async () => {
  const { executable, home } = await fixture();
  const workspace = join(home, "chosen-workspace");
  await mkdir(workspace);

  expect(await resolveRuntimeRepositoryRoot({
    environmentValue: workspace,
    executablePath: executable,
    homeDirectory: home,
  })).toBe(await realpath(workspace));
});

test("packaged gateway creates user-owned state independent of its bundle location", async () => {
  const { executable, home } = await fixture();
  const first = await resolveRuntimeRepositoryRoot({
    environmentValue: "",
    executablePath: executable,
    homeDirectory: home,
  });
  const movedExecutable = join(home, "relocated", "Renamed.app", "Contents", "Resources", "runtime", "bin", "atet-gateway");

  expect(first).toBe(join(home, "Movies", "Atet"));
  expect(await resolveRuntimeRepositoryRoot({
    environmentValue: "",
    executablePath: movedExecutable,
    homeDirectory: home,
  })).toBe(first);
  expect((await lstat(first!)).mode & 0o777).toBe(0o700);
});

test("runtime workspace selection rejects relative configuration and symlink defaults", async () => {
  const { home } = await fixture();
  expect(resolveRuntimeRepositoryRoot({ environmentValue: "relative/path", homeDirectory: home }))
    .rejects.toThrow(/absolute/u);

  const target = join(home, "target");
  await mkdir(target);
  await mkdir(join(home, "Movies"));
  await symlink(target, join(home, "Movies", "Atet"));
  expect(resolveRuntimeRepositoryRoot({ environmentValue: "", homeDirectory: home }))
    .rejects.toThrow(/physical directory/u);
});

test("a single huge input chunk is discarded without losing the following frame", async () => {
  const validLine = `${hostRequest("after-huge", { sequence: 1 })}\n`;
  const validBytes = new TextEncoder().encode(validLine);
  const oversizedBytes = MAX_HOST_LINE_BYTES * 32;
  const chunk = new Uint8Array(oversizedBytes + 1 + validBytes.byteLength);
  chunk.fill(0x61, 0, oversizedBytes);
  chunk[oversizedBytes] = 0x0a;
  chunk.set(validBytes, oversizedBytes + 1);

  const result = await runProtocolChunks([chunk]);

  expect(result.handled).toEqual([{ sequence: 1 }]);
  expect(result.responses.map((response) => response.id)).toEqual(["invalid", "after-huge"]);
  expect(result.responses[0]).toMatchObject({
    error: { code: "invalid_request", message: "Request line is oversized." },
    ok: false,
  });
});

test("line limits and CRLF framing are invariant across chunk boundaries", async () => {
  const emptyPaddingLine = hostRequest("exact-boundary", { padding: "" });
  const paddingLength = MAX_HOST_LINE_BYTES - Buffer.byteLength(emptyPaddingLine);
  const exactBoundaryLine = hostRequest("exact-boundary", { padding: "x".repeat(paddingLength) });
  expect(Buffer.byteLength(exactBoundaryLine)).toBe(MAX_HOST_LINE_BYTES);
  const recoveredLine = `${hostRequest("after-split-overflow", { sequence: 2 })}\n`;

  const result = await runProtocolChunks([
    exactBoundaryLine.slice(0, 17),
    exactBoundaryLine.slice(17),
    "\r",
    "\n",
    "a".repeat(MAX_HOST_LINE_BYTES),
    "b",
    `\n${recoveredLine.slice(0, 11)}`,
    recoveredLine.slice(11),
  ]);

  expect(result.handled).toEqual([
    { padding: "x".repeat(paddingLength) },
    { sequence: 2 },
  ]);
  expect(result.responses.map((response) => response.id)).toEqual([
    "exact-boundary",
    "invalid",
    "after-split-overflow",
  ]);
  expect(result.responses[1]).toMatchObject({
    error: { code: "invalid_request", message: "Request line is oversized." },
    ok: false,
  });
});

test("malformed UTF-8 rejects while emoji split across string chunks remains exact", async () => {
  const emojiRequest = hostRequest("emoji", { caption: "ready 🎥" });
  const split = emojiRequest.indexOf("🎥") + 1;
  const malformedLine = Uint8Array.from([0xc3, 0x28, 0x0a]);

  const result = await runProtocolChunks([
    malformedLine,
    emojiRequest.slice(0, split),
    `${emojiRequest.slice(split)}\n`,
  ]);

  expect(result.handled).toEqual([{ caption: "ready 🎥" }]);
  expect(result.responses.map((response) => response.id)).toEqual(["invalid", "emoji"]);
  expect(result.responses[0]).toMatchObject({
    error: { code: "invalid_request", message: "Request line is not valid UTF-8." },
    ok: false,
  });

  const byteRequest = new TextEncoder().encode(`${hostRequest("emoji-bytes", { caption: "ready 🎥" })}\n`);
  const emojiStart = byteRequest.indexOf(0xf0);
  const byteResult = await runProtocolChunks([
    byteRequest.subarray(0, emojiStart + 2),
    byteRequest.subarray(emojiStart + 2),
  ]);
  expect(byteResult.handled).toEqual([{ caption: "ready 🎥" }]);
  expect(byteResult.responses.map((response) => response.id)).toEqual(["emoji-bytes"]);
});

test("EOF settles complete and discarded final frames deterministically", async () => {
  const complete = await runProtocolChunks([hostRequest("without-newline", { complete: true })]);
  expect(complete.handled).toEqual([{ complete: true }]);
  expect(complete.responses.map((response) => response.id)).toEqual(["without-newline"]);

  const oversized = await runProtocolChunks(["x".repeat(MAX_HOST_LINE_BYTES + 1)]);
  expect(oversized.handled).toEqual([]);
  expect(oversized.responses).toHaveLength(1);
  expect(oversized.responses[0]).toMatchObject({
    error: { code: "invalid_request", message: "Request line is oversized." },
    id: "invalid",
    ok: false,
  });
});

test("iterator failure still closes the owned service", async () => {
  let closeCount = 0;
  const service: RuntimeGatewayService = {
    close: () => {
      closeCount += 1;
      return Promise.resolve();
    },
    handle: () => Promise.reject(new Error("unused")),
    initialize: () => Promise.resolve(),
  };
  const input = async function* (): AsyncGenerator<string> {
    await Promise.resolve();
    yield `${hostRequest("before-error")}\n`;
    throw new Error("input exploded");
  };

  const error = await rejectedError(runGatewayProtocol({
    createService: () => service,
    input: input(),
    writeLine: () => Promise.resolve(),
  }));
  expect(error.message).toBe("input exploded");
  expect(closeCount).toBe(1);
});

test("a stalled initialization is aborted at its finite deadline and still closes", async () => {
  const diagnostics: string[] = [];
  let closeCount = 0;
  let initializationSignal: AbortSignal | undefined;
  const startedAt = performance.now();

  const error = await rejectedError(runGatewayProtocol({
    createService: () => ({
      close: () => {
        closeCount += 1;
        return Promise.resolve();
      },
      handle: () => Promise.reject(new Error("unused")),
      initialize: (abortSignal) => {
        initializationSignal = abortSignal;
        return new Promise<void>(() => undefined);
      },
    }),
    diagnostic: (message) => diagnostics.push(message),
    initializationAbortGraceMs: 15,
    initializationTimeoutMs: 20,
    input: Readable.from([]),
    shutdownTimeoutMs: 20,
    writeLine: () => Promise.resolve(),
  }));

  expect(error.message).toBe("Runtime service initialization exceeded its time bound.");
  expect(performance.now() - startedAt).toBeLessThan(500);
  expect(initializationSignal?.aborted).toBe(true);
  expect(closeCount).toBe(1);
  expect(diagnostics).toContain("runtime initialization did not settle after cancellation");
  expect(diagnostics).toContain("runtime initialization exceeded its time bound");
});

test("an external lifecycle abort cancels stalled initialization and closes without reading input", async () => {
  const initializationStarted = deferred();
  const lifecycleController = new AbortController();
  let closeCount = 0;
  let inputReads = 0;
  const input = async function* (): AsyncGenerator<string> {
    await Promise.resolve();
    inputReads += 1;
    yield "not-json\n";
  };
  const protocol = runGatewayProtocol({
    createService: () => ({
      close: () => {
        closeCount += 1;
        return Promise.resolve();
      },
      handle: () => Promise.reject(new Error("unused")),
      initialize: async (abortSignal) => {
        initializationStarted.resolve();
        if (abortSignal.aborted) throw abortSignal.reason;
        await new Promise<void>((_resolve, reject) => {
          abortSignal.addEventListener("abort", () => reject(
            abortSignal.reason instanceof Error
              ? abortSignal.reason
              : new Error("Runtime initialization was cancelled."),
          ), { once: true });
        });
      },
    }),
    initializationAbortGraceMs: 20,
    initializationTimeoutMs: 1_000,
    input: input(),
    lifecycleSignal: lifecycleController.signal,
    shutdownTimeoutMs: 20,
    writeLine: () => Promise.resolve(),
  });
  await initializationStarted.promise;

  lifecycleController.abort(new Error("test termination signal"));
  await protocol;

  expect(closeCount).toBe(1);
  expect(inputReads).toBe(0);
});

test("an external lifecycle abort stops an initialized protocol reader and closes its service", async () => {
  const inputReadStarted = deferred();
  const lifecycleController = new AbortController();
  let closeCount = 0;
  let inputReturnCount = 0;
  const input: AsyncIterable<string> = {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      return {
        next: () => {
          inputReadStarted.resolve();
          return new Promise<IteratorResult<string>>(() => undefined);
        },
        return: () => {
          inputReturnCount += 1;
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
  const protocol = runGatewayProtocol({
    createService: () => ({
      close: () => {
        closeCount += 1;
        return Promise.resolve();
      },
      handle: () => Promise.reject(new Error("unused")),
      initialize: () => Promise.resolve(),
    }),
    input,
    lifecycleSignal: lifecycleController.signal,
    shutdownTimeoutMs: 20,
    writeLine: () => Promise.resolve(),
  });
  await inputReadStarted.promise;

  lifecycleController.abort(new Error("test termination signal"));
  await protocol;

  expect(inputReturnCount).toBe(1);
  expect(closeCount).toBe(1);
});

test("stalled operations and capture close remain bounded during shutdown", async () => {
  const diagnostics: string[] = [];
  let closeCount = 0;
  const service: RuntimeGatewayService = {
    close: () => {
      closeCount += 1;
      return new Promise<void>(() => undefined);
    },
    handle: () => new Promise<never>(() => undefined),
    initialize: () => Promise.resolve(),
  };
  const startedAt = performance.now();

  await runGatewayProtocol({
    createService: () => service,
    diagnostic: (message) => diagnostics.push(message),
    input: Readable.from([`${hostRequest("stalled")}\n`]),
    operationSettlementTimeoutMs: 20,
    outputDrainTimeoutMs: 20,
    outputWriteTimeoutMs: 20,
    shutdownTimeoutMs: 20,
    writeLine: () => Promise.resolve(),
  });

  expect(performance.now() - startedAt).toBeLessThan(500);
  expect(closeCount).toBe(1);
  expect(diagnostics).toContain("runtime operations exceeded their shutdown time bound");
  expect(diagnostics).toContain("capture shutdown exceeded its time bound");
});

test("a stalled protocol sink has a finite write and drain lifetime", async () => {
  const diagnostics: string[] = [];
  let closeCount = 0;
  await runGatewayProtocol({
    createService: () => ({
      close: () => {
        closeCount += 1;
        return Promise.resolve();
      },
      handle: () => Promise.reject(new Error("unused")),
      initialize: () => Promise.resolve(),
    }),
    diagnostic: (message) => diagnostics.push(message),
    input: Readable.from(["not-json\n"]),
    operationSettlementTimeoutMs: 50,
    outputDrainTimeoutMs: 50,
    outputWriteTimeoutMs: 20,
    shutdownTimeoutMs: 50,
    writeLine: () => new Promise<void>(() => undefined),
  });

  expect(closeCount).toBe(1);
  expect(diagnostics).toContain("protocol output write exceeded its time bound");
});

test("an output failure interrupts an idle input read and closes the iterator and service", async () => {
  const diagnostics: string[] = [];
  const inputReadStarted = deferred();
  let closeCount = 0;
  let inputReturnCount = 0;
  const input: AsyncIterable<string> = {
    [Symbol.asyncIterator](): AsyncIterator<string> {
      return {
        next: () => {
          inputReadStarted.resolve();
          return new Promise<IteratorResult<string>>(() => undefined);
        },
        return: () => {
          inputReturnCount += 1;
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
  const startedAt = performance.now();

  await runGatewayProtocol({
    createService: (emit) => ({
      close: () => {
        closeCount += 1;
        return Promise.resolve();
      },
      handle: () => Promise.reject(new Error("unused")),
      initialize: () => {
        void inputReadStarted.promise.then(() => emit({
          commandId: "command_abcdefgh",
          kind: "command-settled",
          protocolVersion: ATET_DESKTOP_PROTOCOL_VERSION,
          status: "succeeded",
        }));
        return Promise.resolve();
      },
    }),
    diagnostic: (message) => diagnostics.push(message),
    input,
    outputDrainTimeoutMs: 20,
    outputWriteTimeoutMs: 20,
    shutdownTimeoutMs: 20,
    writeLine: () => new Promise<void>(() => undefined),
  });

  expect(performance.now() - startedAt).toBeLessThan(500);
  expect(inputReturnCount).toBe(1);
  expect(closeCount).toBe(1);
  expect(diagnostics).toContain("protocol output write exceeded its time bound");
});

test("synchronous service events fail closed at the fixed output ceiling", async () => {
  const diagnostics: string[] = [];
  let closeCount = 0;
  let writes = 0;
  await runGatewayProtocol({
    createService: (emit) => ({
      close: () => {
        closeCount += 1;
        return Promise.resolve();
      },
      handle: () => Promise.reject(new Error("unused")),
      initialize: () => {
        for (let index = 0; index <= MAX_PENDING_HOST_REQUESTS; index += 1) {
          emit({
            commandId: "command_abcdefgh",
            kind: "command-settled",
            protocolVersion: ATET_DESKTOP_PROTOCOL_VERSION,
            status: "succeeded",
          });
        }
        return Promise.resolve();
      },
    }),
    diagnostic: (message) => diagnostics.push(message),
    input: Readable.from([]),
    outputDrainTimeoutMs: 50,
    outputWriteTimeoutMs: 20,
    writeLine: () => {
      writes += 1;
      return new Promise<void>(() => undefined);
    },
  });

  expect(writes).toBe(1);
  expect(closeCount).toBe(1);
  expect(diagnostics).toContain("protocol event output exceeded its queue bound");
});

test("a blocked sink applies bounded pull backpressure to newline-dense input", async () => {
  const firstWrite = deferred();
  let inputReads = 0;
  let writes = 0;
  const input = async function* (): AsyncGenerator<string> {
    await Promise.resolve();
    for (let index = 0; index < 100; index += 1) {
      inputReads += 1;
      yield "not-json\n";
    }
  };
  const protocol = runGatewayProtocol({
    createService: () => ({
      close: () => Promise.resolve(),
      handle: () => Promise.reject(new Error("unused")),
      initialize: () => Promise.resolve(),
    }),
    input: input(),
    outputDrainTimeoutMs: 1_000,
    outputWriteTimeoutMs: 1_000,
    writeLine: () => {
      writes += 1;
      return writes === 1 ? firstWrite.promise : Promise.resolve();
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(writes).toBe(1);
  expect(inputReads).toBeLessThanOrEqual(MAX_PENDING_HOST_REQUESTS + 1);
  expect(inputReads).toBeLessThan(100);

  firstWrite.resolve();
  await protocol;
  expect(inputReads).toBe(100);
  expect(writes).toBe(100);
});
