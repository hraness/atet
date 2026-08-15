import { expect, test } from "bun:test";
import {
  appendFile,
  link,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { executeAtomicRender } from "./atomic-render";
import type { ProcessRunner } from "./io";

const TEST_MAXIMUM_OUTPUT_BYTES = 1024 * 1024;

function executeTestAtomicRender(
  options: Omit<Parameters<typeof executeAtomicRender>[0], "maximumOutputBytes"> & {
    readonly maximumOutputBytes?: number;
  },
): ReturnType<typeof executeAtomicRender> {
  return executeAtomicRender({
    maximumOutputBytes: TEST_MAXIMUM_OUTPUT_BYTES,
    ...options,
  });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject.");
}

test.skipIf(process.platform === "win32")("commits through a private temp file without mutating a hard-linked target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atet-atomic-render-"));
  try {
    const protectedPath = join(directory, "protected.txt");
    const finalPath = join(directory, "output.mp4");
    await writeFile(protectedPath, "protected");
    await link(protectedPath, finalPath);
    const runner: ProcessRunner = {
      run: async argv => {
        expect(argv).toContain("-n");
        expect(argv).not.toContain("-y");
        await writeFile(argv.at(-1)!, "encoded video");
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    };
    await executeTestAtomicRender({
      argv: ["ffmpeg", "-y", finalPath],
      failureLabel: "FFmpeg failed",
      finalOutputPath: finalPath,
      runner,
    });
    expect(await readFile(protectedPath, "utf8")).toBe("protected");
    expect(await readFile(finalPath, "utf8")).toBe("encoded video");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("preserves the previous render and removes partial output after a failed process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atet-atomic-render-failure-"));
  try {
    const finalPath = join(directory, "output.mp4");
    const companionPath = join(directory, "output.mp4.plan.json");
    await writeFile(finalPath, "prior good render");
    await writeFile(companionPath, "prior plan");
    let published = false;
    const runner: ProcessRunner = {
      run: async argv => {
        expect(argv).toContain("-n");
        await writeFile(argv.at(-1)!, "partial");
        return { exitCode: 1, stderr: "encoder failed", stdout: "" };
      },
    };
    const failure = await rejection(executeTestAtomicRender({
      argv: ["ffmpeg", "-y", finalPath],
      companion: {
        finalPath: companionPath,
        publish: () => {
          published = true;
          return Promise.resolve();
        },
      },
      failureLabel: "FFmpeg failed",
      finalOutputPath: finalPath,
      runner,
    }));
    expect(String(failure)).toContain("encoder failed");
    expect(await readFile(finalPath, "utf8")).toBe("prior good render");
    expect(await readFile(companionPath, "utf8")).toBe("prior plan");
    expect(published).toBe(false);
    expect((await readdir(directory)).filter(name => name.startsWith(".atet-render-"))).toEqual([]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("removes a stale companion if publication fails after the new render commits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atet-atomic-render-companion-"));
  try {
    const finalPath = join(directory, "output.mp4");
    const companionPath = join(directory, "output.mp4.plan.json");
    await writeFile(finalPath, "prior good render");
    await writeFile(companionPath, "prior plan");
    const runner: ProcessRunner = {
      run: async argv => {
        await writeFile(argv.at(-1)!, "new encoded video");
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    };

    const failure = await rejection(executeTestAtomicRender({
      argv: ["ffmpeg", "-y", finalPath],
      companion: {
        finalPath: companionPath,
        publish: () => Promise.reject(new Error("sidecar disk failure")),
      },
      failureLabel: "FFmpeg failed",
      finalOutputPath: finalPath,
      runner,
    }));

    expect(String(failure)).toContain("sidecar disk failure");
    expect(await readFile(finalPath, "utf8")).toBe("new encoded video");
    expect(await readFile(companionPath, "utf8").catch(() => null)).toBeNull();
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("durably removes the old companion before exposing newly committed render bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atet-atomic-render-gated-companion-"));
  try {
    const finalPath = join(directory, "output.mp4");
    const companionPath = join(directory, "output.mp4.plan.json");
    await writeFile(finalPath, "prior good render");
    await writeFile(companionPath, "prior plan");
    let enterPublish!: () => void;
    const publishing = new Promise<void>(resolve => { enterPublish = resolve; });
    let releasePublish!: () => void;
    const publishGate = new Promise<void>(resolve => { releasePublish = resolve; });
    const runner: ProcessRunner = {
      run: async argv => {
        await writeFile(argv.at(-1)!, "new encoded video");
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    };

    const execution = executeTestAtomicRender({
      argv: ["ffmpeg", "-y", finalPath],
      companion: {
        finalPath: companionPath,
        publish: async () => {
          enterPublish();
          await publishGate;
          await writeFile(companionPath, "current plan");
        },
      },
      failureLabel: "FFmpeg failed",
      finalOutputPath: finalPath,
      runner,
    });

    await publishing;
    try {
      expect(await readFile(finalPath, "utf8")).toBe("new encoded video");
      expect(await readFile(companionPath, "utf8").catch(() => null)).toBeNull();
    } finally {
      releasePublish();
    }
    await execution;
    expect(await readFile(companionPath, "utf8")).toBe("current plan");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test.skipIf(process.platform === "win32")("uses no-overwrite mode so a prepositioned temp link fails closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atet-atomic-render-race-"));
  try {
    const protectedPath = join(directory, "protected.txt");
    const finalPath = join(directory, "output.mp4");
    await writeFile(protectedPath, "protected");
    const runner: ProcessRunner = {
      run: async argv => {
        expect(argv).toContain("-n");
        await link(protectedPath, argv.at(-1)!);
        return { exitCode: 1, stderr: "File already exists", stdout: "" };
      },
    };
    const failure = await rejection(executeTestAtomicRender({
      argv: ["ffmpeg", "-y", finalPath],
      failureLabel: "FFmpeg failed",
      finalOutputPath: finalPath,
      runner,
    }));
    expect(String(failure)).toContain("File already exists");
    expect(await readFile(protectedPath, "utf8")).toBe("protected");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("treats the configured maximum output size as an inclusive bound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atet-atomic-render-bound-"));
  try {
    const finalPath = join(directory, "output.mp4");
    const runner: ProcessRunner = {
      run: async argv => {
        // FFmpeg's -fs flag may exit successfully with a truncated container.
        // Growth monitoring bounds the live process, and this complete-output
        // check remains authoritative at the inclusive byte boundary.
        expect(argv).not.toContain("-fs");
        await writeFile(argv.at(-1)!, "12345678");
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    };
    expect(await executeTestAtomicRender({
      argv: ["ffmpeg", "-y", finalPath],
      failureLabel: "FFmpeg failed",
      finalOutputPath: finalPath,
      maximumOutputBytes: 8,
      runner,
    })).toEqual({
      bytes: 8,
      sha256: "ef797c8118f02dfb649607dd5d3f8c7623048c9c063d532cc95c5ed7a898a64f",
    });
    expect(await readFile(finalPath, "utf8")).toBe("12345678");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("aborts and reaps an encoder as soon as private staging exceeds its byte ceiling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atet-atomic-render-growth-bound-"));
  try {
    const finalPath = join(directory, "output.mp4");
    let reaped = false;
    const runner: ProcessRunner = {
      run: async (argv, options) => {
        const signal = options?.abortSignal;
        expect(signal).toBeDefined();
        const temporary = argv.at(-1)!;
        await writeFile(temporary, "12345678");
        await appendFile(temporary, "9");
        if (signal?.aborted !== true) {
          await new Promise<void>(resolveAbort => {
            signal?.addEventListener("abort", () => resolveAbort(), { once: true });
          });
        }
        // ProcessRunner may reject only after its exact child is gone. This
        // delayed marker proves atomic rendering waits for that reap contract.
        await Bun.sleep(5);
        reaped = true;
        throw Object.assign(new Error("encoder killed and reaped"), {
          code: "cancelled",
        });
      },
    };

    const failure = await rejection(executeTestAtomicRender({
      argv: ["ffmpeg", "-y", finalPath],
      failureLabel: "FFmpeg failed",
      finalOutputPath: finalPath,
      maximumOutputBytes: 8,
      runner,
    }));

    expect(failure).toMatchObject({ code: "invalid-data" });
    expect(String(failure)).toContain("while encoding (9 bytes observed)");
    expect(reaped).toBe(true);
    expect(await readFile(finalPath).catch(() => null)).toBeNull();
    expect((await readdir(directory)).filter(name => name.startsWith(".atet-render-")))
      .toEqual([]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}, 5_000);

test("rejects an invalid output bound before starting the renderer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atet-atomic-render-invalid-bound-"));
  try {
    const finalPath = join(directory, "output.mp4");
    let started = false;
    const runner: ProcessRunner = {
      run: () => {
        started = true;
        return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" });
      },
    };
    expect(await rejection(executeTestAtomicRender({
      argv: ["ffmpeg", "-y", finalPath],
      failureLabel: "FFmpeg failed",
      finalOutputPath: finalPath,
      maximumOutputBytes: 0,
      runner,
    }))).toMatchObject({ code: "invalid-data" });
    expect(started).toBe(false);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("passes cancellation to the renderer and publishes no output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atet-atomic-render-cancel-"));
  try {
    const finalPath = join(directory, "output.mp4");
    const controller = new AbortController();
    let rendererStarted!: () => void;
    const started = new Promise<void>(resolveStarted => {
      rendererStarted = resolveStarted;
    });
    const runner: ProcessRunner = {
      run: async (argv, options) => {
        const signal = options?.abortSignal;
        expect(signal).toBeDefined();
        await writeFile(argv.at(-1)!, "partial");
        rendererStarted();
        if (signal?.aborted !== true) {
          await new Promise<void>(resolveAbort => {
            signal?.addEventListener("abort", () => resolveAbort(), { once: true });
          });
        }
        throw Object.assign(new Error("cancelled"), { code: "cancelled" });
      },
    };
    const execution = executeTestAtomicRender({
      abortSignal: controller.signal,
      argv: ["ffmpeg", "-y", finalPath],
      failureLabel: "FFmpeg failed",
      finalOutputPath: finalPath,
      runner,
    });
    await started;
    controller.abort();
    expect(await rejection(execution)).toMatchObject({ code: "cancelled" });
    expect(await readFile(finalPath).catch(() => null)).toBeNull();
    expect((await readdir(directory)).filter(name => name.startsWith(".atet-render-")))
      .toEqual([]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test.skipIf(process.platform === "win32")("encodes in an explicit private workflow staging directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atet-atomic-render-workspace-"));
  const stagingDirectory = await mkdtemp(join(directory, "node-plan-"));
  try {
    const finalPath = join(directory, "public.mp4");
    const runner: ProcessRunner = {
      run: async argv => {
        expect(dirname(argv.at(-1)!)).toBe(await realpath(stagingDirectory));
        await writeFile(argv.at(-1)!, "workspace render", { flag: "wx" });
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    };
    await executeTestAtomicRender({
      argv: ["ffmpeg", "-y", finalPath],
      failureLabel: "FFmpeg failed",
      finalOutputPath: finalPath,
      requireFreshOutput: true,
      runner,
      stagingDirectory,
    });
    expect(await readFile(finalPath, "utf8")).toBe("workspace render");
    expect(await readdir(stagingDirectory)).toEqual([]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
