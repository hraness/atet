import assert from "node:assert/strict"
import { isAbsolute } from "node:path"
import type { Browser, Page, Request, WebSocketRoute } from "playwright-core"
import { bounded } from "./preview-browser-contract"

export const siteShellDeadlineMs = 720_000
export const siteShellBaselineRevision = "f417770111f55f3f3eb13fbae7b6a030c33a445d"
export const siteShellBaselineTree = "1771922fea1f74cab40d92bd3cd0e4689e2ef2ce"
export const siteShellHeaders = Object.freeze({
  "content-security-policy": "default-src 'self'; base-uri 'none'; connect-src https://us.i.posthog.com; font-src 'self'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'; upgrade-insecure-requests",
  "permissions-policy": "camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()",
  "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin", "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  vary: "Accept, Accept-Encoding",
})
export interface ShellCase {
  readonly name: string
  readonly route: "/" | "/404.html"
  readonly width: number
  readonly height: number
  readonly theme: "light" | "dark" | "system"
  readonly system: "light" | "dark"
  readonly forced: "none" | "active"
  readonly coarse: boolean
  readonly reflowEquivalent: boolean
  readonly direction?: "rtl"
}
const themes = [{ theme: "light", system: "dark" }, { theme: "dark", system: "light" },
  { theme: "system", system: "light" }, { theme: "system", system: "dark" }] as const
const originalSiteShellCases: readonly ShellCase[] = Object.freeze((["/", "/404.html"] as const).flatMap(route => [
  ...[320, 390, 544, 545, 768, 769, 1440].flatMap(width => themes.map(({ theme, system }) => ({
    name: `${route}-${width}-${theme}-${system}`, route, width, height: 900, theme, system,
    forced: "none" as const, coarse: false, reflowEquivalent: false,
  }))),
  ...(["light", "dark"] as const).map(system => ({ name: `${route}-forced-${system}`, route, width: 390,
    height: 700, theme: "system" as const, system, forced: "active" as const, coarse: false, reflowEquivalent: false })),
  ...[390, 769].map(width => ({ name: `${route}-coarse-${width}`, route, width, height: 700,
    theme: "system" as const, system: "light" as const, forced: "none" as const, coarse: true, reflowEquivalent: false })),
  ...(["light", "dark"] as const).map(system => ({ name: `${route}-200pct-reflow-equivalent-${system}`, route,
    width: 720, height: 450, theme: "system" as const, system, forced: "none" as const, coarse: false, reflowEquivalent: true })),
]))
export const siteShellCases: readonly ShellCase[] = Object.freeze([
  ...originalSiteShellCases,
  ...(["/", "/404.html"] as const).flatMap(route => [390, 1440].flatMap(width =>
    (["light", "dark"] as const).map(theme => ({ name: `${route}-rtl-${width}-${theme}`, route, width, height: 900,
      theme, system: theme === "light" ? "dark" as const : "light" as const, forced: "none" as const,
      coarse: false, reflowEquivalent: false, direction: "rtl" as const })))),
])

export interface ShellPayload {
  readonly origin: string
  readonly resources: readonly string[]
  readonly stylesheets: readonly string[]
  readonly finalCss: string
}
export interface ShellRequest {
  readonly schemaVersion: 1
  readonly token: string
  readonly appDirectory: string
  readonly chromeExecutable: string
  readonly endpoint: string
  readonly current: ShellPayload
  readonly baseline: ShellPayload
}
export interface ShellCaseFailure {
  readonly schemaVersion: 1
  readonly token: string
  readonly accepted: false
  readonly completed: false
  readonly scenario: string
  readonly stage: "current" | "baseline" | "comparison"
  readonly comparedCases: readonly string[]
  readonly error: string
}
/** Failure evidence is never a terminal success phase. Only the exact fully
 * compared prefix may precede the failed case; a measured current side alone
 * does not count as a completed pair. */
export function parseShellCaseFailure(value: unknown, request: Pick<ShellRequest, "token">): ShellCaseFailure {
  const failure = shellRecord(value)
  keys(failure, ["schemaVersion", "token", "accepted", "completed", "scenario", "stage", "comparedCases", "error"])
  assert.equal(failure.schemaVersion, 1); assert.equal(failure.token, request.token)
  assert.equal(failure.accepted, false); assert.equal(failure.completed, false)
  assert.ok(failure.stage === "current" || failure.stage === "baseline" || failure.stage === "comparison")
  assert.ok(Array.isArray(failure.comparedCases) && failure.comparedCases.length < siteShellCases.length)
  assert.deepEqual(failure.comparedCases, siteShellCases.slice(0, failure.comparedCases.length).map(item => item.name))
  assert.equal(failure.scenario, siteShellCases[failure.comparedCases.length]!.name)
  assert.ok(typeof failure.error === "string" && failure.error.length > 0 && failure.error.length <= 2_048
    && !/[\x00-\x1f]/u.test(failure.error))
  return failure as unknown as ShellCaseFailure
}
export function shellCaseFailure(request: Pick<ShellRequest, "token">, scenario: string,
  stage: ShellCaseFailure["stage"], comparedCases: readonly string[], error: unknown): ShellCaseFailure {
  return parseShellCaseFailure({ schemaVersion: 1, token: request.token, accepted: false, completed: false,
    scenario, stage, comparedCases: [...comparedCases], error: String(error).replace(/[\x00-\x1f]/gu, " ").slice(0, 2_048) || "Unknown failure" }, request)
}
export function shellRecord(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "Expected a shell record")
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), "Unexpected shell fields")
}
export function shellResource(path: unknown): asserts path is string {
  assert.ok(typeof path === "string" && path.length <= 512 && (path === "/" || /^\/[A-Za-z0-9_.\[\]/-]+$/u.test(path))
    && !path.includes("//") && (path === "/" || !path.endsWith("/"))
    && path.split("/").every(part => part !== "." && part !== ".."), "Invalid shell resource")
}
function payload(value: unknown, current: boolean): void {
  const item = shellRecord(value)
  keys(item, ["origin", "resources", "stylesheets", "finalCss"])
  assert.ok(typeof item.origin === "string" && /^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(item.origin))
  assert.ok(Number(new URL(item.origin).port) > 0 && Number(new URL(item.origin).port) <= 65535)
  assert.ok(Array.isArray(item.resources) && item.resources.length >= 20 && item.resources.length <= 128)
  item.resources.forEach(shellResource)
  assert.deepEqual(item.resources, [...new Set(item.resources)].sort())
  assert.ok(item.resources.includes("/") && item.resources.includes("/404.html"))
  assert.ok(Array.isArray(item.stylesheets) && item.stylesheets.length === (current ? 2 : 1))
  assert.equal(new Set(item.stylesheets).size, item.stylesheets.length)
  for (const path of item.stylesheets) {
    shellResource(path)
    assert.ok(path.endsWith(".css") && item.resources.includes(path))
  }
  assert.equal(item.finalCss, item.stylesheets[current ? 1 : 0])
  if (current) assert.match(String(item.finalCss), /^\/assets\/site-[a-f0-9]{64}\.css$/u)
}
export function parseShellRequest(value: unknown): ShellRequest {
  const request = shellRecord(value)
  keys(request, ["schemaVersion", "token", "appDirectory", "chromeExecutable", "endpoint", "current", "baseline"])
  assert.equal(request.schemaVersion, 1)
  assert.ok(typeof request.token === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(request.token))
  assert.ok(typeof request.appDirectory === "string" && request.appDirectory.length <= 4096 && isAbsolute(request.appDirectory))
  assert.ok(typeof request.chromeExecutable === "string" && request.chromeExecutable.length <= 4096 && isAbsolute(request.chromeExecutable))
  assert.ok(typeof request.endpoint === "string" && /^ws:\/\/127\.0\.0\.1:\d{1,5}\/devtools\/browser\/[a-f0-9-]+$/u.test(request.endpoint)
    && Number(new URL(request.endpoint).port) > 0 && Number(new URL(request.endpoint).port) <= 65535)
  payload(request.current, true); payload(request.baseline, false)
  assert.notEqual(shellRecord(request.current).origin, shellRecord(request.baseline).origin)
  return request as unknown as ShellRequest
}
export function assertShellNode(versions: Readonly<Record<string, string | undefined>>): string {
  assert.equal(versions.bun, undefined, "The native worker requires genuine Node")
  assert.equal(versions.node, "24.18.1", "The native worker requires pinned Node 24.18.1")
  return versions.node!
}
export function parseShellPhase(value: unknown, sequence: 0 | 1 | 2, request: ShellRequest): Record<string, unknown> {
  const phase = shellRecord(value)
  const common = ["schemaVersion", "token", "sequence", "kind"]
  keys(phase, sequence === 1 ? common : sequence === 0 ? [...common, "node", "playwright"]
    : [...common, "node", "playwright", "browser", "cases", "baselineCompared", "closed", "negativeControls"])
  assert.equal(phase.schemaVersion, 1); assert.equal(phase.token, request.token)
  assert.equal(phase.sequence, sequence); assert.equal(phase.kind, ["started", "connected", "result"][sequence])
  if (sequence !== 1) {
    assertShellNode({ node: typeof phase.node === "string" ? phase.node : undefined })
    assert.equal(phase.playwright, "1.62.0")
  }
  if (sequence === 2) {
    assert.ok(typeof phase.browser === "string" && /^\d+\.\d+\.\d+\.\d+$/u.test(phase.browser))
    assert.deepEqual(phase.cases, siteShellCases.map(scenario => scenario.name), "Native scope may not be skipped")
    assert.deepEqual(phase.negativeControls, ["/", "/404.html"])
    assert.equal(phase.baselineCompared, true); assert.equal(phase.closed, true)
  }
  return phase
}

