import {
  FaceAnalysisFrameResultSchema,
  FaceTrackIdSchema,
  FaceTrackSchema,
  FaceTrackingConfigSchema,
  RawFaceDetectionFramesSchema,
  type FaceAnalysisFrameResult,
  type FaceTrack,
  type FaceTrackId,
  type FaceTrackingConfig,
  type NormalizedTopLeftRect,
  type RawFaceDetection,
  type RawFaceDetectionFrame,
  type TrackedFaceDetection,
} from "../contracts/analysis";

export interface FaceDetectionPort<Request> {
  detect(request: Request): Promise<RawFaceDetectionFrame>;
}

export type AnalyzedFaceFrameResult = Extract<FaceAnalysisFrameResult, { readonly state: "analyzed" }>;

export type FaceAssociationResult = Readonly<{
  results: readonly AnalyzedFaceFrameResult[];
  tracks: readonly FaceTrack[];
}>;

type TrackObservation = Readonly<{
  assetTimeUs: number;
  confidence: number;
  rect: NormalizedTopLeftRect;
}>;

type MutableTrack = {
  observations: TrackObservation[];
  trackId: FaceTrackId;
};

const INVALID_MATCH_COST = 1_000_000_000;
const UNMATCHED_TRACK_COST = 10;
const MAX_TRACKS = 100_000;

