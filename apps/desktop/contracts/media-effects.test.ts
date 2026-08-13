import { expect, test } from "bun:test";

import {
  AudioEffectsTransformV1Schema,
  ColorGradeTransformV1Schema,
} from "./media-effects";

test("normalizes bounded defaults for every audio effect", () => {
  const parsed = AudioEffectsTransformV1Schema.parse({
    effects: [
      { gainDb: -3, kind: "volume" },
      { kind: "compressor" },
      { delayMs: 180, kind: "delay" },
      { kind: "reverb" },
      { kind: "reverb", mix: 0.2, preset: "plate" },
      { kind: "denoise" },
    ],
    kind: "studio.audio-effects-transform",
    output: { kind: "audio-only", profile: "wav-pcm-s16le" },
    schemaVersion: 1,
  });

  expect(parsed.audioStreamIndex).toBe(0);
  expect(parsed.effects).toEqual([
    { gainDb: -3, kind: "volume" },
    {
      attackMs: 20,
      knee: 2.828,
      kind: "compressor",
      makeupGainDb: 0,
      ratio: 4,
      releaseMs: 250,
      thresholdDb: -18,
    },
    { decay: 0.45, delayMs: 180, kind: "delay", mix: 0.35 },
    { kind: "reverb", mix: 0.25, preset: "medium-room" },
    { kind: "reverb", mix: 0.2, preset: "plate" },
    { kind: "denoise", noiseFloorDb: -50, noiseReductionDb: 12, trackNoise: true },
  ]);
});

test("rejects unsafe audio effect ranges, empty chains, and unknown fields", () => {
  const base = {
    kind: "studio.audio-effects-transform",
    output: { kind: "audio-only", profile: "wav-pcm-s16le" },
    schemaVersion: 1,
  } as const;

  expect(AudioEffectsTransformV1Schema.safeParse({ ...base, effects: [] }).success).toBe(false);
  expect(AudioEffectsTransformV1Schema.safeParse({
    ...base,
    effects: [{ delayMs: 90_001, kind: "delay" }],
  }).success).toBe(false);
  expect(AudioEffectsTransformV1Schema.safeParse({
    ...base,
    effects: [{ gainDb: 3, kind: "volume", shell: "anything" }],
  }).success).toBe(false);
  expect(AudioEffectsTransformV1Schema.safeParse({
    ...base,
    effects: [{ kind: "denoise", noiseFloorDb: Number.NaN }],
  }).success).toBe(false);
});

test("models custom grades and preset overrides without admitting empty control bags", () => {
  expect(ColorGradeTransformV1Schema.safeParse({
    grade: { controls: {}, kind: "custom" },
    kind: "studio.color-grade-transform",
    outputProfile: "h264-mp4",
    schemaVersion: 1,
  }).success).toBe(false);

  const parsed = ColorGradeTransformV1Schema.parse({
    grade: {
      kind: "preset",
      overrides: { hue: 18, saturation: 1.3 },
      preset: "cinematic",
    },
    kind: "studio.color-grade-transform",
    outputProfile: "h264-mp4",
    schemaVersion: 1,
    videoStreamIndex: 2,
  });
  expect(parsed.videoStreamIndex).toBe(2);
  expect(parsed.grade).toEqual({
    kind: "preset",
    overrides: { hue: 18, saturation: 1.3 },
    preset: "cinematic",
  });

  expect(ColorGradeTransformV1Schema.safeParse({
    ...parsed,
    grade: { controls: { temperature: 1.01 }, kind: "custom" },
  }).success).toBe(false);
});
