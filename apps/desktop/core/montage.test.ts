import { describe, expect, test } from "bun:test";

import { planContainedMosaic, planMontageSequence } from "./montage";

describe("contained montage layout", () => {
  test("preserves panel aspect ratios inside checked cells", () => {
    const plan = planContainedMosaic({
      canvas: { height: 1_080, width: 1_920 },
      panels: [
        {
          cell: { height: 352, width: 700, x: 24, y: 92 },
          panelId: "pov",
          source: { height: 282, width: 560 },
        },
        {
          cell: { height: 718, width: 1_148, x: 748, y: 92 },
          panelId: "laptop",
          source: { height: 447, width: 714 },
        },
      ],
    });

    expect(plan.panels).toEqual([
      {
        cell: { height: 352, width: 700, x: 24, y: 92 },
        content: { height: 352, width: 698, x: 25, y: 92 },
        panelId: "pov",
        source: { height: 282, width: 560 },
      },
      {
        cell: { height: 718, width: 1_148, x: 748, y: 92 },
        content: { height: 718, width: 1_146, x: 749, y: 92 },
        panelId: "laptop",
        source: { height: 447, width: 714 },
      },
    ]);
  });

  test("rejects overlapping cells", () => {
    expect(() => planContainedMosaic({
      canvas: { height: 100, width: 100 },
      panels: [
        { cell: { height: 60, width: 60, x: 0, y: 0 }, panelId: "first", source: { height: 10, width: 10 } },
        { cell: { height: 60, width: 60, x: 50, y: 40 }, panelId: "second", source: { height: 10, width: 10 } },
      ],
    })).toThrow(/overlap/u);
  });

  test("rejects duplicate IDs, cells outside the canvas, and odd canvases", () => {
    expect(() => planContainedMosaic({
      canvas: { height: 100, width: 100 },
      panels: [
        { cell: { height: 40, width: 40, x: 0, y: 0 }, panelId: "same", source: { height: 10, width: 10 } },
        { cell: { height: 40, width: 40, x: 60, y: 60 }, panelId: "same", source: { height: 10, width: 10 } },
      ],
    })).toThrow(/unique/u);
    expect(() => planContainedMosaic({
      canvas: { height: 100, width: 100 },
      panels: [
        { cell: { height: 20, width: 20, x: 90, y: 90 }, panelId: "outside", source: { height: 10, width: 10 } },
      ],
    })).toThrow(/exceeds/u);
    expect(() => planContainedMosaic({
      canvas: { height: 99, width: 100 },
      panels: [
        { cell: { height: 20, width: 20, x: 0, y: 0 }, panelId: "odd", source: { height: 10, width: 10 } },
      ],
    })).toThrow(/even/u);
  });
});

describe("montage sequence transitions", () => {
  test("maps clips contiguously and plans bounded symmetric fades", () => {
    const plan = planMontageSequence({
      clips: [
        { clipId: "intro", source: { endUs: 12_000_000, startUs: 2_000_000 } },
        { clipId: "short", source: { endUs: 30_400_000, startUs: 30_000_000 } },
        { clipId: "ending", source: { endUs: 50_000_000, startUs: 47_000_000 } },
      ],
      preferredTransitionDurationUs: 350_000,
    });

    expect(plan.durationUs).toBe(13_400_000);
    expect(plan.clips.map(clip => clip.output)).toEqual([
      { endUs: 10_000_000, startUs: 0 },
      { endUs: 10_400_000, startUs: 10_000_000 },
      { endUs: 13_400_000, startUs: 10_400_000 },
    ]);
    expect(plan.transitions).toEqual([
      {
        cutOutputUs: 10_000_000,
        durationUs: 200_000,
        fadeIn: { endUs: 10_200_000, startUs: 10_000_000 },
        fadeOut: { endUs: 10_000_000, startUs: 9_800_000 },
        fromClipId: "intro",
        kind: "dip-to-black",
        toClipId: "short",
      },
      {
        cutOutputUs: 10_400_000,
        durationUs: 200_000,
        fadeIn: { endUs: 10_600_000, startUs: 10_400_000 },
        fadeOut: { endUs: 10_400_000, startUs: 10_200_000 },
        fromClipId: "short",
        kind: "dip-to-black",
        toClipId: "ending",
      },
    ]);
  });

  test("rejects empty, inverted, and duplicate clip inputs", () => {
    expect(() => planMontageSequence({ clips: [], preferredTransitionDurationUs: 1 })).toThrow();
    expect(() => planMontageSequence({
      clips: [{ clipId: "bad", source: { endUs: 1, startUs: 1 } }],
      preferredTransitionDurationUs: 1,
    })).toThrow();
    expect(() => planMontageSequence({
      clips: [
        { clipId: "same", source: { endUs: 2, startUs: 1 } },
        { clipId: "same", source: { endUs: 4, startUs: 3 } },
      ],
      preferredTransitionDurationUs: 1,
    })).toThrow();
    expect(() => planMontageSequence({
      clips: [
        { clipId: "too-short", source: { endUs: 2, startUs: 1 } },
        { clipId: "neighbor", source: { endUs: 4, startUs: 2 } },
      ],
      preferredTransitionDurationUs: 1,
    })).toThrow(/at least two/u);
  });
});
