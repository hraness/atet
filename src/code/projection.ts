import {
  OperationDiscoverySchema,
  SchemaIdSchema,
  WorkflowRegistryProjectionSchema,
  type OperationDiscovery,
  type OperationDiscoverySource,
  type WorkflowRegistryProjection,
} from "./contracts.js"
import { canonicalJson, sha256Hex } from "./canonical-json.js"
import { parseCodeBoundary } from "./boundary.js"
import { TransmuteCodeError } from "./errors.js"
import {
  PORTABLE_TRANSMUTE_OPERATION_CONTRACTS,
  PORTABLE_TRANSMUTE_OPERATION_KINDS,
} from "./public-operations.js"

export const WORKFLOW_REGISTRY_PROJECTION_HASH_DOMAIN =
  "transmute.workflow.registry-projection/v1" as const
export const PUBLIC_WORKFLOW_REGISTRY_PROJECTION_ID =
  "transmute.workflow.registry.public/v1" as const

export type WorkflowRegistryProjectionSource =
  | OperationDiscoverySource
  | readonly OperationDiscovery[]

export interface CreateWorkflowRegistryProjectionOptions {
  readonly trustedCompute?: boolean
}

function discoveryList(
  source: WorkflowRegistryProjectionSource,
): readonly OperationDiscovery[] {
  return Array.isArray(source)
    ? source
    : (source as OperationDiscoverySource).list()
}

function operationKey(kind: string, version: number): string {
  return `${kind}@${String(version)}`
}

function uniqueSorted<Value extends string>(
  values: Iterable<Value>,
): readonly Value[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

export function normalizeOperationDiscovery(
  input: readonly OperationDiscovery[],
): readonly OperationDiscovery[] {
  const normalized = input.map((item) => {
    const parsed = parseCodeBoundary(
      OperationDiscoverySchema,
      item,
      "operation discovery entry",
    )
    const preparation = uniqueSorted(parsed.policy.preparation)
    if (preparation.length !== parsed.policy.preparation.length) {
      throw new TransmuteCodeError(
        "invalid-data",
        `Duplicate preparation requirement for ${operationKey(parsed.kind, parsed.version)}.`,
        { kind: parsed.kind, version: parsed.version },
      )
    }
    const resources = [...parsed.policy.resources]
      .sort((left, right) => left.resource.localeCompare(right.resource))
    if (new Set(resources.map(resource => resource.resource)).size !== resources.length) {
      throw new TransmuteCodeError(
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
      throw new TransmuteCodeError(
        "conflict",
        `Duplicate operation discovery entry: ${key}`,
        { kind: operation.kind, version: operation.version },
      )
    }
    seen.add(key)
  }
  return normalized
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
  const id = parseCodeBoundary(SchemaIdSchema, input.id, "registry projection id")
  const discovery = normalizeOperationDiscovery(input.discovery)
  const trustedCompute = input.trustedCompute ?? false
  return sha256Hex(
    `${WORKFLOW_REGISTRY_PROJECTION_HASH_DOMAIN}\0${canonicalJson({
      discovery,
      id,
      trustedCompute,
    })}`,
  )
}

export function createWorkflowRegistryProjection(
  idInput: string,
  source: WorkflowRegistryProjectionSource,
  options: CreateWorkflowRegistryProjectionOptions = {},
): WorkflowRegistryProjection {
  const id = parseCodeBoundary(SchemaIdSchema, idInput, "registry projection id")
  const discovery = normalizeOperationDiscovery(discoveryList(source))
  const trustedCompute = options.trustedCompute ?? false
  const parsed = parseCodeBoundary(WorkflowRegistryProjectionSchema, {
    discovery,
    id,
    projectionSha256: createWorkflowRegistryProjectionHash({
      discovery,
      id,
      trustedCompute,
    }),
    trustedCompute,
  }, "workflow registry projection")
  return Object.freeze({
    ...parsed,
    discovery: freezeDiscovery(parsed.discovery),
  })
}

export function parseWorkflowRegistryProjection(
  input: unknown,
): WorkflowRegistryProjection {
  const parsed = parseCodeBoundary(
    WorkflowRegistryProjectionSchema,
    input,
    "workflow registry projection",
  )
  const normalized = createWorkflowRegistryProjection(
    parsed.id,
    parsed.discovery,
    { trustedCompute: parsed.trustedCompute },
  )
  if (parsed.projectionSha256 !== normalized.projectionSha256) {
    throw new TransmuteCodeError(
      "invalid-data",
      "Workflow registry projection hash does not match its contents.",
      {
        actualProjectionSha256: parsed.projectionSha256,
        expectedProjectionSha256: normalized.projectionSha256,
        projectionId: parsed.id,
      },
    )
  }
  if (canonicalJson(parsed) !== canonicalJson(normalized)) {
    throw new TransmuteCodeError(
      "invalid-data",
      "Workflow registry projection discovery is not normalized.",
      { projectionId: parsed.id },
    )
  }
  return normalized
}

function publicDiscovery(): readonly OperationDiscovery[] {
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

/** Compatibility spelling for hosts that identify this as the Transmute projection. */
export const PUBLIC_TRANSMUTE_WORKFLOW_PROJECTION =
  PUBLIC_WORKFLOW_REGISTRY_PROJECTION
