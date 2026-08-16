import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { ApplicationError } from "../application/errors";
import {
  OPERATION_KINDS,
  type OperationDefinition,
  type OperationKind,
  type OperationPolicy,
} from "../application/operation";
import { OperationRegistry } from "../application/registry";
import {
  CODE_WORKER_ABI,
  GRAPH_ABI,
  GRAPH_COMPILER_ABI,
  GRAPH_SCHEDULER_ABI,
  GRAPH_PLAN_VERSION,
  REQUIREMENT_ENVELOPE_VERSION,
  STATIC_BINDINGS_VERSION,
  WORKFLOW_GRAPH_VERSION,
  WORKFLOW_REF_VERSION,
  type AuthoredWorkflowGraphV1,
  type GraphCompilerLimits,
  type UnsignedGraphPlanV1,
  type WorkflowBundleIdentity,
  type WorkflowRuntimeIdentity,
} from "./contracts";
import {
  DEFAULT_GRAPH_COMPILER_LIMITS,
  compileGraphPlan,
  createGraphPlanHash,
  parseGraphPlan,
} from "./compiler";
import { defineCompute } from "./define-workflow";
import { WorkflowGraphBuilder } from "./graph-builder";

const ZERO_HASH = "0".repeat(64);
const ONE_HASH = "1".repeat(64);

const bundle = {
  bundleSha256: ZERO_HASH,
  bytes: 100,
  dependencyGraphSha256: ONE_HASH,
  entrypoint: "workflows/compiler-test.ts",
  sourceSha256: ZERO_HASH,
} satisfies WorkflowBundleIdentity;

const runtime = {
  applicationBuild: "atet-compiler-test",
  bunRevision: "compiler-test-revision",
  bunVersion: "1.3.14",
  bundlerConfigurationSha256: ZERO_HASH,
  bundlerName: "bun",
  bundlerRevision: "compiler-test-revision",
  bundlerVersion: "1.3.14",
  compilerAbi: GRAPH_COMPILER_ABI,
  codeWorkerAbi: CODE_WORKER_ABI,
  externals: {
    kind: "deny-all",
    modules: [],
    policySha256: ZERO_HASH,
  },
  graphAbi: GRAPH_ABI,
  schedulerAbi: GRAPH_SCHEDULER_ABI,
} satisfies WorkflowRuntimeIdentity;

function policy(
  override: Partial<OperationPolicy> = {},
): OperationPolicy {
  return {
    cache: "content-addressed",
    cancellable: true,
    effect: "pure",
    maxDurationMs: 1_000,
    maxFanOut: 0,
    maxInputBytes: 1_024,
    maxOutputBytes: 2_048,
    preparation: [],
    resources: [{ amount: 1, resource: "cpu" }],
    resume: "deterministic",
    ...override,
  };
}

function register<Kind extends OperationKind>(
  registry: OperationRegistry,
  kind: Kind,
  inputSchemaId: string,
  outputSchemaId: string,
  operationPolicy: OperationPolicy,
  onExecute: () => void,
): void {
  const definition: OperationDefinition<Kind, unknown, unknown> = {
    inputSchema: z.unknown(),
    inputSchemaId,
    kind,
    lifecycle: {
      kind: "pure",
      execute: () => {
        onExecute();
        return Promise.resolve({});
      },
    },
    outputSchema: z.unknown(),
    outputSchemaId,
    policy: operationPolicy,
    summarize: () => ({ fields: {}, kind }),
    version: 1,
  };
  registry.register(definition);
}

