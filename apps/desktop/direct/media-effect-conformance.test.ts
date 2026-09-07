import { expect, test } from "bun:test";
import { defineDirect } from "@hraness/direct";
import { createDirectEffectDriver } from "@hraness/direct/effect";
import { createDirectSession } from "@hraness/direct/testing";
import { createHash } from "node:crypto";
import { fstatSync } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Layer } from "effect";
import { z } from "zod";

import type { RunResult } from "../cli/io";
import { LocalMediaEffectsService } from "../cli/media-effects-service";

const worldSchema = z.object({ publications: z.number().int().nonnegative() });
function session() {
  const result = createDirectSession({
    definition: defineDirect({
      parseWorld: input => worldSchema.parse(input), defaultScenario: "media.empty",
      scenarios: [{ id: "media.empty", title: "Unpublished transform", route: "/", world: { publications: 0 } }],
      coverage: [],
    }),
    activation: { kind: "query", source: "" },
    create: context => createDirectEffectDriver({ context, layer: Layer.empty, clock: "deadline" }),
    observe: driver => driver.observation,
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

/** Real file ownership with a controlled encoder result; no FFmpeg or capture. */
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atet-direct-media-")));
  const inputPath = join(root, "input.wav");
  const bytes = Buffer.from("immutable source fixture");
  await writeFile(inputPath, bytes, { mode: 0o600 });
  const stat = await lstat(inputPath);
  return {
    root, inputPath, outputPath: join(root, "output.wav"),
    expectedInput: {
      bytes: bytes.length, device: stat.dev, inode: stat.ino, modifiedAtMs: stat.mtimeMs,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
    transform: {
      audioStreamIndex: 0, effects: [{ kind: "volume", gainDb: -3 }],
      kind: "atet.audio-effects-transform", output: { kind: "audio-only", profile: "wav-pcm-s16le" }, schemaVersion: 1,
    },
  };
}

test.each(["reset", "dispose"] as const)("Direct %s observes native media custody until the encoder settles", async action => {
  const input = await fixture();
  const owner = session();
  const entered = Promise.withResolvers<{ descriptor: number; staging: string }>();
  const native = Promise.withResolvers<RunResult>();
  let dispatches = 0;
  const service = new LocalMediaEffectsService({ ffmpeg: "fixture", runner: {
    run: async (argv, options) => {
      dispatches += 1;
      const descriptor = options?.inheritedFileDescriptors?.[0];
      const staging = argv.at(-1);
      if (descriptor === undefined || staging === undefined) throw new Error("Missing production media custody.");
      await writeFile(staging, "held native output", { mode: 0o600 });
      entered.resolve({ descriptor, staging });
      return await native.promise;
    },
  } });
  const completion = owner.harness.runExit("media-render", operation => Effect.gen(function*() {
    yield* service.renderAudioEffect(input);
    yield* operation.transact(world => { world.publications += 1; });
  }));
  try {
    const held = await Promise.race([
      entered.promise,
      completion.then(exit => {
        if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
        throw new Error("Media operation settled before native encoder admission.");
      }),
    ]);
    expect(owner.probe.isQuiescent()).toEqual({ ok: true, value: false });
    expect(owner.harness.advance(1000).ok).toBe(true);
    expect(owner.harness.snapshot().pendingOperations).toBe(1);
    if (action === "reset") expect(owner.store.reset({ publications: 0 }).ok).toBe(true);
    else owner.dispose();
    let closed = false;
    const closing = owner.harness.close().then(report => { closed = true; return report; });
    await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(closed).toBe(false);
    expect(owner.probe.isQuiescent()).toEqual({ ok: true, value: false });
    expect(fstatSync(held.descriptor).ino).toBe(input.expectedInput.inode);
    expect(await readFile(held.staging, "utf8")).toBe("held native output");
    expect(dispatches).toBe(1);
    native.reject(undefined);
    const exit = await completion;
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect([...Cause.failures(exit.cause)]).toContainEqual(expect.objectContaining({
        _tag: "OperationBoundaryFailure", cause: undefined,
      }));
    }
    const report = await closing;
    expect(Exit.isSuccess(report.runtime)).toBe(true);
    expect(report.settlementErrors).toEqual([]);
    expect(report.diagnostics).toEqual([]);
    expect(owner.harness.snapshot().pendingOperations).toBe(0);
    expect(owner.probe.isQuiescent()).toEqual({ ok: true, value: true });
    expect(owner.store.getSnapshot().world.publications).toBe(0);
    expect(() => fstatSync(held.descriptor)).toThrow();
    expect(await readdir(input.root)).toEqual(["input.wav"]);
    expect(dispatches).toBe(1);
  } finally {
    native.resolve({ exitCode: 0, stderr: "", stdout: "" });
    owner.dispose();
    await completion;
    await owner.harness.close();
    await rm(input.root, { recursive: true, force: true });
  }
});

test("Direct media completion records one verified publication and closes quiescently", async () => {
  const input = await fixture();
  const owner = session();
  let dispatches = 0;
  const service = new LocalMediaEffectsService({ ffmpeg: "fixture", runner: {
    run: async argv => {
      dispatches += 1;
      await writeFile(argv.at(-1)!, "verified synthetic output", { mode: 0o600 });
      return { exitCode: 0, stderr: "", stdout: "" };
    },
  } });
  try {
    const exit = await owner.harness.runExit("media-render", operation => Effect.gen(function*() {
      const result = yield* service.renderAudioEffect(input);
      yield* operation.transact(world => { world.publications += 1; });
      return result;
    }));
    if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.sha256).toBe(createHash("sha256").update("verified synthetic output").digest("hex"));
    expect(await readFile(input.outputPath, "utf8")).toBe("verified synthetic output");
    expect(owner.store.getSnapshot().world.publications).toBe(1);
    expect(dispatches).toBe(1);
    owner.dispose();
    const report = await owner.harness.close();
    expect(report.operationFailures).toEqual([]);
    // Atomic render deliberately interrupts its scoped output monitor on completion.
    expect(report.childFailures.every(Cause.isInterruptedOnly)).toBe(true);
    expect(report.backgroundFailures).toEqual([]);
    expect(report.diagnostics).toEqual([]);
    expect(owner.probe.isQuiescent()).toEqual({ ok: true, value: true });
  } finally {
    owner.dispose();
    await owner.harness.close();
    await rm(input.root, { recursive: true, force: true });
  }
});
