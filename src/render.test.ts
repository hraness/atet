import { describe, expect, test } from "bun:test"
import { createTLSchema, parseTldrawJsonFile } from "tldraw"
import { builtInIcons } from "./icons.ts"
import { sanitizeIcon } from "./icons.ts"
import { parseDiagramSpec } from "./parse.ts"
import { renderPng, renderSvg } from "./render.ts"
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
    const evidenceLabel = parsed.records.find(({ id }) => id === "shape:evidence-label")
    const review = parsed.records.find(({ id }) => id === "shape:review")
    const reviewLabel = parsed.records.find(({ id }) => id === "shape:review-label")

    expect(evidenceLabel?.props?.size).toBe("s")
    expect(evidenceLabel?.props?.scale).toBeCloseTo(16 / 18)
    expect(
      Number(evidenceLabel?.props?.w) * Number(evidenceLabel?.props?.scale),
    ).toBeCloseTo(208)
    expect(review?.props?.richText).toEqual({ type: "doc", content: [{ type: "paragraph" }] })
    expect(reviewLabel?.props?.size).toBe("m")
    expect(reviewLabel?.props?.scale).toBeCloseTo(22 / 24)

    const result = parseTldrawJsonFile({ json, schema: createTLSchema() })
    if (!result.ok) throw new Error(JSON.stringify(result.error))
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
