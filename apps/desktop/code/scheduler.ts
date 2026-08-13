import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import {
  HOST_RESOURCE_MAX_WAIT_MILLISECONDS,
  HostResourceError,
  type HostResourceCoordinator,
  type HostResourceLease,
} from "@hraness/transmute/host-resources";

import { ApplicationError, asApplicationError } from "../application/errors";
import type { ApplicationContext } from "../application/context";
import { withProjectPublicationLease } from "../application/project-publication-lease";
import {
  RESOURCE_KINDS,
  type OperationResourceKind,
  type OperationResumeClass,
} from "../application/operation";
import type {
  OperationDiscovery,
  OperationRegistry,
  RegisteredOperation,
} from "../application/registry";
import {
  canonicalJson,
  canonicalJsonFingerprint,
} from "../core/canonical-json";
import {
  JsonValueSchema,
  NodeKeySchema,
  OperationPolicySchema,
  WorkflowNodePolicySchema,
  isComputeGraphNode,
  isOperationGraphNode,
  trustedComputePolicy,
  type AuthoredComputeGraphNodeV1,
  type AuthoredGraphNodeV1,
  type AuthoredOperationGraphNodeV1,
  type GraphInputValue,
  type GraphPlanV1,
  type JsonValue,
  type OperationResourceTotals,
  type SerializedRefV1,
  type WorkflowOutputBinding,
  type WorkflowNodePolicy,
} from "./contracts";
import {
  NODE_EXECUTION_PLAN_VERSION,
  NODE_PREPARATION_PLAN_VERSION,
  RUN_NODE_VERSION,
  RUN_STORE_VERSION,
  NodeExecutionPlanUnsignedSchema,
  NodeExecutionPlanSchema,
  NodePreparationPlanUnsignedSchema,
  NodePreparationPlanSchema,
  RunNodeRecordSchema,
  RunSummarySchema,
  createNodeExecutionPlanHash,
  createNodeInputFingerprintFromParsed,
  createNodePreparationPlanHash,
  createRunNodeOutputFingerprintFromParsed,
  type NewRunGrant,
  type CancellationRequest,
  type NodeExecutionPlan,
  type NodePreparationPlan,
  type RunFence,
  type RunGrant,
  type RunNodeOutput,
  type RunNodeRecord,
  type RunStatus,
  type RunSummary,
} from "./run-contracts";
import type { RunStore } from "./run-store";
import { projectReferenceValue } from "./reference-projection";
import { physicalHostResourceClaims } from "./host-resource-policy";

export {
  NODE_EXECUTION_PLAN_HASH_DOMAIN,
  NODE_INPUT_HASH_DOMAIN,
  NODE_OUTPUT_HASH_DOMAIN,
  NODE_PREPARATION_PLAN_HASH_DOMAIN,
} from "./run-contracts";

const MAX_SUMMARY_FIELDS = 32;
const MAX_SUMMARY_KEY_LENGTH = 128;
const MAX_SUMMARY_STRING_LENGTH = 2_000;
const MAX_FAILURE_MESSAGE_LENGTH = 4_000;
const DEFAULT_CANCELLATION_POLL_MS = 100;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export const DEFAULT_SCHEDULER_RESOURCE_LIMITS = Object.freeze({
  browser: 1,
  "capture-device": 1,
  cpu: 4,
  ffmpeg: 2,
  "local-io": 4,
  network: 4,
  "output-publication": 4,
  "paid-call": 1,
  "project-render": 1,
  "project-publication": 1,
  vision: 1,
  whisper: 1,
}) satisfies OperationResourceTotals;

export interface SchedulerHostLimits {
  readonly maxJobs?: number;
  readonly maxNodes?: number;
  readonly maxWallClockMs?: number;
  readonly resources?: Partial<OperationResourceTotals>;
}

export interface SchedulerNodeContext {
  readonly graphPlan: GraphPlanV1;
  readonly node: AuthoredOperationGraphNodeV1;
  readonly operation: OperationDiscovery;
  readonly resolvedInput: JsonValue;
  readonly runId: string;
}

export interface NodePreparationBinding {
  readonly inputDescriptors: JsonValue;
  readonly upperDurationMs?: number;
  readonly upperInputBytes?: number;
}

export interface NodeExecutionBinding {
  readonly exactInput: JsonValue;
  readonly expectedProjectGeneration?: string;
  readonly publicationKeys: readonly string[];
}

export interface NodePreparationRequest extends SchedulerNodeContext {
  readonly dependencyOutputs: Readonly<Record<string, RunNodeOutput>>;
}

export interface NodeExecutionPlanningRequest extends NodePreparationRequest {
  readonly preparationPlan: NodePreparationPlan;
}

export interface NodeReconciliationRequest extends SchedulerNodeContext {
  /**
   * The scheduler-scoped application carries the active machine lease and
   * inherited descriptor for every reconciliation-side process.
   */
  readonly application: ApplicationContext;
  /**
   * Aborted as soon as cancellation, the workflow deadline, or scheduler
   * monitoring invalidates this reconciliation attempt.
   */
  readonly abortSignal: AbortSignal;
  /**
   * Reasserts the durable run claim, cancellation marker, and wall-clock
   * deadline. Reconcilers must call this immediately before every write.
   */
  readonly beforePublication: () => Promise<void>;
  readonly dependencyOutputs: Readonly<Record<string, RunNodeOutput>>;
  readonly executionPlan: NodeExecutionPlan | undefined;
  readonly previous: RunNodeRecord;
  readonly preparationPlan: NodePreparationPlan | undefined;
  readonly resumeClass: OperationResumeClass;
  readonly workspaceDirectory?: string;
}

export type NodeReconciliation =
  | {
    readonly kind: "completed";
    readonly output: JsonValue;
    readonly receiptReference?: string;
    readonly summary: Readonly<Record<string, boolean | null | number | string>>;
  }
  | {
    readonly kind: "retry";
  }
  | {
    readonly kind: "ambiguous" | "incompatible";
    readonly message: string;
  };

export interface SchedulerNodePlanner {
  prepare(request: NodePreparationRequest): Promise<NodePreparationBinding>;
  plan(request: NodeExecutionPlanningRequest): Promise<NodeExecutionBinding>;
  reconcile?(request: NodeReconciliationRequest): Promise<NodeReconciliation>;
}

export interface SchedulerAuthorizationRequest {
  readonly executor: AuthoredGraphNodeV1["executor"];
  readonly graphPlanSha256: string;
  readonly nodeKey: string;
  readonly operation?: OperationDiscovery;
  readonly policy: WorkflowNodePolicy;
  readonly runId: string;
}

export interface PreparationAuthorizationRequest extends SchedulerAuthorizationRequest {
  readonly preparationPlan: NodePreparationPlan;
}

export interface EffectAuthorizationRequest extends SchedulerAuthorizationRequest {
  readonly executionPlan: NodeExecutionPlan;
}

export type SchedulerAuthorizationDecision =
  | boolean
  | {
    readonly allowed: boolean;
    readonly reason?: string;
  };

export interface SchedulerAuthorization {
  readonly grantedBy: string;
  authorizeEffect(
    request: EffectAuthorizationRequest,
  ): Promise<SchedulerAuthorizationDecision>;
  authorizePreparation(
    request: PreparationAuthorizationRequest,
  ): Promise<SchedulerAuthorizationDecision>;
}

export interface SchedulerApprovalPause {
  readonly nodeKey: string;
  readonly phase: "effect" | "preparation";
  readonly planSha256: string;
}

export interface SchedulerRunResult {
  readonly pause?: SchedulerApprovalPause;
  readonly summary: RunSummary;
}

export interface SchedulerComputeExecutor {
  readonly bundleSha256: string;
  execute(request: {
    readonly abortSignal: AbortSignal;
    readonly computeKey: string;
    readonly inheritedHostResourceFileDescriptor?: number;
    readonly input: JsonValue;
    readonly nodeKey: string;
    readonly replayAcknowledged: boolean;
    readonly timeoutMs: number;
  }): Promise<JsonValue>;
}

export interface SchedulerComputeExecutorLease {
  readonly executor: SchedulerComputeExecutor;
  release(): Promise<void>;
}

export type SchedulerComputeRuntime =
  | {
    readonly executor: SchedulerComputeExecutor;
    readonly kind: "fresh";
  }
  | {
    readonly kind: "replay";
    load(options: {
      readonly signal: AbortSignal;
      readonly waitTimeoutMilliseconds: number;
    }): Promise<SchedulerComputeExecutorLease>;
    readonly nodeKeys: readonly string[];
  };

export interface DurableWorkflowSchedulerOptions {
  readonly application: ApplicationContext;
  readonly authorization: SchedulerAuthorization;
  readonly cancellationPollMs?: number;
  readonly compute?: SchedulerComputeRuntime;
  readonly currentApplicationBuild: string;
  /**
   * One machine-scoped physical admission authority. Local scheduler limits
   * remain a fast conservative prefilter; this coordinator is authoritative
   * across independent Transmute processes.
   */
  readonly hostResourceCoordinator: HostResourceCoordinator;
  readonly hostLimits?: SchedulerHostLimits;
  readonly jobs?: number;
  readonly nodePlanner: SchedulerNodePlanner;
  readonly now?: () => Date;
  readonly owner: string;
  readonly registry: OperationRegistry;
  readonly store: Pick<
    RunStore,
    | "acquireClaim"
    | "appendEvent"
    | "appendGrant"
    | "assertFence"
    | "cancellation"
    | "graphPlan"
    | "grants"
    | "node"
    | "nodes"
    | "releaseClaim"
    | "reopenComputeNode"
    | "runtime"
    | "stagingDirectory"
    | "summary"
    | "writeNode"
    | "writeSummary"
  >;
}

interface NormalizedSchedulerLimits {
  readonly cancellationPollMs: number;
  readonly jobs: number;
  readonly maxNodes: number;
  readonly maxWallClockMs: number;
  readonly resources: OperationResourceTotals;
}

interface ResolvedNode {
  readonly dependencyOutputs: Readonly<Record<string, RunNodeOutput>>;
  readonly input: JsonValue;
}

interface PreparedNode {
  readonly executionPlan: NodeExecutionPlan;
  readonly executor: ResolvedNodeExecutor;
  readonly record: RunNodeRecord;
  readonly resolved: ResolvedNode;
}

interface RunningNode {
  readonly admissionAbortController: AbortController;
  readonly abortController: AbortController;
  readonly cancellable: boolean;
  readonly executionPlan: NodeExecutionPlan;
  readonly nodeKey: string;
  readonly promise: Promise<NodeExecutionOutcome>;
  readonly resources: readonly {
    readonly amount: number;
    readonly resource: OperationResourceKind;
  }[];
  readonly publicationKeys: readonly string[];
}

type NodeExecutionOutcome =
  | {
    readonly kind: "completed";
    readonly output: RunNodeOutput;
  }
  | {
    readonly failure: ReturnType<typeof schedulerFailure>;
    readonly kind:
      | "cancelled"
      | "failed"
      | "ambiguous"
      | "ambiguous-code"
      | "interrupted";
  };

interface MutableRunState {
  cancelled: boolean;
  monitorError: ApplicationError | undefined;
  pause: SchedulerApprovalPause | undefined;
  reconciliationDeferred: boolean;
  readonly startedAt: string;
}

type ResolvedNodeExecutor =
  | {
    readonly kind: "operation";
    readonly operation: RegisteredOperation;
    readonly policy: OperationDiscovery["policy"];
  }
  | {
    readonly compute: AuthoredComputeGraphNodeV1["executor"]["compute"];
    readonly kind: "compute";
    readonly policy: ReturnType<typeof trustedComputePolicy>;
  };

type NodeDeadlineKind = "node" | "workflow";

type WorkflowInterruptionKind = "cancellation" | "deadline" | "monitor";

