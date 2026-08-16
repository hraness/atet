import { z } from "zod";

import { ColorGradeSelectionSchema } from "./media-effects";
import type { DeepReadonly, ReadonlyInferred } from "./recording";

export const VIDEO_LOOK_PRESETS = [
  "blue-16mm",
  "warm-super-8",
  "photocopy",
  "soft-vhs",
] as const;

export const ERROR_DIFFUSION_DITHER_ALGORITHMS = [
  "atkinson",
  "floyd-steinberg",
] as const;

const UnitIntervalSchema = z.number().finite().min(0).max(1);
const CanonicalRgbHexSchema = z.string()
  .regex(/^#[0-9a-fA-F]{6}$/u, "Expected a six-digit RGB hex color.")
  .transform(value => value.toLocaleLowerCase("en-US"));

export const VideoLookPresetSchema = z.enum(VIDEO_LOOK_PRESETS);

export const VideoLookPresetOptionsSchema = z.strictObject({
  intensity: UnitIntervalSchema.default(1),
  seed: z.number().int().safe().nonnegative().max(2_147_483_647).default(19_840_123),
});

export const ColorGradeVideoEffectSchema = z.strictObject({
  amount: UnitIntervalSchema.default(1),
  grade: ColorGradeSelectionSchema,
  kind: z.literal("color-grade"),
});

export const DuotoneVideoEffectSchema = z.strictObject({
  amount: UnitIntervalSchema.default(1),
  highlights: CanonicalRgbHexSchema,
  kind: z.literal("duotone"),
  shadows: CanonicalRgbHexSchema,
});

export const DiffusionVideoEffectSchema = z.strictObject({
  amount: UnitIntervalSchema.default(0.15),
  blendMode: z.enum(["screen", "soft-light"]).default("screen"),
  kind: z.literal("diffusion"),
  radiusPx: z.number().finite().min(0.25).max(64).default(4),
});

export const FilmGrainVideoEffectSchema = z.strictObject({
  amount: UnitIntervalSchema.default(0.25),
  cadence: z.enum(["fixed", "frame-varying"]).default("frame-varying"),
  chroma: UnitIntervalSchema.default(0.15),
  kind: z.literal("film-grain"),
  seed: z.number().int().safe().nonnegative().max(2_147_483_647),
});

export const VignetteVideoEffectSchema = z.strictObject({
  amount: UnitIntervalSchema.default(0.2),
  center: z.strictObject({
    xUnit: UnitIntervalSchema.default(0.5),
    yUnit: UnitIntervalSchema.default(0.5),
  }).default({ xUnit: 0.5, yUnit: 0.5 }),
  kind: z.literal("vignette"),
});

export const ScanlinesVideoEffectSchema = z.strictObject({
  amount: UnitIntervalSchema.default(0.15),
  kind: z.literal("scanlines"),
  spacingPx: z.number().int().safe().min(4).max(64).default(4),
  thicknessPx: z.number().int().safe().min(1).max(3).default(1),
});

export const OrderedDitherVideoEffectSchema = z.strictObject({
  amount: UnitIntervalSchema.default(1),
  bayerScale: z.number().int().safe().min(0).max(5).default(2),
  colors: z.number().int().safe().min(2).max(256).default(16),
  kind: z.literal("ordered-dither"),
  matrix: z.literal("bayer-8x8").default("bayer-8x8"),
});

export const ErrorDiffusionDitherVideoEffectSchema = z.strictObject({
  algorithm: z.enum(ERROR_DIFFUSION_DITHER_ALGORITHMS).default("floyd-steinberg"),
  amount: UnitIntervalSchema.default(1),
  colors: z.number().int().safe().min(2).max(256).default(16),
  kind: z.literal("error-diffusion-dither"),
});

/**
 * These are artistic, display-referred effects. Codec/output dithering remains
 * a separate renderer concern so an aesthetic dither cannot accidentally be
 * treated as a bit-depth conversion policy.
 */
export const VideoEffectSchema = z.discriminatedUnion("kind", [
  ColorGradeVideoEffectSchema,
  DuotoneVideoEffectSchema,
  DiffusionVideoEffectSchema,
  FilmGrainVideoEffectSchema,
  VignetteVideoEffectSchema,
  ScanlinesVideoEffectSchema,
  OrderedDitherVideoEffectSchema,
  ErrorDiffusionDitherVideoEffectSchema,
]);

export const VideoLookV1Schema = z.strictObject({
  effects: z.array(VideoEffectSchema).min(1).max(16),
  kind: z.union([
    z.literal("atet.video-look"),
    z.literal("studio.video-look"),
  ]),
  processingColorSpace: z.literal("bt709-display").default("bt709-display"),
  schemaVersion: z.literal(1),
});

export type VideoEffect = ReadonlyInferred<typeof VideoEffectSchema>;
export type VideoEffectInput = DeepReadonly<z.input<typeof VideoEffectSchema>>;
export type VideoLookPreset = ReadonlyInferred<typeof VideoLookPresetSchema>;
export type VideoLookPresetOptions = ReadonlyInferred<typeof VideoLookPresetOptionsSchema>;
export type VideoLookPresetOptionsInput = DeepReadonly<z.input<typeof VideoLookPresetOptionsSchema>>;
export type VideoLookV1 = ReadonlyInferred<typeof VideoLookV1Schema>;
