// @bun
import {
  TransmuteCloudError,
  fetchTransmuteDiscovery,
  parseTransmuteDiscovery,
  readBoundedResponseBytes,
  transmuteProductionContract,
  transmuteRedirectUri
} from "./index-yz7y9m2g.js";
import {
  __require
} from "./index-z1w83f81.js";

// src/auth.ts
import { createHash as createHash2, randomBytes as randomBytes2, timingSafeEqual } from "crypto";
import { createServer } from "http";

// src/credential-lease.ts
import { createHash, randomBytes } from "crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readlink,
  readdir,
  unlink
} from "fs/promises";
import { homedir } from "os";
import { isAbsolute, join } from "path";
import { performance } from "perf_hooks";
var choosingMarkerPattern = /^choosing-v4-([0-9a-f]{32})-(\d{1,10})-([0-9a-f]{32})-([0-9a-f]{32})$/u;
var leaseMarkerPattern = /^lease-v4-([0-9a-f]{16})-([0-9a-f]{32})-(\d{1,10})-([0-9a-f]{32})-([0-9a-f]{32})$/u;
var maximumDirectoryEntries = 256;
var defaultWaitMilliseconds = 35000;
var defaultStaleMilliseconds = 30000;
var defaultPollMilliseconds = 50;
var maximumDurationMilliseconds = 5 * 60000;
var maximumPathBytes = 4096;
var maximumTicket = 0xffff_ffff_ffff_ffffn;
var transmuteCredentialMutationPlatforms = Object.freeze([
  "darwin",
  "linux"
]);
function errorCode(purpose) {
  return purpose === "refresh" ? "TOKEN_REFRESH_FAILED" : "TOKEN_STORAGE_FAILED";
}
function defaultFailureMessage(purpose) {
  return purpose === "refresh" ? "Transmute could not safely coordinate a login refresh." : "Transmute could not safely coordinate credential storage.";
}
function leaseFailure(purpose, message = defaultFailureMessage(purpose), cause) {
  return new TransmuteCloudError(errorCode(purpose), message, cause === undefined ? undefined : { cause });
}
function isErrorCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
function isTransmuteCredentialMutationPlatformSupported(platform) {
  return transmuteCredentialMutationPlatforms.some((supported) => supported === platform);
}
function assertTransmuteCredentialMutationPlatformSupported(purpose, platform = process.platform) {
  if (isTransmuteCredentialMutationPlatformSupported(platform))
    return;
  throw leaseFailure(purpose, "Transmute cannot safely mutate shared credentials on this platform.");
}
function duration(value, fallback) {
  if (value === undefined)
    return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximumDurationMilliseconds) {
    throw new TransmuteCloudError("INVALID_ARGUMENT", "Invalid Transmute credential lease configuration.");
  }
  return value;
}
function resolveOptions(dependencies) {
  const configured = dependencies.credentialLease;
  const directory = configured?.directory ?? join(homedir(), ".cache", "hraness-transmute-cli", "credential-lease-v4");
  if (!isAbsolute(directory) || directory.includes("\x00") || Buffer.byteLength(directory, "utf8") > maximumPathBytes) {
    throw new TransmuteCloudError("INVALID_ARGUMENT", "Invalid Transmute credential lease configuration.");
  }
  return {
    directory,
    waitTimeoutMilliseconds: duration(configured?.waitTimeoutMilliseconds, defaultWaitMilliseconds),
    staleAfterMilliseconds: duration(configured?.staleAfterMilliseconds, defaultStaleMilliseconds),
    pollIntervalMilliseconds: duration(configured?.pollIntervalMilliseconds, defaultPollMilliseconds),
    signal: configured?.signal,
    heartbeat: configured?.heartbeat
  };
}
function throwIfCancelled(signal, purpose) {
  if (signal?.aborted !== true)
    return;
  throw leaseFailure(purpose, purpose === "refresh" ? "Transmute login refresh was cancelled." : "Transmute credential mutation was cancelled.");
}
function throwIfTransmuteCredentialMutationCancelled(dependencies, purpose) {
  throwIfCancelled(dependencies.credentialLease?.signal, purpose);
}
async function waitForLease(milliseconds, signal, purpose) {
  throwIfCancelled(signal, purpose);
  await new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      if (timer !== undefined)
        clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    };
    const finish = () => {
      if (settled)
        return;
      settled = true;
      cleanup();
      resolve();
    };
    const cancel = () => {
      if (settled)
        return;
      settled = true;
      cleanup();
      reject(leaseFailure(purpose, purpose === "refresh" ? "Transmute login refresh was cancelled." : "Transmute credential mutation was cancelled."));
    };
    timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted === true)
      cancel();
  });
}
async function prepareDirectory(directory, purpose) {
  try {
    await mkdir(directory, { recursive: true, mode: 448 });
    const details = await lstat(directory);
    const currentUid = credentialOwnerUid();
    if (!details.isDirectory() || details.isSymbolicLink() || details.uid !== currentUid || (details.mode & 63) !== 0) {
      throw leaseFailure(purpose);
    }
  } catch (cause) {
    if (cause instanceof TransmuteCloudError)
      throw cause;
    throw leaseFailure(purpose, undefined, cause);
  }
}
function parsedPid(value) {
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid >= 1 && pid <= 2147483647 ? pid : null;
}
function parseMarkerName(name) {
  const choosing = choosingMarkerPattern.exec(name);
  if (choosing !== null) {
    const processScopeIdentity2 = choosing[1];
    const pidText2 = choosing[2];
    const processIdentity2 = choosing[3];
    const ownerId2 = choosing[4];
    if (processScopeIdentity2 === undefined || pidText2 === undefined || processIdentity2 === undefined || ownerId2 === undefined)
      return null;
    const pid2 = parsedPid(pidText2);
    return pid2 === null ? null : {
      kind: "choosing",
      name,
      processScopeIdentity: processScopeIdentity2,
      pid: pid2,
      processIdentity: processIdentity2,
      ownerId: ownerId2
    };
  }
  const lease = leaseMarkerPattern.exec(name);
  if (lease === null)
    return null;
  const ticketText = lease[1];
  const processScopeIdentity = lease[2];
  const pidText = lease[3];
  const processIdentity = lease[4];
  const ownerId = lease[5];
  if (ticketText === undefined || processScopeIdentity === undefined || pidText === undefined || processIdentity === undefined || ownerId === undefined) {
    return null;
  }
  const pid = parsedPid(pidText);
  if (pid === null)
    return null;
  return {
    kind: "lease",
    name,
    processScopeIdentity,
    pid,
    processIdentity,
    ownerId,
    ticket: BigInt(`0x${ticketText}`)
  };
}
function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return !isErrorCode(cause, "ESRCH");
  }
}
var linuxBootIdPath = "/proc/sys/kernel/random/boot_id";
var linuxMachineIdPaths = ["/etc/machine-id", "/var/lib/dbus/machine-id"];
var maximumProcStatBytes = 8192;
var macProcessInfoFlavor = 3;
var macProcessInfoSize = 136;
var macProcessStartSecondsOffset = 120;
var macProcessStartMicrosecondsOffset = 128;
var macHostUuidBytes = 16;
var macHostUuidWaitSeconds = 1n;
var cachedMacProcessScopeIdentity;
var cachedLinuxHostIdentity;
function processIdentityDigest(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}
async function linuxHostIdentity() {
  if (cachedLinuxHostIdentity !== undefined)
    return cachedLinuxHostIdentity;
  for (const path of linuxMachineIdPaths) {
    try {
      const source = (await readFile(path, "utf8")).trim().toLowerCase();
      if (/^(?!0{32}$)[0-9a-f]{32}$/u.test(source)) {
        cachedLinuxHostIdentity = processIdentityDigest(`linux-host:${source}`);
        return cachedLinuxHostIdentity;
      }
    } catch {}
  }
  return null;
}
async function linuxProcessIdentity(pid) {
  const [bootIdSource, statSource, pidNamespaceSource, hostIdentity] = await Promise.all([
    readFile(linuxBootIdPath, "utf8"),
    readFile(`/proc/${pid}/stat`, "utf8"),
    readlink(`/proc/${pid}/ns/pid`),
    linuxHostIdentity()
  ]);
  if (Buffer.byteLength(bootIdSource, "utf8") > 128 || Buffer.byteLength(statSource, "utf8") > maximumProcStatBytes)
    return null;
  const bootId = bootIdSource.trim().toLowerCase();
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(bootId)) {
    return null;
  }
  if (hostIdentity === null)
    return null;
  if (!/^pid:\[[1-9][0-9]{0,31}\]$/u.test(pidNamespaceSource))
    return null;
  const commandEnd = statSource.lastIndexOf(") ");
  if (commandEnd < 2)
    return null;
  const fields = statSource.slice(commandEnd + 2).trim().split(/\s+/u);
  const startTicks = fields[19];
  if (startTicks === undefined || !/^[1-9][0-9]{0,31}$/u.test(startTicks))
    return null;
  const processScopeIdentity = processIdentityDigest(`linux-pid-namespace:${hostIdentity}:${pidNamespaceSource}`);
  return {
    processScopeIdentity,
    value: processIdentityDigest(`linux-process:${processScopeIdentity}:${startTicks}`)
  };
}
async function macProcessIdentity(pid) {
  const { dlopen, ptr } = await import("bun:ffi");
  const library = dlopen("/usr/lib/libproc.dylib", {
    proc_pidinfo: {
      args: ["i32", "i32", "u64", "ptr", "i32"],
      returns: "i32"
    }
  });
  try {
    const bytes = new Uint8Array(macProcessInfoSize);
    const returned = library.symbols.proc_pidinfo(pid, macProcessInfoFlavor, 0, ptr(bytes), bytes.byteLength);
    if (returned !== macProcessInfoSize)
      return null;
    const view = new DataView(bytes.buffer);
    const seconds = view.getBigUint64(macProcessStartSecondsOffset, true);
    const microseconds = view.getBigUint64(macProcessStartMicrosecondsOffset, true);
    if (seconds < 1n || microseconds >= 1000000n)
      return null;
    return processIdentityDigest(`darwin:${seconds}:${microseconds}`);
  } finally {
    library.close();
  }
}
async function macProcessScopeIdentity() {
  if (cachedMacProcessScopeIdentity !== undefined) {
    return cachedMacProcessScopeIdentity;
  }
  const { dlopen } = await import("bun:ffi");
  const library = dlopen("/usr/lib/libSystem.B.dylib", {
    gethostuuid: {
      args: ["ptr", "ptr"],
      returns: "i32"
    }
  });
  try {
    const uuid = new Uint8Array(macHostUuidBytes);
    const wait = new BigInt64Array([macHostUuidWaitSeconds, 0n]);
    if (library.symbols.gethostuuid(uuid, wait) !== 0)
      return null;
    const source = Buffer.from(uuid).toString("hex");
    if (!/^(?!0{32}$)[0-9a-f]{32}$/u.test(source))
      return null;
    cachedMacProcessScopeIdentity = processIdentityDigest(`darwin-host:${source}`);
    return cachedMacProcessScopeIdentity;
  } finally {
    library.close();
  }
}
async function darwinProcessIdentity(pid) {
  const [value, processScopeIdentity] = await Promise.all([
    macProcessIdentity(pid),
    macProcessScopeIdentity()
  ]);
  return value === null || processScopeIdentity === null ? null : { processScopeIdentity, value };
}
async function queryProcessIdentity(pid) {
  if (!processIsAlive(pid))
    return { kind: "missing" };
  try {
    const identity = process.platform === "linux" ? await linuxProcessIdentity(pid) : process.platform === "darwin" ? await darwinProcessIdentity(pid) : null;
    if (identity !== null)
      return { kind: "identified", ...identity };
  } catch {}
  return processIsAlive(pid) ? { kind: "unavailable" } : { kind: "missing" };
}
async function markerProcessIsOwner(marker, inspectingProcessScopeIdentity) {
  if (marker.processScopeIdentity !== inspectingProcessScopeIdentity)
    return true;
  const processIdentity = await queryProcessIdentity(marker.pid);
  return processIdentity.kind === "unavailable" || processIdentity.kind === "identified" && processIdentity.processScopeIdentity === marker.processScopeIdentity && processIdentity.value === marker.processIdentity;
}
function identity(value) {
  return { device: value.dev, inode: value.ino };
}
function credentialOwnerUid() {
  if (typeof process.getuid !== "function") {
    throw new Error("credential owner uid unavailable");
  }
  return process.getuid();
}
function sameIdentity(left, right) {
  const device = "device" in right ? right.device : right.dev;
  const inode = "inode" in right ? right.inode : right.ino;
  return left.device === device && left.inode === inode;
}
function markerIsPrivateRegularFile(details) {
  return details.isFile() && !details.isSymbolicLink() && details.uid === credentialOwnerUid() && (details.mode & 63) === 0 && details.size === 0;
}
async function removeStaleUniqueMarker(marker, options, processScopeIdentity) {
  try {
    const confirmed = await lstat(marker.path);
    if (!sameIdentity(marker.identity, confirmed) || !markerIsPrivateRegularFile(confirmed) || await markerProcessIsOwner(marker, processScopeIdentity) || Date.now() - confirmed.mtimeMs < options.staleAfterMilliseconds) {
      return;
    }
    await unlink(marker.path);
  } catch {}
}
async function scanActiveMarkers(options, purpose, processScopeIdentity) {
  let entries;
  try {
    entries = await readdir(options.directory, { withFileTypes: true });
  } catch (cause) {
    throw leaseFailure(purpose, undefined, cause);
  }
  if (entries.length > maximumDirectoryEntries) {
    throw leaseFailure(purpose);
  }
  const active = [];
  for (const entry of entries) {
    const parsed = parseMarkerName(entry.name);
    if (parsed === null)
      continue;
    if (parsed.processScopeIdentity !== processScopeIdentity) {
      throw leaseFailure(purpose, "Transmute cannot safely coordinate credentials across process scopes.");
    }
    const path = join(options.directory, entry.name);
    let details;
    try {
      details = await lstat(path);
    } catch (cause) {
      if (isErrorCode(cause, "ENOENT"))
        continue;
      throw leaseFailure(purpose, undefined, cause);
    }
    if (!markerIsPrivateRegularFile(details)) {
      throw leaseFailure(purpose);
    }
    const marker = {
      ...parsed,
      path,
      identity: identity(details),
      modifiedAtMilliseconds: details.mtimeMs
    };
    if (Date.now() - marker.modifiedAtMilliseconds < options.staleAfterMilliseconds || await markerProcessIsOwner(marker, processScopeIdentity)) {
      active.push(marker);
      continue;
    }
    await removeStaleUniqueMarker(marker, options, processScopeIdentity);
  }
  return active;
}
async function publishMarker(directory, name, processScopeIdentity, pid, processIdentity, ownerId, purpose, ticket) {
  const path = join(directory, name);
  let handle;
  try {
    handle = await open(path, "wx+", 384);
    const details = await handle.stat();
    if (!markerIsPrivateRegularFile(details))
      throw leaseFailure(purpose);
    return {
      name,
      path,
      processScopeIdentity,
      pid,
      processIdentity,
      ownerId,
      ...ticket === undefined ? {} : { ticket },
      handle,
      identity: identity(details)
    };
  } catch (cause) {
    await handle?.close().catch(() => {
      return;
    });
    if (cause instanceof TransmuteCloudError)
      throw cause;
    throw leaseFailure(purpose, undefined, cause);
  }
}
async function markerStillOwned(marker) {
  try {
    const [held, named] = await Promise.all([
      marker.handle.stat(),
      lstat(marker.path)
    ]);
    return sameIdentity(marker.identity, held) && sameIdentity(marker.identity, named) && markerIsPrivateRegularFile(held) && markerIsPrivateRegularFile(named);
  } catch {
    return false;
  }
}
async function removePublishedMarkerOnce(marker) {
  let held;
  let named;
  try {
    held = await marker.handle.stat();
  } catch {
    return "lost";
  }
  try {
    named = await lstat(marker.path);
  } catch (cause) {
    return isErrorCode(cause, "ENOENT") ? "removed" : "retry";
  }
  if (!sameIdentity(marker.identity, held) || !sameIdentity(marker.identity, named) || !markerIsPrivateRegularFile(held) || !markerIsPrivateRegularFile(named)) {
    return "lost";
  }
  try {
    await unlink(marker.path);
    return "removed";
  } catch (cause) {
    return isErrorCode(cause, "ENOENT") ? "removed" : "retry";
  }
}
async function removePublishedMarker(marker, pollMilliseconds) {
  for (let attempt = 0;attempt < 3; attempt += 1) {
    const result = await removePublishedMarkerOnce(marker);
    if (result !== "retry")
      return result;
    if (attempt < 2)
      await waitForLease(pollMilliseconds, undefined, "logout");
  }
  return "retry";
}
function closeAfterBackgroundCleanup(marker, pollMilliseconds) {
  let cleanup = Promise.resolve();
  const timer = setInterval(() => {
    cleanup = cleanup.then(async () => {
      const result = await removePublishedMarkerOnce(marker);
      if (result === "retry")
        return;
      clearInterval(timer);
      await marker.handle.close().catch(() => {
        return;
      });
    }).catch(() => {
      return;
    });
  }, pollMilliseconds);
  timer.unref();
}
function compareLeases(left, right) {
  const leftTicket = left.ticket;
  const rightTicket = right.ticket;
  if (leftTicket === undefined || rightTicket === undefined)
    return 0;
  if (leftTicket < rightTicket)
    return -1;
  if (leftTicket > rightTicket)
    return 1;
  if (left.ownerId < right.ownerId)
    return -1;
  if (left.ownerId > right.ownerId)
    return 1;
  return 0;
}
function managedLease(marker, options, purpose) {
  let releaseRequested = false;
  let released = false;
  let heartbeat = Promise.resolve();
  const heartbeatMilliseconds = Math.max(10, Math.min(5000, Math.floor(options.staleAfterMilliseconds / 3)));
  const touch = async () => {
    if (!await markerStillOwned(marker))
      throw leaseFailure(purpose);
    const timestamp = new Date;
    await marker.handle.utimes(timestamp, timestamp);
  };
  const timer = setInterval(() => {
    if (releaseRequested || released)
      return;
    heartbeat = heartbeat.then(async () => {
      try {
        await (options.heartbeat ?? ((operation) => operation()))(touch);
      } catch {}
    }).catch(() => {
      return;
    });
  }, heartbeatMilliseconds);
  timer.unref();
  const assertOwnedOnce = async () => {
    if (released || !await markerStillOwned(marker)) {
      throw leaseFailure(purpose);
    }
    const markers = await scanActiveMarkers(options, purpose, marker.processScopeIdentity);
    const leases = markers.filter((candidate) => candidate.kind === "lease").sort(compareLeases);
    const owner = leases[0];
    if (owner === undefined || owner.ownerId !== marker.ownerId || owner.ticket !== marker.ticket || !sameIdentity(marker.identity, owner.identity)) {
      throw leaseFailure(purpose);
    }
  };
  return {
    assertOwned: async () => {
      let lastFailure;
      for (let attempt = 0;attempt < 3; attempt += 1) {
        try {
          await assertOwnedOnce();
          return;
        } catch (cause) {
          lastFailure = cause;
          if (attempt < 2) {
            await waitForLease(options.pollIntervalMilliseconds, undefined, purpose);
          }
        }
      }
      if (lastFailure instanceof TransmuteCloudError)
        throw lastFailure;
      throw leaseFailure(purpose, undefined, lastFailure);
    },
    release: async () => {
      if (releaseRequested)
        return;
      releaseRequested = true;
      clearInterval(timer);
      heartbeat.catch(() => {
        return;
      });
      const removal = await removePublishedMarker(marker, options.pollIntervalMilliseconds);
      if (removal !== "retry") {
        released = true;
        await marker.handle.close().catch(() => {
          return;
        });
        return;
      }
      closeAfterBackgroundCleanup(marker, options.pollIntervalMilliseconds);
    }
  };
}
async function cleanupUnacquiredMarker(marker, pollMilliseconds) {
  if (marker === undefined)
    return;
  if (await removePublishedMarker(marker, pollMilliseconds) !== "retry") {
    await marker.handle.close().catch(() => {
      return;
    });
    return;
  }
  closeAfterBackgroundCleanup(marker, pollMilliseconds);
}
async function acquireTransmuteCredentialMutationLease(dependencies, purpose) {
  assertTransmuteCredentialMutationPlatformSupported(purpose);
  const options = resolveOptions(dependencies);
  await prepareDirectory(options.directory, purpose);
  const deadline = performance.now() + options.waitTimeoutMilliseconds;
  const ownerId = randomBytes(16).toString("hex");
  const processIdentity = await queryProcessIdentity(process.pid);
  if (processIdentity.kind !== "identified")
    throw leaseFailure(purpose);
  const choosingName = `choosing-v4-${processIdentity.processScopeIdentity}-${process.pid}-${processIdentity.value}-${ownerId}`;
  let choosing;
  let owner;
  let lease;
  try {
    throwIfCancelled(options.signal, purpose);
    choosing = await publishMarker(options.directory, choosingName, processIdentity.processScopeIdentity, process.pid, processIdentity.value, ownerId, purpose);
    const initialMarkers = await scanActiveMarkers(options, purpose, processIdentity.processScopeIdentity);
    let highestTicket = 0n;
    for (const marker of initialMarkers) {
      if (marker.kind === "lease" && marker.ticket !== undefined && marker.ticket > highestTicket) {
        highestTicket = marker.ticket;
      }
    }
    if (highestTicket >= maximumTicket)
      throw leaseFailure(purpose);
    const ticket = highestTicket + 1n;
    const ticketText = ticket.toString(16).padStart(16, "0");
    const ownerName = `lease-v4-${ticketText}-${processIdentity.processScopeIdentity}-${process.pid}-${processIdentity.value}-${ownerId}`;
    owner = await publishMarker(options.directory, ownerName, processIdentity.processScopeIdentity, process.pid, processIdentity.value, ownerId, purpose, ticket);
    if (await removePublishedMarker(choosing, options.pollIntervalMilliseconds) !== "removed") {
      throw leaseFailure(purpose);
    }
    await choosing.handle.close().catch(() => {
      return;
    });
    choosing = undefined;
    lease = managedLease(owner, options, purpose);
    for (;; ) {
      throwIfCancelled(options.signal, purpose);
      if (!await markerStillOwned(owner))
        throw leaseFailure(purpose);
      const markers = await scanActiveMarkers(options, purpose, processIdentity.processScopeIdentity);
      const anotherChooser = markers.some((marker) => marker.kind === "choosing" && marker.ownerId !== ownerId);
      const leases = markers.filter((marker) => marker.kind === "lease").sort(compareLeases);
      const first = leases[0];
      if (!anotherChooser && first !== undefined && first.ownerId === ownerId && first.ticket === ticket && sameIdentity(owner.identity, first.identity)) {
        return lease;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw leaseFailure(purpose, purpose === "refresh" ? "Transmute timed out waiting for another login refresh." : "Transmute timed out waiting for another credential mutation.");
      }
      await waitForLease(Math.min(options.pollIntervalMilliseconds, remaining), options.signal, purpose);
    }
  } catch (cause) {
    await lease?.release();
    if (lease === undefined) {
      await cleanupUnacquiredMarker(owner, options.pollIntervalMilliseconds);
    }
    await cleanupUnacquiredMarker(choosing, options.pollIntervalMilliseconds);
    throw cause;
  }
}

