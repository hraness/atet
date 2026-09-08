import assert from "node:assert/strict"
import { constants, type Stats } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"

type PreviewFileDescriptor = {
  stat(): Promise<Stats>
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>
  close(): Promise<void>
}

type PreviewFileIo = {
  realpath(path: string): Promise<string>
  lstat(path: string): Promise<Stats>
  open(path: string, flags: number): Promise<PreviewFileDescriptor>
}

const maximumPreviewBytes = 16 * 1024 * 1024

function identity(stat: Stats) {
  return [stat.dev, stat.ino, stat.size, stat.mode, stat.nlink, stat.mtimeMs, stat.ctimeMs]
}

// The production reader below is permanently bound to native filesystem calls.
// This internal factory permits deterministic descriptor-race tests without
// patching global filesystem functions or launching a special-file process.
export function createPreviewFileReader(io: PreviewFileIo) {
  return async function readPreviewFile(path: string, maximum = maximumPreviewBytes): Promise<Uint8Array> {
    assert.ok(Number.isSafeInteger(maximum) && maximum >= 0 && maximum <= maximumPreviewBytes,
      "Preview file limit must be a bounded nonnegative integer")
    assert.equal(await io.realpath(path), path, "Preview input/output must have a physical path")
    const before = await io.lstat(path)
    assert.ok(before.isFile() && Number.isSafeInteger(before.size) && before.size >= 0 && before.size <= maximum,
      "Preview artifact is not a bounded ordinary file")
    const handle = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const opened = await handle.stat()
      assert.ok(opened.isFile(), "Preview descriptor is not an ordinary file")
      assert.deepEqual(identity(opened), identity(before), "Preview file changed before reading")

      // One fixed allocation, including a sentinel, bounds both a growing file
      // and partial reads. Never allocate from a later, potentially larger stat.
      const bytes = new Uint8Array(before.size + 1)
      let count = 0
      while (count < bytes.byteLength) {
        const remaining = bytes.byteLength - count
        const { bytesRead } = await handle.read(bytes, count, remaining, count)
        assert.ok(Number.isSafeInteger(bytesRead) && bytesRead >= 0 && bytesRead <= remaining,
          "Preview descriptor returned an invalid read length")
        if (bytesRead === 0) break
        count += bytesRead
      }
      assert.equal(count, before.size, "Preview file length changed while reading")
      const after = await handle.stat()
      assert.ok(after.isFile(), "Preview descriptor stopped being an ordinary file")
      assert.deepEqual(identity(after), identity(before), "Preview descriptor changed while reading")
      assert.deepEqual(identity(await io.lstat(path)), identity(before), "Preview path changed while reading")
      assert.equal(await io.realpath(path), path, "Preview input/output stopped having a physical path")
      return bytes.subarray(0, count)
    } finally { await handle.close() }
  }
}

export const readPreviewFile = createPreviewFileReader({ realpath, lstat, open })
