// @bun
// src/code/contracts.ts
import { z } from "zod";
var WORKFLOW_GRAPH_VERSION = "studio-workflow-graph-v2";
var WORKFLOW_REF_VERSION = "studio-workflow-ref-v1";
var GRAPH_ABI = "studio-workflow-graph-abi-v2";
var REQUIREMENT_ENVELOPE_VERSION = "studio-requirement-envelope-v2";
var TRUSTED_COMPUTE_VERSION = 1;
var WORKFLOW_COMPILATION_VERSION = "transmute-workflow-compilation-v1";
var MAX_SERIALIZED_GRAPH_NODES = 4096;
var MAX_SERIALIZED_NODE_DEPENDENCIES = 4096;
var MAX_OPERATION_DISCOVERY_ENTRIES = 4096;
var MAX_TRUSTED_COMPUTE_INPUT_BYTES = 2 * 1024 * 1024;
var MAX_TRUSTED_COMPUTE_OUTPUT_BYTES = 2 * 1024 * 1024;
var MAX_TRUSTED_COMPUTE_DURATION_MS = 5 * 60 * 1000;
var SAFE_IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/u;
var NODE_KEY_SEGMENT_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/u;
var NODE_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*(?:\/[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*)*$/u;
var SCHEMA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u;
var OPERATION_KIND_PATTERN = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*)+$/u;
var SHA256_PATTERN = /^[a-f0-9]{64}$/u;
var WorkflowIdSchema = z.string().min(1).max(128).regex(SAFE_IDENTIFIER_PATTERN);
var NodeKeySegmentSchema = z.string().min(1).max(64).regex(NODE_KEY_SEGMENT_PATTERN);
var NodeKeySchema = z.string().min(1).max(255).regex(NODE_KEY_PATTERN);
var SchemaIdSchema = z.string().min(1).max(192).regex(SCHEMA_ID_PATTERN);
var ComputeKeySchema = z.string().min(1).max(192).regex(SCHEMA_ID_PATTERN);
var OperationKindSchema = z.string().min(3).max(192).regex(OPERATION_KIND_PATTERN);
var Sha256Schema = z.string().regex(SHA256_PATTERN);
var PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
var NonnegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var RefPathSegmentSchema = z.union([
  z.string().min(1).max(128),
  NonnegativeSafeIntegerSchema
]);
var JsonObjectKeySchema = z.string().refine((key) => key !== "__proto__", "JSON object keys must not use the reserved __proto__ name.");
var RESERVED_JSON_OBJECT = Symbol("reserved-json-object");
function rejectReservedJsonObjectKey(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.hasOwn(value, "__proto__") ? RESERVED_JSON_OBJECT : value;
}
var JsonValueSchema = z.lazy(() => z.preprocess(rejectReservedJsonObjectKey, z.union([
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(JsonValueSchema),
  z.record(JsonObjectKeySchema, JsonValueSchema)
])));
var SerializedRefV1Schema = z.strictObject({
  $ref: z.strictObject({
    nodeKey: NodeKeySchema,
    path: z.array(RefPathSegmentSchema).max(32).optional(),
    schemaId: SchemaIdSchema
  }),
  version: z.literal(WORKFLOW_REF_VERSION)
});
var GraphInputObjectSchema = z.lazy(() => z.record(JsonObjectKeySchema, GraphInputValueSchema).superRefine((value, context) => {
  if (Object.hasOwn(value, "$ref")) {
    context.addIssue({
      code: "custom",
      message: "The reserved $ref field must contain a complete versioned workflow reference."
    });
  }
}));
var GraphInputValueSchema = z.lazy(() => z.preprocess(rejectReservedJsonObjectKey, z.union([
  SerializedRefV1Schema,
  z.null(),
  z.boolean(),
  z.number().finite(),
  z.string(),
  z.array(GraphInputValueSchema),
  GraphInputObjectSchema
])));
var WorkflowOutputObjectSchema = z.lazy(() => z.record(JsonObjectKeySchema, WorkflowOutputBindingSchema).superRefine((value, context) => {
  if (Object.hasOwn(value, "$ref")) {
    context.addIssue({
      code: "custom",
      message: "The reserved $ref field must contain a complete versioned workflow reference."
    });
  }
}));
var WorkflowOutputBindingSchema = z.lazy(() => z.preprocess(rejectReservedJsonObjectKey, z.union([
  SerializedRefV1Schema,
  z.array(WorkflowOutputBindingSchema),
  WorkflowOutputObjectSchema
])));
var AuthoredOperationIdentitySchema = z.strictObject({
  kind: OperationKindSchema,
  version: PositiveSafeIntegerSchema
});
var AuthoredComputeIdentitySchema = z.strictObject({
  bounds: z.strictObject({
    maxDurationMs: PositiveSafeIntegerSchema.max(MAX_TRUSTED_COMPUTE_DURATION_MS),
    maxInputBytes: PositiveSafeIntegerSchema.max(MAX_TRUSTED_COMPUTE_INPUT_BYTES),
    maxOutputBytes: PositiveSafeIntegerSchema.max(MAX_TRUSTED_COMPUTE_OUTPUT_BYTES)
  }),
  key: ComputeKeySchema,
  version: z.literal(TRUSTED_COMPUTE_VERSION)
});
var AuthoredNodeExecutorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("operation"),
    operation: AuthoredOperationIdentitySchema
  }),
  z.strictObject({
    compute: AuthoredComputeIdentitySchema,
    kind: z.literal("compute")
  })
]);
var AuthoredGraphNodeV1Schema = z.strictObject({
  controlDependencies: z.array(NodeKeySchema).max(MAX_SERIALIZED_NODE_DEPENDENCIES).optional(),
  dependencies: z.array(NodeKeySchema).max(MAX_SERIALIZED_NODE_DEPENDENCIES),
  executor: AuthoredNodeExecutorSchema,
  input: GraphInputValueSchema,
  inputSchemaId: SchemaIdSchema,
  key: NodeKeySchema,
  label: z.string().min(1).max(160).optional(),
  outputSchemaId: SchemaIdSchema
});
function isOperationGraphNode(node) {
  return node.executor.kind === "operation";
}
function isComputeGraphNode(node) {
  return node.executor.kind === "compute";
}
var WorkflowIdentitySchema = z.strictObject({
  id: WorkflowIdSchema,
  inputSchemaId: SchemaIdSchema,
  version: PositiveSafeIntegerSchema
});
var AuthoredWorkflowGraphV1Schema = z.strictObject({
  nodes: z.array(AuthoredGraphNodeV1Schema).min(1).max(MAX_SERIALIZED_GRAPH_NODES),
  outputs: WorkflowOutputBindingSchema,
  version: z.literal(WORKFLOW_GRAPH_VERSION),
  workflow: WorkflowIdentitySchema
});
var OPERATION_EFFECT_CLASSES = Object.freeze([
  "pure",
  "local-read",
  "local-derived-write",
  "project-mutation",
  "paid-cloud",
  "live-control"
]);
var WORKFLOW_EFFECT_CLASSES = Object.freeze([
  ...OPERATION_EFFECT_CLASSES,
  "trusted-code"
]);
var OPERATION_RESUME_CLASSES = Object.freeze([
  "deterministic",
  "verified-receipt",
  "recoverable-transaction",
  "ambiguous-after-dispatch",
  "non-resumable-live"
]);
var WORKFLOW_RESUME_CLASSES = Object.freeze([
  ...OPERATION_RESUME_CLASSES,
  "explicit-code-replay"
]);
var OPERATION_PREPARATION_KINDS = Object.freeze([
  "project-state",
  "recording-metadata",
  "screen-capture",
  "camera",
  "microphone",
  "system-audio",
  "typed-text",
  "window-metadata",
  "local-media",
  "provider-options"
]);
var OPERATION_LIFECYCLE_KINDS = Object.freeze([
  "pure",
  "local-artifact",
  "project-transaction",
  "paid-dispatch",
  "live-control"
]);
var OPERATION_RESOURCE_KINDS = Object.freeze([
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
  "browser"
]);
var OperationResourceClaimSchema = z.strictObject({
  amount: PositiveSafeIntegerSchema,
  resource: z.enum(OPERATION_RESOURCE_KINDS)
});
var OperationPolicySchema = z.strictObject({
  cache: z.enum(["none", "exact-run", "content-addressed"]),
  cancellable: z.boolean(),
  effect: z.enum(OPERATION_EFFECT_CLASSES),
  maxDurationMs: PositiveSafeIntegerSchema,
  maxFanOut: NonnegativeSafeIntegerSchema,
  maxInputBytes: NonnegativeSafeIntegerSchema,
  maxOutputBytes: NonnegativeSafeIntegerSchema,
  preparation: z.array(z.enum(OPERATION_PREPARATION_KINDS)).max(OPERATION_PREPARATION_KINDS.length),
  resources: z.array(OperationResourceClaimSchema).max(OPERATION_RESOURCE_KINDS.length),
  resume: z.enum(OPERATION_RESUME_CLASSES)
});
var TrustedComputePolicySchema = z.strictObject({
  cache: z.literal("exact-run"),
  cancellable: z.literal(true),
  effect: z.literal("trusted-code"),
  maxDurationMs: PositiveSafeIntegerSchema.max(MAX_TRUSTED_COMPUTE_DURATION_MS),
  maxFanOut: z.literal(0),
  maxInputBytes: PositiveSafeIntegerSchema.max(MAX_TRUSTED_COMPUTE_INPUT_BYTES),
  maxOutputBytes: PositiveSafeIntegerSchema.max(MAX_TRUSTED_COMPUTE_OUTPUT_BYTES),
  preparation: z.tuple([]),
  resources: z.tuple([
    z.strictObject({ amount: z.literal(1), resource: z.literal("cpu") })
  ]),
  resume: z.literal("explicit-code-replay")
});
var WorkflowNodePolicySchema = z.union([
  OperationPolicySchema,
  TrustedComputePolicySchema
]);
function trustedComputePolicy(compute) {
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
    resume: "explicit-code-replay"
  });
}
var OperationDiscoverySchema = z.strictObject({
  inputSchemaId: SchemaIdSchema,
  kind: OperationKindSchema,
  lifecycle: z.enum(OPERATION_LIFECYCLE_KINDS),
  outputSchemaId: SchemaIdSchema,
  policy: OperationPolicySchema,
  version: PositiveSafeIntegerSchema
});
var WorkflowRegistryProjectionSchema = z.strictObject({
  discovery: z.array(OperationDiscoverySchema).max(MAX_OPERATION_DISCOVERY_ENTRIES),
  id: SchemaIdSchema,
  projectionSha256: Sha256Schema,
  trustedCompute: z.boolean()
});
var GraphCompilerLimitsSchema = z.strictObject({
  maxDepth: PositiveSafeIntegerSchema,
  maxEdges: NonnegativeSafeIntegerSchema,
  maxFanOut: NonnegativeSafeIntegerSchema,
  maxNodes: PositiveSafeIntegerSchema.max(MAX_SERIALIZED_GRAPH_NODES),
  maxTotalOperationFanOut: NonnegativeSafeIntegerSchema
});
var UNRESOLVED_REQUIREMENT_KINDS = Object.freeze([
  "dependency-outputs",
  "exact-media-hashes",
  "exact-sensitive-metadata-hashes",
  "prices",
  "project-generations",
  "render-plans"
]);
var RequirementEnvelopeBoundsSchema = z.strictObject({
  depth: NonnegativeSafeIntegerSchema,
  edges: NonnegativeSafeIntegerSchema,
  localMediaUploadNodes: NonnegativeSafeIntegerSchema,
  maxDurationMs: NonnegativeSafeIntegerSchema,
  maxInputBytes: NonnegativeSafeIntegerSchema,
  maxOutputBytes: NonnegativeSafeIntegerSchema,
  nodes: NonnegativeSafeIntegerSchema,
  paidCallClaims: NonnegativeSafeIntegerSchema,
  structuralFanOut: NonnegativeSafeIntegerSchema,
  totalOperationFanOut: NonnegativeSafeIntegerSchema
});
var RequirementEnvelopeSchema = z.strictObject({
  bounds: RequirementEnvelopeBoundsSchema,
  computeKeys: z.array(ComputeKeySchema).max(MAX_SERIALIZED_GRAPH_NODES),
  effects: z.array(z.enum(WORKFLOW_EFFECT_CLASSES)).max(WORKFLOW_EFFECT_CLASSES.length),
  operationFamilies: z.array(NodeKeySegmentSchema).max(MAX_SERIALIZED_GRAPH_NODES),
  operationKinds: z.array(OperationKindSchema).max(MAX_SERIALIZED_GRAPH_NODES),
  preparation: z.array(z.enum(OPERATION_PREPARATION_KINDS)).max(OPERATION_PREPARATION_KINDS.length),
  resources: z.array(OperationResourceClaimSchema).max(OPERATION_RESOURCE_KINDS.length),
  resumeClasses: z.array(z.enum(WORKFLOW_RESUME_CLASSES)).max(WORKFLOW_RESUME_CLASSES.length),
  unresolved: z.array(z.enum(UNRESOLVED_REQUIREMENT_KINDS)).max(UNRESOLVED_REQUIREMENT_KINDS.length),
  version: z.literal(REQUIREMENT_ENVELOPE_VERSION)
});
var CompiledWorkflowGraphSchema = z.strictObject({
  compilationSha256: Sha256Schema,
  envelope: RequirementEnvelopeSchema,
  graph: AuthoredWorkflowGraphV1Schema,
  graphSha256: Sha256Schema,
  limits: GraphCompilerLimitsSchema,
  projection: WorkflowRegistryProjectionSchema,
  topologicalWaves: z.array(z.array(NodeKeySchema).min(1)).max(MAX_SERIALIZED_GRAPH_NODES),
  version: z.literal(WORKFLOW_COMPILATION_VERSION)
});
var TRUSTED_COMPUTE_BRAND = Symbol.for("studio.trusted-compute-definition");
var WORKFLOW_REF_BRAND = Symbol.for("studio.workflow-ref");

