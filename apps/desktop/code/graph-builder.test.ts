import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { ApplicationError } from "../application/errors";
import type {
  OperationDefinition,
  OperationKind,
  OperationPolicy,
} from "../application/operation";
import { OperationRegistry } from "../application/registry";
import { WORKFLOW_REF_VERSION, type Ref } from "./contracts";
import {
  WorkflowGraphBuilder,
  defineWorkflowFragment,
  operationContract,
} from "./graph-builder";

const purePolicy = {
  cache: "content-addressed",
  cancellable: true,
  effect: "pure",
  maxDurationMs: 1_000,
  maxFanOut: 0,
  maxInputBytes: 1_024,
  maxOutputBytes: 1_024,
  preparation: [],
  resources: [{ amount: 1, resource: "cpu" }],
  resume: "deterministic",
} as const satisfies OperationPolicy;

function register<Kind extends OperationKind>(
  registry: OperationRegistry,
  kind: Kind,
  inputSchemaId: string,
  outputSchemaId: string,
): void {
  const definition: OperationDefinition<Kind, unknown, unknown> = {
    inputSchema: z.unknown(),
    inputSchemaId,
    kind,
    lifecycle: {
      kind: "pure",
      execute: () => Promise.reject(
        new Error("Graph construction must not execute operations."),
      ),
    },
    outputSchema: z.unknown(),
    outputSchemaId,
    policy: purePolicy,
    summarize: () => ({ fields: {}, kind }),
    version: 1,
  };
  registry.register(definition);
}

function registryFixture(): OperationRegistry {
  const registry = new OperationRegistry();
  register(
    registry,
    "project.snapshot",
    "test.project-snapshot-input/v1",
    "test.project-snapshot-output/v1",
  );
  register(
    registry,
    "analysis.faces",
    "test.faces-input/v1",
    "test.faces-output/v1",
  );
  register(
    registry,
    "analysis.music",
    "test.music-input/v1",
    "test.music-output/v1",
  );
  register(
    registry,
    "derive.edit-batch",
    "test.edit-input/v1",
    "test.edit-output/v1",
  );
  return registry;
}

