import { expect, test } from "bun:test"
import {
  assertBaselineManifest, assertPreviewEvidence, baselineRevision, comparePreviewEvidence,
  expectedPreviewHeaders, parsePreviewArguments, previewCases, readPreviewHeaders, resolvePreviewResource,
  isPreviewEndpointEvent, parsePreviewEndpoint, withPreviewCancellation,
  type PreviewArtifact, type PreviewCase, type PreviewEvidence, type PreviewSignalSource,
} from "./verify-preview-layout"

function config() {
  return { headers: [{ source: "/preview", headers: Object.entries(expectedPreviewHeaders).map(([key, value]) => ({ key, value: String(value) })) }] }
}

const scenario: PreviewCase = { name: "fixture", width: 320, height: 180, dpr: 2, colorScheme: "light", forcedColors: "none" }

function evidence(): PreviewEvidence {
  return {
    width: 320, height: 180, dpr: 2, theme: "system", dark: false, forcedColors: false,
    columns: 2, actions: 0, loadedFonts: 2, text: "Atet", maxScrollY: 240, reachedScrollY: 240,
    failures: [], elements: Array.from({ length: 18 }, (_, index) => ({
      key: `element-${index}`, rect: [0, index * 10, 100, 10], styles: { color: "rgb(0, 0, 0)" },
    })),
  }
}

test("preview matrix is finite and preserves the original geometry, 48rem boundary and both system themes", () => {
  expect(previewCases).toHaveLength(11)
  expect(new Set(previewCases.map(value => value.name)).size).toBe(11)
  for (const colorScheme of ["light", "dark"] as const) {
    expect(previewCases.filter(value => value.colorScheme === colorScheme && value.forcedColors === "none")
      .map(({ width, height, dpr }) => [width, height, dpr]))
      .toEqual([[1280, 900, 1], [768, 900, 1], [769, 900, 1], [320, 180, 2], [640, 450, 2]])
    expect(previewCases.find(value => value.name === `${colorScheme}-200pct-reflow-equivalent`)?.width).toBe(640)
  }
  expect(previewCases.filter(value => value.forcedColors === "active")).toHaveLength(1)
})

test("default verification is independent of an old baseline; explicit baseline requires both absolute inputs", () => {
  expect(parsePreviewArguments([])).toEqual({})
  expect(parsePreviewArguments(["--baseline", "/baseline/apps/web", "--baseline-manifest", "/baseline/manifest.json"]))
    .toEqual({ baseline: "/baseline/apps/web", manifest: "/baseline/manifest.json" })
  for (const args of [["--baseline", "/baseline"], ["--baseline", "relative", "--baseline-manifest", "/manifest.json"],
    ["--baseline", "/baseline", "--baseline-manifest", "relative"], ["--baseline-manifest", "/manifest.json", "--baseline", "/baseline"], ["--help"]]) {
    expect(() => parsePreviewArguments(args)).toThrow()
  }
})

test("preview headers are read from the exact Vercel rule and reject weaker CSP, missing or duplicate headers", () => {
  expect(readPreviewHeaders(config())).toEqual(expectedPreviewHeaders)
  const weak = config()
  weak.headers[0]!.headers[0]!.value += "; script-src 'unsafe-inline'"
  expect(() => readPreviewHeaders(weak)).toThrow()
  const duplicate = config()
  duplicate.headers[0]!.headers[1] = { ...duplicate.headers[0]!.headers[0]! }
  expect(() => readPreviewHeaders(duplicate)).toThrow()
  const missing = config()
  missing.headers[0]!.headers.pop()
  expect(() => readPreviewHeaders(missing)).toThrow()
  const repeated = config()
  repeated.headers.push(repeated.headers[0]!)
  expect(() => readPreviewHeaders(repeated)).toThrow()
  const ordinary = config()
  ordinary.headers[0]!.source = "/(.*)"
  expect(() => readPreviewHeaders(ordinary)).toThrow()
})

