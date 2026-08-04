import {
  AuthoredComputeIdentitySchema,
  AuthoredGraphNodeV1Schema,
  AuthoredWorkflowGraphV1Schema,
  NodeKeySegmentSchema,
  OperationDiscoverySchema,
  SerializedRefV1Schema,
  TRUSTED_COMPUTE_BRAND,
  TRUSTED_COMPUTE_VERSION,
  WORKFLOW_GRAPH_VERSION,
  WORKFLOW_REF_BRAND,
  WORKFLOW_REF_VERSION,
  WorkflowIdentitySchema,
  type AuthoredGraphNodeV1,
  type AuthoredWorkflowGraphV1,
  type AnyTrustedComputeDefinition,
  type GraphInputValue,
  type OperationContract,
  type OperationDiscovery,
  type OperationDiscoverySource,
  type OperationInputValue,
  type OperationKind,
  type Ref,
  type SerializedRefV1,
  type TrustedComputeDefinition,
  type WorkflowIdentity,
  type WorkflowOutputBinding,
  type WorkflowOutputValue,
  type WorkflowRegistryProjection,
} from "./contracts.js"
import { parseCodeBoundary } from "./boundary.js"
import { TransmuteCodeError } from "./errors.js"

export type OperationDiscoveryProvider =
  | OperationDiscoverySource
  | Pick<WorkflowRegistryProjection, "discovery">

export interface OperationNodeOptions {
  /** Adds causal dependencies without threading a producer value into input. */
  readonly after?: Ref<unknown> | readonly Ref<unknown>[]
  readonly label?: string
}

export interface UntypedOperationRequest {
  readonly input: unknown
  readonly kind: OperationKind
  readonly version: number
}

export interface WorkflowFragment<Input, Output> {
  build(builder: WorkflowGraphBuilder, input: Input): Output
}

interface BuilderState {
  readonly computes: Map<string, AnyTrustedComputeDefinition>
  readonly discovery: ReadonlyMap<string, OperationDiscovery>
  readonly nodes: Map<string, AuthoredGraphNodeV1>
  readonly references: WeakSet<object>
}

interface EncodedInput {
  readonly dependencies: readonly string[]
  readonly value: GraphInputValue
}

const MAX_AUTHORING_VALUE_DEPTH = 128

function discoveryKey(kind: OperationKind, version: number): string {
  return `${kind}@${String(version)}`
}

function providerDiscovery(
  provider: OperationDiscoveryProvider,
): readonly OperationDiscovery[] {
  const source = provider as Partial<OperationDiscoverySource>
  if (typeof source.list === "function") return source.list()
  return (provider as Pick<WorkflowRegistryProjection, "discovery">).discovery
}

function operationContractValue<Input, Output>(
  discovery: Pick<OperationDiscovery, "inputSchemaId" | "kind" | "outputSchemaId" | "version">,
): OperationContract<Input, Output> {
  return Object.freeze({
    inputSchemaId: discovery.inputSchemaId,
    kind: discovery.kind,
    outputSchemaId: discovery.outputSchemaId,
    version: discovery.version,
  })
}

