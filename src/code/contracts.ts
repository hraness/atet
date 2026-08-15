import { z } from "zod"

export const WORKFLOW_GRAPH_VERSION = "atet-workflow-graph-v2" as const
export const WORKFLOW_REF_VERSION = "atet-workflow-ref-v1" as const
export const GRAPH_ABI = "atet-workflow-graph-abi-v2" as const
export const REQUIREMENT_ENVELOPE_VERSION = "atet-requirement-envelope-v2" as const
export const TRUSTED_COMPUTE_VERSION = 1 as const
export const WORKFLOW_COMPILATION_VERSION = "atet-workflow-compilation-v1" as const
export const LEGACY_WORKFLOW_GRAPH_VERSION = "studio-workflow-graph-v2" as const
export const LEGACY_WORKFLOW_REF_VERSION = "studio-workflow-ref-v1" as const
export const LEGACY_GRAPH_ABI = "studio-workflow-graph-abi-v2" as const
export const LEGACY_REQUIREMENT_ENVELOPE_VERSION =
  "studio-requirement-envelope-v2" as const
export const LEGACY_WORKFLOW_COMPILATION_VERSION = "transmute-workflow-compilation-v1" as const

export const MAX_SERIALIZED_GRAPH_NODES = 4_096
export const MAX_SERIALIZED_NODE_DEPENDENCIES = 4_096
export const MAX_SERIALIZED_REF_PATH_SEGMENTS = 32
export const MAX_OPERATION_DISCOVERY_ENTRIES = 4_096
export const MAX_TRUSTED_COMPUTE_INPUT_BYTES = 2 * 1024 * 1024
export const MAX_TRUSTED_COMPUTE_OUTPUT_BYTES = 2 * 1024 * 1024
export const MAX_TRUSTED_COMPUTE_DURATION_MS = 5 * 60 * 1_000

const SAFE_IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/u
const NODE_KEY_SEGMENT_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/u
const NODE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*(?:\/[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*)*$/u
const SCHEMA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u
const OPERATION_KIND_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*)+$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u

export const WorkflowIdSchema = z.string().min(1).max(128).regex(SAFE_IDENTIFIER_PATTERN)
export const NodeKeySegmentSchema = z.string().min(1).max(64).regex(NODE_KEY_SEGMENT_PATTERN)
export const NodeKeySchema = z.string().min(1).max(255).regex(NODE_KEY_PATTERN)
export const SchemaIdSchema = z.string().min(1).max(192).regex(SCHEMA_ID_PATTERN)
export const ComputeKeySchema = z.string().min(1).max(192).regex(SCHEMA_ID_PATTERN)
export const OperationKindSchema = z.string().min(3).max(192).regex(OPERATION_KIND_PATTERN)
export const Sha256Schema = z.string().regex(SHA256_PATTERN)
export const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const NonnegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const RefPathSegmentSchema = z.union([
  z.string().min(1).max(128),
  NonnegativeSafeIntegerSchema,
])

export type OperationKind = z.infer<typeof OperationKindSchema>
export type JsonPrimitive = boolean | null | number | string
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

const JsonObjectKeySchema = z.string().refine(
  key => key !== "__proto__",
  "JSON object keys must not use the reserved __proto__ name.",
)

const RESERVED_JSON_OBJECT = Symbol("reserved-json-object")

function rejectReservedJsonObjectKey(value: unknown): unknown {
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.hasOwn(value, "__proto__")
  )
    ? RESERVED_JSON_OBJECT
    : value
}

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.preprocess(
  rejectReservedJsonObjectKey,
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(JsonObjectKeySchema, JsonValueSchema),
  ]),
))

export const SerializedRefV1Schema = z.strictObject({
  $ref: z.strictObject({
    nodeKey: NodeKeySchema,
    path: z.array(RefPathSegmentSchema)
      .max(MAX_SERIALIZED_REF_PATH_SEGMENTS)
      .optional(),
    schemaId: SchemaIdSchema,
  }),
  version: z.union([
    z.literal(WORKFLOW_REF_VERSION),
    z.literal(LEGACY_WORKFLOW_REF_VERSION),
  ]),
})

