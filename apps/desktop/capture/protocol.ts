import { z } from "zod";
import {
  CaptureInterruptionSchema as RecordingCaptureInterruptionSchema,
  MAX_CAPTURE_INTERRUPTION_SOURCE_ID_BYTES,
  type CaptureInterruption as RecordingCaptureInterruption,
} from "../contracts/recording";

export const CAPTURE_PROTOCOL_VERSION = 4 as const;
export const CAPTURE_HELPER_VERSION = "0.4.0" as const;
export const MAX_PROTOCOL_LINE_BYTES = 64 * 1024;
export const MAX_CAPTURE_DISPLAYS = 16;
export const MAX_CAPTURE_CAMERAS = 32;
export const MAX_CAPTURE_AUDIO_SOURCES = 64;
export const MAX_CAPTURE_SEGMENTS = 128;
export const MAX_CAPTURE_SOURCE_ID_BYTES =
  MAX_CAPTURE_INTERRUPTION_SOURCE_ID_BYTES;

export {
  CaptureInterruptionSchema,
  type CaptureInterruption,
} from "../contracts/recording";

const BoundedIdentifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u);
const utf8ByteLength = (value: string): number =>
  new TextEncoder().encode(value).byteLength;
const utf8BoundedString = (maximumBytes: number) => z.string().min(1)
  .refine(
    value => utf8ByteLength(value) <= maximumBytes && !value.includes("\0"),
    `Expected a non-NUL string of at most ${String(maximumBytes)} UTF-8 bytes.`,
  );
const BoundedFieldIdentifierSchema = utf8BoundedString(512);
const BoundedWindowIdentifierSchema = z.string().min(1)
  .regex(/^[1-9][0-9]*$/u)
  .refine(
    value => utf8ByteLength(value) <= 32 && !value.includes("\0"),
    "Expected a positive decimal window ID of at most 32 UTF-8 bytes.",
  );
const BoundedWindowTitleSchema = utf8BoundedString(256);
const BoundedMessageSchema = z.string().min(1).max(4_096);
const SafeIntegerSchema = z.number().int().safe().nonnegative();
const PositiveSafeIntegerSchema = SafeIntegerSchema.positive();
const SignedSafeIntegerSchema = z.number().int().safe();
const PositiveProcessIdentifierSchema = z.number().int().positive()
  .max(2_147_483_647);

const AbsoluteSessionDirectorySchema = z.string().min(1).max(4_096).superRefine((value, context) => {
  if (!value.startsWith("/") || value.includes("\0")) {
    context.addIssue({ code: "custom", message: "Expected an absolute macOS path." });
    return;
  }
  if (value.split("/").some((part) => part === "." || part === "..")) {
    context.addIssue({ code: "custom", message: "Absolute paths may not contain dot segments." });
  }
});

const RelativeOutputPathSchema = z.string().min(1).max(1_024).superRefine((value, context) => {
  if (
    value.startsWith("/")
    || value.startsWith("\\")
    || value.includes("\\")
    || value.includes("\0")
    || value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    context.addIssue({ code: "custom", message: "Expected a normalized session-relative output path." });
  }
});

const RequestBase = {
  protocolVersion: z.literal(CAPTURE_PROTOCOL_VERSION),
  requestId: BoundedIdentifierSchema,
} as const;

export const TypedTextFocusIdentitySchema = z.strictObject({
  fieldId: BoundedFieldIdentifierSchema,
  processId: PositiveProcessIdentifierSchema,
  windowId: BoundedWindowIdentifierSchema,
  windowTitle: BoundedWindowTitleSchema,
});

export const TypedTextFocusIdentitiesSchema = z.array(TypedTextFocusIdentitySchema)
  .max(16)
  .superRefine((identities, context) => {
    const keys = identities.map(identity =>
      `${identity.processId}\0${identity.windowId}\0${identity.fieldId}\0${identity.windowTitle}`
    );
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        message: "Typed-text focus identities must be unique.",
      });
    }
  });

