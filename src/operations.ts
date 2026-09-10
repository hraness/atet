import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { builtInIcons } from "./icons.js"
import { lintDiagram } from "./lint.js"
import { parseDiagramSpec } from "./parse.js"
import { renderPng, renderSvg } from "./render.js"
import { serializeTldr } from "./tldr.js"
import type { DiagramConfig, LintFinding, RenderArtifacts } from "./types.js"
import {
  generateSlopcameraImageFile,
  slopcameraMaximumPromptBytes,
  type GeneratedSlopcameraImageFile,
  type SlopcameraGenerateDependencies,
  type SlopcameraImageModel,
} from "./generate.js"
import {
  vectorizeImage,
  type VectorizeReceipt,
} from "./vectorize/index.js"
import {
  createDefaultHostResourceCoordinator,
  type HostResourceClaim,
  type HostResourceCoordinator,
  type HostResourceLease,
} from "./host-resources.js"

export const slopcameraOperationCodes = [
  "slopcamera.diagram.check",
  "slopcamera.diagram.render",
  "slopcamera.image.vectorize",
  "slopcamera.image.generate",
] as const

export type SlopcameraOperationCode = (typeof slopcameraOperationCodes)[number]

export interface SlopcameraOperationDescriptor {
  readonly code: SlopcameraOperationCode
  readonly title: string
  readonly description: string
  readonly execution: "gateway" | "local"
  readonly authentication: "environment" | "none"
  readonly destructive: boolean
  readonly idempotent: boolean
  readonly inputSchema: Readonly<Record<string, unknown>>
  /** Immutable operation-owned physical host admission claims. */
  readonly resources: readonly HostResourceClaim[]
  readonly transport?: {
    readonly method: "POST"
    readonly authority: "https://ai-gateway.vercel.sh/v4/ai"
    readonly authorization: "bearer"
    readonly retry: "never"
  }
}

export class SlopcameraOperationError extends Error {
  readonly code:
    | "INVALID_OPERATION"
    | "INVALID_OPERATION_INPUT"
    | "INVALID_SEARCH"

  constructor(
    code: SlopcameraOperationError["code"],
    message: string,
  ) {
    super(`[${code}] ${message}`)
    this.name = "SlopcameraOperationError"
    this.code = code
  }
}

const modelSchema = {
  type: "string",
  minLength: 3,
  maxLength: 256,
  pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*/[a-zA-Z0-9][a-zA-Z0-9._:-]*$",
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

export const slopcameraOperationRegistry: readonly SlopcameraOperationDescriptor[] =
  deepFreeze([
    {
      code: "slopcamera.diagram.check",
      title: "Check diagram",
      description:
        "Parse and lint a checked Slopcamera diagram source without changing its files.",
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
      resources: [
        { resource: "cpu", amount: 1 },
        { resource: "local-io", amount: 1 },
      ],
    },
    {
      code: "slopcamera.diagram.render",
      title: "Render diagram",
      description:
        "Render a checked Slopcamera diagram source to its replaceable light, dark, PNG, SVG, and tldraw artifacts.",
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
      resources: [
        { resource: "cpu", amount: 1 },
        { resource: "local-io", amount: 1 },
      ],
    },
    {
      code: "slopcamera.image.vectorize",
      title: "Vectorize image",
      description:
        "Convert a local caller-owned raster into a bounded inert SVG without authentication or network access.",
      execution: "local",
      authentication: "none",
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
      resources: [
        { resource: "cpu", amount: 1 },
        { resource: "local-io", amount: 1 },
      ],
    },
    {
      code: "slopcamera.image.generate",
      title: "Generate image",
      description:
        "Generate one bounded image directly through Vercel AI Gateway with an environment credential and no client retry.",
      execution: "gateway",
      authentication: "environment",
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
            maxLength: slopcameraMaximumPromptBytes,
          },
          outputPath: pathSchema,
        },
      },
      resources: [
        { resource: "local-io", amount: 1 },
        { resource: "network", amount: 1 },
        { resource: "paid-call", amount: 1 },
      ],
      transport: {
        method: "POST",
        authority: "https://ai-gateway.vercel.sh/v4/ai",
        authorization: "bearer",
        retry: "never",
      },
    },
  ] satisfies readonly SlopcameraOperationDescriptor[])

