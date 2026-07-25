import { expect, test } from "bun:test"
import fc from "fast-check"
import { resolveStackLayout } from "./layout.ts"
import type {
  BoxShape,
  StackAlign,
  StackDiagramSource,
  StackDirection,
} from "./types.ts"

const shapeArbitrary = fc.record({
  width: fc.integer({ min: 48, max: 320 }),
  height: fc.integer({ min: 48, max: 240 }),
  type: fc.constantFrom<"rect" | "ellipse">("rect", "ellipse"),
})

test("stack resolution is deterministic, bounded, ordered, and dimension preserving", () => {
  fc.assert(
    fc.property(
      fc.constantFrom<StackDirection>("horizontal", "vertical"),
      fc.constantFrom<StackAlign>("start", "center", "end"),
      fc.integer({ min: 0, max: 240 }),
      fc.integer({ min: 0, max: 120 }),
      fc.array(shapeArbitrary, { minLength: 1, maxLength: 9 }),
      (direction, align, gap, padding, generatedShapes) => {
        const horizontal = direction === "horizontal"
        const requiredMain =
          generatedShapes.reduce(
            (total, shape) => total + (horizontal ? shape.width : shape.height),
            0,
          ) +
          gap * (generatedShapes.length - 1)
        const maximumCross = Math.max(
          ...generatedShapes.map((shape) => (horizontal ? shape.height : shape.width)),
        )
        const source = {
          version: 1,
          name: "generated-stack",
          canvas: {
            width: horizontal ? requiredMain + padding * 2 + 50 : maximumCross + padding * 2 + 50,
            height: horizontal ? maximumCross + padding * 2 + 50 : requiredMain + padding * 2 + 50,
            padding,
          },
          layout: { type: "stack", direction, gap, align },
          shapes: generatedShapes.map((shape, index) => ({
            id: `shape-${index}`,
            ...shape,
          })),
          edges: generatedShapes.slice(1).map((_, index) => ({
            id: `edge-${index}`,
            from: `shape-${index}`,
            to: `shape-${index + 1}`,
          })),
        } satisfies StackDiagramSource

        const first = resolveStackLayout(source)
        const second = resolveStackLayout(source)
        expect(first).toEqual(second)

        const resolvedShapes = first.shapes as readonly BoxShape[]
        for (const [index, shape] of resolvedShapes.entries()) {
          const original = source.shapes[index]
          expect(original).toBeDefined()
          expect(shape.width).toBe(original!.width)
          expect(shape.height).toBe(original!.height)
          expect(Number((shape.x * 1000).toFixed(6))).toBe(
            Math.round(shape.x * 1000),
          )
          expect(Number((shape.y * 1000).toFixed(6))).toBe(
            Math.round(shape.y * 1000),
          )
          expect(shape.x).toBeGreaterThanOrEqual(padding)
          expect(shape.y).toBeGreaterThanOrEqual(padding)
          expect(shape.x + shape.width).toBeLessThanOrEqual(source.canvas.width - padding)
          expect(shape.y + shape.height).toBeLessThanOrEqual(source.canvas.height - padding)

          const next = resolvedShapes[index + 1]
          if (next !== undefined) {
            if (horizontal) {
              expect(next.x).toBeGreaterThanOrEqual(shape.x + shape.width + gap - 0.001)
            } else {
              expect(next.y).toBeGreaterThanOrEqual(shape.y + shape.height + gap - 0.001)
            }
          }
        }

        const firstShape = resolvedShapes[0]
        const lastShape = resolvedShapes.at(-1)
        expect(firstShape).toBeDefined()
        expect(lastShape).toBeDefined()
        const leadingSpace = horizontal
          ? firstShape!.x - padding
          : firstShape!.y - padding
        const trailingSpace = horizontal
          ? source.canvas.width - padding - (lastShape!.x + lastShape!.width)
          : source.canvas.height - padding - (lastShape!.y + lastShape!.height)
        expect(Math.abs(leadingSpace - trailingSpace)).toBeLessThanOrEqual(0.001)
      },
    ),
    { numRuns: 200 },
  )
})