export const CaptureDisplaySelectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("all") }),
  z.strictObject({
    displayIds: z.array(utf8BoundedString(64)).min(1).max(MAX_CAPTURE_DISPLAYS)
      .superRefine((displayIds, context) => {
        if (new Set(displayIds).size !== displayIds.length) {
          context.addIssue({
            code: "custom",
            message: "Selected display IDs must be unique.",
          });
        }
      }),
    kind: z.literal("selected"),
  }),
]);

export const CaptureDeviceSelectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("disabled") }),
  z.strictObject({ kind: z.literal("default") }),
  z.strictObject({
    deviceId: utf8BoundedString(256),
    kind: z.literal("device"),
  }),
]);

export const CaptureOptionsSchema = z.strictObject({
  camera: CaptureDeviceSelectionSchema.default({ kind: "default" }),
  displays: CaptureDisplaySelectionSchema.default({ kind: "all" }),
  metadata: z.boolean().default(true),
  microphone: CaptureDeviceSelectionSchema.default({ kind: "default" }),
  interactionEventProcessIdentifier: PositiveProcessIdentifierSchema
    .nullable()
    .default(null),
  strictSources: z.boolean().default(false),
  systemAudio: z.boolean().default(true),
  typedText: z.boolean().default(false),
  typedTextFocusIdentities: TypedTextFocusIdentitiesSchema.nullable()
    .default(null),
  excludedBundleIdentifiers: z.array(z.string().min(1).max(256)).max(16).default(["com.hraness.transmute"]),
});

const ConfigureRequestSchema = z.strictObject({
  ...RequestBase,
  command: z.literal("configure"),
  options: CaptureOptionsSchema.optional(),
  sessionDirectory: AbsoluteSessionDirectorySchema,
});

const SimpleCommandSchema = <Command extends "pause" | "resume" | "shutdown" | "snapshot" | "start" | "status" | "stop">(
  command: Command,
) => z.strictObject({ ...RequestBase, command: z.literal(command) });

export const CaptureRequestSchema = z.discriminatedUnion("command", [
  ConfigureRequestSchema,
  SimpleCommandSchema("start"),
  SimpleCommandSchema("pause"),
  SimpleCommandSchema("resume"),
  SimpleCommandSchema("snapshot"),
  SimpleCommandSchema("status"),
  SimpleCommandSchema("stop"),
  SimpleCommandSchema("shutdown"),
]);

export type CaptureOptions = Readonly<z.infer<typeof CaptureOptionsSchema>>;
export type CaptureRequest = Readonly<z.infer<typeof CaptureRequestSchema>>;
export type TypedTextFocusIdentity = Readonly<
  z.infer<typeof TypedTextFocusIdentitySchema>
>;

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

const RectSchema = z.strictObject({
  height: z.number().finite().positive(),
  width: z.number().finite().positive(),
  x: z.number().finite(),
  y: z.number().finite(),
});

export const DisplayGeometrySchema = z.strictObject({
  bounds: RectSchema,
  displayId: z.string().min(1).max(64),
  isPrimary: z.boolean(),
  pixelHeight: PositiveSafeIntegerSchema,
  pixelWidth: PositiveSafeIntegerSchema,
  scaleFactor: z.number().finite().positive().max(8),
});

