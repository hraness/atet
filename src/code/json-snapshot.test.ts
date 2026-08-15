import { describe, expect, spyOn, test } from "bun:test"

import {
  canonicalJson,
  canonicalJsonSha256,
  sha256Hex,
} from "./canonical-json.js"
import { AtetCodeError } from "./errors.js"
import {
  createBoundedJsonSnapshot,
  createBoundedJsonValueSnapshot,
  deepFreezeJson,
} from "./json-snapshot.js"

describe("JSON snapshots", () => {
  test("bounds, identifies, and deeply freezes one canonical snapshot", () => {
    const input = { nested: { values: [1, 2, 3] }, z: -0 }
    const snapshot = createBoundedJsonSnapshot(input, 1_024, "fixture")
    const expectedCanonical = canonicalJson({
      nested: { values: [1, 2, 3] },
      z: 0,
    })

    expect(snapshot.bytes).toBe(new TextEncoder().encode(expectedCanonical).byteLength)
    expect(snapshot.sha256).toBe(sha256Hex(expectedCanonical))
    expect(snapshot.canonicalText).toBeUndefined()
    expect(snapshot.value).not.toBe(input)
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.value)).toBe(true)
    const nested = (snapshot.value as { readonly nested: {
      readonly values: readonly number[]
    } }).nested
    expect(Object.isFrozen(nested)).toBe(true)
    expect(Object.isFrozen(nested.values)).toBe(true)
  })

  test("captures canonical text only when requested", () => {
    const input: unknown = JSON.parse(
      '{"10":"ten","2":"two","__proto__":"data"}',
    )
    const snapshot = createBoundedJsonSnapshot(input, 1_024, "fixture", {
      captureCanonicalText: true,
    })

    expect(snapshot.canonicalText).toBe(
      '{"10":"ten","2":"two","__proto__":"data"}',
    )
    expect(snapshot.sha256).toBe(sha256Hex(snapshot.canonicalText ?? ""))
  })

  test("captures bounded values without paying for an unused digest", () => {
    const input = { nested: [1, 2, 3], value: "kept" }
    const snapshot = createBoundedJsonValueSnapshot(input, 1_024, "value fixture")

    expect(snapshot.value).toEqual(input)
    expect(snapshot.value).not.toBe(input)
    expect(snapshot.bytes).toBe(
      new TextEncoder().encode(canonicalJson(input)).byteLength,
    )
    expect("sha256" in snapshot).toBe(false)
    expect(Object.isFrozen(snapshot.value)).toBe(true)
  })

  test("batches canonical hash updates while preserving exact identity", () => {
    const input = Array.from({ length: 50_000 }, (_, index) => index % 10)
    const canonical = canonicalJson(input)
    const expected = sha256Hex(canonical)
    const update = spyOn(Bun.CryptoHasher.prototype, "update")
    try {
      expect(canonicalJsonSha256(input)).toBe(expected)
    } finally {
      update.mockRestore()
    }
    expect(update.mock.calls.length).toBeLessThanOrEqual(
      Math.ceil(canonical.length / (64 * 1024)) + 1,
    )
  })

  test("freezes very deep JSON iteratively and rejects cycles", () => {
    const root: Record<string, unknown> = {}
    let cursor = root
    for (let depth = 0; depth < 20_000; depth += 1) {
      const next: Record<string, unknown> = {}
      cursor.next = next
      cursor = next
    }

    expect(() => deepFreezeJson(root)).not.toThrow()
    expect(Object.isFrozen(root)).toBe(true)
    expect(Object.isFrozen(cursor)).toBe(true)

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => deepFreezeJson(cyclic)).toThrow(AtetCodeError)
  })

  test("rejects a snapshot before returning values over its byte limit", () => {
    expect(() => createBoundedJsonSnapshot(
      { value: "four bytes and more" },
      4,
      "small fixture",
    )).toThrow("small fixture contains")
  })

  test("bounds escaped and malformed UTF-16 strings before serialization", () => {
    const input = "\"\\\u0000😀\ud800"
    const expected = new TextEncoder().encode(JSON.stringify(input)).byteLength

    expect(createBoundedJsonSnapshot(input, expected, "string fixture")).toMatchObject({
      bytes: expected,
      value: input,
    })
    expect(() => createBoundedJsonSnapshot(
      input,
      expected - 1,
      "string fixture",
    )).toThrow("contains more than")
  })

  test("fails hostile values closed before recursion or accessor execution", () => {
    let nested: unknown = "leaf"
    for (let depth = 0; depth < 256; depth += 1) nested = [nested]
    expect(() => createBoundedJsonSnapshot(
      nested,
      16_384,
      "deep fixture",
    )).toThrow(AtetCodeError)

    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => createBoundedJsonSnapshot(
      cyclic,
      1_024,
      "cyclic fixture",
    )).toThrow(AtetCodeError)

    let getterExecuted = false
    const accessor: Record<string, unknown> = {}
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get: () => {
        getterExecuted = true
        throw new Error("must not execute")
      },
    })
    expect(() => createBoundedJsonSnapshot(
      accessor,
      1_024,
      "accessor fixture",
    )).toThrow("plain data properties")
    expect(getterExecuted).toBe(false)
  })

  test("rejects a wide array before enumerating its elements", () => {
    let enumerated = false
    const wide = new Proxy(new Array<unknown>(11), {
      ownKeys: (target) => {
        enumerated = true
        return Reflect.ownKeys(target)
      },
    })
    expect(() => createBoundedJsonSnapshot(
      wide,
      1_024,
      "wide fixture",
      { maximumValues: 10 },
    )).toThrow("JSON values")
    expect(enumerated).toBe(false)
  })

  test("keeps captured snapshots strict about named array properties", () => {
    const input = [1] as number[] & { label?: string }
    input.label = "not part of the JSON value"

    expect(() => createBoundedJsonSnapshot(
      input,
      1_024,
      "named array fixture",
    )).toThrow("named properties")
  })

  test("captures an array length once before descriptor traversal", () => {
    let lengthReads = 0
    const input = new Proxy(["captured"], {
      get: (target, property, receiver) => {
        if (property !== "length") {
          return Reflect.get(target, property, receiver) as unknown
        }
        lengthReads += 1
        return lengthReads === 1 ? 1 : 2_000_000
      },
    })

    expect(createBoundedJsonSnapshot(input, 1_024, "changing array").value)
      .toEqual(["captured"])
    expect(lengthReads).toBe(1)
  })
})
