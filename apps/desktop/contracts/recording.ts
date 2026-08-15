import { z } from "zod";

export type DeepReadonly<T> =
  T extends bigint | boolean | null | number | string | symbol | undefined
    ? T
    : T extends readonly (infer Item)[]
      ? readonly DeepReadonly<Item>[]
      : T extends object
        ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
        : T;

export type ReadonlyInferred<Schema extends z.ZodType> = DeepReadonly<z.infer<Schema>>;

const OPAQUE_ID_SUFFIX = /^[a-z0-9][a-z0-9_-]{7,63}$/u;

function opaqueId<Prefix extends string>(prefix: Prefix) {
  return z.string().superRefine((value, context) => {
    if (!value.startsWith(prefix) || !OPAQUE_ID_SUFFIX.test(value.slice(prefix.length))) {
      context.addIssue({
        code: "custom",
        message: `Expected an opaque ${prefix} identifier.`,
      });
    }
  });
}

export const RecordingIdSchema = opaqueId("rec_").brand<"RecordingId">();
export const TrackIdSchema = opaqueId("track_").brand<"TrackId">();
export const SegmentIdSchema = opaqueId("segment_").brand<"SegmentId">();
export const EventStreamIdSchema = opaqueId("events_").brand<"EventStreamId">();

export const MicrosecondsSchema = z.number().int().safe().nonnegative();
export const PositiveMicrosecondsSchema = z.number().int().safe().positive();
export const SignedMicrosecondsSchema = z.number().int().safe();
export const SequenceSchema = z.number().int().safe().nonnegative();
export const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const IsoTimestampSchema = z.string().datetime({ offset: true });

export const CAPTURE_SYNC_ONSET_FLOOR_US = 50_000;
export const CAPTURE_SYNC_DRIFT_FLOOR_US = 20_000;
export const CAPTURE_SYNC_DRIFT_PPM = 200;

export interface CaptureSyncPlacementInput {
  readonly clockNativeStartUs: number;
  readonly clockSourceEndUs: number;
  readonly clockSourceStartUs: number;
  readonly fileContainerOriginPtsUs: number;
  readonly fileEndPtsUs: number;
  readonly fileFirstPtsUs: number;
  readonly helperNativeStartUs: number;
}

export interface CaptureSyncPlacement {
  readonly endUs: number;
  readonly fileRangeEndUs: number;
  readonly fileRangeStartUs: number;
  readonly rawEndUs: number;
  readonly rawStartUs: number;
  readonly startUs: number;
}

export function deriveCaptureSyncPlacement(
  input: CaptureSyncPlacementInput,
): CaptureSyncPlacement | null {
  if (
    Object.values(input).some(value => !Number.isSafeInteger(value))
    || input.clockSourceStartUs < 0
    || input.clockSourceEndUs <= input.clockSourceStartUs
  ) {
    return null;
  }
  const fileDurationUs = input.fileEndPtsUs - input.fileFirstPtsUs;
  const rawStartUs = input.clockSourceStartUs
    + input.helperNativeStartUs
    - input.clockNativeStartUs;
  const rawEndUs = rawStartUs + fileDurationUs;
  const startUs = Math.max(input.clockSourceStartUs, rawStartUs);
  const endUs = Math.min(input.clockSourceEndUs, rawEndUs);
  const normalizedFileStartUs = input.fileFirstPtsUs
    - input.fileContainerOriginPtsUs;
  const fileRangeStartUs = normalizedFileStartUs + startUs - rawStartUs;
  const fileRangeEndUs = fileRangeStartUs + endUs - startUs;
  const values = [
    fileDurationUs,
    rawStartUs,
    rawEndUs,
    startUs,
    endUs,
    normalizedFileStartUs,
    fileRangeStartUs,
    fileRangeEndUs,
  ];
  if (
    values.some(value => !Number.isSafeInteger(value))
    || fileDurationUs <= 0
    || startUs < 0
    || endUs <= startUs
    || fileRangeStartUs < 0
    || fileRangeEndUs <= fileRangeStartUs
  ) {
    return null;
  }
  return {
    endUs,
    fileRangeEndUs,
    fileRangeStartUs,
    rawEndUs,
    rawStartUs,
    startUs,
  };
}

export function deriveCaptureSyncSpanToleranceUs(
  tickUs: number,
  maximumSampleDurationUs: number,
): number | null {
  const toleranceUs = Math.max(1, tickUs, maximumSampleDurationUs);
  return Number.isSafeInteger(toleranceUs) && toleranceUs > 0
    ? toleranceUs
    : null;
}

export interface CaptureSyncToleranceInput {
  readonly referenceDurationUs: number;
  readonly referenceEndUncertaintyUs: number;
  readonly referenceFirstUncertaintyUs: number;
  readonly referenceMaximumSampleDurationUs: number;
  readonly subjectEndUncertaintyUs: number;
  readonly subjectFirstUncertaintyUs: number;
  readonly subjectMaximumSampleDurationUs: number;
}

export interface CaptureSyncTolerances {
  readonly durationDriftUs: number;
  readonly onsetSkewUs: number;
}

export function deriveCaptureSyncTolerances(
  input: CaptureSyncToleranceInput,
): CaptureSyncTolerances | null {
  if (
    Object.values(input).some(value => !Number.isSafeInteger(value) || value < 0)
    || input.referenceDurationUs <= 0
    || input.referenceMaximumSampleDurationUs <= 0
    || input.subjectMaximumSampleDurationUs <= 0
  ) {
    return null;
  }
  const maximumSampleDurationUs = Math.max(
    input.subjectMaximumSampleDurationUs,
    input.referenceMaximumSampleDurationUs,
  );
  const onsetSkewUs = Math.max(
    CAPTURE_SYNC_ONSET_FLOOR_US,
    input.subjectFirstUncertaintyUs
      + input.referenceFirstUncertaintyUs
      + maximumSampleDurationUs,
  );
  const ppmToleranceUs = Number(
    (
      BigInt(input.referenceDurationUs) * BigInt(CAPTURE_SYNC_DRIFT_PPM)
      + 999_999n
    ) / 1_000_000n,
  );
  const durationDriftUs = Math.max(
    CAPTURE_SYNC_DRIFT_FLOOR_US,
    ppmToleranceUs,
    input.subjectFirstUncertaintyUs
      + input.subjectEndUncertaintyUs
      + input.referenceFirstUncertaintyUs
      + input.referenceEndUncertaintyUs
      + 2 * maximumSampleDurationUs,
  );
  return Number.isSafeInteger(onsetSkewUs)
    && Number.isSafeInteger(durationDriftUs)
    && onsetSkewUs >= 0
    && durationDriftUs >= 0
    ? { durationDriftUs, onsetSkewUs }
    : null;
}

export function deriveCaptureSyncDurationDriftPpm(
  durationDriftUs: number,
  referenceDurationUs: number,
): number | null {
  if (
    !Number.isSafeInteger(durationDriftUs)
    || !Number.isSafeInteger(referenceDurationUs)
    || referenceDurationUs <= 0
  ) {
    return null;
  }
  const scaledMagnitude = BigInt(Math.abs(durationDriftUs)) * 1_000_000n;
  const denominator = BigInt(referenceDurationUs);
  const quotient = scaledMagnitude / denominator;
  const remainder = scaledMagnitude % denominator;
  const roundsAwayFromZero = durationDriftUs >= 0
    ? remainder * 2n >= denominator
    : remainder * 2n > denominator;
  const magnitude = quotient + (roundsAwayFromZero ? 1n : 0n);
  const result = Number(durationDriftUs < 0 ? -magnitude : magnitude);
  return Number.isSafeInteger(result) ? result : null;
}

