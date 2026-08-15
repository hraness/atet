import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createFixedGatewayFetch,
  generateAtetImage,
  generateAtetImageFile,
  atetGatewayApiBaseUrl,
  atetGatewayCredentialStatus,
  type AtetGenerateDependencies,
} from "./generate.ts"

const webp = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x08, 0x00, 0x00, 0x00,
  0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58,
])

function runtime(
  inspect?: (settings: Readonly<Record<string, unknown>>) => void,
  generationId = "gen_123",
): NonNullable<AtetGenerateDependencies["loadRuntime"]> {
  return async () => ({
    createGateway(settings) {
      inspect?.(settings)
      return { imageModel: modelId => ({ modelId }) }
    },
    async generateImage(settings) {
      inspect?.(settings)
      return {
        images: [{ mediaType: "image/webp", uint8Array: webp }],
        providerMetadata: { gateway: { generationId } },
        warnings: [{ message: "secret provider detail", type: "other" }],
      }
    },
  })
}

describe("Vercel AI Gateway image generation", () => {
  test("prefers the explicit Gateway key, never returns it, and requests zero retries", async () => {
    const seen: Readonly<Record<string, unknown>>[] = []
    const result = await generateAtetImage(
      { model: "openai/gpt-image-1.5", prompt: "one cobalt circle" },
      {
        environment: {
          AI_GATEWAY_API_KEY: "gateway-key-value",
          VERCEL_OIDC_TOKEN: "oidc-token-value",
        },
        loadRuntime: runtime(value => seen.push(value), "gateway-key-value"),
      },
    )
    expect(seen[0]).toMatchObject({
      apiKey: "gateway-key-value",
      baseURL: atetGatewayApiBaseUrl,
    })
    expect(seen[1]).toMatchObject({ maxRetries: 0, n: 1 })
    expect((globalThis as typeof globalThis & {
      AI_SDK_LOG_WARNINGS?: boolean
    }).AI_SDK_LOG_WARNINGS).toBe(false)
    expect(result).toMatchObject({
      model: "openai/gpt-image-1.5",
      provider: "vercel-ai-gateway",
      requestId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    })
    expect(JSON.stringify(result)).not.toContain("gateway-key-value")
    expect(JSON.stringify(result)).not.toContain("secret provider detail")
    expect(result.warnings[0]).toMatch(/^other sha256:[a-f0-9]{64}$/u)
  })

  test("accepts Vercel OIDC from vercel env run without persisting it", async () => {
    let token = ""
    await generateAtetImage(
      { model: "recraft/recraft-v4.1-utility", prompt: "metallic mark" },
      {
        environment: { VERCEL_OIDC_TOKEN: "oidc-test-token-0001" },
        loadRuntime: runtime(settings => {
          if (typeof settings.apiKey === "string") token = settings.apiKey
        }),
      },
    )
    expect(token).toBe("oidc-test-token-0001")
    expect(atetGatewayCredentialStatus({
      VERCEL_OIDC_TOKEN: "oidc-test-token-0001",
    })).toEqual({ available: true, source: "VERCEL_OIDC_TOKEN" })
  })

  test("fails before loading a provider when no environment credential exists", async () => {
    let loaded = false
    await expect(generateAtetImage(
      { model: "openai/gpt-image-1.5", prompt: "no credential" },
      {
        environment: {},
        loadRuntime: async () => {
          loaded = true
          return await runtime()()
        },
      },
    )).rejects.toThrow("[AUTHENTICATION_REQUIRED]")
    expect(loaded).toBe(false)
    expect(atetGatewayCredentialStatus({})).toEqual({
      available: false,
      source: null,
    })
  })

  test("fails closed on an invalid explicit key instead of falling back to OIDC", async () => {
    let loaded = false
    await expect(generateAtetImage(
      { model: "openai/gpt-image-1.5", prompt: "invalid key" },
      {
        environment: {
          AI_GATEWAY_API_KEY: " malformed key ",
          VERCEL_OIDC_TOKEN: "valid-oidc-token-value",
        },
        loadRuntime: async () => {
          loaded = true
          return await runtime()()
        },
      },
    )).rejects.toThrow("[AUTHENTICATION_REQUIRED]")
    expect(() => atetGatewayCredentialStatus({
      AI_GATEWAY_API_KEY: " malformed key ",
      VERCEL_OIDC_TOKEN: "valid-oidc-token-value",
    })).toThrow("[AUTHENTICATION_REQUIRED]")
    expect(loaded).toBe(false)
  })

  test("an already-aborted caller never loads or dispatches the Gateway runtime", async () => {
    const controller = new AbortController()
    controller.abort(new Error("private caller detail"))
    let loadCalls = 0
    let createGatewayCalls = 0
    let generateImageCalls = 0

    await expect(generateAtetImage(
      {
        model: "openai/gpt-image-1.5",
        prompt: "cancel before loading",
        signal: controller.signal,
      },
      {
        environment: { AI_GATEWAY_API_KEY: "gateway-test-key-0001" },
        loadRuntime: async () => {
          loadCalls += 1
          return {
            createGateway: () => {
              createGatewayCalls += 1
              return { imageModel: (modelId: string) => modelId }
            },
            generateImage: async () => {
              generateImageCalls += 1
              return {}
            },
          }
        },
      },
    )).rejects.toThrow("[GENERATION_FAILED]")
    expect(loadCalls).toBe(0)
    expect(createGatewayCalls).toBe(0)
    expect(generateImageCalls).toBe(0)
  })

  test("writes a validated image atomically and returns a content receipt", async () => {
    const root = await mkdtemp(join(tmpdir(), "atet-gateway-image-"))
    const outputPath = join(root, "generated.webp")
    try {
      const result = await generateAtetImageFile(
        {
          model: "openai/gpt-image-1.5",
          outputPath,
          prompt: "one cobalt circle",
        },
        {
          environment: { AI_GATEWAY_API_KEY: "gateway-test-key-0001" },
          loadRuntime: runtime(),
        },
      )
      expect(await readFile(outputPath)).toEqual(Buffer.from(webp))
      expect(await readdir(root)).toEqual(["generated.webp"])
      expect(result).toMatchObject({
        bytes: webp.byteLength,
        mediaType: "image/webp",
        outputPath,
        provider: "vercel-ai-gateway",
      })
      expect(result.sha256).toMatch(/^[a-f0-9]{64}$/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("refuses to replace an existing generated image", async () => {
    const root = await mkdtemp(join(tmpdir(), "atet-gateway-no-clobber-"))
    const outputPath = join(root, "generated.webp")
    const original = new TextEncoder().encode("caller-owned")
    try {
      await Bun.write(outputPath, original)
      await expect(generateAtetImageFile(
        {
          model: "openai/gpt-image-1.5",
          outputPath,
          prompt: "one cobalt circle",
        },
        {
          environment: { AI_GATEWAY_API_KEY: "gateway-test-key-0001" },
          loadRuntime: runtime(),
        },
      )).rejects.toThrow("[OUTPUT_WRITE_FAILED]")
      expect(await readFile(outputPath)).toEqual(Buffer.from(original))
      expect(await readdir(root)).toEqual(["generated.webp"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("allows exactly one concurrent writer to publish an output", async () => {
    const root = await mkdtemp(join(tmpdir(), "atet-gateway-race-"))
    const outputPath = join(root, "generated.webp")
    try {
      const results = await Promise.allSettled([1, 2].map(async index =>
        await generateAtetImageFile(
          {
            model: "openai/gpt-image-1.5",
            outputPath,
            prompt: `candidate ${String(index)}`,
          },
          {
            environment: { AI_GATEWAY_API_KEY: "gateway-test-key-0001" },
            loadRuntime: runtime(),
          },
        )))
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1)
      expect(results.filter(result => result.status === "rejected")).toHaveLength(1)
      expect(await readFile(outputPath)).toEqual(Buffer.from(webp))
      expect(await readdir(root)).toEqual(["generated.webp"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects invalid media bytes and a suffix that disagrees with the response", async () => {
    const root = await mkdtemp(join(tmpdir(), "atet-gateway-invalid-"))
    try {
      const invalidRuntime = async () => ({
        createGateway: () => ({ imageModel: (modelId: string) => modelId }),
        generateImage: async () => ({
          images: [{
            mediaType: "image/webp",
            uint8Array: new TextEncoder().encode("not webp"),
          }],
        }),
      })
      await expect(generateAtetImageFile(
        {
          model: "openai/gpt-image-1.5",
          outputPath: join(root, "invalid.webp"),
          prompt: "invalid",
        },
        {
          environment: { AI_GATEWAY_API_KEY: "gateway-test-key-0001" },
          loadRuntime: invalidRuntime,
        },
      )).rejects.toThrow("[GENERATION_INVALID_RESPONSE]")
      await expect(generateAtetImageFile(
        {
          model: "openai/gpt-image-1.5",
          outputPath: join(root, "mismatch.png"),
          prompt: "mismatch",
        },
        {
          environment: { AI_GATEWAY_API_KEY: "gateway-test-key-0001" },
          loadRuntime: runtime(),
        },
      )).rejects.toThrow("does not match")
      expect(await readdir(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("pins all credential-bearing fetches to the Gateway v4 prefix", async () => {
    let calls = 0
    const forwarded: string[] = []
    const fixed = createFixedGatewayFetch({
      fetch: async input => {
        calls += 1
        forwarded.push(input instanceof Request ? input.url : String(input))
        return new Response("ok")
      },
      maximumResponseBytes: 16,
    })
    await fixed(`${atetGatewayApiBaseUrl}/images`, { redirect: "follow" })
    await expect(fixed("https://attacker.example/collect"))
      .rejects.toThrow("[GENERATION_FAILED]")
    await expect(fixed("https://ai-gateway.vercel.sh/v4/other"))
      .rejects.toThrow("[GENERATION_FAILED]")
    expect(calls).toBe(1)
    expect(forwarded).toEqual([`${atetGatewayApiBaseUrl}/images`])
  })

  test("forwards only the canonical URL that passed Gateway validation", async () => {
    let coercions = 0
    let forwarded = ""
    const mutableInput = {
      toString() {
        coercions += 1
        return coercions === 1
          ? `${atetGatewayApiBaseUrl}/images`
          : "https://attacker.example/collect"
      },
    }
    const fixed = createFixedGatewayFetch({
      fetch: async input => {
        forwarded = input instanceof Request ? input.url : String(input)
        return new Response("ok")
      },
      maximumResponseBytes: 16,
    })

    await fixed(mutableInput as unknown as string)

    expect(coercions).toBe(1)
    expect(forwarded).toBe(`${atetGatewayApiBaseUrl}/images`)
  })

  test("does not retry or expose provider failure details", async () => {
    let calls = 0
    let caught: unknown
    try {
      await generateAtetImage(
        { model: "openai/gpt-image-1.5", prompt: "no retry" },
        {
          environment: { AI_GATEWAY_API_KEY: "gateway-secret-value" },
          loadRuntime: async () => ({
            createGateway: () => ({ imageModel: (modelId: string) => modelId }),
            generateImage: async settings => {
              calls += 1
              expect(settings.maxRetries).toBe(0)
              throw new Error("provider-secret-detail gateway-secret-value")
            },
          }),
        },
      )
    } catch (error) {
      caught = error
    }
    expect(calls).toBe(1)
    expect(String(caught)).toContain("[GENERATION_FAILED]")
    expect(String(caught)).not.toContain("provider-secret-detail")
    expect(String(caught)).not.toContain("gateway-secret-value")
  })

  test("settles at the hard deadline when the provider ignores its abort signal", async () => {
    let observedSignal: AbortSignal | undefined
    const startedAt = performance.now()
    await expect(generateAtetImage(
      {
        model: "openai/gpt-image-1.5",
        prompt: "bounded generation",
        timeoutMs: 1_000,
      },
      {
        environment: { AI_GATEWAY_API_KEY: "gateway-test-key-0001" },
        loadRuntime: async () => ({
          createGateway: () => ({ imageModel: (modelId: string) => modelId }),
          generateImage: async settings => {
            observedSignal = settings.abortSignal as AbortSignal
            return await new Promise<never>(() => undefined)
          },
        }),
      },
    )).rejects.toThrow("[GENERATION_FAILED]")
    expect(observedSignal?.aborted).toBe(true)
    expect(performance.now() - startedAt).toBeLessThan(3_000)
  })

  test("settles when the caller aborts even if the provider does not", async () => {
    const controller = new AbortController()
    let observedSignal: AbortSignal | undefined
    let markDispatched: (() => void) | undefined
    const dispatched = new Promise<void>(resolve => {
      markDispatched = resolve
    })
    const generation = generateAtetImage(
      {
        model: "openai/gpt-image-1.5",
        prompt: "cancelled generation",
        signal: controller.signal,
      },
      {
        environment: { AI_GATEWAY_API_KEY: "gateway-test-key-0001" },
        loadRuntime: async () => ({
          createGateway: () => ({ imageModel: (modelId: string) => modelId }),
          generateImage: async settings => {
            observedSignal = settings.abortSignal as AbortSignal
            markDispatched?.()
            return await new Promise<never>(() => undefined)
          },
        }),
      },
    )
    await dispatched
    controller.abort(new Error("private caller detail"))
    await expect(generation).rejects.toThrow("[GENERATION_FAILED]")
    expect(observedSignal?.aborted).toBe(true)
    await expect(generation).rejects.not.toThrow("private caller detail")
  })

  test("never dispatches after cancellation wins a delayed runtime load", async () => {
    const controller = new AbortController()
    let dispatches = 0
    let releaseRuntime: (() => void) | undefined
    const runtimeLoaded = new Promise<void>(resolve => {
      releaseRuntime = resolve
    })
    const generation = generateAtetImage(
      {
        model: "openai/gpt-image-1.5",
        prompt: "cancel before dispatch",
        signal: controller.signal,
      },
      {
        environment: { AI_GATEWAY_API_KEY: "gateway-test-key-0001" },
        loadRuntime: async () => {
          await runtimeLoaded
          return {
            createGateway: () => ({ imageModel: (modelId: string) => modelId }),
            generateImage: async () => {
              dispatches += 1
              return {}
            },
          }
        },
      },
    )
    controller.abort()
    await expect(generation).rejects.toThrow("[GENERATION_FAILED]")
    releaseRuntime?.()
    await Bun.sleep(10)
    expect(dispatches).toBe(0)
  })
})
