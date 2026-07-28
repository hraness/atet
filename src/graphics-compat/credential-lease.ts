import { createHash, randomBytes } from "node:crypto"
import {
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  unlink,
  type FileHandle,
} from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { performance } from "node:perf_hooks"
import {
  GraphicsCloudError,
  type GraphicsCloudErrorCode,
} from "./cloud-errors.js"

const choosingMarkerPattern =
  /^choosing-v4-([0-9a-f]{32})-(\d{1,10})-([0-9a-f]{32})-([0-9a-f]{32})$/u
const leaseMarkerPattern =
  /^lease-v4-([0-9a-f]{16})-([0-9a-f]{32})-(\d{1,10})-([0-9a-f]{32})-([0-9a-f]{32})$/u
const maximumDirectoryEntries = 256
const defaultWaitMilliseconds = 35_000
const defaultStaleMilliseconds = 30_000
const defaultPollMilliseconds = 50
const maximumDurationMilliseconds = 5 * 60_000
const maximumPathBytes = 4_096
const maximumTicket = 0xffff_ffff_ffff_ffffn

export const graphicsCredentialMutationPlatforms = Object.freeze([
  "darwin",
  "linux",
] as const)

/**
 * Advanced coordination controls for embedders and deterministic tests.
 * Processes sharing credentials must share `directory`. It contains only
 * empty ticket/owner markers; OAuth material remains exclusively in secrets.
 */
export interface GraphicsCredentialMutationLeaseOptions {
  readonly directory?: string
  readonly waitTimeoutMilliseconds?: number
  readonly staleAfterMilliseconds?: number
  readonly pollIntervalMilliseconds?: number
  /**
   * Cancels lease waiting and is checked again immediately before a refresh
   * POST. A dispatched rotating-token exchange always completes and persists.
   */
  readonly signal?: AbortSignal
  /** Test hook that may fail before delegating to the inode-bound touch. */
  readonly heartbeat?: (touch: () => Promise<void>) => Promise<void>
}

export interface GraphicsCredentialMutationLeaseDependencies {
  readonly credentialLease?: GraphicsCredentialMutationLeaseOptions
}

export type GraphicsCredentialMutationPurpose =
  | "login"
  | "refresh"
  | "logout"

export interface GraphicsCredentialMutationLease {
  readonly assertOwned: () => Promise<void>
  readonly release: () => Promise<void>
}

interface ResolvedOptions {
  readonly directory: string
  readonly waitTimeoutMilliseconds: number
  readonly staleAfterMilliseconds: number
  readonly pollIntervalMilliseconds: number
  readonly signal: AbortSignal | undefined
  readonly heartbeat:
    | ((touch: () => Promise<void>) => Promise<void>)
    | undefined
}

interface MarkerIdentity {
  readonly device: number
  readonly inode: number
}

interface PublishedMarker {
  readonly name: string
  readonly path: string
  readonly processScopeIdentity: string
  readonly pid: number
  readonly processIdentity: string
  readonly ownerId: string
  readonly ticket?: bigint
  readonly handle: FileHandle
  readonly identity: MarkerIdentity
}

interface ScannedMarker {
  readonly kind: "choosing" | "lease"
  readonly name: string
  readonly path: string
  readonly processScopeIdentity: string
  readonly pid: number
  readonly processIdentity: string
  readonly ownerId: string
  readonly ticket?: bigint
  readonly identity: MarkerIdentity
  readonly modifiedAtMilliseconds: number
}

function errorCode(
  purpose: GraphicsCredentialMutationPurpose,
): GraphicsCloudErrorCode {
  return purpose === "refresh" ? "TOKEN_REFRESH_FAILED" : "TOKEN_STORAGE_FAILED"
}

function defaultFailureMessage(
  purpose: GraphicsCredentialMutationPurpose,
): string {
  return purpose === "refresh"
    ? "Graphics could not safely coordinate a login refresh."
    : "Graphics could not safely coordinate credential storage."
}

