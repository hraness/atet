import { z } from "zod";

import { OPERATION_KINDS } from "../application/operation";
import {
  canonicalJsonFingerprint,
  type CanonicalJsonFingerprint,
} from "../core/canonical-json";
import {
  AuthoredOperationIdentitySchema,
  AuthoredComputeIdentitySchema,
  AuthoredNodeExecutorSchema,
  GraphPlanV1Schema,
  JsonValueSchema,
  NodeKeySchema,
  OperationPolicySchema,
  WorkflowNodePolicySchema,
  PositiveSafeIntegerSchema,
  Sha256Schema,
  WorkflowBundleIdentitySchema,
  WorkflowIdentitySchema,
  WorkflowRuntimeIdentitySchema,
  type JsonValue,
} from "./contracts";

export const RUN_STORE_VERSION = "atet-run-store-v2" as const;
export const RUN_NODE_VERSION = "atet-run-node-v2" as const;
export const NODE_PREPARATION_PLAN_VERSION = "atet-node-preparation-plan-v2" as const;
export const NODE_EXECUTION_PLAN_VERSION = "atet-node-execution-plan-v2" as const;
export const RUN_EVENT_VERSION = "atet-run-event-v2" as const;
export const RUN_GRANT_VERSION = "atet-run-grant-v2" as const;
export const RUN_FENCE_VERSION = "atet-run-fence-v2" as const;
export const RUN_OUTPUTS_VERSION = "atet-run-outputs-v2" as const;
const LEGACY_RUN_STORE_VERSION = "transmute-run-store-v2" as const;
const LEGACY_RUN_NODE_VERSION = "transmute-run-node-v2" as const;
const LEGACY_NODE_PREPARATION_PLAN_VERSION = "transmute-node-preparation-plan-v2" as const;
const LEGACY_NODE_EXECUTION_PLAN_VERSION = "transmute-node-execution-plan-v2" as const;
const LEGACY_RUN_EVENT_VERSION = "transmute-run-event-v2" as const;
const LEGACY_RUN_GRANT_VERSION = "transmute-run-grant-v2" as const;
const LEGACY_RUN_FENCE_VERSION = "transmute-run-fence-v2" as const;
const LEGACY_RUN_OUTPUTS_VERSION = "transmute-run-outputs-v2" as const;

export const NODE_PREPARATION_PLAN_HASH_DOMAIN =
  "studio.workflow.node-preparation-plan/v2" as const;
export const NODE_EXECUTION_PLAN_HASH_DOMAIN =
  "studio.workflow.node-execution-plan/v2" as const;
export const NODE_INPUT_HASH_DOMAIN = "studio.workflow.node-input/v1" as const;
export const NODE_OUTPUT_HASH_DOMAIN = "studio.workflow.node-output/v1" as const;
export const RUN_OUTPUTS_HASH_DOMAIN = "studio.workflow.run-outputs/v1" as const;

const RunIdSchema = z.string().regex(/^run_[a-z0-9][a-z0-9_-]{5,95}$/u);
const TimestampSchema = z.string().datetime({ offset: true });
const OwnerSchema = z.string().min(1).max(256);
const FenceTokenSchema = z.string().uuid();
const BoundedMessageSchema = z.string().min(1).max(4_000);

export const RunStatusSchema = z.enum([
  "planned",
  "running",
  "approval-required",
  "ambiguous-code",
  "completed",
  "partial",
  "failed",
  "cancelled",
  "incompatible",
]);

export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunNodeStatusSchema = z.enum([
  "pending",
  "ready",
  "preparing",
  "approval-required",
  "running",
  "completed",
  "failed",
  "skipped",
  "cancelled",
  "ambiguous-code",
  "ambiguous",
  "incompatible",
]);

export const RunFenceSchema = z.strictObject({
  acquiredAt: TimestampSchema,
  generation: PositiveSafeIntegerSchema,
  hostname: z.string().min(1).max(255),
  owner: OwnerSchema,
  pid: PositiveSafeIntegerSchema,
  runId: RunIdSchema,
  token: FenceTokenSchema,
  version: z.union([z.literal(RUN_FENCE_VERSION), z.literal(LEGACY_RUN_FENCE_VERSION)]),
});

export type RunFence = z.infer<typeof RunFenceSchema>;

export const RunWorkflowRecordSchema = z.strictObject({
  bundle: WorkflowBundleIdentitySchema,
  sourceLocator: z.string().min(1).max(2_048),
  workflow: WorkflowIdentitySchema,
});

export type RunWorkflowRecord = z.infer<typeof RunWorkflowRecordSchema>;

