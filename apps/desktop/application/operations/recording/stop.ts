import type { OperationDefinition } from "../../operation";
import {
  EmptyRecordingOperationInputSchema,
  type EmptyRecordingOperationInput,
  executeRecordingControl,
  RecordingOperationOutputSchema,
  type RecordingOperationOutput,
  recordingTransitionPolicy,
  summarizeRecordingControl,
} from "./shared";

export const RecordingStopInputSchema = EmptyRecordingOperationInputSchema;
export const RecordingStopOutputSchema = RecordingOperationOutputSchema;
export type RecordingStopInput = EmptyRecordingOperationInput;
export type RecordingStopOutput = RecordingOperationOutput;

export const recordingStopOperationDefinition: OperationDefinition<
  "recording.stop",
  RecordingStopInput,
  RecordingStopOutput
> = {
  inputSchema: RecordingStopInputSchema,
  inputSchemaId: "studio.operation.recording.stop.input/v1",
  kind: "recording.stop",
  lifecycle: {
    kind: "live-control",
    execute: async context => await executeRecordingControl(context, "stop"),
  },
  outputSchema: RecordingStopOutputSchema,
  outputSchemaId: "studio.operation.recording.stop.output/v1",
  policy: recordingTransitionPolicy,
  summarize: output => summarizeRecordingControl("recording.stop", output),
  version: 1,
};
