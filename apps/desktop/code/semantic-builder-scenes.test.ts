import { describe, expect, test } from "bun:test";

import { createApplicationOperationRegistry } from "../application";
import { WorkflowBuilder } from "./public";

describe("scene analysis semantic workflow helper", () => {
  test("authors one registered local scene-evidence operation", () => {
    const workflow = WorkflowBuilder.create(
      createApplicationOperationRegistry(),
    );
    const project = workflow.project.snapshot(
      "project",
      "project_sceneplan01",
    );
    const scenes = workflow.analysis.scenes("scenes", {
      config: {
        maximumSceneDurationUs: 15_000_000,
        sceneThreshold: 0.4,
      },
      project,
      source: "asset_sceneplan01:stream_sceneplan01",
    });
    const graph = workflow.build({
      id: "scene-evidence",
      inputSchemaId: "test.scene-evidence.input/v1",
      version: 1,
    }, {
      planDigest: scenes.select("planDigest"),
      samples: scenes.select("samples"),
      scenes: scenes.select("scenes"),
    });
    const sceneNode = graph.nodes.find(node => node.key === "scenes");

    expect(sceneNode?.executor).toEqual({
      kind: "operation",
      operation: { kind: "analysis.scenes", version: 1 },
    });
    expect(sceneNode?.dependencies).toEqual(["project"]);
    expect(sceneNode?.input).toMatchObject({
      config: {
        maximumSceneDurationUs: 15_000_000,
        sceneThreshold: 0.4,
      },
      project: {
        $ref: {
          nodeKey: "project",
          path: ["project", "projectId"],
        },
      },
      source: "asset_sceneplan01:stream_sceneplan01",
    });
    expect(sceneNode?.outputSchemaId)
      .toBe("studio.operation.analysis.scenes.output/v1");
    expect(graph.outputs).toMatchObject({
      planDigest: {
        $ref: { nodeKey: "scenes", path: ["planDigest"] },
      },
      samples: {
        $ref: { nodeKey: "scenes", path: ["samples"] },
      },
      scenes: {
        $ref: { nodeKey: "scenes", path: ["scenes"] },
      },
    });
  });
});
