import { expect, spyOn, test } from "bun:test";
import { fstatSync, readSync } from "node:fs";
import * as fs from "node:fs/promises";
import { chmod, link, mkdtemp, readFile, realpath, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spatialCompositorCadenceSha256 } from "../core/spatial-compositor";
import type { ProcessRunner } from "./io";
import { verifySpatialCompositorOutput } from "./spatial-compositor-verifier";

function request() {
  const cadence = { kind: "atet.spatial-compositor-cadence" as const, schemaVersion: 1 as const,
    projectionSha256: "a".repeat(64), compositionPlanSha256: "b".repeat(64),
    frameRate: { numerator: 30, denominator: 1 }, durationUs: 1_000_000, frameCount: 30 };
  const video = { streams: [{ codec_type: "video", codec_name: "h264", width: 16, height: 16, pix_fmt: "yuv420p", time_base: "1/30",
    start_pts: 0, duration_ts: 30, avg_frame_rate: "30/1", r_frame_rate: "30/1", nb_frames: "30", nb_read_frames: "30" }],
    frames: Array.from({ length: 30 }, (_, index) => ({ best_effort_timestamp: index })) };
  const audio = { streams: [{ codec_type: "audio", codec_name: "aac", time_base: "1/48000", start_pts: 0, duration_ts: 48_000, sample_rate: "48000" }] };
  return { cadence: { cadence, cadenceSha256: spatialCompositorCadenceSha256(cadence) }, video, audio,
    expectedVideo: { pixelWidth: 16, pixelHeight: 16, pixelFormat: "yuv420p" as const }, maximumBytes: 1024, ffprobe: "/usr/bin/ffprobe" };
}

test.each(["stable", "once", "repeated", "bytes", "restored", "mode", "path", "hard-link", "native", "schema"] as const)(
  "timing verification handles %s evidence without re-encoding or trusting a mutable probe interval", async transition => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "atet-compositor-proof-")));
    try {
      const outputPath = join(root, "out.mp4"), original = Buffer.from("original timing bytes");
      const stamp = new Date("2026-01-01T00:00:00Z");
      await writeFile(outputPath, original, { mode: 0o600 }); await utimes(outputPath, stamp, stamp);
      const input = request();
      let calls = 0;
      const descriptors: number[] = [];
      const rounds = [1, 2].map(() => ({ entered: 0, settled: Promise.withResolvers<void>() }));
      const runner: ProcessRunner = { run: async (argv, options) => {
        const roundIndex = Math.floor(calls++ / 2), round = rounds[roundIndex]!;
        expect(argv[0]).toBe(input.ffprobe); expect(argv.at(-1)).toBe("/dev/fd/3");
        const descriptor = options?.inheritedFileDescriptors?.[0];
        expect(descriptor).toBeDefined(); descriptors.push(descriptor!);
        expect(fstatSync(descriptor!).isFile()).toBe(true);
        round.entered += 1;
        if (round.entered === 2) {
          try {
            if ((transition === "once" || transition === "native" || transition === "schema") && roundIndex === 0
              || transition === "repeated") await chmod(outputPath, 0o600);
            else if (transition === "mode") await chmod(outputPath, 0o640);
            else if (transition === "path") {
              await rename(outputPath, `${outputPath}.old`); await writeFile(outputPath, original, { mode: 0o600 });
            } else if (transition === "hard-link") await link(outputPath, `${outputPath}.alias`);
            else if ((transition === "bytes" || transition === "restored") && roundIndex === 0) {
              await writeFile(outputPath, Buffer.alloc(original.length, "x")); await utimes(outputPath, stamp, stamp);
              const observed = Buffer.alloc(original.length);
              readSync(descriptor!, observed, 0, observed.length, 0);
              expect(observed.equals(original)).toBe(false);
              if (transition === "restored") { await writeFile(outputPath, original); await utimes(outputPath, stamp, stamp); }
            }
            round.settled.resolve();
          } catch (cause) { round.settled.reject(cause); }
        }
        await round.settled.promise;
        const video = argv.includes("-count_frames");
        if (transition === "native") return { exitCode: 1, stdout: "", stderr: video ? "video decode reason" : "audio decode reason" };
        if (transition === "schema" && video) return { exitCode: 0, stdout: "not json", stderr: "" };
        // The first interval can observe a transient replacement with valid
        // timing; the restored original must be independently probed again.
        const result = transition === "restored" && roundIndex === 1 && video
          ? { ...input.video, streams: [{ ...input.video.streams[0], width: 32 }] }
          : video ? input.video : input.audio;
        return { exitCode: 0, stdout: JSON.stringify(result), stderr: "" };
      } };
      const operation = verifySpatialCompositorOutput({ ...input, outputPath, runner, signal: new AbortController().signal });
      if (transition === "stable" || transition === "once") expect((await operation).frameCount).toBe(30);
      else {
        const error = await operation.catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        if (transition === "repeated") expect(message).toContain("ctimeNs");
        else if (transition === "bytes") expect(message).toContain("bytes changed");
        else if (transition === "restored") expect(message).toContain("dimensions or pixel format");
        else if (transition === "mode") expect(message).toContain("mode");
        else if (transition === "path") expect(message).toContain("ino");
        else if (transition === "hard-link") expect(message).toContain("nlink");
        else if (transition === "native") {
          expect(message).toContain("video decode reason"); expect(message).toContain("audio decode reason");
          expect((error as AggregateError).errors).toHaveLength(2);
        } else expect(message).toContain("native verification failed");
      }
      expect(calls).toBe(["once", "repeated", "restored"].includes(transition) ? 4 : 2);
      for (const descriptor of descriptors) expect(() => fstatSync(descriptor)).toThrow();
      if (transition === "restored") expect(await readFile(outputPath)).toEqual(original);
    } finally { await rm(root, { recursive: true, force: true }); }
  },
);

