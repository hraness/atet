import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { delimiter } from "node:path"
import { previewNodeCandidates } from "./build-preview-browser-driver"
import { assertOwnedPreviewEndpoint, createPreviewBrowserShutdown, previewBrowserCloseMs } from "./preview-browser-shutdown"
import { expectedPreviewHeaders, previewCases, withPreviewCancellation, type PreviewSignalSource } from "./preview-browser-contract"
import { assertNodeRuntime, assertWorkerInputsUnchanged, assertWorkerProtocolSnapshot, createWorkerInputReader, createWorkerObserver, decodeWorkerJson, encodeWorkerJson,
  parseWorkerPhase, parseWorkerRequest, workerCasesDeadline, workerPhaseFiles, workerProtocolLimit,
  type PreviewWorkerRequest, type PreviewWorkerResult, type WorkerInputSnapshot, type WorkerObservation } from "./preview-browser-protocol"

function request(): PreviewWorkerRequest {
  const stylesheets = ["/assets/foundation.css", "/assets/recipes.css"]
  return { schemaVersion: 1, token: "12345678-abcd-1234-abcd-123456789abc", appDirectory: "/private/tmp/app",
    endpoint: "ws://127.0.0.1:12345/devtools/browser/abcd-1234", current: {
      origin: "http://127.0.0.1:12346", headers: expectedPreviewHeaders, stylesheets,
      resources: ["/preview", ...stylesheets, ...Array.from({ length: 13 }, (_, index) => `/assets/font-${index}.woff2`)].sort(),
    }, baseline: null }
}

function phases(input = request()): readonly Uint8Array[] {
  const common = { schemaVersion: 1, token: input.token }
  const runtime = { node: "24.13.0", playwright: "1.62.0" }
  return [
    { ...common, sequence: 0, kind: "started", ...runtime },
    { ...common, sequence: 1, kind: "connected" },
    { ...common, sequence: 2, kind: "result", ...runtime, browser: "123.0.0.0", closed: true,
      baselineCompared: input.baseline !== null,
      cases: previewCases.map(scenario => ({ ...scenario, columns: scenario.width <= 768 ? 2 : 4, maxScrollY: scenario.height === 180 ? 200 : 0 })) },
  ].map(encodeWorkerJson)
}

test("worker accepts only genuine Node 24 and an explicit executable, never the Bun execPath", () => {
  expect(assertNodeRuntime({ node: "24.13.0" })).toBe("24.13.0")
  for (const versions of [{ node: "24.13.0", bun: "1.3.14" }, { node: "22.0.0" }, { node: "24" }, {}, { node: "24.1.0-extra" }]) {
    expect(() => assertNodeRuntime(versions)).toThrow()
  }
  expect(previewNodeCandidates({ NODE_EXECUTABLE_PATH: "/exact/node", PATH: "/other" })).toEqual(["/exact/node"])
  expect(() => previewNodeCandidates({ NODE_EXECUTABLE_PATH: "node" })).toThrow()
  expect(previewNodeCandidates({ PATH: ["relative", "", "/one", "/two", "/one"].join(delimiter) })).toEqual(["/one/node", "/two/node"])
})

test("worker JSON is finite canonical UTF-8 with no duplicate keys, trailing or truncated values", () => {
  expect(decodeWorkerJson(encodeWorkerJson({ schemaVersion: 1 }))).toEqual({ schemaVersion: 1 })
  for (const bytes of [Buffer.from('{"schemaVersion":1,"schemaVersion":1}\n'), Buffer.from('{"schemaVersion":'),
    Buffer.from('{}\n{}\n'), Buffer.from('{}'), Buffer.from('{ "x": 1 }\n'), Buffer.from([0xff, 10]),
    Buffer.from("x".repeat(workerProtocolLimit + 1))]) {
    expect(() => decodeWorkerJson(bytes)).toThrow()
  }
})

