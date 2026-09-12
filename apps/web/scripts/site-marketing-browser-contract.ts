import assert from "node:assert/strict"
import { isAbsolute } from "node:path"
import type { Page } from "playwright-core"
import { assertShellNode, compareShellElements, compareShellEvidence, measure, resolvedShellTheme, settle,
  shellAppearanceSteps, shellRecord, shellResource, siteShellCases, siteShellDeadlineMs,
  type ShellCase, type ShellElement, type ShellEvidence, type ShellPayload } from "./site-shell-browser-contract"

/** Separately reviewed redesign contract. It never certifies historical parity. */
export const marketingScope = "marketing-editorial-v1"
export const marketingBaselineRevision = "bf1e1a905e81b24fe5c5a04f4fe9d75ea17521f9"
export const marketingBaselineTree = "7669115d5cec5872bc17ae4498a6b040173eb300"
export const marketingBaselineProfile = "marketing-before-editorial-bf1e1a9-v1"
export const marketingDeadlineMs = siteShellDeadlineMs
export const marketingCases = siteShellCases
export const marketingHeadingIds = ["install-title", "examples-title", "workflow-title", "interfaces-title",
  "design-title", "questions-title", "maker-title", "cta-title"] as const
export const marketingSectionIds = ["install", "examples", "workflow", "interfaces", "design", "questions", "maker", "closing"] as const
export interface MarketingRequest {
  readonly schemaVersion: 1
  readonly token: string
  readonly scope: typeof marketingScope
  readonly baselineProfile: typeof marketingBaselineProfile
  readonly appDirectory: string
  readonly chromeExecutable: string
  readonly endpoint: string
  readonly current: ShellPayload
  readonly baseline: ShellPayload
  readonly fieldAssets: readonly [string, string]
}
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), "Unexpected marketing protocol fields")
}
function payload(value: unknown): void {
  const item = shellRecord(value)
  keys(item, ["origin", "resources", "stylesheets", "finalCss"])
  assert.ok(typeof item.origin === "string" && /^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(item.origin))
  assert.ok(Number(new URL(item.origin).port) > 0 && Number(new URL(item.origin).port) <= 65535)
  assert.ok(Array.isArray(item.resources) && item.resources.length >= 20 && item.resources.length <= 128)
  item.resources.forEach(shellResource)
  assert.deepEqual(item.resources, [...new Set(item.resources)].sort())
  assert.ok(item.resources.includes("/") && item.resources.includes("/404.html"))
  assert.ok(Array.isArray(item.stylesheets) && item.stylesheets.length === 2 && new Set(item.stylesheets).size === 2)
  for (const path of item.stylesheets) { shellResource(path); assert.ok(path.endsWith(".css") && item.resources.includes(path)) }
  assert.equal(item.finalCss, item.stylesheets[1]); assert.match(String(item.finalCss), /^\/assets\/site-[a-f0-9]{64}\.css$/u)
}
export function parseMarketingRequest(value: unknown): MarketingRequest {
  const item = shellRecord(value)
  keys(item, ["schemaVersion", "token", "scope", "baselineProfile", "appDirectory", "chromeExecutable", "endpoint", "current", "baseline", "fieldAssets"])
  assert.equal(item.schemaVersion, 1); assert.equal(item.scope, marketingScope); assert.equal(item.baselineProfile, marketingBaselineProfile)
  assert.ok(typeof item.token === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(item.token))
  for (const key of ["appDirectory", "chromeExecutable"]) assert.ok(typeof item[key] === "string" && item[key].length <= 4096 && isAbsolute(item[key]))
  assert.ok(typeof item.endpoint === "string" && /^ws:\/\/127\.0\.0\.1:\d{1,5}\/devtools\/browser\/[a-f0-9-]+$/u.test(item.endpoint)
    && Number(new URL(item.endpoint).port) > 0 && Number(new URL(item.endpoint).port) <= 65535)
  payload(item.current); payload(item.baseline)
  assert.notEqual(shellRecord(item.current).origin, shellRecord(item.baseline).origin)
  assert.ok(Array.isArray(item.fieldAssets) && item.fieldAssets.length === 2 && new Set(item.fieldAssets).size === 2)
  for (const path of item.fieldAssets) {
    shellResource(path); assert.ok(path.endsWith(".svg") && (shellRecord(item.current).resources as string[]).includes(path))
  }
  return item as unknown as MarketingRequest
}
export function parseMarketingPhase(value: unknown, sequence: 0 | 1 | 2, request: MarketingRequest): Record<string, unknown> {
  const item = shellRecord(value), common = ["schemaVersion", "token", "scope", "baselineProfile", "sequence", "kind"]
  keys(item, sequence === 1 ? common : sequence === 0 ? [...common, "node", "playwright"]
    : [...common, "node", "playwright", "browser", "cases", "comparison", "closed", "negativeControls", "designCases"])
  assert.equal(item.schemaVersion, 1); assert.equal(item.token, request.token); assert.equal(item.scope, marketingScope)
  assert.equal(item.baselineProfile, marketingBaselineProfile); assert.equal(item.sequence, sequence)
  assert.equal(item.kind, ["started", "connected", "result"][sequence])
  if (sequence !== 1) { assertShellNode({ node: typeof item.node === "string" ? item.node : undefined }); assert.equal(item.playwright, "1.62.0") }
  if (sequence === 2) {
    assert.ok(typeof item.browser === "string" && /^\d+\.\d+\.\d+\.\d+$/u.test(item.browser))
    assert.deepEqual(item.cases, marketingCases.map(value => value.name)); assert.equal(item.closed, true)
    assert.equal(item.comparison, "unchanged-shell-and-copy-with-reviewed-homepage-design")
    assert.deepEqual(item.negativeControls, ["/-final-css", "/-foundation-css", "/404.html-final-css"])
    assert.ok(Array.isArray(item.designCases) && item.designCases.length === marketingCases.length)
    item.designCases.forEach((sample, index) => {
      const observation = shellRecord(sample), scenario = marketingCases[index]!
      keys(observation, ["name", "scope", "h1Px", "h2Px", "foundationRestored"])
      assert.equal(observation.name, scenario.name); assert.equal(observation.scope, scenario.route === "/" ? "editorial-main" : "unchanged-404")
      assert.equal(observation.h1Px, scenario.route === "/" ? headingSize(scenario.width, 1) : null)
      assert.equal(observation.h2Px, scenario.route === "/" ? headingSize(scenario.width, 2) : null)
      assert.equal(observation.foundationRestored, scenario.route === "/" && scenario.width === 1440 && scenario.theme === "system" && scenario.system === "light")
    })
  }
  return item
}
export function parseMarketingCaseFailure(value: unknown, request: MarketingRequest): Record<string, unknown> {
  const item = shellRecord(value)
  keys(item, ["schemaVersion", "scope", "token", "accepted", "completed", "scenario", "stage", "comparedCases", "error"])
  assert.equal(item.schemaVersion, 1); assert.equal(item.scope, marketingScope); assert.equal(item.token, request.token)
  assert.equal(item.accepted, false); assert.equal(item.completed, false)
  assert.ok(["current", "baseline", "pair", "comparison"].includes(String(item.stage)))
  assert.ok(Array.isArray(item.comparedCases) && item.comparedCases.length < marketingCases.length)
  assert.deepEqual(item.comparedCases, marketingCases.slice(0, item.comparedCases.length).map(value => value.name))
  assert.equal(item.scenario, marketingCases[item.comparedCases.length]!.name)
  assert.ok(typeof item.error === "string" && item.error.length > 0 && item.error.length <= 2048 && !/[\x00-\x1f]/u.test(item.error))
  return item
}
export function marketingCaseFailure(request: MarketingRequest, scenario: string, stage: string, comparedCases: readonly string[], error: unknown) {
  return parseMarketingCaseFailure({ schemaVersion: 1, scope: marketingScope, token: request.token, accepted: false, completed: false,
    scenario, stage, comparedCases: [...comparedCases], error: String(error).replace(/[\x00-\x1f]/gu, " ").slice(0, 2048) || "Unknown failure" }, request)
}
export function headingSize(width: number, level: 1 | 2): number {
  return level === 1 ? Math.min(64, Math.max(44, width * .051)) : Math.min(52, Math.max(38.4, width * .04))
}
const near = (actual: string | number, expected: number, label: string, tolerance = .1) =>
  assert.ok(Math.abs(Number.parseFloat(String(actual)) - expected) <= tolerance, `${label}: ${actual} != ${expected}`)
