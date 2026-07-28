import { TransmuteCloudError } from "./cloud-errors.js"

export const transmuteDiscoveryUrl =
  "https://transmute.rocks/.well-known/transmute-cli.json"
export const transmuteRedirectUri =
  "http://127.0.0.1:49671/oauth/callback"
export const transmuteProductionContract = Object.freeze({
  environment: "production",
  apiBaseUrl: "https://transmute.rocks/api/v1",
  operationsUrl: "https://transmute.rocks/api/v1/operations",
  issuer: "https://account.hraness.com",
  authorizationEndpoint:
    "https://account.hraness.com/api/auth/oauth2/authorize",
  tokenEndpoint: "https://account.hraness.com/api/auth/oauth2/token",
  revocationEndpoint: "https://account.hraness.com/api/auth/oauth2/revoke",
  clientId: "hraness:transmute-cli:production:v1",
  resource: "https://hraness.com/suite",
  generateImage: "https://transmute.rocks/api/v1/images/generate",
  maximumPromptBytes: 8_192,
  maximumRawImageBytes: 3_145_728,
} as const)
export const transmuteImageModels = Object.freeze([
  "openai/gpt-image-1.5",
  "recraft/recraft-v4.1-utility",
] as const)
export const transmuteResponseMediaTypes = Object.freeze([
  "image/webp",
] as const)
export const transmuteImageGenerationQuota = Object.freeze({
  accountDailyLimit: 10,
  globalDailySafetyLimit: 100,
  paymentEnforced: false,
  period: "utc-day",
} as const)
export const transmuteDesktopClientId = "transmute-cli" as const
export const transmuteDesktopScopes = Object.freeze([
  "openid",
  "profile",
  "email",
] as const)
export const transmuteDesktopEndpoints = Object.freeze({
  deviceAuthorization: "https://transmute.rocks/api/auth/device/code",
  deviceToken: "https://transmute.rocks/api/auth/device/token",
  session: "https://transmute.rocks/api/auth/get-session",
  signOut: "https://transmute.rocks/api/auth/revoke-session",
  convexToken: "https://transmute.rocks/api/auth/convex/token",
} as const)

export type TransmuteImageModel = (typeof transmuteImageModels)[number]
export type TransmuteResponseMediaType =
  (typeof transmuteResponseMediaTypes)[number]

export interface TransmuteMediaCapability {
  readonly apiBaseUrl: typeof transmuteProductionContract.apiBaseUrl
  readonly operationsUrl: typeof transmuteProductionContract.operationsUrl
  readonly authorization: {
    readonly type: "oauth2-authorization-code"
    readonly issuer: typeof transmuteProductionContract.issuer
    readonly authorizationEndpoint:
      typeof transmuteProductionContract.authorizationEndpoint
    readonly tokenEndpoint: typeof transmuteProductionContract.tokenEndpoint
    readonly revocationEndpoint:
      typeof transmuteProductionContract.revocationEndpoint
    readonly clientId: typeof transmuteProductionContract.clientId
    readonly redirectUri: typeof transmuteRedirectUri
    readonly scopes: readonly ["openid", "offline_access"]
    readonly resource: typeof transmuteProductionContract.resource
    readonly pkce: "S256"
  }
  readonly endpoints: {
    readonly generateImage: typeof transmuteProductionContract.generateImage
  }
  readonly imageGeneration: {
    readonly access: "authenticated"
    readonly billing: "free-preview"
    readonly models: typeof transmuteImageModels
    readonly maximumPromptBytes:
      typeof transmuteProductionContract.maximumPromptBytes
    readonly maximumRawImageBytes:
      typeof transmuteProductionContract.maximumRawImageBytes
    readonly imagesPerRequest: 1
    readonly responseMediaTypes: readonly ["image/webp"]
    readonly quota: typeof transmuteImageGenerationQuota
    readonly idempotency: {
      readonly header: "Idempotency-Key"
      readonly durable: true
      readonly scope: "suite-account"
    }
  }
  readonly vectorize: {
    readonly access: "local"
    readonly billing: "free"
    readonly execution: "local"
  }
}

