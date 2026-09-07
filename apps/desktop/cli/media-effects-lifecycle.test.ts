import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { fstatSync, type BigIntStats, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Fiber } from "effect";

import { operationExitValue, type OperationEffectFailure } from "../application/operation-effects";
import type { RunResult } from "./io";
import { LocalMediaEffectsService, type ExpectedLocalMediaInput } from "./media-effects-service";

const transform = {
  audioStreamIndex: 0,
  effects: [{ kind: "volume", gainDb: -3 }],
  kind: "atet.audio-effects-transform",
  output: { kind: "audio-only", profile: "wav-pcm-s16le" },
  schemaVersion: 1,
} as const;

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "atet-transform-pin-")));
  const inputPath = join(root, "source.wav");
  const input = Buffer.from("immutable native fixture");
  await fs.writeFile(inputPath, input, { mode: 0o600 });
  const stat = await fs.lstat(inputPath);
  const expectedInput: ExpectedLocalMediaInput = {
    bytes: input.length, device: stat.dev, inode: stat.ino, modifiedAtMs: stat.mtimeMs,
    sha256: createHash("sha256").update(input).digest("hex"),
  };
  return { root, inputPath, expectedInput, outputPath: join(root, "derived.wav"), transform };
}

function nativeCauses(cause: Cause.Cause<OperationEffectFailure>): unknown[] {
  return Array.from(Cause.failures(cause)).flatMap(failure => [
    failure.cause,
    ...(failure.priorCause === undefined ? [] : nativeCauses(failure.priorCause)),
  ]);
}

test("native transform interruption retains the pinned descriptor and staging until the encoder settles", async () => {
  const input = await fixture();
  const started = Promise.withResolvers<{ descriptor: number; staging: string }>();
  const nativeResult = Promise.withResolvers<RunResult>();
  const service = new LocalMediaEffectsService({
    ffmpeg: "ffmpeg",
    runner: {
      run: async (argv, options) => {
        const descriptor = options?.inheritedFileDescriptors?.[0];
        if (descriptor === undefined) throw new Error("Expected the real pinned input descriptor.");
        const staging = argv.at(-1)!;
        await fs.writeFile(staging, "native output");
        started.resolve({ descriptor, staging });
        return await nativeResult.promise;
      },
    },
  });
  const fiber = Effect.runFork(service.renderAudioEffect(input));
  const completion = Effect.runPromise(Fiber.await(fiber));
  try {
    const native = await Promise.race([
      started.promise,
      completion.then(() => { throw new Error("Encoder never reached its held native result."); }),
    ]);
    await Effect.runPromise(Fiber.interruptFork(fiber));
    await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(fstatSync(native.descriptor).ino).toBe(input.expectedInput.inode);
    expect(await fs.readFile(native.staging, "utf8")).toBe("native output");
    await expect(fs.stat(input.outputPath)).rejects.toMatchObject({ code: "ENOENT" });
    nativeResult.reject(undefined);
    const exit = await completion;
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(nativeCauses(exit.cause)).toContain(undefined);
    expect(() => fstatSync(native.descriptor)).toThrow();
    expect(await fs.readdir(input.root)).toEqual(["source.wav"]);
  } finally {
    nativeResult.resolve({ exitCode: 0, stderr: "", stdout: "" });
    await Effect.runPromise(Fiber.interrupt(fiber));
    await fs.rm(input.root, { recursive: true, force: true });
  }
});

test.each([undefined, null, false, new Error("native close failure")])(
  "pinned input close rejection %p retains exact public precedence and private encoder cause",
  async closeFailure => {
    const input = await fixture();
    const primary = new Error("private encoder detail");
    const nativeOpen = fs.open;
    const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await nativeOpen(...args);
      if (args[0] !== input.inputPath) return handle;
      const close = handle.close.bind(handle);
      handle.close = async () => { await close(); throw closeFailure; };
      return handle;
    });
    const service = new LocalMediaEffectsService({
      ffmpeg: "ffmpeg", runner: { run: () => Promise.reject(primary) },
    });
    try {
      const exit = await Effect.runPromiseExit(service.renderAudioEffect(input));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Array.from(Cause.failures(exit.cause))).toHaveLength(1);
        expect(nativeCauses(exit.cause)).toEqual([closeFailure, primary]);
      }
      const projected = await Promise.resolve().then(() => operationExitValue(exit)).then(
        value => ({ status: "fulfilled", value }),
        (reason: unknown) => ({ status: "rejected", reason }),
      );
      expect(projected).toEqual({ status: "rejected", reason: closeFailure });
      if ("reason" in projected) expect(projected.reason).toBe(closeFailure);
      expect(Object.keys(primary)).toEqual([]);
      expect(await fs.readdir(input.root)).toEqual(["source.wav"]);
    } finally {
      openSpy.mockRestore();
      await fs.rm(input.root, { recursive: true, force: true });
    }
  },
);

test.each([
  { first: "number", value: undefined },
  { first: "bigint", value: null },
  { first: "number", value: false },
  { first: "bigint", value: new Error("first native stat") },
] as const)("pin verification joins both native stats and preserves the first rejection ($first)", async ({ first, value }) => {
  const input = await fixture();
  const bothStarted = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const second = new Error("later private stat failure");
  const nativeOpen = fs.open;
  let closes = 0;
  let renders = 0;
  const openSpy = spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await nativeOpen(...args);
    if (args[0] !== input.inputPath) return handle;
    const close = handle.close.bind(handle);
    let starts = 0;
    function stat(options?: { bigint?: false }): Promise<Stats>;
    function stat(options: { bigint: true }): Promise<BigIntStats>;
    function stat(options?: { bigint?: boolean }): Promise<Stats | BigIntStats>;
    async function stat(options?: { bigint?: boolean }): Promise<Stats | BigIntStats> {
      starts += 1;
      if (starts === 2) bothStarted.resolve(handle.fd);
      if ((options?.bigint === true ? "bigint" : "number") === first) throw value;
      await release.promise;
      throw second;
    }
    handle.stat = stat;
    handle.close = async () => { closes += 1; await close(); };
    return handle;
  });
  const service = new LocalMediaEffectsService({
    ffmpeg: "ffmpeg", runner: { run: () => { renders += 1; return Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }); } },
  });
  const completion = Effect.runPromiseExit(service.renderAudioEffect(input));
  try {
    const descriptor = await Promise.race([
      bothStarted.promise,
      completion.then(() => { throw new Error("Both pin stats must be admitted before failure settles."); }),
    ]);
    await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(closes).toBe(0);
    expect(fstatSync(descriptor).ino).toBe(input.expectedInput.inode);
    release.resolve();
    const exit = await completion;
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Array.from(Cause.failures(exit.cause))).toHaveLength(1);
      expect(Array.from(Cause.failures(exit.cause))[0]?.cause).toBe(value);
      expect(nativeCauses(exit.cause)).toContain(second);
    }
    expect(closes).toBe(1);
    expect(renders).toBe(0);
    expect(() => fstatSync(descriptor)).toThrow();
  } finally {
    release.resolve(); await completion; openSpy.mockRestore();
    await fs.rm(input.root, { recursive: true, force: true });
  }
});
