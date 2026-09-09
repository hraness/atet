import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { reduceSpatialFrameRate, spatialFrameCount, spatialFrameSample, spatialOutputDuration } from "./time.js"

describe("exact rational frame sampling", () => {
  test("NTSC sampling has exact frame count and duration without accumulated rounding", () => {
    const rate = { numerator: 30000, denominator: 1001 }
    expect(spatialFrameCount(1_000_000, rate)).toBe(30)
    expect(spatialFrameSample(1, 1_000_000, rate)).toEqual({ frameIndex: 1, timeUs: 33367, exactTimeUs: { numerator: "100100", denominator: "3" } })
    expect(spatialFrameSample(3, 1_000_000, rate).timeUs).toBe(100100)
    expect(spatialFrameSample(29, 1_000_000, rate).timeUs).toBe(967633)
    expect(spatialOutputDuration(1_000_000, rate)).toEqual({ numerator: "1001000", denominator: "1" })
    expect(() => spatialFrameSample(30, 1_000_000, rate)).toThrow()
  })

  test("rounding ties toward positive infinity and endpoints are guarded before quantization", () => {
    expect(spatialFrameSample(1, 10_000, { numerator: 640, denominator: 1 }).timeUs).toBe(1563)
    const rate = { numerator: 30000, denominator: 1001 }
    expect(spatialFrameCount(33367, rate)).toBe(2)
    expect(spatialFrameSample(1, 33367, rate).timeUs).toBe(33367)
    expect(() => spatialFrameSample(1, 33366, rate)).toThrow()
    expect(spatialFrameCount(1, rate)).toBe(1)
    expect(spatialFrameSample(0, 1, rate).timeUs).toBe(0)
  })

  test("equivalent rates and count/sample range laws hold at full authored duration", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 1, max: 3_600_000_000 }), (fps, durationUs) => {
      const rate = { numerator: fps, denominator: 1 }
      expect(reduceSpatialFrameRate({ numerator: fps * 2, denominator: 2 })).toEqual(rate)
      const count = spatialFrameCount(durationUs, rate)
      const last = spatialFrameSample(count - 1, durationUs, rate)
      expect(BigInt(last.exactTimeUs.numerator) < BigInt(durationUs) * BigInt(last.exactTimeUs.denominator)).toBe(true)
      expect(() => spatialFrameSample(count, durationUs, rate)).toThrow()
      expect(last.timeUs).toBeLessThanOrEqual(durationUs)
      const duration = spatialOutputDuration(durationUs, rate)
      expect(BigInt(duration.numerator) >= BigInt(durationUs) * BigInt(duration.denominator)).toBe(true)
    }), { numRuns: 100, seed: 4204 })
  })

  test("rejects fractional indices, invalid rates, unbounded and empty durations", () => {
    for (const rate of [{ numerator: 0, denominator: 1 }, { numerator: 1, denominator: 0 }, { numerator: 1001, denominator: 1 }, { numerator: 1.5, denominator: 1 }, { numerator: Infinity, denominator: 1 }]) expect(() => reduceSpatialFrameRate(rate)).toThrow()
    for (const duration of [0, -1, 0.5, 3_600_000_001, Number.MAX_SAFE_INTEGER]) expect(() => spatialFrameCount(duration, { numerator: 30, denominator: 1 })).toThrow()
    expect(() => spatialFrameSample(0.5, 1_000_000, { numerator: 30, denominator: 1 })).toThrow()
    expect(() => spatialFrameSample(-1, 1_000_000, { numerator: 30, denominator: 1 })).toThrow()
  })
})
