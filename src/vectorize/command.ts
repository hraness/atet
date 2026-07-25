import { VectorizeError, type VectorizeErrorCode } from "./types.ts"

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1_024
const TERMINATION_GRACE_MS = 50
const HARD_KILL_WAIT_MS = 500

const timeoutMarker = Symbol("bounded-command-timeout")
let isolateSpawnedProcessGroups = true

export interface CommandResult {
  readonly stderr: string
  readonly stdout: string
}

export interface BoundedCommandOptions {
  /** Bounded bytes delivered to the child on standard input. */
  readonly stdin?: Uint8Array
  /** Raise the stdout quota only for a caller that consumes bounded data there. */
  readonly maxStdoutBytes?: number
}

interface ManagedSubprocess {
  readonly exitCode: number | null
  readonly exited: Promise<number>
  kill(signal?: number | NodeJS.Signals): void
  readonly pid: number
  readonly stderr: ReadableStream<Uint8Array>
  readonly stdout: ReadableStream<Uint8Array>
}

/**
 * Keep conversion descendants in the already-isolated worker process group.
 * This is process-local and called only by the worker entrypoint.
 */
export function inheritVectorizeWorkerProcessGroup(): void {
  isolateSpawnedProcessGroups = false
}

export async function runBoundedCommand(
  command: readonly string[],
  timeoutMs: number,
  failureCode: VectorizeErrorCode,
  options: BoundedCommandOptions = {},
): Promise<CommandResult> {
  if (command.length === 0) {
    throw new VectorizeError("invalid_input", "A bounded command requires a command.")
  }
  if (timeoutMs < 1) {
    throw new VectorizeError("timeout", "VTracer exceeded the conversion time limit.")
  }
  const maxStdoutBytes = options.maxStdoutBytes ?? MAX_COMMAND_OUTPUT_BYTES
  if (!Number.isSafeInteger(maxStdoutBytes) || maxStdoutBytes < 1) {
    throw new VectorizeError("invalid_input", "The command stdout limit must be positive.")
  }

  let child: ManagedSubprocess
  const ownsProcessGroup = isolateSpawnedProcessGroups
  try {
    child = Bun.spawn([...command], {
      detached: ownsProcessGroup,
      env: process.env,
      stderr: "pipe",
      stdin: options.stdin ?? "ignore",
      stdout: "pipe",
      windowsHide: true,
    })
  } catch (error) {
    throw executionError(failureCode, error)
  }

  const streamAbort = new AbortController()
  const stdoutTask = readBoundedText(
    child.stdout,
    maxStdoutBytes,
    streamAbort.signal,
    "VTracer emitted too much primary output.",
  )
  const stderrTask = readBoundedText(
    child.stderr,
    MAX_COMMAND_OUTPUT_BYTES,
    streamAbort.signal,
    "VTracer emitted too much diagnostic output.",
  )
  const executionTask = Promise.all([
    child.exited,
    stdoutTask,
    stderrTask,
  ]).then(([exitCode, stdout, stderr]) => {
    if (exitCode !== 0) {
      throw new VectorizeError(
        failureCode,
        [
          `Command failed (${exitCode}): ${command[0] ?? "unknown"}`,
          stderr.trim(),
        ]
          .filter(Boolean)
          .join("\n"),
        { exitCode },
      )
    }
    return { stderr, stdout }
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutTask = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(timeoutMarker), timeoutMs)
  })

  try {
    return await Promise.race([executionTask, timeoutTask])
  } catch (error) {
    let cleanupError: unknown
    try {
      await terminateAndWait(child, ownsProcessGroup)
    } catch (caught) {
      cleanupError = caught
    } finally {
      streamAbort.abort()
      await settlesWithin(
        Promise.allSettled([stdoutTask, stderrTask]),
        HARD_KILL_WAIT_MS,
      )
    }

    if (error === timeoutMarker) {
      throw new VectorizeError(
        "timeout",
        cleanupError === undefined
          ? "VTracer exceeded the conversion time limit."
          : "VTracer exceeded the conversion time limit and did not terminate cleanly.",
        cleanupError === undefined ? {} : { cleanup: String(cleanupError) },
      )
    }
    if (error instanceof VectorizeError) throw error
    if (cleanupError instanceof VectorizeError) throw cleanupError
    throw executionError(failureCode, error)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function terminateAndWait(
  child: ManagedSubprocess,
  ownsProcessGroup: boolean,
): Promise<void> {
  if (process.platform === "win32") {
    await killWindowsProcessTree(child.pid)
  } else if (!ownsProcessGroup) {
    safelyKillChild(child, "SIGTERM")
    await delay(TERMINATION_GRACE_MS)
    safelyKillChild(child, "SIGKILL")
  } else {
    safelyKillPosixProcessGroup(child, "SIGTERM")
    await delay(TERMINATION_GRACE_MS)
    // The group may still contain descendants after its leader exits.
    safelyKillPosixProcessGroup(child, "SIGKILL")
  }
  if (await settlesWithin(child.exited, HARD_KILL_WAIT_MS)) return
  throw new VectorizeError(
    "trace_failed",
    "VTracer did not exit after forced termination.",
  )
}

function safelyKillChild(
  child: ManagedSubprocess,
  signal: NodeJS.Signals,
): void {
  try {
    child.kill(signal)
  } catch {
    // A concurrent exit is equivalent to successful termination.
  }
}

function safelyKillPosixProcessGroup(
  child: ManagedSubprocess,
  signal: NodeJS.Signals,
): void {
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // A concurrent group exit is equivalent to successful termination.
    }
  }
}

async function killWindowsProcessTree(pid: number): Promise<void> {
  let killer: ManagedSubprocess
  try {
    killer = Bun.spawn(
      ["taskkill.exe", "/PID", String(pid), "/T", "/F"],
      {
        detached: false,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
        windowsHide: true,
      },
    )
  } catch {
    return
  }
  const drain = Promise.all([
    readBoundedText(
      killer.stdout,
      MAX_COMMAND_OUTPUT_BYTES,
      AbortSignal.timeout(HARD_KILL_WAIT_MS),
      "Process-tree cleanup emitted too much output.",
    ),
    readBoundedText(
      killer.stderr,
      MAX_COMMAND_OUTPUT_BYTES,
      AbortSignal.timeout(HARD_KILL_WAIT_MS),
      "Process-tree cleanup emitted too much output.",
    ),
  ])
  if (!(await settlesWithin(Promise.all([killer.exited, drain]), HARD_KILL_WAIT_MS))) {
    try {
      killer.kill("SIGKILL")
    } catch {
      // Cleanup is already best-effort after a taskkill timeout.
    }
  }
}

async function settlesWithin(promise: Promise<unknown>, durationMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let finished = false
    const timer = setTimeout(() => finish(false), durationMs)
    void promise.then(
      () => finish(true),
      () => finish(true),
    )
    function finish(settled: boolean): void {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve(settled)
    }
  })
}

async function readBoundedText(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  signal: AbortSignal,
  limitMessage: string,
): Promise<string> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener("abort", cancel, { once: true })
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maximumBytes) {
        await reader.cancel()
        throw new VectorizeError("output_limit", limitMessage, {
          bytes,
          maximumBytes,
        })
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks, bytes).toString("utf8")
  } finally {
    signal.removeEventListener("abort", cancel)
    reader.releaseLock()
  }
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs)
  })
}

function executionError(failureCode: VectorizeErrorCode, cause: unknown): VectorizeError {
  return new VectorizeError(
    failureCode,
    "VTracer could not be executed.",
    {},
    { cause: cause instanceof Error ? cause : new Error(String(cause)) },
  )
}
