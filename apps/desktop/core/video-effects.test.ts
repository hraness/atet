import { expect, test } from "bun:test";

import {
  compileVideoLookToFfmpeg,
  createVideoLook,
  createVideoLookPreset,
  videoLooks,
} from "./video-effects";

test("expands the blue 16mm look into deterministic inspectable primitives", () => {
  const look = videoLooks.blue16mm({ intensity: 0.8, seed: 42 });

  expect(look.effects.map(effect => effect.kind)).toEqual([
    "color-grade",
    "duotone",
    "diffusion",
    "film-grain",
    "vignette",
  ]);
  expect(look.effects[1]).toEqual({
    amount: 0.576,
    highlights: "#9edbfa",
    kind: "duotone",
    shadows: "#061018",
  });
  expect(look.effects[3]).toEqual({
    amount: 0.384,
    cadence: "frame-varying",
    chroma: 0.08,
    kind: "film-grain",
    seed: 42,
  });

  const compiled = compileVideoLookToFfmpeg(look);
  expect(compiled).toEqual(compileVideoLookToFfmpeg(look));
  expect(compiled.lookHash).toBe(
    "178104f73c03fad9419e454d0b33db2ece5b3e38162d6eab0cff9f9ab33d6578",
  );
  expect(compiled.compiler).toBe("atet.ffmpeg-video-look");
  expect(compiled.look.kind).toBe("atet.video-look");
  expect(compiled.filterGraph).toContain("curves=interp=pchip");
  expect(compiled.filterGraph).toContain("noise=c0s=25:c1s=2:c2s=2");
  expect(compiled.filterGraph).toContain("all_mode=screen:all_opacity=0.136");
  expect(compiled.requiredFilters).toEqual([
    "eq",
    "colorbalance",
    "split",
    "blend",
    "hue",
    "curves",
    "gblur",
    "format",
    "noise",
    "vignette",
  ]);
});

test("compiles ordered and error-diffusion dither without caller expressions", () => {
  const look = createVideoLook([
    {
      amount: 0.75,
      bayerScale: 1,
      colors: 6,
      kind: "ordered-dither",
      matrix: "bayer-8x8",
    },
    {
      algorithm: "atkinson",
      amount: 0.5,
      colors: 3,
      kind: "error-diffusion-dither",
    },
  ]);
  const compiled = compileVideoLookToFfmpeg(look, { videoStreamIndex: 2 });

  expect(compiled.inputLabel).toBe("0:v:2");
  expect(compiled.outputLabel).toBe("video_look_1");
  expect(compiled.filterGraph).toContain(
    "palettegen=max_colors=6:reserve_transparent=0:stats_mode=full",
  );
  expect(compiled.filterGraph).toContain(
    "paletteuse=dither=bayer:bayer_scale=1",
  );
  expect(compiled.filterGraph).toContain("paletteuse=dither=atkinson");
  expect(compiled.requiredFilters).toEqual([
    "split",
    "palettegen",
    "paletteuse",
    "blend",
  ]);
});

test("zero-intensity presets are neutral and retain the selected input stream", () => {
  for (const preset of ["blue-16mm", "warm-super-8", "photocopy", "soft-vhs"] as const) {
    const compiled = compileVideoLookToFfmpeg(
      createVideoLookPreset(preset, { intensity: 0, seed: 7 }),
      { videoStreamIndex: 3 },
    );
    expect(compiled.filterGraph).toBe("");
    expect(compiled.outputLabel).toBe("0:v:3");
    expect(compiled.requiredFilters).toEqual([]);
  }
});

test("effect order is part of the receipt and compile options remain bounded", () => {
  const grain = {
    amount: 0.2,
    cadence: "fixed",
    chroma: 0,
    kind: "film-grain",
    seed: 9,
  } as const;
  const vignette = {
    amount: 0.2,
    kind: "vignette",
  } as const;
  const left = compileVideoLookToFfmpeg(createVideoLook([grain, vignette]));
  const right = compileVideoLookToFfmpeg(createVideoLook([vignette, grain]));

  expect(left.lookHash).not.toBe(right.lookHash);
  expect(left.filterGraph).not.toBe(right.filterGraph);
  expect(() => compileVideoLookToFfmpeg(left.look, { videoStreamIndex: -1 })).toThrow(
    "videoStreamIndex",
  );
  expect(() => compileVideoLookToFfmpeg(left.look, { videoStreamIndex: 1_025 })).toThrow(
    "videoStreamIndex",
  );
});
