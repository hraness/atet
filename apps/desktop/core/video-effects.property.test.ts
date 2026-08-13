import { expect } from "bun:test";
import { assertProperty, fc } from "../testing/property";

import {
  compileVideoLookToFfmpeg,
  createVideoLookPreset,
} from "./video-effects";

assertProperty(fc.property(
  fc.constantFrom("blue-16mm", "warm-super-8", "photocopy", "soft-vhs"),
  fc.integer({ max: 1_000, min: 0 }),
  fc.integer({ max: 2_147_483_647, min: 0 }),
  fc.integer({ max: 16, min: 0 }),
  (preset, intensityThousandths, seed, videoStreamIndex) => {
    const look = createVideoLookPreset(preset, {
      intensity: intensityThousandths / 1_000,
      seed,
    });
    const first = compileVideoLookToFfmpeg(look, { videoStreamIndex });
    const second = compileVideoLookToFfmpeg(
      JSON.parse(JSON.stringify(look)) as unknown,
      { videoStreamIndex },
    );

    expect(second).toEqual(first);
    expect(first.filterGraph).not.toMatch(/(?:Infinity|NaN|undefined)/u);
    expect(first.filterGraph.length).toBeLessThan(32_768);
  },
));
