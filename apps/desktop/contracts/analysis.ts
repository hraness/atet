import { z } from "zod";
import {
  SCENE_UPLOAD_POLICY,
  SceneDescriptionSchema,
} from "@hraness/atet/scene";

import { SourceIntervalSchema } from "./edit";
import {
  AnalysisIdSchema,
  ProjectAssetIdSchema,
  ProjectPlacementIdSchema,
  ProjectStreamIdSchema,
  VideoProjectIdSchema,
} from "./project";
import {
  IsoTimestampSchema,
  MicrosecondsSchema,
  PositiveMicrosecondsSchema,
  RecordingIdSchema,
  RepositoryRelativePathSchema,
  Sha256Schema,
  type ReadonlyInferred,
} from "./recording";

const ANALYSIS_ID_SUFFIX = /^[a-z0-9][a-z0-9_-]{7,63}$/u;

function analysisEntityId(prefix: string) {
  return z.string().refine(
    value => value.startsWith(prefix) && ANALYSIS_ID_SUFFIX.test(value.slice(prefix.length)),
    `Expected an opaque ${prefix} identifier.`,
  );
}

export const AlignmentCandidateIdSchema = analysisEntityId("candidate_").brand<"AlignmentCandidateId">();
export const SceneIdSchema = analysisEntityId("scene_").brand<"SceneId">();
export const SceneSampleIdSchema = analysisEntityId("sample_").brand<"SceneSampleId">();
export const FillerCandidateIdSchema = analysisEntityId("filler_").brand<"FillerCandidateId">();
export const FaceTrackIdSchema = analysisEntityId("face_").brand<"FaceTrackId">();

/**
 * A unit-space rectangle after source orientation has been applied. The origin
 * is the top-left of the displayed frame, x grows right, and y grows down.
 */
export const NormalizedTopLeftRectSchema = z.strictObject({
  height: z.number().finite().positive().max(1),
  width: z.number().finite().positive().max(1),
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
}).superRefine((rect, context) => {
  if (rect.x + rect.width > 1) {
    context.addIssue({ code: "custom", message: "Normalized rectangle exceeds the right frame edge." });
  }
  if (rect.y + rect.height > 1) {
    context.addIssue({ code: "custom", message: "Normalized rectangle exceeds the bottom frame edge." });
  }
});

export const RawFaceDetectionSchema = z.strictObject({
  confidence: z.number().finite().min(0).max(1),
  rect: NormalizedTopLeftRectSchema,
});

export const RawFaceDetectionFrameSchema = z.strictObject({
  assetTimeUs: MicrosecondsSchema,
  detections: z.array(RawFaceDetectionSchema).max(512),
});

export const RawFaceDetectionFramesSchema = z.array(RawFaceDetectionFrameSchema).max(250_000);

export const FaceTrackingConfigSchema = z.strictObject({
  iouWeight: z.number().finite().min(0).max(1),
  maximumCenterDistance: z.number().finite().positive().max(2),
  maximumFacesPerFrame: z.number().int().safe().positive().max(256),
  maximumGapUs: MicrosecondsSchema,
  minimumConfidence: z.number().finite().min(0).max(1),
  minimumIou: z.number().finite().min(0).max(1),
});

export const FaceAnalysisConfigSchema = z.strictObject({
  sampleIntervalUs: PositiveMicrosecondsSchema,
  tracking: FaceTrackingConfigSchema,
}).superRefine((config, context) => {
  if (config.tracking.maximumGapUs < config.sampleIntervalUs) {
    context.addIssue({
      code: "custom",
      message: "Face tracking maximumGapUs must span at least one sample interval.",
      path: ["tracking", "maximumGapUs"],
    });
  }
});

export const FaceAnalysisBackendSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    architecture: z.string().min(1).max(64),
    kind: z.literal("apple-vision"),
    osBuild: z.string().min(1).max(128),
    requestRevision: z.number().int().safe().positive(),
    runtimeVersion: z.string().min(1).max(128),
  }),
  z.strictObject({
    kind: z.literal("local-model"),
    model: z.strictObject({
      name: z.string().min(1).max(256),
      sha256: Sha256Schema,
      version: z.string().min(1).max(128),
    }),
    runtime: z.strictObject({
      name: z.string().min(1).max(128),
      version: z.string().min(1).max(128),
    }),
  }),
]);

export const TrackedFaceDetectionSchema = RawFaceDetectionSchema.extend({
  trackId: FaceTrackIdSchema,
}).strict();

export const FaceAnalysisFrameResultSchema = z.discriminatedUnion("state", [
  z.strictObject({
    assetTimeUs: MicrosecondsSchema,
    detections: z.array(TrackedFaceDetectionSchema).max(256),
    discardedDetections: z.number().int().safe().nonnegative().max(512),
    state: z.literal("analyzed"),
  }).superRefine((frame, context) => {
    const trackIds = frame.detections.map(detection => detection.trackId);
    if (new Set(trackIds).size !== trackIds.length) {
      context.addIssue({ code: "custom", message: "A face track may occur only once in an analyzed frame." });
    }
    if (trackIds.some((trackId, index) => index > 0 && trackId <= trackIds[index - 1]!)) {
      context.addIssue({ code: "custom", message: "Analyzed frame detections must be ordered by track ID." });
    }
  }),
  z.strictObject({
    assetTimeUs: MicrosecondsSchema,
    errorCode: z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/u),
    state: z.literal("failed"),
  }),
]);

