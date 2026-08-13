import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const appDirectory = dirname(fileURLToPath(import.meta.url))

async function readSource(path: string): Promise<string> {
  return await readFile(join(appDirectory, "src", path), "utf8")
}

describe("static Transmute site", () => {
  test("states the four output families in order", async () => {
    const html = await readSource("index.html")
    const families = [">Images<", ">Diagrams<", ">Animated loops<", ">Video<"]
    const positions = families.map(family => html.indexOf(family))

    expect(positions.every(position => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
  })

  test("documents the shared project, cache, preview, and candidate contracts", async () => {
    const html = await readSource("index.html")

    for (const claim of [
      "immutable graph",
      "same identity can be adopted",
      "Parallel iteration",
      "promotion fails closed",
      "complete duration",
      "serializes expensive video encodes",
      "desktop shell adds native capture",
    ]) {
      expect(html).toContain(claim)
    }
  })

  test("uses direct local Vercel Gateway credentials without a browser secret path", async () => {
    const html = await readSource("index.html")
    const theme = await readSource("theme.js")

    expect(html).toContain("AI_GATEWAY_API_KEY")
    expect(html).toContain("VERCEL_OIDC_TOKEN")
    expect(html).toContain("vercel env run -- bun run render.ts")
    expect(html).toContain("no hosted account or browser generation service")
    expect(html).not.toMatch(/<form|type="password"|\/api\//)
    expect(theme).not.toMatch(/fetch\(|XMLHttpRequest|WebSocket|EventSource/)
  })

  test("has the Hraness footer and no retired editorial surface", async () => {
    const html = await readSource("index.html")

    expect(html).toContain('href="https://hraness.com"')
    expect(html).toContain('aria-label="hraness"')
    expect(html).not.toMatch(/cclrte|content machine|href="\/research|Visual diagramming/i)
  })

  test("is dependency-free and keeps a small transfer surface", async () => {
    const html = await readSource("index.html")
    const css = await readSource("styles.css")
    const theme = await readSource("theme.js")
    const manifest = JSON.parse(
      await readFile(join(appDirectory, "package.json"), "utf8"),
    ) as Record<string, unknown>

    expect(manifest.dependencies).toBeUndefined()
    expect(manifest.devDependencies).toBeUndefined()
    expect(new TextEncoder().encode(html).byteLength).toBeLessThan(24_000)
    expect(new TextEncoder().encode(css).byteLength).toBeLessThan(16_000)
    expect(new TextEncoder().encode(theme).byteLength).toBeLessThan(3_000)
    expect(html).not.toMatch(/https:\/\/[^"']+\.(?:css|js)/)
  })

  test("publishes only the homepage to crawler discovery", async () => {
    const sitemap = await readSource("sitemap.xml")
    const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)]
      .map(match => match[1])

    expect(locations).toEqual(["https://transmute.rocks/"])
  })
})
