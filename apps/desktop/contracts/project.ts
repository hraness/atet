import { z } from "zod";

import {
  CameraMoveIdSchema,
  CameraPoseSchema,
  ClickEffectSchema,
  EditPlanIdSchema,
  EasingSchema,
  KeystrokeEffectSchema,
  OverlayOperationSchema,
  SourceIntervalSchema,
  SpeedRangeSchema,
  TypedTextEffectSchema,
  CursorEffectSchema,
  ZoomOperationSchema,
} from "./edit";
import {
  IsoTimestampSchema,
  MicrosecondsSchema,
  PositiveMicrosecondsSchema,
  RecordingIdSchema,
  RepositoryRelativePathSchema,
  Sha256Schema,
  TrackIdSchema,
  type ReadonlyInferred,
} from "./recording";

const ID_SUFFIX = /^[a-z0-9][a-z0-9_-]{7,63}$/u;

function projectId(prefix: string) {
  return z.string().refine(
    value => value.startsWith(prefix) && ID_SUFFIX.test(value.slice(prefix.length)),
    `Expected an opaque ${prefix} identifier.`,
  );
}

export const VideoProjectIdSchema = projectId("project_").brand<"VideoProjectId">();
export const ProjectAssetIdSchema = projectId("asset_").brand<"ProjectAssetId">();
export const ProjectStreamIdSchema = projectId("stream_").brand<"ProjectStreamId">();
export const ProjectPlacementIdSchema = projectId("placement_").brand<"ProjectPlacementId">();
export const AnalysisIdSchema = projectId("analysis_").brand<"AnalysisId">();
export const ProjectEditDecisionIdSchema = projectId("decision_").brand<"ProjectEditDecisionId">();

export const ProjectMediaSegmentSchema = z.strictObject({
  assetRange: SourceIntervalSchema,
  bytes: z.number().int().safe().positive(),
  codec: z.string().min(1).max(128),
  container: z.string().min(1).max(64),
  fileRange: SourceIntervalSchema,
  path: RepositoryRelativePathSchema,
  sha256: Sha256Schema,
  streamIndex: z.number().int().safe().nonnegative(),
}).superRefine((segment, context) => {
  if (
    segment.assetRange.endUs - segment.assetRange.startUs
    !== segment.fileRange.endUs - segment.fileRange.startUs
  ) {
    context.addIssue({
      code: "custom",
      message: "Project media segment asset and file ranges must have equal duration.",
    });
  }
});

const StreamBaseShape = {
  label: z.string().min(1).max(512),
  segments: z.array(ProjectMediaSegmentSchema).min(1),
  streamId: ProjectStreamIdSchema,
} as const;

export const ProjectVideoStreamSchema = z.strictObject({
  ...StreamBaseShape,
  frameRate: z.number().finite().positive().max(1_000),
  kind: z.literal("video"),
  pixelHeight: z.number().int().safe().positive().max(16_384),
  pixelWidth: z.number().int().safe().positive().max(16_384),
  role: z.enum(["screen", "camera", "b-roll", "other"]),
}).superRefine((stream, context) => {
  if (stream.pixelWidth * stream.pixelHeight > 134_217_728) {
    context.addIssue({ code: "custom", message: "Project video stream exceeds the 128-megapixel safety limit." });
  }
});

export const ProjectAudioStreamSchema = z.strictObject({
  ...StreamBaseShape,
  channels: z.number().int().safe().positive().max(64),
  kind: z.literal("audio"),
  role: z.enum(["system-audio", "microphone", "portable-audio", "music", "dialogue", "other"]),
  sampleRateHz: z.number().int().safe().positive().max(768_000),
});

export const ProjectMediaStreamSchema = z.discriminatedUnion("kind", [
  ProjectVideoStreamSchema,
  ProjectAudioStreamSchema,
]);

