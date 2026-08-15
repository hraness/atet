import type { JsonValue } from "./contracts.js"
import { AtetCodeError } from "./errors.js"
import { jsonStringUtf8ByteLength } from "./json-utf8.js"
import { createSha256HexHasher } from "./sha256.js"

export interface BoundedJsonSnapshot {
  readonly bytes: number
  readonly canonicalText?: string
  readonly sha256: string
  readonly value: JsonValue
  readonly values: number
}

export interface BoundedJsonValueSnapshot {
  readonly bytes: number
  readonly value: JsonValue
  readonly values: number
}

export interface BoundedCanonicalFingerprint {
  readonly bytes: number
  readonly sha256: string
}

export interface JsonSnapshotLimits {
  readonly captureCanonicalText?: boolean
  readonly maximumBytes?: number
  readonly maximumDepth?: number
  readonly maximumValues?: number
}

const DEFAULT_MAXIMUM_DEPTH = 128
const DEFAULT_MAXIMUM_VALUES = 1_000_000
const HASH_BUFFER_CODE_UNITS = 64 * 1024

type MutableJsonContainer = JsonValue[] | Record<string, JsonValue>
type StringPropertyDescriptors = Readonly<
  Record<string, PropertyDescriptor | undefined>
>

interface Assignment {
  readonly key: number | string
  readonly target: MutableJsonContainer
}

interface VisitFrame {
  readonly assignment?: Assignment
  readonly depth: number
  readonly kind: "visit"
  readonly value: unknown
}

interface ArrayFrame {
  readonly clone: JsonValue[] | undefined
  readonly depth: number
  readonly descriptors: StringPropertyDescriptors
  readonly index: number
  readonly kind: "array"
  readonly source: object
  readonly values: number
}

interface ObjectFrame {
  readonly clone: Record<string, JsonValue> | undefined
  readonly depth: number
  readonly descriptors: StringPropertyDescriptors
  readonly index: number
  readonly keys: readonly string[]
  readonly kind: "object"
  readonly source: object
}

type SnapshotFrame = ArrayFrame | ObjectFrame | VisitFrame

interface BoundedJsonCapture {
  readonly bytes: number
  readonly canonicalText?: string
  readonly sha256?: string
  readonly value?: JsonValue
  readonly values: number
}

interface JsonCaptureOptions {
  readonly captureText: boolean
  readonly captureValue: boolean
  readonly hash: boolean
  readonly hashPrefix?: string
  /** Preserve canonicalJson's released Array.map domain without cloning extras. */
  readonly ignoreNonIndexArrayProperties: boolean
}

interface FreezeFrame {
  readonly exiting: boolean
  readonly value: unknown
}

type MutableStructureContainer = unknown[] | Record<string, unknown>

interface StructureAssignment {
  readonly key: number | string
  readonly target: MutableStructureContainer
}

interface StructureVisitFrame {
  readonly assignment?: StructureAssignment
  readonly depth: number
  readonly kind: "visit"
  readonly value: unknown
}

interface StructureExitFrame {
  readonly kind: "exit"
  readonly source: object
}

type StructureFrame = StructureExitFrame | StructureVisitFrame

function invalidJson(
  message: string,
  details?: Readonly<Record<string, unknown>>,
): never {
  throw new AtetCodeError("invalid-data", message, details)
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    return invalidJson(`${name} must be a positive safe integer.`)
  }
  return value
}

function enumerableSymbolDescriptor(
  descriptors: object,
): boolean {
  return Object.getOwnPropertySymbols(descriptors).some(
    symbol => (Reflect.get(descriptors, symbol) as PropertyDescriptor | undefined)
      ?.enumerable === true,
  )
}

/**
 * Bounds recursive plain-container structure before an extensible user schema
 * runs. Foreign class instances and unsupported scalar kinds remain atomic so
 * schema preprocessors and transforms retain their established input contract.
 */
