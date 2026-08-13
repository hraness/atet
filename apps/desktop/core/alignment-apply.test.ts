import { describe, expect, test } from "bun:test";

import {
  AudioAlignmentAnalysisV1Schema,
  SpeechAnalysisV1Schema,
  type AudioAlignmentAnalysisV1,
  type SpeechAnalysisV1,
} from "../contracts/analysis";
import {
  ProjectAssetIdSchema,
  ProjectPlacementV1Schema,
  type ProjectPlacementV1,
} from "../contracts/project";
import {
  applyAudioAlignmentCandidate,
  projectFillerCut,
} from "./alignment-apply";
import { hashPlacementSync } from "./project-plan";

const HASH = "0".repeat(64);
const NOW = "2026-07-22T12:00:00.000Z";

function referencePlacement(): ProjectPlacementV1 {
  return ProjectPlacementV1Schema.parse({
    assetId: "asset_reference01",
    assetRange: { endUs: 20_000_000, startUs: 10_000_000 },
    audio: [],
    enabled: true,
    placementId: "placement_reference01",
    sync: {
      anchors: [
        { assetTimeUs: 10_000_000, projectTimeUs: 0 },
        { assetTimeUs: 14_000_000, projectTimeUs: 5_000_000 },
        { assetTimeUs: 20_000_000, projectTimeUs: 10_000_000 },
      ],
      provenance: { kind: "identity" },
    },
    video: [],
  });
}

function alignmentAnalysis(): AudioAlignmentAnalysisV1 {
  return AudioAlignmentAnalysisV1Schema.parse({
    analysisId: "analysis_alignment01",
    config: {
      analysisSampleRateHz: 16_000,
      maxDriftPpm: 10_000,
      minimumOverlapUs: 1_000_000,
      windowUs: 2_000_000,
    },
    createdAt: NOW,
    inputDigest: HASH,
    kind: "studio.audio-alignment-analysis",
    matches: [],
    reference: {
      assetId: "asset_reference01",
      integritySha256: HASH,
      streamId: "stream_reference_audio01",
    },
    result: {
      candidates: [{
        ambiguity: 0,
        anchors: [
          { referenceAssetTimeUs: 10_000_000, targetAssetTimeUs: 2_000_000 },
          { referenceAssetTimeUs: 20_000_000, targetAssetTimeUs: 12_000_000 },
        ],
        autoApplicable: true,
        candidateId: "candidate_alignment01",
        confidence: 0.99,
        driftPpm: 0,
        initialOffsetUs: 8_000_000,
        maxResidualUs: 100,
        medianResidualUs: 50,
        overlapUs: 10_000_000,
        peakRatio: 4,
      }],
      status: "matched",
    },
    schemaVersion: 1,
    target: {
      assetId: "asset_target0001",
      integritySha256: HASH,
      streamId: "stream_target_audio001",
    },
    tool: { name: "test-aligner", profile: "test", version: "1" },
  });
}

describe("alignment candidate application", () => {
  test("composes through reference breakpoints and clips negative project time", () => {
    const reference = referencePlacement();
    const analysis = alignmentAnalysis();
    if (analysis.result.status !== "matched") throw new Error("Invalid fixture.");
    const result = applyAudioAlignmentCandidate({
      analysis,
      candidateId: analysis.result.candidates[0]!.candidateId,
      expectedReferenceSyncSha256: hashPlacementSync(reference),
      referencePlacement: reference,
      targetAssetId: ProjectAssetIdSchema.parse("asset_target0001"),
      targetAssetRange: { endUs: 12_000_000, startUs: 0 },
    });
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.clippedAtProjectStart).toBe(true);
    expect(result.appliedAssetRange).toEqual({ startUs: 2_000_000, endUs: 12_000_000 });
    expect(result.sync.anchors).toEqual([
      { assetTimeUs: 2_000_000, projectTimeUs: 0 },
      { assetTimeUs: 6_000_000, projectTimeUs: 5_000_000 },
      { assetTimeUs: 12_000_000, projectTimeUs: 10_000_000 },
    ]);
    expect(result.sync.provenance).toMatchObject({
      analysisId: "analysis_alignment01",
      kind: "audio-alignment",
    });
  });

  test("returns explicit stale and no-overlap rejections", () => {
    const reference = referencePlacement();
    const analysis = alignmentAnalysis();
    const candidateId = analysis.result.status === "matched"
      ? analysis.result.candidates[0]!.candidateId
      : (() => { throw new Error("fixture"); })();
    expect(applyAudioAlignmentCandidate({
      analysis,
      candidateId,
      expectedReferenceSyncSha256: "f".repeat(64),
      referencePlacement: reference,
      targetAssetId: ProjectAssetIdSchema.parse("asset_target0001"),
      targetAssetRange: { endUs: 12_000_000, startUs: 0 },
    })).toMatchObject({ reason: "stale-reference-sync", status: "rejected" });
    expect(applyAudioAlignmentCandidate({
      analysis,
      candidateId,
      expectedReferenceSyncSha256: hashPlacementSync(reference),
      referencePlacement: reference,
      targetAssetId: ProjectAssetIdSchema.parse("asset_target0001"),
      targetAssetRange: { endUs: 1_000_000, startUs: 0 },
    })).toEqual({ reason: "no-project-overlap", status: "rejected" });
  });

  test("does not derive trusted target synchronization from an unverified reference", () => {
    const reference = ProjectPlacementV1Schema.parse({
      ...referencePlacement(),
      sync: {
        ...referencePlacement().sync,
        provenance: { kind: "unverified", reason: "initial-placement" },
      },
    });
    const analysis = alignmentAnalysis();
    const candidateId = analysis.result.status === "matched"
      ? analysis.result.candidates[0]!.candidateId
      : (() => { throw new Error("fixture"); })();

    expect(applyAudioAlignmentCandidate({
      analysis,
      candidateId,
      expectedReferenceSyncSha256: hashPlacementSync(reference),
      referencePlacement: reference,
      targetAssetId: ProjectAssetIdSchema.parse("asset_target0001"),
      targetAssetRange: { endUs: 12_000_000, startUs: 0 },
    })).toEqual({ reason: "unverified-reference-sync", status: "rejected" });
  });
});

