import { constants } from "node:fs"
import { open, realpath, type FileHandle } from "node:fs/promises"
import { resolve } from "node:path"
import sharp from "sharp"
import { type VectorizeDeadline } from "./limits.ts"
import { sha256 } from "./metrics.ts"
import { VectorizeError, type VectorizeInput, type VectorizeLimits } from "./types.ts"

const allowedFormats = new Set(["avif", "gif", "heif", "jpeg", "png", "tiff", "webp"])
const METRIC_MAX_EDGE = 512

export interface LoadedRaster {
  readonly bytes: Uint8Array
  readonly format: string
  readonly height: number
  readonly inputBytes: number
  readonly pixels: Uint8Array
  readonly scoreHeight: number
  readonly scorePixels: Uint8Array
  readonly scoreWidth: number
  readonly sourceSha256: string
  readonly width: number
}

export async function loadRaster(
  input: VectorizeInput,
  limits: Readonly<VectorizeLimits>,
  deadline: VectorizeDeadline,
): Promise<LoadedRaster> {
  deadline.assert("input read")
  const bytes = await readInputBytes(input, limits.maxInputBytes, deadline)
  deadline.assert("input metadata")
  try {
    const metadata = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: limits.maxDecodedPixels,
      sequentialRead: true,
    }).metadata()
    const format = metadata.format
    if (format === undefined || !allowedFormats.has(format)) {
      throw new VectorizeError(
        "invalid_input",
        `Expected a supported raster image, received ${format ?? "an unknown format"}.`,
      )
    }
    if ((metadata.pages ?? 1) !== 1) {
      throw new VectorizeError("invalid_input", "Animated and multipage raster inputs are rejected.")
    }
    if (
      metadata.width === undefined ||
      metadata.height === undefined ||
      metadata.width < 1 ||
      metadata.height < 1
    ) {
      throw new VectorizeError("invalid_input", "Raster dimensions are missing or invalid.")
    }
    assertDimensions(metadata.width, metadata.height, limits)

    const decoded = await sharp(bytes, {
      failOn: "error",
      limitInputPixels: limits.maxDecodedPixels,
      sequentialRead: true,
    })
      .rotate()
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const { channels, height, width } = decoded.info
    if (channels !== 4) {
      throw new VectorizeError("invalid_input", "Raster decoding did not produce RGBA pixels.")
    }
    assertDimensions(width, height, limits)
    const pixels = Uint8Array.from(decoded.data)
    if (!containsVisiblePixel(pixels)) {
      throw new VectorizeError("invalid_input", "A fully transparent image cannot be vectorized.")
    }
    deadline.assert("raster decode")

    const scoreScale = Math.min(1, METRIC_MAX_EDGE / Math.max(width, height))
    const scoreWidth = Math.max(1, Math.round(width * scoreScale))
    const scoreHeight = Math.max(1, Math.round(height * scoreScale))
    const scorePixels =
      scoreWidth === width && scoreHeight === height
        ? pixels
        : Uint8Array.from(
            await sharp(pixels, { raw: { channels: 4, height, width } })
              .resize(scoreWidth, scoreHeight, { fit: "fill", kernel: "lanczos3" })
              .raw()
              .toBuffer(),
          )
    deadline.assert("metric sample")
    return {
      bytes,
      format,
      height,
      inputBytes: bytes.byteLength,
      pixels,
      scoreHeight,
      scorePixels,
      scoreWidth,
      sourceSha256: sha256(bytes),
      width,
    }
  } catch (error) {
    if (error instanceof VectorizeError) throw error
    throw new VectorizeError("invalid_input", "Raster input could not be decoded safely.", {}, {
      cause: error,
    })
  }
}

async function readInputBytes(
  input: VectorizeInput,
  maximumBytes: number,
  deadline: VectorizeDeadline,
): Promise<Uint8Array> {
  if (typeof input === "string") {
    return readRegularInput(resolve(input), maximumBytes, deadline)
  }
  const view = input instanceof ArrayBuffer ? new Uint8Array(input) : input
  if (view.byteLength === 0) {
    throw new VectorizeError("invalid_input", "Raster input is empty.")
  }
  if (view.byteLength > maximumBytes) {
    throw new VectorizeError(
      "input_limit",
      `Raster input exceeds the ${maximumBytes}-byte limit.`,
      { bytes: view.byteLength, maximumBytes },
    )
  }
  deadline.assert("input read")
  const bytes = Uint8Array.from(view)
  deadline.assert("input read")
  return bytes
}

