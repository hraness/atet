import { expect, test } from "bun:test";

import {
  AnalysisSubjectSchema,
  ProjectPlacementV1Schema,
  VideoProjectV1Schema,
} from "../contracts";
import { alignmentInputDigest, resolveAudioAnalysisSubject } from "./audio-analysis";

const HASH = "a".repeat(64);
const NOW = "2026-07-22T12:00:00.000Z";

function placement(projectEndUs = 10_000_000) {
  return ProjectPlacementV1Schema.parse({
    assetId: "asset_audiofixture01",
    assetRange: { endUs: 10_000_000, startUs: 0 },
    audio: [{
      presentation: { enabled: true, gainDb: 0, pan: 0 },
      streamId: "stream_audiofixture01",
    }],
    enabled: true,
    placementId: "placement_audiofixture01",
    sync: {
      anchors: [
        { assetTimeUs: 0, projectTimeUs: 0 },
        { assetTimeUs: 10_000_000, projectTimeUs: projectEndUs },
      ],
      provenance: { kind: "manual" },
    },
    video: [],
  });
}

function project(fileStartUs = 500_000) {
  return VideoProjectV1Schema.parse({
    analyses: [],
    assets: [{
      assetId: "asset_audiofixture01",
      createdAt: NOW,
      durationUs: 10_000_000,
      label: "Audio",
      role: "dialogue",
      source: { importedAt: NOW, kind: "imported", originalName: "audio.mov", sourceSha256: HASH },
      streams: [{
        channels: 2,
        kind: "audio",
        label: "Dialogue",
        role: "dialogue",
        sampleRateHz: 48_000,
        segments: [{
          assetRange: { endUs: 10_000_000, startUs: 0 },
          bytes: 1_024,
          codec: "aac",
          container: "mov",
          fileRange: { endUs: fileStartUs + 10_000_000, startUs: fileStartUs },
          path: "fixtures/audio.mov",
          sha256: HASH,
          streamIndex: 1,
        }],
        streamId: "stream_audiofixture01",
      }],
    }],
    createdAt: NOW,
    currentEditPlanPath: "edits/current.json",
    kind: "studio.video-project",
    name: "Audio fixture",
    placements: [placement()],
    projectId: "project_audiofixture01",
    referencePlacementId: "placement_audiofixture01",
    schemaVersion: 1,
    timeline: { durationUs: 10_000_000, timebase: "microseconds" },
    updatedAt: NOW,
  });
}

test("audio analysis subjects cover the complete stream clock mapping", () => {
  const first = resolveAudioAnalysisSubject(
    project(500_000),
    "asset_audiofixture01:stream_audiofixture01",
  ).subject;
  const shifted = resolveAudioAnalysisSubject(
    project(750_000),
    "asset_audiofixture01:stream_audiofixture01",
  ).subject;
  expect(first.integritySha256).not.toBe(shifted.integritySha256);
});

test("alignment input provenance binds both subjects, placement ranges, and reference sync", () => {
  const subject = AnalysisSubjectSchema.parse({
    assetId: "asset_audiofixture01",
    integritySha256: HASH,
    streamId: "stream_audiofixture01",
  });
  const target = AnalysisSubjectSchema.parse({
    assetId: "asset_targetfixture1",
    integritySha256: "b".repeat(64),
    streamId: "stream_targetfixture1",
  });
  const referencePlacement = placement();
  const targetPlacement = ProjectPlacementV1Schema.parse({
    ...referencePlacement,
    assetId: target.assetId,
    placementId: "placement_targetfixture1",
    audio: [{ presentation: { enabled: true, gainDb: 0, pan: 0 }, streamId: target.streamId }],
  });
  const input = {
    config: { analysisSampleRateHz: 8_000, maxDriftPpm: 5_000, minimumOverlapUs: 3_000_000, windowUs: 10_000_000 },
    reference: subject,
    referencePlacement,
    target,
    targetPlacement,
  } as const;
  const digest = alignmentInputDigest(input);
  expect(alignmentInputDigest({ ...input, referencePlacement: placement(9_999_999) })).not.toBe(digest);
  expect(alignmentInputDigest({
    ...input,
    targetPlacement: ProjectPlacementV1Schema.parse({
      ...targetPlacement,
      assetRange: { endUs: 9_000_000, startUs: 0 },
      sync: {
        ...targetPlacement.sync,
        anchors: [
          { assetTimeUs: 0, projectTimeUs: 0 },
          { assetTimeUs: 9_000_000, projectTimeUs: 9_000_000 },
        ],
      },
    }),
  })).not.toBe(digest);
});
