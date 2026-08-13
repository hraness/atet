import { expect } from "bun:test";
import { assertProperty, fc } from "../testing/property";

import type { CameraPose } from "../contracts";
import {
  cameraPoseToNormalizedViewport,
  interpolateCameraPose,
} from "./project-camera";

const poseArbitrary = fc.double({ min: 1, max: 10, noNaN: true }).chain(zoom => {
  const half = 1 / (2 * zoom);
  return fc.record({
    centerX: fc.double({ min: half, max: 1 - half, noNaN: true }),
    centerY: fc.double({ min: half, max: 1 - half, noNaN: true }),
    space: fc.constant("prepared-video-layer-normalized-v1" as const),
    zoom: fc.constant(zoom),
  });
});

assertProperty(fc.property(
  poseArbitrary,
  poseArbitrary,
  fc.double({ min: 0, max: 1, noNaN: true }),
  fc.constantFrom("linear", "ease-in", "ease-out", "ease-in-out"),
  (from: CameraPose, to: CameraPose, progress, kind) => {
    const pose = interpolateCameraPose(from, to, { kind }, progress);
    const viewport = cameraPoseToNormalizedViewport(pose);
    expect(Number.isFinite(pose.zoom)).toBe(true);
    expect(pose.zoom).toBeGreaterThanOrEqual(1);
    expect(pose.zoom).toBeLessThanOrEqual(10);
    expect(viewport.x).toBeGreaterThanOrEqual(-1e-12);
    expect(viewport.y).toBeGreaterThanOrEqual(-1e-12);
    expect(viewport.x + viewport.width).toBeLessThanOrEqual(1 + 1e-12);
    expect(viewport.y + viewport.height).toBeLessThanOrEqual(1 + 1e-12);
  },
));
