import { createHash } from "node:crypto"
import { VectorizeError } from "./types.js"

export function sha256(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex")
}

export function sanitizedTraceRgba(rgba: Uint8Array, minimumAlpha: number): Uint8Array {
  if (rgba.length === 0 || rgba.length % 4 !== 0) {
    throw new VectorizeError("invalid_input", "Trace sanitation requires nonempty RGBA pixels.")
  }
  if (!Number.isInteger(minimumAlpha) || minimumAlpha < 1 || minimumAlpha > 64) {
    throw new VectorizeError("invalid_input", "alphaCutoff must be an integer from 1 through 64.")
  }
  const sanitized = Uint8Array.from(rgba)
  for (let index = 0; index < sanitized.length; index += 4) {
    if (sanitized[index + 3]! >= minimumAlpha) continue
    sanitized[index] = 0
    sanitized[index + 1] = 0
    sanitized[index + 2] = 0
    sanitized[index + 3] = 0
  }
  return sanitized
}

export function alphaPlaneTraceRgba(rgba: Uint8Array): Uint8Array {
  if (rgba.length === 0 || rgba.length % 4 !== 0) {
    throw new VectorizeError("invalid_input", "An alpha trace requires nonempty RGBA pixels.")
  }
  const grayscale = new Uint8Array(rgba.length)
  for (let index = 0; index < rgba.length; index += 4) {
    const alpha = rgba[index + 3]!
    grayscale[index] = alpha
    grayscale[index + 1] = alpha
    grayscale[index + 2] = alpha
    grayscale[index + 3] = 255
  }
  return grayscale
}

export function lowAlphaMassRatio(rgba: Uint8Array, cutoff: number): number {
  if (rgba.length === 0 || rgba.length % 4 !== 0) {
    throw new VectorizeError("invalid_input", "Low-alpha measurement requires nonempty RGBA pixels.")
  }
  if (!Number.isInteger(cutoff) || cutoff < 1 || cutoff > 255) {
    throw new VectorizeError("invalid_input", "The low-alpha cutoff must be a byte.")
  }
  let lowAlphaMass = 0
  let visibleAlphaMass = 0
  for (let index = 3; index < rgba.length; index += 4) {
    const alpha = rgba[index]!
    visibleAlphaMass += alpha
    if (alpha > 0 && alpha < cutoff) lowAlphaMass += alpha
  }
  return visibleAlphaMass === 0 ? 0 : lowAlphaMass / visibleAlphaMass
}

export function hasFractionalAlpha(rgba: Uint8Array): boolean {
  for (let index = 3; index < rgba.length; index += 4) {
    const alpha = rgba[index]!
    if (alpha > 0 && alpha < 255) return true
  }
  return false
}

export function normalizedPremultipliedRmse(
  source: Uint8Array,
  candidate: Uint8Array,
): number {
  assertComparableRgba(source, candidate, "RMSE")
  let squaredError = 0
  for (let index = 0; index < source.length; index += 4) {
    const sourceAlpha = source[index + 3]! / 255
    const candidateAlpha = candidate[index + 3]! / 255
    for (let channel = 0; channel < 3; channel += 1) {
      const difference =
        source[index + channel]! * sourceAlpha - candidate[index + channel]! * candidateAlpha
      squaredError += difference * difference
    }
    const alphaDifference = source[index + 3]! - candidate[index + 3]!
    squaredError += alphaDifference * alphaDifference
  }
  return Math.sqrt(squaredError / source.length) / 255
}

export function normalizedAlphaRmse(source: Uint8Array, candidate: Uint8Array): number {
  assertComparableRgba(source, candidate, "Alpha RMSE")
  let squaredError = 0
  for (let index = 3; index < source.length; index += 4) {
    const difference = source[index]! - candidate[index]!
    squaredError += difference * difference
  }
  return Math.sqrt(squaredError / (source.length / 4)) / 255
}

function assertComparableRgba(source: Uint8Array, candidate: Uint8Array, label: string): void {
  if (source.length === 0 || source.length !== candidate.length || source.length % 4 !== 0) {
    throw new VectorizeError(
      "invalid_input",
      `${label} inputs must be equally sized nonempty RGBA buffers.`,
    )
  }
}

