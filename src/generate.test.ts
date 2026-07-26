import { describe, expect, test } from "bun:test"
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  graphicsSecretsName,
  graphicsSecretsService,
  type GraphicsSecretStore,
} from "./auth.ts"
import {
  graphicsImageModels,
  graphicsProductionContract,
  graphicsRedirectUri,
  parseGraphicsDiscovery,
} from "./discovery.ts"
import {
  generateGraphicsImage,
  generateGraphicsImageFile,
  validateGraphicsIdempotencyKey,
} from "./generate.ts"

class FixedSecrets implements GraphicsSecretStore {
  value = JSON.stringify({
    schemaVersion: 1,
    issuer: graphicsProductionContract.issuer,
    clientId: graphicsProductionContract.clientId,
    resource: graphicsProductionContract.resource,
    accessToken: "bounded-access-token",
    refreshToken: "bounded-refresh-token",
    expiresAt: Date.now() + 60 * 60_000,
  })

  async get() {
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

  async delete() {
    this.value = ""
    return true
  }
}

const discovery = parseGraphicsDiscovery({
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
})

const webp = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x08, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  0x56, 0x50, 0x38, 0x58,
])

function success(base64 = Buffer.from(webp).toString("base64")) {
  return {
    apiVersion: "v1",
    image: { base64, mediaType: "image/webp" },
    model: graphicsImageModels[0],
    requestId: "request_123",
  }
}

describe("Graphics hosted image generation", () => {
  test("sends one authenticated duplicate-mitigated request and atomically writes WebP", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphics-generate-"))
    const outputPath = join(root, "generated.webp")
    const secrets = new FixedSecrets()
    let calls = 0
    try {
      const result = await generateGraphicsImageFile(
        {
          model: graphicsImageModels[0],
          prompt: "A restrained geometric texture",
          outputPath,
          idempotencyKey: "request-key-0001",
        },
        {
          discovery,
          secrets,
          fetch: async (input, init) => {
            calls += 1
            expect(String(input)).toBe(
              graphicsProductionContract.generateImage,
            )
            expect(init?.method).toBe("POST")
            expect(init?.redirect).toBe("error")
            const headers = new Headers(init?.headers)
            expect(headers.get("authorization")).toBe(
              "Bearer bounded-access-token",
            )
            expect(headers.get("idempotency-key")).toBe("request-key-0001")
            expect(JSON.parse(String(init?.body))).toEqual({
              model: graphicsImageModels[0],
              prompt: "A restrained geometric texture",
            })
            return Response.json(success())
          },
        },
      )
      expect(calls).toBe(1)
      expect(result).toMatchObject({
        bytes: webp.byteLength,
        mediaType: "image/webp",
        model: graphicsImageModels[0],
        outputPath,
        requestId: "request_123",
      })
      expect(await readFile(outputPath)).toEqual(Buffer.from(webp))
      expect(await readdir(root)).toEqual(["generated.webp"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("generates a process-local UUID when the caller omits idempotency", async () => {
    const result = await generateGraphicsImage(
      {
        model: graphicsImageModels[0],
        prompt: "one shape",
      },
      {
        discovery,
        secrets: new FixedSecrets(),
        fetch: async (_input, init) => {
          const key = new Headers(init?.headers).get("idempotency-key")
          expect(key).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
          )
          return Response.json(success())
        },
      },
    )
    expect(result.idempotencyKey).toHaveLength(36)
  })

  test("rejects invalid magic and never publishes a partial output", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphics-generate-invalid-"))
    const outputPath = join(root, "invalid.webp")
    try {
      await expect(
        generateGraphicsImageFile(
          {
            model: graphicsImageModels[0],
            prompt: "invalid response",
            outputPath,
          },
          {
            discovery,
            secrets: new FixedSecrets(),
            fetch: async () =>
              Response.json(
                success(Buffer.from("not webp", "utf8").toString("base64")),
              ),
          },
        ),
      ).rejects.toThrow("[GENERATION_INVALID_RESPONSE]")
      expect(await readdir(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("does not retry ambiguous failures and redacts the response body", async () => {
    let calls = 0
    let caught: unknown
    try {
      await generateGraphicsImage(
        {
          model: graphicsImageModels[0],
          prompt: "do not retry",
          idempotencyKey: "request-key-0002",
        },
        {
          discovery,
          secrets: new FixedSecrets(),
          fetch: async () => {
            calls += 1
            return new Response(
              JSON.stringify({
                error: "provider-secret-detail",
                bearer: "do-not-print-me",
              }),
              { status: 503 },
            )
          },
        },
      )
    } catch (error) {
      caught = error
    }
    expect(calls).toBe(1)
    expect(String(caught)).toContain("[GENERATION_FAILED]")
    expect(String(caught)).not.toContain("provider-secret-detail")
    expect(String(caught)).not.toContain("do-not-print-me")
  })

  test("revalidates injected discovery before reading or sending a bearer token", async () => {
    let calls = 0
    await expect(
      generateGraphicsImage(
        {
          model: graphicsImageModels[0],
          prompt: "do not exfiltrate",
        },
        {
          discovery: {
            ...discovery,
            endpoints: {
              generateImage: "https://attacker.example/collect",
            },
          } as unknown as typeof discovery,
          secrets: new FixedSecrets(),
          fetch: async () => {
            calls += 1
            throw new Error("must not fetch")
          },
        },
      ),
    ).rejects.toThrow("[DISCOVERY_INVALID]")
    expect(calls).toBe(0)
  })

  test("requires exact response fields, a 16-character key, and a WebP suffix", async () => {
    expect(() => validateGraphicsIdempotencyKey("short")).toThrow(
      "[INVALID_ARGUMENT]",
    )
    await expect(
      generateGraphicsImage(
        {
          model: graphicsImageModels[0],
          prompt: "strict response",
        },
        {
          discovery,
          secrets: new FixedSecrets(),
          fetch: async () => Response.json({ ...success(), extra: true }),
        },
      ),
    ).rejects.toThrow("[GENERATION_INVALID_RESPONSE]")

    await expect(
      generateGraphicsImageFile(
        {
          model: graphicsImageModels[0],
          prompt: "wrong suffix",
          outputPath: "image.png",
        },
        { discovery, secrets: new FixedSecrets() },
      ),
    ).rejects.toThrow("must end in .webp")

    for (const prompt of ["   \n\t", "valid\u0000invalid", "bad\u0007bell"]) {
      await expect(
        generateGraphicsImage(
          {
            model: graphicsImageModels[0],
            prompt,
          },
          { discovery, secrets: new FixedSecrets() },
        ),
      ).rejects.toThrow("[INVALID_ARGUMENT]")
    }
  })
})
