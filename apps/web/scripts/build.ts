import { createHash } from "node:crypto"
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { renderSlopcameraSocialImage } from "./generate-og"
import { buildPreview } from "./build-preview"
import type { PreviewArtifact } from "./preview-contract"
import { buildSite } from "./build-site"
import type { SiteArtifact } from "./site-contract"
export { renderAskAiAboutThis } from "../src/site-content"
import {
  homeMarkdown,
  llmsTxt,
  robotsTxt,
  sitemapMarkdown,
} from "../src/agent-pages"

const appDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const sourceDirectory = join(appDirectory, "src")
const defaultOutputDirectory = join(appDirectory, "dist")
const posthogIngestOrigin = "https://us.i.posthog.com"
const siteOrigin = "https://slop.camera"
const posthogPackageDirectory = dirname(fileURLToPath(import.meta.resolve("posthog-js/package.json")))
const copiedFiles = [
  "apple-touch-icon.png",
  "icon.svg",
] as const

const generatedTextFiles = {
  "index.md": homeMarkdown,
  "llms.txt": llmsTxt,
  "robots.txt": robotsTxt,
  "sitemap.xml": renderSitemapXml(),
  "sitemap.md": sitemapMarkdown,
} as const

function assetPath(name: string, bytes: Uint8Array): string {
  const digest = createHash("sha256").update(bytes).digest("hex").slice(0, 12)
  const extensionIndex = name.lastIndexOf(".")
  const stem = name.slice(0, extensionIndex)
  const extension = name.slice(extensionIndex)
  return `/assets/${stem}-${digest}${extension}`
}

function renderSitemapUrl(
  path: string,
  lastmod: string,
  priority: string,
): string {
  return `  <url>
    <loc>${siteOrigin}${path}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${path === "/" ? "weekly" : "monthly"}</changefreq>
    <priority>${priority}</priority>
  </url>`
}

