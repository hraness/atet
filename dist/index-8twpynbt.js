// @bun
// src/code/contracts.ts
import { z } from "zod";
var WORKFLOW_GRAPH_VERSION = "atet-workflow-graph-v2";
var WORKFLOW_REF_VERSION = "atet-workflow-ref-v1";
var GRAPH_ABI = "atet-workflow-graph-abi-v2";
var REQUIREMENT_ENVELOPE_VERSION = "atet-requirement-envelope-v2";
var TRUSTED_COMPUTE_VERSION = 1;
var WORKFLOW_COMPILATION_VERSION = "atet-workflow-compilation-v1";
var LEGACY_WORKFLOW_GRAPH_VERSION = "studio-workflow-graph-v2";
var LEGACY_WORKFLOW_REF_VERSION = "studio-workflow-ref-v1";
var LEGACY_GRAPH_ABI = "studio-workflow-graph-abi-v2";
var LEGACY_REQUIREMENT_ENVELOPE_VERSION = "studio-requirement-envelope-v2";
var LEGACY_WORKFLOW_COMPILATION_VERSION = "transmute-workflow-compilation-v1";
var MAX_SERIALIZED_GRAPH_NODES = 4096;
var MAX_SERIALIZED_NODE_DEPENDENCIES = 4096;
var MAX_SERIALIZED_REF_PATH_SEGMENTS = 32;
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
    path: z.array(RefPathSegmentSchema).max(MAX_SERIALIZED_REF_PATH_SEGMENTS).optional(),
    schemaId: SchemaIdSchema
  }),
  version: z.union([
    z.literal(WORKFLOW_REF_VERSION),
    z.literal(LEGACY_WORKFLOW_REF_VERSION)
  ])
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
  version: z.union([
    z.literal(WORKFLOW_GRAPH_VERSION),
    z.literal(LEGACY_WORKFLOW_GRAPH_VERSION)
  ]),
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
  version: z.union([
    z.literal(REQUIREMENT_ENVELOPE_VERSION),
    z.literal(LEGACY_REQUIREMENT_ENVELOPE_VERSION)
  ])
});
var CompiledWorkflowGraphSchema = z.strictObject({
  compilationSha256: Sha256Schema,
  envelope: RequirementEnvelopeSchema,
  graph: AuthoredWorkflowGraphV1Schema,
  graphSha256: Sha256Schema,
  limits: GraphCompilerLimitsSchema,
  projection: WorkflowRegistryProjectionSchema,
  topologicalWaves: z.array(z.array(NodeKeySchema).min(1)).max(MAX_SERIALIZED_GRAPH_NODES),
  version: z.union([
    z.literal(WORKFLOW_COMPILATION_VERSION),
    z.literal(LEGACY_WORKFLOW_COMPILATION_VERSION)
  ])
});
var TRUSTED_COMPUTE_BRAND = Symbol.for("atet.trusted-compute-definition");
var LEGACY_TRUSTED_COMPUTE_BRAND = Symbol.for("studio.trusted-compute-definition");
var WORKFLOW_REF_BRAND = Symbol.for("atet.workflow-ref");

// src/code/errors.ts
class AtetCodeError extends Error {
  code;
  details;
  constructor(code, message, details) {
    super(message);
    this.name = "AtetCodeError";
    this.code = code;
    this.details = details === undefined ? undefined : Object.freeze({ ...details });
  }
}
function atetCodeErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function asAtetCodeError(error) {
  if (error instanceof AtetCodeError)
    return error;
  return new AtetCodeError("internal", atetCodeErrorMessage(error));
}
var transmuteCodeErrorMessage = atetCodeErrorMessage;
var asTransmuteCodeError = asAtetCodeError;

// src/code/sha256.ts
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
var UTF8_ENCODER = new TextEncoder;
function createSha256HexHasher() {
  if (typeof Bun !== "undefined") {
    const hasher2 = new Bun.CryptoHasher("sha256");
    return {
      digestHex: () => hasher2.digest("hex"),
      update: (input) => {
        hasher2.update(input);
      }
    };
  }
  const hasher = sha256.create();
  return {
    digestHex: () => bytesToHex(hasher.digest()),
    update: (input) => {
      hasher.update(typeof input === "string" ? UTF8_ENCODER.encode(input) : input);
    }
  };
}
function sha256Hex(input) {
  const hasher = createSha256HexHasher();
  hasher.update(input);
  return hasher.digestHex();
}

// src/code/json-utf8.ts
function jsonStringUtf8ByteLength(value, maximumBytes = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    return;
  let bytes = 2;
  if (bytes > maximumBytes)
    return;
  for (let index = 0;index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    let additional;
    if (codeUnit === 34 || codeUnit === 92 || codeUnit === 8 || codeUnit === 9 || codeUnit === 10 || codeUnit === 12 || codeUnit === 13) {
      additional = 2;
    } else if (codeUnit < 32) {
      additional = 6;
    } else if (codeUnit < 128) {
      additional = 1;
    } else if (codeUnit < 2048) {
      additional = 2;
    } else if (codeUnit >= 55296 && codeUnit <= 56319) {
      const next = value.charCodeAt(index + 1);
      if (next >= 56320 && next <= 57343) {
        additional = 4;
        index += 1;
      } else {
        additional = 6;
      }
    } else if (codeUnit >= 56320 && codeUnit <= 57343) {
      additional = 6;
    } else {
      additional = 3;
    }
    if (additional > maximumBytes - bytes)
      return;
    bytes += additional;
  }
  return bytes;
}
function utf8ByteLength(value, maximumBytes = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0)
    return;
  let bytes = 0;
  for (let index = 0;index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    let additional;
    if (codeUnit < 128) {
      additional = 1;
    } else if (codeUnit < 2048) {
      additional = 2;
    } else if (codeUnit >= 55296 && codeUnit <= 56319) {
      const next = value.charCodeAt(index + 1);
      if (next >= 56320 && next <= 57343) {
        additional = 4;
        index += 1;
      } else {
        additional = 3;
      }
    } else {
      additional = 3;
    }
    if (additional > maximumBytes - bytes)
      return;
    bytes += additional;
  }
  return bytes;
}