export function shellContentType(path: string): string {
  if (path === "/" || path.endsWith(".html")) return "text/html; charset=utf-8"
  const extension = path.split(".").at(-1)!
  const types: Record<string, string> = { css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
    woff2: "font/woff2", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", webp: "image/webp",
    md: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8", xml: "application/xml; charset=utf-8", ico: "image/x-icon" }
  assert.ok(Object.hasOwn(types, extension), `Unadmitted resource type: ${path}`)
  return types[extension]!
}
export interface ShellElement {
  readonly key: string
  readonly rect: readonly number[]
  readonly styles: Readonly<Record<string, string>>
  readonly text: string
  readonly semantics: Readonly<Record<string, string | null>>
}
export interface ShellEvidence {
  readonly direction: "ltr" | "rtl"
  readonly dom: string
  readonly elements: readonly ShellElement[]
  readonly focus: readonly ShellElement[]
  readonly hover: readonly ShellElement[]
  readonly skip: ShellElement
  readonly recovery: boolean
  readonly appearance: readonly ShellAppearanceEvidence[]
}
export interface ShellAppearanceEvidence {
  readonly step: string
  readonly active: "light" | "dark" | "system"
  readonly elements: readonly ShellElement[]
}
export const shellAppearanceSteps = Object.freeze([
  { name: "arrow-down-opens-first", key: "ArrowDown", active: "light" },
  { name: "arrow-up-wraps-last", key: "ArrowUp", active: "system" },
  { name: "home-focuses-first", key: "Home", active: "light" },
  { name: "arrow-down-focuses-dark", key: "ArrowDown", active: "dark" },
  { name: "end-focuses-last", key: "End", active: "system" },
  { name: "arrow-down-wraps-first", key: "ArrowDown", active: "light" },
  { name: "arrow-up-opens-last", key: "ArrowUp", active: "system" },
] as const)
const appearanceRoot = "[data-hraness-appearance-menu]"
const appearanceTrigger = `${appearanceRoot} button`
const appearancePopover = `${appearanceRoot} .hraness-design-theme-toggle__popover`
const appearanceMenu = `${appearanceRoot} [role="menu"]`
const appearanceItems = `${appearanceRoot} [role="menuitemradio"]`
const appearanceSelectors = [appearanceRoot, appearanceTrigger, appearancePopover, appearanceMenu, appearanceItems,
  `${appearanceItems} .hraness-appearance-icon`, `${appearanceItems} .hraness-appearance-icon svg`]
const appearanceElementKeys = appearanceSelectors.flatMap((selector, index) =>
  Array.from({ length: index < 4 ? 1 : 3 }, (_, item) => `${selector}[${item}]`))
const commonSelectors = ["body", ".skip-link", ".topbar", ".wordmark", ".topbar-actions", '.topbar nav[aria-label="Primary"]',
  '.topbar nav[aria-label="Primary"] a', "[data-hraness-appearance-menu]", "[data-hraness-appearance-menu] button",
  "#main", "#hraness-site-footer", ".hraness-site-footer__inner", ".hraness-site-footer__brand", ".hraness-site-footer__mark",
  ".hraness-site-footer__links", ".hraness-site-footer__socials", ".hraness-site-footer__social-item",
  ".hraness-site-footer__social-link", ".hraness-site-footer__social-icon"]
const homeSelectors = ["#page-title", ".hraness-marketing-hero", ".hraness-marketing-hero__summary", "#install", "#examples",
  "#workflow", "#interfaces", "#design", "#questions", "#maker", "#closing", ".atet-ask-ai", ".atet-ask-ai *"]
const recoverySelectors = [".route-state", ".route-state h1", ".route-state p", ".route-state a"]
const properties = ["display", "position", "box-sizing", "width", "height", "min-width", "max-width", "min-height", "max-height",
  "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-align", "text-decoration-line", "text-decoration-color",
  "color", "background-color", "background-image", "background-position", "background-size", "background-repeat", "background-attachment",
  "background-origin", "background-clip", "border-radius", "box-shadow", "grid-template-columns", "flex-wrap", "flex-direction", "order",
  "align-items", "align-content", "justify-items", "justify-content", "row-gap", "column-gap", "transform", "opacity", "visibility",
  "overflow-x", "overflow-y", "white-space", "overflow-wrap", "outline-style", "outline-width", "outline-color", "outline-offset",
  "backdrop-filter", "appearance", "cursor", "touch-action", "direction", "z-index", ...["top", "right", "bottom", "left"].flatMap(side =>
    [`margin-${side}`, `padding-${side}`, `border-${side}-width`, `border-${side}-style`, `border-${side}-color`])]

async function measure(page: Page, selectors: readonly string[]): Promise<ShellElement[]> {
  return page.evaluate(({ selectors, properties }) => selectors.flatMap(selector => {
    const found = [...document.querySelectorAll<HTMLElement>(selector)]
    if (found.length === 0) throw new Error(`Missing shell landmark: ${selector}`)
    return found.map((element, index) => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element)
      return { key: `${selector}[${index}]`, rect: [rect.x, rect.y + scrollY, rect.width, rect.height],
        styles: Object.fromEntries(properties.map(property => [property, style.getPropertyValue(property)])),
        text: element.textContent?.replace(/\s+/gu, " ").trim() ?? "",
        semantics: Object.fromEntries(["href", "role", "aria-label", "aria-labelledby", "tabindex", "target", "rel",
          "aria-controls", "aria-expanded", "aria-haspopup", "aria-checked", "hidden", "data-theme-value", "data-selected"].map(key => [key, element.getAttribute(key)])) }
    })
  }), { selectors: [...selectors], properties })
}
function comparablePaintStyles(styles: ShellElement["styles"]): ShellElement["styles"] {
  const shadow = styles["box-shadow"]
  if (shadow === undefined) return styles
  // CSSOM retains the authored color space. Zero-lightness, zero-chroma black
  // has exactly the same paint in these two serializations. Keep alpha and
  // every shadow offset, spread and blur exact; do not normalize other colors.
  return { ...styles, "box-shadow": shadow.replace(/oklch\(0 0 0 \/ (0(?:\.\d+)?|1(?:\.0+)?)\)/gu,
    (_, alpha: string) => `rgba(0, 0, 0, ${Number(alpha)})`) }
}
export function compareShellElements(actual: readonly ShellElement[], baseline: readonly ShellElement[], label: string): void {
  assert.equal(actual.length, baseline.length, `${label}: element inventory`)
  const differences = actual.flatMap((item, index) => {
    const old = baseline[index]!
    const actualPaint = comparablePaintStyles(item.styles), baselinePaint = comparablePaintStyles(old.styles)
    const styles = [...new Set([...Object.keys(item.styles), ...Object.keys(old.styles)])]
      .filter(property => actualPaint[property] !== baselinePaint[property])
      .map(property => ({ property, baseline: old.styles[property], actual: item.styles[property] }))
    const geometry = item.rect.flatMap((axis, offset) =>
      Number.isFinite(axis) && Number.isFinite(old.rect[offset]) && Math.abs(axis - old.rect[offset]!) <= 0.5
        ? [] : [{ axis: offset, baseline: old.rect[offset], actual: axis }])
    return styles.length === 0 && geometry.length === 0 ? [] : [{ key: item.key, baselineKey: old.key, styles, geometry }]
  })
  try {
  for (const [index, item] of actual.entries()) {
    const old = baseline[index]!
    assert.equal(item.key, old.key); assert.equal(item.text, old.text, `${label} ${item.key}: text`)
    assert.deepEqual(item.semantics, old.semantics, `${label} ${item.key}: semantics`)
    assert.deepEqual(comparablePaintStyles(item.styles), comparablePaintStyles(old.styles), `${label} ${item.key}: computed styles`)
    assert.equal(item.rect.length, 4)
    item.rect.forEach((axis, offset) => assert.ok(Number.isFinite(axis) && Number.isFinite(old.rect[offset])
      && Math.abs(axis - old.rect[offset]!) <= 0.5, `${label} ${item.key}: geometry ${offset}: ${old.rect[offset]} -> ${axis}`))
  }
  } catch (error) {
    // Diagnose descendants even when the first failure is an ancestor's height.
    // Keep the original strict assertion; this is not a tolerance or retry.
    const properties = new Map<string, { key: string, property: string, baseline: string | undefined, actual: string | undefined, affectedElements: number }>()
    for (const item of differences) for (const style of item.styles) {
      const signature = JSON.stringify(style)
      const previous = properties.get(signature)
      if (previous) previous.affectedElements += 1
      else properties.set(signature, { key: item.key, ...style, affectedElements: 1 })
    }
    // Group repeated descendant deltas so the bounded worker stderr retains
    // the causal property changes instead of only a tail of shifted rectangles.
    const diagnostic = { changedElements: differences.length, changedProperties: properties.size,
      properties: [...properties.values()].slice(0, 20), geometryChanges: differences.reduce((count, item) => count + item.geometry.length, 0) }
    throw new AggregateError([error], `${label}: paired element differences ${JSON.stringify(diagnostic)}`)
  }
}
export function compareShellEvidence(actual: ShellEvidence, baseline: ShellEvidence, label: string): void {
  assert.equal(actual.direction, baseline.direction, `${label}: document direction changed`)
  assert.equal(actual.dom, baseline.dom, `${label}: semantic document changed`)
  assert.equal(actual.recovery, baseline.recovery)
  compareShellElements(actual.elements, baseline.elements, label)
  compareShellElements([actual.skip], [baseline.skip], `${label} focused skip`)
  compareShellElements(actual.focus, baseline.focus, `${label} keyboard focus`)
  compareShellElements(actual.hover, baseline.hover, `${label} pointer hover`)
  for (const evidence of [actual, baseline]) {
    assert.deepEqual(evidence.appearance.map(item => [item.step, item.active]), shellAppearanceSteps.map(step => [step.name, step.active]),
      `${label}: open appearance keyboard coverage incomplete`)
    for (const step of evidence.appearance) assert.deepEqual(step.elements.map(item => item.key), appearanceElementKeys,
      `${label}: open appearance landmark inventory incomplete`)
  }
  for (const [index, item] of actual.appearance.entries()) {
    compareShellElements(item.elements, baseline.appearance[index]!.elements, `${label} open appearance ${item.step}`)
  }
}
async function settle(page: Page, direction?: "rtl"): Promise<void> {
  await page.evaluate(async direction => {
    // RTL is an explicit paired browser fixture, applied to each new document
    // after navigation. The authoritative served HTML and CSS remain intact.
    if (direction === "rtl") document.documentElement.setAttribute("dir", direction)
    await document.fonts.ready
    const fonts = await Promise.all([document.fonts.load('400 16px "Nebula Sans"'), document.fonts.load('500 16px "Nebula Sans"')])
    if (fonts.some(group => group.length === 0 || group.some(font => font.status !== "loaded"))) throw new Error("Local fonts did not load")
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  }, direction)
}
export function resolvedShellTheme(preference: ShellCase["theme"], system: ShellCase["system"]): ShellCase["system"] {
  return preference === "system" ? system : preference
}
async function assertAppearancePreference(page: Page, preference: ShellCase["theme"], system: ShellCase["system"], label = ""): Promise<void> {
  const prefix = label === "" ? "" : `${label}: `
  assert.equal(await page.locator(appearanceRoot).getAttribute("data-theme-value"), preference, `${prefix}Appearance preference changed`)
  assert.equal(await page.locator("html").getAttribute("data-theme"), resolvedShellTheme(preference, system), `${prefix}Resolved appearance changed`)
}