function leaseFailure(
  purpose: GraphicsCredentialMutationPurpose,
  message = defaultFailureMessage(purpose),
  cause?: unknown,
): GraphicsCloudError {
  return new GraphicsCloudError(
    errorCode(purpose),
    message,
    cause === undefined ? undefined : { cause },
  )
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  )
}

export function isGraphicsCredentialMutationPlatformSupported(
  platform: NodeJS.Platform,
): platform is (typeof graphicsCredentialMutationPlatforms)[number] {
  return graphicsCredentialMutationPlatforms.some(
    (supported) => supported === platform,
  )
}

export function assertGraphicsCredentialMutationPlatformSupported(
  purpose: GraphicsCredentialMutationPurpose,
  platform: NodeJS.Platform = process.platform,
): void {
  if (isGraphicsCredentialMutationPlatformSupported(platform)) return
  throw leaseFailure(
    purpose,
    "Graphics cannot safely mutate shared credentials on this platform.",
  )
}

function duration(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximumDurationMilliseconds
  ) {
    throw new GraphicsCloudError(
      "INVALID_ARGUMENT",
      "Invalid Graphics credential lease configuration.",
    )
  }
  return value
}

function resolveOptions(
  dependencies: GraphicsCredentialMutationLeaseDependencies,
): ResolvedOptions {
  const configured = dependencies.credentialLease
  const directory =
    configured?.directory ??
    join(homedir(), ".cache", "hraness-graphics-cli", "credential-lease-v4")
  if (
    !isAbsolute(directory) ||
    directory.includes("\0") ||
    Buffer.byteLength(directory, "utf8") > maximumPathBytes
  ) {
    throw new GraphicsCloudError(
      "INVALID_ARGUMENT",
      "Invalid Graphics credential lease configuration.",
    )
  }
  return {
    directory,
    waitTimeoutMilliseconds: duration(
      configured?.waitTimeoutMilliseconds,
      defaultWaitMilliseconds,
    ),
    staleAfterMilliseconds: duration(
      configured?.staleAfterMilliseconds,
      defaultStaleMilliseconds,
    ),
    pollIntervalMilliseconds: duration(
      configured?.pollIntervalMilliseconds,
      defaultPollMilliseconds,
    ),
    signal: configured?.signal,
    heartbeat: configured?.heartbeat,
  }
}

function throwIfCancelled(
  signal: AbortSignal | undefined,
  purpose: GraphicsCredentialMutationPurpose,
): void {
  if (signal?.aborted !== true) return
  throw leaseFailure(
    purpose,
    purpose === "refresh"
      ? "Graphics login refresh was cancelled."
      : "Graphics credential mutation was cancelled.",
  )
}

export function throwIfGraphicsCredentialMutationCancelled(
  dependencies: GraphicsCredentialMutationLeaseDependencies,
  purpose: GraphicsCredentialMutationPurpose,
): void {
  throwIfCancelled(dependencies.credentialLease?.signal, purpose)
}

async function waitForLease(
  milliseconds: number,
  signal: AbortSignal | undefined,
  purpose: GraphicsCredentialMutationPurpose,
): Promise<void> {
  throwIfCancelled(signal, purpose)
  await new Promise<void>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener("abort", cancel)
    }
    const finish = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const cancel = (): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(
        leaseFailure(
          purpose,
          purpose === "refresh"
            ? "Graphics login refresh was cancelled."
            : "Graphics credential mutation was cancelled.",
        ),
      )
    }
    timer = setTimeout(finish, milliseconds)
    signal?.addEventListener("abort", cancel, { once: true })
    if (signal?.aborted === true) cancel()
  })
}

