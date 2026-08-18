import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  type FileHandle,
  lstat,
  open,
  realpath,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { z } from "zod";

import { executeAtomicRender, type AtomicRenderOutput } from "./atomic-render";
import { CliError } from "./errors";
import type { ProcessRunner, RunOptions } from "./io";
import { SELF_CONTAINED_MEDIA_INPUT_ARGUMENTS } from "./media-ingest";
import type { ExpectedLocalMediaInput } from "./media-effects-service";
import { resolveSafePath } from "./paths";

const MAXIMUM_COMPOSE_INPUTS = 8;
const MAXIMUM_COMPOSE_SEGMENTS = 32;
const MAXIMUM_COMPOSE_INPUT_BYTES = 512 * 1024 * 1024 * 1024;
export const MAXIMUM_MEDIA_COMPOSE_OUTPUT_BYTES = 64 * 1024 * 1024 * 1024;
const MEDIA_COMPOSE_TIMEOUT_MS = 12 * 60 * 60_000;
const FIRST_PINNED_CHILD_DESCRIPTOR = 3;
const SPEED_RAMP_STEPS = 6;
const MAXIMUM_COMPOSE_SPEED_RANGES = 32;

const PositiveMicrosecondsSchema = z.number().int().safe().positive();
const EvenDimensionSchema = z.number()
  .int()
  .safe()
  .min(16)
  .max(16_384)
  .refine(value => value % 2 === 0, "Video dimensions must be even.");

export const MediaComposeTransitionSchema = z.strictObject({
  durationUs: PositiveMicrosecondsSchema.max(2_000_000).default(750_000),
  kind: z.literal("fade").default("fade"),
});

export const MediaComposeSpeedRangeSchema = z.strictObject({
  endUs: PositiveMicrosecondsSchema,
  rampUs: PositiveMicrosecondsSchema.min(200_000).max(2_000_000).default(600_000),
  rate: z.number().finite().min(1.25).max(8),
  startUs: z.number().int().safe().nonnegative(),
});

export const MediaComposeSegmentSchema = z.strictObject({
  audioStream: z.number().int().safe().min(0).max(255).default(0),
  endUs: PositiveMicrosecondsSchema,
  source: z.string().min(1).max(8_192),
  speed: z.array(MediaComposeSpeedRangeSchema).max(8).default([]),
  startUs: z.number().int().safe().nonnegative(),
  transitionAfter: MediaComposeTransitionSchema.optional(),
  videoStream: z.number().int().safe().min(0).max(255).default(0),
}).superRefine((segment, context) => {
  let priorEndUs = segment.startUs;
  for (const [index, speed] of segment.speed.entries()) {
    if (speed.startUs < segment.startUs || speed.endUs > segment.endUs) {
      context.addIssue({
        code: "custom",
        message: "Every speed range must be contained in its segment.",
        path: ["speed", index],
      });
    }
    if (speed.endUs <= speed.startUs) {
      context.addIssue({
        code: "custom",
        message: "Speed range endUs must be greater than startUs.",
        path: ["speed", index, "endUs"],
      });
    }
    if (speed.startUs < priorEndUs) {
      context.addIssue({
        code: "custom",
        message: "Speed ranges must be ordered and non-overlapping.",
        path: ["speed", index],
      });
    }
    if (speed.endUs - speed.startUs < speed.rampUs * 2 + 100_000) {
      context.addIssue({
        code: "custom",
        message: "A speed range must leave at least 100ms at its target rate after both ramps.",
        path: ["speed", index, "rampUs"],
      });
    }
    priorEndUs = speed.endUs;
  }
});

