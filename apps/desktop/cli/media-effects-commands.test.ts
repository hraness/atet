import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { EXIT_CODE } from "./errors";
import { BunProcessRunner, type CliIo, type ProcessRunner, type RunOptions, type RunResult } from "./io";
import type { RepositoryPaths } from "./paths";
import { createCliTestRunner } from "./run-cli-test-helper";

const runCli = createCliTestRunner(import.meta.url);

const NOW = new Date("2026-07-23T16:00:00.000Z");
const FFMPEG = [
  Bun.which("ffmpeg"),
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
  "/opt/local/bin/ffmpeg",
].find((candidate): candidate is string =>
  candidate !== null && candidate !== undefined && existsSync(candidate)
);
const FFPROBE = [
  Bun.which("ffprobe"),
  "/opt/homebrew/bin/ffprobe",
  "/usr/local/bin/ffprobe",
  "/opt/local/bin/ffprobe",
].find((candidate): candidate is string =>
  candidate !== null && candidate !== undefined && existsSync(candidate)
);
const MEDIA_TOOLS_UNAVAILABLE = FFMPEG === undefined || FFPROBE === undefined;

interface CommandResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface MediaFixture {
  readonly audioPath: string;
  readonly paths: RepositoryPaths;
  readonly root: string;
  readonly videoPath: string;
}

interface StreamProbe {
  readonly streams: readonly {
    readonly codec_type?: string;
    readonly height?: number;
    readonly index?: number;
    readonly width?: number;
  }[];
}

interface TransformReceipt {
  readonly filterGraph: string;
  readonly input: {
    readonly bytes: number;
    readonly path: string;
    readonly sha256: string;
  };
  readonly kind: string;
  readonly operation: string;
  readonly output: {
    readonly bytes: number;
    readonly durationUs: number;
    readonly path: string;
    readonly sha256: string;
  };
  readonly receiptPath: string;
  readonly transform: {
    readonly audioStreamIndex?: number;
    readonly effects?: readonly { readonly kind: string; readonly preset?: string }[];
    readonly grade?: {
      readonly kind: string;
      readonly overrides?: Readonly<Record<string, number>>;
      readonly preset?: string;
    };
    readonly videoStreamIndex?: number;
  };
}

function persistedReceipt(
  receipt: TransformReceipt,
): Readonly<Record<string, unknown>> {
  const persisted: Record<string, unknown> = { ...receipt };
  delete persisted.receiptPath;
  return persisted;
}

class RecordingRunner implements ProcessRunner {
  readonly calls: Array<readonly [string, ...string[]]> = [];
  readonly #runner = new BunProcessRunner();

