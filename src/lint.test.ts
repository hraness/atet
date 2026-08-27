import { describe, expect, test } from "bun:test"
import { lintDiagram } from "./lint.ts"
import { parseDiagramSpec } from "./parse.ts"

describe("diagram lint", () => {
  test("finds overflowing rich labels and shared fan-in ports", () => {
    const spec = parseDiagramSpec({
      version: 1,
      name: "lint-rich-layout",
      canvas: { width: 900, height: 500 },
      shapes: [
        { id: "a", type: "rect", x: 20, y: 40, width: 180, height: 100 },
        { id: "b", type: "rect", x: 20, y: 340, width: 180, height: 100 },
        {
          id: "target",
          type: "rect",
          x: 620,
          y: 190,
          width: 220,
          height: 80,
          icon: "database",
          labelRows: [
            { text: "ONTOLOGY", fontSize: 24, fontFamily: "mono" },
            { text: "A deliberately tall detail row", fontSize: 30 },
          ],
        },
      ],
      edges: [
        { id: "a-target", from: "a", to: "target", end: "left" },
        { id: "b-target", from: "b", to: "target", end: "left" },
      ],
    })

    expect(lintDiagram(spec)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "label-overflow", shapeIds: ["target"] }),
        expect.objectContaining({ code: "shared-edge-port", shapeIds: ["target"] }),
      ]),
    )
  })

  test("accepts distributed fan-in ports", () => {
    const spec = parseDiagramSpec({
      version: 1,
      name: "lint-distributed-ports",
      canvas: { width: 900, height: 500 },
      shapes: [
        { id: "a", type: "rect", x: 20, y: 40, width: 180, height: 100 },
        { id: "b", type: "rect", x: 20, y: 340, width: 180, height: 100 },
        { id: "target", type: "rect", x: 620, y: 190, width: 220, height: 120 },
      ],
      edges: [
        { id: "a-target", from: "a", to: "target", end: "left", endPosition: 0.3 },
        { id: "b-target", from: "b", to: "target", end: "left", endPosition: 0.7 },
      ],
    })

    expect(lintDiagram(spec).some(({ code }) => code === "shared-edge-port")).toBe(false)
  })

  test("finds a single mono token that exceeds the available label width", () => {
    const spec = parseDiagramSpec({
      version: 1,
      name: "lint-horizontal-overflow",
      canvas: { width: 300, height: 200 },
      shapes: [
        {
          id: "identifier",
          type: "rect",
          x: 20,
          y: 40,
          width: 140,
          height: 120,
          labelRows: [
            {
              text: "ONE_UNBROKEN_IDENTIFIER",
              fontSize: 16,
              fontFamily: "mono",
            },
          ],
        },
      ],
    })

    expect(lintDiagram(spec)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "label-overflow", shapeIds: ["identifier"] }),
      ]),
    )
  })
})
