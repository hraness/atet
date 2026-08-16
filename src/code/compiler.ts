import { z } from "zod"

import {
  AuthoredWorkflowGraphV1Schema,
  CompiledWorkflowGraphSchema,
  GraphCompilerLimitsSchema,
  MAX_OPERATION_DISCOVERY_ENTRIES,
  MAX_SERIALIZED_GRAPH_NODES,
  OPERATION_PREPARATION_KINDS,
  OPERATION_RESOURCE_KINDS,
  REQUIREMENT_ENVELOPE_VERSION,
  RequirementEnvelopeSchema,
  Sha256Schema,
  UNRESOLVED_REQUIREMENT_KINDS,
  WORKFLOW_COMPILATION_VERSION,
  WORKFLOW_EFFECT_CLASSES,
  WORKFLOW_GRAPH_VERSION,
  WORKFLOW_REF_VERSION,
  WORKFLOW_RESUME_CLASSES,
  isComputeGraphNode,
  isOperationGraphNode,
  trustedComputePolicy,
  type AuthoredGraphNodeV1,
  type AuthoredWorkflowGraphV1,
  type CompiledWorkflowGraph,
  type GraphCompilerLimits,
  type GraphInputValue,
  type OperationDiscoverySource,
  type OperationKind,
  type OperationPreparationKind,
  type OperationResourceKind,
  type RequirementEnvelope,
  type SerializedRefV1,
  type WorkflowEffectClass,
  type WorkflowNodePolicy,
  type WorkflowOutputBinding,
  type WorkflowRegistryProjection,
  type WorkflowResumeClass,
} from "./contracts.js"
import {
  canonicalJsonSha256,
  canonicalJsonSha256Prefixed,
} from "./canonical-json.js"
import { parseCodeBoundary } from "./boundary.js"
import { AtetCodeError } from "./errors.js"
import {
  createBoundedJsonValueSnapshot,
  deepFreezeJson,
} from "./json-snapshot.js"
import {
  PUBLIC_WORKFLOW_REGISTRY_PROJECTION,
  createWorkflowRegistryProjection,
  parseWorkflowRegistryProjection,
} from "./projection.js"

export const WORKFLOW_GRAPH_HASH_DOMAIN = "atet.workflow.graph/v1" as const
export const WORKFLOW_COMPILATION_HASH_DOMAIN =
  "atet.workflow.compilation/v1" as const

export const DEFAULT_GRAPH_COMPILER_LIMITS = Object.freeze({
  maxDepth: 64,
  maxEdges: 2_048,
  maxFanOut: 64,
  maxNodes: 256,
  maxTotalOperationFanOut: 4_096,
}) satisfies GraphCompilerLimits

const MAX_SERIALIZED_GRAPH_BYTES = 64 * 1024 * 1024
const MAX_SERIALIZED_GRAPH_DEPTH = 160
const MAX_SERIALIZED_GRAPH_VALUES = 1_100_000
const MAX_GRAPH_COMPILER_LIMIT_BYTES = 1_024
const MAX_GRAPH_COMPILER_LIMIT_DEPTH = 2
const MAX_GRAPH_COMPILER_LIMIT_INPUT_VALUES = 16
// A compilation contains the graph, registry projection, topology, limits,
// and requirement envelope. Its bounds must compose rather than reuse the
// graph's exact ceiling.
const MAX_WORKFLOW_COMPILATION_BYTES = 80 * 1024 * 1024
const MAX_WORKFLOW_COMPILATION_DEPTH = 192
const MAX_OPERATION_DISCOVERY_VALUES = 17
  + OPERATION_PREPARATION_KINDS.length
  + (3 * OPERATION_RESOURCE_KINDS.length)
const MAX_WORKFLOW_PROJECTION_VALUES = 5
  + (MAX_OPERATION_DISCOVERY_ENTRIES * MAX_OPERATION_DISCOVERY_VALUES)
const MAX_REQUIREMENT_ENVELOPE_VALUES = 21
  + (3 * MAX_SERIALIZED_GRAPH_NODES)
  + WORKFLOW_EFFECT_CLASSES.length
  + OPERATION_PREPARATION_KINDS.length
  + (3 * OPERATION_RESOURCE_KINDS.length)
  + WORKFLOW_RESUME_CLASSES.length
  + UNRESOLVED_REQUIREMENT_KINDS.length