// src/code/json-snapshot.ts
var DEFAULT_MAXIMUM_DEPTH = 128;
var DEFAULT_MAXIMUM_VALUES = 1e6;
var HASH_BUFFER_CODE_UNITS = 64 * 1024;
function invalidJson(message, details) {
  throw new AtetCodeError("invalid-data", message, details);
}
function positiveLimit(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    return invalidJson(`${name} must be a positive safe integer.`);
  }
  return value;
}
function enumerableSymbolDescriptor(descriptors) {
  return Object.getOwnPropertySymbols(descriptors).some((symbol) => Reflect.get(descriptors, symbol)?.enumerable === true);
}
function captureJsonStructure(input, name, limits = {}) {
  const maximumDepth = positiveLimit(limits.maximumDepth ?? DEFAULT_MAXIMUM_DEPTH, "JSON structure depth limit");
  const maximumValues = positiveLimit(limits.maximumValues ?? DEFAULT_MAXIMUM_VALUES, "JSON structure value limit");
  const maximumBytes = limits.maximumBytes === undefined ? undefined : positiveLimit(limits.maximumBytes, "JSON structure byte limit");
  const active = new WeakSet;
  const pending = [{ depth: 0, kind: "visit", value: input }];
  let bytes = 0;
  let discoveredValues = 1;
  let root;
  let rootAssigned = false;
  const addBytes = (additional) => {
    if (maximumBytes === undefined)
      return;
    if (additional > maximumBytes - bytes) {
      return invalidJson(`${name} contains more than ${String(maximumBytes)} bytes.`, { actualLowerBound: bytes + additional, maximumBytes });
    }
    bytes += additional;
  };
  const addJsonString = (value) => {
    if (maximumBytes === undefined)
      return;
    const additional = jsonStringUtf8ByteLength(value, maximumBytes - bytes);
    if (additional === undefined) {
      return invalidJson(`${name} contains more than ${String(maximumBytes)} bytes.`, { actualLowerBound: maximumBytes + 1, maximumBytes });
    }
    bytes += additional;
  };
  const discover = (additional) => {
    if (additional > maximumValues - discoveredValues) {
      return invalidJson(`${name} contains more than ${String(maximumValues)} structural values.`, { actualLowerBound: discoveredValues + additional, maximumValues });
    }
    discoveredValues += additional;
  };
  const assign = (assignment, value) => {
    if (assignment === undefined) {
      root = value;
      rootAssigned = true;
      return;
    }
    Object.defineProperty(assignment.target, assignment.key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true
    });
  };
  try {
    while (pending.length > 0) {
      const frame = pending.pop();
      if (frame === undefined)
        continue;
      if (frame.kind === "exit") {
        active.delete(frame.source);
        continue;
      }
      if (frame.depth > maximumDepth) {
        return invalidJson(`${name} nesting exceeds ${String(maximumDepth)} levels.`, { actual: frame.depth, maximumDepth });
      }
      const value = frame.value;
      if (typeof value === "string") {
        addJsonString(value);
        assign(frame.assignment, value);
        continue;
      }
      if (value === null) {
        addBytes(4);
        assign(frame.assignment, value);
        continue;
      }
      if (typeof value === "boolean") {
        addBytes(value ? 4 : 5);
        assign(frame.assignment, value);
        continue;
      }
      if (typeof value === "number") {
        if (Number.isFinite(value)) {
          addBytes(JSON.stringify(Object.is(value, -0) ? 0 : value).length);
        }
        assign(frame.assignment, value);
        continue;
      }
      if (typeof value !== "object") {
        assign(frame.assignment, value);
        continue;
      }
      const isArray = Array.isArray(value);
      if (!isArray) {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
          assign(frame.assignment, value);
          continue;
        }
      }
      if (active.has(value)) {
        return invalidJson(`${name} does not support cyclic plain-container values.`);
      }
      const arrayLength = isArray ? value.length : undefined;
      if (arrayLength !== undefined && arrayLength > maximumValues - discoveredValues) {
        return invalidJson(`${name} contains more than ${String(maximumValues)} structural values.`, { actualLowerBound: discoveredValues + arrayLength, maximumValues });
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Object.getOwnPropertySymbols(descriptors).some((symbol) => Reflect.get(descriptors, symbol)?.enumerable === true)) {
        return invalidJson(`${name} cannot contain enumerable symbol properties.`);
      }
      const keys = Object.keys(descriptors).filter((key) => descriptors[key]?.enumerable === true);
      const namedArrayKeys = arrayLength === undefined ? [] : keys.filter((key) => {
        const index = Number(key);
        return !(Number.isSafeInteger(index) && index >= 0 && index < arrayLength && String(index) === key);
      });
      if (arrayLength !== undefined) {
        discover(arrayLength);
        discover(namedArrayKeys.length);
        addBytes(2 + Math.max(0, arrayLength - 1));
        for (const key of namedArrayKeys) {
          addJsonString(key);
          addBytes(1);
        }
      } else {
        discover(keys.length);
        addBytes(2 + Math.max(0, keys.length - 1));
        for (const key of keys) {
          addJsonString(key);
          addBytes(1);
        }
      }
      const clone = arrayLength === undefined ? {} : new Array(arrayLength);
      assign(frame.assignment, clone);
      active.add(value);
      pending.push({ kind: "exit", source: value });
      for (let index = keys.length - 1;index >= 0; index -= 1) {
        const key = keys[index];
        if (key === undefined)
          continue;
        const descriptor = descriptors[key];
        if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
          return invalidJson(`${name} properties must be plain data properties.`);
        }
        const numericKey = arrayLength !== undefined && Number.isSafeInteger(Number(key)) && Number(key) >= 0 && Number(key) < arrayLength && String(Number(key)) === key ? Number(key) : key;
        pending.push({
          assignment: { key: numericKey, target: clone },
          depth: frame.depth + 1,
          kind: "visit",
          value: descriptor.value
        });
      }
    }
  } catch (error) {
    if (error instanceof AtetCodeError)
      throw error;
    throw new AtetCodeError("invalid-data", `${name} could not be safely inspected.`, { cause: error instanceof Error ? error.message : String(error) });
  }
  if (!rootAssigned) {
    return invalidJson(`${name} did not contain a capturable value.`);
  }
  return root;
}
function assignValue(assignment, value, setRoot) {
  if (assignment === undefined) {
    setRoot(value);
    return;
  }
  if (Array.isArray(assignment.target)) {
    assignment.target[assignment.key] = value;
  } else {
    Object.defineProperty(assignment.target, assignment.key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true
    });
  }
}
function scalarJson(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return invalidJson("JSON snapshots do not support non-finite numbers.");
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  return JSON.stringify(value);
}
function captureBoundedJson(input, maximumBytesInput, name, limits = {}, capture) {
  const maximumBytes = positiveLimit(maximumBytesInput, "JSON snapshot byte limit");
  const maximumDepth = positiveLimit(limits.maximumDepth ?? DEFAULT_MAXIMUM_DEPTH, "JSON snapshot depth limit");
  const maximumValues = positiveLimit(limits.maximumValues ?? DEFAULT_MAXIMUM_VALUES, "JSON snapshot value limit");
  const active = new WeakSet;
  const hash = capture.hash ? createSha256HexHasher() : undefined;
  let hashPart = capture.hashPrefix ?? "";
  const flushHash = () => {
    if (hash === undefined || hashPart.length === 0)
      return;
    hash.update(hashPart);
    hashPart = "";
  };
  const captureCanonicalText = capture.captureText;
  const canonicalParts = [];
  let canonicalPart = "";
  const pending = [{ depth: 0, kind: "visit", value: input }];
  let bytes = 0;
  let discoveredValues = 1;
  let root;
  const append = (text, exactBytes = text.length) => {
    if (exactBytes > maximumBytes - bytes) {
      return invalidJson(`${name} contains more than ${String(maximumBytes)} bytes.`, { actualLowerBound: bytes + exactBytes, maximumBytes });
    }
    if (hash !== undefined) {
      hashPart += text;
      if (hashPart.length >= HASH_BUFFER_CODE_UNITS)
        flushHash();
    }
    if (captureCanonicalText) {
      canonicalPart += text;
      if (canonicalPart.length >= 64 * 1024) {
        canonicalParts.push(canonicalPart);
        canonicalPart = "";
      }
    }
    bytes += exactBytes;
  };
  const discover = (additional) => {
    if (additional > maximumValues - discoveredValues) {
      return invalidJson(`${name} contains more than ${String(maximumValues)} JSON values.`, { actualLowerBound: discoveredValues + additional, maximumValues });
    }
    discoveredValues += additional;
  };
  const setRoot = (value) => {
    root = value;
  };
  try {
    while (pending.length > 0) {
      const frame = pending.pop();
      if (frame === undefined)
        break;
      if (frame.kind === "array") {
        if (frame.index === frame.values) {
          append("]");
          active.delete(frame.source);
          if (frame.clone !== undefined)
            Object.freeze(frame.clone);
          continue;
        }
        if (frame.index > 0)
          append(",");
        const descriptor = frame.descriptors[String(frame.index)];
        if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
          return invalidJson(`${name} arrays must contain plain data elements.`);
        }
        pending.push({ ...frame, index: frame.index + 1 });
        pending.push({
          ...frame.clone === undefined ? {} : { assignment: { key: frame.index, target: frame.clone } },
          depth: frame.depth + 1,
          kind: "visit",
          value: descriptor.value
        });
        continue;
      }
      if (frame.kind === "object") {
        if (frame.index === frame.keys.length) {
          append("}");
          active.delete(frame.source);
          if (frame.clone !== undefined)
            Object.freeze(frame.clone);
          continue;
        }
        const key = frame.keys[frame.index];
        if (key === undefined) {
          return invalidJson(`${name} lost an object key during traversal.`);
        }
        if (frame.index > 0)
          append(",");
        const keyBytes = jsonStringUtf8ByteLength(key, maximumBytes - bytes);
        if (keyBytes === undefined) {
          return invalidJson(`${name} contains more than ${String(maximumBytes)} bytes.`, { actualLowerBound: maximumBytes + 1, maximumBytes });
        }
        append(scalarJson(key), keyBytes);
        append(":");
        const descriptor = frame.descriptors[key];
        if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
          return invalidJson(`${name} properties must be plain data properties.`);
        }
        pending.push({ ...frame, index: frame.index + 1 });
        pending.push({
          ...frame.clone === undefined ? {} : { assignment: { key, target: frame.clone } },
          depth: frame.depth + 1,
          kind: "visit",
          value: descriptor.value
        });
        continue;
      }
      if (frame.depth > maximumDepth) {
        return invalidJson(`${name} nesting exceeds ${String(maximumDepth)} levels.`, { actual: frame.depth, maximumDepth });
      }
      const value = frame.value;
      if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
        const normalized = typeof value === "number" && Object.is(value, -0) ? 0 : value;
        if (typeof value === "string") {
          const stringBytes = jsonStringUtf8ByteLength(value, maximumBytes - bytes);
          if (stringBytes === undefined) {
            return invalidJson(`${name} contains more than ${String(maximumBytes)} bytes.`, { actualLowerBound: maximumBytes + 1, maximumBytes });
          }
          append(scalarJson(value), stringBytes);
        } else {
          append(scalarJson(value));
        }
        if (capture.captureValue) {
          assignValue(frame.assignment, normalized, setRoot);
        }
        continue;
      }
      if (typeof value !== "object") {
        return invalidJson(`${name} does not support ${typeof value} values.`);
      }
      if (active.has(value)) {
        return invalidJson(`${name} does not support cyclic values.`);
      }
      const arrayLength = Array.isArray(value) ? value.length : undefined;
      if (arrayLength !== undefined && arrayLength > maximumValues - discoveredValues) {
        return invalidJson(`${name} contains more than ${String(maximumValues)} JSON values.`, {
          actualLowerBound: discoveredValues + arrayLength,
          maximumValues
        });
      }
      if (arrayLength !== undefined) {
        const punctuationBytes = 2 + Math.max(0, arrayLength - 1);
        if (punctuationBytes > maximumBytes - bytes) {
          return invalidJson(`${name} contains more than ${String(maximumBytes)} bytes.`, { actualLowerBound: bytes + punctuationBytes, maximumBytes });
        }
      }
      active.add(value);
      if (Array.isArray(value)) {
        const length = arrayLength;
        if (length === undefined) {
          return invalidJson(`${name} lost an array length during traversal.`);
        }
        discoveredValues += length;
        const descriptors2 = Object.getOwnPropertyDescriptors(value);
        if (!capture.ignoreNonIndexArrayProperties) {
          if (enumerableSymbolDescriptor(descriptors2)) {
            return invalidJson(`${name} cannot contain enumerable symbol properties.`);
          }
          const keys2 = Object.keys(descriptors2).filter((key) => descriptors2[key]?.enumerable === true);
          if (keys2.length !== length || keys2.some((key, index) => key !== String(index))) {
            return invalidJson(`${name} arrays must be dense and cannot have named properties.`);
          }
        }
        const clone2 = capture.captureValue ? [] : undefined;
        if (clone2 !== undefined)
          assignValue(frame.assignment, clone2, setRoot);
        append("[");
        pending.push({
          clone: clone2,
          depth: frame.depth,
          descriptors: descriptors2,
          index: 0,
          kind: "array",
          source: value,
          values: length
        });
        continue;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        return invalidJson(`${name} accepts only arrays and plain objects.`);
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (enumerableSymbolDescriptor(descriptors)) {
        return invalidJson(`${name} cannot contain enumerable symbol properties.`);
      }
      const keys = Object.keys(descriptors).filter((key) => descriptors[key]?.enumerable === true).sort();
      discover(keys.length);
      const clone = capture.captureValue ? {} : undefined;
      if (clone !== undefined)
        assignValue(frame.assignment, clone, setRoot);
      append("{");
      pending.push({
        clone,
        depth: frame.depth,
        descriptors,
        index: 0,
        keys,
        kind: "object",
        source: value
      });
    }
  } catch (error) {
    if (error instanceof AtetCodeError)
      throw error;
    throw new AtetCodeError("invalid-data", `${name} could not be safely inspected.`, { cause: error instanceof Error ? error.message : String(error) });
  }
  if (capture.captureValue && root === undefined) {
    return invalidJson(`${name} did not contain a JSON value.`);
  }
  if (captureCanonicalText && canonicalPart.length > 0) {
    canonicalParts.push(canonicalPart);
  }
  flushHash();
  return Object.freeze({
    bytes,
    ...captureCanonicalText ? { canonicalText: canonicalParts.join("") } : {},
    ...hash === undefined ? {} : { sha256: hash.digestHex() },
    ...capture.captureValue ? { value: root } : {},
    values: discoveredValues
  });
}
function createBoundedJsonValueSnapshot(input, maximumBytesInput, name, limits = {}) {
  const captured = captureBoundedJson(input, maximumBytesInput, name, limits, {
    captureText: false,
    captureValue: true,
    hash: false,
    ignoreNonIndexArrayProperties: false
  });
  if (captured.value === undefined) {
    return invalidJson(`${name} did not produce a complete JSON value snapshot.`);
  }
  return captured;
}
function createBoundedJsonSnapshot(input, maximumBytesInput, name, limits = {}) {
  const captured = captureBoundedJson(input, maximumBytesInput, name, limits, {
    captureText: limits.captureCanonicalText === true,
    captureValue: true,
    hash: true,
    ignoreNonIndexArrayProperties: false
  });
  if (captured.sha256 === undefined || captured.value === undefined) {
    return invalidJson(`${name} did not produce a complete JSON snapshot.`);
  }
  return captured;
}
function createBoundedCanonicalJson(input, maximumBytesInput, name, limits = {}) {
  const captured = captureBoundedJson(input, maximumBytesInput, name, limits, {
    captureText: true,
    captureValue: false,
    hash: false,
    ignoreNonIndexArrayProperties: true
  });
  if (captured.canonicalText === undefined) {
    return invalidJson(`${name} did not produce canonical JSON text.`);
  }
  return captured.canonicalText;
}
function createBoundedCanonicalFingerprint(input, maximumBytesInput, name, limits = {}, hashPrefix) {
  const captured = captureBoundedJson(input, maximumBytesInput, name, limits, {
    captureText: false,
    captureValue: false,
    hash: true,
    ignoreNonIndexArrayProperties: true,
    ...hashPrefix === undefined ? {} : { hashPrefix }
  });
  if (captured.sha256 === undefined) {
    return invalidJson(`${name} did not produce a canonical JSON identity.`);
  }
  return Object.freeze({ bytes: captured.bytes, sha256: captured.sha256 });
}
function createBoundedCanonicalSha256(input, maximumBytesInput, name, limits = {}, hashPrefix) {
  return createBoundedCanonicalFingerprint(input, maximumBytesInput, name, limits, hashPrefix).sha256;
}
function deepFreezeJson(value) {
  const active = new WeakSet;
  const completed = new WeakSet;
  const pending = [{ exiting: false, value }];
  try {
    while (pending.length > 0) {
      const item = pending.pop();
      if (item === undefined)
        break;
      const current = item.value;
      if (current === null || typeof current === "boolean" || typeof current === "string") {
        continue;
      }
      if (typeof current === "number") {
        if (!Number.isFinite(current)) {
          return invalidJson("JSON snapshots do not support non-finite numbers.");
        }
        continue;
      }
      if (typeof current !== "object") {
        return invalidJson(`JSON snapshots do not support ${typeof current} values.`);
      }
      if (item.exiting) {
        active.delete(current);
        completed.add(current);
        Object.freeze(current);
        continue;
      }
      if (completed.has(current))
        continue;
      if (active.has(current)) {
        return invalidJson("JSON snapshots do not support cycles.");
      }
      active.add(current);
      pending.push({ exiting: true, value: current });
      if (Array.isArray(current)) {
        const length = current.length;
        const descriptors2 = Object.getOwnPropertyDescriptors(current);
        if (enumerableSymbolDescriptor(descriptors2)) {
          return invalidJson("JSON snapshots cannot contain enumerable symbol properties.");
        }
        const keys2 = Object.keys(descriptors2).filter((key) => descriptors2[key]?.enumerable === true);
        if (keys2.length !== length || keys2.some((key, index) => key !== String(index))) {
          return invalidJson("JSON snapshot arrays must be dense and cannot have named properties.");
        }
        for (let index = length - 1;index >= 0; index -= 1) {
          const descriptor = descriptors2[String(index)];
          if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
            return invalidJson("JSON snapshot arrays must contain plain data elements.");
          }
          pending.push({ exiting: false, value: descriptor.value });
        }
        continue;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        return invalidJson("JSON snapshots accept only arrays and plain objects.");
      }
      const descriptors = Object.getOwnPropertyDescriptors(current);
      if (enumerableSymbolDescriptor(descriptors)) {
        return invalidJson("JSON snapshots cannot contain enumerable symbol properties.");
      }
      const keys = Object.keys(descriptors).filter((key) => descriptors[key]?.enumerable === true);
      for (let index = keys.length - 1;index >= 0; index -= 1) {
        const key = keys[index];
        if (key === undefined)
          continue;
        const descriptor = descriptors[key];
        if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
          return invalidJson("JSON snapshot properties must be plain data properties.");
        }
        if (descriptor.value === undefined) {
          return invalidJson(`JSON snapshot property ${key} is undefined.`);
        }
        pending.push({ exiting: false, value: descriptor.value });
      }
    }
  } catch (error) {
    if (error instanceof AtetCodeError)
      throw error;
    throw new AtetCodeError("invalid-data", "JSON snapshot could not be safely inspected.", { cause: error instanceof Error ? error.message : String(error) });
  }
  return value;
}

