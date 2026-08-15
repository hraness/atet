import {
  AuthoredComputeIdentitySchema,
  AuthoredGraphNodeV1Schema,
  AuthoredWorkflowGraphV1Schema,
  MAX_SERIALIZED_GRAPH_NODES,
  MAX_SERIALIZED_NODE_DEPENDENCIES,
  MAX_SERIALIZED_REF_PATH_SEGMENTS,
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
import { AtetCodeError } from "./errors.js"
import { deepFreezeJson } from "./json-snapshot.js"
import { boundedOperationDiscoveryList } from "./projection.js"

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
  authoredValues: number
  readonly computes: Map<string, AnyTrustedComputeDefinition>
  readonly discovery: ReadonlyMap<string, OperationDiscovery>
  readonly nodes: Map<string, AuthoredGraphNodeV1>
  readonly references: WeakSet<object>
}

interface EncodedInput {
  readonly dependencies: readonly string[]
  readonly value: GraphInputValue
  readonly values: number
}

const MAX_AUTHORING_VALUE_DEPTH = 128
const MAX_AUTHORING_VALUES = 1_000_000

interface EncodingBudget {
  consumed: number
  readonly maximum: number
}

function consumeAuthoringValue(budget: EncodingBudget): void {
  if (budget.consumed >= budget.maximum) {
    throw new AtetCodeError(
      "invalid-data",
      `Workflow authoring values exceed the ${String(MAX_AUTHORING_VALUES)} value limit.`,
    )
  }
  budget.consumed += 1
}

function consumeAuthoringValues(
  budget: EncodingBudget,
  additional: number,
): void {
  requireAuthoringCapacity(budget, additional)
  budget.consumed += additional
}

function requireAuthoringCapacity(
  budget: EncodingBudget,
  additional: number,
): void {
  if (additional > budget.maximum - budget.consumed) {
    throw new AtetCodeError(
      "invalid-data",
      `Workflow authoring values exceed the ${String(MAX_AUTHORING_VALUES)} value limit.`,
    )
  }
}

function encodingBudget(state: BuilderState): EncodingBudget {
  return {
    consumed: 0,
    maximum: MAX_AUTHORING_VALUES - state.authoredValues,
  }
}

function requireStateCapacity(state: BuilderState, additional: number): void {
  if (additional > MAX_AUTHORING_VALUES - state.authoredValues) {
    throw new AtetCodeError(
      "invalid-data",
      `Workflow authoring values exceed the ${String(MAX_AUTHORING_VALUES)} value limit.`,
    )
  }
}

function discoveryKey(kind: OperationKind, version: number): string {
  return `${kind}@${String(version)}`
}

