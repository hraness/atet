import { describe, expect, test } from "bun:test"
import { createTLSchema, parseTldrawJsonFile } from "tldraw"
import { builtInIcons } from "./icons.ts"
import { sanitizeIcon } from "./icons.ts"
import { parseDiagramSpec } from "./parse.ts"
import { renderPng, renderSvg, resolveEdge, resolveEdgeLabel } from "./render.ts"
import { serializeTldr } from "./tldr.ts"

const spec = parseDiagramSpec({
  version: 1,
  name: "headless-flow",
  canvas: { width: 1000, height: 500 },
  shapes: [
    {
      id: "source",
      type: "rect",
      x: 80,
      y: 140,
      width: 240,
      height: 180,
      radius: 24,
      label: "Source",
      icon: "document",
      tone: "blue",
    },
    {
      id: "result",
      type: "rect",
      x: 680,
      y: 140,
      width: 240,
      height: 180,
      radius: 24,
      label: "Result",
      icon: "check",
      tone: "green",
    },
  ],
  edges: [{ id: "source-result", from: "source", to: "result" }],
})

const config = { icons: builtInIcons }

const sizedLabelSpec = parseDiagramSpec({
  version: 1,
  name: "sized-box-labels",
  canvas: { width: 700, height: 440 },
  shapes: [
    {
      id: "evidence",
      type: "rect",
      x: 80,
      y: 120,
      width: 240,
      height: 180,
      label: "Evidence\npacket",
      labelFontSize: 16,
      icon: "document",
      tone: "blue",
    },
    {
      id: "review",
      type: "rect",
      x: 420,
      y: 150,
      width: 200,
      height: 120,
      label: "Review queue",
      labelFontSize: 22,
      tone: "green",
    },
  ],
})

const richLabelSpec = parseDiagramSpec({
  version: 1,
  name: "rich-labels-and-ports",
  canvas: { width: 900, height: 400 },
  shapes: [
    {
      id: "source",
      type: "rect",
      x: 40,
      y: 110,
      width: 240,
      height: 180,
      icon: "database",
      tone: "purple",
      labelRows: [
        { text: "ENTITY", fontSize: 15, fontFamily: "mono", weight: 700 },
        { text: "Aβ*56 assembly", fontSize: 20, weight: 500 },
      ],
    },
    {
      id: "target",
      type: "rect",
      x: 620,
      y: 110,
      width: 240,
      height: 180,
      label: "Evidence packet",
    },
  ],
  edges: [
    {
      id: "source-target",
      from: "source",
      to: "target",
      start: "right",
      startPosition: 0.3,
      end: "left",
      endPosition: 0.7,
      bend: 40,
      label: "supports",
      labelFontSize: 20,
      labelFontFamily: "mono",
      labelWeight: 700,
      labelOffset: -18,
    },
  ],
})

const richLabelConfig = {
  font: { family: "Editorial Serif", monoFamily: "Interface Mono, monospace" },
  icons: builtInIcons,
}

