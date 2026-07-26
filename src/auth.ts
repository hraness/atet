import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { createServer, type Server } from "node:http"
import {
  fetchGraphicsDiscovery,
  graphicsProductionContract,
  graphicsRedirectUri,
  parseGraphicsDiscovery,
  readBoundedResponseBytes,
  type GraphicsDiscoveryDocument,
  type GraphicsFetch,
} from "./discovery.ts"
import { GraphicsCloudError } from "./cloud-errors.ts"
import {
  acquireGraphicsCredentialMutationLease,
  assertGraphicsCredentialMutationPlatformSupported,
  throwIfGraphicsCredentialMutationCancelled,
  type GraphicsCredentialMutationLeaseOptions,
} from "./credential-lease.ts"

export type { GraphicsCredentialMutationLeaseOptions } from "./credential-lease.ts"

export const graphicsSecretsService = "com.hraness.graphics.cli"
export const graphicsSecretsName = "oauth2-tokens"

const tokenResponseMaximumBytes = 64 * 1024
const authorizationResponseMaximumBytes = 32 * 1024
const authorizationLaunchUrlMaximumBytes = 16 * 1024
const storedCredentialMaximumBytes = 64 * 1024
const maximumTokenLength = 16 * 1024
const callbackPort = 49_671
const callbackPath = "/oauth/callback"
const callbackMaximumRequests = 32
const expirySkewMilliseconds = 60_000
const maximumExpiresInSeconds = 365 * 24 * 60 * 60

export interface GraphicsSecretStore {
  get(options: { readonly service: string; readonly name: string }): Promise<string | null>
  set(options: {
    readonly service: string
    readonly name: string
    readonly value: string
  }): Promise<void>
  delete(options: { readonly service: string; readonly name: string }): Promise<boolean>
}

export interface StoredGraphicsCredentials {
  readonly schemaVersion: 1
  readonly issuer: string
  readonly clientId: string
  readonly resource: string
  readonly accessToken: string
  readonly refreshToken?: string
  readonly expiresAt: number
}

export interface GraphicsAuthStatus {
  readonly authenticated: boolean
  readonly expiresAt: string | null
  readonly refreshable: boolean
}

export interface GraphicsAuthDependencies {
  readonly fetch?: GraphicsFetch
  readonly now?: () => number
  readonly openUrl?: (url: string) => Promise<void>
  readonly secrets?: GraphicsSecretStore
  readonly credentialLease?: GraphicsCredentialMutationLeaseOptions
}

function secretStore(
  dependencies: GraphicsAuthDependencies,
): GraphicsSecretStore {
  return dependencies.secrets ?? Bun.secrets
}

