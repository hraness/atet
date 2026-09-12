import assert from "node:assert/strict"
import type { Page } from "playwright-core"
import { compareShellElements, measure, resolvedShellTheme, settle, type ShellCase, type ShellElement } from "./site-shell-browser-contract"

/** Reviewed eccb0341 material formulas resolved independently of the target's
 * classes, variables or stylesheets. Palette values are the pinned Paper CSS. */
export interface LanternPaint { readonly wall: Readonly<Record<string, string>>; readonly pane: Readonly<Record<string, string>>;
  readonly chrome: Readonly<Record<string, string>>; readonly warm: Readonly<Record<string, string>> }
export const lanternPaintOwners = {
  ".topbar[0]": ["background-color", "border-bottom-color", "backdrop-filter", "box-shadow"],
  ".hraness-marketing-hero[0]": ["background-color", "background-image", "background-position", "background-size", "background-repeat", "background-attachment", "background-origin", "background-clip"],
  ".hraness-marketing-proof-frame[0]": ["background-color", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "border-radius"],
} as const
/**
 * Chromium serializes near-neutral white color-mix stops with tiny floating
 * point differences depending on whether the declaration came from a
 * stylesheet or a detached reference element. Keep the wall comparison
 * structural and strict while collapsing only that known neutral epsilon.
 */
