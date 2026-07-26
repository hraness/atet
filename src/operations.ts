import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import {
  requireGraphicsAuthentication,
  type GraphicsAuthDependencies,
} from "./auth.ts"
import { builtInIcons } from "./icons.ts"
import { lintDiagram } from "./lint.ts"
import { parseDiagramSpec } from "./parse.ts"
import { renderPng, renderSvg } from "./render.ts"
import { serializeTldr } from "./tldr.ts"
import type { DiagramConfig, LintFinding, RenderArtifacts } from "./types.ts"
import {
  generateGraphicsImageFile,
  validateGraphicsIdempotencyKey,
  type GeneratedGraphicsImageFile,
} from "./generate.ts"
import {
  graphicsImageModels,
  graphicsMaximumPromptBytes,
  type GraphicsImageModel,
} from "./discovery.ts"
import {
  vectorizeImage,
  type VectorizeReceipt,
} from "./vectorize/index.ts"

export const graphicsOperationCodes = [
  "graphics.diagram.check",
  "graphics.diagram.render",
  "graphics.image.vectorize",
  "graphics.image.generate",
] as const

export type GraphicsOperationCode = (typeof graphicsOperationCodes)[number]

export interface GraphicsOperationDescriptor {
  readonly code: GraphicsOperationCode
  readonly title: string
  readonly description: string
  readonly execution: "local" | "hosted"
  readonly authentication: "none" | "required"
  readonly destructive: boolean
  readonly idempotent: boolean
  readonly inputSchema: Readonly<Record<string, unknown>>
  readonly transport?: {
    readonly method: "POST"
    readonly endpointFromDiscovery: "endpoints.generateImage"
    readonly authorization: "bearer"
    readonly idempotencyHeader: "Idempotency-Key"
    readonly retry: "never"
  }
}

export class GraphicsOperationError extends Error {
  readonly code:
    | "INVALID_OPERATION"
    | "INVALID_OPERATION_INPUT"
    | "INVALID_SEARCH"

  constructor(
    code: GraphicsOperationError["code"],
    message: string,
  ) {
    super(`[${code}] ${message}`)
    this.name = "GraphicsOperationError"
    this.code = code
  }
}

const modelSchema = {
  type: "string",
  enum: graphicsImageModels,
} as const

const pathSchema = {
  type: "string",
  minLength: 1,
  maxLength: 4_096,
} as const

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value
  }
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

export const graphicsOperationRegistry: readonly GraphicsOperationDescriptor[] =
  deepFreeze([
    {
      code: "graphics.diagram.check",
      title: "Check diagram",
      description:
        "Parse and lint a checked Graphics diagram source without changing its files.",
      execution: "local",
      authentication: "none",
      destructive: false,
      idempotent: true,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: { path: pathSchema },
      },
    },
    {
      code: "graphics.diagram.render",
      title: "Render diagram",
      description:
        "Render a checked Graphics diagram source to its replaceable light, dark, PNG, SVG, and tldraw artifacts.",
      execution: "local",
      authentication: "none",
      destructive: true,
      idempotent: true,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: pathSchema,
          outDirectory: pathSchema,
          scale: {
            type: "number",
            exclusiveMinimum: 0,
            maximum: 4,
          },
        },
      },
    },
    {
      code: "graphics.image.vectorize",
      title: "Vectorize image",
      description:
        "Convert a local caller-owned raster into a bounded inert SVG after proving a free Graphics login; source bytes remain local.",
      execution: "local",
      authentication: "required",
      destructive: true,
      idempotent: false,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["inputPath", "outputPath"],
        properties: {
          inputPath: pathSchema,
          outputPath: pathSchema,
          duotone: {
            type: "array",
            minItems: 2,
            maxItems: 2,
            items: {
              type: "string",
              pattern: "^#[a-fA-F0-9]{3}(?:[a-fA-F0-9]{3})?$",
            },
          },
          alphaCutoff: { type: "integer", minimum: 1, maximum: 64 },
          timeoutMs: { type: "integer", minimum: 1, maximum: 300_000 },
        },
      },
    },
    {
      code: "graphics.image.generate",
      title: "Generate image",
      description:
        "Generate one bounded WebP with an explicitly supported hosted model, process-local duplicate mitigation, and no ambiguous retry.",
      execution: "hosted",
      authentication: "required",
      destructive: true,
      idempotent: false,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["model", "prompt", "outputPath"],
        properties: {
          model: modelSchema,
          prompt: {
            type: "string",
            minLength: 1,
            maxLength: graphicsMaximumPromptBytes,
          },
          outputPath: pathSchema,
          idempotencyKey: {
            type: "string",
            minLength: 16,
            maxLength: 128,
            pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
          },
        },
      },
      transport: {
        method: "POST",
        endpointFromDiscovery: "endpoints.generateImage",
        authorization: "bearer",
        idempotencyHeader: "Idempotency-Key",
        retry: "never",
      },
    },
  ] satisfies readonly GraphicsOperationDescriptor[])

