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

export const RecordingResumeInputSchema = EmptyRecordingOperationInputSchema;
export const RecordingResumeOutputSchema = RecordingOperationOutputSchema;
export type RecordingResumeInput = EmptyRecordingOperationInput;
export type RecordingResumeOutput = RecordingOperationOutput;

export const recordingResumeOperationDefinition: OperationDefinition<
  "recording.resume",
  RecordingResumeInput,
  RecordingResumeOutput
> = {
  inputSchema: RecordingResumeInputSchema,
  inputSchemaId: "studio.operation.recording.resume.input/v1",
  kind: "recording.resume",
  lifecycle: {
    kind: "live-control",
    execute: async context => await executeRecordingControl(context, "resume"),
  },
  outputSchema: RecordingResumeOutputSchema,
  outputSchemaId: "studio.operation.recording.resume.output/v1",
  policy: recordingTransitionPolicy,
  summarize: output => summarizeRecordingControl("recording.resume", output),
  version: 1,
};
