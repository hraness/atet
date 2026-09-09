import assert from "node:assert/strict"
import { mkdtemp, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  artifactForFile, canonicalJson, compilerSha256, createStylexGeneration,
  finalizeStylexGeneration, prepareStylexProducedTemplate, readStylexPackageManifest,
  sealStylexProducedTemplate, stylexUnionPolicySha256, STYLEX_TEMPLATE_CSS_PLACEHOLDER,
} from "@hraness/ui/stylex-build"
import { collectBunStylexGraph } from "@hraness/ui/stylex-build/bun"
import { stylexVite } from "@hraness/ui/stylex-build/vite"
import { build as viteBuild, version as viteVersion } from "vite"
import { inspectPreviewCssResources } from "./preview-css"
import { readPreviewFile as bytesAt } from "./preview-file"
import { projectSiteArtifacts, siteSha256, snapshotSiteFoundation, type SiteArtifact } from "./site-contract"
import type { SiteAssets } from "../src/site-content"

const packages = [
  { name: "@hraness/design-kit", version: "0.5.2" },
  { name: "@hraness/site-footer", version: "0.6.1" },
  { name: "@hraness/ui", version: "0.5.7" },
] as const
const fontFiles = [
  ...["Light", "Book", "Medium", "Semibold", "Bold", "Black"].flatMap(weight =>
    ["", "Italic"].map(suffix => `nebula-sans/NebulaSans-${weight}${suffix}.woff2`)),
  "geist-mono/GeistMono[wght].woff2",
] as const
const documents = ["404.html", "index.html"] as const
const sourceFiles = [
  "package.json", "bun.lock", "src/index.html", "src/404.html", "src/site-shell.stylex.ts",
  "src/site-renderer.ts", "src/site-template.ts", "src/site-content.ts", "src/published-release.ts",
  "src/site-foundation.ts", "src/site-foundation.css", "src/site-ua-compatibility.css", "src/site-ask-ai-compatibility.css", "src/site-footer-compatibility.css", "src/styles.css",
  "scripts/build.ts", "scripts/build-site.ts", "scripts/site-contract.ts", "scripts/preview-css.ts", "scripts/preview-file.ts",
] as const

function below(root: string, path: string): string {
  const logical = relative(root, path).split(sep).join("/")
  assert.ok(logical !== "" && logical !== ".." && !logical.startsWith("../") && !logical.startsWith("/"), "Site compiler input escaped its physical source root")
  return logical
}