function isPlainRecord(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function cloneSerializedRef(reference: Ref<unknown>): SerializedRefV1 {
  return parseCodeBoundary(
    SerializedRefV1Schema,
    reference.serialized,
    "workflow reference",
  )
}

function isOwnedRef(value: unknown, state: BuilderState): value is Ref<unknown> {
  return typeof value === "object"
    && value !== null
    && WORKFLOW_REF_BRAND in value
    && state.references.has(value)
}

function encodeInputValue(
  input: unknown,
  state: BuilderState,
  dependencies: Set<string>,
  ancestors: Set<object>,
  depth: number,
): GraphInputValue {
  if (depth > MAX_AUTHORING_VALUE_DEPTH) {
    throw new TransmuteCodeError(
      "invalid-data",
      `Workflow input nesting exceeds ${String(MAX_AUTHORING_VALUE_DEPTH)} levels.`,
    )
  }
  if (isOwnedRef(input, state)) {
    const serialized = cloneSerializedRef(input)
    dependencies.add(serialized.$ref.nodeKey)
    return serialized
  }
  if (typeof input === "object" && input !== null && WORKFLOW_REF_BRAND in input) {
    throw new TransmuteCodeError(
      "invalid-data",
      "Use a typed Ref value created by this workflow graph builder.",
    )
  }
  if (input === null || typeof input === "boolean" || typeof input === "string") {
    return input
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new TransmuteCodeError(
        "invalid-data",
        "Workflow node input numbers must be finite.",
      )
    }
    return Object.is(input, -0) ? 0 : input
  }
  if (typeof input !== "object") {
    throw new TransmuteCodeError(
      "invalid-data",
      `Workflow node input cannot contain ${typeof input} values.`,
    )
  }
  if (ancestors.has(input)) {
    throw new TransmuteCodeError(
      "invalid-data",
      "Workflow node input cannot contain cycles.",
    )
  }
  ancestors.add(input)
  try {
    if (Array.isArray(input)) {
      return input.map(value => encodeInputValue(
        value,
        state,
        dependencies,
        ancestors,
        depth + 1,
      ))
    }
    if (!isPlainRecord(input)) {
      throw new TransmuteCodeError(
        "invalid-data",
        "Workflow node input accepts only JSON values and typed workflow references.",
      )
    }
    if (Object.hasOwn(input, "$ref")) {
      throw new TransmuteCodeError(
        "invalid-data",
        "Use a typed Ref value instead of constructing the reserved $ref field.",
      )
    }
    const encoded: Record<string, GraphInputValue> = {}
    for (const key of Object.keys(input).sort()) {
      if (key === "__proto__") {
        throw new TransmuteCodeError(
          "invalid-data",
          "Workflow inputs cannot contain the reserved __proto__ object key.",
        )
      }
      encoded[key] = encodeInputValue(
        input[key],
        state,
        dependencies,
        ancestors,
        depth + 1,
      )
    }
    return encoded
  } finally {
    ancestors.delete(input)
  }
}

function encodeOperationInput(input: unknown, state: BuilderState): EncodedInput {
  const dependencies = new Set<string>()
  const value = encodeInputValue(input, state, dependencies, new Set(), 0)
  return {
    dependencies: [...dependencies].sort((left, right) => left.localeCompare(right)),
    value,
  }
}

function encodeControlDependencies(
  after: OperationNodeOptions["after"],
  state: BuilderState,
): readonly string[] {
  if (after === undefined) return []
  const references = Array.isArray(after) ? after : [after]
  const dependencies = new Set<string>()
  for (const reference of references) {
    if (!isOwnedRef(reference, state)) {
      throw new TransmuteCodeError(
        "invalid-data",
        "Operation control dependencies must be typed Ref values created by this workflow graph builder.",
      )
    }
    dependencies.add(cloneSerializedRef(reference).$ref.nodeKey)
  }
  return [...dependencies].sort((left, right) => left.localeCompare(right))
}

function combineDependencies(
  dataDependencies: readonly string[],
  controlDependencies: readonly string[],
): readonly string[] {
  return [...new Set([...dataDependencies, ...controlDependencies])]
    .sort((left, right) => left.localeCompare(right))
}