async function prepareDirectory(
  directory: string,
  purpose: GraphicsCredentialMutationPurpose,
): Promise<void> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const details = await lstat(directory)
    const currentUid = credentialOwnerUid()
    if (
      !details.isDirectory() ||
      details.isSymbolicLink() ||
      details.uid !== currentUid ||
      (details.mode & 0o077) !== 0
    ) {
      throw leaseFailure(purpose)
    }
  } catch (cause) {
    if (cause instanceof GraphicsCloudError) throw cause
    throw leaseFailure(purpose, undefined, cause)
  }
}

function parsedPid(value: string): number | null {
  const pid = Number(value)
  return Number.isSafeInteger(pid) && pid >= 1 && pid <= 2_147_483_647
    ? pid
    : null
}

function parseMarkerName(name: string): Omit<ScannedMarker, "path" | "identity" | "modifiedAtMilliseconds"> | null {
  const choosing = choosingMarkerPattern.exec(name)
  if (choosing !== null) {
    const processScopeIdentity = choosing[1]
    const pidText = choosing[2]
    const processIdentity = choosing[3]
    const ownerId = choosing[4]
    if (
      processScopeIdentity === undefined ||
      pidText === undefined ||
      processIdentity === undefined ||
      ownerId === undefined
    ) return null
    const pid = parsedPid(pidText)
    return pid === null
      ? null
      : {
          kind: "choosing",
          name,
          processScopeIdentity,
          pid,
          processIdentity,
          ownerId,
        }
  }
  const lease = leaseMarkerPattern.exec(name)
  if (lease === null) return null
  const ticketText = lease[1]
  const processScopeIdentity = lease[2]
  const pidText = lease[3]
  const processIdentity = lease[4]
  const ownerId = lease[5]
  if (
    ticketText === undefined ||
    processScopeIdentity === undefined ||
    pidText === undefined ||
    processIdentity === undefined ||
    ownerId === undefined
  ) {
    return null
  }
  const pid = parsedPid(pidText)
  if (pid === null) return null
  return {
    kind: "lease",
    name,
    processScopeIdentity,
    pid,
    processIdentity,
    ownerId,
    ticket: BigInt(`0x${ticketText}`),
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return !isErrorCode(cause, "ESRCH")
  }
}

type ProcessIdentityResult =
  | Readonly<{
      kind: "identified"
      processScopeIdentity: string
      value: string
    }>
  | Readonly<{ kind: "missing" }>
  | Readonly<{ kind: "unavailable" }>

const linuxBootIdPath = "/proc/sys/kernel/random/boot_id"
const linuxMachineIdPaths = ["/etc/machine-id", "/var/lib/dbus/machine-id"] as const
const maximumProcStatBytes = 8_192
const macProcessInfoFlavor = 3
const macProcessInfoSize = 136
const macProcessStartSecondsOffset = 120
const macProcessStartMicrosecondsOffset = 128
const macHostUuidBytes = 16
const macHostUuidWaitSeconds = 1n
let cachedMacProcessScopeIdentity: string | undefined
let cachedLinuxHostIdentity: string | undefined

function processIdentityDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32)
}

async function linuxHostIdentity(): Promise<string | null> {
  if (cachedLinuxHostIdentity !== undefined) return cachedLinuxHostIdentity
  for (const path of linuxMachineIdPaths) {
    try {
      const source = (await readFile(path, "utf8")).trim().toLowerCase()
      if (/^(?!0{32}$)[0-9a-f]{32}$/u.test(source)) {
        cachedLinuxHostIdentity = processIdentityDigest(
          `linux-host:${source}`,
        )
        return cachedLinuxHostIdentity
      }
    } catch {
      // Try the next standard machine-id location before failing closed.
    }
  }
  return null
}

async function linuxProcessIdentity(pid: number): Promise<
  Readonly<{ processScopeIdentity: string; value: string }> | null
