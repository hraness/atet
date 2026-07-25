import { describe, expect, test } from "bun:test"
import { resolveDiagramSource, resolveStackLayout, StackLayoutError } from "./layout.ts"
import { parseDiagramSource, parseDiagramSpec } from "./parse.ts"
import type { StackDiagramEdge, StackDiagramSource } from "./types.ts"

const invalidTypedStackEdge: StackDiagramEdge = {
  id: "invalid",
  from: "one",
  to: "two",
  // @ts-expect-error Stack layouts resolve anchors and do not accept explicit sides.
  start: "left",
}
void invalidTypedStackEdge

const horizontalSource = {
  version: 1,
  name: "horizontal-stack",
  canvas: { width: 1000, height: 400 },
  layout: { type: "stack", direction: "horizontal" },
  shapes: [
    { id: "one", type: "rect", width: 100, height: 100, label: "One" },
    { id: "two", type: "ellipse", width: 200, height: 200, label: "Two" },
  ],
  edges: [{ id: "one-two", from: "one", to: "two" }],
} as const satisfies StackDiagramSource

describe("resolveStackLayout", () => {
  test("applies the compact defaults and stamps horizontal edge anchors", () => {
    expect(resolveStackLayout(horizontalSource)).toEqual({
      version: 1,
      name: "horizontal-stack",
      canvas: { width: 1000, height: 400, padding: 64 },
      shapes: [
        {
          id: "one",
          type: "rect",
          x: 270,
          y: 150,
          width: 100,
          height: 100,
          label: "One",
        },
        {
          id: "two",
          type: "ellipse",
          x: 530,
          y: 100,
          width: 200,
          height: 200,
          label: "Two",
        },
      ],
      edges: [
        {
          id: "one-two",
          from: "one",
          to: "two",
          start: "right",
          end: "left",
          bend: 0,
        },
      ],
    })
  })

  test("lays out a vertical end-aligned stack and orients a reverse edge", () => {
    const resolved = resolveStackLayout({
      version: 1,
      name: "vertical-stack",
      canvas: { width: 500, height: 600, padding: 20 },
      layout: { type: "stack", direction: "vertical", gap: 25, align: "end" },
      shapes: [
        { id: "one", type: "rect", width: 100, height: 80 },
        { id: "two", type: "ellipse", width: 200, height: 120 },
      ],
      edges: [{ id: "two-one", from: "two", to: "one", start: "auto", end: "auto" }],
    })

    expect(resolved.shapes).toEqual([
      { id: "one", type: "rect", x: 380, y: 187.5, width: 100, height: 80 },
      { id: "two", type: "ellipse", x: 280, y: 292.5, width: 200, height: 120 },
    ])
    expect(resolved.edges).toEqual([
      {
        id: "two-one",
        from: "two",
        to: "one",
        start: "top",
        end: "bottom",
        bend: 0,
      },
    ])
  })

  test("quantizes generated positions without rewriting authored geometry", () => {
    const resolved = resolveStackLayout({
      version: 1,
      name: "fractional-stack",
      canvas: { width: 900.3333, height: 300.3333, padding: 20.1111 },
      layout: {
        type: "stack",
        direction: "horizontal",
        gap: 10.2222,
        align: "center",
      },
      shapes: [
        { id: "one", type: "rect", width: 100.1111, height: 80.1111 },
        { id: "two", type: "ellipse", width: 120.2222, height: 90.2222 },
      ],
    })

    expect(resolved.canvas).toEqual({
      width: 900.3333,
      height: 300.3333,
      padding: 20.1111,
    })
    expect(
      resolved.shapes.map((shape) => {
        if (shape.type !== "rect" && shape.type !== "ellipse") {
          throw new Error("expected a resolved box")
        }
        return [shape.width, shape.height]
      }),
    ).toEqual([
      [100.1111, 80.1111],
      [120.2222, 90.2222],
    ])
    expect(resolved.shapes.map(({ x, y }) => [x, y])).toEqual([
      [334.889, 110.111],
      [445.223, 105.056],
    ])
  })

  test("accepts a decimal exact fit in the emitted coordinate system", () => {
    const resolved = resolveStackLayout({
      version: 1,
      name: "decimal-exact-fit",
      canvas: { width: 0.3, height: 0.2, padding: 0 },
      layout: { type: "stack", direction: "horizontal", gap: 0 },
      shapes: [
        { id: "one", type: "rect", width: 0.1, height: 0.1 },
        { id: "two", type: "rect", width: 0.2, height: 0.1 },
      ],
    })

    expect(resolved.shapes).toEqual([
      { id: "one", type: "rect", x: 0, y: 0.05, width: 0.1, height: 0.1 },
      { id: "two", type: "rect", x: 0.1, y: 0.05, width: 0.2, height: 0.1 },
    ])
  })

  test("keeps near-boundary fractional geometry inside the emitted canvas", () => {
    const resolved = resolveStackLayout({
      version: 1,
      name: "fractional-boundary",
      canvas: { width: 1, height: 1, padding: 0 },
      layout: {
        type: "stack",
        direction: "horizontal",
        gap: 0,
        align: "end",
      },
      shapes: [
        { id: "one", type: "rect", width: 0.9996, height: 0.9994 },
      ],
    })
    const shape = resolved.shapes[0]
    expect(shape).toMatchObject({
      x: 0,
      y: 0,
      width: 0.9996,
      height: 0.9994,
    })
    if (shape === undefined) throw new Error("expected one resolved shape")
    expect(shape.x + ("width" in shape ? shape.width : 0)).toBeLessThanOrEqual(
      resolved.canvas.width,
    )
    expect(shape.y + ("height" in shape ? shape.height : 0)).toBeLessThanOrEqual(
      resolved.canvas.height,
    )
  })

  test("rejects geometry one quantized unit beyond the boundary", () => {
    expect(() =>
      resolveStackLayout({
        version: 1,
        name: "fractional-overflow",
        canvas: { width: 1, height: 1, padding: 0 },
        layout: { type: "stack", direction: "horizontal", gap: 0 },
        shapes: [
          { id: "one", type: "rect", width: 0.5004, height: 0.5 },
          { id: "two", type: "rect", width: 0.5006, height: 0.5 },
        ],
      }),
    ).toThrow(/horizontal stack needs 1.002px but only 1px remain/)
  })

  test("accepts one raw extent that exactly fits from a grid start", () => {
    const resolved = resolveStackLayout({
      version: 1,
      name: "sub-grid-exact-fit",
      canvas: { width: 400.0003, height: 100, padding: 0 },
      layout: { type: "stack", direction: "horizontal", gap: 0 },
      shapes: [
        { id: "one", type: "rect", width: 400.0003, height: 50 },
      ],
    })

    expect(resolved.shapes).toEqual([
      {
        id: "one",
        type: "rect",
        x: 0,
        y: 25,
        width: 400.0003,
        height: 50,
      },
    ])
  })

  test("rejects accumulated grid advances whose final raw extent overflows", () => {
    expect(() =>
      resolveStackLayout({
        version: 1,
        name: "accumulated-sub-grid-overflow",
        canvas: { width: 1000, height: 100, padding: 0 },
        layout: { type: "stack", direction: "horizontal", gap: 0 },
        shapes: [
          { id: "one", type: "rect", width: 400, height: 50 },
          { id: "two", type: "rect", width: 400.0003, height: 50 },
          { id: "three", type: "rect", width: 199.9995, height: 50 },
        ],
      }),
    ).toThrow(/horizontal stack needs 1000.001px but only 1000px remain/)
  })

  test("leaves matching free space before and after the main-axis sequence", () => {
    const resolved = resolveStackLayout(horizontalSource)
    const first = resolved.shapes[0]
    const last = resolved.shapes.at(-1)
    expect(first?.type).toBe("rect")
    expect(last?.type).toBe("ellipse")
    if (
      first === undefined ||
      last === undefined ||
      (first.type !== "rect" && first.type !== "ellipse") ||
      (last.type !== "rect" && last.type !== "ellipse")
    ) {
      throw new Error("expected a resolved box sequence")
    }

    const padding = resolved.canvas.padding ?? 0
    const leadingSpace = first.x - padding
    const trailingSpace =
      resolved.canvas.width - padding - (last.x + last.width)
    expect(leadingSpace).toBe(trailingSpace)
    expect(leadingSpace).toBe(206)
  })

  test("fails rather than shrinking shapes that do not fit", () => {
    const source = {
      ...horizontalSource,
      canvas: { width: 400, height: 180 },
    }
    expect(() => resolveStackLayout(source)).toThrow(StackLayoutError)
    try {
      resolveStackLayout(source)
    } catch (error) {
      expect(error).toBeInstanceOf(StackLayoutError)
      expect((error as StackLayoutError).issues).toEqual([
        "horizontal stack needs 460px but only 272px remain inside 64px padding",
        "shape one needs 100px on the cross axis but only 52px remain inside 64px padding",
        "shape two needs 200px on the cross axis but only 52px remain inside 64px padding",
      ])
    }
    expect(source.shapes[0]?.width).toBe(100)
    expect(source.shapes[1]?.height).toBe(200)
  })

  test("rejects invalid stack relationships at the direct API boundary", () => {
    const source = {
      version: 1,
      name: "invalid-direct-edges",
      canvas: { width: 800, height: 300, padding: 20 },
      layout: { type: "stack", direction: "horizontal", gap: 20 },
      shapes: [
        { id: "a", type: "rect", width: 100, height: 80 },
        { id: "b", type: "rect", width: 100, height: 80 },
        { id: "c", type: "rect", width: 100, height: 80 },
      ],
      edges: [
        { id: "skip", from: "a", to: "c" },
        {
          id: "a-b",
          from: "a",
          to: "b",
          start: "right",
          end: "left",
          bend: 0.25,
        },
        { id: "a-b", from: "b", to: "a" },
      ],
    } as unknown as StackDiagramSource

    try {
      resolveStackLayout(source)
      throw new Error("expected direct stack validation to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(StackLayoutError)
      expect((error as StackLayoutError).issues).toEqual([
        "edge skip must connect adjacent stack shapes",
        "edge a-b.start must be auto or omitted in a stack layout",
        "edge a-b.end must be auto or omitted in a stack layout",
        "edge a-b.bend must be 0 or omitted in a stack layout",
        "edge id a-b is duplicated",
        "edge a-b duplicates a connection between the same stack shapes",
      ])
    }
  })

  test("resolves authored sources and preserves positioned specifications unchanged", () => {
    const authored = parseDiagramSource(horizontalSource)
    expect(resolveDiagramSource(authored)).toEqual(parseDiagramSpec(horizontalSource))

    const positioned = parseDiagramSpec({
      version: 1,
      name: "positioned",
      canvas: { width: 200, height: 200 },
      shapes: [{ id: "one", type: "rect", x: 10, y: 20, width: 80, height: 60 }],
    })
    expect(resolveDiagramSource(positioned)).toBe(positioned)
  })

  test("keeps the coordinate-free example executable", async () => {
    const source = await Bun.file(
      new URL("../examples/semantic-flow.diagram.json", import.meta.url),
    ).json()
    const resolved = parseDiagramSpec(source)

    expect(resolved.name).toBe("semantic-flow")
    expect(resolved.shapes).toHaveLength(3)
    expect(resolved.edges?.map(({ start, end }) => [start, end])).toEqual([
      ["right", "left"],
      ["right", "left"],
    ])
  })
})
