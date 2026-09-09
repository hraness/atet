import type { SpatialCamera } from "./contracts.js"

/**
 * Portable affine and calibrated-camera math.
 * Right-handed meters, Y-up; cameras face local -Z. Column vectors, column-major
 * matrices, quaternion [x,y,z,w]. Pixel origin is the top-left image boundary;
 * pixel (i,j)'s center is [i + 0.5, j + 0.5]. No distortion or implicit resize.
 */
export type Vec2 = readonly [number, number];
export type Vec3 = readonly [number, number, number];
export type Quaternion = readonly [number, number, number, number];
export type Mat4 = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];
export type Transform = Readonly<{ position: Vec3; rotation: Quaternion; scale: Vec3 }>;
type View = Readonly<{ width: number; height: number; near: number; far: number }>;
export type Perspective = View & Readonly<{ kind: "perspective"; fx: number; fy: number; cx: number; cy: number }>;
export type Orthographic = View & Readonly<{ kind: "orthographic"; left: number; right: number; bottom: number; top: number }>;
export type Projection = Perspective | Orthographic;
export type Camera = Readonly<{ projection: Projection; cameraToWorld: Mat4 }>;
export type ProjectedPoint = Readonly<{ pixel: Vec2; depthMeters: number; insideImage: boolean; insideClip: boolean }>;
export type Ray = Readonly<{ origin: Vec3; direction: Vec3; nearDistanceMeters: number; farDistanceMeters: number }>;
export type Bounds = Readonly<{ min: Vec3; max: Vec3 }>;

// Explicit numerical guardrails for intermediate affine calculations.
export const MAX_ABS_COMPONENT = 1e12;
export const MAX_IMAGE_DIMENSION = 1_000_000;
const AFFINE_TOLERANCE = 1e-12;
const RIGID_TOLERANCE = 1e-8;
const MIN_RELATIVE_DETERMINANT = 1e-12;

function number(value: number, label: string): number {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_ABS_COMPONENT) {
    throw new RangeError(`${label} must be finite with magnitude <= ${MAX_ABS_COMPONENT}`);
  }
  return value;
}

function values(value: readonly number[], length: number, label: string): void {
  if (!Array.isArray(value) || value.length !== length) throw new RangeError(`${label} must have ${length} components`);
  for (let index = 0; index < length; index++) number(value[index]!, `${label}[${index}]`);
}

function vec2(x: number, y: number): Vec2 {
  return Object.freeze([number(x, "x"), number(y, "y")]);
}

function vec3(x: number, y: number, z: number): Vec3 {
  return Object.freeze([number(x, "x"), number(y, "y"), number(z, "z")]);
}

function matrix(value: number[]): Mat4 {
  values(value, 16, "matrix");
  return Object.freeze(value) as unknown as Mat4;
}

function affine(value: Mat4): void {
  values(value, 16, "transform");
  if (Math.abs(value[3]) > AFFINE_TOLERANCE || Math.abs(value[7]) > AFFINE_TOLERANCE
    || Math.abs(value[11]) > AFFINE_TOLERANCE || Math.abs(value[15] - 1) > AFFINE_TOLERANCE) {
    throw new RangeError("transform must be affine with bottom row [0,0,0,1]");
  }
}

export const IDENTITY_MATRIX: Mat4 = matrix([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** Normalizes nonzero input, without selecting an arbitrary quaternion sign. */
export function normalizeQuaternion(q: Quaternion): Quaternion {
  values(q, 4, "quaternion");
  const length = Math.hypot(...q);
  if (length === 0) throw new RangeError("quaternion must be nonzero");
  return Object.freeze([q[0] / length, q[1] / length, q[2] / length, q[3] / length]);
}

/** T * R * S: scale in local axes, rotate, then translate. Zero scale is allowed. */
export function composeTransform(transform: Transform): Mat4 {
  values(transform.position, 3, "position");
  values(transform.scale, 3, "scale");
  const [x, y, z, w] = normalizeQuaternion(transform.rotation);
  const [sx, sy, sz] = transform.scale;
  return matrix([
    (1 - 2 * (y*y + z*z)) * sx, 2 * (x*y + z*w) * sx, 2 * (x*z - y*w) * sx, 0,
    2 * (x*y - z*w) * sy, (1 - 2 * (x*x + z*z)) * sy, 2 * (y*z + x*w) * sy, 0,
    2 * (x*z + y*w) * sz, 2 * (y*z - x*w) * sz, (1 - 2 * (x*x + y*y)) * sz, 0,
    ...transform.position, 1,
  ]);
}

/** Parent * local; preserves affine shear introduced by a scaled parent. */
export function multiplyTransforms(parent: Mat4, local: Mat4): Mat4 {
  affine(parent);
  affine(local);
  const output = new Array<number>(16).fill(0);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 3; row++) {
      output[col * 4 + row] = parent[row]! * local[col * 4]!
        + parent[4 + row]! * local[col * 4 + 1]!
        + parent[8 + row]! * local[col * 4 + 2]!
        + (col === 3 ? parent[12 + row]! : 0);
    }
  }
  output[15] = 1;
  return matrix(output);
}