function boundedToken(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximumTokenLength ||
    /[\u0000-\u0020\u007f]/u.test(value)
  ) {
    throw new GraphicsCloudError(
      "TOKEN_EXCHANGE_FAILED",
      "Graphics rejected the authorization token response.",
    )
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseStoredCredentials(value: string): StoredGraphicsCredentials {
  if (Buffer.byteLength(value, "utf8") > storedCredentialMaximumBytes) {
    throw new GraphicsCloudError(
      "TOKEN_STORAGE_FAILED",
      "Stored Graphics credentials are invalid.",
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new GraphicsCloudError(
      "TOKEN_STORAGE_FAILED",
      "Stored Graphics credentials are invalid.",
    )
  }
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== 1 ||
    typeof parsed.issuer !== "string" ||
    parsed.issuer.length > 2_048 ||
    typeof parsed.clientId !== "string" ||
    parsed.clientId.length > 256 ||
    typeof parsed.resource !== "string" ||
    parsed.resource.length > 2_048 ||
    !Number.isSafeInteger(parsed.expiresAt) ||
    (parsed.expiresAt as number) < 0 ||
    (parsed.expiresAt as number) > 8_640_000_000_000_000
  ) {
    throw new GraphicsCloudError(
      "TOKEN_STORAGE_FAILED",
      "Stored Graphics credentials are invalid.",
    )
  }
  let accessToken: string
  let refreshToken: string | undefined
  try {
    accessToken = boundedToken(parsed.accessToken)
    refreshToken =
      parsed.refreshToken === undefined
        ? undefined
        : boundedToken(parsed.refreshToken)
  } catch (cause) {
    throw new GraphicsCloudError(
      "TOKEN_STORAGE_FAILED",
      "Stored Graphics credentials are invalid.",
      { cause },
    )
  }
  const keys = Object.keys(parsed)
  if (
    keys.some(
      (key) =>
        ![
          "schemaVersion",
          "issuer",
          "clientId",
          "resource",
          "accessToken",
          "refreshToken",
          "expiresAt",
        ].includes(key),
    )
  ) {
    throw new GraphicsCloudError(
      "TOKEN_STORAGE_FAILED",
      "Stored Graphics credentials are invalid.",
    )
  }
  return {
    schemaVersion: 1,
    issuer: parsed.issuer,
    clientId: parsed.clientId,
    resource: parsed.resource,
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    expiresAt: parsed.expiresAt as number,
  }
}

async function loadCredentials(
  dependencies: GraphicsAuthDependencies,
): Promise<StoredGraphicsCredentials | null> {
  let stored: string | null
  try {
    stored = await secretStore(dependencies).get({
      service: graphicsSecretsService,
      name: graphicsSecretsName,
    })
  } catch (cause) {
    throw new GraphicsCloudError(
      "TOKEN_STORAGE_FAILED",
      "Graphics could not read credentials from the operating-system credential store.",
      { cause },
    )
  }
  return stored === null ? null : parseStoredCredentials(stored)
}

async function storeCredentials(
  credentials: StoredGraphicsCredentials,
  dependencies: GraphicsAuthDependencies,
): Promise<void> {
  const value = JSON.stringify(credentials)
  if (Buffer.byteLength(value, "utf8") > storedCredentialMaximumBytes) {
    throw new GraphicsCloudError(
      "TOKEN_STORAGE_FAILED",
      "Graphics credentials exceed the credential-store limit.",
    )
  }
  try {
    await secretStore(dependencies).set({
      service: graphicsSecretsService,
      name: graphicsSecretsName,
      value,
    })
  } catch (cause) {
    throw new GraphicsCloudError(
      "TOKEN_STORAGE_FAILED",
      "Graphics could not write credentials to the operating-system credential store.",
      { cause },
    )
  }
}

async function deleteCredentials(
  dependencies: GraphicsAuthDependencies,
): Promise<boolean> {
  try {
    return await secretStore(dependencies).delete({
      service: graphicsSecretsService,
      name: graphicsSecretsName,
    })
  } catch (cause) {
    throw new GraphicsCloudError(
      "TOKEN_STORAGE_FAILED",
      "Graphics could not remove credentials from the operating-system credential store.",
      { cause },
    )
  }
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url")
}

export function createPkcePair(): {
  readonly verifier: string
  readonly challenge: string
} {
  const verifier = base64Url(randomBytes(32))
  const challenge = createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64url")
  return { verifier, challenge }
}

export function buildGraphicsAuthorizationUrl(
  discovery: GraphicsDiscoveryDocument,
  state: string,
  challenge: string,
): string {
  const trustedDiscovery = parseGraphicsDiscovery(discovery)
  if (
    state.length < 32 ||
    state.length > 256 ||
    challenge.length !== 43 ||
    !/^[A-Za-z0-9_-]+$/u.test(state) ||
    !/^[A-Za-z0-9_-]+$/u.test(challenge)
  ) {
    throw new GraphicsCloudError(
      "INVALID_ARGUMENT",
      "Invalid OAuth state or PKCE challenge.",
    )
  }
  const url = new URL(trustedDiscovery.authorization.authorizationEndpoint)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", trustedDiscovery.authorization.clientId)
  url.searchParams.set("redirect_uri", graphicsRedirectUri)
  url.searchParams.set("scope", trustedDiscovery.authorization.scopes.join(" "))
  url.searchParams.set("resource", trustedDiscovery.authorization.resource)
  url.searchParams.set("state", state)
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  return url.href
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8")
  const rightBytes = Buffer.from(right, "utf8")
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  )
}