function registryFixture(
  onExecute: () => void = () => {},
  reverse = false,
): OperationRegistry {
  const registry = new OperationRegistry();
  const definitions = [
    {
      inputSchemaId: "test.snapshot-input/v1",
      kind: "project.snapshot" as const,
      outputSchemaId: "test.snapshot-output/v1",
      policy: policy({
        effect: "local-read",
        preparation: ["project-state"],
        resources: [{ amount: 1, resource: "local-io" }],
        resume: "verified-receipt",
      }),
    },
    {
      inputSchemaId: "test.faces-input/v1",
      kind: "analysis.faces" as const,
      outputSchemaId: "test.faces-output/v1",
      policy: policy({
        effect: "local-read",
        maxFanOut: 4,
        preparation: ["local-media"],
        resources: [{ amount: 1, resource: "vision" }],
        resume: "verified-receipt",
      }),
    },
    {
      inputSchemaId: "test.music-input/v1",
      kind: "analysis.music" as const,
      outputSchemaId: "test.music-output/v1",
      policy: policy({
        effect: "local-read",
        maxFanOut: 4,
        preparation: ["local-media"],
        resources: [{ amount: 1, resource: "whisper" }],
        resume: "verified-receipt",
      }),
    },
    {
      inputSchemaId: "test.edits-input/v1",
      kind: "derive.edit-batch" as const,
      outputSchemaId: "test.edits-output/v1",
      policy: policy(),
    },
  ];
  if (reverse) definitions.reverse();
  for (const definition of definitions) {
    register(
      registry,
      definition.kind,
      definition.inputSchemaId,
      definition.outputSchemaId,
      definition.policy,
      onExecute,
    );
  }
  return registry;
}

function graphFixture(
  registry: OperationRegistry,
  siblingOrder: readonly ("faces" | "music")[] = ["faces", "music"],
): AuthoredWorkflowGraphV1 {
  const builder = WorkflowGraphBuilder.create(registry);
  const source = builder.operationByKind<{ readonly projectId: string }>("source", {
    input: { projectId: "project_compiler" },
    kind: "project.snapshot",
    version: 1,
  });
  const references: {
    faces?: ReturnType<typeof builder.operationByKind<{ readonly tracks: number }>>;
    music?: ReturnType<typeof builder.operationByKind<{ readonly beats: number }>>;
  } = {};
  for (const sibling of siblingOrder) {
    if (sibling === "faces") {
      references.faces = builder.namespace("analysis").operationByKind("faces", {
        input: { project: source },
        kind: "analysis.faces",
        version: 1,
      });
    } else {
      references.music = builder.namespace("analysis").operationByKind("music", {
        input: { project: source },
        kind: "analysis.music",
        version: 1,
      });
    }
  }
  if (references.faces === undefined || references.music === undefined) {
    throw new Error("Compiler fixture requires both analysis nodes.");
  }
  const edits = builder.operationByKind<{ readonly operations: number }>("edits", {
    input: {
      faces: references.faces,
      music: references.music,
    },
    kind: "derive.edit-batch",
    version: 1,
  });
  return builder.build({
    id: "compiler-test",
    inputSchemaId: "test.compiler-input/v1",
    version: 1,
  }, { edits });
}

function compile(
  graph: unknown,
  registry = registryFixture(),
  limits?: Partial<GraphCompilerLimits>,
) {
  return compileGraphPlan({
    bundle,
    graph,
    ...(limits === undefined ? {} : { limits }),
    registry,
    runtime,
    staticBindings: {
      candidates: [{
        bytes: 10,
        descriptorSha256: ZERO_HASH,
        id: "input.mov",
        kind: "file",
        mediaType: "video/quicktime",
        sha256: ONE_HASH,
      }],
      initialSubjects: [{
        descriptorSha256: ZERO_HASH,
        id: "project_compiler",
        kind: "project",
        planSha256: ONE_HASH,
        projectSha256: ZERO_HASH,
      }],
      version: STATIC_BINDINGS_VERSION,
    },
    workflowInput: { projectId: "project_compiler" },
  });
}

