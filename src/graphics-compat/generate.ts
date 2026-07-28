import { randomUUID } from "node:crypto"
import { rename, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import {
  type GraphicsAuthDependencies,
  getGraphicsAccessToken,
} from "./auth.js"
import { GraphicsCloudError } from "./cloud-errors.js"
import {
  fetchGraphicsDiscovery,
  graphicsImageModels,
  graphicsResponseMediaTypes,
  parseGraphicsDiscovery,
  readBoundedResponseBytes,
  type GraphicsDiscoveryDocument,
  type GraphicsImageModel,
  type GraphicsResponseMediaType,
} from "./discovery.js"

const maximumIdempotencyKeyLength = 128
const minimumIdempotencyKeyLength = 16
const responseEnvelopeAllowanceBytes = 8 * 1024

export interface GenerateGraphicsImageInput {
  readonly model: GraphicsImageModel
  readonly prompt: string
  readonly idempotencyKey?: string
}

export interface GeneratedGraphicsImage {
  readonly apiVersion: "v1"
  readonly image: {
    readonly base64: string
    readonly mediaType: GraphicsResponseMediaType
  }
  readonly model: GraphicsImageModel
  readonly requestId: string
}

export interface GeneratedGraphicsImageFile {
  readonly bytes: number
  readonly idempotencyKey: string
  readonly mediaType: GraphicsResponseMediaType
  readonly model: GraphicsImageModel
  readonly outputPath: string
  readonly requestId: string
}

export interface GraphicsGenerateDependencies extends GraphicsAuthDependencies {
  readonly discovery?: GraphicsDiscoveryDocument
}

function invalidArgument(message: string): never {
  throw new GraphicsCloudError("INVALID_ARGUMENT", message)
}

export function validateGraphicsIdempotencyKey(value: string): string {
  if (
    value.length < minimumIdempotencyKeyLength ||
    value.length > maximumIdempotencyKeyLength ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  ) {
    invalidArgument(
      "Idempotency key must be 16–128 characters using letters, digits, `.`, `_`, `:`, or `-`.",
    )
  }
  return value
}

function validateInput(
  input: GenerateGraphicsImageInput,
  discovery: GraphicsDiscoveryDocument,
): { readonly idempotencyKey: string; readonly requestBody: string } {
  if (!graphicsImageModels.includes(input.model)) {
    invalidArgument(
      `Model must be ${graphicsImageModels[0]} or ${graphicsImageModels[1]}.`,
    )
  }
  if (
    typeof input.prompt !== "string" ||
    input.prompt.trim().length === 0 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.prompt) ||
    Buffer.byteLength(input.prompt, "utf8") >
      discovery.imageGeneration.maximumPromptBytes
  ) {
    invalidArgument(
      `Prompt must be non-empty and no more than ${discovery.imageGeneration.maximumPromptBytes} UTF-8 bytes.`,
    )
  }
  const idempotencyKey = validateGraphicsIdempotencyKey(
    input.idempotencyKey ?? randomUUID(),
  )
  return {
    idempotencyKey,
    requestBody: JSON.stringify({
      model: input.model,
      prompt: input.prompt,
    }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort()
  const canonical = [...expected].sort()
  return (
    actual.length === canonical.length &&
    actual.every((entry, index) => entry === canonical[index])
  )
}

function isCanonicalBase64(value: string): boolean {
  return (
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  )
}

function hasExpectedMagic(
  bytes: Uint8Array,
  _mediaType: GraphicsResponseMediaType,
): boolean {
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

function parseGeneratedGraphicsImage(
  value: unknown,
  discovery: GraphicsDiscoveryDocument,
  requestedModel: GraphicsImageModel,
): { readonly response: GeneratedGraphicsImage; readonly bytes: Uint8Array } {
  const trustedDiscovery = parseGraphicsDiscovery(discovery)
  const invalid = new GraphicsCloudError(
    "GENERATION_INVALID_RESPONSE",
    "Graphics image generation returned an invalid bounded image.",
  )
  if (
    !isRecord(value) ||
    !exactKeys(value, ["apiVersion", "image", "model", "requestId"]) ||
    value.apiVersion !== "v1" ||
    value.model !== requestedModel ||
    typeof value.requestId !== "string" ||
    value.requestId.length < 1 ||
    value.requestId.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(value.requestId) ||
    !isRecord(value.image) ||
    !exactKeys(value.image, ["base64", "mediaType"]) ||
    typeof value.image.base64 !== "string" ||
    !isCanonicalBase64(value.image.base64) ||
    typeof value.image.mediaType !== "string" ||
    !graphicsResponseMediaTypes.includes(
      value.image.mediaType as GraphicsResponseMediaType,
    ) ||
    value.image.mediaType !==
      trustedDiscovery.imageGeneration.responseMediaTypes[0]
  ) {
    throw invalid
  }
  const bytes = Buffer.from(value.image.base64, "base64")
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength >
      trustedDiscovery.imageGeneration.maximumRawImageBytes ||
    bytes.toString("base64") !== value.image.base64 ||
    !hasExpectedMagic(
      bytes,
      value.image.mediaType as GraphicsResponseMediaType,
    )
  ) {
    throw invalid
  }
  return {
    response: {
      apiVersion: "v1",
      image: {
        base64: value.image.base64,
        mediaType: value.image.mediaType as GraphicsResponseMediaType,
      },
      model: requestedModel,
      requestId: value.requestId,
    },
    bytes,
  }
}

async function performGeneration(
  input: GenerateGraphicsImageInput,
  dependencies: GraphicsGenerateDependencies,
): Promise<{
  readonly bytes: Uint8Array
  readonly idempotencyKey: string
  readonly response: GeneratedGraphicsImage
}> {
  const discovery =
    dependencies.discovery === undefined
      ? await fetchGraphicsDiscovery(dependencies.fetch)
      : parseGraphicsDiscovery(dependencies.discovery)
  const { idempotencyKey, requestBody } = validateInput(input, discovery)
  const accessToken = await getGraphicsAccessToken(discovery, dependencies)
  const maximumResponseBytes =
    Math.ceil(discovery.imageGeneration.maximumRawImageBytes / 3) * 4 +
    responseEnvelopeAllowanceBytes
  const failed = new GraphicsCloudError(
    "GENERATION_FAILED",
    "Graphics image generation failed; the request was not retried.",
  )
  let response: Response
  try {
    response = await (dependencies.fetch ?? fetch)(
      discovery.endpoints.generateImage,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          [discovery.imageGeneration.idempotency.header]: idempotencyKey,
          "user-agent": "hraness-graphics-cli/0.4.0",
        },
        body: requestBody,
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
      },
    )
  } catch (cause) {
    throw new GraphicsCloudError(
      "GENERATION_FAILED",
      "Graphics image generation failed; the request was not retried.",
      { cause },
    )
  }
  const contentType = response.headers.get("content-type")
  if (
    contentType === null ||
    !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/iu.test(
      contentType,
    )
  ) {
    await response.body?.cancel().catch(() => undefined)
    throw failed
  }
  const responseBytes = await readBoundedResponseBytes(
    response,
    maximumResponseBytes,
    failed,
  )
  if (!response.ok) throw failed
  let value: unknown
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(responseBytes),
    )
  } catch {
    throw new GraphicsCloudError(
      "GENERATION_INVALID_RESPONSE",
      "Graphics image generation returned invalid JSON.",
    )
  }
  const parsed = parseGeneratedGraphicsImage(value, discovery, input.model)
  return { ...parsed, idempotencyKey }
}

