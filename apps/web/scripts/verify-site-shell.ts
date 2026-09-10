#!/usr/bin/env bun

import assert from "node:assert/strict"
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
import { parseShellCaseFailure, parseShellPhase, parseShellRequest, shellContentType, shellRecord, shellResource, siteShellBaselineRevision,
  siteShellBaselineTree, siteInstallBaselineProfile, siteInstallBaselineRevision, siteInstallBaselineTree,
  siteShellCases, siteShellDeadlineMs, siteShellHeaders, type ShellPayload, type ShellRequest } from "./site-shell-browser-contract"
import { parseCopyCaseFailure, parseCopyPhase, siteCopyCases, siteCopyDeadlineMs } from "./site-copy-browser-contract"

const appDirectory = dirname(dirname(fileURLToPath(import.meta.url)))
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")
export interface ShellArtifact { readonly path: string; readonly bytes: number; readonly sha256: string }
export interface ShellSnapshot {
  readonly inputs: readonly ShellArtifact[]
  readonly artifacts: readonly ShellArtifact[]
  readonly files: ReadonlyMap<string, Uint8Array>
  readonly stylesheets: readonly string[]
}

export function parseShellArguments(args: readonly string[]): { baseline: string; manifest: string } {
  assert.ok(args.length === 4 && args[0] === "--baseline-directory" && args[2] === "--baseline-manifest"
    && typeof args[1] === "string" && isAbsolute(args[1]) && typeof args[3] === "string" && isAbsolute(args[3]),
  "Usage: verify-site-shell.ts --baseline-directory <absolute old apps/web> --baseline-manifest <absolute reviewed JSON>")
  return { baseline: args[1], manifest: args[3] }
}
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
async function readArtifacts(directory: string, paths: readonly string[]): Promise<{ artifacts: ShellArtifact[]; files: Map<string, Uint8Array> }> {
  const artifacts: ShellArtifact[] = [], files = new Map<string, Uint8Array>()
  let total = 0
  for (const path of paths) {
    shellResource(`/${path}`)
    const bytes = await readPreviewFile(join(directory, path))
    total += bytes.byteLength
    assert.ok(total <= 64 * 1024 * 1024, "Excessive aggregate shell bytes")
    artifacts.push({ path, bytes: bytes.byteLength, sha256: digest(bytes) })
    files.set(path === "index.html" ? "/" : `/${path}`, Uint8Array.from(bytes))
  }
  return { artifacts, files }
}
export function assertShellHeaders(value: unknown): void {
  const rules = shellRecord(value).headers
  assert.ok(Array.isArray(rules) && rules.length <= 64)
  const matching = rules.map(shellRecord).filter(rule => rule.source === "/((?!preview$).*)")
  assert.equal(matching.length, 1)
  const headers = matching[0]!.headers
  assert.ok(Array.isArray(headers) && headers.length === Object.keys(siteShellHeaders).length)
  const parsed: Record<string, string> = {}
  for (const value of headers) {
    const item = shellRecord(value)
    assert.deepEqual(Object.keys(item).sort(), ["key", "value"])
    assert.ok(typeof item.key === "string" && /^[a-z-]+$/iu.test(item.key) && typeof item.value === "string")
    assert.ok(!Object.hasOwn(parsed, item.key.toLowerCase()))
    parsed[item.key.toLowerCase()] = item.value
  }
  assert.deepEqual(parsed, siteShellHeaders, "Ordinary production CSP/header contract changed")
}
/** Exported only to let the integration owner create and review the baseline
 * manifest after proving its exact clean Git tree. This routine never accepts
 * or manufactures provenance and never invokes Git or a build. */
