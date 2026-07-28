import { gunzipSync, inflateRawSync } from "node:zlib"
import { VectorizeError } from "./types.js"

const MAX_BINARY_BYTES = 8 * 1_024 * 1_024

export function extractVTracerArchive(
  archive: Uint8Array,
  format: "tar.gz" | "zip",
): Uint8Array {
  return format === "tar.gz"
    ? extractTarEntry(
        gunzipSync(archive, { maxOutputLength: MAX_BINARY_BYTES }),
        "vtracer",
      )
    : extractZipEntry(archive, "vtracer.exe")
}

function extractTarEntry(tar: Uint8Array, expectedName: string): Uint8Array {
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = readNullTerminatedAscii(header.subarray(0, 100))
    const prefix = readNullTerminatedAscii(header.subarray(345, 500))
    const fullName = prefix === "" ? name : `${prefix}/${name}`
    const sizeText = readNullTerminatedAscii(header.subarray(124, 136)).trim()
    if (!/^[0-7]+$/u.test(sizeText)) {
      throw new VectorizeError("tool_integrity", "VTracer tar contains an invalid size.")
    }
    const size = Number.parseInt(sizeText, 8)
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_BINARY_BYTES) {
      throw new VectorizeError("tool_integrity", "VTracer tar entry exceeds its size limit.")
    }
    const contentStart = offset + 512
    const contentEnd = contentStart + size
    if (contentEnd > tar.length) {
      throw new VectorizeError("tool_integrity", "VTracer tar entry is truncated.")
    }
    if (fullName === expectedName || fullName.endsWith(`/${expectedName}`)) {
      return Uint8Array.from(tar.subarray(contentStart, contentEnd))
    }
    offset = contentStart + Math.ceil(size / 512) * 512
  }
  throw new VectorizeError("tool_integrity", `VTracer archive omitted ${expectedName}.`)
}

function extractZipEntry(zip: Uint8Array, expectedName: string): Uint8Array {
  const bytes = Buffer.from(zip)
  let offset = 0
  while (offset + 30 <= bytes.length) {
    const signature = bytes.readUInt32LE(offset)
    if (signature !== 0x04034b50) break
    const flags = bytes.readUInt16LE(offset + 6)
    const compression = bytes.readUInt16LE(offset + 8)
    const compressedSize = bytes.readUInt32LE(offset + 18)
    const uncompressedSize = bytes.readUInt32LE(offset + 22)
    const nameLength = bytes.readUInt16LE(offset + 26)
    const extraLength = bytes.readUInt16LE(offset + 28)
    if ((flags & 0x1) !== 0 || (flags & 0x8) !== 0) {
      throw new VectorizeError(
        "tool_integrity",
        "VTracer zip uses encryption or an unsupported data descriptor.",
      )
    }
    if (uncompressedSize > MAX_BINARY_BYTES) {
      throw new VectorizeError("tool_integrity", "VTracer zip entry exceeds its size limit.")
    }
    const nameStart = offset + 30
    const dataStart = nameStart + nameLength + extraLength
    const dataEnd = dataStart + compressedSize
    if (dataEnd > bytes.length) {
      throw new VectorizeError("tool_integrity", "VTracer zip entry is truncated.")
    }
    const name = bytes.subarray(nameStart, nameStart + nameLength).toString("utf8")
    if (name === expectedName || name.endsWith(`/${expectedName}`)) {
      const compressed = bytes.subarray(dataStart, dataEnd)
      const extracted =
        compression === 0
          ? Buffer.from(compressed)
          : compression === 8
            ? inflateRawSync(compressed, { maxOutputLength: MAX_BINARY_BYTES })
            : undefined
      if (extracted === undefined) {
        throw new VectorizeError(
          "tool_integrity",
          `VTracer zip uses unsupported compression method ${compression}.`,
        )
      }
      if (extracted.length !== uncompressedSize) {
        throw new VectorizeError("tool_integrity", "VTracer zip size does not match its header.")
      }
      return Uint8Array.from(extracted)
    }
    offset = dataEnd
  }
  throw new VectorizeError("tool_integrity", `VTracer archive omitted ${expectedName}.`)
}

function readNullTerminatedAscii(bytes: Uint8Array): string {
  const end = bytes.indexOf(0)
  return Buffer.from(end === -1 ? bytes : bytes.subarray(0, end)).toString("ascii")
}