> {
  const [bootIdSource, statSource, pidNamespaceSource, hostIdentity] = await Promise.all([
    readFile(linuxBootIdPath, "utf8"),
    readFile(`/proc/${pid}/stat`, "utf8"),
    readlink(`/proc/${pid}/ns/pid`),
    linuxHostIdentity(),
  ])
  if (
    Buffer.byteLength(bootIdSource, "utf8") > 128 ||
    Buffer.byteLength(statSource, "utf8") > maximumProcStatBytes
  ) return null
  const bootId = bootIdSource.trim().toLowerCase()
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(bootId)) {
    return null
  }
  if (hostIdentity === null) return null
  if (!/^pid:\[[1-9][0-9]{0,31}\]$/u.test(pidNamespaceSource)) return null
  // Field 2 (`comm`) may contain spaces or parentheses. The final `) ` ends
  // that field; field 22 (`starttime`) is index 19 in the remaining fields.
  const commandEnd = statSource.lastIndexOf(") ")
  if (commandEnd < 2) return null
  const fields = statSource.slice(commandEnd + 2).trim().split(/\s+/u)
  const startTicks = fields[19]
  if (
    startTicks === undefined ||
    !/^[1-9][0-9]{0,31}$/u.test(startTicks)
  ) return null
  const processScopeIdentity = processIdentityDigest(
    `linux-pid-namespace:${hostIdentity}:${pidNamespaceSource}`,
  )
  return {
    processScopeIdentity,
    value: processIdentityDigest(
      `linux-process:${processScopeIdentity}:${startTicks}`,
    ),
  }
}

async function macProcessIdentity(pid: number): Promise<string | null> {
  const { dlopen, ptr } = await import("bun:ffi")
  const library = dlopen("/usr/lib/libproc.dylib", {
    proc_pidinfo: {
      args: ["i32", "i32", "u64", "ptr", "i32"],
      returns: "i32",
    },
  } as const)
  try {
    const bytes = new Uint8Array(macProcessInfoSize)
    const returned = library.symbols.proc_pidinfo(
      pid,
      macProcessInfoFlavor,
      0,
      ptr(bytes),
      bytes.byteLength,
    )
    if (returned !== macProcessInfoSize) return null
    const view = new DataView(bytes.buffer)
    const seconds = view.getBigUint64(macProcessStartSecondsOffset, true)
    const microseconds = view.getBigUint64(
      macProcessStartMicrosecondsOffset,
      true,
    )
    if (seconds < 1n || microseconds >= 1_000_000n) return null
    return processIdentityDigest(`darwin:${seconds}:${microseconds}`)
  } finally {
    library.close()
  }
}

async function macProcessScopeIdentity(): Promise<string | null> {
  if (cachedMacProcessScopeIdentity !== undefined) {
    return cachedMacProcessScopeIdentity
  }
  const { dlopen } = await import("bun:ffi")
  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    gethostuuid: {
      args: ["ptr", "ptr"],
      returns: "i32",
    },
  } as const)
  try {
    const uuid = new Uint8Array(macHostUuidBytes)
    const wait = new BigInt64Array([macHostUuidWaitSeconds, 0n])
    if (library.symbols.gethostuuid(uuid, wait) !== 0) return null
    const source = Buffer.from(uuid).toString("hex")
    if (!/^(?!0{32}$)[0-9a-f]{32}$/u.test(source)) return null
    cachedMacProcessScopeIdentity = processIdentityDigest(
      `darwin-host:${source}`,
    )
    return cachedMacProcessScopeIdentity
  } finally {
    library.close()
  }
}

async function darwinProcessIdentity(pid: number): Promise<
  Readonly<{ processScopeIdentity: string; value: string }> | null
> {
  const [value, processScopeIdentity] = await Promise.all([
    macProcessIdentity(pid),
    macProcessScopeIdentity(),
  ])
  return value === null || processScopeIdentity === null
    ? null
    : { processScopeIdentity, value }
}

