import { describe, expect, test } from "bun:test"
import {
  fetchTransmuteDiscovery,
  parseTransmuteDiscovery,
  transmuteDesktopClientId,
  transmuteDesktopEndpoints,
  transmuteDesktopScopes,
  transmuteDiscoveryMaximumBytes,
  transmuteDiscoveryUrl,
  transmuteImageModels,
  transmuteProductionContract,
  transmuteRedirectUri,
} from "./discovery.ts"

function validDiscovery(
  desktop: Record<string, unknown> = { availability: "unavailable" },
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    product: "transmute",
    environment: transmuteProductionContract.environment,
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
        endpoints: {
          generateImage: transmuteProductionContract.generateImage,
        },
        imageGeneration: {
          access: "authenticated",
          billing: "free-preview",
          models: transmuteImageModels,
          maximumPromptBytes: transmuteProductionContract.maximumPromptBytes,
          maximumRawImageBytes: transmuteProductionContract.maximumRawImageBytes,
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
      desktop,
    },
  }
}

function media(document: Record<string, unknown>): Record<string, unknown> {
  const capabilities = document.capabilities as Record<string, unknown>
  return capabilities.media as Record<string, unknown>
}

function withMedia(
  document: Record<string, unknown>,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const capabilities = document.capabilities as Record<string, unknown>
  return {
    ...document,
    capabilities: {
      ...capabilities,
      media: { ...media(document), ...updates },
    },
  }
}

function availableDesktop(): Record<string, unknown> {
  return {
    availability: "available",
    clientId: transmuteDesktopClientId,
    scopes: transmuteDesktopScopes,
    endpoints: {
      ...transmuteDesktopEndpoints,
      sceneDescribe: "https://kind-otter-123.convex.site/api/v1/scenes/describe",
    },
  }
}

