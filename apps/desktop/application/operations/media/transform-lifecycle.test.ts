import { afterEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Cause, Effect, Exit, Fiber } from "effect";

import type { AudioEffectsTransformV1, ColorGradeTransformV1 } from "../../../contracts";
import { LocalMediaEffectsService } from "../../../cli/media-effects-service";
import type { ProbedMedia } from "../../../cli/media-ingest";
import type { OperationExecutionContext } from "../../operation";
import { OPERATION_COMPLETION_CHECKPOINT_FILE } from "../../operation-completion-checkpoint";
import { operationBoundary, operationFinally, type OperationEffectFailure } from "../../operation-effects";
import { OperationRegistry } from "../../registry";
import { operationApplicationContext } from "../test-support";
import { createMediaAudioEffectsOperationDefinition, mediaAudioEffectsProgram, type MediaAudioEffectsOutput } from "./audio-effects";
import { createMediaColorGradeOperationDefinition, mediaColorGradeProgram, type MediaColorGradeOutput } from "./color-grade";
import { bindMediaCapabilities } from "./capabilities";
import { createMediaTransformPlatform, MediaTransformPlatform, type MediaTransformPlatformService } from "./transform-platform";

const roots: string[] = [];
const audio = {
  audioStreamIndex: 0, effects: [{ kind: "volume", gainDb: -3 }],
  kind: "atet.audio-effects-transform", output: { kind: "audio-only", profile: "wav-pcm-s16le" }, schemaVersion: 1,
} satisfies AudioEffectsTransformV1;
const color = {
  grade: { kind: "preset", preset: "clean" }, kind: "atet.color-grade-transform",
  outputProfile: "h264-mp4", schemaVersion: 1, videoStreamIndex: 0,
} satisfies ColorGradeTransformV1;
const outputBytes = Buffer.from("derived media fixture");
const outputDigest = createHash("sha256").update(outputBytes).digest("hex");

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { force: true, recursive: true });
});

function probe(kind: "audio" | "color"): ProbedMedia {
  const shared = {
    index: 0, assetRange: { startUs: 0, endUs: 2_000_000 }, fileRange: { startUs: 0, endUs: 2_000_000 },
  };
  return {
    container: "fixture", durationUs: 2_000_000,
    streams: kind === "audio"
      ? [{ ...shared, codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2 }]
      : [{ ...shared, codec_type: "video", codec_name: "h264", avg_frame_rate: "30/1", width: 1920, height: 1080 }],
  };
}

async function fixture(workflow = false) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "atet-transform-owner-")));
  roots.push(root);
  const source = "artifacts/atet/recordings/source.media";
  const sourcePath = join(root, source);
  await fs.mkdir(join(root, "artifacts/atet/recordings"), { recursive: true });
  await fs.writeFile(sourcePath, "immutable input", { mode: 0o600 });
  const controller = new AbortController();
  const application = operationApplicationContext(root, {
    capabilities: () => Promise.resolve((["ffmpeg", "ffprobe"] as const).map(name => ({
      available: true, command: Bun.which("true") ?? "/usr/bin/true", name, version: `${name} fixture`,
    }))),
  });
  const workspaceDirectory = join(application.paths.privateRoot, "runs/transform-fixture");
  if (workflow) await fs.mkdir(workspaceDirectory, { mode: 0o700, recursive: true });
  const context: OperationExecutionContext = {
    application, abortSignal: controller.signal,
    ...(workflow ? { workflow: {
      beforePublication: () => Promise.resolve(), nodeKey: "transform", nodePlanSha256: "a".repeat(64),
      runId: "run_transform", workspaceDirectory,
    } } : {}),
  };
  const capabilityBindings = await bindMediaCapabilities(application, ["ffmpeg", "ffprobe"]);
  return { root, source, sourcePath, controller, context, capabilityBindings, workspaceDirectory };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function program(kind: "audio" | "color", input: Fixture): Effect.Effect<
  MediaAudioEffectsOutput | MediaColorGradeOutput, OperationEffectFailure, MediaTransformPlatform
> {
  const bound = { input: { path: input.source }, capabilityBindings: input.capabilityBindings };
  return kind === "audio"
    ? mediaAudioEffectsProgram({ ...bound, transform: audio })
    : mediaColorGradeProgram({ ...bound, transform: color });
}

function nativePlatform(input: Fixture, kind: "audio" | "color") {
  return createMediaTransformPlatform(input.context, {
    probe: () => Promise.resolve(probe(kind)),
    renderAudio: async options => {
      await fs.writeFile(options.outputPath, outputBytes, { mode: 0o600 });
      return { bytes: outputBytes.length, sha256: outputDigest, outputPath: options.outputPath, filterGraph: "audio fixture", transform: options.transform };
    },
    renderColor: async options => {
      await fs.writeFile(options.outputPath, outputBytes, { mode: 0o600 });
      return { bytes: outputBytes.length, sha256: outputDigest, outputPath: options.outputPath, filterGraph: "color fixture", transform: options.transform };
    },
  });
}