function compareNumber(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareRects(left: NormalizedTopLeftRect, right: NormalizedTopLeftRect): number {
  return (
    compareNumber(left.x, right.x)
    || compareNumber(left.y, right.y)
    || compareNumber(left.width, right.width)
    || compareNumber(left.height, right.height)
  );
}

function compareDetections(left: RawFaceDetection, right: RawFaceDetection): number {
  return compareRects(left.rect, right.rect) || compareNumber(right.confidence, left.confidence);
}

function selectedDetections(
  frame: RawFaceDetectionFrame,
  config: FaceTrackingConfig,
): Readonly<{ detections: readonly RawFaceDetection[]; discardedDetections: number }> {
  const aboveConfidence = frame.detections
    .filter(detection => detection.confidence >= config.minimumConfidence)
    .sort((left, right) => (
      compareNumber(right.confidence, left.confidence)
      || compareRects(left.rect, right.rect)
    ));
  const detections = aboveConfidence
    .slice(0, config.maximumFacesPerFrame)
    .sort(compareDetections);
  return {
    detections,
    discardedDetections: frame.detections.length - detections.length,
  };
}

function center(rect: NormalizedTopLeftRect): Readonly<{ x: number; y: number }> {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function predictedRect(track: MutableTrack, assetTimeUs: number): NormalizedTopLeftRect {
  const last = track.observations.at(-1);
  if (last === undefined) throw new TypeError(`Face track ${track.trackId} has no observations.`);
  const prior = track.observations.at(-2);
  if (prior === undefined || last.assetTimeUs === prior.assetTimeUs) return last.rect;
  const elapsedUs = assetTimeUs - last.assetTimeUs;
  const observationDeltaUs = last.assetTimeUs - prior.assetTimeUs;
  const lastCenter = center(last.rect);
  const priorCenter = center(prior.rect);
  const predictedCenterX = lastCenter.x + ((lastCenter.x - priorCenter.x) / observationDeltaUs) * elapsedUs;
  const predictedCenterY = lastCenter.y + ((lastCenter.y - priorCenter.y) / observationDeltaUs) * elapsedUs;
  return {
    height: last.rect.height,
    width: last.rect.width,
    x: clamp(predictedCenterX - last.rect.width / 2, 0, 1 - last.rect.width),
    y: clamp(predictedCenterY - last.rect.height / 2, 0, 1 - last.rect.height),
  };
}

export function normalizedRectIou(
  left: NormalizedTopLeftRect,
  right: NormalizedTopLeftRect,
): number {
  const intersectionWidth = Math.max(
    0,
    Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
  );
  const intersection = intersectionWidth * intersectionHeight;
  if (intersection === 0) return 0;
  return intersection / (left.width * left.height + right.width * right.height - intersection);
}

function centerDistance(left: NormalizedTopLeftRect, right: NormalizedTopLeftRect): number {
  const leftCenter = center(left);
  const rightCenter = center(right);
  return Math.hypot(leftCenter.x - rightCenter.x, leftCenter.y - rightCenter.y);
}

function associationCost(
  track: MutableTrack,
  detection: RawFaceDetection,
  assetTimeUs: number,
  config: FaceTrackingConfig,
): number {
  const predicted = predictedRect(track, assetTimeUs);
  const iou = normalizedRectIou(predicted, detection.rect);
  const distance = centerDistance(predicted, detection.rect);
  if (iou < config.minimumIou && distance > config.maximumCenterDistance) {
    return INVALID_MATCH_COST;
  }
  const normalizedDistance = Math.min(1, distance / config.maximumCenterDistance);
  return config.iouWeight * (1 - iou) + (1 - config.iouWeight) * normalizedDistance;
}

/**
 * Minimum-cost row assignment for a rectangular matrix with at least as many
 * columns as rows. Iteration order is deliberate so equal-cost solutions are
 * stable after tracks and detections have been canonically ordered.
 */
function minimumCostAssignment(costs: readonly (readonly number[])[]): readonly number[] {
  const rowCount = costs.length;
  if (rowCount === 0) return [];
  const columnCount = costs[0]?.length ?? 0;
  if (columnCount < rowCount || costs.some(row => row.length !== columnCount)) {
    throw new TypeError("Face association cost matrix must be rectangular with enough columns.");
  }

  const rowPotential = Array.from({ length: rowCount + 1 }, () => 0);
  const columnPotential = Array.from({ length: columnCount + 1 }, () => 0);
  const matchedRowByColumn = Array.from({ length: columnCount + 1 }, () => 0);
  const predecessorColumn = Array.from({ length: columnCount + 1 }, () => 0);

  for (let row = 1; row <= rowCount; row += 1) {
    matchedRowByColumn[0] = row;
    let currentColumn = 0;
    const minimumReducedCost = Array.from({ length: columnCount + 1 }, () => Number.POSITIVE_INFINITY);
    const used = Array.from({ length: columnCount + 1 }, () => false);
    do {
      used[currentColumn] = true;
      const currentRow = matchedRowByColumn[currentColumn]!;
      let delta = Number.POSITIVE_INFINITY;
      let nextColumn = 0;
      for (let column = 1; column <= columnCount; column += 1) {
        if (used[column]) continue;
        const reducedCost = costs[currentRow - 1]![column - 1]!
          - rowPotential[currentRow]!
          - columnPotential[column]!;
        if (reducedCost < minimumReducedCost[column]!) {
          minimumReducedCost[column] = reducedCost;
          predecessorColumn[column] = currentColumn;
        }
        if (
          minimumReducedCost[column]! < delta
          || (minimumReducedCost[column] === delta && column < nextColumn)
        ) {
          delta = minimumReducedCost[column]!;
          nextColumn = column;
        }
      }
      if (!Number.isFinite(delta) || nextColumn === 0) {
        throw new TypeError("Face association could not find a finite assignment.");
      }
      for (let column = 0; column <= columnCount; column += 1) {
        if (used[column]) {
          const matchedRow = matchedRowByColumn[column]!;
          rowPotential[matchedRow] = rowPotential[matchedRow]! + delta;
          columnPotential[column] = columnPotential[column]! - delta;
        } else {
          minimumReducedCost[column] = minimumReducedCost[column]! - delta;
        }
      }
      currentColumn = nextColumn;
    } while (matchedRowByColumn[currentColumn] !== 0);

    do {
      const previousColumn = predecessorColumn[currentColumn]!;
      matchedRowByColumn[currentColumn] = matchedRowByColumn[previousColumn]!;
      currentColumn = previousColumn;
    } while (currentColumn !== 0);
  }

  const assignedColumnByRow = Array.from({ length: rowCount }, () => -1);
  for (let column = 1; column <= columnCount; column += 1) {
    const row = matchedRowByColumn[column]!;
    if (row !== 0) assignedColumnByRow[row - 1] = column - 1;
  }
  return assignedColumnByRow;
}

function trackId(index: number): FaceTrackId {
  return FaceTrackIdSchema.parse(`face_${String(index).padStart(8, "0")}`);
}

function maximumObservedGapUs(observations: readonly TrackObservation[]): number {
  let maximum = 0;
  for (let index = 1; index < observations.length; index += 1) {
    maximum = Math.max(maximum, observations[index]!.assetTimeUs - observations[index - 1]!.assetTimeUs);
  }
  return maximum;
}

/**
 * Associates local detector boxes by geometry only. Input frame and detection
 * order do not influence the output; births receive deterministic IDs in
 * asset-time and top-left geometry order.
 */
export function associateFaceDetections(
  framesInput: unknown,
  configInput: unknown,
): FaceAssociationResult {
  const config = FaceTrackingConfigSchema.parse(configInput);
  const frames = [...RawFaceDetectionFramesSchema.parse(framesInput)]
    .sort((left, right) => left.assetTimeUs - right.assetTimeUs);
  for (let index = 1; index < frames.length; index += 1) {
    if (frames[index]!.assetTimeUs === frames[index - 1]!.assetTimeUs) {
      throw new TypeError("Raw face detection frame times must be unique.");
    }
  }

  const tracks: MutableTrack[] = [];
  const results: AnalyzedFaceFrameResult[] = [];

  for (const frame of frames) {
    const selected = selectedDetections(frame, config);
    const activeTracks = tracks
      .filter((track) => {
        const last = track.observations.at(-1);
        return last !== undefined && frame.assetTimeUs - last.assetTimeUs <= config.maximumGapUs;
      })
      .sort((left, right) => left.trackId.localeCompare(right.trackId));

    const costs = activeTracks.map((track) => [
      ...selected.detections.map(detection => associationCost(track, detection, frame.assetTimeUs, config)),
      ...activeTracks.map(() => UNMATCHED_TRACK_COST),
    ]);
    const assignedColumns = minimumCostAssignment(costs);
    const matchedDetectionIndexes = new Set<number>();
    const detections: TrackedFaceDetection[] = [];

    for (let trackIndex = 0; trackIndex < activeTracks.length; trackIndex += 1) {
      const detectionIndex = assignedColumns[trackIndex]!;
      const track = activeTracks[trackIndex]!;
      const detection = selected.detections[detectionIndex];
      if (
        detection === undefined
        || detectionIndex >= selected.detections.length
        || costs[trackIndex]![detectionIndex]! >= INVALID_MATCH_COST
      ) {
        continue;
      }
      matchedDetectionIndexes.add(detectionIndex);
      track.observations.push({
        assetTimeUs: frame.assetTimeUs,
        confidence: detection.confidence,
        rect: detection.rect,
      });
      detections.push({ ...detection, trackId: track.trackId });
    }

    for (let detectionIndex = 0; detectionIndex < selected.detections.length; detectionIndex += 1) {
      if (matchedDetectionIndexes.has(detectionIndex)) continue;
      if (tracks.length >= MAX_TRACKS) {
        throw new RangeError(`Face association exceeds the ${MAX_TRACKS} track evidence limit.`);
      }
      const detection = selected.detections[detectionIndex]!;
      const created: MutableTrack = {
        observations: [{
          assetTimeUs: frame.assetTimeUs,
          confidence: detection.confidence,
          rect: detection.rect,
        }],
        trackId: trackId(tracks.length + 1),
      };
      tracks.push(created);
      detections.push({ ...detection, trackId: created.trackId });
    }

    results.push(FaceAnalysisFrameResultSchema.parse({
      assetTimeUs: frame.assetTimeUs,
      detections: detections.sort((left, right) => left.trackId.localeCompare(right.trackId)),
      discardedDetections: selected.discardedDetections,
      state: "analyzed",
    }) as AnalyzedFaceFrameResult);
  }

  return {
    results,
    tracks: tracks.map((track) => FaceTrackSchema.parse({
      firstSeenAssetTimeUs: track.observations[0]!.assetTimeUs,
      lastSeenAssetTimeUs: track.observations.at(-1)!.assetTimeUs,
      maximumObservedGapUs: maximumObservedGapUs(track.observations),
      observationCount: track.observations.length,
      trackId: track.trackId,
    })),
  };
}
