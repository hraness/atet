import assert from "node:assert/strict"
import { join } from "node:path"
import { checkLanternMaterialSnapshot } from "../vendor/lantern-material/check.mjs"
import { readPreviewFile } from "./preview-file"
import { siteSha256 } from "./site-contract"

/** Admit the complete immutable, asset-free material before the compiler reads it. */
export async function snapshotLanternMaterial(directory: string) {
  const manifest = await checkLanternMaterialSnapshot(directory)
  assert.equal(manifest.source.commit, "eccb0341d8d0ba960a0f02248cf59888062afb0a")
  const files = new Map<string, Uint8Array>()
  for (const [path, receipt] of Object.entries(manifest.files)) {
    const bytes = await readPreviewFile(join(directory, path), 128 * 1024)
    assert.equal(siteSha256(bytes), receipt.sha256, "Lantern material changed after admission")
    files.set(path, bytes)
  }
  return { files, sourceCommit: manifest.source.commit }
}
