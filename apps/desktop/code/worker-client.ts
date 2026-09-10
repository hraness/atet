import { Effect, Exit, Fiber } from "effect";
import { WorkerEffectRuntime, workerBoundary, workerValidation, type WorkerCompletion, type WorkerFailure } from "./worker-effects";
import { createHash, randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";

import { ApplicationError } from "../application/errors";
import type { OperationDiscovery } from "../application/registry";
import { canonicalJson } from "../core/canonical-json";
import {
  AuthoredWorkflowGraphV1Schema,
  JsonValueSchema,
  normalizeAuthoredWorkflowGraph,
  type JsonValue,
} from "./contracts";
import {
  CODE_WORKER_PROTOCOL,
  CodeWorkerRequestSchema,
  MAX_CODE_WORKER_DIAGNOSTIC_BARRIER_BYTES,
  WorkerFrameDecoder,
  encodeCodeWorkerDiagnosticBarrier,
  encodeWorkerFrame,
  type CodeWorkerMessage,
  type CodeWorkerRequest,
  type CodeWorkerResponse,
} from "./worker-protocol";
import { captureWorkerProcessStartIdentity } from "./worker-process-identity";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAXIMUM_DIAGNOSTIC_BYTES = 64 * 1024;
const CODE_WORKER_CANCEL_GRACE_MS = 250;
export const MAX_CODE_WORKER_POOL_SIZE = 4;

const WorkerBuiltWorkflowSchema = z.strictObject({
  graph: AuthoredWorkflowGraphV1Schema,
  input: JsonValueSchema,
});

const WorkerCancellationAcknowledgementSchema = z.strictObject({
  cancellation: z.enum(["active", "queued", "missing"]),
});

class CodeWorkerCancellationError extends ApplicationError {
  readonly workerReusable: boolean;

  constructor(nodeKey: string, workerReusable: boolean) {
    super("cancelled", `Compute node ${nodeKey} was cancelled.`);
    this.workerReusable = workerReusable;
  }
}

export interface CodeWorkerDiagnostics {
  readonly stderr: string;
  readonly stdout: string;
}

export interface CodeWorkerBuildResult {
  readonly diagnostics: CodeWorkerDiagnostics;
  readonly graph: z.infer<typeof AuthoredWorkflowGraphV1Schema>;
  readonly input: JsonValue;
}

export interface CodeWorkerBundle {
  readonly bytes: Uint8Array;
  readonly externalImports: readonly {
    readonly resolvedPath: string;
    readonly specifier: string;
  }[];
  readonly sha256: string;
}

export interface StartCodeWorkerOptions {
  readonly bunExecutable?: string;
  readonly bundle: CodeWorkerBundle;
  readonly inheritedHostResourceFileDescriptor?: number;
  readonly maximumDiagnosticBytes?: number;
  readonly temporaryRoot?: string;
  readonly timeoutMs?: number;
  readonly workerEntryPath?: string;
}

export interface BuildInCodeWorkerOptions extends StartCodeWorkerOptions {
  readonly registry: {
    list(): readonly OperationDiscovery[];
  };
  readonly workflowInput: unknown;
}

export interface CodeWorkerComputeRequest {
  readonly abortSignal?: AbortSignal;
  readonly computeKey: string;
  readonly inheritedHostResourceFileDescriptor?: number;
  readonly input: JsonValue;
  readonly nodeKey: string;
  readonly replayAcknowledged: boolean;
  readonly timeoutMs?: number;
}

export interface CodeWorkerSession {
  build(
    registry: { list(): readonly OperationDiscovery[] },
    workflowInput: unknown,
    inputMode?: "parsed" | "raw",
  ): Promise<CodeWorkerBuildResult>;
  close(): Promise<void>;
  compute(request: CodeWorkerComputeRequest): Promise<JsonValue>;
  diagnostics(): CodeWorkerDiagnostics;
  readonly bundleSha256: string;
  readonly generation: number;
  readonly processId: number;
  readonly processStartIdentity: string;
}

export interface CodeWorkerPool {
  readonly bundleSha256: string;
  close(): Promise<void>;
  execute(request: CodeWorkerComputeRequest): Promise<JsonValue>;
  readonly size: number;
}

export interface StartCodeWorkerPoolOptions extends StartCodeWorkerOptions {
  readonly expectedBuild: Pick<CodeWorkerBuildResult, "graph" | "input">;
  readonly initialWorker?: {
    readonly build: Pick<CodeWorkerBuildResult, "graph" | "input">;
    readonly session: CodeWorkerSession;
  };
  readonly maximumWorkers: number;
  readonly registry: {
    list(): readonly OperationDiscovery[];
  };
  readonly workflowInput: unknown;
  readonly workflowInputMode?: "parsed" | "raw";
}

interface WaitingMessage {
  readonly accept: (message: CodeWorkerMessage) => boolean;
  readonly reject: (error: Error) => void;
  readonly resolve: (message: CodeWorkerMessage) => void;
  readonly completion: WorkerCompletion<CodeWorkerMessage>;
}

interface WaitingDiagnosticBarrier {
  readonly reject: (error: Error) => void;
  readonly resolve: () => void;
  stderrObserved: boolean;
  stdoutObserved: boolean;
  readonly completion: WorkerCompletion<void>;
}

interface WaitingWorker {
  readonly abortHandler?: () => void;
  readonly abortSignal?: AbortSignal;
  readonly reject: (error: Error) => void;
  readonly resolve: (worker: CodeWorkerSession) => void;
}

function positiveBound(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new ApplicationError("usage", `${label} must be a positive safe integer.`);
  }
  return resolved;
}

function writeProtocol(stream: Socket, message: unknown): Promise<void> {
  const frame = encodeWorkerFrame(message);
  return new Promise((resolveWrite, rejectWrite) => {
    stream.write(frame, error => {
      if (error === null || error === undefined) resolveWrite();
      else rejectWrite(error);
    });
  });
}

function workerFailure(message: CodeWorkerResponse & { readonly status: "error" }): ApplicationError {
  switch (message.error.code) {
    case "cancelled":
      return new ApplicationError("cancelled", message.error.message);
    case "unknown-compute":
      return new ApplicationError("unsupported-plan", message.error.message);
    case "execution":
      return new ApplicationError("invalid-data", message.error.message);
    case "invalid-output":
    case "invalid-request":
      return new ApplicationError("invalid-data", message.error.message);
    case "internal":
      return new ApplicationError("internal", message.error.message);
  }
}

export function consumeCodeWorkerDiagnosticBarriers(
  input: Uint8Array,
  stream: "stderr" | "stdout",
  barriers: readonly string[],
): {
  readonly diagnostics: Buffer<ArrayBufferLike>;
  readonly observed: readonly string[];
} {
  let diagnostics: Buffer<ArrayBufferLike> = Buffer.from(input);
  const observed: string[] = [];
  for (const barrier of barriers) {
    const marker = Buffer.from(encodeCodeWorkerDiagnosticBarrier(barrier, stream));
    const offset = diagnostics.indexOf(marker);
    if (offset === -1) continue;
    diagnostics = Buffer.concat([
      diagnostics.subarray(0, offset),
      diagnostics.subarray(offset + marker.byteLength),
    ]);
    observed.push(barrier);
  }
  return { diagnostics, observed: Object.freeze(observed) };
}