export function normalizeLanternPaintValue(value: string): string {
  return value.replace(/oklch\(\s*([+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?)\s+([+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?)\s+none\s*\/\s*([^\)]+)\)/giu,
    (token, lightness: string, chroma: string, alpha: string) => {
      const l = Number(lightness), c = Number(chroma)
      if (!Number.isFinite(l) || !Number.isFinite(c) || Math.abs(c) > 1e-4) return token
      if (Math.abs(1 - l) <= 1e-4) return `oklch(1 0 none / ${alpha.trim()})`
      if (Math.abs(l) <= 1e-4) return `oklch(0 0 none / ${alpha.trim()})`
      return token
    })
}
export const normalizeLanternWallImage = normalizeLanternPaintValue
export async function lanternPaintReference(page: Page, scenario: ShellCase, reduced = false): Promise<LanternPaint> {
  return page.evaluate(({ dark, forced, reduced }) => {
    const ink = forced ? "CanvasText" : dark ? "#f5f2ed" : "#1c1917"
    const plane = forced ? "Canvas" : dark ? "#1d1a18" : "#fffefa"
    const paper = forced ? "Canvas" : dark ? "#12100f" : "#f8f7f4"
    const seam = forced ? "CanvasText" : `color-mix(in oklch, ${ink} 16%, ${plane})`
    const line = `color-mix(in oklch, ${ink} 9%, transparent)`
    const edge = "color-mix(in oklch, white 16%, transparent)"
    const grid = (angle: number) => `repeating-linear-gradient(${angle}deg, transparent 0, transparent 62px, ${line} 62px, ${edge} 63px, transparent 64px)`
    const wallImage = `${grid(90)}, ${grid(0)}, radial-gradient(ellipse at 60% 110%, color-mix(in oklch, #d49a54 32%, transparent), transparent 62%), linear-gradient(110deg, color-mix(in oklch, #8d9fc5 22%, transparent), transparent 28%, color-mix(in oklch, white 8%, transparent) 48%, transparent 70%, color-mix(in oklch, #8d9fc5 16%, transparent))`
    const sample = (declarations: Record<string, string>, properties: readonly string[]) => {
      const element = document.createElement("div")
      element.style.position = "fixed"; element.style.top = "-10000px"
      for (const [property, value] of Object.entries(declarations)) element.style.setProperty(property, value)
      document.documentElement.append(element)
      try { const style = getComputedStyle(element); return Object.fromEntries(properties.map(key => [key, style.getPropertyValue(key)])) }
      finally { element.remove() }
    }
    return {
      wall: sample({ "background-color": paper, "background-image": forced || reduced ? "none" : wallImage, "background-position": "center top", "background-size": "auto, auto, auto, auto", color: ink },
        ["background-color", "background-image", "background-position", "background-size", "background-repeat", "background-attachment", "background-origin", "background-clip", "color"]),
      pane: sample({ "background-color": plane, border: `1px solid ${seam}`, "border-radius": "14px", color: ink },
        ["background-color", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "border-radius", "color"]),
      chrome: sample({ "background-color": forced || reduced ? plane : `color-mix(in oklch, ${plane} 90%, transparent)`,
        "border-bottom": `1px solid ${seam}`, "backdrop-filter": forced || reduced ? "none" : "blur(20px) saturate(1.1)",
        "box-shadow": forced ? "none" : "inset 0 1px 0 color-mix(in oklch, white 28%, transparent), 0 4px 12px color-mix(in oklch, black 4%, transparent)" },
        ["background-color", "border-bottom-color", "backdrop-filter", "box-shadow"]),
      warm: sample({ "background-color": forced ? "Highlight" : `color-mix(in oklch, #d49a54 12%, ${plane})`, color: forced ? "HighlightText" : ink }, ["background-color", "color"]),
    }
  }, { dark: resolvedShellTheme(scenario.theme, scenario.system) === "dark", forced: scenario.forced === "active", reduced })
}
function expectedPaint(key: string, reference: LanternPaint): Readonly<Record<string, string>> | undefined {
  return key === ".topbar[0]" ? reference.chrome : key === ".hraness-marketing-hero[0]" ? reference.wall
    : key === ".hraness-marketing-proof-frame[0]" ? reference.pane : undefined
}
/** This projection changes only positively asserted paint. All geometry,
 * semantics, text, active focus and unlisted properties remain strict. */
export function projectLanternPaint(actual: readonly ShellElement[], baseline: readonly ShellElement[], reference: LanternPaint): ShellElement[] {
  assert.deepEqual(actual.map(item => item.key), baseline.map(item => item.key))
  return actual.map((item, index) => {
    const expected = expectedPaint(item.key, reference)
    if (expected === undefined) return item
    const styles = { ...item.styles }, old = baseline[index]!
    for (const property of lanternPaintOwners[item.key as keyof typeof lanternPaintOwners]) {
      const actualValue = normalizeLanternPaintValue(item.styles[property]!)
      const expectedValue = normalizeLanternPaintValue(expected[property]!)
      assert.equal(actualValue, expectedValue, `${item.key} exact Lantern ${property}`)
      assert.ok(Object.hasOwn(old.styles, property), `${item.key} baseline paint inventory`)
      styles[property] = old.styles[property]!
    }
    return { ...item, styles }
  })
}

/** A finite source migration, not general class stripping. The three header
 * atoms must contain exactly their reviewed declarations on both revisions. */
export async function lanternHeaderAtoms(page: Page, current: boolean): Promise<readonly string[]> {
  return page.evaluate(current => {
    const header = document.querySelector(".topbar")
    if (header === null) throw new Error("Missing compiled header")
    const compact = (value: string) => value.replace(/\s+/gu, "")
    const wanted: Record<string, string> = current ? {
      "border-bottom-color": "var(--hraness-material-seam, var(--line))",
      "background-color": "var(--hraness-material-chrome-paint, color-mix(in srgb, var(--paper) 84%, transparent))",
      "backdrop-filter": "var(--hraness-material-chrome-blur, blur(14px) saturate(1.4))",
    } : { "border-bottom-color": "var(--line)", "background-color": "color-mix(in srgb, var(--paper) 84%, transparent)", "backdrop-filter": "blur(14px) saturate(1.4)" }
    const found = new Map<string, string>()
    const visit = (rules: CSSRuleList, depth: number) => {
      if (depth > 12) throw new Error("Excessive compiled stylesheet nesting")
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule && /^\.x[a-z0-9]+$/u.test(rule.selectorText) && header.classList.contains(rule.selectorText.slice(1))) {
          for (const [property, value] of Object.entries(wanted)) if (compact(rule.style.getPropertyValue(property)) === compact(value)) {
            const properties = [...rule.style].sort(), allowed = property === "backdrop-filter" ? ["-webkit-backdrop-filter", "backdrop-filter"] : [property]
            if (!properties.includes(property) || properties.some(key => !allowed.includes(key)) || properties.some(key => rule.style.getPropertyPriority(key) !== "" || compact(rule.style.getPropertyValue(key)) !== compact(value)))
              throw new Error(`Unreviewed header atom declarations: ${property}`)
            if (found.has(property)) throw new Error(`Duplicate compiled header atom: ${property}`)
            found.set(property, rule.selectorText.slice(1))
          }
        } else if ("cssRules" in rule) visit((rule as CSSGroupingRule).cssRules, depth + 1)
      }
    }
    for (const sheet of document.styleSheets) {
      if (sheet.href === null || new URL(sheet.href).origin !== location.origin || sheet.disabled) throw new Error("Unowned header stylesheet")
      visit(sheet.cssRules, 0)
    }
    if (found.size !== 3 || new Set(found.values()).size !== 3) throw new Error("Incomplete compiled header paint admission")
    return [...found.values()]
  }, current)
}

