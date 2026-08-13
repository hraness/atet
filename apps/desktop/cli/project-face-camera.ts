import {
  FaceTrackIdSchema,
  ProjectCameraMoveSchema,
  ProjectPlacementIdSchema,
  type Easing,
  type FaceAnalysisV1,
  type FaceTrackId,
  type ProjectCameraMove,
  type ProjectEditPlanV1,
  type VideoProjectV1,
} from "../contracts";
import {
  faceCoordinateDisplayAspect,
  mapFaceResultsToPreparedLayer,
  planFaceFraming,
  type PreparedFaceFrame,
} from "../core/face-framing";
import {
  hashProjectCameraGeometry,
  hashProjectCameraSync,
} from "../core/project-camera";
import {
  assetToProjectUs,
  projectToAssetUs,
} from "../core/project-time";
import { CliError } from "./errors";

type FaceReference = Extract<
  VideoProjectV1["analyses"][number],
  { readonly kind: "faces" }
>;

export interface ProjectFaceCameraOptions {
  readonly analysis: FaceAnalysisV1;
  readonly cameraMoveId: string;
  readonly easing: Easing;
  readonly framing: "tight" | "medium" | "wide" | "group";
  readonly gapPolicy: "hold" | "fallback" | "fail";
  readonly headroom: number;
  readonly maximumZoom: number;
  readonly minimumZoom: number;
  readonly outputHeight: number;
  readonly outputWidth: number;
  readonly placementId: string;
  readonly plan: ProjectEditPlanV1;
  readonly project: VideoProjectV1;
  readonly projectRange: Readonly<{ readonly endUs: number; readonly startUs: number }>;
  readonly reference: FaceReference;
  readonly requireAllSelectedFaces: boolean;
  readonly selection:
    | Readonly<{ readonly kind: "explicit"; readonly trackIds: readonly string[] }>
    | Readonly<{ readonly kind: "all" | "largest" }>;
  readonly smoothingSeconds: number;
}

