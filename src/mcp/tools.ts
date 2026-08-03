import { rename, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  requireTransmuteAuthentication,
  type TransmuteAuthDependencies,
} from "../auth.js"
import { TransmuteCloudError } from "../cloud-errors.js"
import { generateTransmuteImageFile } from "../generate.js"
import { builtInIcons } from "../icons.js"
import { lintDiagram } from "../lint.js"
import {
  TransmuteOperationError,
  transmuteOperationCodes,
  parseTransmuteOperationInput,
  searchTransmuteOperations,
  withTransmuteOperationHostAdmission,
  type CheckTransmuteOperationInput,
  type GenerateTransmuteOperationInput,
  type TransmuteOperationCode,
  type RenderTransmuteOperationInput,
  type VectorizeTransmuteOperationInput,
} from "../operations.js"
import {
  createDefaultHostResourceCoordinator,
  type HostResourceCoordinator,
  type HostResourceLease,
} from "../host-resources.js"
import { DiagramValidationError, parseDiagramSpec } from "../parse.js"
import { renderPng, renderSvg } from "../render.js"
import { serializeTldr } from "../tldr.js"
import type {
  DiagramConfig,
  DiagramSpec,
  LintFinding,
  RenderArtifacts,
} from "../types.js"
import {
  vectorizeHardLimits,
  vectorizeImage,
  VectorizeError,
} from "../vectorize/index.js"
import {
  WorkspaceBoundary,
  WorkspaceBoundaryError,
  type WorkspaceSource,
} from "./boundary.js"
import type {
  McpToolDefinition,
  McpToolResult,
} from "./types.js"

export const mcpMaximumScale = 4
export const mcpMaximumRenderedPixels = 16_777_216
export const mcpMaximumShapes = 64
export const mcpMaximumEdges = 128
export const mcpMaximumReturnedFindings = 40

const defaultScale = 2
const maximumShapeIdsPerFinding = 12
const builtInConfig: DiagramConfig = Object.freeze({ icons: builtInIcons })

const findingSchema = {
  type: "object",
  additionalProperties: false,
  required: ["code", "message", "shapeIds"],
  properties: {
    code: { type: "string" },
    message: { type: "string" },
    shapeIds: { type: "array", items: { type: "string" } },
  },
} as const

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value
  }
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

