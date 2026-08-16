import { createHash, randomBytes } from "node:crypto"
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs"
import { availableParallelism, homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { performance } from "node:perf_hooks"
import {
  isHostResourcePlatformSupported,
  tryLockHostResourceDescriptor,
  unlockHostResourceDescriptor,
} from "./host-resource-posix.js"

const profileIdPattern = /^[a-z0-9][a-z0-9._/-]{0,119}$/u
const resourceNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const ownerIdPattern = /^[0-9a-f]{32}$/u
const ticketPattern = /^[1-9][0-9]{0,19}$/u
const markerNamePattern = /^lease-([0-9]{20})-([0-9a-f]{32})\.lock$/u
const temporaryNamePattern = /^\.host-resources-[0-9a-f]{32}\.tmp$/u
const stateFileName = "state.json"
const controlFileName = "control.lock"
const initializedFileName = "initialized.lock"
const maximumResources = 64
const maximumProcessLocalProfiles = 64
const maximumDirectoryEntries = 1_024
const maximumFileBytes = 64 * 1_024
const maximumPathBytes = 4_096
const maximumResourceAmount = 1_000_000
const maximumTicket = 0xffff_ffff_ffff_ffffn
const defaultPollIntervalMilliseconds = 25
const defaultWaitTimeoutMilliseconds = 35_000
const maximumAdmissionBackoffMilliseconds = 250
const smallPollIntervalMilliseconds = 4
const maximumAdmissionBackoffMultiplier = 8

/** Largest supported explicit admission wait for any host-resource lease. */
export const HOST_RESOURCE_MAX_WAIT_MILLISECONDS = 24 * 60 * 60_000

export const atetHostResourceNames = Object.freeze([
  "cpu",
  "local-io",
  "ffmpeg",
  "video-encode",
  "vision",
  "whisper",
  "network",
  "paid-call",
  "browser",
  "capture-device",
] as const)

export type AtetHostResourceName =
  (typeof atetHostResourceNames)[number]

export interface HostResourceCapacity {
  readonly resource: string
  readonly limit: number
}

export interface HostResourceProfile {
  readonly id: string
  readonly capacities: readonly HostResourceCapacity[]
}

export interface HostResourceClaim {
  readonly resource: string
  readonly amount: number
}

export interface HostResourceLease {
  readonly claims: readonly HostResourceClaim[]
  readonly inheritedFileDescriptor: number
  readonly profile: HostResourceProfile
  readonly ticket: string
  assertOwned(): Promise<void>
}

export interface HostResourceLeaseOptions {
  readonly signal?: AbortSignal
  readonly waitTimeoutMilliseconds?: number
}

export interface HostResourceCoordinator {
  readonly profile: HostResourceProfile
  readonly scope: "machine" | "process"
  withLease<T>(
    claims: readonly HostResourceClaim[],
    callback: (lease: HostResourceLease) => T | Promise<T>,
    options?: HostResourceLeaseOptions,
  ): Promise<T>
}

export interface HostResourceCoordinatorOptions {
  readonly profile?: HostResourceProfile
  readonly stateRoot?: string
  readonly pollIntervalMilliseconds?: number
  readonly waitTimeoutMilliseconds?: number
}

export type HostResourceErrorCode =
  | "INVALID_PROFILE"
  | "INVALID_CLAIMS"
  | "UNSUPPORTED_PLATFORM"
  | "UNSAFE_STATE"
  | "PROFILE_MISMATCH"
  | "WAIT_ABORTED"
  | "WAIT_TIMEOUT"
  | "OWNERSHIP_LOST"

export class HostResourceError extends Error {
  readonly code: HostResourceErrorCode

  constructor(code: HostResourceErrorCode, message: string, cause?: unknown) {
    super(`[${code}] ${message}`, cause === undefined ? undefined : { cause })
    this.name = "HostResourceError"
    this.code = code
  }
}

interface MarkerIdentity {
  readonly device: number
  readonly inode: number
}

interface MarkerDocument {
  readonly version: 1
  readonly owner: string
  readonly profileSha256: string
  readonly ticket: string
  readonly phase: "A" | "W"
  readonly claims: readonly HostResourceClaim[]
}

interface LiveMarker {
  document: MarkerDocument
  readonly identity: MarkerIdentity
  readonly name: string
  readonly path: string
}

interface OwnedMarker extends LiveMarker {
  readonly descriptor: number
  released: boolean
}

interface ResolvedStateRoot {
  readonly path: string
}

interface ResolvedCoordinatorOptions {
  readonly pollIntervalMilliseconds: number
  readonly profile: HostResourceProfile
  readonly profileSha256: string
  readonly stateRoot: string
  readonly waitTimeoutMilliseconds: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort()
  const normalizedExpected = [...expected].sort()
  return actual.length === normalizedExpected.length
    && actual.every((key, index) => key === normalizedExpected[index])
}

function boundedPositiveInteger(
  value: unknown,
  maximum: number,
): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1
    && (value as number) <= maximum
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value
  }
  for (const nested of Object.values(value)) deepFreeze(nested)
  return Object.freeze(value)
}

function resourceEntries(
  value: unknown,
  amountKey: "amount" | "limit",
  errorCode: "INVALID_CLAIMS" | "INVALID_PROFILE",
): readonly Readonly<{ resource: string; value: number }>[] {
  const minimumEntries = errorCode === "INVALID_CLAIMS" ? 0 : 1
  if (
    !Array.isArray(value)
    || value.length < minimumEntries
    || value.length > maximumResources
  ) {
    throw new HostResourceError(
      errorCode,
      `Host-resource ${amountKey === "limit" ? "capacities" : "claims"} must contain ${minimumEntries} through ${maximumResources} entries.`,
    )
  }
  const seen = new Set<string>()
  const result = value.map((candidate) => {
    if (
      !isRecord(candidate)
      || !hasExactKeys(candidate, ["resource", amountKey])
      || typeof candidate.resource !== "string"
      || !resourceNamePattern.test(candidate.resource)
      || !boundedPositiveInteger(candidate[amountKey], maximumResourceAmount)
      || seen.has(candidate.resource)
    ) {
      throw new HostResourceError(
        errorCode,
        `Host-resource ${amountKey === "limit" ? "capacities" : "claims"} are malformed or duplicated.`,
      )
    }
    seen.add(candidate.resource)
    return { resource: candidate.resource, value: candidate[amountKey] as number }
  })
  return result.sort((left, right) => (
    left.resource < right.resource ? -1 : left.resource > right.resource ? 1 : 0
  ))
}