function encodeOutputValue(
  output: unknown,
  state: BuilderState,
  ancestors: Set<object>,
  depth: number,
): WorkflowOutputBinding {
  if (depth > MAX_AUTHORING_VALUE_DEPTH) {
    throw new TransmuteCodeError(
      "invalid-data",
      `Workflow output nesting exceeds ${String(MAX_AUTHORING_VALUE_DEPTH)} levels.`,
    )
  }
  if (isOwnedRef(output, state)) return cloneSerializedRef(output)
  if (typeof output !== "object" || output === null) {
    throw new TransmuteCodeError(
      "invalid-data",
      "Workflow outputs must contain only typed references, arrays, and named objects.",
    )
  }
  if (ancestors.has(output)) {
    throw new TransmuteCodeError("invalid-data", "Workflow outputs cannot contain cycles.")
  }
  ancestors.add(output)
  try {
    if (Array.isArray(output)) {
      return output.map(value => encodeOutputValue(value, state, ancestors, depth + 1))
    }
    if (!isPlainRecord(output)) {
      throw new TransmuteCodeError(
        "invalid-data",
        "Workflow outputs accept only typed references, arrays, and plain objects.",
      )
    }
    if (Object.hasOwn(output, "$ref")) {
      throw new TransmuteCodeError(
        "invalid-data",
        "Use a typed Ref value instead of constructing the reserved $ref field.",
      )
    }
    const encoded: Record<string, WorkflowOutputBinding> = {}
    for (const key of Object.keys(output).sort()) {
      if (key === "__proto__") {
        throw new TransmuteCodeError(
          "invalid-data",
          "Workflow outputs cannot contain the reserved __proto__ object key.",
        )
      }
      encoded[key] = encodeOutputValue(output[key], state, ancestors, depth + 1)
    }
    return encoded
  } finally {
    ancestors.delete(output)
  }
}

function createReference<Output>(
  nodeKey: string,
  schemaId: string,
  state: BuilderState,
  path: readonly (number | string)[] = [],
): Ref<Output> {
  const reference = Object.freeze({
    [WORKFLOW_REF_BRAND]: (): Output => {
      throw new TransmuteCodeError(
        "internal",
        "A workflow reference type marker is not executable.",
      )
    },
    at: (index: number) => {
      if (!Number.isSafeInteger(index) || index < 0) {
        throw new TransmuteCodeError(
          "invalid-data",
          "Workflow reference array indexes must be nonnegative safe integers.",
        )
      }
      return createReference(nodeKey, schemaId, state, [...path, index]) as (
        Output extends readonly (infer Item)[] ? Ref<Item> : never
      )
    },
    select: <Key extends Extract<keyof Output, string>>(key: Key): Ref<Output[Key]> => {
      if (typeof key !== "string" || key.length < 1 || key.length > 128) {
        throw new TransmuteCodeError(
          "invalid-data",
          "Workflow reference field names must contain 1–128 characters.",
        )
      }
      return createReference<Output[Key]>(nodeKey, schemaId, state, [...path, key])
    },
    serialized: Object.freeze({
      $ref: Object.freeze({
        nodeKey,
        ...(path.length === 0 ? {} : { path: [...path] }),
        schemaId,
      }),
      version: WORKFLOW_REF_VERSION,
    }),
  }) as unknown as Ref<Output>
  state.references.add(reference)
  return reference
}

function createState(provider: OperationDiscoveryProvider): BuilderState {
  const discovery = new Map<string, OperationDiscovery>()
  for (const input of providerDiscovery(provider)) {
    const item = parseCodeBoundary(
      OperationDiscoverySchema,
      input,
      "operation discovery entry",
    )
    const key = discoveryKey(item.kind, item.version)
    if (discovery.has(key)) {
      throw new TransmuteCodeError(
        "conflict",
        `Duplicate operation discovery entry: ${key}`,
        { kind: item.kind, version: item.version },
      )
    }
    discovery.set(key, item)
  }
  return {
    computes: new Map(),
    discovery,
    nodes: new Map(),
    references: new WeakSet(),
  }
}

export function defineWorkflowFragment<Input, Output>(
  build: (builder: WorkflowGraphBuilder, input: Input) => Output,
): WorkflowFragment<Input, Output> {
  return Object.freeze({ build })
}