export const ProjectAssetSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("recording"),
    recordingId: RecordingIdSchema,
    trackIds: z.array(TrackIdSchema).min(1),
  }),
  z.strictObject({
    importedAt: IsoTimestampSchema,
    kind: z.literal("imported"),
    originalName: z.string().min(1).max(1_024),
    sourceSha256: Sha256Schema,
  }),
  z.strictObject({
    generator: z.string().min(1).max(256),
    generatorVersion: z.string().min(1).max(128),
    kind: z.literal("generated"),
    sourceSha256: Sha256Schema,
  }),
]);

export const ProjectAssetRoleSchema = z.enum([
  "screen",
  "camera",
  "b-roll",
  "system-audio",
  "microphone",
  "portable-audio",
  "music",
  "dialogue",
  "other",
]);

function segmentsAreOrdered(segments: readonly z.infer<typeof ProjectMediaSegmentSchema>[]): boolean {
  let priorEndUs = -1;
  for (const segment of segments) {
    if (segment.assetRange.startUs < priorEndUs) return false;
    priorEndUs = segment.assetRange.endUs;
  }
  return true;
}

export const ProjectAssetV1Schema = z.strictObject({
  assetId: ProjectAssetIdSchema,
  createdAt: IsoTimestampSchema,
  durationUs: PositiveMicrosecondsSchema,
  label: z.string().min(1).max(512),
  role: ProjectAssetRoleSchema,
  source: ProjectAssetSourceSchema,
  streams: z.array(ProjectMediaStreamSchema).min(1),
}).superRefine((asset, context) => {
  const integrityByPath = new Map<string, { readonly bytes: number; readonly sha256: string }>();
  if (new Set(asset.streams.map(stream => stream.streamId)).size !== asset.streams.length) {
    context.addIssue({ code: "custom", message: "Project stream IDs must be unique within an asset." });
  }
  for (const stream of asset.streams) {
    for (const segment of stream.segments) {
      const prior = integrityByPath.get(segment.path);
      if (prior !== undefined && (prior.bytes !== segment.bytes || prior.sha256 !== segment.sha256)) {
        context.addIssue({
          code: "custom",
          message: `Segments for ${segment.path} must agree on whole-file integrity.`,
        });
      }
      integrityByPath.set(segment.path, { bytes: segment.bytes, sha256: segment.sha256 });
    }
    if (!segmentsAreOrdered(stream.segments)) {
      context.addIssue({
        code: "custom",
        message: `Segments for ${stream.streamId} must be ordered and non-overlapping.`,
      });
    }
    if (stream.segments.some(segment => segment.assetRange.endUs > asset.durationUs)) {
      context.addIssue({
        code: "custom",
        message: `Segments for ${stream.streamId} exceed the asset duration.`,
      });
    }
  }
  const hasVideo = asset.streams.some(stream => stream.kind === "video");
  const hasAudio = asset.streams.some(stream => stream.kind === "audio");
  if ((asset.role === "screen" || asset.role === "camera" || asset.role === "b-roll") && !hasVideo) {
    context.addIssue({ code: "custom", message: `Asset role ${asset.role} requires a video stream.` });
  }
  if (
    (asset.role === "system-audio"
      || asset.role === "microphone"
      || asset.role === "portable-audio"
      || asset.role === "music"
      || asset.role === "dialogue")
    && !hasAudio
  ) {
    context.addIssue({ code: "custom", message: `Asset role ${asset.role} requires an audio stream.` });
  }
});

export const SyncAnchorSchema = z.strictObject({
  assetTimeUs: MicrosecondsSchema,
  projectTimeUs: MicrosecondsSchema,
});

export const SyncProvenanceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("identity") }),
  z.strictObject({
    kind: z.literal("unverified"),
    reason: z.enum(["initial-placement", "insufficient-evidence"]),
  }),
  z.strictObject({
    kind: z.literal("manual"),
    note: z.string().min(1).max(2_048).optional(),
  }),
  z.strictObject({
    analysisId: AnalysisIdSchema,
    confidence: z.number().finite().min(0).max(1),
    kind: z.literal("audio-alignment"),
    maxResidualUs: MicrosecondsSchema,
  }),
]);