async function queryProcessIdentity(pid: number): Promise<ProcessIdentityResult> {
  if (!processIsAlive(pid)) return { kind: "missing" }
  try {
    const identity = process.platform === "linux"
      ? await linuxProcessIdentity(pid)
      : process.platform === "darwin"
        ? await darwinProcessIdentity(pid)
        : null
    if (identity !== null) return { kind: "identified", ...identity }
  } catch {
    // Recheck below to distinguish an ordinary exit from unavailable process
    // inspection without exposing platform details to credential errors.
  }
  return processIsAlive(pid)
    ? { kind: "unavailable" }
    : { kind: "missing" }
}

async function markerProcessIsOwner(marker: Pick<
  ScannedMarker,
  "pid" | "processIdentity" | "processScopeIdentity"
>, inspectingProcessScopeIdentity: string): Promise<boolean> {
  if (marker.processScopeIdentity !== inspectingProcessScopeIdentity) return true
  const processIdentity = await queryProcessIdentity(marker.pid)
  // Process inspection can itself be unavailable. Preserve the safety side of
  // fail-closed behavior rather than preempting a possibly live token owner.
  return processIdentity.kind === "unavailable" ||
    (
      processIdentity.kind === "identified" &&
      processIdentity.processScopeIdentity === marker.processScopeIdentity &&
      processIdentity.value === marker.processIdentity
    )
}

function identity(value: { readonly dev: number; readonly ino: number }): MarkerIdentity {
  return { device: value.dev, inode: value.ino }
}

function credentialOwnerUid(): number {
  if (typeof process.getuid !== "function") {
    throw new Error("credential owner uid unavailable")
  }
  return process.getuid()
}

function sameIdentity(
  left: MarkerIdentity,
  right:
    | MarkerIdentity
    | { readonly dev: number; readonly ino: number },
): boolean {
  const device = "device" in right ? right.device : right.dev
  const inode = "inode" in right ? right.inode : right.ino
  return left.device === device && left.inode === inode
}

function markerIsPrivateRegularFile(details: {
  readonly mode: number
  readonly uid: number
  readonly size: number
  isFile(): boolean
  isSymbolicLink(): boolean
}): boolean {
  return (
    details.isFile() &&
    !details.isSymbolicLink() &&
    details.uid === credentialOwnerUid() &&
    (details.mode & 0o077) === 0 &&
    details.size === 0
  )
}

async function removeStaleUniqueMarker(
  marker: ScannedMarker,
  options: ResolvedOptions,
  processScopeIdentity: string,
): Promise<void> {
  try {
    const confirmed = await lstat(marker.path)
    if (
      !sameIdentity(marker.identity, confirmed) ||
      !markerIsPrivateRegularFile(confirmed) ||
      await markerProcessIsOwner(marker, processScopeIdentity) ||
      Date.now() - confirmed.mtimeMs < options.staleAfterMilliseconds
    ) {
      return
    }
    // Owner ids are random and never reused, so this pathname can never name a
    // legitimate successor. The inode check fences concurrent stale cleaners.
    await unlink(marker.path)
  } catch {
    // Cleanup is opportunistic. Dead stale markers are ignored by election, so
    // a transient unlink failure cannot strand the credential lease.
  }
}

async function scanActiveMarkers(
  options: ResolvedOptions,
  purpose: GraphicsCredentialMutationPurpose,
  processScopeIdentity: string,
): Promise<readonly ScannedMarker[]> {
  let entries
  try {
    entries = await readdir(options.directory, { withFileTypes: true })
  } catch (cause) {
    throw leaseFailure(purpose, undefined, cause)
  }
  if (entries.length > maximumDirectoryEntries) {
    throw leaseFailure(purpose)
  }

  const active: ScannedMarker[] = []
  for (const entry of entries) {
    const parsed = parseMarkerName(entry.name)
    if (parsed === null) continue
    if (parsed.processScopeIdentity !== processScopeIdentity) {
      throw leaseFailure(
        purpose,
        "Graphics cannot safely coordinate credentials across process scopes.",
      )
    }
    const path = join(options.directory, entry.name)
    let details
    try {
      details = await lstat(path)
    } catch (cause) {
      if (isErrorCode(cause, "ENOENT")) continue
      throw leaseFailure(purpose, undefined, cause)
    }
    if (!markerIsPrivateRegularFile(details)) {
      throw leaseFailure(purpose)
    }
    const marker: ScannedMarker = {
      ...parsed,
      path,
      identity: identity(details),
      modifiedAtMilliseconds: details.mtimeMs,
    }
    if (
      Date.now() - marker.modifiedAtMilliseconds <
        options.staleAfterMilliseconds ||
      await markerProcessIsOwner(marker, processScopeIdentity)
    ) {
      active.push(marker)
      continue
    }
    await removeStaleUniqueMarker(marker, options, processScopeIdentity)
  }
  return active
}

