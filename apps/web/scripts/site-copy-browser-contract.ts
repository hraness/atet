import assert from "node:assert/strict"
import type { Browser, Page, Request } from "playwright-core"
import { bounded } from "./preview-browser-contract"
import { assertShellNode, chooseAppearance, compareShellElements, denyShellWebSocket, measure, settle,
  shellContentType, shellContextLifecycle, shellOperationTracker, shellRecord, siteShellHeaders, withShellCaseCleanup,
  type ShellCase, type ShellCaseFailure, type ShellElement, type ShellPayload, type ShellRequest } from "./site-shell-browser-contract"

export const siteCopyDeadlineMs = 180_000
export const siteCopyCases: readonly ShellCase[] = Object.freeze([544, 545].flatMap(width =>
  (["light", "dark"] as const).flatMap(theme => (["none", "active"] as const).map(forced => ({
    name: `copy-${width}-${theme}-${forced}`, route: "/" as const, width, height: 900, theme,
    system: theme === "light" ? "dark" as const : "light" as const, forced, coarse: false, reflowEquivalent: false,
  })))))
export const copySteps = Object.freeze(["idle-focus", "idle-hover", "copied-focus", "copied-hover", "reset",
  "fallback-success", "fallback-failed", "failed-hover", "fallback-throw", "recovered"])
export const copyNegativeControls = Object.freeze(["copy-stylesheet-disabled", "copy-focus-suppressed"])
const copySelectors = ["#install", ".install-note", ".cli-install", ".panel-label", ".install-commands",
  ".install-commands > li", ".install-commands > li > span", ".install-commands > li > code", ".panel-note", ".panel-note a",
  "[data-copy-command]", "[data-copy-command-value]", "[data-copy-command-button]", ".copy-command__note",
  ".copy-command__note > code", "[data-copy-command-status]"]
const buttonSelector = "[data-copy-command-button]"
const copyCounts = [1, 1, 1, 2, 1, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1]
export const copyElementKeys = copySelectors.flatMap((selector, index) => Array.from({ length: copyCounts[index] ?? 0 }, (_, item) => `${selector}[${item}]`))
export const copyProperties = ["font-style", "font-variant", "font-stretch", "text-decoration-thickness", "text-underline-offset",
  "clip", "clip-path", "list-style-type", "list-style-position", "list-style-image", "border-image-source", "border-image-slice",
  "border-image-width", "border-image-outset", "border-image-repeat"]
