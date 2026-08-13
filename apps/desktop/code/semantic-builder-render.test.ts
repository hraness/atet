import { describe, expect, test } from "bun:test";

import { createApplicationOperationRegistry } from "../application";
import {
  AnalysisIdSchema,
  ProjectPlacementIdSchema,
} from "../contracts";
import { WorkflowBuilder } from "./semantic-builder";

describe("semantic immutable render authoring", () => {
  test("threads revision to exact plan to render without a mutable project pointer", () => {
    const workflow = WorkflowBuilder.create(
      createApplicationOperationRegistry({
        nextAnalysisId: () => "analysis_renderbuilder1",
      }),
    );
    const project = workflow.project.snapshot(
      "project",
      "project_renderbuilder1",
    );
    const faces = workflow.analysis.faces("faces", {
      analysisId: AnalysisIdSchema.parse("analysis_renderbuilder1"),
      project,
      source: "asset_render01:stream_render01",
    });
    const draft = workflow.edits.followFaces("camera", {
      analysisId: faces.select("analysisId"),
      aspect: "9:16",
      placementId: ProjectPlacementIdSchema.parse("placement_render01"),
      project,
      projectRange: { endUs: 5_000_000, startUs: 0 },
    });
    const revision = workflow.project.createRevision("revision", {
      draft,
      project,
    });
    const plan = workflow.render.plan("plan", {
      revision,
      settings: { frameRate: 30 },
    });
    const rendered = workflow.render.project("render", {
      output: {
        maximumBytes: 512 * 1024 * 1024,
        path: "renders/social/vertical.mp4",
      },
      plan,
      syncPolicy: "require-verified",
    });
    const graph = workflow.build({
      id: "immutable-render",
      inputSchemaId: "test.immutable-render.input/v1",
      version: 1,
    }, { rendered });

    expect(graph.nodes.map(node => node.key)).toEqual([
      "camera",
      "faces",
      "plan",
      "project",
      "render",
      "revision",
    ]);
    expect(graph.nodes.find(node => node.key === "plan")?.dependencies)
      .toEqual(["revision"]);
    expect(graph.nodes.find(node => node.key === "render")?.dependencies)
      .toEqual(["plan"]);
    expect(graph.nodes.find(node => node.key === "plan")?.input)
      .not.toHaveProperty("project");
    expect(graph.nodes.find(node => node.key === "render")?.input)
      .not.toHaveProperty("binding");
    expect(graph.nodes.find(node => node.key === "render")?.input)
      .toMatchObject({
        output: {
          maximumBytes: 512 * 1024 * 1024,
          path: "renders/social/vertical.mp4",
        },
        syncPolicy: "require-verified",
      });
  });
});
