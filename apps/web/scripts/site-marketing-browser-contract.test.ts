import { expect, test } from "bun:test"
import { marketingScope, marketingBaselineProfile, marketingBaselineRevision, marketingBaselineTree, marketingCases,
  marketingDeadlineMs, parseMarketingRequest, parseMarketingPhase, parseMarketingCaseFailure, marketingCaseFailure,
  compareMarketingElements, headingSize, marketingHeadingIds, marketingSectionIds, assertMarketingPaint, assertMarketingProof, assertMarketingFlow, assertMarketingInstallNote,
  assertMarketingDerivedPaint, marketingPrimaryContrast, type MarketingRequest, type MarketingTextExtent } from "./site-marketing-browser-contract"
import { parseShellRequest, type ShellElement } from "./site-shell-browser-contract"
import { assertMarketingBaselineManifest, assertMarketingFontInventory } from "./verify-site-marketing"
import type { ShellSnapshot } from "./verify-site-shell"

function request(): MarketingRequest {
  const finalCss = `/assets/site-${"a".repeat(64)}.css`
  const fieldAssets = ["/grain.svg", "/cells.svg"]
  const resources = ["/", "/404.html", "/base.css", finalCss, ...fieldAssets, ...Array.from({ length: 14 }, (_, index) => `/font-${index}.woff2`)].sort()
  const payload = (port: number) => ({ origin: `http://127.0.0.1:${port}`, resources, stylesheets: ["/base.css", finalCss], finalCss })
  return parseMarketingRequest({ schemaVersion: 1, scope: marketingScope, baselineProfile: marketingBaselineProfile,
    token: "00112233-4455-6677-8899-aabbccddeeff", appDirectory: "/tmp/current-app", chromeExecutable: "/tmp/chrome",
    endpoint: "ws://127.0.0.1:9222/devtools/browser/1234abcd", current: payload(1234), baseline: payload(1235), fieldAssets })
}
function result(input = request()) {
  return { schemaVersion: 1, scope: marketingScope, baselineProfile: marketingBaselineProfile, token: input.token,
    sequence: 2, kind: "result", node: "24.18.1", playwright: "1.62.0", browser: "151.0.7922.34",
    cases: marketingCases.map(value => value.name), comparison: "unchanged-shell-and-copy-with-reviewed-homepage-design", closed: true,
    negativeControls: ["/-final-css", "/-foundation-css", "/404.html-final-css"],
    designCases: marketingCases.map(value => ({ name: value.name, scope: value.route === "/" ? "editorial-main" : "unchanged-404",
      h1Px: value.route === "/" ? headingSize(value.width, 1) : null, h2Px: value.route === "/" ? headingSize(value.width, 2) : null,
      foundationRestored: value.route === "/" && value.width === 1440 && value.theme === "system" && value.system === "light" })) }
}
test("new design protocol cannot enter historical parity and refuses scope/payload ambiguity", () => {
  const input = request()
  expect(() => parseShellRequest(input)).toThrow()
  for (const patch of [{ scope: "shell" }, { baselineProfile: "historical" }, { baseline: input.current },
    { current: { ...input.current, resources: [...input.current.resources, "https://remote.test/font.woff2"] } },
    { current: { ...input.current, stylesheets: ["/base.css"] } }, { baselineCompared: true },
    { fieldAssets: ["/grain.svg", "/missing.svg"] }, { fieldAssets: ["/grain.svg", "/grain.svg"] },
    { fieldAssets: ["/font-1.woff2", "/cells.svg"] }]) {
    expect(() => parseMarketingRequest({ ...input, ...patch })).toThrow()
  }
})
test("terminal proof requires all 76 cases, actual design observations and both restoration controls", () => {
  const input = request(), complete = result(input)
  expect(marketingCases).toHaveLength(76); expect(marketingDeadlineMs).toBe(720_000)
  expect(parseMarketingPhase(complete, 2, input)).toEqual(complete)
  for (const patch of [{ cases: complete.cases.slice(1) }, { closed: false }, { comparison: "historical-parity" },
    { negativeControls: ["/-final-css", "/404.html-final-css"] }, { designCases: [] },
    { designCases: complete.designCases.map((item, index) => index === 0 ? { ...item, h1Px: 16 } : item) }, { baselineCompared: true }]) {
    expect(() => parseMarketingPhase({ ...complete, ...patch }, 2, input)).toThrow()
  }
})
test("failure receipt names only the fully completed prefix and cannot impersonate success", () => {
  const input = request(), prefix = marketingCases.slice(0, 3).map(value => value.name)
  const failure = marketingCaseFailure(input, marketingCases[3]!.name, "current", prefix, new Error("Missing local font"))
  expect(failure.accepted).toBe(false)
  expect(() => parseMarketingPhase(failure, 2, input)).toThrow()
  expect(() => parseMarketingCaseFailure({ ...failure, comparedCases: [...prefix].reverse() }, input)).toThrow()
  expect(() => parseMarketingCaseFailure({ ...failure, accepted: true }, input)).toThrow()
})
function element(key: string, styles: Record<string, string> = {}): ShellElement {
  return { key, rect: [20, 100, 200, 100], styles: { width: "200px", height: "100px", color: "rgb(20, 20, 20)",
    "background-color": "rgba(0, 0, 0, 0)", "font-size": "16px", ...styles }, text: "Original product copy", semantics: { href: null } }
}
test("finite typography exception never exempts text, semantics, unrelated paint, inventory or collapsed content", () => {
  const old = element("#page-title[0]"), changed = { ...old, styles: { ...old.styles, "font-size": "44px" }, rect: [32, 120, 240, 106] }
  expect(() => compareMarketingElements([changed], [old], "allowed heading typography")).not.toThrow()
  for (const actual of [{ ...changed, text: "Invented copy" }, { ...changed, semantics: { href: "https://other.test" } },
    { ...changed, styles: { ...changed.styles, "background-color": "red" } }, { ...changed, rect: [32, 120, 240, 0] }]) {
    expect(() => compareMarketingElements([actual], [old], "regression")).toThrow()
  }
  expect(() => compareMarketingElements([], [old], "missing heading")).toThrow()
  const button = element(".unlisted-button[0]")
  expect(() => compareMarketingElements([{ ...button, rect: [20, 100, 100, 100] }], [button], "unlisted dimensions")).toThrow()
  const section = element("#workflow[0]")
  expect(() => compareMarketingElements([{ ...section, styles: { ...section.styles, "background-color": "red" } }], [section], "unlisted section paint")).toThrow()
  const transcript = element(".transcript[0]")
  expect(() => compareMarketingElements([{ ...transcript, styles: { ...transcript.styles, color: "red" } }], [transcript], "retained command paint")).toThrow()
  const inherited = element("#page-title[0]", { "text-decoration-line": "none", "text-decoration-color": "rgb(20, 20, 20)" })
  const newInk = { ...inherited, styles: { ...inherited.styles, color: "rgb(36, 42, 47)", "text-decoration-color": "rgb(36, 42, 47)" } }
  expect(() => compareMarketingElements([newInk], [inherited], "inactive exact currentColor derivation")).not.toThrow()
  expect(() => compareMarketingElements([{ ...newInk, styles: { ...newInk.styles, "text-decoration-line": "underline" } }], [inherited], "new active paint")).toThrow()
  expect(() => compareMarketingElements([{ ...newInk, styles: { ...newInk.styles, "text-decoration-color": "red" } }], [inherited], "independent decoration paint")).toThrow()
})
test("design baseline admits only reviewed exact bf1e1a9 source and artifact bytes", () => {
  const snapshot: ShellSnapshot = { inputs: [{ path: "src/index.html", bytes: 1, sha256: "a".repeat(64) }],
    artifacts: [{ path: "index.html", bytes: 1, sha256: "b".repeat(64) }], files: new Map(), stylesheets: ["/base.css", "/site.css"] }
  const manifest = { schemaVersion: 3, baselineProfile: marketingBaselineProfile, sourceRevision: marketingBaselineRevision,
    checkoutRevision: marketingBaselineRevision, sourceTree: marketingBaselineTree, inputs: snapshot.inputs, artifacts: snapshot.artifacts }
  expect(() => assertMarketingBaselineManifest(manifest, snapshot)).not.toThrow()
  for (const patch of [{ schemaVersion: 1 }, { sourceTree: "c".repeat(40) }, { checkoutRevision: "d".repeat(40) },
    { baselineProfile: "install-family-ed48ebb3-v1" }, { inputs: [] }, { artifacts: [] }, { accepted: true }]) {
    expect(() => assertMarketingBaselineManifest({ ...manifest, ...patch }, snapshot)).toThrow()
  }
})
test("every admitted field paint change is positive, including H2 transparency and zero-sized texture controls", () => {
  const scenario = marketingCases.find(value => value.route === "/" && value.width === 390 && value.theme === "light")!
  const ink = "rgb(36, 42, 47)", muted = "rgb(81, 93, 104)", origin = "http://127.0.0.1:1234", assets = ["/grain.svg", "/cells.svg"] as const
  const selectors = ["#main", "#page-title", ...marketingHeadingIds.map(id => `#${id}`), ...marketingSectionIds.map(id => `#${id}`),
    ".hraness-marketing-hero", ".hraness-marketing-hero__copy", ".hraness-marketing-hero__frame", ".hraness-marketing-proof-frame", ".hraness-marketing-proof-frame__content"]
  const elements = selectors.map(selector => element(`${selector}[0]`, { color: ink, "background-image": "none" }))
  elements.push(...[".hraness-marketing-hero__summary", ".hraness-marketing-proof-frame__chrome", ".hraness-marketing-proof-frame__caption"].map(selector => element(`${selector}[0]`, { color: muted })))
  const field = elements[0]!
  elements[0] = { ...field, styles: { ...field.styles, position: "relative", "background-image": `url("${origin}/grain.svg"), url("${origin}/cells.svg"), linear-gradient(rgb(240, 239, 234) 0%, rgb(220, 225, 223) 34%, rgb(201, 211, 221) 70%, rgb(227, 231, 232) 100%)`,
    "background-size": "64px 64px, 266.667%, 100% 100%", "background-position": "0px 0px, 50% 0%, 0px 0px", "background-repeat": "repeat, repeat, repeat",
    "background-attachment": "scroll, scroll, scroll", "background-origin": "padding-box, padding-box, padding-box", "background-clip": "border-box, border-box, border-box" } }
  const canvas = { color: "rgb(0, 0, 0)", background: "rgb(255, 255, 255)" }
  expect(() => assertMarketingPaint(elements, scenario, assets, origin, canvas)).not.toThrow()
  for (const [key, property, value] of [["#workflow-title[0]", "color", "rgba(0, 0, 0, 0)"], ["#main[0]", "background-size", "0px 0px, 0px 0px, 0px 0px"],
    ["#main[0]", "background-position", "10000px 0px, 50% 0%, 0px 0px"], ["#main[0]", "background-repeat", "no-repeat"],
    ["#main[0]", "background-attachment", "scroll, fixed, scroll"], ["#main[0]", "background-origin", "content-box, padding-box, padding-box"],
    ["#main[0]", "background-clip", "border-box, border-box"],
    [".hraness-marketing-proof-frame__caption[0]", "color", "red"], [".hraness-marketing-hero[0]", "background-color", "red"]]) {
    const changed = elements.map(item => item.key === key ? { ...item, styles: { ...item.styles, [property!]: value! } } : item)
    expect(() => assertMarketingPaint(changed, scenario, assets, origin, canvas)).toThrow()
  }
})
test("only the three main field layers expand unchanged default background longhands", () => {
  const defaults = { "background-attachment": "scroll", "background-origin": "padding-box", "background-clip": "border-box" }
  const old = element("#main[0]", defaults), changed = element("#main[0]", Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, [value, value, value].join(", ")])))
  expect(() => compareMarketingElements([changed], [old], "three unchanged field defaults")).not.toThrow()
  for (const [key, value] of [["background-attachment", "scroll, fixed, scroll"], ["background-origin", "content-box, padding-box, padding-box"], ["background-clip", "border-box, border-box"]])
    expect(() => compareMarketingElements([{ ...changed, styles: { ...changed.styles, [key!]: value! } }], [old], "layer regression")).toThrow()
  expect(() => compareMarketingElements([{ ...changed, key: ".hraness-marketing-hero[0]" }], [{ ...old, key: ".hraness-marketing-hero[0]" }], "unlisted layer owner")).toThrow()
})
test("proof requires complete six-line readable extent and text containment, not merely positive dimensions", () => {
  const block = (selector: string, rect: number[], styles: Record<string, string> = {}): ShellElement => ({ ...element(`${selector}[0]`, styles), rect })
  const elements = [block(".hraness-marketing-proof-frame", [20, 100, 500, 250], { "border-left-width": "1px" }),
    block(".hraness-marketing-proof-frame__chrome", [21, 101, 498, 30]), block(".hraness-marketing-proof-frame__content", [21, 131, 498, 168]),
    block(".transcript", [21, 131, 498, 168], { "line-height": "22px", "padding-top": "18px", "padding-bottom": "18px" }),
    block(".hraness-marketing-proof-frame__caption", [21, 299, 498, 50])]
  const extents: MarketingTextExtent[] = [{ selector: ".transcript", fragments: [[40, 149, 100, 16]], client: [498, 168], scroll: [498, 168] },
    { selector: ".hraness-marketing-proof-frame__caption", fragments: [[40, 308, 100, 16]], client: [498, 50], scroll: [498, 50] }]
  expect(() => assertMarketingProof(elements, extents)).not.toThrow()
  for (const key of [".hraness-marketing-proof-frame[0]", ".transcript[0]"]) {
    const tiny = elements.map(item => item.key === key ? { ...item, rect: [item.rect[0]!, item.rect[1]!, item.rect[2]!, 1] } : item)
    expect(() => assertMarketingProof(tiny, extents)).toThrow()
  }
  expect(() => assertMarketingProof(elements, [{ ...extents[0]!, scroll: [498, 400] }, extents[1]!])).toThrow()
  expect(() => assertMarketingProof(elements, [{ ...extents[0]!, fragments: [[40, 400, 100, 16]] }, extents[1]!])).toThrow()
})

