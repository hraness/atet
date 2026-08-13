import { createHash, randomUUID } from "node:crypto"
import { link, rm, writeFile } from "node:fs/promises"
import { dirname, extname, resolve } from "node:path"
import { TransmuteCloudError } from "./cloud-errors.js"

export const transmuteGatewayApiBaseUrl =
  "https://ai-gateway.vercel.sh/v4/ai" as const

export const transmuteImageModels = Object.freeze([
  "openai/gpt-image-1.5",
  "recraft/recraft-v4.1-utility",
] as const)

export const transmuteResponseMediaTypes = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp",
] as const)

export const transmuteMaximumPromptBytes = 32 * 1024
export const transmuteMaximumRawImageBytes = 64 * 1024 * 1024

export type TransmuteImageModel = string
export type TransmuteResponseMediaType =
  (typeof transmuteResponseMediaTypes)[number]
export type TransmuteGatewayCredentialSource =
  | "AI_GATEWAY_API_KEY"
  | "VERCEL_OIDC_TOKEN"

export interface TransmuteGatewayCredentialStatus {
  readonly available: boolean
  readonly source: TransmuteGatewayCredentialSource | null
}

export interface GenerateTransmuteImageInput {
  readonly model: TransmuteImageModel
  readonly prompt: string
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export interface GeneratedTransmuteImage {
  readonly image: {
    readonly base64: string
    readonly mediaType: TransmuteResponseMediaType
  }
  readonly model: TransmuteImageModel
  readonly provider: "vercel-ai-gateway"
  readonly requestId: string
  readonly warnings: readonly string[]
}

export interface GeneratedTransmuteImageFile {
  readonly bytes: number
  readonly mediaType: TransmuteResponseMediaType
  readonly model: TransmuteImageModel
  readonly outputPath: string
  readonly provider: "vercel-ai-gateway"
  readonly requestId: string
  readonly sha256: string
  readonly warnings: readonly string[]
}

type TransmuteEnvironment = Readonly<Record<string, string | undefined>>
type TransmuteGatewayFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

interface GatewayProvider {
  imageModel(modelId: string): unknown
}

interface GatewayRuntime {
  createGateway(settings: Readonly<{
    apiKey: string
    baseURL: typeof transmuteGatewayApiBaseUrl
    fetch: TransmuteGatewayFetch
  }>): GatewayProvider
  generateImage(input: Readonly<Record<string, unknown>>): Promise<unknown>
}

export interface TransmuteGenerateDependencies {
  readonly environment?: TransmuteEnvironment
  readonly fetch?: TransmuteGatewayFetch
  readonly loadRuntime?: () => Promise<GatewayRuntime>
  readonly maximumResponseBytes?: number
}

const defaultGenerationTimeoutMs = 5 * 60_000
const maximumGenerationTimeoutMs = 30 * 60_000
const defaultMaximumGatewayResponseBytes = 96 * 1024 * 1024

function invalidArgument(message: string): never {
  throw new TransmuteCloudError("INVALID_ARGUMENT", message)
}

function credentialValue(value: string): string {
  if (
    value.length < 16 ||
    value.length > 16 * 1024 ||
    value.trim() !== value ||
    /[^\x21-\x7e]/u.test(value)
  ) {
    throw new TransmuteCloudError(
      "AUTHENTICATION_REQUIRED",
      "The selected Vercel AI Gateway credential is invalid.",
    )
  }
  return value
}

function environment(
  injected: TransmuteEnvironment | undefined,
): TransmuteEnvironment {
  return injected ?? process.env
}

function resolveGatewayCredential(
  injected: TransmuteEnvironment | undefined,
): Readonly<{
  source: TransmuteGatewayCredentialSource
  token: string
}> {
  const values = environment(injected)
  if (values.AI_GATEWAY_API_KEY !== undefined) {
    return {
      source: "AI_GATEWAY_API_KEY",
      token: credentialValue(values.AI_GATEWAY_API_KEY),
    }
  }
  if (values.VERCEL_OIDC_TOKEN !== undefined) {
    return {
      source: "VERCEL_OIDC_TOKEN",
      token: credentialValue(values.VERCEL_OIDC_TOKEN),
    }
  }
  throw new TransmuteCloudError(
    "AUTHENTICATION_REQUIRED",
    "Set AI_GATEWAY_API_KEY or run Transmute through `vercel env run -- …` with VERCEL_OIDC_TOKEN available.",
  )
}

export function transmuteGatewayCredentialStatus(
  injected?: TransmuteEnvironment,
): TransmuteGatewayCredentialStatus {
  const values = environment(injected)
  if (values.AI_GATEWAY_API_KEY !== undefined) {
    credentialValue(values.AI_GATEWAY_API_KEY)
    return { available: true, source: "AI_GATEWAY_API_KEY" }
  }
  if (values.VERCEL_OIDC_TOKEN !== undefined) {
    credentialValue(values.VERCEL_OIDC_TOKEN)
    return { available: true, source: "VERCEL_OIDC_TOKEN" }
  }
  return { available: false, source: null }
}

function validateModel(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 256 ||
    !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/iu.test(value)
  ) {
    invalidArgument("Model must be a bounded Vercel AI Gateway provider/model id.")
  }
  return value
}