export type SerializedRefV1 = z.infer<typeof SerializedRefV1Schema>

export type GraphInputValue =
  | JsonPrimitive
  | SerializedRefV1
  | readonly GraphInputValue[]
  | { readonly [key: string]: GraphInputValue }

const GraphInputObjectSchema: z.ZodType<Readonly<Record<string, GraphInputValue>>> = z.lazy(
  () => z.record(JsonObjectKeySchema, GraphInputValueSchema).superRefine((value, context) => {
    if (Object.hasOwn(value, "$ref")) {
      context.addIssue({
        code: "custom",
        message: "The reserved $ref field must contain a complete versioned workflow reference.",
      })
    }
  }),
)

export const GraphInputValueSchema: z.ZodType<GraphInputValue> = z.lazy(() => z.preprocess(
  rejectReservedJsonObjectKey,
  z.union([
    SerializedRefV1Schema,
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(GraphInputValueSchema),
    GraphInputObjectSchema,
  ]),
))

export type WorkflowOutputBinding =
  | SerializedRefV1
  | readonly WorkflowOutputBinding[]
  | { readonly [key: string]: WorkflowOutputBinding }

const WorkflowOutputObjectSchema: z.ZodType<Readonly<Record<string, WorkflowOutputBinding>>> = z.lazy(
  () => z.record(JsonObjectKeySchema, WorkflowOutputBindingSchema).superRefine((value, context) => {
    if (Object.hasOwn(value, "$ref")) {
      context.addIssue({
        code: "custom",
        message: "The reserved $ref field must contain a complete versioned workflow reference.",
      })
    }
  }),
)

export const WorkflowOutputBindingSchema: z.ZodType<WorkflowOutputBinding> = z.lazy(
  () => z.preprocess(
    rejectReservedJsonObjectKey,
    z.union([
      SerializedRefV1Schema,
      z.array(WorkflowOutputBindingSchema),
      WorkflowOutputObjectSchema,
    ]),
  ),
)

export const AuthoredOperationIdentitySchema = z.strictObject({
  kind: OperationKindSchema,
  version: PositiveSafeIntegerSchema,
})

export type AuthoredOperationIdentity = z.infer<typeof AuthoredOperationIdentitySchema>

export const AuthoredComputeIdentitySchema = z.strictObject({
  bounds: z.strictObject({
    maxDurationMs: PositiveSafeIntegerSchema.max(MAX_TRUSTED_COMPUTE_DURATION_MS),
    maxInputBytes: PositiveSafeIntegerSchema.max(MAX_TRUSTED_COMPUTE_INPUT_BYTES),
    maxOutputBytes: PositiveSafeIntegerSchema.max(MAX_TRUSTED_COMPUTE_OUTPUT_BYTES),
  }),
  key: ComputeKeySchema,
  version: z.literal(TRUSTED_COMPUTE_VERSION),
})

export const AuthoredNodeExecutorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("operation"),
    operation: AuthoredOperationIdentitySchema,
  }),
  z.strictObject({
    compute: AuthoredComputeIdentitySchema,
    kind: z.literal("compute"),
  }),
])

export type AuthoredNodeExecutor = z.infer<typeof AuthoredNodeExecutorSchema>

export const AuthoredGraphNodeV1Schema = z.strictObject({
  controlDependencies: z.array(NodeKeySchema)
    .max(MAX_SERIALIZED_NODE_DEPENDENCIES)
    .optional(),
  dependencies: z.array(NodeKeySchema).max(MAX_SERIALIZED_NODE_DEPENDENCIES),
  executor: AuthoredNodeExecutorSchema,
  input: GraphInputValueSchema,
  inputSchemaId: SchemaIdSchema,
  key: NodeKeySchema,
  label: z.string().min(1).max(160).optional(),
  outputSchemaId: SchemaIdSchema,
})

