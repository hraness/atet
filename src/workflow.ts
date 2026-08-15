import {
  executeAtetOperationWithLease,
  isAtetOperationCode,
  isTransmuteOperationCode,
  parseAtetOperationInput,
  atetOperationHostResourceClaims,
  type AtetOperationCode,
  type AtetOperationDependencies,
  type AtetOperationInputMap,
  type AtetOperationResultMap,
  type TransmuteOperationCode,
  type TransmuteOperationInputMap,
  type TransmuteOperationResultMap,
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

export type AtetWorkflowErrorCode =
  | "INVALID_WORKFLOW"
  | "INVALID_WORKFLOW_INPUT"
  | "INVALID_WORKFLOW_STEP"
  | "WORKFLOW_ABORTED"
  | "WORKFLOW_FAILED"
  | "WORKFLOW_STEP_FAILED"

export interface AtetWorkflowStepReceipt {
  readonly index: number
  readonly id: string
  readonly operation: AtetOperationCode
}

export class AtetWorkflowError extends Error {
  readonly code: AtetWorkflowErrorCode
  readonly completedSteps: readonly AtetWorkflowStepReceipt[]
  readonly failedStep?: Readonly<{
    id: string
    operation: AtetOperationCode
  }>

  constructor(
    code: AtetWorkflowErrorCode,
    message: string,
    options: {
      readonly cause?: unknown
      readonly completedSteps?: readonly AtetWorkflowStepReceipt[]
      readonly failedStep?: Readonly<{
        id: string
        operation: AtetOperationCode
      }>
    } = {},
  ) {
    super(`[${code}] ${message}`, { cause: options.cause })
    this.name = "AtetWorkflowError"
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

export interface AtetWorkflowExecutorContext {
  readonly hostResourceLease: HostResourceLease
  readonly signal: AbortSignal
  readonly stepId: string
}

export type AtetWorkflowExecutor = <C extends AtetOperationCode>(
  code: C,
  input: AtetOperationInputMap[C],
  context: AtetWorkflowExecutorContext,
) => Promise<AtetOperationResultMap[C]>

export interface AtetWorkflowContext {
  readonly signal: AbortSignal
  operation<C extends AtetOperationCode>(
    id: string,
    code: C,
    input: AtetOperationInputMap[C],
  ): Promise<AtetOperationResultMap[C]>
}

export interface AtetWorkflowDefinition<Input, Output> {
  readonly id: string
  readonly version: number
  readonly parseInput: (value: unknown) => Input
  readonly run: (
    context: AtetWorkflowContext,
    input: Input,
  ) => Output | Promise<Output>
}

export interface DefineAtetWorkflowOptions<Input, Output>
  extends AtetWorkflowDefinition<Input, Output> {}

export interface RunAtetWorkflowOptions {
  /**
   * Operation dependencies may also carry admission controls. Explicit
   * workflow-level controls take precedence when both are present.
   */
  readonly dependencies?: AtetOperationDependencies
  readonly executor?: AtetWorkflowExecutor
  readonly hostResourceCoordinator?: HostResourceCoordinator
  readonly maximumSteps?: number
  readonly signal?: AbortSignal
  readonly waitTimeoutMilliseconds?: number
}

export interface AtetWorkflowRun<Output> {
  readonly workflow: Readonly<{
    id: string
    version: number
  }>
  readonly output: Output
  readonly steps: readonly AtetWorkflowStepReceipt[]
}

function workflowError(
  code: AtetWorkflowErrorCode,
  message: string,
): never {
  throw new AtetWorkflowError(code, message)
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
  completedSteps: readonly AtetWorkflowStepReceipt[] = [],
): asserts id is string {
  if (
    typeof id !== "string" ||
    id.length < 1 ||
    id.length > 80 ||
    !workflowStepIdPattern.test(id)
  ) {
    throw new AtetWorkflowError(
      "INVALID_WORKFLOW_STEP",
      "Step id must be 1 through 80 letters, numbers, dots, underscores, colons, or hyphens.",
      { completedSteps },
    )
  }
}

export function defineAtetWorkflow<Input, Output>(
  options: DefineAtetWorkflowOptions<Input, Output>,
): AtetWorkflowDefinition<Input, Output> {
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
  completedSteps: readonly AtetWorkflowStepReceipt[],
  cause?: unknown,
): AtetWorkflowError {
  return new AtetWorkflowError(
    "WORKFLOW_ABORTED",
    "Workflow execution was aborted.",
    { cause, completedSteps },
  )
}

export async function runAtetWorkflow<Input, Output>(
  definition: AtetWorkflowDefinition<Input, Output>,
  value: unknown,
  options: RunAtetWorkflowOptions = {},
): Promise<AtetWorkflowRun<Awaited<Output>>> {
  const normalized = defineAtetWorkflow(definition)
  const limit = maximumSteps(options.maximumSteps)
  const signal = options.signal
    ?? options.dependencies?.signal
    ?? new AbortController().signal
  const invoked = new Set<string>()
  const completed: AtetWorkflowStepReceipt[] = []
  const dispatched: Promise<unknown>[] = []
  let acceptingOperations = true
  let nextIndex = 0

  if (signal.aborted) throw aborted(completed)

  let input: Input
  try {
    input = normalized.parseInput(value)
  } catch (cause) {
    throw new AtetWorkflowError(
      "INVALID_WORKFLOW_INPUT",
      "Workflow input did not satisfy its parser.",
      { cause },
    )
  }

  const executor: AtetWorkflowExecutor = options.executor
    ?? (<C extends AtetOperationCode>(
      code: C,
      operationInput: AtetOperationInputMap[C],
      context: AtetWorkflowExecutorContext,
    ) => executeAtetOperationWithLease(
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

  async function dispatchOperation<C extends AtetOperationCode>(
    id: string,
    code: C,
    operationInput: AtetOperationInputMap[C],
  ): Promise<AtetOperationResultMap[C]> {
    if (signal.aborted) throw aborted(completed)
    validateStepId(id, completed)
    if (!isAtetOperationCode(code)) {
      throw new AtetWorkflowError(
        "INVALID_WORKFLOW_STEP",
        `Workflow step ${id} names an unknown Atet operation.`,
        { completedSteps: completed },
      )
    }
    if (invoked.has(id)) {
      throw new AtetWorkflowError(
        "INVALID_WORKFLOW_STEP",
        `Duplicate workflow step id: ${id}.`,
        { completedSteps: completed },
      )
    }
    if (nextIndex >= limit) {
      throw new AtetWorkflowError(
        "INVALID_WORKFLOW_STEP",
        `Workflow exceeds its ${String(limit)}-step limit.`,
        { completedSteps: completed },
      )
    }
    const index = nextIndex
    nextIndex += 1
    invoked.add(id)
    let normalizedInput: AtetOperationInputMap[C]
    try {
      normalizedInput = parseAtetOperationInput(code, operationInput)
    } catch (cause) {
      throw new AtetWorkflowError(
        "INVALID_WORKFLOW_STEP",
        `Workflow step ${id} has invalid input for ${code}.`,
        { cause, completedSteps: completed },
      )
    }
    try {
      const result = await hostResourceCoordinator.withLease(
        atetOperationHostResourceClaims(code),
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
        cause instanceof AtetWorkflowError &&
        cause.code === "WORKFLOW_ABORTED"
      ) {
        throw cause
      }
      if (signal.aborted) throw aborted(completed, cause)
      throw new AtetWorkflowError(
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

  const context: AtetWorkflowContext = Object.freeze({
    signal,
    operation<C extends AtetOperationCode>(
      id: string,
      code: C,
      operationInput: AtetOperationInputMap[C],
    ): Promise<AtetOperationResultMap[C]> {
      if (!acceptingOperations) {
        const closed = Promise.reject<AtetOperationResultMap[C]>(
          new AtetWorkflowError(
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
    if (runFailure instanceof AtetWorkflowError) throw runFailure
    throw new AtetWorkflowError(
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
    if (cause instanceof AtetWorkflowError) throw cause
    throw new AtetWorkflowError(
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

/** @deprecated Use Atet names for newly authored integrations. */
export type TransmuteWorkflowErrorCode = AtetWorkflowErrorCode
/** @deprecated New receipts use canonical Atet operation identifiers. */
export type TransmuteWorkflowStepReceipt = AtetWorkflowStepReceipt
/** @deprecated Use {@link AtetWorkflowError}. */
export { AtetWorkflowError as TransmuteWorkflowError }
/** @deprecated Use {@link AtetWorkflowExecutorContext}. */
export type TransmuteWorkflowExecutorContext = AtetWorkflowExecutorContext
/** @deprecated Accepts v1 operation identifiers and adapts them to Atet. */
export type TransmuteWorkflowExecutor = <C extends TransmuteOperationCode>(
  code: C,
  input: TransmuteOperationInputMap[C],
  context: TransmuteWorkflowExecutorContext,
) => Promise<TransmuteOperationResultMap[C]>
/** @deprecated Accepts v1 operation identifiers and adapts them to Atet. */
export interface TransmuteWorkflowContext {
  readonly signal: AbortSignal
  operation<C extends TransmuteOperationCode>(
    id: string,
    code: C,
    input: TransmuteOperationInputMap[C],
  ): Promise<TransmuteOperationResultMap[C]>
}
/** @deprecated Use {@link AtetWorkflowDefinition} for newly authored workflows. */
export interface TransmuteWorkflowDefinition<Input, Output> {
  readonly id: string
  readonly version: number
  readonly parseInput: (value: unknown) => Input
  readonly run: (
    context: TransmuteWorkflowContext,
    input: Input,
  ) => Output | Promise<Output>
}
/** @deprecated Use {@link DefineAtetWorkflowOptions}. */
export interface DefineTransmuteWorkflowOptions<Input, Output>
  extends TransmuteWorkflowDefinition<Input, Output> {}
/** @deprecated Use {@link RunAtetWorkflowOptions}. */
export interface RunTransmuteWorkflowOptions {
  readonly dependencies?: AtetOperationDependencies
  readonly executor?: TransmuteWorkflowExecutor
  readonly hostResourceCoordinator?: HostResourceCoordinator
  readonly maximumSteps?: number
  readonly signal?: AbortSignal
  readonly waitTimeoutMilliseconds?: number
}
/** @deprecated New runs return canonical Atet receipts. */
export type TransmuteWorkflowRun<Output> = AtetWorkflowRun<Output>

function atetCodeFromTransmute(code: TransmuteOperationCode): AtetOperationCode {
  if (!isTransmuteOperationCode(code)) {
    throw new AtetWorkflowError(
      "INVALID_WORKFLOW_STEP",
      "Deprecated Transmute workflows accept only exact v1 operation identifiers.",
    )
  }
  return code.replace(/^transmute\./u, "atet.") as AtetOperationCode
}

function transmuteCodeFromAtet(code: AtetOperationCode): TransmuteOperationCode {
  return code.replace(/^atet\./u, "transmute.") as TransmuteOperationCode
}

/** @deprecated Use {@link defineAtetWorkflow}. */
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

/**
 * @deprecated Use {@link runAtetWorkflow}. Exact v1 operation inputs are
 * adapted before dispatch; receipts and errors use canonical Atet identifiers.
 */
export async function runTransmuteWorkflow<Input, Output>(
  definition: TransmuteWorkflowDefinition<Input, Output>,
  value: unknown,
  options: RunTransmuteWorkflowOptions = {},
): Promise<TransmuteWorkflowRun<Awaited<Output>>> {
  const legacy = defineTransmuteWorkflow(definition)
  const canonical = defineAtetWorkflow({
    id: legacy.id,
    version: legacy.version,
    parseInput: legacy.parseInput,
    run(context, input) {
      const legacyContext: TransmuteWorkflowContext = Object.freeze({
        signal: context.signal,
        operation<C extends TransmuteOperationCode>(
          id: string,
          code: C,
          operationInput: TransmuteOperationInputMap[C],
        ): Promise<TransmuteOperationResultMap[C]> {
          return context.operation(
            id,
            atetCodeFromTransmute(code),
            operationInput,
          ) as Promise<TransmuteOperationResultMap[C]>
        },
      })
      return legacy.run(legacyContext, input)
    },
  })
  const legacyExecutor = options.executor
  const executor: AtetWorkflowExecutor | undefined = legacyExecutor === undefined
    ? undefined
    : (async (code, operationInput, context) => await legacyExecutor(
        transmuteCodeFromAtet(code),
        operationInput,
        context,
      )) as AtetWorkflowExecutor
  return await runAtetWorkflow(canonical, value, {
    ...(options.dependencies === undefined ? {} : { dependencies: options.dependencies }),
    ...(executor === undefined ? {} : { executor }),
    ...(options.hostResourceCoordinator === undefined
      ? {}
      : { hostResourceCoordinator: options.hostResourceCoordinator }),
    ...(options.maximumSteps === undefined ? {} : { maximumSteps: options.maximumSteps }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.waitTimeoutMilliseconds === undefined
      ? {}
      : { waitTimeoutMilliseconds: options.waitTimeoutMilliseconds }),
  })
}
