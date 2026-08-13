import { describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ApplicationContext } from "./context";
import {
  ExactCapabilityApplicationRunner,
  assertExactCapabilityBindings,
  bindExactCapabilities,
} from "./capability-binding";

function application(
  root: string,
  executable: string,
  onRun: () => void = () => undefined,
): ApplicationContext {
  const capability = {
    available: true,
    command: executable,
    name: "ffmpeg" as const,
    version: "same reported version",
  };
  return {
    capabilities: () => Promise.resolve([capability]),
    capability: name => Promise.resolve(name === capability.name
      ? capability
      : {
          available: false,
          name,
          reason: "Capability was not configured for this fixture.",
        }),
    clock: {
      now: () => new Date("2026-07-23T00:00:00.000Z"),
      timestampMilliseconds: () => 0,
    },
    paths: {
      artifactRoot: join(root, "artifacts"),
      desktopRoot: root,
      privateRoot: join(root, "private"),
      projectRoot: join(root, "projects"),
      repositoryRoot: root,
    },
    runner: {
      run: () => {
        onRun();
        return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
      },
    },
  };
}

describe("exact application capability bindings", () => {
  test("rejects a capability whose identity differs from the requested name", async () => {
    const root = await mkdtemp(join(tmpdir(), "transmute-capability-name-"));
    try {
      const executable = join(root, "ffprobe-fixture");
      await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      const base = application(root, executable);
      const context: ApplicationContext = {
        ...base,
        capability: () => Promise.resolve({
          available: true,
          command: executable,
          name: "ffprobe",
          version: "wrong capability",
        }),
      };

      expect(bindExactCapabilities(context, ["ffmpeg"])).rejects.toMatchObject({
        code: "internal",
        details: {
          requestedCapability: "ffmpeg",
          returnedCapability: "ffprobe",
        },
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("executes the descriptor-pinned bytes across a rename-over at launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "transmute-capability-pin-race-"));
    try {
      const executable = join(root, "ffmpeg-fixture");
      const replacement = join(root, "ffmpeg-replacement");
      await Promise.all([
        writeFile(
          executable,
          "#!/bin/sh\nprintf original-executable\n",
          { mode: 0o700 },
        ),
        writeFile(
          replacement,
          "#!/bin/sh\nprintf replaced-executable\n",
          { mode: 0o700 },
        ),
      ]);
      await Promise.all([
        chmod(executable, 0o700),
        chmod(replacement, 0o700),
      ]);
      const base = application(root, executable);
      let delegatedPath = "";
      const context: ApplicationContext = {
        ...base,
        runner: {
          run: async argv => {
            delegatedPath = argv[0];
            // This is the exact handoff boundary: the wrapper has completed
            // verification and is delegating the launch to the trusted host
            // runner. Replacing the probed pathname here must not affect it.
            await rename(replacement, executable);
            const child = Bun.spawn([...argv], {
              stderr: "pipe",
              stdin: "ignore",
              stdout: "pipe",
            });
            const [exitCode, stderr, stdout] = await Promise.all([
              child.exited,
              new Response(child.stderr).text(),
              new Response(child.stdout).text(),
            ]);
            return { exitCode, stderr, stdout };
          },
        },
      };
      const binding = await bindExactCapabilities(context, ["ffmpeg"]);
      const result = await new ExactCapabilityApplicationRunner(
        context.runner,
        binding,
        context.paths.privateRoot,
      ).run([executable]);

      expect(result).toMatchObject({
        exitCode: 0,
        stdout: "original-executable",
      });
      expect(delegatedPath).not.toBe(await realpath(executable));
      expect(delegatedPath).toContain("/capability-pins-v1/");
      expect(delegatedPath).toEndWith("/ffmpeg-fixture");
      expect((await lstat(delegatedPath)).mode & 0o777).toBe(0o500);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("rejects same-version executable replacement before process launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "transmute-exact-capability-"));
    try {
      const executable = join(root, "ffmpeg-fixture");
      await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      await chmod(executable, 0o700);
      let delegated = 0;
      const context = application(root, executable, () => {
        delegated += 1;
      });
      const binding = await bindExactCapabilities(context, ["ffmpeg"]);
      expect(binding[0]).toMatchObject({
        command: executable,
        executablePath: await realpath(executable),
        name: "ffmpeg",
        version: "same reported version",
      });
      expect(binding[0]?.executableSha256).toMatch(/^[a-f0-9]{64}$/u);

      const runner = new ExactCapabilityApplicationRunner(
        context.runner,
        binding,
        context.paths.privateRoot,
      );
      await runner.run([executable, "-version"]);
      expect(delegated).toBe(1);

      // Same path, size, mode, and reported version; only the executable bytes
      // differ. Neither a fresh exact binding nor the per-spawn guard accepts it.
      await writeFile(executable, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
      expect(assertExactCapabilityBindings(
        context,
        binding,
        ["ffmpeg"],
      )).rejects.toMatchObject({ code: "conflict" });
      expect(runner.run([executable, "-version"])).rejects.toMatchObject({
        code: "conflict",
      });
      expect(delegated).toBe(1);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