test("CSS resource admission permits only bounded local font references", () => {
  expect(resolvePreviewResource("./fonts/GeistMono[wght].woff2", "/assets/styles-abc.css"))
    .toBe("/assets/fonts/GeistMono[wght].woff2")
  expect(resolvePreviewResource("./NebulaSans-Book-hash.woff2", "/graphs/preview-foundation/assets/style.css"))
    .toBe("/graphs/preview-foundation/assets/NebulaSans-Book-hash.woff2")
  for (const reference of ["https://example.test/font.woff2", "//example.test/font.woff2", "data:font/woff2,x", "../font.woff2",
    "./font.woff2?x", "./font.woff2#x", "./font%2ewoff2", "./image.png", "./font.woff2 ", "./font\\x.woff2", "x".repeat(513)]) {
    expect(() => resolvePreviewResource(reference, "/assets/style.css")).toThrow()
  }
})

test("old baseline manifest binds the exact revision and complete artifact bytes, not an approximate stylesheet", () => {
  const artifacts: PreviewArtifact[] = Array.from({ length: 15 }, (_, index) => ({ path: `artifact-${index}`, bytes: index + 1, sha256: "a".repeat(64) }))
  const manifest = { schemaVersion: 1, sourceRevision: baselineRevision, artifacts }
  expect(() => assertBaselineManifest(manifest, artifacts)).not.toThrow()
  expect(() => assertBaselineManifest({ ...manifest, sourceRevision: "main" }, artifacts)).toThrow()
  expect(() => assertBaselineManifest({ ...manifest, schemaVersion: 2 }, artifacts)).toThrow()
  expect(() => assertBaselineManifest({ ...manifest, approximation: true }, artifacts)).toThrow()
  expect(() => assertBaselineManifest(manifest, artifacts.slice(1))).toThrow()
  expect(() => assertBaselineManifest(manifest, artifacts.map((artifact, index) => index === 0 ? { ...artifact, sha256: "b".repeat(64) } : artifact))).toThrow()
})

test("layout acceptance rejects actions, font fallback, wrong breakpoints, clipping and nonfinite geometry", () => {
  expect(() => assertPreviewEvidence(evidence(), scenario)).not.toThrow()
  for (const patch of [{ actions: 1 }, { loadedFonts: 0 }, { columns: 4 }, { dpr: 1 }, { dark: true },
    { theme: "light" }, { maxScrollY: 0 }, { reachedScrollY: 0 }, { width: Number.NaN }, { failures: ["clipped"] }]) {
    expect(() => assertPreviewEvidence({ ...evidence(), ...patch }, scenario)).toThrow()
  }
  const hidden = evidence()
  expect(() => assertPreviewEvidence({ ...hidden, elements: hidden.elements.map((element, index) => index === 0 ? { ...element, rect: [0, 0, 0, 10] } : element) }, scenario)).toThrow()
  const nonfinite = evidence()
  expect(() => assertPreviewEvidence({ ...nonfinite, elements: nonfinite.elements.map((element, index) => index === 0 ? { ...element, rect: [Infinity, 0, 100, 10] } : element) }, scenario)).toThrow()
})