export function captureJsonStructure(
  input: unknown,
  name: string,
  limits: JsonSnapshotLimits = {},
): unknown {
  const maximumDepth = positiveLimit(
    limits.maximumDepth ?? DEFAULT_MAXIMUM_DEPTH,
    "JSON structure depth limit",
  )
  const maximumValues = positiveLimit(
    limits.maximumValues ?? DEFAULT_MAXIMUM_VALUES,
    "JSON structure value limit",
  )
  const maximumBytes = limits.maximumBytes === undefined
    ? undefined
    : positiveLimit(limits.maximumBytes, "JSON structure byte limit")
  const active = new WeakSet<object>()
  const pending: StructureFrame[] = [{ depth: 0, kind: "visit", value: input }]
  let bytes = 0
  let discoveredValues = 1
  let root: unknown
  let rootAssigned = false
  const addBytes = (additional: number): void => {
    if (maximumBytes === undefined) return
    if (additional > maximumBytes - bytes) {
      return invalidJson(
        `${name} contains more than ${String(maximumBytes)} bytes.`,
        { actualLowerBound: bytes + additional, maximumBytes },
      )
    }
    bytes += additional
  }
  const addJsonString = (value: string): void => {
    if (maximumBytes === undefined) return
    const additional = jsonStringUtf8ByteLength(value, maximumBytes - bytes)
    if (additional === undefined) {
      return invalidJson(
        `${name} contains more than ${String(maximumBytes)} bytes.`,
        { actualLowerBound: maximumBytes + 1, maximumBytes },
      )
    }
    bytes += additional
  }
  const discover = (additional: number): void => {
    if (additional > maximumValues - discoveredValues) {
      return invalidJson(
        `${name} contains more than ${String(maximumValues)} structural values.`,
        { actualLowerBound: discoveredValues + additional, maximumValues },
      )
    }
    discoveredValues += additional
  }
  const assign = (assignment: StructureAssignment | undefined, value: unknown): void => {
    if (assignment === undefined) {
      root = value
      rootAssigned = true
      return
    }
    Object.defineProperty(assignment.target, assignment.key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    })
  }

  try {
    while (pending.length > 0) {
      const frame = pending.pop()
      if (frame === undefined) continue
      if (frame.kind === "exit") {
        active.delete(frame.source)
        continue
      }
      if (frame.depth > maximumDepth) {
        return invalidJson(
          `${name} nesting exceeds ${String(maximumDepth)} levels.`,
          { actual: frame.depth, maximumDepth },
        )
      }
      const value = frame.value
      if (typeof value === "string") {
        addJsonString(value)
        assign(frame.assignment, value)
        continue
      }
      if (value === null) {
        addBytes(4)
        assign(frame.assignment, value)
        continue
      }
      if (typeof value === "boolean") {
        addBytes(value ? 4 : 5)
        assign(frame.assignment, value)
        continue
      }
      if (typeof value === "number") {
        if (Number.isFinite(value)) {
          addBytes(JSON.stringify(Object.is(value, -0) ? 0 : value).length)
        }
        assign(frame.assignment, value)
        continue
      }
      if (typeof value !== "object") {
        assign(frame.assignment, value)
        continue
      }
      const isArray = Array.isArray(value)
      if (!isArray) {
        const prototype: unknown = Object.getPrototypeOf(value)
        if (prototype !== Object.prototype && prototype !== null) {
          assign(frame.assignment, value)
          continue
        }
      }
      if (active.has(value)) {
        return invalidJson(`${name} does not support cyclic plain-container values.`)
      }

      const arrayLength = isArray ? (value as unknown[]).length : undefined
      if (arrayLength !== undefined && arrayLength > maximumValues - discoveredValues) {
        return invalidJson(
          `${name} contains more than ${String(maximumValues)} structural values.`,
          { actualLowerBound: discoveredValues + arrayLength, maximumValues },
        )
      }
      const descriptors = Object.getOwnPropertyDescriptors(value)
      if (Object.getOwnPropertySymbols(descriptors).some(
        symbol => (Reflect.get(descriptors, symbol) as PropertyDescriptor | undefined)
          ?.enumerable === true,
      )) {
        return invalidJson(`${name} cannot contain enumerable symbol properties.`)
      }
      const keys = Object.keys(descriptors)
        .filter(key => descriptors[key]?.enumerable === true)
      const namedArrayKeys = arrayLength === undefined
        ? []
        : keys.filter((key) => {
            const index = Number(key)
            return !(
              Number.isSafeInteger(index)
              && index >= 0
              && index < arrayLength
              && String(index) === key
            )
          })
      if (arrayLength !== undefined) {
        discover(arrayLength)
        discover(namedArrayKeys.length)
        addBytes(2 + Math.max(0, arrayLength - 1))
        for (const key of namedArrayKeys) {
          addJsonString(key)
          addBytes(1)
        }
      } else {
        discover(keys.length)
        addBytes(2 + Math.max(0, keys.length - 1))
        for (const key of keys) {
          addJsonString(key)
          addBytes(1)
        }
      }

      const clone: MutableStructureContainer = arrayLength === undefined
        ? {}
        : new Array<unknown>(arrayLength)
      assign(frame.assignment, clone)
      active.add(value)
      pending.push({ kind: "exit", source: value })
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index]
        if (key === undefined) continue
        const descriptor = descriptors[key]
        if (
          descriptor === undefined
          || descriptor.get !== undefined
          || descriptor.set !== undefined
        ) {
          return invalidJson(`${name} properties must be plain data properties.`)
        }
        const numericKey = arrayLength !== undefined
          && Number.isSafeInteger(Number(key))
          && Number(key) >= 0
          && Number(key) < arrayLength
          && String(Number(key)) === key
          ? Number(key)
          : key
        pending.push({
          assignment: { key: numericKey, target: clone },
          depth: frame.depth + 1,
          kind: "visit",
          value: descriptor.value,
        })
      }
    }
  } catch (error) {
    if (error instanceof AtetCodeError) throw error
    throw new AtetCodeError(
      "invalid-data",
      `${name} could not be safely inspected.`,
      { cause: error instanceof Error ? error.message : String(error) },
    )
  }

  if (!rootAssigned) {
    return invalidJson(`${name} did not contain a capturable value.`)
  }
  return root
}

