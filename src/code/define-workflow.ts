import type { z } from "zod"

import {
  AuthoredComputeIdentitySchema,
  ComputeKeySchema,
  JsonValueSchema,
  MAX_TRUSTED_COMPUTE_DURATION_MS,
  MAX_TRUSTED_COMPUTE_INPUT_BYTES,
  MAX_TRUSTED_COMPUTE_OUTPUT_BYTES,
  SchemaIdSchema,
  TRUSTED_COMPUTE_BRAND,
  WorkflowIdSchema,
  type AuthoredWorkflowGraphV1,
  type AnyTrustedComputeDefinition,
  type JsonValue,
  type TrustedComputeDefinition,
  type WorkflowOutputValue,
  type WorkflowRegistryProjection,
} from "./contracts.js"
import { parseCodeBoundary } from "./boundary.js"
import { TransmuteCodeError } from "./errors.js"
import {
  WorkflowGraphBuilder,
  type OperationDiscoveryProvider,
} from "./graph-builder.js"
import { PortableWorkflowBuilder } from "./portable-builder.js"
import { PUBLIC_WORKFLOW_REGISTRY_PROJECTION } from "./projection.js"

export interface WorkflowDefinitionOptions<
  Input,
  Output extends WorkflowOutputValue,
> {
  readonly build: (builder: PortableWorkflowBuilder, input: Input) => Output
  readonly id: string
  readonly inputSchema: z.ZodType<Input>
  readonly inputSchemaId: string
  readonly version: number
}

export interface WorkflowDefinition<Input, Output extends WorkflowOutputValue> {
  readonly build: (builder: PortableWorkflowBuilder, input: Input) => Output
  readonly id: string
  readonly inputSchema: z.ZodType<Input>
  readonly inputSchemaId: string
  readonly version: number
}

export interface BuiltWorkflow<
  Input extends JsonValue = JsonValue,
  Output extends WorkflowOutputValue = WorkflowOutputValue,
> {
  readonly graph: AuthoredWorkflowGraphV1
  readonly input: Input
  readonly projection: WorkflowRegistryProjection
  readonly __output?: () => Output
}

function workflowDefinitionIdentity(options: {
  readonly build: unknown
  readonly id: string
  readonly inputSchemaId: string
  readonly version: number
}): {
  readonly id: string
  readonly inputSchemaId: string
  readonly version: number
} {
  if (typeof options.build !== "function") {
    throw new TransmuteCodeError(
      "invalid-data",
      "Workflow definitions require a build function.",
    )
  }
  const id = parseCodeBoundary(WorkflowIdSchema, options.id, "workflow id")
  const inputSchemaId = parseCodeBoundary(
    SchemaIdSchema,
    options.inputSchemaId,
    "workflow input schema id",
  )
  if (!Number.isSafeInteger(options.version) || options.version < 1) {
    throw new TransmuteCodeError(
      "invalid-data",
      "Workflow versions must be positive safe integers.",
    )
  }
  return { id, inputSchemaId, version: options.version }
}

export function defineWorkflow<Input, Output extends WorkflowOutputValue>(
  options: WorkflowDefinitionOptions<Input, Output>,
): WorkflowDefinition<Input, Output> {
  const identity = workflowDefinitionIdentity(options)
  return Object.freeze({
    build: options.build,
    id: identity.id,
    inputSchema: options.inputSchema,
    inputSchemaId: identity.inputSchemaId,
    version: identity.version,
  })
}

export function buildWorkflow<
  Input,
  Output extends WorkflowOutputValue,
>(
  definition: WorkflowDefinition<Input, Output>,
  input: unknown,
): BuiltWorkflow<JsonValue, Output> {
  const parsedInput = parseCodeBoundary(
    definition.inputSchema,
    input,
    "workflow input",
  )
  const workflowInput = parseCodeBoundary(
    JsonValueSchema,
    parsedInput,
    "JSON-safe workflow input",
  )
  const builder = PortableWorkflowBuilder.create()
  const outputs = definition.build(builder, parsedInput)
  const graph = builder.build({
    id: definition.id,
    inputSchemaId: definition.inputSchemaId,
    version: definition.version,
  }, outputs)
  return Object.freeze({
    graph,
    input: workflowInput,
    projection: PUBLIC_WORKFLOW_REGISTRY_PROJECTION,
  })
}

export const buildWorkflowGraph = buildWorkflow

