import assert from "node:assert/strict"
import type { Stats } from "node:fs"
import { link, lstat, opendir, writeFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { expectedPreviewHeaders, previewCases, type BrowserPayload, type PreviewCase } from "./preview-browser-contract"
import { readPreviewFile } from "./preview-file"

export const workerProtocolLimit = 32 * 1024
export const workerPhaseFiles = ["started.json", "connected.json", "result.json"] as const
export const workerStartupMs = 10_000
export const workerAttachmentMs = 10_000
export const workerDriverLimit = 256 * 1024
const tokenPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u

export interface WorkerPayload {
  readonly origin: string
  readonly headers: Readonly<Record<string, string>>
  readonly stylesheets: readonly string[]
  readonly resources: readonly string[]
}

export interface PreviewWorkerRequest {
  readonly schemaVersion: 1
  readonly token: string
  readonly appDirectory: string
  readonly endpoint: string
  readonly current: WorkerPayload
  readonly baseline: WorkerPayload | null
}

export interface PreviewWorkerResult {
  readonly schemaVersion: 1
  readonly token: string
  readonly sequence: 2
  readonly kind: "result"
  readonly node: string
  readonly playwright: "1.62.0"
  readonly browser: string
  readonly cases: readonly (PreviewCase & { readonly columns: number; readonly maxScrollY: number })[]
  readonly baselineCompared: boolean
  readonly closed: true
}

type WorkerInputStat = Pick<Stats, "dev" | "ino" | "size" | "mode" | "nlink" | "mtimeMs" | "ctimeMs" | "isFile">
export interface WorkerInputSnapshot {
  readonly path: string
  readonly maximum: number
  readonly identity: readonly number[]
  readonly bytes: Uint8Array
}

interface WorkerInputIo {
  stat(path: string): Promise<WorkerInputStat>
  read(path: string, maximum: number): Promise<Uint8Array>
}

function inputIdentity(stat: WorkerInputStat): readonly number[] {
  assert.ok(stat.isFile(), "Worker input must remain an ordinary file")
  const identity = [stat.dev, stat.ino, stat.size, stat.mode, stat.nlink, stat.mtimeMs, stat.ctimeMs]
  assert.ok(identity.every(Number.isFinite), "Invalid worker input identity")
  return Object.freeze(identity)
}

/** Retain descriptor identity and an independent byte copy. Native admission
 * stays permanently bound to the strict physical-file reader. */
export function createWorkerInputReader(io: WorkerInputIo) {
  return async (path: string, maximum: number): Promise<WorkerInputSnapshot> => {
    assert.ok(isAbsolute(path) && Number.isSafeInteger(maximum) && maximum > 0 && maximum <= workerDriverLimit)
    const before = inputIdentity(await io.stat(path))
    const bytes = Uint8Array.from(await io.read(path, maximum))
    assert.ok(bytes.byteLength <= maximum)
    assert.equal(bytes.byteLength, before[2], "Worker input length changed")
    assert.deepEqual(inputIdentity(await io.stat(path)), before, "Worker input changed while taking its snapshot")
    return Object.freeze({ path, maximum, identity: before, bytes })
  }
}

export const readWorkerInput = createWorkerInputReader({ stat: lstat, read: readPreviewFile })

export function assertWorkerInputsUnchanged(before: readonly WorkerInputSnapshot[], after: readonly WorkerInputSnapshot[]): void {
  assert.equal(before.length, 2, "Worker must bind exactly the compiled driver and request")
  assert.equal(after.length, before.length)
  for (const [index, expected] of before.entries()) {
    const actual = after[index]!
    assert.equal(actual.path, expected.path)
    assert.equal(actual.maximum, expected.maximum)
    assert.deepEqual(actual.identity, expected.identity, "Worker input identity changed after dispatch")
    assert.ok(Buffer.from(actual.bytes).equals(Buffer.from(expected.bytes)), "Worker input bytes changed after dispatch")
  }
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "Invalid worker object")
  return value as Record<string, unknown>
}

function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), "Unexpected worker fields")
}