export function preflightJsonStructure(
  input: unknown,
  name: string,
  limits: JsonSnapshotLimits = {},
): void {
  void captureJsonStructure(input, name, limits)
}

function assignValue(
  assignment: Assignment | undefined,
  value: JsonValue,
  setRoot: (root: JsonValue) => void,
): void {
  if (assignment === undefined) {
    setRoot(value)
    return
  }
  if (Array.isArray(assignment.target)) {
    assignment.target[assignment.key as number] = value
  } else {
    Object.defineProperty(assignment.target, assignment.key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    })
  }
}

function scalarJson(value: boolean | null | number | string): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return invalidJson("JSON snapshots do not support non-finite numbers.")
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  return JSON.stringify(value)
}

/**
 * Validates, clones, canonically hashes, byte-bounds, and freezes JSON without
 * recursive parsing or traversal. Object accessors are rejected from their
 * descriptors and are never invoked.
 */
function captureBoundedJson(
  input: unknown,
  maximumBytesInput: number,
  name: string,
  limits: JsonSnapshotLimits = {},
  capture: JsonCaptureOptions,
): BoundedJsonCapture {
  const maximumBytes = positiveLimit(maximumBytesInput, "JSON snapshot byte limit")
  const maximumDepth = positiveLimit(
    limits.maximumDepth ?? DEFAULT_MAXIMUM_DEPTH,
    "JSON snapshot depth limit",
  )
  const maximumValues = positiveLimit(
    limits.maximumValues ?? DEFAULT_MAXIMUM_VALUES,
    "JSON snapshot value limit",
  )
  const active = new WeakSet<object>()
  const hash = capture.hash ? createSha256HexHasher() : undefined
  let hashPart = capture.hashPrefix ?? ""
  const flushHash = (): void => {
    if (hash === undefined || hashPart.length === 0) return
    hash.update(hashPart)
    hashPart = ""
  }
  const captureCanonicalText = capture.captureText
  const canonicalParts: string[] = []
  let canonicalPart = ""
  const pending: SnapshotFrame[] = [{ depth: 0, kind: "visit", value: input }]
  let bytes = 0
  let discoveredValues = 1
  let root: JsonValue | undefined

  const append = (text: string, exactBytes = text.length): void => {
    if (exactBytes > maximumBytes - bytes) {
      return invalidJson(
        `${name} contains more than ${String(maximumBytes)} bytes.`,
        { actualLowerBound: bytes + exactBytes, maximumBytes },
      )
    }
    if (hash !== undefined) {
      hashPart += text
      if (hashPart.length >= HASH_BUFFER_CODE_UNITS) flushHash()
    }
    if (captureCanonicalText) {
      canonicalPart += text
      if (canonicalPart.length >= 64 * 1024) {
        canonicalParts.push(canonicalPart)
        canonicalPart = ""
      }
    }
    bytes += exactBytes
  }
  const discover = (additional: number): void => {
    if (additional > maximumValues - discoveredValues) {
      return invalidJson(
        `${name} contains more than ${String(maximumValues)} JSON values.`,
        { actualLowerBound: discoveredValues + additional, maximumValues },
      )
    }
    discoveredValues += additional
  }
  const setRoot = (value: JsonValue): void => {
    root = value
  }

  try {
    while (pending.length > 0) {
      const frame = pending.pop()
      if (frame === undefined) break

      if (frame.kind === "array") {
        if (frame.index === frame.values) {
          append("]")
          active.delete(frame.source)
          if (frame.clone !== undefined) Object.freeze(frame.clone)
          continue
        }
        if (frame.index > 0) append(",")
        const descriptor = frame.descriptors[String(frame.index)]
        if (
          descriptor === undefined
          || descriptor.get !== undefined
          || descriptor.set !== undefined
        ) {
          return invalidJson(
            `${name} arrays must contain plain data elements.`,
          )
        }
        pending.push({ ...frame, index: frame.index + 1 })
        pending.push({
          ...(frame.clone === undefined
            ? {}
            : { assignment: { key: frame.index, target: frame.clone } }),
          depth: frame.depth + 1,
          kind: "visit",
          value: descriptor.value,
        })
        continue
      }

      if (frame.kind === "object") {
        if (frame.index === frame.keys.length) {
          append("}")
          active.delete(frame.source)
          if (frame.clone !== undefined) Object.freeze(frame.clone)
          continue
        }
        const key = frame.keys[frame.index]
        if (key === undefined) {
          return invalidJson(`${name} lost an object key during traversal.`)
        }
        if (frame.index > 0) append(",")
        const keyBytes = jsonStringUtf8ByteLength(key, maximumBytes - bytes)
        if (keyBytes === undefined) {
          return invalidJson(
            `${name} contains more than ${String(maximumBytes)} bytes.`,
            { actualLowerBound: maximumBytes + 1, maximumBytes },
          )
        }
        append(scalarJson(key), keyBytes)
        append(":")
        const descriptor = frame.descriptors[key]
        if (
          descriptor === undefined
          || descriptor.get !== undefined
          || descriptor.set !== undefined
        ) {
          return invalidJson(`${name} properties must be plain data properties.`)
        }
        pending.push({ ...frame, index: frame.index + 1 })
        pending.push({
          ...(frame.clone === undefined
            ? {}
            : { assignment: { key, target: frame.clone } }),
          depth: frame.depth + 1,
          kind: "visit",
          value: descriptor.value,
        })
        continue
      }

      if (frame.depth > maximumDepth) {
        return invalidJson(
          `${name} nesting exceeds ${String(maximumDepth)} levels.`,
          { actual: frame.depth, maximumDepth },
        )
      }
      const value = frame.value
      if (
        value === null
        || typeof value === "boolean"
        || typeof value === "number"
        || typeof value === "string"
      ) {
        const normalized = typeof value === "number" && Object.is(value, -0)
          ? 0
          : value
        if (typeof value === "string") {
          const stringBytes = jsonStringUtf8ByteLength(
            value,
            maximumBytes - bytes,
          )
          if (stringBytes === undefined) {
            return invalidJson(
              `${name} contains more than ${String(maximumBytes)} bytes.`,
              { actualLowerBound: maximumBytes + 1, maximumBytes },
            )
          }
          append(scalarJson(value), stringBytes)
        } else {
          append(scalarJson(value))
        }
        if (capture.captureValue) {
          assignValue(frame.assignment, normalized, setRoot)
        }
        continue
      }
      if (typeof value !== "object") {
        return invalidJson(`${name} does not support ${typeof value} values.`)
      }
      if (active.has(value)) {
        return invalidJson(`${name} does not support cyclic values.`)
      }
      const arrayLength = Array.isArray(value) ? value.length : undefined
      if (
        arrayLength !== undefined
        && arrayLength > maximumValues - discoveredValues
      ) {
        return invalidJson(
          `${name} contains more than ${String(maximumValues)} JSON values.`,
          {
            actualLowerBound: discoveredValues + arrayLength,
            maximumValues,
          },
        )
      }
      if (arrayLength !== undefined) {
        const punctuationBytes = 2 + Math.max(0, arrayLength - 1)
        if (punctuationBytes > maximumBytes - bytes) {
          return invalidJson(
            `${name} contains more than ${String(maximumBytes)} bytes.`,
            { actualLowerBound: bytes + punctuationBytes, maximumBytes },
          )
        }
      }
      active.add(value)

      if (Array.isArray(value)) {
        const length = arrayLength
        if (length === undefined) {
          return invalidJson(`${name} lost an array length during traversal.`)
        }
        discoveredValues += length
        const descriptors = Object.getOwnPropertyDescriptors(value)
        if (!capture.ignoreNonIndexArrayProperties) {
          if (enumerableSymbolDescriptor(descriptors)) {
            return invalidJson(`${name} cannot contain enumerable symbol properties.`)
          }
          const keys = Object.keys(descriptors)
            .filter(key => descriptors[key]?.enumerable === true)
          if (
            keys.length !== length
            || keys.some((key, index) => key !== String(index))
          ) {
            return invalidJson(
              `${name} arrays must be dense and cannot have named properties.`,
            )
          }
        }
        const clone = capture.captureValue ? [] as JsonValue[] : undefined
        if (clone !== undefined) assignValue(frame.assignment, clone, setRoot)
        append("[")
        pending.push({
          clone,
          depth: frame.depth,
          descriptors,
          index: 0,
          kind: "array",
          source: value,
          values: length,
        })
        continue
      }

      const prototype: unknown = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) {
        return invalidJson(`${name} accepts only arrays and plain objects.`)
      }
      const descriptors = Object.getOwnPropertyDescriptors(value)
      if (enumerableSymbolDescriptor(descriptors)) {
        return invalidJson(`${name} cannot contain enumerable symbol properties.`)
      }
      const keys = Object.keys(descriptors)
        .filter(key => descriptors[key]?.enumerable === true)
        .sort()
      discover(keys.length)
      const clone: Record<string, JsonValue> | undefined = capture.captureValue
        ? {}
        : undefined
      if (clone !== undefined) assignValue(frame.assignment, clone, setRoot)
      append("{")
      pending.push({
        clone,
        depth: frame.depth,
        descriptors,
        index: 0,
        keys,
        kind: "object",
        source: value,
      })
    }
  } catch (error) {
    if (error instanceof AtetCodeError) throw error
    throw new AtetCodeError(
      "invalid-data",
      `${name} could not be safely inspected.`,
      { cause: error instanceof Error ? error.message : String(error) },
    )
  }

  if (capture.captureValue && root === undefined) {
    return invalidJson(`${name} did not contain a JSON value.`)
  }
  if (captureCanonicalText && canonicalPart.length > 0) {
    canonicalParts.push(canonicalPart)
  }
  flushHash()
  return Object.freeze({
    bytes,
    ...(captureCanonicalText
      ? { canonicalText: canonicalParts.join("") }
      : {}),
    ...(hash === undefined ? {} : { sha256: hash.digestHex() }),
    ...(capture.captureValue ? { value: root as JsonValue } : {}),
    values: discoveredValues,
  })
}

