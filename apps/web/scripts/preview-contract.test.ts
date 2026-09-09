import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { previewSha256, projectPreviewArtifacts, snapshotPreviewFoundation as snapshotWithInspection } from "./preview-contract"

const digest = previewSha256("fixture compiler identity")
const entrypoint = "/fixture/apps/web/src/preview-foundation.ts"
const fontSources = Array.from({ length: 13 }, (_, index) => new Uint8Array([119, 79, 70, 50, index]))
const fontHashes = fontSources.map(previewSha256)

// This dependency-free suite tests the projection from a controlled synthetic
// parser result. preview-css.test.ts separately proves real parser discovery.
function snapshotPreviewFoundation(value: unknown, hashes: readonly string[], entry: string) {
  return snapshotWithInspection(value, hashes, entry,
    source => [...source.matchAll(/url\(([^)]+)\)/gu)].map(match => match[1]!))
}

function foundationOutput() {
  return { output: [
    {
      type: "chunk", fileName: "assets/preview-foundation-fixture.js", code: "\n",
      isEntry: true, facadeModuleId: entrypoint, imports: [], dynamicImports: [], exports: [],
    },
    { type: "asset", fileName: "assets/style-fixture.css", source: fontSources.map((_, index) =>
      `@font-face{font-family:fixture${index};src:url(./font-${index}.woff2)}`).join("") },
    ...fontSources.map((source, index) => ({ type: "asset", fileName: `assets/font-${index}.woff2`, source })),
  ] }
}

function completeFixture() {
  const foundation = snapshotPreviewFoundation(foundationOutput(), fontHashes, entrypoint)
  const artifact = (path: string, source: string) => ({ path, bytes: Buffer.byteLength(source), sha256: previewSha256(source) })
  const finalCss = artifact(`assets/preview-${digest}.css`, ".fixture{display:grid}")
  const complete = {
    artifacts: [artifact("preview.html", "<!doctype html>"),
      ...foundation.artifacts.map(item => ({ ...item, path: `graphs/preview-foundation/${item.path}` })),
      artifact("graphs/preview-renderer/entries/preview-renderer-fixture.js", "export function renderPreviewDocument(){}"),
    ],
    compilerSha256: digest, finalCss, generationId: "atet-preview",
    graphs: ["preview-foundation", "preview-renderer"].map(id => ({ id, receiptSha256: digest })),
    kind: "hraness-stylex-complete-generation", packages: [{ manifestSha256: digest, name: "@hraness/ui", version: "0.5.7" }],
    planSha256: digest, schemaVersion: 2, state: "complete", unionPolicySha256: digest,
  }
  const expected = { compilerSha256: digest, finalCssPath: finalCss.path, foundation, manifestSha256: digest, planSha256: digest, unionPolicySha256: digest }
  return { complete, expected }
}