test("worker input retains exact closure, headers, local origins and explicit app root", () => {
  const original = request()
  expect(parseWorkerRequest(original)).toEqual(original)
  for (const patch of [{ extra: true }, { appDirectory: "relative" }, { token: "other-run" },
    { endpoint: "ws://example.test:12345/devtools/browser/abcd" }, { endpoint: "ws://127.0.0.1:0/devtools/browser/abcd" },
    { endpoint: "ws://127.0.0.1:12345/devtools/page/abcd" },
    { current: { ...original.current, origin: "http://127.0.0.1:12346/" } },
    { current: { ...original.current, origin: "http://example.test:12346" } },
    { current: { ...original.current, headers: { ...expectedPreviewHeaders, "content-security-policy": "default-src *" } } },
    { current: { ...original.current, resources: original.current.resources.slice(1) } },
    { current: { ...original.current, resources: [...original.current.resources, "/script.js"].sort() } },
    { baseline: original.current }]) {
    expect(() => parseWorkerRequest({ ...original, ...patch })).toThrow()
  }
  const baseline = { ...original.current, stylesheets: original.current.stylesheets.slice(0, 1),
    resources: original.current.resources.filter(path => path !== original.current.stylesheets[1]) }
  expect(parseWorkerRequest({ ...original, baseline }).baseline).toEqual(baseline)
  expect(workerCasesDeadline(original)).toBe(340_000)
  expect(workerCasesDeadline({ ...original, baseline })).toBe(670_000)
})

test("worker phases bind one ordered run, exact runtime, complete matrix and completed protocol close", () => {
  const input = request()
  const values = phases().map(decodeWorkerJson)
  for (const sequence of [0, 1, 2] as const) expect<unknown>(parseWorkerPhase(values[sequence], sequence, input)).toEqual(values[sequence])
  const result = values[2] as PreviewWorkerResult
  for (const patch of [{ token: "aaaaaaaa-abcd-1234-abcd-123456789abc" }, { sequence: 1 }, { kind: "connected" },
    { closed: false }, { node: "22.1.0" }, { playwright: "1.61.0" }, { baselineCompared: true }, { extra: 1 },
    { cases: result.cases.slice(1) }, { cases: [...result.cases].reverse() },
    { cases: result.cases.map((row, index) => index === 0 ? { ...row, columns: 2 } : row) },
    { cases: result.cases.map((row, index) => index === 0 ? { ...row, maxScrollY: NaN } : row) }]) {
    expect(() => parseWorkerPhase({ ...result, ...patch }, 2, input)).toThrow()
  }
  expect(() => parseWorkerPhase(values[2], 1, input)).toThrow()
})

async function flush() { for (let turn = 0; turn < 8; turn += 1) await Promise.resolve() }
function pending<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, refuse) => { resolve = accept; reject = refuse })
  return { promise, resolve, reject }
}

function clock() {
  let now = 0
  let id = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  return { now: () => now, schedule(callback: () => void, delay: number) {
    const key = ++id
    timers.set(key, { at: now + delay, callback })
    return () => { timers.delete(key) }
  }, async advance(ms: number) {
    const target = now + ms
    await flush()
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (next === undefined || next[1].at > target) break
      now = next[1].at
      timers.delete(next[0])
      next[1].callback()
      await flush()
    }
    now = target
    await flush()
  }, elapse(ms: number) { now += ms }, pending: () => timers.size }
}

function observer(read: (path: string, attempt: number) => Promise<Uint8Array>) {
  const time = clock()
  const controller = new AbortController()
  const exited = pending<unknown>()
  let connected = 0
  let active = 0
  let maximumActive = 0
  const requests: { path: string; maximum: number }[] = []
  const observe = createWorkerObserver({ ...time, async read(path, maximum) {
    requests.push({ path, maximum })
    active += 1
    maximumActive = Math.max(maximumActive, active)
    try { return await read(path, requests.length) } finally { active -= 1 }
  } })
  const result = observe("/private/tmp/owned/worker-protocol", request(), controller.signal, exited.promise, () => { connected += 1 })
    .then(value => ({ value }), error => ({ error: error as unknown }))
  return { time, controller, exited, requests, result, connected: () => connected, maximumActive: () => maximumActive }
}

test("worker observer emits one live connected phase and admits one bounded complete result", async () => {
  const fixture = observer(async (_path, attempt) => phases()[attempt - 1]!)
  await fixture.time.advance(100)
  const result = await fixture.result
  expect("value" in result).toBe(true)
  expect(fixture.connected()).toBe(1)
  expect(fixture.requests.map(value => value.path.split("/").at(-1))).toEqual([...workerPhaseFiles])
  expect(fixture.requests.every(value => value.maximum === workerProtocolLimit)).toBe(true)
  expect(fixture.maximumActive()).toBe(1)
  expect(fixture.time.pending()).toBe(0)
})

