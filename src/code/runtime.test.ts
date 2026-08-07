import { describe, expect, test } from "bun:test"
import { z } from "zod"

import {
  type BuiltWorkflow,
  defineWorkflow,
} from "./define-workflow.js"
import { TransmuteCodeError } from "./errors.js"
import { WorkflowGraphBuilder } from "./graph-builder.js"
import {
  PUBLIC_WORKFLOW_REGISTRY_PROJECTION,
  PUBLIC_WORKFLOW_REGISTRY_PROJECTION_ID,
  createWorkflowRegistryProjection,
} from "./projection.js"
import {
  createTransmuteCodeHost,
  runBuiltWorkflow,
  runWorkflow,
  TransmuteWorkflowRunError,
} from "./runtime.js"
import type {
  OperationDiscovery,
  WorkflowOutputValue,
} from "./contracts.js"
import type {
  PortableTransmuteOperationResultMap,
} from "./public-operations.js"

const desktopOnlyDiscovery = {
  inputSchemaId: "studio.operation.recording.start.input/v1",
  kind: "recording.start",
  lifecycle: "live-control",
  outputSchemaId: "studio.operation.recording.start.output/v1",
  policy: {
    cache: "none",
    cancellable: false,
    effect: "live-control",
    maxDurationMs: 60_000,
    maxFanOut: 0,
    maxInputBytes: 4_096,
    maxOutputBytes: 4_096,
    preparation: ["screen-capture"],
    resources: [{ amount: 1, resource: "capture-device" }],
    resume: "non-resumable-live",
  },
  version: 1,
} as const satisfies OperationDiscovery

const FIXTURE_RESULTS: PortableTransmuteOperationResultMap = {
  "transmute.diagram.check": { configPath: null, findings: [] },
  "transmute.diagram.render": {
    artifacts: {
      darkPng: "/tmp/system.dark.png",
      darkSvg: "/tmp/system.dark.svg",
      lightPng: "/tmp/system.light.png",
      lightSvg: "/tmp/system.light.svg",
      spec: "/tmp/system.json",
      tldr: "/tmp/system.tldr",
    },
    configPath: null,
    findings: [],
  },
  "transmute.image.generate": {
    bytes: 100,
    idempotencyKey: "fixture-key-0001",
    mediaType: "image/webp",
    model: "openai/gpt-image-1.5",
    outputPath: "/tmp/generated.webp",
    requestId: "request_fixture",
  },
  "transmute.image.vectorize": {
    outputPath: "/tmp/vector.svg",
    receipt: {
      alphaCutoff: 16,
      bytes: 100,
      candidatesEvaluated: 1,
      format: "png",
      height: 32,
      inputBytes: 100,
      outputMode: "color",
      pathCount: 1,
      profile: "balanced",
      provenance: {
        arch: "arm64",
        platform: "darwin",
        sharp: "fixture",
        sharpVersions: {},
        vips: "fixture",
        vtracerSha256: "0".repeat(64),
        vtracerSource: "official-release",
        vtracerVersion: "fixture",
      },
      quality: {
        alphaRmse: 0,
        colorRmse: 0,
        outsideAlphaRatio: 0,
        sampleHeight: 32,
        sampleWidth: 32,
        supportRecall: 1,
      },
      receiptVersion: 1,
      representation: "color-paths",
      sourceSha256: "1".repeat(64),
      svgSha256: "2".repeat(64),
      width: 32,
    },
  },
}

async function capturedRunError(
  promise: Promise<unknown>,
): Promise<TransmuteWorkflowRunError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof TransmuteWorkflowRunError) return error
    throw error
  }
  throw new Error("Expected TransmuteWorkflowRunError")
}

