import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { operationApplicationContext } from "../application/operations/test-support";
import { originalSpz } from "../application/spatial-world-fixture.testing";
import { parseCliArgs } from "./args";
import { executeSpatialWorldCommand } from "./spatial-world-service";
import { createCliTestRunner } from "./run-cli-test-helper";
import type { CliIo } from "./io";

const runCli = createCliTestRunner(import.meta.url);
const savedImport = {
  splat: { path: "saved.spz", bytes: 100, sha256: "a".repeat(64) },
  identities: { assetId: "asset_world", entityId: "entity_world", name: "Saved world" },
  normalization: { metersPerUnit: 1, sourceUp: "y", sourceHandedness: "right", transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
  provenance: { kind: "saved", description: "Explicit saved world" },
};
const importArgv = ["scene", "world", "import", "--input", "import.json", "--source-root", ".", "--output-root", "artifacts/slopcamera/generated/import-test", "--json"];

test("world CLI exposes only local import and rejects retired provider actions", () => {
  expect(parseCliArgs(importArgv)).toMatchObject({ kind: "spatial-world", action: "import", sourceRoot: "." });
  for (const argv of [
    ["plan", "--input", "world.json"],
    ["generate", "--input", "world.json", "--allow-paid-generation", "--budget-id", "samples", "--maximum-credits", "12500"],
    ["inspect", "world_test"], ["resume", "world_test"], ["recover", "world_test", "--operation-id", "operation_test"],
  ]) expect(() => parseCliArgs(["scene", "world", ...argv])).toThrow();
  expect(() => parseCliArgs([...importArgv, "--allow-paid-generation"])).toThrow();
});

test("canonical saved import needs no credential or network and preserves historical attempts", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "slopcamera-world-cli-import-")));
  try {
    const bytes = originalSpz().compressed;
    const input = { ...savedImport, splat: { path: "saved.spz", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } };
    await writeFile(join(root, "saved.spz"), bytes);
    await writeFile(join(root, "import.json"), JSON.stringify(input));
    const retainedDirectory = join(root, "artifacts/slopcamera/generated/worlds/attempts/historical_attempt");
    await mkdir(retainedDirectory, { recursive: true });
    const historicalBytes = '{"preserve":"historical provider evidence"}';
    await writeFile(join(retainedDirectory, "request.json"), historicalBytes);
    const output: string[] = [], errors: string[] = [];
    let networkCalls = 0;
    const io: CliIo = { cwd: () => root, env: {}, now: () => new Date(), platform: process.platform, stdout: value => output.push(value), stderr: value => errors.push(value) };
    const dependencies = { io, paths: operationApplicationContext(root).paths, stateRoot: join(root, "state"),
      fetch: async () => { networkCalls++; throw new Error("Saved import must not access the network"); },
      gatewayMediaDownload: async () => { networkCalls++; throw new Error("Saved import must not download artifacts"); },
    };
    expect(await runCli(importArgv, dependencies)).toBe(0);
    const imported = JSON.parse(output.at(-1)!);
    expect(imported.manifest.capabilities.physics).toBe("unavailable");
    expect(imported.assets).toHaveLength(2);
    expect(await readFile(join(root, "artifacts/slopcamera/generated/import-test", imported.manifest.splat.payload.path))).toEqual(bytes);
    expect(await readFile(join(retainedDirectory, "request.json"), "utf8")).toBe(historicalBytes);
    expect(networkCalls).toBe(0);
    expect(errors).toEqual([]);
    const controller = new AbortController(); controller.abort();
    expect(await runCli(importArgv, { ...dependencies, abortSignal: controller.signal })).toBe(11);
    expect(networkCalls).toBe(0);
    expect(await readFile(join(retainedDirectory, "request.json"), "utf8")).toBe(historicalBytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("world import requires a dedicated generated destination", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "slopcamera-world-cli-destination-")));
  try {
    await writeFile(join(root, "import.json"), JSON.stringify(savedImport));
    await expect(executeSpatialWorldCommand(operationApplicationContext(root), {
      kind: "spatial-world", action: "import", input: "import.json", sourceRoot: root, outputRoot: "src/private-world", json: true,
    }, {})).rejects.toThrow("dedicated directory");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("canonical world CLI reports malformed saved imports as invalid input without network access", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "slopcamera-world-cli-invalid-import-")));
  try {
    const errors: string[] = [], output: string[] = [];
    let networkCalls = 0;
    const io: CliIo = { cwd: () => root, env: {}, now: () => new Date(), platform: process.platform, stdout: value => output.push(value), stderr: value => errors.push(value) };
    const { normalization: _normalization, ...missingNormalization } = savedImport;
    for (const malformed of [missingNormalization, { ...savedImport, identities: { ...savedImport.identities, colliderAssetId: "asset_collider" } }]) {
      await writeFile(join(root, "import.json"), JSON.stringify(malformed));
      const exit = await runCli(importArgv, {
        io, paths: operationApplicationContext(root).paths, stateRoot: join(root, "state"),
        fetch: async () => { networkCalls++; throw new Error("Saved import must not access the network"); },
      });
      expect(exit).toBe(7);
    }
    expect(networkCalls).toBe(0);
    expect(errors.join("") + output.join("")).toContain("invalid-data");
    expect(errors.join("") + output.join("")).not.toContain("internal");
  } finally { await rm(root, { recursive: true, force: true }); }
});
