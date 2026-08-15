import { describe, expect, test } from "bun:test";

import { createApplicationOperationRegistry } from "../application";
import {
  ZoomIdSchema,
} from "../contracts";
import { compileGraphPlan } from "./compiler";
import {
  addManualCameraMoves,
  cameraPush,
  cameraReframe,
  manualZoom,
  setMetadataEffects,
  WorkflowBuilder,
} from "./public";
import {
  TESTING_WORKFLOW_BUNDLE,
  TESTING_WORKFLOW_RUNTIME,
} from "./testing";

describe("complete semantic edit transaction", () => {
  test("joins nested analysis references, interaction effects, and manual camera moves in one checked commit", () => {
    const registry = createApplicationOperationRegistry({
      nextAnalysisId: () => "analysis_complete01",
    });
    const workflow = WorkflowBuilder.create(registry);
    const project = workflow.project.snapshot(
      "project",
      "project_complete01",
    );
    const inactivity = workflow.analysis.inactivity("inactivity", { project });
    const autoZooms = workflow.analysis.projectAutoZooms("auto-zooms", {
      project,
    });
    const placementId = "placement_complete01";
    const streamId = "stream_complete001";
    const push = cameraPush({
      cameraMoveId: "camera_pushdemo01",
      placementId,
      projectRange: { endUs: 2_000_000, startUs: 0 },
      streamId,
      to: { centerX: 0.4, centerY: 0.4, zoom: 2 },
    });
    const reframe = cameraReframe({
      cameraMoveId: "camera_reframe01",
      from: { centerX: 0.4, centerY: 0.4, zoom: 2 },
      placementId,
      projectRange: { endUs: 5_000_000, startUs: 2_000_000 },
      streamId,
      to: { centerX: 0.6, centerY: 0.55, zoom: 2 },
    });
    const batch = workflow.edits.completeBatch("complete-edits", {
      cutRanges: inactivity.select("cuts"),
      ordered: [
        {
          kind: "add-zooms",
          zooms: autoZooms.select("operations"),
        },
        setMetadataEffects({
          clicks: {
            color: "#FFCC00",
            durationUs: 500_000,
            enabled: true,
            radiusPx: 32,
            style: "pulse",
          },
          cursor: {
            enabled: true,
            scale: 1.2,
            smoothing: { algorithm: "exponential", strength: 0.5 },
            style: "captured",
          },
          keystrokes: {
            enabled: true,
            holdUs: 1_000_000,
            maxKeys: 8,
            position: "bottom-right",
            secureText: "hide",
          },
          metadataPlacementId: autoZooms.select("sourcePlacementId"),
          typedText: {
            enabled: true,
            idleTimeoutUs: 1_250_000,
            maxCharacters: 256,
            placement: "input",
            secureText: "hide",
          },
        }),
        addManualCameraMoves([push, reframe]),
      ],
    });
    const committed = workflow.project.commitCompleteEdits("commit", {
      batch,
      project,
    });
    const graph = workflow.build({
      id: "complete-edit-transaction",
      inputSchemaId: "test.complete-edit-transaction.input/v1",
      version: 1,
    }, { committed: committed.receipt });
    const plan = compileGraphPlan({
      bundle: TESTING_WORKFLOW_BUNDLE,
      graph,
      registry,
      runtime: TESTING_WORKFLOW_RUNTIME,
      workflowInput: {},
    });

    expect(plan.topologicalWaves).toEqual([
      ["project"],
      ["auto-zooms", "inactivity"],
      ["complete-edits"],
      ["commit"],
    ]);
    const nodes = new Map(plan.graph.nodes.map(node => [node.key, node]));
    const batchNode = nodes.get("complete-edits");
    expect(batchNode?.executor).toEqual({
      kind: "operation",
      operation: { kind: "derive.edit-batch", version: 3 },
    });
    expect(batchNode?.inputSchemaId)
      .toBe("atet.operation.derive.edit-batch.input/v3");
    expect(batchNode?.outputSchemaId)
      .toBe("atet.operation.derive.edit-batch.output/v3");
    expect(batchNode?.dependencies).toEqual([
      "auto-zooms",
      "inactivity",
    ]);
    expect(batchNode?.input).toMatchObject({
      cutRanges: {
        $ref: {
          nodeKey: "inactivity",
          path: ["cuts"],
        },
      },
      ordered: [
        {
          kind: "add-zooms",
          zooms: {
            $ref: {
              nodeKey: "auto-zooms",
              path: ["operations"],
            },
          },
        },
        {
          kind: "set-metadata-effects",
          metadataPlacementId: {
            $ref: {
              nodeKey: "auto-zooms",
              path: ["sourcePlacementId"],
            },
          },
        },
        {
          cameraMoves: [
            {
              cameraMoveId: "camera_pushdemo01",
              keyframes: [
                { projectTimeUs: 0 },
                { projectTimeUs: 2_000_000 },
              ],
            },
            {
              cameraMoveId: "camera_reframe01",
              keyframes: [
                { projectTimeUs: 2_000_000 },
                { projectTimeUs: 5_000_000 },
              ],
            },
          ],
          kind: "add-manual-camera-moves",
        },
      ],
    });
    const commitNode = nodes.get("commit");
    expect(commitNode?.executor).toEqual({
      kind: "operation",
      operation: { kind: "project.commit-edits", version: 3 },
    });
    expect(commitNode?.inputSchemaId)
      .toBe("atet.operation.project.commit-edits.input/v3");
    expect(commitNode?.dependencies).toEqual(["complete-edits", "project"]);
    expect(
      plan.graph.nodes.filter(node => (
        node.executor.kind === "operation"
        && node.executor.operation.kind === "derive.edit-batch"
        && node.executor.operation.version === 3
      )),
    ).toHaveLength(1);
    expect(
      plan.graph.nodes.filter(node => (
        node.executor.kind === "operation"
        && node.executor.operation.kind === "project.commit-edits"
        && node.executor.operation.version === 3
      )),
    ).toHaveLength(1);
  });

  test("offers progressive single-edit helpers without changing the ordinary v1 path", () => {
    const registry = createApplicationOperationRegistry();
    const placementId = "placement_helpers01";
    const streamId = "stream_helpers001";
    const move = cameraPush({
      cameraMoveId: "camera_helpers01",
      placementId,
      projectRange: { endUs: 1_500_000, startUs: 500_000 },
      streamId,
      to: { centerX: 0.5, centerY: 0.5, zoom: 1.5 },
    });
    const helpers = [{
      build: (workflow: WorkflowBuilder) => (
        workflow.edits.setMetadataEffects("edit", {
          clicks: { enabled: false },
          cursor: { enabled: false },
          keystrokes: { enabled: false },
          metadataPlacementId: null,
          typedText: { enabled: false },
        })
      ),
      key: "effects",
    }, {
      build: (workflow: WorkflowBuilder) => (
        workflow.edits.addManualCameraMoves("edit", [move])
      ),
      key: "add-camera",
    }, {
      build: (workflow: WorkflowBuilder) => (
        workflow.edits.removeCameraMoves("edit", [move.cameraMoveId])
      ),
      key: "remove-camera",
    }, {
      build: (workflow: WorkflowBuilder) => (
        workflow.edits.removeZooms(
          "edit",
          [ZoomIdSchema.parse("zoom_helpers001")],
        )
      ),
      key: "remove-zoom",
    }] as const;
    for (const helper of helpers) {
      const workflow = WorkflowBuilder.create(registry);
      const project = workflow.project.snapshot(
        "project",
        "project_helpers01",
      );
      const batch = helper.build(workflow);
      const committed = workflow.project.commitCompleteEdits("commit", {
        batch,
        project,
      });
      const graph = workflow.build({
        id: `progressive-${helper.key}`,
        inputSchemaId: `test.progressive-${helper.key}.input/v1`,
        version: 1,
      }, { committed: committed.receipt });
      expect(graph.nodes.find(node => node.key === "edit")?.executor).toEqual({
        kind: "operation",
        operation: { kind: "derive.edit-batch", version: 3 },
      });
      expect(graph.nodes.find(node => node.key === "commit")?.executor)
        .toEqual({
          kind: "operation",
          operation: { kind: "project.commit-edits", version: 3 },
        });
    }

    const ordinary = WorkflowBuilder.create(registry);
    const ordinaryBatch = ordinary.edits.batch("ordinary", {});
    const ordinaryGraph = ordinary.build({
      id: "ordinary-edit-batch",
      inputSchemaId: "test.ordinary-edit-batch.input/v1",
      version: 1,
    }, { batch: ordinaryBatch });
    expect(ordinaryGraph.nodes[0]?.executor).toEqual({
      kind: "operation",
      operation: { kind: "derive.edit-batch", version: 1 },
    });

    expect(helpers[0]?.build(WorkflowBuilder.create(registry)).serialized)
      .toMatchObject({
        $ref: {
          schemaId: "atet.operation.derive.edit-batch.output/v3",
        },
      });
    expect(() => cameraPush({
      cameraMoveId: "camera_invalid01",
      placementId,
      projectRange: { endUs: 3_000_000, startUs: 2_000_000 },
      streamId,
      to: { centerX: 0.5, centerY: 0.5, zoom: 1 },
    })).toThrow("must increase zoom");
  });

  test("accepts ordinary camera IDs and validates them at the helper boundary", () => {
    const valid = cameraReframe({
      cameraMoveId: "camera_stringids01",
      from: { centerX: 0.5, centerY: 0.5, zoom: 1 },
      placementId: "placement_stringids01",
      projectRange: { endUs: 2_000_000, startUs: 1_000_000 },
      streamId: "stream_stringids001",
      to: { centerX: 0.5, centerY: 0.5, zoom: 2 },
    });
    expect(valid).toMatchObject({
      cameraMoveId: "camera_stringids01",
      placementId: "placement_stringids01",
      streamId: "stream_stringids001",
    });
    expect(() => cameraPush({
      cameraMoveId: "invalid",
      placementId: "placement_stringids01",
      projectRange: { endUs: 2_000_000, startUs: 1_000_000 },
      streamId: "stream_stringids001",
      to: { centerX: 0.5, centerY: 0.5, zoom: 2 },
    })).toThrow();
    expect(() => cameraReframe({
      cameraMoveId: "camera_stringids02",
      from: { centerX: 0.5, centerY: 0.5, zoom: 1 },
      placementId: "invalid",
      projectRange: { endUs: 2_000_000, startUs: 1_000_000 },
      streamId: "stream_stringids001",
      to: { centerX: 0.5, centerY: 0.5, zoom: 2 },
    })).toThrow();
    expect(() => cameraReframe({
      cameraMoveId: "camera_stringids03",
      from: { centerX: 0.5, centerY: 0.5, zoom: 1 },
      placementId: "placement_stringids01",
      projectRange: { endUs: 2_000_000, startUs: 1_000_000 },
      streamId: "invalid",
      to: { centerX: 0.5, centerY: 0.5, zoom: 2 },
    })).toThrow();
  });

  test("authors binding-free manual zoom intent through the stable complete commit", () => {
    const registry = createApplicationOperationRegistry();
    const workflow = WorkflowBuilder.create(registry);
    const project = workflow.project.snapshot(
      "project",
      "project_manualzoom01",
    );
    const zoom = manualZoom({
      range: { endUs: 3_000_000, startUs: 1_000_000 },
      scale: 2,
      target: {
        kind: "point",
        point: { x: 960, y: 540 },
      },
      zoomId: "zoom_semantic01",
    });
    expect(String(zoom.zoomId)).toBe("zoom_semantic01");
    expect(zoom).toMatchObject({
      easing: { kind: "ease-in-out" },
      enterDurationUs: 300_000,
      exitDurationUs: 300_000,
      range: { endUs: 3_000_000, startUs: 1_000_000 },
      scale: 2,
      target: {
        kind: "point",
        point: { x: 960, y: 540 },
      },
    });
    const batch = workflow.edits.addManualZooms("manual-zoom", [zoom]);
    const committed = workflow.project.commitCompleteEdits("commit", {
      batch,
      project,
    });
    const graph = workflow.build({
      id: "manual-zoom-edit",
      inputSchemaId: "test.manual-zoom-edit.input/v1",
      version: 1,
    }, { committed: committed.receipt });
    const nodes = new Map(graph.nodes.map(node => [node.key, node]));
    expect(nodes.get("manual-zoom")?.executor).toEqual({
      kind: "operation",
      operation: { kind: "derive.edit-batch", version: 3 },
    });
    expect(nodes.get("manual-zoom")?.inputSchemaId)
      .toBe("atet.operation.derive.edit-batch.input/v3");
    expect(nodes.get("manual-zoom")?.input).toMatchObject({
      ordered: [{
        kind: "add-manual-zooms",
        zooms: [{
          zoomId: "zoom_semantic01",
        }],
      }],
    });
    expect(nodes.get("commit")?.executor).toEqual({
      kind: "operation",
      operation: { kind: "project.commit-edits", version: 3 },
    });
    expect(nodes.get("commit")?.inputSchemaId)
      .toBe("atet.operation.project.commit-edits.input/v3");
    expect(nodes.get("commit")?.dependencies).toEqual([
      "manual-zoom",
      "project",
    ]);
  });
});