describe("Transmute service discovery", () => {
  test("accepts only the grouped v2 production media contract", () => {
    const document = validDiscovery()
    const parsed = parseTransmuteDiscovery(document)
    expect(parsed).toEqual(
      document as unknown as ReturnType<typeof parseTransmuteDiscovery>,
    )
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.capabilities)).toBe(true)
    expect(Object.isFrozen(parsed.capabilities.media.authorization)).toBe(true)
    expect(
      Object.isFrozen(parsed.capabilities.media.imageGeneration.models),
    ).toBe(true)
    expect(Object.isFrozen(parsed.capabilities.desktop)).toBe(true)

    expect(() =>
      parseTransmuteDiscovery({ ...validDiscovery(), schemaVersion: 1 }),
    ).toThrow("[DISCOVERY_INVALID]")
    expect(() =>
      parseTransmuteDiscovery({ ...validDiscovery(), environment: "staging" }),
    ).toThrow("[DISCOVERY_INVALID]")
    expect(() =>
      parseTransmuteDiscovery(
        withMedia(validDiscovery(), {
          apiBaseUrl: "https://attacker.example/api/v1",
        }),
      ),
    ).toThrow("[DISCOVERY_INVALID]")
    expect(() =>
      parseTransmuteDiscovery(
        withMedia(validDiscovery(), {
          operationsUrl: "https://transmute.rocks/api/v2/operations",
        }),
      ),
    ).toThrow("[DISCOVERY_INVALID]")
  })

  test("rejects extra keys and every mutable authorization authority", () => {
    expect(() =>
      parseTransmuteDiscovery({ ...validDiscovery(), surprise: true }),
    ).toThrow("[DISCOVERY_INVALID]")

    const document = validDiscovery()
    const authorization = media(document).authorization as Record<string, unknown>
    for (const [key, value] of [
      ["issuer", "https://account.hraness.com.example"],
      ["tokenEndpoint", "https://attacker.example/token"],
      ["clientId", "other-client"],
      ["resource", "https://hraness.com/other"],
      ["redirectUri", "http://127.0.0.1:49672/oauth/callback"],
    ] as const) {
      expect(() =>
        parseTransmuteDiscovery(
          withMedia(document, {
            authorization: { ...authorization, [key]: value },
          }),
        ),
      ).toThrow("[DISCOVERY_INVALID]")
    }
  })

  test("requires the exact generation policy and local vectorization contract", () => {
    const document = validDiscovery()
    const generation = media(document).imageGeneration as Record<string, unknown>
    const quota = generation.quota as Record<string, unknown>
    const idempotency = generation.idempotency as Record<string, unknown>
    expect(() =>
      parseTransmuteDiscovery(withMedia(document, { vectorize: undefined })),
    ).toThrow("[DISCOVERY_INVALID]")
    expect(() =>
      parseTransmuteDiscovery(
        withMedia(document, {
          vectorize: {
            access: "local",
            billing: "free-preview",
            execution: "local",
          },
        }),
      ),
    ).toThrow("[DISCOVERY_INVALID]")

    for (const [key, value] of [
      ["access", "anonymous"],
      ["billing", "paid"],
    ] as const) {
      expect(() =>
        parseTransmuteDiscovery(
          withMedia(document, {
            imageGeneration: { ...generation, [key]: value },
          }),
        ),
      ).toThrow("[DISCOVERY_INVALID]")
    }
    for (const [key, value] of [
      ["accountDailyLimit", 11],
      ["globalDailySafetyLimit", 101],
      ["paymentEnforced", true],
      ["period", "rolling-day"],
    ] as const) {
      expect(() =>
        parseTransmuteDiscovery(
          withMedia(document, {
            imageGeneration: {
              ...generation,
              quota: { ...quota, [key]: value },
            },
          }),
        ),
      ).toThrow("[DISCOVERY_INVALID]")
    }
    for (const [key, value] of [
      ["header", "X-Idempotency-Key"],
      ["durable", false],
      ["scope", "process-local-mvp"],
    ] as const) {
      expect(() =>
        parseTransmuteDiscovery(
          withMedia(document, {
            imageGeneration: {
              ...generation,
              idempotency: { ...idempotency, [key]: value },
            },
          }),
        ),
      ).toThrow("[DISCOVERY_INVALID]")
    }
  })

  test("exposes desktop only through its checked availability discriminant", () => {
    const unavailable = parseTransmuteDiscovery(validDiscovery())
    expect(unavailable.capabilities.desktop).toEqual({
      availability: "unavailable",
    })

    const available = parseTransmuteDiscovery(validDiscovery(availableDesktop()))
    expect(available.capabilities.desktop.availability).toBe("available")
    if (available.capabilities.desktop.availability !== "available") {
      throw new Error("Expected available desktop discovery.")
    }
    expect(available.capabilities.desktop.endpoints.sceneDescribe).toBe(
      "https://kind-otter-123.convex.site/api/v1/scenes/describe",
    )

    expect(() =>
      parseTransmuteDiscovery(
        validDiscovery({ availability: "unavailable", endpoints: {} }),
      ),
    ).toThrow("[DISCOVERY_INVALID]")
    for (const desktop of [
      { ...availableDesktop(), clientId: "other-client" },
      {
        ...availableDesktop(),
        endpoints: {
          ...(availableDesktop().endpoints as Record<string, unknown>),
          deviceToken: "https://evil.example/api/auth/device/token",
        },
      },
      {
        ...availableDesktop(),
        endpoints: {
          ...(availableDesktop().endpoints as Record<string, unknown>),
          sceneDescribe: "https://evil.example/api/v1/scenes/describe",
        },
      },
    ]) {
      expect(() => parseTransmuteDiscovery(validDiscovery(desktop))).toThrow(
        "[DISCOVERY_INVALID]",
      )
    }
  })

  test("fetches the fixed URL without redirects and bounds JSON/content type", async () => {
    let calls = 0
    const discovery = await fetchTransmuteDiscovery(async (input, init) => {
      calls += 1
      expect(String(input)).toBe(transmuteDiscoveryUrl)
      expect(init?.redirect).toBe("error")
      return new Response(JSON.stringify(validDiscovery()), {
        headers: { "content-type": "application/json; charset=utf-8" },
      })
    })
    expect(calls).toBe(1)
    expect(discovery.capabilities.media.authorization.clientId).toBe(
      transmuteProductionContract.clientId,
    )

    await expect(
      fetchTransmuteDiscovery(async () =>
        new Response(JSON.stringify(validDiscovery()), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      ),
    ).rejects.toThrow("[DISCOVERY_UNAVAILABLE]")

    await expect(
      fetchTransmuteDiscovery(async () =>
        new Response(JSON.stringify(validDiscovery()), {
          headers: { "content-type": "text/plain" },
        }),
      ),
    ).rejects.toThrow("[DISCOVERY_INVALID]")

    await expect(
      fetchTransmuteDiscovery(async () =>
        new Response("{}", {
          headers: {
            "content-type": "application/json",
            "content-length": String(transmuteDiscoveryMaximumBytes + 1),
          },
        }),
      ),
    ).rejects.toThrow("[DISCOVERY_INVALID]")
  })
})
