// @bun
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
var graphicsImageGenerationQuota = Object.freeze({
  accountDailyLimit: 10,
  globalDailySafetyLimit: 100,
  paymentEnforced: false,
  period: "utc-day"
});
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
    "access",
    "billing",
    "models",
    "maximumPromptBytes",
    "maximumRawImageBytes",
    "imagesPerRequest",
    "responseMediaTypes",
    "quota",
    "idempotency"
  ]);
  if (value.access !== "authenticated" || value.billing !== "free-preview") {
    invalidDiscovery();
  }
  exactStringTuple(value.models, graphicsImageModels);
  if (value.imagesPerRequest !== 1)
    invalidDiscovery();
  exactStringTuple(value.responseMediaTypes, ["image/webp"]);
  if (!isRecord(value.quota))
    invalidDiscovery();
  exactKeys(value.quota, [
    "accountDailyLimit",
    "globalDailySafetyLimit",
    "paymentEnforced",
    "period"
  ]);
  if (value.quota.accountDailyLimit !== graphicsImageGenerationQuota.accountDailyLimit || value.quota.globalDailySafetyLimit !== graphicsImageGenerationQuota.globalDailySafetyLimit || value.quota.paymentEnforced !== graphicsImageGenerationQuota.paymentEnforced || value.quota.period !== graphicsImageGenerationQuota.period) {
    invalidDiscovery();
  }
  if (!isRecord(value.idempotency))
    invalidDiscovery();
  exactKeys(value.idempotency, ["header", "durable", "scope"]);
  if (value.idempotency.header !== "Idempotency-Key" || value.idempotency.durable !== true || value.idempotency.scope !== "suite-account") {
    invalidDiscovery();
  }
  return {
    access: "authenticated",
    billing: "free-preview",
    models: graphicsImageModels,
    maximumPromptBytes: positiveInteger(value.maximumPromptBytes, graphicsMaximumPromptBytes) === graphicsProductionContract.maximumPromptBytes ? graphicsProductionContract.maximumPromptBytes : invalidDiscovery(),
    maximumRawImageBytes: positiveInteger(value.maximumRawImageBytes, graphicsMaximumRawImageBytes) === graphicsProductionContract.maximumRawImageBytes ? graphicsProductionContract.maximumRawImageBytes : invalidDiscovery(),
    imagesPerRequest: 1,
    responseMediaTypes: ["image/webp"],
    quota: graphicsImageGenerationQuota,
    idempotency: {
      header: "Idempotency-Key",
      durable: true,
      scope: "suite-account"
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
export {
  readBoundedResponseBytes,
  readBoundedJson,
  parseGraphicsDiscovery,
  graphicsResponseMediaTypes,
  graphicsRedirectUri,
  graphicsProductionContract,
  graphicsMaximumRawImageBytes,
  graphicsMaximumPromptBytes,
  graphicsImageModels,
  graphicsImageGenerationQuota,
  graphicsDiscoveryUrl,
  graphicsDiscoveryMaximumBytes,
  fetchGraphicsDiscovery
};
