import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import {
  chmod,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { extractVTracerArchive } from "./archive.ts"
import { runBoundedCommand } from "./command.ts"
import { type VectorizeDeadline } from "./limits.ts"
import { sha256 } from "./metrics.ts"
import { VectorizeError } from "./types.ts"

export const VTRACER_VERSION = "0.6.4"

interface VTracerRelease {
  readonly archiveSha256: string
  readonly binarySha256: string
  readonly format: "tar.gz" | "zip"
  readonly url: string
}

const frozenRelease = (release: VTracerRelease): Readonly<VTracerRelease> =>
  Object.freeze(release)

/**
 * Hashes were independently recomputed from the five official GitHub release
 * assets and their extracted binaries on 2026-07-25.
 */
export const vtracerReleases = Object.freeze({
  "darwin-arm64": frozenRelease({
    archiveSha256: "4a597fd2df8b961d60620df40a7436109427d86e5c028758e6e8796b02d3d996",
    binarySha256: "77e495bbe212448240387fba3b6d8bc62ba20ecfb6f3c22967e51600f1cc6e66",
    format: "tar.gz",
    url: `https://github.com/visioncortex/vtracer/releases/download/${VTRACER_VERSION}/vtracer-aarch64-apple-darwin.tar.gz`,
  }),
  "darwin-x64": frozenRelease({
    archiveSha256: "f0d755292c2602d772d63d658a3498b23eca8b5620d4b92a991bd035d5abed16",
    binarySha256: "0f9f88f989b757e27973a5c4b42665153070183d0787656ee8af2249ab326b78",
    format: "tar.gz",
    url: `https://github.com/visioncortex/vtracer/releases/download/${VTRACER_VERSION}/vtracer-x86_64-apple-darwin.tar.gz`,
  }),
  "linux-arm64": frozenRelease({
    archiveSha256: "cbd05ad4f491d12dd139ada61485ca1d24db9f981cbe1658632a083cd0ac1a71",
    binarySha256: "a4b33b6c4066a6b9187802c6efc8b89e211318e12a17164b9d1dd1f29ac5e502",
    format: "tar.gz",
    url: `https://github.com/visioncortex/vtracer/releases/download/${VTRACER_VERSION}/vtracer-aarch64-unknown-linux-musl.tar.gz`,
  }),
  "linux-x64": frozenRelease({
    archiveSha256: "9290ba0c90e224d6d212836dff5491407c1718bcb72f80b2b5a4a01816df5e40",
    binarySha256: "6f31499257076bd94de3e976844cf7ca5643f1e194a2bf0599b13f3719452aec",
    format: "tar.gz",
    url: `https://github.com/visioncortex/vtracer/releases/download/${VTRACER_VERSION}/vtracer-x86_64-unknown-linux-musl.tar.gz`,
  }),
  "win32-x64": frozenRelease({
    archiveSha256: "6b5bc17a6b017129ee40461df254f65d16f3b494c001a8541d41861066b716bf",
    binarySha256: "4ad8d35e566cd15caf582063b8349bd082b8fa2bd461e99d116fc63ad8fdeca0",
    format: "zip",
    url: `https://github.com/visioncortex/vtracer/releases/download/${VTRACER_VERSION}/vtracer-x86_64-pc-windows-msvc.zip`,
  }),
}) satisfies Readonly<Record<string, Readonly<VTracerRelease>>>

export interface VTracerTool {
  /**
   * A conversion-private executable copied through one verified source handle.
   * Callers must remove its containing conversion directory when finished.
   */
  readonly path: string
  readonly sha256: string
  readonly source: "official-release" | "override"
  readonly version: string
}

const MAX_ARCHIVE_BYTES = 4 * 1_024 * 1_024
const MAX_TOOL_BYTES = 16 * 1_024 * 1_024
const FILE_CHUNK_BYTES = 64 * 1_024

export async function ensureVTracer(
  deadline: VectorizeDeadline,
  privateDirectory: string,
  cacheDirectory?: string,
): Promise<VTracerTool> {
  const override = process.env.GRAPHICS_VTRACER_PATH
  if (override !== undefined) {
    return copyAndInspectVTracer(
      resolve(override),
      resolve(privateDirectory),
      "override",
      deadline,
    )
  }

  const key = `${process.platform}-${process.arch}`
  const release = vtracerReleases[key as keyof typeof vtracerReleases]
  if (release === undefined) {
    throw new VectorizeError(
      "tool_platform",
      `VTracer is not pinned for ${process.platform}/${process.arch}.`,
      { arch: process.arch, platform: process.platform },
    )
  }

  const cacheRoot = resolve(cacheDirectory ?? defaultCacheDirectory())
  const suffix = process.platform === "win32" ? ".exe" : ""
  const toolPath = join(
    cacheRoot,
    "tools",
    `vtracer-${VTRACER_VERSION}-${process.platform}-${process.arch}${suffix}`,
  )
  const cachedHash = await hashCachedTool(toolPath, deadline)
  if (cachedHash !== release.binarySha256) {
    await removeInvalidCachedTool(toolPath)
    await installOfficialVTracer(toolPath, release, deadline)
  }

  return copyAndInspectVTracer(
    toolPath,
    resolve(privateDirectory),
    "official-release",
    deadline,
    release.binarySha256,
  )
}

function defaultCacheDirectory(): string {
  const explicit = process.env.GRAPHICS_CACHE_DIR
  if (explicit !== undefined && explicit.trim() !== "") return explicit
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? homedir(), "graphics")
  }
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "graphics")
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "graphics")
}

