import { z } from "zod";

import { defineWorkflow } from "../code/public";
import {
  prepareAndCommitOverlays,
  renderFrozenProject,
  resolveWorkflowRenderOptions,
  WorkflowRenderOptionsSchema,
  WorkflowOverlaySetSchema,
} from "./fragments";

export const ChapteredDemoInputSchema = z.strictObject({
  overlays: WorkflowOverlaySetSchema.optional(),
  project: z.string().regex(/^project_[A-Za-z0-9][A-Za-z0-9_-]*$/u),
  render: WorkflowRenderOptionsSchema.optional(),
});

export const chapteredDemo = defineWorkflow({
  id: "chaptered-demo",
  inputSchema: ChapteredDemoInputSchema,
  inputSchemaId: "studio.workflow.chaptered-demo.input/v3",
  version: 3,
  build(workflow, input) {
    const snapshot = workflow.project.snapshot("project", input.project);
    const composition = input.overlays === undefined
      ? { prepared: [], project: snapshot }
      : prepareAndCommitOverlays(workflow, "overlays", {
          overlays: input.overlays,
          project: snapshot,
        });
    const rendered = renderFrozenProject(workflow, "render", {
      target: {
        canvas: { kind: "profile", profileId: "landscape" },
        tier: "final",
      },
      output: resolveWorkflowRenderOptions(
        input.render,
        "renders/chaptered-demo/final.mp4",
      ),
      project: composition.project,
    });
    return {
      overlayReceipts: composition.prepared.map(overlay => overlay.receipt),
      render: rendered.output,
      renderPlan: rendered.plan,
    };
  },
});
