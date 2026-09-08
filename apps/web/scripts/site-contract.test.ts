import { describe, expect, test } from "bun:test"
import { projectSiteArtifacts, siteSha256, snapshotSiteFoundation as snapshotWithInspection } from "./site-contract"

const digest = siteSha256("fixture compiler identity")
const otherDigest = siteSha256("different fixture identity")
const entrypoint = "/fixture/apps/web/src/site-foundation.ts"
const fontSources = Array.from({ length: 13 }, (_, index) => new Uint8Array([119, 79, 70, 50, index]))
const fontHashes = fontSources.map(siteSha256)

// This pure boundary takes a controlled parser result. The separate CSS suite
// proves that the real parser discovers nested and escaped resources.
function snapshotSiteFoundation(value: unknown, hashes: readonly string[] = fontHashes, entry: string = entrypoint) {
  return snapshotWithInspection(value, hashes, entry,
    source => [...source.matchAll(/url\(([^)]+)\)/gu)].map(match => match[1]!))
}

function foundationOutput() {
  return { output: [
    {
      type: "chunk", fileName: "assets/site-foundation-fixture.js", code: "\n",
      isEntry: true, facadeModuleId: entrypoint, imports: [], dynamicImports: [], exports: [],
    },
    { type: "asset", fileName: "assets/style-fixture.css", source: fontSources.map((_, index) =>
      `@font-face{font-family:fixture${index};src:url(./font-${index}.woff2)}`).join("") },
    ...fontSources.map((source, index) => ({ type: "asset", fileName: `assets/font-${index}.woff2`, source })),
  ] }
}

const artifact = (path: string, source = "fixture") => ({ path, bytes: Buffer.byteLength(source), sha256: siteSha256(source) })

function completeFixture() {
  const foundation = snapshotSiteFoundation(foundationOutput())
  const finalCss = artifact(`assets/site-${digest}.css`, ".fixture{display:grid}")
  // Deliberately make canonical identity order differ from package name order.
  const packages = [
    { manifestSha256: "8".repeat(64), name: "@hraness/design-kit", version: "0.5.2" },
    { manifestSha256: "e".repeat(64), name: "@hraness/site-footer", version: "0.6.1" },
    { manifestSha256: "a".repeat(64), name: "@hraness/ui", version: "0.5.7" },
  ]
  const complete = {
    artifacts: [artifact("404.html", "<!doctype html><title>404</title>"), artifact("index.html", "<!doctype html><title>Atet</title>"),
      ...foundation.artifacts.map(item => ({ ...item, path: `graphs/site-foundation/${item.path}` })),
      artifact("graphs/site-renderer/entries/site-renderer-fixture.js", "export function renderSiteDocument(){}"),
    ],
    compilerSha256: digest, finalCss, generationId: "atet-site-shell",
    graphs: ["site-foundation", "site-renderer"].map(id => ({ id, receiptSha256: digest })),
    kind: "hraness-stylex-complete-generation", packages: structuredClone([packages[0]!, packages[2]!, packages[1]!]),
    planSha256: digest, schemaVersion: 2, state: "complete", unionPolicySha256: digest,
  }
  const expected = { compilerSha256: digest, finalCssPath: finalCss.path, foundation, packages, planSha256: digest, unionPolicySha256: digest }
  return { complete, expected }
}

