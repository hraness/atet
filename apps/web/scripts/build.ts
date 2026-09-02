import { createHash } from "node:crypto"
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { renderHranessSiteFooter } from "@hraness/site-footer"
import { AskAiAboutThis } from "@hraness/ui"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import { renderAtetSocialImage } from "./generate-og"
import {
  homeMarkdown,
  llmsTxt,
  readingIndexMarkdown,
  readingPaintWithCodeMarkdown,
  robotsTxt,
  sitemapMarkdown,
} from "../src/agent-pages"
import {
  editorialImageSrcSet,
  editorialImageUrl,
  editorialReading,
  editorialReadings,
  type EditorialReading,
  type EditorialReadingPath,
} from "../src/editorial-images"

const appDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const sourceDirectory = join(appDirectory, "src")
const defaultOutputDirectory = join(appDirectory, "dist")
const posthogIngestOrigin = "https://us.i.posthog.com"
const siteOrigin = "https://atet.sh"
const posthogPackageDirectory = dirname(fileURLToPath(import.meta.resolve("posthog-js/package.json")))
const appearanceMenuStylesPath = fileURLToPath(
  import.meta.resolve("@hraness/design-kit/appearance-menu.css"),
)
const designKitFontsStylesPath = fileURLToPath(
  import.meta.resolve("@hraness/design-kit/fonts.css"),
)
const designKitProductMarketingStylesPath = fileURLToPath(
  import.meta.resolve("@hraness/design-kit/product-marketing.css"),
)
const designKitFontsDirectory = join(dirname(designKitFontsStylesPath), "fonts")
const hranessSiteFooterStylesPath = fileURLToPath(
  import.meta.resolve("@hraness/site-footer/styles.css"),
)

const copiedFiles = [
  "apple-touch-icon.png",
  "icon.svg",
] as const

const generatedTextFiles = {
  "index.md": homeMarkdown,
  "llms.txt": llmsTxt,
  "reading/index.md": readingIndexMarkdown,
  "reading/paint-with-code.md": readingPaintWithCodeMarkdown,
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

function renderDocument(template: string, assets: Readonly<Record<string, string>>): string {
  let rendered = template
  for (const [placeholder, value] of Object.entries(assets)) {
    if (!rendered.includes(placeholder)) {
      throw new Error(`Static document is missing ${placeholder}`)
    }
    rendered = rendered.replaceAll(placeholder, value)
  }
  if (/\{\{[A-Z0-9_]+\}\}/u.test(rendered)) {
    throw new Error("Static document contains an unresolved placeholder")
  }
  return rendered
}

function renderAppearanceMenu(): string {
  return `<div aria-busy="true" class="hraness-design-theme-toggle"
      data-display="icons" data-hraness-appearance-menu data-presentation="menu"
      data-ready="false" data-theme-value="system">
    <button aria-controls="appearance-menu" aria-expanded="false" aria-haspopup="menu"
      aria-label="Appearance: System" class="hraness-design-theme-toggle__trigger"
      disabled type="button">
      <span aria-hidden="true" data-current-appearance-icon="system"></span>
    </button>
    <div class="hraness-design-theme-toggle__popover" hidden>
      <div aria-label="Appearance" class="hraness-design-theme-toggle__menu"
        id="appearance-menu" role="menu">
        <div aria-checked="false" class="hraness-design-theme-toggle__item"
          data-theme-value="light" role="menuitemradio" tabindex="-1">
          <span aria-hidden="true" data-appearance-icon="light"></span><span>Light</span>
        </div>
        <div aria-checked="false" class="hraness-design-theme-toggle__item"
          data-theme-value="dark" role="menuitemradio" tabindex="-1">
          <span aria-hidden="true" data-appearance-icon="dark"></span><span>Dark</span>
        </div>
        <div aria-checked="true" class="hraness-design-theme-toggle__item"
          data-selected="true" data-theme-value="system" role="menuitemradio" tabindex="-1">
          <span aria-hidden="true" data-appearance-icon="system"></span><span>System</span>
        </div>
      </div>
    </div>
  </div>`
}

export function renderAskAiAboutThis(canonicalUrl: string): string {
  return renderToStaticMarkup(createElement(AskAiAboutThis, {
    className: "atet-ask-ai",
    url: canonicalUrl,
  }))
}

type CopyCommandOptions = Readonly<{
  alternateCommand: string
  command: string
  id: string
}>

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character)
}

function escapeXml(value: string): string {
  return escapeHtml(value).replaceAll("'", "&apos;")
}

function renderEditorialFigure(reading: EditorialReading): string {
  return `<figure class="editorial-figure">
          <img alt="${escapeHtml(reading.alt)}" decoding="async" fetchpriority="high"
            height="${reading.height}" sizes="(max-width: 72rem) calc(100vw - 2rem), 72rem"
            src="${reading.src}" srcset="${editorialImageSrcSet(reading)}" width="${reading.width}">
          <figcaption><span>${escapeHtml(reading.caption)}</span><small>${escapeHtml(reading.credit)}</small></figcaption>
        </figure>`
}

