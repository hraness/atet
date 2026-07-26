import { describe, expect, test } from "bun:test"
import {
  fetchGraphicsDiscovery,
  graphicsDiscoveryMaximumBytes,
  graphicsDiscoveryUrl,
  graphicsImageModels,
  graphicsProductionContract,
  graphicsRedirectUri,
  parseGraphicsDiscovery,
} from "./discovery.ts"

function validDiscovery(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    product: "graphics",
    environment: graphicsProductionContract.environment,
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
    endpoints: {
      generateImage: graphicsProductionContract.generateImage,
    },
    imageGeneration: {
      models: graphicsImageModels,
      maximumPromptBytes: graphicsProductionContract.maximumPromptBytes,
      maximumRawImageBytes: graphicsProductionContract.maximumRawImageBytes,
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

describe("Graphics service discovery", () => {
  test("accepts only the pinned production contract", () => {
    const parsed = parseGraphicsDiscovery(validDiscovery())
    expect(parsed).toEqual(
      validDiscovery() as unknown as ReturnType<typeof parseGraphicsDiscovery>,
    )
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.authorization)).toBe(true)
    expect(Object.isFrozen(parsed.imageGeneration.models)).toBe(true)

    for (const mutation of [
      { environment: "staging" },
      { apiBaseUrl: "https://attacker.example/api/v1" },
      { operationsUrl: "https://hraness.graphics/api/v2/operations" },
    ]) {
      expect(() =>
        parseGraphicsDiscovery({ ...validDiscovery(), ...mutation }),
      ).toThrow("[DISCOVERY_INVALID]")
    }
  })

  test("rejects extra keys and every mutable authorization authority", () => {
    expect(() =>
      parseGraphicsDiscovery({ ...validDiscovery(), surprise: true }),
    ).toThrow("[DISCOVERY_INVALID]")

    const document = validDiscovery()
    const authorization = document.authorization as Record<string, unknown>
    for (const [key, value] of [
      ["issuer", "https://account.hraness.com.example"],
      ["tokenEndpoint", "https://attacker.example/token"],
      ["clientId", "other-client"],
      ["resource", "https://hraness.com/other"],
      ["redirectUri", "http://127.0.0.1:49672/oauth/callback"],
    ] as const) {
      expect(() =>
        parseGraphicsDiscovery({
          ...document,
          authorization: { ...authorization, [key]: value },
        }),
      ).toThrow("[DISCOVERY_INVALID]")
    }
  })

  test("requires the authenticated local vectorize feature and exact WebP limits", () => {
    const document = validDiscovery()
    const generation = document.imageGeneration as Record<string, unknown>
    expect(() =>
      parseGraphicsDiscovery({
        ...document,
        features: undefined,
      }),
    ).toThrow("[DISCOVERY_INVALID]")
    expect(() =>
      parseGraphicsDiscovery({
        ...document,
        imageGeneration: {
          ...generation,
          responseMediaTypes: ["image/webp", "image/png"],
        },
      }),
    ).toThrow("[DISCOVERY_INVALID]")
    expect(() =>
      parseGraphicsDiscovery({
        ...document,
        imageGeneration: {
          ...generation,
          maximumRawImageBytes:
            graphicsProductionContract.maximumRawImageBytes + 1,
        },
      }),
    ).toThrow("[DISCOVERY_INVALID]")
  })

  test("fetches the fixed URL without redirects and bounds JSON/content type", async () => {
    let calls = 0
    const discovery = await fetchGraphicsDiscovery(async (input, init) => {
      calls += 1
      expect(String(input)).toBe(graphicsDiscoveryUrl)
      expect(init?.redirect).toBe("error")
      return new Response(JSON.stringify(validDiscovery()), {
        headers: { "content-type": "application/json; charset=utf-8" },
      })
    })
    expect(calls).toBe(1)
    expect(discovery.authorization.clientId).toBe(
      graphicsProductionContract.clientId,
    )

    await expect(
      fetchGraphicsDiscovery(async () =>
        new Response(JSON.stringify(validDiscovery()), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      ),
    ).rejects.toThrow("[DISCOVERY_UNAVAILABLE]")

    await expect(
      fetchGraphicsDiscovery(async () =>
        new Response(JSON.stringify(validDiscovery()), {
          headers: { "content-type": "text/plain" },
        }),
      ),
    ).rejects.toThrow("[DISCOVERY_INVALID]")

    await expect(
      fetchGraphicsDiscovery(async () =>
        new Response("{}", {
          headers: {
            "content-type": "application/json",
            "content-length": String(graphicsDiscoveryMaximumBytes + 1),
          },
        }),
      ),
    ).rejects.toThrow("[DISCOVERY_INVALID]")
  })
})