export interface TransmuteDesktopUnavailableCapability {
  readonly availability: "unavailable"
}

export interface TransmuteDesktopAvailableCapability {
  readonly availability: "available"
  readonly clientId: typeof transmuteDesktopClientId
  readonly scopes: typeof transmuteDesktopScopes
  readonly endpoints: {
    readonly deviceAuthorization:
      typeof transmuteDesktopEndpoints.deviceAuthorization
    readonly deviceToken: typeof transmuteDesktopEndpoints.deviceToken
    readonly session: typeof transmuteDesktopEndpoints.session
    readonly signOut: typeof transmuteDesktopEndpoints.signOut
    readonly convexToken: typeof transmuteDesktopEndpoints.convexToken
    readonly sceneDescribe: string
  }
}

export type TransmuteDesktopCapability =
  | TransmuteDesktopUnavailableCapability
  | TransmuteDesktopAvailableCapability

export interface TransmuteDiscoveryDocument {
  readonly schemaVersion: 2
  readonly product: "transmute"
  readonly environment: typeof transmuteProductionContract.environment
  readonly capabilities: {
    readonly media: TransmuteMediaCapability
    readonly desktop: TransmuteDesktopCapability
  }
}

export type TransmuteFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export const transmuteDiscoveryMaximumBytes = 32 * 1024
export const transmuteMaximumPromptBytes =
  transmuteProductionContract.maximumPromptBytes
export const transmuteMaximumRawImageBytes =
  transmuteProductionContract.maximumRawImageBytes

function invalidDiscovery(): never {
  throw new TransmuteCloudError(
    "DISCOVERY_INVALID",
    "Transmute service discovery returned an invalid contract.",
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): void {
  const actual = Object.keys(value).sort()
  const canonical = [...expected].sort()
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    invalidDiscovery()
  }
}

function positiveInteger(
  value: unknown,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    invalidDiscovery()
  }
  return value as number
}

function exactStringTuple(
  value: unknown,
  expected: readonly string[],
): void {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    value.some((entry, index) => entry !== expected[index])
  ) {
    invalidDiscovery()
  }
}

function parseAuthorization(
  value: unknown,
): TransmuteMediaCapability["authorization"] {
  if (!isRecord(value)) invalidDiscovery()
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
    "pkce",
  ])
  if (
    value.type !== "oauth2-authorization-code" ||
    value.issuer !== transmuteProductionContract.issuer ||
    value.authorizationEndpoint !==
      transmuteProductionContract.authorizationEndpoint ||
    value.tokenEndpoint !== transmuteProductionContract.tokenEndpoint ||
    value.revocationEndpoint !==
      transmuteProductionContract.revocationEndpoint ||
    value.clientId !== transmuteProductionContract.clientId ||
    value.redirectUri !== transmuteRedirectUri ||
    value.resource !== transmuteProductionContract.resource ||
    value.pkce !== "S256"
  ) {
    invalidDiscovery()
  }
  exactStringTuple(value.scopes, ["openid", "offline_access"])
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
    pkce: "S256",
  }
}

