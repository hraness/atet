// @bun
// src/generate.ts
import { randomUUID } from "crypto";
import { rename, rm, writeFile } from "fs/promises";
import { dirname, resolve } from "path";

// src/cloud-errors.ts
class GraphicsCloudError extends Error {
  code;
  constructor(code, message, options) {
    super(`[${code}] ${message}`, options);
    this.name = "GraphicsCloudError";
    this.code = code;
  }
}

// src/discovery.ts
var graphicsDiscoveryUrl = "https://hraness.graphics/.well-known/graphics-cli.json";
var graphicsRedirectUri = "http://127.0.0.1:49671/oauth/callback";
var graphicsProductionContract = Object.freeze({
  environment: "production",
  apiBaseUrl: "https://hraness.graphics/api/v1",
  operationsUrl: "https://hraness.graphics/api/v1/operations",
  issuer: "https://account.hraness.com",
  authorizationEndpoint: "https://account.hraness.com/api/auth/oauth2/authorize",
  tokenEndpoint: "https://account.hraness.com/api/auth/oauth2/token",
  revocationEndpoint: "https://account.hraness.com/api/auth/oauth2/revoke",
  clientId: "hraness:graphics:production:v1",
  resource: "https://hraness.com/suite",
  generateImage: "https://hraness.graphics/api/v1/images/generate",
  maximumPromptBytes: 8192,
  maximumRawImageBytes: 3145728
});
var graphicsImageModels = Object.freeze([
  "openai/gpt-image-1.5",
  "recraft/recraft-v4.1-utility"
]);
var graphicsResponseMediaTypes = Object.freeze([
  "image/webp"
]);
var graphicsDiscoveryMaximumBytes = 32 * 1024;
var graphicsMaximumPromptBytes = graphicsProductionContract.maximumPromptBytes;
var graphicsMaximumRawImageBytes = graphicsProductionContract.maximumRawImageBytes;
function invalidDiscovery() {
  throw new GraphicsCloudError("DISCOVERY_INVALID", "Graphics service discovery returned an invalid contract.");
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    invalidDiscovery();
  }
}
function positiveInteger(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    invalidDiscovery();
  }
  return value;
}
function exactStringTuple(value, expected) {
  if (!Array.isArray(value) || value.length !== expected.length || value.some((entry, index) => entry !== expected[index])) {
    invalidDiscovery();
  }
}
function parseAuthorization(value) {
  if (!isRecord(value))
    invalidDiscovery();
  exactKeys(value, [
    "type",
    "issuer",
    "authorizationEndpoint",
    "tokenEndpoint",
    "revocationEndpoint",
    "clientId",
    "redirectUri",
    "scopes",
    "resource",
    "pkce"
  ]);
  if (value.type !== "oauth2-authorization-code" || value.issuer !== graphicsProductionContract.issuer || value.authorizationEndpoint !== graphicsProductionContract.authorizationEndpoint || value.tokenEndpoint !== graphicsProductionContract.tokenEndpoint || value.revocationEndpoint !== graphicsProductionContract.revocationEndpoint || value.clientId !== graphicsProductionContract.clientId || value.redirectUri !== graphicsRedirectUri || value.resource !== graphicsProductionContract.resource || value.pkce !== "S256") {
    invalidDiscovery();
  }
  exactStringTuple(value.scopes, ["openid", "offline_access"]);
  return {
    type: "oauth2-authorization-code",
    issuer: graphicsProductionContract.issuer,
    authorizationEndpoint: graphicsProductionContract.authorizationEndpoint,
    tokenEndpoint: graphicsProductionContract.tokenEndpoint,
    revocationEndpoint: graphicsProductionContract.revocationEndpoint,
    clientId: graphicsProductionContract.clientId,
    redirectUri: graphicsRedirectUri,
    scopes: ["openid", "offline_access"],
    resource: graphicsProductionContract.resource,
    pkce: "S256"
  };
}
function parseImageGeneration(value) {
  if (!isRecord(value))
    invalidDiscovery();
  exactKeys(value, [
    "models",
    "maximumPromptBytes",
    "maximumRawImageBytes",
    "imagesPerRequest",
    "responseMediaTypes",
    "idempotency"
  ]);
  exactStringTuple(value.models, graphicsImageModels);
  if (value.imagesPerRequest !== 1)
    invalidDiscovery();
  exactStringTuple(value.responseMediaTypes, ["image/webp"]);
  if (!isRecord(value.idempotency))
    invalidDiscovery();
  exactKeys(value.idempotency, ["header", "durable", "scope"]);
  if (value.idempotency.header !== "Idempotency-Key" || value.idempotency.durable !== false || value.idempotency.scope !== "process-local-mvp") {
    invalidDiscovery();
  }
  return {
    models: graphicsImageModels,
    maximumPromptBytes: positiveInteger(value.maximumPromptBytes, graphicsMaximumPromptBytes) === graphicsProductionContract.maximumPromptBytes ? graphicsProductionContract.maximumPromptBytes : invalidDiscovery(),
    maximumRawImageBytes: positiveInteger(value.maximumRawImageBytes, graphicsMaximumRawImageBytes) === graphicsProductionContract.maximumRawImageBytes ? graphicsProductionContract.maximumRawImageBytes : invalidDiscovery(),
    imagesPerRequest: 1,
    responseMediaTypes: ["image/webp"],
    idempotency: {
      header: "Idempotency-Key",
      durable: false,
      scope: "process-local-mvp"
    }
  };
}
function parseFeatures(value) {
  if (!isRecord(value))
    invalidDiscovery();
  exactKeys(value, ["vectorize"]);
  if (!isRecord(value.vectorize))
    invalidDiscovery();
  exactKeys(value.vectorize, ["access", "billing", "execution"]);
  if (value.vectorize.access !== "authenticated" || value.vectorize.billing !== "free" || value.vectorize.execution !== "local") {
    invalidDiscovery();
  }
  return {
    vectorize: {
      access: "authenticated",
      billing: "free",
      execution: "local"
    }
  };
}
function deepFreeze(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value))
    deepFreeze(nested);
  return Object.freeze(value);
}
function parseGraphicsDiscovery(value) {
  if (!isRecord(value))
    invalidDiscovery();
  exactKeys(value, [
    "schemaVersion",
    "product",
    "environment",
    "apiBaseUrl",
    "operationsUrl",
    "authorization",
    "endpoints",
    "imageGeneration",
    "features"
  ]);
  if (value.schemaVersion !== 1 || value.product !== "graphics") {
    invalidDiscovery();
  }
  if (!isRecord(value.endpoints))
    invalidDiscovery();
  exactKeys(value.endpoints, ["generateImage"]);
  return deepFreeze({
    schemaVersion: 1,
    product: "graphics",
    environment: value.environment === graphicsProductionContract.environment ? graphicsProductionContract.environment : invalidDiscovery(),
    apiBaseUrl: value.apiBaseUrl === graphicsProductionContract.apiBaseUrl ? graphicsProductionContract.apiBaseUrl : invalidDiscovery(),
    operationsUrl: value.operationsUrl === graphicsProductionContract.operationsUrl ? graphicsProductionContract.operationsUrl : invalidDiscovery(),
    authorization: parseAuthorization(value.authorization),
    endpoints: {
      generateImage: value.endpoints.generateImage === graphicsProductionContract.generateImage ? graphicsProductionContract.generateImage : invalidDiscovery()
    },
    imageGeneration: parseImageGeneration(value.imageGeneration),
    features: parseFeatures(value.features)
  });
}
async function readBoundedResponseBytes(response, maximumBytes, error) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength) || Number(contentLength) > maximumBytes)) {
    await response.body?.cancel().catch(() => {
      return;
    });
    throw error;
  }
  if (response.body === null)
    return new Uint8Array;
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;; ) {
      const next = await reader.read();
      if (next.done)
        break;
      length += next.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw error;
      }
      chunks.push(next.value);
    }
  } catch (caught) {
    if (caught === error)
      throw caught;
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
async function readBoundedJson(response, maximumBytes, error) {
  const bytes = await readBoundedResponseBytes(response, maximumBytes, error);
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    throw error;
  }
}
async function fetchGraphicsDiscovery(fetchImplementation = fetch) {
  const unavailable = new GraphicsCloudError("DISCOVERY_UNAVAILABLE", "Graphics service discovery is unavailable.");
  let response;
  try {
    response = await fetchImplementation(graphicsDiscoveryUrl, {
      headers: {
        accept: "application/json",
        "user-agent": "hraness-graphics-cli/0.4.0"
      },
      redirect: "error",
      signal: AbortSignal.timeout(1e4)
    });
  } catch (cause) {
    throw new GraphicsCloudError("DISCOVERY_UNAVAILABLE", "Graphics service discovery is unavailable.", { cause });
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {
      return;
    });
    throw unavailable;
  }
  const contentType = response.headers.get("content-type");
  if (contentType === null || !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/iu.test(contentType)) {
    await response.body?.cancel().catch(() => {
      return;
    });
    throw new GraphicsCloudError("DISCOVERY_INVALID", "Graphics service discovery returned an invalid content type.");
  }
  const value = await readBoundedJson(response, graphicsDiscoveryMaximumBytes, new GraphicsCloudError("DISCOVERY_INVALID", "Graphics service discovery returned an invalid contract."));
  return parseGraphicsDiscovery(value);
}

