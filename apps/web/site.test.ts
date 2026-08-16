import { beforeAll, describe, expect, test } from "bun:test"
import { readFile, readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { buildWebsite } from "./scripts/build"

const appDirectory = dirname(fileURLToPath(import.meta.url))
const description = "Agentic creative coding toolkit. At the beginning of time, when there was nothing but chaos, Atum existed alone in the watery mass of Nun. A pyramid mound called Benben emerged. When the lotus flower bloomed, Atum dawned and became Ra. Every night Ra sails in the underworld on the solar barque Atet."
let builtAssets: Awaited<ReturnType<typeof buildWebsite>>

beforeAll(async () => {
  builtAssets = await buildWebsite()
})

async function readSource(path: string): Promise<string> {
  return await readFile(join(appDirectory, "src", path), "utf8")
}

describe("static Atet site", () => {
  test("publishes one canonical Atet identity across discovery metadata", async () => {
    const html = await readSource("index.html")

    expect(html).toContain("<title>Atet: agentic creative coding toolkit</title>")
    expect(html).toContain(`<meta name="description" content="${description}">`)
    expect(html).toContain('<link rel="canonical" href="https://atet.sh/">')
    expect(html).toContain('<meta property="og:url" content="https://atet.sh/">')
    expect(html).toContain('<meta property="og:image" content="https://atet.sh/og.png">')
    expect(html).toContain('<meta property="og:image:width" content="1200">')
    expect(html).toContain('<meta property="og:image:height" content="630">')
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">')
    expect(html).toContain('<meta name="twitter:image" content="https://atet.sh/og.png">')
    expect(html).toContain('<meta name="twitter:image:alt" content="Atet, carry ideas from first light to final form, beside an abstract solar disk and barque path">')
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
        "@id": "https://atet.sh/#website",
        "@type": "WebSite",
        description,
      }),
      expect.objectContaining({
        "@id": "https://atet.sh/#webpage",
        "@type": "WebPage",
        isPartOf: { "@id": "https://atet.sh/#website" },
        mainEntity: { "@id": "https://atet.sh/#software" },
      }),
      expect.objectContaining({
        "@id": "https://atet.sh/#software",
        "@type": "SoftwareApplication",
        description,
        installUrl: "https://atet.sh/#install",
        sameAs: ["https://github.com/hraness/atet"],
        softwareVersion: "2.0.0",
      }),
      expect.objectContaining({
        "@id": "https://atet.sh/#source",
        "@type": "SoftwareSourceCode",
        codeRepository: "https://github.com/hraness/atet",
        targetProduct: { "@id": "https://atet.sh/#software" },
      }),
    ]))
  })

  test("publishes durable documentation with canonical discovery metadata", async () => {
    const html = await readSource("docs.html")
    const match = /<script type="application\/ld\+json">([\s\S]+?)<\/script>/u.exec(html)
    expect(match?.[1]).toBeDefined()
    const value = JSON.parse(match?.[1] ?? "null") as { "@graph"?: unknown[] }

    expect(html).toContain("<title>Atet documentation: install, use, and understand</title>")
    expect(html).toContain('<link rel="canonical" href="https://atet.sh/docs">')
    expect(html).toContain('<meta property="og:url" content="https://atet.sh/docs">')
    expect(html).toContain('<meta property="og:type" content="article">')
    expect(value["@graph"]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        "@id": "https://atet.sh/docs#page",
        "@type": ["WebPage", "TechArticle"],
        about: { "@id": "https://atet.sh/#software" },
        isPartOf: { "@id": "https://atet.sh/#website" },
      }),
      expect.objectContaining({
        "@type": "BreadcrumbList",
      }),
    ]))
  })

  test("puts the complete agent install in the first viewport on both routes", async () => {
    const [home, docs] = await Promise.all([
      readSource("index.html"),
      readSource("docs.html"),
    ])
    const commands = [
      "bun add --global github:hraness/atet",
      "atet skill install",
    ]

    for (const html of [home, docs]) {
      const positions = commands.map(command => html.indexOf(command))
      expect(positions.every(position => position >= 0)).toBe(true)
      expect(positions).toEqual([...positions].sort((left, right) => left - right))
      expect(html.indexOf(commands[0] ?? "")).toBeLessThan(html.indexOf("</section>"))
    }

    expect(home).toContain("Install Atet. Tell your agent what to make.")
    expect(home).toContain("Bun 1.3.14+ · two commands")
    expect(home).toContain("Start a new agent session")
    expect(docs).toContain("atet doctor")
    expect(docs).toContain("Run the last from the project")
    expect(docs).toContain("atet skill install --target claude")
    expect(docs).toContain("atet skill install --target agents")
    expect(docs).toContain("--scope project")
  })

  test("uses an install, use, features, and design information architecture", async () => {
    const html = await readSource("docs.html")
    const modes = ["> Install<", "> Use<", "> Features<", "> Design<"]
    const positions = modes.map(mode => html.indexOf(mode))

    expect(positions.every(position => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
    expect(html).toContain("How-to</span>")
    expect(html).toContain("Reference</span>")
    expect(html).toContain("Explanation</span>")
    expect(html).not.toContain("Diátaxis")
    expect(html.match(/class="docs-section/gu)).toHaveLength(4)
  })

  test("teaches people through requests instead of a command catalog", async () => {
    const html = await readSource("docs.html")

    for (const claim of [
      "turn this repository architecture into a clear diagram",
      "Vectorize this mark",
      "Create three image directions",
      "Build a seamless animated loop",
      "Atet video project",
    ]) {
      expect(html).toContain(claim)
    }

    expect(html).not.toMatch(/<table\b|class="table-wrap"/)
    expect(html).not.toMatch(/atet\.diagram\.|atet\.image\.|@hraness\/atet\/code/)
    expect(html).not.toMatch(/AI_GATEWAY_API_KEY|VERCEL_OIDC_TOKEN|ATET_CACHE_DIR/)
  })

  test("keeps documentation semantic, linkable, and keyboard-operable", async () => {
    const html = await readSource("docs.html")
    const css = await readSource("styles.css")
    const fragmentLinks = [...html.matchAll(/href="#([^"]+)"/gu)].map(match => match[1])
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/gu)].map(match => match[1]))

    expect(html.match(/<h1\b/gu)).toHaveLength(1)
    expect(html).toContain('<a class="skip-link" href="#docs-content">')
    expect(html).toContain('<nav aria-label="Documentation sections" class="docs-index">')
    expect(html).toContain('aria-current="page" href="/docs"')
    expect(html).not.toMatch(/<section(?![^>]*aria-labelledby)/)
    expect(fragmentLinks.every(fragment => ids.has(fragment))).toBe(true)
    expect(css).toContain(".docs-index")
    expect(css).toContain("@media (max-width: 72rem)")
    expect(css).toContain(".docs-section")
  })

  test("states the four output families in order", async () => {
    const html = await readSource("index.html")
    const families = ["> Images<", "> Diagrams<", "> Animated loops<", "> Video<"]
    const positions = families.map(family => html.indexOf(family))

    expect(positions.every(position => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
  })

  test("explains the system in four plain-language stages", async () => {
    const [home, docs] = await Promise.all([
      readSource("index.html"),
      readSource("docs.html"),
    ])

    for (const claim of ["Your request", "Agent + skill", "Checked work", "Results"]) {
      expect(home).toContain(claim)
    }
    for (const claim of ["Intent", "Plan", "Execution", "Result"]) {
      expect(docs).toContain(claim)
    }
    expect(docs).toContain("Several ways in, one underlying system.")
    expect(docs).toContain("macOS desktop app adds native")
    expect(docs).toContain("capture without creating a second project model")
  })

  test("states the local custody and explicit Gateway boundary without a secret path", async () => {
    const [home, docs] = await Promise.all([
      readSource("index.html"),
      readSource("docs.html"),
    ])
    const theme = await readSource("theme.js")

    for (const claim of ["Local custody", "No Atet account", "Source stays primary", "Bounded work"]) {
      expect(home).toContain(claim)
    }
    expect(home).toContain("Model-backed creation goes from your local Atet process through Vercel AI Gateway")
    expect(docs).toContain("Gateway credentials are supplied by your local process and are not stored by Atet")
    expect(docs).toContain("Atet does not operate a hosted project database or account system")
    expect(`${home}\n${docs}`).not.toMatch(/<form|type="password"|\/api\//)
    expect(theme).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/)
  })

  test("keeps the approved creation story as quiet identity context", async () => {
    const html = await readSource("index.html")

    expect(html).toContain("Agentic creative coding toolkit.")
    expect(html).toContain("Atum dawned and")
    expect(html).toContain("underworld on the solar barque Atet")
    expect(html).toContain('<div class="solar-mark" aria-hidden="true">')
    expect(html).not.toMatch(/hieroglyph|pharaoh|ankh/i)
  })

  test("uses one restrained editorial hierarchy across the homepage and docs", async () => {
    const [html, docs, css] = await Promise.all([
      readSource("index.html"),
      readSource("docs.html"),
      readSource("styles.css"),
    ])

    expect(html).toContain("Install Atet. Tell your agent what to make.")
    expect(docs).toContain("Install Atet for your agent.")
    expect(css).toContain('--font-display: ui-serif, "Iowan Old Style", Baskerville')
    expect(css).toContain(".install-panel")
    expect(css).toContain(".capability-list > div")
    expect(css).toContain("border-left: 1px solid var(--line)")
  })

  test("keeps the page semantic, keyboard-operable, and responsive", async () => {
    const html = await readSource("index.html")
    const css = await readSource("styles.css")

    expect(html.match(/<h1\b/gu)).toHaveLength(1)
    expect(html).toContain('<a class="skip-link" href="#main">')
    expect(html).toContain('<nav aria-label="Primary">')
    expect(html).toContain('<main id="main" tabindex="-1">')
    expect(html).toContain('<div class="solar-mark" aria-hidden="true">')
    expect(html).not.toMatch(/<section(?![^>]*aria-labelledby)/)
    expect(css).toContain(":where(a, button, [tabindex]):focus-visible")
    expect(css).toContain("@media (max-width: 64rem)")
    expect(css).toContain("@media (max-width: 48rem)")
    expect(css).toContain("@media (max-width: 34rem)")
    expect(css).toContain("@media (prefers-reduced-motion: reduce)")
    expect(css).toContain("@media (forced-colors: active)")
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
    expect(socialSource).toContain("Carry ideas")
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
    const docs = await readSource("docs.html")
    const css = await readSource("styles.css")
    const theme = await readSource("theme.js")
    const build = await readFile(join(appDirectory, "scripts/build.ts"), "utf8")
    const manifest = JSON.parse(
      await readFile(join(appDirectory, "package.json"), "utf8"),
    ) as Record<string, unknown>

    expect(manifest.dependencies).toBeUndefined()
    expect(manifest.devDependencies).toBeUndefined()
    expect(new TextEncoder().encode(html).byteLength).toBeLessThan(20_000)
    expect(new TextEncoder().encode(docs).byteLength).toBeLessThan(20_000)
    expect(new TextEncoder().encode(css).byteLength).toBeLessThan(28_000)
    expect(new TextEncoder().encode(theme).byteLength).toBeLessThan(3_000)
    expect(html).not.toMatch(/https:\/\/[^"']+\.(?:css|js)/)
    expect(docs).toContain('<link rel="stylesheet" href="{{CSS_ASSET}}">')
    expect(docs).toContain('<script src="{{THEME_ASSET}}" defer></script>')
    expect(html).not.toMatch(/analytics|posthog|plausible|segment/i)
    expect(docs.match(/<script\b/gu)).toHaveLength(2)
    expect(build).toContain('createHash("sha256")')
    expect(build).toContain('"{{CSS_ASSET}}": stylesPath')
    expect(build).toContain('"{{THEME_ASSET}}": themePath')
  })

  test("renders a closed static tree with resolved content-hashed assets", async () => {
    const [html, docs, notFound, rootFiles, docsFiles, assetFiles] = await Promise.all([
      readFile(join(appDirectory, "dist/index.html"), "utf8"),
      readFile(join(appDirectory, "dist/docs/index.html"), "utf8"),
      readFile(join(appDirectory, "dist/404.html"), "utf8"),
      readdir(join(appDirectory, "dist")),
      readdir(join(appDirectory, "dist/docs")),
      readdir(join(appDirectory, "dist/assets")),
    ])

    expect(html).toContain(`<link rel="stylesheet" href="${builtAssets.stylesPath}">`)
    expect(docs).toContain(`<link rel="stylesheet" href="${builtAssets.stylesPath}">`)
    expect(html).toContain(`<script src="${builtAssets.themePath}" defer></script>`)
    expect(docs).toContain(`<script src="${builtAssets.themePath}" defer></script>`)
    expect(notFound).toContain(`<link rel="stylesheet" href="${builtAssets.stylesPath}">`)
    expect(notFound).toContain(`<script src="${builtAssets.themePath}" defer></script>`)
    expect(`${html}\n${docs}\n${notFound}`).not.toContain("{{")
    expect(rootFiles.sort()).toEqual([
      "404.html",
      "apple-touch-icon.png",
      "assets",
      "docs",
      "icon.svg",
      "index.html",
      "og.png",
      "robots.txt",
      "sitemap.xml",
    ])
    expect(docsFiles).toEqual(["index.html"])
    expect(assetFiles.sort()).toEqual([
      builtAssets.stylesPath.split("/").at(-1),
      builtAssets.themePath.split("/").at(-1),
    ].sort())
  })

  test("publishes both durable routes to crawler discovery", async () => {
    const robots = await readSource("robots.txt")
    const sitemap = await readSource("sitemap.xml")
    const notFound = await readSource("404.html")
    const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map(match => match[1])

    expect(robots).toBe("User-agent: *\nAllow: /\n\nSitemap: https://atet.sh/sitemap.xml\n")
    expect(locations).toEqual(["https://atet.sh/", "https://atet.sh/docs"])
    expect(notFound).toContain('<meta name="robots" content="noindex, nofollow">')
  })

  test("redirects each reviewed predecessor host without looping Atet", async () => {
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
    const projected = redirects.map(redirect => ({
      source: redirect.source,
      host: redirect.has?.[0],
      destination: redirect.destination,
      permanent: redirect.permanent,
    }))

    expect(projected).toEqual([
      { source: "/:path*", host: { type: "host", value: "hraness.graphics" }, destination: "https://atet.sh/:path*", permanent: true },
      { source: "/:path*", host: { type: "host", value: "hraness.studio" }, destination: "https://atet.sh/:path*", permanent: true },
      { source: "/:path*", host: { type: "host", value: "preview.hraness.graphics" }, destination: "https://preview.atet.sh/:path*", permanent: true },
      { source: "/:path*", host: { type: "host", value: "preview.hraness.studio" }, destination: "https://preview.atet.sh/:path*", permanent: true },
    ])

    for (const redirect of projected) {
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
    expect(html).toContain("class=\"hraness-mark\"")
    expect(html).toContain("Atet · MIT · Local-first creative tools.")
  })
})