/**
 * Inverts an affine transform including shear/reflection. Rejects singular and
 * ill-conditioned bases: determinant after scaling by max basis entry <= 1e-12.
 */
export function invertTransform(transform: Mat4): Mat4 {
  affine(transform);
  const scale = Math.max(...[0, 1, 2, 4, 5, 6, 8, 9, 10].map((index) => Math.abs(transform[index]!)));
  if (scale === 0) throw new RangeError("transform is singular");
  const [a, b, c, d, e, f, g, h, i] = [0, 4, 8, 1, 5, 9, 2, 6, 10].map((index) => transform[index]! / scale) as [number, number, number, number, number, number, number, number, number];
  const det = a*(e*i-f*h) - b*(d*i-f*g) + c*(d*h-e*g);
  if (Math.abs(det) <= MIN_RELATIVE_DETERMINANT) throw new RangeError("transform is singular or ill-conditioned");
  const factor = 1 / det / scale;
  const r00 = (e*i-f*h)*factor, r01 = (c*h-b*i)*factor, r02 = (b*f-c*e)*factor;
  const r10 = (f*g-d*i)*factor, r11 = (a*i-c*g)*factor, r12 = (c*d-a*f)*factor;
  const r20 = (d*h-e*g)*factor, r21 = (b*g-a*h)*factor, r22 = (a*e-b*d)*factor;
  const [tx, ty, tz] = [transform[12], transform[13], transform[14]];
  return matrix([
    r00, r10, r20, 0, r01, r11, r21, 0, r02, r12, r22, 0,
    -(r00*tx+r01*ty+r02*tz), -(r10*tx+r11*ty+r12*tz), -(r20*tx+r21*ty+r22*tz), 1,
  ]);
}

export function transformPoint(transform: Mat4, point: Vec3): Vec3 {
  affine(transform);
  values(point, 3, "point");
  return apply(transform, point, true);
}

/** Transforms a displacement/direction; does not normalize it or transform normals. */
export function transformDirection(transform: Mat4, direction: Vec3): Vec3 {
  affine(transform);
  values(direction, 3, "direction");
  return apply(transform, direction, false);
}

function apply(m: Mat4, v: Vec3, translate: boolean): Vec3 {
  return vec3(
    m[0]*v[0] + m[4]*v[1] + m[8]*v[2] + (translate ? m[12] : 0),
    m[1]*v[0] + m[5]*v[1] + m[9]*v[2] + (translate ? m[13] : 0),
    m[2]*v[0] + m[6]*v[1] + m[10]*v[2] + (translate ? m[14] : 0),
  );
}

/** Shortest-arc interpolation; q and -q describe the same rotation. t in [0,1]. */
export function slerpQuaternion(from: Quaternion, to: Quaternion, t: number): Quaternion {
  number(t, "t");
  if (t < 0 || t > 1) throw new RangeError("t must be in [0,1]");
  const a = normalizeQuaternion(from);
  const normalizedTo = normalizeQuaternion(to);
  let dot = a.reduce((sum, value, index) => sum + value * normalizedTo[index]!, 0);
  const b = dot < 0 ? normalizedTo.map((value) => -value) : normalizedTo;
  dot = Math.min(1, Math.max(0, Math.abs(dot)));
  let left = 1 - t, right = t;
  if (dot < 0.9995) {
    const angle = Math.acos(dot), sine = Math.sin(angle);
    left = Math.sin((1-t)*angle) / sine;
    right = Math.sin(t*angle) / sine;
  }
  return normalizeQuaternion([
    left*a[0] + right*b[0]!, left*a[1] + right*b[1]!,
    left*a[2] + right*b[2]!, left*a[3] + right*b[3]!,
  ]);
}

function projection(p: Projection): void {
  for (const value of [p.width, p.height]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_IMAGE_DIMENSION) throw new RangeError("image dimensions must be positive bounded integers");
  }
  number(p.near, "near");
  number(p.far, "far");
  if (p.near <= 0 || p.far <= p.near) throw new RangeError("clipping requires 0 < near < far");
  if (p.kind === "perspective") {
    for (const key of ["fx", "fy", "cx", "cy"] as const) number(p[key], key);
    if (p.fx <= 0 || p.fy <= 0) throw new RangeError("focal lengths in pixels must be positive");
  } else if (p.kind === "orthographic") {
    for (const key of ["left", "right", "bottom", "top"] as const) number(p[key], key);
    if (p.left >= p.right || p.bottom >= p.top) throw new RangeError("orthographic extents must be ordered");
  } else {
    throw new RangeError("unsupported projection");
  }
}