export const RunRuntimeRecordSchema = z.strictObject({
  computes: z.array(AuthoredComputeIdentitySchema).max(4_096),
  operations: z.array(AuthoredOperationIdentitySchema).max(OPERATION_KINDS.length * 32),
  runtime: WorkflowRuntimeIdentitySchema,
  version: z.union([z.literal(RUN_STORE_VERSION), z.literal(LEGACY_RUN_STORE_VERSION)]),
});

export type RunRuntimeRecord = z.infer<typeof RunRuntimeRecordSchema>;

export const NodePreparationPlanUnsignedSchema = z.strictObject({
  exactInputBound: z.literal(true).optional(),
  graphPlanSha256: Sha256Schema,
  inputDescriptors: JsonValueSchema,
  nodeKey: NodeKeySchema,
  executor: AuthoredNodeExecutorSchema,
  requestedPreparation: OperationPolicySchema.shape.preparation,
  upperDurationMs: z.number().int().nonnegative().safe(),
  upperInputBytes: z.number().int().nonnegative().safe(),
  version: z.union([z.literal(NODE_PREPARATION_PLAN_VERSION), z.literal(LEGACY_NODE_PREPARATION_PLAN_VERSION)]),
});

export const NodePreparationPlanSchema = NodePreparationPlanUnsignedSchema.extend({
  preparationPlanSha256: Sha256Schema,
});

export type NodePreparationPlan = z.infer<typeof NodePreparationPlanSchema>;

export const NodeExecutionPlanUnsignedSchema = z.strictObject({
  dependencyOutputDigests: z.record(NodeKeySchema, Sha256Schema),
  exactInput: JsonValueSchema,
  expectedProjectGeneration: Sha256Schema.optional(),
  graphPlanSha256: Sha256Schema,
  inputSha256: Sha256Schema,
  nodeKey: NodeKeySchema,
  executor: AuthoredNodeExecutorSchema,
  policy: WorkflowNodePolicySchema,
  preparationPlanSha256: Sha256Schema,
  publicationKeys: z.array(z.string().min(1).max(512)).max(64),
  version: z.union([z.literal(NODE_EXECUTION_PLAN_VERSION), z.literal(LEGACY_NODE_EXECUTION_PLAN_VERSION)]),
});

export const NodeExecutionPlanSchema = NodeExecutionPlanUnsignedSchema.extend({
  nodePlanSha256: Sha256Schema,
});

export type NodeExecutionPlan = z.infer<typeof NodeExecutionPlanSchema>;

function domainHash(domain: string, value: unknown): string {
  return canonicalJsonFingerprint(value, `${domain}\0`).sha256;
}

export function createNodePreparationPlanHash(
  input: z.input<typeof NodePreparationPlanUnsignedSchema>,
): string {
  return domainHash(
    NODE_PREPARATION_PLAN_HASH_DOMAIN,
    NodePreparationPlanUnsignedSchema.parse(input),
  );
}

export function createNodeInputHash(input: z.input<typeof JsonValueSchema>): string {
  return createNodeInputFingerprint(input).sha256;
}

export function createNodeInputFingerprint(
  input: z.input<typeof JsonValueSchema>,
): CanonicalJsonFingerprint {
  return createNodeInputFingerprintFromParsed(JsonValueSchema.parse(input));
}

export function createNodeInputFingerprintFromParsed(
  input: JsonValue,
): CanonicalJsonFingerprint {
  return canonicalJsonFingerprint(
    input,
    `${NODE_INPUT_HASH_DOMAIN}\0`,
  );
}

export function createNodeExecutionPlanHash(
  input: z.input<typeof NodeExecutionPlanUnsignedSchema>,
): string {
  return domainHash(
    NODE_EXECUTION_PLAN_HASH_DOMAIN,
    NodeExecutionPlanUnsignedSchema.parse(input),
  );
}

export function createRunNodeOutputDigest(input: z.input<typeof JsonValueSchema>): string {
  return createRunNodeOutputFingerprint(input).sha256;
}

export function createRunNodeOutputFingerprint(
  input: z.input<typeof JsonValueSchema>,
): CanonicalJsonFingerprint {
  return createRunNodeOutputFingerprintFromParsed(JsonValueSchema.parse(input));
}

export function createRunNodeOutputFingerprintFromParsed(
  input: JsonValue,
): CanonicalJsonFingerprint {
  return canonicalJsonFingerprint(
    input,
    `${NODE_OUTPUT_HASH_DOMAIN}\0`,
  );
}

export function createRunOutputsDigest(input: z.input<typeof JsonValueSchema>): string {
  return domainHash(RUN_OUTPUTS_HASH_DOMAIN, JsonValueSchema.parse(input));
}