export type AuthoredGraphNodeV1 = z.infer<typeof AuthoredGraphNodeV1Schema>
export type AuthoredOperationGraphNodeV1 = Omit<AuthoredGraphNodeV1, "executor"> & {
  readonly executor: Extract<AuthoredNodeExecutor, { readonly kind: "operation" }>
}
export type AuthoredComputeGraphNodeV1 = Omit<AuthoredGraphNodeV1, "executor"> & {
  readonly executor: Extract<AuthoredNodeExecutor, { readonly kind: "compute" }>
}

export function isOperationGraphNode(
  node: AuthoredGraphNodeV1,
): node is AuthoredOperationGraphNodeV1 {
  return node.executor.kind === "operation"
}

export function isComputeGraphNode(
  node: AuthoredGraphNodeV1,
): node is AuthoredComputeGraphNodeV1 {
  return node.executor.kind === "compute"
}

export const WorkflowIdentitySchema = z.strictObject({
  id: WorkflowIdSchema,
  inputSchemaId: SchemaIdSchema,
  version: PositiveSafeIntegerSchema,
})

export type WorkflowIdentity = z.infer<typeof WorkflowIdentitySchema>

export const AuthoredWorkflowGraphV1Schema = z.strictObject({
  nodes: z.array(AuthoredGraphNodeV1Schema).min(1).max(MAX_SERIALIZED_GRAPH_NODES),
  outputs: WorkflowOutputBindingSchema,
  version: z.union([
    z.literal(WORKFLOW_GRAPH_VERSION),
    z.literal(LEGACY_WORKFLOW_GRAPH_VERSION),
  ]),
  workflow: WorkflowIdentitySchema,
})

export type AuthoredWorkflowGraphV1 = z.infer<typeof AuthoredWorkflowGraphV1Schema>

export const OPERATION_EFFECT_CLASSES = Object.freeze([
  "pure",
  "local-read",
  "local-derived-write",
  "project-mutation",
  "paid-cloud",
  "live-control",
] as const)
export type OperationEffectClass = typeof OPERATION_EFFECT_CLASSES[number]

export const WORKFLOW_EFFECT_CLASSES = Object.freeze([
  ...OPERATION_EFFECT_CLASSES,
  "trusted-code",
] as const)
export type WorkflowEffectClass = typeof WORKFLOW_EFFECT_CLASSES[number]

export const OPERATION_RESUME_CLASSES = Object.freeze([
  "deterministic",
  "verified-receipt",
  "recoverable-transaction",
  "ambiguous-after-dispatch",
  "non-resumable-live",
] as const)
export type OperationResumeClass = typeof OPERATION_RESUME_CLASSES[number]

export const WORKFLOW_RESUME_CLASSES = Object.freeze([
  ...OPERATION_RESUME_CLASSES,
  "explicit-code-replay",
] as const)
export type WorkflowResumeClass = typeof WORKFLOW_RESUME_CLASSES[number]

export const OPERATION_PREPARATION_KINDS = Object.freeze([
  "project-state",
  "recording-metadata",
  "screen-capture",
  "camera",
  "microphone",
  "system-audio",
  "typed-text",
  "window-metadata",
  "local-media",
  "provider-options",
] as const)
export type OperationPreparationKind = typeof OPERATION_PREPARATION_KINDS[number]

export const OPERATION_LIFECYCLE_KINDS = Object.freeze([
  "pure",
  "local-artifact",
  "project-transaction",
  "paid-dispatch",
  "live-control",
] as const)
export type OperationLifecycleKind = typeof OPERATION_LIFECYCLE_KINDS[number]

export const OPERATION_RESOURCE_KINDS = Object.freeze([
  "cpu",
  "local-io",
  "ffmpeg",
  "vision",
  "whisper",
  "network",
  "paid-call",
  "project-render",
  "project-publication",
  "output-publication",
  "capture-device",
  "browser",
] as const)
export type OperationResourceKind = typeof OPERATION_RESOURCE_KINDS[number]