export interface ShellSystemPaint {
  readonly bodyColor: string
  readonly elements: readonly Pick<ShellElement, "key" | "rect" | "styles">[]
}
/** Serialized native observer, shared by current and baseline. Settlement is
 * independent of palette validity: stable wrong paint reaches the unchanged
 * inequality/parity assertions. No expected color is supplied to this function. */
export async function settleShellSystemPaint(element: Element, options: {
  readonly label: string; readonly system: ShellCase["system"]
}): Promise<ShellSystemPaint> {
  const label = options.label.slice(0, 192), { system } = options
  const document = element.ownerDocument, view = document.defaultView
  if (view === null) throw new Error(`${label}: System paint document has no native window`)
  const html = document.documentElement, body = document.body
  const menus = document.querySelectorAll("[data-hraness-appearance-menu]")
  if (element !== html || body === null || menus.length !== 1 || (system !== "light" && system !== "dark")) {
    throw new Error(`${label}: System paint owners or media setting are invalid`)
  }
  const menu = menus[0]!, media = view.matchMedia("(prefers-color-scheme: dark)")
  const properties = ["color", "background-color", "color-scheme", "--paper", "--ink", "--ui-background", "--ui-foreground"]
  const started = view.performance.now(), deadline = started + 1_000
  return new Promise((resolve, reject) => {
    let frame: number | undefined, timer: number | undefined, ended = false, lastTime = started
    let previous: string | undefined, last: unknown = null
    const failure = (message: string) => new Error(`${label}: ${message}; last native paint ${JSON.stringify(last).slice(0, 4_096)}`)
    const finish = (error?: unknown, value?: ShellSystemPaint) => {
      if (ended) return
      ended = true
      if (frame !== undefined) view.cancelAnimationFrame(frame)
      if (timer !== undefined) view.clearTimeout(timer)
      observer.disconnect()
      media.removeEventListener("change", mediaChanged)
      if (error !== undefined) reject(error)
      else resolve(value!)
    }
    const checkDeadline = () => {
      const now = view.performance.now()
      if (!Number.isFinite(started) || !Number.isFinite(now) || now < lastTime || now >= deadline) {
        throw failure("System paint settlement exceeded its 1000ms local deadline")
      }
      lastTime = now
    }
    const semantics = () => {
      const state = { dark: media.matches, preference: menu.getAttribute("data-theme-value"), resolved: html.getAttribute("data-theme") }
      last = { ...state, preference: state.preference?.slice(0, 128), resolved: state.resolved?.slice(0, 128) }
      if (html !== document.documentElement || body !== document.body || document.querySelectorAll("[data-hraness-appearance-menu]").length !== 1
        || document.querySelector("[data-hraness-appearance-menu]") !== menu
        || [html, body, menu].some(owner => !owner.isConnected || owner.ownerDocument !== document)) {
        throw failure("System paint owners changed")
      }
      if (state.dark !== (system === "dark") || state.preference !== "system" || state.resolved !== system) {
        throw failure("System paint media, preference or resolved appearance changed")
      }
      return state
    }
    // Observe losses between RAF samples as well, including loss and regain in
    // one task. Rewriting the same correct attribute remains harmless.
    const mutations = (records: readonly MutationRecord[]) => {
      for (const record of records) {
        const expected = record.target === html ? system : "system"
        if (record.oldValue !== expected) throw failure("System paint appearance changed between native samples")
      }
      semantics()
    }
    const observer = new view.MutationObserver(records => {
      try { checkDeadline(); mutations(records) } catch (error) { finish(error) }
    })
    const mediaChanged = (event: MediaQueryListEvent) => {
      try {
        checkDeadline()
        if (event.matches !== (system === "dark")) throw failure("System paint media changed between native samples")
        semantics()
      } catch (error) { finish(error) }
    }
    const read = () => {
      checkDeadline()
      mutations(observer.takeRecords())
      const state = semantics(), samples: unknown[] = []
      last = { ...state, elements: samples }
      let active = false
      const elements = [html, body].map((owner, index) => {
        // Discover the actual style/layout change before asking whether its
        // native transitions have finished. Font readiness alone cannot do so.
        const bounds = owner.getBoundingClientRect(), style = view.getComputedStyle(owner)
        const rect = [bounds.x, bounds.y, bounds.width, bounds.height]
        if (!rect.every(Number.isFinite)) throw failure("System paint geometry is invalid")
        const styles = Object.fromEntries(properties.map(property => [property, style.getPropertyValue(property)]))
        if (Object.values(styles).some(value => value.length > 256)) throw failure("System paint value exceeds its bound")
        const animations = owner.getAnimations()
        samples.push({ key: index === 0 ? "html" : "body", rect, styles, animationCount: animations.length,
          animations: animations.slice(0, 8).map(animation => ({ state: animation.playState, pending: animation.pending, rate: animation.playbackRate })) })
        if (animations.length > 64) throw failure("System paint animation inventory exceeds its bound")
        for (const animation of animations) {
          const effect = animation.effect
          if (effect === null || !("target" in effect) || effect.target !== owner) throw failure("System paint animation has no exact element owner")
          const timing = effect.getComputedTiming()
          if (typeof timing.endTime !== "number" || !Number.isFinite(timing.endTime) || timing.endTime < 0
            || typeof timing.duration !== "number" || !Number.isFinite(timing.duration) || timing.duration < 0
            || typeof timing.iterations !== "number" || !Number.isFinite(timing.iterations) || timing.iterations < 0
            || animation.playState === "paused" || !Number.isFinite(animation.playbackRate) || animation.playbackRate === 0) {
            throw failure("System paint animation must be finite and unpaused")
          }
          active ||= animation.pending || animation.playState === "running"
        }
        return { key: index === 0 ? "html" : "body", rect, styles }
      })
      checkDeadline()
      return { active, bodyColor: elements[1]!.styles.color!, elements }
    }
    const observe = () => {
      try {
        const { active, ...value } = read(), observed = JSON.stringify(value)
        checkDeadline()
        if (!active && previous === observed) { finish(undefined, value); return }
        previous = active ? undefined : observed
        frame = view.requestAnimationFrame(observe)
      } catch (error) { finish(error) }
    }
    try {
      observer.observe(html, { attributes: true, attributeFilter: ["data-theme"], attributeOldValue: true })
      observer.observe(menu, { attributes: true, attributeFilter: ["data-theme-value"], attributeOldValue: true })
      media.addEventListener("change", mediaChanged)
      timer = view.setTimeout(() => finish(failure("System paint settlement exceeded its 1000ms local deadline")), 1_000)
      read() // Immediate semantic/animation checks are not a settled RAF sample.
      frame = view.requestAnimationFrame(observe)
    } catch (error) { finish(error) }
  })
}

