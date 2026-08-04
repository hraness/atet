import {
  AuthoredWorkflowGraphV1Schema,
  CompiledWorkflowGraphSchema,
  GraphCompilerLimitsSchema,
  REQUIREMENT_ENVELOPE_VERSION,
  RequirementEnvelopeSchema,
  WORKFLOW_COMPILATION_VERSION,
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
import { canonicalJson, sha256Hex } from "./canonical-json.js"
import { parseCodeBoundary } from "./boundary.js"
import { TransmuteCodeError } from "./errors.js"
import {
  PUBLIC_WORKFLOW_REGISTRY_PROJECTION,
  createWorkflowRegistryProjection,
  normalizeOperationDiscovery,
  parseWorkflowRegistryProjection,
} from "./projection.js"

export const WORKFLOW_GRAPH_HASH_DOMAIN = "transmute.workflow.graph/v1" as const
export const WORKFLOW_COMPILATION_HASH_DOMAIN =
  "transmute.workflow.compilation/v1" as const

export const DEFAULT_GRAPH_COMPILER_LIMITS = Object.freeze({
  maxDepth: 64,
  maxEdges: 2_048,
  maxFanOut: 64,
  maxNodes: 256,
  maxTotalOperationFanOut: 4_096,
}) satisfies GraphCompilerLimits

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
  throw new TransmuteCodeError("invalid-data", message, details)
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

function safeAdd(left: number, right: number, name: string): number {
  const result = left + right
  if (!Number.isSafeInteger(result)) {
    return invalidData(`${name} exceeds the safe integer range.`, { left, right })
  }
  return result
}

function normalizeLimits(input: unknown): GraphCompilerLimits {
  if (input === undefined) return DEFAULT_GRAPH_COMPILER_LIMITS
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return parseCodeBoundary(
      GraphCompilerLimitsSchema,
      input,
      "graph compiler limits",
    )
  }
  return parseCodeBoundary(GraphCompilerLimitsSchema, {
    ...DEFAULT_GRAPH_COMPILER_LIMITS,
    ...input,
  }, "graph compiler limits")
}

export function normalizeAuthoredWorkflowGraph(
  graphInput: unknown,
): AuthoredWorkflowGraphV1 {
  const graph = parseCodeBoundary(
    AuthoredWorkflowGraphV1Schema,
    graphInput,
    "authored workflow graph",
  )
  const sorted = {
    ...graph,
    nodes: [...graph.nodes].sort((left, right) => left.key.localeCompare(right.key)),
  }
  const canonical = JSON.parse(canonicalJson(sorted)) as unknown
  return parseCodeBoundary(
    AuthoredWorkflowGraphV1Schema,
    canonical,
    "normalized authored workflow graph",
  )
}

export function createWorkflowGraphHash(graphInput: unknown): string {
  const graph = normalizeAuthoredWorkflowGraph(graphInput)
  return sha256Hex(
    `${WORKFLOW_GRAPH_HASH_DOMAIN}\0${canonicalJson(graph)}`,
  )
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
  return references.sort((left, right) => (
    left.$ref.nodeKey.localeCompare(right.$ref.nodeKey)
    || left.$ref.schemaId.localeCompare(right.$ref.schemaId)
    || canonicalJson(left.$ref.path ?? []).localeCompare(
      canonicalJson(right.$ref.path ?? []),
    )
  ))
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
  const graph = normalizeAuthoredWorkflowGraph(graphInput)
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
        throw new TransmuteCodeError(
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
        throw new TransmuteCodeError(
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
      throw new TransmuteCodeError(
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
    throw new TransmuteCodeError(
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
      throw new TransmuteCodeError(
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
      .sort((left, right) => left.resource.localeCompare(right.resource)),
    resumeClasses: uniqueSorted(resumeClasses),
    unresolved: uniqueSorted(unresolved),
    version: REQUIREMENT_ENVELOPE_VERSION,
  }, "workflow requirement envelope")
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
      throw new TransmuteCodeError(
        "invalid-data",
        "Compile with either a projection or a registry projection source, not both.",
      )
    }
    return parseWorkflowRegistryProjection(options.projection)
  }
  if (options.registry !== undefined) {
    if (options.projectionId === undefined) {
      throw new TransmuteCodeError(
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
    throw new TransmuteCodeError(
      "invalid-data",
      "A projection id or trusted-compute authority requires a registry projection source.",
    )
  }
  return PUBLIC_WORKFLOW_REGISTRY_PROJECTION
}

type UnsignedWorkflowCompilation = Omit<CompiledWorkflowGraph, "compilationSha256">

export function createWorkflowCompilationHash(
  compilationInput: unknown,
): string {
  const input = compilationInput as Partial<CompiledWorkflowGraph>
  const unsigned = {
    envelope: input.envelope,
    graph: input.graph,
    graphSha256: input.graphSha256,
    limits: input.limits,
    projection: input.projection,
    topologicalWaves: input.topologicalWaves,
    version: input.version,
  }
  const parsed = parseCodeBoundary(
    CompiledWorkflowGraphSchema.omit({ compilationSha256: true }),
    unsigned,
    "unsigned workflow compilation",
  )
  return sha256Hex(
    `${WORKFLOW_COMPILATION_HASH_DOMAIN}\0${canonicalJson(parsed)}`,
  )
}

export function compileWorkflowGraph(
  options: CompileWorkflowGraphOptions,
): CompiledWorkflowGraph {
  const limits = normalizeLimits(options.limits)
  const projection = resolveProjection(options)
  const discovery = normalizeOperationDiscovery(projection.discovery)
  const normalizedProjection = createWorkflowRegistryProjection(
    projection.id,
    discovery,
    { trustedCompute: projection.trustedCompute },
  )
  if (projection.projectionSha256 !== normalizedProjection.projectionSha256) {
    throw new TransmuteCodeError(
      "invalid-data",
      "Workflow registry projection hash does not match its normalized contents.",
      { projectionId: projection.id },
    )
  }
  const validated = validateGraph(options.graph, normalizedProjection, limits)
  const graphSha256 = createWorkflowGraphHash(validated.graph)
  const unsigned: UnsignedWorkflowCompilation = {
    envelope: deriveRequirementEnvelope(validated),
    graph: validated.graph,
    graphSha256,
    limits,
    projection: normalizedProjection,
    topologicalWaves: validated.topology.waves,
    version: WORKFLOW_COMPILATION_VERSION,
  }
  return deepFreeze(parseCodeBoundary(CompiledWorkflowGraphSchema, {
    ...unsigned,
    compilationSha256: createWorkflowCompilationHash(unsigned),
  }, "compiled workflow graph"))
}

export function parseCompiledWorkflowGraph(input: unknown): CompiledWorkflowGraph {
  const parsed = parseCodeBoundary(
    CompiledWorkflowGraphSchema,
    input,
    "compiled workflow graph",
  )
  const expected = createWorkflowCompilationHash(parsed)
  if (parsed.compilationSha256 !== expected) {
    throw new TransmuteCodeError(
      "invalid-data",
      "Workflow compilation hash does not match its contents.",
      {
        actualCompilationSha256: parsed.compilationSha256,
        expectedCompilationSha256: expected,
      },
    )
  }
  const recompiled = compileWorkflowGraph({
    graph: parsed.graph,
    limits: parsed.limits,
    projection: parsed.projection,
  })
  if (canonicalJson(recompiled) !== canonicalJson(parsed)) {
    throw new TransmuteCodeError(
      "invalid-data",
      "Workflow compilation topology, requirements, or projection do not match the graph.",
    )
  }
  return recompiled
}
