#!/usr/bin/env bun
// @bun
import {
  desktopStatus,
  getLatestDesktopRelease,
  installDesktop,
  openInDesktop,
  selectDesktopAsset
} from "./index-h67mtvfj.js";
import {
  installSkill,
  pathExists
} from "./index-mjemj725.js";
import {
  DiagramValidationError,
  builtInIcons,
  lintDiagram,
  parseDiagramSpec,
  renderPng,
  renderSvg,
  sanitizeIcon,
  serializeTldr
} from "./index-15w61te4.js";
import {
  VectorizeError,
  vectorizeHardLimits,
  vectorizeImage
} from "./index-y5zkj6v2.js";
import {
  __require
} from "./index-z1w83f81.js";

// src/graphics-compat-cli.ts
import { writeFile as writeFile5 } from "fs/promises";
import { resolve as resolve6 } from "path";
import { createInterface } from "readline/promises";

// src/graphics-compat/artifacts.ts
import { mkdir, readFile as readFile2, rename, rm, writeFile } from "fs/promises";
import { basename, dirname as dirname2, join, resolve as resolve2 } from "path";

// src/graphics-compat/config.ts
import { readFile } from "fs/promises";
import { dirname, extname, isAbsolute, resolve } from "path";
import { pathToFileURL } from "url";
var configNames = [
  { current: "graphics.config.ts", legacy: "diagram.config.ts" },
  { current: "graphics.config.mjs", legacy: "diagram.config.mjs" },
  { current: "graphics.config.js", legacy: "diagram.config.js" },
  { current: "graphics.config.json", legacy: "diagram.config.json" }
];
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseFont(value, at) {
  if (!isRecord(value) || typeof value.family !== "string" || value.family.trim() === "") {
    throw new Error(`${at} must have a non-empty family`);
  }
  if (value.files !== undefined && !Array.isArray(value.files)) {
    throw new Error(`${at}.files must be an array`);
  }
  const files = (value.files ?? []).map((file, index) => {
    if (!isRecord(file) || typeof file.path !== "string" || file.path.trim() === "") {
      throw new Error(`${at}.files[${index}].path must be a non-empty string`);
    }
    if (file.weight !== undefined && (typeof file.weight !== "number" || !Number.isFinite(file.weight))) {
      throw new Error(`${at}.files[${index}].weight must be a finite number`);
    }
    if (file.style !== undefined && file.style !== "normal" && file.style !== "italic") {
      throw new Error(`${at}.files[${index}].style must be normal or italic`);
    }
    if (file.embed !== undefined && typeof file.embed !== "boolean") {
      throw new Error(`${at}.files[${index}].embed must be a boolean`);
    }
    const style = file.style;
    return {
      path: file.path,
      ...file.weight === undefined ? {} : { weight: file.weight },
      ...style === undefined ? {} : { style },
      ...file.embed === undefined ? {} : { embed: file.embed }
    };
  });
  return { family: value.family, ...files.length === 0 ? {} : { files } };
}
function parseIcons(value, at) {
  if (!isRecord(value))
    throw new Error(`${at} must be an object`);
  return Object.fromEntries(Object.entries(value).map(([name, icon]) => {
    if (!isRecord(icon) || typeof icon.viewBox !== "string" || typeof icon.body !== "string") {
      throw new Error(`${at}.${name} must have string viewBox and body fields`);
    }
    return [name, sanitizeIcon({ viewBox: icon.viewBox, body: icon.body })];
  }));
}
function parseTheme(value, at) {
  if (!isRecord(value))
    throw new Error(`${at} must be an object`);
  const scalarKeys = ["background", "foreground", "muted", "stroke"];
  for (const key of scalarKeys) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      throw new Error(`${at}.${key} must be a CSS color string`);
    }
  }
  if (value.tones !== undefined && !isRecord(value.tones)) {
    throw new Error(`${at}.tones must be an object`);
  }
  return value;
}
function parseConfig(value) {
  if (!isRecord(value))
    throw new Error("Graphics config must export an object");
  const font = value.font === undefined ? undefined : parseFont(value.font, "font");
  const icons = value.icons === undefined ? undefined : parseIcons(value.icons, "icons");
  let theme;
  if (value.theme !== undefined) {
    if (!isRecord(value.theme))
      throw new Error("theme must be an object");
    theme = {
      ...value.theme.light === undefined ? {} : { light: parseTheme(value.theme.light, "theme.light") },
      ...value.theme.dark === undefined ? {} : { dark: parseTheme(value.theme.dark, "theme.dark") }
    };
  }
  return {
    ...font === undefined ? {} : { font },
    ...icons === undefined ? {} : { icons: { ...builtInIcons, ...icons } },
    ...theme === undefined ? {} : { theme }
  };
}
async function discoverConfig(directory) {
  for (const names of configNames) {
    const candidate = resolve(directory, names.current);
    if (await pathExists(candidate))
      return candidate;
  }
  for (const names of configNames) {
    const candidate = resolve(directory, names.legacy);
    if (await pathExists(candidate)) {
      const replacement = resolve(directory, names.current);
      throw new Error(`Legacy Graphics config found at ${candidate}. Rename it to ${replacement}; Graphics does not auto-load diagram.config.*.`);
    }
  }
  return null;
}
async function loadDiagramConfig(options) {
  const filePath = options.explicitPath === undefined ? await discoverConfig(options.searchDirectory) : resolve(options.explicitPath);
  if (filePath === null) {
    return {
      filePath: null,
      baseDirectory: options.searchDirectory,
      value: { icons: builtInIcons }
    };
  }
  if (!await pathExists(filePath))
    throw new Error(`Config does not exist: ${filePath}`);
  const raw = extname(filePath) === ".json" ? JSON.parse(await readFile(filePath, "utf8")) : (await import(`${pathToFileURL(filePath).href}?v=${Date.now()}`)).default;
  const value = parseConfig(raw);
  const baseDirectory = dirname(filePath);
  const font = value.font === undefined ? undefined : {
    ...value.font,
    ...value.font.files === undefined ? {} : {
      files: value.font.files.map((file) => ({
        ...file,
        path: isAbsolute(file.path) ? file.path : resolve(baseDirectory, file.path)
      }))
    }
  };
  return {
    filePath,
    baseDirectory,
    value: {
      ...value,
      icons: { ...builtInIcons, ...value.icons },
      ...font === undefined ? {} : { font }
    }
  };
}

