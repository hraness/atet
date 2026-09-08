#!/usr/bin/env bun

import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { access, mkdtemp, opendir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnVerificationServer, stopVerificationServer, type ManagedVerificationServer } from "@hraness/direct/tooling/browser-verification"
import { chromium, type Browser, type Page } from "playwright-core"
import { inspectPreviewCssResources } from "./preview-css"
import { readPreviewFile } from "./preview-file"

const appDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const timeoutMs = 30_000
export const baselineRevision = "0130b9ac79dc4ea5abcb31104f64657931a398e8"
const baselineSources = Object.freeze({
  "package.json": "b45819abbe30d326aff9b48dd5752f53165d57d7db9a61c3c481b6e6f6f29244",
  "bun.lock": "2143567331ff2f1cdd9bf4ac9b87a9032a3cfdefbcbddaf50fc161e80dc8b096",
  "src/preview.html": "9e055c91b27eba9018f0c1562de7bd6cb7406a7445381ddfb68ce6bb3c988211",
  "src/styles.css": "49838797ae8c977f3c446482299a3f20a8db4197f1592f3388fdb018e9d469cc",
  "scripts/build.ts": "ac86f314caf41261d20fe8e8f75134c7fa8ae3f2f967b1e3e1dee19fafa515ee",
  "vercel.json": "9b80a7b9f73ffe1a40c5a6ec02bbdf62821962e2b7fa375796f037aaae7c6313",
})

export const expectedPreviewHeaders = Object.freeze({
  "content-security-policy": "default-src 'none'; base-uri 'none'; connect-src 'none'; font-src 'self'; form-action 'none'; frame-ancestors https://hraness.com https://www.hraness.com; img-src 'none'; object-src 'none'; script-src 'none'; style-src 'self'; upgrade-insecure-requests",
  "permissions-policy": "camera=(), display-capture=(), geolocation=(), microphone=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cross-origin-opener-policy": "same-origin",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  vary: "Accept, Accept-Encoding",
  "x-robots-tag": "noindex, nofollow, noarchive, nosnippet",
  link: '<https://atet.sh/>; rel="canonical"',
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

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "Expected an object")
  return value as Record<string, unknown>
}

export function parsePreviewArguments(args: readonly string[]): { baseline?: string; manifest?: string } {
  if (args.length === 0) return {}
  const [flag, baseline, manifestFlag, manifest] = args
  assert.ok(args.length === 4 && flag === "--baseline" && manifestFlag === "--baseline-manifest"
    && baseline !== undefined && manifest !== undefined && isAbsolute(baseline) && isAbsolute(manifest),
  "Usage: verify-preview-layout.ts [--baseline <absolute old apps/web> --baseline-manifest <absolute JSON>]")
  return { baseline, manifest }
}

export function readPreviewHeaders(value: unknown): Record<string, string> {
  const entries = record(value).headers
  assert.ok(Array.isArray(entries) && entries.length <= 64, "Invalid Vercel header inventory")
  const matches = entries.filter(entry => record(entry).source === "/preview")
  assert.equal(matches.length, 1, "Expected one exact /preview header rule")
  const headers = record(matches[0]).headers
  assert.ok(Array.isArray(headers) && headers.length === 9, "Invalid preview header inventory")
  const result: Record<string, string> = {}
  for (const value of headers) {
    const header = record(value)
    assert.deepEqual(Object.keys(header).sort(), ["key", "value"])
    assert.ok(typeof header.key === "string" && /^[a-z-]+$/iu.test(header.key)
      && typeof header.value === "string" && header.value.length <= 1024 && !/[\r\n]/u.test(header.value))
    const key = header.key.toLowerCase()
    assert.ok(!Object.hasOwn(result, key), "Duplicate preview header")
    result[key] = header.value
  }
  assert.deepEqual(result, expectedPreviewHeaders, "Preview headers differ from the reviewed strict contract")
  return result
}