export const ProjectSyncMapSchema = z.strictObject({
  anchors: z.array(SyncAnchorSchema).min(2).max(4_096),
  provenance: SyncProvenanceSchema,
}).superRefine((map, context) => {
  for (let index = 1; index < map.anchors.length; index += 1) {
    const prior = map.anchors[index - 1]!;
    const current = map.anchors[index]!;
    if (current.assetTimeUs <= prior.assetTimeUs) {
      context.addIssue({ code: "custom", message: "Sync anchor asset times must increase strictly." });
      return;
    }
    if (current.projectTimeUs <= prior.projectTimeUs) {
      context.addIssue({ code: "custom", message: "Sync anchor project times must increase strictly." });
      return;
    }
  }
});

export const ProjectVideoCropSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({
    bottom: z.number().finite().min(0).max(1),
    kind: z.literal("normalized-insets"),
    left: z.number().finite().min(0).max(1),
    right: z.number().finite().min(0).max(1),
    top: z.number().finite().min(0).max(1),
  }).superRefine((crop, context) => {
    if (crop.left + crop.right >= 1) {
      context.addIssue({ code: "custom", message: "Project video horizontal crop insets must leave visible content." });
    }
    if (crop.top + crop.bottom >= 1) {
      context.addIssue({ code: "custom", message: "Project video vertical crop insets must leave visible content." });
    }
  }),
]);

export const ProjectVideoPresentationSchema = z.discriminatedUnion("enabled", [
  z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({
    blendMode: z.enum(["normal", "multiply", "screen", "overlay", "darken", "lighten"]),
    crop: ProjectVideoCropSchema,
    enabled: z.literal(true),
    fit: z.enum(["contain", "cover", "fill"]),
    layer: z.number().int().safe(),
    layout: z.discriminatedUnion("kind", [
      z.strictObject({
        height: z.number().finite().positive().max(1),
        kind: z.literal("normalized"),
        width: z.number().finite().positive().max(1),
        x: z.number().finite().min(0).max(1),
        y: z.number().finite().min(0).max(1),
      }).superRefine((layout, context) => {
        if (layout.x + layout.width > 1 || layout.y + layout.height > 1) {
          context.addIssue({ code: "custom", message: "Normalized video layout must stay inside the output canvas." });
        }
      }),
      z.strictObject({
        height: z.number().finite().positive().max(16_384),
        kind: z.literal("output-pixels"),
        width: z.number().finite().positive().max(16_384),
        x: z.number().finite().nonnegative().max(16_384),
        y: z.number().finite().nonnegative().max(16_384),
      }).superRefine((layout, context) => {
        if (layout.width * layout.height > 134_217_728) {
          context.addIssue({ code: "custom", message: "Video layout exceeds the 128-megapixel safety limit." });
        }
      }),
    ]),
    opacity: z.number().finite().min(0).max(1),
  }),
]);

export const ProjectAudioPresentationSchema = z.discriminatedUnion("enabled", [
  z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({
    enabled: z.literal(true),
    gainDb: z.number().finite().min(-96).max(24),
    pan: z.number().finite().min(-1).max(1),
  }),
]);

export const ProjectPlacementV1Schema = z.strictObject({
  assetId: ProjectAssetIdSchema,
  assetRange: SourceIntervalSchema,
  audio: z.array(z.strictObject({
    presentation: ProjectAudioPresentationSchema,
    streamId: ProjectStreamIdSchema,
  })),
  enabled: z.boolean(),
  placementId: ProjectPlacementIdSchema,
  sync: ProjectSyncMapSchema,
  video: z.array(z.strictObject({
    presentation: ProjectVideoPresentationSchema,
    streamId: ProjectStreamIdSchema,
  })),
}).superRefine((placement, context) => {
  const first = placement.sync.anchors[0]!;
  const last = placement.sync.anchors.at(-1)!;
  if (
    first.assetTimeUs !== placement.assetRange.startUs
    || last.assetTimeUs !== placement.assetRange.endUs
  ) {
    context.addIssue({
      code: "custom",
      message: "The first and last sync anchors must equal the placement asset range.",
    });
  }
  const streamIds = [...placement.video, ...placement.audio].map(stream => stream.streamId);
  if (new Set(streamIds).size !== streamIds.length) {
    context.addIssue({ code: "custom", message: "A placement may configure each stream at most once." });
  }
});

