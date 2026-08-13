import { expect } from "bun:test";
import { assertProperty, fc } from "../testing/property";

import {
  AudioAlignmentAnalysisV1Schema,
  SpeechAnalysisV1Schema,
} from "../contracts/analysis";
import {
  ProjectAssetIdSchema,
  ProjectPlacementV1Schema,
} from "../contracts/project";
import {
  applyAudioAlignmentCandidate,
  projectFillerCut,
} from "./alignment-apply";
import { hashPlacementSync } from "./project-plan";
import { assetToProjectUs } from "./project-time";

const HASH = "0".repeat(64);
const NOW = "2026-07-22T12:00:00.000Z";

assertProperty(fc.property(
  fc.integer({ min: 1_000_000, max: 20_000_000 }),
  fc.integer({ min: 1_000_000, max: 20_000_000 }),
  fc.integer({ min: 0, max: 2_000_000 }),
  fc.integer({ min: 0, max: 2_000_000 }),
  (referenceDurationUs, projectDurationUs, referenceStartUs, targetStartUs) => {
    const referenceEndUs = referenceStartUs + referenceDurationUs;
    const targetDurationUs = Math.max(1, referenceDurationUs + 1_000);
    const targetEndUs = targetStartUs + targetDurationUs;
    const projectStartUs = 500_000;
    const reference = ProjectPlacementV1Schema.parse({
      assetId: "asset_property_reference",
      assetRange: { endUs: referenceEndUs, startUs: referenceStartUs },
      audio: [],
      enabled: true,
      placementId: "placement_property_reference",
      sync: {
        anchors: [
          { assetTimeUs: referenceStartUs, projectTimeUs: projectStartUs },
          { assetTimeUs: referenceEndUs, projectTimeUs: projectStartUs + projectDurationUs },
        ],
        provenance: { kind: "manual" },
      },
      video: [],
    });
    const analysis = AudioAlignmentAnalysisV1Schema.parse({
      analysisId: "analysis_property_alignment",
      config: {
        analysisSampleRateHz: 16_000,
        maxDriftPpm: 100_000,
        minimumOverlapUs: 1,
        windowUs: 1,
      },
      createdAt: NOW,
      inputDigest: HASH,
      kind: "studio.audio-alignment-analysis",
      matches: [],
      reference: {
        assetId: reference.assetId,
        integritySha256: HASH,
        streamId: "stream_property_reference",
      },
      result: {
        candidates: [{
          ambiguity: 0,
          anchors: [
            { referenceAssetTimeUs: referenceStartUs, targetAssetTimeUs: targetStartUs },
            { referenceAssetTimeUs: referenceEndUs, targetAssetTimeUs: targetEndUs },
          ],
          autoApplicable: true,
          candidateId: "candidate_property_alignment",
          confidence: 0.99,
          driftPpm: 0,
          initialOffsetUs: referenceStartUs - targetStartUs,
          maxResidualUs: 0,
          medianResidualUs: 0,
          overlapUs: Math.min(referenceDurationUs, targetDurationUs),
          peakRatio: 3,
        }],
        status: "matched",
      },
      schemaVersion: 1,
      target: {
        assetId: "asset_property_target",
        integritySha256: HASH,
        streamId: "stream_property_target",
      },
      tool: { name: "property", profile: "property", version: "1" },
    });
    if (analysis.result.status !== "matched") throw new Error("Invalid property fixture.");
    const result = applyAudioAlignmentCandidate({
      analysis,
      candidateId: analysis.result.candidates[0]!.candidateId,
      expectedReferenceSyncSha256: hashPlacementSync(reference),
      referencePlacement: reference,
      targetAssetId: ProjectAssetIdSchema.parse("asset_property_target"),
      targetAssetRange: { endUs: targetEndUs, startUs: targetStartUs },
    });
    expect(result.status).toBe("applied");
    if (result.status !== "applied") return;
    expect(result.sync.anchors[0]).toEqual({
      assetTimeUs: targetStartUs,
      projectTimeUs: projectStartUs,
    });
    expect(result.sync.anchors.at(-1)).toEqual({
      assetTimeUs: targetEndUs,
      projectTimeUs: projectStartUs + projectDurationUs,
    });
    for (let index = 1; index < result.sync.anchors.length; index += 1) {
      expect(result.sync.anchors[index]?.assetTimeUs)
        .toBeGreaterThan(result.sync.anchors[index - 1]?.assetTimeUs ?? -1);
      expect(result.sync.anchors[index]?.projectTimeUs)
        .toBeGreaterThan(result.sync.anchors[index - 1]?.projectTimeUs ?? -1);
    }
    expect(assetToProjectUs(result.sync, targetStartUs)).toBe(projectStartUs);
    expect(assetToProjectUs(result.sync, targetEndUs)).toBe(projectStartUs + projectDurationUs);
  },
));

