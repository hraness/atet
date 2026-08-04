// @bun
import {
  executeTransmuteOperationWithLease,
  isTransmuteOperationCode,
  parseTransmuteOperationInput,
  transmuteOperationHostResourceClaims
} from "./index-wyraz81p.js";
import {
  createDefaultHostResourceCoordinator
} from "./index-dxtrd5pg.js";

// src/workflow.ts
var workflowIdPattern = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;
var workflowStepIdPattern = /^[A-Za-z0-9]+(?:[._:-][A-Za-z0-9]+)*$/u;
var defaultMaximumSteps = 64;
var hardMaximumSteps = 256;

class TransmuteWorkflowError extends Error {
  code;
  completedSteps;
  failedStep;
  constructor(code, message, options = {}) {
    super(`[${code}] ${message}`, { cause: options.cause });
    this.name = "TransmuteWorkflowError";
    this.code = code;
    this.completedSteps = Object.freeze([...options.completedSteps ?? []].sort((left, right) => left.index - right.index));
    if (options.failedStep !== undefined) {
      this.failedStep = Object.freeze({ ...options.failedStep });
    }
  }
}
function workflowError(code, message) {
  throw new TransmuteWorkflowError(code, message);
}
function validateWorkflowId(id) {
  if (typeof id !== "string" || id.length < 1 || id.length > 80 || !workflowIdPattern.test(id)) {
    workflowError("INVALID_WORKFLOW", "Workflow id must be 1 through 80 lowercase letters, numbers, dots, underscores, or hyphens.");
  }
}
function validateStepId(id, completedSteps = []) {
  if (typeof id !== "string" || id.length < 1 || id.length > 80 || !workflowStepIdPattern.test(id)) {
    throw new TransmuteWorkflowError("INVALID_WORKFLOW_STEP", "Step id must be 1 through 80 letters, numbers, dots, underscores, colons, or hyphens.", { completedSteps });
  }
}
function defineTransmuteWorkflow(options) {
  if (typeof options !== "object" || options === null) {
    workflowError("INVALID_WORKFLOW", "Workflow definition must be an object.");
  }
  validateWorkflowId(options.id);
  if (!Number.isSafeInteger(options.version) || options.version < 1) {
    workflowError("INVALID_WORKFLOW", "Workflow version must be a positive safe integer.");
  }
  if (typeof options.parseInput !== "function" || typeof options.run !== "function") {
    workflowError("INVALID_WORKFLOW", "Workflow definition requires parseInput and run functions.");
  }
  return Object.freeze({
    id: options.id,
    version: options.version,
    parseInput: options.parseInput,
    run: options.run
  });
}
function maximumSteps(value) {
  const resolved = value ?? defaultMaximumSteps;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > hardMaximumSteps) {
    workflowError("INVALID_WORKFLOW", `maximumSteps must be an integer from 1 through ${hardMaximumSteps}.`);
  }
  return resolved;
}
function aborted(completedSteps, cause) {
  return new TransmuteWorkflowError("WORKFLOW_ABORTED", "Workflow execution was aborted.", { cause, completedSteps });
}
async function runTransmuteWorkflow(definition, value, options = {}) {
  const normalized = defineTransmuteWorkflow(definition);
  const limit = maximumSteps(options.maximumSteps);
  const signal = options.signal ?? options.dependencies?.signal ?? new AbortController().signal;
  const invoked = new Set;
  const completed = [];
  const dispatched = [];
  let acceptingOperations = true;
  let nextIndex = 0;
  if (signal.aborted)
    throw aborted(completed);
  let input;
  try {
    input = normalized.parseInput(value);
  } catch (cause) {
    throw new TransmuteWorkflowError("INVALID_WORKFLOW_INPUT", "Workflow input did not satisfy its parser.", { cause });
  }
  const executor = options.executor ?? ((code, operationInput, context2) => executeTransmuteOperationWithLease(code, operationInput, context2.hostResourceLease, options.dependencies));
  const hostResourceCoordinator = options.hostResourceCoordinator ?? options.dependencies?.hostResourceCoordinator ?? createDefaultHostResourceCoordinator();
  const waitTimeoutMilliseconds = options.waitTimeoutMilliseconds ?? options.dependencies?.waitTimeoutMilliseconds;
  async function dispatchOperation(id, code, operationInput) {
    if (signal.aborted)
      throw aborted(completed);
    validateStepId(id, completed);
    if (!isTransmuteOperationCode(code)) {
      throw new TransmuteWorkflowError("INVALID_WORKFLOW_STEP", `Workflow step ${id} names an unknown Transmute operation.`, { completedSteps: completed });
    }
    if (invoked.has(id)) {
      throw new TransmuteWorkflowError("INVALID_WORKFLOW_STEP", `Duplicate workflow step id: ${id}.`, { completedSteps: completed });
    }
    if (nextIndex >= limit) {
      throw new TransmuteWorkflowError("INVALID_WORKFLOW_STEP", `Workflow exceeds its ${String(limit)}-step limit.`, { completedSteps: completed });
    }
    const index = nextIndex;
    nextIndex += 1;
    invoked.add(id);
    let normalizedInput;
    try {
      normalizedInput = parseTransmuteOperationInput(code, operationInput);
    } catch (cause) {
      throw new TransmuteWorkflowError("INVALID_WORKFLOW_STEP", `Workflow step ${id} has invalid input for ${code}.`, { cause, completedSteps: completed });
    }
    try {
      const result = await hostResourceCoordinator.withLease(transmuteOperationHostResourceClaims(code), async (hostResourceLease) => await executor(code, normalizedInput, {
        hostResourceLease,
        signal,
        stepId: id
      }), {
        signal,
        ...waitTimeoutMilliseconds === undefined ? {} : { waitTimeoutMilliseconds }
      });
      completed.push(Object.freeze({ id, index, operation: code }));
      if (signal.aborted)
        throw aborted(completed);
      return result;
    } catch (cause) {
      if (cause instanceof TransmuteWorkflowError && cause.code === "WORKFLOW_ABORTED") {
        throw cause;
      }
      if (signal.aborted)
        throw aborted(completed, cause);
      throw new TransmuteWorkflowError("WORKFLOW_STEP_FAILED", `Workflow step ${id} (${code}) failed.`, {
        cause,
        completedSteps: completed,
        failedStep: { id, operation: code }
      });
    }
  }
  const context = Object.freeze({
    signal,
    operation(id, code, operationInput) {
      if (!acceptingOperations) {
        const closed = Promise.reject(new TransmuteWorkflowError("INVALID_WORKFLOW_STEP", "Workflow operations cannot start after authored workflow code has settled.", { completedSteps: completed }));
        closed.catch(() => {
          return;
        });
        return closed;
      }
      const operation = dispatchOperation(id, code, operationInput);
      dispatched.push(operation);
      operation.catch(() => {
        return;
      });
      return operation;
    }
  });
  let output;
  let runFailed = false;
  let runFailure;
  try {
    output = await normalized.run(context, input);
  } catch (cause) {
    runFailed = true;
    runFailure = cause;
  } finally {
    acceptingOperations = false;
  }
  const operationResults = await Promise.allSettled(dispatched);
  if (signal.aborted)
    throw aborted(completed, runFailed ? runFailure : undefined);
  if (runFailed) {
    if (runFailure instanceof TransmuteWorkflowError)
      throw runFailure;
    throw new TransmuteWorkflowError("WORKFLOW_FAILED", `Workflow ${normalized.id} failed in authored code.`, { cause: runFailure, completedSteps: completed });
  }
  const operationFailure = operationResults.find((result) => result.status === "rejected");
  if (operationFailure !== undefined) {
    const cause = operationFailure.reason;
    if (cause instanceof TransmuteWorkflowError)
      throw cause;
    throw new TransmuteWorkflowError("WORKFLOW_STEP_FAILED", "A dispatched workflow operation failed.", { cause, completedSteps: completed });
  }
  return Object.freeze({
    workflow: Object.freeze({ id: normalized.id, version: normalized.version }),
    output,
    steps: Object.freeze([...completed].sort((left, right) => left.index - right.index))
  });
}

export { TransmuteWorkflowError, defineTransmuteWorkflow, runTransmuteWorkflow };
