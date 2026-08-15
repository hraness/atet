import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeBundleFileSystem } from "../core";
import { ensurePrivateDirectory } from "./paths";

function permissionBits(mode: number): number {
  return mode & 0o777;
}

test.skipIf(process.platform === "win32")(
  "recording directories are 0700 and structured outputs are 0600",
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), "atet-permissions-test-"));
    const recordingRoot = join(temporary, "artifacts", "atet", "recordings", "rec_permissions01");
    try {
      await ensurePrivateDirectory(recordingRoot);
      expect(permissionBits((await stat(recordingRoot)).mode)).toBe(0o700);

      const fileSystem = createNodeBundleFileSystem(recordingRoot);
      await fileSystem.writeTextAtomic("manifest.json", "{}\n");
      expect(permissionBits((await stat(join(recordingRoot, "manifest.json"))).mode)).toBe(0o600);

      for (const directory of ["edits", "analysis", "renders"] as const) {
        const absoluteDirectory = join(recordingRoot, directory);
        await ensurePrivateDirectory(absoluteDirectory);
        await fileSystem.writeTextAtomic(`${directory}/result.json`, "{}\n");
        expect(permissionBits((await stat(absoluteDirectory)).mode)).toBe(0o700);
        expect(permissionBits((await stat(join(absoluteDirectory, "result.json"))).mode)).toBe(0o600);
      }
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  },
);
