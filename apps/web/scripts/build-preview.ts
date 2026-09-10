import assert from "node:assert/strict"
import { mkdtemp, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  artifactForFile, canonicalJson, compilerSha256, createStylexGeneration,
  finalizeStylexGeneration, prepareStylexProducedTemplate, readStylexPackageManifest, sealStylexProducedTemplate,
  stylexUnionPolicySha256, STYLEX_TEMPLATE_CSS_PLACEHOLDER,
} from "@hraness/ui/stylex-build"
import { collectBunStylexGraph } from "@hraness/ui/stylex-build/bun"
import { stylexVite } from "@hraness/ui/stylex-build/vite"
import { build as viteBuild, version as viteVersion } from "vite"

import { previewSha256, projectPreviewArtifacts, snapshotPreviewFoundation, type PreviewArtifact } from "./preview-contract"
import { inspectPreviewCssResources } from "./preview-css"
import { readPreviewFile as bytesAt } from "./preview-file"

const fontFiles = [
  ...["Light", "Book", "Medium", "Semibold", "Bold", "Black"].flatMap(weight =>
    ["", "Italic"].map(suffix => `nebula-sans/NebulaSans-${weight}${suffix}.woff2`)),
  "geist-mono/GeistMono[wght].woff2",
] as const
const sourceFiles = [
  "package.json", "bun.lock", "src/preview.html", "src/preview.stylex.ts",
  "src/preview-renderer.ts", "src/preview-foundation.ts", "src/preview-foundation.css", "src/styles.css",
  "scripts/build-preview.ts", "scripts/preview-contract.ts", "scripts/preview-css.ts", "scripts/preview-file.ts",
] as const

function below(root: string, path: string): string {
  const logical = relative(root, path).split(sep).join("/")
  assert.ok(logical !== "" && logical !== ".." && !logical.startsWith("../") && !logical.startsWith("/"), "Preview compiler input escaped its physical source root")
  return logical
}

/** Support both the repository workspace install and an isolated apps/web copy.
 * No sibling checkout or external dependency installation is an input root. */
async function sourceRoot(app: string): Promise<string> {
  const candidate = resolve(app, "../..")
  if (relative(candidate, app).split(sep).join("/") !== "apps/web") return app
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(await bytesAt(join(candidate, "package.json"), 1024 * 1024)))
    if (value !== null && typeof value === "object" && "name" in value && value.name === "@hraness/slopcamera") return candidate
  } catch (error) {
    if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
  }
  return app
}

export type BuiltPreview = Readonly<{
  files: readonly Readonly<{ artifact: PreviewArtifact; bytes: Uint8Array }>[]
  stylesPath: string
  foundationPath: string
  evidenceDirectory: string
}>

/** Compile and seal only /preview. The normal site's compatibility route is
 * deliberately independent and never loads this finalized recipe sheet. */
