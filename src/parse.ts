import {
  diagramVersion,
  type Anchor,
  type BoxShape,
  type DiagramEdge,
  type DiagramSource,
  type DiagramShape,
  type DiagramSpec,
  type LineShape,
  type StackAlign,
  type StackDiagramEdge,
  type StackDiagramSource,
  type StackDirection,
  type StackLayout,
  type StackShape,
  type TextShape,
  type Tone,
} from "./types.js"
import { resolveDiagramSource } from "./layout.js"

const tones = new Set<Tone>([
  "neutral",
  "blue",
  "orange",
  "green",
  "red",
  "purple",
  "yellow",
])
const anchors = new Set<Anchor>(["auto", "top", "right", "bottom", "left"])
const stackDirections = new Set<StackDirection>(["horizontal", "vertical"])
const stackAlignments = new Set<StackAlign>(["start", "center", "end"])
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]*$/
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export class DiagramValidationError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(`Invalid diagram specification:\n${issues.map((issue) => `- ${issue}`).join("\n")}`)
    this.name = "DiagramValidationError"
    this.issues = issues
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function readString(
  record: Record<string, unknown>,
  key: string,
  at: string,
  issues: string[],
): string | undefined {
  const value = record[key]
  if (typeof value !== "string") {
    issues.push(`${at}.${key} must be a string`)
    return undefined
  }
  return value
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  at: string,
  issues: string[],
): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== "string") {
    issues.push(`${at}.${key} must be a string when present`)
    return undefined
  }
  return value
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
  at: string,
  issues: string[],
  options: { readonly positive?: boolean; readonly nonNegative?: boolean } = {},
): number | undefined {
  const value = record[key]
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.push(`${at}.${key} must be a finite number`)
    return undefined
  }
  if (options.positive && value <= 0) {
    issues.push(`${at}.${key} must be greater than zero`)
    return undefined
  }
  if (options.nonNegative && value < 0) {
    issues.push(`${at}.${key} must be zero or greater`)
    return undefined
  }
  return value
}

function readOptionalNumber(
  record: Record<string, unknown>,
  key: string,
  at: string,
  issues: string[],
  options: { readonly positive?: boolean; readonly nonNegative?: boolean } = {},
): number | undefined {
  if (record[key] === undefined) return undefined
  return readNumber(record, key, at, issues, options)
}

function readOptionalTone(
  record: Record<string, unknown>,
  key: string,
  at: string,
  issues: string[],
): Tone | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== "string" || !tones.has(value as Tone)) {
    issues.push(`${at}.${key} must be one of ${[...tones].join(", ")}`)
    return undefined
  }
  return value as Tone
}

function validateKnownKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  at: string,
  issues: string[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) issues.push(`${at}.${key} is not supported`)
  }
}

function parseBase(
  record: Record<string, unknown>,
  at: string,
  issues: string[],
): {
  readonly id?: string
  readonly x?: number
  readonly y?: number
  readonly tone?: Tone
  readonly opacity?: number
} {
  const id = readString(record, "id", at, issues)
  if (id !== undefined && !idPattern.test(id)) {
    issues.push(`${at}.id must contain only letters, numbers, underscores, or hyphens`)
  }
  const opacity = readOptionalNumber(record, "opacity", at, issues, { nonNegative: true })
  if (opacity !== undefined && opacity > 1) issues.push(`${at}.opacity must not exceed 1`)
  const x = readNumber(record, "x", at, issues)
  const y = readNumber(record, "y", at, issues)
  const tone = readOptionalTone(record, "tone", at, issues)
  return {
    ...(id === undefined ? {} : { id }),
    ...(x === undefined ? {} : { x }),
    ...(y === undefined ? {} : { y }),
    ...(tone === undefined ? {} : { tone }),
    ...(opacity === undefined ? {} : { opacity }),
  }
}