export function normalizeHostResourceProfile(value: unknown): HostResourceProfile {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["id", "capacities"])
    || typeof value.id !== "string"
    || !profileIdPattern.test(value.id)
  ) {
    throw new HostResourceError(
      "INVALID_PROFILE",
      "Host-resource profile identity is invalid.",
    )
  }
  const capacities = resourceEntries(
    value.capacities,
    "limit",
    "INVALID_PROFILE",
  ).map(({ resource, value: limit }) => ({ resource, limit }))
  return deepFreeze({ id: value.id, capacities })
}

export function normalizeHostResourceClaims(
  value: unknown,
  profile: HostResourceProfile,
): readonly HostResourceClaim[] {
  const normalizedProfile = normalizeHostResourceProfile(profile)
  const limits = new Map(
    normalizedProfile.capacities.map(({ resource, limit }) => [resource, limit]),
  )
  const claims = resourceEntries(value, "amount", "INVALID_CLAIMS")
    .map(({ resource, value: amount }) => {
      const limit = limits.get(resource)
      if (limit === undefined || amount > limit) {
        throw new HostResourceError(
          "INVALID_CLAIMS",
          `Host-resource claim ${resource} is unavailable or exceeds its profile limit.`,
        )
      }
      return { resource, amount }
    })
  return deepFreeze(claims)
}

export function defaultAtetHostResourceProfile(
  hostParallelism = availableParallelism(),
): HostResourceProfile {
  if (!boundedPositiveInteger(hostParallelism, maximumResourceAmount)) {
    throw new HostResourceError(
      "INVALID_PROFILE",
      "Host parallelism must be a positive safe integer.",
    )
  }
  const reserve = hostParallelism >= 6 ? 2 : hostParallelism >= 2 ? 1 : 0
  return normalizeHostResourceProfile({
    id: "atet.host-resources/v1",
    capacities: [
      { resource: "cpu", limit: Math.max(1, hostParallelism - reserve) },
      { resource: "local-io", limit: 2 },
      { resource: "ffmpeg", limit: 2 },
      { resource: "video-encode", limit: 1 },
      { resource: "vision", limit: 1 },
      { resource: "whisper", limit: 1 },
      { resource: "network", limit: 4 },
      { resource: "paid-call", limit: 1 },
      { resource: "browser", limit: 1 },
      { resource: "capture-device", limit: 1 },
    ],
  })
}

export function defaultAtetHostResourceStateRoot(
  platform: NodeJS.Platform = process.platform,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  userHome = homedir(),
): string {
  if (!isHostResourcePlatformSupported(platform)) {
    throw new HostResourceError(
      "UNSUPPORTED_PLATFORM",
      "Atet host-resource coordination requires Darwin or Linux.",
    )
  }
  if (platform === "darwin") {
    return join(
      userHome,
      "Library",
      "Application Support",
      "Atet",
      "cli",
      "host-resources-v1",
    )
  }
  const configuredStateHome = environment.XDG_STATE_HOME
  const stateHome = configuredStateHome !== undefined
    && isAbsolute(configuredStateHome)
    ? configuredStateHome
    : join(userHome, ".local", "state")
  return join(stateHome, "atet", "host-resources-v1")
}


function canonicalProfile(profile: HostResourceProfile): string {
  return JSON.stringify(profile)
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function stateFailure(message: string, cause?: unknown): HostResourceError {
  return new HostResourceError("UNSAFE_STATE", message, cause)
}

function isErrorCode(value: unknown, code: string): boolean {
  return isRecord(value) && value.code === code
}

function ownerUid(): number {
  const uid = process.geteuid?.() ?? process.getuid?.()
  if (uid === undefined) throw stateFailure("Host-resource owner identity is unavailable.")
  return uid
}

function identity(value: Pick<Stats, "dev" | "ino">): MarkerIdentity {
  return { device: value.dev, inode: value.ino }
}

function sameIdentity(
  left: MarkerIdentity,
  right: MarkerIdentity | Pick<Stats, "dev" | "ino">,
): boolean {
  const device = "device" in right ? right.device : right.dev
  const inode = "inode" in right ? right.inode : right.ino
  return left.device === device && left.inode === inode
}

function privateDirectory(metadata: Stats): boolean {
  return metadata.isDirectory()
    && !metadata.isSymbolicLink()
    && metadata.uid === ownerUid()
    && (metadata.mode & 0o777) === 0o700
}

function privateRegularFile(metadata: Stats): boolean {
  return metadata.isFile()
    && !metadata.isSymbolicLink()
    && metadata.nlink === 1
    && metadata.uid === ownerUid()
    && (metadata.mode & 0o777) === 0o600
}

function metadataOrNull(path: string): Stats | null {
  try {
    return lstatSync(path)
  } catch (cause) {
    if (isErrorCode(cause, "ENOENT")) return null
    throw cause
  }
}

function ensureStateRoot(path: string): ResolvedStateRoot {
  if (
    !isAbsolute(path)
    || path.includes("\0")
    || Buffer.byteLength(path, "utf8") > maximumPathBytes
  ) {
    throw stateFailure("Host-resource state root must be a bounded absolute path.")
  }
  let created = false
  let metadata = metadataOrNull(path)
  if (metadata === null) {
    try {
      mkdirSync(path, { recursive: true, mode: 0o700 })
      created = true
    } catch (cause) {
      if (!isErrorCode(cause, "EEXIST")) {
        throw stateFailure("Host-resource state root could not be created.", cause)
      }
    }
    metadata = lstatSync(path)
    if (created) chmodSync(path, 0o700)
  }
  if (!privateDirectory(metadata)) {
    throw stateFailure("Host-resource state root is not one private owned directory.")
  }
  const canonical = realpathSync(path)
  if (!privateDirectory(statSync(canonical))) {
    throw stateFailure("Host-resource state root canonicalization is unsafe.")
  }
  return { path: canonical }
}

function openPrivateFile(path: string, exclusive = false): number {
  const existing = metadataOrNull(path)
  if (existing !== null && !privateRegularFile(existing)) {
    throw stateFailure("Host-resource state contains an unsafe file.")
  }
  const flags = constants.O_RDWR
    | constants.O_CREAT
    | constants.O_NOFOLLOW
    | (exclusive ? constants.O_EXCL : 0)
  const descriptor = openSync(path, flags, 0o600)
  try {
    fchmodSync(descriptor, 0o600)
    const opened = fstatSync(descriptor)
    const published = lstatSync(path)
    if (
      !privateRegularFile(opened)
      || !privateRegularFile(published)
      || opened.dev !== published.dev
      || opened.ino !== published.ino
    ) {
      throw stateFailure("Host-resource file identity changed while opening.")
    }
    return descriptor
  } catch (cause) {
    closeSync(descriptor)
    throw cause
  }
}

function readDescriptor(descriptor: number): string {
  const metadata = fstatSync(descriptor)
  if (!privateRegularFile(metadata) || metadata.size > maximumFileBytes) {
    throw stateFailure("Host-resource state file is malformed.")
  }
  const bytes = Buffer.alloc(metadata.size)
  let offset = 0
  while (offset < bytes.length) {
    const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset)
    if (count === 0) break
    offset += count
  }
  if (offset !== bytes.length) throw stateFailure("Host-resource state read was incomplete.")
  return bytes.toString("utf8")
}

