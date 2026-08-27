import { expect } from "bun:test";
import { assertProperty, fc } from "../testing/property";

import { planContainedMosaic, planMontageSequence } from "./montage";

assertProperty(fc.property(
  fc.integer({ min: 1, max: 8_192 }),
  fc.integer({ min: 1, max: 8_192 }),
  fc.nat(),
  fc.nat(),
  (canvasWidthUnits, canvasHeightUnits, sourceWidthSeed, sourceHeightSeed) => {
    const canvas = {
      height: canvasHeightUnits * 2,
      width: canvasWidthUnits * 2,
    };
    const source = {
      height: 2 * (1 + sourceHeightSeed % canvasHeightUnits),
      width: 2 * (1 + sourceWidthSeed % canvasWidthUnits),
    };
    const panel = planContainedMosaic({
      canvas,
      panels: [{
        cell: { ...canvas, x: 0, y: 0 },
        panelId: "property-panel",
        source,
      }],
    }).panels[0];

    expect(panel).toBeDefined();
    if (panel === undefined) return;
    expect(panel.content.width).toBeGreaterThanOrEqual(2);
    expect(panel.content.height).toBeGreaterThanOrEqual(2);
    expect(panel.content.width % 2).toBe(0);
    expect(panel.content.height % 2).toBe(0);
    expect(panel.content.x).toBeGreaterThanOrEqual(panel.cell.x);
    expect(panel.content.y).toBeGreaterThanOrEqual(panel.cell.y);
    expect(panel.content.x + panel.content.width)
      .toBeLessThanOrEqual(panel.cell.x + panel.cell.width);
    expect(panel.content.y + panel.content.height)
      .toBeLessThanOrEqual(panel.cell.y + panel.cell.height);
  },
));

assertProperty(fc.property(
  fc.array(fc.integer({ min: 2, max: 1_000_000 }), { minLength: 1, maxLength: 64 }),
  fc.integer({ min: 1, max: 5_000_000 }),
  (durationsUs, preferredTransitionDurationUs) => {
    const plan = planMontageSequence({
      clips: durationsUs.map((durationUs, index) => ({
        clipId: `clip-${String(index)}`,
        source: {
          endUs: index * 2_000_000 + durationUs,
          startUs: index * 2_000_000,
        },
      })),
      preferredTransitionDurationUs,
    });

    expect(plan.durationUs).toBe(
      durationsUs.reduce((total, durationUs) => total + durationUs, 0),
    );
    expect(plan.transitions).toHaveLength(Math.max(0, durationsUs.length - 1));
    for (let index = 0; index < plan.clips.length; index += 1) {
      const clip = plan.clips[index];
      const durationUs = durationsUs[index];
      const previous = plan.clips[index - 1];
      const expectedStartUs = index === 0 ? 0 : previous?.output.endUs;
      expect(clip).toBeDefined();
      expect(durationUs).toBeDefined();
      expect(expectedStartUs).toBeDefined();
      if (clip === undefined || durationUs === undefined || expectedStartUs === undefined) continue;
      expect(clip.output.startUs).toBe(expectedStartUs);
      expect(clip.output.endUs - clip.output.startUs).toBe(durationUs);
    }
    for (let index = 0; index < plan.transitions.length; index += 1) {
      const transition = plan.transitions[index];
      const fromDurationUs = durationsUs[index];
      const toDurationUs = durationsUs[index + 1];
      expect(transition).toBeDefined();
      expect(fromDurationUs).toBeDefined();
      expect(toDurationUs).toBeDefined();
      if (
        transition === undefined
        || fromDurationUs === undefined
        || toDurationUs === undefined
      ) continue;
      expect(transition.durationUs).toBeLessThanOrEqual(preferredTransitionDurationUs);
      expect(transition.durationUs).toBeLessThanOrEqual(Math.floor(fromDurationUs / 2));
      expect(transition.durationUs).toBeLessThanOrEqual(Math.floor(toDurationUs / 2));
      expect(transition.fadeOut.endUs).toBe(transition.cutOutputUs);
      expect(transition.fadeIn.startUs).toBe(transition.cutOutputUs);
    }
  },
));