function callbackPage(success: boolean): string {
  return [
    "<!doctype html>",
    '<meta charset="utf-8">',
    `<title>Graphics ${success ? "login complete" : "login failed"}</title>`,
    `<p>Graphics login ${success ? "is complete. You can close this window." : "could not be completed. Return to the terminal."}</p>`,
  ].join("")
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
}

interface AuthorizationCallbackListener {
  readonly code: Promise<string>
  readonly close: () => Promise<void>
}

async function startAuthorizationCallback(
  expectedState: string,
  timeoutMilliseconds: number,
): Promise<AuthorizationCallbackListener> {
  let resolveCode!: (code: string) => void
  let rejectCode!: (error: Error) => void
  let settled = false
  let requestCount = 0
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  const server = createServer((request, response) => {
    requestCount += 1
    response.setHeader("connection", "close")
    response.setHeader("cache-control", "no-store")
    response.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
    response.setHeader("content-type", "text/html; charset=utf-8")
    if (requestCount > callbackMaximumRequests) {
      response.statusCode = 429
      response.end(callbackPage(false))
      if (!settled) {
        settled = true
        rejectCode(
          new GraphicsCloudError(
            "AUTHORIZATION_FAILED",
            "Graphics login received too many invalid callback requests.",
          ),
        )
      }
      return
    }
    if (
      request.method !== "GET" ||
      request.headers.host !== `127.0.0.1:${callbackPort}`
    ) {
      response.statusCode = 404
      response.end(callbackPage(false))
      return
    }
    let url: URL
    try {
      if ((request.url?.length ?? 0) > 8_192) throw new Error("oversized callback")
      url = new URL(request.url ?? "", graphicsRedirectUri)
    } catch {
      response.statusCode = 400
      response.end(callbackPage(false))
      return
    }
    if (url.pathname !== callbackPath) {
      response.statusCode = 404
      response.end(callbackPage(false))
      return
    }
    const states = url.searchParams.getAll("state")
    if (
      states.length !== 1 ||
      states[0] === undefined ||
      states[0].length > 256 ||
      !safeEqual(states[0], expectedState)
    ) {
      response.statusCode = 400
      response.end(callbackPage(false))
      return
    }
    const oauthErrors = url.searchParams.getAll("error")
    if (oauthErrors.length > 0) {
      response.statusCode = 400
      response.end(callbackPage(false))
      if (!settled) {
        settled = true
        rejectCode(
          new GraphicsCloudError(
            "AUTHORIZATION_FAILED",
            "Graphics authorization was denied or failed.",
          ),
        )
      }
      return
    }
    const codes = url.searchParams.getAll("code")
    const code = codes[0]
    if (
      codes.length !== 1 ||
      code === undefined ||
      code.length < 1 ||
      code.length > 4_096 ||
      /[\u0000-\u0020\u007f]/u.test(code)
    ) {
      response.statusCode = 400
      response.end(callbackPage(false))
      return
    }
    response.statusCode = 200
    response.end(callbackPage(true))
    if (!settled) {
      settled = true
      resolveCode(code)
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(callbackPort, "127.0.0.1", () => resolve())
  }).catch((cause) => {
    throw new GraphicsCloudError(
      "AUTH_CALLBACK_UNAVAILABLE",
      `Graphics login requires ${graphicsRedirectUri}, but the loopback callback could not start.`,
      { cause },
    )
  })

  const timeout = setTimeout(() => {
    if (settled) return
    settled = true
    rejectCode(
      new GraphicsCloudError(
        "AUTH_TIMEOUT",
        "Graphics login timed out before authorization completed.",
      ),
    )
  }, timeoutMilliseconds)

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    clearTimeout(timeout)
    if (!settled) {
      settled = true
      rejectCode(
        new GraphicsCloudError(
          "AUTHORIZATION_FAILED",
          "Graphics login was cancelled before authorization completed.",
        ),
      )
    }
    server.closeIdleConnections()
    server.closeAllConnections()
    await closeServer(server)
  }
  return { code: codePromise, close }
}

