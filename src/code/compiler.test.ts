import { describe, expect, test } from "bun:test"
import { z } from "zod"

import {
  GRAPH_ABI,
  LEGACY_TRUSTED_COMPUTE_BRAND,
  LEGACY_REQUIREMENT_ENVELOPE_VERSION,
  LEGACY_WORKFLOW_COMPILATION_VERSION,
  LEGACY_WORKFLOW_GRAPH_VERSION,
  LEGACY_WORKFLOW_REF_VERSION,
  MAX_OPERATION_DISCOVERY_ENTRIES,
  MAX_SERIALIZED_NODE_DEPENDENCIES,
  MAX_SERIALIZED_REF_PATH_SEGMENTS,
  WORKFLOW_GRAPH_VERSION,
  WORKFLOW_REF_BRAND,
  WORKFLOW_REF_VERSION,
  TRUSTED_COMPUTE_BRAND,
  type AuthoredWorkflowGraphV1,
  type GraphInputValue,
  type OperationDiscovery,
} from "./contracts.js"
import {
  compileWorkflowGraph,
  createWorkflowCompilationHash,
  createWorkflowGraphHash,
  parseCompiledWorkflowGraph,
} from "./compiler.js"
import { AtetCodeError } from "./errors.js"
import { defineCompute } from "./define-workflow.js"
import { WorkflowGraphBuilder } from "./graph-builder.js"
import { PortableWorkflowBuilder } from "./portable-builder.js"
import {
  PORTABLE_ATET_OPERATION_CONTRACTS,
  AtetImageGenerateInputSchema,
} from "./public-operations.js"
import {
  PUBLIC_TRANSMUTE_WORKFLOW_PROJECTION,
  PUBLIC_WORKFLOW_REGISTRY_PROJECTION,
  PUBLIC_WORKFLOW_REGISTRY_PROJECTION_ID,
  createWorkflowRegistryProjection,
  createWorkflowRegistryProjectionHash,
  parseWorkflowRegistryProjection,
} from "./projection.js"

const desktopOnlyDiscovery = {
  inputSchemaId: "atet.operation.recording.start.input/v1",
  kind: "recording.start",
  lifecycle: "live-control",
  outputSchemaId: "atet.operation.recording.start.output/v1",
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
    inputSchemaId: "atet.workflow.checked-render.input/v1",
    version: 1,
  }, {
    artifacts: rendered.select("artifacts"),
    checked,
  })
}

function captureCode(callback: () => unknown): AtetCodeError {
  try {
    callback()
  } catch (error) {
    if (error instanceof AtetCodeError) return error
    throw error
  }
  throw new Error("Expected AtetCodeError")
}

