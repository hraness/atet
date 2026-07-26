import { describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import {
  buildGraphicsAuthorizationUrl,
  createPkcePair,
  getGraphicsAccessToken,
  graphicsAuthStatus,
  graphicsSecretsName,
  graphicsSecretsService,
  loginGraphics,
  logoutGraphics,
  type GraphicsSecretStore,
  type StoredGraphicsCredentials,
} from "./auth.ts"
import {
  graphicsDiscoveryUrl,
  graphicsImageModels,
  graphicsProductionContract,
  graphicsRedirectUri,
  parseGraphicsDiscovery,
  type GraphicsDiscoveryDocument,
} from "./discovery.ts"

class MemorySecrets implements GraphicsSecretStore {
  value: string | null = null

  async get(options: { readonly service: string; readonly name: string }) {
    expect(options).toEqual({
      service: graphicsSecretsService,
      name: graphicsSecretsName,
    })
    return this.value
  }

  async set(options: {
    readonly service: string
    readonly name: string
    readonly value: string
  }) {
    expect(options.service).toBe(graphicsSecretsService)
    expect(options.name).toBe(graphicsSecretsName)
    this.value = options.value
  }

  async delete(options: { readonly service: string; readonly name: string }) {
    expect(options).toEqual({
      service: graphicsSecretsService,
      name: graphicsSecretsName,
    })
    const existed = this.value !== null
    this.value = null
    return existed
  }
}

function discoveryValue(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    product: "graphics",
    environment: "production",
    apiBaseUrl: graphicsProductionContract.apiBaseUrl,
    operationsUrl: graphicsProductionContract.operationsUrl,
    authorization: {
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
    },
    endpoints: { generateImage: graphicsProductionContract.generateImage },
    imageGeneration: {
      models: graphicsImageModels,
      maximumPromptBytes: 8_192,
      maximumRawImageBytes: 3_145_728,
      imagesPerRequest: 1,
      responseMediaTypes: ["image/webp"],
      idempotency: {
        header: "Idempotency-Key",
        durable: false,
        scope: "process-local-mvp",
      },
    },
    features: {
      vectorize: {
        access: "authenticated",
        billing: "free",
        execution: "local",
      },
    },
  }
}

const discovery = parseGraphicsDiscovery(discoveryValue())

function credentials(
  overrides: Partial<StoredGraphicsCredentials> = {},
): StoredGraphicsCredentials {
  return {
    schemaVersion: 1,
    issuer: discovery.authorization.issuer,
    clientId: discovery.authorization.clientId,
    resource: discovery.authorization.resource,
    accessToken: "current-access-token",
    refreshToken: "current-refresh-token",
    expiresAt: 2_000_000,
    ...overrides,
  }
}

function discoveryResponse(): Response {
  return Response.json(discoveryValue())
}

