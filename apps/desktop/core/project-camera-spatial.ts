import type {
  Easing,
  ProjectCameraKeyframe,
  ProjectCameraSegment,
  ProjectPlacementId,
  ProjectStreamId,
  Rect,
  SourceInterval,
} from "../contracts";
import { evaluateEasingProgress } from "./project-camera";

export interface ProjectCameraSpatialLayer {
  readonly keyframeGroups: readonly Readonly<{
    readonly keyframes: readonly ProjectCameraKeyframe[];
    readonly zoomId: ProjectCameraKeyframe["zoomId"];
  }>[];
  readonly segments: readonly ProjectCameraSegment[];
}

export type ProjectCameraSpatialIndex = ReadonlyMap<
  string,
  ProjectCameraSpatialLayer
>;

export interface ProjectCameraSpatialAlgebra<Value> {
  readonly add: (left: Value, right: Value) => Value;
  readonly constant: (value: number) => Value;
  readonly divide: (left: Value, right: Value) => Value;
  readonly easing: (
    easing: Easing,
    progress: Value,
  ) => Value;
  readonly exponential: (value: Value) => Value;
  readonly maximum: (left: Value, right: Value) => Value;
  readonly minimum: (left: Value, right: Value) => Value;
  readonly multiply: (left: Value, right: Value) => Value;
  readonly selectRange: (
    clock: Value,
    range: SourceInterval,
    end: "inclusive" | "exclusive",
    active: Value,
    fallback: Value,
  ) => Value;
  readonly subtract: (left: Value, right: Value) => Value;
}

export interface ProjectCameraSpatialViewport<Value> {
  readonly height: Value;
  readonly width: Value;
  readonly x: Value;
  readonly y: Value;
}

function cameraLayerKey(
  placementId: ProjectPlacementId | string,
  streamId: ProjectStreamId | string,
): string {
  return `${placementId}\u0000${streamId}`;
}

/**
 * Prepare immutable, deterministically ordered camera paths once. The same
 * layer program is evaluated numerically for metadata and symbolically for
 * FFmpeg, preventing those two spatial pipelines from drifting apart.
 */
export function buildProjectCameraSpatialIndex(
  input: Readonly<{
    readonly cameraKeyframes: readonly ProjectCameraKeyframe[];
    readonly cameraSegments: readonly ProjectCameraSegment[];
  }>,
): ProjectCameraSpatialIndex {
  const mutable = new Map<string, {
    keyframes: ProjectCameraKeyframe[];
    segments: ProjectCameraSegment[];
  }>();
  for (const keyframe of input.cameraKeyframes) {
    const key = cameraLayerKey(keyframe.placementId, keyframe.streamId);
    const layer = mutable.get(key) ?? { keyframes: [], segments: [] };
    layer.keyframes.push(keyframe);
    mutable.set(key, layer);
  }
  for (const segment of input.cameraSegments) {
    const key = cameraLayerKey(segment.placementId, segment.streamId);
    const layer = mutable.get(key) ?? { keyframes: [], segments: [] };
    layer.segments.push(segment);
    mutable.set(key, layer);
  }

  const prepared = new Map<string, ProjectCameraSpatialLayer>();
  for (const [key, layer] of mutable) {
    const byZoom = new Map<
      ProjectCameraKeyframe["zoomId"],
      ProjectCameraKeyframe[]
    >();
    for (const keyframe of layer.keyframes) {
      const group = byZoom.get(keyframe.zoomId) ?? [];
      group.push(keyframe);
      byZoom.set(keyframe.zoomId, group);
    }
    const keyframeGroups = [...byZoom.entries()].map((
      [zoomId, keyframes],
    ) => ({
      keyframes: keyframes.sort((left, right) => (
        left.outputTimeUs - right.outputTimeUs
      )),
      zoomId,
    })).sort((left, right) => (
      left.keyframes[0]!.outputTimeUs - right.keyframes[0]!.outputTimeUs
      || left.zoomId.localeCompare(right.zoomId)
    ));
    layer.segments.sort((left, right) => (
      left.outputRange.startUs - right.outputRange.startUs
      || left.outputRange.endUs - right.outputRange.endUs
      || left.projectRange.startUs - right.projectRange.startUs
      || left.cameraMoveId.localeCompare(right.cameraMoveId)
    ));
    prepared.set(key, {
      keyframeGroups,
      segments: layer.segments,
    });
  }
  return prepared;
}