export interface CheckGraphicsOperationInput {
  readonly path: string
}

export interface RenderGraphicsOperationInput extends CheckGraphicsOperationInput {
  readonly outDirectory?: string
  readonly scale?: number
}

export interface VectorizeGraphicsOperationInput {
  readonly inputPath: string
  readonly outputPath: string
  readonly duotone?: readonly [string, string]
  readonly alphaCutoff?: number
  readonly timeoutMs?: number
}

export interface GenerateGraphicsOperationInput {
  readonly model: GraphicsImageModel
  readonly prompt: string
  readonly outputPath: string
  readonly idempotencyKey?: string
}

export interface GraphicsOperationInputMap {
  readonly "graphics.diagram.check": CheckGraphicsOperationInput
  readonly "graphics.diagram.render": RenderGraphicsOperationInput
  readonly "graphics.image.vectorize": VectorizeGraphicsOperationInput
  readonly "graphics.image.generate": GenerateGraphicsOperationInput
}

export interface GraphicsOperationResultMap {
  readonly "graphics.diagram.check": {
    readonly findings: readonly LintFinding[]
    readonly configPath: null
  }
  readonly "graphics.diagram.render": {
    readonly artifacts: RenderArtifacts
    readonly findings: readonly LintFinding[]
    readonly configPath: null
  }
  readonly "graphics.image.vectorize": {
    readonly outputPath: string
    readonly receipt: VectorizeReceipt
  }
  readonly "graphics.image.generate": GeneratedGraphicsImageFile
}

function operationFailure(message: string): never {
  throw new GraphicsOperationError("INVALID_OPERATION_INPUT", message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function record(
  value: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) operationFailure("Operation input must be an object.")
  const unknown = Object.keys(value).filter((key) => !allowedKeys.includes(key))
  if (unknown.length > 0) {
    operationFailure(`Unsupported operation input field: ${unknown[0]}.`)
  }
  return value
}

function pathValue(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4_096 ||
    value.includes("\0")
  ) {
    operationFailure(`${name} must be a non-empty bounded local path.`)
  }
  return value
}

function parseCheck(value: unknown): CheckGraphicsOperationInput {
  const input = record(value, ["path"])
  return { path: pathValue(input.path, "path") }
}

function parseRender(value: unknown): RenderGraphicsOperationInput {
  const input = record(value, ["path", "outDirectory", "scale"])
  const scale = input.scale
  if (
    scale !== undefined &&
    (typeof scale !== "number" ||
      !Number.isFinite(scale) ||
      scale <= 0 ||
      scale > 4)
  ) {
    operationFailure("scale must be greater than zero and no more than 4.")
  }
  return {
    path: pathValue(input.path, "path"),
    ...(input.outDirectory === undefined
      ? {}
      : { outDirectory: pathValue(input.outDirectory, "outDirectory") }),
    ...(scale === undefined ? {} : { scale }),
  }
}

function parseVectorize(value: unknown): VectorizeGraphicsOperationInput {
  const input = record(value, [
    "inputPath",
    "outputPath",
    "duotone",
    "alphaCutoff",
    "timeoutMs",
  ])
  const inputPath = pathValue(input.inputPath, "inputPath")
  const outputPath = pathValue(input.outputPath, "outputPath")
  if (!outputPath.toLowerCase().endsWith(".svg")) {
    operationFailure("outputPath must end in .svg.")
  }
  const duotone = input.duotone
  if (
    duotone !== undefined &&
    (!Array.isArray(duotone) ||
      duotone.length !== 2 ||
      duotone.some(
        (color) =>
          typeof color !== "string" ||
          !/^#[a-f0-9]{3}(?:[a-f0-9]{3})?$/iu.test(color),
      ))
  ) {
    operationFailure("duotone must contain exactly two #rgb or #rrggbb colors.")
  }
  const alphaCutoff = input.alphaCutoff
  if (
    alphaCutoff !== undefined &&
    (!Number.isInteger(alphaCutoff) ||
      (alphaCutoff as number) < 1 ||
      (alphaCutoff as number) > 64)
  ) {
    operationFailure("alphaCutoff must be an integer from 1 through 64.")
  }
  const timeoutMs = input.timeoutMs
  if (
    timeoutMs !== undefined &&
    (!Number.isInteger(timeoutMs) ||
      (timeoutMs as number) < 1 ||
      (timeoutMs as number) > 300_000)
  ) {
    operationFailure("timeoutMs must be an integer from 1 through 300000.")
  }
  return {
    inputPath,
    outputPath,
    ...(duotone === undefined
      ? {}
      : { duotone: duotone as unknown as readonly [string, string] }),
    ...(alphaCutoff === undefined ? {} : { alphaCutoff: alphaCutoff as number }),
    ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
  }
}

