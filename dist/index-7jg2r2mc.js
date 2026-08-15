// @bun
// src/vectorize/types.ts
var vectorizeProfileNames = ["balanced", "detailed", "photo"];

class VectorizeError extends Error {
  code;
  details;
  constructor(code, message, details = {}, options) {
    super(message, options);
    this.name = "VectorizeError";
    this.code = code;
    this.details = details;
  }
}

// src/vectorize/limits.ts
var vectorizeHardLimits = Object.freeze({
  maxDecodedPixels: 16777216,
  maxDimension: 4096,
  maxDurationMs: 120000,
  maxInputBytes: 16 * 1024 * 1024,
  maxOutputBytes: 2000000,
  maxPaths: 12000
});
var vectorizeDefaultLimits = Object.freeze({
  ...vectorizeHardLimits,
  maxDurationMs: 30000
});
var limitNames = Object.keys(vectorizeHardLimits);
function resolveVectorizeLimits(input) {
  const resolved = {
    maxDecodedPixels: input?.maxDecodedPixels ?? vectorizeDefaultLimits.maxDecodedPixels,
    maxDimension: input?.maxDimension ?? vectorizeDefaultLimits.maxDimension,
    maxDurationMs: input?.maxDurationMs ?? vectorizeDefaultLimits.maxDurationMs,
    maxInputBytes: input?.maxInputBytes ?? vectorizeDefaultLimits.maxInputBytes,
    maxOutputBytes: input?.maxOutputBytes ?? vectorizeDefaultLimits.maxOutputBytes,
    maxPaths: input?.maxPaths ?? vectorizeDefaultLimits.maxPaths
  };
  for (const name of limitNames) {
    const value = resolved[name];
    const hardLimit = vectorizeHardLimits[name];
    if (!Number.isInteger(value) || value < 1 || value > hardLimit) {
      throw new VectorizeError("invalid_input", `${name} must be a positive integer no greater than ${hardLimit}.`, { hardLimit, name, value });
    }
  }
  return Object.freeze(resolved);
}

