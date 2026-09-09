import { expect, test } from "bun:test"
import { parseShellCaseFailure, parseShellPhase, parseShellRequest, shellCaseFailure, shellScopeFields,
  siteInstallBaselineProfile, siteInstallBaselineRevision, siteInstallBaselineTree,
  siteShellBaselineRevision, siteShellBaselineTree, siteShellCases, siteShellDeadlineMs, type ShellRequest } from "./site-shell-browser-contract"
import { assertShellBaselineManifest, type ShellSnapshot } from "./verify-site-shell"

const finalCss = `/assets/site-${"a".repeat(64)}.css`
const resources = ["/", "/404.html", "/base.css", finalCss, ...Array.from({ length: 20 }, (_, index) => `/font-${index}.woff2`)].sort()
function request(scope?: "install-shell" | "install-copy"): ShellRequest {
  return parseShellRequest({ schemaVersion: 1, token: "12345678-1234-1234-1234-123456789abc",
    appDirectory: "/app", chromeExecutable: "/chrome", endpoint: "ws://127.0.0.1:1234/devtools/browser/abc-123",
    ...(scope === undefined ? {} : { scope, baselineProfile: siteInstallBaselineProfile }),
    current: { origin: "http://127.0.0.1:1235", resources, stylesheets: ["/base.css", finalCss], finalCss },
    baseline: { origin: "http://127.0.0.1:1236", resources, stylesheets: scope === undefined ? ["/base.css"] : ["/base.css", finalCss],
      finalCss: scope === undefined ? "/base.css" : finalCss } })
}
test("only the exact install-family profile admits the two-stylesheet pre-migration baseline", () => {
  expect(siteInstallBaselineRevision).toBe("ed48ebb3bb3aceb30fe369586467d2efbfa42455")
  expect(siteInstallBaselineTree).toBe("b3a2708ae6fc0a09dbf7d3eb694b2eebecdc1342")
  const historical = request()
  expect(shellScopeFields(historical)).toEqual({})
  expect(historical.baseline.stylesheets).toHaveLength(1)
  for (const scope of ["install-shell", "install-copy"] as const) {
    const input = request(scope)
    expect(parseShellRequest(JSON.parse(JSON.stringify(input)))).toEqual(input)
    expect(input.baseline.stylesheets).toHaveLength(2)
    expect(() => parseShellRequest({ ...historical, baseline: input.baseline })).toThrow()
    expect(() => parseShellRequest({ ...input, baseline: historical.baseline })).toThrow()
    for (const profile of [undefined, null, "historical", "install-family-ed48ebb3-v2", true]) {
      expect(() => parseShellRequest({ ...input, baselineProfile: profile })).toThrow()
    }
    for (const scope of [undefined, null, "shell", "current-design", "copy", true]) {
      expect(() => parseShellRequest({ ...input, scope })).toThrow()
    }
    const { baselineProfile: _profile, ...missingProfile } = input
    expect(() => parseShellRequest(missingProfile)).toThrow()
    expect(() => parseShellRequest({ ...input, baseline: { ...input.baseline, stylesheets: ["/base.css", finalCss, "/extra.css"] } })).toThrow()
  }
  expect(() => parseShellRequest({ ...historical, baselineProfile: siteInstallBaselineProfile })).toThrow()
})