export const CaptureSourceInventorySchema = z.strictObject({
  audio: z.array(z.discriminatedUnion("kind", [
    z.strictObject({
      audioSourceId: z.string().min(1).max(256),
      channels: z.number().int().positive().max(64),
      kind: z.literal("system"),
      label: z.string().min(1).max(512),
      sampleRateHz: z.number().int().positive().max(768_000),
    }),
    z.strictObject({
      audioSourceId: z.string().min(1).max(256),
      channels: z.number().int().positive().max(64),
      kind: z.literal("microphone"),
      label: z.string().min(1).max(512),
      sampleRateHz: z.number().int().positive().max(768_000),
    }),
  ])).max(MAX_CAPTURE_AUDIO_SOURCES),
  cameras: z.array(z.strictObject({
    cameraId: z.string().min(1).max(256),
    frameRate: z.number().finite().positive().max(1_000),
    label: z.string().min(1).max(512),
    pixelSize: z.strictObject({
      height: PositiveSafeIntegerSchema,
      width: PositiveSafeIntegerSchema,
    }),
    position: z.enum(["front", "back", "external", "unspecified"]),
  })).max(MAX_CAPTURE_CAMERAS),
  displays: z.array(z.strictObject({
    bounds: RectSchema,
    displayId: z.string().min(1).max(64),
    isPrimary: z.boolean(),
    label: z.string().min(1).max(512),
    pixelSize: z.strictObject({
      height: PositiveSafeIntegerSchema,
      width: PositiveSafeIntegerSchema,
    }),
    refreshRateHz: z.number().finite().positive().max(1_000),
    scaleFactor: z.number().finite().positive().max(8),
  })).max(MAX_CAPTURE_DISPLAYS),
}).superRefine((sources, context) => {
  const duplicate = <Item>(items: readonly Item[], key: (item: Item) => string): boolean => {
    const values = items.map(key);
    return new Set(values).size !== values.length;
  };
  if (duplicate(sources.audio, ({ audioSourceId }) => audioSourceId)) {
    context.addIssue({ code: "custom", message: "Capture audio source IDs must be unique." });
  }
  if (duplicate(sources.cameras, ({ cameraId }) => cameraId)) {
    context.addIssue({ code: "custom", message: "Capture camera IDs must be unique." });
  }
  if (duplicate(sources.displays, ({ displayId }) => displayId)) {
    context.addIssue({ code: "custom", message: "Capture display IDs must be unique." });
  }
  if (
    sources.displays.length > 0
    && sources.displays.filter(({ isPrimary }) => isPrimary).length !== 1
  ) {
    context.addIssue({ code: "custom", message: "Capture displays must identify exactly one primary display." });
  }
});

const DiagnosticSchema = z.strictObject({
  code: z.string().min(1).max(128),
  message: BoundedMessageSchema,
  recoverable: z.boolean(),
  source: z.enum(["camera", "helper", "metadata", "microphone", "screen", "system-audio"]),
});

const CaptureClockAnchorSchema = z.strictObject({
  nativeTimeUs: SafeIntegerSchema,
  ptsUs: SignedSafeIntegerSchema,
  uncertaintyUs: SafeIntegerSchema.max(1_000_000),
});

export const CaptureStreamTimingSchema = z.strictObject({
  bufferCount: PositiveSafeIntegerSchema,
  clockAnchors: z.strictObject({
    end: CaptureClockAnchorSchema,
    first: CaptureClockAnchorSchema,
  }),
  presentation: z.strictObject({
    endPtsUs: SignedSafeIntegerSchema,
    firstPtsUs: SignedSafeIntegerSchema,
    lastPtsUs: SignedSafeIntegerSchema,
    maximumSampleDurationUs: PositiveSafeIntegerSchema,
  }),
  sampleCount: PositiveSafeIntegerSchema,
}).superRefine((timing, context) => {
  const { endPtsUs, firstPtsUs, lastPtsUs, maximumSampleDurationUs } = timing.presentation;
  if (lastPtsUs < firstPtsUs) {
    context.addIssue({ code: "custom", message: "Stream lastPtsUs cannot precede firstPtsUs." });
  }
  if (endPtsUs <= lastPtsUs) {
    context.addIssue({ code: "custom", message: "Stream endPtsUs must be after lastPtsUs." });
  }
  if (endPtsUs - lastPtsUs > maximumSampleDurationUs) {
    context.addIssue({ code: "custom", message: "Stream final sample exceeds maximumSampleDurationUs." });
  }
  if (
    timing.clockAnchors.first.ptsUs !== firstPtsUs
    || timing.clockAnchors.end.ptsUs !== endPtsUs
  ) {
    context.addIssue({ code: "custom", message: "Stream clock anchors must bind the first and exclusive-end PTS." });
  }
  if (timing.clockAnchors.end.nativeTimeUs <= timing.clockAnchors.first.nativeTimeUs) {
    context.addIssue({ code: "custom", message: "Stream native clock anchors must increase." });
  }
  const presentationSpanUs = endPtsUs - firstPtsUs;
  const nativeSpanUs = timing.clockAnchors.end.nativeTimeUs
    - timing.clockAnchors.first.nativeTimeUs;
  const clockMappingToleranceUs = timing.clockAnchors.first.uncertaintyUs
    + timing.clockAnchors.end.uncertaintyUs
    + 2;
  if (Math.abs(nativeSpanUs - presentationSpanUs) > clockMappingToleranceUs) {
    context.addIssue({ code: "custom", message: "Stream native clock anchors exceed their recorded mapping uncertainty." });
  }
  if (timing.sampleCount < timing.bufferCount) {
    context.addIssue({ code: "custom", message: "Stream sampleCount cannot be smaller than bufferCount." });
  }
});