export function projectCameraSpatialLayer(
  index: ProjectCameraSpatialIndex,
  placementId: ProjectPlacementId | string,
  streamId: ProjectStreamId | string,
): ProjectCameraSpatialLayer | null {
  return index.get(cameraLayerKey(placementId, streamId)) ?? null;
}

export function assertProjectCameraSpatialLayerGeometry(
  layer: ProjectCameraSpatialLayer | null,
  pixelWidth: number,
  pixelHeight: number,
  label: string,
): void {
  if (layer === null) return;
  const keyframesMatch = layer.keyframeGroups.every(group => (
    group.keyframes.every(keyframe => (
      keyframe.layerPixelWidth === pixelWidth
      && keyframe.layerPixelHeight === pixelHeight
    ))
  ));
  const segmentsMatch = layer.segments.every(segment => (
    segment.layerPixelWidth === pixelWidth
    && segment.layerPixelHeight === pixelHeight
  ));
  if (!keyframesMatch || !segmentsMatch) {
    throw new TypeError(`Camera geometry no longer matches layer ${label}.`);
  }
}

export function projectCameraSegmentsOverlapping(
  segments: readonly ProjectCameraSegment[],
  range: SourceInterval,
): readonly ProjectCameraSegment[] {
  let lower = 0;
  let upper = segments.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (segments[middle]!.outputRange.endUs <= range.startUs) {
      lower = middle + 1;
    } else {
      upper = middle;
    }
  }
  const overlapping: ProjectCameraSegment[] = [];
  for (let index = lower; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment.outputRange.startUs >= range.endUs) break;
    overlapping.push(segment);
  }
  return overlapping;
}

function activeKeyframeGroupAt(
  groups: ProjectCameraSpatialLayer["keyframeGroups"],
  outputTimeUs: number,
): ProjectCameraSpatialLayer["keyframeGroups"][number] | null {
  let lower = 0;
  let upper = groups.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (groups[middle]!.keyframes[0]!.outputTimeUs <= outputTimeUs) {
      lower = middle + 1;
    } else {
      upper = middle;
    }
  }
  const group = groups[lower - 1];
  if (
    group === undefined
    || outputTimeUs < group.keyframes[0]!.outputTimeUs
    || outputTimeUs >= group.keyframes.at(-1)!.outputTimeUs
  ) {
    return null;
  }
  let rightLower = 0;
  let rightUpper = group.keyframes.length;
  while (rightLower < rightUpper) {
    const middle = Math.floor((rightLower + rightUpper) / 2);
    if (group.keyframes[middle]!.outputTimeUs <= outputTimeUs) {
      rightLower = middle + 1;
    } else {
      rightUpper = middle;
    }
  }
  const rightIndex = Math.max(1, rightLower);
  return {
    keyframes: [
      group.keyframes[rightIndex - 1]!,
      group.keyframes[rightIndex]!,
    ],
    zoomId: group.zoomId,
  };
}

function activeSegmentAt(
  segments: readonly ProjectCameraSegment[],
  outputTimeUs: number,
): ProjectCameraSegment | null {
  let lower = 0;
  let upper = segments.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (segments[middle]!.outputRange.endUs <= outputTimeUs) {
      lower = middle + 1;
    } else {
      upper = middle;
    }
  }
  const segment = segments[lower];
  if (
    segment === undefined
    || segment.outputRange.startUs > outputTimeUs
    || outputTimeUs >= segment.outputRange.endUs
  ) {
    return null;
  }
  const projectTimeUs = segment.projectRange.startUs + (
    outputTimeUs - segment.outputRange.startUs
  ) * (
    (segment.projectRange.endUs - segment.projectRange.startUs)
    / (segment.outputRange.endUs - segment.outputRange.startUs)
  );
  let transformLower = 0;
  let transformUpper = segment.transforms.length;
  while (transformLower < transformUpper) {
    const middle = Math.floor((transformLower + transformUpper) / 2);
    if (
      segment.transforms[middle]!.activeProjectRange.endUs
      < projectTimeUs
    ) {
      transformLower = middle + 1;
    } else {
      transformUpper = middle;
    }
  }
  const transform = segment.transforms[transformLower];
  if (
    transform === undefined
    || transform.activeProjectRange.startUs > projectTimeUs
  ) {
    throw new TypeError(
      `Camera segment ${segment.cameraMoveId} does not cover its output clock.`,
    );
  }
  return {
    ...segment,
    transforms: [transform],
  };
}