export const MediaComposeOutputSchema = z.strictObject({
  audioBitrateKbps: z.number().int().safe().min(64).max(512).default(192),
  encoder: z.enum(["h264", "h264-videotoolbox"]).default("h264"),
  frameRate: z.enum([
    "24",
    "25",
    "30",
    "30000/1001",
    "50",
    "60",
    "60000/1001",
  ]).default("30000/1001"),
  height: EvenDimensionSchema.default(1_920),
  maximumBytes: z.number()
    .int()
    .safe()
    .positive()
    .max(MAXIMUM_MEDIA_COMPOSE_OUTPUT_BYTES)
    .default(8 * 1024 * 1024 * 1024),
  videoBitrateKbps: z.number().int().safe().min(500).max(100_000).default(12_000),
  width: EvenDimensionSchema.default(1_080),
}).prefault({});

export const MediaCompositionV1Schema = z.strictObject({
  kind: z.literal("transmute.media-composition"),
  output: MediaComposeOutputSchema,
  schemaVersion: z.literal(1),
  segments: z.array(MediaComposeSegmentSchema)
    .min(2)
    .max(MAXIMUM_COMPOSE_SEGMENTS),
  transition: MediaComposeTransitionSchema.prefault({}),
}).superRefine((composition, context) => {
  for (const [index, segment] of composition.segments.entries()) {
    if (segment.endUs <= segment.startUs) {
      context.addIssue({
        code: "custom",
        message: "Segment endUs must be greater than startUs.",
        path: ["segments", index, "endUs"],
      });
    }
    if (segment.source.includes("\0") || isAbsolute(segment.source)) {
      context.addIssue({
        code: "custom",
        message: "Segment source must be a bounded relative path.",
        path: ["segments", index, "source"],
      });
    }
    if (index === composition.segments.length - 1 && segment.transitionAfter !== undefined) {
      context.addIssue({
        code: "custom",
        message: "The last segment cannot define transitionAfter.",
        path: ["segments", index, "transitionAfter"],
      });
    }
    if (index < composition.segments.length - 1) {
      const next = composition.segments[index + 1]!;
      const transition = segment.transitionAfter ?? composition.transition;
      let durationUs = segment.endUs - segment.startUs;
      let nextDurationUs = next.endUs - next.startUs;
      try {
        durationUs = mediaComposePlaybackPhases(segment).reduce(
          (total, phase) => total + phase.outputDurationUs,
          0,
        );
        nextDurationUs = mediaComposePlaybackPhases(next).reduce(
          (total, phase) => total + phase.outputDurationUs,
          0,
        );
      } catch {
        // Nested segment validation owns the actionable issue. Retaining raw
        // durations here avoids replacing it with a derived-phase error.
      }
      if (
        transition.durationUs >= durationUs
        || transition.durationUs >= nextDurationUs
      ) {
        context.addIssue({
          code: "custom",
          message: "Each transition must be shorter than both adjacent segments.",
          path: ["segments", index, "transitionAfter"],
        });
      }
    }
  }
  if (new Set(composition.segments.map(segment => segment.source)).size > MAXIMUM_COMPOSE_INPUTS) {
    context.addIssue({
      code: "custom",
      message: `A composition may use at most ${String(MAXIMUM_COMPOSE_INPUTS)} unique inputs.`,
      path: ["segments"],
    });
  }
  const speedRanges = composition.segments.reduce(
    (total, segment) => total + segment.speed.length,
    0,
  );
  if (speedRanges > MAXIMUM_COMPOSE_SPEED_RANGES) {
    context.addIssue({
      code: "custom",
      message: `A composition may use at most ${String(MAXIMUM_COMPOSE_SPEED_RANGES)} speed ranges.`,
      path: ["segments"],
    });
  }
});

export type MediaCompositionV1 = z.infer<typeof MediaCompositionV1Schema>;

export interface MediaComposeInputIdentity extends ExpectedLocalMediaInput {
  readonly path: string;
  readonly source: string;
}

export interface BuiltMediaComposeInvocation {
  readonly argv: readonly [string, ...string[]];
  readonly durationUs: number;
  readonly filterGraph: string;
  readonly inputSources: readonly string[];
  readonly transitions: readonly z.infer<typeof MediaComposeTransitionSchema>[];
}