export const OperationResourceClaimSchema = z.strictObject({
  amount: PositiveSafeIntegerSchema,
  resource: z.enum(OPERATION_RESOURCE_KINDS),
})
export interface OperationResourceClaim {
  readonly amount: number
  readonly resource: OperationResourceKind
}

export const OperationPolicySchema = z.strictObject({
  cache: z.enum(["none", "exact-run", "content-addressed"]),
  cancellable: z.boolean(),
  effect: z.enum(OPERATION_EFFECT_CLASSES),
  maxDurationMs: PositiveSafeIntegerSchema,
  maxFanOut: NonnegativeSafeIntegerSchema,
  maxInputBytes: NonnegativeSafeIntegerSchema,
  maxOutputBytes: NonnegativeSafeIntegerSchema,
  preparation: z.array(z.enum(OPERATION_PREPARATION_KINDS))
    .max(OPERATION_PREPARATION_KINDS.length),
  resources: z.array(OperationResourceClaimSchema)
    .max(OPERATION_RESOURCE_KINDS.length),
  resume: z.enum(OPERATION_RESUME_CLASSES),
}) satisfies z.ZodType<OperationPolicy>
export interface OperationPolicy {
  readonly cache: "none" | "exact-run" | "content-addressed"
  readonly cancellable: boolean
  readonly effect: OperationEffectClass
  readonly maxDurationMs: number
  readonly maxFanOut: number
  readonly maxInputBytes: number
  readonly maxOutputBytes: number
  readonly preparation: readonly OperationPreparationKind[]
  readonly resources: readonly OperationResourceClaim[]
  readonly resume: OperationResumeClass
}

export const TrustedComputePolicySchema = z.strictObject({
  cache: z.literal("exact-run"),
  cancellable: z.literal(true),
  effect: z.literal("trusted-code"),
  maxDurationMs: PositiveSafeIntegerSchema.max(MAX_TRUSTED_COMPUTE_DURATION_MS),
  maxFanOut: z.literal(0),
  maxInputBytes: PositiveSafeIntegerSchema.max(MAX_TRUSTED_COMPUTE_INPUT_BYTES),
  maxOutputBytes: PositiveSafeIntegerSchema.max(MAX_TRUSTED_COMPUTE_OUTPUT_BYTES),
  preparation: z.tuple([]),
  resources: z.tuple([
    z.strictObject({ amount: z.literal(1), resource: z.literal("cpu") }),
  ]),
  resume: z.literal("explicit-code-replay"),
})
export type TrustedComputePolicy = z.infer<typeof TrustedComputePolicySchema>
export const WorkflowNodePolicySchema = z.union([
  OperationPolicySchema,
  TrustedComputePolicySchema,
])
export type WorkflowNodePolicy = OperationPolicy | TrustedComputePolicy

export function trustedComputePolicy(
  compute: z.infer<typeof AuthoredComputeIdentitySchema>,
): TrustedComputePolicy {
  return TrustedComputePolicySchema.parse({
    cache: "exact-run",
    cancellable: true,
    effect: "trusted-code",
    maxDurationMs: compute.bounds.maxDurationMs,
    maxFanOut: 0,
    maxInputBytes: compute.bounds.maxInputBytes,
    maxOutputBytes: compute.bounds.maxOutputBytes,
    preparation: [],
    resources: [{ amount: 1, resource: "cpu" }],
    resume: "explicit-code-replay",
  })
}

export const OperationDiscoverySchema = z.strictObject({
  inputSchemaId: SchemaIdSchema,
  kind: OperationKindSchema,
  lifecycle: z.enum(OPERATION_LIFECYCLE_KINDS),
  outputSchemaId: SchemaIdSchema,
  policy: OperationPolicySchema,
  version: PositiveSafeIntegerSchema,
}) satisfies z.ZodType<OperationDiscovery>
export interface OperationDiscovery {
  readonly inputSchemaId: string
  readonly kind: OperationKind
  readonly lifecycle: OperationLifecycleKind
  readonly outputSchemaId: string
  readonly policy: OperationPolicy
  readonly version: number
}

