import { expect, test } from "bun:test"
import { deflateRawSync, gzipSync } from "node:zlib"
import { extractVTracerArchive } from "./archive.ts"
import { vtracerReleases } from "./tool.ts"

test("the pinned release matrix covers supported desktop and server targets", () => {
  expect(Object.keys(vtracerReleases).sort()).toEqual([
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
    "win32-x64",
  ])
  expect(Object.isFrozen(vtracerReleases)).toBe(true)
  for (const release of Object.values(vtracerReleases)) {
    expect(Object.isFrozen(release)).toBe(true)
    expect(release.archiveSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(release.binarySha256).toMatch(/^[a-f0-9]{64}$/)
    expect(release.url).toStartWith(
      "https://github.com/visioncortex/vtracer/releases/download/0.6.4/",
    )
  }
  const originalUrl = vtracerReleases["darwin-arm64"].url
  const mutableRelease = vtracerReleases["darwin-arm64"] as { url: string }
  expect(() => {
    mutableRelease.url = "https://example.invalid"
  }).toThrow()
  expect(vtracerReleases["darwin-arm64"].url).toBe(originalUrl)
})

test("extracts the expected binary from bounded tar.gz and zip archives", () => {
  const binary = Uint8Array.from([0, 1, 2, 3, 254, 255])
  expect(extractVTracerArchive(gzipSync(tarArchive("vtracer", binary)), "tar.gz")).toEqual(
    binary,
  )
  expect(extractVTracerArchive(zipArchive("vtracer.exe", binary), "zip")).toEqual(binary)
})

function tarArchive(name: string, contents: Uint8Array): Uint8Array {
  const header = Buffer.alloc(512)
  header.write(name, 0, "ascii")
  header.write("0000777\0", 100, "ascii")
  header.write("0000000\0", 108, "ascii")
  header.write("0000000\0", 116, "ascii")
  header.write(`${contents.length.toString(8).padStart(11, "0")}\0`, 124, "ascii")
  header.write("00000000000\0", 136, "ascii")
  header.fill(0x20, 148, 156)
  header[156] = "0".charCodeAt(0)
  header.write("ustar\0", 257, "ascii")
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0)
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "ascii")
  const padding = Buffer.alloc(Math.ceil(contents.length / 512) * 512 - contents.length)
  return Uint8Array.from(
    Buffer.concat([header, Buffer.from(contents), padding, Buffer.alloc(1_024)]),
  )
}

function zipArchive(name: string, contents: Uint8Array): Uint8Array {
  const compressed = deflateRawSync(contents)
  const nameBytes = Buffer.from(name)
  const header = Buffer.alloc(30)
  header.writeUInt32LE(0x04034b50, 0)
  header.writeUInt16LE(20, 4)
  header.writeUInt16LE(0, 6)
  header.writeUInt16LE(8, 8)
  header.writeUInt32LE(compressed.length, 18)
  header.writeUInt32LE(contents.length, 22)
  header.writeUInt16LE(nameBytes.length, 26)
  return Uint8Array.from(Buffer.concat([header, nameBytes, compressed]))
}