async function enteredBeforeSettlement<A>(entered: Promise<A>, settled: Promise<unknown>): Promise<A> {
  return await Promise.race([entered, settled.then(() => { throw new Error("Native fixture settled before the expected custody boundary."); })]);
}

async function interrupt(fiber: Fiber.RuntimeFiber<unknown, OperationEffectFailure>): Promise<void> {
  await Effect.runPromise(Fiber.interruptFork(fiber));
  await new Promise<void>(resolve => { setImmediate(resolve); });
}

test.each(["audio", "color"] as const)("%s registry dispatch composes the native pinned renderer without a Promise facade", async kind => {
  const input = await fixture(true);
  const borrowedMarker = join(input.workspaceDirectory, "caller-owned");
  await fs.writeFile(borrowedMarker, "retain");
  let renders = 0;
  let pinned = 0;
  const context: OperationExecutionContext = {
    ...input.context,
    application: { ...input.context.application, runner: {
      run: async (argv, options) => {
        renders += 1;
        pinned += options?.inheritedFileDescriptors?.length ?? 0;
        await fs.writeFile(argv.at(-1)!, outputBytes, { mode: 0o600 });
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    } },
  };
  const facade = spyOn(LocalMediaEffectsService.prototype, kind === "audio" ? "renderAudio" : "renderColor")
    .mockImplementation(() => { throw new Error("Native registry must not call the standalone facade."); });
  try {
    const registry = new OperationRegistry();
    if (kind === "audio") registry.register(createMediaAudioEffectsOperationDefinition({ probe: () => Promise.resolve(probe(kind)) }));
    else registry.register(createMediaColorGradeOperationDefinition({ probe: () => Promise.resolve(probe(kind)) }));
    const result = await registry.execute(context, {
      kind: kind === "audio" ? "media.audio-effects" : "media.color-grade", version: 1,
      input: { input: { path: input.source }, capabilityBindings: input.capabilityBindings, transform: kind === "audio" ? audio : color },
    });
    expect(facade).not.toHaveBeenCalled();
    expect(renders).toBe(1);
    expect(pinned).toBe(1);
    expect(result.receiptReference).toBeDefined();
    const checkpoint = JSON.parse(await fs.readFile(join(input.workspaceDirectory, OPERATION_COMPLETION_CHECKPOINT_FILE), "utf8")) as { output: unknown };
    expect(checkpoint.output).toEqual(result.output);
    expect(await fs.readFile(borrowedMarker, "utf8")).toBe("retain");
  } finally { facade.mockRestore(); }
});

test.each(["audio", "color"] as const)("%s late workspace acquisition is released before interrupted execution settles", async kind => {
  const input = await fixture();
  const platform = nativePlatform(input, kind);
  const acquired = Promise.withResolvers<string>();
  const release = Promise.withResolvers<void>();
  let disposed = false;
  const controlled: MediaTransformPlatformService = {
    ...platform,
    workspace: () => Effect.flatMap(platform.workspace(), workspace => operationBoundary("workspace", async () => {
      acquired.resolve(workspace.path);
      await release.promise;
      return workspace;
    })),
    dispose: workspace => Effect.tap(platform.dispose(workspace), () => Effect.sync(() => { disposed = true; })),
  };
  const fiber = Effect.runFork(program(kind, input).pipe(Effect.provideService(MediaTransformPlatform, controlled)));
  const completion = Effect.runPromise(Fiber.await(fiber));
  try {
    const path = await enteredBeforeSettlement(acquired.promise, completion);
    await interrupt(fiber);
    expect(disposed).toBe(false);
    expect((await fs.stat(path)).isDirectory()).toBe(true);
    release.resolve();
    expect(Exit.isFailure(await completion)).toBe(true);
    expect(disposed).toBe(true);
    await expect(fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { release.resolve(); await Effect.runPromise(Fiber.interrupt(fiber)); }
});

test.each(["audio", "color"] as const)("%s interrupted output probe keeps its workspace until the native read settles", async kind => {
  const input = await fixture();
  const started = Promise.withResolvers<string>();
  const release = Promise.withResolvers<void>();
  const native = nativePlatform(input, kind);
  const platform = {
    ...native,
    probe: createMediaTransformPlatform(input.context, { probe: async (_ffprobe, _runner, path) => {
      if (path !== input.sourcePath) { started.resolve(path); await release.promise; }
      return probe(kind);
    } }).probe,
  };
  const fiber = Effect.runFork(program(kind, input).pipe(Effect.provideService(MediaTransformPlatform, platform)));
  const completion = Effect.runPromise(Fiber.await(fiber));
  try {
    const path = await enteredBeforeSettlement(started.promise, completion);
    await interrupt(fiber);
    expect(await fs.readFile(path)).toEqual(outputBytes);
    release.resolve();
    expect(Exit.isFailure(await completion)).toBe(true);
    await expect(fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { release.resolve(); await Effect.runPromise(Fiber.interrupt(fiber)); }
});

test.each(["audio", "color"] as const)("%s admitted publication joins its real link, receipt and checkpoint after fiber interruption", async kind => {
  const input = await fixture(true);
  const nativeLink = fs.link;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const linkSpy = spyOn(fs, "link").mockImplementation(async (from, to) => {
    if (String(to).includes("/outputs/")) { entered.resolve(); await release.promise; }
    return await nativeLink(from, to);
  });
  const fiber = Effect.runFork(program(kind, input).pipe(Effect.provideService(MediaTransformPlatform, nativePlatform(input, kind))));
  const completion = Effect.runPromise(Fiber.await(fiber));
  try {
    await enteredBeforeSettlement(entered.promise, completion);
    await interrupt(fiber);
    await expect(fs.stat(join(input.workspaceDirectory, OPERATION_COMPLETION_CHECKPOINT_FILE))).rejects.toMatchObject({ code: "ENOENT" });
    release.resolve();
    const result = await completion;
    expect(Exit.isFailure(result)).toBe(true);
    const checkpoint = JSON.parse(await fs.readFile(join(input.workspaceDirectory, OPERATION_COMPLETION_CHECKPOINT_FILE), "utf8")) as {
      output: { artifact: { path: string; sha256: string }; receipt: { path: string } };
    };
    expect(checkpoint.output.artifact.sha256).toBe(outputDigest);
    expect(await fs.readFile(join(input.root, checkpoint.output.artifact.path))).toEqual(outputBytes);
    const receipt = JSON.parse(await fs.readFile(join(input.root, checkpoint.output.receipt.path), "utf8")) as { output: { sha256: string } };
    expect(receipt.output.sha256).toBe(outputDigest);
  } finally {
    release.resolve(); await Effect.runPromise(Fiber.interrupt(fiber)); linkSpy.mockRestore();
  }
});

test.each(["audio", "color"] as const)("%s receipt failure keeps the published output and does not fabricate a checkpoint", async kind => {
  const input = await fixture(true);
  const failure = new Error("native receipt link failure");
  const nativeLink = fs.link;
  const linkSpy = spyOn(fs, "link").mockImplementation(async (from, to) => {
    if (String(to).includes("/receipts/")) throw failure;
    return await nativeLink(from, to);
  });
  try {
    const exit = await Effect.runPromiseExit(program(kind, input).pipe(Effect.provideService(MediaTransformPlatform, nativePlatform(input, kind))));
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Array.from(Cause.failures(exit.cause)).map(value => value.cause)).toEqual([failure]);
    const output = join(dirname(input.context.application.paths.artifactRoot), "generated/media-operations/outputs", `${outputDigest}${kind === "audio" ? ".wav" : ".mp4"}`);
    expect(await fs.readFile(output)).toEqual(outputBytes);
    await expect(fs.stat(join(input.workspaceDirectory, OPERATION_COMPLETION_CHECKPOINT_FILE))).rejects.toMatchObject({ code: "ENOENT" });
  } finally { linkSpy.mockRestore(); }
});

test.each([undefined, null, false, new Error("workspace cleanup")])("workspace cleanup rejection %p wins without exposing the private primary", async cleanupFailure => {
  const input = await fixture();
  const primary = new Error("private rendering detail");
  const platform = createMediaTransformPlatform(input.context, {
    probe: () => Promise.resolve(probe("audio")), renderAudio: () => Promise.reject(primary),
  });
  const controlled: MediaTransformPlatformService = {
    ...platform,
    dispose: workspace => operationFinally(platform.dispose(workspace), Effect.fail({
      _tag: "OperationBoundaryFailure", phase: "cleanup", cause: cleanupFailure,
    })),
  };
  const exit = await Effect.runPromiseExit(program("audio", input).pipe(Effect.provideService(MediaTransformPlatform, controlled)));
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    const failures = Array.from(Cause.failures(exit.cause));
    expect(failures).toHaveLength(1);
    expect(failures[0]?.cause).toBe(cleanupFailure);
    expect(failures[0]?.priorCause && Array.from(Cause.failures(failures[0].priorCause)).map(failure => failure.cause)).toEqual([primary]);
  }
  expect(Object.keys(primary)).toEqual([]);
  expect(await fs.readdir(join(input.context.application.paths.privateRoot, "media-operations"))).toEqual([]);
});
