import { fileURLToPath } from "node:url"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { runBoundedCommand } from "./command.ts"
import { resolveVectorizeLimits } from "./limits.ts"
import {
  MAX_VECTORIZE_REQUEST_BYTES,
  MAX_VECTORIZE_RESPONSE_BYTES,
  VECTORIZE_WORKER_PROTOCOL,
  type VectorizeWorkerRequest,
  type VectorizeWorkerResponse,
} from "./worker-protocol.ts"
import {
  VectorizeError,
  vectorizeProfileNames,
  type VectorizeErrorCode,
  type VectorizeInput,
  type VectorizeOptions,
  type VectorizeResult,
} from "./types.ts"

const vectorizeErrorCodes = new Set<VectorizeErrorCode>([
  "input_limit",
  "invalid_input",
  "output_limit",
  "quality_limit",
  "timeout",
  "tool_download",
  "tool_integrity",
  "tool_platform",
  "tool_version",
  "trace_failed",
  "unsafe_svg",
])
const WORKER_SHUTDOWN_RESERVE_MS = 250
const WORKER_RESPONSE_RESERVE_MS = 100

export async function runVectorizeWorker(
  input: VectorizeInput,
  options: VectorizeOptions,
): Promise<VectorizeResult> {
  const startedAt = performance.now()
  const limits = resolveVectorizeLimits(options.limits)
  if (process.platform === "win32") {
    throw new VectorizeError(
      "tool_platform",
      "Bounded VTracer streaming is unavailable on Windows.",
      { platform: process.platform },
    )
  }
  const workerInput = encodeInput(input, limits.maxInputBytes)
  const temporaryRoot = await mkdtemp(join(tmpdir(), "graphics-vectorize-"))
  let result: VectorizeResult
  try {
    result = await executeVectorizeWorker(
      workerInput,
      options,
      limits,
      startedAt,
      temporaryRoot,
    )
  } finally {
    await removeTemporaryRoot(temporaryRoot)
  }
  if (performance.now() - startedAt >= limits.maxDurationMs) {
    throw new VectorizeError(
      "timeout",
      "Vectorization exceeded the conversion time limit during cleanup.",
    )
  }
  return result
}

async function executeVectorizeWorker(
  workerInput: VectorizeWorkerRequest["input"],
  options: VectorizeOptions,
  limits: ReturnType<typeof resolveVectorizeLimits>,
  startedAt: number,
  temporaryRoot: string,
): Promise<VectorizeResult> {
  const preparationRemainingMs =
    limits.maxDurationMs - (performance.now() - startedAt)
  if (
    preparationRemainingMs <=
    WORKER_SHUTDOWN_RESERVE_MS + WORKER_RESPONSE_RESERVE_MS
  ) {
    throw new VectorizeError(
      "timeout",
      "Vectorization has no remaining budget for isolated worker execution.",
    )
  }
  const workerDurationMs = Math.floor(
    preparationRemainingMs -
      WORKER_SHUTDOWN_RESERVE_MS -
      WORKER_RESPONSE_RESERVE_MS,
  )
  const request: VectorizeWorkerRequest = {
    input: workerInput,
    options: cloneOptions(options, workerDurationMs),
    protocol: VECTORIZE_WORKER_PROTOCOL,
    temporaryRoot,
  }
  const requestBytes = Buffer.from(JSON.stringify(request))
  if (requestBytes.byteLength > MAX_VECTORIZE_REQUEST_BYTES) {
    throw new VectorizeError(
      "input_limit",
      "The vectorization worker request exceeds its IPC limit.",
      {
        bytes: requestBytes.byteLength,
        maximumBytes: MAX_VECTORIZE_REQUEST_BYTES,
      },
    )
  }
  const remainingMs = limits.maxDurationMs - (performance.now() - startedAt)
  if (remainingMs <= WORKER_SHUTDOWN_RESERVE_MS) {
    throw new VectorizeError(
      "timeout",
      "Vectorization has no remaining budget for isolated worker startup and cleanup.",
    )
  }

  const { stdout } = await runBoundedCommand(
    [process.execPath, workerEntryPath()],
    Math.floor(remainingMs - WORKER_SHUTDOWN_RESERVE_MS),
    "trace_failed",
    {
      maxStdoutBytes: MAX_VECTORIZE_RESPONSE_BYTES,
      stdin: requestBytes,
    },
  )
  if (performance.now() - startedAt >= limits.maxDurationMs) {
    throw new VectorizeError(
      "timeout",
      "Vectorization exceeded the conversion time limit.",
    )
  }
  const response = parseResponse(stdout)
  if (!response.ok) {
    throw new VectorizeError(
      response.error.code,
      response.error.message,
      response.error.details,
    )
  }
  assertResult(response.result, limits.maxOutputBytes)
  if (performance.now() - startedAt >= limits.maxDurationMs) {
    throw new VectorizeError(
      "timeout",
      "Vectorization exceeded the conversion time limit.",
    )
  }
  return response.result
}

