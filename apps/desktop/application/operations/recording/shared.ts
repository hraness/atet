import { z } from "zod";

import {
  CapturePermissionsSchema,
  IsoTimestampSchema,
  MicrosecondsSchema,
  RecordingIdSchema,
} from "../../../contracts";
import type {
  ApplicationContext,
  ApplicationRecordingController,
} from "../../context";
import { ApplicationError } from "../../errors";
import type {
  BoundedOperationSummary,
  OperationExecutionContext,
  OperationKind,
  OperationPolicy,
} from "../../operation";
import { throwIfAborted } from "../shared";

export const MAX_RECORDING_OPERATION_DISPLAYS = 16;

const DisplayIdSchema = z.string().min(1).max(64);
const DeviceIdSchema = z.string().min(1).max(256);

const ExplicitDisplayIdsSchema = z.array(DisplayIdSchema)
  .min(1)
  .max(MAX_RECORDING_OPERATION_DISPLAYS)
  .superRefine((displayIds, context) => {
    if (new Set(displayIds).size !== displayIds.length) {
      context.addIssue({
        code: "custom",
        message: "Explicit recording display IDs must be unique.",
      });
    }
  });

export const RecordingDisplaySelectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("all"),
  }),
  z.strictObject({
    displayIds: ExplicitDisplayIdsSchema,
    kind: z.literal("selected"),
  }),
]);

export const RecordingDeviceSelectionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("disabled") }),
  z.strictObject({ kind: z.literal("default") }),
  z.strictObject({ deviceId: DeviceIdSchema, kind: z.literal("device") }),
]);

const RecordingStartFields = {
  camera: RecordingDeviceSelectionSchema,
  displays: RecordingDisplaySelectionSchema,
  microphone: RecordingDeviceSelectionSchema,
  strictInputs: z.boolean(),
  systemAudio: z.boolean(),
  typedText: z.boolean(),
} as const;

export const RecordingStartInputSchema = z.strictObject(
  RecordingStartFields,
);

export const EffectiveRecordingConfigSchema = z.strictObject({
  ...RecordingStartFields,
  metadata: z.literal(true),
});

const RecordingOperationOutputFields = {
  completedSegmentCount: z.number().int().safe().nonnegative(),
  effectiveConfig: EffectiveRecordingConfigSchema.nullable(),
  logicalTimeUs: MicrosecondsSchema,
  permissions: CapturePermissionsSchema.nullable(),
  recordingId: RecordingIdSchema.nullable(),
  state: z.enum(["idle", "recording", "paused"]),
  updatedAt: IsoTimestampSchema.max(64),
} as const;

export const RecordingOperationOutputSchema = z.strictObject(
  RecordingOperationOutputFields,
);

const ControllerRecordingSnapshotSchema = z.strictObject({
  ...RecordingOperationOutputFields,
  recordingRoot: z.string().min(1).max(4_096).nullable(),
});

export const EmptyRecordingOperationInputSchema = z.strictObject({});

export type RecordingStartInput = z.infer<typeof RecordingStartInputSchema>;
export type RecordingOperationOutput = z.infer<
  typeof RecordingOperationOutputSchema
>;
export type EmptyRecordingOperationInput = z.infer<
  typeof EmptyRecordingOperationInputSchema
>;

export const recordingStartPolicy = {
  cache: "none",
  cancellable: false,
  effect: "live-control",
  maxDurationMs: 5 * 60_000,
  maxFanOut: 0,
  maxInputBytes: 32 * 1_024,
  maxOutputBytes: 64 * 1_024,
  preparation: [
    "recording-metadata",
    "screen-capture",
    "camera",
    "microphone",
    "system-audio",
    "typed-text",
    "window-metadata",
  ],
  resources: [{ amount: 1, resource: "capture-device" }],
  resume: "non-resumable-live",
} as const satisfies OperationPolicy;

export const recordingTransitionPolicy = {
  cache: "none",
  cancellable: false,
  effect: "live-control",
  maxDurationMs: 5 * 60_000,
  maxFanOut: 0,
  maxInputBytes: 64,
  maxOutputBytes: 64 * 1_024,
  preparation: [],
  resources: [{ amount: 1, resource: "capture-device" }],
  resume: "non-resumable-live",
} as const satisfies OperationPolicy;

function requireRecordingController(
  application: ApplicationContext,
): ApplicationRecordingController {
  const controller = application.recordingController;
  if (controller === undefined) {
    throw new ApplicationError(
      "unavailable",
      "Recording controller is unavailable.",
    );
  }
  return controller;
}

export function parseRecordingOperationOutput(
  value: unknown,
): RecordingOperationOutput {
  const parsed = ControllerRecordingSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw new ApplicationError(
      "invalid-data",
      "Recording controller returned an invalid bounded snapshot.",
    );
  }
  const snapshot = parsed.data;
  return RecordingOperationOutputSchema.parse({
    completedSegmentCount: snapshot.completedSegmentCount,
    effectiveConfig: snapshot.effectiveConfig,
    logicalTimeUs: snapshot.logicalTimeUs,
    permissions: snapshot.permissions,
    recordingId: snapshot.recordingId,
    state: snapshot.state,
    updatedAt: snapshot.updatedAt,
  });
}

export async function executeRecordingControl(
  context: OperationExecutionContext,
  action: "pause" | "resume" | "start" | "stop",
  options?: RecordingStartInput,
): Promise<RecordingOperationOutput> {
  throwIfAborted(context.abortSignal);
  const controller = requireRecordingController(context.application);
  await context.workflow?.beforePublication();
  const snapshot = options === undefined
    ? await controller.execute(action)
    : await controller.execute(action, options);
  return parseRecordingOperationOutput(snapshot);
}

export function summarizeRecordingControl(
  kind: Extract<OperationKind, `recording.${string}`>,
  output: RecordingOperationOutput,
): BoundedOperationSummary {
  return {
    fields: {
      completedSegmentCount: output.completedSegmentCount,
      logicalTimeUs: output.logicalTimeUs,
      recordingId: output.recordingId,
      state: output.state,
      updatedAt: output.updatedAt,
    },
    kind,
  };
}
