import type {
  Anchor,
  BoxShape,
  DiagramEdge,
  DiagramSource,
  DiagramSpec,
  StackDiagramEdge,
  StackDiagramSource,
  StackShape,
} from "./types.js"

export const stackLayoutDefaults = {
  gap: 160,
  padding: 64,
  align: "center",
} as const

const coordinatePrecision = 3
const coordinateScale = 10 ** coordinatePrecision

interface MainPlacement {
  readonly offsets: readonly number[]
  readonly span: number
}

export class StackLayoutError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(`Invalid stack layout:\n${issues.map((issue) => `- ${issue}`).join("\n")}`)
    this.name = "StackLayoutError"
    this.issues = issues
  }
}

function coordinateFromUnits(value: number): number {
  return value / coordinateScale
}

function normalizedScaledCoordinate(value: number): number {
  const scaled = value * coordinateScale
  return normalizedGridValue(scaled)
}

function normalizedGridValue(value: number): number {
  const nearest = Math.round(value)
  return Math.abs(value - nearest) <= 1e-9 ? nearest : value
}

function floorGridValue(value: number): number {
  return Math.floor(normalizedGridValue(value))
}

function ceilGridValue(value: number): number {
  return Math.ceil(normalizedGridValue(value))
}

function coordinateUnits(
  value: number,
  label: string,
  positive: boolean,
  rounding: "ceil" | "floor",
  issues: string[],
): number {
  if (
    !Number.isFinite(value) ||
    (positive ? value <= 0 : value < 0)
  ) {
    issues.push(
      positive ? `${label} must be positive` : `${label} must not be negative`,
    )
    return 0
  }
  const scaled = normalizedScaledCoordinate(value)
  const units =
    rounding === "ceil" ? ceilGridValue(scaled) : floorGridValue(scaled)
  if (!Number.isSafeInteger(units)) {
    issues.push(`${label} must be a finite coordinate within the supported range`)
    return 0
  }
  if (positive && units < 1) {
    issues.push(
      `${label} must occupy at least ${coordinateFromUnits(1)}px in the layout grid`,
    )
    return 0
  }
  return units
}

function positionedShape(
  shape: StackShape,
  mainPosition: number,
  crossPosition: number,
  horizontal: boolean,
): BoxShape {
  return {
    ...shape,
    x: coordinateFromUnits(horizontal ? mainPosition : crossPosition),
    y: coordinateFromUnits(horizontal ? crossPosition : mainPosition),
  }
}

function authoredMainSize(
  shape: StackShape,
  horizontal: boolean,
): number {
  return horizontal ? shape.width : shape.height
}

function emittedMainPlacement(
  shapes: readonly StackShape[],
  horizontal: boolean,
  gap: number,
  issues: string[],
): MainPlacement {
  if (shapes.length === 0) return { offsets: [], span: 0 }
  const offsets: number[] = []
  let offset = 0
  for (const [index, shape] of shapes.entries()) {
    offsets.push(offset)
    if (index === shapes.length - 1) break
    const advance = coordinateUnits(
      authoredMainSize(shape, horizontal) + gap,
      `space after shape ${shape.id}`,
      true,
      "ceil",
      issues,
    )
    offset += advance
    if (!Number.isSafeInteger(offset)) {
      issues.push("stack positions exceed the supported coordinate range")
      return { offsets, span: Number.POSITIVE_INFINITY }
    }
  }
  const last = shapes.at(-1)
  const span =
    offset +
    (last === undefined
      ? 0
      : normalizedScaledCoordinate(authoredMainSize(last, horizontal)))
  if (!Number.isFinite(span) || !Number.isSafeInteger(Math.ceil(span))) {
    issues.push("stack extent exceeds the supported coordinate range")
  }
  return { offsets, span }
}

function clampedGridPosition(
  ideal: number,
  minimum: number,
  maximum: number,
): number {
  return Math.min(maximum, Math.max(minimum, Math.round(ideal)))
}

