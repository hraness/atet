import { describe, expect, test } from "bun:test"
import { z } from "zod"

import {
  GRAPH_ABI,
  WORKFLOW_GRAPH_VERSION,
  WORKFLOW_REF_VERSION,
  type AuthoredWorkflowGraphV1,
  type OperationDiscovery,
} from "./contracts.js"
import {
  compileWorkflowGraph,
  createWorkflowGraphHash,
} from "./compiler.js"
import { TransmuteCodeError } from "./errors.js"
import { defineCompute } from "./define-workflow.js"
import { WorkflowGraphBuilder } from "./graph-builder.js"
import { PortableWorkflowBuilder } from "./portable-builder.js"
import {
  PORTABLE_TRANSMUTE_OPERATION_CONTRACTS,
} from "./public-operations.js"
import {
  PUBLIC_WORKFLOW_REGISTRY_PROJECTION,
  PUBLIC_WORKFLOW_REGISTRY_PROJECTION_ID,
  createWorkflowRegistryProjection,
} from "./projection.js"

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

function graphFixture(): AuthoredWorkflowGraphV1 {
  const builder = PortableWorkflowBuilder.create()
  const checked = builder.diagram.check("check", { path: "diagrams/system.json" })
  const rendered = builder.diagram.render(
    "render",
    { path: "diagrams/system.json", scale: 2 },
    { after: checked, label: "Render checked diagram" },
  )
  return builder.build({
    id: "checked-render",
    inputSchemaId: "transmute.workflow.checked-render.input/v1",
    version: 1,
  }, {
    artifacts: rendered.select("artifacts"),
    checked,
  })
}

function captureCode(callback: () => unknown): TransmuteCodeError {
  try {
    callback()
  } catch (error) {
    if (error instanceof TransmuteCodeError) return error
    throw error
  }
  throw new Error("Expected TransmuteCodeError")
}

