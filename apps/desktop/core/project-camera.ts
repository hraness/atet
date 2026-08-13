import {
  ProjectCameraSegmentSchema,
  type CameraPose,
  type Easing,
  type ProjectCameraMove,
  type ProjectCameraSegment,
  type ProjectEditPlanV1,
  type ProjectPlacementId,
  type ProjectPlacementV1,
  type ProjectRenderPlanV1,
  type ProjectStreamId,
  type ResolvedProjectVideoSlice,
  type SourceInterval,
  type VideoProjectV1,
} from "../contracts";
import { canonicalJsonSha256 } from "./canonical-json";
import { interpolateMicroseconds } from "./project-time";

const CAMERA_EPSILON = 1e-12;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function cubicCoordinate(parameter: number, first: number, second: number): number {
  const inverse = 1 - parameter;
  return 3 * inverse ** 2 * parameter * first
    + 3 * inverse * parameter ** 2 * second
    + parameter ** 3;
}

/**
 * Evaluate an easing at timeline progress. Cubic Bézier progress follows CSS:
 * progress is the curve's x coordinate, not its parameter.
 */
export function evaluateEasingProgress(easing: Easing, progress: number): number {
  const bounded = clamp(progress, 0, 1);
  if (easing.kind === "linear") return bounded;
  if (easing.kind === "ease-in") return bounded ** 2;
  if (easing.kind === "ease-out") return 1 - (1 - bounded) ** 2;
  if (easing.kind === "ease-in-out") {
    return bounded < 0.5 ? 2 * bounded ** 2 : 1 - (-2 * bounded + 2) ** 2 / 2;
  }
  if (easing.kind === "spring") {
    return clamp(1 - Math.exp(-6 * bounded) * Math.cos(8 * bounded), 0, 1);
  }
  if (easing.kind !== "cubic-bezier") return bounded;
  if (bounded === 0 || bounded === 1) return bounded;
  let lower = 0;
  let upper = 1;
  for (let iteration = 0; iteration < 28; iteration += 1) {
    const parameter = (lower + upper) / 2;
    if (cubicCoordinate(parameter, easing.x1, easing.x2) < bounded) {
      lower = parameter;
    } else {
      upper = parameter;
    }
  }
  return cubicCoordinate((lower + upper) / 2, easing.y1, easing.y2);
}

export function cameraPoseToNormalizedViewport(pose: CameraPose): {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
} {
  const size = 1 / pose.zoom;
  return {
    height: size,
    width: size,
    x: pose.centerX - size / 2,
    y: pose.centerY - size / 2,
  };
}

export function interpolateCameraPose(
  from: CameraPose,
  to: CameraPose,
  easing: Easing,
  progress: number,
): CameraPose {
  const eased = evaluateEasingProgress(easing, progress);
  const logarithmicZoom = Math.log(from.zoom)
    + (Math.log(to.zoom) - Math.log(from.zoom)) * eased;
  const zoom = clamp(Math.exp(logarithmicZoom), 1, 10);
  const halfViewport = 1 / (2 * zoom);
  return {
    centerX: clamp(
      from.centerX + (to.centerX - from.centerX) * eased,
      halfViewport,
      1 - halfViewport,
    ),
    centerY: clamp(
      from.centerY + (to.centerY - from.centerY) * eased,
      halfViewport,
      1 - halfViewport,
    ),
    space: "prepared-video-layer-normalized-v1",
    zoom,
  };
}

export function evaluateCameraMovePose(
  move: ProjectCameraMove,
  projectTimeUs: number,
): CameraPose {
  if (projectTimeUs < move.projectRange.startUs || projectTimeUs > move.projectRange.endUs) {
    throw new RangeError(`Camera move ${move.cameraMoveId} is not active at project time ${projectTimeUs}.`);
  }
  const last = move.keyframes.at(-1)!;
  if (projectTimeUs === last.projectTimeUs) return last.pose;
  let lower = 0;
  let upper = move.keyframes.length - 1;
  while (lower + 1 < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (move.keyframes[middle]!.projectTimeUs <= projectTimeUs) lower = middle;
    else upper = middle;
  }
  const from = move.keyframes[lower]!;
  const to = move.keyframes[lower + 1]!;
  return interpolateCameraPose(
    from.pose,
    to.pose,
    from.outgoingEasing,
    (projectTimeUs - from.projectTimeUs) / (to.projectTimeUs - from.projectTimeUs),
  );
}

export function hashProjectCameraSync(placement: ProjectPlacementV1): string {
  return canonicalJsonSha256({
    assetId: placement.assetId,
    assetRange: placement.assetRange,
    placementId: placement.placementId,
    sync: placement.sync,
  });
}