function resolvedAnchors(
  fromIndex: number,
  toIndex: number,
  horizontal: boolean,
): { readonly start: Anchor; readonly end: Anchor } {
  const forward = fromIndex < toIndex
  if (horizontal) {
    return forward
      ? { start: "right", end: "left" }
      : { start: "left", end: "right" }
  }
  return forward
    ? { start: "bottom", end: "top" }
    : { start: "top", end: "bottom" }
}

function resolvedEdge(
  edge: StackDiagramEdge,
  indexes: ReadonlyMap<string, number>,
  horizontal: boolean,
): DiagramEdge {
  const fromIndex = indexes.get(edge.from)
  const toIndex = indexes.get(edge.to)
  if (fromIndex === undefined || toIndex === undefined) {
    throw new StackLayoutError([
      `edge ${edge.id} must reference shapes that belong to the stack`,
    ])
  }
  const anchors = resolvedAnchors(fromIndex, toIndex, horizontal)
  return {
    ...edge,
    start: anchors.start,
    end: anchors.end,
    bend: 0,
  }
}

function stackStructureIssues(source: StackDiagramSource): readonly string[] {
  const issues: string[] = []
  if (source.shapes.length < 1 || source.shapes.length > 9) {
    issues.push("stack layouts must contain between 1 and 9 shapes")
  }

  const indexes = new Map<string, number>()
  const recordIds = new Set<string>()
  for (const [index, shape] of source.shapes.entries()) {
    if (recordIds.has(shape.id)) {
      issues.push(`shape id ${shape.id} is duplicated`)
    } else {
      indexes.set(shape.id, index)
      recordIds.add(shape.id)
    }
  }

  const connectedPairs = new Set<string>()
  for (const stackEdge of source.edges ?? []) {
    const edge: DiagramEdge = stackEdge
    if (recordIds.has(edge.id)) {
      issues.push(`edge id ${edge.id} is duplicated`)
    }
    recordIds.add(edge.id)

    const fromIndex = indexes.get(edge.from)
    const toIndex = indexes.get(edge.to)
    if (fromIndex === undefined) {
      issues.push(`edge ${edge.id} has unknown from id ${edge.from}`)
    }
    if (toIndex === undefined) {
      issues.push(`edge ${edge.id} has unknown to id ${edge.to}`)
    }
    if (fromIndex !== undefined && toIndex !== undefined) {
      if (fromIndex === toIndex) {
        issues.push(`edge ${edge.id} cannot connect a shape to itself`)
      } else {
        if (Math.abs(fromIndex - toIndex) !== 1) {
          issues.push(`edge ${edge.id} must connect adjacent stack shapes`)
        }
        const pair = [fromIndex, toIndex]
          .sort((left, right) => left - right)
          .join(":")
        if (connectedPairs.has(pair)) {
          issues.push(
            `edge ${edge.id} duplicates a connection between the same stack shapes`,
          )
        }
        connectedPairs.add(pair)
      }
    }
    if (edge.start !== undefined && edge.start !== "auto") {
      issues.push(
        `edge ${edge.id}.start must be auto or omitted in a stack layout`,
      )
    }
    if (edge.end !== undefined && edge.end !== "auto") {
      issues.push(
        `edge ${edge.id}.end must be auto or omitted in a stack layout`,
      )
    }
    if (edge.bend !== undefined && edge.bend !== 0) {
      issues.push(`edge ${edge.id}.bend must be 0 or omitted in a stack layout`)
    }
  }
  return issues
}