const ClassifiedMediaStreamBase = {
  channels: z.number().int().positive().max(64).optional(),
  codec: z.string().min(1).max(64),
  mapping: z.enum(["exact", "provisional"]),
  sampleRateHz: z.number().int().positive().max(768_000).optional(),
  streamIndex: SafeIntegerSchema,
  timing: CaptureStreamTimingSchema,
  trackId: SafeIntegerSchema.optional(),
} as const;

const MediaStreamSchema = z.discriminatedUnion("role", [
  z.strictObject({ ...ClassifiedMediaStreamBase, role: z.literal("camera-video") }),
  z.strictObject({ ...ClassifiedMediaStreamBase, role: z.literal("display-video") }),
  z.strictObject({ ...ClassifiedMediaStreamBase, role: z.literal("microphone-audio") }),
  z.strictObject({ ...ClassifiedMediaStreamBase, role: z.literal("system-audio") }),
  z.strictObject({
    channels: z.number().int().positive().max(64).optional(),
    codec: z.string().min(1).max(64),
    mapping: z.literal("provisional"),
    role: z.literal("unclassified-audio"),
    sampleRateHz: z.number().int().positive().max(768_000).optional(),
    streamIndex: SafeIntegerSchema,
    timing: z.never().optional(),
    trackId: SafeIntegerSchema.optional(),
  }),
]);

const DisplayRecordingSchema = z.strictObject({
  containerDurationUs: PositiveSafeIntegerSchema,
  container: z.literal("mp4"),
  display: DisplayGeometrySchema,
  path: RelativeOutputPathSchema,
  streams: z.array(MediaStreamSchema).min(1).max(3),
});

const CameraRecordingSchema = z.discriminatedUnion("availability", [
  z.strictObject({
    availability: z.literal("recorded"),
    containerDurationUs: PositiveSafeIntegerSchema,
    container: z.enum(["mov", "mp4"]),
    deviceId: z.string().min(1).max(256),
    label: z.string().min(1).max(512),
    path: RelativeOutputPathSchema,
    streams: z.array(MediaStreamSchema).length(1),
  }),
  z.strictObject({
    availability: z.literal("unavailable"),
    reason: z.enum([
      "disabled", "denied", "missing", "restricted", "start-failed",
      "finalization-failed", "inspection-failed",
    ]),
  }),
]);

const MicrophoneRecordingSchema = z.discriminatedUnion("availability", [
  z.strictObject({
    availability: z.literal("recorded"),
    containerDurationUs: PositiveSafeIntegerSchema,
    container: z.literal("m4a"),
    deviceId: z.string().min(1).max(256),
    label: z.string().min(1).max(512),
    path: RelativeOutputPathSchema,
    streams: z.array(MediaStreamSchema).length(1),
  }),
  z.strictObject({
    availability: z.literal("unavailable"),
    reason: z.enum([
      "disabled", "denied", "missing", "restricted", "start-failed",
      "finalization-failed", "inspection-failed",
    ]),
  }),
]);