function resolveCameraLayer(
  project: VideoProjectV1,
  placementId: ProjectPlacementId,
  streamId: ProjectStreamId,
) {
  const placement = project.placements.find(candidate => candidate.placementId === placementId);
  if (placement === undefined) throw new TypeError(`Camera move references unknown placement ${placementId}.`);
  const asset = project.assets.find(candidate => candidate.assetId === placement.assetId);
  if (asset === undefined) throw new TypeError(`Camera placement ${placementId} references an unknown asset.`);
  const stream = asset.streams.find(candidate => candidate.streamId === streamId);
  if (stream?.kind !== "video") {
    throw new TypeError(`Camera move references unknown video stream ${placementId}:${streamId}.`);
  }
  const configured = placement.video.find(candidate => candidate.streamId === streamId);
  if (configured === undefined) {
    throw new TypeError(`Camera move references an unconfigured video stream ${placementId}:${streamId}.`);
  }
  return { asset, configured, placement, stream };
}

export function hashProjectCameraGeometry(
  project: VideoProjectV1,
  placementId: ProjectPlacementId,
  streamId: ProjectStreamId,
): string {
  const { asset, configured, placement, stream } = resolveCameraLayer(project, placementId, streamId);
  return canonicalJsonSha256({
    assetId: asset.assetId,
    placementId: placement.placementId,
    presentation: configured.presentation,
    sourceFrameRate: stream.frameRate,
    sourcePixelHeight: stream.pixelHeight,
    sourcePixelWidth: stream.pixelWidth,
    streamId: stream.streamId,
  });
}

export function assertProjectCameraMoveBindings(
  project: VideoProjectV1,
  move: ProjectCameraMove,
): void {
  const { asset, configured, placement } = resolveCameraLayer(project, move.placementId, move.streamId);
  if (!placement.enabled || !configured.presentation.enabled) {
    throw new TypeError(`Camera move ${move.cameraMoveId} targets a disabled video layer.`);
  }
  if (move.binding.syncSha256 !== hashProjectCameraSync(placement)) {
    throw new TypeError(`Camera move ${move.cameraMoveId} has a stale placement synchronization binding.`);
  }
  if (
    move.binding.geometrySha256
    !== hashProjectCameraGeometry(project, move.placementId, move.streamId)
  ) {
    throw new TypeError(`Camera move ${move.cameraMoveId} has a stale prepared-layer geometry binding.`);
  }
  if (move.origin.kind === "face-analysis") {
    if (
      move.origin.assetId !== asset.assetId
      || move.origin.streamId !== move.streamId
      || move.origin.assetRange.startUs < placement.assetRange.startUs
      || move.origin.assetRange.endUs > placement.assetRange.endUs
    ) {
      throw new TypeError(`Camera move ${move.cameraMoveId} has mismatched face-analysis provenance.`);
    }
  }
}

function intersection(left: SourceInterval, right: SourceInterval): SourceInterval | null {
  const startUs = Math.max(left.startUs, right.startUs);
  const endUs = Math.min(left.endUs, right.endUs);
  return startUs < endUs ? { endUs, startUs } : null;
}

function mapSubrange(
  value: SourceInterval,
  input: SourceInterval,
  output: SourceInterval,
): SourceInterval {
  return {
    endUs: interpolateMicroseconds(
      value.endUs,
      input.startUs,
      input.endUs,
      output.startUs,
      output.endUs,
    ),
    startUs: interpolateMicroseconds(
      value.startUs,
      input.startUs,
      input.endUs,
      output.startUs,
      output.endUs,
    ),
  };
}

function firstTransformEndingAfter(move: ProjectCameraMove, projectTimeUs: number): number {
  let lower = 0;
  let upper = move.keyframes.length - 1;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (move.keyframes[middle + 1]!.projectTimeUs <= projectTimeUs) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}

function cameraTransforms(
  move: ProjectCameraMove,
  activeRange: SourceInterval,
): ProjectCameraSegment["transforms"] {
  const transforms: ProjectCameraSegment["transforms"][number][] = [];
  let index = firstTransformEndingAfter(move, activeRange.startUs);
  while (index + 1 < move.keyframes.length) {
    const from = move.keyframes[index]!;
    const to = move.keyframes[index + 1]!;
    if (from.projectTimeUs >= activeRange.endUs) break;
    const activeProjectRange = intersection(activeRange, {
      endUs: to.projectTimeUs,
      startUs: from.projectTimeUs,
    });
    if (activeProjectRange !== null) {
      transforms.push({
        activeProjectRange,
        fromPose: from.pose,
        interpolationProjectRange: {
          endUs: to.projectTimeUs,
          startUs: from.projectTimeUs,
        },
        outgoingEasing: from.outgoingEasing,
        toPose: to.pose,
      });
    }
    index += 1;
  }
  return transforms;
}