function writeDescriptor(descriptor: number, value: string): void {
  const bytes = Buffer.from(value, "utf8")
  if (bytes.length > maximumFileBytes) {
    throw stateFailure("Host-resource state write exceeds its bound.")
  }
  ftruncateSync(descriptor, 0)
  let offset = 0
  while (offset < bytes.length) {
    const written = writeSync(
      descriptor,
      bytes,
      offset,
      bytes.length - offset,
      offset,
    )
    if (written < 1) throw stateFailure("Host-resource state write was incomplete.")
    offset += written
  }
  fsyncSync(descriptor)
}

interface StateDocument {
  readonly version: 1
  readonly profile: HostResourceProfile
  readonly nextTicket: string
}

function stateJson(state: StateDocument): string {
  return JSON.stringify({
    version: state.version,
    profile: state.profile,
    nextTicket: state.nextTicket,
  })
}

function markerJson(marker: MarkerDocument): string {
  return JSON.stringify({
    version: marker.version,
    owner: marker.owner,
    profileSha256: marker.profileSha256,
    ticket: marker.ticket,
    phase: marker.phase,
    claims: marker.claims,
  })
}

function syncDirectory(directory: string): void {
  const descriptor = openSync(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    if (!privateDirectory(fstatSync(descriptor))) {
      throw stateFailure("Host-resource state root changed identity.")
    }
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

function atomicWriteState(directory: string, state: StateDocument): void {
  const temporaryName = `.host-resources-${randomBytes(16).toString("hex")}.tmp`
  const temporaryPath = join(directory, temporaryName)
  const statePath = join(directory, stateFileName)
  let descriptor: number | undefined
  try {
    descriptor = openPrivateFile(temporaryPath, true)
    writeDescriptor(descriptor, stateJson(state))
    closeSync(descriptor)
    descriptor = undefined
    const existing = metadataOrNull(statePath)
    if (existing !== null && !privateRegularFile(existing)) {
      throw stateFailure("Host-resource profile state is unsafe.")
    }
    renameSync(temporaryPath, statePath)
    const published = lstatSync(statePath)
    if (!privateRegularFile(published)) {
      throw stateFailure("Host-resource profile state was not published safely.")
    }
    syncDirectory(directory)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    try {
      unlinkSync(temporaryPath)
    } catch (cause) {
      if (!isErrorCode(cause, "ENOENT")) {
        // The unique private temporary file is inert. A later control owner
        // removes it before admitting more work.
      }
    }
  }
}

function parseState(value: string): StateDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (cause) {
    throw stateFailure("Host-resource profile state is not valid JSON.", cause)
  }
  if (
    !isRecord(parsed)
    || !hasExactKeys(parsed, ["version", "profile", "nextTicket"])
    || parsed.version !== 1
    || typeof parsed.nextTicket !== "string"
    || !ticketPattern.test(parsed.nextTicket)
  ) {
    throw stateFailure("Host-resource profile state is malformed.")
  }
  let profile: HostResourceProfile
  try {
    profile = normalizeHostResourceProfile(parsed.profile)
  } catch (cause) {
    throw stateFailure("Host-resource profile state is malformed.", cause)
  }
  const nextTicket = BigInt(parsed.nextTicket)
  if (nextTicket > maximumTicket + 1n) {
    throw stateFailure("Host-resource ticket state exceeds its bound.")
  }
  const state: StateDocument = {
    version: 1,
    profile,
    nextTicket: parsed.nextTicket,
  }
  if (stateJson(state) !== value) {
    throw stateFailure("Host-resource profile state is not normalized.")
  }
  return state
}

function readState(
  directory: string,
  profile: HostResourceProfile,
): StateDocument {
  const path = join(directory, stateFileName)
  const initializedPath = join(directory, initializedFileName)
  if (metadataOrNull(path) === null) {
    if (
      metadataOrNull(initializedPath) !== null
      || readdirSync(directory).some((name) => markerNamePattern.test(name))
    ) {
      throw stateFailure("Host-resource profile state is missing.")
    }
    const initial: StateDocument = {
      version: 1,
      profile,
      nextTicket: "1",
    }
    atomicWriteState(directory, initial)
    const initialized = openPrivateFile(initializedPath, true)
    closeSync(initialized)
    syncDirectory(directory)
    return initial
  }
  const descriptor = openPrivateFile(path)
  try {
    const state = parseState(readDescriptor(descriptor))
    const initializedWasMissing = metadataOrNull(initializedPath) === null
    const initialized = initializedWasMissing
      ? openPrivateFile(initializedPath, true)
      : openPrivateFile(initializedPath)
    try {
      if (fstatSync(initialized).size !== 0) {
        throw stateFailure("Host-resource initialization state is malformed.")
      }
    } finally {
      closeSync(initialized)
    }
    if (initializedWasMissing) syncDirectory(directory)
    return state
  } finally {
    closeSync(descriptor)
  }
}

function assertMatchingProfile(
  state: StateDocument,
  profile: HostResourceProfile,
): void {
  if (canonicalProfile(state.profile) === canonicalProfile(profile)) return
  throw new HostResourceError(
    "PROFILE_MISMATCH",
    "The machine-global Atet host-resource profile does not match this process.",
  )
}

function reserveTicket(
  directory: string,
  state: StateDocument,
): string {
  const ticket = BigInt(state.nextTicket)
  if (ticket > maximumTicket) {
    throw stateFailure("Host-resource tickets are exhausted.")
  }
  atomicWriteState(directory, {
    ...state,
    nextTicket: String(ticket + 1n),
  })
  return String(ticket)
}

function duration(
  value: number | undefined,
  fallback: number,
  maximum: number,
  code: "INVALID_CLAIMS" | "INVALID_PROFILE",
  label: string,
): number {
  const resolved = value ?? fallback
  if (!boundedPositiveInteger(resolved, maximum)) {
    throw new HostResourceError(code, `${label} is outside its supported bound.`)
  }
  return resolved
}

function throwIfWaitEnded(signal: AbortSignal | undefined, deadline: number): void {
  if (signal?.aborted === true) {
    throw new HostResourceError(
      "WAIT_ABORTED",
      "Host-resource admission was cancelled before execution.",
    )
  }
  if (performance.now() >= deadline) {
    throw new HostResourceError(
      "WAIT_TIMEOUT",
      "Host-resource admission exceeded its bounded wait.",
    )
  }
}

async function waitForRetry(
  pollIntervalMilliseconds: number,
  signal: AbortSignal | undefined,
  deadline: number,
): Promise<void> {
  throwIfWaitEnded(signal, deadline)
  const remaining = Math.max(1, Math.ceil(deadline - performance.now()))
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener("abort", cancel)
      resolve()
    }
    const cancel = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", cancel)
      reject(new HostResourceError(
        "WAIT_ABORTED",
        "Host-resource admission was cancelled before execution.",
      ))
    }
    const timer = setTimeout(
      finish,
      Math.min(pollIntervalMilliseconds, remaining),
    )
    signal?.addEventListener("abort", cancel, { once: true })
    if (signal?.aborted === true) cancel()
  })
  throwIfWaitEnded(signal, deadline)
}

