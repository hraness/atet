import assert from "node:assert/strict"
import { join } from "node:path"
import { checkMarketingSnapshot } from "../vendor/marketing-preset/check.mjs"
import { readPreviewFile } from "./preview-file"
import { siteSha256 } from "./site-contract"

/** Read only the canonical checker's finite, byte-verified snapshot inventory. */
export async function snapshotMarketingPreset(directory: string) {
  const manifest = await checkMarketingSnapshot(directory)
  const files = new Map<string, Uint8Array>()
  for (const [path, receipt] of Object.entries(manifest.files)) {
    const bytes = await readPreviewFile(join(directory, path), 2 * 1024 * 1024)
    assert.equal(siteSha256(bytes), receipt.sha256, "Marketing snapshot changed after admission")
    files.set(path, bytes)
  }
  return { files, sourceCommit: manifest.source.commit }
}
