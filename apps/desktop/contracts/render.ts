import { z } from "zod";

import {
  ClickEffectSchema,
  CursorEffectSchema,
  EasingSchema,
  KeystrokeEffectSchema,
  OverlayOperationSchema,
  SourceIntervalSchema,
  TypedTextEffectSchema,
  ZoomIdSchema,
} from "./edit";
import {
  IsoTimestampSchema,
  MicrosecondsSchema,
  PointSchema,
  RecordingIdSchema,
  RectSchema,
  RepositoryRelativePathSchema,
  Sha256Schema,
  TrackIdSchema,
  type ReadonlyInferred,
} from "./recording";

export const FreezeIntervalSchema = z.strictObject({
  confidence: z.number().finite().min(0).max(1),
  meanFrameDifference: z.number().finite().nonnegative(),
  range: SourceIntervalSchema,
});

export const SilenceIntervalSchema = z.strictObject({
  peakDb: z.number().finite(),
  range: SourceIntervalSchema,
});

function rangesAreOrderedAndDisjoint(
  intervals: readonly { readonly range: { readonly startUs: number; readonly endUs: number } }[],
): boolean {
  let priorEndUs = -1;
  for (const { range } of intervals) {
    if (range.startUs < priorEndUs) return false;
    priorEndUs = range.endUs;
  }
  return true;
}

export const AnalyzerEvidenceV1Schema = z.strictObject({
  audio: z.array(z.strictObject({
    intervals: z.array(SilenceIntervalSchema),
    trackId: TrackIdSchema,
  })),
  displays: z.array(z.strictObject({
    intervals: z.array(FreezeIntervalSchema),
    trackId: TrackIdSchema,
  })).min(1),
  kind: z.union([
    z.literal("atet.analyzer-evidence"),
    z.literal("studio.analyzer-evidence"),
  ]),
  schemaVersion: z.literal(1),
  sourceDurationUs: MicrosecondsSchema,
  tool: z.strictObject({
    name: z.string().min(1).max(128),
    version: z.string().min(1).max(128),
  }),
}).superRefine((evidence, context) => {
  const tracks = [...evidence.displays, ...evidence.audio];
  if (new Set(tracks.map(({ trackId }) => trackId)).size !== tracks.length) {
    context.addIssue({ code: "custom", message: "Analyzer evidence track IDs must be unique." });
  }
  for (const track of tracks) {
    if (!rangesAreOrderedAndDisjoint(track.intervals)) {
      context.addIssue({ code: "custom", message: `Analyzer intervals for ${track.trackId} must be sorted and non-overlapping.` });
    }
    if (track.intervals.some(({ range }) => range.endUs > evidence.sourceDurationUs)) {
      context.addIssue({ code: "custom", message: `Analyzer intervals for ${track.trackId} exceed sourceDurationUs.` });
    }
  }
});

export const InactivityPlannerConfigSchema = z.strictObject({
  cursorMovementThresholdPx: z.number().finite().positive(),
  edgeHandleUs: MicrosecondsSchema,
  interactionHandleUs: MicrosecondsSchema,
  minimumFreezeConfidence: z.number().finite().min(0).max(1).optional(),
  minimumCutUs: MicrosecondsSchema,
  requireAudioSilence: z.boolean(),
});

export const OutputIntervalSchema = z.strictObject({
  endUs: MicrosecondsSchema,
  startUs: MicrosecondsSchema,
}).superRefine((interval, context) => {
  if (interval.endUs <= interval.startUs) {
    context.addIssue({ code: "custom", message: "Output interval endUs must be greater than startUs." });
  }
});

export const TimeMapSegmentSchema = z.strictObject({
  output: OutputIntervalSchema,
  source: SourceIntervalSchema,
  speed: z.number().finite().positive().max(64),
});

export const ResolvedSourceSegmentSchema = z.strictObject({
  bytes: z.number().int().safe().positive(),
  codec: z.string().min(1).max(128),
  container: z.string().min(1).max(64),
  containerTrackIdentity: z.discriminatedUnion("kind", [
    z.strictObject({ containerTrackId: z.string().min(1).max(256), kind: z.literal("verified") }),
    z.strictObject({
      diagnosticCode: z.string().min(1).max(128),
      expectedRole: z.enum(["display-video", "camera-video", "system-audio", "microphone-audio"]),
      kind: z.literal("provisional"),
    }),
  ]),
  kind: z.enum(["display-video", "camera-video", "system-audio", "microphone-audio"]),
  output: OutputIntervalSchema,
  path: RepositoryRelativePathSchema,
  source: SourceIntervalSchema,
  sha256: Sha256Schema,
  streamIndex: z.number().int().safe().nonnegative(),
  trackId: TrackIdSchema,
});

