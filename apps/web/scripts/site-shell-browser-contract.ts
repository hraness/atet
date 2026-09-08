import assert from "node:assert/strict"
import { isAbsolute } from "node:path"
import type { Browser, Page, WebSocketRoute } from "playwright-core"
import { bounded } from "./preview-browser-contract"

export const siteShellDeadlineMs = 720_000
export const siteShellBaselineRevision = "2104a004d3839e44c5985daf3ac7203e05c2f45a"
export const siteShellBaselineTree = "a6e50b09eebad9007f259c428883521556a483d7"
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
export function compareShellElements(actual: readonly ShellElement[], baseline: readonly ShellElement[], label: string): void {
  assert.equal(actual.length, baseline.length, `${label}: element inventory`)
  for (const [index, item] of actual.entries()) {
    const old = baseline[index]!
    assert.equal(item.key, old.key); assert.equal(item.text, old.text, `${label} ${item.key}: text`)
    assert.deepEqual(item.semantics, old.semantics, `${label} ${item.key}: semantics`)
    assert.deepEqual(item.styles, old.styles, `${label} ${item.key}: computed styles`)
    assert.equal(item.rect.length, 4)
    item.rect.forEach((axis, offset) => assert.ok(Number.isFinite(axis) && Number.isFinite(old.rect[offset])
      && Math.abs(axis - old.rect[offset]!) <= 0.5, `${label} ${item.key}: geometry ${offset}: ${old.rect[offset]} -> ${axis}`))
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
async function assertAppearancePreference(page: Page, preference: ShellCase["theme"], system: ShellCase["system"]): Promise<void> {
  assert.equal(await page.locator(appearanceRoot).getAttribute("data-theme-value"), preference, "Appearance preference changed")
  assert.equal(await page.locator("html").getAttribute("data-theme"), resolvedShellTheme(preference, system), "Resolved appearance changed")
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
    const elements = await measure(page, appearanceSelectors)
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

export async function checkShellCase(browser: Browser, payload: ShellPayload, scenario: ShellCase, negative: boolean): Promise<ShellEvidence> {
  const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height },
    deviceScaleFactor: scenario.reflowEquivalent ? 2 : 1, colorScheme: scenario.system, forcedColors: scenario.forced,
    hasTouch: scenario.coarse, bypassCSP: false, serviceWorkers: "block", reducedMotion: "reduce" })
  context.setDefaultTimeout(5_000)
  const errors: string[] = [], pending = new Set<Promise<unknown>>(), received = new Set<string>()
  const error = (message: string) => { if (errors.length < 64) errors.push(message.slice(0, 512)) }
  const track = (operation: Promise<unknown>) => {
    pending.add(operation)
    void operation.catch(failure => error(String(failure))).finally(() => pending.delete(operation))
  }
  try {
    await context.routeWebSocket("**/*", socket => denyShellWebSocket(socket, error))
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url())
      if (request.method() !== "GET" || url.origin !== payload.origin || url.search !== "" || !payload.resources.includes(url.pathname)) {
        error(`Unadmitted request ${request.method()} ${url.origin}${url.pathname}`)
        await route.abort("blockedbyclient")
      } else await route.continue()
    })
    const page = await context.newPage()
    const settleCase = () => settle(page, scenario.direction)
    page.on("pageerror", failure => error(failure.message))
    page.on("console", message => {
      if (message.type() !== "error") return
      if (message.location().url === `${payload.origin}/404.html` && /^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/u.test(message.text())) return
      error(message.text())
    })
    page.on("requestfailed", request => error(`Resource failure ${request.url()}`))
    page.on("response", response => track((async () => {
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
    assert.equal(await page.locator(".skip-link").evaluate(element => document.activeElement === element), true)
    let skip = (await measure(page, [".skip-link"]))[0]!
    assert.ok(skip.rect[0]! >= 0 && skip.rect[1]! >= 0 && skip.rect[2]! > 0)
    await page.keyboard.press("Enter")
    assert.equal(await page.locator("#main").evaluate(element => document.activeElement === element), true, "Native skip did not focus main")
    await chooseAppearance(page, scenario.theme, scenario.system)
    if (scenario.theme === "system") {
      const alternate = scenario.system === "dark" ? "light" : "dark"
      await page.emulateMedia({ colorScheme: alternate })
      await settleCase()
      await assertAppearancePreference(page, "system", alternate)
      const changed = await page.locator("body").evaluate(element => getComputedStyle(element).color)
      await page.emulateMedia({ colorScheme: scenario.system })
      await settleCase()
      await assertAppearancePreference(page, "system", scenario.system)
      if (scenario.forced === "none") assert.notEqual(await page.locator("body").evaluate(element => getComputedStyle(element).color), changed,
        "System appearance did not follow the native media setting")
    }
    // Restore the exact route before reload: the preceding native skip adds a
    // fragment, whose browser focus restoration would otherwise start Tab at
    // main instead of the document's first keyboard control.
    await page.goto(`${payload.origin}${scenario.route}`, { waitUntil: "load" })
    await page.reload({ waitUntil: "load" })
    await settleCase()
    await assertAppearancePreference(page, scenario.theme, scenario.system)
    await page.keyboard.press("Tab")
    assert.equal(await page.locator(".skip-link").evaluate(element => document.activeElement === element), true)
    skip = (await measure(page, [".skip-link"]))[0]!
    assert.ok(skip.rect[0]! >= 0 && skip.rect[1]! >= 0 && skip.rect[2]! > 0)
    await page.keyboard.press("Enter")
    assert.equal(await page.locator("#main").evaluate(element => document.activeElement === element), true)
    await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }))
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
      assert.equal(await target.evaluate(element => {
        const rect = element.getBoundingClientRect()
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
        return hit !== null && (element === hit || element.contains(hit))
      }), true, `Native focused target is covered: ${key}`)
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
      recovery = true
    }
    for (const stylesheet of payload.stylesheets) assert.ok(received.has(stylesheet), `Stylesheet never loaded: ${stylesheet}`)
    assert.ok([...received].filter(path => path.endsWith(".woff2")).length >= 2, "Font responses missing")
    await bounded(Promise.allSettled([...pending]), "Response listener settlement", 5_000)
    assert.deepEqual(errors, [], `${scenario.name}: network, script, console or CSP failure`)
    await protocol.detach()
    return { direction, dom, elements, skip, hover, focus, recovery, appearance }
  } finally {
    await bounded(context.close(), "Shell browser context close", 5_000)
    await bounded(Promise.allSettled([...pending]), "Final response listener settlement", 5_000)
    assert.equal(pending.size, 0)
    assert.deepEqual(errors, [], `${scenario.name}: late browser error`)
  }
}
