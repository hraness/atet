import type { z } from "zod"

import {
  JsonValueSchema,
  isComputeGraphNode,
  isOperationGraphNode,
  type AuthoredGraphNodeV1,
  type CompiledWorkflowGraph,
  type GraphCompilerLimits,
  type GraphInputValue,
  type JsonValue,
  type OperationPolicy,
  type Ref,
  type SerializedRefV1,
  type WorkflowOutputBinding,
  type WorkflowOutputValue,
} from "./contracts.js"
import {
  compileWorkflowGraph,
} from "./compiler.js"
import { canonicalJson, sha256Hex } from "./canonical-json.js"
import { parseCodeBoundary } from "./boundary.js"
import {
  buildWorkflow,
  type BuiltWorkflow,
  type WorkflowDefinition,
} from "./define-workflow.js"
import {
  TransmuteCodeError,
  transmuteCodeErrorMessage,
  type TransmuteCodeErrorCode,
} from "./errors.js"
import {
  PORTABLE_TRANSMUTE_OPERATION_CONTRACTS,
  isPortableTransmuteOperationKind,
  type PortableTransmuteOperationInputMap,
  type PortableTransmuteOperationKind,
  type PortableTransmuteOperationResultMap,
} from "./public-operations.js"
import { PUBLIC_WORKFLOW_REGISTRY_PROJECTION } from "./projection.js"

export const WORKFLOW_NODE_RECEIPT_VERSION =
  "transmute-workflow-node-receipt-v1" as const
export const WORKFLOW_NODE_RECEIPT_HASH_DOMAIN =
  "transmute.workflow.node-receipt/v1" as const

export interface TransmuteCodeExecutionRequest<
  Kind extends PortableTransmuteOperationKind = PortableTransmuteOperationKind,
> {
  readonly input: PortableTransmuteOperationInputMap[Kind]
  readonly kind: Kind
  readonly nodeKey: string
  readonly version: 2
}

export interface TransmuteCodeExecutionContext {
  readonly signal: AbortSignal
}

export type TransmuteCodeExecutor = <Kind extends PortableTransmuteOperationKind>(
  request: TransmuteCodeExecutionRequest<Kind>,
  context: TransmuteCodeExecutionContext,
) => Promise<PortableTransmuteOperationResultMap[Kind]>

export interface TransmuteCodeAdmissionRequest {
  readonly kind: PortableTransmuteOperationKind
  readonly nodeKey: string
  readonly policy: OperationPolicy
  readonly version: 2
}

export type TransmuteCodeAdmission = <Result>(
  request: TransmuteCodeAdmissionRequest,
  execute: () => Promise<Result>,
  context: TransmuteCodeExecutionContext,
) => Promise<Result>

export interface TransmuteCodeHost {
  readonly admit?: TransmuteCodeAdmission
  readonly execute: TransmuteCodeExecutor
}

export interface CreateTransmuteCodeHostOptions {
  readonly admit?: TransmuteCodeAdmission
  readonly execute: TransmuteCodeExecutor
}

export function createTransmuteCodeHost(
  options: CreateTransmuteCodeHostOptions,
): TransmuteCodeHost {
  if (typeof options !== "object" || options === null) {
    throw new TransmuteCodeError(
      "invalid-data",
      "A Transmute Code host must be an object.",
    )
  }
  if (typeof options.execute !== "function") {
    throw new TransmuteCodeError(
      "invalid-data",
      "A Transmute Code host requires an execute function.",
    )
  }
  if (options.admit !== undefined && typeof options.admit !== "function") {
    throw new TransmuteCodeError(
      "invalid-data",
      "A Transmute Code host admit value must be a function when provided.",
    )
  }
  return Object.freeze({
    ...(options.admit === undefined ? {} : { admit: options.admit }),
    execute: options.execute,
  })
}

export interface WorkflowNodeReceipt {
  readonly index: number
  readonly inputSha256: string
  readonly kind: PortableTransmuteOperationKind
  readonly nodeKey: string
  readonly outputSha256: string
  readonly receiptSha256: string
  readonly version: typeof WORKFLOW_NODE_RECEIPT_VERSION
  readonly operationVersion: 2
}

export interface FailedWorkflowNode {
  readonly kind: PortableTransmuteOperationKind
  readonly nodeKey: string
  readonly version: 2
}

export class TransmuteWorkflowRunError extends TransmuteCodeError {
  readonly completedReceipts: readonly WorkflowNodeReceipt[]
  readonly failedNode: FailedWorkflowNode | undefined
  readonly runCause: unknown

