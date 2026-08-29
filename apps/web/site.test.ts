import { beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  HRANESS_HOME_URL,
  HRANESS_NEWSLETTER_URL,
  hranessSocialLinks,
} from "@hraness/site-footer"

import {
  isCanonicalAnalyticsPage,
  posthogCookielessDistinctId,
  sanitizePageview,
} from "./src/analytics-contract"
import {
  homeMarkdown,
  llmsTxt,
  notFoundMarkdown,
  readingIndexMarkdown,
  readingFacesMarkdown,
  readingFeynobgMarkdown,
  readingGaussiansMarkdown,
  readingGeminiOmniMarkdown,
  robotsTxt,
  sitemapMarkdown,
} from "./src/agent-pages"
import {
  notAcceptableBody,
  preferredRepresentation,
  preferredRepresentationFrom,
} from "./src/negotiate"
import {
  isHomePath,
  isNegotiableDocumentPath,
  isPreservedRedirectPath,
  isPreviewPath,
  isReadingFacesPath,
  isReadingFeynobgPath,
  isReadingGaussiansPath,
  isReadingGeminiOmniPath,
  isReadingIndexPath,
  negotiateSiteRequest,
} from "./src/negotiate-request"
import middleware, { config as middlewareConfig } from "./middleware"
import { buildWebsite, renderAskAiAboutThis, renderSitemapXml } from "./scripts/build"
import { renderAtetSocialImage } from "./scripts/generate-og"
import {
  editorialImageSrcSet,
  editorialImageUrl,
  editorialReadings,
} from "./src/editorial-images"

const appDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryDirectory = join(appDirectory, "..", "..")
const brandDescription = "Agentic creative coding toolkit. At the beginning of time, when there was nothing but chaos, Atum existed alone in the watery mass of Nun. A pyramid mound called Benben emerged. When the lotus flower bloomed, Atum dawned and became Ra. Every night Ra sails in the underworld on the solar barque Atet."
const searchDescription = "Atet gives coding agents tools to generate images, video, and voice, edit real footage, add motion graphics and captions, and export finished videos."
let builtAssets: Awaited<ReturnType<typeof buildWebsite>>

beforeAll(async () => {
  builtAssets = await buildWebsite({ environment: {} })
})

async function readSource(path: string): Promise<string> {
  return await readFile(join(appDirectory, "src", path), "utf8")
}

async function readBuilt(path: string): Promise<string> {
  return await readFile(join(appDirectory, "dist", path), "utf8")
}