interface WorkflowInterruption {
  readonly error: ApplicationError;
  readonly kind: WorkflowInterruptionKind;
}

function safeDeadline(startedAtMs: number, durationMs: number): number {
  return durationMs > Number.MAX_SAFE_INTEGER - startedAtMs
    ? Number.MAX_SAFE_INTEGER
    : startedAtMs + durationMs;
}

function scheduleDeadline(
  deadlineMonotonicMs: number,
  expire: () => void,
): () => void {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (!active) return;
    const remainingMs = deadlineMonotonicMs - performance.now();
    if (remainingMs <= 0) {
      active = false;
      expire();
      return;
    }
    timer = setTimeout(arm, Math.min(remainingMs, MAX_TIMER_DELAY_MS));
  };
  arm();
  return () => {
    active = false;
    if (timer !== undefined) clearTimeout(timer);
  };
}

class WorkflowRunControl {
  readonly #abortController = new AbortController();
  readonly deadlineMonotonicMs: number;
  readonly #interruptionPromise: Promise<never>;
  readonly #onInterrupt: (interruption: WorkflowInterruption) => void;
  readonly #rejectInterruption: (error: ApplicationError) => void;
  readonly #stopDeadline: () => void;
  #interruption: WorkflowInterruption | undefined;

  constructor(
    deadlineMonotonicMs: number,
    onInterrupt: (interruption: WorkflowInterruption) => void,
  ) {
    this.deadlineMonotonicMs = deadlineMonotonicMs;
    this.#onInterrupt = onInterrupt;
    let rejectInterruption!: (error: ApplicationError) => void;
    this.#interruptionPromise = new Promise<never>((_resolve, reject) => {
      rejectInterruption = reject;
    });
    this.#rejectInterruption = rejectInterruption;
    void this.#interruptionPromise.catch(() => undefined);
    this.#stopDeadline = scheduleDeadline(deadlineMonotonicMs, () => {
      this.interrupt("deadline", new ApplicationError(
        "cancelled",
        "Workflow exceeded the host wall-clock bound.",
      ));
    });
  }

  get interruption(): WorkflowInterruption | undefined {
    return this.#interruption;
  }

  get signal(): AbortSignal {
    return this.#abortController.signal;
  }

  interrupt(kind: WorkflowInterruptionKind, error: ApplicationError): void {
    if (this.#interruption !== undefined) return;
    const interruption = { error, kind } satisfies WorkflowInterruption;
    this.#interruption = interruption;
    this.#abortController.abort(error);
    this.#onInterrupt(interruption);
    this.#rejectInterruption(error);
  }

  assertActive(): void {
    if (this.#interruption !== undefined) throw this.#interruption.error;
  }

  async race<Value>(execute: () => Promise<Value>): Promise<Value> {
    this.assertActive();
    return await Promise.race([
      Promise.resolve().then(execute),
      this.#interruptionPromise,
    ]);
  }

  stop(): void {
    this.#stopDeadline();
  }
}

function safePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ApplicationError("usage", `${name} must be a positive safe integer.`);
  }
  return value;
}

function safeNonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApplicationError("usage", `${name} must be a nonnegative safe integer.`);
  }
  return value;
}

function normalizeLimits(options: DurableWorkflowSchedulerOptions): NormalizedSchedulerLimits {
  const hostJobs = safePositiveInteger(options.hostLimits?.maxJobs ?? 4, "Host job limit");
  const requestedJobs = options.jobs === undefined
    ? hostJobs
    : safePositiveInteger(options.jobs, "Requested job limit");
  const resourceOverrides = options.hostLimits?.resources ?? {};
  const resources = Object.fromEntries(RESOURCE_KINDS.map(resource => [
    resource,
    safeNonnegativeInteger(
      resourceOverrides[resource] ?? DEFAULT_SCHEDULER_RESOURCE_LIMITS[resource],
      `Host ${resource} limit`,
    ),
  ])) as Record<OperationResourceKind, number>;
  return {
    cancellationPollMs: safePositiveInteger(
      options.cancellationPollMs ?? DEFAULT_CANCELLATION_POLL_MS,
      "Cancellation poll interval",
    ),
    jobs: Math.min(hostJobs, requestedJobs),
    maxNodes: safePositiveInteger(options.hostLimits?.maxNodes ?? 4_096, "Host node limit"),
    maxWallClockMs: safePositiveInteger(
      options.hostLimits?.maxWallClockMs ?? 24 * 60 * 60 * 1_000,
      "Host workflow wall-clock limit",
    ),
    resources,
  };
}

export function nodeOutputDigest(value: JsonValue): string {
  return createRunNodeOutputFingerprintFromParsed(value).sha256;
}

function isSerializedRef(value: GraphInputValue | WorkflowOutputBinding): value is SerializedRefV1 {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.hasOwn(value, "$ref");
}

function isGraphInputArray(value: GraphInputValue): value is readonly GraphInputValue[] {
  return Array.isArray(value);
}

function isWorkflowOutputArray(
  value: WorkflowOutputBinding,
): value is readonly WorkflowOutputBinding[] {
  return Array.isArray(value);
}

function verifiedOutput(record: RunNodeRecord): RunNodeOutput {
  if (record.status !== "completed" || record.output === undefined) {
    throw new ApplicationError(
      "invalid-data",
      `Dependency ${record.nodeKey} does not have a completed output.`,
    );
  }
  const value = JsonValueSchema.parse(record.output.value);
  const digest = nodeOutputDigest(value);
  if (digest !== record.output.digestSha256) {
    throw new ApplicationError(
      "invalid-data",
      `Completed output digest does not match for node ${record.nodeKey}.`,
    );
  }
  return record.output;
}

function resolveGraphValue(
  value: GraphInputValue,
  outputs: ReadonlyMap<string, RunNodeOutput>,
): JsonValue {
  if (isSerializedRef(value)) {
    const output = outputs.get(value.$ref.nodeKey);
    if (output === undefined) {
      throw new ApplicationError(
        "invalid-data",
        `Node input references unavailable output ${value.$ref.nodeKey}.`,
      );
    }
    return projectReferenceValue(value, output.value);
  }
  if (isGraphInputArray(value)) {
    return value.map(item => resolveGraphValue(item, outputs));
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, resolveGraphValue(item, outputs)]),
    );
  }
  return value;
}

function resolveNode(
  node: AuthoredGraphNodeV1,
  recordsByKey: ReadonlyMap<string, RunNodeRecord>,
): ResolvedNode {
  const outputs = new Map<string, RunNodeOutput>();
  const dependencyOutputs: Record<string, RunNodeOutput> = {};
  for (const dependency of [...node.dependencies].sort((left, right) => left.localeCompare(right))) {
    const record = recordsByKey.get(dependency);
    if (record === undefined) {
      throw new ApplicationError("invalid-data", `Missing dependency node ${dependency}.`);
    }
    const output = verifiedOutput(record);
    outputs.set(dependency, output);
    dependencyOutputs[dependency] = output;
  }
  return {
    dependencyOutputs,
    input: JsonValueSchema.parse(resolveGraphValue(node.input, outputs)),
  };
}

function normalizePolicy(policy: WorkflowNodePolicy): WorkflowNodePolicy {
  return WorkflowNodePolicySchema.parse({
    ...policy,
    preparation: [...policy.preparation].sort((left, right) => left.localeCompare(right)),
    resources: [...policy.resources].sort((left, right) => (
      left.resource.localeCompare(right.resource)
    )),
  });
}

function normalizeDiscovery(discovery: OperationDiscovery): OperationDiscovery {
  return {
    ...discovery,
    policy: OperationPolicySchema.parse(normalizePolicy(discovery.policy)),
  };
}

function operationForNode(
  graphPlan: GraphPlanV1,
  node: AuthoredOperationGraphNodeV1,
  registry: OperationRegistry,
): RegisteredOperation {
  const operation = node.executor.operation;
  const registered = registry.get(operation.kind, operation.version);
  const planned = graphPlan.registry.discovery.find(item => (
    item.kind === operation.kind && item.version === operation.version
  ));
  if (planned === undefined) {
    throw new ApplicationError(
      "incompatible",
      `Graph plan omits operation ${operation.kind}@${String(operation.version)}.`,
    );
  }
  if (
    canonicalJson(normalizeDiscovery(registered.discovery))
    !== canonicalJson(normalizeDiscovery(planned))
  ) {
    throw new ApplicationError(
      "incompatible",
      `Registered operation changed after planning: ${operation.kind}@${String(operation.version)}.`,
    );
  }
  return registered;
}

function executorForNode(
  graphPlan: GraphPlanV1,
  node: AuthoredGraphNodeV1,
  registry: OperationRegistry,
): ResolvedNodeExecutor {
  if (isOperationGraphNode(node)) {
    const operation = operationForNode(graphPlan, node, registry);
    return {
      kind: "operation",
      operation,
      policy: operation.discovery.policy,
    };
  }
  if (isComputeGraphNode(node)) {
    return {
      compute: node.executor.compute,
      kind: "compute",
      policy: trustedComputePolicy(node.executor.compute),
    };
  }
  throw new ApplicationError("internal", `Unknown node executor for ${node.key}.`);
}

function normalizePublicationKeys(keys: readonly string[]): readonly string[] {
  if (keys.length > 64) {
    throw new ApplicationError("invalid-data", "A node may claim at most 64 publication keys.");
  }
  const normalized = [...keys].map((key) => {
    if (key.length < 1 || key.length > 512) {
      throw new ApplicationError(
        "invalid-data",
        "Publication keys must contain between 1 and 512 characters.",
      );
    }
    return key;
  }).sort((left, right) => left.localeCompare(right));
  if (new Set(normalized).size !== normalized.length) {
    throw new ApplicationError("invalid-data", "A node cannot claim a publication key twice.");
  }
  return normalized;
}

function computePreparationBinding(resolved: ResolvedNode): NodePreparationBinding {
  const fingerprint = canonicalJsonFingerprint(
    resolved.input,
    "studio.workflow.compute-input-descriptor/v1\0",
  );
  return {
    inputDescriptors: JsonValueSchema.parse({
      bytes: fingerprint.bytes,
      inputSha256: fingerprint.sha256,
    }),
    upperInputBytes: fingerprint.bytes,
  };
}

function createPreparationPlan(
  graphPlan: GraphPlanV1,
  node: AuthoredGraphNodeV1,
  policy: WorkflowNodePolicy,
  binding: NodePreparationBinding,
): NodePreparationPlan {
  const upperDurationMs = binding.upperDurationMs ?? policy.maxDurationMs;
  const upperInputBytes = binding.upperInputBytes ?? policy.maxInputBytes;
  if (
    !Number.isSafeInteger(upperDurationMs)
    || upperDurationMs < 0
    || upperDurationMs > policy.maxDurationMs
  ) {
    throw new ApplicationError(
      "invalid-data",
      `Preparation duration bound exceeds policy for node ${node.key}.`,
    );
  }
  if (
    !Number.isSafeInteger(upperInputBytes)
    || upperInputBytes < 0
    || upperInputBytes > policy.maxInputBytes
  ) {
    throw new ApplicationError(
      "invalid-data",
      `Preparation input bound exceeds policy for node ${node.key}.`,
    );
  }
  const unsigned = NodePreparationPlanUnsignedSchema.parse({
    exactInputBound: true,
    executor: node.executor,
    graphPlanSha256: graphPlan.graphPlanSha256,
    inputDescriptors: JsonValueSchema.parse(binding.inputDescriptors),
    nodeKey: node.key,
    requestedPreparation: [...policy.preparation]
      .sort((left, right) => left.localeCompare(right)),
    upperDurationMs,
    upperInputBytes,
    version: NODE_PREPARATION_PLAN_VERSION,
  });
  return NodePreparationPlanSchema.parse({
    ...unsigned,
    preparationPlanSha256: createNodePreparationPlanHash(unsigned),
  });
}