export function operationContract<Input, Output>(
  provider: OperationDiscoveryProvider,
  kind: OperationKind,
  version: number,
): OperationContract<Input, Output> {
  const discovery = providerDiscovery(provider).find(
    candidate => candidate.kind === kind && candidate.version === version,
  )
  if (discovery === undefined) {
    throw new TransmuteCodeError(
      "unsupported-plan",
      `Unsupported operation: ${kind}@${String(version)}`,
      { kind, version },
    )
  }
  return operationContractValue<Input, Output>(discovery)
}

export class WorkflowGraphBuilder {
  readonly #namespace: readonly string[]
  readonly #state: BuilderState

  private constructor(state: BuilderState, namespace: readonly string[]) {
    this.#namespace = namespace
    this.#state = state
  }

  static create(provider: OperationDiscoveryProvider): WorkflowGraphBuilder {
    return new WorkflowGraphBuilder(createState(provider), [])
  }

  namespace(segmentInput: string): WorkflowGraphBuilder {
    const segment = parseCodeBoundary(
      NodeKeySegmentSchema,
      segmentInput,
      "workflow namespace segment",
    )
    return new WorkflowGraphBuilder(this.#state, [...this.#namespace, segment])
  }

  fragment<Input, Output>(
    namespace: string,
    fragment: WorkflowFragment<Input, Output>,
    input: Input,
  ): Output {
    return fragment.build(this.namespace(namespace), input)
  }

