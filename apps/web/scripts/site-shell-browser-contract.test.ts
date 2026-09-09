import { expect, test } from "bun:test"
import type { WebSocketRoute } from "playwright-core"
import { assertShellFocusFragments, assertShellFocusUnchanged, assertShellNode, assertShellSkipReveal, assertShellSystemPaintChanged, compareShellElements, compareShellEvidence, denyShellWebSocket, parseShellCaseFailure, parseShellPhase, parseShellRequest,
  resolvedShellTheme, settleShellAppearancePaint, settleShellFocusState, settleShellSystemPaint, shellAppearanceSteps, shellCaseFailure, shellContextLifecycle, shellFocusFragments, shellOperationTracker, shellResource, siteShellBaselineRevision, siteShellBaselineTree, siteShellCases, siteShellHeaders,
  type ShellCase, type ShellElement, type ShellEvidence, type ShellRequest } from "./site-shell-browser-contract"

function operationDeferred() {
  let resolve!: () => void, reject!: (reason: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test("case teardown admits only the owned page close and never a whole-browser disconnect", () => {
  for (const closing of [false, true]) {
    const errors: string[] = [], lifecycle = shellContextLifecycle(message => errors.push(message))
    if (closing) lifecycle.beginContextClose()
    lifecycle.pageClosed()
    expect(errors).toEqual(closing ? [] : ["Page closed before intentional context close"])
    lifecycle.browserDisconnected()
    expect(errors.at(-1)).toBe("Browser disconnected during shell case ownership")
    expect(errors.length).toBe(closing ? 1 : 2)
  }
})

test("browser operation settlement drains responses admitted by an earlier completion before close", async () => {
  const errors: string[] = [], order: string[] = [], first = operationDeferred(), later = operationDeferred()
  const tracker = shellOperationTracker(message => errors.push(message))
  void tracker.track("request and route", first.promise.then(() => {
    order.push("first")
    void tracker.track("late response body", later.promise.then(() => { order.push("later") }))
  }))
  let settled = false
  const done = tracker.settle("live bodies").then(() => { tracker.seal(); settled = true; order.push("close") })
  first.resolve()
  for (let index = 0; index < 8; index++) await Promise.resolve()
  expect(settled).toBe(false)
  expect(tracker.size).toBe(1)
  expect(() => tracker.seal()).toThrow("Browser operations still pending")
  later.resolve()
  await done
  expect(order).toEqual(["first", "later", "close"])
  expect(errors).toEqual([])
  expect(tracker.size).toBe(0)
})

test("browser operation settlement retains genuine failures and rejects late admissions", async () => {
  const errors: string[] = [], tracker = shellOperationTracker(message => errors.push(message))
  void tracker.track("live response", Promise.reject(new Error("Target page, context or browser has been closed")))
  await tracker.settle("failed live body")
  expect(errors).toEqual(["live response: Error: Target page, context or browser has been closed"])
  tracker.seal()
  expect(() => tracker.seal()).toThrow("Browser operation admission already sealed")
  await tracker.track("late request", Promise.resolve())
  expect(errors).toEqual(["live response: Error: Target page, context or browser has been closed", "Browser operation after settlement: late request"])
  expect(tracker.size).toBe(0)
})

test("browser operation settlement has one finite deadline while preserving pending ownership", async () => {
  const errors: string[] = [], tracker = shellOperationTracker(message => errors.push(message)), live = operationDeferred()
  void tracker.track("unfinished request", live.promise)
  await expect(tracker.settle("bounded live body", 10)).rejects.toThrow("bounded live body")
  expect(tracker.size).toBe(1)
  expect(() => tracker.seal()).toThrow("Browser operations still pending")
  live.resolve()
  await tracker.settle("collect live body")
  tracker.seal()
  expect(errors).toEqual([])
})

test("fixed-point browser collection preserves every finite admission tree regardless of sibling order", async () => {
  // Exhaust the bounded depth, branching and sibling-order domain. Every
  // completion admits its children after the original drain snapshot exists.
  for (let depth = 0; depth <= 5; depth++) for (let width = 1; width <= 3; width++) for (const reverse of [false, true]) {
    const errors: string[] = [], visited: string[] = [], tracker = shellOperationTracker(message => errors.push(message))
    const expected: string[] = []
    const plan = (id: string, remaining: number) => {
      expected.push(id)
      if (remaining > 0) for (let index = 0; index < width; index++) plan(`${id}.${index}`, remaining - 1)
    }
    const admit = (id: string, remaining: number) => {
      void tracker.track(id, Promise.resolve().then(() => {
        visited.push(id)
        if (remaining > 0) {
          const indices = Array.from({ length: width }, (_, index) => index)
          if (reverse) indices.reverse()
          for (const index of indices) admit(`${id}.${index}`, remaining - 1)
        }
      }))
    }
    plan("request", depth); admit("request", depth)
    await tracker.settle("finite admission tree")
    tracker.seal()
    expect(visited.toSorted()).toEqual(expected.toSorted())
    expect(new Set(visited).size).toBe(visited.length)
    expect(tracker.size).toBe(0)
    expect(errors).toEqual([])
  }
})

function fragmentFixture(rectangles = [[53.75, 523.734375, 194, 21], [20, 551.625, 49.078125, 21]], covered = -1) {
  const reads: number[][] = [], foreign = {} as Element, descendant = {} as Element
  let connected = true, focused = true, visible = true, nested = false
  const document = { get activeElement() { return focused ? element : foreign },
    elementFromPoint(x: number, y: number): Element | null {
      reads.push([x, y])
      const index = rectangles.findIndex(([left, top, width, height]) => x > left! && x < left! + width! && y > top! && y < top! + height!)
      return index < 0 || index === covered ? foreign : nested ? descendant : element
    } }
  const element = { ownerDocument: document, get isConnected() { return connected }, matches: () => visible,
    contains: (node: Element) => node === descendant,
    getClientRects: () => rectangles.map(([x, y, width, height]) => ({ x, y, width, height })),
  } as unknown as Element
  return { element, document, reads,
    set(kind: "detached" | "blurred" | "invisible" | "descendant") {
      if (kind === "detached") connected = false
      else if (kind === "blurred") focused = false
      else if (kind === "invisible") visible = false
      else nested = true
    } }
}

test("multiline native focus tests every actual fragment instead of the empty union gap", () => {
  const fixture = fragmentFixture()
  // Measured current and legacy 320px 404 geometry: this point hits the
  // paragraph between lines, while both real link fragments remain reachable.
  expect(fixture.document.elementFromPoint(133.875, 548.1796875)).not.toBe(fixture.element)
  const fragments = shellFocusFragments(fixture.element)
  expect(fragments.map(item => item.owned)).toEqual([true, true])
  expect(fixture.reads.slice(1)).toEqual([[150.75, 534.234375], [44.5390625, 562.125]])
  expect(() => assertShellFocusFragments(fragments, "recovery")).not.toThrow()
  fixture.set("descendant")
  expect(() => assertShellFocusFragments(shellFocusFragments(fixture.element), "nested icon")).not.toThrow()
})

test("one covered multiline fragment fails even when another fragment is hit-testable", () => {
  for (const covered of [0, 1]) {
    const fixture = fragmentFixture(undefined, covered)
    const fragments = shellFocusFragments(fixture.element)
    expect(fixture.reads).toHaveLength(2)
    expect(fragments.filter(item => item.owned)).toHaveLength(1)
    expect(() => assertShellFocusFragments(fragments, "recovery")).toThrow(`fragment ${covered}`)
  }
})

test("native fragment observation retains focus ownership and bounded finite geometry", () => {
  for (const kind of ["detached", "blurred", "invisible"] as const) {
    const fixture = fragmentFixture(); fixture.set(kind)
    expect(() => shellFocusFragments(fixture.element)).toThrow("lost focus or ownership")
    expect(fixture.reads).toHaveLength(0)
  }
  for (const rectangles of [[], [[0, 0, 0, 0]], [[0, 0, Infinity, 1]], [[0, NaN, 1, 1]], [[0, 0, -1, 1]],
    Array.from({ length: 129 }, () => [0, 0, 1, 1])]) {
    expect(() => shellFocusFragments(fragmentFixture(rectangles).element)).toThrow()
  }
  expect(() => assertShellFocusFragments([], "missing")).toThrow()
  expect(() => assertShellFocusFragments([{ rect: [0, 0, 0, 1], owned: true }], "empty")).toThrow()
})

test("partial shell failure records only the fully compared prefix and never accepts a pair", () => {
  const request = { token: "11111111-1111-4111-8111-111111111111" }
  const compared = siteShellCases.slice(0, 34).map(item => item.name), scenario = siteShellCases[34]!.name
  for (const stage of ["current", "baseline", "comparison"] as const) {
    const failure = shellCaseFailure(request, scenario, stage, compared, new Error("covered\nfragment"))
    expect(failure).toEqual({ schemaVersion: 1, token: request.token, accepted: false, completed: false,
      scenario, stage, comparedCases: compared, error: "Error: covered fragment" })
    expect(parseShellCaseFailure(JSON.parse(JSON.stringify(failure)), request)).toEqual(failure)
    expect(failure.comparedCases).not.toBe(compared)
    expect(() => parseShellPhase(failure, 2, request as ShellRequest)).toThrow()
  }
  const first = shellCaseFailure(request, siteShellCases[0]!.name, "current", [], "x".repeat(4_096))
  expect(first.error).toHaveLength(2_048); expect(first.comparedCases).toEqual([])
  for (const patch of [{ accepted: true }, { completed: true }, { stage: "result" }, { stage: ["current"] }, { token: "wrong" },
    { scenario: siteShellCases[1]!.name }, { comparedCases: [siteShellCases[0]!.name] },
    { comparedCases: siteShellCases.map(item => item.name) }, { error: "\n" }, { error: "" }, { extra: true }]) {
    expect(() => parseShellCaseFailure({ ...first, ...patch }, request)).toThrow()
  }
  expect(() => shellCaseFailure(request, scenario, "baseline", [...compared].reverse(), "wrong prefix")).toThrow()
})

test("skip reveal diagnostics never turn a failed settled frame into acceptance", async () => {
  let reads = 0
  const diagnostic = async () => { reads += 1; return { afterTwoFrames: { rect: [12, 12, 100, 48], focused: true } } }
  await assertShellSkipReveal([12, 12, 100, 48], "current initial", diagnostic)
  expect(reads).toBe(0)
  for (const rect of [[-1, 12, 100, 48], [12, -1, 100, 48], [12, 12, 0, 48]]) {
    await expect(assertShellSkipReveal(rect, "current reload", diagnostic)).rejects.toThrow("current reload: focused skip link is clipped")
  }
  expect(reads).toBe(3)
})

interface SkipAnimation {
  readonly playState?: AnimationPlayState
  readonly pending?: boolean
  readonly playbackRate?: number
  readonly endTime?: number
  readonly duration?: number
  readonly iterations?: number
  readonly owned?: boolean
}
interface SkipSample {
  readonly rect: readonly number[]
  readonly scrollY: number
  readonly focused: boolean
  readonly focus: boolean
  readonly focusVisible: boolean
  readonly connected: boolean
  readonly animations: readonly SkipAnimation[]
  readonly styles: Readonly<Record<string, string>>
}
const focusPaint = { transform: "matrix(1, 0, 0, 1, 0, 0)", "outline-style": "none", "outline-width": "0px",
  "outline-color": "rgb(23, 22, 18)", "outline-offset": "3px" }
const appearancePaint = { ...focusPaint, "background-color": "color(srgb 0.147137 0.117961 0.0821961)" }
function appearancePaintFixture() {
  let now = 0, sequence = 0, readCost = 0, scrollY = 0, observerCallback: MutationCallback | undefined
  const frames = new Map<number, () => void>(), timers = new Map<number, { at: number; callback: () => void }>()
  const events = new Set<() => void>(), observed = new Set<Node>(), records: MutationRecord[] = [], reads: string[] = []
  const selectorOwners = new Map<string, Element[]>(), states = Array.from({ length: 14 }, (_, index) => ({
    rect: [0, 0, 182, 40], styles: appearancePaint as Readonly<Record<string, string>>, animations: [] as SkipAnimation[],
    connected: true, focus: index === 4, focusVisible: index === 4, attributes: new Map<string, string>(),
  }))
  let activeElement: Element, observer: MutationObserver
  const document = { documentElement: undefined as unknown as Element, get activeElement() { return activeElement },
    querySelectorAll: (selector: string) => selectorOwners.get(selector) ?? [], defaultView: {
      performance: { now: () => now }, get scrollY() { return scrollY },
      requestAnimationFrame: (callback: () => void) => { frames.set(++sequence, callback); return sequence },
      cancelAnimationFrame: (id: number) => { frames.delete(id) },
      setTimeout: (callback: () => void, delay: number) => { timers.set(++sequence, { at: now + delay, callback }); return sequence },
      clearTimeout: (id: number) => { timers.delete(id) },
      getComputedStyle: (owner: Element) => {
        const index = owners.indexOf(owner); reads.push(`${index}:style`)
        return { getPropertyValue: (property: string) => states[index]!.styles[property] ?? "" }
      },
      MutationObserver: class {
        constructor(callback: MutationCallback) { observerCallback = callback; observer = this as unknown as MutationObserver }
        observe(owner: Node) { observed.add(owner) }
        takeRecords() { return records.splice(0) }
        disconnect() { observed.clear(); records.length = 0 }
      },
    } }
  const owners = states.map((state, index) => {
    const owner = { ownerDocument: document, get isConnected() { return state.connected },
      getAttribute: (attribute: string) => state.attributes.get(attribute) ?? null,
      hasAttribute: (attribute: string) => state.attributes.has(attribute),
      matches: (selector: string) => selector === ":focus" ? state.focus : state.focusVisible,
      addEventListener: (_type: string, callback: () => void) => { events.add(callback) },
      removeEventListener: (_type: string, callback: () => void) => { events.delete(callback) },
      getBoundingClientRect: () => { reads.push(`${index}:rect`); now += readCost
        return { x: state.rect[0], y: state.rect[1], width: state.rect[2], height: state.rect[3] } },
      getAnimations: () => { reads.push(`${index}:animations`); return state.animations.map(animation => ({
        playState: animation.playState ?? "running", pending: animation.pending ?? false, playbackRate: animation.playbackRate ?? 1,
        effect: { target: animation.owned === false ? {} : owner, getComputedTiming: () => ({
          endTime: animation.endTime ?? 0.01, duration: animation.duration ?? 0.01, iterations: animation.iterations ?? 1,
        }) },
      })) },
    } as unknown as Element
    return owner
  })
  const base = "[data-hraness-appearance-menu]", items = `${base} [role="menuitemradio"]`
  const selectors = [base, `${base} button`, `${base} .hraness-design-theme-toggle__popover`, `${base} [role="menu"]`,
    items, `${items} .hraness-appearance-icon`, `${items} .hraness-appearance-icon svg`]
  let offset = 0
  for (const [index, selector] of selectors.entries()) { const size = index < 4 ? 1 : 3
    selectorOwners.set(selector, owners.slice(offset, offset + size)); offset += size }
  states[0]!.attributes.set("data-theme-value", "dark"); states[0]!.attributes.set("data-ready", "true")
  states[1]!.attributes.set("aria-expanded", "true")
  for (const [index, value] of ["light", "dark", "system"].entries()) states[4 + index]!.attributes.set("data-theme-value", value)
  states[13]!.attributes.set("data-theme", "dark")
  document.documentElement = owners[13]!; activeElement = owners[4]!
  return {
    start(label = "current /-320-dark-light arrow-down-opens-first", properties = Object.keys(appearancePaint)) {
      const result = settleShellAppearancePaint(owners[0]!, { label, active: "light", preference: "dark", properties })
      void result.catch(() => {}); return result
    },
    state(index: number, patch: Partial<(typeof states)[number]>) { Object.assign(states[index]!, patch) },
    frame(at = now + 16) { now = at; const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback() },
    advance(at: number) { now = at; for (const [id, timer] of [...timers]) if (timer.at <= at) { timers.delete(id); timer.callback() } },
    attribute(index: number, name: string, value: string | null) {
      const state = states[index]!
      if (observed.size > 0) records.push({ type: "attributes", target: owners[index]!, attributeName: name,
        oldValue: state.attributes.get(name) ?? null } as unknown as MutationRecord)
      if (value === null) state.attributes.delete(name); else state.attributes.set(name, value)
    },
    mutateTree() { records.push({ type: "childList", target: owners[0]! } as unknown as MutationRecord) },
    deliverMutations() { if (observed.size > 0) observerCallback!(records.splice(0), observer) },
    changeOwner() { selectorOwners.set(items, [owners[4]!, owners[5]!]) },
    blurAndRegain() { for (const callback of [...events]) callback() },
    setReadCost(cost: number) { readCost = cost }, setScroll(value: number) { scrollY = value },
    get reads() { return reads }, get pending() { return [frames.size, timers.size, observed.size, events.size] },
  }
}

test("appearance observes all exact landmark styles before animations and requires two stable RAFs", async () => {
  for (const source of ["current", "baseline"]) {
    const fixture = appearancePaintFixture(), result = fixture.start(`${source} arrow-down-opens-first`)
    expect(fixture.reads).toEqual(Array.from({ length: 13 }, (_, index) => [`${index}:rect`, `${index}:style`, `${index}:animations`]).flat())
    fixture.frame(); expect(fixture.pending).toEqual([1, 1, 2, 1]); fixture.frame()
    expect((await result).elements).toHaveLength(13)
    expect(fixture.pending).toEqual([0, 0, 0, 0])
  }
})

test("appearance waits for native focus transitions and stable real paint without polling expected colors", async () => {
  const fixture = appearancePaintFixture()
  const before = { ...appearancePaint, "background-color": "oklab(0 0 0 / 0)", "outline-width": "3px", "outline-offset": "0px" }
  fixture.state(4, { styles: before, animations: [{}] }); fixture.state(1, { animations: [{}] })
  const result = fixture.start(); fixture.frame()
  fixture.state(4, { styles: appearancePaint, animations: [] }); fixture.frame()
  expect(fixture.pending).toEqual([1, 1, 2, 1])
  fixture.state(1, { animations: [{ playState: "finished", pending: true }] }); fixture.frame()
  fixture.state(1, { animations: [] }); fixture.frame()
  fixture.state(12, { rect: [1, 0, 182, 40] }); fixture.frame(); fixture.setScroll(1); fixture.frame()
  expect(fixture.pending).toEqual([1, 1, 2, 1]); fixture.frame()
  expect((await result).elements[4]!.styles).toEqual(appearancePaint)
  expect(fixture.pending).toEqual([0, 0, 0, 0])
  const wrong = appearancePaintFixture(); wrong.state(4, { styles: before })
  const bad = wrong.start(); wrong.frame(); wrong.frame()
  const evidence = await bad, item = evidence.elements[4]!
  const actual: ShellElement = { ...item, text: "Light", semantics: {} }
  expect(() => compareShellElements([actual], [{ ...actual, styles: appearancePaint }], "unchanged parity")).toThrow("paired element differences")
  expect(wrong.pending).toEqual([0, 0, 0, 0])
})

test("appearance refuses sticky focus loss, changed semantics and transient owner or preference changes", async () => {
  for (const kind of ["blur", "focus", "visible", "detached", "owner", "closed", "preference", "theme", "tree"] as const) {
    const fixture = appearancePaintFixture(), result = fixture.start(); fixture.frame()
    if (kind === "blur") fixture.blurAndRegain()
    else if (kind === "focus") fixture.state(4, { focus: false })
    else if (kind === "visible") fixture.state(4, { focusVisible: false })
    else if (kind === "detached") fixture.state(12, { connected: false })
    else if (kind === "owner") fixture.changeOwner()
    else if (kind === "tree") fixture.mutateTree()
    else if (kind === "closed") { fixture.attribute(1, "aria-expanded", "false"); fixture.attribute(1, "aria-expanded", "true") }
    else if (kind === "preference") { fixture.attribute(0, "data-theme-value", "light"); fixture.attribute(0, "data-theme-value", "dark") }
    else { fixture.attribute(13, "data-theme", "light"); fixture.attribute(13, "data-theme", "dark") }
    fixture.frame(); await expect(result).rejects.toThrow("appearance")
    expect(fixture.pending).toEqual([0, 0, 0, 0])
  }
  const fixture = appearancePaintFixture(), result = fixture.start()
  fixture.attribute(1, "aria-expanded", "true"); fixture.deliverMutations(); fixture.frame(); fixture.frame()
  expect((await result).elements).toHaveLength(13)
})

test("appearance retains bounded exact animation ownership and finite native paint", async () => {
  for (const animation of [{ playState: "paused" as const }, { endTime: Infinity }, { duration: Infinity }, { iterations: Infinity },
    { playbackRate: 0 }, { playbackRate: NaN }, { owned: false }]) {
    const fixture = appearancePaintFixture(); fixture.state(4, { animations: [animation] })
    await expect(fixture.start()).rejects.toThrow(/animation.*(?:finite and unpaused|exact element owner)/u)
    expect(fixture.pending).toEqual([0, 0, 0, 0])
  }
  for (const patch of [{ rect: [NaN, 0, 182, 40] }, { styles: { ...appearancePaint, "background-color": "x".repeat(4_097) } },
    { animations: Array.from({ length: 65 }, () => ({})) }]) {
    const fixture = appearancePaintFixture(); fixture.state(4, patch)
    await expect(fixture.start()).rejects.toThrow("appearance")
    expect(fixture.pending).toEqual([0, 0, 0, 0])
  }
  const incomplete = appearancePaintFixture()
  await expect(incomplete.start("current", ["outline-style"])).rejects.toThrow("paint inventory")
  expect(incomplete.pending).toEqual([0, 0, 0, 0])
})

test("appearance stability is invariant across every landmark owner and arbitrary finite final paint", async () => {
  for (let owner = 0; owner < 13; owner++) {
    const fixture = appearancePaintFixture(), finalPaint = { ...appearancePaint, "background-color": `rgb(${owner * 17},${255 - owner * 13},29)` }
    fixture.state(owner, { animations: [{}] })
    const result = fixture.start(); fixture.frame()
    fixture.state(owner, { animations: [], styles: finalPaint }); fixture.frame()
    expect(fixture.pending).toEqual([1, 1, 2, 1]); fixture.frame()
    expect((await result).elements[owner]!.styles).toEqual(finalPaint)
    expect(fixture.pending).toEqual([0, 0, 0, 0])
  }
})

test("appearance rejects missing frames, moving paint and deadline races without renewing the deadline", async () => {
  for (const kind of ["missing", "animation", "paint"] as const) {
    const fixture = appearancePaintFixture()
    if (kind === "animation") fixture.state(4, { animations: [{}] })
    const result = fixture.start()
    if (kind !== "missing") for (let at = 16; at < 1_000; at += 16) {
      if (kind === "paint") fixture.state(4, { styles: { ...appearancePaint, "background-color": `rgb(${at},0,0)` } })
      fixture.frame(at)
    }
    fixture.advance(1_000); await expect(result).rejects.toThrow("1000ms local deadline")
    expect(fixture.pending).toEqual([0, 0, 0, 0])
  }
  for (const at of [1_000, 1_001, NaN, -1]) {
    const fixture = appearancePaintFixture(), result = fixture.start(); fixture.frame(16); fixture.frame(at)
    await expect(result).rejects.toThrow("1000ms local deadline")
    expect(fixture.pending).toEqual([0, 0, 0, 0])
  }
  const fixture = appearancePaintFixture(), result = fixture.start(); fixture.frame(); fixture.setReadCost(100); fixture.frame()
  await expect(result).rejects.toThrow("1000ms local deadline")
  expect(fixture.pending).toEqual([0, 0, 0, 0])
})
// Exercise the exact serialized page function with a deterministic native-API
// surface, without global replacements, a browser, wall-clock sleeps or CSS.
function skipFixture(initial: Partial<SkipSample> = {}, mainInitial: Partial<SkipSample> = {}) {
  let sample: SkipSample = { rect: [12, 12, 100, 48], scrollY: 0, focused: true, focus: true,
    focusVisible: true, connected: true, animations: [], styles: focusPaint, ...initial }
  let mainSample: SkipSample = { ...sample, rect: [0, 100, 320, 900], focused: false, focus: false,
    focusVisible: false, ...mainInitial }
  let now = 0, sequence = 0, reads = 0, readCost = 0
  const frames = new Map<number, () => void>(), timers = new Map<number, { at: number; callback: () => void }>()
  const listeners = new Map<Element, Map<string, Set<() => void>>>()
  let element: Element, main: Element
  const selected = new Map<string, Element[]>()
  const document = { get activeElement() { return sample.focused ? element : mainSample.focused ? main : null },
    querySelectorAll: (selector: string) => selected.get(selector) ?? [],
    querySelector: (selector: string) => selected.get(selector)?.[0] ?? null, defaultView: {
    performance: { now: () => now }, get scrollY() { return sample.scrollY },
    getComputedStyle: (owner: Element) => ({ getPropertyValue: (property: string) => (owner === element ? sample : mainSample).styles[property] ?? "" }),
    requestAnimationFrame: (callback: () => void) => { frames.set(++sequence, callback); return sequence },
    cancelAnimationFrame: (id: number) => { frames.delete(id) },
    setTimeout: (callback: () => void, delay: number) => { timers.set(++sequence, { at: now + delay, callback }); return sequence },
    clearTimeout: (id: number) => { timers.delete(id) },
  } }
  const makeOwner = (state: () => SkipSample) => {
    const events = new Map<string, Set<() => void>>()
    const owner = {
      ownerDocument: document, get isConnected() { return state().connected },
      matches: (selector: string) => selector === ":focus" ? state().focus : state().focusVisible,
      getBoundingClientRect: () => {
        reads++; now += readCost
        const rect = state().rect
        return { x: rect[0], y: rect[1], width: rect[2], height: rect[3] }
      },
      getAnimations: () => state().animations.map(animation => ({
        playState: animation.playState ?? "running", pending: animation.pending ?? false, playbackRate: animation.playbackRate ?? 1,
        effect: { target: animation.owned === false ? {} : owner, getComputedTiming: () => ({
          endTime: animation.endTime ?? 0.01, duration: animation.duration ?? 0.01, iterations: animation.iterations ?? 1,
        }) },
      })),
      addEventListener: (type: string, callback: () => void) => { const set = events.get(type) ?? new Set(); set.add(callback); events.set(type, set) },
      removeEventListener: (type: string, callback: () => void) => { events.get(type)?.delete(callback) },
    } as unknown as Element
    listeners.set(owner, events)
    return owner
  }
  element = makeOwner(() => sample); main = makeOwner(() => mainSample)
  selected.set(".skip-link", [element]); selected.set("#main", [main])
  const startState = (focus: "skip" | "main", label = "current initial", properties = Object.keys(focusPaint)) => {
    const result = settleShellFocusState(focus === "skip" ? element : main, { label, focus, properties })
    void result.catch(() => {})
    return result
  }
  const frame = (patch: Partial<SkipSample> = {}, at = now + 16, mainPatch: Partial<SkipSample> = {}) => {
    sample = { ...sample, ...patch }; mainSample = { ...mainSample, ...mainPatch }; now = at
    const callbacks = [...frames.values()]; frames.clear()
    for (const callback of callbacks) callback()
  }
  const dispatch = (owner: Element, type: string) => { for (const callback of [...listeners.get(owner)?.get(type) ?? []]) callback() }
  return {
    startState,
    start(label = "current initial") {
      const result = startState("skip", label).then(value => ({ rect: value.elements[0]!.rect, scrollY: value.scrollY }))
      void result.catch(() => {})
      return result
    },
    frame,
    mainFrame(mainPatch: Partial<SkipSample> = {}, patch: Partial<SkipSample> = {}, at = now + 16) { frame(patch, at, mainPatch) },
    advance(at: number) {
      now = at
      for (const [id, timer] of [...timers]) if (timer.at <= at) { timers.delete(id); timer.callback() }
    },
    blurAndRegain() { dispatch(element, "blur") },
    mainBlurAndRegain() { dispatch(main, "blur") },
    skipFocusAndLose() { dispatch(element, "focus") },
    changeOwner(selector: ".skip-link" | "#main", change: "missing" | "duplicate" | "replaced") {
      const owner = selector === ".skip-link" ? element : main
      selected.set(selector, change === "missing" ? [] : change === "duplicate" ? [owner, owner] : [makeOwner(() => sample)])
    },
    setReadCost(milliseconds: number) { readCost = milliseconds },
    get reads() { return reads },
    get pending() { return [frames.size, timers.size, [...listeners.values()].flatMap(events => [...events.values()]).reduce((total, set) => total + set.size, 0)] },
  }
}

interface SystemPaintOwner {
  readonly rect: readonly number[]
  readonly styles: Readonly<Record<string, string>>
  readonly animations: readonly SkipAnimation[]
  readonly connected: boolean
}
interface SystemPaintSample {
  readonly dark: boolean
  readonly preference: string | null
  readonly resolved: string | null
  readonly html: SystemPaintOwner
  readonly body: SystemPaintOwner
}
function systemPaintFixture(system: "light" | "dark" = "light", initial: Partial<SystemPaintSample> = {}) {
  const styles = { color: "rgb(23, 22, 18)", "background-color": "rgb(250, 248, 243)", "color-scheme": system,
    "--paper": "#faf8f3", "--ink": "#171612", "--ui-background": "#faf8f3", "--ui-foreground": "#171612" }
  const defaultOwner = { rect: [0, 0, 320, 900], styles, animations: [], connected: true }
  let sample: SystemPaintSample = { dark: system === "dark", preference: "system", resolved: system,
    html: defaultOwner, body: defaultOwner, ...initial }
  let now = 0, sequence = 0, readCost = 0, observerCallback: MutationCallback | undefined
  const frames = new Map<number, () => void>(), timers = new Map<number, { at: number; callback: () => void }>()
  const mediaListeners = new Set<(event: MediaQueryListEvent) => void>(), observed = new Set<Node>(), records: MutationRecord[] = []
  const reads: string[] = [], selected = new Map<string, Element[]>()
  let html: Element, body: Element, menu: Element, observer: MutationObserver
  const media = { get matches() { return sample.dark },
    addEventListener: (_type: string, callback: (event: MediaQueryListEvent) => void) => { mediaListeners.add(callback) },
    removeEventListener: (_type: string, callback: (event: MediaQueryListEvent) => void) => { mediaListeners.delete(callback) } }
  const document = { get documentElement() { return html }, get body() { return body },
    querySelectorAll: (selector: string) => selected.get(selector) ?? [],
    querySelector: (selector: string) => selected.get(selector)?.[0] ?? null, defaultView: {
      performance: { now: () => now },
      matchMedia: (query: string) => { expect(query).toBe("(prefers-color-scheme: dark)"); return media },
      getComputedStyle: (owner: Element) => {
        reads.push(owner === html ? "html:style" : "body:style")
        return { getPropertyValue: (property: string) => (owner === html ? sample.html : sample.body).styles[property] ?? "" }
      },
      requestAnimationFrame: (callback: () => void) => { frames.set(++sequence, callback); return sequence },
      cancelAnimationFrame: (id: number) => { frames.delete(id) },
      setTimeout: (callback: () => void, delay: number) => { timers.set(++sequence, { at: now + delay, callback }); return sequence },
      clearTimeout: (id: number) => { timers.delete(id) },
      MutationObserver: class {
        constructor(callback: MutationCallback) { observerCallback = callback; observer = this as unknown as MutationObserver }
        observe(owner: Node, options: MutationObserverInit) {
          expect(options).toEqual({ attributes: true, attributeFilter: [owner === html ? "data-theme" : "data-theme-value"], attributeOldValue: true })
          observed.add(owner)
        }
        takeRecords() { return records.splice(0) }
        disconnect() { observed.clear(); records.length = 0 }
      },
    } }
  const makeOwner = (key: "html" | "body") => {
    const owner = { ownerDocument: document, get isConnected() { return sample[key].connected },
      getAttribute: () => sample.resolved,
      getBoundingClientRect: () => { reads.push(`${key}:rect`); now += readCost
        const rect = sample[key].rect; return { x: rect[0], y: rect[1], width: rect[2], height: rect[3] } },
      getAnimations: () => { reads.push(`${key}:animations`); return sample[key].animations.map(animation => ({
        playState: animation.playState ?? "running", pending: animation.pending ?? false, playbackRate: animation.playbackRate ?? 1,
        effect: { target: animation.owned === false ? {} : owner, getComputedTiming: () => ({
          endTime: animation.endTime ?? 0.01, duration: animation.duration ?? 0.01, iterations: animation.iterations ?? 1,
        }) },
      })) },
    } as unknown as Element
    return owner
  }
  html = makeOwner("html"); body = makeOwner("body")
  menu = { ownerDocument: document, isConnected: true, getAttribute: () => sample.preference } as unknown as Element
  selected.set("[data-hraness-appearance-menu]", [menu])
  return {
    start(label = "current /-320-system-light System alternate dark") {
      const result = settleShellSystemPaint(html, { label, system }); void result.catch(() => {}); return result
    },
    patch(patch: Partial<SystemPaintSample>) { sample = { ...sample, ...patch } },
    owner(key: "html" | "body", patch: Partial<SystemPaintOwner>) { sample = { ...sample, [key]: { ...sample[key], ...patch } } },
    frame(at = now + 16) { now = at; const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback() },
    advance(at: number) { now = at; for (const [id, timer] of [...timers]) if (timer.at <= at) { timers.delete(id); timer.callback() } },
    attribute(key: "resolved" | "preference", value: string | null) {
      const target = key === "resolved" ? html : menu
      if (observed.has(target)) records.push({ target, oldValue: sample[key] } as unknown as MutationRecord)
      sample = { ...sample, [key]: value }
    },
    deliverMutations() { if (observed.size > 0) observerCallback!(records.splice(0), observer) },
    mediaEvent(matches: boolean) { for (const callback of [...mediaListeners]) callback({ matches } as MediaQueryListEvent) },
    changeMenu() { selected.set("[data-hraness-appearance-menu]", []) },
    setReadCost(cost: number) { readCost = cost },
    get reads() { return reads },
    get styles() { return styles },
    get pending() { return [frames.size, timers.size, observed.size, mediaListeners.size] },
  }
}

test("System paint samples native HTML/body style before animations and requires two stable RAFs for both sources", async () => {
  for (const source of ["current", "baseline"] as const) for (const system of ["light", "dark"] as const) {
    const fixture = systemPaintFixture(system), result = fixture.start(`${source} /-320-system-${system} System restored ${system}`)
    expect(fixture.reads).toEqual(["html:rect", "html:style", "html:animations", "body:rect", "body:style", "body:animations"])
    fixture.attribute("resolved", system); fixture.attribute("preference", "system"); fixture.deliverMutations()
    fixture.mediaEvent(system === "dark")
    fixture.frame()
    expect(fixture.pending).toEqual([1, 1, 2, 1])
    fixture.frame()
    expect((await result).elements.map(owner => owner.key)).toEqual(["html", "body"])
    expect(fixture.pending).toEqual([0, 0, 0, 0])
  }
})

test("System paint waits for each finite owner animation and stable actual paint/geometry without palette polling", async () => {
  const fixture = systemPaintFixture()
  fixture.owner("html", { animations: [{}] }); fixture.owner("body", { animations: [{}] })
  const result = fixture.start()
  fixture.frame(); fixture.owner("html", { animations: [{ playState: "finished" }] }); fixture.frame()
  expect(fixture.pending).toEqual([1, 1, 2, 1])
  fixture.owner("body", { animations: [{ playState: "finished" }] }); fixture.frame()
  fixture.owner("body", { styles: { ...fixture.styles, color: "rgb(101, 102, 103)" } }); fixture.frame()
  fixture.owner("html", { rect: [0, 0, 321, 900] }); fixture.frame()
  expect(fixture.pending).toEqual([1, 1, 2, 1])
  fixture.frame()
  expect((await result).bodyColor).toBe("rgb(101, 102, 103)")
  expect(fixture.pending).toEqual([0, 0, 0, 0])
})

test("stable wrong System paint remains red at the original inequality, with bounded scenario/source/phase diagnostics", async () => {
  const alternate = systemPaintFixture("dark"), restored = systemPaintFixture("light")
  const first = alternate.start(), second = restored.start()
  for (const fixture of [alternate, restored]) { fixture.frame(); fixture.frame() }
  const changed = await first, reset = await second
  expect(changed.bodyColor).toBe(reset.bodyColor)
  expect(() => assertShellSystemPaintChanged(changed, reset, "current /-320-system-light System alternate/restored"))
    .toThrow("current /-320-system-light System alternate/restored: System appearance did not follow the native media setting")
  expect(() => assertShellSystemPaintChanged(changed, { ...reset, bodyColor: "rgb(244, 241, 232)" }, "baseline System alternate/restored")).not.toThrow()
  const bad = systemPaintFixture("light", { dark: true })
  const error = await bad.start("x".repeat(500)).catch(value => value as Error)
  expect(String(error)).toContain("media, preference or resolved appearance changed")
  expect(String(error).length).toBeLessThan(4_500)
  expect(bad.pending).toEqual([0, 0, 0, 0])
})

test("System paint rejects paused, infinite, invalid-rate and foreign-owner animations on either exact owner", async () => {
  for (const key of ["html", "body"] as const) for (const animation of [
    { playState: "paused" }, { endTime: Infinity }, { duration: Infinity }, { iterations: Infinity },
    { endTime: -1 }, { duration: -1 }, { iterations: -1 }, { playbackRate: 0 }, { playbackRate: NaN }, { owned: false },
  ] satisfies SkipAnimation[]) {
    const fixture = systemPaintFixture(); fixture.owner(key, { animations: [animation] })
    await expect(fixture.start("baseline /404.html-390-system-light System restored light")).rejects.toThrow(
      animation.owned === false ? "no exact element owner" : "finite and unpaused")
    expect(fixture.pending).toEqual([0, 0, 0, 0])
  }
  for (const animation of [{ playState: "paused" }, { endTime: Infinity }] satisfies SkipAnimation[]) {
    const fixture = systemPaintFixture(), result = fixture.start(); fixture.frame()
    fixture.owner("body", { animations: [animation] }); fixture.frame()
    await expect(result).rejects.toThrow("finite and unpaused")
    expect(fixture.pending).toEqual([0, 0, 0, 0])
  }
})

test("System paint rejects semantic loss immediately, during RAF and between samples even after regain", async () => {
  for (const patch of [{ dark: true }, { preference: "dark" }, { resolved: "dark" }]) {
    const immediate = systemPaintFixture("light", patch)
    await expect(immediate.start()).rejects.toThrow("media, preference or resolved appearance changed")
    expect(immediate.pending).toEqual([0, 0, 0, 0])
    const later = systemPaintFixture(), result = later.start(); later.frame(); later.patch(patch); later.frame()
    await expect(result).rejects.toThrow("media, preference or resolved appearance changed")
    expect(later.pending).toEqual([0, 0, 0, 0])
  }
  for (const attribute of ["resolved", "preference"] as const) for (const deliver of [true, false]) {
    const fixture = systemPaintFixture(), result = fixture.start(); fixture.frame()
    fixture.attribute(attribute, "dark"); fixture.attribute(attribute, attribute === "resolved" ? "light" : "system")
    if (deliver) fixture.deliverMutations()
    fixture.frame(); fixture.frame()
    await expect(result).rejects.toThrow("appearance changed between native samples")
    expect(fixture.pending).toEqual([0, 0, 0, 0])
  }
  const media = systemPaintFixture(), result = media.start(); media.frame(); media.mediaEvent(true); media.mediaEvent(false); media.frame()
  await expect(result).rejects.toThrow("media changed between native samples")
  expect(media.pending).toEqual([0, 0, 0, 0])
})

test("System paint refuses nonsettling paint, geometry or animation, missing RAF and late synchronous samples", async () => {
  const timely = systemPaintFixture(), timelyResult = timely.start(); timely.frame(998); timely.frame(999)
  expect((await timelyResult).bodyColor).toBe("rgb(23, 22, 18)")
  expect(timely.pending).toEqual([0, 0, 0, 0])
  for (const kind of ["paint", "geometry", "animation", "pending", "missing"] as const) {
    const fixture = systemPaintFixture()
    if (kind === "animation") fixture.owner("body", { animations: [{}] })
    if (kind === "pending") fixture.owner("body", { animations: [{ playState: "finished", pending: true }] })
    const result = fixture.start()
    if (kind !== "missing") for (let at = 16; at < 1_000; at += 16) {
      if (kind === "paint") fixture.owner("body", { styles: { ...fixture.styles, color: `rgb(${at}, 0, 0)` } })
      if (kind === "geometry") fixture.owner("html", { rect: [0, 0, at, 900] })
      fixture.frame(at)
    }
    fixture.advance(1_000)
    await expect(result).rejects.toThrow("1000ms local deadline")
    expect(fixture.pending).toEqual([0, 0, 0, 0])
  }
  for (const at of [1_000, 1_001, NaN, -1]) {
    const fixture = systemPaintFixture(), result = fixture.start(); fixture.frame(16); fixture.frame(at)
    await expect(result).rejects.toThrow("1000ms local deadline")
    expect(fixture.pending).toEqual([0, 0, 0, 0])
  }
  const slow = systemPaintFixture(), result = slow.start(); slow.frame(16); slow.setReadCost(500); slow.frame(32)
  await expect(result).rejects.toThrow("1000ms local deadline")
  expect(slow.pending).toEqual([0, 0, 0, 0])
})

test("System paint retains exact owner, finite geometry and bounded native inventories", async () => {
  for (const change of ["menu", "html", "body", "geometry", "paint", "animations"] as const) {
    const fixture = systemPaintFixture(), result = fixture.start(); fixture.frame()
    if (change === "menu") fixture.changeMenu()
    else if (change === "html" || change === "body") fixture.owner(change, { connected: false })
    else if (change === "geometry") fixture.owner("body", { rect: [NaN, 0, 320, 900] })
    else if (change === "paint") fixture.owner("body", { styles: { ...fixture.styles, color: "x".repeat(257) } })
    else fixture.owner("body", { animations: Array.from({ length: 65 }, () => ({})) })
    fixture.frame()
    await expect(result).rejects.toThrow("System paint")
    expect(fixture.pending).toEqual([0, 0, 0, 0])
  }
})

test("skip settlement requires two native RAF samples even without an animation", async () => {
  const fixture = skipFixture(), result = fixture.start("baseline reload")
  expect(fixture.reads).toBe(1) // Immediate native focus/style check.
  expect(fixture.pending).toEqual([1, 1, 1])
  fixture.frame()
  expect(fixture.pending).toEqual([1, 1, 1])
  fixture.frame()
  expect(await result).toEqual({ rect: [12, 12, 100, 48], scrollY: 0 })
  expect(fixture.reads).toBe(3)
  expect(fixture.pending).toEqual([0, 0, 0])
})

test("skip settlement waits for finite native transitions, then stable geometry without visibility polling", async () => {
  const fixture = skipFixture({ rect: [12, -73, 100, 48], animations: [{}] }), result = fixture.start()
  fixture.frame({ rect: [12, -20, 100, 48] })
  fixture.frame({ rect: [12, 12, 100, 48], animations: [] })
  expect(fixture.pending).toEqual([1, 1, 1])
  fixture.frame()
  expect(await result).toEqual({ rect: [12, 12, 100, 48], scrollY: 0 })
  expect(fixture.pending).toEqual([0, 0, 0])
})

test("skip settlement rejects stable clipping once and later valid geometry cannot heal it", async () => {
  for (const rect of [[-1, 12, 100, 48], [12, -1, 100, 48], [12, 12, 0, 48]]) {
    const fixture = skipFixture({ rect }), result = fixture.start()
    fixture.frame(); fixture.frame()
    const settled = await result
    expect(settled.rect).toEqual(rect)
    expect(fixture.reads).toBe(3)
    let assertions = 0, diagnostics = 0
    const verify = async () => {
      assertions++
      await assertShellSkipReveal(settled.rect, "current initial", async () => {
        diagnostics++
        fixture.frame({ rect: [12, 12, 100, 48] })
        return { later: [12, 12, 100, 48] }
      })
    }
    await expect(verify()).rejects.toThrow("current initial: focused skip link is clipped")
    expect([assertions, diagnostics]).toEqual([1, 1])
    expect(fixture.pending).toEqual([0, 0, 0])
  }
})

test("skip settlement rejects immediate and later native focus or focus-visible loss", async () => {
  for (const patch of [{ focused: false }, { focus: false }, { focusVisible: false }, { connected: false }]) {
    const immediate = skipFixture(patch)
    const error = "connected" in patch ? "native focus owners changed" : "skip requires continuous native focus and focus-visible"
    await expect(immediate.start()).rejects.toThrow(error)
    expect(immediate.reads).toBe(0)
    expect(immediate.pending).toEqual([0, 0, 0])
    const later = skipFixture(), result = later.start("baseline reload")
    later.frame(patch)
    await expect(result).rejects.toThrow(`baseline reload: ${error}`)
    expect(later.pending).toEqual([0, 0, 0])
  }
  const regained = skipFixture(), result = regained.start()
  regained.blurAndRegain()
  regained.frame(); regained.frame()
  await expect(result).rejects.toThrow("lost native focus during settlement")
  expect(regained.pending).toEqual([0, 0, 0])
})

test("skip settlement rejects paused, infinite, stopped-rate and foreign-owned native animations", async () => {
  for (const animation of [{ playState: "paused" as const }, { endTime: Infinity }, { duration: Infinity },
    { iterations: Infinity }, { playbackRate: 0 }, { playbackRate: NaN }, { duration: NaN }, { owned: false }]) {
    const fixture = skipFixture({ animations: [animation] })
    await expect(fixture.start()).rejects.toThrow(/animation.*(?:finite and unpaused|exact element owner)/u)
    expect(fixture.pending).toEqual([0, 0, 0])
    const late = skipFixture(), result = late.start()
    late.frame({ animations: [animation] })
    await expect(result).rejects.toThrow(/animation.*(?:finite and unpaused|exact element owner)/u)
    expect(late.pending).toEqual([0, 0, 0])
  }
})

test("skip settlement waits for pending animations and restarts stability when geometry or scroll changes", async () => {
  const fixture = skipFixture({ animations: [{ playState: "finished", pending: true }] }), result = fixture.start()
  fixture.frame()
  fixture.frame({ animations: [{ playState: "finished" }] })
  fixture.frame({ rect: [13, 12, 100, 48] })
  fixture.frame({ scrollY: 10 })
  expect(fixture.pending).toEqual([1, 1, 1])
  fixture.frame()
  expect(await result).toEqual({ rect: [13, 12, 100, 48], scrollY: 10 })
  expect(fixture.pending).toEqual([0, 0, 0])
})

test("skip settlement rejects nonsettling animation or geometry, missing RAF and deadline-boundary frames", async () => {
  const moving = skipFixture(), movingResult = moving.start()
  const running = skipFixture({ animations: [{}] }), runningResult = running.start()
  for (let at = 16; at < 1_000; at += 16) {
    moving.frame({ rect: [at, 12, 100, 48] }, at)
    running.frame({}, at)
  }
  for (const [fixture, result] of [[moving, movingResult], [running, runningResult]] as const) {
    fixture.advance(1_000)
    await expect(result).rejects.toThrow("1000ms local deadline")
    expect(fixture.pending).toEqual([0, 0, 0])
  }
  const absent = skipFixture(), absentResult = absent.start()
  absent.advance(1_000)
  await expect(absentResult).rejects.toThrow("1000ms local deadline")
  expect(absent.pending).toEqual([0, 0, 0])
  for (const at of [1_000, 1_001, NaN, -1]) {
    const fixture = skipFixture(), result = fixture.start()
    fixture.frame({}, 16); fixture.frame({}, at)
    await expect(result).rejects.toThrow("1000ms local deadline")
    expect(fixture.pending).toEqual([0, 0, 0])
  }
  const slow = skipFixture(), slowResult = slow.start()
  slow.frame()
  slow.setReadCost(1_000)
  slow.frame()
  await expect(slowResult).rejects.toThrow("1000ms local deadline")
  expect(slow.pending).toEqual([0, 0, 0])
  const timely = skipFixture(), timelyResult = timely.start()
  timely.frame({}, 998); timely.frame({}, 999)
  expect(await timelyResult).toEqual({ rect: [12, 12, 100, 48], scrollY: 0 })
  expect(timely.pending).toEqual([0, 0, 0])
})

test("skip settlement refuses nonfinite geometry instead of waiting for a valid rectangle", async () => {
  for (const patch of [{ rect: [12, NaN, 100, 48] }, { rect: [12, 12, Infinity, 48] }, { scrollY: Infinity }]) {
    const fixture = skipFixture(patch)
    await expect(fixture.start()).rejects.toThrow("invalid skip geometry")
    expect(fixture.pending).toEqual([0, 0, 0])
  }
})

function transferFixture(skip: Partial<SkipSample> = {}, main: Partial<SkipSample> = {}) {
  return skipFixture({ focused: false, focus: false, focusVisible: false, ...skip },
    { focused: true, focus: true, focusVisible: true, ...main })
}

test("native transfer requires immediate exact main focus and two stable RAF samples of both owners", async () => {
  const fixture = transferFixture(), result = fixture.startState("main", "baseline reload transfer")
  expect(fixture.reads).toBe(2)
  expect(fixture.pending).toEqual([1, 1, 2])
  fixture.mainFrame()
  expect(fixture.pending).toEqual([1, 1, 2])
  fixture.mainFrame()
  expect(await result).toEqual({ scrollY: 0, elements: [
    { key: ".skip-link[0]", rect: [12, 12, 100, 48], styles: focusPaint },
    { key: "#main[0]", rect: [0, 100, 320, 900], styles: focusPaint },
  ] })
  expect(fixture.reads).toBe(6)
  expect(fixture.pending).toEqual([0, 0, 0])
})

test("native transfer waits for both finite animation owners and restarts geometry and paint stability", async () => {
  const fixture = transferFixture({ animations: [{}] }, { animations: [{ playState: "finished", pending: true }] })
  const result = fixture.startState("main")
  fixture.mainFrame({}, { animations: [] })
  fixture.mainFrame({}, { rect: [12, -73, 100, 48] })
  expect(fixture.pending).toEqual([1, 1, 2]) // Main's pending animation still owns settlement.
  fixture.mainFrame({ animations: [] })
  fixture.mainFrame({ rect: [0, 101, 320, 900] })
  fixture.mainFrame({ styles: { ...focusPaint, "outline-width": "3px" } })
  expect(fixture.pending).toEqual([1, 1, 2])
  fixture.mainFrame()
  const value = await result
  expect(value.elements[0]!.rect).toEqual([12, -73, 100, 48])
  expect(value.elements[1]!.rect).toEqual([0, 101, 320, 900])
  expect(value.elements[1]!.styles["outline-width"]).toBe("3px")
  expect(fixture.pending).toEqual([0, 0, 0])
})

test("reveal and transfer sample every admitted paint property even when native geometry is already stable", async () => {
  for (const property of Object.keys(focusPaint)) {
    for (const owner of ["reveal", "skip", "main"] as const) {
      const fixture = owner === "reveal" ? skipFixture() : transferFixture()
      const result = fixture.startState(owner === "reveal" ? "skip" : "main")
      fixture.frame()
      const styles = { ...focusPaint, [property]: `different-native-${property}` }
      if (owner === "main") fixture.mainFrame({ styles })
      else fixture.frame({ styles })
      expect(fixture.pending).toEqual([1, 1, owner === "reveal" ? 1 : 2])
      fixture.frame()
      expect((await result).elements[owner === "main" ? 1 : 0]!.styles[property]).toBe(`different-native-${property}`)
      expect(fixture.pending).toEqual([0, 0, 0])
    }
  }
})

test("stable wrong transfer geometry and paint reach strict parity unchanged and stay red", async () => {
  const fixture = transferFixture({ rect: [12, 12, 100, 48], styles: { ...focusPaint, "outline-color": "rgb(138, 85, 0)" } })
  const result = fixture.startState("main")
  fixture.frame(); fixture.frame()
  const settled = await result
  const actual = settled.elements.map(owner => ({ ...owner, text: "", semantics: {} }))
  expect(() => assertShellFocusUnchanged(settled, actual, "observed transfer")).not.toThrow()
  const baseline = actual.map(owner => owner.key === ".skip-link[0]"
    ? { ...owner, rect: [12, -73, 100, 48], styles: focusPaint } : owner)
  expect(() => compareShellElements(actual, baseline, "paired transfer")).toThrow("paired element differences")
  fixture.frame({ rect: [12, -73, 100, 48], styles: focusPaint })
  expect(() => compareShellElements(actual, baseline, "paired transfer")).toThrow("paired element differences")
  expect(fixture.pending).toEqual([0, 0, 0])
})

test("recorded focus evidence cannot change geometry, paint or owner inventory after settlement", async () => {
  const fixture = transferFixture({ scrollY: 40 }), result = fixture.startState("main")
  fixture.frame(); fixture.frame()
  const settled = await result
  const evidence = settled.elements.map(owner => ({ ...owner,
    rect: [owner.rect[0]!, owner.rect[1]! + settled.scrollY, ...owner.rect.slice(2)], text: "", semantics: {} }))
  expect(() => assertShellFocusUnchanged(settled, evidence, "transfer")).not.toThrow()
  for (const index of [0, 1]) {
    const owner = evidence[index]!
    for (const patch of [{ rect: owner.rect.map(value => value + 1) },
      { styles: { ...owner.styles, "outline-color": "rgb(255, 0, 0)" } }]) {
      const changed = evidence.map((item, position) => position === index ? { ...item, ...patch } : item)
      expect(() => assertShellFocusUnchanged(settled, changed, "transfer")).toThrow("changed after settlement")
    }
    expect(() => assertShellFocusUnchanged(settled, evidence.filter((_, position) => position !== index), "transfer")).toThrow("owner inventory changed")
    expect(() => assertShellFocusUnchanged(settled, [...evidence, owner], "transfer")).toThrow("owner inventory changed")
  }
})

test("native transfer rejects main focus loss or skip focus immediately, continuously and after transient regain", async () => {
  for (const owner of ["skip", "main"] as const) {
    for (const patch of owner === "skip" ? [{ focused: true }, { focus: true }, { focusVisible: true }]
      : [{ focused: false }, { focus: false }]) {
      const immediate = transferFixture(owner === "skip" ? patch : {}, owner === "main" ? patch : {})
      await expect(immediate.startState("main")).rejects.toThrow("main requires continuous native focus and skip-not-focused")
      expect(immediate.reads).toBe(0)
      expect(immediate.pending).toEqual([0, 0, 0])
      const later = transferFixture(), result = later.startState("main", "current reload transfer")
      if (owner === "skip") later.frame(patch)
      else later.mainFrame(patch)
      await expect(result).rejects.toThrow("current reload transfer: main requires continuous native focus and skip-not-focused")
      expect(later.pending).toEqual([0, 0, 0])
    }
  }
  for (const event of ["mainBlurAndRegain", "skipFocusAndLose"] as const) {
    const fixture = transferFixture(), result = fixture.startState("main")
    fixture[event]()
    fixture.frame(); fixture.frame()
    await expect(result).rejects.toThrow("main lost native focus during settlement")
    expect(fixture.pending).toEqual([0, 0, 0])
  }
})

test("native focus settlement rejects disconnected, missing, duplicate or replaced exact owners", async () => {
  for (const mode of ["skip", "main"] as const) {
    for (const selector of [".skip-link", "#main"] as const) {
      for (const change of ["missing", "duplicate", "replaced"] as const) {
        const fixture = mode === "skip" ? skipFixture() : transferFixture(), result = fixture.startState(mode)
        fixture.changeOwner(selector, change)
        fixture.frame()
        await expect(result).rejects.toThrow("native focus owners changed")
        expect(fixture.pending).toEqual([0, 0, 0])
      }
    }
  }
  for (const owner of ["skip", "main"] as const) {
    const fixture = transferFixture(), result = fixture.startState("main")
    if (owner === "skip") fixture.frame({ connected: false })
    else fixture.mainFrame({ connected: false })
    await expect(result).rejects.toThrow("native focus owners changed")
    expect(fixture.pending).toEqual([0, 0, 0])
  }
})

test("native transfer rejects paused, infinite, stopped-rate and foreign-owned animations on either owner", async () => {
  for (const owner of ["skip", "main"] as const) {
    for (const animation of [{ playState: "paused" as const }, { endTime: Infinity }, { duration: Infinity },
      { iterations: Infinity }, { playbackRate: 0 }, { playbackRate: NaN }, { duration: NaN }, { owned: false }]) {
      const patch = { animations: [animation] }
      const immediate = transferFixture(owner === "skip" ? patch : {}, owner === "main" ? patch : {})
      await expect(immediate.startState("main")).rejects.toThrow(/animation.*(?:finite and unpaused|exact element owner)/u)
      expect(immediate.pending).toEqual([0, 0, 0])
      const fixture = transferFixture(), result = fixture.startState("main")
      if (owner === "skip") fixture.frame(patch)
      else fixture.mainFrame(patch)
      await expect(result).rejects.toThrow(/animation.*(?:finite and unpaused|exact element owner)/u)
      expect(fixture.pending).toEqual([0, 0, 0])
    }
  }
})

test("native transfer cannot settle nonsettling paint, geometry, running animations or missing RAF past its deadline", async () => {
  for (const condition of ["skip-paint", "main-paint", "geometry", "running", "missing-raf", "late-read", "deadline-frame"] as const) {
    const fixture = transferFixture({}, condition === "running" ? { animations: [{}] } : {})
    const result = fixture.startState("main")
    if (condition === "late-read") {
      fixture.frame(); fixture.setReadCost(1_000); fixture.frame()
    } else if (condition === "deadline-frame") {
      fixture.frame({}, 999); fixture.frame({}, 1_000)
    } else if (condition !== "missing-raf") {
      for (let at = 16; at < 1_000; at += 16) {
        const styles = { ...focusPaint, "outline-width": `${at}px` }
        fixture.mainFrame(condition === "main-paint" ? { styles } : condition === "geometry" ? { rect: [at, 100, 320, 900] } : {},
          condition === "skip-paint" ? { styles } : {}, at)
      }
    }
    fixture.advance(1_000)
    await expect(result).rejects.toThrow("main settlement exceeded its 1000ms local deadline")
    expect(fixture.pending).toEqual([0, 0, 0])
  }
  const timely = transferFixture(), result = timely.startState("main")
  timely.frame({}, 998); timely.frame({}, 999)
  expect((await result).elements).toHaveLength(2)
  expect(timely.pending).toEqual([0, 0, 0])
})

test("native transfer refuses nonfinite geometry and incomplete or duplicate paint inventories", async () => {
  for (const owner of ["skip", "main"] as const) {
    const fixture = transferFixture(), result = fixture.startState("main")
    if (owner === "skip") fixture.frame({ rect: [12, NaN, 100, 48] })
    else fixture.mainFrame({ rect: [0, 100, Infinity, 900] })
    await expect(result).rejects.toThrow("invalid main geometry")
    expect(fixture.pending).toEqual([0, 0, 0])
  }
  for (const properties of [[], Object.keys(focusPaint).slice(1), [...Object.keys(focusPaint), "transform"]]) {
    const fixture = transferFixture()
    await expect(fixture.startState("main", "transfer", properties)).rejects.toThrow("incomplete native focus paint inventory")
    expect(fixture.pending).toEqual([0, 0, 0])
  }
})

function request(): ShellRequest {
  const foundation = "/graphs/site-foundation/assets/style.css", union = `/assets/site-${"a".repeat(64)}.css`
  const common = ["/", "/404.html", "/icon.svg", "/llms.txt", "/sitemap.md", "/sitemap.xml", "/assets/theme.js",
    ...Array.from({ length: 13 }, (_, index) => `/assets/font-${index}.woff2`)]
  return { schemaVersion: 1, token: "12345678-abcd-1234-abcd-123456789abc", appDirectory: "/private/tmp/app",
    chromeExecutable: "/private/tmp/browser/chrome", endpoint: "ws://127.0.0.1:12345/devtools/browser/abcd-1234",
    current: { origin: "http://127.0.0.1:12346", resources: [...common, foundation, union].sort(),
      stylesheets: [foundation, union], finalCss: union }, baseline: { origin: "http://127.0.0.1:12347",
      resources: [...common, "/assets/styles.css"].sort(), stylesheets: ["/assets/styles.css"], finalCss: "/assets/styles.css" } }
}
test("ordinary static verification rejects all sockets before any server connection", async () => {
  for (const url of ["ws://127.0.0.1:12346/socket", "wss://us.i.posthog.com/socket", "wss://example.com/socket"]) {
    const errors: string[] = [], calls: unknown[] = []
    const socket = { url: () => url, close: async (options: unknown) => { calls.push(options) },
      connectToServer: () => { throw new Error("Socket escaped its admission boundary") } } as unknown as WebSocketRoute
    await denyShellWebSocket(socket, message => errors.push(message))
    expect(errors).toEqual([`Unadmitted socket ${url}`])
    expect(calls).toEqual([{ code: 1008, reason: "Ordinary static verification admits no sockets" }])
  }
})
test("shell native scope covers both exact breakpoints, all appearance states, forced colors, coarse pointers and truthful reflow", () => {
  const original = siteShellCases.slice(0, 68)
  expect(original).toHaveLength(68)
  expect(new Set(original.map(value => value.name)).size).toBe(68)
  expect(original.every(value => value.direction === undefined)).toBe(true)
  for (const route of ["/", "/404.html"] as const) {
    for (const width of [320, 390, 544, 545, 768, 769, 1440]) {
      const cases = original.filter(value => value.route === route && value.width === width && !value.coarse && value.forced === "none")
      expect(cases).toEqual((["light", "dark", "system", "system"] as const).map<ShellCase>((theme, index) => {
        const system = index === 0 || index === 3 ? "dark" : "light"
        return { name: `${route}-${width}-${theme}-${system}`, route, width, height: 900, theme, system,
          forced: "none", coarse: false, reflowEquivalent: false }
      }))
    }
    expect(original.filter(value => value.route === route && value.forced === "active")).toEqual((["light", "dark"] as const).map<ShellCase>(system => ({
      name: `${route}-forced-${system}`, route, width: 390, height: 700, theme: "system", system, forced: "active", coarse: false, reflowEquivalent: false })))
    expect(original.filter(value => value.route === route && value.coarse)).toEqual([390, 769].map<ShellCase>(width => ({
      name: `${route}-coarse-${width}`, route, width, height: 700, theme: "system", system: "light", forced: "none", coarse: true, reflowEquivalent: false })))
    expect(original.filter(value => value.route === route && value.reflowEquivalent)).toEqual((["light", "dark"] as const).map<ShellCase>(system => ({
      name: `${route}-200pct-reflow-equivalent-${system}`, route, width: 720, height: 450, theme: "system", system,
      forced: "none", coarse: false, reflowEquivalent: true })))
  }
  expect(siteShellBaselineRevision).toMatch(/^[a-f0-9]{40}$/)
  expect(siteShellBaselineTree).toMatch(/^[a-f0-9]{40}$/)
  expect(siteShellHeaders["content-security-policy"]).toContain("script-src 'self'; style-src 'self'")
  expect(siteShellHeaders["content-security-policy"]).not.toContain("unsafe-inline")
})
test("eight mandatory RTL cases append paired home and recovery layouts without changing the original 68 cases", () => {
  expect(siteShellCases).toHaveLength(76)
  expect(new Set(siteShellCases.map(value => value.name)).size).toBe(76)
  expect(siteShellCases.slice(68)).toEqual((["/", "/404.html"] as const).flatMap(route => [390, 1440].flatMap(width =>
    (["light", "dark"] as const).map<ShellCase>(theme => ({ name: `${route}-rtl-${width}-${theme}`, route, width, height: 900,
      theme, system: theme === "light" ? "dark" : "light", forced: "none", coarse: false,
      reflowEquivalent: false, direction: "rtl" })))))
})
test("System preference resolves against native media while explicit light and dark remain fixed", () => {
  expect(["light", "dark"].flatMap(system => (["light", "dark", "system"] as const).map(preference =>
    resolvedShellTheme(preference, system as "light" | "dark")))).toEqual(["light", "dark", "light", "light", "dark", "dark"])
})
test("worker requires genuine exact Node and complete explicit loopback inputs", () => {
  expect(assertShellNode({ node: "24.18.1" })).toBe("24.18.1")
  for (const versions of [{}, { node: "24.18.0" }, { node: "24.18.1", bun: "1.3.14" }]) expect(() => assertShellNode(versions)).toThrow()
  const value = request()
  expect(parseShellRequest(value)).toEqual(value)
  for (const patch of [{ baseline: null }, { appDirectory: "relative" }, { chromeExecutable: "chrome" }, { extra: true },
    { endpoint: "ws://127.0.0.1:0/devtools/browser/abcd" }, { endpoint: "ws://127.0.0.1:70000/devtools/browser/abcd" },
    { current: { ...value.current, origin: "https://atet.sh" } }, { current: { ...value.current, origin: "http://127.0.0.1:12346/" } },
    { current: { ...value.current, origin: "http://127.0.0.1:0" } }, { current: { ...value.current, finalCss: value.current.stylesheets[0] } },
    { current: { ...value.current, resources: [...value.current.resources, "/../private"].sort() } },
    { current: { ...value.current, resources: [...value.current.resources].reverse() } },
    { current: { ...value.current, resources: value.current.resources.filter(path => path !== "/404.html") } },
    { baseline: { ...value.baseline, origin: value.current.origin } }]) {
    expect(() => parseShellRequest({ ...value, ...patch })).toThrow()
  }
  for (const path of ["https://remote.test/file", "/%2e%2e/file", "/./file", "/a/../file", "/file?token=x", "/file#hash", "//remote.test/file", "/back\\slash"]) {
    // Double-slash absolute references cannot pass the browser payload's
    // origin admission, but should also fail the resource grammar itself.
    expect(() => shellResource(path)).toThrow()
  }
})
test("terminal result refuses omitted scope, reordered cases, false cleanup and alternate runtime", () => {
  const input = request()
  const result = { schemaVersion: 1, token: input.token, sequence: 2, kind: "result", node: "24.18.1", playwright: "1.62.0",
    browser: "149.0.0.1", cases: siteShellCases.map(value => value.name), baselineCompared: true, closed: true,
    negativeControls: ["/", "/404.html"] }
  expect(parseShellPhase(result, 2, input)).toEqual(result)
  for (const patch of [{ closed: false }, { baselineCompared: false }, { node: "24.13.0" }, { playwright: "1.61.0" },
    { cases: result.cases.slice(1) }, { cases: result.cases.slice(0, 68) }, { cases: [...result.cases].reverse() }, { negativeControls: ["/"] },
    { sequence: 1 }, { token: "other" }, { unexpected: true }]) {
    expect(() => parseShellPhase({ ...result, ...patch }, 2, input)).toThrow()
  }
})
function element(): ShellElement {
  return { key: ".hraness-site-footer__social-link[0]", rect: [10, 20, 32, 32], text: "",
    semantics: { href: "https://substack.com/@hraness", "aria-label": "Hraness on Substack" },
    styles: { color: "rgb(23, 22, 18)", display: "flex", cursor: "pointer", "touch-action": "manipulation", "outline-width": "2px" } }
}
test("ancestor failure retains later descendant differences without weakening parity", () => {
  const first = { ...element(), key: "body[0]", styles: { height: "100px" } }
  const second = { ...element(), key: ".child[0]", styles: { height: "32px", "border-top-width": "0px" } }
  const actual = [
    { ...first, styles: { height: "104px" } },
    { ...second, styles: { height: "36px", "border-top-width": "2px" } },
  ]
  let failure: unknown
  try { compareShellElements(actual, [first, second], "paired") } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(AggregateError)
  const diagnostic = failure as AggregateError
  expect(diagnostic.message).toContain('"key":"body[0]"')
  expect(diagnostic.message).toContain('"key":".child[0]"')
  expect(diagnostic.message).toContain('"property":"border-top-width","baseline":"0px","actual":"2px"')
  expect(diagnostic.errors).toHaveLength(1)
  expect(String(diagnostic.errors[0])).toContain("body[0]: computed styles")
  expect(() => compareShellElements([first, second], [first, second], "paired")).not.toThrow()
})
test("repeated descendant diagnostics stay bounded and retain distinct causes", () => {
  const baseline = Array.from({ length: 100 }, (_, index) => ({ ...element(), key: `.child[${index}]`, styles: { "white-space": "nowrap" } }))
  const actual = baseline.map(item => ({ ...item, rect: item.rect.map(axis => axis + 4), styles: { "white-space": "normal" } }))
  let failure: unknown
  try { compareShellElements(actual, baseline, "paired") } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(AggregateError)
  const diagnostic = (failure as AggregateError).message
  expect(diagnostic.length).toBeLessThan(1_000)
  expect(diagnostic).toContain('"affectedElements":100')
  expect(diagnostic).toContain('"property":"white-space","baseline":"nowrap","actual":"normal"')
  expect(diagnostic).toContain('"geometryChanges":400')
})
test("shadow parity accepts only exact black color-space equivalence and preserves paint differences", () => {
  const old = { ...element(), styles: { "box-shadow": "rgba(0, 0, 0, 0.32) 0px 18px 48px -18px" } }
  const current = { ...old, styles: { "box-shadow": "oklch(0 0 0 / 0.32) 0px 18px 48px -18px" } }
  expect(() => compareShellElements([current], [old], "equivalent black")).not.toThrow()
  expect(current.styles["box-shadow"]).toContain("oklch") // Raw evidence is never rewritten.
  for (const shadow of [
    "oklch(0 0 0 / 0.33) 0px 18px 48px -18px",
    "oklch(0.01 0 0 / 0.32) 0px 18px 48px -18px",
    "oklch(0 0.01 0 / 0.32) 0px 18px 48px -18px",
    "oklch(0 0 0 / 0.32) 0px 19px 48px -18px",
    "oklch(0 0 0 / 0.32) 0px 18px 49px -18px",
    "oklch(0 0 0 / 0.32) 0px 18px 48px -17px",
    "none",
  ]) expect(() => compareShellElements([{ ...current, styles: { "box-shadow": shadow } }], [old], "paint regression")).toThrow()
  expect(() => compareShellElements([{ ...current, styles: { color: "oklch(0 0 0 / 0.32)" } }],
    [{ ...old, styles: { color: "rgba(0, 0, 0, 0.32)" } }], "unreviewed property")).toThrow()
})
function evidence(): ShellEvidence {
  const old = element()
  const menuElements = [
    ["[data-hraness-appearance-menu]", 1], ["[data-hraness-appearance-menu] button", 1],
    ["[data-hraness-appearance-menu] .hraness-design-theme-toggle__popover", 1],
    ['[data-hraness-appearance-menu] [role="menu"]', 1], ['[data-hraness-appearance-menu] [role="menuitemradio"]', 3],
    ['[data-hraness-appearance-menu] [role="menuitemradio"] .hraness-appearance-icon', 3],
    ['[data-hraness-appearance-menu] [role="menuitemradio"] .hraness-appearance-icon svg', 3],
  ] as const
  return { direction: "ltr", dom: "<main></main>", elements: [old], skip: old, hover: [old], focus: [old], recovery: false,
    appearance: shellAppearanceSteps.map(step => ({ step: step.name, active: step.active,
      elements: menuElements.flatMap(([selector, count]) => Array.from({ length: count }, (_, index) => ({
        ...old, key: `${selector}[${index}]`, text: "Light",
        styles: { ...old.styles, direction: "ltr", "background-color": "rgb(255, 255, 255)" },
        semantics: { role: "menuitemradio", "aria-checked": "true", tabindex: "-1", "data-theme-value": "light", "data-selected": "" },
      }))) })) }
}
test("parity catches footer cascade, native appearance, focus, semantic and geometry regressions", () => {
  const old = element()
  expect(() => compareShellElements([old], [old], "same")).not.toThrow()
  for (const changed of [
    { ...old, styles: { ...old.styles, color: "rgb(98, 93, 84)" } },
    { ...old, styles: { ...old.styles, "touch-action": "auto" } },
    { ...old, styles: { ...old.styles, cursor: "auto" } },
    { ...old, styles: { ...old.styles, "outline-width": "0px" } },
    { ...old, semantics: { ...old.semantics, href: "https://other.test/" } },
    { ...old, rect: [10, 20, 33, 32] }, { ...old, rect: [NaN, 20, 32, 32] },
  ]) expect(() => compareShellElements([changed], [old], "regression")).toThrow()
  const baseline = evidence()
  expect(() => compareShellEvidence(baseline, baseline, "same")).not.toThrow()
  for (const changed of [{ ...baseline, dom: "<div></div>" }, { ...baseline, direction: "rtl" as const },
    { ...baseline, focus: [] }, { ...baseline, hover: [] }, { ...baseline, recovery: true }]) {
    expect(() => compareShellEvidence(changed, baseline, "regression")).toThrow()
  }
})
test("open menu parity binds every native focus step and actual item styles, geometry and semantics", () => {
  const baseline = evidence()
  expect(shellAppearanceSteps.map(step => [step.key, step.active])).toEqual([
    ["ArrowDown", "light"], ["ArrowUp", "system"], ["Home", "light"], ["ArrowDown", "dark"],
    ["End", "system"], ["ArrowDown", "light"], ["ArrowUp", "system"],
  ])
  for (const appearance of [baseline.appearance.slice(1), [...baseline.appearance].reverse(),
    baseline.appearance.map((step, index) => index === 0 ? { ...step, active: "dark" as const } : step),
    baseline.appearance.map(step => ({ ...step, elements: [] }))]) {
    expect(() => compareShellEvidence({ ...baseline, appearance }, baseline, "native menu")).toThrow()
    expect(() => compareShellEvidence({ ...baseline, appearance }, { ...baseline, appearance }, "missing scope on both sides")).toThrow()
  }
  const item = baseline.appearance[3]!.elements[4]!
  for (const changed of [{ ...item, styles: { ...item.styles, "background-color": "rgb(0, 0, 0)" } },
    { ...item, styles: { ...item.styles, direction: "rtl" } }, { ...item, rect: [10, 20, 40, 32] },
    { ...item, semantics: { ...item.semantics, "aria-checked": "false" } },
    { ...item, semantics: { ...item.semantics, role: "option" } }]) {
    const appearance = baseline.appearance.map((step, index) => index === 3
      ? { ...step, elements: step.elements.map((element, offset) => offset === 4 ? changed : element) } : step)
    expect(() => compareShellEvidence({ ...baseline, appearance }, baseline, "visible menu regression")).toThrow()
  }
})