const MAX_TOPOLOGICAL_WAVE_VALUES = 1 + (2 * MAX_SERIALIZED_GRAPH_NODES)
const MAX_GRAPH_COMPILER_LIMIT_VALUES = 6
const MAX_WORKFLOW_COMPILATION_VALUES = MAX_SERIALIZED_GRAPH_VALUES
  + MAX_WORKFLOW_PROJECTION_VALUES
  + MAX_REQUIREMENT_ENVELOPE_VALUES
  + MAX_TOPOLOGICAL_WAVE_VALUES
  + MAX_GRAPH_COMPILER_LIMIT_VALUES
  + 4 // Compilation root plus its three scalar fields.

export interface CompileWorkflowGraphOptions {
  readonly graph: unknown
  readonly limits?: unknown
  readonly projection?: unknown
  readonly projectionId?: string
  readonly registry?: OperationDiscoverySource
  readonly trustedCompute?: boolean
}

export interface ValidatedGraphTopology {
  readonly depth: number
  readonly edges: number
  readonly structuralFanOut: number
  readonly waves: readonly (readonly string[])[]
}
interface ValidatedGraph {
  readonly graph: AuthoredWorkflowGraphV1
  readonly policiesByNode: ReadonlyMap<string, WorkflowNodePolicy>
  readonly topology: ValidatedGraphTopology
}

function invalidData(
  message: string,
  details?: Readonly<Record<string, unknown>>,
): never {
  throw new AtetCodeError("invalid-data", message, details)
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value
  }
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function operationKey(kind: OperationKind, version: number): string {
  return `${kind}@${String(version)}`
}

function uniqueSorted<Value extends string>(
  values: Iterable<Value>,
): readonly Value[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function canonicalAtetIdentity(value: string): string {
  if (value === "studio") return "atet"
  return value.replace(/^studio\./u, "atet.")
}

function safeAdd(left: number, right: number, name: string): number {
  const result = left + right
  if (!Number.isSafeInteger(result)) {
    return invalidData(`${name} exceeds the safe integer range.`, { left, right })
  }
  return result
}

function normalizeLimits(input: unknown): GraphCompilerLimits {
  if (input === undefined) return DEFAULT_GRAPH_COMPILER_LIMITS
  const captured = createBoundedJsonValueSnapshot(
    input,
    MAX_GRAPH_COMPILER_LIMIT_BYTES,
    "graph compiler limits",
    {
      maximumDepth: MAX_GRAPH_COMPILER_LIMIT_DEPTH,
      maximumValues: MAX_GRAPH_COMPILER_LIMIT_INPUT_VALUES,
    },
  ).value
  if (typeof captured !== "object" || captured === null || Array.isArray(captured)) {
    return parseCodeBoundary(
      GraphCompilerLimitsSchema,
      captured,
      "graph compiler limits",
    )
  }
  return parseCodeBoundary(GraphCompilerLimitsSchema, {
    ...DEFAULT_GRAPH_COMPILER_LIMITS,
    ...captured,
  }, "graph compiler limits")
}

function preflightAuthoredWorkflowGraph(
  graphInput: unknown,
  maximumNodes: number,
): void {
  if (
    typeof graphInput !== "object"
    || graphInput === null
    || Array.isArray(graphInput)
  ) {
    return
  }
  const nodes = Object.getOwnPropertyDescriptor(
    graphInput,
    "nodes",
  )?.value as unknown
  if (Array.isArray(nodes) && nodes.length > maximumNodes) {
    return invalidData(
      `Workflow has ${String(nodes.length)} nodes; the limit is ${String(maximumNodes)}.`,
      { actual: nodes.length, limit: maximumNodes },
    )
  }
}

function parseAuthoredWorkflowGraphPreservingIdentity(
  graphInput: unknown,
  maximumNodes = MAX_SERIALIZED_GRAPH_NODES,
): AuthoredWorkflowGraphV1 {
  preflightAuthoredWorkflowGraph(graphInput, maximumNodes)
  const captured = createBoundedJsonValueSnapshot(
    graphInput,
    MAX_SERIALIZED_GRAPH_BYTES,
    "Authored workflow graph",
    {
      maximumDepth: MAX_SERIALIZED_GRAPH_DEPTH,
      maximumValues: MAX_SERIALIZED_GRAPH_VALUES,
    },
  ).value
  const graph = parseCodeBoundary(
    AuthoredWorkflowGraphV1Schema,
    captured,
    "authored workflow graph",
  )
  if (graph.nodes.length > maximumNodes) {
    return invalidData(
      `Workflow has ${String(graph.nodes.length)} nodes; the limit is ${String(maximumNodes)}.`,
      { actual: graph.nodes.length, limit: maximumNodes },
    )
  }
  const sorted = {
    ...graph,
    nodes: [...graph.nodes].sort((left, right) => (
      left.key.localeCompare(right.key)
    )),
  }
  return deepFreezeJson(sorted)
}

function canonicalizeGraphValue(
  value: GraphInputValue | WorkflowOutputBinding,
): GraphInputValue | WorkflowOutputBinding {
  if (isSerializedRef(value)) {
    return {
      $ref: {
        ...value.$ref,
        schemaId: canonicalAtetIdentity(value.$ref.schemaId),
      },
      version: WORKFLOW_REF_VERSION,
    }
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeGraphValue) as readonly GraphInputValue[]
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => (
      [key, canonicalizeGraphValue(nested)]
    ))) as GraphInputValue
  }
  return value
}