export const FaceTrackSchema = z.strictObject({
  firstSeenAssetTimeUs: MicrosecondsSchema,
  lastSeenAssetTimeUs: MicrosecondsSchema,
  maximumObservedGapUs: MicrosecondsSchema,
  observationCount: z.number().int().safe().positive().max(250_000),
  trackId: FaceTrackIdSchema,
}).superRefine((track, context) => {
  if (track.lastSeenAssetTimeUs < track.firstSeenAssetTimeUs) {
    context.addIssue({ code: "custom", message: "Face track last-seen time cannot precede first-seen time." });
  }
  if (track.observationCount === 1 && track.maximumObservedGapUs !== 0) {
    context.addIssue({ code: "custom", message: "A one-observation face track cannot contain an observed gap." });
  }
});

export const AnalysisSubjectSchema = z.strictObject({
  assetId: ProjectAssetIdSchema,
  integritySha256: Sha256Schema,
  streamId: ProjectStreamIdSchema,
});

export const AnalysisToolSchema = z.strictObject({
  name: z.string().min(1).max(128),
  profile: z.string().min(1).max(128),
  version: z.string().min(1).max(128),
});

/**
 * Immutable local face-box evidence. Track IDs describe only geometry
 * continuity between sampled frames; they are not people or biometric
 * identities.
 */
export const FaceAnalysisV1Schema = z.strictObject({
  analysisId: AnalysisIdSchema,
  backend: FaceAnalysisBackendSchema,
  config: FaceAnalysisConfigSchema,
  coordinateSpace: z.strictObject({
    encodedPixelHeight: z.number().int().safe().positive().max(16_384),
    encodedPixelWidth: z.number().int().safe().positive().max(16_384),
    mirroredHorizontally: z.boolean(),
    origin: z.literal("top-left"),
    pixelHeight: z.number().int().safe().positive().max(16_384),
    pixelWidth: z.number().int().safe().positive().max(16_384),
    rotationDegrees: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    sampleAspectRatio: z.strictObject({
      denominator: z.number().int().safe().positive().max(1_000_000),
      numerator: z.number().int().safe().positive().max(1_000_000),
    }),
    units: z.literal("normalized"),
    xAxis: z.literal("right"),
    yAxis: z.literal("down"),
  }).superRefine((coordinateSpace, context) => {
    if (
      coordinateSpace.pixelWidth * coordinateSpace.pixelHeight > 134_217_728
      || coordinateSpace.encodedPixelWidth * coordinateSpace.encodedPixelHeight > 134_217_728
    ) {
      context.addIssue({ code: "custom", message: "Face analysis source exceeds the 128-megapixel safety limit." });
    }
    const swapsAxes = coordinateSpace.rotationDegrees === 90 || coordinateSpace.rotationDegrees === 270;
    const expectedWidth = swapsAxes ? coordinateSpace.encodedPixelHeight : coordinateSpace.encodedPixelWidth;
    const expectedHeight = swapsAxes ? coordinateSpace.encodedPixelWidth : coordinateSpace.encodedPixelHeight;
    if (coordinateSpace.pixelWidth !== expectedWidth || coordinateSpace.pixelHeight !== expectedHeight) {
      context.addIssue({
        code: "custom",
        message: "Oriented face-analysis pixel dimensions must agree with encoded dimensions and rotation.",
      });
    }
  }),
  coverage: z.strictObject({
    analyzedFrames: z.number().int().safe().nonnegative().max(250_000),
    failedFrames: z.number().int().safe().nonnegative().max(250_000),
    range: SourceIntervalSchema,
    requestedFrames: z.number().int().safe().positive().max(250_000),
  }),
  createdAt: IsoTimestampSchema,
  durationUs: PositiveMicrosecondsSchema,
  inputDigest: Sha256Schema,
  kind: z.union([
    z.literal("atet.face-analysis"),
    z.literal("transmute.face-analysis"),
    z.literal("studio.face-analysis"),
  ]),
  privacy: z.strictObject({
    biometricIdentification: z.literal("not-performed"),
    execution: z.literal("local-only"),
    storedEvidence: z.literal("bounding-boxes-only"),
    tracking: z.literal("geometry-continuity-only"),
  }),
  results: z.array(FaceAnalysisFrameResultSchema).min(1).max(250_000),
  schemaVersion: z.literal(1),
  subject: AnalysisSubjectSchema,
  tool: AnalysisToolSchema,
  tracks: z.array(FaceTrackSchema).max(100_000),
}).superRefine((analysis, context) => {
  if (analysis.coverage.range.endUs > analysis.durationUs) {
    context.addIssue({ code: "custom", message: "Face analysis coverage exceeds the subject duration." });
  }
  if (analysis.results.length !== analysis.coverage.requestedFrames) {
    context.addIssue({ code: "custom", message: "Face analysis result count must equal requested coverage frames." });
  }

  const analyzedResults = analysis.results.filter(result => result.state === "analyzed");
  const failedResults = analysis.results.filter(result => result.state === "failed");
  if (
    analyzedResults.length !== analysis.coverage.analyzedFrames
    || failedResults.length !== analysis.coverage.failedFrames
    || analysis.coverage.analyzedFrames + analysis.coverage.failedFrames !== analysis.coverage.requestedFrames
  ) {
    context.addIssue({ code: "custom", message: "Face analysis coverage counts must match frame result states." });
  }

  let priorResultTimeUs = -1;
  const observations = new Map<string, number[]>();
  for (const result of analysis.results) {
    if (result.assetTimeUs <= priorResultTimeUs) {
      context.addIssue({ code: "custom", message: "Face analysis frame results must increase strictly in asset time." });
      break;
    }
    if (
      result.assetTimeUs < analysis.coverage.range.startUs
      || result.assetTimeUs >= analysis.coverage.range.endUs
    ) {
      context.addIssue({ code: "custom", message: "Face analysis frame result falls outside the coverage range." });
    }
    priorResultTimeUs = result.assetTimeUs;
    if (result.state === "failed") continue;
    if (result.detections.length > analysis.config.tracking.maximumFacesPerFrame) {
      context.addIssue({ code: "custom", message: "Face analysis frame exceeds its configured face limit." });
    }
    for (const detection of result.detections) {
      if (detection.confidence < analysis.config.tracking.minimumConfidence) {
        context.addIssue({ code: "custom", message: "Persisted face detection is below the configured confidence floor." });
      }
      const trackObservations = observations.get(detection.trackId) ?? [];
      trackObservations.push(result.assetTimeUs);
      observations.set(detection.trackId, trackObservations);
    }
  }

  const trackIds = analysis.tracks.map(track => track.trackId);
  if (new Set(trackIds).size !== trackIds.length) {
    context.addIssue({ code: "custom", message: "Face analysis track IDs must be unique." });
  }
  if (trackIds.some((trackId, index) => index > 0 && trackId <= trackIds[index - 1]!)) {
    context.addIssue({ code: "custom", message: "Face analysis tracks must be ordered by track ID." });
  }
  if (observations.size !== analysis.tracks.length) {
    context.addIssue({ code: "custom", message: "Face analysis tracks must exactly summarize observed detections." });
  }

  for (const track of analysis.tracks) {
    const times = observations.get(track.trackId);
    if (times === undefined || times.length === 0) {
      context.addIssue({ code: "custom", message: `Face track ${track.trackId} has no observed detections.` });
      continue;
    }
    let maximumObservedGapUs = 0;
    for (let index = 1; index < times.length; index += 1) {
      maximumObservedGapUs = Math.max(maximumObservedGapUs, times[index]! - times[index - 1]!);
    }
    if (
      track.firstSeenAssetTimeUs !== times[0]
      || track.lastSeenAssetTimeUs !== times.at(-1)
      || track.observationCount !== times.length
      || track.maximumObservedGapUs !== maximumObservedGapUs
    ) {
      context.addIssue({ code: "custom", message: `Face track ${track.trackId} summary does not match its detections.` });
    }
    if (maximumObservedGapUs > analysis.config.tracking.maximumGapUs) {
      context.addIssue({ code: "custom", message: `Face track ${track.trackId} exceeds the configured geometry gap.` });
    }
  }
});