function string(value: unknown, maximum: number): asserts value is string {
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\x00-\x1f]/u.test(value), "Invalid worker string")
}

/** Canonical JSON also rejects duplicate keys, invalid UTF-8 and trailing data. */
export function decodeWorkerJson(bytes: Uint8Array): unknown {
  assert.ok(bytes.byteLength > 0 && bytes.byteLength <= workerProtocolLimit, "Excessive worker protocol bytes")
  const text = Buffer.from(bytes).toString("utf8")
  assert.ok(Buffer.from(text).equals(Buffer.from(bytes)), "Invalid worker UTF-8")
  const value: unknown = JSON.parse(text)
  assert.equal(text, `${JSON.stringify(value)}\n`, "Worker protocol must be one canonical JSON value")
  return value
}

export function encodeWorkerJson(value: unknown): Uint8Array {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`)
  assert.ok(bytes.byteLength > 0 && bytes.byteLength <= workerProtocolLimit, "Excessive worker protocol bytes")
  return bytes
}

function parsePayload(value: unknown, stylesheetCount: number): WorkerPayload {
  const payload = record(value)
  keys(payload, ["origin", "headers", "stylesheets", "resources"])
  string(payload.origin, 128)
  const url = new URL(payload.origin)
  assert.ok(url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== ""
    && url.origin === payload.origin && Number(url.port) > 0 && Number(url.port) <= 65535, "Worker requires an exact loopback origin")
  assert.deepEqual(payload.headers, expectedPreviewHeaders, "Worker header contract changed")
  assert.ok(Array.isArray(payload.stylesheets) && payload.stylesheets.length === stylesheetCount)
  const stylesheets = payload.stylesheets
  for (const path of stylesheets) {
    string(path, 512)
    assert.match(path, /^\/(?:assets\/|graphs\/preview-foundation\/assets\/)[A-Za-z0-9_-]+\.css$/u)
  }
  assert.equal(new Set(stylesheets).size, stylesheetCount)
  assert.ok(Array.isArray(payload.resources) && payload.resources.length === stylesheetCount + 14)
  const resources = payload.resources
  assert.equal(new Set(resources).size, resources.length)
  assert.deepEqual(resources, [...resources].sort(), "Worker inventory must be sorted")
  for (const path of resources) {
    string(path, 512)
    assert.ok(path === "/preview" || stylesheets.includes(path)
      || /^\/(?:assets\/|graphs\/preview-foundation\/assets\/)[A-Za-z0-9_./\[\]-]+\.woff2$/u.test(path), "Invalid worker resource")
    assert.ok(!path.split("/").includes(".."), "Worker resource traversal")
  }
  assert.ok(resources.includes("/preview") && stylesheets.every(path => resources.includes(path)))
  assert.equal(resources.filter(path => path.endsWith(".woff2")).length, 13)
  return payload as unknown as WorkerPayload
}

export function parseWorkerRequest(value: unknown): PreviewWorkerRequest {
  const request = record(value)
  keys(request, ["schemaVersion", "token", "appDirectory", "endpoint", "current", "baseline"])
  assert.equal(request.schemaVersion, 1)
  string(request.token, 36)
  assert.match(request.token, tokenPattern)
  string(request.appDirectory, 4096)
  assert.ok(isAbsolute(request.appDirectory), "Worker app root must be explicit and absolute")
  string(request.endpoint, 128)
  const endpoint = /^ws:\/\/127\.0\.0\.1:(\d{1,5})(\/devtools\/browser\/[a-f0-9-]+)$/u.exec(request.endpoint)
  assert.ok(endpoint !== null && Number(endpoint[1]) > 0 && Number(endpoint[1]) <= 65535, "Invalid worker CDP endpoint")
  parsePayload(request.current, 2)
  if (request.baseline !== null) parsePayload(request.baseline, 1)
  return request as unknown as PreviewWorkerRequest
}

export function browserPayload(payload: WorkerPayload): BrowserPayload {
  return { headers: payload.headers, stylesheets: payload.stylesheets,
    files: new Map(payload.resources.map(path => [path, new Uint8Array(0)])) }
}

export function assertNodeRuntime(versions: Readonly<Record<string, string | undefined>>): string {
  assert.equal(versions.bun, undefined, "Playwright worker must run in genuine Node, never Bun")
  assert.ok(versions.node !== undefined && /^24\.\d+\.\d+$/u.test(versions.node), "Playwright worker requires Node 24")
  return versions.node
}

export function parseWorkerPhase(value: unknown, sequence: 0 | 1 | 2, request: PreviewWorkerRequest): Record<string, unknown> {
  const phase = record(value)
  const common = ["schemaVersion", "token", "sequence", "kind"]
  keys(phase, sequence === 0 ? [...common, "node", "playwright"] : sequence === 1 ? common
    : [...common, "node", "playwright", "browser", "cases", "baselineCompared", "closed"])
  assert.equal(phase.schemaVersion, 1)
  assert.equal(phase.token, request.token, "Worker phase belongs to another run")
  assert.equal(phase.sequence, sequence, "Worker phase is duplicate or out of order")
  assert.equal(phase.kind, ["started", "connected", "result"][sequence])
  if (sequence !== 1) {
    assertNodeRuntime({ node: typeof phase.node === "string" ? phase.node : undefined })
    assert.equal(phase.playwright, "1.62.0")
  }
  if (sequence === 2) {
    string(phase.browser, 128)
    assert.equal(phase.closed, true, "Worker result precedes protocol cleanup")
    assert.equal(phase.baselineCompared, request.baseline !== null)
    assert.ok(Array.isArray(phase.cases) && phase.cases.length === previewCases.length)
    for (const [index, value] of phase.cases.entries()) {
      const row = record(value)
      keys(row, [...Object.keys(previewCases[index]!), "columns", "maxScrollY"])
      const { columns, maxScrollY, ...scenario } = row
      assert.deepEqual(scenario, previewCases[index], "Worker case matrix changed")
      assert.equal(columns, previewCases[index]!.width <= 768 ? 2 : 4)
      assert.ok(typeof maxScrollY === "number" && Number.isFinite(maxScrollY) && maxScrollY >= 0)
      if (previewCases[index]!.height === 180) assert.ok(maxScrollY > 0)
    }
  }
  return phase
}

/** Publish a complete inode once. A reader never sees a partial JSON write;
 * hard-link publication refuses an existing phase instead of overwriting it.
 * Retain the staging link so publication never changes the observed nlink. */
export async function publishWorkerPhase(directory: string, sequence: 0 | 1 | 2, value: unknown): Promise<void> {
  const name = workerPhaseFiles[sequence]
  const temporary = join(directory, `.${name}.tmp`)
  await writeFile(temporary, encodeWorkerJson(value), { flag: "wx", mode: 0o600 })
  await link(temporary, join(directory, name))
}

interface WorkerObserverIo {
  now(): number
  schedule(callback: () => void, delayMs: number): () => void
  read(path: string, maximum: number): Promise<Uint8Array>
}

export interface WorkerObservation {
  readonly result: PreviewWorkerResult
  readonly phases: readonly Uint8Array[]
}

export function workerCasesDeadline(request: PreviewWorkerRequest): number {
  // Existing 30-second case budgets, followed by existing two 5-second closes.
  return previewCases.length * (request.baseline === null ? 1 : 2) * 30_000 + 10_000
}

/** One serialized read per 50ms. Only absence can retry: a visible malformed,
 * truncated, changed or duplicate phase is a terminal protocol failure. */
export function createWorkerObserver(io: WorkerObserverIo) {
  return async (directory: string, request: PreviewWorkerRequest, signal: AbortSignal,
    exited: Promise<unknown>, onConnected: () => void): Promise<WorkerObservation> => {
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      let finished = false
      let sequence: 0 | 1 | 2 = 0
      let deadline = io.now() + workerStartupMs
      let cancelDeadline = () => {}
      let cancelRetry = () => {}
      let processExited = false
      let reads = 0
      const maximumReads = Math.ceil((workerStartupMs + workerAttachmentMs + workerCasesDeadline(request)) / 50) + 3
      const phases: Uint8Array[] = []
      const finish = (error?: unknown, result?: PreviewWorkerResult) => {
        if (finished) return
        finished = true
        cancelDeadline(); cancelRetry()
        signal.removeEventListener("abort", abort)
        if (error !== undefined) reject(error)
        else resolve({ result: result!, phases })
      }
      const abort = () => finish(signal.reason)
      const expire = () => finish(new Error(`Preview worker ${workerPhaseFiles[sequence]} exceeded its absolute deadline`))
      const armDeadline = (milliseconds: number) => {
        cancelDeadline()
        deadline = io.now() + milliseconds
        cancelDeadline = io.schedule(expire, milliseconds)
      }
      const inspect = async () => {
        if (finished) return
        if (io.now() >= deadline) { expire(); return }
        if (++reads > maximumReads) { finish(new Error("Excessive worker protocol reads")); return }
        try {
          const bytes = await io.read(join(directory, workerPhaseFiles[sequence]), workerProtocolLimit)
          if (finished) return
          if (signal.aborted) { abort(); return }
          if (io.now() >= deadline) { expire(); return }
          const phase = parseWorkerPhase(decodeWorkerJson(bytes), sequence, request)
          phases.push(Uint8Array.from(bytes))
          if (sequence === 2) {
            const started = record(decodeWorkerJson(phases[0]!))
            assert.equal(phase.node, started.node, "Worker runtime changed during verification")
            finish(undefined, phase as unknown as PreviewWorkerResult)
          } else if (sequence === 0) {
            sequence = 1
            armDeadline(workerAttachmentMs)
          } else {
            sequence = 2
            armDeadline(workerCasesDeadline(request))
            onConnected()
          }
        } catch (error) {
          if (finished) return
          if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" || processExited) {
            finish(error)
          } else if (io.now() >= deadline) expire()
        } finally {
          if (!finished) cancelRetry = io.schedule(() => { void inspect() }, Math.min(50, Math.max(0, deadline - io.now())))
        }
      }
      armDeadline(workerStartupMs)
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
      // Exit alone never accepts a result. Read the expected finite files;
      // absent terminal data after exit is a failure, including truncated runs.
      void exited.then(() => { processExited = true }, error => finish(error))
      void inspect()
    })
  }
}

export const observeWorker = createWorkerObserver({ now: () => performance.now(), read: readPreviewFile,
  schedule(callback, delayMs) { const timer = setTimeout(callback, delayMs); return () => clearTimeout(timer) } })

export async function assertCollectedWorkerProtocol(directory: string, observation: WorkerObservation): Promise<void> {
  const inventory: string[] = []
  for await (const entry of await opendir(directory)) {
    inventory.push(entry.name)
    assert.ok(inventory.length <= 6, "Excessive worker protocol inventory")
  }
  const observed: Uint8Array[] = []
  for (const name of workerPhaseFiles) {
    const bytes = await readPreviewFile(join(directory, name), workerProtocolLimit)
    observed.push(bytes)
    const staged = await readPreviewFile(join(directory, `.${name}.tmp`), workerProtocolLimit)
    assert.ok(Buffer.from(bytes).equals(Buffer.from(staged)), "Worker staging identity changed")
  }
  assertWorkerProtocolSnapshot(inventory, observed, observation)
}

export function assertWorkerProtocolSnapshot(inventory: readonly string[], bytes: readonly Uint8Array[], observation: WorkerObservation): void {
  assert.deepEqual([...inventory].sort(), workerPhaseFiles.flatMap(name => [name, `.${name}.tmp`]).sort(), "Worker protocol has duplicate, partial or unexpected files")
  assert.equal(bytes.length, 3)
  assert.equal(observation.phases.length, 3)
  for (const [index, value] of bytes.entries()) {
    assert.ok(Buffer.from(value).equals(Buffer.from(observation.phases[index]!)), "Worker phase changed after observation")
  }
}
