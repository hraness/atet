import { expect, test } from "bun:test";

import { AnalyzerEvidenceV1Schema } from "../contracts/render";
import { RecordingEventV1Schema } from "../contracts/recording";
import { planAutomaticInactivityCuts } from "./inactivity";

const evidence = AnalyzerEvidenceV1Schema.parse({
  audio: [],
  displays: [{
    intervals: [{ confidence: 1, meanFrameDifference: 0, range: { endUs: 10_000_000, startUs: 0 } }],
    trackId: "track_display01",
  }],
  kind: "studio.analyzer-evidence",
  schemaVersion: 1,
  sourceDurationUs: 10_000_000,
  tool: { name: "fixture", version: "1" },
});

test("cuts only all-display inactivity above threshold and keeps handles", () => {
  const result = planAutomaticInactivityCuts(evidence, [], {
    cursorMovementThresholdPx: 5,
    edgeHandleUs: 1_000_000,
    interactionHandleUs: 100_000,
    minimumCutUs: 2_000_000,
    requireAudioSilence: false,
  });
  expect(result.cuts).toEqual([{ startUs: 1_000_000, endUs: 9_000_000 }]);
});

test("protects real cursor movement without treating stationary sampling as activity", () => {
  const positions = [{ x: 10, y: 10 }, { x: 10, y: 10 }, { x: 100, y: 10 }];
  const events = positions.map((position, index) => RecordingEventV1Schema.parse({
    displayId: "display-primary",
    nativeTimeUs: index * 1_000_000,
    position,
    sequence: index,
    sourceTimeUs: index * 1_000_000,
    type: "cursor.sample",
    visible: true,
  }));
  const result = planAutomaticInactivityCuts(evidence, events, {
    cursorMovementThresholdPx: 5,
    edgeHandleUs: 0,
    interactionHandleUs: 100_000,
    minimumCutUs: 500_000,
    requireAudioSilence: false,
  });
  expect(result.cuts).toEqual([
    { startUs: 0, endUs: 900_000 },
    { startUs: 2_100_001, endUs: 10_000_000 },
  ]);
});

test("requires confident freeze evidence unless explicitly lowered", () => {
  const uncertain = AnalyzerEvidenceV1Schema.parse({
    ...evidence,
    displays: [{
      intervals: [{ confidence: 0.5, meanFrameDifference: 0, range: { endUs: 10_000_000, startUs: 0 } }],
      trackId: "track_display01",
    }],
  });
  const config = {
    cursorMovementThresholdPx: 5,
    edgeHandleUs: 0,
    interactionHandleUs: 0,
    minimumCutUs: 1,
    requireAudioSilence: false,
  } as const;
  expect(planAutomaticInactivityCuts(uncertain, [], config).cuts).toEqual([]);
  expect(planAutomaticInactivityCuts(uncertain, [], { ...config, minimumFreezeConfidence: 0.5 }).cuts)
    .toEqual([{ startUs: 0, endUs: 10_000_000 }]);
});

test("rejects analyzer ranges outside source time and duplicate track evidence", () => {
  expect(() => AnalyzerEvidenceV1Schema.parse({
    ...evidence,
    displays: [{
      intervals: [{ confidence: 1, meanFrameDifference: 0, range: { endUs: 10_000_001, startUs: 0 } }],
      trackId: "track_display01",
    }],
  })).toThrow(/exceed sourceDurationUs/u);
  expect(() => AnalyzerEvidenceV1Schema.parse({
    ...evidence,
    displays: [evidence.displays[0], evidence.displays[0]],
  })).toThrow(/track IDs must be unique/u);
});
