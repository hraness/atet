import assert from "node:assert/strict"
import type { Browser, Page } from "playwright-core"

const timeoutMs = 30_000

export const expectedPreviewHeaders = Object.freeze({
  "content-security-policy": "default-src 'none'; base-uri 'none'; connect-src 'none'; font-src 'self'; form-action 'none'; frame-ancestors https://hraness.com https://www.hraness.com; img-src 'none'; object-src 'none'; script-src 'none'; style-src 'self'; upgrade-insecure-requests",
  "permissions-policy": "camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cross-origin-opener-policy": "same-origin",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  vary: "Accept, Accept-Encoding",
  "x-robots-tag": "noindex, nofollow, noarchive, nosnippet",
  link: '<https://slop.camera/>; rel="canonical"',
})

export interface PreviewCase {
  readonly name: string
  readonly width: number
  readonly height: number
  readonly dpr: number
  readonly colorScheme: "light" | "dark"
  readonly forcedColors: "none" | "active"
}

export const previewCases: readonly PreviewCase[] = Object.freeze([
  ...(["light", "dark"] as const).flatMap(colorScheme => [
    { name: "wide", width: 1280, height: 900, dpr: 1 },
    { name: "48rem-boundary", width: 768, height: 900, dpr: 1 },
    { name: "above-48rem", width: 769, height: 900, dpr: 1 },
    { name: "short-dpr2", width: 320, height: 180, dpr: 2 },
    // This is the CSS viewport produced by 200% reflow, not native browser zoom.
    { name: "200pct-reflow-equivalent", width: 640, height: 450, dpr: 2 },
  ].map(size => ({ ...size, name: `${colorScheme}-${size.name}`, colorScheme, forcedColors: "none" as const }))),
  { name: "forced-colors-short-dpr2", width: 320, height: 180, dpr: 2, colorScheme: "light", forcedColors: "active" },
])

export function contentType(path: string): string {
  return path === "/preview" ? "text/html; charset=utf-8" : path.endsWith(".css") ? "text/css; charset=utf-8" : "font/woff2"
}

export interface BrowserPayload {
  readonly files: ReadonlyMap<string, Uint8Array>
  readonly headers: Readonly<Record<string, string>>
  readonly stylesheets: readonly string[]
}

export interface ElementEvidence {
  readonly key: string
  readonly rect: readonly number[]
  readonly styles: Readonly<Record<string, string>>
}
export interface PreviewEvidence {
  readonly width: number
  readonly height: number
  readonly dpr: number
  readonly theme: string | null
  readonly dark: boolean
  readonly forcedColors: boolean
  readonly columns: number
  readonly actions: number
  readonly loadedFonts: number
  readonly text: string
  readonly maxScrollY: number
  readonly reachedScrollY: number
  readonly failures: readonly string[]
  readonly elements: readonly ElementEvidence[]
}

