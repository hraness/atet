import {
  executeTransmuteOperation,
  isTransmuteOperationCode,
  parseTransmuteOperationInput,
  type TransmuteOperationCode,
  type TransmuteOperationDependencies,
  type TransmuteOperationInputMap,
  type TransmuteOperationResultMap,
} from "./operations.js"

const workflowIdPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u
const workflowStepIdPattern = /^[A-Za-z0-9]+(?:[._:-][A-Za-z0-9]+)*$/u
const defaultMaximumSteps = 64
const hardMaximumSteps = 256

export type TransmuteWorkflowErrorCode =
  | "INVALID_WORKFLOW"
  | "INVALID_WORKFLOW_INPUT"
  | "INVALID_WORKFLOW_STEP"
  | "WORKFLOW_ABORTED"
  | "WORKFLOW_FAILED"
  | "WORKFLOW_STEP_FAILED"

export interface TransmuteWorkflowStepReceipt {
  readonly index: number
  readonly id: string
  readonly operation: TransmuteOperationCode
}

export class TransmuteWorkflowError extends Error {
  readonly code: TransmuteWorkflowErrorCode
  readonly completedSteps: readonly TransmuteWorkflowStepReceipt[]
  readonly failedStep?: Readonly<{
    id: string
    operation: TransmuteOperationCode
  }>

