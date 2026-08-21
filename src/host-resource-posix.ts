import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import type { Pointer } from "bun:ffi"

const lockExclusive = 0x02
const lockNonblocking = 0x04
const lockUnlock = 0x08
const interruptedErrno = 4

type NativeFlock = (descriptor: number, operation: number) => number
type NativePointer = Pointer | bigint
type NativeErrnoLocation = () => NativePointer | null

interface NativeLocking {
  readonly errnoLocation: NativeErrnoLocation
  readonly flock: NativeFlock
  readonly readInt32: (pointer: NativePointer) => number
}

let nativeLocking: NativeLocking | undefined
const nativeLibraries: unknown[] = []
const runtimeRequire = createRequire(import.meta.url)

function bunFfi(): typeof import("bun:ffi") {
  return runtimeRequire("bun:ffi") as typeof import("bun:ffi")
}

function mappedLinuxLibcCandidates(
  processMaps: string,
  architecture = process.arch,
): readonly string[] {
  const candidates: string[] = []
  const append = (candidate: string): void => {
    if (!candidates.includes(candidate)) candidates.push(candidate)
  }
  for (const line of processMaps.split("\n")) {
    const pathStart = line.indexOf("/")
    if (pathStart < 0 || line.endsWith(" (deleted)")) continue
    const path = line.slice(pathStart).replace(
      /\\([0-7]{3})/gu,
      (_match, octal: string) => String.fromCodePoint(Number.parseInt(octal, 8)),
    )
    if (
      /\/(?:libc(?:-[^/]+)?\.so(?:\.[0-9]+)*|libc\.musl-[^/]+\.so(?:\.[0-9]+)*|ld-musl-[^/]+\.so(?:\.[0-9]+)*)$/u
        .test(path)
    ) {
      append(path)
    }
  }
  append("libc.so.6")
  if (architecture === "x64") append("/lib/ld-musl-x86_64.so.1")
  if (architecture === "arm64") append("/lib/ld-musl-aarch64.so.1")
  return candidates
}

function linuxLibcCandidates(): readonly string[] {
  try {
    return mappedLinuxLibcCandidates(readFileSync("/proc/self/maps", "utf8"))
  } catch {
    return mappedLinuxLibcCandidates("")
  }
}

function initializeNativeLocking(): NativeLocking {
  if (nativeLocking !== undefined) return nativeLocking
  const { dlopen, FFIType, read } = bunFfi()
  if (process.platform === "darwin") {
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      __error: { args: [], returns: FFIType.ptr },
      flock: {
        args: [FFIType.i32, FFIType.i32],
        returns: FFIType.i32,
      },
    })
    nativeLibraries.push(library)
    nativeLocking = {
      errnoLocation: library.symbols.__error,
      flock: library.symbols.flock,
      readInt32: read.i32 as (pointer: NativePointer) => number,
    }
    return nativeLocking
  }
  if (process.platform === "linux") {
    const failures: string[] = []
    for (const candidate of linuxLibcCandidates()) {
      try {
        const library = dlopen(candidate, {
          __errno_location: { args: [], returns: FFIType.ptr },
          flock: {
            args: [FFIType.i32, FFIType.i32],
            returns: FFIType.i32,
          },
        })
        nativeLibraries.push(library)
        nativeLocking = {
          errnoLocation: library.symbols.__errno_location,
          flock: library.symbols.flock,
          readInt32: read.i32 as (pointer: NativePointer) => number,
        }
        return nativeLocking
      } catch (cause) {
        failures.push(
          `${candidate}: ${cause instanceof Error ? cause.message : String(cause)}`,
        )
      }
    }
    throw new Error(
      "Atet could not load host flock support"
      + ` (${failures.join("; ")}).`,
    )
  }
  throw new Error(
    `Atet host-resource coordination is unsupported on ${process.platform}.`,
  )
}

function currentErrno(locking: NativeLocking): number {
  const pointer = locking.errnoLocation()
  if (pointer === null) {
    throw new Error("Atet could not read the host flock error.")
  }
  return locking.readInt32(pointer)
}

function isBusyErrno(errno: number): boolean {
  return process.platform === "darwin" ? errno === 35 : errno === 11
}

export const atetHostResourcePlatforms = Object.freeze([
  "darwin",
  "linux",
] as const)

export function isHostResourcePlatformSupported(
  platform: NodeJS.Platform,
): platform is (typeof atetHostResourcePlatforms)[number] {
  return atetHostResourcePlatforms.some((candidate) => candidate === platform)
}

export function tryLockHostResourceDescriptor(descriptor: number): boolean {
  const locking = initializeNativeLocking()
  for (;;) {
    if (locking.flock(descriptor, lockExclusive | lockNonblocking) === 0) {
      return true
    }
    const errno = currentErrno(locking)
    if (errno === interruptedErrno) continue
    if (isBusyErrno(errno)) return false
    throw new Error(`Atet host-resource flock failed with errno ${errno}.`)
  }
}

export function unlockHostResourceDescriptor(descriptor: number): void {
  const locking = initializeNativeLocking()
  for (;;) {
    if (locking.flock(descriptor, lockUnlock) === 0) return
    const errno = currentErrno(locking)
    if (errno === interruptedErrno) continue
    throw new Error(`Atet host-resource unlock failed with errno ${errno}.`)
  }
}
