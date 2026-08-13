import {
  AudioAlignmentAnalysisV1Schema,
  SpeechAnalysisV1Schema,
  type AlignmentCandidate,
  type AudioAlignmentAnalysisV1,
  type SpeechAnalysisV1,
} from "../contracts/analysis";
import { SourceIntervalSchema, type SourceInterval } from "../contracts/edit";
import {
  ProjectEditDerivationSchema,
  ProjectSyncMapSchema,
  type ProjectAssetId,
  type ProjectEditPlanV1,
  type ProjectPlacementV1,
  type ProjectSyncMap,
} from "../contracts/project";
import { hashPlacementSync } from "./project-plan";
import { mapAssetIntervalToProjectSlices } from "./project-time";

type ProjectEditDerivation = ProjectEditPlanV1["derivations"][number];

export type AlignmentApplyRejectionReason =
  | "candidate-not-found"
  | "no-project-overlap"
  | "non-monotone-composition"
  | "stale-reference-sync"
  | "subject-mismatch"
  | "unverified-reference-sync"
  | "unsafe-extrapolation";

export type AlignmentApplyResult =
  | {
      readonly appliedAssetRange: SourceInterval;
      readonly candidateId: AlignmentCandidate["candidateId"];
      readonly clippedAtProjectStart: boolean;
      readonly referenceSyncSha256: string;
      readonly requestedAssetRange: SourceInterval;
      readonly status: "applied";
      readonly sync: ProjectSyncMap;
      readonly targetAssetId: ProjectAssetId;
    }
  | {
      readonly actualReferenceSyncSha256?: string;
      readonly expectedReferenceSyncSha256?: string;
      readonly reason: AlignmentApplyRejectionReason;
      readonly status: "rejected";
    };

export interface ApplyAudioAlignmentInput {
  readonly analysis: AudioAlignmentAnalysisV1;
  readonly candidateId: AlignmentCandidate["candidateId"];
  readonly expectedReferenceSyncSha256: string;
  readonly referencePlacement: ProjectPlacementV1;
  readonly targetAssetId: ProjectAssetId;
  readonly targetAssetRange: SourceInterval;
}

export type FillerCutRejectionReason =
  | "candidate-not-found"
  | "candidate-not-safe"
  | "music-protected"
  | "music-protection-incomplete"
  | "no-recommended-cut"
  | "outside-placement"
  | "stale-placement-sync"
  | "subject-mismatch"
  | "unverified-placement-sync"
  | "unmapped-cut";

export type FillerCutProjectionResult =
  | {
      readonly derivation: ProjectEditDerivation;
      readonly placementSyncSha256: string;
      readonly status: "projected";
    }
  | {
      readonly actualPlacementSyncSha256?: string;
      readonly expectedPlacementSyncSha256?: string;
      readonly reason: FillerCutRejectionReason;
      readonly status: "rejected";
    };

export interface ProjectFillerCutInput {
  readonly candidateId: string;
  readonly decisionId: string;
  readonly expectedPlacementSyncSha256: string;
  readonly placement: ProjectPlacementV1;
  readonly projectMusicProtection: {
    readonly complete: boolean;
    readonly ranges: readonly SourceInterval[];
  };
  readonly speech: SpeechAnalysisV1;
}

interface CandidateClockAnchor {
  readonly referenceUs: number;
  readonly targetUs: number;
}

interface ClockAnchor {
  readonly inputUs: number;
  readonly outputUs: number;
}

function roundedSignedRatio(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new RangeError("Clock-map denominator must be positive.");
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const quotient = absolute / denominator;
  const remainder = absolute % denominator;
  const rounded = quotient + (remainder * 2n >= denominator ? 1n : 0n);
  return negative ? -rounded : rounded;
}

function linearMapUs(
  valueUs: number,
  inputStartUs: number,
  inputEndUs: number,
  outputStartUs: number,
  outputEndUs: number,
): number {
  for (const value of [valueUs, inputStartUs, inputEndUs, outputStartUs, outputEndUs]) {
    if (!Number.isSafeInteger(value)) throw new RangeError("Clock-map values must be safe integers.");
  }
  if (inputEndUs <= inputStartUs || outputEndUs <= outputStartUs) {
    throw new RangeError("Clock-map ranges must increase strictly.");
  }
  if (valueUs === inputStartUs) return outputStartUs;
  if (valueUs === inputEndUs) return outputEndUs;
  const numerator = (BigInt(valueUs) - BigInt(inputStartUs))
    * (BigInt(outputEndUs) - BigInt(outputStartUs));
  const denominator = BigInt(inputEndUs) - BigInt(inputStartUs);
  const mapped = BigInt(outputStartUs) + roundedSignedRatio(numerator, denominator);
  const result = Number(mapped);
  if (!Number.isSafeInteger(result)) throw new RangeError("Clock-map result exceeds safe integer range.");
  return result;
}

function clockSegment(anchors: readonly ClockAnchor[], inputUs: number): readonly [ClockAnchor, ClockAnchor] {
  if (anchors.length < 2) throw new RangeError("Clock maps require two anchors.");
  for (let index = 1; index < anchors.length; index += 1) {
    const left = anchors[index - 1];
    const right = anchors[index];
    if (left !== undefined && right !== undefined && inputUs < right.inputUs) return [left, right];
  }
  return [anchors.at(-2)!, anchors.at(-1)!];
}