function normalizeMainOptIn(dom: string): string {
  const current = '<main class="hraness-marketing-field" data-hraness-marketing-preset="editorial" id="main" tabindex="-1">'
  assert.equal(dom.split(current).length, 2, "Exactly one reviewed main opt-in required")
  return dom.replace(current, '<main id="main" tabindex="-1">')
}
/** Both sides already use the same compiled shell/install transport. Preserve
 * every actual class and attribute; only the declared main opening differs. */
export async function marketingDom(page: Page, current: boolean): Promise<string> {
  const dom = await page.evaluate(() => {
    const root = document.body.cloneNode(true) as HTMLElement
    for (const script of root.querySelectorAll("script")) script.remove()
    return root.outerHTML
  })
  return current && await page.locator('#main[data-hraness-marketing-preset="editorial"]').count() === 1 ? normalizeMainOptIn(dom) : dom
}
/** Only document-flow Y moves for unchanged siblings below the redesigned main.
 * Relative child geometry, width/height, all paint, semantics and text stay exact. */
function translateSiblings(items: readonly ShellElement[], evidence: ShellEvidence): ShellElement[] {
  return items.map(item => {
    const owner = item.key.startsWith(".slopcamera-ask-ai") ? ".slopcamera-ask-ai[0]"
      : item.key.startsWith("#hraness-site-footer") || item.key.startsWith(".hraness-site-footer") ? "#hraness-site-footer[0]" : undefined
    if (owner === undefined) return item
    const anchor = evidence.elements.find(value => value.key === owner)
    assert.ok(anchor !== undefined)
    return { ...item, rect: item.rect.map((value, axis) => axis === 1 ? value - anchor.rect[1]! : value) }
  })
}
const geometryProperties = ["width", "height", "max-width", "margin-left", "margin-right", "grid-template-columns"] as const
const spacingProperties = ["padding-top", "padding-bottom", "padding-left", "padding-right"] as const
const headingProperties = ["font-family", "font-size", "font-weight", "line-height", "letter-spacing", "color", ...geometryProperties] as const
export interface MarketingPaintReference { readonly ink: string; readonly line: string; readonly strongLine: string; readonly primaryInk: string }
export interface MarketingPaintPair { readonly current: MarketingPaintReference; readonly baseline: MarketingPaintReference }
const borderSides = ["top", "right", "bottom", "left"] as const
const primaryActionKeys = [".hraness-marketing-hero__actions a[0]", ".hraness-marketing-cta__actions a[data-emphasis=\"primary\"][0]"] as const
const fieldLayerDefaults = { "background-attachment": "scroll", "background-origin": "padding-box", "background-clip": "border-box" } as const
const marketingBorderPaint: Readonly<Record<string, { readonly sides: readonly string[]; readonly reference: "line" | "strongLine" }>> = {
  ...Object.fromEntries(marketingSectionIds.map(id => [`#${id}[0]`, { sides: id === "install" ? borderSides : ["top"], reference: "line" as const }])),
  ".hraness-marketing-proof-frame[0]": { sides: borderSides, reference: "line" },
  ".hraness-marketing-proof-frame__chrome[0]": { sides: ["bottom"], reference: "line" },
  ".hraness-marketing-proof-frame__caption[0]": { sides: ["top"], reference: "line" },
  ".hraness-marketing-hero__actions a[1]": { sides: borderSides, reference: "strongLine" },
}
/** Immutable paper-theme.css primary-foreground (84), bridged to accent ink
 * (148). Forced colors uses the separately measured native Canvas value. */