export function isSafeRepositoryRelativePath(value: string): boolean {
  if (
    value.length === 0
    || value.length > 1024
    || value.startsWith("/")
    || value.startsWith("\\")
    || /^[a-zA-Z]:/u.test(value)
    || value.includes("\\")
    || value.includes("\0")
    || [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  ) {
    return false;
  }
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

export const RepositoryRelativePathSchema = z.string().refine(
  isSafeRepositoryRelativePath,
  "Use a normalized repository-relative path without empty, dot, or parent segments.",
);

export const PointSchema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
});

export const RectSchema = PointSchema.extend({
  height: z.number().finite().positive(),
  width: z.number().finite().positive(),
}).strict();

export const PixelSizeSchema = z.strictObject({
  height: z.number().int().safe().positive(),
  width: z.number().int().safe().positive(),
});

export const PermissionStateSchema = z.enum([
  "not-determined",
  "authorized",
  "denied",
  "restricted",
  "unavailable",
]);

export const CapturePermissionsSchema = z.strictObject({
  accessibility: PermissionStateSchema,
  camera: PermissionStateSchema,
  inputMonitoring: PermissionStateSchema,
  microphone: PermissionStateSchema,
  screenCapture: PermissionStateSchema,
  systemAudio: PermissionStateSchema,
  windowMetadata: PermissionStateSchema,
});

export const DisplaySourceSchema = z.strictObject({
  bounds: RectSchema,
  displayId: z.string().min(1).max(256),
  isPrimary: z.boolean(),
  label: z.string().min(1).max(512),
  pixelSize: PixelSizeSchema,
  refreshRateHz: z.number().finite().positive(),
  scaleFactor: z.number().finite().positive(),
});

export const CameraSourceSchema = z.strictObject({
  cameraId: z.string().min(1).max(256),
  frameRate: z.number().finite().positive(),
  label: z.string().min(1).max(512),
  pixelSize: PixelSizeSchema,
  position: z.enum(["front", "back", "external", "unspecified"]),
});

export const AudioSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    audioSourceId: z.string().min(1).max(256),
    channels: z.number().int().safe().positive().max(64),
    kind: z.literal("system"),
    label: z.string().min(1).max(512),
    sampleRateHz: z.number().int().safe().positive(),
  }),
  z.strictObject({
    audioSourceId: z.string().min(1).max(256),
    channels: z.number().int().safe().positive().max(64),
    kind: z.literal("microphone"),
    label: z.string().min(1).max(512),
    sampleRateHz: z.number().int().safe().positive(),
  }),
]);

export const SourceInventorySchema = z.strictObject({
  audio: z.array(AudioSourceSchema),
  cameras: z.array(CameraSourceSchema),
  displays: z.array(DisplaySourceSchema),
});

export const MAX_CAPTURE_INTERRUPTION_SEGMENTS = 128;
export const MAX_CAPTURE_INTERRUPTION_SOURCE_ID_BYTES = 256;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

const CaptureInterruptionSourceIdSchema = z.string().min(1).refine(
  value =>
    utf8ByteLength(value) <= MAX_CAPTURE_INTERRUPTION_SOURCE_ID_BYTES
    && !value.includes("\0"),
  `Expected a non-NUL source ID of at most ${MAX_CAPTURE_INTERRUPTION_SOURCE_ID_BYTES} UTF-8 bytes.`,
);

const CaptureInterruptionBaseShape = {
  nativeTimeUs: MicrosecondsSchema,
  recoverable: z.boolean(),
  segmentIndex: z.number().int().safe().nonnegative()
    .max(MAX_CAPTURE_INTERRUPTION_SEGMENTS - 1),
  sourceId: CaptureInterruptionSourceIdSchema.nullable(),
  sourceTimeUs: MicrosecondsSchema,
} as const;

export const CaptureInterruptionSchema = z.discriminatedUnion("source", [
  z.strictObject({
    ...CaptureInterruptionBaseShape,
    code: z.enum([
      "selected-display-disconnected",
      "screen-stream-stopped",
      "screen-recording-failed",
    ]),
    source: z.literal("screen"),
  }),
  z.strictObject({
    ...CaptureInterruptionBaseShape,
    code: z.literal("system-audio-track-missing"),
    source: z.literal("system-audio"),
  }),
  z.strictObject({
    ...CaptureInterruptionBaseShape,
    code: z.enum([
      "camera-device-disconnected",
      "camera-session-interrupted",
      "camera-runtime-error",
      "camera-session-stopped",
      "camera-recording-failed",
    ]),
    source: z.literal("camera"),
  }),
  z.strictObject({
    ...CaptureInterruptionBaseShape,
    code: z.enum([
      "microphone-device-disconnected",
      "microphone-session-interrupted",
      "microphone-runtime-error",
      "microphone-session-stopped",
      "microphone-recording-failed",
    ]),
    source: z.literal("microphone"),
  }),
]);

export const PendingIntegritySchema = z.strictObject({
  state: z.literal("pending"),
});

export const VerifiedIntegritySchema = z.strictObject({
  bytes: z.number().int().safe().nonnegative(),
  sha256: Sha256Schema,
  state: z.literal("verified"),
});

export const FileIntegritySchema = z.discriminatedUnion("state", [
  PendingIntegritySchema,
  VerifiedIntegritySchema,
]);

const LegacyMediaSegmentV1Schema = z.strictObject({
  codec: z.string().min(1).max(128),
  containerTrackIdentity: z.discriminatedUnion("kind", [
    z.strictObject({ containerTrackId: z.string().min(1).max(256), kind: z.literal("verified") }),
    z.strictObject({
      diagnosticCode: z.string().min(1).max(128),
      expectedRole: z.enum(["display-video", "camera-video", "system-audio", "microphone-audio"]),
      kind: z.literal("provisional"),
    }),
  ]),
  container: z.string().min(1).max(64),
  endUs: PositiveMicrosecondsSchema,
  integrity: FileIntegritySchema,
  nativeEndUs: PositiveMicrosecondsSchema,
  nativeStartUs: MicrosecondsSchema,
  path: RepositoryRelativePathSchema,
  segmentId: SegmentIdSchema,
  startUs: MicrosecondsSchema,
  streamIndex: z.number().int().safe().nonnegative(),
}).superRefine((segment, context) => {
  if (segment.endUs <= segment.startUs) {
    context.addIssue({ code: "custom", message: "Segment endUs must be greater than startUs." });
  }
  if (segment.nativeEndUs <= segment.nativeStartUs) {
    context.addIssue({ code: "custom", message: "Segment nativeEndUs must be greater than nativeStartUs." });
  }
});

const MediaFileRangeSchema = z.strictObject({
  endUs: PositiveMicrosecondsSchema,
  startUs: MicrosecondsSchema,
}).superRefine((range, context) => {
  if (range.endUs <= range.startUs) {
    context.addIssue({ code: "custom", message: "Media file range must have positive duration." });
  }
});

