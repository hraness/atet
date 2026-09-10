import {
  executeSlopcameraOperationWithLease,
  isSlopcameraOperationCode,
  parseSlopcameraOperationInput,
  slopcameraOperationHostResourceClaims,
  type SlopcameraOperationCode,
  type SlopcameraOperationDependencies,
  type SlopcameraOperationInputMap,
  type SlopcameraOperationResultMap,
} from "./operations.js"
import {
  createDefaultHostResourceCoordinator,
  type HostResourceCoordinator,
  type HostResourceLease,
} from "./host-resources.js"

const workflowIdPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u
const workflowStepIdPattern = /^[A-Za-z0-9]+(?:[._:-][A-Za-z0-9]+)*$/u
const defaultMaximumSteps = 64
const hardMaximumSteps = 256

export type SlopcameraWorkflowErrorCode =
  | "INVALID_WORKFLOW"
  | "INVALID_WORKFLOW_INPUT"
  | "INVALID_WORKFLOW_STEP"
  | "WORKFLOW_ABORTED"
  | "WORKFLOW_FAILED"
  | "WORKFLOW_STEP_FAILED"

export interface SlopcameraWorkflowStepReceipt {
  readonly index: number
  readonly id: string
  readonly operation: SlopcameraOperationCode
}

export class SlopcameraWorkflowError extends Error {
  readonly code: SlopcameraWorkflowErrorCode
  readonly completedSteps: readonly SlopcameraWorkflowStepReceipt[]
  readonly failedStep?: Readonly<{
    id: string
    operation: SlopcameraOperationCode
  }>

  constructor(
    code: SlopcameraWorkflowErrorCode,
    message: string,
    options: {
      readonly cause?: unknown
      readonly completedSteps?: readonly SlopcameraWorkflowStepReceipt[]
      readonly failedStep?: Readonly<{
        id: string
        operation: SlopcameraOperationCode
      }>
    } = {},
  ) {
    super(`[${code}] ${message}`, { cause: options.cause })
    this.name = "SlopcameraWorkflowError"
    this.code = code
    this.completedSteps = Object.freeze(
      [...(options.completedSteps ?? [])].sort(
        (left, right) => left.index - right.index,
      ),
    )
    if (options.failedStep !== undefined) {
      this.failedStep = Object.freeze({ ...options.failedStep })
    }
  }
}

export interface SlopcameraWorkflowExecutorContext {
  readonly hostResourceLease: HostResourceLease
  readonly signal: AbortSignal
  readonly stepId: string
}

export type SlopcameraWorkflowExecutor = <C extends SlopcameraOperationCode>(
  code: C,
  input: SlopcameraOperationInputMap[C],
  context: SlopcameraWorkflowExecutorContext,
) => Promise<SlopcameraOperationResultMap[C]>

export interface SlopcameraWorkflowContext {
  readonly signal: AbortSignal
  operation<C extends SlopcameraOperationCode>(
    id: string,
    code: C,
    input: SlopcameraOperationInputMap[C],
  ): Promise<SlopcameraOperationResultMap[C]>
}

export interface SlopcameraWorkflowDefinition<Input, Output> {
  readonly id: string
  readonly version: number
  readonly parseInput: (value: unknown) => Input
  readonly run: (
    context: SlopcameraWorkflowContext,
    input: Input,
  ) => Output | Promise<Output>
}

export interface DefineSlopcameraWorkflowOptions<Input, Output>
  extends SlopcameraWorkflowDefinition<Input, Output> {}

export interface RunSlopcameraWorkflowOptions {
  /**
   * Operation dependencies may also carry admission controls. Explicit
   * workflow-level controls take precedence when both are present.
   */
  readonly dependencies?: SlopcameraOperationDependencies
  readonly executor?: SlopcameraWorkflowExecutor
  readonly hostResourceCoordinator?: HostResourceCoordinator
  readonly maximumSteps?: number
  readonly signal?: AbortSignal
  readonly waitTimeoutMilliseconds?: number
}

export interface SlopcameraWorkflowRun<Output> {
  readonly workflow: Readonly<{
    id: string
    version: number
  }>
  readonly output: Output
  readonly steps: readonly SlopcameraWorkflowStepReceipt[]
}

function workflowError(
  code: SlopcameraWorkflowErrorCode,
  message: string,
): never {
  throw new SlopcameraWorkflowError(code, message)
}

