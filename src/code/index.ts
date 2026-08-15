import {
  DEFAULT_GRAPH_COMPILER_LIMITS,
  WORKFLOW_COMPILATION_HASH_DOMAIN,
  WORKFLOW_GRAPH_HASH_DOMAIN,
  compileWorkflowGraph as compileAdvancedWorkflowGraph,
  createGraphHash,
  createWorkflowCompilationHash,
  createWorkflowGraphHash,
} from "./compiler.js"
import type {
  CompiledWorkflowGraph,
  GraphCompilerLimits,
} from "./contracts.js"
import {
  PUBLIC_WORKFLOW_REGISTRY_PROJECTION,
} from "./projection.js"

export {
  DEFAULT_GRAPH_COMPILER_LIMITS,
  WORKFLOW_COMPILATION_HASH_DOMAIN,
  WORKFLOW_GRAPH_HASH_DOMAIN,
  createGraphHash,
  createWorkflowCompilationHash,
  createWorkflowGraphHash,
}

export interface CompileWorkflowGraphOptions {
  readonly graph: unknown
  readonly limits?: Partial<GraphCompilerLimits>
}

/** Compile only against the closed four-operation public projection. */
export function compileWorkflowGraph(
  options: CompileWorkflowGraphOptions,
): CompiledWorkflowGraph {
  return compileAdvancedWorkflowGraph({
    graph: options.graph,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
    projection: PUBLIC_WORKFLOW_REGISTRY_PROJECTION,
  })
}

export {
  boundedCanonicalJson,
  boundedCanonicalJsonSha256,
  canonicalJson,
  canonicalJsonSha256,
  sha256Hex,
  type CanonicalJsonBounds,
  type CanonicalJsonValue,
} from "./canonical-json.js"
export {
  AuthoredGraphNodeV1Schema,
  AuthoredWorkflowGraphV1Schema,
  CompiledWorkflowGraphSchema,
  GRAPH_ABI,
  GraphCompilerLimitsSchema,
  JsonValueSchema,
  OperationDiscoverySchema,
  OperationKindSchema,
  OperationPolicySchema,
  REQUIREMENT_ENVELOPE_VERSION,
  RequirementEnvelopeSchema,
  SerializedRefV1Schema,
  WORKFLOW_COMPILATION_VERSION,
  WORKFLOW_GRAPH_VERSION,
  WORKFLOW_REF_BRAND,
  WORKFLOW_REF_VERSION,
  type AuthoredGraphNodeV1,
  type AuthoredOperationGraphNodeV1,
  type AuthoredWorkflowGraphV1,
  type CompiledWorkflowGraph,
  type GraphCompilerLimits,
  type GraphInputValue,
  type JsonPrimitive,
  type JsonValue,
  type OperationContract,
  type OperationDiscovery,
  type OperationInputValue,
  type OperationKind,
  type OperationPolicy,
  type Ref,
  type RefValue,
  type RequirementEnvelope,
  type SerializedRefV1,
  type WorkflowIdentity,
  type WorkflowOutputBinding,
  type WorkflowOutputValue,
  type WorkflowRegistryProjection,
} from "./contracts.js"
export {
  buildWorkflow,
  buildWorkflowGraph,
  defineWorkflow,
  seconds,
  type BuiltWorkflow,
  type WorkflowDefinition,
  type WorkflowDefinitionOptions,
} from "./define-workflow.js"
export {
  AtetCodeError,
  TransmuteCodeError,
  asAtetCodeError,
  asTransmuteCodeError,
  atetCodeErrorMessage,
  transmuteCodeErrorMessage,
  type AtetCodeErrorCode,
  type TransmuteCodeErrorCode,
} from "./errors.js"
export type { OperationNodeOptions } from "./graph-builder.js"
export {
  PortableWorkflowBuilder,
  definePortableWorkflowFragment,
  type PortableWorkflowFragment,
} from "./portable-builder.js"
export {
  PUBLIC_ATET_WORKFLOW_PROJECTION,
  PUBLIC_TRANSMUTE_WORKFLOW_PROJECTION,
  PUBLIC_WORKFLOW_REGISTRY_PROJECTION,
  PUBLIC_WORKFLOW_REGISTRY_PROJECTION_ID,
  createPublicWorkflowRegistryProjection,
} from "./projection.js"
export * from "./public-operations.js"
export * from "./runtime.js"