export interface DefineComputeOptions<Input, Output> {
  readonly inputSchema: z.ZodType<Input>
  readonly inputSchemaId: string
  readonly key: string
  readonly maxDurationMs?: number
  readonly maxInputBytes?: number
  readonly maxOutputBytes?: number
  readonly outputSchema: z.ZodType<Output>
  readonly outputSchemaId: string
  readonly run: (
    input: Input,
    context: {
      readonly abortSignal: AbortSignal
      readonly nodeKey: string
      readonly replayAcknowledged: boolean
    },
  ) => Output | Promise<Output>
}

export function defineCompute<Input, Output>(
  options: DefineComputeOptions<Input, Output>,
): TrustedComputeDefinition<Input, Output> {
  const key = parseCodeBoundary(ComputeKeySchema, options.key, "trusted compute key")
  const inputSchemaId = parseCodeBoundary(
    SchemaIdSchema,
    options.inputSchemaId,
    "trusted compute input schema id",
  )
  const outputSchemaId = parseCodeBoundary(
    SchemaIdSchema,
    options.outputSchemaId,
    "trusted compute output schema id",
  )
  const identity = parseCodeBoundary(AuthoredComputeIdentitySchema, {
    bounds: {
      maxDurationMs: options.maxDurationMs ?? 30_000,
      maxInputBytes: options.maxInputBytes ?? Math.min(
        1024 * 1024,
        MAX_TRUSTED_COMPUTE_INPUT_BYTES,
      ),
      maxOutputBytes: options.maxOutputBytes ?? Math.min(
        1024 * 1024,
        MAX_TRUSTED_COMPUTE_OUTPUT_BYTES,
      ),
    },
    key,
    version: 1,
  }, "trusted compute definition")
  if (identity.bounds.maxDurationMs > MAX_TRUSTED_COMPUTE_DURATION_MS) {
    throw new TransmuteCodeError(
      "invalid-data",
      "Trusted compute duration exceeds the host maximum.",
    )
  }
  return Object.freeze({
    [TRUSTED_COMPUTE_BRAND]: true as const,
    bounds: identity.bounds,
    inputSchema: options.inputSchema,
    inputSchemaId,
    key,
    outputSchema: options.outputSchema,
    outputSchemaId,
    run: options.run,
  })
}

export interface AdvancedWorkflowDefinitionOptions<
  Input,
  Output extends WorkflowOutputValue,
> {
  readonly build: (builder: WorkflowGraphBuilder, input: Input) => Output
  readonly id: string
  readonly inputSchema: z.ZodType<Input>
  readonly inputSchemaId: string
  readonly version: number
}

export type AdvancedWorkflowDefinition<
  Input,
  Output extends WorkflowOutputValue,
> = AdvancedWorkflowDefinitionOptions<Input, Output>

export interface BuiltAdvancedWorkflow<Input extends JsonValue = JsonValue> {
  readonly computeDefinitions: readonly AnyTrustedComputeDefinition[]
  readonly graph: AuthoredWorkflowGraphV1
  readonly input: Input
}

export function defineAdvancedWorkflow<
  Input,
  Output extends WorkflowOutputValue,
>(
  options: AdvancedWorkflowDefinitionOptions<Input, Output>,
): AdvancedWorkflowDefinition<Input, Output> {
  const identity = workflowDefinitionIdentity(options)
  return Object.freeze({
    build: options.build,
    id: identity.id,
    inputSchema: options.inputSchema,
    inputSchemaId: identity.inputSchemaId,
    version: identity.version,
  })
}

export function buildAdvancedWorkflow<
  Input,
  Output extends WorkflowOutputValue,
>(
  definition: AdvancedWorkflowDefinition<Input, Output>,
  provider: OperationDiscoveryProvider,
  input: unknown,
): BuiltAdvancedWorkflow {
  const parsedInput = parseCodeBoundary(
    definition.inputSchema,
    input,
    "workflow input",
  )
  const workflowInput = parseCodeBoundary(
    JsonValueSchema,
    parsedInput,
    "JSON-safe workflow input",
  )
  const builder = WorkflowGraphBuilder.create(provider)
  const outputs = definition.build(builder, parsedInput)
  return Object.freeze({
    computeDefinitions: builder.computeDefinitions(),
    graph: builder.build({
      id: definition.id,
      inputSchemaId: definition.inputSchemaId,
      version: definition.version,
    }, outputs),
    input: workflowInput,
  })
}

export function seconds(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TransmuteCodeError(
      "invalid-data",
      "Seconds must be a finite nonnegative number.",
    )
  }
  const microseconds = value * 1_000_000
  if (!Number.isSafeInteger(microseconds)) {
    throw new TransmuteCodeError(
      "invalid-data",
      "Seconds must resolve to an integer number of safe microseconds.",
    )
  }
  return microseconds
}
