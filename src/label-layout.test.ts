import { describe, expect, test } from "bun:test"
import { layoutBoxContent, wrapDiagramText } from "./label-layout.ts"
import type { BoxShape } from "./types.ts"

describe("box label layout", () => {
  test("centers an icon and mixed-type label rows as one measured block", () => {
    const shape: BoxShape = {
      id: "ontology-record",
      type: "rect",
      x: 100,
      y: 50,
      width: 240,
      height: 160,
      icon: "database",
      labelRowGap: 8,
      labelRows: [
        { text: "ENTITY", fontSize: 14, fontFamily: "mono", weight: 700 },
        { text: "Aβ*56 assembly", fontSize: 20, weight: 500 },
      ],
    }

    const layout = layoutBoxContent(shape, 40)
    expect(layout.icon).toEqual({ x: 200, y: 77.05, size: 40 })
    expect(layout.rows).toHaveLength(2)
    expect(layout.rows[0]).toMatchObject({ fontFamily: "mono", fontSize: 14, weight: 700 })
    expect(layout.rows[0]?.height).toBeCloseTo(18.9)
    expect(layout.rows[0]?.y).toBeCloseTo(129.05)
    expect(layout.rows[1]).toMatchObject({ fontFamily: "default", fontSize: 20, weight: 500 })
    expect(layout.rows[1]?.height).toBeCloseTo(27)
    expect(layout.rows[1]?.y).toBeCloseTo(155.95)
    const contentTop = layout.icon?.y ?? 0
    const finalRow = layout.rows.at(-1)
    const contentBottom = (finalRow?.y ?? 0) + (finalRow?.height ?? 0)
    expect(contentTop - shape.y).toBeCloseTo(shape.y + shape.height - contentBottom)
  })

  test("uses a wider character measure for mono wrapping", () => {
    const text = "alpha beta xx gamma"
    expect(wrapDiagramText(text, 120, 16, "default")).toEqual([
      "alpha beta xx",
      "gamma",
    ])
    expect(wrapDiagramText(text, 120, 16, "mono")).toEqual([
      "alpha beta",
      "xx gamma",
    ])
  })
})
