import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  type FileHandle,
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";

import {
  AudioEffectsTransformV1Schema,
  ColorGradeTransformV1Schema,
  type AudioEffect,
  type AudioEffectsTransformV1,
  type ColorGradeControls,
  type ColorGradeTransformV1,
} from "../contracts";
import { executeAtomicRender, type AtomicRenderOutput } from "./atomic-render";
import { CliError } from "./errors";
import type { ProcessRunner, RunOptions } from "./io";
import { SELF_CONTAINED_MEDIA_INPUT_ARGUMENTS } from "./media-ingest";

const MAXIMUM_PATH_BYTES = 8_192;
const MAXIMUM_LOCAL_MEDIA_EFFECT_INPUT_BYTES = 512 * 1024 * 1024 * 1024;
export const MAXIMUM_LOCAL_MEDIA_EFFECT_OUTPUT_BYTES = 32 * 1024 * 1024 * 1024;
const LOCAL_MEDIA_EFFECT_TIMEOUT_MS = 12 * 60 * 60_000;
const PINNED_CHILD_INPUT_DESCRIPTOR = 3;
const PINNED_CHILD_INPUT_PATH = `/dev/fd/${PINNED_CHILD_INPUT_DESCRIPTOR}`;

const REVERB_TAPS = {
  "small-room": [
    { delayMs: 29, weight: 0.5 },
    { delayMs: 47, weight: 0.3 },
    { delayMs: 71, weight: 0.2 },
  ],
  "medium-room": [
    { delayMs: 43, weight: 0.4 },
    { delayMs: 67, weight: 0.3 },
    { delayMs: 101, weight: 0.2 },
    { delayMs: 149, weight: 0.1 },
  ],
  "large-hall": [
    { delayMs: 61, weight: 0.35 },
    { delayMs: 113, weight: 0.27 },
    { delayMs: 173, weight: 0.2 },
    { delayMs: 257, weight: 0.12 },
    { delayMs: 347, weight: 0.06 },
  ],
  plate: [
    { delayMs: 23, weight: 0.28 },
    { delayMs: 37, weight: 0.24 },
    { delayMs: 53, weight: 0.2 },
    { delayMs: 79, weight: 0.16 },
    { delayMs: 113, weight: 0.12 },
  ],
} as const satisfies Readonly<Record<
  Extract<AudioEffect, { readonly kind: "reverb" }>["preset"],
  readonly { readonly delayMs: number; readonly weight: number }[]
>>;

export interface ResolvedColorGradeControls {
  readonly brightness: number;
  readonly contrast: number;
  readonly gamma: number;
  readonly hue: number;
  readonly saturation: number;
  readonly temperature: number;
  readonly tint: number;
}

const NEUTRAL_GRADE: ResolvedColorGradeControls = {
  brightness: 0,
  contrast: 1,
  gamma: 1,
  hue: 0,
  saturation: 1,
  temperature: 0,
  tint: 0,
};

const COLOR_PRESETS = {
  cinematic: {
    brightness: -0.02,
    contrast: 1.14,
    gamma: 0.96,
    hue: 0,
    saturation: 0.88,
    temperature: 0.12,
    tint: 0.06,
  },
  clean: {
    brightness: 0.02,
    contrast: 1.04,
    gamma: 1,
    hue: 0,
    saturation: 1.02,
    temperature: 0,
    tint: 0,
  },
  cool: {
    brightness: 0,
    contrast: 1.05,
    gamma: 1,
    hue: 0,
    saturation: 0.96,
    temperature: -0.35,
    tint: 0,
  },
  flat: {
    brightness: 0.02,
    contrast: 0.86,
    gamma: 1.04,
    hue: 0,
    saturation: 0.85,
    temperature: 0,
    tint: 0,
  },
  monochrome: {
    brightness: 0,
    contrast: 1.1,
    gamma: 1,
    hue: 0,
    saturation: 0,
    temperature: 0,
    tint: 0,
  },
  vivid: {
    brightness: 0.01,
    contrast: 1.12,
    gamma: 1,
    hue: 0,
    saturation: 1.22,
    temperature: 0,
    tint: 0,
  },
  warm: {
    brightness: 0,
    contrast: 1.04,
    gamma: 1,
    hue: 0,
    saturation: 1.08,
    temperature: 0.35,
    tint: 0,
  },
} as const satisfies Readonly<Record<
  Extract<ColorGradeTransformV1["grade"], { readonly kind: "preset" }>["preset"],
  ResolvedColorGradeControls
