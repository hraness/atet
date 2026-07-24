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