// src/graphics-compat/artifacts.ts
async function atomicWrite(filePath, data) {
  const temporary = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(temporary, data);
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
async function readDiagramFile(filePath) {
  const absolutePath = resolve2(filePath);
  let parsed;
  try {
    parsed = JSON.parse(await readFile2(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not read diagram JSON at ${absolutePath}`, { cause: error });
  }
  return { absolutePath, spec: parseDiagramSpec(parsed) };
}
async function checkDiagramFile(options) {
  const { absolutePath, spec } = await readDiagramFile(options.filePath);
  const config = await loadDiagramConfig({
    ...options.configPath === undefined ? {} : { explicitPath: options.configPath },
    searchDirectory: dirname2(absolutePath)
  });
  for (const shape of spec.shapes) {
    if ((shape.type === "rect" || shape.type === "ellipse") && shape.icon !== undefined && config.value.icons?.[shape.icon] === undefined) {
      throw new Error(`Unknown icon "${shape.icon}" on shape ${shape.id}`);
    }
  }
  return { findings: lintDiagram(spec), configPath: config.filePath };
}
async function renderDiagramFile(options) {
  const { absolutePath, spec } = await readDiagramFile(options.filePath);
  const outDirectory = resolve2(options.outDirectory ?? dirname2(absolutePath));
  const config = await loadDiagramConfig({
    ...options.configPath === undefined ? {} : { explicitPath: options.configPath },
    searchDirectory: dirname2(absolutePath)
  });
  const scale = options.scale ?? 2;
  if (!Number.isFinite(scale) || scale <= 0 || scale > 8) {
    throw new Error("PNG scale must be greater than zero and no more than 8");
  }
  const [light, dark] = await Promise.all([
    renderSvg(spec, "light", config.value),
    renderSvg(spec, "dark", config.value)
  ]);
  const [lightPng, darkPng] = [renderPng(light, config.value, scale), renderPng(dark, config.value, scale)];
  const artifacts = {
    spec: absolutePath,
    tldr: join(outDirectory, `${spec.name}.tldr`),
    lightSvg: join(outDirectory, `${spec.name}.light.svg`),
    darkSvg: join(outDirectory, `${spec.name}.dark.svg`),
    lightPng: join(outDirectory, `${spec.name}.light.png`),
    darkPng: join(outDirectory, `${spec.name}.dark.png`)
  };
  await mkdir(outDirectory, { recursive: true });
  await Promise.all([
    atomicWrite(artifacts.tldr, serializeTldr(spec, config.value)),
    atomicWrite(artifacts.lightSvg, light.svg),
    atomicWrite(artifacts.darkSvg, dark.svg),
    atomicWrite(artifacts.lightPng, lightPng),
    atomicWrite(artifacts.darkPng, darkPng)
  ]);
  return { artifacts, findings: lintDiagram(spec), configPath: config.filePath };
}
function artifactSummary(artifacts) {
  return [
    `Rendered ${basename(artifacts.spec)}`,
    `  ${artifacts.tldr}`,
    `  ${artifacts.lightSvg}`,
    `  ${artifacts.darkSvg}`,
    `  ${artifacts.lightPng}`,
    `  ${artifacts.darkPng}`
  ].join(`
`);
}
// src/graphics-compat/mcp/tools.ts
import { rename as rename4, rm as rm4, writeFile as writeFile4 } from "fs/promises";
import { dirname as dirname6, join as join5 } from "path";

// src/graphics-compat/auth.ts
import { createHash as createHash2, randomBytes as randomBytes2, timingSafeEqual } from "crypto";
import { createServer } from "http";

// src/graphics-compat/cloud-errors.ts
class GraphicsCloudError extends Error {
  code;
  constructor(code, message, options) {
    super(`[${code}] ${message}`, options);
    this.name = "GraphicsCloudError";
    this.code = code;
  }
}

// src/graphics-compat/discovery.ts
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
function isRecord2(value) {
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
  if (!isRecord2(value))
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
  if (!isRecord2(value))
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
  if (!isRecord2(value.quota))
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
  if (!isRecord2(value.idempotency))
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
  if (!isRecord2(value))
    invalidDiscovery();
  exactKeys(value, ["vectorize"]);
  if (!isRecord2(value.vectorize))
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
  if (!isRecord2(value))
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
  if (!isRecord2(value.endpoints))
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

// src/graphics-compat/credential-lease.ts
import { createHash, randomBytes } from "crypto";
import {
  lstat,
  mkdir as mkdir2,
  open,
  readFile as readFile3,
  readlink,
  readdir,
  unlink
} from "fs/promises";
import { homedir } from "os";
import { isAbsolute as isAbsolute2, join as join2 } from "path";
import { performance } from "perf_hooks";
var choosingMarkerPattern = /^choosing-v4-([0-9a-f]{32})-(\d{1,10})-([0-9a-f]{32})-([0-9a-f]{32})$/u;
var leaseMarkerPattern = /^lease-v4-([0-9a-f]{16})-([0-9a-f]{32})-(\d{1,10})-([0-9a-f]{32})-([0-9a-f]{32})$/u;
var maximumDirectoryEntries = 256;
var defaultWaitMilliseconds = 35000;
var defaultStaleMilliseconds = 30000;
var defaultPollMilliseconds = 50;
var maximumDurationMilliseconds = 5 * 60000;
var maximumPathBytes = 4096;
var maximumTicket = 0xffff_ffff_ffff_ffffn;
var graphicsCredentialMutationPlatforms = Object.freeze([
  "darwin",
  "linux"
]);
function errorCode(purpose) {
  return purpose === "refresh" ? "TOKEN_REFRESH_FAILED" : "TOKEN_STORAGE_FAILED";
}
function defaultFailureMessage(purpose) {
  return purpose === "refresh" ? "Graphics could not safely coordinate a login refresh." : "Graphics could not safely coordinate credential storage.";
}
function leaseFailure(purpose, message = defaultFailureMessage(purpose), cause) {
  return new GraphicsCloudError(errorCode(purpose), message, cause === undefined ? undefined : { cause });
}
function isErrorCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function isGraphicsCredentialMutationPlatformSupported(platform) {
  return graphicsCredentialMutationPlatforms.some((supported) => supported === platform);
}
function assertGraphicsCredentialMutationPlatformSupported(purpose, platform = process.platform) {
  if (isGraphicsCredentialMutationPlatformSupported(platform))
    return;
  throw leaseFailure(purpose, "Graphics cannot safely mutate shared credentials on this platform.");
}
function duration(value, fallback) {
  if (value === undefined)
    return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximumDurationMilliseconds) {
    throw new GraphicsCloudError("INVALID_ARGUMENT", "Invalid Graphics credential lease configuration.");
  }
  return value;
}
function resolveOptions(dependencies) {
  const configured = dependencies.credentialLease;
  const directory = configured?.directory ?? join2(homedir(), ".cache", "hraness-graphics-cli", "credential-lease-v4");
  if (!isAbsolute2(directory) || directory.includes("\x00") || Buffer.byteLength(directory, "utf8") > maximumPathBytes) {
    throw new GraphicsCloudError("INVALID_ARGUMENT", "Invalid Graphics credential lease configuration.");
  }
  return {
    directory,
    waitTimeoutMilliseconds: duration(configured?.waitTimeoutMilliseconds, defaultWaitMilliseconds),
    staleAfterMilliseconds: duration(configured?.staleAfterMilliseconds, defaultStaleMilliseconds),
    pollIntervalMilliseconds: duration(configured?.pollIntervalMilliseconds, defaultPollMilliseconds),
    signal: configured?.signal,
    heartbeat: configured?.heartbeat
  };
}
function throwIfCancelled(signal, purpose) {
  if (signal?.aborted !== true)
    return;
  throw leaseFailure(purpose, purpose === "refresh" ? "Graphics login refresh was cancelled." : "Graphics credential mutation was cancelled.");
}
function throwIfGraphicsCredentialMutationCancelled(dependencies, purpose) {
  throwIfCancelled(dependencies.credentialLease?.signal, purpose);
}
async function waitForLease(milliseconds, signal, purpose) {
  throwIfCancelled(signal, purpose);
  await new Promise((resolve3, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      if (timer !== undefined)
        clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    };
    const finish = () => {
      if (settled)
        return;
      settled = true;
      cleanup();
      resolve3();
    };
    const cancel = () => {
      if (settled)
        return;
      settled = true;
      cleanup();
      reject(leaseFailure(purpose, purpose === "refresh" ? "Graphics login refresh was cancelled." : "Graphics credential mutation was cancelled."));
    };
    timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted === true)
      cancel();
  });
}
async function prepareDirectory(directory, purpose) {
  try {
    await mkdir2(directory, { recursive: true, mode: 448 });
    const details = await lstat(directory);
    const currentUid = credentialOwnerUid();
    if (!details.isDirectory() || details.isSymbolicLink() || details.uid !== currentUid || (details.mode & 63) !== 0) {
      throw leaseFailure(purpose);
    }
  } catch (cause) {
    if (cause instanceof GraphicsCloudError)
      throw cause;
    throw leaseFailure(purpose, undefined, cause);
  }
}
function parsedPid(value) {
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid >= 1 && pid <= 2147483647 ? pid : null;
}
function parseMarkerName(name) {
  const choosing = choosingMarkerPattern.exec(name);
  if (choosing !== null) {
    const processScopeIdentity2 = choosing[1];
    const pidText2 = choosing[2];
    const processIdentity2 = choosing[3];
    const ownerId2 = choosing[4];
    if (processScopeIdentity2 === undefined || pidText2 === undefined || processIdentity2 === undefined || ownerId2 === undefined)
      return null;
    const pid2 = parsedPid(pidText2);
    return pid2 === null ? null : {
      kind: "choosing",
      name,
      processScopeIdentity: processScopeIdentity2,
      pid: pid2,
      processIdentity: processIdentity2,
      ownerId: ownerId2
    };
  }
  const lease = leaseMarkerPattern.exec(name);
  if (lease === null)
    return null;
  const ticketText = lease[1];
  const processScopeIdentity = lease[2];
  const pidText = lease[3];
  const processIdentity = lease[4];
  const ownerId = lease[5];
  if (ticketText === undefined || processScopeIdentity === undefined || pidText === undefined || processIdentity === undefined || ownerId === undefined) {
    return null;
  }
  const pid = parsedPid(pidText);
  if (pid === null)
    return null;
  return {
    kind: "lease",
    name,
    processScopeIdentity,
    pid,
    processIdentity,
    ownerId,
    ticket: BigInt(`0x${ticketText}`)
  };
}
function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return !isErrorCode(cause, "ESRCH");
  }
}
var linuxBootIdPath = "/proc/sys/kernel/random/boot_id";
var linuxMachineIdPaths = ["/etc/machine-id", "/var/lib/dbus/machine-id"];
var maximumProcStatBytes = 8192;
var macProcessInfoFlavor = 3;
var macProcessInfoSize = 136;
var macProcessStartSecondsOffset = 120;
var macProcessStartMicrosecondsOffset = 128;
var macHostUuidBytes = 16;
var macHostUuidWaitSeconds = 1n;
var cachedMacProcessScopeIdentity;
var cachedLinuxHostIdentity;
function processIdentityDigest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}
async function linuxHostIdentity() {
  if (cachedLinuxHostIdentity !== undefined)
    return cachedLinuxHostIdentity;
  for (const path of linuxMachineIdPaths) {
    try {
      const source = (await readFile3(path, "utf8")).trim().toLowerCase();
      if (/^(?!0{32}$)[0-9a-f]{32}$/u.test(source)) {
        cachedLinuxHostIdentity = processIdentityDigest(`linux-host:${source}`);
        return cachedLinuxHostIdentity;
      }
    } catch {}
  }
  return null;
}
async function linuxProcessIdentity(pid) {
  const [bootIdSource, statSource, pidNamespaceSource, hostIdentity] = await Promise.all([
    readFile3(linuxBootIdPath, "utf8"),
    readFile3(`/proc/${pid}/stat`, "utf8"),
    readlink(`/proc/${pid}/ns/pid`),
    linuxHostIdentity()
  ]);
  if (Buffer.byteLength(bootIdSource, "utf8") > 128 || Buffer.byteLength(statSource, "utf8") > maximumProcStatBytes)
    return null;
  const bootId = bootIdSource.trim().toLowerCase();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(bootId)) {
    return null;
  }
  if (hostIdentity === null)
    return null;
  if (!/^pid:\[[1-9][0-9]{0,31}\]$/u.test(pidNamespaceSource))
    return null;
  const commandEnd = statSource.lastIndexOf(") ");
  if (commandEnd < 2)
    return null;
  const fields = statSource.slice(commandEnd + 2).trim().split(/\s+/u);
  const startTicks = fields[19];
  if (startTicks === undefined || !/^[1-9][0-9]{0,31}$/u.test(startTicks))
    return null;
  const processScopeIdentity = processIdentityDigest(`linux-pid-namespace:${hostIdentity}:${pidNamespaceSource}`);
  return {
    processScopeIdentity,
    value: processIdentityDigest(`linux-process:${processScopeIdentity}:${startTicks}`)
  };
}
async function macProcessIdentity(pid) {
  const { dlopen, ptr } = await import("bun:ffi");
  const library = dlopen("/usr/lib/libproc.dylib", {
    proc_pidinfo: {
      args: ["i32", "i32", "u64", "ptr", "i32"],
      returns: "i32"
    }
  });
  try {
    const bytes = new Uint8Array(macProcessInfoSize);
    const returned = library.symbols.proc_pidinfo(pid, macProcessInfoFlavor, 0, ptr(bytes), bytes.byteLength);
    if (returned !== macProcessInfoSize)
      return null;
    const view = new DataView(bytes.buffer);
    const seconds = view.getBigUint64(macProcessStartSecondsOffset, true);
    const microseconds = view.getBigUint64(macProcessStartMicrosecondsOffset, true);
    if (seconds < 1n || microseconds >= 1000000n)
      return null;
    return processIdentityDigest(`darwin:${seconds}:${microseconds}`);
  } finally {
    library.close();
  }
}
async function macProcessScopeIdentity() {
  if (cachedMacProcessScopeIdentity !== undefined) {
    return cachedMacProcessScopeIdentity;
  }
  const { dlopen } = await import("bun:ffi");
  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    gethostuuid: {
      args: ["ptr", "ptr"],
      returns: "i32"
    }
  });
  try {
    const uuid = new Uint8Array(macHostUuidBytes);
    const wait = new BigInt64Array([macHostUuidWaitSeconds, 0n]);
    if (library.symbols.gethostuuid(uuid, wait) !== 0)
      return null;
    const source = Buffer.from(uuid).toString("hex");
    if (!/^(?!0{32}$)[0-9a-f]{32}$/u.test(source))
      return null;
    cachedMacProcessScopeIdentity = processIdentityDigest(`darwin-host:${source}`);
    return cachedMacProcessScopeIdentity;
  } finally {
    library.close();
  }
}
async function darwinProcessIdentity(pid) {
  const [value, processScopeIdentity] = await Promise.all([
    macProcessIdentity(pid),
    macProcessScopeIdentity()
  ]);
  return value === null || processScopeIdentity === null ? null : { processScopeIdentity, value };
}
async function queryProcessIdentity(pid) {
  if (!processIsAlive(pid))
    return { kind: "missing" };
  try {
    const identity = process.platform === "linux" ? await linuxProcessIdentity(pid) : process.platform === "darwin" ? await darwinProcessIdentity(pid) : null;
    if (identity !== null)
      return { kind: "identified", ...identity };
  } catch {}
  return processIsAlive(pid) ? { kind: "unavailable" } : { kind: "missing" };
}
async function markerProcessIsOwner(marker, inspectingProcessScopeIdentity) {
  if (marker.processScopeIdentity !== inspectingProcessScopeIdentity)
    return true;
  const processIdentity = await queryProcessIdentity(marker.pid);
  return processIdentity.kind === "unavailable" || processIdentity.kind === "identified" && processIdentity.processScopeIdentity === marker.processScopeIdentity && processIdentity.value === marker.processIdentity;
}
function identity(value) {
  return { device: value.dev, inode: value.ino };
}
function credentialOwnerUid() {
  if (typeof process.getuid !== "function") {
    throw new Error("credential owner uid unavailable");
  }
  return process.getuid();
}
function sameIdentity(left, right) {
  const device = "device" in right ? right.device : right.dev;
  const inode = "inode" in right ? right.inode : right.ino;
  return left.device === device && left.inode === inode;
}
function markerIsPrivateRegularFile(details) {
  return details.isFile() && !details.isSymbolicLink() && details.uid === credentialOwnerUid() && (details.mode & 63) === 0 && details.size === 0;
}
async function removeStaleUniqueMarker(marker, options, processScopeIdentity) {
  try {
    const confirmed = await lstat(marker.path);
    if (!sameIdentity(marker.identity, confirmed) || !markerIsPrivateRegularFile(confirmed) || await markerProcessIsOwner(marker, processScopeIdentity) || Date.now() - confirmed.mtimeMs < options.staleAfterMilliseconds) {
      return;
    }
    await unlink(marker.path);
  } catch {}
}
async function scanActiveMarkers(options, purpose, processScopeIdentity) {
  let entries;
  try {
    entries = await readdir(options.directory, { withFileTypes: true });
  } catch (cause) {
    throw leaseFailure(purpose, undefined, cause);
  }
  if (entries.length > maximumDirectoryEntries) {
    throw leaseFailure(purpose);
  }
  const active = [];
  for (const entry of entries) {
    const parsed = parseMarkerName(entry.name);
    if (parsed === null)
      continue;
    if (parsed.processScopeIdentity !== processScopeIdentity) {
      throw leaseFailure(purpose, "Graphics cannot safely coordinate credentials across process scopes.");
    }
    const path = join2(options.directory, entry.name);
    let details;
    try {
      details = await lstat(path);
    } catch (cause) {
      if (isErrorCode(cause, "ENOENT"))
        continue;
      throw leaseFailure(purpose, undefined, cause);
    }
    if (!markerIsPrivateRegularFile(details)) {
      throw leaseFailure(purpose);
    }
    const marker = {
      ...parsed,
      path,
      identity: identity(details),
      modifiedAtMilliseconds: details.mtimeMs
    };
    if (Date.now() - marker.modifiedAtMilliseconds < options.staleAfterMilliseconds || await markerProcessIsOwner(marker, processScopeIdentity)) {
      active.push(marker);
      continue;
    }
    await removeStaleUniqueMarker(marker, options, processScopeIdentity);
  }
  return active;
}
async function publishMarker(directory, name, processScopeIdentity, pid, processIdentity, ownerId, purpose, ticket) {
  const path = join2(directory, name);
  let handle;
  try {
    handle = await open(path, "wx+", 384);
    const details = await handle.stat();
    if (!markerIsPrivateRegularFile(details))
      throw leaseFailure(purpose);
    return {
      name,
      path,
      processScopeIdentity,
      pid,
      processIdentity,
      ownerId,
      ...ticket === undefined ? {} : { ticket },
      handle,
      identity: identity(details)
    };
  } catch (cause) {
    await handle?.close().catch(() => {
      return;
    });
    if (cause instanceof GraphicsCloudError)
      throw cause;
    throw leaseFailure(purpose, undefined, cause);
  }
}
async function markerStillOwned(marker) {
  try {
    const [held, named] = await Promise.all([
      marker.handle.stat(),
      lstat(marker.path)
    ]);
    return sameIdentity(marker.identity, held) && sameIdentity(marker.identity, named) && markerIsPrivateRegularFile(held) && markerIsPrivateRegularFile(named);
  } catch {
    return false;
  }
}
async function removePublishedMarkerOnce(marker) {
  let held;
  let named;
  try {
    held = await marker.handle.stat();
  } catch {
    return "lost";
  }
  try {
    named = await lstat(marker.path);
  } catch (cause) {
    return isErrorCode(cause, "ENOENT") ? "removed" : "retry";
  }
  if (!sameIdentity(marker.identity, held) || !sameIdentity(marker.identity, named) || !markerIsPrivateRegularFile(held) || !markerIsPrivateRegularFile(named)) {
    return "lost";
  }
  try {
    await unlink(marker.path);
    return "removed";
  } catch (cause) {
    return isErrorCode(cause, "ENOENT") ? "removed" : "retry";
  }
}
async function removePublishedMarker(marker, pollMilliseconds) {
  for (let attempt = 0;attempt < 3; attempt += 1) {
    const result = await removePublishedMarkerOnce(marker);
    if (result !== "retry")
      return result;
    if (attempt < 2)
      await waitForLease(pollMilliseconds, undefined, "logout");
  }
  return "retry";
}
function closeAfterBackgroundCleanup(marker, pollMilliseconds) {
  let cleanup = Promise.resolve();
  const timer = setInterval(() => {
    cleanup = cleanup.then(async () => {
      const result = await removePublishedMarkerOnce(marker);
      if (result === "retry")
        return;
      clearInterval(timer);
      await marker.handle.close().catch(() => {
        return;
      });
    }).catch(() => {
      return;
    });
  }, pollMilliseconds);
  timer.unref();
}
function compareLeases(left, right) {
  const leftTicket = left.ticket;
  const rightTicket = right.ticket;
  if (leftTicket === undefined || rightTicket === undefined)
    return 0;
  if (leftTicket < rightTicket)
    return -1;
  if (leftTicket > rightTicket)
    return 1;
  if (left.ownerId < right.ownerId)
    return -1;
  if (left.ownerId > right.ownerId)
    return 1;
  return 0;
}
function managedLease(marker, options, purpose) {
  let releaseRequested = false;
  let released = false;
  let heartbeat = Promise.resolve();
  const heartbeatMilliseconds = Math.max(10, Math.min(5000, Math.floor(options.staleAfterMilliseconds / 3)));
  const touch = async () => {
    if (!await markerStillOwned(marker))
      throw leaseFailure(purpose);
    const timestamp = new Date;
    await marker.handle.utimes(timestamp, timestamp);
  };
  const timer = setInterval(() => {
    if (releaseRequested || released)
      return;
    heartbeat = heartbeat.then(async () => {
      try {
        await (options.heartbeat ?? ((operation) => operation()))(touch);
      } catch {}
    }).catch(() => {
      return;
    });
  }, heartbeatMilliseconds);
  timer.unref();
  const assertOwnedOnce = async () => {
    if (released || !await markerStillOwned(marker)) {
      throw leaseFailure(purpose);
    }
    const markers = await scanActiveMarkers(options, purpose, marker.processScopeIdentity);
    const leases = markers.filter((candidate) => candidate.kind === "lease").sort(compareLeases);
    const owner = leases[0];
    if (owner === undefined || owner.ownerId !== marker.ownerId || owner.ticket !== marker.ticket || !sameIdentity(marker.identity, owner.identity)) {
      throw leaseFailure(purpose);
    }
  };
  return {
    assertOwned: async () => {
      let lastFailure;
      for (let attempt = 0;attempt < 3; attempt += 1) {
        try {
          await assertOwnedOnce();
          return;
        } catch (cause) {
          lastFailure = cause;
          if (attempt < 2) {
            await waitForLease(options.pollIntervalMilliseconds, undefined, purpose);
          }
        }
      }
      if (lastFailure instanceof GraphicsCloudError)
        throw lastFailure;
      throw leaseFailure(purpose, undefined, lastFailure);
    },
    release: async () => {
      if (releaseRequested)
        return;
      releaseRequested = true;
      clearInterval(timer);
      heartbeat.catch(() => {
        return;
      });
      const removal = await removePublishedMarker(marker, options.pollIntervalMilliseconds);
      if (removal !== "retry") {
        released = true;
        await marker.handle.close().catch(() => {
          return;
        });
        return;
      }
      closeAfterBackgroundCleanup(marker, options.pollIntervalMilliseconds);
    }
  };
}
async function cleanupUnacquiredMarker(marker, pollMilliseconds) {
  if (marker === undefined)
    return;
  if (await removePublishedMarker(marker, pollMilliseconds) !== "retry") {
    await marker.handle.close().catch(() => {
      return;
    });
    return;
  }
  closeAfterBackgroundCleanup(marker, pollMilliseconds);
}
async function acquireGraphicsCredentialMutationLease(dependencies, purpose) {
  assertGraphicsCredentialMutationPlatformSupported(purpose);
  const options = resolveOptions(dependencies);
  await prepareDirectory(options.directory, purpose);
  const deadline = performance.now() + options.waitTimeoutMilliseconds;
  const ownerId = randomBytes(16).toString("hex");
  const processIdentity = await queryProcessIdentity(process.pid);
  if (processIdentity.kind !== "identified")
    throw leaseFailure(purpose);
  const choosingName = `choosing-v4-${processIdentity.processScopeIdentity}-${process.pid}-${processIdentity.value}-${ownerId}`;
  let choosing;
  let owner;
  let lease;
  try {
    throwIfCancelled(options.signal, purpose);
    choosing = await publishMarker(options.directory, choosingName, processIdentity.processScopeIdentity, process.pid, processIdentity.value, ownerId, purpose);
    const initialMarkers = await scanActiveMarkers(options, purpose, processIdentity.processScopeIdentity);
    let highestTicket = 0n;
    for (const marker of initialMarkers) {
      if (marker.kind === "lease" && marker.ticket !== undefined && marker.ticket > highestTicket) {
        highestTicket = marker.ticket;
      }
    }
    if (highestTicket >= maximumTicket)
      throw leaseFailure(purpose);
    const ticket = highestTicket + 1n;
    const ticketText = ticket.toString(16).padStart(16, "0");
    const ownerName = `lease-v4-${ticketText}-${processIdentity.processScopeIdentity}-${process.pid}-${processIdentity.value}-${ownerId}`;
    owner = await publishMarker(options.directory, ownerName, processIdentity.processScopeIdentity, process.pid, processIdentity.value, ownerId, purpose, ticket);
    if (await removePublishedMarker(choosing, options.pollIntervalMilliseconds) !== "removed") {
      throw leaseFailure(purpose);
    }
    await choosing.handle.close().catch(() => {
      return;
    });
    choosing = undefined;
    lease = managedLease(owner, options, purpose);
    for (;; ) {
      throwIfCancelled(options.signal, purpose);
      if (!await markerStillOwned(owner))
        throw leaseFailure(purpose);
      const markers = await scanActiveMarkers(options, purpose, processIdentity.processScopeIdentity);
      const anotherChooser = markers.some((marker) => marker.kind === "choosing" && marker.ownerId !== ownerId);
      const leases = markers.filter((marker) => marker.kind === "lease").sort(compareLeases);
      const first = leases[0];
      if (!anotherChooser && first !== undefined && first.ownerId === ownerId && first.ticket === ticket && sameIdentity(owner.identity, first.identity)) {
        return lease;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw leaseFailure(purpose, purpose === "refresh" ? "Graphics timed out waiting for another login refresh." : "Graphics timed out waiting for another credential mutation.");
      }
      await waitForLease(Math.min(options.pollIntervalMilliseconds, remaining), options.signal, purpose);
    }
  } catch (cause) {
    await lease?.release();
    if (lease === undefined) {
      await cleanupUnacquiredMarker(owner, options.pollIntervalMilliseconds);
    }
    await cleanupUnacquiredMarker(choosing, options.pollIntervalMilliseconds);
    throw cause;
  }
}

// src/graphics-compat/auth.ts
var graphicsSecretsService = "com.hraness.graphics.cli";
var graphicsSecretsName = "oauth2-tokens";
var tokenResponseMaximumBytes = 64 * 1024;
var authorizationResponseMaximumBytes = 32 * 1024;
var authorizationLaunchUrlMaximumBytes = 16 * 1024;
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
function isRecord3(value) {
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
  if (!isRecord3(parsed) || parsed.schemaVersion !== 1 || typeof parsed.issuer !== "string" || parsed.issuer.length > 2048 || typeof parsed.clientId !== "string" || parsed.clientId.length > 256 || typeof parsed.resource !== "string" || parsed.resource.length > 2048 || !Number.isSafeInteger(parsed.expiresAt) || parsed.expiresAt < 0 || parsed.expiresAt > 8640000000000000) {
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
  const verifier = base64Url(randomBytes2(32));
  const challenge = createHash2("sha256").update(verifier, "ascii").digest("base64url");
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
  await new Promise((resolve3) => {
    server.close(() => resolve3());
  });
}
async function startAuthorizationCallback(expectedState, timeoutMilliseconds) {
  let resolveCode;
  let rejectCode;
  let settled = false;
  let requestCount = 0;
  const codePromise = new Promise((resolve3, reject) => {
    resolveCode = resolve3;
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
  await new Promise((resolve3, reject) => {
    server.once("error", reject);
    server.listen(callbackPort, "127.0.0.1", () => resolve3());
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
function authorizationLaunchFailure(options) {
  return new GraphicsCloudError("AUTHORIZATION_FAILED", "Graphics could not start the authorization flow.", options);
}
function validateAuthorizationLaunchUrl(discovery, value) {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > authorizationLaunchUrlMaximumBytes || /[\u0000-\u0020\u007f]/u.test(value) || value.includes("\\") || value.includes("#")) {
    throw authorizationLaunchFailure();
  }
  const isRootRelative = value.startsWith("/") && !value.startsWith("//");
  const isHttpsAbsolute = /^https:\/\//iu.test(value);
  if (!isRootRelative && !isHttpsAbsolute) {
    throw authorizationLaunchFailure();
  }
  if (/^https:\/\/[^/?#]*@/iu.test(value)) {
    throw authorizationLaunchFailure();
  }
  let url;
  let issuer;
  try {
    issuer = new URL(discovery.authorization.issuer);
    url = new URL(value, issuer);
  } catch {
    throw authorizationLaunchFailure();
  }
  if (url.protocol !== "https:" || url.origin !== issuer.origin || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw authorizationLaunchFailure();
  }
  return url.href;
}
async function fetchAuthorizationLaunchUrl(discovery, authorizationUrl, dependencies) {
  let response;
  try {
    response = await (dependencies.fetch ?? fetch)(authorizationUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "hraness-graphics-cli/0.4.0"
      },
      redirect: "manual",
      signal: AbortSignal.timeout(15000)
    });
  } catch (cause) {
    throw authorizationLaunchFailure({ cause });
  }
  if (response.redirected) {
    await response.body?.cancel().catch(() => {
      return;
    });
    throw authorizationLaunchFailure();
  }
  if (response.status >= 300 && response.status <= 399) {
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => {
      return;
    });
    return validateAuthorizationLaunchUrl(discovery, location);
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {
      return;
    });
    throw authorizationLaunchFailure();
  }
  const contentType = response.headers.get("content-type");
  if (contentType === null || !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/iu.test(contentType)) {
    await response.body?.cancel().catch(() => {
      return;
    });
    throw authorizationLaunchFailure();
  }
  const failure = authorizationLaunchFailure();
  const bytes = await readBoundedResponseBytes(response, authorizationResponseMaximumBytes, failure);
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw failure;
  }
  if (!isRecord3(value) || value.redirect !== true || Object.keys(value).length !== 2 || !("url" in value)) {
    throw failure;
  }
  return validateAuthorizationLaunchUrl(discovery, value.url);
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
  if (!isRecord3(value) || typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer" || !Number.isSafeInteger(value.expires_in) || value.expires_in < 1 || value.expires_in > maximumExpiresInSeconds) {
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
  assertGraphicsCredentialMutationPlatformSupported("login");
  const discovery = await fetchGraphicsDiscovery(dependencies.fetch);
  const { verifier, challenge } = createPkcePair();
  const state = base64Url(randomBytes2(32));
  const callback = await startAuthorizationCallback(state, 5 * 60000);
  callback.code.catch(() => {
    return;
  });
  const authorizationUrl = buildGraphicsAuthorizationUrl(discovery, state, challenge);
  try {
    const launch = (async () => {
      try {
        const launchUrl = await fetchAuthorizationLaunchUrl(discovery, authorizationUrl, dependencies);
        await (dependencies.openUrl ?? defaultOpenUrl)(launchUrl);
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
    const lease = await acquireGraphicsCredentialMutationLease(dependencies, "login");
    try {
      throwIfGraphicsCredentialMutationCancelled(dependencies, "login");
      await loadCredentials(dependencies);
      await lease.assertOwned();
      throwIfGraphicsCredentialMutationCancelled(dependencies, "login");
      await storeCredentials(credentials, dependencies);
    } finally {
      await lease.release();
    }
    return {
      authenticated: true,
      expiresAt: new Date(credentials.expiresAt).toISOString(),
      refreshable: credentials.refreshToken !== undefined
    };
  } finally {
    await callback.close();
  }
}
function credentialsMatchDiscovery(credentials, discovery) {
  return credentials.issuer === discovery.authorization.issuer && credentials.clientId === discovery.authorization.clientId && credentials.resource === discovery.authorization.resource;
}
async function refreshAccessToken(discovery, dependencies) {
  const lease = await acquireGraphicsCredentialMutationLease(dependencies, "refresh");
  try {
    const credentials = await loadCredentials(dependencies);
    if (credentials === null || !credentialsMatchDiscovery(credentials, discovery)) {
      throw new GraphicsCloudError("AUTH_REQUIRED", "Graphics login is missing or expired. Run `graphics login`.");
    }
    const now = (dependencies.now ?? Date.now)();
    if (credentials.expiresAt > now + expirySkewMilliseconds) {
      return credentials.accessToken;
    }
    const refreshToken = credentials.refreshToken;
    if (refreshToken === undefined) {
      throw new GraphicsCloudError("AUTH_REQUIRED", "Graphics login is missing or expired. Run `graphics login`.");
    }
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: discovery.authorization.clientId,
      resource: discovery.authorization.resource
    });
    await lease.assertOwned();
    throwIfGraphicsCredentialMutationCancelled(dependencies, "refresh");
    const token = await tokenRequest(discovery, form, "TOKEN_REFRESH_FAILED", dependencies);
    const next = credentialsFromToken(discovery, token, (dependencies.now ?? Date.now)(), refreshToken);
    await lease.assertOwned();
    await storeCredentials(next, dependencies);
    return next.accessToken;
  } finally {
    await lease.release();
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
  return refreshAccessToken(trustedDiscovery, dependencies);
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
  assertGraphicsCredentialMutationPlatformSupported("logout");
  const lease = await acquireGraphicsCredentialMutationLease(dependencies, "logout");
  try {
    const credentials = await loadCredentials(dependencies);
    if (credentials === null)
      return { removed: false, revoked: false };
    let revocationError;
    let revoked = false;
    try {
      const discovery = await fetchGraphicsDiscovery(dependencies.fetch);
      if (!credentialsMatchDiscovery(credentials, discovery)) {
        throw new GraphicsCloudError("REVOCATION_FAILED", "Graphics could not verify the stored login before revocation.");
      }
      const token = credentials.refreshToken ?? credentials.accessToken;
      const tokenTypeHint = credentials.refreshToken === undefined ? "access_token" : "refresh_token";
      let response;
      try {
        await lease.assertOwned();
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
    await lease.assertOwned();
    const removed = await deleteCredentials(dependencies);
    if (revocationError !== undefined)
      throw revocationError;
    return { removed, revoked };
  } finally {
    await lease.release();
  }
}

// src/graphics-compat/generate.ts
import { randomUUID } from "crypto";
import { rename as rename2, rm as rm2, writeFile as writeFile2 } from "fs/promises";
import { dirname as dirname3, resolve as resolve3 } from "path";
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
function isRecord4(value) {
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
  if (!isRecord4(value) || !exactKeys2(value, ["apiVersion", "image", "model", "requestId"]) || value.apiVersion !== "v1" || value.model !== requestedModel || typeof value.requestId !== "string" || value.requestId.length < 1 || value.requestId.length > 256 || /[\u0000-\u001f\u007f]/u.test(value.requestId) || !isRecord4(value.image) || !exactKeys2(value.image, ["base64", "mediaType"]) || typeof value.image.base64 !== "string" || !isCanonicalBase64(value.image.base64) || typeof value.image.mediaType !== "string" || !graphicsResponseMediaTypes.includes(value.image.mediaType) || value.image.mediaType !== trustedDiscovery.imageGeneration.responseMediaTypes[0]) {
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
async function atomicImageWrite(outputPath, bytes) {
  const absolutePath = resolve3(outputPath);
  const temporaryPath = resolve3(dirname3(absolutePath), `.${randomUUID()}.graphics-generate.tmp`);
  try {
    await writeFile2(temporaryPath, bytes, { flag: "wx" });
    await rename2(temporaryPath, absolutePath);
    return absolutePath;
  } catch (cause) {
    throw new GraphicsCloudError("OUTPUT_WRITE_FAILED", "Graphics could not atomically write the generated image.", { cause });
  } finally {
    await rm2(temporaryPath, { force: true }).catch(() => {
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

// src/graphics-compat/operations.ts
import { randomUUID as randomUUID2 } from "crypto";
import { mkdir as mkdir3, readFile as readFile4, rename as rename3, rm as rm3, writeFile as writeFile3 } from "fs/promises";
import { dirname as dirname4, join as join3, resolve as resolve4 } from "path";
var graphicsOperationCodes = [
  "graphics.diagram.check",
  "graphics.diagram.render",
  "graphics.image.vectorize",
  "graphics.image.generate"
];

class GraphicsOperationError extends Error {
  code;
  constructor(code, message) {
    super(`[${code}] ${message}`);
    this.name = "GraphicsOperationError";
    this.code = code;
  }
}
var modelSchema = {
  type: "string",
  enum: graphicsImageModels
};
var pathSchema = {
  type: "string",
  minLength: 1,
  maxLength: 4096
};
function deepFreeze2(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value))
    deepFreeze2(nested);
  return Object.freeze(value);
}
var graphicsOperationRegistry = deepFreeze2([
  {
    code: "graphics.diagram.check",
    title: "Check diagram",
    description: "Parse and lint a checked Graphics diagram source without changing its files.",
    execution: "local",
    authentication: "none",
    destructive: false,
    idempotent: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: pathSchema }
    }
  },
  {
    code: "graphics.diagram.render",
    title: "Render diagram",
    description: "Render a checked Graphics diagram source to its replaceable light, dark, PNG, SVG, and tldraw artifacts.",
    execution: "local",
    authentication: "none",
    destructive: true,
    idempotent: true,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: pathSchema,
        outDirectory: pathSchema,
        scale: {
          type: "number",
          exclusiveMinimum: 0,
          maximum: 4
        }
      }
    }
  },
  {
    code: "graphics.image.vectorize",
    title: "Vectorize image",
    description: "Convert a local caller-owned raster into a bounded inert SVG after proving a free Graphics login; source bytes remain local.",
    execution: "local",
    authentication: "required",
    destructive: true,
    idempotent: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["inputPath", "outputPath"],
      properties: {
        inputPath: pathSchema,
        outputPath: pathSchema,
        duotone: {
          type: "array",
          minItems: 2,
          maxItems: 2,
          items: {
            type: "string",
            pattern: "^#[a-fA-F0-9]{3}(?:[a-fA-F0-9]{3})?$"
          }
        },
        alphaCutoff: { type: "integer", minimum: 1, maximum: 64 },
        timeoutMs: { type: "integer", minimum: 1, maximum: 300000 }
      }
    }
  },
  {
    code: "graphics.image.generate",
    title: "Generate image",
    description: "Generate one bounded free-preview WebP with an explicitly supported hosted model, durable suite-account idempotency, and no ambiguous retry.",
    execution: "hosted",
    authentication: "required",
    destructive: true,
    idempotent: false,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["model", "prompt", "outputPath"],
      properties: {
        model: modelSchema,
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: graphicsMaximumPromptBytes
        },
        outputPath: pathSchema,
        idempotencyKey: {
          type: "string",
          minLength: 16,
          maxLength: 128,
          pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$"
        }
      }
    },
    transport: {
      method: "POST",
      endpointFromDiscovery: "endpoints.generateImage",
      authorization: "bearer",
      idempotencyHeader: "Idempotency-Key",
      retry: "never"
    }
  }
]);
function operationFailure(message) {
  throw new GraphicsOperationError("INVALID_OPERATION_INPUT", message);
}
function isRecord5(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function record(value, allowedKeys) {
  if (!isRecord5(value))
    operationFailure("Operation input must be an object.");
  const unknown = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0) {
    operationFailure(`Unsupported operation input field: ${unknown[0]}.`);
  }
  return value;
}
function pathValue(value, name) {
  if (typeof value !== "string" || value.length < 1 || value.length > 4096 || value.includes("\x00")) {
    operationFailure(`${name} must be a non-empty bounded local path.`);
  }
  return value;
}
function parseCheck(value) {
  const input = record(value, ["path"]);
  return { path: pathValue(input.path, "path") };
}
function parseRender(value) {
  const input = record(value, ["path", "outDirectory", "scale"]);
  const scale = input.scale;
  if (scale !== undefined && (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0 || scale > 4)) {
    operationFailure("scale must be greater than zero and no more than 4.");
  }
  return {
    path: pathValue(input.path, "path"),
    ...input.outDirectory === undefined ? {} : { outDirectory: pathValue(input.outDirectory, "outDirectory") },
    ...scale === undefined ? {} : { scale }
  };
}
function parseVectorize(value) {
  const input = record(value, [
    "inputPath",
    "outputPath",
    "duotone",
    "alphaCutoff",
    "timeoutMs"
  ]);
  const inputPath = pathValue(input.inputPath, "inputPath");
  const outputPath = pathValue(input.outputPath, "outputPath");
  if (!outputPath.toLowerCase().endsWith(".svg")) {
    operationFailure("outputPath must end in .svg.");
  }
  const duotone = input.duotone;
  if (duotone !== undefined && (!Array.isArray(duotone) || duotone.length !== 2 || duotone.some((color) => typeof color !== "string" || !/^#[a-f0-9]{3}(?:[a-f0-9]{3})?$/iu.test(color)))) {
    operationFailure("duotone must contain exactly two #rgb or #rrggbb colors.");
  }
  const alphaCutoff = input.alphaCutoff;
  if (alphaCutoff !== undefined && (!Number.isInteger(alphaCutoff) || alphaCutoff < 1 || alphaCutoff > 64)) {
    operationFailure("alphaCutoff must be an integer from 1 through 64.");
  }
  const timeoutMs = input.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000)) {
    operationFailure("timeoutMs must be an integer from 1 through 300000.");
  }
  return {
    inputPath,
    outputPath,
    ...duotone === undefined ? {} : { duotone },
    ...alphaCutoff === undefined ? {} : { alphaCutoff },
    ...timeoutMs === undefined ? {} : { timeoutMs }
  };
}
function parseGenerate(value) {
  const input = record(value, [
    "model",
    "prompt",
    "outputPath",
    "idempotencyKey"
  ]);
  if (typeof input.model !== "string" || !graphicsImageModels.includes(input.model)) {
    operationFailure(`model must be ${graphicsImageModels[0]} or ${graphicsImageModels[1]}.`);
  }
  if (typeof input.prompt !== "string" || input.prompt.trim().length < 1 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.prompt) || Buffer.byteLength(input.prompt, "utf8") > graphicsMaximumPromptBytes) {
    operationFailure(`prompt must be non-empty and no more than ${graphicsMaximumPromptBytes} UTF-8 bytes.`);
  }
  if (input.idempotencyKey !== undefined) {
    try {
      validateGraphicsIdempotencyKey(typeof input.idempotencyKey === "string" ? input.idempotencyKey : "");
    } catch {
      operationFailure("idempotencyKey is invalid.");
    }
  }
  const outputPath = pathValue(input.outputPath, "outputPath");
  if (!outputPath.toLowerCase().endsWith(".webp")) {
    operationFailure("outputPath must end in .webp.");
  }
  return {
    model: input.model,
    prompt: input.prompt,
    outputPath,
    ...input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }
  };
}
function parseGraphicsOperationInput(code, input) {
  switch (code) {
    case "graphics.diagram.check":
      return parseCheck(input);
    case "graphics.diagram.render":
      return parseRender(input);
    case "graphics.image.vectorize":
      return parseVectorize(input);
    case "graphics.image.generate":
      return parseGenerate(input);
    default:
      throw new GraphicsOperationError("INVALID_OPERATION", "Unknown Graphics operation code.");
  }
}
function isGraphicsOperationCode(value) {
  return graphicsOperationCodes.includes(value);
}
function searchGraphicsOperations(query = "", limit = graphicsOperationRegistry.length) {
  if (typeof query !== "string" || query.length > 200 || /[\u0000-\u001f\u007f]/u.test(query) || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new GraphicsOperationError("INVALID_SEARCH", "Search requires a bounded query and a limit from 1 through 20.");
  }
  const terms = query.toLowerCase().split(/\s+/u).filter((term) => term.length > 0);
  return graphicsOperationRegistry.filter((operation) => {
    const haystack = `${operation.code} ${operation.title} ${operation.description}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  }).slice(0, limit);
}
var operationBuiltInConfig = Object.freeze({
  icons: builtInIcons
});
async function readOperationDiagram(path) {
  const absolutePath = resolve4(path);
  let value;
  try {
    value = JSON.parse(await readFile4(absolutePath, "utf8"));
  } catch (cause) {
    throw new GraphicsOperationError("INVALID_OPERATION_INPUT", "Diagram source could not be read as JSON.");
  }
  const spec = parseDiagramSpec(value);
  for (const shape of spec.shapes) {
    if ((shape.type === "rect" || shape.type === "ellipse") && shape.icon !== undefined && !Object.hasOwn(builtInIcons, shape.icon)) {
      throw new GraphicsOperationError("INVALID_OPERATION_INPUT", "Diagram requests an unavailable built-in icon.");
    }
  }
  return { absolutePath, spec };
}
async function atomicOperationWrite(path, value) {
  const temporaryPath = join3(dirname4(path), `.${randomUUID2()}.graphics-operation.tmp`);
  try {
    await writeFile3(temporaryPath, value, { flag: "wx" });
    await rename3(temporaryPath, path);
  } finally {
    await rm3(temporaryPath, { force: true }).catch(() => {
      return;
    });
  }
}
async function checkOperationDiagram(path) {
  const { spec } = await readOperationDiagram(path);
  return {
    findings: lintDiagram(spec),
    configPath: null
  };
}
async function renderOperationDiagram(input) {
  const { absolutePath, spec } = await readOperationDiagram(input.path);
  const outputDirectory = resolve4(input.outDirectory ?? dirname4(absolutePath));
  const scale = input.scale ?? 2;
  const [light, dark] = await Promise.all([
    renderSvg(spec, "light", operationBuiltInConfig),
    renderSvg(spec, "dark", operationBuiltInConfig)
  ]);
  const [lightPng, darkPng] = [
    renderPng(light, operationBuiltInConfig, scale),
    renderPng(dark, operationBuiltInConfig, scale)
  ];
  const artifacts = {
    spec: absolutePath,
    tldr: join3(outputDirectory, `${spec.name}.tldr`),
    lightSvg: join3(outputDirectory, `${spec.name}.light.svg`),
    darkSvg: join3(outputDirectory, `${spec.name}.dark.svg`),
    lightPng: join3(outputDirectory, `${spec.name}.light.png`),
    darkPng: join3(outputDirectory, `${spec.name}.dark.png`)
  };
  await mkdir3(outputDirectory, { recursive: true });
  await Promise.all([
    atomicOperationWrite(artifacts.tldr, serializeTldr(spec, operationBuiltInConfig)),
    atomicOperationWrite(artifacts.lightSvg, light.svg),
    atomicOperationWrite(artifacts.darkSvg, dark.svg),
    atomicOperationWrite(artifacts.lightPng, lightPng),
    atomicOperationWrite(artifacts.darkPng, darkPng)
  ]);
  return {
    artifacts,
    findings: lintDiagram(spec),
    configPath: null
  };
}
async function executeGraphicsOperation(code, value, dependencies = {}) {
  const input = parseGraphicsOperationInput(code, value);
  switch (code) {
    case "graphics.diagram.check": {
      const options = input;
      return await checkOperationDiagram(options.path);
    }
    case "graphics.diagram.render": {
      const options = input;
      return await renderOperationDiagram(options);
    }
    case "graphics.image.vectorize": {
      const options = input;
      await requireGraphicsAuthentication(dependencies);
      const result = await vectorizeImage(options.inputPath, {
        outputPath: options.outputPath,
        ...options.duotone === undefined ? {} : { duotone: options.duotone },
        ...options.alphaCutoff === undefined ? {} : { alphaCutoff: options.alphaCutoff },
        ...options.timeoutMs === undefined ? {} : { limits: { maxDurationMs: options.timeoutMs } }
      });
      if (result.outputPath === null) {
        throw new GraphicsOperationError("INVALID_OPERATION_INPUT", "Vectorization did not publish its required output.");
      }
      return {
        outputPath: result.outputPath,
        receipt: result.receipt
      };
    }
    case "graphics.image.generate": {
      const options = input;
      return await generateGraphicsImageFile(options, dependencies);
    }
    default:
      throw new GraphicsOperationError("INVALID_OPERATION", "Unknown Graphics operation code.");
  }
}

// src/graphics-compat/mcp/boundary.ts
import { open as open2, mkdir as mkdir4, realpath, stat } from "fs/promises";
import {
  basename as basename2,
  dirname as dirname5,
  isAbsolute as isAbsolute3,
  join as join4,
  relative,
  resolve as resolve5,
  win32
} from "path";
var mcpSourceByteLimit = 1024 * 1024;

class WorkspaceBoundaryError extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "WorkspaceBoundaryError";
    this.code = code;
  }
}
function filesystemCode(error) {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return;
}
function normalizeRelativePath(value, options) {
  if (value.length === 0 || value.includes("\x00")) {
    throw new WorkspaceBoundaryError("INVALID_PATH", "Path must be a non-empty root-relative path.");
  }
  if (isAbsolute3(value) || win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    throw new WorkspaceBoundaryError("INVALID_PATH", "Absolute paths are not allowed.");
  }
  const segments = value.split(/[\\/]/).filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) {
    throw new WorkspaceBoundaryError("INVALID_PATH", "Parent-directory traversal is not allowed.");
  }
  if (segments.length === 0) {
    if (!options.allowRoot) {
      throw new WorkspaceBoundaryError("INVALID_PATH", "Path must identify a file below the root.");
    }
    return { native: ".", portable: "." };
  }
  return {
    native: segments.join("/"),
    portable: segments.join("/")
  };
}
function isConfined(rootDirectory, target) {
  const fromRoot = relative(rootDirectory, target);
  return fromRoot === "" || !fromRoot.startsWith("..") && !isAbsolute3(fromRoot);
}
async function readUtf8WithCap(filePath) {
  let handle;
  try {
    handle = await open2(filePath, "r");
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new WorkspaceBoundaryError("SOURCE_NOT_FILE", "Diagram source must be a regular file.");
    }
    if (metadata.size > mcpSourceByteLimit) {
      throw new WorkspaceBoundaryError("SOURCE_TOO_LARGE", `Diagram source exceeds the ${mcpSourceByteLimit}-byte limit.`);
    }
    const buffer = Buffer.allocUnsafe(mcpSourceByteLimit + 1);
    let bytesRead = 0;
    while (bytesRead <= mcpSourceByteLimit) {
      const next = await handle.read(buffer, bytesRead, mcpSourceByteLimit + 1 - bytesRead, null);
      if (next.bytesRead === 0)
        break;
      bytesRead += next.bytesRead;
    }
    if (bytesRead > mcpSourceByteLimit) {
      throw new WorkspaceBoundaryError("SOURCE_TOO_LARGE", `Diagram source exceeds the ${mcpSourceByteLimit}-byte limit.`);
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } catch {
      throw new WorkspaceBoundaryError("SOURCE_ENCODING", "Diagram source must contain valid UTF-8.");
    }
  } catch (error) {
    if (error instanceof WorkspaceBoundaryError)
      throw error;
    const code = filesystemCode(error);
    if (code === "ENOENT") {
      throw new WorkspaceBoundaryError("SOURCE_NOT_FOUND", "Diagram source does not exist.");
    }
    throw new WorkspaceBoundaryError("FILESYSTEM_ERROR", "Diagram source could not be read.");
  } finally {
    await handle?.close();
  }
}

