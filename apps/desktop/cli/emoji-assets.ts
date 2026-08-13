import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import {
  APPLE_EMOJI_ASSET_ROOT,
  APPLE_EMOJI_CATALOG_PATH,
  APPLE_EMOJI_MANIFEST_PATH,
  EMOJI_ASSET_GENERATION_COMMAND,
} from "../core/emoji";
import { CliError } from "./errors";

export const EMOJI_GENERATION_COMMAND = EMOJI_ASSET_GENERATION_COMMAND;

export type EmojiVariant = "color" | "duotone";
export type EmojiAssetProvider = "apple-emoji-pack" | "brand-catalog";

interface EmojiCatalogItem {
  readonly emoji: string;
  readonly group: string;
  readonly id: string;
  readonly name: string;
  readonly sourcePngSha256: string;
  readonly subgroup: string;
}

interface EmojiManifestItem {
  readonly colorSvgSha256: string;
  readonly duotoneSvgSha256: string;
  readonly id: string;
  readonly sourcePngSha256: string;
}

interface EmojiCatalog {
  readonly fontSha256: string;
  readonly items: readonly EmojiCatalogItem[];
}

interface EmojiManifest {
  readonly catalogSha256: string;
  readonly fontSha256: string;
  readonly items: readonly EmojiManifestItem[];
}

interface BrandEmojiItem {
  readonly bytes: number;
  readonly codePointId: string;
  readonly domain: string;
  readonly emoji: string;
  readonly path: string;
  readonly sha256: string;
}

export interface EmojiAssetState {
  readonly assetRoot: string;
  readonly catalogCount: number;
  readonly catalogPath: string;
  readonly generationCommand: string;
  readonly installedCount: number;
  readonly manifestPath: string;
  readonly provenance: "checked" | "missing" | "invalid";
}

export interface EmojiSearchResult {
  readonly available: Readonly<Record<EmojiVariant, boolean>>;
  readonly emoji: string;
  readonly group: string;
  readonly id: string;
  readonly name: string;
  readonly provider: EmojiAssetProvider;
  readonly subgroup: string;
}

export interface ResolvedEmojiAsset extends EmojiSearchResult {
  readonly path: string;
  readonly sha256: string;
  readonly variant: EmojiVariant;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliError("invalid-data", "Emoji metadata must be a JSON object.");
  }
  return value as Readonly<Record<string, unknown>>;
}

function stringField(value: Readonly<Record<string, unknown>>, field: string): string {
  const item = value[field];
  if (typeof item !== "string" || item === "") {
    throw new CliError("invalid-data", `Emoji metadata field ${field} must be a non-empty string.`);
  }
  return item;
}

function arrayField(value: Readonly<Record<string, unknown>>, field: string): readonly unknown[] {
  const item = value[field];
  if (!Array.isArray(item)) {
    throw new CliError("invalid-data", `Emoji metadata field ${field} must be an array.`);
  }
  return item;
}

function integerField(value: Readonly<Record<string, unknown>>, field: string): number {
  const item = value[field];
  if (typeof item !== "number" || !Number.isSafeInteger(item) || item <= 0) {
    throw new CliError("invalid-data", `Emoji metadata field ${field} must be a positive safe integer.`);
  }
  return item;
}

function parseCatalog(value: unknown): EmojiCatalog {
  const root = record(value);
  const font = record(root.font);
  return {
    fontSha256: stringField(font, "sha256"),
    items: arrayField(root, "items").map((rawItem) => {
      const item = record(rawItem);
      return {
        emoji: stringField(item, "emoji"),
        group: stringField(item, "group"),
        id: stringField(item, "id"),
        name: stringField(item, "name"),
        sourcePngSha256: stringField(item, "sourcePngSha256"),
        subgroup: stringField(item, "subgroup"),
      };
    }),
  };
}

