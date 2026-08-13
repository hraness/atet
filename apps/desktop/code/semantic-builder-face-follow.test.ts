import { describe, expect, test } from "bun:test";

import { createApplicationOperationRegistry } from "../application";
import {
  AnalysisIdSchema,
  ProjectPlacementIdSchema,
} from "../contracts";
import { WorkflowBuilder } from "./semantic-builder";

describe("semantic face-follow revision authoring", () => {
  test("expands common aspects into parallel derivations and immutable publications", () => {
    const workflow = WorkflowBuilder.create(
      createApplicationOperationRegistry({
        nextAnalysisId: () => "analysis_builderfaces1",
      }),
    );
    const project = workflow.project.snapshot("project", "project_builderfaces1");
    const faces = workflow.analysis.faces("faces", {
      analysisId: AnalysisIdSchema.parse("analysis_builderfaces1"),
      project,
      source: "asset_builder01:stream_builder01",
    });
    const drafts = workflow.edits.followFacesVariants("derive-faces", {
      analysisId: faces.select("analysisId"),
      placementId: ProjectPlacementIdSchema.parse("placement_builder01"),
      project,
      projectRange: { endUs: 5_000_000, startUs: 0 },
    });
    const revisions = workflow.project.createRevisionVariants(
      "publish-revisions",
      { drafts, project },
    );
    const graph = workflow.build({
      id: "face-follow-variants",
      inputSchemaId: "test.face-follow-variants.input/v1",
      version: 1,
    }, {
      revisions: {
        landscape: revisions.landscape.revision,
        portrait: revisions.portrait.revision,
        square: revisions.square.revision,
      },
    });

    expect(graph.nodes.map(node => node.key)).toEqual([
      "derive-faces/landscape",
      "derive-faces/portrait",
      "derive-faces/square",
      "faces",
      "project",
      "publish-revisions/landscape",
      "publish-revisions/portrait",
      "publish-revisions/square",
    ]);
    expect(
      graph.nodes.find(node => node.key === "derive-faces/landscape")
        ?.dependencies,
    ).toEqual(["faces", "project"]);
    expect(
      graph.nodes.find(node => node.key === "publish-revisions/landscape")
        ?.dependencies,
    ).toEqual(["derive-faces/landscape", "project"]);
    expect(
      graph.nodes.find(node => node.key === "derive-faces/landscape")?.input,
    ).toMatchObject({ aspect: "16:9" });
    expect(
      graph.nodes.find(node => node.key === "derive-faces/square")?.input,
    ).toMatchObject({ aspect: "1:1" });
    expect(
      graph.nodes.find(node => node.key === "derive-faces/portrait")?.input,
    ).toMatchObject({ aspect: "9:16" });
  });
});