// src/code/canonical-json.ts
var MAX_CANONICAL_JSON_BYTES = Number.MAX_SAFE_INTEGER;
var MAX_CANONICAL_JSON_DEPTH = Number.MAX_SAFE_INTEGER;
var MAX_CANONICAL_JSON_VALUES = Number.MAX_SAFE_INTEGER;
function compareUtf16Strings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function canonicalLimits(bounds) {
  return {
    maximumDepth: bounds?.maximumDepth ?? MAX_CANONICAL_JSON_DEPTH,
    maximumValues: bounds?.maximumValues ?? MAX_CANONICAL_JSON_VALUES
  };
}
function boundedCanonicalJson(value, bounds) {
  return createBoundedCanonicalJson(value, bounds.maximumBytes, bounds.name ?? "Canonical JSON", canonicalLimits(bounds));
}
function boundedCanonicalJsonSha256(value, bounds, hashPrefix) {
  return createBoundedCanonicalSha256(value, bounds.maximumBytes, bounds.name ?? "Canonical JSON", canonicalLimits(bounds), hashPrefix);
}
function boundedCanonicalJsonFingerprint(value, bounds, hashPrefix) {
  return createBoundedCanonicalFingerprint(value, bounds.maximumBytes, bounds.name ?? "Canonical JSON", canonicalLimits(bounds), hashPrefix);
}
function canonicalJson(value) {
  return boundedCanonicalJson(value, {
    maximumBytes: MAX_CANONICAL_JSON_BYTES
  });
}
function canonicalJsonSha256(value) {
  return boundedCanonicalJsonSha256(value, {
    maximumBytes: MAX_CANONICAL_JSON_BYTES
  });
}
function canonicalJsonSha256Prefixed(prefix, value) {
  return boundedCanonicalJsonSha256(value, { maximumBytes: MAX_CANONICAL_JSON_BYTES }, prefix);
}
function canonicalJsonFingerprint(value, hashPrefix) {
  return boundedCanonicalJsonFingerprint(value, { maximumBytes: MAX_CANONICAL_JSON_BYTES }, hashPrefix);
}