export const transmuteMcpTools: readonly McpToolDefinition[] = deepFreeze([
  {
    name: "check_diagram",
    title: "Check diagram",
    description:
      "Parse and lint one root-relative Transmute diagram source without changing files. Uses only built-in icons and themes.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description: "Root-relative path to a diagram JSON source (1 MiB maximum).",
        },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "source", "findings", "summary"],
      properties: {
        ok: { const: true },
        source: { type: "string" },
        findings: { type: "array", items: findingSchema },
        summary: {
          type: "object",
          additionalProperties: false,
          required: [
            "shapeCount",
            "edgeCount",
            "findingCount",
            "returnedFindingCount",
            "findingsTruncated",
          ],
          properties: {
            shapeCount: { type: "integer", minimum: 0 },
            edgeCount: { type: "integer", minimum: 0 },
            findingCount: { type: "integer", minimum: 0 },
            returnedFindingCount: { type: "integer", minimum: 0 },
            findingsTruncated: { type: "boolean" },
          },
        },
      },
    },
    annotations: {
      title: "Check diagram",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "render_diagram",
    title: "Render diagram",
    description:
      "Render one root-relative Transmute diagram source with built-in icons and themes, overwriting its paired .tldr, light/dark SVG, and light/dark PNG artifacts.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description: "Root-relative path to a diagram JSON source (1 MiB maximum).",
        },
        out_dir: {
          type: "string",
          description:
            "Optional root-relative output directory. Defaults to the source directory.",
        },
        scale: {
          type: "number",
          exclusiveMinimum: 0,
          maximum: mcpMaximumScale,
          default: defaultScale,
          description: "PNG scale. The scaled canvas may contain at most 16,777,216 pixels.",
        },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "source", "scale", "findings", "artifacts", "summary"],
      properties: {
        ok: { const: true },
        source: { type: "string" },
        scale: { type: "number" },
        findings: { type: "array", items: findingSchema },
        artifacts: {
          type: "object",
          additionalProperties: false,
          required: ["tldr", "lightSvg", "darkSvg", "lightPng", "darkPng"],
          properties: {
            tldr: { type: "string" },
            lightSvg: { type: "string" },
            darkSvg: { type: "string" },
            lightPng: { type: "string" },
            darkPng: { type: "string" },
          },
        },
        summary: {
          type: "object",
          additionalProperties: false,
          required: [
            "shapeCount",
            "edgeCount",
            "findingCount",
            "returnedFindingCount",
            "findingsTruncated",
          ],
          properties: {
            shapeCount: { type: "integer", minimum: 0 },
            edgeCount: { type: "integer", minimum: 0 },
            findingCount: { type: "integer", minimum: 0 },
            returnedFindingCount: { type: "integer", minimum: 0 },
            findingsTruncated: { type: "boolean" },
          },
        },
      },
    },
    annotations: {
      title: "Render diagram",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "search_transmute",
    title: "Search Transmute operations",
    description:
      "Search the fixed semantic Transmute operation registry by bounded text. This never executes code or changes files.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          maxLength: 200,
          description: "Optional terms matched against operation codes and descriptions.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          default: 4,
        },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "operations"],
      properties: {
        ok: { const: true },
        operations: {
          type: "array",
          maxItems: 20,
          items: {
            type: "object",
            required: [
              "code",
              "title",
              "description",
              "execution",
              "authentication",
              "inputSchema",
            ],
          },
        },
      },
    },
    annotations: {
      title: "Search Transmute operations",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "execute_transmute",
    title: "Execute Transmute operation",
    description:
      "Execute one exact operation code with typed JSON input. Never accepts or evaluates source code. Local paths remain confined to the configured workspace root.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["operation", "input"],
      properties: {
        operation: {
          type: "string",
          enum: transmuteOperationCodes,
        },
        input: {
          type: "object",
          description:
            "Typed input matching the selected operation's registry schema.",
        },
      },
    },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["ok", "operation", "result"],
      properties: {
        ok: { const: true },
        operation: { type: "string", enum: transmuteOperationCodes },
        result: { type: "object" },
      },
    },
    annotations: {
      title: "Execute Transmute operation",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
])

class ToolFailure extends Error {
  readonly code: string
  readonly issues?: readonly string[]

  constructor(code: string, message: string, issues?: readonly string[]) {
    super(message)
    this.name = "ToolFailure"
    this.code = code
    if (issues !== undefined) this.issues = issues
  }
}

interface ParsedCheckArguments {
  readonly path: string
}

interface ParsedRenderArguments extends ParsedCheckArguments {
  readonly outDirectory?: string
  readonly scale: number
}

interface ParsedSearchArguments {
  readonly query: string
  readonly limit: number
}

interface ParsedExecuteArguments {
  readonly operation: TransmuteOperationCode
  readonly input: unknown
}

interface LoadedDiagram {
  readonly source: WorkspaceSource
  readonly spec: DiagramSpec
}

interface PublicArtifactPaths {
  readonly tldr: string
  readonly lightSvg: string
  readonly darkSvg: string
  readonly lightPng: string
  readonly darkPng: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function safeFragment(value: string, maximumLength = 160): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximumLength)
}

function safeIssues(issues: readonly string[]): readonly string[] {
  return issues.slice(0, 24).map((issue) => safeFragment(issue, 240))
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) {
    throw new ToolFailure(
      "INVALID_ARGUMENTS",
      `Unsupported argument: ${safeFragment(unknown[0] ?? "unknown")}.`,
    )
  }
}

