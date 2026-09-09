import { describe, expect, test } from "bun:test";
import {
  IDENTITY_MATRIX, MAX_ABS_COMPONENT, MAX_IMAGE_DIMENSION,
  composeTransform, invertTransform, multiplyTransforms, normalizeQuaternion,
  pixelRay, projectPoint, slerpQuaternion, transformBounds, transformDirection,
  transformPoint, unprojectPixel,
  type Camera, type Mat4, type Orthographic, type Perspective, type Quaternion,
  type Transform, type Vec2, type Vec3,
} from "./math.js";

function close(actual: number, expected: number, tolerance = 1e-9): void {
  if (!Number.isFinite(actual) || Math.abs(actual-expected) > tolerance*Math.max(1, Math.abs(expected))) {
    throw new Error(`expected ${actual} ≈ ${expected} within relative/absolute ${tolerance}`);
  }
}

function vector(actual: readonly number[], expected: readonly number[], tolerance = 1e-9): void {
  expect(actual.length).toBe(expected.length);
  actual.forEach((value, index) => close(value, expected[index]!, tolerance));
}

const IDENTITY_Q: Quaternion = [0, 0, 0, 1];
const UNIT_SCALE: Vec3 = [1, 1, 1];
const perspective: Perspective = Object.freeze({ kind: "perspective", width: 960, height: 540,
  fx: 800, fy: 700, cx: 411, cy: 287, near: 0.5, far: 20 });
const orthographic: Orthographic = Object.freeze({ kind: "orthographic", width: 800, height: 200,
  left: -2, right: 6, bottom: -3, top: 1, near: 0.5, far: 20 });
const perspectiveCamera: Camera = Object.freeze({ projection: perspective, cameraToWorld: IDENTITY_MATRIX });
const orthographicCamera: Camera = Object.freeze({ projection: orthographic, cameraToWorld: IDENTITY_MATRIX });

function axisAngle(axis: Vec3, radians: number): Quaternion {
  const length = Math.hypot(...axis), sine = Math.sin(radians/2);
  return [axis[0]/length*sine, axis[1]/length*sine, axis[2]/length*sine, Math.cos(radians/2)];
}

function trs(position: Vec3 = [0, 0, 0], rotation: Quaternion = IDENTITY_Q, scale: Vec3 = UNIT_SCALE): Mat4 {
  return composeTransform({ position, rotation, scale });
}

function along(origin: Vec3, direction: Vec3, distance: number): Vec3 {
  return [origin[0]+direction[0]*distance, origin[1]+direction[1]*distance, origin[2]+direction[2]*distance];
}

// Fixed-seed LCG. Every sample is reproducible; no global/ambient random state.
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state/0x100000000; };
}

