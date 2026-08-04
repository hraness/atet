import { randomUUID } from "node:crypto"
import { rename, rm, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import {
  type TransmuteAuthDependencies,
  getTransmuteAccessToken,
} from "./auth.js"
import { TransmuteCloudError } from "./cloud-errors.js"
import {
  fetchTransmuteDiscovery,
  transmuteImageModels,
  transmuteResponseMediaTypes,
  parseTransmuteDiscovery,
  readBoundedResponseBytes,
  type TransmuteDiscoveryDocument,
  type TransmuteImageModel,
  type TransmuteResponseMediaType,
} from "./discovery.js"

const maximumIdempotencyKeyLength = 128
const minimumIdempotencyKeyLength = 16
const responseEnvelopeAllowanceBytes = 8 * 1024

export interface GenerateTransmuteImageInput {
  readonly model: TransmuteImageModel
  readonly prompt: string
  readonly idempotencyKey?: string
}

export interface GeneratedTransmuteImage {
  readonly apiVersion: "v1"
  readonly image: {
    readonly base64: string
    readonly mediaType: TransmuteResponseMediaType
  }
  readonly model: TransmuteImageModel
  readonly requestId: string
}

export interface GeneratedTransmuteImageFile {
  readonly bytes: number
  readonly idempotencyKey: string
  readonly mediaType: TransmuteResponseMediaType
  readonly model: TransmuteImageModel
  readonly outputPath: string
  readonly requestId: string
}

export interface TransmuteGenerateDependencies extends TransmuteAuthDependencies {
  readonly discovery?: TransmuteDiscoveryDocument
}

function invalidArgument(message: string): never {
  throw new TransmuteCloudError("INVALID_ARGUMENT", message)
}

export function validateTransmuteIdempotencyKey(value: string): string {
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
  input: GenerateTransmuteImageInput,
  discovery: TransmuteDiscoveryDocument,
): { readonly idempotencyKey: string; readonly requestBody: string } {
  if (!transmuteImageModels.includes(input.model)) {
    invalidArgument(
      `Model must be ${transmuteImageModels[0]} or ${transmuteImageModels[1]}.`,
    )
  }
  if (
    typeof input.prompt !== "string" ||
    input.prompt.trim().length === 0 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.prompt) ||
    Buffer.byteLength(input.prompt, "utf8") >
      discovery.capabilities.media.imageGeneration.maximumPromptBytes
  ) {
    invalidArgument(
      `Prompt must be non-empty and no more than ${discovery.capabilities.media.imageGeneration.maximumPromptBytes} UTF-8 bytes.`,
    )
  }
  const idempotencyKey = validateTransmuteIdempotencyKey(
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
  _mediaType: TransmuteResponseMediaType,
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

function parseGeneratedTransmuteImage(
  value: unknown,
  discovery: TransmuteDiscoveryDocument,
  requestedModel: TransmuteImageModel,
): { readonly response: GeneratedTransmuteImage; readonly bytes: Uint8Array } {
  const trustedDiscovery = parseTransmuteDiscovery(discovery)
  const invalid = new TransmuteCloudError(
    "GENERATION_INVALID_RESPONSE",
    "Transmute image generation returned an invalid bounded image.",
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
    !transmuteResponseMediaTypes.includes(
      value.image.mediaType as TransmuteResponseMediaType,
    ) ||
    value.image.mediaType !==
      trustedDiscovery.capabilities.media.imageGeneration.responseMediaTypes[0]
  ) {
    throw invalid
  }
  const bytes = Buffer.from(value.image.base64, "base64")
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength >
      trustedDiscovery.capabilities.media.imageGeneration.maximumRawImageBytes ||
    bytes.toString("base64") !== value.image.base64 ||
    !hasExpectedMagic(
      bytes,
      value.image.mediaType as TransmuteResponseMediaType,
    )
  ) {
    throw invalid
  }
  return {
    response: {
      apiVersion: "v1",
      image: {
        base64: value.image.base64,
        mediaType: value.image.mediaType as TransmuteResponseMediaType,
      },
      model: requestedModel,
      requestId: value.requestId,
    },
    bytes,
  }
}

async function performGeneration(
  input: GenerateTransmuteImageInput,
  dependencies: TransmuteGenerateDependencies,
): Promise<{
  readonly bytes: Uint8Array
  readonly idempotencyKey: string
  readonly response: GeneratedTransmuteImage
}> {
  const discovery =
    dependencies.discovery === undefined
      ? await fetchTransmuteDiscovery(dependencies.fetch)
      : parseTransmuteDiscovery(dependencies.discovery)
  const { idempotencyKey, requestBody } = validateInput(input, discovery)
  const accessToken = await getTransmuteAccessToken(discovery, dependencies)
  const maximumResponseBytes =
    Math.ceil(discovery.capabilities.media.imageGeneration.maximumRawImageBytes / 3) * 4 +
    responseEnvelopeAllowanceBytes
  const failed = new TransmuteCloudError(
    "GENERATION_FAILED",
    "Transmute image generation failed; the request was not retried.",
  )
  let response: Response
  try {
    response = await (dependencies.fetch ?? fetch)(
      discovery.capabilities.media.endpoints.generateImage,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
          [discovery.capabilities.media.imageGeneration.idempotency.header]: idempotencyKey,
          "user-agent": "hraness-transmute-cli/0.9.0",
        },
        body: requestBody,
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
      },
    )
  } catch (cause) {
    throw new TransmuteCloudError(
      "GENERATION_FAILED",
      "Transmute image generation failed; the request was not retried.",
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
    throw new TransmuteCloudError(
      "GENERATION_INVALID_RESPONSE",
      "Transmute image generation returned invalid JSON.",
    )
  }
  const parsed = parseGeneratedTransmuteImage(value, discovery, input.model)
  return { ...parsed, idempotencyKey }
}

export async function generateTransmuteImage(
  input: GenerateTransmuteImageInput,
  dependencies: TransmuteGenerateDependencies = {},
): Promise<GeneratedTransmuteImage & { readonly idempotencyKey: string }> {
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
    `.${randomUUID()}.transmute-generate.tmp`,
  )
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx" })
    await rename(temporaryPath, absolutePath)
    return absolutePath
  } catch (cause) {
    throw new TransmuteCloudError(
      "OUTPUT_WRITE_FAILED",
      "Transmute could not atomically write the generated image.",
      { cause },
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
