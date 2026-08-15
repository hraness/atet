import { z } from "zod";

import {
  EmojiSelectorSchema,
  EmojiOverlaySourceSchema,
  type EmojiOverlaySource,
  type EmojiSelector,
} from "../contracts/edit";

export const EMOJI_ASSET_GENERATION_COMMAND = "bun run emoji-pack:generate";
export const BRAND_EMOJI_GENERATION_COMMAND = "bun run brand-icons:generate";
export const LOCAL_EMOJI_PACK_ROOT = "apps/desktop/.generated/emoji-pack";
export const APPLE_EMOJI_ASSET_ROOT = `${LOCAL_EMOJI_PACK_ROOT}/assets`;
export const APPLE_EMOJI_CATALOG_PATH =
  `${LOCAL_EMOJI_PACK_ROOT}/apple-emoji-catalog.json`;
export const APPLE_EMOJI_MANIFEST_PATH =
  `${LOCAL_EMOJI_PACK_ROOT}/emoji-pack-manifest.json`;

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const AppleCatalogItemSchema = z.strictObject({
  emoji: z.string().min(1),
  emojiVersion: z.string().min(1),
  glyphIDs: z.array(z.number().int().positive()).min(1),
  group: z.string().min(1),
  id: z.string().regex(/^[a-f0-9]+(?:-[a-f0-9]+)*$/u),
  name: z.string().min(1),
  qualification: z.string().min(1),
  sourceIndex: z.number().int().nonnegative(),
  sourceKind: z.enum(["coretext-composite", "coretext-render", "sbix"]),
  sourcePngBytes: z.number().int().positive(),
  sourcePngSha256: Sha256Schema,
  subgroup: z.string().min(1),
});

const AppleCatalogSchema = z.strictObject({
  font: z.strictObject({
    copyright: z.string().nullable(),
    postScriptName: z.literal("AppleColorEmoji"),
    sha256: Sha256Schema,
    version: z.string().nullable(),
  }),
  formatVersion: z.literal(1),
  items: z.array(AppleCatalogItemSchema),
  source: z.strictObject({
    file: z.string().min(1),
    rgiCount: z.number().int().positive(),
    sha256: Sha256Schema,
    unicodeVersion: z.string().min(1),
    url: z.string().url(),
  }),
  unsupported: z.array(z.strictObject({
    emoji: z.string().min(1),
    emojiVersion: z.string().min(1),
    group: z.string().min(1),
    id: z.string().min(1),
    name: z.string().min(1),
    qualification: z.string().min(1),
    reason: z.string().min(1),
    sourceIndex: z.number().int().nonnegative(),
    subgroup: z.string().min(1),
  })),
});

const PackManifestSchema = z.strictObject({
  catalogSha256: Sha256Schema,
  formatVersion: z.literal(1),
  items: z.array(z.strictObject({
    atlas: z.number().int().nonnegative(),
    colorSvgSha256: Sha256Schema,
    duotoneSvgSha256: Sha256Schema,
    id: z.string().min(1),
    index: z.number().int().nonnegative(),
    sourcePngSha256: Sha256Schema,
    tile: z.number().int().nonnegative(),
  })),
  outputs: z.array(z.strictObject({
    atlas: z.number().int().nonnegative(),
    bytes: z.number().int().positive(),
    height: z.number().int().positive(),
    path: z.string().min(1),
    sha256: Sha256Schema,
    variant: z.enum(["color", "duotone"]),
    width: z.number().int().positive(),
  })),
  provenance: z.strictObject({
    fontSha256: Sha256Schema,
    sharp: z.string().min(1),
    vips: z.string().min(1),
    vtracerSha256: Sha256Schema,
    vtracerVersion: z.string().min(1),
  }),
  recipe: z.strictObject({
    background: z.string().min(1),
    columns: z.number().int().positive(),
    iconSize: z.number().int().positive(),
    itemsPerAtlas: z.number().int().positive(),
    rows: z.number().int().positive(),
    tileSize: z.number().int().positive(),
  }),
});