export async function buildPreview(appDirectory: string): Promise<BuiltPreview> {
  assert.equal(Bun.version, "1.3.14")
  assert.equal(viteVersion, "8.2.1")
  const app = await realpath(appDirectory)
  const root = await sourceRoot(app)
  const manifestPath = await realpath(fileURLToPath(import.meta.resolve("@hraness/ui/stylex-manifest.json")))
  const manifest = await readStylexPackageManifest(manifestPath)
  assert.deepEqual(manifest.package, { name: "@hraness/ui", version: "0.5.7" })
  const manifestSha256 = previewSha256(`${canonicalJson(manifest)}\n`)
  const fontCss = await realpath(fileURLToPath(import.meta.resolve("@hraness/design-kit/fonts.css")))
  const fonts = await Promise.all(fontFiles.map(async path => {
    const absolute = join(dirname(fontCss), "fonts", path)
    const bytes = await bytesAt(absolute, 2 * 1024 * 1024)
    return { path: below(root, absolute), sha256: previewSha256(bytes), bytes: bytes.byteLength }
  }))
  const sourcePaths = [...sourceFiles.map(path => join(app, path)), manifestPath, fontCss,
    ...(root === app ? [] : [join(root, "package.json"), join(root, "bun.lock")])]
  const inputs = await Promise.all(sourcePaths.map(async path => ({
    path: below(root, path), bytes: await bytesAt(path, 2 * 1024 * 1024),
  })))
  const snapshot = inputs.map(({ path, bytes }) => ({ path, bytes: bytes.byteLength, sha256: previewSha256(bytes) }))
  // The public finalizer needs its final URL before compilation. This address
  // binds the complete authored/toolchain/package input set, not a guessed CSS
  // byte hash. The completion record separately binds the actual emitted bytes.
  const fingerprint = previewSha256(canonicalJson({
    bun: Bun.version, compilerSha256, fonts, inputs: snapshot,
    unionPolicySha256: stylexUnionPolicySha256, vite: viteVersion,
  }))
  const finalCssPath = `assets/preview-${fingerprint}.css`
  const outputDirectory = await realpath(await mkdtemp(join(tmpdir(), "slopcamera-web-preview-")))
  try {
    const generation = await createStylexGeneration({
      expectedGraphs: [
        { adapter: "vite", entrypoints: [below(root, join(app, "src/preview-foundation.ts"))], id: "preview-foundation", kind: "client" },
        { adapter: "bun", entrypoints: [below(root, join(app, "src/preview-renderer.ts"))], id: "preview-renderer", kind: "ssr" },
      ],
      finalCssPath, generationId: "slopcamera-preview", outputDirectory,
      packageManifests: [manifestPath], rootDirectory: root,
      templates: [{ cssHref: `/${finalCssPath}`, graphId: "preview-renderer", outputPath: "preview.html", sourcePath: "preview.html", stylesheetGraphId: "preview-foundation" }],
    })
    const foundation = snapshotPreviewFoundation(await viteBuild({
      base: "./", configFile: false, envFile: false, mode: "production",
      plugins: [stylexVite({ generation, graphId: "preview-foundation", rootDirectory: root })],
    }), fonts.map(font => font.sha256), join(app, "src/preview-foundation.ts"), inspectPreviewCssResources)
    const renderer = await collectBunStylexGraph({
      build: { minify: true, sourcemap: "none" }, generation, graphId: "preview-renderer", rootDirectory: root,
    })
    const entries = renderer.outputs.filter(item => /^entries\/preview-renderer-[A-Za-z0-9_-]+\.js$/u.test(item.path))
    assert.equal(entries.length, 1, "Preview must have one captured compiled renderer entry")
    const entry = entries[0]!
    const rendererRoot = join(generation.directory, renderer.outputRoot)
    for (const item of renderer.outputs) assert.deepEqual(await artifactForFile(rendererRoot, item.path), item)
    const module: unknown = await import(pathToFileURL(join(rendererRoot, entry.path)).href)
    assert.ok(module !== null && typeof module === "object" && "renderPreviewDocument" in module && typeof module.renderPreviewDocument === "function")
    const template = inputs.find(item => item.path === below(root, join(app, "src/preview.html")))!
    const html: unknown = module.renderPreviewDocument(new TextDecoder().decode(template.bytes),
      `<link rel="stylesheet" href="/${foundation.cssPath}">\n    <link rel="stylesheet" href="${STYLEX_TEMPLATE_CSS_PLACEHOLDER}">`)
    assert.ok(typeof html === "string" && Buffer.byteLength(html) <= 64 * 1024)
    assert.doesNotMatch(html, /<script\b|<style\b|\sstyle\s*=|<a\b|<button\b|<form\b|<input\b|<select\b|<textarea\b|contenteditable/iu, "Preview renderer violated its inert document boundary")
    const prepared = await prepareStylexProducedTemplate(generation, "preview.html")
    await writeFile(prepared.sourcePath, html, { flag: "wx", mode: 0o644 })
    await sealStylexProducedTemplate(generation, "preview.html")
    const finalized = await finalizeStylexGeneration({ generation, outputDirectory, rootDirectory: root })
    const artifacts = projectPreviewArtifacts(JSON.parse(new TextDecoder().decode(await bytesAt(join(finalized, "stylex-complete.json")))) as unknown, {
      compilerSha256, finalCssPath, foundation, manifestSha256,
      planSha256: generation.planSha256, unionPolicySha256: stylexUnionPolicySha256,
    })
    const files = await Promise.all(artifacts.map(async artifact => {
      const bytes = await bytesAt(join(finalized, artifact.path))
      assert.equal(bytes.byteLength, artifact.bytes)
      assert.equal(previewSha256(bytes), artifact.sha256)
      if (artifact.path === finalCssPath) {
        assert.deepEqual(inspectPreviewCssResources(new TextDecoder("utf-8", { fatal: true }).decode(bytes), artifact.path), [],
          "Preview recipes must not introduce resources outside the captured foundation")
      }
      return { artifact, bytes }
    }))
    for (const input of snapshot) assert.deepEqual(await artifactForFile(root, input.path), input, "Preview source or compiler input changed during compilation")
    for (const font of fonts) assert.deepEqual(await artifactForFile(root, font.path), font, "Preview installed font changed during compilation")
    return { evidenceDirectory: finalized, files, foundationPath: `/${foundation.cssPath}`, stylesPath: `/${finalCssPath}` }
  } catch (error) {
    throw new Error(`Preview compilation failed; retained evidence: ${outputDirectory}`, { cause: error })
  }
}