async function publishMarker(
  directory: string,
  name: string,
  processScopeIdentity: string,
  pid: number,
  processIdentity: string,
  ownerId: string,
  purpose: GraphicsCredentialMutationPurpose,
  ticket?: bigint,
): Promise<PublishedMarker> {
  const path = join(directory, name)
  let handle: FileHandle | undefined
  try {
    handle = await open(path, "wx+", 0o600)
    const details = await handle.stat()
    if (!markerIsPrivateRegularFile(details)) throw leaseFailure(purpose)
    return {
      name,
      path,
      processScopeIdentity,
      pid,
      processIdentity,
      ownerId,
      ...(ticket === undefined ? {} : { ticket }),
      handle,
      identity: identity(details),
    }
  } catch (cause) {
    await handle?.close().catch(() => undefined)
    if (cause instanceof GraphicsCloudError) throw cause
    throw leaseFailure(purpose, undefined, cause)
  }
}

async function markerStillOwned(marker: PublishedMarker): Promise<boolean> {
  try {
    const [held, named] = await Promise.all([
      marker.handle.stat(),
      lstat(marker.path),
    ])
    return (
      sameIdentity(marker.identity, held) &&
      sameIdentity(marker.identity, named) &&
      markerIsPrivateRegularFile(held) &&
      markerIsPrivateRegularFile(named)
    )
  } catch {
    return false
  }
}

type MarkerRemovalResult = "removed" | "lost" | "retry"

async function removePublishedMarkerOnce(
  marker: PublishedMarker,
): Promise<MarkerRemovalResult> {
  let held
  let named
  try {
    held = await marker.handle.stat()
  } catch {
    return "lost"
  }
  try {
    named = await lstat(marker.path)
  } catch (cause) {
    return isErrorCode(cause, "ENOENT") ? "removed" : "retry"
  }
  if (
    !sameIdentity(marker.identity, held) ||
    !sameIdentity(marker.identity, named) ||
    !markerIsPrivateRegularFile(held) ||
    !markerIsPrivateRegularFile(named)
  ) {
    return "lost"
  }
  try {
    // This owner path is globally unique and is never reused. No legitimate
    // successor can appear at it between the inode check and unlink.
    await unlink(marker.path)
    return "removed"
  } catch (cause) {
    return isErrorCode(cause, "ENOENT") ? "removed" : "retry"
  }
}

async function removePublishedMarker(
  marker: PublishedMarker,
  pollMilliseconds: number,
): Promise<MarkerRemovalResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await removePublishedMarkerOnce(marker)
    if (result !== "retry") return result
    if (attempt < 2) await waitForLease(pollMilliseconds, undefined, "logout")
  }
  return "retry"
}

function closeAfterBackgroundCleanup(
  marker: PublishedMarker,
  pollMilliseconds: number,
): void {
  let cleanup = Promise.resolve()
  const timer = setInterval(() => {
    cleanup = cleanup
      .then(async () => {
        const result = await removePublishedMarkerOnce(marker)
        if (result === "retry") return
        clearInterval(timer)
        await marker.handle.close().catch(() => undefined)
      })
      .catch(() => undefined)
  }, pollMilliseconds)
  timer.unref()
}

