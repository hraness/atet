import { describe, expect, test } from "bun:test"
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createStylexTransformCollector } from "@hraness/ui/stylex-build"
import { snapshotLanternMaterial } from "./lantern-material"

const app = fileURLToPath(new URL("../", import.meta.url))
const vendor = join(app, "vendor/lantern-material")
const read = (path: string) => readFile(join(app, path), "utf8")

describe("Lantern material admission and scope", () => {
  test("admits only the complete released finite inventory and rejects changed ownership or bytes", async () => {
    const admitted = await snapshotLanternMaterial(vendor)
    expect(admitted.sourceCommit).toBe("eccb0341d8d0ba960a0f02248cf59888062afb0a")
    expect([...admitted.files.keys()].sort()).toEqual(["LICENSE", "check.d.mts", "check.mjs", "lantern-material.css"])
    const root = await realpath(await mkdtemp(join(tmpdir(), "slopcamera-lantern-")))
    try {
      const copy = join(root, "snapshot")
      await cp(vendor, copy, { recursive: true })
      const original = await readFile(join(copy, "lantern-material.css"))
      // Any byte change in the CSS must fail exact admission, even valid inert CSS.
      for (const suffix of ["\n", "/* local override */", "\nhtml{color:red}"]) {
        await writeFile(join(copy, "lantern-material.css"), Buffer.concat([original, Buffer.from(suffix)]))
        await expect(snapshotLanternMaterial(copy)).rejects.toThrow("differs")
      }
      await writeFile(join(copy, "lantern-material.css"), original)
      await writeFile(join(copy, "extra.css"), "")
      await expect(snapshotLanternMaterial(copy)).rejects.toThrow("unowned")
      await rm(join(copy, "extra.css"))
      const manifest = JSON.parse(await readFile(join(copy, "provenance.json"), "utf8"))
      manifest.source.commit = "a".repeat(40)
      await writeFile(join(copy, "provenance.json"), JSON.stringify(manifest))
      await expect(snapshotLanternMaterial(copy)).rejects.toThrow()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  test("changes homepage paint without changing the preview or recovery material scope", async () => {
    const [home, missing, preview, foundation, build, css] = await Promise.all([
      read("src/index.html"), read("src/404.html"), read("src/preview.html"),
      read("src/site-foundation.css"), read("scripts/build-site.ts"), read("src/styles.css"),
    ])
    expect(home.match(/data-hraness-material="lantern"/gu)).toHaveLength(1)
    expect(home).toContain('class="topbar hraness-material-chrome {{SITE_HEADER_CLASS}}"')
    expect(home.match(/hraness-material-wall/gu)).toHaveLength(1)
    expect(home).toContain('class="hraness-marketing-hero slopcamera-product-hero hraness-material-wall"')
    expect(home).toContain('class="hraness-marketing-proof-frame hraness-material-pane"')
    expect(home).not.toContain('class="hraness-marketing-field"')
    for (const other of [missing, preview]) expect(other).not.toMatch(/data-hraness-material|hraness-material-/u)
    expect(await read("src/preview-foundation.css")).not.toContain("lantern-material")
    expect(foundation.indexOf('vendor/lantern-material/lantern-material.css')).toBeGreaterThan(foundation.indexOf('vendor/marketing-preset/product-marketing-preset.css'))
    expect(build).toContain('...materialPaths.map(path => join(materialRoot, path))')
    expect(build).toContain('materialSourceCommit: material.sourceCommit')
    expect(build).toContain('path: "lantern-material/LICENSE"')
    expect(css).toContain('background-size: auto, auto, auto, auto;')
    expect(css).toContain('min-block-size: 3.25rem;\n  padding-block: 1rem;')
    expect(css).toContain('outline-offset: 2px;')
    expect(css).toContain('background-color: var(--hraness-material-warm-plane);\n  color: var(--hraness-material-ink);')
    expect(css).toContain('background-color: Highlight;\n    color: HighlightText;')
  })

  test("compiled header uses shared paint tokens with exact previous no-material fallbacks", async () => {
    const source = await read("src/site-shell.stylex.ts")
    const compiled = await createStylexTransformCollector(app).transform(source, join(app, "src/site-shell.stylex.ts"))
    const slots = [...compiled.code.matchAll(/\bheader: \{\s*className: "([^"]+)"\s*\}\.className/gu)]
    expect(slots).toHaveLength(1)
    const classes = new Set(slots[0]![1]!.split(" "))
    const rules = compiled.rules.filter(([name]) => classes.has(name)).map(([name, rule]) => rule.ltr.replaceAll(`.${name}`, ".header"))
    expect(rules).toContain('.header{border-bottom-color:var(--hraness-material-seam,var(--line))}')
    expect(rules).toContain('.header{background-color:var(--hraness-material-chrome-paint,color-mix(in srgb,var(--paper) 84%,transparent))}')
    expect(rules.some(rule => rule.includes('backdrop-filter:var(--hraness-material-chrome-blur,blur(14px) saturate(1.4))'))).toBe(true)
    expect(rules).toContain('.header{position:sticky}')
    expect(rules).toContain('.header{min-height:3.5rem}')
    expect(rules.join("\n")).not.toContain('!important')
  })
})