const MappedFreezeIntervalSchema = z.strictObject({
  assetRange: SourceIntervalSchema,
  confidence: z.number().finite().min(0).max(1),
  meanFrameDifference: z.number().finite().nonnegative(),
  projectRange: SourceIntervalSchema,
});

const MappedSilenceIntervalSchema = z.strictObject({
  assetRange: SourceIntervalSchema,
  peakDb: z.number().finite(),
  projectRange: SourceIntervalSchema,
});

const ProjectInactivityStreamBaseShape = {
  placementAssetRange: SourceIntervalSchema,
  placementId: ProjectPlacementIdSchema,
  subject: AnalysisSubjectSchema,
  syncMapSha256: Sha256Schema,
} as const;

export const ProjectInactivityDisplayEvidenceSchema = z.strictObject({
  ...ProjectInactivityStreamBaseShape,
  intervals: z.array(MappedFreezeIntervalSchema).max(100_000),
});

export const ProjectInactivityAudioEvidenceSchema = z.strictObject({
  ...ProjectInactivityStreamBaseShape,
  intervals: z.array(MappedSilenceIntervalSchema).max(100_000),
});

export const ProjectInteractionEvidenceSchema = z.strictObject({
  assetRange: SourceIntervalSchema,
  projectRange: SourceIntervalSchema,
  source: z.enum([
    "mouse.click",
    "key.activity",
    "typing.input",
    "focus.changed",
    "cursor.movement",
  ]),
});

export const ProjectInactivityConfigSchema = z.strictObject({
  cursorMovementThresholdPx: z.number().finite().positive(),
  edgeHandleUs: MicrosecondsSchema,
  interactionHandleUs: MicrosecondsSchema,
  minimumCutUs: MicrosecondsSchema,
  minimumFreezeConfidence: z.number().finite().min(0).max(1),
  motionThreshold: z.number().finite().min(0).max(1),
  requireAudioSilence: z.boolean(),
});

/**
 * Immutable project-clock evidence for inactivity decisions. Asset ranges retain
 * analyzer provenance; paired project ranges retain the exact accepted sync map
 * used when the analysis was produced.
 */