describe("portable workflow compiler", () => {
  test("keeps public policy claims aligned with the closed semantic executor", () => {
    expect(Object.fromEntries(Object.entries(PORTABLE_TRANSMUTE_OPERATION_CONTRACTS)
      .map(([kind, contract]) => [kind, contract.policy.resources])))
      .toEqual({
        "transmute.diagram.check": [
          { amount: 1, resource: "cpu" },
          { amount: 1, resource: "local-io" },
        ],
        "transmute.diagram.render": [
          { amount: 1, resource: "cpu" },
          { amount: 1, resource: "local-io" },
        ],
        "transmute.image.generate": [
          { amount: 1, resource: "local-io" },
          { amount: 1, resource: "network" },
          { amount: 1, resource: "paid-call" },
        ],
        "transmute.image.vectorize": [
          { amount: 1, resource: "cpu" },
          { amount: 1, resource: "local-io" },
        ],
      })
    expect(PORTABLE_TRANSMUTE_OPERATION_CONTRACTS["transmute.diagram.render"].policy)
      .toMatchObject({ cache: "none", resume: "ambiguous-after-dispatch" })
    expect(PORTABLE_TRANSMUTE_OPERATION_CONTRACTS["transmute.image.vectorize"].policy)
      .toMatchObject({ cache: "none", resume: "ambiguous-after-dispatch" })
    for (const contract of Object.values(PORTABLE_TRANSMUTE_OPERATION_CONTRACTS)) {
      expect(() => z.toJSONSchema(contract.inputSchema)).not.toThrow()
      expect(() => z.toJSONSchema(contract.outputSchema)).not.toThrow()
    }
  })

  test("preserves the graph/ref ABI and locks canonical graph identity", () => {
    const graph = graphFixture()
    expect(GRAPH_ABI).toBe("studio-workflow-graph-abi-v2")
    expect(graph.version).toBe(WORKFLOW_GRAPH_VERSION)
    expect(graph.outputs).toEqual({
      artifacts: {
        $ref: {
          nodeKey: "render",
          path: ["artifacts"],
          schemaId: "transmute.operation.diagram.render.output/v2",
        },
        version: WORKFLOW_REF_VERSION,
      },
      checked: {
        $ref: {
          nodeKey: "check",
          schemaId: "transmute.operation.diagram.check.output/v2",
        },
        version: WORKFLOW_REF_VERSION,
      },
    })
    expect(createWorkflowGraphHash(graph)).toBe(
      "c6348ca6f5e8950bb84c5c19dcb7f6739d84c94daa6aeee409986407175cc212",
    )

    const reversed = { ...graph, nodes: [...graph.nodes].reverse() }
    expect(createWorkflowGraphHash(reversed)).toBe(createWorkflowGraphHash(graph))
  })

  test("binds compilation to a normalized immutable projection, not graph identity", () => {
    const graph = graphFixture()
    const publicCompilation = compileWorkflowGraph({ graph })
    const desktopProjection = createWorkflowRegistryProjection(
      "transmute.workflow.registry.desktop-test/v1",
      [...PUBLIC_WORKFLOW_REGISTRY_PROJECTION.discovery, desktopOnlyDiscovery],
      { trustedCompute: true },
    )
    const desktopCompilation = compileWorkflowGraph({
      graph,
      projection: desktopProjection,
    })

    expect(publicCompilation.graphSha256).toBe(desktopCompilation.graphSha256)
    expect(publicCompilation.compilationSha256)
      .not.toBe(desktopCompilation.compilationSha256)
    expect(publicCompilation.projection.id)
      .toBe(PUBLIC_WORKFLOW_REGISTRY_PROJECTION_ID)
    expect(publicCompilation.projection.trustedCompute).toBe(false)
    expect(Object.isFrozen(publicCompilation.projection)).toBe(true)
    expect(Object.isFrozen(publicCompilation.projection.discovery)).toBe(true)
    expect(Object.isFrozen(publicCompilation.projection.discovery[0]?.policy.resources))
      .toBe(true)
    expect(publicCompilation.topologicalWaves).toEqual([["check"], ["render"]])
  })

  test("rejects a local-host-only operation at the public compile boundary", () => {
    const projection = createWorkflowRegistryProjection(
      "transmute.workflow.registry.desktop-test/v1",
      [...PUBLIC_WORKFLOW_REGISTRY_PROJECTION.discovery, desktopOnlyDiscovery],
    )
    const builder = WorkflowGraphBuilder.create(projection)
    const started = builder.operationByKind("start", {
      input: { displayId: "main" },
      kind: "recording.start",
      version: 1,
    })
    const graph = builder.build({
      id: "desktop-only",
      inputSchemaId: "studio.workflow.desktop-only.input/v1",
      version: 1,
    }, { started })
    const error = captureCode(() => compileWorkflowGraph({ graph }))
    expect(error.code).toBe("unsupported-plan")
    expect(error.details).toMatchObject({
      kind: "recording.start",
      nodeKey: "start",
      projectionId: PUBLIC_WORKFLOW_REGISTRY_PROJECTION_ID,
      version: 1,
    })
  })

  test("hash-binds trusted-compute authority and rejects it publicly", () => {
    const builder = WorkflowGraphBuilder.create(PUBLIC_WORKFLOW_REGISTRY_PROJECTION)
    const compute = defineCompute({
      inputSchema: z.strictObject({ value: z.number() }),
      inputSchemaId: "test.compute.input/v1",
      key: "test.compute",
      outputSchema: z.strictObject({ value: z.number() }),
      outputSchemaId: "test.compute.output/v1",
      run: input => input,
    })
    const output = builder.compute("compute", compute, { value: 1 })
    const graph = builder.build({
      id: "compute-authority",
      inputSchemaId: "test.compute-authority.input/v1",
      version: 1,
    }, { output })

    const error = captureCode(() => compileWorkflowGraph({ graph }))
    expect(error.code).toBe("unsupported-plan")
    expect(error.details).toMatchObject({
      executorKind: "compute",
      nodeKey: "compute",
      projectionId: PUBLIC_WORKFLOW_REGISTRY_PROJECTION_ID,
    })

    const trusted = createWorkflowRegistryProjection(
      "transmute.workflow.registry.trusted-test/v1",
      PUBLIC_WORKFLOW_REGISTRY_PROJECTION.discovery,
      { trustedCompute: true },
    )
    const compiled = compileWorkflowGraph({ graph, projection: trusted })
    expect(compiled.projection.trustedCompute).toBe(true)
    expect(compiled.projection.projectionSha256)
      .not.toBe(PUBLIC_WORKFLOW_REGISTRY_PROJECTION.projectionSha256)
    expect(compiled.envelope.effects).toEqual(["trusted-code"])
  })

  test("rejects reserved refs and cyclic authoring values", () => {
    const builder = PortableWorkflowBuilder.create()
    expect(() => {
      Reflect.apply(builder.diagram.check, undefined, ["reserved", {
        path: {
          $ref: {
            nodeKey: "forged",
            schemaId: "transmute.operation.diagram.check.output/v2",
          },
          version: WORKFLOW_REF_VERSION,
        },
      }])
    }).toThrow(TransmuteCodeError)

    const cyclic: { path?: unknown } = {}
    cyclic.path = cyclic
    expect(() => {
      Reflect.apply(builder.diagram.check, undefined, ["cyclic", cyclic])
    }).toThrow(TransmuteCodeError)
  })

  test("rejects graph cycles and configured structural limits", () => {
    const graph = graphFixture()
    const check = graph.nodes.find(node => node.key === "check")
    if (check === undefined) throw new Error("Missing check fixture")
    const cyclic: AuthoredWorkflowGraphV1 = {
      ...graph,
      nodes: graph.nodes.map(node => node.key === "check"
        ? {
            ...check,
            dependencies: ["render"],
            input: {
              path: {
                $ref: {
                  nodeKey: "render",
                  schemaId: "transmute.operation.diagram.render.output/v2",
                },
                version: WORKFLOW_REF_VERSION,
              },
            },
          }
        : node),
    }
    expect(() => compileWorkflowGraph({ graph: cyclic }))
      .toThrow("Workflow graph contains a dependency cycle.")
    expect(() => compileWorkflowGraph({ graph, limits: { maxNodes: 1 } }))
      .toThrow("Workflow has 2 nodes; the limit is 1.")
  })
})
