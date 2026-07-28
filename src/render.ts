import { readFile } from "node:fs/promises"
import { extname } from "node:path"
import { Resvg } from "@resvg/resvg-js"
import { sanitizeIcon } from "./icons.js"
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

function wrapText(text: string, maxWidth: number, fontSize: number): readonly string[] {
  const explicitLines = text.split("\n")
  const maxCharacters = Math.max(1, Math.floor(maxWidth / (fontSize * 0.56)))
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
}): string {
  const lines = wrapText(options.text, options.width, options.fontSize)
  const lineHeight = options.lineHeight ?? options.fontSize * 1.25
  const anchor = options.align
  const x =
    anchor === "middle"
      ? options.x + options.width / 2
      : anchor === "end"
        ? options.x + options.width
        : options.x
  return `<text x="${x}" y="${options.y}" text-anchor="${anchor}" dominant-baseline="hanging" fill="${options.color}" opacity="${options.opacity}" font-family="${escapeXml(options.family)}" font-size="${options.fontSize}" font-weight="${options.weight}">${lines
    .map(
      (line, index) =>
        `<tspan x="${x}" dy="${index === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`,
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
  family: string,
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
  const iconMarkup =
    icon === undefined
      ? ""
      : iconSvg({
          icon,
          x: shape.x + (shape.width - iconSize) / 2,
          y:
            shape.label === undefined
              ? shape.y + (shape.height - iconSize) / 2
              : shape.y + shape.height * 0.18,
          size: iconSize,
          color: tone.text,
          opacity,
        })
  const labelMarkup =
    shape.label === undefined
      ? ""
      : textSvg({
          text: shape.label,
          x: shape.x + 16,
          y:
            icon === undefined
              ? shape.y + shape.height / 2 - 12
              : shape.y + shape.height * 0.68,
          width: shape.width - 32,
          fontSize: 22,
          weight: 600,
          align: "middle",
          color: tone.text,
          opacity,
          family,
        })
  return `<g data-shape-id="${escapeXml(shape.id)}" opacity="${opacity}">${geometry}${iconMarkup}${labelMarkup}</g>`
}

function pointForAnchor(
  shape: BoxShape,
  anchor: Anchor | undefined,
  toward: { readonly x: number; readonly y: number },
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
  switch (resolved) {
    case "top":
      return { x: center.x, y: shape.y, normalized: { x: 0.5, y: 0 } }
    case "right":
      return {
        x: shape.x + shape.width,
        y: center.y,
        normalized: { x: 1, y: 0.5 },
      }
    case "bottom":
      return {
        x: center.x,
        y: shape.y + shape.height,
        normalized: { x: 0.5, y: 1 },
      }
    case "left":
      return { x: shape.x, y: center.y, normalized: { x: 0, y: 0.5 } }
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
  const start = pointForAnchor(from, edge.start, toCenter)
  const end = pointForAnchor(to, edge.end, fromCenter)
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

function edgeSvg(resolved: ResolvedEdge, theme: ThemeColors, family: string): string {
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
  const label =
    edge.label === undefined
      ? ""
      : `<text x="${control.x}" y="${control.y - 10}" text-anchor="middle" fill="${tone.text}" stroke="${theme.background}" stroke-width="6" paint-order="stroke" font-family="${escapeXml(family)}" font-size="18" font-weight="600">${escapeXml(edge.label)}</text>`
  return `<g data-edge-id="${escapeXml(edge.id)}"><path d="${path}" fill="none" stroke="${tone.stroke}" stroke-width="3" stroke-linecap="round" marker-end="${marker}"/>${label}</g>`
}

function shapeSvg(
  shape: DiagramShape,
  theme: ThemeColors,
  family: string,
  icons: Readonly<Record<string, IconDefinition>>,
): string {
  if (shape.type === "rect" || shape.type === "ellipse") {
    return boxSvg(shape, theme, family, icons)
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
    family,
  })
}

export async function renderSvg(
  spec: DiagramSpec,
  mode: ColorMode,
  config: DiagramConfig,
): Promise<RenderedDiagram> {
  const theme = resolveTheme(mode, config)
  const family = config.font?.family ?? "system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
  const icons = config.icons ?? {}
  const embeddedFonts = await fontCss(config)
  const markerDefinitions = Object.entries(theme.tones)
    .map(
      ([toneName, tone]) =>
        `<marker id="arrow-open-${toneName}" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto" markerUnits="strokeWidth"><path d="M2 2 10 6 2 10" fill="none" stroke="${tone.stroke}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></marker><marker id="arrow-triangle-${toneName}" markerWidth="11" markerHeight="11" refX="9" refY="5.5" orient="auto" markerUnits="strokeWidth"><path d="M1 1 10 5.5 1 10z" fill="${tone.stroke}"/></marker>`,
    )
    .join("")
  const edgeMarkup = (spec.edges ?? [])
    .map((edge) => edgeSvg(resolveEdge(spec, edge), theme, family))
    .join("")
  const shapeMarkup = spec.shapes.map((shape) => shapeSvg(shape, theme, family, icons)).join("")
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
