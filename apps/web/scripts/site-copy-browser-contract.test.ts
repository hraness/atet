import { expect, test } from "bun:test"
import type { Page } from "playwright-core"
import { assertCopyPorts, compareCopyEvidence, copyCaseFailure, copyElementKeys, copyNegativeControls, copyProperties, copySteps, measureCopy, parseCopyCaseFailure,
  parseCopyPhase, siteCopyCases, siteCopyDeadlineMs, type CopyEvidence } from "./site-copy-browser-contract"
import { parseShellPhase, parseShellRequest, siteShellCases, siteShellDeadlineMs, type ShellRequest } from "./site-shell-browser-contract"
import { normalizeInstallTransport } from "./site-install-dom"
import { decodeWorkerJson, encodeWorkerJson } from "./preview-browser-protocol"

const request = { schemaVersion: 1, token: "12345678-1234-1234-1234-123456789abc", scope: "install-copy" } as ShellRequest
const phase = { schemaVersion: 1, token: request.token, scope: "install-copy", sequence: 2, kind: "result", node: "24.18.1",
  playwright: "1.62.0", browser: "151.0.7922.34", cases: siteCopyCases.map(item => item.name),
  baselineCompared: true, closed: true, negativeControls: copyNegativeControls,
  get observations() { return siteCopyCases.map(item => ({ name: item.name, command, steps: copySteps, elementsPerSample: copyElementKeys.length, current: ports, baseline: ports })) } }
test("copy-only protocol is closed and cannot substitute for the original 76-case matrix", () => {
  expect(siteShellCases).toHaveLength(76); expect(siteShellDeadlineMs).toBe(720_000)
  expect(siteCopyCases).toHaveLength(8); expect(siteCopyDeadlineMs).toBe(180_000)
  expect(new Set(siteCopyCases.map(item => `${item.width}/${item.theme}/${item.forced}`)).size).toBe(8)
  expect(parseCopyPhase(phase, 2, request)).toEqual(phase)
  expect(parseCopyPhase(decodeWorkerJson(encodeWorkerJson(phase)), 2, request)).toEqual(phase)
  for (const [key, value] of Object.entries({ scope: "shell", node: "24.18.0", playwright: "1.61.0", browser: "ambient",
    token: "foreign", closed: false, baselineCompared: false, cases: siteShellCases.map(item => item.name), negativeControls: [], observations: [] })) {
    expect(() => parseCopyPhase({ ...phase, [key]: value }, 2, request)).toThrow()
  }
  expect(() => parseShellPhase(phase, 2, request)).toThrow()
  expect(() => parseCopyPhase(phase, 2, { ...request, scope: undefined } as unknown as ShellRequest)).toThrow()
  expect(() => parseCopyPhase({ ...phase, relaxed: true }, 2, request)).toThrow()
  expect(() => parseCopyPhase(phase, 1, request)).toThrow()
  const resources = ["/", "/404.html", ...Array.from({ length: 20 }, (_, index) => `/asset-${index}.woff2`), "/base.css", `/assets/site-${"a".repeat(64)}.css`].sort()
  const complete = { ...request, appDirectory: "/app", chromeExecutable: "/chrome", endpoint: "ws://127.0.0.1:1234/devtools/browser/abc-123",
    current: { origin: "http://127.0.0.1:1235", resources, stylesheets: ["/base.css", resources.find(path => path.startsWith("/assets/"))], finalCss: resources.find(path => path.startsWith("/assets/")) },
    baseline: { origin: "http://127.0.0.1:1236", resources, stylesheets: ["/base.css"], finalCss: "/base.css" } }
  expect(parseShellRequest(complete).scope).toBe("install-copy")
  for (const scope of [null, undefined, "shell", "copy", true]) expect(() => parseShellRequest({ ...complete, scope })).toThrow()
})
test("copy partial evidence certifies only the exact preceding paired prefix", () => {
  for (let index = 0; index < siteCopyCases.length; index++) {
    const item = siteCopyCases[index]
    expect(item).toBeDefined()
    if (!item) throw new Error("Missing finite case")
    const failure = copyCaseFailure(request, item.name, "pair", siteCopyCases.slice(0, index).map(value => value.name), new Error("native red"))
    expect(parseCopyCaseFailure(failure, request)).toEqual(failure)
    for (const change of [{ completed: true }, { accepted: true }, { scope: "shell" }, { stage: "success" }, { error: "bad\ncontrol" },
      { scenario: "foreign" }, { comparedCases: [...failure.comparedCases, item.name] }]) {
      expect(() => parseCopyCaseFailure({ ...failure, ...change }, request)).toThrow()
    }
  }
})
const command = "npx skills add https://github.com/hraness/atet/tree/v1.2.3 --skill atet"
test("actual copy sampler passes every authored clipping, list and border-image reset to the native observer", async () => {
  let properties: readonly string[] = []
  const page = { evaluate: async (_callback: unknown, input: { properties: readonly string[] }) => { properties = input.properties; return [] } } as unknown as Page
  await measureCopy(page)
  expect(copyProperties).toEqual(["font-style", "font-variant", "font-stretch", "text-decoration-thickness", "text-underline-offset",
    "clip", "clip-path", "list-style-type", "list-style-position", "list-style-image", "border-image-source", "border-image-slice",
    "border-image-width", "border-image-outset", "border-image-repeat"])
  expect(properties.slice(-copyProperties.length)).toEqual(copyProperties)
  expect(properties).toContain("opacity"); expect(properties).toContain("outline-style")
  expect(properties).toContain("border-left-color"); expect(new Set(properties).size).toBe(properties.length)
})
const ports = { write: "success" as const, fallback: "throw" as const, writes: Array.from({ length: 5 }, () => command),
  fallbacks: Array.from({ length: 3 }, () => ({ value: command, readonly: true, start: 0, end: command.length, focused: true, offscreen: true })),
  timers: [{ delay: 2500, started: 100, fired: 2600, cancelled: false }, { delay: 2500, started: 3000, fired: null, cancelled: true },
    { delay: 2500, started: 3500, fired: null, cancelled: false }] }
