import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { StudioPathSchema } from "../../../../src/studio";
import { deepFreezeJson } from "../../../../src/code/json-snapshot";
import { createNodeBundleFileSystem } from "../../core/storage";
import { ensurePhysicalPrivateDirectoryWithin } from "../../cli/paths";
import { inventoryStudioFiles, readStudioBytes } from "../../cli/studio-files";
import { ASSET_LIMITS, AssetIdSchema, POLY_HAVEN, assetJson, captureAssetJson, capturePolyHavenSnapshots, describePolyHavenAsset, parseAssetSearch, parseAssetSelection, parsePolyHavenAssetPlan, planPolyHavenAsset, type AssetPlannedFile, type PolyHavenAssetPlan } from "./contracts";
import { createPolyHavenNetwork, type AssetFetch } from "./network";

const hash = (algorithm: "md5" | "sha256", bytes: Uint8Array): string => createHash(algorithm).update(bytes).digest("hex");
const absent = (error: unknown): boolean => error instanceof Error && "code" in error && error.code === "ENOENT";
export interface ImportedAssetFile extends AssetPlannedFile { readonly sha256: string }
export interface PolyHavenAssetReceipt {
  readonly kind: "atet.studio-asset-import"; readonly schemaVersion: 1; readonly provider: "poly-haven"; readonly planSha256: string;
  readonly asset: PolyHavenAssetPlan["asset"]; readonly license: PolyHavenAssetPlan["license"]; readonly credit: string; readonly apiTermsUrl: string;
  readonly files: readonly ImportedAssetFile[]; readonly totalBytes: number; readonly sourceDirectory: "source"; readonly verification: "catalog-md5-and-local-sha256";
}
function fileChecks(file: AssetPlannedFile, bytes: Buffer): void {
  if (bytes.length !== file.bytes || hash("md5", bytes) !== file.md5) throw new Error("Downloaded asset differs from its selected catalog size or MD5.");
  const extension = file.path.split(".").at(-1);
  const valid = extension === "bin" || extension === "gltf" || extension === "png" && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || (extension === "jpg" || extension === "jpeg") && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    || extension === "exr" && bytes.subarray(0, 4).equals(Buffer.from([0x76, 0x2f, 0x31, 0x01]))
    || extension === "hdr" && /^(?:#\?RADIANCE|#\?RGBE)\r?\n/u.test(bytes.subarray(0, 32).toString("ascii"));
  if (!valid) throw new Error("Asset file signature differs from its selected format.");
}
export function validateGltfAssetClosure(bytes: Uint8Array, planInput: unknown): void {
  const plan = parsePolyHavenAssetPlan(planInput);
  if (plan.selection.kind !== "model" || bytes.byteLength > ASSET_LIMITS.jsonBytes) throw new Error("glTF source exceeds the supported JSON profile.");
  const raw = captureAssetJson(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  const document = z.object({ asset: z.object({ version: z.literal("2.0") }), buffers: z.array(z.object({ uri: z.string(), byteLength: z.number().int().positive() })).max(64).default([]), images: z.array(z.object({ uri: z.string() })).max(64).default([]), extensionsUsed: z.array(z.string()).max(32).default([]), extensionsRequired: z.array(z.string()).max(32).default([]) }).parse(raw);
  const allowed = new Set(["KHR_materials_ior", "KHR_materials_specular", "KHR_materials_transmission", "KHR_materials_volume", "KHR_materials_clearcoat", "KHR_materials_sheen", "KHR_materials_emissive_strength", "KHR_materials_unlit", "KHR_texture_transform", "KHR_mesh_quantization"]);
  if ([...document.extensionsUsed, ...document.extensionsRequired].some(name => !allowed.has(name))) throw new Error("glTF uses an extension outside the supported asset profile.");
  function inspect(value: unknown, path: string): void {
    if (Array.isArray(value)) { value.forEach((item, index) => inspect(item, `${path}/${index}`)); return; }
    if (value === null || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "uri" && !/^\/(?:images|buffers)\/\d+$/u.test(path)) throw new Error("glTF contains a resource outside its supported buffer/image closure.");
      if (key === "extensions" && (item === null || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(name => !allowed.has(name)))) throw new Error("glTF contains an undeclared unsupported extension.");
      inspect(item, `${path}/${key}`);
    }
  }
  inspect(raw, "");
  const actual = new Set<string>(), expected = plan.files.filter(file => file.role === "dependency");
  for (const item of [...document.buffers, ...document.images]) {
    if (/[?#\\:]/u.test(item.uri) || /%2f|%5c/iu.test(item.uri)) throw new Error("glTF resource references must be local explicit paths.");
    const path = StudioPathSchema.parse(decodeURIComponent(item.uri));
    const file = expected.find(file => file.path === path);
    if (file === undefined || "byteLength" in item && item.byteLength !== file.bytes) throw new Error("glTF resource differs from its complete selected dependency closure.");
    actual.add(path);
  }
  if (expected.some(file => !actual.has(file.path))) throw new Error("glTF catalog contains an unreferenced dependency outside the source closure.");
}

export function createPolyHavenAssetService(options: { readonly storageRoot: string; readonly fetch?: AssetFetch; readonly signal?: AbortSignal; readonly beforePublication?: () => Promise<void> }) {
  const network = createPolyHavenNetwork(options);
  const storageRoot = options.storageRoot, cancellation = options.signal, beforePublication = options.beforePublication;
  async function fence(): Promise<void> {
    if (cancellation?.aborted) throw new Error("Poly Haven asset operation was cancelled.");
    await beforePublication?.();
    if (cancellation?.aborted) throw new Error("Poly Haven asset operation was cancelled.");
  }
  async function describe(assetIdInput: unknown) {
    const assetId = AssetIdSchema.parse(captureAssetJson(assetIdInput));
    const snapshots = capturePolyHavenSnapshots({ info: await network.json(`/info/${assetId}`), files: await network.json(`/files/${assetId}`) });
    const asset = describePolyHavenAsset(assetId, snapshots.info);
    return deepFreezeJson({ provider: POLY_HAVEN.provider, credit: POLY_HAVEN.credit, apiTermsUrl: POLY_HAVEN.termsUrl, asset, snapshots });
  }
  async function verify(directory: string, plan: PolyHavenAssetPlan, receiptInput?: unknown): Promise<PolyHavenAssetReceipt> {
    const fs = createNodeBundleFileSystem(directory), files: ImportedAssetFile[] = [];
    const inventory = await inventoryStudioFiles(join(directory, "source"), ASSET_LIMITS.files, plan.selection.maximumTotalBytes);
    if (inventory.length !== plan.files.length) throw new Error("Retained asset source closure contains missing or undeclared files.");
    for (const file of plan.files) {
      const integrity = await fs.inspectFile!(`source/${file.path}`, file.bytes);
      const bytes = await readStudioBytes(join(directory, "source", file.path), integrity, ASSET_LIMITS.fileBytes);
      fileChecks(file, bytes);
      if (file.role === "model") validateGltfAssetClosure(bytes, plan);
      files.push({ ...file, sha256: integrity.sha256 });
    }
    const receipt: PolyHavenAssetReceipt = { kind: "atet.studio-asset-import", schemaVersion: 1, provider: "poly-haven", planSha256: plan.planSha256, asset: plan.asset, license: plan.license, credit: plan.credit, apiTermsUrl: plan.apiTermsUrl, files, totalBytes: plan.totalBytes, sourceDirectory: "source", verification: "catalog-md5-and-local-sha256" };
    if (receiptInput !== undefined && assetJson(captureAssetJson(receiptInput)) !== assetJson(receipt)) throw new Error("Retained asset receipt conflicts with its verified source files.");
    await fence();
    return deepFreezeJson(receipt);
  }
  return {
    async search(input: unknown) {
      const query = parseAssetSearch(input);
      const result = z.object({ query: z.string().max(100), type: z.string(), total: z.number().int().nonnegative(), results: z.array(z.object({ slug: AssetIdSchema, score: z.number().finite().min(-1).max(1) })).max(20) }).parse(captureAssetJson(await network.json("/search", new URLSearchParams({ q: query.query, t: query.type, limit: String(query.limit) }))));
      if (result.results.length > query.limit || result.query !== query.query || result.type !== query.type || new Set(result.results.map(item => item.slug)).size !== result.results.length) throw new Error("Poly Haven search differs from its bounded request.");
      const items = [];
      for (const resultItem of result.results) {
        const asset = describePolyHavenAsset(resultItem.slug, await network.json(`/info/${resultItem.slug}`));
        if (query.type !== "all" && asset.type !== query.type) throw new Error("Poly Haven search returned an asset outside the requested type.");
        items.push({ ...asset, score: resultItem.score });
      }
      return deepFreezeJson({ provider: POLY_HAVEN.provider, credit: POLY_HAVEN.credit, apiTermsUrl: POLY_HAVEN.termsUrl, query, total: result.total, items });
    },
    describe,
    async plan(input: unknown): Promise<PolyHavenAssetPlan> {
      const selection = parseAssetSelection(input), found = await describe(selection.assetId);
      return planPolyHavenAsset(selection, found.snapshots);
    },
    async importAsset(input: unknown) {
      const plan = parsePolyHavenAssetPlan(input);
      await fence();
      const root = resolve(storageRoot), details = await lstat(root);
      if (!details.isDirectory() || details.isSymbolicLink() || await realpath(root) !== root) throw new Error("Asset storage requires an existing physical root.");
      const relative = `imports/${plan.planSha256}`, directory = await ensurePhysicalPrivateDirectoryWithin(root, relative), fs = createNodeBundleFileSystem(root);
      await ensurePhysicalPrivateDirectoryWithin(directory, "source");
      await fs.writeTextNoReplace!(`${relative}/plan.json`, assetJson(plan), fence);
      if (await fs.readText(`${relative}/plan.json`) !== assetJson(plan)) throw new Error("Retained asset plan conflicts with the requested plan.");
      const retained = await fs.readText(`${relative}/receipt.json`).catch(error => { if (absent(error)) return undefined; throw error; });
      if (retained !== undefined) {
        const receipt = await verify(directory, plan, JSON.parse(retained));
        return deepFreezeJson({ disposition: "reused" as const, receipt, receiptPath: `${relative}/receipt.json`, sourceRoot: join(directory, "source"), receiptSha256: hash("sha256", Buffer.from(assetJson(receipt))) });
      }
      for (const file of [...plan.files].sort((a, b) => Number(b.role === "model") - Number(a.role === "model"))) {
        await fence();
        const destination = `${relative}/source/${file.path}`;
        const existing = await fs.inspectFile!(destination, file.bytes).catch(error => { if (absent(error)) return undefined; throw error; });
        if (existing !== undefined) {
          const bytes = await readStudioBytes(join(root, destination), existing, ASSET_LIMITS.fileBytes);
          fileChecks(file, bytes);
          if (file.role === "model") validateGltfAssetClosure(bytes, plan);
          continue;
        }
        const bytes = await network.file(file.url, file.bytes);
        fileChecks(file, bytes);
        if (file.role === "model") validateGltfAssetClosure(bytes, plan);
        const staging = `staging/${randomUUID()}`, stage = await ensurePhysicalPrivateDirectoryWithin(root, staging);
        const handle = await open(join(stage, "download"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        // Keep the exact downloaded stage as recoverable evidence. The source copy
        // uses shared inode-pinned, guarded, atomic no-replace publication.
        await fs.copyFileNoReplace!(`${staging}/download`, destination, { bytes: bytes.length, sha256: hash("sha256", bytes) }, fence);
      }
      const receipt = await verify(directory, plan);
      await fs.writeTextNoReplace!(`${relative}/receipt.json`, assetJson(receipt), fence);
      const winner = JSON.parse(await fs.readText(`${relative}/receipt.json`)) as unknown;
      const verified = await verify(directory, plan, winner);
      return deepFreezeJson({ disposition: "created" as const, receipt: verified, receiptPath: `${relative}/receipt.json`, sourceRoot: join(directory, "source"), receiptSha256: hash("sha256", Buffer.from(assetJson(verified))) });
    },
  };
}