export const CameraKeyframeSchema = z.strictObject({
  easing: EasingSchema,
  outputTimeUs: MicrosecondsSchema,
  scale: z.number().finite().min(1).max(10),
  sourceTimeUs: MicrosecondsSchema,
  viewport: RectSchema,
  zoomId: ZoomIdSchema,
});

export const ResolvedOverlaySchema = z.strictObject({
  operation: OverlayOperationSchema,
  output: OutputIntervalSchema,
});

export const RenderCursorSampleSchema = z.strictObject({
  coordinateSpace: z.literal("output-pixels"),
  displayId: z.string().min(1).max(256),
  outputTimeUs: MicrosecondsSchema,
  position: PointSchema,
  sourceTimeUs: MicrosecondsSchema,
  visible: z.boolean(),
});

export const RenderClickCueSchema = z.strictObject({
  button: z.enum(["left", "right", "middle", "other"]),
  clickCount: z.number().int().safe().positive().max(16),
  coordinateSpace: z.literal("output-pixels"),
  displayId: z.string().min(1).max(256),
  outputTimeUs: MicrosecondsSchema,
  phase: z.enum(["down", "up"]),
  position: PointSchema,
  sourceTimeUs: MicrosecondsSchema,
});

export const RenderKeystrokeCueSchema = z.strictObject({
  activity: z.discriminatedUnion("kind", [
    z.strictObject({
      keyCode: z.string().min(1).max(128),
      kind: z.literal("shortcut"),
      modifiers: z.array(z.enum(["command", "control", "option", "shift", "caps-lock", "function"])).min(1),
    }),
    z.strictObject({
      control: z.enum(["arrow-up", "arrow-down", "arrow-left", "arrow-right", "escape", "tab", "enter", "delete"]),
      kind: z.literal("control"),
      modifiers: z.array(z.enum(["command", "control", "option", "shift", "caps-lock", "function"])),
    }),
    z.strictObject({ kind: z.literal("printable"), token: z.literal("[PRINTABLE]") }),
  ]),
  outputTimeUs: MicrosecondsSchema,
  phase: z.enum(["down", "up"]),
  repeat: z.boolean(),
  sourceTimeUs: MicrosecondsSchema,
});

export const RenderTypingSpanSchema = z.discriminatedUnion("secure", [
  z.strictObject({
    endOutputUs: MicrosecondsSchema,
    endSourceUs: MicrosecondsSchema,
    fieldId: z.string().min(1).max(512),
    secure: z.literal(false),
    startOutputUs: MicrosecondsSchema,
    startSourceUs: MicrosecondsSchema,
    updates: z.array(z.strictObject({
      bounds: RectSchema,
      coordinateSpace: z.literal("output-pixels"),
      outputTimeUs: MicrosecondsSchema,
      sourceTimeUs: MicrosecondsSchema,
      text: z.string(),
    })).min(1).max(4096),
    windowId: z.string().min(1).max(256),
  }),
  z.strictObject({
    bounds: RectSchema,
    endOutputUs: MicrosecondsSchema,
    endSourceUs: MicrosecondsSchema,
    fieldId: z.literal("[REDACTED]"),
    secure: z.literal(true),
    startOutputUs: MicrosecondsSchema,
    startSourceUs: MicrosecondsSchema,
    state: z.literal("hidden"),
    windowId: z.string().min(1).max(256),
  }),
]);

export const RenderEffectsSchema = z.strictObject({
  clickCues: z.array(RenderClickCueSchema).max(100_000),
  clicks: ClickEffectSchema,
  cursor: CursorEffectSchema,
  cursorSamples: z.array(RenderCursorSampleSchema).max(100_000),
  keystrokes: KeystrokeEffectSchema,
  keystrokeCues: z.array(RenderKeystrokeCueSchema).max(100_000),
  typedText: TypedTextEffectSchema,
  typingSpans: z.array(RenderTypingSpanSchema).max(100_000),
});

export const Yuv420pDimensionSchema = z.number().int().safe().positive().max(16_384).refine(
  value => value % 2 === 0,
  "YUV 4:2:0 pixel dimensions must be even.",
);

