import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProcessRunner, RunOptions, RunResult } from "./io";
import { BunProcessRunner } from "./io";
import { executeAtomicRender } from "./atomic-render";
import {
  buildAudioEffectsInvocation,
  buildColorGradeInvocation,
  type ExpectedLocalMediaInput,
  LocalMediaEffectsService,
  MAXIMUM_LOCAL_MEDIA_EFFECT_OUTPUT_BYTES,
} from "./media-effects-service";

const FFMPEG = [
  Bun.which("ffmpeg"),
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/opt/local/bin/ffmpeg",
].find((candidate): candidate is string => candidate !== null && candidate !== undefined && existsSync(candidate));

const AUDIO_TRANSFORM = {
  audioStreamIndex: 2,
  effects: [
    { gainDb: -3, kind: "volume" },
    {
      attackMs: 10,
      knee: 2,
      kind: "compressor",
      makeupGainDb: 2,
      ratio: 3,
      releaseMs: 120,
      thresholdDb: -20,
    },
    { decay: 0.5, delayMs: 125, kind: "delay", mix: 0.4 },
    { kind: "reverb", mix: 0.3, preset: "large-hall" },
    { kind: "denoise", noiseFloorDb: -55, noiseReductionDb: 15, trackNoise: true },
  ],
  kind: "studio.audio-effects-transform",
  output: { kind: "audio-only", profile: "wav-pcm-s16le" },
  schemaVersion: 1,
} as const;

class MaterializingRunner implements ProcessRunner {
  readonly calls: Array<readonly [string, ...string[]]> = [];
  readonly options: RunOptions[] = [];

  async run(
    argv: readonly [string, ...string[]],
    options: RunOptions = {},
  ): Promise<RunResult> {
    this.calls.push(argv);
    this.options.push(options);
    await writeFile(argv.at(-1)!, "derived-media");
    return { exitCode: 0, stderr: "", stdout: "" };
  }
}

class FailingRunner implements ProcessRunner {
  calls = 0;

