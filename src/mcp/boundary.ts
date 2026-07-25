import { open, mkdir, realpath, stat } from "node:fs/promises"
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  win32,
} from "node:path"

export const mcpSourceByteLimit = 1024 * 1024

export class WorkspaceBoundaryError extends Error {
  readonly code:
    | "INVALID_PATH"
    | "PATH_OUTSIDE_ROOT"
    | "SOURCE_NOT_FOUND"
    | "SOURCE_NOT_FILE"
    | "SOURCE_TOO_LARGE"
    | "SOURCE_ENCODING"
    | "OUTPUT_NOT_DIRECTORY"
    | "FILESYSTEM_ERROR"

  constructor(
    code: WorkspaceBoundaryError["code"],
    message: string,
  ) {
    super(message)
    this.name = "WorkspaceBoundaryError"
    this.code = code
  }
}

interface NormalizedRelativePath {
  readonly native: string
  readonly portable: string
}

export interface WorkspaceSource {
  readonly absolutePath: string
  readonly relativePath: string
  readonly text: string
}

export interface WorkspaceDirectory {
  readonly absolutePath: string
  readonly relativePath: string
}

function filesystemCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code
  }
  return undefined
}

function normalizeRelativePath(
  value: string,
  options: { readonly allowRoot: boolean },
): NormalizedRelativePath {
  if (value.length === 0 || value.includes("\0")) {
    throw new WorkspaceBoundaryError("INVALID_PATH", "Path must be a non-empty root-relative path.")
  }
  if (
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new WorkspaceBoundaryError("INVALID_PATH", "Absolute paths are not allowed.")
  }
  const segments = value
    .split(/[\\/]/)
    .filter((segment) => segment !== "" && segment !== ".")
  if (segments.includes("..")) {
    throw new WorkspaceBoundaryError("INVALID_PATH", "Parent-directory traversal is not allowed.")
  }
  if (segments.length === 0) {
    if (!options.allowRoot) {
      throw new WorkspaceBoundaryError("INVALID_PATH", "Path must identify a file below the root.")
    }
    return { native: ".", portable: "." }
  }
  return {
    native: segments.join("/"),
    portable: segments.join("/"),
  }
}

function isConfined(rootDirectory: string, target: string): boolean {
  const fromRoot = relative(rootDirectory, target)
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))
}

async function readUtf8WithCap(filePath: string): Promise<string> {
  let handle
  try {
    handle = await open(filePath, "r")
    const metadata = await handle.stat()
    if (!metadata.isFile()) {
      throw new WorkspaceBoundaryError(
        "SOURCE_NOT_FILE",
        "Diagram source must be a regular file.",
      )
    }
    if (metadata.size > mcpSourceByteLimit) {
      throw new WorkspaceBoundaryError(
        "SOURCE_TOO_LARGE",
        `Diagram source exceeds the ${mcpSourceByteLimit}-byte limit.`,
      )
    }

    const buffer = Buffer.allocUnsafe(mcpSourceByteLimit + 1)
    let bytesRead = 0
    while (bytesRead <= mcpSourceByteLimit) {
      const next = await handle.read(
        buffer,
        bytesRead,
        mcpSourceByteLimit + 1 - bytesRead,
        null,
      )
      if (next.bytesRead === 0) break
      bytesRead += next.bytesRead
    }
    if (bytesRead > mcpSourceByteLimit) {
      throw new WorkspaceBoundaryError(
        "SOURCE_TOO_LARGE",
        `Diagram source exceeds the ${mcpSourceByteLimit}-byte limit.`,
      )
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, bytesRead),
      )
    } catch {
      throw new WorkspaceBoundaryError(
        "SOURCE_ENCODING",
        "Diagram source must contain valid UTF-8.",
      )
    }
  } catch (error) {
    if (error instanceof WorkspaceBoundaryError) throw error
    const code = filesystemCode(error)
    if (code === "ENOENT") {
      throw new WorkspaceBoundaryError("SOURCE_NOT_FOUND", "Diagram source does not exist.")
    }
    throw new WorkspaceBoundaryError("FILESYSTEM_ERROR", "Diagram source could not be read.")
  } finally {
    await handle?.close()
  }
}

