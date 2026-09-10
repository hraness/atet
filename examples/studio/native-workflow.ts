import { defineWorkflow, StudioRunInputSchema } from "@hraness/slopcamera/local/code";

// Input retains the bundle manifest returned by `studio bundle` and its exact job.
// Runtime selection and --allow-trusted-code belong to the CLI invocation.
export default defineWorkflow({
  id: "native-studio-shot",
  version: 1,
  inputSchemaId: "native-studio-shot-input-v1",
  inputSchema: StudioRunInputSchema,
  build(workflow, input) {
    const shot = workflow.studio.run("produce-shot", input);
    return { shot };
  },
});