function compareLeases(left: ScannedMarker, right: ScannedMarker): number {
  const leftTicket = left.ticket
  const rightTicket = right.ticket
  if (leftTicket === undefined || rightTicket === undefined) return 0
  if (leftTicket < rightTicket) return -1
  if (leftTicket > rightTicket) return 1
  if (left.ownerId < right.ownerId) return -1
  if (left.ownerId > right.ownerId) return 1
  return 0
}

function managedLease(
  marker: PublishedMarker,
  options: ResolvedOptions,
  purpose: GraphicsCredentialMutationPurpose,
): GraphicsCredentialMutationLease {
  let releaseRequested = false
  let released = false
  let heartbeat = Promise.resolve()
  const heartbeatMilliseconds = Math.max(
    10,
    Math.min(5_000, Math.floor(options.staleAfterMilliseconds / 3)),
  )

  const touch = async (): Promise<void> => {
    if (!(await markerStillOwned(marker))) throw leaseFailure(purpose)
    const timestamp = new Date()
    await marker.handle.utimes(timestamp, timestamp)
  }
  const timer = setInterval(() => {
    if (releaseRequested || released) return
    heartbeat = heartbeat
      .then(async () => {
        try {
          await (options.heartbeat ?? ((operation) => operation()))(touch)
        } catch {
          // A heartbeat is a liveness hint, not ownership. Live PIDs are never
          // preempted, and final ownership is revalidated from the marker and
          // open inode before a rotated response is persisted.
        }
      })
      .catch(() => undefined)
  }, heartbeatMilliseconds)
  timer.unref()

  const assertOwnedOnce = async (): Promise<void> => {
    if (released || !(await markerStillOwned(marker))) {
      throw leaseFailure(purpose)
    }
    const markers = await scanActiveMarkers(
      options,
      purpose,
      marker.processScopeIdentity,
    )
    const leases = markers
      .filter((candidate) => candidate.kind === "lease")
      .sort(compareLeases)
    const owner = leases[0]
    if (
      owner === undefined ||
      owner.ownerId !== marker.ownerId ||
      owner.ticket !== marker.ticket ||
      !sameIdentity(marker.identity, owner.identity)
    ) {
      throw leaseFailure(purpose)
    }
  }

  return {
    assertOwned: async () => {
      let lastFailure: unknown
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await assertOwnedOnce()
          return
        } catch (cause) {
          lastFailure = cause
          if (attempt < 2) {
            await waitForLease(
              options.pollIntervalMilliseconds,
              undefined,
              purpose,
            )
          }
        }
      }
      if (lastFailure instanceof GraphicsCloudError) throw lastFailure
      throw leaseFailure(purpose, undefined, lastFailure)
    },
    release: async () => {
      if (releaseRequested) return
      releaseRequested = true
      clearInterval(timer)
      // Heartbeats are advisory and may be supplied by an embedder. Never let
      // a stuck heartbeat strand the owner after the credential mutation has
      // finished. A late touch is inode-bound and safely fails after close.
      void heartbeat.catch(() => undefined)
      const removal = await removePublishedMarker(
        marker,
        options.pollIntervalMilliseconds,
      )
      if (removal !== "retry") {
        released = true
        await marker.handle.close().catch(() => undefined)
        return
      }
      // Keep the inode open and retry in the background. This preserves a live
      // owner until a transient filesystem error clears; process exit makes
      // the unique marker recoverable through the dead/stale path.
      closeAfterBackgroundCleanup(marker, options.pollIntervalMilliseconds)
    },
  }
}

async function cleanupUnacquiredMarker(
  marker: PublishedMarker | undefined,
  pollMilliseconds: number,
): Promise<void> {
  if (marker === undefined) return
  if ((await removePublishedMarker(marker, pollMilliseconds)) !== "retry") {
    await marker.handle.close().catch(() => undefined)
    return
  }
  closeAfterBackgroundCleanup(marker, pollMilliseconds)
}