export async function waitForCodeWorkerResponseDiagnostics(
  response: Promise<CodeWorkerMessage>,
  diagnostics: Promise<void>,
  requestId: string,
): Promise<CodeWorkerResponse> {
  const result = await response;
  if (result.kind !== "response") {
    throw new ApplicationError(
      "invalid-data",
      "Code worker returned a non-response message.",
    );
  }
  if (result.diagnosticBarrier !== requestId) {
    throw new ApplicationError(
      "invalid-data",
      "Code-worker diagnostic barrier identity mismatch.",
    );
  }
  await diagnostics;
  return result;
}

class RunningCodeWorker implements CodeWorkerSession {
  readonly #effects = new WorkerEffectRuntime();
  readonly #child: ChildProcess;
  readonly #cleanupDirectories: readonly string[];
  readonly #decoder = new WorkerFrameDecoder();
  readonly #diagnosticBarriers = new Map<string, WaitingDiagnosticBarrier>();
  readonly #maximumDiagnosticBytes: number;
  readonly #protocol: Socket;
  readonly #queued: CodeWorkerMessage[] = [];
  readonly #timeoutMs: number;
  readonly #waiting: WaitingMessage[] = [];
  #buildCompleted = false;
  #buildStarted = false;
  #closed = false;
  #closePromise: Promise<void> | undefined;
  #fatal: Error | undefined;
  #preparationGuardian: CodeWorkerLeaseGuardian | undefined;
  #stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  #stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  bundleSha256 = "";
  generation = 0;
  readonly processId: number;
  readonly processStartIdentity: string;

  constructor(options: {
    readonly child: ChildProcess;
    readonly cleanupDirectories: readonly string[];
    readonly maximumDiagnosticBytes: number;
    readonly preparationGuardian: CodeWorkerLeaseGuardian;
    readonly processStartIdentity: string;
    readonly protocol: Socket;
    readonly timeoutMs: number;
  }) {
    this.#child = options.child;
    this.#cleanupDirectories = options.cleanupDirectories;
    this.#maximumDiagnosticBytes = options.maximumDiagnosticBytes;
    this.#preparationGuardian = options.preparationGuardian;
    this.#protocol = options.protocol;
    this.#timeoutMs = options.timeoutMs;
    const processId = options.child.pid;
    if (processId === undefined || processId < 2) {
      throw new ApplicationError("subprocess", "Code worker has no valid process ID.");
    }
    this.processId = processId;
    this.processStartIdentity = options.processStartIdentity;
    this.#attach();
  }

  async initialize(expected: {
    readonly bunRevision: string;
    readonly bunVersion: string;
    readonly bundleSha256: string;
    readonly workerEntrySha256: string;
  }): Promise<void> {
    const hello = await this.#effects.run(this.#nextMessage(message => message.kind === "hello", this.#timeoutMs));
    if (hello.kind !== "hello" || hello.bundleSha256 !== expected.bundleSha256) {
      throw new ApplicationError(
        "invalid-data",
        "Code-worker handshake bundle identity mismatch.",
      );
    }
    if (
      hello.bunVersion !== expected.bunVersion
      || hello.bunRevision !== expected.bunRevision
    ) {
      throw new ApplicationError(
        "incompatible",
        "Code-worker child Bun runtime attestation mismatch.",
      );
    }
    if (hello.workerEntrySha256 !== expected.workerEntrySha256) {
      throw new ApplicationError(
        "incompatible",
        "Code-worker implementation entry-byte attestation mismatch.",
      );
    }
    this.bundleSha256 = hello.bundleSha256;
    this.generation = hello.generation;
  }

  diagnostics(): CodeWorkerDiagnostics {
    return {
      stderr: new TextDecoder().decode(this.#stderr),
      stdout: new TextDecoder().decode(this.#stdout),
    };
  }

  async build(
    registry: { list(): readonly OperationDiscovery[] },
    workflowInput: unknown,
    inputMode: "parsed" | "raw" = "raw",
  ): Promise<CodeWorkerBuildResult> {
    if (this.#buildStarted) {
      throw new ApplicationError(
        "conflict",
        "Code-worker session already consumed its guarded authored build.",
      );
    }
    this.#buildStarted = true;
    const guardian = this.#preparationGuardian;
    const request = this.#request(CodeWorkerRequestSchema.parse({
      action: "build",
      generation: this.generation,
      inputMode,
      kind: "request",
      protocol: CODE_WORKER_PROTOCOL,
      registry: [...registry.list()],
      requestId: this.#requestId("build"),
      workflowInput: JsonValueSchema.parse(workflowInput),
    }), this.#timeoutMs);
    if (guardian === undefined) {
      const built = WorkerBuiltWorkflowSchema.parse(await request);
      return {
        diagnostics: this.diagnostics(),
        graph: built.graph,
        input: built.input,
      };
    }
    let output: JsonValue;
    try {
      output = await Promise.race([
        request,
        guardian.failure,
      ]);
    } catch (error) {
      try {
        await this.close();
      } catch (retirementError) {
        throw new AggregateError(
          [error, retirementError],
          "Code-worker preparation failed and the worker could not be observably retired.",
        );
      }
      throw error;
    }
    try {
      await guardian.complete();
      this.#preparationGuardian = undefined;
    } catch (error) {
      try {
        await this.close();
      } catch (retirementError) {
        throw new AggregateError(
          [error, retirementError],
          "Code-worker preparation guardian failed and the worker could not be observably retired.",
        );
      }
      throw error;
    }
    const built = WorkerBuiltWorkflowSchema.parse(output);
    this.#buildCompleted = true;
    return {
      diagnostics: this.diagnostics(),
      graph: built.graph,
      input: built.input,
    };
  }

  compute(request: CodeWorkerComputeRequest): Promise<JsonValue> {
    return this.#queueCompute(request);
  }

