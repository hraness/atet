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

  test("parses a positive label font size on positioned boxes", () => {
    const parsed = parseDiagramSpec({
      ...valid,
      shapes: valid.shapes.map((shape, index) =>
        index === 0 ? { ...shape, labelFontSize: 16 } : shape,
      ),
    })

    expect(parsed.shapes[0]).toMatchObject({ labelFontSize: 16 })
  })

  test("rejects a non-positive box label font size", () => {
    try {
      parseDiagramSpec({
        ...valid,
        shapes: valid.shapes.map((shape, index) =>
          index === 0 ? { ...shape, labelFontSize: 0 } : shape,
        ),
      })
      throw new Error("expected box label parsing to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(DiagramValidationError)
      expect((error as DiagramValidationError).issues).toContain(
        "shapes[0].labelFontSize must be greater than zero",
      )
    }
  })

  test("parses mixed box rows, mono text, edge label styles, and distinct ports", () => {
    const parsed = parseDiagramSpec({
      ...valid,
      shapes: [
        {
          ...valid.shapes[0],
          label: undefined,
          labelRows: [
            { text: "ENTITY", fontSize: 15, fontFamily: "mono", weight: 700 },
            { text: "Aβ*56 assembly", fontSize: 20, weight: 500 },
          ],
          labelRowGap: 7,
        },
        { ...valid.shapes[1], label: "B", labelFontFamily: "mono" },
        {
          id: "caption",
          type: "text",
          x: 320,
          y: 40,
          text: "typed relation",
          fontFamily: "mono",
        },
      ],
      edges: [
        {
          id: "a-b",
          from: "a",
          to: "b",
          label: "supports",
          labelFontSize: 19,
          labelFontFamily: "mono",
          labelWeight: 700,
          labelPosition: 0.42,
          labelOffset: -18,
          startPosition: 0.3,
          endPosition: 0.7,
        },
      ],
    })

    expect(parsed.shapes[0]).toMatchObject({ labelRowGap: 7 })
    expect(parsed.shapes[0]).toHaveProperty("labelRows.0.fontFamily", "mono")
    expect(parsed.shapes[0]).toHaveProperty("labelRows.0.text", "ENTITY")
    expect(parsed.shapes[0]).toHaveProperty("labelRows.0.weight", 700)
    expect(parsed.shapes[2]).toMatchObject({ fontFamily: "mono" })
    expect(parsed.edges?.[0]).toMatchObject({
      endPosition: 0.7,
      labelFontFamily: "mono",
      labelOffset: -18,
      startPosition: 0.3,
    })
  })

  test("rejects empty or conflicting rows and orphaned label styling", () => {
    try {
      parseDiagramSpec({
        ...valid,
        shapes: [
          { ...valid.shapes[0], labelRows: [] },
          {
            id: "unstyled",
            type: "rect",
            x: 620,
            y: 120,
            width: 220,
            height: 140,
            labelFontFamily: "mono",
            labelRowGap: 4,
          },
        ],
        edges: [
          {
            id: "a-b",
            from: "a",
            to: "unstyled",
            labelFontSize: 18,
            startPosition: -0.1,
            endPosition: 1.1,
          },
        ],
      })
      throw new Error("expected rich label parsing to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(DiagramValidationError)
      const issues = (error as DiagramValidationError).issues
      expect(issues).toContain("shapes[0].labelRows must contain between 1 and 4 rows")
      expect(issues).toContain("shapes[0].label and shapes[0].labelRows are mutually exclusive")
      expect(issues).toContain("shapes[1] cannot style a label that is not present")
      expect(issues).toContain("shapes[1].labelRowGap requires labelRows")
      expect(issues).toContain("edges[0].startPosition must be zero or greater")
      expect(issues).toContain("edges[0].endPosition must not exceed 1")
      expect(issues).toContain("edges[0] cannot style or position a label that is not present")
    }
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
        {
          id: "a",
          type: "rect",
          width: 180,
          height: 100,
          label: "Alpha",
          labelFontSize: 16,
        },
        { id: "b", type: "ellipse", width: 180, height: 100 },
      ],
      edges: [{ id: "a-b", from: "a", to: "b" }],
    })

    expect("layout" in source).toBe(true)
    expect(source.shapes[0]).not.toHaveProperty("x")
    expect(parseDiagramSpec(source).shapes).toEqual([
      {
        id: "a",
        type: "rect",
        x: 190,
        y: 150,
        width: 180,
        height: 100,
        label: "Alpha",
        labelFontSize: 16,
      },
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
