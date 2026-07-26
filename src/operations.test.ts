import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  graphicsImageModels,
  graphicsProductionContract,
  graphicsRedirectUri,
  parseGraphicsDiscovery,
} from "./discovery.ts"
import {
  executeGraphicsOperation,
  graphicsOperationCodes,
  graphicsOperationRegistry,
  parseGraphicsOperationInput,
  searchGraphicsOperations,
} from "./operations.ts"

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

describe("canonical Graphics operations", () => {
  test("publishes four exact semantic codes in stable order", () => {
    expect(graphicsOperationRegistry.map(({ code }) => code)).toEqual(
      [...graphicsOperationCodes],
    )
    expect(
      graphicsOperationRegistry.find(
        ({ code }) => code === "graphics.image.generate",
      ),
    ).toMatchObject({
      execution: "hosted",
      authentication: "required",
      destructive: true,
      idempotent: false,
      transport: {
        method: "POST",
        endpointFromDiscovery: "endpoints.generateImage",
        authorization: "bearer",
        idempotencyHeader: "Idempotency-Key",
        retry: "never",
      },
    })
    expect(
      graphicsOperationRegistry.find(
        ({ code }) => code === "graphics.image.vectorize",
      ),
    ).toMatchObject({
      execution: "local",
      authentication: "required",
    })
  })

  test("searches bounded semantic metadata without fuzzy execution", () => {
    expect(searchGraphicsOperations("diagram").map(({ code }) => code)).toEqual([
      "graphics.diagram.check",
      "graphics.diagram.render",
    ])
    expect(searchGraphicsOperations("hosted image", 1).map(({ code }) => code))
      .toEqual(["graphics.image.generate"])
    expect(() => searchGraphicsOperations("\0")).toThrow("[INVALID_SEARCH]")
  })

  test("rejects unknown fields and source text instead of evaluating it", () => {
    expect(() =>
      parseGraphicsOperationInput("graphics.diagram.check", {
        path: "flow.diagram.json",
        source: "await Bun.write('/tmp/executed', 'yes')",
      }),
    ).toThrow("[INVALID_OPERATION_INPUT]")
    expect(() =>
      parseGraphicsOperationInput("graphics.image.generate", {
        model: "other/provider-model",
        prompt: "anything",
      }),
    ).toThrow("[INVALID_OPERATION_INPUT]")
    expect(() =>
      parseGraphicsOperationInput("graphics.image.generate", {
        model: graphicsImageModels[0],
        prompt: "anything",
      }),
    ).toThrow("outputPath")
    expect(() =>
      parseGraphicsOperationInput("graphics.image.vectorize", {
        inputPath: "input.png",
        outputPath: "output.png",
      }),
    ).toThrow("must end in .svg")
  })

  test("executes a fixed local diagram adapter by exact code", async () => {
    const root = await mkdtemp(join(tmpdir(), "graphics-operation-check-"))
    try {
      const path = join(root, "flow.diagram.json")
      const marker = join(root, "config-executed")
      await writeFile(
        path,
        JSON.stringify({
          version: 1,
          name: "flow",
          canvas: { width: 400, height: 200 },
          shapes: [
            {
              id: "one",
              type: "rect",
              x: 40,
              y: 40,
              width: 120,
              height: 80,
            },
          ],
        }),
      )
      await writeFile(
        join(root, "graphics.config.ts"),
        `await Bun.write(${JSON.stringify(marker)}, "executed"); export default {}\n`,
      )
      const result = await executeGraphicsOperation(
        "graphics.diagram.check",
        { path },
      )
      expect(result).toMatchObject({
        configPath: null,
        findings: expect.any(Array),
      })
      expect(await Bun.file(marker).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("auth-gates local vectorization without uploading its path or bytes", async () => {
    const networkInputs: string[] = []
    await expect(
      executeGraphicsOperation(
        "graphics.image.vectorize",
        {
          inputPath: "/private/caller-owned.png",
          outputPath: "/private/caller-owned.svg",
        },
        {
          fetch: async (input) => {
            networkInputs.push(String(input))
            return Response.json(discovery)
          },
          secrets: {
            get: async () => null,
            set: async () => undefined,
            delete: async () => false,
          },
        },
      ),
    ).rejects.toThrow("[AUTH_REQUIRED]")
    expect(networkInputs).toEqual([
      "https://hraness.graphics/.well-known/graphics-cli.json",
    ])
    expect(JSON.stringify(networkInputs)).not.toContain("caller-owned")
  })
})