/** Same owned CDP media seam as the released material's browser proof. The
 * preference and scroll are restored and the session detached on every path. */
export async function withLanternTransparency(page: Page, inspect: () => Promise<void>): Promise<void> {
  const initial = await page.evaluate(() => ({ scrollX, scrollY, features: [
    { name: "prefers-color-scheme", value: matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" },
    { name: "prefers-reduced-motion", value: matchMedia("(prefers-reduced-motion: reduce)").matches ? "reduce" : "no-preference" },
    { name: "prefers-reduced-transparency", value: matchMedia("(prefers-reduced-transparency: reduce)").matches ? "reduce" : "no-preference" },
    { name: "forced-colors", value: matchMedia("(forced-colors: active)").matches ? "active" : "none" },
  ] }))
  const session = await page.context().newCDPSession(page), errors: unknown[] = []
  const select = async (features: typeof initial.features) => {
    await session.send("Emulation.setEmulatedMedia", { features })
    assert.equal(await page.evaluate(features => features.every(({ name, value }) => matchMedia(`(${name}: ${value})`).matches), features), true)
  }
  try { await select(initial.features.map(item => item.name === "prefers-reduced-transparency" ? { ...item, value: "reduce" } : item)); await inspect() }
  catch (error) { errors.push(error) }
  finally {
    try { await select(initial.features) } catch (error) { errors.push(error) }
    try { await page.evaluate(({ scrollX, scrollY }) => scrollTo({ left: scrollX, top: scrollY, behavior: "instant" }), initial) } catch (error) { errors.push(error) }
    try { await session.detach() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, "Lantern transparency inspection and restoration failed")
}
export async function observeLanternInteraction(page: Page, scenario: ShellCase, reference: LanternPaint): Promise<void> {
  const selector = ".hraness-material-disclosure", summaries = `${selector} > summary`
  assert.equal(await page.locator(selector).count(), 9)
  assert.equal(await page.locator(`${selector}[open]`).count(), 0)
  const before = await measure(page, [summaries]), originalScroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }))
  const first = page.locator(summaries).first(), errors: unknown[] = []
  try {
    await first.click(); await settle(page, scenario.direction)
    assert.equal(await page.locator(`${selector}[open]`).count(), 1)
    await first.focus(); await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab"); await settle(page, scenario.direction)
    assert.equal(await first.evaluate(element => element === document.activeElement && element.matches(":focus-visible")), true)
    const selected = (await measure(page, [summaries]))[0]!
    for (const [property, value] of Object.entries(reference.warm)) assert.equal(selected.styles[property], value, `Opened disclosure exact ${property}`)
    assert.equal(selected.styles["outline-style"], "solid"); assert.equal(selected.styles["outline-width"], "2px"); assert.equal(selected.styles["outline-offset"], "2px")
    await page.keyboard.press("Enter"); await settle(page, scenario.direction)
    assert.equal(await page.locator(`${selector}[open]`).count(), 0)
  } catch (error) { errors.push(error) }
  finally {
    try {
      if (await page.locator(`${selector}[open]`).count() === 1) await first.click()
      await page.locator(".wordmark").focus()
      await page.evaluate(({ x, y }) => scrollTo({ left: x, top: y, behavior: "instant" }), originalScroll)
      await settle(page, scenario.direction)
      compareShellElements(await measure(page, [summaries]), before, "Exact restored native disclosure state")
    } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, "Lantern disclosure inspection and restoration failed")
}