// src/code/public-operations.ts
import { z as z2 } from "zod";
var MAX_PATH_CHARACTERS = 4096;
var MAX_PROMPT_BYTES = 32 * 1024;
var MAX_GENERATED_IMAGE_BYTES = 64 * 1024 * 1024;
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
var AtetImageModelSchema = z2.string().min(3).max(256).regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/iu);
var AtetDiagramCheckInputSchema = z2.strictObject({
  path: BoundedPathSchema
});
var AtetDiagramRenderInputSchema = schemaWithReadonlyOutput(z2.strictObject({
  outDirectory: BoundedPathSchema.optional(),
  path: BoundedPathSchema,
  scale: z2.number().finite().positive().max(4).optional()
}));
var AtetImageVectorizeInputSchema = schemaWithReadonlyOutput(z2.strictObject({
  alphaCutoff: z2.number().int().min(1).max(64).optional(),
  duotone: z2.tuple([
    z2.string().regex(/^#[a-f0-9]{3}(?:[a-f0-9]{3})?$/iu),
    z2.string().regex(/^#[a-f0-9]{3}(?:[a-f0-9]{3})?$/iu)
  ]).optional(),
  inputPath: BoundedPathSchema,
  outputPath: BoundedPathSchema.refine((value) => value.toLowerCase().endsWith(".svg"), "Vector output paths must end in .svg."),
  timeoutMs: z2.number().int().min(1).max(300000).optional()
}));
var PromptSchema = z2.string().superRefine((value, context) => {
  if (utf8ByteLength(value, MAX_PROMPT_BYTES) === undefined) {
    context.addIssue({
      code: "custom",
      message: `Prompts must contain at most ${String(MAX_PROMPT_BYTES)} UTF-8 bytes.`
    });
    return;
  }
  if (value.trim().length === 0) {
    context.addIssue({ code: "custom", message: "Prompts must not be blank." });
    return;
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    context.addIssue({
      code: "custom",
      message: "Prompts must not contain control characters."
    });
  }
});
var AtetImageGenerateInputSchema = schemaWithReadonlyOutput(z2.strictObject({
  model: AtetImageModelSchema,
  outputPath: BoundedPathSchema.refine((value) => /\.(?:jpe?g|png|webp)$/iu.test(value), "Generated image output paths must end in .png, .jpg, .jpeg, or .webp."),
  prompt: PromptSchema
}));
var AtetLintFindingSchema = z2.strictObject({
  code: z2.string().min(1).max(160),
  message: z2.string().min(1).max(4096),
  shapeIds: z2.array(z2.string().min(1).max(256)).max(4096)
});
var AtetDiagramCheckOutputSchema = z2.strictObject({
  configPath: z2.null(),
  findings: z2.array(AtetLintFindingSchema).max(4096)
});
var AtetRenderArtifactsSchema = z2.strictObject({
  darkPng: BoundedPathSchema,
  darkSvg: BoundedPathSchema,
  lightPng: BoundedPathSchema,
  lightSvg: BoundedPathSchema,
  spec: BoundedPathSchema,
  tldr: BoundedPathSchema
});
var AtetDiagramRenderOutputSchema = z2.strictObject({
  artifacts: AtetRenderArtifactsSchema,
  configPath: z2.null(),
  findings: z2.array(AtetLintFindingSchema).max(4096)
});
var AtetVectorizeQualityReceiptSchema = z2.strictObject({
  alphaRmse: z2.number().finite().nonnegative(),
  colorRmse: z2.number().finite().nonnegative(),
  outsideAlphaRatio: z2.number().finite().min(0).max(1),
  sampleHeight: PositiveSafeIntegerSchema2,
  sampleWidth: PositiveSafeIntegerSchema2,
  supportRecall: z2.number().finite().min(0).max(1)
});
var AtetVectorizeProvenanceSchema = z2.strictObject({
  arch: BoundedVersionStringSchema,
  platform: BoundedVersionStringSchema,
  sharp: BoundedVersionStringSchema,
  sharpVersions: z2.record(z2.string().min(1).max(128), BoundedVersionStringSchema),
  vips: BoundedVersionStringSchema,
  vtracerSha256: Sha256Schema2,
  vtracerSource: z2.enum(["official-release", "override"]),
  vtracerVersion: BoundedVersionStringSchema
});
var AtetVectorizeReceiptSchema = z2.strictObject({
  alphaCutoff: z2.number().int().min(1).max(64),
  bytes: NonnegativeSafeIntegerSchema2.max(MAX_VECTOR_OUTPUT_BYTES),
  candidatesEvaluated: PositiveSafeIntegerSchema2,
  format: z2.string().min(1).max(80),
  height: PositiveSafeIntegerSchema2.max(4096),
  inputBytes: PositiveSafeIntegerSchema2.max(MAX_VECTOR_INPUT_BYTES),
  outputMode: z2.enum(["color", "duotone"]),
  pathCount: NonnegativeSafeIntegerSchema2.max(12000),
  profile: z2.enum(["balanced", "detailed", "photo"]),
  provenance: AtetVectorizeProvenanceSchema,
  quality: AtetVectorizeQualityReceiptSchema,
  receiptVersion: z2.literal(1),
  representation: z2.enum(["color-paths", "alpha-mask"]),
  sourceSha256: Sha256Schema2,
  svgSha256: Sha256Schema2,
  width: PositiveSafeIntegerSchema2.max(4096)
});
var AtetImageVectorizeOutputSchema = z2.strictObject({
  outputPath: BoundedPathSchema,
  receipt: AtetVectorizeReceiptSchema
});
var AtetImageGenerateOutputSchema = z2.strictObject({
  bytes: PositiveSafeIntegerSchema2.max(MAX_GENERATED_IMAGE_BYTES),
  mediaType: z2.enum(["image/jpeg", "image/png", "image/webp"]),
  model: AtetImageModelSchema,
  outputPath: BoundedPathSchema,
  provider: z2.literal("vercel-ai-gateway"),
  requestId: z2.string().min(1).max(256).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "Request ids must not contain control characters."),
  sha256: Sha256Schema2,
  warnings: z2.array(z2.string().min(1).max(256)).max(100)
});
var PORTABLE_ATET_OPERATION_KINDS = Object.freeze([
  "atet.diagram.check",
  "atet.diagram.render",
  "atet.image.generate",
  "atet.image.vectorize"
]);
function freezePolicy(policy) {
  const preparation = Object.freeze([...policy.preparation]);
  const resources = Object.freeze(policy.resources.map((claim) => Object.freeze({ ...claim })));
  return Object.freeze({ ...policy, preparation, resources });
}
function portableContract(contract) {
  return Object.freeze({ ...contract, policy: freezePolicy(contract.policy) });
}
var PORTABLE_ATET_OPERATION_CONTRACTS = Object.freeze({
  "atet.diagram.check": portableContract({
    inputSchema: AtetDiagramCheckInputSchema,
    inputSchemaId: "atet.operation.diagram.check.input/v2",
    kind: "atet.diagram.check",
    lifecycle: "pure",
    outputSchema: AtetDiagramCheckOutputSchema,
    outputSchemaId: "atet.operation.diagram.check.output/v2",
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
  "atet.diagram.render": portableContract({
    inputSchema: AtetDiagramRenderInputSchema,
    inputSchemaId: "atet.operation.diagram.render.input/v2",
    kind: "atet.diagram.render",
    lifecycle: "local-artifact",
    outputSchema: AtetDiagramRenderOutputSchema,
    outputSchemaId: "atet.operation.diagram.render.output/v2",
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
  "atet.image.generate": portableContract({
    inputSchema: AtetImageGenerateInputSchema,
    inputSchemaId: "atet.operation.image.generate.input/v2",
    kind: "atet.image.generate",
    lifecycle: "paid-dispatch",
    outputSchema: AtetImageGenerateOutputSchema,
    outputSchemaId: "atet.operation.image.generate.output/v2",
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
  "atet.image.vectorize": portableContract({
    inputSchema: AtetImageVectorizeInputSchema,
    inputSchemaId: "atet.operation.image.vectorize.input/v2",
    kind: "atet.image.vectorize",
    lifecycle: "local-artifact",
    outputSchema: AtetImageVectorizeOutputSchema,
    outputSchemaId: "atet.operation.image.vectorize.output/v2",
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
function isPortableAtetOperationKind(value) {
  return PORTABLE_ATET_OPERATION_KINDS.includes(value);
}
var TransmuteImageModelSchema = AtetImageModelSchema;
var TransmuteDiagramCheckInputSchema = AtetDiagramCheckInputSchema;
var TransmuteDiagramRenderInputSchema = AtetDiagramRenderInputSchema;
var TransmuteImageVectorizeInputSchema = AtetImageVectorizeInputSchema;
var TransmuteImageGenerateInputSchema = AtetImageGenerateInputSchema;
var TransmuteLintFindingSchema = AtetLintFindingSchema;
var TransmuteDiagramCheckOutputSchema = AtetDiagramCheckOutputSchema;
var TransmuteRenderArtifactsSchema = AtetRenderArtifactsSchema;
var TransmuteDiagramRenderOutputSchema = AtetDiagramRenderOutputSchema;
var TransmuteVectorizeQualityReceiptSchema = AtetVectorizeQualityReceiptSchema;
var TransmuteVectorizeProvenanceSchema = AtetVectorizeProvenanceSchema;
var TransmuteVectorizeReceiptSchema = AtetVectorizeReceiptSchema;
var TransmuteImageVectorizeOutputSchema = AtetImageVectorizeOutputSchema;
var TransmuteImageGenerateOutputSchema = AtetImageGenerateOutputSchema;
var PORTABLE_TRANSMUTE_OPERATION_KINDS = Object.freeze([
  "transmute.diagram.check",
  "transmute.diagram.render",
  "transmute.image.generate",
  "transmute.image.vectorize"
]);
var PORTABLE_TRANSMUTE_OPERATION_CONTRACTS = Object.freeze(Object.fromEntries(PORTABLE_TRANSMUTE_OPERATION_KINDS.map((kind) => {
  const canonical = kind.replace(/^transmute\./u, "atet.");
  const contract = PORTABLE_ATET_OPERATION_CONTRACTS[canonical];
  return [kind, Object.freeze({
    ...contract,
    inputSchemaId: contract.inputSchemaId.replace(/^atet\./u, "transmute."),
    kind,
    outputSchemaId: contract.outputSchemaId.replace(/^atet\./u, "transmute.")
  })];
})));
function isPortableTransmuteOperationKind(value) {
  return PORTABLE_TRANSMUTE_OPERATION_KINDS.includes(value);
}

// src/code/boundary.ts
function parseCodeBoundary(schema, input, name) {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new AtetCodeError("invalid-data", `Invalid ${name}.`, {
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
var PUBLIC_WORKFLOW_REGISTRY_PROJECTION_ID = "atet.workflow.registry.public/v1";
var LEGACY_PUBLIC_WORKFLOW_REGISTRY_PROJECTION_ID = "transmute.workflow.registry.public/v1";
var OWNED_NORMALIZED_PROJECTIONS = new WeakSet;
var MAX_OPERATION_DISCOVERY_VALUES = 17 + OPERATION_PREPARATION_KINDS.length + 3 * OPERATION_RESOURCE_KINDS.length;
var MAX_OPERATION_DISCOVERY_LIST_VALUES = 1 + MAX_OPERATION_DISCOVERY_ENTRIES * MAX_OPERATION_DISCOVERY_VALUES;
var MAX_OPERATION_DISCOVERY_LIST_BYTES = 32 * 1024 * 1024;
var MAX_OPERATION_DISCOVERY_LIST_DEPTH = 8;
var MAX_WORKFLOW_REGISTRY_PROJECTION_BYTES = MAX_OPERATION_DISCOVERY_LIST_BYTES + 4096;
var MAX_WORKFLOW_REGISTRY_PROJECTION_DEPTH = MAX_OPERATION_DISCOVERY_LIST_DEPTH + 1;
var MAX_WORKFLOW_REGISTRY_PROJECTION_VALUES = MAX_OPERATION_DISCOVERY_LIST_VALUES + 5;
function discoveryList(source) {
  return Array.isArray(source) ? source : source.list();
}
function boundedOperationDiscoveryList(input, name = "operation discovery list") {
  if (!Array.isArray(input)) {
    throw new AtetCodeError("invalid-data", `${name} must be an array.`);
  }
  const length = input.length;
  if (length > MAX_OPERATION_DISCOVERY_ENTRIES) {
    throw new AtetCodeError("invalid-data", `${name} cannot exceed ${String(MAX_OPERATION_DISCOVERY_ENTRIES)} entries.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.getOwnPropertySymbols(descriptors).some((symbol) => Reflect.get(descriptors, symbol)?.enumerable === true)) {
    throw new AtetCodeError("invalid-data", `${name} cannot contain enumerable symbol properties.`);
  }
  const keys = Object.keys(descriptors).filter((key) => descriptors[key]?.enumerable === true);
  if (keys.length !== length || keys.some((key, index) => key !== String(index))) {
    throw new AtetCodeError("invalid-data", `${name} must be dense and cannot have named properties.`);
  }
  const punctuationBytes = 2 + Math.max(0, length - 1);
  let bytes = punctuationBytes;
  let values = 1;
  const captured = [];
  for (let index = 0;index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new AtetCodeError("invalid-data", `${name} must contain plain data elements.`);
    }
    const remainingBytes = MAX_OPERATION_DISCOVERY_LIST_BYTES - bytes;
    if (remainingBytes < 1) {
      throw new AtetCodeError("invalid-data", `${name} contains more than ${String(MAX_OPERATION_DISCOVERY_LIST_BYTES)} bytes.`);
    }
    const snapshot = createBoundedJsonValueSnapshot(descriptor.value, remainingBytes, `${name} entry ${String(index)}`, {
      maximumDepth: MAX_OPERATION_DISCOVERY_LIST_DEPTH - 1,
      maximumValues: MAX_OPERATION_DISCOVERY_VALUES
    });
    bytes += snapshot.bytes;
    values += snapshot.values;
    if (values > MAX_OPERATION_DISCOVERY_LIST_VALUES) {
      throw new AtetCodeError("invalid-data", `${name} contains more than ${String(MAX_OPERATION_DISCOVERY_LIST_VALUES)} JSON values.`);
    }
    captured.push(snapshot.value);
  }
  return Object.freeze(captured);
}
function operationKey(kind, version) {
  return `${kind}@${String(version)}`;
}
function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
function canonicalAtetIdentity(value) {
  if (value === "studio" || value === "transmute")
    return "atet";
  return value.replace(/^studio\./u, "atet.").replace(/^transmute\./u, "atet.");
}
function normalizeOperationDiscoveryPreservingIdentity(input) {
  const normalized = boundedOperationDiscoveryList(input).map((item) => {
    const parsed = parseCodeBoundary(OperationDiscoverySchema, item, "operation discovery entry");
    const preparation = uniqueSorted(parsed.policy.preparation);
    if (preparation.length !== parsed.policy.preparation.length) {
      throw new AtetCodeError("invalid-data", `Duplicate preparation requirement for ${operationKey(parsed.kind, parsed.version)}.`, { kind: parsed.kind, version: parsed.version });
    }
    const resources = [...parsed.policy.resources].sort((left, right) => left.resource.localeCompare(right.resource));
    if (new Set(resources.map((resource) => resource.resource)).size !== resources.length) {
      throw new AtetCodeError("invalid-data", `Duplicate resource claim for ${operationKey(parsed.kind, parsed.version)}.`, { kind: parsed.kind, version: parsed.version });
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
      throw new AtetCodeError("conflict", `Duplicate operation discovery entry: ${key}`, { kind: operation.kind, version: operation.version });
    }
    seen.add(key);
  }
  return normalized;
}
function normalizeOperationDiscovery(input) {
  return normalizeOperationDiscoveryPreservingIdentity(input).map((operation) => parseCodeBoundary(OperationDiscoverySchema, {
    ...operation,
    inputSchemaId: canonicalAtetIdentity(operation.inputSchemaId),
    kind: canonicalAtetIdentity(operation.kind),
    outputSchemaId: canonicalAtetIdentity(operation.outputSchemaId)
  }, "canonical operation discovery entry"));
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
  const id = canonicalAtetIdentity(parseCodeBoundary(SchemaIdSchema, input.id, "registry projection id"));
  const discovery = normalizeOperationDiscovery(input.discovery);
  const trustedCompute = input.trustedCompute ?? false;
  return workflowRegistryProjectionHashFromNormalized({
    discovery,
    id,
    trustedCompute
  });
}
function workflowRegistryProjectionHashFromNormalized(input, domain = WORKFLOW_REGISTRY_PROJECTION_HASH_DOMAIN) {
  return canonicalJsonSha256Prefixed(`${domain}\x00`, {
    discovery: input.discovery,
    id: input.id,
    trustedCompute: input.trustedCompute
  });
}
function createWorkflowRegistryProjection(idInput, source, options = {}) {
  const id = canonicalAtetIdentity(parseCodeBoundary(SchemaIdSchema, idInput, "registry projection id"));
  const discovery = normalizeOperationDiscovery(discoveryList(source));
  const trustedCompute = options.trustedCompute ?? false;
  const parsed = parseCodeBoundary(WorkflowRegistryProjectionSchema, {
    discovery,
    id,
    projectionSha256: workflowRegistryProjectionHashFromNormalized({
      discovery,
      id,
      trustedCompute
    }),
    trustedCompute
  }, "workflow registry projection");
  const projection = Object.freeze({
    ...parsed,
    discovery: freezeDiscovery(parsed.discovery)
  });
  OWNED_NORMALIZED_PROJECTIONS.add(projection);
  return projection;
}
function parseWorkflowRegistryProjection(input) {
  if (typeof input === "object" && input !== null && OWNED_NORMALIZED_PROJECTIONS.has(input)) {
    return input;
  }
  const captured = createBoundedJsonValueSnapshot(input, MAX_WORKFLOW_REGISTRY_PROJECTION_BYTES, "workflow registry projection", {
    maximumDepth: MAX_WORKFLOW_REGISTRY_PROJECTION_DEPTH,
    maximumValues: MAX_WORKFLOW_REGISTRY_PROJECTION_VALUES
  }).value;
  const parsed = parseCodeBoundary(WorkflowRegistryProjectionSchema, captured, "workflow registry projection");
  const exactDiscovery = normalizeOperationDiscoveryPreservingIdentity(parsed.discovery);
  const exactIdentity = {
    discovery: exactDiscovery,
    id: parsed.id,
    trustedCompute: parsed.trustedCompute
  };
  const expectedProjectionSha256 = workflowRegistryProjectionHashFromNormalized(exactIdentity);
  if (parsed.projectionSha256 !== expectedProjectionSha256) {
    throw new AtetCodeError("invalid-data", "Workflow registry projection hash does not match its contents.", {
      actualProjectionSha256: parsed.projectionSha256,
      expectedProjectionSha256,
      projectionId: parsed.id
    });
  }
  if (canonicalJsonSha256(parsed.discovery) !== canonicalJsonSha256(exactDiscovery)) {
    throw new AtetCodeError("invalid-data", "Workflow registry projection discovery is not normalized.", { projectionId: parsed.id });
  }
  return createWorkflowRegistryProjection(parsed.id, exactDiscovery, { trustedCompute: parsed.trustedCompute });
}
function publicDiscovery() {
  return PORTABLE_ATET_OPERATION_KINDS.map((kind) => {
    const contract = PORTABLE_ATET_OPERATION_CONTRACTS[kind];
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
function legacyPublicDiscovery() {
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
var legacyPublicDiscoveryEntries = normalizeOperationDiscoveryPreservingIdentity(legacyPublicDiscovery());
var PUBLIC_TRANSMUTE_WORKFLOW_PROJECTION = Object.freeze({
  discovery: freezeDiscovery(legacyPublicDiscoveryEntries),
  id: LEGACY_PUBLIC_WORKFLOW_REGISTRY_PROJECTION_ID,
  projectionSha256: workflowRegistryProjectionHashFromNormalized({
    discovery: legacyPublicDiscoveryEntries,
    id: LEGACY_PUBLIC_WORKFLOW_REGISTRY_PROJECTION_ID,
    trustedCompute: false
  }),
  trustedCompute: false
});
var PUBLIC_ATET_WORKFLOW_PROJECTION = PUBLIC_WORKFLOW_REGISTRY_PROJECTION;

// src/code/compiler.ts
import { z as z3 } from "zod";
var WORKFLOW_GRAPH_HASH_DOMAIN = "transmute.workflow.graph/v1";
var WORKFLOW_COMPILATION_HASH_DOMAIN = "transmute.workflow.compilation/v1";
var DEFAULT_GRAPH_COMPILER_LIMITS = Object.freeze({
  maxDepth: 64,
  maxEdges: 2048,
  maxFanOut: 64,
  maxNodes: 256,
  maxTotalOperationFanOut: 4096
});
var MAX_SERIALIZED_GRAPH_BYTES = 64 * 1024 * 1024;
var MAX_SERIALIZED_GRAPH_DEPTH = 160;
var MAX_SERIALIZED_GRAPH_VALUES = 1100000;
var MAX_GRAPH_COMPILER_LIMIT_BYTES = 1024;
var MAX_GRAPH_COMPILER_LIMIT_DEPTH = 2;
var MAX_GRAPH_COMPILER_LIMIT_INPUT_VALUES = 16;
var MAX_WORKFLOW_COMPILATION_BYTES = 80 * 1024 * 1024;
var MAX_WORKFLOW_COMPILATION_DEPTH = 192;
var MAX_OPERATION_DISCOVERY_VALUES2 = 17 + OPERATION_PREPARATION_KINDS.length + 3 * OPERATION_RESOURCE_KINDS.length;
var MAX_WORKFLOW_PROJECTION_VALUES = 5 + MAX_OPERATION_DISCOVERY_ENTRIES * MAX_OPERATION_DISCOVERY_VALUES2;
var MAX_REQUIREMENT_ENVELOPE_VALUES = 21 + 3 * MAX_SERIALIZED_GRAPH_NODES + WORKFLOW_EFFECT_CLASSES.length + OPERATION_PREPARATION_KINDS.length + 3 * OPERATION_RESOURCE_KINDS.length + WORKFLOW_RESUME_CLASSES.length + UNRESOLVED_REQUIREMENT_KINDS.length;
var MAX_TOPOLOGICAL_WAVE_VALUES = 1 + 2 * MAX_SERIALIZED_GRAPH_NODES;
var MAX_GRAPH_COMPILER_LIMIT_VALUES = 6;
var MAX_WORKFLOW_COMPILATION_VALUES = MAX_SERIALIZED_GRAPH_VALUES + MAX_WORKFLOW_PROJECTION_VALUES + MAX_REQUIREMENT_ENVELOPE_VALUES + MAX_TOPOLOGICAL_WAVE_VALUES + MAX_GRAPH_COMPILER_LIMIT_VALUES + 4;
function invalidData(message, details) {
  throw new AtetCodeError("invalid-data", message, details);
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
function canonicalAtetIdentity2(value) {
  if (value === "studio" || value === "transmute")
    return "atet";
  return value.replace(/^studio\./u, "atet.").replace(/^transmute\./u, "atet.");
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
  const captured = createBoundedJsonValueSnapshot(input, MAX_GRAPH_COMPILER_LIMIT_BYTES, "graph compiler limits", {
    maximumDepth: MAX_GRAPH_COMPILER_LIMIT_DEPTH,
    maximumValues: MAX_GRAPH_COMPILER_LIMIT_INPUT_VALUES
  }).value;
  if (typeof captured !== "object" || captured === null || Array.isArray(captured)) {
    return parseCodeBoundary(GraphCompilerLimitsSchema, captured, "graph compiler limits");
  }
  return parseCodeBoundary(GraphCompilerLimitsSchema, {
    ...DEFAULT_GRAPH_COMPILER_LIMITS,
    ...captured
  }, "graph compiler limits");
}
function preflightAuthoredWorkflowGraph(graphInput, maximumNodes) {
  if (typeof graphInput !== "object" || graphInput === null || Array.isArray(graphInput)) {
    return;
  }
  const nodes = Object.getOwnPropertyDescriptor(graphInput, "nodes")?.value;
  if (Array.isArray(nodes) && nodes.length > maximumNodes) {
    return invalidData(`Workflow has ${String(nodes.length)} nodes; the limit is ${String(maximumNodes)}.`, { actual: nodes.length, limit: maximumNodes });
  }
}
function parseAuthoredWorkflowGraphPreservingIdentity(graphInput, maximumNodes = MAX_SERIALIZED_GRAPH_NODES) {
  preflightAuthoredWorkflowGraph(graphInput, maximumNodes);
  const captured = createBoundedJsonValueSnapshot(graphInput, MAX_SERIALIZED_GRAPH_BYTES, "Authored workflow graph", {
    maximumDepth: MAX_SERIALIZED_GRAPH_DEPTH,
    maximumValues: MAX_SERIALIZED_GRAPH_VALUES
  }).value;
  const graph = parseCodeBoundary(AuthoredWorkflowGraphV1Schema, captured, "authored workflow graph");
  if (graph.nodes.length > maximumNodes) {
    return invalidData(`Workflow has ${String(graph.nodes.length)} nodes; the limit is ${String(maximumNodes)}.`, { actual: graph.nodes.length, limit: maximumNodes });
  }
  const sorted = {
    ...graph,
    nodes: [...graph.nodes].sort((left, right) => left.key.localeCompare(right.key))
  };
  return deepFreezeJson(sorted);
}
function canonicalizeGraphValue(value) {
  if (isSerializedRef(value)) {
    return {
      $ref: {
        ...value.$ref,
        schemaId: canonicalAtetIdentity2(value.$ref.schemaId)
      },
      version: WORKFLOW_REF_VERSION
    };
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeGraphValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, canonicalizeGraphValue(nested)]));
  }
  return value;
}
function canonicalizeAuthoredWorkflowGraph(graph) {
  return deepFreezeJson(parseCodeBoundary(AuthoredWorkflowGraphV1Schema, {
    ...graph,
    nodes: graph.nodes.map((node) => ({
      ...node,
      executor: node.executor.kind === "operation" ? {
        kind: "operation",
        operation: {
          ...node.executor.operation,
          kind: canonicalAtetIdentity2(node.executor.operation.kind)
        }
      } : {
        compute: {
          ...node.executor.compute,
          key: canonicalAtetIdentity2(node.executor.compute.key)
        },
        kind: "compute"
      },
      input: canonicalizeGraphValue(node.input),
      inputSchemaId: canonicalAtetIdentity2(node.inputSchemaId),
      outputSchemaId: canonicalAtetIdentity2(node.outputSchemaId)
    })),
    outputs: canonicalizeGraphValue(graph.outputs),
    version: WORKFLOW_GRAPH_VERSION,
    workflow: {
      ...graph.workflow,
      id: canonicalAtetIdentity2(graph.workflow.id),
      inputSchemaId: canonicalAtetIdentity2(graph.workflow.inputSchemaId)
    }
  }, "canonical authored workflow graph"));
}
function normalizeAuthoredWorkflowGraph(graphInput, maximumNodes = MAX_SERIALIZED_GRAPH_NODES) {
  return canonicalizeAuthoredWorkflowGraph(parseAuthoredWorkflowGraphPreservingIdentity(graphInput, maximumNodes));
}
function workflowGraphHashFromNormalized(graph) {
  return canonicalJsonSha256Prefixed(`${WORKFLOW_GRAPH_HASH_DOMAIN}\x00`, graph);
}
function createWorkflowGraphHash(graphInput) {
  const graph = normalizeAuthoredWorkflowGraph(graphInput);
  return workflowGraphHashFromNormalized(graph);
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
  return references;
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
  const graph = normalizeAuthoredWorkflowGraph(graphInput, limits.maxNodes);
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
        throw new AtetCodeError("unsupported-plan", `Unsupported operation: ${operationKey2(identity.kind, identity.version)}`, {
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
        throw new AtetCodeError("unsupported-plan", `Trusted compute is unsupported at node ${node.key}.`, {
          executorKind: "compute",
          nodeKey: node.key,
          projectionId: projection.id
        });
      }
      policy = trustedComputePolicy(node.executor.compute);
    } else {
      throw new AtetCodeError("internal", `Unknown node executor for ${node.key}.`);
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
    throw new AtetCodeError("internal", `Operation ${kind} has no namespace family.`, { kind });
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
      throw new AtetCodeError("internal", `Node ${node.key} lost its execution policy.`);
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
function canonicalizeRequirementEnvelope(input) {
  const envelope = parseCodeBoundary(RequirementEnvelopeSchema, input, "workflow requirement envelope");
  return parseCodeBoundary(RequirementEnvelopeSchema, {
    ...envelope,
    computeKeys: envelope.computeKeys.map(canonicalAtetIdentity2),
    operationFamilies: envelope.operationFamilies.map(canonicalAtetIdentity2),
    operationKinds: envelope.operationKinds.map(canonicalAtetIdentity2),
    version: REQUIREMENT_ENVELOPE_VERSION
  }, "canonical workflow requirement envelope");
}
function resolveProjection(options) {
  if (options.projection !== undefined) {
    if (options.registry !== undefined || options.projectionId !== undefined || options.trustedCompute !== undefined) {
      throw new AtetCodeError("invalid-data", "Compile with either a projection or a registry projection source, not both.");
    }
    return parseWorkflowRegistryProjection(options.projection);
  }
  if (options.registry !== undefined) {
    if (options.projectionId === undefined) {
      throw new AtetCodeError("invalid-data", "A registry projection source requires an explicit projection id.");
    }
    return createWorkflowRegistryProjection(options.projectionId, options.registry, { trustedCompute: options.trustedCompute ?? false });
  }
  if (options.projectionId !== undefined || options.trustedCompute !== undefined) {
    throw new AtetCodeError("invalid-data", "A projection id or trusted-compute authority requires a registry projection source.");
  }
  return PUBLIC_WORKFLOW_REGISTRY_PROJECTION;
}
var RequiredCompilationComponentSchema = z3.unknown().refine((value) => value !== undefined, "Required");
var ShallowCompiledWorkflowGraphSchema = z3.strictObject({
  compilationSha256: Sha256Schema,
  envelope: RequiredCompilationComponentSchema,
  graph: RequiredCompilationComponentSchema,
  graphSha256: Sha256Schema,
  limits: RequiredCompilationComponentSchema,
  projection: RequiredCompilationComponentSchema,
  topologicalWaves: RequiredCompilationComponentSchema,
  version: z3.union([
    z3.literal(WORKFLOW_COMPILATION_VERSION),
    z3.literal(LEGACY_WORKFLOW_COMPILATION_VERSION)
  ])
});
function boundedCompilationInput(input, name) {
  return createBoundedJsonValueSnapshot(input, MAX_WORKFLOW_COMPILATION_BYTES, name, {
    maximumDepth: MAX_WORKFLOW_COMPILATION_DEPTH,
    maximumValues: MAX_WORKFLOW_COMPILATION_VALUES
  }).value;
}
function workflowCompilationHashFromValidated(compilation) {
  return canonicalJsonSha256Prefixed(`${WORKFLOW_COMPILATION_HASH_DOMAIN}\x00`, compilation);
}
function createWorkflowCompilationHash(compilationInput) {
  const bounded = boundedCompilationInput(compilationInput, "workflow compilation");
  if (typeof bounded !== "object" || bounded === null || Array.isArray(bounded)) {
    return invalidData("Workflow compilation must be a plain object.");
  }
  const {
    compilationSha256: ignoredCompilationSha256,
    ...unsigned
  } = bounded;
  const parsed = parseCodeBoundary(CompiledWorkflowGraphSchema.omit({ compilationSha256: true }), unsigned, "unsigned workflow compilation");
  return workflowCompilationHashFromValidated(parsed);
}
function compileWorkflowGraph(options) {
  const limits = normalizeLimits(options.limits);
  const projection = resolveProjection(options);
  const validated = validateGraph(options.graph, projection, limits);
  const graphSha256 = workflowGraphHashFromNormalized(validated.graph);
  const unsigned = {
    envelope: deriveRequirementEnvelope(validated),
    graph: validated.graph,
    graphSha256,
    limits,
    projection,
    topologicalWaves: validated.topology.waves,
    version: WORKFLOW_COMPILATION_VERSION
  };
  return deepFreeze(parseCodeBoundary(CompiledWorkflowGraphSchema, {
    ...unsigned,
    compilationSha256: workflowCompilationHashFromValidated(unsigned)
  }, "compiled workflow graph"));
}
function parseCompiledWorkflowGraph(input) {
  const bounded = boundedCompilationInput(input, "compiled workflow graph");
  const shallow = parseCodeBoundary(ShallowCompiledWorkflowGraphSchema, bounded, "compiled workflow graph");
  const {
    compilationSha256: parsedCompilationSha256,
    ...unsigned
  } = shallow;
  const expected = workflowCompilationHashFromValidated(unsigned);
  if (parsedCompilationSha256 !== expected) {
    throw new AtetCodeError("invalid-data", "Workflow compilation hash does not match its contents.", {
      actualCompilationSha256: parsedCompilationSha256,
      expectedCompilationSha256: expected
    });
  }
  const parsed = parseCodeBoundary(CompiledWorkflowGraphSchema, bounded, "compiled workflow graph");
  const exactGraph = parseAuthoredWorkflowGraphPreservingIdentity(parsed.graph);
  if (canonicalJsonSha256(parsed.graph) !== canonicalJsonSha256(exactGraph)) {
    throw new AtetCodeError("invalid-data", "Compiled workflow graph nodes are not normalized.");
  }
  const expectedGraphSha256 = workflowGraphHashFromNormalized(exactGraph);
  if (parsed.graphSha256 !== expectedGraphSha256) {
    throw new AtetCodeError("invalid-data", "Workflow graph hash does not match its authenticated contents.", {
      actualGraphSha256: parsed.graphSha256,
      expectedGraphSha256
    });
  }
  const canonicalGraph = canonicalizeAuthoredWorkflowGraph(exactGraph);
  const canonicalProjection = parseWorkflowRegistryProjection(parsed.projection);
  const canonicalLimits2 = normalizeLimits(parsed.limits);
  const recompiled = compileWorkflowGraph({
    graph: canonicalGraph,
    limits: canonicalLimits2,
    projection: canonicalProjection
  });
  const canonicalUnsigned = {
    envelope: canonicalizeRequirementEnvelope(parsed.envelope),
    graph: canonicalGraph,
    graphSha256: workflowGraphHashFromNormalized(canonicalGraph),
    limits: canonicalLimits2,
    projection: canonicalProjection,
    topologicalWaves: parsed.topologicalWaves,
    version: WORKFLOW_COMPILATION_VERSION
  };
  if (recompiled.compilationSha256 !== workflowCompilationHashFromValidated(canonicalUnsigned)) {
    throw new AtetCodeError("invalid-data", "Workflow compilation topology, requirements, or projection do not match the graph.");
  }
  return recompiled;
}

// src/code/graph-builder.ts
var MAX_AUTHORING_VALUE_DEPTH = 128;
var MAX_AUTHORING_VALUES = 1e6;
var NORMALIZED_LEGACY_COMPUTES = new WeakMap;
function consumeAuthoringValue(budget) {
  if (budget.consumed >= budget.maximum) {
    throw new AtetCodeError("invalid-data", `Workflow authoring values exceed the ${String(MAX_AUTHORING_VALUES)} value limit.`);
  }
  budget.consumed += 1;
}
function consumeAuthoringValues(budget, additional) {
  requireAuthoringCapacity(budget, additional);
  budget.consumed += additional;
}
function requireAuthoringCapacity(budget, additional) {
  if (additional > budget.maximum - budget.consumed) {
    throw new AtetCodeError("invalid-data", `Workflow authoring values exceed the ${String(MAX_AUTHORING_VALUES)} value limit.`);
  }
}
function encodingBudget(state) {
  return {
    consumed: 0,
    maximum: MAX_AUTHORING_VALUES - state.authoredValues
  };
}
function requireStateCapacity(state, additional) {
  if (additional > MAX_AUTHORING_VALUES - state.authoredValues) {
    throw new AtetCodeError("invalid-data", `Workflow authoring values exceed the ${String(MAX_AUTHORING_VALUES)} value limit.`);
  }
}
function normalizeTrustedComputeDefinition(definition) {
  if (definition[TRUSTED_COMPUTE_BRAND] === true)
    return definition;
  if (Reflect.get(definition, LEGACY_TRUSTED_COMPUTE_BRAND) !== true) {
    return;
  }
  const existing = NORMALIZED_LEGACY_COMPUTES.get(definition);
  if (existing !== undefined) {
    return existing;
  }
  const normalized = Object.freeze({
    [TRUSTED_COMPUTE_BRAND]: true,
    bounds: definition.bounds,
    inputSchema: definition.inputSchema,
    inputSchemaId: definition.inputSchemaId,
    key: definition.key,
    outputSchema: definition.outputSchema,
    outputSchemaId: definition.outputSchemaId,
    run: definition.run
  });
  NORMALIZED_LEGACY_COMPUTES.set(definition, normalized);
  return normalized;
}
function discoveryKey(kind, version) {
  return `${kind}@${String(version)}`;
}
function providerDiscovery(provider) {
  const source = provider;
  const discovery = typeof source.list === "function" ? source.list() : provider.discovery;
  return boundedOperationDiscoveryList(discovery);
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
function rejectEnumerableSymbols(descriptors, name) {
  if (Object.getOwnPropertySymbols(descriptors).some((symbol) => Reflect.get(descriptors, symbol)?.enumerable === true)) {
    throw new AtetCodeError("invalid-data", `${name} cannot contain enumerable symbol properties.`);
  }
}
function cloneSerializedRef(reference) {
  return deepFreezeJson(parseCodeBoundary(SerializedRefV1Schema, reference.serialized, "workflow reference"));
}
function serializedReferenceValueCount(reference) {
  const path = reference.$ref.path;
  return path === undefined ? 5 : 6 + path.length;
}
function isOwnedRef(value, state) {
  return typeof value === "object" && value !== null && WORKFLOW_REF_BRAND in value && state.references.has(value);
}
function encodeInputValue(input, state, dependencies, ancestors, depth, budget) {
  if (depth > MAX_AUTHORING_VALUE_DEPTH) {
    throw new AtetCodeError("invalid-data", `Workflow input nesting exceeds ${String(MAX_AUTHORING_VALUE_DEPTH)} levels.`);
  }
  if (isOwnedRef(input, state)) {
    const serialized = cloneSerializedRef(input);
    consumeAuthoringValues(budget, serializedReferenceValueCount(serialized));
    dependencies.add(serialized.$ref.nodeKey);
    return serialized;
  }
  consumeAuthoringValue(budget);
  if (typeof input === "object" && input !== null && WORKFLOW_REF_BRAND in input) {
    throw new AtetCodeError("invalid-data", "Use a typed Ref value created by this workflow graph builder.");
  }
  if (input === null || typeof input === "boolean" || typeof input === "string") {
    return input;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new AtetCodeError("invalid-data", "Workflow node input numbers must be finite.");
    }
    return Object.is(input, -0) ? 0 : input;
  }
  if (typeof input !== "object") {
    throw new AtetCodeError("invalid-data", `Workflow node input cannot contain ${typeof input} values.`);
  }
  if (ancestors.has(input)) {
    throw new AtetCodeError("invalid-data", "Workflow node input cannot contain cycles.");
  }
  ancestors.add(input);
  try {
    if (Array.isArray(input)) {
      const length = input.length;
      requireAuthoringCapacity(budget, length);
      const descriptors2 = Object.getOwnPropertyDescriptors(input);
      rejectEnumerableSymbols(descriptors2, "Workflow node input arrays");
      const keys2 = Object.keys(descriptors2).filter((key) => descriptors2[key]?.enumerable === true);
      if (keys2.length !== length || keys2.some((key, index) => key !== String(index))) {
        throw new AtetCodeError("invalid-data", "Workflow node input arrays must be dense and cannot have named properties.");
      }
      const encoded2 = [];
      for (let index = 0;index < length; index += 1) {
        const descriptor = descriptors2[String(index)];
        if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
          throw new AtetCodeError("invalid-data", "Workflow node input arrays must contain plain data elements.");
        }
        encoded2.push(encodeInputValue(descriptor.value, state, dependencies, ancestors, depth + 1, budget));
      }
      return encoded2;
    }
    if (!isPlainRecord(input)) {
      throw new AtetCodeError("invalid-data", "Workflow node input accepts only JSON values and typed workflow references.");
    }
    if (Object.hasOwn(input, "$ref")) {
      throw new AtetCodeError("invalid-data", "Use a typed Ref value instead of constructing the reserved $ref field.");
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    rejectEnumerableSymbols(descriptors, "Workflow node inputs");
    const keys = Object.keys(descriptors).filter((key) => descriptors[key]?.enumerable === true).sort();
    requireAuthoringCapacity(budget, keys.length);
    const encoded = {};
    for (const key of keys) {
      if (key === "__proto__") {
        throw new AtetCodeError("invalid-data", "Workflow inputs cannot contain the reserved __proto__ object key.");
      }
      const descriptor = descriptors[key];
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new AtetCodeError("invalid-data", "Workflow node input properties must be plain data properties.");
      }
      encoded[key] = encodeInputValue(descriptor.value, state, dependencies, ancestors, depth + 1, budget);
    }
    return encoded;
  } finally {
    ancestors.delete(input);
  }
}
function encodeOperationInput(input, state) {
  const dependencies = new Set;
  const budget = encodingBudget(state);
  const value = encodeInputValue(input, state, dependencies, new Set, 0, budget);
  return {
    dependencies: [...dependencies].sort((left, right) => left.localeCompare(right)),
    value,
    values: budget.consumed
  };
}
function encodeControlDependencies(after, state) {
  if (after === undefined)
    return [];
  const dependencies = new Set;
  const appendReference = (reference) => {
    if (!isOwnedRef(reference, state)) {
      throw new AtetCodeError("invalid-data", "Operation control dependencies must be typed Ref values created by this workflow graph builder.");
    }
    dependencies.add(cloneSerializedRef(reference).$ref.nodeKey);
  };
  if (!Array.isArray(after)) {
    appendReference(after);
    return [...dependencies];
  }
  const length = after.length;
  if (length > MAX_SERIALIZED_NODE_DEPENDENCIES) {
    throw new AtetCodeError("invalid-data", `Operation control dependencies cannot exceed ${String(MAX_SERIALIZED_NODE_DEPENDENCIES)} entries.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(after);
  rejectEnumerableSymbols(descriptors, "Operation control dependencies");
  const keys = Object.keys(descriptors).filter((key) => descriptors[key]?.enumerable === true);
  if (keys.length !== length || keys.some((key, index) => key !== String(index))) {
    throw new AtetCodeError("invalid-data", "Operation control dependencies must be a dense array without named properties.");
  }
  for (let index = 0;index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new AtetCodeError("invalid-data", "Operation control dependencies must contain plain data elements.");
    }
    appendReference(descriptor.value);
  }
  return [...dependencies].sort((left, right) => left.localeCompare(right));
}
function combineDependencies(dataDependencies, controlDependencies) {
  return [...new Set([...dataDependencies, ...controlDependencies])].sort((left, right) => left.localeCompare(right));
}
function encodeOutputValue(output, state, ancestors, depth, budget) {
  if (depth > MAX_AUTHORING_VALUE_DEPTH) {
    throw new AtetCodeError("invalid-data", `Workflow output nesting exceeds ${String(MAX_AUTHORING_VALUE_DEPTH)} levels.`);
  }
  if (isOwnedRef(output, state)) {
    const serialized = cloneSerializedRef(output);
    consumeAuthoringValues(budget, serializedReferenceValueCount(serialized));
    return serialized;
  }
  consumeAuthoringValue(budget);
  if (typeof output !== "object" || output === null) {
    throw new AtetCodeError("invalid-data", "Workflow outputs must contain only typed references, arrays, and named objects.");
  }
  if (ancestors.has(output)) {
    throw new AtetCodeError("invalid-data", "Workflow outputs cannot contain cycles.");
  }
  ancestors.add(output);
  try {
    if (Array.isArray(output)) {
      const length = output.length;
      requireAuthoringCapacity(budget, length);
      const descriptors2 = Object.getOwnPropertyDescriptors(output);
      rejectEnumerableSymbols(descriptors2, "Workflow output arrays");
      const keys2 = Object.keys(descriptors2).filter((key) => descriptors2[key]?.enumerable === true);
      if (keys2.length !== length || keys2.some((key, index) => key !== String(index))) {
        throw new AtetCodeError("invalid-data", "Workflow output arrays must be dense and cannot have named properties.");
      }
      const encoded2 = [];
      for (let index = 0;index < length; index += 1) {
        const descriptor = descriptors2[String(index)];
        if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
          throw new AtetCodeError("invalid-data", "Workflow output arrays must contain plain data elements.");
        }
        encoded2.push(encodeOutputValue(descriptor.value, state, ancestors, depth + 1, budget));
      }
      return encoded2;
    }
    if (!isPlainRecord(output)) {
      throw new AtetCodeError("invalid-data", "Workflow outputs accept only typed references, arrays, and plain objects.");
    }
    if (Object.hasOwn(output, "$ref")) {
      throw new AtetCodeError("invalid-data", "Use a typed Ref value instead of constructing the reserved $ref field.");
    }
    const descriptors = Object.getOwnPropertyDescriptors(output);
    rejectEnumerableSymbols(descriptors, "Workflow outputs");
    const keys = Object.keys(descriptors).filter((key) => descriptors[key]?.enumerable === true).sort();
    requireAuthoringCapacity(budget, keys.length);
    const encoded = {};
    for (const key of keys) {
      if (key === "__proto__") {
        throw new AtetCodeError("invalid-data", "Workflow outputs cannot contain the reserved __proto__ object key.");
      }
      const descriptor = descriptors[key];
      if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new AtetCodeError("invalid-data", "Workflow output properties must be plain data properties.");
      }
      encoded[key] = encodeOutputValue(descriptor.value, state, ancestors, depth + 1, budget);
    }
    return encoded;
  } finally {
    ancestors.delete(output);
  }
}
function createReference(nodeKey, schemaId, state, path = []) {
  if (path.length > MAX_SERIALIZED_REF_PATH_SEGMENTS) {
    throw new AtetCodeError("invalid-data", `Workflow reference paths cannot exceed ${String(MAX_SERIALIZED_REF_PATH_SEGMENTS)} segments.`);
  }
  const serialized = deepFreezeJson({
    $ref: {
      nodeKey,
      ...path.length === 0 ? {} : { path: [...path] },
      schemaId
    },
    version: WORKFLOW_REF_VERSION
  });
  const reference = Object.freeze({
    [WORKFLOW_REF_BRAND]: () => {
      throw new AtetCodeError("internal", "A workflow reference type marker is not executable.");
    },
    at: (index) => {
      if (!Number.isSafeInteger(index) || index < 0) {
        throw new AtetCodeError("invalid-data", "Workflow reference array indexes must be nonnegative safe integers.");
      }
      if (path.length >= MAX_SERIALIZED_REF_PATH_SEGMENTS) {
        throw new AtetCodeError("invalid-data", `Workflow reference paths cannot exceed ${String(MAX_SERIALIZED_REF_PATH_SEGMENTS)} segments.`);
      }
      return createReference(nodeKey, schemaId, state, [...path, index]);
    },
    select: (key) => {
      if (typeof key !== "string" || key.length < 1 || key.length > 128) {
        throw new AtetCodeError("invalid-data", "Workflow reference field names must contain 1\u2013128 characters.");
      }
      if (path.length >= MAX_SERIALIZED_REF_PATH_SEGMENTS) {
        throw new AtetCodeError("invalid-data", `Workflow reference paths cannot exceed ${String(MAX_SERIALIZED_REF_PATH_SEGMENTS)} segments.`);
      }
      return createReference(nodeKey, schemaId, state, [...path, key]);
    },
    serialized
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
      throw new AtetCodeError("conflict", `Duplicate operation discovery entry: ${key}`, { kind: item.kind, version: item.version });
    }
    discovery.set(key, item);
  }
  return {
    authoredValues: 7,
    computes: new Map,
    discovery,
    nodes: new Map,
    references: new WeakSet
  };
}
function defineWorkflowFragment(build) {
  if (typeof build !== "function") {
    throw new AtetCodeError("invalid-data", "Workflow fragments require a build function.");
  }
  return Object.freeze({ build });
}
function operationContract(provider, kind, version) {
  const discovery = createState(provider).discovery.get(discoveryKey(kind, version));
  if (discovery === undefined) {
    throw new AtetCodeError("unsupported-plan", `Unsupported operation: ${kind}@${String(version)}`, { kind, version });
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
      throw new AtetCodeError("unsupported-plan", `Unsupported operation: ${request.kind}@${String(request.version)}`, { kind: request.kind, version: request.version });
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
    if (typeof definition !== "object" || definition === null) {
      throw new AtetCodeError("invalid-data", "Compute nodes require a definition created by defineCompute().");
    }
    const normalizedDefinition = normalizeTrustedComputeDefinition(definition);
    if (normalizedDefinition === undefined) {
      throw new AtetCodeError("invalid-data", "Compute nodes require a definition created by defineCompute().");
    }
    const compute = parseCodeBoundary(AuthoredComputeIdentitySchema, {
      bounds: normalizedDefinition.bounds,
      key: normalizedDefinition.key,
      version: TRUSTED_COMPUTE_VERSION
    }, "trusted compute identity");
    const existing = this.#state.computes.get(compute.key);
    if (existing !== undefined && existing !== normalizedDefinition) {
      throw new AtetCodeError("conflict", `Duplicate trusted compute key: ${compute.key}`, { key: compute.key });
    }
    const key = this.#nodeKey(keyInput);
    const encoded = encodeOperationInput(input, this.#state);
    const controlDependencies = encodeControlDependencies(options.after, this.#state);
    const dependencies = combineDependencies(encoded.dependencies, controlDependencies);
    const nodeValues = encoded.values + 15 + controlDependencies.length + dependencies.length + (options.label === undefined ? 0 : 1);
    requireStateCapacity(this.#state, nodeValues);
    const node = parseCodeBoundary(AuthoredGraphNodeV1Schema, {
      controlDependencies,
      dependencies,
      executor: { compute, kind: "compute" },
      input: encoded.value,
      inputSchemaId: normalizedDefinition.inputSchemaId,
      key,
      ...options.label === undefined ? {} : { label: options.label },
      outputSchemaId: normalizedDefinition.outputSchemaId
    }, "authored compute node");
    this.#state.computes.set(compute.key, normalizedDefinition);
    this.#state.nodes.set(key, node);
    this.#state.authoredValues += nodeValues;
    return createReference(key, normalizedDefinition.outputSchemaId, this.#state);
  }
  computeDefinitions() {
    return Object.freeze([...this.#state.computes.values()].sort((left, right) => left.key.localeCompare(right.key)));
  }
  build(workflowInput, outputs) {
    const workflow = parseCodeBoundary(WorkflowIdentitySchema, workflowInput, "workflow identity");
    const outputBudget = encodingBudget(this.#state);
    const encodedOutputs = encodeOutputValue(outputs, this.#state, new Set, 0, outputBudget);
    return deepFreezeJson(parseCodeBoundary(AuthoredWorkflowGraphV1Schema, {
      nodes: [...this.#state.nodes.values()].sort((left, right) => left.key.localeCompare(right.key)),
      outputs: encodedOutputs,
      version: WORKFLOW_GRAPH_VERSION,
      workflow
    }, "authored workflow graph"));
  }
  #nodeKey(keyInput) {
    const keySegment = parseCodeBoundary(NodeKeySegmentSchema, keyInput, "workflow node key segment");
    const key = [...this.#namespace, keySegment].join("/");
    if (this.#state.nodes.has(key)) {
      throw new AtetCodeError("conflict", `Duplicate workflow node key: ${key}`, { nodeKey: key });
    }
    if (this.#state.nodes.size >= MAX_SERIALIZED_GRAPH_NODES) {
      throw new AtetCodeError("invalid-data", `Workflow nodes cannot exceed ${String(MAX_SERIALIZED_GRAPH_NODES)} entries.`);
    }
    return key;
  }
  #addOperation(keyInput, request, options) {
    const key = this.#nodeKey(keyInput);
    const discovery = this.#state.discovery.get(discoveryKey(request.kind, request.version));
    if (discovery === undefined) {
      throw new AtetCodeError("unsupported-plan", `Unsupported operation: ${request.kind}@${String(request.version)}`, { kind: request.kind, version: request.version });
    }
    if (request.inputSchemaId !== discovery.inputSchemaId || request.outputSchemaId !== discovery.outputSchemaId) {
      throw new AtetCodeError("invalid-data", `Operation contract schema mismatch for ${request.kind}@${String(request.version)}.`, {
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
    const dependencies = combineDependencies(encoded.dependencies, controlDependencies);
    const nodeValues = encoded.values + 11 + controlDependencies.length + dependencies.length + (options.label === undefined ? 0 : 1);
    requireStateCapacity(this.#state, nodeValues);
    const node = parseCodeBoundary(AuthoredGraphNodeV1Schema, {
      controlDependencies,
      dependencies,
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
    this.#state.authoredValues += nodeValues;
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
      check: (key, input, options = {}) => this.#builder.operation(key, PORTABLE_ATET_OPERATION_CONTRACTS["atet.diagram.check"], input, options),
      render: (key, input, options = {}) => this.#builder.operation(key, PORTABLE_ATET_OPERATION_CONTRACTS["atet.diagram.render"], input, options)
    });
    this.image = Object.freeze({
      generate: (key, input, options = {}) => this.#builder.operation(key, PORTABLE_ATET_OPERATION_CONTRACTS["atet.image.generate"], input, options),
      vectorize: (key, input, options = {}) => this.#builder.operation(key, PORTABLE_ATET_OPERATION_CONTRACTS["atet.image.vectorize"], input, options)
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
function boundedWorkflowInput(schema, input) {
  const capturedInput = captureJsonStructure(input, "workflow input", {
    maximumBytes: MAX_TRUSTED_COMPUTE_INPUT_BYTES
  });
  const parsedInput = parseCodeBoundary(schema, capturedInput, "workflow input");
  return createBoundedJsonValueSnapshot(parsedInput, MAX_TRUSTED_COMPUTE_INPUT_BYTES, "JSON-safe workflow input").value;
}
function workflowDefinitionIdentity(options) {
  if (typeof options.build !== "function") {
    throw new AtetCodeError("invalid-data", "Workflow definitions require a build function.");
  }
  const id = parseCodeBoundary(WorkflowIdSchema, options.id, "workflow id");
  const inputSchemaId = parseCodeBoundary(SchemaIdSchema, options.inputSchemaId, "workflow input schema id");
  if (!Number.isSafeInteger(options.version) || options.version < 1) {
    throw new AtetCodeError("invalid-data", "Workflow versions must be positive safe integers.");
  }
  return { id, inputSchemaId, version: options.version };
}
function assertOptionsObject(value, name) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AtetCodeError("invalid-data", `${name} must be an object.`);
  }
}
function assertSchemaCapability(value, name) {
  if (typeof value !== "object" || value === null || typeof value.safeParse !== "function") {
    throw new AtetCodeError("invalid-data", `${name} must provide a synchronous safeParse function.`);
  }
}
function defineWorkflow(options) {
  assertOptionsObject(options, "Workflow definition options");
  assertSchemaCapability(options.inputSchema, "Workflow input schema");
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
  assertOptionsObject(definition, "Workflow definition");
  assertSchemaCapability(definition.inputSchema, "Workflow input schema");
  workflowDefinitionIdentity(definition);
  const workflowInput = boundedWorkflowInput(definition.inputSchema, input);
  const builder = PortableWorkflowBuilder.create();
  const outputs = definition.build(builder, workflowInput);
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
  assertOptionsObject(options, "Trusted compute definition options");
  assertSchemaCapability(options.inputSchema, "Trusted compute input schema");
  assertSchemaCapability(options.outputSchema, "Trusted compute output schema");
  if (typeof options.run !== "function") {
    throw new AtetCodeError("invalid-data", "Trusted compute definitions require a run function.");
  }
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
    throw new AtetCodeError("invalid-data", "Trusted compute duration exceeds the host maximum.");
  }
  return Object.freeze({
    [TRUSTED_COMPUTE_BRAND]: true,
    bounds: deepFreezeJson(identity.bounds),
    inputSchema: options.inputSchema,
    inputSchemaId,
    key,
    outputSchema: options.outputSchema,
    outputSchemaId,
    run: options.run
  });
}
function defineAdvancedWorkflow(options) {
  assertOptionsObject(options, "Advanced workflow definition options");
  assertSchemaCapability(options.inputSchema, "Advanced workflow input schema");
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
  assertOptionsObject(definition, "Advanced workflow definition");
  assertSchemaCapability(definition.inputSchema, "Advanced workflow input schema");
  workflowDefinitionIdentity(definition);
  const workflowInput = boundedWorkflowInput(definition.inputSchema, input);
  const builder = WorkflowGraphBuilder.create(provider);
  const outputs = definition.build(builder, workflowInput);
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
    throw new AtetCodeError("invalid-data", "Seconds must be a finite nonnegative number.");
  }
  const microseconds = value * 1e6;
  if (!Number.isSafeInteger(microseconds)) {
    throw new AtetCodeError("invalid-data", "Seconds must resolve to an integer number of safe microseconds.");
  }
  return microseconds;
}

// src/code/runtime.ts
var WORKFLOW_NODE_RECEIPT_VERSION = "atet-workflow-node-receipt-v1";
var WORKFLOW_NODE_RECEIPT_HASH_DOMAIN = "transmute.workflow.node-receipt/v1";
var MAX_WORKFLOW_RESULT_BYTES = 96 * 1024 * 1024;
var MAX_WORKFLOW_RESULT_DEPTH = 320;
var MAX_WORKFLOW_RESULT_VALUES = 1300000;
function createAtetCodeHost(options) {
  if (typeof options !== "object" || options === null) {
    throw new AtetCodeError("invalid-data", "An Atet Code host must be an object.");
  }
  if (typeof options.execute !== "function") {
    throw new AtetCodeError("invalid-data", "An Atet Code host requires an execute function.");
  }
  if (options.admit !== undefined && typeof options.admit !== "function") {
    throw new AtetCodeError("invalid-data", "An Atet Code host admit value must be a function when provided.");
  }
  return Object.freeze({
    ...options.admit === undefined ? {} : { admit: options.admit },
    execute: options.execute
  });
}

class AtetWorkflowRunError extends AtetCodeError {
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
    this.name = "AtetWorkflowRunError";
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
    throw new AtetCodeError("internal", `Workflow reference producer ${reference.$ref.nodeKey} has not completed.`, { nodeKey: reference.$ref.nodeKey });
  }
  for (const segment of reference.$ref.path ?? []) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) {
        throw new AtetCodeError("invalid-data", `Workflow reference ${reference.$ref.nodeKey} has an invalid array projection.`, { nodeKey: reference.$ref.nodeKey, segment });
      }
      const currentArray = current;
      current = currentArray[segment];
    } else {
      if (typeof current !== "object" || current === null || Array.isArray(current) || !Object.hasOwn(current, segment)) {
        throw new AtetCodeError("invalid-data", `Workflow reference ${reference.$ref.nodeKey} has an invalid object projection.`, { nodeKey: reference.$ref.nodeKey, segment });
      }
      current = current[segment];
    }
    if (current === undefined) {
      throw new AtetCodeError("invalid-data", `Workflow reference ${reference.$ref.nodeKey} projected an undefined value.`, { nodeKey: reference.$ref.nodeKey, segment });
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
        throw new AtetCodeError("internal", `Compiled workflow value ${key} is undefined.`);
      }
      output[key] = resolveValue(item, values);
    }
    return output;
  }
  return value;
}
function createNodeReceipt(index, nodeKey, kind, inputSha256, outputSha256) {
  const unsigned = {
    index,
    inputSha256,
    kind,
    nodeKey,
    operationVersion: 2,
    outputSha256,
    version: WORKFLOW_NODE_RECEIPT_VERSION
  };
  return Object.freeze({
    ...unsigned,
    receiptSha256: canonicalJsonSha256Prefixed(`${WORKFLOW_NODE_RECEIPT_HASH_DOMAIN}\x00`, unsigned)
  });
}
function publicOperationNode(node) {
  if (isComputeGraphNode(node)) {
    throw new AtetCodeError("unsupported-plan", `The public projection does not support trusted compute at node ${node.key}.`, {
      executorKind: "compute",
      nodeKey: node.key,
      projectionId: PUBLIC_WORKFLOW_REGISTRY_PROJECTION.id
    });
  }
  if (!isOperationGraphNode(node)) {
    throw new AtetCodeError("unsupported-plan", `The public projection does not support the executor at node ${node.key}.`, { nodeKey: node.key, projectionId: PUBLIC_WORKFLOW_REGISTRY_PROJECTION.id });
  }
  const operation = node.executor.operation;
  if (operation.version !== 2 || !isPortableAtetOperationKind(operation.kind)) {
    throw new AtetCodeError("unsupported-plan", `Unsupported operation: ${operation.kind}@${String(operation.version)}`, {
      kind: operation.kind,
      nodeKey: node.key,
      projectionId: PUBLIC_WORKFLOW_REGISTRY_PROJECTION.id,
      version: operation.version
    });
  }
}
function throwIfAborted(signal) {
  if (signal.aborted) {
    throw new AtetCodeError("cancelled", "Workflow execution was cancelled.");
  }
}
function workflowNodeFailure(error, node, completedReceipts) {
  const code = error instanceof AtetCodeError ? error.code : "subprocess";
  return new AtetWorkflowRunError(code, `Workflow node ${node.key} (${node.executor.operation.kind}@2) failed: ` + atetCodeErrorMessage(error), {
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
  const code = error instanceof AtetCodeError ? error.code : "internal";
  return new AtetWorkflowRunError(code, message, {
    cause: error,
    completedReceipts
  });
}
async function executePublicNode(host, node, values, context) {
  const { kind } = node.executor.operation;
  const contract = PORTABLE_ATET_OPERATION_CONTRACTS[kind];
  const resolvedInput = resolveValue(node.input, values);
  const rawInput = createBoundedJsonValueSnapshot(resolvedInput, contract.policy.maxInputBytes, `${kind} raw input at node ${node.key}`);
  const parsedInput = parseCodeBoundary(contract.inputSchema, rawInput.value, `${kind} input at node ${node.key}`);
  const boundedInput = createBoundedJsonSnapshot(parsedInput, contract.policy.maxInputBytes, `${kind} input at node ${node.key}`);
  const request = Object.freeze({
    input: boundedInput.value,
    kind,
    nodeKey: node.key,
    version: 2
  });
  throwIfAborted(context.signal);
  const dispatch = async () => await host.execute(request, context);
  const rawOutput = host.admit === undefined ? await dispatch() : await host.admit(Object.freeze({
    kind,
    nodeKey: node.key,
    policy: contract.policy,
    version: 2
  }), dispatch, context);
  const boundedRawOutput = createBoundedJsonValueSnapshot(rawOutput, contract.policy.maxOutputBytes, `${kind} raw output at node ${node.key}`);
  const parsedOutput = parseCodeBoundary(contract.outputSchema, boundedRawOutput.value, `${kind} output at node ${node.key}`);
  return Object.freeze({
    input: boundedInput,
    output: createBoundedJsonSnapshot(parsedOutput, contract.policy.maxOutputBytes, `${kind} output at node ${node.key}`)
  });
}
async function runBuiltWorkflow(built, options) {
  const compilation = compileWorkflowGraph({
    graph: built.graph,
    limits: options.limits,
    projection: PUBLIC_WORKFLOW_REGISTRY_PROJECTION
  });
  for (const node of compilation.graph.nodes)
    publicOperationNode(node);
  const host = createAtetCodeHost(options.host);
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
        throw new AtetCodeError("internal", `Compiled workflow topology lost node ${nodeKey}.`, { nodeKey });
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
      values.set(outcome.node.key, outcome.executed.output.value);
      receipts.push(createNodeReceipt(receipts.length, outcome.node.key, outcome.node.executor.operation.kind, outcome.executed.input.sha256, outcome.executed.output.sha256));
    }
    const failure = outcomes.find((outcome) => outcome.kind === "failed");
    if (failure !== undefined) {
      throw workflowNodeFailure(failure.error, failure.node, receipts);
    }
    if (context.signal.aborted) {
      const cause = new AtetCodeError("cancelled", "Workflow execution was cancelled.");
      throw workflowRunFailure(cause, "Workflow execution was cancelled after the current wave settled.", receipts);
    }
  }
  let output;
  try {
    output = createBoundedJsonValueSnapshot(resolveValue(compilation.graph.outputs, values), MAX_WORKFLOW_RESULT_BYTES, "workflow output", {
      maximumDepth: MAX_WORKFLOW_RESULT_DEPTH,
      maximumValues: MAX_WORKFLOW_RESULT_VALUES
    }).value;
  } catch (error) {
    throw workflowRunFailure(error, `Workflow output resolution failed: ${atetCodeErrorMessage(error)}`, receipts);
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
function transmuteKindFromAtet(kind) {
  return kind.replace(/^atet\./u, "transmute.");
}
function createTransmuteCodeHost(options) {
  if (typeof options !== "object" || options === null) {
    throw new AtetCodeError("invalid-data", "A Transmute Code host must be an object.");
  }
  const legacyExecute = options.execute;
  const legacyAdmit = options.admit;
  if (typeof legacyExecute !== "function") {
    throw new AtetCodeError("invalid-data", "A Transmute Code host requires an execute function.");
  }
  if (legacyAdmit !== undefined && typeof legacyAdmit !== "function") {
    throw new AtetCodeError("invalid-data", "A Transmute Code host admit value must be a function when provided.");
  }
  const execute = async (request, context) => {
    const legacyKind = transmuteKindFromAtet(request.kind);
    return await legacyExecute({
      input: request.input,
      kind: legacyKind,
      nodeKey: request.nodeKey,
      version: 2
    }, context);
  };
  const admit = legacyAdmit === undefined ? undefined : async (request, dispatch, context) => await legacyAdmit({
    kind: transmuteKindFromAtet(request.kind),
    nodeKey: request.nodeKey,
    policy: request.policy,
    version: 2
  }, dispatch, context);
  return createAtetCodeHost({
    ...admit === undefined ? {} : { admit },
    execute
  });
}

export { WORKFLOW_GRAPH_VERSION, WORKFLOW_REF_VERSION, GRAPH_ABI, REQUIREMENT_ENVELOPE_VERSION, TRUSTED_COMPUTE_VERSION, WORKFLOW_COMPILATION_VERSION, LEGACY_WORKFLOW_GRAPH_VERSION, LEGACY_WORKFLOW_REF_VERSION, LEGACY_GRAPH_ABI, LEGACY_REQUIREMENT_ENVELOPE_VERSION, LEGACY_WORKFLOW_COMPILATION_VERSION, MAX_SERIALIZED_GRAPH_NODES, MAX_SERIALIZED_NODE_DEPENDENCIES, MAX_SERIALIZED_REF_PATH_SEGMENTS, MAX_OPERATION_DISCOVERY_ENTRIES, MAX_TRUSTED_COMPUTE_INPUT_BYTES, MAX_TRUSTED_COMPUTE_OUTPUT_BYTES, MAX_TRUSTED_COMPUTE_DURATION_MS, WorkflowIdSchema, NodeKeySegmentSchema, NodeKeySchema, SchemaIdSchema, ComputeKeySchema, OperationKindSchema, Sha256Schema, PositiveSafeIntegerSchema, NonnegativeSafeIntegerSchema, RefPathSegmentSchema, JsonValueSchema, SerializedRefV1Schema, GraphInputValueSchema, WorkflowOutputBindingSchema, AuthoredOperationIdentitySchema, AuthoredComputeIdentitySchema, AuthoredNodeExecutorSchema, AuthoredGraphNodeV1Schema, isOperationGraphNode, isComputeGraphNode, WorkflowIdentitySchema, AuthoredWorkflowGraphV1Schema, OPERATION_EFFECT_CLASSES, WORKFLOW_EFFECT_CLASSES, OPERATION_RESUME_CLASSES, WORKFLOW_RESUME_CLASSES, OPERATION_PREPARATION_KINDS, OPERATION_LIFECYCLE_KINDS, OPERATION_RESOURCE_KINDS, OperationResourceClaimSchema, OperationPolicySchema, TrustedComputePolicySchema, WorkflowNodePolicySchema, trustedComputePolicy, OperationDiscoverySchema, WorkflowRegistryProjectionSchema, GraphCompilerLimitsSchema, UNRESOLVED_REQUIREMENT_KINDS, RequirementEnvelopeBoundsSchema, RequirementEnvelopeSchema, CompiledWorkflowGraphSchema, TRUSTED_COMPUTE_BRAND, LEGACY_TRUSTED_COMPUTE_BRAND, WORKFLOW_REF_BRAND, AtetCodeError, atetCodeErrorMessage, asAtetCodeError, transmuteCodeErrorMessage, asTransmuteCodeError, createSha256HexHasher, sha256Hex, compareUtf16Strings, boundedCanonicalJson, boundedCanonicalJsonSha256, boundedCanonicalJsonFingerprint, canonicalJson, canonicalJsonSha256, canonicalJsonSha256Prefixed, canonicalJsonFingerprint, AtetImageModelSchema, AtetDiagramCheckInputSchema, AtetDiagramRenderInputSchema, AtetImageVectorizeInputSchema, AtetImageGenerateInputSchema, AtetLintFindingSchema, AtetDiagramCheckOutputSchema, AtetRenderArtifactsSchema, AtetDiagramRenderOutputSchema, AtetVectorizeQualityReceiptSchema, AtetVectorizeProvenanceSchema, AtetVectorizeReceiptSchema, AtetImageVectorizeOutputSchema, AtetImageGenerateOutputSchema, PORTABLE_ATET_OPERATION_KINDS, PORTABLE_ATET_OPERATION_CONTRACTS, isPortableAtetOperationKind, TransmuteImageModelSchema, TransmuteDiagramCheckInputSchema, TransmuteDiagramRenderInputSchema, TransmuteImageVectorizeInputSchema, TransmuteImageGenerateInputSchema, TransmuteLintFindingSchema, TransmuteDiagramCheckOutputSchema, TransmuteRenderArtifactsSchema, TransmuteDiagramRenderOutputSchema, TransmuteVectorizeQualityReceiptSchema, TransmuteVectorizeProvenanceSchema, TransmuteVectorizeReceiptSchema, TransmuteImageVectorizeOutputSchema, TransmuteImageGenerateOutputSchema, PORTABLE_TRANSMUTE_OPERATION_KINDS, PORTABLE_TRANSMUTE_OPERATION_CONTRACTS, isPortableTransmuteOperationKind, WORKFLOW_REGISTRY_PROJECTION_HASH_DOMAIN, PUBLIC_WORKFLOW_REGISTRY_PROJECTION_ID, LEGACY_PUBLIC_WORKFLOW_REGISTRY_PROJECTION_ID, boundedOperationDiscoveryList, normalizeOperationDiscovery, createWorkflowRegistryProjectionHash, createWorkflowRegistryProjection, parseWorkflowRegistryProjection, createPublicWorkflowRegistryProjection, PUBLIC_WORKFLOW_REGISTRY_PROJECTION, PUBLIC_TRANSMUTE_WORKFLOW_PROJECTION, PUBLIC_ATET_WORKFLOW_PROJECTION, WORKFLOW_GRAPH_HASH_DOMAIN, WORKFLOW_COMPILATION_HASH_DOMAIN, DEFAULT_GRAPH_COMPILER_LIMITS, normalizeAuthoredWorkflowGraph, createWorkflowGraphHash, createGraphHash, createWorkflowCompilationHash, compileWorkflowGraph, parseCompiledWorkflowGraph, defineWorkflowFragment, operationContract, WorkflowGraphBuilder, definePortableWorkflowFragment, PortableWorkflowBuilder, defineWorkflow, buildWorkflow, buildWorkflowGraph, defineCompute, defineAdvancedWorkflow, buildAdvancedWorkflow, seconds, WORKFLOW_NODE_RECEIPT_VERSION, WORKFLOW_NODE_RECEIPT_HASH_DOMAIN, MAX_WORKFLOW_RESULT_BYTES, MAX_WORKFLOW_RESULT_DEPTH, MAX_WORKFLOW_RESULT_VALUES, createAtetCodeHost, AtetWorkflowRunError, runBuiltWorkflow, runWorkflow, createTransmuteCodeHost };