export interface MediaComposePlaybackPhase {
  readonly endUs: number;
  readonly labelRate: number | null;
  readonly outputDurationUs: number;
  readonly rate: number;
  readonly startUs: number;
}

export interface MediaComposeResult extends AtomicRenderOutput {
  readonly durationUs: number;
  readonly filterGraph: string;
  readonly inputs: readonly MediaComposeInputIdentity[];
  readonly outputPath: string;
  readonly composition: MediaCompositionV1;
}

interface PinnedComposeInputs {
  readonly assertUnchanged: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly identities: readonly MediaComposeInputIdentity[];
  readonly processPaths: ReadonlyMap<string, string>;
  readonly runner: ProcessRunner;
}

function decimal(value: number): string {
  if (!Number.isFinite(value)) throw new CliError("internal", "FFmpeg filter value must be finite.");
  const normalized = Math.abs(value) < 0.000_000_000_1 ? 0 : value;
  return normalized.toFixed(10).replace(/0+$/u, "").replace(/\.$/u, "");
}

function seconds(microseconds: number): string {
  return decimal(microseconds / 1_000_000);
}

function atempo(rate: number): string {
  const filters: string[] = [];
  let remaining = rate;
  while (remaining > 100) {
    filters.push("atempo=100");
    remaining /= 100;
  }
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  filters.push(`atempo=${decimal(remaining)}`);
  return filters.join(",");
}

function easedRampRate(from: number, to: number, progress: number): number {
  const eased = progress * progress * (3 - 2 * progress);
  return from + (to - from) * eased;
}

function outputDurationUs(startUs: number, endUs: number, rate: number): number {
  const durationUs = Math.max(1, Math.round((endUs - startUs) / rate));
  if (!Number.isSafeInteger(durationUs)) {
    throw new CliError("invalid-data", "Speed-adjusted media duration is not a safe integer.");
  }
  return durationUs;
}

/**
 * Expand checked speed ranges into bounded constant-rate phases. Six eased
 * steps make both video and pitch-preserving FFmpeg audio transition smoothly
 * without relying on a build-specific runtime filter command.
 */
export function mediaComposePlaybackPhases(
  input: z.infer<typeof MediaComposeSegmentSchema>,
): readonly MediaComposePlaybackPhase[] {
  const segment = MediaComposeSegmentSchema.parse(input);
  const phases: MediaComposePlaybackPhase[] = [];
  const append = (startUs: number, endUs: number, rate: number, labelRate: number | null): void => {
    if (endUs <= startUs) return;
    phases.push({
      endUs,
      labelRate,
      outputDurationUs: outputDurationUs(startUs, endUs, rate),
      rate,
      startUs,
    });
  };
  const ramp = (
    startUs: number,
    endUs: number,
    from: number,
    to: number,
    labelRate: number,
  ): void => {
    const durationUs = endUs - startUs;
    for (let index = 0; index < SPEED_RAMP_STEPS; index += 1) {
      const phaseStartUs = startUs + Math.floor(durationUs * index / SPEED_RAMP_STEPS);
      const phaseEndUs = startUs + Math.floor(durationUs * (index + 1) / SPEED_RAMP_STEPS);
      append(
        phaseStartUs,
        phaseEndUs,
        easedRampRate(from, to, (index + 0.5) / SPEED_RAMP_STEPS),
        labelRate,
      );
    }
  };

  let cursorUs = segment.startUs;
  for (const speed of segment.speed) {
    append(cursorUs, speed.startUs, 1, null);
    ramp(speed.startUs, speed.startUs + speed.rampUs, 1, speed.rate, speed.rate);
    append(
      speed.startUs + speed.rampUs,
      speed.endUs - speed.rampUs,
      speed.rate,
      speed.rate,
    );
    ramp(speed.endUs - speed.rampUs, speed.endUs, speed.rate, 1, speed.rate);
    cursorUs = speed.endUs;
  }
  append(cursorUs, segment.endUs, 1, null);
  if (phases.length === 0) {
    throw new CliError("invalid-data", "Composition segment has no playable duration.");
  }
  return phases;
}