export async function readShellSnapshot(directory: string, current: boolean): Promise<ShellSnapshot> {
  assert.ok(isAbsolute(directory))
  assert.equal(await realpath(directory), directory)
  const rootFiles = (await opendir(directory))
  const config: string[] = []
  for await (const entry of rootFiles) {
    if (entry.isDirectory() || entry.name.startsWith(".")) continue
    assert.ok(entry.isFile(), "Shell config cannot be a symlink or special file")
    assert.ok(/\.(?:json|ts)$|^bun\.lock$/u.test(entry.name) || /^(?:AGENTS|README)\.md$/u.test(entry.name),
      `Unreviewed shell root input ${entry.name}`)
    config.push(entry.name)
    assert.ok(config.length <= 32)
  }
  const sources = [...config, ...(await inventory(join(directory, "src"))).map(path => `src/${path}`),
    ...(await inventory(join(directory, "scripts"))).map(path => `scripts/${path}`)].sort()
  assert.ok(sources.length > 20 && sources.length <= 160)
  const input = await readArtifacts(directory, sources)
  assertShellHeaders(JSON.parse(Buffer.from(await readPreviewFile(join(directory, "vercel.json"), 64 * 1024)).toString()))
  const output = join(directory, "dist")
  const paths = await inventory(output)
  const { artifacts, files } = await readArtifacts(output, paths)
  assert.deepEqual(await inventory(output), paths, "Built file inventory changed during snapshot")
  const stylesheets: string[][] = []
  for (const route of ["/", "/404.html"]) {
    const bytes = files.get(route)
    assert.ok(bytes !== undefined && bytes.byteLength <= 256 * 1024)
    const html = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    assert.ok(!/\{\{[^{}]*\}\}|\s(?:on\w+|style)\s*=|<(?:iframe|object|embed)\b/iu.test(html), "Unadmitted ordinary HTML")
    const css = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"\s*\/?\s*>/gu)].map(match => match[1]!)
    assert.equal(css.length, current ? 2 : 1)
    assert.equal(new Set(css).size, css.length)
    for (const path of css) { shellResource(path); assert.ok(files.has(path) && path.endsWith(".css")) }
    for (const match of html.matchAll(/<(?:script|img)\b[^>]*\bsrc="([^"]+)"/gu)) {
      const path = match[1]!
      shellResource(path)
      assert.ok(files.has(path), `HTML executable/media outside immutable loopback inventory: ${path}`)
    }
    stylesheets.push(css)
  }
  assert.deepEqual(stylesheets[0], stylesheets[1], "Both ordinary documents must share the same stylesheets")
  if (current) assert.match(stylesheets[0]![1]!, /^\/assets\/site-[a-f0-9]{64}\.css$/u)
  assert.ok([...files.keys()].filter(path => path.endsWith(".woff2")).length >= 13)
  return { inputs: input.artifacts, artifacts, files, stylesheets: stylesheets[0]! }
}
export function assertShellBaselineManifest(value: unknown, snapshot: ShellSnapshot, profile?: typeof siteInstallBaselineProfile): void {
  assert.ok(profile === undefined || profile === siteInstallBaselineProfile, "Unknown baseline profile")
  const manifest = shellRecord(value)
  assert.deepEqual(Object.keys(manifest).sort(), ["artifacts", "checkoutRevision", "inputs", "schemaVersion", "sourceRevision", "sourceTree",
    ...(profile === undefined ? [] : ["baselineProfile"])].sort())
  assert.equal(manifest.schemaVersion, profile === undefined ? 1 : 2)
  assert.equal(manifest.sourceRevision, profile === undefined ? siteShellBaselineRevision : siteInstallBaselineRevision)
  assert.equal(manifest.sourceTree, profile === undefined ? siteShellBaselineTree : siteInstallBaselineTree)
  if (profile === undefined) assert.ok(typeof manifest.checkoutRevision === "string" && /^[a-f0-9]{40}$/u.test(manifest.checkoutRevision))
  else {
    assert.equal(manifest.baselineProfile, siteInstallBaselineProfile)
    assert.equal(manifest.checkoutRevision, siteInstallBaselineRevision, "Install baseline must be the exact pre-migration checkout")
  }
  assert.equal(snapshot.stylesheets.length, profile === undefined ? 1 : 2)
  assert.deepEqual(manifest.inputs, snapshot.inputs, "Baseline source/config bytes differ from the reviewed manifest")
  assert.deepEqual(manifest.artifacts, snapshot.artifacts, "Baseline built bytes differ from the reviewed manifest")
}
export function assertShellSnapshotUnchanged(before: ShellSnapshot, after: ShellSnapshot): void {
  assert.deepEqual(after.inputs, before.inputs, "Authoritative source/config input bytes changed during native verification")
  assert.deepEqual(after.artifacts, before.artifacts, "Authoritative built artifact bytes changed during native verification")
  assert.deepEqual(after.stylesheets, before.stylesheets)
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
  const result = await Bun.build({ entrypoints: [join(appDirectory, "scripts/site-shell-browser-driver.mjs")], target: "node",
    env: "disable", format: "esm", minify: false, sourcemap: "none", packages: "external" })
  assert.ok(result.success && result.outputs.length === 1, "Could not compile the private Node shell worker")
  const bytes = new Uint8Array(await result.outputs[0]!.arrayBuffer())
  assert.ok(bytes.byteLength > 0 && bytes.byteLength <= workerDriverLimit)
  assert.ok(!/\bBun\s*\.|["'](?:bun|@hraness\/direct)(?:["'/])/u.test(Buffer.from(bytes).toString()), "Node worker gained a Bun/Direct runtime edge")
  const path = join(profile, "site-shell-browser-driver.mjs")
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 })
  return { path, bytes }
}
interface ShellObservation { readonly result: Record<string, unknown>; readonly phases: readonly Uint8Array[] }
async function observe(directory: string, request: ShellRequest, signal: AbortSignal, exited: Promise<unknown>, absoluteDeadline: number): Promise<ShellObservation> {
  const limit = request.scope === "install-copy" ? siteCopyDeadlineMs : siteShellDeadlineMs
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
        result = (request.scope === "install-copy" ? parseCopyPhase : parseShellPhase)(decodeWorkerJson(bytes), sequence, request)
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
    return (request.scope === "install-copy" ? parseCopyCaseFailure : parseShellCaseFailure)(
      decodeWorkerJson(await readPreviewFile(join(profile, "site-shell-case-failure.json"), workerProtocolLimit)), request)
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined
    throw error
  }
}

