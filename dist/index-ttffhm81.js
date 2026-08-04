// @bun
import {
  getTransmuteAccessToken
} from "./index-bt7a0bdq.js";
import {
  TransmuteCloudError,
  fetchTransmuteDiscovery,
  parseTransmuteDiscovery,
  readBoundedResponseBytes,
  transmuteImageModels,
  transmuteResponseMediaTypes
} from "./index-sn35spwy.js";

// src/generate.ts
import { randomUUID } from "crypto";
import { rename, rm, writeFile } from "fs/promises";
import { dirname, resolve } from "path";
var maximumIdempotencyKeyLength = 128;
var minimumIdempotencyKeyLength = 16;
var responseEnvelopeAllowanceBytes = 8 * 1024;
function invalidArgument(message) {
  throw new TransmuteCloudError("INVALID_ARGUMENT", message);
}
function validateTransmuteIdempotencyKey(value) {
  if (value.length < minimumIdempotencyKeyLength || value.length > maximumIdempotencyKeyLength || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    invalidArgument("Idempotency key must be 16\u2013128 characters using letters, digits, `.`, `_`, `:`, or `-`.");
  }
  return value;
}
function validateInput(input, discovery) {
  if (!transmuteImageModels.includes(input.model)) {
    invalidArgument(`Model must be ${transmuteImageModels[0]} or ${transmuteImageModels[1]}.`);
  }
  if (typeof input.prompt !== "string" || input.prompt.trim().length === 0 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.prompt) || Buffer.byteLength(input.prompt, "utf8") > discovery.capabilities.media.imageGeneration.maximumPromptBytes) {
    invalidArgument(`Prompt must be non-empty and no more than ${discovery.capabilities.media.imageGeneration.maximumPromptBytes} UTF-8 bytes.`);
  }
  const idempotencyKey = validateTransmuteIdempotencyKey(input.idempotencyKey ?? randomUUID());
  return {
    idempotencyKey,
    requestBody: JSON.stringify({
      model: input.model,
      prompt: input.prompt
    })
  };
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length && actual.every((entry, index) => entry === canonical[index]);
}
function isCanonicalBase64(value) {
  return value.length > 0 && value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value);
}
function hasExpectedMagic(bytes, _mediaType) {
  return bytes.byteLength >= 16 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(bytes).readUInt32LE(4) === bytes.byteLength - 8 && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(Buffer.from(bytes.subarray(12, 16)).toString("ascii"));
}
function parseGeneratedTransmuteImage(value, discovery, requestedModel) {
  const trustedDiscovery = parseTransmuteDiscovery(discovery);
  const invalid = new TransmuteCloudError("GENERATION_INVALID_RESPONSE", "Transmute image generation returned an invalid bounded image.");
  if (!isRecord(value) || !exactKeys(value, ["apiVersion", "image", "model", "requestId"]) || value.apiVersion !== "v1" || value.model !== requestedModel || typeof value.requestId !== "string" || value.requestId.length < 1 || value.requestId.length > 256 || /[\u0000-\u001f\u007f]/u.test(value.requestId) || !isRecord(value.image) || !exactKeys(value.image, ["base64", "mediaType"]) || typeof value.image.base64 !== "string" || !isCanonicalBase64(value.image.base64) || typeof value.image.mediaType !== "string" || !transmuteResponseMediaTypes.includes(value.image.mediaType) || value.image.mediaType !== trustedDiscovery.capabilities.media.imageGeneration.responseMediaTypes[0]) {
    throw invalid;
  }
  const bytes = Buffer.from(value.image.base64, "base64");
  if (bytes.byteLength < 1 || bytes.byteLength > trustedDiscovery.capabilities.media.imageGeneration.maximumRawImageBytes || bytes.toString("base64") !== value.image.base64 || !hasExpectedMagic(bytes, value.image.mediaType)) {
    throw invalid;
  }
  return {
    response: {
      apiVersion: "v1",
      image: {
        base64: value.image.base64,
        mediaType: value.image.mediaType
      },
      model: requestedModel,
      requestId: value.requestId
    },
    bytes
  };
}
async function performGeneration(input, dependencies) {
  const discovery = dependencies.discovery === undefined ? await fetchTransmuteDiscovery(dependencies.fetch) : parseTransmuteDiscovery(dependencies.discovery);
  const { idempotencyKey, requestBody } = validateInput(input, discovery);
  const accessToken = await getTransmuteAccessToken(discovery, dependencies);
  const maximumResponseBytes = Math.ceil(discovery.capabilities.media.imageGeneration.maximumRawImageBytes / 3) * 4 + responseEnvelopeAllowanceBytes;
  const failed = new TransmuteCloudError("GENERATION_FAILED", "Transmute image generation failed; the request was not retried.");
  let response;
  try {
    response = await (dependencies.fetch ?? fetch)(discovery.capabilities.media.endpoints.generateImage, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        [discovery.capabilities.media.imageGeneration.idempotency.header]: idempotencyKey,
        "user-agent": "hraness-transmute-cli/0.8.0"
      },
      body: requestBody,
      redirect: "error",
      signal: AbortSignal.timeout(120000)
    });
  } catch (cause) {
    throw new TransmuteCloudError("GENERATION_FAILED", "Transmute image generation failed; the request was not retried.", { cause });
  }
  const contentType = response.headers.get("content-type");
  if (contentType === null || !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/iu.test(contentType)) {
    await response.body?.cancel().catch(() => {
      return;
    });
    throw failed;
  }
  const responseBytes = await readBoundedResponseBytes(response, maximumResponseBytes, failed);
  if (!response.ok)
    throw failed;
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(responseBytes));
  } catch {
    throw new TransmuteCloudError("GENERATION_INVALID_RESPONSE", "Transmute image generation returned invalid JSON.");
  }
  const parsed = parseGeneratedTransmuteImage(value, discovery, input.model);
  return { ...parsed, idempotencyKey };
}
async function generateTransmuteImage(input, dependencies = {}) {
  const generated = await performGeneration(input, dependencies);
  return { ...generated.response, idempotencyKey: generated.idempotencyKey };
}
async function atomicImageWrite(outputPath, bytes) {
  const absolutePath = resolve(outputPath);
  const temporaryPath = resolve(dirname(absolutePath), `.${randomUUID()}.transmute-generate.tmp`);
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx" });
    await rename(temporaryPath, absolutePath);
    return absolutePath;
  } catch (cause) {
    throw new TransmuteCloudError("OUTPUT_WRITE_FAILED", "Transmute could not atomically write the generated image.", { cause });
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {
      return;
    });
  }
}
async function generateTransmuteImageFile(input, dependencies = {}) {
  if (typeof input.outputPath !== "string" || input.outputPath.length < 1 || input.outputPath.length > 4096 || input.outputPath.includes("\x00")) {
    invalidArgument("Output path must be a non-empty local path.");
  }
  if (!input.outputPath.toLowerCase().endsWith(".webp")) {
    invalidArgument("Output path must end in .webp.");
  }
  const generated = await performGeneration(input, dependencies);
  const outputPath = await atomicImageWrite(input.outputPath, generated.bytes);
  return {
    bytes: generated.bytes.byteLength,
    idempotencyKey: generated.idempotencyKey,
    mediaType: generated.response.image.mediaType,
    model: generated.response.model,
    outputPath,
    requestId: generated.response.requestId
  };
}

export { validateTransmuteIdempotencyKey, generateTransmuteImage, generateTransmuteImageFile };