export function assertShellSystemPaintChanged(alternate: ShellSystemPaint, restored: ShellSystemPaint, label: string): void {
  assert.notEqual(restored.bodyColor, alternate.bodyColor,
    `${label.slice(0, 192)}: System appearance did not follow the native media setting; alternate/restored native paint ${JSON.stringify({ alternate, restored }).slice(0, 8_192)}`)
}
async function chooseAppearance(page: Page, value: ShellCase["theme"], system: ShellCase["system"]): Promise<void> {
  const trigger = page.locator("[data-hraness-appearance-menu] button")
  await trigger.click()
  await page.keyboard.press("Home")
  for (let index = 0; index < ["light", "dark", "system"].indexOf(value); index++) await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Enter")
  assert.equal(await trigger.getAttribute("aria-expanded"), "false")
  await assertAppearancePreference(page, value, system)
  assert.equal(await trigger.getAttribute("aria-label"), `Appearance: ${value[0]!.toUpperCase()}${value.slice(1)}`)
}

/** Exercise the installed controller's native opening, wrapping, Home/End,
 * Escape, focus return and selection behavior while each actual popover and
 * item is visible. Selection preserves the scenario's preference. */
async function checkOpenAppearance(page: Page, scenario: ShellCase): Promise<ShellAppearanceEvidence[]> {
  const trigger = page.locator(appearanceTrigger)
  const evidence: ShellAppearanceEvidence[] = []
  const assertClosed = async () => {
    assert.equal(await trigger.getAttribute("aria-expanded"), "false")
    assert.equal(await page.locator(appearancePopover).evaluate(element => (element as HTMLElement).hidden), true)
    assert.equal(await trigger.evaluate(element => document.activeElement === element), true, "Appearance close did not return native focus")
    await assertAppearancePreference(page, scenario.theme, scenario.system)
  }
  await assertClosed()
  for (const step of shellAppearanceSteps) {
    if (step.name === "arrow-up-opens-last") {
      await page.keyboard.press("Escape")
      await assertClosed()
    }
    await page.keyboard.press(step.key)
    await settle(page)
    const semantics = await page.locator(appearanceRoot).evaluate(root => {
      const trigger = root.querySelector("button")!, menu = root.querySelector('[role="menu"]')!
      const popover = root.querySelector<HTMLElement>(".hraness-design-theme-toggle__popover")!
      return { expanded: trigger.getAttribute("aria-expanded"), hasPopup: trigger.getAttribute("aria-haspopup"),
        ownsMenu: trigger.getAttribute("aria-controls") === menu.id, menuLabel: menu.getAttribute("aria-label"),
        hidden: popover.hidden, direction: getComputedStyle(root).direction,
        active: document.activeElement?.getAttribute("data-theme-value") ?? null,
        focusVisible: document.activeElement?.matches(":focus-visible") ?? false,
        items: [...menu.querySelectorAll('[role="menuitemradio"]')].map(item => ({
          value: item.getAttribute("data-theme-value"), checked: item.getAttribute("aria-checked"),
          selected: item.hasAttribute("data-selected"), tabindex: item.getAttribute("tabindex"),
        })) }
    })
    assert.deepEqual(semantics, { expanded: "true", hasPopup: "menu", ownsMenu: true, menuLabel: "Appearance", hidden: false,
      direction: scenario.direction ?? "ltr", active: step.active, focusVisible: true,
      items: ["light", "dark", "system"].map(value => ({ value, checked: String(value === scenario.theme),
        selected: value === scenario.theme, tabindex: "-1" })) }, `${scenario.name}: native appearance ${step.name}`)
    const label = `${scenario.name} appearance ${step.name}`
    const settled = await page.locator(appearanceRoot).evaluate(settleShellAppearancePaint,
      { label, active: step.active, preference: scenario.theme, properties })
    const elements = await measure(page, appearanceSelectors)
    assertShellFocusUnchanged(settled, elements, label)
    for (const element of elements) {
      assert.ok(element.rect[2]! > 0 && element.rect[3]! > 0 && element.styles.display !== "none" && element.styles.visibility === "visible",
        `${scenario.name} ${element.key}: open appearance landmark not visible`)
      assert.ok(element.rect[0]! >= -0.5 && element.rect[0]! + element.rect[2]! <= scenario.width + 0.5,
        `${scenario.name} ${element.key}: open appearance horizontal clipping`)
    }
    const focused = page.locator(`${appearanceItems}[data-theme-value="${step.active}"]`)
    assert.equal(await focused.evaluate(element => {
      const rect = element.getBoundingClientRect(), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return rect.top >= 0 && rect.bottom <= innerHeight && hit !== null && (hit === element || element.contains(hit))
    }), true, `${scenario.name}: open appearance focus is covered or clipped`)
    evidence.push({ step: step.name, active: step.active, elements })
  }
  await page.keyboard.press("Home")
  for (let index = 0; index < ["light", "dark", "system"].indexOf(scenario.theme); index++) await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Enter")
  await assertClosed()
  return evidence
}

/** Native actions stay on local skip, appearance and recovery controls. All
 * remote links are inspected or hovered, never activated. */
export async function denyShellWebSocket(socket: WebSocketRoute, error: (message: string) => void): Promise<void> {
  error(`Unadmitted socket ${socket.url()}`)
  await socket.close({ code: 1008, reason: "Ordinary static verification admits no sockets" })
}