const LegacyCaptureTimingSchema = z.strictObject({
  kind: z.literal("legacy-estimate"),
  nativeRange: z.strictObject({
    endUs: PositiveMicrosecondsSchema,
    startUs: MicrosecondsSchema,
  }),
  reason: z.literal("recording-manifest-v1-container-duration"),
}).superRefine((timing, context) => {
  if (timing.nativeRange.endUs <= timing.nativeRange.startUs) {
    context.addIssue({ code: "custom", message: "Legacy native timing range must have positive duration." });
  }
});

export const CaptureSyncMeasurementSchema = z.strictObject({
  captureSegmentIndex: z.number().int().safe().nonnegative().max(127),
  durationDriftPpm: z.number().int().safe(),
  durationDriftUs: SignedMicrosecondsSchema,
  evidence: z.strictObject({
    file: z.strictObject({
      containerOriginPtsUs: SignedMicrosecondsSchema,
      endPtsUs: SignedMicrosecondsSchema,
      firstPtsUs: SignedMicrosecondsSchema,
      spanToleranceUs: PositiveMicrosecondsSchema,
      tickUs: PositiveMicrosecondsSchema,
    }),
    helper: z.strictObject({
      bufferCount: z.number().int().safe().positive(),
      clockAnchors: z.strictObject({
        end: z.strictObject({
          nativeTimeUs: MicrosecondsSchema,
          ptsUs: SignedMicrosecondsSchema,
          uncertaintyUs: MicrosecondsSchema,
        }),
        first: z.strictObject({
          nativeTimeUs: MicrosecondsSchema,
          ptsUs: SignedMicrosecondsSchema,
          uncertaintyUs: MicrosecondsSchema,
        }),
      }),
      containerDurationUs: PositiveMicrosecondsSchema,
      presentation: z.strictObject({
        endPtsUs: SignedMicrosecondsSchema,
        firstPtsUs: SignedMicrosecondsSchema,
        lastPtsUs: SignedMicrosecondsSchema,
        maximumSampleDurationUs: PositiveMicrosecondsSchema,
      }),
      sampleCount: z.number().int().safe().positive(),
    }),
  }),
  kind: z.literal("measured"),
  nativeRange: z.strictObject({
    endUs: PositiveMicrosecondsSchema,
    startUs: MicrosecondsSchema,
  }),
  onsetSkewUs: SignedMicrosecondsSchema,
  policy: z.literal("capture-sync-v1"),
  presentation: z.strictObject({
    endPtsUs: SignedMicrosecondsSchema,
    firstPtsUs: SignedMicrosecondsSchema,
    lastPtsUs: SignedMicrosecondsSchema,
  }),
  referenceTrackId: TrackIdSchema,
  status: z.enum(["within-tolerance", "out-of-tolerance"]),
  tolerance: z.strictObject({
    durationDriftUs: MicrosecondsSchema,
    onsetSkewUs: MicrosecondsSchema,
  }),
}).superRefine((timing, context) => {
  if (timing.nativeRange.endUs <= timing.nativeRange.startUs) {
    context.addIssue({ code: "custom", message: "Measured native timing range must have positive duration." });
  }
  if (timing.presentation.lastPtsUs < timing.presentation.firstPtsUs) {
    context.addIssue({ code: "custom", message: "Measured last PTS cannot precede first PTS." });
  }
  if (timing.presentation.endPtsUs <= timing.presentation.lastPtsUs) {
    context.addIssue({ code: "custom", message: "Measured exclusive-end PTS must follow the last PTS." });
  }
  if (
    timing.evidence.helper.presentation.firstPtsUs !== timing.presentation.firstPtsUs
    || timing.evidence.helper.presentation.lastPtsUs !== timing.presentation.lastPtsUs
    || timing.evidence.helper.presentation.endPtsUs !== timing.presentation.endPtsUs
  ) {
    context.addIssue({ code: "custom", message: "Capture sync summary PTS must match its raw timing evidence." });
  }
  if (
    timing.evidence.helper.clockAnchors.first.nativeTimeUs !== timing.nativeRange.startUs
    || timing.evidence.helper.clockAnchors.end.nativeTimeUs !== timing.nativeRange.endUs
    || timing.evidence.helper.clockAnchors.first.ptsUs !== timing.evidence.helper.presentation.firstPtsUs
    || timing.evidence.helper.clockAnchors.end.ptsUs !== timing.evidence.helper.presentation.endPtsUs
  ) {
    context.addIssue({ code: "custom", message: "Capture sync ranges must match their raw clock anchors." });
  }
  const presentationSpanUs = timing.evidence.helper.presentation.endPtsUs
    - timing.evidence.helper.presentation.firstPtsUs;
  const nativeSpanUs = timing.evidence.helper.clockAnchors.end.nativeTimeUs
    - timing.evidence.helper.clockAnchors.first.nativeTimeUs;
  const clockMappingToleranceUs = timing.evidence.helper.clockAnchors.first.uncertaintyUs
    + timing.evidence.helper.clockAnchors.end.uncertaintyUs
    + 2;
  if (Math.abs(nativeSpanUs - presentationSpanUs) > clockMappingToleranceUs) {
    context.addIssue({ code: "custom", message: "Capture native clock anchors exceed their recorded mapping uncertainty." });
  }
  if (
    timing.evidence.helper.presentation.endPtsUs
      - timing.evidence.helper.presentation.lastPtsUs
    > timing.evidence.helper.presentation.maximumSampleDurationUs
  ) {
    context.addIssue({ code: "custom", message: "Capture sync final sample exceeds its recorded maximum duration." });
  }
  const helperSpanUs = timing.evidence.helper.presentation.endPtsUs
    - timing.evidence.helper.presentation.firstPtsUs;
  const fileSpanUs = timing.evidence.file.endPtsUs - timing.evidence.file.firstPtsUs;
  const expectedSpanToleranceUs = deriveCaptureSyncSpanToleranceUs(
    timing.evidence.file.tickUs,
    timing.evidence.helper.presentation.maximumSampleDurationUs,
  );
  if (fileSpanUs <= 0) {
    context.addIssue({ code: "custom", message: "Finalized file timing evidence must have positive duration." });
  }
  if (
    expectedSpanToleranceUs === null
    || timing.evidence.file.spanToleranceUs !== expectedSpanToleranceUs
  ) {
    context.addIssue({ code: "custom", message: "Finalized file span tolerance must match capture-sync-v1 policy." });
  } else if (Math.abs(fileSpanUs - helperSpanUs) > expectedSpanToleranceUs) {
    context.addIssue({ code: "custom", message: "Finalized file span exceeds its recorded helper tolerance." });
  }
  if (timing.evidence.file.firstPtsUs < timing.evidence.file.containerOriginPtsUs) {
    context.addIssue({ code: "custom", message: "Finalized file PTS cannot precede its container origin." });
  }
  if (timing.evidence.helper.sampleCount < timing.evidence.helper.bufferCount) {
    context.addIssue({ code: "custom", message: "Capture sample count cannot be smaller than buffer count." });
  }
  const outOfTolerance = Math.abs(timing.onsetSkewUs) > timing.tolerance.onsetSkewUs
    || Math.abs(timing.durationDriftUs) > timing.tolerance.durationDriftUs;
  if (outOfTolerance !== (timing.status === "out-of-tolerance")) {
    context.addIssue({ code: "custom", message: "Capture sync status must match its explicit tolerances." });
  }
});

