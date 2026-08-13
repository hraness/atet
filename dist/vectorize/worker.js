// @bun
import {
  MAX_VECTORIZE_REQUEST_BYTES,
  MAX_VECTORIZE_RESPONSE_BYTES,
  VECTORIZE_WORKER_PROTOCOL,
  VectorizeError,
  configureVectorizeSharpConcurrency,
  forwardVectorizeWorkerTermination,
  vectorizeImageInProcess,
  withInheritedCommandFileDescriptors
} from "../index-vdtz0dng.js";
import"../index-z1w83f81.js";

// src/vectorize/worker.ts
import { lstat, realpath } from "fs/promises";
import { tmpdir } from "os";
import { basename, dirname } from "path";
var errorCodes = new Set([
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
forwardVectorizeWorkerTermination();
await main();
async function main() {
  let response;
  try {
    configureVectorizeSharpConcurrency();
    const requestText = await readBoundedInput();
    const request = parseRequest(requestText);
    const input = decodeInput(request.input);
    const temporaryRoot = await validateTemporaryRoot(request.temporaryRoot);
    const result = await withInheritedCommandFileDescriptors(request.options.inheritedFileDescriptors, async () => await vectorizeImageInProcess(input, request.options, temporaryRoot));
    response = {
      ok: true,
      protocol: VECTORIZE_WORKER_PROTOCOL,
      result
    };
  } catch (error) {
    response = {
      error: serializeError(error),
      ok: false,
      protocol: VECTORIZE_WORKER_PROTOCOL
    };
  }
  let encoded = JSON.stringify(response);
  if (Buffer.byteLength(encoded) > MAX_VECTORIZE_RESPONSE_BYTES) {
    encoded = JSON.stringify({
      error: {
        code: "output_limit",
        details: { maximumBytes: MAX_VECTORIZE_RESPONSE_BYTES },
        message: "The vectorization worker response exceeds its IPC limit."
      },
      ok: false,
      protocol: VECTORIZE_WORKER_PROTOCOL
    });
  }
  await Bun.write(Bun.stdout, encoded);
}
async function readBoundedInput() {
  const reader = Bun.stdin.stream().getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done)
        break;
      bytes += value.byteLength;
      if (bytes > MAX_VECTORIZE_REQUEST_BYTES) {
        await reader.cancel();
        throw new VectorizeError("input_limit", "The vectorization worker request exceeds its IPC limit.", { bytes, maximumBytes: MAX_VECTORIZE_REQUEST_BYTES });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}
function parseRequest(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new VectorizeError("invalid_input", "The vectorization worker request is malformed.", {}, { cause: error });
  }
  if (!isRecord(parsed) || parsed.protocol !== VECTORIZE_WORKER_PROTOCOL || !isRecord(parsed.input) || !isRecord(parsed.options) || typeof parsed.temporaryRoot !== "string" || parsed.temporaryRoot.length === 0 || typeof parsed.input.kind !== "string" || typeof parsed.input.value !== "string" || !["bytes", "path"].includes(parsed.input.kind)) {
    throw new VectorizeError("invalid_input", "The vectorization worker request is invalid.");
  }
  return parsed;
}
function decodeInput(input) {
  if (input.kind === "path")
    return input.value;
  if (input.value.length > Math.ceil(MAX_VECTORIZE_REQUEST_BYTES / 3) * 4 || input.value.length % 4 !== 0) {
    throw new VectorizeError("input_limit", "Encoded raster input exceeds its IPC limit.");
  }
  const bytes = Buffer.from(input.value, "base64");
  if (bytes.toString("base64") !== input.value) {
    throw new VectorizeError("invalid_input", "Encoded raster input is not canonical base64.");
  }
  return bytes;
}
async function validateTemporaryRoot(path) {
  let realRoot;
  let realTemporaryDirectory;
  try {
    const resolved = await Promise.all([
      realpath(path),
      realpath(tmpdir())
    ]);
    realRoot = resolved[0];
    realTemporaryDirectory = resolved[1];
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || dirname(realRoot) !== realTemporaryDirectory || !/^transmute-vectorize-[A-Za-z0-9_-]{6,}$/u.test(basename(realRoot))) {
      throw new VectorizeError("invalid_input", "The supervisor temporary directory is invalid.");
    }
  } catch (error) {
    if (error instanceof VectorizeError)
      throw error;
    throw new VectorizeError("invalid_input", "The supervisor temporary directory could not be verified.", {}, { cause: error });
  }
  return realRoot;
}
function serializeError(error) {
  const code = error instanceof VectorizeError && errorCodes.has(error.code) ? error.code : "trace_failed";
  const message = error instanceof Error ? error.message : "The vectorization worker failed.";
  const details = error instanceof VectorizeError && Buffer.byteLength(JSON.stringify(error.details)) <= 64 * 1024 ? error.details : {};
  return { code, details, message };
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
