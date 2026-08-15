import { beforeAll, describe, expect, test } from "bun:test"
import { readFile, readdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { buildWebsite } from "./scripts/build"

const appDirectory = dirname(fileURLToPath(import.meta.url))
const description = "Open-source TypeScript SDK, Bun CLI, and local runtime for turning ideas and raw assets into images, diagrams, animated loops, and video."
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

    expect(html).toContain("<title>Atet: code-first visual media from source to final</title>")
    expect(html).toContain(`<meta name="description" content="${description}">`)
    expect(html).toContain('<link rel="canonical" href="https://atet.sh/">')
    expect(html).toContain('<meta property="og:url" content="https://atet.sh/">')
    expect(html).toContain('<meta property="og:image" content="https://atet.sh/og.png">')
    expect(html).toContain('<meta property="og:image:width" content="1200">')
    expect(html).toContain('<meta property="og:image:height" content="630">')
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">')
    expect(html).toContain('<meta name="twitter:image" content="https://atet.sh/og.png">')
    expect(html).toContain('<link rel="icon" href="/icon.svg" type="image/svg+xml">')
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">')
    expect(html).not.toMatch(/Transmute|transmute\.rocks|hraness\.(?:graphics|studio)/)
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
        softwareVersion: "1.0.0",
      }),
      expect.objectContaining({
        "@id": "https://atet.sh/#source",
        "@type": "SoftwareSourceCode",
        codeRepository: "https://github.com/hraness/atet",
        targetProduct: { "@id": "https://atet.sh/#software" },
      }),
    ]))
  })

  test("states the four output families in order", async () => {
    const html = await readSource("index.html")
    const families = ["> Images<", "> Diagrams<", "> Animated loops<", "> Video<"]
    const positions = families.map(family => html.indexOf(family))

    expect(positions.every(position => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
  })

  test("documents the immutable project, cache, candidate, preview, and final contracts", async () => {
    const html = await readSource("index.html")

    for (const claim of [
      "one immutable project graph",
      "A verified artifact with the same inputs",
      "A meaningful change creates a new identity",
      "Agents render independent candidates",
      "stale promotion fails closed",
      "complete duration",
      "Expensive video encodes serialize by default",
      "partial verified results remain reusable",
    ]) {
      expect(html).toContain(claim)
    }
  })

  test("keeps SDK, local host, and desktop capture inside one workflow system", async () => {
    const html = await readSource("index.html")

    expect(html).toContain(">TypeScript SDK<")
    expect(html).toContain(">Local host<")
    expect(html).toContain(">Desktop shell<")
    expect(html).toContain("without creating another workflow engine")
  })

  test("uses direct local Gateway access without a browser secret path", async () => {
    const html = await readSource("index.html")
    const theme = await readSource("theme.js")

    expect(html).toContain("AI_GATEWAY_API_KEY")
    expect(html).toContain("VERCEL_OIDC_TOKEN")
    expect(html).toContain('vercel env run -- atet image generate "…"')
    expect(html).toContain("no hosted account or browser generation service")
    expect(html).toContain("This site never receives")
    expect(html).not.toMatch(/<form|type="password"|\/api\//)
    expect(theme).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon/)
  })

  test("uses the solar-barque name as a restrained abstract metaphor", async () => {
    const html = await readSource("index.html")

    expect(html).toContain("Atet draws on Ra's solar barque as an abstract")
    expect(html).toContain("metaphor for passage and transformation")
    expect(html).not.toMatch(/hieroglyph|pharaoh|pyramid|ankh/i)
  })

  test("keeps the page semantic, keyboard-operable, and responsive", async () => {
    const html = await readSource("index.html")
    const css = await readSource("styles.css")

    expect(html.match(/<h1\b/gu)).toHaveLength(1)
    expect(html).toContain('<a class="skip-link" href="#main">')
    expect(html).toContain('<nav aria-label="Primary">')
    expect(html).toContain('<main id="main" tabindex="-1">')
    expect(html).toContain('<div aria-hidden="true" class="solar-field">')
    expect(html).not.toMatch(/<section(?![^>]*aria-labelledby)/)
    expect(css).toContain(":where(a, button, [tabindex]):focus-visible")
    expect(css).toContain("@media (max-width: 64rem)")
    expect(css).toContain("@media (max-width: 48rem)")
    expect(css).toContain("@media (max-width: 34rem)")
    expect(css).toContain("@media (prefers-reduced-motion: reduce)")
    expect(css).toContain("@media (forced-colors: active)")
  })

  test("ships original correctly sized social and icon assets", async () => {
    const social = new Uint8Array(await Bun.file(join(appDirectory, "src/og.png")).arrayBuffer())
    const apple = new Uint8Array(await Bun.file(join(appDirectory, "src/apple-touch-icon.png")).arrayBuffer())
    const icon = await readSource("icon.svg")
    const socialView = new DataView(social.buffer, social.byteOffset, social.byteLength)
    const appleView = new DataView(apple.buffer, apple.byteOffset, apple.byteLength)

    expect(Array.from(social.slice(1, 4))).toEqual([80, 78, 71])
    expect(socialView.getUint32(16)).toBe(1200)
    expect(socialView.getUint32(20)).toBe(630)
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
    expect(new TextEncoder().encode(html).byteLength).toBeLessThan(28_000)
    expect(new TextEncoder().encode(css).byteLength).toBeLessThan(30_000)
    expect(new TextEncoder().encode(theme).byteLength).toBeLessThan(3_000)
    expect(html).not.toMatch(/https:\/\/[^"']+\.(?:css|js)/)
    expect(html).not.toMatch(/analytics|posthog|plausible|segment/i)
    expect(build).toContain('createHash("sha256")')
    expect(build).toContain('"{{CSS_ASSET}}": stylesPath')
    expect(build).toContain('"{{THEME_ASSET}}": themePath')
  })

  test("renders a closed static tree with resolved content-hashed assets", async () => {
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

  test("publishes only the canonical homepage to crawler discovery", async () => {
    const robots = await readSource("robots.txt")
    const sitemap = await readSource("sitemap.xml")
    const notFound = await readSource("404.html")
    const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map(match => match[1])

    expect(robots).toBe("User-agent: *\nAllow: /\n\nSitemap: https://atet.sh/sitemap.xml\n")
    expect(locations).toEqual(["https://atet.sh/"])
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
      { source: "/:path*", host: { type: "host", value: "transmute.rocks" }, destination: "https://atet.sh/:path*", permanent: true },
      { source: "/:path*", host: { type: "host", value: "hraness.graphics" }, destination: "https://atet.sh/:path*", permanent: true },
      { source: "/:path*", host: { type: "host", value: "hraness.studio" }, destination: "https://atet.sh/:path*", permanent: true },
      { source: "/:path*", host: { type: "host", value: "preview.transmute.rocks" }, destination: "https://preview.atet.sh/:path*", permanent: true },
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
    expect(html).toContain("Atet 1.0.0 · MIT · Local-first visual media.")
  })
})
