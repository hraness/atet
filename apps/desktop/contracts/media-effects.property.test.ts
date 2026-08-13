import { expect } from "bun:test";
import { assertProperty, fc } from "../testing/property";

import {
  AudioEffectsTransformV1Schema,
  ColorGradeTransformV1Schema,
} from "./media-effects";

assertProperty(fc.property(
  fc.integer({ max: 2_400, min: -6_000 }),
  fc.integer({ max: 10_000, min: 1 }),
  fc.integer({ max: 1_000, min: 0 }),
  (gainHundredths, delayMs, mixThousandths) => {
    const parsed = AudioEffectsTransformV1Schema.parse({
      effects: [
        { gainDb: gainHundredths / 100, kind: "volume" },
        { delayMs, kind: "delay", mix: mixThousandths / 1_000 },
      ],
      kind: "studio.audio-effects-transform",
      output: { kind: "audio-only", profile: "wav-pcm-s16le" },
      schemaVersion: 1,
    });
    expect(AudioEffectsTransformV1Schema.parse(JSON.parse(JSON.stringify(parsed)) as unknown)).toEqual(parsed);
  },
));

assertProperty(fc.property(
  fc.integer({ max: 50, min: -50 }),
  fc.integer({ max: 200, min: 0 }),
  fc.integer({ max: 300, min: 0 }),
  fc.integer({ max: 180, min: -180 }),
  (brightnessHundredths, contrastHundredths, saturationHundredths, hue) => {
    const parsed = ColorGradeTransformV1Schema.parse({
      grade: {
        controls: {
          brightness: brightnessHundredths / 100,
          contrast: contrastHundredths / 100,
          hue,
          saturation: saturationHundredths / 100,
        },
        kind: "custom",
      },
      kind: "studio.color-grade-transform",
      outputProfile: "h264-mp4",
      schemaVersion: 1,
    });
    expect(ColorGradeTransformV1Schema.parse(JSON.parse(JSON.stringify(parsed)) as unknown)).toEqual(parsed);
  },
));
