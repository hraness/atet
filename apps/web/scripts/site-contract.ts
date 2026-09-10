import assert from "node:assert/strict"
import { createHash } from "node:crypto"

export type SiteArtifact = Readonly<{ bytes: number; path: string; sha256: string }>
export type SiteFoundation = Readonly<{
  cssPath: string
  privateScriptPath: string
  artifacts: readonly SiteArtifact[]
}>

type SitePackage = Readonly<{ manifestSha256: string; name: string; version: string }>

export const siteSha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex")

const foundationRoot = "graphs/site-foundation/"
const maxArtifactBytes = 16 * 1024 * 1024
const releases = [
  { name: "@hraness/design-kit", version: "0.5.2" },
  { name: "@hraness/site-footer", version: "0.6.1" },
  { name: "@hraness/ui", version: "0.5.7" },
] as const

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "Expected a site artifact record")
  return value as Record<string, unknown>
}

function digest(value: unknown): string {
  assert.ok(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value), "Invalid site artifact digest")
  return value
}

function artifact(value: unknown): SiteArtifact {
  const item = record(value)
  assert.deepEqual(Object.keys(item).sort(), ["bytes", "path", "sha256"])
  assert.ok(typeof item.bytes === "number" && Number.isSafeInteger(item.bytes) && item.bytes >= 0 && item.bytes <= maxArtifactBytes,
    "Invalid site artifact byte length")
  assert.ok(typeof item.path === "string" && item.path.length <= 512
    && item.path.split("/").every(part => part !== "." && part !== ".." && /^[A-Za-z0-9_.-]+$/u.test(part)), "Unsafe site artifact path")
  return { bytes: item.bytes, path: item.path, sha256: digest(item.sha256) }
}

function sorted(items: readonly SiteArtifact[]): SiteArtifact[] {
  return [...items].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
}

function packages(value: unknown, order: "identity" | "name"): SitePackage[] {
  assert.ok(Array.isArray(value) && value.length === releases.length, "Site generation requires all three reviewed packages")
  const identities = value.map(value => {
    const item = record(value)
    assert.deepEqual(Object.keys(item).sort(), ["manifestSha256", "name", "version"])
    const release = releases.find(release => release.name === item.name)
    assert.ok(release, "Unexpected site package name")
    assert.equal(item.version, release.version, "Site package release changed")
    return { manifestSha256: digest(item.manifestSha256), name: release.name, version: release.version }
  })
  assert.equal(new Set(identities.map(item => item.name)).size, releases.length, "Duplicate site package name")
  const byName = [...identities].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  if (order === "identity") {
    // The finalizer sorts canonical identity JSON, beginning with the digest.
    // These parsed scalar records already have canonical key order.
    const serialized = identities.map(item => JSON.stringify(item))
    assert.deepEqual(serialized, [...serialized].sort(), "Site packages must use canonical identity order")
  } else {
    assert.deepEqual(identities, byName, "Captured site packages must use canonical name order")
  }
  return byName
}

function capturedFoundation(value: SiteFoundation): SiteArtifact[] {
  const input = record(value)
  assert.deepEqual(Object.keys(input).sort(), ["artifacts", "cssPath", "privateScriptPath"])
  assert.ok(Array.isArray(input.artifacts) && input.artifacts.length === 15)
  const artifacts = sorted(input.artifacts.map(artifact))
  assert.equal(new Set(artifacts.map(item => item.path)).size, artifacts.length, "Duplicate captured site foundation output")
  const scripts = artifacts.filter(item => /^assets\/site-foundation-[A-Za-z0-9_-]+\.js$/u.test(item.path))
  const css = artifacts.filter(item => /^assets\/[A-Za-z0-9_.-]+\.css$/u.test(item.path))
  const fonts = artifacts.filter(item => /^assets\/[A-Za-z0-9_.-]+\.woff2$/u.test(item.path))
  assert.equal(scripts.length, 1, "Site foundation requires one captured private entry")
  assert.equal(css.length, 1, "Site foundation requires one captured stylesheet")
  assert.equal(fonts.length, 13, "Site foundation requires thirteen captured fonts")
  assert.equal(input.privateScriptPath, `${foundationRoot}${scripts[0]!.path}`)
  assert.equal(input.cssPath, `${foundationRoot}${css[0]!.path}`)
  return artifacts.map(item => ({ ...item, path: `${foundationRoot}${item.path}` }))
}

