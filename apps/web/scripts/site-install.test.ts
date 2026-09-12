import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { createStylexTransformCollector, type StylexTransformResult } from "@hraness/ui/stylex-build"
import { siteContentSlots } from "../src/site-content"
import { assertCompiledSiteClass, replaceSiteSlot } from "../src/site-template"

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8")
const root = fileURLToPath(new URL("../", import.meta.url))
const path = fileURLToPath(new URL("../src/site-install.stylex.ts", import.meta.url))
const compile = (source: string) => createStylexTransformCollector(root).transform(source, path)
const compact = (value: string) => value.replace(/\s+/gu, "")

function classesFor(compiled: StylexTransformResult, slot: string): string {
  const matches = [...compiled.code.matchAll(new RegExp(`\\b${slot}: \\{\\s*className: "([^"]+)"\\s*\\}\\.className`, "gu"))]
  expect(matches).toHaveLength(1)
  const classes = matches[0]?.[1]
  assertCompiledSiteClass(classes, slot)
  return classes
}
function rulesFor(compiled: StylexTransformResult, slot: string): string[] {
  const classes = new Set(classesFor(compiled, slot).split(" "))
  return compiled.rules.filter(([name]) => classes.has(name)).map(([name, rule]) => {
    expect(rule.rtl).toBeNull()
    return compact(rule.ltr.replaceAll(`.${name}`, ".slot"))
  })
}
function required(compiled: StylexTransformResult, slot: string, rule: string): void {
  expect(rulesFor(compiled, slot)).toContain(compact(rule))
}
function borderColorAt(compiled: StylexTransformResult, slot: string, side: string, phone: boolean, forced: boolean): string | undefined {
  const classes = new Set(classesFor(compiled, slot).split(" "))
  const applicable = compiled.rules.filter(([name, rule]) => classes.has(name)
    && rule.ltr.includes(`border-${side}-color:`)
    && [...rule.ltr.matchAll(/@media ([^{}]+)\{/gu)].every(([, query]) => {
      // Exact StyleX 0.19 output grammar for these two finite axes. The
      // compiler excludes forced colors from the competing phone rule.
      switch (compact(query ?? "")) {
        case "(max-width:34rem)": return phone
        case "(forced-colors:active)": return forced
        case "(max-width:34rem)and(not(forced-colors:active))": return phone && !forced
        default: throw new Error("Unreviewed install border condition")
      }
    }))
    .map(([name, rule, priority]) => ({ value: rule.ltr.match(new RegExp(`border-${side}-color:([^}]+)`))?.[1],
      priority, specificity: rule.ltr.split(`.${name}`).length - 1 }))
    .sort((a, b) => b.specificity - a.specificity || b.priority - a.priority)
  return applicable[0]?.value
}
function assertCopyContract(compiled: StylexTransformResult): void {
  const hover = "color-mix(in srgb,var(--gold-bright) 14%,transparent)"
  for (const [slot, normal, hovered, background] of [
    ["idle", "var(--night-muted)", "var(--night-ink)", "transparent"],
    ["copied", "var(--night-ink)", "var(--night-ink)", hover],
    ["failed", "var(--gold-bright)", "var(--gold-bright)", "transparent"],
  ] as const) {
    // Only rules actually attached to this finite state count, never an
    // unrelated state, package rule or a duplicate semantic hook selector.
    const rules = rulesFor(compiled, slot)
    expect(rules.filter(rule => /\{color:/u.test(rule)).sort()).toEqual([
      compact(`.slot{color:${normal}}`), compact(`.slot:hover{color:${hovered}}`),
    ].sort())
    expect(rules.filter(rule => /\{background-color:/u.test(rule)).sort()).toEqual([
      compact(`.slot{background-color:${background}}`), compact(`.slot:hover{background-color:${hover}}`),
    ].sort())
    expect(rules.filter(rule => /\{background-position:/u.test(rule)).sort()).toEqual([
      `.slot{background-position:${slot === "copied" ? "initial" : "0 0"}}`, ".slot:hover{background-position:initial}",
    ].map(compact).sort())
    for (const declaration of ["min-width:4.4rem", "min-height:2.75rem", "font-size:.8rem", "font-weight:500", "cursor:pointer", "border-image-source:none", "background-image:none"]) {
      required(compiled, slot, `.slot{${declaration}}`)
    }
    required(compiled, slot, ".slot{border-left-width:1px}")
    required(compiled, slot, ".slot{border-top-width:0}")
    required(compiled, slot, "@media (max-width: 34rem){.slot.slot{border-left-width:0}}")
    required(compiled, slot, "@media (max-width: 34rem){.slot.slot{border-top-width:1px}}")
    for (const side of ["top", "right", "bottom", "left"]) {
      required(compiled, slot, `@media (forced-colors: active){.slot.slot{border-${side}-color:CanvasText}}`)
    }
    // Border shorthands also reset the currently invisible sides' colors.
    // Bind the actual compiler specificity/priority through both media axes.
    for (const phone of [false, true]) for (const forced of [false, true]) {
      expect(borderColorAt(compiled, slot, "top", phone, forced)).toBe(forced ? "CanvasText" : phone ? "var(--night-line)" : "currentColor")
      expect(borderColorAt(compiled, slot, "left", phone, forced)).toBe(forced ? "CanvasText" : phone ? "currentColor" : "var(--night-line)")
    }
    expect(rules.join("\n")).not.toMatch(/outline|appearance:|forced-color-adjust|\[data-|\.copy-command/u)
  }
  for (const slot of ["command", "commands"]) {
    required(compiled, slot, ".slot{border-width:1px}")
    required(compiled, slot, ".slot{border-style:solid}")
    required(compiled, slot, "@media (forced-colors: active){.slot.slot{border-color:CanvasText}}")
    required(compiled, slot, ".slot{background-color:var(--night)}")
  }
  required(compiled, "command", ".slot{grid-template-columns:minmax(0,1fr) auto}")
  required(compiled, "command", "@media (max-width: 34rem){.slot.slot{grid-template-columns:minmax(0,1fr)}}")
  for (const declaration of ["position:fixed", "top:0", "right:auto", "bottom:auto", "left:-9999px", "opacity:0"]) required(compiled, "fallback", `.slot{${declaration}}`)
  for (const declaration of ["position:absolute", "width:1px", "height:1px", "overflow:hidden", "clip-path:inset(50%)", "white-space:nowrap"]) required(compiled, "status", `.slot{${declaration}}`)
  required(compiled, "value", ".slot{overflow-x:auto}")
  required(compiled, "value", ".slot{white-space:nowrap}")
  required(compiled, "panelLink", ".slot{color:var(--gold)}")
  required(compiled, "panelNote", ".slot{margin-top:1rem}")
  required(compiled, "number", ".slot{font:.75rem/1.7 var(--font-mono)}")
  for (const slot of ["value", "noteCode", "installCode"]) required(compiled, slot, ".slot{background-position:0 0}")
}

describe("install/copy compiled ownership (pure, process-free)", () => {
  test("binds idle, copied, failed, responsive, forced and offscreen presentation to exact emitted state classes", async () => {
    assertCopyContract(await compile(await read("src/site-install.stylex.ts")))
  })

  test("rejects failed-hover, copied, phone, forced-color, fallback and focus-reset mutations", async () => {
    const source = await read("src/site-install.stylex.ts")
    const mutations = [
      source.replace('failed: { color: { default: "var(--gold-bright)", ":hover": "var(--gold-bright)" } }', 'failed: { color: { default: "var(--gold-bright)", ":hover": "var(--night-ink)" } }'),
      source.replace('stylex.props(install.button, install.copied)', 'stylex.props(install.button)'),
      source.replace('borderLeftWidth: { default: "1px", [phone]: 0 }', 'borderLeftWidth: "1px"'),
      source.replace('default: "currentColor", [phone]: "var(--night-line)"', 'default: "var(--night-line)", [phone]: "var(--night-line)"'),
      source.replaceAll('[forcedColors]: "CanvasText"', '[forcedColors]: "var(--night-line)"'),
      source.replace('left: "-9999px"', 'left: 0'),
      source.replace('opacity: 0', 'opacity: 1'),
      source.replace('font: "0.75rem/1.7 var(--font-mono)"', 'font: "inherit"'),
      source.replace('  button: {', '  button: { outline: "none",'),
      source.replace('  button: {', '  button: { forcedColorAdjust: "none",'),
      source.replace('backgroundPosition: "0px 0px"', 'backgroundPosition: "initial"'),
      source.replace('backgroundPosition: { default: "0px 0px", ":hover": "initial" }', 'backgroundPosition: "initial"'),
      source.replace('backgroundPosition: { default: "initial", ":hover": "initial" }', 'backgroundPosition: { default: "0px 0px", ":hover": "initial" }'),
    ]
    for (const mutation of mutations) {
      expect(mutation).not.toBe(source)
      const compiled = await compile(mutation)
      expect(() => assertCopyContract(compiled)).toThrow()
    }
  })

  test("every install class slot is counted, attribute safe and supplied only by the captured SSR recipe", async () => {
    const [home, renderer, source, build, client] = await Promise.all([
      read("src/index.html"), read("src/site-renderer.ts"), read("src/site-install.stylex.ts"), read("scripts/build-site.ts"), read("src/copy-command.ts"),
    ])
    const compiled = await compile(source)
    let html = home
    for (const [placeholder, value, count] of siteContentSlots("index.html", { themePath: "/assets/theme-0123456789ab.js", analyticsPath: null })) {
      html = replaceSiteSlot(html, placeholder, value, count)
    }
    const slots = [...renderer.matchAll(/\["(\{\{INSTALL_[A-Z_]+\}\})", siteInstallClassNames\.(\w+), (\d+)\]/gu)]
    expect(slots).toHaveLength(19)
    for (const match of slots) {
      const placeholder = match[1]; const slot = match[2]; const count = Number(match[3])
      if (!placeholder || !slot) throw new Error("Missing counted slot")
      const classes = classesFor(compiled, slot)
      expect(() => replaceSiteSlot(html, placeholder, classes, count + 1)).toThrow()
      html = replaceSiteSlot(html, placeholder, classes, count)
    }
    expect(html).not.toContain("{{INSTALL_")
    expect(html).not.toMatch(/<style\b|\sstyle\s*=/iu)
    const idle = classesFor(compiled, "idle")
    expect(html).toContain(`class="copy-command__button ${idle}"`)
    expect(html).toContain(`data-copy-idle-class="copy-command__button ${idle}"`)
    for (const state of ["copied", "failed"]) expect(html).toContain(`data-copy-${state}-class="copy-command__button ${classesFor(compiled, state)}"`)
    expect(html).toContain('data-copy-command-button hidden type="button">Copy</button>')
    expect(html).toContain('aria-describedby="skill-install-copy-status"')
    expect(html).toContain('aria-atomic="true" aria-live="polite"')
    expect(html).toContain(`<template data-copy-command-fallback><textarea class="${classesFor(compiled, "fallback")}" readonly></textarea></template>`)
    expect(build).toContain('"src/site-install.stylex.ts"')
    expect(renderer).toContain('import { siteInstallClassNames } from "./site-install.stylex"')
    expect(client).not.toMatch(/stylex|\.style\b|setAttribute\(["']style|createElement\(["']style|fetch\(|XMLHttpRequest|WebSocket/u)
    expect(Buffer.byteLength(client)).toBeLessThan(4000)
  })

  test("removes only local ownership from legacy CSS and retains global native focus and marketing boundaries", async () => {
    const css = await read("src/styles.css")
    // Only the reviewed editorial heading layout and archive-text wrapping stay
    // in marketing CSS. The compiled install/copy recipes retain every other rule.
    const editorialInstall = `[data-hraness-marketing-preset="editorial"] .hraness-marketing-install__heading-group {
  grid-template-columns: minmax(0, 1fr);
}

[data-hraness-marketing-preset="editorial"] .hraness-marketing-install__heading-group > .install-note {
  overflow-wrap: anywhere;
}`
    expect(css.split(editorialInstall)).toHaveLength(2)
    expect(css.replace(editorialInstall, "")).not.toMatch(/\.copy-command|\.cli-install|\.install-commands|\.panel-label|\.install-note|\.panel-note/u)
    expect(css).toContain(".quiet-note,\n.trust-links")
    expect(css).toContain(":where(.trust-links, .origin-note, .hraness-marketing-question__answer, .hraness-marketing-maker__links) a")
    expect(css).toContain("outline: 2px solid var(--focus)")
    expect(css).toContain("outline-offset: 3px")
    expect(css).toContain(".hraness-marketing-page")
    expect(css).toContain(".transcript")
  })
})
