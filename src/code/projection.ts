import {
  MAX_OPERATION_DISCOVERY_ENTRIES,
  OPERATION_PREPARATION_KINDS,
  OPERATION_RESOURCE_KINDS,
  OperationDiscoverySchema,
  SchemaIdSchema,
  WorkflowRegistryProjectionSchema,
  type OperationDiscovery,
  type OperationDiscoverySource,
  type WorkflowRegistryProjection,
} from "./contracts.js"
import {
  canonicalJsonSha256,
  canonicalJsonSha256Prefixed,
} from "./canonical-json.js"
import { parseCodeBoundary } from "./boundary.js"
import { AtetCodeError } from "./errors.js"
import { createBoundedJsonValueSnapshot } from "./json-snapshot.js"
import {
  PORTABLE_ATET_OPERATION_CONTRACTS,
  PORTABLE_ATET_OPERATION_KINDS,
  PORTABLE_TRANSMUTE_OPERATION_CONTRACTS,
  PORTABLE_TRANSMUTE_OPERATION_KINDS,
} from "./public-operations.js"

export const WORKFLOW_REGISTRY_PROJECTION_HASH_DOMAIN =
  // Stable domain salt for version-one projection hashes. The serialized
  // projection identity and discovery are canonicalized independently.
  "transmute.workflow.registry-projection/v1" as const
export const PUBLIC_WORKFLOW_REGISTRY_PROJECTION_ID =
  "atet.workflow.registry.public/v1" as const
export const LEGACY_PUBLIC_WORKFLOW_REGISTRY_PROJECTION_ID =
  "transmute.workflow.registry.public/v1" as const

export type WorkflowRegistryProjectionSource =
  | OperationDiscoverySource
  | readonly OperationDiscovery[]

export interface CreateWorkflowRegistryProjectionOptions {
  readonly trustedCompute?: boolean
}

const OWNED_NORMALIZED_PROJECTIONS = new WeakSet<object>()
const MAX_OPERATION_DISCOVERY_VALUES = 17
  + OPERATION_PREPARATION_KINDS.length
  + (3 * OPERATION_RESOURCE_KINDS.length)
const MAX_OPERATION_DISCOVERY_LIST_VALUES = 1
  + (MAX_OPERATION_DISCOVERY_ENTRIES * MAX_OPERATION_DISCOVERY_VALUES)
const MAX_OPERATION_DISCOVERY_LIST_BYTES = 32 * 1024 * 1024
const MAX_OPERATION_DISCOVERY_LIST_DEPTH = 8
const MAX_WORKFLOW_REGISTRY_PROJECTION_BYTES =
  MAX_OPERATION_DISCOVERY_LIST_BYTES + 4_096
const MAX_WORKFLOW_REGISTRY_PROJECTION_DEPTH =
  MAX_OPERATION_DISCOVERY_LIST_DEPTH + 1
const MAX_WORKFLOW_REGISTRY_PROJECTION_VALUES =
  MAX_OPERATION_DISCOVERY_LIST_VALUES + 5

function discoveryList(
  source: WorkflowRegistryProjectionSource,
): unknown {
  return Array.isArray(source)
    ? source
    : (source as OperationDiscoverySource).list()
}