test("worker observer retries only absent files and never overlaps a pending strict read", async () => {
  const read = pending<Uint8Array>()
  const fixture = observer(async (_path, attempt) => attempt === 1 ? read.promise : phases()[attempt - 2]!)
  await fixture.time.advance(500)
  expect(fixture.requests).toHaveLength(1)
  read.reject(Object.assign(new Error("absent"), { code: "ENOENT" }))
  await flush()
  await fixture.time.advance(150)
  expect("value" in await fixture.result).toBe(true)
  expect(fixture.maximumActive()).toBe(1)
  expect(fixture.time.pending()).toBe(0)
})

test("worker observer rejects visible malformed, truncated, identity-refused and wrong-sequence results", async () => {
  for (const failure of [Buffer.from('{"kind":'), phases()[2]!, encodeWorkerJson({ sequence: 0 }), new Error("File changed")]) {
    const fixture = observer(async () => { if (failure instanceof Error) throw failure; return failure })
    expect("error" in await fixture.result).toBe(true)
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.connected()).toBe(0)
    expect(fixture.time.pending()).toBe(0)
  }
})

for (const terminal of ["cancelled", "timeout", "delayed-timer"] as const) {
  test(`worker ${terminal} rejects a late successful phase without changing live markers`, async () => {
    const read = pending<Uint8Array>()
    const fixture = observer(async () => read.promise)
    if (terminal === "cancelled") fixture.controller.abort(new Error("cancelled"))
    else if (terminal === "timeout") await fixture.time.advance(10_000)
    else fixture.time.elapse(10_001)
    read.resolve(phases()[0]!)
    expect("error" in await fixture.result).toBe(true)
    await flush()
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.connected()).toBe(0)
    expect(fixture.time.pending()).toBe(0)
  })
}

test("connected-phase cancellation cannot be overwritten by a late worker result", async () => {
  const read = pending<Uint8Array>()
  const fixture = observer(async (_path, attempt) => attempt < 3 ? phases()[attempt - 1]! : read.promise)
  await fixture.time.advance(100)
  expect(fixture.connected()).toBe(1)
  fixture.controller.abort(new Error("cancelled after attachment"))
  expect("error" in await fixture.result).toBe(true)
  read.resolve(phases()[2]!)
  await fixture.time.advance(50)
  expect(fixture.requests).toHaveLength(3)
  expect(fixture.connected()).toBe(1)
  expect(fixture.time.pending()).toBe(0)
})

test("worker exit without complete result is failure, not a success receipt", async () => {
  const fixture = observer(async () => { throw Object.assign(new Error("absent"), { code: "ENOENT" }) })
  fixture.exited.resolve(0)
  await fixture.time.advance(50)
  expect("error" in await fixture.result).toBe(true)
  expect(fixture.connected()).toBe(0)
  expect(fixture.time.pending()).toBe(0)
})

test("post-collection snapshot rejects duplicate, missing, partial and rewritten protocol files", () => {
  const bytes = phases()
  const observation: WorkerObservation = { result: decodeWorkerJson(bytes[2]!) as PreviewWorkerResult, phases: bytes }
  const inventory = workerPhaseFiles.flatMap(name => [name, `.${name}.tmp`])
  expect(() => assertWorkerProtocolSnapshot(inventory, bytes, observation)).not.toThrow()
  for (const entries of [inventory.slice(1), [...inventory, "result-2.json"], [...inventory, "result.json"], [...inventory, ".extra.tmp"]]) {
    expect(() => assertWorkerProtocolSnapshot(entries, bytes, observation)).toThrow()
  }
  expect(() => assertWorkerProtocolSnapshot(inventory, bytes.slice(1), observation)).toThrow()
  expect(() => assertWorkerProtocolSnapshot(inventory, [bytes[0]!, bytes[1]!, Buffer.from("changed")], observation)).toThrow()
})

function inputStat() {
  return { dev: 1, ino: 2, size: 4, mode: 0o100600, nlink: 1, mtimeMs: 10, ctimeMs: 20, isFile: () => true }
}

function inputSnapshots(): readonly WorkerInputSnapshot[] {
  return ["driver.mjs", "request.json"].map(name => ({ path: `/private/tmp/owned/${name}`, maximum: 1024,
    identity: [1, 2, 4, 0o100600, 1, 10, 20], bytes: Buffer.from("test") }))
}