function mapClock(anchors: readonly ClockAnchor[], inputUs: number): number {
  const [left, right] = clockSegment(anchors, inputUs);
  return linearMapUs(inputUs, left.inputUs, right.inputUs, left.outputUs, right.outputUs);
}

function candidateAnchors(candidate: AlignmentCandidate): readonly CandidateClockAnchor[] {
  return candidate.anchors.map(anchor => ({
    referenceUs: anchor.referenceAssetTimeUs,
    targetUs: anchor.targetAssetTimeUs,
  }));
}

function targetToReferenceUs(candidate: AlignmentCandidate, targetUs: number): number {
  return mapClock(candidateAnchors(candidate).map(anchor => ({
    inputUs: anchor.targetUs,
    outputUs: anchor.referenceUs,
  })), targetUs);
}

function referenceToTargetUs(candidate: AlignmentCandidate, referenceUs: number): number {
  return mapClock(candidateAnchors(candidate).map(anchor => ({
    inputUs: anchor.referenceUs,
    outputUs: anchor.targetUs,
  })), referenceUs);
}

function referenceToProjectUs(reference: ProjectPlacementV1, referenceUs: number): number {
  return mapClock(reference.sync.anchors.map(anchor => ({
    inputUs: anchor.assetTimeUs,
    outputUs: anchor.projectTimeUs,
  })), referenceUs);
}

function targetToProjectUs(
  candidate: AlignmentCandidate,
  reference: ProjectPlacementV1,
  targetUs: number,
): number {
  return referenceToProjectUs(reference, targetToReferenceUs(candidate, targetUs));
}

function firstNonnegativeProjectTime(
  candidate: AlignmentCandidate,
  reference: ProjectPlacementV1,
  startUs: number,
  endUs: number,
): number | null {
  if (targetToProjectUs(candidate, reference, endUs) <= 0) return null;
  let low = startUs;
  let high = endUs;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (targetToProjectUs(candidate, reference, middle) >= 0) high = middle;
    else low = middle + 1;
  }
  return low;
}

function analysisCandidates(analysis: AudioAlignmentAnalysisV1): readonly AlignmentCandidate[] {
  return analysis.result.status === "no-match" ? [] : analysis.result.candidates;
}

export function applyAudioAlignmentCandidate(input: ApplyAudioAlignmentInput): AlignmentApplyResult {
  const analysis = AudioAlignmentAnalysisV1Schema.parse(input.analysis);
  const requestedAssetRange = SourceIntervalSchema.parse(input.targetAssetRange);
  const actualReferenceSyncSha256 = hashPlacementSync(input.referencePlacement);
  if (actualReferenceSyncSha256 !== input.expectedReferenceSyncSha256) {
    return {
      actualReferenceSyncSha256,
      expectedReferenceSyncSha256: input.expectedReferenceSyncSha256,
      reason: "stale-reference-sync",
      status: "rejected",
    };
  }
  if (input.referencePlacement.sync.provenance.kind === "unverified") {
    return { reason: "unverified-reference-sync", status: "rejected" };
  }
  if (
    analysis.reference.assetId !== input.referencePlacement.assetId
    || analysis.target.assetId !== input.targetAssetId
  ) {
    return { reason: "subject-mismatch", status: "rejected" };
  }
  const candidate = analysisCandidates(analysis)
    .find(item => item.candidateId === input.candidateId);
  if (candidate === undefined) return { reason: "candidate-not-found", status: "rejected" };

  try {
    const requestedStartProjectUs = targetToProjectUs(
      candidate,
      input.referencePlacement,
      requestedAssetRange.startUs,
    );
    const requestedEndProjectUs = targetToProjectUs(
      candidate,
      input.referencePlacement,
      requestedAssetRange.endUs,
    );
    if (requestedEndProjectUs <= requestedStartProjectUs) {
      return { reason: "non-monotone-composition", status: "rejected" };
    }

    const clippedStartUs = requestedStartProjectUs < 0
      ? firstNonnegativeProjectTime(
          candidate,
          input.referencePlacement,
          requestedAssetRange.startUs,
          requestedAssetRange.endUs,
        )
      : requestedAssetRange.startUs;
    if (clippedStartUs === null || clippedStartUs >= requestedAssetRange.endUs) {
      return { reason: "no-project-overlap", status: "rejected" };
    }
    const appliedAssetRange = {
      endUs: requestedAssetRange.endUs,
      startUs: clippedStartUs,
    };

    const targetTimes = new Set<number>([appliedAssetRange.startUs, appliedAssetRange.endUs]);
    for (const anchor of candidate.anchors) {
      if (
        anchor.targetAssetTimeUs > appliedAssetRange.startUs
        && anchor.targetAssetTimeUs < appliedAssetRange.endUs
      ) targetTimes.add(anchor.targetAssetTimeUs);
    }
    for (const anchor of input.referencePlacement.sync.anchors) {
      const targetUs = referenceToTargetUs(candidate, anchor.assetTimeUs);
      if (targetUs > appliedAssetRange.startUs && targetUs < appliedAssetRange.endUs) {
        targetTimes.add(targetUs);
      }
    }

    const mapped = [...targetTimes].sort((left, right) => left - right).map(assetTimeUs => ({
      assetTimeUs,
      projectTimeUs: assetTimeUs === appliedAssetRange.startUs && requestedStartProjectUs < 0
        ? 0
        : targetToProjectUs(candidate, input.referencePlacement, assetTimeUs),
    }));
    const anchors: typeof mapped = [];
    for (const anchor of mapped) {
      const prior = anchors.at(-1);
      if (anchor.projectTimeUs < 0) continue;
      if (prior !== undefined && anchor.projectTimeUs <= prior.projectTimeUs) {
        if (anchor.assetTimeUs === appliedAssetRange.endUs) {
          return { reason: "non-monotone-composition", status: "rejected" };
        }
        continue;
      }
      anchors.push(anchor);
    }
    if (
      anchors.length < 2
      || anchors[0]?.assetTimeUs !== appliedAssetRange.startUs
      || anchors.at(-1)?.assetTimeUs !== appliedAssetRange.endUs
    ) {
      return { reason: "non-monotone-composition", status: "rejected" };
    }

    const sync = ProjectSyncMapSchema.parse({
      anchors,
      provenance: {
        analysisId: analysis.analysisId,
        confidence: candidate.confidence,
        kind: "audio-alignment",
        maxResidualUs: candidate.maxResidualUs,
      },
    });
    return {
      appliedAssetRange,
      candidateId: candidate.candidateId,
      clippedAtProjectStart: appliedAssetRange.startUs !== requestedAssetRange.startUs,
      referenceSyncSha256: actualReferenceSyncSha256,
      requestedAssetRange,
      status: "applied",
      sync,
      targetAssetId: input.targetAssetId,
    };
  } catch (error) {
    if (error instanceof RangeError) return { reason: "unsafe-extrapolation", status: "rejected" };
    throw error;
  }
}