export const measureCopy = (page: Page, selectors: readonly string[] = copySelectors) => measure(page, selectors, copyProperties)
export interface CopyEvidence {
  readonly steps: readonly { name: string; elements: readonly ShellElement[] }[]
  readonly command: string
  readonly negativeControls: readonly string[]
  readonly ports: CopyPorts
}
export function compareCopyEvidence(current: CopyEvidence, baseline: CopyEvidence, label: string, negative = false): void {
  assert.equal(current.command, baseline.command)
  assert.deepEqual(current.negativeControls, negative ? copyNegativeControls : [])
  assert.deepEqual(baseline.negativeControls, [])
  for (const side of [current, baseline]) {
    assert.deepEqual(side.steps.map(step => step.name), copySteps)
    for (const step of side.steps) assert.deepEqual(step.elements.map(element => element.key), copyElementKeys)
  }
  for (const [index, step] of current.steps.entries()) {
    const old = baseline.steps[index]
    assert.ok(old !== undefined)
    compareShellElements(step.elements, old.elements, `${label} ${step.name}`)
  }
}
export function summarizeCopyCase(current: CopyEvidence, baseline: CopyEvidence, name: string) {
  return { name, command: current.command, steps: copySteps, elementsPerSample: copyElementKeys.length,
    current: current.ports, baseline: baseline.ports }
}
export function parseCopyPhase(value: unknown, sequence: 0 | 1 | 2, request: ShellRequest): Record<string, unknown> {
  assert.equal(request.scope, "install-copy")
  const phase = shellRecord(value), common = ["schemaVersion", "token", "sequence", "kind", "scope"]
  assert.deepEqual(Object.keys(phase).sort(), (sequence === 1 ? common : sequence === 0 ? [...common, "node", "playwright"]
    : [...common, "node", "playwright", "browser", "cases", "baselineCompared", "closed", "negativeControls", "observations"]).sort())
  assert.equal(phase.schemaVersion, 1); assert.equal(phase.token, request.token); assert.equal(phase.scope, "install-copy")
  assert.equal(phase.sequence, sequence); assert.equal(phase.kind, ["started", "connected", "result"][sequence])
  if (sequence !== 1) { assertShellNode({ node: String(phase.node) }); assert.equal(phase.playwright, "1.62.0") }
  if (sequence === 2) {
    assert.match(String(phase.browser), /^\d+\.\d+\.\d+\.\d+$/u)
    assert.deepEqual(phase.cases, siteCopyCases.map(item => item.name))
    assert.deepEqual(phase.negativeControls, copyNegativeControls)
    assert.equal(phase.baselineCompared, true); assert.equal(phase.closed, true)
    assert.ok(Array.isArray(phase.observations) && phase.observations.length === siteCopyCases.length)
    for (const [index, value] of phase.observations.entries()) {
      const observation = shellRecord(value)
      assert.deepEqual(Object.keys(observation).sort(), ["name", "command", "steps", "elementsPerSample", "current", "baseline"].sort())
      assert.equal(observation.name, siteCopyCases[index]?.name); assert.deepEqual(observation.steps, copySteps)
      assert.equal(observation.elementsPerSample, copyElementKeys.length)
      assert.ok(typeof observation.command === "string")
      assert.match(observation.command, /^npx skills add https:\/\/github\.com\/hraness\/atet\/tree\/v\d+\.\d+\.\d+ --skill atet$/u)
      assertCopyPorts(observation.current as CopyPorts, observation.command)
      assertCopyPorts(observation.baseline as CopyPorts, observation.command)
    }
  }
  return phase
}
export function parseCopyCaseFailure(value: unknown, request: Pick<ShellRequest, "token">): ShellCaseFailure {
  const failure = shellRecord(value)
  assert.deepEqual(Object.keys(failure).sort(), ["schemaVersion", "token", "scope", "accepted", "completed", "scenario", "stage", "comparedCases", "error"].sort())
  assert.equal(failure.schemaVersion, 1); assert.equal(failure.token, request.token); assert.equal(failure.scope, "install-copy")
  assert.equal(failure.accepted, false); assert.equal(failure.completed, false)
  assert.ok(["current", "baseline", "pair", "comparison"].includes(String(failure.stage)))
  assert.ok(Array.isArray(failure.comparedCases) && failure.comparedCases.length < siteCopyCases.length)
  assert.deepEqual(failure.comparedCases, siteCopyCases.slice(0, failure.comparedCases.length).map(item => item.name))
  assert.equal(failure.scenario, siteCopyCases[failure.comparedCases.length]?.name)
  assert.ok(typeof failure.error === "string" && failure.error.length > 0 && failure.error.length <= 2_048 && !/[\x00-\x1f]/u.test(failure.error))
  return failure as unknown as ShellCaseFailure
}
export function copyCaseFailure(request: Pick<ShellRequest, "token">, scenario: string, stage: ShellCaseFailure["stage"],
  comparedCases: readonly string[], error: unknown): ShellCaseFailure {
  return parseCopyCaseFailure({ schemaVersion: 1, token: request.token, scope: "install-copy", accepted: false, completed: false,
    scenario, stage, comparedCases, error: String(error).replace(/[\x00-\x1f]/gu, " ").slice(0, 2_048) || "Unknown failure" }, request)
}

interface CopyPorts {
  write: "success" | "reject"
  fallback: "success" | "failed" | "throw"
  writes: string[]
  fallbacks: { value: string; readonly: boolean; start: number; end: number; focused: boolean; offscreen: boolean }[]
  timers: { delay: number; started: number; fired: number | null; cancelled: boolean }[]
}
declare global { interface Window { __atetCopyProof: CopyPorts } }
/** Only fresh isolated fixture contexts receive these two ports. Neither calls
 * the real OS clipboard. Native textarea selection and the real timer remain. */
