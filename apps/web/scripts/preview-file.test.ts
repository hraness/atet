import { expect, test } from "bun:test"
import { constants } from "node:fs"
import { appendFile, chmod, link, lstat, mkdtemp, open, realpath, rename, rm, symlink, truncate, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPreviewFileReader, readPreviewFile } from "./preview-file"

async function fixture(run: (path: string, directory: string) => Promise<void>) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "slopcamera-preview-file-")))
  const path = join(directory, "fixture.bin")
  try {
    await writeFile(path, new Uint8Array([0, 127, 128, 255]))
    await run(path, directory)
  } finally { await rm(directory, { recursive: true, force: true }) }
}

type Io = Parameters<typeof createPreviewFileReader>[0]
type Descriptor = Awaited<ReturnType<Io["open"]>>

function wrap(handle: Awaited<ReturnType<typeof open>>, overrides: Partial<Descriptor> = {}): Descriptor {
  return {
    stat: () => handle.stat(),
    read: (buffer, offset, length, position) => handle.read(buffer, offset, length, position),
    close: () => handle.close(),
    ...overrides,
  }
}

test("reads exact ordinary bytes, empty files and stable hardlinked installed inputs", async () => {
  await fixture(async (path, directory) => {
    expect(await readPreviewFile(path, 4)).toEqual(new Uint8Array([0, 127, 128, 255]))
    const alias = join(directory, "installed-alias.bin")
    await link(path, alias)
    expect(await readPreviewFile(alias, 4)).toEqual(new Uint8Array([0, 127, 128, 255]))
    await writeFile(path, "")
    expect(await readPreviewFile(path, 0)).toEqual(new Uint8Array())
  })
})

test("rejects symlinks, directories, oversized inputs and invalid caps before opening", async () => {
  await fixture(async (path, directory) => {
    const linked = join(directory, "symlink.bin")
    await symlink(path, linked)
    let opens = 0
    const read = createPreviewFileReader({ realpath, lstat, open: async () => {
      opens += 1
      throw new Error("unexpected open")
    } })
    await expect(read(linked)).rejects.toThrow("physical path")
    await expect(read(directory)).rejects.toThrow("bounded ordinary file")
    await expect(read(path, 3)).rejects.toThrow("bounded ordinary file")
    for (const cap of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 16 * 1024 * 1024 + 1]) {
      await expect(read(path, cap)).rejects.toThrow("bounded nonnegative integer")
    }
    expect(opens).toBe(0)
  })
})