function parseImageGeneration(
  value: unknown,
): TransmuteMediaCapability["imageGeneration"] {
  if (!isRecord(value)) invalidDiscovery()
  exactKeys(value, [
    "access",
    "billing",
    "models",
    "maximumPromptBytes",
    "maximumRawImageBytes",
    "imagesPerRequest",
    "responseMediaTypes",
    "quota",
    "idempotency",
  ])
  if (
    value.access !== "authenticated" ||
    value.billing !== "free-preview"
  ) {
    invalidDiscovery()
  }
  exactStringTuple(value.models, transmuteImageModels)
  if (value.imagesPerRequest !== 1) invalidDiscovery()
  exactStringTuple(value.responseMediaTypes, ["image/webp"])
  if (!isRecord(value.quota)) invalidDiscovery()
  exactKeys(value.quota, [
    "accountDailyLimit",
    "globalDailySafetyLimit",
    "paymentEnforced",
    "period",
  ])
  if (
    value.quota.accountDailyLimit !==
      transmuteImageGenerationQuota.accountDailyLimit ||
    value.quota.globalDailySafetyLimit !==
      transmuteImageGenerationQuota.globalDailySafetyLimit ||
    value.quota.paymentEnforced !==
      transmuteImageGenerationQuota.paymentEnforced ||
    value.quota.period !== transmuteImageGenerationQuota.period
  ) {
    invalidDiscovery()
  }
  if (!isRecord(value.idempotency)) invalidDiscovery()
  exactKeys(value.idempotency, ["header", "durable", "scope"])
  if (
    value.idempotency.header !== "Idempotency-Key" ||
    value.idempotency.durable !== true ||
    value.idempotency.scope !== "suite-account"
  ) {
    invalidDiscovery()
  }
  return {
    access: "authenticated",
    billing: "free-preview",
    models: transmuteImageModels,
    maximumPromptBytes:
      positiveInteger(value.maximumPromptBytes, transmuteMaximumPromptBytes) ===
      transmuteProductionContract.maximumPromptBytes
        ? transmuteProductionContract.maximumPromptBytes
        : invalidDiscovery(),
    maximumRawImageBytes:
      positiveInteger(
        value.maximumRawImageBytes,
        transmuteMaximumRawImageBytes,
      ) === transmuteProductionContract.maximumRawImageBytes
        ? transmuteProductionContract.maximumRawImageBytes
        : invalidDiscovery(),
    imagesPerRequest: 1,
    responseMediaTypes: ["image/webp"],
    quota: transmuteImageGenerationQuota,
    idempotency: {
      header: "Idempotency-Key",
      durable: true,
      scope: "suite-account",
    },
  }
}

function parseVectorize(
  value: unknown,
): TransmuteMediaCapability["vectorize"] {
  if (!isRecord(value)) invalidDiscovery()
  exactKeys(value, ["access", "billing", "execution"])
  if (
    value.access !== "local" ||
    value.billing !== "free" ||
    value.execution !== "local"
  ) {
    invalidDiscovery()
  }
  return {
    access: "local",
    billing: "free",
    execution: "local",
  }
}

function parseSceneDescribeEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) invalidDiscovery()
  let endpoint: URL
  try {
    endpoint = new URL(value)
  } catch {
    return invalidDiscovery()
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.port !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    endpoint.pathname !== "/api/v1/scenes/describe" ||
    !endpoint.hostname.endsWith(".convex.site")
  ) {
    invalidDiscovery()
  }
  return endpoint.href
}

function parseDesktop(
  value: unknown,
): TransmuteDesktopCapability {
  if (!isRecord(value)) invalidDiscovery()
  if (value.availability === "unavailable") {
    exactKeys(value, ["availability"])
    return { availability: "unavailable" }
  }
  if (value.availability !== "available") invalidDiscovery()
  exactKeys(value, ["availability", "clientId", "scopes", "endpoints"])
  if (value.clientId !== transmuteDesktopClientId) invalidDiscovery()
  exactStringTuple(value.scopes, transmuteDesktopScopes)
  if (!isRecord(value.endpoints)) invalidDiscovery()
  exactKeys(value.endpoints, [
    "deviceAuthorization",
    "deviceToken",
    "session",
    "signOut",
    "convexToken",
    "sceneDescribe",
  ])
  if (
    value.endpoints.deviceAuthorization !==
      transmuteDesktopEndpoints.deviceAuthorization ||
    value.endpoints.deviceToken !== transmuteDesktopEndpoints.deviceToken ||
    value.endpoints.session !== transmuteDesktopEndpoints.session ||
    value.endpoints.signOut !== transmuteDesktopEndpoints.signOut ||
    value.endpoints.convexToken !== transmuteDesktopEndpoints.convexToken
  ) {
    invalidDiscovery()
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
      sceneDescribe: parseSceneDescribeEndpoint(value.endpoints.sceneDescribe),
    },
  }
}