function createExecutionPlan(
  graphPlan: GraphPlanV1,
  node: AuthoredGraphNodeV1,
  policy: WorkflowNodePolicy,
  preparationPlan: NodePreparationPlan,
  resolved: ResolvedNode,
  binding: NodeExecutionBinding,
): NodeExecutionPlan {
  const exactInput = JsonValueSchema.parse(binding.exactInput);
  const exactInputFingerprint = createNodeInputFingerprintFromParsed(exactInput);
  const exactInputBytes = exactInputFingerprint.bytes;
  const exactInputLimit = preparationPlan.exactInputBound === true
    ? preparationPlan.upperInputBytes
    : policy.maxInputBytes;
  if (exactInputBytes > exactInputLimit) {
    throw new ApplicationError(
      "invalid-data",
      `Exact input for node ${node.key} uses ${String(exactInputBytes)} canonical JSON bytes; the ${preparationPlan.exactInputBound === true ? "prepared upper bound" : "operation input limit"} is ${String(exactInputLimit)}.`,
    );
  }
  const dependencyOutputDigests = Object.fromEntries(
    Object.entries(resolved.dependencyOutputs)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, output]) => [key, output.digestSha256]),
  );
  const unsigned = NodeExecutionPlanUnsignedSchema.parse({
    dependencyOutputDigests,
    executor: node.executor,
    exactInput,
    ...(binding.expectedProjectGeneration === undefined
      ? {}
      : { expectedProjectGeneration: binding.expectedProjectGeneration }),
    graphPlanSha256: graphPlan.graphPlanSha256,
    inputSha256: exactInputFingerprint.sha256,
    nodeKey: node.key,
    policy: normalizePolicy(policy),
    preparationPlanSha256: preparationPlan.preparationPlanSha256,
    publicationKeys: normalizePublicationKeys(binding.publicationKeys),
    version: NODE_EXECUTION_PLAN_VERSION,
  });
  return NodeExecutionPlanSchema.parse({
    ...unsigned,
    nodePlanSha256: createNodeExecutionPlanHash(unsigned),
  });
}

function verifyPreparationPlan(
  plan: NodePreparationPlan,
  graphPlan: GraphPlanV1,
  node: AuthoredGraphNodeV1,
  policy: WorkflowNodePolicy,
): void {
  const parsed = NodePreparationPlanSchema.parse(plan);
  const { preparationPlanSha256, ...unsigned } = parsed;
  if (
    preparationPlanSha256 !== createNodePreparationPlanHash(unsigned)
    || parsed.graphPlanSha256 !== graphPlan.graphPlanSha256
    || parsed.nodeKey !== node.key
    || canonicalJson(parsed.executor) !== canonicalJson(node.executor)
    || parsed.upperDurationMs > policy.maxDurationMs
    || parsed.upperInputBytes > policy.maxInputBytes
    || canonicalJson(parsed.requestedPreparation)
      !== canonicalJson([...policy.preparation].sort((left, right) => left.localeCompare(right)))
  ) {
    throw new ApplicationError(
      "invalid-data",
      `Persisted preparation plan no longer matches node ${node.key}.`,
    );
  }
}

function verifyExecutionPlan(
  plan: NodeExecutionPlan,
  graphPlan: GraphPlanV1,
  node: AuthoredGraphNodeV1,
  policy: WorkflowNodePolicy,
  preparationPlan: NodePreparationPlan,
  resolved: ResolvedNode,
): void {
  const parsed = NodeExecutionPlanSchema.parse(plan);
  const { nodePlanSha256, ...unsigned } = parsed;
  const exactInputFingerprint = createNodeInputFingerprintFromParsed(parsed.exactInput);
  const exactInputBytes = exactInputFingerprint.bytes;
  const exactInputLimit = preparationPlan.exactInputBound === true
    ? preparationPlan.upperInputBytes
    : policy.maxInputBytes;
  const expectedDigests = Object.fromEntries(
    Object.entries(resolved.dependencyOutputs)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, output]) => [key, output.digestSha256]),
  );
  if (
    nodePlanSha256 !== createNodeExecutionPlanHash(unsigned)
    || exactInputBytes > exactInputLimit
    || parsed.inputSha256 !== exactInputFingerprint.sha256
    || parsed.graphPlanSha256 !== graphPlan.graphPlanSha256
    || parsed.nodeKey !== node.key
    || parsed.preparationPlanSha256 !== preparationPlan.preparationPlanSha256
    || canonicalJson(parsed.executor) !== canonicalJson(node.executor)
    || canonicalJson(parsed.policy) !== canonicalJson(normalizePolicy(policy))
    || canonicalJson(parsed.dependencyOutputDigests) !== canonicalJson(expectedDigests)
    || canonicalJson(parsed.publicationKeys)
      !== canonicalJson(normalizePublicationKeys(parsed.publicationKeys))
  ) {
    throw new ApplicationError(
      "invalid-data",
      `Persisted execution plan no longer matches node ${node.key}.`,
    );
  }
}

function authorizationAllowed(decision: SchedulerAuthorizationDecision): boolean {
  return typeof decision === "boolean" ? decision : decision.allowed;
}

function exactPreparationGrant(
  grants: readonly RunGrant[],
  graphPlanSha256: string,
  nodeKey: string,
  preparationPlanSha256: string,
): boolean {
  return grants.some(grant => (
    grant.kind === "preparation"
    && grant.graphPlanSha256 === graphPlanSha256
    && grant.nodeKey === nodeKey
    && grant.preparationPlanSha256 === preparationPlanSha256
  ));
}

function exactEffectGrant(
  grants: readonly RunGrant[],
  graphPlanSha256: string,
  nodeKey: string,
  nodePlanSha256: string,
): boolean {
  return grants.some(grant => (
    grant.kind === "effect"
    && grant.graphPlanSha256 === graphPlanSha256
    && grant.nodeKey === nodeKey
    && grant.nodePlanSha256 === nodePlanSha256
  ));
}

function boundedMessage(message: string): string {
  const normalized = message.length === 0 ? "Unknown scheduler failure." : message;
  return normalized.slice(0, MAX_FAILURE_MESSAGE_LENGTH);
}

function schedulerFailure(error: unknown, retryable = false) {
  const applicationError = asApplicationError(error);
  const code = (() => {
    switch (applicationError.code) {
      case "authorization-required":
      case "cancelled":
      case "conflict":
      case "incompatible":
      case "invalid-data":
      case "subprocess":
      case "unavailable":
      case "unsupported-plan":
      case "ambiguous":
      case "internal":
        return applicationError.code;
      case "not-found":
      case "unsafe-path":
      case "usage":
        return "invalid-data";
    }
  })();
  return {
    code,
    message: boundedMessage(applicationError.message),
    retryable,
  } as const;
}

function boundedSummary(
  fields: Readonly<Record<string, boolean | null | number | string>>,
): Readonly<Record<string, boolean | null | number | string>> {
  const entries = Object.entries(fields).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length > MAX_SUMMARY_FIELDS) {
    throw new ApplicationError("internal", "Operation summary exceeds the scheduler field limit.");
  }
  return Object.fromEntries(entries.map(([key, value]) => {
    if (key.length < 1 || key.length > MAX_SUMMARY_KEY_LENGTH) {
      throw new ApplicationError("internal", "Operation summary contains an invalid field name.");
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new ApplicationError("internal", "Operation summary contains a non-finite number.");
    }
    if (typeof value === "string" && value.length > MAX_SUMMARY_STRING_LENGTH) {
      throw new ApplicationError("internal", "Operation summary contains an oversized string.");
    }
    return [key, value];
  }));
}

function createRunNodeOutput(
  valueInput: unknown,
  summaryInput: Readonly<Record<string, boolean | null | number | string>>,
  maxOutputBytes: number,
  receiptReference?: string,
): RunNodeOutput {
  const value = JsonValueSchema.parse(valueInput);
  const fingerprint = createRunNodeOutputFingerprintFromParsed(value);
  const bytes = fingerprint.bytes;
  if (bytes > maxOutputBytes) {
    throw new ApplicationError(
      "invalid-data",
      `Operation output uses ${String(bytes)} bytes; the limit is ${String(maxOutputBytes)}.`,
    );
  }
  return {
    digestSha256: fingerprint.sha256,
    ...(receiptReference === undefined ? {} : { receiptReference }),
    summary: boundedSummary(summaryInput),
    value,
  };
}

function dependencyTerminalFailure(record: RunNodeRecord): boolean {
  return [
    "ambiguous",
    "cancelled",
    "failed",
    "incompatible",
    "skipped",
  ].includes(record.status);
}

function isRunnableStatus(record: RunNodeRecord): boolean {
  return record.status === "pending"
    || record.status === "ready"
    || record.status === "preparing"
    || record.status === "approval-required";
}

class ResourceLedger {
  readonly #jobs: number;
  readonly #limits: OperationResourceTotals;
  readonly #publicationKeys = new Set<string>();
  readonly #used: Record<OperationResourceKind, number>;
  #usedJobs = 0;

  constructor(limits: NormalizedSchedulerLimits) {
    this.#jobs = limits.jobs;
    this.#limits = limits.resources;
    this.#used = Object.fromEntries(RESOURCE_KINDS.map(resource => [resource, 0])) as Record<
      OperationResourceKind,
      number
    >;
  }

