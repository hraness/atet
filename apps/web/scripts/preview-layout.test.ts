import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { VerificationServerOutputTimeoutError, type VerificationOutputSnapshot } from "@hraness/direct/tooling/browser-verification"
import {
  assertBaselineManifest, assertPreviewEvidence, baselineRevision, comparePreviewEvidence,
  expectedPreviewHeaders, parsePreviewArguments, previewCases, readPreviewHeaders, resolvePreviewResource,
  createPreviewEndpointWaiter, parsePreviewEndpoint, withPreviewCancellation,
  capturePreviewOutputTimeout, previewFailureSummary, runPreviewCli,
  type EndpointEvidence, type PreviewArtifact, type PreviewCase, type PreviewEvidence, type PreviewSignalSource,
} from "./verify-preview-layout"

function outputSnapshot(state: "pending" | "eof" | "error"): VerificationOutputSnapshot {
  const counts = { bytesRead: 37, chunksRead: 2, countersSaturated: false, tail: "private native output" }
  const stream = state === "pending" ? { ...counts, state, inFlightRead: true as const }
    : state === "eof" ? { ...counts, state, inFlightRead: false as const }
      : { ...counts, state, inFlightRead: false as const, error: "private stream failure" }
  return { schema: "direct.verification-output/v1", stdout: stream, stderr: stream }
}

test("private timeout evidence preserves role and detached immutable pending, EOF and error snapshots", () => {
  for (const role of ["worker", "chrome"] as const) for (const state of ["pending", "eof", "error"] as const) {
    const original = outputSnapshot(state)
    const failure = new VerificationServerOutputTimeoutError(5_000, { outputSnapshot: () => original })
    const evidence = capturePreviewOutputTimeout(role, failure)
    expect(evidence).toEqual({ role, source: "direct-output-timeout", outputSnapshot: original })
    expect(evidence?.outputSnapshot).not.toBe(failure.outputSnapshot)
    expect(evidence?.outputSnapshot?.stdout).not.toBe(failure.outputSnapshot?.stdout)
    expect(Object.isFrozen(evidence)).toBe(true)
    expect(Object.isFrozen(evidence?.outputSnapshot)).toBe(true)
    expect(Object.isFrozen(evidence?.outputSnapshot?.stdout)).toBe(true)
    expect(Object.isFrozen(evidence?.outputSnapshot?.stderr)).toBe(true)
    Reflect.set(original.stdout, "state", "later-state")
    expect(evidence?.outputSnapshot?.stdout.state).toBe(state)
    expect(JSON.stringify(evidence)).toContain("private native output")
  }
})

test("absent and failed Direct snapshot capture remain unknown, never synthetic EOF", () => {
  expect(capturePreviewOutputTimeout("chrome", new Error("ordinary cleanup failure"))).toBeUndefined()
  const missing = new VerificationServerOutputTimeoutError(5_000, {})
  expect(capturePreviewOutputTimeout("chrome", missing)).toEqual({ role: "chrome",
    source: "direct-output-timeout", outputSnapshot: null })
  const unavailable = new VerificationServerOutputTimeoutError(5_000, {
    outputSnapshot() { throw new Error("diagnostic capture unavailable") },
  })
  expect(capturePreviewOutputTimeout("worker", unavailable)).toEqual({ role: "worker",
    source: "direct-output-timeout", outputSnapshot: null, outputSnapshotFailure: "diagnostic capture unavailable" })
})

test("malformed or accessor-backed timeout fields cannot replace the cleanup failure", () => {
  let getterReads = 0
  const accessor = Object.create(VerificationServerOutputTimeoutError.prototype) as unknown
  Object.defineProperty(accessor, "outputSnapshot", { get() { getterReads += 1; throw new Error("private getter") } })
  expect(capturePreviewOutputTimeout("chrome", accessor)).toEqual({ role: "chrome", source: "direct-output-timeout",
    outputSnapshot: null, outputSnapshotFailure: "Direct deadline snapshot was unavailable or invalid" })
  expect(getterReads).toBe(0)
  for (const patch of [{ bytesRead: -1 }, { chunksRead: Number.POSITIVE_INFINITY },
    { tail: "x".repeat(12_001) }, { state: "eof", inFlightRead: true },
    { state: "error", inFlightRead: false, error: "x".repeat(1025) }]) {
    const snapshot = outputSnapshot("pending")
    const malformed = Object.assign(Object.create(VerificationServerOutputTimeoutError.prototype) as object, {
      outputSnapshot: { ...snapshot, stdout: { ...snapshot.stdout, ...patch } },
    })
    const evidence = capturePreviewOutputTimeout("worker", malformed)
    expect(evidence?.outputSnapshot).toBeNull()
    expect(evidence?.outputSnapshotFailure).toBe("Direct deadline snapshot was unavailable or invalid")
  }
  for (const patch of [{ outputSnapshot: { schema: "unexpected" } },
    { outputSnapshotFailure: "x".repeat(1025) }]) {
    const malformed = Object.assign(Object.create(VerificationServerOutputTimeoutError.prototype) as object, patch)
    expect(capturePreviewOutputTimeout("chrome", malformed)?.outputSnapshot).toBeNull()
    expect(capturePreviewOutputTimeout("chrome", malformed)?.outputSnapshotFailure)
      .toBe("Direct deadline snapshot was unavailable or invalid")
  }
})