const MetadataFileSchema = z.strictObject({
  droppedEvents: SafeIntegerSchema,
  eventKinds: z.array(z.enum([
    "cursor.sample",
    "display.topology",
    "focus.changed",
    "key.activity",
    "lifecycle.marker",
    "mouse.click",
    "typing.input",
    "window.changed",
    "window.snapshot",
    "diagnostic.dropped-events",
  ])).min(1).max(10),
  path: RelativeOutputPathSchema,
  recordCount: SafeIntegerSchema,
});

export const SegmentCompletionSchema = z.strictObject({
  camera: CameraRecordingSchema,
  clock: z.strictObject({
    end: z.strictObject({
      nativeTimeUs: SafeIntegerSchema,
      sourceTimeUs: SafeIntegerSchema,
    }),
    kind: z.literal("mach-continuous-microseconds"),
    start: z.strictObject({
      nativeTimeUs: SafeIntegerSchema,
      sourceTimeUs: SafeIntegerSchema,
    }),
  }),
  diagnostics: z.array(DiagnosticSchema).max(128),
  displays: z.array(DisplayRecordingSchema).min(1).max(MAX_CAPTURE_DISPLAYS),
  index: SafeIntegerSchema.max(MAX_CAPTURE_SEGMENTS - 1),
  metadata: z.array(MetadataFileSchema).max(8),
  microphone: MicrophoneRecordingSchema,
  sources: CaptureSourceInventorySchema,
}).superRefine((segment, context) => {
  const sourceDurationUs = segment.clock.end.sourceTimeUs - segment.clock.start.sourceTimeUs;
  const nativeDurationUs = segment.clock.end.nativeTimeUs - segment.clock.start.nativeTimeUs;
  if (sourceDurationUs <= 0 || nativeDurationUs <= 0) {
    context.addIssue({ code: "custom", message: "Segment clock anchors must increase." });
  } else if (sourceDurationUs !== nativeDurationUs) {
    context.addIssue({ code: "custom", message: "Segment source and native clock durations must agree." });
  }
  const paths = [
    ...segment.displays.map(({ path }) => path),
    ...(segment.camera.availability === "recorded" ? [segment.camera.path] : []),
    ...(segment.microphone.availability === "recorded" ? [segment.microphone.path] : []),
    ...segment.metadata.map(({ path }) => path),
  ];
  if (new Set(paths).size !== paths.length) {
    context.addIssue({ code: "custom", message: "Segment output paths must be unique." });
  }
  const outputDisplayIds = segment.displays.map(({ display }) => display.displayId);
  if (new Set(outputDisplayIds).size !== outputDisplayIds.length) {
    context.addIssue({ code: "custom", message: "Segment display output IDs must be unique." });
  }
  if (segment.displays.filter(({ display }) => display.isPrimary).length !== 1) {
    context.addIssue({ code: "custom", message: "Segment outputs must identify exactly one primary display." });
  }
  const sourceDisplayIds = new Set(segment.sources.displays.map(({ displayId }) => displayId));
  if (outputDisplayIds.some(displayId => !sourceDisplayIds.has(displayId))) {
    context.addIssue({ code: "custom", message: "Segment display outputs must exist in the source inventory." });
  }
  let systemAudioTracks = 0;
  for (const display of segment.displays) {
    const displayVideo = display.streams.filter(({ role }) => role === "display-video");
    if (displayVideo.length !== 1 || displayVideo[0]?.mapping !== "exact") {
      context.addIssue({ code: "custom", message: "Each display file must identify one exact display-video stream." });
    }
    if (display.streams.some(({ role }) => role === "camera-video" || role === "microphone-audio")) {
      context.addIssue({ code: "custom", message: "Display files may not claim camera or microphone streams." });
    }
    for (const stream of display.streams) {
      if (stream.role === "system-audio") {
        systemAudioTracks += 1;
        if (stream.mapping !== "exact") {
          context.addIssue({ code: "custom", message: "The isolated ScreenCaptureKit audio stream must have exact system-audio identity." });
        }
      }
    }
  }
  if (systemAudioTracks > 1) {
    context.addIssue({ code: "custom", message: "A segment may contain only one system-audio stream." });
  }
  if (
    segment.camera.availability === "recorded"
    && (segment.camera.streams[0]?.role !== "camera-video" || segment.camera.streams[0].mapping !== "exact")
  ) {
    context.addIssue({ code: "custom", message: "Recorded camera media must identify one exact camera-video stream." });
  }
  if (
    segment.microphone.availability === "recorded"
    && (segment.microphone.streams[0]?.role !== "microphone-audio" || segment.microphone.streams[0].mapping !== "exact")
  ) {
    context.addIssue({ code: "custom", message: "Recorded microphone media must identify one exact microphone-audio stream." });
  }
});