function canonicalizeAuthoredWorkflowGraph(
  graph: AuthoredWorkflowGraphV1,
): AuthoredWorkflowGraphV1 {
  return deepFreezeJson(parseCodeBoundary(AuthoredWorkflowGraphV1Schema, {
    ...graph,
    nodes: graph.nodes.map(node => ({
      ...node,
      executor: node.executor.kind === "operation"
        ? {
            kind: "operation" as const,
            operation: {
              ...node.executor.operation,
              kind: canonicalAtetIdentity(node.executor.operation.kind),
            },
          }
        : {
            compute: {
              ...node.executor.compute,
              key: canonicalAtetIdentity(node.executor.compute.key),
            },
            kind: "compute" as const,
          },
      input: canonicalizeGraphValue(node.input),
      inputSchemaId: canonicalAtetIdentity(node.inputSchemaId),
      outputSchemaId: canonicalAtetIdentity(node.outputSchemaId),
    })),
    outputs: canonicalizeGraphValue(graph.outputs),
    version: WORKFLOW_GRAPH_VERSION,
    workflow: {
      ...graph.workflow,
      id: canonicalAtetIdentity(graph.workflow.id),
      inputSchemaId: canonicalAtetIdentity(graph.workflow.inputSchemaId),
    },
  }, "canonical authored workflow graph"))
}

export function normalizeAuthoredWorkflowGraph(
  graphInput: unknown,
  maximumNodes = MAX_SERIALIZED_GRAPH_NODES,
): AuthoredWorkflowGraphV1 {
  return canonicalizeAuthoredWorkflowGraph(
    parseAuthoredWorkflowGraphPreservingIdentity(graphInput, maximumNodes),
  )
}

function workflowGraphHashFromNormalized(
  graph: AuthoredWorkflowGraphV1,
): string {
  return canonicalJsonSha256Prefixed(
    `${WORKFLOW_GRAPH_HASH_DOMAIN}\0`,
    graph,
  )
}

export function createWorkflowGraphHash(graphInput: unknown): string {
  const graph = normalizeAuthoredWorkflowGraph(graphInput)
  return workflowGraphHashFromNormalized(graph)
}

export const createGraphHash = createWorkflowGraphHash

function isSerializedRef(value: unknown): value is SerializedRefV1 {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.hasOwn(value, "$ref")
}

function isGraphValueArray(
  value: GraphInputValue | WorkflowOutputBinding,
): value is readonly (GraphInputValue | WorkflowOutputBinding)[] {
  return Array.isArray(value)
}

function collectReferences(
  value: GraphInputValue | WorkflowOutputBinding,
): readonly SerializedRefV1[] {
  const references: SerializedRefV1[] = []
  const pending: (GraphInputValue | WorkflowOutputBinding)[] = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) continue
    if (isSerializedRef(current)) {
      references.push(current)
      continue
    }
    if (isGraphValueArray(current)) {
      for (const item of current) pending.push(item)
      continue
    }
    if (typeof current === "object" && current !== null) {
      for (const item of Object.values(current)) pending.push(item)
    }
  }
  return references
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index])
}