describe("affine transforms and quaternion convention", () => {
  test("column-major T*R*S agrees with an asymmetric right-handed construction", () => {
    const matrix = trs([10, 20, 30], axisAngle([0, 1, 0], Math.PI/2), [2, 3, 4]);
    vector(matrix.slice(12, 15), [10, 20, 30]);
    vector(transformPoint(matrix, [1, 2, 3]), [22, 26, 28]);
    vector(transformDirection(matrix, [1, 2, 3]), [12, 6, -2]);
    vector(transformPoint(invertTransform(matrix), [22, 26, 28]), [1, 2, 3]);
    vector(transformPoint(trs([0, 0, 0], axisAngle([1, 0, 0], Math.PI/2)), [0, 1, 0]), [0, 0, 1]);
    vector(transformPoint(trs([0, 0, 0], axisAngle([0, 0, 1], Math.PI/2)), [1, 0, 0]), [0, 1, 0]);
  });

  test("parent scale plus child rotation retains shear instead of lossy TRS decomposition", () => {
    const parent = trs([3, -5, 7], IDENTITY_Q, [2, 1, 1]);
    const child = trs([1, 2, 3], axisAngle([0, 0, 1], Math.PI/4));
    const composed = multiplyTransforms(parent, child);
    const basisDot = composed[0]*composed[4] + composed[1]*composed[5] + composed[2]*composed[6];
    close(basisDot, -1.5);
    vector(transformPoint(composed, [2, -4, 1]), transformPoint(parent, transformPoint(child, [2, -4, 1])));
    vector(multiplyTransforms(invertTransform(composed), composed), IDENTITY_MATRIX);
    expect(() => projectPoint({ projection: perspective, cameraToWorld: composed }, [1, 2, -3])).toThrow(RangeError);
  });

  test("seeded affine compositions, reflections, and inverse round trips", () => {
    const random = seeded(0xa7e70001);
    const randomVec = (): Vec3 => [random()*20-10, random()*20-10, random()*20-10];
    for (let index = 0; index < 256; index++) {
      const parent = trs(randomVec(), axisAngle(randomVec(), random()*Math.PI*2),
        [0.25+random()*3, 0.25+random()*3, (index%2 ? -1 : 1)*(0.25+random()*3)]);
      const local = trs(randomVec(), axisAngle(randomVec(), random()*Math.PI*2), [0.25+random()*3, 0.25+random()*3, 0.25+random()*3]);
      const point = randomVec(), matrix = multiplyTransforms(parent, local), inverse = invertTransform(matrix);
      vector(transformPoint(matrix, point), transformPoint(parent, transformPoint(local, point)), 1e-8);
      vector(transformPoint(inverse, transformPoint(matrix, point)), point, 1e-8);
      vector(multiplyTransforms(matrix, inverse), IDENTITY_MATRIX, 1e-8);
      vector(multiplyTransforms(inverse, matrix), IDENTITY_MATRIX, 1e-8);
    }
  });

  test("shortest-arc slerp handles q/-q, endpoints, normalization, and near-coincident inputs", () => {
    const q = axisAngle([1, -2, 3], 2.1), minusQ = q.map((value) => -value) as unknown as Quaternion;
    for (const t of [0, 0.001, 0.2, 0.5, 0.999, 1]) {
      const interpolated = slerpQuaternion(q, minusQ, t);
      close(Math.hypot(...interpolated), 1);
      vector(trs([0, 0, 0], interpolated), trs([0, 0, 0], q));
    }
    const midpoint = slerpQuaternion(IDENTITY_Q, [0, 1, 0, 0], 0.5);
    vector(transformDirection(trs([0, 0, 0], midpoint), [0, 0, -1]), [-1, 0, 0]);
    vector(normalizeQuaternion([0, 0, 0, 7]), IDENTITY_Q);
    const closeRotation = axisAngle([0, 1, 0], 1e-7);
    close(Math.hypot(...slerpQuaternion(IDENTITY_Q, closeRotation, 0.5)), 1);
    vector(trs([0, 0, 0], slerpQuaternion(q, IDENTITY_Q, 0)), trs([0, 0, 0], q));
    vector(trs([0, 0, 0], slerpQuaternion(q, IDENTITY_Q, 1)), IDENTITY_MATRIX);
  });
});