  async #queueCompute(request: CodeWorkerComputeRequest): Promise<JsonValue> {
    if (!this.#buildCompleted) throw new ApplicationError(
      "conflict", "Code-worker compute requires one completed guarded authored build.",
    );
    let acquired = false;
    const completion = this.#effects.completion<JsonValue>(0, () => undefined);
    const abort = () => {
      if (!acquired) completion.fail(new CodeWorkerCancellationError(request.nodeKey, true));
    };
    request.abortSignal?.addEventListener("abort", abort, { once: true });
    if (request.abortSignal?.aborted) abort();
    // A cancelled caller can leave immediately. Its ordered turn remains owned
    // until predecessors settle, so later requests cannot overtake active work.
    const fiber = this.#effects.fork(this.#effects.serial.withPermits(1)(Effect.gen(this, function*() {
      acquired = true;
      yield* workerValidation("admission", () => {
        if (request.abortSignal?.aborted) throw new CodeWorkerCancellationError(request.nodeKey, true);
      });
      return yield* this.#computeProgram(request);
    }).pipe(Effect.ensuring(Effect.sync(() => request.abortSignal?.removeEventListener("abort", abort))))));
    fiber.addObserver(exit => completion.complete(exit));
    return await this.#effects.run(completion.await);
  }

  #computeProgram(request: CodeWorkerComputeRequest): Effect.Effect<JsonValue, WorkerFailure> {
    return Effect.gen(this, function*() {
      const timeoutMs = yield* workerValidation("compute", () => {
        if (request.abortSignal?.aborted) throw new CodeWorkerCancellationError(request.nodeKey, true);
        return positiveBound(request.timeoutMs, this.#timeoutMs, "Code compute timeout");
      });
      const requestId = this.#requestId("compute");
      const message = yield* workerValidation("protocol", () => CodeWorkerRequestSchema.parse({
        action: "compute", computeKey: request.computeKey, generation: this.generation,
        input: JsonValueSchema.parse(request.input), kind: "request", nodeKey: request.nodeKey,
        protocol: CODE_WORKER_PROTOCOL, replayAcknowledged: request.replayAcknowledged, requestId,
      }));
      // The request remains owned until its actual terminal frame/diagnostics,
      // even when a queued cancellation permits its caller to return earlier.
      const computation = this.#effects.fork(this.#requestProgram(message, timeoutMs));
      if (request.abortSignal === undefined) return yield* Fiber.join(computation);
      const abortSignal = request.abortSignal;
      const forced = this.#effects.completion<JsonValue>(0, () => undefined);
      let abortStarted = false;
      let forceStarted = false;
      let settled = false;
      let cancelAlarm: (() => void) | undefined;
      const reusable = () => new CodeWorkerCancellationError(request.nodeKey, true);
      const force = () => {
        if (forceStarted || settled) return;
        forceStarted = true;
        cancelAlarm?.();
        const error = new CodeWorkerCancellationError(request.nodeKey, false);
        this.#rejectAll(error);
        this.#child.kill("SIGKILL");
        forced.fail(error);
      };
      const abort = () => {
        if (abortStarted || settled) return;
        abortStarted = true;
        cancelAlarm = this.#effects.alarm(CODE_WORKER_CANCEL_GRACE_MS, force);
        const cancellation = Effect.gen(this, function*() {
          const request = yield* workerValidation("protocol", () => CodeWorkerRequestSchema.parse({
            action: "cancel", generation: this.generation, kind: "request", protocol: CODE_WORKER_PROTOCOL,
            requestId: this.#requestId("cancel"), targetRequestId: requestId,
          }));
          const output = yield* this.#requestProgram(request, this.#timeoutMs);
          return yield* workerValidation("protocol", () => WorkerCancellationAcknowledgementSchema.parse(output));
        });
        const cancellationFiber = this.#effects.fork(Effect.match(cancellation, {
          onFailure: () => { force(); },
          onSuccess: acknowledgement => {
            cancelAlarm?.();
            cancelAlarm = undefined;
            if (settled) return;
            if (acknowledgement.cancellation === "active") {
              cancelAlarm = this.#effects.alarm(CODE_WORKER_CANCEL_GRACE_MS, force);
            } else {
              forced.fail(reusable());
            }
          },
        }));
        cancellationFiber.addObserver(exit => { if (Exit.isFailure(exit)) force(); });
      };
      return yield* Effect.scoped(Effect.gen(this, function*() {
        yield* Effect.acquireRelease(Effect.sync(() => {
          abortSignal.addEventListener("abort", abort, { once: true });
          if (abortSignal.aborted) abort();
        }), () => Effect.sync(() => {
          settled = true;
          cancelAlarm?.();
          abortSignal.removeEventListener("abort", abort);
        }));
        const outcome = yield* Effect.either(Effect.raceFirst(Fiber.join(computation), forced.await));
        return yield* workerValidation("compute", () => {
          if (outcome._tag === "Left") {
            const error = outcome.left.cause;
            if (error instanceof CodeWorkerCancellationError) throw error;
            if (abortSignal.aborted) throw new CodeWorkerCancellationError(
              request.nodeKey,
              this.#fatal === undefined && this.#child.exitCode === null && this.#child.signalCode === null,
            );
            throw error;
          }
          if (abortSignal.aborted) throw reusable();
          return JsonValueSchema.parse(outcome.right);
        });
      }));
    });
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close().finally(async () => await this.#effects.close());
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    // Publish closure before the asynchronous shutdown handshake so no racing
    // caller can enqueue work behind shutdown.
    this.#closed = true;
    if (
      this.#fatal === undefined
      && this.#child.exitCode === null
      && this.#child.signalCode === null
    ) {
      try {
        await this.#request(CodeWorkerRequestSchema.parse({
          action: "shutdown",
          generation: this.generation,
          kind: "request",
          protocol: CODE_WORKER_PROTOCOL,
          requestId: this.#requestId("shutdown"),
        }), this.#timeoutMs, true);
      } catch {
        this.#child.kill("SIGTERM");
      }
    }
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      if (!await this.#waitForExit(100)) {
        this.#child.kill("SIGTERM");
      }
      if (!await this.#waitForExit(500)) {
        this.#child.kill("SIGKILL");
      }
      if (!await this.#waitForExit(1_000)) {
        const error = new ApplicationError(
          "subprocess",
          "Code worker did not exit after SIGKILL; its temporary files were retained.",
        );
        const preparationGuardian = this.#preparationGuardian;
        if (preparationGuardian !== undefined) {
          preparationGuardian.retireDetached();
          this.#preparationGuardian = undefined;
        }
        this.#rejectAll(error);
        this.#detachProcessHandles();
        throw error;
      }
    }
    const preparationGuardian = this.#preparationGuardian;
    this.#rejectAll(new ApplicationError("cancelled", "Code-worker session closed."));
    this.#detachProcessHandles();
    const cleanup = Promise.all(this.#cleanupDirectories.map(async directory => {
      await rm(directory, { force: true, recursive: true });
    })).then(() => undefined);
    const guardianCompletion = preparationGuardian === undefined
      ? Promise.resolve()
      : preparationGuardian.complete();
    if (preparationGuardian !== undefined) {
      this.#preparationGuardian = undefined;
    }
    const settled = await Promise.allSettled([cleanup, guardianCompletion]);
    const failures: unknown[] = [];
    for (const result of settled) {
      if (result.status === "rejected") failures.push(result.reason as unknown);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "Code-worker files and preparation guardian both failed to close.",
      );
    }
  }

  #detachProcessHandles(): void {
    this.#protocol.destroy();
    this.#child.stdin?.destroy();
    this.#child.stdout?.destroy();
    this.#child.stderr?.destroy();
    this.#child.unref();
  }

  async #waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return true;
    const completion = this.#effects.completion<boolean>(timeoutMs, () => completion.succeed(false));
    const onExit = () => completion.succeed(true);
    this.#child.once("exit", onExit);
    completion.activate();
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) onExit();
    return await this.#effects.run(completion.await.pipe(Effect.ensuring(Effect.sync(() => {
      this.#child.off("exit", onExit);
    }))));
  }

  #attach(): void {
    this.#protocol.on("data", (chunk: Buffer) => {
      try {
        for (const message of this.#decoder.push(chunk)) this.#deliver(message);
      } catch (error) {
        this.#rejectAll(new ApplicationError(
          "invalid-data",
          `Invalid code-worker protocol: ${String(error)}`,
        ));
        this.#child.kill("SIGKILL");
      }
    });
    this.#protocol.on("error", error => this.#rejectAll(
      new ApplicationError("subprocess", `Code-worker protocol failed: ${error.message}`),
    ));
    this.#child.stdout?.on("data", (chunk: Buffer) => {
      this.#recordDiagnostic("stdout", chunk);
    });
    this.#child.stderr?.on("data", (chunk: Buffer) => {
      this.#recordDiagnostic("stderr", chunk);
    });
    this.#child.on("error", error => this.#rejectAll(
      new ApplicationError("subprocess", `Could not start code worker: ${error.message}`),
    ));
    this.#child.on("exit", (code, signal) => {
      if (this.#closed) return;
      this.#rejectAll(new ApplicationError(
        "subprocess",
        `Code worker exited before completing (code ${String(code)}, signal ${String(signal)}).`,
        { ...this.diagnostics() },
      ));
    });
  }

  #deliver(message: CodeWorkerMessage): void {
    const index = this.#waiting.findIndex(waiter => waiter.accept(message));
    if (index === -1) {
      this.#queued.push(message);
      return;
    }
    const [waiter] = this.#waiting.splice(index, 1);
    if (waiter !== undefined) {
      waiter.resolve(message);
    }
  }

  #nextMessage(
    accept: (message: CodeWorkerMessage) => boolean,
    timeoutMs: number,
  ): Effect.Effect<CodeWorkerMessage, WorkerFailure> {
    if (this.#fatal !== undefined) return workerValidation("protocol", () => { throw this.#fatal; });
    const index = this.#queued.findIndex(accept);
    if (index !== -1) {
      const message = this.#queued.splice(index, 1)[0];
      if (message !== undefined) return Effect.succeed(message);
    }
    const completion = this.#effects.completion<CodeWorkerMessage>(timeoutMs, () => {
      const index = this.#waiting.indexOf(waiter);
      if (index === -1) return;
      this.#waiting.splice(index, 1);
      const error = new ApplicationError("subprocess", "Timed out waiting for the code worker.");
      completion.fail(error);
      this.#rejectAll(error);
      this.#child.kill("SIGKILL");
    });
    const waiter: WaitingMessage = { accept, completion, reject: completion.fail, resolve: completion.succeed };
    this.#waiting.push(waiter);
    completion.activate();
    return completion.await;
  }

  async #request(message: CodeWorkerRequest, timeoutMs: number, allowClosed = false): Promise<JsonValue> {
    return await this.#effects.run(this.#requestProgram(message, timeoutMs, allowClosed));
  }

  #requestProgram(message: CodeWorkerRequest, timeoutMs: number, allowClosed = false): Effect.Effect<JsonValue, WorkerFailure> {
    return Effect.gen(this, function*() {
      yield* workerValidation("protocol", () => {
        if (this.#closed && !allowClosed) throw new ApplicationError("conflict", "Code-worker session is already closed.");
      });
      // Reserve both native tables before writing. Native callbacks choose the
      // winner synchronously; the Effect continuations only observe that choice.
      const response = this.#nextMessage(candidate => (
        candidate.kind === "response" && candidate.requestId === message.requestId
      ), timeoutMs);
      const diagnostics = this.#waitForDiagnosticBarrier(message.requestId, timeoutMs);
      const outcome = yield* Effect.exit(Effect.gen(this, function*() {
        yield* workerBoundary("protocol", () => writeProtocol(this.#protocol, message));
        const candidate = yield* response;
        const result = yield* workerValidation("protocol", () => {
          if (candidate.kind !== "response") throw new ApplicationError("invalid-data", "Code worker returned a non-response message.");
          if (candidate.diagnosticBarrier !== message.requestId) throw new ApplicationError("invalid-data", "Code-worker response diagnostic barrier identity mismatch.");
          return candidate;
        });
        yield* diagnostics;
        return yield* workerValidation("protocol", () => {
          if (result.status === "error") throw workerFailure(result);
          return JsonValueSchema.parse(result.output);
        });
      }));
      if (Exit.isFailure(outcome)) {
        this.#cancelDiagnosticBarrier(message.requestId, new ApplicationError("subprocess", "Code-worker request failed."));
      }
      return yield* outcome;
    });
  }

  #rejectAll(error: Error): void {
    this.#fatal ??= error;
    for (const waiter of this.#waiting.splice(0)) {
      waiter.reject(error);
    }
    for (const [barrier, waiter] of this.#diagnosticBarriers) {
      this.#diagnosticBarriers.delete(barrier);
      waiter.reject(error);
    }
  }

  #waitForDiagnosticBarrier(barrier: string, timeoutMs: number): Effect.Effect<void, WorkerFailure> {
    if (this.#fatal !== undefined) return workerValidation("protocol", () => { throw this.#fatal; });
    if (this.#diagnosticBarriers.has(barrier)) {
      return workerValidation("protocol", () => {
        throw new ApplicationError(
          "internal", `Duplicate code-worker diagnostic barrier: ${barrier}`,
        );
      });
    }
    const completion = this.#effects.completion<void>(timeoutMs, () => {
      const waiter = this.#diagnosticBarriers.get(barrier);
      if (waiter === undefined) return;
      this.#diagnosticBarriers.delete(barrier);
      const error = new ApplicationError("subprocess", "Timed out waiting for code-worker diagnostics.");
      completion.fail(error);
      this.#rejectAll(error);
      this.#child.kill("SIGKILL");
    });
    this.#diagnosticBarriers.set(barrier, {
      completion, reject: completion.fail, resolve: () => completion.succeed(undefined),
      stderrObserved: false, stdoutObserved: false,
    });
    completion.activate();
    return completion.await;
  }

  #cancelDiagnosticBarrier(barrier: string, error: Error): void {
    const waiter = this.#diagnosticBarriers.get(barrier);
    if (waiter === undefined) return;
    this.#diagnosticBarriers.delete(barrier);
    waiter.reject(error);
  }

  #recordDiagnostic(stream: "stderr" | "stdout", chunk: Buffer): void {
    let value: Buffer<ArrayBufferLike> = Buffer.concat([
      stream === "stderr" ? this.#stderr : this.#stdout,
      chunk,
    ]);
    const pendingBarriers = [...this.#diagnosticBarriers].filter(([, waiter]) => (
      stream === "stderr" ? !waiter.stderrObserved : !waiter.stdoutObserved
    ));
    const consumed = consumeCodeWorkerDiagnosticBarriers(
      value,
      stream,
      pendingBarriers.map(([barrier]) => barrier),
    );
    value = consumed.diagnostics;
    for (const barrier of consumed.observed) {
      const waiter = this.#diagnosticBarriers.get(barrier);
      if (waiter === undefined) continue;
      if (stream === "stderr") waiter.stderrObserved = true;
      else waiter.stdoutObserved = true;
      if (!waiter.stderrObserved || !waiter.stdoutObserved) continue;
      this.#diagnosticBarriers.delete(barrier);
      waiter.resolve();
    }
    const pendingBarrierCount = [...this.#diagnosticBarriers.values()].filter(waiter => (
      stream === "stderr" ? !waiter.stderrObserved : !waiter.stdoutObserved
    )).length;
    const maximumBufferedBytes = this.#maximumDiagnosticBytes + (
      pendingBarrierCount * MAX_CODE_WORKER_DIAGNOSTIC_BARRIER_BYTES
    );
    if (stream === "stderr") this.#stderr = value;
    else this.#stdout = value;
    if (value.byteLength <= maximumBufferedBytes) return;
    const label = stream === "stderr" ? "stderr" : "stdout";
    if (stream === "stderr") {
      this.#stderr = value.subarray(0, this.#maximumDiagnosticBytes);
    } else {
      this.#stdout = value.subarray(0, this.#maximumDiagnosticBytes);
    }
    this.#rejectAll(new ApplicationError(
      "subprocess",
      `Code-worker ${label} exceeded its diagnostic bound.`,
    ));
    this.#child.kill("SIGKILL");
  }

  #requestId(prefix: string): string {
    return `${prefix}_${randomUUID().replaceAll("-", "")}`;
  }
}

