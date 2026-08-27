import { sanitizeIcon } from "./icons.js"
import { layoutBoxContent } from "./label-layout.js"
import { resolveEdge, resolveEdgeLabel } from "./render.js"
import { resolveTheme } from "./theme.js"
import type {
  BoxShape,
  DiagramConfig,
  DiagramFontFamily,
  DiagramShape,
  DiagramSpec,
  IconDefinition,
  LineShape,
  TextShape,
  TextWeight,
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

function richText(text: string, weight: TextWeight = 400): Readonly<Record<string, unknown>> {
  return {
    type: "doc",
    content: text.split("\n").map((line) => ({
      type: "paragraph",
      ...(line === ""
        ? {}
        : {
            content: [
              {
                type: "text",
                text: line,
                ...(weight < 600 ? {} : { marks: [{ type: "bold" }] }),
              },
            ],
          }),
    })),
  }
}

function authoredShapeId(id: string): string {
  return `shape:${id}`
}

function generatedShapeId(kind: "box-icon" | "box-label" | "edge-label", id: string): string {
  return `shape:atet:${kind}:${id}`
}

function shapeMeta(sourceId: string): Readonly<Record<string, unknown>> {
  return { diagram: { version: 1, sourceId } }
}

function indexKey(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error(`A .tldr index must be a non-negative safe integer, received ${index}`)
  }
  const digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  let width = 1
  let remaining = index
  let capacity = digits.length
  while (remaining >= capacity) {
    remaining -= capacity
    width += 1
    capacity *= digits.length
    if (width > 26 || !Number.isSafeInteger(capacity)) {
      throw new Error("A .tldr export contains too many generated records")
    }
  }
  let suffix = ""
  for (let place = 0; place < width; place += 1) {
    suffix = `${digits[remaining % digits.length]}${suffix}`
    remaining = Math.floor(remaining / digits.length)
  }
  return `${String.fromCharCode("a".charCodeAt(0) + width - 1)}${suffix}`
}

function baseShape(shape: DiagramShape, index: number): TldrawRecord {
  return {
    x: shape.x,
    y: shape.y,
    rotation: 0,
    isLocked: false,
    opacity: shape.opacity ?? 1,
    meta: shapeMeta(shape.id),
    id: authoredShapeId(shape.id),
    parentId: "page:page",
    index: indexKey(index),
    typeName: "shape",
  }
}