test("retaining deadline diagnostics cannot turn completed payload work into accepted custody", async () => {
  const failure = new VerificationServerOutputTimeoutError(5_000, { outputSnapshot: () => outputSnapshot("pending") })
  let accepted = false
  let retained: ReturnType<typeof capturePreviewOutputTimeout>
  const result = await withPreviewCancellation(signals().source, async () => "completed payload", async () => {
    retained = capturePreviewOutputTimeout("chrome", failure)
    throw failure
  }).then(() => { accepted = true }, error => error as unknown)
  expect(result).toBeInstanceOf(AggregateError)
  expect((result as AggregateError).errors).toEqual([failure])
  expect(retained?.outputSnapshot?.stdout.state).toBe("pending")
  expect(accepted).toBe(false)
})

test("CLI summaries omit private tails, causes, serializers and hostile accessors", () => {
  const failure = new VerificationServerOutputTimeoutError(5_000, { outputSnapshot: () => outputSnapshot("error") })
  let getterReads = 0
  Object.defineProperty(failure, "cause", { get() { getterReads += 1; return "private cause" } })
  Object.defineProperty(failure, "toJSON", { value() { throw new Error("private serializer") } })
  const aggregate = new AggregateError([failure], "Preview resource collection failed")
  aggregate.errors.push(aggregate)
  const summary = previewFailureSummary(aggregate)
  expect(summary).toContain("verification server output did not settle within 5000ms after exit")
  expect(summary).not.toMatch(/private native output|private stream failure|private cause|outputSnapshot|toJSON/u)
  expect(getterReads).toBe(0)
  const hostile = Object.defineProperty({}, "message", { get() { getterReads += 1; throw new Error("private message") } })
  expect(previewFailureSummary(hostile)).toContain("Unreadable verification failure")
  expect(getterReads).toBe(0)
  const excessive = new AggregateError(Array.from({ length: 100 }, () => new Error("\u0000".repeat(10_000))), "large aggregate")
  expect(Buffer.byteLength(previewFailureSummary(excessive))).toBeLessThanOrEqual(16_512)
})

test("CLI failure waits for private persistence and cleanup, then reports only text and nonzero", async () => {
  const finish = deferred()
  const failure = new VerificationServerOutputTimeoutError(5_000, { outputSnapshot: () => outputSnapshot("pending") })
  const calls: string[] = []
  let exitCode = 0
  const completion = runPreviewCli([], {
    async verify() { calls.push("verify"); await finish.promise; calls.push("private receipt and cleanup settled"); throw failure },
    fail() { exitCode = 1; calls.push("nonzero") },
    report(message) { expect(typeof message).toBe("string"); expect(message).not.toContain("private native output"); calls.push("summary") },
  })
  expect(exitCode).toBe(0)
  expect(calls).toEqual(["verify"])
  finish.resolve()
  await completion
  expect(exitCode).toBe(1)
  expect(calls).toEqual(["verify", "private receipt and cleanup settled", "nonzero", "summary"])
  const success: string[] = []
  await runPreviewCli([], { async verify() { success.push("verified") }, fail() { success.push("failed") }, report() { success.push("reported") } })
  expect(success).toEqual(["verified"])
})