async function defaultOpenUrl(url: string): Promise<void> {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["rundll32", "url.dll,FileProtocolHandler", url]
        : ["xdg-open", url]
  let subprocess: ReturnType<typeof Bun.spawn>
  try {
    subprocess = Bun.spawn(command, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
  } catch (cause) {
    throw new GraphicsCloudError(
      "AUTHORIZATION_FAILED",
      "Graphics could not open the authorization page.",
      { cause },
    )
  }
  const exitCode = await Promise.race([
    subprocess.exited,
    Bun.sleep(10_000).then(() => null),
  ])
  if (exitCode === null) {
    subprocess.kill()
    await subprocess.exited.catch(() => undefined)
  }
  if (exitCode !== 0) {
    throw new GraphicsCloudError(
      "AUTHORIZATION_FAILED",
      "Graphics could not open the authorization page.",
    )
  }
}

function authorizationLaunchFailure(options?: ErrorOptions): GraphicsCloudError {
  return new GraphicsCloudError(
    "AUTHORIZATION_FAILED",
    "Graphics could not start the authorization flow.",
    options,
  )
}

function validateAuthorizationLaunchUrl(
  discovery: GraphicsDiscoveryDocument,
  value: unknown,
): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    Buffer.byteLength(value, "utf8") > authorizationLaunchUrlMaximumBytes ||
    /[\u0000-\u0020\u007f]/u.test(value) ||
    value.includes("\\") ||
    value.includes("#")
  ) {
    throw authorizationLaunchFailure()
  }

  const isRootRelative = value.startsWith("/") && !value.startsWith("//")
  const isHttpsAbsolute = /^https:\/\//iu.test(value)
  if (!isRootRelative && !isHttpsAbsolute) {
    throw authorizationLaunchFailure()
  }
  if (/^https:\/\/[^/?#]*@/iu.test(value)) {
    throw authorizationLaunchFailure()
  }

  let url: URL
  let issuer: URL
  try {
    issuer = new URL(discovery.authorization.issuer)
    url = new URL(value, issuer)
  } catch {
    throw authorizationLaunchFailure()
  }
  if (
    url.protocol !== "https:" ||
    url.origin !== issuer.origin ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw authorizationLaunchFailure()
  }
  return url.href
}

async function fetchAuthorizationLaunchUrl(
  discovery: GraphicsDiscoveryDocument,
  authorizationUrl: string,
  dependencies: GraphicsAuthDependencies,
): Promise<string> {
  let response: Response
  try {
    response = await (dependencies.fetch ?? fetch)(authorizationUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "hraness-graphics-cli/0.4.0",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    })
  } catch (cause) {
    throw authorizationLaunchFailure({ cause })
  }

  if (response.redirected) {
    await response.body?.cancel().catch(() => undefined)
    throw authorizationLaunchFailure()
  }

  if (response.status >= 300 && response.status <= 399) {
    const location = response.headers.get("location")
    await response.body?.cancel().catch(() => undefined)
    return validateAuthorizationLaunchUrl(discovery, location)
  }

  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined)
    throw authorizationLaunchFailure()
  }
  const contentType = response.headers.get("content-type")
  if (
    contentType === null ||
    !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/iu.test(
      contentType,
    )
  ) {
    await response.body?.cancel().catch(() => undefined)
    throw authorizationLaunchFailure()
  }

  const failure = authorizationLaunchFailure()
  const bytes = await readBoundedResponseBytes(
    response,
    authorizationResponseMaximumBytes,
    failure,
  )
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw failure
  }
  if (
    !isRecord(value) ||
    value.redirect !== true ||
    Object.keys(value).length !== 2 ||
    !("url" in value)
  ) {
    throw failure
  }
  return validateAuthorizationLaunchUrl(discovery, value.url)
}

interface TokenResponse {
  readonly accessToken: string
  readonly refreshToken?: string
  readonly expiresIn: number
}