const fractionalShapeArbitrary = fc.record({
  width: fc.integer({ min: 480_001, max: 3_200_000 }).map((value) => value / 10_000),
  height: fc.integer({ min: 480_001, max: 2_400_000 }).map((value) => value / 10_000),
  type: fc.constantFrom<"rect" | "ellipse">("rect", "ellipse"),
})

test("fractional stacks preserve dimensions while emitted positions remain centered and bounded", () => {
  fc.assert(
    fc.property(
      fc.constantFrom<StackDirection>("horizontal", "vertical"),
      fc.constantFrom<StackAlign>("start", "center", "end"),
      fc.integer({ min: 0, max: 500_000 }).map((value) => value / 10_000),
      fc.integer({ min: 0, max: 250_000 }).map((value) => value / 10_000),
      fc.array(fractionalShapeArbitrary, { minLength: 1, maxLength: 5 }),
      (direction, align, gap, padding, generatedShapes) => {
        const horizontal = direction === "horizontal"
        const requiredMain =
          generatedShapes.reduce(
            (total, shape) =>
              total + (horizontal ? shape.width : shape.height),
            0,
          ) +
          gap * (generatedShapes.length - 1)
        const maximumCross = Math.max(
          ...generatedShapes.map((shape) =>
            horizontal ? shape.height : shape.width,
          ),
        )
        const source = {
          version: 1,
          name: "fractional-generated-stack",
          canvas: {
            width: horizontal
              ? requiredMain + padding * 2 + 50.1234
              : maximumCross + padding * 2 + 50.1234,
            height: horizontal
              ? maximumCross + padding * 2 + 50.1234
              : requiredMain + padding * 2 + 50.1234,
            padding,
          },
          layout: { type: "stack", direction, gap, align },
          shapes: generatedShapes.map((shape, index) => ({
            id: `shape-${index}`,
            ...shape,
          })),
        } satisfies StackDiagramSource

        const resolved = resolveStackLayout(source)
        const resolvedShapes = resolved.shapes as readonly BoxShape[]
        for (const [index, shape] of resolvedShapes.entries()) {
          const authored = source.shapes[index]
          expect(authored).toBeDefined()
          expect(shape.width).toBe(authored!.width)
          expect(shape.height).toBe(authored!.height)
          expect(Number((shape.x * 1000).toFixed(6))).toBe(
            Math.round(shape.x * 1000),
          )
          expect(Number((shape.y * 1000).toFixed(6))).toBe(
            Math.round(shape.y * 1000),
          )
          expect(shape.x).toBeGreaterThanOrEqual(padding)
          expect(shape.y).toBeGreaterThanOrEqual(padding)
          expect(shape.x + shape.width).toBeLessThanOrEqual(
            source.canvas.width - padding + 1e-12,
          )
          expect(shape.y + shape.height).toBeLessThanOrEqual(
            source.canvas.height - padding + 1e-12,
          )

          const next = resolvedShapes[index + 1]
          if (next !== undefined) {
            const actualGap = horizontal
              ? next.x - (shape.x + shape.width)
              : next.y - (shape.y + shape.height)
            expect(actualGap).toBeGreaterThanOrEqual(gap - 1e-12)
          }
        }

        const first = resolvedShapes[0]
        const last = resolvedShapes.at(-1)
        expect(first).toBeDefined()
        expect(last).toBeDefined()
        const leading = horizontal
          ? first!.x - padding
          : first!.y - padding
        const trailing = horizontal
          ? source.canvas.width - padding - (last!.x + last!.width)
          : source.canvas.height - padding - (last!.y + last!.height)
        expect(Math.abs(leading - trailing)).toBeLessThanOrEqual(
          0.001 + 1e-12,
        )
      },
    ),
    { numRuns: 100 },
  )
})