test("deadline diagnostics stay in the private write-once receipt and never the public result", async () => {
  const source = await readFile(new URL("./verify-preview-layout.ts", import.meta.url), "utf8")
  expect(source).toContain('}, "worker")')
  expect(source).toContain('}, "chrome")')
  expect(source).toContain('await writeFile(path, receipt, { flag: "wx", mode: 0o600 })')
  expect(source).toContain("Buffer.byteLength(receipt) <= 1024 * 1024")
  expect(source).toContain("console.log(JSON.stringify({ ...record(result), processGroupAbsent, workerProcessGroupAbsent, evidenceDirectory: profile }))")
  expect(source).toContain("if (import.meta.main) await runPreviewCli")
  expect(source).not.toContain("console.error(error)")
})

function config() {
  return { headers: [{ source: "/preview", headers: Object.entries(expectedPreviewHeaders).map(([key, value]) => ({ key, value: String(value) })) }] }
}

const scenario: PreviewCase = { name: "fixture", width: 320, height: 180, dpr: 2, colorScheme: "light", forcedColors: "none" }

function evidence(): PreviewEvidence {
  return {
    width: 320, height: 180, dpr: 2, theme: "system", dark: false, forcedColors: false,
    columns: 2, actions: 0, loadedFonts: 2, text: "Slopcamera", maxScrollY: 240, reachedScrollY: 240,
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

test("endpoint bytes bind one finite local port and Chrome browser path", () => {
  expect(parsePreviewEndpoint("12345\n/devtools/browser/abcd-1234\n"))
    .toEqual({ port: 12345, browserPath: "/devtools/browser/abcd-1234" })
  for (const value of ["", "0\n/devtools/browser/abcd", "65536\n/devtools/browser/abcd", "1234\nhttps://example.test/", "1234\n/devtools/page/abcd", "1234\n/devtools/browser/abcd\nextra", "x".repeat(1025)]) {
    expect(() => parsePreviewEndpoint(value)).toThrow()
  }
})

async function flushReadiness() {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
}

function readinessClock() {
  let now = 0
  let nextId = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  return {
    now: () => now,
    schedule(callback: () => void, delayMs: number) {
      const id = ++nextId
      timers.set(id, { at: now + delayMs, callback })
      return () => { timers.delete(id) }
    },
    async advance(ms: number) {
      const target = now + ms
      await flushReadiness()
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (next === undefined || next[1].at > target) break
        now = next[1].at
        timers.delete(next[0])
        next[1].callback()
        await flushReadiness()
      }
      now = target
      await flushReadiness()
    },
    // Model a busy event loop whose absolute clock advances before timers run.
    elapse(ms: number) { now += ms },
    pending: () => timers.size,
  }
}

const endpointBytes = Buffer.from("12345\n/devtools/browser/abcd-1234\n")

function pendingEndpointRead() {
  let resolve!: (bytes: Uint8Array) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Uint8Array>((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}

function readinessHarness(read: (attempt: number) => Promise<Uint8Array>) {
  const clock = readinessClock()
  const controller = new AbortController()
  const exited = deferred()
  const evidence: EndpointEvidence = { deadlineMs: 10_000, attempts: 0 }
  const requests: { path: string; maximum: number }[] = []
  let active = 0
  let maximumActive = 0
  let settled = false
  const wait = createPreviewEndpointWaiter({ ...clock, async read(path, maximum) {
    requests.push({ path, maximum })
    active += 1
    maximumActive = Math.max(maximumActive, active)
    try { return await read(requests.length) } finally { active -= 1 }
  } })
  const result: Promise<{ value?: string; error?: unknown }> = wait("/private/tmp/owned-profile", exited.promise, controller.signal, evidence)
    .then(value => ({ value }), error => ({ error: error as unknown })).finally(() => { settled = true })
  return { clock, controller, exited, evidence, requests, result,
    maximumActive: () => maximumActive, settled: () => settled }
}

test("endpoint readiness discovers a valid file after an absent initial read without filesystem notifications", async () => {
  const fixture = readinessHarness(async attempt => {
    if (attempt === 1) throw Object.assign(new Error("absent"), { code: "ENOENT" })
    return endpointBytes
  })
  await fixture.clock.advance(49)
  expect(fixture.requests).toEqual([{ path: "/private/tmp/owned-profile/DevToolsActivePort", maximum: 1024 }])
  expect(fixture.settled()).toBe(false)
  await fixture.clock.advance(1)
  expect(await fixture.result).toEqual({ value: "ws://127.0.0.1:12345/devtools/browser/abcd-1234" })
  expect(fixture.evidence).toMatchObject({ attempts: 2, outcome: "connected", lastRead: { elapsedMs: 50, bytes: endpointBytes.length } })
  expect(fixture.maximumActive()).toBe(1)
  expect(fixture.clock.pending()).toBe(0)
})

test("endpoint readiness has one absolute ten-second deadline and at most 201 strict reads", async () => {
  const fixture = readinessHarness(async () => Buffer.from("malformed"))
  await fixture.clock.advance(10_000)
  const result = await fixture.result
  expect(result.error).toBeInstanceOf(Error)
  expect((result.error as Error).message).toBe("Chrome endpoint startup timed out")
  expect(fixture.evidence.outcome).toBe("timeout")
  expect(fixture.evidence.attempts).toBe(200)
  expect(fixture.evidence.attempts).toBeLessThanOrEqual(201)
  expect(fixture.requests.every(request => request.maximum === 1024)).toBe(true)
  expect(fixture.maximumActive()).toBe(1)
  expect(fixture.clock.pending()).toBe(0)
})

test("endpoint readiness never overlaps reads and retries only after a changed read has settled", async () => {
  const pending = pendingEndpointRead()
  const fixture = readinessHarness(async attempt => attempt === 1 ? pending.promise : endpointBytes)
  await fixture.clock.advance(500)
  expect(fixture.requests).toHaveLength(1)
  expect(fixture.settled()).toBe(false)
  pending.reject(new Error("Preview file changed before reading"))
  await flushReadiness()
  await fixture.clock.advance(49)
  expect(fixture.requests).toHaveLength(1)
  await fixture.clock.advance(1)
  expect(await fixture.result).toEqual({ value: "ws://127.0.0.1:12345/devtools/browser/abcd-1234" })
  expect(fixture.maximumActive()).toBe(1)
  expect(fixture.clock.pending()).toBe(0)
})

test("endpoint readiness does not accept malformed, excessive or identity-refused reads", async () => {
  const fixture = readinessHarness(async attempt => {
    if (attempt === 1) return Buffer.from("12345\n/devtools/page/abcd-1234\n")
    if (attempt === 2) return Buffer.from("x".repeat(1025))
    if (attempt === 3) throw new Error("Preview descriptor changed while reading")
    return endpointBytes
  })
  await fixture.clock.advance(100)
  expect(fixture.settled()).toBe(false)
  expect(fixture.evidence).toMatchObject({ attempts: 3, lastRead: { error: { message: "Preview descriptor changed while reading" } } })
  await fixture.clock.advance(50)
  expect(await fixture.result).toEqual({ value: "ws://127.0.0.1:12345/devtools/browser/abcd-1234" })
  expect(fixture.evidence.attempts).toBe(4)
  expect(fixture.clock.pending()).toBe(0)
})

for (const terminal of ["timeout", "cancelled", "exited"] as const) {
  test(`endpoint ${terminal} stays terminal after a late successful read`, async () => {
    const pending = pendingEndpointRead()
    const fixture = readinessHarness(async () => pending.promise)
    if (terminal === "timeout") await fixture.clock.advance(10_000)
    else if (terminal === "cancelled") fixture.controller.abort(new Error("cancelled fixture"))
    else fixture.exited.resolve()
    const result = await fixture.result
    expect(result.error).toBeInstanceOf(Error)
    expect(fixture.evidence.outcome).toBe(terminal)
    const before = structuredClone(fixture.evidence)
    pending.resolve(endpointBytes)
    await flushReadiness()
    expect(fixture.evidence).toEqual(before)
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.clock.pending()).toBe(0)
  })
}

test("a delayed deadline callback cannot admit endpoint bytes completed after ten seconds", async () => {
  const pending = pendingEndpointRead()
  const fixture = readinessHarness(async () => pending.promise)
  fixture.clock.elapse(10_001)
  pending.resolve(endpointBytes)
  const result = await fixture.result
  expect(result.error).toBeInstanceOf(Error)
  expect(fixture.evidence.outcome).toBe("timeout")
  expect(fixture.evidence.attempts).toBe(1)
  expect(fixture.clock.pending()).toBe(0)
})

test("endpoint cancellation between reads prevents any subsequent read", async () => {
  const fixture = readinessHarness(async () => { throw new Error("absent") })
  await fixture.clock.advance(25)
  fixture.controller.abort(new Error("cancelled fixture"))
  expect((await fixture.result).error).toBeInstanceOf(Error)
  await fixture.clock.advance(10_000)
  expect(fixture.requests).toHaveLength(1)
  expect(fixture.evidence.outcome).toBe("cancelled")
  expect(fixture.clock.pending()).toBe(0)
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