export interface ShellFocusSettlement {
  readonly elements: readonly Pick<ShellElement, "key" | "rect" | "styles">[]
  readonly scrollY: number
}
/** Observe the real open-menu paint, not a desired palette. The shared reset's
 * reduced-motion duration also applies to the items' default transition: all;
 * fonts plus RAFs alone do not flush or finish those native focus transitions. */
export async function settleShellAppearancePaint(root: Element, options: {
  readonly label: string; readonly active: "light" | "dark" | "system"
  readonly preference: ShellCase["theme"]; readonly properties: readonly string[]
}): Promise<ShellFocusSettlement> {
  const { label, active, preference, properties } = options
  const document = root.ownerDocument, view = document.defaultView
  if (view === null) throw new Error(`${label}: appearance document has no native window`)
  const base = "[data-hraness-appearance-menu]", items = `${base} [role="menuitemradio"]`
  const selectors = [base, `${base} button`, `${base} .hraness-design-theme-toggle__popover`, `${base} [role="menu"]`,
    items, `${items} .hraness-appearance-icon`, `${items} .hraness-appearance-icon svg`]
  const attributes = ["class", "hidden", "role", "tabindex", "aria-expanded", "aria-controls", "aria-checked", "data-ready",
    "data-theme-value", "data-selected", "data-focused", "data-hovered"]
  const capture = () => selectors.flatMap((selector, index) => {
    const found = [...document.querySelectorAll(selector)]
    if (found.length !== (index < 4 ? 1 : 3)) throw new Error(`${label}: appearance owner inventory changed`)
    return found.map((owner, offset) => ({ owner, key: `${selector}[${offset}]` }))
  })
  const owners = capture(), html = document.documentElement
  const focused = owners[4 + ["light", "dark", "system"].indexOf(active)]?.owner
  if (owners[0]?.owner !== root || focused === undefined || !["light", "dark", "system"].includes(preference)
    || properties.length > 256 || new Set(properties).size !== properties.length
    || !["background-color", "outline-style", "outline-width", "outline-color", "outline-offset"].every(property => properties.includes(property))) {
    throw new Error(`${label}: incomplete appearance owner or paint inventory`)
  }
  const originalAttributes = new Map(owners.map(({ owner }) => [owner,
    new Map(attributes.map(attribute => [attribute, owner.getAttribute(attribute)]))]))
  originalAttributes.set(html, new Map([["data-theme", html.getAttribute("data-theme")]]))
  const started = view.performance.now(), deadline = started + 1_000
  return new Promise((resolve, reject) => {
    let frame: number | undefined, timer: number | undefined, ended = false, previous: string | undefined, lastTime = started
    const failure = (message: string) => new Error(`${label}: appearance ${message}`)
    const finish = (error?: unknown, value?: ShellFocusSettlement) => {
      if (ended) return
      ended = true
      if (frame !== undefined) view.cancelAnimationFrame(frame)
      if (timer !== undefined) view.clearTimeout(timer)
      observer.disconnect(); focused.removeEventListener("blur", lostFocus)
      if (error !== undefined) reject(error)
      else resolve(value!)
    }
    const lostFocus = () => finish(failure("lost native focus during settlement"))
    const checkDeadline = () => {
      const now = view.performance.now()
      if (!Number.isFinite(started) || !Number.isFinite(now) || now < lastTime || now >= deadline) {
        throw failure("settlement exceeded its 1000ms local deadline")
      }
      lastTime = now
    }
    const semantics = () => {
      const current = capture()
      if (document.documentElement !== html || current.some(({ owner }, index) => owner !== owners[index]!.owner
        || !owner.isConnected || owner.ownerDocument !== document)) throw failure("owners changed")
      if (document.activeElement !== focused || !focused.matches(":focus") || !focused.matches(":focus-visible")
        || focused.getAttribute("data-theme-value") !== active || root.getAttribute("data-theme-value") !== preference
        || root.getAttribute("data-ready") !== "true" || owners[1]!.owner.getAttribute("aria-expanded") !== "true"
        || owners[2]!.owner.hasAttribute("hidden")) throw failure("open-menu focus or preference changed")
      for (const [owner, expected] of originalAttributes) for (const [attribute, value] of expected) {
        if (owner.getAttribute(attribute) !== value) throw failure("semantics changed")
      }
    }
    const mutations = (records: readonly MutationRecord[]) => {
      for (const record of records) {
        const expected = originalAttributes.get(record.target as Element)
        if (record.type !== "attributes" || record.attributeName === null || expected === undefined
          || !expected.has(record.attributeName) || expected.get(record.attributeName) !== record.oldValue) {
          throw failure("owners or semantics changed between native samples")
        }
      }
      semantics()
    }
    const observer = new view.MutationObserver(records => {
      try { checkDeadline(); mutations(records) } catch (error) { finish(error) }
    })
    const read = () => {
      checkDeadline(); mutations(observer.takeRecords())
      const scrollY = view.scrollY
      if (!Number.isFinite(scrollY)) throw failure("geometry is invalid")
      let animating = false
      const elements = owners.map(({ owner, key }) => {
        // Style/layout must be flushed before getAnimations: opening a hidden
        // popover can defer discovery of the focus transition until that flush.
        const bounds = owner.getBoundingClientRect(), style = view.getComputedStyle(owner)
        const rect = [bounds.x, bounds.y, bounds.width, bounds.height]
        const styles = Object.fromEntries(properties.map(property => [property, style.getPropertyValue(property)]))
        if (!rect.every(Number.isFinite) || Object.values(styles).some(value => value.length > 4_096)) throw failure("paint or geometry is invalid")
        const animations = owner.getAnimations()
        if (animations.length > 64) throw failure("animation inventory exceeds its bound")
        for (const animation of animations) {
          const effect = animation.effect
          if (effect === null || !("target" in effect) || effect.target !== owner) throw failure("animation has no exact element owner")
          const timing = effect.getComputedTiming()
          if (typeof timing.endTime !== "number" || !Number.isFinite(timing.endTime) || timing.endTime < 0
            || typeof timing.duration !== "number" || !Number.isFinite(timing.duration) || timing.duration < 0
            || typeof timing.iterations !== "number" || !Number.isFinite(timing.iterations) || timing.iterations < 0
            || animation.playState === "paused" || !Number.isFinite(animation.playbackRate) || animation.playbackRate === 0) {
            throw failure("animation must be finite and unpaused")
          }
          animating ||= animation.pending || animation.playState === "running"
        }
        return { key, rect, styles }
      })
      checkDeadline()
      return { elements, scrollY, animating }
    }
    const observe = () => {
      try {
        const { animating, ...value } = read(), current = JSON.stringify(value)
        if (!animating && previous === current) { finish(undefined, value); return }
        previous = animating ? undefined : current
        frame = view.requestAnimationFrame(observe)
      } catch (error) { finish(error) }
    }
    try {
      observer.observe(root, { subtree: true, attributes: true, attributeFilter: attributes, attributeOldValue: true, childList: true })
      observer.observe(html, { attributes: true, attributeFilter: ["data-theme"], attributeOldValue: true })
      focused.addEventListener("blur", lostFocus)
      timer = view.setTimeout(() => finish(failure("settlement exceeded its 1000ms local deadline")), 1_000)
      read() // Immediate checks are not a stable animation-frame sample.
      frame = view.requestAnimationFrame(observe)
    } catch (error) { finish(error) }
  })
}
/** This serialized observer has no module dependencies. It samples actual
 * geometry and paint, never desired visibility or baseline values. A stable
 * wrong result must reach the authoritative reveal/parity assertions unchanged. */