const EventBase = {
  protocolVersion: z.literal(CAPTURE_PROTOCOL_VERSION),
} as const;

const RequestEventBase = {
  ...EventBase,
  requestId: BoundedIdentifierSchema,
} as const;

const StateSchema = z.enum(["unconfigured", "ready", "recording", "paused", "stopped", "shutting-down"]);

export const CaptureHelperCapabilitiesSchema = z.strictObject({
  availableSources: z.boolean(),
  camera: z.boolean(),
  displayRecording: z.boolean(),
  interruptionDiagnostics: z.boolean(),
  metadata: z.boolean(),
  microphone: z.boolean(),
  minimumMacOSMajorVersion: z.literal(15),
  systemAudio: z.boolean(),
  typedTextOptIn: z.boolean(),
});

export const CaptureHelperProbeSchema = z.strictObject({
  availableSources: CaptureSourceInventorySchema,
  capabilities: CaptureHelperCapabilitiesSchema,
  helperVersion: z.literal(CAPTURE_HELPER_VERSION),
  permissions: CapturePermissionsSchema,
  protocolVersion: z.literal(CAPTURE_PROTOCOL_VERSION),
});

export type CaptureHelperProbe = Readonly<z.infer<typeof CaptureHelperProbeSchema>>;

const CaptureEventValueSchema = z.discriminatedUnion("event", [
  z.strictObject({
    ...EventBase,
    capabilities: CaptureHelperCapabilitiesSchema,
    event: z.literal("ready"),
    helperVersion: z.literal(CAPTURE_HELPER_VERSION),
  }),
  z.strictObject({
    ...RequestEventBase,
    availableSources: CaptureSourceInventorySchema,
    event: z.literal("configured"),
    lastInterruption: RecordingCaptureInterruptionSchema.nullable(),
    options: CaptureOptionsSchema,
    permissions: CapturePermissionsSchema,
    sources: CaptureSourceInventorySchema,
    state: z.literal("ready"),
  }),
  z.strictObject({
    ...RequestEventBase,
    event: z.literal("status"),
    activeSegmentIndex: SafeIntegerSchema.nullable(),
    availableSources: CaptureSourceInventorySchema,
    completedSegmentCount: SafeIntegerSchema.max(MAX_CAPTURE_SEGMENTS),
    lastInterruption: RecordingCaptureInterruptionSchema.nullable(),
    logicalTimeUs: SafeIntegerSchema,
    permissions: CapturePermissionsSchema,
    sources: CaptureSourceInventorySchema,
    state: StateSchema,
  }),
  z.strictObject({
    ...RequestEventBase,
    event: z.literal("segment-started"),
    index: SafeIntegerSchema.max(MAX_CAPTURE_SEGMENTS - 1),
    nativeStartUs: SafeIntegerSchema,
    permissions: CapturePermissionsSchema,
    sources: CaptureSourceInventorySchema,
    startUs: SafeIntegerSchema,
  }),
  z.strictObject({
    ...RequestEventBase,
    event: z.literal("segment-completed"),
    interruption: RecordingCaptureInterruptionSchema.nullable(),
    segment: SegmentCompletionSchema,
  }),
  z.strictObject({
    ...RequestEventBase,
    durationUs: SafeIntegerSchema,
    event: z.literal("session-completed"),
    segmentCount: SafeIntegerSchema.max(MAX_CAPTURE_SEGMENTS),
    state: z.literal("stopped"),
  }),
  z.strictObject({
    ...RequestEventBase,
    code: z.string().min(1).max(128),
    event: z.literal("error"),
    interruption: RecordingCaptureInterruptionSchema.nullable(),
    message: BoundedMessageSchema,
    recoverable: z.boolean(),
    state: StateSchema,
  }),
  z.strictObject({
    ...RequestEventBase,
    event: z.literal("shutdown"),
  }),
]);

