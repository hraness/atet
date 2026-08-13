import type { SourceInterval } from "../contracts/edit";

function compareIntervals(left: SourceInterval, right: SourceInterval): number {
  return left.startUs - right.startUs || left.endUs - right.endUs;
}

export function intervalDurationUs(interval: SourceInterval): number {
  return interval.endUs - interval.startUs;
}

export function unionIntervals(intervals: readonly SourceInterval[]): readonly SourceInterval[] {
  if (intervals.length === 0) return [];
  const ordered = [...intervals].sort(compareIntervals);
  const result: SourceInterval[] = [];
  for (const interval of ordered) {
    if (interval.endUs <= interval.startUs) continue;
    const prior = result.at(-1);
    if (prior === undefined || interval.startUs > prior.endUs) {
      result.push({ startUs: interval.startUs, endUs: interval.endUs });
      continue;
    }
    if (interval.endUs > prior.endUs) {
      result[result.length - 1] = { startUs: prior.startUs, endUs: interval.endUs };
    }
  }
  return result;
}

export function intersectIntervals(
  left: readonly SourceInterval[],
  right: readonly SourceInterval[],
): readonly SourceInterval[] {
  const normalizedLeft = unionIntervals(left);
  const normalizedRight = unionIntervals(right);
  const result: SourceInterval[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < normalizedLeft.length && rightIndex < normalizedRight.length) {
    const leftInterval = normalizedLeft[leftIndex];
    const rightInterval = normalizedRight[rightIndex];
    if (leftInterval === undefined || rightInterval === undefined) break;
    const startUs = Math.max(leftInterval.startUs, rightInterval.startUs);
    const endUs = Math.min(leftInterval.endUs, rightInterval.endUs);
    if (endUs > startUs) result.push({ startUs, endUs });
    if (leftInterval.endUs <= rightInterval.endUs) leftIndex += 1;
    else rightIndex += 1;
  }
  return result;
}

export function intersectManyIntervalSets(
  sets: readonly (readonly SourceInterval[])[],
): readonly SourceInterval[] {
  if (sets.length === 0) return [];
  const first = sets[0];
  if (first === undefined) return [];
  return sets.slice(1).reduce<readonly SourceInterval[]>(
    (result, intervals) => intersectIntervals(result, intervals),
    unionIntervals(first),
  );
}

export function subtractIntervals(
  source: readonly SourceInterval[],
  removed: readonly SourceInterval[],
): readonly SourceInterval[] {
  const normalizedSource = unionIntervals(source);
  const normalizedRemoved = unionIntervals(removed);
  const result: SourceInterval[] = [];
  let removedIndex = 0;
  for (const sourceInterval of normalizedSource) {
    let cursor = sourceInterval.startUs;
    while (
      removedIndex < normalizedRemoved.length
      && (normalizedRemoved[removedIndex]?.endUs ?? Number.POSITIVE_INFINITY) <= cursor
    ) {
      removedIndex += 1;
    }
    let scanIndex = removedIndex;
    while (scanIndex < normalizedRemoved.length) {
      const cut = normalizedRemoved[scanIndex];
      if (cut === undefined || cut.startUs >= sourceInterval.endUs) break;
      if (cut.startUs > cursor) {
        result.push({ startUs: cursor, endUs: Math.min(cut.startUs, sourceInterval.endUs) });
      }
      cursor = Math.max(cursor, cut.endUs);
      if (cursor >= sourceInterval.endUs) break;
      scanIndex += 1;
    }
    if (cursor < sourceInterval.endUs) result.push({ startUs: cursor, endUs: sourceInterval.endUs });
  }
  return result;
}

export function clipIntervals(
  intervals: readonly SourceInterval[],
  bounds: SourceInterval,
): readonly SourceInterval[] {
  return intersectIntervals(intervals, [bounds]);
}

export function expandIntervals(
  intervals: readonly SourceInterval[],
  beforeUs: number,
  afterUs: number,
  bounds: SourceInterval,
): readonly SourceInterval[] {
  return unionIntervals(intervals.map((interval) => ({
    startUs: Math.max(bounds.startUs, interval.startUs - beforeUs),
    endUs: Math.min(bounds.endUs, interval.endUs + afterUs),
  })));
}

export function intervalContains(container: SourceInterval, candidate: SourceInterval): boolean {
  return container.startUs <= candidate.startUs && container.endUs >= candidate.endUs;
}

export function intervalsContain(
  containers: readonly SourceInterval[],
  candidate: SourceInterval,
): boolean {
  return containers.some((container) => intervalContains(container, candidate));
}