function parseGenerate(value: unknown): GenerateGraphicsOperationInput {
  const input = record(value, [
    "model",
    "prompt",
    "outputPath",
    "idempotencyKey",
  ])
  if (
    typeof input.model !== "string" ||
    !graphicsImageModels.includes(input.model as GraphicsImageModel)
  ) {
    operationFailure(
      `model must be ${graphicsImageModels[0]} or ${graphicsImageModels[1]}.`,
    )
  }
  if (
    typeof input.prompt !== "string" ||
    input.prompt.trim().length < 1 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.prompt) ||
    Buffer.byteLength(input.prompt, "utf8") > graphicsMaximumPromptBytes
  ) {
    operationFailure(
      `prompt must be non-empty and no more than ${graphicsMaximumPromptBytes} UTF-8 bytes.`,
    )
  }
  if (input.idempotencyKey !== undefined) {
    try {
      validateGraphicsIdempotencyKey(
        typeof input.idempotencyKey === "string"
          ? input.idempotencyKey
          : "",
      )
    } catch {
      operationFailure("idempotencyKey is invalid.")
    }
  }
  const outputPath = pathValue(input.outputPath, "outputPath")
  if (!outputPath.toLowerCase().endsWith(".webp")) {
    operationFailure("outputPath must end in .webp.")
  }
  return {
    model: input.model as GraphicsImageModel,
    prompt: input.prompt,
    outputPath,
    ...(input.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: input.idempotencyKey as string }),
  }
}

export function parseGraphicsOperationInput<C extends GraphicsOperationCode>(
  code: C,
  input: unknown,
): GraphicsOperationInputMap[C] {
  switch (code) {
    case "graphics.diagram.check":
      return parseCheck(input) as GraphicsOperationInputMap[C]
    case "graphics.diagram.render":
      return parseRender(input) as GraphicsOperationInputMap[C]
    case "graphics.image.vectorize":
      return parseVectorize(input) as GraphicsOperationInputMap[C]
    case "graphics.image.generate":
      return parseGenerate(input) as GraphicsOperationInputMap[C]
    default:
      throw new GraphicsOperationError(
        "INVALID_OPERATION",
        "Unknown Graphics operation code.",
      )
  }
}

export function isGraphicsOperationCode(
  value: string,
): value is GraphicsOperationCode {
  return graphicsOperationCodes.includes(value as GraphicsOperationCode)
}