/** Bind the actual Vite output before finalization, including local font bytes. */
export function snapshotSiteFoundation(value: unknown, fontHashes: readonly string[], entrypoint: string,
  inspectCss: (source: string, filename: string) => readonly string[]): SiteFoundation {
  assert.equal(fontHashes.length, 13)
  fontHashes.forEach(digest)
  assert.equal(new Set(fontHashes).size, 13, "Site foundation font inputs must be distinct")
  const results = Array.isArray(value) ? value : [value]
  assert.equal(results.length, 1, "Site foundation requires one Vite output")
  const output = record(results[0]).output
  assert.ok(Array.isArray(output) && output.length === 15, "Site foundation must emit one private entry, one CSS asset and thirteen WOFF2 assets")
  const chunks = output.map(record).filter(item => item.type === "chunk")
  assert.equal(chunks.length, 1, "Site foundation requires exactly one captured private entry")
  const chunk = chunks[0]!
  assert.equal(chunk.isEntry, true)
  assert.equal(chunk.facadeModuleId, entrypoint, "Site foundation entry ownership changed")
  for (const field of ["imports", "dynamicImports", "exports"] as const) {
    assert.deepEqual(chunk[field], [], "Site foundation entry must not import or export executable modules")
  }
  assert.ok(typeof chunk.fileName === "string" && /^assets\/site-foundation-[A-Za-z0-9_-]+\.js$/u.test(chunk.fileName))
  assert.ok(typeof chunk.code === "string" && Buffer.byteLength(chunk.code) <= 1024)
  // A CSS-importing source entry may emit whitespace or an empty-module marker,
  // but its captured graph evidence is never a public executable asset.
  assert.match(chunk.code, /^\s*(?:export\s*\{\s*\}\s*;?\s*)?$/u, "Site foundation private entry acquired executable behavior")
  const artifacts = sorted(output.map(value => {
    const item = record(value)
    assert.ok(item.type === "asset" || item === chunk, "Unknown site foundation output role")
    const content = item.type === "chunk" ? item.code : item.source
    assert.ok(typeof content === "string" || content instanceof Uint8Array)
    const byteLength = typeof content === "string" ? Buffer.byteLength(content) : content.byteLength
    assert.ok(byteLength <= maxArtifactBytes, "Site foundation asset exceeds its byte bound")
    return artifact({ bytes: byteLength, path: item.fileName, sha256: siteSha256(content) })
  }))
  assert.equal(new Set(artifacts.map(item => item.path)).size, artifacts.length, "Duplicate site foundation output")
  assert.ok(artifacts.every(item => item.path === chunk.fileName || /^assets\/[A-Za-z0-9_.-]+\.(?:css|woff2)$/u.test(item.path)),
    "Unexpected site foundation output role")
  const css = artifacts.filter(item => item.path.endsWith(".css"))
  assert.equal(css.length, 1)
  const fonts = artifacts.filter(item => item.path.endsWith(".woff2"))
  assert.deepEqual(fonts.map(item => item.sha256).sort(), [...fontHashes].sort(), "Emitted site fonts differ from installed approved font inputs")
  const cssOutput = output.map(record).find(item => item.fileName === css[0]!.path)!
  const cssSource = typeof cssOutput.source === "string" ? cssOutput.source : new TextDecoder("utf-8", { fatal: true }).decode(cssOutput.source as Uint8Array)
  const urls = inspectCss(cssSource, css[0]!.path)
  assert.deepEqual(urls.map(url => {
    assert.match(url, /^(?:\.\/)?[A-Za-z0-9_-]+\.woff2$/u, "Site foundation must use canonical local emitted WOFF2 URLs")
    return `assets/${url.replace(/^\.\//u, "")}`
  }).sort(), fonts.map(item => item.path).sort(), "Site stylesheet must link every captured font exactly once")
  const foundation = { artifacts, cssPath: `${foundationRoot}${css[0]!.path}`, privateScriptPath: `${foundationRoot}${chunk.fileName}` }
  capturedFoundation(foundation)
  return foundation
}