async function measure(page: Page): Promise<PreviewEvidence> {
  return page.evaluate(async () => {
    await document.fonts.ready
    const loaded = await Promise.all([document.fonts.load('400 16px "Nebula Sans"'), document.fonts.load('500 16px "Nebula Sans"')])
    const root = document.documentElement
    const body = document.body
    const selectors = ["body", ".preview-shell", ".preview-mark", ".preview-mark__sun", ".preview-mark__path",
      ".preview-kicker", "#preview-title", ".preview-summary", ".preview-outputs",
      ...[1, 2, 3, 4].flatMap(index => [`.preview-outputs li:nth-child(${index})`, `.preview-outputs li:nth-child(${index}) span`]), ".preview-note"]
    const properties = ["display", "position", "min-height", "max-width", "border-radius", "font-family", "font-size", "font-weight",
      "line-height", "letter-spacing", "color", "background-color", "background-image", "box-shadow", "grid-template-columns",
      "background-attachment", "background-clip", "background-origin", "background-position", "background-repeat", "background-size",
      "align-items", "align-content", "justify-items", "justify-content", "gap", "transform", "opacity", "visibility",
      "overflow-x", "overflow-y", "white-space", "overflow-wrap", "font-synthesis", "text-wrap", "-webkit-font-smoothing",
      "font-variant-ligatures", "text-rendering", ...["top", "right", "bottom", "left"].flatMap(side =>
        [`margin-${side}`, `padding-${side}`, `border-${side}-width`, `border-${side}-style`, `border-${side}-color`])]
    window.scrollTo({ top: 0, behavior: "instant" })
    const failures: string[] = []
    const targets = selectors.map(key => {
      const element = document.querySelector<HTMLElement>(key)
      if (element === null) throw new Error(`Missing preview element ${key}`)
      return { key, element }
    })
    const elements = targets.map(({ key, element }) => {
      const rect = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      if (key === "body" && style.fontFamily.split(",")[0]!.replaceAll('"', "").trim() !== "Nebula Sans") failures.push("body: local font is not selected")
      if (key === "body" && !matchMedia("(forced-colors: active)").matches
        && style.color !== (matchMedia("(prefers-color-scheme: dark)").matches ? "rgb(244, 241, 232)" : "rgb(23, 22, 18)")) failures.push("body: system theme color did not apply")
      if (rect.width <= 0 || rect.height <= 0 || rect.left < -0.5 || rect.right > root.clientWidth + 0.5) failures.push(`${key}: horizontal bounds`)
      if (element.scrollWidth > element.clientWidth + 1 && (style.overflowX !== "visible" || rect.left + element.scrollWidth > root.clientWidth + 0.5)) failures.push(`${key}: clipped content`)
      return { key, rect: [rect.x, rect.y, rect.width, rect.height], styles: Object.fromEntries(properties.map(property => [property, style.getPropertyValue(property)])) }
    })
    if (root.scrollWidth > root.clientWidth + 1 || body.scrollWidth > root.clientWidth + 1) failures.push("document horizontal overflow")
    const maxScrollY = Math.max(0, root.scrollHeight - root.clientHeight)
    for (const { key, element } of targets) {
      if (key === "body" || key === ".preview-shell" || key === ".preview-outputs" || element.closest('[aria-hidden="true"]') !== null) continue
      const before = element.getBoundingClientRect()
      window.scrollTo({ top: Math.min(maxScrollY, Math.max(0, before.top + window.scrollY - (root.clientHeight - before.height) / 2)), behavior: "instant" })
      const after = element.getBoundingClientRect()
      if (after.top < -0.5 || after.bottom > root.clientHeight + 0.5) failures.push(`${key}: not reachable by vertical scrolling`)
    }
    window.scrollTo({ top: maxScrollY, behavior: "instant" })
    const note = document.querySelector(".preview-note")!.getBoundingClientRect()
    if (note.top < -0.5 || note.bottom > root.clientHeight + 0.5) failures.push("final note not visible at bottom boundary")
    return {
      width: innerWidth, height: innerHeight, dpr: devicePixelRatio, theme: root.getAttribute("data-theme"),
      dark: matchMedia("(prefers-color-scheme: dark)").matches, forcedColors: matchMedia("(forced-colors: active)").matches,
      columns: getComputedStyle(document.querySelector(".preview-outputs")!).gridTemplateColumns.split(" ").length,
      actions: document.querySelectorAll('a,button,input,select,textarea,form,iframe,object,embed,script,style,details,summary,audio,video,[role="button"],[role="link"],[tabindex],[contenteditable],[style]').length,
      loadedFonts: loaded.filter(group => group.length > 0 && group.every(font => font.status === "loaded")).length,
      text: body.innerText, maxScrollY, reachedScrollY: scrollY, failures, elements,
    }
  })
}