describe("portable ephemeral workflow runtime", () => {
  test("composes deeply nested bindings with one resolved node output", async () => {
    const definition = defineWorkflow({
      build(builder) {
        const checked = builder.diagram.check("check", { path: "diagram.json" })
        let output: WorkflowOutputValue = checked
        for (let depth = 0; depth < 120; depth += 1) {
          output = { nested: output }
        }
        return output
      },
      id: "nested-runtime-output",
      inputSchema: z.strictObject({}),
      inputSchemaId: "transmute.workflow.nested-runtime-output.input/v1",
      version: 1,
    })
    const host = createTransmuteCodeHost({
      execute: request => Promise.resolve(FIXTURE_RESULTS[request.kind]),
    })

    const result = await runWorkflow(definition, {}, { host })
    let cursor: unknown = result.output
    for (let depth = 0; depth < 120; depth += 1) {
      cursor = (cursor as Readonly<Record<string, unknown>>).nested
    }
    expect(cursor).toEqual(FIXTURE_RESULTS["transmute.diagram.check"])
    expect(Object.isFrozen(result.output)).toBe(true)
    expect(Object.isFrozen(cursor)).toBe(true)
  })

  test("compiles every node before host admission or execution", async () => {
    const desktopProjection = createWorkflowRegistryProjection(
      "transmute.workflow.registry.desktop-test/v1",
      [...PUBLIC_WORKFLOW_REGISTRY_PROJECTION.discovery, desktopOnlyDiscovery],
    )
    const builder = WorkflowGraphBuilder.create(desktopProjection)
    const checked = builder.operationByKind("check", {
      input: { path: "diagram.json" },
      kind: "transmute.diagram.check",
      version: 2,
    })
    builder.operationByKind("start", {
      input: { displayId: "main" },
      kind: "recording.start",
      version: 1,
    }, { after: checked })
    const graph = builder.build({
      id: "late-desktop-node",
      inputSchemaId: "studio.workflow.late-desktop-node.input/v1",
      version: 1,
    }, { checked })
    let admissions = 0
    let executions = 0
    const host = createTransmuteCodeHost({
      admit: async (_request, execute) => {
        admissions += 1
        return await execute()
      },
      execute: () => {
        executions += 1
        return Promise.reject(new Error("Executor must not be reached"))
      },
    })

    let caught: unknown
    try {
      await runBuiltWorkflow({
        graph,
        input: {},
        projection: desktopProjection,
      } satisfies BuiltWorkflow, { host })
    } catch (error) {
      caught = error
    }
    if (!(caught instanceof TransmuteCodeError)) {
      throw new Error("Expected TransmuteCodeError")
    }
    const error = caught
    expect(error).toBeInstanceOf(TransmuteCodeError)
    expect(error.code).toBe("unsupported-plan")
    expect(error.details).toMatchObject({
      kind: "recording.start",
      nodeKey: "start",
      projectionId: PUBLIC_WORKFLOW_REGISTRY_PROJECTION_ID,
    })
    expect(admissions).toBe(0)
    expect(executions).toBe(0)
  })

  test("resolves refs by waves, validates outputs, and returns stable receipts", async () => {
    const definition = defineWorkflow({
      build(builder, input: { readonly path: string }) {
        const checked = builder.diagram.check("check", input)
        const rendered = builder.diagram.render(
          "render",
          input,
          { after: checked },
        )
        return {
          artifacts: rendered.select("artifacts"),
          findings: checked.select("findings"),
        }
      },
      id: "runtime-checked-render",
      inputSchema: z.strictObject({ path: z.string().min(1) }),
      inputSchemaId: "transmute.workflow.runtime-checked-render.input/v1",
      version: 1,
    })
    let admissions = 0
    const host = createTransmuteCodeHost({
      admit: async (_request, execute) => {
        admissions += 1
        return await execute()
      },
      execute: request => Promise.resolve(FIXTURE_RESULTS[request.kind]),
    })

    const first = await runWorkflow(definition, { path: "system.json" }, { host })
    const second = await runWorkflow(definition, { path: "system.json" }, { host })
    expect(admissions).toBe(4)
    expect(first.compilation.topologicalWaves).toEqual([["check"], ["render"]])
    expect(first.output).toEqual({
      artifacts: {
        darkPng: "/tmp/system.dark.png",
        darkSvg: "/tmp/system.dark.svg",
        lightPng: "/tmp/system.light.png",
        lightSvg: "/tmp/system.light.svg",
        spec: "/tmp/system.json",
        tldr: "/tmp/system.tldr",
      },
      findings: [],
    })
    expect(first.receipts.map(receipt => receipt.nodeKey)).toEqual([
      "check",
      "render",
    ])
    expect(first.receipts).toEqual(second.receipts)
  })

  test("runs independent wave nodes concurrently and commits receipts in key order", async () => {
    const definition = defineWorkflow({
      build(builder, input: { readonly path: string }) {
        const alpha = builder.diagram.check("alpha", input)
        const beta = builder.diagram.check("beta", input)
        const rendered = builder.diagram.render("render", input, {
          after: [beta, alpha],
        })
        return { alpha, beta, rendered }
      },
      id: "parallel-wave",
      inputSchema: z.strictObject({ path: z.string().min(1) }),
      inputSchemaId: "transmute.workflow.parallel-wave.input/v1",
      version: 1,
    })
    let active = 0
    let maximumActive = 0
    let checksStarted = 0
    let releaseChecks: (() => void) | undefined
    const bothChecksStarted = new Promise<void>((resolve) => {
      releaseChecks = resolve
    })
    const completions: string[] = []
    const host = createTransmuteCodeHost({
      admit: async (_request, execute) => {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        try {
          return await execute()
        } finally {
          active -= 1
        }
      },
      execute: async (request) => {
        if (request.kind === "transmute.diagram.check") {
          checksStarted += 1
          if (checksStarted === 2) releaseChecks?.()
          await bothChecksStarted
          if (request.nodeKey === "alpha") {
            await new Promise<void>(resolve => setTimeout(resolve, 5))
          }
          completions.push(request.nodeKey)
          return FIXTURE_RESULTS[request.kind]
        }
        return FIXTURE_RESULTS[request.kind]
      },
    })

    const result = await runWorkflow(definition, { path: "system.json" }, { host })
    expect(maximumActive).toBe(2)
    expect(completions).toEqual(["beta", "alpha"])
    expect(result.compilation.topologicalWaves).toEqual([
      ["alpha", "beta"],
      ["render"],
    ])
    expect(result.receipts.map(receipt => receipt.nodeKey)).toEqual([
      "alpha",
      "beta",
      "render",
    ])
  })

  test("retains frozen completed receipts and failing-node evidence", async () => {
    const definition = defineWorkflow({
      build(builder, input: { readonly path: string }) {
        const checked = builder.diagram.check("check", input)
        const rendered = builder.diagram.render("render", input, { after: checked })
        return { checked, rendered }
      },
      id: "failed-second-node",
      inputSchema: z.strictObject({ path: z.string().min(1) }),
      inputSchemaId: "transmute.workflow.failed-second-node.input/v1",
      version: 1,
    })
    const failure = new Error("render fixture failed")
    const host = createTransmuteCodeHost({
      execute: request => request.kind === "transmute.diagram.render"
        ? Promise.reject(failure)
        : Promise.resolve(FIXTURE_RESULTS[request.kind]),
    })

    const error = await capturedRunError(
      runWorkflow(definition, { path: "system.json" }, { host }),
    )
    expect(error.code).toBe("subprocess")
    expect(error.runCause).toBe(failure)
    expect(error.failedNode).toEqual({
      kind: "transmute.diagram.render",
      nodeKey: "render",
      version: 2,
    })
    expect(error.completedReceipts.map(receipt => receipt.nodeKey)).toEqual([
      "check",
    ])
    expect(Object.isFrozen(error.completedReceipts)).toBe(true)
    expect(Object.isFrozen(error.failedNode)).toBe(true)
  })

  test("retains the completed node receipt when cancellation is observed after dispatch", async () => {
    const definition = defineWorkflow({
      build(builder, input: { readonly path: string }) {
        const checked = builder.diagram.check("check", input)
        const rendered = builder.diagram.render("render", input, { after: checked })
        return { checked, rendered }
      },
      id: "post-dispatch-cancellation",
      inputSchema: z.strictObject({ path: z.string().min(1) }),
      inputSchemaId: "transmute.workflow.post-dispatch-cancellation.input/v1",
      version: 1,
    })
    const controller = new AbortController()
    const host = createTransmuteCodeHost({
      execute: (request) => {
        if (request.kind === "transmute.diagram.render") controller.abort()
        return Promise.resolve(FIXTURE_RESULTS[request.kind])
      },
    })

    const error = await capturedRunError(runWorkflow(
      definition,
      { path: "system.json" },
      { host, signal: controller.signal },
    ))
    expect(error.code).toBe("cancelled")
    expect(error.failedNode).toBeUndefined()
    expect(error.completedReceipts.map(receipt => receipt.nodeKey)).toEqual([
      "check",
      "render",
    ])
    expect(error.runCause).toBeInstanceOf(TransmuteCodeError)
  })

  test("retains every completed receipt when final output projection fails", async () => {
    const definition = defineWorkflow({
      build(builder, input: { readonly path: string }) {
        const checked = builder.diagram.check("check", input)
        return { impossible: checked.select("findings").at(4) }
      },
      id: "invalid-final-projection",
      inputSchema: z.strictObject({ path: z.string().min(1) }),
      inputSchemaId: "transmute.workflow.invalid-final-projection.input/v1",
      version: 1,
    })
    const host = createTransmuteCodeHost({
      execute: request => Promise.resolve(FIXTURE_RESULTS[request.kind]),
    })

    const error = await capturedRunError(runWorkflow(
      definition,
      { path: "system.json" },
      { host },
    ))
    expect(error.code).toBe("invalid-data")
    expect(error.failedNode).toBeUndefined()
    expect(error.completedReceipts.map(receipt => receipt.nodeKey)).toEqual([
      "check",
    ])
    expect(error.runCause).toBeInstanceOf(TransmuteCodeError)
    expect(error.message).toContain("Workflow output resolution failed")
  })
})