export function searchGraphicsOperations(
  query = "",
  limit = graphicsOperationRegistry.length,
): readonly GraphicsOperationDescriptor[] {
  if (
    typeof query !== "string" ||
    query.length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(query) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 20
  ) {
    throw new GraphicsOperationError(
      "INVALID_SEARCH",
      "Search requires a bounded query and a limit from 1 through 20.",
    )
  }
  const terms = query
    .toLowerCase()
    .split(/\s+/u)
    .filter((term) => term.length > 0)
  return graphicsOperationRegistry
    .filter((operation) => {
      const haystack =
        `${operation.code} ${operation.title} ${operation.description}`.toLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
    .slice(0, limit)
}

export type GraphicsOperationDependencies = GraphicsAuthDependencies

const operationBuiltInConfig: DiagramConfig = Object.freeze({
  icons: builtInIcons,
})

async function readOperationDiagram(path: string) {
  const absolutePath = resolve(path)
  let value: unknown
  try {
    value = JSON.parse(await readFile(absolutePath, "utf8"))
  } catch (cause) {
    throw new GraphicsOperationError(
      "INVALID_OPERATION_INPUT",
      "Diagram source could not be read as JSON.",
    )
  }
  const spec = parseDiagramSpec(value)
  for (const shape of spec.shapes) {
    if (
      (shape.type === "rect" || shape.type === "ellipse") &&
      shape.icon !== undefined &&
      !Object.hasOwn(builtInIcons, shape.icon)
    ) {
      throw new GraphicsOperationError(
        "INVALID_OPERATION_INPUT",
        "Diagram requests an unavailable built-in icon.",
      )
    }
  }
  return { absolutePath, spec }
}

async function atomicOperationWrite(
  path: string,
  value: string | Uint8Array,
): Promise<void> {
  const temporaryPath = join(
    dirname(path),
    `.${randomUUID()}.graphics-operation.tmp`,
  )
  try {
    await writeFile(temporaryPath, value, { flag: "wx" })
    await rename(temporaryPath, path)
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
  }
}

async function checkOperationDiagram(path: string) {
  const { spec } = await readOperationDiagram(path)
  return {
    findings: lintDiagram(spec),
    configPath: null,
  } as const
}

async function renderOperationDiagram(
  input: RenderGraphicsOperationInput,
) {
  const { absolutePath, spec } = await readOperationDiagram(input.path)
  const outputDirectory = resolve(input.outDirectory ?? dirname(absolutePath))
  const scale = input.scale ?? 2
  const [light, dark] = await Promise.all([
    renderSvg(spec, "light", operationBuiltInConfig),
    renderSvg(spec, "dark", operationBuiltInConfig),
  ])
  const [lightPng, darkPng] = [
    renderPng(light, operationBuiltInConfig, scale),
    renderPng(dark, operationBuiltInConfig, scale),
  ]
  const artifacts = {
    spec: absolutePath,
    tldr: join(outputDirectory, `${spec.name}.tldr`),
    lightSvg: join(outputDirectory, `${spec.name}.light.svg`),
    darkSvg: join(outputDirectory, `${spec.name}.dark.svg`),
    lightPng: join(outputDirectory, `${spec.name}.light.png`),
    darkPng: join(outputDirectory, `${spec.name}.dark.png`),
  } satisfies RenderArtifacts
  await mkdir(outputDirectory, { recursive: true })
  await Promise.all([
    atomicOperationWrite(
      artifacts.tldr,
      serializeTldr(spec, operationBuiltInConfig),
    ),
    atomicOperationWrite(artifacts.lightSvg, light.svg),
    atomicOperationWrite(artifacts.darkSvg, dark.svg),
    atomicOperationWrite(artifacts.lightPng, lightPng),
    atomicOperationWrite(artifacts.darkPng, darkPng),
  ])
  return {
    artifacts,
    findings: lintDiagram(spec),
    configPath: null,
  } as const
}

export async function executeGraphicsOperation<C extends GraphicsOperationCode>(
  code: C,
  value: unknown,
  dependencies: GraphicsOperationDependencies = {},
): Promise<GraphicsOperationResultMap[C]> {
  const input = parseGraphicsOperationInput(code, value)
  switch (code) {
    case "graphics.diagram.check": {
      const options = input as CheckGraphicsOperationInput
      return (await checkOperationDiagram(options.path)) as GraphicsOperationResultMap[C]
    }
    case "graphics.diagram.render": {
      const options = input as RenderGraphicsOperationInput
      return (await renderOperationDiagram(options)) as GraphicsOperationResultMap[C]
    }
    case "graphics.image.vectorize": {
      const options = input as VectorizeGraphicsOperationInput
      // Authentication is a local feature gate only. Neither the raster path
      // nor its bytes are included in discovery or token requests.
      await requireGraphicsAuthentication(dependencies)
      const result = await vectorizeImage(options.inputPath, {
        outputPath: options.outputPath,
        ...(options.duotone === undefined ? {} : { duotone: options.duotone }),
        ...(options.alphaCutoff === undefined
          ? {}
          : { alphaCutoff: options.alphaCutoff }),
        ...(options.timeoutMs === undefined
          ? {}
          : { limits: { maxDurationMs: options.timeoutMs } }),
      })
      if (result.outputPath === null) {
        throw new GraphicsOperationError(
          "INVALID_OPERATION_INPUT",
          "Vectorization did not publish its required output.",
        )
      }
      return {
        outputPath: result.outputPath,
        receipt: result.receipt,
      } as GraphicsOperationResultMap[C]
    }
    case "graphics.image.generate": {
      const options = input as GenerateGraphicsOperationInput
      return (await generateGraphicsImageFile(options, dependencies)) as GraphicsOperationResultMap[C]
    }
    default:
      throw new GraphicsOperationError(
        "INVALID_OPERATION",
        "Unknown Graphics operation code.",
      )
  }
}
