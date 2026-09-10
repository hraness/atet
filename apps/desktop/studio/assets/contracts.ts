import { z } from "zod";
import { canonicalJson, boundedCanonicalJsonSha256 } from "../../../../src/code/canonical-json";
import { createBoundedJsonValueSnapshot, deepFreezeJson } from "../../../../src/code/json-snapshot";
import { StudioPathSchema } from "../../../../src/studio";

export const POLY_HAVEN = Object.freeze({ provider: "poly-haven" as const, api: "https://api.polyhaven.com", download: "https://dl.polyhaven.org", credit: "Powered by Poly Haven", homepage: "https://polyhaven.com", license: "CC0-1.0", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/", termsUrl: "https://github.com/Poly-Haven/Public-API/blob/master/ToS.md", userAgent: "SLOPCAMERA/StudioAssets (+https://slop.camera)" });
export const ASSET_LIMITS = Object.freeze({ jsonBytes: 4 * 1024 * 1024, fileBytes: 128 * 1024 * 1024, totalBytes: 512 * 1024 * 1024, files: 64, requestMs: 120_000 });
export const AssetIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const text = z.string().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const resolution = z.enum(["1k", "2k", "4k"]);
const common = { provider: z.literal("poly-haven"), assetId: AssetIdSchema, resolution, maximumTotalBytes: z.number().int().min(1).max(ASSET_LIMITS.totalBytes).default(50 * 1024 * 1024) };
export const AssetSelectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.literal("hdri"), format: z.enum(["hdr", "exr"]) }),
  z.strictObject({ ...common, kind: z.literal("texture"), format: z.enum(["png", "jpg", "exr"]), maps: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/u)).min(1).max(16) }).refine(value => new Set(value.maps).size === value.maps.length, "Texture maps must be unique."),
  z.strictObject({ ...common, kind: z.literal("model"), format: z.literal("gltf") }),
]);
export type AssetSelection = z.infer<typeof AssetSelectionSchema>;
export const AssetSearchSchema = z.strictObject({ provider: z.literal("poly-haven"), query: z.string().trim().min(1).max(100).refine(value => !/[\u0000-\u001f\u007f]/u.test(value)).transform(value => value.toLowerCase()), type: z.enum(["all", "hdris", "textures", "models"]).default("all"), limit: z.number().int().min(1).max(20).default(8) });
export type AssetSearch = z.infer<typeof AssetSearchSchema>;
export function captureAssetJson(value: unknown): unknown {
  return createBoundedJsonValueSnapshot(value, ASSET_LIMITS.jsonBytes, "studio asset data", { maximumDepth: 24, maximumValues: 150_000 }).value;
}
export function parseAssetSelection(value: unknown): AssetSelection { return deepFreezeJson(AssetSelectionSchema.parse(captureAssetJson(value))); }
export function parseAssetSearch(value: unknown): AssetSearch { return deepFreezeJson(AssetSearchSchema.parse(captureAssetJson(value))); }
export const assetJson = (value: unknown): string => `${canonicalJson(value)}\n`;
export const assetHash = (value: unknown): string => boundedCanonicalJsonSha256(value, { maximumBytes: ASSET_LIMITS.jsonBytes });