function parseShape(value: unknown, index: number, issues: string[]): DiagramShape | null {
  const at = `shapes[${index}]`
  if (!isRecord(value)) {
    issues.push(`${at} must be an object`)
    return null
  }
  const type = readString(value, "type", at, issues)
  const base = parseBase(value, at, issues)
  if (base.id === undefined || base.x === undefined || base.y === undefined || type === undefined) {
    return null
  }
  const requiredBase = {
    id: base.id,
    x: base.x,
    y: base.y,
    ...(base.tone === undefined ? {} : { tone: base.tone }),
    ...(base.opacity === undefined ? {} : { opacity: base.opacity }),
  }

  if (type === "rect" || type === "ellipse") {
    validateKnownKeys(
      value,
      new Set([
        "id",
        "type",
        "x",
        "y",
        "tone",
        "opacity",
        "width",
        "height",
        "radius",
        "label",
        "icon",
        "iconSize",
        "strokeWidth",
        "fill",
      ]),
      at,
      issues,
    )
    const width = readNumber(value, "width", at, issues, { positive: true })
    const height = readNumber(value, "height", at, issues, { positive: true })
    const fill = value.fill
    if (fill !== undefined && typeof fill !== "boolean") issues.push(`${at}.fill must be a boolean`)
    if (width === undefined || height === undefined) return null
    return {
      ...requiredBase,
      type,
      width,
      height,
      ...(readOptionalNumber(value, "radius", at, issues, { nonNegative: true }) === undefined
        ? {}
        : { radius: value.radius as number }),
      ...(readOptionalString(value, "label", at, issues) === undefined
        ? {}
        : { label: value.label as string }),
      ...(readOptionalString(value, "icon", at, issues) === undefined
        ? {}
        : { icon: value.icon as string }),
      ...(readOptionalNumber(value, "iconSize", at, issues, { positive: true }) === undefined
        ? {}
        : { iconSize: value.iconSize as number }),
      ...(readOptionalNumber(value, "strokeWidth", at, issues, { nonNegative: true }) === undefined
        ? {}
        : { strokeWidth: value.strokeWidth as number }),
      ...(typeof fill === "boolean" ? { fill } : {}),
    } satisfies BoxShape
  }

  if (type === "text") {
    validateKnownKeys(
      value,
      new Set([
        "id",
        "type",
        "x",
        "y",
        "tone",
        "opacity",
        "text",
        "width",
        "fontSize",
        "weight",
        "align",
      ]),
      at,
      issues,
    )
    const text = readString(value, "text", at, issues)
    const weight = value.weight
    if (weight !== undefined && ![400, 500, 600, 700].includes(weight as number)) {
      issues.push(`${at}.weight must be 400, 500, 600, or 700`)
    }
    const align = value.align
    if (align !== undefined && !["start", "middle", "end"].includes(align as string)) {
      issues.push(`${at}.align must be start, middle, or end`)
    }
    if (text === undefined) return null
    return {
      ...requiredBase,
      type,
      text,
      ...(readOptionalNumber(value, "width", at, issues, { positive: true }) === undefined
        ? {}
        : { width: value.width as number }),
      ...(readOptionalNumber(value, "fontSize", at, issues, { positive: true }) === undefined
        ? {}
        : { fontSize: value.fontSize as number }),
      ...(weight === undefined ? {} : { weight: weight as 400 | 500 | 600 | 700 }),
      ...(align === undefined ? {} : { align: align as "start" | "middle" | "end" }),
    } satisfies TextShape
  }

  if (type === "line") {
    validateKnownKeys(
      value,
      new Set(["id", "type", "x", "y", "tone", "opacity", "x2", "y2", "strokeWidth"]),
      at,
      issues,
    )
    const x2 = readNumber(value, "x2", at, issues)
    const y2 = readNumber(value, "y2", at, issues)
    if (x2 === undefined || y2 === undefined) return null
    return {
      ...requiredBase,
      type,
      x2,
      y2,
      ...(readOptionalNumber(value, "strokeWidth", at, issues, { positive: true }) === undefined
        ? {}
        : { strokeWidth: value.strokeWidth as number }),
    } satisfies LineShape
  }

  issues.push(`${at}.type must be rect, ellipse, text, or line`)
  return null
}

