import { describe, expect, test } from "bun:test";

import {
  AuthoredWorkflowGraphV1Schema,
  GraphInputValueSchema,
  JsonValueSchema,
  SerializedRefV1Schema,
  WORKFLOW_GRAPH_VERSION,
  WORKFLOW_REF_VERSION,
} from "./contracts";

const validReference = {
  $ref: {
    nodeKey: "analysis/faces",
    schemaId: "studio.analysis.faces-output/v1",
  },
  version: WORKFLOW_REF_VERSION,
} as const;

function validGraph(): unknown {
  return {
    nodes: [{
      dependencies: [],
      input: { projectId: "project_contracts" },
      inputSchemaId: "studio.project.snapshot-input/v1",
      key: "project",
      executor: {
        kind: "operation",
        operation: {
          kind: "project.snapshot",
          version: 1,
        },
      },
      outputSchemaId: "studio.project.snapshot-output/v1",
    }, {
      dependencies: ["project"],
      input: {
        project: {
          $ref: {
            nodeKey: "project",
            schemaId: "studio.project.snapshot-output/v1",
          },
          version: WORKFLOW_REF_VERSION,
        },
      },
      inputSchemaId: "studio.analysis.faces-input/v1",
      key: "analysis/faces",
      executor: {
        kind: "operation",
        operation: {
          kind: "analysis.faces",
          version: 1,
        },
      },
      outputSchemaId: "studio.analysis.faces-output/v1",
    }],
    outputs: { faces: validReference },
    version: WORKFLOW_GRAPH_VERSION,
    workflow: {
      id: "contracts-test",
      inputSchemaId: "studio.workflow.contracts-test-input/v1",
      version: 1,
    },
  };
}

describe("workflow graph contracts", () => {
  test("round-trips a strict versioned graph and explicit schema-bound references", () => {
    const graph = AuthoredWorkflowGraphV1Schema.parse(validGraph());
    expect(graph.version).toBe(WORKFLOW_GRAPH_VERSION);
    expect(graph.outputs).toEqual({ faces: validReference });
    expect(SerializedRefV1Schema.parse(validReference)).toEqual(validReference);
    expect(AuthoredWorkflowGraphV1Schema.parse(
      JSON.parse(JSON.stringify(graph)) as unknown,
    )).toEqual(graph);
  });

  test("rejects policy metadata at every authored graph ownership boundary", () => {
    const graphWithNodePolicy = structuredClone(validGraph()) as {
      nodes: Record<string, unknown>[];
    };
    graphWithNodePolicy.nodes[0]!.policy = { effect: "pure" };
    expect(() => AuthoredWorkflowGraphV1Schema.parse(graphWithNodePolicy)).toThrow();

    const graphWithOperationPolicy = structuredClone(validGraph()) as {
      nodes: { executor: { operation: Record<string, unknown> } }[];
    };
    graphWithOperationPolicy.nodes[0]!.executor.operation.policy = { effect: "pure" };
    expect(() => AuthoredWorkflowGraphV1Schema.parse(graphWithOperationPolicy)).toThrow();

    const graphWithTopLevelPolicy = {
      ...(validGraph() as Record<string, unknown>),
      policy: { allowPaidCalls: true },
    };
    expect(() => AuthoredWorkflowGraphV1Schema.parse(graphWithTopLevelPolicy)).toThrow();
  });

  test("rejects unknown versions and malformed or ambiguous reference objects", () => {
    expect(() => SerializedRefV1Schema.parse({
      ...validReference,
      policy: {},
    })).toThrow();
    expect(() => SerializedRefV1Schema.parse({
      ...validReference,
      version: "transmute-workflow-ref-v2",
    })).toThrow();

    const malformedReference = structuredClone(validGraph()) as {
      nodes: { input: Record<string, unknown> }[];
    };
    malformedReference.nodes[1]!.input.project = {
      $ref: { nodeKey: "project" },
      version: WORKFLOW_REF_VERSION,
    };
    expect(() => AuthoredWorkflowGraphV1Schema.parse(malformedReference)).toThrow();

    expect(() => AuthoredWorkflowGraphV1Schema.parse({
      ...(validGraph() as Record<string, unknown>),
      version: "transmute-workflow-graph-v999",
    })).toThrow();
  });

  test("rejects unsafe node keys and non-JSON node inputs", () => {
    const unsafeKey = structuredClone(validGraph()) as {
      nodes: { key: string }[];
    };
    unsafeKey.nodes[0]!.key = "../project";
    expect(() => AuthoredWorkflowGraphV1Schema.parse(unsafeKey)).toThrow();

    const nonFinite = structuredClone(validGraph()) as {
      nodes: { input: unknown }[];
    };
    nonFinite.nodes[0]!.input = { duration: Number.POSITIVE_INFINITY };
    expect(() => AuthoredWorkflowGraphV1Schema.parse(nonFinite)).toThrow();
  });

  test("rejects reserved prototype keys instead of silently dropping JSON data", () => {
    const value = JSON.parse(
      "{\"__proto__\":{\"polluted\":true},\"safe\":2}",
    ) as unknown;
    expect(JsonValueSchema.safeParse(value).success).toBe(false);
    expect(GraphInputValueSchema.safeParse(value).success).toBe(false);
  });
});