export function resolvePreviewResource(reference: string, stylesheet: string): string {
  assert.ok(reference.length > 0 && reference.length <= 512 && !/[\\%\s?#]/u.test(reference)
    && !reference.split("/").includes(".."), "Invalid preview resource reference")
  const url = new URL(reference, `http://preview.invalid${stylesheet}`)
  assert.ok(url.origin === "http://preview.invalid" && url.search === "" && url.hash === ""
    && /^\/(?:assets\/|graphs\/preview-foundation\/assets\/)[A-Za-z0-9_./\[\]-]+\.woff2$/u.test(url.pathname),
  "Preview CSS may request only inventory-bound local WOFF2 fonts")
  return url.pathname
}

export interface PreviewArtifact { readonly path: string; readonly bytes: number; readonly sha256: string }

export function assertBaselineManifest(value: unknown, artifacts: readonly PreviewArtifact[]): void {
  const manifest = record(value)
  assert.deepEqual(Object.keys(manifest).sort(), ["artifacts", "schemaVersion", "sourceRevision"])
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.sourceRevision, baselineRevision)
  assert.equal(artifacts.length, 15, "Baseline must bind HTML, one stylesheet and thirteen fonts")
  assert.deepEqual(manifest.artifacts, artifacts, "Baseline artifact bytes differ from its explicit manifest")
}

function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex") }

interface Payload {
  readonly files: ReadonlyMap<string, Uint8Array>
  readonly headers: Readonly<Record<string, string>>
  readonly stylesheets: readonly string[]
  readonly artifacts: readonly PreviewArtifact[]
}

async function readPayload(directory: string, manifestPath?: string): Promise<Payload> {
  assert.equal(await realpath(directory), directory, "Preview directory must have a physical absolute path")
  const headers = readPreviewHeaders(JSON.parse(Buffer.from(await readPreviewFile(join(directory, "vercel.json"), 64 * 1024)).toString()))
  const output = join(directory, "dist")
  const htmlBytes = await readPreviewFile(join(output, "preview.html"), 64 * 1024)
  const html = Buffer.from(htmlBytes).toString()
  assert.ok(!/<(?:script|style|a|button|input|select|textarea|form|iframe|object|embed)\b|\s(?:on\w+|style|tabindex|contenteditable)\s*=/iu.test(html),
    "Preview must remain inert: no actions, inline styles or scripts")
  const stylesheets = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"\s*\/?\s*>/gu)].map(match => match[1]!)
  assert.equal(stylesheets.length, manifestPath === undefined ? 2 : 1)
  assert.equal(new Set(stylesheets).size, stylesheets.length)
  const files = new Map<string, Uint8Array>([["/preview", htmlBytes]])
  const fonts = new Set<string>()
  for (const path of stylesheets) {
    assert.ok(/^\/(?:assets\/|graphs\/preview-foundation\/assets\/)[A-Za-z0-9_-]+\.css$/u.test(path), "Invalid preview CSS path")
    const bytes = await readPreviewFile(join(output, path.slice(1)))
    files.set(path, bytes)
    for (const reference of inspectPreviewCssResources(Buffer.from(bytes).toString(), path)) {
      fonts.add(resolvePreviewResource(reference, path))
    }
  }
  assert.equal(fonts.size, 13, "Preview must bind all thirteen local font files")
  for (const path of [...fonts].sort()) files.set(path, await readPreviewFile(join(output, path.slice(1)), 2 * 1024 * 1024))
  const artifacts = [...files].map(([path, bytes]) => ({
    path: path === "/preview" ? "preview.html" : path.slice(1), bytes: bytes.byteLength, sha256: digest(bytes),
  })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  if (manifestPath !== undefined) {
    for (const [path, hash] of Object.entries(baselineSources)) {
      assert.equal(digest(await readPreviewFile(join(directory, path))), hash, `Baseline is not exact ${baselineRevision}: ${path}`)
    }
    assertBaselineManifest(JSON.parse(Buffer.from(await readPreviewFile(manifestPath, 64 * 1024)).toString()), artifacts)
  }
  return { files, headers, stylesheets, artifacts }
}

function contentType(path: string): string {
  return path === "/preview" ? "text/html; charset=utf-8" : path.endsWith(".css") ? "text/css; charset=utf-8" : "font/woff2"
}

function serve(payload: Payload) {
  const rejected: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url)
    const bytes = payload.files.get(url.pathname)
    if (request.method !== "GET" || url.search !== "" || bytes === undefined) {
      if (rejected.length < 128) rejected.push(`${request.method} ${url.pathname}`)
      return new Response("Not Found", { status: 404 })
    }
    return new Response(Uint8Array.from(bytes), { headers: {
      ...(url.pathname === "/preview" ? payload.headers : {}),
      "content-type": contentType(url.pathname), "cache-control": "no-store",
    } })
  } })
  return { server, rejected }
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