export function boundedOperationDiscoveryList(
  input: unknown,
  name = "operation discovery list",
): readonly unknown[] {
  if (!Array.isArray(input)) {
    throw new AtetCodeError("invalid-data", `${name} must be an array.`)
  }
  const length = input.length
  if (length > MAX_OPERATION_DISCOVERY_ENTRIES) {
    throw new AtetCodeError(
      "invalid-data",
      `${name} cannot exceed ${String(MAX_OPERATION_DISCOVERY_ENTRIES)} entries.`,
    )
  }
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (Object.getOwnPropertySymbols(descriptors).some(
    symbol => (Reflect.get(descriptors, symbol) as PropertyDescriptor | undefined)
      ?.enumerable === true,
  )) {
    throw new AtetCodeError(
      "invalid-data",
      `${name} cannot contain enumerable symbol properties.`,
    )
  }
  const keys = Object.keys(descriptors)
    .filter(key => descriptors[key]?.enumerable === true)
  if (
    keys.length !== length
    || keys.some((key, index) => key !== String(index))
  ) {
    throw new AtetCodeError(
      "invalid-data",
      `${name} must be dense and cannot have named properties.`,
    )
  }
  const punctuationBytes = 2 + Math.max(0, length - 1)
  let bytes = punctuationBytes
  let values = 1
  const captured: unknown[] = []
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)]
    if (
      descriptor === undefined
      || descriptor.get !== undefined
      || descriptor.set !== undefined
    ) {
      throw new AtetCodeError(
        "invalid-data",
        `${name} must contain plain data elements.`,
      )
    }
    const remainingBytes = MAX_OPERATION_DISCOVERY_LIST_BYTES - bytes
    if (remainingBytes < 1) {
      throw new AtetCodeError(
        "invalid-data",
        `${name} contains more than ${String(MAX_OPERATION_DISCOVERY_LIST_BYTES)} bytes.`,
      )
    }
    const snapshot = createBoundedJsonValueSnapshot(
      descriptor.value,
      remainingBytes,
      `${name} entry ${String(index)}`,
      {
        maximumDepth: MAX_OPERATION_DISCOVERY_LIST_DEPTH - 1,
        maximumValues: MAX_OPERATION_DISCOVERY_VALUES,
      },
    )
    bytes += snapshot.bytes
    values += snapshot.values
    if (values > MAX_OPERATION_DISCOVERY_LIST_VALUES) {
      throw new AtetCodeError(
        "invalid-data",
        `${name} contains more than ${String(MAX_OPERATION_DISCOVERY_LIST_VALUES)} JSON values.`,
      )
    }
    captured.push(snapshot.value)
  }
  return Object.freeze(captured)
}

function operationKey(kind: string, version: number): string {
  return `${kind}@${String(version)}`
}