function validatePrompt(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
    Buffer.byteLength(value, "utf8") > transmuteMaximumPromptBytes
  ) {
    invalidArgument(
      `Prompt must be non-empty and no more than ${transmuteMaximumPromptBytes} UTF-8 bytes.`,
    )
  }
  return value
}

function validateTimeout(value: number | undefined): number {
  const timeout = value ?? defaultGenerationTimeoutMs
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1_000 ||
    timeout > maximumGenerationTimeoutMs
  ) {
    invalidArgument(
      `timeoutMs must be an integer from 1000 through ${maximumGenerationTimeoutMs}.`,
    )
  }
  return timeout
}

function isObject(value: unknown): value is Record<string, unknown> {
  return (
    (typeof value === "object" && value !== null) ||
    typeof value === "function"
  )
}

function parseFunction(
  value: unknown,
): (input: Readonly<Record<string, unknown>>) => Promise<unknown> {
  if (typeof value !== "function") {
    throw new TransmuteCloudError(
      "GENERATION_FAILED",
      "The Vercel AI Gateway runtime is unavailable.",
    )
  }
  return value as (
    input: Readonly<Record<string, unknown>>,
  ) => Promise<unknown>
}

function disableAiSdkWarningLogging(): void {
  (
    globalThis as typeof globalThis & {
      AI_SDK_LOG_WARNINGS?: false
    }
  ).AI_SDK_LOG_WARNINGS = false
}

function assertGenerationActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new TransmuteCloudError(
      "GENERATION_FAILED",
      "Vercel AI Gateway image generation was cancelled or exceeded its deadline.",
    )
  }
}

async function loadDefaultGatewayRuntime(): Promise<GatewayRuntime> {
  let aiModule: unknown
  let gatewayModule: unknown
  try {
    ;[aiModule, gatewayModule] = await Promise.all([
      import("ai-v7"),
      import("@ai-sdk/gateway-v4"),
    ])
  } catch {
    throw new TransmuteCloudError(
      "GENERATION_FAILED",
      "The Vercel AI Gateway runtime is unavailable.",
    )
  }
  if (!isObject(aiModule) || !isObject(gatewayModule)) {
    throw new TransmuteCloudError(
      "GENERATION_FAILED",
      "The Vercel AI Gateway runtime is unavailable.",
    )
  }
  const generateImage = parseFunction(aiModule.generateImage)
  if (typeof gatewayModule.createGateway !== "function") {
    throw new TransmuteCloudError(
      "GENERATION_FAILED",
      "The Vercel AI Gateway runtime is unavailable.",
    )
  }
  const createGateway = gatewayModule.createGateway as (
    settings: Readonly<Record<string, unknown>>,
  ) => unknown
  return {
    createGateway: settings => {
      const provider = createGateway(settings)
      if (!isObject(provider) || typeof provider.imageModel !== "function") {
        throw new TransmuteCloudError(
          "GENERATION_FAILED",
          "The Vercel AI Gateway runtime is unavailable.",
        )
      }
      const imageModel = provider.imageModel as (modelId: string) => unknown
      return { imageModel: modelId => imageModel.call(provider, modelId) }
    },
    generateImage,
  }
}

function gatewayUrl(input: string | URL | Request): URL {
  try {
    if (input instanceof Request) return new URL(input.url)
    if (input instanceof URL) return new URL(input.href)
    return new URL(input, transmuteGatewayApiBaseUrl)
  } catch {
    throw new TransmuteCloudError(
      "GENERATION_FAILED",
      "The Vercel AI Gateway request was rejected.",
    )
  }
}

