import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ingestEmojiAsset } from "./asset-ingest";
import {
  inspectEmojiAssets,
  resolveEmojiAsset,
  searchEmojiAssets,
} from "./emoji-assets";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../../..");

test("reports the ignored local emoji-pack metadata paths", async () => {
  const state = await inspectEmojiAssets(REPOSITORY_ROOT);
  const generatedRoot = join(
    REPOSITORY_ROOT,
    "apps/desktop/.generated/emoji-pack",
  );
  expect(state).toMatchObject({
    assetRoot: join(generatedRoot, "assets"),
    catalogPath: join(generatedRoot, "apple-emoji-catalog.json"),
    generationCommand: "bun run emoji-pack:generate",
    manifestPath: join(generatedRoot, "emoji-pack-manifest.json"),
  });
});

test("searches and resolves checked brand-catalog emoji overlays", async () => {
  const search = await searchEmojiAssets(REPOSITORY_ROOT, "atet", 10, undefined, "brand-catalog");
  expect(search).toHaveLength(1);
  expect(search[0]).toMatchObject({
    available: { color: false, duotone: true },
    emoji: "☀️",
    name: "atet.sh",
    provider: "brand-catalog",
  });

  const resolved = await resolveEmojiAsset(REPOSITORY_ROOT, "atet", undefined, "auto");
  expect(resolved.provider).toBe("brand-catalog");
  expect(resolved.variant).toBe("duotone");
  expect(resolved.path).toEndWith("/apps/desktop/assets/brand-emoji/atet.sh.svg");

  const temporary = await mkdtemp(join(tmpdir(), "atet-brand-emoji-test-"));
  try {
    const ingested = await ingestEmojiAsset(join(temporary, "rec_emoji001"), resolved);
    expect(ingested.mediaType).toBe("image/svg+xml");
    expect(ingested.provenance).toMatchObject({ generator: "brand-catalog", kind: "generated" });
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("reports an unavailable variant instead of substituting brand color assets", async () => {
  let failure: unknown;
  try {
    await resolveEmojiAsset(REPOSITORY_ROOT, "brand:atet.sh", "color", "brand-catalog");
  } catch (error) {
    failure = error;
  }
  expect(String(failure)).toContain("duotone variant only");
});
