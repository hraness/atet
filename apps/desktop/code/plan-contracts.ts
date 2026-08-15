import { z } from "zod";
import {
  AuthoredWorkflowGraphV1Schema,
  GRAPH_ABI,
  GraphCompilerLimitsSchema,
  JsonValueSchema,
  MAX_SERIALIZED_GRAPH_NODES,
  NodeKeySchema,
  NonnegativeSafeIntegerSchema,
  OperationDiscoverySchema as PortableOperationDiscoverySchema,
  RequirementEnvelopeSchema,
  Sha256Schema,
} from "@hraness/atet/code/advanced";

import { OPERATION_KINDS } from "../application/operation";

const LEGACY_PORTABLE_OPERATION_KINDS = [
  "transmute.diagram.check",
  "transmute.diagram.render",
  "transmute.image.generate",
  "transmute.image.vectorize",
] as const;

export const OperationKindSchema = z.union([
  z.enum(OPERATION_KINDS),
  z.enum(LEGACY_PORTABLE_OPERATION_KINDS),
]) as z.ZodType<typeof OPERATION_KINDS[number]>;

/**
 * The portable graph accepts namespaced operation identities. A persisted
 * Desktop plan is a projection over the closed local registry, so it narrows
 * discovery back to operation kinds this host can actually execute.
 */
export const OperationDiscoverySchema = PortableOperationDiscoverySchema.extend({
  kind: OperationKindSchema,
});

export type GraphOperationDiscovery = z.infer<typeof OperationDiscoverySchema>;

export const GRAPH_PLAN_VERSION = "atet-graph-plan-v2" as const;
export const GRAPH_COMPILER_ABI = "atet-workflow-compiler-v2" as const;
export const GRAPH_SCHEDULER_ABI = "atet-workflow-scheduler-v2" as const;
export const CODE_WORKER_ABI = "atet-code-worker-abi-v4" as const;
export const STATIC_BINDINGS_VERSION = "atet-static-bindings-v1" as const;
const LEGACY_GRAPH_PLAN_VERSION = "transmute-graph-plan-v2" as const;
const LEGACY_GRAPH_COMPILER_ABI = "transmute-workflow-compiler-v2" as const;
const LEGACY_GRAPH_SCHEDULER_ABI = "transmute-workflow-scheduler-v2" as const;
const LEGACY_CODE_WORKER_ABI = "transmute-code-worker-abi-v4" as const;
const LEGACY_STATIC_BINDINGS_VERSION = "transmute-static-bindings-v1" as const;

export const OPERATION_FAMILIES = [
  "analysis",
  "compute",
  "derive",
  "edit",
  "gateway",
  "iteration",
  "media",
  "project",
  "recording",
  "render",
  "atet",
] as const;

export type OperationFamily = typeof OPERATION_FAMILIES[number];

const MEDIA_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;

export const WorkflowBundleIdentitySchema = z.strictObject({
  bundleSha256: Sha256Schema,
  bytes: NonnegativeSafeIntegerSchema,
  dependencyGraphSha256: Sha256Schema,
  entrypoint: z.string().min(1).max(1_024),
  sourceSha256: Sha256Schema,
});

export type WorkflowBundleIdentity = z.infer<typeof WorkflowBundleIdentitySchema>;

export const ExternalsPolicyIdentitySchema = z.strictObject({
  kind: z.enum(["deny-all", "allowlist"]),
  modules: z.array(z.string().min(1).max(214)).max(256),
  policySha256: Sha256Schema,
});

export const WorkflowRuntimeIdentitySchema = z.strictObject({
  applicationBuild: z.string().min(1).max(160),
  bunRevision: z.string().min(1).max(160),
  bunVersion: z.string().min(1).max(80),
  bundlerConfigurationSha256: Sha256Schema,
  bundlerName: z.string().min(1).max(80),
  bundlerRevision: z.string().min(1).max(160),
  bundlerVersion: z.string().min(1).max(80),
  compilerAbi: z.union([z.literal(GRAPH_COMPILER_ABI), z.literal(LEGACY_GRAPH_COMPILER_ABI)]),
  codeWorkerAbi: z.union([z.literal(CODE_WORKER_ABI), z.literal(LEGACY_CODE_WORKER_ABI)]),
  externals: ExternalsPolicyIdentitySchema,
  graphAbi: z.literal(GRAPH_ABI),
  schedulerAbi: z.union([z.literal(GRAPH_SCHEDULER_ABI), z.literal(LEGACY_GRAPH_SCHEDULER_ABI)]),
});

export type WorkflowRuntimeIdentity = z.infer<typeof WorkflowRuntimeIdentitySchema>;

export const InitialSubjectBindingSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    descriptorSha256: Sha256Schema,
    id: z.string().min(1).max(256),
    kind: z.literal("project"),
    planSha256: Sha256Schema,
    projectSha256: Sha256Schema,
  }),
  z.strictObject({
    bundleSha256: Sha256Schema,
    descriptorSha256: Sha256Schema,
    id: z.string().min(1).max(256),
    kind: z.literal("recording"),
  }),
]);

export type InitialSubjectBinding = z.infer<typeof InitialSubjectBindingSchema>;

export const CandidateDescriptorSchema = z.strictObject({
  bytes: NonnegativeSafeIntegerSchema.optional(),
  descriptorSha256: Sha256Schema,
  id: z.string().min(1).max(256),
  kind: z.enum(["file", "project", "recording"]),
  mediaType: z.string().max(160).regex(MEDIA_TYPE_PATTERN).optional(),
  sha256: Sha256Schema.optional(),
});

export type CandidateDescriptor = z.infer<typeof CandidateDescriptorSchema>;

export const StaticBindingsSchema = z.strictObject({
  candidates: z.array(CandidateDescriptorSchema).max(1_024),
  initialSubjects: z.array(InitialSubjectBindingSchema).max(16),
  version: z.union([z.literal(STATIC_BINDINGS_VERSION), z.literal(LEGACY_STATIC_BINDINGS_VERSION)]),
});

export type StaticBindings = z.infer<typeof StaticBindingsSchema>;

export const GraphRegistryIdentitySchema = z.strictObject({
  discovery: z.array(OperationDiscoverySchema).max(OPERATION_KINDS.length * 32),
});

export const UnsignedGraphPlanV1Schema = z.strictObject({
  bundle: WorkflowBundleIdentitySchema,
  envelope: RequirementEnvelopeSchema,
  graph: AuthoredWorkflowGraphV1Schema,
  limits: GraphCompilerLimitsSchema,
  registry: GraphRegistryIdentitySchema,
  runtime: WorkflowRuntimeIdentitySchema,
  staticBindings: StaticBindingsSchema,
  topologicalWaves: z.array(z.array(NodeKeySchema).min(1))
    .max(MAX_SERIALIZED_GRAPH_NODES),
  version: z.union([z.literal(GRAPH_PLAN_VERSION), z.literal(LEGACY_GRAPH_PLAN_VERSION)]),
  workflowInput: JsonValueSchema,
});

export type UnsignedGraphPlanV1 = z.infer<typeof UnsignedGraphPlanV1Schema>;

export const GraphPlanV1Schema = UnsignedGraphPlanV1Schema.extend({
  graphPlanSha256: Sha256Schema,
});

export type GraphPlanV1 = z.infer<typeof GraphPlanV1Schema>;
