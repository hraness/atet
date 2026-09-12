#!/usr/bin/env bun

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { access, lstat, mkdir, mkdtemp, opendir, realpath, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnVerificationServer, stopVerificationServer, type ManagedVerificationServer } from "@hraness/direct/tooling/browser-verification"
import { bounded, withPreviewCancellation } from "./preview-browser-contract"
import { readPreviewFile } from "./preview-file"
import { assertWorkerInputsUnchanged, assertWorkerProtocolSnapshot, decodeWorkerJson, encodeWorkerJson,
  readWorkerInput, workerDriverLimit, workerPhaseFiles, workerProtocolLimit, type WorkerInputSnapshot } from "./preview-browser-protocol"
import { capturePreviewOutputTimeout, createPreviewEndpointWaiter, previewFailureSummary,
  type EndpointEvidence, type PreviewOutputTimeoutEvidence } from "./verify-preview-layout"
import { shellContentType, shellRecord, siteShellHeaders, type ShellPayload } from "./site-shell-browser-contract"
import { readShellSnapshot, assertShellSnapshotUnchanged, parseShellArguments, type ShellSnapshot, type ShellArtifact } from "./verify-site-shell"
import { snapshotMarketingPreset } from "./marketing-preset"
import { snapshotLanternMaterial } from "./lantern-material"
import { parseMarketingCaseFailure as parseShellCaseFailure, parseMarketingPhase as parseShellPhase,
  parseMarketingRequest as parseShellRequest, marketingCases as siteShellCases, marketingDeadlineMs,
  marketingScope, marketingBaselineProfile, marketingBaselineRevision, marketingBaselineTree,
  type MarketingRequest as ShellRequest } from "./site-marketing-browser-contract"

const appDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")
async function inventory(directory: string, root = directory, depth = 0): Promise<string[]> {
  assert.ok(depth <= 8)
  assert.equal(await realpath(directory), directory, "Shell input directory must be physical")
  const paths: string[] = []
  for await (const entry of await opendir(directory)) {
    assert.ok(/^[A-Za-z0-9_.\[\]-]+$/u.test(entry.name) && entry.name !== "." && entry.name !== "..")
    const path = join(directory, entry.name)
    if (entry.isDirectory()) paths.push(...await inventory(path, root, depth + 1))
    else {
      assert.ok(entry.isFile(), "Shell inventory rejects symlinks and special files")
      paths.push(path.slice(root.length + 1))
    }
    assert.ok(paths.length <= 128, "Excessive shell file inventory")
  }
  return paths.sort()
}
interface CandidateIdentity { readonly sha: string; readonly tree: string }
function candidateIdentity(directory: string): CandidateIdentity {
  const run = (...args: string[]) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", timeout: 5_000, maxBuffer: 64 * 1024 })
  assert.equal(run("status", "--porcelain", "--untracked-files=all"), "", "Native acceptance requires a clean candidate checkout")
  const values = run("rev-parse", "HEAD", "HEAD^{tree}").trim().split("\n")
  assert.equal(values.length, 2); assert.ok(values.every(value => /^[a-f0-9]{40}$/u.test(value)))
  return { sha: values[0]!, tree: values[1]! }
}
/** Full dist retains both independent compiler graphs; only the ordinary
 * graph gains the editorial face. Keep each finite inventory and all bytes. */