class VectorizeDeadline {
  #deadline;
  constructor(durationMs) {
    this.#deadline = performance.now() + durationMs;
  }
  assert(stage) {
    if (this.remainingMs() <= 0) {
      throw new VectorizeError("timeout", `Vectorization timed out during ${stage}.`, { stage });
    }
  }
  remainingMs() {
    return Math.max(0, Math.ceil(this.#deadline - performance.now()));
  }
}

// src/vectorize/command.ts
import { AsyncLocalStorage } from "async_hooks";
import { constants } from "fs";
import {
  lstat,
  mkdtemp,
  open,
  rmdir,
  unlink
} from "fs/promises";
import { join } from "path";

// src/process-environment.ts
var gatewayCredentialNames = new Set([
  "AI_GATEWAY_API_KEY",
  "VERCEL_OIDC_TOKEN"
]);
function nonGatewayChildEnvironment(source = process.env) {
  const environment = { ...source };
  for (const name of Object.keys(environment)) {
    if (gatewayCredentialNames.has(name.toLocaleUpperCase("en-US"))) {
      delete environment[name];
    }
  }
  return environment;
}

// src/vectorize/command.ts
var MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;
var PRIMARY_OUTPUT_READ_BYTES = 64 * 1024;
var PRIMARY_OUTPUT_POLL_MS = 2;
var PRIMARY_OUTPUT_EXIT_EMPTY_POLLS = 2;
var TERMINATION_GRACE_MS = 50;
var HARD_KILL_WAIT_MS = 500;
var MAX_INHERITED_FILE_DESCRIPTORS = 16;
var timeoutMarker = Symbol("bounded-command-timeout");
var noCommandFailure = Symbol("no-command-failure");
var activePosixProcessGroups = new Set;
var workerTerminationForwardingInstalled = false;
var inheritedCommandFileDescriptors = new AsyncLocalStorage;
function normalizedInheritedFileDescriptors(value) {
  const descriptors = value ?? [];
  if (descriptors.length > MAX_INHERITED_FILE_DESCRIPTORS || descriptors.some((descriptor, index) => !Number.isSafeInteger(descriptor) || descriptor < 0 || descriptor > 2147483647 || descriptors.indexOf(descriptor) !== index)) {
    throw new VectorizeError("invalid_input", "Inherited vectorizer descriptors must be unique bounded integers.");
  }
  return Object.freeze([...descriptors]);
}
async function withInheritedCommandFileDescriptors(descriptors, callback) {
  const normalized = normalizedInheritedFileDescriptors(descriptors);
  return await inheritedCommandFileDescriptors.run(normalized, async () => await callback());
}
function forwardVectorizeWorkerTermination() {
  if (process.platform === "win32" || workerTerminationForwardingInstalled) {
    return;
  }
  workerTerminationForwardingInstalled = true;
  const signals = [
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143]
  ];
  for (const [signal, exitCode] of signals) {
    process.once(signal, () => {
      for (const pid of activePosixProcessGroups) {
        safelyKillPosixProcessGroupByPid(pid, "SIGKILL");
      }
      process.exit(exitCode);
    });
  }
}
async function runBoundedCommand(command, timeoutMs, failureCode, options = {}) {
  return runBoundedCommandInternal(command, timeoutMs, failureCode, options);
}
async function runBoundedPathOutputCommand(commandForOutput, timeoutMs, failureCode, options) {
  if (process.platform === "win32") {
    throw new VectorizeError("tool_platform", "Bounded pathname output is unavailable on Windows.", { platform: process.platform });
  }
  assertPositiveLimit(options.maxOutputBytes, "The command primary-output limit must be positive.");
  if (timeoutMs < 1) {
    throw new VectorizeError("timeout", "VTracer exceeded the conversion time limit.");
  }
  const startedAt = performance.now();
  let anchorHandle;
  let directoryHandle;
  let outputDirectory;
  let readerHandle;
  let result;
  let failure = noCommandFailure;
  try {
    outputDirectory = await mkdtemp(join(options.temporaryRoot, "atet-command-output-"));
    directoryHandle = await open(outputDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    await assertOpenedPrivateDirectory(outputDirectory, directoryHandle);
    const outputPath = join(outputDirectory, "output.svg");
    await createPrivateFifo(outputPath, remainingCommandTime(startedAt, timeoutMs), failureCode);
    anchorHandle = await open(outputPath, constants.O_RDWR | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    readerHandle = await open(outputPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    await assertOpenedPrivateFifo(outputPath, anchorHandle, readerHandle);
    await directoryHandle.chmod(320);
    const commandResult = await runBoundedCommandInternal(commandForOutput(outputPath), remainingCommandTime(startedAt, timeoutMs), failureCode, options, {
      handle: readerHandle,
      maximumBytes: options.maxOutputBytes
    });
    if (commandResult.primaryOutput === undefined) {
      throw new VectorizeError(failureCode, "VTracer did not expose its bounded primary output.");
    }
    result = {
      output: commandResult.primaryOutput,
      stderr: commandResult.stderr,
      stdout: commandResult.stdout
    };
  } catch (error) {
    failure = error instanceof VectorizeError ? error : executionError(failureCode, error);
  }
  const cleanupError = await removePrimaryOutputEndpoint(outputDirectory, outputDirectory === undefined ? undefined : join(outputDirectory, "output.svg"), readerHandle, anchorHandle, directoryHandle);
  if (failure !== noCommandFailure) {
    if (cleanupError === undefined)
      throw failure;
    throw new VectorizeError(failure instanceof VectorizeError ? failure.code : failureCode, `${failure instanceof Error ? failure.message : String(failure)} The temporary primary-output endpoint also could not be removed.`, {
      ...failure instanceof VectorizeError ? failure.details : {},
      cleanup: String(cleanupError)
    }, { cause: failure instanceof Error ? failure : undefined });
  }
  if (cleanupError !== undefined) {
    throw new VectorizeError(failureCode, "The temporary primary-output endpoint could not be removed.", { cleanup: String(cleanupError) }, { cause: cleanupError instanceof Error ? cleanupError : undefined });
  }
  if (result === undefined) {
    throw new VectorizeError(failureCode, "The bounded command completed without a result.");
  }
  return result;
}
async function runBoundedCommandInternal(command, timeoutMs, failureCode, options, primaryOutput) {
  if (command.length === 0) {
    throw new VectorizeError("invalid_input", "A bounded command requires a command.");
  }
  if (timeoutMs < 1) {
    throw new VectorizeError("timeout", "VTracer exceeded the conversion time limit.");
  }
  const maxStdoutBytes = options.maxStdoutBytes ?? MAX_COMMAND_OUTPUT_BYTES;
  assertPositiveLimit(maxStdoutBytes, "The command stdout limit must be positive.");
  const inheritedDescriptors = normalizedInheritedFileDescriptors(options.inheritedFileDescriptors ?? inheritedCommandFileDescriptors.getStore());
  let child;
  const ownsProcessGroup = process.platform !== "win32";
  try {
    child = Bun.spawn([...command], {
      detached: ownsProcessGroup,
      env: nonGatewayChildEnvironment(),
      stdio: [
        options.stdin ?? "ignore",
        "pipe",
        "pipe",
        ...inheritedDescriptors
      ],
      windowsHide: true
    });
  } catch (error) {
    throw executionError(failureCode, error);
  }
  if (process.platform !== "win32") {
    activePosixProcessGroups.add(child.pid);
  }
  const streamAbort = new AbortController;
  let childHasExited = false;
  const childExitTask = child.exited.then((exitCode) => {
    childHasExited = true;
    if (ownsProcessGroup && process.platform !== "win32") {
      safelyKillPosixProcessGroup(child, "SIGKILL");
    }
    return exitCode;
  });
  const stdoutTask = readBoundedText(child.stdout, maxStdoutBytes, streamAbort.signal, "VTracer emitted too much primary output.");
  const stderrTask = readBoundedText(child.stderr, MAX_COMMAND_OUTPUT_BYTES, streamAbort.signal, "VTracer emitted too much diagnostic output.");
  const primaryOutputTask = primaryOutput === undefined ? Promise.resolve(undefined) : readBoundedFifo(primaryOutput.handle, primaryOutput.maximumBytes, streamAbort.signal, () => childHasExited);
  const executionTask = Promise.all([
    childExitTask,
    stdoutTask,
    stderrTask,
    primaryOutputTask
  ]).then(([exitCode, stdout, stderr, boundedPrimaryOutput]) => {
    if (exitCode !== 0) {
      throw new VectorizeError(failureCode, [
        `Command failed (${exitCode}): ${command[0] ?? "unknown"}`,
        stderr.trim()
      ].filter(Boolean).join(`
`), { exitCode });
    }
    return boundedPrimaryOutput === undefined ? { stderr, stdout } : { primaryOutput: boundedPrimaryOutput, stderr, stdout };
  });
  let timer;
  const timeoutTask = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(timeoutMarker), timeoutMs);
  });
  try {
    return await Promise.race([executionTask, timeoutTask]);
  } catch (error) {
    let cleanupError;
    try {
      await terminateAndWait(child, ownsProcessGroup);
    } catch (caught) {
      cleanupError = caught;
    } finally {
      streamAbort.abort();
      await settlesWithin(Promise.allSettled([stdoutTask, stderrTask, primaryOutputTask]), HARD_KILL_WAIT_MS);
    }
    if (error === timeoutMarker) {
      throw new VectorizeError("timeout", cleanupError === undefined ? "VTracer exceeded the conversion time limit." : "VTracer exceeded the conversion time limit and did not terminate cleanly.", cleanupError === undefined ? {} : { cleanup: String(cleanupError) });
    }
    if (error instanceof VectorizeError)
      throw error;
    if (cleanupError instanceof VectorizeError)
      throw cleanupError;
    throw executionError(failureCode, error);
  } finally {
    if (timer !== undefined)
      clearTimeout(timer);
    activePosixProcessGroups.delete(child.pid);
  }
}
function assertPositiveLimit(value, message) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new VectorizeError("invalid_input", message);
  }
}
function remainingCommandTime(startedAt, timeoutMs) {
  return Math.floor(timeoutMs - (performance.now() - startedAt));
}
async function createPrivateFifo(path, timeoutMs, failureCode) {
  await runBoundedCommandInternal(["mkfifo", "-m", "600", path], timeoutMs, failureCode, {});
}
async function assertOpenedPrivateDirectory(path, directory) {
  const [pathMetadata, openedMetadata] = await Promise.all([
    lstat(path),
    directory.stat()
  ]);
  if (!pathMetadata.isDirectory() || !openedMetadata.isDirectory() || pathMetadata.dev !== openedMetadata.dev || pathMetadata.ino !== openedMetadata.ino) {
    throw new VectorizeError("trace_failed", "The bounded primary-output directory changed during setup.");
  }
}
async function assertOpenedPrivateFifo(path, anchor, reader) {
  const [pathMetadata, anchorMetadata, readerMetadata] = await Promise.all([
    lstat(path),
    anchor.stat(),
    reader.stat()
  ]);
  if (!pathMetadata.isFIFO() || !anchorMetadata.isFIFO() || !readerMetadata.isFIFO() || pathMetadata.dev !== anchorMetadata.dev || pathMetadata.ino !== anchorMetadata.ino || anchorMetadata.dev !== readerMetadata.dev || anchorMetadata.ino !== readerMetadata.ino) {
    throw new VectorizeError("trace_failed", "The bounded primary-output endpoint changed during setup.");
  }
}
async function removePrimaryOutputEndpoint(directoryPath, path, reader, anchor, directoryHandle) {
  let cleanupError;
  if (directoryPath !== undefined && directoryHandle === undefined) {
    try {
      await rmdir(directoryPath);
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (directoryPath !== undefined && directoryHandle !== undefined) {
    await directoryHandle.chmod(448).catch((error) => {
      cleanupError ??= error;
    });
    try {
      const [pathDirectoryMetadata, openedDirectoryMetadata] = await Promise.all([
        lstat(directoryPath),
        directoryHandle.stat()
      ]);
      if (!pathDirectoryMetadata.isDirectory() || !openedDirectoryMetadata.isDirectory() || pathDirectoryMetadata.dev !== openedDirectoryMetadata.dev || pathDirectoryMetadata.ino !== openedDirectoryMetadata.ino) {
        throw new VectorizeError("trace_failed", "The bounded primary-output directory changed before cleanup.");
      }
      if (path !== undefined && cleanupError === undefined) {
        const pathMetadata = await lstat(path).catch((error) => {
          if (isFileSystemError(error, "ENOENT"))
            return;
          throw error;
        });
        const openedMetadata = await (reader ?? anchor)?.stat();
        if (pathMetadata === undefined && openedMetadata !== undefined) {
          throw new VectorizeError("trace_failed", "The bounded primary-output endpoint disappeared before cleanup.");
        }
        if (pathMetadata !== undefined) {
          if (!pathMetadata.isFIFO() || openedMetadata !== undefined && (pathMetadata.dev !== openedMetadata.dev || pathMetadata.ino !== openedMetadata.ino)) {
            throw new VectorizeError("trace_failed", "The bounded primary-output endpoint changed before cleanup.");
          }
          await unlink(path);
        }
      }
      if (cleanupError === undefined)
        await rmdir(directoryPath);
    } catch (error) {
      cleanupError ??= error;
    }
  }
  const closes = await Promise.allSettled([
    reader?.close(),
    anchor?.close(),
    directoryHandle?.close()
  ]);
  cleanupError ??= closes.find((result) => result.status === "rejected")?.reason;
  return cleanupError;
}
async function terminateAndWait(child, ownsProcessGroup) {
  if (process.platform === "win32") {
    await killWindowsProcessTree(child.pid);
  } else if (!ownsProcessGroup) {
    safelyKillChild(child, "SIGTERM");
    await delay(TERMINATION_GRACE_MS);
    safelyKillChild(child, "SIGKILL");
  } else {
    safelyKillPosixProcessGroup(child, "SIGTERM");
    await delay(TERMINATION_GRACE_MS);
    safelyKillPosixProcessGroup(child, "SIGKILL");
  }
  if (await settlesWithin(child.exited, HARD_KILL_WAIT_MS))
    return;
  throw new VectorizeError("trace_failed", "VTracer did not exit after forced termination.");
}
function safelyKillChild(child, signal) {
  try {
    child.kill(signal);
  } catch {}
}
function safelyKillPosixProcessGroup(child, signal) {
  if (!safelyKillPosixProcessGroupByPid(child.pid, signal)) {
    try {
      child.kill(signal);
    } catch {}
  }
}
function safelyKillPosixProcessGroupByPid(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}
async function killWindowsProcessTree(pid) {
  let killer;
  try {
    killer = Bun.spawn(["taskkill.exe", "/PID", String(pid), "/T", "/F"], {
      detached: false,
      env: nonGatewayChildEnvironment(),
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
      windowsHide: true
    });
  } catch {
    return;
  }
  const drain = Promise.all([
    readBoundedText(killer.stdout, MAX_COMMAND_OUTPUT_BYTES, AbortSignal.timeout(HARD_KILL_WAIT_MS), "Process-tree cleanup emitted too much output."),
    readBoundedText(killer.stderr, MAX_COMMAND_OUTPUT_BYTES, AbortSignal.timeout(HARD_KILL_WAIT_MS), "Process-tree cleanup emitted too much output.")
  ]);
  if (!await settlesWithin(Promise.all([killer.exited, drain]), HARD_KILL_WAIT_MS)) {
    try {
      killer.kill("SIGKILL");
    } catch {}
  }
}
async function settlesWithin(promise, durationMs) {
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => finish(false), durationMs);
    promise.then(() => finish(true), () => finish(true));
    function finish(settled) {
      if (finished)
        return;
      finished = true;
      clearTimeout(timer);
      resolve(settled);
    }
  });
}
async function readBoundedText(stream, maximumBytes, signal, limitMessage) {
  const reader = stream.getReader();
  const chunks = [];
  let bytes = 0;
  const cancel = () => {
    reader.cancel().catch(() => {
      return;
    });
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done)
        break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new VectorizeError("output_limit", limitMessage, {
          bytes,
          maximumBytes
        });
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, bytes).toString("utf8");
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}
async function readBoundedFifo(handle, maximumBytes, signal, childHasExited) {
  const buffer = Buffer.allocUnsafe(Math.min(PRIMARY_OUTPUT_READ_BYTES, maximumBytes + 1));
  const chunks = [];
  let bytes = 0;
  let emptyPollsAfterExit = 0;
  while (!signal.aborted) {
    const maximumRead = Math.min(buffer.byteLength, maximumBytes - bytes + 1);
    try {
      const { bytesRead } = await handle.read(buffer, 0, maximumRead, null);
      if (bytesRead > 0) {
        emptyPollsAfterExit = 0;
        bytes += bytesRead;
        if (bytes > maximumBytes) {
          throw new VectorizeError("output_limit", "VTracer emitted too much primary output.", { bytes, maximumBytes });
        }
        chunks.push(Uint8Array.from(buffer.subarray(0, bytesRead)));
        continue;
      }
    } catch (error) {
      if (!isWouldBlockError(error))
        throw error;
    }
    if (childHasExited()) {
      emptyPollsAfterExit += 1;
      if (emptyPollsAfterExit >= PRIMARY_OUTPUT_EXIT_EMPTY_POLLS)
        break;
    } else {
      emptyPollsAfterExit = 0;
    }
    await delay(PRIMARY_OUTPUT_POLL_MS);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}
function isWouldBlockError(error) {
  return isFileSystemError(error) && ["EAGAIN", "EINTR", "EWOULDBLOCK"].includes(String(error.code));
}
function isFileSystemError(error, code) {
  return error instanceof Error && "code" in error && (code === undefined || error.code === code);
}
function delay(durationMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}
function executionError(failureCode, cause) {
  return new VectorizeError(failureCode, "VTracer could not be executed.", {}, { cause: cause instanceof Error ? cause : new Error(String(cause)) });
}

// src/vectorize/tool.ts
import { createHash as createHash2, randomUUID } from "crypto";
import { constants as constants2 } from "fs";
import {
  chmod,
  mkdir,
  open as open2,
  realpath,
  rename,
  rm,
  writeFile
} from "fs/promises";
import { homedir } from "os";
import { dirname, join as join2, resolve } from "path";

// src/vectorize/archive.ts
import { gunzipSync, inflateRawSync } from "zlib";
var MAX_BINARY_BYTES = 8 * 1024 * 1024;
function extractVTracerArchive(archive, format) {
  return format === "tar.gz" ? extractTarEntry(gunzipSync(archive, { maxOutputLength: MAX_BINARY_BYTES }), "vtracer") : extractZipEntry(archive, "vtracer.exe");
}
function extractTarEntry(tar, expectedName) {
  for (let offset = 0;offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0))
      break;
    const name = readNullTerminatedAscii(header.subarray(0, 100));
    const prefix = readNullTerminatedAscii(header.subarray(345, 500));
    const fullName = prefix === "" ? name : `${prefix}/${name}`;
    const sizeText = readNullTerminatedAscii(header.subarray(124, 136)).trim();
    if (!/^[0-7]+$/u.test(sizeText)) {
      throw new VectorizeError("tool_integrity", "VTracer tar contains an invalid size.");
    }
    const size = Number.parseInt(sizeText, 8);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BINARY_BYTES) {
      throw new VectorizeError("tool_integrity", "VTracer tar entry exceeds its size limit.");
    }
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > tar.length) {
      throw new VectorizeError("tool_integrity", "VTracer tar entry is truncated.");
    }
    if (fullName === expectedName || fullName.endsWith(`/${expectedName}`)) {
      return Uint8Array.from(tar.subarray(contentStart, contentEnd));
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  throw new VectorizeError("tool_integrity", `VTracer archive omitted ${expectedName}.`);
}
function extractZipEntry(zip, expectedName) {
  const bytes = Buffer.from(zip);
  let offset = 0;
  while (offset + 30 <= bytes.length) {
    const signature = bytes.readUInt32LE(offset);
    if (signature !== 67324752)
      break;
    const flags = bytes.readUInt16LE(offset + 6);
    const compression = bytes.readUInt16LE(offset + 8);
    const compressedSize = bytes.readUInt32LE(offset + 18);
    const uncompressedSize = bytes.readUInt32LE(offset + 22);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    if ((flags & 1) !== 0 || (flags & 8) !== 0) {
      throw new VectorizeError("tool_integrity", "VTracer zip uses encryption or an unsupported data descriptor.");
    }
    if (uncompressedSize > MAX_BINARY_BYTES) {
      throw new VectorizeError("tool_integrity", "VTracer zip entry exceeds its size limit.");
    }
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) {
      throw new VectorizeError("tool_integrity", "VTracer zip entry is truncated.");
    }
    const name = bytes.subarray(nameStart, nameStart + nameLength).toString("utf8");
    if (name === expectedName || name.endsWith(`/${expectedName}`)) {
      const compressed = bytes.subarray(dataStart, dataEnd);
      const extracted = compression === 0 ? Buffer.from(compressed) : compression === 8 ? inflateRawSync(compressed, { maxOutputLength: MAX_BINARY_BYTES }) : undefined;
      if (extracted === undefined) {
        throw new VectorizeError("tool_integrity", `VTracer zip uses unsupported compression method ${compression}.`);
      }
      if (extracted.length !== uncompressedSize) {
        throw new VectorizeError("tool_integrity", "VTracer zip size does not match its header.");
      }
      return Uint8Array.from(extracted);
    }
    offset = dataEnd;
  }
  throw new VectorizeError("tool_integrity", `VTracer archive omitted ${expectedName}.`);
}
function readNullTerminatedAscii(bytes) {
  const end = bytes.indexOf(0);
  return Buffer.from(end === -1 ? bytes : bytes.subarray(0, end)).toString("ascii");
}