  async run(
    argv: readonly [string, ...string[]],
    options?: RunOptions,
  ): Promise<RunResult> {
    this.calls.push(argv);
    return await this.#runner.run(argv, options);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixturePaths(root: string): RepositoryPaths {
  return {
    artifactRoot: join(root, "artifacts", "atet", "recordings"),
    desktopRoot: join(root, "projects", "atet", "apps", "desktop"),
    privateRoot: join(root, "artifacts", "atet", "private"),
    projectRoot: join(root, "artifacts", "atet", "projects"),
    repositoryRoot: root,
  };
}

async function runRequired(
  runner: ProcessRunner,
  argv: readonly [string, ...string[]],
): Promise<void> {
  const result = await runner.run(argv, { maxOutputBytes: 1_000_000 });
  if (result.exitCode !== 0) {
    throw new Error(`Fixture process failed (${result.exitCode}): ${result.stderr}`);
  }
}

async function createFixture(): Promise<MediaFixture> {
  if (FFMPEG === undefined) throw new Error("FFmpeg unexpectedly unavailable.");
  const root = await mkdtemp(join(tmpdir(), "atet-media-effects-command-"));
  const inputs = join(root, "fixtures");
  const audioPath = join(inputs, "two-audio-streams.mkv");
  const videoPath = join(inputs, "two-video-streams.mkv");
  const runner = new BunProcessRunner();
  await mkdir(inputs, { recursive: true });
  await runRequired(runner, [
    FFMPEG,
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi",
    "-i", "sine=frequency=440:sample_rate=48000:duration=0.3",
    "-f", "lavfi",
    "-i", "sine=frequency=880:sample_rate=48000:duration=0.3",
    "-map", "0:a:0",
    "-map", "1:a:0",
    "-c:a", "pcm_s16le",
    audioPath,
  ]);
  await runRequired(runner, [
    FFMPEG,
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "lavfi",
    "-i", "color=c=red:size=64x48:rate=12:duration=0.3",
    "-f", "lavfi",
    "-i", "color=c=blue:size=96x54:rate=12:duration=0.3",
    "-map", "0:v:0",
    "-map", "1:v:0",
    "-c:v", "ffv1",
    videoPath,
  ]);
  return { audioPath, paths: fixturePaths(root), root, videoPath };
}

async function execute(
  fixture: MediaFixture,
  runner: ProcessRunner,
  argv: readonly string[],
): Promise<CommandResult> {
  let stderr = "";
  let stdout = "";
  const io: CliIo = {
    cwd: () => fixture.root,
    env: { PATH: process.env.PATH },
    now: () => NOW,
    platform: process.platform,
    stderr: value => { stderr += value; },
    stdout: value => { stdout += value; },
  };
  const exitCode = await runCli(argv, {
    stateRoot: join(fixture.root, "auth"),
    io,
    paths: fixture.paths,
    runner,
  });
  return { exitCode, stderr, stdout };
}

async function probe(path: string): Promise<StreamProbe> {
  if (FFPROBE === undefined) throw new Error("FFprobe unexpectedly unavailable.");
  const result = await new BunProcessRunner().run([
    FFPROBE,
    "-v", "error",
    "-show_entries", "stream=index,codec_type,width,height",
    "-of", "json",
    path,
  ], { maxOutputBytes: 128_000 });
  if (result.exitCode !== 0) {
    throw new Error(`FFprobe failed (${result.exitCode}): ${result.stderr}`);
  }
  return JSON.parse(result.stdout) as StreamProbe;
}

function absoluteRepositoryPath(root: string, displayedPath: string): string {
  expect(isAbsolute(displayedPath)).toBe(false);
  const absolute = join(root, displayedPath);
  const generatedRoot = join(root, "artifacts", "atet", "generated");
  expect(relative(generatedRoot, absolute).startsWith("..")).toBe(false);
  return absolute;
}

function parseFailure(result: CommandResult): { readonly code: string; readonly message: string } {
  expect(result.stdout).toBe("");
  const parsed = JSON.parse(result.stderr) as {
    readonly error: { readonly code: string; readonly message: string };
  };
  return parsed.error;
}

test.skipIf(MEDIA_TOOLS_UNAVAILABLE)(
  "runCli renders repository-local full audio and preset color effects with verified receipts",
  async () => {
    const fixture = await createFixture();
    const runner = new RecordingRunner();
    try {
      const [audioBefore, videoBefore, audioStatBefore, videoStatBefore] = await Promise.all([
        readFile(fixture.audioPath),
        readFile(fixture.videoPath),
        stat(fixture.audioPath),
        stat(fixture.videoPath),
      ]);

      const audioResult = await execute(fixture, runner, [
        "media", "audio", "fixtures/two-audio-streams.mkv",
        "--audio-stream", "1",
        "--denoise",
        "--denoise-reduction-db", "8",
        "--compressor",
        "--compressor-threshold-db", "-24",
        "--compressor-ratio", "3",
        "--compressor-attack-ms", "10",
        "--compressor-release-ms", "150",
        "--compressor-makeup-db", "2",
        "--volume-db", "-2",
        "--delay-ms", "40",
        "--delay-feedback", "0.4",
        "--delay-mix", "0.2",
        "--reverb", "plate",
        "--reverb-wet", "0.25",
        "--output", "tests/audio/full-chain.wav",
        "--json",
      ]);
      expect({ exitCode: audioResult.exitCode, stderr: audioResult.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      const audioReceipt = JSON.parse(audioResult.stdout) as TransformReceipt;
      expect(audioReceipt).toMatchObject({
        kind: "atet.local-media-transform-receipt",
        operation: "audio-effects",
        transform: {
          audioStreamIndex: 1,
          effects: [
            { kind: "denoise" },
            { kind: "compressor" },
            { kind: "volume" },
            { kind: "delay" },
            { kind: "reverb", preset: "plate" },
          ],
        },
      });
      expect(audioReceipt.filterGraph).toContain("[0:a:1]afftdn=");
      expect(audioReceipt.filterGraph).toContain("[audio_fx_3]asplit=6");
      const audioOutputPath = absoluteRepositoryPath(fixture.root, audioReceipt.output.path);
      const audioReceiptPath = absoluteRepositoryPath(fixture.root, audioReceipt.receiptPath);
      const audioOutput = await readFile(audioOutputPath);
      expect(audioReceipt.output).toEqual({
        bytes: audioOutput.byteLength,
        durationUs: 653_000,
        path: "artifacts/atet/generated/tests/audio/full-chain.wav",
        sha256: sha256(audioOutput),
      });
      expect(audioReceipt.input).toEqual({
        bytes: audioBefore.byteLength,
        path: "fixtures/two-audio-streams.mkv",
        sha256: sha256(audioBefore),
      });
      const persistedAudioReceipt = JSON.parse(
        await readFile(audioReceiptPath, "utf8"),
      ) as Readonly<Record<string, unknown>>;
      expect(persistedAudioReceipt).toEqual(persistedReceipt(audioReceipt));
      const audioStreams = (await probe(audioOutputPath)).streams;
      expect(audioStreams.map(stream => stream.codec_type)).toEqual(["audio"]);

      const colorResult = await execute(fixture, runner, [
        "media", "color", "fixtures/two-video-streams.mkv",
        "--video-stream", "1",
        "--preset", "cinematic",
        "--brightness", "0.04",
        "--saturation", "1.3",
        "--temperature", "-0.2",
        "--tint", "0.1",
        "--hue-degrees", "12",
        "--output", "tests/color/cinematic-overrides.mp4",
        "--json",
      ]);
      expect({ exitCode: colorResult.exitCode, stderr: colorResult.stderr }).toEqual({
        exitCode: 0,
        stderr: "",
      });
      const colorReceipt = JSON.parse(colorResult.stdout) as TransformReceipt;
      expect(colorReceipt).toMatchObject({
        kind: "atet.local-media-transform-receipt",
        operation: "color-grade",
        transform: {
          grade: {
            kind: "preset",
            overrides: {
              brightness: 0.04,
              hue: 12,
              saturation: 1.3,
              temperature: -0.2,
              tint: 0.1,
            },
            preset: "cinematic",
          },
          videoStreamIndex: 1,
        },
      });
      expect(colorReceipt.filterGraph).toContain(
        "eq=brightness=0.04:contrast=1.14:saturation=1.3:gamma=0.96",
      );
      expect(colorReceipt.filterGraph).toContain("hue=h=12");
      const colorOutputPath = absoluteRepositoryPath(fixture.root, colorReceipt.output.path);
      const colorReceiptPath = absoluteRepositoryPath(fixture.root, colorReceipt.receiptPath);
      const colorOutput = await readFile(colorOutputPath);
      expect(colorReceipt.output).toEqual({
        bytes: colorOutput.byteLength,
        durationUs: 333_333,
        path: "artifacts/atet/generated/tests/color/cinematic-overrides.mp4",
        sha256: sha256(colorOutput),
      });
      expect(colorReceipt.input).toEqual({
        bytes: videoBefore.byteLength,
        path: "fixtures/two-video-streams.mkv",
        sha256: sha256(videoBefore),
      });
      const persistedColorReceipt = JSON.parse(
        await readFile(colorReceiptPath, "utf8"),
      ) as Readonly<Record<string, unknown>>;
      expect(persistedColorReceipt).toEqual(persistedReceipt(colorReceipt));
      const colorStreams = (await probe(colorOutputPath)).streams;
      expect(colorStreams).toHaveLength(1);
      expect(colorStreams[0]).toMatchObject({ codec_type: "video", height: 54, width: 96 });

      const audioRender = runner.calls.find(argv =>
        argv.includes("-filter_complex") && argv.includes("[audio_fx_4]")
      );
      expect(audioRender).toBeDefined();
      expect(audioRender).toContain("[audio_fx_4]");
      const colorRender = runner.calls.find(argv =>
        argv.includes("-filter_complex") && argv.some(value => value.includes("[0:1]eq="))
      );
      expect(colorRender).toBeDefined();

      const [audioAfter, videoAfter, audioStatAfter, videoStatAfter] = await Promise.all([
        readFile(fixture.audioPath),
        readFile(fixture.videoPath),
        stat(fixture.audioPath),
        stat(fixture.videoPath),
      ]);
      expect(audioAfter).toEqual(audioBefore);
      expect(videoAfter).toEqual(videoBefore);
      expect({
        inode: audioStatAfter.ino,
        modifiedAtMs: audioStatAfter.mtimeMs,
        size: audioStatAfter.size,
      }).toEqual({
        inode: audioStatBefore.ino,
        modifiedAtMs: audioStatBefore.mtimeMs,
        size: audioStatBefore.size,
      });
      expect({
        inode: videoStatAfter.ino,
        modifiedAtMs: videoStatAfter.mtimeMs,
        size: videoStatAfter.size,
      }).toEqual({
        inode: videoStatBefore.ino,
        modifiedAtMs: videoStatBefore.mtimeMs,
        size: videoStatBefore.size,
      });
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  },
  30_000,
);

test.skipIf(MEDIA_TOOLS_UNAVAILABLE)(
  "runCli rejects out-of-range streams and unsafe outputs without rendering or changing sources",
  async () => {
    const fixture = await createFixture();
    const runner = new RecordingRunner();
    try {
      const [audioBefore, videoBefore] = await Promise.all([
        readFile(fixture.audioPath),
        readFile(fixture.videoPath),
      ]);
      const collisionInput = join(
        fixture.root,
        "artifacts",
        "atet",
        "generated",
        "tests",
        "collision.wav.atet.json",
      );
      await mkdir(join(collisionInput, ".."), { recursive: true });
      await writeFile(collisionInput, audioBefore);
      const failures = [
        {
          argv: [
            "media", "audio", "fixtures/two-audio-streams.mkv",
            "--audio-stream", "2",
            "--volume-db", "-1",
            "--json",
          ],
          code: "usage",
          exitCode: EXIT_CODE.usage,
        },
        {
          argv: [
            "media", "color", "fixtures/two-video-streams.mkv",
            "--video-stream", "2",
            "--preset", "clean",
            "--json",
          ],
          code: "usage",
          exitCode: EXIT_CODE.usage,
        },
        {
          argv: [
            "media", "audio", "fixtures/two-audio-streams.mkv",
            "--volume-db", "-1",
            "--output", "../escaped.wav",
            "--json",
          ],
          code: "unsafe-path",
          exitCode: EXIT_CODE["unsafe-path"],
        },
        {
          argv: [
            "media", "audio",
            "artifacts/atet/generated/tests/collision.wav.atet.json",
            "--volume-db", "-1",
            "--output", "tests/collision.wav",
            "--json",
          ],
          code: "unsafe-path",
          exitCode: EXIT_CODE["unsafe-path"],
        },
        {
          argv: [
            "media", "color", "fixtures/two-video-streams.mkv",
            "--preset", "clean",
            "--output", join(fixture.root, "absolute-output.mp4"),
            "--json",
          ],
          code: "unsafe-path",
          exitCode: EXIT_CODE["unsafe-path"],
        },
      ] as const;
      for (const failure of failures) {
        const result = await execute(fixture, runner, failure.argv);
        expect(result.exitCode).toBe(failure.exitCode);
        expect(parseFailure(result).code).toBe(failure.code);
      }

      expect(runner.calls.some(argv => argv.includes("-filter_complex"))).toBe(false);
      expect(await readFile(join(fixture.root, "artifacts", "atet", "escaped.wav")).catch(() => null)).toBeNull();
      expect(await readFile(join(fixture.root, "absolute-output.mp4")).catch(() => null)).toBeNull();
      expect(await readFile(fixture.audioPath)).toEqual(audioBefore);
      expect(await readFile(fixture.videoPath)).toEqual(videoBefore);
      expect(await readFile(collisionInput)).toEqual(audioBefore);
      expect(await readFile(join(
        fixture.root,
        "artifacts",
        "atet",
        "generated",
        "tests",
        "collision.wav",
      )).catch(() => null)).toBeNull();
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  },
  30_000,
);