export class WorkspaceBoundary {
  readonly rootDirectory: string

  private constructor(rootDirectory: string) {
    this.rootDirectory = rootDirectory
  }

  static async create(rootDirectory: string): Promise<WorkspaceBoundary> {
    let resolvedRoot: string
    try {
      resolvedRoot = await realpath(resolve(rootDirectory))
      if (!(await stat(resolvedRoot)).isDirectory()) {
        throw new WorkspaceBoundaryError(
          "OUTPUT_NOT_DIRECTORY",
          "MCP root must be a directory.",
        )
      }
    } catch (error) {
      if (error instanceof WorkspaceBoundaryError) throw error
      throw new WorkspaceBoundaryError(
        "FILESYSTEM_ERROR",
        "MCP root could not be opened.",
      )
    }
    return new WorkspaceBoundary(resolvedRoot)
  }

  private assertConfined(target: string): void {
    if (!isConfined(this.rootDirectory, target)) {
      throw new WorkspaceBoundaryError(
        "PATH_OUTSIDE_ROOT",
        "Path resolves outside the MCP root.",
      )
    }
  }

  toRelativePath(absolutePath: string): string {
    this.assertConfined(absolutePath)
    const fromRoot = relative(this.rootDirectory, absolutePath)
    return fromRoot === "" ? "." : fromRoot.split("\\").join("/")
  }

  async readSource(value: string): Promise<WorkspaceSource> {
    const normalized = normalizeRelativePath(value, { allowRoot: false })
    const lexicalPath = resolve(this.rootDirectory, normalized.native)
    this.assertConfined(lexicalPath)

    let canonicalPath: string
    try {
      canonicalPath = await realpath(lexicalPath)
    } catch (error) {
      if (filesystemCode(error) === "ENOENT") {
        throw new WorkspaceBoundaryError(
          "SOURCE_NOT_FOUND",
          "Diagram source does not exist.",
        )
      }
      throw new WorkspaceBoundaryError(
        "FILESYSTEM_ERROR",
        "Diagram source could not be resolved.",
      )
    }
    this.assertConfined(canonicalPath)
    return {
      absolutePath: canonicalPath,
      relativePath: this.toRelativePath(canonicalPath),
      text: await readUtf8WithCap(canonicalPath),
    }
  }

  async prepareOutputDirectory(value: string): Promise<WorkspaceDirectory> {
    const normalized = normalizeRelativePath(value, { allowRoot: true })
    const lexicalPath = resolve(this.rootDirectory, normalized.native)
    this.assertConfined(lexicalPath)

    // Resolve the nearest existing ancestor before mkdir so a symlink in the
    // requested path cannot redirect writes outside the server root.
    let ancestor = lexicalPath
    for (;;) {
      try {
        const canonicalAncestor = await realpath(ancestor)
        this.assertConfined(canonicalAncestor)
        break
      } catch (error) {
        if (error instanceof WorkspaceBoundaryError) throw error
        if (filesystemCode(error) !== "ENOENT") {
          throw new WorkspaceBoundaryError(
            "FILESYSTEM_ERROR",
            "Output directory could not be resolved.",
          )
        }
        const parent = dirname(ancestor)
        if (parent === ancestor) {
          throw new WorkspaceBoundaryError(
            "PATH_OUTSIDE_ROOT",
            "Output directory resolves outside the MCP root.",
          )
        }
        ancestor = parent
      }
    }

    try {
      await mkdir(lexicalPath, { recursive: true })
      const canonicalPath = await realpath(lexicalPath)
      this.assertConfined(canonicalPath)
      if (!(await stat(canonicalPath)).isDirectory()) {
        throw new WorkspaceBoundaryError(
          "OUTPUT_NOT_DIRECTORY",
          "Output path must be a directory.",
        )
      }
      return {
        absolutePath: canonicalPath,
        relativePath: this.toRelativePath(canonicalPath),
      }
    } catch (error) {
      if (error instanceof WorkspaceBoundaryError) throw error
      throw new WorkspaceBoundaryError(
        "FILESYSTEM_ERROR",
        "Output directory could not be created.",
      )
    }
  }
}
