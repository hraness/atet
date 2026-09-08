import { expect, test } from "bun:test"
import { assertShellNode, compareShellElements, compareShellEvidence, parseShellPhase, parseShellRequest,
  shellResource, siteShellBaselineRevision, siteShellBaselineTree, siteShellCases, siteShellHeaders,
  type ShellElement, type ShellEvidence, type ShellRequest } from "./site-shell-browser-contract"

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
test("shell native scope covers both exact breakpoints, all appearance states, forced colors, coarse pointers and truthful reflow", () => {
  expect(siteShellCases).toHaveLength(68)
  expect(new Set(siteShellCases.map(value => value.name)).size).toBe(68)
  for (const route of ["/", "/404.html"]) {
    for (const width of [320, 390, 544, 545, 768, 769, 1440]) {
      const cases = siteShellCases.filter(value => value.route === route && value.width === width && !value.coarse && value.forced === "none")
      expect(cases.map(value => [value.theme, value.system])).toEqual([["light", "dark"], ["dark", "light"], ["system", "light"], ["system", "dark"]])
    }
    expect(siteShellCases.filter(value => value.route === route && value.forced === "active")).toHaveLength(2)
    expect(siteShellCases.filter(value => value.route === route && value.coarse)).toHaveLength(2)
    expect(siteShellCases.filter(value => value.route === route && value.reflowEquivalent).map(value => [value.width, value.height])).toEqual([[720, 450], [720, 450]])
  }
  expect(siteShellBaselineRevision).toMatch(/^[a-f0-9]{40}$/)
  expect(siteShellBaselineTree).toMatch(/^[a-f0-9]{40}$/)
  expect(siteShellHeaders["content-security-policy"]).toContain("script-src 'self'; style-src 'self'")
  expect(siteShellHeaders["content-security-policy"]).not.toContain("unsafe-inline")
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
    { cases: result.cases.slice(1) }, { cases: [...result.cases].reverse() }, { negativeControls: ["/"] },
    { sequence: 1 }, { token: "other" }, { unexpected: true }]) {
    expect(() => parseShellPhase({ ...result, ...patch }, 2, input)).toThrow()
  }
})
function element(): ShellElement {
  return { key: ".hraness-site-footer__social-link[0]", rect: [10, 20, 32, 32], text: "",
    semantics: { href: "https://substack.com/@hraness", "aria-label": "Hraness on Substack" },
    styles: { color: "rgb(23, 22, 18)", display: "flex", cursor: "pointer", "touch-action": "manipulation", "outline-width": "2px" } }
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
  const evidence: ShellEvidence = { dom: "<main></main>", elements: [old], skip: old, hover: [old], focus: [old], recovery: false }
  for (const changed of [{ ...evidence, dom: "<div></div>" }, { ...evidence, focus: [] }, { ...evidence, hover: [] }, { ...evidence, recovery: true }]) {
    expect(() => compareShellEvidence(changed, evidence, "regression")).toThrow()
  }
})
