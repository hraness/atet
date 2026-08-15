#!/usr/bin/env bun

import { access, lstat, mkdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { runRecordingDaemon } from "../../cli/recording-daemon";
import type {
  DesktopEvent,
  DesktopResponse,
} from "../../contracts";
import {
  MAX_HOST_LINE_BYTES,
  MAX_PENDING_HOST_REQUESTS,
  encodeHostEvent,
  encodeHostResponse,
  hostFailure,
  hostSuccess,
  parseHostRequest,
} from "./host-protocol";
import {
  RecordingService,
  resolveGatewayRepositoryRoot,
  resolveRecordingArtifactDirectory,
} from "./recording-service";
import { renamedEnvironmentValue } from "../../cli/renamed-environment";

const defaultOperationSettlementTimeoutMs = 30_000;
const defaultInitializationAbortGraceMs = 250;
const defaultInitializationTimeoutMs = 15_000;
const defaultOutputDrainTimeoutMs = 5_000;
const defaultOutputWriteTimeoutMs = 5_000;
const defaultShutdownTimeoutMs = 5_000;
const invalidRequestId = "invalid";
const maxQueuedOutputBytes = MAX_HOST_LINE_BYTES * MAX_PENDING_HOST_REQUESTS;
const maxQueuedOutputLines = MAX_PENDING_HOST_REQUESTS;
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function diagnostic(message: string): void {
  process.stderr.write(`atet-gateway: ${message}\n`);
}

async function executableFromEnvironment(value: string | undefined): Promise<string> {
  if (value === undefined || !isAbsolute(value)) throw new Error("ATET_CAPTURE_HELPER must name an absolute executable.");
  const canonical = await realpath(value);
  const details = await stat(canonical);
  if (!details.isFile()) throw new Error("ATET_CAPTURE_HELPER is not a regular file.");
  await access(canonical, constants.X_OK);
  return canonical;
}

async function physicalDirectoryExists(path: string): Promise<boolean> {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new Error("Atet workspace must be a physical directory.");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Selects mutable project state independently from immutable bundled tools. */
export async function resolveRuntimeRepositoryRoot(options: {
  readonly environmentValue?: string;
  readonly executablePath?: string;
  readonly homeDirectory?: string;
} = {}): Promise<string | null> {
  const environmentValue = options.environmentValue
    ?? renamedEnvironmentValue(process.env, "ATET_REPOSITORY_ROOT");
  if (environmentValue !== undefined && environmentValue.trim() !== "") {
    return await resolveGatewayRepositoryRoot(environmentValue);
  }
  const homeDirectory = options.homeDirectory ?? process.env.HOME;
  if (homeDirectory === undefined || !isAbsolute(homeDirectory)) return null;
  const canonicalRoot = join(homeDirectory, "Movies", "Atet");
  const predecessorRoot = join(homeDirectory, "Movies", "Transmute");
  const [hasCanonicalRoot, hasPredecessorRoot] = await Promise.all([
    physicalDirectoryExists(canonicalRoot),
    physicalDirectoryExists(predecessorRoot),
  ]);
  if (hasCanonicalRoot && hasPredecessorRoot) {
    throw new Error("Both Movies/Atet and Movies/Transmute exist. Select one with ATET_REPOSITORY_ROOT before Atet writes project state.");
  }
  if (hasPredecessorRoot) return await realpath(predecessorRoot);
  const projectRoot = canonicalRoot;
  await mkdir(projectRoot, { mode: 0o700, recursive: true });
  const details = await lstat(projectRoot);
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error("Atet workspace must be a physical directory.");
  }
  return await realpath(projectRoot);
}

function valueAfter(arguments_: readonly string[], name: string): string {
  const index = arguments_.indexOf(name);
  const value = index === -1 ? undefined : arguments_[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error("Invalid recording daemon invocation.");
  return value;
}

async function maybeRunRecordingDaemon(arguments_: readonly string[]): Promise<boolean> {
  if (arguments_[0] !== "__record_daemon") return false;
  if (arguments_.length !== 5 || arguments_[1] !== "--artifact-root" || arguments_[3] !== "--helper") {
    throw new Error("Invalid recording daemon invocation.");
  }
  const repositoryRoot = await resolveRuntimeRepositoryRoot();
  if (repositoryRoot === null) throw new Error("Recording daemon requires a configured repository.");
  const helper = await executableFromEnvironment(valueAfter(arguments_, "--helper"));
  const artifactRoot = resolve(valueAfter(arguments_, "--artifact-root"));
  const selectedArtifactRoot = await resolveRecordingArtifactDirectory(
    repositoryRoot,
    "artifacts/atet/recordings",
  );
  if (artifactRoot !== selectedArtifactRoot) {
    throw new Error("Recording daemon artifact root is outside the configured repository location.");
  }
  await runRecordingDaemon({ artifactRoot, helperExecutable: helper });
  return true;
}

async function writeStdoutLine(line: string): Promise<void> {
  await new Promise<void>((resolveWrite, rejectWrite) => {
    process.stdout.write(line, (error) => {
      if (error === null || error === undefined) resolveWrite();
      else rejectWrite(error);
    });
  });
}

export interface RuntimeGatewayService {
  readonly close: () => Promise<void>;
  readonly handle: (
    requestValue: unknown,
    bridgeCommand: string,
  ) => Promise<DesktopResponse>;
  readonly initialize: (abortSignal: AbortSignal) => Promise<void>;
}

export interface RuntimeGatewayProtocolOptions {
  readonly createService: (
    emit: (event: DesktopEvent) => void,
  ) => RuntimeGatewayService;
  readonly diagnostic?: (message: string) => void;
  readonly initializationAbortGraceMs?: number;
  readonly initializationTimeoutMs?: number;
  readonly input: AsyncIterable<string | Uint8Array>;
  readonly lifecycleSignal?: AbortSignal;
  readonly operationSettlementTimeoutMs?: number;
  readonly outputDrainTimeoutMs?: number;
  readonly outputWriteTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly writeLine: (line: string) => Promise<void>;
}

type Settlement = "fulfilled" | "rejected" | "timed_out";

type InitializationOutcome =
  | Readonly<{ readonly kind: "fulfilled" }>
  | Readonly<{ readonly error: unknown; readonly kind: "rejected" }>;

function positiveTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Runtime protocol timeouts must be positive safe integers.");
  }
  return value;
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<Settlement> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const settlement = promise.then<Settlement, Settlement>(
    () => "fulfilled",
    () => "rejected",
  );
  const result = await Promise.race([
    settlement,
    new Promise<Settlement>((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout("timed_out"), timeoutMs);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  return result;
}

export async function runGatewayProtocol(
  options: RuntimeGatewayProtocolOptions,
): Promise<void> {
  const reportDiagnostic = options.diagnostic ?? diagnostic;
  const report = (message: string): void => {
    try {
      reportDiagnostic(message);
    } catch {
      // Diagnostics must never take ownership of protocol or capture cleanup.
    }
  };
  const initializationAbortGraceMs = positiveTimeout(
    options.initializationAbortGraceMs,
    defaultInitializationAbortGraceMs,
  );
  const initializationTimeoutMs = positiveTimeout(
    options.initializationTimeoutMs,
    defaultInitializationTimeoutMs,
  );
  const operationSettlementTimeoutMs = positiveTimeout(
    options.operationSettlementTimeoutMs,
    defaultOperationSettlementTimeoutMs,
  );
  const outputDrainTimeoutMs = positiveTimeout(
    options.outputDrainTimeoutMs,
    defaultOutputDrainTimeoutMs,
  );
  const outputWriteTimeoutMs = positiveTimeout(
    options.outputWriteTimeoutMs,
    defaultOutputWriteTimeoutMs,
  );
  const shutdownTimeoutMs = positiveTimeout(
    options.shutdownTimeoutMs,
    defaultShutdownTimeoutMs,
  );

  type OutputState = "failed" | "open" | "sealed";
  interface QueuedOutput {
    readonly byteLength: number;
    readonly line: string;
  }

  const outputQueue: QueuedOutput[] = [];
  const outputCapacityWaiters = new Set<() => void>();
  const outputIdleWaiters = new Set<() => void>();
  let outputState: OutputState = "open";
  let outputQueuedBytes = 0;
  let outputInFlightBytes = 0;
  let outputInFlightLines = 0;
  let outputPump: Promise<void> | undefined;
  let resolveInputInterruption: (() => void) | undefined;
  const inputInterruption = new Promise<void>((resolveInterruption) => {
    resolveInputInterruption = resolveInterruption;
  });
  const interruptInput = (): void => resolveInputInterruption?.();

  const outputFailed = (): boolean => outputState === "failed";
  const outputLineCount = (): number => outputQueue.length + outputInFlightLines;
  const outputByteCount = (): number => outputQueuedBytes + outputInFlightBytes;
  const wakeOutputCapacityWaiters = (): void => {
    for (const wake of outputCapacityWaiters) wake();
    outputCapacityWaiters.clear();
  };
  const wakeOutputIdleWaiters = (): void => {
    if (outputQueue.length !== 0 || outputInFlightLines !== 0 || outputPump !== undefined) return;
    for (const wake of outputIdleWaiters) wake();
    outputIdleWaiters.clear();
  };
  const failOutput = (message: string): void => {
    if (outputState === "failed") return;
    outputState = "failed";
    outputQueue.length = 0;
    outputQueuedBytes = 0;
    report(message);
    interruptInput();
    wakeOutputCapacityWaiters();
    wakeOutputIdleWaiters();
  };
  const hasOutputCapacity = (byteLength: number): boolean => (
    outputLineCount() < maxQueuedOutputLines
    && outputByteCount() + byteLength <= maxQueuedOutputBytes
  );
  const waitForOutputCapacity = async (): Promise<void> => {
    await new Promise<void>((resolveCapacity) => {
      outputCapacityWaiters.add(resolveCapacity);
    });
  };
  const waitForOutputIdle = async (): Promise<void> => {
    while (outputQueue.length !== 0 || outputInFlightLines !== 0 || outputPump !== undefined) {
      await new Promise<void>((resolveIdle) => {
        outputIdleWaiters.add(resolveIdle);
      });
    }
  };
  const startOutputPump = (): void => {
    if (outputPump !== undefined || outputFailed() || outputQueue.length === 0) return;
    outputPump = (async () => {
      while (!outputFailed()) {
        const output = outputQueue.shift();
        if (output === undefined) return;
        outputQueuedBytes -= output.byteLength;
        outputInFlightBytes = output.byteLength;
        outputInFlightLines = 1;
        const settlement = await settleWithin(
          Promise.resolve().then(async () => await options.writeLine(output.line)),
          outputWriteTimeoutMs,
        );
        outputInFlightBytes = 0;
        outputInFlightLines = 0;
        wakeOutputCapacityWaiters();
        if (settlement === "timed_out") {
          failOutput("protocol output write exceeded its time bound");
          return;
        }
        if (settlement === "rejected") {
          failOutput("protocol output closed unexpectedly");
          return;
        }
      }
    })().finally(() => {
      outputPump = undefined;
      if (outputState !== "failed" && outputQueue.length > 0) startOutputPump();
      wakeOutputIdleWaiters();
    });
  };
  const queueOutput = async (line: string): Promise<boolean> => {
    const byteLength = Buffer.byteLength(line);
    if (byteLength > maxQueuedOutputBytes) {
      failOutput("protocol output line exceeded its queue bound");
      return false;
    }
    while (outputState === "open" && !hasOutputCapacity(byteLength)) {
      await waitForOutputCapacity();
    }
    if (outputState !== "open") return false;
    outputQueue.push({ byteLength, line });
    outputQueuedBytes += byteLength;
    startOutputPump();
    return true;
  };
  const tryQueueOutput = (line: string): boolean => {
    const byteLength = Buffer.byteLength(line);
    if (outputState !== "open") return false;
    if (byteLength > maxQueuedOutputBytes || !hasOutputCapacity(byteLength)) {
      failOutput("protocol event output exceeded its queue bound");
      return false;
    }
    outputQueue.push({ byteLength, line });
    outputQueuedBytes += byteLength;
    startOutputPump();
    return true;
  };

  let pending = 0;
  const operations = new Set<Promise<void>>();
  const initializationController = new AbortController();
  let initializationTimedOut = false;
  let lifecycleAborted = false;
  const abortForLifecycle = (): void => {
    if (lifecycleAborted) return;
    lifecycleAborted = true;
    interruptInput();
    if (!initializationController.signal.aborted) {
      initializationController.abort(
        options.lifecycleSignal?.reason ?? new Error("Runtime gateway lifecycle was cancelled."),
      );
    }
  };
  let shutdown: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  const service = options.createService(
    (event) => {
      try {
        tryQueueOutput(encodeHostEvent(event));
      } catch {
        failOutput("protocol event was invalid");
      }
    },
  );
  options.lifecycleSignal?.addEventListener("abort", abortForLifecycle, { once: true });
  if (options.lifecycleSignal?.aborted === true) abortForLifecycle();
  const beginClose = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise;
    try {
      closePromise = service.close();
    } catch (error) {
      closePromise = Promise.reject(
        error instanceof Error ? error : new Error("Capture shutdown failed."),
      );
    }
    void closePromise.catch(() => undefined);
    return closePromise;
  };
  const stop = (): Promise<void> => {
    shutdown ??= (async () => {
      const operationsSettlement = await settleWithin(
        Promise.allSettled([...operations]),
        operationSettlementTimeoutMs,
      );
      if (operationsSettlement === "timed_out") {
        report("runtime operations exceeded their shutdown time bound");
      }
      const closeSettlement = await settleWithin(
        beginClose(),
        shutdownTimeoutMs,
      );
      if (closeSettlement === "timed_out") {
        report("capture shutdown exceeded its time bound");
      } else if (closeSettlement === "rejected") {
        report("capture shutdown failed");
      }
      if (outputState === "open") outputState = "sealed";
      wakeOutputCapacityWaiters();
      const outputSettlement = await settleWithin(waitForOutputIdle(), outputDrainTimeoutMs);
      if (outputSettlement === "timed_out") {
        failOutput("protocol output drain exceeded its time bound");
      }
    })();
    return shutdown;
  };

  const handleLine = async (line: Buffer): Promise<void> => {
    if (line.length === 0 || line.length > MAX_HOST_LINE_BYTES) {
      await queueOutput(encodeHostResponse(hostFailure(invalidRequestId, "invalid_request", "Request line is empty or oversized.")));
      return;
    }
    let text: string;
    try {
      text = strictUtf8Decoder.decode(line);
    } catch {
      await queueOutput(encodeHostResponse(hostFailure(invalidRequestId, "invalid_request", "Request line is not valid UTF-8.")));
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      await queueOutput(encodeHostResponse(hostFailure(invalidRequestId, "invalid_request", "Request line is not valid JSON.")));
      return;
    }
    let request;
    try {
      request = parseHostRequest(value);
    } catch {
      await queueOutput(encodeHostResponse(hostFailure(invalidRequestId, "invalid_request", "Host request is invalid.")));
      return;
    }
    if (pending >= MAX_PENDING_HOST_REQUESTS) {
      await queueOutput(encodeHostResponse(hostFailure(request.id, "conflict", "The runtime request queue is full.")));
      return;
    }
    pending += 1;
    const operation = (async () => {
      let line: string;
      try {
        const response = await service.handle(request.payload, request.command);
        line = encodeHostResponse(hostSuccess(request.id, response));
      } catch {
        line = encodeHostResponse(hostFailure(request.id, "invalid_request", "Desktop request is invalid."));
      }
      try {
        await queueOutput(line);
      } finally {
        pending -= 1;
      }
    })();
    operations.add(operation);
    void operation.finally(() => operations.delete(operation)).catch(() => undefined);
  };

  const lineStorage = Buffer.allocUnsafe(MAX_HOST_LINE_BYTES);
  let lineBytes = 0;
  let pendingHighSurrogate: string | undefined;
  let trailingCarriageReturn = false;
  let discardReason: "encoding" | "oversized" | undefined;

  const resetLine = (): void => {
    lineBytes = 0;
    pendingHighSurrogate = undefined;
    trailingCarriageReturn = false;
  };
  const discardLine = (reason: "encoding" | "oversized"): void => {
    resetLine();
    discardReason ??= reason;
  };
  const appendBytes = (bytes: Uint8Array): void => {
    if (discardReason !== undefined || bytes.byteLength === 0) return;
    if (pendingHighSurrogate !== undefined) {
      discardLine("encoding");
      return;
    }
    if (trailingCarriageReturn) {
      discardLine("oversized");
      return;
    }
    const remaining = MAX_HOST_LINE_BYTES - lineBytes;
    if (bytes.byteLength <= remaining) {
      lineStorage.set(bytes, lineBytes);
      lineBytes += bytes.byteLength;
      return;
    }
    if (bytes.byteLength === remaining + 1 && bytes.at(-1) === 0x0d) {
      if (remaining > 0) lineStorage.set(bytes.subarray(0, remaining), lineBytes);
      lineBytes = MAX_HOST_LINE_BYTES;
      trailingCarriageReturn = true;
      return;
    }
    discardLine("oversized");
  };
  const appendEncodedString = (value: string): void => {
    if (discardReason !== undefined || value.length === 0) return;
    if (trailingCarriageReturn) {
      discardLine("oversized");
      return;
    }
    const remaining = MAX_HOST_LINE_BYTES - lineBytes;
    const byteLength = Buffer.byteLength(value);
    if (byteLength <= remaining) {
      const written = lineStorage.write(value, lineBytes, remaining, "utf8");
      if (written !== byteLength) {
        discardLine("encoding");
        return;
      }
      lineBytes += written;
      return;
    }
    if (byteLength === remaining + 1 && value.endsWith("\r")) {
      if (remaining > 0) {
        const written = lineStorage.write(value.slice(0, -1), lineBytes, remaining, "utf8");
        if (written !== remaining) {
          discardLine("encoding");
          return;
        }
        lineBytes += written;
      }
      trailingCarriageReturn = true;
      return;
    }
    discardLine("oversized");
  };
  const appendString = (value: string): void => {
    if (discardReason !== undefined || value.length === 0) return;
    let offset = 0;
    if (pendingHighSurrogate !== undefined) {
      const firstCodeUnit = value.charCodeAt(0);
      if (firstCodeUnit < 0xdc00 || firstCodeUnit > 0xdfff) {
        discardLine("encoding");
        return;
      }
      appendEncodedString(`${pendingHighSurrogate}${value[0]}`);
      pendingHighSurrogate = undefined;
      offset = 1;
      if (discardReason !== undefined) return;
    }
    const fragmentStart = offset;
    for (let index = offset; index < value.length; index += 1) {
      const codeUnit = value.charCodeAt(index);
      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        if (index + 1 === value.length) {
          appendEncodedString(value.slice(fragmentStart, index));
          if (discardReason === undefined) pendingHighSurrogate = value[index];
          return;
        }
        const lowSurrogate = value.charCodeAt(index + 1);
        if (lowSurrogate < 0xdc00 || lowSurrogate > 0xdfff) {
          discardLine("encoding");
          return;
        }
        index += 1;
      } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        discardLine("encoding");
        return;
      }
    }
    appendEncodedString(value.slice(fragmentStart));
  };
  const finishLine = async (): Promise<void> => {
    if (pendingHighSurrogate !== undefined && discardReason === undefined) {
      discardLine("encoding");
    }
    if (discardReason !== undefined) {
      const message = discardReason === "oversized"
        ? "Request line is oversized."
        : "Request line is not valid UTF-8.";
      discardReason = undefined;
      await queueOutput(encodeHostResponse(hostFailure(invalidRequestId, "invalid_request", message)));
    } else {
      const line = lineStorage.subarray(0, lineBytes);
      await handleLine(trailingCarriageReturn || line.at(-1) !== 0x0d ? line : line.subarray(0, -1));
    }
    resetLine();
  };

  let initializationTimer: ReturnType<typeof setTimeout> | undefined;
  let inputDone = false;
  let inputIterator: AsyncIterator<string | Uint8Array> | undefined;
  const stopInput = async (): Promise<void> => {
    if (inputDone || inputIterator?.return === undefined) return;
    let returnPromise: Promise<IteratorResult<string | Uint8Array>>;
    try {
      returnPromise = inputIterator.return();
    } catch {
      report("protocol input shutdown failed");
      return;
    }
    const inputSettlement = await settleWithin(returnPromise, shutdownTimeoutMs);
    if (inputSettlement === "timed_out") {
      report("protocol input shutdown exceeded its time bound");
    } else if (inputSettlement === "rejected") {
      report("protocol input shutdown failed");
    }
  };

  try {
    let resolveInitializationAbort: (() => void) | undefined;
    const initializationAbort = new Promise<void>((resolveAbort) => {
      resolveInitializationAbort = resolveAbort;
    });
    const onInitializationAbort = (): void => resolveInitializationAbort?.();
    initializationController.signal.addEventListener("abort", onInitializationAbort, { once: true });
    if (initializationController.signal.aborted) onInitializationAbort();
    initializationTimer = setTimeout(() => {
      initializationTimedOut = true;
      if (!initializationController.signal.aborted) {
        initializationController.abort(new Error("Runtime service initialization exceeded its time bound."));
      }
    }, initializationTimeoutMs);

    const initialization = Promise.resolve().then(
      async () => await service.initialize(initializationController.signal),
    );
    const observedInitialization = initialization.then<InitializationOutcome, InitializationOutcome>(
      () => ({ kind: "fulfilled" }),
      (error: unknown) => ({ error, kind: "rejected" }),
    );
    const firstInitializationOutcome = await Promise.race([
      observedInitialization,
      initializationAbort.then(() => null),
    ]);
    const initializationWasInterrupted = initializationController.signal.aborted;
    if (initializationWasInterrupted) {
      void beginClose();
      const abortSettlement = await settleWithin(
        observedInitialization,
        initializationAbortGraceMs,
      );
      if (abortSettlement === "timed_out") {
        report("runtime initialization did not settle after cancellation");
      }
      if (initializationTimedOut) {
        report("runtime initialization exceeded its time bound");
        throw new Error("Runtime service initialization exceeded its time bound.");
      }
      return;
    }
    if (firstInitializationOutcome === null) {
      throw new Error("Runtime service initialization was interrupted without an abort reason.");
    }
    if (firstInitializationOutcome.kind === "rejected") {
      throw firstInitializationOutcome.error;
    }
    clearTimeout(initializationTimer);
    initializationTimer = undefined;
    initializationController.signal.removeEventListener("abort", onInitializationAbort);

    if (!outputFailed() && !lifecycleAborted) {
      inputIterator = options.input[Symbol.asyncIterator]();
      input: while (!lifecycleAborted) {
        const next = await Promise.race([
          inputIterator.next().then((value) => ({ kind: "input" as const, value })),
          inputInterruption.then(() => ({ kind: "input-interruption" as const })),
        ]);
        if (next.kind === "input-interruption") break;
        if (next.value.done) {
          inputDone = true;
          break;
        }
        const chunk = next.value.value;
        let offset = 0;
        while (offset < chunk.length) {
          const newline = typeof chunk === "string"
            ? chunk.indexOf("\n", offset)
            : chunk.indexOf(0x0a, offset);
          const end = newline === -1 ? chunk.length : newline;
          if (typeof chunk === "string") appendString(chunk.slice(offset, end));
          else appendBytes(chunk.subarray(offset, end));
          if (newline === -1) break;
          await finishLine();
          if (outputFailed()) break input;
          offset = newline + 1;
        }
      }
    }
    if (!lifecycleAborted && !outputFailed()
      && (discardReason !== undefined || pendingHighSurrogate !== undefined
      || trailingCarriageReturn || lineBytes > 0)) {
      await finishLine();
    }
  } finally {
    if (initializationTimer !== undefined) clearTimeout(initializationTimer);
    options.lifecycleSignal?.removeEventListener("abort", abortForLifecycle);
    await Promise.all([stopInput(), stop()]);
  }
}

async function runGateway(): Promise<void> {
  const lifecycleController = new AbortController();
  const onSignal = (): void => {
    lifecycleController.abort(new Error("Runtime gateway received a termination signal."));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const captureHelper = await executableFromEnvironment(
      renamedEnvironmentValue(process.env, "ATET_CAPTURE_HELPER"),
    );
    const repositoryRoot = await resolveRuntimeRepositoryRoot();
    if (lifecycleController.signal.aborted) return;
    await runGatewayProtocol({
      createService: (emit) => new RecordingService({
        captureHelper,
        emit,
        repositoryRoot,
      }),
      input: process.stdin,
      lifecycleSignal: lifecycleController.signal,
      writeLine: writeStdoutLine,
    });
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

async function main(): Promise<void> {
  if (await maybeRunRecordingDaemon(process.argv.slice(2))) return;
  await runGateway();
}

if (import.meta.main) {
  try {
    await main();
  } catch {
    diagnostic("runtime initialization failed");
    process.exitCode = 1;
  }
}