// src/auth.ts
var graphicsSecretsService = "com.hraness.graphics.cli";
var graphicsSecretsName = "oauth2-tokens";
var tokenResponseMaximumBytes = 64 * 1024;
var storedCredentialMaximumBytes = 64 * 1024;
var maximumTokenLength = 16 * 1024;
var expirySkewMilliseconds = 60000;
var maximumExpiresInSeconds = 365 * 24 * 60 * 60;
function secretStore(dependencies) {
  return dependencies.secrets ?? Bun.secrets;
}
function boundedToken(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumTokenLength || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new GraphicsCloudError("TOKEN_EXCHANGE_FAILED", "Graphics rejected the authorization token response.");
  }
  return value;
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseStoredCredentials(value) {
  if (Buffer.byteLength(value, "utf8") > storedCredentialMaximumBytes) {
    throw new GraphicsCloudError("TOKEN_STORAGE_FAILED", "Stored Graphics credentials are invalid.");
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new GraphicsCloudError("TOKEN_STORAGE_FAILED", "Stored Graphics credentials are invalid.");
  }
  if (!isRecord2(parsed) || parsed.schemaVersion !== 1 || typeof parsed.issuer !== "string" || parsed.issuer.length > 2048 || typeof parsed.clientId !== "string" || parsed.clientId.length > 256 || typeof parsed.resource !== "string" || parsed.resource.length > 2048 || !Number.isSafeInteger(parsed.expiresAt) || parsed.expiresAt < 0 || parsed.expiresAt > 8640000000000000) {
    throw new GraphicsCloudError("TOKEN_STORAGE_FAILED", "Stored Graphics credentials are invalid.");
  }
  let accessToken;
  let refreshToken;
  try {
    accessToken = boundedToken(parsed.accessToken);
    refreshToken = parsed.refreshToken === undefined ? undefined : boundedToken(parsed.refreshToken);
  } catch (cause) {
    throw new GraphicsCloudError("TOKEN_STORAGE_FAILED", "Stored Graphics credentials are invalid.", { cause });
  }
  const keys = Object.keys(parsed);
  if (keys.some((key) => ![
    "schemaVersion",
    "issuer",
    "clientId",
    "resource",
    "accessToken",
    "refreshToken",
    "expiresAt"
  ].includes(key))) {
    throw new GraphicsCloudError("TOKEN_STORAGE_FAILED", "Stored Graphics credentials are invalid.");
  }
  return {
    schemaVersion: 1,
    issuer: parsed.issuer,
    clientId: parsed.clientId,
    resource: parsed.resource,
    accessToken,
    ...refreshToken === undefined ? {} : { refreshToken },
    expiresAt: parsed.expiresAt
  };
}
async function loadCredentials(dependencies) {
  let stored;
  try {
    stored = await secretStore(dependencies).get({
      service: graphicsSecretsService,
      name: graphicsSecretsName
    });
  } catch (cause) {
    throw new GraphicsCloudError("TOKEN_STORAGE_FAILED", "Graphics could not read credentials from the operating-system credential store.", { cause });
  }
  return stored === null ? null : parseStoredCredentials(stored);
}
async function storeCredentials(credentials, dependencies) {
  const value = JSON.stringify(credentials);
  if (Buffer.byteLength(value, "utf8") > storedCredentialMaximumBytes) {
    throw new GraphicsCloudError("TOKEN_STORAGE_FAILED", "Graphics credentials exceed the credential-store limit.");
  }
  try {
    await secretStore(dependencies).set({
      service: graphicsSecretsService,
      name: graphicsSecretsName,
      value
    });
  } catch (cause) {
    throw new GraphicsCloudError("TOKEN_STORAGE_FAILED", "Graphics could not write credentials to the operating-system credential store.", { cause });
  }
}
async function tokenRequest(discovery, body, failureCode, dependencies) {
  const failure = new GraphicsCloudError(failureCode, failureCode === "TOKEN_EXCHANGE_FAILED" ? "Graphics could not exchange the authorization code." : "Graphics could not refresh the login.");
  let response;
  try {
    response = await (dependencies.fetch ?? fetch)(discovery.authorization.tokenEndpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "hraness-graphics-cli/0.4.0"
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(15000)
    });
  } catch (cause) {
    throw new GraphicsCloudError(failureCode, failure.message.slice(failure.message.indexOf("]") + 2), {
      cause
    });
  }
  const contentType = response.headers.get("content-type");
  if (contentType === null || !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/iu.test(contentType)) {
    await response.body?.cancel().catch(() => {
      return;
    });
    throw failure;
  }
  const bytes = await readBoundedResponseBytes(response, tokenResponseMaximumBytes, failure);
  if (!response.ok)
    throw failure;
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw failure;
  }
  if (!isRecord2(value) || typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer" || !Number.isSafeInteger(value.expires_in) || value.expires_in < 1 || value.expires_in > maximumExpiresInSeconds) {
    throw failure;
  }
  let accessToken;
  let refreshToken;
  try {
    accessToken = boundedToken(value.access_token);
    refreshToken = value.refresh_token === undefined ? undefined : boundedToken(value.refresh_token);
  } catch {
    throw failure;
  }
  return {
    accessToken,
    ...refreshToken === undefined ? {} : { refreshToken },
    expiresIn: value.expires_in
  };
}
function credentialsFromToken(discovery, token, now, retainedRefreshToken) {
  const refreshToken = token.refreshToken ?? retainedRefreshToken;
  return {
    schemaVersion: 1,
    issuer: discovery.authorization.issuer,
    clientId: discovery.authorization.clientId,
    resource: discovery.authorization.resource,
    accessToken: token.accessToken,
    ...refreshToken === undefined ? {} : { refreshToken },
    expiresAt: now + token.expiresIn * 1000
  };
}
var refreshes = new WeakMap;
async function refreshAccessToken(discovery, credentials, dependencies) {
  const refreshToken = credentials.refreshToken;
  if (refreshToken === undefined) {
    throw new GraphicsCloudError("AUTH_REQUIRED", "Graphics login is missing or expired. Run `graphics login`.");
  }
  const store = secretStore(dependencies);
  const active = refreshes.get(store);
  if (active !== undefined)
    return active;
  const operation = (async () => {
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: discovery.authorization.clientId,
      resource: discovery.authorization.resource
    });
    const token = await tokenRequest(discovery, form, "TOKEN_REFRESH_FAILED", dependencies);
    const next = credentialsFromToken(discovery, token, (dependencies.now ?? Date.now)(), refreshToken);
    await storeCredentials(next, dependencies);
    return next.accessToken;
  })();
  refreshes.set(store, operation);
  try {
    return await operation;
  } finally {
    if (refreshes.get(store) === operation)
      refreshes.delete(store);
  }
}
async function getGraphicsAccessToken(discovery, dependencies = {}) {
  const trustedDiscovery = parseGraphicsDiscovery(discovery);
  const credentials = await loadCredentials(dependencies);
  if (credentials === null || credentials.issuer !== trustedDiscovery.authorization.issuer || credentials.clientId !== trustedDiscovery.authorization.clientId || credentials.resource !== trustedDiscovery.authorization.resource) {
    throw new GraphicsCloudError("AUTH_REQUIRED", "Graphics login is missing or expired. Run `graphics login`.");
  }
  const now = (dependencies.now ?? Date.now)();
  if (credentials.expiresAt > now + expirySkewMilliseconds) {
    return credentials.accessToken;
  }
  return refreshAccessToken(trustedDiscovery, credentials, dependencies);
}