function parsePath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolFailure(
      "INVALID_ARGUMENTS",
      "path must be a non-empty root-relative string.",
    )
  }
  if (!value.toLowerCase().endsWith(".diagram.json")) {
    throw new ToolFailure(
      "INVALID_ARGUMENTS",
      "path must end in .diagram.json.",
    )
  }
  return value
}

function parseCheckArguments(value: unknown): ParsedCheckArguments {
  if (!isRecord(value)) {
    throw new ToolFailure("INVALID_ARGUMENTS", "Tool arguments must be an object.")
  }
  rejectUnknownKeys(value, new Set(["path"]))
  return { path: parsePath(value.path) }
}

function parseRenderArguments(value: unknown): ParsedRenderArguments {
  if (!isRecord(value)) {
    throw new ToolFailure("INVALID_ARGUMENTS", "Tool arguments must be an object.")
  }
  rejectUnknownKeys(value, new Set(["path", "out_dir", "scale"]))
  const outDirectory = value.out_dir
  if (
    outDirectory !== undefined &&
    (typeof outDirectory !== "string" || outDirectory.length === 0)
  ) {
    throw new ToolFailure(
      "INVALID_ARGUMENTS",
      "out_dir must be a non-empty root-relative string when present.",
    )
  }
  const scale = value.scale ?? defaultScale
  if (
    typeof scale !== "number" ||
    !Number.isFinite(scale) ||
    scale <= 0 ||
    scale > mcpMaximumScale
  ) {
    throw new ToolFailure(
      "RENDER_LIMIT",
      `scale must be greater than zero and no more than ${mcpMaximumScale}.`,
    )
  }
  return {
    path: parsePath(value.path),
    ...(outDirectory === undefined ? {} : { outDirectory }),
    scale,
  }
}

function parseSearchArguments(value: unknown): ParsedSearchArguments {
  if (!isRecord(value)) {
    throw new ToolFailure("INVALID_ARGUMENTS", "Tool arguments must be an object.")
  }
  rejectUnknownKeys(value, new Set(["query", "limit"]))
  const query = value.query ?? ""
  const limit = value.limit ?? transmuteOperationCodes.length
  if (
    typeof query !== "string" ||
    query.length > 200 ||
    /[\u0000-\u001f\u007f]/u.test(query) ||
    !Number.isInteger(limit) ||
    (limit as number) < 1 ||
    (limit as number) > 20
  ) {
    throw new ToolFailure(
      "INVALID_ARGUMENTS",
      "query must be a bounded string and limit must be an integer from 1 through 20.",
    )
  }
  return { query, limit: limit as number }
}

function parseExecuteArguments(value: unknown): ParsedExecuteArguments {
  if (!isRecord(value)) {
    throw new ToolFailure("INVALID_ARGUMENTS", "Tool arguments must be an object.")
  }
  rejectUnknownKeys(value, new Set(["operation", "input"]))
  if (
    typeof value.operation !== "string" ||
    !transmuteOperationCodes.includes(value.operation as TransmuteOperationCode) ||
    !isRecord(value.input)
  ) {
    throw new ToolFailure(
      "INVALID_ARGUMENTS",
      "operation must be an exact Transmute operation code and input must be an object.",
    )
  }
  return {
    operation: value.operation as TransmuteOperationCode,
    input: value.input,
  }
}

function assertBuiltInIcons(spec: DiagramSpec): void {
  for (const shape of spec.shapes) {
    if (
      (shape.type === "rect" || shape.type === "ellipse") &&
      shape.icon !== undefined &&
      !Object.hasOwn(builtInIcons, shape.icon)
    ) {
      throw new ToolFailure(
        "UNKNOWN_ICON",
        `Shape ${safeFragment(shape.id)} requests unavailable built-in icon ${safeFragment(shape.icon)}.`,
      )
    }
  }
}