describe("inert preview artifact boundary (pure synthetic contract controls)", () => {
  test("captures the real-output shape while keeping both executable graph roles private", () => {
    const { complete, expected } = completeFixture()
    const projected = projectPreviewArtifacts(complete, expected)
    expect(projected).toHaveLength(16)
    expect(projected.filter(item => item.path.endsWith(".woff2"))).toHaveLength(13)
    expect(projected.filter(item => item.path.endsWith(".css"))).toHaveLength(2)
    expect(projected.some(item => /\.(?:js|map|json)$/u.test(item.path))).toBe(false)
    expect(projected.find(item => item.path === "preview.html")).toEqual(complete.artifacts[0])
    expect(complete.artifacts).toHaveLength(17)
  })

  test("rejects CSS-only input, executable entry behavior and incorrect entry ownership", () => {
    for (const mutate of [
      (value: any) => { value.output.shift() },
      (value: any) => { value.output[0].code = "alert(1)" },
      (value: any) => { value.output[0].facadeModuleId = "/other/entry.ts" },
      (value: any) => { value.output[0].isEntry = false },
      (value: any) => { value.output[0].imports = ["other.js"] },
      (value: any) => { value.output[0].dynamicImports = ["other.js"] },
      (value: any) => { value.output[0].exports = ["main"] },
    ]) {
      const output = foundationOutput()
      mutate(output)
      expect(() => snapshotPreviewFoundation(output, fontHashes, entrypoint)).toThrow()
    }
  })

  test("requires the exact thirteen installed font hashes and linked canonical emitted names", () => {
    const output = foundationOutput()
    expect(() => snapshotPreviewFoundation(output, [...fontHashes.slice(1), digest], entrypoint)).toThrow("installed approved font")
    for (const url of ["../font-0.woff2", "/font-0.woff2", "%66ont-0.woff2", "font[0].woff2", "font-0.woff2?x", "data:font/woff2;base64,AA", "https://example.test/font.woff2"]) {
      const value = foundationOutput()
      value.output[1]!.source = String(value.output[1]!.source).replace("./font-0.woff2", url)
      expect(() => snapshotPreviewFoundation(value, fontHashes, entrypoint)).toThrow()
    }
    const duplicate = foundationOutput()
    duplicate.output[1]!.source = String(duplicate.output[1]!.source).replace("./font-0.woff2", "./font-1.woff2")
    expect(() => snapshotPreviewFoundation(duplicate, fontHashes, entrypoint)).toThrow("link every captured font")
    const renamed = foundationOutput()
    renamed.output[2]!.fileName = "assets/GeistMono_wght_-Vc9u_qg9.woff2"
    renamed.output[1]!.source = String(renamed.output[1]!.source).replace("./font-0.woff2", "./GeistMono_wght_-Vc9u_qg9.woff2")
    expect(snapshotPreviewFoundation(renamed, fontHashes, entrypoint).artifacts).toHaveLength(15)
    expect(() => snapshotWithInspection(foundationOutput(), fontHashes, entrypoint,
      () => [...fontSources.map((_, index) => `./font-${index}.woff2`), "https://example.test/image-set.png"]))
      .toThrow("canonical local emitted WOFF2")
    expect(() => snapshotWithInspection(foundationOutput(), fontHashes, entrypoint,
      () => { throw new Error("CSS parser failure") })).toThrow("CSS parser failure")
  })

  test("rejects duplicate, extra, missing, unsafe or mutated finalized artifacts", () => {
    for (const path of ["../outside.css", "/outside.css", "graphs//x.css", "graphs/%2e%2e/x.css", "graphs/preview-foundation/assets/source.ts", "graphs/preview-renderer/stylex-graph.json", "graphs/other/entries/app.js"]) {
      const { complete, expected } = completeFixture()
      complete.artifacts.push({ path, bytes: 1, sha256: digest })
      expect(() => projectPreviewArtifacts(complete, expected)).toThrow()
    }
    for (const mutate of [
      (value: any) => { value.artifacts.push(value.artifacts[0]) },
      (value: any) => { value.artifacts.splice(0, 1) },
      (value: any) => { value.artifacts[2].sha256 = digest },
      (value: any) => { value.artifacts[2].bytes = 2 ** 40 },
      (value: any) => { value.artifacts[2].symlink = "other" },
      (value: any) => { value.artifacts.push(value.finalCss) },
      (value: any) => { value.finalCss = { ...value.finalCss, path: "assets/wrong.css" } },
    ]) {
      const { complete, expected } = completeFixture()
      mutate(complete)
      expect(() => projectPreviewArtifacts(complete, expected)).toThrow()
    }
  })

  test("rejects forged compiler, package, plan, state or private-entry identity", () => {
    for (const mutate of [
      (value: any) => { value.compilerSha256 = previewSha256("other") },
      (value: any) => { value.unionPolicySha256 = previewSha256("other") },
      (value: any) => { value.planSha256 = previewSha256("other") },
      (value: any) => { value.state = "building" },
      (value: any) => { value.packages[0].version = "0.5.6" },
      (value: any) => { value.packages[0].manifestSha256 = previewSha256("other") },
      (value: any) => { value.graphs[0].id = "other" },
      (value: any) => { value.absoluteSource = "/private/source" },
    ]) {
      const { complete, expected } = completeFixture()
      mutate(complete)
      expect(() => projectPreviewArtifacts(complete, expected)).toThrow()
    }
    const { complete, expected } = completeFixture()
    expect(() => projectPreviewArtifacts(complete, { ...expected, foundation: { ...expected.foundation, privateScriptPath: expected.foundation.cssPath } })).toThrow()
  })

  test("preview background resets preserve the shorthand's initial percentage position", async () => {
    const recipe = await readFile(new URL("../src/preview.stylex.ts", import.meta.url), "utf8")
    // The original route, shell and sun backgrounds omit a position. Explicit
    // numeric zero percentages are canonicalized to lengths in final CSS;
    // preserve their actual initial value rather than relaxing native parity.
    for (const name of ["route", "shell", "sun"]) {
      const block = new RegExp(`\\n  ${name}: \\{([\\s\\S]*?)\\n  \\},`, "u").exec(recipe)?.[1]
      expect(block).toBeDefined()
      expect(block).toContain('backgroundPosition: "initial"')
    }
    expect([...recipe.matchAll(/backgroundPosition:\s*"([^"]+)"/gu)].map(match => match[1]))
      .toEqual(["initial", "initial", "initial"])
  })

  test("authored preview has static recipes and a private CSS-importing foundation, without changing ordinary entrypoints", async () => {
    const root = new URL("../", import.meta.url)
    const read = async (path: string) => readFile(fileURLToPath(new URL(path, root)), "utf8")
    const [css, entry, recipe, renderer, template, build] = await Promise.all([
      read("src/styles.css"), read("src/preview-foundation.ts"), read("src/preview.stylex.ts"),
      read("src/preview-renderer.ts"), read("src/preview.html"), read("scripts/build-preview.ts"),
    ])
    expect(css).not.toMatch(/\.preview-/u)
    expect(entry.replace(/\/\/[^\n]*/gu, "").trim()).toBe('import "./preview-foundation.css"')
    expect(recipe).toContain('import * as stylex from "@stylexjs/stylex"')
    expect(recipe).toContain("stylex.create(")
    expect(recipe).not.toMatch(/stylex\.create\(\s*\w|document\.|insertRule|createElement/iu)
    expect(renderer).toContain('from "./preview.stylex"')
    expect(template.match(/\{\{PREVIEW_[A-Z_]+_CLASS\}\}/gu)).toHaveLength(18)
    expect(template).not.toMatch(/<script\b|<style\b|\sstyle\s*=|<a\b|<button\b/iu)
    expect(build).toContain('entrypoints: [below(root, join(app, "src/preview-foundation.ts"))]')
    expect(build).toContain("finalizeStylexGeneration(")
    expect(build).toContain('join(app, "src/preview-foundation.ts"), inspectPreviewCssResources)')
    expect(build).not.toContain("cssCodeSplit:")
  })
})
