import assert from "node:assert/strict"
import { constants } from "node:fs"
import { access, realpath, writeFile } from "node:fs/promises"
import { delimiter, isAbsolute, join } from "node:path"
import { workerDriverLimit } from "./preview-browser-protocol"

export function previewNodeCandidates(environment: Readonly<Record<string, string | undefined>>): readonly string[] {
  if (environment.NODE_EXECUTABLE_PATH !== undefined) {
    assert.ok(isAbsolute(environment.NODE_EXECUTABLE_PATH), "NODE_EXECUTABLE_PATH must name an absolute Node executable")
    return [environment.NODE_EXECUTABLE_PATH]
  }
  return [...new Set((environment.PATH ?? "").split(delimiter).filter(path => isAbsolute(path)).map(path => join(path, "node")))]
}

export async function findPreviewNode(): Promise<string> {
  for (const candidate of previewNodeCandidates(process.env)) {
    try { await access(candidate, constants.X_OK); return await realpath(candidate) } catch { /* Try the next explicit PATH entry. */ }
  }
  throw new Error("Node 24 is required for Playwright; set NODE_EXECUTABLE_PATH")
}

export async function buildPreviewBrowserDriver(appDirectory: string, profile: string): Promise<{ readonly path: string; readonly bytes: Uint8Array }> {
  assert.equal(Bun.version, "1.3.14")
  assert.equal(await realpath(appDirectory), appDirectory)
  assert.equal(await realpath(profile), profile)
  const result = await Bun.build({ entrypoints: [join(appDirectory, "scripts/preview-browser-driver.ts")],
    env: "disable", format: "esm", minify: false, sourcemap: "none", target: "node", packages: "external" })
  assert.ok(result.success && result.outputs.length === 1, `Could not build Node preview driver: ${result.logs.map(log => log.message).join("\n")}`)
  const bytes = new Uint8Array(await result.outputs[0]!.arrayBuffer())
  assert.ok(bytes.byteLength > 0 && bytes.byteLength <= workerDriverLimit, "Excessive private worker bundle")
  const source = Buffer.from(bytes).toString()
  assert.ok(!/\bBun\s*\.|["'](?:bun|@hraness\/direct)(?:["'/])/u.test(source), "Node driver contains a Bun or Direct runtime edge")
  const path = join(profile, "preview-browser-driver.mjs")
  await writeFile(path, bytes, { flag: "wx", mode: 0o600 })
  return { path, bytes }
}
