// @bun
// src/host-resources.ts
import { createHash, randomBytes } from "crypto";
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
  writeSync
} from "fs";
import { availableParallelism, homedir } from "os";
import { isAbsolute, join } from "path";
import { performance } from "perf_hooks";

// src/host-resource-posix.ts
import { readFileSync } from "fs";
import { createRequire } from "module";
var lockExclusive = 2;
var lockNonblocking = 4;
var lockUnlock = 8;
var interruptedErrno = 4;
var nativeLocking;
var nativeLibraries = [];
var runtimeRequire = createRequire(import.meta.url);
function bunFfi() {
  return runtimeRequire("bun:ffi");
}
function mappedLinuxLibcCandidates(processMaps, architecture = process.arch) {
  const candidates = [];
  const append = (candidate) => {
    if (!candidates.includes(candidate))
      candidates.push(candidate);
  };
  for (const line of processMaps.split(`
`)) {
    const pathStart = line.indexOf("/");
    if (pathStart < 0 || line.endsWith(" (deleted)"))
      continue;
    const path = line.slice(pathStart).replace(/\\([0-7]{3})/gu, (_match, octal) => String.fromCodePoint(Number.parseInt(octal, 8)));
    if (/\/(?:libc(?:-[^/]+)?\.so(?:\.[0-9]+)*|libc\.musl-[^/]+\.so(?:\.[0-9]+)*|ld-musl-[^/]+\.so(?:\.[0-9]+)*)$/u.test(path)) {
      append(path);
    }
  }
  append("libc.so.6");
  if (architecture === "x64")
    append("/lib/ld-musl-x86_64.so.1");
  if (architecture === "arm64")
    append("/lib/ld-musl-aarch64.so.1");
  return candidates;
}
function linuxLibcCandidates() {
  try {
    return mappedLinuxLibcCandidates(readFileSync("/proc/self/maps", "utf8"));
  } catch {
    return mappedLinuxLibcCandidates("");
  }
}
function initializeNativeLocking() {
  if (nativeLocking !== undefined)
    return nativeLocking;
  const { dlopen, FFIType, read } = bunFfi();
  if (process.platform === "darwin") {
    const library = dlopen("/usr/lib/libSystem.B.dylib", {
      __error: { args: [], returns: FFIType.ptr },
      flock: {
        args: [FFIType.i32, FFIType.i32],
        returns: FFIType.i32
      }
    });
    nativeLibraries.push(library);
    nativeLocking = {
      errnoLocation: library.symbols.__error,
      flock: library.symbols.flock,
      readInt32: read.i32
    };
    return nativeLocking;
  }
  if (process.platform === "linux") {
    const failures = [];
    for (const candidate of linuxLibcCandidates()) {
      try {
        const library = dlopen(candidate, {
          __errno_location: { args: [], returns: FFIType.ptr },
          flock: {
            args: [FFIType.i32, FFIType.i32],
            returns: FFIType.i32
          }
        });
        nativeLibraries.push(library);
        nativeLocking = {
          errnoLocation: library.symbols.__errno_location,
          flock: library.symbols.flock,
          readInt32: read.i32
        };
        return nativeLocking;
      } catch (cause) {
        failures.push(`${candidate}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    throw new Error("Transmute could not load host flock support" + ` (${failures.join("; ")}).`);
  }
  throw new Error(`Transmute host-resource coordination is unsupported on ${process.platform}.`);
}
function currentErrno(locking) {
  const pointer = locking.errnoLocation();
  if (pointer === null) {
    throw new Error("Transmute could not read the host flock error.");
  }
  return locking.readInt32(pointer);
}
function isBusyErrno(errno) {
  return process.platform === "darwin" ? errno === 35 : errno === 11;
}
var transmuteHostResourcePlatforms = Object.freeze([
  "darwin",
  "linux"
]);
function isHostResourcePlatformSupported(platform) {
  return transmuteHostResourcePlatforms.some((candidate) => candidate === platform);
}
function tryLockHostResourceDescriptor(descriptor) {
  const locking = initializeNativeLocking();
  for (;; ) {
    if (locking.flock(descriptor, lockExclusive | lockNonblocking) === 0) {
      return true;
    }
    const errno = currentErrno(locking);
    if (errno === interruptedErrno)
      continue;
    if (isBusyErrno(errno))
      return false;
    throw new Error(`Transmute host-resource flock failed with errno ${errno}.`);
  }
}
function unlockHostResourceDescriptor(descriptor) {
  const locking = initializeNativeLocking();
  for (;; ) {
    if (locking.flock(descriptor, lockUnlock) === 0)
      return;
    const errno = currentErrno(locking);
    if (errno === interruptedErrno)
      continue;
    throw new Error(`Transmute host-resource unlock failed with errno ${errno}.`);
  }
}

// src/host-resources.ts
var profileIdPattern = /^[a-z0-9][a-z0-9._/-]{0,119}$/u;
var resourceNamePattern = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
var ownerIdPattern = /^[0-9a-f]{32}$/u;
var ticketPattern = /^[1-9][0-9]{0,19}$/u;
var markerNamePattern = /^lease-([0-9]{20})-([0-9a-f]{32})\.lock$/u;
var temporaryNamePattern = /^\.host-resources-[0-9a-f]{32}\.tmp$/u;
var stateFileName = "state.json";
var controlFileName = "control.lock";
var initializedFileName = "initialized.lock";
var maximumResources = 64;
var maximumProcessLocalProfiles = 64;
var maximumDirectoryEntries = 1024;
var maximumFileBytes = 64 * 1024;
var maximumPathBytes = 4096;
var maximumResourceAmount = 1e6;
var maximumTicket = 0xffff_ffff_ffff_ffffn;
var defaultPollIntervalMilliseconds = 25;
var defaultWaitTimeoutMilliseconds = 35000;
var maximumAdmissionBackoffMilliseconds = 250;
var smallPollIntervalMilliseconds = 4;
var maximumAdmissionBackoffMultiplier = 8;
var HOST_RESOURCE_MAX_WAIT_MILLISECONDS = 24 * 60 * 60000;
var transmuteHostResourceNames = Object.freeze([
  "cpu",
  "local-io",
  "ffmpeg",
  "video-encode",
  "vision",
  "whisper",
  "network",
  "paid-call",
  "browser",
  "capture-device"
]);

class HostResourceError extends Error {
  code;
  constructor(code, message, cause) {
    super(`[${code}] ${message}`, cause === undefined ? undefined : { cause });
    this.name = "HostResourceError";
    this.code = code;
  }
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const normalizedExpected = [...expected].sort();
  return actual.length === normalizedExpected.length && actual.every((key, index) => key === normalizedExpected[index]);
}
function boundedPositiveInteger(value, maximum) {
  return Number.isSafeInteger(value) && value >= 1 && value <= maximum;
}
function deepFreeze(value) {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value))
    deepFreeze(nested);
  return Object.freeze(value);
}
function resourceEntries(value, amountKey, errorCode) {
  const minimumEntries = errorCode === "INVALID_CLAIMS" ? 0 : 1;
  if (!Array.isArray(value) || value.length < minimumEntries || value.length > maximumResources) {
    throw new HostResourceError(errorCode, `Host-resource ${amountKey === "limit" ? "capacities" : "claims"} must contain ${minimumEntries} through ${maximumResources} entries.`);
  }
  const seen = new Set;
  const result = value.map((candidate) => {
    if (!isRecord(candidate) || !hasExactKeys(candidate, ["resource", amountKey]) || typeof candidate.resource !== "string" || !resourceNamePattern.test(candidate.resource) || !boundedPositiveInteger(candidate[amountKey], maximumResourceAmount) || seen.has(candidate.resource)) {
      throw new HostResourceError(errorCode, `Host-resource ${amountKey === "limit" ? "capacities" : "claims"} are malformed or duplicated.`);
    }
    seen.add(candidate.resource);
    return { resource: candidate.resource, value: candidate[amountKey] };
  });
  return result.sort((left, right) => left.resource < right.resource ? -1 : left.resource > right.resource ? 1 : 0);
}
function normalizeHostResourceProfile(value) {
  if (!isRecord(value) || !hasExactKeys(value, ["id", "capacities"]) || typeof value.id !== "string" || !profileIdPattern.test(value.id)) {
    throw new HostResourceError("INVALID_PROFILE", "Host-resource profile identity is invalid.");
  }
  const capacities = resourceEntries(value.capacities, "limit", "INVALID_PROFILE").map(({ resource, value: limit }) => ({ resource, limit }));
  return deepFreeze({ id: value.id, capacities });
}
function normalizeHostResourceClaims(value, profile) {
  const normalizedProfile = normalizeHostResourceProfile(profile);
  const limits = new Map(normalizedProfile.capacities.map(({ resource, limit }) => [resource, limit]));
  const claims = resourceEntries(value, "amount", "INVALID_CLAIMS").map(({ resource, value: amount }) => {
    const limit = limits.get(resource);
    if (limit === undefined || amount > limit) {
      throw new HostResourceError("INVALID_CLAIMS", `Host-resource claim ${resource} is unavailable or exceeds its profile limit.`);
    }
    return { resource, amount };
  });
  return deepFreeze(claims);
}
function defaultTransmuteHostResourceProfile(hostParallelism = availableParallelism()) {
  if (!boundedPositiveInteger(hostParallelism, maximumResourceAmount)) {
    throw new HostResourceError("INVALID_PROFILE", "Host parallelism must be a positive safe integer.");
  }
  const reserve = hostParallelism >= 6 ? 2 : hostParallelism >= 2 ? 1 : 0;
  return normalizeHostResourceProfile({
    id: "transmute.host-resources/v1",
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
      { resource: "capture-device", limit: 1 }
    ]
  });
}
function defaultTransmuteHostResourceStateRoot(platform = process.platform, environment = process.env, userHome = homedir()) {
  if (!isHostResourcePlatformSupported(platform)) {
    throw new HostResourceError("UNSUPPORTED_PLATFORM", "Transmute host-resource coordination requires Darwin or Linux.");
  }
  if (platform === "darwin") {
    return join(userHome, "Library", "Application Support", "Transmute", "cli", "host-resources-v1");
  }
  const configuredStateHome = environment.XDG_STATE_HOME;
  const stateHome = configuredStateHome !== undefined && isAbsolute(configuredStateHome) ? configuredStateHome : join(userHome, ".local", "state");
  return join(stateHome, "transmute", "host-resources-v1");
}
function canonicalProfile(profile) {
  return JSON.stringify(profile);
}
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function stateFailure(message, cause) {
  return new HostResourceError("UNSAFE_STATE", message, cause);
}
function isErrorCode(value, code) {
  return isRecord(value) && value.code === code;
}
function ownerUid() {
  const uid = process.geteuid?.() ?? process.getuid?.();
  if (uid === undefined)
    throw stateFailure("Host-resource owner identity is unavailable.");
  return uid;
}
function identity(value) {
  return { device: value.dev, inode: value.ino };
}
function sameIdentity(left, right) {
  const device = "device" in right ? right.device : right.dev;
  const inode = "inode" in right ? right.inode : right.ino;
  return left.device === device && left.inode === inode;
}
function privateDirectory(metadata) {
  return metadata.isDirectory() && !metadata.isSymbolicLink() && metadata.uid === ownerUid() && (metadata.mode & 511) === 448;
}
function privateRegularFile(metadata) {
  return metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1 && metadata.uid === ownerUid() && (metadata.mode & 511) === 384;
}
function metadataOrNull(path) {
  try {
    return lstatSync(path);
  } catch (cause) {
    if (isErrorCode(cause, "ENOENT"))
      return null;
    throw cause;
  }
}
function ensureStateRoot(path) {
  if (!isAbsolute(path) || path.includes("\x00") || Buffer.byteLength(path, "utf8") > maximumPathBytes) {
    throw stateFailure("Host-resource state root must be a bounded absolute path.");
  }
  let created = false;
  let metadata = metadataOrNull(path);
  if (metadata === null) {
    try {
      mkdirSync(path, { recursive: true, mode: 448 });
      created = true;
    } catch (cause) {
      if (!isErrorCode(cause, "EEXIST")) {
        throw stateFailure("Host-resource state root could not be created.", cause);
      }
    }
    metadata = lstatSync(path);
    if (created)
      chmodSync(path, 448);
  }
  if (!privateDirectory(metadata)) {
    throw stateFailure("Host-resource state root is not one private owned directory.");
  }
  const canonical = realpathSync(path);
  if (!privateDirectory(statSync(canonical))) {
    throw stateFailure("Host-resource state root canonicalization is unsafe.");
  }
  return { path: canonical };
}
function openPrivateFile(path, exclusive = false) {
  const existing = metadataOrNull(path);
  if (existing !== null && !privateRegularFile(existing)) {
    throw stateFailure("Host-resource state contains an unsafe file.");
  }
  const flags = constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | (exclusive ? constants.O_EXCL : 0);
  const descriptor = openSync(path, flags, 384);
  try {
    fchmodSync(descriptor, 384);
    const opened = fstatSync(descriptor);
    const published = lstatSync(path);
    if (!privateRegularFile(opened) || !privateRegularFile(published) || opened.dev !== published.dev || opened.ino !== published.ino) {
      throw stateFailure("Host-resource file identity changed while opening.");
    }
    return descriptor;
  } catch (cause) {
    closeSync(descriptor);
    throw cause;
  }
}
function readDescriptor(descriptor) {
  const metadata = fstatSync(descriptor);
  if (!privateRegularFile(metadata) || metadata.size > maximumFileBytes) {
    throw stateFailure("Host-resource state file is malformed.");
  }
  const bytes = Buffer.alloc(metadata.size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (count === 0)
      break;
    offset += count;
  }
  if (offset !== bytes.length)
    throw stateFailure("Host-resource state read was incomplete.");
  return bytes.toString("utf8");
}
function writeDescriptor(descriptor, value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > maximumFileBytes) {
    throw stateFailure("Host-resource state write exceeds its bound.");
  }
  ftruncateSync(descriptor, 0);
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (written < 1)
      throw stateFailure("Host-resource state write was incomplete.");
    offset += written;
  }
  fsyncSync(descriptor);
}
function stateJson(state) {
  return JSON.stringify({
    version: state.version,
    profile: state.profile,
    nextTicket: state.nextTicket
  });
}
function markerJson(marker) {
  return JSON.stringify({
    version: marker.version,
    owner: marker.owner,
    profileSha256: marker.profileSha256,
    ticket: marker.ticket,
    phase: marker.phase,
    claims: marker.claims
  });
}
function syncDirectory(directory) {
  const descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!privateDirectory(fstatSync(descriptor))) {
      throw stateFailure("Host-resource state root changed identity.");
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
function atomicWriteState(directory, state) {
  const temporaryName = `.host-resources-${randomBytes(16).toString("hex")}.tmp`;
  const temporaryPath = join(directory, temporaryName);
  const statePath = join(directory, stateFileName);
  let descriptor;
  try {
    descriptor = openPrivateFile(temporaryPath, true);
    writeDescriptor(descriptor, stateJson(state));
    closeSync(descriptor);
    descriptor = undefined;
    const existing = metadataOrNull(statePath);
    if (existing !== null && !privateRegularFile(existing)) {
      throw stateFailure("Host-resource profile state is unsafe.");
    }
    renameSync(temporaryPath, statePath);
    const published = lstatSync(statePath);
    if (!privateRegularFile(published)) {
      throw stateFailure("Host-resource profile state was not published safely.");
    }
    syncDirectory(directory);
  } finally {
    if (descriptor !== undefined)
      closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch (cause) {
      if (!isErrorCode(cause, "ENOENT")) {}
    }
  }
}
function parseState(value) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw stateFailure("Host-resource profile state is not valid JSON.", cause);
  }
  if (!isRecord(parsed) || !hasExactKeys(parsed, ["version", "profile", "nextTicket"]) || parsed.version !== 1 || typeof parsed.nextTicket !== "string" || !ticketPattern.test(parsed.nextTicket)) {
    throw stateFailure("Host-resource profile state is malformed.");
  }
  let profile;
  try {
    profile = normalizeHostResourceProfile(parsed.profile);
  } catch (cause) {
    throw stateFailure("Host-resource profile state is malformed.", cause);
  }
  const nextTicket = BigInt(parsed.nextTicket);
  if (nextTicket > maximumTicket + 1n) {
    throw stateFailure("Host-resource ticket state exceeds its bound.");
  }
  const state = {
    version: 1,
    profile,
    nextTicket: parsed.nextTicket
  };
  if (stateJson(state) !== value) {
    throw stateFailure("Host-resource profile state is not normalized.");
  }
  return state;
}
function readState(directory, profile) {
  const path = join(directory, stateFileName);
  const initializedPath = join(directory, initializedFileName);
  if (metadataOrNull(path) === null) {
    if (metadataOrNull(initializedPath) !== null || readdirSync(directory).some((name) => markerNamePattern.test(name))) {
      throw stateFailure("Host-resource profile state is missing.");
    }
    const initial = {
      version: 1,
      profile,
      nextTicket: "1"
    };
    atomicWriteState(directory, initial);
    const initialized = openPrivateFile(initializedPath, true);
    closeSync(initialized);
    syncDirectory(directory);
    return initial;
  }
  const descriptor = openPrivateFile(path);
  try {
    const state = parseState(readDescriptor(descriptor));
    const initializedWasMissing = metadataOrNull(initializedPath) === null;
    const initialized = initializedWasMissing ? openPrivateFile(initializedPath, true) : openPrivateFile(initializedPath);
    try {
      if (fstatSync(initialized).size !== 0) {
        throw stateFailure("Host-resource initialization state is malformed.");
      }
    } finally {
      closeSync(initialized);
    }
    if (initializedWasMissing)
      syncDirectory(directory);
    return state;
  } finally {
    closeSync(descriptor);
  }
}
function assertMatchingProfile(state, profile) {
  if (canonicalProfile(state.profile) === canonicalProfile(profile))
    return;
  throw new HostResourceError("PROFILE_MISMATCH", "The machine-global Transmute host-resource profile does not match this process.");
}
function reserveTicket(directory, state) {
  const ticket = BigInt(state.nextTicket);
  if (ticket > maximumTicket) {
    throw stateFailure("Host-resource tickets are exhausted.");
  }
  atomicWriteState(directory, {
    ...state,
    nextTicket: String(ticket + 1n)
  });
  return String(ticket);
}
function duration(value, fallback, maximum, code, label) {
  const resolved = value ?? fallback;
  if (!boundedPositiveInteger(resolved, maximum)) {
    throw new HostResourceError(code, `${label} is outside its supported bound.`);
  }
  return resolved;
}
function throwIfWaitEnded(signal, deadline) {
  if (signal?.aborted === true) {
    throw new HostResourceError("WAIT_ABORTED", "Host-resource admission was cancelled before execution.");
  }
  if (performance.now() >= deadline) {
    throw new HostResourceError("WAIT_TIMEOUT", "Host-resource admission exceeded its bounded wait.");
  }
}
async function waitForRetry(pollIntervalMilliseconds, signal, deadline) {
  throwIfWaitEnded(signal, deadline);
  const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled)
        return;
      settled = true;
      signal?.removeEventListener("abort", cancel);
      resolve();
    };
    const cancel = () => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      reject(new HostResourceError("WAIT_ABORTED", "Host-resource admission was cancelled before execution."));
    };
    const timer = setTimeout(finish, Math.min(pollIntervalMilliseconds, remaining));
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted === true)
      cancel();
  });
  throwIfWaitEnded(signal, deadline);
}
function mixRetrySeed(ticket, retry) {
  const mask = 0xffff_ffff_ffff_ffffn;
  let value = BigInt(ticket) + BigInt(retry + 1) * 0x9e37_79b9_7f4a_7c15n & mask;
  value = (value ^ value >> 30n) * 0xbf58_476d_1ce4_e5b9n & mask;
  value = (value ^ value >> 27n) * 0x94d0_49bb_1331_11ebn & mask;
  return (value ^ value >> 31n) & mask;
}
function admissionRetryDelayMilliseconds(pollIntervalMilliseconds, ticket, unchangedRetryCount) {
  const adaptiveLimit = pollIntervalMilliseconds <= smallPollIntervalMilliseconds ? pollIntervalMilliseconds : Math.max(pollIntervalMilliseconds, Math.min(maximumAdmissionBackoffMilliseconds, pollIntervalMilliseconds * maximumAdmissionBackoffMultiplier));
  const exponent = Math.min(unchangedRetryCount, Math.ceil(Math.log2(maximumAdmissionBackoffMultiplier)));
  const ceiling = Math.min(adaptiveLimit, pollIntervalMilliseconds * 2 ** exponent);
  const floor = Math.max(1, Math.ceil(ceiling / 2));
  const width = ceiling - floor + 1;
  const offset = Number(mixRetrySeed(ticket, unchangedRetryCount) % BigInt(width));
  return floor + offset;
}
async function withControlLock(directory, pollIntervalMilliseconds, signal, deadline, callback) {
  const descriptor = openPrivateFile(join(directory, controlFileName));
  let locked = false;
  try {
    while (!(locked = tryLockHostResourceDescriptor(descriptor))) {
      await waitForRetry(pollIntervalMilliseconds, signal, deadline);
    }
    throwIfWaitEnded(signal, deadline);
    return callback();
  } catch (cause) {
    if (cause instanceof HostResourceError)
      throw cause;
    throw stateFailure("Host-resource control locking failed.", cause);
  } finally {
    if (locked) {
      try {
        unlockHostResourceDescriptor(descriptor);
      } catch {}
    }
    closeSync(descriptor);
  }
}
function normalizedTicketName(ticket) {
  return ticket.padStart(20, "0");
}
function parseMarker(name, source, profile, profileSha256) {
  const nameMatch = markerNamePattern.exec(name);
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw stateFailure("A live host-resource marker is not valid JSON.", cause);
  }
  if (nameMatch === null || !isRecord(parsed) || !hasExactKeys(parsed, [
    "version",
    "owner",
    "profileSha256",
    "ticket",
    "phase",
    "claims"
  ]) || parsed.version !== 1 || typeof parsed.owner !== "string" || !ownerIdPattern.test(parsed.owner) || typeof parsed.profileSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(parsed.profileSha256) || typeof parsed.ticket !== "string" || !ticketPattern.test(parsed.ticket) || parsed.phase !== "A" && parsed.phase !== "W" || normalizedTicketName(parsed.ticket) !== nameMatch[1] || parsed.owner !== nameMatch[2]) {
    throw stateFailure("A live host-resource marker is malformed.");
  }
  if (parsed.profileSha256 !== profileSha256) {
    throw new HostResourceError("PROFILE_MISMATCH", "A live lease belongs to a different host-resource profile.");
  }
  let claims;
  try {
    claims = normalizeHostResourceClaims(parsed.claims, profile);
  } catch (cause) {
    throw stateFailure("A live host-resource marker has invalid claims.", cause);
  }
  const marker = {
    version: 1,
    owner: parsed.owner,
    profileSha256: parsed.profileSha256,
    ticket: parsed.ticket,
    phase: parsed.phase,
    claims
  };
  if (markerJson(marker) !== source) {
    throw stateFailure("A live host-resource marker is not normalized.");
  }
  return marker;
}
function unlinkExactMarker(path, markerIdentity) {
  const published = lstatSync(path);
  if (!privateRegularFile(published) || !sameIdentity(markerIdentity, published)) {
    throw new HostResourceError("OWNERSHIP_LOST", "Host-resource marker identity changed before cleanup.");
  }
  unlinkSync(path);
}
function removeTemporaryFile(path) {
  const descriptor = openPrivateFile(path);
  try {
    const opened = fstatSync(descriptor);
    const published = lstatSync(path);
    if (opened.dev !== published.dev || opened.ino !== published.ino) {
      throw stateFailure("Host-resource temporary state changed identity.");
    }
    unlinkSync(path);
  } finally {
    closeSync(descriptor);
  }
}
function scanLiveMarkers(directory, profile, profileSha256) {
  const entries = readdirSync(directory, { withFileTypes: true });
  if (entries.length > maximumDirectoryEntries) {
    throw stateFailure("Host-resource state contains too many entries.");
  }
  const live = [];
  const tickets = new Set;
  const owners = new Set;
  for (const entry of entries) {
    if (entry.name === controlFileName || entry.name === stateFileName || entry.name === initializedFileName)
      continue;
    const path = join(directory, entry.name);
    if (temporaryNamePattern.test(entry.name)) {
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw stateFailure("Host-resource temporary state is unsafe.");
      }
      removeTemporaryFile(path);
      continue;
    }
    if (!markerNamePattern.test(entry.name)) {
      throw stateFailure("Host-resource state contains an unknown entry.");
    }
    const descriptor = openPrivateFile(path);
    let locked = false;
    try {
      const opened = fstatSync(descriptor);
      const markerIdentity = identity(opened);
      locked = tryLockHostResourceDescriptor(descriptor);
      if (locked) {
        unlinkExactMarker(path, markerIdentity);
        continue;
      }
      const document = parseMarker(entry.name, readDescriptor(descriptor), profile, profileSha256);
      if (tickets.has(document.ticket) || owners.has(document.owner)) {
        throw stateFailure("Live host-resource marker identity is duplicated.");
      }
      tickets.add(document.ticket);
      owners.add(document.owner);
      live.push({
        document,
        identity: markerIdentity,
        name: entry.name,
        path
      });
    } finally {
      if (locked) {
        try {
          unlockHostResourceDescriptor(descriptor);
        } catch {}
      }
      closeSync(descriptor);
    }
  }
  return live.sort((left, right) => {
    const leftTicket = BigInt(left.document.ticket);
    const rightTicket = BigInt(right.document.ticket);
    return leftTicket < rightTicket ? -1 : leftTicket > rightTicket ? 1 : 0;
  });
}
function assertOwnedMarkerIdentity(marker) {
  if (marker.released) {
    throw new HostResourceError("OWNERSHIP_LOST", "Host-resource lease is no longer active.");
  }
  let held;
  let published;
  try {
    held = fstatSync(marker.descriptor);
    published = lstatSync(marker.path);
  } catch (cause) {
    throw new HostResourceError("OWNERSHIP_LOST", "Host-resource marker is no longer reachable.", cause);
  }
  if (!privateRegularFile(held) || !privateRegularFile(published) || !sameIdentity(marker.identity, held) || !sameIdentity(marker.identity, published)) {
    throw new HostResourceError("OWNERSHIP_LOST", "Host-resource descriptor no longer owns its published inode.");
  }
}
function publishWaitingMarker(directory, state, claims, profileSha256) {
  const ticket = reserveTicket(directory, state);
  const owner = randomBytes(16).toString("hex");
  const name = `lease-${normalizedTicketName(ticket)}-${owner}.lock`;
  const path = join(directory, name);
  let descriptor;
  try {
    descriptor = openPrivateFile(path, true);
    if (!tryLockHostResourceDescriptor(descriptor)) {
      throw stateFailure("A new host-resource marker could not be locked.");
    }
    const document = {
      version: 1,
      owner,
      profileSha256,
      ticket,
      phase: "W",
      claims
    };
    writeDescriptor(descriptor, markerJson(document));
    return {
      descriptor,
      document,
      identity: identity(fstatSync(descriptor)),
      name,
      path,
      released: false
    };
  } catch (cause) {
    if (descriptor !== undefined) {
      try {
        unlockHostResourceDescriptor(descriptor);
      } catch {}
      closeSync(descriptor);
    }
    try {
      unlinkSync(path);
    } catch (cleanupCause) {
      if (!isErrorCode(cleanupCause, "ENOENT")) {}
    }
    throw cause;
  }
}
function sameMarker(left, right) {
  return left.name === right.name && left.document.owner === right.document.owner && left.document.ticket === right.document.ticket && sameIdentity(left.identity, right.identity);
}
function claimsOverlap(left, right) {
  const resources = new Set(left.map(({ resource }) => resource));
  return right.some(({ resource }) => resources.has(resource));
}
function canFitClaims(profile, active, requested) {
  const used = new Map;
  for (const marker of active) {
    for (const claim of marker.document.claims) {
      used.set(claim.resource, (used.get(claim.resource) ?? 0) + claim.amount);
    }
  }
  for (const { resource, limit } of profile.capacities) {
    const current = used.get(resource) ?? 0;
    if (current > limit) {
      throw stateFailure("Live host-resource leases exceed the declared profile.");
    }
  }
  return requested.every(({ resource, amount }) => {
    const limit = profile.capacities.find((capacity) => capacity.resource === resource)?.limit;
    return limit !== undefined && (used.get(resource) ?? 0) + amount <= limit;
  });
}
function admissionQueueState(marker, live) {
  const ticket = BigInt(marker.document.ticket);
  const blockers = live.filter((candidate) => {
    if (sameMarker(candidate, marker))
      return false;
    if (!claimsOverlap(candidate.document.claims, marker.document.claims)) {
      return false;
    }
    return candidate.document.phase === "A" || BigInt(candidate.document.ticket) < ticket;
  });
  return sha256(blockers.map((candidate) => `${candidate.name}\x00${markerJson(candidate.document)}`).join(`
`));
}
function attemptAdmission(marker, live, profile) {
  assertOwnedMarkerIdentity(marker);
  const current = live.find((candidate) => sameMarker(candidate, marker));
  if (current === undefined || current.document.phase !== marker.document.phase || markerJson(current.document) !== markerJson(marker.document)) {
    throw new HostResourceError("OWNERSHIP_LOST", "Host-resource lease marker no longer matches its descriptor.");
  }
  const ticket = BigInt(marker.document.ticket);
  const earlierOverlap = live.some((candidate) => candidate.document.phase === "W" && BigInt(candidate.document.ticket) < ticket && claimsOverlap(candidate.document.claims, marker.document.claims));
  if (earlierOverlap) {
    return {
      admitted: false,
      queueState: admissionQueueState(marker, live)
    };
  }
  const active = live.filter((candidate) => candidate.document.phase === "A");
  if (!canFitClaims(profile, active, marker.document.claims)) {
    return {
      admitted: false,
      queueState: admissionQueueState(marker, live)
    };
  }
  const admitted = { ...marker.document, phase: "A" };
  writeDescriptor(marker.descriptor, markerJson(admitted));
  marker.document = admitted;
  return { admitted: true, queueState: "" };
}
function markerMatchesOwnedActive(candidate, marker) {
  return sameMarker(candidate, marker) && candidate.document.phase === "A" && marker.document.phase === "A" && markerJson(candidate.document) === markerJson(marker.document);
}
async function admitMarker(marker, root, options, signal, deadline, state) {
  let previousQueueState;
  let unchangedRetryCount = 0;
  for (;; ) {
    const attempt = await withControlLock(root, options.pollIntervalMilliseconds, signal, deadline, () => {
      const currentState = state();
      assertMatchingProfile(currentState, options.profile);
      const live = scanLiveMarkers(root, options.profile, options.profileSha256);
      return attemptAdmission(marker, live, options.profile);
    });
    if (attempt.admitted)
      return;
    if (attempt.queueState === previousQueueState) {
      unchangedRetryCount += 1;
    } else {
      previousQueueState = attempt.queueState;
      unchangedRetryCount = 0;
    }
    await waitForRetry(admissionRetryDelayMilliseconds(options.pollIntervalMilliseconds, marker.document.ticket, unchangedRetryCount), signal, deadline);
  }
}
async function assertMarkerOwned(marker, root, options, state) {
  assertOwnedMarkerIdentity(marker);
  const deadline = performance.now() + options.waitTimeoutMilliseconds;
  await withControlLock(root, options.pollIntervalMilliseconds, undefined, deadline, () => {
    const currentState = state();
    assertMatchingProfile(currentState, options.profile);
    const live = scanLiveMarkers(root, options.profile, options.profileSha256);
    if (!live.some((candidate) => markerMatchesOwnedActive(candidate, marker))) {
      throw new HostResourceError("OWNERSHIP_LOST", "Host-resource lease is not backed by its exact active kernel lock.");
    }
  });
}
async function releaseMarker(marker, root, options, state) {
  if (marker.released)
    return;
  marker.released = true;
  try {
    closeSync(marker.descriptor);
  } catch (cause) {
    if (!isErrorCode(cause, "EBADF"))
      throw cause;
  }
  const deadline = performance.now() + options.waitTimeoutMilliseconds;
  await withControlLock(root, options.pollIntervalMilliseconds, undefined, deadline, () => {
    const currentState = state();
    assertMatchingProfile(currentState, options.profile);
    if (metadataOrNull(marker.path) === null)
      return;
    const descriptor = openPrivateFile(marker.path);
    let locked = false;
    try {
      const opened = fstatSync(descriptor);
      if (!sameIdentity(marker.identity, opened)) {
        throw new HostResourceError("OWNERSHIP_LOST", "Host-resource marker inode changed before release.");
      }
      locked = tryLockHostResourceDescriptor(descriptor);
      if (!locked) {
        return;
      }
      unlinkExactMarker(marker.path, marker.identity);
    } finally {
      if (locked) {
        try {
          unlockHostResourceDescriptor(descriptor);
        } catch {}
      }
      closeSync(descriptor);
    }
  });
}
function resolveCoordinatorOptions(options) {
  if (!isHostResourcePlatformSupported(process.platform)) {
    throw new HostResourceError("UNSUPPORTED_PLATFORM", "Transmute host-resource coordination requires Darwin or Linux.");
  }
  const profile = normalizeHostResourceProfile(options.profile ?? defaultTransmuteHostResourceProfile());
  const stateRoot = options.stateRoot ?? defaultTransmuteHostResourceStateRoot();
  if (typeof stateRoot !== "string" || !isAbsolute(stateRoot) || stateRoot.includes("\x00") || Buffer.byteLength(stateRoot, "utf8") > maximumPathBytes) {
    throw stateFailure("Host-resource state root must be a bounded absolute path.");
  }
  return {
    pollIntervalMilliseconds: duration(options.pollIntervalMilliseconds, defaultPollIntervalMilliseconds, 1000, "INVALID_PROFILE", "Host-resource poll interval"),
    profile,
    profileSha256: sha256(canonicalProfile(profile)),
    stateRoot,
    waitTimeoutMilliseconds: duration(options.waitTimeoutMilliseconds, defaultWaitTimeoutMilliseconds, HOST_RESOURCE_MAX_WAIT_MILLISECONDS, "INVALID_PROFILE", "Host-resource wait timeout")
  };
}
function createHostResourceCoordinator(coordinatorOptions = {}) {
  const options = resolveCoordinatorOptions(coordinatorOptions);
  let resolvedRoot;
  const root = () => {
    if (resolvedRoot === undefined) {
      resolvedRoot = ensureStateRoot(options.stateRoot);
    }
    return resolvedRoot.path;
  };
  const state = () => {
    return readState(root(), options.profile);
  };
  const coordinator = {
    profile: options.profile,
    scope: "machine",
    async withLease(claimValue, callback, leaseOptions = {}) {
      const claims = normalizeHostResourceClaims(claimValue, options.profile);
      if (typeof callback !== "function") {
        throw new HostResourceError("INVALID_CLAIMS", "Host-resource lease callback must be a function.");
      }
      const waitTimeoutMilliseconds = duration(leaseOptions.waitTimeoutMilliseconds, options.waitTimeoutMilliseconds, HOST_RESOURCE_MAX_WAIT_MILLISECONDS, "INVALID_CLAIMS", "Host-resource lease wait timeout");
      const signal = leaseOptions.signal;
      const deadline = performance.now() + waitTimeoutMilliseconds;
      throwIfWaitEnded(signal, deadline);
      const directory = root();
      let marker;
      let callbackSettledSuccessfully = false;
      let callbackResult;
      let callbackFailure;
      try {
        marker = await withControlLock(directory, options.pollIntervalMilliseconds, signal, deadline, () => {
          const currentState = state();
          assertMatchingProfile(currentState, options.profile);
          scanLiveMarkers(directory, options.profile, options.profileSha256);
          return publishWaitingMarker(directory, currentState, claims, options.profileSha256);
        });
        await admitMarker(marker, directory, options, signal, deadline, state);
        const ownedMarker = marker;
        const lease = Object.freeze({
          claims,
          inheritedFileDescriptor: ownedMarker.descriptor,
          profile: options.profile,
          ticket: ownedMarker.document.ticket,
          assertOwned: async () => {
            await assertMarkerOwned(ownedMarker, directory, options, state);
          }
        });
        await lease.assertOwned();
        try {
          callbackResult = await callback(lease);
          callbackSettledSuccessfully = true;
          await lease.assertOwned();
        } catch (cause) {
          callbackFailure = cause;
        }
      } finally {
        if (marker !== undefined) {
          try {
            await releaseMarker(marker, directory, options, state);
          } catch (releaseFailure) {
            if (callbackFailure === undefined)
              callbackFailure = releaseFailure;
          }
        }
      }
      if (!callbackSettledSuccessfully || callbackFailure !== undefined) {
        throw callbackFailure;
      }
      return callbackResult;
    }
  };
  return Object.freeze(coordinator);
}
var processLocalCoordinatorStates = new Map;
function createProcessLocalHostResourceCoordinator(coordinatorOptions = {}) {
  const profile = normalizeHostResourceProfile(coordinatorOptions.profile ?? defaultTransmuteHostResourceProfile());
  const defaultWait = duration(coordinatorOptions.waitTimeoutMilliseconds, defaultWaitTimeoutMilliseconds, HOST_RESOURCE_MAX_WAIT_MILLISECONDS, "INVALID_PROFILE", "Host-resource wait timeout");
  if (coordinatorOptions.pollIntervalMilliseconds !== undefined) {
    duration(coordinatorOptions.pollIntervalMilliseconds, defaultPollIntervalMilliseconds, 1000, "INVALID_PROFILE", "Host-resource poll interval");
  }
  const stateKey = canonicalProfile(profile);
  let localState = processLocalCoordinatorStates.get(stateKey);
  if (localState === undefined) {
    if (processLocalCoordinatorStates.size >= maximumProcessLocalProfiles) {
      throw new HostResourceError("INVALID_PROFILE", "This process already coordinates the maximum number of host-resource profiles.");
    }
    localState = {
      active: new Map,
      nextTicket: 1n,
      waiting: []
    };
    processLocalCoordinatorStates.set(stateKey, localState);
  }
  const { active, waiting } = localState;
  const removeWaitHooks = (request) => {
    if (request.timeout !== undefined)
      clearTimeout(request.timeout);
    if (request.abortListener !== undefined) {
      request.signal?.removeEventListener("abort", request.abortListener);
    }
  };
  const activeMarkers = () => [...active.values()].map((request) => ({
    document: {
      version: 1,
      owner: request.ticket.padStart(32, "0").slice(-32),
      profileSha256: sha256(canonicalProfile(profile)),
      ticket: request.ticket,
      phase: "A",
      claims: request.claims
    },
    identity: { device: 0, inode: 0 },
    name: request.ticket,
    path: ""
  }));
  const pump = () => {
    for (let index = 0;index < waiting.length; ) {
      const request = waiting[index];
      if (request === undefined)
        break;
      const earlierOverlap = waiting.slice(0, index).some((earlier) => claimsOverlap(earlier.claims, request.claims));
      if (earlierOverlap || !canFitClaims(profile, activeMarkers(), request.claims)) {
        index += 1;
        continue;
      }
      waiting.splice(index, 1);
      removeWaitHooks(request);
      let descriptor;
      try {
        descriptor = openSync(process.platform === "win32" ? "NUL" : "/dev/null", constants.O_RDONLY);
      } catch (cause) {
        request.settled = true;
        request.reject(new HostResourceError("UNSAFE_STATE", "Process-local host-resource admission could not open its lease descriptor.", cause));
        continue;
      }
      request.active = true;
      active.set(request.ticket, request);
      request.descriptor = descriptor;
      const assertOwned = async () => {
        if (request.settled || !request.active || active.get(request.ticket) !== request || request.descriptor !== descriptor) {
          throw new HostResourceError("OWNERSHIP_LOST", "Process-local host-resource lease is no longer active.");
        }
        try {
          fstatSync(descriptor);
        } catch (cause) {
          throw new HostResourceError("OWNERSHIP_LOST", "Process-local host-resource descriptor is no longer open.", cause);
        }
      };
      const lease = Object.freeze({
        assertOwned,
        claims: request.claims,
        inheritedFileDescriptor: descriptor,
        profile,
        ticket: request.ticket
      });
      (async () => {
        let succeeded = false;
        let result;
        let failure;
        try {
          await lease.assertOwned();
          result = await request.callback(lease);
          await lease.assertOwned();
          succeeded = true;
        } catch (cause) {
          failure = cause;
        } finally {
          request.active = false;
          request.settled = true;
          active.delete(request.ticket);
          try {
            closeSync(descriptor);
          } catch (cause) {
            if (failure === undefined)
              failure = cause;
          }
          pump();
        }
        if (succeeded && failure === undefined)
          request.resolve(result);
        else
          request.reject(failure);
      })();
    }
  };
  const coordinator = {
    profile,
    scope: "process",
    async withLease(claimValue, callback, leaseOptions = {}) {
      const claims = normalizeHostResourceClaims(claimValue, profile);
      if (typeof callback !== "function") {
        return Promise.reject(new HostResourceError("INVALID_CLAIMS", "Host-resource lease callback must be a function."));
      }
      if (localState.nextTicket > maximumTicket) {
        return Promise.reject(stateFailure("Host-resource tickets are exhausted."));
      }
      const waitTimeoutMilliseconds = duration(leaseOptions.waitTimeoutMilliseconds, defaultWait, HOST_RESOURCE_MAX_WAIT_MILLISECONDS, "INVALID_CLAIMS", "Host-resource lease wait timeout");
      const ticket = String(localState.nextTicket);
      localState.nextTicket += 1n;
      return await new Promise((resolve, reject) => {
        const request = {
          active: false,
          callback,
          claims,
          reject,
          resolve,
          settled: false,
          signal: leaseOptions.signal,
          ticket
        };
        const removeWaiting = (cause) => {
          if (request.active || request.settled)
            return;
          request.settled = true;
          const index = waiting.indexOf(request);
          if (index >= 0)
            waiting.splice(index, 1);
          removeWaitHooks(request);
          reject(cause);
          pump();
        };
        request.abortListener = () => removeWaiting(new HostResourceError("WAIT_ABORTED", "Host-resource admission was cancelled before execution."));
        request.timeout = setTimeout(() => removeWaiting(new HostResourceError("WAIT_TIMEOUT", "Host-resource admission exceeded its bounded wait.")), waitTimeoutMilliseconds);
        request.timeout.unref?.();
        leaseOptions.signal?.addEventListener("abort", request.abortListener, {
          once: true
        });
        if (leaseOptions.signal?.aborted === true) {
          request.abortListener();
          return;
        }
        waiting.push(request);
        pump();
      });
    }
  };
  return Object.freeze(coordinator);
}
function createDefaultHostResourceCoordinator(options = {}, platform = process.platform) {
  if (isHostResourcePlatformSupported(platform)) {
    return createHostResourceCoordinator(options);
  }
  const {
    profile,
    pollIntervalMilliseconds,
    waitTimeoutMilliseconds
  } = options;
  return createProcessLocalHostResourceCoordinator({
    ...profile === undefined ? {} : { profile },
    ...pollIntervalMilliseconds === undefined ? {} : { pollIntervalMilliseconds },
    ...waitTimeoutMilliseconds === undefined ? {} : { waitTimeoutMilliseconds }
  });
}

export { HOST_RESOURCE_MAX_WAIT_MILLISECONDS, transmuteHostResourceNames, HostResourceError, normalizeHostResourceProfile, normalizeHostResourceClaims, defaultTransmuteHostResourceProfile, defaultTransmuteHostResourceStateRoot, createHostResourceCoordinator, createProcessLocalHostResourceCoordinator, createDefaultHostResourceCoordinator };