class WorkspaceBoundary {
  rootDirectory;
  constructor(rootDirectory) {
    this.rootDirectory = rootDirectory;
  }
  static async create(rootDirectory) {
    let resolvedRoot;
    try {
      resolvedRoot = await realpath(resolve5(rootDirectory));
      if (!(await stat(resolvedRoot)).isDirectory()) {
        throw new WorkspaceBoundaryError("OUTPUT_NOT_DIRECTORY", "MCP root must be a directory.");
      }
    } catch (error) {
      if (error instanceof WorkspaceBoundaryError)
        throw error;
      throw new WorkspaceBoundaryError("FILESYSTEM_ERROR", "MCP root could not be opened.");
    }
    return new WorkspaceBoundary(resolvedRoot);
  }
  assertConfined(target) {
    if (!isConfined(this.rootDirectory, target)) {
      throw new WorkspaceBoundaryError("PATH_OUTSIDE_ROOT", "Path resolves outside the MCP root.");
    }
  }
  toRelativePath(absolutePath) {
    this.assertConfined(absolutePath);
    const fromRoot = relative(this.rootDirectory, absolutePath);
    return fromRoot === "" ? "." : fromRoot.split("\\").join("/");
  }
  async readSource(value) {
    const normalized = normalizeRelativePath(value, { allowRoot: false });
    const lexicalPath = resolve5(this.rootDirectory, normalized.native);
    this.assertConfined(lexicalPath);
    let canonicalPath;
    try {
      canonicalPath = await realpath(lexicalPath);
    } catch (error) {
      if (filesystemCode(error) === "ENOENT") {
        throw new WorkspaceBoundaryError("SOURCE_NOT_FOUND", "Diagram source does not exist.");
      }
      throw new WorkspaceBoundaryError("FILESYSTEM_ERROR", "Diagram source could not be resolved.");
    }
    this.assertConfined(canonicalPath);
    return {
      absolutePath: canonicalPath,
      relativePath: this.toRelativePath(canonicalPath),
      text: await readUtf8WithCap(canonicalPath)
    };
  }
  async resolveInputFile(value, maximumBytes) {
    const normalized = normalizeRelativePath(value, { allowRoot: false });
    const lexicalPath = resolve5(this.rootDirectory, normalized.native);
    this.assertConfined(lexicalPath);
    let canonicalPath;
    try {
      canonicalPath = await realpath(lexicalPath);
      this.assertConfined(canonicalPath);
      const metadata = await stat(canonicalPath);
      if (!metadata.isFile()) {
        throw new WorkspaceBoundaryError("SOURCE_NOT_FILE", "Input must be a regular file.");
      }
      if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || metadata.size > maximumBytes) {
        throw new WorkspaceBoundaryError("SOURCE_TOO_LARGE", `Input exceeds the ${maximumBytes}-byte limit.`);
      }
    } catch (error) {
      if (error instanceof WorkspaceBoundaryError)
        throw error;
      if (filesystemCode(error) === "ENOENT") {
        throw new WorkspaceBoundaryError("SOURCE_NOT_FOUND", "Input does not exist.");
      }
      throw new WorkspaceBoundaryError("FILESYSTEM_ERROR", "Input could not be resolved.");
    }
    return {
      absolutePath: canonicalPath,
      relativePath: this.toRelativePath(canonicalPath)
    };
  }
  async prepareOutputFile(value) {
    const normalized = normalizeRelativePath(value, { allowRoot: false });
    const fileName = basename2(normalized.native);
    if (fileName === "." || fileName === ".." || fileName.length === 0) {
      throw new WorkspaceBoundaryError("INVALID_PATH", "Output path must identify a file below the root.");
    }
    const directory = await this.prepareOutputDirectory(dirname5(normalized.native));
    const absolutePath = join4(directory.absolutePath, fileName);
    this.assertConfined(absolutePath);
    return {
      absolutePath,
      relativePath: this.toRelativePath(absolutePath)
    };
  }
  async prepareOutputDirectory(value) {
    const normalized = normalizeRelativePath(value, { allowRoot: true });
    const lexicalPath = resolve5(this.rootDirectory, normalized.native);
    this.assertConfined(lexicalPath);
    let ancestor = lexicalPath;
    for (;; ) {
      try {
        const canonicalAncestor = await realpath(ancestor);
        this.assertConfined(canonicalAncestor);
        break;
      } catch (error) {
        if (error instanceof WorkspaceBoundaryError)
          throw error;
        if (filesystemCode(error) !== "ENOENT") {
          throw new WorkspaceBoundaryError("FILESYSTEM_ERROR", "Output directory could not be resolved.");
        }
        const parent = dirname5(ancestor);
        if (parent === ancestor) {
          throw new WorkspaceBoundaryError("PATH_OUTSIDE_ROOT", "Output directory resolves outside the MCP root.");
        }
        ancestor = parent;
      }
    }
    try {
      await mkdir4(lexicalPath, { recursive: true });
      const canonicalPath = await realpath(lexicalPath);
      this.assertConfined(canonicalPath);
      if (!(await stat(canonicalPath)).isDirectory()) {
        throw new WorkspaceBoundaryError("OUTPUT_NOT_DIRECTORY", "Output path must be a directory.");
      }
      return {
        absolutePath: canonicalPath,
        relativePath: this.toRelativePath(canonicalPath)
      };
    } catch (error) {
      if (error instanceof WorkspaceBoundaryError)
        throw error;
      throw new WorkspaceBoundaryError("FILESYSTEM_ERROR", "Output directory could not be created.");
    }
  }
}

