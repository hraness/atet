import type { EditPlanV1, SourceInterval } from "../contracts/edit";
import { TimeMapSegmentSchema, type TimeMapSegment } from "../contracts/render";
import { intersectIntervals } from "./intervals";

export interface SourceTimeMap {
  readonly durationUs: number;
  readonly segments: readonly TimeMapSegment[];
}

function rateAt(plan: EditPlanV1, sourceTimeUs: number): number {
  return plan.speed.find(({ range }) => range.startUs <= sourceTimeUs && sourceTimeUs < range.endUs)?.rate
    ?? plan.baseSpeed;
}

export function buildSourceTimeMap(plan: EditPlanV1): SourceTimeMap {
  const segments: TimeMapSegment[] = [];
  let outputCursorUs = 0;
  for (const keep of plan.keep) {
    const boundaries = new Set<number>([keep.startUs, keep.endUs]);
    for (const speed of plan.speed) {
      if (speed.range.startUs > keep.startUs && speed.range.startUs < keep.endUs) boundaries.add(speed.range.startUs);
      if (speed.range.endUs > keep.startUs && speed.range.endUs < keep.endUs) boundaries.add(speed.range.endUs);
    }
    const points = [...boundaries].sort((left, right) => left - right);
    for (let index = 1; index < points.length; index += 1) {
      const startUs = points[index - 1];
      const endUs = points[index];
      if (startUs === undefined || endUs === undefined || endUs <= startUs) continue;
      const speed = rateAt(plan, startUs);
      const outputDurationUs = Math.max(1, Math.round((endUs - startUs) / speed));
      const segment = TimeMapSegmentSchema.parse({
        output: { startUs: outputCursorUs, endUs: outputCursorUs + outputDurationUs },
        source: { startUs, endUs },
        speed,
      });
      segments.push(segment);
      outputCursorUs += outputDurationUs;
    }
  }
  return { durationUs: outputCursorUs, segments };
}

function interpolate(
  value: number,
  inputStart: number,
  inputEnd: number,
  outputStart: number,
  outputEnd: number,
): number {
  const ratio = (value - inputStart) / (inputEnd - inputStart);
  return Math.round(outputStart + ratio * (outputEnd - outputStart));
}

export function sourceToOutputUs(map: SourceTimeMap, sourceTimeUs: number): number | null {
  const segment = map.segments.find(({ source }) => source.startUs <= sourceTimeUs && sourceTimeUs < source.endUs)
    ?? [...map.segments].reverse().find(({ source }) => source.endUs === sourceTimeUs);
  if (segment === undefined) return null;
  return interpolate(
    sourceTimeUs,
    segment.source.startUs,
    segment.source.endUs,
    segment.output.startUs,
    segment.output.endUs,
  );
}

export function outputToSourceUs(map: SourceTimeMap, outputTimeUs: number): number | null {
  const segment = map.segments.find(({ output }) => output.startUs <= outputTimeUs && outputTimeUs < output.endUs)
    ?? map.segments.at(-1);
  if (segment === undefined || outputTimeUs < 0 || outputTimeUs > map.durationUs) return null;
  if (outputTimeUs < segment.output.startUs || outputTimeUs > segment.output.endUs) return null;
  return interpolate(
    outputTimeUs,
    segment.output.startUs,
    segment.output.endUs,
    segment.source.startUs,
    segment.source.endUs,
  );
}

export function mapSourceInterval(
  map: SourceTimeMap,
  interval: SourceInterval,
): readonly { readonly source: SourceInterval; readonly output: SourceInterval }[] {
  return map.segments.flatMap((segment) => intersectIntervals([interval], [segment.source]).flatMap((source) => {
    const outputStart = sourceToOutputUs(map, source.startUs);
    const outputEnd = sourceToOutputUs(map, source.endUs);
    if (outputStart === null || outputEnd === null || outputEnd <= outputStart) return [];
    return [{ source, output: { startUs: outputStart, endUs: outputEnd } }];
  }));
}
