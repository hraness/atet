// @bun
// src/cloud-errors.ts
class TransmuteCloudError extends Error {
  code;
  constructor(code, message, options) {
    super(`[${code}] ${message}`, options);
    this.name = "TransmuteCloudError";
    this.code = code;
  }
}

// src/discovery.ts
var transmuteDiscoveryUrl = "https://transmute.rocks/.well-known/transmute-cli.json";
var transmuteRedirectUri = "http://127.0.0.1:49671/oauth/callback";
var transmuteProductionContract = Object.freeze({
  environment: "production",
  apiBaseUrl: "https://transmute.rocks/api/v1",
  operationsUrl: "https://transmute.rocks/api/v1/operations",
  issuer: "https://account.hraness.com",
  authorizationEndpoint: "https://account.hraness.com/api/auth/oauth2/authorize",
  tokenEndpoint: "https://account.hraness.com/api/auth/oauth2/token",
  revocationEndpoint: "https://account.hraness.com/api/auth/oauth2/revoke",
  clientId: "hraness:transmute-cli:production:v1",
  resource: "https://hraness.com/suite",
  generateImage: "https://transmute.rocks/api/v1/images/generate",
  maximumPromptBytes: 8192,
  maximumRawImageBytes: 3145728
});
var transmuteImageModels = Object.freeze([
  "openai/gpt-image-1.5",
  "recraft/recraft-v4.1-utility"
]);
var transmuteResponseMediaTypes = Object.freeze([
  "image/webp"
]);
var transmuteImageGenerationQuota = Object.freeze({
  accountDailyLimit: 10,
  globalDailySafetyLimit: 100,
  paymentEnforced: false,
  period: "utc-day"
});
var transmuteDesktopClientId = "transmute-cli";
var transmuteDesktopScopes = Object.freeze([
  "openid",
  "profile",
  "email"
]);
var transmuteDesktopEndpoints = Object.freeze({
  deviceAuthorization: "https://transmute.rocks/api/auth/device/code",
  deviceToken: "https://transmute.rocks/api/auth/device/token",
  session: "https://transmute.rocks/api/auth/get-session",
  signOut: "https://transmute.rocks/api/auth/revoke-session",
  convexToken: "https://transmute.rocks/api/auth/convex/token"
});
var transmuteDiscoveryMaximumBytes = 32 * 1024;
var transmuteMaximumPromptBytes = transmuteProductionContract.maximumPromptBytes;
var transmuteMaximumRawImageBytes = transmuteProductionContract.maximumRawImageBytes;
function invalidDiscovery() {
  throw new TransmuteCloudError("DISCOVERY_INVALID", "Transmute service discovery returned an invalid contract.");
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
  if (value.type !== "oauth2-authorization-code" || value.issuer !== transmuteProductionContract.issuer || value.authorizationEndpoint !== transmuteProductionContract.authorizationEndpoint || value.tokenEndpoint !== transmuteProductionContract.tokenEndpoint || value.revocationEndpoint !== transmuteProductionContract.revocationEndpoint || value.clientId !== transmuteProductionContract.clientId || value.redirectUri !== transmuteRedirectUri || value.resource !== transmuteProductionContract.resource || value.pkce !== "S256") {
    invalidDiscovery();
  }
  exactStringTuple(value.scopes, ["openid", "offline_access"]);
  return {
    type: "oauth2-authorization-code",
    issuer: transmuteProductionContract.issuer,
    authorizationEndpoint: transmuteProductionContract.authorizationEndpoint,
    tokenEndpoint: transmuteProductionContract.tokenEndpoint,
    revocationEndpoint: transmuteProductionContract.revocationEndpoint,
    clientId: transmuteProductionContract.clientId,
    redirectUri: transmuteRedirectUri,
    scopes: ["openid", "offline_access"],
    resource: transmuteProductionContract.resource,
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
  exactStringTuple(value.models, transmuteImageModels);
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
  if (value.quota.accountDailyLimit !== transmuteImageGenerationQuota.accountDailyLimit || value.quota.globalDailySafetyLimit !== transmuteImageGenerationQuota.globalDailySafetyLimit || value.quota.paymentEnforced !== transmuteImageGenerationQuota.paymentEnforced || value.quota.period !== transmuteImageGenerationQuota.period) {
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
    models: transmuteImageModels,
    maximumPromptBytes: positiveInteger(value.maximumPromptBytes, transmuteMaximumPromptBytes) === transmuteProductionContract.maximumPromptBytes ? transmuteProductionContract.maximumPromptBytes : invalidDiscovery(),
    maximumRawImageBytes: positiveInteger(value.maximumRawImageBytes, transmuteMaximumRawImageBytes) === transmuteProductionContract.maximumRawImageBytes ? transmuteProductionContract.maximumRawImageBytes : invalidDiscovery(),
    imagesPerRequest: 1,
    responseMediaTypes: ["image/webp"],
    quota: transmuteImageGenerationQuota,
    idempotency: {
      header: "Idempotency-Key",
      durable: true,
      scope: "suite-account"
    }
  };
}
function parseVectorize(value) {
  if (!isRecord(value))
    invalidDiscovery();
  exactKeys(value, ["access", "billing", "execution"]);
  if (value.access !== "local" || value.billing !== "free" || value.execution !== "local") {
    invalidDiscovery();
  }
  return {
    access: "local",
    billing: "free",
    execution: "local"
  };
}
function parseSceneDescribeEndpoint(value) {
  if (typeof value !== "string" || value.length > 2048)
    invalidDiscovery();
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    return invalidDiscovery();
  }
  if (endpoint.protocol !== "https:" || endpoint.username !== "" || endpoint.password !== "" || endpoint.port !== "" || endpoint.search !== "" || endpoint.hash !== "" || endpoint.pathname !== "/api/v1/scenes/describe" || !endpoint.hostname.endsWith(".convex.site")) {
    invalidDiscovery();
  }
  return endpoint.href;
}
function parseDesktop(value) {
  if (!isRecord(value))
    invalidDiscovery();
  if (value.availability === "unavailable") {
    exactKeys(value, ["availability"]);
    return { availability: "unavailable" };
  }
  if (value.availability !== "available")
    invalidDiscovery();
  exactKeys(value, ["availability", "clientId", "scopes", "endpoints"]);
  if (value.clientId !== transmuteDesktopClientId)
    invalidDiscovery();
  exactStringTuple(value.scopes, transmuteDesktopScopes);
  if (!isRecord(value.endpoints))
    invalidDiscovery();
  exactKeys(value.endpoints, [
    "deviceAuthorization",
    "deviceToken",
    "session",
    "signOut",
    "convexToken",
    "sceneDescribe"
  ]);
  if (value.endpoints.deviceAuthorization !== transmuteDesktopEndpoints.deviceAuthorization || value.endpoints.deviceToken !== transmuteDesktopEndpoints.deviceToken || value.endpoints.session !== transmuteDesktopEndpoints.session || value.endpoints.signOut !== transmuteDesktopEndpoints.signOut || value.endpoints.convexToken !== transmuteDesktopEndpoints.convexToken) {
    invalidDiscovery();
  }
  return {
    availability: "available",
    clientId: transmuteDesktopClientId,
    scopes: transmuteDesktopScopes,
    endpoints: {
      deviceAuthorization: transmuteDesktopEndpoints.deviceAuthorization,
      deviceToken: transmuteDesktopEndpoints.deviceToken,
      session: transmuteDesktopEndpoints.session,
      signOut: transmuteDesktopEndpoints.signOut,
      convexToken: transmuteDesktopEndpoints.convexToken,
      sceneDescribe: parseSceneDescribeEndpoint(value.endpoints.sceneDescribe)
    }
  };
}
function parseMedia(value) {
  if (!isRecord(value))
    invalidDiscovery();
  exactKeys(value, [
    "apiBaseUrl",
    "operationsUrl",
    "authorization",
    "endpoints",
    "imageGeneration",
    "vectorize"
  ]);
  if (!isRecord(value.endpoints))
    invalidDiscovery();
  exactKeys(value.endpoints, ["generateImage"]);
  return {
    apiBaseUrl: value.apiBaseUrl === transmuteProductionContract.apiBaseUrl ? transmuteProductionContract.apiBaseUrl : invalidDiscovery(),
    operationsUrl: value.operationsUrl === transmuteProductionContract.operationsUrl ? transmuteProductionContract.operationsUrl : invalidDiscovery(),
    authorization: parseAuthorization(value.authorization),
    endpoints: {
      generateImage: value.endpoints.generateImage === transmuteProductionContract.generateImage ? transmuteProductionContract.generateImage : invalidDiscovery()
    },
    imageGeneration: parseImageGeneration(value.imageGeneration),
    vectorize: parseVectorize(value.vectorize)
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
function parseTransmuteDiscovery(value) {
  if (!isRecord(value))
    invalidDiscovery();
  exactKeys(value, [
    "schemaVersion",
    "product",
    "environment",
    "capabilities"
  ]);
  if (value.schemaVersion !== 2 || value.product !== "transmute") {
    invalidDiscovery();
  }
  if (!isRecord(value.capabilities))
    invalidDiscovery();
  exactKeys(value.capabilities, ["media", "desktop"]);
  return deepFreeze({
    schemaVersion: 2,
    product: "transmute",
    environment: value.environment === transmuteProductionContract.environment ? transmuteProductionContract.environment : invalidDiscovery(),
    capabilities: {
      media: parseMedia(value.capabilities.media),
      desktop: parseDesktop(value.capabilities.desktop)
    }
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
async function fetchTransmuteDiscovery(fetchImplementation = fetch) {
  const unavailable = new TransmuteCloudError("DISCOVERY_UNAVAILABLE", "Transmute service discovery is unavailable.");
  let response;
  try {
    response = await fetchImplementation(transmuteDiscoveryUrl, {
      headers: {
        accept: "application/json",
        "user-agent": "hraness-transmute-cli/0.6.0"
      },
      redirect: "error",
      signal: AbortSignal.timeout(1e4)
    });
  } catch (cause) {
    throw new TransmuteCloudError("DISCOVERY_UNAVAILABLE", "Transmute service discovery is unavailable.", { cause });
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
    throw new TransmuteCloudError("DISCOVERY_INVALID", "Transmute service discovery returned an invalid content type.");
  }
  const value = await readBoundedJson(response, transmuteDiscoveryMaximumBytes, new TransmuteCloudError("DISCOVERY_INVALID", "Transmute service discovery returned an invalid contract."));
  return parseTransmuteDiscovery(value);
}

export { TransmuteCloudError, transmuteDiscoveryUrl, transmuteRedirectUri, transmuteProductionContract, transmuteImageModels, transmuteResponseMediaTypes, transmuteImageGenerationQuota, transmuteDesktopClientId, transmuteDesktopScopes, transmuteDesktopEndpoints, transmuteDiscoveryMaximumBytes, transmuteMaximumPromptBytes, transmuteMaximumRawImageBytes, parseTransmuteDiscovery, readBoundedResponseBytes, readBoundedJson, fetchTransmuteDiscovery };