test("copy evidence requires exact bytes, native selected fallback and an unaccelerated real reset", () => {
  expect(() => assertCopyPorts(ports, command)).not.toThrow()
  for (const mutation of [
    (value: typeof ports) => { value.writes[0] = "foreign" },
    (value: typeof ports) => { value.writes.pop() },
    (value: typeof ports) => { value.fallbacks[0]!.readonly = false },
    (value: typeof ports) => { value.fallbacks[0]!.focused = false },
    (value: typeof ports) => { value.fallbacks[0]!.offscreen = false },
    (value: typeof ports) => { value.fallbacks[0]!.end -= 1 },
    (value: typeof ports) => { value.timers[0]!.delay = 2499 },
    (value: typeof ports) => { value.timers[0]!.fired = 2599 },
    (value: typeof ports) => { value.timers[1]!.cancelled = false },
  ]) { const changed = structuredClone(ports); mutation(changed); expect(() => assertCopyPorts(changed, command)).toThrow() }
  for (const index of [0, 1, 2]) for (const [key, values] of [
    ["started", [Infinity, -Infinity, NaN, -1, "100", null, true]],
    ["fired", [Infinity, -Infinity, NaN, -1, "2600", true]],
    ["cancelled", ["true", "false", 0, 1, null, undefined]],
  ] as const) for (const value of values) {
    const timers = ports.timers.map((timer, at) => at === index ? { ...timer, [key]: value } : timer)
    expect(() => assertCopyPorts({ ...ports, timers } as unknown as Parameters<typeof assertCopyPorts>[0], command)).toThrow()
  }
  // Valid JSON can overflow to Infinity without containing a non-JSON token.
  const overflow = JSON.parse(JSON.stringify(phase).replace('"fired":2600', '"fired":1e309')) as unknown
  expect(() => parseCopyPhase(overflow, 2, request)).toThrow()
})
test("every declared native step compares the complete authored descendants and rejects paint/state loss", () => {
  const evidence: CopyEvidence = { command, ports, negativeControls: [], steps: copySteps.map(name => ({ name,
    elements: copyElementKeys.map(key => ({ key, rect: [1, 2, 3, 4], text: key, semantics: { role: null }, styles: { color: "gold", opacity: "1" } })) })) }
  expect(() => compareCopyEvidence(evidence, structuredClone(evidence), "same")).not.toThrow()
  for (let step = 0; step < copySteps.length; step++) for (let element = 0; element < copyElementKeys.length; element++) {
    const changed = structuredClone(evidence)
    const item = changed.steps[step]?.elements[element]
    if (!item) throw new Error("Missing finite sample")
    Object.assign(item.styles, { opacity: "0" })
    expect(() => compareCopyEvidence(changed, evidence, "changed descendant")).toThrow()
  }
  expect(() => compareCopyEvidence({ ...evidence, steps: evidence.steps.slice(1) }, evidence, "missing step")).toThrow()
  const missing = { ...evidence, steps: evidence.steps.map(step => ({ ...step, elements: step.elements.slice(1) })) }
  expect(() => compareCopyEvidence(missing, missing, "both missing same role")).toThrow()
})