function assertComplexityLimits(spec: DiagramSpec): void {
  const edgeCount = spec.edges?.length ?? 0
  if (spec.shapes.length > mcpMaximumShapes || edgeCount > mcpMaximumEdges) {
    throw new ToolFailure(
      "COMPLEXITY_LIMIT",
      `Diagram may contain at most ${mcpMaximumShapes} shapes and ${mcpMaximumEdges} edges in MCP mode.`,
    )
  }
}

function assertRawComplexityLimits(value: unknown): void {
  if (!isRecord(value)) return
  const shapeCount = Array.isArray(value.shapes) ? value.shapes.length : 0
  const edgeCount = Array.isArray(value.edges) ? value.edges.length : 0
  if (shapeCount > mcpMaximumShapes || edgeCount > mcpMaximumEdges) {
    throw new ToolFailure(
      "COMPLEXITY_LIMIT",
      `Diagram may contain at most ${mcpMaximumShapes} shapes and ${mcpMaximumEdges} edges in MCP mode.`,
    )
  }
}

function assertRenderLimits(spec: DiagramSpec, scale: number): void {
  const scaledWidth = spec.canvas.width * scale
  const scaledHeight = spec.canvas.height * scale
  const pixels = Math.ceil(scaledWidth) * Math.ceil(scaledHeight)
  if (
    !Number.isFinite(pixels) ||
    scaledWidth < 1 ||
    scaledHeight < 1 ||
    pixels > mcpMaximumRenderedPixels
  ) {
    throw new ToolFailure(
      "RENDER_LIMIT",
      `Scaled canvas must be at least 1 pixel on each axis and no more than ${mcpMaximumRenderedPixels.toLocaleString("en-US")} pixels total.`,
    )
  }
}

function publicFinding(finding: LintFinding): LintFinding {
  return {
    code: safeFragment(finding.code, 64),
    message: safeFragment(finding.message, 240),
    shapeIds: finding.shapeIds
      .slice(0, maximumShapeIdsPerFinding)
      .map((shapeId) => safeFragment(shapeId, 120)),
  }
}

function publicFindings(
  findings: readonly LintFinding[],
): readonly LintFinding[] {
  return findings
    .slice(0, mcpMaximumReturnedFindings)
    .map(publicFinding)
}

function diagramSummary(
  spec: DiagramSpec,
  findingCount: number,
  returnedFindingCount: number,
): Readonly<Record<string, number | boolean>> {
  return {
    shapeCount: spec.shapes.length,
    edgeCount: spec.edges?.length ?? 0,
    findingCount,
    returnedFindingCount,
    findingsTruncated: returnedFindingCount < findingCount,
  }
}

function successResult(
  text: string,
  structuredContent: Readonly<Record<string, unknown>>,
): McpToolResult {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  }
}

function failureResult(error: unknown): McpToolResult {
  let code = "INTERNAL_ERROR"
  let message = "The tool failed safely."
  let issues: readonly string[] | undefined

  if (error instanceof ToolFailure) {
    code = error.code
    message = safeFragment(error.message, 320)
    issues = error.issues
  } else if (error instanceof WorkspaceBoundaryError) {
    code = error.code
    message = safeFragment(error.message, 320)
  } else if (error instanceof TransmuteCloudError) {
    code = error.code
    message = safeFragment(
      error.message.replace(/^\[[A-Z_]+\]\s*/u, ""),
      320,
    )
  } else if (error instanceof TransmuteOperationError) {
    code = error.code
    message = safeFragment(
      error.message.replace(/^\[[A-Z_]+\]\s*/u, ""),
      320,
    )
  } else if (error instanceof VectorizeError) {
    code = `VECTORIZE_${error.code.toUpperCase()}`
    message = "Local vectorization failed safely."
  } else if (error instanceof DiagramValidationError) {
    code = "INVALID_DIAGRAM"
    message = "Diagram source did not pass validation."
    issues = safeIssues(error.issues)
  } else if (
    typeof error === "object" &&
    error !== null &&
    "issues" in error &&
    Array.isArray(error.issues) &&
    error.issues.every((issue) => typeof issue === "string")
  ) {
    code = "INVALID_LAYOUT"
    message = "Diagram layout could not be resolved."
    issues = safeIssues(error.issues)
  }

  const issueText =
    issues === undefined || issues.length === 0
      ? ""
      : `\n${issues.map((issue) => `- ${issue}`).join("\n")}`
  return {
    content: [{ type: "text", text: `[${code}] ${message}${issueText}` }],
    isError: true,
  }
}

