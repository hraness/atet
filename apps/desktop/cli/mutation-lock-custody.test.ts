import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { chmod, link, lstat, mkdtemp, readFile, rename, rm, utimes, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireMutationLease, MUTATION_LOCK_FILE, MUTATION_LOCK_TEMP_PREFIX } from "./mutation-lock";

const stamp = new Date("2026-01-01T00:00:00Z");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "atet-mutation-custody-"));
  const path = join(root, MUTATION_LOCK_FILE);
  const nativeOpen = fs.open;
  let held: FileHandle | undefined;
  const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await nativeOpen(...args);
    if (String(args[0]).includes(MUTATION_LOCK_TEMP_PREFIX)) {
      held = handle;
      const nativeSync = handle.sync.bind(handle);
      Object.defineProperty(handle, "sync", { value: async () => {
        await nativeSync();
        // Establish an exactly reproducible mtime before custody is captured,
        // so subsequent byte tests exercise the ctime-only verification path.
        await handle.utimes(stamp, stamp);
      } });
    }
    return handle;
  });
  try {
    const lease = await acquireMutationLease(root, { command: "spatial.project", label: "custody fixture" });
    if (held === undefined) throw new Error("The lease did not retain its staged descriptor.");
    const owner = await readFile(path);
    return { root, path, held, lease, owner };
  } finally { openSpy.mockRestore(); }
}

test("refreshes only exact owner custody after metadata drift and cleans it after close", async () => {
  const f = await fixture();
  try {
    const before = await lstat(f.path);
    await chmod(f.path, 0o600);
    const after = await lstat(f.path);
    expect(after.ctimeMs).not.toBe(before.ctimeMs);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    await Promise.all([f.lease.assertOwned(), f.lease.assertOwned(), f.lease.assertOwned()]);
    expect(await readFile(f.path)).toEqual(f.owner);
    await f.lease.close();
    await f.lease.unlinkIfOwned();
    await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(f.lease.assertOwned()).rejects.toThrow("closed descriptor");
  } finally { await f.lease.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("cleanup can prove the original owner after a ctime change following close", async () => {
  const f = await fixture();
  try {
    await f.lease.close();
    await chmod(f.path, 0o600);
    await f.lease.unlinkIfOwned();
    await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { await f.lease.close(); await rm(f.root, { recursive: true, force: true }); }
});

test.each(["bytes", "mode", "link", "path"] as const)("rejects changed %s and never cleans up the changed owner", async transition => {
  const f = await fixture();
  try {
    if (transition === "bytes") {
      const changed = Buffer.from(f.owner);
      changed[changed.length - 1] = 0x20;
      await writeFile(f.path, changed);
      await utimes(f.path, stamp, stamp);
      expect(JSON.parse(changed.toString())).toEqual(JSON.parse(f.owner.toString()));
      expect((await lstat(f.path)).mtimeMs).toBe(stamp.getTime());
    } else if (transition === "mode") await chmod(f.path, 0o640);
    else if (transition === "link") await link(f.path, `${f.path}.alias`);
    else { await rename(f.path, `${f.path}.original`); await writeFile(f.path, f.owner, { mode: 0o600 }); }
    await expect(f.lease.assertOwned()).rejects.toThrow(transition === "bytes" ? "owner bytes" : transition === "link" ? "nlink" : transition === "path" ? "ino" : "mode");
    await f.lease.close();
    await f.lease.unlinkIfOwned();
    expect(await lstat(f.path)).toBeDefined();
    if (transition === "path") expect(await readFile(f.path)).toEqual(f.owner);
  } finally { await f.lease.close(); await rm(f.root, { recursive: true, force: true }); }
});

test.each(["once", "repeated", "bytes"] as const)("performs a bounded coherent owner proof for %s changes during a read", async transition => {
  const f = await fixture();
  const nativeRead = f.held.read.bind(f.held);
  let passes = 0;
  Object.defineProperty(f.held, "read", { configurable: true, value: async (buffer: Buffer, offset: number, length: number, position: number) => {
    const result = await nativeRead(buffer, offset, length, position);
    if (result.bytesRead !== 0) return result;
    passes += 1;
    if (transition === "repeated" || (transition === "once" && passes === 1)) await chmod(f.path, 0o600);
    else if (transition === "bytes" && passes === 1) {
      await writeFile(f.path, `${f.owner.toString().slice(0, -1)} `);
      await utimes(f.path, stamp, stamp);
    }
    return result;
  } });
  try {
    await chmod(f.path, 0o600);
    if (transition === "once") await f.lease.assertOwned();
    else await expect(f.lease.assertOwned()).rejects.toThrow(transition === "bytes" ? "owner bytes" : "ctimeMs");
    expect(passes).toBe(2);
    expect(await lstat(f.path)).toBeDefined();
  } finally { await f.lease.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("serializes a delayed owner proof, concurrent assertion, and caller close", async () => {
  const f = await fixture();
  const nativeRead = f.held.read.bind(f.held);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  let heldReads = 0, active = 0, maximumActive = 0;
  Object.defineProperty(f.held, "read", { value: async (buffer: Buffer, offset: number, length: number, position: number) => {
    heldReads += 1; active += 1; maximumActive = Math.max(maximumActive, active);
    if (heldReads === 1) { enter(); await released; }
    try { return await nativeRead(buffer, offset, length, position); }
    finally { active -= 1; }
  } });
  try {
    await chmod(f.path, 0o600);
    const first = f.lease.assertOwned();
    await entered;
    const second = f.lease.assertOwned();
    let closeFinished = false;
    const closing = f.lease.close().then(() => { closeFinished = true; });
    await Promise.resolve();
    expect(closeFinished).toBe(false);
    expect(heldReads).toBe(1);
    release();
    await Promise.all([first, second, closing]);
    expect(maximumActive).toBe(1);
    expect(closeFinished).toBe(true);
    await f.lease.unlinkIfOwned();
    await expect(lstat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { release(); await f.lease.close(); await rm(f.root, { recursive: true, force: true }); }
});