assertProperty(fc.property(
  fc.integer({ min: 2_000_000, max: 20_000_000 }),
  fc.integer({ min: 1, max: 500_000 }),
  fc.integer({ min: 1, max: 500_000 }),
  fc.integer({ min: 0, max: 1_000_000 }),
  (durationUs, beforeUs, afterUs, startSeed) => {
    const fillerStartUs = 1 + startSeed % Math.max(1, durationUs - 3);
    const fillerEndUs = Math.min(durationUs - 1, fillerStartUs + 1);
    const cutStartUs = Math.max(0, fillerStartUs - beforeUs);
    const cutEndUs = Math.min(durationUs, fillerEndUs + afterUs);
    fc.pre(cutEndUs > cutStartUs);
    const placement = ProjectPlacementV1Schema.parse({
      assetId: "asset_property_speech",
      assetRange: { endUs: durationUs, startUs: 0 },
      audio: [],
      enabled: true,
      placementId: "placement_property_speech",
      sync: {
        anchors: [
          { assetTimeUs: 0, projectTimeUs: 750_000 },
          { assetTimeUs: durationUs, projectTimeUs: durationUs + 750_000 },
        ],
        provenance: { kind: "manual" },
      },
      video: [],
    });
    const speech = SpeechAnalysisV1Schema.parse({
      analysisId: "analysis_property_speech",
      config: { language: "en", minimumFillerConfidence: 0.8, speechHandleUs: 0 },
      createdAt: NOW,
      durationUs,
      inputDigest: HASH,
      kind: "studio.speech-analysis",
      result: {
        detectedLanguage: "en",
        fillers: [{
          acousticBoundaryConfidence: 0.99,
          autoApplicable: true,
          candidateId: "filler_property001",
          classification: "filled-pause",
          confidence: 0.99,
          musicProtected: false,
          range: { endUs: fillerEndUs, startUs: fillerStartUs },
          recommendedCut: { endUs: cutEndUs, startUs: cutStartUs },
          text: "um",
          wordEndExclusive: 1,
          wordStart: 0,
        }],
        status: "transcribed",
        utterances: [],
        words: [{
          confidence: 0.99,
          range: { endUs: fillerEndUs, startUs: fillerStartUs },
          speaker: null,
          text: "um",
          wordIndex: 0,
        }],
      },
      schemaVersion: 1,
      subject: {
        assetId: placement.assetId,
        integritySha256: HASH,
        streamId: "stream_property_speech",
      },
      tool: { name: "property", profile: "property", version: "1" },
    });
    const result = projectFillerCut({
      candidateId: "filler_property001",
      decisionId: "decision_property001",
      expectedPlacementSyncSha256: hashPlacementSync(placement),
      placement,
      projectMusicProtection: { complete: true, ranges: [] },
      speech,
    });
    expect(result.status).toBe("projected");
    if (result.status !== "projected") return;
    expect(result.derivation.projectRange).toEqual({
      endUs: cutEndUs + 750_000,
      startUs: cutStartUs + 750_000,
    });
    expect(result.derivation.origin).toMatchObject({
      assetRange: { endUs: cutEndUs, startUs: cutStartUs },
      syncMapSha256: hashPlacementSync(placement),
    });
  },
));
