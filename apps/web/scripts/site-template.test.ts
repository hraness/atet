import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { createStylexTransformCollector, type StylexTransformResult } from "@hraness/ui/stylex-build"
import { assertCompiledSiteClass, replaceSiteSlot } from "../src/site-template"

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8")

function assertPrimaryActionColors(compiled: StylexTransformResult): void {
  for (const slot of ["navigationAction", "recoveryAction"]) {
    // Bind the rules to each emitted action, not unrelated package or shell CSS.
    const matches = [...compiled.code.matchAll(new RegExp(`\\b${slot}: \\{\\s*className: "([^"]+)"\\s*\\}\\.className`, "gu"))]
    expect(matches).toHaveLength(1)
    const classes = new Set(matches[0]![1]!.split(" "))
    const rules = compiled.rules.filter(([name]) => classes.has(name)).map(([name, value]) => {
      expect(value.rtl).toBeNull()
      return value.ltr.replaceAll(`.${name}`, ".action")
    })
    const accent = "var(--hraness-marketing-accent)"
    const hover = `color-mix(in oklch,${accent} 84%,black)`
    expect(rules.filter(rule => /\bborder(?:-(?:top|right|bottom|left))?-color:/u.test(rule)).sort()).toEqual([
      `.action:hover{border-color:${hover}}`, `.action{border-color:${accent}}`,
    ].sort())
    expect(rules).toContain(".action{border-width:1px}")
    expect(rules).toContain(".action{border-style:solid}")
    expect(rules.filter(rule => /\bbackground-color:/u.test(rule)).sort()).toEqual([
      `.action:hover{background-color:${hover}}`, `.action{background-color:${accent}}`,
      "@media (forced-colors: active){.action.action{background-color:CanvasText}}",
      `@media (forced-colors: active){.action.action:hover{background-color:${hover}}}`,
    ].sort())
    const backgrounds = compiled.rules.filter(([name, value]) => classes.has(name) && /\bbackground-color:/u.test(value.ltr))
    for (const forced of [false, true]) {
      for (const hovered of [false, true]) {
        // These exact four selectors have no focus/active condition, so the
        // same background precedence also holds while focused or pressed.
        const applicable = backgrounds.filter(([, value]) => (forced || !value.ltr.startsWith("@media"))
          && (hovered || !value.ltr.includes(":hover"))).sort((left, right) => right[2] - left[2])
        expect(applicable[0]![1].ltr.match(/background-color:([^}]+)/u)?.[1])
          .toBe(hovered ? hover : forced ? "CanvasText" : accent)
      }
    }
    expect(rules.join("\n")).not.toMatch(/forced-color-adjust:/u)
  }
}

