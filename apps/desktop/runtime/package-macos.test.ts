import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import {
  verifyFinalRuntimeManifest,
  writeFinalRuntimeManifest,
} from "./package-macos";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function writeSidecars(runtimeRoot: string): Promise<void> {
  const bin = join(runtimeRoot, "bin");
  await mkdir(bin, { recursive: true });
  await Promise.all([
    writeFile(join(bin, "transmute-capture"), "signed capture bytes"),
    writeFile(join(bin, "transmute-face-analyzer"), "signed face analyzer bytes"),
    writeFile(join(bin, "transmute-gateway"), "signed gateway bytes"),
  ]);
}

test("runtime manifest is relocatable and contains no build checkout path", async () => {
  const checkoutRoot = await mkdtemp(join(tmpdir(), "transmute-build-checkout-"));
  const relocationRoot = await mkdtemp(join(tmpdir(), "transmute-relocated-app-"));
  const runtimeRoot = join(checkoutRoot, "Transmute.app", "Contents", "Resources", "runtime");
  const relocatedRuntimeRoot = join(relocationRoot, "Renamed.app", "Contents", "Resources", "runtime");
  try {
    await writeSidecars(runtimeRoot);
    const manifest = await writeFinalRuntimeManifest(runtimeRoot, "1.3.14-test");

    expect(manifest.capture.sha256).toBe(digest("signed capture bytes"));
    expect(manifest.faceAnalyzer.sha256).toBe(digest("signed face analyzer bytes"));
    expect(manifest.gateway.sha256).toBe(digest("signed gateway bytes"));
    expect(manifest.schemaVersion).toBe(2);
    expect(Object.keys(manifest).sort()).toEqual(["capture", "faceAnalyzer", "gateway", "schemaVersion"]);
    expect(await verifyFinalRuntimeManifest(runtimeRoot)).toBeUndefined();

    await cp(runtimeRoot, relocatedRuntimeRoot, { recursive: true });
    expect(await verifyFinalRuntimeManifest(relocatedRuntimeRoot)).toBeUndefined();
    const manifestBytes = await readFile(join(relocatedRuntimeRoot, "manifest.json"), "utf8");
    expect(manifestBytes).not.toContain(checkoutRoot);
    expect(manifestBytes).not.toContain("repository-root.txt");

    await writeFile(join(relocatedRuntimeRoot, "bin", "transmute-gateway"), "mutated after manifest");
    expect(verifyFinalRuntimeManifest(relocatedRuntimeRoot))
      .rejects.toThrow(/final signed sidecars/u);
  } finally {
    await Promise.all([
      rm(checkoutRoot, { force: true, recursive: true }),
      rm(relocationRoot, { force: true, recursive: true }),
    ]);
  }
});
