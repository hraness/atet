import { describe, expect, test } from "bun:test";

import { createApplicationOperationRegistry } from "../application/default-registry";
import {
  DIRECT_WORKFLOW_OPERATION_DISCOVERY,
  createWorkflowEvidence,
} from "./workflow-fixtures";

describe("Atet Direct workflow fixture", () => {
  test("binds its browser-safe discovery snapshot to the production registry", () => {
    const operationKinds = new Set<string>(
      DIRECT_WORKFLOW_OPERATION_DISCOVERY.map(({ kind }) => kind),
    );
    const productionDiscovery = createApplicationOperationRegistry({
      nextAnalysisId: () => "analysis_direct01",
      toolVersion: "atet-direct",
    }).list().filter(({ kind }) => operationKinds.has(kind));

    expect(productionDiscovery).toEqual([...DIRECT_WORKFLOW_OPERATION_DISCOVERY]);
  });

  test("compiles deterministic graph, recovery, and production-shaped durable output evidence", () => {
    const evidence = createWorkflowEvidence();

    expect(evidence.workflowId).toBe("direct-code-mode");
    expect(evidence.waves).toEqual([
      ["project"],
      ["analyze/faces", "analyze/inactivity", "analyze/music"],
      ["curate"],
      ["edits"],
    ]);
    expect(evidence.runs.map(({ summary }) => summary.status)).toEqual([
      "ambiguous-code",
      "completed",
    ]);
    expect(evidence.runs[0]?.summary.counts).toEqual({
      cancelled: 0,
      completed: 4,
      failed: 0,
      pending: 2,
      skipped: 0,
    });
    expect(evidence.durableRun).toMatchObject({
      graphPlanPath:
        "artifacts/atet/private/workflow-runs/run_direct_workflow/graph-plan.json",
      outputsPath:
        "artifacts/atet/private/workflow-runs/run_direct_workflow/outputs.json",
      summaryPath:
        "artifacts/atet/private/workflow-runs/run_direct_workflow/summary.json",
    });
    const completedOutputs = evidence.runs[1]?.summary.outputs;
    if (completedOutputs === undefined) {
      throw new Error("Completed workflow fixture must expose authored outputs.");
    }
    expect(evidence.durableRun.outputsDocument.outputs).toEqual(completedOutputs);
    expect(Object.keys(evidence.durableRun.outputsDocument.nodeOutputDigests).toSorted()).toEqual([
      "curate",
      "edits",
    ]);
  });
});
