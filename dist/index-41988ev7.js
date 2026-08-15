// @bun
import {
  __require
} from "./index-z1w83f81.js";

// src/generate.ts
import { createHash, randomUUID } from "crypto";
import { link, rm, writeFile } from "fs/promises";
import { dirname, extname, resolve } from "path";

// src/cloud-errors.ts
class AtetCloudError extends Error {
  code;
  constructor(code, message, options) {
    super(`[${code}] ${message}`, options);
    this.name = "AtetCloudError";
    this.code = code;
  }
}

// src/generate.ts
var atetGatewayApiBaseUrl = "https://ai-gateway.vercel.sh/v4/ai";
var atetImageModels = Object.freeze([
  "openai/gpt-image-1.5",
  "recraft/recraft-v4.1-utility"
]);
var atetResponseMediaTypes = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp"
]);
var atetMaximumPromptBytes = 32 * 1024;
var atetMaximumRawImageBytes = 64 * 1024 * 1024;
var defaultGenerationTimeoutMs = 5 * 60000;
var maximumGenerationTimeoutMs = 30 * 60000;
var defaultMaximumGatewayResponseBytes = 96 * 1024 * 1024;
function invalidArgument(message) {
  throw new AtetCloudError("INVALID_ARGUMENT", message);
}
function credentialValue(value) {
  if (value.length < 16 || value.length > 16 * 1024 || value.trim() !== value || /[^\x21-\x7e]/u.test(value)) {
    throw new AtetCloudError("AUTHENTICATION_REQUIRED", "The selected Vercel AI Gateway credential is invalid.");
  }
  return value;
}
function environment(injected) {
  return injected ?? process.env;
}
function resolveGatewayCredential(injected) {
  const values = environment(injected);
  if (values.AI_GATEWAY_API_KEY !== undefined) {
    return {
      source: "AI_GATEWAY_API_KEY",
      token: credentialValue(values.AI_GATEWAY_API_KEY)
    };
  }
  if (values.VERCEL_OIDC_TOKEN !== undefined) {
    return {
      source: "VERCEL_OIDC_TOKEN",
      token: credentialValue(values.VERCEL_OIDC_TOKEN)
    };
  }
  throw new AtetCloudError("AUTHENTICATION_REQUIRED", "Set AI_GATEWAY_API_KEY or run Atet through `vercel env run -- \u2026` with VERCEL_OIDC_TOKEN available.");
}
function atetGatewayCredentialStatus(injected) {
  const values = environment(injected);
  if (values.AI_GATEWAY_API_KEY !== undefined) {
    credentialValue(values.AI_GATEWAY_API_KEY);
    return { available: true, source: "AI_GATEWAY_API_KEY" };
  }
  if (values.VERCEL_OIDC_TOKEN !== undefined) {
    credentialValue(values.VERCEL_OIDC_TOKEN);
    return { available: true, source: "VERCEL_OIDC_TOKEN" };
  }
  return { available: false, source: null };
}
function validateModel(value) {
  if (typeof value !== "string" || value.length < 3 || value.length > 256 || !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/iu.test(value)) {
    invalidArgument("Model must be a bounded Vercel AI Gateway provider/model id.");
  }
  return value;
}
function validatePrompt(value) {
  if (typeof value !== "string" || value.trim().length === 0 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) || Buffer.byteLength(value, "utf8") > atetMaximumPromptBytes) {
    invalidArgument(`Prompt must be non-empty and no more than ${atetMaximumPromptBytes} UTF-8 bytes.`);
  }
  return value;
}
function validateTimeout(value) {
  const timeout = value ?? defaultGenerationTimeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > maximumGenerationTimeoutMs) {
    invalidArgument(`timeoutMs must be an integer from 1000 through ${maximumGenerationTimeoutMs}.`);
  }
  return timeout;
}
function isObject(value) {
  return typeof value === "object" && value !== null || typeof value === "function";
}
function parseFunction(value) {
  if (typeof value !== "function") {
    throw new AtetCloudError("GENERATION_FAILED", "The Vercel AI Gateway runtime is unavailable.");
  }
  return value;
}
function disableAiSdkWarningLogging() {
  globalThis.AI_SDK_LOG_WARNINGS = false;
}
function assertGenerationActive(signal) {
  if (signal.aborted) {
    throw new AtetCloudError("GENERATION_FAILED", "Vercel AI Gateway image generation was cancelled or exceeded its deadline.");
  }
}
async function loadDefaultGatewayRuntime() {
  let aiModule;
  let gatewayModule;
  try {
    [aiModule, gatewayModule] = await Promise.all([
      import("ai-v7"),
      import("@ai-sdk/gateway-v4")
    ]);
  } catch {
    throw new AtetCloudError("GENERATION_FAILED", "The Vercel AI Gateway runtime is unavailable.");
  }
  if (!isObject(aiModule) || !isObject(gatewayModule)) {
    throw new AtetCloudError("GENERATION_FAILED", "The Vercel AI Gateway runtime is unavailable.");
  }
  const generateImage = parseFunction(aiModule.generateImage);
  if (typeof gatewayModule.createGateway !== "function") {
    throw new AtetCloudError("GENERATION_FAILED", "The Vercel AI Gateway runtime is unavailable.");
  }
  const createGateway = gatewayModule.createGateway;
  return {
    createGateway: (settings) => {
      const provider = createGateway(settings);
      if (!isObject(provider) || typeof provider.imageModel !== "function") {
        throw new AtetCloudError("GENERATION_FAILED", "The Vercel AI Gateway runtime is unavailable.");
      }
      const imageModel = provider.imageModel;
      return { imageModel: (modelId) => imageModel.call(provider, modelId) };
    },
    generateImage
  };
}
function gatewayUrl(input) {
  try {
    if (input instanceof Request)
      return new URL(input.url);
    if (input instanceof URL)
      return new URL(input.href);
    return new URL(input, atetGatewayApiBaseUrl);
  } catch {
    throw new AtetCloudError("GENERATION_FAILED", "The Vercel AI Gateway request was rejected.");
  }
}
function canonicalGatewayInput(input, url) {
  if (!(input instanceof Request))
    return url;
  const snapshot = new Request(input);
  const body = snapshot.method === "GET" || snapshot.method === "HEAD" ? undefined : snapshot.body ?? undefined;
  const requestInit = {
    headers: snapshot.headers,
    method: snapshot.method,
    signal: snapshot.signal,
    ...body === undefined ? {} : { body, duplex: "half" }
  };
  return new Request(url.href, requestInit);
}
function boundedResponse(response, maximumBytes) {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const value = Number(declared);
    if (!Number.isSafeInteger(value) || value < 0 || value > maximumBytes) {
      response.body?.cancel().catch(() => {
        return;
      });
      throw new AtetCloudError("GENERATION_INVALID_RESPONSE", "Vercel AI Gateway returned an invalid bounded response.");
    }
  }
  if (response.body === null)
    return response;
  const reader = response.body.getReader();
  let bytes = 0;
  const body = new ReadableStream({
    cancel: async (reason) => await reader.cancel(reason),
    pull: async (controller) => {
      try {
        const next = await reader.read();
        if (next.done) {
          reader.releaseLock();
          controller.close();
          return;
        }
        bytes += next.value.byteLength;
        if (bytes > maximumBytes) {
          await reader.cancel().catch(() => {
            return;
          });
          controller.error(new AtetCloudError("GENERATION_INVALID_RESPONSE", "Vercel AI Gateway returned an invalid bounded response."));
          return;
        }
        controller.enqueue(next.value);
      } catch {
        controller.error(new AtetCloudError("GENERATION_INVALID_RESPONSE", "Vercel AI Gateway returned an invalid bounded response."));
      }
    }
  });
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText
  });
}
function createFixedGatewayFetch(options = {}) {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const maximumResponseBytes = options.maximumResponseBytes ?? defaultMaximumGatewayResponseBytes;
  if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 1 || maximumResponseBytes > 1024 * 1024 * 1024) {
    invalidArgument("maximumResponseBytes is outside the supported range.");
  }
  const fixed = new URL(atetGatewayApiBaseUrl);
  return async (input, init) => {
    const url = gatewayUrl(input);
    if (url.origin !== fixed.origin || url.pathname !== fixed.pathname && !url.pathname.startsWith(`${fixed.pathname}/`) || url.username !== "" || url.password !== "") {
      throw new AtetCloudError("GENERATION_FAILED", "The Vercel AI Gateway request was rejected.");
    }
    const canonicalInput = canonicalGatewayInput(input, url);
    let response;
    try {
      response = await fetchImplementation(canonicalInput, {
        ...init,
        redirect: "error"
      });
    } catch (error) {
      if (error instanceof AtetCloudError)
        throw error;
      throw new AtetCloudError("GENERATION_FAILED", "Vercel AI Gateway image generation failed; the request was not retried.");
    }
    if (response.redirected || response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {
        return;
      });
      throw new AtetCloudError("GENERATION_FAILED", "The Vercel AI Gateway request was rejected.");
    }
    return boundedResponse(response, maximumResponseBytes);
  };
}
function combineSignals(caller, timeoutMs) {
  const controller = new AbortController;
  const abort = () => controller.abort(caller?.reason);
  let rejectInterruption;
  const interruption = new Promise((_resolve, reject) => {
    rejectInterruption = reject;
  });
  const rejectOnAbort = () => {
    rejectInterruption?.(new AtetCloudError("GENERATION_FAILED", "Vercel AI Gateway image generation was cancelled or exceeded its deadline."));
  };
  controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
  if (caller?.aborted === true)
    abort();
  caller?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    dispose: () => {
      clearTimeout(timer);
      caller?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", rejectOnAbort);
      rejectInterruption = undefined;
    },
    interruption,
    signal: controller.signal
  };
}
function mediaType(value) {
  if (typeof value !== "string" || !atetResponseMediaTypes.includes(value)) {
    throw new AtetCloudError("GENERATION_INVALID_RESPONSE", "Vercel AI Gateway returned an unsupported image type.");
  }
  return value;
}
function validImageBytes(bytes, type) {
  if (bytes.byteLength < 12 || bytes.byteLength > atetMaximumRawImageBytes) {
    return false;
  }
  if (type === "image/png") {
    return Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (type === "image/jpeg") {
    return bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
  }
  return bytes.byteLength >= 16 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(bytes).readUInt32LE(4) === bytes.byteLength - 8 && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(Buffer.from(bytes.subarray(12, 16)).toString("ascii"));
}
function warningReceipt(value) {
  let type = "provider-warning";
  let detail = "Provider warning";
  if (typeof value === "string") {
    detail = value;
  } else if (isObject(value)) {
    if (typeof value.type === "string" && value.type.length <= 64) {
      type = value.type.replace(/[^a-z0-9._-]/giu, "-") || type;
    }
    if (typeof value.message === "string")
      detail = value.message;
    else if (typeof value.details === "string")
      detail = value.details;
  }
  return `${type} sha256:${createHash("sha256").update(detail).digest("hex")}`;
}
function parseResult(value, model) {
  if (!isObject(value) || !Array.isArray(value.images) || value.images.length !== 1) {
    throw new AtetCloudError("GENERATION_INVALID_RESPONSE", "Vercel AI Gateway did not return exactly one image.");
  }
  const image = value.images[0];
  if (!isObject(image) || !(image.uint8Array instanceof Uint8Array)) {
    throw new AtetCloudError("GENERATION_INVALID_RESPONSE", "Vercel AI Gateway returned an invalid bounded image.");
  }
  const type = mediaType(image.mediaType);
  if (!validImageBytes(image.uint8Array, type)) {
    throw new AtetCloudError("GENERATION_INVALID_RESPONSE", "Vercel AI Gateway returned an invalid bounded image.");
  }
  const gateway = isObject(value.providerMetadata) && isObject(value.providerMetadata.gateway) ? value.providerMetadata.gateway : undefined;
  const foreignGenerationId = gateway !== undefined && typeof gateway.generationId === "string" && gateway.generationId.length > 0 && gateway.generationId.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(gateway.generationId) ? gateway.generationId : randomUUID();
  const requestId = `sha256:${createHash("sha256").update("transmute.gateway-generation-id/v1\x00").update(foreignGenerationId).digest("hex")}`;
  const warnings = Array.isArray(value.warnings) ? value.warnings.slice(0, 100).map(warningReceipt) : [];
  return {
    bytes: image.uint8Array,
    response: {
      image: {
        base64: Buffer.from(image.uint8Array).toString("base64"),
        mediaType: type
      },
      model,
      provider: "vercel-ai-gateway",
      requestId,
      warnings
    }
  };
}
async function performGeneration(input, dependencies) {
  const model = validateModel(input.model);
  const prompt = validatePrompt(input.prompt);
  const credential = resolveGatewayCredential(dependencies.environment);
  const timeout = combineSignals(input.signal, validateTimeout(input.timeoutMs));
  try {
    const generation = (async () => {
      assertGenerationActive(timeout.signal);
      disableAiSdkWarningLogging();
      const runtime = await (dependencies.loadRuntime ?? loadDefaultGatewayRuntime)();
      assertGenerationActive(timeout.signal);
      const provider = runtime.createGateway({
        apiKey: credential.token,
        baseURL: atetGatewayApiBaseUrl,
        fetch: createFixedGatewayFetch({
          ...dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch },
          ...dependencies.maximumResponseBytes === undefined ? {} : { maximumResponseBytes: dependencies.maximumResponseBytes }
        })
      });
      assertGenerationActive(timeout.signal);
      const generated = await runtime.generateImage({
        abortSignal: timeout.signal,
        maxRetries: 0,
        model: provider.imageModel(model),
        n: 1,
        prompt
      });
      return parseResult(generated, model);
    })();
    return await Promise.race([generation, timeout.interruption]);
  } catch (error) {
    if (error instanceof AtetCloudError)
      throw error;
    throw new AtetCloudError("GENERATION_FAILED", "Vercel AI Gateway image generation failed; the request was not retried.");
  } finally {
    timeout.dispose();
  }
}
async function generateAtetImage(input, dependencies = {}) {
  return (await performGeneration(input, dependencies)).response;
}
function expectedMediaType(outputPath) {
  const extension = extname(outputPath).toLocaleLowerCase("en-US");
  if (extension === ".png")
    return "image/png";
  if (extension === ".jpg" || extension === ".jpeg")
    return "image/jpeg";
  if (extension === ".webp")
    return "image/webp";
  invalidArgument("Output path must end in .png, .jpg, .jpeg, or .webp.");
}
async function atomicImageWrite(outputPath, bytes) {
  const absolutePath = resolve(outputPath);
  const temporaryPath = resolve(dirname(absolutePath), `.${randomUUID()}.atet-generate.tmp`);
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx" });
    await link(temporaryPath, absolutePath);
    return absolutePath;
  } catch {
    throw new AtetCloudError("OUTPUT_WRITE_FAILED", "Atet could not atomically write the generated image.");
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {
      return;
    });
  }
}
async function generateAtetImageFile(input, dependencies = {}) {
  if (typeof input.outputPath !== "string" || input.outputPath.length < 1 || input.outputPath.length > 4096 || input.outputPath.includes("\x00")) {
    invalidArgument("Output path must be a non-empty local path.");
  }
  const expected = expectedMediaType(input.outputPath);
  const generated = await performGeneration(input, dependencies);
  if (generated.response.image.mediaType !== expected) {
    throw new AtetCloudError("GENERATION_INVALID_RESPONSE", `Generated ${generated.response.image.mediaType} does not match the requested ${expected} output path.`);
  }
  const outputPath = await atomicImageWrite(input.outputPath, generated.bytes);
  return {
    bytes: generated.bytes.byteLength,
    mediaType: generated.response.image.mediaType,
    model: generated.response.model,
    outputPath,
    provider: generated.response.provider,
    requestId: generated.response.requestId,
    sha256: createHash("sha256").update(generated.bytes).digest("hex"),
    warnings: generated.response.warnings
  };
}
var transmuteGatewayApiBaseUrl = atetGatewayApiBaseUrl;
var transmuteImageModels = atetImageModels;
var transmuteResponseMediaTypes = atetResponseMediaTypes;
var transmuteMaximumPromptBytes = atetMaximumPromptBytes;
var transmuteMaximumRawImageBytes = atetMaximumRawImageBytes;
var transmuteGatewayCredentialStatus = atetGatewayCredentialStatus;
var generateTransmuteImage = generateAtetImage;
var generateTransmuteImageFile = generateAtetImageFile;

export { AtetCloudError, atetGatewayApiBaseUrl, atetImageModels, atetResponseMediaTypes, atetMaximumPromptBytes, atetMaximumRawImageBytes, atetGatewayCredentialStatus, createFixedGatewayFetch, generateAtetImage, generateAtetImageFile, transmuteGatewayApiBaseUrl, transmuteImageModels, transmuteResponseMediaTypes, transmuteMaximumPromptBytes, transmuteMaximumRawImageBytes, transmuteGatewayCredentialStatus, generateTransmuteImage, generateTransmuteImageFile };