function providerDiscovery(
  provider: OperationDiscoveryProvider,
): readonly unknown[] {
  const source = provider as Partial<OperationDiscoverySource>
  const discovery = typeof source.list === "function"
    ? source.list()
    : (provider as Pick<WorkflowRegistryProjection, "discovery">).discovery
  return boundedOperationDiscoveryList(discovery)
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

function rejectEnumerableSymbols(
  descriptors: object,
  name: string,
): void {
  if (Object.getOwnPropertySymbols(descriptors).some(
    symbol => (Reflect.get(descriptors, symbol) as PropertyDescriptor | undefined)
      ?.enumerable === true,
  )) {
    throw new AtetCodeError(
      "invalid-data",
      `${name} cannot contain enumerable symbol properties.`,
    )
  }
}

function cloneSerializedRef(reference: Ref<unknown>): SerializedRefV1 {
  return deepFreezeJson(parseCodeBoundary(
    SerializedRefV1Schema,
    reference.serialized,
    "workflow reference",
  ))
}

function serializedReferenceValueCount(reference: SerializedRefV1): number {
  const path = reference.$ref.path
  // Root object + its two fields + nested $ref fields + optional path values.
  return path === undefined ? 5 : 6 + path.length
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
  budget: EncodingBudget,
): GraphInputValue {
  if (depth > MAX_AUTHORING_VALUE_DEPTH) {
    throw new AtetCodeError(
      "invalid-data",
      `Workflow input nesting exceeds ${String(MAX_AUTHORING_VALUE_DEPTH)} levels.`,
    )
  }
  if (isOwnedRef(input, state)) {
    const serialized = cloneSerializedRef(input)
    consumeAuthoringValues(budget, serializedReferenceValueCount(serialized))
    dependencies.add(serialized.$ref.nodeKey)
    return serialized
  }
  consumeAuthoringValue(budget)
  if (typeof input === "object" && input !== null && WORKFLOW_REF_BRAND in input) {
    throw new AtetCodeError(
      "invalid-data",
      "Use a typed Ref value created by this workflow graph builder.",
    )
  }
  if (input === null || typeof input === "boolean" || typeof input === "string") {
    return input
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new AtetCodeError(
        "invalid-data",
        "Workflow node input numbers must be finite.",
      )
    }
    return Object.is(input, -0) ? 0 : input
  }
  if (typeof input !== "object") {
    throw new AtetCodeError(
      "invalid-data",
      `Workflow node input cannot contain ${typeof input} values.`,
    )
  }
  if (ancestors.has(input)) {
    throw new AtetCodeError(
      "invalid-data",
      "Workflow node input cannot contain cycles.",
    )
  }
  ancestors.add(input)
  try {
    if (Array.isArray(input)) {
      const length = input.length
      requireAuthoringCapacity(budget, length)
      const descriptors = Object.getOwnPropertyDescriptors(input)
      rejectEnumerableSymbols(descriptors, "Workflow node input arrays")
      const keys = Object.keys(descriptors)
        .filter(key => descriptors[key]?.enumerable === true)
      if (
        keys.length !== length
        || keys.some((key, index) => key !== String(index))
      ) {
        throw new AtetCodeError(
          "invalid-data",
          "Workflow node input arrays must be dense and cannot have named properties.",
        )
      }
      const encoded: GraphInputValue[] = []
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)]
        if (
          descriptor === undefined
          || descriptor.get !== undefined
          || descriptor.set !== undefined
        ) {
          throw new AtetCodeError(
            "invalid-data",
            "Workflow node input arrays must contain plain data elements.",
          )
        }
        encoded.push(encodeInputValue(
          descriptor.value,
          state,
          dependencies,
          ancestors,
          depth + 1,
          budget,
        ))
      }
      return encoded
    }
    if (!isPlainRecord(input)) {
      throw new AtetCodeError(
        "invalid-data",
        "Workflow node input accepts only JSON values and typed workflow references.",
      )
    }
    if (Object.hasOwn(input, "$ref")) {
      throw new AtetCodeError(
        "invalid-data",
        "Use a typed Ref value instead of constructing the reserved $ref field.",
      )
    }
    const descriptors = Object.getOwnPropertyDescriptors(input)
    rejectEnumerableSymbols(descriptors, "Workflow node inputs")
    const keys = Object.keys(descriptors)
      .filter(key => descriptors[key]?.enumerable === true)
      .sort()
    requireAuthoringCapacity(budget, keys.length)
    const encoded: Record<string, GraphInputValue> = {}
    for (const key of keys) {
      if (key === "__proto__") {
        throw new AtetCodeError(
          "invalid-data",
          "Workflow inputs cannot contain the reserved __proto__ object key.",
        )
      }
      const descriptor = descriptors[key]
      if (
        descriptor === undefined
        || descriptor.get !== undefined
        || descriptor.set !== undefined
      ) {
        throw new AtetCodeError(
          "invalid-data",
          "Workflow node input properties must be plain data properties.",
        )
      }
      encoded[key] = encodeInputValue(
        descriptor.value,
        state,
        dependencies,
        ancestors,
        depth + 1,
        budget,
      )
    }
    return encoded
  } finally {
    ancestors.delete(input)
  }
}