function parseManifest(value: unknown): EmojiManifest {
  const root = record(value);
  const provenance = record(root.provenance);
  return {
    catalogSha256: stringField(root, "catalogSha256"),
    fontSha256: stringField(provenance, "fontSha256"),
    items: arrayField(root, "items").map((rawItem) => {
      const item = record(rawItem);
      return {
        colorSvgSha256: stringField(item, "colorSvgSha256"),
        duotoneSvgSha256: stringField(item, "duotoneSvgSha256"),
        id: stringField(item, "id"),
        sourcePngSha256: stringField(item, "sourcePngSha256"),
      };
    }),
  };
}

async function fileSha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function paths(repositoryRoot: string): {
  readonly assetRoot: string;
  readonly catalogPath: string;
  readonly manifestPath: string;
} {
  return {
    assetRoot: join(repositoryRoot, APPLE_EMOJI_ASSET_ROOT),
    catalogPath: join(repositoryRoot, APPLE_EMOJI_CATALOG_PATH),
    manifestPath: join(repositoryRoot, APPLE_EMOJI_MANIFEST_PATH),
  };
}

function brandPaths(repositoryRoot: string): { readonly assetRoot: string; readonly manifestPath: string } {
  const assetRoot = join(repositoryRoot, "apps", "desktop", "assets", "brand-emoji");
  return { assetRoot, manifestPath: join(assetRoot, "manifest.json") };
}

async function readBrandItems(repositoryRoot: string): Promise<{
  readonly assetRoot: string;
  readonly items: readonly BrandEmojiItem[];
}> {
  const localPaths = brandPaths(repositoryRoot);
  let input: unknown;
  try {
    input = JSON.parse(await readFile(localPaths.manifestPath, "utf8")) as unknown;
  } catch (error) {
    throw new CliError("invalid-data", `Brand emoji manifest is unavailable or invalid: ${String(error)}`);
  }
  const manifest = record(input);
  if (manifest.formatVersion !== 1) throw new CliError("invalid-data", "Brand emoji manifest version must be 1.");
  const items = arrayField(manifest, "assets").map((raw): BrandEmojiItem => {
    const item = record(raw);
    const domain = stringField(item, "domain");
    const path = stringField(item, "path");
    const sha256 = stringField(item, "sha256");
    const codePointId = stringField(item, "codePointID");
    if (!/^[a-z0-9.-]+\.svg$/u.test(path) || path !== `${domain}.svg`) {
      throw new CliError("invalid-data", `Brand emoji asset path is invalid for ${domain}.`);
    }
    if (!/^[a-f0-9]{64}$/u.test(sha256) || !/^[a-f0-9]+(?:-[a-f0-9]+)*$/u.test(codePointId)) {
      throw new CliError("invalid-data", `Brand emoji hashes or code points are invalid for ${domain}.`);
    }
    return {
      bytes: integerField(item, "bytes"),
      codePointId,
      domain,
      emoji: stringField(item, "emoji"),
      path,
      sha256,
    };
  });
  if (new Set(items.map(({ domain }) => domain)).size !== items.length) {
    throw new CliError("invalid-data", "Brand emoji manifest contains duplicate domains.");
  }
  return { assetRoot: localPaths.assetRoot, items };
}