const AnalysisReferenceBaseShape = {
  analysisId: AnalysisIdSchema,
  createdAt: IsoTimestampSchema,
  path: RepositoryRelativePathSchema,
  sha256: Sha256Schema,
} as const;

export const ProjectAnalysisReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...AnalysisReferenceBaseShape,
    confidence: z.number().finite().min(0).max(1),
    driftPpm: z.number().finite(),
    kind: z.literal("audio-alignment"),
    referencePlacementId: ProjectPlacementIdSchema,
    targetPlacementId: ProjectPlacementIdSchema,
  }),
  z.strictObject({
    ...AnalysisReferenceBaseShape,
    audioStreams: z.number().int().safe().nonnegative(),
    displayStreams: z.number().int().safe().positive(),
    kind: z.literal("inactivity"),
    projectStructureSha256: Sha256Schema,
    recommendedRanges: z.number().int().safe().nonnegative(),
  }),
  z.strictObject({
    ...AnalysisReferenceBaseShape,
    assetId: ProjectAssetIdSchema,
    keyRegions: z.number().int().safe().nonnegative(),
    kind: z.literal("music"),
    musicRegions: z.number().int().safe().nonnegative(),
    streamId: ProjectStreamIdSchema,
    tempoRegions: z.number().int().safe().nonnegative(),
  }),
  z.strictObject({
    ...AnalysisReferenceBaseShape,
    assetId: ProjectAssetIdSchema,
    kind: z.literal("scenes"),
    model: z.string().min(1).max(256),
    sceneCount: z.number().int().safe().nonnegative(),
    streamIds: z.array(ProjectStreamIdSchema).min(1).max(8),
  }),
  z.strictObject({
    ...AnalysisReferenceBaseShape,
    analyzedFrames: z.number().int().safe().nonnegative().max(250_000),
    assetId: ProjectAssetIdSchema,
    kind: z.literal("faces"),
    localOnly: z.literal(true),
    streamId: ProjectStreamIdSchema,
    subjectIntegritySha256: Sha256Schema,
    trackCount: z.number().int().safe().nonnegative().max(100_000),
  }),
  z.strictObject({
    ...AnalysisReferenceBaseShape,
    assetId: ProjectAssetIdSchema,
    fillerCount: z.number().int().safe().nonnegative(),
    kind: z.literal("speech"),
    streamId: ProjectStreamIdSchema,
    wordCount: z.number().int().safe().nonnegative(),
  }),
]);