export async function acquireGraphicsCredentialMutationLease(
  dependencies: GraphicsCredentialMutationLeaseDependencies,
  purpose: GraphicsCredentialMutationPurpose,
): Promise<GraphicsCredentialMutationLease> {
  assertGraphicsCredentialMutationPlatformSupported(purpose)
  const options = resolveOptions(dependencies)
  await prepareDirectory(options.directory, purpose)
  const deadline = performance.now() + options.waitTimeoutMilliseconds
  const ownerId = randomBytes(16).toString("hex")
  const processIdentity = await queryProcessIdentity(process.pid)
  if (processIdentity.kind !== "identified") throw leaseFailure(purpose)
  const choosingName =
    `choosing-v4-${processIdentity.processScopeIdentity}-${process.pid}-${processIdentity.value}-${ownerId}`
  let choosing: PublishedMarker | undefined
  let owner: PublishedMarker | undefined
  let lease: GraphicsCredentialMutationLease | undefined

  try {
    throwIfCancelled(options.signal, purpose)
    choosing = await publishMarker(
      options.directory,
      choosingName,
      processIdentity.processScopeIdentity,
      process.pid,
      processIdentity.value,
      ownerId,
      purpose,
    )
    const initialMarkers = await scanActiveMarkers(
      options,
      purpose,
      processIdentity.processScopeIdentity,
    )
    let highestTicket = 0n
    for (const marker of initialMarkers) {
      if (
        marker.kind === "lease" &&
        marker.ticket !== undefined &&
        marker.ticket > highestTicket
      ) {
        highestTicket = marker.ticket
      }
    }
    if (highestTicket >= maximumTicket) throw leaseFailure(purpose)
    const ticket = highestTicket + 1n
    const ticketText = ticket.toString(16).padStart(16, "0")
    const ownerName =
      `lease-v4-${ticketText}-${processIdentity.processScopeIdentity}-${process.pid}-${processIdentity.value}-${ownerId}`
    owner = await publishMarker(
      options.directory,
      ownerName,
      processIdentity.processScopeIdentity,
      process.pid,
      processIdentity.value,
      ownerId,
      purpose,
      ticket,
    )
    if (
      (await removePublishedMarker(
        choosing,
        options.pollIntervalMilliseconds,
      )) !== "removed"
    ) {
      throw leaseFailure(purpose)
    }
    await choosing.handle.close().catch(() => undefined)
    choosing = undefined

    lease = managedLease(owner, options, purpose)
    for (;;) {
      throwIfCancelled(options.signal, purpose)
      if (!(await markerStillOwned(owner))) throw leaseFailure(purpose)
      const markers = await scanActiveMarkers(
        options,
        purpose,
        processIdentity.processScopeIdentity,
      )
      const anotherChooser = markers.some(
        (marker) =>
          marker.kind === "choosing" && marker.ownerId !== ownerId,
      )
      const leases = markers
        .filter((marker) => marker.kind === "lease")
        .sort(compareLeases)
      const first = leases[0]
      if (
        !anotherChooser &&
        first !== undefined &&
        first.ownerId === ownerId &&
        first.ticket === ticket &&
        sameIdentity(owner.identity, first.identity)
      ) {
        return lease
      }
      const remaining = deadline - performance.now()
      if (remaining <= 0) {
        throw leaseFailure(
          purpose,
          purpose === "refresh"
            ? "Graphics timed out waiting for another login refresh."
            : "Graphics timed out waiting for another credential mutation.",
        )
      }
      await waitForLease(
        Math.min(options.pollIntervalMilliseconds, remaining),
        options.signal,
        purpose,
      )
    }
  } catch (cause) {
    await lease?.release()
    if (lease === undefined) {
      await cleanupUnacquiredMarker(owner, options.pollIntervalMilliseconds)
    }
    await cleanupUnacquiredMarker(choosing, options.pollIntervalMilliseconds)
    throw cause
  }
}
