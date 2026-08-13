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

export const RecordingPauseInputSchema = EmptyRecordingOperationInputSchema;
export const RecordingPauseOutputSchema = RecordingOperationOutputSchema;
export type RecordingPauseInput = EmptyRecordingOperationInput;
export type RecordingPauseOutput = RecordingOperationOutput;

export const recordingPauseOperationDefinition: OperationDefinition<
  "recording.pause",
  RecordingPauseInput,
  RecordingPauseOutput
> = {
  inputSchema: RecordingPauseInputSchema,
  inputSchemaId: "studio.operation.recording.pause.input/v1",
  kind: "recording.pause",
  lifecycle: {
    kind: "live-control",
    execute: async context => await executeRecordingControl(context, "pause"),
  },
  outputSchema: RecordingPauseOutputSchema,
  outputSchemaId: "studio.operation.recording.pause.output/v1",
  policy: recordingTransitionPolicy,
  summarize: output => summarizeRecordingControl("recording.pause", output),
  version: 1,
};
