import {
  AnalyzerEvidenceV1Schema,
  InactivityPlannerConfigSchema,
  type AnalyzerEvidenceV1,
  type InactivityPlannerConfig,
} from "../contracts/render";
import type { SourceInterval } from "../contracts/edit";
import type { RecordingEventV1 } from "../contracts/recording";
import { clipIntervals, expandIntervals, intersectManyIntervalSets, subtractIntervals } from "./intervals";

export const DEFAULT_MINIMUM_FREEZE_CONFIDENCE = 0.9;

export interface AutomaticInactivityPlan {
  readonly cuts: readonly SourceInterval[];
  readonly candidateCount: number;
  readonly protectedInteractionCount: number;
}

export type InactivityInteractionSource =
  | "mouse.click"
  | "key.activity"
  | "typing.input"
  | "focus.changed"
  | "cursor.movement";

export interface InactivityInteractionInterval {
  readonly range: SourceInterval;
  readonly source: InactivityInteractionSource;
}

export function recordingInteractionIntervals(
  events: readonly RecordingEventV1[],
  cursorMovementThresholdPx: number,
): readonly InactivityInteractionInterval[] {
  const explicit = events.flatMap((event) => {
    switch (event.type) {
      case "mouse.click":
      case "key.activity":
      case "typing.input":
      case "focus.changed":
        return [{
          range: { startUs: event.sourceTimeUs, endUs: event.sourceTimeUs + 1 },
          source: event.type,
        }];
      case "cursor.sample":
      case "window.snapshot":
      case "window.changed":
      case "display.topology":
      case "lifecycle.marker":
      case "diagnostic.dropped-events":
        return [];
      default:
        return [];
    }
  });
  const priorCursorByDisplay = new Map<string, Extract<RecordingEventV1, { readonly type: "cursor.sample" }>>();
  const movement: InactivityInteractionInterval[] = [];
  for (const event of [...events].sort((left, right) => left.sourceTimeUs - right.sourceTimeUs || left.sequence - right.sequence)) {
    if (event.type !== "cursor.sample") continue;
    const prior = priorCursorByDisplay.get(event.displayId);
    if (
      prior !== undefined
      && Math.hypot(event.position.x - prior.position.x, event.position.y - prior.position.y) > cursorMovementThresholdPx
      && event.sourceTimeUs > prior.sourceTimeUs
    ) {
      movement.push({
        range: { startUs: prior.sourceTimeUs, endUs: event.sourceTimeUs + 1 },
        source: "cursor.movement",
      });
    }
    priorCursorByDisplay.set(event.displayId, event);
  }
  return [...explicit, ...movement].sort((left, right) => (
    left.range.startUs - right.range.startUs
    || left.range.endUs - right.range.endUs
    || left.source.localeCompare(right.source)
  ));
}

export interface MappedInactivityEvidence {
  readonly audioIntervals: readonly (readonly SourceInterval[])[];
  readonly displayIntervals: readonly (readonly SourceInterval[])[];
  readonly interactionIntervals: readonly SourceInterval[];
  readonly sourceDurationUs: number;
}

export function planMappedInactivityCuts(
  evidence: MappedInactivityEvidence,
  configInput: InactivityPlannerConfig,
): AutomaticInactivityPlan {
  const config = InactivityPlannerConfigSchema.parse(configInput);
  const sourceBounds = { startUs: 0, endUs: evidence.sourceDurationUs };
  let candidates = clipIntervals(intersectManyIntervalSets(evidence.displayIntervals), sourceBounds);
  if (config.requireAudioSilence) {
    if (evidence.audioIntervals.length === 0) {
      return { cuts: [], candidateCount: candidates.length, protectedInteractionCount: 0 };
    }
    candidates = intersectManyIntervalSets([candidates, ...evidence.audioIntervals]);
  }
  const edgeHandled = candidates.flatMap(({ startUs, endUs }) => {
    const handled = { startUs: startUs + config.edgeHandleUs, endUs: endUs - config.edgeHandleUs };
    return handled.endUs > handled.startUs ? [handled] : [];
  });
  const protectedInteractions = expandIntervals(
    evidence.interactionIntervals,
    config.interactionHandleUs,
    config.interactionHandleUs,
    sourceBounds,
  );
  const cuts = clipIntervals(subtractIntervals(edgeHandled, protectedInteractions), sourceBounds)
    .filter(({ startUs, endUs }) => endUs - startUs >= config.minimumCutUs);
  return {
    candidateCount: candidates.length,
    cuts,
    protectedInteractionCount: protectedInteractions.length,
  };
}

export function planAutomaticInactivityCuts(
  evidenceInput: AnalyzerEvidenceV1,
  events: readonly RecordingEventV1[],
  configInput: InactivityPlannerConfig,
): AutomaticInactivityPlan {
  const evidence = AnalyzerEvidenceV1Schema.parse(evidenceInput);
  const config = InactivityPlannerConfigSchema.parse(configInput);
  const minimumFreezeConfidence = config.minimumFreezeConfidence ?? DEFAULT_MINIMUM_FREEZE_CONFIDENCE;
  const displaySets = evidence.displays.map(({ intervals }) => intervals
    .filter(({ confidence }) => confidence >= minimumFreezeConfidence)
    .map(({ range }) => range));
  return planMappedInactivityCuts({
    audioIntervals: evidence.audio.map(({ intervals }) => intervals.map(({ range }) => range)),
    displayIntervals: displaySets,
    interactionIntervals: recordingInteractionIntervals(events, config.cursorMovementThresholdPx)
      .map(({ range }) => range),
    sourceDurationUs: evidence.sourceDurationUs,
  }, config);
}