function validateWorkflowId(id: unknown): asserts id is string {
  if (
    typeof id !== "string" ||
    id.length < 1 ||
    id.length > 80 ||
    !workflowIdPattern.test(id)
  ) {
    workflowError(
      "INVALID_WORKFLOW",
      "Workflow id must be 1 through 80 lowercase letters, numbers, dots, underscores, or hyphens.",
    )
  }
}

function validateStepId(
  id: unknown,
  completedSteps: readonly SlopcameraWorkflowStepReceipt[] = [],
): asserts id is string {
  if (
    typeof id !== "string" ||
    id.length < 1 ||
    id.length > 80 ||
    !workflowStepIdPattern.test(id)
  ) {
    throw new SlopcameraWorkflowError(
      "INVALID_WORKFLOW_STEP",
      "Step id must be 1 through 80 letters, numbers, dots, underscores, colons, or hyphens.",
      { completedSteps },
    )
  }
}

export function defineSlopcameraWorkflow<Input, Output>(
  options: DefineSlopcameraWorkflowOptions<Input, Output>,
): SlopcameraWorkflowDefinition<Input, Output> {
  if (typeof options !== "object" || options === null) {
    workflowError("INVALID_WORKFLOW", "Workflow definition must be an object.")
  }
  validateWorkflowId(options.id)
  if (!Number.isSafeInteger(options.version) || options.version < 1) {
    workflowError(
      "INVALID_WORKFLOW",
      "Workflow version must be a positive safe integer.",
    )
  }
  if (typeof options.parseInput !== "function" || typeof options.run !== "function") {
    workflowError(
      "INVALID_WORKFLOW",
      "Workflow definition requires parseInput and run functions.",
    )
  }
  return Object.freeze({
    id: options.id,
    version: options.version,
    parseInput: options.parseInput,
    run: options.run,
  })
}

function maximumSteps(value: number | undefined): number {
  const resolved = value ?? defaultMaximumSteps
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > hardMaximumSteps
  ) {
    workflowError(
      "INVALID_WORKFLOW",
      `maximumSteps must be an integer from 1 through ${hardMaximumSteps}.`,
    )
  }
  return resolved
}

function aborted(
  completedSteps: readonly SlopcameraWorkflowStepReceipt[],
  cause?: unknown,
): SlopcameraWorkflowError {
  return new SlopcameraWorkflowError(
    "WORKFLOW_ABORTED",
    "Workflow execution was aborted.",
    { cause, completedSteps },
  )
}