export const ProjectInactivityAnalysisV1Schema = z.strictObject({
  analysisId: AnalysisIdSchema,
  audio: z.array(ProjectInactivityAudioEvidenceSchema).max(256),
  config: ProjectInactivityConfigSchema,
  createdAt: IsoTimestampSchema,
  displays: z.array(ProjectInactivityDisplayEvidenceSchema).min(1).max(256),
  durationUs: MicrosecondsSchema,
  inputDigest: Sha256Schema,
  interactions: z.array(ProjectInteractionEvidenceSchema).max(1_000_000),
  kind: z.union([
    z.literal("atet.project-inactivity-analysis"),
    z.literal("transmute.project-inactivity-analysis"),
    z.literal("studio.project-inactivity-analysis"),
  ]),
  projectId: VideoProjectIdSchema,
  projectStructureSha256: Sha256Schema,
  referenceRecording: z.strictObject({
    assetId: ProjectAssetIdSchema,
    placementId: ProjectPlacementIdSchema,
    recordingId: RecordingIdSchema,
    syncMapSha256: Sha256Schema,
  }).nullable(),
  result: z.strictObject({
    candidateCount: z.number().int().safe().nonnegative(),
    protectedInteractionCount: z.number().int().safe().nonnegative(),
    recommendedRanges: z.array(SourceIntervalSchema).max(100_000),
  }),
  schemaVersion: z.literal(1),
  tool: AnalysisToolSchema,
}).superRefine((analysis, context) => {
  const evidence = [...analysis.displays, ...analysis.audio];
  const identities = evidence.map(item => `${item.placementId}:${item.subject.streamId}`);
  if (new Set(identities).size !== identities.length) {
    context.addIssue({ code: "custom", message: "Project inactivity placement-stream evidence must be unique." });
  }
  for (const stream of evidence) {
    let priorAssetEndUs = -1;
    let priorProjectEndUs = -1;
    for (const interval of stream.intervals) {
      if (
        interval.assetRange.startUs < stream.placementAssetRange.startUs
        || interval.assetRange.endUs > stream.placementAssetRange.endUs
      ) {
        context.addIssue({
          code: "custom",
          message: `Inactivity evidence for ${stream.subject.streamId} exceeds its placement asset range.`,
        });
      }
      if (interval.projectRange.endUs > analysis.durationUs) {
        context.addIssue({
          code: "custom",
          message: `Inactivity evidence for ${stream.subject.streamId} exceeds the project duration.`,
        });
      }
      if (
        interval.assetRange.startUs < priorAssetEndUs
        || interval.projectRange.startUs < priorProjectEndUs
      ) {
        context.addIssue({
          code: "custom",
          message: `Inactivity evidence for ${stream.subject.streamId} must be ordered in both clocks.`,
        });
        break;
      }
      priorAssetEndUs = interval.assetRange.endUs;
      priorProjectEndUs = interval.projectRange.endUs;
    }
  }
  let priorInteractionProjectUs = -1;
  for (const interaction of analysis.interactions) {
    if (interaction.projectRange.endUs > analysis.durationUs) {
      context.addIssue({ code: "custom", message: "Interaction evidence exceeds the project duration." });
    }
    if (interaction.projectRange.startUs < priorInteractionProjectUs) {
      context.addIssue({ code: "custom", message: "Interaction evidence must be ordered by project time." });
      break;
    }
    priorInteractionProjectUs = interaction.projectRange.startUs;
  }
  if (!rangesAreOrderedAndDisjoint(analysis.result.recommendedRanges.map(range => ({ range })))) {
    context.addIssue({ code: "custom", message: "Recommended inactivity ranges must be ordered and disjoint." });
  }
  if (analysis.result.recommendedRanges.some(range => range.endUs > analysis.durationUs)) {
    context.addIssue({ code: "custom", message: "Recommended inactivity ranges exceed the project duration." });
  }
  if (!analysis.config.requireAudioSilence && analysis.audio.length !== 0) {
    context.addIssue({ code: "custom", message: "Audio evidence must be empty when silence protection is disabled." });
  }
});

export const AlignmentMatchSchema = z.strictObject({
  ambiguity: z.number().finite().min(0).max(1),
  confidence: z.number().finite().min(0).max(1),
  referenceAssetTimeUs: MicrosecondsSchema,
  targetAssetTimeUs: MicrosecondsSchema,
  windowUs: MicrosecondsSchema,
});

export const AssetClockAnchorSchema = z.strictObject({
  referenceAssetTimeUs: MicrosecondsSchema,
  targetAssetTimeUs: MicrosecondsSchema,
});

