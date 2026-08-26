import { createHash } from "node:crypto"
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  homeMarkdown,
  llmsTxt,
  readingFacesMarkdown,
  readingFeynobgMarkdown,
  robotsTxt,
  sitemapMarkdown,
} from "../src/agent-pages"

const appDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const sourceDirectory = join(appDirectory, "src")
const defaultOutputDirectory = join(appDirectory, "dist")
const posthogIngestOrigin = "https://us.i.posthog.com"
const posthogPackageDirectory = dirname(fileURLToPath(import.meta.resolve("posthog-js/package.json")))
const appearanceMenuStylesPath = fileURLToPath(
  import.meta.resolve("@hraness/design-kit/appearance-menu.css"),
)

const copiedFiles = [
  "apple-touch-icon.png",
  "icon.svg",
  "og.png",
  "sitemap.xml",
] as const

const generatedTextFiles = {
  "index.md": homeMarkdown,
  "llms.txt": llmsTxt,
  "reading/draw-faces-with-javascript.md": readingFacesMarkdown,
  "reading/feynobg.md": readingFeynobgMarkdown,
  "robots.txt": robotsTxt,
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
    readingFacesTemplate,
    readingFeynobgTemplate,
    productStyles,
    appearanceStyles,
    theme,
  ] = await Promise.all([
    readFile(join(sourceDirectory, "index.html"), "utf8"),
    readFile(join(sourceDirectory, "404.html"), "utf8"),
    readFile(join(sourceDirectory, "reading/draw-faces-with-javascript.html"), "utf8"),
    readFile(join(sourceDirectory, "reading/feynobg.html"), "utf8"),
    readFile(join(sourceDirectory, "styles.css"), "utf8"),
    readFile(appearanceMenuStylesPath, "utf8"),
    bundleTheme(),
  ])
  const styles = new TextEncoder().encode(`${productStyles}\n${appearanceStyles}`)

  const stylesPath = assetPath("styles.css", styles)
  const themePath = assetPath("theme.js", theme)
  const commonAssets = {
    "{{APPEARANCE_MENU}}": renderAppearanceMenu(),
    "{{CSS_ASSET}}": stylesPath,
    "{{THEME_ASSET}}": themePath,
  } as const
  const analytics = analyticsConfig === null ? null : await bundleAnalytics(analyticsConfig)
  const analyticsPath = analytics === null ? null : assetPath("analytics.js", analytics)
  const indexAssets = {
    ...commonAssets,
    "{{ANALYTICS_SCRIPT}}": analyticsPath === null
      ? ""
      : `<script src="${analyticsPath}" type="module"></script>`,
    "{{SKILL_INSTALL_COMMAND}}": renderCopyCommand({
      alternateCommand: "bunx skills add https://github.com/hraness/atet/tree/v3.0.0 --skill atet",
      command: "npx skills add https://github.com/hraness/atet/tree/v3.0.0 --skill atet",
      id: "skill-install-copy-status",
    }),
  } as const

  await rm(outputDirectory, { force: true, recursive: true })
  await mkdir(join(outputDirectory, "assets"), { recursive: true })
  await mkdir(join(outputDirectory, "reading"), { recursive: true })

  await Promise.all([
    writeFile(join(outputDirectory, "index.html"), renderDocument(indexTemplate, indexAssets)),
    writeFile(join(outputDirectory, "404.html"), renderDocument(notFoundTemplate, commonAssets)),
    writeFile(
      join(outputDirectory, "reading/draw-faces-with-javascript.html"),
      renderDocument(readingFacesTemplate, commonAssets),
    ),
    writeFile(
      join(outputDirectory, "reading/feynobg.html"),
      renderDocument(readingFeynobgTemplate, commonAssets),
    ),
    writeFile(join(outputDirectory, stylesPath.slice(1)), styles),
    writeFile(join(outputDirectory, themePath.slice(1)), theme),
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
    + 6
    + (result.analyticsPath === null ? 0 : 1)
  console.log(`Built ${generatedFiles} static files in ${defaultOutputDirectory}`)
}