export const MediaSegmentSchema = z.strictObject({
  codec: z.string().min(1).max(128),
  containerTrackIdentity: z.discriminatedUnion("kind", [
    z.strictObject({ containerTrackId: z.string().min(1).max(256), kind: z.literal("verified") }),
    z.strictObject({
      diagnosticCode: z.string().min(1).max(128),
      expectedRole: z.enum(["display-video", "camera-video", "system-audio", "microphone-audio"]),
      kind: z.literal("provisional"),
    }),
  ]),
  container: z.string().min(1).max(64),
  endUs: PositiveMicrosecondsSchema,
  fileRange: MediaFileRangeSchema,
  integrity: FileIntegritySchema,
  path: RepositoryRelativePathSchema,
  segmentId: SegmentIdSchema,
  startUs: MicrosecondsSchema,
  streamIndex: z.number().int().safe().nonnegative(),
  timing: z.discriminatedUnion("kind", [
    LegacyCaptureTimingSchema,
    CaptureSyncMeasurementSchema,
  ]),
}).superRefine((segment, context) => {
  if (segment.endUs <= segment.startUs) {
    context.addIssue({ code: "custom", message: "Segment endUs must be greater than startUs." });
  }
  if (
    segment.endUs - segment.startUs
    !== segment.fileRange.endUs - segment.fileRange.startUs
  ) {
    context.addIssue({ code: "custom", message: "Media source and file ranges must have equal duration." });
  }
});

const TrackBaseSchema = z.strictObject({
  enabled: z.boolean(),
  label: z.string().min(1).max(512),
  segments: z.array(MediaSegmentSchema),
  trackId: TrackIdSchema,
});

export const DisplayVideoTrackSchema = TrackBaseSchema.extend({
  kind: z.literal("display-video"),
  source: z.strictObject({ displayId: z.string().min(1).max(256) }),
}).strict();

export const CameraVideoTrackSchema = TrackBaseSchema.extend({
  kind: z.literal("camera-video"),
  source: z.strictObject({ cameraId: z.string().min(1).max(256) }),
}).strict();

export const SystemAudioTrackSchema = TrackBaseSchema.extend({
  kind: z.literal("system-audio"),
  source: z.strictObject({ audioSourceId: z.string().min(1).max(256) }),
}).strict();

export const MicrophoneAudioTrackSchema = TrackBaseSchema.extend({
  kind: z.literal("microphone-audio"),
  source: z.strictObject({ audioSourceId: z.string().min(1).max(256) }),
}).strict();

export const LogicalTrackSchema = z.discriminatedUnion("kind", [
  DisplayVideoTrackSchema,
  CameraVideoTrackSchema,
  SystemAudioTrackSchema,
  MicrophoneAudioTrackSchema,
]);

export const EventKindSchema = z.enum([
  "cursor.sample",
  "mouse.click",
  "key.activity",
  "typing.input",
  "focus.changed",
  "window.snapshot",
  "window.changed",
  "display.topology",
  "lifecycle.marker",
  "diagnostic.dropped-events",
]);

export const EventStreamReferenceSchema = z.strictObject({
  endUs: MicrosecondsSchema,
  eventKinds: z.array(EventKindSchema).min(1),
  eventStreamId: EventStreamIdSchema,
  integrity: FileIntegritySchema,
  path: RepositoryRelativePathSchema,
  recordCount: z.number().int().safe().nonnegative(),
  startUs: MicrosecondsSchema,
}).superRefine((stream, context) => {
  if (stream.endUs < stream.startUs) {
    context.addIssue({ code: "custom", message: "Event stream endUs cannot precede startUs." });
  }
  if (new Set(stream.eventKinds).size !== stream.eventKinds.length) {
    context.addIssue({ code: "custom", message: "Event stream kinds must be unique." });
  }
});

export const RecordingDiagnosticSchema = z.strictObject({
  code: z.string().min(1).max(128),
  count: z.number().int().safe().positive(),
  firstSourceTimeUs: MicrosecondsSchema.nullable(),
  lastSourceTimeUs: MicrosecondsSchema.nullable(),
  level: z.enum(["info", "warning", "error"]),
  message: z.string().min(1).max(4096),
}).superRefine((diagnostic, context) => {
  if ((diagnostic.firstSourceTimeUs === null) !== (diagnostic.lastSourceTimeUs === null)) {
    context.addIssue({ code: "custom", message: "Diagnostic source-time bounds must both be null or both be present." });
  } else if (
    diagnostic.firstSourceTimeUs !== null
    && diagnostic.lastSourceTimeUs !== null
    && diagnostic.lastSourceTimeUs < diagnostic.firstSourceTimeUs
  ) {
    context.addIssue({ code: "custom", message: "Diagnostic lastSourceTimeUs cannot precede firstSourceTimeUs." });
  }
});

export const RecordingLifecycleStateSchema = z.enum([
  "preparing",
  "recording",
  "paused",
  "stopped",
  "failed",
]);

function addDuplicateIssue(
  values: readonly string[],
  label: string,
  context: z.core.$RefinementCtx<unknown>,
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: `${label} must be unique.` });
  }
}

function validateOrderedSegments(
  track: z.infer<typeof LogicalTrackSchema>,
  context: z.core.$RefinementCtx<unknown>,
): void {
  let priorEnd = -1;
  for (const segment of track.segments) {
    if (segment.startUs < priorEnd) {
      context.addIssue({
        code: "custom",
        message: `Track ${track.trackId} segments must be ordered and non-overlapping.`,
      });
      return;
    }
    priorEnd = segment.endUs;
  }
}

const RecordingManifestBaseShape = {
  capture: z.strictObject({
    cursor: z.enum(["disabled", "metadata"]),
    typedText: z.enum(["disabled", "enabled"]).default("disabled"),
    windowMetadata: z.enum(["disabled", "bounds-only", "titles-and-bounds"]),
  }),
  coordinateSpace: z.strictObject({
    kind: z.literal("global-display-points"),
    origin: z.literal("top-left"),
    xAxis: z.literal("right"),
    yAxis: z.literal("down"),
  }),
  createdAt: IsoTimestampSchema,
  diagnostics: z.array(RecordingDiagnosticSchema),
  eventStreams: z.array(EventStreamReferenceSchema),
  kind: z.union([
    z.literal("atet.recording-bundle"),
    z.literal("transmute.recording-bundle"),
    z.literal("studio.recording-bundle"),
  ]),
  permissions: CapturePermissionsSchema,
  platform: z.strictObject({
    architecture: z.string().min(1).max(128),
    os: z.enum(["macos", "linux", "windows", "unknown"]),
    osVersion: z.string().min(1).max(128),
  }),
  recordingId: RecordingIdSchema,
  sources: SourceInventorySchema,
  state: RecordingLifecycleStateSchema,
  tool: z.strictObject({
    captureVersion: z.string().min(1).max(128),
    name: z.union([z.literal("atet"), z.literal("studio")]),
    version: z.string().min(1).max(128),
  }),
  tracks: z.array(LogicalTrackSchema),
  updatedAt: IsoTimestampSchema,
} as const;