function validateReference(
  reference: SerializedRefV1,
  nodesByKey: ReadonlyMap<string, AuthoredGraphNodeV1>,
  owner: string,
): void {
  const producer = nodesByKey.get(reference.$ref.nodeKey)
  if (producer === undefined) {
    return invalidData(
      `${owner} contains a dangling reference to ${reference.$ref.nodeKey}.`,
      { nodeKey: reference.$ref.nodeKey, owner },
    )
  }
  if (producer.outputSchemaId !== reference.$ref.schemaId) {
    return invalidData(
      `${owner} expects schema ${reference.$ref.schemaId} from ${producer.key}, `
      + `but the producer declares ${producer.outputSchemaId}.`,
      {
        actualSchemaId: producer.outputSchemaId,
        expectedSchemaId: reference.$ref.schemaId,
        nodeKey: producer.key,
        owner,
      },
    )
  }
}

function topologicalWaves(
  nodes: readonly AuthoredGraphNodeV1[],
  limits: GraphCompilerLimits,
): ValidatedGraphTopology {
  const dependencies = new Map<string, ReadonlySet<string>>()
  const dependents = new Map<string, Set<string>>()
  let edgeCount = 0
  for (const node of nodes) {
    const nodeDependencies = new Set(node.dependencies)
    dependencies.set(node.key, nodeDependencies)
    edgeCount = safeAdd(edgeCount, nodeDependencies.size, "Workflow edge count")
    for (const dependency of nodeDependencies) {
      const entries = dependents.get(dependency) ?? new Set<string>()
      entries.add(node.key)
      dependents.set(dependency, entries)
    }
  }
  if (edgeCount > limits.maxEdges) {
    return invalidData(
      `Workflow has ${String(edgeCount)} edges; the limit is ${String(limits.maxEdges)}.`,
      { actual: edgeCount, limit: limits.maxEdges },
    )
  }
  const structuralFanOut = Math.max(
    0,
    ...[...dependents.values()].map(entries => entries.size),
  )
  if (structuralFanOut > limits.maxFanOut) {
    return invalidData(
      `Workflow fan-out is ${String(structuralFanOut)}; the limit is ${String(limits.maxFanOut)}.`,
      { actual: structuralFanOut, limit: limits.maxFanOut },
    )
  }

  let ready = nodes
    .filter(node => (dependencies.get(node.key)?.size ?? 0) === 0)
    .map(node => node.key)
    .sort((left, right) => left.localeCompare(right))
  const remaining = new Map<string, number>(
    nodes.map(node => [node.key, dependencies.get(node.key)?.size ?? 0]),
  )
  const waves: string[][] = []
  let visited = 0
  while (ready.length > 0) {
    const wave = ready
    waves.push(wave)
    visited += wave.length
    const next = new Set<string>()
    for (const nodeKey of wave) {
      for (const dependent of dependents.get(nodeKey) ?? []) {
        const nextCount = (remaining.get(dependent) ?? 0) - 1
        remaining.set(dependent, nextCount)
        if (nextCount === 0) next.add(dependent)
      }
    }
    ready = [...next].sort((left, right) => left.localeCompare(right))
  }
  if (visited !== nodes.length) {
    return invalidData("Workflow graph contains a dependency cycle.")
  }
  if (waves.length > limits.maxDepth) {
    return invalidData(
      `Workflow depth is ${String(waves.length)}; the limit is ${String(limits.maxDepth)}.`,
      { actual: waves.length, limit: limits.maxDepth },
    )
  }
  return {
    depth: waves.length,
    edges: edgeCount,
    structuralFanOut,
    waves,
  }
}

