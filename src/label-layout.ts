import type { BoxLabelRow, BoxShape, DiagramFontFamily, TextWeight } from "./types.js"

const defaultLabelFontSize = 22
const defaultLabelWeight = 600
const defaultLineHeightRatio = 1.35
const defaultRowGap = 8
const iconLabelGap = 12

function characterWidthRatio(fontFamily: DiagramFontFamily): number {
  return fontFamily === "mono" ? 0.62 : 0.56
}

export function estimateDiagramTextWidth(
  text: string,
  fontSize: number,
  fontFamily: DiagramFontFamily = "default",
): number {
  return text.length * fontSize * characterWidthRatio(fontFamily)
}

export interface ResolvedLabelRow {
  readonly text: string
  readonly lines: readonly string[]
  readonly fontSize: number
  readonly fontFamily: DiagramFontFamily
  readonly weight: TextWeight
  readonly lineHeight: number
  readonly height: number
  readonly y: number
}

export interface BoxContentLayout {
  readonly icon?: {
    readonly x: number
    readonly y: number
    readonly size: number
  }
  readonly rows: readonly ResolvedLabelRow[]
}

export function wrapDiagramText(
  text: string,
  maxWidth: number,
  fontSize: number,
  fontFamily: DiagramFontFamily = "default",
): readonly string[] {
  const explicitLines = text.split("\n")
  const maxCharacters = Math.max(
    1,
    Math.floor(maxWidth / (fontSize * characterWidthRatio(fontFamily))),
  )
  const lines: string[] = []
  for (const explicitLine of explicitLines) {
    if (explicitLine.length <= maxCharacters) {
      lines.push(explicitLine)
      continue
    }
    const words = explicitLine.split(/\s+/)
    let current = ""
    for (const word of words) {
      const candidate = current === "" ? word : `${current} ${word}`
      if (candidate.length <= maxCharacters || current === "") {
        current = candidate
      } else {
        lines.push(current)
        current = word
      }
    }
    if (current !== "") lines.push(current)
  }
  return lines.length === 0 ? [""] : lines
}

function resolveRows(shape: BoxShape): readonly Omit<ResolvedLabelRow, "lines" | "height" | "y">[] {
  if (shape.labelRows !== undefined) {
    return shape.labelRows.map((row: BoxLabelRow) => ({
      text: row.text,
      fontSize: row.fontSize ?? defaultLabelFontSize,
      fontFamily: row.fontFamily ?? "default",
      weight: row.weight ?? defaultLabelWeight,
      lineHeight: (row.fontSize ?? defaultLabelFontSize) * defaultLineHeightRatio,
    }))
  }
  if (shape.label === undefined) return []
  const fontSize = shape.labelFontSize ?? defaultLabelFontSize
  return [
    {
      text: shape.label,
      fontSize,
      fontFamily: shape.labelFontFamily ?? "default",
      weight: shape.labelWeight ?? defaultLabelWeight,
      lineHeight: fontSize * defaultLineHeightRatio,
    },
  ]
}

export function layoutBoxContent(shape: BoxShape, resolvedIconSize?: number): BoxContentLayout {
  const textWidth = Math.max(1, shape.width - 32)
  const pendingRows = resolveRows(shape).map((row) => {
    const lines = wrapDiagramText(row.text, textWidth, row.fontSize, row.fontFamily)
    const height = lines.length * row.lineHeight
    return { ...row, lines, height }
  })
  const rowGap = shape.labelRows === undefined ? 0 : (shape.labelRowGap ?? defaultRowGap)
  const rowsHeight =
    pendingRows.reduce((total, row) => total + row.height, 0) +
    Math.max(0, pendingRows.length - 1) * rowGap
  const hasIcon = resolvedIconSize !== undefined
  const gap = hasIcon && pendingRows.length > 0 ? iconLabelGap : 0
  const contentHeight = (resolvedIconSize ?? 0) + gap + rowsHeight
  let cursorY = shape.y + (shape.height - contentHeight) / 2
  const icon =
    resolvedIconSize === undefined
      ? undefined
      : {
          x: shape.x + (shape.width - resolvedIconSize) / 2,
          y: cursorY,
          size: resolvedIconSize,
        }
  if (hasIcon) cursorY += resolvedIconSize + gap
  const rows = pendingRows.map((row) => {
    const resolved = { ...row, y: cursorY }
    cursorY += row.height + rowGap
    return resolved
  })
  return {
    ...(icon === undefined ? {} : { icon }),
    rows,
  }
}
