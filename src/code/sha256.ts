import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"

const UTF8_ENCODER = new TextEncoder()

export interface Sha256HexHasher {
  readonly digestHex: () => string
  readonly update: (input: string | Uint8Array) => void
}

/** Native on Bun, with the same synchronous audited fallback for browsers. */
export function createSha256HexHasher(): Sha256HexHasher {
  if (typeof Bun !== "undefined") {
    const hasher = new Bun.CryptoHasher("sha256")
    return {
      digestHex: () => hasher.digest("hex"),
      update: (input) => {
        hasher.update(input)
      },
    }
  }
  const hasher = sha256.create()
  return {
    digestHex: () => bytesToHex(hasher.digest()),
    update: (input) => {
      hasher.update(typeof input === "string" ? UTF8_ENCODER.encode(input) : input)
    },
  }
}

/** Synchronous SHA-256 over exact UTF-8 bytes in Bun, Node, and browsers. */
export function sha256Hex(input: string): string {
  const hasher = createSha256HexHasher()
  hasher.update(input)
  return hasher.digestHex()
}
