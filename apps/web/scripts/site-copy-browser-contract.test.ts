import { expect, test } from "bun:test"
import type { Page } from "playwright-core"
import { assertCopyPorts, compareCopyEvidence, copyCaseFailure, copyElementKeys, copyNegativeControls, copyProperties, copySteps, measureCopy, parseCopyCaseFailure,
  parseCopyPhase, settleCopyPaint, stableCopyPaint, siteCopyCases, siteCopyDeadlineMs, type CopyEvidence } from "./site-copy-browser-contract"
import { compareShellElements, parseShellPhase, parseShellRequest, shellPaintProperties, siteInstallBaselineProfile, siteShellCases, siteShellDeadlineMs, type ShellRequest } from "./site-shell-browser-contract"
import { normalizeInstallTransport } from "./site-install-dom"
import { decodeWorkerJson, encodeWorkerJson } from "./preview-browser-protocol"

const request = { schemaVersion: 1, token: "12345678-1234-1234-1234-123456789abc", scope: "install-copy", baselineProfile: siteInstallBaselineProfile } as ShellRequest
const phase = { schemaVersion: 1, token: request.token, scope: "install-copy", baselineProfile: siteInstallBaselineProfile, sequence: 2, kind: "result", node: "24.18.1",
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
    baseline: { origin: "http://127.0.0.1:1236", resources, stylesheets: ["/base.css", resources.find(path => path.startsWith("/assets/"))], finalCss: resources.find(path => path.startsWith("/assets/")) } }
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
const command = "bun apps/desktop/dist/cli/main.js skill install --target agents"
test("copy observations require the exact current source-install command even when every port agrees", () => {
  for (const changedCommand of [
    "npx skills add https://github.com/hraness/slopcamera/tree/v1.2.3 --skill slopcamera",
    command.replace("--target agents", "--target codex"), `${command} `,
  ]) {
    const changedPorts = { ...ports, writes: ports.writes.map(() => changedCommand),
      fallbacks: ports.fallbacks.map(value => ({ ...value, value: changedCommand, end: changedCommand.length })) }
    expect(() => assertCopyPorts(changedPorts, changedCommand)).not.toThrow()
    const changed = { ...phase, observations: phase.observations.map(value => ({ ...value,
      command: changedCommand, current: changedPorts, baseline: changedPorts })) }
    expect(() => parseCopyPhase(changed, 2, request)).toThrow()
  }
})
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