function parseMedia(value: unknown): TransmuteMediaCapability {
  if (!isRecord(value)) invalidDiscovery()
  exactKeys(value, [
    "apiBaseUrl",
    "operationsUrl",
    "authorization",
    "endpoints",
    "imageGeneration",
    "vectorize",
  ])
  if (!isRecord(value.endpoints)) invalidDiscovery()
  exactKeys(value.endpoints, ["generateImage"])
  return {
    apiBaseUrl:
      value.apiBaseUrl === transmuteProductionContract.apiBaseUrl
        ? transmuteProductionContract.apiBaseUrl
        : invalidDiscovery(),
    operationsUrl:
      value.operationsUrl === transmuteProductionContract.operationsUrl
        ? transmuteProductionContract.operationsUrl
        : invalidDiscovery(),
    authorization: parseAuthorization(value.authorization),
    endpoints: {
      generateImage:
        value.endpoints.generateImage === transmuteProductionContract.generateImage
          ? transmuteProductionContract.generateImage
          : invalidDiscovery(),
    },
    imageGeneration: parseImageGeneration(value.imageGeneration),
    vectorize: parseVectorize(value.vectorize),
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value
  }
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

export function parseTransmuteDiscovery(
  value: unknown,
): TransmuteDiscoveryDocument {
  if (!isRecord(value)) invalidDiscovery()
  exactKeys(value, [
    "schemaVersion",
    "product",
    "environment",
    "capabilities",
  ])
  if (value.schemaVersion !== 2 || value.product !== "transmute") {
    invalidDiscovery()
  }
  if (!isRecord(value.capabilities)) invalidDiscovery()
  exactKeys(value.capabilities, ["media", "desktop"])

  return deepFreeze({
    schemaVersion: 2,
    product: "transmute",
    environment:
      value.environment === transmuteProductionContract.environment
        ? transmuteProductionContract.environment
        : invalidDiscovery(),
    capabilities: {
      media: parseMedia(value.capabilities.media),
      desktop: parseDesktop(value.capabilities.desktop),
    },
  })
}

export async function readBoundedResponseBytes(
  response: Response,
  maximumBytes: number,
  error: TransmuteCloudError,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length")
  if (
    contentLength !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength) ||
      Number(contentLength) > maximumBytes)
  ) {
    await response.body?.cancel().catch(() => undefined)
    throw error
  }
  if (response.body === null) return new Uint8Array()

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > maximumBytes) {
        await reader.cancel()
        throw error
      }
      chunks.push(next.value)
    }
  } catch (caught) {
    if (caught === error) throw caught
    throw error
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export async function readBoundedJson(
  response: Response,
  maximumBytes: number,
  error: TransmuteCloudError,
): Promise<unknown> {
  const bytes = await readBoundedResponseBytes(response, maximumBytes, error)
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return JSON.parse(text)
  } catch {
    throw error
  }
}

export async function fetchTransmuteDiscovery(
  fetchImplementation: TransmuteFetch = fetch,
): Promise<TransmuteDiscoveryDocument> {
  const unavailable = new TransmuteCloudError(
    "DISCOVERY_UNAVAILABLE",
    "Transmute service discovery is unavailable.",
  )
  let response: Response
  try {
    response = await fetchImplementation(transmuteDiscoveryUrl, {
      headers: {
        accept: "application/json",
        "user-agent": "hraness-transmute-cli/0.5.0",
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    })
  } catch (cause) {
    throw new TransmuteCloudError(
      "DISCOVERY_UNAVAILABLE",
      "Transmute service discovery is unavailable.",
      { cause },
    )
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined)
    throw unavailable
  }
  const contentType = response.headers.get("content-type")
  if (
    contentType === null ||
    !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/iu.test(
      contentType,
    )
  ) {
    await response.body?.cancel().catch(() => undefined)
    throw new TransmuteCloudError(
      "DISCOVERY_INVALID",
      "Transmute service discovery returned an invalid content type.",
    )
  }
  const value = await readBoundedJson(
    response,
    transmuteDiscoveryMaximumBytes,
    new TransmuteCloudError(
      "DISCOVERY_INVALID",
      "Transmute service discovery returned an invalid contract.",
    ),
  )
  return parseTransmuteDiscovery(value)
}
