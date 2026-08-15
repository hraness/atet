import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ApplicationContext } from "../application/context";
import {
  createHostApplicationBuildIdentity,
  createWorkflowRuntimeIdentity,
} from "./runtime-identity";
import { bundleWorkflowSource } from "./source-bundle";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async directory => {
    await rm(directory, { force: true, recursive: true });
  }));
});

describe("workflow runtime identity", () => {
  test("binds the Bun configuration with the allowlisted dependency closure bundled", async () => {
    const root = await mkdtemp(join(tmpdir(), "atet-runtime-identity-"));
    temporaryDirectories.push(root);
    await writeFile(
      join(root, "workflow.ts"),
      "import { seconds } from '@hraness/atet/local/code'; export default seconds(1);\n",
    );
    const bundle = await bundleWorkflowSource({ allowedRoot: root, entryPath: "workflow.ts" });
    const first = await createWorkflowRuntimeIdentity({ bundle });
    const second = await createWorkflowRuntimeIdentity({ bundle });

    expect(first).toEqual(second);
    expect(first.externals).toMatchObject({
      kind: "deny-all",
      modules: [],
    });
    expect(first.bundlerConfigurationSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.externals.policySha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("changes when a selected native capability is replaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "atet-host-runtime-identity-"));
    temporaryDirectories.push(root);
    const executable = join(root, "face-analyzer");
    await writeFile(executable, "native helper v1\n", { mode: 0o700 });
    const application = {
      capabilities: () => Promise.resolve([{
        available: true,
        command: executable,
        name: "face-analyzer",
        version: "face-analyzer 1",
      }]),
      capability: name => Promise.resolve(name === "face-analyzer"
        ? {
            available: true,
            command: executable,
            name,
            version: "face-analyzer 1",
          }
        : { available: false, name }),
      clock: {
        now: () => new Date(0),
        timestampMilliseconds: () => 0,
      },
      paths: {
        artifactRoot: root,
        desktopRoot: root,
        privateRoot: root,
        projectRoot: root,
        repositoryRoot: root,
      },
      runner: {
        run: () => Promise.resolve({
          exitCode: 0,
          stderr: "",
          stdout: "",
        }),
      },
    } satisfies ApplicationContext;
    const first = await createHostApplicationBuildIdentity(application);
    await writeFile(executable, "native helper v2\n", { mode: 0o700 });
    const second = await createHostApplicationBuildIdentity(application);
    expect(first).not.toBe(second);
  });
});