export async function settleShellFocusState(element: Element, options: {
  readonly label: string; readonly focus: "skip" | "main"; readonly properties: readonly string[]
}): Promise<ShellFocusSettlement> {
  const { label, focus, properties } = options
  const document = element.ownerDocument, view = document.defaultView
  if (view === null) throw new Error(`${label}: skip document has no native window`)
  const skip = document.querySelectorAll(".skip-link"), main = document.querySelectorAll("#main")
  if (skip.length !== 1 || main.length !== 1 || skip[0] === main[0]
    || element !== (focus === "skip" ? skip[0] : main[0])) throw new Error(`${label}: native focus owners changed`)
  const owners = focus === "skip" ? [skip[0]!] : [skip[0]!, main[0]!]
  if (properties.length > 256 || new Set(properties).size !== properties.length
    || !["transform", "outline-style", "outline-width", "outline-color", "outline-offset"].every(property => properties.includes(property))) {
    throw new Error(`${label}: incomplete native focus paint inventory`)
  }
  const started = view.performance.now(), deadline = started + 1_000
  return new Promise((resolve, reject) => {
    let frame: number | undefined, timer: number | undefined, ended = false, lastTime = started
    let previous: string | undefined
    const finish = (error?: unknown, value?: ShellFocusSettlement) => {
      if (ended) return
      ended = true
      if (frame !== undefined) view.cancelAnimationFrame(frame)
      if (timer !== undefined) view.clearTimeout(timer)
      element.removeEventListener("blur", lostFocus)
      if (focus === "main") skip[0]!.removeEventListener("focus", lostFocus)
      if (error !== undefined) reject(error)
      else resolve(value!)
    }
    // Blur is sticky, including loss and regain between two animation frames.
    const lostFocus = () => finish(new Error(`${label}: ${focus} lost native focus during settlement`))
    const checkDeadline = () => {
      const now = view.performance.now()
      if (!Number.isFinite(started) || !Number.isFinite(now) || now < lastTime || now >= deadline) {
        throw new Error(`${label}: ${focus} settlement exceeded its 1000ms local deadline`)
      }
      lastTime = now
    }
    const read = () => {
      checkDeadline()
      if (owners.some(owner => !owner.isConnected || owner.ownerDocument !== document)
        || document.querySelectorAll(".skip-link").length !== 1 || document.querySelector(".skip-link") !== skip[0]
        || document.querySelectorAll("#main").length !== 1 || document.querySelector("#main") !== main[0]) {
        throw new Error(`${label}: native focus owners changed`)
      }
      if (document.activeElement !== element || !element.matches(":focus") || (focus === "skip"
        ? !element.matches(":focus-visible") : skip[0]!.matches(":focus") || skip[0]!.matches(":focus-visible"))) {
        throw new Error(`${label}: ${focus === "skip" ? "skip requires continuous native focus and focus-visible"
          : "main requires continuous native focus and skip-not-focused"}`)
      }
      const scrollY = view.scrollY
      if (!Number.isFinite(scrollY)) throw new Error(`${label}: invalid ${focus} geometry`)
      let active = false
      const elements = owners.map((owner, index) => {
        // Flush each exact owner's style/layout before observing its animations.
        const bounds = owner.getBoundingClientRect(), style = view.getComputedStyle(owner)
        const rect = [bounds.x, bounds.y, bounds.width, bounds.height]
        if (!rect.every(Number.isFinite)) throw new Error(`${label}: invalid ${focus} geometry`)
        const styles = Object.fromEntries(properties.map(property => [property, style.getPropertyValue(property)]))
        for (const animation of owner.getAnimations()) {
          const effect = animation.effect
          if (effect === null || !("target" in effect) || effect.target !== owner) {
            throw new Error(`${label}: ${focus} animation has no exact element owner`)
          }
          const timing = effect.getComputedTiming()
          if (typeof timing.endTime !== "number" || !Number.isFinite(timing.endTime) || timing.endTime < 0
            || typeof timing.duration !== "number" || !Number.isFinite(timing.duration) || timing.duration < 0
            || typeof timing.iterations !== "number" || !Number.isFinite(timing.iterations) || timing.iterations < 0
            || animation.playState === "paused"
            || !Number.isFinite(animation.playbackRate) || animation.playbackRate === 0) {
            throw new Error(`${label}: ${focus} animation must be finite and unpaused`)
          }
          active ||= animation.pending || animation.playState === "running"
        }
        return { key: index === 0 ? ".skip-link[0]" : "#main[0]", rect, styles }
      })
      checkDeadline() // A late synchronous style/layout read cannot win the timer race.
      return { elements, scrollY, active }
    }
    const observe = () => {
      try {
        const { active, ...value } = read(), observed = JSON.stringify(value)
        checkDeadline()
        if (!active && previous === observed) {
          finish(undefined, value)
          return
        }
        previous = active ? undefined : observed
        frame = view.requestAnimationFrame(observe)
      } catch (error) { finish(error) }
    }
    element.addEventListener("blur", lostFocus)
    if (focus === "main") skip[0]!.addEventListener("focus", lostFocus)
    timer = view.setTimeout(() => finish(new Error(`${label}: ${focus} settlement exceeded its 1000ms local deadline`)), 1_000)
    try {
      read() // Immediate focus/animation checks do not count as a settled RAF.
      frame = view.requestAnimationFrame(observe)
    } catch (error) { finish(error) }
  })
}

export function assertShellFocusUnchanged(settled: ShellFocusSettlement, evidence: readonly ShellElement[], label: string): void {
  for (const owner of settled.elements) {
    const matches = evidence.filter(item => item.key === owner.key)
    assert.equal(matches.length, 1, `${label}: settled focus owner inventory changed`)
    const actual = matches[0]!
    assert.deepEqual(actual.rect, [owner.rect[0], owner.rect[1]! + settled.scrollY, ...owner.rect.slice(2)],
      `${label}: ${owner.key} geometry changed after settlement`)
    assert.deepEqual(actual.styles, owner.styles, `${label}: ${owner.key} paint changed after settlement`)
  }
}

/** A failed settled sample remains red even if a later diagnostic frame changes. */
export async function assertShellSkipReveal(rect: readonly number[], label: string, diagnostic: () => Promise<unknown>): Promise<void> {
  if (rect[0]! >= 0 && rect[1]! >= 0 && rect[2]! > 0) return
  assert.fail(`${label}: focused skip link is clipped ${JSON.stringify({ rect, diagnostic: await diagnostic() })}`)
}

async function skipRevealDiagnostic(page: Page): Promise<unknown> {
  const sample = () => page.locator(".skip-link").evaluate(element => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element)
    return { rect: [rect.x, rect.y, rect.width, rect.height], focused: document.activeElement === element,
      focus: element.matches(":focus"), focusVisible: element.matches(":focus-visible"),
      transform: style.transform, top: style.top, left: style.left,
      transitionProperty: style.transitionProperty, transitionDuration: style.transitionDuration,
      transitionDelay: style.transitionDelay, animationCount: element.getAnimations().length }
  })
  const before = await sample()
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  return { before, afterTwoFrames: await sample() }
}

export interface ShellFocusFragment {
  readonly rect: readonly [number, number, number, number]
  readonly owned: boolean
}
/** Serialized synchronous observer: an inline union can include an empty gap
 * between lines. Require hit ownership at every real fragment's center, never
 * search for one convenient successful point or change paint to satisfy it. */
export function shellFocusFragments(element: Element): ShellFocusFragment[] {
  const document = element.ownerDocument
  if (!element.isConnected || document.activeElement !== element || !element.matches(":focus-visible")) {
    throw new Error("Native focused target lost focus or ownership")
  }
  const rectangles = [...element.getClientRects()]
  if (rectangles.length === 0 || rectangles.length > 128) throw new Error("Invalid focused fragment count")
  const fragments: ShellFocusFragment[] = []
  for (const rect of rectangles) {
    const values = [rect.x, rect.y, rect.width, rect.height] as const
    if (!values.every(Number.isFinite) || rect.width < 0 || rect.height < 0) throw new Error("Invalid focused fragment geometry")
    if (rect.width === 0 || rect.height === 0) continue
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    fragments.push({ rect: values, owned: hit !== null && (element === hit || element.contains(hit)) })
  }
  if (fragments.length === 0) throw new Error("Native focused target has no painted fragments")
  return fragments
}
export function assertShellFocusFragments(fragments: readonly ShellFocusFragment[], key: string): void {
  assert.ok(fragments.length > 0 && fragments.length <= 128, `Native focused target has no bounded fragments: ${key}`)
  for (const [index, fragment] of fragments.entries()) {
    assert.ok(fragment.rect.length === 4 && fragment.rect.every(Number.isFinite) && fragment.rect[2] > 0 && fragment.rect[3] > 0)
    assert.equal(fragment.owned, true, `Native focused target is covered: ${key} fragment ${index} ${JSON.stringify(fragment.rect)}`)
  }
}

/** Response callbacks may admit more work while an earlier body is settling.
 * Drain to a fixed point under one deadline, then close admission synchronously.
 * Late work remains observed and fatal; it is never discarded as teardown noise. */