export interface SupportMetrics {
  readonly outsideAlphaRatio: number
  readonly supportRecall: number
}

export function measureSupport(
  source: Uint8Array,
  candidate: Uint8Array,
  width: number,
  height: number,
  dilation = 1,
): SupportMetrics {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    source.length !== width * height * 4 ||
    candidate.length !== source.length
  ) {
    throw new VectorizeError(
      "invalid_input",
      "Support metrics require equally sized rectangular RGBA buffers.",
    )
  }
  if (!Number.isInteger(dilation) || dilation < 0 || dilation > 4) {
    throw new VectorizeError("invalid_input", "Support dilation must be an integer from 0 to 4.")
  }

  const support = new Uint8Array(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let covered = false
      for (let dy = -dilation; dy <= dilation && !covered; dy += 1) {
        for (let dx = -dilation; dx <= dilation; dx += 1) {
          const neighborX = x + dx
          const neighborY = y + dy
          if (
            neighborX >= 0 &&
            neighborX < width &&
            neighborY >= 0 &&
            neighborY < height &&
            source[(neighborY * width + neighborX) * 4 + 3]! > 0
          ) {
            covered = true
            break
          }
        }
      }
      support[y * width + x] = covered ? 1 : 0
    }
  }

  let candidateAlphaMass = 0
  let outsideAlphaMass = 0
  let recalledAlphaMass = 0
  let sourceAlphaMass = 0
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const sourceAlpha = source[pixel * 4 + 3]! / 255
    const candidateAlpha = candidate[pixel * 4 + 3]! / 255
    sourceAlphaMass += sourceAlpha
    candidateAlphaMass += candidateAlpha
    recalledAlphaMass += Math.min(sourceAlpha, candidateAlpha)
    if (support[pixel] === 0) outsideAlphaMass += candidateAlpha
  }
  if (sourceAlphaMass === 0 || candidateAlphaMass === 0) {
    throw new VectorizeError("quality_limit", "Source and candidate must contain visible pixels.")
  }
  return {
    outsideAlphaRatio: outsideAlphaMass / candidateAlphaMass,
    supportRecall: recalledAlphaMass / sourceAlphaMass,
  }
}

type OklabColor = readonly [number, number, number]

export interface DominantOklabDuotoneModel {
  readonly cutoff: number
  readonly primary: OklabColor
  readonly primaryShare: number
}