function parseStackShape(value: unknown, index: number, issues: string[]): StackShape | null {
  const at = `shapes[${index}]`
  if (!isRecord(value)) {
    issues.push(`${at} must be an object`)
    return null
  }
  validateKnownKeys(
    value,
    new Set([
      "id",
      "type",
      "tone",
      "opacity",
      "width",
      "height",
      "radius",
      "label",
      "icon",
      "iconSize",
      "strokeWidth",
      "fill",
    ]),
    at,
    issues,
  )
  const id = readString(value, "id", at, issues)
  if (id !== undefined && !idPattern.test(id)) {
    issues.push(`${at}.id must contain only letters, numbers, underscores, or hyphens`)
  }
  const type = readString(value, "type", at, issues)
  if (type !== undefined && type !== "rect" && type !== "ellipse") {
    issues.push(`${at}.type must be rect or ellipse in a stack layout`)
  }
  const width = readNumber(value, "width", at, issues, { positive: true })
  const height = readNumber(value, "height", at, issues, { positive: true })
  const tone = readOptionalTone(value, "tone", at, issues)
  const opacity = readOptionalNumber(value, "opacity", at, issues, { nonNegative: true })
  if (opacity !== undefined && opacity > 1) issues.push(`${at}.opacity must not exceed 1`)
  const radius = readOptionalNumber(value, "radius", at, issues, { nonNegative: true })
  const label = readOptionalString(value, "label", at, issues)
  const icon = readOptionalString(value, "icon", at, issues)
  const iconSize = readOptionalNumber(value, "iconSize", at, issues, { positive: true })
  const strokeWidth = readOptionalNumber(value, "strokeWidth", at, issues, {
    nonNegative: true,
  })
  const fill = value.fill
  if (fill !== undefined && typeof fill !== "boolean") issues.push(`${at}.fill must be a boolean`)
  if (
    id === undefined ||
    (type !== "rect" && type !== "ellipse") ||
    width === undefined ||
    height === undefined
  ) {
    return null
  }
  return {
    id,
    type,
    width,
    height,
    ...(tone === undefined ? {} : { tone }),
    ...(opacity === undefined ? {} : { opacity }),
    ...(radius === undefined ? {} : { radius }),
    ...(label === undefined ? {} : { label }),
    ...(icon === undefined ? {} : { icon }),
    ...(iconSize === undefined ? {} : { iconSize }),
    ...(strokeWidth === undefined ? {} : { strokeWidth }),
    ...(typeof fill === "boolean" ? { fill } : {}),
  }
}

function parseEdge(value: unknown, index: number, issues: string[]): DiagramEdge | null {
  const at = `edges[${index}]`
  if (!isRecord(value)) {
    issues.push(`${at} must be an object`)
    return null
  }
  validateKnownKeys(
    value,
    new Set(["id", "from", "to", "label", "tone", "start", "end", "bend", "arrowhead"]),
    at,
    issues,
  )
  const id = readString(value, "id", at, issues)
  const from = readString(value, "from", at, issues)
  const to = readString(value, "to", at, issues)
  if (id !== undefined && !idPattern.test(id)) issues.push(`${at}.id has unsupported characters`)
  const start = value.start
  const end = value.end
  if (start !== undefined && (typeof start !== "string" || !anchors.has(start as Anchor))) {
    issues.push(`${at}.start must be auto, top, right, bottom, or left`)
  }
  if (end !== undefined && (typeof end !== "string" || !anchors.has(end as Anchor))) {
    issues.push(`${at}.end must be auto, top, right, bottom, or left`)
  }
  const arrowhead = value.arrowhead
  if (
    arrowhead !== undefined &&
    !["arrow", "triangle", "none"].includes(arrowhead as string)
  ) {
    issues.push(`${at}.arrowhead must be arrow, triangle, or none`)
  }
  if (id === undefined || from === undefined || to === undefined) return null
  return {
    id,
    from,
    to,
    ...(readOptionalString(value, "label", at, issues) === undefined
      ? {}
      : { label: value.label as string }),
    ...(readOptionalTone(value, "tone", at, issues) === undefined
      ? {}
      : { tone: value.tone as Tone }),
    ...(start === undefined ? {} : { start: start as Anchor }),
    ...(end === undefined ? {} : { end: end as Anchor }),
    ...(readOptionalNumber(value, "bend", at, issues) === undefined
      ? {}
      : { bend: value.bend as number }),
    ...(arrowhead === undefined
      ? {}
      : { arrowhead: arrowhead as "arrow" | "triangle" | "none" }),
  }
}

