import { expect, test } from "bun:test";

import {
  ProjectInactivityAnalysisV1Schema,
  EditPlanIdSchema,
  VideoProjectV1Schema,
  type VideoProjectV1,
} from "../contracts";
import { createDefaultProjectEditPlan, hashProjectStructure } from "./project-plan";
import { applyProjectInactivityPlan, projectInactivityDerivations } from "./project-inactivity";

const HASH = "a".repeat(64);
const NOW = "2026-07-22T15:00:00.000Z";

function project(): VideoProjectV1 {
  return VideoProjectV1Schema.parse({
    analyses: [],
    assets: [{
      assetId: "asset_screen00001",
      createdAt: NOW,
      durationUs: 10_000_000,
      label: "Screen",
      role: "screen",
      source: { importedAt: NOW, kind: "imported", originalName: "screen.mov", sourceSha256: HASH },
      streams: [{
        frameRate: 60,
        kind: "video",
        label: "Screen",
        pixelHeight: 1_080,
        pixelWidth: 1_920,
        role: "screen",
        segments: [{
          assetRange: { endUs: 10_000_000, startUs: 0 },
          bytes: 100,
          codec: "h264",
          container: "mov",
          fileRange: { endUs: 10_000_000, startUs: 0 },
          path: "fixtures/screen.mov",
          sha256: HASH,
          streamIndex: 0,
        }],
        streamId: "stream_screen00001",
      }],
    }],
    createdAt: NOW,
    currentEditPlanPath: "edits/current.json",
    kind: "studio.video-project",
    name: "Screen",
    placements: [{
      assetId: "asset_screen00001",
      assetRange: { endUs: 10_000_000, startUs: 0 },
      audio: [],
      enabled: true,
      placementId: "placement_screen01",
      sync: {
        anchors: [
          { assetTimeUs: 0, projectTimeUs: 0 },
          { assetTimeUs: 10_000_000, projectTimeUs: 10_000_000 },
        ],
        provenance: { kind: "identity" },
      },
      video: [{
        presentation: {
          blendMode: "normal",
          crop: { kind: "none" },
          enabled: true,
          fit: "fill",
          layer: 0,
          layout: { height: 1, kind: "normalized", width: 1, x: 0, y: 0 },
          opacity: 1,
        },
        streamId: "stream_screen00001",
      }],
    }],
    projectId: "project_inactive01",
    referencePlacementId: "placement_screen01",
    schemaVersion: 1,
    timeline: { durationUs: 10_000_000, timebase: "microseconds" },
    updatedAt: NOW,
  });
}

function analysis(inputProject: VideoProjectV1) {
  return ProjectInactivityAnalysisV1Schema.parse({
    analysisId: "analysis_inactive01",
    audio: [],
    config: {
      cursorMovementThresholdPx: 2,
      edgeHandleUs: 250_000,
      interactionHandleUs: 750_000,
      minimumCutUs: 3_000_000,
      minimumFreezeConfidence: 0.9,
      motionThreshold: 0.003,
      requireAudioSilence: false,
    },
    createdAt: NOW,
    displays: [{
      intervals: [{
        assetRange: { endUs: 8_000_000, startUs: 2_000_000 },
        confidence: 1,
        meanFrameDifference: 0.003,
        projectRange: { endUs: 8_000_000, startUs: 2_000_000 },
      }],
      placementAssetRange: { endUs: 10_000_000, startUs: 0 },
      placementId: "placement_screen01",
      subject: { assetId: "asset_screen00001", integritySha256: HASH, streamId: "stream_screen00001" },
      syncMapSha256: HASH,
    }],
    durationUs: 10_000_000,
    inputDigest: HASH,
    interactions: [],
    kind: "studio.project-inactivity-analysis",
    projectId: inputProject.projectId,
    projectStructureSha256: hashProjectStructure(inputProject),
    referenceRecording: null,
    result: {
      candidateCount: 2,
      protectedInteractionCount: 1,
      recommendedRanges: [
        { endUs: 4_000_000, startUs: 2_000_000 },
        { endUs: 8_000_000, startUs: 6_000_000 },
      ],
    },
    schemaVersion: 1,
    tool: { name: "fixture", profile: "project-clock-v1", version: "1" },
  });
}

function withUnverifiedImportedPlacement(inputProject: VideoProjectV1): VideoProjectV1 {
  const sourceAsset = inputProject.assets[0]!;
  const sourceStream = sourceAsset.streams[0]!;
  const sourcePlacement = inputProject.placements[0]!;
  const importedStream = {
    ...sourceStream,
    streamId: "stream_imported_video01",
  };
  return VideoProjectV1Schema.parse({
    ...inputProject,
    assets: [...inputProject.assets, {
      ...sourceAsset,
      assetId: "asset_imported_video01",
      label: "Imported camera",
      role: "camera",
      source: {
        importedAt: NOW,
        kind: "imported",
        originalName: "camera.mov",
        sourceSha256: HASH,
      },
      streams: [importedStream],
    }],
    placements: [...inputProject.placements, {
      ...sourcePlacement,
      assetId: "asset_imported_video01",
      placementId: "placement_imported01",
      sync: {
        ...sourcePlacement.sync,
        provenance: { kind: "unverified", reason: "initial-placement" },
      },
      video: sourcePlacement.video.map(configured => ({
        ...configured,
        streamId: "stream_imported_video01",
      })),
    }],
  });
}