function canonicalGatewayInput(
  input: string | URL | Request,
  url: URL,
): URL | Request {
  if (!(input instanceof Request)) return url

  // Snapshot the Request's internal data, then bind it to the URL that was
  // actually validated. Never forward a foreign Request subclass directly.
  const snapshot = new Request(input)
  const body = snapshot.method === "GET" || snapshot.method === "HEAD"
    ? undefined
    : snapshot.body ?? undefined
  const requestInit: RequestInit & { duplex?: "half" } = {
    headers: snapshot.headers,
    method: snapshot.method,
    signal: snapshot.signal,
    ...(body === undefined ? {} : { body, duplex: "half" }),
  }
  return new Request(url.href, requestInit)
}

function boundedResponse(response: Response, maximumBytes: number): Response {
  const declared = response.headers.get("content-length")
  if (declared !== null) {
    const value = Number(declared)
    if (!Number.isSafeInteger(value) || value < 0 || value > maximumBytes) {
      void response.body?.cancel().catch(() => undefined)
      throw new TransmuteCloudError(
        "GENERATION_INVALID_RESPONSE",
        "Vercel AI Gateway returned an invalid bounded response.",
      )
    }
  }
  if (response.body === null) return response
  const reader = response.body.getReader()
  let bytes = 0
  const body = new ReadableStream<Uint8Array>({
    cancel: async reason => await reader.cancel(reason),
    pull: async controller => {
      try {
        const next = await reader.read()
        if (next.done) {
          reader.releaseLock()
          controller.close()
          return
        }
        bytes += next.value.byteLength
        if (bytes > maximumBytes) {
          await reader.cancel().catch(() => undefined)
          controller.error(
            new TransmuteCloudError(
              "GENERATION_INVALID_RESPONSE",
              "Vercel AI Gateway returned an invalid bounded response.",
            ),
          )
          return
        }
        controller.enqueue(next.value)
      } catch {
        controller.error(
          new TransmuteCloudError(
            "GENERATION_INVALID_RESPONSE",
            "Vercel AI Gateway returned an invalid bounded response.",
          ),
        )
      }
    },
  })
  return new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  })
}

export function createFixedGatewayFetch(
  options: Readonly<{
    fetch?: TransmuteGatewayFetch
    maximumResponseBytes?: number
  }> = {},
): TransmuteGatewayFetch {
  const fetchImplementation = options.fetch ?? globalThis.fetch
  const maximumResponseBytes =
    options.maximumResponseBytes ?? defaultMaximumGatewayResponseBytes
  if (
    !Number.isSafeInteger(maximumResponseBytes) ||
    maximumResponseBytes < 1 ||
    maximumResponseBytes > 1024 * 1024 * 1024
  ) {
    invalidArgument("maximumResponseBytes is outside the supported range.")
  }
  const fixed = new URL(transmuteGatewayApiBaseUrl)
  return async (input, init) => {
    const url = gatewayUrl(input)
    if (
      url.origin !== fixed.origin ||
      (url.pathname !== fixed.pathname &&
        !url.pathname.startsWith(`${fixed.pathname}/`)) ||
      url.username !== "" ||
      url.password !== ""
    ) {
      throw new TransmuteCloudError(
        "GENERATION_FAILED",
        "The Vercel AI Gateway request was rejected.",
      )
    }
    const canonicalInput = canonicalGatewayInput(input, url)
    let response: Response
    try {
      response = await fetchImplementation(canonicalInput, {
        ...init,
        redirect: "error",
      })
    } catch (error) {
      if (error instanceof TransmuteCloudError) throw error
      throw new TransmuteCloudError(
        "GENERATION_FAILED",
        "Vercel AI Gateway image generation failed; the request was not retried.",
      )
    }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined)
      throw new TransmuteCloudError(
        "GENERATION_FAILED",
        "The Vercel AI Gateway request was rejected.",
      )
    }
    return boundedResponse(response, maximumResponseBytes)
  }
}

