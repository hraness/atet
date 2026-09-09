import { describe, expect, test } from "bun:test";

import type { SpatialProjection } from "../../../src/spatial-scene/contracts";
import { IDENTITY_MATRIX, projectPoint } from "../../../src/spatial-scene/math";
import { assertProperty, fc } from "../testing/property";
import { decodeSpatialAxialDepth, spatialSelectionColor, spatialWebGlProjection } from "./spatial";

const finite = (min: number, max: number) => fc.double({ min, max, noNaN: true, noDefaultInfinity: true });

function projectedPixel(projection: SpatialProjection, point: readonly [number, number, number]) {
  const m = spatialWebGlProjection(projection);
  const x = m[0] * point[0] + m[4] * point[1] + m[8] * point[2] + m[12];
  const y = m[1] * point[0] + m[5] * point[1] + m[9] * point[2] + m[13];
  const w = m[3] * point[0] + m[7] * point[1] + m[11] * point[2] + m[15];
  return [(x / w + 1) * projection.width / 2, (1 - y / w) * projection.height / 2];
}

describe("spatial lowering algebra", () => {
  test("WebGL projection and calibrated optical projection agree for asymmetric cameras", () => {
    assertProperty(fc.property(
      fc.integer({ min: 32, max: 2_048 }), fc.integer({ min: 32, max: 2_048 }),
      finite(40, 2_000), finite(40, 2_000), finite(-30, 2_000), finite(-30, 2_000),
      finite(-10, 10), finite(-10, 10), finite(0.2, 100),
      (width, height, fx, fy, cx, cy, x, y, depth) => {
        const projection: SpatialProjection = { kind: "perspective", width, height, fx, fy, cx, cy, near: 0.1, far: 101 };
        const point: readonly [number, number, number] = [x, y, -depth];
        const expected = projectPoint({ cameraToWorld: IDENTITY_MATRIX, projection }, point)!;
        const actual = projectedPixel(projection, point);
        expect(actual[0]).toBeCloseTo(expected.pixel[0], 7);
        expect(actual[1]).toBeCloseTo(expected.pixel[1], 7);
      },
    ));
  });

  test("orthographic projection preserves off-center and non-square framing", () => {
    assertProperty(fc.property(
      finite(-100, 100), finite(-100, 100), finite(0.5, 50), finite(0.5, 50),
      finite(-100, 100), finite(-100, 100), finite(0.2, 100),
      (left, bottom, spanX, spanY, x, y, depth) => {
        const projection: SpatialProjection = { kind: "orthographic", width: 960, height: 540,
          left, bottom, right: left + spanX, top: bottom + spanY, near: 0.1, far: 101 };
        const point: readonly [number, number, number] = [x, y, -depth];
        const expected = projectPoint({ cameraToWorld: IDENTITY_MATRIX, projection }, point)!;
        const actual = projectedPixel(projection, point);
        expect(actual[0]).toBeCloseTo(expected.pixel[0], 7);
        expect(actual[1]).toBeCloseTo(expected.pixel[1], 7);
      },
    ));
  });

  test("selection encoding is injective and reserves black for no-hit", () => {
    assertProperty(fc.property(fc.integer({ min: 1, max: 4_096 }), id => {
      const bytes = spatialSelectionColor(id);
      expect(bytes[0] * 65_536 + bytes[1] * 256 + bytes[2]).toBe(id);
      expect(bytes.some(byte => byte !== 0)).toBe(true);
    }));
  });

  test("24-bit axial quantization round trips within one interval step", () => {
    assertProperty(fc.property(finite(0.001, 2), finite(3, 100_000), finite(0, 1), (near, far, fraction) => {
      const expected = near + fraction * (far - near);
      const code = 1 + Math.round(fraction * 16_777_214);
      const decoded = decodeSpatialAxialDepth([Math.floor(code / 65_536), Math.floor(code / 256) % 256, code % 256, 255], near, far)!;
      expect(Math.abs(decoded - expected)).toBeLessThanOrEqual((far - near) / 16_777_214 + 1e-10);
      expect(decoded).toBeGreaterThanOrEqual(near);
      expect(decoded).toBeLessThanOrEqual(far);
    }));
  });
});