// src/vectorize/metrics.ts
import { createHash } from "crypto";
function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}
function sanitizedTraceRgba(rgba, minimumAlpha) {
  if (rgba.length === 0 || rgba.length % 4 !== 0) {
    throw new VectorizeError("invalid_input", "Trace sanitation requires nonempty RGBA pixels.");
  }
  if (!Number.isInteger(minimumAlpha) || minimumAlpha < 1 || minimumAlpha > 64) {
    throw new VectorizeError("invalid_input", "alphaCutoff must be an integer from 1 through 64.");
  }
  const sanitized = Uint8Array.from(rgba);
  for (let index = 0;index < sanitized.length; index += 4) {
    if (sanitized[index + 3] >= minimumAlpha)
      continue;
    sanitized[index] = 0;
    sanitized[index + 1] = 0;
    sanitized[index + 2] = 0;
    sanitized[index + 3] = 0;
  }
  return sanitized;
}
function alphaPlaneTraceRgba(rgba) {
  if (rgba.length === 0 || rgba.length % 4 !== 0) {
    throw new VectorizeError("invalid_input", "An alpha trace requires nonempty RGBA pixels.");
  }
  const grayscale = new Uint8Array(rgba.length);
  for (let index = 0;index < rgba.length; index += 4) {
    const alpha = rgba[index + 3];
    grayscale[index] = alpha;
    grayscale[index + 1] = alpha;
    grayscale[index + 2] = alpha;
    grayscale[index + 3] = 255;
  }
  return grayscale;
}
function lowAlphaMassRatio(rgba, cutoff) {
  if (rgba.length === 0 || rgba.length % 4 !== 0) {
    throw new VectorizeError("invalid_input", "Low-alpha measurement requires nonempty RGBA pixels.");
  }
  if (!Number.isInteger(cutoff) || cutoff < 1 || cutoff > 255) {
    throw new VectorizeError("invalid_input", "The low-alpha cutoff must be a byte.");
  }
  let lowAlphaMass = 0;
  let visibleAlphaMass = 0;
  for (let index = 3;index < rgba.length; index += 4) {
    const alpha = rgba[index];
    visibleAlphaMass += alpha;
    if (alpha > 0 && alpha < cutoff)
      lowAlphaMass += alpha;
  }
  return visibleAlphaMass === 0 ? 0 : lowAlphaMass / visibleAlphaMass;
}
function hasFractionalAlpha(rgba) {
  for (let index = 3;index < rgba.length; index += 4) {
    const alpha = rgba[index];
    if (alpha > 0 && alpha < 255)
      return true;
  }
  return false;
}
function normalizedPremultipliedRmse(source, candidate) {
  assertComparableRgba(source, candidate, "RMSE");
  let squaredError = 0;
  for (let index = 0;index < source.length; index += 4) {
    const sourceAlpha = source[index + 3] / 255;
    const candidateAlpha = candidate[index + 3] / 255;
    for (let channel = 0;channel < 3; channel += 1) {
      const difference = source[index + channel] * sourceAlpha - candidate[index + channel] * candidateAlpha;
      squaredError += difference * difference;
    }
    const alphaDifference = source[index + 3] - candidate[index + 3];
    squaredError += alphaDifference * alphaDifference;
  }
  return Math.sqrt(squaredError / source.length) / 255;
}
function normalizedAlphaRmse(source, candidate) {
  assertComparableRgba(source, candidate, "Alpha RMSE");
  let squaredError = 0;
  for (let index = 3;index < source.length; index += 4) {
    const difference = source[index] - candidate[index];
    squaredError += difference * difference;
  }
  return Math.sqrt(squaredError / (source.length / 4)) / 255;
}
function assertComparableRgba(source, candidate, label) {
  if (source.length === 0 || source.length !== candidate.length || source.length % 4 !== 0) {
    throw new VectorizeError("invalid_input", `${label} inputs must be equally sized nonempty RGBA buffers.`);
  }
}
function measureSupport(source, candidate, width, height, dilation = 1) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || source.length !== width * height * 4 || candidate.length !== source.length) {
    throw new VectorizeError("invalid_input", "Support metrics require equally sized rectangular RGBA buffers.");
  }
  if (!Number.isInteger(dilation) || dilation < 0 || dilation > 4) {
    throw new VectorizeError("invalid_input", "Support dilation must be an integer from 0 to 4.");
  }
  const support = new Uint8Array(width * height);
  for (let y = 0;y < height; y += 1) {
    for (let x = 0;x < width; x += 1) {
      let covered = false;
      for (let dy = -dilation;dy <= dilation && !covered; dy += 1) {
        for (let dx = -dilation;dx <= dilation; dx += 1) {
          const neighborX = x + dx;
          const neighborY = y + dy;
          if (neighborX >= 0 && neighborX < width && neighborY >= 0 && neighborY < height && source[(neighborY * width + neighborX) * 4 + 3] > 0) {
            covered = true;
            break;
          }
        }
      }
      support[y * width + x] = covered ? 1 : 0;
    }
  }
  let candidateAlphaMass = 0;
  let outsideAlphaMass = 0;
  let recalledAlphaMass = 0;
  let sourceAlphaMass = 0;
  for (let pixel = 0;pixel < width * height; pixel += 1) {
    const sourceAlpha = source[pixel * 4 + 3] / 255;
    const candidateAlpha = candidate[pixel * 4 + 3] / 255;
    sourceAlphaMass += sourceAlpha;
    candidateAlphaMass += candidateAlpha;
    recalledAlphaMass += Math.min(sourceAlpha, candidateAlpha);
    if (support[pixel] === 0)
      outsideAlphaMass += candidateAlpha;
  }
  if (sourceAlphaMass === 0 || candidateAlphaMass === 0) {
    throw new VectorizeError("quality_limit", "Source and candidate must contain visible pixels.");
  }
  return {
    outsideAlphaRatio: outsideAlphaMass / candidateAlphaMass,
    supportRecall: recalledAlphaMass / sourceAlphaMass
  };
}
function parseHexColor(value) {
  const shorthand = value.match(/^#([a-f0-9])([a-f0-9])([a-f0-9])$/iu);
  if (shorthand !== null) {
    return [
      Number.parseInt(`${shorthand[1]}${shorthand[1]}`, 16),
      Number.parseInt(`${shorthand[2]}${shorthand[2]}`, 16),
      Number.parseInt(`${shorthand[3]}${shorthand[3]}`, 16)
    ];
  }
  const full = value.match(/^#([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/iu);
  if (full === null) {
    throw new VectorizeError("invalid_input", `Expected a #rgb or #rrggbb color, received ${JSON.stringify(value)}.`);
  }
  return [
    Number.parseInt(full[1], 16),
    Number.parseInt(full[2], 16),
    Number.parseInt(full[3], 16)
  ];
}
function normalizedHexColor(value) {
  return `#${parseHexColor(value).map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}
function srgbToOklab([red, green, blue]) {
  const linear = (channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const r = linear(red);
  const g = linear(green);
  const b = linear(blue);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ];
}
function oklabDistance(left, right) {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}
function otsuDistanceCutoff(colors, primary) {
  const distances = colors.map(({ color, mass }) => ({
    distance: oklabDistance(color, primary),
    mass
  }));
  const maximum = Math.max(...distances.map(({ distance }) => distance));
  if (maximum === 0)
    return Number.POSITIVE_INFINITY;
  const histogram = Array.from({ length: 256 }, () => ({ mass: 0, moment: 0 }));
  for (const { distance, mass } of distances) {
    const index = Math.min(255, Math.floor(distance / maximum * 255));
    histogram[index].mass += mass;
    histogram[index].moment += mass * distance;
  }
  const totalMass = histogram.reduce((sum, bin) => sum + bin.mass, 0);
  const totalMoment = histogram.reduce((sum, bin) => sum + bin.moment, 0);
  let nearMass = 0;
  let nearMoment = 0;
  let bestScore = -1;
  let bestIndex = 254;
  for (let index = 0;index < 255; index += 1) {
    const bin = histogram[index];
    nearMass += bin.mass;
    nearMoment += bin.moment;
    const farMass = totalMass - nearMass;
    if (nearMass === 0 || farMass === 0)
      continue;
    const nearMean = nearMoment / nearMass;
    const farMean = (totalMoment - nearMoment) / farMass;
    const score = nearMass * farMass * (nearMean - farMean) ** 2;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  let cutoff = maximum * (bestIndex + 1) / 255;
  const nearShare = () => distances.reduce((sum, { distance, mass }) => sum + (distance <= cutoff ? mass : 0), 0) / totalMass;
  if (nearShare() < 0.5) {
    let cumulativeMass = 0;
    for (const { distance, mass } of [...distances].sort((left, right) => left.distance - right.distance)) {
      cumulativeMass += mass;
      cutoff = distance;
      if (cumulativeMass >= totalMass / 2)
        break;
    }
  }
  return cutoff;
}
function dominantOklabDuotoneModel(rgba) {
  if (rgba.length === 0 || rgba.length % 4 !== 0) {
    throw new VectorizeError("invalid_input", "A duotone model requires nonempty RGBA pixels.");
  }
  const bins = new Map;
  for (let index = 0;index < rgba.length; index += 4) {
    const alpha = rgba[index + 3] / 255;
    if (alpha === 0)
      continue;
    const red = rgba[index];
    const green = rgba[index + 1];
    const blue = rgba[index + 2];
    const key = red >> 4 << 8 | green >> 4 << 4 | blue >> 4;
    const bin = bins.get(key) ?? { blue: 0, green: 0, mass: 0, red: 0 };
    bin.mass += alpha;
    bin.red += red * alpha;
    bin.green += green * alpha;
    bin.blue += blue * alpha;
    bins.set(key, bin);
  }
  if (bins.size === 0) {
    throw new VectorizeError("invalid_input", "A duotone model requires visible pixels.");
  }
  const colors = [...bins.entries()].map(([key, bin]) => ({
    color: srgbToOklab([
      bin.red / bin.mass,
      bin.green / bin.mass,
      bin.blue / bin.mass
    ]),
    key,
    mass: bin.mass
  })).sort((left, right) => right.mass - left.mass || left.key - right.key);
  const primary = colors[0].color;
  const cutoff = otsuDistanceCutoff(colors, primary);
  const totalMass = colors.reduce((sum, { mass }) => sum + mass, 0);
  const primaryMass = colors.reduce((sum, { color, mass }) => sum + (oklabDistance(color, primary) <= cutoff ? mass : 0), 0);
  return { cutoff, primary, primaryShare: primaryMass / totalMass };
}
function colorBelongsToPrimary(rgb, model) {
  return oklabDistance(srgbToOklab(rgb), model.primary) <= model.cutoff;
}

// src/vectorize/tool.ts
var VTRACER_VERSION = "0.6.4";
var frozenRelease = (release) => Object.freeze(release);
var vtracerReleases = Object.freeze({
  "darwin-arm64": frozenRelease({
    archiveSha256: "4a597fd2df8b961d60620df40a7436109427d86e5c028758e6e8796b02d3d996",
    binarySha256: "77e495bbe212448240387fba3b6d8bc62ba20ecfb6f3c22967e51600f1cc6e66",
    format: "tar.gz",
    url: `https://github.com/visioncortex/vtracer/releases/download/${VTRACER_VERSION}/vtracer-aarch64-apple-darwin.tar.gz`
  }),
  "darwin-x64": frozenRelease({
    archiveSha256: "f0d755292c2602d772d63d658a3498b23eca8b5620d4b92a991bd035d5abed16",
    binarySha256: "0f9f88f989b757e27973a5c4b42665153070183d0787656ee8af2249ab326b78",
    format: "tar.gz",
    url: `https://github.com/visioncortex/vtracer/releases/download/${VTRACER_VERSION}/vtracer-x86_64-apple-darwin.tar.gz`
  }),
  "linux-arm64": frozenRelease({
    archiveSha256: "cbd05ad4f491d12dd139ada61485ca1d24db9f981cbe1658632a083cd0ac1a71",
    binarySha256: "a4b33b6c4066a6b9187802c6efc8b89e211318e12a17164b9d1dd1f29ac5e502",
    format: "tar.gz",
    url: `https://github.com/visioncortex/vtracer/releases/download/${VTRACER_VERSION}/vtracer-aarch64-unknown-linux-musl.tar.gz`
  }),
  "linux-x64": frozenRelease({
    archiveSha256: "9290ba0c90e224d6d212836dff5491407c1718bcb72f80b2b5a4a01816df5e40",
    binarySha256: "6f31499257076bd94de3e976844cf7ca5643f1e194a2bf0599b13f3719452aec",
    format: "tar.gz",
    url: `https://github.com/visioncortex/vtracer/releases/download/${VTRACER_VERSION}/vtracer-x86_64-unknown-linux-musl.tar.gz`
  }),
  "win32-x64": frozenRelease({
    archiveSha256: "6b5bc17a6b017129ee40461df254f65d16f3b494c001a8541d41861066b716bf",
    binarySha256: "4ad8d35e566cd15caf582063b8349bd082b8fa2bd461e99d116fc63ad8fdeca0",
    format: "zip",
    url: `https://github.com/visioncortex/vtracer/releases/download/${VTRACER_VERSION}/vtracer-x86_64-pc-windows-msvc.zip`
  })
});
var MAX_ARCHIVE_BYTES = 4 * 1024 * 1024;
var MAX_TOOL_BYTES = 16 * 1024 * 1024;
var FILE_CHUNK_BYTES = 64 * 1024;
function renamedEnvironmentValue(canonical) {
  const predecessor = canonical.replace(/^ATET_/u, "TRANSMUTE_");
  const current = process.env[canonical];
  const legacy = process.env[predecessor];
  if (current !== undefined && legacy !== undefined && current !== legacy) {
    throw new VectorizeError("invalid_input", `${canonical} and ${predecessor} disagree; remove one or set both to the same value.`);
  }
  return current ?? legacy;
}
async function ensureVTracer(deadline, privateDirectory, cacheDirectory) {
  const override = renamedEnvironmentValue("ATET_VTRACER_PATH");
  if (override !== undefined) {
    return copyAndInspectVTracer(resolve(override), resolve(privateDirectory), "override", deadline);
  }
  const key = `${process.platform}-${process.arch}`;
  const release = vtracerReleases[key];
  if (release === undefined) {
    throw new VectorizeError("tool_platform", `VTracer is not pinned for ${process.platform}/${process.arch}.`, { arch: process.arch, platform: process.platform });
  }
  const cacheRoot = resolve(cacheDirectory ?? defaultCacheDirectory());
  const suffix = process.platform === "win32" ? ".exe" : "";
  const toolPath = join2(cacheRoot, "tools", `vtracer-${VTRACER_VERSION}-${process.platform}-${process.arch}${suffix}`);
  const cachedHash = await hashCachedTool(toolPath, deadline);
  if (cachedHash !== release.binarySha256) {
    await removeInvalidCachedTool(toolPath);
    await installOfficialVTracer(toolPath, release, deadline);
  }
  return copyAndInspectVTracer(toolPath, resolve(privateDirectory), "official-release", deadline, release.binarySha256);
}
function defaultCacheDirectory() {
  const explicit = renamedEnvironmentValue("ATET_CACHE_DIR");
  if (explicit !== undefined && explicit.trim() !== "")
    return explicit;
  if (process.platform === "win32") {
    return join2(process.env.LOCALAPPDATA ?? homedir(), "atet");
  }
  if (process.platform === "darwin")
    return join2(homedir(), "Library", "Caches", "atet");
  return join2(process.env.XDG_CACHE_HOME ?? join2(homedir(), ".cache"), "atet");
}
async function installOfficialVTracer(toolPath, release, deadline) {
  deadline.assert("VTracer download");
  const archive = await downloadBounded(release.url, deadline, MAX_ARCHIVE_BYTES);
  const archiveSha256 = sha256(archive);
  if (archiveSha256 !== release.archiveSha256) {
    throw new VectorizeError("tool_integrity", `VTracer archive checksum mismatch: ${archiveSha256}`, { actual: archiveSha256, expected: release.archiveSha256 });
  }
  const binary = extractVTracerArchive(archive, release.format);
  if (binary.byteLength < 1 || binary.byteLength > MAX_TOOL_BYTES) {
    throw new VectorizeError("tool_integrity", "VTracer binary exceeds its verified installation limit.", { bytes: binary.byteLength, maximumBytes: MAX_TOOL_BYTES });
  }
  const binarySha256 = sha256(binary);
  if (binarySha256 !== release.binarySha256) {
    throw new VectorizeError("tool_integrity", `VTracer binary checksum mismatch: ${binarySha256}`, { actual: binarySha256, expected: release.binarySha256 });
  }
  deadline.assert("VTracer installation");
  await mkdir(dirname(toolPath), { recursive: true });
  const stagedPath = `${toolPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(stagedPath, binary, { flag: "wx", mode: 448 });
    if (process.platform !== "win32")
      await chmod(stagedPath, 320);
    deadline.assert("VTracer installation");
    try {
      await rename(stagedPath, toolPath);
    } catch (error) {
      const concurrentHash = await hashCachedTool(toolPath, deadline);
      if (concurrentHash === release.binarySha256) {
        await rm(stagedPath, { force: true });
      } else {
        throw error;
      }
    }
  } catch (error) {
    await rm(stagedPath, { force: true });
    if (error instanceof VectorizeError)
      throw error;
    throw new VectorizeError("tool_integrity", "Could not publish the verified VTracer binary.", {}, { cause: error });
  }
  const installedHash = await hashCachedTool(toolPath, deadline);
  if (installedHash !== release.binarySha256) {
    throw new VectorizeError("tool_integrity", "Installed VTracer differs from the verified release binary.", { actual: installedHash, expected: release.binarySha256 });
  }
}
async function copyAndInspectVTracer(sourcePath, privateDirectory, source, deadline, expectedSha256) {
  deadline.assert("VTracer private copy");
  await mkdir(privateDirectory, { mode: 448, recursive: true });
  const suffix = process.platform === "win32" ? ".exe" : "";
  const privatePath = join2(privateDirectory, `vtracer-${randomUUID()}${suffix}`);
  const failureCode = source === "official-release" ? "tool_integrity" : "tool_version";
  let sourceHandle;
  let targetHandle;
  let copiedSha256;
  try {
    const resolvedSourcePath = await realpath(sourcePath);
    deadline.assert("VTracer private copy");
    sourceHandle = await open2(resolvedSourcePath, boundedReadFlags());
    const metadata = await sourceHandle.stat();
    assertBoundedRegularTool(metadata, sourcePath);
    targetHandle = await open2(privatePath, "wx", 320);
    copiedSha256 = await copyAndHash(sourceHandle, targetHandle, MAX_TOOL_BYTES, deadline);
    await targetHandle.sync();
    deadline.assert("VTracer private copy");
  } catch (error) {
    if (error instanceof VectorizeError)
      throw error;
    throw new VectorizeError(failureCode, "VTracer could not be copied into the private conversion directory.", {}, { cause: error });
  } finally {
    await Promise.allSettled([sourceHandle?.close(), targetHandle?.close()]);
  }
  try {
    if (copiedSha256.length === 0) {
      throw new VectorizeError(failureCode, "VTracer executable is empty.");
    }
    if (expectedSha256 !== undefined && copiedSha256 !== expectedSha256) {
      throw new VectorizeError("tool_integrity", "VTracer changed before it could be copied for conversion.", { actual: copiedSha256, expected: expectedSha256 });
    }
    if (process.platform !== "win32")
      await chmod(privatePath, 320);
    const privateSha256 = await hashRegularFile(privatePath, MAX_TOOL_BYTES, deadline, failureCode);
    if (privateSha256 !== copiedSha256) {
      throw new VectorizeError("tool_integrity", "The private VTracer copy failed its integrity check.", { actual: privateSha256, expected: copiedSha256 });
    }
    return inspectVTracer(privatePath, source, deadline, copiedSha256, expectedSha256);
  } catch (error) {
    await rm(privatePath, { force: true });
    throw error;
  }
}
async function inspectVTracer(path, source, deadline, copiedSha256, expectedSha256) {
  deadline.assert("VTracer inspection");
  const { stderr, stdout } = await runBoundedCommand([path, "--version"], deadline.remainingMs(), "tool_version");
  if (!new RegExp(`\\b${VTRACER_VERSION.replaceAll(".", "\\.")}\\b`, "u").test(`${stdout}
${stderr}`)) {
    throw new VectorizeError("tool_version", `Expected VTracer ${VTRACER_VERSION}.`);
  }
  const afterInspectionSha256 = await hashRegularFile(path, MAX_TOOL_BYTES, deadline, "tool_integrity");
  if (afterInspectionSha256 !== copiedSha256 || expectedSha256 !== undefined && afterInspectionSha256 !== expectedSha256) {
    throw new VectorizeError("tool_integrity", "The private VTracer executable changed during inspection.", {
      actual: afterInspectionSha256,
      expected: expectedSha256 ?? copiedSha256
    });
  }
  return {
    path,
    sha256: afterInspectionSha256,
    source,
    version: VTRACER_VERSION
  };
}
async function hashCachedTool(path, deadline) {
  try {
    return await hashRegularFile(path, MAX_TOOL_BYTES, deadline, "tool_integrity");
  } catch (error) {
    if (error instanceof VectorizeError && error.code === "timeout")
      throw error;
    if (isFileSystemError2(error, "ENOENT"))
      return;
    return;
  }
}
async function removeInvalidCachedTool(path) {
  try {
    await rm(path, { force: true });
  } catch (error) {
    throw new VectorizeError("tool_integrity", "Could not remove an invalid cached VTracer binary.", {}, { cause: error });
  }
}
async function hashRegularFile(path, maximumBytes, deadline, failureCode) {
  let handle;
  try {
    deadline.assert("VTracer hash");
    const resolvedPath = await realpath(path);
    deadline.assert("VTracer hash");
    handle = await open2(resolvedPath, boundedReadFlags());
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximumBytes) {
      throw new VectorizeError(failureCode, "VTracer must be a non-empty regular file within its size limit.", { bytes: metadata.size, maximumBytes });
    }
    const hash = createHash2("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(FILE_CHUNK_BYTES, maximumBytes + 1));
    let bytes = 0;
    while (true) {
      deadline.assert("VTracer hash");
      const maximumRead = Math.min(buffer.byteLength, maximumBytes - bytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, maximumRead, null);
      if (bytesRead === 0)
        break;
      bytes += bytesRead;
      if (bytes > maximumBytes) {
        throw new VectorizeError(failureCode, "VTracer grew beyond its executable size limit while being hashed.", { bytes, maximumBytes });
      }
      hash.update(buffer.subarray(0, bytesRead));
    }
    deadline.assert("VTracer hash");
    return hash.digest("hex");
  } catch (error) {
    if (error instanceof VectorizeError)
      throw error;
    throw new VectorizeError(failureCode, "VTracer executable could not be read safely.", {}, { cause: error });
  } finally {
    await handle?.close().catch(() => {
      return;
    });
  }
}
async function copyAndHash(source, target, maximumBytes, deadline) {
  const hash = createHash2("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(FILE_CHUNK_BYTES, maximumBytes + 1));
  let bytes = 0;
  while (true) {
    deadline.assert("VTracer private copy");
    const maximumRead = Math.min(buffer.byteLength, maximumBytes - bytes + 1);
    const { bytesRead } = await source.read(buffer, 0, maximumRead, null);
    if (bytesRead === 0)
      break;
    bytes += bytesRead;
    if (bytes > maximumBytes) {
      throw new VectorizeError("tool_integrity", "VTracer grew beyond its executable size limit while being copied.", { bytes, maximumBytes });
    }
    hash.update(buffer.subarray(0, bytesRead));
    let written = 0;
    while (written < bytesRead) {
      const result = await target.write(buffer, written, bytesRead - written, null);
      if (result.bytesWritten < 1) {
        throw new VectorizeError("tool_integrity", "VTracer private copy stopped before completion.");
      }
      written += result.bytesWritten;
    }
  }
  return bytes === 0 ? "" : hash.digest("hex");
}
function assertBoundedRegularTool(metadata, path) {
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_TOOL_BYTES) {
    throw new VectorizeError("tool_version", `VTracer must be a non-empty regular file: ${path}`, { bytes: metadata.size, maximumBytes: MAX_TOOL_BYTES });
  }
}
async function downloadBounded(url, deadline, maximumBytes) {
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), deadline.remainingMs());
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "hraness-atet-vectorizer" },
      redirect: "follow",
      signal: controller.signal
    });
    if (!response.ok || response.body === null) {
      throw new VectorizeError("tool_download", `Could not download VTracer: ${response.status} ${response.statusText}`);
    }
    const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      throw new VectorizeError("tool_download", "VTracer archive exceeds its download limit.");
    }
    const chunks = [];
    const reader = response.body.getReader();
    let bytes = 0;
    while (true) {
      deadline.assert("VTracer download");
      const { done, value } = await reader.read();
      if (done)
        break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new VectorizeError("tool_download", "VTracer archive exceeds its download limit.");
      }
      chunks.push(value);
    }
    return Uint8Array.from(Buffer.concat(chunks, bytes));
  } catch (error) {
    if (error instanceof VectorizeError)
      throw error;
    if (controller.signal.aborted) {
      throw new VectorizeError("timeout", "VTracer download exceeded the conversion time limit.");
    }
    throw new VectorizeError("tool_download", "Could not download VTracer.", {}, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}
function isFileSystemError2(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}
function boundedReadFlags() {
  if (process.platform === "win32")
    return constants2.O_RDONLY;
  return constants2.O_RDONLY | constants2.O_NONBLOCK | constants2.O_NOFOLLOW;
}

// src/vectorize/pixels.ts
import { constants as constants3 } from "fs";
import { open as open3, realpath as realpath2 } from "fs/promises";
import { resolve as resolve2 } from "path";
import sharp from "sharp";
var allowedFormats = new Set(["avif", "gif", "heif", "jpeg", "png", "tiff", "webp"]);
var METRIC_MAX_EDGE = 512;
var VECTORIZE_SHARP_CONCURRENCY = 1;
function configureVectorizeSharpConcurrency() {
  const actual = sharp.concurrency(VECTORIZE_SHARP_CONCURRENCY);
  if (actual !== VECTORIZE_SHARP_CONCURRENCY) {
    throw new VectorizeError("trace_failed", "The vectorization worker could not bind its Sharp CPU budget.");
  }
}
async function loadRaster(input, limits, deadline) {
  deadline.assert("input read");
  const bytes = await readInputBytes(input, limits.maxInputBytes, deadline);
  deadline.assert("input metadata");
  try {
    const metadata = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: limits.maxDecodedPixels,
      sequentialRead: true
    }).metadata();
    const format = metadata.format;
    if (format === undefined || !allowedFormats.has(format)) {
      throw new VectorizeError("invalid_input", `Expected a supported raster image, received ${format ?? "an unknown format"}.`);
    }
    if ((metadata.pages ?? 1) !== 1) {
      throw new VectorizeError("invalid_input", "Animated and multipage raster inputs are rejected.");
    }
    if (metadata.width === undefined || metadata.height === undefined || metadata.width < 1 || metadata.height < 1) {
      throw new VectorizeError("invalid_input", "Raster dimensions are missing or invalid.");
    }
    assertDimensions(metadata.width, metadata.height, limits);
    const decoded = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: limits.maxDecodedPixels,
      sequentialRead: true
    }).rotate().ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { channels, height, width } = decoded.info;
    if (channels !== 4) {
      throw new VectorizeError("invalid_input", "Raster decoding did not produce RGBA pixels.");
    }
    assertDimensions(width, height, limits);
    const pixels = Uint8Array.from(decoded.data);
    if (!containsVisiblePixel(pixels)) {
      throw new VectorizeError("invalid_input", "A fully transparent image cannot be vectorized.");
    }
    deadline.assert("raster decode");
    const scoreScale = Math.min(1, METRIC_MAX_EDGE / Math.max(width, height));
    const scoreWidth = Math.max(1, Math.round(width * scoreScale));
    const scoreHeight = Math.max(1, Math.round(height * scoreScale));
    const scorePixels = scoreWidth === width && scoreHeight === height ? pixels : Uint8Array.from(await sharp(pixels, { raw: { channels: 4, height, width } }).resize(scoreWidth, scoreHeight, { fit: "fill", kernel: "lanczos3" }).raw().toBuffer());
    deadline.assert("metric sample");
    return {
      bytes,
      format,
      height,
      inputBytes: bytes.byteLength,
      pixels,
      scoreHeight,
      scorePixels,
      scoreWidth,
      sourceSha256: sha256(bytes),
      width
    };
  } catch (error) {
    if (error instanceof VectorizeError)
      throw error;
    throw new VectorizeError("invalid_input", "Raster input could not be decoded safely.", {}, {
      cause: error
    });
  }
}
async function readInputBytes(input, maximumBytes, deadline) {
  if (typeof input === "string") {
    return readRegularInput(resolve2(input), maximumBytes, deadline);
  }
  const view = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  if (view.byteLength === 0) {
    throw new VectorizeError("invalid_input", "Raster input is empty.");
  }
  if (view.byteLength > maximumBytes) {
    throw new VectorizeError("input_limit", `Raster input exceeds the ${maximumBytes}-byte limit.`, { bytes: view.byteLength, maximumBytes });
  }
  deadline.assert("input read");
  const bytes = Uint8Array.from(view);
  deadline.assert("input read");
  return bytes;
}
async function readRegularInput(path, maximumBytes, deadline) {
  let handle;
  try {
    deadline.assert("input read");
    const targetPath = await realpath2(path);
    deadline.assert("input read");
    handle = await open3(targetPath, boundedReadFlags2());
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new VectorizeError("invalid_input", `Raster input is not a file: ${path}`);
    }
    if (metadata.size < 1) {
      throw new VectorizeError("invalid_input", "Raster input is empty.");
    }
    if (metadata.size > maximumBytes) {
      throw new VectorizeError("input_limit", `Raster input exceeds the ${maximumBytes}-byte limit.`, { bytes: metadata.size, maximumBytes });
    }
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maximumBytes + 1));
    const chunks = [];
    let bytes = 0;
    while (true) {
      deadline.assert("input read");
      const maximumRead = Math.min(chunk.byteLength, maximumBytes - bytes + 1);
      const { bytesRead } = await handle.read(chunk, 0, maximumRead, null);
      if (bytesRead === 0)
        break;
      bytes += bytesRead;
      if (bytes > maximumBytes) {
        throw new VectorizeError("input_limit", `Raster input exceeds the ${maximumBytes}-byte limit.`, { bytes, maximumBytes });
      }
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    if (bytes === 0) {
      throw new VectorizeError("invalid_input", "Raster input is empty.");
    }
    deadline.assert("input read");
    return Buffer.concat(chunks, bytes);
  } catch (error) {
    if (error instanceof VectorizeError)
      throw error;
    throw new VectorizeError("invalid_input", "Raster input could not be read safely.", {}, { cause: error });
  } finally {
    await handle?.close().catch(() => {
      return;
    });
  }
}
function assertDimensions(width, height, limits) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > limits.maxDimension || height > limits.maxDimension || width * height > limits.maxDecodedPixels) {
    throw new VectorizeError("input_limit", `Raster dimensions must fit ${limits.maxDimension}px and ${limits.maxDecodedPixels} decoded pixels.`, { height, width });
  }
}
function containsVisiblePixel(rgba) {
  for (let index = 3;index < rgba.length; index += 4) {
    if (rgba[index] > 0)
      return true;
  }
  return false;
}
function boundedReadFlags2() {
  if (process.platform === "win32")
    return constants3.O_RDONLY;
  return constants3.O_RDONLY | constants3.O_NONBLOCK | constants3.O_NOFOLLOW;
}
async function encodeTracePng(pixels, width, height) {
  return Uint8Array.from(await sharp(pixels, { raw: { channels: 4, height, width } }).png({ adaptiveFiltering: false, compressionLevel: 9, palette: false }).toBuffer());
}
async function renderSvgRgba(svg, width, height, maxDecodedPixels) {
  try {
    return Uint8Array.from(await sharp(Buffer.from(svg), {
      density: 72,
      failOn: "error",
      limitInputPixels: maxDecodedPixels
    }).resize(width, height, { fit: "fill" }).ensureAlpha().raw().toBuffer());
  } catch (error) {
    throw new VectorizeError("trace_failed", "Canonical SVG could not be rendered for quality measurement.", {}, { cause: error });
  }
}
function sharpProvenance() {
  const sharpVersions = normalizedPixelToolchain(sharp.versions);
  const sharpVersion = sharpVersions.sharp;
  const vipsVersion = sharpVersions.vips;
  if (sharpVersion === undefined || vipsVersion === undefined) {
    throw new VectorizeError("tool_version", "Sharp must report its own and libvips version metadata.");
  }
  return {
    sharp: sharpVersion,
    sharpVersions,
    vips: vipsVersion
  };
}
function normalizedPixelToolchain(versions) {
  const entries = Object.entries(versions).filter((entry) => entry[1] !== undefined).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0 || entries.some(([name, version]) => name.length === 0 || version.length === 0)) {
    throw new VectorizeError("tool_version", "Pixel toolchain versions must be nonempty strings.");
  }
  return Object.freeze(Object.fromEntries(entries));
}

// src/vectorize/worker-protocol.ts
var VECTORIZE_WORKER_PROTOCOL = 1;
var MAX_VECTORIZE_REQUEST_BYTES = Math.ceil(vectorizeHardLimits.maxInputBytes / 3) * 4 + 512 * 1024;
var MAX_VECTORIZE_RESPONSE_BYTES = vectorizeHardLimits.maxOutputBytes * 2 + 512 * 1024;

// src/vectorize/vectorize.ts
import { randomUUID as randomUUID2 } from "crypto";
import {
  mkdir as mkdir2,
  rename as rename2,
  rm as rm3,
  writeFile as writeFile2
} from "fs/promises";
import { dirname as dirname3, join as join4, resolve as resolve3 } from "path";

// src/vectorize/svg.ts
var PATH_DATA = /^[MmZzLlHhVvCcSsQqTtAaEe0-9+,.\s-]+$/u;
var TRANSLATE = /^translate\(\s*[-+0-9.eE]+\s*(?:,\s*|\s+)[-+0-9.eE]+\s*\)$/u;
var DANGEROUS_SOURCE = /<!DOCTYPE|<!ENTITY|<\?(?!xml)|<(?:a|animate|embed|filter|foreignObject|iframe|image|link|object|script|set|style|use)\b|(?:href|src)\s*=|\bon[a-z]+\s*=|url\s*\(/iu;
function canonicalizeVTracerSvg(sourceSvg, width, height, maxPaths) {
  if (DANGEROUS_SOURCE.test(sourceSvg)) {
    throw new VectorizeError("unsafe_svg", "VTracer output contains active or referenced SVG content.");
  }
  const paths = [];
  const pathPattern = /<path\b([^>]*)\/?\s*>/gu;
  for (const match of sourceSvg.matchAll(pathPattern)) {
    if (paths.length >= maxPaths) {
      throw new VectorizeError("output_limit", `VTracer output exceeds the ${maxPaths}-path limit.`);
    }
    const attributes = match[1];
    const d = attributes.match(/(?:^|\s)d="([^"]*)"/u)?.[1];
    const fill = attributes.match(/(?:^|\s)fill="([^"]+)"/u)?.[1];
    const transform = attributes.match(/(?:^|\s)transform="([^"]+)"/u)?.[1];
    if (d === "")
      continue;
    if (d === undefined || d.includes("&") || !PATH_DATA.test(d)) {
      throw new VectorizeError("unsafe_svg", "VTracer output contains unsupported path data.");
    }
    if (fill === undefined) {
      throw new VectorizeError("unsafe_svg", "VTracer output contains a path without a fill.");
    }
    if (transform !== undefined && !TRANSLATE.test(transform)) {
      throw new VectorizeError("unsafe_svg", "VTracer output contains an unsupported path transform.");
    }
    const normalizedFill = normalizedHexColor(fill);
    paths.push({
      d,
      fill: normalizedFill,
      rgb: parseHexColor(normalizedFill),
      ...transform === undefined ? {} : { transform }
    });
  }
  if (paths.length === 0) {
    throw new VectorizeError("trace_failed", "VTracer output did not contain visible paths.");
  }
  return { paths, svg: buildColorSvg(paths, width, height) };
}
function buildColorSvg(paths, width, height, duotone) {
  const palette = duotone === undefined ? undefined : [
    normalizedHexColor(duotone.palette[0]),
    normalizedHexColor(duotone.palette[1])
  ];
  const body = paths.map(({ d, fill, rgb, transform }) => {
    const outputFill = duotone === undefined || palette === undefined ? fill : colorBelongsToPrimary(rgb, duotone.model) ? palette[0] : palette[1];
    return `  <path d="${d}"${transform === undefined ? "" : ` transform="${transform}"`} fill="${outputFill}"/>`;
  });
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    ...body,
    "</svg>",
    ""
  ].join(`
`);
  assertSafeCanonicalSvg(svg);
  return svg;
}
function buildAlphaMaskedSvg(artworkPaths, maskPaths, width, height, duotone) {
  if (maskPaths.some(({ rgb }) => rgb[0] !== rgb[1] || rgb[1] !== rgb[2])) {
    throw new VectorizeError("unsafe_svg", "An alpha mask may contain only grayscale fills.");
  }
  const palette = duotone === undefined ? undefined : [
    normalizedHexColor(duotone.palette[0]),
    normalizedHexColor(duotone.palette[1])
  ];
  const maskFingerprint = maskPaths.map(({ d, fill, transform }) => `${d}
${fill}
${transform ?? ""}`).join(`
`);
  const maskId = `alpha-${sha256(maskFingerprint).slice(0, 16)}`;
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    "  <defs>",
    `    <mask id="${maskId}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}" mask-type="luminance">`,
    `      <rect x="0" y="0" width="${width}" height="${height}" fill="#000000"/>`,
    ...maskPaths.map(({ d, fill, transform }) => `      <path d="${d}"${transform === undefined ? "" : ` transform="${transform}"`} fill="${fill}"/>`),
    "    </mask>",
    "  </defs>",
    `  <g mask="url(#${maskId})">`,
    ...artworkPaths.map(({ d, fill, rgb, transform }) => {
      const outputFill = duotone === undefined || palette === undefined ? fill : colorBelongsToPrimary(rgb, duotone.model) ? palette[0] : palette[1];
      return `    <path d="${d}"${transform === undefined ? "" : ` transform="${transform}"`} fill="${outputFill}"/>`;
    }),
    "  </g>",
    "</svg>",
    ""
  ].join(`
`);
  assertSafeCanonicalSvg(svg);
  return svg;
}
function countSvgPaths(svg) {
  return svg.match(/<path\b/gu)?.length ?? 0;
}
function assertSafeCanonicalSvg(svg) {
  if (/<!DOCTYPE|<!ENTITY|<\?(?!xml)|<(?:a|animate|embed|filter|foreignObject|iframe|image|link|object|script|set|style|use)\b|(?:href|src)\s*=|\bon[a-z]+\s*=/iu.test(svg)) {
    throw new VectorizeError("unsafe_svg", "Canonical SVG contains active or external content.");
  }
  for (const match of svg.matchAll(/url\(([^)]+)\)/gu)) {
    if (!/^#[a-z0-9-]+$/u.test(match[1])) {
      throw new VectorizeError("unsafe_svg", "Canonical SVG contains an external URL.");
    }
    if (!svg.includes(`id="${match[1].slice(1)}"`)) {
      throw new VectorizeError("unsafe_svg", "Canonical SVG references an unknown local ID.");
    }
  }
}

// src/vectorize/supervisor.ts
import { fileURLToPath } from "url";
import { mkdtemp as mkdtemp2, rm as rm2 } from "fs/promises";
import { tmpdir } from "os";
import { dirname as dirname2, join as join3 } from "path";
var vectorizeErrorCodes = new Set([
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
  "unsafe_svg"
]);
var WORKER_SHUTDOWN_RESERVE_MS = 250;
var WORKER_RESPONSE_RESERVE_MS = 100;
async function runVectorizeWorker(input, options) {
  const startedAt = performance.now();
  const limits = resolveVectorizeLimits(options.limits);
  if (process.platform === "win32") {
    throw new VectorizeError("tool_platform", "Bounded VTracer streaming is unavailable on Windows.", { platform: process.platform });
  }
  const workerInput = encodeInput(input, limits.maxInputBytes);
  const temporaryRoot = await mkdtemp2(join3(tmpdir(), "atet-vectorize-"));
  let result;
  try {
    result = await executeVectorizeWorker(workerInput, options, limits, startedAt, temporaryRoot);
  } finally {
    await removeTemporaryRoot(temporaryRoot);
  }
  if (performance.now() - startedAt >= limits.maxDurationMs) {
    throw new VectorizeError("timeout", "Vectorization exceeded the conversion time limit during cleanup.");
  }
  return result;
}
async function executeVectorizeWorker(workerInput, options, limits, startedAt, temporaryRoot) {
  const preparationRemainingMs = limits.maxDurationMs - (performance.now() - startedAt);
  if (preparationRemainingMs <= WORKER_SHUTDOWN_RESERVE_MS + WORKER_RESPONSE_RESERVE_MS) {
    throw new VectorizeError("timeout", "Vectorization has no remaining budget for isolated worker execution.");
  }
  const workerDurationMs = Math.floor(preparationRemainingMs - WORKER_SHUTDOWN_RESERVE_MS - WORKER_RESPONSE_RESERVE_MS);
  const inheritedFileDescriptors = inheritedDescriptors(options.inheritedFileDescriptors);
  const workerInheritedFileDescriptors = inheritedFileDescriptors.map((_descriptor, index) => index + 3);
  const request = {
    input: workerInput,
    options: cloneOptions(options, workerDurationMs, workerInheritedFileDescriptors),
    protocol: VECTORIZE_WORKER_PROTOCOL,
    temporaryRoot
  };
  const requestBytes = Buffer.from(JSON.stringify(request));
  if (requestBytes.byteLength > MAX_VECTORIZE_REQUEST_BYTES) {
    throw new VectorizeError("input_limit", "The vectorization worker request exceeds its IPC limit.", {
      bytes: requestBytes.byteLength,
      maximumBytes: MAX_VECTORIZE_REQUEST_BYTES
    });
  }
  const remainingMs = limits.maxDurationMs - (performance.now() - startedAt);
  if (remainingMs <= WORKER_SHUTDOWN_RESERVE_MS) {
    throw new VectorizeError("timeout", "Vectorization has no remaining budget for isolated worker startup and cleanup.");
  }
  const { stdout } = await runBoundedCommand([process.execPath, workerEntryPath()], Math.floor(remainingMs - WORKER_SHUTDOWN_RESERVE_MS), "trace_failed", {
    ...inheritedFileDescriptors.length === 0 ? {} : { inheritedFileDescriptors },
    maxStdoutBytes: MAX_VECTORIZE_RESPONSE_BYTES,
    stdin: requestBytes
  });
  if (performance.now() - startedAt >= limits.maxDurationMs) {
    throw new VectorizeError("timeout", "Vectorization exceeded the conversion time limit.");
  }
  const response = parseResponse(stdout);
  if (!response.ok) {
    throw new VectorizeError(response.error.code, response.error.message, response.error.details);
  }
  assertResult(response.result, limits.maxOutputBytes);
  if (performance.now() - startedAt >= limits.maxDurationMs) {
    throw new VectorizeError("timeout", "Vectorization exceeded the conversion time limit.");
  }
  return response.result;
}
async function removeTemporaryRoot(temporaryRoot) {
  try {
    await rm2(temporaryRoot, { force: true, recursive: true });
  } catch (error) {
    throw new VectorizeError("trace_failed", "The isolated vectorization directory could not be removed.", { temporaryRoot }, { cause: error });
  }
}
function encodeInput(input, maximumInputBytes) {
  return typeof input === "string" ? { kind: "path", value: input } : encodeBytes(input, maximumInputBytes);
}
function encodeBytes(input, maximumInputBytes) {
  const view = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  if (view.byteLength < 1) {
    throw new VectorizeError("invalid_input", "Raster input is empty.");
  }
  if (view.byteLength > maximumInputBytes) {
    throw new VectorizeError("input_limit", `Raster input exceeds the ${maximumInputBytes}-byte limit.`, { bytes: view.byteLength, maximumBytes: maximumInputBytes });
  }
  return {
    kind: "bytes",
    value: Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("base64")
  };
}
function cloneOptions(options, workerDurationMs, inheritedFileDescriptors) {
  return {
    ...options.alphaCutoff === undefined ? {} : { alphaCutoff: options.alphaCutoff },
    ...options.cacheDirectory === undefined ? {} : { cacheDirectory: options.cacheDirectory },
    ...options.duotone === undefined ? {} : { duotone: [options.duotone[0], options.duotone[1]] },
    ...inheritedFileDescriptors.length === 0 ? {} : { inheritedFileDescriptors },
    limits: {
      ...options.limits,
      maxDurationMs: workerDurationMs
    },
    ...options.outputPath === undefined ? {} : { outputPath: options.outputPath }
  };
}
function inheritedDescriptors(value) {
  const descriptors = value ?? [];
  if (descriptors.length > 16 || descriptors.some((descriptor, index) => !Number.isSafeInteger(descriptor) || descriptor < 0 || descriptor > 2147483647 || descriptors.indexOf(descriptor) !== index)) {
    throw new VectorizeError("invalid_input", "Inherited vectorizer descriptors must be unique bounded integers.");
  }
  return Object.freeze([...descriptors]);
}
function workerEntryPath() {
  const modulePath = fileURLToPath(import.meta.url);
  return modulePath.endsWith(".ts") ? join3(dirname2(modulePath), "worker.ts") : join3(dirname2(modulePath), "vectorize", "worker.js");
}
function parseResponse(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new VectorizeError("trace_failed", "The vectorization worker returned malformed output.", {}, { cause: error });
  }
  if (!isRecord(parsed) || parsed.protocol !== VECTORIZE_WORKER_PROTOCOL) {
    throw new VectorizeError("trace_failed", "The vectorization worker returned an incompatible response.");
  }
  if (parsed.ok === true && isVectorizeResult(parsed.result)) {
    return parsed;
  }
  if (parsed.ok === false && isRecord(parsed.error) && typeof parsed.error.code === "string" && vectorizeErrorCodes.has(parsed.error.code) && typeof parsed.error.message === "string" && isRecord(parsed.error.details)) {
    return parsed;
  }
  throw new VectorizeError("trace_failed", "The vectorization worker returned an invalid response.");
}
function assertResult(result, maximumOutputBytes) {
  const bytes = Buffer.byteLength(result.svg);
  if (bytes < 1 || bytes > maximumOutputBytes || result.receipt.bytes !== bytes || result.receipt.svgSha256.length !== 64) {
    throw new VectorizeError("trace_failed", "The vectorization worker response violates its output contract.", { bytes, maximumOutputBytes });
  }
}
function isVectorizeResult(value) {
  if (!isRecord(value) || value.outputPath !== null && typeof value.outputPath !== "string" || typeof value.svg !== "string" || !isRecord(value.receipt)) {
    return false;
  }
  const profile = value.receipt.profile;
  return typeof value.receipt.bytes === "number" && typeof value.receipt.svgSha256 === "string" && typeof profile === "string" && vectorizeProfileNames.includes(profile);
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/vectorize/vectorize.ts
var DEFAULT_ALPHA_CUTOFF = 8;
var COMPARE_LOW_ALPHA_MASS_RATIO = 0.002;
var profiles = [
  {
    args: [
      "--colormode",
      "color",
      "--hierarchical",
      "stacked",
      "--mode",
      "spline",
      "--filter_speckle",
      "0",
      "--color_precision",
      "8",
      "--gradient_step",
      "4",
      "--segment_length",
      "4.5",
      "--path_precision",
      "4"
    ],
    name: "balanced"
  },
  {
    args: [
      "--colormode",
      "color",
      "--hierarchical",
      "stacked",
      "--mode",
      "spline",
      "--filter_speckle",
      "0",
      "--color_precision",
      "8",
      "--gradient_step",
      "2",
      "--segment_length",
      "3.5",
      "--path_precision",
      "5"
    ],
    name: "detailed"
  },
  {
    args: [
      "--preset",
      "photo",
      "--hierarchical",
      "stacked",
      "--filter_speckle",
      "0"
    ],
    name: "photo"
  }
];
var alphaMaskArgs = [
  "--colormode",
  "color",
  "--hierarchical",
  "cutout",
  "--mode",
  "spline",
  "--filter_speckle",
  "0",
  "--color_precision",
  "8",
  "--gradient_step",
  "2",
  "--segment_length",
  "3.5",
  "--path_precision",
  "5",
  "--corner_threshold",
  "30",
  "--splice_threshold",
  "20"
];
function vectorizeImage(input, options = {}) {
  return runVectorizeWorker(input, options);
}
async function vectorizeImageInProcess(input, options = {}, temporaryRoot) {
  const limits = resolveVectorizeLimits(options.limits);
  const deadline = new VectorizeDeadline(limits.maxDurationMs);
  const alphaCutoff = options.alphaCutoff ?? DEFAULT_ALPHA_CUTOFF;
  if (!Number.isInteger(alphaCutoff) || alphaCutoff < 1 || alphaCutoff > 64) {
    throw new VectorizeError("invalid_input", "alphaCutoff must be an integer from 1 through 64.");
  }
  const duotonePalette = options.duotone === undefined ? undefined : [
    normalizedHexColor(options.duotone[0]),
    normalizedHexColor(options.duotone[1])
  ];
  const raster = await loadRaster(input, limits, deadline);
  if (process.platform === "win32") {
    throw new VectorizeError("tool_platform", "Bounded VTracer streaming is unavailable on Windows.", { platform: process.platform });
  }
  const tool = await ensureVTracer(deadline, temporaryRoot, options.cacheDirectory);
  const errors = [];
  const candidates = [];
  const variations = traceVariations(raster.pixels, alphaCutoff);
  for (const variation of variations) {
    deadline.assert(`${variation.name} trace`);
    const sourcePath = join4(temporaryRoot, `${variation.name}.png`);
    await writeFile2(sourcePath, await encodeTracePng(variation.pixels, raster.width, raster.height));
    const balanced = await attemptCandidate(raster, variation, profiles[0], sourcePath, tool, temporaryRoot, limits, deadline, errors);
    if (balanced !== undefined)
      candidates.push(balanced);
    if (balanced !== undefined && passesFastQuality(balanced.quality))
      continue;
    const detailed = await attemptCandidate(raster, variation, profiles[1], sourcePath, tool, temporaryRoot, limits, deadline, errors);
    if (detailed !== undefined)
      candidates.push(detailed);
    if ([balanced, detailed].some((candidate) => candidate !== undefined && passesQuality(candidate.quality))) {
      continue;
    }
    const photo = await attemptCandidate(raster, variation, profiles[2], sourcePath, tool, temporaryRoot, limits, deadline, errors);
    if (photo !== undefined)
      candidates.push(photo);
  }
  const baseForMask = [...candidates].sort(compareFidelity)[0];
  if (baseForMask !== undefined && hasFractionalAlpha(raster.pixels) && baseForMask.quality.alphaRmse > 0.06) {
    const masked = await attemptAlphaMask(raster, baseForMask, tool, temporaryRoot, limits, deadline, errors);
    if (masked !== undefined)
      candidates.push(masked);
  }
  const eligible = candidates.filter((candidate) => candidate.bytes <= limits.maxOutputBytes && candidate.pathCount <= limits.maxPaths && passesQuality(candidate.quality));
  if (eligible.length === 0) {
    throw new VectorizeError("quality_limit", "No adaptive vector candidate passed the fidelity and output gates.", {
      candidates: candidates.map(candidateSummary),
      errors
    });
  }
  const selected = selectCandidate(eligible);
  const duotone = duotonePalette === undefined ? undefined : {
    model: dominantOklabDuotoneModel(raster.pixels),
    palette: duotonePalette
  };
  const svg = selected.maskPaths === undefined ? buildColorSvg(selected.artworkPaths, raster.width, raster.height, duotone) : buildAlphaMaskedSvg(selected.artworkPaths, selected.maskPaths, raster.width, raster.height, duotone);
  assertSafeCanonicalSvg(svg);
  const bytes = Buffer.byteLength(svg);
  const pathCount = countSvgPaths(svg);
  if (bytes > limits.maxOutputBytes || pathCount > limits.maxPaths) {
    throw new VectorizeError("output_limit", `Canonical SVG exceeds ${limits.maxOutputBytes} bytes or ${limits.maxPaths} paths.`, { bytes, pathCount });
  }
  deadline.assert("output publication");
  const outputPath = options.outputPath === undefined ? null : await writeSvgAtomically(options.outputPath, svg);
  const pixelToolchain = sharpProvenance();
  return {
    outputPath,
    receipt: {
      alphaCutoff: selected.alphaCutoff,
      bytes,
      candidatesEvaluated: candidates.length,
      format: raster.format,
      height: raster.height,
      inputBytes: raster.inputBytes,
      outputMode: duotone === undefined ? "color" : "duotone",
      pathCount,
      profile: selected.profile,
      provenance: {
        arch: process.arch,
        platform: process.platform,
        sharp: pixelToolchain.sharp,
        sharpVersions: pixelToolchain.sharpVersions,
        vips: pixelToolchain.vips,
        vtracerSha256: tool.sha256,
        vtracerSource: tool.source,
        vtracerVersion: tool.version
      },
      quality: roundedQuality(selected.quality),
      receiptVersion: 1,
      representation: selected.representation,
      sourceSha256: raster.sourceSha256,
      svgSha256: sha256(svg),
      width: raster.width
    },
    svg
  };
}
function traceVariations(pixels, alphaCutoff) {
  const sanitized = sanitizedTraceRgba(pixels, alphaCutoff);
  const output = [];
  if (containsVisiblePixel2(sanitized)) {
    output.push({ alphaCutoff, name: `alpha-${alphaCutoff}`, pixels: sanitized });
  }
  if (alphaCutoff > 1 && (output.length === 0 || lowAlphaMassRatio(pixels, alphaCutoff) >= COMPARE_LOW_ALPHA_MASS_RATIO)) {
    output.push({
      alphaCutoff: 1,
      name: "alpha-1",
      pixels: sanitizedTraceRgba(pixels, 1)
    });
  }
  if (output.length === 0) {
    throw new VectorizeError("invalid_input", "Alpha sanitation removed every visible pixel.");
  }
  return output;
}
function containsVisiblePixel2(pixels) {
  for (let index = 3;index < pixels.length; index += 4) {
    if (pixels[index] > 0)
      return true;
  }
  return false;
}
async function attemptCandidate(raster, variation, profile, sourcePath, tool, temporaryRoot, limits, deadline, errors) {
  try {
    const raw = await traceRawSvg(tool, sourcePath, profile.args, temporaryRoot, limits.maxOutputBytes, deadline);
    deadline.assert(`${profile.name} trace`);
    const canonical = canonicalizeVTracerSvg(raw, raster.width, raster.height, limits.maxPaths);
    const bytes = Buffer.byteLength(canonical.svg);
    const pathCount = canonical.paths.length;
    if (bytes > limits.maxOutputBytes || pathCount > limits.maxPaths) {
      throw new VectorizeError("output_limit", `${profile.name} exceeds vector output limits.`);
    }
    const quality = await scoreSvg(canonical.svg, raster, limits.maxDecodedPixels, deadline);
    return {
      alphaCutoff: variation.alphaCutoff,
      artworkPaths: canonical.paths,
      bytes,
      pathCount,
      profile: profile.name,
      quality,
      representation: "color-paths",
      svg: canonical.svg
    };
  } catch (error) {
    if (error instanceof VectorizeError && error.code === "timeout")
      throw error;
    errors.push(`${variation.name}/${profile.name}: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
}
async function attemptAlphaMask(raster, base, tool, temporaryRoot, limits, deadline, errors) {
  try {
    const alphaPixels = alphaPlaneTraceRgba(raster.pixels);
    const sourcePath = join4(temporaryRoot, "alpha-plane.png");
    await writeFile2(sourcePath, await encodeTracePng(alphaPixels, raster.width, raster.height));
    const raw = await traceRawSvg(tool, sourcePath, alphaMaskArgs, temporaryRoot, limits.maxOutputBytes, deadline);
    const mask = canonicalizeVTracerSvg(raw, raster.width, raster.height, limits.maxPaths);
    const pathCount = base.artworkPaths.length + mask.paths.length;
    if (pathCount > limits.maxPaths) {
      throw new VectorizeError("output_limit", "Alpha-masked output exceeds the path limit.");
    }
    const svg = buildAlphaMaskedSvg(base.artworkPaths, mask.paths, raster.width, raster.height);
    const bytes = Buffer.byteLength(svg);
    if (bytes > limits.maxOutputBytes) {
      throw new VectorizeError("output_limit", "Alpha-masked output exceeds the byte limit.");
    }
    const quality = await scoreSvg(svg, raster, limits.maxDecodedPixels, deadline);
    return {
      alphaCutoff: base.alphaCutoff,
      artworkPaths: base.artworkPaths,
      bytes,
      maskPaths: mask.paths,
      pathCount,
      profile: base.profile,
      quality,
      representation: "alpha-mask",
      svg
    };
  } catch (error) {
    if (error instanceof VectorizeError && error.code === "timeout")
      throw error;
    errors.push(`alpha-mask: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
}
async function scoreSvg(svg, raster, maxDecodedPixels, deadline) {
  const candidatePixels = await renderSvgRgba(svg, raster.scoreWidth, raster.scoreHeight, maxDecodedPixels);
  deadline.assert("quality measurement");
  const support = measureSupport(raster.scorePixels, candidatePixels, raster.scoreWidth, raster.scoreHeight, 1);
  return {
    alphaRmse: normalizedAlphaRmse(raster.scorePixels, candidatePixels),
    colorRmse: normalizedPremultipliedRmse(raster.scorePixels, candidatePixels),
    outsideAlphaRatio: support.outsideAlphaRatio,
    sampleHeight: raster.scoreHeight,
    sampleWidth: raster.scoreWidth,
    supportRecall: support.supportRecall
  };
}
async function traceRawSvg(tool, sourcePath, args, temporaryRoot, maximumBytes, deadline) {
  const { output } = await runBoundedPathOutputCommand((outputPath) => [
    tool.path,
    "--input",
    sourcePath,
    "--output",
    outputPath,
    ...args
  ], deadline.remainingMs(), "trace_failed", {
    maxOutputBytes: maximumBytes,
    temporaryRoot
  });
  if (output.length === 0) {
    throw new VectorizeError("trace_failed", "VTracer did not emit an SVG.");
  }
  return output;
}
function passesFastQuality(quality) {
  return passesQuality(quality) && quality.colorRmse <= 0.12 && quality.alphaRmse <= 0.18 && quality.outsideAlphaRatio <= 0.02 && quality.supportRecall >= 0.97;
}
function passesQuality(quality) {
  return quality.colorRmse <= 0.3 && quality.alphaRmse <= 0.3 && quality.outsideAlphaRatio <= 0.15 && quality.supportRecall >= 0.8;
}
function compareFidelity(left, right) {
  return left.quality.colorRmse - right.quality.colorRmse || left.quality.alphaRmse - right.quality.alphaRmse || left.bytes - right.bytes || left.pathCount - right.pathCount || left.profile.localeCompare(right.profile);
}
function selectCandidate(candidates) {
  const bestRmse = Math.min(...candidates.map(({ quality }) => quality.colorRmse));
  const fidelityWindow = candidates.filter(({ quality }) => quality.colorRmse <= bestRmse + 0.005);
  return [...fidelityWindow].sort((left, right) => left.bytes - right.bytes || left.pathCount - right.pathCount || left.quality.alphaRmse - right.quality.alphaRmse || left.profile.localeCompare(right.profile) || left.representation.localeCompare(right.representation))[0];
}
function roundedQuality(quality) {
  const rounded = (value) => Number(value.toFixed(8));
  return {
    alphaRmse: rounded(quality.alphaRmse),
    colorRmse: rounded(quality.colorRmse),
    outsideAlphaRatio: rounded(quality.outsideAlphaRatio),
    sampleHeight: quality.sampleHeight,
    sampleWidth: quality.sampleWidth,
    supportRecall: rounded(quality.supportRecall)
  };
}
function candidateSummary(candidate) {
  return {
    alphaCutoff: candidate.alphaCutoff,
    bytes: candidate.bytes,
    pathCount: candidate.pathCount,
    profile: candidate.profile,
    quality: roundedQuality(candidate.quality),
    representation: candidate.representation
  };
}
async function writeSvgAtomically(path, svg) {
  const outputPath = resolve3(path);
  await mkdir2(dirname3(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${randomUUID2()}.tmp`;
  try {
    await writeFile2(temporaryPath, svg, { flag: "wx" });
    await rename2(temporaryPath, outputPath);
  } catch (error) {
    await rm3(temporaryPath, { force: true });
    throw new VectorizeError("output_limit", `Could not atomically write ${outputPath}.`, {}, { cause: error });
  }
  return outputPath;
}

export { nonGatewayChildEnvironment, vectorizeProfileNames, VectorizeError, vectorizeHardLimits, vectorizeDefaultLimits, withInheritedCommandFileDescriptors, forwardVectorizeWorkerTermination, VTRACER_VERSION, vtracerReleases, configureVectorizeSharpConcurrency, VECTORIZE_WORKER_PROTOCOL, MAX_VECTORIZE_REQUEST_BYTES, MAX_VECTORIZE_RESPONSE_BYTES, vectorizeImage, vectorizeImageInProcess };
