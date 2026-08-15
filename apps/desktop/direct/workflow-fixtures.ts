import { z } from "zod";

import { deriveProjectEditBatch } from "../application/operations/derive/edit-batch";
import type { OperationDiscovery } from "../application/registry";
import {
  NodeKeySchema,
  OperationKindSchema,
  Sha256Schema,
  WORKFLOW_EFFECT_CLASSES,
} from "../code/contracts";
import {
  defineCompute,
  defineWorkflow,
} from "../code/define-workflow";
import {
  createRunNodeOutputDigest,
  createRunOutputsDigest,
  RUN_OUTPUTS_VERSION,
  RunNodeStatusSchema,
  RunOutputsSchema,
  RunSummarySchema,
} from "../code/run-contracts";
import { compileTestingWorkflow } from "../code/testing";
import { canonicalJson } from "../core/canonical-json";

const WORKFLOW_TIMESTAMP = "2026-07-22T16:00:00.000Z";
const RECOVERY_TIMESTAMP = "2026-07-22T16:00:03.000Z";
const COMPLETED_TIMESTAMP = "2026-07-22T16:00:08.000Z";
const RUN_ID = "run_direct_workflow";
const RUN_PATH = `artifacts/atet/private/workflow-runs/${RUN_ID}`;

/**
 * Browser-safe discovery snapshot for the production operations used by this
 * fixture. A Bun-only parity test binds every field to the live application
 * registry so the Direct browser can compile the real graph contract without
 * importing filesystem-backed operation executors.
 */
export const DIRECT_WORKFLOW_OPERATION_DISCOVERY = [
  {
    inputSchemaId: "studio.operation.analysis.faces.input/v1",
    kind: "analysis.faces",
    lifecycle: "local-artifact",
    outputSchemaId: "studio.operation.analysis.faces.output/v1",
    policy: {
      cache: "none",
      cancellable: true,
      effect: "local-derived-write",
      maxDurationMs: 7_200_000,
      maxFanOut: 1,
      maxInputBytes: 16_384,
      maxOutputBytes: 65_536,
      preparation: ["project-state", "local-media"],
      resources: [
        { amount: 1, resource: "cpu" },
        { amount: 1, resource: "local-io" },
        { amount: 1, resource: "vision" },
      ],
      resume: "verified-receipt",
    },
    version: 1,
  },
  {
    inputSchemaId: "studio.operation.analysis.music.input/v1",
    kind: "analysis.music",
    lifecycle: "local-artifact",
    outputSchemaId: "studio.operation.analysis.music.output/v1",
    policy: {
      cache: "none",
      cancellable: true,
      effect: "local-derived-write",
      maxDurationMs: 7_200_000,
      maxFanOut: 1,
      maxInputBytes: 16_384,
      maxOutputBytes: 65_536,
      preparation: ["project-state", "local-media"],
      resources: [
        { amount: 1, resource: "cpu" },
        { amount: 1, resource: "ffmpeg" },
        { amount: 1, resource: "local-io" },
      ],
      resume: "verified-receipt",
    },
    version: 1,
  },
  {
    inputSchemaId: "studio.operation.analysis.project-inactivity.input/v1",
    kind: "analysis.project-inactivity",
    lifecycle: "local-artifact",
    outputSchemaId: "studio.operation.analysis.project-inactivity.output/v1",
    policy: {
      cache: "none",
      cancellable: true,
      effect: "local-derived-write",
      maxDurationMs: 7_200_000,
      maxFanOut: 1,
      maxInputBytes: 16_384,
      maxOutputBytes: 8_388_608,
      preparation: ["project-state", "recording-metadata", "local-media"],
      resources: [
        { amount: 1, resource: "cpu" },
        { amount: 1, resource: "ffmpeg" },
        { amount: 1, resource: "local-io" },
      ],
      resume: "verified-receipt",
    },
    version: 1,
  },
  {
    inputSchemaId: "studio.operation.derive.edit-batch.input/v1",
    kind: "derive.edit-batch",
    lifecycle: "pure",
    outputSchemaId: "studio.operation.derive.edit-batch.output/v1",
    policy: {
      cache: "content-addressed",
      cancellable: true,
      effect: "pure",
      maxDurationMs: 5_000,
      maxFanOut: 0,
      maxInputBytes: 16_777_216,
      maxOutputBytes: 16_777_216,
      preparation: [],
      resources: [{ amount: 1, resource: "cpu" }],
      resume: "deterministic",
    },
    version: 1,
  },
  {
    inputSchemaId: "studio.operation.derive.edit-batch.input/v2",
    kind: "derive.edit-batch",
    lifecycle: "pure",
    outputSchemaId: "studio.operation.derive.edit-batch.output/v2",
    policy: {
      cache: "content-addressed",
      cancellable: true,
      effect: "pure",
      maxDurationMs: 5_000,
      maxFanOut: 0,
      maxInputBytes: 16_777_216,
      maxOutputBytes: 16_777_216,
      preparation: [],
      resources: [{ amount: 1, resource: "cpu" }],
      resume: "deterministic",
    },
    version: 2,
  },
  {
    inputSchemaId: "studio.operation.derive.edit-batch.input/v3",
    kind: "derive.edit-batch",
    lifecycle: "pure",
    outputSchemaId: "studio.operation.derive.edit-batch.output/v3",
    policy: {
      cache: "content-addressed",
      cancellable: true,
      effect: "pure",
      maxDurationMs: 5_000,
      maxFanOut: 0,
      maxInputBytes: 16_777_216,
      maxOutputBytes: 16_777_216,
      preparation: [],
      resources: [{ amount: 1, resource: "cpu" }],
      resume: "deterministic",
    },
    version: 3,
  },
  {
    inputSchemaId: "studio.operation.project.snapshot.input/v1",
    kind: "project.snapshot",
    lifecycle: "local-artifact",
    outputSchemaId: "studio.operation.project.snapshot.output/v1",
    policy: {
      cache: "none",
      cancellable: true,
      effect: "local-read",
      maxDurationMs: 30_000,
      maxFanOut: 0,
      maxInputBytes: 1_024,
      maxOutputBytes: 67_108_864,
      preparation: ["project-state"],
      resources: [{ amount: 1, resource: "local-io" }],
      resume: "deterministic",
    },
    version: 1,
  },
] as const satisfies readonly OperationDiscovery[];

const EvidenceExecutorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("operation"),
    operation: OperationKindSchema,
  }),
  z.strictObject({
    computeKey: z.string().min(1).max(192),
    kind: z.literal("compute"),
  }),
]);

const WorkflowNodeEvidenceSchema = z.strictObject({
  dependencies: z.array(NodeKeySchema).max(64),
  executor: EvidenceExecutorSchema,
  key: NodeKeySchema,
  label: z.string().min(1).max(160),
});

const WorkflowNodeStateEvidenceSchema = z.strictObject({
  attempt: z.number().int().nonnegative().safe(),
  key: NodeKeySchema,
  status: RunNodeStatusSchema,
});

type WorkflowNodeStateEvidence = z.infer<typeof WorkflowNodeStateEvidenceSchema>;

const WorkflowRunEvidenceSchema = z.strictObject({
  label: z.string().min(1).max(80),
  nodes: z.array(WorkflowNodeStateEvidenceSchema).min(1).max(64),
  summary: RunSummarySchema,
});

export const WorkflowEvidenceSchema = z.strictObject({
  durableRun: z.strictObject({
    graphPlanPath: z.string().min(1).max(512),
    outputsDocument: RunOutputsSchema,
    outputsPath: z.string().min(1).max(512),
    summaryPath: z.string().min(1).max(512),
  }),
  effects: z.array(z.enum(WORKFLOW_EFFECT_CLASSES)).min(1),
  graphPlanSha256: Sha256Schema,
  nodes: z.array(WorkflowNodeEvidenceSchema).min(1).max(64),
  recovery: z.strictObject({
    command: z.string().min(1).max(512),
    failedNode: NodeKeySchema,
    replayScope: z.literal("one-attempt"),
  }),
  runs: z.array(WorkflowRunEvidenceSchema).min(2).max(8),
  waves: z.array(z.array(NodeKeySchema).min(1).max(64)).min(1).max(64),
  workflowId: z.string().min(1).max(128),
});

export type WorkflowEvidence = z.infer<typeof WorkflowEvidenceSchema>;
type WorkflowRunCounts = z.infer<typeof RunSummarySchema>["counts"];

const SelectCutsOutputSchema = z.strictObject({
  cutRanges: z.array(z.strictObject({
    endUs: z.number().int().safe().positive(),
    startUs: z.number().int().safe().nonnegative(),
  })).max(32),
});

const selectCuts = defineCompute({
  inputSchema: z.strictObject({
    faces: z.unknown(),
    inactivity: z.unknown(),
    music: z.unknown(),
  }),
  inputSchemaId: "studio.direct.select-cuts.input/v1",
  key: "direct.select-cuts",
  maxDurationMs: 2_000,
  maxInputBytes: 256 * 1_024,
  maxOutputBytes: 32 * 1_024,
  outputSchema: SelectCutsOutputSchema,
  outputSchemaId: "studio.direct.select-cuts.output/v1",
  run: () => ({
    cutRanges: [{ endUs: 9_000_000, startUs: 4_000_000 }],
  }),
});