// src/graphics-compat/mcp/tools.ts
var mcpMaximumScale = 4;
var mcpMaximumRenderedPixels = 16777216;
var mcpMaximumShapes = 64;
var mcpMaximumEdges = 128;
var mcpMaximumReturnedFindings = 40;
var defaultScale = 2;
var maximumShapeIdsPerFinding = 12;
var builtInConfig = Object.freeze({ icons: builtInIcons });
var findingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["code", "message", "shapeIds"],
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    shapeIds: { type: "array", items: { type: "string" } }
  }
};
function deepFreeze3(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value))
    deepFreeze3(nested);
  return Object.freeze(value);
}
var graphicsMcpTools = deepFreeze3([
  {
    name: "check_diagram",
    title: "Check diagram",
    description: "Parse and lint one root-relative Graphics diagram source without changing files. Uses only built-in icons and themes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description: "Root-relative path to a diagram JSON source (1 MiB maximum)."
        }
      }
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "source", "findings", "summary"],
      properties: {
        ok: { const: true },
        source: { type: "string" },
        findings: { type: "array", items: findingSchema },
        summary: {
          type: "object",
          additionalProperties: false,
          required: [
            "shapeCount",
            "edgeCount",
            "findingCount",
            "returnedFindingCount",
            "findingsTruncated"
          ],
          properties: {
            shapeCount: { type: "integer", minimum: 0 },
            edgeCount: { type: "integer", minimum: 0 },
            findingCount: { type: "integer", minimum: 0 },
            returnedFindingCount: { type: "integer", minimum: 0 },
            findingsTruncated: { type: "boolean" }
          }
        }
      }
    },
    annotations: {
      title: "Check diagram",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: "render_diagram",
    title: "Render diagram",
    description: "Render one root-relative Graphics diagram source with built-in icons and themes, overwriting its paired .tldr, light/dark SVG, and light/dark PNG artifacts.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description: "Root-relative path to a diagram JSON source (1 MiB maximum)."
        },
        out_dir: {
          type: "string",
          description: "Optional root-relative output directory. Defaults to the source directory."
        },
        scale: {
          type: "number",
          exclusiveMinimum: 0,
          maximum: mcpMaximumScale,
          default: defaultScale,
          description: "PNG scale. The scaled canvas may contain at most 16,777,216 pixels."
        }
      }
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "source", "scale", "findings", "artifacts", "summary"],
      properties: {
        ok: { const: true },
        source: { type: "string" },
        scale: { type: "number" },
        findings: { type: "array", items: findingSchema },
        artifacts: {
          type: "object",
          additionalProperties: false,
          required: ["tldr", "lightSvg", "darkSvg", "lightPng", "darkPng"],
          properties: {
            tldr: { type: "string" },
            lightSvg: { type: "string" },
            darkSvg: { type: "string" },
            lightPng: { type: "string" },
            darkPng: { type: "string" }
          }
        },
        summary: {
          type: "object",
          additionalProperties: false,
          required: [
            "shapeCount",
            "edgeCount",
            "findingCount",
            "returnedFindingCount",
            "findingsTruncated"
          ],
          properties: {
            shapeCount: { type: "integer", minimum: 0 },
            edgeCount: { type: "integer", minimum: 0 },
            findingCount: { type: "integer", minimum: 0 },
            returnedFindingCount: { type: "integer", minimum: 0 },
            findingsTruncated: { type: "boolean" }
          }
        }
      }
    },
    annotations: {
      title: "Render diagram",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: "search_graphics",
    title: "Search Graphics operations",
    description: "Search the fixed semantic Graphics operation registry by bounded text. This never executes code or changes files.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          maxLength: 200,
          description: "Optional terms matched against operation codes and descriptions."
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 4
        }
      }
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "operations"],
      properties: {
        ok: { const: true },
        operations: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            required: [
              "code",
              "title",
              "description",
              "execution",
              "authentication",
              "inputSchema"
            ]
          }
        }
      }
    },
    annotations: {
      title: "Search Graphics operations",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: "execute_graphics",
    title: "Execute Graphics operation",
    description: "Execute one exact operation code with typed JSON input. Never accepts or evaluates source code. Local paths remain confined to the configured workspace root.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["operation", "input"],
      properties: {
        operation: {
          type: "string",
          enum: graphicsOperationCodes
        },
        input: {
          type: "object",
          description: "Typed input matching the selected operation's registry schema."
        }
      }
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "operation", "result"],
      properties: {
        ok: { const: true },
        operation: { type: "string", enum: graphicsOperationCodes },
        result: { type: "object" }
      }
    },
    annotations: {
      title: "Execute Graphics operation",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    }
  }
]);

