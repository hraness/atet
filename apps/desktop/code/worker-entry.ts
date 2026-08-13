import { createHash } from "node:crypto";
import { closeSync, readFileSync } from "node:fs";
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ApplicationError, asApplicationError } from "../application/errors";
import { canonicalJson } from "../core/canonical-json";
import {
  isComputeGraphNode,
  JsonValueSchema,
  type AnyTrustedComputeDefinition,
  type AuthoredWorkflowGraphV1,
  type WorkflowOutputValue,
} from "./contracts";
import {
  buildWorkflowRuntime,
  buildWorkflowRuntimeFromParsedInput,
  type WorkflowDefinition,
} from "./define-workflow";
import {
  CODE_WORKER_PROTOCOL,
  CodeWorkerRequestSchema,
  CodeWorkerResponseSchema,
  WorkerFrameDecoder,
  encodeCodeWorkerDiagnosticBarrier,
  encodeWorkerFrame,
  type CodeWorkerRequest,
  type CodeWorkerResponse,
} from "./worker-protocol";
import { establishCurrentWorkerProcessGroup } from "./worker-process-identity";

const WORKER_GENERATION = 1;
const GUARDIAN_READY = "guardian-ready\n";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value === "") {
    throw new Error(`Missing code-worker argument: ${name}`);
  }
  return value;
}

function writeFrame(socket: Socket, message: unknown): Promise<void> {
  const frame = encodeWorkerFrame(message);
  return new Promise((resolveWrite, rejectWrite) => {
    socket.write(frame, error => {
      if (error === null || error === undefined) resolveWrite();
      else rejectWrite(error);
    });
  });
}

function writeDiagnosticBarrier(
  stream: NodeJS.WriteStream,
  barrier: string,
  diagnosticStream: "stderr" | "stdout",
): Promise<void> {
  const marker = encodeCodeWorkerDiagnosticBarrier(barrier, diagnosticStream);
  return new Promise((resolveWrite, rejectWrite) => {
    stream.write(marker, error => {
      if (error === null || error === undefined) resolveWrite();
      else rejectWrite(error);
    });
  });
}

async function writeResponse(
  socket: Socket,
  value: unknown,
): Promise<void> {
  const response = CodeWorkerResponseSchema.parse(value);
  await Promise.all([
    writeDiagnosticBarrier(process.stderr, response.diagnosticBarrier, "stderr"),
    writeDiagnosticBarrier(process.stdout, response.diagnosticBarrier, "stdout"),
  ]);
  await writeFrame(socket, response);
}

function workerProtocolChunk(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new TypeError("Code-worker protocol received a non-byte socket chunk.");
}

async function waitForGuardianReady(): Promise<void> {
  process.stdin.setEncoding("utf8");
  let input = "";
  for await (const chunk of process.stdin) {
    if (typeof chunk !== "string") {
      throw new TypeError("Code-worker guardian startup gate was not UTF-8 text.");
    }
    input += chunk;
    if (
      input.length > GUARDIAN_READY.length
      || !GUARDIAN_READY.startsWith(input)
    ) {
      throw new Error("Code-worker guardian startup gate is invalid.");
    }
  }
  if (input !== GUARDIAN_READY) {
    throw new Error("Code-worker guardian startup gate closed before readiness.");
  }
}

function errorResponse(
  request: CodeWorkerRequest,
  error: unknown,
): CodeWorkerResponse {
  const failure = asApplicationError(error);
  const rawCode = (
    typeof error === "object"
    && error !== null
    && "code" in error
  )
    ? Reflect.get(error, "code")
    : undefined;
  const rawMessage = (
    typeof error === "object"
    && error !== null
    && "message" in error
  )
    ? Reflect.get(error, "message")
    : undefined;
  const structuralCode = typeof rawCode === "string"
    ? rawCode
    : failure.code;
  const structuralMessage = typeof rawMessage === "string"
    ? rawMessage
    : failure.message;
  return {
    diagnosticBarrier: request.requestId,
    error: {
      code: structuralCode === "cancelled"
        ? "cancelled"
        : structuralCode === "invalid-data" || structuralCode === "usage"
          ? "invalid-output"
          : "execution",
      message: structuralMessage.slice(0, 2_000),
    },
    generation: request.generation,
    kind: "response",
    protocol: CODE_WORKER_PROTOCOL,
    requestId: request.requestId,
    status: "error",
  };
}