describe("workflow graph builder", () => {
  test("exposes projection methods only for compatible static shapes", () => {
    const builder = WorkflowGraphBuilder.create(registryFixture());
    const scalar = builder.operationByKind<string>("scalar", {
      input: {},
      kind: "project.snapshot",
      version: 1,
    });
    const array = builder.operationByKind<readonly string[]>("array", {
      input: {},
      kind: "analysis.faces",
      version: 1,
    });
    const object = builder.operationByKind<{ readonly label: string }>(
      "object",
      {
        input: {},
        kind: "analysis.music",
        version: 1,
      },
    );
    const assertStaticProjectionTypes = (): void => {
      /* eslint-disable @typescript-eslint/no-unsafe-call --
       * These deliberately invalid calls are compile-time API assertions. */
      // @ts-expect-error Scalars do not support array projection.
      scalar.at(0);
      // @ts-expect-error Scalars do not support object projection.
      scalar.select("length");
      // @ts-expect-error Arrays do not expose implementation properties.
      array.select("length");
      // @ts-expect-error Objects do not support array projection.
      object.at(0);
      /* eslint-enable @typescript-eslint/no-unsafe-call */
    };
    void assertStaticProjectionTypes;
    expect(array.at(0).serialized.$ref.path).toEqual([0]);
    expect(object.select("label").serialized.$ref.path).toEqual(["label"]);
  });

  test("projects typed object and array fields while preserving producer identity", () => {
    const registry = registryFixture();
    const builder = WorkflowGraphBuilder.create(registry);
    const source = builder.operationByKind<{
      readonly items: readonly { readonly label: string }[];
    }>("source", {
      input: { value: "hello" },
      kind: "project.snapshot",
      version: 1,
    });
    const projected = source.select("items").at(0).select("label");
    builder.operationByKind("sink", {
      input: { value: projected },
      kind: "analysis.faces",
      version: 1,
    });
    const graph = builder.build({
      id: "projection-test",
      inputSchemaId: "test.projection-input/v1",
      version: 1,
    }, { projected });

    const sink = graph.nodes.find(node => node.key === "sink");
    expect(sink?.dependencies).toEqual(["source"]);
    expect(sink?.input).toEqual({
      value: {
        $ref: {
          nodeKey: "source",
          path: ["items", 0, "label"],
          schemaId: "test.project-snapshot-output/v1",
        },
        version: WORKFLOW_REF_VERSION,
      },
    });
  });

  test("adds explicit causal dependencies without threading output values", () => {
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
    const resumed = builder.operationByKind("resume", {
      input: {},
      kind: "analysis.music",
      version: 1,
    }, { after: [started, paused] });
    const stopped = builder.operationByKind("stop", {
      input: {},
      kind: "derive.edit-batch",
      version: 1,
    }, { after: resumed });
    const graph = builder.build({
      id: "causal-dependency-test",
      inputSchemaId: "test.causal-dependency-input/v1",
      version: 1,
    }, { stopped });

    expect(graph.nodes.map(node => ({
      controlDependencies: node.controlDependencies,
      dependencies: node.dependencies,
      key: node.key,
    }))).toEqual([
      {
        controlDependencies: ["start"],
        dependencies: ["start"],
        key: "pause",
      },
      {
        controlDependencies: ["pause", "start"],
        dependencies: ["pause", "start"],
        key: "resume",
      },
      { controlDependencies: [], dependencies: [], key: "start" },
      {
        controlDependencies: ["resume"],
        dependencies: ["resume"],
        key: "stop",
      },
    ]);

    const foreign = WorkflowGraphBuilder.create(registry).operationByKind(
      "foreign",
      {
        input: {},
        kind: "project.snapshot",
        version: 1,
      },
    );
    expect(() => builder.operationByKind("invalid", {
      input: {},
      kind: "analysis.faces",
      version: 1,
    }, { after: foreign })).toThrow(ApplicationError);
  });

  test("serializes typed refs, infers dependencies, and namespaces fragments", () => {
    const registry = registryFixture();
    const builder = WorkflowGraphBuilder.create(registry);
    const project = builder.operationByKind<{ readonly projectId: string }>("project", {
      input: { projectId: "project_builder" },
      kind: "project.snapshot",
      version: 1,
    });
    const analysisFragment = defineWorkflowFragment((
      fragmentBuilder,
      input: { readonly project: Ref<{ readonly projectId: string }> },
    ) => ({
      faces: fragmentBuilder.operationByKind<{ readonly tracks: number }>("faces", {
        input: { project: input.project },
        kind: "analysis.faces",
        version: 1,
      }),
      music: fragmentBuilder.operationByKind<{ readonly beats: number }>("music", {
        input: { project: input.project },
        kind: "analysis.music",
        version: 1,
      }),
    }));
    const analyses = builder.fragment("parallel", analysisFragment, { project });
    const edits = builder.operationByKind<{ readonly operations: number }>("edits", {
      input: {
        evidence: [analyses.music, analyses.faces],
      },
      kind: "derive.edit-batch",
      version: 1,
    });
    const graph = builder.build({
      id: "builder-test",
      inputSchemaId: "test.builder-input/v1",
      version: 1,
    }, {
      analyses,
      edits,
    });

    expect(graph.nodes.map(node => node.key)).toEqual([
      "edits",
      "parallel/faces",
      "parallel/music",
      "project",
    ]);
    expect(graph.nodes.find(node => node.key === "parallel/faces")?.dependencies)
      .toEqual(["project"]);
    expect(graph.nodes.find(node => node.key === "edits")?.dependencies)
      .toEqual(["parallel/faces", "parallel/music"]);
    expect(graph.outputs).toEqual({
      analyses: {
        faces: {
          $ref: { nodeKey: "parallel/faces", schemaId: "test.faces-output/v1" },
          version: WORKFLOW_REF_VERSION,
        },
        music: {
          $ref: { nodeKey: "parallel/music", schemaId: "test.music-output/v1" },
          version: WORKFLOW_REF_VERSION,
        },
      },
      edits: {
        $ref: { nodeKey: "edits", schemaId: "test.edit-output/v1" },
        version: WORKFLOW_REF_VERSION,
      },
    });
  });

  test("uses typed operation contracts without placing policy in authored nodes", () => {
    const registry = registryFixture();
    const builder = WorkflowGraphBuilder.create(registry);
    const contract = operationContract<
      { readonly projectId: string },
      { readonly projectId: string }
    >(registry, "project.snapshot", 1);
    const project = builder.operation("project", contract, {
      projectId: "project_typed",
    }, { label: "Open project" });
    const graph = builder.build({
      id: "typed-contract-test",
      inputSchemaId: "test.typed-contract-input/v1",
      version: 1,
    }, { project });

    expect(graph.nodes[0]).toEqual({
      controlDependencies: [],
      dependencies: [],
      input: { projectId: "project_typed" },
      inputSchemaId: "test.project-snapshot-input/v1",
      key: "project",
      label: "Open project",
      executor: {
        kind: "operation",
        operation: { kind: "project.snapshot", version: 1 },
      },
      outputSchemaId: "test.project-snapshot-output/v1",
    });
    expect("policy" in graph.nodes[0]!).toBe(false);
  });

  test("rejects duplicate namespace keys, forged refs, and cross-graph refs", () => {
    const registry = registryFixture();
    const builder = WorkflowGraphBuilder.create(registry);
    builder.operationByKind("node", {
      input: {},
      kind: "project.snapshot",
      version: 1,
    });
    expect(() => builder.operationByKind("node", {
      input: {},
      kind: "project.snapshot",
      version: 1,
    })).toThrow(ApplicationError);

    const forged = WorkflowGraphBuilder.create(registry);
    expect(() => forged.operationByKind("faces", {
      input: {
        project: {
          $ref: {
            nodeKey: "project",
            schemaId: "test.project-snapshot-output/v1",
          },
          version: WORKFLOW_REF_VERSION,
        },
      },
      kind: "analysis.faces",
      version: 1,
    })).toThrow(/typed Ref/u);

    const first = WorkflowGraphBuilder.create(registry);
    const firstProject = first.operationByKind("project", {
      input: {},
      kind: "project.snapshot",
      version: 1,
    });
    const second = WorkflowGraphBuilder.create(registry);
    expect(() => second.operationByKind("faces", {
      input: { project: firstProject },
      kind: "analysis.faces",
      version: 1,
    })).toThrow(/typed Ref/u);
  });

  test("rejects invalid namespace segments and unsupported operation versions", () => {
    const builder = WorkflowGraphBuilder.create(registryFixture());
    expect(() => builder.namespace("../escape")).toThrow();
    expect(() => builder.operationByKind("future", {
      input: {},
      kind: "project.snapshot",
      version: 99,
    })).toThrow(/Unsupported operation/u);
  });
});
