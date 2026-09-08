import { expect, test } from "bun:test"
import type { WebSocketRoute } from "playwright-core"
import { assertShellNode, compareShellElements, compareShellEvidence, denyShellWebSocket, parseShellPhase, parseShellRequest,
  resolvedShellTheme, shellAppearanceSteps, shellResource, siteShellBaselineRevision, siteShellBaselineTree, siteShellCases, siteShellHeaders,
  type ShellCase, type ShellElement, type ShellEvidence, type ShellRequest } from "./site-shell-browser-contract"

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