export function assertMarketingFontInventory(artifacts: readonly ShellArtifact[]): void {
  const fonts = artifacts.filter(file => file.path.endsWith(".woff2"))
  const ordinary = fonts.filter(file => /^graphs\/site-foundation\/assets\/[A-Za-z0-9_.-]+\.woff2$/u.test(file.path))
  const preview = fonts.filter(file => /^graphs\/preview-foundation\/assets\/[A-Za-z0-9_.-]+\.woff2$/u.test(file.path))
  assert.equal(ordinary.length, 14, "Ordinary marketing graph must retain fourteen fonts")
  assert.equal(preview.length, 13, "Independent preview graph must retain thirteen fonts")
  assert.equal(fonts.length, ordinary.length + preview.length, "Font escaped its captured compiler graph")
  assert.equal(new Set(fonts.map(file => file.path)).size, fonts.length, "Duplicate font artifact")
}
interface MarketingSnapshot extends ShellSnapshot { readonly presetSourceCommit: string; readonly presetManifestSha256: string; readonly fieldAssets: readonly [string, string]; readonly materialSourceCommit: string; readonly materialManifestSha256: string }
async function readMarketingSnapshot(directory: string): Promise<MarketingSnapshot> {
  const snapshot = await readShellSnapshot(directory, true), vendor = join(directory, "vendor/marketing-preset")
  const preset = await snapshotMarketingPreset(vendor), manifest = await readPreviewFile(join(vendor, "provenance.json"), 32 * 1024)
  const material = await snapshotLanternMaterial(join(directory, "vendor/lantern-material"))
  const materialManifest = await readPreviewFile(join(directory, "vendor/lantern-material/provenance.json"), 32 * 1024)
  const inputs = [...snapshot.inputs, ...[...material.files].map(([path, bytes]) => ({ path: `vendor/lantern-material/${path}`, bytes: bytes.byteLength, sha256: digest(bytes) })),
    { path: "vendor/lantern-material/provenance.json", bytes: materialManifest.byteLength, sha256: digest(materialManifest) }, ...[...preset.files].map(([path, bytes]) => ({ path: `vendor/marketing-preset/${path}`, bytes: bytes.byteLength, sha256: digest(bytes) })),
    { path: "vendor/marketing-preset/provenance.json", bytes: manifest.byteLength, sha256: digest(manifest) }].sort((a, b) => a.path.localeCompare(b.path))
  assertMarketingFontInventory(snapshot.artifacts)
  const fieldAssets: string[] = []
  for (const name of ["fonts/instrument-serif/instrument-serif-latin-400.woff2", "marketing-assets/grain.svg", "marketing-assets/cells.svg"]) {
    const source = preset.files.get(name); assert.ok(source !== undefined)
    const matches = snapshot.artifacts.filter(file => file.sha256 === digest(source) && file.path.endsWith(name.endsWith(".woff2") ? ".woff2" : ".svg"))
    assert.equal(matches.length, 1,
      `Exactly one captured canonical marketing asset required: ${name}`)
    if (name.endsWith(".svg")) fieldAssets.push(`/${matches[0]!.path}`)
  }
  assert.equal(fieldAssets.length, 2)
  return { ...snapshot, inputs, materialSourceCommit: material.sourceCommit, materialManifestSha256: digest(materialManifest), presetSourceCommit: preset.sourceCommit, presetManifestSha256: digest(manifest), fieldAssets: fieldAssets as [string, string] }
}
export function assertMarketingBaselineManifest(value: unknown, snapshot: ShellSnapshot): void {
  const manifest = shellRecord(value)
  assert.deepEqual(Object.keys(manifest).sort(), ["artifacts", "baselineProfile", "checkoutRevision", "inputs", "schemaVersion", "sourceRevision", "sourceTree"])
  assert.equal(manifest.schemaVersion, 3); assert.equal(manifest.baselineProfile, marketingBaselineProfile)
  assert.equal(manifest.checkoutRevision, marketingBaselineRevision); assert.equal(manifest.sourceRevision, marketingBaselineRevision)
  assert.equal(manifest.sourceTree, marketingBaselineTree); assert.equal(snapshot.stylesheets.length, 2)
  assert.deepEqual(manifest.inputs, snapshot.inputs, "Reviewed baseline input bytes changed")
  assert.deepEqual(manifest.artifacts, snapshot.artifacts, "Reviewed baseline artifact bytes changed")
}
function serve(snapshot: ShellSnapshot) {
  const rejected: string[] = []
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const url = new URL(request.url), bytes = snapshot.files.get(url.pathname)
    if (request.method !== "GET" || url.search !== "" || bytes === undefined || url.hostname !== "127.0.0.1") {
      if (rejected.length < 64) rejected.push(`${request.method} ${url.pathname}`)
      return new Response("Not Found", { status: 404 })
    }
    return new Response(Uint8Array.from(bytes), { status: url.pathname === "/404.html" ? 404 : 200,
      headers: { ...siteShellHeaders, "content-type": shellContentType(url.pathname), "cache-control": "no-store" } })
  } })
  return { server, rejected, closed: false }
}
function browserPayload(snapshot: ShellSnapshot, origin: string): ShellPayload {
  return { origin, resources: [...snapshot.files.keys()].sort(), stylesheets: snapshot.stylesheets, finalCss: snapshot.stylesheets.at(-1)! }
}
async function executable(name: "NODE_EXECUTABLE_PATH" | "SLOPCAMERA_CHROME_PATH"): Promise<string> {
  const path = process.env[name]
  assert.ok(path !== undefined && isAbsolute(path), `${name} must name the explicit pinned executable`)
  await access(path, constants.X_OK)
  return realpath(path)
}
async function executableIdentity(path: string): Promise<readonly number[]> {
  assert.equal(await realpath(path), path)
  const stat = await lstat(path)
  assert.ok(stat.isFile() && stat.size > 0 && stat.size <= 1024 * 1024 * 1024)
  return [stat.dev, stat.ino, stat.size, stat.mode, stat.nlink, stat.mtimeMs, stat.ctimeMs]
}
async function buildDriver(profile: string): Promise<{ path: string; bytes: Uint8Array }> {
  assert.equal(Bun.version, "1.3.14")
  const result = await Bun.build({ entrypoints: [join(appDirectory, "scripts/site-marketing-browser-driver.mjs")], target: "node",
    env: "disable", format: "esm", minify: false, sourcemap: "none", packages: "external" })
  assert.ok(result.success && result.outputs.length === 1, "Could not compile the private Node shell worker")
  const bytes = new Uint8Array(await result.outputs[0]!.arrayBuffer())
  assert.ok(bytes.byteLength > 0 && bytes.byteLength <= workerDriverLimit)
  assert.ok(!/\bBun\s*\.|["'](?:bun|@hraness\/direct)(?:["'/])/u.test(Buffer.from(bytes).toString()), "Node worker gained a Bun/Direct runtime edge")
  const path = join(profile, "site-marketing-browser-driver.mjs")
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 })
  return { path, bytes }
}
interface ShellObservation { readonly result: Record<string, unknown>; readonly phases: readonly Uint8Array[] }
async function observe(directory: string, request: ShellRequest, signal: AbortSignal, exited: Promise<unknown>, absoluteDeadline: number): Promise<ShellObservation> {
  const limit = marketingDeadlineMs
  const phases: Uint8Array[] = []
  let processExited = false
  void exited.then(() => { processExited = true }, () => { processExited = true })
  let result: Record<string, unknown> | undefined
  for (const sequence of [0, 1, 2] as const) {
    const deadline = Math.min(absoluteDeadline, performance.now() + (sequence === 2 ? limit : 10_000))
    let reads = 0
    while (true) {
      signal.throwIfAborted()
      assert.ok(performance.now() < deadline && ++reads <= Math.ceil(limit / 50) + 1, `Worker ${workerPhaseFiles[sequence]} absolute deadline`)
      try {
        const bytes = await bounded(readPreviewFile(join(directory, workerPhaseFiles[sequence]), workerProtocolLimit),
          "Worker phase read deadline", Math.max(1, deadline - performance.now()))
        signal.throwIfAborted()
        assert.ok(performance.now() < deadline, "Worker phase arrived after its deadline")
        result = parseShellPhase(decodeWorkerJson(bytes), sequence, request)
        phases.push(Uint8Array.from(bytes))
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT" || processExited) throw error
      }
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason) }
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve() }, Math.min(50, Math.max(1, deadline - performance.now())))
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
      })
    }
  }
  assert.equal(result!.node, shellRecord(decodeWorkerJson(phases[0]!)).node)
  return { result: result!, phases }
}
async function collectProtocol(directory: string, observation: ShellObservation): Promise<void> {
  const paths = await inventory(directory)
  const bytes: Uint8Array[] = []
  for (const name of workerPhaseFiles) {
    const published = await readPreviewFile(join(directory, name), workerProtocolLimit)
    const staged = await readPreviewFile(join(directory, `.${name}.tmp`), workerProtocolLimit)
    assert.ok(Buffer.from(published).equals(Buffer.from(staged)))
    bytes.push(published)
  }
  // The established immutable file protocol's collector is shape-independent.
  assertWorkerProtocolSnapshot(paths, bytes, { phases: observation.phases,
    result: observation.result as unknown as Parameters<typeof assertWorkerProtocolSnapshot>[2]["result"] })
}
async function readCaseFailure(profile: string, request: ShellRequest) {
  try {
    return parseShellCaseFailure(
      decodeWorkerJson(await readPreviewFile(join(profile, "site-marketing-case-failure.json"), workerProtocolLimit)), request)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined
    throw error
  }
}