function combineSignals(
  caller: AbortSignal | undefined,
  timeoutMs: number,
): Readonly<{
  dispose(): void
  interruption: Promise<never>
  signal: AbortSignal
}> {
  const controller = new AbortController()
  const abort = (): void => controller.abort(caller?.reason)
  let rejectInterruption: ((error: TransmuteCloudError) => void) | undefined
  const interruption = new Promise<never>((_resolve, reject) => {
    rejectInterruption = reject
  })
  const rejectOnAbort = (): void => {
    rejectInterruption?.(new TransmuteCloudError(
      "GENERATION_FAILED",
      "Vercel AI Gateway image generation was cancelled or exceeded its deadline.",
    ))
  }
  controller.signal.addEventListener("abort", rejectOnAbort, { once: true })
  if (caller?.aborted === true) abort()
  caller?.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return {
    dispose: () => {
      clearTimeout(timer)
      caller?.removeEventListener("abort", abort)
      controller.signal.removeEventListener("abort", rejectOnAbort)
      rejectInterruption = undefined
    },
    interruption,
    signal: controller.signal,
  }
}

function mediaType(value: unknown): TransmuteResponseMediaType {
  if (
    typeof value !== "string" ||
    !transmuteResponseMediaTypes.includes(value as TransmuteResponseMediaType)
  ) {
    throw new TransmuteCloudError(
      "GENERATION_INVALID_RESPONSE",
      "Vercel AI Gateway returned an unsupported image type.",
    )
  }
  return value as TransmuteResponseMediaType
}

function validImageBytes(
  bytes: Uint8Array,
  type: TransmuteResponseMediaType,
): boolean {
  if (
    bytes.byteLength < 12 ||
    bytes.byteLength > transmuteMaximumRawImageBytes
  ) {
    return false
  }
  if (type === "image/png") {
    return Buffer.from(bytes.subarray(0, 8)).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    )
  }
  if (type === "image/jpeg") {
    return (
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes.at(-2) === 0xff &&
      bytes.at(-1) === 0xd9
    )
  }
  return (
    bytes.byteLength >= 16 &&
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes).readUInt32LE(4) === bytes.byteLength - 8 &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP" &&
    ["VP8 ", "VP8L", "VP8X"].includes(
      Buffer.from(bytes.subarray(12, 16)).toString("ascii"),
    )
  )
}

function warningReceipt(value: unknown): string {
  let type = "provider-warning"
  let detail = "Provider warning"
  if (typeof value === "string") {
    detail = value
  } else if (isObject(value)) {
    if (typeof value.type === "string" && value.type.length <= 64) {
      type = value.type.replace(/[^a-z0-9._-]/giu, "-") || type
    }
    if (typeof value.message === "string") detail = value.message
    else if (typeof value.details === "string") detail = value.details
  }
  return `${type} sha256:${createHash("sha256").update(detail).digest("hex")}`
}

function parseResult(
  value: unknown,
  model: string,
): Readonly<{ bytes: Uint8Array; response: GeneratedTransmuteImage }> {
  if (!isObject(value) || !Array.isArray(value.images) || value.images.length !== 1) {
    throw new TransmuteCloudError(
      "GENERATION_INVALID_RESPONSE",
      "Vercel AI Gateway did not return exactly one image.",
    )
  }
  const image = value.images[0]
  if (!isObject(image) || !(image.uint8Array instanceof Uint8Array)) {
    throw new TransmuteCloudError(
      "GENERATION_INVALID_RESPONSE",
      "Vercel AI Gateway returned an invalid bounded image.",
    )
  }
  const type = mediaType(image.mediaType)
  if (!validImageBytes(image.uint8Array, type)) {
    throw new TransmuteCloudError(
      "GENERATION_INVALID_RESPONSE",
      "Vercel AI Gateway returned an invalid bounded image.",
    )
  }
  const gateway = isObject(value.providerMetadata) &&
      isObject(value.providerMetadata.gateway)
    ? value.providerMetadata.gateway
    : undefined
  const foreignGenerationId = gateway !== undefined &&
      typeof gateway.generationId === "string" &&
      gateway.generationId.length > 0 &&
      gateway.generationId.length <= 256 &&
      !/[\u0000-\u001f\u007f]/u.test(gateway.generationId)
    ? gateway.generationId
    : randomUUID()
  const requestId = `sha256:${createHash("sha256")
    .update("transmute.gateway-generation-id/v1\0")
    .update(foreignGenerationId)
    .digest("hex")}`
  const warnings = Array.isArray(value.warnings)
    ? value.warnings.slice(0, 100).map(warningReceipt)
    : []
  return {
    bytes: image.uint8Array,
    response: {
      image: {
        base64: Buffer.from(image.uint8Array).toString("base64"),
        mediaType: type,
      },
      model,
      provider: "vercel-ai-gateway",
      requestId,
      warnings,
    },
  }
}

