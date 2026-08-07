import {
  createBoundedCanonicalJson,
  createBoundedCanonicalFingerprint,
  createBoundedCanonicalSha256,
} from "./json-snapshot.js"
import {
  createSha256HexHasher,
  sha256Hex,
  type Sha256HexHasher,
} from "./sha256.js"

type JsonScalar = boolean | null | number | string

// Generic canonicalization is a representation primitive, not a product input
// boundary. Foreign-data callers own explicit ceilings through the bounded
// entry points below; the released generic surface retains safe-integer
// accounting without shrinking its prior acceptance domain.
const MAX_CANONICAL_JSON_BYTES = Number.MAX_SAFE_INTEGER
const MAX_CANONICAL_JSON_DEPTH = Number.MAX_SAFE_INTEGER
const MAX_CANONICAL_JSON_VALUES = Number.MAX_SAFE_INTEGER

export type CanonicalJsonValue =
  | JsonScalar
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue }

export interface CanonicalJsonFingerprint {
  readonly bytes: number
  readonly sha256: string
}

export interface CanonicalJsonBounds {
  readonly maximumBytes: number
  readonly maximumDepth?: number
  readonly maximumValues?: number
  readonly name?: string
}

/** Exact UTF-16 code-unit ordering for non-versioned local collections. */
export function compareUtf16Strings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function canonicalLimits(bounds?: CanonicalJsonBounds) {
  return {
    maximumDepth: bounds?.maximumDepth ?? MAX_CANONICAL_JSON_DEPTH,
    maximumValues: bounds?.maximumValues ?? MAX_CANONICAL_JSON_VALUES,
  } as const
}

export function boundedCanonicalJson(
  value: unknown,
  bounds: CanonicalJsonBounds,
): string {
  return createBoundedCanonicalJson(
    value,
    bounds.maximumBytes,
    bounds.name ?? "Canonical JSON",
    canonicalLimits(bounds),
  )
}

export function boundedCanonicalJsonSha256(
  value: unknown,
  bounds: CanonicalJsonBounds,
  hashPrefix?: string,
): string {
  return createBoundedCanonicalSha256(
    value,
    bounds.maximumBytes,
    bounds.name ?? "Canonical JSON",
    canonicalLimits(bounds),
    hashPrefix,
  )
}

export function boundedCanonicalJsonFingerprint(
  value: unknown,
  bounds: CanonicalJsonBounds,
  hashPrefix?: string,
): CanonicalJsonFingerprint {
  return createBoundedCanonicalFingerprint(
    value,
    bounds.maximumBytes,
    bounds.name ?? "Canonical JSON",
    canonicalLimits(bounds),
    hashPrefix,
  )
}

export function canonicalJson(value: unknown): string {
  return boundedCanonicalJson(value, {
    maximumBytes: MAX_CANONICAL_JSON_BYTES,
  })
}

export function canonicalJsonSha256(value: unknown): string {
  return boundedCanonicalJsonSha256(value, {
    maximumBytes: MAX_CANONICAL_JSON_BYTES,
  })
}

export function canonicalJsonSha256Prefixed(
  prefix: string,
  value: unknown,
): string {
  return boundedCanonicalJsonSha256(
    value,
    { maximumBytes: MAX_CANONICAL_JSON_BYTES },
    prefix,
  )
}

export function canonicalJsonFingerprint(
  value: unknown,
  hashPrefix?: string,
): CanonicalJsonFingerprint {
  return boundedCanonicalJsonFingerprint(
    value,
    { maximumBytes: MAX_CANONICAL_JSON_BYTES },
    hashPrefix,
  )
}

export {
  createSha256HexHasher,
  sha256Hex,
  type Sha256HexHasher,
}