function copyPaintFixture() {
  const selectors = [...new Set(copyElementKeys.map(key => key.replace(/\[\d+\]$/u, "")))]
  const counts = selectors.map(selector => copyElementKeys.filter(key => key.startsWith(`${selector}[`)).length)
  const properties = [...shellPaintProperties, ...copyProperties]
  let now = 0, sequence = 0, readCost = 0
  const frames = new Map<number, () => void>(), timers = new Map<number, { at: number; callback: () => void }>()
  const selected = new Map<string, NativeElement[]>(), reads: string[] = []
  const view = {
    scrollY: 0, performance: { now: () => now },
    getComputedStyle: (owner: NativeElement) => {
      reads.push(`${owner.key}:style`)
      return { getPropertyValue: (property: string) => owner.styles[property] ?? "" }
    },
    requestAnimationFrame: (callback: () => void) => { frames.set(++sequence, callback); return sequence },
    cancelAnimationFrame: (id: number) => { frames.delete(id) },
    setTimeout: (callback: () => void, delay: number) => { timers.set(++sequence, { at: now + delay, callback }); return sequence },
    clearTimeout: (id: number) => { timers.delete(id) },
    get Element() { return NativeElement },
  }
  const document = { defaultView: view, documentElement: undefined as unknown as NativeElement,
    activeElement: undefined as unknown as NativeElement,
    querySelectorAll: (selector: string) => selected.get(selector) ?? [],
    querySelector: (selector: string) => selected.get(selector)?.[0] ?? null }
  class NativeElement {
    ownerDocument = document
    isConnected = true
    parentElement: NativeElement | null = null
    styles: Record<string, string> = Object.fromEntries(properties.map(property => [property, "unchanged"]))
    attributes: Record<string, string> = {}
    rect = [0, 0, 40, 20]
    textContent = "exact text"
    hover = false
    animations: { playState: string; pending: boolean; playbackRate: number; effect: {
      target: NativeElement; getComputedTiming(): { endTime: number; duration: number; iterations: number }
    } }[] = []
    constructor(readonly key: string) {}
    getAttribute(key: string) { return this.attributes[key] ?? null }
    matches(selector: string) { expect(selector).toBe(":hover"); return this.hover }
    contains(owner: NativeElement): boolean { return owner === this || (owner.parentElement !== null && this.contains(owner.parentElement)) }
    getBoundingClientRect() {
      reads.push(`${this.key}:rect`); now += readCost
      return { x: this.rect[0], y: this.rect[1], width: this.rect[2], height: this.rect[3] }
    }
    getAnimations(options?: { subtree: boolean }) {
      reads.push(`${this.key}:animations`)
      return options?.subtree ? owners.flatMap(owner => this.contains(owner) ? owner.animations : []) : this.animations
    }
  }
  const owners = copyElementKeys.map(key => new NativeElement(key))
  const root = owners[0]
  if (!root) throw new Error("Missing fixture root")
  const html = new NativeElement("html"), body = new NativeElement("body")
  root.parentElement = body; body.parentElement = html
  for (const owner of owners.slice(1)) owner.parentElement = root
  for (const selector of selectors) selected.set(selector, owners.filter(owner => owner.key.startsWith(`${selector}[`)))
  document.documentElement = html; document.activeElement = owners.find(owner => owner.key === "[data-copy-command-button][0]") ?? root
  const options = { selectors, counts, properties, label: "copy paint fixture" }
  return { owners, root, document, view, selected, reads, options,
    start() { const result = settleCopyPaint(root as unknown as Element, options); void result.catch(() => {}); return result },
    animation(index: number, pending = true) {
      const owner = owners[index]
      if (!owner) throw new Error("Missing fixture owner")
      const animation = { playState: "running", pending, playbackRate: 1,
        effect: { target: owner, getComputedTiming: () => ({ endTime: 0.01, duration: 0.01, iterations: 1 }) } }
      owner.animations = [animation]; return animation
    },
    frame(at = now + 16) { now = at; const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback() },
    advance(at: number) { now = at; for (const [id, timer] of [...timers]) if (timer.at <= at) { timers.delete(id); timer.callback() } },
    setReadCost(value: number) { readCost = value },
    get pending() { return [frames.size, timers.size] },
  }
}

test("copy stability serializes the complete unchanged measurement inventory into the real native observer", async () => {
  let captured: unknown, callback: unknown
  const page = { evaluate: async () => {}, locator: (selector: string) => {
    expect(selector).toBe("#install")
    return { evaluate: async (fn: unknown, input: unknown) => { callback = fn; captured = input; return [] } }
  } } as unknown as Page
  await stableCopyPaint(page, "complete paint")
  const fixture = copyPaintFixture()
  expect(callback).toBe(settleCopyPaint)
  expect(captured).toEqual({ ...fixture.options, label: "complete paint" })
  const result = fixture.start(); fixture.frame(); expect(fixture.pending).toEqual([1, 1]); fixture.frame()
  const elements = await result
  expect(elements.map(element => element.key)).toEqual(copyElementKeys)
  for (const element of elements) expect(Object.keys(element.styles)).toEqual([...shellPaintProperties, ...copyProperties])
  expect(fixture.pending).toEqual([0, 0])
  expect(fixture.reads.indexOf("#install[0]:animations")).toBeGreaterThan(fixture.reads.indexOf("[data-copy-command-status][0]:style"))
})

