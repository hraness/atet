import { sanitizeIcon } from "./icons.js"
import { resolveEdge } from "./render.js"
import { resolveTheme } from "./theme.js"
import type {
  BoxShape,
  DiagramConfig,
  DiagramShape,
  DiagramSpec,
  IconDefinition,
  LineShape,
  TextShape,
  Tone,
} from "./types.js"

type TldrawRecord = Readonly<Record<string, unknown>>

const schema = {
  schemaVersion: 2,
  sequences: {
    "com.tldraw.store": 5,
    "com.tldraw.asset": 1,
    "com.tldraw.camera": 1,
    "com.tldraw.document": 2,
    "com.tldraw.instance": 26,
    "com.tldraw.instance_page_state": 5,
    "com.tldraw.page": 1,
    "com.tldraw.instance_presence": 6,
    "com.tldraw.pointer": 1,
    "com.tldraw.shape": 4,
    "com.tldraw.user": 1,
    "com.tldraw.asset.image": 6,
    "com.tldraw.asset.video": 5,
    "com.tldraw.asset.bookmark": 2,
    "com.tldraw.shape.group": 0,
    "com.tldraw.shape.text": 4,
    "com.tldraw.shape.bookmark": 2,
    "com.tldraw.shape.draw": 5,
    "com.tldraw.shape.geo": 11,
    "com.tldraw.shape.note": 13,
    "com.tldraw.shape.line": 5,
    "com.tldraw.shape.frame": 1,
    "com.tldraw.shape.arrow": 8,
    "com.tldraw.shape.highlight": 4,
    "com.tldraw.shape.embed": 4,
    "com.tldraw.shape.image": 5,
    "com.tldraw.shape.video": 4,
    "com.tldraw.binding.arrow": 1,
  },
} as const

const tldrawColors: Readonly<Record<Tone, string>> = {
  neutral: "black",
  blue: "blue",
  orange: "orange",
  green: "green",
  red: "red",
  purple: "violet",
  yellow: "yellow",
}

function richText(text: string): Readonly<Record<string, unknown>> {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        ...(text === "" ? {} : { content: [{ type: "text", text }] }),
      },
    ],
  }
}

function shapeId(id: string): string {
  return `shape:${id}`
}

function shapeMeta(sourceId: string): Readonly<Record<string, unknown>> {
  return { diagram: { version: 1, sourceId } }
}

function indexKey(index: number): string {
  const alphabet = "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  const value = alphabet[index]
  if (value === undefined) {
    throw new Error("A .tldr export currently supports at most 61 generated records")
  }
  return `a${value}`
}

function baseShape(shape: DiagramShape, index: number): TldrawRecord {
  return {
    x: shape.x,
    y: shape.y,
    rotation: 0,
    isLocked: false,
    opacity: shape.opacity ?? 1,
    meta: shapeMeta(shape.id),
    id: shapeId(shape.id),
    parentId: "page:page",
    index: indexKey(index),
    typeName: "shape",
  }
}

function textShape(options: {
  readonly id: string
  readonly sourceId: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly text: string
  readonly tone: Tone
  readonly size: "s" | "m" | "l" | "xl"
  readonly align: "start" | "middle" | "end"
  readonly index: number
  readonly opacity?: number
  readonly scale?: number
}): TldrawRecord {
  return {
    x: options.x,
    y: options.y,
    rotation: 0,
    isLocked: false,
    opacity: options.opacity ?? 1,
    meta: shapeMeta(options.sourceId),
    id: shapeId(options.id),
    type: "text",
    props: {
      color: tldrawColors[options.tone],
      size: options.size,
      w: options.width,
      font: "sans",
      textAlign: options.align,
      autoSize: false,
      scale: options.scale ?? 1,
      richText: richText(options.text),
    },
    parentId: "page:page",
    index: indexKey(options.index),
    typeName: "shape",
  }
}

