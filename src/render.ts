import { readFile } from "node:fs/promises"
import { extname } from "node:path"
import { Resvg } from "@resvg/resvg-js"
import { sanitizeIcon } from "./icons.js"
import { layoutBoxContent, wrapDiagramText } from "./label-layout.js"
import { resolveTheme } from "./theme.js"
import type {
  Anchor,
  BoxShape,
  ColorMode,
  DiagramConfig,
  DiagramEdge,
  DiagramShape,
  DiagramSpec,
  IconDefinition,
  RenderedDiagram,
  TextShape,
  ThemeColors,
} from "./types.js"

interface FontFamilies {
  readonly default: string
  readonly mono: string
}

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")

function fontMime(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".otf":
      return "font/otf"
    case ".woff":
      return "font/woff"
    case ".woff2":
      return "font/woff2"
    default:
      return "font/ttf"
  }
}

async function fontCss(config: DiagramConfig): Promise<string> {
  if (config.font?.files === undefined) return ""
  const faces = await Promise.all(
    config.font.files
      .filter((file) => file.embed === true)
      .map(async (file) => {
        const encoded = (await readFile(file.path)).toString("base64")
        return `@font-face{font-family:"${escapeXml(config.font!.family)}";src:url(data:${fontMime(file.path)};base64,${encoded});font-weight:${file.weight ?? 400};font-style:${file.style ?? "normal"};}`
      }),
  )
  return faces.join("")
}

function textSvg(options: {
  readonly text: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly fontSize: number
  readonly weight: number
  readonly align: "start" | "middle" | "end"
  readonly color: string
  readonly opacity: number
  readonly family: string
  readonly lineHeight?: number
  readonly lines?: readonly string[]
  readonly centerLineBoxes?: boolean
}): string {
  const lines = options.lines ?? wrapDiagramText(options.text, options.width, options.fontSize)
  const lineHeight = options.lineHeight ?? options.fontSize * 1.25
  const anchor = options.align
  const x =
    anchor === "middle"
      ? options.x + options.width / 2
      : anchor === "end"
        ? options.x + options.width
        : options.x
  const dominantBaseline = options.centerLineBoxes ? "central" : "hanging"
  return `<text x="${x}" y="${options.y}" text-anchor="${anchor}" dominant-baseline="${dominantBaseline}" fill="${options.color}" opacity="${options.opacity}" font-family="${escapeXml(options.family)}" font-size="${options.fontSize}" font-weight="${options.weight}">${lines
    .map((line, index) =>
      options.centerLineBoxes
        ? `<tspan x="${x}" y="${options.y + (index + 0.5) * lineHeight}">${escapeXml(line)}</tspan>`
        : `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join("")}</text>`
}

function iconSvg(options: {
  readonly icon: IconDefinition
  readonly x: number
  readonly y: number
  readonly size: number
  readonly color: string
  readonly opacity: number
}): string {
  const icon = sanitizeIcon(options.icon)
  const parts = icon.viewBox.trim().split(/\s+/).map(Number)
  const width = (parts[2] ?? 24) - (parts[0] ?? 0)
  const height = (parts[3] ?? 24) - (parts[1] ?? 0)
  const scale = options.size / Math.max(width, height)
  return `<g color="${options.color}" opacity="${options.opacity}" transform="translate(${options.x} ${options.y}) scale(${scale}) translate(${-Number(parts[0] ?? 0)} ${-Number(parts[1] ?? 0)})">${icon.body}</g>`
}

function boxSvg(
  shape: BoxShape,
  theme: ThemeColors,
  families: FontFamilies,
  icons: Readonly<Record<string, IconDefinition>>,
): string {
  const tone = theme.tones[shape.tone ?? "neutral"]
  const strokeWidth = shape.strokeWidth ?? 2
  const opacity = shape.opacity ?? 1
  const radius = shape.type === "ellipse" ? 0 : Math.min(shape.radius ?? 22, shape.height / 2)
  const geometry =
    shape.type === "ellipse"
      ? `<ellipse cx="${shape.x + shape.width / 2}" cy="${shape.y + shape.height / 2}" rx="${shape.width / 2}" ry="${shape.height / 2}" fill="${shape.fill === false ? "none" : tone.fill}" stroke="${tone.stroke}" stroke-width="${strokeWidth}"/>`
      : `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" rx="${radius}" fill="${shape.fill === false ? "none" : tone.fill}" stroke="${tone.stroke}" stroke-width="${strokeWidth}"/>`
  const icon = shape.icon === undefined ? undefined : icons[shape.icon]
  if (shape.icon !== undefined && icon === undefined) {
    throw new Error(`Unknown icon "${shape.icon}" on shape ${shape.id}`)
  }
  const iconSize = Math.min(shape.iconSize ?? 52, shape.height * 0.45, shape.width * 0.32)
  const content = layoutBoxContent(shape, icon === undefined ? undefined : iconSize)
  const iconMarkup =
    icon === undefined || content.icon === undefined
      ? ""
      : iconSvg({
          icon,
          x: content.icon.x,
          y: content.icon.y,
          size: content.icon.size,
          color: tone.text,
          opacity: 1,
        })
  const labelMarkup = content.rows
    .map((row) =>
      textSvg({
          text: row.text,
          x: shape.x + 16,
          y: row.y,
          width: shape.width - 32,
          fontSize: row.fontSize,
          weight: row.weight,
          align: "middle",
          color: tone.text,
          opacity: 1,
          family: families[row.fontFamily],
          lineHeight: row.lineHeight,
          lines: row.lines,
          centerLineBoxes: true,
        }),
    )
    .join("")
  return `<g data-shape-id="${escapeXml(shape.id)}" opacity="${opacity}">${geometry}${iconMarkup}${labelMarkup}</g>`
}