function encodeOperationInput(input: unknown, state: BuilderState): EncodedInput {
  const dependencies = new Set<string>()
  const budget = encodingBudget(state)
  const value = encodeInputValue(input, state, dependencies, new Set(), 0, budget)
  return {
    dependencies: [...dependencies].sort((left, right) => left.localeCompare(right)),
    value,
    values: budget.consumed,
  }
}

function encodeControlDependencies(
  after: OperationNodeOptions["after"],
  state: BuilderState,
): readonly string[] {
  if (after === undefined) return []
  const dependencies = new Set<string>()
  const appendReference = (reference: unknown): void => {
    if (!isOwnedRef(reference, state)) {
      throw new AtetCodeError(
        "invalid-data",
        "Operation control dependencies must be typed Ref values created by this workflow graph builder.",
      )
    }
    dependencies.add(cloneSerializedRef(reference).$ref.nodeKey)
  }
  if (!Array.isArray(after)) {
    appendReference(after)
    return [...dependencies]
  }
  const length = after.length
  if (length > MAX_SERIALIZED_NODE_DEPENDENCIES) {
    throw new AtetCodeError(
      "invalid-data",
      `Operation control dependencies cannot exceed ${String(MAX_SERIALIZED_NODE_DEPENDENCIES)} entries.`,
    )
  }
  const descriptors = Object.getOwnPropertyDescriptors(after)
  rejectEnumerableSymbols(descriptors, "Operation control dependencies")
  const keys = Object.keys(descriptors)
    .filter(key => descriptors[key]?.enumerable === true)
  if (
    keys.length !== length
    || keys.some((key, index) => key !== String(index))
  ) {
    throw new AtetCodeError(
      "invalid-data",
      "Operation control dependencies must be a dense array without named properties.",
    )
  }
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (
      descriptor === undefined
      || descriptor.get !== undefined
      || descriptor.set !== undefined
    ) {
      throw new AtetCodeError(
        "invalid-data",
        "Operation control dependencies must contain plain data elements.",
      )
    }
    appendReference(descriptor.value)
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
  budget: EncodingBudget,
): WorkflowOutputBinding {
  if (depth > MAX_AUTHORING_VALUE_DEPTH) {
    throw new AtetCodeError(
      "invalid-data",
      `Workflow output nesting exceeds ${String(MAX_AUTHORING_VALUE_DEPTH)} levels.`,
    )
  }
  if (isOwnedRef(output, state)) {
    const serialized = cloneSerializedRef(output)
    consumeAuthoringValues(budget, serializedReferenceValueCount(serialized))
    return serialized
  }
  consumeAuthoringValue(budget)
  if (typeof output !== "object" || output === null) {
    throw new AtetCodeError(
      "invalid-data",
      "Workflow outputs must contain only typed references, arrays, and named objects.",
    )
  }
  if (ancestors.has(output)) {
    throw new AtetCodeError("invalid-data", "Workflow outputs cannot contain cycles.")
  }
  ancestors.add(output)
  try {
    if (Array.isArray(output)) {
      const length = output.length
      requireAuthoringCapacity(budget, length)
      const descriptors = Object.getOwnPropertyDescriptors(output)
      rejectEnumerableSymbols(descriptors, "Workflow output arrays")
      const keys = Object.keys(descriptors)
        .filter(key => descriptors[key]?.enumerable === true)
      if (
        keys.length !== length
        || keys.some((key, index) => key !== String(index))
      ) {
        throw new AtetCodeError(
          "invalid-data",
          "Workflow output arrays must be dense and cannot have named properties.",
        )
      }
      const encoded: WorkflowOutputBinding[] = []
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)]
        if (
          descriptor === undefined
          || descriptor.get !== undefined
          || descriptor.set !== undefined
        ) {
          throw new AtetCodeError(
            "invalid-data",
            "Workflow output arrays must contain plain data elements.",
          )
        }
        encoded.push(encodeOutputValue(
          descriptor.value,
          state,
          ancestors,
          depth + 1,
          budget,
        ))
      }
      return encoded
    }
    if (!isPlainRecord(output)) {
      throw new AtetCodeError(
        "invalid-data",
        "Workflow outputs accept only typed references, arrays, and plain objects.",
      )
    }
    if (Object.hasOwn(output, "$ref")) {
      throw new AtetCodeError(
        "invalid-data",
        "Use a typed Ref value instead of constructing the reserved $ref field.",
      )
    }
    const descriptors = Object.getOwnPropertyDescriptors(output)
    rejectEnumerableSymbols(descriptors, "Workflow outputs")
    const keys = Object.keys(descriptors)
      .filter(key => descriptors[key]?.enumerable === true)
      .sort()
    requireAuthoringCapacity(budget, keys.length)
    const encoded: Record<string, WorkflowOutputBinding> = {}
    for (const key of keys) {
      if (key === "__proto__") {
        throw new AtetCodeError(
          "invalid-data",
          "Workflow outputs cannot contain the reserved __proto__ object key.",
        )
      }
      const descriptor = descriptors[key]
      if (
        descriptor === undefined
        || descriptor.get !== undefined
        || descriptor.set !== undefined
      ) {
        throw new AtetCodeError(
          "invalid-data",
          "Workflow output properties must be plain data properties.",
        )
      }
      encoded[key] = encodeOutputValue(
        descriptor.value,
        state,
        ancestors,
        depth + 1,
        budget,
      )
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
  if (path.length > MAX_SERIALIZED_REF_PATH_SEGMENTS) {
    throw new AtetCodeError(
      "invalid-data",
      `Workflow reference paths cannot exceed ${String(MAX_SERIALIZED_REF_PATH_SEGMENTS)} segments.`,
    )
  }
  const serialized = deepFreezeJson({
    $ref: {
      nodeKey,
      ...(path.length === 0 ? {} : { path: [...path] }),
      schemaId,
    },
    version: WORKFLOW_REF_VERSION,
  } satisfies SerializedRefV1)
  const reference = Object.freeze({
    [WORKFLOW_REF_BRAND]: (): Output => {
      throw new AtetCodeError(
        "internal",
        "A workflow reference type marker is not executable.",
      )
    },
    at: (index: number) => {
      if (!Number.isSafeInteger(index) || index < 0) {
        throw new AtetCodeError(
          "invalid-data",
          "Workflow reference array indexes must be nonnegative safe integers.",
        )
      }
      if (path.length >= MAX_SERIALIZED_REF_PATH_SEGMENTS) {
        throw new AtetCodeError(
          "invalid-data",
          `Workflow reference paths cannot exceed ${String(MAX_SERIALIZED_REF_PATH_SEGMENTS)} segments.`,
        )
      }
      return createReference(nodeKey, schemaId, state, [...path, index]) as (
        Output extends readonly (infer Item)[] ? Ref<Item> : never
      )
    },
    select: <Key extends Extract<keyof Output, string>>(key: Key): Ref<Output[Key]> => {
      if (typeof key !== "string" || key.length < 1 || key.length > 128) {
        throw new AtetCodeError(
          "invalid-data",
          "Workflow reference field names must contain 1–128 characters.",
        )
      }
      if (path.length >= MAX_SERIALIZED_REF_PATH_SEGMENTS) {
        throw new AtetCodeError(
          "invalid-data",
          `Workflow reference paths cannot exceed ${String(MAX_SERIALIZED_REF_PATH_SEGMENTS)} segments.`,
        )
      }
      return createReference<Output[Key]>(nodeKey, schemaId, state, [...path, key])
    },
    serialized,
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
      throw new AtetCodeError(
        "conflict",
        `Duplicate operation discovery entry: ${key}`,
        { kind: item.kind, version: item.version },
      )
    }
    discovery.set(key, item)
  }
  return {
    // Root graph, nodes array, version, workflow object, and its three fields.
    // The output subtree is charged temporarily by build().
    authoredValues: 7,
    computes: new Map(),
    discovery,
    nodes: new Map(),
    references: new WeakSet(),
  }
}