test("opens nonblocking and no-follow, then rejects a raced special-file descriptor without reading", async () => {
  await fixture(async (path, directory) => {
    let closed = 0
    let reads = 0
    const read = createPreviewFileReader({ realpath, lstat, open: async (_path, flags) => {
      // Deterministic special-file replacement model: this is not a native FIFO
      // timing claim. A missing flag fails before any potentially blocking I/O.
      expect(flags).toBe(constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      return {
        stat: () => lstat(directory),
        read: async () => { reads += 1; return { bytesRead: 0 } },
        close: async () => { closed += 1 },
      }
    } })
    await expect(read(path)).rejects.toThrow("descriptor is not an ordinary file")
    expect(reads).toBe(0)
    expect(closed).toBe(1)
  })
})

test("rejects a real symlink swap between lstat and native open", async () => {
  await fixture(async path => {
    const read = createPreviewFileReader({ realpath, lstat, open: async (target, flags) => {
      await rename(target, `${target}.original`)
      await symlink(`${target}.original`, target)
      return open(target, flags)
    } })
    await expect(read(path)).rejects.toThrow()
  })
})

test("rejects a real inode swap before reading and closes the acquired descriptor", async () => {
  await fixture(async path => {
    let closed = 0
    const read = createPreviewFileReader({ realpath, lstat, open: async (target, flags) => {
      await rename(target, `${target}.original`)
      await writeFile(target, new Uint8Array([0, 127, 128, 255]))
      const handle = await open(target, flags)
      return wrap(handle, { close: async () => { closed += 1; await handle.close() } })
    } })
    await expect(read(path)).rejects.toThrow("changed before reading")
    expect(closed).toBe(1)
  })
})

test("handles partial descriptor reads with one fixed admitted-size-plus-sentinel buffer", async () => {
  await fixture(async path => {
    const buffers = new Set<Uint8Array>()
    const positions: number[] = []
    const read = createPreviewFileReader({ realpath, lstat, open: async (target, flags) => {
      const handle = await open(target, flags)
      return wrap(handle, { read: async (buffer, offset, length, position) => {
        buffers.add(buffer)
        positions.push(position)
        expect(buffer.byteLength).toBe(5)
        return handle.read(buffer, offset, Math.min(length, 1), position)
      } })
    } })
    expect(await read(path, 4)).toEqual(new Uint8Array([0, 127, 128, 255]))
    expect(buffers.size).toBe(1)
    expect(positions).toEqual([0, 1, 2, 3, 4])
  })
})

test("rejects growth without reading or allocating beyond the original size plus one byte", async () => {
  await fixture(async path => {
    let calls = 0
    let closed = 0
    const read = createPreviewFileReader({ realpath, lstat, open: async (target, flags) => {
      const handle = await open(target, flags)
      return wrap(handle, {
        read: async (buffer, offset, length, position) => {
          calls += 1
          await appendFile(target, new Uint8Array(4096))
          expect(buffer.byteLength).toBe(5)
          expect(length).toBe(5)
          return handle.read(buffer, offset, length, position)
        },
        close: async () => { closed += 1; await handle.close() },
      })
    } })
    await expect(read(path, 4)).rejects.toThrow("length changed while reading")
    expect(calls).toBe(1)
    expect(closed).toBe(1)
  })
})

test("rejects truncation after admission", async () => {
  await fixture(async path => {
    const read = createPreviewFileReader({ realpath, lstat, open: async (target, flags) => {
      const handle = await open(target, flags)
      return wrap(handle, { read: async (buffer, offset, length, position) => {
        await truncate(target, 0)
        return handle.read(buffer, offset, length, position)
      } })
    } })
    await expect(read(path)).rejects.toThrow("length changed while reading")
  })
})

test("rejects same-length metadata changes and path replacement during reading", async () => {
  for (const mutation of ["mode", "path", "links"] as const) {
    await fixture(async path => {
      let changed = false
      const read = createPreviewFileReader({ realpath, lstat, open: async (target, flags) => {
        const handle = await open(target, flags)
        return wrap(handle, { read: async (buffer, offset, length, position) => {
          if (!changed) {
            changed = true
            if (mutation === "mode") await chmod(target, 0o400)
            if (mutation === "links") await link(target, `${target}.alias`)
            if (mutation === "path") {
              await rename(target, `${target}.original`)
              await writeFile(target, new Uint8Array([0, 127, 128, 255]))
            }
          }
          return handle.read(buffer, offset, length, position)
        } })
      } })
      await expect(read(path)).rejects.toThrow("changed while reading")
    })
  }
})

test("rechecks the physical path and closes on read errors or invalid descriptor results", async () => {
  for (const failure of ["physical", "read", "invalid"] as const) {
    await fixture(async path => {
      let resolutions = 0
      let closed = 0
      const read = createPreviewFileReader({
        lstat,
        realpath: async target => {
          resolutions += 1
          return failure === "physical" && resolutions === 2 ? `${target}.alias` : realpath(target)
        },
        open: async (target, flags) => {
          const handle = await open(target, flags)
          return wrap(handle, {
            read: async (buffer, offset, length, position) => {
              if (failure === "read") throw new Error("fixture read failure")
              if (failure === "invalid") return { bytesRead: -1 }
              return handle.read(buffer, offset, length, position)
            },
            close: async () => { closed += 1; await handle.close() },
          })
        },
      })
      await expect(read(path)).rejects.toThrow()
      expect(closed).toBe(1)
    })
  }
})