export async function generateGraphicsImage(
  input: GenerateGraphicsImageInput,
  dependencies: GraphicsGenerateDependencies = {},
): Promise<GeneratedGraphicsImage & { readonly idempotencyKey: string }> {
  const generated = await performGeneration(input, dependencies)
  return { ...generated.response, idempotencyKey: generated.idempotencyKey }
}

async function atomicImageWrite(
  outputPath: string,
  bytes: Uint8Array,
): Promise<string> {
  const absolutePath = resolve(outputPath)
  const temporaryPath = resolve(
    dirname(absolutePath),
    `.${randomUUID()}.graphics-generate.tmp`,
  )
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx" })
    await rename(temporaryPath, absolutePath)
    return absolutePath
  } catch (cause) {
    throw new GraphicsCloudError(
      "OUTPUT_WRITE_FAILED",
      "Graphics could not atomically write the generated image.",
      { cause },
    )
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

export async function generateGraphicsImageFile(
  input: GenerateGraphicsImageInput & { readonly outputPath: string },
  dependencies: GraphicsGenerateDependencies = {},
): Promise<GeneratedGraphicsImageFile> {
  if (
    typeof input.outputPath !== "string" ||
    input.outputPath.length < 1 ||
    input.outputPath.length > 4_096 ||
    input.outputPath.includes("\0")
  ) {
    invalidArgument("Output path must be a non-empty local path.")
  }
  if (!input.outputPath.toLowerCase().endsWith(".webp")) {
    invalidArgument("Output path must end in .webp.")
  }
  const generated = await performGeneration(input, dependencies)
  const outputPath = await atomicImageWrite(input.outputPath, generated.bytes)
  return {
    bytes: generated.bytes.byteLength,
    idempotencyKey: generated.idempotencyKey,
    mediaType: generated.response.image.mediaType,
    model: generated.response.model,
    outputPath,
    requestId: generated.response.requestId,
  }
}
