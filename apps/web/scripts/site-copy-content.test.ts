import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { homeMarkdown, llmsTxt, sitemapMarkdown } from "../src/agent-pages"
import { publishedArchiveUrl, sourceInstall } from "../src/published-release"
import { renderSlopcameraIcons } from "./generate-icons"

const read = (path: string) => readFile(new URL(`../../../${path}`, import.meta.url), "utf8")
const compact = (value: string) => value.replace(/\*\*|`/gu, "").replace(/\s+/gu, " ")
const definition = "Slopcamera is a local visual studio for coding agents. Author scenes, combine generated and recorded media, and export images, diagrams, animation, and video from retained sources."
const docs = "https://github.com/hraness/slopcamera/blob/main/docs/README.md"

describe("visual studio public copy (pure, process-free)", () => {
  test("the source install is complete in the guide and never renames historical archive bytes", async () => {
    const [readme, guide, html] = await Promise.all([
      read("README.md"), read("docs/how-to/use-current-source.md"), read("apps/web/src/index.html"),
    ])
    const steps = [sourceInstall.checkoutCommand, "git rev-parse HEAD", "bun install --frozen-lockfile --ignore-scripts", "bun run build:sdk", "bun run build:desktop:cli", "export SLOPCAMERA_SOURCE_ROOT", 'slopcamera() { bun "$SLOPCAMERA_SOURCE_ROOT/apps/desktop/dist/cli/main.js" "$@"; }', "slopcamera doctor --json"]
    for (const source of [readme, guide]) {
      const positions = steps.map(step => source.indexOf(step))
      expect(positions.every(position => position >= 0)).toBe(true)
      expect(positions).toEqual([...positions].sort((a, b) => a - b))
    }
    expect(readme).toContain("Historical Atet release evidence")
    expect(publishedArchiveUrl).toBe("https://github.com/hraness/slopcamera/releases/download/v3.2.6/hraness-slopcamera-3.2.6.tgz")
    expect(html).toContain("{{ARCHIVE_INSTALL_COMMAND}}")
    const graph = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/u)![1]!)["@graph"] as Record<string, unknown>[]
    for (const item of graph) {
      expect(item).not.toHaveProperty("softwareVersion")
      expect(item).not.toHaveProperty("version")
      expect(item).not.toHaveProperty("offers")
    }
  })

  test("the original camera mark produces the exact desktop and web icon derivatives", async () => {
    const icon = await renderSlopcameraIcons()
    const [desktop, apple, manifest, provenance] = await Promise.all([
      readFile(new URL("../../desktop/assets/icon.png", import.meta.url)),
      readFile(new URL("../src/apple-touch-icon.png", import.meta.url)),
      read("apps/desktop/assets/brand-emoji/manifest.json"),
      read("apps/desktop/assets/brand-provenance.json"),
    ])
    expect(icon.desktop).toEqual(new Uint8Array(desktop))
    expect(icon.apple).toEqual(new Uint8Array(apple))
    expect(JSON.parse(manifest).assets[0]).toMatchObject({ domain: "slopcamera.com", emoji: "📷", codePointID: "1f4f7", sha256: icon.sourceSha256 })
    expect(JSON.parse(provenance).source.sha256).toBe(icon.sourceSha256)
    for (const output of JSON.parse(provenance).outputs as { path: string; bytes: number; sha256: string }[]) {
      const bytes = output.path === "icon.png" ? desktop : apple
      expect(bytes.byteLength).toBe(output.bytes)
      expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(output.sha256)
    }
  })

  test("the README, visible homepage, metadata, and agent indexes agree on the durable product", async () => {
    const [readme, html] = await Promise.all([read("README.md"), read("apps/web/src/index.html")])
    for (const source of [readme, html, homeMarkdown, llmsTxt]) expect(compact(source)).toContain(definition)
    for (const kind of ["description", "og:description", "twitter:description"]) {
      expect(html).toContain(`${kind}" content="${definition}"`)
    }
    const graph = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/u)![1]!)
    for (const item of graph["@graph"].filter((value: { description?: unknown }) => value.description !== undefined)) {
      expect(item.description).toBe(definition)
    }
  })

  test("first value includes the source-built starter and names its real five derived outputs", async () => {
    const [readme, html, cli, artifacts] = await Promise.all([
      read("README.md"), read("apps/web/src/index.html"), read("src/cli.ts"), read("src/artifacts.ts"),
    ])
    expect(cli).toContain('name: "example-flow"')
    expect(artifacts).toContain('`${spec.name}.tldr`')
    const commands = ["slopcamera diagram init first.diagram.json", "slopcamera diagram check first.diagram.json --strict", "slopcamera diagram render first.diagram.json"]
    for (const source of [readme, html, homeMarkdown]) {
      const positions = commands.map(command => source.indexOf(command))
      expect(positions.every(position => position >= 0)).toBe(true)
      expect(positions).toEqual([...positions].sort((a, b) => a - b))
      expect(source).not.toContain("--input job.json")
      expect(source).toContain("docs/tutorials/first-diagram.md")
    }
    for (const suffix of ["tldr", "light.svg", "dark.svg", "light.png", "dark.png"]) {
      for (const source of [readme, homeMarkdown]) expect(source).toContain(`example-flow.${suffix}`)
    }
    expect(readme).toContain(publishedArchiveUrl)
    expect(homeMarkdown).toContain(publishedArchiveUrl)
    expect(homeMarkdown).toContain(sourceInstall.guideUrl)
    expect(readme).toContain(sourceInstall.checkoutCommand)
  })

  test("release, native trust, and MCP scope remain adjacent to the expanded creation story", async () => {
    const [html, readme, operations] = await Promise.all([read("apps/web/src/index.html"), read("README.md"), read("src/operations.ts")])
    for (const source of [html, readme, homeMarkdown, llmsTxt]) {
      const text = compact(source)
      expect(text).toContain("current user")
      expect(text).toContain("main")
      expect(text).toContain("studio")
      expect(text).toContain("camera-track")
      expect(text).toMatch(/(?:MCP.*(?:subset|toolset)|(?:subset|toolset).*MCP)/u)
      expect(text).not.toContain("Each one reaches the same project and the same operations")
      expect(text).not.toContain("Only model-backed work may upload")
    }
    const codes = operations.match(/export const slopcameraOperationCodes = \[([\s\S]*?)\] as const/u)![1]!
    expect([...codes.matchAll(/"([^"]+)"/gu)].map(match => match[1])).toEqual([
      "slopcamera.diagram.check", "slopcamera.diagram.render", "slopcamera.image.vectorize", "slopcamera.image.generate",
    ])
    expect(html).toContain("It does not expose every CLI command.")
    expect(readme).toContain("Seven editable")
    expect(html).toContain("qualified Three.js GPU profile")
  })

  test("documentation discovery reaches the canonical index without inventing a hosted manual", async () => {
    const [html, config] = await Promise.all([read("apps/web/src/index.html"), read("apps/web/vercel.json")])
    expect(html).toContain('href="/docs">Docs</a>')
    for (const source of [homeMarkdown, llmsTxt, sitemapMarkdown]) expect(source).toContain(docs)
    const routes = JSON.parse(config).redirects.filter((route: { has?: unknown }) => route.has === undefined)
    expect(routes).toEqual([
      { source: "/docs", destination: docs, permanent: true },
      { source: "/docs/:path*", destination: docs, permanent: true },
    ])
    const links = [...html.matchAll(/href="(https:\/\/github.com\/hraness\/slopcamera\/blob\/main\/docs\/[^"#]+)(?:#[^"]*)?"/gu)]
    expect(links.length).toBeGreaterThan(5)
    const allowed = new Set(["README.md", "tutorials/first-diagram.md", "tutorials/first-native-film.md", "spatial-scenes.md", "studio.md", "directing-video.md", "how-to/edit-video.md", "how-to/generate-media.md", "how-to/educational-video.md", "how-to/run-workflows.md", "reference/capabilities.md", "architecture.md", "how-to/use-current-source.md"])
    for (const [, link] of links) expect(allowed.has(link!.split("/docs/")[1]!)).toBe(true)
    expect(html).not.toMatch(/<video\b|autoplay|<iframe\b/u)
  })
})