function targetPlacement(): ProjectPlacementV1 {
  return ProjectPlacementV1Schema.parse({
    assetId: "asset_target0001",
    assetRange: { endUs: 12_000_000, startUs: 2_000_000 },
    audio: [],
    enabled: true,
    placementId: "placement_target0001",
    sync: {
      anchors: [
        { assetTimeUs: 2_000_000, projectTimeUs: 0 },
        { assetTimeUs: 6_000_000, projectTimeUs: 5_000_000 },
        { assetTimeUs: 12_000_000, projectTimeUs: 10_000_000 },
      ],
      provenance: { kind: "manual" },
    },
    video: [],
  });
}

function speechAnalysis(
  overrides: Readonly<{ autoApplicable?: boolean; musicProtected?: boolean }> = {},
): SpeechAnalysisV1 {
  const autoApplicable = overrides.autoApplicable ?? true;
  const musicProtected = overrides.musicProtected ?? false;
  return SpeechAnalysisV1Schema.parse({
    analysisId: "analysis_speech001",
    config: { language: "en", minimumFillerConfidence: 0.8, speechHandleUs: 200_000 },
    createdAt: NOW,
    durationUs: 12_000_000,
    inputDigest: HASH,
    kind: "studio.speech-analysis",
    result: {
      detectedLanguage: "en",
      fillers: [{
        acousticBoundaryConfidence: autoApplicable ? 0.95 : 0.5,
        autoApplicable,
        candidateId: "filler_example001",
        classification: "filled-pause",
        confidence: autoApplicable ? 0.99 : 0.7,
        musicProtected,
        range: { endUs: 5_400_000, startUs: 5_000_000 },
        recommendedCut: { endUs: 5_600_000, startUs: 4_800_000 },
        text: "um",
        wordEndExclusive: 1,
        wordStart: 0,
      }],
      status: "transcribed",
      utterances: [],
      words: [{
        confidence: 0.99,
        range: { endUs: 5_400_000, startUs: 5_000_000 },
        speaker: null,
        text: "um",
        wordIndex: 0,
      }],
    },
    schemaVersion: 1,
    subject: {
      assetId: "asset_target0001",
      integritySha256: HASH,
      streamId: "stream_target_audio001",
    },
    tool: { name: "test-speech", profile: "test", version: "1" },
  });
}

describe("filler cut projection", () => {
  test("projects one asset-local recommendation into one global cut derivation", () => {
    const placement = targetPlacement();
    const result = projectFillerCut({
      candidateId: "filler_example001",
      decisionId: "decision_filler001",
      expectedPlacementSyncSha256: hashPlacementSync(placement),
      placement,
      projectMusicProtection: { complete: true, ranges: [] },
      speech: speechAnalysis(),
    });
    expect(result.status).toBe("projected");
    if (result.status !== "projected") return;
    expect(result.derivation).toMatchObject({
      operation: "cut",
      origin: {
        assetRange: { startUs: 4_800_000, endUs: 5_600_000 },
        kind: "asset-analysis",
        syncMapSha256: hashPlacementSync(placement),
      },
      projectRange: { startUs: 3_500_000, endUs: 4_500_000 },
    });
  });

  test("rejects stale, unsafe, and music-protected filler decisions", () => {
    const placement = targetPlacement();
    const base = {
      candidateId: "filler_example001",
      decisionId: "decision_filler001",
      expectedPlacementSyncSha256: hashPlacementSync(placement),
      placement,
      projectMusicProtection: { complete: true, ranges: [] },
    } as const;
    expect(projectFillerCut({
      ...base,
      expectedPlacementSyncSha256: "f".repeat(64),
      speech: speechAnalysis(),
    })).toMatchObject({ reason: "stale-placement-sync", status: "rejected" });
    expect(projectFillerCut({ ...base, speech: speechAnalysis({ autoApplicable: false }) }))
      .toEqual({ reason: "candidate-not-safe", status: "rejected" });
    expect(projectFillerCut({
      ...base,
      speech: speechAnalysis({ autoApplicable: false, musicProtected: true }),
    })).toEqual({ reason: "music-protected", status: "rejected" });
    expect(projectFillerCut({
      ...base,
      projectMusicProtection: { complete: false, ranges: [] },
      speech: speechAnalysis(),
    })).toEqual({ reason: "music-protection-incomplete", status: "rejected" });
    expect(projectFillerCut({
      ...base,
      projectMusicProtection: { complete: true, ranges: [{ endUs: 4_000_000, startUs: 3_900_000 }] },
      speech: speechAnalysis(),
    })).toEqual({ reason: "music-protected", status: "rejected" });
    const unverified = ProjectPlacementV1Schema.parse({
      ...placement,
      sync: {
        ...placement.sync,
        provenance: { kind: "unverified", reason: "initial-placement" },
      },
    });
    expect(projectFillerCut({
      ...base,
      expectedPlacementSyncSha256: hashPlacementSync(unverified),
      placement: unverified,
      speech: speechAnalysis(),
    })).toEqual({ reason: "unverified-placement-sync", status: "rejected" });
  });
});