class ToolFailure extends Error {
  code;
  issues;
  constructor(code, message, issues) {
    super(message);
    this.name = "ToolFailure";
    this.code = code;
    if (issues !== undefined)
      this.issues = issues;
  }
}
function isRecord6(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function safeFragment(value, maximumLength = 160) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximumLength);
}
function safeIssues(issues) {
  return issues.slice(0, 24).map((issue) => safeFragment(issue, 240));
}
function rejectUnknownKeys(value, allowed) {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ToolFailure("INVALID_ARGUMENTS", `Unsupported argument: ${safeFragment(unknown[0] ?? "unknown")}.`);
  }
}
function parsePath(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolFailure("INVALID_ARGUMENTS", "path must be a non-empty root-relative string.");
  }
  if (!value.toLowerCase().endsWith(".diagram.json")) {
    throw new ToolFailure("INVALID_ARGUMENTS", "path must end in .diagram.json.");
  }
  return value;
}
function parseCheckArguments(value) {
  if (!isRecord6(value)) {
    throw new ToolFailure("INVALID_ARGUMENTS", "Tool arguments must be an object.");
  }
  rejectUnknownKeys(value, new Set(["path"]));
  return { path: parsePath(value.path) };
}
function parseRenderArguments(value) {
  if (!isRecord6(value)) {
    throw new ToolFailure("INVALID_ARGUMENTS", "Tool arguments must be an object.");
  }
  rejectUnknownKeys(value, new Set(["path", "out_dir", "scale"]));
  const outDirectory = value.out_dir;
  if (outDirectory !== undefined && (typeof outDirectory !== "string" || outDirectory.length === 0)) {
    throw new ToolFailure("INVALID_ARGUMENTS", "out_dir must be a non-empty root-relative string when present.");
  }
  const scale = value.scale ?? defaultScale;
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0 || scale > mcpMaximumScale) {
    throw new ToolFailure("RENDER_LIMIT", `scale must be greater than zero and no more than ${mcpMaximumScale}.`);
  }
  return {
    path: parsePath(value.path),
    ...outDirectory === undefined ? {} : { outDirectory },
    scale
  };
}
function parseSearchArguments(value) {
  if (!isRecord6(value)) {
    throw new ToolFailure("INVALID_ARGUMENTS", "Tool arguments must be an object.");
  }
  rejectUnknownKeys(value, new Set(["query", "limit"]));
  const query = value.query ?? "";
  const limit = value.limit ?? graphicsOperationCodes.length;
  if (typeof query !== "string" || query.length > 200 || /[\u0000-\u001f\u007f]/u.test(query) || !Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new ToolFailure("INVALID_ARGUMENTS", "query must be a bounded string and limit must be an integer from 1 through 20.");
  }
  return { query, limit };
}
function parseExecuteArguments(value) {
  if (!isRecord6(value)) {
    throw new ToolFailure("INVALID_ARGUMENTS", "Tool arguments must be an object.");
  }
  rejectUnknownKeys(value, new Set(["operation", "input"]));
  if (typeof value.operation !== "string" || !graphicsOperationCodes.includes(value.operation) || !isRecord6(value.input)) {
    throw new ToolFailure("INVALID_ARGUMENTS", "operation must be an exact Graphics operation code and input must be an object.");
  }
  return {
    operation: value.operation,
    input: value.input
  };
}
function assertBuiltInIcons(spec) {
  for (const shape of spec.shapes) {
    if ((shape.type === "rect" || shape.type === "ellipse") && shape.icon !== undefined && !Object.hasOwn(builtInIcons, shape.icon)) {
      throw new ToolFailure("UNKNOWN_ICON", `Shape ${safeFragment(shape.id)} requests unavailable built-in icon ${safeFragment(shape.icon)}.`);
    }
  }
}
function assertComplexityLimits(spec) {
  const edgeCount = spec.edges?.length ?? 0;
  if (spec.shapes.length > mcpMaximumShapes || edgeCount > mcpMaximumEdges) {
    throw new ToolFailure("COMPLEXITY_LIMIT", `Diagram may contain at most ${mcpMaximumShapes} shapes and ${mcpMaximumEdges} edges in MCP mode.`);
  }
}
function assertRawComplexityLimits(value) {
  if (!isRecord6(value))
    return;
  const shapeCount = Array.isArray(value.shapes) ? value.shapes.length : 0;
  const edgeCount = Array.isArray(value.edges) ? value.edges.length : 0;
  if (shapeCount > mcpMaximumShapes || edgeCount > mcpMaximumEdges) {
    throw new ToolFailure("COMPLEXITY_LIMIT", `Diagram may contain at most ${mcpMaximumShapes} shapes and ${mcpMaximumEdges} edges in MCP mode.`);
  }
}
function assertRenderLimits(spec, scale) {
  const scaledWidth = spec.canvas.width * scale;
  const scaledHeight = spec.canvas.height * scale;
  const pixels = Math.ceil(scaledWidth) * Math.ceil(scaledHeight);
  if (!Number.isFinite(pixels) || scaledWidth < 1 || scaledHeight < 1 || pixels > mcpMaximumRenderedPixels) {
    throw new ToolFailure("RENDER_LIMIT", `Scaled canvas must be at least 1 pixel on each axis and no more than ${mcpMaximumRenderedPixels.toLocaleString("en-US")} pixels total.`);
  }
}
function publicFinding(finding) {
  return {
    code: safeFragment(finding.code, 64),
    message: safeFragment(finding.message, 240),
    shapeIds: finding.shapeIds.slice(0, maximumShapeIdsPerFinding).map((shapeId) => safeFragment(shapeId, 120))
  };
}
function publicFindings(findings) {
  return findings.slice(0, mcpMaximumReturnedFindings).map(publicFinding);
}
function diagramSummary(spec, findingCount, returnedFindingCount) {
  return {
    shapeCount: spec.shapes.length,
    edgeCount: spec.edges?.length ?? 0,
    findingCount,
    returnedFindingCount,
    findingsTruncated: returnedFindingCount < findingCount
  };
}
function successResult(text, structuredContent) {
  return {
    content: [{ type: "text", text }],
    structuredContent
  };
}
function failureResult(error) {
  let code = "INTERNAL_ERROR";
  let message = "The tool failed safely.";
  let issues;
  if (error instanceof ToolFailure) {
    code = error.code;
    message = safeFragment(error.message, 320);
    issues = error.issues;
  } else if (error instanceof WorkspaceBoundaryError) {
    code = error.code;
    message = safeFragment(error.message, 320);
  } else if (error instanceof GraphicsCloudError) {
    code = error.code;
    message = safeFragment(error.message.replace(/^\[[A-Z_]+\]\s*/u, ""), 320);
  } else if (error instanceof GraphicsOperationError) {
    code = error.code;
    message = safeFragment(error.message.replace(/^\[[A-Z_]+\]\s*/u, ""), 320);
  } else if (error instanceof VectorizeError) {
    code = `VECTORIZE_${error.code.toUpperCase()}`;
    message = "Local vectorization failed safely.";
  } else if (error instanceof DiagramValidationError) {
    code = "INVALID_DIAGRAM";
    message = "Diagram source did not pass validation.";
    issues = safeIssues(error.issues);
  } else if (typeof error === "object" && error !== null && "issues" in error && Array.isArray(error.issues) && error.issues.every((issue) => typeof issue === "string")) {
    code = "INVALID_LAYOUT";
    message = "Diagram layout could not be resolved.";
    issues = safeIssues(error.issues);
  }
  const issueText = issues === undefined || issues.length === 0 ? "" : `
${issues.map((issue) => `- ${issue}`).join(`
`)}`;
  return {
    content: [{ type: "text", text: `[${code}] ${message}${issueText}` }],
    isError: true
  };
}
function portableDirectory(filePath) {
  const separator = filePath.lastIndexOf("/");
  return separator === -1 ? "." : filePath.slice(0, separator);
}
async function atomicOverwrite(filePath, data) {
  const temporaryPath = join5(dirname6(filePath), `.${crypto.randomUUID()}.graphics-mcp.tmp`);
  try {
    await writeFile4(temporaryPath, data, { flag: "wx" });
    try {
      await rename4(temporaryPath, filePath);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
      if (code !== "EEXIST" && code !== "EPERM")
        throw error;
      await rm4(filePath, { force: true });
      await rename4(temporaryPath, filePath);
    }
  } finally {
    await rm4(temporaryPath, { force: true });
  }
}
async function loadDiagram(boundary, path) {
  const source = await boundary.readSource(path);
  let parsed;
  try {
    parsed = JSON.parse(source.text);
  } catch {
    throw new ToolFailure("INVALID_JSON", "Diagram source is not valid JSON.");
  }
  assertRawComplexityLimits(parsed);
  const spec = parseDiagramSpec(parsed);
  assertComplexityLimits(spec);
  assertBuiltInIcons(spec);
  return { source, spec };
}

