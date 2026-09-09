import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { RepositoryRelativePathSchema } from "../contracts/recording";
import { SPATIAL_PROJECT_LIMITS } from "../contracts/spatial-project";
import type { BundleFileIntegrity } from "./storage";

/** A successful result proves exact file bytes and their ancestor entries durable. */
export interface SpatialDurabilityPort {
  syncExactFile(path: string, expected: BundleFileIntegrity): Promise<void>;
}

/**
 * The caller holds the project publication lease through this operation. No
 * rewrite is used to obtain durability: an already-published inode is flushed
 * and rechecked, including every newly-created ancestor through the bundle root.
 */
export function createNodeSpatialDurability(bundleRoot: string): SpatialDurabilityPort {
  const root = resolve(bundleRoot);
  return {
    async syncExactFile(pathInput, expected) {
      const path = RepositoryRelativePathSchema.parse(pathInput);
      if (!Number.isSafeInteger(expected.bytes) || expected.bytes < 1
        || expected.bytes > SPATIAL_PROJECT_LIMITS.payloadBytes || !/^[a-f0-9]{64}$/u.test(expected.sha256)) {
        throw new Error("Invalid spatial durability byte contract.");
      }
      const target = resolve(root, path);
      const within = relative(root, target);
      if (within === "" || within.startsWith(`..${sep}`) || within === "..") throw new Error("Spatial file escapes its root.");
      const parents: Array<{ path: string; handle: FileHandle; dev: number; ino: number }> = [];
      let file: FileHandle | undefined;
      let primaryFailure: unknown;
      let failed = false;
      try {
        const parts = relative(root, dirname(target)).split(sep).filter(Boolean);
        let current = root;
        for (const part of ["", ...parts]) {
          if (part !== "") current = join(current, part);
          const lexical = await lstat(current);
          if (lexical.isSymbolicLink() || !lexical.isDirectory()) throw new Error("Spatial durability requires physical ancestor directories.");
          const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
          parents.push({ path: current, handle, dev: lexical.dev, ino: lexical.ino });
          const physical = await handle.stat();
          if (!physical.isDirectory() || physical.dev !== lexical.dev || physical.ino !== lexical.ino) {
            throw new Error("Spatial ancestor changed during durability admission.");
          }
        }
        const actualRoot = await realpath(root);
        const actualTarget = await realpath(target);
        if (actualTarget !== join(actualRoot, path)) throw new Error("Spatial file ancestry was redirected.");
        const lexical = await lstat(target);
        if (lexical.isSymbolicLink() || !lexical.isFile() || lexical.size !== expected.bytes) throw new Error("Spatial durability requires exact bounded regular bytes.");
        file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = await file.stat();
        if (!before.isFile() || before.dev !== lexical.dev || before.ino !== lexical.ino || before.size !== expected.bytes) throw new Error("Spatial file changed during durability admission.");
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let offset = 0;
        while (offset < expected.bytes) {
          const read = await file.read(buffer, 0, Math.min(buffer.length, expected.bytes - offset), offset);
          if (read.bytesRead === 0) throw new Error("Spatial durability file was truncated.");
          offset += read.bytesRead;
          hash.update(buffer.subarray(0, read.bytesRead));
        }
        if (hash.digest("hex") !== expected.sha256) throw new Error("Spatial durability digest mismatch.");
        await file.sync();
        for (const parent of [...parents].reverse()) await parent.handle.sync();
        const after = await file.stat();
        const named = await lstat(target);
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
          || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
          || named.isSymbolicLink() || named.dev !== before.dev || named.ino !== before.ino
          || named.size !== before.size || named.mtimeMs !== before.mtimeMs || named.ctimeMs !== before.ctimeMs) {
          throw new Error("Spatial file changed during durability proof.");
        }
        for (const parent of parents) {
          const namedParent = await lstat(parent.path);
          if (namedParent.isSymbolicLink() || !namedParent.isDirectory()
            || namedParent.dev !== parent.dev || namedParent.ino !== parent.ino) throw new Error("Spatial ancestor changed during durability proof.");
        }
        if (await realpath(target) !== actualTarget) throw new Error("Spatial ancestry changed during durability proof.");
      } catch (error) {
        failed = true;
        primaryFailure = error;
      } finally {
        // Settle all descriptor ownership even if a preceding close fails.
        const closed = await Promise.allSettled([...(file === undefined ? [] : [file.close()]), ...parents.map(parent => parent.handle.close())]);
        const failures = closed.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failures.length > 0) {
          primaryFailure = new AggregateError([...(failed ? [primaryFailure] : []), ...failures.map(result => result.reason)], "Spatial durability descriptor close failed.");
          failed = true;
        }
      }
      if (failed) throw primaryFailure;
    },
  };
}