export const AlignmentCandidateSchema = z.strictObject({
  ambiguity: z.number().finite().min(0).max(1),
  anchors: z.array(AssetClockAnchorSchema).min(2).max(4_096),
  autoApplicable: z.boolean(),
  candidateId: AlignmentCandidateIdSchema,
  confidence: z.number().finite().min(0).max(1),
  driftPpm: z.number().finite().min(-100_000).max(100_000),
  initialOffsetUs: z.number().int().safe(),
  maxResidualUs: MicrosecondsSchema,
  medianResidualUs: MicrosecondsSchema,
  overlapUs: MicrosecondsSchema,
  peakRatio: z.number().finite().nonnegative(),
}).superRefine((candidate, context) => {
  for (let index = 1; index < candidate.anchors.length; index += 1) {
    const prior = candidate.anchors[index - 1]!;
    const current = candidate.anchors[index]!;
    if (current.targetAssetTimeUs <= prior.targetAssetTimeUs) {
      context.addIssue({ code: "custom", message: "Candidate target anchors must increase strictly." });
      return;
    }
    if (current.referenceAssetTimeUs <= prior.referenceAssetTimeUs) {
      context.addIssue({ code: "custom", message: "Candidate reference anchors must increase strictly." });
      return;
    }
  }
  if (candidate.autoApplicable && (candidate.confidence < 0.8 || candidate.ambiguity > 0.2)) {
    context.addIssue({
      code: "custom",
      message: "Auto-applicable alignment candidates require high confidence and low ambiguity.",
    });
  }
});

export const AudioAlignmentAnalysisV1Schema = z.strictObject({
  analysisId: AnalysisIdSchema,
  config: z.strictObject({
    analysisSampleRateHz: z.number().int().safe().min(8_000).max(96_000),
    maxDriftPpm: z.number().finite().positive().max(100_000),
    minimumOverlapUs: MicrosecondsSchema,
    windowUs: MicrosecondsSchema,
  }),
  createdAt: IsoTimestampSchema,
  inputDigest: Sha256Schema,
  kind: z.union([
    z.literal("atet.audio-alignment-analysis"),
    z.literal("transmute.audio-alignment-analysis"),
    z.literal("studio.audio-alignment-analysis"),
  ]),
  matches: z.array(AlignmentMatchSchema).max(100_000),
  reference: AnalysisSubjectSchema,
  result: z.discriminatedUnion("status", [
    z.strictObject({
      candidates: z.array(AlignmentCandidateSchema).min(1).max(32),
      status: z.literal("matched"),
    }),
    z.strictObject({
      candidates: z.array(AlignmentCandidateSchema).min(2).max(32),
      reason: z.literal("periodic-or-competing-matches"),
      status: z.literal("ambiguous"),
    }),
    z.strictObject({
      diagnostics: z.array(z.string().min(1).max(1_024)).max(64),
      reason: z.enum(["insufficient-overlap", "low-correlation", "silent-input", "unrelated-input"]),
      status: z.literal("no-match"),
    }),
  ]),
  schemaVersion: z.literal(1),
  target: AnalysisSubjectSchema,
  tool: AnalysisToolSchema,
}).superRefine((analysis, context) => {
  if (
    analysis.reference.assetId === analysis.target.assetId
    && analysis.reference.streamId === analysis.target.streamId
  ) {
    context.addIssue({ code: "custom", message: "Alignment subjects must identify different streams." });
  }
  let priorReferenceUs = -1;
  let priorTargetUs = -1;
  for (const match of analysis.matches) {
    if (
      match.referenceAssetTimeUs < priorReferenceUs
      || match.targetAssetTimeUs < priorTargetUs
    ) {
      context.addIssue({ code: "custom", message: "Alignment matches must be ordered in both asset clocks." });
      break;
    }
    priorReferenceUs = match.referenceAssetTimeUs;
    priorTargetUs = match.targetAssetTimeUs;
  }
});

function rangesAreOrderedAndDisjoint(
  values: readonly { readonly range: { readonly startUs: number; readonly endUs: number } }[],
): boolean {
  let priorEndUs = -1;
  for (const value of values) {
    if (value.range.startUs < priorEndUs) return false;
    priorEndUs = value.range.endUs;
  }
  return true;
}

export const MusicPresenceRegionSchema = z.strictObject({
  confidence: z.number().finite().min(0).max(1),
  range: SourceIntervalSchema,
});

export const TempoAlternativeSchema = z.strictObject({
  bpm: z.number().finite().min(20).max(400),
  confidence: z.number().finite().min(0).max(1),
});

export const TempoRegionSchema = z.strictObject({
  alternatives: z.array(TempoAlternativeSchema).max(4),
  beatTimesUs: z.array(MicrosecondsSchema).max(250_000),
  bpm: z.number().finite().min(20).max(400),
  changeFromPrevious: z.strictObject({
    confidence: z.number().finite().min(0).max(1),
    deltaBpm: z.number().finite(),
  }).nullable(),
  confidence: z.number().finite().min(0).max(1),
  meter: z.enum(["2/4", "3/4", "4/4", "6/8", "unknown"]),
  range: SourceIntervalSchema,
}).superRefine((region, context) => {
  let priorBeatUs = -1;
  for (const beatUs of region.beatTimesUs) {
    if (beatUs <= priorBeatUs) {
      context.addIssue({ code: "custom", message: "Beat times must increase strictly." });
      return;
    }
    if (beatUs < region.range.startUs || beatUs >= region.range.endUs) {
      context.addIssue({ code: "custom", message: "Beat times must fall inside their tempo region." });
      return;
    }
    priorBeatUs = beatUs;
  }
});

export const MusicalKeySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unknown") }),
  z.strictObject({
    kind: z.literal("key"),
    mode: z.enum(["major", "minor"]),
    pitchClass: z.number().int().min(0).max(11),
  }),
]);

