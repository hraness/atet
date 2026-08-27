import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { Resvg } from "@resvg/resvg-js"

const appDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const sourceDirectory = join(appDirectory, "src")
const sourcePath = join(sourceDirectory, "og-source.svg")
const serifHeroPath = join(sourceDirectory, "og-serif-hero.png")
const checkedOutputPath = join(sourceDirectory, "og.png")
const maximumSocialImageBytes = 2 * 1_024 * 1_024
const rendererVersion = "2.6.2"
const serifHero = Object.freeze({
  bytes: 35_859,
  height: 630,
  sha256: "4a4a132a6f8fd781df0c5804797799dc4179e56ab819de79f33fbeecc99b2f52",
  width: 1_200,
})
const fonts = Object.freeze([
  Object.freeze({
    bytes: 140_008,
    path: fileURLToPath(import.meta.resolve(
      "@hraness/design-kit/fonts/nebula-sans/NebulaSans-Book.otf",
    )),
    sha256: "4cc650f856591af1affc4add4f50e260c8239a2542bafe77909b78006023f091",
  }),
  Object.freeze({
    bytes: 145_348,
    path: fileURLToPath(import.meta.resolve(
      "@hraness/design-kit/fonts/nebula-sans/NebulaSans-Bold.otf",
    )),
    sha256: "91617d3e2281e8213f64f6bf359f387022d3149b35000b38365c32130a25bfa8",
  }),
])

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function assertExactAsset(
  bytes: Uint8Array,
  expected: Readonly<{ bytes: number; sha256: string }>,
  label: string,
): void {
  if (bytes.byteLength !== expected.bytes || sha256(bytes) !== expected.sha256) {
    throw new Error(`${label} does not match its checked provenance`)
  }
}

async function verifiedRendererVersion(): Promise<void> {
  const manifestPath = fileURLToPath(import.meta.resolve("@resvg/resvg-js/package.json"))
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown
  if (
    typeof manifest !== "object"
    || manifest === null
    || !("version" in manifest)
    || manifest.version !== rendererVersion
  ) {
    throw new Error(`Atet social rendering requires @resvg/resvg-js ${rendererVersion}`)
  }
}

export async function renderAtetSocialImage(): Promise<Uint8Array> {
  await verifiedRendererVersion()
  const [source, hero, fontBytes] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(serifHeroPath),
    Promise.all(fonts.map(async font => await readFile(font.path))),
  ])
  assertExactAsset(hero, serifHero, "Checked serif hero raster")
  const heroView = new DataView(hero.buffer, hero.byteOffset, hero.byteLength)
  if (
    heroView.getUint32(16) !== serifHero.width
    || heroView.getUint32(20) !== serifHero.height
  ) {
    throw new Error("Checked serif hero raster dimensions changed")
  }
  fonts.forEach((font, index) => {
    const bytes = fontBytes[index]
    if (bytes === undefined) throw new Error("Canonical social font is missing")
    assertExactAsset(bytes, font, "Canonical Nebula Sans social font")
  })

  const heroReference = 'href="og-serif-hero.png"'
  if (source.split(heroReference).length !== 2) {
    throw new Error("Social SVG must contain exactly one checked serif hero reference")
  }
  const resolved = source.replace(
    heroReference,
    `href="data:image/png;base64,${hero.toString("base64")}"`,
  )
  const rendered = new Resvg(resolved, {
    font: {
      defaultFontFamily: "Nebula Sans",
      fontFiles: fonts.map(font => font.path),
      loadSystemFonts: false,
      sansSerifFamily: "Nebula Sans",
    },
    shapeRendering: 2,
    textRendering: 2,
  }).render()
  if (rendered.width !== 1_200 || rendered.height !== 630) {
    throw new Error("Generated social image dimensions changed")
  }
  const png = new Uint8Array(rendered.asPng())
  if (png.byteLength <= 0 || png.byteLength > maximumSocialImageBytes) {
    throw new Error("Generated social image exceeds its byte bound")
  }
  return png
}

if (import.meta.main) {
  const png = await renderAtetSocialImage()
  await writeFile(checkedOutputPath, png)
  console.log(`Generated ${png.byteLength} bytes at ${checkedOutputPath}`)
}