class GraphicsMcpToolRuntime {
  boundary;
  authDependencies;
  renderQueue = Promise.resolve();
  constructor(boundary, authDependencies) {
    this.boundary = boundary;
    this.authDependencies = authDependencies;
  }
  static async create(rootDirectory, authDependencies = {}) {
    return new GraphicsMcpToolRuntime(await WorkspaceBoundary.create(rootDirectory), authDependencies);
  }
  enqueueRender(operation) {
    const result = this.renderQueue.then(operation, operation);
    this.renderQueue = result.then(() => {
      return;
    }, () => {
      return;
    });
    return result;
  }
  async call(name, argumentsValue) {
    try {
      if (name === "check_diagram") {
        const options = parseCheckArguments(argumentsValue);
        return await this.check(options);
      }
      if (name === "render_diagram") {
        const options = parseRenderArguments(argumentsValue);
        return await this.enqueueRender(() => this.render(options));
      }
      if (name === "search_graphics") {
        const options = parseSearchArguments(argumentsValue);
        const operations = searchGraphicsOperations(options.query, options.limit);
        return successResult(`Found ${operations.length} Graphics operation${operations.length === 1 ? "" : "s"}.`, { ok: true, operations });
      }
      if (name === "execute_graphics") {
        const options = parseExecuteArguments(argumentsValue);
        return await this.execute(options);
      }
      throw new ToolFailure("UNKNOWN_TOOL", "Requested tool is not available.");
    } catch (error) {
      return failureResult(error);
    }
  }
  wrapSemanticResult(operation, result) {
    if (result.isError === true)
      return result;
    return {
      content: result.content,
      structuredContent: {
        ok: true,
        operation,
        result: result.structuredContent ?? {}
      }
    };
  }
  async execute(options) {
    if (options.operation === "graphics.diagram.check") {
      const input2 = parseGraphicsOperationInput(options.operation, options.input);
      return this.wrapSemanticResult(options.operation, await this.check({ path: input2.path }));
    }
    if (options.operation === "graphics.diagram.render") {
      const input2 = parseGraphicsOperationInput(options.operation, options.input);
      return this.enqueueRender(async () => this.wrapSemanticResult(options.operation, await this.render({
        path: input2.path,
        ...input2.outDirectory === undefined ? {} : { outDirectory: input2.outDirectory },
        scale: input2.scale ?? defaultScale
      })));
    }
    if (options.operation === "graphics.image.vectorize") {
      const input2 = parseGraphicsOperationInput(options.operation, options.input);
      return this.enqueueRender(async () => {
        const source = await this.boundary.resolveInputFile(input2.inputPath, vectorizeHardLimits.maxInputBytes);
        await requireGraphicsAuthentication(this.authDependencies);
        const output2 = await this.boundary.prepareOutputFile(input2.outputPath);
        const result = await vectorizeImage(source.absolutePath, {
          outputPath: output2.absolutePath,
          ...input2.duotone === undefined ? {} : { duotone: input2.duotone },
          ...input2.alphaCutoff === undefined ? {} : { alphaCutoff: input2.alphaCutoff },
          ...input2.timeoutMs === undefined ? {} : { limits: { maxDurationMs: input2.timeoutMs } }
        });
        return successResult(`Executed ${options.operation}: ${output2.relativePath}`, {
          ok: true,
          operation: options.operation,
          result: {
            inputPath: source.relativePath,
            outputPath: output2.relativePath,
            receipt: result.receipt
          }
        });
      });
    }
    const input = parseGraphicsOperationInput(options.operation, options.input);
    const discovery = await requireGraphicsAuthentication(this.authDependencies);
    const output = await this.boundary.prepareOutputFile(input.outputPath);
    const generated = await generateGraphicsImageFile({ ...input, outputPath: output.absolutePath }, { ...this.authDependencies, discovery });
    return successResult(`Executed ${options.operation}: ${output.relativePath} (request ${safeFragment(generated.requestId, 256)}).`, {
      ok: true,
      operation: options.operation,
      result: {
        bytes: generated.bytes,
        idempotencyKey: generated.idempotencyKey,
        mediaType: generated.mediaType,
        model: generated.model,
        outputPath: output.relativePath,
        requestId: generated.requestId
      }
    });
  }
  async check(options) {
    const { source, spec } = await loadDiagram(this.boundary, options.path);
    const allFindings = lintDiagram(spec);
    const findings = publicFindings(allFindings);
    const summary = diagramSummary(spec, allFindings.length, findings.length);
    const text = allFindings.length === 0 ? `Checked ${source.relativePath}: no findings.` : `Checked ${source.relativePath}: ${allFindings.length} finding${allFindings.length === 1 ? "" : "s"}; ${findings.length} returned in structured content${findings.length < allFindings.length ? " (truncated)" : ""}.`;
    return successResult(text, {
      ok: true,
      source: source.relativePath,
      findings,
      summary
    });
  }
  async render(options) {
    const { source, spec } = await loadDiagram(this.boundary, options.path);
    assertRenderLimits(spec, options.scale);
    const outputDirectory = await this.boundary.prepareOutputDirectory(options.outDirectory ?? portableDirectory(source.relativePath));
    const tldr = serializeTldr(spec, builtInConfig);
    const [light, dark] = await Promise.all([
      renderSvg(spec, "light", builtInConfig),
      renderSvg(spec, "dark", builtInConfig)
    ]);
    const lightPng = renderPng(light, builtInConfig, options.scale);
    const darkPng = renderPng(dark, builtInConfig, options.scale);
    const absoluteArtifacts = {
      spec: source.absolutePath,
      tldr: join5(outputDirectory.absolutePath, `${spec.name}.tldr`),
      lightSvg: join5(outputDirectory.absolutePath, `${spec.name}.light.svg`),
      darkSvg: join5(outputDirectory.absolutePath, `${spec.name}.dark.svg`),
      lightPng: join5(outputDirectory.absolutePath, `${spec.name}.light.png`),
      darkPng: join5(outputDirectory.absolutePath, `${spec.name}.dark.png`)
    };
    await Promise.all([
      atomicOverwrite(absoluteArtifacts.tldr, tldr),
      atomicOverwrite(absoluteArtifacts.lightSvg, light.svg),
      atomicOverwrite(absoluteArtifacts.darkSvg, dark.svg),
      atomicOverwrite(absoluteArtifacts.lightPng, lightPng),
      atomicOverwrite(absoluteArtifacts.darkPng, darkPng)
    ]);
    const artifacts = {
      tldr: this.boundary.toRelativePath(absoluteArtifacts.tldr),
      lightSvg: this.boundary.toRelativePath(absoluteArtifacts.lightSvg),
      darkSvg: this.boundary.toRelativePath(absoluteArtifacts.darkSvg),
      lightPng: this.boundary.toRelativePath(absoluteArtifacts.lightPng),
      darkPng: this.boundary.toRelativePath(absoluteArtifacts.darkPng)
    };
    const allFindings = lintDiagram(spec);
    const findings = publicFindings(allFindings);
    const summary = diagramSummary(spec, allFindings.length, findings.length);
    const text = [
      `Rendered ${source.relativePath} with built-in assets:`,
      ...Object.values(artifacts).map((artifact) => `- ${artifact}`)
    ].join(`
`);
    return successResult(text, {
      ok: true,
      source: source.relativePath,
      scale: options.scale,
      findings,
      artifacts,
      summary
    });
  }
}