function parseComposition(input: unknown): MediaCompositionV1 {
  const parsed = MediaCompositionV1Schema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new CliError(
      "usage",
      `Invalid media composition${issue?.path.length === 0 ? "" : ` at ${issue?.path.join(".")}`}: ${issue?.message ?? "unknown error"}`,
    );
  }
  return parsed.data;
}

export function parseMediaComposition(input: unknown): MediaCompositionV1 {
  return parseComposition(input);
}

function transitionsFor(composition: MediaCompositionV1) {
  return composition.segments.slice(0, -1).map(segment => (
    segment.transitionAfter ?? composition.transition
  ));
}

function compositionDurationUs(
  composition: MediaCompositionV1,
  transitions: readonly z.infer<typeof MediaComposeTransitionSchema>[],
): number {
  const segmentDuration = composition.segments.reduce(
    (total, segment) => total + mediaComposePlaybackPhases(segment).reduce(
      (subtotal, phase) => subtotal + phase.outputDurationUs,
      0,
    ),
    0,
  );
  const transitionDuration = transitions.reduce(
    (total, transition) => total + transition.durationUs,
    0,
  );
  const durationUs = segmentDuration - transitionDuration;
  if (!Number.isSafeInteger(durationUs) || durationUs <= 0) {
    throw new CliError("invalid-data", "Composition duration is not a positive safe integer.");
  }
  return durationUs;
}

function encodingArguments(composition: MediaCompositionV1): readonly string[] {
  const output = composition.output;
  if (output.encoder === "h264-videotoolbox") {
    return [
      "-c:v", "h264_videotoolbox",
      "-b:v", `${String(output.videoBitrateKbps)}k`,
      "-maxrate", `${String(Math.ceil(output.videoBitrateKbps * 1.35))}k`,
      "-bufsize", `${String(output.videoBitrateKbps * 2)}k`,
      "-profile:v", "high",
      "-allow_sw", "0",
    ];
  }
  return [
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "18",
    "-profile:v", "high",
  ];
}