  constructor(
    code: TransmuteCodeErrorCode,
    message: string,
    options: {
      readonly cause: unknown
      readonly completedReceipts: readonly WorkflowNodeReceipt[]
      readonly failedNode?: FailedWorkflowNode
    },
  ) {
    const failedNode = options.failedNode === undefined
      ? undefined
      : Object.freeze({ ...options.failedNode })
    const completedReceipts = Object.freeze([...options.completedReceipts])
    super(code, message, {
      completedReceiptCount: completedReceipts.length,
      ...(failedNode === undefined ? {} : { failedNode }),
    })
    this.name = "TransmuteWorkflowRunError"
    this.completedReceipts = completedReceipts
    this.failedNode = failedNode
    this.runCause = options.cause
  }
}

export type ResolvedWorkflowOutput<Value> =
  Value extends Ref<infer Output>
    ? Output
    : Value extends readonly (infer Item)[]
      ? readonly ResolvedWorkflowOutput<Item>[]
      : Value extends Readonly<Record<string, unknown>>
        ? { readonly [Key in keyof Value]: ResolvedWorkflowOutput<Value[Key]> }
        : never

export interface WorkflowRunResult<Output = JsonValue> {
  readonly compilation: CompiledWorkflowGraph
  readonly output: Output
  readonly receipts: readonly WorkflowNodeReceipt[]
}

export interface RunBuiltWorkflowOptions {
  readonly host: TransmuteCodeHost
  readonly limits?: Partial<GraphCompilerLimits>
  readonly signal?: AbortSignal
}

function isSerializedRef(value: unknown): value is SerializedRefV1 {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.hasOwn(value, "$ref")
}

function projectedValue(
  reference: SerializedRefV1,
  values: ReadonlyMap<string, JsonValue>,
): JsonValue {
  let current = values.get(reference.$ref.nodeKey)
  if (current === undefined) {
    throw new TransmuteCodeError(
      "internal",
      `Workflow reference producer ${reference.$ref.nodeKey} has not completed.`,
      { nodeKey: reference.$ref.nodeKey },
    )
  }
  for (const segment of reference.$ref.path ?? []) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) {
        throw new TransmuteCodeError(
          "invalid-data",
          `Workflow reference ${reference.$ref.nodeKey} has an invalid array projection.`,
          { nodeKey: reference.$ref.nodeKey, segment },
        )
      }
      const currentArray = current as readonly JsonValue[]
      current = currentArray[segment]
    } else {
      if (
        typeof current !== "object"
        || current === null
        || Array.isArray(current)
        || !Object.hasOwn(current, segment)
      ) {
        throw new TransmuteCodeError(
          "invalid-data",
          `Workflow reference ${reference.$ref.nodeKey} has an invalid object projection.`,
          { nodeKey: reference.$ref.nodeKey, segment },
        )
      }
      current = (current as Readonly<Record<string, JsonValue>>)[segment]
    }
    if (current === undefined) {
      throw new TransmuteCodeError(
        "invalid-data",
        `Workflow reference ${reference.$ref.nodeKey} projected an undefined value.`,
        { nodeKey: reference.$ref.nodeKey, segment },
      )
    }
  }
  return current
}

function resolveValue(
  value: GraphInputValue | WorkflowOutputBinding,
  values: ReadonlyMap<string, JsonValue>,
): JsonValue {
  if (isSerializedRef(value)) return projectedValue(value, values)
  if (Array.isArray(value)) {
    const items = value as readonly (GraphInputValue | WorkflowOutputBinding)[]
    return items.map(item => resolveValue(item, values))
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Readonly<Record<string, GraphInputValue | WorkflowOutputBinding>>
    const output: Record<string, JsonValue> = {}
    for (const key of Object.keys(record).sort()) {
      const item = record[key]
      if (item === undefined) {
        throw new TransmuteCodeError(
          "internal",
          `Compiled workflow value ${key} is undefined.`,
        )
      }
      output[key] = resolveValue(item, values)
    }
    return output
  }
  return value
}

function boundedJson(
  value: unknown,
  maximumBytes: number,
  name: string,
): JsonValue {
  const parsed = parseCodeBoundary(JsonValueSchema, value, name)
  const bytes = new TextEncoder().encode(canonicalJson(parsed)).byteLength
  if (bytes > maximumBytes) {
    throw new TransmuteCodeError(
      "invalid-data",
      `${name} contains ${String(bytes)} bytes; the limit is ${String(maximumBytes)}.`,
      { actualBytes: bytes, maximumBytes },
    )
  }
  return parsed
}

