import { expect, test } from "bun:test";

import { VideoLookPresetOptionsSchema, VideoLookV1Schema } from "./video-effects";

test("normalizes bounded defaults across the artistic effect graph", () => {
  const parsed = VideoLookV1Schema.parse({
    effects: [
      {
        grade: { kind: "preset", preset: "cinematic" },
        kind: "color-grade",
      },
      {
        highlights: "#B8E6FF",
        kind: "duotone",
        shadows: "#061018",
      },
      { kind: "diffusion" },
      { kind: "film-grain", seed: 42 },
      { kind: "vignette" },
      { kind: "scanlines" },
      { kind: "ordered-dither" },
      { kind: "error-diffusion-dither" },
    ],
    kind: "studio.video-look",
    schemaVersion: 1,
  });

  expect(parsed.processingColorSpace).toBe("bt709-display");
  expect(parsed.effects).toEqual([
    {
      amount: 1,
      grade: { kind: "preset", preset: "cinematic" },
      kind: "color-grade",
    },
    {
      amount: 1,
      highlights: "#b8e6ff",
      kind: "duotone",
      shadows: "#061018",
    },
    { amount: 0.15, blendMode: "screen", kind: "diffusion", radiusPx: 4 },
    {
      amount: 0.25,
      cadence: "frame-varying",
      chroma: 0.15,
      kind: "film-grain",
      seed: 42,
    },
    { amount: 0.2, center: { xUnit: 0.5, yUnit: 0.5 }, kind: "vignette" },
    { amount: 0.15, kind: "scanlines", spacingPx: 4, thicknessPx: 1 },
    {
      amount: 1,
      bayerScale: 2,
      colors: 16,
      kind: "ordered-dither",
      matrix: "bayer-8x8",
    },
    {
      algorithm: "floyd-steinberg",
      amount: 1,
      colors: 16,
      kind: "error-diffusion-dither",
    },
  ]);
});

test("rejects unknown effect fields, unsafe colors, ranges, and oversized graphs", () => {
  const look = (effects: readonly unknown[]) => ({
    effects,
    kind: "studio.video-look",
    schemaVersion: 1,
  });

  expect(VideoLookV1Schema.safeParse(look([])).success).toBe(false);
  expect(VideoLookV1Schema.safeParse(look([
    { highlights: "blue", kind: "duotone", shadows: "#000000" },
  ])).success).toBe(false);
  expect(VideoLookV1Schema.safeParse(look([
    { kind: "film-grain", seed: 42, shell: "anything" },
  ])).success).toBe(false);
  expect(VideoLookV1Schema.safeParse(look([
    { kind: "scanlines", spacingPx: 3 },
  ])).success).toBe(false);
  expect(VideoLookV1Schema.safeParse(look([
    { colors: 257, kind: "ordered-dither" },
  ])).success).toBe(false);
  expect(VideoLookV1Schema.safeParse(look(
    Array.from({ length: 17 }, () => ({ kind: "vignette" })),
  )).success).toBe(false);
});

test("bounds deterministic preset controls", () => {
  expect(VideoLookPresetOptionsSchema.parse({})).toEqual({
    intensity: 1,
    seed: 19_840_123,
  });
  expect(VideoLookPresetOptionsSchema.safeParse({ intensity: 1.01 }).success).toBe(false);
  expect(VideoLookPresetOptionsSchema.safeParse({ seed: -1 }).success).toBe(false);
  expect(VideoLookPresetOptionsSchema.safeParse({
    intensity: 0.5,
    seed: 7,
    source: "caller text",
  }).success).toBe(false);
});