function uniqueSorted<Value extends string>(
  values: Iterable<Value>,
): readonly Value[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function canonicalAtetIdentity(value: string): string {
  if (value === "studio" || value === "transmute") return "atet"
  return value
    .replace(/^studio\./u, "atet.")
    .replace(/^transmute\./u, "atet.")
}

function normalizeOperationDiscoveryPreservingIdentity(
  input: unknown,
): readonly OperationDiscovery[] {
  const normalized = boundedOperationDiscoveryList(input).map((item) => {
    const parsed = parseCodeBoundary(
      OperationDiscoverySchema,
      item,
      "operation discovery entry",
    )
    const preparation = uniqueSorted(parsed.policy.preparation)
    if (preparation.length !== parsed.policy.preparation.length) {
      throw new AtetCodeError(
        "invalid-data",
        `Duplicate preparation requirement for ${operationKey(parsed.kind, parsed.version)}.`,
        { kind: parsed.kind, version: parsed.version },
      )
    }
    const resources = [...parsed.policy.resources]
      .sort((left, right) => (
        left.resource.localeCompare(right.resource)
      ))
    if (new Set(resources.map(resource => resource.resource)).size !== resources.length) {
      throw new AtetCodeError(
        "invalid-data",
        `Duplicate resource claim for ${operationKey(parsed.kind, parsed.version)}.`,
        { kind: parsed.kind, version: parsed.version },
      )
    }
    return parseCodeBoundary(OperationDiscoverySchema, {
      ...parsed,
      policy: { ...parsed.policy, preparation, resources },
    }, "normalized operation discovery entry")
  }).sort((left, right) => (
    left.kind.localeCompare(right.kind) || left.version - right.version
  ))
  const seen = new Set<string>()
  for (const operation of normalized) {
    const key = operationKey(operation.kind, operation.version)
    if (seen.has(key)) {
      throw new AtetCodeError(
        "conflict",
        `Duplicate operation discovery entry: ${key}`,
        { kind: operation.kind, version: operation.version },
      )
    }
    seen.add(key)
  }
  return normalized
}

export function normalizeOperationDiscovery(
  input: unknown,
): readonly OperationDiscovery[] {
  return normalizeOperationDiscoveryPreservingIdentity(input).map(operation => (
    parseCodeBoundary(OperationDiscoverySchema, {
      ...operation,
      inputSchemaId: canonicalAtetIdentity(operation.inputSchemaId),
      kind: canonicalAtetIdentity(operation.kind),
      outputSchemaId: canonicalAtetIdentity(operation.outputSchemaId),
    }, "canonical operation discovery entry")
  ))
}

function freezeDiscovery(
  discovery: readonly OperationDiscovery[],
): readonly OperationDiscovery[] {
  return Object.freeze(discovery.map(operation => Object.freeze({
    ...operation,
    policy: Object.freeze({
      ...operation.policy,
      preparation: Object.freeze([...operation.policy.preparation]),
      resources: Object.freeze(operation.policy.resources.map(
        resource => Object.freeze({ ...resource }),
      )),
    }),
  })))
}

export function createWorkflowRegistryProjectionHash(input: {
  readonly discovery: readonly OperationDiscovery[]
  readonly id: string
  readonly trustedCompute?: boolean
}): string {
  const id = canonicalAtetIdentity(
    parseCodeBoundary(SchemaIdSchema, input.id, "registry projection id"),
  )
  const discovery = normalizeOperationDiscovery(input.discovery)
  const trustedCompute = input.trustedCompute ?? false
  return workflowRegistryProjectionHashFromNormalized({
    discovery,
    id,
    trustedCompute,
  })
}

function workflowRegistryProjectionHashFromNormalized(input: {
  readonly discovery: readonly OperationDiscovery[]
  readonly id: string
  readonly trustedCompute: boolean
}, domain = WORKFLOW_REGISTRY_PROJECTION_HASH_DOMAIN): string {
  return canonicalJsonSha256Prefixed(
    `${domain}\0`,
    {
      discovery: input.discovery,
      id: input.id,
      trustedCompute: input.trustedCompute,
    },
  )
}

export function createWorkflowRegistryProjection(
  idInput: string,
  source: WorkflowRegistryProjectionSource,
  options: CreateWorkflowRegistryProjectionOptions = {},
): WorkflowRegistryProjection {
  const id = canonicalAtetIdentity(
    parseCodeBoundary(SchemaIdSchema, idInput, "registry projection id"),
  )
  const discovery = normalizeOperationDiscovery(discoveryList(source))
  const trustedCompute = options.trustedCompute ?? false
  const parsed = parseCodeBoundary(WorkflowRegistryProjectionSchema, {
    discovery,
    id,
    projectionSha256: workflowRegistryProjectionHashFromNormalized({
      discovery,
      id,
      trustedCompute,
    }),
    trustedCompute,
  }, "workflow registry projection")
  const projection = Object.freeze({
    ...parsed,
    discovery: freezeDiscovery(parsed.discovery),
  })
  OWNED_NORMALIZED_PROJECTIONS.add(projection)
  return projection
}

export function parseWorkflowRegistryProjection(
  input: unknown,
): WorkflowRegistryProjection {
  if (
    typeof input === "object"
    && input !== null
    && OWNED_NORMALIZED_PROJECTIONS.has(input)
  ) {
    return input as WorkflowRegistryProjection
  }
  const captured = createBoundedJsonValueSnapshot(
    input,
    MAX_WORKFLOW_REGISTRY_PROJECTION_BYTES,
    "workflow registry projection",
    {
      maximumDepth: MAX_WORKFLOW_REGISTRY_PROJECTION_DEPTH,
      maximumValues: MAX_WORKFLOW_REGISTRY_PROJECTION_VALUES,
    },
  ).value
  const parsed = parseCodeBoundary(
    WorkflowRegistryProjectionSchema,
    captured,
    "workflow registry projection",
  )
  const exactDiscovery = normalizeOperationDiscoveryPreservingIdentity(
    parsed.discovery,
  )
  const exactIdentity = {
    discovery: exactDiscovery,
    id: parsed.id,
    trustedCompute: parsed.trustedCompute,
  }
  const expectedProjectionSha256 =
    workflowRegistryProjectionHashFromNormalized(exactIdentity)
  if (parsed.projectionSha256 !== expectedProjectionSha256) {
    throw new AtetCodeError(
      "invalid-data",
      "Workflow registry projection hash does not match its contents.",
      {
        actualProjectionSha256: parsed.projectionSha256,
        expectedProjectionSha256,
        projectionId: parsed.id,
      },
    )
  }
  if (canonicalJsonSha256(parsed.discovery) !== canonicalJsonSha256(exactDiscovery)) {
    throw new AtetCodeError(
      "invalid-data",
      "Workflow registry projection discovery is not normalized.",
      { projectionId: parsed.id },
    )
  }
  return createWorkflowRegistryProjection(
    parsed.id,
    exactDiscovery,
    { trustedCompute: parsed.trustedCompute },
  )
}

function publicDiscovery(): readonly OperationDiscovery[] {
  return PORTABLE_ATET_OPERATION_KINDS.map((kind) => {
    const contract = PORTABLE_ATET_OPERATION_CONTRACTS[kind]
    return {
      inputSchemaId: contract.inputSchemaId,
      kind: contract.kind,
      lifecycle: contract.lifecycle,
      outputSchemaId: contract.outputSchemaId,
      policy: contract.policy,
      version: contract.version,
    }
  })
}

function legacyPublicDiscovery(): readonly OperationDiscovery[] {
  return PORTABLE_TRANSMUTE_OPERATION_KINDS.map((kind) => {
    const contract = PORTABLE_TRANSMUTE_OPERATION_CONTRACTS[kind]
    return {
      inputSchemaId: contract.inputSchemaId,
      kind: contract.kind,
      lifecycle: contract.lifecycle,
      outputSchemaId: contract.outputSchemaId,
      policy: contract.policy,
      version: contract.version,
    }
  })
}

export function createPublicWorkflowRegistryProjection(): WorkflowRegistryProjection {
  return createWorkflowRegistryProjection(
    PUBLIC_WORKFLOW_REGISTRY_PROJECTION_ID,
    publicDiscovery(),
    { trustedCompute: false },
  )
}

export const PUBLIC_WORKFLOW_REGISTRY_PROJECTION =
  createPublicWorkflowRegistryProjection()

const legacyPublicDiscoveryEntries =
  normalizeOperationDiscoveryPreservingIdentity(legacyPublicDiscovery())

/** Exact version-one discovery retained only for predecessor readers. */
export const PUBLIC_TRANSMUTE_WORKFLOW_PROJECTION = Object.freeze({
  discovery: freezeDiscovery(legacyPublicDiscoveryEntries),
  id: LEGACY_PUBLIC_WORKFLOW_REGISTRY_PROJECTION_ID,
  projectionSha256: workflowRegistryProjectionHashFromNormalized({
    discovery: legacyPublicDiscoveryEntries,
    id: LEGACY_PUBLIC_WORKFLOW_REGISTRY_PROJECTION_ID,
    trustedCompute: false,
  }),
  trustedCompute: false,
}) satisfies WorkflowRegistryProjection

/** Compatibility spelling for hosts that identify this as the Atet projection. */
export const PUBLIC_ATET_WORKFLOW_PROJECTION =
  PUBLIC_WORKFLOW_REGISTRY_PROJECTION