async function readMetadata(repositoryRoot: string): Promise<{
  readonly assetRoot: string;
  readonly catalog: EmojiCatalog;
  readonly catalogPath: string;
  readonly manifest: EmojiManifest;
  readonly manifestPath: string;
}> {
  const localPaths = paths(repositoryRoot);
  let catalogBytes: Buffer;
  let manifestBytes: Buffer;
  try {
    [catalogBytes, manifestBytes] = await Promise.all([
      readFile(localPaths.catalogPath),
      readFile(localPaths.manifestPath),
    ]);
  } catch {
    throw new CliError(
      "unavailable",
      `Emoji catalog metadata is missing. Run: ${EMOJI_GENERATION_COMMAND}`,
      { generationCommand: EMOJI_GENERATION_COMMAND },
    );
  }
  let catalogUnknown: unknown;
  let manifestUnknown: unknown;
  try {
    catalogUnknown = JSON.parse(catalogBytes.toString());
    manifestUnknown = JSON.parse(manifestBytes.toString());
  } catch {
    throw new CliError("invalid-data", "Emoji catalog metadata is not valid JSON.");
  }
  const catalog = parseCatalog(catalogUnknown);
  const manifest = parseManifest(manifestUnknown);
  const catalogSha256 = createHash("sha256").update(catalogBytes).digest("hex");
  if (manifest.catalogSha256 !== catalogSha256 || manifest.fontSha256 !== catalog.fontSha256) {
    throw new CliError(
      "invalid-data",
      `Emoji provenance is stale. Run: ${EMOJI_GENERATION_COMMAND}`,
      { generationCommand: EMOJI_GENERATION_COMMAND },
    );
  }
  if (catalog.items.length !== manifest.items.length) {
    throw new CliError("invalid-data", "Emoji catalog and asset manifest counts differ.");
  }
  const catalogById = new Map(catalog.items.map((item) => [item.id, item] as const));
  for (const item of manifest.items) {
    const catalogItem = catalogById.get(item.id);
    if (catalogItem === undefined || catalogItem.sourcePngSha256 !== item.sourcePngSha256) {
      throw new CliError("invalid-data", `Emoji manifest provenance differs for ${item.id}.`);
    }
  }
  return { ...localPaths, catalog, manifest };
}

async function variantAvailability(
  assetRoot: string,
  id: string,
): Promise<Readonly<Record<EmojiVariant, boolean>>> {
  const [color, duotone] = await Promise.all([
    fileExists(join(assetRoot, id, "color.svg")),
    fileExists(join(assetRoot, id, "duotone.svg")),
  ]);
  return { color, duotone };
}

function normalizeHexQuery(query: string): string | undefined {
  const normalized = query.trim().toLowerCase()
    .replaceAll("u+", "")
    .replaceAll("0x", "")
    .replaceAll(/[_\s]+/gu, "-");
  return /^[0-9a-f]{1,6}(?:-[0-9a-f]{1,6})*$/u.test(normalized) ? normalized : undefined;
}

function matchingItems(items: readonly EmojiCatalogItem[], query: string): readonly EmojiCatalogItem[] {
  const trimmed = query.trim();
  if (trimmed === "") throw new CliError("usage", "Emoji query cannot be empty.");
  const normalizedHex = normalizeHexQuery(trimmed);
  const exact = items.filter((item) =>
    item.emoji === trimmed
    || item.id === normalizedHex
    || item.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase()
  );
  if (exact.length > 0) return exact;
  const folded = trimmed.toLocaleLowerCase();
  return items.filter((item) =>
    item.name.toLocaleLowerCase().includes(folded)
    || item.group.toLocaleLowerCase().includes(folded)
    || item.subgroup.toLocaleLowerCase().includes(folded)
  );
}

function result(
  item: EmojiCatalogItem,
  available: Readonly<Record<EmojiVariant, boolean>>,
): EmojiSearchResult {
  return {
    available,
    emoji: item.emoji,
    group: item.group,
    id: item.id,
    name: item.name,
    provider: "apple-emoji-pack",
    subgroup: item.subgroup,
  };
}

function brandResult(item: BrandEmojiItem): EmojiSearchResult {
  return {
    available: { color: false, duotone: true },
    emoji: item.emoji,
    group: "Bundled brands",
    id: item.codePointId,
    name: item.domain,
    provider: "brand-catalog",
    subgroup: item.domain,
  };
}

function matchingBrandItems(items: readonly BrandEmojiItem[], query: string): readonly BrandEmojiItem[] {
  const trimmed = query.trim().replace(/^brand:/iu, "");
  if (trimmed === "") throw new CliError("usage", "Emoji query cannot be empty.");
  const folded = trimmed.toLocaleLowerCase();
  const normalizedHex = normalizeHexQuery(trimmed);
  const exact = items.filter((item) =>
    item.emoji === trimmed
    || item.codePointId === normalizedHex
    || item.domain === folded
    || item.domain.replace(/\.com$/u, "") === folded
  );
  return exact.length > 0 ? exact : items.filter((item) => item.domain.includes(folded));
}