// src/graphics-compat/mcp/server.ts
var graphicsMcpProtocolVersion = "2025-11-25";
var graphicsMcpServerName = "hraness-graphics";
var maximumMessageBytes = 1024 * 1024;
function isRecord7(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isJsonRpcId(value) {
  return typeof value === "string" || typeof value === "number" && Number.isSafeInteger(value);
}
function isInitializeParams(value) {
  return isRecord7(value) && typeof value.protocolVersion === "string" && isRecord7(value.capabilities) && isRecord7(value.clientInfo) && typeof value.clientInfo.name === "string" && typeof value.clientInfo.version === "string";
}
function parseRequest(value) {
  if (!isRecord7(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string" || value.method.length === 0 || "id" in value && !isJsonRpcId(value.id)) {
    throw new Error("invalid request");
  }
  return {
    jsonrpc: "2.0",
    ..."id" in value ? { id: value.id } : {},
    method: value.method,
    ..."params" in value ? { params: value.params } : {}
  };
}
function success(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function failure(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function parseToolCall(params) {
  if (!isRecord7(params) || typeof params.name !== "string" || params.arguments !== undefined && !isRecord7(params.arguments)) {
    throw new Error("invalid params");
  }
  const unknownKeys = Object.keys(params).filter((key) => key !== "name" && key !== "arguments");
  if (unknownKeys.length > 0)
    throw new Error("invalid params");
  return {
    name: params.name,
    argumentsValue: params.arguments ?? {}
  };
}

class GraphicsMcpSession {
  runtime;
  serverVersion;
  state = "new";
  constructor(runtime, serverVersion) {
    this.runtime = runtime;
    this.serverVersion = serverVersion;
  }
  async handle(value) {
    let request;
    try {
      request = parseRequest(value);
    } catch {
      return failure(null, -32600, "Invalid Request");
    }
    const notification = request.id === undefined;
    if (request.method === "notifications/initialized") {
      if (!notification) {
        return failure(request.id, -32600, "Invalid Request");
      }
      if (this.state === "initializing")
        this.state = "ready";
      return null;
    }
    if (notification)
      return null;
    const id = request.id;
    if (request.method === "initialize") {
      if (this.state !== "new" || !isInitializeParams(request.params)) {
        return failure(id, -32602, "Invalid initialize parameters");
      }
      this.state = "initializing";
      return success(id, {
        protocolVersion: graphicsMcpProtocolVersion,
        capabilities: {
          tools: { listChanged: false }
        },
        serverInfo: {
          name: graphicsMcpServerName,
          version: this.serverVersion
        },
        instructions: "Use the compatibility check_diagram/render_diagram tools or search_graphics followed by execute_graphics with an exact registry code and typed JSON. Local paths are root-relative; source code is never accepted or evaluated."
      });
    }
    if (this.state !== "ready") {
      return failure(id, -32002, "Server is not initialized");
    }
    if (request.method === "ping")
      return success(id, {});
    if (request.method === "tools/list") {
      if (request.params !== undefined && (!isRecord7(request.params) || Object.keys(request.params).length > 0)) {
        return failure(id, -32602, "Invalid tools/list parameters");
      }
      return success(id, { tools: graphicsMcpTools });
    }
    if (request.method === "tools/call") {
      try {
        const toolCall = parseToolCall(request.params);
        if (!graphicsMcpTools.some((tool) => tool.name === toolCall.name)) {
          return failure(id, -32602, "Unknown tool");
        }
        return success(id, await this.runtime.call(toolCall.name, toolCall.argumentsValue));
      } catch {
        return failure(id, -32602, "Invalid tools/call parameters");
      }
    }
    return failure(id, -32601, "Method not found");
  }
}
async function defaultWriteLine(line) {
  await new Promise((resolve6, reject) => {
    process.stdout.write(`${line}
`, (error) => {
      if (error === null || error === undefined)
        resolve6();
      else
        reject(error);
    });
  });
}
function defaultInput() {
  return process.stdin;
}
async function emitResponse(writeLine, response) {
  await writeLine(JSON.stringify(response));
}
async function processLine(line, session, writeLine) {
  if (line.byteLength === 0)
    return;
  let value;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
    if (text.trim() === "")
      return;
    value = JSON.parse(text);
  } catch {
    await emitResponse(writeLine, failure(null, -32700, "Parse error"));
    return;
  }
  if (Array.isArray(value)) {
    await emitResponse(writeLine, failure(null, -32600, "Invalid Request"));
    return;
  }
  const response = await session.handle(value);
  if (response !== null)
    await emitResponse(writeLine, response);
}
async function runMcpServer(options = {}) {
  const runtime = await GraphicsMcpToolRuntime.create(options.rootDirectory ?? process.cwd(), options.authDependencies);
  const session = new GraphicsMcpSession(runtime, options.serverVersion ?? "0.4.0");
  const writeLine = options.writeLine ?? defaultWriteLine;
  let buffered = Buffer.alloc(0);
  for await (const chunk of options.input ?? defaultInput()) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    buffered = Buffer.concat([buffered, bytes]);
    if (buffered.byteLength > maximumMessageBytes && !buffered.includes(10)) {
      buffered = Buffer.alloc(0);
      await emitResponse(writeLine, failure(null, -32700, "Parse error"));
      continue;
    }
    for (;; ) {
      const newline = buffered.indexOf(10);
      if (newline === -1)
        break;
      let line = buffered.subarray(0, newline);
      buffered = buffered.subarray(newline + 1);
      if (line.at(-1) === 13)
        line = line.subarray(0, -1);
      if (line.byteLength > maximumMessageBytes) {
        await emitResponse(writeLine, failure(null, -32700, "Parse error"));
      } else {
        await processLine(line, session, writeLine);
      }
    }
  }
  if (buffered.byteLength > 0) {
    if (buffered.byteLength > maximumMessageBytes) {
      await emitResponse(writeLine, failure(null, -32700, "Parse error"));
    } else {
      await processLine(buffered, session, writeLine);
    }
  }
}
// src/graphics-compat-cli.ts
var version = "0.4.0";
var help = `graphics ${version}

Create concise diagrams from a checked JSON source.

Usage:
  graphics init [file]
  graphics check <file> [--config <file>] [--strict]
  graphics render <file> [--out-dir <directory>] [--config <file>] [--scale <number>]
  graphics vectorize <image> --output <file.svg> [--json] [--duotone <#rgb,#rgb>]
  graphics generate <prompt> --output <file.webp> [--model <model>] [--idempotency-key <key>] [--json]
  graphics login
  graphics logout
  graphics auth status
  graphics code search [query] [--limit <number>]
  graphics code execute <operation> --input <JSON>
  graphics mcp --root <workspace>
  graphics open <file.tldr|file.tldraw>
  graphics doctor
  graphics desktop status
  graphics desktop url
  graphics desktop install [--yes] [--download-only]
  graphics skill path
  graphics skill install [--target codex|claude|agents] [--scope user|project] [--force]

Render writes the same five replaceable artifacts on every run:
  <name>.tldr
  <name>.light.svg
  <name>.dark.svg
  <name>.light.png
  <name>.dark.png

The .tldr file is editable tldraw interchange. It imports into tldraw Offline,
which can save the newer app-owned .tldraw bundle. Rendering does not require
tldraw Offline or the tldraw SDK.

Vectorize adaptively traces a raster with a checksum-pinned VTracer binary.
It enforces bounded input, decode, time, path, and output budgets and emits a
safe path-only SVG (plus an internal vector alpha mask when fidelity requires).
It requires a valid free Graphics login but runs locally and uploads no source.

Generate sends one authenticated, non-retried free-preview request with durable
suite-account idempotency using exactly openai/gpt-image-1.5 or
recraft/recraft-v4.1-utility. The UTC-day limits are 10 per account and a 100
global safety cap; payment is not yet enforced. Responses are bounded,
validated WebP images and are published with an atomic local rename.

Code mode searches and executes a fixed semantic registry. Execute accepts
typed JSON for one exact owned operation code; it never evaluates source text.

MCP preserves root-relative check_diagram/render_diagram and adds closed
search_graphics/execute_graphics registry tools. It uses built-in assets, never
executes workspace config or caller code, and writes protocol messages only to
stdout.
`;
function parseArguments(args, valueOptions) {
  const positionals = [];
  const options = {};
  const flags = new Set;
  for (let index = 0;index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined)
      continue;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (!valueOptions.has(name)) {
      flags.add(name);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${name} requires a value`);
    }
    options[name] = value;
    index += 1;
  }
  return { positionals, options, flags };
}
function requiredPositional(parsed, index, label) {
  const value = parsed.positionals[index];
  if (value === undefined)
    throw new Error(`Missing ${label}`);
  return value;
}
function requiredOption(parsed, name) {
  const value = parsed.options[name];
  if (value === undefined)
    throw new Error(`--${name} is required`);
  return value;
}
function parsePositiveInteger(value, name) {
  if (value === undefined)
    return;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}
function parseDuotone(value) {
  if (value === undefined)
    return;
  const colors = value.split(",").map((color) => color.trim());
  if (colors.length !== 2 || colors.some((color) => !/^#[a-f0-9]{3}(?:[a-f0-9]{3})?$/iu.test(color))) {
    throw new Error("--duotone must contain two #rgb or #rrggbb colors separated by a comma");
  }
  return [colors[0], colors[1]];
}
function printFindings(findings) {
  if (findings.length === 0) {
    console.log("No diagram lint findings.");
    return;
  }
  console.warn(`${findings.length} diagram lint finding${findings.length === 1 ? "" : "s"}:`);
  for (const finding of findings) {
    console.warn(`  [${finding.code}] ${finding.message}`);
  }
}
var starter = {
  $schema: "https://raw.githubusercontent.com/hraness/graphics/v0.4.0/schema/diagram.schema.json",
  version: 1,
  name: "example-flow",
  canvas: { width: 960, height: 540, padding: 64 },
  layout: { type: "stack", direction: "horizontal", gap: 160, align: "center" },
  shapes: [
    {
      id: "source",
      type: "rect",
      width: 240,
      height: 160,
      label: "Source",
      icon: "document",
      tone: "blue"
    },
    {
      id: "result",
      type: "rect",
      width: 240,
      height: 160,
      label: "Result",
      icon: "check",
      tone: "green"
    }
  ],
  edges: [{ id: "source-result", from: "source", to: "result" }]
};
async function confirmInstall() {
  if (!process.stdin.isTTY) {
    throw new Error("Pass --yes to download the 100\u2013230 MB official tldraw Offline installer");
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question("Download, verify, and launch the official tldraw Offline installer? [y/N] ");
    return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
  } finally {
    prompt.close();
  }
}
function installLegacyVectorizerEnvironment() {
  const mappings = [
    ["GRAPHICS_VTRACER_PATH", "TRANSMUTE_VTRACER_PATH"],
    ["GRAPHICS_CACHE_DIR", "TRANSMUTE_CACHE_DIR"]
  ];
  const previous = mappings.map(([, canonical]) => [canonical, process.env[canonical]]);
  for (const [legacy, canonical] of mappings) {
    if (process.env[canonical] === undefined && process.env[legacy] !== undefined) {
      process.env[canonical] = process.env[legacy];
    }
  }
  return () => {
    for (const [canonical, value] of previous) {
      if (value === undefined)
        delete process.env[canonical];
      else
        process.env[canonical] = value;
    }
  };
}
async function main(args, dependencies = {}) {
  const [command, ...rest] = args;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    console.log(help);
    return;
  }
  if (command === "version" || command === "--version" || command === "-v") {
    console.log(version);
    return;
  }
  if (command === "init") {
    const parsed = parseArguments(rest, new Set);
    const filePath = resolve6(parsed.positionals[0] ?? "diagram.diagram.json");
    if (await pathExists(filePath))
      throw new Error(`Refusing to overwrite existing file: ${filePath}`);
    await writeFile5(filePath, `${JSON.stringify(starter, null, 2)}
`);
    console.log(`Created ${filePath}`);
    return;
  }
  if (command === "check") {
    const parsed = parseArguments(rest, new Set(["config"]));
    const result = await checkDiagramFile({
      filePath: requiredPositional(parsed, 0, "diagram file"),
      ...parsed.options.config === undefined ? {} : { configPath: parsed.options.config }
    });
    console.log(`Valid diagram${result.configPath === null ? "" : ` with ${result.configPath}`}.`);
    printFindings(result.findings);
    if (parsed.flags.has("strict") && result.findings.length > 0)
      process.exitCode = 2;
    return;
  }
  if (command === "render") {
    const parsed = parseArguments(rest, new Set(["out-dir", "config", "scale"]));
    const scale = parsed.options.scale === undefined ? undefined : Number.parseFloat(parsed.options.scale);
    const result = await renderDiagramFile({
      filePath: requiredPositional(parsed, 0, "diagram file"),
      ...parsed.options["out-dir"] === undefined ? {} : { outDirectory: parsed.options["out-dir"] },
      ...parsed.options.config === undefined ? {} : { configPath: parsed.options.config },
      ...scale === undefined ? {} : { scale }
    });
    console.log(artifactSummary(result.artifacts));
    printFindings(result.findings);
    return;
  }
  if (command === "vectorize") {
    const parsed = parseArguments(rest, new Set(["output", "duotone", "alpha-cutoff", "timeout-ms"]));
    const unknownFlags = [...parsed.flags].filter((flag) => flag !== "json");
    if (unknownFlags.length > 0) {
      throw new Error(`Unknown vectorize option: --${unknownFlags[0]}`);
    }
    if (parsed.positionals.length > 1) {
      throw new Error("graphics vectorize accepts exactly one raster input");
    }
    const output = requiredOption(parsed, "output");
    if (!output.toLowerCase().endsWith(".svg")) {
      throw new Error("--output must end in .svg");
    }
    const alphaCutoff = parsePositiveInteger(parsed.options["alpha-cutoff"], "alpha-cutoff");
    const timeoutMs = parsePositiveInteger(parsed.options["timeout-ms"], "timeout-ms");
    const duotone = parseDuotone(parsed.options.duotone);
    await (dependencies.requireAuthentication ?? requireGraphicsAuthentication)();
    const restoreEnvironment = installLegacyVectorizerEnvironment();
    let result;
    try {
      result = await (dependencies.vectorize ?? vectorizeImage)(requiredPositional(parsed, 0, "raster image"), {
        ...alphaCutoff === undefined ? {} : { alphaCutoff },
        ...duotone === undefined ? {} : { duotone },
        ...timeoutMs === undefined ? {} : { limits: { maxDurationMs: timeoutMs } },
        outputPath: output
      });
    } finally {
      restoreEnvironment();
    }
    if (parsed.flags.has("json")) {
      (dependencies.log ?? console.log)(JSON.stringify({ ...result.receipt, outputPath: result.outputPath }, null, 2));
    } else {
      (dependencies.log ?? console.log)(`Vectorized ${result.receipt.width}\xD7${result.receipt.height} with ` + `${result.receipt.profile}/${result.receipt.representation}: ${result.outputPath}`);
    }
    return;
  }
  if (command === "generate") {
    const parsed = parseArguments(rest, new Set(["model", "output", "idempotency-key"]));
    const unknownFlags = [...parsed.flags].filter((flag) => flag !== "json");
    if (unknownFlags.length > 0) {
      throw new Error(`Unknown generate option: --${unknownFlags[0]}`);
    }
    if (parsed.positionals.length !== 1) {
      throw new Error("graphics generate accepts exactly one prompt");
    }
    const model = parsed.options.model ?? graphicsImageModels[1];
    if (!graphicsImageModels.includes(model)) {
      throw new Error(`--model must be ${graphicsImageModels[0]} or ${graphicsImageModels[1]}`);
    }
    const result = await (dependencies.generate ?? generateGraphicsImageFile)({
      model,
      prompt: requiredPositional(parsed, 0, "prompt"),
      outputPath: requiredOption(parsed, "output"),
      ...parsed.options["idempotency-key"] === undefined ? {} : { idempotencyKey: parsed.options["idempotency-key"] }
    });
    if (parsed.flags.has("json")) {
      (dependencies.log ?? console.log)(JSON.stringify(result, null, 2));
    } else {
      (dependencies.log ?? console.log)(`Generated ${result.mediaType} with ${result.model}: ${result.outputPath} (${result.bytes} bytes, request ${result.requestId})`);
    }
    return;
  }
  if (command === "login") {
    const parsed = parseArguments(rest, new Set);
    if (parsed.positionals.length > 0 || parsed.flags.size > 0) {
      throw new Error("graphics login accepts no arguments");
    }
    const status = await loginGraphics();
    console.log(`Logged in to Graphics${status.expiresAt === null ? "" : ` until ${status.expiresAt}`}.`);
    return;
  }
  if (command === "logout") {
    const parsed = parseArguments(rest, new Set);
    if (parsed.positionals.length > 0 || parsed.flags.size > 0) {
      throw new Error("graphics logout accepts no arguments");
    }
    const result = await logoutGraphics();
    console.log(result.removed ? "Logged out of Graphics." : "Graphics was already logged out.");
    return;
  }
  if (command === "auth") {
    const [subcommand, ...subcommandArgs] = rest;
    if (subcommand !== "status" || subcommandArgs.length > 0) {
      throw new Error("Use graphics auth status");
    }
    const status = await graphicsAuthStatus();
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  if (command === "code") {
    const [subcommand, ...subcommandArgs] = rest;
    if (subcommand === "search") {
      const parsed = parseArguments(subcommandArgs, new Set(["limit"]));
      if (parsed.flags.size > 0 || parsed.positionals.length > 1) {
        throw new Error("Use graphics code search [query] [--limit <number>]");
      }
      const limit = parsePositiveInteger(parsed.options.limit, "limit") ?? graphicsOperationCodes.length;
      const operations = searchGraphicsOperations(parsed.positionals[0] ?? "", limit);
      console.log(JSON.stringify({ operations }, null, 2));
      return;
    }
    if (subcommand === "execute") {
      const parsed = parseArguments(subcommandArgs, new Set(["input"]));
      if (parsed.flags.size > 0 || parsed.positionals.length !== 1) {
        throw new Error("Use graphics code execute <operation> --input <JSON>");
      }
      const operation = parsed.positionals[0];
      if (!isGraphicsOperationCode(operation)) {
        throw new Error(`Unknown Graphics operation code: ${operation}`);
      }
      const inputText = requiredOption(parsed, "input");
      if (Buffer.byteLength(inputText, "utf8") > 64 * 1024) {
        throw new Error("--input JSON must be no more than 65536 UTF-8 bytes");
      }
      let input;
      try {
        input = JSON.parse(inputText);
      } catch {
        throw new Error("--input must be valid JSON");
      }
      const result = await executeGraphicsOperation(operation, input);
      console.log(JSON.stringify({ operation, result }, null, 2));
      return;
    }
    throw new Error("Use graphics code search [query] or graphics code execute <operation> --input <JSON>");
  }
  if (command === "mcp") {
    const parsed = parseArguments(rest, new Set(["root"]));
    if (parsed.positionals.length > 0 || parsed.flags.size > 0) {
      throw new Error("graphics mcp accepts only --root <workspace>");
    }
    await runMcpServer({
      rootDirectory: requiredOption(parsed, "root"),
      serverVersion: version
    });
    return;
  }
  if (command === "open") {
    const parsed = parseArguments(rest, new Set);
    await openInDesktop(requiredPositional(parsed, 0, "tldraw file"));
    console.log("Opened in tldraw Offline.");
    return;
  }
  if (command === "doctor") {
    const status = await desktopStatus();
    console.log(`graphics ${version}`);
    console.log(`Bun ${process.versions.bun ?? "not detected"}`);
    console.log("Headless SVG/PNG renderer ready");
    console.log(process.platform === "win32" ? "Adaptive raster-to-SVG vectorizer unavailable on Windows (fails closed with tool_platform)" : "Adaptive raster-to-SVG vectorizer ready (VTracer downloads on first use)");
    console.log("Root-relative MCP check/render server ready (trusted local workspace)");
    try {
      const auth = await graphicsAuthStatus();
      console.log(auth.authenticated ? "Graphics authenticated features ready" : "Graphics authenticated features require `graphics login`");
    } catch {
      console.log("Graphics credential store unavailable (authenticated features disabled)");
    }
    console.log(status.installedPath === null ? "tldraw Offline not installed (optional)" : `tldraw Offline: ${status.installedPath}`);
    console.log(status.server === null ? "tldraw Offline agent server not running (optional)" : `tldraw Offline agent server: localhost:${status.server.port}`);
    return;
  }
  if (command === "desktop") {
    const [subcommand, ...subcommandArgs] = rest;
    if (subcommand === "status") {
      const status = await desktopStatus();
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    if (subcommand === "url") {
      const release = await getLatestDesktopRelease();
      const asset = selectDesktopAsset(release);
      console.log(JSON.stringify({
        release: release.tag_name,
        releaseUrl: release.html_url,
        asset: asset.name,
        url: asset.browser_download_url,
        bytes: asset.size,
        sha256: asset.digest
      }, null, 2));
      return;
    }
    if (subcommand === "install") {
      const parsed = parseArguments(subcommandArgs, new Set);
      if (!parsed.flags.has("yes") && !await confirmInstall()) {
        console.log("Cancelled.");
        return;
      }
      const result = await installDesktop({ downloadOnly: parsed.flags.has("download-only") });
      console.log(`${parsed.flags.has("download-only") ? "Downloaded" : "Prepared"} tldraw Offline ${result.release}: ${result.filePath}`);
      return;
    }
    throw new Error("Use graphics desktop status, url, or install");
  }
  if (command === "skill") {
    const [subcommand, ...subcommandArgs] = rest;
    if (subcommand === "path") {
      const { bundledSkillPath } = await import("./skill-install-0f3cqyyx.js");
      console.log(bundledSkillPath());
      return;
    }
    if (subcommand === "install") {
      const parsed = parseArguments(subcommandArgs, new Set(["target", "scope", "project"]));
      const target = parsed.options.target ?? "codex";
      const scope = parsed.options.scope ?? "user";
      if (!["codex", "claude", "agents"].includes(target)) {
        throw new Error("--target must be codex, claude, or agents");
      }
      if (!["user", "project"].includes(scope)) {
        throw new Error("--scope must be user or project");
      }
      const destination = await installSkill({
        target,
        scope,
        ...parsed.options.project === undefined ? {} : { projectDirectory: parsed.options.project },
        force: parsed.flags.has("force")
      });
      console.log(`Installed graphics skill at ${destination}`);
      return;
    }
    throw new Error("Use graphics skill path or install");
  }
  throw new Error(`Unknown command: ${command}

${help}`);
}
if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
export {
  main,
  installLegacyVectorizerEnvironment
};