export const KeyRegionSchema = z.strictObject({
  alternate: z.strictObject({
    confidence: z.number().finite().min(0).max(1),
    key: MusicalKeySchema,
  }).nullable(),
  changeConfidence: z.number().finite().min(0).max(1).nullable(),
  confidence: z.number().finite().min(0).max(1),
  key: MusicalKeySchema,
  range: SourceIntervalSchema,
});

export const MusicAnalysisV1Schema = z.strictObject({
  analysisId: AnalysisIdSchema,
  config: z.strictObject({
    hopSize: z.number().int().safe().positive(),
    minimumMusicUs: MicrosecondsSchema,
    sampleRateHz: z.number().int().safe().min(8_000).max(192_000),
    tempoWindowUs: MicrosecondsSchema,
    windowSize: z.number().int().safe().positive(),
  }),
  createdAt: IsoTimestampSchema,
  durationUs: MicrosecondsSchema,
  inputDigest: Sha256Schema,
  keyRegions: z.array(KeyRegionSchema).max(100_000),
  kind: z.union([
    z.literal("atet.music-analysis"),
    z.literal("transmute.music-analysis"),
    z.literal("studio.music-analysis"),
  ]),
  musicRegions: z.array(MusicPresenceRegionSchema).max(100_000),
  schemaVersion: z.literal(1),
  subject: AnalysisSubjectSchema,
  tempoRegions: z.array(TempoRegionSchema).max(100_000),
  tool: AnalysisToolSchema,
}).superRefine((analysis, context) => {
  for (const [label, regions] of [
    ["Music", analysis.musicRegions],
    ["Tempo", analysis.tempoRegions],
    ["Key", analysis.keyRegions],
  ] as const) {
    if (!rangesAreOrderedAndDisjoint(regions)) {
      context.addIssue({ code: "custom", message: `${label} regions must be ordered and non-overlapping.` });
    }
    if (regions.some(region => region.range.endUs > analysis.durationUs)) {
      context.addIssue({ code: "custom", message: `${label} regions exceed the analyzed duration.` });
    }
  }
  if (analysis.tempoRegions[0]?.changeFromPrevious !== null && analysis.tempoRegions.length > 0) {
    context.addIssue({ code: "custom", message: "The first tempo region cannot be a tempo change." });
  }
  if (analysis.keyRegions[0]?.changeConfidence !== null && analysis.keyRegions.length > 0) {
    context.addIssue({ code: "custom", message: "The first key region cannot be a key change." });
  }
});

export const SceneFrameSampleSchema = z.strictObject({
  actualAssetTimeUs: MicrosecondsSchema,
  bytes: z.number().int().safe().positive().max(20_000_000),
  perceptualHash: z.string().regex(/^[a-f0-9]{16}$/u),
  path: RepositoryRelativePathSchema,
  reasons: z.array(z.enum(["boundary", "middle", "event", "maximum-gap", "motion"])).min(1),
  requestedAssetTimeUs: MicrosecondsSchema,
  sampleId: SceneSampleIdSchema,
  sha256: Sha256Schema,
});

export { SceneDescriptionSchema };

export const DescribedSceneSchema = z.strictObject({
  boundaryConfidence: z.number().finite().min(0).max(1),
  description: SceneDescriptionSchema,
  range: SourceIntervalSchema,
  sampleIds: z.array(SceneSampleIdSchema).min(1).max(12),
  sceneId: SceneIdSchema,
});

export const SceneBatchSchema = z.strictObject({
  batchKey: Sha256Schema,
  errorCode: z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/u).nullable(),
  imageBytes: z.number().int().safe().nonnegative().max(6_000_000),
  imageCount: z.number().int().safe().nonnegative().max(12),
  sceneIds: z.array(SceneIdSchema).min(1).max(4),
  state: z.enum(["planned", "dispatching", "complete", "ambiguous", "failed"]),
}).superRefine((batch, context) => {
  const isFailure = batch.state === "ambiguous" || batch.state === "failed";
  if (isFailure !== (batch.errorCode !== null)) {
    context.addIssue({
      code: "custom",
      message: "Scene batch failure states and error codes must agree.",
      path: ["errorCode"],
    });
  }
  if (new Set(batch.sceneIds).size !== batch.sceneIds.length) {
    context.addIssue({ code: "custom", message: "Scene batch scene IDs must be unique.", path: ["sceneIds"] });
  }
  if ((batch.imageBytes === 0) !== (batch.imageCount === 0)) {
    context.addIssue({
      code: "custom",
      message: "Scene batch image count and byte size must either both be zero or both be positive.",
    });
  }
  if (batch.state !== "planned" && (batch.imageBytes === 0 || batch.imageCount === 0)) {
    context.addIssue({
      code: "custom",
      message: "A dispatched scene batch must identify at least one materialized image.",
    });
  }
});