export async function inspectEmojiAssets(repositoryRoot: string): Promise<EmojiAssetState> {
  const localPaths = paths(repositoryRoot);
  try {
    const metadata = await readMetadata(repositoryRoot);
    let installedCount = 0;
    try {
      const entries = await readdir(metadata.assetRoot, { withFileTypes: true });
      installedCount = entries.filter((entry) => entry.isDirectory()).length;
    } catch {
      installedCount = 0;
    }
    return {
      ...localPaths,
      catalogCount: metadata.catalog.items.length,
      generationCommand: EMOJI_GENERATION_COMMAND,
      installedCount,
      provenance: "checked",
    };
  } catch (error) {
    return {
      ...localPaths,
      catalogCount: 0,
      generationCommand: EMOJI_GENERATION_COMMAND,
      installedCount: 0,
      provenance: error instanceof CliError && error.code === "unavailable" ? "missing" : "invalid",
    };
  }
}

export async function searchEmojiAssets(
  repositoryRoot: string,
  query: string,
  limit: number,
  variant?: EmojiVariant,
  provider: EmojiAssetProvider | "all" = "all",
): Promise<readonly EmojiSearchResult[]> {
  const results: EmojiSearchResult[] = [];
  if (provider === "all" || provider === "apple-emoji-pack") {
    try {
      const metadata = await readMetadata(repositoryRoot);
      const matches = matchingItems(metadata.catalog.items, query).slice(0, limit);
      results.push(...await Promise.all(matches.map(async (item) => {
        const availability = await variantAvailability(metadata.assetRoot, item.id);
        if (variant === undefined) return result(item, availability);
        return result(item, {
          color: variant === "color" && availability.color,
          duotone: variant === "duotone" && availability.duotone,
        });
      })));
    } catch (error) {
      if (provider === "apple-emoji-pack" || !(error instanceof CliError && error.code === "unavailable")) throw error;
    }
  }
  if (provider === "all" || provider === "brand-catalog") {
    const brand = await readBrandItems(repositoryRoot);
    results.push(...matchingBrandItems(brand.items, query).map(brandResult).filter((item) =>
      variant === undefined || item.available[variant]
    ));
  }
  return results.sort((left, right) =>
    Number(right.name.toLocaleLowerCase() === query.toLocaleLowerCase())
    - Number(left.name.toLocaleLowerCase() === query.toLocaleLowerCase())
    || left.provider.localeCompare(right.provider)
    || left.name.localeCompare(right.name)
  ).slice(0, limit);
}

async function resolveAppleEmojiAsset(
  repositoryRoot: string,
  query: string,
  variant: EmojiVariant = "color",
): Promise<ResolvedEmojiAsset> {
  const metadata = await readMetadata(repositoryRoot);
  const matches = matchingItems(metadata.catalog.items, query);
  if (matches.length === 0) throw new CliError("not-found", `No emoji matches ${query}.`);
  if (matches.length > 1) {
    throw new CliError(
      "conflict",
      `Emoji query ${query} is ambiguous: ${matches.slice(0, 8).map(({ emoji, name }) => `${emoji} ${name}`).join(", ")}.`,
      { matches: matches.slice(0, 20).map(({ emoji, id, name }) => ({ emoji, id, name })) },
    );
  }
  const item = matches[0]!;
  const manifestItem = metadata.manifest.items.find(({ id }) => id === item.id);
  if (manifestItem === undefined) {
    throw new CliError("invalid-data", `Emoji manifest omits ${item.id}.`);
  }
  const assetPath = join(metadata.assetRoot, item.id, `${variant}.svg`);
  if (!await fileExists(assetPath)) {
    throw new CliError(
      "unavailable",
      `Local ${variant} asset for ${item.emoji} ${item.name} is missing. Run: ${EMOJI_GENERATION_COMMAND}`,
      { generationCommand: EMOJI_GENERATION_COMMAND, id: item.id, variant },
    );
  }
  const [assetRootReal, assetReal] = await Promise.all([realpath(metadata.assetRoot), realpath(assetPath)]);
  const assetRelative = relative(assetRootReal, assetReal);
  if (assetRelative.startsWith("..") || isAbsolute(assetRelative)) {
    throw new CliError("unsafe-path", `Emoji asset ${item.id}/${variant}.svg escapes the generated asset root.`);
  }
  const actualSha256 = await fileSha256(assetReal);
  const expectedSha256 = variant === "color"
    ? manifestItem.colorSvgSha256
    : manifestItem.duotoneSvgSha256;
  if (actualSha256 !== expectedSha256) {
    throw new CliError(
      "invalid-data",
      `Local ${variant} asset for ${item.emoji} failed its checked hash. Run: ${EMOJI_GENERATION_COMMAND}`,
      { actualSha256, expectedSha256, generationCommand: EMOJI_GENERATION_COMMAND },
    );
  }
  return {
    ...result(item, await variantAvailability(metadata.assetRoot, item.id)),
    path: assetReal,
    provider: "apple-emoji-pack",
    sha256: actualSha256,
    variant,
  };
}