describe("Graphics OAuth login", () => {
  test("builds a bounded S256 authorization request", () => {
    const pkce = createPkcePair()
    expect(pkce.verifier).toHaveLength(43)
    expect(pkce.challenge).toHaveLength(43)
    const state = "s".repeat(43)
    const url = new URL(
      buildGraphicsAuthorizationUrl(discovery, state, pkce.challenge),
    )
    expect(url.origin + url.pathname).toBe(
      graphicsProductionContract.authorizationEndpoint,
    )
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: graphicsProductionContract.clientId,
      redirect_uri: graphicsRedirectUri,
      scope: "openid offline_access",
      resource: graphicsProductionContract.resource,
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    })
  })

  test("refreshes once, rotates credentials, and forbids redirects", async () => {
    const secrets = new MemorySecrets()
    secrets.value = JSON.stringify(credentials({ expiresAt: 1 }))
    let calls = 0
    const accessToken = await getGraphicsAccessToken(discovery, {
      secrets,
      now: () => 1_000,
      fetch: async (input, init) => {
        calls += 1
        expect(String(input)).toBe(graphicsProductionContract.tokenEndpoint)
        expect(init?.redirect).toBe("error")
        expect(String(init?.body)).toContain("grant_type=refresh_token")
        expect(String(init?.body)).toContain(
          "refresh_token=current-refresh-token",
        )
        return Response.json({
          access_token: "rotated-access-token",
          refresh_token: "rotated-refresh-token",
          token_type: "Bearer",
          expires_in: 3_600,
        })
      },
    })
    expect(calls).toBe(1)
    expect(accessToken).toBe("rotated-access-token")
    expect(JSON.parse(secrets.value ?? "{}")).toMatchObject({
      accessToken: "rotated-access-token",
      refreshToken: "rotated-refresh-token",
      expiresAt: 3_601_000,
    })
  })

  test("rejects a token response without an explicit Bearer type", async () => {
    const secrets = new MemorySecrets()
    secrets.value = JSON.stringify(credentials({ expiresAt: 1 }))
    const before = secrets.value
    await expect(
      getGraphicsAccessToken(discovery, {
        secrets,
        now: () => 1_000,
        fetch: async () =>
          Response.json({
            access_token: "replacement-token",
            expires_in: 3_600,
          }),
      }),
    ).rejects.toThrow("[TOKEN_REFRESH_FAILED]")
    expect(secrets.value).toBe(before)
  })

  test("completes the fixed loopback callback before exchanging and stores only in secrets", async () => {
    const secrets = new MemorySecrets()
    let exchangeCalls = 0
    const status = await loginGraphics({
      secrets,
      now: () => 10_000,
      fetch: async (input, init) => {
        if (String(input) === graphicsDiscoveryUrl) return discoveryResponse()
        exchangeCalls += 1
        expect(String(input)).toBe(graphicsProductionContract.tokenEndpoint)
        expect(init?.redirect).toBe("error")
        const form = new URLSearchParams(String(init?.body))
        expect(form.get("grant_type")).toBe("authorization_code")
        expect(form.get("code")).toBe("bounded-code")
        expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/u)
        return Response.json({
          access_token: "login-access-token",
          refresh_token: "login-refresh-token",
          token_type: "Bearer",
          expires_in: 3_600,
        })
      },
      openUrl: async (authorizationUrl) => {
        const state = new URL(authorizationUrl).searchParams.get("state")
        expect(state).not.toBeNull()
        const callback = new URL(graphicsRedirectUri)
        callback.searchParams.set("state", state!)
        callback.searchParams.set("code", "bounded-code")
        const response = await fetch(callback)
        expect(response.status).toBe(200)
        expect(response.headers.get("connection")).toBe("close")
        // Some platform URL launchers do not exit until the browser closes.
        // The callback, not launcher process lifetime, completes login.
        await new Promise<void>(() => undefined)
      },
    })
    expect(exchangeCalls).toBe(1)
    expect(status).toMatchObject({ authenticated: true, refreshable: true })
    expect(JSON.parse(secrets.value ?? "{}")).toMatchObject({
      accessToken: "login-access-token",
      refreshToken: "login-refresh-token",
    })
  })

  test("closes the loopback listener when opening the browser fails", async () => {
    const secrets = new MemorySecrets()
    const unhandled: unknown[] = []
    const observeUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", observeUnhandled)
    try {
      await expect(
        loginGraphics({
          secrets,
          fetch: async () => discoveryResponse(),
          openUrl: async () => {
            throw new Error("browser unavailable with private detail")
          },
        }),
      ).rejects.toThrow("[AUTHORIZATION_FAILED]")
      await Bun.sleep(0)
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", observeUnhandled)
    }

    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(49_671, "127.0.0.1", () => resolve())
    })
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  test("reports status without tokens and revokes before removing local credentials", async () => {
    const secrets = new MemorySecrets()
    secrets.value = JSON.stringify(credentials())
    const status = await graphicsAuthStatus({ secrets, now: () => 1_000 })
    expect(status).toEqual({
      authenticated: true,
      expiresAt: new Date(2_000_000).toISOString(),
      refreshable: true,
    })
    expect(JSON.stringify(status)).not.toContain("token")

    const foreignSecrets = new MemorySecrets()
    foreignSecrets.value = JSON.stringify(
      credentials({ issuer: "https://foreign.example" }),
    )
    expect(
      await graphicsAuthStatus({ secrets: foreignSecrets, now: () => 1_000 }),
    ).toEqual({
      authenticated: false,
      expiresAt: null,
      refreshable: false,
    })

    const requests: string[] = []
    const result = await logoutGraphics({
      secrets,
      fetch: async (input, init) => {
        requests.push(String(input))
        if (String(input) === graphicsDiscoveryUrl) return discoveryResponse()
        expect(init?.redirect).toBe("error")
        expect(String(init?.body)).toContain(
          "token=current-refresh-token",
        )
        return new Response(null, { status: 200 })
      },
    })
    expect(requests).toEqual([
      graphicsDiscoveryUrl,
      graphicsProductionContract.revocationEndpoint,
    ])
    expect(result).toEqual({ removed: true, revoked: true })
    expect(secrets.value).toBeNull()
  })
})