const CaptureNativeClockSegmentSchema = z.strictObject({
  index: z.number().int().safe().nonnegative().max(127),
  nativeRange: z.strictObject({
    endUs: PositiveMicrosecondsSchema,
    startUs: MicrosecondsSchema,
  }),
  sourceRange: z.strictObject({
    endUs: PositiveMicrosecondsSchema,
    startUs: MicrosecondsSchema,
  }),
}).superRefine((segment, context) => {
  const nativeDurationUs = segment.nativeRange.endUs - segment.nativeRange.startUs;
  const sourceDurationUs = segment.sourceRange.endUs - segment.sourceRange.startUs;
  if (nativeDurationUs <= 0 || sourceDurationUs <= 0) {
    context.addIssue({ code: "custom", message: "Capture native-clock ranges must have positive duration." });
  } else if (nativeDurationUs !== sourceDurationUs) {
    context.addIssue({ code: "custom", message: "Capture native and source ranges must have equal duration." });
  }
});

const RecordingTimelineV1Schema = z.strictObject({
  durationUs: MicrosecondsSchema,
  timebase: z.literal("microseconds"),
});

const RecordingTimelineV2Schema = z.strictObject({
  durationUs: MicrosecondsSchema,
  nativeClock: z.strictObject({
    kind: z.literal("mach-continuous-microseconds"),
    segments: z.array(CaptureNativeClockSegmentSchema).max(128),
  }),
  timebase: z.literal("microseconds"),
}).superRefine((timeline, context) => {
  let priorIndex = -1;
  let priorNativeEndUs = -1;
  let priorSourceEndUs = 0;
  for (const segment of timeline.nativeClock.segments) {
    if (segment.index <= priorIndex) {
      context.addIssue({ code: "custom", message: "Capture native-clock segment indices must increase." });
      return;
    }
    if (segment.sourceRange.startUs !== priorSourceEndUs) {
      context.addIssue({ code: "custom", message: "Capture native-clock source ranges must be contiguous across pauses." });
      return;
    }
    if (segment.nativeRange.startUs < priorNativeEndUs) {
      context.addIssue({ code: "custom", message: "Capture native-clock ranges must be ordered and non-overlapping." });
      return;
    }
    priorIndex = segment.index;
    priorNativeEndUs = segment.nativeRange.endUs;
    priorSourceEndUs = segment.sourceRange.endUs;
  }
  if (priorSourceEndUs > timeline.durationUs) {
    context.addIssue({ code: "custom", message: "Capture native-clock ranges exceed the recording timeline." });
  }
});

interface ValidatableRecordingManifest {
  readonly createdAt: string;
  readonly diagnostics: readonly z.infer<typeof RecordingDiagnosticSchema>[];
  readonly eventStreams: readonly z.infer<typeof EventStreamReferenceSchema>[];
  readonly kind: "atet.recording-bundle" | "studio.recording-bundle";
  readonly sources: z.infer<typeof SourceInventorySchema>;
  readonly state: z.infer<typeof RecordingLifecycleStateSchema>;
  readonly timeline: { readonly durationUs: number };
  readonly tool: { readonly name: "atet" | "studio" };
  readonly tracks: readonly z.infer<typeof LogicalTrackSchema>[];
  readonly updatedAt: string;
}

function validateRecordingManifest(
  manifest: ValidatableRecordingManifest,
  context: z.core.$RefinementCtx<unknown>,
): void {
  const canonicalIdentity = manifest.kind === "atet.recording-bundle"
    && manifest.tool.name === "atet";
  const legacyIdentity = manifest.kind === "studio.recording-bundle"
    && manifest.tool.name === "studio";
  if (!canonicalIdentity && !legacyIdentity) {
    context.addIssue({
      code: "custom",
      message: "Recording bundle kind and tool name must use the same product identity.",
    });
  }
  if (Date.parse(manifest.updatedAt) < Date.parse(manifest.createdAt)) {
    context.addIssue({ code: "custom", message: "updatedAt cannot precede createdAt." });
  }

  addDuplicateIssue(manifest.tracks.map(({ trackId }) => trackId), "Track IDs", context);
  addDuplicateIssue(manifest.sources.displays.map(({ displayId }) => displayId), "Display source IDs", context);
  addDuplicateIssue(manifest.sources.cameras.map(({ cameraId }) => cameraId), "Camera source IDs", context);
  addDuplicateIssue(manifest.sources.audio.map(({ audioSourceId }) => audioSourceId), "Audio source IDs", context);
  addDuplicateIssue(
    manifest.tracks.flatMap(({ segments }) => segments.map(({ segmentId }) => segmentId)),
    "Segment IDs",
    context,
  );
  addDuplicateIssue(
    manifest.tracks.flatMap(({ segments }) => segments.map(({ path, streamIndex }) => `${path}\0${streamIndex}`)),
    "Segment path and stream-index pairs",
    context,
  );
  addDuplicateIssue(
    manifest.eventStreams.map(({ eventStreamId }) => eventStreamId),
    "Event stream IDs",
    context,
  );
  addDuplicateIssue(
    manifest.eventStreams.map(({ path }) => path),
    "Event stream paths",
    context,
  );

  const displayIds = new Set(manifest.sources.displays.map(({ displayId }) => displayId));
  const cameraIds = new Set(manifest.sources.cameras.map(({ cameraId }) => cameraId));
  const systemAudioIds = new Set(
    manifest.sources.audio.filter(({ kind }) => kind === "system").map(({ audioSourceId }) => audioSourceId),
  );
  const microphoneIds = new Set(
    manifest.sources.audio.filter(({ kind }) => kind === "microphone").map(({ audioSourceId }) => audioSourceId),
  );

  if (
    manifest.sources.displays.length > 0
    && manifest.sources.displays.filter(({ isPrimary }) => isPrimary).length !== 1
  ) {
    context.addIssue({ code: "custom", message: "Display inventory must identify exactly one primary display." });
  }

  const mediaPaths = new Set(manifest.tracks.flatMap(({ segments }) => segments.map(({ path }) => path)));
  if (manifest.eventStreams.some(({ path }) => mediaPaths.has(path))) {
    context.addIssue({ code: "custom", message: "Media segments and event streams must not share a file path." });
  }
  if (manifest.eventStreams.some(({ endUs }) => endUs > manifest.timeline.durationUs)) {
    context.addIssue({ code: "custom", message: "Event streams cannot exceed the recording timeline." });
  }
  if (manifest.diagnostics.some(({ lastSourceTimeUs }) => (
    lastSourceTimeUs !== null && lastSourceTimeUs > manifest.timeline.durationUs
  ))) {
    context.addIssue({ code: "custom", message: "Recording diagnostics cannot exceed the recording timeline." });
  }
  if (
    manifest.state === "stopped"
    && (
      manifest.tracks.some(({ segments }) => segments.some(({ integrity }) => integrity.state !== "verified"))
      || manifest.eventStreams.some(({ integrity }) => integrity.state !== "verified")
    )
  ) {
    context.addIssue({ code: "custom", message: "Stopped recordings must have verified integrity for every referenced file." });
  }

  for (const track of manifest.tracks) {
    validateOrderedSegments(track, context);
    if (track.segments.some(({ endUs }) => endUs > manifest.timeline.durationUs)) {
      context.addIssue({ code: "custom", message: `Track ${track.trackId} exceeds the recording timeline.` });
    }
    const sourceExists = track.kind === "display-video"
      ? displayIds.has(track.source.displayId)
      : track.kind === "camera-video"
        ? cameraIds.has(track.source.cameraId)
        : track.kind === "system-audio"
          ? systemAudioIds.has(track.source.audioSourceId)
          : microphoneIds.has(track.source.audioSourceId);
    if (!sourceExists) {
      context.addIssue({ code: "custom", message: `Track ${track.trackId} references an unknown source.` });
    }
  }
}