/**
 * Narrow a prepared layer to the at-most-one zoom leg and camera transform
 * active at a numeric output time. Project plans make both families disjoint
 * per layer, so metadata evaluation stays logarithmic in the authored edit
 * count instead of multiplying events by every camera move.
 */
export function projectCameraSpatialLayerAtOutputTime(
  layer: ProjectCameraSpatialLayer | null,
  outputTimeUs: number,
): ProjectCameraSpatialLayer | null {
  if (layer === null) return null;
  const keyframeGroup = activeKeyframeGroupAt(
    layer.keyframeGroups,
    outputTimeUs,
  );
  const segment = activeSegmentAt(layer.segments, outputTimeUs);
  if (keyframeGroup === null && segment === null) return null;
  return {
    keyframeGroups: keyframeGroup === null ? [] : [keyframeGroup],
    segments: segment === null ? [] : [segment],
  };
}

function interpolate<Value>(
  from: number,
  to: number,
  easing: Easing,
  progress: Value,
  algebra: ProjectCameraSpatialAlgebra<Value>,
): Value {
  if (from === to) return algebra.constant(from);
  return algebra.add(
    algebra.constant(from),
    algebra.multiply(
      algebra.constant(to - from),
      algebra.easing(easing, progress),
    ),
  );
}

function clamp<Value>(
  value: Value,
  minimum: Value,
  maximum: Value,
  algebra: ProjectCameraSpatialAlgebra<Value>,
): Value {
  return algebra.minimum(maximum, algebra.maximum(minimum, value));
}

function keyframeField<Value>(
  group: ProjectCameraSpatialLayer["keyframeGroups"][number],
  field: keyof Rect,
  outputTimeUs: Value,
  algebra: ProjectCameraSpatialAlgebra<Value>,
): Value {
  const keyframes = group.keyframes;
  let value = algebra.constant(keyframes.at(-1)!.viewport[field]);
  for (let index = keyframes.length - 1; index > 0; index -= 1) {
    const left = keyframes[index - 1]!;
    const right = keyframes[index]!;
    if (right.outputTimeUs <= left.outputTimeUs) continue;
    const progress = algebra.divide(
      algebra.subtract(
        outputTimeUs,
        algebra.constant(left.outputTimeUs),
      ),
      algebra.constant(right.outputTimeUs - left.outputTimeUs),
    );
    value = algebra.selectRange(
      outputTimeUs,
      { endUs: right.outputTimeUs, startUs: left.outputTimeUs },
      "exclusive",
      interpolate(
        left.viewport[field],
        right.viewport[field],
        right.easing,
        progress,
        algebra,
      ),
      value,
    );
  }
  return value;
}

function applyKeyframeGroups<Value>(
  layer: ProjectCameraSpatialLayer,
  pixelWidth: number,
  pixelHeight: number,
  outputTimeUs: Value,
  algebra: ProjectCameraSpatialAlgebra<Value>,
): ProjectCameraSpatialViewport<Value> {
  let viewport: ProjectCameraSpatialViewport<Value> = {
    height: algebra.constant(pixelHeight),
    width: algebra.constant(pixelWidth),
    x: algebra.constant(0),
    y: algebra.constant(0),
  };
  for (const group of layer.keyframeGroups) {
    const first = group.keyframes[0]!;
    const last = group.keyframes.at(-1)!;
    const range = {
      endUs: last.outputTimeUs,
      startUs: first.outputTimeUs,
    };
    viewport = {
      height: algebra.selectRange(
        outputTimeUs,
        range,
        "exclusive",
        keyframeField(group, "height", outputTimeUs, algebra),
        viewport.height,
      ),
      width: algebra.selectRange(
        outputTimeUs,
        range,
        "exclusive",
        keyframeField(group, "width", outputTimeUs, algebra),
        viewport.width,
      ),
      x: algebra.selectRange(
        outputTimeUs,
        range,
        "exclusive",
        keyframeField(group, "x", outputTimeUs, algebra),
        viewport.x,
      ),
      y: algebra.selectRange(
        outputTimeUs,
        range,
        "exclusive",
        keyframeField(group, "y", outputTimeUs, algebra),
        viewport.y,
      ),
    };
  }
  return viewport;
}

