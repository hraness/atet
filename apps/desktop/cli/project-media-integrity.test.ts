import { afterEach, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256Hex } from "../core/canonical-json";
import * as storage from "../core/storage";
import { fingerprintPhysicalProjectMedia, resolveVerifiedProjectMedia, verifyPhysicalProjectMedia } from "./project-media-integrity";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "slopcamera-project-media-integrity-")));
  roots.push(root);
  const path = join(root, "exact audio.wav"), contents = "exact retained audio bytes";
  await writeFile(path, contents, { mode: 0o600 });
  return { root, path, contents, expected: { bytes: Buffer.byteLength(contents), sha256: sha256Hex(contents) } };
}

test("physical media reads retain exact byte bounds, hashes, and physical path policy", async () => {
  const input = await fixture();
  expect(await fingerprintPhysicalProjectMedia(input.path, input.expected.bytes)).toEqual({ ...input.expected, path: input.path });
  expect(await resolveVerifiedProjectMedia({ repositoryRoot: input.root, path: "exact audio.wav", expected: input.expected, label: "Audio" })).toBe(input.path);
  for (const maximumBytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) {
    await expect(fingerprintPhysicalProjectMedia(input.path, maximumBytes)).rejects.toMatchObject({ code: "invalid-data" });
  }
  await expect(fingerprintPhysicalProjectMedia(input.path, input.expected.bytes - 1)).rejects.toMatchObject({ code: "unsafe-path" });
  await expect(verifyPhysicalProjectMedia(input.path, { ...input.expected, bytes: input.expected.bytes + 1 }, "Audio")).rejects.toThrow("byte length changed");
  await expect(verifyPhysicalProjectMedia(input.path, { ...input.expected, sha256: "0".repeat(64) }, "Audio")).rejects.toThrow("recorded SHA-256 integrity check");
  const linked = join(input.root, "linked.wav"); await symlink(input.path, linked);
  await expect(fingerprintPhysicalProjectMedia(linked, input.expected.bytes)).rejects.toMatchObject({ code: "unsafe-path" });
  await expect(resolveVerifiedProjectMedia({ repositoryRoot: input.root, path: "../outside.wav", expected: input.expected, label: "Audio" })).rejects.toMatchObject({ code: "unsafe-path" });
  const empty = join(input.root, "empty.wav"); await writeFile(empty, "");
  await expect(fingerprintPhysicalProjectMedia(empty, 1)).rejects.toMatchObject({ code: "unsafe-path" });
});

test.each(["once", "repeated", "content", "mode", "growth"] as const)(
  "the production media adapter handles %s changes through coherent bounded inspection", async transition => {
    const input = await fixture();
    const nativeFactory = storage.createNodeBundleFileSystem;
    const attempts: number[] = [];
    const factorySpy = spyOn(storage, "createNodeBundleFileSystem").mockImplementation(root => nativeFactory(root, {
      duringFileInspectionForTesting: async ({ attempt }) => {
        attempts.push(attempt);
        if (transition === "mode") await chmod(input.path, 0o640);
        else if (transition === "growth") await writeFile(input.path, `${input.contents}changed`);
        else if (attempt === 1 || transition === "repeated") {
          const before = await lstat(input.path);
          await chmod(input.path, 0o600);
          expect((await lstat(input.path)).ctimeMs).not.toBe(before.ctimeMs);
        } else if (transition === "content") await writeFile(input.path, "x".repeat(input.expected.bytes));
      },
    }));
    try {
      if (transition === "once") {
        expect(await verifyPhysicalProjectMedia(input.path, input.expected, "Audio")).toBe(input.path);
        expect(await readFile(input.path, "utf8")).toBe(input.contents);
      } else {
        await expect(verifyPhysicalProjectMedia(input.path, input.expected, "Audio")).rejects.toMatchObject({
          code: "conflict", details: { cause: expect.any(Error) },
        });
      }
      expect(attempts).toEqual(transition === "mode" || transition === "growth" ? [1] : [1, 2]);
    } finally { factorySpy.mockRestore(); }
  },
);

test("media cannot become empty between positive-size admission and coherent inspection", async () => {
  const input = await fixture();
  const nativeFactory = storage.createNodeBundleFileSystem;
  const factorySpy = spyOn(storage, "createNodeBundleFileSystem").mockImplementation(root => {
    writeFileSync(input.path, "");
    return nativeFactory(root);
  });
  try {
    await expect(fingerprintPhysicalProjectMedia(input.path, input.expected.bytes)).rejects.toMatchObject({ code: "conflict" });
  } finally { factorySpy.mockRestore(); }
});