test("worker input capture retains independent bytes and rejects a descriptor identity race", async () => {
  const bytes = Buffer.from("test")
  const calls: string[] = []
  const read = createWorkerInputReader({ async stat(path) { calls.push(`stat:${path}`); return inputStat() },
    async read(path, maximum) { calls.push(`read:${path}:${maximum}`); return bytes } })
  const snapshot = await read("/private/tmp/owned/driver.mjs", 1024)
  bytes[0] = 0
  expect(Buffer.from(snapshot.bytes).toString()).toBe("test")
  expect(snapshot.identity).toEqual([1, 2, 4, 0o100600, 1, 10, 20])
  expect(calls).toEqual(["stat:/private/tmp/owned/driver.mjs", "read:/private/tmp/owned/driver.mjs:1024", "stat:/private/tmp/owned/driver.mjs"])
  let reads = 0
  const changed = createWorkerInputReader({ async stat() { return { ...inputStat(), ino: ++reads } }, async read() { return Buffer.from("test") } })
  await expect(changed("/private/tmp/owned/driver.mjs", 1024)).rejects.toThrow("Worker input changed")
  await expect(read("relative", 1024)).rejects.toThrow()
  await expect(read("/private/tmp/owned/driver.mjs", 256 * 1024 + 1)).rejects.toThrow()
})

test("post-collection input binding rejects changed request or driver bytes, inode, metadata, order or count", () => {
  const before = inputSnapshots()
  expect(() => assertWorkerInputsUnchanged(before, inputSnapshots())).not.toThrow()
  for (const target of [0, 1]) {
    const change = (patch: Partial<WorkerInputSnapshot>) => before.map((value, index) => index === target ? { ...value, ...patch } : value)
    expect(() => assertWorkerInputsUnchanged(before, change({ bytes: Buffer.from("edit") }))).toThrow("bytes changed")
    expect(() => assertWorkerInputsUnchanged(before, change({ path: "/private/tmp/other" }))).toThrow()
    expect(() => assertWorkerInputsUnchanged(before, change({ maximum: 2048 }))).toThrow()
    for (const field of [0, 1, 2, 3, 4, 5, 6]) {
      const identity = before[target]!.identity.map((value, index) => index === field ? value + 1 : value)
      expect(() => assertWorkerInputsUnchanged(before, change({ identity }))).toThrow("identity changed")
    }
  }
  expect(() => assertWorkerInputsUnchanged(before, [...before].reverse())).toThrow()
  expect(() => assertWorkerInputsUnchanged(before, before.slice(1))).toThrow()
})