const workflowFixture = defineWorkflow({
  build(workflow, input: {
    readonly cameraSource: string;
    readonly musicSource: string;
    readonly project: string;
  }) {
    const project = workflow.project.snapshot("project", input.project, {
      label: "Freeze project snapshot",
    });
    const analyze = workflow.namespace("analyze");
    const faces = analyze.analysis.faces("faces", {
      project,
      source: input.cameraSource,
    }, { label: "Detect faces locally" });
    const inactivity = analyze.analysis.inactivity("inactivity", {
      project,
    }, { label: "Detect long inactivity" });
    const music = analyze.analysis.music("music", {
      project,
      source: input.musicSource,
    }, { label: "Map music structure" });
    const curated = workflow.compute("curate", selectCuts, {
      faces,
      inactivity,
      music,
    }, { label: "Curate candidate cuts in trusted code" });
    const edits = workflow.edits.batch("edits", {
      cutRanges: curated.select("cutRanges"),
    }, { label: "Build reusable edit batch" });
    return { curated, edits };
  },
  id: "direct-code-mode",
  inputSchema: z.strictObject({
    cameraSource: z.string().min(1).max(256),
    musicSource: z.string().min(1).max(256),
    project: z.string().regex(/^project_[A-Za-z0-9][A-Za-z0-9_-]*$/u),
  }),
  inputSchemaId: "studio.direct.code-mode.input/v1",
  version: 1,
});

function nodeStates(
  nodeKeys: readonly string[],
  phase: "ambiguous" | "completed",
): readonly WorkflowNodeStateEvidence[] {
  return nodeKeys.map((key) => {
    if (phase === "ambiguous") {
      if (key === "curate") {
        return { attempt: 1, key, status: "ambiguous-code" };
      }
      if (key === "edits") return { attempt: 0, key, status: "pending" };
    }
    return {
      attempt: key === "curate" && phase === "completed" ? 2 : 1,
      key,
      status: "completed",
    };
  });
}

function countsForNodeEvidence(
  nodes: readonly WorkflowNodeStateEvidence[],
): WorkflowRunCounts {
  return {
    cancelled: nodes.filter(({ status }) => status === "cancelled").length,
    completed: nodes.filter(({ status }) => status === "completed").length,
    failed: nodes.filter(({ status }) => (
      status === "failed"
      || status === "incompatible"
      || status === "ambiguous"
    )).length,
    pending: nodes.filter(({ status }) => (
      status === "pending"
      || status === "ready"
      || status === "preparing"
      || status === "running"
      || status === "approval-required"
      || status === "ambiguous-code"
    )).length,
    skipped: nodes.filter(({ status }) => status === "skipped").length,
  };
}

function parseWorkflowEvidence(input: unknown): WorkflowEvidence {
  const evidence = WorkflowEvidenceSchema.parse(input);
  const nodeKeys = evidence.nodes.map(({ key }) => key);
  const keySet = new Set(nodeKeys);
  if (keySet.size !== nodeKeys.length) {
    throw new Error("Workflow evidence node keys must be unique.");
  }
  for (const wave of evidence.waves) {
    for (const key of wave) {
      if (!keySet.has(key)) {
        throw new Error(`Workflow evidence wave references unknown node ${key}.`);
      }
    }
  }
  const scheduled = evidence.waves.flat();
  if (
    scheduled.length !== nodeKeys.length
    || new Set(scheduled).size !== nodeKeys.length
  ) {
    throw new Error("Workflow evidence waves must schedule every node exactly once.");
  }
  for (const run of evidence.runs) {
    if (
      run.nodes.length !== nodeKeys.length
      || run.nodes.some(({ key }) => !keySet.has(key))
      || new Set(run.nodes.map(({ key }) => key)).size !== nodeKeys.length
    ) {
      throw new Error("Workflow run evidence must contain every planned node exactly once.");
    }
    if (run.summary.graphPlanSha256 !== evidence.graphPlanSha256) {
      throw new Error("Workflow run evidence must bind the exact graph plan.");
    }
    const counts = countsForNodeEvidence(run.nodes);
    if (
      run.summary.counts.cancelled !== counts.cancelled
      || run.summary.counts.completed !== counts.completed
      || run.summary.counts.failed !== counts.failed
      || run.summary.counts.pending !== counts.pending
      || run.summary.counts.skipped !== counts.skipped
    ) {
      throw new Error("Workflow run summary counts must match its node evidence.");
    }
  }
  if (!keySet.has(evidence.recovery.failedNode)) {
    throw new Error("Workflow recovery must identify a planned node.");
  }
  const completedRun = evidence.runs.at(-1);
  const outputsDocument = evidence.durableRun.outputsDocument;
  if (
    completedRun?.summary.status !== "completed"
    || completedRun.summary.outputs === undefined
    || outputsDocument.runId !== completedRun.summary.runId
    || outputsDocument.graphPlanSha256 !== evidence.graphPlanSha256
    || outputsDocument.outputsSha256 !== createRunOutputsDigest(outputsDocument.outputs)
    || canonicalJson(outputsDocument.outputs) !== canonicalJson(completedRun.summary.outputs)
  ) {
    throw new Error("Workflow durable outputs must match the completed run and exact graph plan.");
  }
  return evidence;
}