export const CaptureEventSchema = CaptureEventValueSchema.superRefine(
  (event, context) => {
    if (event.event === "configured" && event.lastInterruption !== null) {
      context.addIssue({
        code: "custom",
        message: "A newly configured capture session cannot have a prior interruption.",
      });
    }
    if (event.event === "segment-completed" && event.interruption !== null) {
      if (
        event.interruption.segmentIndex !== event.segment.index
        || event.interruption.nativeTimeUs
          !== event.segment.clock.end.nativeTimeUs
        || event.interruption.sourceTimeUs
          !== event.segment.clock.end.sourceTimeUs
      ) {
        context.addIssue({
          code: "custom",
          message: "A segment-completed interruption must match the segment index and clock-end anchors.",
        });
      }
      if (!event.interruption.recoverable) {
        context.addIssue({
          code: "custom",
          message: "A completed interruption must be recoverable.",
        });
      }
    }
    if (
      event.event === "error"
      && event.interruption !== null
      && event.interruption.recoverable !== event.recoverable
    ) {
      context.addIssue({
        code: "custom",
        message: "An error interruption must agree with the error recovery state.",
      });
    }
  },
);

export type CaptureEvent = Readonly<z.infer<typeof CaptureEventSchema>>;
export type SegmentCompletion = Readonly<z.infer<typeof SegmentCompletionSchema>>;
export type CapturePermissions = Readonly<z.infer<typeof CapturePermissionsSchema>>;
export type CaptureSourceInventory = Readonly<
  z.infer<typeof CaptureSourceInventorySchema>
>;

function parseBoundedJsonLine(line: string): unknown {
  if (new TextEncoder().encode(line).byteLength > MAX_PROTOCOL_LINE_BYTES) {
    throw new Error(`Capture protocol line exceeds ${MAX_PROTOCOL_LINE_BYTES} bytes.`);
  }
  if (line.trim().length === 0) {
    throw new Error("Capture protocol line is empty.");
  }
  try {
    return JSON.parse(line) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown JSON error";
    throw new Error(`Capture protocol line is not valid JSON: ${detail}`);
  }
}

export function parseCaptureRequest(value: unknown): CaptureRequest {
  return CaptureRequestSchema.parse(value);
}

export function parseCaptureRequestLine(line: string): CaptureRequest {
  return parseCaptureRequest(parseBoundedJsonLine(line));
}

export function parseCaptureEvent(value: unknown): CaptureEvent {
  return CaptureEventSchema.parse(value);
}

export function parseCaptureHelperProbe(value: unknown): CaptureHelperProbe {
  return CaptureHelperProbeSchema.parse(value);
}

export function parseCaptureInterruption(
  value: unknown,
): RecordingCaptureInterruption {
  return RecordingCaptureInterruptionSchema.parse(value);
}

export function parseCaptureEventLine(line: string): CaptureEvent {
  return parseCaptureEvent(parseBoundedJsonLine(line));
}

export function encodeCaptureRequest(request: CaptureRequest): string {
  return `${JSON.stringify(parseCaptureRequest(request))}\n`;
}

export function encodeCaptureEvent(event: CaptureEvent): string {
  const line = JSON.stringify(parseCaptureEvent(event));
  if (new TextEncoder().encode(line).byteLength > MAX_PROTOCOL_LINE_BYTES) {
    throw new Error(`Encoded capture event exceeds ${MAX_PROTOCOL_LINE_BYTES} bytes.`);
  }
  return `${line}\n`;
}
