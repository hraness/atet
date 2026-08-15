import type { z } from "zod";
import {
  defineCompute,
  seconds,
  type DefineComputeOptions,
} from "@hraness/atet/code/advanced";

import { ApplicationError } from "../application/errors";
import {
  JsonValueSchema,
  SchemaIdSchema,
  WorkflowIdSchema,
  type AuthoredWorkflowGraphV1,
  type AnyTrustedComputeDefinition,
  type JsonValue,
  type WorkflowOutputValue,
} from "./contracts";
import type { OperationDiscoverySource } from "./graph-builder";
import { WorkflowBuilder } from "./semantic-builder";

export interface WorkflowDefinitionOptions<Input, Output extends WorkflowOutputValue> {
  readonly build: (builder: WorkflowBuilder, input: Input) => Output;
  readonly id: string;
  readonly inputSchema: z.ZodType<Input>;
  readonly inputSchemaId: string;
  readonly version: number;
}

export interface WorkflowDefinition<Input, Output extends WorkflowOutputValue> {
  readonly build: (builder: WorkflowBuilder, input: Input) => Output;
  readonly id: string;
  readonly inputSchema: z.ZodType<Input>;
  readonly inputSchemaId: string;
  readonly version: number;
}

export interface BuiltWorkflow<Input extends JsonValue = JsonValue> {
  readonly graph: AuthoredWorkflowGraphV1;
  readonly input: Input;
}

export interface BuiltWorkflowRuntime<Input extends JsonValue = JsonValue>
  extends BuiltWorkflow<Input> {
  readonly computeDefinitions: readonly AnyTrustedComputeDefinition[];
}

export { defineCompute, seconds };
export type { DefineComputeOptions };

export function defineWorkflow<Input, Output extends WorkflowOutputValue>(
  options: WorkflowDefinitionOptions<Input, Output>,
): WorkflowDefinition<Input, Output> {
  const id = WorkflowIdSchema.parse(options.id);
  const inputSchemaId = SchemaIdSchema.parse(options.inputSchemaId);
  if (!Number.isSafeInteger(options.version) || options.version < 1) {
    throw new ApplicationError("invalid-data", "Workflow versions must be positive safe integers.");
  }
  return Object.freeze({
    build: options.build,
    id,
    inputSchema: options.inputSchema,
    inputSchemaId,
    version: options.version,
  });
}

export function buildWorkflow<Input, Output extends WorkflowOutputValue>(
  definition: WorkflowDefinition<Input, Output>,
  registry: OperationDiscoverySource,
  input: unknown,
): BuiltWorkflow {
  const runtime = buildWorkflowRuntime(definition, registry, input);
  return {
    graph: runtime.graph,
    input: runtime.input,
  };
}

export function buildWorkflowRuntime<Input, Output extends WorkflowOutputValue>(
  definition: WorkflowDefinition<Input, Output>,
  registry: OperationDiscoverySource,
  input: unknown,
): BuiltWorkflowRuntime {
  const parsedInput = definition.inputSchema.parse(input);
  return buildWorkflowRuntimeFromParsedInput(definition, registry, parsedInput);
}

/**
 * Rebuilds an exact persisted workflow without applying input transforms a
 * second time. Callers must supply the JSON-safe output of the original
 * schema parse from the hash-verified graph plan.
 */
export function buildWorkflowRuntimeFromParsedInput<
  Input,
  Output extends WorkflowOutputValue,
>(
  definition: WorkflowDefinition<Input, Output>,
  registry: OperationDiscoverySource,
  input: unknown,
): BuiltWorkflowRuntime {
  const parsedInput = input as Input;
  const workflowInput = JsonValueSchema.parse(parsedInput);
  const builder = WorkflowBuilder.create(registry);
  const outputs = definition.build(builder, parsedInput);
  const graph = builder.build({
    id: definition.id,
    inputSchemaId: definition.inputSchemaId,
    version: definition.version,
  }, outputs);
  return {
    computeDefinitions: builder.computeDefinitions(),
    graph,
    input: workflowInput,
  };
}