export const SceneAnalysisV1Schema = z.strictObject({
  analysisId: AnalysisIdSchema,
  batches: z.array(SceneBatchSchema).max(10_000),
  cloudUpload: z.strictObject({
    acknowledgedAt: IsoTimestampSchema,
    policy: z.literal(SCENE_UPLOAD_POLICY),
  }),
  createdAt: IsoTimestampSchema,
  durationUs: MicrosecondsSchema,
  inputDigest: Sha256Schema,
  kind: z.union([
    z.literal("atet.scene-analysis"),
    z.literal("transmute.scene-analysis"),
    z.literal("studio.scene-analysis"),
  ]),
  model: z.strictObject({
    aiSdkVersion: z.string().min(1).max(128),
    gateway: z.literal("vercel-ai-gateway"),
    promptSha256: Sha256Schema,
    promptVersion: z.string().min(1).max(128),
    requestedModel: z.string().min(1).max(256),
    resolvedModel: z.string().min(1).max(256).nullable(),
    samplingVersion: z.string().min(1).max(128),
  }),
  samples: z.array(SceneFrameSampleSchema).max(100_000),
  scenes: z.array(DescribedSceneSchema).max(100_000),
  schemaVersion: z.literal(1),
  subjects: z.array(AnalysisSubjectSchema).min(1).max(8),
  usage: z.strictObject({
    inputTokens: z.number().int().safe().nonnegative(),
    outputTokens: z.number().int().safe().nonnegative(),
    uploadedBytes: z.number().int().safe().nonnegative(),
    uploadedImages: z.number().int().safe().nonnegative(),
  }),
}).superRefine((analysis, context) => {
  if (!rangesAreOrderedAndDisjoint(analysis.scenes)) {
    context.addIssue({ code: "custom", message: "Described scenes must be ordered and non-overlapping." });
  }
  if (analysis.scenes.some(scene => scene.range.endUs > analysis.durationUs)) {
    context.addIssue({ code: "custom", message: "Described scenes exceed the analyzed duration." });
  }
  const samplesById = new Map(analysis.samples.map(sample => [sample.sampleId, sample]));
  if (samplesById.size !== analysis.samples.length) {
    context.addIssue({ code: "custom", message: "Scene sample IDs must be unique." });
  }
  if (new Set(analysis.scenes.map(scene => scene.sceneId)).size !== analysis.scenes.length) {
    context.addIssue({ code: "custom", message: "Scene IDs must be unique." });
  }
  if (new Set(analysis.batches.map(batch => batch.batchKey)).size !== analysis.batches.length) {
    context.addIssue({ code: "custom", message: "Scene batch keys must be unique." });
  }
  const batchedSceneIds = analysis.batches.flatMap(batch => batch.sceneIds);
  if (new Set(batchedSceneIds).size !== batchedSceneIds.length) {
    context.addIssue({ code: "custom", message: "A scene may belong to only one analysis batch." });
  }
  for (const scene of analysis.scenes) {
    for (const sampleId of scene.sampleIds) {
      const sample = samplesById.get(sampleId);
      if (sample === undefined) {
        context.addIssue({ code: "custom", message: `Scene ${scene.sceneId} references an unknown sample.` });
      } else if (
        sample.actualAssetTimeUs < scene.range.startUs
        || sample.actualAssetTimeUs >= scene.range.endUs
      ) {
        context.addIssue({ code: "custom", message: `Scene ${scene.sceneId} has a sample outside its range.` });
      }
    }
  }
});

export const TranscriptWordSchema = z.strictObject({
  confidence: z.number().finite().min(0).max(1),
  range: SourceIntervalSchema,
  speaker: z.string().min(1).max(128).nullable(),
  text: z.string().min(1).max(256),
  wordIndex: z.number().int().safe().nonnegative(),
});

export const SpeechUtteranceSchema = z.strictObject({
  range: SourceIntervalSchema,
  text: z.string().min(1).max(16_384),
  wordEndExclusive: z.number().int().safe().positive(),
  wordStart: z.number().int().safe().nonnegative(),
});

export const FillerCandidateSchema = z.strictObject({
  acousticBoundaryConfidence: z.number().finite().min(0).max(1),
  autoApplicable: z.boolean(),
  candidateId: FillerCandidateIdSchema,
  classification: z.enum(["filled-pause", "phrase-filler", "contextual", "repetition", "false-start"]),
  confidence: z.number().finite().min(0).max(1),
  musicProtected: z.boolean(),
  range: SourceIntervalSchema,
  recommendedCut: SourceIntervalSchema.nullable(),
  text: z.string().min(1).max(1_024),
  wordEndExclusive: z.number().int().safe().positive(),
  wordStart: z.number().int().safe().nonnegative(),
}).superRefine((candidate, context) => {
  if (candidate.wordEndExclusive <= candidate.wordStart) {
    context.addIssue({ code: "custom", message: "Filler word range must be nonempty." });
  }
  if (
    candidate.recommendedCut !== null
    && (
      candidate.recommendedCut.startUs > candidate.range.startUs
      || candidate.recommendedCut.endUs < candidate.range.endUs
    )
  ) {
    context.addIssue({ code: "custom", message: "A recommended filler cut must contain the detected filler range." });
  }
  if (candidate.autoApplicable && (
    candidate.recommendedCut === null
    || candidate.musicProtected
    || candidate.classification === "contextual"
    || candidate.confidence < 0.9
    || candidate.acousticBoundaryConfidence < 0.8
  )) {
    context.addIssue({
      code: "custom",
      message: "Auto-applicable fillers require a safe cut, strong evidence, and no music protection.",
    });
  }
});