function segmentPoseField<Value>(
  segment: ProjectCameraSegment,
  field: "centerX" | "centerY" | "zoom",
  projectTimeUs: Value,
  algebra: ProjectCameraSpatialAlgebra<Value>,
): Value {
  const last = segment.transforms.at(-1)!;
  let value = algebra.constant(last.toPose[field]);
  for (let index = segment.transforms.length - 1; index >= 0; index -= 1) {
    const transform = segment.transforms[index]!;
    const interpolation = transform.interpolationProjectRange;
    const progress = algebra.divide(
      algebra.subtract(
        projectTimeUs,
        algebra.constant(interpolation.startUs),
      ),
      algebra.constant(interpolation.endUs - interpolation.startUs),
    );
    const interpolated = field === "zoom"
      ? clamp(
          algebra.exponential(algebra.add(
            algebra.constant(Math.log(transform.fromPose.zoom)),
            algebra.multiply(
              algebra.constant(
                Math.log(transform.toPose.zoom)
                - Math.log(transform.fromPose.zoom),
              ),
              algebra.easing(transform.outgoingEasing, progress),
            ),
          )),
          algebra.constant(1),
          algebra.constant(10),
          algebra,
        )
      : interpolate(
          transform.fromPose[field],
          transform.toPose[field],
          transform.outgoingEasing,
          progress,
          algebra,
        );
    value = algebra.selectRange(
      projectTimeUs,
      transform.activeProjectRange,
      "inclusive",
      interpolated,
      value,
    );
  }
  return value;
}

function applySegment<Value>(
  viewport: ProjectCameraSpatialViewport<Value>,
  segment: ProjectCameraSegment,
  pixelWidth: number,
  pixelHeight: number,
  outputTimeUs: Value,
  algebra: ProjectCameraSpatialAlgebra<Value>,
): ProjectCameraSpatialViewport<Value> {
  const projectDurationUs = (
    segment.projectRange.endUs - segment.projectRange.startUs
  );
  const outputDurationUs = (
    segment.outputRange.endUs - segment.outputRange.startUs
  );
  const projectTimeUs = algebra.add(
    algebra.constant(segment.projectRange.startUs),
    algebra.multiply(
      algebra.subtract(
        outputTimeUs,
        algebra.constant(segment.outputRange.startUs),
      ),
      algebra.constant(projectDurationUs / outputDurationUs),
    ),
  );
  const zoom = segmentPoseField(
    segment,
    "zoom",
    projectTimeUs,
    algebra,
  );
  const halfViewport = algebra.divide(
    algebra.constant(1),
    algebra.multiply(algebra.constant(2), zoom),
  );
  const maximumCenter = algebra.subtract(algebra.constant(1), halfViewport);
  const centerX = algebra.minimum(
    maximumCenter,
    algebra.maximum(
      halfViewport,
      segmentPoseField(segment, "centerX", projectTimeUs, algebra),
    ),
  );
  const centerY = algebra.minimum(
    maximumCenter,
    algebra.maximum(
      halfViewport,
      segmentPoseField(segment, "centerY", projectTimeUs, algebra),
    ),
  );
  const width = algebra.divide(algebra.constant(pixelWidth), zoom);
  const height = algebra.divide(algebra.constant(pixelHeight), zoom);
  const active = {
    height,
    width,
    x: algebra.subtract(
      algebra.multiply(algebra.constant(pixelWidth), centerX),
      algebra.divide(width, algebra.constant(2)),
    ),
    y: algebra.subtract(
      algebra.multiply(algebra.constant(pixelHeight), centerY),
      algebra.divide(height, algebra.constant(2)),
    ),
  };
  return {
    height: algebra.selectRange(
      outputTimeUs,
      segment.outputRange,
      "exclusive",
      active.height,
      viewport.height,
    ),
    width: algebra.selectRange(
      outputTimeUs,
      segment.outputRange,
      "exclusive",
      active.width,
      viewport.width,
    ),
    x: algebra.selectRange(
      outputTimeUs,
      segment.outputRange,
      "exclusive",
      active.x,
      viewport.x,
    ),
    y: algebra.selectRange(
      outputTimeUs,
      segment.outputRange,
      "exclusive",
      active.y,
      viewport.y,
    ),
  };
}

