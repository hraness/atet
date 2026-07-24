import { describe, expect, test } from "bun:test"
import { DiagramValidationError, parseDiagramSpec } from "./parse.ts"

const valid = {
  version: 1,
  name: "small-flow",
  canvas: { width: 900, height: 500 },
  shapes: [
    { id: "a", type: "rect", x: 40, y: 120, width: 220, height: 140, label: "A" },
    { id: "b", type: "rect", x: 620, y: 120, width: 220, height: 140, label: "B" },
  ],
  edges: [{ id: "a-b", from: "a", to: "b" }],
}

describe("parseDiagramSpec", () => {
  test("parses a checked discriminated specification", () => {
    const parsed = parseDiagramSpec(valid)
    expect(parsed.name).toBe("small-flow")
    expect(parsed.shapes).toHaveLength(2)
    expect(parsed.edges).toHaveLength(1)
  })

  test("rejects unknown keys and unresolved relationships", () => {
    expect(() =>
      parseDiagramSpec({
        ...valid,
        title: "Invented",
        edges: [{ id: "a-c", from: "a", to: "c" }],
      }),
    ).toThrow(DiagramValidationError)
    try {
      parseDiagramSpec({
        ...valid,
        title: "Invented",
        edges: [{ id: "a-c", from: "a", to: "c" }],
      })
    } catch (error) {
      expect(error).toBeInstanceOf(DiagramValidationError)
      expect((error as DiagramValidationError).issues).toContain("root.title is not supported")
      expect((error as DiagramValidationError).issues).toContain(
        "edge a-c has unknown or non-connectable to id c",
      )
    }
  })

  test("rejects duplicate semantic ids", () => {
    expect(() =>
      parseDiagramSpec({
        ...valid,
        edges: [{ id: "a", from: "a", to: "b" }],
      }),
    ).toThrow(/edge id a is duplicated/)
  })
})
