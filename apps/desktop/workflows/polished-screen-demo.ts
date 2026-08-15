import { z } from "zod";

import {
  defineWorkflow,
  polishedInteractionEffects,
} from "../code/public";
import {
  FaceFollowRequestOptionsSchema,
} from "../application/operations";
import { resolveProjectExportProfile } from "../contracts";
import {
  resolveWorkflowRenderOptions,
  WorkflowRenderOptionsSchema,
} from "./fragments";

export const PolishedScreenDemoInputSchema = z.strictObject({
  cameraSource: z.string().min(1).max(256),
  faceFollow: FaceFollowRequestOptionsSchema,
  musicSource: z.string().min(1).max(256),
  project: z.string().regex(/^project_[A-Za-z0-9][A-Za-z0-9_-]*$/u),
  render: WorkflowRenderOptionsSchema.optional(),
});

export const polishedScreenDemo = defineWorkflow({
  id: "polished-screen-demo",
  inputSchema: PolishedScreenDemoInputSchema,
  inputSchemaId: "atet.workflow.polished-screen-demo.input/v4",
  version: 4,
  build(workflow, input) {
    const project = workflow.project.snapshot("project", input.project);
    const parallel = workflow.namespace("analyze");
    const inactivity = parallel.analysis.inactivity("inactivity", { project });
    const autoZooms = parallel.analysis.projectAutoZooms("auto-zooms", {
      project,
    });
    const faces = parallel.analysis.faces("faces", {
      project,
      source: input.cameraSource,
    });
    const music = parallel.analysis.music("music", {
      project,
      source: input.musicSource,
    });
    const edits = workflow.advanced.edits.completeBatchV2(
      "editorial-decisions",
      {
      cutRanges: inactivity.select("cuts"),
      ordered: [
        {
          kind: "add-zooms",
          zooms: autoZooms.select("operations"),
        },
        polishedInteractionEffects(autoZooms.select("sourcePlacementId")),
      ],
      },
    );
    const committed = workflow.advanced.project.commitCompleteEditsV2(
      "commit-base-edits",
      {
        batch: edits,
        project,
      },
      {
        // The analyses publish append-only project references. Make their
        // completion causally precede the mutable edit commit so its receipt is
        // the exact post-analysis generation used by face framing.
        after: [faces, music],
      },
    );
    const selection = input.faceFollow.selection ?? { kind: "largest" as const };
    const faceFraming = workflow.edits.followFaces("face-framing", {
      analysisId: faces.select("analysisId"),
      aspect: "16:9",
      easing: input.faceFollow.easing ?? { kind: "ease-in-out" },
      framing: input.faceFollow.framing
        ?? (selection.kind === "all" ? "group" : "medium"),
      gapPolicy: input.faceFollow.gapPolicy ?? "hold",
      headroom: input.faceFollow.headroom ?? 0.08,
      maximumZoom: input.faceFollow.maximumZoom ?? 4,
      minimumZoom: input.faceFollow.minimumZoom ?? 1,
      placementId: input.faceFollow.placementId,
      project: committed,
      projectRange: input.faceFollow.projectRange,
      requireAllSelectedFaces:
        input.faceFollow.requireAllSelectedFaces ?? false,
      selection,
      smoothingSeconds: input.faceFollow.smoothingSeconds ?? 0.25,
    });
    const render = workflow.namespace("render");
    const revision = render.project.createRevision("revision", {
      draft: faceFraming,
      project: committed,
    });
    const renderProfile = resolveProjectExportProfile("landscape", "final");
    const renderPlan = render.render.plan("plan", {
      revision,
      settings: { frameRate: renderProfile.frameRate },
    });
    const output = resolveWorkflowRenderOptions(
      input.render,
      "renders/polished-screen-demo/final.mp4",
    );
    const rendered = render.render.project("output", {
      target: {
        canvas: { kind: "profile", profileId: "landscape" },
        tier: "final",
      },
      output: {
        maximumBytes: output.maximumBytes,
        path: output.output,
      },
      plan: renderPlan,
      syncPolicy: output.syncPolicy,
    });
    return {
      autoZooms,
      faceFollow: {
        cameraMoveId: faceFraming.select("cameraMove").select("cameraMoveId"),
        revision: revision.revision,
        selectedTrackIds: faceFraming.select("selectedTrackIds"),
      },
      faces,
      music,
      render: rendered,
      renderPlan,
    };
  },
});