const NormalizedRecordingManifestV1Schema = z.strictObject({
  ...RecordingManifestBaseShape,
  interruptions: z.array(CaptureInterruptionSchema).max(0).default([]),
  schemaVersion: z.literal(1),
  timeline: RecordingTimelineV1Schema,
}).superRefine((manifest, context) => {
  validateRecordingManifest(manifest, context);
  if (manifest.tracks.some(track => track.segments.some(segment => segment.timing.kind !== "legacy-estimate"))) {
    context.addIssue({ code: "custom", message: "Recording manifest v1 may contain only legacy-estimate timing." });
  }
});

const MeasuredRecordingManifestShape = {
  ...RecordingManifestBaseShape,
  timeline: RecordingTimelineV2Schema,
} as const;

type ValidatableMeasuredRecordingManifest = z.infer<
  z.ZodObject<typeof MeasuredRecordingManifestShape>
>;

function validateMeasuredRecordingManifest(
  manifest: ValidatableMeasuredRecordingManifest,
  context: z.core.$RefinementCtx<unknown>,
): void {
  validateRecordingManifest(manifest, context);
  if (manifest.tracks.some(track => track.segments.some(segment => segment.timing.kind !== "measured"))) {
    context.addIssue({ code: "custom", message: "Recording manifest v2 requires measured timing for every media segment." });
  }
  const clockSegments = new Map(
    manifest.timeline.nativeClock.segments.map(segment => [segment.index, segment] as const),
  );
  for (const track of manifest.tracks) {
    const captureSegmentIndices = track.segments.flatMap(segment => (
      segment.timing.kind === "measured" ? [segment.timing.captureSegmentIndex] : []
    ));
    if (new Set(captureSegmentIndices).size !== captureSegmentIndices.length) {
      context.addIssue({
        code: "custom",
        message: `Track ${track.trackId} must have at most one media segment per capture segment.`,
      });
    }
    for (const segment of track.segments) {
      if (segment.timing.kind !== "measured") continue;
      const timing = segment.timing;
      const clockSegment = clockSegments.get(timing.captureSegmentIndex);
      if (clockSegment === undefined) {
        context.addIssue({ code: "custom", message: "Measured timing references an unknown capture clock segment." });
      } else {
        const placement = deriveCaptureSyncPlacement({
          clockNativeStartUs: clockSegment.nativeRange.startUs,
          clockSourceEndUs: clockSegment.sourceRange.endUs,
          clockSourceStartUs: clockSegment.sourceRange.startUs,
          fileContainerOriginPtsUs: timing.evidence.file.containerOriginPtsUs,
          fileEndPtsUs: timing.evidence.file.endPtsUs,
          fileFirstPtsUs: timing.evidence.file.firstPtsUs,
          helperNativeStartUs: timing.evidence.helper.clockAnchors.first.nativeTimeUs,
        });
        if (
          placement === null
          || segment.startUs !== placement.startUs
          || segment.endUs !== placement.endUs
          || segment.fileRange.startUs !== placement.fileRangeStartUs
          || segment.fileRange.endUs !== placement.fileRangeEndUs
        ) {
          context.addIssue({
            code: "custom",
            message: "capture-timing-evidence-mismatch: media placement does not match raw clock and file evidence.",
          });
        }
      }

      const referenceTrack = manifest.tracks.find(
        ({ trackId }) => trackId === timing.referenceTrackId,
      );
      if (referenceTrack === undefined) {
        context.addIssue({ code: "custom", message: "Capture sync measurement references an unknown track." });
        continue;
      }
      if (referenceTrack.kind !== "display-video") {
        context.addIssue({
          code: "custom",
          message: "Capture sync measurement must reference a display-video track.",
        });
        continue;
      }
      const referenceSegments = referenceTrack.segments.filter(candidate => (
        candidate.timing.kind === "measured"
        && candidate.timing.captureSegmentIndex === timing.captureSegmentIndex
      ));
      if (referenceSegments.length !== 1) {
        context.addIssue({
          code: "custom",
          message: "Capture sync reference track must have exactly one segment for the capture segment.",
        });
        continue;
      }
      const referenceTiming = referenceSegments[0]!.timing;
      if (referenceTiming.kind !== "measured") continue;
      const onsetSkewUs = timing.evidence.helper.clockAnchors.first.nativeTimeUs
        - referenceTiming.evidence.helper.clockAnchors.first.nativeTimeUs;
      const endSkewUs = timing.evidence.helper.clockAnchors.end.nativeTimeUs
        - referenceTiming.evidence.helper.clockAnchors.end.nativeTimeUs;
      const durationDriftUs = endSkewUs - onsetSkewUs;
      const referenceDurationUs = referenceTiming.evidence.helper.clockAnchors.end.nativeTimeUs
        - referenceTiming.evidence.helper.clockAnchors.first.nativeTimeUs;
      const durationDriftPpm = deriveCaptureSyncDurationDriftPpm(
        durationDriftUs,
        referenceDurationUs,
      );
      const tolerances = deriveCaptureSyncTolerances({
        referenceDurationUs,
        referenceEndUncertaintyUs: referenceTiming.evidence.helper.clockAnchors.end.uncertaintyUs,
        referenceFirstUncertaintyUs: referenceTiming.evidence.helper.clockAnchors.first.uncertaintyUs,
        referenceMaximumSampleDurationUs: referenceTiming.evidence.helper.presentation.maximumSampleDurationUs,
        subjectEndUncertaintyUs: timing.evidence.helper.clockAnchors.end.uncertaintyUs,
        subjectFirstUncertaintyUs: timing.evidence.helper.clockAnchors.first.uncertaintyUs,
        subjectMaximumSampleDurationUs: timing.evidence.helper.presentation.maximumSampleDurationUs,
      });
      if (
        durationDriftPpm === null
        || timing.onsetSkewUs !== onsetSkewUs
        || timing.durationDriftUs !== durationDriftUs
        || timing.durationDriftPpm !== durationDriftPpm
      ) {
        context.addIssue({
          code: "custom",
          message: "capture-timing-evidence-mismatch: derived synchronization does not match raw clock anchors.",
        });
      }
      if (
        tolerances === null
        || timing.tolerance.durationDriftUs !== tolerances.durationDriftUs
        || timing.tolerance.onsetSkewUs !== tolerances.onsetSkewUs
      ) {
        context.addIssue({
          code: "custom",
          message: "capture-timing-evidence-mismatch: synchronization tolerances do not match capture-sync-v1 policy.",
        });
      } else {
        const expectedStatus = Math.abs(onsetSkewUs) > tolerances.onsetSkewUs
          || Math.abs(durationDriftUs) > tolerances.durationDriftUs
          ? "out-of-tolerance"
          : "within-tolerance";
        if (timing.status !== expectedStatus) {
          context.addIssue({
            code: "custom",
            message: "capture-timing-evidence-mismatch: synchronization status does not match capture-sync-v1 policy.",
          });
        }
      }
    }
  }
}