export function renderSitemapXml(): string {
  const entries = [
    renderSitemapUrl("/", "2026-09-09", "1.0"),
    renderSitemapUrl("/index.md", "2026-09-09", "0.8"),
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join("\n")}
</urlset>
`
}

type BuildEnvironment = Readonly<Record<string, string | undefined>>

type BuildOptions = Readonly<{
  environment?: BuildEnvironment
  outputDirectory?: string
}>

function productionAnalyticsConfig(environment: BuildEnvironment): Readonly<{
  host: string
  key: string
}> | null {
  const key = environment.NEXT_PUBLIC_POSTHOG_KEY?.trim()
  if (environment.VERCEL_ENV !== "production" || key === undefined || key === "") {
    return null
  }
  if (!/^phc_[A-Za-z0-9_-]+$/u.test(key)) {
    throw new Error("NEXT_PUBLIC_POSTHOG_KEY must be a PostHog project token")
  }

  const host = environment.NEXT_PUBLIC_POSTHOG_HOST?.trim() || posthogIngestOrigin
  if (host !== posthogIngestOrigin) {
    throw new Error(`NEXT_PUBLIC_POSTHOG_HOST must equal ${posthogIngestOrigin}`)
  }
  return { host, key }
}

async function bundleAnalytics(config: Readonly<{ host: string; key: string }>): Promise<Uint8Array> {
  const [license, manifestSource] = await Promise.all([
    readFile(join(posthogPackageDirectory, "LICENSE"), "utf8"),
    readFile(join(posthogPackageDirectory, "package.json"), "utf8"),
  ])
  const manifest = JSON.parse(manifestSource) as unknown
  if (
    typeof manifest !== "object"
    || manifest === null
    || !("version" in manifest)
    || typeof manifest.version !== "string"
    || license.includes("*/")
  ) {
    throw new Error("The installed PostHog package has an invalid license boundary")
  }
  const result = await Bun.build({
    banner: `/*! posthog-js ${manifest.version}\n${license.trim()}\n*/`,
    define: {
      __SLOPCAMERA_POSTHOG_HOST__: JSON.stringify(config.host),
      __SLOPCAMERA_POSTHOG_KEY__: JSON.stringify(config.key),
    },
    entrypoints: [join(sourceDirectory, "analytics.ts")],
    env: "disable",
    format: "esm",
    minify: true,
    sourcemap: "none",
    target: "browser",
  })
  const output = result.outputs[0]
  if (!result.success || result.outputs.length !== 1 || output === undefined) {
    const details = result.logs.map(log => log.message).join("\n")
    throw new Error(`Could not bundle the analytics client${details === "" ? "" : `: ${details}`}`)
  }
  return new Uint8Array(await output.arrayBuffer())
}

async function bundleTheme(): Promise<Uint8Array> {
  const result = await Bun.build({
    entrypoints: [join(sourceDirectory, "theme.ts")],
    env: "disable",
    format: "iife",
    minify: true,
    sourcemap: "none",
    target: "browser",
  })
  const output = result.outputs[0]
  if (!result.success || result.outputs.length !== 1 || output === undefined) {
    const details = result.logs.map(log => log.message).join("\n")
    throw new Error(`Could not bundle the appearance client${details === "" ? "" : `: ${details}`}`)
  }
  return new Uint8Array(await output.arrayBuffer())
}

export async function buildWebsite(options: BuildOptions = {}): Promise<Readonly<{
  analyticsPath: string | null
  previewArtifacts: readonly PreviewArtifact[]
  previewEvidenceDirectory: string
  previewFoundationPath: string
  previewStylesPath: string
  stylesPath: string
  siteArtifacts: readonly SiteArtifact[]
  siteEvidenceDirectory: string
  siteFoundationPath: string
  themePath: string
}>> {
  const environment = options.environment ?? process.env
  const outputDirectory = options.outputDirectory ?? defaultOutputDirectory
  const analyticsConfig = productionAnalyticsConfig(environment)
  const [theme, socialImage] = await Promise.all([
    bundleTheme(), renderSlopcameraSocialImage(),
  ])
  const themePath = assetPath("theme.js", theme)
  const analytics = analyticsConfig === null ? null : await bundleAnalytics(analyticsConfig)
  const analyticsPath = analytics === null ? null : assetPath("analytics.js", analytics)
  // Finalize both independent closed graphs before replacing a public build.
  // All content and stylesheet substitutions happen inside the sealed producers.
  const site = await buildSite(appDirectory, { themePath, analyticsPath })
  const preview = await buildPreview(appDirectory)

  await rm(outputDirectory, { force: true, recursive: true })
  await mkdir(join(outputDirectory, "assets"), { recursive: true })

  await Promise.all([
    ...[...site.files, ...preview.files].map(async ({ artifact, bytes }) => {
      const destination = join(outputDirectory, artifact.path)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, bytes, { flag: "wx", mode: 0o644 })
    }),
    writeFile(join(outputDirectory, themePath.slice(1)), theme),
    writeFile(join(outputDirectory, "og.png"), socialImage),
    ...(analyticsPath === null || analytics === null
      ? []
      : [writeFile(join(outputDirectory, analyticsPath.slice(1)), analytics)]),
  ])

  for (const file of copiedFiles) {
    const source = join(sourceDirectory, file)
    const sourceStat = await stat(source)
    if (!sourceStat.isFile()) {
      throw new Error(`Static source is not a regular file: ${basename(source)}`)
    }
    await cp(source, join(outputDirectory, file), {
      dereference: true,
      errorOnExist: true,
    })
  }

  await Promise.all(Object.entries(generatedTextFiles).map(([file, contents]) => (
    writeFile(join(outputDirectory, file), contents)
  )))

  return {
    analyticsPath, stylesPath: site.stylesPath, themePath,
    siteArtifacts: site.files.map(item => item.artifact),
    siteEvidenceDirectory: site.evidenceDirectory,
    siteFoundationPath: site.foundationPath,
    previewArtifacts: preview.files.map(item => item.artifact),
    previewEvidenceDirectory: preview.evidenceDirectory,
    previewFoundationPath: preview.foundationPath,
    previewStylesPath: preview.stylesPath,
  }
}

if (import.meta.main) {
  const result = await buildWebsite()
  const generatedFiles = copiedFiles.length
    + Object.keys(generatedTextFiles).length
    + 2 + result.siteArtifacts.length + result.previewArtifacts.length
    + (result.analyticsPath === null ? 0 : 1)
  console.log(`Built ${generatedFiles} static files in ${defaultOutputDirectory}`)
  console.log(`Site compiler evidence retained in ${result.siteEvidenceDirectory}`)
  console.log(`Preview compiler evidence retained in ${result.previewEvidenceDirectory}`)
}
