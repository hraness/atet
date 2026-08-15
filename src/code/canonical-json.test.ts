import { describe, expect, test } from "bun:test"

import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"

import {
  boundedCanonicalJson,
  canonicalJson,
  canonicalJsonFingerprint,
  canonicalJsonSha256,
  sha256Hex,
} from "./canonical-json.js"
import { AtetCodeError } from "./errors.js"
import { jsonStringUtf8ByteLength, utf8ByteLength } from "./json-utf8.js"

function canonicalError(value: unknown): AtetCodeError {
  try {
    canonicalJson(value)
  } catch (error) {
    if (error instanceof AtetCodeError) return error
    throw error
  }
  throw new Error("Expected canonical JSON to reject the value.")
}

describe("portable canonical JSON", () => {
  test("counts JSON string UTF-8 bytes exactly before allocation", () => {
    const encoder = new TextEncoder()
    const corpus = [
      "",
      "plain ASCII",
      "\"\\\b\t\n\f\r",
      String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index)),
      "éह漢字",
      "😀🧑🏾‍🎨",
      "\ud800",
      "\udfff",
      "a\ud800b\udfffc",
    ]
    for (let codeUnit = 0; codeUnit <= 0xffff; codeUnit += 257) {
      corpus.push(String.fromCharCode(codeUnit))
    }

    for (const value of corpus) {
      const expected = encoder.encode(JSON.stringify(value)).byteLength
      expect(jsonStringUtf8ByteLength(value)).toBe(expected)
      expect(jsonStringUtf8ByteLength(value, expected)).toBe(expected)
      expect(jsonStringUtf8ByteLength(value, expected - 1)).toBeUndefined()

      const rawExpected = encoder.encode(value).byteLength
      expect(utf8ByteLength(value)).toBe(rawExpected)
      expect(utf8ByteLength(value, rawExpected)).toBe(rawExpected)
      if (rawExpected > 0) {
        expect(utf8ByteLength(value, rawExpected - 1)).toBeUndefined()
      }
    }
  })

  test("orders object keys and normalizes negative zero", () => {
    expect(canonicalJson({ z: -0, a: { y: 2, b: 3 } })).toBe(
      '{"a":{"b":3,"y":2},"z":0}',
    )
  })

  test("keeps canonical text and identity aligned for integer-like keys", () => {
    const input: unknown = JSON.parse(
      '{"10":"ten","2":"two","__proto__":"data"}',
    )
    const canonical = canonicalJson(input)

    expect(canonical).toBe('{"10":"ten","2":"two","__proto__":"data"}')
    expect(canonicalJsonSha256(input)).toBe(sha256Hex(canonical))
    expect(canonicalJsonFingerprint(input)).toEqual({
      bytes: new TextEncoder().encode(canonical).byteLength,
      sha256: sha256Hex(canonical),
    })
  })

  test("keeps the native digest identical to the portable fallback", () => {
    const input = "atet\0portable SHA-256 \ud83c\udfa8"
    expect(sha256Hex(input)).toBe(bytesToHex(
      sha256(new TextEncoder().encode(input)),
    ))
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    )
  })

  test("rejects sparse arrays instead of collapsing distinct values", () => {
    const oneHole = new Array<unknown>(1)
    const twoHoles = new Array<unknown>(2)

    expect(canonicalError(oneHole).code).toBe("invalid-data")
    expect(canonicalError(twoHoles).code).toBe("invalid-data")
    expect(() => canonicalJson([undefined])).toThrow(AtetCodeError)
  })

  test("ignores named array properties like the released SDK and rejects cycles", () => {
    const named = [1] as number[] & { label?: string }
    named.label = "not JSON"
    Object.defineProperty(named, Symbol("metadata"), {
      enumerable: true,
      value: "also not JSON",
    })
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic

    expect(canonicalJson(named)).toBe("[1]")
    expect(canonicalJsonSha256(named)).toBe(sha256Hex("[1]"))
    expect(canonicalJsonFingerprint(named)).toEqual({
      bytes: 3,
      sha256: sha256Hex("[1]"),
    })
    expect(canonicalError(cyclic).message).toContain("cyclic")
  })

  test("canonicalizes one captured descriptor snapshot without rereading a Proxy", () => {
    let valueReads = 0
    const input = new Proxy({ value: "captured" }, {
      get: (target, property, receiver) => {
        if (property === "value") valueReads += 1
        return Reflect.get(target, property, receiver) as unknown
      },
    })

    expect(canonicalJson(input)).toBe('{"value":"captured"}')
    expect(valueReads).toBe(0)
  })

  test("preflights deep, accessor, and wide values without recursion or enumeration", () => {
    let nested: unknown = "leaf"
    for (let depth = 0; depth < 256; depth += 1) nested = { nested }
    expect(() => boundedCanonicalJson(nested, {
      maximumBytes: 16_384,
      maximumDepth: 128,
      maximumValues: 1_000,
      name: "bounded deep fixture",
    })).toThrow("nesting exceeds")

    let getterExecuted = false
    const accessor: Record<string, unknown> = {}
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get: () => {
        getterExecuted = true
        throw new Error("must not execute")
      },
    })
    expect(canonicalError(accessor).message).toContain("plain data properties")
    expect(getterExecuted).toBe(false)

    let enumeratedWideArray = false
    const wide = new Proxy(new Array<unknown>(11), {
      ownKeys: (target) => {
        enumeratedWideArray = true
        return Reflect.ownKeys(target)
      },
    })
    expect(() => boundedCanonicalJson(wide, {
      maximumBytes: 1_024,
      maximumDepth: 16,
      maximumValues: 10,
      name: "bounded wide fixture",
    })).toThrow("values")
    expect(enumeratedWideArray).toBe(false)
  })

  test("keeps the released generic domain broad while callers choose structural bounds", () => {
    const flat = Array.from({ length: 64 }, (_, index) => index)
    let deep: unknown = "leaf"
    for (let depth = 0; depth < 32; depth += 1) deep = { deep }

    expect(canonicalJson(flat)).toStartWith("[0,1,2")
    expect(canonicalJson(deep)).toContain('"leaf"')
    expect(() => boundedCanonicalJson(flat, {
      maximumBytes: 4_096,
      maximumDepth: 64,
      maximumValues: 32,
      name: "flat caller boundary",
    })).toThrow("JSON values")
    expect(() => boundedCanonicalJson(deep, {
      maximumBytes: 4_096,
      maximumDepth: 16,
      maximumValues: 128,
      name: "deep caller boundary",
    })).toThrow("nesting exceeds")
    expect(() => boundedCanonicalJson({ value: "bounded" }, {
      maximumBytes: 4,
      maximumDepth: 8,
      maximumValues: 8,
      name: "byte caller boundary",
    })).toThrow("contains more than")
  })
})
