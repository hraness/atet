import { deepFreezeJson } from "../code/json-snapshot.js"
import { SpatialFrameRateSchema, SpatialTimeUsSchema, type SpatialFrameRate } from "./contracts.js"
import { parseSpatialValue, SpatialSceneError } from "./identity.js"

/** Decimal strings retain exact rational values across JSON and SDK boundaries. */
export interface SpatialRational { readonly numerator: string; readonly denominator: string }
export interface SpatialFrameSample { readonly frameIndex: number; readonly timeUs: number; readonly exactTimeUs: SpatialRational }

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) { const remainder = a % b; a = b; b = remainder }
  return a
}
function rational(numerator: bigint, denominator: bigint): SpatialRational {
  const divisor = gcd(numerator, denominator)
  return Object.freeze({ numerator: String(numerator / divisor), denominator: String(denominator / divisor) })
}
function integer(input: number, name: string): bigint {
  if (!Number.isSafeInteger(input) || input < 0) throw new SpatialSceneError("invalid-data", `${name} must be a nonnegative safe integer.`)
  return BigInt(input)
}
function duration(input: number): bigint {
  const value = parseSpatialValue(SpatialTimeUsSchema, input, "durationUs")
  if (value === 0) throw new SpatialSceneError("invalid-data", "Output duration must be positive.")
  return BigInt(value)
}

export function reduceSpatialFrameRate(input: unknown): SpatialFrameRate {
  const rate = parseSpatialValue(SpatialFrameRateSchema, input, "frame rate")
  const divisor = Number(gcd(BigInt(rate.numerator), BigInt(rate.denominator)))
  return Object.freeze({ numerator: rate.numerator / divisor, denominator: rate.denominator / divisor })
}

/** Number of nominal samples i/fps in the half-open authored duration. */
export function spatialFrameCount(durationUs: number, rateInput: unknown): number {
  const end = duration(durationUs), rate = reduceSpatialFrameRate(rateInput)
  const numerator = end * BigInt(rate.numerator), denominator = 1_000_000n * BigInt(rate.denominator)
  return Number((numerator + denominator - 1n) / denominator)
}

/** Every sample is rounded independently to nearest microsecond, with ties toward +infinity. */
export function spatialFrameSample(frameIndex: number, durationUs: number, rateInput: unknown): SpatialFrameSample {
  const index = integer(frameIndex, "frameIndex"), end = duration(durationUs), rate = reduceSpatialFrameRate(rateInput)
  const numerator = index * 1_000_000n * BigInt(rate.denominator), denominator = BigInt(rate.numerator)
  if (numerator >= end * denominator) throw new SpatialSceneError("invalid-data", "Frame lies outside the half-open duration before quantization.", "frameIndex")
  const timeUs = Number((2n * numerator + denominator) / (2n * denominator))
  return deepFreezeJson({ frameIndex, timeUs, exactTimeUs: rational(numerator, denominator) })
}

/** Encoded duration is frameCount/fps and can exceed authored duration by less than one frame. */
export function spatialOutputDuration(durationUs: number, rateInput: unknown): SpatialRational {
  const rate = reduceSpatialFrameRate(rateInput)
  return rational(BigInt(spatialFrameCount(durationUs, rate)) * 1_000_000n * BigInt(rate.denominator), BigInt(rate.numerator))
}
