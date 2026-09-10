import assert from "node:assert/strict"
import { createHash } from "node:crypto"

export type PreviewArtifact = Readonly<{ bytes: number; path: string; sha256: string }>
export type PreviewFoundation = Readonly<{
  cssPath: string
  privateScriptPath: string
  artifacts: readonly PreviewArtifact[]
}>
export const previewSha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex")

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "Expected a preview artifact record")
  return value as Record<string, unknown>
}

function digest(value: unknown): string {
  assert.ok(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value), "Invalid preview artifact digest")
  return value
}

function artifact(value: unknown): PreviewArtifact {
  const item = record(value)
  assert.deepEqual(Object.keys(item).sort(), ["bytes", "path", "sha256"])
  assert.ok(typeof item.bytes === "number" && Number.isSafeInteger(item.bytes) && item.bytes >= 0 && item.bytes <= 16 * 1024 * 1024)
  assert.ok(typeof item.path === "string" && item.path.length <= 512
    && item.path.split("/").every(part => part !== "." && part !== ".." && /^[A-Za-z0-9_.-]+$/u.test(part)), "Unsafe preview artifact path")
  return { bytes: item.bytes, path: item.path, sha256: digest(item.sha256) }
}

function sorted(items: readonly PreviewArtifact[]): PreviewArtifact[] {
  return [...items].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

/** Bind the actual public Vite RollupOutput, including every approved font. */
export function snapshotPreviewFoundation(value: unknown, fontHashes: readonly string[], entrypoint: string,
  inspectCss: (source: string, filename: string) => readonly string[]): PreviewFoundation {
  assert.equal(fontHashes.length, 13)
  fontHashes.forEach(digest)
  const results = Array.isArray(value) ? value : [value]
  assert.equal(results.length, 1, "Preview foundation requires one Vite output")
  const output = record(results[0]).output
  assert.ok(Array.isArray(output) && output.length === 15, "Preview foundation must emit one private entry, one CSS asset and thirteen WOFF2 assets")
  const chunks = output.map(record).filter(item => item.type === "chunk")
  assert.equal(chunks.length, 1, "Preview foundation requires exactly one captured private entry")
  const chunk = chunks[0]!
  assert.equal(chunk.isEntry, true)
  assert.equal(chunk.facadeModuleId, entrypoint, "Preview foundation entry ownership changed")
  for (const field of ["imports", "dynamicImports", "exports"] as const) assert.deepEqual(chunk[field], [], "Preview foundation entry must not import or export executable modules")
  assert.ok(typeof chunk.fileName === "string" && /^assets\/preview-foundation-[A-Za-z0-9_-]+\.js$/u.test(chunk.fileName))
  assert.ok(typeof chunk.code === "string" && Buffer.byteLength(chunk.code) <= 1024)
  // With only a CSS import in this non-HTML source entry,
  // Vite may emit whitespace or an empty-module marker, never executable logic.
  assert.match(chunk.code, /^\s*(?:export\s*\{\s*\}\s*;?\s*)?$/u, "Preview foundation private entry acquired executable behavior")
  const artifacts = sorted(output.map(value => {
    const item = record(value)
    assert.ok(item.type === "asset" || item === chunk, "Unknown preview foundation output role")
    const content = item.type === "chunk" ? item.code : item.source
    assert.ok(typeof content === "string" || content instanceof Uint8Array)
    const source = typeof content === "string" ? Buffer.from(content) : content
    return artifact({ bytes: source.byteLength, path: item.fileName, sha256: previewSha256(source) })
  }))
  assert.equal(new Set(artifacts.map(item => item.path)).size, artifacts.length, "Duplicate preview foundation output")
  assert.ok(artifacts.every(item => item.path === chunk.fileName || /^assets\/[A-Za-z0-9_.-]+\.(?:css|woff2)$/u.test(item.path)), "Unexpected preview foundation output role")
  const css = artifacts.filter(item => item.path.endsWith(".css"))
  assert.equal(css.length, 1)
  assert.deepEqual(artifacts.filter(item => item.path.endsWith(".woff2")).map(item => item.sha256).sort(), [...fontHashes].sort(), "Emitted preview fonts differ from installed approved font inputs")
  const cssOutput = output.map(record).find(item => item.fileName === css[0]!.path)!
  const cssSource = typeof cssOutput.source === "string" ? cssOutput.source : new TextDecoder("utf-8", { fatal: true }).decode(cssOutput.source as Uint8Array)
  const urls = inspectCss(cssSource, css[0]!.path)
  assert.deepEqual(urls.map(url => {
    assert.match(url, /^(?:\.\/)?[A-Za-z0-9_-]+\.woff2$/u, "Preview foundation must use canonical local emitted WOFF2 URLs")
    return `assets/${url.replace(/^\.\//u, "")}`
  }).sort(), artifacts.filter(item => item.path.endsWith(".woff2")).map(item => item.path).sort(), "Preview stylesheet must link every captured font exactly once")
  return { artifacts, cssPath: `graphs/preview-foundation/${css[0]!.path}`, privateScriptPath: `graphs/preview-foundation/${chunk.fileName}` }
}

/** Project a finalized generation without repackaging or rewriting its bytes.
 * Renderer modules, graph receipts and source maps never become site assets. */
export function projectPreviewArtifacts(value: unknown, expected: Readonly<{
  compilerSha256: string
  unionPolicySha256: string
  planSha256: string
  manifestSha256: string
  finalCssPath: string
  foundation: PreviewFoundation
}>): readonly PreviewArtifact[] {
  const complete = record(value)
  assert.deepEqual(Object.keys(complete).sort(), ["artifacts", "compilerSha256", "finalCss", "generationId", "graphs", "kind", "packages", "planSha256", "schemaVersion", "state", "unionPolicySha256"])
  assert.equal(complete.kind, "hraness-stylex-complete-generation")
  assert.equal(complete.state, "complete")
  assert.equal(complete.schemaVersion, 2)
  assert.equal(complete.generationId, "slopcamera-preview")
  for (const key of ["compilerSha256", "unionPolicySha256", "planSha256"] as const) assert.equal(complete[key], digest(expected[key]))
  assert.ok(Array.isArray(complete.graphs) && complete.graphs.length === 2)
  assert.deepEqual(complete.graphs.map(value => {
    const graph = record(value)
    assert.deepEqual(Object.keys(graph).sort(), ["id", "receiptSha256"])
    digest(graph.receiptSha256)
    return graph.id
  }).sort(), ["preview-foundation", "preview-renderer"])
  assert.deepEqual(complete.packages, [{ manifestSha256: digest(expected.manifestSha256), name: "@hraness/ui", version: "0.5.7" }])
  assert.ok(Array.isArray(complete.artifacts) && complete.artifacts.length >= 17 && complete.artifacts.length <= 63)
  const artifacts = complete.artifacts.map(artifact)
  assert.equal(new Set(artifacts.map(item => item.path)).size, artifacts.length)
  const finalCss = artifact(complete.finalCss)
  assert.match(expected.finalCssPath, /^assets\/preview-[a-f0-9]{64}\.css$/u)
  assert.equal(finalCss.path, expected.finalCssPath)
  // The public completion schema keeps finalCss separate from artifacts.
  assert.ok(artifacts.every(item => item.path !== finalCss.path), "Final preview CSS must not be duplicated in graph artifacts")
  assert.ok(artifacts.reduce((sum, item) => sum + item.bytes, finalCss.bytes) <= 64 * 1024 * 1024)
  const captured = sorted(expected.foundation.artifacts.map(item => ({ ...item, path: `graphs/preview-foundation/${item.path}` })))
  assert.deepEqual(sorted(artifacts.filter(item => item.path.startsWith("graphs/preview-foundation/"))), captured, "Finalized preview foundation differs from captured Vite output")
  assert.equal(captured.filter(item => item.path === expected.foundation.privateScriptPath && item.path.endsWith(".js")).length, 1)
  const allowed = new Set(["preview.html", finalCss.path, ...captured.filter(item => item.path !== expected.foundation.privateScriptPath).map(item => item.path)])
  const publicArtifacts = [...artifacts, finalCss].filter(item => {
    if (allowed.has(item.path)) return true
    if (item.path === expected.foundation.privateScriptPath) return false
    assert.match(item.path, /^graphs\/preview-renderer\/(?:entries|chunks)\/[A-Za-z0-9_.-]+\.js$/u, "Unexpected private preview output")
    return false
  })
  assert.equal(publicArtifacts.length, 16)
  for (const path of allowed) assert.ok(publicArtifacts.some(item => item.path === path))
  return sorted(publicArtifacts)
}