export interface CheckSlopcameraOperationInput {
  readonly path: string
}

export interface RenderSlopcameraOperationInput extends CheckSlopcameraOperationInput {
  readonly outDirectory?: string
  readonly scale?: number
}

export interface VectorizeSlopcameraOperationInput {
  readonly inputPath: string
  readonly outputPath: string
  readonly duotone?: readonly [string, string]
  readonly alphaCutoff?: number
  readonly timeoutMs?: number
}

export interface GenerateSlopcameraOperationInput {
  readonly model: SlopcameraImageModel
  readonly prompt: string
  readonly outputPath: string
}

export interface SlopcameraOperationInputMap {
  readonly "slopcamera.diagram.check": CheckSlopcameraOperationInput
  readonly "slopcamera.diagram.render": RenderSlopcameraOperationInput
  readonly "slopcamera.image.vectorize": VectorizeSlopcameraOperationInput
  readonly "slopcamera.image.generate": GenerateSlopcameraOperationInput
}

export interface SlopcameraOperationResultMap {
  readonly "slopcamera.diagram.check": {
    readonly findings: readonly LintFinding[]
    readonly configPath: null
  }
  readonly "slopcamera.diagram.render": {
    readonly artifacts: RenderArtifacts
    readonly findings: readonly LintFinding[]
    readonly configPath: null
  }
  readonly "slopcamera.image.vectorize": {
    readonly outputPath: string
    readonly receipt: VectorizeReceipt
  }
  readonly "slopcamera.image.generate": GeneratedSlopcameraImageFile
}

