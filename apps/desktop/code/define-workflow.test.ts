import { describe, expect, test } from "bun:test";
import { z } from "zod";

import type {
  OperationDefinition,
  OperationPolicy,
} from "../application/operation";
import { OperationRegistry } from "../application/registry";
import {
  buildWorkflow,
  buildWorkflowRuntime,
  defineCompute,
  defineWorkflow,
  seconds,
} from "./define-workflow";

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
    "project.snapshot",
    { readonly projectId: string },
    { readonly projectId: string }
  > = {
    inputSchema: z.strictObject({ projectId: z.string() }),
    inputSchemaId: "test.workflow-project-input/v1",
    kind: "project.snapshot",
    lifecycle: {
      kind: "pure",
      execute: (_context, input) => Promise.resolve(input),
    },
    outputSchema: z.strictObject({ projectId: z.string() }),
    outputSchemaId: "test.workflow-project-output/v1",
    policy,
    summarize: output => ({
      fields: { projectId: output.projectId },
      kind: "project.snapshot",
    }),
    version: 1,
  };
  registry.register(definition);
  return registry;
}

describe("workflow definitions", () => {
  test("parses input before constructing a graph", () => {
    let buildCount = 0;
    const workflow = defineWorkflow({
      build(builder, input: { readonly projectId: string }) {
        buildCount += 1;
        const project = builder.operation("project", {
          inputSchemaId: "test.workflow-project-input/v1",
          kind: "project.snapshot",
          outputSchemaId: "test.workflow-project-output/v1",
          version: 1,
        }, input);
        return { project };
      },
      id: "definition-test",
      inputSchema: z.strictObject({ projectId: z.string().min(1) }),
      inputSchemaId: "test.definition-input/v1",
      version: 1,
    });

    expect(() => buildWorkflow(workflow, registryFixture(), { projectId: "" })).toThrow();
    expect(buildCount).toBe(0);

    const built = buildWorkflow(workflow, registryFixture(), {
      projectId: "project_definition",
    });
    expect(buildCount).toBe(1);
    expect(built.input).toEqual({ projectId: "project_definition" });
    expect(built.graph.workflow).toEqual({
      id: "definition-test",
      inputSchemaId: "test.definition-input/v1",
      version: 1,
    });
  });

  test("requires workflow input schema output to remain JSON-safe", () => {
    const workflow = defineWorkflow({
      build() {
        throw new Error("Invalid input must fail before build.");
      },
      id: "json-input-test",
      inputSchema: z.date(),
      inputSchemaId: "test.json-input/v1",
      version: 1,
    });
    expect(() => buildWorkflow(workflow, registryFixture(), new Date(0))).toThrow();
  });

  test("converts exact seconds to integer microseconds", () => {
    expect(seconds(0)).toBe(0);
    expect(seconds(0.9)).toBe(900_000);
    expect(seconds(3)).toBe(3_000_000);
    expect(() => seconds(-1)).toThrow();
    expect(() => seconds(1 / 3)).toThrow();
  });

  test("registers schema-bound compute callbacks without serializing functions", () => {
    const decorate = defineCompute({
      inputSchema: z.strictObject({ value: z.string() }),
      inputSchemaId: "test.decorate-input/v1",
      key: "test.decorate",
      outputSchema: z.strictObject({ value: z.string() }),
      outputSchemaId: "test.decorate-output/v1",
      run: input => ({ value: `${input.value}!` }),
    });
    const workflow = defineWorkflow({
      build(builder, input: { readonly value: string }) {
        return { value: builder.compute("decorate", decorate, input) };
      },
      id: "compute-definition-test",
      inputSchema: z.strictObject({ value: z.string() }),
      inputSchemaId: "test.compute-workflow-input/v1",
      version: 1,
    });
    const built = buildWorkflowRuntime(
      workflow,
      registryFixture(),
      { value: "hello" },
    );
    expect(built.computeDefinitions).toEqual([decorate]);
    expect(built.graph.nodes[0]).toMatchObject({
      executor: {
        compute: {
          key: "test.decorate",
          version: 1,
        },
        kind: "compute",
      },
    });
    expect(JSON.stringify(built.graph)).not.toContain("run");
    expect(() => defineCompute({
      ...decorate,
      key: "test.too-large",
      maxOutputBytes: 3 * 1024 * 1024,
    })).toThrow();
  });
});