export function marketingPrimaryContrast(scenario: ShellCase): string | undefined {
  return scenario.forced === "active" ? undefined : resolvedShellTheme(scenario.theme, scenario.system) === "dark"
    ? "rgb(18, 16, 15)" : "rgb(248, 247, 244)"
}
/** Use the pinned browser's color serialization, with explicit immutable alpha
 * and expected ink. These nonrendered probes are removed before any comparison. */
export async function measureMarketingPaintReference(page: Page, scenario: ShellCase, mode: "current" | "baseline"): Promise<MarketingPaintReference | undefined> {
  if (scenario.route !== "/") return undefined
  const dark = resolvedShellTheme(scenario.theme, scenario.system) === "dark"
  return page.evaluate(({ mode, dark, forced, primaryContrast }) => {
    const main = document.querySelector("#main")
    if (main === null) throw new Error("Missing main color reference")
    const ink = mode === "baseline" ? getComputedStyle(main).color : forced ? getComputedStyle(document.documentElement).color
      : dark ? "rgb(236, 238, 233)" : "rgb(36, 42, 47)"
    const sample = (color: string) => {
      const element = document.createElement("span")
      element.style.display = "none"; element.style.color = color
      document.documentElement.append(element)
      try { return getComputedStyle(element).color } finally { element.remove() }
    }
    const primaryInk = mode === "baseline" ? ink : forced ? getComputedStyle(document.documentElement).backgroundColor : primaryContrast!
    return { ink: sample(ink), primaryInk: forced ? primaryInk : sample(primaryInk), line: sample(forced ? ink : `color-mix(in oklch, ${ink} 12%, transparent)`),
      strongLine: sample(forced ? ink : `color-mix(in oklch, ${ink} 22%, transparent)`) }
  }, { mode, dark, forced: scenario.forced === "active", primaryContrast: marketingPrimaryContrast(scenario) })
}
export function assertMarketingDerivedPaint(elements: readonly ShellElement[], reference: MarketingPaintReference): void {
  for (const [key, contract] of Object.entries(marketingBorderPaint)) {
    const matches = elements.filter(item => item.key === key); assert.equal(matches.length, 1, `Exactly one derived border owner ${key}`)
    for (const side of contract.sides) {
      assert.equal(matches[0]!.styles[`border-${side}-width`], "1px", `${key} retains its one-pixel ${side} border`)
      assert.equal(matches[0]!.styles[`border-${side}-style`], "solid", `${key} retains its solid ${side} border`)
      assert.equal(matches[0]!.styles[`border-${side}-color`], reference[contract.reference], `${key} exact derived ${side} border color`)
    }
  }
  assert.equal(elements.find(item => item.key === ".hraness-marketing-hero__actions a[1]")!.styles.color, reference.ink, "Only the secondary action uses field ink")
  for (const key of primaryActionKeys) {
    const matches = elements.filter(item => item.key === key); assert.equal(matches.length, 1, `Exactly one primary action ${key}`)
    assert.equal(matches[0]!.styles.color, reference.primaryInk, `${key} retains readable accent contrast ink`)
  }
}
/** This map and the separately asserted marketingBorderPaint are the complete
 * exception surface. Unlisted paint, content and semantics remain exact. */
