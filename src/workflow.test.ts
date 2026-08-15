import { describe, expect, test } from "bun:test"
import {
  defineAtetWorkflow,
  defineTransmuteWorkflow,
  runAtetWorkflow,
  runTransmuteWorkflow,
  AtetWorkflowError,
  type AtetWorkflowExecutor,
  type TransmuteWorkflowExecutor,
} from "./workflow.ts"
import {
  createProcessLocalHostResourceCoordinator,
  type HostResourceCoordinator,
  type HostResourceLeaseOptions,
} from "./host-resources.ts"

function diagramInput(value: unknown): { readonly path: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof Reflect.get(value, "path") !== "string"
  ) {
    throw new Error("path is required")
  }
  return { path: Reflect.get(value, "path") as string }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000
  while (!predicate()) {
    if (performance.now() >= deadline) {
      throw new Error("Timed out waiting for workflow executor admission.")
    }
    await Bun.sleep(2)
  }
}

describe("typed Atet workflows", () => {
  test("adapts the v1 workflow input surface and emits canonical receipts", async () => {
    const observed: string[] = []
    const executor: TransmuteWorkflowExecutor = (async (code, input) => {
      observed.push(`${code}:${Reflect.get(input, "path") as string}`)
      return { configPath: null, findings: [] }
    }) as TransmuteWorkflowExecutor
    const workflow = defineTransmuteWorkflow({
      id: "legacy-input-adapter",
      version: 1,
      parseInput: diagramInput,
      run: (context, input) => context.operation(
        "check",
        "transmute.diagram.check",
        input,
      ),
    })

    const result = await runTransmuteWorkflow(
      workflow,
      { path: "legacy.diagram.json" },
      {
        executor,
        hostResourceCoordinator: createProcessLocalHostResourceCoordinator({
          profile: {
            id: "test.legacy-workflow-adapter/v1",
            capacities: [
              { resource: "cpu", limit: 1 },
              { resource: "local-io", limit: 1 },
            ],
          },
        }),
      },
    )

    expect(observed).toEqual([
      "transmute.diagram.check:legacy.diagram.json",
    ])
    expect(result.steps).toEqual([
      { id: "check", index: 0, operation: "atet.diagram.check" },
    ])
  })

  test("wraps a custom executor in immutable operation-owned admission", async () => {
    const coordinator = createProcessLocalHostResourceCoordinator({
      profile: {
        id: "test.workflow-admission/v1",
        capacities: [
          { resource: "cpu", limit: 1 },
          { resource: "local-io", limit: 1 },
        ],
      },
    })
    const workflowSignal = new AbortController().signal
    let observedAdmissionOptions: HostResourceLeaseOptions | undefined
    const workflowCoordinator: HostResourceCoordinator = {
      profile: coordinator.profile,
      scope: coordinator.scope,
      withLease: async (claims, callback, options) => {
        observedAdmissionOptions = options
        return await coordinator.withLease(claims, callback, options)
      },
    }
    let observedLease: unknown
    const workflow = defineAtetWorkflow({
      id: "custom-executor-admission",
      version: 1,
      parseInput: diagramInput,
      run: (context, input) => context.operation(
        "check",
        "atet.diagram.check",
        input,
      ),
    })
    await runAtetWorkflow(workflow, { path: "flow.diagram.json" }, {
      dependencies: {
        hostResourceCoordinator: workflowCoordinator,
        signal: workflowSignal,
        waitTimeoutMilliseconds: 1_234,
      },
      executor: (async (_code, _input, { hostResourceLease, signal }) => {
        observedLease = hostResourceLease
        expect(signal).toBe(workflowSignal)
        await hostResourceLease.assertOwned()
        expect(hostResourceLease.claims).toEqual([
          { resource: "cpu", amount: 1 },
          { resource: "local-io", amount: 1 },
        ])
        return { configPath: null, findings: [] }
      }) as AtetWorkflowExecutor,
    })
    expect(observedLease).toBeDefined()
    expect(observedAdmissionOptions).toEqual({
      signal: workflowSignal,
      waitTimeoutMilliseconds: 1_234,
    })
  })

  test("parses input and runs typed operations with an ordered receipt", async () => {
    const calls: string[] = []
    const executor: AtetWorkflowExecutor = (async (code, input) => {
      calls.push(`${code}:${Reflect.get(input, "path") as string}`)
      if (code === "atet.diagram.check") {
        return { configPath: null, findings: [] }
      }
      if (code === "atet.diagram.render") {
        return {
          artifacts: {
            spec: "/tmp/flow.diagram.json",
            tldr: "/tmp/flow.tldr",
            lightSvg: "/tmp/flow.light.svg",
            darkSvg: "/tmp/flow.dark.svg",
            lightPng: "/tmp/flow.light.png",
            darkPng: "/tmp/flow.dark.png",
          },
          configPath: null,
          findings: [],
        }
      }
      throw new Error(`Unexpected operation ${code}`)
    }) as AtetWorkflowExecutor
    const workflow = defineAtetWorkflow({
      id: "checked-render",
      version: 1,
      parseInput: diagramInput,
      async run(context, input) {
        const checked = await context.operation(
          "check",
          "atet.diagram.check",
          input,
        )
        const rendered = await context.operation(
          "render",
          "atet.diagram.render",
          input,
        )
        return {
          artifact: rendered.artifacts.lightSvg,
          findingCount: checked.findings.length,
        }
      },
    })

    const result = await runAtetWorkflow(
      workflow,
      { path: "/tmp/flow.diagram.json" },
      { executor },
    )

    expect(calls).toEqual([
      "atet.diagram.check:/tmp/flow.diagram.json",
      "atet.diagram.render:/tmp/flow.diagram.json",
    ])
    expect(result).toEqual({
      workflow: { id: "checked-render", version: 1 },
      output: { artifact: "/tmp/flow.light.svg", findingCount: 0 },
      steps: [
        { id: "check", index: 0, operation: "atet.diagram.check" },
        { id: "render", index: 1, operation: "atet.diagram.render" },
      ],
    })
  })

  test("keeps parallel receipts in invocation order", async () => {
    const coordinator = createProcessLocalHostResourceCoordinator({
      profile: {
        id: "test.workflow-parallel-receipts/v1",
        capacities: [
          { resource: "cpu", limit: 2 },
          { resource: "local-io", limit: 2 },
        ],
      },
    })
    const admitted = new Set<string>()
    const completed = new Set<string>()
    const releases = new Map<string, () => void>()
    const blockers = new Map(["first", "second"].map((stepId) => {
      let release!: () => void
      const blocker = new Promise<void>((resolve) => {
        release = resolve
      })
      releases.set(stepId, release)
      return [stepId, blocker] as const
    }))
    const executor = (async (_code, _input, { stepId }) => {
      admitted.add(stepId)
      await blockers.get(stepId)
      completed.add(stepId)
      return { configPath: null, findings: [] }
    }) as AtetWorkflowExecutor
    const workflow = defineAtetWorkflow({
      id: "parallel-checks",
      version: 1,
      parseInput: diagramInput,
      async run(context, input) {
        const first = context.operation(
          "first",
          "atet.diagram.check",
          input,
        )
        const second = context.operation(
          "second",
          "atet.diagram.check",
          input,
        )
        try {
          await waitUntil(() => admitted.size === 2)
          releases.get("second")?.()
          await waitUntil(() => completed.has("second"))
          releases.get("first")?.()
          await Promise.all([first, second])
        } finally {
          releases.get("second")?.()
          releases.get("first")?.()
        }
        return "done"
      },
    })

    const result = await runAtetWorkflow(
      workflow,
      { path: "flow.diagram.json" },
      { executor, hostResourceCoordinator: coordinator },
    )
    expect(result.steps.map(({ id }) => id)).toEqual(["first", "second"])
  })

  test("drains an un-awaited operation before reporting success", async () => {
    let release: (() => void) | undefined
    const executor = (async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return { configPath: null, findings: [] }
    }) as AtetWorkflowExecutor
    const workflow = defineAtetWorkflow({
      id: "drain-operation",
      version: 1,
      parseInput: diagramInput,
      run(context, input) {
        void context.operation("check", "atet.diagram.check", input)
        return "scheduled"
      },
    })

    let settled = false
    const execution = runAtetWorkflow(
      workflow,
      { path: "flow.diagram.json" },
      { executor },
    )
    void execution.then(() => {
      settled = true
    })
    await waitUntil(() => release !== undefined)
    expect(settled).toBe(false)
    release?.()

    const result = await execution
    expect(result.output).toBe("scheduled")
    expect(result.steps).toEqual([
      { id: "check", index: 0, operation: "atet.diagram.check" },
    ])
  })

  test("turns an un-awaited operation rejection into workflow failure", async () => {
    const cause = new Error("background check failed")
    const workflow = defineAtetWorkflow({
      id: "drain-failure",
      version: 1,
      parseInput: diagramInput,
      run(context, input) {
        void context.operation("check", "atet.diagram.check", input)
        return "scheduled"
      },
    })

    await expect(runAtetWorkflow(
      workflow,
      { path: "flow.diagram.json" },
      {
        executor: (async () => {
          throw cause
        }) as AtetWorkflowExecutor,
      },
    )).rejects.toMatchObject({
      cause,
      code: "WORKFLOW_STEP_FAILED",
      completedSteps: [],
      failedStep: { id: "check" },
    })
  })

  test("rejects invalid foreign input before invoking an operation", async () => {
    let executed = false
    const workflow = defineAtetWorkflow({
      id: "checked-render",
      version: 1,
      parseInput: diagramInput,
      async run(context, input) {
        return context.operation("check", "atet.diagram.check", input)
      },
    })
    await expect(
      runAtetWorkflow(workflow, null, {
        executor: (async () => {
          executed = true
          throw new Error("must not execute")
        }) as AtetWorkflowExecutor,
      }),
    ).rejects.toMatchObject({ code: "INVALID_WORKFLOW_INPUT" })
    expect(executed).toBe(false)
  })

  test("rejects unknown operations and invalid operation input before an executor", async () => {
    let executions = 0
    const executor = (async () => {
      executions += 1
      return { configPath: null, findings: [] }
    }) as AtetWorkflowExecutor
    const unknownOperation = defineAtetWorkflow({
      id: "unknown-operation",
      version: 1,
      parseInput: diagramInput,
      run(context, input) {
        const unsafeOperation = context.operation as unknown as (
          id: string,
          code: string,
          value: unknown,
        ) => Promise<unknown>
        return unsafeOperation(
          "unknown",
          "atet.private.render",
          input,
        )
      },
    })
    await expect(
      runAtetWorkflow(
        unknownOperation,
        { path: "flow.diagram.json" },
        { executor },
      ),
    ).rejects.toMatchObject({ code: "INVALID_WORKFLOW_STEP" })

    const invalidInput = defineAtetWorkflow({
      id: "invalid-operation-input",
      version: 1,
      parseInput: diagramInput,
      run(context) {
        return context.operation(
          "invalid",
          "atet.diagram.check",
          { path: "" },
        )
      },
    })
    await expect(
      runAtetWorkflow(
        invalidInput,
        { path: "flow.diagram.json" },
        { executor },
      ),
    ).rejects.toMatchObject({ code: "INVALID_WORKFLOW_STEP" })
    expect(executions).toBe(0)
  })

  test("bounds steps and rejects duplicate ids", async () => {
    const executor = (async () => ({ configPath: null, findings: [] })) as
      AtetWorkflowExecutor
    const duplicate = defineAtetWorkflow({
      id: "duplicate",
      version: 1,
      parseInput: diagramInput,
      async run(context, input) {
        await context.operation("same", "atet.diagram.check", input)
        return context.operation("same", "atet.diagram.check", input)
      },
    })
    await expect(
      runAtetWorkflow(duplicate, { path: "flow.diagram.json" }, { executor }),
    ).rejects.toMatchObject({
      code: "INVALID_WORKFLOW_STEP",
      completedSteps: [
        { id: "same", index: 0, operation: "atet.diagram.check" },
      ],
      message: expect.stringContaining("Duplicate workflow step id"),
    })

    const bounded = defineAtetWorkflow({
      id: "bounded",
      version: 1,
      parseInput: diagramInput,
      async run(context, input) {
        await context.operation("one", "atet.diagram.check", input)
        return context.operation("two", "atet.diagram.check", input)
      },
    })
    await expect(
      runAtetWorkflow(bounded, { path: "flow.diagram.json" }, {
        executor,
        maximumSteps: 1,
      }),
    ).rejects.toMatchObject({
      code: "INVALID_WORKFLOW_STEP",
      message: expect.stringContaining("1-step limit"),
    })
  })

  test("identifies a failed step without hiding its cause", async () => {
    const cause = new Error("render unavailable")
    const workflow = defineAtetWorkflow({
      id: "failed-render",
      version: 1,
      parseInput: diagramInput,
      run(context, input) {
        return context.operation("render", "atet.diagram.render", input)
      },
    })
    try {
      await runAtetWorkflow(workflow, { path: "flow.diagram.json" }, {
        executor: (async () => {
          throw cause
        }) as AtetWorkflowExecutor,
      })
      throw new Error("Expected workflow failure")
    } catch (error) {
      expect(error).toBeInstanceOf(AtetWorkflowError)
      expect(error).toMatchObject({
        cause,
        code: "WORKFLOW_STEP_FAILED",
        completedSteps: [],
        failedStep: {
          id: "render",
          operation: "atet.diagram.render",
        },
      })
    }
  })

  test("wraps authored-code failure with completed step receipts", async () => {
    const cause = new Error("postcondition failed")
    const executor = (async () => ({ configPath: null, findings: [] })) as
      AtetWorkflowExecutor
    const workflow = defineAtetWorkflow({
      id: "postcondition",
      version: 1,
      parseInput: diagramInput,
      async run(context, input) {
        await context.operation("check", "atet.diagram.check", input)
        throw cause
      },
    })

    await expect(runAtetWorkflow(
      workflow,
      { path: "flow.diagram.json" },
      { executor },
    )).rejects.toMatchObject({
      cause,
      code: "WORKFLOW_FAILED",
      completedSteps: [
        { id: "check", index: 0, operation: "atet.diagram.check" },
      ],
    })
  })

  test("freezes a parallel failure receipt before a sibling settles", async () => {
    const coordinator = createProcessLocalHostResourceCoordinator({
      profile: {
        id: "test.workflow-parallel-failure/v1",
        capacities: [
          { resource: "cpu", limit: 2 },
          { resource: "local-io", limit: 2 },
        ],
      },
    })
    let siblingAdmitted = false
    let releaseSibling!: () => void
    const siblingBlocker = new Promise<void>((resolve) => {
      releaseSibling = resolve
    })
    let markFailed: () => void = () => undefined
    const failed = new Promise<void>((resolve) => {
      markFailed = resolve
    })
    const cause = new Error("first failed")
    const executor = (async (_code, _input, { stepId }) => {
      if (stepId === "failed") {
        markFailed()
        throw cause
      }
      siblingAdmitted = true
      await siblingBlocker
      return { configPath: null, findings: [] }
    }) as AtetWorkflowExecutor
    const workflow = defineAtetWorkflow({
      id: "parallel-failure",
      version: 1,
      parseInput: diagramInput,
      async run(context, input) {
        await Promise.all([
          context.operation("failed", "atet.diagram.check", input),
          context.operation("sibling", "atet.diagram.check", input),
        ])
      },
    })

    const execution = runAtetWorkflow(
      workflow,
      { path: "flow.diagram.json" },
      { executor, hostResourceCoordinator: coordinator },
    )
    let admissionFailure: unknown
    try {
      await failed
      await waitUntil(() => siblingAdmitted)
    } catch (error) {
      admissionFailure = error
    } finally {
      releaseSibling()
    }

    let failure: unknown
    try {
      await execution
    } catch (error) {
      failure = error
    }
    if (admissionFailure !== undefined) {
      throw admissionFailure
    }
    expect(failure).toMatchObject({
      code: "WORKFLOW_STEP_FAILED",
      completedSteps: [],
      failedStep: { id: "failed" },
    })
    expect(failure).toMatchObject({ completedSteps: [] })
  })

  test("honors an already-aborted signal", async () => {
    const controller = new AbortController()
    controller.abort()
    const workflow = defineAtetWorkflow({
      id: "abort-before-run",
      version: 1,
      parseInput: diagramInput,
      run: () => "unreachable",
    })
    await expect(
      runAtetWorkflow(workflow, { path: "flow.diagram.json" }, {
        dependencies: { signal: controller.signal },
      }),
    ).rejects.toMatchObject({ code: "WORKFLOW_ABORTED" })
  })

  test("reports cooperative in-flight cancellation as workflow abort", async () => {
    const controller = new AbortController()
    const executorCause = new Error("executor observed abort")
    let receivedSignal: AbortSignal | undefined
    const workflow = defineAtetWorkflow({
      id: "abort-in-flight",
      version: 1,
      parseInput: diagramInput,
      run(context, input) {
        return context.operation("check", "atet.diagram.check", input)
      },
    })
    const execution = runAtetWorkflow(
      workflow,
      { path: "flow.diagram.json" },
      {
        signal: controller.signal,
        executor: (async (_code, _input, { signal }) => {
          receivedSignal = signal
          controller.abort()
          throw executorCause
        }) as AtetWorkflowExecutor,
      },
    )
    await expect(execution).rejects.toMatchObject({
      cause: executorCause,
      code: "WORKFLOW_ABORTED",
      completedSteps: [],
    })
    expect(receivedSignal).toBe(controller.signal)
  })

  test("retains a completed step when cancellation becomes visible at settlement", async () => {
    const controller = new AbortController()
    const workflow = defineAtetWorkflow({
      id: "abort-at-settlement",
      version: 1,
      parseInput: diagramInput,
      run(context, input) {
        return context.operation("check", "atet.diagram.check", input)
      },
    })
    const execution = runAtetWorkflow(
      workflow,
      { path: "flow.diagram.json" },
      {
        signal: controller.signal,
        executor: (async () => {
          controller.abort()
          return { configPath: null, findings: [] }
        }) as AtetWorkflowExecutor,
      },
    )
    await expect(execution).rejects.toMatchObject({
      code: "WORKFLOW_ABORTED",
      completedSteps: [
        { id: "check", index: 0, operation: "atet.diagram.check" },
      ],
    })
  })

  test("validates stable workflow identity", () => {
    expect(() => defineAtetWorkflow({
      id: "Desktop Workflow",
      version: 1,
      parseInput: (value) => value,
      run: (_context, input) => input,
    })).toThrow("[INVALID_WORKFLOW]")
    expect(() => defineAtetWorkflow({
      id: "valid",
      version: 0,
      parseInput: (value) => value,
      run: (_context, input) => input,
    })).toThrow("[INVALID_WORKFLOW]")
  })
})
