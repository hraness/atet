import { expect, test } from "bun:test"
import fc from "fast-check"
import { parseDiagramSpec } from "./parse.ts"
import { serializeTldr } from "./tldr.ts"

test("tldr serialization is deterministic for finite box layouts", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          x: fc.integer({ min: 0, max: 1600 }),
          y: fc.integer({ min: 0, max: 900 }),
          width: fc.integer({ min: 120, max: 400 }),
          height: fc.integer({ min: 64, max: 240 }),
          labelFontSize: fc.option(fc.integer({ min: 8, max: 64 }), {
            nil: undefined,
          }),
        }),
        { minLength: 1, maxLength: 20 },
      ),
      (boxes) => {
        const spec = parseDiagramSpec({
          version: 1,
          name: "generated-layout",
          canvas: { width: 2200, height: 1400 },
          shapes: boxes.map((box, index) => ({
            id: `box-${index}`,
            type: "rect",
            ...box,
            label: `Box ${index}`,
          })),
        })
        expect(serializeTldr(spec, {})).toBe(serializeTldr(spec, {}))
      },
    ),
    { numRuns: 100 },
  )
})

test("tldr serialization is deterministic for mixed box label rows", () => {
  const row = fc.record({
    text: fc.string({ minLength: 1, maxLength: 40 }),
    fontSize: fc.integer({ min: 8, max: 40 }),
    fontFamily: fc.constantFrom("default", "mono"),
    weight: fc.constantFrom(400, 500, 600, 700),
  })
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          x: fc.integer({ min: 0, max: 1600 }),
          y: fc.integer({ min: 0, max: 900 }),
          width: fc.integer({ min: 120, max: 400 }),
          height: fc.integer({ min: 80, max: 280 }),
          labelRows: fc.array(row, { minLength: 1, maxLength: 4 }),
          labelRowGap: fc.integer({ min: 0, max: 24 }),
        }),
        { minLength: 1, maxLength: 8 },
      ),
      (boxes) => {
        const spec = parseDiagramSpec({
          version: 1,
          name: "generated-rich-layout",
          canvas: { width: 2200, height: 1400 },
          shapes: boxes.map((box, index) => ({
            id: `box-${index}`,
            type: "rect",
            ...box,
          })),
        })
        expect(serializeTldr(spec, {})).toBe(serializeTldr(spec, {}))
      },
    ),
    { numRuns: 100 },
  )
})