/** Build a caller-text-free filter graph; caller paths remain isolated in argv. */
export function buildMediaComposeInvocation(options: {
  readonly composition: unknown;
  readonly ffmpeg: string;
  readonly inputPaths: ReadonlyMap<string, string>;
  readonly outputPath: string;
}): BuiltMediaComposeInvocation {
  const composition = parseComposition(options.composition);
  const inputSources = [...new Set(composition.segments.map(segment => segment.source))];
  const sourceIndex = new Map(inputSources.map((source, index) => [source, index]));
  const filters: string[] = [];
  const width = String(composition.output.width);
  const height = String(composition.output.height);
  const segmentDurationsUs: number[] = [];
  for (const [index, segment] of composition.segments.entries()) {
    const inputIndex = sourceIndex.get(segment.source);
    if (inputIndex === undefined) throw new CliError("internal", "Composition source index was lost.");
    const phases = mediaComposePlaybackPhases(segment);
    const segmentDurationUs = phases.reduce((total, phase) => total + phase.outputDurationUs, 0);
    segmentDurationsUs.push(segmentDurationUs);
    if (phases.length === 1 && phases[0]!.rate === 1 && phases[0]!.labelRate === null) {
      filters.push(
        `[${String(inputIndex)}:v:${String(segment.videoStream)}]trim=start=${seconds(segment.startUs)}:end=${seconds(segment.endUs)},setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${composition.output.frameRate},format=yuv420p,settb=AVTB[v${String(index)}]`,
        `[${String(inputIndex)}:a:${String(segment.audioStream)}]atrim=start=${seconds(segment.startUs)}:end=${seconds(segment.endUs)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${String(index)}]`,
      );
      continue;
    }

    let localOutputUs = 0;
    const labelRanges: Array<{ readonly endUs: number; readonly rate: number; readonly startUs: number }> = [];
    for (const [phaseIndex, phase] of phases.entries()) {
      const videoPhase = `v${String(index)}_p${String(phaseIndex)}`;
      const audioPhase = `a${String(index)}_p${String(phaseIndex)}`;
      filters.push(
        `[${String(inputIndex)}:v:${String(segment.videoStream)}]trim=start=${seconds(phase.startUs)}:end=${seconds(phase.endUs)},setpts=(PTS-STARTPTS)/${decimal(phase.rate)},scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${composition.output.frameRate},trim=duration=${seconds(phase.outputDurationUs)},setpts=PTS-STARTPTS,format=yuv420p,settb=AVTB[${videoPhase}]`,
        `[${String(inputIndex)}:a:${String(segment.audioStream)}]atrim=start=${seconds(phase.startUs)}:end=${seconds(phase.endUs)},asetpts=PTS-STARTPTS,aresample=48000,${atempo(phase.rate)},atrim=duration=${seconds(phase.outputDurationUs)},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:channel_layouts=stereo[${audioPhase}]`,
      );
      if (phase.labelRate !== null) {
        const prior = labelRanges.at(-1);
        if (prior?.rate === phase.labelRate && prior.endUs === localOutputUs) {
          labelRanges[labelRanges.length - 1] = {
            ...prior,
            endUs: localOutputUs + phase.outputDurationUs,
          };
        } else {
          labelRanges.push({
            endUs: localOutputUs + phase.outputDurationUs,
            rate: phase.labelRate,
            startUs: localOutputUs,
          });
        }
      }
      localOutputUs += phase.outputDurationUs;
    }
    const phaseInputs = phases.map((_, phaseIndex) => (
      `[v${String(index)}_p${String(phaseIndex)}][a${String(index)}_p${String(phaseIndex)}]`
    )).join("");
    const concatenatedVideoLabel = `v${String(index)}_concat`;
    const rawVideoLabel = labelRanges.length === 0 ? `v${String(index)}` : `v${String(index)}_raw`;
    filters.push(
      `${phaseInputs}concat=n=${String(phases.length)}:v=1:a=1[${concatenatedVideoLabel}][a${String(index)}]`,
      `[${concatenatedVideoLabel}]fps=${composition.output.frameRate},format=yuv420p,settb=AVTB[${rawVideoLabel}]`,
    );
    let labeledVideo = rawVideoLabel;
    for (const [labelIndex, label] of labelRanges.entries()) {
      const next = labelIndex === labelRanges.length - 1
        ? `v${String(index)}`
        : `v${String(index)}_label${String(labelIndex)}`;
      filters.push(
        `[${labeledVideo}]drawtext=text='${decimal(label.rate)}x':fontcolor=white:fontsize='max(32,h*0.035)':box=1:boxcolor=black@0.72:boxborderw=12:x='w-tw-max(36,w*0.04)':y='max(36,h*0.04)':enable='gte(t,${seconds(label.startUs)})*lt(t,${seconds(label.endUs)})'[${next}]`,
      );
      labeledVideo = next;
    }
  }

  const transitions = transitionsFor(composition);
  let videoLabel = "v0";
  let audioLabel = "a0";
  let timelineDurationUs = segmentDurationsUs[0]!;
  for (const [index, transition] of transitions.entries()) {
    const nextIndex = index + 1;
    const outputVideo = `compose_v${String(nextIndex)}`;
    const outputAudio = `compose_a${String(nextIndex)}`;
    const offsetUs = timelineDurationUs - transition.durationUs;
    filters.push(
      `[${videoLabel}][v${String(nextIndex)}]xfade=transition=fade:duration=${seconds(transition.durationUs)}:offset=${seconds(offsetUs)}[${outputVideo}]`,
      `[${audioLabel}][a${String(nextIndex)}]acrossfade=d=${seconds(transition.durationUs)}:c1=tri:c2=tri[${outputAudio}]`,
    );
    videoLabel = outputVideo;
    audioLabel = outputAudio;
    timelineDurationUs = offsetUs + segmentDurationsUs[nextIndex]!;
  }
  const durationUs = compositionDurationUs(composition, transitions);
  if (timelineDurationUs !== durationUs) {
    throw new CliError("internal", "Composition timeline duration drifted while building filters.");
  }

  const argv: string[] = [
    options.ffmpeg,
    "-hide_banner", "-nostdin", "-xerror", "-y",
  ];
  for (const source of inputSources) {
    const inputPath = options.inputPaths.get(source);
    if (inputPath === undefined) {
      throw new CliError("internal", `Composition input was not bound: ${source}`);
    }
    argv.push(...SELF_CONTAINED_MEDIA_INPUT_ARGUMENTS, "-i", inputPath);
  }
  argv.push(
    "-filter_complex", filters.join(";"),
    "-map", `[${videoLabel}]`,
    "-map", `[${audioLabel}]`,
    "-map_metadata", "-1",
    "-sn", "-dn",
    "-t", seconds(durationUs),
    "-fs", String(composition.output.maximumBytes),
    ...encodingArguments(composition),
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", `${String(composition.output.audioBitrateKbps)}k`,
    "-movflags", "+faststart",
    options.outputPath,
  );
  return {
    argv: argv as [string, ...string[]],
    durationUs,
    filterGraph: filters.join(";"),
    inputSources,
    transitions,
  };
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
  if (offset !== bytes) throw new CliError("conflict", "Media input ended while it was being pinned.");
  return hash.digest("hex");
}