interface CodeWorkerLeaseGuardian {
  complete(): Promise<void>;
  readonly failure: Promise<never>;
  retireDetached(): void;
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

async function startCodeWorkerLeaseGuardian(options: {
  readonly bunExecutable: string;
  readonly inheritedFileDescriptor: number;
  readonly workerProcessId: number;
  readonly workerStartIdentity: string;
}): Promise<CodeWorkerLeaseGuardian> {
  if (
    process.platform === "win32"
    || options.inheritedFileDescriptor === 0
  ) {
    return {
      complete: () => Promise.resolve(),
      failure: new Promise<never>(() => undefined),
      retireDetached: () => undefined,
    };
  }
  if (options.inheritedFileDescriptor < 3) {
    throw new ApplicationError(
      "internal",
      "Code-worker host-resource lease descriptor is unsafe to inherit.",
    );
  }
  const guardianEntryPath = join(import.meta.dir, "worker-lease-guardian.ts");
  const guardian = spawn(
    options.bunExecutable,
    [
      "run",
      guardianEntryPath,
      "--worker-pid",
      String(options.workerProcessId),
      "--worker-start-identity",
      options.workerStartIdentity,
    ],
    {
      env: {
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PATH: dirname(options.bunExecutable),
      },
      stdio: ["pipe", "pipe", "pipe", options.inheritedFileDescriptor],
    },
  );
  if (
    guardian.stdin === null
    || guardian.stdout === null
    || guardian.stderr === null
  ) {
    guardian.kill("SIGKILL");
    throw new ApplicationError(
      "subprocess",
      "Code-worker lease guardian did not expose its control streams.",
    );
  }
  let diagnostics = Buffer.alloc(0);
  guardian.stderr.on("data", (chunk: Uint8Array) => {
    diagnostics = Buffer.concat([diagnostics, chunk]).subarray(0, 2_000);
  });
  let settlementRequested: "complete" | "retire" | undefined;
  const exit = childExit(guardian);
  try {
    await new Promise<void>((resolveReady, rejectReady) => {
      let readyBytes = Buffer.alloc(0);
      let settled = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        guardian.stdout?.removeListener("data", onData);
        if (error === undefined) resolveReady();
        else rejectReady(error);
      };
      const onData = (chunk: Uint8Array) => {
        readyBytes = Buffer.concat([readyBytes, chunk]);
        if (readyBytes.byteLength > 64) {
          settle(new ApplicationError(
            "subprocess",
            "Code-worker lease guardian exceeded its handshake bound.",
          ));
          return;
        }
        const text = readyBytes.toString("utf8");
        if (text === "ready\n") settle();
        else if (!"ready\n".startsWith(text)) {
          settle(new ApplicationError(
            "subprocess",
            "Code-worker lease guardian returned an invalid handshake.",
          ));
        }
      };
      const timeout = setTimeout(() => {
        settle(new ApplicationError(
          "subprocess",
          "Timed out waiting for the code-worker lease guardian.",
        ));
      }, 2_000);
      guardian.stdout?.on("data", onData);
      void exit.then(result => settle(new ApplicationError(
        "subprocess",
        `Code-worker lease guardian exited during handshake (code ${String(result.code)}, signal ${String(result.signal)}).`,
      )));
    });
    guardian.stdout.resume();
  } catch (error) {
    guardian.kill("SIGTERM");
    await exit;
    throw error;
  }
  const failure = new Promise<never>((_resolve, reject) => {
    void exit.then(result => {
      if (settlementRequested !== undefined) return;
      const detail = new TextDecoder().decode(diagnostics).trim();
      reject(new ApplicationError(
        "subprocess",
        `Code-worker lease guardian exited before compute settled (code ${String(result.code)}, signal ${String(result.signal)})${detail === "" ? "." : `: ${detail}`}`,
      ));
    });
  });
  // The guardian can fail between its ready byte and the first guarded
  // operation. Mark the promise observed immediately; later races still
  // receive the original rejection.
  void failure.catch(() => undefined);