export function installCopyProofPorts(): void {
  const ports: CopyPorts = { write: "success", fallback: "success", writes: [], fallbacks: [], timers: [] }
  Object.defineProperty(window, "__atetCopyProof", { value: ports })
  Object.defineProperty(navigator, "clipboard", { value: Object.freeze({ writeText: async (value: string) => {
    if (ports.writes.length >= 16) throw new Error("Copy proof command bound")
    ports.writes.push(value)
    if (ports.write === "reject") throw new Error("Controlled clipboard denial")
  } }) })
  Object.defineProperty(document, "execCommand", { value: (command: string) => {
    if (command !== "copy" || ports.fallbacks.length >= 8) throw new Error("Unadmitted legacy command")
    const input = document.activeElement
    if (!(input instanceof HTMLTextAreaElement)) throw new Error("Legacy copy did not select its textarea")
    const box = input.getBoundingClientRect(), style = getComputedStyle(input)
    ports.fallbacks.push({ value: input.value, readonly: input.readOnly, start: input.selectionStart, end: input.selectionEnd,
      focused: document.activeElement === input, offscreen: box.right < 0 && style.position === "fixed" && style.opacity === "0" })
    if (ports.fallback === "throw") throw new Error("Controlled legacy failure")
    return ports.fallback === "success"
  } })
  const originalTimeout = window.setTimeout.bind(window), originalClear = window.clearTimeout.bind(window)
  const timers = new Map<number, CopyPorts["timers"][number]>()
  window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay !== 2_500) return originalTimeout(handler, delay, ...args)
    if (typeof handler !== "function" || ports.timers.length >= 8) throw new Error("Unadmitted copy timer")
    const item = { delay, started: performance.now(), fired: null as number | null, cancelled: false }
    ports.timers.push(item)
    const id = originalTimeout(() => { item.fired = performance.now(); timers.delete(id); handler(...args) }, delay)
    timers.set(id, item)
    return id
  }) as typeof window.setTimeout
  window.clearTimeout = ((id?: number) => { const timer = id === undefined ? undefined : timers.get(id); if (timer) timer.cancelled = true; originalClear(id) }) as typeof window.clearTimeout
}

async function copyState(page: Page, state: "idle" | "copied" | "failed"): Promise<void> {
  await page.waitForFunction(state => {
    const button = document.querySelector<HTMLButtonElement>("[data-copy-command-button]")
    return button !== null && !button.hidden && (button.dataset.copyState ?? "idle") === state
  }, state)
  const actual = await page.locator(buttonSelector).evaluate(button => ({ text: button.textContent, state: button.getAttribute("data-copy-state"),
    type: button.getAttribute("type"), described: button.getAttribute("aria-describedby"), label: button.getAttribute("aria-label"),
    status: document.querySelector("[data-copy-command-status]")?.textContent,
    live: document.querySelector("[data-copy-command-status]")?.getAttribute("aria-live"),
    atomic: document.querySelector("[data-copy-command-status]")?.getAttribute("aria-atomic"), textareas: document.querySelectorAll("textarea").length }))
  assert.deepEqual(actual, { text: state === "copied" ? "Copied" : "Copy", state: state === "idle" ? null : state, type: "button",
    described: "skill-install-copy-status", label: "Copy install command", status: state === "idle" ? "" : state === "copied"
      ? "Install command copied." : "Could not copy the command. Select it and copy it manually.", live: "polite", atomic: "true", textareas: 0 })
}
export function assertCopyPorts(ports: CopyPorts, command: string): void {
  assert.deepEqual(Object.keys(shellRecord(ports)).sort(), ["write", "fallback", "writes", "fallbacks", "timers"].sort())
  assert.equal(ports.write, "success"); assert.equal(ports.fallback, "throw")
  assert.deepEqual(ports.writes, Array.from({ length: 5 }, () => command))
  assert.deepEqual(ports.fallbacks, Array.from({ length: 3 }, () => ({ value: command, readonly: true, start: 0, end: command.length, focused: true, offscreen: true })))
  assert.equal(ports.timers.length, 3)
  for (const timer of ports.timers) {
    assert.deepEqual(Object.keys(shellRecord(timer)).sort(), ["delay", "started", "fired", "cancelled"].sort())
    assert.equal(timer.delay, 2_500)
    assert.ok(typeof timer.started === "number" && Number.isFinite(timer.started) && timer.started >= 0)
    assert.ok(timer.fired === null || (typeof timer.fired === "number" && Number.isFinite(timer.fired) && timer.fired >= timer.started))
    assert.equal(typeof timer.cancelled, "boolean")
  }
  const reset = ports.timers[0], cancelled = ports.timers[1], live = ports.timers[2]
  assert.ok(reset !== undefined && reset.fired !== null && Number.isFinite(reset.started) && reset.fired - reset.started >= 2_500 && !reset.cancelled)
  assert.ok(cancelled !== undefined && cancelled.fired === null && cancelled.cancelled)
  assert.ok(live !== undefined && live.fired === null && !live.cancelled)
}