test("copy paint waits through parent-to-child transition chains and does not accept a fixed frame count", async () => {
  for (const chainLength of [1, 2, 3, 12, 20]) {
    const fixture = copyPaintFixture(), result = fixture.start()
    for (let index = 0; index < chainLength; index++) {
      fixture.owners.forEach(owner => { owner.animations = [] })
      const animation = fixture.animation(index % fixture.owners.length)
      fixture.frame(); expect(fixture.pending).toEqual([1, 1])
      animation.pending = false
      fixture.frame(); expect(fixture.pending).toEqual([1, 1])
    }
    fixture.owners.forEach(owner => { owner.animations = [] })
    fixture.frame(); expect(fixture.pending).toEqual([1, 1]); fixture.frame()
    expect(await result).toHaveLength(22); expect(fixture.pending).toEqual([0, 0])
  }
})

test("stable wrong copy paint settles but still fails the original exact comparison", async () => {
  const baseline = copyPaintFixture(), oldResult = baseline.start(); baseline.frame(); baseline.frame()
  const old = await oldResult
  for (const index of [0, 14, 20, 21]) {
    const fixture = copyPaintFixture(), owner = fixture.owners[index]
    if (!owner) throw new Error("Missing fixture owner")
    owner.styles["font-size"] = "stable wrong"
    const result = fixture.start(); fixture.frame(); fixture.frame()
    const actual = await result
    expect(() => compareShellElements(actual, old, "wrong copy paint")).toThrow()
    expect(fixture.pending).toEqual([0, 0])
  }
})

test("copy paint clears prior stability after any full-sample change", async () => {
  const fixture = copyPaintFixture(), result = fixture.start(); fixture.frame()
  const owner = fixture.owners[20]
  if (!owner) throw new Error("Missing fixture child")
  owner.styles["font-size"] = "child inherited change"
  fixture.frame(); expect(fixture.pending).toEqual([1, 1]); fixture.frame()
  expect((await result)[20]?.styles["font-size"]).toBe("child inherited change")
})

test("copy stability rejects identity, semantic, animation and invalid native-clock loss without leaking observers", async () => {
  const mutations: ((fixture: ReturnType<typeof copyPaintFixture>) => void)[] = [
    fixture => { fixture.selected.set(".copy-command__note > code", []) },
    fixture => { fixture.root.isConnected = false },
    fixture => { fixture.document.activeElement = fixture.root },
    fixture => { fixture.document.documentElement.attributes["data-theme"] = "foreign" },
    fixture => { fixture.root.textContent = "changed semantics" },
    fixture => { fixture.root.hover = true },
    fixture => { fixture.root.rect[0] = Infinity },
    fixture => { fixture.animation(20).playState = "paused" },
    fixture => { fixture.animation(20).playbackRate = 0 },
    fixture => { fixture.animation(20).effect.getComputedTiming = () => ({ endTime: Infinity, duration: 1, iterations: 1 }) },
  ]
  for (const mutate of mutations) {
    const fixture = copyPaintFixture(), result = fixture.start(); fixture.frame(); mutate(fixture); fixture.frame()
    await expect(result).rejects.toThrow(); expect(fixture.pending).toEqual([0, 0])
  }
  for (const at of [1000, 1001, -1, Infinity, NaN]) {
    const fixture = copyPaintFixture(), result = fixture.start(); fixture.frame(); fixture.frame(at)
    await expect(result).rejects.toThrow(/1000ms/u); expect(fixture.pending).toEqual([0, 0])
  }
  const blocked = copyPaintFixture(), pending = blocked.start(); blocked.advance(1000)
  await expect(pending).rejects.toThrow(/1000ms/u); expect(blocked.pending).toEqual([0, 0])
  const costly = copyPaintFixture(), slow = costly.start(); costly.setReadCost(100); costly.frame()
  await expect(slow).rejects.toThrow(/1000ms/u); expect(costly.pending).toEqual([0, 0])
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
  expect(() => compareCopyEvidence(evidence, { ...evidence, command: "historical install command" }, "changed command")).toThrow()
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