export const RecordingManifestV2Schema = z.strictObject({
  ...MeasuredRecordingManifestShape,
  interruptions: z.array(CaptureInterruptionSchema).max(0).default([]),
  schemaVersion: z.literal(2),
}).superRefine(validateMeasuredRecordingManifest);

export const RecordingManifestV3Schema = z.strictObject({
  ...MeasuredRecordingManifestShape,
  interruptions: z.array(CaptureInterruptionSchema)
    .max(MAX_CAPTURE_INTERRUPTION_SEGMENTS),
  schemaVersion: z.literal(3),
}).superRefine((manifest, context) => {
  validateMeasuredRecordingManifest(manifest, context);

  const clockSegments = new Map(
    manifest.timeline.nativeClock.segments.map(segment => [segment.index, segment] as const),
  );
  const lastClockSegment = manifest.timeline.nativeClock.segments.at(-1);
  let priorInterruptionIndex = -1;
  let unmatchedFailureSeen = false;
  for (const interruption of manifest.interruptions) {
    if (interruption.segmentIndex <= priorInterruptionIndex) {
      context.addIssue({
        code: "custom",
        message: "Capture interruptions must be ordered with at most one interruption per segment.",
      });
      return;
    }
    priorInterruptionIndex = interruption.segmentIndex;
    const clockSegment = clockSegments.get(interruption.segmentIndex);
    if (clockSegment !== undefined) {
      if (
        !interruption.recoverable
        || interruption.nativeTimeUs !== clockSegment.nativeRange.endUs
        || interruption.sourceTimeUs !== clockSegment.sourceRange.endUs
      ) {
        context.addIssue({
          code: "custom",
          message: "A completed-segment interruption must be recoverable and match its capture clock end anchors.",
        });
      }
      continue;
    }

    const expectedPreparedIndex = (lastClockSegment?.index ?? -1) + 1;
    const persistedSourceFrontierUs =
      lastClockSegment?.sourceRange.endUs ?? 0;
    const persistedNativeFrontierUs =
      lastClockSegment?.nativeRange.endUs ?? 0;
    if (
      unmatchedFailureSeen
      || manifest.state !== "failed"
      || interruption.segmentIndex !== expectedPreparedIndex
      || interruption.sourceTimeUs !== persistedSourceFrontierUs
      || interruption.nativeTimeUs < persistedNativeFrontierUs
      || interruption.recoverable
      || manifest.timeline.durationUs !== persistedSourceFrontierUs
    ) {
      context.addIssue({
        code: "custom",
        message: "Only one nonrecoverable failed prepared-start interruption may be anchored at the persisted capture frontier.",
      });
    }
    unmatchedFailureSeen = true;
  }
});

function unknownArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value as readonly unknown[] : null;
}

function normalizeLegacyRecordingManifest(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const manifest = input as Readonly<Record<string, unknown>>;
  const rawTracks = unknownArray(manifest.tracks);
  if (manifest.schemaVersion !== 1 || rawTracks === null) return input;
  let normalizedLegacySegment = false;
  const tracks = rawTracks.map(rawTrack => {
    if (typeof rawTrack !== "object" || rawTrack === null || Array.isArray(rawTrack)) return rawTrack;
    const track = rawTrack as Readonly<Record<string, unknown>>;
    const rawSegments = unknownArray(track.segments);
    if (rawSegments === null) return rawTrack;
    const segments = rawSegments.map(rawSegment => {
      if (typeof rawSegment !== "object" || rawSegment === null || Array.isArray(rawSegment)) return rawSegment;
      const segment = rawSegment as Readonly<Record<string, unknown>>;
      if (segment.fileRange !== undefined || segment.timing !== undefined) {
        if (
          typeof segment.timing === "object"
          && segment.timing !== null
          && !Array.isArray(segment.timing)
          && (segment.timing as Readonly<Record<string, unknown>>).kind === "legacy-estimate"
        ) {
          normalizedLegacySegment = true;
        }
        return rawSegment;
      }
      const parsed = LegacyMediaSegmentV1Schema.safeParse(rawSegment);
      if (!parsed.success) return rawSegment;
      normalizedLegacySegment = true;
      const legacy = parsed.data;
      return {
        codec: legacy.codec,
        container: legacy.container,
        containerTrackIdentity: legacy.containerTrackIdentity,
        endUs: legacy.endUs,
        fileRange: { endUs: legacy.endUs - legacy.startUs, startUs: 0 },
        integrity: legacy.integrity,
        path: legacy.path,
        segmentId: legacy.segmentId,
        startUs: legacy.startUs,
        streamIndex: legacy.streamIndex,
        timing: {
          kind: "legacy-estimate",
          nativeRange: { endUs: legacy.nativeEndUs, startUs: legacy.nativeStartUs },
          reason: "recording-manifest-v1-container-duration",
        },
      };
    });
    return { ...track, segments };
  });
  const diagnostics = unknownArray(manifest.diagnostics);
  if (diagnostics === null) return { ...manifest, tracks };
  const hasLegacyDiagnostic = diagnostics.some(diagnostic => (
    typeof diagnostic === "object"
    && diagnostic !== null
    && !Array.isArray(diagnostic)
    && (diagnostic as Readonly<Record<string, unknown>>).code === "legacy-capture-timing"
  ));
  return {
    ...manifest,
    diagnostics: normalizedLegacySegment && !hasLegacyDiagnostic
      ? [...diagnostics, {
          code: "legacy-capture-timing",
          count: 1,
          firstSourceTimeUs: null,
          lastSourceTimeUs: null,
          level: "warning",
          message: "Recording manifest v1 has estimated container timing; per-track capture synchronization was not measured.",
        }]
      : diagnostics,
    tracks,
  };
}

export const RecordingManifestSchema = z.preprocess(
  normalizeLegacyRecordingManifest,
  z.discriminatedUnion("schemaVersion", [
    NormalizedRecordingManifestV1Schema,
    RecordingManifestV2Schema,
    RecordingManifestV3Schema,
  ]),
);

/** @deprecated Use RecordingManifestSchema. Retained as a source-compatible reader alias. */
export const RecordingManifestV1Schema = RecordingManifestSchema;

const EventBaseShape = {
  nativeTimeUs: MicrosecondsSchema,
  sequence: SequenceSchema,
  sourceTimeUs: MicrosecondsSchema,
} as const;

export const CursorSampleEventSchema = z.strictObject({
  ...EventBaseShape,
  displayId: z.string().min(1).max(256),
  position: PointSchema,
  type: z.literal("cursor.sample"),
  visible: z.boolean(),
});