test("late cancellation after successful postflight leaves input and protocol evidence intact", async () => {
  const listeners = new Map<string, Set<() => void>>()
  const source: PreviewSignalSource = {
    on(name, listener) { const set = listeners.get(name) ?? new Set<() => void>(); set.add(listener); listeners.set(name, set) },
    off(name, listener) { listeners.get(name)?.delete(listener) },
  }
  const entered = pending<void>()
  const finish = pending<void>()
  const inputs = inputSnapshots()
  const protocol = phases()
  let accepted = false
  const completion = withPreviewCancellation(source, async () => "verified", async () => {
    assertWorkerInputsUnchanged(inputs, inputSnapshots())
    entered.resolve()
    await finish.promise
  }).then(() => { accepted = true }, error => error as unknown)
  await entered.promise
  for (const listener of listeners.get("SIGTERM") ?? []) listener()
  finish.resolve()
  expect(await completion).toBeInstanceOf(AggregateError)
  expect(accepted).toBe(false)
  expect(inputs).toEqual(inputSnapshots())
  expect(protocol).toEqual(phases())
  expect([...listeners.values()].every(set => set.size === 0)).toBe(true)
  const parent = await readFile(new URL("./verify-preview-layout.ts", import.meta.url), "utf8")
  expect(parent).not.toMatch(/\b(?:rm|unlink|rmdir)\s*\(/u)
  expect(parent).toContain("evidenceDirectory: profile")
})

test("graceful close requires the exact endpoint from the parent-owned physical profile", () => {
  const endpoint = request().endpoint
  expect(() => assertOwnedPreviewEndpoint(Buffer.from("12345\n/devtools/browser/abcd-1234\n"), endpoint)).not.toThrow()
  for (const bytes of [Buffer.from("12346\n/devtools/browser/abcd-1234\n"), Buffer.from("12345\n/devtools/browser/other\n"),
    Buffer.from("12345\n/devtools/page/abcd-1234\n"), Buffer.from("0\n/devtools/browser/abcd\n"), Buffer.from("x".repeat(1025))]) {
    expect(() => assertOwnedPreviewEndpoint(bytes, endpoint)).toThrow()
  }
  expect(() => assertOwnedPreviewEndpoint(Buffer.from("12345\n/devtools/browser/abcd-1234\n"), "ws://example.test:12345/devtools/browser/abcd-1234")).toThrow()
})

function shutdownFixture(options: {
  proveOwnership?: () => Promise<void>
  send?: () => Promise<unknown>
  disconnect?: () => Promise<void>
} = {}) {
  const time = clock()
  const controller = new AbortController()
  const sendEntered = pending<void>()
  const calls: string[] = []
  let accepted = false
  const close = createPreviewBrowserShutdown(time)
  const run = () => close({ signal: controller.signal,
    async proveOwnership() { calls.push("owned"); await options.proveOwnership?.() },
    async createSession() { calls.push("session"); return { async send(method: "Browser.close") {
      calls.push(method)
      sendEntered.resolve()
      return options.send?.()
    } } },
    async disconnect() { calls.push("disconnect"); await options.disconnect?.() },
  }).then(() => { accepted = true }, error => error as unknown)
  return { time, controller, calls, run, sendEntered, accepted: () => accepted }
}

test("owned shutdown sends one browser close before one transport disconnect", async () => {
  const fixture = shutdownFixture()
  expect(await fixture.run()).toBeUndefined()
  expect(fixture.calls).toEqual(["owned", "session", "Browser.close", "disconnect"])
  expect(fixture.accepted()).toBe(true)
  expect(fixture.time.pending()).toBe(0)
  expect(previewBrowserCloseMs).toBe(5_000)
})

test("unproven ownership and pre-cancellation admit no browser close and no result", async () => {
  const refusal = new Error("unproven endpoint")
  const unowned = shutdownFixture({ async proveOwnership() { throw refusal } })
  const rejected = await unowned.run()
  expect(rejected).toBeInstanceOf(AggregateError)
  expect((rejected as AggregateError).errors[0]).toBe(refusal)
  expect(unowned.calls).toEqual(["owned", "disconnect"])
  expect(unowned.accepted()).toBe(false)
  const cancelled = shutdownFixture()
  cancelled.controller.abort(new Error("cancelled before shutdown"))
  expect(await cancelled.run()).toBeInstanceOf(AggregateError)
  expect(cancelled.calls).toEqual(["disconnect"])
  expect(cancelled.accepted()).toBe(false)
})

test("close-send failure remains first when transport disconnect also fails", async () => {
  const sendFailure = new Error("Browser.close rejected")
  const disconnectFailure = new Error("transport disconnect rejected")
  const fixture = shutdownFixture({ async send() { throw sendFailure }, async disconnect() { throw disconnectFailure } })
  const failure = await fixture.run()
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors).toEqual([sendFailure, disconnectFailure])
  expect(fixture.calls).toEqual(["owned", "session", "Browser.close", "disconnect"])
  expect(fixture.accepted()).toBe(false)
  expect(fixture.time.pending()).toBe(0)
})

test("an undefined protocol rejection remains a failure, never a success sentinel", async () => {
  const fixture = shutdownFixture({ send: () => Promise.reject(undefined) })
  const failure = await fixture.run()
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors).toEqual([undefined])
  expect(fixture.calls).toEqual(["owned", "session", "Browser.close", "disconnect"])
  expect(fixture.accepted()).toBe(false)
  expect(fixture.time.pending()).toBe(0)
})