async function bounded<T>(promise: Promise<T>, label: string, limit = timeoutMs): Promise<T> {
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

async function checkCase(browser: Browser, base: URL, payload: Payload, scenario: PreviewCase, negative: boolean): Promise<PreviewEvidence> {
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

async function findChrome(): Promise<string> {
  for (const candidate of [process.env.ATET_CHROME_PATH, process.env.CHROME_PATH, "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]) {
    if (candidate === undefined || candidate === "") continue
    try { await access(candidate, constants.X_OK); return candidate } catch { /* Try the next explicit executable. */ }
  }
  throw new Error("Chrome is required; set ATET_CHROME_PATH")
}

export function parsePreviewEndpoint(text: string): { port: number; browserPath: string } {
  assert.ok(Buffer.byteLength(text) <= 1024, "Excessive Chrome endpoint file")
  const match = /^(\d{1,5})\n(\/devtools\/browser\/[a-f0-9-]+)\n?$/u.exec(text)
  assert.ok(match !== null && Number(match[1]) > 0 && Number(match[1]) <= 65535, "Invalid Chrome endpoint")
  return { port: Number(match[1]), browserPath: match[2]! }
}

function errorEvidence(error: unknown): Record<string, unknown> {
  return error instanceof Error ? { name: error.name, message: error.message.slice(0, 2048),
    ...("code" in error ? { code: String(error.code).slice(0, 64) } : {}) } : { message: String(error).slice(0, 2048) }
}

export interface EndpointEvidence {
  readonly deadlineMs: number
  attempts: number
  lastRead?: { elapsedMs: number; bytes?: number; error?: Record<string, unknown> }
  outcome?: "connected" | "timeout" | "cancelled" | "exited" | "failed"
}

interface PreviewEndpointIo {
  now(): number
  schedule(callback: () => void, delayMs: number): () => void
  read(path: string, maximum: number): Promise<Uint8Array>
}

/** Internal deterministic seam. Native admission below always uses the strict
 * physical-file reader; filesystem notifications are not readiness evidence. */
export function createPreviewEndpointWaiter(io: PreviewEndpointIo) {
  return async function waitEndpoint(profile: string, exited: Promise<unknown>, signal: AbortSignal, evidence: EndpointEvidence): Promise<string> {
    signal.throwIfAborted()
    assert.equal(evidence.deadlineMs, 10_000, "Chrome endpoint deadline must remain ten seconds")
    assert.equal(evidence.attempts, 0, "Chrome endpoint evidence cannot be reused")
    return new Promise((resolve, reject) => {
      let finished = false
      let lastError: unknown
      let cancelDeadline = () => {}
      let cancelRetry = () => {}
      const started = io.now()
      const deadline = started + evidence.deadlineMs
      const finish = (error?: unknown, value?: string) => {
        if (finished) return
        finished = true
        cancelDeadline()
        cancelRetry()
        signal.removeEventListener("abort", abort)
        if (error !== undefined) reject(error)
        else resolve(value!)
      }
      const expire = () => {
        if (finished) return
        evidence.outcome = "timeout"
        finish(new Error("Chrome endpoint startup timed out", { cause: lastError }))
      }
      const abort = () => {
        if (finished) return
        evidence.outcome = "cancelled"
        finish(signal.reason)
      }
      const inspect = async () => {
        if (finished) return
        if (io.now() >= deadline) { expire(); return }
        if (evidence.attempts >= 201) {
          evidence.outcome = "failed"
          finish(new Error("Excessive Chrome endpoint readiness reads"))
          return
        }
        evidence.attempts += 1
        try {
          const text = Buffer.from(await io.read(join(profile, "DevToolsActivePort"), 1024)).toString()
          if (finished) return
          if (signal.aborted) { abort(); return }
          // A delayed timer callback must not admit bytes completed past the
          // original absolute deadline, nor may a late read change its outcome.
          if (io.now() >= deadline) { expire(); return }
          const endpoint = parsePreviewEndpoint(text)
          evidence.lastRead = { elapsedMs: Math.round(io.now() - started), bytes: Buffer.byteLength(text) }
          evidence.outcome = "connected"
          finish(undefined, `ws://127.0.0.1:${endpoint.port}${endpoint.browserPath}`)
        } catch (error) {
          if (finished) return
          lastError = error
          evidence.lastRead = { elapsedMs: Math.round(io.now() - started), error: errorEvidence(error) }
          if (io.now() >= deadline) expire()
        } finally {
          // Schedule only after the current strict read has settled. Missing,
          // partial or changed files never produce overlapping descriptor reads.
          if (!finished) cancelRetry = io.schedule(() => { void inspect() }, Math.min(50, Math.max(0, deadline - io.now())))
        }
      }
      cancelDeadline = io.schedule(expire, evidence.deadlineMs)
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
      void exited.then(() => {
        if (finished) return
        evidence.outcome = "exited"
        finish(new Error("Chrome exited before protocol attachment"))
      }, error => {
        if (finished) return
        evidence.outcome = "failed"
        finish(new Error("Chrome process wait failed", { cause: error }))
      })
      void inspect()
    })
  }
}

const waitBrowserEndpoint = createPreviewEndpointWaiter({
  now: () => performance.now(),
  read: readPreviewFile,
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs)
    return () => clearTimeout(timer)
  },
})

export async function verifyPreview(args: readonly string[] = []): Promise<void> {
  let profile: string | undefined
  const servers: ReturnType<typeof serve>[] = []
  let managed: ManagedVerificationServer | undefined
  let browser: Browser | undefined
  let connection: Promise<Browser> | undefined
  let activeCase: Promise<PreviewEvidence> | undefined
  let processGroupAbsent = false
  let verificationCompleted = false
  let signal: AbortSignal | undefined
  let chromeOutput: string | undefined
  let endpointBeforeCollection: unknown
  const endpointEvidence: EndpointEvidence = { deadlineMs: 10_000, attempts: 0 }
  const result = await withPreviewCancellation(process, async cancellation => {
    signal = cancellation.signal
    const options = parsePreviewArguments(args)
    const current = await cancellation.wait(async () => readPayload(await realpath(appDirectory)))
    const baseline = options.baseline === undefined ? undefined : await cancellation.wait(() => readPayload(options.baseline!, options.manifest))
    // Do not race resource acquisition: capture the profile before cancellation
    // can hand control to cleanup. The synchronous spawn below follows the same rule.
    profile = await mkdtemp(join(await realpath(tmpdir()), "atet-preview-layout-"))
    cancellation.signal.throwIfAborted()
    const currentServer = serve(current)
    servers.push(currentServer)
    const oldServer = baseline === undefined ? undefined : serve(baseline)
    if (oldServer !== undefined) servers.push(oldServer)
    const chrome = await cancellation.wait(findChrome)
    cancellation.signal.throwIfAborted()
    managed = spawnVerificationServer({ cwd: appDirectory, detachedProcessGroup: true, logLimit: 12_000, command: [
      chrome, "--headless=new", "--no-sandbox", "--disable-background-networking", "--disable-component-update",
      "--disable-default-apps", "--disable-extensions", "--disable-gpu", "--disable-sync", "--force-color-profile=srgb",
      "--metrics-recording-only", "--mute-audio", "--no-first-run", "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
    ] })
    console.error("atet-preview: browser-started")
    const endpoint = await waitBrowserEndpoint(profile, managed.exited, cancellation.signal, endpointEvidence)
    browser = await cancellation.wait(() => {
      connection = chromium.connectOverCDP(endpoint, { timeout: 10_000 })
      return connection
    })
    console.error("atet-preview: browser-connected")
    const rows = []
    for (const scenario of previewCases) {
      const evidence = await cancellation.wait(() => {
        activeCase = checkCase(browser!, currentServer.server.url, current, scenario, scenario.name === "light-wide")
        return bounded(activeCase, scenario.name)
      })
      if (baseline !== undefined && oldServer !== undefined) {
        const old = await cancellation.wait(() => {
          activeCase = checkCase(browser!, oldServer.server.url, baseline, scenario, false)
          return bounded(activeCase, `baseline ${scenario.name}`)
        })
        comparePreviewEvidence(evidence, old)
      }
      rows.push({ ...scenario, columns: evidence.columns, maxScrollY: evidence.maxScrollY })
    }
    for (const server of servers) assert.deepEqual(server.rejected, [], "Server received unadmitted resource requests")
    verificationCompleted = true
    return { browser: browser.version(), cases: rows, nativeBrowserZoom: false, internetRequestsAllowed: false,
      exactHeaders: true, noActions: true, resourceErrors: 0, cspErrors: 0, negativeStylesheetRestored: true,
      currentArtifacts: current.artifacts, baseline: baseline === undefined ? null : { sourceRevision: baselineRevision, artifacts: baseline.artifacts } }
  }, async () => {
    const failures: unknown[] = []
    const collect = async (operation: () => Promise<unknown>) => {
      try { await operation() } catch (error) { failures.push(error) }
    }
    if (profile !== undefined && (!verificationCompleted || signal?.aborted === true)) {
      try {
        const text = Buffer.from(await readPreviewFile(join(profile, "DevToolsActivePort"), 1024)).toString()
        endpointBeforeCollection = { text, parsed: parsePreviewEndpoint(text) }
      } catch (error) { endpointBeforeCollection = errorEvidence(error) }
    }
    if (browser !== undefined) await collect(() => bounded(browser!.close(), "Browser protocol close", 5_000))
    if (managed !== undefined) await collect(async () => {
      await stopVerificationServer(managed!, 5_000)
      processGroupAbsent = true
      console.error("atet-preview: browser-collected")
    })
    if (managed !== undefined) await collect(async () => {
      chromeOutput = await bounded(managed!.output, "Bounded Chrome diagnostic output", 5_000)
      assert.ok(Buffer.byteLength(chromeOutput) <= 48_000, "Supervisor diagnostic output exceeded its bound")
    })
    // An interrupted CDP attachment can settle after cancellation won its race.
    // The owned group is collected first; then drain and close that late handle.
    if (connection !== undefined && browser === undefined) await collect(async () => {
      const late = await bounded(connection!.then(value => value, () => undefined), "Cancelled CDP attachment settlement", 10_000)
      if (late !== undefined) await bounded(late.close(), "Late browser protocol close", 5_000)
    })
    if (activeCase !== undefined) await collect(() => bounded(Promise.allSettled([activeCase!]), "Active verification settlement", 5_000))
    for (const server of servers) await collect(() => bounded(server.server.stop(true), "Preview server close", 5_000))
    if (profile !== undefined) {
      if (managed !== undefined && !processGroupAbsent) failures.push(new Error(`Browser process-group absence is unproved; preserved profile: ${profile}`))
      if (verificationCompleted && signal?.aborted !== true && failures.length === 0 && processGroupAbsent) {
        await collect(() => rm(profile!, { recursive: true, force: true }))
      } else await collect(async () => {
        const entries: string[] = []
        for await (const entry of await opendir(profile!)) {
          entries.push(entry.name)
          if (entries.length >= 64) break
        }
        let endpointAtCollection: unknown
        try {
          const text = Buffer.from(await readPreviewFile(join(profile!, "DevToolsActivePort"), 1024)).toString()
          endpointAtCollection = { text, parsed: parsePreviewEndpoint(text) }
        } catch (error) { endpointAtCollection = errorEvidence(error) }
        const path = join(profile!, "atet-preview-failure.json")
        await writeFile(path, `${JSON.stringify({ accepted: false, verificationCompleted, cancelled: signal?.aborted === true,
          processGroupAbsent, endpointEvidence, endpointBeforeCollection, endpointAtCollection, profileEntries: entries.sort(),
          chromeOutput, cleanupFailures: failures.map(errorEvidence) }, null, 2)}\n`, { flag: "wx", mode: 0o600 })
        console.error(`atet-preview: failure evidence preserved at ${path}`)
      })
    }
    if (failures.length > 0) throw new AggregateError(failures, "Preview resource collection failed")
  })
  console.log(JSON.stringify({ ...record(result), processGroupAbsent }))
}

if (import.meta.main) await verifyPreview(process.argv.slice(2))