// src/code/errors.ts
class TransmuteCodeError extends Error {
  code;
  details;
  constructor(code, message, details) {
    super(message);
    this.name = "TransmuteCodeError";
    this.code = code;
    this.details = details === undefined ? undefined : Object.freeze({ ...details });
  }
}
function transmuteCodeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function asTransmuteCodeError(error) {
  if (error instanceof TransmuteCodeError)
    return error;
  return new TransmuteCodeError("internal", transmuteCodeErrorMessage(error));
}

// src/code/canonical-json.ts
function invalidCanonicalJson(message) {
  throw new TransmuteCodeError("invalid-data", message);
}
function canonicalize(value, ancestors) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return invalidCanonicalJson("Canonical JSON does not support non-finite numbers.");
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object") {
    return invalidCanonicalJson(`Canonical JSON does not support ${typeof value} values.`);
  }
  if (ancestors.has(value)) {
    return invalidCanonicalJson("Canonical JSON does not support cycles.");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalize(item, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return invalidCanonicalJson("Canonical JSON accepts only arrays and plain objects.");
    }
    const record = value;
    return `{${Object.keys(record).sort().map((key) => {
      const item = record[key];
      if (item === undefined) {
        return invalidCanonicalJson(`Canonical JSON property ${key} is undefined.`);
      }
      return `${JSON.stringify(key)}:${canonicalize(item, ancestors)}`;
    }).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
function canonicalJson(value) {
  return canonicalize(value, new Set);
}
var SHA256_INITIAL = [
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
];
var SHA256_CONSTANTS = [
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
];
function rotateRight(value, shift) {
  return value >>> shift | value << 32 - shift;
}
function sha256Hex(input) {
  const source = new TextEncoder().encode(input);
  const bitLength = source.length * 8;
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(source);
  bytes[source.length] = 128;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 4294967296), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  const state = [...SHA256_INITIAL];
  const words = new Uint32Array(64);
  for (let offset = 0;offset < paddedLength; offset += 64) {
    for (let index = 0;index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16;index < 64; index += 1) {
      const word15 = words[index - 15] ?? 0;
      const word2 = words[index - 2] ?? 0;
      const sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ word15 >>> 3;
      const sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ word2 >>> 10;
      words[index] = (words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1 >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0;index < 64; index += 1) {
      const eValue = e ?? 0;
      const aValue = a ?? 0;
      const sum1 = rotateRight(eValue, 6) ^ rotateRight(eValue, 11) ^ rotateRight(eValue, 25);
      const choice = eValue & (f ?? 0) ^ ~eValue & (g ?? 0);
      const temporary1 = (h ?? 0) + sum1 + choice + (SHA256_CONSTANTS[index] ?? 0) + (words[index] ?? 0) >>> 0;
      const sum0 = rotateRight(aValue, 2) ^ rotateRight(aValue, 13) ^ rotateRight(aValue, 22);
      const majority = aValue & (b ?? 0) ^ aValue & (c ?? 0) ^ (b ?? 0) & (c ?? 0);
      const temporary2 = sum0 + majority >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d ?? 0) + temporary1 >>> 0;
      d = c;
      c = b;
      b = a;
      a = temporary1 + temporary2 >>> 0;
    }
    state[0] = (state[0] ?? 0) + (a ?? 0) >>> 0;
    state[1] = (state[1] ?? 0) + (b ?? 0) >>> 0;
    state[2] = (state[2] ?? 0) + (c ?? 0) >>> 0;
    state[3] = (state[3] ?? 0) + (d ?? 0) >>> 0;
    state[4] = (state[4] ?? 0) + (e ?? 0) >>> 0;
    state[5] = (state[5] ?? 0) + (f ?? 0) >>> 0;
    state[6] = (state[6] ?? 0) + (g ?? 0) >>> 0;
    state[7] = (state[7] ?? 0) + (h ?? 0) >>> 0;
  }
  return state.map((word) => word.toString(16).padStart(8, "0")).join("");
}
function canonicalJsonSha256(value) {
  return sha256Hex(canonicalJson(value));
}

// src/code/public-operations.ts
import { z as z2 } from "zod";
var MAX_PATH_CHARACTERS = 4096;
var MAX_PROMPT_BYTES = 8192;
var MAX_GENERATED_IMAGE_BYTES = 3145728;
var MAX_VECTOR_INPUT_BYTES = 16 * 1024 * 1024;
var MAX_VECTOR_OUTPUT_BYTES = 2000000;
var MAX_DIAGRAM_ARTIFACT_BYTES = 64 * 1024 * 1024;
var BoundedPathSchema = z2.string().min(1).max(MAX_PATH_CHARACTERS).refine((value) => !value.includes("\x00"), "Paths must not contain NUL bytes.");
var Sha256Schema2 = z2.string().regex(/^[a-f0-9]{64}$/u);
var BoundedVersionStringSchema = z2.string().min(1).max(256);
var NonnegativeSafeIntegerSchema2 = z2.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var PositiveSafeIntegerSchema2 = z2.number().int().positive().max(Number.MAX_SAFE_INTEGER);
function schemaWithReadonlyOutput(schema) {
  return schema;
}
var TransmuteImageModelSchema = z2.enum([
  "openai/gpt-image-1.5",
  "recraft/recraft-v4.1-utility"
]);
var TransmuteDiagramCheckInputSchema = z2.strictObject({
  path: BoundedPathSchema
});
var TransmuteDiagramRenderInputSchema = schemaWithReadonlyOutput(z2.strictObject({
  outDirectory: BoundedPathSchema.optional(),
  path: BoundedPathSchema,
  scale: z2.number().finite().positive().max(4).optional()
}));
var TransmuteImageVectorizeInputSchema = schemaWithReadonlyOutput(z2.strictObject({
  alphaCutoff: z2.number().int().min(1).max(64).optional(),
  duotone: z2.tuple([
    z2.string().regex(/^#[a-f0-9]{3}(?:[a-f0-9]{3})?$/iu),
    z2.string().regex(/^#[a-f0-9]{3}(?:[a-f0-9]{3})?$/iu)
  ]).optional(),
  inputPath: BoundedPathSchema,
  outputPath: BoundedPathSchema.refine((value) => value.toLowerCase().endsWith(".svg"), "Vector output paths must end in .svg."),
  timeoutMs: z2.number().int().min(1).max(300000).optional()
}));
var PromptSchema = z2.string().refine((value) => value.trim().length > 0, "Prompts must not be blank.").refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value), "Prompts must not contain control characters.").refine((value) => new TextEncoder().encode(value).byteLength <= MAX_PROMPT_BYTES, `Prompts must contain at most ${String(MAX_PROMPT_BYTES)} UTF-8 bytes.`);
var TransmuteImageGenerateInputSchema = schemaWithReadonlyOutput(z2.strictObject({
  idempotencyKey: z2.string().min(16).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u).optional(),
  model: TransmuteImageModelSchema,
  outputPath: BoundedPathSchema.refine((value) => value.toLowerCase().endsWith(".webp"), "Generated image output paths must end in .webp."),
  prompt: PromptSchema
}));
var TransmuteLintFindingSchema = z2.strictObject({
  code: z2.string().min(1).max(160),
  message: z2.string().min(1).max(4096),
  shapeIds: z2.array(z2.string().min(1).max(256)).max(4096)
});
var TransmuteDiagramCheckOutputSchema = z2.strictObject({
  configPath: z2.null(),
  findings: z2.array(TransmuteLintFindingSchema).max(4096)
});
var TransmuteRenderArtifactsSchema = z2.strictObject({
  darkPng: BoundedPathSchema,
  darkSvg: BoundedPathSchema,
  lightPng: BoundedPathSchema,
  lightSvg: BoundedPathSchema,
  spec: BoundedPathSchema,
  tldr: BoundedPathSchema
});
var TransmuteDiagramRenderOutputSchema = z2.strictObject({
  artifacts: TransmuteRenderArtifactsSchema,
  configPath: z2.null(),
  findings: z2.array(TransmuteLintFindingSchema).max(4096)
});
var TransmuteVectorizeQualityReceiptSchema = z2.strictObject({
  alphaRmse: z2.number().finite().nonnegative(),
  colorRmse: z2.number().finite().nonnegative(),
  outsideAlphaRatio: z2.number().finite().min(0).max(1),
  sampleHeight: PositiveSafeIntegerSchema2,
  sampleWidth: PositiveSafeIntegerSchema2,
  supportRecall: z2.number().finite().min(0).max(1)
});
var TransmuteVectorizeProvenanceSchema = z2.strictObject({
  arch: BoundedVersionStringSchema,
  platform: BoundedVersionStringSchema,
  sharp: BoundedVersionStringSchema,
  sharpVersions: z2.record(z2.string().min(1).max(128), BoundedVersionStringSchema),
  vips: BoundedVersionStringSchema,
  vtracerSha256: Sha256Schema2,
  vtracerSource: z2.enum(["official-release", "override"]),
  vtracerVersion: BoundedVersionStringSchema
});
var TransmuteVectorizeReceiptSchema = z2.strictObject({
  alphaCutoff: z2.number().int().min(1).max(64),
  bytes: NonnegativeSafeIntegerSchema2.max(MAX_VECTOR_OUTPUT_BYTES),
  candidatesEvaluated: PositiveSafeIntegerSchema2,
  format: z2.string().min(1).max(80),
  height: PositiveSafeIntegerSchema2.max(4096),
  inputBytes: PositiveSafeIntegerSchema2.max(MAX_VECTOR_INPUT_BYTES),
  outputMode: z2.enum(["color", "duotone"]),
  pathCount: NonnegativeSafeIntegerSchema2.max(12000),
  profile: z2.enum(["balanced", "detailed", "photo"]),
  provenance: TransmuteVectorizeProvenanceSchema,
  quality: TransmuteVectorizeQualityReceiptSchema,
  receiptVersion: z2.literal(1),
  representation: z2.enum(["color-paths", "alpha-mask"]),
  sourceSha256: Sha256Schema2,
  svgSha256: Sha256Schema2,
  width: PositiveSafeIntegerSchema2.max(4096)
});
var TransmuteImageVectorizeOutputSchema = z2.strictObject({
  outputPath: BoundedPathSchema,
  receipt: TransmuteVectorizeReceiptSchema
});
var TransmuteImageGenerateOutputSchema = z2.strictObject({
  bytes: PositiveSafeIntegerSchema2.max(MAX_GENERATED_IMAGE_BYTES),
  idempotencyKey: z2.string().min(16).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
  mediaType: z2.literal("image/webp"),
  model: TransmuteImageModelSchema,
  outputPath: BoundedPathSchema,
  requestId: z2.string().min(1).max(256).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "Request ids must not contain control characters.")
});
var PORTABLE_TRANSMUTE_OPERATION_KINDS = Object.freeze([
  "transmute.diagram.check",
  "transmute.diagram.render",
  "transmute.image.generate",
  "transmute.image.vectorize"
]);
function freezePolicy(policy) {
  const preparation = Object.freeze([...policy.preparation]);
  const resources = Object.freeze(policy.resources.map((claim) => Object.freeze({ ...claim })));
  return Object.freeze({ ...policy, preparation, resources });
}
function portableContract(contract) {
  return Object.freeze({ ...contract, policy: freezePolicy(contract.policy) });
}
var PORTABLE_TRANSMUTE_OPERATION_CONTRACTS = Object.freeze({
  "transmute.diagram.check": portableContract({
    inputSchema: TransmuteDiagramCheckInputSchema,
    inputSchemaId: "transmute.operation.diagram.check.input/v2",
    kind: "transmute.diagram.check",
    lifecycle: "pure",
    outputSchema: TransmuteDiagramCheckOutputSchema,
    outputSchemaId: "transmute.operation.diagram.check.output/v2",
    policy: {
      cache: "content-addressed",
      cancellable: false,
      effect: "local-read",
      maxDurationMs: 30000,
      maxFanOut: 0,
      maxInputBytes: 4096,
      maxOutputBytes: 256 * 1024,
      preparation: ["local-media"],
      resources: [
        { amount: 1, resource: "cpu" },
        { amount: 1, resource: "local-io" }
      ],
      resume: "deterministic"
    },
    version: 2
  }),
  "transmute.diagram.render": portableContract({
    inputSchema: TransmuteDiagramRenderInputSchema,
    inputSchemaId: "transmute.operation.diagram.render.input/v2",
    kind: "transmute.diagram.render",
    lifecycle: "local-artifact",
    outputSchema: TransmuteDiagramRenderOutputSchema,
    outputSchemaId: "transmute.operation.diagram.render.output/v2",
    policy: {
      cache: "none",
      cancellable: false,
      effect: "local-derived-write",
      maxDurationMs: 120000,
      maxFanOut: 5,
      maxInputBytes: 8192,
      maxOutputBytes: 5 * MAX_DIAGRAM_ARTIFACT_BYTES,
      preparation: ["local-media"],
      resources: [
        { amount: 1, resource: "cpu" },
        { amount: 1, resource: "local-io" }
      ],
      resume: "ambiguous-after-dispatch"
    },
    version: 2
  }),
  "transmute.image.generate": portableContract({
    inputSchema: TransmuteImageGenerateInputSchema,
    inputSchemaId: "transmute.operation.image.generate.input/v2",
    kind: "transmute.image.generate",
    lifecycle: "paid-dispatch",
    outputSchema: TransmuteImageGenerateOutputSchema,
    outputSchemaId: "transmute.operation.image.generate.output/v2",
    policy: {
      cache: "exact-run",
      cancellable: false,
      effect: "paid-cloud",
      maxDurationMs: 120000,
      maxFanOut: 1,
      maxInputBytes: 16 * 1024,
      maxOutputBytes: MAX_GENERATED_IMAGE_BYTES,
      preparation: ["provider-options"],
      resources: [
        { amount: 1, resource: "local-io" },
        { amount: 1, resource: "network" },
        { amount: 1, resource: "paid-call" }
      ],
      resume: "ambiguous-after-dispatch"
    },
    version: 2
  }),
  "transmute.image.vectorize": portableContract({
    inputSchema: TransmuteImageVectorizeInputSchema,
    inputSchemaId: "transmute.operation.image.vectorize.input/v2",
    kind: "transmute.image.vectorize",
    lifecycle: "local-artifact",
    outputSchema: TransmuteImageVectorizeOutputSchema,
    outputSchemaId: "transmute.operation.image.vectorize.output/v2",
    policy: {
      cache: "none",
      cancellable: false,
      effect: "local-derived-write",
      maxDurationMs: 300000,
      maxFanOut: 1,
      maxInputBytes: MAX_VECTOR_INPUT_BYTES,
      maxOutputBytes: MAX_VECTOR_OUTPUT_BYTES,
      preparation: ["local-media"],
      resources: [
        { amount: 1, resource: "cpu" },
        { amount: 1, resource: "local-io" }
      ],
      resume: "ambiguous-after-dispatch"
    },
    version: 2
  })
});
function isPortableTransmuteOperationKind(value) {
  return PORTABLE_TRANSMUTE_OPERATION_KINDS.includes(value);
}

// src/code/boundary.ts
function parseCodeBoundary(schema, input, name) {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new TransmuteCodeError("invalid-data", `Invalid ${name}.`, {
      issues: result.error.issues.map((issue) => ({
        code: issue.code,
        message: issue.message,
        path: issue.path.map(String)
      }))
    });
  }
  return result.data;
}

// src/code/projection.ts
var WORKFLOW_REGISTRY_PROJECTION_HASH_DOMAIN = "transmute.workflow.registry-projection/v1";
var PUBLIC_WORKFLOW_REGISTRY_PROJECTION_ID = "transmute.workflow.registry.public/v1";
function discoveryList(source) {
  return Array.isArray(source) ? source : source.list();
}
function operationKey(kind, version) {
  return `${kind}@${String(version)}`;
}
function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
function normalizeOperationDiscovery(input) {
  const normalized = input.map((item) => {
    const parsed = parseCodeBoundary(OperationDiscoverySchema, item, "operation discovery entry");
    const preparation = uniqueSorted(parsed.policy.preparation);
    if (preparation.length !== parsed.policy.preparation.length) {
      throw new TransmuteCodeError("invalid-data", `Duplicate preparation requirement for ${operationKey(parsed.kind, parsed.version)}.`, { kind: parsed.kind, version: parsed.version });
    }
    const resources = [...parsed.policy.resources].sort((left, right) => left.resource.localeCompare(right.resource));
    if (new Set(resources.map((resource) => resource.resource)).size !== resources.length) {
      throw new TransmuteCodeError("invalid-data", `Duplicate resource claim for ${operationKey(parsed.kind, parsed.version)}.`, { kind: parsed.kind, version: parsed.version });
    }
    return parseCodeBoundary(OperationDiscoverySchema, {
      ...parsed,
      policy: { ...parsed.policy, preparation, resources }
    }, "normalized operation discovery entry");
  }).sort((left, right) => left.kind.localeCompare(right.kind) || left.version - right.version);
  const seen = new Set;
  for (const operation of normalized) {
    const key = operationKey(operation.kind, operation.version);
    if (seen.has(key)) {
      throw new TransmuteCodeError("conflict", `Duplicate operation discovery entry: ${key}`, { kind: operation.kind, version: operation.version });
    }
    seen.add(key);
  }
  return normalized;
}
function freezeDiscovery(discovery) {
  return Object.freeze(discovery.map((operation) => Object.freeze({
    ...operation,
    policy: Object.freeze({
      ...operation.policy,
      preparation: Object.freeze([...operation.policy.preparation]),
      resources: Object.freeze(operation.policy.resources.map((resource) => Object.freeze({ ...resource })))
    })
  })));
}
function createWorkflowRegistryProjectionHash(input) {
  const id = parseCodeBoundary(SchemaIdSchema, input.id, "registry projection id");
  const discovery = normalizeOperationDiscovery(input.discovery);
  const trustedCompute = input.trustedCompute ?? false;
  return sha256Hex(`${WORKFLOW_REGISTRY_PROJECTION_HASH_DOMAIN}\x00${canonicalJson({
    discovery,
    id,
    trustedCompute
  })}`);
}
function createWorkflowRegistryProjection(idInput, source, options = {}) {
  const id = parseCodeBoundary(SchemaIdSchema, idInput, "registry projection id");
  const discovery = normalizeOperationDiscovery(discoveryList(source));
  const trustedCompute = options.trustedCompute ?? false;
  const parsed = parseCodeBoundary(WorkflowRegistryProjectionSchema, {
    discovery,
    id,
    projectionSha256: createWorkflowRegistryProjectionHash({
      discovery,
      id,
      trustedCompute
    }),
    trustedCompute
  }, "workflow registry projection");
  return Object.freeze({
    ...parsed,
    discovery: freezeDiscovery(parsed.discovery)
  });
}
function parseWorkflowRegistryProjection(input) {
  const parsed = parseCodeBoundary(WorkflowRegistryProjectionSchema, input, "workflow registry projection");
  const normalized = createWorkflowRegistryProjection(parsed.id, parsed.discovery, { trustedCompute: parsed.trustedCompute });
  if (parsed.projectionSha256 !== normalized.projectionSha256) {
    throw new TransmuteCodeError("invalid-data", "Workflow registry projection hash does not match its contents.", {
      actualProjectionSha256: parsed.projectionSha256,
      expectedProjectionSha256: normalized.projectionSha256,
      projectionId: parsed.id
    });
  }
  if (canonicalJson(parsed) !== canonicalJson(normalized)) {
    throw new TransmuteCodeError("invalid-data", "Workflow registry projection discovery is not normalized.", { projectionId: parsed.id });
  }
  return normalized;
}
function publicDiscovery() {
  return PORTABLE_TRANSMUTE_OPERATION_KINDS.map((kind) => {
    const contract = PORTABLE_TRANSMUTE_OPERATION_CONTRACTS[kind];
    return {
      inputSchemaId: contract.inputSchemaId,
      kind: contract.kind,
      lifecycle: contract.lifecycle,
      outputSchemaId: contract.outputSchemaId,
      policy: contract.policy,
      version: contract.version
    };
  });
}
function createPublicWorkflowRegistryProjection() {
  return createWorkflowRegistryProjection(PUBLIC_WORKFLOW_REGISTRY_PROJECTION_ID, publicDiscovery(), { trustedCompute: false });
}
var PUBLIC_WORKFLOW_REGISTRY_PROJECTION = createPublicWorkflowRegistryProjection();
var PUBLIC_TRANSMUTE_WORKFLOW_PROJECTION = PUBLIC_WORKFLOW_REGISTRY_PROJECTION;

// src/code/compiler.ts
var WORKFLOW_GRAPH_HASH_DOMAIN = "transmute.workflow.graph/v1";
var WORKFLOW_COMPILATION_HASH_DOMAIN = "transmute.workflow.compilation/v1";
var DEFAULT_GRAPH_COMPILER_LIMITS = Object.freeze({
  maxDepth: 64,
  maxEdges: 2048,
  maxFanOut: 64,
  maxNodes: 256,
  maxTotalOperationFanOut: 4096
});
function invalidData(message, details) {
  throw new TransmuteCodeError("invalid-data", message, details);
}
function deepFreeze(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value))
    deepFreeze(nested);
  return Object.freeze(value);
}
function operationKey2(kind, version) {
  return `${kind}@${String(version)}`;
}
function uniqueSorted2(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
function safeAdd(left, right, name) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    return invalidData(`${name} exceeds the safe integer range.`, { left, right });
  }
  return result;
}
function normalizeLimits(input) {
  if (input === undefined)
    return DEFAULT_GRAPH_COMPILER_LIMITS;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return parseCodeBoundary(GraphCompilerLimitsSchema, input, "graph compiler limits");
  }
  return parseCodeBoundary(GraphCompilerLimitsSchema, {
    ...DEFAULT_GRAPH_COMPILER_LIMITS,
    ...input
  }, "graph compiler limits");
}
function normalizeAuthoredWorkflowGraph(graphInput) {
  const graph = parseCodeBoundary(AuthoredWorkflowGraphV1Schema, graphInput, "authored workflow graph");
  const sorted = {
    ...graph,
    nodes: [...graph.nodes].sort((left, right) => left.key.localeCompare(right.key))
  };
  const canonical = JSON.parse(canonicalJson(sorted));
  return parseCodeBoundary(AuthoredWorkflowGraphV1Schema, canonical, "normalized authored workflow graph");
}
function createWorkflowGraphHash(graphInput) {
  const graph = normalizeAuthoredWorkflowGraph(graphInput);
  return sha256Hex(`${WORKFLOW_GRAPH_HASH_DOMAIN}\x00${canonicalJson(graph)}`);
}
var createGraphHash = createWorkflowGraphHash;
function isSerializedRef(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.hasOwn(value, "$ref");
}
function isGraphValueArray(value) {
  return Array.isArray(value);
}
function collectReferences(value) {
  const references = [];
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined)
      continue;
    if (isSerializedRef(current)) {
      references.push(current);
      continue;
    }
    if (isGraphValueArray(current)) {
      for (const item of current)
        pending.push(item);
      continue;
    }
    if (typeof current === "object" && current !== null) {
      for (const item of Object.values(current))
        pending.push(item);
    }
  }
  return references.sort((left, right) => left.$ref.nodeKey.localeCompare(right.$ref.nodeKey) || left.$ref.schemaId.localeCompare(right.$ref.schemaId) || canonicalJson(left.$ref.path ?? []).localeCompare(canonicalJson(right.$ref.path ?? [])));
}
function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function validateReference(reference, nodesByKey, owner) {
  const producer = nodesByKey.get(reference.$ref.nodeKey);
  if (producer === undefined) {
    return invalidData(`${owner} contains a dangling reference to ${reference.$ref.nodeKey}.`, { nodeKey: reference.$ref.nodeKey, owner });
  }
  if (producer.outputSchemaId !== reference.$ref.schemaId) {
    return invalidData(`${owner} expects schema ${reference.$ref.schemaId} from ${producer.key}, ` + `but the producer declares ${producer.outputSchemaId}.`, {
      actualSchemaId: producer.outputSchemaId,
      expectedSchemaId: reference.$ref.schemaId,
      nodeKey: producer.key,
      owner
    });
  }
}
function topologicalWaves(nodes, limits) {
  const dependencies = new Map;
  const dependents = new Map;
  let edgeCount = 0;
  for (const node of nodes) {
    const nodeDependencies = new Set(node.dependencies);
    dependencies.set(node.key, nodeDependencies);
    edgeCount = safeAdd(edgeCount, nodeDependencies.size, "Workflow edge count");
    for (const dependency of nodeDependencies) {
      const entries = dependents.get(dependency) ?? new Set;
      entries.add(node.key);
      dependents.set(dependency, entries);
    }
  }
  if (edgeCount > limits.maxEdges) {
    return invalidData(`Workflow has ${String(edgeCount)} edges; the limit is ${String(limits.maxEdges)}.`, { actual: edgeCount, limit: limits.maxEdges });
  }
  const structuralFanOut = Math.max(0, ...[...dependents.values()].map((entries) => entries.size));
  if (structuralFanOut > limits.maxFanOut) {
    return invalidData(`Workflow fan-out is ${String(structuralFanOut)}; the limit is ${String(limits.maxFanOut)}.`, { actual: structuralFanOut, limit: limits.maxFanOut });
  }
  let ready = nodes.filter((node) => (dependencies.get(node.key)?.size ?? 0) === 0).map((node) => node.key).sort((left, right) => left.localeCompare(right));
  const remaining = new Map(nodes.map((node) => [node.key, dependencies.get(node.key)?.size ?? 0]));
  const waves = [];
  let visited = 0;
  while (ready.length > 0) {
    const wave = ready;
    waves.push(wave);
    visited += wave.length;
    const next = new Set;
    for (const nodeKey of wave) {
      for (const dependent of dependents.get(nodeKey) ?? []) {
        const nextCount = (remaining.get(dependent) ?? 0) - 1;
        remaining.set(dependent, nextCount);
        if (nextCount === 0)
          next.add(dependent);
      }
    }
    ready = [...next].sort((left, right) => left.localeCompare(right));
  }
  if (visited !== nodes.length) {
    return invalidData("Workflow graph contains a dependency cycle.");
  }
  if (waves.length > limits.maxDepth) {
    return invalidData(`Workflow depth is ${String(waves.length)}; the limit is ${String(limits.maxDepth)}.`, { actual: waves.length, limit: limits.maxDepth });
  }
  return {
    depth: waves.length,
    edges: edgeCount,
    structuralFanOut,
    waves
  };
}
function validateGraph(graphInput, projection, limits) {
  const graph = normalizeAuthoredWorkflowGraph(graphInput);
  if (graph.nodes.length > limits.maxNodes) {
    return invalidData(`Workflow has ${String(graph.nodes.length)} nodes; the limit is ${String(limits.maxNodes)}.`, { actual: graph.nodes.length, limit: limits.maxNodes });
  }
  const nodesByKey = new Map;
  for (const node of graph.nodes) {
    if (nodesByKey.has(node.key)) {
      return invalidData(`Duplicate workflow node key: ${node.key}`, {
        nodeKey: node.key
      });
    }
    nodesByKey.set(node.key, node);
  }
  const discoveryByKey = new Map(projection.discovery.map((operation) => [
    operationKey2(operation.kind, operation.version),
    operation
  ]));
  const policiesByNode = new Map;
  let totalOperationFanOut = 0;
  for (const node of graph.nodes) {
    let policy;
    if (isOperationGraphNode(node)) {
      const identity = node.executor.operation;
      const operation = discoveryByKey.get(operationKey2(identity.kind, identity.version));
      if (operation === undefined) {
        throw new TransmuteCodeError("unsupported-plan", `Unsupported operation: ${operationKey2(identity.kind, identity.version)}`, {
          kind: identity.kind,
          nodeKey: node.key,
          projectionId: projection.id,
          version: identity.version
        });
      }
      if (node.inputSchemaId !== operation.inputSchemaId || node.outputSchemaId !== operation.outputSchemaId) {
        return invalidData(`Operation schema identity mismatch for ${operationKey2(identity.kind, identity.version)} ` + `at node ${node.key}.`, {
          actualInputSchemaId: node.inputSchemaId,
          actualOutputSchemaId: node.outputSchemaId,
          expectedInputSchemaId: operation.inputSchemaId,
          expectedOutputSchemaId: operation.outputSchemaId,
          kind: identity.kind,
          nodeKey: node.key,
          version: identity.version
        });
      }
      policy = operation.policy;
    } else if (isComputeGraphNode(node)) {
      if (!projection.trustedCompute) {
        throw new TransmuteCodeError("unsupported-plan", `Trusted compute is unsupported at node ${node.key}.`, {
          executorKind: "compute",
          nodeKey: node.key,
          projectionId: projection.id
        });
      }
      policy = trustedComputePolicy(node.executor.compute);
    } else {
      throw new TransmuteCodeError("internal", `Unknown node executor for ${node.key}.`);
    }
    policiesByNode.set(node.key, policy);
    totalOperationFanOut = safeAdd(totalOperationFanOut, policy.maxFanOut, "Total operation fan-out");
    const references = collectReferences(node.input);
    for (const reference of references) {
      validateReference(reference, nodesByKey, `Node ${node.key}`);
    }
    const controlDependencies = node.controlDependencies ?? [];
    const normalizedControlDependencies = uniqueSorted2(controlDependencies);
    if (!arraysEqual(controlDependencies, normalizedControlDependencies)) {
      return invalidData(`Node ${node.key} control dependencies must be unique and sorted.`, { nodeKey: node.key });
    }
    for (const dependency of controlDependencies) {
      if (!nodesByKey.has(dependency)) {
        return invalidData(`Node ${node.key} contains a dangling control dependency to ${dependency}.`, { dependency, nodeKey: node.key });
      }
      if (dependency === node.key) {
        return invalidData(`Node ${node.key} cannot depend on itself.`, {
          nodeKey: node.key
        });
      }
    }
    const inferredDependencies = uniqueSorted2([
      ...references.map((reference) => reference.$ref.nodeKey),
      ...controlDependencies
    ]);
    if (!arraysEqual(node.dependencies, inferredDependencies)) {
      return invalidData(`Node ${node.key} dependencies do not match its embedded references and explicit control dependencies. ` + `Expected [${inferredDependencies.join(", ")}].`, { expectedDependencies: inferredDependencies, nodeKey: node.key });
    }
  }
  if (totalOperationFanOut > limits.maxTotalOperationFanOut) {
    return invalidData(`Workflow operation fan-out bound is ${String(totalOperationFanOut)}; ` + `the limit is ${String(limits.maxTotalOperationFanOut)}.`, { actual: totalOperationFanOut, limit: limits.maxTotalOperationFanOut });
  }
  for (const reference of collectReferences(graph.outputs)) {
    validateReference(reference, nodesByKey, "Workflow outputs");
  }
  return {
    graph,
    policiesByNode,
    topology: topologicalWaves(graph.nodes, limits)
  };
}
function operationFamily(kind) {
  const separator = kind.indexOf(".");
  if (separator < 1) {
    throw new TransmuteCodeError("internal", `Operation ${kind} has no namespace family.`, { kind });
  }
  return kind.slice(0, separator);
}
function addResource(resources, resource, amount) {
  resources.set(resource, safeAdd(resources.get(resource) ?? 0, amount, `Resource ${resource} claim`));
}
function deriveRequirementEnvelope(validated) {
  const computeKeys = new Set;
  const effects = new Set;
  const families = new Set;
  const operationKinds = new Set;
  const preparation = new Set;
  const resources = new Map;
  const resumeClasses = new Set;
  let localMediaUploadNodes = 0;
  let maxDurationMs = 0;
  let maxInputBytes = 0;
  let maxOutputBytes = 0;
  let totalOperationFanOut = 0;
  for (const node of validated.graph.nodes) {
    const policy = validated.policiesByNode.get(node.key);
    if (policy === undefined) {
      throw new TransmuteCodeError("internal", `Node ${node.key} lost its execution policy.`);
    }
    effects.add(policy.effect);
    resumeClasses.add(policy.resume);
    if (isOperationGraphNode(node)) {
      families.add(operationFamily(node.executor.operation.kind));
      operationKinds.add(node.executor.operation.kind);
    } else if (isComputeGraphNode(node)) {
      families.add("compute");
      computeKeys.add(node.executor.compute.key);
    }
    for (const requirement of policy.preparation)
      preparation.add(requirement);
    for (const claim of policy.resources) {
      addResource(resources, claim.resource, claim.amount);
    }
    if (policy.effect === "paid-cloud" && policy.preparation.includes("local-media")) {
      localMediaUploadNodes = safeAdd(localMediaUploadNodes, 1, "Local media upload node count");
    }
    maxDurationMs = safeAdd(maxDurationMs, policy.maxDurationMs, "Workflow duration bound");
    maxInputBytes = safeAdd(maxInputBytes, policy.maxInputBytes, "Workflow input byte bound");
    maxOutputBytes = safeAdd(maxOutputBytes, policy.maxOutputBytes, "Workflow output byte bound");
    totalOperationFanOut = safeAdd(totalOperationFanOut, policy.maxFanOut, "Workflow operation fan-out bound");
  }
  const unresolved = new Set;
  if (validated.topology.edges > 0)
    unresolved.add("dependency-outputs");
  if (preparation.has("local-media") || preparation.has("project-state") || preparation.has("recording-metadata")) {
    unresolved.add("exact-media-hashes");
  }
  if (preparation.has("recording-metadata") || preparation.has("typed-text") || preparation.has("window-metadata")) {
    unresolved.add("exact-sensitive-metadata-hashes");
  }
  if (effects.has("paid-cloud") || resources.has("paid-call")) {
    unresolved.add("prices");
  }
  if (effects.has("project-mutation") || operationKinds.has("render.project") || operationKinds.has("render.project-plan")) {
    unresolved.add("project-generations");
  }
  if (families.has("render"))
    unresolved.add("render-plans");
  return parseCodeBoundary(RequirementEnvelopeSchema, {
    bounds: {
      depth: validated.topology.depth,
      edges: validated.topology.edges,
      localMediaUploadNodes,
      maxDurationMs,
      maxInputBytes,
      maxOutputBytes,
      nodes: validated.graph.nodes.length,
      paidCallClaims: resources.get("paid-call") ?? 0,
      structuralFanOut: validated.topology.structuralFanOut,
      totalOperationFanOut
    },
    computeKeys: uniqueSorted2(computeKeys),
    effects: uniqueSorted2(effects),
    operationFamilies: uniqueSorted2(families),
    operationKinds: uniqueSorted2(operationKinds),
    preparation: uniqueSorted2(preparation),
    resources: [...resources].map(([resource, amount]) => ({ amount, resource })).sort((left, right) => left.resource.localeCompare(right.resource)),
    resumeClasses: uniqueSorted2(resumeClasses),
    unresolved: uniqueSorted2(unresolved),
    version: REQUIREMENT_ENVELOPE_VERSION
  }, "workflow requirement envelope");
}
function resolveProjection(options) {
  if (options.projection !== undefined) {
    if (options.registry !== undefined || options.projectionId !== undefined || options.trustedCompute !== undefined) {
      throw new TransmuteCodeError("invalid-data", "Compile with either a projection or a registry projection source, not both.");
    }
    return parseWorkflowRegistryProjection(options.projection);
  }
  if (options.registry !== undefined) {
    if (options.projectionId === undefined) {
      throw new TransmuteCodeError("invalid-data", "A registry projection source requires an explicit projection id.");
    }
    return createWorkflowRegistryProjection(options.projectionId, options.registry, { trustedCompute: options.trustedCompute ?? false });
  }
  if (options.projectionId !== undefined || options.trustedCompute !== undefined) {
    throw new TransmuteCodeError("invalid-data", "A projection id or trusted-compute authority requires a registry projection source.");
  }
  return PUBLIC_WORKFLOW_REGISTRY_PROJECTION;
}
function createWorkflowCompilationHash(compilationInput) {
  const input = compilationInput;
  const unsigned = {
    envelope: input.envelope,
    graph: input.graph,
    graphSha256: input.graphSha256,
    limits: input.limits,
    projection: input.projection,
    topologicalWaves: input.topologicalWaves,
    version: input.version
  };
  const parsed = parseCodeBoundary(CompiledWorkflowGraphSchema.omit({ compilationSha256: true }), unsigned, "unsigned workflow compilation");
  return sha256Hex(`${WORKFLOW_COMPILATION_HASH_DOMAIN}\x00${canonicalJson(parsed)}`);
}
function compileWorkflowGraph(options) {
  const limits = normalizeLimits(options.limits);
  const projection = resolveProjection(options);
  const discovery = normalizeOperationDiscovery(projection.discovery);
  const normalizedProjection = createWorkflowRegistryProjection(projection.id, discovery, { trustedCompute: projection.trustedCompute });
  if (projection.projectionSha256 !== normalizedProjection.projectionSha256) {
    throw new TransmuteCodeError("invalid-data", "Workflow registry projection hash does not match its normalized contents.", { projectionId: projection.id });
  }
  const validated = validateGraph(options.graph, normalizedProjection, limits);
  const graphSha256 = createWorkflowGraphHash(validated.graph);
  const unsigned = {
    envelope: deriveRequirementEnvelope(validated),
    graph: validated.graph,
    graphSha256,
    limits,
    projection: normalizedProjection,
    topologicalWaves: validated.topology.waves,
    version: WORKFLOW_COMPILATION_VERSION
  };
  return deepFreeze(parseCodeBoundary(CompiledWorkflowGraphSchema, {
    ...unsigned,
    compilationSha256: createWorkflowCompilationHash(unsigned)
  }, "compiled workflow graph"));
}
function parseCompiledWorkflowGraph(input) {
  const parsed = parseCodeBoundary(CompiledWorkflowGraphSchema, input, "compiled workflow graph");
  const expected = createWorkflowCompilationHash(parsed);
  if (parsed.compilationSha256 !== expected) {
    throw new TransmuteCodeError("invalid-data", "Workflow compilation hash does not match its contents.", {
      actualCompilationSha256: parsed.compilationSha256,
      expectedCompilationSha256: expected
    });
  }
  const recompiled = compileWorkflowGraph({
    graph: parsed.graph,
    limits: parsed.limits,
    projection: parsed.projection
  });
  if (canonicalJson(recompiled) !== canonicalJson(parsed)) {
    throw new TransmuteCodeError("invalid-data", "Workflow compilation topology, requirements, or projection do not match the graph.");
  }
  return recompiled;
}

// src/code/graph-builder.ts
var MAX_AUTHORING_VALUE_DEPTH = 128;
function discoveryKey(kind, version) {
  return `${kind}@${String(version)}`;
}
function providerDiscovery(provider) {
  const source = provider;
  if (typeof source.list === "function")
    return source.list();
  return provider.discovery;
}
function operationContractValue(discovery) {
  return Object.freeze({
    inputSchemaId: discovery.inputSchemaId,
    kind: discovery.kind,
    outputSchemaId: discovery.outputSchemaId,
    version: discovery.version
  });
}
function isPlainRecord(value) {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function cloneSerializedRef(reference) {
  return parseCodeBoundary(SerializedRefV1Schema, reference.serialized, "workflow reference");
}
function isOwnedRef(value, state) {
  return typeof value === "object" && value !== null && WORKFLOW_REF_BRAND in value && state.references.has(value);
}
function encodeInputValue(input, state, dependencies, ancestors, depth) {
  if (depth > MAX_AUTHORING_VALUE_DEPTH) {
    throw new TransmuteCodeError("invalid-data", `Workflow input nesting exceeds ${String(MAX_AUTHORING_VALUE_DEPTH)} levels.`);
  }
  if (isOwnedRef(input, state)) {
    const serialized = cloneSerializedRef(input);
    dependencies.add(serialized.$ref.nodeKey);
    return serialized;
  }
  if (typeof input === "object" && input !== null && WORKFLOW_REF_BRAND in input) {
    throw new TransmuteCodeError("invalid-data", "Use a typed Ref value created by this workflow graph builder.");
  }
  if (input === null || typeof input === "boolean" || typeof input === "string") {
    return input;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new TransmuteCodeError("invalid-data", "Workflow node input numbers must be finite.");
    }
    return Object.is(input, -0) ? 0 : input;
  }
  if (typeof input !== "object") {
    throw new TransmuteCodeError("invalid-data", `Workflow node input cannot contain ${typeof input} values.`);
  }
  if (ancestors.has(input)) {
    throw new TransmuteCodeError("invalid-data", "Workflow node input cannot contain cycles.");
  }
  ancestors.add(input);
  try {
    if (Array.isArray(input)) {
      return input.map((value) => encodeInputValue(value, state, dependencies, ancestors, depth + 1));
    }
    if (!isPlainRecord(input)) {
      throw new TransmuteCodeError("invalid-data", "Workflow node input accepts only JSON values and typed workflow references.");
    }
    if (Object.hasOwn(input, "$ref")) {
      throw new TransmuteCodeError("invalid-data", "Use a typed Ref value instead of constructing the reserved $ref field.");
    }
    const encoded = {};
    for (const key of Object.keys(input).sort()) {
      if (key === "__proto__") {
        throw new TransmuteCodeError("invalid-data", "Workflow inputs cannot contain the reserved __proto__ object key.");
      }
      encoded[key] = encodeInputValue(input[key], state, dependencies, ancestors, depth + 1);
    }
    return encoded;
  } finally {
    ancestors.delete(input);
  }
}
function encodeOperationInput(input, state) {
  const dependencies = new Set;
  const value = encodeInputValue(input, state, dependencies, new Set, 0);
  return {
    dependencies: [...dependencies].sort((left, right) => left.localeCompare(right)),
    value
  };
}
function encodeControlDependencies(after, state) {
  if (after === undefined)
    return [];
  const references = Array.isArray(after) ? after : [after];
  const dependencies = new Set;
  for (const reference of references) {
    if (!isOwnedRef(reference, state)) {
      throw new TransmuteCodeError("invalid-data", "Operation control dependencies must be typed Ref values created by this workflow graph builder.");
    }
    dependencies.add(cloneSerializedRef(reference).$ref.nodeKey);
  }
  return [...dependencies].sort((left, right) => left.localeCompare(right));
}
function combineDependencies(dataDependencies, controlDependencies) {
  return [...new Set([...dataDependencies, ...controlDependencies])].sort((left, right) => left.localeCompare(right));
}
function encodeOutputValue(output, state, ancestors, depth) {
  if (depth > MAX_AUTHORING_VALUE_DEPTH) {
    throw new TransmuteCodeError("invalid-data", `Workflow output nesting exceeds ${String(MAX_AUTHORING_VALUE_DEPTH)} levels.`);
  }
  if (isOwnedRef(output, state))
    return cloneSerializedRef(output);
  if (typeof output !== "object" || output === null) {
    throw new TransmuteCodeError("invalid-data", "Workflow outputs must contain only typed references, arrays, and named objects.");
  }
  if (ancestors.has(output)) {
    throw new TransmuteCodeError("invalid-data", "Workflow outputs cannot contain cycles.");
  }
  ancestors.add(output);
  try {
    if (Array.isArray(output)) {
      return output.map((value) => encodeOutputValue(value, state, ancestors, depth + 1));
    }
    if (!isPlainRecord(output)) {
      throw new TransmuteCodeError("invalid-data", "Workflow outputs accept only typed references, arrays, and plain objects.");
    }
    if (Object.hasOwn(output, "$ref")) {
      throw new TransmuteCodeError("invalid-data", "Use a typed Ref value instead of constructing the reserved $ref field.");
    }
    const encoded = {};
    for (const key of Object.keys(output).sort()) {
      if (key === "__proto__") {
        throw new TransmuteCodeError("invalid-data", "Workflow outputs cannot contain the reserved __proto__ object key.");
      }
      encoded[key] = encodeOutputValue(output[key], state, ancestors, depth + 1);
    }
    return encoded;
  } finally {
    ancestors.delete(output);
  }
}
function createReference(nodeKey, schemaId, state, path = []) {
  const reference = Object.freeze({
    [WORKFLOW_REF_BRAND]: () => {
      throw new TransmuteCodeError("internal", "A workflow reference type marker is not executable.");
    },
    at: (index) => {
      if (!Number.isSafeInteger(index) || index < 0) {
        throw new TransmuteCodeError("invalid-data", "Workflow reference array indexes must be nonnegative safe integers.");
      }
      return createReference(nodeKey, schemaId, state, [...path, index]);
    },
    select: (key) => {
      if (typeof key !== "string" || key.length < 1 || key.length > 128) {
        throw new TransmuteCodeError("invalid-data", "Workflow reference field names must contain 1\u2013128 characters.");
      }
      return createReference(nodeKey, schemaId, state, [...path, key]);
    },
    serialized: Object.freeze({
      $ref: Object.freeze({
        nodeKey,
        ...path.length === 0 ? {} : { path: [...path] },
        schemaId
      }),
      version: WORKFLOW_REF_VERSION
    })
  });
  state.references.add(reference);
  return reference;
}
function createState(provider) {
  const discovery = new Map;
  for (const input of providerDiscovery(provider)) {
    const item = parseCodeBoundary(OperationDiscoverySchema, input, "operation discovery entry");
    const key = discoveryKey(item.kind, item.version);
    if (discovery.has(key)) {
      throw new TransmuteCodeError("conflict", `Duplicate operation discovery entry: ${key}`, { kind: item.kind, version: item.version });
    }
    discovery.set(key, item);
  }
  return {
    computes: new Map,
    discovery,
    nodes: new Map,
    references: new WeakSet
  };
}
function defineWorkflowFragment(build) {
  return Object.freeze({ build });
}
function operationContract(provider, kind, version) {
  const discovery = providerDiscovery(provider).find((candidate) => candidate.kind === kind && candidate.version === version);
  if (discovery === undefined) {
    throw new TransmuteCodeError("unsupported-plan", `Unsupported operation: ${kind}@${String(version)}`, { kind, version });
  }
  return operationContractValue(discovery);
}

class WorkflowGraphBuilder {
  #namespace;
  #state;
  constructor(state, namespace) {
    this.#namespace = namespace;
    this.#state = state;
  }
  static create(provider) {
    return new WorkflowGraphBuilder(createState(provider), []);
  }
  namespace(segmentInput) {
    const segment = parseCodeBoundary(NodeKeySegmentSchema, segmentInput, "workflow namespace segment");
    return new WorkflowGraphBuilder(this.#state, [...this.#namespace, segment]);
  }
  fragment(namespace, fragment, input) {
    return fragment.build(this.namespace(namespace), input);
  }
  operation(keyInput, contract, input, options = {}) {
    return this.#addOperation(keyInput, {
      input,
      inputSchemaId: contract.inputSchemaId,
      kind: contract.kind,
      outputSchemaId: contract.outputSchemaId,
      version: contract.version
    }, options);
  }
  operationByKind(keyInput, request, options = {}) {
    const discovery = this.#state.discovery.get(discoveryKey(request.kind, request.version));
    if (discovery === undefined) {
      throw new TransmuteCodeError("unsupported-plan", `Unsupported operation: ${request.kind}@${String(request.version)}`, { kind: request.kind, version: request.version });
    }
    return this.#addOperation(keyInput, {
      input: request.input,
      inputSchemaId: discovery.inputSchemaId,
      kind: request.kind,
      outputSchemaId: discovery.outputSchemaId,
      version: request.version
    }, options);
  }
  compute(keyInput, definition, input, options = {}) {
    if (typeof definition !== "object" || definition === null || definition[TRUSTED_COMPUTE_BRAND] !== true) {
      throw new TransmuteCodeError("invalid-data", "Compute nodes require a definition created by defineCompute().");
    }
    const compute = parseCodeBoundary(AuthoredComputeIdentitySchema, {
      bounds: definition.bounds,
      key: definition.key,
      version: TRUSTED_COMPUTE_VERSION
    }, "trusted compute identity");
    const existing = this.#state.computes.get(compute.key);
    if (existing !== undefined && existing !== definition) {
      throw new TransmuteCodeError("conflict", `Duplicate trusted compute key: ${compute.key}`, { key: compute.key });
    }
    this.#state.computes.set(compute.key, definition);
    const key = this.#nodeKey(keyInput);
    const encoded = encodeOperationInput(input, this.#state);
    const controlDependencies = encodeControlDependencies(options.after, this.#state);
    const node = parseCodeBoundary(AuthoredGraphNodeV1Schema, {
      controlDependencies,
      dependencies: combineDependencies(encoded.dependencies, controlDependencies),
      executor: { compute, kind: "compute" },
      input: encoded.value,
      inputSchemaId: definition.inputSchemaId,
      key,
      ...options.label === undefined ? {} : { label: options.label },
      outputSchemaId: definition.outputSchemaId
    }, "authored compute node");
    this.#state.nodes.set(key, node);
    return createReference(key, definition.outputSchemaId, this.#state);
  }
  computeDefinitions() {
    return Object.freeze([...this.#state.computes.values()].sort((left, right) => left.key.localeCompare(right.key)));
  }
  build(workflowInput, outputs) {
    const workflow = parseCodeBoundary(WorkflowIdentitySchema, workflowInput, "workflow identity");
    return parseCodeBoundary(AuthoredWorkflowGraphV1Schema, {
      nodes: [...this.#state.nodes.values()].sort((left, right) => left.key.localeCompare(right.key)),
      outputs: encodeOutputValue(outputs, this.#state, new Set, 0),
      version: WORKFLOW_GRAPH_VERSION,
      workflow
    }, "authored workflow graph");
  }
  #nodeKey(keyInput) {
    const keySegment = parseCodeBoundary(NodeKeySegmentSchema, keyInput, "workflow node key segment");
    const key = [...this.#namespace, keySegment].join("/");
    if (this.#state.nodes.has(key)) {
      throw new TransmuteCodeError("conflict", `Duplicate workflow node key: ${key}`, { nodeKey: key });
    }
    return key;
  }
  #addOperation(keyInput, request, options) {
    const key = this.#nodeKey(keyInput);
    const discovery = this.#state.discovery.get(discoveryKey(request.kind, request.version));
    if (discovery === undefined) {
      throw new TransmuteCodeError("unsupported-plan", `Unsupported operation: ${request.kind}@${String(request.version)}`, { kind: request.kind, version: request.version });
    }
    if (request.inputSchemaId !== discovery.inputSchemaId || request.outputSchemaId !== discovery.outputSchemaId) {
      throw new TransmuteCodeError("invalid-data", `Operation contract schema mismatch for ${request.kind}@${String(request.version)}.`, {
        actualInputSchemaId: request.inputSchemaId,
        actualOutputSchemaId: request.outputSchemaId,
        expectedInputSchemaId: discovery.inputSchemaId,
        expectedOutputSchemaId: discovery.outputSchemaId,
        kind: request.kind,
        version: request.version
      });
    }
    const encoded = encodeOperationInput(request.input, this.#state);
    const controlDependencies = encodeControlDependencies(options.after, this.#state);
    const node = parseCodeBoundary(AuthoredGraphNodeV1Schema, {
      controlDependencies,
      dependencies: combineDependencies(encoded.dependencies, controlDependencies),
      executor: {
        kind: "operation",
        operation: { kind: discovery.kind, version: discovery.version }
      },
      input: encoded.value,
      inputSchemaId: discovery.inputSchemaId,
      key,
      ...options.label === undefined ? {} : { label: options.label },
      outputSchemaId: discovery.outputSchemaId
    }, "authored operation node");
    this.#state.nodes.set(key, node);
    return createReference(key, discovery.outputSchemaId, this.#state);
  }
}

// src/code/portable-builder.ts
function definePortableWorkflowFragment(build) {
  return Object.freeze({ build });
}

class PortableWorkflowBuilder {
  #builder;
  diagram;
  image;
  constructor(builder) {
    this.#builder = builder;
    this.diagram = Object.freeze({
      check: (key, input, options = {}) => this.#builder.operation(key, PORTABLE_TRANSMUTE_OPERATION_CONTRACTS["transmute.diagram.check"], input, options),
      render: (key, input, options = {}) => this.#builder.operation(key, PORTABLE_TRANSMUTE_OPERATION_CONTRACTS["transmute.diagram.render"], input, options)
    });
    this.image = Object.freeze({
      generate: (key, input, options = {}) => this.#builder.operation(key, PORTABLE_TRANSMUTE_OPERATION_CONTRACTS["transmute.image.generate"], input, options),
      vectorize: (key, input, options = {}) => this.#builder.operation(key, PORTABLE_TRANSMUTE_OPERATION_CONTRACTS["transmute.image.vectorize"], input, options)
    });
  }
  static create() {
    return new PortableWorkflowBuilder(WorkflowGraphBuilder.create(PUBLIC_WORKFLOW_REGISTRY_PROJECTION));
  }
  namespace(segment) {
    return new PortableWorkflowBuilder(this.#builder.namespace(segment));
  }
  fragment(namespace, fragment, input) {
    return fragment.build(this.namespace(namespace), input);
  }
  build(workflow, outputs) {
    return this.#builder.build(workflow, outputs);
  }
}

// src/code/define-workflow.ts
function workflowDefinitionIdentity(options) {
  if (typeof options.build !== "function") {
    throw new TransmuteCodeError("invalid-data", "Workflow definitions require a build function.");
  }
  const id = parseCodeBoundary(WorkflowIdSchema, options.id, "workflow id");
  const inputSchemaId = parseCodeBoundary(SchemaIdSchema, options.inputSchemaId, "workflow input schema id");
  if (!Number.isSafeInteger(options.version) || options.version < 1) {
    throw new TransmuteCodeError("invalid-data", "Workflow versions must be positive safe integers.");
  }
  return { id, inputSchemaId, version: options.version };
}
function defineWorkflow(options) {
  const identity = workflowDefinitionIdentity(options);
  return Object.freeze({
    build: options.build,
    id: identity.id,
    inputSchema: options.inputSchema,
    inputSchemaId: identity.inputSchemaId,
    version: identity.version
  });
}
function buildWorkflow(definition, input) {
  const parsedInput = parseCodeBoundary(definition.inputSchema, input, "workflow input");
  const workflowInput = parseCodeBoundary(JsonValueSchema, parsedInput, "JSON-safe workflow input");
  const builder = PortableWorkflowBuilder.create();
  const outputs = definition.build(builder, parsedInput);
  const graph = builder.build({
    id: definition.id,
    inputSchemaId: definition.inputSchemaId,
    version: definition.version
  }, outputs);
  return Object.freeze({
    graph,
    input: workflowInput,
    projection: PUBLIC_WORKFLOW_REGISTRY_PROJECTION
  });
}
var buildWorkflowGraph = buildWorkflow;
function defineCompute(options) {
  const key = parseCodeBoundary(ComputeKeySchema, options.key, "trusted compute key");
  const inputSchemaId = parseCodeBoundary(SchemaIdSchema, options.inputSchemaId, "trusted compute input schema id");
  const outputSchemaId = parseCodeBoundary(SchemaIdSchema, options.outputSchemaId, "trusted compute output schema id");
  const identity = parseCodeBoundary(AuthoredComputeIdentitySchema, {
    bounds: {
      maxDurationMs: options.maxDurationMs ?? 30000,
      maxInputBytes: options.maxInputBytes ?? Math.min(1024 * 1024, MAX_TRUSTED_COMPUTE_INPUT_BYTES),
      maxOutputBytes: options.maxOutputBytes ?? Math.min(1024 * 1024, MAX_TRUSTED_COMPUTE_OUTPUT_BYTES)
    },
    key,
    version: 1
  }, "trusted compute definition");
  if (identity.bounds.maxDurationMs > MAX_TRUSTED_COMPUTE_DURATION_MS) {
    throw new TransmuteCodeError("invalid-data", "Trusted compute duration exceeds the host maximum.");
  }
  return Object.freeze({
    [TRUSTED_COMPUTE_BRAND]: true,
    bounds: identity.bounds,
    inputSchema: options.inputSchema,
    inputSchemaId,
    key,
    outputSchema: options.outputSchema,
    outputSchemaId,
    run: options.run
  });
}
function defineAdvancedWorkflow(options) {
  const identity = workflowDefinitionIdentity(options);
  return Object.freeze({
    build: options.build,
    id: identity.id,
    inputSchema: options.inputSchema,
    inputSchemaId: identity.inputSchemaId,
    version: identity.version
  });
}
function buildAdvancedWorkflow(definition, provider, input) {
  const parsedInput = parseCodeBoundary(definition.inputSchema, input, "workflow input");
  const workflowInput = parseCodeBoundary(JsonValueSchema, parsedInput, "JSON-safe workflow input");
  const builder = WorkflowGraphBuilder.create(provider);
  const outputs = definition.build(builder, parsedInput);
  return Object.freeze({
    computeDefinitions: builder.computeDefinitions(),
    graph: builder.build({
      id: definition.id,
      inputSchemaId: definition.inputSchemaId,
      version: definition.version
    }, outputs),
    input: workflowInput
  });
}
function seconds(value) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TransmuteCodeError("invalid-data", "Seconds must be a finite nonnegative number.");
  }
  const microseconds = value * 1e6;
  if (!Number.isSafeInteger(microseconds)) {
    throw new TransmuteCodeError("invalid-data", "Seconds must resolve to an integer number of safe microseconds.");
  }
  return microseconds;
}

// src/code/runtime.ts
var WORKFLOW_NODE_RECEIPT_VERSION = "transmute-workflow-node-receipt-v1";
var WORKFLOW_NODE_RECEIPT_HASH_DOMAIN = "transmute.workflow.node-receipt/v1";
function createTransmuteCodeHost(options) {
  if (typeof options !== "object" || options === null) {
    throw new TransmuteCodeError("invalid-data", "A Transmute Code host must be an object.");
  }
  if (typeof options.execute !== "function") {
    throw new TransmuteCodeError("invalid-data", "A Transmute Code host requires an execute function.");
  }
  if (options.admit !== undefined && typeof options.admit !== "function") {
    throw new TransmuteCodeError("invalid-data", "A Transmute Code host admit value must be a function when provided.");
  }
  return Object.freeze({
    ...options.admit === undefined ? {} : { admit: options.admit },
    execute: options.execute
  });
}

class TransmuteWorkflowRunError extends TransmuteCodeError {
  completedReceipts;
  failedNode;
  runCause;
  constructor(code, message, options) {
    const failedNode = options.failedNode === undefined ? undefined : Object.freeze({ ...options.failedNode });
    const completedReceipts = Object.freeze([...options.completedReceipts]);
    super(code, message, {
      completedReceiptCount: completedReceipts.length,
      ...failedNode === undefined ? {} : { failedNode }
    });
    this.name = "TransmuteWorkflowRunError";
    this.completedReceipts = completedReceipts;
    this.failedNode = failedNode;
    this.runCause = options.cause;
  }
}
function isSerializedRef2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.hasOwn(value, "$ref");
}
function projectedValue(reference, values) {
  let current = values.get(reference.$ref.nodeKey);
  if (current === undefined) {
    throw new TransmuteCodeError("internal", `Workflow reference producer ${reference.$ref.nodeKey} has not completed.`, { nodeKey: reference.$ref.nodeKey });
  }
  for (const segment of reference.$ref.path ?? []) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) {
        throw new TransmuteCodeError("invalid-data", `Workflow reference ${reference.$ref.nodeKey} has an invalid array projection.`, { nodeKey: reference.$ref.nodeKey, segment });
      }
      const currentArray = current;
      current = currentArray[segment];
    } else {
      if (typeof current !== "object" || current === null || Array.isArray(current) || !Object.hasOwn(current, segment)) {
        throw new TransmuteCodeError("invalid-data", `Workflow reference ${reference.$ref.nodeKey} has an invalid object projection.`, { nodeKey: reference.$ref.nodeKey, segment });
      }
      current = current[segment];
    }
    if (current === undefined) {
      throw new TransmuteCodeError("invalid-data", `Workflow reference ${reference.$ref.nodeKey} projected an undefined value.`, { nodeKey: reference.$ref.nodeKey, segment });
    }
  }
  return current;
}
function resolveValue(value, values) {
  if (isSerializedRef2(value))
    return projectedValue(value, values);
  if (Array.isArray(value)) {
    const items = value;
    return items.map((item) => resolveValue(item, values));
  }
  if (typeof value === "object" && value !== null) {
    const record = value;
    const output = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined) {
        throw new TransmuteCodeError("internal", `Compiled workflow value ${key} is undefined.`);
      }
      output[key] = resolveValue(item, values);
    }
    return output;
  }
  return value;
}
function boundedJson(value, maximumBytes, name) {
  const parsed = parseCodeBoundary(JsonValueSchema, value, name);
  const bytes = new TextEncoder().encode(canonicalJson(parsed)).byteLength;
  if (bytes > maximumBytes) {
    throw new TransmuteCodeError("invalid-data", `${name} contains ${String(bytes)} bytes; the limit is ${String(maximumBytes)}.`, { actualBytes: bytes, maximumBytes });
  }
  return parsed;
}
function createNodeReceipt(index, nodeKey, kind, input, output) {
  const unsigned = {
    index,
    inputSha256: sha256Hex(canonicalJson(input)),
    kind,
    nodeKey,
    operationVersion: 2,
    outputSha256: sha256Hex(canonicalJson(output)),
    version: WORKFLOW_NODE_RECEIPT_VERSION
  };
  return Object.freeze({
    ...unsigned,
    receiptSha256: sha256Hex(`${WORKFLOW_NODE_RECEIPT_HASH_DOMAIN}\x00${canonicalJson(unsigned)}`)
  });
}
function publicOperationNode(node) {
  if (isComputeGraphNode(node)) {
    throw new TransmuteCodeError("unsupported-plan", `The public projection does not support trusted compute at node ${node.key}.`, {
      executorKind: "compute",
      nodeKey: node.key,
      projectionId: PUBLIC_WORKFLOW_REGISTRY_PROJECTION.id
    });
  }
  if (!isOperationGraphNode(node)) {
    throw new TransmuteCodeError("unsupported-plan", `The public projection does not support the executor at node ${node.key}.`, { nodeKey: node.key, projectionId: PUBLIC_WORKFLOW_REGISTRY_PROJECTION.id });
  }
  const operation = node.executor.operation;
  if (operation.version !== 2 || !isPortableTransmuteOperationKind(operation.kind)) {
    throw new TransmuteCodeError("unsupported-plan", `Unsupported operation: ${operation.kind}@${String(operation.version)}`, {
      kind: operation.kind,
      nodeKey: node.key,
      projectionId: PUBLIC_WORKFLOW_REGISTRY_PROJECTION.id,
      version: operation.version
    });
  }
}
function throwIfAborted(signal) {
  if (signal.aborted) {
    throw new TransmuteCodeError("cancelled", "Workflow execution was cancelled.");
  }
}
function workflowNodeFailure(error, node, completedReceipts) {
  const code = error instanceof TransmuteCodeError ? error.code : "subprocess";
  return new TransmuteWorkflowRunError(code, `Workflow node ${node.key} (${node.executor.operation.kind}@2) failed: ` + transmuteCodeErrorMessage(error), {
    cause: error,
    completedReceipts,
    failedNode: {
      kind: node.executor.operation.kind,
      nodeKey: node.key,
      version: 2
    }
  });
}
function workflowRunFailure(error, message, completedReceipts) {
  const code = error instanceof TransmuteCodeError ? error.code : "internal";
  return new TransmuteWorkflowRunError(code, message, {
    cause: error,
    completedReceipts
  });
}
async function executePublicNode(host, node, values, context) {
  const { kind } = node.executor.operation;
  const contract = PORTABLE_TRANSMUTE_OPERATION_CONTRACTS[kind];
  const resolvedInput = resolveValue(node.input, values);
  const parsedInput = parseCodeBoundary(contract.inputSchema, resolvedInput, `${kind} input at node ${node.key}`);
  const boundedInput = boundedJson(parsedInput, contract.policy.maxInputBytes, `${kind} input at node ${node.key}`);
  const request = {
    input: parsedInput,
    kind,
    nodeKey: node.key,
    version: 2
  };
  throwIfAborted(context.signal);
  const dispatch = async () => await host.execute(request, context);
  const rawOutput = host.admit === undefined ? await dispatch() : await host.admit({
    kind,
    nodeKey: node.key,
    policy: contract.policy,
    version: 2
  }, dispatch, context);
  const parsedOutput = parseCodeBoundary(contract.outputSchema, rawOutput, `${kind} output at node ${node.key}`);
  return {
    input: boundedInput,
    output: boundedJson(parsedOutput, contract.policy.maxOutputBytes, `${kind} output at node ${node.key}`)
  };
}
async function runBuiltWorkflow(built, options) {
  const compilation = compileWorkflowGraph({
    graph: built.graph,
    limits: options.limits,
    projection: PUBLIC_WORKFLOW_REGISTRY_PROJECTION
  });
  for (const node of compilation.graph.nodes)
    publicOperationNode(node);
  const host = createTransmuteCodeHost(options.host);
  const context = Object.freeze({
    signal: options.signal ?? new AbortController().signal
  });
  throwIfAborted(context.signal);
  const nodes = new Map(compilation.graph.nodes.map((node) => [node.key, node]));
  const values = new Map;
  const receipts = [];
  for (const wave of compilation.topologicalWaves) {
    const outcomes = await Promise.all(wave.map(async (nodeKey) => {
      const node = nodes.get(nodeKey);
      if (node === undefined) {
        throw new TransmuteCodeError("internal", `Compiled workflow topology lost node ${nodeKey}.`, { nodeKey });
      }
      publicOperationNode(node);
      try {
        return {
          executed: await executePublicNode(host, node, values, context),
          kind: "executed",
          node
        };
      } catch (error) {
        return { error, kind: "failed", node };
      }
    }));
    for (const outcome of outcomes) {
      if (outcome.kind !== "executed")
        continue;
      values.set(outcome.node.key, outcome.executed.output);
      receipts.push(createNodeReceipt(receipts.length, outcome.node.key, outcome.node.executor.operation.kind, outcome.executed.input, outcome.executed.output));
    }
    const failure = outcomes.find((outcome) => outcome.kind === "failed");
    if (failure !== undefined) {
      throw workflowNodeFailure(failure.error, failure.node, receipts);
    }
    if (context.signal.aborted) {
      const cause = new TransmuteCodeError("cancelled", "Workflow execution was cancelled.");
      throw workflowRunFailure(cause, "Workflow execution was cancelled after the current wave settled.", receipts);
    }
  }
  let output;
  try {
    output = parseCodeBoundary(JsonValueSchema, resolveValue(compilation.graph.outputs, values), "workflow output");
  } catch (error) {
    throw workflowRunFailure(error, `Workflow output resolution failed: ${transmuteCodeErrorMessage(error)}`, receipts);
  }
  return Object.freeze({
    compilation,
    output,
    receipts: Object.freeze(receipts)
  });
}
async function runWorkflow(definition, input, options) {
  return await runBuiltWorkflow(buildWorkflow(definition, input), options);
}

export { WORKFLOW_GRAPH_VERSION, WORKFLOW_REF_VERSION, GRAPH_ABI, REQUIREMENT_ENVELOPE_VERSION, TRUSTED_COMPUTE_VERSION, WORKFLOW_COMPILATION_VERSION, MAX_SERIALIZED_GRAPH_NODES, MAX_SERIALIZED_NODE_DEPENDENCIES, MAX_OPERATION_DISCOVERY_ENTRIES, MAX_TRUSTED_COMPUTE_INPUT_BYTES, MAX_TRUSTED_COMPUTE_OUTPUT_BYTES, MAX_TRUSTED_COMPUTE_DURATION_MS, WorkflowIdSchema, NodeKeySegmentSchema, NodeKeySchema, SchemaIdSchema, ComputeKeySchema, OperationKindSchema, Sha256Schema, PositiveSafeIntegerSchema, NonnegativeSafeIntegerSchema, RefPathSegmentSchema, JsonValueSchema, SerializedRefV1Schema, GraphInputValueSchema, WorkflowOutputBindingSchema, AuthoredOperationIdentitySchema, AuthoredComputeIdentitySchema, AuthoredNodeExecutorSchema, AuthoredGraphNodeV1Schema, isOperationGraphNode, isComputeGraphNode, WorkflowIdentitySchema, AuthoredWorkflowGraphV1Schema, OPERATION_EFFECT_CLASSES, WORKFLOW_EFFECT_CLASSES, OPERATION_RESUME_CLASSES, WORKFLOW_RESUME_CLASSES, OPERATION_PREPARATION_KINDS, OPERATION_LIFECYCLE_KINDS, OPERATION_RESOURCE_KINDS, OperationResourceClaimSchema, OperationPolicySchema, TrustedComputePolicySchema, WorkflowNodePolicySchema, trustedComputePolicy, OperationDiscoverySchema, WorkflowRegistryProjectionSchema, GraphCompilerLimitsSchema, UNRESOLVED_REQUIREMENT_KINDS, RequirementEnvelopeBoundsSchema, RequirementEnvelopeSchema, CompiledWorkflowGraphSchema, TRUSTED_COMPUTE_BRAND, WORKFLOW_REF_BRAND, TransmuteCodeError, transmuteCodeErrorMessage, asTransmuteCodeError, canonicalJson, sha256Hex, canonicalJsonSha256, TransmuteImageModelSchema, TransmuteDiagramCheckInputSchema, TransmuteDiagramRenderInputSchema, TransmuteImageVectorizeInputSchema, TransmuteImageGenerateInputSchema, TransmuteLintFindingSchema, TransmuteDiagramCheckOutputSchema, TransmuteRenderArtifactsSchema, TransmuteDiagramRenderOutputSchema, TransmuteVectorizeQualityReceiptSchema, TransmuteVectorizeProvenanceSchema, TransmuteVectorizeReceiptSchema, TransmuteImageVectorizeOutputSchema, TransmuteImageGenerateOutputSchema, PORTABLE_TRANSMUTE_OPERATION_KINDS, PORTABLE_TRANSMUTE_OPERATION_CONTRACTS, isPortableTransmuteOperationKind, WORKFLOW_REGISTRY_PROJECTION_HASH_DOMAIN, PUBLIC_WORKFLOW_REGISTRY_PROJECTION_ID, normalizeOperationDiscovery, createWorkflowRegistryProjectionHash, createWorkflowRegistryProjection, parseWorkflowRegistryProjection, createPublicWorkflowRegistryProjection, PUBLIC_WORKFLOW_REGISTRY_PROJECTION, PUBLIC_TRANSMUTE_WORKFLOW_PROJECTION, WORKFLOW_GRAPH_HASH_DOMAIN, WORKFLOW_COMPILATION_HASH_DOMAIN, DEFAULT_GRAPH_COMPILER_LIMITS, normalizeAuthoredWorkflowGraph, createWorkflowGraphHash, createGraphHash, createWorkflowCompilationHash, compileWorkflowGraph, parseCompiledWorkflowGraph, defineWorkflowFragment, operationContract, WorkflowGraphBuilder, definePortableWorkflowFragment, PortableWorkflowBuilder, defineWorkflow, buildWorkflow, buildWorkflowGraph, defineCompute, defineAdvancedWorkflow, buildAdvancedWorkflow, seconds, WORKFLOW_NODE_RECEIPT_VERSION, WORKFLOW_NODE_RECEIPT_HASH_DOMAIN, createTransmuteCodeHost, TransmuteWorkflowRunError, runBuiltWorkflow, runWorkflow };