export async function checkCopyCase(browser: Browser, payload: ShellPayload, scenario: ShellCase, negative: boolean): Promise<CopyEvidence> {
  const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height }, colorScheme: scenario.system,
    forcedColors: scenario.forced, bypassCSP: false, serviceWorkers: "block", reducedMotion: "reduce" })
  context.setDefaultTimeout(5_000)
  const errors: string[] = [], received = new Set<string>(), requests = new Map<Request, () => void>()
  const error = (value: string) => { if (errors.length < 64) errors.push(value.slice(0, 512)) }
  const operations = shellOperationTracker(error), lifecycle = shellContextLifecycle(error)
  browser.on("disconnected", lifecycle.browserDisconnected)
  return withShellCaseCleanup(async () => {
    await context.addInitScript(installCopyProofPorts)
    await context.routeWebSocket("**/*", socket => operations.track("Copy WebSocket denial", denyShellWebSocket(socket, error)))
    await context.route("**/*", route => operations.track("Copy resource route", (async () => {
      const request = route.request(), url = new URL(request.url())
      if (request.method() !== "GET" || url.origin !== payload.origin || url.search !== "" || !payload.resources.includes(url.pathname)) {
        error(`Unadmitted copy resource ${request.method()} ${url.origin}${url.pathname}`); await route.abort("blockedbyclient")
      } else await route.continue()
    })()))
    const page = await context.newPage()
    page.on("close", lifecycle.pageClosed)
    page.on("request", request => { void operations.track(`Copy request ${new URL(request.url()).pathname}`, new Promise<void>(resolve => requests.set(request, resolve))) })
    const finish = (request: Request) => { const resolve = requests.get(request); if (!resolve) error("Unknown copy resource completion"); else { requests.delete(request); resolve() } }
    page.on("requestfinished", finish)
    page.on("requestfailed", request => { error(`Failed copy resource ${new URL(request.url()).pathname}`); finish(request) })
    page.on("pageerror", failure => error(failure.message))
    page.on("console", message => { if (message.type() === "error") error(message.text()) })
    page.on("response", response => operations.track(`Copy response ${new URL(response.url()).pathname}`, (async () => {
      const path = new URL(response.url()).pathname; received.add(path)
      assert.equal(response.status(), 200); assert.equal(response.headers()["content-type"], shellContentType(path))
      assert.equal(await response.finished(), null)
    })()))
    const protocol = await context.newCDPSession(page)
    await protocol.send("Log.enable")
    protocol.on("Log.entryAdded", ({ entry }) => { if (entry.level === "error" || entry.source === "security") error(`${entry.source}: ${entry.text}`) })
    const response = await page.goto(payload.origin, { waitUntil: "load" })
    assert.ok(response !== null && response.status() === 200)
    for (const [key, value] of Object.entries(siteShellHeaders)) assert.equal(response.headers()[key], value)
    assert.equal(page.frames().length, 1)
    await page.locator('[data-hraness-appearance-menu][data-ready="true"]').waitFor()
    await chooseAppearance(page, scenario.theme, scenario.system)
    await copyState(page, "idle")
    const command = await page.locator("[data-copy-command-value]").innerText()
    assert.match(command, /^npx skills add https:\/\/github\.com\/hraness\/atet\/tree\/v\d+\.\d+\.\d+ --skill atet$/u)
    assert.deepEqual(await page.evaluate(() => ({ width: innerWidth, forced: matchMedia("(forced-colors: active)").matches,
      theme: document.documentElement.dataset.theme })), { width: scenario.width, forced: scenario.forced === "active", theme: scenario.theme })
    const button = page.locator(buttonSelector), steps: { name: string; elements: ShellElement[] }[] = []
    const sample = async (name: string) => { await settle(page); steps.push({ name, elements: await measureCopy(page) }) }
    await button.scrollIntoViewIfNeeded()
    // Shift+Tab from the native appearance trigger reaches the preceding public
    // link, so walk forward using actual Tab events to the sole copy button.
    for (let index = 0; index < 40 && !await button.evaluate(element => document.activeElement === element); index++) await page.keyboard.press("Tab")
    assert.equal(await button.evaluate(element => document.activeElement === element && element.matches(":focus-visible")), true)
    await sample("idle-focus")
    await button.hover(); await sample("idle-hover")
    await page.mouse.move(0, 0)
    await page.keyboard.press("Enter"); await copyState(page, "copied"); await sample("copied-focus")
    await button.hover(); await sample("copied-hover")
    await copyState(page, "idle"); await sample("reset")
    await page.evaluate(() => { window.__atetCopyProof.write = "reject" })
    await button.click(); await copyState(page, "copied"); await sample("fallback-success")
    await page.evaluate(() => { window.__atetCopyProof.fallback = "failed" })
    await button.click(); await copyState(page, "failed"); await page.mouse.move(0, 0); await sample("fallback-failed")
    await button.hover(); await sample("failed-hover")
    await page.evaluate(() => { window.__atetCopyProof.fallback = "throw" })
    await button.click()
    await page.waitForFunction(() => window.__atetCopyProof.fallbacks.length === 3)
    await copyState(page, "failed"); await sample("fallback-throw")
    await page.evaluate(() => { window.__atetCopyProof.write = "success" })
    await button.click(); await copyState(page, "copied"); await sample("recovered")
    const ports = await page.evaluate(() => window.__atetCopyProof)
    assertCopyPorts(ports, command)
    const controls: string[] = []
    if (negative) {
      // Let the final real success reset finish before adversarial paint
      // controls; a live timer must not contaminate their exact restore proof.
      await copyState(page, "idle"); await settle(page)
      const before = await measureCopy(page)
      await page.evaluate(path => {
        const sheet = [...document.styleSheets].find(sheet => sheet.href === `${location.origin}${path}`)
        if (!sheet) throw new Error("Missing copy final stylesheet")
        sheet.disabled = true
      }, payload.finalCss)
      await settle(page)
      const disabled = await measureCopy(page)
      assert.throws(() => compareShellElements(disabled, before, "Copy stylesheet negative control"))
      await page.evaluate(path => {
        const sheet = [...document.styleSheets].find(sheet => sheet.href === `${location.origin}${path}`)
        if (!sheet) throw new Error("Missing copy stylesheet restoration")
        sheet.disabled = false
      }, payload.finalCss)
      await settle(page); compareShellElements(await measureCopy(page), before, "Copy exact stylesheet recovery")
      controls.push(copyNegativeControls[0]!)
      await page.mouse.move(0, 0); await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab"); await settle(page)
      assert.equal(await button.evaluate(element => element.matches(":focus-visible")), true)
      const focused = await measureCopy(page, [buttonSelector])
      const previousStyle = await button.getAttribute("style")
      assert.equal(previousStyle, null)
      await button.evaluate(element => (element as HTMLElement).style.setProperty("outline-style", "none", "important"))
      await settle(page)
      const suppressed = await measureCopy(page, [buttonSelector])
      assert.throws(() => compareShellElements(suppressed, focused, "Copy native focus negative control"))
      await button.evaluate(element => element.removeAttribute("style"))
      await settle(page); compareShellElements(await measureCopy(page, [buttonSelector]), focused, "Copy exact native focus recovery")
      controls.push(copyNegativeControls[1]!)
    }
    await operations.settle("Copy final operations")
    for (const path of payload.stylesheets) assert.ok(received.has(path), `Missing copy stylesheet ${path}`)
    assert.ok([...received].filter(path => path.endsWith(".woff2")).length >= 2)
    await protocol.detach(); await operations.settle("Copy operations after observer detach")
    assert.ok(!page.isClosed() && browser.isConnected()); assert.equal(requests.size, 0); assert.deepEqual(errors, [])
    operations.seal()
    return { steps, command, negativeControls: controls, ports }
  }, async () => {
    try {
      lifecycle.beginContextClose(); await bounded(context.close(), "Copy context collection", 5_000)
      assert.equal(browser.isConnected(), true)
      await operations.settle("Copy final operation settlement"); assert.equal(requests.size, 0); assert.equal(operations.size, 0); assert.deepEqual(errors, [])
    } finally { browser.off("disconnected", lifecycle.browserDisconnected) }
  })
}
