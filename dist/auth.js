// @bun
// src/auth.ts
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { createServer } from "http";

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
var callbackPort = 49671;
var callbackPath = "/oauth/callback";
var callbackMaximumRequests = 32;
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
async function deleteCredentials(dependencies) {
  try {
    return await secretStore(dependencies).delete({
      service: graphicsSecretsService,
      name: graphicsSecretsName
    });
  } catch (cause) {
    throw new GraphicsCloudError("TOKEN_STORAGE_FAILED", "Graphics could not remove credentials from the operating-system credential store.", { cause });
  }
}
function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}
function createPkcePair() {
  const verifier = base64Url(randomBytes(32));
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return { verifier, challenge };
}
function buildGraphicsAuthorizationUrl(discovery, state, challenge) {
  const trustedDiscovery = parseGraphicsDiscovery(discovery);
  if (state.length < 32 || state.length > 256 || challenge.length !== 43 || !/^[A-Za-z0-9_-]+$/u.test(state) || !/^[A-Za-z0-9_-]+$/u.test(challenge)) {
    throw new GraphicsCloudError("INVALID_ARGUMENT", "Invalid OAuth state or PKCE challenge.");
  }
  const url = new URL(trustedDiscovery.authorization.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", trustedDiscovery.authorization.clientId);
  url.searchParams.set("redirect_uri", graphicsRedirectUri);
  url.searchParams.set("scope", trustedDiscovery.authorization.scopes.join(" "));
  url.searchParams.set("resource", trustedDiscovery.authorization.resource);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.href;
}
function safeEqual(left, right) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}
function callbackPage(success) {
  return [
    "<!doctype html>",
    '<meta charset="utf-8">',
    `<title>Graphics ${success ? "login complete" : "login failed"}</title>`,
    `<p>Graphics login ${success ? "is complete. You can close this window." : "could not be completed. Return to the terminal."}</p>`
  ].join("");
}
async function closeServer(server) {
  if (!server.listening)
    return;
  await new Promise((resolve) => {
    server.close(() => resolve());
  });
}
async function startAuthorizationCallback(expectedState, timeoutMilliseconds) {
  let resolveCode;
  let rejectCode;
  let settled = false;
  let requestCount = 0;
  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = createServer((request, response) => {
    requestCount += 1;
    response.setHeader("connection", "close");
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (requestCount > callbackMaximumRequests) {
      response.statusCode = 429;
      response.end(callbackPage(false));
      if (!settled) {
        settled = true;
        rejectCode(new GraphicsCloudError("AUTHORIZATION_FAILED", "Graphics login received too many invalid callback requests."));
      }
      return;
    }
    if (request.method !== "GET" || request.headers.host !== `127.0.0.1:${callbackPort}`) {
      response.statusCode = 404;
      response.end(callbackPage(false));
      return;
    }
    let url;
    try {
      if ((request.url?.length ?? 0) > 8192)
        throw new Error("oversized callback");
      url = new URL(request.url ?? "", graphicsRedirectUri);
    } catch {
      response.statusCode = 400;
      response.end(callbackPage(false));
      return;
    }
    if (url.pathname !== callbackPath) {
      response.statusCode = 404;
      response.end(callbackPage(false));
      return;
    }
    const states = url.searchParams.getAll("state");
    if (states.length !== 1 || states[0] === undefined || states[0].length > 256 || !safeEqual(states[0], expectedState)) {
      response.statusCode = 400;
      response.end(callbackPage(false));
      return;
    }
    const oauthErrors = url.searchParams.getAll("error");
    if (oauthErrors.length > 0) {
      response.statusCode = 400;
      response.end(callbackPage(false));
      if (!settled) {
        settled = true;
        rejectCode(new GraphicsCloudError("AUTHORIZATION_FAILED", "Graphics authorization was denied or failed."));
      }
      return;
    }
    const codes = url.searchParams.getAll("code");
    const code = codes[0];
    if (codes.length !== 1 || code === undefined || code.length < 1 || code.length > 4096 || /[\u0000-\u0020\u007f]/u.test(code)) {
      response.statusCode = 400;
      response.end(callbackPage(false));
      return;
    }
    response.statusCode = 200;
    response.end(callbackPage(true));
    if (!settled) {
      settled = true;
      resolveCode(code);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(callbackPort, "127.0.0.1", () => resolve());
  }).catch((cause) => {
    throw new GraphicsCloudError("AUTH_CALLBACK_UNAVAILABLE", `Graphics login requires ${graphicsRedirectUri}, but the loopback callback could not start.`, { cause });
  });
  const timeout = setTimeout(() => {
    if (settled)
      return;
    settled = true;
    rejectCode(new GraphicsCloudError("AUTH_TIMEOUT", "Graphics login timed out before authorization completed."));
  }, timeoutMilliseconds);
  let closed = false;
  const close = async () => {
    if (closed)
      return;
    closed = true;
    clearTimeout(timeout);
    if (!settled) {
      settled = true;
      rejectCode(new GraphicsCloudError("AUTHORIZATION_FAILED", "Graphics login was cancelled before authorization completed."));
    }
    server.closeIdleConnections();
    server.closeAllConnections();
    await closeServer(server);
  };
  return { code: codePromise, close };
}
async function defaultOpenUrl(url) {
  const command = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["rundll32", "url.dll,FileProtocolHandler", url] : ["xdg-open", url];
  let subprocess;
  try {
    subprocess = Bun.spawn(command, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore"
    });
  } catch (cause) {
    throw new GraphicsCloudError("AUTHORIZATION_FAILED", "Graphics could not open the authorization page.", { cause });
  }
  const exitCode = await Promise.race([
    subprocess.exited,
    Bun.sleep(1e4).then(() => null)
  ]);
  if (exitCode === null) {
    subprocess.kill();
    await subprocess.exited.catch(() => {
      return;
    });
  }
  if (exitCode !== 0) {
    throw new GraphicsCloudError("AUTHORIZATION_FAILED", "Graphics could not open the authorization page.");
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
async function loginGraphics(dependencies = {}) {
  const discovery = await fetchGraphicsDiscovery(dependencies.fetch);
  const { verifier, challenge } = createPkcePair();
  const state = base64Url(randomBytes(32));
  const callback = await startAuthorizationCallback(state, 5 * 60000);
  callback.code.catch(() => {
    return;
  });
  const authorizationUrl = buildGraphicsAuthorizationUrl(discovery, state, challenge);
  try {
    const launch = (async () => {
      try {
        await (dependencies.openUrl ?? defaultOpenUrl)(authorizationUrl);
      } catch (cause) {
        if (cause instanceof GraphicsCloudError)
          throw cause;
        throw new GraphicsCloudError("AUTHORIZATION_FAILED", "Graphics could not open the authorization page.", { cause });
      }
    })();
    launch.catch(() => {
      return;
    });
    const code = await Promise.race([
      callback.code,
      launch.then(() => callback.code)
    ]);
    await callback.close();
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: graphicsRedirectUri,
      client_id: discovery.authorization.clientId,
      resource: discovery.authorization.resource,
      code_verifier: verifier
    });
    const token = await tokenRequest(discovery, form, "TOKEN_EXCHANGE_FAILED", dependencies);
    const now = (dependencies.now ?? Date.now)();
    const credentials = credentialsFromToken(discovery, token, now);
    await storeCredentials(credentials, dependencies);
    return {
      authenticated: true,
      expiresAt: new Date(credentials.expiresAt).toISOString(),
      refreshable: credentials.refreshToken !== undefined
    };
  } finally {
    await callback.close();
  }
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
async function requireGraphicsAuthentication(dependencies = {}) {
  const discovery = await fetchGraphicsDiscovery(dependencies.fetch);
  await getGraphicsAccessToken(discovery, dependencies);
  return discovery;
}
async function graphicsAuthStatus(dependencies = {}) {
  const credentials = await loadCredentials(dependencies);
  if (credentials === null) {
    return { authenticated: false, expiresAt: null, refreshable: false };
  }
  if (credentials.issuer !== graphicsProductionContract.issuer || credentials.clientId !== graphicsProductionContract.clientId || credentials.resource !== graphicsProductionContract.resource) {
    return { authenticated: false, expiresAt: null, refreshable: false };
  }
  return {
    authenticated: credentials.expiresAt > (dependencies.now ?? Date.now)() || credentials.refreshToken !== undefined,
    expiresAt: new Date(credentials.expiresAt).toISOString(),
    refreshable: credentials.refreshToken !== undefined
  };
}
async function logoutGraphics(dependencies = {}) {
  const credentials = await loadCredentials(dependencies);
  if (credentials === null)
    return { removed: false, revoked: false };
  let revocationError;
  let revoked = false;
  try {
    const discovery = await fetchGraphicsDiscovery(dependencies.fetch);
    if (credentials.issuer !== discovery.authorization.issuer || credentials.clientId !== discovery.authorization.clientId || credentials.resource !== discovery.authorization.resource) {
      throw new GraphicsCloudError("REVOCATION_FAILED", "Graphics could not verify the stored login before revocation.");
    }
    const token = credentials.refreshToken ?? credentials.accessToken;
    const tokenTypeHint = credentials.refreshToken === undefined ? "access_token" : "refresh_token";
    let response;
    try {
      response = await (dependencies.fetch ?? fetch)(discovery.authorization.revocationEndpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "hraness-graphics-cli/0.4.0"
        },
        body: new URLSearchParams({
          token,
          token_type_hint: tokenTypeHint,
          client_id: discovery.authorization.clientId
        }),
        redirect: "error",
        signal: AbortSignal.timeout(15000)
      });
    } catch (cause) {
      throw new GraphicsCloudError("REVOCATION_FAILED", "Graphics could not revoke the remote login.", { cause });
    }
    await readBoundedResponseBytes(response, 16 * 1024, new GraphicsCloudError("REVOCATION_FAILED", "Graphics received an invalid revocation response."));
    if (!response.ok) {
      throw new GraphicsCloudError("REVOCATION_FAILED", "Graphics could not revoke the remote login.");
    }
    revoked = true;
  } catch (error) {
    revocationError = error instanceof GraphicsCloudError ? error : new GraphicsCloudError("REVOCATION_FAILED", "Graphics could not revoke the remote login.", { cause: error });
  }
  const removed = await deleteCredentials(dependencies);
  if (revocationError !== undefined)
    throw revocationError;
  return { removed, revoked };
}
export {
  requireGraphicsAuthentication,
  logoutGraphics,
  loginGraphics,
  graphicsSecretsService,
  graphicsSecretsName,
  graphicsAuthStatus,
  getGraphicsAccessToken,
  createPkcePair,
  buildGraphicsAuthorizationUrl
};