function operationFailure(message: string): never {
  throw new SlopcameraOperationError("INVALID_OPERATION_INPUT", message)
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

function parseCheck(value: unknown): CheckSlopcameraOperationInput {
  const input = record(value, ["path"])
  return { path: pathValue(input.path, "path") }
}

function parseRender(value: unknown): RenderSlopcameraOperationInput {
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

function parseVectorize(value: unknown): VectorizeSlopcameraOperationInput {
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

function parseGenerate(value: unknown): GenerateSlopcameraOperationInput {
  const input = record(value, ["model", "prompt", "outputPath"])
  if (
    typeof input.model !== "string" ||
    input.model.length > 256 ||
    !/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/iu.test(input.model)
  ) {
    operationFailure("model must be a bounded Vercel AI Gateway provider/model id.")
  }
  if (
    typeof input.prompt !== "string" ||
    input.prompt.trim().length < 1 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.prompt) ||
    Buffer.byteLength(input.prompt, "utf8") > slopcameraMaximumPromptBytes
  ) {
    operationFailure(
      `prompt must be non-empty and no more than ${slopcameraMaximumPromptBytes} UTF-8 bytes.`,
    )
  }
  const outputPath = pathValue(input.outputPath, "outputPath")
  if (!/\.(?:jpe?g|png|webp)$/iu.test(outputPath)) {
    operationFailure("outputPath must end in .png, .jpg, .jpeg, or .webp.")
  }
  return {
    model: input.model as SlopcameraImageModel,
    prompt: input.prompt,
    outputPath,
  }
}

export function parseSlopcameraOperationInput<C extends SlopcameraOperationCode>(
  code: C,
  input: unknown,
): SlopcameraOperationInputMap[C] {
  switch (code) {
    case "slopcamera.diagram.check":
      return parseCheck(input) as SlopcameraOperationInputMap[C]
    case "slopcamera.diagram.render":
      return parseRender(input) as SlopcameraOperationInputMap[C]
    case "slopcamera.image.vectorize":
      return parseVectorize(input) as SlopcameraOperationInputMap[C]
    case "slopcamera.image.generate":
      return parseGenerate(input) as SlopcameraOperationInputMap[C]
    default:
      throw new SlopcameraOperationError(
        "INVALID_OPERATION",
        "Unknown Slopcamera operation code.",
      )
  }
}

export function isSlopcameraOperationCode(
  value: string,
): value is SlopcameraOperationCode {
  return slopcameraOperationCodes.includes(value as SlopcameraOperationCode)
}

export function slopcameraOperationHostResourceClaims(
  code: SlopcameraOperationCode,
): readonly HostResourceClaim[] {
  const descriptor = slopcameraOperationRegistry.find(
    (candidate) => candidate.code === code,
  )
  if (descriptor === undefined) {
    throw new SlopcameraOperationError(
      "INVALID_OPERATION",
      "Unknown Slopcamera operation code.",
    )
  }
  return descriptor.resources
}

export function searchSlopcameraOperations(
  query = "",
  limit = slopcameraOperationRegistry.length,
): readonly SlopcameraOperationDescriptor[] {
  if (
    typeof query !== "string" ||
    query.length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(query) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 20
  ) {
    throw new SlopcameraOperationError(
      "INVALID_SEARCH",
      "Search requires a bounded query and a limit from 1 through 20.",
    )
  }
  const terms = query
    .toLowerCase()
    .split(/\s+/u)
    .filter((term) => term.length > 0)
  return slopcameraOperationRegistry
    .filter((operation) => {
      const haystack =
        `${operation.code} ${operation.title} ${operation.description}`.toLowerCase()
      return terms.every((term) => haystack.includes(term))
    })
    .slice(0, limit)
}

export interface SlopcameraOperationDependencies extends SlopcameraGenerateDependencies {
  /** Callback-scoped host authority inherited by operation subprocesses. */
  readonly inheritedFileDescriptors?: readonly number[]
  /** Optional coordinator override for deterministic hosts and tests. */
  readonly hostResourceCoordinator?: HostResourceCoordinator
  readonly signal?: AbortSignal
  readonly waitTimeoutMilliseconds?: number
}

export interface SlopcameraOperationHostAdmissionOptions {
  readonly hostResourceCoordinator?: HostResourceCoordinator
  readonly signal?: AbortSignal
  readonly waitTimeoutMilliseconds?: number
}

function operationDependenciesWithLease(
  dependencies: SlopcameraOperationDependencies,
  lease: HostResourceLease,
): SlopcameraOperationDependencies {
  const inheritedFileDescriptors = [
    ...(dependencies.inheritedFileDescriptors ?? []),
    lease.inheritedFileDescriptor,
  ].filter((descriptor, index, descriptors) => (
    descriptors.indexOf(descriptor) === index
  ))
  if (
    inheritedFileDescriptors.length > 16
    || inheritedFileDescriptors.some((descriptor) => (
      !Number.isSafeInteger(descriptor)
      || descriptor < 0
      || descriptor > 2_147_483_647
    ))
  ) {
    throw new SlopcameraOperationError(
      "INVALID_OPERATION_INPUT",
      "Operation host-resource inheritance exceeds its descriptor bound.",
    )
  }
  const {
    hostResourceCoordinator: _hostResourceCoordinator,
    signal: _signal,
    waitTimeoutMilliseconds: _waitTimeoutMilliseconds,
    ...operationDependencies
  } = dependencies
  return {
    ...operationDependencies,
    inheritedFileDescriptors,
  }
}

export async function withSlopcameraOperationHostAdmission<T>(
  code: SlopcameraOperationCode,
  callback: (lease: HostResourceLease) => T | Promise<T>,
  options: SlopcameraOperationHostAdmissionOptions = {},
): Promise<T> {
  const coordinator = options.hostResourceCoordinator
    ?? createDefaultHostResourceCoordinator()
  return await coordinator.withLease(
    slopcameraOperationHostResourceClaims(code),
    async (lease) => {
      await lease.assertOwned()
      return await callback(lease)
    },
    {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.waitTimeoutMilliseconds === undefined
        ? {}
        : { waitTimeoutMilliseconds: options.waitTimeoutMilliseconds }),
    },
  )
}

const operationBuiltInConfig: DiagramConfig = Object.freeze({
  icons: builtInIcons,
})

async function readOperationDiagram(path: string) {
  const absolutePath = resolve(path)
  let value: unknown
  try {
    value = JSON.parse(await readFile(absolutePath, "utf8"))
  } catch (cause) {
    throw new SlopcameraOperationError(
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
      throw new SlopcameraOperationError(
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
    `.${randomUUID()}.slopcamera-operation.tmp`,
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
  input: RenderSlopcameraOperationInput,
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

async function executeSlopcameraOperationUncoordinated<
  C extends SlopcameraOperationCode,
>(
  code: C,
  value: unknown,
  dependencies: SlopcameraOperationDependencies = {},
): Promise<SlopcameraOperationResultMap[C]> {
  const input = parseSlopcameraOperationInput(code, value)
  switch (code) {
    case "slopcamera.diagram.check": {
      const options = input as CheckSlopcameraOperationInput
      return (await checkOperationDiagram(options.path)) as SlopcameraOperationResultMap[C]
    }
    case "slopcamera.diagram.render": {
      const options = input as RenderSlopcameraOperationInput
      return (await renderOperationDiagram(options)) as SlopcameraOperationResultMap[C]
    }
    case "slopcamera.image.vectorize": {
      const options = input as VectorizeSlopcameraOperationInput
      const result = await vectorizeImage(options.inputPath, {
        outputPath: options.outputPath,
        ...(options.duotone === undefined ? {} : { duotone: options.duotone }),
        ...(options.alphaCutoff === undefined
          ? {}
          : { alphaCutoff: options.alphaCutoff }),
        ...(options.timeoutMs === undefined
          ? {}
          : { limits: { maxDurationMs: options.timeoutMs } }),
        ...(dependencies.inheritedFileDescriptors === undefined
          ? {}
          : {
              inheritedFileDescriptors:
                dependencies.inheritedFileDescriptors,
            }),
      })
      if (result.outputPath === null) {
        throw new SlopcameraOperationError(
          "INVALID_OPERATION_INPUT",
          "Vectorization did not publish its required output.",
        )
      }
      return {
        outputPath: result.outputPath,
        receipt: result.receipt,
      } as SlopcameraOperationResultMap[C]
    }
    case "slopcamera.image.generate": {
      const options = input as GenerateSlopcameraOperationInput
      return (await generateSlopcameraImageFile(
        {
          ...options,
          ...(dependencies.signal === undefined
            ? {}
            : { signal: dependencies.signal }),
        },
        dependencies,
      )) as SlopcameraOperationResultMap[C]
    }
    default:
      throw new SlopcameraOperationError(
        "INVALID_OPERATION",
        "Unknown Slopcamera operation code.",
      )
  }
}

/** Execute one operation under authority already held by a workflow node. */
export async function executeSlopcameraOperationWithLease<
  C extends SlopcameraOperationCode,
>(
  code: C,
  value: unknown,
  lease: HostResourceLease,
  dependencies: SlopcameraOperationDependencies = {},
): Promise<SlopcameraOperationResultMap[C]> {
  await lease.assertOwned()
  const available = new Map<string, number>()
  for (const claim of lease.claims) {
    if (
      typeof claim.resource !== "string"
      || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(claim.resource)
      || !Number.isSafeInteger(claim.amount)
      || claim.amount < 1
    ) {
      throw new SlopcameraOperationError(
        "INVALID_OPERATION",
        "The active host-resource lease contains invalid claims.",
      )
    }
    const total = (available.get(claim.resource) ?? 0) + claim.amount
    if (!Number.isSafeInteger(total)) {
      throw new SlopcameraOperationError(
        "INVALID_OPERATION",
        "The active host-resource lease contains invalid claims.",
      )
    }
    available.set(claim.resource, total)
  }
  const missing = slopcameraOperationHostResourceClaims(code).filter(
    claim => (available.get(claim.resource) ?? 0) < claim.amount,
  )
  if (missing.length > 0) {
    throw new SlopcameraOperationError(
      "INVALID_OPERATION",
      `The active host-resource lease does not cover ${missing
        .map(claim => `${claim.resource}:${String(claim.amount)}`)
        .join(", ")}.`,
    )
  }
  return await executeSlopcameraOperationUncoordinated(
    code,
    value,
    operationDependenciesWithLease(dependencies, lease),
  )
}

/** Execute one direct SDK operation under machine-wide resource admission. */
export async function executeSlopcameraOperation<C extends SlopcameraOperationCode>(
  code: C,
  value: unknown,
  dependencies: SlopcameraOperationDependencies = {},
): Promise<SlopcameraOperationResultMap[C]> {
  const input = parseSlopcameraOperationInput(code, value)
  return await withSlopcameraOperationHostAdmission(
    code,
    async (lease) => await executeSlopcameraOperationUncoordinated(
      code,
      input,
      operationDependenciesWithLease(dependencies, lease),
    ),
    dependencies,
  )
}