export function defineWorkflowFragment<Input, Output>(
  build: (builder: WorkflowGraphBuilder, input: Input) => Output,
): WorkflowFragment<Input, Output> {
  if (typeof build !== "function") {
    throw new AtetCodeError(
      "invalid-data",
      "Workflow fragments require a build function.",
    )
  }
  return Object.freeze({ build })
}

export function operationContract<Input, Output>(
  provider: OperationDiscoveryProvider,
  kind: OperationKind,
  version: number,
): OperationContract<Input, Output> {
  const discovery = createState(provider).discovery.get(discoveryKey(kind, version))
  if (discovery === undefined) {
    throw new AtetCodeError(
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
      throw new AtetCodeError(
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
      throw new AtetCodeError(
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
      throw new AtetCodeError(
        "conflict",
        `Duplicate trusted compute key: ${compute.key}`,
        { key: compute.key },
      )
    }
    const key = this.#nodeKey(keyInput)
    const encoded = encodeOperationInput(input, this.#state)
    const controlDependencies = encodeControlDependencies(options.after, this.#state)
    const dependencies = combineDependencies(
      encoded.dependencies,
      controlDependencies,
    )
    const nodeValues = encoded.values
      + 15
      + controlDependencies.length
      + dependencies.length
      + (options.label === undefined ? 0 : 1)
    requireStateCapacity(this.#state, nodeValues)
    const node = parseCodeBoundary(AuthoredGraphNodeV1Schema, {
      controlDependencies,
      dependencies,
      executor: { compute, kind: "compute" },
      input: encoded.value,
      inputSchemaId: definition.inputSchemaId,
      key,
      ...(options.label === undefined ? {} : { label: options.label }),
      outputSchemaId: definition.outputSchemaId,
    }, "authored compute node")
    this.#state.computes.set(compute.key, definition)
    this.#state.nodes.set(key, node)
    this.#state.authoredValues += nodeValues
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
    const outputBudget = encodingBudget(this.#state)
    const encodedOutputs = encodeOutputValue(
      outputs,
      this.#state,
      new Set(),
      0,
      outputBudget,
    )
    return deepFreezeJson(parseCodeBoundary(AuthoredWorkflowGraphV1Schema, {
      nodes: [...this.#state.nodes.values()]
        .sort((left, right) => left.key.localeCompare(right.key)),
      outputs: encodedOutputs,
      version: WORKFLOW_GRAPH_VERSION,
      workflow,
    }, "authored workflow graph"))
  }

  #nodeKey(keyInput: string): string {
    const keySegment = parseCodeBoundary(
      NodeKeySegmentSchema,
      keyInput,
      "workflow node key segment",
    )
    const key = [...this.#namespace, keySegment].join("/")
    if (this.#state.nodes.has(key)) {
      throw new AtetCodeError(
        "conflict",
        `Duplicate workflow node key: ${key}`,
        { nodeKey: key },
      )
    }
    if (this.#state.nodes.size >= MAX_SERIALIZED_GRAPH_NODES) {
      throw new AtetCodeError(
        "invalid-data",
        `Workflow nodes cannot exceed ${String(MAX_SERIALIZED_GRAPH_NODES)} entries.`,
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
      throw new AtetCodeError(
        "unsupported-plan",
        `Unsupported operation: ${request.kind}@${String(request.version)}`,
        { kind: request.kind, version: request.version },
      )
    }
    if (
      request.inputSchemaId !== discovery.inputSchemaId
      || request.outputSchemaId !== discovery.outputSchemaId
    ) {
      throw new AtetCodeError(
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
    const dependencies = combineDependencies(
      encoded.dependencies,
      controlDependencies,
    )
    const nodeValues = encoded.values
      + 11
      + controlDependencies.length
      + dependencies.length
      + (options.label === undefined ? 0 : 1)
    requireStateCapacity(this.#state, nodeValues)
    const node = parseCodeBoundary(AuthoredGraphNodeV1Schema, {
      controlDependencies,
      dependencies,
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
    this.#state.authoredValues += nodeValues
    return createReference<Output>(key, discovery.outputSchemaId, this.#state)
  }
}