export interface OperationDiscoverySource {
  list(): readonly OperationDiscovery[]
}

export const WorkflowRegistryProjectionSchema = z.strictObject({
  discovery: z.array(OperationDiscoverySchema).max(MAX_OPERATION_DISCOVERY_ENTRIES),
  id: SchemaIdSchema,
  projectionSha256: Sha256Schema,
  trustedCompute: z.boolean(),
}) satisfies z.ZodType<WorkflowRegistryProjection>
export interface WorkflowRegistryProjection {
  readonly discovery: readonly OperationDiscovery[]
  readonly id: string
  readonly projectionSha256: string
  readonly trustedCompute: boolean
}

export const GraphCompilerLimitsSchema = z.strictObject({
  maxDepth: PositiveSafeIntegerSchema,
  maxEdges: NonnegativeSafeIntegerSchema,
  maxFanOut: NonnegativeSafeIntegerSchema,
  maxNodes: PositiveSafeIntegerSchema.max(MAX_SERIALIZED_GRAPH_NODES),
  maxTotalOperationFanOut: NonnegativeSafeIntegerSchema,
}) satisfies z.ZodType<GraphCompilerLimits>
export interface GraphCompilerLimits {
  readonly maxDepth: number
  readonly maxEdges: number
  readonly maxFanOut: number
  readonly maxNodes: number
  readonly maxTotalOperationFanOut: number
}

export const UNRESOLVED_REQUIREMENT_KINDS = Object.freeze([
  "dependency-outputs",
  "exact-media-hashes",
  "exact-sensitive-metadata-hashes",
  "prices",
  "project-generations",
  "render-plans",
] as const)

export const RequirementEnvelopeBoundsSchema = z.strictObject({
  depth: NonnegativeSafeIntegerSchema,
  edges: NonnegativeSafeIntegerSchema,
  localMediaUploadNodes: NonnegativeSafeIntegerSchema,
  maxDurationMs: NonnegativeSafeIntegerSchema,
  maxInputBytes: NonnegativeSafeIntegerSchema,
  maxOutputBytes: NonnegativeSafeIntegerSchema,
  nodes: NonnegativeSafeIntegerSchema,
  paidCallClaims: NonnegativeSafeIntegerSchema,
  structuralFanOut: NonnegativeSafeIntegerSchema,
  totalOperationFanOut: NonnegativeSafeIntegerSchema,
})

export const RequirementEnvelopeSchema = z.strictObject({
  bounds: RequirementEnvelopeBoundsSchema,
  computeKeys: z.array(ComputeKeySchema).max(MAX_SERIALIZED_GRAPH_NODES),
  effects: z.array(z.enum(WORKFLOW_EFFECT_CLASSES)).max(WORKFLOW_EFFECT_CLASSES.length),
  operationFamilies: z.array(NodeKeySegmentSchema).max(MAX_SERIALIZED_GRAPH_NODES),
  operationKinds: z.array(OperationKindSchema).max(MAX_SERIALIZED_GRAPH_NODES),
  preparation: z.array(z.enum(OPERATION_PREPARATION_KINDS))
    .max(OPERATION_PREPARATION_KINDS.length),
  resources: z.array(OperationResourceClaimSchema).max(OPERATION_RESOURCE_KINDS.length),
  resumeClasses: z.array(z.enum(WORKFLOW_RESUME_CLASSES))
    .max(WORKFLOW_RESUME_CLASSES.length),
  unresolved: z.array(z.enum(UNRESOLVED_REQUIREMENT_KINDS))
    .max(UNRESOLVED_REQUIREMENT_KINDS.length),
  version: z.union([
    z.literal(REQUIREMENT_ENVELOPE_VERSION),
    z.literal(LEGACY_REQUIREMENT_ENVELOPE_VERSION),
  ]),
})
export type RequirementEnvelope = z.infer<typeof RequirementEnvelopeSchema>