export function createBoundedJsonValueSnapshot(
  input: unknown,
  maximumBytesInput: number,
  name: string,
  limits: JsonSnapshotLimits = {},
): BoundedJsonValueSnapshot {
  const captured = captureBoundedJson(input, maximumBytesInput, name, limits, {
    captureText: false,
    captureValue: true,
    hash: false,
    ignoreNonIndexArrayProperties: false,
  })
  if (captured.value === undefined) {
    return invalidJson(`${name} did not produce a complete JSON value snapshot.`)
  }
  return captured as BoundedJsonValueSnapshot
}

export function createBoundedJsonSnapshot(
  input: unknown,
  maximumBytesInput: number,
  name: string,
  limits: JsonSnapshotLimits = {},
): BoundedJsonSnapshot {
  const captured = captureBoundedJson(input, maximumBytesInput, name, limits, {
    captureText: limits.captureCanonicalText === true,
    captureValue: true,
    hash: true,
    ignoreNonIndexArrayProperties: false,
  })
  if (captured.sha256 === undefined || captured.value === undefined) {
    return invalidJson(`${name} did not produce a complete JSON snapshot.`)
  }
  return captured as BoundedJsonSnapshot
}

export function createBoundedCanonicalJson(
  input: unknown,
  maximumBytesInput: number,
  name: string,
  limits: JsonSnapshotLimits = {},
): string {
  const captured = captureBoundedJson(input, maximumBytesInput, name, limits, {
    captureText: true,
    captureValue: false,
    hash: false,
    ignoreNonIndexArrayProperties: true,
  })
  if (captured.canonicalText === undefined) {
    return invalidJson(`${name} did not produce canonical JSON text.`)
  }
  return captured.canonicalText
}