export const VideoProjectV1Schema = z.strictObject({
  analyses: z.array(ProjectAnalysisReferenceSchema),
  assets: z.array(ProjectAssetV1Schema),
  createdAt: IsoTimestampSchema,
  currentEditPlanPath: RepositoryRelativePathSchema.nullable(),
  kind: z.union([
    z.literal("atet.video-project"),
    z.literal("studio.video-project"),
  ]),
  name: z.string().min(1).max(512),
  placements: z.array(ProjectPlacementV1Schema),
  projectId: VideoProjectIdSchema,
  referencePlacementId: ProjectPlacementIdSchema,
  schemaVersion: z.literal(1),
  timeline: z.strictObject({
    durationUs: PositiveMicrosecondsSchema,
    timebase: z.literal("microseconds"),
  }),
  updatedAt: IsoTimestampSchema,
}).superRefine((project, context) => {
  if (Date.parse(project.updatedAt) < Date.parse(project.createdAt)) {
    context.addIssue({ code: "custom", message: "updatedAt cannot precede createdAt." });
  }
  const assetIds = project.assets.map(asset => asset.assetId);
  const placementIds = project.placements.map(placement => placement.placementId);
  const analysisIds = project.analyses.map(analysis => analysis.analysisId);
  for (const [label, ids] of [
    ["Project asset IDs", assetIds.map(String)],
    ["Project placement IDs", placementIds.map(String)],
    ["Project analysis IDs", analysisIds.map(String)],
  ] as const) {
    if (new Set<string>(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: `${label} must be unique.` });
    }
  }
  const knownPlacements = new Set(placementIds);
  if (!knownPlacements.has(project.referencePlacementId)) {
    context.addIssue({ code: "custom", message: "referencePlacementId must identify a project placement." });
  }
  for (const placement of project.placements) {
    const asset = project.assets.find(candidate => candidate.assetId === placement.assetId);
    if (asset === undefined) {
      context.addIssue({ code: "custom", message: `Placement ${placement.placementId} references an unknown asset.` });
      continue;
    }
    if (placement.assetRange.endUs > asset.durationUs) {
      context.addIssue({ code: "custom", message: `Placement ${placement.placementId} exceeds its asset duration.` });
    }
    if (placement.sync.anchors.some(anchor => anchor.projectTimeUs > project.timeline.durationUs)) {
      context.addIssue({ code: "custom", message: `Placement ${placement.placementId} exceeds the project timeline.` });
    }
    for (const configured of placement.video) {
      const stream = asset.streams.find(candidate => candidate.streamId === configured.streamId);
      if (stream === undefined || stream.kind !== "video") {
        context.addIssue({ code: "custom", message: `Placement ${placement.placementId} configures an unknown video stream.` });
      }
    }
    for (const configured of placement.audio) {
      const stream = asset.streams.find(candidate => candidate.streamId === configured.streamId);
      if (stream === undefined || stream.kind !== "audio") {
        context.addIssue({ code: "custom", message: `Placement ${placement.placementId} configures an unknown audio stream.` });
      }
    }
  }
  for (const analysis of project.analyses) {
    if (analysis.kind === "audio-alignment") {
      if (!knownPlacements.has(analysis.referencePlacementId) || !knownPlacements.has(analysis.targetPlacementId)) {
        context.addIssue({ code: "custom", message: `Alignment ${analysis.analysisId} references an unknown placement.` });
      }
    } else if (analysis.kind !== "inactivity") {
      const asset = project.assets.find(candidate => candidate.assetId === analysis.assetId);
      if (asset === undefined) {
        context.addIssue({ code: "custom", message: `Analysis ${analysis.analysisId} references an unknown asset.` });
        continue;
      }
      const requiredStreamIds = analysis.kind === "scenes" ? analysis.streamIds : [analysis.streamId];
      const requiredKind = analysis.kind === "scenes" || analysis.kind === "faces" ? "video" : "audio";
      if (new Set(requiredStreamIds).size !== requiredStreamIds.length) {
        context.addIssue({ code: "custom", message: `Analysis ${analysis.analysisId} stream IDs must be unique.` });
      }
      for (const streamId of requiredStreamIds) {
        const stream = asset.streams.find(candidate => candidate.streamId === streamId);
        if (stream === undefined || stream.kind !== requiredKind) {
          context.addIssue({
            code: "custom",
            message: `Analysis ${analysis.analysisId} requires a ${requiredKind} stream on its asset.`,
          });
        }
      }
    }
  }
});

export const ProjectZoomOperationSchema = z.strictObject({
  operation: ZoomOperationSchema,
  placementId: ProjectPlacementIdSchema,
});

export const ProjectCameraTransformKeyframeSchema = z.strictObject({
  outgoingEasing: EasingSchema,
  pose: CameraPoseSchema,
  projectTimeUs: MicrosecondsSchema,
});