  operation<Input, Output>(
    keyInput: string,
    contract: OperationContract<Input, Output>,
    input: OperationInputValue<Input>,
    options: OperationNodeOptions = {},
  ): Ref<Output> {
    return this.#addOperation<Output>(keyInput, {
      input,
      inputSchemaId: contract.inputSchemaId,
      kind: contract.kind,
      outputSchemaId: contract.outputSchemaId,
      version: contract.version,
    }, options)
  }

  operationByKind<Output>(
    keyInput: string,
    request: UntypedOperationRequest,
    options: OperationNodeOptions = {},
  ): Ref<Output> {
    const discovery = this.#state.discovery.get(
      discoveryKey(request.kind, request.version),
    )
    if (discovery === undefined) {
      throw new TransmuteCodeError(
        "unsupported-plan",
        `Unsupported operation: ${request.kind}@${String(request.version)}`,
        { kind: request.kind, version: request.version },
      )
    }
    return this.#addOperation<Output>(keyInput, {
      input: request.input,
      inputSchemaId: discovery.inputSchemaId,
      kind: request.kind,
      outputSchemaId: discovery.outputSchemaId,
      version: request.version,
    }, options)
  }

  compute<Input, Output>(
    keyInput: string,
    definition: TrustedComputeDefinition<Input, Output>,
    input: OperationInputValue<Input>,
    options: OperationNodeOptions = {},
  ): Ref<Output> {
    if (
      typeof definition !== "object"
      || definition === null
      || definition[TRUSTED_COMPUTE_BRAND] !== true
    ) {
      throw new TransmuteCodeError(
        "invalid-data",
        "Compute nodes require a definition created by defineCompute().",
      )
    }
    const compute = parseCodeBoundary(
      AuthoredComputeIdentitySchema,
      {
        bounds: definition.bounds,
        key: definition.key,
        version: TRUSTED_COMPUTE_VERSION,
      },
      "trusted compute identity",
    )
    const existing = this.#state.computes.get(compute.key)
    if (existing !== undefined && existing !== definition) {
      throw new TransmuteCodeError(
        "conflict",
        `Duplicate trusted compute key: ${compute.key}`,
        { key: compute.key },
      )
    }
    this.#state.computes.set(compute.key, definition)
    const key = this.#nodeKey(keyInput)
    const encoded = encodeOperationInput(input, this.#state)
    const controlDependencies = encodeControlDependencies(options.after, this.#state)
    const node = parseCodeBoundary(AuthoredGraphNodeV1Schema, {
      controlDependencies,
      dependencies: combineDependencies(encoded.dependencies, controlDependencies),
      executor: { compute, kind: "compute" },
      input: encoded.value,
      inputSchemaId: definition.inputSchemaId,
      key,
      ...(options.label === undefined ? {} : { label: options.label }),
      outputSchemaId: definition.outputSchemaId,
    }, "authored compute node")
    this.#state.nodes.set(key, node)
    return createReference<Output>(key, definition.outputSchemaId, this.#state)
  }

  computeDefinitions(): readonly AnyTrustedComputeDefinition[] {
    return Object.freeze(
      [...this.#state.computes.values()]
        .sort((left, right) => left.key.localeCompare(right.key)),
    )
  }

  build(
    workflowInput: WorkflowIdentity,
    outputs: WorkflowOutputValue,
  ): AuthoredWorkflowGraphV1 {
    const workflow = parseCodeBoundary(
      WorkflowIdentitySchema,
      workflowInput,
      "workflow identity",
    )
    return parseCodeBoundary(AuthoredWorkflowGraphV1Schema, {
      nodes: [...this.#state.nodes.values()]
        .sort((left, right) => left.key.localeCompare(right.key)),
      outputs: encodeOutputValue(outputs, this.#state, new Set(), 0),
      version: WORKFLOW_GRAPH_VERSION,
      workflow,
    }, "authored workflow graph")
  }

  #nodeKey(keyInput: string): string {
    const keySegment = parseCodeBoundary(
      NodeKeySegmentSchema,
      keyInput,
      "workflow node key segment",
    )
    const key = [...this.#namespace, keySegment].join("/")
    if (this.#state.nodes.has(key)) {
      throw new TransmuteCodeError(
        "conflict",
        `Duplicate workflow node key: ${key}`,
        { nodeKey: key },
      )
    }
    return key
  }

  #addOperation<Output>(
    keyInput: string,
    request: {
      readonly input: unknown
      readonly inputSchemaId: string
      readonly kind: OperationKind
      readonly outputSchemaId: string
      readonly version: number
    },
    options: OperationNodeOptions,
  ): Ref<Output> {
    const key = this.#nodeKey(keyInput)
    const discovery = this.#state.discovery.get(discoveryKey(request.kind, request.version))
    if (discovery === undefined) {
      throw new TransmuteCodeError(
        "unsupported-plan",
        `Unsupported operation: ${request.kind}@${String(request.version)}`,
        { kind: request.kind, version: request.version },
      )
    }
    if (
      request.inputSchemaId !== discovery.inputSchemaId
      || request.outputSchemaId !== discovery.outputSchemaId
    ) {
      throw new TransmuteCodeError(
        "invalid-data",
        `Operation contract schema mismatch for ${request.kind}@${String(request.version)}.`,
        {
          actualInputSchemaId: request.inputSchemaId,
          actualOutputSchemaId: request.outputSchemaId,
          expectedInputSchemaId: discovery.inputSchemaId,
          expectedOutputSchemaId: discovery.outputSchemaId,
          kind: request.kind,
          version: request.version,
        },
      )
    }
    const encoded = encodeOperationInput(request.input, this.#state)
    const controlDependencies = encodeControlDependencies(options.after, this.#state)
    const node = parseCodeBoundary(AuthoredGraphNodeV1Schema, {
      controlDependencies,
      dependencies: combineDependencies(encoded.dependencies, controlDependencies),
      executor: {
        kind: "operation",
        operation: { kind: discovery.kind, version: discovery.version },
      },
      input: encoded.value,
      inputSchemaId: discovery.inputSchemaId,
      key,
      ...(options.label === undefined ? {} : { label: options.label }),
      outputSchemaId: discovery.outputSchemaId,
    }, "authored operation node")
    this.#state.nodes.set(key, node)
    return createReference<Output>(key, discovery.outputSchemaId, this.#state)
  }
}