export function createBoundedCanonicalFingerprint(
  input: unknown,
  maximumBytesInput: number,
  name: string,
  limits: JsonSnapshotLimits = {},
  hashPrefix?: string,
): BoundedCanonicalFingerprint {
  const captured = captureBoundedJson(input, maximumBytesInput, name, limits, {
    captureText: false,
    captureValue: false,
    hash: true,
    ignoreNonIndexArrayProperties: true,
    ...(hashPrefix === undefined ? {} : { hashPrefix }),
  })
  if (captured.sha256 === undefined) {
    return invalidJson(`${name} did not produce a canonical JSON identity.`)
  }
  return Object.freeze({ bytes: captured.bytes, sha256: captured.sha256 })
}

export function createBoundedCanonicalSha256(
  input: unknown,
  maximumBytesInput: number,
  name: string,
  limits: JsonSnapshotLimits = {},
  hashPrefix?: string,
): string {
  return createBoundedCanonicalFingerprint(
    input,
    maximumBytesInput,
    name,
    limits,
    hashPrefix,
  ).sha256
}

/**
 * Deeply freezes an already JSON-shaped value without consuming the call stack.
 * This is kept for internal values whose byte identity was established earlier.
 */
export function deepFreezeJson<Value>(value: Value): Value {
  const active = new WeakSet<object>()
  const completed = new WeakSet<object>()
  const pending: FreezeFrame[] = [{ exiting: false, value }]

  try {
    while (pending.length > 0) {
      const item = pending.pop()
      if (item === undefined) break
      const current = item.value
      if (
        current === null
        || typeof current === "boolean"
        || typeof current === "string"
      ) {
        continue
      }
      if (typeof current === "number") {
        if (!Number.isFinite(current)) {
          return invalidJson("JSON snapshots do not support non-finite numbers.")
        }
        continue
      }
      if (typeof current !== "object") {
        return invalidJson(`JSON snapshots do not support ${typeof current} values.`)
      }
      if (item.exiting) {
        active.delete(current)
        completed.add(current)
        Object.freeze(current)
        continue
      }
      if (completed.has(current)) continue
      if (active.has(current)) {
        return invalidJson("JSON snapshots do not support cycles.")
      }
      active.add(current)
      pending.push({ exiting: true, value: current })
      if (Array.isArray(current)) {
        const length = current.length
        const descriptors = Object.getOwnPropertyDescriptors(current)
        if (enumerableSymbolDescriptor(descriptors)) {
          return invalidJson("JSON snapshots cannot contain enumerable symbol properties.")
        }
        const keys = Object.keys(descriptors)
          .filter(key => descriptors[key]?.enumerable === true)
        if (
          keys.length !== length
          || keys.some((key, index) => key !== String(index))
        ) {
          return invalidJson(
            "JSON snapshot arrays must be dense and cannot have named properties.",
          )
        }
        for (let index = length - 1; index >= 0; index -= 1) {
          const descriptor = descriptors[String(index)]
          if (
            descriptor === undefined
            || descriptor.get !== undefined
            || descriptor.set !== undefined
          ) {
            return invalidJson(
              "JSON snapshot arrays must contain plain data elements.",
            )
          }
          pending.push({ exiting: false, value: descriptor.value })
        }
        continue
      }

      const prototype: unknown = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) {
        return invalidJson("JSON snapshots accept only arrays and plain objects.")
      }
      const descriptors = Object.getOwnPropertyDescriptors(current)
      if (enumerableSymbolDescriptor(descriptors)) {
        return invalidJson("JSON snapshots cannot contain enumerable symbol properties.")
      }
      const keys = Object.keys(descriptors)
        .filter(key => descriptors[key]?.enumerable === true)
      for (let index = keys.length - 1; index >= 0; index -= 1) {
        const key = keys[index]
        if (key === undefined) continue
        const descriptor = descriptors[key]
        if (
          descriptor === undefined
          || descriptor.get !== undefined
          || descriptor.set !== undefined
        ) {
          return invalidJson("JSON snapshot properties must be plain data properties.")
        }
        if (descriptor.value === undefined) {
          return invalidJson(`JSON snapshot property ${key} is undefined.`)
        }
        pending.push({ exiting: false, value: descriptor.value })
      }
    }
  } catch (error) {
    if (error instanceof AtetCodeError) throw error
    throw new AtetCodeError(
      "invalid-data",
      "JSON snapshot could not be safely inspected.",
      { cause: error instanceof Error ? error.message : String(error) },
    )
  }

  return value
}