function parseStackLayout(value: unknown, issues: string[]): StackLayout | null {
  if (!isRecord(value)) {
    issues.push("layout must be an object")
    return null
  }
  validateKnownKeys(value, new Set(["type", "direction", "gap", "align"]), "layout", issues)
  if (value.type !== "stack") issues.push("layout.type must be stack")
  const direction = value.direction
  if (
    typeof direction !== "string" ||
    !stackDirections.has(direction as StackDirection)
  ) {
    issues.push("layout.direction must be horizontal or vertical")
  }
  const gap = readOptionalNumber(value, "gap", "layout", issues, { nonNegative: true })
  const align = value.align
  if (
    align !== undefined &&
    (typeof align !== "string" || !stackAlignments.has(align as StackAlign))
  ) {
    issues.push("layout.align must be start, center, or end")
  }
  if (
    value.type !== "stack" ||
    typeof direction !== "string" ||
    !stackDirections.has(direction as StackDirection)
  ) {
    return null
  }
  return {
    type: "stack",
    direction: direction as StackDirection,
    ...(gap === undefined ? {} : { gap }),
    ...(align === undefined || !stackAlignments.has(align as StackAlign)
      ? {}
      : { align: align as StackAlign }),
  }
}

export function parseDiagramSource(value: unknown): DiagramSource {
  const issues: string[] = []
  if (!isRecord(value)) throw new DiagramValidationError(["root must be an object"])
  const isStackSource = "layout" in value
  validateKnownKeys(
    value,
    new Set([
      "$schema",
      "version",
      "name",
      "canvas",
      "shapes",
      "edges",
      ...(isStackSource ? ["layout"] : []),
    ]),
    "root",
    issues,
  )

  if (value.version !== diagramVersion) issues.push(`version must be ${diagramVersion}`)
  const name = readString(value, "name", "root", issues)
  if (name !== undefined && !namePattern.test(name)) {
    issues.push("name must be lowercase kebab-case")
  }

  const canvasValue = value.canvas
  let canvas: DiagramSpec["canvas"] | null = null
  if (!isRecord(canvasValue)) {
    issues.push("canvas must be an object")
  } else {
    validateKnownKeys(canvasValue, new Set(["width", "height", "padding"]), "canvas", issues)
    const width = readNumber(canvasValue, "width", "canvas", issues, { positive: true })
    const height = readNumber(canvasValue, "height", "canvas", issues, { positive: true })
    const padding = readOptionalNumber(canvasValue, "padding", "canvas", issues, {
      nonNegative: true,
    })
    if (width !== undefined && height !== undefined) {
      canvas = { width, height, ...(padding === undefined ? {} : { padding }) }
    }
  }

  const layout = isStackSource ? parseStackLayout(value.layout, issues) : null
  const shapesValue = value.shapes
  const positionedShapes: DiagramShape[] = []
  const stackShapes: StackShape[] = []
  if (!Array.isArray(shapesValue)) {
    issues.push("shapes must be an array")
  } else {
    if (isStackSource && (shapesValue.length < 1 || shapesValue.length > 9)) {
      issues.push("stack layouts must contain between 1 and 9 shapes")
    }
    for (const [index, shape] of shapesValue.entries()) {
      if (isStackSource) {
        const parsed = parseStackShape(shape, index, issues)
        if (parsed !== null) stackShapes.push(parsed)
      } else {
        const parsed = parseShape(shape, index, issues)
        if (parsed !== null) positionedShapes.push(parsed)
      }
    }
  }

  const edgesValue = value.edges
  const edges: DiagramEdge[] = []
  if (edgesValue !== undefined) {
    if (!Array.isArray(edgesValue)) {
      issues.push("edges must be an array when present")
    } else {
      for (const [index, edge] of edgesValue.entries()) {
        const parsed = parseEdge(edge, index, issues)
        if (parsed !== null) edges.push(parsed)
      }
    }
  }

  const shapes = isStackSource ? stackShapes : positionedShapes
  const allIds = new Set<string>()
  for (const [kind, records] of [
    ["shape", shapes],
    ["edge", edges],
  ] as const) {
    for (const record of records) {
      if (allIds.has(record.id)) issues.push(`${kind} id ${record.id} is duplicated`)
      allIds.add(record.id)
    }
  }
  const connectableIds = new Set(
    shapes
      .filter(
        (shape): shape is BoxShape | StackShape =>
          shape.type === "rect" || shape.type === "ellipse",
      )
      .map((shape) => shape.id),
  )
  for (const edge of edges) {
    if (!connectableIds.has(edge.from)) issues.push(`edge ${edge.id} has unknown or non-connectable from id ${edge.from}`)
    if (!connectableIds.has(edge.to)) issues.push(`edge ${edge.id} has unknown or non-connectable to id ${edge.to}`)
    if (edge.from === edge.to) issues.push(`edge ${edge.id} cannot connect a shape to itself`)
  }

  if (isStackSource) {
    const indexes = new Map(stackShapes.map((shape, index) => [shape.id, index]))
    const connectedPairs = new Set<string>()
    for (const edge of edges) {
      const fromIndex = indexes.get(edge.from)
      const toIndex = indexes.get(edge.to)
      if (
        fromIndex !== undefined &&
        toIndex !== undefined &&
        Math.abs(fromIndex - toIndex) !== 1
      ) {
        issues.push(`edge ${edge.id} must connect adjacent stack shapes`)
      }
      if (fromIndex !== undefined && toIndex !== undefined && fromIndex !== toIndex) {
        const pair = [fromIndex, toIndex].sort((left, right) => left - right).join(":")
        if (connectedPairs.has(pair)) {
          issues.push(`edge ${edge.id} duplicates a connection between the same stack shapes`)
        }
        connectedPairs.add(pair)
      }
      if (edge.start !== undefined && edge.start !== "auto") {
        issues.push(`edge ${edge.id}.start must be auto or omitted in a stack layout`)
      }
      if (edge.end !== undefined && edge.end !== "auto") {
        issues.push(`edge ${edge.id}.end must be auto or omitted in a stack layout`)
      }
      if (edge.bend !== undefined && edge.bend !== 0) {
        issues.push(`edge ${edge.id}.bend must be 0 or omitted in a stack layout`)
      }
    }
  }

  if (
    issues.length > 0 ||
    name === undefined ||
    canvas === null ||
    (isStackSource && layout === null)
  ) {
    throw new DiagramValidationError(issues)
  }
  const common = {
    ...("$schema" in value && typeof value.$schema === "string" ? { $schema: value.$schema } : {}),
    version: diagramVersion,
    name,
    canvas,
  } as const
  if (isStackSource) {
    const stackEdges: readonly StackDiagramEdge[] = edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      ...(edge.label === undefined ? {} : { label: edge.label }),
      ...(edge.tone === undefined ? {} : { tone: edge.tone }),
      ...(edge.start === "auto" ? { start: edge.start } : {}),
      ...(edge.end === "auto" ? { end: edge.end } : {}),
      ...(edge.bend === 0 ? { bend: edge.bend } : {}),
      ...(edge.arrowhead === undefined ? {} : { arrowhead: edge.arrowhead }),
    }))
    return {
      ...common,
      layout: layout as StackLayout,
      shapes: stackShapes,
      ...(edgesValue === undefined ? {} : { edges: stackEdges }),
    } satisfies StackDiagramSource
  }
  return {
    ...common,
    shapes: positionedShapes,
    ...(edgesValue === undefined ? {} : { edges }),
  }
}

export function parseDiagramSpec(value: unknown): DiagramSpec {
  return resolveDiagramSource(parseDiagramSource(value))
}