async function installOfficialVTracer(
  toolPath: string,
  release: Readonly<VTracerRelease>,
  deadline: VectorizeDeadline,
): Promise<void> {
  deadline.assert("VTracer download")
  const archive = await downloadBounded(release.url, deadline, MAX_ARCHIVE_BYTES)
  const archiveSha256 = sha256(archive)
  if (archiveSha256 !== release.archiveSha256) {
    throw new VectorizeError(
      "tool_integrity",
      `VTracer archive checksum mismatch: ${archiveSha256}`,
      { actual: archiveSha256, expected: release.archiveSha256 },
    )
  }
  const binary = extractVTracerArchive(archive, release.format)
  if (binary.byteLength < 1 || binary.byteLength > MAX_TOOL_BYTES) {
    throw new VectorizeError(
      "tool_integrity",
      "VTracer binary exceeds its verified installation limit.",
      { bytes: binary.byteLength, maximumBytes: MAX_TOOL_BYTES },
    )
  }
  const binarySha256 = sha256(binary)
  if (binarySha256 !== release.binarySha256) {
    throw new VectorizeError(
      "tool_integrity",
      `VTracer binary checksum mismatch: ${binarySha256}`,
      { actual: binarySha256, expected: release.binarySha256 },
    )
  }

  deadline.assert("VTracer installation")
  await mkdir(dirname(toolPath), { recursive: true })
  const stagedPath = `${toolPath}.${randomUUID()}.tmp`
  try {
    await writeFile(stagedPath, binary, { flag: "wx", mode: 0o700 })
    if (process.platform !== "win32") await chmod(stagedPath, 0o500)
    deadline.assert("VTracer installation")
    try {
      await rename(stagedPath, toolPath)
    } catch (error) {
      const concurrentHash = await hashCachedTool(toolPath, deadline)
      if (concurrentHash === release.binarySha256) {
        await rm(stagedPath, { force: true })
      } else {
        throw error
      }
    }
  } catch (error) {
    await rm(stagedPath, { force: true })
    if (error instanceof VectorizeError) throw error
    throw new VectorizeError(
      "tool_integrity",
      "Could not publish the verified VTracer binary.",
      {},
      { cause: error },
    )
  }

  const installedHash = await hashCachedTool(toolPath, deadline)
  if (installedHash !== release.binarySha256) {
    throw new VectorizeError(
      "tool_integrity",
      "Installed VTracer differs from the verified release binary.",
      { actual: installedHash, expected: release.binarySha256 },
    )
  }
}