const FaceTrackReferenceIdSchema = z.string()
  .regex(/^face_[a-z0-9][a-z0-9_-]{7,63}$/u)
  .brand<"FaceTrackReferenceId">();

export const ProjectCameraMoveOriginSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("manual") }),
  z.strictObject({
    analysisId: AnalysisIdSchema,
    analysisSha256: Sha256Schema,
    assetId: ProjectAssetIdSchema,
    assetRange: SourceIntervalSchema,
    kind: z.literal("face-analysis"),
    outputAspectRatio: z.number().finite().positive().max(100).nullable(),
    streamId: ProjectStreamIdSchema,
    subjectIntegritySha256: Sha256Schema,
    trackIds: z.array(FaceTrackReferenceIdSchema).min(1).max(64),
  }).superRefine((origin, context) => {
    if (new Set(origin.trackIds).size !== origin.trackIds.length) {
      context.addIssue({ code: "custom", message: "Face-analysis camera track IDs must be unique." });
    }
  }),
]);

export const ProjectCameraMoveSchema = z.strictObject({
  binding: z.strictObject({
    geometrySha256: Sha256Schema,
    syncSha256: Sha256Schema,
  }),
  cameraMoveId: CameraMoveIdSchema,
  keyframes: z.array(ProjectCameraTransformKeyframeSchema).min(2).max(4_096),
  origin: ProjectCameraMoveOriginSchema,
  placementId: ProjectPlacementIdSchema,
  projectRange: SourceIntervalSchema,
  streamId: ProjectStreamIdSchema,
}).superRefine((move, context) => {
  if (
    move.keyframes[0]?.projectTimeUs !== move.projectRange.startUs
    || move.keyframes.at(-1)?.projectTimeUs !== move.projectRange.endUs
  ) {
    context.addIssue({
      code: "custom",
      message: "Camera move keyframes must exactly match both project range endpoints.",
    });
  }
  for (let index = 1; index < move.keyframes.length; index += 1) {
    if (move.keyframes[index]!.projectTimeUs <= move.keyframes[index - 1]!.projectTimeUs) {
      context.addIssue({
        code: "custom",
        message: "Camera move keyframe project times must increase strictly.",
      });
      break;
    }
  }
  if (move.origin.kind === "face-analysis" && move.origin.streamId !== move.streamId) {
    context.addIssue({
      code: "custom",
      message: "Face-analysis camera provenance must identify the camera move stream.",
    });
  }
});

export const ProjectEditDerivationSchema = z.strictObject({
  decisionId: ProjectEditDecisionIdSchema,
  operation: z.enum(["cut", "speed", "trim"]),
  origin: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("manual") }),
    z.strictObject({
      analysisId: AnalysisIdSchema,
      assetId: ProjectAssetIdSchema,
      assetRange: SourceIntervalSchema,
      kind: z.literal("asset-analysis"),
      placementId: ProjectPlacementIdSchema,
      syncMapSha256: Sha256Schema,
    }),
    z.strictObject({
      analysisId: AnalysisIdSchema,
      inputDigest: Sha256Schema,
      kind: z.literal("project-analysis"),
      projectStructureSha256: Sha256Schema,
    }),
  ]),
  projectRange: SourceIntervalSchema,
});