function renderReadingCards(): string {
  return editorialReadings.map(reading => `<article class="reading-card">
    <a href="${reading.canonicalPath}">
      <img alt="" decoding="async" height="${reading.height}" loading="lazy"
        sizes="(max-width: 44rem) calc(100vw - 2rem), 50vw" src="${reading.src}"
        srcset="${editorialImageSrcSet(reading)}" width="${reading.width}">
      <div>
        <p class="eyebrow">Reading · ${escapeHtml(reading.datePublished)}</p>
        <h3>${escapeHtml(reading.title)}</h3>
        <p>${escapeHtml(reading.description)}</p>
      </div>
    </a>
  </article>`).join("\n")
}

function renderEditorialAssets(path: EditorialReadingPath): Readonly<Record<string, string>> {
  const reading = editorialReading(path)
  return {
    "{{EDITORIAL_FIGURE}}": renderEditorialFigure(reading),
    "{{EDITORIAL_IMAGE_ALT}}": escapeHtml(reading.alt),
    "{{EDITORIAL_IMAGE_HEIGHT}}": String(reading.height),
    "{{EDITORIAL_IMAGE_JSON}}": JSON.stringify({
      "@type": "ImageObject",
      contentUrl: editorialImageUrl(reading),
      height: reading.height,
      width: reading.width,
    }),
    "{{EDITORIAL_IMAGE_URL}}": editorialImageUrl(reading),
    "{{EDITORIAL_IMAGE_WIDTH}}": String(reading.width),
  }
}

function renderSitemapImages(readings: readonly EditorialReading[]): string {
  return readings.map(reading => `    <image:image>
      <image:loc>${escapeXml(editorialImageUrl(reading))}</image:loc>
      <image:title>${escapeXml(reading.title)}</image:title>
      <image:caption>${escapeXml(reading.caption)}</image:caption>
    </image:image>`).join("\n")
}

function renderSitemapUrl(
  path: string,
  lastmod: string,
  priority: string,
  readings: readonly EditorialReading[] = [],
): string {
  const images = readings.length === 0 ? "" : `\n${renderSitemapImages(readings)}`
  return `  <url>
    <loc>${siteOrigin}${path}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${path === "/" ? "weekly" : "monthly"}</changefreq>
    <priority>${priority}</priority>${images}
  </url>`
}