export const marketingDifferenceMap: Readonly<Record<string, { readonly properties: readonly string[]; readonly axes: readonly number[] }>> = Object.freeze({
  "body[0]": { properties: ["height"], axes: [3] },
  "#main[0]": { properties: ["height", "position", "color", "background-color", "background-image", "background-position", "background-size", "background-repeat"], axes: [3] },
  "#page-title[0]": { properties: headingProperties, axes: [0, 1, 2, 3] },
  ".hraness-marketing-hero[0]": { properties: [...geometryProperties, ...spacingProperties, "color", "background-color", "background-image"], axes: [0, 1, 2, 3] },
  ".hraness-marketing-hero__summary[0]": { properties: [...geometryProperties, "font-size", "line-height", "color"], axes: [0, 1, 2, 3] },
  ...Object.fromEntries(marketingSectionIds.map(id => [`#${id}[0]`, { properties: [...geometryProperties, ...spacingProperties, "color", ...(id === "install" ? ["border-radius"] : [])], axes: [0, 1, 2, 3] }])),
  ...Object.fromEntries(marketingHeadingIds.map(id => [`#${id}[0]`, { properties: headingProperties, axes: [0, 1, 2, 3] }])),
  ...Object.fromEntries([".hraness-marketing-hero__copy[0]", ".hraness-marketing-hero__frame[0]"].map(key =>
    [key, { properties: [...geometryProperties, "color"], axes: [0, 1, 2, 3] }])),
  ".hraness-marketing-proof-frame[0]": { properties: [...geometryProperties, "color", "border-radius"], axes: [0, 1, 2, 3] },
  ".hraness-marketing-proof-frame__content[0]": { properties: [...geometryProperties, "color"], axes: [0, 1, 2, 3] },
  ".hraness-marketing-proof-frame__chrome[0]": { properties: [...geometryProperties, "color"], axes: [0, 1, 2, 3] },
  ".hraness-marketing-proof-frame__caption[0]": { properties: [...geometryProperties, "color"], axes: [0, 1, 2, 3] },
  ".transcript[0]": { properties: geometryProperties, axes: [0, 1, 2, 3] },
  ".hraness-marketing-install__heading-group > .install-note[0]": { properties: ["width", "height", "overflow-wrap"], axes: [0, 1, 2, 3] },
  '.hraness-marketing-cta__actions a[data-emphasis="primary"][0]': { properties: ["width", "height", "min-height", "border-radius"], axes: [0, 1, 2, 3] },
  ...Object.fromEntries([0, 1].map(index => [`.hraness-marketing-hero__actions a[${index}]`,
    { properties: ["width", "height", "min-height", "border-radius", ...(index === 1 ? ["color"] : [])], axes: [0, 1, 2, 3] }])),
})
export function compareMarketingElements(actual: readonly ShellElement[], baseline: readonly ShellElement[], label: string, paint?: MarketingPaintPair): void {
  assert.deepEqual(actual.map(value => value.key), baseline.map(value => value.key), `${label}: exact landmark inventory`)
  const projected = actual.map((item, index) => {
    const allowed = marketingDifferenceMap[item.key], old = baseline[index]!
    if (allowed === undefined) return item
    assert.ok(item.rect[2]! > 0 && item.rect[3]! > 0, `${label}: collapsed landmark ${item.key}`)
    const styles = { ...item.styles }
    const repairedPrimaryInk = primaryActionKeys.includes(item.key as typeof primaryActionKeys[number]) && paint !== undefined
      && item.styles.color === paint.current.primaryInk && old.styles.color === paint.baseline.primaryInk
    if (repairedPrimaryInk) styles.color = old.styles.color!
    // Adding the three positively asserted field layers repeats these unchanged
    // defaults in CSSOM. No other owner, value or layer count is equivalent.
    if (item.key === "#main[0]") for (const [property, value] of Object.entries(fieldLayerDefaults)) {
      if (old.styles[property] === value && item.styles[property] === [value, value, value].join(", ")) styles[property] = value
    }
    const border = marketingBorderPaint[item.key]
    if (paint !== undefined && border !== undefined) for (const side of border.sides) {
      const property = `border-${side}-color`
      if (item.styles[property] === paint.current[border.reference] && old.styles[property] === paint.baseline[border.reference]) styles[property] = old.styles[property]!
    }
    for (const property of allowed.properties) if (Object.hasOwn(old.styles, property)) styles[property] = old.styles[property]!
    // CSSOM exposes currentColor even on absent decoration/outline/borders.
    // Admit only that exact derivation from the independently asserted ink;
    // active paint and independently authored values remain strict.
    if (allowed.properties.includes("color") || repairedPrimaryInk) {
      const inactive = [
        ...(old.styles["text-decoration-line"] === "none" ? ["text-decoration-color"] : []),
        ...(old.styles["outline-style"] === "none" ? ["outline-color"] : []),
        ...["top", "right", "bottom", "left"].filter(side => old.styles[`border-${side}-style`] === "none")
          .map(side => `border-${side}-color`),
      ]
      for (const property of inactive) if (old.styles[property] === old.styles.color && item.styles[property] === item.styles.color)
        styles[property] = old.styles[property]!
    }
    return { ...item, styles, rect: item.rect.map((value, axis) => allowed.axes.includes(axis) ? old.rect[axis]! : value) }
  })
  compareShellElements(projected, baseline, label)
}
export function compareMarketingEvidence(actual: ShellEvidence, baseline: ShellEvidence, scenario: ShellCase, paint?: MarketingPaintPair): void {
  if (scenario.route === "/404.html") { compareShellEvidence(actual, baseline, scenario.name); return }
  assert.equal(normalizeMainOptIn(actual.dom), baseline.dom, "Copy, commands, logo and DOM outside the exact opt-in must remain unchanged")
  assert.equal(actual.direction, baseline.direction); assert.equal(actual.recovery, baseline.recovery)
  assertMarketingFlow(actual.elements, baseline.elements)
  compareMarketingElements(translateSiblings(actual.elements, actual), translateSiblings(baseline.elements, baseline), `${scenario.name} finite design differences`, paint)
  compareShellElements([actual.skip], [baseline.skip], `${scenario.name} skip`)
  compareShellElements(translateSiblings(actual.focus, actual), translateSiblings(baseline.focus, baseline), `${scenario.name} native focus`)
  compareShellElements(translateSiblings(actual.hover, actual), translateSiblings(baseline.hover, baseline), `${scenario.name} native hover`)
  assert.deepEqual(actual.appearance.map(value => [value.step, value.active]), shellAppearanceSteps.map(value => [value.name, value.active]))
  assert.deepEqual(actual.appearance.map(value => [value.step, value.active]), baseline.appearance.map(value => [value.step, value.active]))
  actual.appearance.forEach((value, index) => compareShellElements(value.elements, baseline.appearance[index]!.elements, `${scenario.name} appearance ${value.step}`))
}
export const marketingDetailSelectors = ["#main", "#page-title", ...marketingHeadingIds.map(id => `#${id}`), ".hraness-marketing-hero", ".hraness-marketing-hero__copy",
  ".hraness-marketing-hero__frame", ".hraness-marketing-hero__summary", ".hraness-marketing-hero__actions a", ".hraness-marketing-proof-frame",
  ".hraness-marketing-proof-frame__chrome", ".hraness-marketing-proof-frame__content", ".transcript", ".hraness-marketing-proof-frame__caption",
  ".hraness-marketing-install__heading-group > .install-note", '.hraness-marketing-cta__actions a[data-emphasis="primary"]', ...marketingSectionIds.map(id => `#${id}`)] as const