export async function runSlopcameraWorkflow<Input, Output>(
  definition: SlopcameraWorkflowDefinition<Input, Output>,
  value: unknown,
  options: RunSlopcameraWorkflowOptions = {},
): Promise<SlopcameraWorkflowRun<Awaited<Output>>> {
  const normalized = defineSlopcameraWorkflow(definition)
  const limit = maximumSteps(options.maximumSteps)
  const signal = options.signal
    ?? options.dependencies?.signal
    ?? new AbortController().signal
  const invoked = new Set<string>()
  const completed: SlopcameraWorkflowStepReceipt[] = []
  const dispatched: Promise<unknown>[] = []
  let acceptingOperations = true
  let nextIndex = 0

  if (signal.aborted) throw aborted(completed)

  let input: Input
  try {
    input = normalized.parseInput(value)
  } catch (cause) {
    throw new SlopcameraWorkflowError(
      "INVALID_WORKFLOW_INPUT",
      "Workflow input did not satisfy its parser.",
      { cause },
    )
  }

  const executor: SlopcameraWorkflowExecutor = options.executor
    ?? (<C extends SlopcameraOperationCode>(
      code: C,
      operationInput: SlopcameraOperationInputMap[C],
      context: SlopcameraWorkflowExecutorContext,
    ) => executeSlopcameraOperationWithLease(
      code,
      operationInput,
      context.hostResourceLease,
      options.dependencies,
    ))
  const hostResourceCoordinator = options.hostResourceCoordinator
    ?? options.dependencies?.hostResourceCoordinator
    ?? createDefaultHostResourceCoordinator()
  const waitTimeoutMilliseconds = options.waitTimeoutMilliseconds
    ?? options.dependencies?.waitTimeoutMilliseconds

  async function dispatchOperation<C extends SlopcameraOperationCode>(
    id: string,
    code: C,
    operationInput: SlopcameraOperationInputMap[C],
  ): Promise<SlopcameraOperationResultMap[C]> {
    if (signal.aborted) throw aborted(completed)
    validateStepId(id, completed)
    if (!isSlopcameraOperationCode(code)) {
      throw new SlopcameraWorkflowError(
        "INVALID_WORKFLOW_STEP",
        `Workflow step ${id} names an unknown Slopcamera operation.`,
        { completedSteps: completed },
      )
    }
    if (invoked.has(id)) {
      throw new SlopcameraWorkflowError(
        "INVALID_WORKFLOW_STEP",
        `Duplicate workflow step id: ${id}.`,
        { completedSteps: completed },
      )
    }
    if (nextIndex >= limit) {
      throw new SlopcameraWorkflowError(
        "INVALID_WORKFLOW_STEP",
        `Workflow exceeds its ${String(limit)}-step limit.`,
        { completedSteps: completed },
      )
    }
    const index = nextIndex
    nextIndex += 1
    invoked.add(id)
    let normalizedInput: SlopcameraOperationInputMap[C]
    try {
      normalizedInput = parseSlopcameraOperationInput(code, operationInput)
    } catch (cause) {
      throw new SlopcameraWorkflowError(
        "INVALID_WORKFLOW_STEP",
        `Workflow step ${id} has invalid input for ${code}.`,
        { cause, completedSteps: completed },
      )
    }
    try {
      const result = await hostResourceCoordinator.withLease(
        slopcameraOperationHostResourceClaims(code),
        async (hostResourceLease) => await executor(code, normalizedInput, {
          hostResourceLease,
          signal,
          stepId: id,
        }),
        {
          signal,
          ...(waitTimeoutMilliseconds === undefined
            ? {}
            : { waitTimeoutMilliseconds }),
        },
      )
      completed.push(Object.freeze({ id, index, operation: code }))
      if (signal.aborted) throw aborted(completed)
      return result
    } catch (cause) {
      if (
        cause instanceof SlopcameraWorkflowError &&
        cause.code === "WORKFLOW_ABORTED"
      ) {
        throw cause
      }
      if (signal.aborted) throw aborted(completed, cause)
      throw new SlopcameraWorkflowError(
        "WORKFLOW_STEP_FAILED",
        `Workflow step ${id} (${code}) failed.`,
        {
          cause,
          completedSteps: completed,
          failedStep: { id, operation: code },
        },
      )
    }
  }

  const context: SlopcameraWorkflowContext = Object.freeze({
    signal,
    operation<C extends SlopcameraOperationCode>(
      id: string,
      code: C,
      operationInput: SlopcameraOperationInputMap[C],
    ): Promise<SlopcameraOperationResultMap[C]> {
      if (!acceptingOperations) {
        const closed = Promise.reject<SlopcameraOperationResultMap[C]>(
          new SlopcameraWorkflowError(
            "INVALID_WORKFLOW_STEP",
            "Workflow operations cannot start after authored workflow code has settled.",
            { completedSteps: completed },
          ),
        )
        void closed.catch(() => undefined)
        return closed
      }
      const operation = dispatchOperation(id, code, operationInput)
      dispatched.push(operation)
      // Attach a rejection observer immediately so a deliberately un-awaited
      // branch cannot become an unhandled rejection before the runner drains it.
      void operation.catch(() => undefined)
      return operation
    },
  })

  let output!: Awaited<Output>
  let runFailed = false
  let runFailure: unknown
  try {
    output = await normalized.run(context, input) as Awaited<Output>
  } catch (cause) {
    runFailed = true
    runFailure = cause
  } finally {
    acceptingOperations = false
  }

  const operationResults = await Promise.allSettled(dispatched)
  if (signal.aborted) throw aborted(completed, runFailed ? runFailure : undefined)
  if (runFailed) {
    if (runFailure instanceof SlopcameraWorkflowError) throw runFailure
    throw new SlopcameraWorkflowError(
      "WORKFLOW_FAILED",
      `Workflow ${normalized.id} failed in authored code.`,
      { cause: runFailure, completedSteps: completed },
    )
  }
  const operationFailure = operationResults.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  )
  if (operationFailure !== undefined) {
    const cause: unknown = operationFailure.reason
    if (cause instanceof SlopcameraWorkflowError) throw cause
    throw new SlopcameraWorkflowError(
      "WORKFLOW_STEP_FAILED",
      "A dispatched workflow operation failed.",
      { cause, completedSteps: completed },
    )
  }
  return Object.freeze({
    workflow: Object.freeze({ id: normalized.id, version: normalized.version }),
    output,
    steps: Object.freeze([...completed].sort((left, right) => left.index - right.index)),
  })
}
