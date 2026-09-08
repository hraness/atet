import assert from "node:assert/strict"
import { transform } from "lightningcss"

/** Inspect, but never rewrite, the captured emitted stylesheet. Dependency
 * analysis includes image-set strings that the parser's Url visitor omits. */
export function inspectPreviewCssResources(source: string, filename: string): readonly string[] {
  assert.ok(Buffer.byteLength(source) <= 16 * 1024 * 1024)
  const result = transform({
    code: Buffer.from(source), filename, minify: false, analyzeDependencies: true,
  })
  assert.equal(result.warnings.length, 0, "Preview CSS parser emitted warnings")
  assert.ok(result.dependencies !== null && result.dependencies !== undefined && result.dependencies.length <= 64,
    "Preview foundation has an invalid or excessive resource inventory")
  return result.dependencies.map(dependency => {
    assert.equal(dependency.type, "url", "Preview foundation has an unresolved stylesheet import or unsupported resource")
    assert.ok("url" in dependency && typeof dependency.url === "string")
    return dependency.url
  })
}