describe("workflow graph compiler", () => {
  test("derives trusted-code policy for schema-bound compute nodes", () => {
    const registry = new OperationRegistry();
    const builder = WorkflowGraphBuilder.create(registry);
    const compute = defineCompute({
      inputSchema: z.strictObject({ values: z.array(z.number()).max(8) }),
      inputSchemaId: "test.compute-rank-input/v1",
      key: "test.rank",
      maxDurationMs: 2_000,
      maxInputBytes: 4_096,
      maxOutputBytes: 2_048,
      outputSchema: z.strictObject({ best: z.number() }),
      outputSchemaId: "test.compute-rank-output/v1",
      run: input => ({ best: Math.max(...input.values) }),
    });
    const output = builder.compute("rank", compute, { values: [3, 1, 2] });
    const graph = builder.build({
      id: "compute-compiler",
      inputSchemaId: "test.compute-compiler-input/v1",
      version: 1,
    }, { output });
    const plan = compileGraphPlan({
      bundle,
      graph,
      registry,
      runtime,
      workflowInput: {},
    });
    expect(plan.envelope).toMatchObject({
      computeKeys: ["test.rank"],
      effects: ["trusted-code"],
      operationFamilies: ["compute"],
      operationKinds: [],
      resumeClasses: ["explicit-code-replay"],
      resources: [{ amount: 1, resource: "cpu" }],
    });
    expect(plan.graph.nodes[0]?.executor).toMatchObject({
      compute: { key: "test.rank" },
      kind: "compute",
    });
  });

  test("derives the Atet family for visual media operations", () => {
    const registry = new OperationRegistry();
    register(
      registry,
      "atet.diagram.check",
      "test.atet-diagram-check-input/v1",
      "test.atet-diagram-check-output/v1",
      policy({
        cancellable: false,
        effect: "local-read",
        preparation: ["local-media"],
        resources: [{ amount: 1, resource: "local-io" }],
      }),
      () => {},
    );
    const builder = WorkflowGraphBuilder.create(registry);
    const checked = builder.operationByKind("check", {
      input: { path: "fixtures/system.diagram.json" },
      kind: "atet.diagram.check",
      version: 1,
    });
    const graph = builder.build({
      id: "atet-visual-compiler",
      inputSchemaId: "test.atet-visual-compiler-input/v1",
      version: 1,
    }, { checked });

    const plan = compileGraphPlan({
      bundle,
      graph,
      registry,
      runtime,
      workflowInput: {},
    });

    expect(plan.envelope).toMatchObject({
      effects: ["local-read"],
      operationFamilies: ["atet"],
      operationKinds: ["atet.diagram.check"],
      preparation: ["local-media"],
      resources: [{ amount: 1, resource: "local-io" }],
    });
  });

  test("produces deterministic topological waves and host-derived requirements", () => {
    let executions = 0;
    const registry = registryFixture(() => {
      executions += 1;
    });
    const plan = compile(graphFixture(registry), registry);

    expect(executions).toBe(0);
    expect(plan.topologicalWaves).toEqual([
      ["source"],
      ["analysis/faces", "analysis/music"],
      ["edits"],
    ]);
    expect(plan.envelope).toMatchObject({
      bounds: {
        depth: 3,
        edges: 4,
        nodes: 4,
        structuralFanOut: 2,
        totalOperationFanOut: 8,
      },
      effects: ["local-read", "pure"],
      operationFamilies: ["analysis", "derive", "project"],
      operationKinds: [
        "analysis.faces",
        "analysis.music",
        "derive.edit-batch",
        "project.snapshot",
      ],
      preparation: ["local-media", "project-state"],
      resources: [
        { amount: 1, resource: "cpu" },
        { amount: 1, resource: "local-io" },
        { amount: 1, resource: "vision" },
        { amount: 1, resource: "whisper" },
      ],
      unresolved: ["dependency-outputs", "exact-media-hashes"],
    });
    expect(parseGraphPlan(JSON.parse(JSON.stringify(plan)) as unknown)).toEqual(plan);
  });

  test("validates explicit causal dependencies independently from data references", () => {
    const registry = registryFixture();
    const builder = WorkflowGraphBuilder.create(registry);
    const started = builder.operationByKind("start", {
      input: {},
      kind: "project.snapshot",
      version: 1,
    });
    const paused = builder.operationByKind("pause", {
      input: {},
      kind: "analysis.faces",
      version: 1,
    }, { after: started });
    const graph = builder.build({
      id: "control-dependency-compiler",
      inputSchemaId: "test.control-dependency-compiler-input/v1",
      version: 1,
    }, { paused });
    const plan = compile(graph, registry);

    expect(plan.topologicalWaves).toEqual([["start"], ["pause"]]);
    expect(plan.graph.nodes.find(node => node.key === "pause")).toMatchObject({
      controlDependencies: ["start"],
      dependencies: ["start"],
      input: {},
    });

    const missingDeclaration = structuredClone(graph);
    missingDeclaration.nodes.find(node => node.key === "pause")!
      .controlDependencies = [];
    expect(() => compile(missingDeclaration, registry)).toThrow(
      /dependencies do not match/u,
    );

    const danglingControl = structuredClone(graph);
    const danglingNode = danglingControl.nodes.find(node => node.key === "pause")!;
    danglingNode.controlDependencies = ["missing"];
    danglingNode.dependencies = ["missing"];
    expect(() => compile(danglingControl, registry)).toThrow(
      /dangling control dependency/u,
    );
  });

  test("normalizes node, sibling, registry, and binding construction order", () => {
    const forwardRegistry = registryFixture();
    const reverseRegistry = registryFixture(undefined, true);
    const forward = compile(graphFixture(forwardRegistry, ["faces", "music"]), forwardRegistry);
    const reverse = compile(graphFixture(reverseRegistry, ["music", "faces"]), reverseRegistry);

    expect(reverse.graph).toEqual(forward.graph);
    expect(reverse.registry).toEqual(forward.registry);
    expect(reverse.topologicalWaves).toEqual(forward.topologicalWaves);
    expect(reverse.graphPlanSha256).toBe(forward.graphPlanSha256);
  });

  test("rejects duplicate, dangling, mismatched, cyclic, and unsupported nodes", () => {
    const registry = registryFixture();
    const base = graphFixture(registry);

    const duplicate = structuredClone(base);
    duplicate.nodes.push(structuredClone(duplicate.nodes[0]!));
    expect(() => compile(duplicate, registry)).toThrow(/Duplicate workflow node key/u);

    const dangling = structuredClone(base);
    const danglingFaces = dangling.nodes.find(node => node.key === "analysis/faces")!;
    danglingFaces.input = {
      $ref: { nodeKey: "missing", schemaId: "test.snapshot-output/v1" },
      version: WORKFLOW_REF_VERSION,
    };
    danglingFaces.dependencies = ["missing"];
    expect(() => compile(dangling, registry)).toThrow(/dangling reference/u);

    const mismatched = structuredClone(base);
    const mismatchedFaces = mismatched.nodes.find(node => node.key === "analysis/faces")!;
    mismatchedFaces.input = {
      $ref: { nodeKey: "source", schemaId: "test.wrong-output/v1" },
      version: WORKFLOW_REF_VERSION,
    };
    mismatchedFaces.dependencies = ["source"];
    expect(() => compile(mismatched, registry)).toThrow(/expects schema/u);

    const dependencyMismatch = structuredClone(base);
    dependencyMismatch.nodes.find(node => node.key === "analysis/faces")!.dependencies = [];
    expect(() => compile(dependencyMismatch, registry)).toThrow(/do not match/u);

    const cycle = structuredClone(base);
    const source = cycle.nodes.find(node => node.key === "source")!;
    source.input = {
      $ref: { nodeKey: "edits", schemaId: "test.edits-output/v1" },
      version: WORKFLOW_REF_VERSION,
    };
    source.dependencies = ["edits"];
    expect(() => compile(cycle, registry)).toThrow(/dependency cycle/u);

    const unsupported = structuredClone(base);
    const unsupportedNode = unsupported.nodes[0]!;
    if (unsupportedNode.executor.kind === "operation") {
      unsupportedNode.executor.operation.version = 99;
    }
    expect(() => compile(unsupported, registry)).toThrow(/Unsupported operation/u);

    const unknownSchema = structuredClone(base);
    unknownSchema.nodes[0]!.outputSchemaId = "test.unknown-output/v1";
    expect(() => compile(unknownSchema, registry)).toThrow(/schema identity mismatch/u);
  });

  test("rejects output reference failures and authored policy metadata", () => {
    const registry = registryFixture();
    const danglingOutput = structuredClone(graphFixture(registry));
    danglingOutput.outputs = {
      $ref: { nodeKey: "missing", schemaId: "test.edits-output/v1" },
      version: WORKFLOW_REF_VERSION,
    };
    expect(() => compile(danglingOutput, registry)).toThrow(/dangling reference/u);

    const mismatchedOutput = structuredClone(graphFixture(registry));
    mismatchedOutput.outputs = {
      $ref: { nodeKey: "edits", schemaId: "test.wrong-output/v1" },
      version: WORKFLOW_REF_VERSION,
    };
    expect(() => compile(mismatchedOutput, registry)).toThrow(/expects schema/u);

    const authoredPolicy = structuredClone(graphFixture(registry)) as unknown as {
      nodes: Record<string, unknown>[];
    };
    authoredPolicy.nodes[0]!.policy = { effect: "pure" };
    expect(() => compile(authoredPolicy, registry)).toThrow(/Invalid authored workflow graph/u);
  });

  test("enforces node, edge, depth, structural fan-out, and operation fan-out limits", () => {
    const registry = registryFixture();
    const graph = graphFixture(registry);
    const cases: readonly [Partial<GraphCompilerLimits>, RegExp][] = [
      [{ maxNodes: 3 }, /4 nodes/u],
      [{ maxEdges: 3 }, /4 edges/u],
      [{ maxDepth: 2 }, /depth is 3/u],
      [{ maxFanOut: 1 }, /fan-out is 2/u],
      [{ maxTotalOperationFanOut: 7 }, /fan-out bound is 8/u],
    ];
    for (const [limits, message] of cases) {
      expect(() => compile(graph, registry, {
        ...DEFAULT_GRAPH_COMPILER_LIMITS,
        ...limits,
      })).toThrow(message);
    }
  });

  test("domain-separated plan hash covers runtime, bundle, input, output, registry, and envelope", () => {
    const plan = compile(graphFixture(registryFixture()));
    const {
      graphPlanSha256,
      ...unsigned
    } = plan;
    expect(createGraphPlanHash(unsigned)).toBe(graphPlanSha256);

    const variants: UnsignedGraphPlanV1[] = [
      {
        ...unsigned,
        runtime: { ...unsigned.runtime, applicationBuild: "different-build" },
      },
      {
        ...unsigned,
        bundle: { ...unsigned.bundle, sourceSha256: ONE_HASH },
      },
      {
        ...unsigned,
        workflowInput: { projectId: "project_other" },
      },
      {
        ...unsigned,
        graph: {
          ...unsigned.graph,
          outputs: {
            $ref: {
              nodeKey: "analysis/faces",
              schemaId: "test.faces-output/v1",
            },
            version: WORKFLOW_REF_VERSION,
          },
        },
      },
      {
        ...unsigned,
        registry: {
          discovery: unsigned.registry.discovery.map((operation, index) => (
            index === 0
              ? {
                ...operation,
                policy: {
                  ...operation.policy,
                  maxDurationMs: operation.policy.maxDurationMs + 1,
                },
              }
              : operation
          )),
        },
      },
      {
        ...unsigned,
        envelope: {
          ...unsigned.envelope,
          bounds: {
            ...unsigned.envelope.bounds,
            maxDurationMs: unsigned.envelope.bounds.maxDurationMs + 1,
          },
        },
      },
    ];
    const hashes = variants.map(createGraphPlanHash);
    expect(new Set(hashes).size).toBe(variants.length);
    expect(hashes).not.toContain(graphPlanSha256);

    expect(() => parseGraphPlan({
      ...plan,
      runtime: { ...plan.runtime, applicationBuild: "tampered" },
    })).toThrow(ApplicationError);

    const forgedEnvelope = {
      ...unsigned,
      envelope: {
        ...unsigned.envelope,
        effects: [],
        operationKinds: [],
      },
    } satisfies UnsignedGraphPlanV1;
    expect(() => parseGraphPlan({
      ...forgedEnvelope,
      graphPlanSha256: createGraphPlanHash(forgedEnvelope),
    })).toThrow(/requirements/u);

    const forgedTopology = {
      ...unsigned,
      topologicalWaves: [["source"]],
    } satisfies UnsignedGraphPlanV1;
    expect(() => parseGraphPlan({
      ...forgedTopology,
      graphPlanSha256: createGraphPlanHash(forgedTopology),
    })).toThrow(/topology/u);
  });

  test("verifies Studio plan hashes before coherent Atet normalization and rejects retired runtime ABIs", () => {
    const canonical = compile(graphFixture(registryFixture()));
    const legacy = JSON.parse(
      JSON.stringify(canonical)
        .replaceAll("atet-workflow-graph-v2", "studio-workflow-graph-v2")
        .replaceAll("atet-workflow-ref-v1", "studio-workflow-ref-v1")
        .replaceAll("atet-requirement-envelope-v2", "studio-requirement-envelope-v2")
        .replaceAll("atet-workflow-graph-abi-v2", "studio-workflow-graph-abi-v2")
        .replaceAll("atet-compiler-test", "studio-compiler-test")
        .replaceAll("test.snapshot-input/v1", "studio.operation.project.snapshot.input/v1")
        .replaceAll("test.snapshot-output/v1", "studio.operation.project.snapshot.output/v1")
        .replaceAll("test.faces-input/v1", "studio.operation.analysis.faces.input/v1")
        .replaceAll("test.faces-output/v1", "studio.operation.analysis.faces.output/v1")
        .replaceAll("test.music-input/v1", "studio.operation.analysis.music.input/v1")
        .replaceAll("test.music-output/v1", "studio.operation.analysis.music.output/v1")
        .replaceAll("test.edits-input/v1", "studio.operation.derive.edit-batch.input/v1")
        .replaceAll("test.edits-output/v1", "studio.operation.derive.edit-batch.output/v1"),
    ) as typeof canonical;
    const { graphPlanSha256: ignoredGraphPlanSha256, ...legacyUnsigned } = legacy;
    void ignoredGraphPlanSha256;
    const authenticatedLegacy = {
      ...legacyUnsigned,
      graphPlanSha256: createGraphPlanHash(legacyUnsigned),
    };

    const parsed = parseGraphPlan(authenticatedLegacy);
    expect(parsed.version).toBe(GRAPH_PLAN_VERSION);
    expect(parsed.graph.version).toBe(WORKFLOW_GRAPH_VERSION);
    expect(parsed.envelope.version).toBe(REQUIREMENT_ENVELOPE_VERSION);
    expect(parsed.runtime).toMatchObject({
      applicationBuild: "atet-compiler-test",
      codeWorkerAbi: CODE_WORKER_ABI,
      compilerAbi: GRAPH_COMPILER_ABI,
      graphAbi: GRAPH_ABI,
      schedulerAbi: GRAPH_SCHEDULER_ABI,
    });
    expect(parsed.staticBindings.version).toBe(STATIC_BINDINGS_VERSION);
    expect(parsed.registry.discovery.every(discovery => (
      discovery.inputSchemaId.startsWith("atet.operation.")
      && discovery.outputSchemaId.startsWith("atet.operation.")
    ))).toBe(true);
    expect(parsed.graph.nodes.every(node => (
      node.executor.kind !== "operation"
      || OPERATION_KINDS.includes(node.executor.operation.kind as OperationKind)
    ))).toBe(true);

    for (const [field, value] of [
      ["codeWorkerAbi", "retired-code-worker-abi"],
      ["compilerAbi", "retired-compiler-abi"],
      ["schedulerAbi", "retired-scheduler-abi"],
    ] as const) {
      expect(() => parseGraphPlan({
        ...canonical,
        runtime: { ...canonical.runtime, [field]: value },
      })).toThrow(ApplicationError);
    }

    expect(() => parseGraphPlan({
      ...authenticatedLegacy,
      runtime: {
        ...authenticatedLegacy.runtime,
        applicationBuild: "retired-tampered",
      },
    })).toThrow("hash does not match");
    const forgedLegacyUnsigned = {
      ...legacyUnsigned,
      envelope: { ...legacyUnsigned.envelope, effects: [] },
    };
    expect(() => parseGraphPlan({
      ...forgedLegacyUnsigned,
      graphPlanSha256: createGraphPlanHash(forgedLegacyUnsigned),
    })).toThrow(/requirements/u);
  });
});