export function projectFillerCut(input: ProjectFillerCutInput): FillerCutProjectionResult {
  const speech = SpeechAnalysisV1Schema.parse(input.speech);
  const actualPlacementSyncSha256 = hashPlacementSync(input.placement);
  if (actualPlacementSyncSha256 !== input.expectedPlacementSyncSha256) {
    return {
      actualPlacementSyncSha256,
      expectedPlacementSyncSha256: input.expectedPlacementSyncSha256,
      reason: "stale-placement-sync",
      status: "rejected",
    };
  }
  if (input.placement.sync.provenance.kind === "unverified") {
    return { reason: "unverified-placement-sync", status: "rejected" };
  }
  if (speech.subject.assetId !== input.placement.assetId) {
    return { reason: "subject-mismatch", status: "rejected" };
  }
  if (speech.result.status !== "transcribed") {
    return { reason: "candidate-not-found", status: "rejected" };
  }
  const candidate = speech.result.fillers.find(item => item.candidateId === input.candidateId);
  if (candidate === undefined) return { reason: "candidate-not-found", status: "rejected" };
  if (candidate.musicProtected) return { reason: "music-protected", status: "rejected" };
  if (!candidate.autoApplicable) return { reason: "candidate-not-safe", status: "rejected" };
  if (candidate.recommendedCut === null) return { reason: "no-recommended-cut", status: "rejected" };
  if (
    candidate.recommendedCut.startUs < input.placement.assetRange.startUs
    || candidate.recommendedCut.endUs > input.placement.assetRange.endUs
  ) {
    return { reason: "outside-placement", status: "rejected" };
  }

  const slices = mapAssetIntervalToProjectSlices(input.placement, candidate.recommendedCut);
  const first = slices[0];
  const last = slices.at(-1);
  if (first === undefined || last === undefined) return { reason: "unmapped-cut", status: "rejected" };
  for (let index = 1; index < slices.length; index += 1) {
    if (slices[index - 1]?.project.endUs !== slices[index]?.project.startUs) {
      return { reason: "unmapped-cut", status: "rejected" };
    }
  }
  if (!input.projectMusicProtection.complete) {
    return { reason: "music-protection-incomplete", status: "rejected" };
  }
  const projectRange = { endUs: last.project.endUs, startUs: first.project.startUs };
  if (input.projectMusicProtection.ranges.some(
    range => range.startUs < projectRange.endUs && range.endUs > projectRange.startUs,
  )) {
    return { reason: "music-protected", status: "rejected" };
  }
  const derivation = ProjectEditDerivationSchema.parse({
    decisionId: input.decisionId,
    operation: "cut",
    origin: {
      analysisId: speech.analysisId,
      assetId: speech.subject.assetId,
      assetRange: candidate.recommendedCut,
      kind: "asset-analysis",
      placementId: input.placement.placementId,
      syncMapSha256: actualPlacementSyncSha256,
    },
    projectRange,
  });
  return {
    derivation,
    placementSyncSha256: actualPlacementSyncSha256,
    status: "projected",
  };
}