class InheritedInputsRunner implements ProcessRunner {
  readonly #descriptors: readonly number[];
  readonly #runner: ProcessRunner;

  constructor(runner: ProcessRunner, descriptors: readonly number[]) {
    this.#descriptors = descriptors;
    this.#runner = runner;
  }

  run(
    argv: readonly [string, ...string[]],
    options: RunOptions = {},
  ): ReturnType<ProcessRunner["run"]> {
    if ((options.inheritedFileDescriptors?.length ?? 0) !== 0) {
      throw new CliError("internal", "Pinned composition execution cannot inherit unrelated descriptors.");
    }
    return this.#runner.run(argv, {
      ...options,
      inheritedFileDescriptors: this.#descriptors,
    });
  }
}

function validateExpectedInput(input: ExpectedLocalMediaInput): void {
  if (
    !Number.isSafeInteger(input.bytes)
    || input.bytes <= 0
    || input.bytes > MAXIMUM_COMPOSE_INPUT_BYTES
    || !Number.isSafeInteger(input.device)
    || input.device < 0
    || !Number.isSafeInteger(input.inode)
    || input.inode < 0
    || !Number.isFinite(input.modifiedAtMs)
    || !/^[a-f0-9]{64}$/u.test(input.sha256)
  ) {
    throw new CliError("internal", "Expected composition input identity is invalid.");
  }
}

