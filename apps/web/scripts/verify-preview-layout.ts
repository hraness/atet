#!/usr/bin/env bun

import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, mkdir, mkdtemp, opendir, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnVerificationServer, stopVerificationServer, type ManagedVerificationServer } from "@hraness/direct/tooling/browser-verification"
import { inspectPreviewCssResources } from "./preview-css"
import { readPreviewFile } from "./preview-file"
import { expectedPreviewHeaders, bounded, contentType, withPreviewCancellation } from "./preview-browser-contract"
import { buildPreviewBrowserDriver, findPreviewNode } from "./build-preview-browser-driver"
import { assertCollectedWorkerProtocol, assertWorkerInputsUnchanged, encodeWorkerJson, observeWorker, parseWorkerRequest,
  readWorkerInput, workerDriverLimit, workerProtocolLimit,
  type PreviewWorkerRequest, type WorkerInputSnapshot, type WorkerObservation, type WorkerPayload } from "./preview-browser-protocol"
export { expectedPreviewHeaders, previewCases, assertPreviewEvidence, comparePreviewEvidence, withPreviewCancellation } from "./preview-browser-contract"
export type { PreviewCase, PreviewEvidence, PreviewSignalSource } from "./preview-browser-contract"

const appDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
export const baselineRevision = "0130b9ac79dc4ea5abcb31104f64657931a398e8"
const baselineSources = Object.freeze({
  "package.json": "b45819abbe30d326aff9b48dd5752f53165d57d7db9a61c3c481b6e6f6f29244",
  "bun.lock": "2143567331ff2f1cdd9bf4ac9b87a9032a3cfdefbcbddaf50fc161e80dc8b096",
  "src/preview.html": "9e055c91b27eba9018f0c1562de7bd6cb7406a7445381ddfb68ce6bb3c988211",
  "src/styles.css": "49838797ae8c977f3c446482299a3f20a8db4197f1592f3388fdb018e9d469cc",
  "scripts/build.ts": "ac86f314caf41261d20fe8e8f75134c7fa8ae3f2f967b1e3e1dee19fafa515ee",
  "vercel.json": "9b80a7b9f73ffe1a40c5a6ec02bbdf62821962e2b7fa375796f037aaae7c6313",
})

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

function workerPayload(payload: Payload, origin: string): WorkerPayload {
  return { origin, headers: payload.headers, stylesheets: payload.stylesheets, resources: [...payload.files.keys()].sort() }
}