function pointForAnchor(
  shape: BoxShape,
  anchor: Anchor | undefined,
  toward: { readonly x: number; readonly y: number },
  position: number | undefined,
): { readonly x: number; readonly y: number; readonly normalized: { readonly x: number; readonly y: number } } {
  const center = { x: shape.x + shape.width / 2, y: shape.y + shape.height / 2 }
  let resolved = anchor ?? "auto"
  if (resolved === "auto") {
    const dx = toward.x - center.x
    const dy = toward.y - center.y
    resolved =
      Math.abs(dx / shape.width) >= Math.abs(dy / shape.height)
        ? dx >= 0
          ? "right"
          : "left"
        : dy >= 0
          ? "bottom"
          : "top"
  }
  const resolvedPosition = position ?? 0.5
  if (shape.type === "ellipse") {
    const projected = (resolvedPosition - 0.5) * 2
    const radial = Math.sqrt(Math.max(0, 1 - projected * projected)) / 2
    const normalized =
      resolved === "top"
        ? { x: resolvedPosition, y: 0.5 - radial }
        : resolved === "bottom"
          ? { x: resolvedPosition, y: 0.5 + radial }
          : resolved === "left"
            ? { x: 0.5 - radial, y: resolvedPosition }
            : { x: 0.5 + radial, y: resolvedPosition }
    return {
      x: shape.x + shape.width * normalized.x,
      y: shape.y + shape.height * normalized.y,
      normalized,
    }
  }
  switch (resolved) {
    case "top":
      return {
        x: shape.x + shape.width * resolvedPosition,
        y: shape.y,
        normalized: { x: resolvedPosition, y: 0 },
      }
    case "right":
      return {
        x: shape.x + shape.width,
        y: shape.y + shape.height * resolvedPosition,
        normalized: { x: 1, y: resolvedPosition },
      }
    case "bottom":
      return {
        x: shape.x + shape.width * resolvedPosition,
        y: shape.y + shape.height,
        normalized: { x: resolvedPosition, y: 1 },
      }
    case "left":
      return {
        x: shape.x,
        y: shape.y + shape.height * resolvedPosition,
        normalized: { x: 0, y: resolvedPosition },
      }
  }
}