for (const terminal of ["timeout", "cancelled", "delayed-timer"] as const) {
  test(`graceful close ${terminal} remains failed after late protocol settlement`, async () => {
    const send = pending<unknown>()
    const fixture = shutdownFixture({ send: () => send.promise })
    const completion = fixture.run()
    await fixture.sendEntered.promise
    if (terminal === "cancelled") fixture.controller.abort(new Error("shutdown cancelled"))
    else if (terminal === "timeout") await fixture.time.advance(5_000)
    else { fixture.time.elapse(5_001); send.resolve({}) }
    const failure = await completion
    expect(failure).toBeInstanceOf(AggregateError)
    expect(String((failure as AggregateError).errors[0])).toContain(terminal === "cancelled" ? "shutdown cancelled" : "exceeded 5000ms")
    expect(fixture.calls).toEqual(["owned", "session", "Browser.close", "disconnect"])
    expect(fixture.accepted()).toBe(false)
    send.resolve({})
    await flush()
    expect(fixture.accepted()).toBe(false)
    expect(fixture.time.pending()).toBe(0)
  })
}

test("shutdown admission, send and disconnect share one absolute five-second deadline", async () => {
  const fixture = shutdownFixture({
    async proveOwnership() { fixture.time.elapse(1_000) },
    async send() { fixture.time.elapse(3_999) },
    async disconnect() { fixture.time.elapse(1) },
  })
  expect(await fixture.run()).toBeInstanceOf(AggregateError)
  expect(fixture.calls).toEqual(["owned", "session", "Browser.close", "disconnect"])
  expect(fixture.accepted()).toBe(false)
  expect(fixture.time.now()).toBe(5_000)
  expect(fixture.time.pending()).toBe(0)
})

test("cancellation during transport disconnect still prevents a successful shutdown receipt", async () => {
  const entered = pending<void>()
  const disconnected = pending<void>()
  const fixture = shutdownFixture({ async disconnect() { entered.resolve(); await disconnected.promise } })
  const completion = fixture.run()
  await entered.promise
  const cancelled = new Error("cancelled during disconnect")
  fixture.controller.abort(cancelled)
  disconnected.resolve()
  const failure = await completion
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).errors).toEqual([cancelled])
  expect(fixture.calls).toEqual(["owned", "session", "Browser.close", "disconnect"])
  expect(fixture.accepted()).toBe(false)
  expect(fixture.time.pending()).toBe(0)
})

test("failed graceful cleanup cannot publish the provisional worker result", async () => {
  const source: PreviewSignalSource = { on() {}, off() {} }
  const sendFailure = new Error("Browser.close rejected")
  const close = createPreviewBrowserShutdown(clock())
  let published = false
  const completion = withPreviewCancellation(source, async () => phases()[2], async () => close({
    signal: new AbortController().signal,
    async proveOwnership() {},
    async createSession() { return { async send() { throw sendFailure } } },
    async disconnect() {},
  })).then(() => { published = true }, error => error as unknown)
  expect(await completion).toBeInstanceOf(AggregateError)
  expect(published).toBe(false)
})

test("private driver uses genuine Node and the explicit app root without importing Bun custody", async () => {
  const driver = await readFile(new URL("./preview-browser-driver.ts", import.meta.url), "utf8")
  const builder = await readFile(new URL("./build-preview-browser-driver.ts", import.meta.url), "utf8")
  const parent = await readFile(new URL("./verify-preview-layout.ts", import.meta.url), "utf8")
  expect(driver).toContain("assertNodeRuntime(process.versions)")
  expect(driver).toContain('createRequire(join(appDirectory, "package.json"))')
  expect(driver).toContain("chromium.connectOverCDP(request.endpoint, { timeout: workerAttachmentMs })")
  expect(driver).toContain("matrixCompleted = true")
  expect(driver).toContain("assertOwnedPreviewEndpoint(endpoint, request.endpoint)")
  expect(driver).toContain("createSession: () => browser!.newBrowserCDPSession()")
  expect(driver).not.toMatch(/\bBun\s*\.|@hraness\/direct|import\.meta/u)
  expect(builder).toContain('target: "node"')
  expect(builder).toContain('packages: "external"')
  expect(parent).not.toContain('from "playwright-core"')
  expect(parent).toContain('await stopVerificationServer(worker!, 5_000)')
  expect(parent).toContain('await stopVerificationServer(managed!, 5_000)')
  expect(parent).toContain("assertCollectedWorkerProtocol")
  expect(parent).toContain("assertWorkerInputsUnchanged(workerInputs, currentInputs)")
  expect(parent).toContain("Compiled driver changed before dispatch")
  expect(parent).toContain("Worker request changed before dispatch")
})