export async function verifyPreview(args: readonly string[] = []): Promise<void> {
  let profile: string | undefined
  const servers: ReturnType<typeof serve>[] = []
  let managed: ManagedVerificationServer | undefined
  let worker: ManagedVerificationServer | undefined
  let observation: WorkerObservation | undefined
  let workerInputs: readonly WorkerInputSnapshot[] | undefined
  let protocolDirectory: string | undefined
  let processGroupAbsent = false
  let workerProcessGroupAbsent = false
  let verificationCompleted = false
  let signal: AbortSignal | undefined
  let chromeOutput: string | undefined
  let workerOutput: string | undefined
  let endpointBeforeCollection: unknown
  const endpointEvidence: EndpointEvidence = { deadlineMs: 10_000, attempts: 0 }
  const result = await withPreviewCancellation(process, async cancellation => {
    signal = cancellation.signal
    const options = parsePreviewArguments(args)
    const current = await cancellation.wait(async () => readPayload(await realpath(appDirectory)))
    const baseline = options.baseline === undefined ? undefined : await cancellation.wait(() => readPayload(options.baseline!, options.manifest))
    // Capture every resource acquisition before cancellation can enter cleanup.
    profile = await mkdtemp(join(await realpath(tmpdir()), "atet-preview-layout-"))
    cancellation.signal.throwIfAborted()
    const driver = await buildPreviewBrowserDriver(await realpath(appDirectory), profile)
    cancellation.signal.throwIfAborted()
    const node = await cancellation.wait(findPreviewNode)
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
    protocolDirectory = join(profile, "worker-protocol")
    await mkdir(protocolDirectory, { mode: 0o700 })
    const request: PreviewWorkerRequest = parseWorkerRequest({ schemaVersion: 1, token: randomUUID(),
      appDirectory: await realpath(appDirectory), endpoint,
      current: workerPayload(current, currentServer.server.url.origin),
      baseline: baseline === undefined || oldServer === undefined ? null : workerPayload(baseline, oldServer.server.url.origin) })
    const requestPath = join(profile, "preview-browser-request.json")
    const requestBytes = encodeWorkerJson(request)
    await writeFile(requestPath, requestBytes, { flag: "wx", mode: 0o600 })
    workerInputs = [await readWorkerInput(driver.path, workerDriverLimit), await readWorkerInput(requestPath, workerProtocolLimit)]
    assert.ok(Buffer.from(workerInputs[0]!.bytes).equals(Buffer.from(driver.bytes)), "Compiled driver changed before dispatch")
    assert.ok(Buffer.from(workerInputs[1]!.bytes).equals(Buffer.from(requestBytes)), "Worker request changed before dispatch")
    // Retain original bytes independently of the executed paths, plus their
    // physical identities, for failure diagnosis and reproducible admission.
    for (const [index, name] of ["preview-browser-driver.snapshot.mjs", "preview-browser-request.snapshot.json"].entries()) {
      await writeFile(join(profile, name), workerInputs[index]!.bytes, { flag: "wx", mode: 0o600 })
    }
    await writeFile(join(profile, "preview-browser-inputs.json"), encodeWorkerJson({ schemaVersion: 1,
      inputs: workerInputs.map(input => ({ path: input.path, identity: input.identity, bytes: input.bytes.byteLength, sha256: digest(input.bytes) })) }),
    { flag: "wx", mode: 0o600 })
    cancellation.signal.throwIfAborted()
    worker = spawnVerificationServer({ cwd: appDirectory, detachedProcessGroup: true, logLimit: 12_000,
      omitEnvironment: ["NODE_OPTIONS", "NODE_PATH"],
      command: [node, driver.path, request.appDirectory, requestPath] })
    console.error("atet-preview: worker-started")
    observation = await observeWorker(protocolDirectory, request, cancellation.signal, worker.exited, () => {
      console.error("atet-preview: browser-connected")
    })
    // A result is provisional until genuine zero exit and both Direct custody
    // settlements succeed. A late result can never override cancellation.
    await cancellation.wait(() => bounded(worker!.exited, "Preview worker exit after result", 5_000))
    assert.equal(worker.exitCode(), 0, "Preview worker did not exit successfully")
    for (const server of servers) assert.deepEqual(server.rejected, [], "Server received unadmitted resource requests")
    verificationCompleted = true
    return { browser: observation.result.browser, node: observation.result.node, playwright: observation.result.playwright,
      cases: observation.result.cases, nativeBrowserZoom: false, internetRequestsAllowed: false,
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
    // Collect the client first; its owned Node group may not retain a live CDP
    // transport while the Chrome group and inherited output pipes are reaped.
    if (worker !== undefined) await collect(async () => {
      await stopVerificationServer(worker!, 5_000)
      workerProcessGroupAbsent = true
      console.error("atet-preview: worker-collected")
    })
    if (managed !== undefined) await collect(async () => {
      await stopVerificationServer(managed!, 5_000)
      processGroupAbsent = true
      console.error("atet-preview: browser-collected")
    })
    if (worker !== undefined) await collect(async () => {
      workerOutput = await bounded(worker!.output, "Bounded worker diagnostic output", 5_000)
      assert.ok(Buffer.byteLength(workerOutput) <= 48_000, "Worker diagnostic output exceeded its bound")
    })
    if (managed !== undefined) await collect(async () => {
      chromeOutput = await bounded(managed!.output, "Bounded Chrome diagnostic output", 5_000)
      assert.ok(Buffer.byteLength(chromeOutput) <= 48_000, "Supervisor diagnostic output exceeded its bound")
    })
    for (const server of servers) await collect(() => bounded(server.server.stop(true), "Preview server close", 5_000))
    if (verificationCompleted && observation !== undefined && protocolDirectory !== undefined) await collect(async () => {
      assert.ok(workerProcessGroupAbsent && processGroupAbsent, "Both owned process groups must be absent before protocol acceptance")
      assert.equal(worker!.exitCode(), 0)
      assert.equal(workerOutput, "", "Successful worker must not emit an alternate stdout/stderr receipt")
      assert.ok(workerInputs !== undefined)
      const currentInputs: WorkerInputSnapshot[] = []
      for (const input of workerInputs) currentInputs.push(await readWorkerInput(input.path, input.maximum))
      assertWorkerInputsUnchanged(workerInputs, currentInputs)
      await assertCollectedWorkerProtocol(protocolDirectory!, observation!)
      for (const server of servers) assert.deepEqual(server.rejected, [], "Server received late unadmitted resource requests")
    })
    if (profile !== undefined) {
      if (managed !== undefined && !processGroupAbsent) failures.push(new Error(`Browser process-group absence is unproved; preserved profile: ${profile}`))
      if (worker !== undefined && !workerProcessGroupAbsent) failures.push(new Error(`Worker process-group absence is unproved; preserved profile: ${profile}`))
      // Never delete admission or protocol evidence inside a cancellable turn,
      // including after success. Separate guarded reclamation owns its removal.
      if (!verificationCompleted || signal?.aborted === true || failures.length > 0 || !processGroupAbsent || !workerProcessGroupAbsent) await collect(async () => {
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
          processGroupAbsent, workerProcessGroupAbsent, endpointEvidence, endpointBeforeCollection, endpointAtCollection,
          profileEntries: entries.sort(), chromeOutput, workerOutput, cleanupFailures: failures.map(errorEvidence) }, null, 2)}\n`, { flag: "wx", mode: 0o600 })
        console.error(`atet-preview: failure evidence preserved at ${path}`)
      })
    }
    if (failures.length > 0) throw new AggregateError(failures, "Preview resource collection failed")
  })
  console.log(JSON.stringify({ ...record(result), processGroupAbsent, workerProcessGroupAbsent, evidenceDirectory: profile }))
}

if (import.meta.main) await verifyPreview(process.argv.slice(2))
