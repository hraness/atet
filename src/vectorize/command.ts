import { AsyncLocalStorage } from "node:async_hooks"
import { constants } from "node:fs"
import {
  lstat,
  mkdtemp,
  open,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises"
import { join } from "node:path"
import { VectorizeError, type VectorizeErrorCode } from "./types.js"

const MAX_COMMAND_OUTPUT_BYTES = 64 * 1_024
const PRIMARY_OUTPUT_READ_BYTES = 64 * 1_024
const PRIMARY_OUTPUT_POLL_MS = 2
const PRIMARY_OUTPUT_EXIT_EMPTY_POLLS = 2
const TERMINATION_GRACE_MS = 50
const HARD_KILL_WAIT_MS = 500
const MAX_INHERITED_FILE_DESCRIPTORS = 16

const timeoutMarker = Symbol("bounded-command-timeout")
const noCommandFailure = Symbol("no-command-failure")
const activePosixProcessGroups = new Set<number>()
let workerTerminationForwardingInstalled = false
const inheritedCommandFileDescriptors = new AsyncLocalStorage<readonly number[]>()

export interface CommandResult {
  readonly stderr: string
  readonly stdout: string
}

export interface BoundedCommandOptions {
  /**
   * Open descriptors explicitly duplicated into the child from descriptor 3.
   * Values are local execution authority and never enter receipts or logs.
   */
  readonly inheritedFileDescriptors?: readonly number[]
  /** Bounded bytes delivered to the child on standard input. */
  readonly stdin?: Uint8Array
  /** Raise the stdout quota only for a caller that consumes bounded data there. */
  readonly maxStdoutBytes?: number
}

function normalizedInheritedFileDescriptors(
  value: readonly number[] | undefined,
): readonly number[] {
  const descriptors = value ?? []
  if (
    descriptors.length > MAX_INHERITED_FILE_DESCRIPTORS
    || descriptors.some((descriptor, index) => (
      !Number.isSafeInteger(descriptor)
      || descriptor < 0
      || descriptor > 2_147_483_647
      || descriptors.indexOf(descriptor) !== index
    ))
  ) {
    throw new VectorizeError(
      "invalid_input",
      "Inherited vectorizer descriptors must be unique bounded integers.",
    )
  }
  return Object.freeze([...descriptors])
}

export async function withInheritedCommandFileDescriptors<T>(
  descriptors: readonly number[] | undefined,
  callback: () => T | Promise<T>,
): Promise<T> {
  const normalized = normalizedInheritedFileDescriptors(descriptors)
  return await inheritedCommandFileDescriptors.run(
    normalized,
    async () => await callback(),
  )
}

export interface BoundedPathOutputOptions extends BoundedCommandOptions {
  /** Maximum bytes accepted from the command's pathname-based primary output. */
  readonly maxOutputBytes: number
  /** Existing private directory in which to create the per-call output endpoint. */
  readonly temporaryRoot: string
}

export interface PathOutputCommandResult extends CommandResult {
  readonly output: string
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
 * Forward supervisor termination into every command group owned by the
 * isolated worker. This is process-local and called only by the worker
 * entrypoint before conversion begins.
 */
export function forwardVectorizeWorkerTermination(): void {
  if (
    process.platform === "win32" ||
    workerTerminationForwardingInstalled
  ) {
    return
  }
  workerTerminationForwardingInstalled = true
  const signals = [
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const
  for (const [signal, exitCode] of signals) {
    process.once(signal, () => {
      for (const pid of activePosixProcessGroups) {
        safelyKillPosixProcessGroupByPid(pid, "SIGKILL")
      }
      process.exit(exitCode)
    })
  }
}

export async function runBoundedCommand(
  command: readonly string[],
  timeoutMs: number,
  failureCode: VectorizeErrorCode,
  options: BoundedCommandOptions = {},
): Promise<CommandResult> {
  return runBoundedCommandInternal(command, timeoutMs, failureCode, options)
}

/**
 * Run a command whose primary output must be a pathname while retaining a
 * bounded streaming boundary. A private FIFO gives pathname-only tools a
 * portable output argument and applies backpressure before output can exceed
 * the in-memory quota.
 */
export async function runBoundedPathOutputCommand(
  commandForOutput: (outputPath: string) => readonly string[],
  timeoutMs: number,
  failureCode: VectorizeErrorCode,
  options: BoundedPathOutputOptions,
): Promise<PathOutputCommandResult> {
  if (process.platform === "win32") {
    throw new VectorizeError(
      "tool_platform",
      "Bounded pathname output is unavailable on Windows.",
      { platform: process.platform },
    )
  }
  assertPositiveLimit(
    options.maxOutputBytes,
    "The command primary-output limit must be positive.",
  )
  if (timeoutMs < 1) {
    throw new VectorizeError("timeout", "VTracer exceeded the conversion time limit.")
  }

  const startedAt = performance.now()
  let anchorHandle: FileHandle | undefined
  let directoryHandle: FileHandle | undefined
  let outputDirectory: string | undefined
  let readerHandle: FileHandle | undefined
  let result: PathOutputCommandResult | undefined
  let failure: unknown | typeof noCommandFailure = noCommandFailure
  try {
    outputDirectory = await mkdtemp(
      join(options.temporaryRoot, "transmute-command-output-"),
    )
    directoryHandle = await open(
      outputDirectory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    await assertOpenedPrivateDirectory(outputDirectory, directoryHandle)
    const outputPath = join(outputDirectory, "output.svg")
    await createPrivateFifo(
      outputPath,
      remainingCommandTime(startedAt, timeoutMs),
      failureCode,
    )
    anchorHandle = await open(
      outputPath,
      constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    )
    readerHandle = await open(
      outputPath,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    )
    await assertOpenedPrivateFifo(outputPath, anchorHandle, readerHandle)
    // VTracer only needs to traverse this directory and open the FIFO. Removing
    // directory write permission prevents accidental replacement of the path
    // between verification and command startup.
    await directoryHandle.chmod(0o500)

    const commandResult = await runBoundedCommandInternal(
      commandForOutput(outputPath),
      remainingCommandTime(startedAt, timeoutMs),
      failureCode,
      options,
      {
        handle: readerHandle,
        maximumBytes: options.maxOutputBytes,
      },
    )
    if (commandResult.primaryOutput === undefined) {
      throw new VectorizeError(
        failureCode,
        "VTracer did not expose its bounded primary output.",
      )
    }
    result = {
      output: commandResult.primaryOutput,
      stderr: commandResult.stderr,
      stdout: commandResult.stdout,
    }
  } catch (error) {
    failure =
      error instanceof VectorizeError
        ? error
        : executionError(failureCode, error)
  }

  const cleanupError = await removePrimaryOutputEndpoint(
    outputDirectory,
    outputDirectory === undefined
      ? undefined
      : join(outputDirectory, "output.svg"),
    readerHandle,
    anchorHandle,
    directoryHandle,
  )
  if (failure !== noCommandFailure) {
    if (cleanupError === undefined) throw failure
    throw new VectorizeError(
      failure instanceof VectorizeError ? failure.code : failureCode,
      `${failure instanceof Error ? failure.message : String(failure)} The temporary primary-output endpoint also could not be removed.`,
      {
        ...(failure instanceof VectorizeError ? failure.details : {}),
        cleanup: String(cleanupError),
      },
      { cause: failure instanceof Error ? failure : undefined },
    )
  }
  if (cleanupError !== undefined) {
    throw new VectorizeError(
      failureCode,
      "The temporary primary-output endpoint could not be removed.",
      { cleanup: String(cleanupError) },
      { cause: cleanupError instanceof Error ? cleanupError : undefined },
    )
  }
  if (result === undefined) {
    throw new VectorizeError(
      failureCode,
      "The bounded command completed without a result.",
    )
  }
  return result
}

interface PrimaryOutputReader {
  readonly handle: FileHandle
  readonly maximumBytes: number
}

interface InternalCommandResult extends CommandResult {
  readonly primaryOutput?: string
}

async function runBoundedCommandInternal(
  command: readonly string[],
  timeoutMs: number,
  failureCode: VectorizeErrorCode,
  options: BoundedCommandOptions,
  primaryOutput?: PrimaryOutputReader,
): Promise<InternalCommandResult> {
  if (command.length === 0) {
    throw new VectorizeError("invalid_input", "A bounded command requires a command.")
  }
  if (timeoutMs < 1) {
    throw new VectorizeError("timeout", "VTracer exceeded the conversion time limit.")
  }
  const maxStdoutBytes = options.maxStdoutBytes ?? MAX_COMMAND_OUTPUT_BYTES
  assertPositiveLimit(maxStdoutBytes, "The command stdout limit must be positive.")
  const inheritedDescriptors = normalizedInheritedFileDescriptors(
    options.inheritedFileDescriptors
      ?? inheritedCommandFileDescriptors.getStore(),
  )

  let child: ManagedSubprocess
  const ownsProcessGroup = process.platform !== "win32"
  try {
    child = Bun.spawn([...command], {
      detached: ownsProcessGroup,
      env: process.env,
      stdio: [
        options.stdin ?? "ignore",
        "pipe",
        "pipe",
        ...inheritedDescriptors,
      ],
      windowsHide: true,
    })
  } catch (error) {
    throw executionError(failureCode, error)
  }
  if (process.platform !== "win32") {
    activePosixProcessGroups.add(child.pid)
  }

  const streamAbort = new AbortController()
  let childHasExited = false
  const childExitTask = child.exited.then((exitCode) => {
    childHasExited = true
    if (ownsProcessGroup && process.platform !== "win32") {
      // A leader can exit while background descendants still own its pipes or
      // pathname output. The group is private to this command, so terminate it
      // immediately instead of waiting for descendant-held streams to reach
      // EOF and turning a completed leader into a timeout.
      safelyKillPosixProcessGroup(child, "SIGKILL")
    }
    return exitCode
  })
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
  const primaryOutputTask =
    primaryOutput === undefined
      ? Promise.resolve<string | undefined>(undefined)
      : readBoundedFifo(
          primaryOutput.handle,
          primaryOutput.maximumBytes,
          streamAbort.signal,
          () => childHasExited,
        )
  const executionTask = Promise.all([
    childExitTask,
    stdoutTask,
    stderrTask,
    primaryOutputTask,
  ]).then(([exitCode, stdout, stderr, boundedPrimaryOutput]) => {
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
    return boundedPrimaryOutput === undefined
      ? { stderr, stdout }
      : { primaryOutput: boundedPrimaryOutput, stderr, stdout }
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
        Promise.allSettled([stdoutTask, stderrTask, primaryOutputTask]),
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
    activePosixProcessGroups.delete(child.pid)
  }
}

function assertPositiveLimit(value: number, message: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new VectorizeError("invalid_input", message)
  }
}

function remainingCommandTime(startedAt: number, timeoutMs: number): number {
  return Math.floor(timeoutMs - (performance.now() - startedAt))
}

async function createPrivateFifo(
  path: string,
  timeoutMs: number,
  failureCode: VectorizeErrorCode,
): Promise<void> {
  await runBoundedCommandInternal(
    ["mkfifo", "-m", "600", path],
    timeoutMs,
    failureCode,
    {},
  )
}

async function assertOpenedPrivateDirectory(
  path: string,
  directory: FileHandle,
): Promise<void> {
  const [pathMetadata, openedMetadata] = await Promise.all([
    lstat(path),
    directory.stat(),
  ])
  if (
    !pathMetadata.isDirectory() ||
    !openedMetadata.isDirectory() ||
    pathMetadata.dev !== openedMetadata.dev ||
    pathMetadata.ino !== openedMetadata.ino
  ) {
    throw new VectorizeError(
      "trace_failed",
      "The bounded primary-output directory changed during setup.",
    )
  }
}

async function assertOpenedPrivateFifo(
  path: string,
  anchor: FileHandle,
  reader: FileHandle,
): Promise<void> {
  const [pathMetadata, anchorMetadata, readerMetadata] = await Promise.all([
    lstat(path),
    anchor.stat(),
    reader.stat(),
  ])
  if (
    !pathMetadata.isFIFO() ||
    !anchorMetadata.isFIFO() ||
    !readerMetadata.isFIFO() ||
    pathMetadata.dev !== anchorMetadata.dev ||
    pathMetadata.ino !== anchorMetadata.ino ||
    anchorMetadata.dev !== readerMetadata.dev ||
    anchorMetadata.ino !== readerMetadata.ino
  ) {
    throw new VectorizeError(
      "trace_failed",
      "The bounded primary-output endpoint changed during setup.",
    )
  }
}

async function removePrimaryOutputEndpoint(
  directoryPath: string | undefined,
  path: string | undefined,
  reader: FileHandle | undefined,
  anchor: FileHandle | undefined,
  directoryHandle: FileHandle | undefined,
): Promise<unknown | undefined> {
  let cleanupError: unknown
  if (directoryPath !== undefined && directoryHandle === undefined) {
    try {
      // This branch is reachable only if opening the freshly-created empty
      // directory failed. rmdir never follows a replacement symlink.
      await rmdir(directoryPath)
    } catch (error) {
      cleanupError ??= error
    }
  }
  if (directoryPath !== undefined && directoryHandle !== undefined) {
    await directoryHandle.chmod(0o700).catch((error: unknown) => {
      cleanupError ??= error
    })
    try {
      const [pathDirectoryMetadata, openedDirectoryMetadata] = await Promise.all([
        lstat(directoryPath),
        directoryHandle.stat(),
      ])
      if (
        !pathDirectoryMetadata.isDirectory() ||
        !openedDirectoryMetadata.isDirectory() ||
        pathDirectoryMetadata.dev !== openedDirectoryMetadata.dev ||
        pathDirectoryMetadata.ino !== openedDirectoryMetadata.ino
      ) {
        throw new VectorizeError(
          "trace_failed",
          "The bounded primary-output directory changed before cleanup.",
        )
      }
      if (path !== undefined && cleanupError === undefined) {
        const pathMetadata = await lstat(path).catch((error: unknown) => {
          if (isFileSystemError(error, "ENOENT")) return undefined
          throw error
        })
        const openedMetadata = await (reader ?? anchor)?.stat()
        if (pathMetadata === undefined && openedMetadata !== undefined) {
          throw new VectorizeError(
            "trace_failed",
            "The bounded primary-output endpoint disappeared before cleanup.",
          )
        }
        if (pathMetadata !== undefined) {
          if (
            !pathMetadata.isFIFO() ||
            (openedMetadata !== undefined &&
              (pathMetadata.dev !== openedMetadata.dev ||
                pathMetadata.ino !== openedMetadata.ino))
          ) {
            throw new VectorizeError(
              "trace_failed",
              "The bounded primary-output endpoint changed before cleanup.",
            )
          }
          await unlink(path)
        }
      }
      if (cleanupError === undefined) await rmdir(directoryPath)
    } catch (error) {
      cleanupError ??= error
    }
  }
  const closes = await Promise.allSettled([
    reader?.close(),
    anchor?.close(),
    directoryHandle?.close(),
  ])
  cleanupError ??= closes.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  )?.reason
  return cleanupError
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
  if (!safelyKillPosixProcessGroupByPid(child.pid, signal)) {
    try {
      child.kill(signal)
    } catch {
      // A concurrent group exit is equivalent to successful termination.
    }
  }
}

function safelyKillPosixProcessGroupByPid(
  pid: number,
  signal: NodeJS.Signals,
): boolean {
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    return false
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

async function readBoundedFifo(
  handle: FileHandle,
  maximumBytes: number,
  signal: AbortSignal,
  childHasExited: () => boolean,
): Promise<string> {
  const buffer = Buffer.allocUnsafe(
    Math.min(PRIMARY_OUTPUT_READ_BYTES, maximumBytes + 1),
  )
  const chunks: Uint8Array[] = []
  let bytes = 0
  let emptyPollsAfterExit = 0
  while (!signal.aborted) {
    const maximumRead = Math.min(
      buffer.byteLength,
      maximumBytes - bytes + 1,
    )
    try {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        maximumRead,
        null,
      )
      if (bytesRead > 0) {
        emptyPollsAfterExit = 0
        bytes += bytesRead
        if (bytes > maximumBytes) {
          throw new VectorizeError(
            "output_limit",
            "VTracer emitted too much primary output.",
            { bytes, maximumBytes },
          )
        }
        chunks.push(Uint8Array.from(buffer.subarray(0, bytesRead)))
        continue
      }
    } catch (error) {
      if (!isWouldBlockError(error)) throw error
    }
    if (childHasExited()) {
      emptyPollsAfterExit += 1
      // A fast child can write and exit after this nonblocking read reports
      // empty but before its exit promise updates our state. Require another
      // empty read after observing the exit so queued FIFO bytes are drained.
      if (emptyPollsAfterExit >= PRIMARY_OUTPUT_EXIT_EMPTY_POLLS) break
    } else {
      emptyPollsAfterExit = 0
    }
    await delay(PRIMARY_OUTPUT_POLL_MS)
  }
  return Buffer.concat(chunks, bytes).toString("utf8")
}

function isWouldBlockError(error: unknown): boolean {
  return (
    isFileSystemError(error) &&
    ["EAGAIN", "EINTR", "EWOULDBLOCK"].includes(
      String(error.code),
    )
  )
}

function isFileSystemError(
  error: unknown,
  code?: string,
): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (code === undefined || (error as NodeJS.ErrnoException).code === code)
  )
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