function constrainViewport<Value>(
  viewport: ProjectCameraSpatialViewport<Value>,
  pixelWidth: number,
  pixelHeight: number,
  algebra: ProjectCameraSpatialAlgebra<Value>,
): ProjectCameraSpatialViewport<Value> {
  const width = clamp(
    viewport.width,
    algebra.constant(pixelWidth / 10),
    algebra.constant(pixelWidth),
    algebra,
  );
  const height = clamp(
    viewport.height,
    algebra.constant(pixelHeight / 10),
    algebra.constant(pixelHeight),
    algebra,
  );
  return {
    height,
    width,
    x: clamp(
      viewport.x,
      algebra.constant(0),
      algebra.subtract(algebra.constant(pixelWidth), width),
      algebra,
    ),
    y: clamp(
      viewport.y,
      algebra.constant(0),
      algebra.subtract(algebra.constant(pixelHeight), height),
      algebra,
    ),
  };
}

/**
 * Evaluate the final viewport for one prepared video layer at one output
 * clock value. Manual and face-derived segments intentionally override legacy
 * metadata zoom keyframes while active, matching the renderer's composition.
 */
export function evaluateProjectCameraSpatialViewport<Value>(
  layer: ProjectCameraSpatialLayer | null,
  input: Readonly<{
    readonly outputTimeUs: Value;
    readonly pixelHeight: number;
    readonly pixelWidth: number;
  }>,
  algebra: ProjectCameraSpatialAlgebra<Value>,
): ProjectCameraSpatialViewport<Value> {
  if (layer === null) {
    return {
      height: algebra.constant(input.pixelHeight),
      width: algebra.constant(input.pixelWidth),
      x: algebra.constant(0),
      y: algebra.constant(0),
    };
  }
  let viewport = applyKeyframeGroups(
    layer,
    input.pixelWidth,
    input.pixelHeight,
    input.outputTimeUs,
    algebra,
  );
  for (const segment of layer.segments) {
    viewport = applySegment(
      viewport,
      segment,
      input.pixelWidth,
      input.pixelHeight,
      input.outputTimeUs,
      algebra,
    );
  }
  return constrainViewport(
    viewport,
    input.pixelWidth,
    input.pixelHeight,
    algebra,
  );
}

const NUMBER_ALGEBRA: ProjectCameraSpatialAlgebra<number> = {
  add: (left, right) => left + right,
  constant: value => value,
  divide: (left, right) => left / right,
  easing: evaluateEasingProgress,
  exponential: Math.exp,
  maximum: Math.max,
  minimum: Math.min,
  multiply: (left, right) => left * right,
  selectRange: (clock, range, end, active, fallback) => (
    clock >= range.startUs
    && (end === "inclusive" ? clock <= range.endUs : clock < range.endUs)
      ? active
      : fallback
  ),
  subtract: (left, right) => left - right,
};

export function evaluateProjectCameraSpatialViewportAt(
  layer: ProjectCameraSpatialLayer | null,
  input: Readonly<{
    readonly outputTimeUs: number;
    readonly pixelHeight: number;
    readonly pixelWidth: number;
  }>,
): Rect {
  return evaluateProjectCameraSpatialViewport(
    layer,
    input,
    NUMBER_ALGEBRA,
  );
}