/** Camera scale/shear/reflection would change the meaning of axial-meter depth. */
function camera(camera: Camera): void {
  projection(camera.projection);
  const m = camera.cameraToWorld;
  affine(m);
  const columns: Vec3[] = [[m[0], m[1], m[2]], [m[4], m[5], m[6]], [m[8], m[9], m[10]]];
  for (let i = 0; i < 3; i++) {
    for (let j = i; j < 3; j++) {
      const dot = columns[i]!.reduce((sum, value, index) => sum + value*columns[j]![index]!, 0);
      if (Math.abs(dot - (i === j ? 1 : 0)) > RIGID_TOLERANCE) throw new RangeError("camera pose must be rigid without scale or shear");
    }
  }
  const determinant = m[0]*(m[5]*m[10]-m[9]*m[6]) - m[4]*(m[1]*m[10]-m[9]*m[2]) + m[8]*(m[1]*m[6]-m[5]*m[2]);
  if (determinant <= 0) throw new RangeError("camera pose must preserve handedness");
}

/**
 * Returns null on/behind the camera plane. Positive-depth offscreen or clipped
 * points remain projectable, with separate flags. Image bounds are half-open;
 * near/far depth boundaries are inclusive. No rasterization epsilon is implied.
 */
export function projectPoint(view: Camera, worldPoint: Vec3): ProjectedPoint | null {
  camera(view);
  values(worldPoint, 3, "world point");
  const local = apply(invertTransform(view.cameraToWorld), worldPoint, true);
  const depthMeters = -local[2];
  if (depthMeters <= 0) return null;
  const p = view.projection;
  const pixel = p.kind === "perspective"
    ? vec2(p.fx*local[0]/depthMeters+p.cx, p.cy-p.fy*local[1]/depthMeters)
    : vec2((local[0]-p.left)/(p.right-p.left)*p.width, (p.top-local[1])/(p.top-p.bottom)*p.height);
  return Object.freeze({ pixel, depthMeters,
    insideImage: pixel[0] >= 0 && pixel[0] < p.width && pixel[1] >= 0 && pixel[1] < p.height,
    insideClip: depthMeters >= p.near && depthMeters <= p.far });
}

/** Pixel and depth may lie outside image/clip bounds; depth must remain positive. */
export function unprojectPixel(view: Camera, pixel: Vec2, depthMeters: number): Vec3 {
  camera(view);
  values(pixel, 2, "pixel");
  number(depthMeters, "depth");
  if (depthMeters <= 0) throw new RangeError("axial depth must be positive");
  const p = view.projection;
  const local: Vec3 = p.kind === "perspective"
    ? [(pixel[0]-p.cx)/p.fx*depthMeters, (p.cy-pixel[1])/p.fy*depthMeters, -depthMeters]
    : [p.left+pixel[0]/p.width*(p.right-p.left), p.top-pixel[1]/p.height*(p.top-p.bottom), -depthMeters];
  values(local, 3, "unprojected local point");
  return apply(view.cameraToWorld, local, true);
}

/**
 * A normalized world-space ray. Perspective origin is the optical center;
 * orthographic origin is the corresponding point on the camera plane (depth 0).
 * near/far distances are along the ray, NOT positive axial depth for perspective.
 */
export function pixelRay(view: Camera, pixel: Vec2): Ray {
  camera(view);
  values(pixel, 2, "pixel");
  const p = view.projection;
  const x = p.kind === "perspective" ? (pixel[0]-p.cx)/p.fx : p.left+pixel[0]/p.width*(p.right-p.left);
  const y = p.kind === "perspective" ? (p.cy-pixel[1])/p.fy : p.top-pixel[1]/p.height*(p.top-p.bottom);
  const length = p.kind === "perspective" ? Math.hypot(x, y, 1) : 1;
  const origin = apply(view.cameraToWorld, p.kind === "perspective" ? [0, 0, 0] : vec3(x, y, 0), true);
  const direction = apply(view.cameraToWorld, p.kind === "perspective" ? vec3(x/length, y/length, -1/length) : [0, 0, -1], false);
  return Object.freeze({ origin, direction,
    nearDistanceMeters: number(p.near*length, "near ray distance"),
    farDistanceMeters: number(p.far*length, "far ray distance") });
}

/** World-axis-aligned enclosure of all eight corners, including shear/reflection. */
export function transformBounds(transform: Mat4, bounds: Bounds): Bounds {
  affine(transform);
  values(bounds.min, 3, "bounds min");
  values(bounds.max, 3, "bounds max");
  if (bounds.min.some((value, index) => value > bounds.max[index]!)) throw new RangeError("bounds must have min <= max");
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let mask = 0; mask < 8; mask++) {
    const point = apply(transform, [mask&1 ? bounds.max[0] : bounds.min[0], mask&2 ? bounds.max[1] : bounds.min[1], mask&4 ? bounds.max[2] : bounds.min[2]], true);
    for (let index = 0; index < 3; index++) {
      min[index] = Math.min(min[index]!, point[index]!);
      max[index] = Math.max(max[index]!, point[index]!);
    }
  }
  return Object.freeze({ min: vec3(min[0]!, min[1]!, min[2]!), max: vec3(max[0]!, max[1]!, max[2]!) });
}

/** Convert a validated authored camera pose to an explicit camera-to-world matrix. */
export function cameraMathView(camera: SpatialCamera): Camera {
  return Object.freeze({ projection: camera.projection, cameraToWorld: composeTransform({ ...camera.pose, scale: [1, 1, 1] }) });
}