export const MouseClickEventSchema = z.strictObject({
  ...EventBaseShape,
  button: z.enum(["left", "right", "middle", "other"]),
  clickCount: z.number().int().safe().positive().max(16),
  displayId: z.string().min(1).max(256),
  phase: z.enum(["down", "up"]),
  position: PointSchema,
  type: z.literal("mouse.click"),
});

const ModifierSchema = z.enum(["command", "control", "option", "shift", "caps-lock", "function"]);

export const KeyActivityEventSchema = z.strictObject({
  ...EventBaseShape,
  activity: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("shortcut"),
      keyCode: z.string().min(1).max(128),
      modifiers: z.array(ModifierSchema).min(1),
      phase: z.enum(["down", "up"]),
      repeat: z.boolean(),
    }),
    z.strictObject({
      control: z.enum(["arrow-up", "arrow-down", "arrow-left", "arrow-right", "escape", "tab", "enter", "delete"]),
      kind: z.literal("control"),
      modifiers: z.array(ModifierSchema),
      phase: z.enum(["down", "up"]),
      repeat: z.boolean(),
    }),
    z.strictObject({
      kind: z.literal("printable"),
      modifiers: z.array(ModifierSchema),
      phase: z.enum(["down", "up"]),
      repeat: z.boolean(),
      token: z.literal("[PRINTABLE]"),
    }),
  ]),
  type: z.literal("key.activity"),
});

const PublicTypingPayloadSchema = z.strictObject({
  action: z.enum(["insert", "delete-backward", "delete-forward", "replace"]),
  bounds: RectSchema,
  fieldId: z.string().min(1).max(512),
  secure: z.literal(false),
  text: z.string().max(4096),
  windowId: z.string().min(1).max(256),
});

export const TypingInputEventSchema = z.strictObject({
  ...EventBaseShape,
  input: PublicTypingPayloadSchema,
  type: z.literal("typing.input"),
});

export const FocusTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({
    bounds: RectSchema,
    fieldId: z.string().min(1).max(512),
    kind: z.literal("public-input"),
    processId: z.number().int().positive().max(2_147_483_647).optional(),
    role: z.string().min(1).max(128),
    windowId: z.string().min(1).max(256),
  }),
  z.strictObject({
    bounds: RectSchema,
    fieldId: z.literal("[REDACTED]"),
    kind: z.literal("secure-input"),
    processId: z.number().int().positive().max(2_147_483_647).optional(),
    redacted: z.literal(true),
    role: z.literal("secure-text-field"),
    windowId: z.string().min(1).max(256),
  }),
]);

export const FocusChangedEventSchema = z.strictObject({
  ...EventBaseShape,
  target: FocusTargetSchema,
  type: z.literal("focus.changed"),
});

export const WindowTitleSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("available"), value: z.string().max(2048) }),
  z.strictObject({ reason: z.enum(["permission", "secure", "unavailable"]), state: z.literal("redacted") }),
]);

export const WindowRecordSchema = z.strictObject({
  applicationBundleId: z.string().min(1).max(512),
  applicationName: z.string().min(1).max(512),
  bounds: RectSchema,
  displayId: z.string().min(1).max(256),
  isFocused: z.boolean(),
  layer: z.number().int().safe(),
  title: WindowTitleSchema,
  windowId: z.string().min(1).max(256),
});

export const WindowSnapshotEventSchema = z.strictObject({
  ...EventBaseShape,
  type: z.literal("window.snapshot"),
  windows: z.array(WindowRecordSchema),
});

export const WindowChangedEventSchema = z.strictObject({
  ...EventBaseShape,
  change: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.enum(["created", "updated", "focused"]), window: WindowRecordSchema }),
    z.strictObject({ kind: z.literal("destroyed"), windowId: z.string().min(1).max(256) }),
  ]),
  type: z.literal("window.changed"),
});

export const DisplayTopologyEventSchema = z.strictObject({
  ...EventBaseShape,
  displays: z.array(DisplaySourceSchema).min(1),
  type: z.literal("display.topology"),
});

export const LifecycleMarkerEventSchema = z.strictObject({
  ...EventBaseShape,
  marker: z.enum([
    "capture-requested",
    "recording-started",
    "pause-requested",
    "paused",
    "resume-requested",
    "resumed",
    "stop-requested",
    "stopped",
    "segment-opened",
    "segment-closed",
    "failed",
  ]),
  segmentId: SegmentIdSchema.nullable(),
  type: z.literal("lifecycle.marker"),
});

export const DroppedEventsDiagnosticSchema = z.strictObject({
  ...EventBaseShape,
  category: z.enum(["cursor", "mouse", "keyboard", "typing", "window", "display", "lifecycle"]),
  droppedCount: z.number().int().safe().positive(),
  firstDroppedNativeTimeUs: MicrosecondsSchema,
  lastDroppedNativeTimeUs: MicrosecondsSchema,
  reason: z.string().min(1).max(1024),
  type: z.literal("diagnostic.dropped-events"),
});

export const RecordingEventV1Schema = z.discriminatedUnion("type", [
  CursorSampleEventSchema,
  MouseClickEventSchema,
  KeyActivityEventSchema,
  TypingInputEventSchema,
  FocusChangedEventSchema,
  WindowSnapshotEventSchema,
  WindowChangedEventSchema,
  DisplayTopologyEventSchema,
  LifecycleMarkerEventSchema,
  DroppedEventsDiagnosticSchema,
]);

export type RecordingId = z.infer<typeof RecordingIdSchema>;
export type TrackId = z.infer<typeof TrackIdSchema>;
export type SegmentId = z.infer<typeof SegmentIdSchema>;
export type Rect = ReadonlyInferred<typeof RectSchema>;
export type Point = ReadonlyInferred<typeof PointSchema>;
export type DisplaySource = ReadonlyInferred<typeof DisplaySourceSchema>;
export type SourceInventory = ReadonlyInferred<typeof SourceInventorySchema>;
export type CapturePermissions = ReadonlyInferred<typeof CapturePermissionsSchema>;
export type CaptureInterruption = ReadonlyInferred<typeof CaptureInterruptionSchema>;
export type RecordingManifestV1 = ReadonlyInferred<typeof RecordingManifestV1Schema>;
export type RecordingManifestV2 = ReadonlyInferred<typeof RecordingManifestV2Schema>;
export type RecordingManifestV3 = ReadonlyInferred<typeof RecordingManifestV3Schema>;
export type RecordingManifest = ReadonlyInferred<typeof RecordingManifestSchema>;
export type RecordingEventV1 = ReadonlyInferred<typeof RecordingEventV1Schema>;
export type CursorSampleEvent = ReadonlyInferred<typeof CursorSampleEventSchema>;
export type TypingInputEvent = ReadonlyInferred<typeof TypingInputEventSchema>;
export type WindowRecord = ReadonlyInferred<typeof WindowRecordSchema>;

export function parseRecordingManifestV1(input: unknown): RecordingManifestV1 {
  return RecordingManifestV1Schema.parse(input);
}

export function parseRecordingManifest(input: unknown): RecordingManifest {
  return RecordingManifestSchema.parse(input);
}

export function parseRecordingEventV1(input: unknown): RecordingEventV1 {
  return RecordingEventV1Schema.parse(input);
}
