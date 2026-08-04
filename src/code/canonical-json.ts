import { TransmuteCodeError } from "./errors.js"

type JsonScalar = boolean | null | number | string

export type CanonicalJsonValue =
  | JsonScalar
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue }

function invalidCanonicalJson(message: string): never {
  throw new TransmuteCodeError("invalid-data", message)
}

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value)
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return invalidCanonicalJson("Canonical JSON does not support non-finite numbers.")
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value)
  }
  if (typeof value !== "object") {
    return invalidCanonicalJson(
      `Canonical JSON does not support ${typeof value} values.`,
    )
  }
  if (ancestors.has(value)) {
    return invalidCanonicalJson("Canonical JSON does not support cycles.")
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalize(item, ancestors)).join(",")}]`
    }
    const prototype: unknown = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      return invalidCanonicalJson(
        "Canonical JSON accepts only arrays and plain objects.",
      )
    }
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => {
      const item = record[key]
      if (item === undefined) {
        return invalidCanonicalJson(
          `Canonical JSON property ${key} is undefined.`,
        )
      }
      return `${JSON.stringify(key)}:${canonicalize(item, ancestors)}`
    }).join(",")}}`
  } finally {
    ancestors.delete(value)
  }
}

export function canonicalJson(value: unknown): string {
  return canonicalize(value, new Set())
}

const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const

const SHA256_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const

function rotateRight(value: number, shift: number): number {
  return (value >>> shift) | (value << (32 - shift))
}

/** A dependency-free SHA-256 implementation with UTF-8 string input. */
export function sha256Hex(input: string): string {
  const source = new TextEncoder().encode(input)
  const bitLength = source.length * 8
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64
  const bytes = new Uint8Array(paddedLength)
  bytes.set(source)
  bytes[source.length] = 0x80
  const view = new DataView(bytes.buffer)
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false)
  view.setUint32(paddedLength - 4, bitLength >>> 0, false)

  const state: number[] = [...SHA256_INITIAL]
  const words = new Uint32Array(64)
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false)
    }
    for (let index = 16; index < 64; index += 1) {
      const word15 = words[index - 15] ?? 0
      const word2 = words[index - 2] ?? 0
      const sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3)
      const sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10)
      words[index] = (
        (words[index - 16] ?? 0)
        + sigma0
        + (words[index - 7] ?? 0)
        + sigma1
      ) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = state
    for (let index = 0; index < 64; index += 1) {
      const eValue = e ?? 0
      const aValue = a ?? 0
      const sum1 = rotateRight(eValue, 6) ^ rotateRight(eValue, 11) ^ rotateRight(eValue, 25)
      const choice = (eValue & (f ?? 0)) ^ (~eValue & (g ?? 0))
      const temporary1 = (
        (h ?? 0)
        + sum1
        + choice
        + (SHA256_CONSTANTS[index] ?? 0)
        + (words[index] ?? 0)
      ) >>> 0
      const sum0 = rotateRight(aValue, 2) ^ rotateRight(aValue, 13) ^ rotateRight(aValue, 22)
      const majority = (aValue & (b ?? 0))
        ^ (aValue & (c ?? 0))
        ^ ((b ?? 0) & (c ?? 0))
      const temporary2 = (sum0 + majority) >>> 0
      h = g
      g = f
      f = e
      e = ((d ?? 0) + temporary1) >>> 0
      d = c
      c = b
      b = a
      a = (temporary1 + temporary2) >>> 0
    }
    state[0] = ((state[0] ?? 0) + (a ?? 0)) >>> 0
    state[1] = ((state[1] ?? 0) + (b ?? 0)) >>> 0
    state[2] = ((state[2] ?? 0) + (c ?? 0)) >>> 0
    state[3] = ((state[3] ?? 0) + (d ?? 0)) >>> 0
    state[4] = ((state[4] ?? 0) + (e ?? 0)) >>> 0
    state[5] = ((state[5] ?? 0) + (f ?? 0)) >>> 0
    state[6] = ((state[6] ?? 0) + (g ?? 0)) >>> 0
    state[7] = ((state[7] ?? 0) + (h ?? 0)) >>> 0
  }
  return state.map((word) => word.toString(16).padStart(8, "0")).join("")
}

export function canonicalJsonSha256(value: unknown): string {
  return sha256Hex(canonicalJson(value))
}