function layerPixelSize(
  slice: ResolvedProjectVideoSlice,
  output: Pick<ProjectRenderPlanV1["output"], "pixelHeight" | "pixelWidth">,
): { readonly height: number; readonly width: number } {
  if (!slice.presentation.enabled) {
    throw new TypeError(`Camera slice ${slice.placementId}:${slice.streamId} is disabled.`);
  }
  const layout = slice.presentation.layout;
  return layout.kind === "output-pixels"
    ? {
        height: Math.max(1, Math.round(layout.height)),
        width: Math.max(1, Math.round(layout.width)),
      }
    : {
        height: Math.max(1, Math.round(layout.height * output.pixelHeight)),
        width: Math.max(1, Math.round(layout.width * output.pixelWidth)),
      };
}

function layerKey(placementId: ProjectPlacementId, streamId: ProjectStreamId): string {
  return `${placementId}\u0000${streamId}`;
}

/**
 * Resolve paths only against intersecting video slices and keyframe legs.
 * Splits at cuts, speed boundaries, sync anchors, and media boundaries retain
 * the original interpolation range so easing never restarts after a split.
 */
export function compileProjectCameraSegments(
  project: VideoProjectV1,
  plan: ProjectEditPlanV1,
  videoSlices: readonly ResolvedProjectVideoSlice[],
  output: Pick<ProjectRenderPlanV1["output"], "pixelHeight" | "pixelWidth">,
): readonly ProjectCameraSegment[] {
  const movesByLayer = new Map<string, ProjectCameraMove[]>();
  for (const move of plan.cameraMoves) {
    assertProjectCameraMoveBindings(project, move);
    const key = layerKey(move.placementId, move.streamId);
    const moves = movesByLayer.get(key) ?? [];
    moves.push(move);
    movesByLayer.set(key, moves);
  }
  for (const moves of movesByLayer.values()) {
    moves.sort((left, right) => (
      left.projectRange.startUs - right.projectRange.startUs
      || left.projectRange.endUs - right.projectRange.endUs
      || left.cameraMoveId.localeCompare(right.cameraMoveId)
    ));
  }

  const slicesByLayer = new Map<string, ResolvedProjectVideoSlice[]>();
  for (const slice of videoSlices) {
    const key = layerKey(slice.placementId, slice.streamId);
    if (!movesByLayer.has(key)) continue;
    const slices = slicesByLayer.get(key) ?? [];
    slices.push(slice);
    slicesByLayer.set(key, slices);
  }

  const segments: ProjectCameraSegment[] = [];
  for (const [key, slices] of slicesByLayer) {
    const moves = movesByLayer.get(key)!;
    slices.sort((left, right) => (
      left.projectRange.startUs - right.projectRange.startUs
      || left.projectRange.endUs - right.projectRange.endUs
    ));
    let firstMove = 0;
    for (const slice of slices) {
      while (
        firstMove < moves.length
        && moves[firstMove]!.projectRange.endUs <= slice.projectRange.startUs
      ) {
        firstMove += 1;
      }
      for (let moveIndex = firstMove; moveIndex < moves.length; moveIndex += 1) {
        const move = moves[moveIndex]!;
        if (move.projectRange.startUs >= slice.projectRange.endUs) break;
        const projectRange = intersection(move.projectRange, slice.projectRange);
        if (projectRange === null) continue;
        const transforms = cameraTransforms(move, projectRange);
        if (transforms.length === 0) continue;
        const size = layerPixelSize(slice, output);
        if (
          move.origin.kind === "face-analysis"
          && move.origin.outputAspectRatio !== null
          && Math.abs(
            output.pixelWidth / output.pixelHeight - move.origin.outputAspectRatio,
          ) > 1e-9
        ) {
          throw new TypeError(
            `Face camera move ${move.cameraMoveId} was framed for another render aspect ratio.`,
          );
        }
        segments.push(ProjectCameraSegmentSchema.parse({
          assetRange: mapSubrange(projectRange, slice.projectRange, slice.assetRange),
          cameraMoveId: move.cameraMoveId,
          geometrySha256: move.binding.geometrySha256,
          layerPixelHeight: size.height,
          layerPixelWidth: size.width,
          outputRange: mapSubrange(projectRange, slice.projectRange, slice.outputRange),
          placementId: move.placementId,
          projectRange,
          streamId: move.streamId,
          syncSha256: move.binding.syncSha256,
          transforms,
        }));
      }
    }
  }
  return segments.sort((left, right) => (
    left.outputRange.startUs - right.outputRange.startUs
    || left.placementId.localeCompare(right.placementId)
    || left.streamId.localeCompare(right.streamId)
    || left.projectRange.startUs - right.projectRange.startUs
    || left.cameraMoveId.localeCompare(right.cameraMoveId)
  ));
}

export function cameraPosesApproximatelyEqual(
  left: CameraPose,
  right: CameraPose,
  epsilon = CAMERA_EPSILON,
): boolean {
  return left.space === right.space
    && Math.abs(left.centerX - right.centerX) <= epsilon
    && Math.abs(left.centerY - right.centerY) <= epsilon
    && Math.abs(left.zoom - right.zoom) <= epsilon;
}