export async function verifySiteShell(args: readonly string[], scope: "shell" | "install-copy" | "install-shell" = "shell"): Promise<void> {
  assert.ok(scope === "shell" || scope === "install-copy" || scope === "install-shell")
  const baselineProfile = scope === "shell" ? undefined : siteInstallBaselineProfile
  const limit = scope === "install-copy" ? siteCopyDeadlineMs : siteShellDeadlineMs
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
  let current: ShellSnapshot | undefined, baseline: ShellSnapshot | undefined
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
      current = await step(() => readShellSnapshot(actualApp, true))
      baseline = await step(() => readShellSnapshot(options.baseline, baselineProfile !== undefined))
      manifestBefore = Uint8Array.from(await step(() => readPreviewFile(options.manifest, 128 * 1024)))
      assertShellBaselineManifest(JSON.parse(Buffer.from(manifestBefore).toString()), baseline, baselineProfile)
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
      profile = await mkdtemp(join(await realpath(tmpdir()), "slopcamera-site-shell-"))
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
      const request = parseShellRequest({ schemaVersion: 1, token: randomUUID(), ...(scope === "shell" ? {} : { scope, baselineProfile }), appDirectory: actualApp, chromeExecutable: browserPath,
        endpoint, current: browserPayload(current, currentServer.server.url.origin), baseline: browserPayload(baseline, baselineServer.server.url.origin) })
      workerRequest = request
      const requestPath = join(profile, "site-shell-browser-request.json"), bytes = encodeWorkerJson(request)
      await writeFile(requestPath, bytes, { flag: "wx", mode: 0o600 })
      inputs = [await readWorkerInput(driver.path, workerDriverLimit), await readWorkerInput(requestPath, workerProtocolLimit)]
      assert.ok(Buffer.from(inputs[0]!.bytes).equals(Buffer.from(driver.bytes)))
      assert.ok(Buffer.from(inputs[1]!.bytes).equals(Buffer.from(bytes)))
      await writeFile(join(profile, "site-shell-inputs.json"), `${JSON.stringify({ schemaVersion: 1, executableInputs,
        packageInputs: packageInputs.map(input => ({ path: input.path, identity: input.identity, sha256: digest(input.bytes) })),
        current: { inputs: current.inputs, artifacts: current.artifacts }, baseline: JSON.parse(Buffer.from(manifestBefore).toString()),
        worker: inputs.map(input => ({ path: input.path, identity: input.identity, sha256: digest(input.bytes) })) })}\n`, { flag: "wx", mode: 0o600 })
      await writeFile(join(profile, "site-shell-driver.snapshot.mjs"), inputs[0]!.bytes, { flag: "wx", mode: 0o600 })
      await writeFile(join(profile, "site-shell-request.snapshot.json"), inputs[1]!.bytes, { flag: "wx", mode: 0o600 })
      signal.throwIfAborted()
      worker = spawnVerificationServer({ cwd: actualApp, detachedProcessGroup: true, logLimit: 12_000,
        omitEnvironment: ["NODE_OPTIONS", "NODE_PATH"], command: [node, driver.path, actualApp, requestPath] })
      console.error(`slopcamera-site-shell: verifying ${(scope === "install-copy" ? siteCopyCases : siteShellCases).length} mandatory ${scope} current/baseline cases`)
      observation = await observe(protocolDirectory, request, signal, worker.exited, deadline)
      await step(() => bounded(worker!.exited, "Shell worker successful exit", 5_000))
      assert.equal(worker.exitCode(), 0)
      completed = true
      return { ...observation.result, nativeBrowserZoom: false, reflowEquivalent: scope !== "install-copy" ? "1440x900 at 200% => 720x450 CSS viewport" : false,
        productionHeaders: siteShellHeaders, internetRequestsAllowed: false, analytics: "unaltered scripts on neutral loopback origin",
        baselineManifestSha256: digest(manifestBefore), currentArtifacts: current.artifacts }
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
        assertShellSnapshotUnchanged(current!, await readShellSnapshot(actualApp, true))
        assertShellSnapshotUnchanged(baseline!, await readShellSnapshot(options.baseline, baselineProfile !== undefined))
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
        await writeFile(join(profile!, "site-shell-failure.json"), receipt, { flag: "wx", mode: 0o600 })
        console.error(`slopcamera-site-shell: retained failure evidence at ${profile}`)
      })
      if (failures.length > 0) throw new AggregateError(failures, "Shell resource collection failed")
    })
    console.log(JSON.stringify({ ...result, accepted: true, workerProcessGroupAbsent: workerAbsent, browserProcessGroupAbsent: chromeAbsent,
      listenersCollected: servers.every(server => server.closed), outputEof: true, evidenceDirectory: profile }))
  } finally { clearTimeout(deadlineTimer) }
}

if (import.meta.main) {
  try { await verifySiteShell(process.argv.slice(2)) } catch (error) {
    process.exitCode = 1
    console.error(previewFailureSummary(error).replace("slopcamera-preview:", "slopcamera-site-shell:"))
  }
}
