import type { SourceInterval } from "../contracts/edit";
import {
  ProjectEditPlanV1Schema,
  type ProjectEditPlanV1,
  type ProjectPlacementV1,
  type ProjectSyncMap,
} from "../contracts/project";

export interface ProjectSyncSegment {
  readonly asset: SourceInterval;
  readonly project: SourceInterval;
}

export interface ProjectOutputSegment {
  readonly output: SourceInterval;
  readonly project: SourceInterval;
  readonly speed: number;
}

export interface ProjectOutputTimeMap {
  readonly durationUs: number;
  readonly segments: readonly ProjectOutputSegment[];
}

export interface PlacementProjectSlice {
  readonly asset: SourceInterval;
  readonly placementId: ProjectPlacementV1["placementId"];
  readonly project: SourceInterval;
}

export interface PlacementOutputSlice extends PlacementProjectSlice {
  readonly output: SourceInterval;
  readonly speed: number;
}

function requireSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer.`);
  }
}

function roundedRatio(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n || numerator < 0n) {
    throw new RangeError("Interpolation requires a nonnegative numerator and positive denominator.");
  }
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return quotient + (remainder * 2n >= denominator ? 1n : 0n);
}

/**
 * Interpolate one integer-microsecond clock onto another without an unsafe
 * intermediate Number multiplication. Endpoints are exact and interior values
 * use deterministic half-up rounding.
 */
export function interpolateMicroseconds(
  value: number,
  inputStartUs: number,
  inputEndUs: number,
  outputStartUs: number,
  outputEndUs: number,
): number {
  for (const [candidate, label] of [
    [value, "value"],
    [inputStartUs, "inputStartUs"],
    [inputEndUs, "inputEndUs"],
    [outputStartUs, "outputStartUs"],
    [outputEndUs, "outputEndUs"],
  ] as const) {
    requireSafeInteger(candidate, label);
  }
  if (inputEndUs <= inputStartUs || outputEndUs <= outputStartUs) {
    throw new RangeError("Interpolation ranges must increase strictly.");
  }
  if (value < inputStartUs || value > inputEndUs) {
    throw new RangeError("Interpolation value lies outside its input range.");
  }
  if (value === inputStartUs) return outputStartUs;
  if (value === inputEndUs) return outputEndUs;

  const inputDelta = BigInt(inputEndUs) - BigInt(inputStartUs);
  const outputDelta = BigInt(outputEndUs) - BigInt(outputStartUs);
  const offset = BigInt(value) - BigInt(inputStartUs);
  const result = BigInt(outputStartUs) + roundedRatio(offset * outputDelta, inputDelta);
  const output = Number(result);
  if (!Number.isSafeInteger(output)) {
    throw new RangeError("Interpolated microseconds exceed the safe integer range.");
  }
  return output;
}

export function projectSyncSegments(sync: ProjectSyncMap): readonly ProjectSyncSegment[] {
  const segments: ProjectSyncSegment[] = [];
  for (let index = 1; index < sync.anchors.length; index += 1) {
    const left = sync.anchors[index - 1];
    const right = sync.anchors[index];
    if (left === undefined || right === undefined) continue;
    segments.push({
      asset: { endUs: right.assetTimeUs, startUs: left.assetTimeUs },
      project: { endUs: right.projectTimeUs, startUs: left.projectTimeUs },
    });
  }
  return segments;
}

function firstProjectAnchorAtLeast(
  sync: ProjectSyncMap,
  projectTimeUs: number,
): number {
  let low = 0;
  let high = sync.anchors.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (sync.anchors[middle]!.projectTimeUs < projectTimeUs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function firstProjectAnchorAfter(
  sync: ProjectSyncMap,
  projectTimeUs: number,
): number {
  let low = 0;
  let high = sync.anchors.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (sync.anchors[middle]!.projectTimeUs <= projectTimeUs) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function projectSubrangeMapsToAssetDuration(
  sync: ProjectSyncMap,
  segmentIndex: number,
  startUs: number,
  endUs: number,
): boolean {
  const left = sync.anchors[segmentIndex];
  const right = sync.anchors[segmentIndex + 1];
  if (left === undefined || right === undefined || endUs <= startUs) {
    return false;
  }
  return interpolateMicroseconds(
    endUs,
    left.projectTimeUs,
    right.projectTimeUs,
    left.assetTimeUs,
    right.assetTimeUs,
  ) > interpolateMicroseconds(
    startUs,
    left.projectTimeUs,
    right.projectTimeUs,
    left.assetTimeUs,
    right.assetTimeUs,
  );
}

/**
 * Checks complete placement coverage without materializing or linearly
 * scanning every sync segment. Only the two partial edge segments can collapse
 * under integer clock interpolation; complete interior segments are strictly
 * increasing by contract.
 */
export function projectIntervalHasCompleteSyncCoverage(
  sync: ProjectSyncMap,
  range: SourceInterval,
): boolean {
  const first = sync.anchors[0];
  const last = sync.anchors.at(-1);
  if (
    first === undefined
    || last === undefined
    || range.endUs <= range.startUs
    || range.startUs < first.projectTimeUs
    || range.endUs > last.projectTimeUs
  ) {
    return false;
  }
  const startSegment = firstProjectAnchorAfter(
    sync,
    range.startUs,
  ) - 1;
  const endSegment = firstProjectAnchorAtLeast(
    sync,
    range.endUs,
  ) - 1;
  if (startSegment < 0 || endSegment < startSegment) return false;
  if (startSegment === endSegment) {
    return projectSubrangeMapsToAssetDuration(
      sync,
      startSegment,
      range.startUs,
      range.endUs,
    );
  }
  const firstSegmentEndUs = sync.anchors[startSegment + 1]?.projectTimeUs;
  const lastSegmentStartUs = sync.anchors[endSegment]?.projectTimeUs;
  return firstSegmentEndUs !== undefined
    && lastSegmentStartUs !== undefined
    && projectSubrangeMapsToAssetDuration(
      sync,
      startSegment,
      range.startUs,
      firstSegmentEndUs,
    )
    && projectSubrangeMapsToAssetDuration(
      sync,
      endSegment,
      lastSegmentStartUs,
      range.endUs,
    );
}

function segmentAt(
  segments: readonly ProjectSyncSegment[],
  value: number,
  clock: "asset" | "project",
): ProjectSyncSegment | undefined {
  const containing = segments.find(segment => (
    segment[clock].startUs <= value && value < segment[clock].endUs
  ));
  if (containing !== undefined) return containing;
  const final = segments.at(-1);
  return final?.[clock].endUs === value ? final : undefined;
}

export function assetToProjectUs(sync: ProjectSyncMap, assetTimeUs: number): number | null {
  const segment = segmentAt(projectSyncSegments(sync), assetTimeUs, "asset");
  return segment === undefined
    ? null
    : interpolateMicroseconds(
        assetTimeUs,
        segment.asset.startUs,
        segment.asset.endUs,
        segment.project.startUs,
        segment.project.endUs,
      );
}

export function projectToAssetUs(sync: ProjectSyncMap, projectTimeUs: number): number | null {
  const segment = segmentAt(projectSyncSegments(sync), projectTimeUs, "project");
  return segment === undefined
    ? null
    : interpolateMicroseconds(
        projectTimeUs,
        segment.project.startUs,
        segment.project.endUs,
        segment.asset.startUs,
        segment.asset.endUs,
      );
}

function intersection(left: SourceInterval, right: SourceInterval): SourceInterval | null {
  const startUs = Math.max(left.startUs, right.startUs);
  const endUs = Math.min(left.endUs, right.endUs);
  return endUs > startUs ? { endUs, startUs } : null;
}

export function mapAssetIntervalToProjectSlices(
  placement: ProjectPlacementV1,
  assetRange: SourceInterval,
): readonly PlacementProjectSlice[] {
  return projectSyncSegments(placement.sync).flatMap(segment => {
    const asset = intersection(assetRange, segment.asset);
    if (asset === null) return [];
    const projectStartUs = interpolateMicroseconds(
      asset.startUs,
      segment.asset.startUs,
      segment.asset.endUs,
      segment.project.startUs,
      segment.project.endUs,
    );
    const projectEndUs = interpolateMicroseconds(
      asset.endUs,
      segment.asset.startUs,
      segment.asset.endUs,
      segment.project.startUs,
      segment.project.endUs,
    );
    if (projectEndUs <= projectStartUs) return [];
    return [{
      asset,
      placementId: placement.placementId,
      project: { endUs: projectEndUs, startUs: projectStartUs },
    }];
  });
}

export function mapProjectIntervalToAssetSlices(
  placement: ProjectPlacementV1,
  projectRange: SourceInterval,
): readonly PlacementProjectSlice[] {
  return projectSyncSegments(placement.sync).flatMap(segment => {
    const project = intersection(projectRange, segment.project);
    if (project === null) return [];
    const assetStartUs = interpolateMicroseconds(
      project.startUs,
      segment.project.startUs,
      segment.project.endUs,
      segment.asset.startUs,
      segment.asset.endUs,
    );
    const assetEndUs = interpolateMicroseconds(
      project.endUs,
      segment.project.startUs,
      segment.project.endUs,
      segment.asset.startUs,
      segment.asset.endUs,
    );
    if (assetEndUs <= assetStartUs) return [];
    return [{
      asset: { endUs: assetEndUs, startUs: assetStartUs },
      placementId: placement.placementId,
      project,
    }];
  });
}

function speedAt(plan: ProjectEditPlanV1, projectTimeUs: number): number {
  return plan.speed.find(speed => (
    speed.range.startUs <= projectTimeUs && projectTimeUs < speed.range.endUs
  ))?.rate ?? plan.baseSpeed;
}

export function buildProjectOutputTimeMap(input: ProjectEditPlanV1): ProjectOutputTimeMap {
  const plan = ProjectEditPlanV1Schema.parse(input);
  const segments: ProjectOutputSegment[] = [];
  let outputCursorUs = 0;
  for (const keep of plan.keep) {
    const boundaries = new Set<number>([keep.startUs, keep.endUs]);
    for (const speed of plan.speed) {
      if (speed.range.startUs > keep.startUs && speed.range.startUs < keep.endUs) {
        boundaries.add(speed.range.startUs);
      }
      if (speed.range.endUs > keep.startUs && speed.range.endUs < keep.endUs) {
        boundaries.add(speed.range.endUs);
      }
    }
    const ordered = [...boundaries].sort((left, right) => left - right);
    for (let index = 1; index < ordered.length; index += 1) {
      const startUs = ordered[index - 1];
      const endUs = ordered[index];
      if (startUs === undefined || endUs === undefined || endUs <= startUs) continue;
      const speed = speedAt(plan, startUs);
      const outputDurationUs = Math.max(1, Math.round((endUs - startUs) / speed));
      segments.push({
        output: { endUs: outputCursorUs + outputDurationUs, startUs: outputCursorUs },
        project: { endUs, startUs },
        speed,
      });
      outputCursorUs += outputDurationUs;
    }
  }
  return { durationUs: outputCursorUs, segments };
}

function outputSegmentAt(
  map: ProjectOutputTimeMap,
  value: number,
  clock: "output" | "project",
): ProjectOutputSegment | undefined {
  const containing = map.segments.find(segment => (
    segment[clock].startUs <= value && value < segment[clock].endUs
  ));
  if (containing !== undefined) return containing;
  if (clock === "project") {
    return [...map.segments].reverse().find(segment => segment.project.endUs === value);
  }
  const final = map.segments.at(-1);
  return final?.output.endUs === value ? final : undefined;
}

export function projectToOutputUs(map: ProjectOutputTimeMap, projectTimeUs: number): number | null {
  const segment = outputSegmentAt(map, projectTimeUs, "project");
  return segment === undefined
    ? null
    : interpolateMicroseconds(
        projectTimeUs,
        segment.project.startUs,
        segment.project.endUs,
        segment.output.startUs,
        segment.output.endUs,
      );
}

export function outputToProjectUs(map: ProjectOutputTimeMap, outputTimeUs: number): number | null {
  const segment = outputSegmentAt(map, outputTimeUs, "output");
  return segment === undefined
    ? null
    : interpolateMicroseconds(
        outputTimeUs,
        segment.output.startUs,
        segment.output.endUs,
        segment.project.startUs,
        segment.project.endUs,
      );
}

export function mapProjectIntervalToOutputSlices(
  map: ProjectOutputTimeMap,
  projectRange: SourceInterval,
): readonly {
  readonly output: SourceInterval;
  readonly project: SourceInterval;
  readonly speed: number;
}[] {
  return map.segments.flatMap(segment => {
    const project = intersection(projectRange, segment.project);
    if (project === null) return [];
    const outputStartUs = interpolateMicroseconds(
      project.startUs,
      segment.project.startUs,
      segment.project.endUs,
      segment.output.startUs,
      segment.output.endUs,
    );
    const outputEndUs = interpolateMicroseconds(
      project.endUs,
      segment.project.startUs,
      segment.project.endUs,
      segment.output.startUs,
      segment.output.endUs,
    );
    if (outputEndUs <= outputStartUs) return [];
    return [{
      output: { endUs: outputEndUs, startUs: outputStartUs },
      project,
      speed: segment.speed,
    }];
  });
}

export function mapPlacementToOutputSlices(
  placement: ProjectPlacementV1,
  map: ProjectOutputTimeMap,
): readonly PlacementOutputSlice[] {
  return map.segments.flatMap(outputSegment => (
    mapProjectIntervalToAssetSlices(placement, outputSegment.project).flatMap(slice => {
      const outputStartUs = interpolateMicroseconds(
        slice.project.startUs,
        outputSegment.project.startUs,
        outputSegment.project.endUs,
        outputSegment.output.startUs,
        outputSegment.output.endUs,
      );
      const outputEndUs = interpolateMicroseconds(
        slice.project.endUs,
        outputSegment.project.startUs,
        outputSegment.project.endUs,
        outputSegment.output.startUs,
        outputSegment.output.endUs,
      );
      if (outputEndUs <= outputStartUs) return [];
      return [{
        ...slice,
        output: { endUs: outputEndUs, startUs: outputStartUs },
        speed: outputSegment.speed,
      }];
    })
  ));
}