export function createWorkflowEvidence(): WorkflowEvidence {
  const registry = {
    list: (): readonly OperationDiscovery[] => DIRECT_WORKFLOW_OPERATION_DISCOVERY,
  };
  const plan = compileTestingWorkflow({
    definition: workflowFixture,
    input: {
      cameraSource: "asset_camera_a",
      musicSource: "asset_screen",
      project: "project_direct01",
    },
    registry,
  });
  const nodeKeys = plan.graph.nodes.map(({ key }) => key);
  const ambiguousNodes = nodeStates(nodeKeys, "ambiguous");
  const completedNodes = nodeStates(nodeKeys, "completed");
  const curatedOutput = SelectCutsOutputSchema.parse({
    cutRanges: [{ endUs: 9_000_000, startUs: 4_000_000 }],
  });
  const editsOutput = deriveProjectEditBatch(
    curatedOutput.cutRanges.map(range => ({ kind: "cut", range })),
  );
  const completedOutputs = {
    curated: curatedOutput,
    edits: editsOutput,
  };
  const outputsDocument = RunOutputsSchema.parse({
    graphPlanSha256: plan.graphPlanSha256,
    nodeOutputDigests: {
      curate: createRunNodeOutputDigest(curatedOutput),
      edits: createRunNodeOutputDigest(editsOutput),
    },
    outputs: completedOutputs,
    outputsSha256: createRunOutputsDigest(completedOutputs),
    runId: RUN_ID,
    version: RUN_OUTPUTS_VERSION,
  });
  return parseWorkflowEvidence({
    durableRun: {
      graphPlanPath: `${RUN_PATH}/graph-plan.json`,
      outputsDocument,
      outputsPath: `${RUN_PATH}/outputs.json`,
      summaryPath: `${RUN_PATH}/summary.json`,
    },
    effects: plan.envelope.effects,
    graphPlanSha256: plan.graphPlanSha256,
    nodes: plan.graph.nodes.map(node => ({
      dependencies: node.dependencies,
      executor: node.executor.kind === "operation"
        ? {
            kind: "operation",
            operation: node.executor.operation.kind,
          }
        : {
            computeKey: node.executor.compute.key,
            kind: "compute",
          },
      key: node.key,
      label: node.label ?? node.key,
    })),
    recovery: {
      command: "atet runs resume run_direct_workflow --replay-ambiguous-code curate",
      failedNode: "curate",
      replayScope: "one-attempt",
    },
    runs: [
      {
        label: "Interrupted after trusted-code dispatch",
        nodes: ambiguousNodes,
        summary: {
          counts: countsForNodeEvidence(ambiguousNodes),
          graphPlanSha256: plan.graphPlanSha256,
          runId: RUN_ID,
          startedAt: WORKFLOW_TIMESTAMP,
          status: "ambiguous-code",
          updatedAt: RECOVERY_TIMESTAMP,
          version: "atet-run-store-v2",
        },
      },
      {
        label: "Exact-node replay completed",
        nodes: completedNodes,
        summary: {
          counts: countsForNodeEvidence(completedNodes),
          finishedAt: COMPLETED_TIMESTAMP,
          graphPlanSha256: plan.graphPlanSha256,
          outputs: completedOutputs,
          runId: RUN_ID,
          startedAt: WORKFLOW_TIMESTAMP,
          status: "completed",
          updatedAt: COMPLETED_TIMESTAMP,
          version: "atet-run-store-v2",
        },
      },
    ],
    waves: plan.topologicalWaves,
    workflowId: plan.graph.workflow.id,
  });
}