function mixRetrySeed(ticket: string, retry: number): bigint {
  const mask = 0xffff_ffff_ffff_ffffn
  let value = (
    BigInt(ticket)
    + BigInt(retry + 1) * 0x9e37_79b9_7f4a_7c15n
  ) & mask
  value = ((value ^ (value >> 30n)) * 0xbf58_476d_1ce4_e5b9n) & mask
  value = ((value ^ (value >> 27n)) * 0x94d0_49bb_1331_11ebn) & mask
  return (value ^ (value >> 31n)) & mask
}

function admissionRetryDelayMilliseconds(
  pollIntervalMilliseconds: number,
  ticket: string,
  unchangedRetryCount: number,
): number {
  // Explicit tiny intervals are commonly used by deterministic local callers.
  // Keep them as the upper bound instead of silently stretching their loop.
  const adaptiveLimit = pollIntervalMilliseconds <= smallPollIntervalMilliseconds
    ? pollIntervalMilliseconds
    : Math.max(
      pollIntervalMilliseconds,
      Math.min(
        maximumAdmissionBackoffMilliseconds,
        pollIntervalMilliseconds * maximumAdmissionBackoffMultiplier,
      ),
    )
  const exponent = Math.min(
    unchangedRetryCount,
    Math.ceil(Math.log2(maximumAdmissionBackoffMultiplier)),
  )
  const ceiling = Math.min(
    adaptiveLimit,
    pollIntervalMilliseconds * (2 ** exponent),
  )
  const floor = Math.max(1, Math.ceil(ceiling / 2))
  const width = ceiling - floor + 1
  const offset = Number(
    mixRetrySeed(ticket, unchangedRetryCount) % BigInt(width),
  )
  return floor + offset
}

async function withControlLock<T>(
  directory: string,
  pollIntervalMilliseconds: number,
  signal: AbortSignal | undefined,
  deadline: number,
  callback: () => T,
): Promise<T> {
  const descriptor = openPrivateFile(join(directory, controlFileName))
  let locked = false
  try {
    while (!(locked = tryLockHostResourceDescriptor(descriptor))) {
      await waitForRetry(pollIntervalMilliseconds, signal, deadline)
    }
    throwIfWaitEnded(signal, deadline)
    return callback()
  } catch (cause) {
    if (cause instanceof HostResourceError) throw cause
    throw stateFailure("Host-resource control locking failed.", cause)
  } finally {
    if (locked) {
      try {
        unlockHostResourceDescriptor(descriptor)
      } catch {
        // Closing the descriptor still relinquishes the kernel lock.
      }
    }
    closeSync(descriptor)
  }
}

function normalizedTicketName(ticket: string): string {
  return ticket.padStart(20, "0")
}

function parseMarker(
  name: string,
  source: string,
  profile: HostResourceProfile,
  profileSha256: string,
): MarkerDocument {
  const nameMatch = markerNamePattern.exec(name)
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (cause) {
    throw stateFailure("A live host-resource marker is not valid JSON.", cause)
  }
  if (
    nameMatch === null
    || !isRecord(parsed)
    || !hasExactKeys(parsed, [
      "version",
      "owner",
      "profileSha256",
      "ticket",
      "phase",
      "claims",
    ])
    || parsed.version !== 1
    || typeof parsed.owner !== "string"
    || !ownerIdPattern.test(parsed.owner)
    || typeof parsed.profileSha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(parsed.profileSha256)
    || typeof parsed.ticket !== "string"
    || !ticketPattern.test(parsed.ticket)
    || (parsed.phase !== "A" && parsed.phase !== "W")
    || normalizedTicketName(parsed.ticket) !== nameMatch[1]
    || parsed.owner !== nameMatch[2]
  ) {
    throw stateFailure("A live host-resource marker is malformed.")
  }
  if (parsed.profileSha256 !== profileSha256) {
    throw new HostResourceError(
      "PROFILE_MISMATCH",
      "A live lease belongs to a different host-resource profile.",
    )
  }
  let claims: readonly HostResourceClaim[]
  try {
    claims = normalizeHostResourceClaims(parsed.claims, profile)
  } catch (cause) {
    throw stateFailure("A live host-resource marker has invalid claims.", cause)
  }
  const marker: MarkerDocument = {
    version: 1,
    owner: parsed.owner,
    profileSha256: parsed.profileSha256,
    ticket: parsed.ticket,
    phase: parsed.phase,
    claims,
  }
  if (markerJson(marker) !== source) {
    throw stateFailure("A live host-resource marker is not normalized.")
  }
  return marker
}

function unlinkExactMarker(path: string, markerIdentity: MarkerIdentity): void {
  const published = lstatSync(path)
  if (!privateRegularFile(published) || !sameIdentity(markerIdentity, published)) {
    throw new HostResourceError(
      "OWNERSHIP_LOST",
      "Host-resource marker identity changed before cleanup.",
    )
  }
  unlinkSync(path)
}

