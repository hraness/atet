import { GraphicsCloudError } from "./cloud-errors.ts"

export const graphicsDiscoveryUrl =
  "https://hraness.graphics/.well-known/graphics-cli.json"
export const graphicsRedirectUri =
  "http://127.0.0.1:49671/oauth/callback"
export const graphicsProductionContract = Object.freeze({
  environment: "production",
  apiBaseUrl: "https://hraness.graphics/api/v1",
  operationsUrl: "https://hraness.graphics/api/v1/operations",
  issuer: "https://account.hraness.com",
  authorizationEndpoint:
    "https://account.hraness.com/api/auth/oauth2/authorize",
  tokenEndpoint: "https://account.hraness.com/api/auth/oauth2/token",
  revocationEndpoint: "https://account.hraness.com/api/auth/oauth2/revoke",
  clientId: "hraness:graphics:production:v1",
  resource: "https://hraness.com/suite",
  generateImage: "https://hraness.graphics/api/v1/images/generate",
  maximumPromptBytes: 8_192,
  maximumRawImageBytes: 3_145_728,
} as const)
export const graphicsImageModels = Object.freeze([
  "openai/gpt-image-1.5",
  "recraft/recraft-v4.1-utility",
] as const)
export const graphicsResponseMediaTypes = Object.freeze([
  "image/webp",
] as const)

export type GraphicsImageModel = (typeof graphicsImageModels)[number]
export type GraphicsResponseMediaType =
  (typeof graphicsResponseMediaTypes)[number]

export interface GraphicsDiscoveryDocument {
  readonly schemaVersion: 1
  readonly product: "graphics"
  readonly environment: typeof graphicsProductionContract.environment
  readonly apiBaseUrl: typeof graphicsProductionContract.apiBaseUrl
  readonly operationsUrl: typeof graphicsProductionContract.operationsUrl
  readonly authorization: {
    readonly type: "oauth2-authorization-code"
    readonly issuer: typeof graphicsProductionContract.issuer
    readonly authorizationEndpoint:
      typeof graphicsProductionContract.authorizationEndpoint
    readonly tokenEndpoint: typeof graphicsProductionContract.tokenEndpoint
    readonly revocationEndpoint:
      typeof graphicsProductionContract.revocationEndpoint
    readonly clientId: typeof graphicsProductionContract.clientId
    readonly redirectUri: typeof graphicsRedirectUri
    readonly scopes: readonly ["openid", "offline_access"]
    readonly resource: typeof graphicsProductionContract.resource
    readonly pkce: "S256"
  }
  readonly endpoints: {
    readonly generateImage: typeof graphicsProductionContract.generateImage
  }
  readonly imageGeneration: {
    readonly models: typeof graphicsImageModels
    readonly maximumPromptBytes:
      typeof graphicsProductionContract.maximumPromptBytes
    readonly maximumRawImageBytes:
      typeof graphicsProductionContract.maximumRawImageBytes
    readonly imagesPerRequest: 1
    readonly responseMediaTypes: readonly ["image/webp"]
    readonly idempotency: {
      readonly header: "Idempotency-Key"
      readonly durable: false
      readonly scope: "process-local-mvp"
    }
  }
  readonly features: {
    readonly vectorize: {
      readonly access: "authenticated"
      readonly billing: "free"
      readonly execution: "local"
    }
  }
}

export type GraphicsFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

export const graphicsDiscoveryMaximumBytes = 32 * 1024
export const graphicsMaximumPromptBytes =
  graphicsProductionContract.maximumPromptBytes
export const graphicsMaximumRawImageBytes =
  graphicsProductionContract.maximumRawImageBytes

function invalidDiscovery(): never {
  throw new GraphicsCloudError(
    "DISCOVERY_INVALID",
    "Graphics service discovery returned an invalid contract.",
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
): GraphicsDiscoveryDocument["authorization"] {
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
    value.issuer !== graphicsProductionContract.issuer ||
    value.authorizationEndpoint !==
      graphicsProductionContract.authorizationEndpoint ||
    value.tokenEndpoint !== graphicsProductionContract.tokenEndpoint ||
    value.revocationEndpoint !==
      graphicsProductionContract.revocationEndpoint ||
    value.clientId !== graphicsProductionContract.clientId ||
    value.redirectUri !== graphicsRedirectUri ||
    value.resource !== graphicsProductionContract.resource ||
    value.pkce !== "S256"
  ) {
    invalidDiscovery()
  }
  exactStringTuple(value.scopes, ["openid", "offline_access"])
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
    pkce: "S256",
  }
}