describe("projection, image coordinates, and axial depth", () => {
  test("off-center asymmetric calibration uses top-left boundary coordinates", () => {
    const projected = projectPoint(perspectiveCamera, [1, 0.5, -4])!;
    vector(projected.pixel, [611, 199.5]);
    expect(projected.depthMeters).toBe(4);
    expect(projected.insideClip).toBe(true);
    expect(projected.insideImage).toBe(true);
    vector(unprojectPixel(perspectiveCamera, projected.pixel, projected.depthMeters), [1, 0.5, -4]);
    vector(projectPoint(perspectiveCamera, [0, 0, -5])!.pixel, [411, 287]);
    const tiny: Camera = { projection: { ...perspective, width: 4, height: 2, fx: 4, fy: 4, cx: 2, cy: 1 }, cameraToWorld: IDENTITY_MATRIX };
    vector(unprojectPixel(tiny, [0.5, 0.5], 2), [-0.75, 0.25, -2]);
    vector(projectPoint(tiny, [-0.75, 0.25, -2])!.pixel, [0.5, 0.5]);
  });

  test("clip boundaries are inclusive, image boundaries half-open, behind-plane is null", () => {
    for (const [depth, inside] of [[0.49, false], [0.5, true], [20, true], [20.001, false]] as const) {
      for (const view of [perspectiveCamera, orthographicCamera]) {
        expect(projectPoint(view, [0, 0, -depth])!.insideClip).toBe(inside);
      }
    }
    // Binary-rational intrinsics make the exact boundary representable. General
    // round trips are approximate and must not imply undocumented edge snapping.
    const binaryPerspective: Camera = { projection: { ...perspective, width: 512, height: 256, fx: 512, fy: 512, cx: 256, cy: 128 }, cameraToWorld: IDENTITY_MATRIX };
    for (const view of [binaryPerspective, orthographicCamera]) {
      expect(projectPoint(view, [0, 0, 0])).toBeNull();
      expect(projectPoint(view, [0, 0, 1])).toBeNull();
      expect(projectPoint(view, unprojectPixel(view, [0, 0], 2))!.insideImage).toBe(true);
      expect(projectPoint(view, unprojectPixel(view, [view.projection.width, view.projection.height], 2))!.insideImage).toBe(false);
      expect(projectPoint(view, unprojectPixel(view, [-1, 0], 2))!.insideImage).toBe(false);
    }
  });

  test("aspect/resolution changes require explicit intrinsics and do not recenter calibration", () => {
    const point: Vec3 = [1, -0.75, -4];
    const original = projectPoint(perspectiveCamera, point)!;
    const twiceWide: Camera = { projection: { ...perspective, width: 1920, fx: 1600, cx: 822 }, cameraToWorld: IDENTITY_MATRIX };
    vector(projectPoint(twiceWide, point)!.pixel, [original.pixel[0]*2, original.pixel[1]]);
    const widerViewport: Camera = { projection: { ...perspective, width: 1920 }, cameraToWorld: IDENTITY_MATRIX };
    vector(projectPoint(widerViewport, point)!.pixel, original.pixel);
    const narrower: Camera = { projection: { ...perspective, width: 600 }, cameraToWorld: IDENTITY_MATRIX };
    expect(projectPoint(narrower, point)!.insideImage).toBe(false);
  });

  test("rotated parent and camera roll preserve physical world pose and axial meters", () => {
    const parent = trs([10, 20, 30], axisAngle([0, 1, 0], Math.PI/2));
    const local = trs([1, 2, 3], axisAngle([0, 0, 1], Math.PI/2));
    const view: Camera = { projection: perspective, cameraToWorld: multiplyTransforms(parent, local) };
    vector(transformPoint(view.cameraToWorld, [0, 0, 0]), [13, 22, 29]);
    const projected = projectPoint(view, [8, 22, 29])!;
    vector(projected.pixel, [411, 287]);
    close(projected.depthMeters, 5);
    vector(unprojectPixel(view, [411, 287], 5), [8, 22, 29]);
    vector(pixelRay(view, [411, 287]).direction, [-1, 0, 0]);
  });

  test("orthographic asymmetric extents have constant scale and parallel displaced rays", () => {
    vector(projectPoint(orthographicCamera, [2, -1, -4])!.pixel, [400, 100]);
    vector(projectPoint(orthographicCamera, [1.25, -0.75, -8])!.pixel, [325, 87.5]);
    vector(projectPoint(orthographicCamera, [1.25, -0.75, -2])!.pixel, [325, 87.5]);
    const a = pixelRay(orthographicCamera, [0, 0]), b = pixelRay(orthographicCamera, [800, 200]);
    vector(a.origin, [-2, 1, 0]);
    vector(b.origin, [6, -3, 0]);
    vector(a.direction, [0, 0, -1]);
    vector(b.direction, a.direction);
    expect(a.nearDistanceMeters).toBe(0.5);
    expect(a.farDistanceMeters).toBe(20);
  });

  test("perspective rays distinguish distance along ray from axial clipping depth", () => {
    const view: Camera = { projection: { ...perspective, fx: 1, fy: 1, cx: 0, cy: 0, near: 2, far: 10 }, cameraToWorld: IDENTITY_MATRIX };
    const ray = pixelRay(view, [3, 4]);
    vector(ray.origin, [0, 0, 0]);
    vector(ray.direction, [3/Math.sqrt(26), -4/Math.sqrt(26), -1/Math.sqrt(26)]);
    close(Math.hypot(...ray.direction), 1);
    close(ray.nearDistanceMeters, 2*Math.sqrt(26));
    close(ray.farDistanceMeters, 10*Math.sqrt(26));
    vector(along(ray.origin, ray.direction, ray.nearDistanceMeters), unprojectPixel(view, [3, 4], 2));
    vector(along(ray.origin, ray.direction, ray.farDistanceMeters), unprojectPixel(view, [3, 4], 10));
    expect(projectPoint(view, unprojectPixel(view, [3, 4], 2))!.depthMeters).toBe(2);
  });

  test("seeded perspective/orthographic project-unproject and ray intersections through rigid hierarchies", () => {
    const random = seeded(0xa7e70002);
    for (let index = 0; index < 256; index++) {
      const parent = trs([random()*30-15, random()*30-15, random()*30-15], axisAngle([0.2+random(), random()-0.5, random()-0.5], random()*Math.PI*2));
      const local = trs([random()*3, -random()*5, random()*2], axisAngle([random()-0.5, 0.2+random(), random()-0.5], random()*Math.PI*2));
      const view: Camera = { projection: index%2 ? perspective : orthographic, cameraToWorld: multiplyTransforms(parent, local) };
      const pixel: Vec2 = [random()*view.projection.width, random()*view.projection.height];
      const depth = 0.6+random()*18;
      const world = unprojectPixel(view, pixel, depth), projected = projectPoint(view, world)!;
      vector(projected.pixel, pixel, 1e-8);
      close(projected.depthMeters, depth, 1e-8);
      expect(projected.insideClip).toBe(true);
      const ray = pixelRay(view, pixel);
      close(Math.hypot(...ray.direction), 1);
      vector(along(ray.origin, ray.direction, ray.nearDistanceMeters), unprojectPixel(view, pixel, view.projection.near), 1e-8);
      vector(along(ray.origin, ray.direction, ray.farDistanceMeters), unprojectPixel(view, pixel, view.projection.far), 1e-8);
    }
  });
});

