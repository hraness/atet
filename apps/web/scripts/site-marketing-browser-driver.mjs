import assert from "node:assert/strict"
import { realpath, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, isAbsolute, join } from "node:path"
import { pathToFileURL } from "node:url"
import { bounded, withPreviewCancellation } from "./preview-browser-contract"
import { assertShellNode, checkShellCase, ShellPairFailure, settleShellPair } from "./site-shell-browser-contract"
import { marketingCases, marketingDeadlineMs, marketingScope, marketingBaselineProfile, parseMarketingRequest,
  parseMarketingPhase, marketingCaseFailure, compareMarketingEvidence, compareMarketingElements, measureMarketingDetails,
  observeMarketingDesign, marketingDom, measureMarketingPaintReference } from "./site-marketing-browser-contract"
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
  const request = parseMarketingRequest(decodeWorkerJson(await readPreviewFile(requestPath, workerProtocolLimit)))
  const selectedCases = marketingCases, selectedDeadline = marketingDeadlineMs
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
  const common = { schemaVersion: 1, token: request.token, scope: marketingScope, baselineProfile: marketingBaselineProfile }, runtime = { node, playwright: "1.62.0" }
  let browser, connection, activePair, signal, matrixCompleted = false
  const result = await withPreviewCancellation(process, async cancellation => {
    signal = cancellation.signal
    await publishWorkerPhase(directory, 0, { ...common, ...runtime, sequence: 0, kind: "started" })
    browser = await cancellation.wait(() => {
      connection = chromium.connectOverCDP(request.endpoint, { timeout: workerAttachmentMs })
      return connection
    })
    await publishWorkerPhase(directory, 1, { ...common, sequence: 1, kind: "connected" })
    assert.equal(browser.version(), pinnedBrowser[0].browserVersion, "Connected browser version differs from pinned Chrome for Testing")
    const cases = [], negativeControls = [], designCases = []
    for (const scenario of selectedCases) {
      let stage = "pair"
      try {
        const remaining = selectedDeadline - (performance.now() - started)
        assert.ok(remaining > 0, "Shell matrix exceeded its absolute deadline")
        const negative = scenario.width === 1440 && scenario.theme === "system" && scenario.system === "light"
        let design, baselineDetails, currentDom, baselineDom, baselinePaint
        const [evidence, old] = await cancellation.wait(() => {
          activePair = settleShellPair(
            () => checkShellCase(browser, request.current, scenario, "current", negative,
              async page => { design = await observeMarketingDesign(page, scenario, request.current, request.fieldAssets, negative && scenario.route === "/"); currentDom = await marketingDom(page, true) }),
            // Both sides already contain compiled install transports. This is
            // the new bf1e1a9 design baseline, never the historical migration.
            () => checkShellCase(browser, request.baseline, scenario, "current", false,
              async page => { baselineDetails = await measureMarketingDetails(page, scenario); baselineDom = await marketingDom(page, false); baselinePaint = await measureMarketingPaintReference(page, scenario, "baseline") }))
          return bounded(activePair, `Current/baseline ${scenario.name}`, Math.min(60_000, remaining))
        })
        stage = "comparison"
        assert.ok(design !== undefined && baselineDetails !== undefined, "Current design observations missing")
        assert.ok(typeof currentDom === "string" && typeof baselineDom === "string", "Exact DOM inventories missing")
        assert.equal(currentDom, baselineDom, "Original compiled class, attribute, copy and structure inventories stay exact")
        const paint = scenario.route === "/" ? { current: design.paint, baseline: baselinePaint } : undefined
        if (paint !== undefined) assert.ok(paint.current !== undefined && paint.baseline !== undefined, "Both exact derived paint references are required")
        compareMarketingEvidence(evidence, old, scenario, paint)
        compareMarketingElements(design.elements, baselineDetails, `${scenario.name} proof/headings/actions`, paint)
        designCases.push(design.observation)
        cases.push(scenario.name)
        if (negative) negativeControls.push(`${scenario.route}-final-css`, ...(scenario.route === "/" ? ["/-foundation-css"] : []))
      } catch (error) {
        if (error instanceof ShellPairFailure) stage = error.stage
        // Preserve the exact failed scenario without manufacturing result.json.
        // The parent reads this only after collecting the owned worker; success
        // still requires the original complete three-phase protocol.
        try {
          await bounded(writeFile(join(dirname(requestPath), "site-marketing-case-failure.json"),
            encodeWorkerJson(marketingCaseFailure(request, scenario.name, stage, cases, error)), { flag: "wx", mode: 0o600 }),
          "Partial shell failure evidence", 5_000)
        } catch (receiptError) { throw new AggregateError([error, receiptError], "Shell case failure and receipt publication failed") }
        throw error
      }
    }
    matrixCompleted = true
    return { ...common, ...runtime, sequence: 2, kind: "result", browser: browser.version(),
      cases, comparison: "unchanged-shell-and-copy-with-reviewed-homepage-design", negativeControls, closed: true, designCases }
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
    if (activePair !== undefined) await collect(() => bounded(Promise.allSettled([activePair]), "Both underlying case settlements", 5_000))
    if (failures.length > 0) throw new AggregateError(failures, "Shell browser protocol collection failed")
  })
  parseMarketingPhase(result, 2, request)
  await publishWorkerPhase(directory, 2, result)
}

await main()