test("same-browser parity tolerates half a CSS pixel but detects disabled styles, changed text and geometry", () => {
  const original = evidence()
  expect(() => comparePreviewEvidence(evidence(), original)).not.toThrow()
  const changed = (rect: readonly number[]) => ({ ...original, elements: original.elements.map((element, index) => index === 0 ? { ...element, rect } : element) })
  expect(() => comparePreviewEvidence(changed([0.5, 0, 100, 10]), original)).not.toThrow()
  expect(() => comparePreviewEvidence(changed([0.51, 0, 100, 10]), original)).toThrow()
  expect(() => comparePreviewEvidence(changed([NaN, 0, 100, 10]), original)).toThrow()
  expect(() => comparePreviewEvidence({ ...original, text: "Changed" }, original)).toThrow()
  const disabled = { ...original, elements: original.elements.map(element => ({ ...element, styles: { color: "rgb(255, 0, 0)" } })) }
  expect(() => comparePreviewEvidence(disabled, original)).toThrow()
  expect(() => comparePreviewEvidence(original, evidence())).not.toThrow()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(accept => { resolve = accept })
  return { promise, resolve }
}

test("endpoint event admission handles basename, full-path, byte and missing filenames without admitting unrelated paths", () => {
  const profile = "/private/tmp/owned-profile"
  for (const filename of ["DevToolsActivePort", `${profile}/DevToolsActivePort`, Buffer.from("DevToolsActivePort"), null, undefined, ""]) {
    expect(isPreviewEndpointEvent(filename, profile)).toBe(true)
  }
  for (const filename of ["Default", "/other/DevToolsActivePort", "../DevToolsActivePort", {}, 1]) {
    expect(isPreviewEndpointEvent(filename, profile)).toBe(false)
  }
})

test("endpoint bytes bind one finite local port and Chrome browser path", () => {
  expect(parsePreviewEndpoint("12345\n/devtools/browser/abcd-1234\n"))
    .toEqual({ port: 12345, browserPath: "/devtools/browser/abcd-1234" })
  for (const value of ["", "0\n/devtools/browser/abcd", "65536\n/devtools/browser/abcd", "1234\nhttps://example.test/", "1234\n/devtools/page/abcd", "1234\n/devtools/browser/abcd\nextra", "x".repeat(1025)]) {
    expect(() => parsePreviewEndpoint(value)).toThrow()
  }
})

function signals() {
  const listeners = new Map<string, Set<() => void>>()
  const source: PreviewSignalSource = {
    on(name, listener) {
      const set = listeners.get(name) ?? new Set<() => void>()
      set.add(listener)
      listeners.set(name, set)
    },
    off(name, listener) { listeners.get(name)?.delete(listener) },
  }
  return { source,
    emit(name: "SIGINT" | "SIGTERM") { for (const listener of listeners.get(name) ?? []) listener() },
    count() { return [...listeners.values()].reduce((count, set) => count + set.size, 0) },
  }
}

for (const phase of ["startup", "connected case"] as const) {
  test(`cancellation during ${phase} awaits collection and latches repeated signals`, async () => {
    const source = signals()
    const entered = deferred()
    const collecting = deferred()
    const collected = deferred()
    const active = deferred()
    let completed = false
    const completion = withPreviewCancellation(source.source, async cancellation => {
      entered.resolve()
      await cancellation.wait(() => active.promise)
      throw new Error("Cancelled verification unexpectedly continued")
    }, async () => {
      collecting.resolve()
      await collected.promise
    }).then(() => undefined, error => error as unknown).finally(() => { completed = true })
    await entered.promise
    expect(source.count()).toBe(2)
    source.emit("SIGTERM")
    await collecting.promise
    source.emit("SIGINT")
    expect(source.count()).toBe(2)
    expect(completed).toBe(false)
    collected.resolve()
    const error = await completion
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors.map(error => String(error))).toEqual(["Error: Preview verification cancelled by SIGTERM"])
    expect(source.count()).toBe(0)
    // Late protocol settlement cannot turn cancellation into success.
    active.resolve()
  })
}

test("cancelled verification admits no subsequent operation and still collects resources", async () => {
  const source = signals()
  let admitted = false
  let collected = false
  await expect(withPreviewCancellation(source.source, async cancellation => {
    source.emit("SIGINT")
    return cancellation.wait(async () => { admitted = true })
  }, async () => { collected = true })).rejects.toThrow("Preview verification or resource collection failed")
  expect(admitted).toBe(false)
  expect(collected).toBe(true)
  expect(source.count()).toBe(0)
})

test("a signal during cleanup prevents a successful verification result", async () => {
  const source = signals()
  const collecting = deferred()
  const collected = deferred()
  const completion = withPreviewCancellation(source.source, async () => "verified", async () => {
    collecting.resolve()
    await collected.promise
  }).then(() => undefined, error => error as unknown)
  await collecting.promise
  source.emit("SIGTERM")
  collected.resolve()
  expect(await completion).toBeInstanceOf(AggregateError)
  expect(source.count()).toBe(0)
})

test("cancellation does not hide failed collection and ordinary completion removes signal listeners", async () => {
  const source = signals()
  const cleanupFailure = new Error("Owned browser process-group absence is unproved")
  const result = await withPreviewCancellation(source.source, async cancellation => {
    source.emit("SIGTERM")
    return cancellation.wait(async () => "unreachable")
  }, async () => { throw cleanupFailure }).then(() => undefined, error => error as unknown)
  expect(result).toBeInstanceOf(AggregateError)
  expect((result as AggregateError).errors).toContain(cleanupFailure)
  expect((result as AggregateError).errors).toHaveLength(2)
  expect(source.count()).toBe(0)
  let collected = false
  expect(await withPreviewCancellation(source.source, async cancellation => cancellation.wait(async () => "verified"), async () => { collected = true })).toBe("verified")
  expect(collected).toBe(true)
  expect(source.count()).toBe(0)
})
