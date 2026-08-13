import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  boundedBrowserStep,
  classifySnapshotTreeOpenStateResult,
  removeBrowserRuntimeSnapshot,
  scavengeStaleBrowserRuntimeSnapshots,
} from "./html-overlay-renderer";

const roots: string[] = [];
const NOW = new Date("2026-07-28T17:00:00.000Z");
const LEASE_FILE = ".transmute-runtime-lease.json";

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

async function anchorFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "transmute-snapshot-scavenger-"));
  roots.push(root);
  return await realpath(root);
}

async function snapshotFixture(
  anchor: string,
  suffix: string,
  pid: number,
): Promise<string> {
  const path = join(anchor, `.transmute-browser-runtime-${suffix}`);
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
  await writeFile(join(path, LEASE_FILE), `${JSON.stringify({
    acquiredAt: "2026-07-28T16:00:00.000Z",
    hostname: hostname(),
    pid,
    schemaVersion: 1,
    state: "active",
    token: "00000000-0000-4000-8000-000000000001",
  })}\n`, { mode: 0o600 });
  return path;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function removalFixture(anchor: string, name: string, token: string) {
  const directory = join(anchor, name);
  const runtimeRoot = join(directory, "browser");
  await mkdir(runtimeRoot, { mode: 0o700, recursive: true });
  await mkdir(join(runtimeRoot, "Contents", "Frameworks"), {
    mode: 0o700,
    recursive: true,
  });
  await mkdir(join(directory, "home"), { mode: 0o700 });
  await mkdir(join(directory, "tmp"), { mode: 0o700 });
  await writeFile(join(runtimeRoot, "identity.txt"), name, { mode: 0o600 });
  await writeFile(
    join(runtimeRoot, "Contents", "Frameworks", "shared.bin"),
    name,
    { mode: 0o600 },
  );
  await writeFile(join(directory, "home", "identity.txt"), name, { mode: 0o600 });
  const lease = {
    acquiredAt: "2026-07-28T16:00:00.000Z",
    hostname: hostname(),
    pid: process.pid,
    schemaVersion: 1 as const,
    state: "active" as const,
    token,
  };
  const leasePath = join(directory, LEASE_FILE);
  await writeFile(leasePath, `${JSON.stringify(lease)}\n`, { mode: 0o600 });
  const leaseHandle = await open(leasePath, "r");
  const [containerDetails, leaseDetails] = await Promise.all([
    lstat(directory, { bigint: true }),
    leaseHandle.stat(),
  ]);
  const containerChildren = await Promise.all(
    (await readdir(directory)).sort().map(async childName => {
      const details = await lstat(join(directory, childName), { bigint: true });
      return {
        dev: details.dev.toString(),
        ino: details.ino.toString(),
        kind: details.isSymbolicLink()
          ? "symlink" as const
          : details.isDirectory()
            ? "directory" as const
            : details.isFile() ? "file" as const : "other" as const,
        mode: Number(details.mode & 0o177777n),
        name: childName,
      };
    }),
  );
  const runtimeEntries = [
    { kind: "directory" as const, mode: 0o700, path: "." },
    { kind: "directory" as const, mode: 0o700, path: "Contents" },
    {
      kind: "directory" as const,
      mode: 0o700,
      path: "Contents/Frameworks",
    },
    {
      bytes: name.length,
      kind: "file" as const,
      mode: 0o600,
      path: "Contents/Frameworks/shared.bin",
      sha256: "0".repeat(64),
    },
    {
      bytes: name.length,
      kind: "file" as const,
      mode: 0o600,
      path: "identity.txt",
      sha256: "0".repeat(64),
    },
  ];
  const identity = await Promise.all(runtimeEntries.map(async entry => {
    const details = await lstat(
      entry.path === "." ? runtimeRoot : join(runtimeRoot, entry.path),
      { bigint: true },
    );
    return {
      ctimeNs: details.ctimeNs.toString(),
      dev: details.dev.toString(),
      ino: details.ino.toString(),
      mode: Number(details.mode & 0o177777n),
      path: entry.path,
      size: details.size.toString(),
    };
  }));
  return {
    containerChildren,
    containerIdentity: {
      ctimeNs: containerDetails.ctimeNs.toString(),
      dev: containerDetails.dev.toString(),
      ino: containerDetails.ino.toString(),
      mode: Number(containerDetails.mode & 0o177777n),
      path: "<snapshot-container>",
      size: containerDetails.size.toString(),
    },
    directory,
    identity,
    lease,
    leaseHandle,
    leaseIdentity: {
      ctimeMs: leaseDetails.ctimeMs,
      dev: leaseDetails.dev,
      ino: leaseDetails.ino,
      mode: leaseDetails.mode,
      mtimeMs: leaseDetails.mtimeMs,
      nlink: leaseDetails.nlink,
      size: leaseDetails.size,
      uid: leaseDetails.uid,
    },
    runtimeImmutable: false,
    runtimeEntries,
    runtimeRoot,
  };
}

describe("browser runtime snapshot scavenging", () => {
  test("bounded browser work observes cancellation triggered in its start gap", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled inside start");
    let lateCleanup = "";
    const operation = boundedBrowserStep(
      () => {
        controller.abort(reason);
        return Promise.resolve("late result");
      },
      controller.signal,
      1_000,
      "fixture gap",
      value => {
        lateCleanup = value;
      },
    );

    expect(operation).rejects.toBe(reason);
    await operation.catch(() => undefined);
    expect(lateCleanup).toBe("late result");
  });

  test("reclaims only an old dead-owner snapshot whose tree is proven closed", async () => {
    const anchor = await anchorFixture();
    const stale = await snapshotFixture(anchor, "ABC123", 999_991);
    const removed: string[] = [];

    const reclaimed = await scavengeStaleBrowserRuntimeSnapshots({
      anchorPath: anchor,
      now: () => NOW,
      processAlive: () => false,
      releaseAndRemove: async path => {
        expect(await pathExists(stale)).toBe(false);
        expect(await pathExists(path)).toBe(true);
        removed.push(path);
        await rm(path, { force: true, recursive: true });
      },
      staleAfterMs: 1_000,
      treeOpenState: () => Promise.resolve("closed"),
    });

    expect(reclaimed).toEqual([stale]);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatch(
      /\/\.transmute-browser-reclaim-[0-9a-f-]{36}$/u,
    );
    expect(await pathExists(stale)).toBe(false);
  });

  test("preserves live-owner and open-tree peers regardless of age", async () => {
    const anchor = await anchorFixture();
    const live = await snapshotFixture(anchor, "DEF456", process.pid);
    const open = await snapshotFixture(anchor, "GHI789", 999_992);
    const removed: string[] = [];

    const reclaimed = await scavengeStaleBrowserRuntimeSnapshots({
      anchorPath: anchor,
      now: () => NOW,
      processAlive: pid => pid === process.pid,
      releaseAndRemove: path => {
        removed.push(path);
        return Promise.resolve();
      },
      staleAfterMs: 1_000,
      treeOpenState: path => Promise.resolve(path === open
        ? classifySnapshotTreeOpenStateResult({
            exitCode: 1,
            stderr: "",
            stdout: "p59972\nf3\n",
          })
        : "closed"),
    });

    expect(reclaimed).toEqual([]);
    expect(removed).toEqual([]);
    expect(await pathExists(live)).toBe(true);
    expect(await pathExists(open)).toBe(true);
  });

  test("refuses wrong-owner identities, unsafe shapes, and changed leases", async () => {
    const anchor = await anchorFixture();
    const wrongOwner = await snapshotFixture(anchor, "JKL012", 999_993);
    const changed = await snapshotFixture(anchor, "MNO345", 999_994);
    const linkTarget = join(anchor, "link-target");
    await mkdir(linkTarget, { mode: 0o700 });
    await symlink(linkTarget, join(anchor, ".transmute-browser-runtime-PQR678"));
    const removed: string[] = [];
    const actualUid = typeof process.getuid === "function" ? process.getuid() : 501;

    expect(await scavengeStaleBrowserRuntimeSnapshots({
      anchorPath: anchor,
      currentUid: actualUid + 1,
      now: () => NOW,
      processAlive: () => false,
      releaseAndRemove: path => {
        removed.push(path);
        return Promise.resolve();
      },
      staleAfterMs: 1_000,
      treeOpenState: () => Promise.resolve("closed"),
    })).toEqual([]);

    expect(await scavengeStaleBrowserRuntimeSnapshots({
      anchorPath: anchor,
      currentUid: actualUid,
      now: () => NOW,
      processAlive: () => false,
      releaseAndRemove: async path => {
        removed.push(path);
        await rm(path, { force: true, recursive: true });
      },
      staleAfterMs: 1_000,
      treeOpenState: async path => {
        if (path === changed) {
          await writeFile(join(path, LEASE_FILE), `${JSON.stringify({
            acquiredAt: "2026-07-28T16:00:00.000Z",
            hostname: hostname(),
            pid: 999_995,
            schemaVersion: 1,
            state: "active",
            token: "00000000-0000-4000-8000-000000000002",
          })}\n`, { mode: 0o600 });
        }
        return "closed";
      },
    })).toEqual([wrongOwner]);

    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatch(
      /\/\.transmute-browser-reclaim-[0-9a-f-]{36}$/u,
    );
    expect(await pathExists(wrongOwner)).toBe(false);
    expect(await pathExists(changed)).toBe(true);
    expect(await pathExists(join(anchor, ".transmute-browser-runtime-PQR678")))
      .toBe(true);
  });

  test("preserves a candidate when immutable release or removal fails", async () => {
    const anchor = await anchorFixture();
    const stale = await snapshotFixture(anchor, "STU901", 999_996);
    let quarantined = "";

    const reclaimed = await scavengeStaleBrowserRuntimeSnapshots({
      anchorPath: anchor,
      now: () => NOW,
      processAlive: () => false,
      releaseAndRemove: path => {
        quarantined = path;
        return Promise.reject(new Error("fixture cleanup failed"));
      },
      staleAfterMs: 1_000,
      treeOpenState: () => Promise.resolve("closed"),
    });

    expect(reclaimed).toEqual([]);
    expect(await pathExists(stale)).toBe(false);
    expect(await pathExists(quarantined)).toBe(true);
    expect(await readdir(anchor)).toContain(basename(quarantined));
  });

  test("preserves a tree opened across the first lsof and quarantine gap", async () => {
    const anchor = await anchorFixture();
    const stale = await snapshotFixture(anchor, "YZA567", 999_998);
    let probes = 0;
    let releaseCalls = 0;

    const reclaimed = await scavengeStaleBrowserRuntimeSnapshots({
      anchorPath: anchor,
      now: () => NOW,
      processAlive: () => false,
      releaseAndRemove: () => {
        releaseCalls += 1;
        return Promise.resolve();
      },
      staleAfterMs: 1_000,
      treeOpenState: () => {
        probes += 1;
        return Promise.resolve(probes === 1 ? "closed" : "open");
      },
    });

    expect(reclaimed).toEqual([]);
    expect(probes).toBe(2);
    expect(releaseCalls).toBe(0);
    expect(await pathExists(stale)).toBe(false);
    expect((await readdir(anchor)).some(name =>
      name.startsWith(".transmute-browser-reclaim-"))).toBe(true);
  });

  test("treats lsof PID evidence as open even when lsof exits one", () => {
    expect(classifySnapshotTreeOpenStateResult({
      exitCode: 1,
      stderr: "",
      stdout: "p59972\nf3\n",
    })).toBe("open");
    expect(classifySnapshotTreeOpenStateResult({
      exitCode: 1,
      stderr: "",
      stdout: "",
    })).toBe("closed");
    expect(classifySnapshotTreeOpenStateResult({
      exitCode: 0,
      stderr: "",
      stdout: "",
    })).toBe("unknown");
  });

  test("propagates cancellation without starting orphan deletion", async () => {
    const anchor = await anchorFixture();
    const stale = await snapshotFixture(anchor, "VWX234", 999_997);
    const controller = new AbortController();
    const reason = new Error("fixture cancelled");
    controller.abort(reason);

    const scavenging = scavengeStaleBrowserRuntimeSnapshots({
      anchorPath: anchor,
      now: () => NOW,
      processAlive: () => false,
      releaseAndRemove: () => Promise.reject(
        new Error("cleanup must not start"),
      ),
      signal: controller.signal,
      staleAfterMs: 1_000,
      treeOpenState: () => Promise.resolve("closed"),
    });
    expect(scavenging).rejects.toBe(reason);
    await scavenging.catch(() => undefined);
    expect(await pathExists(stale)).toBe(true);
  });

  test("normal cleanup quarantines and preserves a swapped peer before mutation", async () => {
    const anchor = await anchorFixture();
    const first = await removalFixture(
      anchor,
      ".transmute-browser-runtime-AAA111",
      "00000000-0000-4000-8000-000000000011",
    );
    const second = await removalFixture(
      anchor,
      ".transmute-browser-runtime-BBB222",
      "00000000-0000-4000-8000-000000000022",
    );
    const swap = join(anchor, ".fixture-swap");
    await rename(first.directory, swap);
    await rename(second.directory, first.directory);
    await rename(swap, second.directory);

    const removal = removeBrowserRuntimeSnapshot(first);
    expect(removal).rejects.toThrow(/atomically quarantined/u);
    await removal.catch(() => undefined);

    const quarantineName = (await readdir(anchor)).find(name =>
      name.startsWith(".transmute-browser-reclaim-"));
    expect(quarantineName).toBeDefined();
    const quarantine = join(anchor, quarantineName!);
    expect(await readFile(join(quarantine, "browser", "identity.txt"), "utf8"))
      .toBe(".transmute-browser-runtime-BBB222");
    expect(await readFile(
      join(second.directory, "browser", "identity.txt"),
      "utf8",
    )).toBe(".transmute-browser-runtime-AAA111");

    await removeBrowserRuntimeSnapshot({
      ...second,
      directory: quarantine,
      runtimeRoot: join(quarantine, "browser"),
    });
    expect(await pathExists(quarantine)).toBe(false);
  });

  test("normal cleanup preserves peers when only their mutable home children are swapped", async () => {
    const anchor = await anchorFixture();
    const first = await removalFixture(
      anchor,
      ".transmute-browser-runtime-CCC333",
      "00000000-0000-4000-8000-000000000033",
    );
    const second = await removalFixture(
      anchor,
      ".transmute-browser-runtime-DDD444",
      "00000000-0000-4000-8000-000000000044",
    );
    const swap = join(anchor, ".fixture-home-swap");
    await rename(join(first.directory, "home"), swap);
    await rename(join(second.directory, "home"), join(first.directory, "home"));
    await rename(swap, join(second.directory, "home"));

    const removal = removeBrowserRuntimeSnapshot(first);
    expect(removal).rejects.toThrow(/cleanup children changed/u);
    await removal.catch(() => undefined);

    const quarantineName = (await readdir(anchor)).find(name =>
      name.startsWith(".transmute-browser-reclaim-"));
    expect(quarantineName).toBeDefined();
    const quarantine = join(anchor, quarantineName!);
    expect(await readFile(join(quarantine, "home", "identity.txt"), "utf8"))
      .toBe(".transmute-browser-runtime-DDD444");
    expect(await readFile(
      join(second.directory, "home", "identity.txt"),
      "utf8",
    )).toBe(".transmute-browser-runtime-CCC333");
    expect(await readFile(join(quarantine, "browser", "identity.txt"), "utf8"))
      .toBe(".transmute-browser-runtime-CCC333");
    await second.leaseHandle.close();
  });

  test("normal cleanup preserves a peer whose equal-named nested runtime file was swapped", async () => {
    const anchor = await anchorFixture();
    const first = await removalFixture(
      anchor,
      ".transmute-browser-runtime-EEE555",
      "00000000-0000-4000-8000-000000000055",
    );
    const second = await removalFixture(
      anchor,
      ".transmute-browser-runtime-FFF666",
      "00000000-0000-4000-8000-000000000066",
    );
    const firstNested = join(
      first.runtimeRoot,
      "Contents",
      "Frameworks",
      "shared.bin",
    );
    const secondNested = join(
      second.runtimeRoot,
      "Contents",
      "Frameworks",
      "shared.bin",
    );
    const swap = join(anchor, ".fixture-nested-swap");
    await rename(firstNested, swap);
    await rename(secondNested, firstNested);
    await rename(swap, secondNested);

    const removal = removeBrowserRuntimeSnapshot(first);
    expect(removal).rejects.toThrow(/cleanup descendants changed/u);
    await removal.catch(() => undefined);

    const quarantineName = (await readdir(anchor)).find(name =>
      name.startsWith(".transmute-browser-reclaim-"));
    expect(quarantineName).toBeDefined();
    const quarantine = join(anchor, quarantineName!);
    expect(await readFile(
      join(quarantine, "browser", "Contents", "Frameworks", "shared.bin"),
      "utf8",
    )).toBe(".transmute-browser-runtime-FFF666");
    expect(await readFile(secondNested, "utf8"))
      .toBe(".transmute-browser-runtime-EEE555");
    await second.leaseHandle.close();
  });

  test("released lease survives partial cleanup and is reclaimed in the same process", async () => {
    const anchor = await anchorFixture();
    const fixture = await removalFixture(
      anchor,
      ".transmute-browser-runtime-GGG777",
      "00000000-0000-4000-8000-000000000077",
    );
    let quarantine = "";
    const removal = removeBrowserRuntimeSnapshot({
      ...fixture,
      releaseAndRemove: async path => {
        quarantine = path;
        await rm(join(path, "browser"), { force: true, recursive: true });
        throw new Error("fixture crash during child cleanup");
      },
    });
    expect(removal).rejects.toThrow("fixture crash during child cleanup");
    await removal.catch(() => undefined);

    const releasedLease = JSON.parse(
      await readFile(join(quarantine, LEASE_FILE), "utf8"),
    ) as { state?: unknown };
    expect(releasedLease.state).toBe("released");
    expect(await pathExists(join(quarantine, "browser"))).toBe(false);

    const removed: string[] = [];
    const reclaimed = await scavengeStaleBrowserRuntimeSnapshots({
      anchorPath: anchor,
      now: () => new Date("2026-07-28T16:00:01.000Z"),
      processAlive: () => true,
      releaseAndRemove: async path => {
        removed.push(path);
        await rm(path, { force: true, recursive: true });
      },
      staleAfterMs: 60 * 60_000,
      treeOpenState: () => Promise.resolve("closed"),
    });

    expect(reclaimed).toEqual([quarantine]);
    expect(removed).toHaveLength(1);
    expect(await pathExists(quarantine)).toBe(false);
  });
});
