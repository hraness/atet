/** Explicit opt-in, free public qualification; no credentials or native source execution. */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createPolyHavenAssetService } from "./poly-haven";
import { assetJson } from "./contracts";

const root = process.argv[2];
if (root === undefined || !root.startsWith("/")) throw new Error("Provide a fresh absolute ignored qualification directory.");
const directory = resolve(root);
await mkdir(directory, { mode: 0o700 });
const service = createPolyHavenAssetService({ storageRoot: directory, signal: AbortSignal.timeout(300_000) });
const search = await service.search({ provider: "poly-haven", query: "sunset", type: "hdris", limit: 1 });
await writeFile(`${directory}/search.json`, assetJson(search), { flag: "wx", mode: 0o600 });
const samples = [
  { provider: "poly-haven", assetId: "venice_sunset", kind: "hdri", resolution: "1k", format: "hdr", maximumTotalBytes: 20 * 1024 * 1024 },
  { provider: "poly-haven", assetId: "dirty_football", kind: "model", resolution: "1k", format: "gltf", maximumTotalBytes: 20 * 1024 * 1024 },
];
let bytes = 0;
const results = [];
for (const selection of samples) {
  const plan = await service.plan(selection);
  bytes += plan.totalBytes;
  if (bytes > 50 * 1024 * 1024) throw new Error("Qualification would exceed its 50 MiB free download budget.");
  const imported = await service.importAsset(plan);
  const offline = createPolyHavenAssetService({ storageRoot: directory, fetch: async () => { throw new Error("Completed replay must not use the network."); } });
  const replayed = await offline.importAsset(plan);
  if (replayed.disposition !== "reused" || replayed.receiptSha256 !== imported.receiptSha256) throw new Error("Completed asset replay differs from the verified import.");
  results.push({ assetId: selection.assetId, bytes: plan.totalBytes, sourceRoot: imported.sourceRoot, receiptPath: imported.receiptPath, receiptSha256: imported.receiptSha256, replay: replayed.disposition });
  console.log(`${selection.assetId}: ${plan.files.length} exact files, ${plan.totalBytes} bytes, verified offline replay`);
}
await writeFile(`${directory}/qualification.json`, assetJson({ provider: "poly-haven", credit: "Powered by Poly Haven", actualDownloadBytes: bytes, authorizationMaximumBytes: 50 * 1024 * 1024, noCredentials: true, noSourceExecution: true, verification: "catalog sizes/MD5, local SHA256, glTF closure, immutable complete replay", results }), { flag: "wx", mode: 0o600 });