function landmark(elements: readonly ShellElement[], selector: string): ShellElement {
  const matches = elements.filter(item => item.key === `${selector}[0]`)
  assert.equal(matches.length, 1, `Exactly one ${selector}`); return matches[0]!
}
export function assertMarketingFlow(actual: readonly ShellElement[], baseline: readonly ShellElement[]): void {
  const main = landmark(actual, "#main"), oldMain = landmark(baseline, "#main")
  const delta = main.rect[1]! + main.rect[3]! - oldMain.rect[1]! - oldMain.rect[3]!
  for (const selector of [".slopcamera-ask-ai", "#hraness-site-footer"]) {
    near(landmark(actual, selector).rect[1]! - landmark(baseline, selector).rect[1]!, delta, `${selector} moves only with main flow`, .5)
  }
}
export function assertMarketingPaint(elements: readonly ShellElement[], scenario: ShellCase, fieldAssets: readonly [string, string], origin: string,
  canvas: { readonly color: string; readonly background: string }): void {
  const pick = (selector: string) => landmark(elements, selector), field = pick("#main"), hero = pick(".hraness-marketing-hero")
  const forced = scenario.forced === "active", dark = resolvedShellTheme(scenario.theme, scenario.system) === "dark"
  const ink = forced ? canvas.color : dark ? "rgb(236, 238, 233)" : "rgb(36, 42, 47)"
  const muted = forced ? canvas.color : dark ? "rgb(194, 201, 206)" : "rgb(81, 93, 104)"
  for (const selector of ["#main", "#page-title", ...marketingHeadingIds.map(id => `#${id}`), ...marketingSectionIds.map(id => `#${id}`),
    ".hraness-marketing-hero", ".hraness-marketing-hero__copy", ".hraness-marketing-hero__frame", ".hraness-marketing-proof-frame", ".hraness-marketing-proof-frame__content"]) {
    assert.equal(pick(selector).styles.color, ink, `${selector} exact field ink`)
  }
  for (const selector of [".hraness-marketing-hero__summary", ".hraness-marketing-proof-frame__chrome", ".hraness-marketing-proof-frame__caption"])
    assert.equal(pick(selector).styles.color, muted, `${selector} exact field secondary ink`)
  const canvasChannels = forced ? /^rgb\((\d+, \d+, \d+)\)$/u.exec(canvas.background) : null
  if (forced) assert.ok(canvasChannels !== null, "Forced Canvas requires the pinned browser's opaque RGB serialization")
  const transparent = forced ? `rgba(${canvasChannels![1]}, 0)` : "rgba(0, 0, 0, 0)"
  assert.equal(hero.styles["background-image"], "none"); assert.equal(hero.styles["background-color"], transparent, "Hero retains exact transparent Canvas paint")
  assert.equal(field.styles["background-color"], forced ? canvas.background : "rgba(0, 0, 0, 0)")
  assert.equal(field.styles.position, "relative")
  for (const [property, value] of Object.entries(fieldLayerDefaults))
    assert.equal(field.styles[property], forced ? value : [value, value, value].join(", "), `Every field layer retains default ${property}`)
  if (forced) {
    assert.equal(field.styles["background-image"], "none"); assert.equal(field.styles["background-size"], "auto")
    assert.match(field.styles["background-position"]!, /^(?:0px|0%) (?:0px|0%)$/u); assert.equal(field.styles["background-repeat"], "repeat")
  } else {
    const value = field.styles["background-image"]!, urls = [...value.matchAll(/url\("?([^"\)]+)"?\)/gu)].map(match => new URL(match[1]!))
    for (const url of urls) { assert.equal(url.origin, origin); assert.equal(url.search, ""); assert.equal(url.hash, "") }
    assert.deepEqual(urls.map(url => url.pathname), fieldAssets, "Exact admitted grain then cells")
    const gradient = value.match(/linear-gradient\((.*)\)$/u)?.[1]?.replace(/^180deg, /u, "")
    assert.equal(gradient, dark ? "rgb(41, 43, 40) 0%, rgb(52, 59, 61) 34%, rgb(66, 78, 101) 70%, rgb(47, 56, 67) 100%"
      : "rgb(240, 239, 234) 0%, rgb(220, 225, 223) 34%, rgb(201, 211, 221) 70%, rgb(227, 231, 232) 100%")
    assert.match(field.styles["background-size"]!, new RegExp(`^64px 64px, ${scenario.width <= 760 ? "266\\.667" : "100"}%(?: auto)?, 100% 100%$`, "u"))
    assert.match(field.styles["background-position"]!, /^(?:0px|0%) (?:0px|0%), 50% (?:0px|0%), (?:0px|0%) (?:0px|0%)$/u)
    assert.ok(["repeat", "repeat, repeat, repeat"].includes(field.styles["background-repeat"]!))
  }
}
export interface MarketingTextExtent { readonly selector: string; readonly fragments: readonly (readonly number[])[]; readonly client: readonly number[]; readonly scroll: readonly number[] }
export function assertMarketingInstallNote(note: ShellElement, heading: ShellElement, extent: MarketingTextExtent, column: readonly number[], viewportWidth: number, direction: "ltr" | "rtl" = "ltr"): void {
  assert.equal(extent.selector, ".hraness-marketing-install__heading-group > .install-note")
  assert.equal(note.styles["overflow-wrap"], "anywhere", "Archive URL wraps without changing its literal text")
  assert.ok(note.rect.every(Number.isFinite) && note.rect[2]! > 0 && note.rect[3]! > 0)
  assert.ok(column.length === 4 && column.every(Number.isFinite) && column[2]! > 0 && column[3]! > 0)
  assert.ok(note.rect[0]! >= -.5 && note.rect[0]! + note.rect[2]! <= viewportWidth + .5, "Install note fits the viewport")
  assert.ok(note.rect[0]! >= column[0]! - .5 && note.rect[1]! >= column[1]! - .5
    && note.rect[0]! + note.rect[2]! <= column[0]! + column[2]! + .5
    && note.rect[1]! + note.rect[3]! <= column[1]! + column[3]! + .5, "Install note stays inside its actual column")
  assert.ok(heading.rect.length === 4 && heading.rect.every(Number.isFinite) && heading.rect[2]! > 0 && heading.rect[3]! > 0)
  assert.ok(heading.rect[0]! >= column[0]! - .5 && heading.rect[1]! >= column[1]! - .5
    && heading.rect[0]! + heading.rect[2]! <= column[0]! + column[2]! + .5
    && heading.rect[1]! + heading.rect[3]! <= column[1]! + column[3]! + .5, "Install heading stays inside its actual column")
  // The compiled note retains max-width:62ch; the heading can use more of the
  // same grid column. Both preserve their logical start, including RTL.
  near(heading.rect[0]! + (direction === "rtl" ? heading.rect[2]! : 0), note.rect[0]! + (direction === "rtl" ? note.rect[2]! : 0), "Install heading and note share their logical column start")
  assert.ok(extent.fragments.length > 0 && extent.fragments.length <= 256)
  assert.ok(extent.client.length === 2 && extent.scroll.length === 2 && [...extent.client, ...extent.scroll].every(value => Number.isFinite(value) && value > 0))
  assert.ok(extent.scroll[0]! <= extent.client[0]! + 1 && extent.scroll[1]! <= extent.client[1]! + 1, "Complete install text has no concealed overflow")
  for (const fragment of extent.fragments) assert.ok(fragment.length === 4 && fragment.every(Number.isFinite) && fragment[2]! > 0 && fragment[3]! > 0
    && fragment[0]! >= note.rect[0]! - .5 && fragment[1]! >= note.rect[1]! - .5
    && fragment[0]! + fragment[2]! <= note.rect[0]! + note.rect[2]! + .5
    && fragment[1]! + fragment[3]! <= note.rect[1]! + note.rect[3]! + .5, "Every install text and archive URL fragment is visible")
}
export function assertMarketingProof(elements: readonly ShellElement[], extents: readonly MarketingTextExtent[]): void {
  const frame = landmark(elements, ".hraness-marketing-proof-frame"), chrome = landmark(elements, ".hraness-marketing-proof-frame__chrome")
  const content = landmark(elements, ".hraness-marketing-proof-frame__content"), transcript = landmark(elements, ".transcript"), caption = landmark(elements, ".hraness-marketing-proof-frame__caption")
  const contained = (inner: readonly number[], outer: readonly number[], label: string) => {
    assert.ok(inner.length === 4 && inner.every(Number.isFinite) && inner[2]! > 0 && inner[3]! > 0, `${label} positive fragment`)
    assert.ok(inner[0]! >= outer[0]! - .5 && inner[1]! >= outer[1]! - .5 && inner[0]! + inner[2]! <= outer[0]! + outer[2]! + .5
      && inner[1]! + inner[3]! <= outer[1]! + outer[3]! + .5, `${label} complete visible containment`)
  }
  for (const item of [chrome, content, caption]) { contained(item.rect, frame.rect, item.key); near(item.rect[2]!, frame.rect[2]! - 2 * Number.parseFloat(frame.styles["border-left-width"]!), `${item.key} frame width`, .5) }
  contained(transcript.rect, content.rect, "Full transcript")
  near(chrome.rect[1]! + chrome.rect[3]!, content.rect[1]!, "Chrome/content contiguous", .5)
  near(content.rect[1]! + content.rect[3]!, caption.rect[1]!, "Content/caption contiguous", .5)
  const line = Number.parseFloat(transcript.styles["line-height"]!), padding = Number.parseFloat(transcript.styles["padding-top"]!) + Number.parseFloat(transcript.styles["padding-bottom"]!)
  assert.ok(line >= 20 && transcript.rect[3]! >= 6 * line + padding - .5, "All six authored command lines retain readable extent")
  assert.deepEqual(extents.map(item => item.selector), [".transcript", ".hraness-marketing-proof-frame__caption"])
  for (const extent of extents) {
    const owner = landmark(elements, extent.selector)
    assert.ok(extent.fragments.length > 0 && extent.fragments.length <= 256, "Bounded visible text fragments")
    assert.ok(extent.client.length === 2 && extent.scroll.length === 2 && [...extent.client, ...extent.scroll].every(value => Number.isFinite(value) && value > 0))
    assert.ok(extent.scroll[0]! <= extent.client[0]! + 1 && extent.scroll[1]! <= extent.client[1]! + 1, "No concealed text overflow")
    for (const fragment of extent.fragments) { contained(fragment, owner.rect, extent.selector); contained(fragment, frame.rect, "Frame text") }
  }
}
export async function measureMarketingDetails(page: Page, scenario: ShellCase): Promise<ShellElement[]> {
  return scenario.route === "/" ? measure(page, marketingDetailSelectors) : []
}
export interface MarketingObservation { readonly name: string; readonly scope: "editorial-main" | "unchanged-404"; readonly h1Px: number | null; readonly h2Px: number | null; readonly foundationRestored: boolean }
export async function observeMarketingDesign(page: Page, scenario: ShellCase, payload: ShellPayload, fieldAssets: readonly [string, string], negative: boolean): Promise<{ observation: MarketingObservation; elements: readonly ShellElement[]; paint?: MarketingPaintReference }> {
  if (scenario.route === "/404.html") {
    assert.equal(await page.locator('[data-hraness-marketing-preset],.hraness-marketing-field').count(), 0)
    return { observation: { name: scenario.name, scope: "unchanged-404", h1Px: null, h2Px: null, foundationRestored: false }, elements: [] }
  }
  assert.equal(await page.locator('[data-hraness-marketing-preset]').count(), 1)
  assert.equal(await page.locator('#main[data-hraness-marketing-preset="editorial"].hraness-marketing-field').count(), 1)
  assert.equal(await page.locator('.topbar[data-hraness-marketing-preset]').count(), 0)
  const selectors = marketingDetailSelectors
  const original = await measureMarketingDetails(page, scenario), pick = (key: string) => {
    const item = original.find(value => value.key === `${key}[0]`); assert.ok(item !== undefined, key); return item
  }
  const field = pick("#main"), h1 = pick("#page-title"), hero = pick(".hraness-marketing-hero")
  const expectedH1 = headingSize(scenario.width, 1), expectedH2 = headingSize(scenario.width, 2)
  for (const [heading, size, leading, tracking] of [[h1, expectedH1, 1.06, -.025],
    ...marketingHeadingIds.map(id => [pick(`#${id}`), expectedH2, 1.08, -.02] as const)] as const) {
    assert.match(heading.styles["font-family"]!, /Instrument Serif/u); assert.equal(heading.styles["font-weight"], "400")
    near(heading.styles["font-size"]!, size, heading.key); near(heading.styles["line-height"]!, size * leading, heading.key)
    near(heading.styles["letter-spacing"]!, size * tracking, heading.key)
    assert.ok(heading.rect[2]! > 0 && heading.rect[3]! >= size * leading - .5 && heading.rect[3]! <= size * leading * 8, "Readable, noncollapsed heading")
    if (!(heading.rect[0]! >= -.5 && heading.rect[0]! + heading.rect[2]! <= scenario.width + .5)) {
      const geometry = await page.locator(heading.key.replace(/\[0\]$/u, "")).evaluate(element => {
        const values = [], properties = ["width", "min-width", "max-width", "display", "box-sizing", "overflow-x", "grid-template-columns"]
        let current: Element | null = element
        for (let depth = 0; current !== null && depth < 3; depth++, current = current.parentElement) {
          const rect = current.getBoundingClientRect(), style = getComputedStyle(current)
          values.push({ tag: current.tagName, id: current.id, rect: [rect.x, rect.y, rect.width, rect.height],
            styles: Object.fromEntries(properties.map(property => [property, style.getPropertyValue(property)])) })
        }
        return values
      })
      assert.fail(`Heading fits the viewport: ${JSON.stringify({ heading: heading.key, viewport: scenario.width, rect: heading.rect, geometry })}`)
    }
    assert.equal(heading.styles.visibility, "visible"); assert.equal(heading.styles.opacity, "1")
  }
  assert.equal(h1.text, "Direct scenes and films with your coding agent")
  assert.equal(await page.evaluate(() => [...document.fonts].some(face => face.family.replaceAll('"', '') === "Instrument Serif" && face.weight === "400" && face.status === "loaded")), true)
  const phone = scenario.width <= 760
  near(hero.styles["padding-top"]!, phone ? 44 : 56, "Hero top rhythm")
  near(hero.styles["padding-bottom"]!, phone ? 72 : 64, "Hero bottom rhythm")
  const canvas = await page.evaluate(() => ({ color: getComputedStyle(document.documentElement).color, background: getComputedStyle(document.documentElement).backgroundColor }))
  assertMarketingPaint(original, scenario, fieldAssets, payload.origin, canvas)
  const paint = await measureMarketingPaintReference(page, scenario, "current"); assert.ok(paint !== undefined)
  assertMarketingDerivedPaint(original, paint)
  const summary = pick(".hraness-marketing-hero__summary")
  near(summary.styles["font-size"]!, 17, "Summary size"); near(summary.styles["line-height"]!, 27.2, "Summary leading")
  assert.equal(await page.locator('#main .hraness-marketing-action[data-emphasis="primary"]').count(), 2, "Exactly two homepage primary actions")
  for (const action of original.filter(value => value.key.startsWith(".hraness-marketing-hero__actions a[") || primaryActionKeys.includes(value.key as typeof primaryActionKeys[number]))) {
    assert.ok(action.rect[3]! >= (scenario.coarse ? 48 : 42) - .5, "Action target height")
    near(action.styles["border-radius"]!, 4, "Action radius")
  }
  const sections = marketingSectionIds.map(id => pick(`#${id}`)), gutter = phone ? 20 : 32
  near(pick("#install").styles["border-radius"]!, 10, "Canonical install frame radius")
  near(pick(".hraness-marketing-proof-frame").styles["border-radius"]!, 10, "Canonical proof frame radius")
  for (const section of [hero, ...sections]) {
    near(section.rect[2]!, Math.min(section.key === "#install[0]" ? scenario.width - 2 * gutter : scenario.width, 1120), `${section.key} measure`)
    const inset = section.key === "#install[0]" ? Math.min(40, Math.max(24, scenario.width * .04)) : gutter
    near(section.styles["padding-left"]!, inset, `${section.key} left gutter`); near(section.styles["padding-right"]!, inset, `${section.key} right gutter`)
    assert.ok(section.rect[3]! > 0 && section.styles.display !== "none" && section.styles.visibility === "visible" && section.styles.opacity === "1", `${section.key} visible content`)
    if (section !== hero && section.key !== "#install[0]") {
      near(section.styles["padding-top"]!, phone ? 56 : 80, `${section.key} story start`)
      near(section.styles["padding-bottom"]!, phone ? 56 : 80, `${section.key} story end`)
    }
  }
  for (const selector of [".hraness-marketing-proof-frame", ".hraness-marketing-proof-frame__content", ".transcript", ".hraness-marketing-proof-frame__caption"]) {
    const proof = pick(selector)
    assert.ok(proof.rect[2]! > 0 && proof.rect[3]! > 0 && proof.rect[0]! >= -.5 && proof.rect[0]! + proof.rect[2]! <= scenario.width + .5, `${selector} visible bounded proof`)
    assert.equal(proof.styles.visibility, "visible"); assert.equal(proof.styles.opacity, "1")
  }
  const textExtents = await page.evaluate(() => [".transcript", ".hraness-marketing-proof-frame__caption", ".hraness-marketing-install__heading-group > .install-note"].map(selector => {
    const owner = document.querySelector<HTMLElement>(selector)
    if (owner === null) throw new Error(`Missing text owner ${selector}`)
    const walker = document.createTreeWalker(owner, NodeFilter.SHOW_TEXT), fragments: number[][] = []
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue
      for (let element = node.parentElement; element !== null; element = element === owner ? null : element.parentElement) {
        const style = getComputedStyle(element)
        if (style.visibility !== "visible" || style.display === "none" || style.opacity !== "1" || style.color === "rgba(0, 0, 0, 0)") throw new Error("Unreadable proof text")
      }
      const range = document.createRange(); range.selectNodeContents(node)
      const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0)
      if (rects.length === 0) throw new Error("Missing proof text fragments")
      fragments.push(...rects.map(rect => [rect.x, rect.y + scrollY, rect.width, rect.height]))
      if (fragments.length > 256) throw new Error("Excessive proof text fragments")
    }
    return { selector, fragments, client: [owner.clientWidth, owner.clientHeight], scroll: [owner.scrollWidth, owner.scrollHeight] }
  }))
  assertMarketingProof(original, textExtents.slice(0, 2))
  const installColumn = await page.locator(".hraness-marketing-install__heading-group").evaluate(element => {
    const rect = element.getBoundingClientRect(); return [rect.x, rect.y + scrollY, rect.width, rect.height]
  })
  assertMarketingInstallNote(pick(".hraness-marketing-install__heading-group > .install-note"), pick("#install-title"), textExtents[2]!, installColumn, scenario.width, scenario.direction)
  for (let index = 1; index < sections.length; index++) assert.ok(sections[index]!.rect[1]! >= sections[index - 1]!.rect[1]! + sections[index - 1]!.rect[3]! - .5, "Section order/clearance")
  assert.ok(hero.rect[1]! + hero.rect[3]! <= sections[0]!.rect[1]! + .5, "Hero clears install section")
  const copy = pick(".hraness-marketing-hero__copy"), frame = pick(".hraness-marketing-hero__frame")
  if (scenario.width >= 992) {
    near(copy.rect[2]! / frame.rect[2]!, .9 / 1.1, "Retained desktop hero ratio", .01)
    assert.ok(Math.min(copy.rect[1]! + copy.rect[3]!, frame.rect[1]! + frame.rect[3]!) > Math.max(copy.rect[1]!, frame.rect[1]!), "Desktop hero columns overlap vertically")
  } else assert.ok(frame.rect[1]! >= copy.rect[1]! + copy.rect[3]! - .5, "Phone hero stacks proof below copy")
  if (negative) {
    const shellBefore = await measure(page, [".topbar", ".wordmark"])
    const foundation = await page.evaluateHandle(href => {
      const sheet = [...document.styleSheets].find(value => value.href === href)
      if (sheet === undefined || sheet.disabled) throw new Error("Active foundation missing")
      sheet.disabled = true; return sheet
    }, `${payload.origin}${payload.stylesheets[0]}`)
    try {
      // This deliberate removal also unregisters the foundation's FontFaces.
      // Settle only this held disabled state; normal/restore paths still use
      // the original strict local-font admission below.
      await foundation.evaluate(async sheet => {
        const assertDisabled = () => {
          if (!(sheet instanceof CSSStyleSheet) || ![...document.styleSheets].includes(sheet) || !sheet.disabled) throw new Error("Lost disabled foundation identity")
        }
        assertDisabled()
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        assertDisabled()
      })
      const disabled = await measure(page, ["#main", "#page-title"])
      assert.ok(disabled[0]!.styles["background-image"] !== field.styles["background-image"] || disabled[1]!.styles["font-family"] !== h1.styles["font-family"], "Foundation removal must expose the actual preset dependency")
    } finally {
      await foundation.evaluate(sheet => { if (!(sheet instanceof CSSStyleSheet) || ![...document.styleSheets].includes(sheet)) throw new Error("Lost foundation identity"); sheet.disabled = false })
      await foundation.dispose()
    }
    await settle(page, scenario.direction)
    compareShellElements(await measure(page, selectors), original, "Exact restored editorial foundation")
    compareShellElements(await measure(page, [".topbar", ".wordmark"]), shellBefore, "Exact restored shell foundation")
  }
  return { observation: { name: scenario.name, scope: "editorial-main", h1Px: expectedH1, h2Px: expectedH2, foundationRestored: negative }, elements: original, paint }
}