function validateGraph(
  graphInput: unknown,
  projection: WorkflowRegistryProjection,
  limits: GraphCompilerLimits,
): ValidatedGraph {
  const graph = normalizeAuthoredWorkflowGraph(graphInput, limits.maxNodes)
  if (graph.nodes.length > limits.maxNodes) {
    return invalidData(
      `Workflow has ${String(graph.nodes.length)} nodes; the limit is ${String(limits.maxNodes)}.`,
      { actual: graph.nodes.length, limit: limits.maxNodes },
    )
  }
  const nodesByKey = new Map<string, AuthoredGraphNodeV1>()
  for (const node of graph.nodes) {
    if (nodesByKey.has(node.key)) {
      return invalidData(`Duplicate workflow node key: ${node.key}`, {
        nodeKey: node.key,
      })
    }
    nodesByKey.set(node.key, node)
  }
  const discoveryByKey = new Map(
    projection.discovery.map(operation => [
      operationKey(operation.kind, operation.version),
      operation,
    ]),
  )
  const policiesByNode = new Map<string, WorkflowNodePolicy>()
  let totalOperationFanOut = 0
  for (const node of graph.nodes) {
    let policy: WorkflowNodePolicy
    if (isOperationGraphNode(node)) {
      const identity = node.executor.operation
      const operation = discoveryByKey.get(
        operationKey(identity.kind, identity.version),
      )
      if (operation === undefined) {
        throw new AtetCodeError(
          "unsupported-plan",
          `Unsupported operation: ${operationKey(identity.kind, identity.version)}`,
          {
            kind: identity.kind,
            nodeKey: node.key,
            projectionId: projection.id,
            version: identity.version,
          },
        )
      }
      if (
        node.inputSchemaId !== operation.inputSchemaId
        || node.outputSchemaId !== operation.outputSchemaId
      ) {
        return invalidData(
          `Operation schema identity mismatch for ${operationKey(identity.kind, identity.version)} `
          + `at node ${node.key}.`,
          {
            actualInputSchemaId: node.inputSchemaId,
            actualOutputSchemaId: node.outputSchemaId,
            expectedInputSchemaId: operation.inputSchemaId,
            expectedOutputSchemaId: operation.outputSchemaId,
            kind: identity.kind,
            nodeKey: node.key,
            version: identity.version,
          },
        )
      }
      policy = operation.policy
    } else if (isComputeGraphNode(node)) {
      if (!projection.trustedCompute) {
        throw new AtetCodeError(
          "unsupported-plan",
          `Trusted compute is unsupported at node ${node.key}.`,
          {
            executorKind: "compute",
            nodeKey: node.key,
            projectionId: projection.id,
          },
        )
      }
      policy = trustedComputePolicy(node.executor.compute)
    } else {
      throw new AtetCodeError(
        "internal",
        `Unknown node executor for ${node.key}.`,
      )
    }
    policiesByNode.set(node.key, policy)
    totalOperationFanOut = safeAdd(
      totalOperationFanOut,
      policy.maxFanOut,
      "Total operation fan-out",
    )
    const references = collectReferences(node.input)
    for (const reference of references) {
      validateReference(reference, nodesByKey, `Node ${node.key}`)
    }
    const controlDependencies = node.controlDependencies ?? []
    const normalizedControlDependencies = uniqueSorted(controlDependencies)
    if (!arraysEqual(controlDependencies, normalizedControlDependencies)) {
      return invalidData(
        `Node ${node.key} control dependencies must be unique and sorted.`,
        { nodeKey: node.key },
      )
    }
    for (const dependency of controlDependencies) {
      if (!nodesByKey.has(dependency)) {
        return invalidData(
          `Node ${node.key} contains a dangling control dependency to ${dependency}.`,
          { dependency, nodeKey: node.key },
        )
      }
      if (dependency === node.key) {
        return invalidData(`Node ${node.key} cannot depend on itself.`, {
          nodeKey: node.key,
        })
      }
    }
    const inferredDependencies = uniqueSorted([
      ...references.map(reference => reference.$ref.nodeKey),
      ...controlDependencies,
    ])
    if (!arraysEqual(node.dependencies, inferredDependencies)) {
      return invalidData(
        `Node ${node.key} dependencies do not match its embedded references and explicit control dependencies. `
        + `Expected [${inferredDependencies.join(", ")}].`,
        { expectedDependencies: inferredDependencies, nodeKey: node.key },
      )
    }
  }
  if (totalOperationFanOut > limits.maxTotalOperationFanOut) {
    return invalidData(
      `Workflow operation fan-out bound is ${String(totalOperationFanOut)}; `
      + `the limit is ${String(limits.maxTotalOperationFanOut)}.`,
      { actual: totalOperationFanOut, limit: limits.maxTotalOperationFanOut },
    )
  }
  for (const reference of collectReferences(graph.outputs)) {
    validateReference(reference, nodesByKey, "Workflow outputs")
  }
  return {
    graph,
    policiesByNode,
    topology: topologicalWaves(graph.nodes, limits),
  }
}