async function pinComposeInputs(options: {
  readonly expectedInputs: ReadonlyMap<string, ExpectedLocalMediaInput>;
  readonly composition: MediaCompositionV1;
  readonly runner: ProcessRunner;
  readonly sourceRoot: string;
}): Promise<PinnedComposeInputs> {
  const sourceRoot = await realpath(resolve(options.sourceRoot));
  const sources = [...new Set(options.composition.segments.map(segment => segment.source))];
  const handles: FileHandle[] = [];
  const identities: MediaComposeInputIdentity[] = [];
  const exactStats: BigIntStats[] = [];
  const processPaths = new Map<string, string>();
  try {
    for (const [index, source] of sources.entries()) {
      const expected = options.expectedInputs.get(source);
      if (expected === undefined) throw new CliError("internal", `Expected composition input was not provided: ${source}`);
      validateExpectedInput(expected);
      const path = await resolveSafePath(sourceRoot, source);
      const lexical = await lstat(path).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
          throw new CliError("not-found", `Composition input does not exist: ${source}`);
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
        throw new CliError("conflict", `Composition input changed after inspection: ${source}`);
      }
      const handle = await open(
        path,
        constants.O_RDONLY
          | (constants.O_NOFOLLOW ?? 0)
          | (constants.O_NONBLOCK ?? 0),
      );
      handles.push(handle);
      const [opened, exactBefore] = await Promise.all([
        handle.stat(),
        handle.stat({ bigint: true }),
      ]);
      if (
        !opened.isFile()
        || opened.dev !== lexical.dev
        || opened.ino !== lexical.ino
        || opened.size !== lexical.size
      ) {
        throw new CliError("conflict", `Composition input changed while opening: ${source}`);
      }
      const sha256 = await hashFileHandle(handle, expected.bytes);
      const exactAfter = await handle.stat({ bigint: true });
      if (!sameExactFile(exactBefore, exactAfter) || sha256 !== expected.sha256) {
        throw new CliError("conflict", `Composition input bytes changed before rendering: ${source}`);
      }
      exactStats.push(exactAfter);
      identities.push({ ...expected, path, source });
      processPaths.set(source, `/dev/fd/${String(FIRST_PINNED_CHILD_DESCRIPTOR + index)}`);
    }
    return {
      assertUnchanged: async () => {
        for (const [index, handle] of handles.entries()) {
          const current = await handle.stat({ bigint: true });
          if (!sameExactFile(exactStats[index]!, current)) {
            throw new CliError("conflict", `Composition input changed while rendering: ${sources[index]}`);
          }
        }
      },
      close: async () => {
        await Promise.all(handles.map(async handle => await handle.close().catch(() => undefined)));
      },
      identities,
      processPaths,
      runner: new InheritedInputsRunner(options.runner, handles.map(handle => handle.fd)),
    };
  } catch (error) {
    await Promise.all(handles.map(async handle => await handle.close().catch(() => undefined)));
    throw error;
  }
}

export class LocalMediaComposeService {
  readonly #ffmpeg: string;
  readonly #runner: ProcessRunner;

  constructor(options: { readonly ffmpeg: string; readonly runner: ProcessRunner }) {
    if (options.ffmpeg.trim() === "" || options.ffmpeg.includes("\0")) {
      throw new CliError("usage", "FFmpeg executable must be a bounded nonempty string.");
    }
    this.#ffmpeg = options.ffmpeg;
    this.#runner = options.runner;
  }

  async render(options: {
    readonly composition: unknown;
    readonly expectedInputs: ReadonlyMap<string, ExpectedLocalMediaInput>;
    readonly outputPath: string;
    readonly sourceRoot: string;
  }): Promise<MediaComposeResult> {
    const composition = parseComposition(options.composition);
    const outputPath = resolve(options.outputPath);
    const parent = await lstat(dirname(outputPath));
    if (parent.isSymbolicLink() || !parent.isDirectory()) {
      throw new CliError("unsafe-path", "Composition output directory must be physical.");
    }
    const pinned = await pinComposeInputs({
      composition,
      expectedInputs: options.expectedInputs,
      runner: this.#runner,
      sourceRoot: options.sourceRoot,
    });
    try {
      const built = buildMediaComposeInvocation({
        composition,
        ffmpeg: this.#ffmpeg,
        inputPaths: pinned.processPaths,
        outputPath,
      });
      const output = await executeAtomicRender({
        argv: built.argv,
        beforePublish: pinned.assertUnchanged,
        failureLabel: "FFmpeg media composition failed",
        finalOutputPath: outputPath,
        maximumOutputBytes: composition.output.maximumBytes,
        requireFreshOutput: true,
        runner: pinned.runner,
        timeoutMs: MEDIA_COMPOSE_TIMEOUT_MS,
      });
      return {
        ...output,
        composition,
        durationUs: built.durationUs,
        filterGraph: built.filterGraph,
        inputs: pinned.identities,
        outputPath,
      };
    } finally {
      await pinned.close();
    }
  }
}
