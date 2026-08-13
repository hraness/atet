import { expect } from "bun:test";
import { assertProperty, fc } from "../testing/property";
import { z } from "zod";

import { ApplicationError } from "../application/errors";
import type {
  OperationDefinition,
  OperationPolicy,
} from "../application/operation";
import { OperationRegistry } from "../application/registry";
import {
  WORKFLOW_REF_VERSION,
  type AuthoredWorkflowGraphV1,
  type Ref,
} from "./contracts";
import { compileGraphPlan } from "./compiler";
import { WorkflowGraphBuilder } from "./graph-builder";
import {
  TESTING_WORKFLOW_BUNDLE,
  TESTING_WORKFLOW_RUNTIME,
} from "./testing";

const policy = {
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

function registryFixture(): OperationRegistry {
  const registry = new OperationRegistry();
  const definition: OperationDefinition<
    "derive.edit-batch",
    unknown,
    unknown
  > = {
    inputSchema: z.unknown(),
    inputSchemaId: "test.property-input/v1",
    kind: "derive.edit-batch",
    lifecycle: {
      kind: "pure",
      execute: () => Promise.reject(
        new Error("Compilation must not execute operations."),
      ),
    },
    outputSchema: z.unknown(),
    outputSchemaId: "test.property-output/v1",
    policy,
    summarize: () => ({ fields: {}, kind: "derive.edit-batch" }),
    version: 1,
  };
  registry.register(definition);
  return registry;
}

function independentGraph(
  registry: OperationRegistry,
  constructionOrder: readonly string[],
): AuthoredWorkflowGraphV1 {
  const builder = WorkflowGraphBuilder.create(registry);
  const outputs: Record<string, Ref<{ readonly name: string }>> = {};
  for (const name of constructionOrder) {
    outputs[name] = builder.operationByKind(name, {
      input: { name },
      kind: "derive.edit-batch",
      version: 1,
    });
  }
  return builder.build({
    id: "construction-order-property",
    inputSchemaId: "test.construction-order-input/v1",
    version: 1,
  }, outputs);
}

function chainGraph(registry: OperationRegistry): AuthoredWorkflowGraphV1 {
  const builder = WorkflowGraphBuilder.create(registry);
  const source = builder.operationByKind<{ readonly value: number }>("source", {
    input: { value: 1 },
    kind: "derive.edit-batch",
    version: 1,
  });
  const target = builder.operationByKind<{ readonly value: number }>("target", {
    input: { source },
    kind: "derive.edit-batch",
    version: 1,
  });
  return builder.build({
    id: "invalid-input-property",
    inputSchemaId: "test.invalid-input/v1",
    version: 1,
  }, { target });
}

function compile(graph: unknown, registry: OperationRegistry) {
  return compileGraphPlan({
    bundle: TESTING_WORKFLOW_BUNDLE,
    graph,
    registry,
    runtime: TESTING_WORKFLOW_RUNTIME,
    workflowInput: {},
  });
}

const nodeNames: ("alpha" | "beta" | "delta" | "gamma")[] = [
  "alpha",
  "beta",
  "delta",
  "gamma",
];
const baselineRegistry = registryFixture();
const baselineHash = compile(
  independentGraph(baselineRegistry, nodeNames),
  baselineRegistry,
).graphPlanSha256;

assertProperty(fc.property(
  fc.shuffledSubarray(nodeNames, {
    maxLength: nodeNames.length,
    minLength: nodeNames.length,
  }),
  (constructionOrder) => {
    const registry = registryFixture();
    const plan = compile(independentGraph(registry, constructionOrder), registry);
    expect(plan.graph.nodes.map(node => node.key)).toEqual([...nodeNames].sort());
    expect(plan.topologicalWaves).toEqual([[...nodeNames].sort()]);
    expect(plan.graphPlanSha256).toBe(baselineHash);
  },
));

assertProperty(fc.property(
  fc.jsonValue(),
  (arbitraryInput) => {
    const registry = registryFixture();
    let error: unknown;
    try {
      compile(arbitraryInput, registry);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ApplicationError);
  },
));

assertProperty(fc.property(
  fc.constantFrom(
    "dependency-mismatch",
    "dangling",
    "duplicate",
    "policy",
    "schema-mismatch",
    "unknown-version",
  ),
  (corruption) => {
    const registry = registryFixture();
    const graph = structuredClone(chainGraph(registry));
    const source = graph.nodes.find(node => node.key === "source")!;
    const target = graph.nodes.find(node => node.key === "target")!;
    let invalidGraph: unknown = graph;
    switch (corruption) {
      case "dependency-mismatch":
        target.dependencies = [];
        break;
      case "dangling":
        target.input = {
          $ref: { nodeKey: "missing", schemaId: "test.property-output/v1" },
          version: WORKFLOW_REF_VERSION,
        };
        target.dependencies = ["missing"];
        break;
      case "duplicate":
        graph.nodes.push(structuredClone(source));
        break;
      case "policy": {
        const raw = structuredClone(graph) as unknown as {
          nodes: Record<string, unknown>[];
        };
        raw.nodes[0]!.policy = { effect: "pure" };
        invalidGraph = raw;
        break;
      }
      case "schema-mismatch":
        target.input = {
          $ref: { nodeKey: "source", schemaId: "test.wrong-output/v1" },
          version: WORKFLOW_REF_VERSION,
        };
        break;
      case "unknown-version":
        if (target.executor.kind === "operation") {
          target.executor.operation.version = 9_999;
        }
        break;
    }
    let firstMessage: string | undefined;
    let secondMessage: string | undefined;
    try {
      compile(invalidGraph, registry);
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      firstMessage = error instanceof Error ? error.message : String(error);
    }
    try {
      compile(structuredClone(invalidGraph), registry);
    } catch (error) {
      secondMessage = error instanceof Error ? error.message : String(error);
    }
    expect(firstMessage).toBeDefined();
    expect(secondMessage).toBe(firstMessage);
  },
));

assertProperty(fc.property(
  fc.string({ minLength: 1, maxLength: 40 }),
  fc.string({ minLength: 1, maxLength: 40 }),
  (left, right) => {
    fc.pre(left !== right);
    const registry = registryFixture();
    const builderLeft = WorkflowGraphBuilder.create(registry);
    const outputLeft = builderLeft.operationByKind("node", {
      input: { value: left },
      kind: "derive.edit-batch",
      version: 1,
    });
    const builderRight = WorkflowGraphBuilder.create(registry);
    const outputRight = builderRight.operationByKind("node", {
      input: { value: right },
      kind: "derive.edit-batch",
      version: 1,
    });
    const identity = {
      id: "semantic-input-property",
      inputSchemaId: "test.semantic-input/v1",
      version: 1,
    } as const;
    const leftPlan = compile(builderLeft.build(identity, { output: outputLeft }), registry);
    const rightPlan = compile(builderRight.build(identity, { output: outputRight }), registry);
    expect(leftPlan.graphPlanSha256).not.toBe(rightPlan.graphPlanSha256);
  },
));