async function readRegularInput(
  path: string,
  maximumBytes: number,
  deadline: VectorizeDeadline,
): Promise<Uint8Array> {
  let handle: FileHandle | undefined
  try {
    deadline.assert("input read")
    const targetPath = await realpath(path)
    deadline.assert("input read")
    handle = await open(targetPath, boundedReadFlags())
    const metadata = await handle.stat()
    if (!metadata.isFile()) {
      throw new VectorizeError("invalid_input", `Raster input is not a file: ${path}`)
    }
    if (metadata.size < 1) {
      throw new VectorizeError("invalid_input", "Raster input is empty.")
    }
    if (metadata.size > maximumBytes) {
      throw new VectorizeError(
        "input_limit",
        `Raster input exceeds the ${maximumBytes}-byte limit.`,
        { bytes: metadata.size, maximumBytes },
      )
    }

    const chunk = Buffer.allocUnsafe(Math.min(64 * 1_024, maximumBytes + 1))
    const chunks: Buffer[] = []
    let bytes = 0
    while (true) {
      deadline.assert("input read")
      const maximumRead = Math.min(chunk.byteLength, maximumBytes - bytes + 1)
      const { bytesRead } = await handle.read(chunk, 0, maximumRead, null)
      if (bytesRead === 0) break
      bytes += bytesRead
      if (bytes > maximumBytes) {
        throw new VectorizeError(
          "input_limit",
          `Raster input exceeds the ${maximumBytes}-byte limit.`,
          { bytes, maximumBytes },
        )
      }
      chunks.push(Buffer.from(chunk.subarray(0, bytesRead)))
    }
    if (bytes === 0) {
      throw new VectorizeError("invalid_input", "Raster input is empty.")
    }
    deadline.assert("input read")
    return Buffer.concat(chunks, bytes)
  } catch (error) {
    if (error instanceof VectorizeError) throw error
    throw new VectorizeError(
      "invalid_input",
      "Raster input could not be read safely.",
      {},
      { cause: error },
    )
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function assertDimensions(
  width: number,
  height: number,
  limits: Readonly<VectorizeLimits>,
): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > limits.maxDimension ||
    height > limits.maxDimension ||
    width * height > limits.maxDecodedPixels
  ) {
    throw new VectorizeError(
      "input_limit",
      `Raster dimensions must fit ${limits.maxDimension}px and ${limits.maxDecodedPixels} decoded pixels.`,
      { height, width },
    )
  }
}

function containsVisiblePixel(rgba: Uint8Array): boolean {
  for (let index = 3; index < rgba.length; index += 4) {
    if (rgba[index]! > 0) return true
  }
  return false
}

function boundedReadFlags(): number {
  if (process.platform === "win32") return constants.O_RDONLY
  return constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
}

export async function encodeTracePng(
  pixels: Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array> {
  return Uint8Array.from(
    await sharp(pixels, { raw: { channels: 4, height, width } })
      .png({ adaptiveFiltering: false, compressionLevel: 9, palette: false })
      .toBuffer(),
  )
}

export async function renderSvgRgba(
  svg: string,
  width: number,
  height: number,
  maxDecodedPixels: number,
): Promise<Uint8Array> {
  try {
    return Uint8Array.from(
      await sharp(Buffer.from(svg), {
        density: 72,
        failOn: "error",
        limitInputPixels: maxDecodedPixels,
      })
        .resize(width, height, { fit: "fill" })
        .ensureAlpha()
        .raw()
        .toBuffer(),
    )
  } catch (error) {
    throw new VectorizeError(
      "trace_failed",
      "Canonical SVG could not be rendered for quality measurement.",
      {},
      { cause: error },
    )
  }
}

export function sharpProvenance(): Readonly<{
  sharp: string
  sharpVersions: Readonly<Record<string, string>>
  vips: string
}> {
  const sharpVersions = normalizedPixelToolchain(sharp.versions)
  const sharpVersion = sharpVersions.sharp
  const vipsVersion = sharpVersions.vips
  if (sharpVersion === undefined || vipsVersion === undefined) {
    throw new VectorizeError(
      "tool_version",
      "Sharp must report its own and libvips version metadata.",
    )
  }
  return {
    sharp: sharpVersion,
    sharpVersions,
    vips: vipsVersion,
  }
}

export function normalizedPixelToolchain(
  versions: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const entries = Object.entries(versions)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  if (
    entries.length === 0 ||
    entries.some(([name, version]) => name.length === 0 || version.length === 0)
  ) {
    throw new VectorizeError(
      "tool_version",
      "Pixel toolchain versions must be nonempty strings.",
    )
  }
  return Object.freeze(Object.fromEntries(entries))
}
