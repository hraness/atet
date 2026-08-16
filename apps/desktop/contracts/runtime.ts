import { z } from "zod";

import {
  CaptureInterruptionSchema,
  CapturePermissionsSchema,
  IsoTimestampSchema,
  MicrosecondsSchema,
  RecordingIdSchema,
  RepositoryRelativePathSchema,
  type ReadonlyInferred,
} from "./recording";

export const ATET_DESKTOP_PROTOCOL = "atet.desktop";
export const LEGACY_STUDIO_DESKTOP_PROTOCOL = "studio.desktop";
export const ATET_DESKTOP_PROTOCOL_VERSION = 3;

const RuntimeRequestIdSchema = z.string().regex(/^request_[a-z0-9][a-z0-9_-]{7,63}$/u);
const RuntimeCommandIdSchema = z.string().regex(/^command_[a-z0-9][a-z0-9_-]{7,63}$/u);
const CaptureSourceIdSchema = z.string().min(1).max(256);

export const CaptureRuntimeStateSchema = z.discriminatedUnion("state", [
  z.strictObject({
    lastRecording: z.strictObject({
      durationUs: MicrosecondsSchema,
      recordingId: RecordingIdSchema,
      recordingPath: RepositoryRelativePathSchema,
    }).nullable(),
    state: z.literal("idle"),
  }),
  z.strictObject({ commandId: RuntimeCommandIdSchema, recordingPath: RepositoryRelativePathSchema, state: z.literal("starting") }),
  z.strictObject({ recordingId: RecordingIdSchema, recordingPath: RepositoryRelativePathSchema, sourceTimeUs: MicrosecondsSchema, state: z.literal("recording") }),
  z.strictObject({ recordingId: RecordingIdSchema, recordingPath: RepositoryRelativePathSchema, sourceTimeUs: MicrosecondsSchema, state: z.literal("paused") }),
  z.strictObject({ commandId: RuntimeCommandIdSchema, recordingId: RecordingIdSchema, recordingPath: RepositoryRelativePathSchema, sourceTimeUs: MicrosecondsSchema, state: z.literal("stopping") }),
  z.strictObject({
    code: z.string().min(1).max(128),
    message: z.string().min(1).max(2048),
    recordingId: RecordingIdSchema.nullable(),
    recordingPath: RepositoryRelativePathSchema.nullable(),
    sourceTimeUs: MicrosecondsSchema.nullable(),
    state: z.literal("failed"),
  }),
]);

export const RuntimeSourceSummarySchema = z.strictObject({
  audioSources: z.array(z.strictObject({
    id: z.string().min(1).max(256),
    kind: z.enum(["system", "microphone"]),
    label: z.string().min(1).max(512),
  })).max(64),
  cameras: z.array(z.strictObject({ id: z.string().min(1).max(256), label: z.string().min(1).max(512) })).max(32),
  displays: z.array(z.strictObject({ id: z.string().min(1).max(256), isPrimary: z.boolean(), label: z.string().min(1).max(512) })).max(32),
});

export const CaptureRuntimeSnapshotSchema = z.strictObject({
  availableSources: RuntimeSourceSummarySchema,
  lastInterruption: CaptureInterruptionSchema.nullable(),
  permissions: CapturePermissionsSchema,
  protocolVersion: z.literal(ATET_DESKTOP_PROTOCOL_VERSION),
  sources: RuntimeSourceSummarySchema,
  state: CaptureRuntimeStateSchema,
  updatedAt: IsoTimestampSchema,
});

const DisplaySelectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("all") }),
  z.strictObject({
    displayIds: z.array(CaptureSourceIdSchema).min(1).max(16).superRefine((displayIds, context) => {
      if (new Set(displayIds).size !== displayIds.length) {
        context.addIssue({ code: "custom", message: "Selected display IDs must be unique." });
      }
    }),
    kind: z.literal("selected"),
  }),
]);

const OptionalDeviceSelectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("disabled") }),
  z.strictObject({ kind: z.literal("default") }),
  z.strictObject({ deviceId: CaptureSourceIdSchema, kind: z.literal("device") }),
]);

export const CaptureStartOptionsSchema = z.strictObject({
  camera: OptionalDeviceSelectionSchema,
  displays: DisplaySelectionSchema,
  microphone: OptionalDeviceSelectionSchema,
  recordingDirectory: RepositoryRelativePathSchema.refine(
    (path) => path === "artifacts/atet/recordings"
      || path.startsWith("artifacts/atet/recordings/"),
    "Recordings must stay under artifacts/atet/recordings/.",
  ),
  systemAudio: z.boolean(),
  typedText: z.enum(["disabled", "enabled"]),
  windowMetadata: z.literal("titles-and-bounds"),
});

export const CaptureDomainCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ commandId: RuntimeCommandIdSchema, kind: z.literal("start"), options: CaptureStartOptionsSchema }),
  z.strictObject({ commandId: RuntimeCommandIdSchema, kind: z.literal("pause") }),
  z.strictObject({ commandId: RuntimeCommandIdSchema, kind: z.literal("resume") }),
  z.strictObject({ commandId: RuntimeCommandIdSchema, kind: z.literal("stop") }),
]);

export const DesktopRequestSchema = z.strictObject({
  payload: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("snapshot") }),
    z.strictObject({ command: CaptureDomainCommandSchema, kind: z.literal("dispatch") }),
  ]),
  protocol: z.union([
    z.literal(ATET_DESKTOP_PROTOCOL),
    z.literal(LEGACY_STUDIO_DESKTOP_PROTOCOL),
  ]),
  protocolVersion: z.literal(ATET_DESKTOP_PROTOCOL_VERSION),
  requestId: RuntimeRequestIdSchema,
});

export const DesktopResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    protocolVersion: z.literal(ATET_DESKTOP_PROTOCOL_VERSION),
    requestId: RuntimeRequestIdSchema,
    snapshot: CaptureRuntimeSnapshotSchema,
  }),
  z.strictObject({
    error: z.strictObject({
      code: z.string().min(1).max(128),
      message: z.string().min(1).max(2048),
      retryable: z.boolean(),
    }),
    ok: z.literal(false),
    protocolVersion: z.literal(ATET_DESKTOP_PROTOCOL_VERSION),
    requestId: RuntimeRequestIdSchema,
  }),
]);

export const DesktopEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("snapshot-changed"),
    protocolVersion: z.literal(ATET_DESKTOP_PROTOCOL_VERSION),
    snapshot: CaptureRuntimeSnapshotSchema,
  }),
  z.strictObject({
    commandId: RuntimeCommandIdSchema,
    kind: z.literal("command-settled"),
    protocolVersion: z.literal(ATET_DESKTOP_PROTOCOL_VERSION),
    status: z.enum(["succeeded", "failed"]),
  }),
]);

export type CaptureRuntimeState = ReadonlyInferred<typeof CaptureRuntimeStateSchema>;
export type CaptureRuntimeSnapshot = ReadonlyInferred<typeof CaptureRuntimeSnapshotSchema>;
export type CaptureStartOptions = ReadonlyInferred<typeof CaptureStartOptionsSchema>;
export type CaptureDomainCommand = ReadonlyInferred<typeof CaptureDomainCommandSchema>;
export type DesktopRequest = ReadonlyInferred<typeof DesktopRequestSchema>;
export type DesktopResponse = ReadonlyInferred<typeof DesktopResponseSchema>;
export type DesktopEvent = ReadonlyInferred<typeof DesktopEventSchema>;