export function assertPreviewEvidence(evidence: PreviewEvidence, scenario: PreviewCase): void {
  for (const key of ["width", "height", "dpr", "columns", "actions", "loadedFonts", "maxScrollY", "reachedScrollY"] as const) {
    assert.ok(Number.isFinite(evidence[key]) && evidence[key] >= 0, `Invalid numeric evidence: ${key}`)
  }
  assert.deepEqual([evidence.width, evidence.height, evidence.dpr], [scenario.width, scenario.height, scenario.dpr])
  assert.deepEqual([evidence.theme, evidence.dark, evidence.forcedColors], ["system", scenario.colorScheme === "dark", scenario.forcedColors === "active"])
  assert.equal(evidence.columns, scenario.width <= 768 ? 2 : 4)
  assert.equal(evidence.actions, 0, "Preview gained a script, inline style or action")
  assert.equal(evidence.loadedFonts, 2, "Preview local Book and Medium font faces must load")
  assert.deepEqual(evidence.failures, [])
  assert.ok(typeof evidence.text === "string" && evidence.text.length > 0 && evidence.text.length < 4096)
  assert.equal(evidence.elements.length, 18)
  assert.equal(new Set(evidence.elements.map(element => element.key)).size, 18)
  for (const element of evidence.elements) {
    assert.equal(element.rect.length, 4)
    assert.ok(element.rect.every(Number.isFinite) && element.rect[2]! > 0 && element.rect[3]! > 0)
    assert.ok(Object.keys(element.styles).length > 0 && Object.values(element.styles).every(value => typeof value === "string"))
  }
  if (scenario.height === 180) assert.ok(evidence.maxScrollY > 0, "Original short viewport must require vertical scrolling")
  assert.ok(evidence.reachedScrollY >= evidence.maxScrollY - 1, "Bottom scroll boundary was not reached")
}

export function comparePreviewEvidence(actual: PreviewEvidence, baseline: PreviewEvidence): void {
  assert.equal(actual.text, baseline.text, "Preview visible content changed")
  assert.equal(actual.elements.length, baseline.elements.length)
  for (const [index, element] of actual.elements.entries()) {
    const old = baseline.elements[index]!
    assert.equal(element.key, old.key)
    assert.deepEqual(element.styles, old.styles, `${element.key}: computed style parity`)
    assert.equal(element.rect.length, old.rect.length)
    for (const [axis, value] of element.rect.entries()) {
      assert.ok(Number.isFinite(value) && Number.isFinite(old.rect[axis]) && Math.abs(value - old.rect[axis]!) <= 0.5,
        `${element.key}: geometry ${axis} changed from ${old.rect[axis]} to ${value}`)
    }
  }
}