  run(): Promise<RunResult> {
    this.calls += 1;
    return Promise.resolve({ exitCode: 9, stderr: "fixture failure", stdout: "" });
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject.");
}

async function expectedInput(path: string): Promise<ExpectedLocalMediaInput> {
  const [details, bytes] = await Promise.all([lstat(path), readFile(path)]);
  return {
    bytes: bytes.byteLength,
    device: details.dev,
    inode: details.ino,
    modifiedAtMs: details.mtimeMs,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

test("builds an ordered, numeric-only graph for all supported audio effects", () => {
  const inputPath = "/private/input;$(touch-nope).wav";
  const built = buildAudioEffectsInvocation({
    ffmpeg: "/opt/tools/ffmpeg",
    inputPath,
    outputPath: "/private/output.wav",
    transform: AUDIO_TRANSFORM,
  });

  expect(built.filterGraph).toContain("[0:a:2]volume=volume=-3dB[audio_fx_0]");
  expect(built.filterGraph).toContain("[audio_fx_0]acompressor=");
  expect(built.filterGraph).toContain("[audio_fx_1]asplit=8");
  expect(built.filterGraph).toContain(
    "[delay_2_tap_0]adelay=delays=125:all=1,volume=volume=0.4[delay_2_tap_0_gain]",
  );
  expect(built.filterGraph).toContain(
    "[delay_2_tap_6]adelay=delays=875:all=1,volume=volume=0.00625[delay_2_tap_6_gain]",
  );
  expect(built.filterGraph).toContain("amix=inputs=8:duration=longest");
  expect(built.filterGraph).toContain("[audio_fx_2]asplit=6");
  expect(built.filterGraph).toContain("[audio_fx_3]afftdn=nf=-55:nr=15:tn=1[audio_fx_4]");
  expect(built.argv).toContain("[audio_fx_4]");
  expect(built.argv).toContain(inputPath);
  expect(built.argv.filter(argument => argument === inputPath)).toHaveLength(1);
  expect(built.argv).toContain("-xerror");
  expect(built.argv.slice(built.argv.indexOf("-fs"), built.argv.indexOf("-fs") + 2)).toEqual([
    "-fs",
    String(MAXIMUM_LOCAL_MEDIA_EFFECT_OUTPUT_BYTES),
  ]);
  expect(built.argv.slice(-2)).toEqual(["pcm_s16le", "/private/output.wav"]);
  expect(built.argv.every(argument => !argument.includes("shell"))).toBe(true);
});

test("resolves presets, exact overrides, temperature balance, and hue into a color filter", () => {
  const built = buildColorGradeInvocation({
    ffmpeg: "ffmpeg",
    inputPath: "/private/input.mp4",
    outputPath: "/private/output.mp4",
    transform: {
      grade: {
        kind: "preset",
        overrides: { hue: 18, saturation: 1.3 },
        preset: "cinematic",
      },
      kind: "studio.color-grade-transform",
      outputProfile: "h264-mp4",
      schemaVersion: 1,
      videoStreamIndex: 1,
    },
  });

  expect(built.controls).toEqual({
    brightness: -0.02,
    contrast: 1.14,
    gamma: 0.96,
    hue: 18,
    saturation: 1.3,
    temperature: 0.12,
    tint: 0.06,
  });
  expect(built.filter).toContain("eq=brightness=-0.02:contrast=1.14:saturation=1.3:gamma=0.96");
  expect(built.filter).toContain("colorbalance=");
  expect(built.filter).toContain("hue=h=18");
  expect(built.argv.find(argument => argument.startsWith("[0:V:1]"))).toBeDefined();
  expect(built.argv).toContain("-protocol_whitelist");
  expect(built.argv).toContain("-format_whitelist");
  expect(built.argv).toContain("-xerror");
  expect(built.argv.slice(built.argv.indexOf("-fs"), built.argv.indexOf("-fs") + 2)).toEqual([
    "-fs",
    String(MAXIMUM_LOCAL_MEDIA_EFFECT_OUTPUT_BYTES),
  ]);
  expect(built.argv).toContain("0:a?");
  expect(built.argv).toContain("libx264");
});

test("publishes a fresh derived file atomically and never changes its source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atet-media-effects-service-"));
  try {
    const inputPath = join(directory, "source.wav");
    const outputPath = join(directory, "derived.wav");
    await writeFile(inputPath, "immutable-source");
    const before = createHash("sha256").update(await readFile(inputPath)).digest("hex");
    const runner = new MaterializingRunner();
    const service = new LocalMediaEffectsService({ ffmpeg: "ffmpeg-fixture", runner });

    const result = await service.renderAudio({
      expectedInput: await expectedInput(inputPath),
      inputPath,
      outputPath,
      transform: {
        ...AUDIO_TRANSFORM,
        audioStreamIndex: 0,
      },
    });

    expect(createHash("sha256").update(await readFile(inputPath)).digest("hex")).toBe(before);
    expect(await readFile(outputPath, "utf8")).toBe("derived-media");
    expect(result.bytes).toBe(Buffer.byteLength("derived-media"));
    expect(result.outputPath).toBe(outputPath);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toContain("-n");
    expect(runner.calls[0]).not.toContain("-y");
    expect(runner.calls[0]?.at(-1)).not.toBe(outputPath);
    expect(runner.calls[0]).toContain("/dev/fd/3");
    expect(runner.options[0]?.inheritedFileDescriptors).toHaveLength(1);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("refuses existing outputs before starting FFmpeg", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atet-media-effects-conflict-"));
  try {
    const inputPath = join(directory, "source.wav");
    const outputPath = join(directory, "derived.wav");
    await writeFile(inputPath, "immutable-source");
    await writeFile(outputPath, "existing-output");
    const runner = new FailingRunner();
    const service = new LocalMediaEffectsService({ ffmpeg: "ffmpeg-fixture", runner });

    const failure = await rejection(service.renderAudio({
      expectedInput: await expectedInput(inputPath),
      inputPath,
      outputPath,
      transform: { ...AUDIO_TRANSFORM, audioStreamIndex: 0 },
    }));
    expect(failure).toMatchObject({ code: "conflict" });
    expect(runner.calls).toBe(0);
    expect(await readFile(outputPath, "utf8")).toBe("existing-output");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("cleans temporary state and leaves no output when FFmpeg fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atet-media-effects-failure-"));
  try {
    const inputPath = join(directory, "source.wav");
    const outputPath = join(directory, "derived.wav");
    await writeFile(inputPath, "immutable-source");
    const runner = new FailingRunner();
    const service = new LocalMediaEffectsService({ ffmpeg: "ffmpeg-fixture", runner });

    const failure = await rejection(service.renderAudio({
      expectedInput: await expectedInput(inputPath),
      inputPath,
      outputPath,
      transform: { ...AUDIO_TRANSFORM, audioStreamIndex: 0 },
    }));
    expect(failure).toMatchObject({ code: "subprocess" });
    expect(await rejection(stat(outputPath))).toBeDefined();
    expect(runner.calls).toBe(1);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("preserves a destination created while FFmpeg is rendering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atet-media-effects-output-race-"));
  try {
    const inputPath = join(directory, "source.wav");
    const outputPath = join(directory, "derived.wav");
    await writeFile(inputPath, "immutable-source");
    const runner: ProcessRunner = {
      run: async argv => {
        await writeFile(argv.at(-1)!, "derived-media");
        await writeFile(outputPath, "concurrent-writer");
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    };
    const service = new LocalMediaEffectsService({ ffmpeg: "ffmpeg-fixture", runner });

    const failure = await rejection(service.renderAudio({
      expectedInput: await expectedInput(inputPath),
      inputPath,
      outputPath,
      transform: { ...AUDIO_TRANSFORM, audioStreamIndex: 0 },
    }));

    expect(failure).toMatchObject({ code: "conflict" });
    expect(await readFile(inputPath, "utf8")).toBe("immutable-source");
    expect(await readFile(outputPath, "utf8")).toBe("concurrent-writer");
    expect((await readdir(directory)).filter(name => name.startsWith(".atet-render-"))).toEqual([]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("rejects an input pathname swapped after its expected digest was recorded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atet-media-effects-input-race-"));
  try {
    const inputPath = join(directory, "source.wav");
    const originalPath = join(directory, "source-original.wav");
    const outputPath = join(directory, "derived.wav");
    await writeFile(inputPath, "expected-source");
    const expected = await expectedInput(inputPath);
    await rename(inputPath, originalPath);
    await writeFile(inputPath, "swapped-source!");
    const runner = new FailingRunner();
    const service = new LocalMediaEffectsService({ ffmpeg: "ffmpeg-fixture", runner });

    const failure = await rejection(service.renderAudio({
      expectedInput: expected,
      inputPath,
      outputPath,
      transform: { ...AUDIO_TRANSFORM, audioStreamIndex: 0 },
    }));

    expect(failure).toMatchObject({ code: "conflict" });
    expect(runner.calls).toBe(0);
    expect(await readFile(outputPath).catch(() => null)).toBeNull();
    await rm(inputPath);
    await rename(originalPath, inputPath);
    expect(await readFile(inputPath, "utf8")).toBe("expected-source");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("keeps FFmpeg on the pinned descriptor and rejects an A to B to A pathname swap", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atet-media-effects-pinned-input-"));
  try {
    const inputPath = join(directory, "source.wav");
    const heldPath = join(directory, "source-held.wav");
    const swappedPath = join(directory, "source-swapped.wav");
    const outputPath = join(directory, "derived.wav");
    await writeFile(inputPath, "source-A");
    await writeFile(swappedPath, "source-B");
    const expected = await expectedInput(inputPath);
    let consumed = "";
    const runner: ProcessRunner = {
      run: async (argv, options) => {
        const descriptor = options?.inheritedFileDescriptors?.[0];
        if (descriptor === undefined) throw new Error("Pinned descriptor was not inherited.");
        await rename(inputPath, heldPath);
        await rename(swappedPath, inputPath);
        consumed = await readFile(`/dev/fd/${descriptor}`, "utf8");
        await rename(inputPath, swappedPath);
        await rename(heldPath, inputPath);
        await writeFile(argv.at(-1)!, `derived-from-${consumed}`);
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    };
    const service = new LocalMediaEffectsService({ ffmpeg: "ffmpeg-fixture", runner });

    const failure = await rejection(service.renderAudio({
      expectedInput: expected,
      inputPath,
      outputPath,
      transform: { ...AUDIO_TRANSFORM, audioStreamIndex: 0 },
    }));

    expect(failure).toMatchObject({ code: "conflict" });
    expect(consumed).toBe("source-A");
    expect(await readFile(inputPath, "utf8")).toBe("source-A");
    expect(await readFile(outputPath).catch(() => null)).toBeNull();
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("does not publish output when the pinned inode changes during rendering", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atet-media-effects-input-mutation-"));
  try {
    const inputPath = join(directory, "source.wav");
    const outputPath = join(directory, "derived.wav");
    await writeFile(inputPath, "immutable-source");
    const runner: ProcessRunner = {
      run: async argv => {
        await writeFile(argv.at(-1)!, "derived-media");
        await writeFile(inputPath, "mutated-source!!");
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    };
    const service = new LocalMediaEffectsService({ ffmpeg: "ffmpeg-fixture", runner });

    const failure = await rejection(service.renderAudio({
      expectedInput: await expectedInput(inputPath),
      inputPath,
      outputPath,
      transform: { ...AUDIO_TRANSFORM, audioStreamIndex: 0 },
    }));

    expect(failure).toMatchObject({ code: "conflict" });
    expect(await readFile(outputPath).catch(() => null)).toBeNull();
    expect((await readdir(directory)).filter(name => name.startsWith(".atet-render-"))).toEqual([]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("rejects an output that exceeds the configured byte ceiling", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atet-media-effects-output-limit-"));
  try {
    const outputPath = join(directory, "derived.wav");
    const runner: ProcessRunner = {
      run: async argv => {
        await writeFile(argv.at(-1)!, "123456789");
        return { exitCode: 0, stderr: "", stdout: "" };
      },
    };

    const failure = await rejection(executeAtomicRender({
      argv: ["ffmpeg-fixture", "-y", outputPath],
      failureLabel: "FFmpeg effects render failed",
      finalOutputPath: outputPath,
      maximumOutputBytes: 8,
      requireFreshOutput: true,
      runner,
    }));

    expect(failure).toMatchObject({ code: "invalid-data" });
    expect(await readFile(outputPath).catch(() => null)).toBeNull();
    expect((await readdir(directory)).filter(name => name.startsWith(".atet-render-"))).toEqual([]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test.skipIf(FFMPEG === undefined)("executes the complete audio-effects graph with real FFmpeg", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atet-media-effects-ffmpeg-"));
  try {
    const inputPath = join(directory, "source.wav");
    const outputPath = join(directory, "derived.wav");
    const runner = new BunProcessRunner();
    const generated = await runner.run([
      FFMPEG!,
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi",
      "-i", "sine=frequency=440:duration=0.12",
      "-c:a", "pcm_s16le",
      inputPath,
    ]);
    expect(generated.exitCode).toBe(0);
    const before = createHash("sha256").update(await readFile(inputPath)).digest("hex");
    const service = new LocalMediaEffectsService({ ffmpeg: FFMPEG!, runner });

    const result = await service.renderAudio({
      expectedInput: await expectedInput(inputPath),
      inputPath,
      outputPath,
      transform: {
        audioStreamIndex: 0,
        effects: [
          { kind: "compressor" },
          { delayMs: 25, kind: "delay", mix: 0.2 },
          { kind: "reverb", mix: 0.15, preset: "small-room" },
          { kind: "denoise", noiseFloorDb: -60, noiseReductionDb: 8, trackNoise: false },
          { gainDb: -1, kind: "volume" },
        ],
        kind: "studio.audio-effects-transform",
        output: { kind: "audio-only", profile: "wav-pcm-s16le" },
        schemaVersion: 1,
      },
    });

    expect(result.bytes).toBeGreaterThan(1_000);
    expect((await stat(outputPath)).size).toBe(result.bytes);
    expect(createHash("sha256").update(await readFile(inputPath)).digest("hex")).toBe(before);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test.skipIf(FFMPEG === undefined)("executes temperature, tint, hue, and tonal controls with real FFmpeg", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atet-color-grade-ffmpeg-"));
  try {
    const inputPath = join(directory, "source.mkv");
    const outputPath = join(directory, "derived.mov");
    const runner = new BunProcessRunner();
    const generated = await runner.run([
      FFMPEG!,
      "-hide_banner", "-nostdin", "-y",
      "-f", "lavfi",
      "-i", "testsrc2=size=32x32:rate=10:duration=0.2",
      "-c:v", "ffv1",
      inputPath,
    ]);
    expect(generated.exitCode).toBe(0);
    const before = createHash("sha256").update(await readFile(inputPath)).digest("hex");
    const service = new LocalMediaEffectsService({ ffmpeg: FFMPEG!, runner });

    const result = await service.renderColor({
      expectedInput: await expectedInput(inputPath),
      inputPath,
      outputPath,
      transform: {
        grade: {
          controls: {
            brightness: 0.02,
            contrast: 1.1,
            gamma: 0.95,
            hue: 12,
            saturation: 1.15,
            temperature: 0.25,
            tint: -0.1,
          },
          kind: "custom",
        },
        kind: "studio.color-grade-transform",
        outputProfile: "prores-mov",
        schemaVersion: 1,
        videoStreamIndex: 0,
      },
    });

    expect(result.bytes).toBeGreaterThan(1_000);
    expect((await stat(outputPath)).size).toBe(result.bytes);
    expect(createHash("sha256").update(await readFile(inputPath)).digest("hex")).toBe(before);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