export function resolveStackLayout(source: StackDiagramSource): DiagramSpec {
  const issues = [...stackStructureIssues(source)]
  const horizontal = source.layout.direction === "horizontal"
  coordinateUnits(
    source.canvas.width,
    "canvas width",
    true,
    "floor",
    issues,
  )
  coordinateUnits(
    source.canvas.height,
    "canvas height",
    true,
    "floor",
    issues,
  )
  const gapValue = source.layout.gap ?? stackLayoutDefaults.gap
  coordinateUnits(
    gapValue,
    "stack gap",
    false,
    "ceil",
    issues,
  )
  const paddingValue = source.canvas.padding ?? stackLayoutDefaults.padding
  const padding = coordinateUnits(
    paddingValue,
    "canvas padding",
    false,
    "ceil",
    issues,
  )
  for (const shape of source.shapes) {
    coordinateUnits(
      shape.width,
      `shape ${shape.id} width`,
      true,
      "ceil",
      issues,
    )
    coordinateUnits(
      shape.height,
      `shape ${shape.id} height`,
      true,
      "ceil",
      issues,
    )
  }
  const align = source.layout.align ?? stackLayoutDefaults.align
  const canvasMainValue = horizontal
    ? source.canvas.width
    : source.canvas.height
  const canvasCrossValue = horizontal
    ? source.canvas.height
    : source.canvas.width
  const mainPlacement = emittedMainPlacement(
    source.shapes,
    horizontal,
    gapValue,
    issues,
  )
  const maximumMainStart = floorGridValue(
    normalizedScaledCoordinate(canvasMainValue - paddingValue) -
      mainPlacement.span,
  )
  if (padding > maximumMainStart) {
    const requiredMain = ceilGridValue(mainPlacement.span)
    const availableMain = floorGridValue(
      normalizedScaledCoordinate(canvasMainValue - paddingValue * 2),
    )
    issues.push(
      `${source.layout.direction} stack needs ${coordinateFromUnits(requiredMain)}px but only ${coordinateFromUnits(availableMain)}px remain inside ${paddingValue}px padding`,
    )
  }
  const crossStarts = source.shapes.map((shape) => {
    const authoredSize = horizontal
      ? shape.height
      : shape.width
    const maximum = floorGridValue(
      normalizedScaledCoordinate(
        canvasCrossValue - paddingValue - authoredSize,
      ),
    )
    if (padding > maximum) {
      const requiredCross = ceilGridValue(
        normalizedScaledCoordinate(authoredSize),
      )
      const availableCross = floorGridValue(
        normalizedScaledCoordinate(canvasCrossValue - paddingValue * 2),
      )
      issues.push(
        `shape ${shape.id} needs ${coordinateFromUnits(requiredCross)}px on the cross axis but only ${coordinateFromUnits(availableCross)}px remain inside ${paddingValue}px padding`,
      )
    }
    return { authoredSize, maximum }
  })
  if (issues.length > 0) throw new StackLayoutError(issues)

  const mainStart = clampedGridPosition(
    (normalizedScaledCoordinate(canvasMainValue) -
      mainPlacement.span) /
      2,
    padding,
    maximumMainStart,
  )
  const shapes = source.shapes.map((shape, index) => {
    const crossStart = crossStarts[index]
    if (crossStart === undefined) {
      throw new StackLayoutError([
        `shape ${shape.id} has no cross-axis placement`,
      ])
    }
    const crossPosition =
      align === "start"
        ? padding
        : align === "end"
          ? crossStart.maximum
          : clampedGridPosition(
              normalizedScaledCoordinate(
                (canvasCrossValue - crossStart.authoredSize) / 2,
              ),
              padding,
              crossStart.maximum,
            )
    const mainPosition = mainStart + (mainPlacement.offsets[index] ?? 0)
    const positioned = positionedShape(
      shape,
      mainPosition,
      crossPosition,
      horizontal,
    )
    return positioned
  })
  const indexes = new Map(shapes.map((shape, index) => [shape.id, index]))
  const edges = source.edges?.map((edge) => resolvedEdge(edge, indexes, horizontal))

  return {
    ...(source.$schema === undefined ? {} : { $schema: source.$schema }),
    version: source.version,
    name: source.name,
    canvas: {
      width: source.canvas.width,
      height: source.canvas.height,
      padding: paddingValue,
    },
    shapes,
    ...(edges === undefined ? {} : { edges }),
  }
}

export function resolveDiagramSource(source: DiagramSource): DiagramSpec {
  return "layout" in source ? resolveStackLayout(source) : source
}
