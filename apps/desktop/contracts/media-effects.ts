import { z } from "zod";

import type { ReadonlyInferred } from "./recording";

export const AUDIO_REVERB_PRESETS = [
  "small-room",
  "medium-room",
  "large-hall",
  "plate",
] as const;
export const AUDIO_ONLY_OUTPUT_PROFILES = ["wav-pcm-s16le", "flac", "mp3", "aac", "opus"] as const;
export const COLOR_GRADE_PRESETS = [
  "clean",
  "warm",
  "cool",
  "vivid",
  "cinematic",
  "monochrome",
  "flat",
] as const;
export const COLOR_GRADE_OUTPUT_PROFILES = ["h264-mp4", "prores-mov", "vp9-webm"] as const;

export const AudioVolumeEffectSchema = z.strictObject({
  gainDb: z.number().finite().min(-60).max(24),
  kind: z.literal("volume"),
});

export const AudioCompressorEffectSchema = z.strictObject({
  attackMs: z.number().finite().min(0.01).max(2_000).default(20),
  knee: z.number().finite().min(1).max(8).default(2.828),
  kind: z.literal("compressor"),
  makeupGainDb: z.number().finite().min(0).max(36).default(0),
  ratio: z.number().finite().min(1).max(20).default(4),
  releaseMs: z.number().finite().min(0.01).max(9_000).default(250),
  thresholdDb: z.number().finite().min(-60).max(0).default(-18),
});

/**
 * A bounded feedback-style echo rendered as up to 16 deterministic taps over
 * at most 30 seconds. `mix` controls the first repeat and `decay` controls the
 * gain retained by each subsequent repeat.
 */
export const AudioDelayEffectSchema = z.strictObject({
  decay: z.number().finite().min(0).max(1).default(0.45),
  delayMs: z.number().int().safe().min(1).max(10_000),
  kind: z.literal("delay"),
  mix: z.number().finite().min(0).max(1).default(0.35),
});

export const AudioReverbEffectSchema = z.strictObject({
  kind: z.literal("reverb"),
  mix: z.number().finite().min(0).max(1).default(0.25),
  preset: z.enum(AUDIO_REVERB_PRESETS).default("medium-room"),
});

export const AudioDenoiseEffectSchema = z.strictObject({
  kind: z.literal("denoise"),
  noiseFloorDb: z.number().finite().min(-80).max(-20).default(-50),
  noiseReductionDb: z.number().finite().min(0.01).max(97).default(12),
  trackNoise: z.boolean().default(true),
});

export const AudioEffectSchema = z.discriminatedUnion("kind", [
  AudioVolumeEffectSchema,
  AudioCompressorEffectSchema,
  AudioDelayEffectSchema,
  AudioReverbEffectSchema,
  AudioDenoiseEffectSchema,
]);

export const AudioTransformOutputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("audio-only"),
    profile: z.enum(AUDIO_ONLY_OUTPUT_PROFILES),
  }),
  z.strictObject({
    inputVideoStreamIndex: z.number().int().safe().nonnegative().optional(),
    kind: z.literal("preserve-video"),
    profile: z.enum(["aac", "opus"]),
    videoStreamIndex: z.number().int().safe().nonnegative().default(0),
  }),
]);

export const AudioEffectsTransformV1Schema = z.strictObject({
  audioStreamIndex: z.number().int().safe().nonnegative().default(0),
  effects: z.array(AudioEffectSchema).min(1).max(16),
  kind: z.union([
    z.literal("transmute.audio-effects-transform"),
    z.literal("studio.audio-effects-transform"),
  ]),
  output: AudioTransformOutputSchema,
  schemaVersion: z.literal(1),
});

export const ColorGradeControlsSchema = z.strictObject({
  brightness: z.number().finite().min(-0.5).max(0.5).optional(),
  contrast: z.number().finite().min(0).max(2).optional(),
  gamma: z.number().finite().min(0.1).max(3).optional(),
  hue: z.number().finite().min(-180).max(180).optional(),
  saturation: z.number().finite().min(0).max(3).optional(),
  temperature: z.number().finite().min(-1).max(1).optional(),
  tint: z.number().finite().min(-1).max(1).optional(),
}).refine(
  controls => Object.values(controls).some(value => value !== undefined),
  "At least one color-grade control must be supplied.",
);

export const ColorGradeSelectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("custom"),
    controls: ColorGradeControlsSchema,
  }),
  z.strictObject({
    kind: z.literal("preset"),
    overrides: ColorGradeControlsSchema.optional(),
    preset: z.enum(COLOR_GRADE_PRESETS),
  }),
]);

export const ColorGradeOutputProfileSchema = z.enum(COLOR_GRADE_OUTPUT_PROFILES);

export const ColorGradeTransformV1Schema = z.strictObject({
  grade: ColorGradeSelectionSchema,
  inputStreamIndex: z.number().int().safe().nonnegative().optional(),
  kind: z.union([
    z.literal("transmute.color-grade-transform"),
    z.literal("studio.color-grade-transform"),
  ]),
  outputProfile: ColorGradeOutputProfileSchema,
  schemaVersion: z.literal(1),
  videoStreamIndex: z.number().int().safe().nonnegative().default(0),
});

export type AudioEffect = ReadonlyInferred<typeof AudioEffectSchema>;
export type AudioEffectsTransformV1 = ReadonlyInferred<typeof AudioEffectsTransformV1Schema>;
export type AudioTransformOutput = ReadonlyInferred<typeof AudioTransformOutputSchema>;
export type ColorGradeControls = ReadonlyInferred<typeof ColorGradeControlsSchema>;
export type ColorGradeSelection = ReadonlyInferred<typeof ColorGradeSelectionSchema>;
export type ColorGradeTransformV1 = ReadonlyInferred<typeof ColorGradeTransformV1Schema>;