export function downloadUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Invalid Poly Haven download URL.");
  const url = new URL(value);
  if (url.origin !== POLY_HAVEN.download || url.username || url.password || url.port || url.hash || url.search || !url.pathname.startsWith("/file/ph-assets/") || /%2f|%5c/iu.test(url.pathname)) throw new Error("Poly Haven downloads require the fixed HTTPS asset origin and path.");
  const path = decodeURIComponent(url.pathname.slice("/file/ph-assets/".length));
  StudioPathSchema.parse(path);
  if (url.href !== value) throw new Error("Poly Haven download URLs must be canonical.");
  return value;
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected Poly Haven object metadata.");
  return value as Record<string, unknown>;
}
function own(value: unknown, key: string): unknown {
  const object = record(value);
  if (!Object.hasOwn(object, key)) throw new Error("The selected Poly Haven variant is unavailable.");
  return object[key];
}
function validateMetadataUrls(value: unknown): void {
  if (Array.isArray(value)) { value.forEach(validateMetadataUrls); return; }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(url|thumbnail_url)$/u.test(key) && item !== null) {
      if (key === "url") downloadUrl(item);
      else {
        const url = new URL(z.string().max(2048).parse(item));
        if (url.origin !== "https://cdn.polyhaven.com" || url.username || url.password || url.port || url.hash || !url.pathname.startsWith("/asset_img/") || [...url.searchParams.keys()].some(key => !["width", "height", "v"].includes(key))) throw new Error("Unexpected Poly Haven thumbnail URL.");
      }
    }
    validateMetadataUrls(item);
  }
}
export function capturePolyHavenSnapshots(input: unknown): { readonly info: unknown; readonly files: unknown } {
  const captured = z.strictObject({ info: z.unknown(), files: z.unknown() }).parse(captureAssetJson(input));
  const snapshots = { info: record(captured.info), files: record(captured.files) };
  validateMetadataUrls(snapshots);
  return deepFreezeJson(snapshots);
}
export interface PolyHavenAsset { readonly assetId: string; readonly name: string; readonly type: "hdris" | "textures" | "models"; readonly authors: readonly { readonly name: string; readonly role: string }[]; readonly assetPage: string }
export function describePolyHavenAsset(assetIdInput: unknown, infoInput: unknown): PolyHavenAsset {
  const assetId = AssetIdSchema.parse(assetIdInput), info = record(captureAssetJson(infoInput));
  validateMetadataUrls(info);
  const type = z.number().int().min(0).max(2).parse(info.type), authors = record(info.authors);
  if (Object.keys(authors).length < 1 || Object.keys(authors).length > 64) throw new Error("Poly Haven author metadata is missing or exceeds its bound.");
  return deepFreezeJson({ assetId, name: text.parse(info.name), type: (["hdris", "textures", "models"] as const)[type]!, authors: Object.entries(authors).map(([name, role]) => ({ name: text.parse(name), role: text.parse(role) })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0), assetPage: `${POLY_HAVEN.homepage}/a/${assetId}` });
}
export interface AssetPlannedFile { readonly path: string; readonly url: string; readonly bytes: number; readonly md5: string; readonly role: "environment" | "texture" | "model" | "dependency"; readonly map?: string }
const sourceFile = z.object({ url: z.string(), size: z.number().int().positive().max(ASSET_LIMITS.fileBytes), md5: z.string().regex(/^[a-f0-9]{32}$/u), include: z.record(z.string(), z.unknown()).optional() });
function selectedFile(value: unknown, role: AssetPlannedFile["role"], pathInput?: string, map?: string): { file: AssetPlannedFile; includes: Record<string, unknown> } {
  const source = sourceFile.parse(value), url = downloadUrl(source.url);
  if (role === "model" && source.size > ASSET_LIMITS.jsonBytes) throw new Error("Selected glTF JSON exceeds its four MiB decode profile.");
  const basename = decodeURIComponent(new URL(url).pathname.split("/").at(-1)!);
  const path = StudioPathSchema.parse(pathInput ?? basename);
  const allowed = role === "model" ? /\.gltf$/u : role === "dependency" ? /\.(?:bin|png|jpg|jpeg)$/u : /\.(?:hdr|exr|png|jpg)$/u;
  if (!allowed.test(path) || !allowed.test(basename)) throw new Error("Unsupported asset file; archives and executable sources are not imported by this adapter.");
  return { file: { path, url, bytes: source.size, md5: source.md5, role, ...(map === undefined ? {} : { map }) }, includes: source.include ?? {} };
}
export interface PolyHavenAssetPlan {
  readonly kind: "slopcamera.studio-asset-plan"; readonly schemaVersion: 1; readonly provider: "poly-haven"; readonly selection: AssetSelection;
  readonly asset: PolyHavenAsset; readonly license: { readonly spdx: "CC0-1.0"; readonly url: string; readonly scope: "asset-files" };
  readonly credit: string; readonly apiTermsUrl: string; readonly snapshots: { readonly info: unknown; readonly files: unknown };
  readonly files: readonly AssetPlannedFile[]; readonly totalBytes: number; readonly planSha256: string;
}
export function planPolyHavenAsset(selectionInput: unknown, snapshotsInput: { readonly info: unknown; readonly files: unknown }): PolyHavenAssetPlan {
  const selection = parseAssetSelection(selectionInput), snapshots = capturePolyHavenSnapshots(snapshotsInput);
  const asset = describePolyHavenAsset(selection.assetId, snapshots.info);
  if (asset.type !== ({ hdri: "hdris", texture: "textures", model: "models" } as const)[selection.kind]) throw new Error("Selected asset kind differs from its provider metadata.");
  const files: AssetPlannedFile[] = [];
  for (const map of selection.kind === "texture" ? [...selection.maps].sort() : [selection.kind === "hdri" ? "hdri" : "gltf"]) {
    const variant = own(own(own(snapshots.files, map), selection.resolution), selection.format);
    const selected = selectedFile(variant, selection.kind === "hdri" ? "environment" : selection.kind, undefined, selection.kind === "texture" ? map : undefined);
    if (!selected.file.path.endsWith(`.${selection.format}`)) throw new Error("Selected asset format differs from its download filename.");
    files.push(selected.file);
    const includes = Object.entries(selected.includes);
    if (selection.kind !== "model" && includes.length > 0) throw new Error("The selected standalone map unexpectedly requires dependencies.");
    for (const [path, value] of includes) {
      const dependency = selectedFile(value, "dependency", path);
      if (Object.keys(dependency.includes).length > 0) throw new Error("Nested native dependencies require a separately supported import profile.");
      files.push(dependency.file);
    }
  }
  const paths = new Set<string>();
  for (const file of files) {
    const key = file.path.toLowerCase();
    if (paths.has(key)) throw new Error("Selected asset paths collide.");
    paths.add(key);
  }
  for (const path of paths) for (let offset = path.indexOf("/"); offset !== -1; offset = path.indexOf("/", offset + 1)) if (paths.has(path.slice(0, offset))) throw new Error("Selected asset uses a file as a directory.");
  const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
  if (files.length > ASSET_LIMITS.files || totalBytes > selection.maximumTotalBytes) throw new Error("Selected complete asset exceeds its explicit file or byte budget.");
  const body = { kind: "slopcamera.studio-asset-plan" as const, schemaVersion: 1 as const, provider: "poly-haven" as const, selection, asset, license: { spdx: "CC0-1.0" as const, url: POLY_HAVEN.licenseUrl, scope: "asset-files" as const }, credit: POLY_HAVEN.credit, apiTermsUrl: POLY_HAVEN.termsUrl, snapshots, files: files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), totalBytes };
  return deepFreezeJson({ ...body, planSha256: assetHash(body) });
}
export function parsePolyHavenAssetPlan(input: unknown): PolyHavenAssetPlan {
  const value = record(captureAssetJson(input));
  const snapshots = z.strictObject({ info: z.unknown(), files: z.unknown() }).parse(value.snapshots);
  digest.parse(value.planSha256);
  const derived = planPolyHavenAsset(value.selection, { info: snapshots.info, files: snapshots.files });
  if (canonicalJson(value) !== canonicalJson(derived)) throw new Error("Asset plan differs from its exact canonical provider snapshots and selection.");
  return derived;
}