async function sourceRoot(app: string): Promise<string> {
  const candidate = resolve(app, "../..")
  if (relative(candidate, app).split(sep).join("/") !== "apps/web") return app
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(await bytesAt(join(candidate, "package.json"), 1024 * 1024)))
    if (value !== null && typeof value === "object" && "name" in value && value.name === "@hraness/atet") return candidate
  } catch (error) {
    if (!(error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error
  }
  return app
}

export type BuiltSite = Readonly<{
  files: readonly Readonly<{ artifact: SiteArtifact; bytes: Uint8Array }>[]
  stylesPath: string
  foundationPath: string
  evidenceDirectory: string
}>

/** Two complete ordinary documents share a captured SSR producer and one
 * finalized UI/design-kit/footer/product union. Compatibility CSS is captured
 * separately in the foundation and is never relabeled as migrated recipes. */
export async function buildSite(appDirectory: string, assets: SiteAssets): Promise<BuiltSite> {
  assert.equal(Bun.version, "1.3.14")
  assert.equal(viteVersion, "8.2.1")
  const app = await realpath(appDirectory)
  const root = await sourceRoot(app)
  const packageInputs = await Promise.all(packages.map(async expected => {
    const path = await realpath(fileURLToPath(import.meta.resolve(`${expected.name}/stylex-manifest.json`)))
    const manifest = await readStylexPackageManifest(path)
    assert.deepEqual(manifest.package, expected)
    return { path, ...expected, manifestSha256: siteSha256(`${canonicalJson(manifest)}\n`) }
  }))
  const fontCss = await realpath(fileURLToPath(import.meta.resolve("@hraness/design-kit/fonts.css")))
  const fonts = await Promise.all(fontFiles.map(async path => {
    const absolute = join(dirname(fontCss), "fonts", path)
    const bytes = await bytesAt(absolute, 2 * 1024 * 1024)
    return { path: below(root, absolute), sha256: siteSha256(bytes), bytes: bytes.byteLength }
  }))
  const sourcePaths = [...sourceFiles.map(path => join(app, path)), ...packageInputs.map(item => item.path), fontCss,
    ...(root === app ? [] : [join(root, "package.json"), join(root, "bun.lock")])]
  const inputs = await Promise.all(sourcePaths.map(async path => ({
    path: below(root, path), bytes: await bytesAt(path, 2 * 1024 * 1024),
  })))
  const snapshot = inputs.map(({ path, bytes }) => ({ path, bytes: bytes.byteLength, sha256: siteSha256(bytes) }))
  const fingerprint = siteSha256(canonicalJson({
    assets, bun: Bun.version, compilerSha256, fonts, inputs: snapshot,
    unionPolicySha256: stylexUnionPolicySha256, vite: viteVersion,
  }))
  const finalCssPath = `assets/site-${fingerprint}.css`
  const outputDirectory = await realpath(await mkdtemp(join(tmpdir(), "atet-web-site-")))
  try {
    const generation = await createStylexGeneration({
      expectedGraphs: [
        { adapter: "vite", entrypoints: [below(root, join(app, "src/site-foundation.ts"))], id: "site-foundation", kind: "client" },
        { adapter: "bun", entrypoints: [below(root, join(app, "src/site-renderer.ts"))], id: "site-renderer", kind: "ssr" },
      ],
      finalCssPath, generationId: "atet-site-shell", outputDirectory,
      packageManifests: packageInputs.map(item => item.path), rootDirectory: root,
      templates: documents.map(path => ({
        cssHref: `/${finalCssPath}`, graphId: "site-renderer", outputPath: path, sourcePath: path, stylesheetGraphId: "site-foundation",
      })),
    })
    const foundation = snapshotSiteFoundation(await viteBuild({
      base: "./", configFile: false, envFile: false, mode: "production",
      plugins: [stylexVite({ generation, graphId: "site-foundation", rootDirectory: root })],
    }), fonts.map(font => font.sha256), join(app, "src/site-foundation.ts"), inspectPreviewCssResources)
    const renderer = await collectBunStylexGraph({
      build: { minify: true, sourcemap: "none" }, generation, graphId: "site-renderer", rootDirectory: root,
    })
    const entries = renderer.outputs.filter(item => /^entries\/site-renderer-[A-Za-z0-9_-]+\.js$/u.test(item.path))
    assert.equal(entries.length, 1, "Site must have one captured compiled renderer entry")
    const rendererRoot = join(generation.directory, renderer.outputRoot)
    for (const item of renderer.outputs) assert.deepEqual(await artifactForFile(rendererRoot, item.path), item)
    const module: unknown = await import(pathToFileURL(join(rendererRoot, entries[0]!.path)).href)
    assert.ok(module !== null && typeof module === "object" && "renderSiteDocument" in module && typeof module.renderSiteDocument === "function")
    for (const document of documents) {
      const template = inputs.find(item => item.path === below(root, join(app, "src", document)))!
      const html: unknown = module.renderSiteDocument(new TextDecoder("utf-8", { fatal: true }).decode(template.bytes), document, assets,
        `<link rel="stylesheet" href="/${foundation.cssPath}">\n    <link rel="stylesheet" href="${STYLEX_TEMPLATE_CSS_PLACEHOLDER}">`)
      assert.ok(typeof html === "string" && Buffer.byteLength(html) <= 128 * 1024)
      assert.doesNotMatch(html, /<style\b|\sstyle\s*=/iu, "Site renderer introduced inline styling")
      const prepared = await prepareStylexProducedTemplate(generation, document)
      await writeFile(prepared.sourcePath, html, { flag: "wx", mode: 0o644 })
      await sealStylexProducedTemplate(generation, document)
    }
    const finalized = await finalizeStylexGeneration({ generation, outputDirectory, rootDirectory: root })
    const artifacts = projectSiteArtifacts(JSON.parse(new TextDecoder().decode(await bytesAt(join(finalized, "stylex-complete.json")))) as unknown, {
      compilerSha256, finalCssPath, foundation,
      packages: packageInputs.map(({ name, version, manifestSha256 }) => ({ name, version, manifestSha256 })),
      planSha256: generation.planSha256, unionPolicySha256: stylexUnionPolicySha256,
    })
    const files = await Promise.all(artifacts.map(async artifact => {
      const bytes = await bytesAt(join(finalized, artifact.path))
      assert.equal(bytes.byteLength, artifact.bytes)
      assert.equal(siteSha256(bytes), artifact.sha256)
      if (artifact.path === finalCssPath) assert.deepEqual(inspectPreviewCssResources(new TextDecoder("utf-8", { fatal: true }).decode(bytes), artifact.path), [],
        "Site recipes must not introduce resources outside the captured foundation")
      return { artifact, bytes }
    }))
    for (const input of snapshot) assert.deepEqual(await artifactForFile(root, input.path), input, "Site source or compiler input changed during compilation")
    for (const font of fonts) assert.deepEqual(await artifactForFile(root, font.path), font, "Site installed font changed during compilation")
    return { evidenceDirectory: finalized, files, foundationPath: `/${foundation.cssPath}`, stylesPath: `/${finalCssPath}` }
  } catch (error) {
    throw new Error(`Site compilation failed; retained evidence: ${outputDirectory}`, { cause: error })
  }
}
