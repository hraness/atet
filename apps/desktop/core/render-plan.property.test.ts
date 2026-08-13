import { expect } from "bun:test";
import { assertProperty, fc } from "../testing/property";

import { TrackIdSchema } from "../contracts/recording";
import { normalizeEditPlan } from "./plan";
import { compileRenderPlan } from "./render-plan";
import { testManifest, testPlan } from "./test-support";

assertProperty(fc.property(
  fc.double({ min: 0, max: 1920, noNaN: true }),
  fc.double({ min: 0, max: 1080, noNaN: true }),
  fc.double({ min: 1, max: 10, noNaN: true }),
  (x, y, scale) => {
    const plan = normalizeEditPlan({
      ...testPlan(),
      zooms: [{
        displayId: "display-primary",
        easing: { kind: "linear" },
        enterDurationUs: 0,
        exitDurationUs: 0,
        kind: "manual",
        range: { endUs: 2_000, startUs: 1_000 },
        scale,
        target: { kind: "point", point: { x, y } },
        zoomId: "zoom_property1",
      }],
    });
    const render = compileRenderPlan(testManifest(), plan, [], {
      audioTrackIds: [],
      camera: { kind: "none" },
      displayTrackId: TrackIdSchema.parse("track_display01"),
      frameRate: 60,
      pixelHeight: 1080,
      pixelWidth: 1920,
    });
    for (const { viewport } of render.cameraKeyframes) {
      expect(viewport.x).toBeGreaterThanOrEqual(0);
      expect(viewport.y).toBeGreaterThanOrEqual(0);
      expect(viewport.x + viewport.width).toBeLessThanOrEqual(1920 + Number.EPSILON * 1920);
      expect(viewport.y + viewport.height).toBeLessThanOrEqual(1080 + Number.EPSILON * 1080);
      expect(viewport.width / viewport.height).toBeCloseTo(16 / 9, 10);
    }
  },
));