async function copyAndInspectVTracer(
  sourcePath: string,
  privateDirectory: string,
  source: VTracerTool["source"],
  deadline: VectorizeDeadline,
  expectedSha256?: string,
): Promise<VTracerTool> {
  deadline.assert("VTracer private copy")
  await mkdir(privateDirectory, { mode: 0o700, recursive: true })
  const suffix = process.platform === "win32" ? ".exe" : ""
  const privatePath = join(privateDirectory, `vtracer-${randomUUID()}${suffix}`)
  const failureCode = source === "official-release" ? "tool_integrity" : "tool_version"
  let sourceHandle: FileHandle | undefined
  let targetHandle: FileHandle | undefined
  let copiedSha256: string
  try {
    const resolvedSourcePath = await realpath(sourcePath)
    deadline.assert("VTracer private copy")
    sourceHandle = await open(resolvedSourcePath, boundedReadFlags())
    const metadata = await sourceHandle.stat()
    assertBoundedRegularTool(metadata, sourcePath)
    targetHandle = await open(privatePath, "wx", 0o500)
    copiedSha256 = await copyAndHash(
      sourceHandle,
      targetHandle,
      MAX_TOOL_BYTES,
      deadline,
    )
    await targetHandle.sync()
    deadline.assert("VTracer private copy")
  } catch (error) {
    if (error instanceof VectorizeError) throw error
    throw new VectorizeError(
      failureCode,
      "VTracer could not be copied into the private conversion directory.",
      {},
      { cause: error },
    )
  } finally {
    await Promise.allSettled([sourceHandle?.close(), targetHandle?.close()])
  }

  try {
    if (copiedSha256.length === 0) {
      throw new VectorizeError(failureCode, "VTracer executable is empty.")
    }
    if (expectedSha256 !== undefined && copiedSha256 !== expectedSha256) {
      throw new VectorizeError(
        "tool_integrity",
        "VTracer changed before it could be copied for conversion.",
        { actual: copiedSha256, expected: expectedSha256 },
      )
    }
    if (process.platform !== "win32") await chmod(privatePath, 0o500)
    const privateSha256 = await hashRegularFile(
      privatePath,
      MAX_TOOL_BYTES,
      deadline,
      failureCode,
    )
    if (privateSha256 !== copiedSha256) {
      throw new VectorizeError(
        "tool_integrity",
        "The private VTracer copy failed its integrity check.",
        { actual: privateSha256, expected: copiedSha256 },
      )
    }
    return inspectVTracer(
      privatePath,
      source,
      deadline,
      copiedSha256,
      expectedSha256,
    )
  } catch (error) {
    await rm(privatePath, { force: true })
    throw error
  }
}

async function inspectVTracer(
  path: string,
  source: VTracerTool["source"],
  deadline: VectorizeDeadline,
  copiedSha256: string,
  expectedSha256?: string,
): Promise<VTracerTool> {
  deadline.assert("VTracer inspection")
  const { stderr, stdout } = await runBoundedCommand(
    [path, "--version"],
    deadline.remainingMs(),
    "tool_version",
  )
  if (!new RegExp(`\\b${VTRACER_VERSION.replaceAll(".", "\\.")}\\b`, "u").test(`${stdout}\n${stderr}`)) {
    throw new VectorizeError(
      "tool_version",
      `Expected VTracer ${VTRACER_VERSION}.`,
    )
  }
  const afterInspectionSha256 = await hashRegularFile(
    path,
    MAX_TOOL_BYTES,
    deadline,
    "tool_integrity",
  )
  if (
    afterInspectionSha256 !== copiedSha256 ||
    (expectedSha256 !== undefined && afterInspectionSha256 !== expectedSha256)
  ) {
    throw new VectorizeError(
      "tool_integrity",
      "The private VTracer executable changed during inspection.",
      {
        actual: afterInspectionSha256,
        expected: expectedSha256 ?? copiedSha256,
      },
    )
  }
  return {
    path,
    sha256: afterInspectionSha256,
    source,
    version: VTRACER_VERSION,
  }
}

async function hashCachedTool(
  path: string,
  deadline: VectorizeDeadline,
): Promise<string | undefined> {
  try {
    return await hashRegularFile(
      path,
      MAX_TOOL_BYTES,
      deadline,
      "tool_integrity",
    )
  } catch (error) {
    if (error instanceof VectorizeError && error.code === "timeout") throw error
    if (isFileSystemError(error, "ENOENT")) return undefined
    return undefined
  }
}

async function removeInvalidCachedTool(path: string): Promise<void> {
  try {
    await rm(path, { force: true })
  } catch (error) {
    throw new VectorizeError(
      "tool_integrity",
      "Could not remove an invalid cached VTracer binary.",
      {},
      { cause: error },
    )
  }
}