export const ProjectEditPlanV1Schema = z.strictObject({
  baseSpeed: z.number().finite().positive().max(64),
  cameraMoves: z.array(ProjectCameraMoveSchema).max(4_096),
  createdAt: IsoTimestampSchema,
  effects: z.strictObject({
    clicks: ClickEffectSchema,
    cursor: CursorEffectSchema,
    keystrokes: KeystrokeEffectSchema,
    metadataPlacementId: ProjectPlacementIdSchema.nullable(),
    typedText: TypedTextEffectSchema,
  }),
  derivations: z.array(ProjectEditDerivationSchema),
  keep: z.array(SourceIntervalSchema),
  kind: z.union([
    z.literal("atet.project-edit-plan"),
    z.literal("studio.project-edit-plan"),
  ]),
  overlays: z.array(OverlayOperationSchema),
  planId: EditPlanIdSchema,
  projectId: VideoProjectIdSchema,
  projectStructureSha256: Sha256Schema,
  schemaVersion: z.literal(1),
  speed: z.array(SpeedRangeSchema),
  timelineDurationUs: PositiveMicrosecondsSchema,
  updatedAt: IsoTimestampSchema,
  zooms: z.array(ProjectZoomOperationSchema),
}).superRefine((plan, context) => {
  if (Date.parse(plan.updatedAt) < Date.parse(plan.createdAt)) {
    context.addIssue({ code: "custom", message: "updatedAt cannot precede createdAt." });
  }
  let priorKeepEndUs = -1;
  for (const interval of plan.keep) {
    if (interval.startUs <= priorKeepEndUs) {
      context.addIssue({ code: "custom", message: "Project keep intervals must be sorted, disjoint, and non-adjacent." });
      break;
    }
    priorKeepEndUs = interval.endUs;
    if (interval.endUs > plan.timelineDurationUs) {
      context.addIssue({ code: "custom", message: "Project keep intervals cannot exceed the project timeline." });
    }
  }
  let priorSpeedEndUs = -1;
  for (const speed of plan.speed) {
    if (speed.range.startUs < priorSpeedEndUs) {
      context.addIssue({ code: "custom", message: "Project speed ranges must be sorted and non-overlapping." });
      break;
    }
    priorSpeedEndUs = speed.range.endUs;
    if (!plan.keep.some(keep => keep.startUs <= speed.range.startUs && keep.endUs >= speed.range.endUs)) {
      context.addIssue({ code: "custom", message: "Every project speed range must be contained in one keep interval." });
    }
    if (speed.rate === plan.baseSpeed) {
      context.addIssue({ code: "custom", message: "Project speed ranges equal to baseSpeed are redundant." });
    }
  }
  for (const operation of [
    ...plan.overlays.map(item => ({ range: item.range })),
    ...plan.zooms.map(zoom => ({ range: zoom.operation.range })),
    ...plan.cameraMoves.map(move => ({ range: move.projectRange })),
  ]) {
    if (operation.range.endUs > plan.timelineDurationUs) {
      context.addIssue({ code: "custom", message: "Timed project operations cannot exceed the project timeline." });
    }
    if (!plan.keep.some(keep => keep.startUs < operation.range.endUs && keep.endUs > operation.range.startUs)) {
      context.addIssue({ code: "custom", message: "Timed project operations must overlap kept project time." });
    }
  }
  if (new Set(plan.overlays.map(overlay => overlay.overlayId)).size !== plan.overlays.length) {
    context.addIssue({ code: "custom", message: "Project overlay IDs must be unique." });
  }
  if (new Set(plan.zooms.map(zoom => zoom.operation.zoomId)).size !== plan.zooms.length) {
    context.addIssue({ code: "custom", message: "Project zoom IDs must be unique." });
  }
  if (new Set(plan.cameraMoves.map(move => move.cameraMoveId)).size !== plan.cameraMoves.length) {
    context.addIssue({ code: "custom", message: "Project camera move IDs must be unique." });
  }
  const priorCameraEndByLayer = new Map<string, number>();
  const priorCameraByLayer = new Map<string, ProjectCameraMove>();
  for (const move of [...plan.cameraMoves].sort((left, right) => (
    left.placementId.localeCompare(right.placementId)
    || left.streamId.localeCompare(right.streamId)
    || left.projectRange.startUs - right.projectRange.startUs
    || left.projectRange.endUs - right.projectRange.endUs
  ))) {
    const layer = `${move.placementId}\u0000${move.streamId}`;
    const priorEndUs = priorCameraEndByLayer.get(layer);
    if (priorEndUs !== undefined && move.projectRange.startUs < priorEndUs) {
      context.addIssue({
        code: "custom",
        message: "Project camera moves on the same placement and stream must not overlap.",
      });
      break;
    }
    const priorMove = priorCameraByLayer.get(layer);
    if (
      priorMove !== undefined
      && priorMove.projectRange.endUs === move.projectRange.startUs
    ) {
      const priorPose = priorMove.keyframes.at(-1)!.pose;
      const nextPose = move.keyframes[0]!.pose;
      if (
        priorPose.space !== nextPose.space
        || priorPose.centerX !== nextPose.centerX
        || priorPose.centerY !== nextPose.centerY
        || priorPose.zoom !== nextPose.zoom
      ) {
        context.addIssue({
          code: "custom",
          message: "Adjacent project camera moves on one layer must share their endpoint pose.",
        });
        break;
      }
    }
    priorCameraEndByLayer.set(layer, move.projectRange.endUs);
    priorCameraByLayer.set(layer, move);
  }
  const priorZoomEndByLayer = new Map<string, number>();
  for (const zoom of [...plan.zooms].sort((left, right) => (
    left.placementId.localeCompare(right.placementId)
    || left.operation.displayId.localeCompare(right.operation.displayId)
    || left.operation.range.startUs - right.operation.range.startUs
    || left.operation.range.endUs - right.operation.range.endUs
  ))) {
    const layer = `${zoom.placementId}\u0000${zoom.operation.displayId}`;
    const priorEndUs = priorZoomEndByLayer.get(layer);
    if (priorEndUs !== undefined && zoom.operation.range.startUs < priorEndUs) {
      context.addIssue({
        code: "custom",
        message: "Project zooms on the same placement and display must not overlap.",
      });
      break;
    }
    priorZoomEndByLayer.set(layer, zoom.operation.range.endUs);
  }
  if (new Set(plan.derivations.map(derivation => derivation.decisionId)).size !== plan.derivations.length) {
    context.addIssue({ code: "custom", message: "Project edit decision IDs must be unique." });
  }
  if (plan.derivations.some(derivation => derivation.projectRange.endUs > plan.timelineDurationUs)) {
    context.addIssue({ code: "custom", message: "Project edit derivations cannot exceed the project timeline." });
  }
});