function removeTemporaryFile(path: string): void {
  const descriptor = openPrivateFile(path)
  try {
    const opened = fstatSync(descriptor)
    const published = lstatSync(path)
    if (opened.dev !== published.dev || opened.ino !== published.ino) {
      throw stateFailure("Host-resource temporary state changed identity.")
    }
    unlinkSync(path)
  } finally {
    closeSync(descriptor)
  }
}

function scanLiveMarkers(
  directory: string,
  profile: HostResourceProfile,
  profileSha256: string,
): readonly LiveMarker[] {
  const entries = readdirSync(directory, { withFileTypes: true })
  if (entries.length > maximumDirectoryEntries) {
    throw stateFailure("Host-resource state contains too many entries.")
  }
  const live: LiveMarker[] = []
  const tickets = new Set<string>()
  const owners = new Set<string>()
  for (const entry of entries) {
    if (
      entry.name === controlFileName
      || entry.name === stateFileName
      || entry.name === initializedFileName
    ) continue
    const path = join(directory, entry.name)
    if (temporaryNamePattern.test(entry.name)) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw stateFailure("Host-resource temporary state is unsafe.")
      }
      removeTemporaryFile(path)
      continue
    }
    if (!markerNamePattern.test(entry.name)) {
      throw stateFailure("Host-resource state contains an unknown entry.")
    }
    const descriptor = openPrivateFile(path)
    let locked = false
    try {
      const opened = fstatSync(descriptor)
      const markerIdentity = identity(opened)
      locked = tryLockHostResourceDescriptor(descriptor)
      if (locked) {
        // An unlocked marker has no live descriptor owner. The kernel lock is
        // the sole liveness fact; PIDs and timestamps are deliberately absent.
        unlinkExactMarker(path, markerIdentity)
        continue
      }
      const document = parseMarker(
        entry.name,
        readDescriptor(descriptor),
        profile,
        profileSha256,
      )
      if (tickets.has(document.ticket) || owners.has(document.owner)) {
        throw stateFailure("Live host-resource marker identity is duplicated.")
      }
      tickets.add(document.ticket)
      owners.add(document.owner)
      live.push({
        document,
        identity: markerIdentity,
        name: entry.name,
        path,
      })
    } finally {
      if (locked) {
        try {
          unlockHostResourceDescriptor(descriptor)
        } catch {
          // Close remains the authoritative release.
        }
      }
      closeSync(descriptor)
    }
  }
  return live.sort((left, right) => {
    const leftTicket = BigInt(left.document.ticket)
    const rightTicket = BigInt(right.document.ticket)
    return leftTicket < rightTicket ? -1 : leftTicket > rightTicket ? 1 : 0
  })
}

function assertOwnedMarkerIdentity(marker: OwnedMarker): void {
  if (marker.released) {
    throw new HostResourceError(
      "OWNERSHIP_LOST",
      "Host-resource lease is no longer active.",
    )
  }
  let held: Stats
  let published: Stats
  try {
    held = fstatSync(marker.descriptor)
    published = lstatSync(marker.path)
  } catch (cause) {
    throw new HostResourceError(
      "OWNERSHIP_LOST",
      "Host-resource marker is no longer reachable.",
      cause,
    )
  }
  if (
    !privateRegularFile(held)
    || !privateRegularFile(published)
    || !sameIdentity(marker.identity, held)
    || !sameIdentity(marker.identity, published)
  ) {
    throw new HostResourceError(
      "OWNERSHIP_LOST",
      "Host-resource descriptor no longer owns its published inode.",
    )
  }
}

function publishWaitingMarker(
  directory: string,
  state: StateDocument,
  claims: readonly HostResourceClaim[],
  profileSha256: string,
): OwnedMarker {
  const ticket = reserveTicket(directory, state)
  const owner = randomBytes(16).toString("hex")
  const name = `lease-${normalizedTicketName(ticket)}-${owner}.lock`
  const path = join(directory, name)
  let descriptor: number | undefined
  try {
    descriptor = openPrivateFile(path, true)
    if (!tryLockHostResourceDescriptor(descriptor)) {
      throw stateFailure("A new host-resource marker could not be locked.")
    }
    const document: MarkerDocument = {
      version: 1,
      owner,
      profileSha256,
      ticket,
      phase: "W",
      claims,
    }
    writeDescriptor(descriptor, markerJson(document))
    return {
      descriptor,
      document,
      identity: identity(fstatSync(descriptor)),
      name,
      path,
      released: false,
    }
  } catch (cause) {
    if (descriptor !== undefined) {
      try {
        unlockHostResourceDescriptor(descriptor)
      } catch {
        // Closing remains the authoritative release.
      }
      closeSync(descriptor)
    }
    try {
      unlinkSync(path)
    } catch (cleanupCause) {
      if (!isErrorCode(cleanupCause, "ENOENT")) {
        // A later scanner removes an unlocked unique marker.
      }
    }
    throw cause
  }
}

function sameMarker(left: LiveMarker, right: OwnedMarker): boolean {
  return left.name === right.name
    && left.document.owner === right.document.owner
    && left.document.ticket === right.document.ticket
    && sameIdentity(left.identity, right.identity)
}

function claimsOverlap(
  left: readonly HostResourceClaim[],
  right: readonly HostResourceClaim[],
): boolean {
  const resources = new Set(left.map(({ resource }) => resource))
  return right.some(({ resource }) => resources.has(resource))
}

function canFitClaims(
  profile: HostResourceProfile,
  active: readonly LiveMarker[],
  requested: readonly HostResourceClaim[],
): boolean {
  const used = new Map<string, number>()
  for (const marker of active) {
    for (const claim of marker.document.claims) {
      used.set(claim.resource, (used.get(claim.resource) ?? 0) + claim.amount)
    }
  }
  for (const { resource, limit } of profile.capacities) {
    const current = used.get(resource) ?? 0
    if (current > limit) {
      throw stateFailure("Live host-resource leases exceed the declared profile.")
    }
  }
  return requested.every(({ resource, amount }) => {
    const limit = profile.capacities.find(
      (capacity) => capacity.resource === resource,
    )?.limit
    return limit !== undefined && (used.get(resource) ?? 0) + amount <= limit
  })
}

interface AdmissionAttempt {
  readonly admitted: boolean
  readonly queueState: string
}