test("primary contrast follows the exact Paper palette and selected/system theme", () => {
  const scenario = marketingCases[0]!
  for (const system of ["light", "dark"] as const) {
    expect(marketingPrimaryContrast({ ...scenario, theme: "light", system })).toBe("rgb(248, 247, 244)")
    expect(marketingPrimaryContrast({ ...scenario, theme: "dark", system })).toBe("rgb(18, 16, 15)")
    expect(marketingPrimaryContrast({ ...scenario, theme: "system", system })).toBe(system === "dark" ? "rgb(18, 16, 15)" : "rgb(248, 247, 244)")
    expect(marketingPrimaryContrast({ ...scenario, system, forced: "active" })).toBeUndefined()
  }
})
test("finite active borders and repaired primary contrast retain exact paint and alpha", () => {
  const current = { ink: "rgb(36, 42, 47)", primaryInk: "rgb(248, 247, 244)", line: "rgba(36, 42, 47, 0.12)", strongLine: "rgba(36, 42, 47, 0.22)" }
  const baseline = { ink: "rgb(28, 25, 23)", primaryInk: "rgb(28, 25, 23)", line: "rgba(28, 25, 23, 0.12)", strongLine: "rgba(28, 25, 23, 0.22)" }
  const primaryKeys = [".hraness-marketing-hero__actions a[0]", '.hraness-marketing-cta__actions a[data-emphasis="primary"][0]']
  const keys = [...marketingSectionIds.map(id => `#${id}[0]`), ".hraness-marketing-proof-frame[0]", ".hraness-marketing-proof-frame__chrome[0]",
    ".hraness-marketing-proof-frame__caption[0]", ".hraness-marketing-hero__actions a[1]"]
  const make = (reference: typeof current) => [...keys.map(key => {
    const sides = key === ".hraness-marketing-proof-frame__chrome[0]" ? ["bottom"]
      : key === "#install[0]" || key === ".hraness-marketing-proof-frame[0]" || key.endsWith("a[1]") ? ["top", "right", "bottom", "left"] : ["top"]
    return element(key, { color: reference.ink, ...Object.fromEntries(sides.flatMap(side => [
      [`border-${side}-width`, "1px"], [`border-${side}-style`, "solid"], [`border-${side}-color`, key.endsWith("a[1]") ? reference.strongLine : reference.line],
    ])) })
  }), ...primaryKeys.map(key => element(key, { color: reference.primaryInk, "background-color": "blue", "border-top-color": "blue",
    "text-decoration-line": "none", "text-decoration-color": reference.primaryInk, "outline-style": "none", "outline-color": reference.primaryInk }))]
  const original = make(baseline), changed = make(current), paint = { current, baseline }
  expect(() => assertMarketingDerivedPaint(changed, current)).not.toThrow()
  expect(() => compareMarketingElements(changed, original, "exact derived paint", paint)).not.toThrow()
  for (const [property, value] of [["border-top-color", "rgba(36, 42, 47, 0.2)"], ["border-top-width", "2px"], ["border-top-style", "dashed"]]) {
    const bad = changed.map(item => item.key === "#install[0]" ? { ...item, styles: { ...item.styles, [property!]: value! } } : item)
    expect(() => assertMarketingDerivedPaint(bad, current)).toThrow()
    expect(() => compareMarketingElements(bad, original, "border regression", paint)).toThrow()
  }
  expect(() => assertMarketingDerivedPaint(changed.map(item => item.key.endsWith("a[1]") ? { ...item, styles: { ...item.styles, color: "red" } } : item), current)).toThrow()
  for (const key of primaryKeys) {
    for (const [property, value] of [["color", current.ink], ["border-top-color", current.strongLine], ["background-color", "red"], ["text-decoration-line", "underline"]]) {
      const bad = changed.map(item => item.key === key ? { ...item, styles: { ...item.styles, [property!]: value! } } : item)
      expect(() => compareMarketingElements(bad, original, "primary paint regression", paint)).toThrow()
      if (property === "color") expect(() => assertMarketingDerivedPaint(bad, current)).toThrow()
    }
  }
  expect(() => assertMarketingDerivedPaint(changed.filter(item => item.key !== primaryKeys[1]), current)).toThrow()
})
test("unchanged footer and Ask AI translate only by the measured main flow delta", () => {
  const baseline = [element("#main[0]"), element(".slopcamera-ask-ai[0]"), element("#hraness-site-footer[0]")]
  const actual = baseline.map((item, index) => ({ ...item, rect: index === 0 ? [20, 100, 200, 150] : [20, 150, 200, 100] }))
  expect(() => assertMarketingFlow(actual, baseline)).not.toThrow()
  expect(() => assertMarketingFlow(actual.map((item, index) => index === 2 ? { ...item, rect: [20, 175, 200, 100] } : item), baseline)).toThrow()
})