export interface EmojiAssetFilePort {
  fileSize(path: string): Promise<number>;
  readText(path: string): Promise<string>;
}

export type EmojiAssetVariant = "native-png" | "color-svg" | "duotone-svg";

export interface EmojiAssetProvider {
  resolve(selector: EmojiSelector): Promise<EmojiOverlaySource>;
}

export interface EmojiAssetProviderOptions {
  readonly catalogPath?: string;
  readonly generatedRoot?: string;
  readonly manifestPath?: string;
  readonly variant?: EmojiAssetVariant;
}

export class MissingEmojiAssetsError extends Error {
  readonly command = EMOJI_ASSET_GENERATION_COMMAND;
  readonly path: string;

  constructor(path: string) {
    super(`Emoji asset is missing at ${path}. Generate the retained local assets with: ${EMOJI_ASSET_GENERATION_COMMAND}`);
    this.name = "MissingEmojiAssetsError";
    this.path = path;
  }
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SyntaxError(`Invalid ${label} JSON: ${String(error)}`);
  }
}

export function createEmojiAssetProvider(
  files: EmojiAssetFilePort,
  options: EmojiAssetProviderOptions = {},
): EmojiAssetProvider {
  const catalogPath = options.catalogPath ?? APPLE_EMOJI_CATALOG_PATH;
  const manifestPath = options.manifestPath ?? APPLE_EMOJI_MANIFEST_PATH;
  const generatedRoot = options.generatedRoot ?? LOCAL_EMOJI_PACK_ROOT;
  const variant = options.variant ?? "color-svg";

  return {
    async resolve(selectorInput) {
      const selector = EmojiSelectorSchema.parse(selectorInput);
      const [catalogText, manifestText] = await Promise.all([
        files.readText(catalogPath),
        files.readText(manifestPath),
      ]);
      const catalog = AppleCatalogSchema.parse(parseJson(catalogText, "emoji catalog"));
      const manifest = PackManifestSchema.parse(parseJson(manifestText, "emoji manifest"));
      const item = catalog.items.find((candidate) => (
        selector.kind === "unicode"
          ? candidate.emoji === selector.value
          : selector.kind === "name"
            ? candidate.name.toLocaleLowerCase() === selector.value.toLocaleLowerCase()
            : candidate.id === selector.value
      ));
      if (item === undefined) throw new Error(`Emoji selector did not match the local catalog: ${selector.value}`);
      const manifestItem = manifest.items.find(({ id }) => id === item.id);
      if (manifestItem === undefined || manifestItem.sourcePngSha256 !== item.sourcePngSha256) {
        throw new Error(`Emoji manifest does not match catalog item ${item.id}.`);
      }
      const path = variant === "native-png"
        ? `${generatedRoot}/native/${item.id}.png`
        : `${generatedRoot}/assets/${item.id}/${variant === "color-svg" ? "color.svg" : "duotone.svg"}`;
      let bytes: number;
      try {
        bytes = await files.fileSize(path);
      } catch {
        throw new MissingEmojiAssetsError(path);
      }
      const sha256 = variant === "native-png"
        ? item.sourcePngSha256
        : variant === "color-svg"
          ? manifestItem.colorSvgSha256
          : manifestItem.duotoneSvgSha256;
      return EmojiOverlaySourceSchema.parse({
        asset: {
          bytes,
          mediaType: variant === "native-png" ? "image/png" : "image/svg+xml",
          path,
          provenance: {
            command: ["bun", "run", "emoji-pack:generate"],
            generator: "atet-emoji-pack",
            generatorVersion: manifest.provenance.vtracerVersion,
            kind: "generated",
            sourceSha256: item.sourcePngSha256,
          },
          sha256,
        },
        kind: "emoji",
        provider: "apple-emoji-pack",
        selector,
      });
    },
  };
}

export async function resolveEmojiAsset(
  provider: EmojiAssetProvider,
  selector: EmojiSelector,
): Promise<EmojiOverlaySource> {
  return await provider.resolve(EmojiSelectorSchema.parse(selector));
}
