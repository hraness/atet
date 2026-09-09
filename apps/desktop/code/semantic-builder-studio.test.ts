import { expect, test } from "bun:test";
import { createApplicationOperationRegistry } from "../application";
import { studioOperationFixture } from "../application/operations/studio-test-support";
import { operationFileClaims } from "./file-candidate-provenance";
import { JsonValueSchema } from "./contracts";
import { WorkflowBuilder } from "./public";

test("studio authoring creates a closed operation with ordinary output references", () => {
  const workflow = WorkflowBuilder.create(createApplicationOperationRegistry());
  const { input } = studioOperationFixture();
  const produced = workflow.studio.run("native", { bundle: input.bundle, job: input.job });
  const graph = workflow.build({ id: "studio-graph", inputSchemaId: "test.studio.input/v1", version: 1 }, { outputs: produced.select("outputs"), receipt: produced.select("receipt") });
  expect(graph.nodes[0]).toMatchObject({ executor: { kind: "operation", operation: { kind: "atet.studio.run", version: 1 } }, outputSchemaId: "atet.operation.studio.run.output/v1" });
  expect(graph.outputs).toMatchObject({ receipt: { $ref: { nodeKey: "native", path: ["receipt"] } } });
  expect(graph.nodes[0]?.input).not.toHaveProperty("allowTrustedCode");
  expect(graph.nodes[0]?.input).not.toHaveProperty("runtimePath");
});

test("studio file authority includes only its retained explicit bundle manifest", () => {
  const { input } = studioOperationFixture();
  const claims = operationFileClaims("atet.studio.run", JsonValueSchema.parse(input));
  expect(claims).toHaveLength(1);
  expect(claims[0]).toMatchObject(input.bundle);
  expect(operationFileClaims("atet.studio.run", { job: { parameters: { path: "unrelated/private.txt" } }, outputs: [{ path: "future.step" }] })).toEqual([]);
});