describe("headless rendering", () => {
  test("creates rounded, theme-aware SVG without a bundled commercial font", async () => {
    const [light, dark] = await Promise.all([
      renderSvg(spec, "light", config),
      renderSvg(spec, "dark", config),
    ])
    expect(light.svg).toContain('rx="24"')
    expect(light.svg).toContain('data-edge-id="source-result"')
    expect(light.svg).not.toContain("MonoLisa")
    expect(light.svg).not.toBe(dark.svg)
  })

  test("creates a valid PNG", async () => {
    const light = await renderSvg(spec, "light", config)
    const png = renderPng(light, config, 1)
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  })

  test("applies a per-box label font size to SVG and tldraw", async () => {
    const light = await renderSvg(sizedLabelSpec, "light", config)
    expect(light.svg).toMatch(
      /font-size="16" font-weight="600"><tspan[^>]*>Evidence<\/tspan><tspan[^>]*>packet<\/tspan>/,
    )
    expect(light.svg).toMatch(
      /font-size="22" font-weight="600"><tspan[^>]*>Review queue<\/tspan>/,
    )

    const json = serializeTldr(sizedLabelSpec, config)
    const parsed = JSON.parse(json) as {
      readonly records: readonly {
        readonly id: string
        readonly props?: Readonly<Record<string, unknown>>
      }[]
    }
    const evidenceLabel = parsed.records.find(
      ({ id }) => id === "shape:atet:box-label:evidence:1",
    )
    const review = parsed.records.find(({ id }) => id === "shape:review")
    const reviewLabel = parsed.records.find(
      ({ id }) => id === "shape:atet:box-label:review:1",
    )

    expect(evidenceLabel?.props?.size).toBe("s")
    expect(evidenceLabel?.props?.scale).toBeCloseTo(16 / 18)
    expect(
      Number(evidenceLabel?.props?.w) * Number(evidenceLabel?.props?.scale),
    ).toBeCloseTo(208)
    expect(review?.props?.richText).toEqual({ type: "doc", content: [{ type: "paragraph" }] })
    expect(reviewLabel?.props?.size).toBe("m")
    expect(reviewLabel?.props?.scale).toBeCloseTo(22 / 24)
    expect(evidenceLabel?.props?.richText).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Evidence", marks: [{ type: "bold" }] }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "packet", marks: [{ type: "bold" }] }],
        },
      ],
    })

    const result = parseTldrawJsonFile({ json, schema: createTLSchema() })
    if (!result.ok) throw new Error(JSON.stringify(result.error))
    result.value.dispose()
  })

  test("renders mixed label rows, mono predicates, and separated edge ports", async () => {
    const light = await renderSvg(richLabelSpec, "light", richLabelConfig)
    expect(light.svg).toContain('font-family="Interface Mono, monospace" font-size="15"')
    expect(light.svg).toContain('font-family="Editorial Serif" font-size="20"')
    expect(light.svg).toContain('font-family="Interface Mono, monospace" font-size="20"')

    const json = serializeTldr(richLabelSpec, richLabelConfig)
    const serialized = JSON.parse(json) as {
      readonly records: readonly {
        readonly id: string
        readonly props?: Readonly<Record<string, unknown>>
      }[]
    }
    const kind = serialized.records.find(
      ({ id }) => id === "shape:atet:box-label:source:1",
    )
    const relation = serialized.records.find(
      ({ id }) => id === "shape:atet:edge-label:source-target",
    )
    const arrow = serialized.records.find(({ id }) => id === "shape:source-target")
    const startBinding = serialized.records.find(({ id }) => id === "binding:source-target-start")
    const endBinding = serialized.records.find(({ id }) => id === "binding:source-target-end")
    expect(kind?.props).toMatchObject({ font: "mono", scale: 15 / 18 })
    expect(relation?.props).toMatchObject({ font: "mono", scale: 20 / 18 })
    expect(arrow?.props?.bend).toBe(20)
    expect(startBinding?.props).toMatchObject({
      isPrecise: true,
      normalizedAnchor: { x: 1, y: 0.3 },
    })
    expect(endBinding?.props).toMatchObject({
      isPrecise: true,
      normalizedAnchor: { x: 0, y: 0.7 },
    })

    const result = parseTldrawJsonFile({ json, schema: createTLSchema() })
    if (!result.ok) throw new Error(JSON.stringify(result.error))
    result.value.dispose()
  })

  test("keeps bend magnitude compatible while matching tldraw at the visible midpoint", () => {
    const bent = parseDiagramSpec({
      version: 1,
      name: "bend-semantics",
      canvas: { width: 400, height: 160 },
      shapes: [
        { id: "a", type: "rect", x: 0, y: 0, width: 100, height: 100 },
        { id: "b", type: "rect", x: 300, y: 0, width: 100, height: 100 },
      ],
      edges: [{ id: "a-b", from: "a", to: "b", bend: 40, label: "relation", labelOffset: 0 }],
    })
    const sourceEdge = bent.edges?.[0]
    if (sourceEdge === undefined) throw new Error("expected one bend-semantics edge")
    const edge = resolveEdge(bent, sourceEdge)
    expect(edge.control).toEqual({ x: 200, y: 90 })
    expect(resolveEdgeLabel(edge)).toEqual({ x: 200, y: 70 })

    const json = JSON.parse(serializeTldr(bent, {})) as {
      readonly records: readonly { readonly id: string; readonly props?: { readonly bend?: number } }[]
    }
    expect(json.records.find(({ id }) => id === "shape:a-b")?.props?.bend).toBe(20)
  })

  test("keeps maximal rich stack interchange valid beyond 61 records", () => {
    const shapes = Array.from({ length: 9 }, (_, index) => ({
      id: `box-${index}`,
      type: "rect",
      x: index * 180,
      y: 80,
      width: 140,
      height: 220,
      icon: "database",
      labelRows: [
        { text: "TYPE", fontFamily: "mono", fontSize: 12 },
        { text: `Row ${index} A`, fontSize: 12 },
        { text: `Row ${index} B`, fontSize: 12 },
        { text: `Row ${index} C`, fontSize: 12 },
      ],
    }))
    const large = parseDiagramSpec({
      version: 1,
      name: "large-rich-interchange",
      canvas: { width: 1600, height: 380 },
      shapes,
      edges: shapes.slice(1).map((shape, index) => ({
        id: `edge-${index}`,
        from: shapes[index]!.id,
        to: shape.id,
        label: "next",
        labelFontFamily: "mono",
      })),
    })
    const json = serializeTldr(large, { icons: builtInIcons })
    expect(json).toContain('"index": "b00"')
    const result = parseTldrawJsonFile({ json, schema: createTLSchema() })
    if (!result.ok) throw new Error(JSON.stringify(result.error))
    result.value.dispose()
  })

  test("namespaces generated labels away from valid authored ids", () => {
    const collisionSpec = parseDiagramSpec({
      version: 1,
      name: "generated-id-namespace",
      canvas: { width: 760, height: 260 },
      shapes: [
        {
          id: "a",
          type: "rect",
          x: 0,
          y: 60,
          width: 140,
          height: 140,
          labelRows: [{ text: "TYPE", fontFamily: "mono" }, { text: "A" }],
        },
        {
          id: "a-label",
          type: "rect",
          x: 200,
          y: 60,
          width: 140,
          height: 140,
          label: "Authored box",
        },
        {
          id: "b",
          type: "rect",
          x: 400,
          y: 60,
          width: 140,
          height: 140,
          label: "B",
        },
        {
          id: "edge-label",
          type: "rect",
          x: 600,
          y: 60,
          width: 140,
          height: 140,
          label: "Another box",
        },
      ],
      edges: [{ id: "edge", from: "a", to: "b", label: "relation" }],
    })
    const json = serializeTldr(collisionSpec, {})
    const serialized = JSON.parse(json) as {
      readonly records: readonly { readonly id: string; readonly typeName: string }[]
    }
    expect(new Set(serialized.records.map(({ id }) => id)).size).toBe(
      serialized.records.length,
    )
    expect(serialized.records.some(({ id }) => id === "shape:a-label")).toBe(true)
    expect(
      serialized.records.some(({ id }) => id === "shape:atet:box-label:a:1"),
    ).toBe(true)
    expect(serialized.records.some(({ id }) => id === "shape:edge-label")).toBe(true)
    expect(
      serialized.records.some(({ id }) => id === "shape:atet:edge-label:edge"),
    ).toBe(true)

    const result = parseTldrawJsonFile({ json, schema: createTLSchema() })
    if (!result.ok) throw new Error(JSON.stringify(result.error))
    expect(result.value.allRecords().filter(({ typeName }) => typeName === "shape")).toHaveLength(8)
    result.value.dispose()
  })

  test("rejects executable and externally loaded icon content", () => {
    expect(() =>
      sanitizeIcon({
        viewBox: "0 0 24 24",
        body: '<image href="https://example.com/tracker.png"/>',
      }),
    ).toThrow(/executable or externally embedded/)
  })

  test("creates tldraw interchange accepted by the official parser", () => {
    const json = serializeTldr(spec, config)
    const result = parseTldrawJsonFile({ json, schema: createTLSchema() })
    if (!result.ok) throw new Error(JSON.stringify(result.error))
    const records = result.value.allRecords()
    expect(records.filter((record) => record.typeName === "shape")).toHaveLength(7)
    expect(records.filter((record) => record.typeName === "binding")).toHaveLength(2)
    expect(records.filter((record) => record.typeName === "asset")).toHaveLength(2)
    result.value.dispose()
  })
})