test("cancellation drains the admitted probe sibling and preserves native failure diagnostics", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atet-compositor-cancel-")));
  try {
    const outputPath = join(root, "out.mp4"); await writeFile(outputPath, "bounded media");
    const input = request(), controller = new AbortController();
    const entered = Promise.withResolvers<number>(), release = Promise.withResolvers<void>();
    let calls = 0, settled = false;
    const runner: ProcessRunner = { run: async (argv, options) => {
      calls += 1;
      if (argv.includes("-count_frames")) return { exitCode: 1, stdout: "", stderr: "original video failure" };
      entered.resolve(options!.inheritedFileDescriptors![0]!);
      await release.promise;
      return { exitCode: 0, stdout: JSON.stringify(input.audio), stderr: "" };
    } };
    const operation = verifySpatialCompositorOutput({ ...input, outputPath, runner, signal: controller.signal });
    const observed = operation.then(value => { settled = true; return value; }, (cause: unknown) => { settled = true; return cause; });
    const descriptor = await entered.promise;
    controller.abort(new Error("verification cancelled"));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(settled).toBe(false); expect(fstatSync(descriptor).isFile()).toBe(true);
    release.resolve();
    const error = await observed;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as Error).message).toContain("verification cancelled");
    expect((error as Error).message).toContain("original video failure");
    expect(calls).toBe(2); expect(() => fstatSync(descriptor)).toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("probe and descriptor cleanup failures retain both causes after closing the descriptor", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atet-compositor-close-")));
  try {
    const outputPath = join(root, "out.mp4"); await writeFile(outputPath, "bounded media");
    const input = request(), nativeOpen = fs.open;
    let opens = 0, selectedDescriptor: number | undefined;
    const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
      const descriptor = await nativeOpen(...args);
      if (opens++ === 1) {
        selectedDescriptor = descriptor.fd;
        const nativeClose = descriptor.close.bind(descriptor);
        Object.defineProperty(descriptor, "close", { value: async () => {
          await nativeClose(); throw new Error("descriptor cleanup reason");
        } });
      }
      return descriptor;
    });
    try {
      const error = await verifySpatialCompositorOutput({ ...input, outputPath, signal: new AbortController().signal,
        runner: { run: async argv => ({ exitCode: 1, stdout: "", stderr: argv.includes("-count_frames") ? "video failure" : "audio failure" }) },
      }).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as Error).message).toContain("video failure");
      expect((error as Error).message).toContain("audio failure");
      expect((error as Error).message).toContain("descriptor cleanup reason");
      expect(selectedDescriptor).toBeDefined();
      expect(() => fstatSync(selectedDescriptor!)).toThrow();
    } finally { openSpy.mockRestore(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