describe("site shell artifact publication (pure synthetic controls)", () => {
  test("projects both sealed templates, two stylesheets and thirteen fonts without mutation", () => {
    const { complete, expected } = completeFixture()
    complete.artifacts.push(artifact("graphs/site-renderer/chunks/shared-fixture.js", "export{}"))
    const original = structuredClone({ complete, expected })
    const projected = projectSiteArtifacts(complete, expected)
    expect(projected).toHaveLength(17)
    expect(projected.filter(item => item.path.endsWith(".html")).map(item => item.path)).toEqual(["404.html", "index.html"])
    expect(projected.filter(item => item.path.endsWith(".css"))).toHaveLength(2)
    expect(projected.filter(item => item.path.endsWith(".woff2"))).toHaveLength(13)
    expect(projected.some(item => /\.(?:js|map|json|ts)$/u.test(item.path))).toBe(false)
    expect(projected.find(item => item.path === "index.html")).toEqual(complete.artifacts[1])
    expect(projected.map(item => item.path)).toEqual(projected.map(item => item.path).sort())
    expect({ complete, expected }).toEqual(original)
  })

  test("output and graph order are irrelevant, while the public projection stays deterministic", () => {
    const { complete, expected } = completeFixture()
    const projection = projectSiteArtifacts(complete, expected)
    complete.artifacts.reverse()
    complete.graphs.reverse()
    expect(projectSiteArtifacts(complete, expected)).toEqual(projection)
    const output = foundationOutput()
    output.output.reverse()
    expect(snapshotSiteFoundation([output])).toEqual(expected.foundation)
  })

  test("requires canonical identity order independently of captured package name order", () => {
    const { complete, expected } = completeFixture()
    const projection = projectSiteArtifacts(complete, expected)
    expect(complete.packages.map(item => item.name)).toEqual(["@hraness/design-kit", "@hraness/ui", "@hraness/site-footer"])
    const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]] as const
    for (const [completeIndex, completeOrder] of permutations.entries()) {
      for (const [expectedIndex, expectedOrder] of permutations.entries()) {
        const value = { ...complete, packages: completeOrder.map(index => complete.packages[index]!) }
        const capture = { ...expected, packages: expectedOrder.map(index => expected.packages[index]!) }
        if (completeIndex === 0 && expectedIndex === 0) {
          expect(projectSiteArtifacts(value, capture)).toEqual(projection)
        } else {
          expect(() => projectSiteArtifacts(value, capture)).toThrow()
        }
      }
    }
  })

  test("binds hashes to exact package names and rejects duplicate names with different hashes", () => {
    for (const target of ["complete", "expected"] as const) {
      for (const mutate of [
        (items: Array<{ manifestSha256: string; name: string; version: string }>) => { items[1]!.name = items[0]!.name; items[1]!.version = items[0]!.version },
        (items: Array<{ manifestSha256: string; name: string; version: string }>) => { items[1]!.name = "@hraness/unknown" },
        (items: Array<{ manifestSha256: string; name: string; version: string }>) => { items[0]!.manifestSha256 = "9".repeat(64) },
        (items: Array<{ manifestSha256: string; name: string; version: string }>) => { items.push({ ...items[0]! }) },
      ]) {
        const { complete, expected } = completeFixture()
        mutate(target === "complete" ? complete.packages : expected.packages)
        expect(() => projectSiteArtifacts(complete, expected)).toThrow()
      }
    }
  })

  test.each(["", "\n", "export{}", " export { } ;\n"])("accepts only an empty foundation module: %j", code => {
    const output = foundationOutput()
    const entry = output.output[0]!
    expect("code" in entry).toBe(true)
    if (!("code" in entry)) throw new Error("Foundation fixture is missing its module entry")
    entry.code = code
    expect(snapshotSiteFoundation(output).privateScriptPath).toBe("graphs/site-foundation/assets/site-foundation-fixture.js")
  })

  test.each([
    ["missing entry", (value: any) => { value.output.shift() }],
    ["multiple outputs", (value: any) => { value.output.push(value.output[0]) }],
    ["executable code", (value: any) => { value.output[0].code = "alert(1)" }],
    ["comment payload", (value: any) => { value.output[0].code = "/* /private/source */" }],
    ["entry bound", (value: any) => { value.output[0].code = " ".repeat(1025) }],
    ["wrong facade", (value: any) => { value.output[0].facadeModuleId = "/other/entry.ts" }],
    ["non-entry", (value: any) => { value.output[0].isEntry = false }],
    ["static import", (value: any) => { value.output[0].imports = ["other.js"] }],
    ["dynamic import", (value: any) => { value.output[0].dynamicImports = ["other.js"] }],
    ["export", (value: any) => { value.output[0].exports = ["main"] }],
    ["wrong entry name", (value: any) => { value.output[0].fileName = "assets/preview-foundation-fixture.js" }],
    ["unknown output type", (value: any) => { value.output[2].type = "other" }],
    ["second chunk", (value: any) => { value.output[2].type = "chunk" }],
    ["source map", (value: any) => { value.output[2].fileName = "assets/font.woff2.map" }],
    ["duplicate name", (value: any) => { value.output[2].fileName = value.output[3].fileName }],
    ["missing stylesheet", (value: any) => { value.output[1].fileName = "assets/extra.woff2" }],
    ["null bytes", (value: any) => { value.output[2].source = null }],
    ["invalid UTF-8 CSS", (value: any) => { value.output[1].source = new Uint8Array([255]) }],
  ] as const)("rejects an invalid foundation: %s", (_label, mutate) => {
    const output = foundationOutput()
    mutate(output)
    expect(() => snapshotSiteFoundation(output)).toThrow()
  })

  test("requires one output with distinct exact approved font inputs", () => {
    expect(() => snapshotSiteFoundation([foundationOutput(), foundationOutput()])).toThrow("one Vite output")
    expect(() => snapshotSiteFoundation(foundationOutput(), fontHashes.slice(1))).toThrow()
    expect(() => snapshotSiteFoundation(foundationOutput(), [...fontHashes.slice(1), fontHashes[1]!])).toThrow("distinct")
    expect(() => snapshotSiteFoundation(foundationOutput(), [...fontHashes.slice(1), otherDigest])).toThrow("installed approved font")
    expect(() => snapshotSiteFoundation(foundationOutput(), [...fontHashes.slice(1), "A".repeat(64)])).toThrow("digest")
  })

  test.each(["../font-0.woff2", "/font-0.woff2", "%66ont-0.woff2", "font[0].woff2", "font-0.woff2?x", "font-0.woff2#x",
    "data:font/woff2;base64,AA", "https://example.test/font.woff2", "//example.test/font.woff2", "font-0.woff2 "])("rejects an unsafe font URL: %s", url => {
    const output = foundationOutput()
    output.output[1]!.source = String(output.output[1]!.source).replace("./font-0.woff2", url)
    expect(() => snapshotSiteFoundation(output)).toThrow()
  })

  test("binds every CSS URL exactly once and propagates parser errors", () => {
    const output = foundationOutput()
    output.output[1]!.source = String(output.output[1]!.source).replace("./font-0.woff2", "./font-1.woff2")
    expect(() => snapshotSiteFoundation(output)).toThrow("link every captured font")
    expect(() => snapshotWithInspection(foundationOutput(), fontHashes, entrypoint, () => []))
      .toThrow("link every captured font")
    expect(() => snapshotWithInspection(foundationOutput(), fontHashes, entrypoint,
      () => [...fontSources.map((_, index) => `./font-${index}.woff2`), "https://example.test/image-set.png"]))
      .toThrow("canonical local emitted WOFF2")
    expect(() => snapshotWithInspection(foundationOutput(), fontHashes, entrypoint,
      () => { throw new Error("CSS parser failure") })).toThrow("CSS parser failure")
    const renamed = foundationOutput()
    renamed.output[2]!.fileName = "assets/GeistMono_wght_-Vc9u_qg9.woff2"
    renamed.output[1]!.source = String(renamed.output[1]!.source).replace("./font-0.woff2", "./GeistMono_wght_-Vc9u_qg9.woff2")
    expect(snapshotSiteFoundation(renamed).artifacts).toHaveLength(15)
  })

  test.each(["../outside.css", "/outside.css", "graphs//x.css", "graphs/%2e%2e/x.css", "graphs\\other.js", "graphs/./x.js", "graphs/../x.js",
    "graphs/site-foundation/assets/source.ts", "graphs/site-renderer/stylex-graph.json", "graphs/site-renderer/chunks/x.js.map",
    "graphs/site-renderer/entries/other.js", "graphs/site-renderer/nested/chunks/x.js", "graphs/other/entries/site-renderer-x.js",
    "assets/client.js", "private-source.json", "preview.html", "docs/index.html"])("rejects an unexpected or unsafe output: %s", path => {
    const { complete, expected } = completeFixture()
    complete.artifacts.push(artifact(path))
    expect(() => projectSiteArtifacts(complete, expected)).toThrow()
  })

  test.each([
    ["duplicate", (value: any) => { value.artifacts.push(value.artifacts[0]) }],
    ["missing 404", (value: any) => { value.artifacts.splice(0, 1) }],
    ["missing home", (value: any) => { value.artifacts.splice(1, 1) }],
    ["missing renderer", (value: any) => { value.artifacts.pop() }],
    ["second renderer", (value: any) => { value.artifacts.push(artifact("graphs/site-renderer/entries/site-renderer-other.js")) }],
    ["changed foundation digest", (value: any) => { value.artifacts[2].sha256 = otherDigest }],
    ["changed foundation bytes", (value: any) => { value.artifacts[2].bytes += 1 }],
    ["negative size", (value: any) => { value.artifacts[0].bytes = -1 }],
    ["fractional size", (value: any) => { value.artifacts[0].bytes = 1.5 }],
    ["nonfinite size", (value: any) => { value.artifacts[0].bytes = NaN }],
    ["oversized artifact", (value: any) => { value.artifacts[0].bytes = 16 * 1024 * 1024 + 1 }],
    ["metadata", (value: any) => { value.artifacts[0].symlink = "other" }],
    ["invalid hash", (value: any) => { value.artifacts[0].sha256 = "z".repeat(64) }],
    ["null artifact", (value: any) => { value.artifacts[0] = null }],
    ["duplicated final CSS", (value: any) => { value.artifacts.push(value.finalCss) }],
    ["wrong final CSS", (value: any) => { value.finalCss.path = "assets/wrong.css" }],
    ["final CSS metadata", (value: any) => { value.finalCss.sourcePath = "/private/source" }],
  ] as const)("rejects malformed finalized artifacts: %s", (_label, mutate) => {
    const { complete, expected } = completeFixture()
    mutate(complete)
    expect(() => projectSiteArtifacts(complete, expected)).toThrow()
  })

  test("bounds the complete graph inventory and aggregate byte count", () => {
    const { complete, expected } = completeFixture()
    for (let index = 0; index < 47; index += 1) complete.artifacts.push(artifact(`graphs/site-renderer/chunks/chunk-${index}.js`))
    expect(() => projectSiteArtifacts(complete, expected)).toThrow()
    const next = completeFixture()
    for (let index = 0; index < 4; index += 1) {
      next.complete.artifacts.push({ ...artifact(`graphs/site-renderer/chunks/chunk-${index}.js`), bytes: 16 * 1024 * 1024 })
    }
    expect(() => projectSiteArtifacts(next.complete, next.expected)).toThrow("aggregate byte bound")
  })

  test.each([
    ["compiler", (value: any) => { value.compilerSha256 = otherDigest }],
    ["union", (value: any) => { value.unionPolicySha256 = otherDigest }],
    ["plan", (value: any) => { value.planSha256 = otherDigest }],
    ["state", (value: any) => { value.state = "building" }],
    ["generation", (value: any) => { value.generationId = "atet-preview" }],
    ["kind", (value: any) => { value.kind = "other" }],
    ["schema", (value: any) => { value.schemaVersion = 1 }],
    ["unknown metadata", (value: any) => { value.absoluteSource = "/private/source" }],
    ["wrong graph", (value: any) => { value.graphs[0].id = "preview-foundation" }],
    ["duplicate graph", (value: any) => { value.graphs[0].id = value.graphs[1].id }],
    ["missing graph", (value: any) => { value.graphs.pop() }],
    ["invalid receipt", (value: any) => { value.graphs[0].receiptSha256 = "invalid" }],
    ["graph metadata", (value: any) => { value.graphs[0].source = "/private/source" }],
    ["stale design-kit", (value: any) => { value.packages[0].version = "0.5.1" }],
    ["stale footer", (value: any) => { value.packages[2].version = "0.6.0" }],
    ["stale UI", (value: any) => { value.packages[1].version = "0.5.6" }],
    ["wrong package digest", (value: any) => { value.packages[1].manifestSha256 = otherDigest }],
    ["duplicate package", (value: any) => { value.packages[0] = value.packages[1] }],
    ["missing package", (value: any) => { value.packages.pop() }],
    ["unsorted packages", (value: any) => { value.packages.reverse() }],
    ["package metadata", (value: any) => { value.packages[0].source = "/private/source" }],
  ] as const)("rejects forged completion identities: %s", (_label, mutate) => {
    const { complete, expected } = completeFixture()
    mutate(complete)
    expect(() => projectSiteArtifacts(complete, expected)).toThrow()
  })

  test("does not let malformed expected captures expand publication authority", () => {
    for (const mutate of [
      (value: any) => { value.foundation.privateScriptPath = value.foundation.cssPath },
      (value: any) => { value.foundation.cssPath = "graphs/site-foundation/assets/other.css" },
      (value: any) => { value.foundation.artifacts[0].source = "/private/source" },
      (value: any) => { value.foundation.artifacts.push(artifact("assets/client.js")) },
      (value: any) => { value.foundation.artifacts[0] = value.foundation.artifacts[1] },
      (value: any) => { value.foundation.other = true },
      (value: any) => { value.packages.reverse() },
      (value: any) => { value.packages[0].version = "0.5.1" },
      (value: any) => { value.packages[0].manifestSha256 = "invalid" },
      (value: any) => { value.compilerSha256 = "invalid" },
      (value: any) => { value.finalCssPath = `assets/preview-${digest}.css` },
    ]) {
      const { complete, expected } = completeFixture()
      mutate(expected)
      expect(() => projectSiteArtifacts(complete, expected)).toThrow()
    }
  })
})