test("new shell phases and every partial prefix remain distinct from historical or copy acceptance", () => {
  const historical = request(), input = request("install-shell")
  expect(siteShellCases).toHaveLength(76); expect(siteShellDeadlineMs).toBe(720_000)
  for (const sequence of [0, 1, 2] as const) {
    const old = { schemaVersion: 1, token: input.token, sequence, kind: ["started", "connected", "result"][sequence],
      ...(sequence === 1 ? {} : { node: "24.18.1", playwright: "1.62.0" }),
      ...(sequence !== 2 ? {} : { browser: "151.0.7922.34", cases: siteShellCases.map(item => item.name),
        baselineCompared: true, closed: true, negativeControls: ["/", "/404.html"] }) }
    const phase = { ...old, ...shellScopeFields(input) }
    expect(parseShellPhase(old, sequence, historical)).toEqual(old)
    expect(parseShellPhase(phase, sequence, input)).toEqual(phase)
    expect(() => parseShellPhase(old, sequence, input)).toThrow()
    expect(() => parseShellPhase(phase, sequence, historical)).toThrow()
    expect(() => parseShellPhase(phase, sequence, request("install-copy"))).toThrow()
    for (const patch of [{ scope: "install-copy" }, { baselineProfile: "historical" }, { baselineProfile: undefined }]) {
      expect(() => parseShellPhase({ ...phase, ...patch }, sequence, input)).toThrow()
    }
    if (sequence === 2) for (const patch of [{ cases: siteShellCases.slice(1).map(item => item.name) }, { closed: false }, { negativeControls: ["/"] }]) {
      expect(() => parseShellPhase({ ...phase, ...patch }, sequence, input)).toThrow()
    }
  }
  for (const [index, scenario] of siteShellCases.entries()) {
    const prefix = siteShellCases.slice(0, index).map(item => item.name)
    const failure = shellCaseFailure(input, scenario.name, "pair", prefix, new Error("native red"))
    expect(parseShellCaseFailure(JSON.parse(JSON.stringify(failure)), input)).toEqual(failure)
    expect(() => parseShellCaseFailure(failure, historical)).toThrow()
    expect(() => parseShellCaseFailure(shellCaseFailure(historical, scenario.name, "pair", prefix, new Error("old red")), input)).toThrow()
    for (const patch of [{ baselineProfile: "historical" }, { scope: "install-copy" }, { comparedCases: [...prefix, scenario.name] }]) {
      expect(() => parseShellCaseFailure({ ...failure, ...patch }, input)).toThrow()
    }
  }
})

test("reviewed install manifest seals exact checkout, source tree and artifact inputs without accepting migration HEAD", () => {
  const snapshot: ShellSnapshot = { inputs: [{ path: "src/index.html", bytes: 123, sha256: "a".repeat(64) }],
    artifacts: [{ path: "index.html", bytes: 321, sha256: "b".repeat(64) }], files: new Map(), stylesheets: ["/base.css", finalCss] }
  const manifest = { schemaVersion: 2, baselineProfile: siteInstallBaselineProfile, sourceRevision: siteInstallBaselineRevision,
    sourceTree: siteInstallBaselineTree, checkoutRevision: siteInstallBaselineRevision, inputs: snapshot.inputs, artifacts: snapshot.artifacts }
  expect(() => assertShellBaselineManifest(manifest, snapshot, siteInstallBaselineProfile)).not.toThrow()
  for (const patch of [{ schemaVersion: 1 }, { baselineProfile: "historical" }, { sourceRevision: siteShellBaselineRevision },
    { sourceTree: siteShellBaselineTree }, { checkoutRevision: "37e77395b54c643d8bde048c432377c1a1f862ba" },
    { checkoutRevision: siteShellBaselineRevision }, { inputs: [] }, { artifacts: [] }, { relaxed: true }]) {
    expect(() => assertShellBaselineManifest({ ...manifest, ...patch }, snapshot, siteInstallBaselineProfile)).toThrow()
  }
  for (const key of ["inputs", "artifacts"] as const) {
    for (const field of ["path", "bytes", "sha256"] as const) {
      const changed = { ...snapshot, [key]: snapshot[key].map(item => ({ ...item, [field]: field === "bytes" ? 1 : "foreign" })) }
      expect(() => assertShellBaselineManifest(manifest, changed, siteInstallBaselineProfile)).toThrow()
    }
  }
  const historicalSnapshot = { ...snapshot, stylesheets: ["/base.css"] }
  const historical = { schemaVersion: 1, sourceRevision: siteShellBaselineRevision, sourceTree: siteShellBaselineTree,
    checkoutRevision: siteShellBaselineRevision, inputs: snapshot.inputs, artifacts: snapshot.artifacts }
  expect(() => assertShellBaselineManifest(historical, historicalSnapshot)).not.toThrow()
  expect(() => assertShellBaselineManifest(manifest, snapshot)).toThrow()
  expect(() => assertShellBaselineManifest(historical, historicalSnapshot, siteInstallBaselineProfile)).toThrow()
  expect(() => assertShellBaselineManifest(manifest, historicalSnapshot, siteInstallBaselineProfile)).toThrow()
  expect(() => assertShellBaselineManifest(historical, snapshot)).toThrow()
  expect(() => assertShellBaselineManifest(manifest, snapshot, "foreign" as typeof siteInstallBaselineProfile)).toThrow()
})