>>;

export interface BuiltAudioEffectsGraph {
  readonly filterGraph: string;
  readonly outputLabel: string;
  readonly transform: AudioEffectsTransformV1;
}

export interface BuiltColorGradeFilter {
  readonly controls: ResolvedColorGradeControls;
  readonly filter: string;
  readonly transform: ColorGradeTransformV1;
}

export interface BuiltAudioEffectsInvocation extends BuiltAudioEffectsGraph {
  readonly argv: readonly [string, ...string[]];
}

export interface BuiltColorGradeInvocation extends BuiltColorGradeFilter {
  readonly argv: readonly [string, ...string[]];
}

export interface LocalMediaTransformResult<Transform> extends AtomicRenderOutput {
  readonly filterGraph: string;
  readonly outputPath: string;
  readonly transform: Transform;
}

export interface ExpectedLocalMediaInput {
  readonly bytes: number;
  readonly device: number;
  readonly inode: number;
  readonly modifiedAtMs: number;
  readonly sha256: string;
}

interface PinnedLocalMediaInput {
  readonly assertUnchanged: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly processPath: string;
  readonly runner: ProcessRunner;
}

function validateExpectedInput(input: ExpectedLocalMediaInput): void {
  if (
    !Number.isSafeInteger(input.bytes)
    || input.bytes <= 0
    || input.bytes > MAXIMUM_LOCAL_MEDIA_EFFECT_INPUT_BYTES
    || !Number.isSafeInteger(input.device)
    || input.device < 0
    || !Number.isSafeInteger(input.inode)
    || input.inode < 0
    || !Number.isFinite(input.modifiedAtMs)
    || !/^[a-f0-9]{64}$/u.test(input.sha256)
  ) {
    throw new CliError("internal", "Expected local-media input identity is invalid.");
  }
}

function sameExactFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function hashFileHandle(handle: FileHandle, bytes: number): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  while (offset < bytes) {
    const read = await handle.read(
      buffer,
      0,
      Math.min(buffer.byteLength, bytes - offset),
      offset,
    );
    if (read.bytesRead === 0) break;
    hash.update(buffer.subarray(0, read.bytesRead));
    offset += read.bytesRead;
  }
  if (offset !== bytes) {
    throw new CliError("conflict", "Media input ended while it was being pinned.");
  }
  return hash.digest("hex");
}

class InheritedInputRunner implements ProcessRunner {
  readonly #descriptor: number;
  readonly #runner: ProcessRunner;

  constructor(runner: ProcessRunner, descriptor: number) {
    this.#descriptor = descriptor;
    this.#runner = runner;
  }

  run(
    argv: readonly [string, ...string[]],
    options: RunOptions = {},
  ): ReturnType<ProcessRunner["run"]> {
    if ((options.inheritedFileDescriptors?.length ?? 0) !== 0) {
      throw new CliError("internal", "Pinned media execution cannot inherit unrelated file descriptors.");
    }
    return this.#runner.run(argv, {
      ...options,
      inheritedFileDescriptors: [this.#descriptor],
    });
  }
}