async function main(): Promise<void> {
  const bundlePath = argument("--bundle");
  const expectedSha256 = argument("--sha256");
  const socketPath = argument("--socket");
  const preparationLeaseFd = Number(argument("--preparation-lease-fd"));
  if (
    !Number.isSafeInteger(preparationLeaseFd)
    || preparationLeaseFd < 0
    || (preparationLeaseFd > 0 && preparationLeaseFd < 3)
  ) {
    throw new Error("Code-worker preparation lease descriptor is invalid.");
  }
  let preparationLeaseReleased = preparationLeaseFd === 0;
  const releasePreparationLease = () => {
    if (preparationLeaseReleased) return;
    closeSync(preparationLeaseFd);
    preparationLeaseReleased = true;
  };
  establishCurrentWorkerProcessGroup();
  // Authored modules may execute arbitrary synchronous top-level code. Do not
  // read or evaluate them until the parent has installed the lease guardian.
  // If the parent dies first, pipe EOF makes this worker exit without import.
  await waitForGuardianReady();
  const workerEntryBytes = readFileSync(fileURLToPath(import.meta.url));
  const workerEntrySha256 = createHash("sha256")
    .update(workerEntryBytes)
    .digest("hex");
  const bundleBytes = readFileSync(bundlePath);
  const actualSha256 = createHash("sha256").update(bundleBytes).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new Error("Code-worker bundle hash does not match the requested identity.");
  }
  const loaded: unknown = await import(
    `${pathToFileURL(bundlePath).href}?sha256=${actualSha256}`
  );
  if (typeof loaded !== "object" || loaded === null || !("default" in loaded)) {
    throw new Error("Workflow bundle must have one default workflow definition export.");
  }
  const definition = Reflect.get(loaded, "default") as WorkflowDefinition<
    unknown,
    WorkflowOutputValue
  >;
  let computeDefinitions = new Map<string, AnyTrustedComputeDefinition>();
  let graph: AuthoredWorkflowGraphV1 | undefined;
  const protocol = createConnection({ path: socketPath });
  await once(protocol, "connect");
  await writeFrame(protocol, {
    bunRevision: Bun.revision,
    bunVersion: Bun.version,
    bundleSha256: actualSha256,
    generation: WORKER_GENERATION,
    kind: "hello",
    protocol: CODE_WORKER_PROTOCOL,
    workerEntrySha256,
  });

  const decoder = new WorkerFrameDecoder();
  const activeComputations = new Map<string, AbortController>();
  const queuedComputeRequests = new Map<string, Extract<
    CodeWorkerRequest,
    { readonly action: "compute" }
  >>();
  const terminallyCancelledQueuedRequests = new Set<string>();
  let requestTail = Promise.resolve();

  const cancellationError = (request: Extract<
    CodeWorkerRequest,
    { readonly action: "compute" }
  >) => new ApplicationError(
    "cancelled",
    `Compute node ${request.nodeKey} was cancelled.`,
  );

  const executeCompute = async (
    request: Extract<CodeWorkerRequest, { readonly action: "compute" }>,
  ): Promise<void> => {
    queuedComputeRequests.delete(request.requestId);
    if (terminallyCancelledQueuedRequests.delete(request.requestId)) return;
    const abortController = new AbortController();
    activeComputations.set(request.requestId, abortController);
    let response: CodeWorkerResponse;
    try {
      const node = graph?.nodes.find(candidate => candidate.key === request.nodeKey);
      const compute = computeDefinitions.get(request.computeKey);
      if (
        node === undefined
        || !isComputeGraphNode(node)
        || node.executor.compute.key !== request.computeKey
        || compute === undefined
      ) {
        response = CodeWorkerResponseSchema.parse({
          diagnosticBarrier: request.requestId,
          error: {
            code: "unknown-compute",
            message: `Unknown compute callback: ${request.computeKey}`,
          },
          generation: request.generation,
          kind: "response",
          protocol: CODE_WORKER_PROTOCOL,
          requestId: request.requestId,
          status: "error",
        });
      } else {
        const input = compute.inputSchema.parse(request.input);
        const inputJson = JsonValueSchema.parse(input);
        if (
          new TextEncoder().encode(canonicalJson(inputJson)).byteLength
          > node.executor.compute.bounds.maxInputBytes
        ) {
          throw new Error(
            `Compute input exceeds its bound for ${request.nodeKey}.`,
          );
        }
        const output = compute.outputSchema.parse(await compute.run(input, {
          abortSignal: abortController.signal,
          nodeKey: request.nodeKey,
          replayAcknowledged: request.replayAcknowledged,
        }));
        if (abortController.signal.aborted) {
          throw cancellationError(request);
        }
        const outputJson = JsonValueSchema.parse(output);
        if (
          new TextEncoder().encode(canonicalJson(outputJson)).byteLength
          > node.executor.compute.bounds.maxOutputBytes
        ) {
          throw new Error(
            `Compute output exceeds its bound for ${request.nodeKey}.`,
          );
        }
        response = CodeWorkerResponseSchema.parse({
          diagnosticBarrier: request.requestId,
          generation: request.generation,
          kind: "response",
          output: outputJson,
          protocol: CODE_WORKER_PROTOCOL,
          requestId: request.requestId,
          status: "ok",
        });
      }
    } catch (error) {
      response = errorResponse(
        request,
        abortController.signal.aborted
          ? cancellationError(request)
          : error,
      );
    }
    try {
      await writeResponse(protocol, response);
    } finally {
      activeComputations.delete(request.requestId);
    }
  };

  const executeRequest = async (request: CodeWorkerRequest): Promise<void> => {
    if (request.action === "shutdown") {
      await writeResponse(protocol, {
        diagnosticBarrier: request.requestId,
        generation: request.generation,
        kind: "response",
        output: { stopped: true },
        protocol: CODE_WORKER_PROTOCOL,
        requestId: request.requestId,
        status: "ok",
      });
      protocol.destroy();
      return;
    }
    if (request.action === "compute") {
      await executeCompute(request);
      return;
    }
    if (request.action === "cancel") {
      throw new ApplicationError(
        "internal",
        "Code-worker cancellation escaped immediate dispatch.",
      );
    }
    let response: CodeWorkerResponse;
    try {
      // The guardian owns crash-safe retention of the preparation lease from
      // here. Drop the worker's copy before authored build code begins so this
      // long-lived process cannot strand the full machine budget.
      releasePreparationLease();
      const built = request.inputMode === "parsed"
        ? buildWorkflowRuntimeFromParsedInput(
            definition,
            { list: () => request.registry },
            request.workflowInput,
          )
        : buildWorkflowRuntime(
            definition,
            { list: () => request.registry },
            request.workflowInput,
          );
      graph = built.graph;
      computeDefinitions = new Map(
        built.computeDefinitions.map(compute => [compute.key, compute]),
      );
      response = CodeWorkerResponseSchema.parse({
        diagnosticBarrier: request.requestId,
        generation: request.generation,
        kind: "response",
        output: {
          graph: built.graph,
          input: built.input,
        },
        protocol: CODE_WORKER_PROTOCOL,
        requestId: request.requestId,
        status: "ok",
      });
    } catch (error) {
      response = errorResponse(request, error);
    }
    await writeResponse(protocol, response);
  };

  for await (const chunk of protocol) {
    for (const message of decoder.push(workerProtocolChunk(chunk))) {
      const parsed = CodeWorkerRequestSchema.safeParse(message);
      if (!parsed.success) continue;
      const request = parsed.data;
      if (request.generation !== WORKER_GENERATION) {
        await writeResponse(
          protocol,
          errorResponse(request, new Error("Code-worker generation mismatch.")),
        );
        continue;
      }
      if (request.action === "cancel") {
        const active = activeComputations.get(request.targetRequestId);
        const queued = queuedComputeRequests.get(request.targetRequestId);
        if (active !== undefined) {
          active.abort(new ApplicationError(
            "cancelled",
            `Compute request ${request.targetRequestId} was cancelled.`,
          ));
        } else if (queued !== undefined) {
          queuedComputeRequests.delete(request.targetRequestId);
          terminallyCancelledQueuedRequests.add(request.targetRequestId);
          // Complete a queued cancellation immediately. Otherwise the client
          // waiter would retain its original execution timeout while unrelated
          // active authored work is still ahead of it in request order.
          await writeResponse(protocol, errorResponse(
            queued,
            cancellationError(queued),
          ));
        }
        await writeResponse(protocol, {
          diagnosticBarrier: request.requestId,
          generation: request.generation,
          kind: "response",
          output: {
            cancellation: active !== undefined
              ? "active"
              : queued !== undefined
                ? "queued"
                : "missing",
          },
          protocol: CODE_WORKER_PROTOCOL,
          requestId: request.requestId,
          status: "ok",
        });
        continue;
      }
      if (request.action === "compute") {
        queuedComputeRequests.set(request.requestId, request);
      }
      requestTail = requestTail
        .then(async () => await executeRequest(request))
        .catch(() => {
          protocol.destroy();
        });
    }
  }
  for (const abortController of activeComputations.values()) {
    abortController.abort(new ApplicationError(
      "cancelled",
      "Code-worker protocol closed during compute.",
    ));
  }
  decoder.finish();
  protocol.destroy();
}

await main();