/** Publish sealed documents and styles without rewriting generated bytes.
 * Private renderer modules and generation evidence never become site assets. */
export function projectSiteArtifacts(value: unknown, expected: Readonly<{
  compilerSha256: string
  unionPolicySha256: string
  planSha256: string
  packages: readonly SitePackage[]
  finalCssPath: string
  foundation: SiteFoundation
}>): readonly SiteArtifact[] {
  const complete = record(value)
  assert.deepEqual(Object.keys(complete).sort(), ["artifacts", "compilerSha256", "finalCss", "generationId", "graphs", "kind", "packages", "planSha256", "schemaVersion", "state", "unionPolicySha256"])
  assert.equal(complete.kind, "hraness-stylex-complete-generation")
  assert.equal(complete.state, "complete")
  assert.equal(complete.schemaVersion, 2)
  assert.equal(complete.generationId, "slopcamera-site-shell")
  for (const key of ["compilerSha256", "unionPolicySha256", "planSha256"] as const) assert.equal(complete[key], digest(expected[key]))
  assert.ok(Array.isArray(complete.graphs) && complete.graphs.length === 2)
  assert.deepEqual(complete.graphs.map(value => {
    const graph = record(value)
    assert.deepEqual(Object.keys(graph).sort(), ["id", "receiptSha256"])
    digest(graph.receiptSha256)
    return graph.id
  }).sort(), ["site-foundation", "site-renderer"])
  assert.deepEqual(packages(complete.packages, "identity"), packages(expected.packages, "name"), "Site package manifest changed")
  assert.ok(Array.isArray(complete.artifacts) && complete.artifacts.length >= 18 && complete.artifacts.length <= 64)
  const artifacts = complete.artifacts.map(artifact)
  assert.equal(new Set(artifacts.map(item => item.path)).size, artifacts.length, "Duplicate finalized site artifact")
  const finalCss = artifact(complete.finalCss)
  assert.match(expected.finalCssPath, /^assets\/site-[a-f0-9]{64}\.css$/u)
  assert.equal(finalCss.path, expected.finalCssPath)
  // The completion schema addresses final CSS separately from graph artifacts.
  assert.ok(artifacts.every(item => item.path !== finalCss.path), "Final site CSS must not be duplicated in graph artifacts")
  assert.ok(artifacts.reduce((sum, item) => sum + item.bytes, finalCss.bytes) <= 64 * 1024 * 1024,
    "Site generation exceeds its aggregate byte bound")
  const captured = capturedFoundation(expected.foundation)
  assert.deepEqual(sorted(artifacts.filter(item => item.path.startsWith(foundationRoot))), captured,
    "Finalized site foundation differs from captured Vite output")
  const allowed = new Set(["404.html", "index.html", finalCss.path,
    ...captured.filter(item => item.path !== expected.foundation.privateScriptPath).map(item => item.path)])
  let rendererEntries = 0
  const publicArtifacts = [...artifacts, finalCss].filter(item => {
    if (allowed.has(item.path)) return true
    if (item.path === expected.foundation.privateScriptPath) return false
    if (/^graphs\/site-renderer\/entries\/site-renderer-[A-Za-z0-9_-]+\.js$/u.test(item.path)) {
      rendererEntries += 1
      return false
    }
    assert.match(item.path, /^graphs\/site-renderer\/chunks\/[A-Za-z0-9_.-]+\.js$/u, "Unexpected private site output")
    return false
  })
  assert.equal(rendererEntries, 1, "Site generation requires one captured renderer entry")
  assert.equal(publicArtifacts.length, 17)
  for (const path of allowed) assert.ok(publicArtifacts.some(item => item.path === path), `Missing public site artifact: ${path}`)
  return sorted(publicArtifacts)
}