describe("static Atet site", () => {
  test("renders one crawlable Ask AI row on each public page with exact provider prompts", async () => {
    const subjectUrl = "https://atet.sh/reading/feynobg"
    const prompt = `Tell me about ${subjectUrl}`
    const row = renderAskAiAboutThis(subjectUrl)
    const providers = [
      ["chatgpt", "https://chatgpt.com/", "q"],
      ["claude", "https://claude.ai/new", "q"],
      ["perplexity", "https://perplexity.ai/", "q"],
      ["grok", "https://x.com/i/grok", "text"],
    ] as const

    expect(row.match(/<nav\b/gu)).toHaveLength(1)
    expect(row).toContain('aria-label="Ask AI about this"')
    expect(row.match(/data-slot="ask-ai-about-this-link"/gu)).toHaveLength(4)
    expect(row.match(/target="_blank"/gu)).toHaveLength(4)
    expect(row.match(/rel="noopener noreferrer nofollow"/gu)).toHaveLength(4)
    for (const [provider, baseUrl, parameter] of providers) {
      const destination = new URL(baseUrl)
      destination.searchParams.set(parameter, prompt)
      expect(row).toContain(`data-ask-ai-provider="${provider}"`)
      expect(row).toContain(`href="${destination.href.replaceAll("&", "&amp;")}"`)
    }

    const publicPages = [
      ["index.html", "https://atet.sh/"],
      ["reading/index.html", "https://atet.sh/reading"],
      ["reading/draw-faces-with-javascript.html", "https://atet.sh/reading/draw-faces-with-javascript"],
      ["reading/feynobg.html", subjectUrl],
      ["reading/painting-with-gaussians.html", "https://atet.sh/reading/painting-with-gaussians"],
      ["reading/gemini-omni.html", "https://atet.sh/reading/gemini-omni"],
    ] as const
    for (const [path, canonicalUrl] of publicPages) {
      const html = await readBuilt(path)
      const destination = new URL("https://chatgpt.com/")
      destination.searchParams.set("q", `Tell me about ${canonicalUrl}`)
      expect(html.match(/data-slot="ask-ai-about-this"/gu)).toHaveLength(1)
      expect(html).toContain(destination.href.replaceAll("&", "&amp;"))
    }

    expect(await readBuilt("preview.html")).not.toContain('data-slot="ask-ai-about-this"')
    expect(await readBuilt("404.html")).not.toContain('data-slot="ask-ai-about-this"')
  })

  test("makes the README a detailed agent guide with natural GitHub discovery terms", async () => {
    const readme = await readFile(join(repositoryDirectory, "README.md"), "utf8")
    const searchableReadme = readme
      .replaceAll("**", "")
      .replace(/^>\s?/gmu, "")
      .replace(/\s+/gu, " ")
      .toLowerCase()

    for (const heading of [
      "## Why Atet",
      "## Install Atet",
      "## Start with a finished job",
      "### Instructions for coding agents",
      "## What Atet does",
      "## Important limitations",
      "## How Atet works",
      "## Design and trust",
      "## Verification",
    ]) {
      expect(readme).toContain(heading)
    }

    const readerPath = [
      "## Why Atet",
      "## Install Atet",
      "## Start with a finished job",
      "## What Atet does",
      "## Important limitations",
      "## How Atet works",
      "## Design and trust",
      "## Verification",
    ].map(heading => readme.indexOf(heading))
    expect(readerPath.every(position => position >= 0)).toBe(true)
    expect(readerPath).toEqual([...readerPath].sort((left, right) => left - right))

    for (const term of [
      "agentic creative coding toolkit",
      "TypeScript SDK",
      "Bun CLI",
      "Agent Skill",
      "MCP server",
      "Vercel AI Gateway",
      "AI media generation and video editing for coding agents",
      "screen recordings and imported footage",
      "image, video, speech, and transcription models",
      "clean and captioned versions",
    ]) {
      expect(searchableReadme).toContain(term.toLowerCase())
    }

    expect(searchableReadme).toContain(brandDescription.toLowerCase())

    expect(readme).toContain("npx skills add https://github.com/hraness/atet/tree/v3.1.2 --skill atet")
    expect(readme).toContain("bun add --global @hraness/atet@3.1.2")
    expect(readme).toContain("bun add @hraness/atet@3.1.2")
    expect(readme).toContain("atet skill install --target claude")
    expect(readme).toContain("atet operations list --json")
    expect(readme).toContain("atet ai video generate")
    expect(readme).toContain("atet workflows show social-variants --json")
    expect(readme).not.toMatch(/checked step|checked path|bounded capability|delivery variant/i)
    expect(readme).not.toContain("https://atet.sh/docs")
  })

  test("ships agent instructions for video editing and Gateway media generation", async () => {
    const [skill, video, gateway] = await Promise.all([
      readFile(join(repositoryDirectory, "skills/atet/SKILL.md"), "utf8"),
      readFile(join(repositoryDirectory, "skills/atet/references/video-projects.md"), "utf8"),
      readFile(join(repositoryDirectory, "skills/atet/references/gateway-media.md"), "utf8"),
    ])

    expect(skill).toContain("# Make and edit visual media with Atet")
    expect(skill).toContain("[video-projects.md](references/video-projects.md)")
    expect(skill).toContain("[gateway-media.md](references/gateway-media.md)")
    expect(skill).toContain("social video variants")

    for (const capability of [
      "talking-head-cleanup",
      "polished-screen-demo",
      "social-variants",
      "creative-iteration",
      "Preview and final use the same timeline and composition",
    ]) {
      expect(video).toContain(capability)
    }

    for (const command of [
      "atet ai models list --type image",
      "atet ai video generate",
      "atet ai speech generate",
      "atet ai transcribe",
      "--allow-cloud-upload",
      "--allow-cloud-audio-upload",
    ]) {
      expect(gateway).toContain(command)
    }
  })

  test("publishes one canonical Atet identity across discovery metadata", async () => {
    const html = await readSource("index.html")

    expect(html).toContain("<title>Atet: AI media generation and video editing for coding agents</title>")
    expect(html).toContain(`<meta name="description" content="${searchDescription}">`)
    expect(html).toContain(`<meta property="og:description" content="${searchDescription}">`)
    expect(html).toContain(`<meta name="twitter:description" content="${searchDescription}">`)
    expect(html).toContain('<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">')
    expect(html).not.toContain('<meta name="keywords"')
    expect(html).toContain('<link rel="canonical" href="https://atet.sh/">')
    expect(html).toContain('<link rel="alternate" type="text/markdown" href="/index.md">')
    expect(html).toContain('<link rel="describedby" href="/llms.txt">')
    expect(html).toContain('<meta property="og:url" content="https://atet.sh/">')
    expect(html).toContain('<meta property="og:image" content="https://atet.sh/og.png">')
    expect(html).toContain('<meta property="og:image:width" content="1200">')
    expect(html).toContain('<meta property="og:image:height" content="630">')
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">')
    expect(html).toContain('<meta name="twitter:image" content="https://atet.sh/og.png">')
    expect(html).toContain('<meta name="twitter:image:alt" content="Atet, AI media generation and video editing for coding agents, beside an abstract solar disk and barque path">')
    expect(html).toContain('<link rel="icon" href="/icon.svg" type="image/svg+xml">')
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">')
    expect(html).toContain('<a href="https://www.npmjs.com/package/@hraness/atet">@hraness/atet npm package</a>')
    expect(html).toContain('<a href="https://skills.sh/hraness/atet">Atet Agent Skill</a>')
  })

  test("builds an inert noindex Atet preview with the homepage as canonical", async () => {
    const [source, built, css] = await Promise.all([
      readSource("preview.html"),
      readBuilt("preview.html"),
      readSource("styles.css"),
    ])

    for (const html of [source, built]) {
      expect(html.match(/<h1\b/gu)).toHaveLength(1)
      expect(html).toContain("<h1 id=\"preview-title\">Atet</h1>")
      expect(html).toContain("Make and edit visual media with your coding agent.")
      expect(html).toContain('<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">')
      expect(html).toContain('<link rel="canonical" href="https://atet.sh/">')
      expect(html).not.toMatch(/<script\b|<a\b|<button\b|<form\b|<input\b|<select\b|<textarea\b|contenteditable/iu)
      expect(html).not.toMatch(/analytics|posthog|account|authentication|authorization|sign[ -]?in|user data/iu)
      expect(html).not.toContain('rel="alternate"')
      expect(html).not.toContain('rel="sitemap"')
      expect(html).not.toContain('rel="describedby"')
      expect(html).not.toContain("data-hraness-appearance-menu")
      expect(html).not.toContain('data-slot="hraness-site-footer"')
    }

    expect(source).toContain('<link rel="stylesheet" href="{{CSS_ASSET}}">')
    expect(built).toContain(`<link rel="stylesheet" href="${builtAssets.stylesPath}">`)
    expect(built).not.toContain("{{")
    expect([...built.matchAll(/<li><span>0[1-4]<\/span>([^<]+)<\/li>/gu)]
      .map(match => match[1])).toEqual(["images", "diagrams", "animated loops", "video"])
    expect(css).toContain(".preview-route")
    expect(css).toContain(".preview-shell")
    expect(css).toContain(".preview-mark__sun")
    expect(css).toContain(".preview-outputs")
    expect(css).toMatch(/\.preview-route\s*\{[^}]*place-items:\s*safe center;[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;/su)
    expect(css).toMatch(/\.preview-shell\s*\{[^}]*min-height:\s*min\(38rem, calc\(100svh - 2rem\)\);/su)
    expect(css).not.toMatch(/\.preview-(?:route|shell)\s*\{[^}]*overflow:\s*hidden;/su)
  })

  test("links the website, product, and source in structured data", async () => {
    const html = await readSource("index.html")
    const match = /<script type="application\/ld\+json">([\s\S]+?)<\/script>/u.exec(html)
    expect(match?.[1]).toBeDefined()
    const value = JSON.parse(match?.[1] ?? "null") as { "@graph"?: unknown[] }

    expect(value["@graph"]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        "@id": "https://hraness.com/#organization",
        "@type": "Organization",
        name: "Hraness",
        sameAs: ["https://github.com/hraness"],
      }),
      expect.objectContaining({
        "@id": "https://atet.sh/#website",
        "@type": "WebSite",
        description: searchDescription,
        inLanguage: "en",
        publisher: { "@id": "https://hraness.com/#organization" },
      }),
      expect.objectContaining({
        "@id": "https://atet.sh/#webpage",
        "@type": "WebPage",
        isPartOf: { "@id": "https://atet.sh/#website" },
        mainEntity: { "@id": "https://atet.sh/#software" },
        publisher: { "@id": "https://hraness.com/#organization" },
      }),
      expect.objectContaining({
        "@id": "https://atet.sh/#software",
        "@type": "SoftwareApplication",
        description: searchDescription,
        author: { "@id": "https://hraness.com/#organization" },
        installUrl: "https://atet.sh/#install",
        publisher: { "@id": "https://hraness.com/#organization" },
        sameAs: [
          "https://github.com/hraness/atet",
          "https://www.npmjs.com/package/@hraness/atet",
          "https://skills.sh/hraness/atet",
        ],
        softwareVersion: "3.1.2",
      }),
      expect.objectContaining({
        "@id": "https://atet.sh/#source",
        "@type": "SoftwareSourceCode",
        author: { "@id": "https://hraness.com/#organization" },
        codeRepository: "https://github.com/hraness/atet",
        targetProduct: { "@id": "https://atet.sh/#software" },
        version: "3.1.2",
      }),
    ]))
  })

  test("puts the complete agent install before the first section ends", async () => {
    const html = await readBuilt("index.html")
    const searchableHtml = html.replace(/\s+/gu, " ")
    const commands = [
      "npx skills add https://github.com/hraness/atet/tree/v3.1.2 --skill atet",
      "bun add --global @hraness/atet@3.1.2",
      "atet doctor",
    ]
    const positions = commands.map(command => html.indexOf(command))
    const heroHtml = html.slice(0, html.indexOf("</section>") + "</section>".length)

    expect(positions.every(position => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
    expect(positions.at(-1)).toBeLessThan(html.indexOf("</section>"))
    expect(html).toContain("Make and edit visual media with your coding agent.")
    expect(searchableHtml).toContain("generate images, video, and voice")
    expect(searchableHtml).toContain("edit screen recordings and imported footage")
    expect(searchableHtml).toContain("add captions, graphics, and motion")
    expect(searchableHtml).toContain("export finished videos")
    expect(searchableHtml).toContain("Source media stays unchanged")
    expect(searchableHtml).toContain("Preview and final renders use the same timeline and composition")
    expect(html).toContain("Install the Atet Agent Skill")
    expect(html).toContain("Install the local media tools · Requires Bun 1.3.14+")
    expect(html).toContain("Using Bun? <code>bunx skills add https://github.com/hraness/atet/tree/v3.1.2 --skill atet</code>")
    expect(html).toContain("inside the project you want to work")
    expect(html).toContain("start a new agent session")
    expect(heroHtml).not.toContain("atet skill install")
    expect(html).toContain("When that command is not being used")
    expect(html).toContain("atet skill install --target claude")
    expect(html).toContain("atet skill install --target agents")
    expect(html).toContain("--scope project")
    expect(html).toContain("@hraness/atet@3.1.2")
  })

  test("renders a progressively enhanced reusable copy command in the hero", async () => {
    const [html, build, client] = await Promise.all([
      readBuilt("index.html"),
      readFile(join(appDirectory, "scripts/build.ts"), "utf8"),
      readSource("copy-command.ts"),
    ])

    expect(build).toContain("function renderCopyCommand(options: CopyCommandOptions)")
    expect(html.match(/data-copy-command(?:>|\s)/gu)).toHaveLength(1)
    expect(html).toContain('<code class="copy-command__value" data-copy-command-value>npx skills add https://github.com/hraness/atet/tree/v3.1.2 --skill atet</code>')
    expect(html).toContain("<code>bunx skills add https://github.com/hraness/atet/tree/v3.1.2 --skill atet</code>")
    expect(html).toContain('aria-label="Copy install command"')
    expect(html).toContain("data-copy-command-button hidden type=\"button\">Copy</button>")
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('aria-describedby="skill-install-copy-status"')
    expect(client).toContain("button.hidden = false")
    expect(client).toContain("navigator.clipboard.writeText(value)")
    expect(client).toContain('ownerDocument.execCommand("copy")')
    expect(client).toContain('button.addEventListener("click"')
    expect(client).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/)
  })

  test("uses one install, examples, workflow, and design information architecture", async () => {
    const html = await readSource("index.html")
    const modes = ["> Install<", "> Examples<", "> Workflow<", "> Design<"]
    const positions = modes.map(mode => html.indexOf(mode))

    expect(positions.every(position => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
    expect(html).toContain('<nav aria-label="Page sections" class="docs-index">')
    expect(html.match(/class="docs-section/gu)).toHaveLength(4)
    expect(html).not.toContain("Diátaxis")
  })

  test("teaches people through requests instead of a command catalog", async () => {
    const html = await readSource("index.html")

    for (const claim of [
      "record my screen, camera, microphone, and system audio",
      "three opening-shot ideas from <code>product.png</code>",
      "generate a calm voiceover from <code>script.txt</code>",
      "clean and captioned versions in 16:9, 9:16, 1:1, and 4:5",
      "services in this repository into an editable diagram",
    ]) {
      expect(html.toLowerCase()).toContain(claim.toLowerCase())
    }

    expect(html).not.toMatch(/checked step|checked path|bounded capability|delivery variant/i)
    expect(html).not.toMatch(/<table\b|class="table-wrap"/)
    expect(html).not.toMatch(/atet\.diagram\.|atet\.image\.|@hraness\/atet\/code/)
    expect(html).not.toMatch(/AI_GATEWAY_API_KEY|VERCEL_OIDC_TOKEN|ATET_CACHE_DIR/)
  })

  test("presents one complete creative workflow in order", async () => {
    const html = await readSource("index.html")
    const stages = [
      ">Bring in what you have<",
      ">Generate what is missing<",
      ">Shape the edit<",
      ">Review before final<",
      ">Deliver every version<",
    ]
    const positions = stages.map(stage => html.indexOf(stage))

    expect(positions.every(position => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
  })

  test("explains the architecture and trust boundary in plain language", async () => {
    const html = await readSource("index.html")
    const searchableHtml = html.replace(/\s+/gu, " ")

    for (const claim of ["Source", "Project", "Operations", "Outputs"]) {
      expect(html).toContain(claim)
    }
    expect(html).toContain("A local project your agent can understand.")
    expect(searchableHtml).toContain("your Vercel AI Gateway credential")
    expect(searchableHtml).toContain("There is no Atet account or hosted project database")
    expect(searchableHtml).toContain("uploads local media only after explicit acknowledgement")
    expect(searchableHtml.toLowerCase()).not.toContain("operating-system sandbox")
    expect(html).not.toMatch(/<form|type="password"|\/api\//)
  })

  test("keeps the approved creation story as quiet identity context", async () => {
    const html = await readSource("index.html")
    const searchableHtml = html.replace(/\s+/gu, " ")

    expect(searchableHtml).toContain(brandDescription)
    expect(html).toContain("Atum dawned and became Ra")
    expect(html).toContain("underworld on the solar barque Atet")
    expect(html).toContain('<h3>The name Atet</h3>')
    expect(html).not.toMatch(/hieroglyph|pharaoh|ankh/i)
  })

  test("keeps the page semantic, linkable, keyboard-operable, and responsive", async () => {
    const html = await readSource("index.html")
    const css = await readSource("styles.css")
    const fragmentLinks = [...html.matchAll(/href="#([^"]+)"/gu)].map(match => match[1])
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/gu)].map(match => match[1]))

    expect(html.match(/<h1\b/gu)).toHaveLength(1)
    expect(html).toContain('<a class="skip-link" href="#main">')
    expect(html).toContain('<nav aria-label="Primary">')
    expect(html).toContain('<div class="topbar-actions">')
    expect(html).toContain('<main id="main" tabindex="-1">')
    expect(html).not.toMatch(/<section(?![^>]*aria-labelledby)/)
    expect(fragmentLinks.every(fragment => ids.has(fragment))).toBe(true)
    expect(css).toContain(":where(a, button, [tabindex]):focus-visible")
    expect(css).toContain(".docs-index")
    expect(css).toContain(".docs-section")
    expect(css).toContain(".reading-article")
    expect(css).toContain("@media (max-width: 64rem)")
    expect(css).toContain("@media (max-width: 48rem)")
    expect(css).toContain("@media (max-width: 34rem)")
    expect(css).toContain("@media (prefers-reduced-motion: reduce)")
    expect(css).toContain("@media (forced-colors: active)")
  })

  test("owns one shared appearance menu as the final action in every header", async () => {
    const [html, notFound, reading, readingFeynobg, readingGaussians, readingGeminiOmni] = await Promise.all([
      readBuilt("index.html"),
      readBuilt("404.html"),
      readBuilt("reading/draw-faces-with-javascript.html"),
      readBuilt("reading/feynobg.html"),
      readBuilt("reading/painting-with-gaussians.html"),
      readBuilt("reading/gemini-omni.html"),
    ])

    for (const document of [html, notFound, reading, readingFeynobg, readingGaussians, readingGeminiOmni]) {
      expect(document.match(/data-hraness-appearance-menu/gu)).toHaveLength(1)
      expect(document).toMatch(
        /<header class="topbar">[\s\S]*?<div class="topbar-actions">[\s\S]*?<nav aria-label="Primary">[\s\S]*?<\/nav>\s*<div[^>]*data-hraness-appearance-menu[^>]*>[\s\S]*?<\/div>\s*<\/div>\s*<\/header>/u,
      )
      expect(document.slice(document.indexOf('data-slot="hraness-site-footer"')))
        .not.toContain("data-hraness-appearance-menu")
      expect(document).not.toContain('class="appearance"')
      expect(document).not.toContain("data-theme-choice")
      expect(document).toContain('aria-label="Appearance: System"')
      expect(document).toContain('aria-haspopup="menu"')
      expect(document).toContain('aria-label="Appearance"')
      expect(document.match(/role="menuitemradio"/gu)).toHaveLength(3)
      expect([...document.matchAll(/data-theme-value="(light|dark|system)" role="menuitemradio"/gu)]
        .map(match => match[1])).toEqual(["light", "dark", "system"])
    }

    expect(notFound).toContain('<a class="skip-link" href="#main">')
    expect(notFound).toContain('<main class="route-state" id="main" tabindex="-1">')
    expect(notFound).toContain('<meta name="theme-color" content="#f7f3ea" media="(prefers-color-scheme: light)">')
    expect(notFound).toContain('<meta name="theme-color" content="#0b0b0e" media="(prefers-color-scheme: dark)">')
    expect(notFound).toContain('href="/llms.txt"')
    expect(notFound).toContain('href="/sitemap.md"')
    expect(notFound).toContain('href="/sitemap.xml"')
    expect(notFound).toContain("machine-readable site guide")
  })

  test("uses a restrained editorial visual system", async () => {
    const css = await readSource("styles.css")

    expect(css).toContain('--font-display: ui-serif, "Iowan Old Style", Baskerville')
    expect(css).toContain('--font-body: "Nebula Sans", ui-sans-serif, system-ui')
    expect(css).toContain("--font-sans: var(--font-body)")
    expect(css).toContain("--radius-control: 0.2rem")
    expect(css).toContain("--radius-surface: 0.45rem")
    expect(css).toContain(".install-panel")
    expect(css).toContain(".feature-list > div")
    expect(css).toContain(".origin-note")
    expect(css).not.toMatch(/@font-face|url\([^)]*\.woff/)
    const builtCss = await readBuilt(builtAssets.stylesPath.slice(1))
    expect(builtCss).toContain('font-family: "Nebula Sans";')
    expect(builtCss).toContain('./fonts/nebula-sans/NebulaSans-Book.woff2')
    expect((await readFile(
      join(appDirectory, "dist/assets/fonts/nebula-sans/NebulaSans-Book.woff2"),
    )).byteLength).toBeGreaterThan(60_000)
    expect(await readBuilt("assets/fonts/nebula-sans/PROVENANCE.md"))
      .toContain("https://www.nebulasans.com/download/NebulaSans-1.010.zip")
  })

  test("ships reproducible correctly sized social and icon assets", async () => {
    const social = new Uint8Array(await Bun.file(join(appDirectory, "src/og.png")).arrayBuffer())
    const generatedSocial = await renderAtetSocialImage()
    const serifHero = new Uint8Array(await Bun.file(
      join(appDirectory, "src/og-serif-hero.png"),
    ).arrayBuffer())
    const apple = new Uint8Array(await Bun.file(join(appDirectory, "src/apple-touch-icon.png")).arrayBuffer())
    const socialSource = await readSource("og-source.svg")
    const socialGenerator = await readFile(join(appDirectory, "scripts/generate-og.ts"), "utf8")
    const icon = await readSource("icon.svg")
    const socialView = new DataView(social.buffer, social.byteOffset, social.byteLength)
    const serifHeroView = new DataView(
      serifHero.buffer,
      serifHero.byteOffset,
      serifHero.byteLength,
    )
    const appleView = new DataView(apple.buffer, apple.byteOffset, apple.byteLength)

    expect(generatedSocial).toEqual(social)
    expect(new Bun.CryptoHasher("sha256").update(social).digest("hex")).toBe(
      "d040e1483849836e42ef4209a12cff0e84a9933af947f18bd143381a496d8da5",
    )
    expect(Array.from(social.slice(1, 4))).toEqual([80, 78, 71])
    expect(socialView.getUint32(16)).toBe(1200)
    expect(socialView.getUint32(20)).toBe(630)
    expect(socialSource).toContain("Make and edit")
    expect(socialSource).toContain("visual media")
    expect(socialSource).toContain("with your agent.")
    expect(socialSource).toContain('href="og-serif-hero.png"')
    expect(socialSource.match(/font-family="Nebula Sans"/gu)).toHaveLength(4)
    expect(socialSource).not.toMatch(/system-ui|-apple-system|sans-serif/u)
    expect(socialSource).toContain('fill="#e8aa48"')
    expect(serifHeroView.getUint32(16)).toBe(1200)
    expect(serifHeroView.getUint32(20)).toBe(630)
    expect(new Bun.CryptoHasher("sha256").update(serifHero).digest("hex")).toBe(
      "4a4a132a6f8fd781df0c5804797799dc4179e56ab819de79f33fbeecc99b2f52",
    )
    expect(socialGenerator).toContain('loadSystemFonts: false')
    expect(socialGenerator).toContain("NebulaSans-Book.otf")
    expect(socialGenerator).toContain("NebulaSans-Bold.otf")
    expect(socialGenerator).toContain("4cc650f856591af1affc4add4f50e260c8239a2542bafe77909b78006023f091")
    expect(socialGenerator).toContain("91617d3e2281e8213f64f6bf359f387022d3149b35000b38365c32130a25bfa8")
    expect(Array.from(apple.slice(1, 4))).toEqual([80, 78, 71])
    expect(appleView.getUint32(16)).toBe(180)
    expect(appleView.getUint32(20)).toBe(180)
    expect(icon).toContain('viewBox="0 0 64 64"')
    expect(icon).toContain('fill="#090a12"')
    expect(icon).toContain('stop-color="#f6b94a"')
  })

  test("keeps editorial images visible, discoverable, and bound to retained provenance", async () => {
    const [home, readingIndex, sitemap] = await Promise.all([
      readBuilt("index.html"),
      readBuilt("reading/index.html"),
      readBuilt("sitemap.xml"),
    ])

    expect(home.match(/class="reading-card"/gu)).toHaveLength(editorialReadings.length)
    expect(readingIndex.match(/class="reading-card"/gu)).toHaveLength(editorialReadings.length)
    expect(sitemap).toContain('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"')

    for (const reading of editorialReadings) {
      const stem = reading.src.slice(0, -".webp".length)
      const [html, bytes, smallBytes, mediumBytes, receiptSource, jobSource, prompt] = await Promise.all([
        readBuilt(`reading/${reading.slug}.html`),
        readFile(join(appDirectory, "src", reading.src.slice(1))),
        readFile(join(appDirectory, "src", `${stem.slice(1)}-384.webp`)),
        readFile(join(appDirectory, "src", `${stem.slice(1)}-768.webp`)),
        readFile(join(appDirectory, reading.provenance.receipt), "utf8"),
        readFile(join(appDirectory, reading.provenance.job), "utf8"),
        readFile(join(appDirectory, reading.provenance.prompt), "utf8"),
      ])
      const imageUrl = editorialImageUrl(reading)
      const structuredData = /<script type="application\/ld\+json">([\s\S]+?)<\/script>/u.exec(html)?.[1]
      const graph = JSON.parse(structuredData ?? "null") as { "@graph"?: Array<Record<string, unknown>> }
      const article = graph["@graph"]?.find(value => value["@type"] === "Article")
      const receipt = JSON.parse(receiptSource) as { outputs?: Array<{ sha256?: unknown }> }
      const job = JSON.parse(jobSource) as { noAtetRetry?: unknown; state?: unknown }

      expect(html).toContain(`<meta property="og:image" content="${imageUrl}">`)
      expect(html).toContain(`<meta name="twitter:image" content="${imageUrl}">`)
      expect(html).toContain(`alt="${reading.alt}"`)
      expect(html).toContain(`src="${reading.src}"`)
      expect(html).toContain(`srcset="${editorialImageSrcSet(reading)}"`)
      expect(html).toContain(reading.caption)
      expect(html).toContain(reading.credit)
      expect(html).not.toMatch(/editorial-provenance|gateway_[0-9a-f]+/u)
      expect(article?.image).toEqual({
        "@type": "ImageObject",
        contentUrl: imageUrl,
        height: reading.height,
        width: reading.width,
      })
      expect(sitemap).toContain(`<image:loc>${imageUrl}</image:loc>`)
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(reading.imageSha256)
      expect(smallBytes.byteLength).toBeLessThan(mediumBytes.byteLength)
      expect(mediumBytes.byteLength).toBeLessThan(bytes.byteLength)
      expect(receipt.outputs?.[0]?.sha256).toBe(reading.imageSha256)
      expect(job).toMatchObject({ noAtetRetry: true, state: "completed" })
      expect(prompt.trim().length).toBeGreaterThan(80)
    }
  })

  test("keeps the static shell fingerprinted and analytics explicit", async () => {
    const html = await readSource("index.html")
    const css = await readSource("styles.css")
    const theme = await readSource("theme.ts")
    const copyCommand = await readSource("copy-command.ts")
    const analytics = await readSource("analytics.ts")
    const build = await readFile(join(appDirectory, "scripts/build.ts"), "utf8")
    const manifest = JSON.parse(
      await readFile(join(appDirectory, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const rootManifest = JSON.parse(
      await readFile(join(repositoryDirectory, "package.json"), "utf8"),
    ) as { workspaces?: { catalog?: Record<string, string> } }
    const localLockfile = await readFile(join(appDirectory, "bun.lock"), "utf8")

    expect(manifest.dependencies).toEqual({
      "@hraness/design-kit": "github:hraness/design-kit#v0.2.1",
      "@hraness/site-footer": "github:hraness/site-footer#v0.3.1",
      "@hraness/ui": "github:hraness/ui#v0.4.10",
      "@resvg/resvg-js": "2.6.2",
      "posthog-js": "1.413.2",
      "react": "19.2.3",
      "react-dom": "19.2.3",
    })
    expect(manifest.devDependencies).toEqual({
      "@types/react": "19.2.14",
      "@types/react-dom": "19.2.3",
    })
    expect(rootManifest.workspaces?.catalog?.["posthog-js"]).toBeUndefined()
    expect(rootManifest.workspaces?.catalog?.["@hraness/design-kit"]).toBeUndefined()
    expect(localLockfile).toContain('"@hraness/design-kit": "github:hraness/design-kit#v0.2.1"')
    expect(localLockfile).toContain(
      '"@hraness/site-footer": "github:hraness/site-footer#v0.3.1"',
    )
    expect(localLockfile).toContain('"@hraness/ui": "github:hraness/ui#v0.4.10"')
    expect(localLockfile).toContain('"@resvg/resvg-js": "2.6.2"')
    expect(localLockfile).toContain('"posthog-js": "1.413.2"')
    expect(localLockfile).not.toContain("catalog:")
    expect(new TextEncoder().encode(html).byteLength).toBeLessThan(20_000)
    expect(new TextEncoder().encode(css).byteLength).toBeLessThan(36_000)
    expect(new TextEncoder().encode(theme).byteLength).toBeLessThan(3_000)
    expect(new TextEncoder().encode(copyCommand).byteLength).toBeLessThan(4_000)
    expect(html).not.toMatch(/https:\/\/[^"']+\.(?:css|js)/)
    expect(html).toContain('<link rel="stylesheet" href="{{CSS_ASSET}}">')
    expect(html).toContain('<script src="{{THEME_ASSET}}"></script>')
    expect(html.indexOf('<script src="{{THEME_ASSET}}"></script>'))
      .toBeLessThan(html.indexOf('<link rel="stylesheet" href="{{CSS_ASSET}}">'))
    expect(html).toContain("{{APPEARANCE_MENU}}")
    expect(html).toContain("{{ANALYTICS_SCRIPT}}")
    expect(html.match(/<script\b/gu)).toHaveLength(2)
    expect(theme).toContain('from "@hraness/design-kit/browser"')
    expect(theme).toContain('storageKey: "atet.appearance"')
    expect(theme).toContain('import { installCopyCommands } from "./copy-command"')
    expect(theme).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/)
    expect(copyCommand).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/)
    expect(analytics).toContain('cookieless_mode: "always"')
    expect(analytics).toContain('person_profiles: "never"')
    expect(analytics).toContain("disable_external_dependency_loading: true")
    expect(analytics).toContain("disable_persistence: true")
    expect(analytics).toContain("disable_surveys: true")
    expect(analytics).toContain("disableDeviceModel: true")
    expect(analytics).toContain("advanced_disable_flags: true")
    expect(analytics).toContain('posthog.capture("$pageview"')
    expect(analytics).not.toMatch(/identify\(|autocapture:\s*true|capture_pageleave:\s*true/)
    expect(build).toContain('createHash("sha256")')
    expect(build).toContain("Bun.build")
    expect(build).toContain('format: "iife"')
    expect(build).toContain('import.meta.resolve("@hraness/design-kit/appearance-menu.css")')
    expect(build).toContain('import.meta.resolve("@hraness/design-kit/fonts.css")')
    expect(build).toContain("renderAppearanceMenu()")
    expect(build).toContain("renderCopyCommand({")
    expect(build).toContain('environment.VERCEL_ENV !== "production"')
    expect(build).not.toContain("docsTemplate")
    expect(build).not.toContain('outputDirectory, "docs"')
  })

  test("allows only a canonical cookieless Atet pageview", () => {
    expect(isCanonicalAnalyticsPage({ origin: "https://atet.sh", pathname: "/" })).toBe(true)
    expect(isCanonicalAnalyticsPage({ origin: "https://preview.atet.sh", pathname: "/" })).toBe(false)
    expect(isCanonicalAnalyticsPage({ origin: "https://atet.sh", pathname: "/404" })).toBe(false)
    expect(isCanonicalAnalyticsPage({
      origin: "https://atet.sh",
      pathname: "/reading/draw-faces-with-javascript",
    })).toBe(false)
    expect(isCanonicalAnalyticsPage({
      origin: "https://atet.sh",
      pathname: "/reading/feynobg",
    })).toBe(false)
    expect(isCanonicalAnalyticsPage({
      origin: "https://atet.sh",
      pathname: "/reading/painting-with-gaussians",
    })).toBe(false)
    expect(isCanonicalAnalyticsPage({
      origin: "https://atet.sh",
      pathname: "/reading/gemini-omni",
    })).toBe(false)

    const timestamp = new Date("2026-08-19T12:00:00.000Z")
    const sanitized = sanitizePageview({
      event: "$pageview",
      properties: {
        $cookieless_mode: true,
        $current_url: "https://atet.sh/?private=value#fragment",
        $device_id: "device",
        $pathname: "/",
        $raw_user_agent: "Atet test browser",
        $referrer: "https://example.com/private",
        analytics_schema_version: 99,
        distinct_id: posthogCookielessDistinctId,
        site_id: "wrong",
        token: "phc_testtoken",
      },
      timestamp,
      uuid: "0198c6a7-7c00-7000-8000-000000000000",
    }, "phc_testtoken")

    expect(sanitized).toEqual({
      event: "$pageview",
      properties: {
        $cookieless_mode: true,
        $process_person_profile: false,
        $raw_user_agent: "Atet test browser",
        analytics_schema_version: 1,
        distinct_id: posthogCookielessDistinctId,
        site_id: "atet",
        token: "phc_testtoken",
      },
      timestamp,
      uuid: "0198c6a7-7c00-7000-8000-000000000000",
    })
    expect(sanitizePageview({
      event: "$autocapture",
      properties: { distinct_id: posthogCookielessDistinctId, token: "phc_testtoken" },
      uuid: "0198c6a7-7c00-7000-8000-000000000001",
    }, "phc_testtoken")).toBeNull()
    expect(sanitizePageview({
      event: "$pageview",
      properties: { distinct_id: "persisted-id", token: "phc_testtoken" },
      uuid: "0198c6a7-7c00-7000-8000-000000000002",
    }, "phc_testtoken")).toBeNull()
    expect(sanitizePageview({
      event: "$pageview",
      properties: {
        distinct_id: posthogCookielessDistinctId,
        token: "phc_testtoken",
      },
      uuid: "0198c6a7-7c00-7000-8000-000000000003",
    }, "phc_testtoken")).toBeNull()
    expect(sanitizePageview({
      event: "$pageview",
      properties: {
        $cookieless_mode: false,
        $raw_user_agent: "Atet test browser",
        distinct_id: posthogCookielessDistinctId,
        token: "phc_testtoken",
      },
      uuid: "0198c6a7-7c00-7000-8000-000000000004",
    }, "phc_testtoken")).toBeNull()
    expect(sanitizePageview({
      event: "$pageview",
      properties: {
        $cookieless_mode: true,
        distinct_id: posthogCookielessDistinctId,
        token: "phc_testtoken",
      },
      uuid: "0198c6a7-7c00-7000-8000-000000000005",
    }, "phc_testtoken")).toBeNull()
  })

  test("emits analytics only for a configured Production build", async () => {
    const productionDirectory = await mkdtemp(join(tmpdir(), "atet-web-production-"))
    const secondDirectory = await mkdtemp(join(tmpdir(), "atet-web-production-repeat-"))
    try {
      const environment = {
        NEXT_PUBLIC_POSTHOG_HOST: "https://us.i.posthog.com",
        NEXT_PUBLIC_POSTHOG_KEY: "phc_test-token_value",
        VERCEL_ENV: "production",
      } as const
      const first = await buildWebsite({ environment, outputDirectory: productionDirectory })
      const second = await buildWebsite({ environment, outputDirectory: secondDirectory })
      expect(first.analyticsPath).toMatch(/^\/assets\/analytics-[a-f0-9]{12}\.js$/u)
      expect(second.analyticsPath).toBe(first.analyticsPath)

      const [html, notFound, preview, asset] = await Promise.all([
        readFile(join(productionDirectory, "index.html"), "utf8"),
        readFile(join(productionDirectory, "404.html"), "utf8"),
        readFile(join(productionDirectory, "preview.html"), "utf8"),
        readFile(join(productionDirectory, first.analyticsPath?.slice(1) ?? "missing"), "utf8"),
      ])
      expect(html).toContain(`<script src="${first.analyticsPath}" type="module"></script>`)
      expect(notFound).not.toMatch(/analytics-|posthog|phc_test-token_value/i)
      expect(preview).not.toMatch(/<script\b|analytics-|posthog|phc_test-token_value/iu)
      expect(asset).toContain("phc_test-token_value")
      expect(asset).toContain("https://us.i.posthog.com")
      expect(asset).toStartWith("/*! posthog-js 1.413.2")
      expect(asset).toContain("Apache License\n                           Version 2.0")
      expect(new TextEncoder().encode(asset).byteLength).toBeLessThan(180_000)
    } finally {
      await Promise.all([
        rm(productionDirectory, { force: true, recursive: true }),
        rm(secondDirectory, { force: true, recursive: true }),
      ])
    }
  })

  test("keeps missing, Preview, and unsupported-host analytics builds inert", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "atet-web-inert-"))
    try {
      const preview = await buildWebsite({
        environment: {
          NEXT_PUBLIC_POSTHOG_KEY: "phc_testtoken",
          VERCEL_ENV: "preview",
        },
        outputDirectory,
      })
      expect(preview.analyticsPath).toBeNull()
      expect(await readFile(join(outputDirectory, "index.html"), "utf8"))
        .not.toMatch(/analytics-|phc_testtoken/)

      await expect(buildWebsite({
        environment: {
          NEXT_PUBLIC_POSTHOG_HOST: "https://example.com",
          NEXT_PUBLIC_POSTHOG_KEY: "phc_testtoken",
          VERCEL_ENV: "production",
        },
        outputDirectory,
      })).rejects.toThrow("NEXT_PUBLIC_POSTHOG_HOST must equal https://us.i.posthog.com")
    } finally {
      await rm(outputDirectory, { force: true, recursive: true })
    }
  })

  test("renders one closed static page with resolved content-hashed assets", async () => {
    const [html, notFound, rootFiles, assetFiles] = await Promise.all([
      readFile(join(appDirectory, "dist/index.html"), "utf8"),
      readFile(join(appDirectory, "dist/404.html"), "utf8"),
      readdir(join(appDirectory, "dist")),
      readdir(join(appDirectory, "dist/assets")),
    ])

    expect(html).toContain(`<link rel="stylesheet" href="${builtAssets.stylesPath}">`)
    expect(html).toContain(`<script src="${builtAssets.themePath}"></script>`)
    expect(builtAssets.analyticsPath).toBeNull()
    expect(html).not.toMatch(/analytics-/)
    expect(notFound).toContain(`<link rel="stylesheet" href="${builtAssets.stylesPath}">`)
    expect(notFound).toContain(`<script src="${builtAssets.themePath}"></script>`)
    expect(`${html}\n${notFound}`).not.toContain("{{")
    expect(rootFiles.sort()).toEqual([
      "404.html",
      "apple-touch-icon.png",
      "assets",
      "icon.svg",
      "images",
      "index.html",
      "index.md",
      "llms.txt",
      "og.png",
      "preview.html",
      "reading",
      "robots.txt",
      "sitemap.md",
      "sitemap.xml",
    ])
    expect(assetFiles.sort()).toEqual([
      "fonts",
      builtAssets.stylesPath.split("/").at(-1)!,
      builtAssets.themePath.split("/").at(-1)!,
    ].sort())

    const [stylesAsset, themeAsset] = await Promise.all([
      readFile(join(appDirectory, "dist", builtAssets.stylesPath.slice(1)), "utf8"),
      readFile(join(appDirectory, "dist", builtAssets.themePath.slice(1)), "utf8"),
    ])
    expect(stylesAsset).toContain(".hraness-design-theme-toggle__trigger")
    expect(stylesAsset).toContain(".hraness-site-footer {")
    expect(stylesAsset).toContain("@media (pointer: coarse)")
    expect(new TextEncoder().encode(stylesAsset).byteLength).toBeLessThan(50_000)
    expect(new TextEncoder().encode(themeAsset).byteLength).toBeLessThan(24_000)
    expect(themeAsset).not.toMatch(/react|next-themes|react-aria/i)
    expect(themeAsset).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/)
  })

  test("publishes crawler discovery for the home page and its markdown mirror", async () => {
    const [
      robots,
      sitemap,
      notFound,
      builtRobots,
      builtLlms,
      builtHomeMarkdown,
      builtReadingIndexMarkdown,
      builtSitemapMarkdown,
      builtReadingMarkdown,
      builtFeynobgMarkdown,
      builtGaussiansMarkdown,
      builtGeminiOmniMarkdown,
    ] = await Promise.all([
      Promise.resolve(robotsTxt),
      readBuilt("sitemap.xml"),
      readSource("404.html"),
      readBuilt("robots.txt"),
      readBuilt("llms.txt"),
      readBuilt("index.md"),
      readBuilt("reading/index.md"),
      readBuilt("sitemap.md"),
      readBuilt("reading/draw-faces-with-javascript.md"),
      readBuilt("reading/feynobg.md"),
      readBuilt("reading/painting-with-gaussians.md"),
      readBuilt("reading/gemini-omni.md"),
    ])
    const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map(match => match[1])

    expect(robots).toBe([
      "User-agent: OAI-SearchBot",
      "User-agent: ChatGPT-User",
      "User-agent: GPTBot",
      "Allow: /",
      "",
      "User-agent: Claude-SearchBot",
      "User-agent: Claude-User",
      "User-agent: ClaudeBot",
      "Allow: /",
      "",
      "User-agent: PerplexityBot",
      "User-agent: Perplexity-User",
      "Allow: /",
      "",
      "User-agent: Google-Extended",
      "Allow: /",
      "",
      "User-agent: CCBot",
      "Allow: /",
      "",
      "User-agent: *",
      "Allow: /",
      "",
      "Sitemap: https://atet.sh/sitemap.xml",
      "",
    ].join("\n"))
    expect(robots).not.toMatch(/^\s*Disallow:/mu)
    expect(builtRobots).toBe(robotsTxt)
    expect(locations).toEqual([
      "https://atet.sh/",
      "https://atet.sh/index.md",
      "https://atet.sh/reading",
      "https://atet.sh/reading/index.md",
      "https://atet.sh/reading/draw-faces-with-javascript",
      "https://atet.sh/reading/draw-faces-with-javascript.md",
      "https://atet.sh/reading/feynobg",
      "https://atet.sh/reading/feynobg.md",
      "https://atet.sh/reading/painting-with-gaussians",
      "https://atet.sh/reading/painting-with-gaussians.md",
      "https://atet.sh/reading/gemini-omni",
      "https://atet.sh/reading/gemini-omni.md",
    ])
    for (const discoveryDocument of [sitemap, builtLlms, builtHomeMarkdown, builtSitemapMarkdown]) {
      expect(discoveryDocument).not.toContain("/preview")
    }
    expect(sitemap).toContain("<lastmod>2026-08-26</lastmod>")
    expect(sitemap).toContain("<lastmod>2026-08-27</lastmod>")
    expect(sitemap).toContain("<lastmod>2026-08-28</lastmod>")
    expect(notFound).toContain('<meta name="robots" content="noindex, nofollow">')
    expect(builtLlms).toBe(llmsTxt)
    expect(builtHomeMarkdown).toBe(homeMarkdown)
    expect(builtReadingIndexMarkdown).toBe(readingIndexMarkdown)
    expect(builtSitemapMarkdown).toBe(sitemapMarkdown)
    expect(sitemap).toBe(renderSitemapXml())
    expect(builtReadingMarkdown).toBe(readingFacesMarkdown)
    expect(builtFeynobgMarkdown).toBe(readingFeynobgMarkdown)
    expect(builtGaussiansMarkdown).toBe(readingGaussiansMarkdown)
    expect(builtGeminiOmniMarkdown).toBe(readingGeminiOmniMarkdown)
    expect(llmsTxt).toMatch(/^# Atet\n/u)
    expect(llmsTxt).toContain("> Atet gives coding agents tools")
    expect(llmsTxt).toContain("## When to use Atet")
    expect(llmsTxt).toContain("https://atet.sh/index.md")
    expect(sitemapMarkdown).toContain("# Sitemap")
    expect(sitemapMarkdown).toContain("https://atet.sh/index.md")
    expect(sitemapMarkdown).toContain("https://atet.sh/reading/index.md")
    expect(sitemapMarkdown).toContain("https://atet.sh/reading/draw-faces-with-javascript.md")
    expect(sitemapMarkdown).toContain("https://atet.sh/reading/feynobg.md")
    expect(sitemapMarkdown).toContain("https://atet.sh/reading/painting-with-gaussians.md")
    expect(sitemapMarkdown).toContain("https://atet.sh/reading/gemini-omni.md")
    expect(homeMarkdown).toContain("## Sitemap")
    expect(homeMarkdown).toContain("https://atet.sh/sitemap.md")
    expect(homeMarkdown).toContain("https://atet.sh/reading/draw-faces-with-javascript.md")
    expect(homeMarkdown).toContain("https://atet.sh/reading/feynobg.md")
    expect(homeMarkdown).toContain("https://atet.sh/reading/painting-with-gaussians.md")
    expect(homeMarkdown).toContain("https://atet.sh/reading/gemini-omni.md")
    expect(llmsTxt).toContain("https://atet.sh/reading/draw-faces-with-javascript.md")
    expect(llmsTxt).toContain("https://atet.sh/reading/feynobg.md")
    expect(llmsTxt).toContain("https://atet.sh/reading/painting-with-gaussians.md")
    expect(llmsTxt).toContain("https://atet.sh/reading/gemini-omni.md")
    expect(notFoundMarkdown).toContain("https://atet.sh/llms.txt")
    expect(notFoundMarkdown).toContain("https://atet.sh/sitemap.xml")
  })

  test("redirects the retired docs route and each reviewed predecessor host", async () => {
    const vercel = JSON.parse(
      await readFile(join(appDirectory, "vercel.json"), "utf8"),
    ) as {
      redirects?: Array<{
        source?: string
        has?: Array<{ type?: string; value?: string }>
        destination?: string
        permanent?: boolean
      }>
    }
    const redirects = vercel.redirects ?? []
    const hostRedirects = redirects
      .filter(redirect => redirect.has !== undefined)
      .map(redirect => ({
        source: redirect.source,
        host: redirect.has?.[0],
        destination: redirect.destination,
        permanent: redirect.permanent,
      }))
    const routeRedirects = redirects
      .filter(redirect => redirect.has === undefined)
      .map(redirect => ({
        source: redirect.source,
        destination: redirect.destination,
        permanent: redirect.permanent,
      }))

    expect(routeRedirects).toEqual([
      { source: "/docs", destination: "/", permanent: true },
      { source: "/docs/:path*", destination: "/", permanent: true },
    ])
    expect(hostRedirects).toEqual([
      { source: "/", host: { type: "host", value: "transmute.rocks" }, destination: "https://atet.sh/", permanent: true },
      { source: "/:path*", host: { type: "host", value: "transmute.rocks" }, destination: "https://atet.sh/:path*", permanent: true },
      { source: "/", host: { type: "host", value: "www.transmute.rocks" }, destination: "https://atet.sh/", permanent: true },
      { source: "/:path*", host: { type: "host", value: "www.transmute.rocks" }, destination: "https://atet.sh/:path*", permanent: true },
      { source: "/", host: { type: "host", value: "hraness.graphics" }, destination: "https://atet.sh/", permanent: true },
      { source: "/:path*", host: { type: "host", value: "hraness.graphics" }, destination: "https://atet.sh/:path*", permanent: true },
      { source: "/", host: { type: "host", value: "hraness.studio" }, destination: "https://atet.sh/", permanent: true },
      { source: "/:path*", host: { type: "host", value: "hraness.studio" }, destination: "https://atet.sh/:path*", permanent: true },
    ])

    for (const redirect of hostRedirects) {
      const sourceHost = redirect.host?.value
      expect(sourceHost).not.toBe("atet.sh")
      expect(new URL(redirect.destination?.replace(":path*", "") ?? "https://invalid").host)
        .not.toBe(sourceHost)
    }

    expect(new Set(hostRedirects.map(redirect => redirect.host?.value))).toEqual(new Set([
      "transmute.rocks",
      "www.transmute.rocks",
      "hraness.graphics",
      "hraness.studio",
    ]))
  })

  test("serves a strict CSP, security headers, and immutable fingerprinted assets", async () => {
    const vercel = JSON.parse(
      await readFile(join(appDirectory, "vercel.json"), "utf8"),
    ) as {
      cleanUrls?: boolean
      headers?: Array<{ source?: string; headers?: Array<{ key?: string; value?: string }> }>
      rewrites?: Array<{
        source?: string
        destination?: string
        has?: Array<{ type?: string; key?: string; value?: string }>
      }>
      trailingSlash?: boolean
    }
    const ordinary = vercel.headers
      ?.find(entry => entry.source === "/((?!preview$).*)")?.headers ?? []
    const preview = vercel.headers?.find(entry => entry.source === "/preview")?.headers ?? []
    const assets = vercel.headers?.find(entry => entry.source === "/assets/(.*)")?.headers ?? []
    const byKey = new Map(ordinary.map(header => [header.key, header.value]))
    const previewByKey = new Map(preview.map(header => [header.key, header.value]))
    const csp = byKey.get("Content-Security-Policy") ?? ""
    const previewCsp = previewByKey.get("Content-Security-Policy") ?? ""

    expect(vercel.headers?.find(entry => entry.source === "/(.*)")).toBeUndefined()
    expect(csp).toContain("connect-src https://us.i.posthog.com")
    expect(csp).toContain("font-src 'self'")
    expect(csp).not.toMatch(/font-src[^;]*(?:https?:|data:)/u)
    expect(csp).toContain("form-action 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(byKey.get("X-Frame-Options")).toBe("DENY")
    expect(byKey.get("Referrer-Policy")).toBe("no-referrer")
    expect(byKey.get("Strict-Transport-Security")).toContain("includeSubDomains")
    expect(byKey.get("Vary")).toBe("Accept, Accept-Encoding")
    expect(previewCsp).toBe(
      "default-src 'none'; base-uri 'none'; connect-src 'none'; font-src 'self'; "
      + "form-action 'none'; frame-ancestors https://hraness.com https://www.hraness.com; "
      + "img-src 'none'; object-src 'none'; script-src 'none'; style-src 'self'; "
      + "upgrade-insecure-requests",
    )
    expect(previewCsp).not.toMatch(/font-src[^;]*(?:https?:|data:)/u)
    expect(previewByKey.get("X-Frame-Options")).toBeUndefined()
    expect(previewByKey.get("X-Robots-Tag")).toBe(
      "noindex, nofollow, noarchive, nosnippet",
    )
    expect(previewByKey.get("Link")).toBe('<https://atet.sh/>; rel="canonical"')
    expect(vercel.cleanUrls).toBe(true)
    expect(vercel.trailingSlash).toBe(false)
    for (const key of [
      "Permissions-Policy",
      "Referrer-Policy",
      "X-Content-Type-Options",
      "Cross-Origin-Opener-Policy",
      "Strict-Transport-Security",
      "Vary",
    ]) {
      expect(previewByKey.get(key)).toBe(byKey.get(key))
    }
    expect(vercel.headers
      ?.filter(entry => entry.headers?.some(header => (
        header.key === "Content-Security-Policy"
      )))
      .map(entry => entry.source)).toEqual(["/((?!preview$).*)", "/preview"])
    const ordinaryPathPattern = /^\/((?!preview$).*)$/u
    expect(ordinaryPathPattern.test("/preview")).toBe(false)
    for (const pathname of [
      "/",
      "/Preview",
      "/preview.html",
      "/preview/",
      "/preview/child",
      "/reading/feynobg",
      "/assets/example.css",
      "/missing",
    ]) {
      expect(ordinaryPathPattern.test(pathname)).toBe(true)
    }
    expect(assets).toContainEqual({
      key: "Cache-Control",
      value: "public, max-age=31536000, immutable",
    })

    const home = vercel.headers?.find(entry => entry.source === "/")?.headers ?? []
    const markdown = vercel.headers?.find(entry => entry.source === "/index.md")?.headers ?? []
    const readingIndex = vercel.headers?.find(entry => entry.source === "/reading")?.headers ?? []
    const readingIndexMarkdownHeader = vercel.headers?.find(entry => entry.source === "/reading/index.md")?.headers ?? []
    const reading = vercel.headers?.find(entry => entry.source === "/reading/draw-faces-with-javascript")?.headers ?? []
    const readingMarkdown = vercel.headers?.find(entry => entry.source === "/reading/draw-faces-with-javascript.md")?.headers ?? []
    const readingFeynobg = vercel.headers?.find(entry => entry.source === "/reading/feynobg")?.headers ?? []
    const readingFeynobgMarkdownHeader = vercel.headers?.find(entry => entry.source === "/reading/feynobg.md")?.headers ?? []
    const readingGaussians = vercel.headers?.find(entry => entry.source === "/reading/painting-with-gaussians")?.headers ?? []
    const readingGaussiansMarkdownHeader = vercel.headers?.find(entry => entry.source === "/reading/painting-with-gaussians.md")?.headers ?? []
    const readingGeminiOmni = vercel.headers?.find(entry => entry.source === "/reading/gemini-omni")?.headers ?? []
    const readingGeminiOmniMarkdownHeader = vercel.headers?.find(entry => entry.source === "/reading/gemini-omni.md")?.headers ?? []
    const llms = vercel.headers?.find(entry => entry.source === "/llms.txt")?.headers ?? []
    expect(home).toContainEqual({
      key: "Link",
      value: '</index.md>; rel="alternate"; type="text/markdown", </llms.txt>; rel="describedby"',
    })
    expect(markdown).toContainEqual({
      key: "Content-Type",
      value: "text/markdown; charset=utf-8",
    })
    expect(readingIndex).toContainEqual({
      key: "Link",
      value: '</reading/index.md>; rel="alternate"; type="text/markdown", </llms.txt>; rel="describedby"',
    })
    expect(readingIndexMarkdownHeader).toContainEqual({
      key: "Content-Type",
      value: "text/markdown; charset=utf-8",
    })
    expect(reading).toContainEqual({
      key: "Link",
      value: '</reading/draw-faces-with-javascript.md>; rel="alternate"; type="text/markdown", </llms.txt>; rel="describedby"',
    })
    expect(readingMarkdown).toContainEqual({
      key: "Content-Type",
      value: "text/markdown; charset=utf-8",
    })
    expect(readingFeynobg).toContainEqual({
      key: "Link",
      value: '</reading/feynobg.md>; rel="alternate"; type="text/markdown", </llms.txt>; rel="describedby"',
    })
    expect(readingFeynobgMarkdownHeader).toContainEqual({
      key: "Content-Type",
      value: "text/markdown; charset=utf-8",
    })
    expect(readingGaussians).toContainEqual({
      key: "Link",
      value: '</reading/painting-with-gaussians.md>; rel="alternate"; type="text/markdown", </llms.txt>; rel="describedby"',
    })
    expect(readingGaussiansMarkdownHeader).toContainEqual({
      key: "Content-Type",
      value: "text/markdown; charset=utf-8",
    })
    expect(readingGeminiOmni).toContainEqual({
      key: "Link",
      value: '</reading/gemini-omni.md>; rel="alternate"; type="text/markdown", </llms.txt>; rel="describedby"',
    })
    expect(readingGeminiOmniMarkdownHeader).toContainEqual({
      key: "Content-Type",
      value: "text/markdown; charset=utf-8",
    })
    expect(llms).toContainEqual({
      key: "Content-Type",
      value: "text/plain; charset=utf-8",
    })
    expect(vercel.rewrites).toEqual([
      {
        source: "/",
        has: [{ type: "header", key: "accept", value: "^text/markdown" }],
        destination: "/index.md",
      },
      {
        source: "/reading",
        has: [{ type: "header", key: "accept", value: "^text/markdown" }],
        destination: "/reading/index.md",
      },
      {
        source: "/reading/draw-faces-with-javascript",
        has: [{ type: "header", key: "accept", value: "^text/markdown" }],
        destination: "/reading/draw-faces-with-javascript.md",
      },
      {
        source: "/reading/feynobg",
        has: [{ type: "header", key: "accept", value: "^text/markdown" }],
        destination: "/reading/feynobg.md",
      },
      {
        source: "/reading/painting-with-gaussians",
        has: [{ type: "header", key: "accept", value: "^text/markdown" }],
        destination: "/reading/painting-with-gaussians.md",
      },
      {
        source: "/reading/gemini-omni",
        has: [{ type: "header", key: "accept", value: "^text/markdown" }],
        destination: "/reading/gemini-omni.md",
      },
    ])
  })

  test("renders the canonical Hraness network footer on every ordinary HTML page", async () => {
    const documents = await Promise.all([
      readBuilt("index.html"),
      readBuilt("404.html"),
      readBuilt("reading/index.html"),
      readBuilt("reading/draw-faces-with-javascript.html"),
      readBuilt("reading/feynobg.html"),
      readBuilt("reading/painting-with-gaussians.html"),
      readBuilt("reading/gemini-omni.html"),
    ])
    const expectedHrefs = [
      HRANESS_HOME_URL,
      HRANESS_NEWSLETTER_URL,
      ...hranessSocialLinks.map(({ href }) => href),
    ]

    for (const document of documents) {
      expect(document.match(/<footer\b/gu)).toHaveLength(1)
      const footer = /<footer\b[\s\S]*?<\/footer>/u.exec(document)?.[0]
      expect(footer).toContain('data-slot="hraness-site-footer"')
      expect(footer?.match(/data-slot="hraness-mark"/gu)).toHaveLength(1)
      expect(footer?.match(/data-slot="social-icon"/gu)).toHaveLength(10)
      expect(
        [...(footer?.matchAll(/<a\b[^>]*\shref="([^"]+)"/gu) ?? [])]
          .map(match => match[1]),
      ).toEqual(expectedHrefs)
    }
  })

  test("selects markdown, HTML, and 406 from Accept quality values", () => {
    expect(preferredRepresentation(null)).toBe("text/html")
    expect(preferredRepresentation("")).toBe("text/html")
    expect(preferredRepresentation("*/*")).toBe("text/html")
    expect(preferredRepresentation("text/html")).toBe("text/html")
    expect(preferredRepresentation("text/markdown")).toBe("text/markdown")
    expect(preferredRepresentation("text/markdown, text/html, */*")).toBe("text/markdown")
    expect(preferredRepresentation("text/html, text/markdown;q=0.9")).toBe("text/html")
    expect(preferredRepresentation("text/html;q=0, */*;q=1")).toBe("text/markdown")
    expect(preferredRepresentation("text/markdown;q=0, text/html;q=0")).toBeNull()
    expect(preferredRepresentation("application/xml")).toBeNull()
    expect(preferredRepresentation("application/json, image/png")).toBeNull()
    expect(preferredRepresentationFrom(null, ["text/html"])).toBe("text/html")
    expect(preferredRepresentationFrom("text/html", ["text/html"])).toBe("text/html")
    expect(preferredRepresentationFrom("*/*", ["text/html"])).toBe("text/html")
    expect(preferredRepresentationFrom("text/markdown", ["text/html"])).toBeNull()
    expect(preferredRepresentationFrom("text/html;q=0, */*;q=1", ["text/html"])).toBeNull()
    expect(preferredRepresentation("text/html; q = 0.5")).toBe("text/html")
    expect(preferredRepresentation("text/html;level=1, text/markdown;q=0.4")).toBe("text/markdown")

    for (const malformed of [
      ",",
      "text/html;",
      "text/html;q",
      "text/html;q=",
      "text/html;q=wat",
      "text/html;q=.5",
      "text/html;q=00.5",
      "text/html;q=-0.1",
      "text/html;q=1.001",
      "text/html;q=2",
      "text/html;q=0.0000",
      "text/html;q=0.5;q=0.4",
      "text/html;level=1",
      "text/html;charset=utf-8",
      "text/html;q=0.5;extension=unsupported",
    ]) {
      expect(preferredRepresentation(malformed)).toBeNull()
      expect(preferredRepresentationFrom(malformed, ["text/html"])).toBeNull()
    }
  })

  test("negotiates homepage markdown, agent-friendly 404s, and 406 without an API route", async () => {
    expect(isHomePath("/")).toBe(true)
    expect(isHomePath("/index.html")).toBe(true)
    expect(isReadingFacesPath("/reading/draw-faces-with-javascript")).toBe(true)
    expect(isReadingFacesPath("/reading/draw-faces-with-javascript.html")).toBe(true)
    expect(isReadingFacesPath("/reading/missing")).toBe(false)
    expect(isReadingIndexPath("/reading")).toBe(true)
    expect(isReadingIndexPath("/reading/")).toBe(true)
    expect(isReadingIndexPath("/reading/index.html")).toBe(true)
    expect(isReadingIndexPath("/reading/missing")).toBe(false)
    expect(isReadingFeynobgPath("/reading/feynobg")).toBe(true)
    expect(isReadingFeynobgPath("/reading/feynobg.html")).toBe(true)
    expect(isReadingFeynobgPath("/reading/missing")).toBe(false)
    expect(isReadingGaussiansPath("/reading/painting-with-gaussians")).toBe(true)
    expect(isReadingGaussiansPath("/reading/painting-with-gaussians.html")).toBe(true)
    expect(isReadingGaussiansPath("/reading/missing")).toBe(false)
    expect(isReadingGeminiOmniPath("/reading/gemini-omni")).toBe(true)
    expect(isReadingGeminiOmniPath("/reading/gemini-omni.html")).toBe(true)
    expect(isReadingGeminiOmniPath("/reading/missing")).toBe(false)
    expect(isPreservedRedirectPath("/docs")).toBe(true)
    expect(isPreservedRedirectPath("/docs/install")).toBe(true)
    expect(isPreviewPath("/preview")).toBe(true)
    expect(isPreviewPath("/preview.html")).toBe(true)
    expect(isPreviewPath("/preview/child")).toBe(false)
    expect(isNegotiableDocumentPath("/missing-route")).toBe(true)
    expect(isNegotiableDocumentPath("/reading/draw-faces-with-javascript")).toBe(true)
    expect(isNegotiableDocumentPath("/reading/feynobg")).toBe(true)
    expect(isNegotiableDocumentPath("/reading/painting-with-gaussians")).toBe(true)
    expect(isNegotiableDocumentPath("/reading/gemini-omni")).toBe(true)
    expect(isNegotiableDocumentPath("/llms.txt")).toBe(false)
    expect(isNegotiableDocumentPath("/index.md")).toBe(false)
    expect(isNegotiableDocumentPath("/assets/styles.css")).toBe(false)
    expect(isNegotiableDocumentPath("/preview")).toBe(true)
    expect(isNegotiableDocumentPath("/preview.html")).toBe(true)

    const markdownHome = negotiateSiteRequest(new Request("https://atet.sh/", {
      headers: { Accept: "text/markdown" },
    }))
    expect(markdownHome).toBeDefined()
    expect(markdownHome?.status).toBe(200)
    expect(markdownHome?.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
    expect(markdownHome?.headers.get("vary")).toBe("Accept, Accept-Encoding")
    expect(markdownHome?.headers.get("link")).toContain('rel="canonical"')
    expect(await markdownHome?.text()).toBe(homeMarkdown)

    const htmlHome = negotiateSiteRequest(new Request("https://atet.sh/", {
      headers: { Accept: "text/html" },
    }))
    expect(htmlHome).toBeUndefined()

    const markdownReading = negotiateSiteRequest(new Request("https://atet.sh/reading/draw-faces-with-javascript", {
      headers: { Accept: "text/markdown" },
    }))
    expect(markdownReading?.status).toBe(200)
    expect(markdownReading?.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
    expect(markdownReading?.headers.get("link")).toContain('rel="canonical"')
    expect(await markdownReading?.text()).toBe(readingFacesMarkdown)

    const htmlReading = negotiateSiteRequest(new Request("https://atet.sh/reading/draw-faces-with-javascript", {
      headers: { Accept: "text/html" },
    }))
    expect(htmlReading).toBeUndefined()

    const markdownFeynobg = negotiateSiteRequest(new Request("https://atet.sh/reading/feynobg", {
      headers: { Accept: "text/markdown" },
    }))
    expect(markdownFeynobg?.status).toBe(200)
    expect(markdownFeynobg?.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
    expect(markdownFeynobg?.headers.get("link")).toContain('rel="canonical"')
    expect(await markdownFeynobg?.text()).toBe(readingFeynobgMarkdown)

    const htmlFeynobg = negotiateSiteRequest(new Request("https://atet.sh/reading/feynobg", {
      headers: { Accept: "text/html" },
    }))
    expect(htmlFeynobg).toBeUndefined()

    const markdownGaussians = negotiateSiteRequest(new Request("https://atet.sh/reading/painting-with-gaussians", {
      headers: { Accept: "text/markdown" },
    }))
    expect(markdownGaussians?.status).toBe(200)
    expect(markdownGaussians?.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
    expect(markdownGaussians?.headers.get("link")).toContain('rel="canonical"')
    expect(await markdownGaussians?.text()).toBe(readingGaussiansMarkdown)

    const htmlGaussians = negotiateSiteRequest(new Request("https://atet.sh/reading/painting-with-gaussians", {
      headers: { Accept: "text/html" },
    }))
    expect(htmlGaussians).toBeUndefined()

    const markdownGeminiOmni = negotiateSiteRequest(new Request("https://atet.sh/reading/gemini-omni", {
      headers: { Accept: "text/markdown" },
    }))
    expect(markdownGeminiOmni?.status).toBe(200)
    expect(markdownGeminiOmni?.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
    expect(markdownGeminiOmni?.headers.get("link")).toContain('rel="canonical"')
    expect(await markdownGeminiOmni?.text()).toBe(readingGeminiOmniMarkdown)

    const htmlGeminiOmni = negotiateSiteRequest(new Request("https://atet.sh/reading/gemini-omni", {
      headers: { Accept: "text/html" },
    }))
    expect(htmlGeminiOmni).toBeUndefined()

    const docsRedirect = negotiateSiteRequest(new Request("https://atet.sh/docs", {
      headers: { Accept: "text/markdown" },
    }))
    expect(docsRedirect).toBeUndefined()

    const markdownNotFound = negotiateSiteRequest(new Request("https://atet.sh/this-path-does-not-exist", {
      headers: { Accept: "text/markdown" },
    }))
    expect(markdownNotFound?.status).toBe(404)
    expect(markdownNotFound?.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
    expect(markdownNotFound?.headers.get("vary")).toBe("Accept, Accept-Encoding")
    expect(markdownNotFound?.headers.get("x-robots-tag")).toBe("noindex")
    expect(await markdownNotFound?.text()).toBe(notFoundMarkdown)

    const notAcceptable = negotiateSiteRequest(new Request("https://atet.sh/", {
      headers: { Accept: "application/xml" },
    }))
    expect(notAcceptable?.status).toBe(406)
    expect(notAcceptable?.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(notAcceptable?.headers.get("vary")).toBe("Accept")
    expect(await notAcceptable?.text()).toBe(notAcceptableBody)

    const staticFile = negotiateSiteRequest(new Request("https://atet.sh/llms.txt", {
      headers: { Accept: "application/xml" },
    }))
    expect(staticFile).toBeUndefined()

    for (const accept of ["text/markdown", "application/xml", "text/html;q=0, */*;q=1"]) {
      const preview = new Request("https://atet.sh/preview", {
        headers: { Accept: accept },
      })
      const negotiated = negotiateSiteRequest(preview)
      expect(negotiated?.status).toBe(406)
      expect(negotiated?.headers.get("content-type")).toBe("text/plain; charset=utf-8")
      expect(negotiated?.headers.get("vary")).toBe("Accept")
      expect(await negotiated?.text()).toBe("Not Acceptable\n\nAvailable: text/html\n")

      const middlewareResponse = middleware(preview)
      expect(middlewareResponse?.status).toBe(406)
      expect(await middlewareResponse?.text()).toBe("Not Acceptable\n\nAvailable: text/html\n")
    }

    for (const accept of ["text/html", "*/*"]) {
      const preview = new Request("https://atet.sh/preview", {
        headers: { Accept: accept },
      })
      expect(negotiateSiteRequest(preview)).toBeUndefined()
      expect(middleware(preview)).toBeUndefined()
    }

    const headMarkdown = negotiateSiteRequest(new Request("https://atet.sh/", {
      headers: { Accept: "text/markdown" },
      method: "HEAD",
    }))
    expect(headMarkdown?.status).toBe(200)
    expect(headMarkdown?.headers.get("content-type")).toBe("text/markdown; charset=utf-8")
    expect(await headMarkdown?.text()).toBe("")

    const headNotFound = negotiateSiteRequest(new Request("https://atet.sh/missing-route", {
      headers: { Accept: "text/markdown" },
      method: "HEAD",
    }))
    expect(headNotFound?.status).toBe(404)
    expect(await headNotFound?.text()).toBe("")

    for (const path of ["/", "/preview"]) {
      const headNotAcceptable = negotiateSiteRequest(new Request(`https://atet.sh${path}`, {
        headers: { Accept: "application/xml" },
        method: "HEAD",
      }))
      expect(headNotAcceptable?.status).toBe(406)
      expect(headNotAcceptable?.headers.get("vary")).toBe("Accept")
      expect(await headNotAcceptable?.text()).toBe("")

      const headHtml = new Request(`https://atet.sh${path}`, {
        headers: { Accept: "text/html" },
        method: "HEAD",
      })
      expect(negotiateSiteRequest(headHtml)).toBeUndefined()
      expect(middleware(headHtml)).toBeUndefined()
    }

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      for (const path of ["/", "/missing-route", "/preview"]) {
        for (const accept of ["text/markdown", "application/xml", "text/html"]) {
          const url = `https://atet.sh${path}`
          expect(negotiateSiteRequest(new Request(url, {
            headers: { Accept: accept },
            method,
          }))).toBeUndefined()
          expect(middleware(new Request(url, {
            headers: { Accept: accept },
            method,
          }))).toBeUndefined()
        }
      }
    }

    const html = await readSource("index.html")
    const build = await readFile(join(appDirectory, "scripts/build.ts"), "utf8")
    expect(html).not.toMatch(/\/api\//)
    expect(build).not.toMatch(/\/api\//)
    expect(build).toContain('writeFile(join(outputDirectory, file), contents)')
    expect(middlewareConfig.matcher).toContain("/")
    const middlewareMarkdown = middleware(new Request("https://atet.sh/", {
      headers: { Accept: "text/markdown" },
    }))
    expect(middlewareMarkdown?.status).toBe(200)
    expect(await middlewareMarkdown?.text()).toBe(homeMarkdown)
  })

  test("publishes one original reading take on Mannay’s JavaScript faces", async () => {
    const [html, builtHtml, builtMarkdown, readingFiles] = await Promise.all([
      readFile(join(appDirectory, "src/reading/draw-faces-with-javascript.html"), "utf8"),
      readBuilt("reading/draw-faces-with-javascript.html"),
      readBuilt("reading/draw-faces-with-javascript.md"),
      readdir(join(appDirectory, "dist/reading")),
    ])
    const home = await readBuilt("index.html")
    const searchableHtml = html.replace(/\s+/gu, " ")

    expect(html.match(/<h1\b/gu)).toHaveLength(1)
    expect(html).toContain("<h1 id=\"page-title\">Keep the source small enough to vary</h1>")
    expect(html).toContain('<link rel="canonical" href="https://atet.sh/reading/draw-faces-with-javascript">')
    expect(html).toContain('<link rel="alternate" type="text/markdown" href="/reading/draw-faces-with-javascript.md">')
    expect(html).toContain('<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">')
    expect(html).toContain('href="https://atet.sh/"')
    expect(html).toContain('href="https://hraness.com"')
    expect(html).toContain('href="https://hraness.com/reading/draw-faces-with-javascript"')
    expect(searchableHtml).toContain("Atet does not ship a face generator")
    expect(searchableHtml).toContain("There is no Atet account or hosted project database")
    expect(searchableHtml).toContain("converts raster artwork to SVG locally")
    expect(searchableHtml).toContain("HTML, SVG, shaders, and Three.js")
    expect(html).not.toContain("{{ANALYTICS_SCRIPT}}")
    expect(html).not.toContain("data-copy-command")
    expect(html).not.toContain("You can just draw faces with javascript")
    expect(searchableHtml).not.toContain("background removal")
    expect(searchableHtml).not.toContain("eigendrum")
    expect(builtHtml).not.toContain("{{")
    expect(builtHtml).not.toMatch(/analytics-|posthog|phc_/i)
    expect(builtMarkdown).toBe(readingFacesMarkdown)
    expect(readingFacesMarkdown).toContain("https://atet.sh/")
    expect(readingFacesMarkdown).toContain("https://hraness.com")
    expect(readingFacesMarkdown).toContain("https://hraness.com/reading/draw-faces-with-javascript")
    expect(readingFiles.sort()).toEqual([
      "draw-faces-with-javascript.html",
      "draw-faces-with-javascript.md",
      "feynobg.html",
      "feynobg.md",
      "gemini-omni.html",
      "gemini-omni.md",
      "index.html",
      "index.md",
      "painting-with-gaussians.html",
      "painting-with-gaussians.md",
    ])
    expect(home).toContain('href="/reading/draw-faces-with-javascript"')
    expect(homeMarkdown).toContain("Keep the source small enough to vary")
  })

  test("publishes one original reading take on FeyNoBg", async () => {
    const [html, builtHtml, builtMarkdown] = await Promise.all([
      readFile(join(appDirectory, "src/reading/feynobg.html"), "utf8"),
      readBuilt("reading/feynobg.html"),
      readBuilt("reading/feynobg.md"),
    ])
    const home = await readBuilt("index.html")
    const searchableHtml = html.replace(/\s+/gu, " ")

    expect(html.match(/<h1\b/gu)).toHaveLength(1)
    expect(html).toContain("<h1 id=\"page-title\">Keep the cutout from replacing the source</h1>")
    expect(html).not.toContain("Keep the source small enough to vary</h1>")
    expect(html).toContain('<link rel="canonical" href="https://atet.sh/reading/feynobg">')
    expect(html).toContain('<link rel="alternate" type="text/markdown" href="/reading/feynobg.md">')
    expect(html).toContain('<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">')
    expect(html).toContain('href="https://atet.sh/"')
    expect(html).toContain('href="/reading/draw-faces-with-javascript"')
    expect(html).toContain('href="/reading/painting-with-gaussians"')
    expect(html).toContain('href="https://hraness.com"')
    expect(html).toContain('href="https://hraness.com/reading/feynobg-a-sota-model-for-background-removal"')
    expect(html).toContain('href="https://usefeyn.com/blog/feynobg/"')
    expect(searchableHtml).toContain("Atet does not ship FeyNoBg or a background-removal command")
    expect(searchableHtml).toContain("There is no Atet account or hosted project database")
    expect(searchableHtml).toContain("This page does not assign a rank")
    expect(searchableHtml).toContain("Producing this opacity map requires two skills")
    expect(searchableHtml).not.toContain("Treat recognition and boundary precision as coupled skills")
    expect(searchableHtml).not.toContain("Add capacity without discarding prior learning")
    expect(searchableHtml).not.toContain("263-million-parameter")
    expect(html).not.toContain("{{ANALYTICS_SCRIPT}}")
    expect(html).not.toContain("data-copy-command")
    expect(builtHtml).not.toContain("{{")
    expect(builtHtml).not.toMatch(/analytics-|posthog|phc_/i)
    expect(builtMarkdown).toBe(readingFeynobgMarkdown)
    expect(readingFeynobgMarkdown).toContain("https://atet.sh/")
    expect(readingFeynobgMarkdown).toContain("https://atet.sh/reading/draw-faces-with-javascript")
    expect(readingFeynobgMarkdown).toContain("https://atet.sh/reading/painting-with-gaussians")
    expect(readingFeynobgMarkdown).toContain("https://hraness.com")
    expect(readingFeynobgMarkdown).toContain("https://hraness.com/reading/feynobg-a-sota-model-for-background-removal")
    expect(readingFeynobgMarkdown).toContain("https://usefeyn.com/blog/feynobg/")
    expect(home).toContain('href="/reading/feynobg"')
    expect(homeMarkdown).toContain("Keep the cutout from replacing the source")
  })

  test("publishes one original reading take on Sotnikov’s painterly Gaussian renderer", async () => {
    const [html, builtHtml, builtMarkdown] = await Promise.all([
      readFile(join(appDirectory, "src/reading/painting-with-gaussians.html"), "utf8"),
      readBuilt("reading/painting-with-gaussians.html"),
      readBuilt("reading/painting-with-gaussians.md"),
    ])
    const home = await readBuilt("index.html")
    const searchableHtml = html.replace(/\s+/gu, " ")

    expect(html.match(/<h1\b/gu)).toHaveLength(1)
    expect(html).toContain("<h1 id=\"page-title\">Keep the stroke decision in the renderer</h1>")
    expect(html).not.toContain("Keep the source small enough to vary</h1>")
    expect(html).not.toContain("Keep the cutout from replacing the source</h1>")
    expect(html).toContain('<link rel="canonical" href="https://atet.sh/reading/painting-with-gaussians">')
    expect(html).toContain('<link rel="alternate" type="text/markdown" href="/reading/painting-with-gaussians.md">')
    expect(html).toContain('<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">')
    expect(html).toContain('href="https://atet.sh/"')
    expect(html).toContain('href="/reading/draw-faces-with-javascript"')
    expect(html).toContain('href="/reading/feynobg"')
    expect(html).toContain('href="https://hraness.com"')
    expect(html).toContain('href="https://hraness.com/reading/painting-with-gaussians"')
    expect(html).toContain('href="https://yogthos.net/posts/2026-08-03-splat-painter.html"')
    expect(searchableHtml).toContain("Atet does not ship a Gaussian painter or a splat-painter command")
    expect(searchableHtml).toContain("There is no Atet account or hosted project database")
    expect(searchableHtml).toContain("classical image analysis")
    expect(searchableHtml).toContain("An agent can propose marks")
    expect(searchableHtml).toContain("randomly seeded splats optimized against a target")
    expect(searchableHtml).toContain("contour and texture measurements")
    for (const quotedExcerpt of [
      "slow and opaque",
      "ends up being simply a lossy reconstruction",
      "analyzing edges and textures of an image",
    ]) {
      expect(searchableHtml).not.toContain(quotedExcerpt)
      expect(readingGaussiansMarkdown).not.toContain(quotedExcerpt)
    }
    expect(searchableHtml).not.toContain("Treat recognition and boundary precision as coupled skills")
    expect(searchableHtml).not.toContain("You can just draw faces with javascript")
    expect(searchableHtml).not.toContain("Add capacity without discarding prior learning")
    expect(html).not.toMatch(/Zo\b|stripedex\.com|spongeresearch\.com/i)
    expect(html).not.toContain("{{ANALYTICS_SCRIPT}}")
    expect(html).not.toContain("data-copy-command")
    expect(builtHtml).not.toContain("{{")
    expect(builtHtml).not.toMatch(/analytics-|posthog|phc_/i)
    expect(builtMarkdown).toBe(readingGaussiansMarkdown)
    expect(readingGaussiansMarkdown).toContain("https://atet.sh/")
    expect(readingGaussiansMarkdown).toContain("https://atet.sh/reading/draw-faces-with-javascript")
    expect(readingGaussiansMarkdown).toContain("https://atet.sh/reading/feynobg")
    expect(readingGaussiansMarkdown).toContain("https://hraness.com")
    expect(readingGaussiansMarkdown).toContain("https://hraness.com/reading/painting-with-gaussians")
    expect(readingGaussiansMarkdown).toContain("https://yogthos.net/posts/2026-08-03-splat-painter.html")
    expect(readingGaussiansMarkdown).toContain("https://atet.sh/reading/gemini-omni")
    expect(html).toContain('href="/reading/gemini-omni"')
    expect(home).toContain('href="/reading/painting-with-gaussians"')
    expect(homeMarkdown).toContain("Keep the stroke decision in the renderer")
  })

  test("publishes one original reading take on Gemini Omni 1.1 Flash", async () => {
    const [html, builtHtml, builtMarkdown] = await Promise.all([
      readFile(join(appDirectory, "src/reading/gemini-omni.html"), "utf8"),
      readBuilt("reading/gemini-omni.html"),
      readBuilt("reading/gemini-omni.md"),
    ])
    const home = await readBuilt("index.html")
    const searchableHtml = html.replace(/\s+/gu, " ")

    expect(html.match(/<h1\b/gu)).toHaveLength(1)
    expect(html).toContain("<h1 id=\"page-title\">Control in the renderer still beats a bigger Omni prompt</h1>")
    expect(html).not.toContain("Keep the source small enough to vary</h1>")
    expect(html).not.toContain("Keep the cutout from replacing the source</h1>")
    expect(html).not.toContain("Keep the stroke decision in the renderer</h1>")
    expect(html).toContain('<link rel="canonical" href="https://atet.sh/reading/gemini-omni">')
    expect(html).toContain('<link rel="alternate" type="text/markdown" href="/reading/gemini-omni.md">')
    expect(html).toContain('<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">')
    expect(html).toContain('href="https://atet.sh/"')
    expect(html).toContain('href="/reading/painting-with-gaussians"')
    expect(html).toContain('href="https://hraness.com"')
    expect(html).toContain('href="https://hraness.com/reading/gemini-omni-1-1-flash"')
    expect(html).toContain('href="https://blog.google/innovation-and-ai/technology/developers-tools/build-with-gemini-omni-1-1-flash/"')
    expect(searchableHtml).toContain("This page is an Atet reading take")
    expect(searchableHtml).toContain("It is not the Hraness Reading digest")
    expect(searchableHtml).toContain("Atet does not ship Gemini Omni")
    expect(searchableHtml).toContain("There is no Atet account or hosted project database")
    expect(searchableHtml).toContain("Extra prompt control on a general Omni model is not a replacement")
    expect(searchableHtml).toContain("generation knobs")
    expect(searchableHtml).toContain("Keep the stroke decision in the renderer")
    for (const quotedExcerpt of [
      "takes teams beyond generating videos to truly directing them",
      "a leap from previous models that only referenced the final second",
      "You can extend videos in 10-second increments up to a total cumulative length of 40 seconds",
    ]) {
      expect(searchableHtml).not.toContain(quotedExcerpt)
      expect(readingGeminiOmniMarkdown).not.toContain(quotedExcerpt)
    }
    expect(searchableHtml).not.toContain("Treat recognition and boundary precision as coupled skills")
    expect(searchableHtml).not.toContain("You can just draw faces with javascript")
    expect(searchableHtml).not.toContain("slow and opaque")
    expect(html).not.toMatch(/stripedex\.com|spongeresearch\.com|hra\.sh/i)
    expect(html).not.toContain("{{ANALYTICS_SCRIPT}}")
    expect(html).not.toContain("data-copy-command")
    expect(builtHtml).not.toContain("{{")
    expect(builtHtml).not.toMatch(/analytics-|posthog|phc_/i)
    expect(builtMarkdown).toBe(readingGeminiOmniMarkdown)
    expect(readingGeminiOmniMarkdown).toContain("https://atet.sh/")
    expect(readingGeminiOmniMarkdown).toContain("https://atet.sh/reading/painting-with-gaussians")
    expect(readingGeminiOmniMarkdown).toContain("https://hraness.com")
    expect(readingGeminiOmniMarkdown).toContain("https://hraness.com/reading/gemini-omni-1-1-flash")
    expect(readingGeminiOmniMarkdown).toContain("https://blog.google/innovation-and-ai/technology/developers-tools/build-with-gemini-omni-1-1-flash/")
    expect(home).toContain('href="/reading/gemini-omni"')
    expect(homeMarkdown).toContain("Control in the renderer still beats a bigger Omni prompt")
  })
})