async function openPinnedLocalMediaInput(
  path: string,
  expected: ExpectedLocalMediaInput,
  runner: ProcessRunner,
): Promise<PinnedLocalMediaInput> {
  validateExpectedInput(expected);
  if (process.platform === "win32") {
    throw new CliError(
      "unavailable",
      "Descriptor-pinned local media effects are supported on macOS and other POSIX systems.",
    );
  }
  const lexical = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new CliError("not-found", `Media input does not exist: ${path}`);
    }
    throw error;
  });
  if (
    lexical.isSymbolicLink()
    || !lexical.isFile()
    || lexical.size !== expected.bytes
    || lexical.dev !== expected.device
    || lexical.ino !== expected.inode
    || lexical.mtimeMs !== expected.modifiedAtMs
  ) {
    throw new CliError("conflict", "Media input changed after it was inspected.");
  }
  const handle = await open(
    path,
    constants.O_RDONLY
      | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_NONBLOCK ?? 0),
  ).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ELOOP") {
      throw new CliError("unsafe-path", `Media input must not be a symlink: ${path}`);
    }
    throw error;
  });
  try {
    const [opened, exactBefore] = await Promise.all([
      handle.stat(),
      handle.stat({ bigint: true }),
    ]);
    if (
      !opened.isFile()
      || !exactBefore.isFile()
      || opened.dev !== lexical.dev
      || opened.ino !== lexical.ino
      || opened.size !== lexical.size
      || opened.dev !== expected.device
      || opened.ino !== expected.inode
      || opened.size !== expected.bytes
      || opened.mtimeMs !== expected.modifiedAtMs
    ) {
      throw new CliError("conflict", "Media input changed while its descriptor was being pinned.");
    }
    const sha256 = await hashFileHandle(handle, expected.bytes);
    const exactAfter = await handle.stat({ bigint: true });
    if (!sameExactFile(exactBefore, exactAfter) || sha256 !== expected.sha256) {
      throw new CliError("conflict", "Media input bytes changed before rendering.");
    }
    return {
      assertUnchanged: async () => {
        const afterRender = await handle.stat({ bigint: true });
        if (!sameExactFile(exactAfter, afterRender)) {
          throw new CliError("conflict", "Media input changed while effects were rendering.");
        }
      },
      close: async () => await handle.close(),
      processPath: PINNED_CHILD_INPUT_PATH,
      runner: new InheritedInputRunner(runner, handle.fd),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function decimal(value: number): string {
  if (!Number.isFinite(value)) throw new CliError("internal", "FFmpeg filter value must be finite.");
  const normalized = Math.abs(value) < 0.000_000_000_1 ? 0 : value;
  return normalized.toFixed(10).replace(/0+$/u, "").replace(/\.$/u, "");
}

function amplitude(decibels: number): number {
  return 10 ** (decibels / 20);
}

function parseAudioTransform(input: unknown): AudioEffectsTransformV1 {
  const parsed = AudioEffectsTransformV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new CliError(
      "usage",
      `Invalid audio-effects transform: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
    );
  }
  return parsed.data;
}

function parseColorTransform(input: unknown): ColorGradeTransformV1 {
  const parsed = ColorGradeTransformV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new CliError(
      "usage",
      `Invalid color-grade transform: ${parsed.error.issues[0]?.message ?? "unknown error"}`,
    );
  }
  return parsed.data;
}

function effectOutputLabel(index: number): string {
  return `audio_fx_${index}`;
}

function buildDelayGraph(
  inputLabel: string,
  outputLabel: string,
  effect: Extract<AudioEffect, { readonly kind: "delay" }>,
  serial: number,
): readonly string[] {
  const dry = `delay_${serial}_dry`;
  const dryGain = `delay_${serial}_dry_gain`;
  const maximumTaps = Math.max(
    1,
    Math.min(16, Math.floor(30_000 / effect.delayMs)),
  );
  const tapCount = effect.decay === 0
    ? 1
    : effect.decay >= 1
      ? maximumTaps
    : Math.min(
        maximumTaps,
        Math.max(
          1,
          Math.ceil(Math.log(0.01) / Math.log(effect.decay)),
        ),
      );
  const taps = Array.from(
    { length: tapCount },
    (_, index) => ({
      delayMs: effect.delayMs * (index + 1),
      gain: effect.mix * effect.decay ** index,
      input: `delay_${serial}_tap_${index}`,
      output: `delay_${serial}_tap_${index}_gain`,
    }),
  );
  return [
    `[${inputLabel}]asplit=${taps.length + 1}[${dry}]${taps.map(tap => `[${tap.input}]`).join("")}`,
    `[${dry}]volume=volume=${decimal(1 - effect.mix)}[${dryGain}]`,
    ...taps.map(tap => (
      `[${tap.input}]adelay=delays=${tap.delayMs}:all=1,volume=volume=${decimal(tap.gain)}[${tap.output}]`
    )),
    `[${dryGain}]${taps.map(tap => `[${tap.output}]`).join("")}amix=inputs=${taps.length + 1}:duration=longest:dropout_transition=0:normalize=0[${outputLabel}]`,
  ];
}

function buildReverbGraph(
  inputLabel: string,
  outputLabel: string,
  effect: Extract<AudioEffect, { readonly kind: "reverb" }>,
  serial: number,
): readonly string[] {
  const taps = REVERB_TAPS[effect.preset];
  const dry = `reverb_${serial}_dry`;
  const dryGain = `reverb_${serial}_dry_gain`;
  const wetInputs = taps.map((_, index) => `reverb_${serial}_tap_${index}`);
  const wetGains = taps.map((_, index) => `reverb_${serial}_tap_${index}_gain`);
  return [
    `[${inputLabel}]asplit=${taps.length + 1}[${dry}]${wetInputs.map(label => `[${label}]`).join("")}`,
    `[${dry}]volume=volume=${decimal(1 - effect.mix)}[${dryGain}]`,
    ...taps.map((tap, index) =>
      `[${wetInputs[index]}]adelay=delays=${tap.delayMs}:all=1,volume=volume=${decimal(effect.mix * tap.weight)}[${wetGains[index]}]`
    ),
    `[${dryGain}]${wetGains.map(label => `[${label}]`).join("")}amix=inputs=${taps.length + 1}:duration=longest:dropout_transition=0:normalize=0[${outputLabel}]`,
  ];
}

/** Build a bounded, numeric-only FFmpeg graph. No caller text reaches the graph. */
export function buildAudioEffectsFilterGraph(input: unknown): BuiltAudioEffectsGraph {
  const transform = parseAudioTransform(input);
  const filters: string[] = [];
  let currentLabel = `0:a:${transform.audioStreamIndex}`;
  for (const [index, effect] of transform.effects.entries()) {
    const nextLabel = effectOutputLabel(index);
    if (effect.kind === "volume") {
      filters.push(`[${currentLabel}]volume=volume=${decimal(effect.gainDb)}dB[${nextLabel}]`);
    } else if (effect.kind === "compressor") {
      filters.push(
        `[${currentLabel}]acompressor=threshold=${decimal(amplitude(effect.thresholdDb))}:ratio=${decimal(effect.ratio)}:attack=${decimal(effect.attackMs)}:release=${decimal(effect.releaseMs)}:makeup=${decimal(amplitude(effect.makeupGainDb))}:knee=${decimal(effect.knee)}:detection=rms:link=average[${nextLabel}]`,
      );
    } else if (effect.kind === "delay") {
      filters.push(...buildDelayGraph(currentLabel, nextLabel, effect, index));
    } else if (effect.kind === "reverb") {
      filters.push(...buildReverbGraph(currentLabel, nextLabel, effect, index));
    } else if (effect.kind === "denoise") {
      filters.push(
        `[${currentLabel}]afftdn=nf=${decimal(effect.noiseFloorDb)}:nr=${decimal(effect.noiseReductionDb)}:tn=${effect.trackNoise ? "1" : "0"}[${nextLabel}]`,
      );
    } else {
      effect satisfies never;
    }
    currentLabel = nextLabel;
  }
  return {
    filterGraph: filters.join(";"),
    outputLabel: currentLabel,
    transform,
  };
}

function applyControls(
  base: ResolvedColorGradeControls,
  overrides: ColorGradeControls | undefined,
): ResolvedColorGradeControls {
  return {
    brightness: overrides?.brightness ?? base.brightness,
    contrast: overrides?.contrast ?? base.contrast,
    gamma: overrides?.gamma ?? base.gamma,
    hue: overrides?.hue ?? base.hue,
    saturation: overrides?.saturation ?? base.saturation,
    temperature: overrides?.temperature ?? base.temperature,
    tint: overrides?.tint ?? base.tint,
  };
}

function clampBalance(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

function balanceBand(
  temperature: number,
  tint: number,
  strength: number,
): { readonly blue: number; readonly green: number; readonly red: number } {
  return {
    blue: clampBalance((-temperature + tint * 0.5) * strength),
    green: clampBalance(-tint * strength),
    red: clampBalance((temperature + tint * 0.5) * strength),
  };
}

export function resolveColorGradeControls(input: unknown): ResolvedColorGradeControls {
  const transform = parseColorTransform(input);
  return transform.grade.kind === "custom"
    ? applyControls(NEUTRAL_GRADE, transform.grade.controls)
    : applyControls(COLOR_PRESETS[transform.grade.preset], transform.grade.overrides);
}

/** Resolve a preset plus overrides into an explicit, deterministic FFmpeg chain. */
export function buildColorGradeFilter(input: unknown): BuiltColorGradeFilter {
  const transform = parseColorTransform(input);
  const controls = transform.grade.kind === "custom"
    ? applyControls(NEUTRAL_GRADE, transform.grade.controls)
    : applyControls(COLOR_PRESETS[transform.grade.preset], transform.grade.overrides);
  const filters = [
    `eq=brightness=${decimal(controls.brightness)}:contrast=${decimal(controls.contrast)}:saturation=${decimal(controls.saturation)}:gamma=${decimal(controls.gamma)}`,
  ];
  if (controls.temperature !== 0 || controls.tint !== 0) {
    const shadows = balanceBand(controls.temperature, controls.tint, 0.12);
    const midtones = balanceBand(controls.temperature, controls.tint, 0.2);
    const highlights = balanceBand(controls.temperature, controls.tint, 0.1);
    filters.push(
      [
        `colorbalance=rs=${decimal(shadows.red)}`,
        `gs=${decimal(shadows.green)}`,
        `bs=${decimal(shadows.blue)}`,
        `rm=${decimal(midtones.red)}`,
        `gm=${decimal(midtones.green)}`,
        `bm=${decimal(midtones.blue)}`,
        `rh=${decimal(highlights.red)}`,
        `gh=${decimal(highlights.green)}`,
        `bh=${decimal(highlights.blue)}`,
      ].join(":"),
    );
  }
  if (controls.hue !== 0) filters.push(`hue=h=${decimal(controls.hue)}`);
  return { controls, filter: filters.join(","), transform };
}

function validateArgument(value: string, label: string): void {
  if (
    value.length === 0
    || value.includes("\0")
    || Buffer.byteLength(value) > MAXIMUM_PATH_BYTES
  ) {
    throw new CliError("usage", `${label} must be a bounded, nonempty, NUL-free string.`);
  }
}

function assertExtension(path: string, expected: readonly string[], label: string): void {
  const extension = extname(path).toLocaleLowerCase("en-US");
  if (!expected.includes(extension)) {
    throw new CliError("usage", `${label} output must use ${expected.join(", ")}.`);
  }
}

function audioEncodingArguments(transform: AudioEffectsTransformV1, outputPath: string): readonly string[] {
  if (transform.output.kind === "preserve-video") {
    if (transform.output.profile === "aac") {
      assertExtension(outputPath, [".mp4", ".mov", ".m4v"], "AAC video");
      return ["-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"];
    }
    assertExtension(outputPath, [".mkv", ".webm"], "Opus video");
    return ["-c:v", "copy", "-c:a", "libopus", "-b:a", "160k"];
  }
  if (transform.output.profile === "wav-pcm-s16le") {
    assertExtension(outputPath, [".wav"], "PCM");
    return ["-c:a", "pcm_s16le"];
  }
  if (transform.output.profile === "flac") {
    assertExtension(outputPath, [".flac"], "FLAC");
    return ["-c:a", "flac"];
  }
  if (transform.output.profile === "mp3") {
    assertExtension(outputPath, [".mp3"], "MP3");
    return ["-c:a", "libmp3lame", "-q:a", "2"];
  }
  if (transform.output.profile === "aac") {
    assertExtension(outputPath, [".aac", ".m4a", ".mp4"], "AAC");
    return ["-c:a", "aac", "-b:a", "192k"];
  }
  assertExtension(outputPath, [".ogg", ".opus", ".webm"], "Opus");
  return ["-c:a", "libopus", "-b:a", "160k"];
}

function colorEncodingArguments(transform: ColorGradeTransformV1, outputPath: string): readonly string[] {
  if (transform.outputProfile === "h264-mp4") {
    assertExtension(outputPath, [".mp4"], "H.264");
    return [
      "-c:v", "libx264",
      "-preset", "medium",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "192k",
      "-movflags", "+faststart",
    ];
  }
  if (transform.outputProfile === "prores-mov") {
    assertExtension(outputPath, [".mov"], "ProRes");
    return [
      "-c:v", "prores_ks",
      "-profile:v", "3",
      "-pix_fmt", "yuv422p10le",
      "-c:a", "pcm_s16le",
    ];
  }
  assertExtension(outputPath, [".webm"], "VP9");
  return [
    "-c:v", "libvpx-vp9",
    "-crf", "30",
    "-b:v", "0",
    "-c:a", "libopus",
    "-b:a", "160k",
  ];
}

export function buildAudioEffectsInvocation(options: {
  readonly ffmpeg: string;
  readonly inputPath: string;
  readonly outputPath: string;
  readonly transform: unknown;
}): BuiltAudioEffectsInvocation {
  validateArgument(options.ffmpeg, "FFmpeg executable");
  validateArgument(options.inputPath, "Input path");
  validateArgument(options.outputPath, "Output path");
  if (resolve(options.inputPath) === resolve(options.outputPath)) {
    throw new CliError("unsafe-path", "Audio-effects output must differ from its immutable input.");
  }
  const built = buildAudioEffectsFilterGraph(options.transform);
  const arguments_: string[] = [
    "-hide_banner", "-nostdin", "-xerror", "-y",
    ...SELF_CONTAINED_MEDIA_INPUT_ARGUMENTS,
    "-i", options.inputPath,
    "-filter_complex", built.filterGraph,
    ...(built.transform.output.kind === "preserve-video"
      ? [
          "-map",
          built.transform.output.inputVideoStreamIndex === undefined
            ? `0:V:${built.transform.output.videoStreamIndex}`
            : `0:${built.transform.output.inputVideoStreamIndex}`,
        ]
      : []),
    "-map", `[${built.outputLabel}]`,
    "-map_metadata", "0",
    "-sn", "-dn",
    "-fs", String(MAXIMUM_LOCAL_MEDIA_EFFECT_OUTPUT_BYTES),
    ...audioEncodingArguments(built.transform, options.outputPath),
    options.outputPath,
  ];
  return {
    ...built,
    argv: [options.ffmpeg, ...arguments_],
  };
}

export function buildColorGradeInvocation(options: {
  readonly ffmpeg: string;
  readonly inputPath: string;
  readonly outputPath: string;
  readonly transform: unknown;
}): BuiltColorGradeInvocation {
  validateArgument(options.ffmpeg, "FFmpeg executable");
  validateArgument(options.inputPath, "Input path");
  validateArgument(options.outputPath, "Output path");
  if (resolve(options.inputPath) === resolve(options.outputPath)) {
    throw new CliError("unsafe-path", "Color-grade output must differ from its immutable input.");
  }
  const built = buildColorGradeFilter(options.transform);
  const outputLabel = "graded_video";
  const arguments_: string[] = [
    "-hide_banner", "-nostdin", "-xerror", "-y",
    ...SELF_CONTAINED_MEDIA_INPUT_ARGUMENTS,
    "-i", options.inputPath,
    "-filter_complex", `[${
      built.transform.inputStreamIndex === undefined
        ? `0:V:${built.transform.videoStreamIndex}`
        : `0:${built.transform.inputStreamIndex}`
    }]${built.filter}[${outputLabel}]`,
    "-map", `[${outputLabel}]`,
    "-map", "0:a?",
    "-map_metadata", "0",
    "-sn", "-dn",
    "-fs", String(MAXIMUM_LOCAL_MEDIA_EFFECT_OUTPUT_BYTES),
    ...colorEncodingArguments(built.transform, options.outputPath),
    options.outputPath,
  ];
  return {
    ...built,
    argv: [options.ffmpeg, ...arguments_],
  };
}

async function assertSafeTransformPaths(inputPath: string, outputPath: string): Promise<void> {
  if (inputPath === outputPath) {
    throw new CliError("unsafe-path", "Derived media output must differ from its immutable input.");
  }
  const input = await lstat(inputPath).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new CliError("not-found", `Media input does not exist: ${inputPath}`);
    }
    throw error;
  });
  if (input.isSymbolicLink() || !input.isFile() || input.size <= 0) {
    throw new CliError("unsafe-path", "Media input must be a physical, nonempty regular file.");
  }
  const parentPath = dirname(outputPath);
  const parent = await lstat(parentPath).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new CliError("not-found", `Media output directory does not exist: ${parentPath}`);
    }
    throw error;
  });
  if (parent.isSymbolicLink() || !parent.isDirectory()) {
    throw new CliError("unsafe-path", "Media output directory must be a physical directory.");
  }
  const [physicalInput, physicalOutputParent] = await Promise.all([
    realpath(inputPath),
    realpath(parentPath),
  ]);
  if (physicalInput === join(physicalOutputParent, basename(outputPath))) {
    throw new CliError("unsafe-path", "Derived media output resolves to its immutable input.");
  }
  try {
    const output = await lstat(outputPath);
    if (output.dev === input.dev && output.ino === input.ino) {
      throw new CliError("unsafe-path", "Derived media output aliases its immutable input.");
    }
    throw new CliError("conflict", `Derived media output already exists: ${outputPath}`);
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

export class LocalMediaEffectsService {
  readonly #ffmpeg: string;
  readonly #runner: ProcessRunner;

  constructor(options: { readonly ffmpeg: string; readonly runner: ProcessRunner }) {
    validateArgument(options.ffmpeg, "FFmpeg executable");
    this.#ffmpeg = options.ffmpeg;
    this.#runner = options.runner;
  }

  buildAudio(options: {
    readonly inputPath: string;
    readonly outputPath: string;
    readonly transform: unknown;
  }): BuiltAudioEffectsInvocation {
    return buildAudioEffectsInvocation({ ...options, ffmpeg: this.#ffmpeg });
  }

  buildColor(options: {
    readonly inputPath: string;
    readonly outputPath: string;
    readonly transform: unknown;
  }): BuiltColorGradeInvocation {
    return buildColorGradeInvocation({ ...options, ffmpeg: this.#ffmpeg });
  }

  async renderAudio(options: {
    readonly expectedInput: ExpectedLocalMediaInput;
    readonly inputPath: string;
    readonly outputPath: string;
    readonly transform: unknown;
  }): Promise<LocalMediaTransformResult<AudioEffectsTransformV1>> {
    const inputPath = resolve(options.inputPath);
    const outputPath = resolve(options.outputPath);
    await assertSafeTransformPaths(inputPath, outputPath);
    const pinned = await openPinnedLocalMediaInput(
      inputPath,
      options.expectedInput,
      this.#runner,
    );
    try {
      const built = this.buildAudio({
        ...options,
        inputPath: pinned.processPath,
        outputPath,
      });
      const output = await executeAtomicRender({
        argv: built.argv,
        beforePublish: pinned.assertUnchanged,
        failureLabel: "FFmpeg audio-effects render failed",
        finalOutputPath: outputPath,
        maximumOutputBytes: MAXIMUM_LOCAL_MEDIA_EFFECT_OUTPUT_BYTES,
        requireFreshOutput: true,
        runner: pinned.runner,
        timeoutMs: LOCAL_MEDIA_EFFECT_TIMEOUT_MS,
      });
      return {
        ...output,
        filterGraph: built.filterGraph,
        outputPath,
        transform: built.transform,
      };
    } finally {
      await pinned.close();
    }
  }

  async renderColor(options: {
    readonly expectedInput: ExpectedLocalMediaInput;
    readonly inputPath: string;
    readonly outputPath: string;
    readonly transform: unknown;
  }): Promise<LocalMediaTransformResult<ColorGradeTransformV1>> {
    const inputPath = resolve(options.inputPath);
    const outputPath = resolve(options.outputPath);
    await assertSafeTransformPaths(inputPath, outputPath);
    const pinned = await openPinnedLocalMediaInput(
      inputPath,
      options.expectedInput,
      this.#runner,
    );
    try {
      const built = this.buildColor({
        ...options,
        inputPath: pinned.processPath,
        outputPath,
      });
      const output = await executeAtomicRender({
        argv: built.argv,
        beforePublish: pinned.assertUnchanged,
        failureLabel: "FFmpeg color-grade render failed",
        finalOutputPath: outputPath,
        maximumOutputBytes: MAXIMUM_LOCAL_MEDIA_EFFECT_OUTPUT_BYTES,
        requireFreshOutput: true,
        runner: pinned.runner,
        timeoutMs: LOCAL_MEDIA_EFFECT_TIMEOUT_MS,
      });
      return {
        ...output,
        filterGraph: built.filter,
        outputPath,
        transform: built.transform,
      };
    } finally {
      await pinned.close();
    }
  }
}
