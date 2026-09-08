import assert from "node:assert/strict"
import { realpath } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, isAbsolute, join } from "node:path"
import { pathToFileURL } from "node:url"
import type { Browser } from "playwright-core"
import { bounded, checkCase, comparePreviewEvidence, previewCases, withPreviewCancellation, type PreviewEvidence } from "./preview-browser-contract"
import { assertNodeRuntime, browserPayload, decodeWorkerJson, parseWorkerPhase, parseWorkerRequest,
  publishWorkerPhase, workerAttachmentMs, workerProtocolLimit } from "./preview-browser-protocol"
import { readPreviewFile } from "./preview-file"
import { assertOwnedPreviewEndpoint, closeOwnedPreviewBrowser } from "./preview-browser-shutdown"

/** Private Node entry. Its relocated bundle never supplies the application root. */
async function main(): Promise<void> {
  const node = assertNodeRuntime(process.versions)
  assert.equal(process.argv.length, 4, "Worker requires exact app root and request path")
  const appDirectory = process.argv[2]!
  const requestPath = process.argv[3]!
  assert.ok(isAbsolute(appDirectory) && isAbsolute(requestPath))
  assert.equal(await realpath(appDirectory), appDirectory)
  const request = parseWorkerRequest(decodeWorkerJson(await readPreviewFile(requestPath, workerProtocolLimit)))
  assert.equal(request.appDirectory, appDirectory, "Worker app root differs from admitted input")
  const directory = join(dirname(requestPath), "worker-protocol")
  assert.equal(await realpath(directory), directory)

  // Resolve the installed public entry from the explicit app, not from a
  // temporary bundle directory. Playwright remains an ordinary Node package.
  const require = createRequire(join(appDirectory, "package.json"))
  const packagePath = await realpath(require.resolve("playwright-core/package.json"))
  const manifest: unknown = JSON.parse(Buffer.from(await readPreviewFile(packagePath, 64 * 1024)).toString())
  assert.ok(manifest !== null && typeof manifest === "object" && "version" in manifest)
  assert.equal(manifest.version, "1.62.0", "Worker requires pinned Playwright")
  const { chromium } = await import(pathToFileURL(join(dirname(packagePath), "index.mjs")).href) as typeof import("playwright-core")
  const common = { schemaVersion: 1 as const, token: request.token }
  const runtime = { node, playwright: "1.62.0" as const }
  let browser: Browser | undefined
  let connection: Promise<Browser> | undefined
  let activeCase: Promise<PreviewEvidence> | undefined
  let matrixCompleted = false
  let signal: AbortSignal | undefined
  const completed = await withPreviewCancellation(process, async cancellation => {
    signal = cancellation.signal
    await publishWorkerPhase(directory, 0, { ...common, sequence: 0, kind: "started", ...runtime })
    cancellation.signal.throwIfAborted()
    browser = await cancellation.wait(() => {
      connection = chromium.connectOverCDP(request.endpoint, { timeout: workerAttachmentMs })
      return connection
    })
    await publishWorkerPhase(directory, 1, { ...common, sequence: 1, kind: "connected" })
    const current = browserPayload(request.current)
    const baseline = request.baseline === null ? undefined : browserPayload(request.baseline)
    const rows = []
    for (const scenario of previewCases) {
      const evidence = await cancellation.wait(() => {
        activeCase = checkCase(browser!, new URL(request.current.origin), current, scenario, scenario.name === "light-wide")
        return bounded(activeCase, scenario.name)
      })
      if (baseline !== undefined && request.baseline !== null) {
        const old = await cancellation.wait(() => {
          activeCase = checkCase(browser!, new URL(request.baseline!.origin), baseline, scenario, false)
          return bounded(activeCase, `baseline ${scenario.name}`)
        })
        comparePreviewEvidence(evidence, old)
      }
      rows.push({ ...scenario, columns: evidence.columns, maxScrollY: evidence.maxScrollY })
    }
    matrixCompleted = true
    return { ...common, sequence: 2 as const, kind: "result" as const, ...runtime,
      browser: browser.version(), cases: rows, baselineCompared: request.baseline !== null, closed: true as const }
  }, async () => {
    const failures: unknown[] = []
    const collect = async (operation: () => Promise<unknown>) => {
      try { await operation() } catch (error) { failures.push(error) }
    }
    if (browser !== undefined) await collect(() => matrixCompleted
      ? closeOwnedPreviewBrowser({ signal: signal!,
        proveOwnership: async () => {
          // This is the physical launch profile holding the parent-created
          // request, not an arbitrary remote or reusable browser endpoint.
          const endpoint = await readPreviewFile(join(dirname(requestPath), "DevToolsActivePort"), 1024)
          assertOwnedPreviewEndpoint(endpoint, request.endpoint)
        },
        createSession: () => browser!.newBrowserCDPSession(),
        disconnect: () => browser!.close(),
      })
      : bounded(browser!.close(), "Browser protocol close", 5_000))
    if (connection !== undefined && browser === undefined) await collect(async () => {
      const late = await bounded(connection!.then(value => value, () => undefined), "Cancelled CDP attachment settlement", 10_000)
      if (late !== undefined) await bounded(late.close(), "Late browser protocol close", 5_000)
    })
    if (activeCase !== undefined) await collect(() => bounded(Promise.allSettled([activeCase!]), "Active verification settlement", 5_000))
    if (failures.length > 0) throw new AggregateError(failures, "Worker browser protocol collection failed")
  })
  parseWorkerPhase(completed, 2, request)
  await publishWorkerPhase(directory, 2, completed)
}

// No result or success stdout on any exception. The Bun parent owns the actual
// process group and requires positive exit, stdio and protocol settlement.
await main()
