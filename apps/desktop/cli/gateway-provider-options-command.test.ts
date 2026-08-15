import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import type { RepositoryPaths } from "./paths";
import type { CliIo } from "./io";
import { createCliTestRunner } from "./run-cli-test-helper";

const runCli = createCliTestRunner(import.meta.url);

test("provider-options inspect emits only the reusable secret-free summary", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "atet-provider-options-inspect-")),
  );
  try {
    const paths: RepositoryPaths = {
      artifactRoot: join(root, "artifacts", "atet", "recordings"),
      desktopRoot: join(root, "desktop"),
      privateRoot: join(root, "artifacts", "atet", "private"),
      projectRoot: join(root, "artifacts", "atet", "projects"),
      repositoryRoot: root,
    };
    await mkdir(paths.desktopRoot, { recursive: true });
    const optionPath = join(root, "gateway-options.json");
    const rawSecret = "provider-secret-must-not-print";
    await writeFile(
      optionPath,
      JSON.stringify({
        openai: { apiKey: rawSecret },
        xai: { region: "us-east" },
      }),
      { encoding: "utf8", mode: 0o600 },
    );
    let stdout = "";
    let stderr = "";
    const io: CliIo = {
      cwd: () => root,
      env: {},
      now: () => new Date("2026-07-23T16:00:00.000Z"),
      platform: process.platform,
      stderr: value => { stderr += value; },
      stdout: value => { stdout += value; },
    };
    expect(await runCli([
      "ai",
      "provider-options",
      "inspect",
      optionPath,
      "--json",
    ], { io, paths })).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).not.toContain(rawSecret);
    const output: unknown = JSON.parse(stdout);
    expect(output).toMatchObject({
      namespaces: ["openai", "xai"],
    });
    if (
      typeof output !== "object"
      || output === null
      || Array.isArray(output)
      || !("sha256" in output)
      || typeof output.sha256 !== "string"
    ) {
      throw new Error("Expected a provider-options summary digest.");
    }
    expect(output.sha256).toMatch(/^[a-f0-9]{64}$/u);

    await chmod(optionPath, 0o644);
    stdout = "";
    stderr = "";
    expect(await runCli([
      "ai",
      "provider-options",
      "inspect",
      optionPath,
      "--json",
    ], { io, paths })).toBe(6);
    expect(stdout).toBe("");
    expect(stderr).toContain("private 0600 physical file");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