export interface ResolvedEdge {
  readonly edge: DiagramEdge
  readonly from: BoxShape
  readonly to: BoxShape
  readonly start: ReturnType<typeof pointForAnchor>
  readonly end: ReturnType<typeof pointForAnchor>
  readonly control: { readonly x: number; readonly y: number }
}

export function resolveEdge(spec: DiagramSpec, edge: DiagramEdge): ResolvedEdge {
  const boxes = new Map(
    spec.shapes
      .filter((shape): shape is BoxShape => shape.type === "rect" || shape.type === "ellipse")
      .map((shape) => [shape.id, shape]),
  )
  const from = boxes.get(edge.from)
  const to = boxes.get(edge.to)
  if (from === undefined || to === undefined) {
    throw new Error(`Edge ${edge.id} references a missing box`)
  }
  const fromCenter = { x: from.x + from.width / 2, y: from.y + from.height / 2 }
  const toCenter = { x: to.x + to.width / 2, y: to.y + to.height / 2 }
  const start = pointForAnchor(from, edge.start, toCenter, edge.startPosition)
  const end = pointForAnchor(to, edge.end, fromCenter, edge.endPosition)
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy) || 1
  const bend = edge.bend ?? 0
  return {
    edge,
    from,
    to,
    start,
    end,
    control: {
      x: (start.x + end.x) / 2 + (-dy / length) * bend,
      y: (start.y + end.y) / 2 + (dx / length) * bend,
    },
  }
}

export function resolveEdgeLabel(resolved: ResolvedEdge): {
  readonly x: number
  readonly y: number
} {
  const { edge, start, end, control } = resolved
  const t = edge.labelPosition ?? 0.5
  const oneMinusT = 1 - t
  const point = {
    x: oneMinusT * oneMinusT * start.x + 2 * oneMinusT * t * control.x + t * t * end.x,
    y: oneMinusT * oneMinusT * start.y + 2 * oneMinusT * t * control.y + t * t * end.y,
  }
  const tangent = {
    x: 2 * oneMinusT * (control.x - start.x) + 2 * t * (end.x - control.x),
    y: 2 * oneMinusT * (control.y - start.y) + 2 * t * (end.y - control.y),
  }
  const length = Math.hypot(tangent.x, tangent.y) || 1
  const offset = edge.labelOffset ?? -14
  return {
    x: point.x + (-tangent.y / length) * offset,
    y: point.y + (tangent.x / length) * offset,
  }
}

function edgeSvg(resolved: ResolvedEdge, theme: ThemeColors, families: FontFamilies): string {
  const { edge, start, end, control } = resolved
  const toneName = edge.tone ?? "neutral"
  const tone = theme.tones[toneName]
  const marker =
    edge.arrowhead === "none"
      ? ""
      : edge.arrowhead === "triangle"
        ? `url(#arrow-triangle-${toneName})`
        : `url(#arrow-open-${toneName})`
  const path = `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`
  const labelPoint = resolveEdgeLabel(resolved)
  const label =
    edge.label === undefined
      ? ""
      : `<text x="${labelPoint.x}" y="${labelPoint.y}" text-anchor="middle" dominant-baseline="central" fill="${tone.text}" stroke="${theme.background}" stroke-width="6" paint-order="stroke" font-family="${escapeXml(families[edge.labelFontFamily ?? "default"])}" font-size="${edge.labelFontSize ?? 18}" font-weight="${edge.labelWeight ?? 600}">${escapeXml(edge.label)}</text>`
  return `<g data-edge-id="${escapeXml(edge.id)}"><path d="${path}" fill="none" stroke="${tone.stroke}" stroke-width="3" stroke-linecap="round" marker-end="${marker}"/>${label}</g>`
}