export async function bounded<T>(promise: Promise<T>, label: string, limit = timeoutMs): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${limit}ms`)), limit)
    })])
  } finally { clearTimeout(timer) }
}

type PreviewSignal = "SIGINT" | "SIGTERM"
export interface PreviewSignalSource {
  on(signal: PreviewSignal, listener: () => void): unknown
  off(signal: PreviewSignal, listener: () => void): unknown
}

export interface PreviewCancellation {
  readonly signal: AbortSignal
  wait<T>(operation: () => Promise<T>): Promise<T>
}

/** Signals request cancellation, never exit before owned-resource collection.
 * Keep both listeners installed during cleanup, including repeated signals. */
export async function withPreviewCancellation<T>(
  source: PreviewSignalSource,
  run: (cancellation: PreviewCancellation) => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  const controller = new AbortController()
  const { signal } = controller
  const listeners = (["SIGINT", "SIGTERM"] as const).map(name => {
    const listener = () => {
      if (!signal.aborted) controller.abort(new Error(`Preview verification cancelled by ${name}`))
    }
    source.on(name, listener)
    return { name, listener }
  })
  const failures: unknown[] = []
  let result: T | undefined
  try {
    try {
      result = await run({ signal, async wait(operation) {
        signal.throwIfAborted()
        let listener: (() => void) | undefined
        try {
          const aborted = new Promise<never>((_, reject) => {
            listener = () => reject(signal.reason)
            signal.addEventListener("abort", listener, { once: true })
          })
          const running = Promise.resolve().then(() => {
            signal.throwIfAborted()
            return operation()
          })
          return await Promise.race([running, aborted])
        } finally {
          if (listener !== undefined) signal.removeEventListener("abort", listener)
        }
      } })
    } catch (error) { failures.push(error) }
    try { await cleanup() } catch (error) { failures.push(error) }
    if (signal.aborted && !failures.includes(signal.reason)) failures.unshift(signal.reason)
  } finally {
    for (const { name, listener } of listeners) source.off(name, listener)
  }
  if (failures.length > 0) throw new AggregateError(failures, "Preview verification or resource collection failed")
  return result as T
}

export async function checkCase(browser: Browser, base: URL, payload: BrowserPayload, scenario: PreviewCase, negative: boolean): Promise<PreviewEvidence> {
  const context = await browser.newContext({ viewport: { width: scenario.width, height: scenario.height },
    deviceScaleFactor: scenario.dpr, colorScheme: scenario.colorScheme, forcedColors: scenario.forcedColors,
    bypassCSP: false, serviceWorkers: "block" })
  context.setDefaultTimeout(10_000)
  const errors: string[] = []
  const error = (message: string) => { if (errors.length < 128) errors.push(message.slice(0, 2048)) }
  const received = new Set<string>()
  try {
    // Internet-offline admission: only these immutable loopback HTML/CSS/font bytes may load.
    await context.route("**/*", async route => {
      const request = route.request()
      const url = new URL(request.url())
      if (request.method() !== "GET" || url.origin !== base.origin || url.search !== "" || !payload.files.has(url.pathname)) {
        error(`Unadmitted request: ${request.method()} ${url.origin}${url.pathname}`)
        await route.abort("blockedbyclient")
      } else await route.continue()
    })
    const page = await context.newPage()
    page.on("pageerror", failure => error(failure.message))
    page.on("console", message => { if (message.type() === "error") error(message.text()) })
    page.on("requestfailed", request => error(`Resource failed: ${request.url()} ${request.failure()?.errorText}`))
    page.on("response", response => {
      const path = new URL(response.url()).pathname
      received.add(path)
      if (response.status() !== 200 || response.headers()["content-type"] !== contentType(path)) error(`Invalid resource response: ${path} ${response.status()}`)
    })
    const protocol = await context.newCDPSession(page)
    await protocol.send("Log.enable")
    protocol.on("Log.entryAdded", ({ entry }) => { if (entry.level === "error" || entry.source === "security") error(`${entry.source}: ${entry.text}`) })
    const response = await page.goto(new URL("/preview", base).href, { waitUntil: "load" })
    assert.ok(response !== null && response.status() === 200)
    for (const [key, value] of Object.entries(payload.headers)) assert.equal(response.headers()[key], value, `Actual response header ${key}`)
    assert.equal(page.frames().length, 1, "Preview must be tested top-level, not in an instrumented frame")
    const evidence = await measure(page)
    assertPreviewEvidence(evidence, scenario)
    for (const stylesheet of payload.stylesheets) assert.ok(received.has(stylesheet), `Stylesheet was not loaded: ${stylesheet}`)
    assert.ok([...received].filter(path => path.endsWith(".woff2")).length >= 2, "Local font network loads were not observed")
    if (negative) {
      const href = new URL(payload.stylesheets.at(-1)!, base).href
      const sheet = await page.evaluateHandle(url => {
        const found = [...document.styleSheets].find(candidate => candidate.href === url)
        if (found === undefined || found.disabled) throw new Error("Missing active final stylesheet")
        found.disabled = true
        return found
      }, href)
      // Keep the CSSStyleSheet identity, never remove/reinsert a link or reload the page.
      try {
        const disabled = await measure(page)
        assert.throws(() => comparePreviewEvidence(disabled, evidence), "Disabling final CSS must make parity fail")
      } finally {
        await sheet.evaluate(value => {
          if (!(value instanceof CSSStyleSheet) || ![...document.styleSheets].includes(value)) throw new Error("Negative control lost stylesheet identity")
          value.disabled = false
        })
        await sheet.dispose()
      }
      const restored = await measure(page)
      assertPreviewEvidence(restored, scenario)
      comparePreviewEvidence(restored, evidence)
    }
    assert.deepEqual(errors, [], `${scenario.name}: resource, console, page or CSP errors`)
    return evidence
  } finally { await bounded(context.close(), "Browser context close", 5_000) }
}