async function tokenRequest(
  discovery: GraphicsDiscoveryDocument,
  body: URLSearchParams,
  failureCode: "TOKEN_EXCHANGE_FAILED" | "TOKEN_REFRESH_FAILED",
  dependencies: GraphicsAuthDependencies,
): Promise<TokenResponse> {
  const failure = new GraphicsCloudError(
    failureCode,
    failureCode === "TOKEN_EXCHANGE_FAILED"
      ? "Graphics could not exchange the authorization code."
      : "Graphics could not refresh the login.",
  )
  let response: Response
  try {
    response = await (dependencies.fetch ?? fetch)(
      discovery.authorization.tokenEndpoint,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": "hraness-graphics-cli/0.4.0",
        },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    )
  } catch (cause) {
    throw new GraphicsCloudError(failureCode, failure.message.slice(failure.message.indexOf("]") + 2), {
      cause,
    })
  }
  const contentType = response.headers.get("content-type")
  if (
    contentType === null ||
    !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/iu.test(
      contentType,
    )
  ) {
    await response.body?.cancel().catch(() => undefined)
    throw failure
  }
  const bytes = await readBoundedResponseBytes(
    response,
    tokenResponseMaximumBytes,
    failure,
  )
  if (!response.ok) throw failure
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw failure
  }
  if (
    !isRecord(value) ||
    typeof value.token_type !== "string" ||
    value.token_type.toLowerCase() !== "bearer" ||
    !Number.isSafeInteger(value.expires_in) ||
    (value.expires_in as number) < 1 ||
    (value.expires_in as number) > maximumExpiresInSeconds
  ) {
    throw failure
  }
  let accessToken: string
  let refreshToken: string | undefined
  try {
    accessToken = boundedToken(value.access_token)
    refreshToken =
      value.refresh_token === undefined
        ? undefined
        : boundedToken(value.refresh_token)
  } catch {
    throw failure
  }
  return {
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    expiresIn: value.expires_in as number,
  }
}

function credentialsFromToken(
  discovery: GraphicsDiscoveryDocument,
  token: TokenResponse,
  now: number,
  retainedRefreshToken?: string,
): StoredGraphicsCredentials {
  const refreshToken = token.refreshToken ?? retainedRefreshToken
  return {
    schemaVersion: 1,
    issuer: discovery.authorization.issuer,
    clientId: discovery.authorization.clientId,
    resource: discovery.authorization.resource,
    accessToken: token.accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    expiresAt: now + token.expiresIn * 1_000,
  }
}

export async function loginGraphics(
  dependencies: GraphicsAuthDependencies = {},
): Promise<GraphicsAuthStatus> {
  assertGraphicsCredentialMutationPlatformSupported("login")
  const discovery = await fetchGraphicsDiscovery(dependencies.fetch)
  const { verifier, challenge } = createPkcePair()
  const state = base64Url(randomBytes(32))
  // Listener readiness is awaited before opening the browser so an immediate
  // redirect cannot race the fixed loopback callback.
  const callback = await startAuthorizationCallback(state, 5 * 60_000)
  // Attach a rejection observer before any operation that can fail and close
  // the listener. Awaiting the original promise below still preserves errors.
  void callback.code.catch(() => undefined)
  const authorizationUrl = buildGraphicsAuthorizationUrl(
    discovery,
    state,
    challenge,
  )
  try {
    const launch = (async () => {
      try {
        const launchUrl = await fetchAuthorizationLaunchUrl(
          discovery,
          authorizationUrl,
          dependencies,
        )
        await (dependencies.openUrl ?? defaultOpenUrl)(launchUrl)
      } catch (cause) {
        if (cause instanceof GraphicsCloudError) throw cause
        throw new GraphicsCloudError(
          "AUTHORIZATION_FAILED",
          "Graphics could not open the authorization page.",
          { cause },
        )
      }
    })()
    void launch.catch(() => undefined)
    const code = await Promise.race([
      callback.code,
      launch.then(() => callback.code),
    ])
    await callback.close()
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: graphicsRedirectUri,
      client_id: discovery.authorization.clientId,
      resource: discovery.authorization.resource,
      code_verifier: verifier,
    })
    const token = await tokenRequest(
      discovery,
      form,
      "TOKEN_EXCHANGE_FAILED",
      dependencies,
    )
    const now = (dependencies.now ?? Date.now)()
    const credentials = credentialsFromToken(discovery, token, now)
    const lease = await acquireGraphicsCredentialMutationLease(
      dependencies,
      "login",
    )
    try {
      throwIfGraphicsCredentialMutationCancelled(dependencies, "login")
      // Reread after acquiring the shared mutation lease. A login deliberately
      // replaces whichever credential state won the preceding mutation.
      await loadCredentials(dependencies)
      await lease.assertOwned()
      throwIfGraphicsCredentialMutationCancelled(dependencies, "login")
      await storeCredentials(credentials, dependencies)
    } finally {
      await lease.release()
    }
    return {
      authenticated: true,
      expiresAt: new Date(credentials.expiresAt).toISOString(),
      refreshable: credentials.refreshToken !== undefined,
    }
  } finally {
    await callback.close()
  }
}