function operationFamily(kind: OperationKind): string {
  const separator = kind.indexOf(".")
  if (separator < 1) {
    throw new AtetCodeError(
      "internal",
      `Operation ${kind} has no namespace family.`,
      { kind },
    )
  }
  return kind.slice(0, separator)
}

function addResource(
  resources: Map<OperationResourceKind, number>,
  resource: OperationResourceKind,
  amount: number,
): void {
  resources.set(
    resource,
    safeAdd(resources.get(resource) ?? 0, amount, `Resource ${resource} claim`),
  )
}

function deriveRequirementEnvelope(validated: ValidatedGraph): RequirementEnvelope {
  const computeKeys = new Set<string>()
  const effects = new Set<WorkflowEffectClass>()
  const families = new Set<string>()
  const operationKinds = new Set<OperationKind>()
  const preparation = new Set<OperationPreparationKind>()
  const resources = new Map<OperationResourceKind, number>()
  const resumeClasses = new Set<WorkflowResumeClass>()
  let localMediaUploadNodes = 0
  let maxDurationMs = 0
  let maxInputBytes = 0
  let maxOutputBytes = 0
  let totalOperationFanOut = 0
  for (const node of validated.graph.nodes) {
    const policy = validated.policiesByNode.get(node.key)
    if (policy === undefined) {
      throw new AtetCodeError(
        "internal",
        `Node ${node.key} lost its execution policy.`,
      )
    }
    effects.add(policy.effect)
    resumeClasses.add(policy.resume)
    if (isOperationGraphNode(node)) {
      families.add(operationFamily(node.executor.operation.kind))
      operationKinds.add(node.executor.operation.kind)
    } else if (isComputeGraphNode(node)) {
      families.add("compute")
      computeKeys.add(node.executor.compute.key)
    }
    for (const requirement of policy.preparation) preparation.add(requirement)
    for (const claim of policy.resources) {
      addResource(resources, claim.resource, claim.amount)
    }
    if (policy.effect === "paid-cloud" && policy.preparation.includes("local-media")) {
      localMediaUploadNodes = safeAdd(
        localMediaUploadNodes,
        1,
        "Local media upload node count",
      )
    }
    maxDurationMs = safeAdd(maxDurationMs, policy.maxDurationMs, "Workflow duration bound")
    maxInputBytes = safeAdd(maxInputBytes, policy.maxInputBytes, "Workflow input byte bound")
    maxOutputBytes = safeAdd(maxOutputBytes, policy.maxOutputBytes, "Workflow output byte bound")
    totalOperationFanOut = safeAdd(
      totalOperationFanOut,
      policy.maxFanOut,
      "Workflow operation fan-out bound",
    )
  }

  const unresolved = new Set<RequirementEnvelope["unresolved"][number]>()
  if (validated.topology.edges > 0) unresolved.add("dependency-outputs")
  if (
    preparation.has("local-media")
    || preparation.has("project-state")
    || preparation.has("recording-metadata")
  ) {
    unresolved.add("exact-media-hashes")
  }
  if (
    preparation.has("recording-metadata")
    || preparation.has("typed-text")
    || preparation.has("window-metadata")
  ) {
    unresolved.add("exact-sensitive-metadata-hashes")
  }
  if (effects.has("paid-cloud") || resources.has("paid-call")) {
    unresolved.add("prices")
  }
  if (
    effects.has("project-mutation")
    || operationKinds.has("render.project")
    || operationKinds.has("render.project-plan")
  ) {
    unresolved.add("project-generations")
  }
  if (families.has("render")) unresolved.add("render-plans")

  return parseCodeBoundary(RequirementEnvelopeSchema, {
    bounds: {
      depth: validated.topology.depth,
      edges: validated.topology.edges,
      localMediaUploadNodes,
      maxDurationMs,
      maxInputBytes,
      maxOutputBytes,
      nodes: validated.graph.nodes.length,
      paidCallClaims: resources.get("paid-call") ?? 0,
      structuralFanOut: validated.topology.structuralFanOut,
      totalOperationFanOut,
    },
    computeKeys: uniqueSorted(computeKeys),
    effects: uniqueSorted(effects),
    operationFamilies: uniqueSorted(families),
    operationKinds: uniqueSorted(operationKinds),
    preparation: uniqueSorted(preparation),
    resources: [...resources]
      .map(([resource, amount]) => ({ amount, resource }))
      .sort((left, right) => (
        left.resource.localeCompare(right.resource)
      )),
    resumeClasses: uniqueSorted(resumeClasses),
    unresolved: uniqueSorted(unresolved),
    version: REQUIREMENT_ENVELOPE_VERSION,
  }, "workflow requirement envelope")
}