describe("portable workflow compiler", () => {
  test("keeps public policy claims aligned with the closed semantic executor", () => {
    expect(Object.fromEntries(Object.entries(PORTABLE_ATET_OPERATION_CONTRACTS)
      .map(([kind, contract]) => [kind, contract.policy.resources])))
      .toEqual({
        "atet.diagram.check": [
          { amount: 1, resource: "cpu" },
          { amount: 1, resource: "local-io" },
        ],
        "atet.diagram.render": [
          { amount: 1, resource: "cpu" },
          { amount: 1, resource: "local-io" },
        ],
        "atet.image.generate": [
          { amount: 1, resource: "local-io" },
          { amount: 1, resource: "network" },
          { amount: 1, resource: "paid-call" },
        ],
        "atet.image.vectorize": [
          { amount: 1, resource: "cpu" },
          { amount: 1, resource: "local-io" },
        ],
      })
    expect(PORTABLE_ATET_OPERATION_CONTRACTS["atet.diagram.render"].policy)
      .toMatchObject({ cache: "none", resume: "ambiguous-after-dispatch" })
    expect(PORTABLE_ATET_OPERATION_CONTRACTS["atet.image.vectorize"].policy)
      .toMatchObject({ cache: "none", resume: "ambiguous-after-dispatch" })
    for (const contract of Object.values(PORTABLE_ATET_OPERATION_CONTRACTS)) {
      expect(() => z.toJSONSchema(contract.inputSchema)).not.toThrow()
      expect(() => z.toJSONSchema(contract.outputSchema)).not.toThrow()
    }

    const oversizedBlankPrompt = AtetImageGenerateInputSchema.safeParse({
      model: "openai/gpt-image-1.5",
      outputPath: "render.webp",
      prompt: " ".repeat(32 * 1024 + 1),
    })
    expect(oversizedBlankPrompt.success).toBe(false)
    if (oversizedBlankPrompt.success) throw new Error("Expected prompt rejection")
    expect(oversizedBlankPrompt.error.issues.map(issue => issue.message)).toEqual([
      "Prompts must contain at most 32768 UTF-8 bytes.",
    ])
  })

  test("preserves the graph/ref ABI and locks canonical graph identity", () => {
    const graph = graphFixture()
    expect(GRAPH_ABI).toBe("atet-workflow-graph-abi-v2")
    expect(graph.version).toBe(WORKFLOW_GRAPH_VERSION)
    expect(graph.outputs).toEqual({
      artifacts: {
        $ref: {
          nodeKey: "render",
          path: ["artifacts"],
          schemaId: "atet.operation.diagram.render.output/v2",
        },
        version: WORKFLOW_REF_VERSION,
      },
      checked: {
        $ref: {
          nodeKey: "check",
          schemaId: "atet.operation.diagram.check.output/v2",
        },
        version: WORKFLOW_REF_VERSION,
      },
    })
    expect(createWorkflowGraphHash(graph)).toBe(
      "445128153d3745b28c7be36ce2fa8718d3b3bef4c0bf6f3c58b85ccb72de4907",
    )

    const reversed = { ...graph, nodes: [...graph.nodes].reverse() }
    expect(createWorkflowGraphHash(reversed)).toBe(createWorkflowGraphHash(graph))
  })

  test("preserves released locale ordering for punctuation-sensitive node keys", () => {
    const builder = PortableWorkflowBuilder.create()
    const underscored = builder.diagram.check("a_b", { path: "underscore.json" })
    const hyphenated = builder.diagram.check("a-b", { path: "hyphen.json" })
    const rendered = builder.diagram.render(
      "z",
      { path: "diagram.json", scale: 1 },
      { after: [underscored, hyphenated] },
    )
    const graph = builder.build({
      id: "released-locale-order",
      inputSchemaId: "atet.workflow.released-locale-order.input/v1",
      version: 1,
    }, { rendered })
    const compiled = compileWorkflowGraph({ graph })

    expect(graph.nodes.map(node => node.key)).toEqual(["a_b", "a-b", "z"])
    expect(graph.nodes.at(-1)?.controlDependencies).toEqual(["a_b", "a-b"])
    expect(graph.nodes.at(-1)?.dependencies).toEqual(["a_b", "a-b"])
    expect(compiled.topologicalWaves).toEqual([["a_b", "a-b"], ["z"]])
    expect(createWorkflowGraphHash(graph)).toBe(
      "2f8ecb8884efef558af7c83e5b764f77f71c80a937b674f866d9586907156b1d",
    )
  })

  test("binds compilation to a normalized immutable projection, not graph identity", () => {
    const graph = graphFixture()
    const publicCompilation = compileWorkflowGraph({ graph })
    expect(JSON.stringify(publicCompilation)).not.toMatch(/studio|transmute/u)
    expect(PUBLIC_TRANSMUTE_WORKFLOW_PROJECTION.id)
      .toBe("transmute.workflow.registry.public/v1")
    expect(PUBLIC_TRANSMUTE_WORKFLOW_PROJECTION.discovery.every(operation => (
      operation.kind.startsWith("transmute.")
      && operation.inputSchemaId.startsWith("transmute.")
      && operation.outputSchemaId.startsWith("transmute.")
    ))).toBe(true)
    expect(parseWorkflowRegistryProjection(PUBLIC_TRANSMUTE_WORKFLOW_PROJECTION))
      .toEqual(PUBLIC_WORKFLOW_REGISTRY_PROJECTION)
    expect(createWorkflowRegistryProjectionHash({
      discovery: PUBLIC_TRANSMUTE_WORKFLOW_PROJECTION.discovery,
      id: PUBLIC_TRANSMUTE_WORKFLOW_PROJECTION.id,
      trustedCompute: false,
    })).toBe(PUBLIC_WORKFLOW_REGISTRY_PROJECTION.projectionSha256)
    expect(() => parseWorkflowRegistryProjection({
      ...PUBLIC_TRANSMUTE_WORKFLOW_PROJECTION,
      discovery: PUBLIC_TRANSMUTE_WORKFLOW_PROJECTION.discovery.slice(1),
    })).toThrow("hash does not match")
    const desktopProjection = createWorkflowRegistryProjection(
      "atet.workflow.registry.desktop-test/v1",
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

    let enumeratedDiscovery = false
    const oversizedDiscovery = new Proxy(
      new Array<OperationDiscovery>(MAX_OPERATION_DISCOVERY_ENTRIES + 1),
      {
        ownKeys: (target) => {
          enumeratedDiscovery = true
          return Reflect.ownKeys(target)
        },
      },
    )
    expect(() => createWorkflowRegistryProjection(
      "atet.workflow.registry.oversized-test/v1",
      oversizedDiscovery,
    )).toThrow("cannot exceed")
    expect(enumeratedDiscovery).toBe(false)

    let enumeratedResources = false
    const oversizedResources = new Proxy(new Array<unknown>(100_000), {
      ownKeys: (target) => {
        enumeratedResources = true
        return Reflect.ownKeys(target)
      },
    })
    expect(() => createWorkflowRegistryProjection(
      "atet.workflow.registry.resource-bound-test/v1",
      [{
        ...desktopOnlyDiscovery,
        kind: "test.resource-bound",
        policy: { ...desktopOnlyDiscovery.policy, resources: oversizedResources },
      } as unknown as OperationDiscovery],
    )).toThrow("contains more than")
    expect(enumeratedResources).toBe(false)

    let projectionFieldReads = 0
    const projectionProxy = new Proxy(desktopProjection, {
      get: (target, property, receiver) => {
        projectionFieldReads += 1
        return Reflect.get(target, property, receiver) as unknown
      },
    })
    expect(parseWorkflowRegistryProjection(projectionProxy).projectionSha256)
      .toBe(desktopProjection.projectionSha256)
    expect(projectionFieldReads).toBe(0)
  })

  test("rejects a local-host-only operation at the public compile boundary", () => {
    const projection = createWorkflowRegistryProjection(
      "atet.workflow.registry.desktop-test/v1",
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
      inputSchemaId: "atet.workflow.desktop-only.input/v1",
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
      "atet.workflow.registry.trusted-test/v1",
      PUBLIC_WORKFLOW_REGISTRY_PROJECTION.discovery,
      { trustedCompute: true },
    )
    const compiled = compileWorkflowGraph({ graph, projection: trusted })
    expect(compiled.projection.trustedCompute).toBe(true)
    expect(compiled.projection.projectionSha256)
      .not.toBe(PUBLIC_WORKFLOW_REGISTRY_PROJECTION.projectionSha256)
    expect(compiled.envelope.effects).toEqual(["trusted-code"])

    expect(Symbol.keyFor(TRUSTED_COMPUTE_BRAND))
      .toBe("atet.trusted-compute-definition")
    expect(Symbol.keyFor(WORKFLOW_REF_BRAND)).toBe("atet.workflow-ref")
    const legacyCompute = {
      [LEGACY_TRUSTED_COMPUTE_BRAND]: true as const,
      bounds: compute.bounds,
      inputSchema: compute.inputSchema,
      inputSchemaId: compute.inputSchemaId,
      key: "test.legacy-compute",
      outputSchema: compute.outputSchema,
      outputSchemaId: compute.outputSchemaId,
      run: compute.run,
    } as unknown as typeof compute
    const legacyBuilder = WorkflowGraphBuilder.create(trusted)
    const legacyOutput = legacyBuilder.compute(
      "legacy-compute",
      legacyCompute,
      { value: 1 },
    )
    const normalizedCompute = legacyBuilder.computeDefinitions()[0]
    expect(Reflect.get(normalizedCompute!, TRUSTED_COMPUTE_BRAND)).toBe(true)
    expect(Reflect.get(normalizedCompute!, LEGACY_TRUSTED_COMPUTE_BRAND))
      .toBeUndefined()
    const legacyGraph = legacyBuilder.build({
      id: "legacy-compute-reader",
      inputSchemaId: "studio.workflow.legacy-compute-reader.input/v1",
      version: 1,
    }, { legacyOutput })
    const normalizedLegacyCompilation = compileWorkflowGraph({
      graph: legacyGraph,
      projection: trusted,
    })
    expect(JSON.stringify(normalizedLegacyCompilation))
      .not.toMatch(/studio|transmute/u)
  })

  test("rejects reserved refs and cyclic authoring values", () => {
    const builder = PortableWorkflowBuilder.create()
    expect(() => {
      Reflect.apply(builder.diagram.check, undefined, ["reserved", {
        path: {
          $ref: {
            nodeKey: "forged",
            schemaId: "atet.operation.diagram.check.output/v2",
          },
          version: WORKFLOW_REF_VERSION,
        },
      }])
    }).toThrow(AtetCodeError)

    const cyclic: { path?: unknown } = {}
    cyclic.path = cyclic
    expect(() => {
      Reflect.apply(builder.diagram.check, undefined, ["cyclic", cyclic])
    }).toThrow(AtetCodeError)

    let enumeratedWideInput = false
    const wideInput = new Proxy(new Array<unknown>(1_000_001), {
      ownKeys: (target) => {
        enumeratedWideInput = true
        return Reflect.ownKeys(target)
      },
    })
    const wideError = captureCode(() => {
      Reflect.apply(builder.diagram.check, undefined, ["wide", { path: wideInput }])
    })
    expect(wideError.message).toContain("value limit")
    expect(enumeratedWideInput).toBe(false)
  })

  test("rejects enumerable symbol properties at every authoring container", () => {
    const symbol = Symbol("hidden")
    const inputBuilder = PortableWorkflowBuilder.create()
    const input = { path: "diagram.json" }
    Object.defineProperty(input, symbol, { enumerable: true, value: "hidden" })
    expect(() => inputBuilder.diagram.check("symbol-input", input))
      .toThrow("enumerable symbol")

    const builder = PortableWorkflowBuilder.create()
    const checked = builder.diagram.check("check", { path: "diagram.json" })
    const controls = [checked]
    Object.defineProperty(controls, symbol, { enumerable: true, value: checked })
    expect(() => builder.diagram.render(
      "symbol-control",
      { path: "diagram.json", scale: 1 },
      { after: controls },
    )).toThrow("enumerable symbol")

    const outputs = [checked]
    Object.defineProperty(outputs, symbol, { enumerable: true, value: checked })
    expect(() => builder.build({
      id: "symbol-output",
      inputSchemaId: "atet.workflow.symbol-output.input/v1",
      version: 1,
    }, outputs)).toThrow("enumerable symbol")
  })

  test("bounds typed reference paths and control dependencies while authoring", () => {
    const builder = PortableWorkflowBuilder.create()
    const checked = builder.diagram.check("check", { path: "diagram.json" })
    type ProjectableReference = {
      readonly serialized: {
        readonly $ref: { readonly path?: readonly (number | string)[] }
      }
      readonly select: (key: string) => ProjectableReference
    }
    let projected = checked as unknown as ProjectableReference
    for (let index = 0; index < MAX_SERIALIZED_REF_PATH_SEGMENTS; index += 1) {
      projected = projected.select("field")
    }
    expect(projected.serialized.$ref.path).toHaveLength(
      MAX_SERIALIZED_REF_PATH_SEGMENTS,
    )
    expect(() => projected.select("overflow")).toThrow("cannot exceed")

    let enumerated = false
    const excessiveControls = new Proxy(
      new Array<unknown>(MAX_SERIALIZED_NODE_DEPENDENCIES + 1),
      {
        ownKeys: (target) => {
          enumerated = true
          return Reflect.ownKeys(target)
        },
      },
    )
    const controlError = captureCode(() => {
      Reflect.apply(builder.diagram.render, undefined, [
        "render",
        { path: "diagram.json", scale: 1 },
        { after: excessiveControls },
      ])
    })
    expect(controlError.message).toContain("control dependencies")
    expect(enumerated).toBe(false)
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
                  schemaId: "atet.operation.diagram.render.output/v2",
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

    let enumeratedNodes = false
    const nodes = new Proxy([...graph.nodes], {
      ownKeys: (target) => {
        enumeratedNodes = true
        return Reflect.ownKeys(target)
      },
    })
    expect(() => compileWorkflowGraph({
      graph: { ...graph, nodes },
      limits: { maxNodes: 1 },
    })).toThrow("Workflow has 2 nodes; the limit is 1.")
    expect(enumeratedNodes).toBe(false)

    let getterExecuted = false
    const hostileLimits: Record<string, unknown> = {}
    Object.defineProperty(hostileLimits, "maxNodes", {
      enumerable: true,
      get: () => {
        getterExecuted = true
        return 1
      },
    })
    expect(() => compileWorkflowGraph({ graph, limits: hostileLimits }))
      .toThrow("plain data properties")
    expect(getterExecuted).toBe(false)
  })

  test("preflights hostile graph values before recursive schema parsing", () => {
    const graph = graphFixture()
    let graphPropertyReads = 0
    const graphProxy = new Proxy(graph, {
      get: (target, property, receiver) => {
        graphPropertyReads += 1
        return Reflect.get(target, property, receiver) as unknown
      },
    })
    expect(createWorkflowGraphHash(graphProxy)).toBe(createWorkflowGraphHash(graph))
    expect(graphPropertyReads).toBe(0)

    const cyclicOutputs: Record<string, unknown> = {}
    cyclicOutputs.self = cyclicOutputs
    const cyclic = captureCode(() => createWorkflowGraphHash({
      ...graph,
      outputs: cyclicOutputs,
    }))
    expect(cyclic.code).toBe("invalid-data")
    expect(cyclic.message).toContain("cyclic value")

    let nested: GraphInputValue = "leaf"
    for (let depth = 0; depth < 256; depth += 1) nested = [nested]
    const deeplyNested = captureCode(() => createWorkflowGraphHash({
      ...graph,
      nodes: graph.nodes.map((node, index) => index === 0
        ? { ...node, input: { nested } }
        : node),
    }))
    expect(deeplyNested.code).toBe("invalid-data")
    expect(deeplyNested.message).toContain("nesting exceeds")

    const accessorGraph = { ...graph }
    Object.defineProperty(accessorGraph, "nodes", {
      enumerable: true,
      get: () => {
        throw new Error("must not execute")
      },
    })
    const accessor = captureCode(() => createWorkflowGraphHash(accessorGraph))
    expect(accessor.code).toBe("invalid-data")
    expect(accessor.message).toContain("plain data properties")

    let enumeratedWideArray = false
    const wideArray = new Proxy(new Array<unknown>(1_100_001), {
      ownKeys: (target) => {
        enumeratedWideArray = true
        return Reflect.ownKeys(target)
      },
    })
    const wide = captureCode(() => createWorkflowGraphHash({
      ...graph,
      outputs: { wideArray },
    }))
    expect(wide.code).toBe("invalid-data")
    expect(wide.message).toContain("JSON values")
    expect(enumeratedWideArray).toBe(false)
  })

  test("preflights hostile compilation values before schema parsing or hashing", () => {
    const compilation = compileWorkflowGraph({ graph: graphFixture() })
    expect(createWorkflowCompilationHash(compilation))
      .toBe(compilation.compilationSha256)
    expect(parseCompiledWorkflowGraph(compilation).compilationSha256)
      .toBe(compilation.compilationSha256)

    expect(() => parseCompiledWorkflowGraph({
      ...compilation,
      unexpected: true,
    })).toThrow(AtetCodeError)
    expect(() => createWorkflowCompilationHash({
      ...compilation,
      unexpected: true,
    })).toThrow(AtetCodeError)
    const missingEnvelope: Record<string, unknown> = { ...compilation }
    Reflect.deleteProperty(missingEnvelope, "envelope")
    expect(() => parseCompiledWorkflowGraph(missingEnvelope))
      .toThrow(AtetCodeError)

    const inconsistentUnsigned = {
      envelope: { ...compilation.envelope, effects: [] },
      graph: compilation.graph,
      graphSha256: compilation.graphSha256,
      limits: compilation.limits,
      projection: compilation.projection,
      topologicalWaves: compilation.topologicalWaves,
      version: compilation.version,
    }
    const inconsistent = {
      ...inconsistentUnsigned,
      compilationSha256: createWorkflowCompilationHash(inconsistentUnsigned),
    }
    expect(() => parseCompiledWorkflowGraph(inconsistent))
      .toThrow("topology, requirements, or projection")

    const cyclic: Record<string, unknown> = { ...compilation }
    cyclic.hostile = cyclic
    for (const boundary of [
      createWorkflowCompilationHash,
      parseCompiledWorkflowGraph,
    ]) {
      const error = captureCode(() => boundary(cyclic))
      expect(error.code).toBe("invalid-data")
      expect(error.message).toContain("cyclic")
    }

    let nested: unknown = "leaf"
    for (let depth = 0; depth < 256; depth += 1) nested = { nested }
    const deeplyNested = { ...compilation, hostile: nested }
    for (const boundary of [
      createWorkflowCompilationHash,
      parseCompiledWorkflowGraph,
    ]) {
      const error = captureCode(() => boundary(deeplyNested))
      expect(error.code).toBe("invalid-data")
      expect(error.message).toContain("nesting exceeds")
    }

    let getterExecuted = false
    const accessorCompilation = { ...compilation }
    Object.defineProperty(accessorCompilation, "graph", {
      enumerable: true,
      get: () => {
        getterExecuted = true
        throw new Error("must not execute")
      },
    })
    for (const boundary of [
      createWorkflowCompilationHash,
      parseCompiledWorkflowGraph,
    ]) {
      const error = captureCode(() => boundary(accessorCompilation))
      expect(error.code).toBe("invalid-data")
      expect(error.message).toContain("plain data properties")
    }
    expect(getterExecuted).toBe(false)
  })

  test("verifies predecessor compilation hashes before canonical identity normalization", () => {
    const canonical = compileWorkflowGraph({ graph: graphFixture() })
    const legacyGraph = JSON.parse(
      JSON.stringify(canonical.graph)
        .replaceAll("atet-workflow-graph-v2", LEGACY_WORKFLOW_GRAPH_VERSION)
        .replaceAll("atet-workflow-ref-v1", LEGACY_WORKFLOW_REF_VERSION)
        .replaceAll("atet.operation.", "transmute.operation.")
        .replaceAll("atet.workflow.", "transmute.workflow.")
        .replaceAll("atet.diagram.", "transmute.diagram."),
    ) as AuthoredWorkflowGraphV1
    const legacyUnsigned = {
      envelope: {
        ...canonical.envelope,
        operationFamilies: canonical.envelope.operationFamilies.map(family => (
          family === "atet" ? "transmute" : family
        )),
        operationKinds: canonical.envelope.operationKinds.map(kind => (
          kind.replace(/^atet\./u, "transmute.")
        )),
        version: LEGACY_REQUIREMENT_ENVELOPE_VERSION,
      },
      graph: legacyGraph,
      graphSha256: "c6348ca6f5e8950bb84c5c19dcb7f6739d84c94daa6aeee409986407175cc212",
      limits: canonical.limits,
      projection: PUBLIC_TRANSMUTE_WORKFLOW_PROJECTION,
      topologicalWaves: canonical.topologicalWaves,
      version: LEGACY_WORKFLOW_COMPILATION_VERSION,
    }
    const legacy = {
      ...legacyUnsigned,
      compilationSha256: createWorkflowCompilationHash(legacyUnsigned),
    }

    const parsed = parseCompiledWorkflowGraph(legacy)
    expect(parsed).toEqual(canonical)
    expect(JSON.stringify(parsed)).not.toMatch(/studio|transmute/u)

    const tamperedUnsigned = {
      ...legacyUnsigned,
      graph: {
        ...legacyGraph,
        nodes: legacyGraph.nodes.map((node, index) => index === 0
          ? { ...node, label: "tampered after graph hashing" }
          : node),
      },
    }
    expect(() => parseCompiledWorkflowGraph({
      ...tamperedUnsigned,
      compilationSha256: createWorkflowCompilationHash(tamperedUnsigned),
    })).toThrow("graph hash does not match")
  })

  test("composes a near-authoring-depth graph into a bounded compilation", () => {
    const graph = graphFixture()
    let nested: GraphInputValue = "leaf"
    for (let depth = 0; depth < 120; depth += 1) nested = { nested }
    const deepGraph: AuthoredWorkflowGraphV1 = {
      ...graph,
      nodes: graph.nodes.map((node, index) => index === 0
        ? { ...node, input: { nested } }
        : node),
    }

    const compilation = compileWorkflowGraph({ graph: deepGraph })
    expect(createWorkflowCompilationHash(compilation))
      .toBe(compilation.compilationSha256)
    expect(parseCompiledWorkflowGraph(compilation).compilationSha256)
      .toBe(compilation.compilationSha256)
  })
})