function admissionQueueState(
  marker: OwnedMarker,
  live: readonly LiveMarker[],
): string {
  const ticket = BigInt(marker.document.ticket)
  const blockers = live.filter((candidate) => {
    if (sameMarker(candidate, marker)) return false
    if (!claimsOverlap(candidate.document.claims, marker.document.claims)) {
      return false
    }
    return candidate.document.phase === "A"
      || BigInt(candidate.document.ticket) < ticket
  })
  return sha256(blockers.map((candidate) => (
    `${candidate.name}\0${markerJson(candidate.document)}`
  )).join("\n"))
}

function attemptAdmission(
  marker: OwnedMarker,
  live: readonly LiveMarker[],
  profile: HostResourceProfile,
): AdmissionAttempt {
  assertOwnedMarkerIdentity(marker)
  const current = live.find((candidate) => sameMarker(candidate, marker))
  if (
    current === undefined
    || current.document.phase !== marker.document.phase
    || markerJson(current.document) !== markerJson(marker.document)
  ) {
    throw new HostResourceError(
      "OWNERSHIP_LOST",
      "Host-resource lease marker no longer matches its descriptor.",
    )
  }
  const ticket = BigInt(marker.document.ticket)
  const earlierOverlap = live.some((candidate) => (
    candidate.document.phase === "W"
    && BigInt(candidate.document.ticket) < ticket
    && claimsOverlap(candidate.document.claims, marker.document.claims)
  ))
  if (earlierOverlap) {
    return {
      admitted: false,
      queueState: admissionQueueState(marker, live),
    }
  }
  const active = live.filter((candidate) => candidate.document.phase === "A")
  if (!canFitClaims(profile, active, marker.document.claims)) {
    return {
      admitted: false,
      queueState: admissionQueueState(marker, live),
    }
  }
  const admitted: MarkerDocument = { ...marker.document, phase: "A" }
  writeDescriptor(marker.descriptor, markerJson(admitted))
  marker.document = admitted
  return { admitted: true, queueState: "" }
}

function markerMatchesOwnedActive(
  candidate: LiveMarker,
  marker: OwnedMarker,
): boolean {
  return sameMarker(candidate, marker)
    && candidate.document.phase === "A"
    && marker.document.phase === "A"
    && markerJson(candidate.document) === markerJson(marker.document)
}

async function admitMarker(
  marker: OwnedMarker,
  root: string,
  options: ResolvedCoordinatorOptions,
  signal: AbortSignal | undefined,
  deadline: number,
  state: () => StateDocument,
): Promise<void> {
  let previousQueueState: string | undefined
  let unchangedRetryCount = 0
  for (;;) {
    const attempt = await withControlLock(
      root,
      options.pollIntervalMilliseconds,
      signal,
      deadline,
      () => {
        const currentState = state()
        assertMatchingProfile(currentState, options.profile)
        const live = scanLiveMarkers(
          root,
          options.profile,
          options.profileSha256,
        )
        return attemptAdmission(marker, live, options.profile)
      },
    )
    if (attempt.admitted) return
    // The durable earlier-ticket marker remains the FIFO authority. Backoff
    // only changes when this candidate rechecks it, and relevant marker
    // progress restores the initial responsive interval without a watcher.
    if (attempt.queueState === previousQueueState) {
      unchangedRetryCount += 1
    } else {
      previousQueueState = attempt.queueState
      unchangedRetryCount = 0
    }
    await waitForRetry(
      admissionRetryDelayMilliseconds(
        options.pollIntervalMilliseconds,
        marker.document.ticket,
        unchangedRetryCount,
      ),
      signal,
      deadline,
    )
  }
}

async function assertMarkerOwned(
  marker: OwnedMarker,
  root: string,
  options: ResolvedCoordinatorOptions,
  state: () => StateDocument,
): Promise<void> {
  assertOwnedMarkerIdentity(marker)
  const deadline = performance.now() + options.waitTimeoutMilliseconds
  await withControlLock(
    root,
    options.pollIntervalMilliseconds,
    undefined,
    deadline,
    () => {
      const currentState = state()
      assertMatchingProfile(currentState, options.profile)
      const live = scanLiveMarkers(
        root,
        options.profile,
        options.profileSha256,
      )
      if (!live.some((candidate) => markerMatchesOwnedActive(candidate, marker))) {
        throw new HostResourceError(
          "OWNERSHIP_LOST",
          "Host-resource lease is not backed by its exact active kernel lock.",
        )
      }
    },
  )
}

async function releaseMarker(
  marker: OwnedMarker,
  root: string,
  options: ResolvedCoordinatorOptions,
  state: () => StateDocument,
): Promise<void> {
  if (marker.released) return
  marker.released = true
  try {
    closeSync(marker.descriptor)
  } catch (cause) {
    if (!isErrorCode(cause, "EBADF")) throw cause
  }
  const deadline = performance.now() + options.waitTimeoutMilliseconds
  await withControlLock(
    root,
    options.pollIntervalMilliseconds,
    undefined,
    deadline,
    () => {
      const currentState = state()
      assertMatchingProfile(currentState, options.profile)
      if (metadataOrNull(marker.path) === null) return
      const descriptor = openPrivateFile(marker.path)
      let locked = false
      try {
        const opened = fstatSync(descriptor)
        if (!sameIdentity(marker.identity, opened)) {
          throw new HostResourceError(
            "OWNERSHIP_LOST",
            "Host-resource marker inode changed before release.",
          )
        }
        locked = tryLockHostResourceDescriptor(descriptor)
        if (!locked) {
          // An explicitly inherited descriptor still owns the lease. Keep its
          // active marker visible until the descendant exits; a future scan
          // removes it using the released kernel lock alone.
          return
        }
        unlinkExactMarker(marker.path, marker.identity)
      } finally {
        if (locked) {
          try {
            unlockHostResourceDescriptor(descriptor)
          } catch {
            // Close remains the authoritative release.
          }
        }
        closeSync(descriptor)
      }
    },
  )
}