  constructor(
    code: TransmuteWorkflowErrorCode,
    message: string,
    options: {
      readonly cause?: unknown
      readonly completedSteps?: readonly TransmuteWorkflowStepReceipt[]
      readonly failedStep?: Readonly<{
        id: string
        operation: TransmuteOperationCode
      }>
    } = {},
  ) {
    super(`[${code}] ${message}`, { cause: options.cause })
    this.name = "TransmuteWorkflowError"
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

export interface TransmuteWorkflowExecutorContext {
  readonly signal: AbortSignal
  readonly stepId: string
}

export type TransmuteWorkflowExecutor = <C extends TransmuteOperationCode>(
  code: C,
  input: TransmuteOperationInputMap[C],
  context: TransmuteWorkflowExecutorContext,
) => Promise<TransmuteOperationResultMap[C]>

export interface TransmuteWorkflowContext {
  readonly signal: AbortSignal
  operation<C extends TransmuteOperationCode>(
    id: string,
    code: C,
    input: TransmuteOperationInputMap[C],
  ): Promise<TransmuteOperationResultMap[C]>
}

export interface TransmuteWorkflowDefinition<Input, Output> {
  readonly id: string
  readonly version: number
  readonly parseInput: (value: unknown) => Input
  readonly run: (
    context: TransmuteWorkflowContext,
    input: Input,
  ) => Output | Promise<Output>
}

export interface DefineTransmuteWorkflowOptions<Input, Output>
  extends TransmuteWorkflowDefinition<Input, Output> {}

export interface RunTransmuteWorkflowOptions {
  readonly dependencies?: TransmuteOperationDependencies
  readonly executor?: TransmuteWorkflowExecutor
  readonly maximumSteps?: number
  readonly signal?: AbortSignal
}

export interface TransmuteWorkflowRun<Output> {
  readonly workflow: Readonly<{
    id: string
    version: number
  }>
  readonly output: Output
  readonly steps: readonly TransmuteWorkflowStepReceipt[]
}

function workflowError(
  code: TransmuteWorkflowErrorCode,
  message: string,
): never {
  throw new TransmuteWorkflowError(code, message)
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
  completedSteps: readonly TransmuteWorkflowStepReceipt[] = [],
): asserts id is string {
  if (
    typeof id !== "string" ||
    id.length < 1 ||
    id.length > 80 ||
    !workflowStepIdPattern.test(id)
  ) {
    throw new TransmuteWorkflowError(
      "INVALID_WORKFLOW_STEP",
      "Step id must be 1 through 80 letters, numbers, dots, underscores, colons, or hyphens.",
      { completedSteps },
    )
  }
}

export function defineTransmuteWorkflow<Input, Output>(
  options: DefineTransmuteWorkflowOptions<Input, Output>,
): TransmuteWorkflowDefinition<Input, Output> {
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
  completedSteps: readonly TransmuteWorkflowStepReceipt[],
  cause?: unknown,
): TransmuteWorkflowError {
  return new TransmuteWorkflowError(
    "WORKFLOW_ABORTED",
    "Workflow execution was aborted.",
    { cause, completedSteps },
  )
}

export async function runTransmuteWorkflow<Input, Output>(
  definition: TransmuteWorkflowDefinition<Input, Output>,
  value: unknown,
  options: RunTransmuteWorkflowOptions = {},
): Promise<TransmuteWorkflowRun<Awaited<Output>>> {
  const normalized = defineTransmuteWorkflow(definition)
  const limit = maximumSteps(options.maximumSteps)
  const signal = options.signal ?? new AbortController().signal
  const invoked = new Set<string>()
  const completed: TransmuteWorkflowStepReceipt[] = []
  const dispatched: Promise<unknown>[] = []
  let acceptingOperations = true
  let nextIndex = 0

  if (signal.aborted) throw aborted(completed)

  let input: Input
  try {
    input = normalized.parseInput(value)
  } catch (cause) {
    throw new TransmuteWorkflowError(
      "INVALID_WORKFLOW_INPUT",
      "Workflow input did not satisfy its parser.",
      { cause },
    )
  }

  const executor: TransmuteWorkflowExecutor = options.executor
    ?? (<C extends TransmuteOperationCode>(
      code: C,
      operationInput: TransmuteOperationInputMap[C],
    ) => executeTransmuteOperation(code, operationInput, options.dependencies))

  async function dispatchOperation<C extends TransmuteOperationCode>(
    id: string,
    code: C,
    operationInput: TransmuteOperationInputMap[C],
  ): Promise<TransmuteOperationResultMap[C]> {
    if (signal.aborted) throw aborted(completed)
    validateStepId(id, completed)
    if (!isTransmuteOperationCode(code)) {
      throw new TransmuteWorkflowError(
        "INVALID_WORKFLOW_STEP",
        `Workflow step ${id} names an unknown Transmute operation.`,
        { completedSteps: completed },
      )
    }
    if (invoked.has(id)) {
      throw new TransmuteWorkflowError(
        "INVALID_WORKFLOW_STEP",
        `Duplicate workflow step id: ${id}.`,
        { completedSteps: completed },
      )
    }
    if (nextIndex >= limit) {
      throw new TransmuteWorkflowError(
        "INVALID_WORKFLOW_STEP",
        `Workflow exceeds its ${String(limit)}-step limit.`,
        { completedSteps: completed },
      )
    }
    const index = nextIndex
    nextIndex += 1
    invoked.add(id)
    let normalizedInput: TransmuteOperationInputMap[C]
    try {
      normalizedInput = parseTransmuteOperationInput(code, operationInput)
    } catch (cause) {
      throw new TransmuteWorkflowError(
        "INVALID_WORKFLOW_STEP",
        `Workflow step ${id} has invalid input for ${code}.`,
        { cause, completedSteps: completed },
      )
    }
    try {
      const result = await executor(code, normalizedInput, {
        signal,
        stepId: id,
      })
      if (signal.aborted) throw aborted(completed)
      completed.push(Object.freeze({ id, index, operation: code }))
      return result
    } catch (cause) {
      if (signal.aborted) throw aborted(completed, cause)
      if (
        cause instanceof TransmuteWorkflowError &&
        cause.code === "WORKFLOW_ABORTED"
      ) {
        throw cause
      }
      throw new TransmuteWorkflowError(
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

  const context: TransmuteWorkflowContext = Object.freeze({
    signal,
    operation<C extends TransmuteOperationCode>(
      id: string,
      code: C,
      operationInput: TransmuteOperationInputMap[C],
    ): Promise<TransmuteOperationResultMap[C]> {
      if (!acceptingOperations) {
        const closed = Promise.reject<TransmuteOperationResultMap[C]>(
          new TransmuteWorkflowError(
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
    if (runFailure instanceof TransmuteWorkflowError) throw runFailure
    throw new TransmuteWorkflowError(
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
    if (cause instanceof TransmuteWorkflowError) throw cause
    throw new TransmuteWorkflowError(
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
