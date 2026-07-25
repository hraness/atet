import { describe, expect, test } from "bun:test"
import {
  DiagramValidationError,
  parseDiagramSource,
  parseDiagramSpec,
} from "./parse.ts"

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

  test("parses a coordinate-free stack source before resolving it", () => {
    const source = parseDiagramSource({
      version: 1,
      name: "stack-source",
      canvas: { width: 900, height: 400 },
      layout: { type: "stack", direction: "horizontal" },
      shapes: [
        { id: "a", type: "rect", width: 180, height: 100 },
        { id: "b", type: "ellipse", width: 180, height: 100 },
      ],
      edges: [{ id: "a-b", from: "a", to: "b" }],
    })

    expect("layout" in source).toBe(true)
    expect(source.shapes[0]).not.toHaveProperty("x")
    expect(parseDiagramSpec(source).shapes).toEqual([
      { id: "a", type: "rect", x: 190, y: 150, width: 180, height: 100 },
      { id: "b", type: "ellipse", x: 530, y: 150, width: 180, height: 100 },
    ])
  })

  test("rejects coordinates and non-box shapes in a stack source", () => {
    try {
      parseDiagramSource({
        version: 1,
        name: "invalid-stack",
        canvas: { width: 900, height: 400 },
        layout: { type: "stack", direction: "horizontal" },
        shapes: [
          { id: "a", type: "rect", x: 20, y: 20, width: 180, height: 100 },
          { id: "label", type: "text", width: 180, height: 100, text: "No" },
        ],
      })
      throw new Error("expected stack parsing to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(DiagramValidationError)
      expect((error as DiagramValidationError).issues).toContain(
        "shapes[0].x is not supported",
      )
      expect((error as DiagramValidationError).issues).toContain(
        "shapes[0].y is not supported",
      )
      expect((error as DiagramValidationError).issues).toContain(
        "shapes[1].type must be rect or ellipse in a stack layout",
      )
    }
  })

  test("bounds stack complexity at one through nine shapes", () => {
    const common = {
      version: 1,
      name: "bounded-stack",
      canvas: { width: 5000, height: 400 },
      layout: { type: "stack", direction: "horizontal", gap: 0 },
    }
    expect(() => parseDiagramSource({ ...common, shapes: [] })).toThrow(
      /between 1 and 9 shapes/,
    )
    expect(() =>
      parseDiagramSource({
        ...common,
        shapes: Array.from({ length: 10 }, (_, index) => ({
          id: `shape-${index}`,
          type: "rect",
          width: 100,
          height: 100,
        })),
      }),
    ).toThrow(/between 1 and 9 shapes/)
  })

  test("permits only one straight explicit edge per adjacent stack pair", () => {
    const source = {
      version: 1,
      name: "checked-stack-edges",
      canvas: { width: 1200, height: 400 },
      layout: { type: "stack", direction: "horizontal" },
      shapes: [
        { id: "a", type: "rect", width: 100, height: 100 },
        { id: "b", type: "rect", width: 100, height: 100 },
        { id: "c", type: "rect", width: 100, height: 100 },
      ],
    }
    try {
      parseDiagramSource({
        ...source,
        edges: [
          { id: "skip", from: "a", to: "c", start: "right", bend: 20 },
          { id: "a-b", from: "a", to: "b" },
          { id: "b-a", from: "b", to: "a" },
        ],
      })
      throw new Error("expected stack edge parsing to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(DiagramValidationError)
      const issues = (error as DiagramValidationError).issues
      expect(issues).toContain("edge skip must connect adjacent stack shapes")
      expect(issues).toContain(
        "edge skip.start must be auto or omitted in a stack layout",
      )
      expect(issues).toContain("edge skip.bend must be 0 or omitted in a stack layout")
      expect(issues).toContain(
        "edge b-a duplicates a connection between the same stack shapes",
      )
    }
  })
})