function svgIconAsset(icon: IconDefinition, color: string): string {
  const clean = sanitizeIcon(icon)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="${clean.viewBox}" fill="none" color="${color}">${clean.body}</svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
}

function tldrawSize(fontSize: number | undefined): "s" | "m" | "l" | "xl" {
  if (fontSize === undefined || fontSize < 20) return "m"
  if (fontSize < 28) return "l"
  return "xl"
}

const tldrawTextFontSizes = {
  s: 18,
  m: 24,
  l: 36,
  xl: 44,
} as const

function scaledTldrawSize(fontSize: number): {
  readonly size: keyof typeof tldrawTextFontSizes
  readonly scale: number
} {
  const size = fontSize < 21 ? "s" : fontSize < 30 ? "m" : fontSize < 40 ? "l" : "xl"
  return { size, scale: fontSize / tldrawTextFontSizes[size] }
}

export function serializeTldr(spec: DiagramSpec, config: DiagramConfig): string {
  const records: TldrawRecord[] = [
    {
      gridSize: 10,
      name: spec.name,
      meta: { diagram: { version: 1 } },
      id: "document:document",
      typeName: "document",
    },
    {
      meta: {},
      id: "page:page",
      name: "Page 1",
      index: "a1",
      typeName: "page",
    },
  ]
  const icons = config.icons ?? {}
  const lightTheme = resolveTheme("light", config)
  let generatedIndex = 1

  for (const shape of spec.shapes) {
    generatedIndex += 1
    if (shape.type === "rect" || shape.type === "ellipse") {
      const box = shape as BoxShape
      const hasIcon = box.icon !== undefined
      const hasSeparateLabel =
        box.label !== undefined && (hasIcon || box.labelFontSize !== undefined)
      records.push({
        ...baseShape(box, generatedIndex),
        type: "geo",
        props: {
          w: box.width,
          h: box.height,
          geo: box.type === "ellipse" ? "ellipse" : "rectangle",
          dash: "solid",
          growY: 0,
          url: "",
          scale: 1,
          color: tldrawColors[box.tone ?? "neutral"],
          labelColor: "black",
          fill: box.fill === false ? "none" : "solid",
          size: (box.strokeWidth ?? 2) >= 4 ? "l" : "m",
          font: "sans",
          align: "middle",
          verticalAlign: "middle",
          richText: richText(hasSeparateLabel ? "" : (box.label ?? "")),
        },
      })
      if (box.icon !== undefined) {
        const icon = icons[box.icon]
        if (icon === undefined) throw new Error(`Unknown icon "${box.icon}" on shape ${box.id}`)
        const iconSize = Math.min(box.iconSize ?? 52, box.height * 0.45, box.width * 0.32)
        const assetId = `asset:icon-${box.id}`
        records.push({
          id: assetId,
          type: "image",
          typeName: "asset",
          props: {
            name: `${box.icon}.svg`,
            src: svgIconAsset(icon, lightTheme.tones[box.tone ?? "neutral"].text),
            w: 96,
            h: 96,
            mimeType: "image/svg+xml",
            isAnimated: false,
          },
          meta: { diagram: { version: 1, icon: box.icon } },
        })
        generatedIndex += 1
        records.push({
          x: box.x + (box.width - iconSize) / 2,
          y:
            box.label === undefined
              ? box.y + (box.height - iconSize) / 2
              : box.y + box.height * 0.18,
          rotation: 0,
          isLocked: false,
          opacity: box.opacity ?? 1,
          meta: shapeMeta(box.id),
          id: shapeId(`${box.id}-icon`),
          type: "image",
          props: {
            w: iconSize,
            h: iconSize,
            assetId,
            playing: true,
            url: "",
            crop: null,
            flipX: false,
            flipY: false,
            altText: box.label ?? box.icon,
          },
          parentId: "page:page",
          index: indexKey(generatedIndex),
          typeName: "shape",
        })
      }
      if (hasSeparateLabel && box.label !== undefined) {
        const textStyle =
          box.labelFontSize === undefined
            ? { size: "l" as const, scale: 1 }
            : scaledTldrawSize(box.labelFontSize)
        generatedIndex += 1
        records.push(
          textShape({
            id: `${box.id}-label`,
            sourceId: box.id,
            x: box.x + 16,
            y:
              hasIcon
                ? box.y + box.height * 0.68
                : box.y + box.height / 2 - (box.labelFontSize ?? 22) * 0.55,
            width: (box.width - 32) / textStyle.scale,
            text: box.label,
            tone: box.tone ?? "neutral",
            size: textStyle.size,
            align: "middle",
            index: generatedIndex,
            scale: textStyle.scale,
            ...(box.opacity === undefined ? {} : { opacity: box.opacity }),
          }),
        )
      }
      continue
    }

    if (shape.type === "text") {
      const text = shape as TextShape
      records.push(
        textShape({
          id: text.id,
          sourceId: text.id,
          x: text.x,
          y: text.y,
          width: text.width ?? Math.max(8, text.text.length * (text.fontSize ?? 24) * 0.58),
          text: text.text,
          tone: text.tone ?? "neutral",
          size: tldrawSize(text.fontSize),
          align: text.align ?? "start",
          index: generatedIndex,
          ...(text.opacity === undefined ? {} : { opacity: text.opacity }),
        }),
      )
      continue
    }

    const line = shape as LineShape
    records.push({
      ...baseShape(line, generatedIndex),
      type: "line",
      props: {
        dash: "solid",
        size: (line.strokeWidth ?? 3) >= 4 ? "l" : "m",
        color: tldrawColors[line.tone ?? "neutral"],
        spline: "line",
        points: {
          a1: { id: "a1", index: "a1", x: 0, y: 0 },
          a2: {
            id: "a2",
            index: "a2",
            x: line.x2 - line.x,
            y: line.y2 - line.y,
          },
        },
        scale: 1,
      },
    })
  }

  for (const edge of spec.edges ?? []) {
    const resolved = resolveEdge(spec, edge)
    generatedIndex += 1
    const arrowId = shapeId(edge.id)
    records.push({
      x: resolved.start.x,
      y: resolved.start.y,
      rotation: 0,
      isLocked: false,
      opacity: 1,
      meta: shapeMeta(edge.id),
      id: arrowId,
      type: "arrow",
      props: {
        kind: "arc",
        elbowMidPoint: 0.5,
        dash: "solid",
        size: "m",
        fill: "none",
        color: tldrawColors[edge.tone ?? "neutral"],
        labelColor: tldrawColors[edge.tone ?? "neutral"],
        bend: edge.bend ?? 0,
        start: { x: 0, y: 0 },
        end: {
          x: resolved.end.x - resolved.start.x,
          y: resolved.end.y - resolved.start.y,
        },
        arrowheadStart: "none",
        arrowheadEnd: edge.arrowhead ?? "arrow",
        richText: richText(edge.label ?? ""),
        labelPosition: 0.5,
        font: "sans",
        scale: 1,
      },
      parentId: "page:page",
      index: indexKey(generatedIndex),
      typeName: "shape",
    })
    records.push(
      {
        meta: {},
        id: `binding:${edge.id}-start`,
        fromId: arrowId,
        toId: shapeId(edge.from),
        type: "arrow",
        props: {
          isPrecise: false,
          isExact: false,
          normalizedAnchor: resolved.start.normalized,
          snap: "none",
          terminal: "start",
        },
        typeName: "binding",
      },
      {
        meta: {},
        id: `binding:${edge.id}-end`,
        fromId: arrowId,
        toId: shapeId(edge.to),
        type: "arrow",
        props: {
          isPrecise: false,
          isExact: false,
          normalizedAnchor: resolved.end.normalized,
          snap: "none",
          terminal: "end",
        },
        typeName: "binding",
      },
    )
  }

  return `${JSON.stringify({ tldrawFileFormatVersion: 1, schema, records }, null, 2)}\n`
}
