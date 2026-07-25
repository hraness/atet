import { randomUUID } from "node:crypto"
import {
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { runBoundedCommand } from "./command.ts"
import { resolveVectorizeLimits, VectorizeDeadline } from "./limits.ts"
import {
  alphaPlaneTraceRgba,
  dominantOklabDuotoneModel,
  hasFractionalAlpha,
  lowAlphaMassRatio,
  measureSupport,
  normalizedHexColor,
  normalizedAlphaRmse,
  normalizedPremultipliedRmse,
  sanitizedTraceRgba,
  sha256,
} from "./metrics.ts"
import {
  encodeTracePng,
  loadRaster,
  renderSvgRgba,
  sharpProvenance,
  type LoadedRaster,
} from "./pixels.ts"
import {
  assertSafeCanonicalSvg,
  buildAlphaMaskedSvg,
  buildColorSvg,
  canonicalizeVTracerSvg,
  countSvgPaths,
  type CanonicalVectorPath,
} from "./svg.ts"
import { ensureVTracer, type VTracerTool } from "./tool.ts"
import { runVectorizeWorker } from "./supervisor.ts"
import {
  VectorizeError,
  type VectorizeInput,
  type VectorizeOptions,
  type VectorizeProfile,
  type VectorizeQualityReceipt,
  type VectorizeRepresentation,
  type VectorizeResult,
} from "./types.ts"

const DEFAULT_ALPHA_CUTOFF = 8
const COMPARE_LOW_ALPHA_MASS_RATIO = 0.002

const profiles = [
  {
    args: [
      "--colormode",
      "color",
      "--hierarchical",
      "stacked",
      "--mode",
      "spline",
      "--filter_speckle",
      "0",
      "--color_precision",
      "8",
      "--gradient_step",
      "4",
      "--segment_length",
      "4.5",
      "--path_precision",
      "4",
    ],
    name: "balanced",
  },
  {
    args: [
      "--colormode",
      "color",
      "--hierarchical",
      "stacked",
      "--mode",
      "spline",
      "--filter_speckle",
      "0",
      "--color_precision",
      "8",
      "--gradient_step",
      "2",
      "--segment_length",
      "3.5",
      "--path_precision",
      "5",
    ],
    name: "detailed",
  },
  {
    args: [
      "--preset",
      "photo",
      "--hierarchical",
      "stacked",
      "--filter_speckle",
      "0",
    ],
    name: "photo",
  },
] as const

const alphaMaskArgs = [
  "--colormode",
  "color",
  "--hierarchical",
  "cutout",
  "--mode",
  "spline",
  "--filter_speckle",
  "0",
  "--color_precision",
  "8",
  "--gradient_step",
  "2",
  "--segment_length",
  "3.5",
  "--path_precision",
  "5",
  "--corner_threshold",
  "30",
  "--splice_threshold",
  "20",
] as const

interface Candidate {
  readonly alphaCutoff: number
  readonly artworkPaths: readonly CanonicalVectorPath[]
  readonly bytes: number
  readonly maskPaths?: readonly CanonicalVectorPath[]
  readonly pathCount: number
  readonly profile: VectorizeProfile
  readonly quality: VectorizeQualityReceipt
  readonly representation: VectorizeRepresentation
  readonly svg: string
}

interface TraceVariation {
  readonly alphaCutoff: number
  readonly name: string
  readonly pixels: Uint8Array
}

export function vectorizeImage(
  input: VectorizeInput,
  options: VectorizeOptions = {},
): Promise<VectorizeResult> {
  return runVectorizeWorker(input, options)
}

export async function vectorizeImageInProcess(
  input: VectorizeInput,
  options: VectorizeOptions = {},
  temporaryRoot: string,
): Promise<VectorizeResult> {
  const limits = resolveVectorizeLimits(options.limits)
  const deadline = new VectorizeDeadline(limits.maxDurationMs)
  const alphaCutoff = options.alphaCutoff ?? DEFAULT_ALPHA_CUTOFF
  if (!Number.isInteger(alphaCutoff) || alphaCutoff < 1 || alphaCutoff > 64) {
    throw new VectorizeError(
      "invalid_input",
      "alphaCutoff must be an integer from 1 through 64.",
    )
  }
  const duotonePalette =
    options.duotone === undefined
      ? undefined
      : [
          normalizedHexColor(options.duotone[0]),
          normalizedHexColor(options.duotone[1]),
        ] as const

  const raster = await loadRaster(input, limits, deadline)
  if (process.platform === "win32") {
    throw new VectorizeError(
      "tool_platform",
      "Bounded VTracer streaming is unavailable on Windows.",
      { platform: process.platform },
    )
  }
  const tool = await ensureVTracer(
    deadline,
    temporaryRoot,
    options.cacheDirectory,
  )
    const errors: string[] = []
    const candidates: Candidate[] = []
    const variations = traceVariations(raster.pixels, alphaCutoff)
    for (const variation of variations) {
      deadline.assert(`${variation.name} trace`)
      const sourcePath = join(temporaryRoot, `${variation.name}.png`)
      await writeFile(
        sourcePath,
        await encodeTracePng(variation.pixels, raster.width, raster.height),
      )
      const balanced = await attemptCandidate(
        raster,
        variation,
        profiles[0],
        sourcePath,
        tool,
        temporaryRoot,
        limits,
        deadline,
        errors,
      )
      if (balanced !== undefined) candidates.push(balanced)
      if (balanced !== undefined && passesFastQuality(balanced.quality)) continue

      const detailed = await attemptCandidate(
        raster,
        variation,
        profiles[1],
        sourcePath,
        tool,
        temporaryRoot,
        limits,
        deadline,
        errors,
      )
      if (detailed !== undefined) candidates.push(detailed)
      if ([balanced, detailed].some((candidate) => candidate !== undefined && passesQuality(candidate.quality))) {
        continue
      }

      const photo = await attemptCandidate(
        raster,
        variation,
        profiles[2],
        sourcePath,
        tool,
        temporaryRoot,
        limits,
        deadline,
        errors,
      )
      if (photo !== undefined) candidates.push(photo)
    }

    const baseForMask = [...candidates].sort(compareFidelity)[0]
    if (
      baseForMask !== undefined &&
      hasFractionalAlpha(raster.pixels) &&
      baseForMask.quality.alphaRmse > 0.06
    ) {
      const masked = await attemptAlphaMask(
        raster,
        baseForMask,
        tool,
        temporaryRoot,
        limits,
        deadline,
        errors,
      )
      if (masked !== undefined) candidates.push(masked)
    }

    const eligible = candidates.filter(
      (candidate) =>
        candidate.bytes <= limits.maxOutputBytes &&
        candidate.pathCount <= limits.maxPaths &&
        passesQuality(candidate.quality),
    )
    if (eligible.length === 0) {
      throw new VectorizeError(
        "quality_limit",
        "No adaptive vector candidate passed the fidelity and output gates.",
        {
          candidates: candidates.map(candidateSummary),
          errors,
        },
      )
    }
    const selected = selectCandidate(eligible)
    const duotone =
      duotonePalette === undefined
        ? undefined
        : {
            model: dominantOklabDuotoneModel(raster.pixels),
            palette: duotonePalette,
          }
    const svg =
      selected.maskPaths === undefined
        ? buildColorSvg(
            selected.artworkPaths,
            raster.width,
            raster.height,
            duotone,
          )
        : buildAlphaMaskedSvg(
            selected.artworkPaths,
            selected.maskPaths,
            raster.width,
            raster.height,
            duotone,
          )
    assertSafeCanonicalSvg(svg)
    const bytes = Buffer.byteLength(svg)
    const pathCount = countSvgPaths(svg)
    if (bytes > limits.maxOutputBytes || pathCount > limits.maxPaths) {
      throw new VectorizeError(
        "output_limit",
        `Canonical SVG exceeds ${limits.maxOutputBytes} bytes or ${limits.maxPaths} paths.`,
        { bytes, pathCount },
      )
    }
    deadline.assert("output publication")
    const outputPath =
      options.outputPath === undefined ? null : await writeSvgAtomically(options.outputPath, svg)
    const pixelToolchain = sharpProvenance()
  return {
      outputPath,
      receipt: {
        alphaCutoff: selected.alphaCutoff,
        bytes,
        candidatesEvaluated: candidates.length,
        format: raster.format,
        height: raster.height,
        inputBytes: raster.inputBytes,
        outputMode: duotone === undefined ? "color" : "duotone",
        pathCount,
        profile: selected.profile,
        provenance: {
          arch: process.arch,
          platform: process.platform,
          sharp: pixelToolchain.sharp,
          sharpVersions: pixelToolchain.sharpVersions,
          vips: pixelToolchain.vips,
          vtracerSha256: tool.sha256,
          vtracerSource: tool.source,
          vtracerVersion: tool.version,
        },
        quality: roundedQuality(selected.quality),
        receiptVersion: 1,
        representation: selected.representation,
        sourceSha256: raster.sourceSha256,
        svgSha256: sha256(svg),
        width: raster.width,
      },
      svg,
  }
}

function traceVariations(pixels: Uint8Array, alphaCutoff: number): TraceVariation[] {
  const sanitized = sanitizedTraceRgba(pixels, alphaCutoff)
  const output: TraceVariation[] = []
  if (containsVisiblePixel(sanitized)) {
    output.push({ alphaCutoff, name: `alpha-${alphaCutoff}`, pixels: sanitized })
  }
  if (
    alphaCutoff > 1 &&
    (output.length === 0 ||
      lowAlphaMassRatio(pixels, alphaCutoff) >= COMPARE_LOW_ALPHA_MASS_RATIO)
  ) {
    output.push({
      alphaCutoff: 1,
      name: "alpha-1",
      pixels: sanitizedTraceRgba(pixels, 1),
    })
  }
  if (output.length === 0) {
    throw new VectorizeError("invalid_input", "Alpha sanitation removed every visible pixel.")
  }
  return output
}

function containsVisiblePixel(pixels: Uint8Array): boolean {
  for (let index = 3; index < pixels.length; index += 4) {
    if (pixels[index]! > 0) return true
  }
  return false
}

async function attemptCandidate(
  raster: LoadedRaster,
  variation: TraceVariation,
  profile: (typeof profiles)[number],
  sourcePath: string,
  tool: VTracerTool,
  temporaryRoot: string,
  limits: ReturnType<typeof resolveVectorizeLimits>,
  deadline: VectorizeDeadline,
  errors: string[],
): Promise<Candidate | undefined> {
  try {
    const raw = await traceRawSvg(
      tool,
      sourcePath,
      profile.args,
      temporaryRoot,
      limits.maxOutputBytes,
      deadline,
      `${variation.name}-${profile.name}`,
    )
    deadline.assert(`${profile.name} trace`)
    const canonical = canonicalizeVTracerSvg(
      raw,
      raster.width,
      raster.height,
      limits.maxPaths,
    )
    const bytes = Buffer.byteLength(canonical.svg)
    const pathCount = canonical.paths.length
    if (bytes > limits.maxOutputBytes || pathCount > limits.maxPaths) {
      throw new VectorizeError("output_limit", `${profile.name} exceeds vector output limits.`)
    }
    const quality = await scoreSvg(canonical.svg, raster, limits.maxDecodedPixels, deadline)
    return {
      alphaCutoff: variation.alphaCutoff,
      artworkPaths: canonical.paths,
      bytes,
      pathCount,
      profile: profile.name,
      quality,
      representation: "color-paths",
      svg: canonical.svg,
    }
  } catch (error) {
    if (error instanceof VectorizeError && error.code === "timeout") throw error
    errors.push(
      `${variation.name}/${profile.name}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return undefined
  }
}

async function attemptAlphaMask(
  raster: LoadedRaster,
  base: Candidate,
  tool: VTracerTool,
  temporaryRoot: string,
  limits: ReturnType<typeof resolveVectorizeLimits>,
  deadline: VectorizeDeadline,
  errors: string[],
): Promise<Candidate | undefined> {
  try {
    const alphaPixels = alphaPlaneTraceRgba(raster.pixels)
    const sourcePath = join(temporaryRoot, "alpha-plane.png")
    await writeFile(
      sourcePath,
      await encodeTracePng(alphaPixels, raster.width, raster.height),
    )
    const raw = await traceRawSvg(
      tool,
      sourcePath,
      alphaMaskArgs,
      temporaryRoot,
      limits.maxOutputBytes,
      deadline,
      "alpha-mask",
    )
    const mask = canonicalizeVTracerSvg(raw, raster.width, raster.height, limits.maxPaths)
    const pathCount = base.artworkPaths.length + mask.paths.length
    if (pathCount > limits.maxPaths) {
      throw new VectorizeError("output_limit", "Alpha-masked output exceeds the path limit.")
    }
    const svg = buildAlphaMaskedSvg(
      base.artworkPaths,
      mask.paths,
      raster.width,
      raster.height,
    )
    const bytes = Buffer.byteLength(svg)
    if (bytes > limits.maxOutputBytes) {
      throw new VectorizeError("output_limit", "Alpha-masked output exceeds the byte limit.")
    }
    const quality = await scoreSvg(svg, raster, limits.maxDecodedPixels, deadline)
    return {
      alphaCutoff: base.alphaCutoff,
      artworkPaths: base.artworkPaths,
      bytes,
      maskPaths: mask.paths,
      pathCount,
      profile: base.profile,
      quality,
      representation: "alpha-mask",
      svg,
    }
  } catch (error) {
    if (error instanceof VectorizeError && error.code === "timeout") throw error
    errors.push(`alpha-mask: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

async function scoreSvg(
  svg: string,
  raster: LoadedRaster,
  maxDecodedPixels: number,
  deadline: VectorizeDeadline,
): Promise<VectorizeQualityReceipt> {
  const candidatePixels = await renderSvgRgba(
    svg,
    raster.scoreWidth,
    raster.scoreHeight,
    maxDecodedPixels,
  )
  deadline.assert("quality measurement")
  const support = measureSupport(
    raster.scorePixels,
    candidatePixels,
    raster.scoreWidth,
    raster.scoreHeight,
    1,
  )
  return {
    alphaRmse: normalizedAlphaRmse(raster.scorePixels, candidatePixels),
    colorRmse: normalizedPremultipliedRmse(raster.scorePixels, candidatePixels),
    outsideAlphaRatio: support.outsideAlphaRatio,
    sampleHeight: raster.scoreHeight,
    sampleWidth: raster.scoreWidth,
    supportRecall: support.supportRecall,
  }
}

async function traceRawSvg(
  tool: VTracerTool,
  sourcePath: string,
  args: readonly string[],
  temporaryRoot: string,
  maximumBytes: number,
  deadline: VectorizeDeadline,
  name: string,
): Promise<string> {
  const { stdout } = await runBoundedCommand(
    [tool.path, "--input", sourcePath, "--output", "/dev/stdout", ...args],
    deadline.remainingMs(),
    "trace_failed",
    { maxStdoutBytes: maximumBytes },
  )
  if (stdout.length === 0) {
    throw new VectorizeError("trace_failed", "VTracer did not emit an SVG.")
  }
  return stdout
}

function passesFastQuality(quality: VectorizeQualityReceipt): boolean {
  return (
    passesQuality(quality) &&
    quality.colorRmse <= 0.12 &&
    quality.alphaRmse <= 0.18 &&
    quality.outsideAlphaRatio <= 0.02 &&
    quality.supportRecall >= 0.97
  )
}

function passesQuality(quality: VectorizeQualityReceipt): boolean {
  return (
    quality.colorRmse <= 0.3 &&
    quality.alphaRmse <= 0.3 &&
    quality.outsideAlphaRatio <= 0.15 &&
    quality.supportRecall >= 0.8
  )
}

function compareFidelity(left: Candidate, right: Candidate): number {
  return (
    left.quality.colorRmse - right.quality.colorRmse ||
    left.quality.alphaRmse - right.quality.alphaRmse ||
    left.bytes - right.bytes ||
    left.pathCount - right.pathCount ||
    left.profile.localeCompare(right.profile)
  )
}

function selectCandidate(candidates: readonly Candidate[]): Candidate {
  const bestRmse = Math.min(...candidates.map(({ quality }) => quality.colorRmse))
  const fidelityWindow = candidates.filter(
    ({ quality }) => quality.colorRmse <= bestRmse + 0.005,
  )
  return [...fidelityWindow].sort(
    (left, right) =>
      left.bytes - right.bytes ||
      left.pathCount - right.pathCount ||
      left.quality.alphaRmse - right.quality.alphaRmse ||
      left.profile.localeCompare(right.profile) ||
      left.representation.localeCompare(right.representation),
  )[0]!
}

function roundedQuality(quality: VectorizeQualityReceipt): VectorizeQualityReceipt {
  const rounded = (value: number): number => Number(value.toFixed(8))
  return {
    alphaRmse: rounded(quality.alphaRmse),
    colorRmse: rounded(quality.colorRmse),
    outsideAlphaRatio: rounded(quality.outsideAlphaRatio),
    sampleHeight: quality.sampleHeight,
    sampleWidth: quality.sampleWidth,
    supportRecall: rounded(quality.supportRecall),
  }
}

function candidateSummary(candidate: Candidate): Readonly<Record<string, unknown>> {
  return {
    alphaCutoff: candidate.alphaCutoff,
    bytes: candidate.bytes,
    pathCount: candidate.pathCount,
    profile: candidate.profile,
    quality: roundedQuality(candidate.quality),
    representation: candidate.representation,
  }
}

async function writeSvgAtomically(path: string, svg: string): Promise<string> {
  const outputPath = resolve(path)
  await mkdir(dirname(outputPath), { recursive: true })
  const temporaryPath = `${outputPath}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, svg, { flag: "wx" })
    await rename(temporaryPath, outputPath)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw new VectorizeError(
      "output_limit",
      `Could not atomically write ${outputPath}.`,
      {},
      { cause: error },
    )
  }
  return outputPath
}
