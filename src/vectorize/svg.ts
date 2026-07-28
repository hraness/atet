import {
  colorBelongsToPrimary,
  type DominantOklabDuotoneModel,
  normalizedHexColor,
  parseHexColor,
  sha256,
} from "./metrics.js"
import { VectorizeError } from "./types.js"

export interface CanonicalVectorPath {
  readonly d: string
  readonly fill: string
  readonly rgb: readonly [number, number, number]
  readonly transform?: string
}

export interface CanonicalVector {
  readonly paths: readonly CanonicalVectorPath[]
  readonly svg: string
}

const PATH_DATA = /^[MmZzLlHhVvCcSsQqTtAaEe0-9+,.\s-]+$/u
const TRANSLATE =
  /^translate\(\s*[-+0-9.eE]+\s*(?:,\s*|\s+)[-+0-9.eE]+\s*\)$/u
const DANGEROUS_SOURCE =
  /<!DOCTYPE|<!ENTITY|<\?(?!xml)|<(?:a|animate|embed|filter|foreignObject|iframe|image|link|object|script|set|style|use)\b|(?:href|src)\s*=|\bon[a-z]+\s*=|url\s*\(/iu

export function canonicalizeVTracerSvg(
  sourceSvg: string,
  width: number,
  height: number,
  maxPaths: number,
): CanonicalVector {
  if (DANGEROUS_SOURCE.test(sourceSvg)) {
    throw new VectorizeError(
      "unsafe_svg",
      "VTracer output contains active or referenced SVG content.",
    )
  }
  const paths: CanonicalVectorPath[] = []
  const pathPattern = /<path\b([^>]*)\/?\s*>/gu
  for (const match of sourceSvg.matchAll(pathPattern)) {
    if (paths.length >= maxPaths) {
      throw new VectorizeError(
        "output_limit",
        `VTracer output exceeds the ${maxPaths}-path limit.`,
      )
    }
    const attributes = match[1]!
    const d = attributes.match(/(?:^|\s)d="([^"]*)"/u)?.[1]
    const fill = attributes.match(/(?:^|\s)fill="([^"]+)"/u)?.[1]
    const transform = attributes.match(/(?:^|\s)transform="([^"]+)"/u)?.[1]
    if (d === "") continue
    if (d === undefined || d.includes("&") || !PATH_DATA.test(d)) {
      throw new VectorizeError("unsafe_svg", "VTracer output contains unsupported path data.")
    }
    if (fill === undefined) {
      throw new VectorizeError("unsafe_svg", "VTracer output contains a path without a fill.")
    }
    if (transform !== undefined && !TRANSLATE.test(transform)) {
      throw new VectorizeError(
        "unsafe_svg",
        "VTracer output contains an unsupported path transform.",
      )
    }
    const normalizedFill = normalizedHexColor(fill)
    paths.push({
      d,
      fill: normalizedFill,
      rgb: parseHexColor(normalizedFill),
      ...(transform === undefined ? {} : { transform }),
    })
  }
  if (paths.length === 0) {
    throw new VectorizeError("trace_failed", "VTracer output did not contain visible paths.")
  }
  return { paths, svg: buildColorSvg(paths, width, height) }
}

export function buildColorSvg(
  paths: readonly CanonicalVectorPath[],
  width: number,
  height: number,
  duotone?: Readonly<{
    model: DominantOklabDuotoneModel
    palette: readonly [primary: string, secondary: string]
  }>,
): string {
  const palette =
    duotone === undefined
      ? undefined
      : [
          normalizedHexColor(duotone.palette[0]),
          normalizedHexColor(duotone.palette[1]),
        ] as const
  const body = paths.map(({ d, fill, rgb, transform }) => {
    const outputFill =
      duotone === undefined || palette === undefined
        ? fill
        : colorBelongsToPrimary(rgb, duotone.model)
          ? palette[0]
          : palette[1]
    return `  <path d="${d}"${transform === undefined ? "" : ` transform="${transform}"`} fill="${outputFill}"/>`
  })
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    ...body,
    "</svg>",
    "",
  ].join("\n")
  assertSafeCanonicalSvg(svg)
  return svg
}

export function buildAlphaMaskedSvg(
  artworkPaths: readonly CanonicalVectorPath[],
  maskPaths: readonly CanonicalVectorPath[],
  width: number,
  height: number,
  duotone?: Readonly<{
    model: DominantOklabDuotoneModel
    palette: readonly [primary: string, secondary: string]
  }>,
): string {
  if (maskPaths.some(({ rgb }) => rgb[0] !== rgb[1] || rgb[1] !== rgb[2])) {
    throw new VectorizeError("unsafe_svg", "An alpha mask may contain only grayscale fills.")
  }
  const palette =
    duotone === undefined
      ? undefined
      : [
          normalizedHexColor(duotone.palette[0]),
          normalizedHexColor(duotone.palette[1]),
        ] as const
  const maskFingerprint = maskPaths
    .map(({ d, fill, transform }) => `${d}\n${fill}\n${transform ?? ""}`)
    .join("\n")
  const maskId = `alpha-${sha256(maskFingerprint).slice(0, 16)}`
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    "  <defs>",
    `    <mask id="${maskId}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}" mask-type="luminance">`,
    `      <rect x="0" y="0" width="${width}" height="${height}" fill="#000000"/>`,
    ...maskPaths.map(
      ({ d, fill, transform }) =>
        `      <path d="${d}"${transform === undefined ? "" : ` transform="${transform}"`} fill="${fill}"/>`,
    ),
    "    </mask>",
    "  </defs>",
    `  <g mask="url(#${maskId})">`,
    ...artworkPaths.map(({ d, fill, rgb, transform }) => {
      const outputFill =
        duotone === undefined || palette === undefined
          ? fill
          : colorBelongsToPrimary(rgb, duotone.model)
            ? palette[0]
            : palette[1]
      return `    <path d="${d}"${transform === undefined ? "" : ` transform="${transform}"`} fill="${outputFill}"/>`
    }),
    "  </g>",
    "</svg>",
    "",
  ].join("\n")
  assertSafeCanonicalSvg(svg)
  return svg
}

export function countSvgPaths(svg: string): number {
  return svg.match(/<path\b/gu)?.length ?? 0
}

export function assertSafeCanonicalSvg(svg: string): void {
  if (
    /<!DOCTYPE|<!ENTITY|<\?(?!xml)|<(?:a|animate|embed|filter|foreignObject|iframe|image|link|object|script|set|style|use)\b|(?:href|src)\s*=|\bon[a-z]+\s*=/iu.test(
      svg,
    )
  ) {
    throw new VectorizeError("unsafe_svg", "Canonical SVG contains active or external content.")
  }
  for (const match of svg.matchAll(/url\(([^)]+)\)/gu)) {
    if (!/^#[a-z0-9-]+$/u.test(match[1]!)) {
      throw new VectorizeError("unsafe_svg", "Canonical SVG contains an external URL.")
    }
    if (!svg.includes(`id="${match[1]!.slice(1)}"`)) {
      throw new VectorizeError("unsafe_svg", "Canonical SVG references an unknown local ID.")
    }
  }
}