describe("bounds, validation, and immutability", () => {
  test("asymmetric bounds with rotated negative scale enclose every transformed corner", () => {
    const m = trs([10, 20, 30], axisAngle([0, 1, 0], Math.PI/2), [2, 3, -4]);
    const bounds = transformBounds(m, { min: [-1, -2, -3], max: [2, 4, 5] });
    vector(bounds.min, [-10, 14, 26]);
    vector(bounds.max, [22, 32, 32]);
    const random = seeded(0xa7e70003);
    for (let index = 0; index < 256; index++) {
      const transformed = transformPoint(m, [-1+random()*3, -2+random()*6, -3+random()*8]);
      transformed.forEach((value, axis) => {
        expect(value).toBeGreaterThanOrEqual(bounds.min[axis]! - 1e-10);
        expect(value).toBeLessThanOrEqual(bounds.max[axis]! + 1e-10);
      });
    }
    const collapsed = transformBounds(trs([2, 3, 4], IDENTITY_Q, [0, 0, 0]), { min: [-1, -2, -3], max: [2, 4, 5] });
    vector(collapsed.min, [2, 3, 4]);
    vector(collapsed.max, [2, 3, 4]);
  });

  test("rejects nonfinite, unbounded, malformed, singular, and nonrigid inputs", () => {
    const invalid: (() => unknown)[] = [
      () => normalizeQuaternion([0, 0, 0, 0]),
      () => normalizeQuaternion([NaN, 0, 0, 1]),
      () => normalizeQuaternion([0, 0, 1] as unknown as Quaternion),
      () => trs([MAX_ABS_COMPONENT+1, 0, 0]),
      () => transformPoint(IDENTITY_MATRIX, [Infinity, 0, 0]),
      () => transformPoint([...IDENTITY_MATRIX.slice(0, 15)] as unknown as Mat4, [0, 0, 0]),
      () => transformPoint(IDENTITY_MATRIX.map((value, index) => index === 3 ? 0.1 : value) as unknown as Mat4, [0, 0, 0]),
      () => invertTransform(trs([0, 0, 0], IDENTITY_Q, [0, 1, 1])),
      () => invertTransform(trs([0, 0, 0], IDENTITY_Q, [1e-14, 1, 1])),
      () => slerpQuaternion(IDENTITY_Q, IDENTITY_Q, -0.1),
      () => slerpQuaternion(IDENTITY_Q, IDENTITY_Q, 1.1),
      () => slerpQuaternion(IDENTITY_Q, IDENTITY_Q, NaN),
      () => projectPoint({ ...perspectiveCamera, cameraToWorld: trs([0, 0, 0], IDENTITY_Q, [2, 2, 2]) }, [0, 0, -1]),
      () => projectPoint({ ...perspectiveCamera, cameraToWorld: trs([0, 0, 0], IDENTITY_Q, [-1, 1, 1]) }, [0, 0, -1]),
      () => unprojectPixel(perspectiveCamera, [0, 0], 0),
      () => unprojectPixel(perspectiveCamera, [0, 0], -1),
      () => pixelRay(perspectiveCamera, [NaN, 0]),
      () => transformBounds(IDENTITY_MATRIX, { min: [1, 0, 0], max: [0, 1, 1] }),
    ];
    for (const patch of [{ width: 0 }, { width: 1.5 }, { width: MAX_IMAGE_DIMENSION+1 }, { height: NaN },
      { near: 0 }, { far: 0.25 }, { far: Infinity }, { fx: 0 }, { fy: -1 }, { cx: NaN }]) {
      invalid.push(() => projectPoint({ ...perspectiveCamera, projection: { ...perspective, ...patch } }, [0, 0, -1]));
    }
    invalid.push(() => pixelRay({ ...orthographicCamera, projection: { ...orthographic, right: -3 } }, [0, 0]));
    invalid.forEach((operation) => expect(operation).toThrow(RangeError));
  });

  test("does not mutate authored inputs and returns frozen values", () => {
    const input: Transform = Object.freeze({ position: Object.freeze([1, 2, 3] as const),
      rotation: Object.freeze([0, 0, 0, 2] as const), scale: Object.freeze([1, 1, 1] as const) });
    const before = JSON.stringify(input), m = composeTransform(input);
    const projected = projectPoint(perspectiveCamera, [1, 2, -5])!;
    const ray = pixelRay(perspectiveCamera, [1, 2]);
    const bounds = transformBounds(m, { min: [0, 0, 0], max: [1, 1, 1] });
    expect(JSON.stringify(input)).toBe(before);
    for (const output of [m, transformPoint(m, [1, 2, 3]), invertTransform(m), slerpQuaternion(input.rotation, IDENTITY_Q, 0.3),
      projected, projected.pixel, ray, ray.origin, ray.direction, bounds, bounds.min, bounds.max]) expect(Object.isFrozen(output)).toBe(true);
  });
});