const RunNodeFailureSchema = z.strictObject({
  code: z.enum([
    "authorization-required",
    "cancelled",
    "conflict",
    "incompatible",
    "invalid-data",
    "subprocess",
    "unavailable",
    "unsupported-plan",
    "ambiguous",
    "internal",
  ]),
  message: BoundedMessageSchema,
  retryable: z.boolean(),
});

export const RunNodeOutputSchema = z.strictObject({
  digestSha256: Sha256Schema,
  receiptReference: z.string().min(1).max(2_048).optional(),
  summary: z.record(
    z.string().min(1).max(128),
    z.union([z.boolean(), z.null(), z.number().finite(), z.string().max(2_000)]),
  ),
  value: JsonValueSchema,
}).superRefine((output, context) => {
  if (Object.keys(output.summary).length > 32) {
    context.addIssue({ code: "custom", message: "Run node summaries may contain at most 32 fields." });
  }
});

export type RunNodeOutput = z.infer<typeof RunNodeOutputSchema>;

export const RunNodeRecordSchema = z.strictObject({
  attempt: z.number().int().nonnegative().safe(),
  dependencies: z.array(NodeKeySchema).max(4_096),
  executionPlan: NodeExecutionPlanSchema.optional(),
  failure: RunNodeFailureSchema.optional(),
  finishedAt: TimestampSchema.optional(),
  nodeKey: NodeKeySchema,
  executor: AuthoredNodeExecutorSchema,
  output: RunNodeOutputSchema.optional(),
  preparationPlan: NodePreparationPlanSchema.optional(),
  startedAt: TimestampSchema.optional(),
  status: RunNodeStatusSchema,
  version: z.union([z.literal(RUN_NODE_VERSION), z.literal(LEGACY_RUN_NODE_VERSION)]),
}).superRefine((record, context) => {
  const terminal = [
    "ambiguous",
    "ambiguous-code",
    "cancelled",
    "completed",
    "failed",
    "incompatible",
    "skipped",
  ].includes(record.status);
  const dispatched = [
    "ambiguous",
    "ambiguous-code",
    "completed",
    "running",
  ].includes(record.status);
  if (terminal && record.finishedAt === undefined) {
    context.addIssue({ code: "custom", message: "Terminal run nodes require finishedAt." });
  }
  if (!terminal && record.finishedAt !== undefined) {
    context.addIssue({ code: "custom", message: "Nonterminal run nodes cannot have finishedAt." });
  }
  if (dispatched && record.startedAt === undefined) {
    context.addIssue({ code: "custom", message: "Dispatched run nodes require startedAt." });
  }
  if (dispatched && record.attempt < 1) {
    context.addIssue({ code: "custom", message: "Dispatched run nodes require a positive attempt." });
  }
  if (record.startedAt !== undefined && record.finishedAt !== undefined) {
    if (Date.parse(record.finishedAt) < Date.parse(record.startedAt)) {
      context.addIssue({ code: "custom", message: "Run node finishedAt cannot precede startedAt." });
    }
  }
  if (record.status === "completed") {
    if (
      record.output === undefined
      || record.executionPlan === undefined
      || record.preparationPlan === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Completed run nodes require preparation, execution, and verified output records.",
      });
    }
  }
  if (
    ["running", "ambiguous", "ambiguous-code"].includes(record.status)
    && (record.executionPlan === undefined || record.preparationPlan === undefined)
  ) {
    context.addIssue({
      code: "custom",
      message: `${record.status} run nodes require preparation and execution plans.`,
    });
  }
  if (record.status === "approval-required" && record.preparationPlan === undefined) {
    context.addIssue({
      code: "custom",
      message: "Approval-required run nodes require a preparation plan.",
    });
  }
  if (record.output !== undefined && record.status !== "completed") {
    context.addIssue({ code: "custom", message: "Only completed run nodes may publish output." });
  }
  if (
    ["failed", "incompatible", "ambiguous-code", "ambiguous"].includes(record.status)
    && record.failure === undefined
  ) {
    context.addIssue({ code: "custom", message: `${record.status} run nodes require failure details.` });
  }
  if (
    record.failure !== undefined
    && !["ambiguous", "ambiguous-code", "cancelled", "failed", "incompatible"].includes(record.status)
  ) {
    context.addIssue({
      code: "custom",
      message: `Run node status ${record.status} cannot retain failure details.`,
    });
  }
});

export type RunNodeRecord = z.infer<typeof RunNodeRecordSchema>;