function parseImageGeneration(
  value: unknown,
): GraphicsDiscoveryDocument["imageGeneration"] {
  if (!isRecord(value)) invalidDiscovery()
  exactKeys(value, [
    "models",
    "maximumPromptBytes",
    "maximumRawImageBytes",
    "imagesPerRequest",
    "responseMediaTypes",
    "idempotency",
  ])
  exactStringTuple(value.models, graphicsImageModels)
  if (value.imagesPerRequest !== 1) invalidDiscovery()
  exactStringTuple(value.responseMediaTypes, ["image/webp"])
  if (!isRecord(value.idempotency)) invalidDiscovery()
  exactKeys(value.idempotency, ["header", "durable", "scope"])
  if (
    value.idempotency.header !== "Idempotency-Key" ||
    value.idempotency.durable !== false ||
    value.idempotency.scope !== "process-local-mvp"
  ) {
    invalidDiscovery()
  }
  return {
    models: graphicsImageModels,
    maximumPromptBytes:
      positiveInteger(value.maximumPromptBytes, graphicsMaximumPromptBytes) ===
      graphicsProductionContract.maximumPromptBytes
        ? graphicsProductionContract.maximumPromptBytes
        : invalidDiscovery(),
    maximumRawImageBytes:
      positiveInteger(
        value.maximumRawImageBytes,
        graphicsMaximumRawImageBytes,
      ) === graphicsProductionContract.maximumRawImageBytes
        ? graphicsProductionContract.maximumRawImageBytes
        : invalidDiscovery(),
    imagesPerRequest: 1,
    responseMediaTypes: ["image/webp"],
    idempotency: {
      header: "Idempotency-Key",
      durable: false,
      scope: "process-local-mvp",
    },
  }
}

function parseFeatures(
  value: unknown,
): GraphicsDiscoveryDocument["features"] {
  if (!isRecord(value)) invalidDiscovery()
  exactKeys(value, ["vectorize"])
  if (!isRecord(value.vectorize)) invalidDiscovery()
  exactKeys(value.vectorize, ["access", "billing", "execution"])
  if (
    value.vectorize.access !== "authenticated" ||
    value.vectorize.billing !== "free" ||
    value.vectorize.execution !== "local"
  ) {
    invalidDiscovery()
  }
  return {
    vectorize: {
      access: "authenticated",
      billing: "free",
      execution: "local",
    },
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value
  }
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

export function parseGraphicsDiscovery(
  value: unknown,
): GraphicsDiscoveryDocument {
  if (!isRecord(value)) invalidDiscovery()
  exactKeys(value, [
    "schemaVersion",
    "product",
    "environment",
    "apiBaseUrl",
    "operationsUrl",
    "authorization",
    "endpoints",
    "imageGeneration",
    "features",
  ])
  if (value.schemaVersion !== 1 || value.product !== "graphics") {
    invalidDiscovery()
  }
  if (!isRecord(value.endpoints)) invalidDiscovery()
  exactKeys(value.endpoints, ["generateImage"])

  return deepFreeze({
    schemaVersion: 1,
    product: "graphics",
    environment:
      value.environment === graphicsProductionContract.environment
        ? graphicsProductionContract.environment
        : invalidDiscovery(),
    apiBaseUrl:
      value.apiBaseUrl === graphicsProductionContract.apiBaseUrl
        ? graphicsProductionContract.apiBaseUrl
        : invalidDiscovery(),
    operationsUrl:
      value.operationsUrl === graphicsProductionContract.operationsUrl
        ? graphicsProductionContract.operationsUrl
        : invalidDiscovery(),
    authorization: parseAuthorization(value.authorization),
    endpoints: {
      generateImage:
        value.endpoints.generateImage === graphicsProductionContract.generateImage
          ? graphicsProductionContract.generateImage
          : invalidDiscovery(),
    },
    imageGeneration: parseImageGeneration(value.imageGeneration),
    features: parseFeatures(value.features),
  })
}

export async function readBoundedResponseBytes(
  response: Response,
  maximumBytes: number,
  error: GraphicsCloudError,
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
  error: GraphicsCloudError,
): Promise<unknown> {
  const bytes = await readBoundedResponseBytes(response, maximumBytes, error)
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return JSON.parse(text)
  } catch {
    throw error
  }
}

export async function fetchGraphicsDiscovery(
  fetchImplementation: GraphicsFetch = fetch,
): Promise<GraphicsDiscoveryDocument> {
  const unavailable = new GraphicsCloudError(
    "DISCOVERY_UNAVAILABLE",
    "Graphics service discovery is unavailable.",
  )
  let response: Response
  try {
    response = await fetchImplementation(graphicsDiscoveryUrl, {
      headers: {
        accept: "application/json",
        "user-agent": "hraness-graphics-cli/0.4.0",
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    })
  } catch (cause) {
    throw new GraphicsCloudError(
      "DISCOVERY_UNAVAILABLE",
      "Graphics service discovery is unavailable.",
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
    throw new GraphicsCloudError(
      "DISCOVERY_INVALID",
      "Graphics service discovery returned an invalid content type.",
    )
  }
  const value = await readBoundedJson(
    response,
    graphicsDiscoveryMaximumBytes,
    new GraphicsCloudError(
      "DISCOVERY_INVALID",
      "Graphics service discovery returned an invalid contract.",
    ),
  )
  return parseGraphicsDiscovery(value)
}