async function resolveBrandEmojiAsset(
  repositoryRoot: string,
  query: string,
  variant: EmojiVariant = "duotone",
): Promise<ResolvedEmojiAsset> {
  if (variant !== "duotone") {
    throw new CliError("unavailable", "Brand-catalog emoji overlays provide the checked duotone variant only.");
  }
  const metadata = await readBrandItems(repositoryRoot);
  const matches = matchingBrandItems(metadata.items, query);
  if (matches.length === 0) throw new CliError("not-found", `No brand emoji matches ${query}.`);
  if (matches.length > 1) {
    throw new CliError(
      "conflict",
      `Brand emoji query ${query} is ambiguous: ${matches.slice(0, 8).map(({ domain }) => domain).join(", ")}.`,
    );
  }
  const item = matches[0]!;
  const [assetRootReal, assetReal] = await Promise.all([
    realpath(metadata.assetRoot),
    realpath(join(metadata.assetRoot, item.path)),
  ]);
  const assetRelative = relative(assetRootReal, assetReal);
  if (assetRelative.startsWith("..") || isAbsolute(assetRelative)) {
    throw new CliError("unsafe-path", `Brand emoji asset ${item.path} escapes its checked asset root.`);
  }
  const details = await stat(assetReal);
  const actualSha256 = await fileSha256(assetReal);
  if (!details.isFile() || details.size !== item.bytes || actualSha256 !== item.sha256) {
    throw new CliError("invalid-data", `Brand emoji asset ${item.domain} failed its checked size or hash.`);
  }
  return {
    ...brandResult(item),
    path: assetReal,
    sha256: actualSha256,
    variant,
  };
}

export async function resolveEmojiAsset(
  repositoryRoot: string,
  query: string,
  variant?: EmojiVariant,
  provider: EmojiAssetProvider | "auto" = "auto",
): Promise<ResolvedEmojiAsset> {
  if (provider === "apple-emoji-pack") return await resolveAppleEmojiAsset(repositoryRoot, query, variant);
  if (provider === "brand-catalog") return await resolveBrandEmojiAsset(repositoryRoot, query, variant);
  const brand = await readBrandItems(repositoryRoot);
  const folded = query.trim().toLocaleLowerCase();
  const explicitlyBrand = folded.startsWith("brand:") || brand.items.some((item) =>
    item.domain === folded || item.domain.replace(/\.com$/u, "") === folded
  );
  if (explicitlyBrand) return await resolveBrandEmojiAsset(repositoryRoot, query, variant);
  try {
    return await resolveAppleEmojiAsset(repositoryRoot, query, variant);
  } catch (error) {
    if (!(error instanceof CliError && (error.code === "not-found" || error.code === "unavailable"))) throw error;
    const brandMatches = matchingBrandItems(brand.items, query);
    if (brandMatches.length !== 1) throw error;
    return await resolveBrandEmojiAsset(repositoryRoot, query, variant);
  }
}