async function performGeneration(
  input: GenerateTransmuteImageInput,
  dependencies: TransmuteGenerateDependencies,
): Promise<Readonly<{
  bytes: Uint8Array
  response: GeneratedTransmuteImage
}>> {
  const model = validateModel(input.model)
  const prompt = validatePrompt(input.prompt)
  const credential = resolveGatewayCredential(dependencies.environment)
  const timeout = combineSignals(input.signal, validateTimeout(input.timeoutMs))
  try {
    const generation = (async () => {
      assertGenerationActive(timeout.signal)
      // Raw AI SDK warnings may contain provider-controlled details. Transmute
      // emits only allowlisted warning kinds and message hashes.
      disableAiSdkWarningLogging()
      const runtime = await (dependencies.loadRuntime ?? loadDefaultGatewayRuntime)()
      assertGenerationActive(timeout.signal)
      const provider = runtime.createGateway({
        apiKey: credential.token,
        baseURL: transmuteGatewayApiBaseUrl,
        fetch: createFixedGatewayFetch({
          ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
          ...(dependencies.maximumResponseBytes === undefined
            ? {}
            : { maximumResponseBytes: dependencies.maximumResponseBytes }),
        }),
      })
      assertGenerationActive(timeout.signal)
      const generated = await runtime.generateImage({
        abortSignal: timeout.signal,
        maxRetries: 0,
        model: provider.imageModel(model),
        n: 1,
        prompt,
      })
      return parseResult(generated, model)
    })()
    return await Promise.race([generation, timeout.interruption])
  } catch (error) {
    if (error instanceof TransmuteCloudError) throw error
    throw new TransmuteCloudError(
      "GENERATION_FAILED",
      "Vercel AI Gateway image generation failed; the request was not retried.",
    )
  } finally {
    timeout.dispose()
  }
}

export async function generateTransmuteImage(
  input: GenerateTransmuteImageInput,
  dependencies: TransmuteGenerateDependencies = {},
): Promise<GeneratedTransmuteImage> {
  return (await performGeneration(input, dependencies)).response
}

function expectedMediaType(outputPath: string): TransmuteResponseMediaType {
  const extension = extname(outputPath).toLocaleLowerCase("en-US")
  if (extension === ".png") return "image/png"
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg"
  if (extension === ".webp") return "image/webp"
  invalidArgument("Output path must end in .png, .jpg, .jpeg, or .webp.")
}

async function atomicImageWrite(
  outputPath: string,
  bytes: Uint8Array,
): Promise<string> {
  const absolutePath = resolve(outputPath)
  const temporaryPath = resolve(
    dirname(absolutePath),
    `.${randomUUID()}.transmute-generate.tmp`,
  )
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx" })
    // A same-directory hard link atomically publishes only when the output is
    // absent. Concurrent writers cannot replace one another's selected asset.
    await link(temporaryPath, absolutePath)
    return absolutePath
  } catch {
    throw new TransmuteCloudError(
      "OUTPUT_WRITE_FAILED",
      "Transmute could not atomically write the generated image.",
    )
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

export async function generateTransmuteImageFile(
  input: GenerateTransmuteImageInput & { readonly outputPath: string },
  dependencies: TransmuteGenerateDependencies = {},
): Promise<GeneratedTransmuteImageFile> {
  if (
    typeof input.outputPath !== "string" ||
    input.outputPath.length < 1 ||
    input.outputPath.length > 4_096 ||
    input.outputPath.includes("\0")
  ) {
    invalidArgument("Output path must be a non-empty local path.")
  }
  const expected = expectedMediaType(input.outputPath)
  const generated = await performGeneration(input, dependencies)
  if (generated.response.image.mediaType !== expected) {
    throw new TransmuteCloudError(
      "GENERATION_INVALID_RESPONSE",
      `Generated ${generated.response.image.mediaType} does not match the requested ${expected} output path.`,
    )
  }
  const outputPath = await atomicImageWrite(input.outputPath, generated.bytes)
  return {
    bytes: generated.bytes.byteLength,
    mediaType: generated.response.image.mediaType,
    model: generated.response.model,
    outputPath,
    provider: generated.response.provider,
    requestId: generated.response.requestId,
    sha256: createHash("sha256").update(generated.bytes).digest("hex"),
    warnings: generated.response.warnings,
  }
}
