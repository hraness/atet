import { z } from "zod";

import {
  CapturePermissionsSchema,
  IsoTimestampSchema,
  MicrosecondsSchema,
  RecordingIdSchema,
} from "../../../contracts";
import type { OperationDefinition } from "../../operation";
import {
  executeRecordingControl,
  MAX_RECORDING_OPERATION_DISPLAYS,
  RecordingOperationOutputSchema,
  type RecordingOperationOutput,
  RecordingStartInputSchema,
  type RecordingStartInput,
  recordingStartPolicy,
  summarizeRecordingControl,
} from "./shared";

export const RecordingStartOutputSchema = RecordingOperationOutputSchema;
export type RecordingStartOutput = RecordingOperationOutput;

const RecordingDisplaySelectionV1Schema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("all-current") }),
  z.strictObject({
    displayIds: z.array(z.string().min(1).max(256))
      .min(1)
      .max(MAX_RECORDING_OPERATION_DISPLAYS)
      .superRefine((displayIds, context) => {
        if (new Set(displayIds).size !== displayIds.length) {
          context.addIssue({
            code: "custom",
            message: "Explicit recording display IDs must be unique.",
          });
        }
      }),
    kind: z.literal("explicit"),
  }),
]);

export const RecordingStartInputV1Schema = z.strictObject({
  displaySelection: RecordingDisplaySelectionV1Schema,
  microphone: z.boolean(),
  strictInputs: z.boolean(),
  systemAudio: z.boolean(),
  typedText: z.boolean(),
  webcam: z.boolean(),
});

const EffectiveRecordingConfigV1Schema = z.strictObject({
  ...RecordingStartInputV1Schema.shape,
  metadata: z.literal(true),
});

export const RecordingStartOutputV1Schema = z.strictObject({
  completedSegmentCount: z.number().int().safe().nonnegative(),
  effectiveConfig: EffectiveRecordingConfigV1Schema.nullable(),
  logicalTimeUs: MicrosecondsSchema,
  permissions: CapturePermissionsSchema.nullable(),
  recordingId: RecordingIdSchema.nullable(),
  state: z.enum(["idle", "recording", "paused"]),
  updatedAt: IsoTimestampSchema.max(64),
});

export type RecordingStartInputV1 = z.infer<
  typeof RecordingStartInputV1Schema
>;
export type RecordingStartOutputV1 = z.infer<
  typeof RecordingStartOutputV1Schema
>;

function upgradeRecordingStartInput(
  input: RecordingStartInputV1,
): RecordingStartInput {
  return RecordingStartInputSchema.parse({
    camera: { kind: input.webcam ? "default" : "disabled" },
    displays: input.displaySelection.kind === "all-current"
      ? { kind: "all" }
      : {
          displayIds: input.displaySelection.displayIds,
          kind: "selected",
        },
    microphone: { kind: input.microphone ? "default" : "disabled" },
    strictInputs: input.strictInputs,
    systemAudio: input.systemAudio,
    typedText: input.typedText,
  });
}

function downgradeRecordingStartOutput(
  output: RecordingStartOutput,
): RecordingStartOutputV1 {
  const effectiveConfig = output.effectiveConfig === null
    ? null
    : {
        displaySelection: output.effectiveConfig.displays.kind === "all"
          ? { kind: "all-current" as const }
          : {
              displayIds: output.effectiveConfig.displays.displayIds,
              kind: "explicit" as const,
            },
        metadata: true as const,
        microphone: output.effectiveConfig.microphone.kind !== "disabled",
        strictInputs: output.effectiveConfig.strictInputs,
        systemAudio: output.effectiveConfig.systemAudio,
        typedText: output.effectiveConfig.typedText,
        webcam: output.effectiveConfig.camera.kind !== "disabled",
      };
  return RecordingStartOutputV1Schema.parse({
    ...output,
    effectiveConfig,
  });
}

export const recordingStartOperationDefinitionV1: OperationDefinition<
  "recording.start",
  RecordingStartInputV1,
  RecordingStartOutputV1
> = {
  inputSchema: RecordingStartInputV1Schema,
  inputSchemaId: "studio.operation.recording.start.input/v1",
  kind: "recording.start",
  lifecycle: {
    kind: "live-control",
    execute: async (context, input) => downgradeRecordingStartOutput(
      await executeRecordingControl(
        context,
        "start",
        upgradeRecordingStartInput(input),
      ),
    ),
  },
  outputSchema: RecordingStartOutputV1Schema,
  outputSchemaId: "studio.operation.recording.start.output/v1",
  policy: recordingStartPolicy,
  summarize: output => ({
    fields: {
      completedSegmentCount: output.completedSegmentCount,
      logicalTimeUs: output.logicalTimeUs,
      recordingId: output.recordingId,
      state: output.state,
      updatedAt: output.updatedAt,
    },
    kind: "recording.start",
  }),
  version: 1,
};

export const recordingStartOperationDefinition: OperationDefinition<
  "recording.start",
  RecordingStartInput,
  RecordingStartOutput
> = {
  inputSchema: RecordingStartInputSchema,
  inputSchemaId: "studio.operation.recording.start.input/v2",
  kind: "recording.start",
  lifecycle: {
    kind: "live-control",
    execute: async (context, input) => (
      await executeRecordingControl(context, "start", input)
    ),
  },
  outputSchema: RecordingStartOutputSchema,
  outputSchemaId: "studio.operation.recording.start.output/v2",
  policy: recordingStartPolicy,
  summarize: output => summarizeRecordingControl("recording.start", output),
  version: 2,
};
