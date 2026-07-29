import { describe, expect, test } from "bun:test"
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import {
  buildTransmuteAuthorizationUrl,
  createPkcePair,
  getTransmuteAccessToken,
  transmuteAuthStatus,
  transmuteSecretsName,
  transmuteSecretsService,
  loginTransmute,
  logoutTransmute,
  type TransmuteSecretStore,
  type StoredTransmuteCredentials,
} from "./auth.ts"
import {
  transmuteDiscoveryUrl,
  transmuteImageModels,
  transmuteProductionContract,
  transmuteRedirectUri,
  parseTransmuteDiscovery,
} from "./discovery.ts"
import { acquireTransmuteCredentialMutationLease } from "./credential-lease.ts"
import {
  oauthCallbackTestTimeoutMilliseconds,
  withOAuthCallbackTestLease,
} from "./oauth-callback.test-support.ts"

function oauthCallbackTest(
  name: string,
  run: () => Promise<void>,
): void {
  test(
    name,
    () => withOAuthCallbackTestLease(run),
    oauthCallbackTestTimeoutMilliseconds,
  )
}

interface MemorySecretsHooks {
  readonly beforeGet?: (call: number) => Promise<void> | void
  readonly beforeSet?: (call: number, value: string) => Promise<void> | void
  readonly beforeDelete?: (call: number) => Promise<void> | void
}

class MemorySecrets implements TransmuteSecretStore {
  readonly state: { value: string | null }
  readonly hooks: MemorySecretsHooks
  getCalls = 0
  setCalls = 0
  deleteCalls = 0

  constructor(
    state: { value: string | null } = { value: null },
    hooks: MemorySecretsHooks = {},
  ) {
    this.state = state
    this.hooks = hooks
  }

  get value(): string | null {
    return this.state.value
  }

  set value(value: string | null) {
    this.state.value = value
  }

  async get(options: { readonly service: string; readonly name: string }) {
    expect(options).toEqual({
      service: transmuteSecretsService,
      name: transmuteSecretsName,
    })
    this.getCalls += 1
    await this.hooks.beforeGet?.(this.getCalls)
    return this.value
  }

  async set(options: {
    readonly service: string
    readonly name: string
    readonly value: string
  }) {
    expect(options.service).toBe(transmuteSecretsService)
    expect(options.name).toBe(transmuteSecretsName)
    this.setCalls += 1
    await this.hooks.beforeSet?.(this.setCalls, options.value)
    this.value = options.value
  }

  async delete(options: { readonly service: string; readonly name: string }) {
    expect(options).toEqual({
      service: transmuteSecretsService,
      name: transmuteSecretsName,
    })
    this.deleteCalls += 1
    await this.hooks.beforeDelete?.(this.deleteCalls)
    const existed = this.value !== null
    this.value = null
    return existed
  }
}

function discoveryValue(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    product: "transmute",
    environment: "production",
    capabilities: {
      media: {
        apiBaseUrl: transmuteProductionContract.apiBaseUrl,
        operationsUrl: transmuteProductionContract.operationsUrl,
        authorization: {
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
        },
        endpoints: { generateImage: transmuteProductionContract.generateImage },
        imageGeneration: {
          access: "authenticated",
          billing: "free-preview",
          models: transmuteImageModels,
          maximumPromptBytes: 8_192,
          maximumRawImageBytes: 3_145_728,
          imagesPerRequest: 1,
          responseMediaTypes: ["image/webp"],
          quota: {
            accountDailyLimit: 10,
            globalDailySafetyLimit: 100,
            paymentEnforced: false,
            period: "utc-day",
          },
          idempotency: {
            header: "Idempotency-Key",
            durable: true,
            scope: "suite-account",
          },
        },
        vectorize: {
          access: "local",
          billing: "free",
          execution: "local",
        },
      },
      desktop: { availability: "unavailable" },
    },
  }
}

const discovery = parseTransmuteDiscovery(discoveryValue())

function credentials(
  overrides: Partial<StoredTransmuteCredentials> = {},
): StoredTransmuteCredentials {
  return {
    schemaVersion: 1,
    issuer: discovery.capabilities.media.authorization.issuer,
    clientId: discovery.capabilities.media.authorization.clientId,
    resource: discovery.capabilities.media.authorization.resource,
    accessToken: "current-access-token",
    refreshToken: "current-refresh-token",
    expiresAt: 2_000_000,
    ...overrides,
  }
}

function discoveryResponse(): Response {
  return Response.json(discoveryValue())
}

function isAuthorizationRequest(input: string | URL | Request): boolean {
  const url = new URL(String(input))
  return url.origin + url.pathname ===
    transmuteProductionContract.authorizationEndpoint
}

function authorizationBootstrapResponse(
  input: string | URL | Request,
): Response {
  const state = new URL(String(input)).searchParams.get("state")
  expect(state).not.toBeNull()
  return Response.json({
    redirect: true,
    url: `/login?state=${encodeURIComponent(state!)}`,
  })
}