function textShape(options: {
  readonly recordId: string
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
  readonly fontFamily?: DiagramFontFamily
  readonly weight?: TextWeight
}): TldrawRecord {
  return {
    x: options.x,
    y: options.y,
    rotation: 0,
    isLocked: false,
    opacity: options.opacity ?? 1,
    meta: shapeMeta(options.sourceId),
    id: options.recordId,
    type: "text",
    props: {
      color: tldrawColors[options.tone],
      size: options.size,
      w: options.width,
      font: options.fontFamily === "mono" ? "mono" : "sans",
      textAlign: options.align,
      autoSize: false,
      scale: options.scale ?? 1,
      richText: richText(options.text, options.weight),
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
        box.labelRows !== undefined ||
        (box.label !== undefined &&
          (hasIcon ||
            box.labelFontSize !== undefined ||
            box.labelFontFamily !== undefined ||
            box.labelWeight !== undefined))
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
          richText: richText(hasSeparateLabel ? "" : (box.label ?? ""), box.labelWeight),
        },
      })
      const iconSize = Math.min(box.iconSize ?? 52, box.height * 0.45, box.width * 0.32)
      const content = layoutBoxContent(box, hasIcon ? iconSize : undefined)
      if (box.icon !== undefined) {
        const icon = icons[box.icon]
        if (icon === undefined) throw new Error(`Unknown icon "${box.icon}" on shape ${box.id}`)
        if (content.icon === undefined) throw new Error(`Missing icon layout for shape ${box.id}`)
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
          x: content.icon.x,
          y: content.icon.y,
          rotation: 0,
          isLocked: false,
          opacity: box.opacity ?? 1,
          meta: shapeMeta(box.id),
          id: generatedShapeId("box-icon", box.id),
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
            altText:
              box.labelRows?.map((row) => row.text).join(" ") ?? box.label ?? box.icon,
          },
          parentId: "page:page",
          index: indexKey(generatedIndex),
          typeName: "shape",
        })
      }
      if (hasSeparateLabel) {
        for (const [rowIndex, row] of content.rows.entries()) {
          const textStyle = scaledTldrawSize(row.fontSize)
          generatedIndex += 1
          records.push(
            textShape({
              recordId: generatedShapeId("box-label", `${box.id}:${rowIndex + 1}`),
              sourceId: box.id,
              x: box.x + 16,
              y: row.y,
              width: Math.max(1, box.width - 32) / textStyle.scale,
              text: row.lines.join("\n"),
              tone: box.tone ?? "neutral",
              size: textStyle.size,
              align: "middle",
              index: generatedIndex,
              scale: textStyle.scale,
              fontFamily: row.fontFamily,
              weight: row.weight,
              ...(box.opacity === undefined ? {} : { opacity: box.opacity }),
            }),
          )
        }
      }
      continue
    }

    if (shape.type === "text") {
      const text = shape as TextShape
      const fontSize = text.fontSize ?? 24
      const textStyle = scaledTldrawSize(fontSize)
      const width = text.width ?? Math.max(8, text.text.length * fontSize * 0.58)
      records.push(
        textShape({
          recordId: authoredShapeId(text.id),
          sourceId: text.id,
          x: text.x,
          y: text.y,
          width: width / textStyle.scale,
          text: text.text,
          tone: text.tone ?? "neutral",
          size: textStyle.size,
          align: text.align ?? "start",
          index: generatedIndex,
          scale: textStyle.scale,
          ...(text.fontFamily === undefined ? {} : { fontFamily: text.fontFamily }),
          ...(text.weight === undefined ? {} : { weight: text.weight }),
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
    const arrowId = authoredShapeId(edge.id)
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
        bend: (edge.bend ?? 0) / 2,
        start: { x: 0, y: 0 },
        end: {
          x: resolved.end.x - resolved.start.x,
          y: resolved.end.y - resolved.start.y,
        },
        arrowheadStart: "none",
        arrowheadEnd: edge.arrowhead ?? "arrow",
        richText: richText(""),
        labelPosition: edge.labelPosition ?? 0.5,
        font: edge.labelFontFamily === "mono" ? "mono" : "sans",
        scale: 1,
      },
      parentId: "page:page",
      index: indexKey(generatedIndex),
      typeName: "shape",
    })
    if (edge.label !== undefined) {
      const labelPoint = resolveEdgeLabel(resolved)
      const fontSize = edge.labelFontSize ?? 18
      const fontFamily = edge.labelFontFamily ?? "default"
      const textStyle = scaledTldrawSize(fontSize)
      const widthRatio = fontFamily === "mono" ? 0.62 : 0.56
      const width = Math.max(fontSize, edge.label.length * fontSize * widthRatio)
      generatedIndex += 1
      records.push(
        textShape({
          recordId: generatedShapeId("edge-label", edge.id),
          sourceId: edge.id,
          x: labelPoint.x - width / 2,
          y: labelPoint.y - (fontSize * 1.35) / 2,
          width: width / textStyle.scale,
          text: edge.label,
          tone: edge.tone ?? "neutral",
          size: textStyle.size,
          align: "middle",
          index: generatedIndex,
          scale: textStyle.scale,
          fontFamily,
          weight: edge.labelWeight ?? 600,
        }),
      )
    }
    records.push(
      {
        meta: {},
        id: `binding:${edge.id}-start`,
        fromId: arrowId,
        toId: authoredShapeId(edge.from),
        type: "arrow",
        props: {
          isPrecise: edge.startPosition !== undefined,
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
        toId: authoredShapeId(edge.to),
        type: "arrow",
        props: {
          isPrecise: edge.endPosition !== undefined,
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