export function parseHexColor(value: string): readonly [number, number, number] {
  const shorthand = value.match(/^#([a-f0-9])([a-f0-9])([a-f0-9])$/iu)
  if (shorthand !== null) {
    return [
      Number.parseInt(`${shorthand[1]}${shorthand[1]}`, 16),
      Number.parseInt(`${shorthand[2]}${shorthand[2]}`, 16),
      Number.parseInt(`${shorthand[3]}${shorthand[3]}`, 16),
    ]
  }
  const full = value.match(/^#([a-f0-9]{2})([a-f0-9]{2})([a-f0-9]{2})$/iu)
  if (full === null) {
    throw new VectorizeError(
      "invalid_input",
      `Expected a #rgb or #rrggbb color, received ${JSON.stringify(value)}.`,
    )
  }
  return [
    Number.parseInt(full[1]!, 16),
    Number.parseInt(full[2]!, 16),
    Number.parseInt(full[3]!, 16),
  ]
}

export function normalizedHexColor(value: string): string {
  return `#${parseHexColor(value)
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`
}

function srgbToOklab([red, green, blue]: readonly [number, number, number]): OklabColor {
  const linear = (channel: number): number => {
    const value = channel / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  const r = linear(red)
  const g = linear(green)
  const b = linear(blue)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

export function oklabDistance(left: OklabColor, right: OklabColor): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2])
}

interface WeightedColor {
  readonly color: OklabColor
  readonly key: number
  readonly mass: number
}

function otsuDistanceCutoff(colors: readonly WeightedColor[], primary: OklabColor): number {
  const distances = colors.map(({ color, mass }) => ({
    distance: oklabDistance(color, primary),
    mass,
  }))
  const maximum = Math.max(...distances.map(({ distance }) => distance))
  if (maximum === 0) return Number.POSITIVE_INFINITY

  const histogram = Array.from({ length: 256 }, () => ({ mass: 0, moment: 0 }))
  for (const { distance, mass } of distances) {
    const index = Math.min(255, Math.floor((distance / maximum) * 255))
    histogram[index]!.mass += mass
    histogram[index]!.moment += mass * distance
  }
  const totalMass = histogram.reduce((sum, bin) => sum + bin.mass, 0)
  const totalMoment = histogram.reduce((sum, bin) => sum + bin.moment, 0)
  let nearMass = 0
  let nearMoment = 0
  let bestScore = -1
  let bestIndex = 254
  for (let index = 0; index < 255; index += 1) {
    const bin = histogram[index]!
    nearMass += bin.mass
    nearMoment += bin.moment
    const farMass = totalMass - nearMass
    if (nearMass === 0 || farMass === 0) continue
    const nearMean = nearMoment / nearMass
    const farMean = (totalMoment - nearMoment) / farMass
    const score = nearMass * farMass * (nearMean - farMean) ** 2
    if (score > bestScore) {
      bestScore = score
      bestIndex = index
    }
  }
  let cutoff = (maximum * (bestIndex + 1)) / 255
  const nearShare = (): number =>
    distances.reduce(
      (sum, { distance, mass }) => sum + (distance <= cutoff ? mass : 0),
      0,
    ) / totalMass
  if (nearShare() < 0.5) {
    let cumulativeMass = 0
    for (const { distance, mass } of [...distances].sort(
      (left, right) => left.distance - right.distance,
    )) {
      cumulativeMass += mass
      cutoff = distance
      if (cumulativeMass >= totalMass / 2) break
    }
  }
  return cutoff
}

export function dominantOklabDuotoneModel(
  rgba: Uint8Array,
): DominantOklabDuotoneModel {
  if (rgba.length === 0 || rgba.length % 4 !== 0) {
    throw new VectorizeError("invalid_input", "A duotone model requires nonempty RGBA pixels.")
  }
  const bins = new Map<
    number,
    { blue: number; green: number; mass: number; red: number }
  >()
  for (let index = 0; index < rgba.length; index += 4) {
    const alpha = rgba[index + 3]! / 255
    if (alpha === 0) continue
    const red = rgba[index]!
    const green = rgba[index + 1]!
    const blue = rgba[index + 2]!
    const key = ((red >> 4) << 8) | ((green >> 4) << 4) | (blue >> 4)
    const bin = bins.get(key) ?? { blue: 0, green: 0, mass: 0, red: 0 }
    bin.mass += alpha
    bin.red += red * alpha
    bin.green += green * alpha
    bin.blue += blue * alpha
    bins.set(key, bin)
  }
  if (bins.size === 0) {
    throw new VectorizeError("invalid_input", "A duotone model requires visible pixels.")
  }
  const colors = [...bins.entries()]
    .map(([key, bin]) => ({
      color: srgbToOklab([
        bin.red / bin.mass,
        bin.green / bin.mass,
        bin.blue / bin.mass,
      ]),
      key,
      mass: bin.mass,
    }))
    .sort((left, right) => right.mass - left.mass || left.key - right.key)
  const primary = colors[0]!.color
  const cutoff = otsuDistanceCutoff(colors, primary)
  const totalMass = colors.reduce((sum, { mass }) => sum + mass, 0)
  const primaryMass = colors.reduce(
    (sum, { color, mass }) =>
      sum + (oklabDistance(color, primary) <= cutoff ? mass : 0),
    0,
  )
  return { cutoff, primary, primaryShare: primaryMass / totalMass }
}

export function colorBelongsToPrimary(
  rgb: readonly [number, number, number],
  model: DominantOklabDuotoneModel,
): boolean {
  return oklabDistance(srgbToOklab(rgb), model.primary) <= model.cutoff
}