async function hashRegularFile(
  path: string,
  maximumBytes: number,
  deadline: VectorizeDeadline,
  failureCode: "tool_integrity" | "tool_version",
): Promise<string> {
  let handle: FileHandle | undefined
  try {
    deadline.assert("VTracer hash")
    const resolvedPath = await realpath(path)
    deadline.assert("VTracer hash")
    handle = await open(resolvedPath, boundedReadFlags())
    const metadata = await handle.stat()
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximumBytes) {
      throw new VectorizeError(
        failureCode,
        "VTracer must be a non-empty regular file within its size limit.",
        { bytes: metadata.size, maximumBytes },
      )
    }
    const hash = createHash("sha256")
    const buffer = Buffer.allocUnsafe(Math.min(FILE_CHUNK_BYTES, maximumBytes + 1))
    let bytes = 0
    while (true) {
      deadline.assert("VTracer hash")
      const maximumRead = Math.min(buffer.byteLength, maximumBytes - bytes + 1)
      const { bytesRead } = await handle.read(buffer, 0, maximumRead, null)
      if (bytesRead === 0) break
      bytes += bytesRead
      if (bytes > maximumBytes) {
        throw new VectorizeError(
          failureCode,
          "VTracer grew beyond its executable size limit while being hashed.",
          { bytes, maximumBytes },
        )
      }
      hash.update(buffer.subarray(0, bytesRead))
    }
    deadline.assert("VTracer hash")
    return hash.digest("hex")
  } catch (error) {
    if (error instanceof VectorizeError) throw error
    throw new VectorizeError(
      failureCode,
      "VTracer executable could not be read safely.",
      {},
      { cause: error },
    )
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function copyAndHash(
  source: FileHandle,
  target: FileHandle,
  maximumBytes: number,
  deadline: VectorizeDeadline,
): Promise<string> {
  const hash = createHash("sha256")
  const buffer = Buffer.allocUnsafe(Math.min(FILE_CHUNK_BYTES, maximumBytes + 1))
  let bytes = 0
  while (true) {
    deadline.assert("VTracer private copy")
    const maximumRead = Math.min(buffer.byteLength, maximumBytes - bytes + 1)
    const { bytesRead } = await source.read(buffer, 0, maximumRead, null)
    if (bytesRead === 0) break
    bytes += bytesRead
    if (bytes > maximumBytes) {
      throw new VectorizeError(
        "tool_integrity",
        "VTracer grew beyond its executable size limit while being copied.",
        { bytes, maximumBytes },
      )
    }
    hash.update(buffer.subarray(0, bytesRead))
    let written = 0
    while (written < bytesRead) {
      const result = await target.write(
        buffer,
        written,
        bytesRead - written,
        null,
      )
      if (result.bytesWritten < 1) {
        throw new VectorizeError(
          "tool_integrity",
          "VTracer private copy stopped before completion.",
        )
      }
      written += result.bytesWritten
    }
  }
  return bytes === 0 ? "" : hash.digest("hex")
}

function assertBoundedRegularTool(
  metadata: Awaited<ReturnType<FileHandle["stat"]>>,
  path: string,
): void {
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > MAX_TOOL_BYTES) {
    throw new VectorizeError(
      "tool_version",
      `VTracer must be a non-empty regular file: ${path}`,
      { bytes: metadata.size, maximumBytes: MAX_TOOL_BYTES },
    )
  }
}

async function downloadBounded(
  url: string,
  deadline: VectorizeDeadline,
  maximumBytes: number,
): Promise<Uint8Array> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deadline.remainingMs())
  try {
    const response = await fetch(url, {
      headers: { "user-agent": "hraness-graphics-vectorizer" },
      redirect: "follow",
      signal: controller.signal,
    })
    if (!response.ok || response.body === null) {
      throw new VectorizeError(
        "tool_download",
        `Could not download VTracer: ${response.status} ${response.statusText}`,
      )
    }
    const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10)
    if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
      throw new VectorizeError("tool_download", "VTracer archive exceeds its download limit.")
    }
    const chunks: Uint8Array[] = []
    const reader = response.body.getReader()
    let bytes = 0
    while (true) {
      deadline.assert("VTracer download")
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maximumBytes) {
        await reader.cancel()
        throw new VectorizeError("tool_download", "VTracer archive exceeds its download limit.")
      }
      chunks.push(value)
    }
    return Uint8Array.from(Buffer.concat(chunks, bytes))
  } catch (error) {
    if (error instanceof VectorizeError) throw error
    if (controller.signal.aborted) {
      throw new VectorizeError("timeout", "VTracer download exceeded the conversion time limit.")
    }
    throw new VectorizeError("tool_download", "Could not download VTracer.", {}, { cause: error })
  } finally {
    clearTimeout(timer)
  }
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  )
}

function boundedReadFlags(): number {
  if (process.platform === "win32") return constants.O_RDONLY
  return constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
}
