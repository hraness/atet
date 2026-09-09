import assert from "node:assert/strict"
import { realpath, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, isAbsolute, join } from "node:path"
import { pathToFileURL } from "node:url"
import { bounded, withPreviewCancellation } from "./preview-browser-contract"
import { assertShellNode, checkShellCase, compareShellEvidence, parseShellPhase, parseShellRequest,
  shellCaseFailure, siteShellCases, siteShellDeadlineMs } from "./site-shell-browser-contract"
import { decodeWorkerJson, encodeWorkerJson, publishWorkerPhase, workerAttachmentMs, workerProtocolLimit } from "./preview-browser-protocol"
import { readPreviewFile } from "./preview-file"
import { assertOwnedPreviewEndpoint, closeOwnedPreviewBrowser } from "./preview-browser-shutdown"

// This entry is bundled by the Bun parent, then executed by genuine pinned
// Node. The temporary bundle resolves dependencies only from the explicit app.
async function main() {
  const started = performance.now()
  const node = assertShellNode(process.versions)
  assert.equal(process.argv.length, 4)
  const appDirectory = process.argv[2], requestPath = process.argv[3]
  assert.ok(isAbsolute(appDirectory) && isAbsolute(requestPath))
  assert.equal(await realpath(appDirectory), appDirectory)
  const request = parseShellRequest(decodeWorkerJson(await readPreviewFile(requestPath, workerProtocolLimit)))
  assert.equal(request.appDirectory, appDirectory)
  const directory = join(dirname(requestPath), "worker-protocol")
  assert.equal(await realpath(directory), directory)
  const require = createRequire(join(appDirectory, "package.json"))
  const packagePath = await realpath(require.resolve("playwright-core/package.json"))
  const manifest = JSON.parse(Buffer.from(await readPreviewFile(packagePath, 64 * 1024)).toString())
  assert.equal(manifest.version, "1.62.0")
  const { chromium } = await import(pathToFileURL(join(dirname(packagePath), "index.mjs")).href)
  assert.equal(await realpath(chromium.executablePath()), request.chromeExecutable,
    "The explicit Chrome for Testing executable must be the revision selected by pinned Playwright")
  const browserManifest = JSON.parse(Buffer.from(await readPreviewFile(join(dirname(packagePath), "browsers.json"), 64 * 1024)).toString())
  const pinnedBrowser = browserManifest.browsers.filter(value => value.name === "chromium")
  assert.equal(pinnedBrowser.length, 1)
  const common = { schemaVersion: 1, token: request.token }, runtime = { node, playwright: "1.62.0" }
  let browser, connection, activeCase, signal, matrixCompleted = false
  const result = await withPreviewCancellation(process, async cancellation => {
    signal = cancellation.signal
    await publishWorkerPhase(directory, 0, { ...common, ...runtime, sequence: 0, kind: "started" })
    browser = await cancellation.wait(() => {
      connection = chromium.connectOverCDP(request.endpoint, { timeout: workerAttachmentMs })
      return connection
    })
    await publishWorkerPhase(directory, 1, { ...common, sequence: 1, kind: "connected" })
    assert.equal(browser.version(), pinnedBrowser[0].browserVersion, "Connected browser version differs from pinned Chrome for Testing")
    const cases = [], negativeControls = []
    for (const scenario of siteShellCases) {
      let stage = "current"
      try {
        const remaining = siteShellDeadlineMs - (performance.now() - started)
        assert.ok(remaining > 0, "Shell matrix exceeded its absolute deadline")
        const negative = scenario.width === 1440 && scenario.theme === "system" && scenario.system === "light"
        const evidence = await cancellation.wait(() => {
          activeCase = checkShellCase(browser, request.current, scenario, "current", negative)
          return bounded(activeCase, `Current ${scenario.name}`, Math.min(60_000, remaining))
        })
        stage = "baseline"
        const old = await cancellation.wait(() => {
          activeCase = checkShellCase(browser, request.baseline, scenario, "baseline", false)
          return bounded(activeCase, `Baseline ${scenario.name}`, Math.min(60_000, Math.max(1, siteShellDeadlineMs - (performance.now() - started))))
        })
        stage = "comparison"
        compareShellEvidence(evidence, old, scenario.name)
        cases.push(scenario.name)
        if (negative) negativeControls.push(scenario.route)
      } catch (error) {
        // Preserve the exact failed scenario without manufacturing result.json.
        // The parent reads this only after collecting the owned worker; success
        // still requires the original complete three-phase protocol.
        try {
          await bounded(writeFile(join(dirname(requestPath), "site-shell-case-failure.json"),
            encodeWorkerJson(shellCaseFailure(request, scenario.name, stage, cases, error)), { flag: "wx", mode: 0o600 }),
          "Partial shell failure evidence", 5_000)
        } catch (receiptError) { throw new AggregateError([error, receiptError], "Shell case failure and receipt publication failed") }
        throw error
      }
    }
    matrixCompleted = true
    return { ...common, ...runtime, sequence: 2, kind: "result", browser: browser.version(),
      cases, baselineCompared: true, negativeControls, closed: true }
  }, async () => {
    const failures = []
    const collect = async operation => { try { await operation() } catch (error) { failures.push(error) } }
    if (browser !== undefined) await collect(() => matrixCompleted ? closeOwnedPreviewBrowser({ signal,
      proveOwnership: async () => assertOwnedPreviewEndpoint(await readPreviewFile(join(dirname(requestPath), "DevToolsActivePort"), 1024), request.endpoint),
      createSession: () => browser.newBrowserCDPSession(), disconnect: () => browser.close(),
    }) : bounded(browser.close(), "Browser disconnect", 5_000))
    if (connection !== undefined && browser === undefined) await collect(async () => {
      const late = await bounded(connection.then(value => value, () => undefined), "Late browser attachment settlement", 10_000)
      if (late !== undefined) await bounded(late.close(), "Late browser disconnect", 5_000)
    })
    if (activeCase !== undefined) await collect(() => bounded(Promise.allSettled([activeCase]), "Active case settlement", 5_000))
    if (failures.length > 0) throw new AggregateError(failures, "Shell browser protocol collection failed")
  })
  parseShellPhase(result, 2, request)
  await publishWorkerPhase(directory, 2, result)
}

await main()
