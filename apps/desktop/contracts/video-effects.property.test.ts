import { expect } from "bun:test";
import { assertProperty, fc } from "../testing/property";

import { VideoLookV1Schema } from "./video-effects";

assertProperty(fc.property(
  fc.integer({ max: 100, min: 0 }),
  fc.integer({ max: 100, min: 0 }),
  fc.integer({ max: 2_147_483_647, min: 0 }),
  fc.integer({ max: 256, min: 2 }),
  (amountHundredths, chromaHundredths, seed, colors) => {
    const parsed = VideoLookV1Schema.parse({
      effects: [
        {
          amount: amountHundredths / 100,
          cadence: "frame-varying",
          chroma: chromaHundredths / 100,
          kind: "film-grain",
          seed,
        },
        {
          amount: amountHundredths / 100,
          colors,
          kind: "ordered-dither",
        },
      ],
      kind: "studio.video-look",
      schemaVersion: 1,
    });

    expect(VideoLookV1Schema.parse(JSON.parse(JSON.stringify(parsed)) as unknown)).toEqual(parsed);
  },
));