function createNodeReceipt(
  index: number,
  nodeKey: string,
  kind: PortableTransmuteOperationKind,
  input: JsonValue,
  output: JsonValue,
): WorkflowNodeReceipt {
  const unsigned = {
    index,
    inputSha256: sha256Hex(canonicalJson(input)),
    kind,
    nodeKey,
    operationVersion: 2 as const,
    outputSha256: sha256Hex(canonicalJson(output)),
    version: WORKFLOW_NODE_RECEIPT_VERSION,
  }
  return Object.freeze({
    ...unsigned,
    receiptSha256: sha256Hex(
      `${WORKFLOW_NODE_RECEIPT_HASH_DOMAIN}\0${canonicalJson(unsigned)}`,
    ),
  })
}

function publicOperationNode(
  node: AuthoredGraphNodeV1,
): asserts node is AuthoredGraphNodeV1 & {
  readonly executor: {
    readonly kind: "operation"
    readonly operation: {
      readonly kind: PortableTransmuteOperationKind
      readonly version: 2
    }
  }
} {
  if (isComputeGraphNode(node)) {
    throw new TransmuteCodeError(
      "unsupported-plan",
      `The public projection does not support trusted compute at node ${node.key}.`,
      {
        executorKind: "compute",
        nodeKey: node.key,
        projectionId: PUBLIC_WORKFLOW_REGISTRY_PROJECTION.id,
      },
    )
  }
  if (!isOperationGraphNode(node)) {
    throw new TransmuteCodeError(
      "unsupported-plan",
      `The public projection does not support the executor at node ${node.key}.`,
      { nodeKey: node.key, projectionId: PUBLIC_WORKFLOW_REGISTRY_PROJECTION.id },
    )
  }
  const operation = node.executor.operation
  if (
    operation.version !== 2
    || !isPortableTransmuteOperationKind(operation.kind)
  ) {
    throw new TransmuteCodeError(
      "unsupported-plan",
      `Unsupported operation: ${operation.kind}@${String(operation.version)}`,
      {
        kind: operation.kind,
        nodeKey: node.key,
        projectionId: PUBLIC_WORKFLOW_REGISTRY_PROJECTION.id,
        version: operation.version,
      },
    )
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new TransmuteCodeError("cancelled", "Workflow execution was cancelled.")
  }
}

function workflowNodeFailure(
  error: unknown,
  node: AuthoredGraphNodeV1 & {
    readonly executor: {
      readonly kind: "operation"
      readonly operation: {
        readonly kind: PortableTransmuteOperationKind
        readonly version: 2
      }
    }
  },
  completedReceipts: readonly WorkflowNodeReceipt[],
): TransmuteWorkflowRunError {
  const code = error instanceof TransmuteCodeError ? error.code : "subprocess"
  return new TransmuteWorkflowRunError(
    code,
    `Workflow node ${node.key} (${node.executor.operation.kind}@2) failed: `
      + transmuteCodeErrorMessage(error),
    {
      cause: error,
      completedReceipts,
      failedNode: {
        kind: node.executor.operation.kind,
        nodeKey: node.key,
        version: 2,
      },
    },
  )
}

function workflowRunFailure(
  error: unknown,
  message: string,
  completedReceipts: readonly WorkflowNodeReceipt[],
): TransmuteWorkflowRunError {
  const code = error instanceof TransmuteCodeError ? error.code : "internal"
  return new TransmuteWorkflowRunError(code, message, {
    cause: error,
    completedReceipts,
  })
}

async function executePublicNode(
  host: TransmuteCodeHost,
  node: AuthoredGraphNodeV1 & {
    readonly executor: {
      readonly kind: "operation"
      readonly operation: {
        readonly kind: PortableTransmuteOperationKind
        readonly version: 2
      }
    }
  },
  values: ReadonlyMap<string, JsonValue>,
  context: TransmuteCodeExecutionContext,
): Promise<{ readonly input: JsonValue; readonly output: JsonValue }> {
  const { kind } = node.executor.operation
  const contract = PORTABLE_TRANSMUTE_OPERATION_CONTRACTS[kind]
  const resolvedInput = resolveValue(node.input, values)
  const parsedInput = parseCodeBoundary(
    contract.inputSchema as z.ZodType<unknown>,
    resolvedInput,
    `${kind} input at node ${node.key}`,
  ) as PortableTransmuteOperationInputMap[typeof kind]
  const boundedInput = boundedJson(
    parsedInput,
    contract.policy.maxInputBytes,
    `${kind} input at node ${node.key}`,
  )
  const request: TransmuteCodeExecutionRequest<typeof kind> = {
    input: parsedInput,
    kind,
    nodeKey: node.key,
    version: 2,
  }
  throwIfAborted(context.signal)
  const dispatch = async () => await host.execute(request, context)
  const rawOutput = host.admit === undefined
    ? await dispatch()
    : await host.admit({
        kind,
        nodeKey: node.key,
        policy: contract.policy,
        version: 2,
      }, dispatch, context)
  const parsedOutput = parseCodeBoundary(
    contract.outputSchema as z.ZodType<unknown>,
    rawOutput,
    `${kind} output at node ${node.key}`,
  )
  return {
    input: boundedInput,
    output: boundedJson(
      parsedOutput,
      contract.policy.maxOutputBytes,
      `${kind} output at node ${node.key}`,
    ),
  }
}