export const SpeechAnalysisV1Schema = z.strictObject({
  analysisId: AnalysisIdSchema,
  config: z.strictObject({
    language: z.string().min(1).max(64),
    minimumFillerConfidence: z.number().finite().min(0).max(1),
    speechHandleUs: MicrosecondsSchema,
  }),
  createdAt: IsoTimestampSchema,
  durationUs: MicrosecondsSchema,
  inputDigest: Sha256Schema,
  kind: z.union([
    z.literal("atet.speech-analysis"),
    z.literal("transmute.speech-analysis"),
    z.literal("studio.speech-analysis"),
  ]),
  result: z.discriminatedUnion("status", [
    z.strictObject({
      detectedLanguage: z.string().min(1).max(64),
      fillers: z.array(FillerCandidateSchema).max(100_000),
      status: z.literal("transcribed"),
      utterances: z.array(SpeechUtteranceSchema).max(100_000),
      words: z.array(TranscriptWordSchema).max(1_000_000),
    }),
    z.strictObject({
      detectedLanguage: z.string().min(1).max(64).nullable(),
      reason: z.literal("no-speech"),
      status: z.literal("no-speech"),
    }),
  ]),
  schemaVersion: z.literal(1),
  subject: AnalysisSubjectSchema,
  tool: AnalysisToolSchema,
}).superRefine((analysis, context) => {
  if (analysis.result.status === "no-speech") return;
  const { fillers, utterances, words } = analysis.result;
  if (!rangesAreOrderedAndDisjoint(words)) {
    context.addIssue({ code: "custom", message: "Transcript words must be ordered and non-overlapping." });
  }
  if (words.some((word, index) => word.wordIndex !== index || word.range.endUs > analysis.durationUs)) {
    context.addIssue({ code: "custom", message: "Transcript word indices must be contiguous and ranges bounded." });
  }
  if (!rangesAreOrderedAndDisjoint(fillers)) {
    context.addIssue({ code: "custom", message: "Filler candidates must be ordered and non-overlapping." });
  }
  for (const filler of fillers) {
    if (filler.wordEndExclusive > words.length) {
      context.addIssue({ code: "custom", message: `Filler ${filler.candidateId} exceeds the transcript word range.` });
    }
  }
  for (const utterance of utterances) {
    if (
      utterance.wordEndExclusive <= utterance.wordStart
      || utterance.wordEndExclusive > words.length
      || utterance.range.endUs > analysis.durationUs
    ) {
      context.addIssue({ code: "custom", message: "Speech utterance word and time ranges must be valid." });
    }
  }
});

export type AnalysisSubject = ReadonlyInferred<typeof AnalysisSubjectSchema>;
export type AlignmentCandidate = ReadonlyInferred<typeof AlignmentCandidateSchema>;
export type AudioAlignmentAnalysisV1 = ReadonlyInferred<typeof AudioAlignmentAnalysisV1Schema>;
export type FaceAnalysisConfig = ReadonlyInferred<typeof FaceAnalysisConfigSchema>;
export type FaceAnalysisFrameResult = ReadonlyInferred<typeof FaceAnalysisFrameResultSchema>;
export type FaceAnalysisV1 = ReadonlyInferred<typeof FaceAnalysisV1Schema>;
export type FaceTrack = ReadonlyInferred<typeof FaceTrackSchema>;
export type FaceTrackId = ReadonlyInferred<typeof FaceTrackIdSchema>;
export type FaceTrackingConfig = ReadonlyInferred<typeof FaceTrackingConfigSchema>;
export type NormalizedTopLeftRect = ReadonlyInferred<typeof NormalizedTopLeftRectSchema>;
export type RawFaceDetection = ReadonlyInferred<typeof RawFaceDetectionSchema>;
export type RawFaceDetectionFrame = ReadonlyInferred<typeof RawFaceDetectionFrameSchema>;
export type TrackedFaceDetection = ReadonlyInferred<typeof TrackedFaceDetectionSchema>;
export type ProjectInactivityAnalysisV1 = ReadonlyInferred<typeof ProjectInactivityAnalysisV1Schema>;
export type MusicAnalysisV1 = ReadonlyInferred<typeof MusicAnalysisV1Schema>;
export type SceneAnalysisV1 = ReadonlyInferred<typeof SceneAnalysisV1Schema>;
export type SpeechAnalysisV1 = ReadonlyInferred<typeof SpeechAnalysisV1Schema>;
export type FillerCandidate = ReadonlyInferred<typeof FillerCandidateSchema>;

export function parseAudioAlignmentAnalysisV1(input: unknown): AudioAlignmentAnalysisV1 {
  return AudioAlignmentAnalysisV1Schema.parse(input);
}

export function parseFaceAnalysisV1(input: unknown): FaceAnalysisV1 {
  return FaceAnalysisV1Schema.parse(input);
}

export function parseProjectInactivityAnalysisV1(input: unknown): ProjectInactivityAnalysisV1 {
  return ProjectInactivityAnalysisV1Schema.parse(input);
}

export function parseMusicAnalysisV1(input: unknown): MusicAnalysisV1 {
  return MusicAnalysisV1Schema.parse(input);
}

export function parseSceneAnalysisV1(input: unknown): SceneAnalysisV1 {
  return SceneAnalysisV1Schema.parse(input);
}

export function parseSpeechAnalysisV1(input: unknown): SpeechAnalysisV1 {
  return SpeechAnalysisV1Schema.parse(input);
}
