import { z } from "zod";

import { defineWorkflow } from "../code/public";
import {
  renderFrozenProject,
  resolveWorkflowRenderOptions,
  WorkflowRenderOptionsSchema,
} from "./fragments";

export const TalkingHeadCleanupInputSchema = z.strictObject({
  cameraSource: z.string().min(1).max(256),
  project: z.string().regex(/^project_[A-Za-z0-9][A-Za-z0-9_-]*$/u),
  render: WorkflowRenderOptionsSchema.optional(),
});

export const talkingHeadCleanup = defineWorkflow({
  id: "talking-head-cleanup",
  inputSchema: TalkingHeadCleanupInputSchema,
  inputSchemaId: "atet.workflow.talking-head-cleanup.input/v2",
  version: 2,
  build(workflow, input) {
    const project = workflow.project.snapshot("project", input.project);
    const parallel = workflow.namespace("analyze");
    const inactivity = parallel.analysis.inactivity("inactivity", { project });
    const faces = parallel.analysis.faces("faces", {
      project,
      source: input.cameraSource,
    });
    const edits = workflow.edits.batch("remove-long-pauses", {
      cutRanges: inactivity.select("cuts"),
    });
    const committed = workflow.project.commitEdits("commit-cleanup", {
      batch: edits,
      project,
    });
    const rendered = renderFrozenProject(workflow, "render", {
      target: {
        canvas: { kind: "profile", profileId: "landscape" },
        tier: "final",
      },
      output: resolveWorkflowRenderOptions(
        input.render,
        "renders/talking-head-cleanup/final.mp4",
      ),
      project: committed,
    });
    return {
      faces,
      render: rendered.output,
      renderPlan: rendered.plan,
    };
  },
});
