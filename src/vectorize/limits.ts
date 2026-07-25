import { VectorizeError, type VectorizeLimits } from "./types.ts"

export const vectorizeHardLimits = Object.freeze({
  maxDecodedPixels: 16_777_216,
  maxDimension: 4_096,
  maxDurationMs: 120_000,
  maxInputBytes: 16 * 1_024 * 1_024,
  maxOutputBytes: 2_000_000,
  maxPaths: 12_000,
}) satisfies Readonly<VectorizeLimits>

export const vectorizeDefaultLimits = Object.freeze({
  ...vectorizeHardLimits,
  maxDurationMs: 30_000,
}) satisfies Readonly<VectorizeLimits>

const limitNames = Object.keys(vectorizeHardLimits) as (keyof VectorizeLimits)[]

export function resolveVectorizeLimits(
  input: Partial<VectorizeLimits> | undefined,
): Readonly<VectorizeLimits> {
  const resolved: VectorizeLimits = {
    maxDecodedPixels: input?.maxDecodedPixels ?? vectorizeDefaultLimits.maxDecodedPixels,
    maxDimension: input?.maxDimension ?? vectorizeDefaultLimits.maxDimension,
    maxDurationMs: input?.maxDurationMs ?? vectorizeDefaultLimits.maxDurationMs,
    maxInputBytes: input?.maxInputBytes ?? vectorizeDefaultLimits.maxInputBytes,
    maxOutputBytes: input?.maxOutputBytes ?? vectorizeDefaultLimits.maxOutputBytes,
    maxPaths: input?.maxPaths ?? vectorizeDefaultLimits.maxPaths,
  }

  for (const name of limitNames) {
    const value = resolved[name]
    const hardLimit = vectorizeHardLimits[name]
    if (!Number.isInteger(value) || value < 1 || value > hardLimit) {
      throw new VectorizeError(
        "invalid_input",
        `${name} must be a positive integer no greater than ${hardLimit}.`,
        { hardLimit, name, value },
      )
    }
  }
  return Object.freeze(resolved)
}

export class VectorizeDeadline {
  readonly #deadline: number

  constructor(durationMs: number) {
    this.#deadline = performance.now() + durationMs
  }

  assert(stage: string): void {
    if (this.remainingMs() <= 0) {
      throw new VectorizeError("timeout", `Vectorization timed out during ${stage}.`, { stage })
    }
  }

  remainingMs(): number {
    return Math.max(0, Math.ceil(this.#deadline - performance.now()))
  }
}