export const CompiledWorkflowGraphSchema = z.strictObject({
  compilationSha256: Sha256Schema,
  envelope: RequirementEnvelopeSchema,
  graph: AuthoredWorkflowGraphV1Schema,
  graphSha256: Sha256Schema,
  limits: GraphCompilerLimitsSchema,
  projection: WorkflowRegistryProjectionSchema,
  topologicalWaves: z.array(z.array(NodeKeySchema).min(1))
    .max(MAX_SERIALIZED_GRAPH_NODES),
  version: z.union([
    z.literal(WORKFLOW_COMPILATION_VERSION),
    z.literal(LEGACY_WORKFLOW_COMPILATION_VERSION),
  ]),
}) satisfies z.ZodType<CompiledWorkflowGraph>
export interface CompiledWorkflowGraph {
  readonly compilationSha256: string
  readonly envelope: RequirementEnvelope
  readonly graph: AuthoredWorkflowGraphV1
  readonly graphSha256: string
  readonly limits: GraphCompilerLimits
  readonly projection: WorkflowRegistryProjection
  readonly topologicalWaves: readonly (readonly string[])[]
  readonly version:
    | typeof WORKFLOW_COMPILATION_VERSION
    | typeof LEGACY_WORKFLOW_COMPILATION_VERSION
}

export interface OperationContract<Input, Output> {
  readonly inputSchemaId: string
  readonly kind: OperationKind
  readonly outputSchemaId: string
  readonly version: number
  readonly __input?: (input: Input) => Input
  readonly __output?: (output: Output) => Output
}

export const TRUSTED_COMPUTE_BRAND: unique symbol = Symbol.for(
  "atet.trusted-compute-definition",
) as never
export const LEGACY_TRUSTED_COMPUTE_BRAND: unique symbol = Symbol.for(
  "studio.trusted-compute-definition",
) as never

export interface TrustedComputeDefinition<Input, Output> {
  readonly [TRUSTED_COMPUTE_BRAND]: true
  readonly bounds: {
    readonly maxDurationMs: number
    readonly maxInputBytes: number
    readonly maxOutputBytes: number
  }
  readonly inputSchema: z.ZodType<Input>
  readonly inputSchemaId: string
  readonly key: string
  readonly outputSchema: z.ZodType<Output>
  readonly outputSchemaId: string
  run(input: Input, context: {
    readonly abortSignal: AbortSignal
    readonly nodeKey: string
    readonly replayAcknowledged: boolean
  }): Output | Promise<Output>
}

export type AnyTrustedComputeDefinition = TrustedComputeDefinition<unknown, unknown>

export type OperationInputValue<Value> =
  | Ref<Value>
  | (
    Value extends JsonPrimitive
      ? Value
      : Value extends readonly (infer Item)[]
        ? readonly OperationInputValue<Item>[]
        : Value extends object
          ? { readonly [Key in keyof Value]: OperationInputValue<Value[Key]> }
          : never
  )

export const WORKFLOW_REF_BRAND: unique symbol = Symbol.for(
  "atet.workflow-ref",
) as never

interface RefIdentity<Value> {
  readonly [WORKFLOW_REF_BRAND]: () => Value
  readonly serialized: SerializedRefV1
}

type RefArrayProjection<Value> =
  [Value] extends [readonly (infer Item)[]]
    ? { at(index: number): Ref<Item> }
    : object

type RefObjectProjection<Value> =
  [Value] extends [readonly unknown[]]
    ? object
    : [Value] extends [object]
      ? { select<Key extends Extract<keyof Value, string>>(key: Key): Ref<Value[Key]> }
      : object

export type Ref<Value> =
  & RefIdentity<Value>
  & RefArrayProjection<Value>
  & RefObjectProjection<Value>

export type RefValue<Reference> = Reference extends Ref<infer Value> ? Value : never

export type WorkflowOutputValue =
  | Ref<unknown>
  | readonly WorkflowOutputValue[]
  | { readonly [key: string]: WorkflowOutputValue }

export type OperationResourceTotals = Readonly<Record<OperationResourceKind, number>>