export const RunEventSchema = z.strictObject({
  details: z.record(
    z.string().min(1).max(128),
    z.union([z.boolean(), z.null(), z.number().finite(), z.string().max(2_000)]),
  ),
  fenceGeneration: PositiveSafeIntegerSchema,
  kind: z.enum([
    "run-claimed",
    "run-status",
    "node-status",
    "node-reused",
    "approval-required",
    "run-finalized",
  ]),
  nodeKey: NodeKeySchema.optional(),
  runId: RunIdSchema,
  sequence: PositiveSafeIntegerSchema,
  timestamp: TimestampSchema,
  version: z.union([z.literal(RUN_EVENT_VERSION), z.literal(LEGACY_RUN_EVENT_VERSION)]),
});

export type RunEvent = z.infer<typeof RunEventSchema>;
export type NewRunEvent = Omit<RunEvent, "fenceGeneration" | "runId" | "sequence" | "version">;

const GrantBaseSchema = z.strictObject({
  createdAt: TimestampSchema,
  graphPlanSha256: Sha256Schema,
  grantedBy: OwnerSchema,
  grantId: z.string().uuid(),
  runId: RunIdSchema,
  version: z.union([z.literal(RUN_GRANT_VERSION), z.literal(LEGACY_RUN_GRANT_VERSION)]),
});

export const RunGrantSchema = z.discriminatedUnion("kind", [
  GrantBaseSchema.extend({
    kind: z.literal("graph-policy"),
    scopes: z.array(z.string().min(1).max(128)).min(1).max(128),
  }),
  GrantBaseSchema.extend({
    kind: z.literal("preparation"),
    nodeKey: NodeKeySchema,
    preparationPlanSha256: Sha256Schema,
  }),
  GrantBaseSchema.extend({
    kind: z.literal("effect"),
    nodeKey: NodeKeySchema,
    nodePlanSha256: Sha256Schema,
  }),
  GrantBaseSchema.extend({
    attempt: PositiveSafeIntegerSchema,
    bundleSha256: Sha256Schema,
    computeKey: z.string().min(1).max(255),
    kind: z.literal("compute-replay"),
    nodeKey: NodeKeySchema,
    nodePlanSha256: Sha256Schema,
  }),
]);

export type RunGrant = z.infer<typeof RunGrantSchema>;
export type NewRunGrant = RunGrant extends infer Grant
  ? Grant extends RunGrant
    ? Omit<Grant, "runId" | "version">
    : never
  : never;

export const CancellationRequestSchema = z.strictObject({
  requestedAt: TimestampSchema,
  requestedBy: OwnerSchema,
  runId: RunIdSchema,
  version: z.union([z.literal(RUN_STORE_VERSION), z.literal(LEGACY_RUN_STORE_VERSION)]),
});

export type CancellationRequest = z.infer<typeof CancellationRequestSchema>;

export const RunSummarySchema = z.strictObject({
  counts: z.strictObject({
    cancelled: z.number().int().nonnegative().safe(),
    completed: z.number().int().nonnegative().safe(),
    failed: z.number().int().nonnegative().safe(),
    pending: z.number().int().nonnegative().safe(),
    skipped: z.number().int().nonnegative().safe(),
  }),
  finishedAt: TimestampSchema.optional(),
  graphPlanSha256: Sha256Schema,
  outputs: JsonValueSchema.optional(),
  runId: RunIdSchema,
  startedAt: TimestampSchema.optional(),
  status: RunStatusSchema,
  updatedAt: TimestampSchema,
  version: z.union([z.literal(RUN_STORE_VERSION), z.literal(LEGACY_RUN_STORE_VERSION)]),
});

export type RunSummary = z.infer<typeof RunSummarySchema>;

export const RunOutputsSchema = z.strictObject({
  graphPlanSha256: Sha256Schema,
  nodeOutputDigests: z.record(NodeKeySchema, Sha256Schema),
  outputs: JsonValueSchema,
  outputsSha256: Sha256Schema,
  runId: RunIdSchema,
  version: z.union([z.literal(RUN_OUTPUTS_VERSION), z.literal(LEGACY_RUN_OUTPUTS_VERSION)]),
});

export type RunOutputs = z.infer<typeof RunOutputsSchema>;

export const CreateRunRecordSchema = z.strictObject({
  bundleBytes: z.instanceof(Uint8Array),
  graphPlan: GraphPlanV1Schema,
  runId: RunIdSchema,
  runtime: RunRuntimeRecordSchema,
  sourceLocator: z.string().min(1).max(2_048),
  workflow: RunWorkflowRecordSchema,
});

export type CreateRunRecord = z.infer<typeof CreateRunRecordSchema>;

export function nodeRecordFilename(nodeKey: string): string {
  const key = NodeKeySchema.parse(nodeKey);
  return `${Bun.CryptoHasher.hash("sha256", key, "hex")}.json`;
}