function deferred(): {
  readonly promise: Promise<void>
  readonly resolve: () => void
} {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitForLeaseMarkers(
  directory: string,
  minimum: number,
): Promise<readonly string[]> {
  const deadline = performance.now() + 5_000
  for (;;) {
    const markers = (await readdir(directory)).filter((entry) =>
      entry.startsWith("lease-v4-"),
    )
    if (markers.length >= minimum) return markers
    if (performance.now() >= deadline) break
    await Bun.sleep(2)
  }
  throw new Error("credential lease contenders were not published")
}

async function currentProcessLeaseIdentity(directory: string): Promise<
  Readonly<{ processScopeIdentity: string; processIdentity: string }>
> {
  const lease = await acquireTransmuteCredentialMutationLease(
    {
      credentialLease: {
        directory,
        pollIntervalMilliseconds: 1,
        staleAfterMilliseconds: 100,
        waitTimeoutMilliseconds: 1_000,
      },
    },
    "refresh",
  )
  try {
    const markers = await waitForLeaseMarkers(directory, 1)
    const match =
      /^lease-v4-[0-9a-f]{16}-([0-9a-f]{32})-\d+-([0-9a-f]{32})-[0-9a-f]{32}$/u
        .exec(markers[0] ?? "")
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error("credential lease process identity was not published")
    }
    return {
      processScopeIdentity: match[1],
      processIdentity: match[2],
    }
  } finally {
    await lease.release()
  }
}

async function completeLoginCallback(
  authorizationUrl: string,
  code: string,
): Promise<void> {
  const state = new URL(authorizationUrl).searchParams.get("state")
  expect(state).not.toBeNull()
  const callback = new URL(transmuteRedirectUri)
  callback.searchParams.set("state", state!)
  callback.searchParams.set("code", code)
  const response = await fetch(callback)
  expect(response.status).toBe(200)
  expect(response.headers.get("connection")).toBe("close")
}