export function shellOperationTracker(error: (message: string) => void) {
  const pending = new Set<Promise<void>>()
  let sealed = false
  const track = (label: string, operation: Promise<unknown>): Promise<void> => {
    if (sealed) error(`Browser operation after settlement: ${label}`)
    const observed = operation.then(() => {}, failure => error(`${label}: ${String(failure)}`))
      .finally(() => pending.delete(observed))
    pending.add(observed)
    return observed
  }
  return {
    track,
    get size() { return pending.size },
    async settle(label: string, milliseconds = 5_000): Promise<void> {
      const deadline = performance.now() + milliseconds
      while (pending.size > 0) {
        const remaining = deadline - performance.now()
        assert.ok(remaining > 0, `${label} exceeded its absolute deadline`)
        await bounded(Promise.all([...pending]), label, remaining)
      }
    },
    seal() {
      assert.equal(sealed, false, "Browser operation admission already sealed")
      assert.equal(pending.size, 0, "Browser operations still pending at admission seal")
      sealed = true
    },
  }
}

export function shellContextLifecycle(error: (message: string) => void) {
  let intentionalContextClose = false
  return {
    beginContextClose() { intentionalContextClose = true },
    pageClosed() { if (!intentionalContextClose) error("Page closed before intentional context close") },
    // Closing a single case's context never owns whole-browser shutdown.
    browserDisconnected() { error("Browser disconnected during shell case ownership") },
  }
}