describe("ordinary shell authored contract (pure, process-free)", () => {
  test("compiled home and recovery actions preserve native forced border adjustment and ordinary/hover colors", async () => {
    const path = fileURLToPath(new URL("../src/site-shell.stylex.ts", import.meta.url))
    const root = fileURLToPath(new URL("../", import.meta.url))
    const source = await read("src/site-shell.stylex.ts")
    const compile = (value: string) => createStylexTransformCollector(root).transform(value, path)
    assertPrimaryActionColors(await compile(source))

    // In-memory mutations prove the check rejects the native regression and
    // loss of the retained states without rebuilding or changing any file.
    const border = `borderColor: {\n      default: "var(--hraness-marketing-accent)",\n      ":hover": "color-mix(in oklch, var(--hraness-marketing-accent) 84%, black)",\n    }`
    const forcedBackground = `[forcedColors]: {\n        default: "CanvasText",\n        ":hover": "color-mix(in oklch, var(--hraness-marketing-accent) 84%, black)",\n      },`
    expect(source.split(border)).toHaveLength(2)
    expect(source.split(forcedBackground)).toHaveLength(2)
    const mutations = [
      source.replace(border, border.replace("borderColor: {", 'borderColor: {\n      [forcedColors]: "CanvasText",')),
      source.replace(border, border.replace('      default: "var(--hraness-marketing-accent)",\n', "")),
      source.replace(border, border.replace('      ":hover": "color-mix(in oklch, var(--hraness-marketing-accent) 84%, black)",\n', "")),
      source.replace(forcedBackground, ""),
      source.replace(forcedBackground, '[forcedColors]: "CanvasText",'),
      source.replace(forcedBackground, forcedBackground.replace('        default: "CanvasText",\n', "")),
      source.replace("  primaryAction: {", '  primaryAction: {\n    forcedColorAdjust: "none",'),
    ]
    for (const mutation of mutations) {
      expect(mutation).not.toBe(source)
      const compiled = await compile(mutation)
      expect(() => assertPrimaryActionColors(compiled)).toThrow()
    }
  })

  test("replaces only the exact counted slot and preserves literal replacement bytes", () => {
    expect(replaceSiteSlot("a {{SITE_SLOT}} b {{SITE_SLOT}}", "{{SITE_SLOT}}", "$& literal", 2))
      .toBe("a $& literal b $& literal")
    for (const count of [0, -1, 1, 3, NaN, Infinity, 1.5]) {
      expect(() => replaceSiteSlot("{{SITE_SLOT}} {{SITE_SLOT}}", "{{SITE_SLOT}}", "value", count)).toThrow()
    }
    for (const placeholder of ["", "SITE_SLOT", "{{site_slot}}", "{{SITE-SLOT}}", "{{SITE_SLOT}}\n"]) {
      expect(() => replaceSiteSlot(placeholder, placeholder, "value", 1)).toThrow()
    }
  })

  test("compiled classes are finite attribute-safe names, never inline presentation", () => {
    for (const value of ["x1", "x1 x2", "xvalid_name xdash-name"]) {
      expect(() => assertCompiledSiteClass(value, "{{SITE_SLOT}}" )).not.toThrow()
    }
    for (const value of [null, undefined, 1, {}, [], "", " x1", "x1 ", "x1\nx2", "x1\tx2", "x1  x2", 'x1" style="color:red', "x1<", "1name"]) {
      expect(() => assertCompiledSiteClass(value, "{{SITE_SLOT}}" )).toThrow()
    }
  })

  test("authored slots retain the two semantic shells and their distinct phone navigation", async () => {
    const [home, missing, recipes, renderer, legacy] = await Promise.all([
      read("src/index.html"), read("src/404.html"), read("src/site-shell.stylex.ts"),
      read("src/site-renderer.ts"), read("src/styles.css"),
    ])
    for (const document of [home, missing]) {
      for (const slot of ["SKIP", "HEADER", "WORDMARK", "ACTIONS", "NAVIGATION"]) {
        expect(document.match(new RegExp(`\\{\\{SITE_${slot}_CLASS\\}\\}`, "gu"))).toHaveLength(1)
      }
      expect(document.match(/\{\{SITE_STYLES\}\}/gu)).toHaveLength(1)
      expect(document).toContain('href="#main">Skip to content</a>')
      expect(document).toContain('id="main" tabindex="-1"')
      expect(document.match(/\{\{APPEARANCE_MENU\}\}/gu)).toHaveLength(1)
      expect(document.match(/\{\{HRANESS_SITE_FOOTER\}\}/gu)).toHaveLength(1)
      expect(document).not.toMatch(/\sstyle\s*=|<style\b/iu)
    }
    expect(home.match(/\{\{SITE_HOME_NAVIGATION_LINK_CLASS\}\}/gu)).toHaveLength(4)
    expect(home.match(/\{\{SITE_NAVIGATION_ACTION_CLASS\}\}/gu)).toHaveLength(1)
    expect(missing.match(/\{\{SITE_NAVIGATION_LINK_CLASS\}\}/gu)).toHaveLength(2)
    expect(missing).not.toContain("{{SITE_HOME_NAVIGATION_LINK_CLASS}}")
    expect(missing.match(/\{\{SITE_RECOVERY_LINK_CLASS\}\}/gu)).toHaveLength(4)
    expect(missing.match(/\{\{SITE_RECOVERY_PARAGRAPH_CLASS\}\}/gu)).toHaveLength(2)
    expect(recipes).toContain('const tablet = "@media (max-width: 48rem)"')
    expect(recipes).toContain('const phone = "@media (max-width: 34rem)"')
    expect(recipes).toContain('display: { default: null, [phone]: "none" }')
    expect(recipes).toContain('stylex.props(shell.primaryAction, shell.navigationAction)')
    expect(recipes).toContain('stylex.props(shell.primaryAction, shell.recoveryAction)')
    expect(recipes).toContain('const coarsePointer = "@media (pointer: coarse)"')
    expect(recipes).toContain('[forcedColors]: {\n        default: "CanvasText",')
    expect(recipes).toContain('minHeight: { default: "var(--hraness-marketing-action-height)", [coarsePointer]: "3rem" }')
    expect(renderer).toContain('document === "index.html" ? homeSlots : recoverySlots')
    expect(legacy).not.toMatch(/\.skip-link|\.topbar|\.wordmark|\.route-state/u)
    expect(legacy).toContain(".hraness-marketing-page")
    expect(legacy).not.toContain(".copy-command")
  })

  test("the temporary Ask-AI compatibility cannot escape its existing row", async () => {
    const source = (await read("src/site-ask-ai-compatibility.css")).replace(/\/\*[\s\S]*?\*\//gu, "")
    const selectors = [...source.matchAll(/(?:^|\})\s*([^{}]+)\{/gu)].flatMap(match => match[1]!.split(",").map(value => value.trim()))
    expect(selectors.length).toBeGreaterThan(10)
    for (const selector of selectors) expect(selector).toMatch(/^\.slopcamera-ask-ai(?:$| \[data-slot="ask-ai-about-this-(?:label|links|link|icon)"\](?::(?:hover|active|focus-visible))?$)/u)
    expect(source).not.toMatch(/!important|@import|@font-face|url\(|all\s*:|\.x[A-Za-z0-9_-]+/u)
    for (const value of ["text-transform: none", "letter-spacing: normal", "font-family: inherit", "background-color: transparent", "transform: none", "outline-offset: 3px"]) {
      expect(source).toContain(value)
    }
    // The captured standalone-footer baseline already supplies these atoms.
    // Resetting them changes row wrapping and increases the label height.
    expect(source).not.toContain("line-height: inherit")
    expect(source).not.toContain("white-space:")
  })

  test("the complete ordinary graph remains separate from preview and package standalone CSS", async () => {
    const [foundation, ua, build, renderer] = await Promise.all([
      read("src/site-foundation.css"), read("src/site-ua-compatibility.css"),
      read("scripts/build-site.ts"), read("src/site-renderer.ts"),
    ])
    expect(foundation).toContain('@import "@hraness/design-kit/compiler-foundation.css" layer(base.hraness-foundation)')
    expect(foundation).toContain('@import "@hraness/site-footer/compiler-foundation.css"')
    expect(foundation).toContain('@import "./styles.css" layer(components.slopcamera-legacy)')
    expect(foundation).toContain('@import "./site-ask-ai-compatibility.css"')
    expect(foundation).not.toMatch(/hraness-stylex|(?:ui|design-kit|site-footer)\/stylex\.css|preview-foundation/u)
    expect(ua).not.toMatch(/all\s*:|!important/u)
    expect(build).toContain('const documents = ["404.html", "index.html"] as const')
    expect(build).toContain("packageManifests: packageInputs.map(item => item.path)")
    expect(build.indexOf("await sealStylexProducedTemplate(generation, document)"))
      .toBeLessThan(build.indexOf("await finalizeStylexGeneration("))
    expect(renderer).toContain("siteContentSlots(document, assets)")
    expect(build).not.toContain('replaceAll("__HRANESS_STYLEX_CSS__"')
  })

  test("retained appearance and footer presentation survive the layer migration", async () => {
    const [footer, foundation, ua, build] = await Promise.all([
      read("src/site-footer-compatibility.css"), read("src/site-foundation.css"),
      read("src/site-ua-compatibility.css"), read("scripts/build-site.ts"),
    ])
    const footerRules = footer.replace(/\/\*[\s\S]*?\*\//gu, "").trim()
    expect(footerRules).toMatch(/^\.hraness-site-footer__social-link\s*\{\s*color:\s*inherit;\s*\}$/u)
    expect(foundation).toContain('@import "./site-footer-compatibility.css"')
    expect(build).toContain('"src/site-footer-compatibility.css"')
    expect(ua).toContain(':where(button, select, input[type="button"], input[type="submit"], input[type="reset"]):not(.hraness-design-theme-toggle__trigger) {\n  touch-action: revert;')
    expect(ua).toContain('button:not(:disabled):not(.hraness-design-theme-toggle__trigger) {\n  cursor: revert;')
    expect(ua.match(/:not\(\.hraness-design-theme-toggle__trigger\)/gu)).toHaveLength(2)
  })
})
