import { beforeAll, describe, expect, test } from "bun:test"
import { readFile, readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { buildWebsite } from "./scripts/build"

const appDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryDirectory = join(appDirectory, "..", "..")
const brandDescription = "Agentic creative coding toolkit. At the beginning of time, when there was nothing but chaos, Atum existed alone in the watery mass of Nun. A pyramid mound called Benben emerged. When the lotus flower bloomed, Atum dawned and became Ra. Every night Ra sails in the underworld on the solar barque Atet."
const searchDescription = "Atet gives coding agents tools to generate images, video, and voice, edit real footage, add motion graphics and captions, and export finished videos."
let builtAssets: Awaited<ReturnType<typeof buildWebsite>>

beforeAll(async () => {
  builtAssets = await buildWebsite()
})

async function readSource(path: string): Promise<string> {
  return await readFile(join(appDirectory, "src", path), "utf8")
}

describe("static Atet site", () => {
  test("makes the README a detailed agent guide with natural GitHub discovery terms", async () => {
    const readme = await readFile(join(repositoryDirectory, "README.md"), "utf8")
    const searchableReadme = readme
      .replaceAll("**", "")
      .replace(/^>\s?/gmu, "")
      .replace(/\s+/gu, " ")
      .toLowerCase()

    for (const heading of [
      "## Install Atet",
      "## Start with a finished job",
      "### Instructions for coding agents",
      "## What Atet does",
      "## How Atet works",
      "## Design and trust",
    ]) {
      expect(readme).toContain(heading)
    }

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

    expect(readme).toContain("bun add --global github:hraness/atet")
    expect(readme).toContain("atet skill install --target claude")
    expect(readme).toContain("atet operations list --json")
    expect(readme).toContain("atet ai video generate")
    expect(readme).toContain("atet workflows show social-variants --json")
    expect(readme).not.toMatch(/checked step|checked path|bounded capability|delivery variant/i)
    expect(readme).not.toContain("https://atet.sh/docs")
    expect(readme).not.toContain("github:hraness/atet#")
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
    expect(html).toContain('<meta property="og:url" content="https://atet.sh/">')
    expect(html).toContain('<meta property="og:image" content="https://atet.sh/og.png">')
    expect(html).toContain('<meta property="og:image:width" content="1200">')
    expect(html).toContain('<meta property="og:image:height" content="630">')
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">')
    expect(html).toContain('<meta name="twitter:image" content="https://atet.sh/og.png">')
    expect(html).toContain('<meta name="twitter:image:alt" content="Atet, AI media generation and video editing for coding agents, beside an abstract solar disk and barque path">')
    expect(html).toContain('<link rel="icon" href="/icon.svg" type="image/svg+xml">')
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">')
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
        sameAs: ["https://github.com/hraness/atet"],
      }),
      expect.objectContaining({
        "@id": "https://atet.sh/#source",
        "@type": "SoftwareSourceCode",
        author: { "@id": "https://hraness.com/#organization" },
        codeRepository: "https://github.com/hraness/atet",
        targetProduct: { "@id": "https://atet.sh/#software" },
      }),
    ]))
  })

  test("puts the complete agent install before the first section ends", async () => {
    const html = await readSource("index.html")
    const searchableHtml = html.replace(/\s+/gu, " ")
    const commands = [
      "bun add --global github:hraness/atet",
      "atet skill install",
      "atet doctor",
    ]
    const positions = commands.map(command => html.indexOf(command))

    expect(positions.every(position => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
    expect(positions.at(-1)).toBeLessThan(html.indexOf("</section>"))
    expect(html).toContain("Make and edit visual media with your coding agent.")
    expect(searchableHtml).toContain("generate images, video, and voice")
    expect(searchableHtml).toContain("edit screen recordings and imported footage")
    expect(searchableHtml).toContain("add captions, graphics, and motion")
    expect(searchableHtml).toContain("export finished videos")
    expect(html).toContain("Requires Bun 1.3.14+ · Installs for Codex by default")
    expect(html).toContain("inside the project you want to work")
    expect(html).toContain("start a new agent session")
    expect(html).toContain("atet skill install --target claude")
    expect(html).toContain("atet skill install --target agents")
    expect(html).toContain("--scope project")
    expect(html).not.toContain("github:hraness/atet#")
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
    expect(searchableHtml.toLowerCase()).toContain("it is not an operating-system")
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
    expect(html).toContain('<main id="main" tabindex="-1">')
    expect(html).not.toMatch(/<section(?![^>]*aria-labelledby)/)
    expect(fragmentLinks.every(fragment => ids.has(fragment))).toBe(true)
    expect(css).toContain(":where(a, button, [tabindex]):focus-visible")
    expect(css).toContain(".docs-index")
    expect(css).toContain(".docs-section")
    expect(css).toContain("@media (max-width: 64rem)")
    expect(css).toContain("@media (max-width: 48rem)")
    expect(css).toContain("@media (max-width: 34rem)")
    expect(css).toContain("@media (prefers-reduced-motion: reduce)")
    expect(css).toContain("@media (forced-colors: active)")
  })

  test("uses a restrained editorial visual system", async () => {
    const css = await readSource("styles.css")

    expect(css).toContain('--font-display: ui-serif, "Iowan Old Style", Baskerville')
    expect(css).toContain("--radius-control: 0.2rem")
    expect(css).toContain("--radius-surface: 0.45rem")
    expect(css).toContain(".install-panel")
    expect(css).toContain(".feature-list > div")
    expect(css).toContain(".origin-note")
    expect(css).not.toMatch(/@font-face|url\([^)]*\.woff/)
  })

  test("ships reproducible correctly sized social and icon assets", async () => {
    const social = new Uint8Array(await Bun.file(join(appDirectory, "src/og.png")).arrayBuffer())
    const apple = new Uint8Array(await Bun.file(join(appDirectory, "src/apple-touch-icon.png")).arrayBuffer())
    const socialSource = await readSource("og-source.svg")
    const icon = await readSource("icon.svg")
    const socialView = new DataView(social.buffer, social.byteOffset, social.byteLength)
    const appleView = new DataView(apple.buffer, apple.byteOffset, apple.byteLength)

    expect(Array.from(social.slice(1, 4))).toEqual([80, 78, 71])
    expect(socialView.getUint32(16)).toBe(1200)
    expect(socialView.getUint32(20)).toBe(630)
    expect(socialSource).toContain("Make and edit")
    expect(socialSource).toContain("visual media")
    expect(socialSource).toContain("with your agent.")
    expect(socialSource).toContain("Iowan Old Style")
    expect(socialSource).toContain('fill="#e8aa48"')
    expect(Array.from(apple.slice(1, 4))).toEqual([80, 78, 71])
    expect(appleView.getUint32(16)).toBe(180)
    expect(appleView.getUint32(20)).toBe(180)
    expect(icon).toContain('viewBox="0 0 64 64"')
    expect(icon).toContain('fill="#090a12"')
    expect(icon).toContain('stop-color="#f6b94a"')
  })

  test("keeps the build dependency-free, fingerprinted, and network-inert", async () => {
    const html = await readSource("index.html")
    const css = await readSource("styles.css")
    const theme = await readSource("theme.js")
    const build = await readFile(join(appDirectory, "scripts/build.ts"), "utf8")
    const manifest = JSON.parse(
      await readFile(join(appDirectory, "package.json"), "utf8"),
    ) as Record<string, unknown>

    expect(manifest.dependencies).toBeUndefined()
    expect(manifest.devDependencies).toBeUndefined()
    expect(new TextEncoder().encode(html).byteLength).toBeLessThan(20_000)
    expect(new TextEncoder().encode(css).byteLength).toBeLessThan(28_000)
    expect(new TextEncoder().encode(theme).byteLength).toBeLessThan(3_000)
    expect(html).not.toMatch(/https:\/\/[^"']+\.(?:css|js)/)
    expect(html).toContain('<link rel="stylesheet" href="{{CSS_ASSET}}">')
    expect(html).toContain('<script src="{{THEME_ASSET}}" defer></script>')
    expect(html).not.toMatch(/analytics|posthog|plausible|segment/i)
    expect(html.match(/<script\b/gu)).toHaveLength(2)
    expect(theme).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/)
    expect(build).toContain('createHash("sha256")')
    expect(build).not.toContain("docsTemplate")
    expect(build).not.toContain('outputDirectory, "docs"')
  })

  test("renders one closed static page with resolved content-hashed assets", async () => {
    const [html, notFound, rootFiles, assetFiles] = await Promise.all([
      readFile(join(appDirectory, "dist/index.html"), "utf8"),
      readFile(join(appDirectory, "dist/404.html"), "utf8"),
      readdir(join(appDirectory, "dist")),
      readdir(join(appDirectory, "dist/assets")),
    ])

    expect(html).toContain(`<link rel="stylesheet" href="${builtAssets.stylesPath}">`)
    expect(html).toContain(`<script src="${builtAssets.themePath}" defer></script>`)
    expect(notFound).toContain(`<link rel="stylesheet" href="${builtAssets.stylesPath}">`)
    expect(notFound).toContain(`<script src="${builtAssets.themePath}" defer></script>`)
    expect(`${html}\n${notFound}`).not.toContain("{{")
    expect(rootFiles.sort()).toEqual([
      "404.html",
      "apple-touch-icon.png",
      "assets",
      "icon.svg",
      "index.html",
      "og.png",
      "robots.txt",
      "sitemap.xml",
    ])
    expect(assetFiles.sort()).toEqual([
      builtAssets.stylesPath.split("/").at(-1),
      builtAssets.themePath.split("/").at(-1),
    ].sort())
  })

  test("publishes only the canonical page to crawler discovery", async () => {
    const robots = await readSource("robots.txt")
    const sitemap = await readSource("sitemap.xml")
    const notFound = await readSource("404.html")
    const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map(match => match[1])

    expect(robots).toBe([
      "User-agent: OAI-SearchBot",
      "Allow: /",
      "",
      "User-agent: Claude-SearchBot",
      "Allow: /",
      "",
      "User-agent: Claude-User",
      "Allow: /",
      "",
      "User-agent: *",
      "Allow: /",
      "",
      "Sitemap: https://atet.sh/sitemap.xml",
      "",
    ].join("\n"))
    expect(locations).toEqual(["https://atet.sh/"])
    expect(notFound).toContain('<meta name="robots" content="noindex, nofollow">')
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
      { source: "/", host: { type: "host", value: "hraness.graphics" }, destination: "https://atet.sh/", permanent: true },
      { source: "/:path*", host: { type: "host", value: "hraness.graphics" }, destination: "https://atet.sh/:path*", permanent: true },
      { source: "/", host: { type: "host", value: "hraness.studio" }, destination: "https://atet.sh/", permanent: true },
      { source: "/:path*", host: { type: "host", value: "hraness.studio" }, destination: "https://atet.sh/:path*", permanent: true },
      { source: "/", host: { type: "host", value: "preview.hraness.graphics" }, destination: "https://preview.atet.sh/", permanent: true },
      { source: "/:path*", host: { type: "host", value: "preview.hraness.graphics" }, destination: "https://preview.atet.sh/:path*", permanent: true },
      { source: "/", host: { type: "host", value: "preview.hraness.studio" }, destination: "https://preview.atet.sh/", permanent: true },
      { source: "/:path*", host: { type: "host", value: "preview.hraness.studio" }, destination: "https://preview.atet.sh/:path*", permanent: true },
    ])

    for (const redirect of hostRedirects) {
      const sourceHost = redirect.host?.value
      expect(sourceHost).not.toBe("atet.sh")
      expect(sourceHost).not.toBe("preview.atet.sh")
      expect(new URL(redirect.destination?.replace(":path*", "") ?? "https://invalid").host)
        .not.toBe(sourceHost)
    }
  })

  test("serves a strict CSP, security headers, and immutable fingerprinted assets", async () => {
    const vercel = JSON.parse(
      await readFile(join(appDirectory, "vercel.json"), "utf8"),
    ) as {
      headers?: Array<{ source?: string; headers?: Array<{ key?: string; value?: string }> }>
    }
    const global = vercel.headers?.find(entry => entry.source === "/(.*)")?.headers ?? []
    const assets = vercel.headers?.find(entry => entry.source === "/assets/(.*)")?.headers ?? []
    const byKey = new Map(global.map(header => [header.key, header.value]))
    const csp = byKey.get("Content-Security-Policy") ?? ""

    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("font-src 'none'")
    expect(csp).toContain("form-action 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(byKey.get("Strict-Transport-Security")).toContain("includeSubDomains")
    expect(assets).toContainEqual({
      key: "Cache-Control",
      value: "public, max-age=31536000, immutable",
    })
  })

  test("preserves the canonical Hraness footer", async () => {
    const html = await readSource("index.html")

    expect(html).toContain('href="https://hraness.com"')
    expect(html).toContain('aria-label="hraness"')
    expect(html).toContain('class="hraness-mark"')
    expect(html).toContain("Atet · MIT · AI media generation and video editing for coding agents.")
  })
})