function transport(current: boolean): string {
  const cls = (hook: string) => `class="${hook}${current ? " xcompiled" : ""}"`
  const added = current ? ' class="xcompiled"' : ""
  return '<aside class="unchanged">  Outside bytes\n</aside><section id="install">'
    + `<p ${cls("install-note")}>Note</p><div ${cls("cli-install")}>`
    + `${current ? "\n" : "\n              "}<p ${cls("panel-label")}>Tools</p><ol ${cls("install-commands")}>`
    + ["01", "02"].map(number => `${current ? "\n" : "\n                "}<li${added}><span${added}>${number}</span><code${added}>command</code></li>`).join("")
    + `</ol>${current ? "\n" : "\n              "}<p ${cls("panel-label")}>Skill</p>`
    + `<div ${cls("copy-command")} data-copy-command=""><code ${cls("copy-command__value")}>exact command</code>`
    + `<button ${cls("copy-command__button")}${current ? ' data-copy-idle-class="copy-command__button xcompiled" data-copy-copied-class="copy-command__button xcopied" data-copy-failed-class="copy-command__button xfailed"' : ""} data-copy-command-button="">Copy</button>`
    + `<p ${cls("copy-command__note")}>Bun <code${added}>alternate command</code></p><p ${cls("copy-command__status")} aria-live="polite"></p>`
    + (current ? '\n    <template data-copy-command-fallback=""><textarea class="xfallback" readonly=""></textarea></template>' : "")
    + `\n  </div><p ${cls("panel-note")}>A<a${added} href="/release">Release</a></p><p ${cls("panel-note")}>B<a${added} href="/skill">Skill</a></p></div></section><footer> Original </footer>`
}
test("install normalization removes only counted compiler transports and restores exactly 60 indentation bytes", () => {
  const old = transport(false), current = transport(true)
  expect(normalizeInstallTransport(current, true)).toBe(old)
  expect(normalizeInstallTransport(old, false)).toBe(old)
  expect(normalizeInstallTransport('<main class="route-state">404</main>', true)).toBe('<main class="route-state">404</main>')
  for (const [before, after] of [['Outside bytes', 'Outside changed'], ['<footer> Original ', '<footer> Different '], ['exact command', 'wrong command'],
    ['aria-live="polite"', 'aria-live="off"'], ['href="/release"', 'href="/foreign"'], ['alternate command', 'changed alternate']]) {
    if (!before || !after) throw new Error("Missing mutation")
    expect(normalizeInstallTransport(current.replace(before, after), true)).not.toBe(old)
  }
  for (const changed of [current.replace('data-copy-idle-class="copy-command__button xcompiled"', 'data-copy-idle-class="copy-command__button xforeign"'),
    current.replace('data-copy-failed-class="copy-command__button xfailed"', 'data-copy-failed-class="copy-command__button xcopied"'),
    current.replace('readonly=""', 'onclick="run()"'), current.replace('</textarea>', 'payload</textarea>'),
    current.replace('\n<li', '\n <li'), current.replace('class="install-note xcompiled"', 'class="install-note"'),
    current.replace('class="panel-note xcompiled"', 'class="foreign xcompiled"'), current + '<div data-copy-command=""></div>']) {
    expect(() => normalizeInstallTransport(changed, true)).toThrow()
  }
})