export const RenderPlanV1Schema = z.strictObject({
  cameraKeyframes: z.array(CameraKeyframeSchema),
  effects: RenderEffectsSchema,
  kind: z.union([
    z.literal("atet.render-plan"),
    z.literal("studio.render-plan"),
  ]),
  composition: z.strictObject({
    audioTrackIds: z.array(TrackIdSchema),
    baseDisplay: z.strictObject({
      displayId: z.string().min(1).max(256),
      trackId: TrackIdSchema,
    }),
    camera: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("none") }),
    ]),
    globalToOutput: z.strictObject({
      displayBoundsPoints: RectSchema,
      displayScaleFactor: z.number().finite().positive(),
      outputScaleX: z.number().finite().positive(),
      outputScaleY: z.number().finite().positive(),
      sourceSpace: z.literal("global-display-points"),
      targetSpace: z.literal("output-pixels"),
    }),
  }),
  output: z.strictObject({
    durationUs: MicrosecondsSchema,
    frameRate: z.number().finite().positive().max(240),
    pixelHeight: Yuv420pDimensionSchema,
    pixelWidth: Yuv420pDimensionSchema,
  }).superRefine((output, context) => {
    if (output.pixelWidth * output.pixelHeight > 134_217_728) {
      context.addIssue({ code: "custom", message: "Render output exceeds the 128-megapixel safety limit." });
    }
  }),
  overlays: z.array(ResolvedOverlaySchema),
  planSha256: Sha256Schema,
  recordingId: RecordingIdSchema,
  schemaVersion: z.literal(1),
  sourceSegments: z.array(ResolvedSourceSegmentSchema).max(100_000),
  timeMap: z.array(TimeMapSegmentSchema),
});

export const RenderInvocationSchema = z.strictObject({
  arguments: z.array(z.string()),
  executable: z.literal("ffmpeg"),
  filterGraph: z.strictObject({
    bytes: z.number().int().safe().positive().max(32 * 1024 * 1024),
    path: RepositoryRelativePathSchema,
    sha256: Sha256Schema,
  }),
  outputPath: RepositoryRelativePathSchema,
  renderPlanSha256: Sha256Schema,
});

export const RecordingRenderReceiptV1Schema = z.strictObject({
  createdAt: IsoTimestampSchema,
  display: z.strictObject({
    displayId: z.string().min(1).max(256),
    trackId: TrackIdSchema,
  }),
  kind: z.union([
    z.literal("atet.recording-render-receipt"),
    z.literal("studio.recording-render-receipt"),
  ]),
  output: z.strictObject({
    bytes: z.number().int().safe().positive(),
    path: RepositoryRelativePathSchema,
    sha256: Sha256Schema,
  }),
  plan: z.strictObject({
    path: RepositoryRelativePathSchema,
    sha256: Sha256Schema,
  }),
  recordingId: RecordingIdSchema,
  schemaVersion: z.literal(1),
});

export type AnalyzerEvidenceV1 = ReadonlyInferred<typeof AnalyzerEvidenceV1Schema>;
export type InactivityPlannerConfig = ReadonlyInferred<typeof InactivityPlannerConfigSchema>;
export type TimeMapSegment = ReadonlyInferred<typeof TimeMapSegmentSchema>;
export type ResolvedSourceSegment = ReadonlyInferred<typeof ResolvedSourceSegmentSchema>;
export type RenderCursorSample = ReadonlyInferred<typeof RenderCursorSampleSchema>;
export type RenderClickCue = ReadonlyInferred<typeof RenderClickCueSchema>;
export type RenderKeystrokeCue = ReadonlyInferred<typeof RenderKeystrokeCueSchema>;
export type RenderTypingSpan = ReadonlyInferred<typeof RenderTypingSpanSchema>;
export type RenderEffects = ReadonlyInferred<typeof RenderEffectsSchema>;
export type RenderPlanV1 = ReadonlyInferred<typeof RenderPlanV1Schema>;
export type RenderInvocation = ReadonlyInferred<typeof RenderInvocationSchema>;
export type RecordingRenderReceiptV1 = ReadonlyInferred<typeof RecordingRenderReceiptV1Schema>;

export interface MotionAnalyzer {
  readonly name: string;
  readonly version: string;
  analyze(input: MotionAnalyzerInput): Promise<AnalyzerEvidenceV1>;
}

export interface MotionAnalyzerInput {
  readonly recordingId: z.infer<typeof RecordingIdSchema>;
  readonly sourceDurationUs: number;
  readonly displayTracks: readonly MotionAnalyzerTrackInput[];
  readonly audioTracks: readonly MotionAnalyzerTrackInput[];
}

export interface MotionAnalyzerTrackInput {
  readonly path: string;
  readonly streamIndex: number;
  readonly trackId: z.infer<typeof TrackIdSchema>;
}