export async function verifySiteMarketing(args: readonly string[]): Promise<void> {
  const scope = marketingScope, baselineProfile = marketingBaselineProfile
  const limit = marketingDeadlineMs
  const options = parseShellArguments(args), deadline = performance.now() + limit
  const actualApp = await realpath(appDirectory)
  assert.notEqual(options.baseline, actualApp, "Baseline must be separate from the changed app")
  const deadlineController = new AbortController()
  const deadlineTimer = setTimeout(() => deadlineController.abort(new Error("Site native absolute deadline exceeded")), limit)
  const servers: ReturnType<typeof serve>[] = []
  let profile: string | undefined, protocolDirectory: string | undefined
  let chrome: ManagedVerificationServer | undefined, worker: ManagedVerificationServer | undefined
  let chromeAbsent = false, workerAbsent = false, completed = false
  let chromeOutput: string | undefined, workerOutput: string | undefined
  let signal: AbortSignal | undefined, observation: ShellObservation | undefined
  let workerRequest: ShellRequest | undefined
  let inputs: readonly WorkerInputSnapshot[] | undefined, manifestBefore: Uint8Array | undefined
  let current: MarketingSnapshot | undefined, baseline: ShellSnapshot | undefined
  let candidate: CandidateIdentity | undefined, baselineIdentity: CandidateIdentity | undefined
  let executableInputs: readonly { path: string; identity: readonly number[] }[] = []
  const packageInputs: WorkerInputSnapshot[] = []
  const timeoutEvidence: PreviewOutputTimeoutEvidence[] = []
  const endpointEvidence: EndpointEvidence = { deadlineMs: 10_000, attempts: 0 }
  const waitEndpoint = createPreviewEndpointWaiter({ now: () => performance.now(), read: readPreviewFile,
    schedule(callback, delay) { const timer = setTimeout(callback, delay); return () => clearTimeout(timer) } })
  try {
    const result = await withPreviewCancellation(process, async cancellation => {
      signal = AbortSignal.any([cancellation.signal, deadlineController.signal])
      const step = async <T>(operation: () => Promise<T>): Promise<T> => {
        signal!.throwIfAborted()
        const result = await cancellation.wait(() => bounded(operation(), "Shell parent absolute deadline", Math.max(1, deadline - performance.now())))
        signal!.throwIfAborted()
        return result
      }
      candidate = await step(async () => candidateIdentity(actualApp))
      baselineIdentity = await step(async () => candidateIdentity(options.baseline))
      assert.equal(baselineIdentity.sha, marketingBaselineRevision); assert.equal(baselineIdentity.tree, marketingBaselineTree)
      current = await step(() => readMarketingSnapshot(actualApp))
      baseline = await step(() => readShellSnapshot(options.baseline, true))
      manifestBefore = Uint8Array.from(await step(() => readPreviewFile(options.manifest, 128 * 1024)))
      assertMarketingBaselineManifest(JSON.parse(Buffer.from(manifestBefore).toString()), baseline)
      const node = await step(() => executable("NODE_EXECUTABLE_PATH")), browserPath = await step(() => executable("SLOPCAMERA_CHROME_PATH"))
      assert.ok(process.env.PLAYWRIGHT_BROWSERS_PATH !== undefined && isAbsolute(process.env.PLAYWRIGHT_BROWSERS_PATH),
        "PLAYWRIGHT_BROWSERS_PATH must select the explicit task-owned pinned Chrome for Testing installation")
      const require = createRequire(join(actualApp, "package.json"))
      const packagePath = await realpath(require.resolve("playwright-core/package.json"))
      assert.equal(shellRecord(JSON.parse(Buffer.from(await readPreviewFile(packagePath, 64 * 1024)).toString())).version, "1.62.0")
      for (const path of [packagePath, join(dirname(packagePath), "browsers.json"),
        ...await Promise.all(["@hraness/ui", "@hraness/design-kit", "@hraness/site-footer"].map(async name =>
          realpath(require.resolve(`${name}/stylex-manifest.json`))))]) {
        packageInputs.push(await readWorkerInput(path, workerDriverLimit))
      }
      executableInputs = await Promise.all([node, browserPath].map(async path => ({ path, identity: await executableIdentity(path) })))
      profile = await mkdtemp(join(await realpath(tmpdir()), "slopcamera-site-marketing-"))
      signal.throwIfAborted()
      const driver = await step(() => buildDriver(profile!))
      const currentServer = serve(current); servers.push(currentServer)
      const baselineServer = serve(baseline); servers.push(baselineServer)
      signal.throwIfAborted()
      chrome = spawnVerificationServer({ cwd: actualApp, detachedProcessGroup: true, logLimit: 12_000, command: [browserPath,
        "--headless=new", "--no-sandbox", "--disable-background-networking", "--disable-component-update", "--disable-default-apps",
        "--disable-extensions", "--disable-gpu", "--disable-sync", "--force-color-profile=srgb", "--metrics-recording-only", "--mute-audio",
        "--no-first-run", "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"] })
      const endpoint = await waitEndpoint(profile, chrome.exited, signal, endpointEvidence)
      protocolDirectory = join(profile, "worker-protocol")
      await mkdir(protocolDirectory, { mode: 0o700 })
      const request = parseShellRequest({ schemaVersion: 1, token: randomUUID(), scope, baselineProfile, appDirectory: actualApp, chromeExecutable: browserPath,
        endpoint, current: browserPayload(current, currentServer.server.url.origin), baseline: browserPayload(baseline, baselineServer.server.url.origin), fieldAssets: current.fieldAssets })
      workerRequest = request
      const requestPath = join(profile, "site-marketing-browser-request.json"), bytes = encodeWorkerJson(request)
      await writeFile(requestPath, bytes, { flag: "wx", mode: 0o600 })
      inputs = [await readWorkerInput(driver.path, workerDriverLimit), await readWorkerInput(requestPath, workerProtocolLimit)]
      assert.ok(Buffer.from(inputs[0]!.bytes).equals(Buffer.from(driver.bytes)))
      assert.ok(Buffer.from(inputs[1]!.bytes).equals(Buffer.from(bytes)))
      await writeFile(join(profile, "site-marketing-inputs.json"), `${JSON.stringify({ schemaVersion: 1, executableInputs,
        packageInputs: packageInputs.map(input => ({ path: input.path, identity: input.identity, sha256: digest(input.bytes) })),
        current: { inputs: current.inputs, artifacts: current.artifacts }, baseline: JSON.parse(Buffer.from(manifestBefore).toString()),
        worker: inputs.map(input => ({ path: input.path, identity: input.identity, sha256: digest(input.bytes) })) })}\n`, { flag: "wx", mode: 0o600 })
      await writeFile(join(profile, "site-marketing-driver.snapshot.mjs"), inputs[0]!.bytes, { flag: "wx", mode: 0o600 })
      await writeFile(join(profile, "site-marketing-request.snapshot.json"), inputs[1]!.bytes, { flag: "wx", mode: 0o600 })
      signal.throwIfAborted()
      worker = spawnVerificationServer({ cwd: actualApp, detachedProcessGroup: true, logLimit: 12_000,
        omitEnvironment: ["NODE_OPTIONS", "NODE_PATH"], command: [node, driver.path, actualApp, requestPath] })
      console.error(`slopcamera-site-marketing: verifying ${siteShellCases.length} mandatory ${scope} current/baseline cases`)
      observation = await observe(protocolDirectory, request, signal, worker.exited, deadline)
      await step(() => bounded(worker!.exited, "Shell worker successful exit", 5_000))
      assert.equal(worker.exitCode(), 0)
      completed = true
      return { ...observation.result, nativeBrowserZoom: false, reflowEquivalent: "1440x900 at 200% => 720x450 CSS viewport",
        productionHeaders: siteShellHeaders, internetRequestsAllowed: false, analytics: "unaltered scripts on neutral loopback origin",
        candidate, baselineIdentity, baselineManifestSha256: digest(manifestBefore), currentArtifacts: current.artifacts,
        materialSourceCommit: current.materialSourceCommit, materialManifestSha256: current.materialManifestSha256,
        presetSourceCommit: current.presetSourceCommit, presetManifestSha256: current.presetManifestSha256,
        expectationsSha256: current.inputs.find(input => input.path === "scripts/site-marketing-browser-contract.ts")!.sha256 }
    }, async () => {
      const failures: unknown[] = []
      const collect = async (operation: () => Promise<unknown>, role?: "worker" | "chrome") => {
        try { await operation() } catch (error) {
          failures.push(error)
          if (role !== undefined) { const evidence = capturePreviewOutputTimeout(role, error); if (evidence !== undefined) timeoutEvidence.push(evidence) }
        }
      }
      if (worker !== undefined) await collect(async () => { await stopVerificationServer(worker!, 5_000); workerAbsent = true }, "worker")
      if (chrome !== undefined) await collect(async () => { await stopVerificationServer(chrome!, 5_000); chromeAbsent = true }, "chrome")
      if (worker !== undefined) await collect(async () => { workerOutput = await bounded(worker!.output, "Worker output EOF", 5_000) })
      if (chrome !== undefined) await collect(async () => { chromeOutput = await bounded(chrome!.output, "Chrome output EOF", 5_000) })
      for (const server of servers) await collect(async () => {
        await bounded(server.server.stop(true), "Loopback server collection", 5_000)
        assert.equal(server.server.pendingRequests, 0); assert.equal(server.server.pendingWebSockets, 0)
        server.closed = true
      })
      if (completed) await collect(async () => {
        assert.ok(workerAbsent && chromeAbsent && servers.length === 2 && servers.every(server => server.closed))
        assert.equal(worker!.exitCode(), 0); assert.equal(workerOutput, "")
        assert.ok(chromeOutput !== undefined && Buffer.byteLength(chromeOutput) <= 48_000)
        assert.ok(inputs !== undefined && observation !== undefined && protocolDirectory !== undefined)
        const after: WorkerInputSnapshot[] = []
        for (const input of inputs) after.push(await readWorkerInput(input.path, input.maximum))
        assertWorkerInputsUnchanged(inputs, after)
        await collectProtocol(protocolDirectory, observation)
        assert.equal(await readCaseFailure(profile!, workerRequest!), undefined, "Successful shell worker also published failure evidence")
        for (const input of executableInputs) assert.deepEqual(await executableIdentity(input.path), input.identity, "Admitted executable changed")
        for (const input of packageInputs) {
          const after = await readWorkerInput(input.path, input.maximum)
          assert.deepEqual(after.identity, input.identity, "Installed package input identity changed")
          assert.ok(Buffer.from(after.bytes).equals(Buffer.from(input.bytes)), "Installed package manifest bytes changed")
        }
        assert.ok(manifestBefore !== undefined && Buffer.from(await readPreviewFile(options.manifest, 128 * 1024)).equals(Buffer.from(manifestBefore)), "Baseline input manifest changed")
        assertShellSnapshotUnchanged(current!, await readMarketingSnapshot(actualApp))
        assertShellSnapshotUnchanged(baseline!, await readShellSnapshot(options.baseline, true))
        assert.deepEqual(candidateIdentity(actualApp), candidate, "Candidate Git identity changed")
        assert.deepEqual(candidateIdentity(options.baseline), baselineIdentity, "Baseline Git identity changed")
        for (const server of servers) assert.deepEqual(server.rejected, [], "Unadmitted or late server request")
        signal!.throwIfAborted()
        assert.ok(performance.now() < deadline, "Collection completed after the absolute deadline")
      })
      if (profile !== undefined && (!completed || failures.length > 0 || signal?.aborted === true)) await collect(async () => {
        let caseFailure: ReturnType<typeof parseShellCaseFailure> | undefined
        // Missing partial evidence is possible before the first case. Malformed
        // evidence remains a collector failure, never a fallback success.
        if (workerRequest !== undefined && workerAbsent) await collect(async () => { caseFailure = await readCaseFailure(profile!, workerRequest!) })
        const receipt = `${JSON.stringify({ accepted: false, completed, cancelled: signal?.aborted === true, chromeAbsent, workerAbsent,
          endpointEvidence, timeoutEvidence, caseFailure, workerOutput, chromeOutput, failures: failures.map(error => previewFailureSummary(error)) })}\n`
        assert.ok(Buffer.byteLength(receipt) <= 1024 * 1024)
        await writeFile(join(profile!, "site-marketing-failure.json"), receipt, { flag: "wx", mode: 0o600 })
        console.error(`slopcamera-site-marketing: retained failure evidence at ${profile}`)
      })
      if (failures.length > 0) throw new AggregateError(failures, "Shell resource collection failed")
    })
    console.log(JSON.stringify({ ...result, accepted: true, workerProcessGroupAbsent: workerAbsent, browserProcessGroupAbsent: chromeAbsent,
      listenersCollected: servers.every(server => server.closed), outputEof: true, evidenceDirectory: profile }))
  } finally { clearTimeout(deadlineTimer) }
}

if (import.meta.main) {
  try { await verifySiteMarketing(process.argv.slice(2)) } catch (error) {
    process.exitCode = 1
    console.error(previewFailureSummary(error).replace("slopcamera-preview:", "slopcamera-site-marketing:"))
  }
}