// src/auth.ts
var transmuteSecretsService = "com.hraness.transmute.cli";
var transmuteSecretsName = "oauth2-tokens";
var tokenResponseMaximumBytes = 64 * 1024;
var authorizationResponseMaximumBytes = 32 * 1024;
var authorizationLaunchUrlMaximumBytes = 16 * 1024;
var storedCredentialMaximumBytes = 64 * 1024;
var maximumTokenLength = 16 * 1024;
var callbackPort = 49671;
var callbackPath = "/oauth/callback";
var callbackMaximumRequests = 32;
var expirySkewMilliseconds = 60000;
var maximumExpiresInSeconds = 365 * 24 * 60 * 60;
function secretStore(dependencies) {
  return dependencies.secrets ?? Bun.secrets;
}
function boundedToken(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumTokenLength || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new TransmuteCloudError("TOKEN_EXCHANGE_FAILED", "Transmute rejected the authorization token response.");
  }
  return value;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function parseStoredCredentials(value) {
  if (Buffer.byteLength(value, "utf8") > storedCredentialMaximumBytes) {
    throw new TransmuteCloudError("TOKEN_STORAGE_FAILED", "Stored Transmute credentials are invalid.");
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TransmuteCloudError("TOKEN_STORAGE_FAILED", "Stored Transmute credentials are invalid.");
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || typeof parsed.issuer !== "string" || parsed.issuer.length > 2048 || typeof parsed.clientId !== "string" || parsed.clientId.length > 256 || typeof parsed.resource !== "string" || parsed.resource.length > 2048 || !Number.isSafeInteger(parsed.expiresAt) || parsed.expiresAt < 0 || parsed.expiresAt > 8640000000000000) {
    throw new TransmuteCloudError("TOKEN_STORAGE_FAILED", "Stored Transmute credentials are invalid.");
  }
  let accessToken;
  let refreshToken;
  try {
    accessToken = boundedToken(parsed.accessToken);
    refreshToken = parsed.refreshToken === undefined ? undefined : boundedToken(parsed.refreshToken);
  } catch (cause) {
    throw new TransmuteCloudError("TOKEN_STORAGE_FAILED", "Stored Transmute credentials are invalid.", { cause });
  }
  const keys = Object.keys(parsed);
  if (keys.some((key) => ![
    "schemaVersion",
    "issuer",
    "clientId",
    "resource",
    "accessToken",
    "refreshToken",
    "expiresAt"
  ].includes(key))) {
    throw new TransmuteCloudError("TOKEN_STORAGE_FAILED", "Stored Transmute credentials are invalid.");
  }
  return {
    schemaVersion: 1,
    issuer: parsed.issuer,
    clientId: parsed.clientId,
    resource: parsed.resource,
    accessToken,
    ...refreshToken === undefined ? {} : { refreshToken },
    expiresAt: parsed.expiresAt
  };
}
async function loadCredentials(dependencies) {
  let stored;
  try {
    stored = await secretStore(dependencies).get({
      service: transmuteSecretsService,
      name: transmuteSecretsName
    });
  } catch (cause) {
    throw new TransmuteCloudError("TOKEN_STORAGE_FAILED", "Transmute could not read credentials from the operating-system credential store.", { cause });
  }
  return stored === null ? null : parseStoredCredentials(stored);
}
async function storeCredentials(credentials, dependencies) {
  const value = JSON.stringify(credentials);
  if (Buffer.byteLength(value, "utf8") > storedCredentialMaximumBytes) {
    throw new TransmuteCloudError("TOKEN_STORAGE_FAILED", "Transmute credentials exceed the credential-store limit.");
  }
  try {
    await secretStore(dependencies).set({
      service: transmuteSecretsService,
      name: transmuteSecretsName,
      value
    });
  } catch (cause) {
    throw new TransmuteCloudError("TOKEN_STORAGE_FAILED", "Transmute could not write credentials to the operating-system credential store.", { cause });
  }
}
async function deleteCredentials(dependencies) {
  try {
    return await secretStore(dependencies).delete({
      service: transmuteSecretsService,
      name: transmuteSecretsName
    });
  } catch (cause) {
    throw new TransmuteCloudError("TOKEN_STORAGE_FAILED", "Transmute could not remove credentials from the operating-system credential store.", { cause });
  }
}
function base64Url(bytes) {
  return Buffer.from(bytes).toString("base64url");
}
function createPkcePair() {
  const verifier = base64Url(randomBytes2(32));
  const challenge = createHash2("sha256").update(verifier, "ascii").digest("base64url");
  return { verifier, challenge };
}
function buildTransmuteAuthorizationUrl(discovery, state, challenge) {
  const trustedDiscovery = parseTransmuteDiscovery(discovery);
  if (state.length < 32 || state.length > 256 || challenge.length !== 43 || !/^[A-Za-z0-9_-]+$/u.test(state) || !/^[A-Za-z0-9_-]+$/u.test(challenge)) {
    throw new TransmuteCloudError("INVALID_ARGUMENT", "Invalid OAuth state or PKCE challenge.");
  }
  const url = new URL(trustedDiscovery.capabilities.media.authorization.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", trustedDiscovery.capabilities.media.authorization.clientId);
  url.searchParams.set("redirect_uri", transmuteRedirectUri);
  url.searchParams.set("scope", trustedDiscovery.capabilities.media.authorization.scopes.join(" "));
  url.searchParams.set("resource", trustedDiscovery.capabilities.media.authorization.resource);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.href;
}
function safeEqual(left, right) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}
function callbackPage(success) {
  return [
    "<!doctype html>",
    '<meta charset="utf-8">',
    `<title>Transmute ${success ? "login complete" : "login failed"}</title>`,
    `<p>Transmute login ${success ? "is complete. You can close this window." : "could not be completed. Return to the terminal."}</p>`
  ].join("");
}
async function closeServer(server) {
  if (!server.listening)
    return;
  await new Promise((resolve) => {
    server.close(() => resolve());
  });
}
async function startAuthorizationCallback(expectedState, timeoutMilliseconds) {
  let resolveCode;
  let rejectCode;
  let settled = false;
  let requestCount = 0;
  const codePromise = new Promise((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = createServer((request, response) => {
    requestCount += 1;
    response.setHeader("connection", "close");
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");
    response.setHeader("content-type", "text/html; charset=utf-8");
    if (requestCount > callbackMaximumRequests) {
      response.statusCode = 429;
      response.end(callbackPage(false));
      if (!settled) {
        settled = true;
        rejectCode(new TransmuteCloudError("AUTHORIZATION_FAILED", "Transmute login received too many invalid callback requests."));
      }
      return;
    }
    if (request.method !== "GET" || request.headers.host !== `127.0.0.1:${callbackPort}`) {
      response.statusCode = 404;
      response.end(callbackPage(false));
      return;
    }
    let url;
    try {
      if ((request.url?.length ?? 0) > 8192)
        throw new Error("oversized callback");
      url = new URL(request.url ?? "", transmuteRedirectUri);
    } catch {
      response.statusCode = 400;
      response.end(callbackPage(false));
      return;
    }
    if (url.pathname !== callbackPath) {
      response.statusCode = 404;
      response.end(callbackPage(false));
      return;
    }
    const states = url.searchParams.getAll("state");
    if (states.length !== 1 || states[0] === undefined || states[0].length > 256 || !safeEqual(states[0], expectedState)) {
      response.statusCode = 400;
      response.end(callbackPage(false));
      return;
    }
    const oauthErrors = url.searchParams.getAll("error");
    if (oauthErrors.length > 0) {
      response.statusCode = 400;
      response.end(callbackPage(false));
      if (!settled) {
        settled = true;
        rejectCode(new TransmuteCloudError("AUTHORIZATION_FAILED", "Transmute authorization was denied or failed."));
      }
      return;
    }
    const codes = url.searchParams.getAll("code");
    const code = codes[0];
    if (codes.length !== 1 || code === undefined || code.length < 1 || code.length > 4096 || /[\u0000-\u0020\u007f]/u.test(code)) {
      response.statusCode = 400;
      response.end(callbackPage(false));
      return;
    }
    response.statusCode = 200;
    response.end(callbackPage(true));
    if (!settled) {
      settled = true;
      resolveCode(code);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(callbackPort, "127.0.0.1", () => resolve());
  }).catch((cause) => {
    throw new TransmuteCloudError("AUTH_CALLBACK_UNAVAILABLE", `Transmute login requires ${transmuteRedirectUri}, but the loopback callback could not start.`, { cause });
  });
  const timeout = setTimeout(() => {
    if (settled)
      return;
    settled = true;
    rejectCode(new TransmuteCloudError("AUTH_TIMEOUT", "Transmute login timed out before authorization completed."));
  }, timeoutMilliseconds);
  let closed = false;
  const close = async () => {
    if (closed)
      return;
    closed = true;
    clearTimeout(timeout);
    if (!settled) {
      settled = true;
      rejectCode(new TransmuteCloudError("AUTHORIZATION_FAILED", "Transmute login was cancelled before authorization completed."));
    }
    server.closeIdleConnections();
    server.closeAllConnections();
    await closeServer(server);
  };
  return { code: codePromise, close };
}
async function defaultOpenUrl(url) {
  const command = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["rundll32", "url.dll,FileProtocolHandler", url] : ["xdg-open", url];
  let subprocess;
  try {
    subprocess = Bun.spawn(command, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore"
    });
  } catch (cause) {
    throw new TransmuteCloudError("AUTHORIZATION_FAILED", "Transmute could not open the authorization page.", { cause });
  }
  const exitCode = await Promise.race([
    subprocess.exited,
    Bun.sleep(1e4).then(() => null)
  ]);
  if (exitCode === null) {
    subprocess.kill();
    await subprocess.exited.catch(() => {
      return;
    });
  }
  if (exitCode !== 0) {
    throw new TransmuteCloudError("AUTHORIZATION_FAILED", "Transmute could not open the authorization page.");
  }
}
function authorizationLaunchFailure(options) {
  return new TransmuteCloudError("AUTHORIZATION_FAILED", "Transmute could not start the authorization flow.", options);
}
function validateAuthorizationLaunchUrl(discovery, value) {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > authorizationLaunchUrlMaximumBytes || /[\u0000-\u0020\u007f]/u.test(value) || value.includes("\\") || value.includes("#")) {
    throw authorizationLaunchFailure();
  }
  const isRootRelative = value.startsWith("/") && !value.startsWith("//");
  const isHttpsAbsolute = /^https:\/\//iu.test(value);
  if (!isRootRelative && !isHttpsAbsolute) {
    throw authorizationLaunchFailure();
  }
  if (/^https:\/\/[^/?#]*@/iu.test(value)) {
    throw authorizationLaunchFailure();
  }
  let url;
  let issuer;
  try {
    issuer = new URL(discovery.capabilities.media.authorization.issuer);
    url = new URL(value, issuer);
  } catch {
    throw authorizationLaunchFailure();
  }
  if (url.protocol !== "https:" || url.origin !== issuer.origin || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw authorizationLaunchFailure();
  }
  return url.href;
}
async function fetchAuthorizationLaunchUrl(discovery, authorizationUrl, dependencies) {
  let response;
  try {
    response = await (dependencies.fetch ?? fetch)(authorizationUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "hraness-transmute-cli/0.9.0"
      },
      redirect: "manual",
      signal: AbortSignal.timeout(15000)
    });
  } catch (cause) {
    throw authorizationLaunchFailure({ cause });
  }
  if (response.redirected) {
    await response.body?.cancel().catch(() => {
      return;
    });
    throw authorizationLaunchFailure();
  }
  if (response.status >= 300 && response.status <= 399) {
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => {
      return;
    });
    return validateAuthorizationLaunchUrl(discovery, location);
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {
      return;
    });
    throw authorizationLaunchFailure();
  }
  const contentType = response.headers.get("content-type");
  if (contentType === null || !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/iu.test(contentType)) {
    await response.body?.cancel().catch(() => {
      return;
    });
    throw authorizationLaunchFailure();
  }
  const failure = authorizationLaunchFailure();
  const bytes = await readBoundedResponseBytes(response, authorizationResponseMaximumBytes, failure);
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw failure;
  }
  if (!isRecord(value) || value.redirect !== true || Object.keys(value).length !== 2 || !("url" in value)) {
    throw failure;
  }
  return validateAuthorizationLaunchUrl(discovery, value.url);
}
async function tokenRequest(discovery, body, failureCode, dependencies) {
  const failure = new TransmuteCloudError(failureCode, failureCode === "TOKEN_EXCHANGE_FAILED" ? "Transmute could not exchange the authorization code." : "Transmute could not refresh the login.");
  let response;
  try {
    response = await (dependencies.fetch ?? fetch)(discovery.capabilities.media.authorization.tokenEndpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "hraness-transmute-cli/0.9.0"
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(15000)
    });
  } catch (cause) {
    throw new TransmuteCloudError(failureCode, failure.message.slice(failure.message.indexOf("]") + 2), {
      cause
    });
  }
  const contentType = response.headers.get("content-type");
  if (contentType === null || !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/iu.test(contentType)) {
    await response.body?.cancel().catch(() => {
      return;
    });
    throw failure;
  }
  const bytes = await readBoundedResponseBytes(response, tokenResponseMaximumBytes, failure);
  if (!response.ok)
    throw failure;
  let value;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw failure;
  }
  if (!isRecord(value) || typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer" || !Number.isSafeInteger(value.expires_in) || value.expires_in < 1 || value.expires_in > maximumExpiresInSeconds) {
    throw failure;
  }
  let accessToken;
  let refreshToken;
  try {
    accessToken = boundedToken(value.access_token);
    refreshToken = value.refresh_token === undefined ? undefined : boundedToken(value.refresh_token);
  } catch {
    throw failure;
  }
  return {
    accessToken,
    ...refreshToken === undefined ? {} : { refreshToken },
    expiresIn: value.expires_in
  };
}
function credentialsFromToken(discovery, token, now, retainedRefreshToken) {
  const refreshToken = token.refreshToken ?? retainedRefreshToken;
  return {
    schemaVersion: 1,
    issuer: discovery.capabilities.media.authorization.issuer,
    clientId: discovery.capabilities.media.authorization.clientId,
    resource: discovery.capabilities.media.authorization.resource,
    accessToken: token.accessToken,
    ...refreshToken === undefined ? {} : { refreshToken },
    expiresAt: now + token.expiresIn * 1000
  };
}
async function loginTransmute(dependencies = {}) {
  assertTransmuteCredentialMutationPlatformSupported("login");
  const discovery = await fetchTransmuteDiscovery(dependencies.fetch);
  const { verifier, challenge } = createPkcePair();
  const state = base64Url(randomBytes2(32));
  const callback = await startAuthorizationCallback(state, 5 * 60000);
  callback.code.catch(() => {
    return;
  });
  const authorizationUrl = buildTransmuteAuthorizationUrl(discovery, state, challenge);
  try {
    const launch = (async () => {
      try {
        const launchUrl = await fetchAuthorizationLaunchUrl(discovery, authorizationUrl, dependencies);
        await (dependencies.openUrl ?? defaultOpenUrl)(launchUrl);
      } catch (cause) {
        if (cause instanceof TransmuteCloudError)
          throw cause;
        throw new TransmuteCloudError("AUTHORIZATION_FAILED", "Transmute could not open the authorization page.", { cause });
      }
    })();
    launch.catch(() => {
      return;
    });
    const code = await Promise.race([
      callback.code,
      launch.then(() => callback.code)
    ]);
    await callback.close();
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: transmuteRedirectUri,
      client_id: discovery.capabilities.media.authorization.clientId,
      resource: discovery.capabilities.media.authorization.resource,
      code_verifier: verifier
    });
    const token = await tokenRequest(discovery, form, "TOKEN_EXCHANGE_FAILED", dependencies);
    const now = (dependencies.now ?? Date.now)();
    const credentials = credentialsFromToken(discovery, token, now);
    const lease = await acquireTransmuteCredentialMutationLease(dependencies, "login");
    try {
      throwIfTransmuteCredentialMutationCancelled(dependencies, "login");
      await loadCredentials(dependencies);
      await lease.assertOwned();
      throwIfTransmuteCredentialMutationCancelled(dependencies, "login");
      await storeCredentials(credentials, dependencies);
    } finally {
      await lease.release();
    }
    return {
      authenticated: true,
      expiresAt: new Date(credentials.expiresAt).toISOString(),
      refreshable: credentials.refreshToken !== undefined
    };
  } finally {
    await callback.close();
  }
}
function credentialsMatchDiscovery(credentials, discovery) {
  return credentials.issuer === discovery.capabilities.media.authorization.issuer && credentials.clientId === discovery.capabilities.media.authorization.clientId && credentials.resource === discovery.capabilities.media.authorization.resource;
}
async function refreshAccessToken(discovery, dependencies) {
  const lease = await acquireTransmuteCredentialMutationLease(dependencies, "refresh");
  try {
    const credentials = await loadCredentials(dependencies);
    if (credentials === null || !credentialsMatchDiscovery(credentials, discovery)) {
      throw new TransmuteCloudError("AUTH_REQUIRED", "Transmute login is missing or expired. Run `transmute auth login`.");
    }
    const now = (dependencies.now ?? Date.now)();
    if (credentials.expiresAt > now + expirySkewMilliseconds) {
      return credentials.accessToken;
    }
    const refreshToken = credentials.refreshToken;
    if (refreshToken === undefined) {
      throw new TransmuteCloudError("AUTH_REQUIRED", "Transmute login is missing or expired. Run `transmute auth login`.");
    }
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: discovery.capabilities.media.authorization.clientId,
      resource: discovery.capabilities.media.authorization.resource
    });
    await lease.assertOwned();
    throwIfTransmuteCredentialMutationCancelled(dependencies, "refresh");
    const token = await tokenRequest(discovery, form, "TOKEN_REFRESH_FAILED", dependencies);
    const next = credentialsFromToken(discovery, token, (dependencies.now ?? Date.now)(), refreshToken);
    await lease.assertOwned();
    await storeCredentials(next, dependencies);
    return next.accessToken;
  } finally {
    await lease.release();
  }
}
async function getTransmuteAccessToken(discovery, dependencies = {}) {
  const trustedDiscovery = parseTransmuteDiscovery(discovery);
  const credentials = await loadCredentials(dependencies);
  if (credentials === null || credentials.issuer !== trustedDiscovery.capabilities.media.authorization.issuer || credentials.clientId !== trustedDiscovery.capabilities.media.authorization.clientId || credentials.resource !== trustedDiscovery.capabilities.media.authorization.resource) {
    throw new TransmuteCloudError("AUTH_REQUIRED", "Transmute login is missing or expired. Run `transmute auth login`.");
  }
  const now = (dependencies.now ?? Date.now)();
  if (credentials.expiresAt > now + expirySkewMilliseconds) {
    return credentials.accessToken;
  }
  return refreshAccessToken(trustedDiscovery, dependencies);
}
async function requireTransmuteAuthentication(dependencies = {}) {
  const discovery = await fetchTransmuteDiscovery(dependencies.fetch);
  await getTransmuteAccessToken(discovery, dependencies);
  return discovery;
}
async function transmuteAuthStatus(dependencies = {}) {
  const credentials = await loadCredentials(dependencies);
  if (credentials === null) {
    return { authenticated: false, expiresAt: null, refreshable: false };
  }
  if (credentials.issuer !== transmuteProductionContract.issuer || credentials.clientId !== transmuteProductionContract.clientId || credentials.resource !== transmuteProductionContract.resource) {
    return { authenticated: false, expiresAt: null, refreshable: false };
  }
  return {
    authenticated: credentials.expiresAt > (dependencies.now ?? Date.now)() || credentials.refreshToken !== undefined,
    expiresAt: new Date(credentials.expiresAt).toISOString(),
    refreshable: credentials.refreshToken !== undefined
  };
}
async function logoutTransmute(dependencies = {}) {
  assertTransmuteCredentialMutationPlatformSupported("logout");
  const lease = await acquireTransmuteCredentialMutationLease(dependencies, "logout");
  try {
    const credentials = await loadCredentials(dependencies);
    if (credentials === null)
      return { removed: false, revoked: false };
    let revocationError;
    let revoked = false;
    try {
      const discovery = await fetchTransmuteDiscovery(dependencies.fetch);
      if (!credentialsMatchDiscovery(credentials, discovery)) {
        throw new TransmuteCloudError("REVOCATION_FAILED", "Transmute could not verify the stored login before revocation.");
      }
      const token = credentials.refreshToken ?? credentials.accessToken;
      const tokenTypeHint = credentials.refreshToken === undefined ? "access_token" : "refresh_token";
      let response;
      try {
        await lease.assertOwned();
        response = await (dependencies.fetch ?? fetch)(discovery.capabilities.media.authorization.revocationEndpoint, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
            "user-agent": "hraness-transmute-cli/0.9.0"
          },
          body: new URLSearchParams({
            token,
            token_type_hint: tokenTypeHint,
            client_id: discovery.capabilities.media.authorization.clientId
          }),
          redirect: "error",
          signal: AbortSignal.timeout(15000)
        });
      } catch (cause) {
        throw new TransmuteCloudError("REVOCATION_FAILED", "Transmute could not revoke the remote login.", { cause });
      }
      await readBoundedResponseBytes(response, 16 * 1024, new TransmuteCloudError("REVOCATION_FAILED", "Transmute received an invalid revocation response."));
      if (!response.ok) {
        throw new TransmuteCloudError("REVOCATION_FAILED", "Transmute could not revoke the remote login.");
      }
      revoked = true;
    } catch (error) {
      revocationError = error instanceof TransmuteCloudError ? error : new TransmuteCloudError("REVOCATION_FAILED", "Transmute could not revoke the remote login.", { cause: error });
    }
    await lease.assertOwned();
    const removed = await deleteCredentials(dependencies);
    if (revocationError !== undefined)
      throw revocationError;
    return { removed, revoked };
  } finally {
    await lease.release();
  }
}

export { transmuteSecretsService, transmuteSecretsName, createPkcePair, buildTransmuteAuthorizationUrl, loginTransmute, getTransmuteAccessToken, requireTransmuteAuthentication, transmuteAuthStatus, logoutTransmute };