function portableDirectory(filePath: string): string {
  const separator = filePath.lastIndexOf("/")
  return separator === -1 ? "." : filePath.slice(0, separator)
}

async function atomicOverwrite(
  filePath: string,
  data: string | Uint8Array,
): Promise<void> {
  const temporaryPath = join(
    dirname(filePath),
    `.${crypto.randomUUID()}.transmute-mcp.tmp`,
  )
  try {
    await writeFile(temporaryPath, data, { flag: "wx" })
    try {
      await rename(temporaryPath, filePath)
    } catch (error) {
      const code =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : undefined
      if (code !== "EEXIST" && code !== "EPERM") throw error
      // Windows does not consistently replace an existing destination with
      // rename. The render queue prevents another MCP render from racing this
      // narrow replacement fallback.
      await rm(filePath, { force: true })
      await rename(temporaryPath, filePath)
    }
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

async function loadDiagram(
  boundary: WorkspaceBoundary,
  path: string,
): Promise<LoadedDiagram> {
  const source = await boundary.readSource(path)
  let parsed: unknown
  try {
    parsed = JSON.parse(source.text)
  } catch {
    throw new ToolFailure("INVALID_JSON", "Diagram source is not valid JSON.")
  }
  assertRawComplexityLimits(parsed)
  const spec = parseDiagramSpec(parsed)
  assertComplexityLimits(spec)
  assertBuiltInIcons(spec)
  return { source, spec }
}

export class TransmuteMcpToolRuntime {
  readonly boundary: WorkspaceBoundary
  readonly authDependencies: TransmuteAuthDependencies
  readonly hostResourceCoordinator: HostResourceCoordinator
  private renderQueue: Promise<void> = Promise.resolve()

  private constructor(
    boundary: WorkspaceBoundary,
    authDependencies: TransmuteAuthDependencies,
    hostResourceCoordinator: HostResourceCoordinator,
  ) {
    this.boundary = boundary
    this.authDependencies = authDependencies
    this.hostResourceCoordinator = hostResourceCoordinator
  }

  static async create(
    rootDirectory: string,
    authDependencies: TransmuteAuthDependencies = {},
    hostResourceCoordinator?: HostResourceCoordinator,
  ): Promise<TransmuteMcpToolRuntime> {
    return new TransmuteMcpToolRuntime(
      await WorkspaceBoundary.create(rootDirectory),
      authDependencies,
      hostResourceCoordinator ?? createDefaultHostResourceCoordinator(),
    )
  }

  private async withHostAdmission<T>(
    operation: TransmuteOperationCode,
    callback: (lease: HostResourceLease) => T | Promise<T>,
  ): Promise<T> {
    return await withTransmuteOperationHostAdmission(operation, callback, {
      hostResourceCoordinator: this.hostResourceCoordinator,
    })
  }

  private enqueueRender<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.renderQueue.then(operation, operation)
    this.renderQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  async call(name: string, argumentsValue: unknown): Promise<McpToolResult> {
    try {
      if (name === "check_diagram") {
        const options = parseCheckArguments(argumentsValue)
        return await this.withHostAdmission(
          "transmute.diagram.check",
          async () => await this.check(options),
        )
      }
      if (name === "render_diagram") {
        const options = parseRenderArguments(argumentsValue)
        return await this.enqueueRender(async () => (
          await this.withHostAdmission(
            "transmute.diagram.render",
            async () => await this.render(options),
          )
        ))
      }
      if (name === "search_transmute") {
        const options = parseSearchArguments(argumentsValue)
        const operations = searchTransmuteOperations(
          options.query,
          options.limit,
        )
        return successResult(
          `Found ${operations.length} Transmute operation${operations.length === 1 ? "" : "s"}.`,
          { ok: true, operations },
        )
      }
      if (name === "execute_transmute") {
        const options = parseExecuteArguments(argumentsValue)
        return await this.execute(options)
      }
      throw new ToolFailure("UNKNOWN_TOOL", "Requested tool is not available.")
    } catch (error) {
      return failureResult(error)
    }
  }

  private wrapSemanticResult(
    operation: TransmuteOperationCode,
    result: McpToolResult,
  ): McpToolResult {
    if (result.isError === true) return result
    return {
      content: result.content,
      structuredContent: {
        ok: true,
        operation,
        result: result.structuredContent ?? {},
      },
    }
  }

  private async execute(
    options: ParsedExecuteArguments,
  ): Promise<McpToolResult> {
    if (options.operation === "transmute.diagram.check") {
      const input = parseTransmuteOperationInput(
        options.operation,
        options.input,
      ) as CheckTransmuteOperationInput
      return this.wrapSemanticResult(
        options.operation,
        await this.withHostAdmission(
          options.operation,
          async () => await this.check({ path: input.path }),
        ),
      )
    }
    if (options.operation === "transmute.diagram.render") {
      const input = parseTransmuteOperationInput(
        options.operation,
        options.input,
      ) as RenderTransmuteOperationInput
      return this.enqueueRender(async () => await this.withHostAdmission(
        options.operation,
        async () => this.wrapSemanticResult(
          options.operation,
          await this.render({
            path: input.path,
            ...(input.outDirectory === undefined
              ? {}
              : { outDirectory: input.outDirectory }),
            scale: input.scale ?? defaultScale,
          }),
        ),
      ))
    }
    if (options.operation === "transmute.image.vectorize") {
      const input = parseTransmuteOperationInput(
        options.operation,
        options.input,
      ) as VectorizeTransmuteOperationInput
      return this.enqueueRender(async () => await this.withHostAdmission(
        options.operation,
        async (lease) => {
          const source = await this.boundary.resolveInputFile(
            input.inputPath,
            vectorizeHardLimits.maxInputBytes,
          )
          const output = await this.boundary.prepareOutputFile(input.outputPath)
          const result = await vectorizeImage(source.absolutePath, {
            outputPath: output.absolutePath,
            ...(input.duotone === undefined ? {} : { duotone: input.duotone }),
            ...(input.alphaCutoff === undefined
              ? {}
              : { alphaCutoff: input.alphaCutoff }),
            ...(input.timeoutMs === undefined
              ? {}
              : { limits: { maxDurationMs: input.timeoutMs } }),
            inheritedFileDescriptors: [lease.inheritedFileDescriptor],
          })
          return successResult(
            `Executed ${options.operation}: ${output.relativePath}`,
            {
              ok: true,
              operation: options.operation,
              result: {
                inputPath: source.relativePath,
                outputPath: output.relativePath,
                receipt: result.receipt,
              },
            },
          )
        },
      ))
    }
    return await this.withHostAdmission(options.operation, async () => {
      const input = parseTransmuteOperationInput(
        options.operation,
        options.input,
      ) as GenerateTransmuteOperationInput
      const discovery = await requireTransmuteAuthentication(
        this.authDependencies,
      )
      const output = await this.boundary.prepareOutputFile(input.outputPath)
      const generated = await generateTransmuteImageFile(
        { ...input, outputPath: output.absolutePath },
        { ...this.authDependencies, discovery },
      )
      return successResult(
        `Executed ${options.operation}: ${output.relativePath} (request ${safeFragment(generated.requestId, 256)}).`,
        {
          ok: true,
          operation: options.operation,
          result: {
            bytes: generated.bytes,
            idempotencyKey: generated.idempotencyKey,
            mediaType: generated.mediaType,
            model: generated.model,
            outputPath: output.relativePath,
            requestId: generated.requestId,
          },
        },
      )
    })
  }

  private async check(options: ParsedCheckArguments): Promise<McpToolResult> {
    const { source, spec } = await loadDiagram(this.boundary, options.path)
    const allFindings = lintDiagram(spec)
    const findings = publicFindings(allFindings)
    const summary = diagramSummary(spec, allFindings.length, findings.length)
    const text =
      allFindings.length === 0
        ? `Checked ${source.relativePath}: no findings.`
        : `Checked ${source.relativePath}: ${allFindings.length} finding${allFindings.length === 1 ? "" : "s"}; ${findings.length} returned in structured content${findings.length < allFindings.length ? " (truncated)" : ""}.`
    return successResult(text, {
      ok: true,
      source: source.relativePath,
      findings,
      summary,
    })
  }

  private async render(options: ParsedRenderArguments): Promise<McpToolResult> {
    const { source, spec } = await loadDiagram(this.boundary, options.path)
    assertRenderLimits(spec, options.scale)
    const outputDirectory = await this.boundary.prepareOutputDirectory(
      options.outDirectory ?? portableDirectory(source.relativePath),
    )

    // Serialize before raster work so the existing generated-record budget is
    // enforced before a render can consume substantial CPU or write anything.
    const tldr = serializeTldr(spec, builtInConfig)
    const [light, dark] = await Promise.all([
      renderSvg(spec, "light", builtInConfig),
      renderSvg(spec, "dark", builtInConfig),
    ])
    const lightPng = renderPng(light, builtInConfig, options.scale)
    const darkPng = renderPng(dark, builtInConfig, options.scale)
    const absoluteArtifacts = {
      spec: source.absolutePath,
      tldr: join(outputDirectory.absolutePath, `${spec.name}.tldr`),
      lightSvg: join(outputDirectory.absolutePath, `${spec.name}.light.svg`),
      darkSvg: join(outputDirectory.absolutePath, `${spec.name}.dark.svg`),
      lightPng: join(outputDirectory.absolutePath, `${spec.name}.light.png`),
      darkPng: join(outputDirectory.absolutePath, `${spec.name}.dark.png`),
    } satisfies RenderArtifacts

    await Promise.all([
      atomicOverwrite(
        absoluteArtifacts.tldr,
        tldr,
      ),
      atomicOverwrite(absoluteArtifacts.lightSvg, light.svg),
      atomicOverwrite(absoluteArtifacts.darkSvg, dark.svg),
      atomicOverwrite(absoluteArtifacts.lightPng, lightPng),
      atomicOverwrite(absoluteArtifacts.darkPng, darkPng),
    ])

    const artifacts: PublicArtifactPaths = {
      tldr: this.boundary.toRelativePath(absoluteArtifacts.tldr),
      lightSvg: this.boundary.toRelativePath(absoluteArtifacts.lightSvg),
      darkSvg: this.boundary.toRelativePath(absoluteArtifacts.darkSvg),
      lightPng: this.boundary.toRelativePath(absoluteArtifacts.lightPng),
      darkPng: this.boundary.toRelativePath(absoluteArtifacts.darkPng),
    }
    const allFindings = lintDiagram(spec)
    const findings = publicFindings(allFindings)
    const summary = diagramSummary(spec, allFindings.length, findings.length)
    const text = [
      `Rendered ${source.relativePath} with built-in assets:`,
      ...Object.values(artifacts).map((artifact) => `- ${artifact}`),
    ].join("\n")
    return successResult(text, {
      ok: true,
      source: source.relativePath,
      scale: options.scale,
      findings,
      artifacts,
      summary,
    })
  }
}
