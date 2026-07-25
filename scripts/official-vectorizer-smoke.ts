import { createHash } from "node:crypto"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import sharp from "sharp"
import {
  VTRACER_VERSION,
  vectorizeImage,
  vtracerReleases,
} from "../dist/index.js"

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex")
}

const expectedReleaseHashes = Object.freeze({
  "darwin-arm64": Object.freeze({
    archive: "4a597fd2df8b961d60620df40a7436109427d86e5c028758e6e8796b02d3d996",
    binary: "77e495bbe212448240387fba3b6d8bc62ba20ecfb6f3c22967e51600f1cc6e66",
  }),
  "darwin-x64": Object.freeze({
    archive: "f0d755292c2602d772d63d658a3498b23eca8b5620d4b92a991bd035d5abed16",
    binary: "0f9f88f989b757e27973a5c4b42665153070183d0787656ee8af2249ab326b78",
  }),
  "linux-arm64": Object.freeze({
    archive: "cbd05ad4f491d12dd139ada61485ca1d24db9f981cbe1658632a083cd0ac1a71",
    binary: "a4b33b6c4066a6b9187802c6efc8b89e211318e12a17164b9d1dd1f29ac5e502",
  }),
  "linux-x64": Object.freeze({
    archive: "9290ba0c90e224d6d212836dff5491407c1718bcb72f80b2b5a4a01816df5e40",
    binary: "6f31499257076bd94de3e976844cf7ca5643f1e194a2bf0599b13f3719452aec",
  }),
  "win32-x64": Object.freeze({
    archive: "6b5bc17a6b017129ee40461df254f65d16f3b494c001a8541d41861066b716bf",
    binary: "4ad8d35e566cd15caf582063b8349bd082b8fa2bd461e99d116fc63ad8fdeca0",
  }),
})

const expectedPlatform = process.env.EXPECTED_PLATFORM ?? process.platform
const expectedArch = process.env.EXPECTED_ARCH ?? process.arch
invariant(
  process.platform === expectedPlatform && process.arch === expectedArch,
  `Runner is ${process.platform}/${process.arch}, expected ${expectedPlatform}/${expectedArch}.`,
)
invariant(
  process.env.GRAPHICS_VTRACER_PATH === undefined,
  "Official VTracer smoke must not use GRAPHICS_VTRACER_PATH.",
)

const releaseKey = `${process.platform}-${process.arch}`
const release =
  vtracerReleases[releaseKey as keyof typeof vtracerReleases]
invariant(release !== undefined, `No official VTracer pin for ${releaseKey}.`)
const expectedRelease =
  expectedReleaseHashes[releaseKey as keyof typeof expectedReleaseHashes]
invariant(
  expectedRelease !== undefined,
  `Smoke test has no reviewed release hash for ${releaseKey}.`,
)
invariant(
  release.archiveSha256 === expectedRelease.archive &&
    release.binarySha256 === expectedRelease.binary,
  `VTracer release metadata changed for ${releaseKey}.`,
)

const work = await mkdtemp(join(tmpdir(), "graphics-official-vtracer-"))
try {
  // Generated in memory, so this smoke fixture carries no third-party rights.
  const raster = await sharp({
    create: {
      background: { alpha: 1, b: 160, g: 96, r: 32 },
      channels: 4,
      height: 16,
      width: 16,
    },
  })
    .png()
    .toBuffer()
  const outputPath = join(work, "solid.svg")
  const cacheDirectory = join(work, "empty-cache")
  if (process.platform === "win32") {
    let failure: unknown
    try {
      await vectorizeImage(raster, {
        cacheDirectory,
        limits: { maxDurationMs: 120_000 },
        outputPath,
      })
    } catch (error) {
      failure = error
    }
    invariant(
      isErrorCode(failure, "tool_platform"),
      "Windows vectorization did not fail closed with tool_platform.",
    )
    invariant(
      !(await pathExists(cacheDirectory)),
      "Windows fail-closed path acquired VTracer before rejecting the platform.",
    )
    invariant(
      !(await pathExists(outputPath)),
      "Windows fail-closed path published an output.",
    )
    process.stdout.write(
      `Verified VTracer ${VTRACER_VERSION} ${releaseKey} metadata and fail-closed platform contract\n`,
    )
  } else {
    const result = await vectorizeImage(raster, {
      cacheDirectory,
      limits: { maxDurationMs: 120_000 },
      outputPath,
    })
    const published = await readFile(outputPath, "utf8")

    invariant(result.svg === published, "Published SVG differs from the result.")
    invariant(
      result.receipt.provenance.vtracerSource === "official-release",
      "Receipt does not identify the official VTracer release.",
    )
    invariant(
      result.receipt.provenance.vtracerVersion === VTRACER_VERSION,
      "Receipt contains the wrong VTracer version.",
    )
    invariant(
      result.receipt.provenance.vtracerSha256 === expectedRelease.binary,
      "Receipt VTracer hash differs from the pinned official binary.",
    )
    invariant(
      result.receipt.sourceSha256 === sha256(raster),
      "Receipt source hash differs from the generated raster.",
    )
    invariant(
      result.receipt.svgSha256 === sha256(result.svg),
      "Receipt SVG hash differs from the published SVG.",
    )
    invariant(
      result.receipt.provenance.platform === process.platform &&
        result.receipt.provenance.arch === process.arch,
      "Receipt platform does not match the runner.",
    )
    invariant(
      result.receipt.pathCount > 0 && result.receipt.bytes > 0,
      "Official VTracer produced an empty vector.",
    )

    process.stdout.write(
      `Verified VTracer ${VTRACER_VERSION} ${releaseKey} ${expectedRelease.binary}\n`,
    )
  }
} finally {
  await rm(work, { force: true, recursive: true })
}

function isErrorCode(value: unknown, code: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    value.code === code
  )
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