function shapeSvg(
  shape: DiagramShape,
  theme: ThemeColors,
  families: FontFamilies,
  icons: Readonly<Record<string, IconDefinition>>,
): string {
  if (shape.type === "rect" || shape.type === "ellipse") {
    return boxSvg(shape, theme, families, icons)
  }
  if (shape.type === "line") {
    return `<line data-shape-id="${escapeXml(shape.id)}" x1="${shape.x}" y1="${shape.y}" x2="${shape.x2}" y2="${shape.y2}" stroke="${theme.tones[shape.tone ?? "neutral"].stroke}" stroke-width="${shape.strokeWidth ?? 3}" stroke-linecap="round" opacity="${shape.opacity ?? 1}"/>`
  }
  const text = shape as TextShape
  return textSvg({
    text: text.text,
    x: text.x,
    y: text.y,
    width: text.width ?? Math.max(text.text.length * (text.fontSize ?? 24) * 0.58, 12),
    fontSize: text.fontSize ?? 24,
    weight: text.weight ?? 500,
    align: text.align ?? "start",
    color: theme.tones[text.tone ?? "neutral"].text,
    opacity: text.opacity ?? 1,
    family: families[text.fontFamily ?? "default"],
  })
}

export async function renderSvg(
  spec: DiagramSpec,
  mode: ColorMode,
  config: DiagramConfig,
): Promise<RenderedDiagram> {
  const theme = resolveTheme(mode, config)
  const families: FontFamilies = {
    default: config.font?.family ?? "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
    mono:
      config.font?.monoFamily ??
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace",
  }
  const icons = config.icons ?? {}
  const embeddedFonts = await fontCss(config)
  const markerDefinitions = Object.entries(theme.tones)
    .map(
      ([toneName, tone]) =>
        `<marker id="arrow-open-${toneName}" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="strokeWidth"><path d="M2 2 10 6 2 10" fill="none" stroke="${tone.stroke}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></marker><marker id="arrow-triangle-${toneName}" markerWidth="11" markerHeight="11" refX="9" refY="5.5" orient="auto" markerUnits="strokeWidth"><path d="M1 1 10 5.5 1 10z" fill="${tone.stroke}"/></marker>`,
    )
    .join("")
  const edgeMarkup = (spec.edges ?? [])
    .map((edge) => edgeSvg(resolveEdge(spec, edge), theme, families))
    .join("")
  const shapeMarkup = spec.shapes
    .map((shape) => shapeSvg(shape, theme, families, icons))
    .join("")
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${spec.canvas.width}" height="${spec.canvas.height}" viewBox="0 0 ${spec.canvas.width} ${spec.canvas.height}" role="img" aria-labelledby="diagram-title" color-scheme="${mode}">`,
    `<title id="diagram-title">${escapeXml(spec.name)}</title>`,
    `<style>${embeddedFonts}text{font-kerning:normal;text-rendering:geometricPrecision}</style>`,
    `<rect width="100%" height="100%" fill="${theme.background}"/>`,
    `<defs>${markerDefinitions}</defs>`,
    edgeMarkup,
    shapeMarkup,
    "</svg>",
  ].join("")
  return { mode, svg, width: spec.canvas.width, height: spec.canvas.height }
}

export function renderPng(
  rendered: RenderedDiagram,
  config: DiagramConfig,
  scale = 2,
): Uint8Array {
  const fontFiles = config.font?.files?.map((file) => file.path) ?? []
  const renderer = new Resvg(rendered.svg, {
    fitTo: { mode: "zoom", value: scale },
    font: {
      loadSystemFonts: true,
      ...(fontFiles.length === 0 ? {} : { fontFiles }),
      defaultFontFamily: config.font?.family ?? "sans-serif",
    },
  })
  return renderer.render().asPng()
}
