import { afterEach, expect, test } from "bun:test";
import { link, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureStudioSource, inventoryStudioFiles, verifyStudioSource } from "./studio-files";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() { const root = await realpath(await mkdtemp(join(tmpdir(), "slopcamera-studio-files-"))); roots.push(root); await writeFile(join(root, "scene.py"), "pass\n"); return root; }
test("source capture reads only explicit files and rejects a linked leaf", async () => {
  const root = await fixture(); await writeFile(join(root, "private.txt"), "not selected");
  const bundle = await captureStudioSource({ sourceRoot: root, engine: "manim", entrypoint: { kind: "python", path: "scene.py" }, files: ["scene.py"] });
  expect(bundle.files.map(file => file.path)).toEqual(["scene.py"]);
  await expect(verifyStudioSource(root, bundle)).rejects.toThrow("undeclared");
  await symlink("scene.py", join(root, "linked.py"));
  await expect(captureStudioSource({ sourceRoot: root, engine: "manim", entrypoint: { kind: "python", path: "linked.py" }, files: ["linked.py"] })).rejects.toThrow("physical");
});
test("owned output inventory bounds files and bytes and rejects hard links", async () => {
  const root = await fixture();
  await expect(inventoryStudioFiles(root, 1, 4)).rejects.toThrow("budget");
  expect(await inventoryStudioFiles(root, 1, 5)).toEqual([{ path: "scene.py", bytes: 5 }]);
  await link(join(root, "scene.py"), join(root, "linked.py"));
  await expect(inventoryStudioFiles(root, 10, 100)).rejects.toThrow("singly linked");
});
test("live cache scans tolerate disappearing temporary files while retaining settled limits", async () => {
  const root = await fixture();
  let active = true, iterations = 0;
  const churn = (async () => {
    while (active && iterations < 2_000) {
      const temporary = join(root, `cache-${iterations++}.tmp`), complete = `${temporary}.ready`;
      await writeFile(temporary, "cache");
      await rename(temporary, complete);
      await rm(complete);
    }
  })();
  try {
    for (let index = 0; index < 40; index++) {
      const inventory = await inventoryStudioFiles(root, 8, 128, "live");
      expect(inventory.some(file => file.path === "scene.py" && file.bytes === 5)).toBe(true);
    }
  } finally { active = false; await churn; }
  expect(iterations).toBeGreaterThan(0);
  expect(await inventoryStudioFiles(root, 1, 5)).toEqual([{ path: "scene.py", bytes: 5 }]);
  await expect(inventoryStudioFiles(root, 1, 4, "live")).rejects.toThrow("budget");
  await symlink("scene.py", join(root, "linked.py"));
  await expect(inventoryStudioFiles(root, 8, 128, "live")).rejects.toThrow("symlinks");
  await expect(inventoryStudioFiles(join(root, "missing"), 8, 128, "live")).rejects.toThrow();
});
