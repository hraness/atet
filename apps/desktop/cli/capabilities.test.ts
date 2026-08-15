import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  capabilityCandidates,
  probeCapability,
} from "./capabilities";
import type { CliIo, ProcessRunner } from "./io";
import type { RepositoryPaths } from "./paths";
import { createCliTestRunner } from "./run-cli-test-helper";

const runCli = createCliTestRunner(import.meta.url);

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise rejection.");
}

test("HTML-browser discovery advertises only provenance-verifiable Chrome app candidates", () => {
  const candidates = capabilityCandidates("/desktop", {
    ATET_HTML_BROWSER: "/Custom/Google Chrome.app/Contents/MacOS/Google Chrome",
  }).find(candidate => candidate.name === "html-browser")?.candidates;
  expect(candidates).toEqual([
    "/Custom/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ]);
  expect(candidates).not.toContain("chromium");
  expect(candidates).not.toContain(
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  );
});

test("accepts matching predecessor environment values and rejects renamed conflicts", () => {
  expect(capabilityCandidates("/desktop", {
    TRANSMUTE_CAPTURE_HELPER: "/tools/capture",
  }).find(candidate => candidate.name === "capture-helper")?.candidates[0])
    .toBe("/tools/capture");
  expect(() => capabilityCandidates("/desktop", {
    ATET_CAPTURE_HELPER: "/tools/atet-capture",
    TRANSMUTE_CAPTURE_HELPER: "/tools/transmute-capture",
  })).toThrow("ATET_CAPTURE_HELPER and TRANSMUTE_CAPTURE_HELPER disagree");
});

test("a targeted capability probe does not inspect unrelated executables", async () => {
  const calls: string[][] = [];
  const runner: ProcessRunner = {
    run: (argv) => {
      calls.push([...argv]);
      return Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: "ffmpeg version test\n",
      });
    },
  };

  expect(await probeCapability(runner, "/desktop", {}, "ffmpeg"))
    .toMatchObject({
      available: true,
      command: "ffmpeg",
      name: "ffmpeg",
    });
  expect(calls).toEqual([["ffmpeg", "-version"]]);
});

test("a targeted capability probe forwards its admitted preparation descriptors", async () => {
  let inheritedFileDescriptors: readonly number[] | undefined;
  const runner: ProcessRunner = {
    run: (_argv, options) => {
      inheritedFileDescriptors = options?.inheritedFileDescriptors;
      return Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: "ffmpeg version test\n",
      });
    },
  };

  await probeCapability(
    runner,
    "/desktop",
    {},
    "ffmpeg",
    undefined,
    [42],
  );
  expect(inheritedFileDescriptors).toEqual([42]);
});

test("a targeted capability probe owns its caller's cancellation", async () => {
  const controller = new AbortController();
  let activeProbes = 0;
  let receivedSignal: AbortSignal | undefined;
  let startedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  const runner: ProcessRunner = {
    run: (_argv, options) => {
      receivedSignal = options?.abortSignal;
      activeProbes += 1;
      startedResolve?.();
      return new Promise((_resolve, reject) => {
        const abort = (): void => {
          activeProbes -= 1;
          reject(new Error("fixture capability probe cancelled"));
        };
        if (options?.abortSignal?.aborted === true) abort();
        else options?.abortSignal?.addEventListener("abort", abort, {
          once: true,
        });
      });
    },
  };
  const pending = probeCapability(
    runner,
    "/desktop",
    {},
    "ffmpeg",
    controller.signal,
  );

  await started;
  controller.abort(new Error("fixture operation cancelled"));
  expect(await rejection(pending)).toMatchObject({
    message: "fixture capability probe cancelled",
  });
  expect(receivedSignal).toBe(controller.signal);
  expect(activeProbes).toBe(0);
});

test("doctor remains the explicit exhaustive capability discovery boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "atet-doctor-capabilities-"));
  const browser = join(
    root,
    "Fixture Google Chrome.app",
    "Contents",
    "MacOS",
    "Google Chrome",
  );
  try {
    await mkdir(join(browser, ".."), { recursive: true });
    await writeFile(browser, "fixture browser\n", { mode: 0o700 });
    const calls: string[][] = [];
    const runner: ProcessRunner = {
      run: argv => {
        calls.push([...argv]);
        return Promise.resolve({
          exitCode: 1,
          stderr: "fixture capability unavailable",
          stdout: "",
        });
      },
    };
    let stderr = "";
    let stdout = "";
    const io: CliIo = {
      cwd: () => root,
      env: { ATET_HTML_BROWSER: browser },
      now: () => new Date("2026-07-29T00:00:00.000Z"),
      platform: "linux",
      stderr: value => { stderr += value; },
      stdout: value => { stdout += value; },
    };
    const paths: RepositoryPaths = {
      artifactRoot: join(root, "artifacts", "recordings"),
      desktopRoot: join(root, "desktop"),
      privateRoot: join(root, "artifacts", "private"),
      projectRoot: join(root, "artifacts", "projects"),
      repositoryRoot: root,
    };

    expect(await runCli(["doctor", "--json"], {
      stateRoot: join(root, "auth"),
      io,
      paths,
      runner,
    })).toBe(0);
    expect(stderr).toBe("");
    const tools = (JSON.parse(stdout) as {
      readonly tools: Readonly<Record<string, unknown>>;
    }).tools;
    expect(Object.keys(tools).sort()).toEqual([
      "capture-helper",
      "face-analyzer",
      "ffmpeg",
      "ffprobe",
      "html-browser",
      "rsvg-convert",
      "whisper-cpp",
    ]);
    expect(calls.some(argv => argv[0] === browser)).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