export type VideoProjectId = z.infer<typeof VideoProjectIdSchema>;
export type ProjectAssetId = z.infer<typeof ProjectAssetIdSchema>;
export type ProjectStreamId = z.infer<typeof ProjectStreamIdSchema>;
export type ProjectPlacementId = z.infer<typeof ProjectPlacementIdSchema>;
export type AnalysisId = z.infer<typeof AnalysisIdSchema>;
export type ProjectAssetV1 = ReadonlyInferred<typeof ProjectAssetV1Schema>;
export type ProjectPlacementV1 = ReadonlyInferred<typeof ProjectPlacementV1Schema>;
export type ProjectSyncMap = ReadonlyInferred<typeof ProjectSyncMapSchema>;
export type SyncAnchor = ReadonlyInferred<typeof SyncAnchorSchema>;
export type VideoProjectV1 = ReadonlyInferred<typeof VideoProjectV1Schema>;
export type ProjectCameraMove = ReadonlyInferred<typeof ProjectCameraMoveSchema>;
export type ProjectCameraTransformKeyframe = ReadonlyInferred<typeof ProjectCameraTransformKeyframeSchema>;
export type ProjectZoomOperation = ReadonlyInferred<typeof ProjectZoomOperationSchema>;
export type ProjectEditPlanV1 = ReadonlyInferred<typeof ProjectEditPlanV1Schema>;

export function parseVideoProjectV1(input: unknown): VideoProjectV1 {
  return VideoProjectV1Schema.parse(input);
}

export function parseProjectEditPlanV1(input: unknown): ProjectEditPlanV1 {
  return ProjectEditPlanV1Schema.parse(input);
}