async function removeTemporaryRoot(temporaryRoot: string): Promise<void> {
  try {
    await rm(temporaryRoot, { force: true, recursive: true })
  } catch (error) {
    throw new VectorizeError(
      "trace_failed",
      "The isolated vectorization directory could not be removed.",
      { temporaryRoot },
      { cause: error },
    )
  }
}

function encodeInput(
  input: VectorizeInput,
  maximumInputBytes: number,
): VectorizeWorkerRequest["input"] {
  return typeof input === "string"
    ? { kind: "path", value: input }
    : encodeBytes(input, maximumInputBytes)
}

function encodeBytes(
  input: Uint8Array | ArrayBuffer,
  maximumInputBytes: number,
): Readonly<{ kind: "bytes"; value: string }> {
  const view = input instanceof ArrayBuffer ? new Uint8Array(input) : input
  if (view.byteLength < 1) {
    throw new VectorizeError("invalid_input", "Raster input is empty.")
  }
  if (view.byteLength > maximumInputBytes) {
    throw new VectorizeError(
      "input_limit",
      `Raster input exceeds the ${maximumInputBytes}-byte limit.`,
      { bytes: view.byteLength, maximumBytes: maximumInputBytes },
    )
  }
  return {
    kind: "bytes",
    value: Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("base64"),
  }
}

function cloneOptions(
  options: VectorizeOptions,
  workerDurationMs: number,
): VectorizeOptions {
  return {
    ...(options.alphaCutoff === undefined ? {} : { alphaCutoff: options.alphaCutoff }),
    ...(options.cacheDirectory === undefined
      ? {}
      : { cacheDirectory: options.cacheDirectory }),
    ...(options.duotone === undefined
      ? {}
      : { duotone: [options.duotone[0], options.duotone[1]] as const }),
    limits: {
      ...options.limits,
      maxDurationMs: workerDurationMs,
    },
    ...(options.outputPath === undefined ? {} : { outputPath: options.outputPath }),
  }
}

function workerEntryPath(): string {
  const modulePath = fileURLToPath(import.meta.url)
  return modulePath.endsWith(".ts")
    ? join(dirname(modulePath), "worker.ts")
    : join(dirname(modulePath), "vectorize-worker.js")
}

function parseResponse(stdout: string): VectorizeWorkerResponse {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new VectorizeError(
      "trace_failed",
      "The vectorization worker returned malformed output.",
      {},
      { cause: error },
    )
  }
  if (!isRecord(parsed) || parsed.protocol !== VECTORIZE_WORKER_PROTOCOL) {
    throw new VectorizeError(
      "trace_failed",
      "The vectorization worker returned an incompatible response.",
    )
  }
  if (parsed.ok === true && isVectorizeResult(parsed.result)) {
    return parsed as unknown as VectorizeWorkerResponse
  }
  if (
    parsed.ok === false &&
    isRecord(parsed.error) &&
    typeof parsed.error.code === "string" &&
    vectorizeErrorCodes.has(parsed.error.code as VectorizeErrorCode) &&
    typeof parsed.error.message === "string" &&
    isRecord(parsed.error.details)
  ) {
    return parsed as unknown as VectorizeWorkerResponse
  }
  throw new VectorizeError(
    "trace_failed",
    "The vectorization worker returned an invalid response.",
  )
}

function assertResult(result: VectorizeResult, maximumOutputBytes: number): void {
  const bytes = Buffer.byteLength(result.svg)
  if (
    bytes < 1 ||
    bytes > maximumOutputBytes ||
    result.receipt.bytes !== bytes ||
    result.receipt.svgSha256.length !== 64
  ) {
    throw new VectorizeError(
      "trace_failed",
      "The vectorization worker response violates its output contract.",
      { bytes, maximumOutputBytes },
    )
  }
}

function isVectorizeResult(value: unknown): value is VectorizeResult {
  if (
    !isRecord(value) ||
    (value.outputPath !== null && typeof value.outputPath !== "string") ||
    typeof value.svg !== "string" ||
    !isRecord(value.receipt)
  ) {
    return false
  }
  const profile = value.receipt.profile
  return (
    typeof value.receipt.bytes === "number" &&
    typeof value.receipt.svgSha256 === "string" &&
    typeof profile === "string" &&
    vectorizeProfileNames.includes(
      profile as (typeof vectorizeProfileNames)[number],
    )
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