function canonicalizeRequirementEnvelope(
  input: unknown,
): RequirementEnvelope {
  const envelope = parseCodeBoundary(
    RequirementEnvelopeSchema,
    input,
    "workflow requirement envelope",
  )
  return parseCodeBoundary(RequirementEnvelopeSchema, {
    ...envelope,
    computeKeys: envelope.computeKeys.map(canonicalAtetIdentity),
    operationFamilies: envelope.operationFamilies.map(canonicalAtetIdentity),
    operationKinds: envelope.operationKinds.map(canonicalAtetIdentity),
    version: REQUIREMENT_ENVELOPE_VERSION,
  }, "canonical workflow requirement envelope")
}

function resolveProjection(
  options: CompileWorkflowGraphOptions,
): WorkflowRegistryProjection {
  if (options.projection !== undefined) {
    if (
      options.registry !== undefined
      || options.projectionId !== undefined
      || options.trustedCompute !== undefined
    ) {
      throw new AtetCodeError(
        "invalid-data",
        "Compile with either a projection or a registry projection source, not both.",
      )
    }
    return parseWorkflowRegistryProjection(options.projection)
  }
  if (options.registry !== undefined) {
    if (options.projectionId === undefined) {
      throw new AtetCodeError(
        "invalid-data",
        "A registry projection source requires an explicit projection id.",
      )
    }
    return createWorkflowRegistryProjection(
      options.projectionId,
      options.registry,
      { trustedCompute: options.trustedCompute ?? false },
    )
  }
  if (options.projectionId !== undefined || options.trustedCompute !== undefined) {
    throw new AtetCodeError(
      "invalid-data",
      "A projection id or trusted-compute authority requires a registry projection source.",
    )
  }
  return PUBLIC_WORKFLOW_REGISTRY_PROJECTION
}

type UnsignedWorkflowCompilation = Omit<CompiledWorkflowGraph, "compilationSha256">

const RequiredCompilationComponentSchema = z.unknown().refine(
  value => value !== undefined,
  "Required",
)
const ShallowCompiledWorkflowGraphSchema = z.strictObject({
  compilationSha256: Sha256Schema,
  envelope: RequiredCompilationComponentSchema,
  graph: RequiredCompilationComponentSchema,
  graphSha256: Sha256Schema,
  limits: RequiredCompilationComponentSchema,
  projection: RequiredCompilationComponentSchema,
  topologicalWaves: RequiredCompilationComponentSchema,
  version: z.literal(WORKFLOW_COMPILATION_VERSION),
})

function boundedCompilationInput(input: unknown, name: string): unknown {
  return createBoundedJsonValueSnapshot(
    input,
    MAX_WORKFLOW_COMPILATION_BYTES,
    name,
    {
      maximumDepth: MAX_WORKFLOW_COMPILATION_DEPTH,
      maximumValues: MAX_WORKFLOW_COMPILATION_VALUES,
    },
  ).value
}

function workflowCompilationHashFromValidated(compilation: unknown): string {
  return canonicalJsonSha256Prefixed(
    `${WORKFLOW_COMPILATION_HASH_DOMAIN}\0`,
    compilation,
  )
}