  return {
    complete: async () => {
      if (settlementRequested === "retire") {
        throw new ApplicationError(
          "conflict",
          "Code-worker lease guardian already owns detached retirement.",
        );
      }
      if (settlementRequested === undefined) {
        settlementRequested = "complete";
        if (guardian.exitCode === null && guardian.signalCode === null) {
          await new Promise<void>((resolveWrite, rejectWrite) => {
            const control = guardian.stdin;
            if (control === null) {
              rejectWrite(new Error("Code-worker lease guardian control pipe is missing."));
              return;
            }
            const onError = (error: Error) => rejectWrite(error);
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
        const detail = new TextDecoder().decode(diagnostics).trim();
        throw new ApplicationError(
          "subprocess",
          `Code-worker lease guardian failed (code ${String(result.code)}, signal ${String(result.signal)})${detail === "" ? "." : `: ${detail}`}`,
        );
      }
    },
    failure,
    retireDetached: () => {
      if (settlementRequested !== undefined) return;
      settlementRequested = "retire";
      // Closing the control pipe without `complete` transfers exact worker
      // kill-and-observe ownership to the guardian. Detach every parent-side
      // handle so an uninterruptible worker cannot keep this CLI alive; the
      // guardian retains the inherited kernel lease until exit is observable.
      guardian.stdin?.destroy();
      guardian.stdout?.destroy();
      guardian.stderr?.destroy();
      guardian.unref();
    },
  };
}

class RunningCodeWorkerPool implements CodeWorkerPool {
  readonly #effects = new WorkerEffectRuntime();
  readonly #bunExecutable: string;
  readonly #executions = new Set<Fiber.RuntimeFiber<Exit.Exit<JsonValue, WorkerFailure>, never>>();
  readonly #idle: CodeWorkerSession[];
  readonly #leased = new Set<CodeWorkerSession>();
  readonly #live: Set<CodeWorkerSession>;
  readonly #retiring = new Map<CodeWorkerSession, Promise<void>>();
  readonly #waiting: WaitingWorker[] = [];
  #closed = false;
  #closePromise: Promise<void> | undefined;
  readonly bundleSha256: string;
  readonly size: number;

  constructor(
    bundleSha256: string,
    workers: readonly CodeWorkerSession[],
    bunExecutable: string,
  ) {
    this.#bunExecutable = bunExecutable;
    this.bundleSha256 = bundleSha256;
    this.#idle = [...workers];
    this.#live = new Set(workers);
    this.size = workers.length;
  }

  async execute(request: CodeWorkerComputeRequest): Promise<JsonValue> {
    const admission = this.#acquire(request.abortSignal);
    const fiber = this.#effects.fork(Effect.exit(this.#executeProgram(request, admission)));
    this.#executions.add(fiber);
    fiber.addObserver(() => { this.#executions.delete(fiber); });
    return await this.#effects.run(Effect.flatMap(Fiber.join(fiber), exit => exit));
  }

  #executeProgram(request: CodeWorkerComputeRequest, admission: Effect.Effect<CodeWorkerSession, WorkerFailure>): Effect.Effect<JsonValue, WorkerFailure> {
    return Effect.gen(this, function*() {
      const worker = yield* admission;
      const retire = workerBoundary("retirement", () => this.#retire(worker));
      const started = yield* Effect.either(workerBoundary("admission", () => startCodeWorkerLeaseGuardian({
        bunExecutable: this.#bunExecutable,
        inheritedFileDescriptor: request.inheritedHostResourceFileDescriptor ?? 0,
        workerProcessId: worker.processId,
        workerStartIdentity: worker.processStartIdentity,
      })));
      if (started._tag === "Left") {
        const retired = yield* Effect.either(retire);
        return yield* workerValidation("admission", () => {
          if (retired._tag === "Left") throw new AggregateError(
            [started.left.cause, retired.left.cause],
            "Code-worker guardian startup failed and the worker could not be observably retired.",
          );
          throw started.left.cause;
        });
      }
      const guardian = started.right;
      const complete = workerBoundary("retirement", () => guardian.complete());
      const computation = yield* Effect.either(Effect.raceFirst(
        workerBoundary("compute", () => worker.compute(request)),
        workerBoundary("retirement", () => guardian.failure),
      ));
      if (computation._tag === "Left") {
        const error = computation.left.cause;
        if (error instanceof CodeWorkerCancellationError && error.workerReusable) {
          const completed = yield* Effect.either(complete);
          if (completed._tag === "Left") {
            const retired = yield* Effect.either(retire);
            return yield* workerValidation("retirement", () => {
              if (retired._tag === "Left") throw new AggregateError(
                [error, completed.left.cause, retired.left.cause],
                "Cancelled code worker lost its guardian and could not be observably retired.",
              );
              throw new AggregateError([error, completed.left.cause], "Cancelled code worker's lease guardian failed.");
            });
          }
          if (this.#closed) yield* retire;
          else this.#release(worker);
          return yield* Effect.fail(computation.left);
        }
        // Only confirmed native retirement permits guardian completion.
        const retired = yield* Effect.either(retire);
        if (retired._tag === "Left") {
          guardian.retireDetached();
          return yield* workerValidation("retirement", () => {
            throw new AggregateError(
              [error, retired.left.cause], "Code worker failed and could not be observably retired.",
            );
          });
        }
        const completed = yield* Effect.either(complete);
        if (completed._tag === "Left") return yield* workerValidation("retirement", () => {
          throw new AggregateError(
            [error, completed.left.cause], "Code worker failed after its lease guardian also failed.",
          );
        });
        return yield* Effect.fail(computation.left);
      }
      const output = computation.right;
      if (request.abortSignal?.aborted) {
        const completed = yield* Effect.either(complete);
        if (completed._tag === "Left") {
          const retired = yield* Effect.either(retire);
          return yield* workerValidation("retirement", () => {
            if (retired._tag === "Left") throw new AggregateError(
              [completed.left.cause, retired.left.cause], "Cancelled code worker failed guardian completion and retirement.",
            );
            throw completed.left.cause;
          });
        }
        if (this.#closed) yield* retire;
        else this.#release(worker);
        return yield* workerValidation("compute", () => { throw new CodeWorkerCancellationError(request.nodeKey, true); });
      }
      if (this.#closed) {
        const retired = yield* Effect.either(retire);
        if (retired._tag === "Left") {
          guardian.retireDetached();
          return yield* workerValidation("retirement", () => {
            throw new AggregateError(
              [retired.left.cause], "Completed code worker could not be observably retired.",
            );
          });
        }
        const completed = yield* Effect.either(complete);
        if (completed._tag === "Left") return yield* workerValidation("retirement", () => {
          throw new AggregateError(
            [completed.left.cause], "Retired code worker's lease guardian failed to complete.",
          );
        });
        return output;
      }
      const completed = yield* Effect.either(complete);
      if (completed._tag === "Left") {
        const retired = yield* Effect.either(retire);
        if (retired._tag === "Left") {
          guardian.retireDetached();
          return yield* workerValidation("retirement", () => {
            throw new AggregateError(
              [completed.left.cause, retired.left.cause], "Code-worker completion failed and the worker could not be observably retired.",
            );
          });
        }
        return yield* Effect.fail(completed.left);
      }
      this.#release(worker);
      return output;
    });
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close().finally(async () => await this.#effects.close());
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    const error = new ApplicationError("cancelled", "Code-worker pool closed.");
    this.#rejectWaiting(error);
    this.#idle.splice(0);
    const retirements = [...this.#live].map(worker => this.#retire(worker));
    const retirementSettled = Promise.allSettled([
      ...new Set([...retirements, ...this.#retiring.values()]),
    ]);
    // Execution failures belong to their callers. Closure joins them only so
    // every guardian and inherited lease settles before the pool returns.
    await this.#effects.run(Effect.forEach([...this.#executions], fiber => Effect.asVoid(Fiber.join(fiber)), { concurrency: "unbounded", discard: true }));
    const failure = (await retirementSettled).find(
      result => result.status === "rejected",
    );
    if (failure?.status === "rejected") throw failure.reason;
  }

  #acquire(abortSignal: AbortSignal | undefined): Effect.Effect<CodeWorkerSession, WorkerFailure> {
    if (this.#closed) {
      return workerValidation("admission", () => { throw new ApplicationError("conflict", "Code-worker pool is closed."); });
    }
    if (abortSignal?.aborted === true) {
      return workerValidation("admission", () => {
        throw new ApplicationError(
          "cancelled", "Compute was cancelled before a code worker became available.",
        );
      });
    }
    const worker = this.#idle.shift();
    if (worker !== undefined) {
      this.#leased.add(worker);
      return Effect.succeed(worker);
    }
    if (this.#live.size === 0) {
      return workerValidation("admission", () => {
        throw new ApplicationError(
          "subprocess", "No healthy code worker remains in the pool.",
        );
      });
    }
    const completion = this.#effects.completion<CodeWorkerSession>(0, () => undefined);
    const waiting: WaitingWorker = {
      ...(abortSignal === undefined ? {} : {
        abortSignal,
        abortHandler: () => {
          const index = this.#waiting.indexOf(waiting);
          if (index === -1) return;
          this.#waiting.splice(index, 1);
          completion.fail(new ApplicationError("cancelled", "Compute was cancelled while waiting for a code worker."));
        },
      }),
      reject: completion.fail,
      resolve: completion.succeed,
    };
    if (waiting.abortHandler !== undefined) abortSignal?.addEventListener("abort", waiting.abortHandler, { once: true });
    this.#waiting.push(waiting);
    if (abortSignal?.aborted) waiting.abortHandler?.();
    return completion.await;
  }

  #release(worker: CodeWorkerSession): void {
    if (!this.#leased.delete(worker) || !this.#live.has(worker)) return;
    const waiting = this.#waiting.shift();
    if (waiting === undefined) {
      this.#idle.push(worker);
      return;
    }
    this.#detachWaiting(waiting);
    this.#leased.add(worker);
    waiting.resolve(worker);
  }

  #retire(worker: CodeWorkerSession): Promise<void> {
    const existing = this.#retiring.get(worker);
    if (existing !== undefined) return existing;
    this.#leased.delete(worker);
    this.#live.delete(worker);
    const idleIndex = this.#idle.indexOf(worker);
    if (idleIndex !== -1) this.#idle.splice(idleIndex, 1);
    const retirement = Promise.resolve().then(async () => {
      try {
        await worker.close();
      } finally {
        if (this.#live.size === 0 && !this.#closed) {
          this.#rejectWaiting(new ApplicationError(
            "subprocess",
            "No healthy code worker remains in the pool.",
          ));
        }
      }
    });
    this.#retiring.set(worker, retirement);
    void retirement.finally(() => {
      this.#retiring.delete(worker);
    }).catch(() => undefined);
    return retirement;
  }

  #detachWaiting(waiting: WaitingWorker): void {
    if (waiting.abortHandler !== undefined) {
      waiting.abortSignal?.removeEventListener("abort", waiting.abortHandler);
    }
  }

  #rejectWaiting(error: Error): void {
    for (const waiting of this.#waiting.splice(0)) {
      this.#detachWaiting(waiting);
      waiting.reject(error);
    }
  }
}

function assertExpectedBuild(
  actualInput: Pick<CodeWorkerBuildResult, "graph" | "input">,
  expectedInput: Pick<CodeWorkerBuildResult, "graph" | "input">,
): void {
  const actual = WorkerBuiltWorkflowSchema.parse({
    graph: normalizeAuthoredWorkflowGraph(actualInput.graph),
    input: actualInput.input,
  });
  const expected = WorkerBuiltWorkflowSchema.parse({
    graph: normalizeAuthoredWorkflowGraph(expectedInput.graph),
    input: expectedInput.input,
  });
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new ApplicationError(
      "incompatible",
      "Code worker rebuilt a different workflow graph or normalized input.",
    );
  }
}

function listenProtocolServer(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function acceptProtocolSocket(
  server: Server,
  child: ChildProcess,
  timeoutMs: number,
): Promise<Socket> {
  return new Promise((resolveSocket, rejectSocket) => {
    let settled = false;
    const finish = (result: { readonly error: Error } | { readonly socket: Socket }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.off("connection", onConnection);
      server.off("error", onError);
      child.off("error", onChildError);
      child.off("exit", onExit);
      if ("error" in result) rejectSocket(result.error);
      else resolveSocket(result.socket);
    };
    const onConnection = (socket: Socket) => finish({ socket });
    const onError = (error: Error) => finish({ error });
    const onChildError = (error: Error) => finish({
      error: new ApplicationError(
        "subprocess",
        `Could not start code worker: ${error.message}`,
      ),
    });
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => finish({
      error: new ApplicationError(
        "subprocess",
        `Code worker exited before connecting its protocol socket (code ${String(code)}, signal ${String(signal)}).`,
      ),
    });
    const timer = setTimeout(() => finish({
      error: new ApplicationError(
        "subprocess",
        "Timed out waiting for the code worker protocol connection.",
      ),
    }), timeoutMs);
    server.once("connection", onConnection);
    server.once("error", onError);
    child.once("error", onChildError);
    child.once("exit", onExit);
  });
}

function releaseWorkerStartupGate(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolveGate, rejectGate) => {
    const control = child.stdin;
    if (control === null) {
      rejectGate(new ApplicationError(
        "subprocess",
        "Code worker did not expose its guardian startup gate.",
      ));
      return;
    }
    let settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      control.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (error === undefined) resolveGate();
      else rejectGate(error);
    };
    const onError = (error: Error) => settle(new ApplicationError(
      "subprocess",
      `Code-worker guardian startup gate failed: ${error.message}`,
    ));
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => settle(
      new ApplicationError(
        "subprocess",
        `Code worker exited before its guardian startup gate opened (code ${String(code)}, signal ${String(signal)}).`,
      ),
    );
    const timer = setTimeout(() => settle(new ApplicationError(
      "subprocess",
      "Timed out opening the code-worker guardian startup gate.",
    )), Math.min(timeoutMs, 2_000));
    control.once("error", onError);
    child.once("exit", onExit);
    control.end("guardian-ready\n", () => settle());
  });
}

export async function startCodeWorker(
  options: StartCodeWorkerOptions,
): Promise<CodeWorkerSession> {
  const timeoutMs = positiveBound(
    options.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    "Code worker timeout",
  );
  const maximumDiagnosticBytes = positiveBound(
    options.maximumDiagnosticBytes,
    DEFAULT_MAXIMUM_DIAGNOSTIC_BYTES,
    "Code worker diagnostic byte limit",
  );
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
      "Code-worker preparation requires one safe inherited host-resource descriptor.",
    );
  }
  const bunExecutable = options.bunExecutable ?? process.execPath;
  if (bunExecutable === "") {
    throw new ApplicationError(
      "unavailable",
      "Code mode requires an explicit Bun 1.3.14 executable for its trusted worker process.",
    );
  }
  const workerEntryPath = resolve(
    options.workerEntryPath ?? join(import.meta.dir, "worker-entry.ts"),
  );
  const workerEntrySha256 = createHash("sha256")
    .update(await readFile(workerEntryPath))
    .digest("hex");
  const temporaryParent = resolve(options.temporaryRoot ?? tmpdir());
  await mkdir(temporaryParent, { mode: 0o700, recursive: true });
  const directory = await mkdtemp(join(temporaryParent, "slopcamera-code-worker-"));
  const protocolDirectory = await mkdtemp(join(tmpdir(), "iw-"));
  const socketPath = join(protocolDirectory, "s");
  let child: ChildProcess | undefined;
  let protocol: Socket | undefined;
  let server: Server | undefined;
  let session: RunningCodeWorker | undefined;
  let preparationGuardian: CodeWorkerLeaseGuardian | undefined;
  try {
    const bundlePath = join(directory, "workflow.bundle.js");
    await writeFile(bundlePath, options.bundle.bytes, { flag: "wx", mode: 0o600 });
    await writeFile(join(directory, "tsconfig.json"), `${canonicalJson({
      compilerOptions: {
        baseUrl: ".",
        paths: Object.fromEntries(options.bundle.externalImports.map(external => [
          external.specifier,
          [external.resolvedPath],
        ])),
      },
    })}\n`, { flag: "wx", mode: 0o600 });

    server = createServer();
    await listenProtocolServer(server, socketPath);
    await chmod(socketPath, 0o600);
    child = spawn(
      bunExecutable,
      [
        "run",
        workerEntryPath,
        "--bundle",
        bundlePath,
        "--sha256",
        options.bundle.sha256,
        "--socket",
        socketPath,
        "--preparation-lease-fd",
        inheritedHostResourceFileDescriptor === 0 ? "0" : "3",
      ],
      {
        cwd: directory,
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
    const workerProcessId = child.pid;
    if (workerProcessId === undefined || workerProcessId < 2) {
      throw new ApplicationError("subprocess", "Code worker has no valid process ID.");
    }
    const workerStartIdentity = process.platform === "win32"
      ? "0".repeat(64)
      : captureWorkerProcessStartIdentity(workerProcessId);
    preparationGuardian = await startCodeWorkerLeaseGuardian({
      bunExecutable,
      inheritedFileDescriptor: inheritedHostResourceFileDescriptor,
      workerProcessId,
      workerStartIdentity,
    });
    const startupGate = releaseWorkerStartupGate(child, timeoutMs);
    void startupGate.catch(() => undefined);
    await Promise.race([startupGate, preparationGuardian.failure]);
    const acceptedProtocol = acceptProtocolSocket(server, child, timeoutMs);
    void acceptedProtocol.catch(() => undefined);
    protocol = await Promise.race([
      acceptedProtocol,
      preparationGuardian.failure,
    ]);
    server.close();
    server = undefined;
    session = new RunningCodeWorker({
      child,
      cleanupDirectories: [directory, protocolDirectory],
      maximumDiagnosticBytes,
      preparationGuardian,
      processStartIdentity: workerStartIdentity,
      protocol,
      timeoutMs,
    });
    await Promise.race([
      session.initialize({
        bunRevision: Bun.revision,
        bunVersion: Bun.version,
        bundleSha256: options.bundle.sha256,
        workerEntrySha256,
      }),
      preparationGuardian.failure,
    ]);
    return session;
  } catch (error) {
    server?.close();
    if (session !== undefined) {
      await session.close().catch(() => undefined);
    } else {
      protocol?.destroy();
      const pendingChild = child;
      let childExitObserved = pendingChild === undefined
        || pendingChild.exitCode !== null
        || pendingChild.signalCode !== null;
      if (
        pendingChild !== undefined
        && !childExitObserved
      ) {
        pendingChild.kill("SIGKILL");
        childExitObserved = await new Promise<boolean>(resolveExit => {
          let settled = false;
          const settle = (observed: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            pendingChild.off("exit", onExit);
            resolveExit(observed);
          };
          const onExit = () => settle(true);
          const timeout = setTimeout(() => settle(false), 2_000);
          pendingChild.once("exit", onExit);
          if (
            pendingChild.exitCode !== null
            || pendingChild.signalCode !== null
          ) settle(true);
        });
      }
      if (preparationGuardian !== undefined) {
        if (childExitObserved) {
          await preparationGuardian.complete().catch(() => undefined);
        } else if (pendingChild !== undefined) {
          preparationGuardian.retireDetached();
          // Retirement ownership has moved to the detached guardian. Drop all
          // parent-side worker handles as well so an uninterruptible child
          // cannot keep this CLI alive while the guardian retains the lease.
          pendingChild.stdin?.destroy();
          pendingChild.stdout?.destroy();
          pendingChild.stderr?.destroy();
          pendingChild.unref();
        }
      }
      await Promise.all([
        rm(directory, { force: true, recursive: true }),
        rm(protocolDirectory, { force: true, recursive: true }),
      ]);
    }
    throw error;
  }
}

export async function buildInCodeWorker(
  options: BuildInCodeWorkerOptions,
): Promise<CodeWorkerBuildResult> {
  const session = await startCodeWorker(options);
  try {
    return await session.build(options.registry, options.workflowInput);
  } finally {
    await session.close();
  }
}

export async function startCodeWorkerPool(
  options: StartCodeWorkerPoolOptions,
): Promise<CodeWorkerPool> {
  const requestedWorkers = positiveBound(
    options.maximumWorkers,
    MAX_CODE_WORKER_POOL_SIZE,
    "Code worker pool size",
  );
  const size = Math.min(requestedWorkers, MAX_CODE_WORKER_POOL_SIZE);
  const registrySnapshot = Object.freeze([...options.registry.list()]);
  const registry = {
    list: () => registrySnapshot,
  };
  const workers: CodeWorkerSession[] = [];
  try {
    if (options.initialWorker !== undefined) {
      workers.push(options.initialWorker.session);
      if (options.initialWorker.session.bundleSha256 !== options.bundle.sha256) {
        throw new ApplicationError(
          "incompatible",
          "Initial code worker bundle does not match the pool bundle.",
        );
      }
      assertExpectedBuild(options.initialWorker.build, options.expectedBuild);
    }
    const started = await Promise.allSettled(
      Array.from({ length: size - workers.length }, async () => {
        const worker = await startCodeWorker(options);
        try {
          const built = await worker.build(
            registry,
            options.workflowInput,
            options.workflowInputMode,
          );
          assertExpectedBuild(built, options.expectedBuild);
          return worker;
        } catch (error) {
          await worker.close().catch(() => undefined);
          throw error;
        }
      }),
    );
    for (const result of started) {
      if (result.status === "fulfilled") workers.push(result.value);
    }
    const failure = started.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    if (workers.length !== size) {
      throw new ApplicationError(
        "internal",
        "Code-worker pool did not initialize its bounded worker set.",
      );
    }
    return new RunningCodeWorkerPool(
      options.bundle.sha256,
      workers,
      options.bunExecutable ?? process.execPath,
    );
  } catch (error) {
    await Promise.all(workers.map(async worker => {
      await worker.close().catch(() => undefined);
    }));
    throw error;
  }
}