describe("Transmute OAuth login", () => {
  test("builds a bounded S256 authorization request", () => {
    const pkce = createPkcePair()
    expect(pkce.verifier).toHaveLength(43)
    expect(pkce.challenge).toHaveLength(43)
    const state = "s".repeat(43)
    const url = new URL(
      buildTransmuteAuthorizationUrl(discovery, state, pkce.challenge),
    )
    expect(url.origin + url.pathname).toBe(
      transmuteProductionContract.authorizationEndpoint,
    )
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      client_id: transmuteProductionContract.clientId,
      redirect_uri: transmuteRedirectUri,
      scope: "openid offline_access",
      resource: transmuteProductionContract.resource,
      state,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    })
  })

  test("refreshes once, rotates credentials, and forbids redirects", async () => {
    const secrets = new MemorySecrets()
    secrets.value = JSON.stringify(credentials({ expiresAt: 1 }))
    let calls = 0
    const accessToken = await getTransmuteAccessToken(discovery, {
      secrets,
      now: () => 1_000,
      fetch: async (input, init) => {
        calls += 1
        expect(String(input)).toBe(transmuteProductionContract.tokenEndpoint)
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

  test("serializes process-like contenders, rereads secrets inside the lease, and writes no tokens to files", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "transmute-refresh-lease-test-"),
    )
    const sharedState = {
      value: JSON.stringify(credentials({ expiresAt: 1 })),
    }
    const firstSecrets = new MemorySecrets(sharedState)
    const secondSecrets = new MemorySecrets(sharedState)
    let releaseResponse: (() => void) | undefined
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve
    })
    let markRequestStarted!: () => void
    const requestStarted = new Promise<void>((resolve) => {
      markRequestStarted = resolve
    })
    let refreshCalls = 0
    let firstRequest: Promise<string> | undefined
    let secondRequest: Promise<string> | undefined

    try {
      const refreshFetch = async (input: string | URL | Request) => {
        expect(String(input)).toBe(transmuteProductionContract.tokenEndpoint)
        refreshCalls += 1
        markRequestStarted()
        if (refreshCalls > 1) {
          throw new Error("a rotating refresh token was spent twice")
        }
        await responseGate
        return Response.json({
          access_token: "rotated-access-token",
          refresh_token: "rotated-refresh-token",
          token_type: "Bearer",
          expires_in: 3_600,
        })
      }
      const lease = {
        directory,
        waitTimeoutMilliseconds: 2_000,
        staleAfterMilliseconds: 500,
        pollIntervalMilliseconds: 5,
      } as const
      firstRequest = getTransmuteAccessToken(discovery, {
        secrets: firstSecrets,
        now: () => 1_000,
        fetch: refreshFetch,
        credentialLease: lease,
      })
      await requestStarted

      const lockNames = await readdir(directory)
      expect(lockNames).toHaveLength(1)
      expect(lockNames[0]).toMatch(
        /^lease-v4-[0-9a-f]{16}-[0-9a-f]{32}-\d+-[0-9a-f]{32}-[0-9a-f]{32}$/u,
      )
      const ownerBytes = await readFile(join(directory, lockNames[0]!))
      expect(ownerBytes.byteLength).toBe(0)
      const diskMetadata = [directory, ...lockNames].join("\n")
      expect(diskMetadata).not.toContain("current-refresh-token")
      expect(diskMetadata).not.toContain("rotated-refresh-token")
      expect(diskMetadata).not.toContain("current-access-token")
      expect(diskMetadata).not.toContain("rotated-access-token")

      secondRequest = getTransmuteAccessToken(discovery, {
        secrets: secondSecrets,
        now: () => 1_000,
        fetch: refreshFetch,
        credentialLease: lease,
      })
      for (
        let attempt = 0;
        attempt < 100 && secondSecrets.getCalls < 1;
        attempt += 1
      ) {
        await Bun.sleep(0)
      }
      expect(secondSecrets.getCalls).toBe(1)
      releaseResponse?.()

      expect(await Promise.all([firstRequest, secondRequest])).toEqual([
        "rotated-access-token",
        "rotated-access-token",
      ])
      expect(refreshCalls).toBe(1)
      expect(firstSecrets.getCalls).toBe(2)
      expect(secondSecrets.getCalls).toBe(2)
      expect(firstSecrets.setCalls + secondSecrets.setCalls).toBe(1)
      expect(JSON.parse(sharedState.value)).toMatchObject({
        accessToken: "rotated-access-token",
        refreshToken: "rotated-refresh-token",
      })
      expect(await readdir(directory)).toEqual([])
    } finally {
      releaseResponse?.()
      await Promise.allSettled(
        [firstRequest, secondRequest].filter(
          (request): request is Promise<string> => request !== undefined,
        ),
      )
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("recovers an abandoned stale lease before refreshing", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "transmute-refresh-stale-test-"),
    )
    const secrets = new MemorySecrets()
    secrets.value = JSON.stringify(credentials({ expiresAt: 1 }))

    try {
      const leaseModuleUrl = new URL("./credential-lease.ts", import.meta.url)
      const departedProcess = Bun.spawn(
        [
          process.execPath,
          "-e",
          `const { acquireTransmuteCredentialMutationLease } = await import(${JSON.stringify(leaseModuleUrl.href)}); await acquireTransmuteCredentialMutationLease({ credentialLease: { directory: ${JSON.stringify(directory)}, pollIntervalMilliseconds: 1, staleAfterMilliseconds: 100, waitTimeoutMilliseconds: 1000 } }, "refresh"); await Bun.sleep(60000);`,
        ],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
      )
      const departedPid = departedProcess.pid
      const departedMarkers = await waitForLeaseMarkers(directory, 1)
      const departedMarkerMatch =
        /^lease-v4-[0-9a-f]{16}-([0-9a-f]{32})-\d+-([0-9a-f]{32})-[0-9a-f]{32}$/u
          .exec(departedMarkers[0] ?? "")
      expect(departedMarkerMatch?.[1]).toBeDefined()
      expect(departedMarkerMatch?.[2]).toBeDefined()
      const departedProcessScopeIdentity = departedMarkerMatch![1]!
      const departedProcessIdentity = departedMarkerMatch![2]!
      departedProcess.kill()
      await departedProcess.exited
      const staleOwner = join(directory, departedMarkers[0]!)
      const staleChooser = join(
        directory,
        `choosing-v4-${departedProcessScopeIdentity}-${departedPid}-${departedProcessIdentity}-${"d".repeat(32)}`,
      )
      await writeFile(staleChooser, "", { mode: 0o600 })
      const staleTime = new Date(Date.now() - 60_000)
      await utimes(staleOwner, staleTime, staleTime)
      await utimes(staleChooser, staleTime, staleTime)

      let refreshCalls = 0
      const accessToken = await getTransmuteAccessToken(discovery, {
        secrets,
        now: () => 1_000,
        credentialLease: {
          directory,
          waitTimeoutMilliseconds: 1_000,
          staleAfterMilliseconds: 10,
          pollIntervalMilliseconds: 1,
        },
        fetch: async () => {
          refreshCalls += 1
          return Response.json({
            access_token: "recovered-access-token",
            refresh_token: "recovered-refresh-token",
            token_type: "Bearer",
            expires_in: 3_600,
          })
        },
      })

      expect(accessToken).toBe("recovered-access-token")
      expect(refreshCalls).toBe(1)
      expect(await readdir(directory)).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("recovers a stale marker after its PID has been reused", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "transmute-refresh-reused-pid-test-"),
    )
    const secrets = new MemorySecrets()
    secrets.value = JSON.stringify(credentials({ expiresAt: 1 }))
    const currentIdentity = await currentProcessLeaseIdentity(directory)
    const currentProcessIdentityValue = currentIdentity.processIdentity
    const priorProcessIdentity =
      `${currentProcessIdentityValue[0] === "0" ? "1" : "0"}${currentProcessIdentityValue.slice(1)}`
    const staleOwner = join(
      directory,
      `lease-v4-0000000000000001-${currentIdentity.processScopeIdentity}-${process.pid}-${priorProcessIdentity}-${"f".repeat(32)}`,
    )

    try {
      await writeFile(staleOwner, "", { mode: 0o600 })
      const staleTime = new Date(Date.now() - 60_000)
      await utimes(staleOwner, staleTime, staleTime)
      let refreshCalls = 0
      const accessToken = await getTransmuteAccessToken(discovery, {
        secrets,
        now: () => 1_000,
        credentialLease: {
          directory,
          waitTimeoutMilliseconds: 1_000,
          staleAfterMilliseconds: 10,
          pollIntervalMilliseconds: 1,
        },
        fetch: async () => {
          refreshCalls += 1
          return Response.json({
            access_token: "reused-pid-access-token",
            refresh_token: "reused-pid-refresh-token",
            token_type: "Bearer",
            expires_in: 3_600,
          })
        },
      })

      expect(accessToken).toBe("reused-pid-access-token")
      expect(refreshCalls).toBe(1)
      expect(await readdir(directory)).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("fails closed without deleting a stale marker from another process scope", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "transmute-refresh-foreign-scope-test-"),
    )
    const secrets = new MemorySecrets()
    secrets.value = JSON.stringify(credentials({ expiresAt: 1 }))
    const currentIdentity = await currentProcessLeaseIdentity(directory)
    const foreignProcessScopeIdentity =
      `${currentIdentity.processScopeIdentity[0] === "0" ? "1" : "0"}${currentIdentity.processScopeIdentity.slice(1)}`
    const foreignOwnerName =
      `lease-v4-0000000000000001-${foreignProcessScopeIdentity}-${process.pid}-${currentIdentity.processIdentity}-${"9".repeat(32)}`
    const foreignOwnerPath = join(directory, foreignOwnerName)

    try {
      await writeFile(foreignOwnerPath, "", { mode: 0o600 })
      const staleTime = new Date(Date.now() - 60_000)
      await utimes(foreignOwnerPath, staleTime, staleTime)
      let refreshCalls = 0

      await expect(
        getTransmuteAccessToken(discovery, {
          secrets,
          now: () => 1_000,
          credentialLease: {
            directory,
            waitTimeoutMilliseconds: 1_000,
            staleAfterMilliseconds: 1,
            pollIntervalMilliseconds: 1,
          },
          fetch: async () => {
            refreshCalls += 1
            throw new Error("must not refresh across process scopes")
          },
        }),
      ).rejects.toThrow(
        "[TOKEN_REFRESH_FAILED] Transmute cannot safely coordinate credentials across process scopes.",
      )
      expect(refreshCalls).toBe(0)
      expect(await readdir(directory)).toEqual([foreignOwnerName])
      expect(await readFile(foreignOwnerPath)).toHaveLength(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("never steals a stale-looking lease from a live process and times out within the configured bound", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "transmute-refresh-live-test-"),
    )
    const processIdentity = await currentProcessLeaseIdentity(directory)
    const ownerName =
      `lease-v4-0000000000000001-${processIdentity.processScopeIdentity}-${process.pid}-${processIdentity.processIdentity}-${"a".repeat(32)}`
    const ownerPath = join(directory, ownerName)
    const secrets = new MemorySecrets()
    secrets.value = JSON.stringify(credentials({ expiresAt: 1 }))
    let refreshCalls = 0

    try {
      await writeFile(ownerPath, "", { mode: 0o600 })
      const staleTime = new Date(Date.now() - 60_000)
      await utimes(ownerPath, staleTime, staleTime)
      await expect(
        getTransmuteAccessToken(discovery, {
          secrets,
          now: () => 1_000,
          credentialLease: {
            directory,
            waitTimeoutMilliseconds: 25,
            staleAfterMilliseconds: 1,
            pollIntervalMilliseconds: 2,
          },
          fetch: async () => {
            refreshCalls += 1
            throw new Error("must not refresh without the lease")
          },
        }),
      ).rejects.toThrow(
        "[TOKEN_REFRESH_FAILED] Transmute timed out waiting for another login refresh.",
      )
      expect(refreshCalls).toBe(0)
      expect(await readFile(ownerPath)).toHaveLength(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("never bypasses an atomically published live choosing doorway", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "transmute-refresh-choosing-test-"),
    )
    const processIdentity = await currentProcessLeaseIdentity(directory)
    const choosingName =
      `choosing-v4-${processIdentity.processScopeIdentity}-${process.pid}-${processIdentity.processIdentity}-${"e".repeat(32)}`
    const choosingPath = join(directory, choosingName)
    const secrets = new MemorySecrets()
    secrets.value = JSON.stringify(credentials({ expiresAt: 1 }))
    let refreshCalls = 0

    try {
      await writeFile(choosingPath, "", { mode: 0o600 })
      const staleTime = new Date(Date.now() - 60_000)
      await utimes(choosingPath, staleTime, staleTime)
      await expect(
        getTransmuteAccessToken(discovery, {
          secrets,
          now: () => 1_000,
          credentialLease: {
            directory,
            waitTimeoutMilliseconds: 25,
            staleAfterMilliseconds: 1,
            pollIntervalMilliseconds: 2,
          },
          fetch: async () => {
            refreshCalls += 1
            throw new Error("must not pass a live choosing doorway")
          },
        }),
      ).rejects.toThrow(
        "[TOKEN_REFRESH_FAILED] Transmute timed out waiting for another login refresh.",
      )
      expect(refreshCalls).toBe(0)
      expect(await readFile(choosingPath)).toHaveLength(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("cancels a bounded lease wait without exposing credentials", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "transmute-refresh-cancel-test-"),
    )
    const processIdentity = await currentProcessLeaseIdentity(directory)
    const ownerName =
      `lease-v4-0000000000000001-${processIdentity.processScopeIdentity}-${process.pid}-${processIdentity.processIdentity}-${"b".repeat(32)}`
    const secrets = new MemorySecrets()
    secrets.value = JSON.stringify(credentials({ expiresAt: 1 }))
    const controller = new AbortController()

    try {
      await writeFile(join(directory, ownerName), "", { mode: 0o600 })
      const pending = getTransmuteAccessToken(discovery, {
        secrets,
        now: () => 1_000,
        credentialLease: {
          directory,
          waitTimeoutMilliseconds: 2_000,
          staleAfterMilliseconds: 1_000,
          pollIntervalMilliseconds: 250,
          signal: controller.signal,
        },
        fetch: async () => {
          throw new Error("must not refresh without the lease")
        },
      })
      await Bun.sleep(10)
      controller.abort("private cancellation detail")
      let failure: unknown
      try {
        await pending
      } catch (cause) {
        failure = cause
      }
      expect(String(failure)).toBe(
        "TransmuteCloudError: [TOKEN_REFRESH_FAILED] Transmute login refresh was cancelled.",
      )
      expect(String(failure)).not.toContain("current-access-token")
      expect(String(failure)).not.toContain("current-refresh-token")
      expect(String(failure)).not.toContain("private cancellation detail")
    } finally {
      controller.abort()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("honors cancellation after the credential reread and immediately before refresh dispatch", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "transmute-refresh-predispatch-cancel-test-"),
    )
    const rereadStarted = deferred()
    const releaseReread = deferred()
    const controller = new AbortController()
    const state = { value: JSON.stringify(credentials({ expiresAt: 1 })) }
    const secrets = new MemorySecrets(state, {
      beforeGet: async (call) => {
        if (call !== 2) return
        rereadStarted.resolve()
        await releaseReread.promise
      },
    })
    let refreshCalls = 0

    try {
      const pending = getTransmuteAccessToken(discovery, {
        secrets,
        now: () => 1_000,
        credentialLease: {
          directory,
          waitTimeoutMilliseconds: 1_000,
          staleAfterMilliseconds: 100,
          pollIntervalMilliseconds: 2,
          signal: controller.signal,
        },
        fetch: async () => {
          refreshCalls += 1
          throw new Error("an aborted reread must not dispatch")
        },
      })
      await rereadStarted.promise
      controller.abort("private post-reread reason")
      releaseReread.resolve()
      await expect(pending).rejects.toThrow(
        "[TOKEN_REFRESH_FAILED] Transmute login refresh was cancelled.",
      )
      expect(refreshCalls).toBe(0)
      expect(JSON.parse(state.value)).toMatchObject({
        accessToken: "current-access-token",
        refreshToken: "current-refresh-token",
      })
      expect(await readdir(directory)).toEqual([])
    } finally {
      controller.abort()
      releaseReread.resolve()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("persists a rotated response after a transient heartbeat failure and releases the lease", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "transmute-refresh-heartbeat-test-"),
    )
    const secrets = new MemorySecrets()
    secrets.value = JSON.stringify(credentials({ expiresAt: 1 }))
    const heartbeatFailed = deferred()
    let heartbeatCalls = 0

    try {
      const accessToken = await getTransmuteAccessToken(discovery, {
        secrets,
        now: () => 1_000,
        credentialLease: {
          directory,
          waitTimeoutMilliseconds: 1_000,
          staleAfterMilliseconds: 30,
          pollIntervalMilliseconds: 2,
          heartbeat: async (touch) => {
            heartbeatCalls += 1
            if (heartbeatCalls === 1) {
              heartbeatFailed.resolve()
              throw new Error("transient heartbeat interruption")
            }
            await touch()
          },
        },
        fetch: async () => {
          await heartbeatFailed.promise
          return Response.json({
            access_token: "heartbeat-access-token",
            refresh_token: "heartbeat-refresh-token",
            token_type: "Bearer",
            expires_in: 3_600,
          })
        },
      })

      expect(accessToken).toBe("heartbeat-access-token")
      expect(heartbeatCalls).toBeGreaterThanOrEqual(1)
      expect(JSON.parse(secrets.value ?? "{}")).toMatchObject({
        accessToken: "heartbeat-access-token",
        refreshToken: "heartbeat-refresh-token",
      })
      expect(await readdir(directory)).toEqual([])
    } finally {
      heartbeatFailed.resolve()
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("does not let a stuck advisory heartbeat strand lease release", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "transmute-refresh-stuck-heartbeat-test-"),
    )
    const secrets = new MemorySecrets()
    secrets.value = JSON.stringify(credentials({ expiresAt: 1 }))
    const heartbeatStarted = deferred()
    const neverSettles = new Promise<void>(() => undefined)

    try {
      const pending = getTransmuteAccessToken(discovery, {
        secrets,
        now: () => 1_000,
        credentialLease: {
          directory,
          waitTimeoutMilliseconds: 1_000,
          staleAfterMilliseconds: 30,
          pollIntervalMilliseconds: 2,
          heartbeat: async () => {
            heartbeatStarted.resolve()
            await neverSettles
          },
        },
        fetch: async () => {
          await heartbeatStarted.promise
          return Response.json({
            access_token: "stuck-heartbeat-access-token",
            refresh_token: "stuck-heartbeat-refresh-token",
            token_type: "Bearer",
            expires_in: 3_600,
          })
        },
      })

      const accessToken = await Promise.race([
        pending,
        Bun.sleep(500).then(() => "timed-out" as const),
      ])
      expect(accessToken).toBe("stuck-heartbeat-access-token")
      expect(JSON.parse(secrets.value ?? "{}")).toMatchObject({
        accessToken: "stuck-heartbeat-access-token",
        refreshToken: "stuck-heartbeat-refresh-token",
      })
      expect(await readdir(directory)).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("inode-fences final ownership and never deletes a replacement marker", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "transmute-refresh-inode-test-"),
    )
    const secrets = new MemorySecrets()
    secrets.value = JSON.stringify(credentials({ expiresAt: 1 }))
    const before = secrets.value
    let replacementPath: string | undefined

    try {
      await expect(
        getTransmuteAccessToken(discovery, {
          secrets,
          now: () => 1_000,
          credentialLease: {
            directory,
            waitTimeoutMilliseconds: 1_000,
            staleAfterMilliseconds: 100,
            pollIntervalMilliseconds: 1,
          },
          fetch: async () => {
            const markers = (await readdir(directory)).filter((entry) =>
              entry.startsWith("lease-v4-"),
            )
            expect(markers).toHaveLength(1)
            replacementPath = join(directory, markers[0]!)
            await unlink(replacementPath)
            await writeFile(replacementPath, "", { mode: 0o600 })
            return Response.json({
              access_token: "must-not-persist-access",
              refresh_token: "must-not-persist-refresh",
              token_type: "Bearer",
              expires_in: 3_600,
            })
          },
        }),
      ).rejects.toThrow("[TOKEN_REFRESH_FAILED]")
      expect(secrets.value).toBe(before)
      expect(replacementPath).toBeDefined()
      expect(await readFile(replacementPath!)).toHaveLength(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("rejects a token response without an explicit Bearer type", async () => {
    const secrets = new MemorySecrets()
    secrets.value = JSON.stringify(credentials({ expiresAt: 1 }))
    const before = secrets.value
    await expect(
      getTransmuteAccessToken(discovery, {
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

  oauthCallbackTest("completes the fixed loopback callback before exchanging and stores only in secrets", async () => {
    const secrets = new MemorySecrets()
    let authorizationCalls = 0
    let exchangeCalls = 0
    const status = await loginTransmute({
      secrets,
      now: () => 10_000,
      fetch: async (input, init) => {
        if (String(input) === transmuteDiscoveryUrl) return discoveryResponse()
        if (isAuthorizationRequest(input)) {
          authorizationCalls += 1
          expect(init?.method).toBe("GET")
          expect(init?.redirect).toBe("manual")
          expect(init?.headers).toMatchObject({ accept: "application/json" })
          const url = new URL(String(input))
          expect(url.searchParams.get("response_type")).toBe("code")
          expect(url.searchParams.get("redirect_uri")).toBe(
            transmuteRedirectUri,
          )
          expect(url.searchParams.get("code_challenge_method")).toBe("S256")
          expect(url.searchParams.get("code_challenge")).toMatch(
            /^[A-Za-z0-9_-]{43}$/u,
          )
          return authorizationBootstrapResponse(input)
        }
        exchangeCalls += 1
        expect(String(input)).toBe(transmuteProductionContract.tokenEndpoint)
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
      openUrl: async (launchUrl) => {
        const parsedLaunchUrl = new URL(launchUrl)
        expect(parsedLaunchUrl.origin).toBe(
          transmuteProductionContract.issuer,
        )
        expect(parsedLaunchUrl.pathname).toBe("/login")
        const state = parsedLaunchUrl.searchParams.get("state")
        expect(state).not.toBeNull()
        const callback = new URL(transmuteRedirectUri)
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
    expect(authorizationCalls).toBe(1)
    expect(exchangeCalls).toBe(1)
    expect(status).toMatchObject({ authenticated: true, refreshable: true })
    expect(JSON.parse(secrets.value ?? "{}")).toMatchObject({
      accessToken: "login-access-token",
      refreshToken: "login-refresh-token",
    })
  })

  oauthCallbackTest("accepts a future manual 3xx authorization redirect on the trusted issuer", async () => {
    const secrets = new MemorySecrets()
    let openedUrl: string | undefined
    const status = await loginTransmute({
      secrets,
      now: () => 20_000,
      fetch: async (input, init) => {
        if (String(input) === transmuteDiscoveryUrl) return discoveryResponse()
        if (isAuthorizationRequest(input)) {
          expect(init?.redirect).toBe("manual")
          const state = new URL(String(input)).searchParams.get("state")
          expect(state).not.toBeNull()
          return new Response(null, {
            status: 302,
            headers: {
              location:
                `${transmuteProductionContract.issuer}/login?state=${encodeURIComponent(state!)}`,
            },
          })
        }
        expect(String(input)).toBe(transmuteProductionContract.tokenEndpoint)
        return Response.json({
          access_token: "redirect-access-token",
          refresh_token: "redirect-refresh-token",
          token_type: "Bearer",
          expires_in: 3_600,
        })
      },
      openUrl: async (launchUrl) => {
        openedUrl = launchUrl
        await completeLoginCallback(launchUrl, "redirect-login-code")
      },
    })

    expect(openedUrl).toStartWith(
      `${transmuteProductionContract.issuer}/login?state=`,
    )
    expect(status).toMatchObject({ authenticated: true, refreshable: true })
  })

  oauthCallbackTest("fails closed on malformed, oversized, non-JSON, and implicitly followed authorization responses", async () => {
    const implicitlyFollowed = Response.json({
      redirect: true,
      url: "/login",
    })
    Object.defineProperty(implicitlyFollowed, "redirected", { value: true })
    const cases: ReadonlyArray<{
      readonly name: string
      readonly response: () => Response
    }> = [
      {
        name: "non-success status",
        response: () => Response.json({ redirect: true, url: "/login" }, { status: 500 }),
      },
      {
        name: "missing redirect location",
        response: () => new Response(null, { status: 302 }),
      },
      {
        name: "foreign redirect location",
        response: () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://foreign.example/login" },
          }),
      },
      {
        name: "non-JSON content type",
        response: () =>
          new Response('{"redirect":true,"url":"/login"}', {
            headers: { "content-type": "text/html" },
          }),
      },
      {
        name: "malformed JSON",
        response: () =>
          new Response("not-json", {
            headers: { "content-type": "application/json" },
          }),
      },
      {
        name: "malformed UTF-8",
        response: () =>
          new Response(Uint8Array.of(0xff), {
            headers: { "content-type": "application/json" },
          }),
      },
      {
        name: "oversized body",
        response: () =>
          new Response("{}", {
            headers: {
              "content-type": "application/json",
              "content-length": String(32 * 1024 + 1),
            },
          }),
      },
      {
        name: "false redirect marker",
        response: () => Response.json({ redirect: false, url: "/login" }),
      },
      {
        name: "extra response field",
        response: () =>
          Response.json({ redirect: true, url: "/login", extra: true }),
      },
      {
        name: "implicitly followed redirect",
        response: () => implicitlyFollowed,
      },
    ]

    for (const current of cases) {
      let openCalls = 0
      await expect(
        loginTransmute({
          secrets: new MemorySecrets(),
          fetch: async (input) => {
            if (String(input) === transmuteDiscoveryUrl) {
              return discoveryResponse()
            }
            if (isAuthorizationRequest(input)) return current.response()
            throw new Error(`unexpected request in ${current.name}`)
          },
          openUrl: async () => {
            openCalls += 1
          },
        }),
      ).rejects.toThrow(
        "[AUTHORIZATION_FAILED] Transmute could not start the authorization flow.",
      )
      expect(openCalls).toBe(0)
    }
  })

  oauthCallbackTest("opens only bounded HTTPS URLs on the exact trusted issuer origin", async () => {
    const unsafeUrls = [
      "https://foreign.example/login",
      "https://account.hraness.com.evil.example/login",
      "https://user:password@account.hraness.com/login",
      "https://account.hraness.com:444/login",
      "http://account.hraness.com/login",
      "javascript:alert(1)",
      "//account.hraness.com/login",
      "login",
      "../login",
      "/\\\\foreign.example/login",
      "/login#fragment",
      " https://account.hraness.com/login",
      `/${"a".repeat(16 * 1024)}`,
    ] as const

    for (const unsafeUrl of unsafeUrls) {
      let openCalls = 0
      await expect(
        loginTransmute({
          secrets: new MemorySecrets(),
          fetch: async (input) => {
            if (String(input) === transmuteDiscoveryUrl) {
              return discoveryResponse()
            }
            if (isAuthorizationRequest(input)) {
              return Response.json({ redirect: true, url: unsafeUrl })
            }
            throw new Error("an unsafe launch URL reached token exchange")
          },
          openUrl: async () => {
            openCalls += 1
          },
        }),
      ).rejects.toThrow(
        "[AUTHORIZATION_FAILED] Transmute could not start the authorization flow.",
      )
      expect(openCalls).toBe(0)
    }
  })

  oauthCallbackTest("shares the mutation lease so an explicit login wins over an older in-flight refresh", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "transmute-login-refresh-race-test-"),
    )
    const state = { value: JSON.stringify(credentials({ expiresAt: 1 })) }
    const refreshSecrets = new MemorySecrets(state)
    const loginSecrets = new MemorySecrets(state)
    const refreshDispatched = deferred()
    const releaseRefresh = deferred()
    const loginExchanged = deferred()
    const lease = {
      directory,
      waitTimeoutMilliseconds: 2_000,
      staleAfterMilliseconds: 500,
      pollIntervalMilliseconds: 2,
    } as const
    let refreshRequest: Promise<string> | undefined
    let loginRequest: ReturnType<typeof loginTransmute> | undefined

    try {
      refreshRequest = getTransmuteAccessToken(discovery, {
        secrets: refreshSecrets,
        now: () => 1_000,
        credentialLease: lease,
        fetch: async () => {
          refreshDispatched.resolve()
          await releaseRefresh.promise
          return Response.json({
            access_token: "old-login-rotated-access",
            refresh_token: "old-login-rotated-refresh",
            token_type: "Bearer",
            expires_in: 3_600,
          })
        },
      })
      await refreshDispatched.promise

      loginRequest = loginTransmute({
        secrets: loginSecrets,
        now: () => 2_000,
        credentialLease: lease,
        fetch: async (input, init) => {
          if (String(input) === transmuteDiscoveryUrl) return discoveryResponse()
          if (isAuthorizationRequest(input)) {
            return authorizationBootstrapResponse(input)
          }
          const form = new URLSearchParams(String(init?.body))
          expect(form.get("grant_type")).toBe("authorization_code")
          loginExchanged.resolve()
          return Response.json({
            access_token: "explicit-login-access",
            refresh_token: "explicit-login-refresh",
            token_type: "Bearer",
            expires_in: 3_600,
          })
        },
        openUrl: async (authorizationUrl) => {
          await completeLoginCallback(authorizationUrl, "race-login-code")
        },
      })
      await loginExchanged.promise
      await waitForLeaseMarkers(directory, 2)
      releaseRefresh.resolve()

      expect(await refreshRequest).toBe("old-login-rotated-access")
      expect(await loginRequest).toMatchObject({
        authenticated: true,
        refreshable: true,
      })
      expect(JSON.parse(state.value)).toMatchObject({
        accessToken: "explicit-login-access",
        refreshToken: "explicit-login-refresh",
      })
      expect(loginSecrets.getCalls).toBeGreaterThanOrEqual(1)
      expect(await readdir(directory)).toEqual([])
    } finally {
      releaseRefresh.resolve()
      const pending: Promise<unknown>[] = []
      if (refreshRequest !== undefined) pending.push(refreshRequest)
      if (loginRequest !== undefined) pending.push(loginRequest)
      await Promise.allSettled(pending)
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("shares the mutation lease so logout deletes a concurrently rotated credential", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "transmute-logout-refresh-race-test-"),
    )
    const state: { value: string | null } = {
      value: JSON.stringify(credentials({ expiresAt: 1 })),
    }
    const refreshSecrets = new MemorySecrets(state)
    const logoutSecrets = new MemorySecrets(state)
    const refreshDispatched = deferred()
    const releaseRefresh = deferred()
    const lease = {
      directory,
      waitTimeoutMilliseconds: 2_000,
      staleAfterMilliseconds: 500,
      pollIntervalMilliseconds: 2,
    } as const
    let refreshRequest: Promise<string> | undefined
    let logoutRequest: ReturnType<typeof logoutTransmute> | undefined
    const revokedTokens: string[] = []

    try {
      refreshRequest = getTransmuteAccessToken(discovery, {
        secrets: refreshSecrets,
        now: () => 1_000,
        credentialLease: lease,
        fetch: async () => {
          refreshDispatched.resolve()
          await releaseRefresh.promise
          return Response.json({
            access_token: "logout-race-access",
            refresh_token: "logout-race-refresh",
            token_type: "Bearer",
            expires_in: 3_600,
          })
        },
      })
      await refreshDispatched.promise

      logoutRequest = logoutTransmute({
        secrets: logoutSecrets,
        credentialLease: lease,
        fetch: async (input, init) => {
          if (String(input) === transmuteDiscoveryUrl) return discoveryResponse()
          const form = new URLSearchParams(String(init?.body))
          const token = form.get("token")
          if (token !== null) revokedTokens.push(token)
          return new Response(null, { status: 200 })
        },
      })
      await waitForLeaseMarkers(directory, 2)
      releaseRefresh.resolve()

      expect(await refreshRequest).toBe("logout-race-access")
      expect(await logoutRequest).toEqual({ removed: true, revoked: true })
      expect(revokedTokens).toEqual(["logout-race-refresh"])
      expect(state.value).toBeNull()
      expect(logoutSecrets.getCalls).toBeGreaterThanOrEqual(1)
      expect(await readdir(directory)).toEqual([])
    } finally {
      releaseRefresh.resolve()
      const pending: Promise<unknown>[] = []
      if (refreshRequest !== undefined) pending.push(refreshRequest)
      if (logoutRequest !== undefined) pending.push(logoutRequest)
      await Promise.allSettled(pending)
      await rm(directory, { recursive: true, force: true })
    }
  })

  oauthCallbackTest("closes the loopback listener when opening the browser fails", async () => {
    const secrets = new MemorySecrets()
    const unhandled: unknown[] = []
    const observeUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on("unhandledRejection", observeUnhandled)
    try {
      await expect(
        loginTransmute({
          secrets,
          fetch: async (input) => {
            if (String(input) === transmuteDiscoveryUrl) {
              return discoveryResponse()
            }
            if (isAuthorizationRequest(input)) {
              return authorizationBootstrapResponse(input)
            }
            throw new Error("unexpected token exchange")
          },
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
    const status = await transmuteAuthStatus({ secrets, now: () => 1_000 })
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
      await transmuteAuthStatus({ secrets: foreignSecrets, now: () => 1_000 }),
    ).toEqual({
      authenticated: false,
      expiresAt: null,
      refreshable: false,
    })

    const requests: string[] = []
    const result = await logoutTransmute({
      secrets,
      fetch: async (input, init) => {
        requests.push(String(input))
        if (String(input) === transmuteDiscoveryUrl) return discoveryResponse()
        expect(init?.redirect).toBe("error")
        expect(String(init?.body)).toContain(
          "token=current-refresh-token",
        )
        return new Response(null, { status: 200 })
      },
    })
    expect(requests).toEqual([
      transmuteDiscoveryUrl,
      transmuteProductionContract.revocationEndpoint,
    ])
    expect(result).toEqual({ removed: true, revoked: true })
    expect(secrets.value).toBeNull()
  })

  test("fails credential mutations closed on Windows even with a caller-supplied shared directory", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "transmute-windows-credential-lease-test-"),
    )
    const originalPlatform = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    )!
    const state = { value: JSON.stringify(credentials({ expiresAt: 1 })) }
    const secrets = new MemorySecrets(state)
    let fetchCalls = 0

    Object.defineProperty(process, "platform", {
      ...originalPlatform,
      value: "win32",
    })
    try {
      const dependencies = {
        secrets,
        credentialLease: { directory },
        fetch: async () => {
          fetchCalls += 1
          throw new Error("unsupported credential mutation dispatched")
        },
      } as const
      await expect(
        getTransmuteAccessToken(discovery, {
          ...dependencies,
          now: () => 1_000,
        }),
      ).rejects.toThrow(
        "[TOKEN_REFRESH_FAILED] Transmute cannot safely mutate shared credentials on this platform.",
      )
      await expect(loginTransmute(dependencies)).rejects.toThrow(
        "[TOKEN_STORAGE_FAILED] Transmute cannot safely mutate shared credentials on this platform.",
      )
      await expect(logoutTransmute(dependencies)).rejects.toThrow(
        "[TOKEN_STORAGE_FAILED] Transmute cannot safely mutate shared credentials on this platform.",
      )
      expect(fetchCalls).toBe(0)
      expect(JSON.parse(state.value)).toMatchObject({
        accessToken: "current-access-token",
        refreshToken: "current-refresh-token",
      })
      expect(await readdir(directory)).toEqual([])
    } finally {
      Object.defineProperty(process, "platform", originalPlatform)
      await rm(directory, { recursive: true, force: true })
    }
  })
})