export function createWorkflowCompilationHash(
  compilationInput: unknown,
): string {
  const bounded = boundedCompilationInput(
    compilationInput,
    "workflow compilation",
  )
  if (typeof bounded !== "object" || bounded === null || Array.isArray(bounded)) {
    return invalidData("Workflow compilation must be a plain object.")
  }
  const {
    compilationSha256: ignoredCompilationSha256,
    ...unsigned
  } = bounded as Record<string, unknown>
  void ignoredCompilationSha256
  const parsed = parseCodeBoundary(
    CompiledWorkflowGraphSchema.omit({ compilationSha256: true }),
    unsigned,
    "unsigned workflow compilation",
  )
  return workflowCompilationHashFromValidated(parsed)
}

export function compileWorkflowGraph(
  options: CompileWorkflowGraphOptions,
): CompiledWorkflowGraph {
  const limits = normalizeLimits(options.limits)
  const projection = resolveProjection(options)
  const validated = validateGraph(options.graph, projection, limits)
  const graphSha256 = workflowGraphHashFromNormalized(validated.graph)
  const unsigned: UnsignedWorkflowCompilation = {
    envelope: deriveRequirementEnvelope(validated),
    graph: validated.graph,
    graphSha256,
    limits,
    projection,
    topologicalWaves: validated.topology.waves,
    version: WORKFLOW_COMPILATION_VERSION,
  }
  return deepFreeze(parseCodeBoundary(CompiledWorkflowGraphSchema, {
    ...unsigned,
    compilationSha256: workflowCompilationHashFromValidated(unsigned),
  }, "compiled workflow graph"))
}

export function parseCompiledWorkflowGraph(input: unknown): CompiledWorkflowGraph {
  const bounded = boundedCompilationInput(input, "compiled workflow graph")
  const shallow = parseCodeBoundary(
    ShallowCompiledWorkflowGraphSchema,
    bounded,
    "compiled workflow graph",
  )
  const {
    compilationSha256: parsedCompilationSha256,
    ...unsigned
  } = shallow
  const expected = workflowCompilationHashFromValidated(unsigned)
  if (parsedCompilationSha256 !== expected) {
    throw new AtetCodeError(
      "invalid-data",
      "Workflow compilation hash does not match its contents.",
      {
        actualCompilationSha256: parsedCompilationSha256,
        expectedCompilationSha256: expected,
      },
    )
  }
  const parsed = parseCodeBoundary(
    CompiledWorkflowGraphSchema,
    bounded,
    "compiled workflow graph",
  )
  const exactGraph = parseAuthoredWorkflowGraphPreservingIdentity(parsed.graph)
  if (canonicalJsonSha256(parsed.graph) !== canonicalJsonSha256(exactGraph)) {
    throw new AtetCodeError(
      "invalid-data",
      "Compiled workflow graph nodes are not normalized.",
    )
  }
  const expectedGraphSha256 = workflowGraphHashFromNormalized(exactGraph)
  if (parsed.graphSha256 !== expectedGraphSha256) {
    throw new AtetCodeError(
      "invalid-data",
      "Workflow graph hash does not match its authenticated contents.",
      {
        actualGraphSha256: parsed.graphSha256,
        expectedGraphSha256,
      },
    )
  }
  const canonicalGraph = canonicalizeAuthoredWorkflowGraph(exactGraph)
  const canonicalProjection = parseWorkflowRegistryProjection(parsed.projection)
  const canonicalLimits = normalizeLimits(parsed.limits)
  const recompiled = compileWorkflowGraph({
    graph: canonicalGraph,
    limits: canonicalLimits,
    projection: canonicalProjection,
  })
  const canonicalUnsigned: UnsignedWorkflowCompilation = {
    envelope: canonicalizeRequirementEnvelope(parsed.envelope),
    graph: canonicalGraph,
    graphSha256: workflowGraphHashFromNormalized(canonicalGraph),
    limits: canonicalLimits,
    projection: canonicalProjection,
    topologicalWaves: parsed.topologicalWaves,
    version: WORKFLOW_COMPILATION_VERSION,
  }
  // The predecessor bytes and their nested graph/projection hashes were
  // verified before identity normalization. Recompilation must then match the
  // complete canonicalized semantics rather than the obsolete outer digest.
  if (
    recompiled.compilationSha256
    !== workflowCompilationHashFromValidated(canonicalUnsigned)
  ) {
    throw new AtetCodeError(
      "invalid-data",
      "Workflow compilation topology, requirements, or projection do not match the graph.",
    )
  }
  return recompiled
}