export function renderSitemapXml(): string {
  const entries = [
    renderSitemapUrl("/", "2026-09-01", "1.0", editorialReadings),
    renderSitemapUrl("/index.md", "2026-09-01", "0.8"),
    renderSitemapUrl("/reading", "2026-09-01", "0.8", editorialReadings),
    renderSitemapUrl("/reading/index.md", "2026-09-01", "0.6"),
    ...editorialReadings.flatMap(reading => [
      renderSitemapUrl(reading.canonicalPath, reading.datePublished, "0.7", [reading]),
      renderSitemapUrl(`${reading.canonicalPath}.md`, reading.datePublished, "0.6"),
    ]),
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${entries.join("\n")}
</urlset>
`
}

function renderCopyCommand(options: CopyCommandOptions): string {
  const alternateCommand = escapeHtml(options.alternateCommand)
  const command = escapeHtml(options.command)
  const id = escapeHtml(options.id)

  return `<div class="copy-command" data-copy-command>
    <code class="copy-command__value" data-copy-command-value>${command}</code>
    <button aria-describedby="${id}" aria-label="Copy install command" class="copy-command__button"
      data-copy-command-button hidden type="button">Copy</button>
    <p class="copy-command__note">Using Bun? <code>${alternateCommand}</code></p>
    <p aria-atomic="true" aria-live="polite" class="copy-command__status"
      data-copy-command-status id="${id}"></p>
  </div>`
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
      __ATET_POSTHOG_HOST__: JSON.stringify(config.host),
      __ATET_POSTHOG_KEY__: JSON.stringify(config.key),
    },
    entrypoints: [join(sourceDirectory, "analytics.ts")],
    env: "disable",
    format: "esm",
    minify: true,
    sourcemap: "none",
    target: "browser",
  })
  if (!result.success || result.outputs.length !== 1) {
    const details = result.logs.map(log => log.message).join("\n")
    throw new Error(`Could not bundle the analytics client${details === "" ? "" : `: ${details}`}`)
  }
  return new Uint8Array(await result.outputs[0].arrayBuffer())
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
  if (!result.success || result.outputs.length !== 1) {
    const details = result.logs.map(log => log.message).join("\n")
    throw new Error(`Could not bundle the appearance client${details === "" ? "" : `: ${details}`}`)
  }
  return new Uint8Array(await result.outputs[0].arrayBuffer())
}

export async function buildWebsite(options: BuildOptions = {}): Promise<Readonly<{
  analyticsPath: string | null
  stylesPath: string
  themePath: string
}>> {
  const environment = options.environment ?? process.env
  const outputDirectory = options.outputDirectory ?? defaultOutputDirectory
  const analyticsConfig = productionAnalyticsConfig(environment)
  const [
    indexTemplate,
    notFoundTemplate,
    previewTemplate,
    readingPaintWithCodeTemplate,
    readingIndexTemplate,
    productStyles,
    designKitFontsStyles,
    designKitProductMarketingStyles,
    appearanceStyles,
    hranessSiteFooterStyles,
    theme,
    socialImage,
  ] = await Promise.all([
    readFile(join(sourceDirectory, "index.html"), "utf8"),
    readFile(join(sourceDirectory, "404.html"), "utf8"),
    readFile(join(sourceDirectory, "preview.html"), "utf8"),
    readFile(join(sourceDirectory, "reading/paint-with-code.html"), "utf8"),
    readFile(join(sourceDirectory, "reading/index.html"), "utf8"),
    readFile(join(sourceDirectory, "styles.css"), "utf8"),
    readFile(designKitFontsStylesPath, "utf8"),
    readFile(designKitProductMarketingStylesPath, "utf8"),
    readFile(appearanceMenuStylesPath, "utf8"),
    readFile(hranessSiteFooterStylesPath, "utf8"),
    bundleTheme(),
    renderAtetSocialImage(),
  ])
  const styles = new TextEncoder().encode(
    `${designKitFontsStyles.trim()}\n\n${designKitProductMarketingStyles.trim()}\n\n${productStyles.trimEnd()}\n\n${appearanceStyles.trim()}\n\n${hranessSiteFooterStyles.trim()}\n`,
  )

  const stylesPath = assetPath("styles.css", styles)
  const themePath = assetPath("theme.js", theme)
  const commonAssets = {
    "{{APPEARANCE_MENU}}": renderAppearanceMenu(),
    "{{CSS_ASSET}}": stylesPath,
    "{{HRANESS_SITE_FOOTER}}": renderHranessSiteFooter(),
    "{{THEME_ASSET}}": themePath,
  } as const
  const publicPageAssets = (canonicalPath: string) => ({
    ...commonAssets,
    "{{ASK_AI_ABOUT_THIS}}": renderAskAiAboutThis(`${siteOrigin}${canonicalPath}`),
  }) as const
  const analytics = analyticsConfig === null ? null : await bundleAnalytics(analyticsConfig)
  const analyticsPath = analytics === null ? null : assetPath("analytics.js", analytics)
  const indexAssets = {
    ...publicPageAssets("/"),
    "{{ANALYTICS_SCRIPT}}": analyticsPath === null
      ? ""
      : `<script src="${analyticsPath}" type="module"></script>`,
    "{{SKILL_INSTALL_COMMAND}}": renderCopyCommand({
      alternateCommand: "bunx skills add https://github.com/hraness/atet/tree/v3.2.0 --skill atet",
      command: "npx skills add https://github.com/hraness/atet/tree/v3.2.0 --skill atet",
      id: "skill-install-copy-status",
    }),
    "{{READING_CARD_GRID}}": renderReadingCards(),
  } as const
  const readingIndexAssets = {
    ...commonAssets,
    "{{READING_CARD_GRID}}": renderReadingCards(),
  } as const
  const editorialPageAssets = (path: EditorialReadingPath) => ({
    ...commonAssets,
    ...renderEditorialAssets(path),
  }) as const
  const previewAssets = {
    "{{CSS_ASSET}}": stylesPath,
  } as const

  await rm(outputDirectory, { force: true, recursive: true })
  await mkdir(join(outputDirectory, "assets"), { recursive: true })
  await mkdir(join(outputDirectory, "reading"), { recursive: true })

  await Promise.all([
    cp(designKitFontsDirectory, join(outputDirectory, "assets/fonts"), {
      dereference: true,
      recursive: true,
    }),
    writeFile(join(outputDirectory, "index.html"), renderDocument(indexTemplate, indexAssets)),
    writeFile(
      join(outputDirectory, "reading/index.html"),
      renderDocument(readingIndexTemplate, readingIndexAssets),
    ),
    writeFile(join(outputDirectory, "404.html"), renderDocument(notFoundTemplate, commonAssets)),
    writeFile(
      join(outputDirectory, "preview.html"),
      renderDocument(previewTemplate, previewAssets),
    ),
    writeFile(
      join(outputDirectory, "reading/paint-with-code.html"),
      renderDocument(readingPaintWithCodeTemplate, editorialPageAssets("/reading/paint-with-code")),
    ),
    cp(join(sourceDirectory, "images"), join(outputDirectory, "images"), {
      dereference: true,
      recursive: true,
    }),
    writeFile(join(outputDirectory, stylesPath.slice(1)), styles),
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

  return { analyticsPath, stylesPath, themePath }
}

if (import.meta.main) {
  const result = await buildWebsite()
  const generatedFiles = copiedFiles.length
    + Object.keys(generatedTextFiles).length
    + 13
    + (result.analyticsPath === null ? 0 : 1)
  console.log(`Built ${generatedFiles} static files in ${defaultOutputDirectory}`)
}