function resolveCoordinatorOptions(
  options: HostResourceCoordinatorOptions,
): ResolvedCoordinatorOptions {
  if (!isHostResourcePlatformSupported(process.platform)) {
    throw new HostResourceError(
      "UNSUPPORTED_PLATFORM",
      "Atet host-resource coordination requires Darwin or Linux.",
    )
  }
  const profile = normalizeHostResourceProfile(
    options.profile ?? defaultAtetHostResourceProfile(),
  )
  const stateRoot = options.stateRoot
    ?? defaultAtetHostResourceStateRoot()
  if (
    typeof stateRoot !== "string"
    || !isAbsolute(stateRoot)
    || stateRoot.includes("\0")
    || Buffer.byteLength(stateRoot, "utf8") > maximumPathBytes
  ) {
    throw stateFailure("Host-resource state root must be a bounded absolute path.")
  }
  return {
    pollIntervalMilliseconds: duration(
      options.pollIntervalMilliseconds,
      defaultPollIntervalMilliseconds,
      1_000,
      "INVALID_PROFILE",
      "Host-resource poll interval",
    ),
    profile,
    profileSha256: sha256(canonicalProfile(profile)),
    stateRoot,
    waitTimeoutMilliseconds: duration(
      options.waitTimeoutMilliseconds,
      defaultWaitTimeoutMilliseconds,
      HOST_RESOURCE_MAX_WAIT_MILLISECONDS,
      "INVALID_PROFILE",
      "Host-resource wait timeout",
    ),
  }
}

export function createHostResourceCoordinator(
  coordinatorOptions: HostResourceCoordinatorOptions = {},
): HostResourceCoordinator {
  const options = resolveCoordinatorOptions(coordinatorOptions)
  let resolvedRoot: ResolvedStateRoot | undefined

  const root = (): string => {
    if (resolvedRoot === undefined) {
      resolvedRoot = ensureStateRoot(options.stateRoot)
    }
    return resolvedRoot.path
  }

  const state = (): StateDocument => {
    return readState(root(), options.profile)
  }

  const coordinator: HostResourceCoordinator = {
    profile: options.profile,
    scope: "machine",
    async withLease<T>(
      claimValue: readonly HostResourceClaim[],
      callback: (lease: HostResourceLease) => T | Promise<T>,
      leaseOptions: HostResourceLeaseOptions = {},
    ): Promise<T> {
      const claims = normalizeHostResourceClaims(claimValue, options.profile)
      if (typeof callback !== "function") {
        throw new HostResourceError(
          "INVALID_CLAIMS",
          "Host-resource lease callback must be a function.",
        )
      }
      const waitTimeoutMilliseconds = duration(
        leaseOptions.waitTimeoutMilliseconds,
        options.waitTimeoutMilliseconds,
        HOST_RESOURCE_MAX_WAIT_MILLISECONDS,
        "INVALID_CLAIMS",
        "Host-resource lease wait timeout",
      )
      const signal = leaseOptions.signal
      const deadline = performance.now() + waitTimeoutMilliseconds
      throwIfWaitEnded(signal, deadline)
      const directory = root()
      let marker: OwnedMarker | undefined
      let callbackSettledSuccessfully = false
      let callbackResult!: T
      let callbackFailure: unknown
      try {
        marker = await withControlLock(
          directory,
          options.pollIntervalMilliseconds,
          signal,
          deadline,
          () => {
            const currentState = state()
            assertMatchingProfile(currentState, options.profile)
            scanLiveMarkers(directory, options.profile, options.profileSha256)
            return publishWaitingMarker(
              directory,
              currentState,
              claims,
              options.profileSha256,
            )
          },
        )
        await admitMarker(
          marker,
          directory,
          options,
          signal,
          deadline,
          state,
        )
        const ownedMarker = marker
        const lease: HostResourceLease = Object.freeze({
          claims,
          inheritedFileDescriptor: ownedMarker.descriptor,
          profile: options.profile,
          ticket: ownedMarker.document.ticket,
          assertOwned: async (): Promise<void> => {
            await assertMarkerOwned(ownedMarker, directory, options, state)
          },
        })
        await lease.assertOwned()
        try {
          callbackResult = await callback(lease)
          callbackSettledSuccessfully = true
          // Detect callback-local descriptor/path misuse while the exact owner
          // is still available. External cancellation never releases capacity
          // until this callback has settled.
          await lease.assertOwned()
        } catch (cause) {
          callbackFailure = cause
        }
      } finally {
        if (marker !== undefined) {
          try {
            await releaseMarker(marker, directory, options, state)
          } catch (releaseFailure) {
            if (callbackFailure === undefined) callbackFailure = releaseFailure
          }
        }
      }
      if (!callbackSettledSuccessfully || callbackFailure !== undefined) {
        throw callbackFailure
      }
      return callbackResult
    },
  }
  return Object.freeze(coordinator)
}

interface ProcessLocalRequest<T> {
  readonly callback: (lease: HostResourceLease) => T | Promise<T>
  readonly claims: readonly HostResourceClaim[]
  readonly reject: (cause: unknown) => void
  readonly resolve: (value: T) => void
  readonly signal: AbortSignal | undefined
  readonly ticket: string
  abortListener?: () => void
  active: boolean
  descriptor?: number
  settled: boolean
  timeout?: ReturnType<typeof setTimeout>
}

interface ProcessLocalCoordinatorState {
  readonly active: Map<string, ProcessLocalRequest<unknown>>
  nextTicket: bigint
  readonly waiting: ProcessLocalRequest<unknown>[]
}

const processLocalCoordinatorStates = new Map<
  string,
  ProcessLocalCoordinatorState
>()