function credentialsMatchDiscovery(
  credentials: StoredGraphicsCredentials,
  discovery: GraphicsDiscoveryDocument,
): boolean {
  return (
    credentials.issuer === discovery.authorization.issuer &&
    credentials.clientId === discovery.authorization.clientId &&
    credentials.resource === discovery.authorization.resource
  )
}

async function refreshAccessToken(
  discovery: GraphicsDiscoveryDocument,
  dependencies: GraphicsAuthDependencies,
): Promise<string> {
  const lease = await acquireGraphicsCredentialMutationLease(
    dependencies,
    "refresh",
  )
  try {
    const credentials = await loadCredentials(dependencies)
    if (
      credentials === null ||
      !credentialsMatchDiscovery(credentials, discovery)
    ) {
      throw new GraphicsCloudError(
        "AUTH_REQUIRED",
        "Graphics login is missing or expired. Run `graphics login`.",
      )
    }
    const now = (dependencies.now ?? Date.now)()
    if (credentials.expiresAt > now + expirySkewMilliseconds) {
      return credentials.accessToken
    }
    const refreshToken = credentials.refreshToken
    if (refreshToken === undefined) {
      throw new GraphicsCloudError(
        "AUTH_REQUIRED",
        "Graphics login is missing or expired. Run `graphics login`.",
      )
    }
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: discovery.authorization.clientId,
      resource: discovery.authorization.resource,
    })
    await lease.assertOwned()
    // Cancellation has a precise dispatch boundary: it is honored after the
    // asynchronous credential reread and ownership check, immediately before
    // the refresh POST. Once dispatched, the bounded exchange and credential
    // write complete so a rotated response is never discarded locally.
    throwIfGraphicsCredentialMutationCancelled(dependencies, "refresh")
    const token = await tokenRequest(
      discovery,
      form,
      "TOKEN_REFRESH_FAILED",
      dependencies,
    )
    const next = credentialsFromToken(
      discovery,
      token,
      (dependencies.now ?? Date.now)(),
      refreshToken,
    )
    await lease.assertOwned()
    await storeCredentials(next, dependencies)
    return next.accessToken
  } finally {
    await lease.release()
  }
}

export async function getGraphicsAccessToken(
  discovery: GraphicsDiscoveryDocument,
  dependencies: GraphicsAuthDependencies = {},
): Promise<string> {
  const trustedDiscovery = parseGraphicsDiscovery(discovery)
  const credentials = await loadCredentials(dependencies)
  if (
    credentials === null ||
    credentials.issuer !== trustedDiscovery.authorization.issuer ||
    credentials.clientId !== trustedDiscovery.authorization.clientId ||
    credentials.resource !== trustedDiscovery.authorization.resource
  ) {
    throw new GraphicsCloudError(
      "AUTH_REQUIRED",
      "Graphics login is missing or expired. Run `graphics login`.",
    )
  }
  const now = (dependencies.now ?? Date.now)()
  if (credentials.expiresAt > now + expirySkewMilliseconds) {
    return credentials.accessToken
  }
  return refreshAccessToken(trustedDiscovery, dependencies)
}

