import { expect, test } from "bun:test"
import fc from "fast-check"
import {
  dominantOklabDuotoneModel,
  normalizedPremultipliedRmse,
  sanitizedTraceRgba,
} from "./metrics.ts"

const rgbaArbitrary = fc
  .uint8Array({ maxLength: 512, minLength: 4 })
  .filter((bytes) => bytes.length % 4 === 0)

test("trace sanitation is idempotent and preserves retained pixels", () => {
  fc.assert(
    fc.property(
      rgbaArbitrary,
      fc.integer({ max: 64, min: 1 }),
      (rgba, cutoff) => {
        const sanitized = sanitizedTraceRgba(rgba, cutoff)
        expect(sanitizedTraceRgba(sanitized, cutoff)).toEqual(sanitized)
        for (let index = 0; index < rgba.length; index += 4) {
          if (rgba[index + 3]! < cutoff) {
            expect([...sanitized.slice(index, index + 4)]).toEqual([0, 0, 0, 0])
          } else {
            expect(sanitized.slice(index, index + 4)).toEqual(
              rgba.slice(index, index + 4),
            )
          }
        }
      },
    ),
    { numRuns: 100 },
  )
})

test("fully transparent RGB cannot affect premultiplied fidelity", () => {
  fc.assert(
    fc.property(
      fc.tuple(fc.nat(255), fc.nat(255), fc.nat(255)),
      fc.tuple(fc.nat(255), fc.nat(255), fc.nat(255)),
      (left, right) => {
        const source = Uint8Array.from([...left, 0])
        const candidate = Uint8Array.from([...right, 0])
        expect(normalizedPremultipliedRmse(source, candidate)).toBe(0)
      },
    ),
    { numRuns: 100 },
  )
})

test("fully transparent RGB cannot change the duotone model", () => {
  fc.assert(
    fc.property(
      fc.array(fc.tuple(fc.nat(255), fc.nat(255), fc.nat(255)), {
        maxLength: 64,
        minLength: 1,
      }),
      fc.array(fc.tuple(fc.nat(255), fc.nat(255), fc.nat(255)), {
        maxLength: 64,
      }),
      (visible, hidden) => {
        const visibleRgba = Uint8Array.from(
          visible.flatMap((color) => [...color, 255]),
        )
        const withHidden = Uint8Array.from([
          ...visibleRgba,
          ...hidden.flatMap((color) => [...color, 0]),
        ])
        expect(dominantOklabDuotoneModel(withHidden)).toEqual(
          dominantOklabDuotoneModel(visibleRgba),
        )
      },
    ),
    { numRuns: 100 },
  )
})