export function createProcessLocalHostResourceCoordinator(
  coordinatorOptions: Omit<HostResourceCoordinatorOptions, "stateRoot"> = {},
): HostResourceCoordinator {
  const profile = normalizeHostResourceProfile(
    coordinatorOptions.profile ?? defaultAtetHostResourceProfile(),
  )
  const defaultWait = duration(
    coordinatorOptions.waitTimeoutMilliseconds,
    defaultWaitTimeoutMilliseconds,
    HOST_RESOURCE_MAX_WAIT_MILLISECONDS,
    "INVALID_PROFILE",
    "Host-resource wait timeout",
  )
  if (coordinatorOptions.pollIntervalMilliseconds !== undefined) {
    duration(
      coordinatorOptions.pollIntervalMilliseconds,
      defaultPollIntervalMilliseconds,
      1_000,
      "INVALID_PROFILE",
      "Host-resource poll interval",
    )
  }
  const stateKey = canonicalProfile(profile)
  let localState = processLocalCoordinatorStates.get(stateKey)
  if (localState === undefined) {
    if (processLocalCoordinatorStates.size >= maximumProcessLocalProfiles) {
      throw new HostResourceError(
        "INVALID_PROFILE",
        "This process already coordinates the maximum number of host-resource profiles.",
      )
    }
    localState = {
      active: new Map<string, ProcessLocalRequest<unknown>>(),
      nextTicket: 1n,
      waiting: [],
    }
    processLocalCoordinatorStates.set(stateKey, localState)
  }
  const { active, waiting } = localState

  const removeWaitHooks = (request: ProcessLocalRequest<unknown>): void => {
    if (request.timeout !== undefined) clearTimeout(request.timeout)
    if (request.abortListener !== undefined) {
      request.signal?.removeEventListener("abort", request.abortListener)
    }
  }

  const activeMarkers = (): readonly LiveMarker[] => [...active.values()].map(
    (request) => ({
      document: {
        version: 1,
        owner: request.ticket.padStart(32, "0").slice(-32),
        profileSha256: sha256(canonicalProfile(profile)),
        ticket: request.ticket,
        phase: "A",
        claims: request.claims,
      },
      identity: { device: 0, inode: 0 },
      name: request.ticket,
      path: "",
    }),
  )

  const pump = (): void => {
    for (let index = 0; index < waiting.length;) {
      const request = waiting[index]
      if (request === undefined) break
      const earlierOverlap = waiting.slice(0, index).some((earlier) =>
        claimsOverlap(earlier.claims, request.claims))
      if (
        earlierOverlap
        || !canFitClaims(profile, activeMarkers(), request.claims)
      ) {
        index += 1
        continue
      }
      waiting.splice(index, 1)
      removeWaitHooks(request)
      let descriptor: number
      try {
        descriptor = openSync(
          process.platform === "win32" ? "NUL" : "/dev/null",
          constants.O_RDONLY,
        )
      } catch (cause) {
        request.settled = true
        request.reject(new HostResourceError(
          "UNSAFE_STATE",
          "Process-local host-resource admission could not open its lease descriptor.",
          cause,
        ))
        continue
      }
      request.active = true
      active.set(request.ticket, request)
      request.descriptor = descriptor
      const assertOwned = async (): Promise<void> => {
        if (
          request.settled
          || !request.active
          || active.get(request.ticket) !== request
          || request.descriptor !== descriptor
        ) {
          throw new HostResourceError(
            "OWNERSHIP_LOST",
            "Process-local host-resource lease is no longer active.",
          )
        }
        try {
          fstatSync(descriptor)
        } catch (cause) {
          throw new HostResourceError(
            "OWNERSHIP_LOST",
            "Process-local host-resource descriptor is no longer open.",
            cause,
          )
        }
      }
      const lease: HostResourceLease = Object.freeze({
        assertOwned,
        claims: request.claims,
        inheritedFileDescriptor: descriptor,
        profile,
        ticket: request.ticket,
      })
      void (async () => {
        let succeeded = false
        let result: unknown
        let failure: unknown
        try {
          await lease.assertOwned()
          result = await request.callback(lease)
          await lease.assertOwned()
          succeeded = true
        } catch (cause) {
          failure = cause
        } finally {
          request.active = false
          request.settled = true
          active.delete(request.ticket)
          try {
            closeSync(descriptor)
          } catch (cause) {
            if (failure === undefined) failure = cause
          }
          pump()
        }
        if (succeeded && failure === undefined) request.resolve(result)
        else request.reject(failure)
      })()
    }
  }

  const coordinator: HostResourceCoordinator = {
    profile,
    scope: "process",
    async withLease<T>(
      claimValue: readonly HostResourceClaim[],
      callback: (lease: HostResourceLease) => T | Promise<T>,
      leaseOptions: HostResourceLeaseOptions = {},
    ): Promise<T> {
      const claims = normalizeHostResourceClaims(claimValue, profile)
      if (typeof callback !== "function") {
        return Promise.reject(new HostResourceError(
          "INVALID_CLAIMS",
          "Host-resource lease callback must be a function.",
        ))
      }
      if (localState.nextTicket > maximumTicket) {
        return Promise.reject(stateFailure("Host-resource tickets are exhausted."))
      }
      const waitTimeoutMilliseconds = duration(
        leaseOptions.waitTimeoutMilliseconds,
        defaultWait,
        HOST_RESOURCE_MAX_WAIT_MILLISECONDS,
        "INVALID_CLAIMS",
        "Host-resource lease wait timeout",
      )
      const ticket = String(localState.nextTicket)
      localState.nextTicket += 1n
      return await new Promise<T>((resolve, reject) => {
        const request: ProcessLocalRequest<T> = {
          active: false,
          callback,
          claims,
          reject,
          resolve,
          settled: false,
          signal: leaseOptions.signal,
          ticket,
        }
        const removeWaiting = (cause: HostResourceError): void => {
          if (request.active || request.settled) return
          request.settled = true
          const index = waiting.indexOf(request as ProcessLocalRequest<unknown>)
          if (index >= 0) waiting.splice(index, 1)
          removeWaitHooks(request as ProcessLocalRequest<unknown>)
          reject(cause)
          pump()
        }
        request.abortListener = () => removeWaiting(new HostResourceError(
          "WAIT_ABORTED",
          "Host-resource admission was cancelled before execution.",
        ))
        request.timeout = setTimeout(
          () => removeWaiting(new HostResourceError(
            "WAIT_TIMEOUT",
            "Host-resource admission exceeded its bounded wait.",
          )),
          waitTimeoutMilliseconds,
        )
        request.timeout.unref?.()
        leaseOptions.signal?.addEventListener("abort", request.abortListener, {
          once: true,
        })
        if (leaseOptions.signal?.aborted === true) {
          request.abortListener()
          return
        }
        waiting.push(request as ProcessLocalRequest<unknown>)
        pump()
      })
    },
  }
  return Object.freeze(coordinator)
}

export function createDefaultHostResourceCoordinator(
  options: HostResourceCoordinatorOptions = {},
  platform: NodeJS.Platform = process.platform,
): HostResourceCoordinator {
  if (isHostResourcePlatformSupported(platform)) {
    return createHostResourceCoordinator(options)
  }
  const {
    profile,
    pollIntervalMilliseconds,
    waitTimeoutMilliseconds,
  } = options
  return createProcessLocalHostResourceCoordinator({
    ...(profile === undefined ? {} : { profile }),
    ...(pollIntervalMilliseconds === undefined
      ? {}
      : { pollIntervalMilliseconds }),
    ...(waitTimeoutMilliseconds === undefined
      ? {}
      : { waitTimeoutMilliseconds }),
  })
}