// src/generate.ts
var maximumIdempotencyKeyLength = 128;
var minimumIdempotencyKeyLength = 16;
var responseEnvelopeAllowanceBytes = 8 * 1024;
function invalidArgument(message) {
  throw new GraphicsCloudError("INVALID_ARGUMENT", message);
}
function validateGraphicsIdempotencyKey(value) {
  if (value.length < minimumIdempotencyKeyLength || value.length > maximumIdempotencyKeyLength || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) {
    invalidArgument("Idempotency key must be 16\u2013128 characters using letters, digits, `.`, `_`, `:`, or `-`.");
  }
  return value;
}
function validateInput(input, discovery) {
  if (!graphicsImageModels.includes(input.model)) {
    invalidArgument(`Model must be ${graphicsImageModels[0]} or ${graphicsImageModels[1]}.`);
  }
  if (typeof input.prompt !== "string" || input.prompt.trim().length === 0 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.prompt) || Buffer.byteLength(input.prompt, "utf8") > discovery.imageGeneration.maximumPromptBytes) {
    invalidArgument(`Prompt must be non-empty and no more than ${discovery.imageGeneration.maximumPromptBytes} UTF-8 bytes.`);
  }
  const idempotencyKey = validateGraphicsIdempotencyKey(input.idempotencyKey ?? randomUUID());
  return {
    idempotencyKey,
    requestBody: JSON.stringify({
      model: input.model,
      prompt: input.prompt
    })
  };
}
function isRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys2(value, expected) {
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
function parseGeneratedGraphicsImage(value, discovery, requestedModel) {
  const trustedDiscovery = parseGraphicsDiscovery(discovery);
  const invalid = new GraphicsCloudError("GENERATION_INVALID_RESPONSE", "Graphics image generation returned an invalid bounded image.");
  if (!isRecord3(value) || !exactKeys2(value, ["apiVersion", "image", "model", "requestId"]) || value.apiVersion !== "v1" || value.model !== requestedModel || typeof value.requestId !== "string" || value.requestId.length < 1 || value.requestId.length > 256 || /[\u0000-\u001f\u007f]/u.test(value.requestId) || !isRecord3(value.image) || !exactKeys2(value.image, ["base64", "mediaType"]) || typeof value.image.base64 !== "string" || !isCanonicalBase64(value.image.base64) || typeof value.image.mediaType !== "string" || !graphicsResponseMediaTypes.includes(value.image.mediaType) || value.image.mediaType !== trustedDiscovery.imageGeneration.responseMediaTypes[0]) {
    throw invalid;
  }
  const bytes = Buffer.from(value.image.base64, "base64");
  if (bytes.byteLength < 1 || bytes.byteLength > trustedDiscovery.imageGeneration.maximumRawImageBytes || bytes.toString("base64") !== value.image.base64 || !hasExpectedMagic(bytes, value.image.mediaType)) {
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
  const discovery = dependencies.discovery === undefined ? await fetchGraphicsDiscovery(dependencies.fetch) : parseGraphicsDiscovery(dependencies.discovery);
  const { idempotencyKey, requestBody } = validateInput(input, discovery);
  const accessToken = await getGraphicsAccessToken(discovery, dependencies);
  const maximumResponseBytes = Math.ceil(discovery.imageGeneration.maximumRawImageBytes / 3) * 4 + responseEnvelopeAllowanceBytes;
  const failed = new GraphicsCloudError("GENERATION_FAILED", "Graphics image generation failed; the request was not retried.");
  let response;
  try {
    response = await (dependencies.fetch ?? fetch)(discovery.endpoints.generateImage, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        [discovery.imageGeneration.idempotency.header]: idempotencyKey,
        "user-agent": "hraness-graphics-cli/0.4.0"
      },
      body: requestBody,
      redirect: "error",
      signal: AbortSignal.timeout(120000)
    });
  } catch (cause) {
    throw new GraphicsCloudError("GENERATION_FAILED", "Graphics image generation failed; the request was not retried.", { cause });
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
    throw new GraphicsCloudError("GENERATION_INVALID_RESPONSE", "Graphics image generation returned invalid JSON.");
  }
  const parsed = parseGeneratedGraphicsImage(value, discovery, input.model);
  return { ...parsed, idempotencyKey };
}
async function generateGraphicsImage(input, dependencies = {}) {
  const generated = await performGeneration(input, dependencies);
  return { ...generated.response, idempotencyKey: generated.idempotencyKey };
}
async function atomicImageWrite(outputPath, bytes) {
  const absolutePath = resolve(outputPath);
  const temporaryPath = resolve(dirname(absolutePath), `.${randomUUID()}.graphics-generate.tmp`);
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx" });
    await rename(temporaryPath, absolutePath);
    return absolutePath;
  } catch (cause) {
    throw new GraphicsCloudError("OUTPUT_WRITE_FAILED", "Graphics could not atomically write the generated image.", { cause });
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {
      return;
    });
  }
}
async function generateGraphicsImageFile(input, dependencies = {}) {
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
export {
  validateGraphicsIdempotencyKey,
  generateGraphicsImageFile,
  generateGraphicsImage
};