test("install archive text and heading remain contained after the editorial size change", () => {
  const selector = ".hraness-marketing-install__heading-group > .install-note"
  const note = { ...element(`${selector}[0]`, { "overflow-wrap": "anywhere" }), rect: [45, 200, 230, 100] }
  const heading = { ...element("#install-title[0]"), rect: [45, 100, 230, 80] }
  const extent = { selector, fragments: [[45, 200, 225, 20], [45, 220, 100, 20]], client: [230, 100], scroll: [230, 100] }
  const column = [45, 100, 230, 200], viewport = 320
  expect(() => assertMarketingInstallNote(note, heading, extent, column, viewport)).not.toThrow()
  expect(() => assertMarketingInstallNote(note, { ...heading, rect: [45, 100, 557, 80] }, extent, column, viewport)).toThrow()
  expect(() => assertMarketingInstallNote(note, heading, { ...extent, fragments: [[45, 200, 557, 20]] }, column, viewport)).toThrow()
  expect(() => assertMarketingInstallNote(note, heading, { ...extent, scroll: [557, 100] }, column, viewport)).toThrow()
  expect(() => assertMarketingInstallNote({ ...note, styles: { ...note.styles, "overflow-wrap": "normal" } }, heading, extent, column, viewport)).toThrow()
  expect(() => assertMarketingInstallNote({ ...note, rect: [45, 200, 557, 100] }, heading,
    { ...extent, client: [557, 100], scroll: [557, 100] }, column, viewport)).toThrow()
  expect(() => assertMarketingInstallNote({ ...note, rect: [30, 200, 240, 100] }, { ...heading, rect: [30, 100, 230, 80] },
    { ...extent, client: [240, 100], scroll: [240, 100] }, column, viewport)).toThrow()
  const old = { ...note, styles: { ...note.styles, "overflow-wrap": "normal" }, rect: [45, 150, 557, 60] }
  expect(() => compareMarketingElements([note], [old], "Only declared note wrapping and flow")).not.toThrow()
  expect(() => compareMarketingElements([{ ...note, styles: { ...note.styles, color: "transparent" } }], [old], "Install note paint stays strict")).toThrow()
})


test("full snapshot retains fourteen ordinary fonts and the thirteen independent preview fonts", () => {
  const graph = (name: string, count: number) => Array.from({ length: count }, (_, index) => ({
    path: `graphs/${name}/assets/font-${index}.woff2`, bytes: 1, sha256: "a".repeat(64),
  }))
  const ordinary = graph("site-foundation", 14), preview = graph("preview-foundation", 13)
  const all = [...ordinary, ...preview]
  expect(() => assertMarketingFontInventory(all)).not.toThrow()
  for (const artifacts of [ordinary, preview, [...ordinary.slice(1), ...preview], [...ordinary, ...preview.slice(1)],
    [...all, all[0]!], [...ordinary.slice(1), ...preview, { ...ordinary[0]!, path: "fonts/escaped.woff2" }]]) {
    expect(() => assertMarketingFontInventory(artifacts)).toThrow()
  }
})