export async function runBuiltWorkflow<
  Input extends JsonValue,
  Output extends WorkflowOutputValue,
>(
  built: BuiltWorkflow<Input, Output>,
  options: RunBuiltWorkflowOptions,
): Promise<WorkflowRunResult<ResolvedWorkflowOutput<Output>>> {
  // Compilation and the public capability check intentionally precede every
  // host callback, including host-owned admission.
  const compilation = compileWorkflowGraph({
    graph: built.graph,
    limits: options.limits,
    projection: PUBLIC_WORKFLOW_REGISTRY_PROJECTION,
  })
  for (const node of compilation.graph.nodes) publicOperationNode(node)
  const host = createTransmuteCodeHost(options.host)
  const context = Object.freeze({
    signal: options.signal ?? new AbortController().signal,
  })
  throwIfAborted(context.signal)

  const nodes = new Map(compilation.graph.nodes.map(node => [node.key, node]))
  const values = new Map<string, JsonValue>()
  const receipts: WorkflowNodeReceipt[] = []
  for (const wave of compilation.topologicalWaves) {
    const outcomes = await Promise.all(wave.map(async (nodeKey) => {
      const node = nodes.get(nodeKey)
      if (node === undefined) {
        throw new TransmuteCodeError(
          "internal",
          `Compiled workflow topology lost node ${nodeKey}.`,
          { nodeKey },
        )
      }
      publicOperationNode(node)
      try {
        return {
          executed: await executePublicNode(host, node, values, context),
          kind: "executed",
          node,
        } as const
      } catch (error) {
        return { error, kind: "failed", node } as const
      }
    }))
    // Each callback converts rejection to data, so Promise.all drains the
    // complete dispatched wave before the runtime returns an error.
    for (const outcome of outcomes) {
      if (outcome.kind !== "executed") continue
      values.set(outcome.node.key, outcome.executed.output)
      receipts.push(createNodeReceipt(
        receipts.length,
        outcome.node.key,
        outcome.node.executor.operation.kind,
        outcome.executed.input,
        outcome.executed.output,
      ))
    }
    const failure = outcomes.find(
      (outcome): outcome is Extract<typeof outcome, { readonly kind: "failed" }> => (
        outcome.kind === "failed"
      ),
    )
    if (failure !== undefined) {
      throw workflowNodeFailure(failure.error, failure.node, receipts)
    }
    if (context.signal.aborted) {
      const cause = new TransmuteCodeError(
        "cancelled",
        "Workflow execution was cancelled.",
      )
      throw workflowRunFailure(
        cause,
        "Workflow execution was cancelled after the current wave settled.",
        receipts,
      )
    }
  }
  let output: ResolvedWorkflowOutput<Output>
  try {
    output = parseCodeBoundary(
      JsonValueSchema,
      resolveValue(compilation.graph.outputs, values),
      "workflow output",
    ) as ResolvedWorkflowOutput<Output>
  } catch (error) {
    throw workflowRunFailure(
      error,
      `Workflow output resolution failed: ${transmuteCodeErrorMessage(error)}`,
      receipts,
    )
  }
  return Object.freeze({
    compilation,
    output,
    receipts: Object.freeze(receipts),
  })
}

export async function runWorkflow<
  Input,
  Output extends WorkflowOutputValue,
>(
  definition: WorkflowDefinition<Input, Output>,
  input: unknown,
  options: RunBuiltWorkflowOptions,
): Promise<WorkflowRunResult<ResolvedWorkflowOutput<Output>>> {
  return await runBuiltWorkflow(buildWorkflow(definition, input), options)
}