  impossible(
    resources: readonly { readonly amount: number; readonly resource: OperationResourceKind }[],
  ): boolean {
    return resources.some(claim => claim.amount > this.#limits[claim.resource]);
  }

  acquire(
    resources: readonly { readonly amount: number; readonly resource: OperationResourceKind }[],
    publicationKeys: readonly string[],
  ): boolean {
    if (this.#usedJobs >= this.#jobs) return false;
    if (publicationKeys.some(key => this.#publicationKeys.has(key))) return false;
    if (resources.some(claim => (
      this.#used[claim.resource] + claim.amount > this.#limits[claim.resource]
    ))) return false;
    this.#usedJobs += 1;
    for (const claim of resources) this.#used[claim.resource] += claim.amount;
    for (const key of publicationKeys) this.#publicationKeys.add(key);
    return true;
  }

  release(
    resources: readonly { readonly amount: number; readonly resource: OperationResourceKind }[],
    publicationKeys: readonly string[],
  ): void {
    this.#usedJobs -= 1;
    for (const claim of resources) this.#used[claim.resource] -= claim.amount;
    for (const key of publicationKeys) this.#publicationKeys.delete(key);
  }
}

function applicationWithHostResourceLease(
  application: ApplicationContext,
  lease: HostResourceLease,
): ApplicationContext {
  return {
    ...application,
    hostResourceLease: {
      assertOwned: async () => await lease.assertOwned(),
      claims: lease.claims,
      inheritedFileDescriptor: lease.inheritedFileDescriptor,
      inheritedFileDescriptors: [lease.inheritedFileDescriptor],
      profile: lease.profile,
      ticket: lease.ticket,
    },
    runner: {
      run: async (argv, options = {}) => {
        await lease.assertOwned();
        const inheritedFileDescriptors = [
          ...(options.inheritedFileDescriptors ?? []),
          lease.inheritedFileDescriptor,
        ].filter((descriptor, index, descriptors) => (
          descriptors.indexOf(descriptor) === index
        ));
        if (inheritedFileDescriptors.length > 16) {
          throw new ApplicationError(
            "incompatible",
            "A workflow subprocess cannot inherit more than 16 file descriptors.",
          );
        }
        return await application.runner.run(argv, {
          ...options,
          inheritedFileDescriptors,
        });
      },
    },
  };
}

function asSchedulerApplicationError(error: unknown): ApplicationError {
  if (!(error instanceof HostResourceError)) return asApplicationError(error);
  switch (error.code) {
    case "WAIT_ABORTED":
      return new ApplicationError("cancelled", error.message);
    case "WAIT_TIMEOUT":
      return new ApplicationError("unavailable", error.message);
    case "OWNERSHIP_LOST":
      return new ApplicationError("conflict", error.message);
    case "INVALID_CLAIMS":
    case "INVALID_PROFILE":
    case "PROFILE_MISMATCH":
    case "UNSAFE_STATE":
    case "UNSUPPORTED_PLATFORM":
      return new ApplicationError("incompatible", error.message);
    default: {
      const exhaustive: never = error.code;
      return exhaustive;
    }
  }
}

function countsFor(records: readonly RunNodeRecord[]): RunSummary["counts"] {
  return {
    cancelled: records.filter(record => record.status === "cancelled").length,
    completed: records.filter(record => record.status === "completed").length,
    failed: records.filter(record => (
      record.status === "failed"
      || record.status === "incompatible"
      || record.status === "ambiguous"
    )).length,
    pending: records.filter(record => (
      record.status === "pending"
      || record.status === "ready"
      || record.status === "preparing"
      || record.status === "running"
      || record.status === "approval-required"
      || record.status === "ambiguous-code"
    )).length,
    skipped: records.filter(record => record.status === "skipped").length,
  };
}

function terminalStatus(
  records: readonly RunNodeRecord[],
  state: MutableRunState,
  running: number,
): RunStatus {
  if (state.pause !== undefined) return "approval-required";
  if (records.some(record => record.status === "approval-required")) {
    return "approval-required";
  }
  if (records.some(record => record.status === "ambiguous-code")) return "ambiguous-code";
  if (
    running > 0
    || records.some(record => record.status === "running")
    || records.some(isRunnableStatus)
  ) return "running";
  const counts = countsFor(records);
  if (counts.cancelled > 0) return "cancelled";
  if (counts.failed === 0 && counts.skipped === 0 && counts.completed === records.length) {
    return "completed";
  }
  if (state.cancelled) return "cancelled";
  if (
    records.some(record => record.status === "incompatible")
    && counts.completed === 0
  ) {
    return "incompatible";
  }
  if (counts.completed > 0) return "partial";
  return "failed";
}

function terminalRunStatus(status: RunStatus): boolean {
  return status === "cancelled"
    || status === "completed"
    || status === "failed"
    || status === "incompatible"
    || status === "partial";
}

function resolveOutputBinding(
  binding: WorkflowOutputBinding,
  recordsByKey: ReadonlyMap<string, RunNodeRecord>,
): JsonValue | undefined {
  if (isSerializedRef(binding)) {
    const record = recordsByKey.get(binding.$ref.nodeKey);
    if (record === undefined || record.status !== "completed") return undefined;
    return projectReferenceValue(binding, verifiedOutput(record).value);
  }
  if (isWorkflowOutputArray(binding)) {
    const values: JsonValue[] = [];
    for (const item of binding) {
      const resolved = resolveOutputBinding(item, recordsByKey);
      if (resolved === undefined) return undefined;
      values.push(resolved);
    }
    return values;
  }
  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(binding).sort(([left], [right]) => (
    left.localeCompare(right)
  ))) {
    const resolved = resolveOutputBinding(item, recordsByKey);
    if (resolved === undefined) return undefined;
    output[key] = resolved;
  }
  return output;
}

export class DurableWorkflowScheduler {
  readonly #application: ApplicationContext;
  readonly #authorization: SchedulerAuthorization;
  readonly #computeRuntime: SchedulerComputeRuntime | undefined;
  #computeExecutor: SchedulerComputeExecutor | undefined;
  readonly #currentApplicationBuild: string;
  readonly #hostResourceCoordinator: HostResourceCoordinator;
  readonly #limits: NormalizedSchedulerLimits;
  readonly #nodePlanner: SchedulerNodePlanner;
  readonly #now: () => Date;
  readonly #owner: string;
  readonly #registry: OperationRegistry;
  readonly #replayComputeNodeKeys = new Set<string>();
  readonly #store: DurableWorkflowSchedulerOptions["store"];

  constructor(options: DurableWorkflowSchedulerOptions) {
    if (options.owner.length < 1 || options.owner.length > 256) {
      throw new ApplicationError("usage", "Scheduler owner must contain between 1 and 256 characters.");
    }
    if (
      options.authorization.grantedBy.length < 1
      || options.authorization.grantedBy.length > 256
    ) {
      throw new ApplicationError(
        "usage",
        "Authorization owner must contain between 1 and 256 characters.",
      );
    }
    this.#application = options.application;
    this.#authorization = options.authorization;
    this.#computeRuntime = options.compute;
    this.#computeExecutor = options.compute?.kind === "fresh"
      ? options.compute.executor
      : undefined;
    if (
      options.currentApplicationBuild.length < 1
      || options.currentApplicationBuild.length > 160
    ) {
      throw new ApplicationError(
        "usage",
        "Current application build must contain between 1 and 160 characters.",
      );
    }
    this.#currentApplicationBuild = options.currentApplicationBuild;
    this.#hostResourceCoordinator = options.hostResourceCoordinator;
    this.#limits = normalizeLimits(options);
    this.#nodePlanner = options.nodePlanner;
    this.#now = options.now ?? (() => new Date());
    this.#owner = options.owner;
    this.#registry = options.registry;
    this.#store = options.store;
  }

  async run(runId: string): Promise<SchedulerRunResult> {
    const graphPlan = await this.#store.graphPlan(runId);
    if (graphPlan.graph.nodes.length > this.#limits.maxNodes) {
      throw new ApplicationError(
        "incompatible",
        `Workflow has ${String(graphPlan.graph.nodes.length)} nodes; the host limit is `
        + `${String(this.#limits.maxNodes)}.`,
      );
    }
    const fence = await this.#store.acquireClaim(runId, { owner: this.#owner });
    let ownsFence = true;
    let computeExecutorLease: SchedulerComputeExecutorLease | undefined;
    const workflowDeadlineMonotonicMs = safeDeadline(
      performance.now(),
      this.#limits.maxWallClockMs,
    );
    const initialSummary = await this.#summary(runId);
    const state: MutableRunState = {
      cancelled: false,
      monitorError: undefined,
      pause: undefined,
      reconciliationDeferred: false,
      startedAt: initialSummary.startedAt ?? this.#now().toISOString(),
    };
    const running = new Map<string, RunningNode>();
    const prepared = new Map<string, PreparedNode>();
    const ledger = new ResourceLedger(this.#limits);
    const control = new WorkflowRunControl(
      workflowDeadlineMonotonicMs,
      (interruption) => {
        if (interruption.kind === "monitor") {
          state.monitorError = interruption.error;
        } else {
          state.cancelled = true;
        }
        if (interruption.kind !== "deadline") {
          for (const item of running.values()) {
            item.admissionAbortController.abort();
            if (item.cancellable) item.abortController.abort();
          }
        }
      },
    );
    let cancellationCheckActive = false;
    const cancellationTimer = setInterval(() => {
      if (cancellationCheckActive) return;
      cancellationCheckActive = true;
      void this.#cancellation(runId).then(request => {
        if (request === undefined) return;
        control.interrupt(
          "cancellation",
          new ApplicationError("cancelled", "Workflow cancellation requested."),
        );
      }).catch(error => {
        control.interrupt("monitor", asApplicationError(error));
      }).finally(() => {
        cancellationCheckActive = false;
      });
    }, this.#limits.cancellationPollMs);

    try {
      await this.#store.assertFence(fence);
      await this.#store.appendEvent(fence, {
        details: { status: "running" },
        kind: "run-status",
        timestamp: this.#now().toISOString(),
      });
      try {
        await this.#verifyRuntimeCompatibility(runId, graphPlan);
        computeExecutorLease = await this.#prepareComputeRuntime(
          fence,
          graphPlan,
          state,
          control,
        );
      } catch (error) {
        const compatibilityError = asApplicationError(error);
        if (
          compatibilityError.code !== "incompatible"
          && compatibilityError.code !== "unsupported-plan"
        ) {
          throw error;
        }
        await this.#markRunIncompatible(fence, graphPlan, state, compatibilityError);
        const summary = await this.#publishSummary(fence, graphPlan, state, 0);
        await this.#store.appendEvent(fence, {
          details: { status: summary.status },
          kind: "run-finalized",
          timestamp: this.#now().toISOString(),
        });
        await this.#store.releaseClaim(fence);
        ownsFence = false;
        return { summary };
      }
      await this.#reconcileInterrupted(fence, graphPlan, state, control);
      await this.#publishSummary(fence, graphPlan, state, running.size);
      if (state.reconciliationDeferred) {
        const summary = await this.#publishSummary(fence, graphPlan, state, 0);
        await this.#store.appendEvent(fence, {
          details: { status: summary.status },
          kind: "run-status",
          timestamp: this.#now().toISOString(),
        });
        await this.#store.releaseClaim(fence);
        ownsFence = false;
        return { summary };
      }

      while (true) {
        if (state.monitorError !== undefined) throw state.monitorError;
        await this.#store.assertFence(fence);
        if (await this.#cancellation(runId) !== undefined) {
          state.cancelled = true;
          for (const item of running.values()) {
            item.admissionAbortController.abort();
            if (item.cancellable) item.abortController.abort();
          }
        }
        if (performance.now() >= workflowDeadlineMonotonicMs) {
          state.cancelled = true;
          for (const item of running.values()) {
            item.admissionAbortController.abort();
            if (item.cancellable) item.abortController.abort();
          }
        }

        await this.#advanceDependencies(fence, graphPlan, state);
        if (state.cancelled) {
          await this.#cancelWaitingNodes(fence, graphPlan);
        } else if (state.pause === undefined) {
          await this.#prepareReadyNodes(
            fence,
            graphPlan,
            state,
            control,
            prepared,
          );
          if (state.pause === undefined) {
            await this.#startAdmittedNodes(
              fence,
              prepared,
              running,
              ledger,
              workflowDeadlineMonotonicMs,
              control,
            );
            if (state.cancelled) {
              await this.#cancelWaitingNodes(fence, graphPlan);
            }
          }
        }

        if (running.size > 0) {
          const outcome = await Promise.race(
            [...running.values()].map(async item => ({
              item,
              outcome: await item.promise,
            })),
          );
          running.delete(outcome.item.nodeKey);
          ledger.release(outcome.item.resources, outcome.item.publicationKeys);
          const reconciliationDeferred = await this.#persistOutcome(
            fence,
            graphPlan,
            outcome.item,
            outcome.outcome,
            control,
          );
          await this.#publishSummary(fence, graphPlan, state, running.size);
          if (reconciliationDeferred) {
            state.reconciliationDeferred = true;
            const summary = await this.#publishSummary(
              fence,
              graphPlan,
              state,
              running.size,
            );
            await this.#store.appendEvent(fence, {
              details: { status: summary.status },
              kind: "run-status",
              timestamp: this.#now().toISOString(),
            });
            await this.#store.releaseClaim(fence);
            ownsFence = false;
            return { summary };
          }
          continue;
        }

        const records = await this.#store.nodes(runId);
        const status = terminalStatus(records, state, 0);
        if (status === "running") {
          const impossible = await this.#failImpossibleReadyNodes(
            fence,
            graphPlan,
            ledger,
          );
          if (impossible) continue;
          throw new ApplicationError(
            "internal",
            "Workflow scheduler reached a nonterminal state without runnable work.",
          );
        }
        const summary = await this.#publishSummary(fence, graphPlan, state, 0);
        await this.#store.appendEvent(fence, {
          details: { status: summary.status },
          kind: terminalRunStatus(summary.status) ? "run-finalized" : "run-status",
          timestamp: this.#now().toISOString(),
        });
        await this.#store.releaseClaim(fence);
        ownsFence = false;
        return {
          ...(state.pause === undefined ? {} : { pause: state.pause }),
          summary,
        };
      }
    } catch (error) {
      if (
        ownsFence
        && (
          control.interruption?.kind === "cancellation"
          || control.interruption?.kind === "deadline"
        )
      ) {
        const interruptedRunning = [...running.values()].sort((left, right) => (
          left.nodeKey.localeCompare(right.nodeKey)
        ));
        if (interruptedRunning.length > 0) {
          const outcomes = await Promise.all(interruptedRunning.map(async item => ({
            item,
            outcome: await item.promise,
          })));
          running.clear();
          for (const outcome of outcomes) {
            ledger.release(outcome.item.resources, outcome.item.publicationKeys);
            const deferred = await this.#persistOutcome(
              fence,
              graphPlan,
              outcome.item,
              outcome.outcome,
              control,
            );
            state.reconciliationDeferred ||= deferred;
          }
        }
        await this.#cancelWaitingNodes(fence, graphPlan);
        const summary = await this.#publishSummary(fence, graphPlan, state, running.size);
        await this.#store.appendEvent(fence, {
          details: { status: summary.status },
          kind: terminalRunStatus(summary.status) ? "run-finalized" : "run-status",
          timestamp: this.#now().toISOString(),
        });
        await this.#store.releaseClaim(fence);
        ownsFence = false;
        return { summary };
      }
      if (ownsFence) {
        const applicationError = asApplicationError(error);
        if (applicationError.code !== "conflict") {
          await this.#markSchedulerFailure(fence, graphPlan, state, applicationError).catch(
            () => undefined,
          );
        }
      }
      throw error;
    } finally {
      clearInterval(cancellationTimer);
      control.stop();
      if (ownsFence) {
        await this.#store.releaseClaim(fence).catch(() => undefined);
      }
      await computeExecutorLease?.release().catch(() => undefined);
    }
  }

  async #summary(runId: string): Promise<RunSummary> {
    return await this.#store.summary(runId);
  }

  async #cancellation(runId: string): Promise<CancellationRequest | undefined> {
    let lastConflict: ApplicationError | undefined;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await this.#store.cancellation(runId);
      } catch (error) {
        const applicationError = asApplicationError(error);
        if (applicationError.code !== "conflict") throw error;
        lastConflict = applicationError;
        await Promise.resolve();
      }
    }
    throw lastConflict ?? new ApplicationError(
      "conflict",
      `Could not read a stable cancellation marker for ${runId}.`,
    );
  }

  async #assertWorkflowActive(
    fence: RunFence,
    control: WorkflowRunControl,
  ): Promise<void> {
    control.assertActive();
    const cancellation = await control.race(async () =>
      await this.#cancellation(fence.runId)
    );
    if (cancellation !== undefined) {
      control.interrupt(
        "cancellation",
        new ApplicationError("cancelled", "Workflow cancellation requested."),
      );
      control.assertActive();
    }
  }

  async #runControlledPort<Value>(
    fence: RunFence,
    control: WorkflowRunControl,
    execute: () => Promise<Value>,
  ): Promise<Value> {
    await this.#assertWorkflowActive(fence, control);
    const value = await control.race(execute);
    control.assertActive();
    return value;
  }

  async #verifyRuntimeCompatibility(runId: string, graphPlan: GraphPlanV1): Promise<void> {
    if (graphPlan.runtime.applicationBuild !== this.#currentApplicationBuild) {
      throw new ApplicationError(
        "incompatible",
        "Persisted workflow application build differs from the current host build.",
      );
    }
    const runtime = await this.#store.runtime(runId);
    if (canonicalJson(runtime.runtime) !== canonicalJson(graphPlan.runtime)) {
      throw new ApplicationError("incompatible", "Persisted workflow runtime identity changed.");
    }
    const expected = [...new Set(graphPlan.graph.nodes
      .filter(isOperationGraphNode)
      .map(node => (
        `${node.executor.operation.kind}@${String(node.executor.operation.version)}`
      )))].sort((left, right) => left.localeCompare(right));
    const persisted = runtime.operations.map(operation => (
      `${operation.kind}@${String(operation.version)}`
    )).sort((left, right) => left.localeCompare(right));
    if (canonicalJson(expected) !== canonicalJson(persisted)) {
      throw new ApplicationError("incompatible", "Persisted operation runtime set changed.");
    }
    const expectedComputes = [...new Map(
      graphPlan.graph.nodes
        .filter(isComputeGraphNode)
        .map(node => [node.executor.compute.key, node.executor.compute]),
    ).values()].sort((left, right) => left.key.localeCompare(right.key));
    if (canonicalJson(expectedComputes) !== canonicalJson(runtime.computes)) {
      throw new ApplicationError("incompatible", "Persisted compute runtime set changed.");
    }
    for (const node of graphPlan.graph.nodes) {
      if (isOperationGraphNode(node)) {
        operationForNode(graphPlan, node, this.#registry);
      }
    }
  }

  async #prepareComputeRuntime(
    fence: RunFence,
    graphPlan: GraphPlanV1,
    state: MutableRunState,
    control: WorkflowRunControl,
  ): Promise<SchedulerComputeExecutorLease | undefined> {
    const runtime = this.#computeRuntime;
    if (runtime === undefined) return;
    if (runtime.kind === "fresh") {
      if (runtime.executor.bundleSha256 !== graphPlan.bundle.bundleSha256) {
        throw new ApplicationError(
          "incompatible",
          "Fresh code worker bundle does not match the persisted graph plan.",
        );
      }
      this.#computeExecutor = runtime.executor;
      return;
    }
    const nodeKeys = [...new Set(runtime.nodeKeys.map(key => NodeKeySchema.parse(key)))]
      .sort((left, right) => left.localeCompare(right));
    if (nodeKeys.length === 0) {
      throw new ApplicationError(
        "usage",
        "A compute replay requires at least one exact node key.",
      );
    }
    if (await this.#cancellation(fence.runId) !== undefined) {
      state.cancelled = true;
      return;
    }
    const records = await this.#store.nodes(fence.runId);
    const nodesByKey = new Map(graphPlan.graph.nodes.map(node => [node.key, node]));
    const grants: NewRunGrant[] = [];
    for (const nodeKey of nodeKeys) {
      const node = nodesByKey.get(nodeKey);
      const record = records.find(candidate => candidate.nodeKey === nodeKey);
      if (
        node === undefined
        || !isComputeGraphNode(node)
        || record?.status !== "ambiguous-code"
        || record.executionPlan === undefined
      ) {
        throw new ApplicationError(
          "conflict",
          `Compute node is not awaiting exact replay: ${nodeKey}`,
        );
      }
      grants.push({
        attempt: record.attempt + 1,
        bundleSha256: graphPlan.bundle.bundleSha256,
        computeKey: node.executor.compute.key,
        createdAt: this.#now().toISOString(),
        graphPlanSha256: graphPlan.graphPlanSha256,
        grantedBy: this.#authorization.grantedBy,
        grantId: randomUUID(),
        kind: "compute-replay",
        nodeKey,
        nodePlanSha256: record.executionPlan.nodePlanSha256,
      });
    }
    for (const grant of grants) {
      if (await this.#cancellation(fence.runId) !== undefined) {
        state.cancelled = true;
        return;
      }
      await this.#store.appendGrant(fence, grant);
    }
    if (await this.#cancellation(fence.runId) !== undefined) {
      state.cancelled = true;
      return;
    }
    await this.#assertWorkflowActive(fence, control);
    const remainingMilliseconds = control.deadlineMonotonicMs - performance.now();
    if (remainingMilliseconds <= 0) {
      control.interrupt(
        "deadline",
        new ApplicationError(
          "cancelled",
          "Workflow exceeded the host wall-clock bound.",
        ),
      );
      control.assertActive();
    }
    const load = runtime.load({
      signal: control.signal,
      waitTimeoutMilliseconds: Math.min(
        HOST_RESOURCE_MAX_WAIT_MILLISECONDS,
        Math.max(1, Math.ceil(remainingMilliseconds)),
      ),
    });
    let lease: SchedulerComputeExecutorLease;
    try {
      lease = await control.race(async () => await load);
    } catch (error) {
      // Cancellation may win after replay admission has already entered its
      // callback. Keep the scheduler return bounded, but make the eventual
      // executor owner close anything that settles after the run fence leaves.
      void load.then(
        async lateLease => await lateLease.release(),
        () => undefined,
      ).catch(() => undefined);
      throw error;
    }
    try {
      control.assertActive();
      if (lease.executor.bundleSha256 !== graphPlan.bundle.bundleSha256) {
        throw new ApplicationError(
          "incompatible",
          "Replay code worker bundle does not match the persisted graph plan.",
        );
      }
      this.#computeExecutor = lease.executor;
      for (const nodeKey of nodeKeys) this.#replayComputeNodeKeys.add(nodeKey);
      for (const nodeKey of nodeKeys) {
        await this.#store.reopenComputeNode(fence, nodeKey);
      }
      return lease;
    } catch (error) {
      await lease.release().catch(() => undefined);
      throw error;
    }
  }

  async #reconcileInterrupted(
    fence: RunFence,
    graphPlan: GraphPlanV1,
    state: MutableRunState,
    control: WorkflowRunControl,
  ): Promise<void> {
    const records = await this.#store.nodes(fence.runId);
    const recordsByKey = new Map(records.map(record => [record.nodeKey, record]));
    for (const node of [...graphPlan.graph.nodes].sort((left, right) => (
      left.key.localeCompare(right.key)
    ))) {
      const record = recordsByKey.get(node.key);
      if (record === undefined) {
        throw new ApplicationError("invalid-data", `Run is missing node ${node.key}.`);
      }
      if (record.status === "completed") {
        verifiedOutput(record);
        await this.#store.appendEvent(fence, {
          details: { digestSha256: record.output?.digestSha256 ?? "" },
          kind: "node-reused",
          nodeKey: node.key,
          timestamp: this.#now().toISOString(),
        });
        continue;
      }
      if (record.status === "approval-required") continue;
      if (record.status === "preparing") {
        await this.#persistNode(fence, {
          ...record,
          status: "ready",
        });
        continue;
      }
      if (record.status !== "running") continue;

      if (isComputeGraphNode(node)) {
        await this.#persistNode(fence, {
          ...record,
          failure: schedulerFailure(new ApplicationError(
            "ambiguous",
            "Interrupted trusted compute requires an explicit exact-bundle replay.",
          )),
          finishedAt: this.#now().toISOString(),
          status: "ambiguous-code",
        });
        continue;
      }
      if (!isOperationGraphNode(node)) {
        throw new ApplicationError(
          "internal",
          `Unknown node executor for ${node.key}.`,
        );
      }

      const resumeClass = operationForNode(
        graphPlan,
        node,
        this.#registry,
      ).discovery.policy.resume;
      if (resumeClass === "deterministic") {
        await this.#persistNode(fence, {
          ...record,
          failure: undefined,
          finishedAt: undefined,
          status: "ready",
        });
        continue;
      }
      const reconciled = await this.#reconcileOperationRecord(
        fence,
        graphPlan,
        node,
        record,
        recordsByKey,
        control,
      );
      if (reconciled.deferred) {
        state.reconciliationDeferred = true;
        if (control.interruption !== undefined) break;
        continue;
      }
      if (
        reconciled.reconciliation?.kind === "ambiguous"
        && resumeClass === "non-resumable-live"
      ) {
        state.cancelled = false;
      }
    }
  }

  async #reconcileOperationRecord(
    fence: RunFence,
    graphPlan: GraphPlanV1,
    node: AuthoredOperationGraphNodeV1,
    record: RunNodeRecord,
    recordsByKey: ReadonlyMap<string, RunNodeRecord>,
    control: WorkflowRunControl,
  ): Promise<{
    readonly deferred: boolean;
    readonly reconciliation: NodeReconciliation | undefined;
  }> {
    const operation = operationForNode(graphPlan, node, this.#registry);
    const resolved = resolveNode(node, recordsByKey);
    const resumeClass = operation.discovery.policy.resume;
    await this.#store.assertFence(fence);
    const workspaceDirectory = record.executionPlan === undefined
      ? undefined
      : await this.#store.stagingDirectory(
          fence,
          node.key,
          record.executionPlan.nodePlanSha256,
        );
    let reconciliation: NodeReconciliation | undefined;
    try {
      reconciliation = this.#nodePlanner.reconcile === undefined
        ? undefined
        : await this.#runControlledPort(
            fence,
            control,
            async () => await this.#hostResourceCoordinator.withLease(
              physicalHostResourceClaims(
                operation.discovery.policy.resources,
                this.#hostResourceCoordinator,
              ),
              async lease => {
                await lease.assertOwned();
                const beforePublication = async (): Promise<void> => {
                  await lease.assertOwned();
                  control.assertActive();
                  if (control.signal.aborted) {
                    throw new ApplicationError(
                      "cancelled",
                      "Workflow reconciliation was cancelled before publication.",
                    );
                  }
                  await this.#store.assertFence(fence);
                  await this.#assertWorkflowActive(fence, control);
                  await this.#store.assertFence(fence);
                  control.assertActive();
                  await lease.assertOwned();
                };
                const request: NodeReconciliationRequest = {
                  abortSignal: control.signal,
                  application: applicationWithHostResourceLease(
                    this.#application,
                    lease,
                  ),
                  beforePublication,
                  dependencyOutputs: resolved.dependencyOutputs,
                  executionPlan: record.executionPlan,
                  graphPlan,
                  node,
                  operation: operation.discovery,
                  preparationPlan: record.preparationPlan,
                  previous: record,
                  resolvedInput: resolved.input,
                  resumeClass,
                  runId: fence.runId,
                  ...(workspaceDirectory === undefined
                    ? {}
                    : { workspaceDirectory }),
                };
                return await this.#nodePlanner.reconcile!(request);
              },
              {
                signal: control.signal,
                waitTimeoutMilliseconds: HOST_RESOURCE_MAX_WAIT_MILLISECONDS,
              },
            ),
          );
    } catch {
      // A reconciliation adapter may fail or outlive this scheduler invocation.
      // Preserve the durable running record so a later fenced owner can retry
      // reconciliation instead of converting a possibly published effect into
      // an immutable failed node.
      await this.#store.assertFence(fence);
      return { deferred: true, reconciliation: undefined };
    }
    await this.#store.assertFence(fence);
    await this.#applyReconciliation(
      fence,
      record,
      operation,
      resumeClass,
      reconciliation,
    );
    return { deferred: false, reconciliation };
  }

  async #applyReconciliation(
    fence: RunFence,
    record: RunNodeRecord,
    operation: RegisteredOperation,
    resumeClass: OperationResumeClass,
    reconciliation: NodeReconciliation | undefined,
  ): Promise<void> {
    if (reconciliation?.kind === "completed") {
      const output = createRunNodeOutput(
        reconciliation.output,
        reconciliation.summary,
        operation.discovery.policy.maxOutputBytes,
        reconciliation.receiptReference,
      );
      await this.#persistNode(fence, {
        ...record,
        failure: undefined,
        finishedAt: this.#now().toISOString(),
        output,
        status: "completed",
      });
      return;
    }
    const retryAllowed = resumeClass === "verified-receipt"
      || resumeClass === "recoverable-transaction";
    if (reconciliation?.kind === "retry" && retryAllowed) {
      await this.#persistNode(fence, {
        ...record,
        failure: undefined,
        finishedAt: undefined,
        status: "ready",
      });
      return;
    }
    if (reconciliation?.kind === "incompatible") {
      await this.#persistNode(fence, {
        ...record,
        failure: schedulerFailure(
          new ApplicationError("incompatible", reconciliation.message),
        ),
        finishedAt: this.#now().toISOString(),
        status: "incompatible",
      });
      return;
    }
    const message = reconciliation?.kind === "ambiguous"
      ? reconciliation.message
      : resumeClass === "non-resumable-live"
        ? "Interrupted live operation requires explicit operator reconciliation."
        : resumeClass === "ambiguous-after-dispatch"
          ? "Interrupted paid operation has an ambiguous dispatch outcome."
          : "Interrupted operation has no compatible reconciliation implementation.";
    const status = resumeClass === "verified-receipt"
      || resumeClass === "recoverable-transaction"
      ? "incompatible"
      : "ambiguous";
    await this.#persistNode(fence, {
      ...record,
      failure: schedulerFailure(new ApplicationError(
        status === "incompatible" ? "incompatible" : "ambiguous",
        message,
      )),
      finishedAt: this.#now().toISOString(),
      status,
    });
  }

  async #advanceDependencies(
    fence: RunFence,
    graphPlan: GraphPlanV1,
    state: MutableRunState,
  ): Promise<void> {
    let changed = true;
    while (changed) {
      changed = false;
      const records = await this.#store.nodes(fence.runId);
      const recordsByKey = new Map(records.map(record => [record.nodeKey, record]));
      for (const node of [...graphPlan.graph.nodes].sort((left, right) => (
        left.key.localeCompare(right.key)
      ))) {
        const record = recordsByKey.get(node.key);
        if (record === undefined || record.status !== "pending") continue;
        const dependencies = node.dependencies.map(key => recordsByKey.get(key));
        if (dependencies.some(dependency => dependency === undefined)) {
          throw new ApplicationError("invalid-data", `Node ${node.key} has a missing dependency.`);
        }
        if (dependencies.some(dependency => (
          dependency !== undefined && dependencyTerminalFailure(dependency)
        ))) {
          const updated = {
            ...record,
            finishedAt: this.#now().toISOString(),
            status: state.cancelled ? "cancelled" : "skipped",
          } satisfies RunNodeRecord;
          await this.#persistNode(fence, updated);
          // The durable node write and matching audit event both succeeded.
          // Carry that authoritative transition through this pass so a long
          // failed-dependency chain does not require one full store scan per
          // skipped node. The final unchanged pass still reloads and validates
          // the complete persisted node set.
          recordsByKey.set(node.key, updated);
          changed = true;
          continue;
        }
        if (dependencies.every(dependency => dependency?.status === "completed")) {
          const updated = {
            ...record,
            status: "ready",
          } satisfies RunNodeRecord;
          await this.#persistNode(fence, updated);
          recordsByKey.set(node.key, updated);
          changed = true;
        }
      }
    }
  }

  async #prepareReadyNodes(
    fence: RunFence,
    graphPlan: GraphPlanV1,
    state: MutableRunState,
    control: WorkflowRunControl,
    prepared: Map<string, PreparedNode>,
  ): Promise<void> {
    const records = await this.#store.nodes(fence.runId);
    const recordsByKey = new Map(records.map(record => [record.nodeKey, record]));
    const nodesByKey = new Map(graphPlan.graph.nodes.map(node => [node.key, node]));
    for (const record of records
      .filter(item => item.status === "ready" || item.status === "approval-required")
      .sort((left, right) => left.nodeKey.localeCompare(right.nodeKey))) {
      if (state.pause !== undefined || state.cancelled) break;
      if (prepared.has(record.nodeKey)) continue;
      await this.#assertWorkflowActive(fence, control);
      const node = nodesByKey.get(record.nodeKey);
      if (node === undefined) {
        throw new ApplicationError("invalid-data", `Run contains unknown node ${record.nodeKey}.`);
      }
      const executor = executorForNode(graphPlan, node, this.#registry);
      const resolved = resolveNode(node, recordsByKey);
      let context: NodePreparationRequest | undefined;
      if (executor.kind === "operation") {
        if (!isOperationGraphNode(node)) {
          throw new ApplicationError(
            "internal",
            `Node executor classification changed for ${node.key}.`,
          );
        }
        context = {
          dependencyOutputs: resolved.dependencyOutputs,
          graphPlan,
          node,
          operation: executor.operation.discovery,
          resolvedInput: resolved.input,
          runId: fence.runId,
        };
      }
      let preparationPlan = record.preparationPlan;
      if (preparationPlan === undefined) {
        await this.#persistNode(fence, {
          ...record,
          status: "preparing",
        });
        await this.#store.assertFence(fence);
        const binding = context === undefined
          ? computePreparationBinding(resolved)
          : await this.#runControlledPort(
              fence,
              control,
              async () => await this.#nodePlanner.prepare(context),
            );
        preparationPlan = createPreparationPlan(
          graphPlan,
          node,
          executor.policy,
          binding,
        );
      } else {
        verifyPreparationPlan(preparationPlan, graphPlan, node, executor.policy);
      }

      const preparationAuthorized = await this.#authorizePreparation(
        fence,
        graphPlan,
        node,
        executor,
        preparationPlan,
        control,
      );
      if (!preparationAuthorized) {
        const paused = RunNodeRecordSchema.parse({
          ...record,
          preparationPlan,
          status: "approval-required",
          version: RUN_NODE_VERSION,
        });
        await this.#persistNode(fence, paused);
        state.pause = {
          nodeKey: node.key,
          phase: "preparation",
          planSha256: preparationPlan.preparationPlanSha256,
        };
        await this.#store.appendEvent(fence, {
          details: {
            phase: "preparation",
            planSha256: preparationPlan.preparationPlanSha256,
          },
          kind: "approval-required",
          nodeKey: node.key,
          timestamp: this.#now().toISOString(),
        });
        break;
      }

      let executionPlan = record.executionPlan;
      if (executionPlan === undefined) {
        await this.#store.assertFence(fence);
        const binding = context === undefined
          ? {
              exactInput: resolved.input,
              publicationKeys: [],
            }
          : await this.#runControlledPort(
              fence,
              control,
              async () => await this.#nodePlanner.plan({
                ...context,
                preparationPlan,
              }),
            );
        executionPlan = createExecutionPlan(
          graphPlan,
          node,
          executor.policy,
          preparationPlan,
          resolved,
          binding,
        );
      } else {
        verifyExecutionPlan(
          executionPlan,
          graphPlan,
          node,
          executor.policy,
          preparationPlan,
          resolved,
        );
      }

      const effectAuthorized = await this.#authorizeEffect(
        fence,
        graphPlan,
        node,
        executor,
        executionPlan,
        control,
      );
      if (!effectAuthorized) {
        const paused = RunNodeRecordSchema.parse({
          ...record,
          executionPlan,
          preparationPlan,
          status: "approval-required",
          version: RUN_NODE_VERSION,
        });
        await this.#persistNode(fence, paused);
        state.pause = {
          nodeKey: node.key,
          phase: "effect",
          planSha256: executionPlan.nodePlanSha256,
        };
        await this.#store.appendEvent(fence, {
          details: {
            phase: "effect",
            planSha256: executionPlan.nodePlanSha256,
          },
          kind: "approval-required",
          nodeKey: node.key,
          timestamp: this.#now().toISOString(),
        });
        break;
      }

      const ready = RunNodeRecordSchema.parse({
        ...record,
        executionPlan,
        failure: undefined,
        preparationPlan,
        status: "ready",
        version: RUN_NODE_VERSION,
      });
      if (
        record.status !== "ready"
        || record.preparationPlan === undefined
        || record.executionPlan === undefined
        || record.failure !== undefined
      ) {
        await this.#persistNode(fence, ready);
      }
      recordsByKey.set(node.key, ready);
      prepared.set(node.key, {
        executionPlan,
        executor,
        record: ready,
        resolved,
      });
    }
  }

  async #authorizePreparation(
    fence: RunFence,
    graphPlan: GraphPlanV1,
    node: AuthoredGraphNodeV1,
    executor: ResolvedNodeExecutor,
    preparationPlan: NodePreparationPlan,
    control: WorkflowRunControl,
  ): Promise<boolean> {
    if (preparationPlan.requestedPreparation.length === 0) return true;
    const grants = await this.#store.grants(fence.runId);
    if (exactPreparationGrant(
      grants,
      graphPlan.graphPlanSha256,
      preparationPlan.nodeKey,
      preparationPlan.preparationPlanSha256,
    )) return true;
    const allowed = authorizationAllowed(await this.#runControlledPort(
      fence,
      control,
      async () => await this.#authorization.authorizePreparation({
        executor: node.executor,
        graphPlanSha256: graphPlan.graphPlanSha256,
        nodeKey: preparationPlan.nodeKey,
        ...(executor.kind === "operation"
          ? { operation: executor.operation.discovery }
          : {}),
        policy: executor.policy,
        preparationPlan,
        runId: fence.runId,
      }),
    ));
    if (!allowed) return false;
    const grant: NewRunGrant = {
      createdAt: this.#now().toISOString(),
      graphPlanSha256: graphPlan.graphPlanSha256,
      grantedBy: this.#authorization.grantedBy,
      grantId: randomUUID(),
      kind: "preparation",
      nodeKey: preparationPlan.nodeKey,
      preparationPlanSha256: preparationPlan.preparationPlanSha256,
    };
    await this.#assertWorkflowActive(fence, control);
    await this.#store.appendGrant(fence, grant);
    return true;
  }

  async #authorizeEffect(
    fence: RunFence,
    graphPlan: GraphPlanV1,
    node: AuthoredGraphNodeV1,
    executor: ResolvedNodeExecutor,
    executionPlan: NodeExecutionPlan,
    control: WorkflowRunControl,
  ): Promise<boolean> {
    const grants = await this.#store.grants(fence.runId);
    if (exactEffectGrant(
      grants,
      graphPlan.graphPlanSha256,
      executionPlan.nodeKey,
      executionPlan.nodePlanSha256,
    )) return true;
    const allowed = authorizationAllowed(await this.#runControlledPort(
      fence,
      control,
      async () => await this.#authorization.authorizeEffect({
        executor: node.executor,
        executionPlan,
        graphPlanSha256: graphPlan.graphPlanSha256,
        nodeKey: executionPlan.nodeKey,
        ...(executor.kind === "operation"
          ? { operation: executor.operation.discovery }
          : {}),
        policy: executor.policy,
        runId: fence.runId,
      }),
    ));
    if (!allowed) return false;
    const grant: NewRunGrant = {
      createdAt: this.#now().toISOString(),
      graphPlanSha256: graphPlan.graphPlanSha256,
      grantedBy: this.#authorization.grantedBy,
      grantId: randomUUID(),
      kind: "effect",
      nodeKey: executionPlan.nodeKey,
      nodePlanSha256: executionPlan.nodePlanSha256,
    };
    await this.#assertWorkflowActive(fence, control);
    await this.#store.appendGrant(fence, grant);
    return true;
  }

  async #startAdmittedNodes(
    fence: RunFence,
    prepared: Map<string, PreparedNode>,
    running: Map<string, RunningNode>,
    ledger: ResourceLedger,
    workflowDeadlineMonotonicMs: number,
    control: WorkflowRunControl,
  ): Promise<void> {
    for (const item of [...prepared.values()].sort((left, right) => (
      left.record.nodeKey.localeCompare(right.record.nodeKey)
    ))) {
      if (performance.now() >= workflowDeadlineMonotonicMs) {
        control.interrupt("deadline", new ApplicationError(
          "cancelled",
          "Workflow exceeded the host wall-clock bound.",
        ));
        break;
      }
      const resources = item.executor.policy.resources;
      if (ledger.impossible(resources)) {
        await this.#persistNode(fence, {
          ...item.record,
          failure: schedulerFailure(new ApplicationError(
            "incompatible",
            `Node ${item.record.nodeKey} exceeds the host resource ceiling.`,
          )),
          finishedAt: this.#now().toISOString(),
          status: "incompatible",
        });
        prepared.delete(item.record.nodeKey);
        continue;
      }
      if (!ledger.acquire(resources, item.executionPlan.publicationKeys)) continue;
      try {
        await this.#store.assertFence(fence);
        if (await this.#cancellation(fence.runId) !== undefined) {
          ledger.release(resources, item.executionPlan.publicationKeys);
          control.interrupt("cancellation", new ApplicationError(
            "cancelled",
            "Workflow cancellation requested.",
          ));
          break;
        }
        const admissionAbortController = new AbortController();
        const abortController = new AbortController();
        const runningRecord = RunNodeRecordSchema.parse({
          ...item.record,
          attempt: item.record.attempt + 1,
          startedAt: this.#now().toISOString(),
          status: "running",
          version: RUN_NODE_VERSION,
        });
        await this.#persistNode(fence, runningRecord);
        prepared.delete(item.record.nodeKey);
        const runningNode: RunningNode = {
          admissionAbortController,
          abortController,
          cancellable: item.executor.policy.cancellable,
          executionPlan: item.executionPlan,
          nodeKey: item.record.nodeKey,
          promise: this.#executeNode(
            fence,
            item,
            admissionAbortController,
            abortController,
            workflowDeadlineMonotonicMs,
          ),
          publicationKeys: item.executionPlan.publicationKeys,
          resources,
        };
        running.set(item.record.nodeKey, runningNode);
      } catch (error) {
        ledger.release(resources, item.executionPlan.publicationKeys);
        throw error;
      }
    }
  }

  async #executeNode(
    fence: RunFence,
    item: PreparedNode,
    admissionAbortController: AbortController,
    abortController: AbortController,
    workflowDeadlineMonotonicMs: number,
  ): Promise<NodeExecutionOutcome> {
    let timedOut = false;
    let deadlineKind: NodeDeadlineKind | undefined;
    let publicationMayBeAuthoritative = false;
    let computeDispatched = false;
    const nodeDeadlineMonotonicMs = safeDeadline(
      performance.now(),
      item.executor.policy.maxDurationMs,
    );
    const effectiveDeadlineMonotonicMs = Math.min(
      nodeDeadlineMonotonicMs,
      workflowDeadlineMonotonicMs,
    );
    const effectiveDeadlineKind: NodeDeadlineKind = (
      workflowDeadlineMonotonicMs <= nodeDeadlineMonotonicMs
    )
      ? "workflow"
      : "node";
    let rejectDeadline!: (error: ApplicationError) => void;
    const deadlinePromise = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const deadlineError = () => new ApplicationError(
      "unavailable",
      effectiveDeadlineKind === "workflow"
        ? "Workflow exceeded the host wall-clock bound."
        : "Operation exceeded its registered duration bound.",
    );
    const cancelDeadline = scheduleDeadline(effectiveDeadlineMonotonicMs, () => {
      timedOut = true;
      deadlineKind = effectiveDeadlineKind;
      rejectDeadline(deadlineError());
      admissionAbortController.abort();
      if (item.executor.policy.cancellable) abortController.abort();
    });
    const beforeDeadline = async <Value>(
      execute: () => Promise<Value>,
    ): Promise<Value> => {
      if (timedOut) throw deadlineError();
      return await Promise.race([execute(), deadlinePromise]);
    };
    const assertPublicationAllowed = () => {
      if (timedOut) {
        throw new ApplicationError(
          "cancelled",
          "Workflow node deadline expired before publication.",
        );
      }
    };
    try {
      await beforeDeadline(async () => await this.#store.assertFence(fence));
      if (await beforeDeadline(async () => await this.#cancellation(fence.runId)) !== undefined) {
        throw new ApplicationError("cancelled", "Workflow cancellation requested.");
      }
      if (
        item.executor.policy.effect === "paid-cloud"
        || item.executionPlan.publicationKeys.length > 0
      ) {
        await beforeDeadline(async () => await this.#store.assertFence(fence));
        if (
          await beforeDeadline(async () => await this.#cancellation(fence.runId))
          !== undefined
        ) {
          throw new ApplicationError(
            "cancelled",
            "Workflow cancellation requested before dispatch or publication.",
          );
        }
      }
      const executeOperation = async (lease: HostResourceLease) => {
        if (item.executor.kind !== "operation") {
          throw new ApplicationError(
            "internal",
            `Compute node ${item.record.nodeKey} entered operation execution.`,
          );
        }
        await beforeDeadline(async () => await this.#store.assertFence(fence));
        if (
          await beforeDeadline(async () => await this.#store.cancellation(fence.runId))
          !== undefined
        ) {
          throw new ApplicationError(
            "cancelled",
            "Workflow cancellation requested before project publication.",
          );
        }
        const workspaceDirectory = await beforeDeadline(async () =>
          await this.#store.stagingDirectory(
            fence,
            item.record.nodeKey,
            item.executionPlan.nodePlanSha256,
          )
        );
        await lease.assertOwned();
        const leasedApplication = applicationWithHostResourceLease(
          this.#application,
          lease,
        );
        return await item.executor.operation.execute({
          abortSignal: abortController.signal,
          application: leasedApplication,
          ...(item.executionPlan.expectedProjectGeneration === undefined
            ? {}
            : { expectedProjectGeneration: item.executionPlan.expectedProjectGeneration }),
          runFence: {
            generation: fence.generation,
            owner: fence.owner,
            token: fence.token,
          },
          workflow: {
            beforePublication: async () => {
              assertPublicationAllowed();
              await lease.assertOwned();
              await beforeDeadline(async () => await this.#store.assertFence(fence));
              assertPublicationAllowed();
              if (
                await beforeDeadline(async () => await this.#cancellation(fence.runId))
                !== undefined
              ) {
                throw new ApplicationError(
                  "cancelled",
                  "Workflow cancellation requested before publication.",
                );
              }
              assertPublicationAllowed();
              publicationMayBeAuthoritative = true;
            },
            nodeKey: item.record.nodeKey,
            nodePlanSha256: item.executionPlan.nodePlanSha256,
            runId: fence.runId,
            workspaceDirectory,
          },
        }, item.executionPlan.exactInput);
      };
      const hostClaims = physicalHostResourceClaims(
        item.executor.policy.resources,
        this.#hostResourceCoordinator,
      );
      const hostLeaseOptions = {
        signal: admissionAbortController.signal,
        waitTimeoutMilliseconds: Math.min(
          HOST_RESOURCE_MAX_WAIT_MILLISECONDS,
          Math.max(
            1,
            Math.floor(effectiveDeadlineMonotonicMs - performance.now()),
          ),
        ),
      } as const;
      let output: RunNodeOutput;
      if (item.executor.kind === "compute") {
        const compute = item.executor.compute;
        const computeExecutor = this.#computeExecutor;
        const replayAuthorized = this.#computeRuntime?.kind !== "replay"
          || this.#replayComputeNodeKeys.has(item.record.nodeKey);
        if (computeExecutor === undefined || !replayAuthorized) {
          return {
            failure: schedulerFailure(new ApplicationError(
              "ambiguous",
              "Trusted compute requires explicit authorization to reload its exact persisted bundle.",
            )),
            kind: "ambiguous-code",
          };
        }
        const execution = this.#hostResourceCoordinator.withLease(
          hostClaims,
          async lease => {
            await lease.assertOwned();
            computeDispatched = true;
            return await computeExecutor.execute({
              abortSignal: abortController.signal,
              computeKey: compute.key,
              ...(lease.inheritedFileDescriptor < 3
                ? {}
                : {
                    inheritedHostResourceFileDescriptor:
                      lease.inheritedFileDescriptor,
                  }),
              input: item.executionPlan.exactInput,
              nodeKey: item.record.nodeKey,
              replayAcknowledged: this.#computeRuntime?.kind === "replay",
              timeoutMs: Math.max(
                1,
                Math.floor(effectiveDeadlineMonotonicMs - performance.now()),
              ),
            });
          },
          hostLeaseOptions,
        );
        const value = await beforeDeadline(async () => await execution);
        await beforeDeadline(async () => await this.#store.assertFence(fence));
        output = createRunNodeOutput(
          value,
          {
            computeKey: compute.key,
            trustedCode: true,
          },
          item.executor.policy.maxOutputBytes,
        );
      } else {
        const operation = item.executor.operation;
        const projectPublication = item.executionPlan.publicationKeys.some(
          key => key.startsWith("project:"),
        );
        const execution = this.#hostResourceCoordinator.withLease(
          hostClaims,
          async lease => projectPublication
            ? await withProjectPublicationLease(
                this.#application,
                operation.discovery.kind,
                item.executionPlan.exactInput,
                async () => await executeOperation(lease),
              )
            : await executeOperation(lease),
          hostLeaseOptions,
        );
        const result = await beforeDeadline(async () => await execution);
        await beforeDeadline(async () => await this.#store.assertFence(fence));
        output = createRunNodeOutput(
          result.output,
          result.summary.fields,
          item.executor.policy.maxOutputBytes,
          result.receiptReference,
        );
      }
      return { kind: "completed", output };
    } catch (error) {
      const normalized = asSchedulerApplicationError(error);
      if (item.executor.kind === "compute") {
        const cancelledBeforeDispatch = normalized.code === "cancelled"
          && !computeDispatched;
        if (cancelledBeforeDispatch) {
          return {
            failure: schedulerFailure(
              new ApplicationError("cancelled", "Workflow node was cancelled."),
            ),
            kind: "cancelled",
          };
        }
        if (
          normalized.code === "invalid-data"
          || normalized.code === "unsupported-plan"
          || normalized.code === "incompatible"
        ) {
          return {
            failure: schedulerFailure(normalized),
            kind: "failed",
          };
        }
        return {
          failure: schedulerFailure(new ApplicationError(
            "ambiguous",
            timedOut
              ? deadlineKind === "workflow"
                ? "Trusted compute exceeded the workflow wall-clock bound and requires explicit replay."
                : "Trusted compute exceeded its duration bound and requires explicit replay."
              : `Trusted compute was interrupted and requires explicit replay: ${normalized.message}`,
          )),
          kind: "ambiguous-code",
        };
      }
      if (
        publicationMayBeAuthoritative
        && (
          item.executor.policy.resume === "verified-receipt"
          || item.executor.policy.resume === "recoverable-transaction"
        )
      ) {
        return {
          failure: schedulerFailure(new ApplicationError(
            "ambiguous",
            timedOut
              ? deadlineKind === "workflow"
                ? "Recoverable publication exceeded the workflow wall-clock bound."
                : "Recoverable publication exceeded its duration bound."
              : `Recoverable publication requires reconciliation: ${normalized.message}`,
          )),
          kind: "interrupted",
        };
      }
      const cancelled = normalized.code === "cancelled"
        || (abortController.signal.aborted && !timedOut);
      if (cancelled) {
        return {
          failure: schedulerFailure(
            new ApplicationError("cancelled", "Workflow node was cancelled."),
          ),
          kind: "cancelled",
        };
      }
      if (
        item.executor.policy.resume === "ambiguous-after-dispatch"
        || item.executor.policy.resume === "non-resumable-live"
      ) {
        return {
          failure: schedulerFailure(new ApplicationError(
            "ambiguous",
            timedOut
              ? deadlineKind === "workflow"
                ? "Operation exceeded the workflow wall-clock bound after dispatch."
                : "Operation exceeded its duration bound after dispatch."
              : normalized.message,
          )),
          kind: "ambiguous",
        };
      }
      return {
        failure: schedulerFailure(
          timedOut
            ? new ApplicationError(
              "unavailable",
              deadlineKind === "workflow"
                ? "Operation exceeded the workflow wall-clock bound."
                : "Operation exceeded its registered duration bound.",
            )
            : normalized,
          normalized.code === "unavailable" || normalized.code === "subprocess",
        ),
        kind: "failed",
      };
    } finally {
      cancelDeadline();
    }
  }

  async #persistOutcome(
    fence: RunFence,
    graphPlan: GraphPlanV1,
    running: RunningNode,
    outcome: NodeExecutionOutcome,
    control: WorkflowRunControl,
  ): Promise<boolean> {
    await this.#store.assertFence(fence);
    const current = await this.#store.node(fence.runId, running.nodeKey);
    if (outcome.kind === "completed") {
      await this.#persistNode(fence, {
        ...current,
        failure: undefined,
        finishedAt: this.#now().toISOString(),
        output: outcome.output,
        status: "completed",
      });
      return false;
    }
    if (outcome.kind === "interrupted") {
      const node = graphPlan.graph.nodes.find(item => item.key === running.nodeKey);
      if (node === undefined || !isOperationGraphNode(node)) {
        throw new ApplicationError(
          "invalid-data",
          `Missing recoverable operation node ${running.nodeKey}.`,
        );
      }
      const records = await this.#store.nodes(fence.runId);
      const recordsByKey = new Map(records.map(record => [record.nodeKey, record]));
      const reconciled = await this.#reconcileOperationRecord(
        fence,
        graphPlan,
        node,
        current,
        recordsByKey,
        control,
      );
      return reconciled.deferred;
    }
    await this.#persistNode(fence, {
      ...current,
      failure: outcome.failure,
      finishedAt: this.#now().toISOString(),
      status: outcome.kind,
    });
    if (outcome.kind === "ambiguous") {
      const node = graphPlan.graph.nodes.find(item => item.key === running.nodeKey);
      if (node === undefined) {
        throw new ApplicationError("invalid-data", `Missing graph node ${running.nodeKey}.`);
      }
    }
    return false;
  }

  async #cancelWaitingNodes(fence: RunFence, graphPlan: GraphPlanV1): Promise<void> {
    const records = await this.#store.nodes(fence.runId);
    const graphKeys = new Set(graphPlan.graph.nodes.map(node => node.key));
    for (const record of records
      .filter(item => (
        item.status === "pending"
        || item.status === "ready"
        || item.status === "preparing"
        || item.status === "approval-required"
        || item.status === "ambiguous-code"
      ))
      .sort((left, right) => left.nodeKey.localeCompare(right.nodeKey))) {
      if (!graphKeys.has(record.nodeKey)) continue;
      await this.#persistNode(fence, {
        ...record,
        finishedAt: this.#now().toISOString(),
        status: "cancelled",
      });
    }
  }

  async #failImpossibleReadyNodes(
    fence: RunFence,
    graphPlan: GraphPlanV1,
    ledger: ResourceLedger,
  ): Promise<boolean> {
    const records = await this.#store.nodes(fence.runId);
    const nodesByKey = new Map(graphPlan.graph.nodes.map(node => [node.key, node]));
    let changed = false;
    for (const record of records
      .filter(item => item.status === "ready")
      .sort((left, right) => left.nodeKey.localeCompare(right.nodeKey))) {
      const node = nodesByKey.get(record.nodeKey);
      if (node === undefined) continue;
      const executor = executorForNode(graphPlan, node, this.#registry);
      if (!ledger.impossible(executor.policy.resources)) continue;
      await this.#persistNode(fence, {
        ...record,
        failure: schedulerFailure(new ApplicationError(
          "incompatible",
          `Node ${node.key} exceeds the host resource ceiling.`,
        )),
        finishedAt: this.#now().toISOString(),
        status: "incompatible",
      });
      changed = true;
    }
    return changed;
  }

  async #persistNode(fence: RunFence, input: RunNodeRecord): Promise<void> {
    const parsed = RunNodeRecordSchema.parse(input);
    const node = RunNodeRecordSchema.parse({
      attempt: parsed.attempt,
      dependencies: parsed.dependencies,
      ...(parsed.executionPlan === undefined ? {} : { executionPlan: parsed.executionPlan }),
      ...(parsed.failure === undefined ? {} : { failure: parsed.failure }),
      ...(parsed.finishedAt === undefined ? {} : { finishedAt: parsed.finishedAt }),
      executor: parsed.executor,
      nodeKey: parsed.nodeKey,
      ...(parsed.output === undefined ? {} : { output: parsed.output }),
      ...(parsed.preparationPlan === undefined
        ? {}
        : { preparationPlan: parsed.preparationPlan }),
      ...(parsed.startedAt === undefined ? {} : { startedAt: parsed.startedAt }),
      status: parsed.status,
      version: parsed.version,
    });
    await this.#store.assertFence(fence);
    await this.#store.writeNode(fence, node);
    await this.#store.appendEvent(fence, {
      details: { status: node.status },
      kind: "node-status",
      nodeKey: node.nodeKey,
      timestamp: this.#now().toISOString(),
    });
  }

  async #publishSummary(
    fence: RunFence,
    graphPlan: GraphPlanV1,
    state: MutableRunState,
    running: number,
  ): Promise<RunSummary> {
    const existing = await this.#store.summary(fence.runId);
    if (terminalRunStatus(existing.status)) return existing;
    const records = await this.#store.nodes(fence.runId);
    const recordsByKey = new Map(records.map(record => [record.nodeKey, record]));
    const status = terminalStatus(records, state, running);
    const now = this.#now().toISOString();
    const outputs = status === "completed"
      ? resolveOutputBinding(graphPlan.graph.outputs, recordsByKey)
      : undefined;
    const summary = RunSummarySchema.parse({
      counts: countsFor(records),
      ...(terminalRunStatus(status) ? { finishedAt: now } : {}),
      graphPlanSha256: graphPlan.graphPlanSha256,
      ...(outputs === undefined ? {} : { outputs }),
      runId: fence.runId,
      startedAt: state.startedAt,
      status,
      updatedAt: now,
      version: RUN_STORE_VERSION,
    });
    await this.#store.writeSummary(fence, summary);
    return summary;
  }

  async #markSchedulerFailure(
    fence: RunFence,
    graphPlan: GraphPlanV1,
    state: MutableRunState,
    error: ApplicationError,
  ): Promise<void> {
    const records = await this.#store.nodes(fence.runId);
    const target = records
      .filter(record => (
        record.status === "ready"
        || record.status === "preparing"
        || record.status === "running"
      ))
      .sort((left, right) => left.nodeKey.localeCompare(right.nodeKey))[0];
    if (target !== undefined) {
      const authored = graphPlan.graph.nodes.find(node => node.key === target.nodeKey);
      const resumeClass = authored !== undefined && isOperationGraphNode(authored)
        ? operationForNode(graphPlan, authored, this.#registry).discovery.policy.resume
        : undefined;
      const preserveForReconciliation = target.status === "running"
        && (
          resumeClass === "verified-receipt"
          || resumeClass === "recoverable-transaction"
        );
      if (preserveForReconciliation) {
        await this.#publishSummary(fence, graphPlan, state, 0);
        return;
      }
      await this.#persistNode(fence, {
        ...target,
        failure: schedulerFailure(error),
        finishedAt: this.#now().toISOString(),
        status: error.code === "incompatible" ? "incompatible" : "failed",
      });
    }
    await this.#publishSummary(fence, graphPlan, state, 0);
  }

  async #markRunIncompatible(
    fence: RunFence,
    graphPlan: GraphPlanV1,
    state: MutableRunState,
    error: ApplicationError,
  ): Promise<void> {
    const records = await this.#store.nodes(fence.runId);
    for (const record of [...records].sort((left, right) => (
      left.nodeKey.localeCompare(right.nodeKey)
    ))) {
      if (record.status === "approval-required") {
        await this.#persistNode(fence, {
          ...record,
          status: "ready",
        });
      }
      const current = record.status === "approval-required"
        ? await this.#store.node(fence.runId, record.nodeKey)
        : record;
      if (
        current.status !== "ready"
        && current.status !== "preparing"
        && current.status !== "running"
        && current.status !== "ambiguous-code"
      ) {
        continue;
      }
      await this.#persistNode(fence, {
        ...current,
        failure: schedulerFailure(new ApplicationError(
          "incompatible",
          error.message,
        )),
        finishedAt: this.#now().toISOString(),
        status: "incompatible",
      });
    }
    await this.#advanceDependencies(fence, graphPlan, state);
  }
}