test("projects project-wide inactivity decisions with immutable analysis provenance", () => {
  const inputProject = project();
  const inputAnalysis = analysis(inputProject);
  const result = projectInactivityDerivations({
    analysis: inputAnalysis,
    decisionIds: ["decision_inactive01", "decision_inactive02"],
    operation: "speed",
    project: inputProject,
  });

  expect(result).toMatchObject({ status: "projected" });
  if (result.status !== "projected") throw new Error("Expected projection.");
  expect(result.derivations.map(derivation => ({
    decisionId: String(derivation.decisionId),
    operation: derivation.operation,
    origin: derivation.origin.kind === "project-analysis" ? {
      analysisId: String(derivation.origin.analysisId),
      inputDigest: derivation.origin.inputDigest,
      kind: derivation.origin.kind,
      projectStructureSha256: derivation.origin.projectStructureSha256,
    } : derivation.origin,
    projectRange: derivation.projectRange,
  }))).toEqual([
    {
      decisionId: "decision_inactive01",
      operation: "speed",
      origin: {
        analysisId: String(inputAnalysis.analysisId),
        inputDigest: HASH,
        kind: "project-analysis",
        projectStructureSha256: inputAnalysis.projectStructureSha256,
      },
      projectRange: { endUs: 4_000_000, startUs: 2_000_000 },
    },
    {
      decisionId: "decision_inactive02",
      operation: "speed",
      origin: {
        analysisId: String(inputAnalysis.analysisId),
        inputDigest: HASH,
        kind: "project-analysis",
        projectStructureSha256: inputAnalysis.projectStructureSha256,
      },
      projectRange: { endUs: 8_000_000, startUs: 6_000_000 },
    },
  ]);
});

test("rejects project-wide inactivity decisions after placement sync changes", () => {
  const inputProject = project();
  const changed = VideoProjectV1Schema.parse({
    ...inputProject,
    placements: inputProject.placements.map(placement => ({
      ...placement,
      sync: {
        ...placement.sync,
        provenance: { kind: "manual", note: "changed provenance" },
      },
    })),
  });
  expect(projectInactivityDerivations({
    analysis: analysis(inputProject),
    decisionIds: ["decision_inactive01", "decision_inactive02"],
    operation: "cut",
    project: changed,
  })).toMatchObject({ reason: "stale-project-structure", status: "rejected" });
});

test("applies synchronized cuts once and records one derivation per recommendation", () => {
  const inputProject = project();
  const result = applyProjectInactivityPlan({
    analysis: analysis(inputProject),
    decisionIds: ["decision_inactive01", "decision_inactive02"],
    operation: "cut",
    plan: createDefaultProjectEditPlan(
      inputProject,
      EditPlanIdSchema.parse("plan_inactive0001"),
      NOW,
    ),
    project: inputProject,
    speedRate: 8,
    updatedAt: "2026-07-22T15:01:00.000Z",
  });

  expect(result.status).toBe("applied");
  if (result.status !== "applied") throw new Error("Expected application.");
  expect(result.plan.keep).toEqual([
    { endUs: 2_000_000, startUs: 0 },
    { endUs: 6_000_000, startUs: 4_000_000 },
    { endUs: 10_000_000, startUs: 8_000_000 },
  ]);
  expect(result.plan.derivations).toHaveLength(2);
  expect(result.plan.derivations.every(item => item.origin.kind === "project-analysis")).toBe(true);
});

test("keeps imported-placement inactivity evidence provisional and rejects structural application", () => {
  const inputProject = withUnverifiedImportedPlacement(project());
  const inputAnalysis = analysis(inputProject);
  const projection = projectInactivityDerivations({
    analysis: inputAnalysis,
    decisionIds: ["decision_inactive01", "decision_inactive02"],
    operation: "cut",
    project: inputProject,
  });
  expect(projection.status).toBe("projected");

  const result = applyProjectInactivityPlan({
    analysis: inputAnalysis,
    decisionIds: ["decision_inactive01", "decision_inactive02"],
    operation: "cut",
    plan: createDefaultProjectEditPlan(
      inputProject,
      EditPlanIdSchema.parse("plan_unverified01"),
      NOW,
    ),
    project: inputProject,
    speedRate: 8,
    updatedAt: "2026-07-22T15:01:00.000Z",
  });
  expect(result).toMatchObject({ reason: "unverified-sync", status: "rejected" });
  if (result.status !== "rejected") throw new Error("Expected unverified sync rejection.");
  expect(result.unverifiedPlacementIds?.map(String)).toEqual(["placement_imported01"]);
});

test("rejects foreign inactivity evidence with unknown fields or out-of-bounds clock mappings", () => {
  const inputProject = project();
  const valid = analysis(inputProject);
  expect(() => ProjectInactivityAnalysisV1Schema.parse({ ...valid, unexpected: true }))
    .toThrow(/unrecognized key/iu);
  expect(() => ProjectInactivityAnalysisV1Schema.parse({
    ...valid,
    displays: [{
      ...valid.displays[0],
      intervals: [{
        ...valid.displays[0]!.intervals[0],
        projectRange: { endUs: 10_000_001, startUs: 2_000_000 },
      }],
    }],
  })).toThrow(/exceeds the project duration/u);
});