/**
 * Prove that a current Graphics login exists for a local authenticated
 * feature. The access token is intentionally not returned because callers
 * such as vectorization do not send it or any source bytes to a server.
 */
export async function requireGraphicsAuthentication(
  dependencies: GraphicsAuthDependencies = {},
): Promise<GraphicsDiscoveryDocument> {
  const discovery = await fetchGraphicsDiscovery(dependencies.fetch)
  await getGraphicsAccessToken(discovery, dependencies)
  return discovery
}

export async function graphicsAuthStatus(
  dependencies: GraphicsAuthDependencies = {},
): Promise<GraphicsAuthStatus> {
  const credentials = await loadCredentials(dependencies)
  if (credentials === null) {
    return { authenticated: false, expiresAt: null, refreshable: false }
  }
  if (
    credentials.issuer !== graphicsProductionContract.issuer ||
    credentials.clientId !== graphicsProductionContract.clientId ||
    credentials.resource !== graphicsProductionContract.resource
  ) {
    return { authenticated: false, expiresAt: null, refreshable: false }
  }
  return {
    authenticated:
      credentials.expiresAt > (dependencies.now ?? Date.now)() ||
      credentials.refreshToken !== undefined,
    expiresAt: new Date(credentials.expiresAt).toISOString(),
    refreshable: credentials.refreshToken !== undefined,
  }
}

export async function logoutGraphics(
  dependencies: GraphicsAuthDependencies = {},
): Promise<{ readonly removed: boolean; readonly revoked: boolean }> {
  assertGraphicsCredentialMutationPlatformSupported("logout")
  const lease = await acquireGraphicsCredentialMutationLease(
    dependencies,
    "logout",
  )
  try {
    const credentials = await loadCredentials(dependencies)
    if (credentials === null) return { removed: false, revoked: false }

    let revocationError: GraphicsCloudError | undefined
    let revoked = false
    try {
      const discovery = await fetchGraphicsDiscovery(dependencies.fetch)
      if (!credentialsMatchDiscovery(credentials, discovery)) {
        throw new GraphicsCloudError(
          "REVOCATION_FAILED",
          "Graphics could not verify the stored login before revocation.",
        )
      }
      const token = credentials.refreshToken ?? credentials.accessToken
      const tokenTypeHint =
        credentials.refreshToken === undefined
          ? "access_token"
          : "refresh_token"
      let response: Response
      try {
        await lease.assertOwned()
        response = await (dependencies.fetch ?? fetch)(
          discovery.authorization.revocationEndpoint,
          {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/x-www-form-urlencoded",
              "user-agent": "hraness-graphics-cli/0.4.0",
            },
            body: new URLSearchParams({
              token,
              token_type_hint: tokenTypeHint,
              client_id: discovery.authorization.clientId,
            }),
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
          },
        )
      } catch (cause) {
        throw new GraphicsCloudError(
          "REVOCATION_FAILED",
          "Graphics could not revoke the remote login.",
          { cause },
        )
      }
      await readBoundedResponseBytes(
        response,
        16 * 1024,
        new GraphicsCloudError(
          "REVOCATION_FAILED",
          "Graphics received an invalid revocation response.",
        ),
      )
      if (!response.ok) {
        throw new GraphicsCloudError(
          "REVOCATION_FAILED",
          "Graphics could not revoke the remote login.",
        )
      }
      revoked = true
    } catch (error) {
      revocationError =
        error instanceof GraphicsCloudError
          ? error
          : new GraphicsCloudError(
              "REVOCATION_FAILED",
              "Graphics could not revoke the remote login.",
              { cause: error },
            )
    }

    await lease.assertOwned()
    const removed = await deleteCredentials(dependencies)
    if (revocationError !== undefined) throw revocationError
    return { removed, revoked }
  } finally {
    await lease.release()
  }
}