export interface PlannedProjectFaceCamera {
  readonly move: ProjectCameraMove;
  readonly selectedTrackIds: readonly FaceTrackId[];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function activeTrackIds(
  analysis: FaceAnalysisV1,
  range: Readonly<{ readonly endUs: number; readonly startUs: number }>,
): readonly FaceTrackId[] {
  const ids = new Set<FaceTrackId>();
  for (const result of analysis.results) {
    if (
      result.state !== "analyzed"
      || result.assetTimeUs < range.startUs
      || result.assetTimeUs >= range.endUs
    ) {
      continue;
    }
    for (const detection of result.detections) ids.add(detection.trackId);
  }
  return [...ids].sort((left, right) => left.localeCompare(right));
}

function selectedTrackIds(
  analysis: FaceAnalysisV1,
  range: Readonly<{ readonly endUs: number; readonly startUs: number }>,
  selection: ProjectFaceCameraOptions["selection"],
): readonly FaceTrackId[] {
  const known = new Set(analysis.tracks.map(track => track.trackId));
  let selected: readonly FaceTrackId[];
  if (selection.kind === "explicit") {
    selected = selection.trackIds.map((trackId) => {
      const parsed = FaceTrackIdSchema.safeParse(trackId);
      if (!parsed.success) throw new CliError("usage", `Invalid face track ID: ${trackId}`);
      if (!known.has(parsed.data)) {
        throw new CliError("not-found", `Face analysis does not contain track ${trackId}.`);
      }
      return parsed.data;
    });
  } else {
    selected = activeTrackIds(analysis, range);
  }
  selected = [...new Set(selected)].sort((left, right) => left.localeCompare(right));
  if (selected.length === 0) {
    throw new CliError("not-found", "No selected face track has evidence in the requested camera range.");
  }
  if (selected.length > 64) {
    throw new CliError(
      "usage",
      `Face-follow supports at most 64 selected tracks; narrow the selection from ${selected.length}.`,
    );
  }
  return selected;
}

function largestVisibleFaceFrames(
  frames: readonly PreparedFaceFrame[],
  candidateTrackIds: readonly FaceTrackId[],
  range: Readonly<{ readonly endUs: number; readonly startUs: number }>,
): Readonly<{
  readonly frames: readonly PreparedFaceFrame[];
  readonly selectedTrackIds: readonly FaceTrackId[];
}> {
  const candidates = new Set(candidateTrackIds);
  const selected = new Set<FaceTrackId>();
  const filtered = frames.map((frame): PreparedFaceFrame => {
    if (
      frame.state === "failed"
      || frame.assetTimeUs < range.startUs
      || frame.assetTimeUs >= range.endUs
    ) {
      return frame;
    }
    const winner = frame.detections
      .filter(detection => candidates.has(detection.trackId))
      .sort((left, right) => {
        const leftArea = left.rect.width * left.rect.height;
        const rightArea = right.rect.width * right.rect.height;
        if (leftArea !== rightArea) return leftArea < rightArea ? 1 : -1;
        if (left.confidence !== right.confidence) {
          return left.confidence < right.confidence ? 1 : -1;
        }
        if (left.trackId === right.trackId) return 0;
        return left.trackId < right.trackId ? -1 : 1;
      })[0];
    if (winner === undefined) return { ...frame, detections: [] };
    selected.add(winner.trackId);
    return { ...frame, detections: [winner] };
  });
  return {
    frames: filtered,
    selectedTrackIds: [...selected].sort((left, right) => left.localeCompare(right)),
  };
}

function gapPolicy(
  value: ProjectFaceCameraOptions["gapPolicy"],
  maximumGapUs: number,
) {
  if (value === "fail") return { kind: "fail" as const };
  if (value === "fallback") return { kind: "fallback" as const };
  return {
    kind: "hold" as const,
    maximumHoldUs: Math.max(maximumGapUs, 1_000_000),
    whenExpired: "fallback" as const,
  };
}

function paddingRatio(framing: ProjectFaceCameraOptions["framing"]): number {
  if (framing === "tight") return 0.15;
  if (framing === "medium") return 0.45;
  if (framing === "wide") return 0.9;
  return 0.3;
}

function layerPixels(
  presentation: Extract<
    VideoProjectV1["placements"][number]["video"][number]["presentation"],
    { readonly enabled: true }
  >,
  outputWidth: number,
  outputHeight: number,
): Readonly<{ readonly height: number; readonly width: number }> {
  return presentation.layout.kind === "output-pixels"
    ? {
        height: Math.max(1, Math.round(presentation.layout.height)),
        width: Math.max(1, Math.round(presentation.layout.width)),
      }
    : {
        height: Math.max(1, Math.round(presentation.layout.height * outputHeight)),
        width: Math.max(1, Math.round(presentation.layout.width * outputWidth)),
      };
}

export function planProjectFaceCamera(
  options: ProjectFaceCameraOptions,
): PlannedProjectFaceCamera {
  if (
    !Number.isFinite(options.minimumZoom)
    || !Number.isFinite(options.maximumZoom)
    || options.minimumZoom < 1
    || options.maximumZoom < options.minimumZoom
    || options.maximumZoom > 10
    || !Number.isFinite(options.headroom)
    || options.headroom < 0
    || options.headroom > 1
    || !Number.isFinite(options.smoothingSeconds)
    || options.smoothingSeconds < 0
    || options.smoothingSeconds > 60
  ) {
    throw new CliError("usage", "Face-follow framing, zoom, or smoothing values are invalid.");
  }
  if (options.selection.kind === "largest" && options.requireAllSelectedFaces) {
    throw new CliError(
      "usage",
      "Dynamic largest-visible face selection cannot require every candidate track at once.",
    );
  }
  if (
    !Number.isSafeInteger(options.outputWidth)
    || !Number.isSafeInteger(options.outputHeight)
    || options.outputWidth <= 0
    || options.outputHeight <= 0
    || options.outputWidth > 16_384
    || options.outputHeight > 16_384
    || options.outputWidth * options.outputHeight > 134_217_728
  ) {
    throw new CliError("usage", "Face-follow output dimensions are invalid or exceed 128 megapixels.");
  }
  if (options.projectRange.endUs > options.project.timeline.durationUs) {
    throw new CliError("usage", "Face-follow range exceeds the project timeline.");
  }
  const placementId = ProjectPlacementIdSchema.safeParse(options.placementId);
  if (!placementId.success) {
    throw new CliError("usage", `Invalid project placement: ${options.placementId}`);
  }
  const placement = options.project.placements.find(
    candidate => candidate.placementId === placementId.data,
  );
  if (placement === undefined || !placement.enabled) {
    throw new CliError("not-found", `Unknown enabled project placement: ${options.placementId}`);
  }
  if (
    options.reference.analysisId !== options.analysis.analysisId
    || placement.assetId !== options.analysis.subject.assetId
    || options.reference.assetId !== options.analysis.subject.assetId
    || options.reference.streamId !== options.analysis.subject.streamId
    || options.reference.subjectIntegritySha256 !== options.analysis.subject.integritySha256
  ) {
    throw new CliError(
      "conflict",
      "Face analysis reference or subject does not match the selected project placement.",
    );
  }
  const configured = placement.video.find(
    candidate => candidate.streamId === options.analysis.subject.streamId,
  );
  if (configured?.presentation.enabled !== true) {
    throw new CliError(
      "not-found",
      `Placement ${placement.placementId} does not enable analyzed stream ${options.analysis.subject.streamId}.`,
    );
  }
  const assetStartUs = projectToAssetUs(placement.sync, options.projectRange.startUs);
  const assetEndUs = projectToAssetUs(placement.sync, options.projectRange.endUs);
  if (
    assetStartUs === null
    || assetEndUs === null
    || assetEndUs <= assetStartUs
    || assetStartUs < options.analysis.coverage.range.startUs
    || assetEndUs > options.analysis.coverage.range.endUs
  ) {
    throw new CliError(
      "conflict",
      "Requested camera range is not fully covered by the placement sync map and face analysis.",
    );
  }
  const assetRange = { endUs: assetEndUs, startUs: assetStartUs };
  const candidateTracks = selectedTrackIds(options.analysis, assetRange, options.selection);
  const pixels = layerPixels(
    configured.presentation,
    options.outputWidth,
    options.outputHeight,
  );
  let preparedFrames = mapFaceResultsToPreparedLayer(options.analysis.results, {
    crop: configured.presentation.crop,
    fit: configured.presentation.fit,
    layerPixelHeight: pixels.height,
    layerPixelWidth: pixels.width,
    sourceDisplayAspect: faceCoordinateDisplayAspect(options.analysis.coordinateSpace),
  });
  let tracks = candidateTracks;
  if (options.selection.kind === "largest") {
    const dynamic = largestVisibleFaceFrames(preparedFrames, candidateTracks, assetRange);
    preparedFrames = dynamic.frames;
    tracks = dynamic.selectedTrackIds.length === 0
      ? candidateTracks
      : dynamic.selectedTrackIds;
  }
  const framing = planFaceFraming({
    config: {
      gapPolicy: gapPolicy(options.gapPolicy, options.analysis.config.tracking.maximumGapUs),
      headroomRatio: options.headroom,
      maximumZoom: options.maximumZoom,
      paddingRatio: paddingRatio(options.framing),
      requireAllSelectedFaces: options.requireAllSelectedFaces,
      simplificationTolerance: 0.003,
      smoothingTimeUs: Math.round(options.smoothingSeconds * 1_000_000),
    },
    frames: preparedFrames,
    range: assetRange,
    trackIds: tracks,
  });
  const keyframes = framing.map((keyframe, index) => {
    const projectTimeUs = assetToProjectUs(placement.sync, keyframe.assetTimeUs);
    if (projectTimeUs === null) {
      throw new CliError("conflict", "A face keyframe falls outside the accepted placement sync map.");
    }
    const zoom = clamp(keyframe.zoom, options.minimumZoom, options.maximumZoom);
    const halfViewport = 1 / (2 * zoom);
    return {
      outgoingEasing: index === framing.length - 1 ? { kind: "linear" as const } : options.easing,
      pose: {
        centerX: clamp(
          keyframe.viewport.x + keyframe.viewport.width / 2,
          halfViewport,
          1 - halfViewport,
        ),
        centerY: clamp(
          keyframe.viewport.y + keyframe.viewport.height / 2,
          halfViewport,
          1 - halfViewport,
        ),
        space: "prepared-video-layer-normalized-v1" as const,
        zoom,
      },
      projectTimeUs: index === 0
        ? options.projectRange.startUs
        : index === framing.length - 1
          ? options.projectRange.endUs
          : projectTimeUs,
    };
  }).filter((keyframe, index, all) => (
    index === 0 || keyframe.projectTimeUs > all[index - 1]!.projectTimeUs
  ));
  if (keyframes.length < 2 || keyframes.at(-1)?.projectTimeUs !== options.projectRange.endUs) {
    throw new CliError("conflict", "Face evidence collapsed to an invalid camera keyframe timeline.");
  }
  const parsed = ProjectCameraMoveSchema.safeParse({
    binding: {
      geometrySha256: hashProjectCameraGeometry(
        options.project,
        placement.placementId,
        options.analysis.subject.streamId,
      ),
      syncSha256: hashProjectCameraSync(placement),
    },
    cameraMoveId: options.cameraMoveId,
    keyframes,
    origin: {
      analysisId: options.analysis.analysisId,
      analysisSha256: options.reference.sha256,
      assetId: options.analysis.subject.assetId,
      assetRange,
      kind: "face-analysis",
      outputAspectRatio: configured.presentation.layout.kind === "normalized"
        ? options.outputWidth / options.outputHeight
        : null,
      streamId: options.analysis.subject.streamId,
      subjectIntegritySha256: options.analysis.subject.integritySha256,
      trackIds: tracks,
    },
    placementId: placement.placementId,
    projectRange: options.projectRange,
    streamId: options.analysis.subject.streamId,
  });
  if (!parsed.success) {
    throw new CliError(
      "invalid-data",
      `Face-follow camera move is invalid: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
    );
  }
  if (options.plan.cameraMoves.some(move => (
    move.placementId === parsed.data.placementId
    && move.streamId === parsed.data.streamId
    && move.projectRange.startUs < parsed.data.projectRange.endUs
    && move.projectRange.endUs > parsed.data.projectRange.startUs
  ))) {
    throw new CliError(
      "conflict",
      "Face-follow range overlaps an existing camera move on the same video layer.",
    );
  }
  return { move: parsed.data, selectedTrackIds: tracks };
}