export async function checkShellCase(browser: Browser, payload: ShellPayload, scenario: ShellCase,
  source: "current" | "baseline", negative: boolean): Promise<ShellEvidence> {
  const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height },
    deviceScaleFactor: scenario.reflowEquivalent ? 2 : 1, colorScheme: scenario.system, forcedColors: scenario.forced,
    hasTouch: scenario.coarse, bypassCSP: false, serviceWorkers: "block", reducedMotion: "reduce" })
  context.setDefaultTimeout(5_000)
  const errors: string[] = [], received = new Set<string>()
  const error = (message: string) => { if (errors.length < 64) errors.push(message.slice(0, 512)) }
  const operations = shellOperationTracker(error), requests = new Map<Request, () => void>()
  const lifecycle = shellContextLifecycle(error)
  browser.on("disconnected", lifecycle.browserDisconnected)
  try {
    await context.routeWebSocket("**/*", socket => operations.track("WebSocket denial", denyShellWebSocket(socket, error)))
    await context.route("**/*", route => operations.track("Resource route", (async () => {
      const request = route.request(), url = new URL(request.url())
      if (request.method() !== "GET" || url.origin !== payload.origin || url.search !== "" || !payload.resources.includes(url.pathname)) {
        error(`Unadmitted request ${request.method()} ${url.origin}${url.pathname}`)
        await route.abort("blockedbyclient")
      } else await route.continue()
    })()))
    const page = await context.newPage()
    page.on("close", lifecycle.pageClosed)
    page.on("request", request => {
      const operation = new Promise<void>(resolve => { requests.set(request, resolve) })
      void operations.track(`Request ${new URL(request.url()).pathname}`, operation)
    })
    const finishRequest = (request: Request) => {
      const finish = requests.get(request)
      if (finish === undefined) error(`Unobserved request completion ${new URL(request.url()).pathname}`)
      else { requests.delete(request); finish() }
    }
    page.on("requestfinished", finishRequest)
    const settleCase = () => settle(page, scenario.direction)
    const focusedSkip = async (phase: "initial" | "reload") => {
      const label = `${source} ${scenario.name} ${phase}`
      const settled = await page.locator(".skip-link").evaluate(settleShellFocusState, { label, focus: "skip" as const, properties })
      await assertShellSkipReveal(settled.elements[0]!.rect, label, () => skipRevealDiagnostic(page))
      const evidence = (await measure(page, [".skip-link"]))[0]!
      assertShellFocusUnchanged(settled, [evidence], label)
      return evidence
    }
    const transferredFocus = (phase: "initial" | "reload") => page.locator("#main").evaluate(settleShellFocusState,
      { label: `${source} ${scenario.name} ${phase} transfer`, focus: "main" as const, properties })
    page.on("pageerror", failure => error(failure.message))
    page.on("console", message => {
      if (message.type() !== "error") return
      if (message.location().url === `${payload.origin}/404.html` && /^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/u.test(message.text())) return
      error(message.text())
    })
    page.on("requestfailed", request => { error(`Resource failure ${request.url()}`); finishRequest(request) })
    page.on("response", response => operations.track(`Response ${new URL(response.url()).pathname}`, (async () => {
      const path = new URL(response.url()).pathname
      received.add(path)
      assert.equal(response.status(), path === "/404.html" ? 404 : 200, `Resource status ${path}`)
      assert.equal(response.headers()["content-type"], shellContentType(path), `Resource type ${path}`)
      assert.equal(await response.finished(), null, `Resource body did not finish ${path}`)
    })()))
    const protocol = await context.newCDPSession(page)
    await protocol.send("Log.enable")
    protocol.on("Log.entryAdded", ({ entry }) => {
      // Chromium logs a genuine 404 document as a network error. Its exact
      // response status/body is separately required above; CSP remains fatal.
      if (entry.source === "network" && entry.url === `${payload.origin}/404.html` && entry.text.includes("404")) return
      if (entry.level === "error" || entry.source === "security") error(`${entry.source}: ${entry.text}`)
    })
    const response = await page.goto(`${payload.origin}${scenario.route}`, { waitUntil: "load" })
    assert.ok(response !== null)
    assert.equal(response.status(), scenario.route === "/404.html" ? 404 : 200)
    for (const [key, value] of Object.entries(siteShellHeaders)) assert.equal(response.headers()[key], value, `Production header ${key}`)
    assert.equal(page.frames().length, 1)
    await page.locator('[data-hraness-appearance-menu][data-ready="true"]').waitFor()
    await assertAppearancePreference(page, "system", scenario.system)
    await settleCase()
    await page.keyboard.press("Tab")
    await focusedSkip("initial")
    await page.keyboard.press("Enter")
    assert.equal(await page.locator("#main").evaluate(element => document.activeElement === element), true, "Native skip did not focus main")
    await transferredFocus("initial")
    await chooseAppearance(page, scenario.theme, scenario.system)
    if (scenario.theme === "system") {
      const alternate = scenario.system === "dark" ? "light" : "dark"
      const sampleSystemPaint = async (system: ShellCase["system"], phase: "alternate" | "restored") => {
        const label = `${source} ${scenario.name} System ${phase} ${system}`
        await page.emulateMedia({ colorScheme: system })
        await settleCase()
        await assertAppearancePreference(page, "system", system, label)
        return page.locator("html").evaluate(settleShellSystemPaint, { label, system })
      }
      const changed = await sampleSystemPaint(alternate, "alternate")
      const restored = await sampleSystemPaint(scenario.system, "restored")
      if (scenario.forced === "none") assertShellSystemPaintChanged(changed, restored, `${source} ${scenario.name} System alternate/restored`)
    }
    // Restore the exact route before reload: the preceding native skip adds a
    // fragment, whose browser focus restoration would otherwise start Tab at
    // main instead of the document's first keyboard control.
    await page.goto(`${payload.origin}${scenario.route}`, { waitUntil: "load" })
    await page.reload({ waitUntil: "load" })
    await settleCase()
    await assertAppearancePreference(page, scenario.theme, scenario.system)
    await page.keyboard.press("Tab")
    const skip = await focusedSkip("reload")
    await page.keyboard.press("Enter")
    assert.equal(await page.locator("#main").evaluate(element => document.activeElement === element), true)
    await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }))
    const transferred = await transferredFocus("reload")
    const media = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, coarse: matchMedia("(pointer: coarse)").matches,
      forced: matchMedia("(forced-colors: active)").matches, dark: matchMedia("(prefers-color-scheme: dark)").matches,
      direction: getComputedStyle(document.documentElement).direction,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 }))
    assert.deepEqual(media, { width: scenario.width, height: scenario.height, coarse: scenario.coarse,
      forced: scenario.forced === "active", dark: scenario.system === "dark", direction: scenario.direction ?? "ltr", overflow: false })
    const direction = media.direction
    assert.ok(direction === "ltr" || direction === "rtl")
    const selectors = [...commonSelectors, ...(scenario.route === "/" ? homeSelectors : recoverySelectors)]
    const dom = await page.evaluate(() => {
      const root = document.body.cloneNode(true) as HTMLElement
      for (const element of root.querySelectorAll("script")) element.remove()
      const migrated = ".skip-link, .topbar, .wordmark, .topbar-actions, .topbar nav[aria-label=\"Primary\"], .topbar nav[aria-label=\"Primary\"] a, .route-state, .route-state > h1, .route-state > p, .route-state a"
      for (const element of root.querySelectorAll(migrated)) {
        element.removeAttribute("class")
        // Only the exact migrated shell class attributes may differ. The
        // retained marketing, Ask AI, appearance and footer DOM stays exact.
      }
      return root.outerHTML
    })
    const elements = await measure(page, selectors)
    assertShellFocusUnchanged(transferred, elements, `${source} ${scenario.name} reload transfer`)
    const nav = elements.filter(item => item.key.startsWith('.topbar nav[aria-label="Primary"] a['))
    assert.equal(nav.length, scenario.route === "/" ? 5 : 2)
    assert.deepEqual(nav.map(item => item.styles.display === "none"), scenario.route === "/" && scenario.width <= 544
      ? [true, true, true, true, false] : nav.map(() => false))
    for (const item of elements) {
      if (item.key === "body[0]" || item.key === "#main[0]" || item.key.startsWith(".skip-link")
        || item.styles.display === "none" || item.styles.display === "contents" || item.rect[2] === 0) continue
      assert.ok(item.rect[0]! >= -0.5 && item.rect[0]! + item.rect[2]! <= scenario.width + 0.5,
        `${scenario.name} ${item.key}: horizontal clipping`)
    }
    // The skip action leaves main focused. Clear that state with a real native
    // header action before recording hover/focus states independently.
    await chooseAppearance(page, scenario.theme, scenario.system)
    const appearance = await checkOpenAppearance(page, scenario)
    const focus: ShellElement[] = [], hover: ShellElement[] = []
    // Detailed native state comparisons at every declared breakpoint in both
    // explicit themes, plus System, forced colors, coarse pointer and reflow.
    for (const selector of ['.topbar nav[aria-label="Primary"] a', ".hraness-site-footer__social-link",
      ...(scenario.route === "/" ? [".atet-ask-ai a"] : [".route-state a"])]) {
      const targets = page.locator(selector)
      for (let index = 0; index < await targets.count(); index++) {
        const target = targets.nth(index)
        if (!await target.isVisible()) continue
        await target.hover()
        await settleCase()
        hover.push(...await measure(page, [selector]))
      }
    }
    await page.mouse.move(scenario.width - 1, 1)
    await page.goto(`${payload.origin}${scenario.route}`, { waitUntil: "load" }); await settleCase()
    const total = await page.locator('a[href],button:not([disabled]),summary,[tabindex="0"]').count()
    assert.ok(total > 5 && total < 200)
    const seen = new Set<string>()
    for (let tab = 0; tab <= total + 2; tab++) {
      await page.keyboard.press("Tab")
      // Match the appearance-menu path: observe native focus after style/paint
      // settlement, never the pre-paint outline of the previously focused node.
      // Both current and baseline pages retain the same strict comparisons.
      await settleCase()
      const key = await page.evaluate(() => {
        const active = document.activeElement
        if (!(active instanceof HTMLElement)) return null
        if (active.matches(".skip-link")) return "skip"
        const selectors = ['.topbar a', '[data-hraness-appearance-menu] button', '.hraness-site-footer__brand',
          '.hraness-site-footer__social-link', '.atet-ask-ai a', '.route-state a']
        for (const selector of selectors) if (active.matches(selector)) return `${selector}|${[...document.querySelectorAll(selector)].indexOf(active)}`
        return null
      })
      if (key === "skip" && seen.size > 0) break
      if (key === null || key === "skip" || seen.has(key)) continue
      seen.add(key)
      const [selector, index] = key.split("|")
      const target = page.locator(selector!).nth(Number(index))
      assert.equal(await target.evaluate(element => element.matches(":focus-visible")), true, "Keyboard focus-visible missing")
      const box = await target.boundingBox()
      assert.ok(box !== null && box.y >= -0.5 && box.y + box.height <= scenario.height + 0.5, `Focused target not reachable: ${key}`)
      assertShellFocusFragments(await target.evaluate(shellFocusFragments), key)
      const measured = (await measure(page, [selector!]))[Number(index)]!
      assert.ok(measured.styles["outline-style"] !== "none" && Number.parseFloat(measured.styles["outline-width"]!) > 0,
        `Visible focus outline missing: ${key}`)
      focus.push(measured)
    }
    assert.equal(focus.filter(item => item.key.startsWith(".topbar a[")).length,
      nav.filter(item => item.styles.display !== "none").length + 1, "Header keyboard coverage incomplete")
    assert.equal(focus.filter(item => item.key.startsWith("[data-hraness-appearance-menu] button[")).length, 1,
      "Appearance keyboard coverage incomplete")
    assert.equal(focus.filter(item => item.key.startsWith(".hraness-site-footer__brand[")).length, 1)
    assert.equal(focus.filter(item => item.key.startsWith(".hraness-site-footer__social-link[")).length, 5, "Footer keyboard coverage incomplete")
    if (scenario.route === "/") assert.equal(focus.filter(item => item.key.startsWith(".atet-ask-ai a[")).length, 4)
    else assert.equal(focus.filter(item => item.key.startsWith(".route-state a[")).length, 5)
    await page.goto(`${payload.origin}${scenario.route}`, { waitUntil: "load" }); await settleCase()
    if (negative) {
      const original = await measure(page, [".topbar", ".wordmark", ...(scenario.route === "/404.html" ? [".route-state"] : [])])
      const sheet = await page.evaluateHandle(href => {
        const value = [...document.styleSheets].find(sheet => sheet.href === href)
        if (value === undefined || value.disabled) throw new Error("Active final CSS missing")
        value.disabled = true
        return value
      }, `${payload.origin}${payload.finalCss}`)
      try {
        await settleCase()
        const disabled = await measure(page, [".topbar", ".wordmark", ...(scenario.route === "/404.html" ? [".route-state"] : [])])
        assert.ok(disabled.some((item, index) => JSON.stringify(item.styles) !== JSON.stringify(original[index]!.styles)),
          "Final CSS removal did not change real computed styles")
      } finally {
        await sheet.evaluate(value => {
          if (!(value instanceof CSSStyleSheet) || ![...document.styleSheets].includes(value)) throw new Error("Lost final CSS identity")
          value.disabled = false
        })
        await sheet.dispose()
      }
      await settleCase()
      compareShellElements(await measure(page, [".topbar", ".wordmark", ...(scenario.route === "/404.html" ? [".route-state"] : [])]), original, "Restored final CSS")
    }
    let recovery = false
    if (scenario.route === "/404.html") {
      await page.locator('.route-state a[href="/"]').last().click()
      await page.waitForURL(`${payload.origin}/`)
      assert.equal(await page.locator("#page-title").count(), 1)
      await page.waitForLoadState("load")
      await settleCase()
      recovery = true
    }
    for (const stylesheet of payload.stylesheets) assert.ok(received.has(stylesheet), `Stylesheet never loaded: ${stylesheet}`)
    assert.ok([...received].filter(path => path.endsWith(".woff2")).length >= 2, "Font responses missing")
    await operations.settle("Request, route and response settlement")
    assert.deepEqual(errors, [], `${scenario.name}: network, script, console or CSP failure`)
    await protocol.detach()
    await operations.settle("Post-protocol browser operation settlement")
    assert.equal(page.isClosed(), false, "Page closed before evidence settlement")
    assert.equal(browser.isConnected(), true, "Browser disconnected before evidence settlement")
    assert.equal(requests.size, 0, "Requests still active at evidence settlement")
    assert.deepEqual(errors, [], `${scenario.name}: pre-close browser error`)
    operations.seal()
    return { direction, dom, elements, skip, hover, focus, recovery, appearance }
  } finally {
    lifecycle.beginContextClose()
    try {
      await bounded(context.close(), "Shell browser context close", 5_000)
      assert.equal(browser.isConnected(), true, "Context close disconnected the owned browser")
      await operations.settle("Final browser operation settlement")
      assert.equal(operations.size, 0)
      assert.equal(requests.size, 0)
      assert.deepEqual(errors, [], `${scenario.name}: late browser error`)
    } finally { browser.off("disconnected", lifecycle.browserDisconnected) }
  }
}
