import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
  MAXIMUM_FACE_ANALYZER_FRAMES,
  MAXIMUM_FACE_ANALYZER_OUTPUT_BYTES,
  type FaceAnalyzerFrameEvent,
} from "../analysis/protocol";
import type { SpeechWordInput } from "../core";
import { executeAtomicRender, type AtomicRenderOutput } from "./atomic-render";
import { CliError } from "./errors";
import {
  parseCompletedFaceAnalyzerRun,
  probeFaceAnalyzerVideoTrackOrdinal,
} from "./face-analysis-service";
import type { ProcessRunner, RunOptions } from "./io";
import { SELF_CONTAINED_MEDIA_INPUT_ARGUMENTS } from "./media-ingest";
import type { ExpectedLocalMediaInput } from "./media-effects-service";
import { ensurePrivateDirectory } from "./paths";
import {
  buildWhisperCppSpeechArgv,
  parseWhisperCppWordJson,
  type WhisperCppRuntime,
} from "./speech-analysis-service";

const MAXIMUM_MEDIA_CAPTION_INPUT_BYTES = 512 * 1024 * 1024 * 1024;
export const MAXIMUM_MEDIA_CAPTION_OUTPUT_BYTES = 64 * 1024 * 1024 * 1024;
const MAXIMUM_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAXIMUM_CAPTION_CUES = 5_000;
const MAXIMUM_VAD_SEGMENTS = 10_000;
const MAXIMUM_ASS_BYTES = 16 * 1024 * 1024;
const MEDIA_CAPTION_TIMEOUT_MS = 12 * 60 * 60_000;
const PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;
const FIRST_PINNED_CHILD_DESCRIPTOR = 3;
const DEFAULT_FACE_SAMPLE_INTERVAL_US = 250_000;
const CAPTION_SPEECH_CONTEXT_US = 2_500_000;
const CAPTION_GRAPHEME_SEGMENTER = new Intl.Segmenter("und", {
  granularity: "grapheme",
});

interface CaptionRange {
  readonly endUs: number;
  readonly startUs: number;
}

export interface MediaCaptionSpeechWindow extends CaptionRange {
  readonly acceptRange: CaptionRange;
}

export interface LocalMediaCaptionVadRuntime {
  readonly executable: string;
  readonly modelPath: string;
}

export interface MediaCaptionPosition {
  readonly faceOverlapScore: number;
  readonly x: number;
  readonly y: number;
}

export interface MediaCaptionCue {
  readonly lines: readonly [string] | readonly [string, string];
  readonly position: MediaCaptionPosition;
  readonly range: CaptionRange;
  readonly sourceWordIndices: readonly number[];
}

export interface MediaCaptionPlan {
  readonly cues: readonly MediaCaptionCue[];
  readonly detectedLanguage: string | null;
  readonly detectedLanguages: readonly string[];
  readonly faceAnalysis: Readonly<{
    backend: unknown | null;
    detections: number;
    frames: number;
    sampleIntervalUs: number;
  }>;
  readonly policy: Readonly<{
    faceAware: true;
    maximumCaptionBottomFraction: 0.68;
    socialMetadataReservedBottomFraction: 0.32;
  }>;
  readonly transcriptSha256: string;
  readonly transcription: Readonly<{
    gpuRequested: boolean;
    gpuUsed: boolean;
    voiceActivityDetection: boolean;
    voiceActivitySegments: number;
    windows: number;
  }>;
  readonly words: number;
}

export interface BuiltMediaCaptionInvocation {
  readonly argv: readonly [string, ...string[]];
  readonly filterGraph: string;
}

export interface MediaCaptionResult extends AtomicRenderOutput {
  readonly assSha256: string | null;
  readonly captionPlan: MediaCaptionPlan;
  readonly filterGraph: string;
  readonly outputPath: string;
}

export interface LocalMediaCaptionSettings {
  readonly audioStreamOrdinal: number;
  readonly encoder: "h264" | "h264-videotoolbox";
  readonly frameHeight: number;
  readonly frameWidth: number;
  readonly language: string;
  readonly maximumOutputBytes: number;
  readonly processors: number;
  readonly sampleIntervalUs?: number;
  readonly threads: number;
  readonly useGpu: boolean;
  readonly videoBitrateKbps: number;
  readonly videoStreamIndex: number;
}

interface PinnedCaptionInput {
  readonly assertUnchanged: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly descriptor: number;
  readonly processPath: string;
}

interface CandidatePosition {
  readonly x: number;
  readonly y: number;
}

function decimal(value: number): string {
  if (!Number.isFinite(value)) throw new CliError("internal", "Caption filter value must be finite.");
  return (Math.abs(value) < 0.000_000_000_1 ? 0 : value)
    .toFixed(10)
    .replace(/0+$/u, "")
    .replace(/\.$/u, "");
}

function seconds(microseconds: number): string {
  return decimal(microseconds / 1_000_000);
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
  if (offset !== bytes) throw new CliError("conflict", "Caption input ended while it was being pinned.");
  return hash.digest("hex");
}

function validateExpectedInput(input: ExpectedLocalMediaInput): void {
  if (
    !Number.isSafeInteger(input.bytes)
    || input.bytes <= 0
    || input.bytes > MAXIMUM_MEDIA_CAPTION_INPUT_BYTES
    || !Number.isSafeInteger(input.device)
    || input.device < 0
    || !Number.isSafeInteger(input.inode)
    || input.inode < 0
    || !Number.isFinite(input.modifiedAtMs)
    || !/^[a-f0-9]{64}$/u.test(input.sha256)
  ) {
    throw new CliError("internal", "Expected caption input identity is invalid.");
  }
}

async function pinCaptionInput(
  inputPath: string,
  expected: ExpectedLocalMediaInput,
): Promise<PinnedCaptionInput> {
  validateExpectedInput(expected);
  if (process.platform === "win32") {
    throw new CliError("unavailable", "Descriptor-pinned local captions require a POSIX host.");
  }
  const lexical = await lstat(inputPath).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new CliError("not-found", `Caption input does not exist: ${inputPath}`);
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
    throw new CliError("conflict", "Caption input changed after inspection.");
  }
  const handle = await open(
    inputPath,
    constants.O_RDONLY
      | (constants.O_NOFOLLOW ?? 0)
      | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const exactBefore = await handle.stat({ bigint: true });
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.dev !== lexical.dev
      || opened.ino !== lexical.ino
      || opened.size !== lexical.size
    ) {
      throw new CliError("conflict", "Caption input changed while it was being opened.");
    }
    const sha256 = await hashFileHandle(handle, expected.bytes);
    const exactAfter = await handle.stat({ bigint: true });
    if (!sameExactFile(exactBefore, exactAfter) || sha256 !== expected.sha256) {
      throw new CliError("conflict", "Caption input bytes changed before analysis.");
    }
    const assertUnchanged = async (): Promise<void> => {
      const [pathStats, openedStats] = await Promise.all([
        lstat(inputPath),
        handle.stat({ bigint: true }),
      ]);
      if (
        pathStats.isSymbolicLink()
        || !pathStats.isFile()
        || BigInt(pathStats.dev) !== exactAfter.dev
        || BigInt(pathStats.ino) !== exactAfter.ino
        || !sameExactFile(exactAfter, openedStats)
      ) {
        throw new CliError("conflict", "Caption input changed during local analysis or rendering.");
      }
    };
    return {
      assertUnchanged,
      close: async () => await handle.close(),
      descriptor: handle.fd,
      processPath: `/dev/fd/${String(FIRST_PINNED_CHILD_DESCRIPTOR)}`,
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

class InheritedCaptionRunner implements ProcessRunner {
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
      throw new CliError("internal", "Caption execution cannot inherit unrelated descriptors.");
    }
    return this.#runner.run(argv, {
      ...options,
      inheritedFileDescriptors: this.#descriptors,
    });
  }
}

function graphemes(value: string): readonly string[] {
  return [...CAPTION_GRAPHEME_SEGMENTER.segment(value)]
    .map(item => item.segment);
}

function tokenSeparator(previous: string, current: string): string {
  if (/^[,.;:!?%\u2026)\]}]/u.test(current)) return "";
  if (/^(?:['\u2019](?:d|ll|m|re|s|t|ve))(?:\b|$)/iu.test(current)) return "";
  if (/[([{\u2018\u201c]$/u.test(previous)) return "";
  return " ";
}

function joinedWords(words: readonly SpeechWordInput[]): string {
  let result = "";
  for (const word of words) {
    const text = word.text.normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (text.length === 0) continue;
    result += result.length === 0 ? text : `${tokenSeparator(result, text)}${text}`;
  }
  return result;
}

function wrapCaptionText(text: string, maximumLineGraphemes = 12): readonly [string] | readonly [string, string] | null {
  const characters = graphemes(text);
  if (characters.length <= maximumLineGraphemes) return [text];
  if (characters.length > maximumLineGraphemes * 2) return null;
  const spaces = characters
    .map((character, index) => (/^\s$/u.test(character) ? index : -1))
    .filter(index => index > 0 && index < characters.length - 1);
  const valid = spaces
    .map(index => ({
      imbalance: Math.abs(index - (characters.length - index - 1)),
      index,
    }))
    .filter(candidate => (
      candidate.index <= maximumLineGraphemes
      && characters.length - candidate.index - 1 <= maximumLineGraphemes
    ))
    .sort((left, right) => left.imbalance - right.imbalance || left.index - right.index);
  const split = valid[0]?.index;
  if (split !== undefined) {
    return [
      characters.slice(0, split).join("").trim(),
      characters.slice(split + 1).join("").trim(),
    ];
  }
  if (!characters.some(character => /^\s$/u.test(character))) {
    const midpoint = Math.ceil(characters.length / 2);
    return [characters.slice(0, midpoint).join(""), characters.slice(midpoint).join("")];
  }
  return null;
}

function cueGroups(words: readonly SpeechWordInput[]): readonly {
  readonly lines: readonly [string] | readonly [string, string];
  readonly range: CaptionRange;
  readonly sourceWordIndices: readonly number[];
}[] {
  const cues: Array<{
    readonly lines: readonly [string] | readonly [string, string];
    readonly range: CaptionRange;
    readonly sourceWordIndices: readonly number[];
  }> = [];
  let group: SpeechWordInput[] = [];
  let indices: number[] = [];
  const finish = (): void => {
    if (group.length === 0) return;
    const text = joinedWords(group);
    const lines = wrapCaptionText(text);
    if (lines === null) throw new CliError("invalid-data", "A transcribed caption cannot fit within two bounded lines.");
    cues.push({
      lines,
      range: {
        endUs: group.at(-1)!.range.endUs,
        startUs: group[0]!.range.startUs,
      },
      sourceWordIndices: indices,
    });
    group = [];
    indices = [];
  };
  for (const [index, word] of words.entries()) {
    const candidate = [...group, word];
    const gapUs = group.length === 0 ? 0 : word.range.startUs - group.at(-1)!.range.endUs;
    const durationUs = word.range.endUs - candidate[0]!.range.startUs;
    const lines = wrapCaptionText(joinedWords(candidate));
    if (
      group.length > 0
      && (
        candidate.length > 7
        || durationUs > 2_800_000
        || gapUs > 600_000
        || lines === null
      )
    ) {
      finish();
    }
    if (wrapCaptionText(joinedWords([word])) === null) {
      throw new CliError("invalid-data", `Transcript word ${String(index)} exceeds the bounded caption width.`);
    }
    group.push(word);
    indices.push(index);
  }
  finish();
  if (cues.length > MAXIMUM_CAPTION_CUES) {
    throw new CliError("invalid-data", `Auto captions exceed the ${String(MAXIMUM_CAPTION_CUES)}-cue bound.`);
  }
  return cues.map((cue, index) => {
    const priorEndUs = cues[index - 1]?.range.endUs ?? 0;
    const nextStartUs = cues[index + 1]?.range.startUs ?? Number.MAX_SAFE_INTEGER;
    return {
      ...cue,
      range: {
        endUs: Math.max(cue.range.endUs, Math.min(cue.range.endUs + 120_000, nextStartUs)),
        startUs: Math.min(cue.range.startUs, Math.max(priorEndUs, cue.range.startUs - 80_000)),
      },
    };
  });
}

function overlapArea(
  left: Readonly<{ height: number; width: number; x: number; y: number }>,
  right: Readonly<{ height: number; width: number; x: number; y: number }>,
): number {
  const width = Math.max(0, Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x));
  const height = Math.max(0, Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y));
  return width * height;
}

function personAvoidanceBox(face: FaceAnalyzerFrameEvent["faces"][number]["bounds"]) {
  const closeUp = face.height >= 0.22 || face.width >= 0.38;
  const horizontalExpansion = closeUp ? 0 : 0.8;
  const x = Math.max(0, face.x - face.width * horizontalExpansion - 0.025);
  const right = Math.min(1, face.x + face.width * (1 + horizontalExpansion) + 0.025);
  const y = Math.max(0, face.y - face.height * (closeUp ? 0.2 : 0.45) - 0.02);
  const bottom = Math.min(1, face.y + face.height * (closeUp ? 1.25 : 5) + 0.04);
  return { height: bottom - y, width: right - x, x, y };
}

export function positionForMediaCaptionCue(
  cue: Readonly<{ lines: readonly string[]; range: CaptionRange }>,
  frames: readonly FaceAnalyzerFrameEvent[],
  prior: CandidatePosition | null,
): MediaCaptionPosition {
  const lineLength = Math.max(...cue.lines.map(line => graphemes(line).length));
  const width = Math.max(0.18, Math.min(0.32, lineLength / 12 * 0.32));
  const height = cue.lines.length === 1 ? 0.07 : 0.115;
  const positions: CandidatePosition[] = [];
  for (const y of [0.1, 0.26, 0.42, 0.56]) {
    for (const x of [0.15, 0.32, 0.5, 0.68, 0.85]) positions.push({ x, y });
  }
  const relevant = frames.filter(frame => (
    frame.ptsUs >= Math.max(0, cue.range.startUs - DEFAULT_FACE_SAMPLE_INTERVAL_US)
    && frame.ptsUs <= cue.range.endUs + DEFAULT_FACE_SAMPLE_INTERVAL_US
  ));
  const sampled = relevant.length > 0
    ? relevant
    : [...frames]
      .sort((left, right) => (
        Math.abs(left.ptsUs - (cue.range.startUs + cue.range.endUs) / 2)
        - Math.abs(right.ptsUs - (cue.range.startUs + cue.range.endUs) / 2)
      ))
      .slice(0, 1);
  const scored = positions.map(position => {
    const caption = {
      height,
      width,
      x: Math.max(0.01, Math.min(0.99 - width, position.x - width / 2)),
      y: position.y,
    };
    const renderedPosition = { x: caption.x + width / 2, y: caption.y };
    const overlap = sampled.reduce((total, frame) => total + frame.faces.reduce(
      (frameTotal, face) => frameTotal + overlapArea(caption, personAvoidanceBox(face.bounds)) * face.confidence,
      0,
    ), 0) / Math.max(1, sampled.length);
    const preference = Math.abs(renderedPosition.x - 0.5) * 0.000_2
      + Math.abs(renderedPosition.y - 0.56) * 0.000_1
      + (prior === null ? 0 : (Math.abs(renderedPosition.x - prior.x) + Math.abs(renderedPosition.y - prior.y)) * 0.000_05);
    return { overlap, position: renderedPosition, score: overlap + preference };
  }).sort((left, right) => left.score - right.score || left.position.y - right.position.y || left.position.x - right.position.x);
  const selected = scored[0]!;
  return {
    faceOverlapScore: Number(selected.overlap.toFixed(8)),
    x: selected.position.x,
    y: selected.position.y,
  };
}

export function compileMediaCaptionCues(
  words: readonly SpeechWordInput[],
  frames: readonly FaceAnalyzerFrameEvent[],
): readonly MediaCaptionCue[] {
  let prior: CandidatePosition | null = null;
  return cueGroups(words).map(cue => {
    const position = positionForMediaCaptionCue(cue, frames, prior);
    prior = position;
    return { ...cue, position };
  });
}

function centisecondsToMicroseconds(value: string): number | null {
  const match = /^(0|[1-9][0-9]*)\.([0-9]{2})$/u.exec(value);
  if (match === null) return null;
  const whole = Number(match[1]);
  const fraction = Number(match[2]);
  const microseconds = (whole * 100 + fraction) * 100;
  return Number.isSafeInteger(microseconds) ? microseconds : null;
}

/** Parse the bounded, centisecond VAD protocol emitted by whisper.cpp's local helper. */
export function parseWhisperVadSpeechSegments(
  output: string,
  durationUs: number,
): readonly CaptionRange[] {
  if (!Number.isSafeInteger(durationUs) || durationUs <= 0) {
    throw new CliError("invalid-data", "Caption VAD duration must be positive integer microseconds.");
  }
  if (Buffer.byteLength(output, "utf8") > PROCESS_OUTPUT_BYTES) {
    throw new CliError("invalid-data", "Caption VAD output exceeds its 4 MiB bound.");
  }
  const lines = output.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const header = /^Detected ([0-9]+) speech segments:$/u.exec(lines[0] ?? "");
  if (header === null) {
    throw new CliError("invalid-data", "Caption VAD output omits its segment-count header.");
  }
  const declared = Number(header[1]);
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > MAXIMUM_VAD_SEGMENTS) {
    throw new CliError("invalid-data", `Caption VAD exceeds the ${String(MAXIMUM_VAD_SEGMENTS)}-segment bound.`);
  }
  if (lines.length !== declared + 1) {
    throw new CliError("invalid-data", "Caption VAD output does not match its declared segment count.");
  }
  const ranges: CaptionRange[] = [];
  for (let index = 0; index < declared; index += 1) {
    const match = /^Speech segment ([0-9]+): start = ([0-9]+\.[0-9]{2}), end = ([0-9]+\.[0-9]{2})$/u
      .exec(lines[index + 1]!);
    if (match === null || Number(match[1]) !== index) {
      throw new CliError("invalid-data", "Caption VAD output contains an invalid or unordered segment.");
    }
    const startUs = centisecondsToMicroseconds(match[2]!);
    const endUs = centisecondsToMicroseconds(match[3]!);
    const priorEndUs = ranges.at(-1)?.endUs ?? 0;
    if (
      startUs === null
      || endUs === null
      || startUs < priorEndUs
      || endUs <= startUs
      || endUs > durationUs
    ) {
      throw new CliError("invalid-data", "Caption VAD produced overlapping or out-of-range speech segments.");
    }
    ranges.push({ endUs, startUs });
  }
  return ranges;
}

/** Build short language-redetection windows while retaining bounded context around speech. */
export function buildMediaCaptionSpeechWindows(
  durationUs: number,
  speechRanges: readonly CaptionRange[] | null,
): readonly MediaCaptionSpeechWindow[] {
  if (!Number.isSafeInteger(durationUs) || durationUs <= 0) {
    throw new CliError("invalid-data", "Caption duration must be positive integer microseconds.");
  }
  if (speechRanges === null) {
    const result: MediaCaptionSpeechWindow[] = [];
    for (let acceptStartUs = 0; acceptStartUs < durationUs; acceptStartUs += 30_000_000) {
      const acceptEndUs = Math.min(durationUs, acceptStartUs + 30_000_000);
      result.push({
        acceptRange: { endUs: acceptEndUs, startUs: acceptStartUs },
        endUs: Math.min(durationUs, acceptEndUs + 1_000_000),
        startUs: Math.max(0, acceptStartUs - 1_000_000),
      });
    }
    return result;
  }
  if (speechRanges.length === 0) return [];
  const grouped: CaptionRange[] = [];
  for (const range of speechRanges) {
    const prior = grouped.at(-1);
    if (
      !Number.isSafeInteger(range.startUs)
      || !Number.isSafeInteger(range.endUs)
      || range.startUs < 0
      || range.endUs <= range.startUs
      || range.endUs > durationUs
      || (prior !== undefined && range.startUs < prior.endUs)
    ) {
      throw new CliError("invalid-data", "Caption speech ranges must be ordered and inside the media duration.");
    }
    if (
      prior !== undefined
      && range.startUs - prior.endUs <= 7_000_000
      && range.endUs - prior.startUs <= 28_000_000
    ) {
      grouped[grouped.length - 1] = { endUs: range.endUs, startUs: prior.startUs };
    } else {
      grouped.push({ ...range });
    }
  }
  return grouped.map(range => {
    const acceptStartUs = Math.max(0, range.startUs - CAPTION_SPEECH_CONTEXT_US);
    const acceptEndUs = Math.min(durationUs, range.endUs + CAPTION_SPEECH_CONTEXT_US);
    return {
      acceptRange: { endUs: acceptEndUs, startUs: acceptStartUs },
      endUs: acceptEndUs,
      startUs: acceptStartUs,
    };
  });
}

const NON_DIALOGUE_DESCRIPTION = /^(?:\(|\[)\s*(?:[^\])]*(?:applause|breathing|cheering|engine|eerie|foreign language|grunting|inaudible|laughing|laughter|music|revving|sighing|speaking in|wind|whoosh)[^\])]*)(?:\)|\])\s*[.!?]?$/iu;

/** Remove generated sound-description spans; captions intentionally contain spoken words only. */
export function removeNonDialogueTranscriptWords(
  words: readonly SpeechWordInput[],
): readonly SpeechWordInput[] {
  const retained: SpeechWordInput[] = [];
  for (let index = 0; index < words.length;) {
    const current = words[index]!;
    const normalized = current.text.normalize("NFKC").trim();
    if (/^(?:\(|\[)/u.test(normalized)) {
      const span: SpeechWordInput[] = [];
      let cursor = index;
      while (cursor < words.length && span.length < 16) {
        const candidate = words[cursor]!;
        span.push(candidate);
        cursor += 1;
        if (/[\])]\s*[.!?]?$/u.test(candidate.text.normalize("NFKC").trim())) break;
      }
      if (NON_DIALOGUE_DESCRIPTION.test(joinedWords(span))) {
        index = cursor;
        continue;
      }
    }
    if (!/^[\u266a\u266b]+$/u.test(normalized)) retained.push(current);
    index += 1;
  }
  return retained;
}

export function removeHallucinatedTranscriptRepetition(words: readonly SpeechWordInput[]): readonly SpeechWordInput[] {
  const retained: SpeechWordInput[] = [];
  for (let index = 0; index < words.length;) {
    const key = words[index]!.text
      .normalize("NFKC")
      .toLocaleLowerCase("und")
      .replace(/[^\p{Letter}\p{Number}]+/gu, "");
    let cursor = index + 1;
    while (
      key.length > 0
      && cursor < words.length
      && words[cursor]!.range.startUs - words[cursor - 1]!.range.endUs <= 1_500_000
      && words[cursor]!.text
        .normalize("NFKC")
        .toLocaleLowerCase("und")
        .replace(/[^\p{Letter}\p{Number}]+/gu, "") === key
    ) cursor += 1;
    const run = words.slice(index, cursor);
    const repeatedSingleToken = run.length === 1
      && /^(\p{Letter}|\p{Number})\1{3,}$/iu.test(key);
    if (
      !repeatedSingleToken
      && run.length < 4
      && !(run.length >= 3 && run.some(word => word.confidence < 0.25))
    ) retained.push(...run);
    index = cursor;
  }
  return retained;
}

function wordMidpointUs(word: SpeechWordInput): number {
  return (word.range.startUs + word.range.endUs) / 2;
}

function midpointInside(midpointUs: number, range: CaptionRange, paddingUs = 0): boolean {
  return midpointUs >= Math.max(0, range.startUs - paddingUs)
    && midpointUs <= range.endUs + paddingUs;
}

export function selectMediaCaptionWindowWords(
  words: readonly SpeechWordInput[],
  window: MediaCaptionSpeechWindow,
  speechRanges: readonly CaptionRange[] | null,
): readonly SpeechWordInput[] {
  return words.flatMap(word => {
    const midpointUs = wordMidpointUs(word);
    if (
      !midpointInside(midpointUs, window.acceptRange)
      || (speechRanges !== null && !speechRanges.some(range => midpointInside(midpointUs, range, CAPTION_SPEECH_CONTEXT_US)))
    ) return [];
    const startUs = Math.max(window.acceptRange.startUs, word.range.startUs);
    const endUs = Math.min(window.acceptRange.endUs, word.range.endUs);
    return endUs - startUs < 20_000
      ? []
      : [{ ...word, range: { endUs, startUs } }];
  });
}

function mergeCaptionWords(words: readonly SpeechWordInput[]): readonly SpeechWordInput[] {
  const ordered = [...words].sort((left, right) => (
    left.range.startUs - right.range.startUs
    || left.range.endUs - right.range.endUs
    || right.confidence - left.confidence
  ));
  const merged: SpeechWordInput[] = [];
  for (const word of ordered) {
    const prior = merged.at(-1);
    if (prior === undefined || word.range.startUs >= prior.range.endUs) {
      merged.push(word);
      continue;
    }
    if (
      word.text.normalize("NFKC").trim().toLocaleLowerCase("und")
      === prior.text.normalize("NFKC").trim().toLocaleLowerCase("und")
    ) {
      if (word.confidence > prior.confidence) merged[merged.length - 1] = word;
      continue;
    }
    const adjustedStartUs = prior.range.endUs;
    if (word.range.endUs - adjustedStartUs >= 20_000) {
      merged.push({ ...word, range: { endUs: word.range.endUs, startUs: adjustedStartUs } });
    }
  }
  return removeHallucinatedTranscriptRepetition(removeNonDialogueTranscriptWords(merged));
}

function assTime(microseconds: number, roundUp: boolean): string {
  const centiseconds = Math.max(0, roundUp
    ? Math.ceil(microseconds / 10_000)
    : Math.floor(microseconds / 10_000));
  const hours = Math.floor(centiseconds / 360_000);
  const minutes = Math.floor(centiseconds / 6_000) % 60;
  const seconds = Math.floor(centiseconds / 100) % 60;
  const fraction = centiseconds % 100;
  return `${String(hours)}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
}

function assText(lines: readonly string[]): string {
  return lines.map(line => line
    .normalize("NFKC")
    .replace(/[\r\n\0]/gu, " ")
    .replaceAll("\\", "＼")
    .replaceAll("{", "｛")
    .replaceAll("}", "｝"))
    .join("\\N");
}

export function buildMediaCaptionAss(
  cues: readonly MediaCaptionCue[],
  output: Readonly<{ frameHeight: number; frameWidth: number }>,
): string {
  const fontSize = Math.max(24, Math.round(Math.min(output.frameWidth, output.frameHeight) * 0.06));
  const outline = Math.max(2, Math.round(fontSize * 0.08));
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${String(output.frameWidth)}`,
    `PlayResY: ${String(output.frameHeight)}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "YCbCr Matrix: TV.709",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: SocialSafe,Arial,${String(fontSize)},&H00FFFFFF,&H00FFFFFF,&H78000000,&H78000000,-1,0,0,0,100,100,0,0,3,${String(outline)},0,8,36,36,36,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  const events = cues.map(cue => {
    const x = Math.round(cue.position.x * output.frameWidth);
    const y = Math.round(cue.position.y * output.frameHeight);
    const endUs = Math.max(cue.range.startUs + 10_000, cue.range.endUs);
    return `Dialogue: 0,${assTime(cue.range.startUs, false)},${assTime(endUs, true)},SocialSafe,,0,0,0,,{\\an8\\pos(${String(x)},${String(y)})\\q2}${assText(cue.lines)}`;
  });
  const result = [...header, ...events, ""].join("\n");
  if (Buffer.byteLength(result, "utf8") > MAXIMUM_ASS_BYTES) {
    throw new CliError("invalid-data", "Generated captions exceed the 16 MiB ASS bound.");
  }
  return result;
}

function encodingArguments(settings: LocalMediaCaptionSettings): readonly string[] {
  if (settings.encoder === "h264-videotoolbox") {
    return [
      "-c:v", "h264_videotoolbox",
      "-b:v", `${String(settings.videoBitrateKbps)}k`,
      "-maxrate", `${String(Math.ceil(settings.videoBitrateKbps * 1.35))}k`,
      "-bufsize", `${String(settings.videoBitrateKbps * 2)}k`,
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

export function buildMediaCaptionInvocation(options: {
  readonly assPath: string | null;
  readonly durationUs: number;
  readonly ffmpeg: string;
  readonly inputPath: string;
  readonly outputPath: string;
  readonly settings: LocalMediaCaptionSettings;
}): BuiltMediaCaptionInvocation {
  const filterGraph = options.assPath === null
    ? `[0:v:${String(options.settings.videoStreamIndex)}]null[captioned_video]`
    : `[0:v:${String(options.settings.videoStreamIndex)}]subtitles=filename=${options.assPath}[captioned_video]`;
  const argv: string[] = [
    options.ffmpeg,
    "-hide_banner", "-nostdin", "-xerror", "-y",
    ...SELF_CONTAINED_MEDIA_INPUT_ARGUMENTS,
    "-i", options.inputPath,
    "-filter_complex", filterGraph,
    "-map", "[captioned_video]",
    "-map", `0:a:${String(options.settings.audioStreamOrdinal)}`,
    "-map_metadata", "-1",
    "-sn", "-dn",
    "-t", seconds(options.durationUs),
    "-fs", String(options.settings.maximumOutputBytes),
    ...encodingArguments(options.settings),
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-movflags", "+faststart",
    options.outputPath,
  ];
  return { argv: argv as [string, ...string[]], filterGraph };
}

async function readBoundedTranscript(path: string): Promise<string> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size <= 0 || stats.size > MAXIMUM_TRANSCRIPT_BYTES) {
    throw new CliError("invalid-data", "whisper.cpp produced an unsafe or oversized transcript file.");
  }
  const contents = await readFile(path, "utf8");
  if (Buffer.byteLength(contents, "utf8") !== stats.size) {
    throw new CliError("conflict", "whisper.cpp transcript changed while it was being read.");
  }
  return contents;
}

export function buildMediaCaptionVadArgv(options: {
  readonly inputWavPath: string;
  readonly runtime: LocalMediaCaptionVadRuntime;
  readonly threads: number;
}): readonly [string, ...string[]] {
  for (const value of [
    options.inputWavPath,
    options.runtime.executable,
    options.runtime.modelPath,
  ]) {
    if (value.length === 0 || value.length > 8_192 || value.includes("\0")) {
      throw new CliError("usage", "Caption VAD executable, model, and audio paths must be bounded, nonempty, and NUL-free.");
    }
  }
  if (!Number.isSafeInteger(options.threads) || options.threads < 1 || options.threads > 256) {
    throw new CliError("usage", "Caption VAD threads must be an integer from 1 through 256.");
  }
  return [
    options.runtime.executable,
    "--file", options.inputWavPath,
    "--vad-model", options.runtime.modelPath,
    "--threads", String(options.threads),
    "--vad-threshold", "0.3",
    "--vad-min-speech-duration-ms", "100",
    "--vad-min-silence-duration-ms", "250",
    "--vad-max-speech-duration-s", "20",
    "--vad-speech-pad-ms", "240",
    "--no-prints",
  ];
}

export class LocalMediaCaptionService {
  readonly #faceAnalyzer: string;
  readonly #ffmpeg: string;
  readonly #ffprobe: string;
  readonly #runner: ProcessRunner;
  readonly #vad: LocalMediaCaptionVadRuntime | null;
  readonly #whisper: WhisperCppRuntime;

  constructor(options: {
    readonly faceAnalyzer: string;
    readonly ffmpeg: string;
    readonly ffprobe: string;
    readonly runner: ProcessRunner;
    readonly vad?: LocalMediaCaptionVadRuntime | null;
    readonly whisper: WhisperCppRuntime;
  }) {
    this.#faceAnalyzer = options.faceAnalyzer;
    this.#ffmpeg = options.ffmpeg;
    this.#ffprobe = options.ffprobe;
    this.#runner = options.runner;
    this.#vad = options.vad ?? null;
    this.#whisper = options.whisper;
  }

  async render(options: {
    readonly durationUs: number;
    readonly expectedInput: ExpectedLocalMediaInput;
    readonly inputPath: string;
    readonly outputPath: string;
    readonly settings: LocalMediaCaptionSettings;
    readonly workRoot: string;
  }): Promise<MediaCaptionResult> {
    const inputPath = resolve(options.inputPath);
    const outputPath = resolve(options.outputPath);
    if (inputPath === outputPath) throw new CliError("usage", "Caption output must not overwrite its input.");
    if (!Number.isSafeInteger(options.durationUs) || options.durationUs <= 0) {
      throw new CliError("invalid-data", "Caption input duration must be positive integer microseconds.");
    }
    const parent = await lstat(dirname(outputPath));
    if (parent.isSymbolicLink() || !parent.isDirectory()) {
      throw new CliError("unsafe-path", "Caption output directory must be physical.");
    }
    await ensurePrivateDirectory(options.workRoot);
    const workDirectory = await mkdtemp(join(resolve(options.workRoot), "media-caption-"));
    await chmod(workDirectory, 0o700);
    const pinned = await pinCaptionInput(inputPath, options.expectedInput);
    const pcmPath = join(workDirectory, "input.wav");
    const transcriptPrefix = join(workDirectory, "transcript");
    let assHandle: FileHandle | null = null;
    try {
      const decode = await this.#runner.run([
        this.#ffmpeg,
        "-hide_banner", "-nostdin", "-xerror", "-y",
        ...SELF_CONTAINED_MEDIA_INPUT_ARGUMENTS,
        "-i", pinned.processPath,
        "-map", `0:a:${String(options.settings.audioStreamOrdinal)}`,
        "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
        "-f", "wav", pcmPath,
      ], {
        inheritedFileDescriptors: [pinned.descriptor],
        maxOutputBytes: PROCESS_OUTPUT_BYTES,
        timeoutMs: MEDIA_CAPTION_TIMEOUT_MS,
      });
      if (decode.exitCode !== 0) {
        throw new CliError("subprocess", `FFmpeg caption audio decode failed: ${decode.stderr.trim().slice(-4_000) || `exit ${decode.exitCode}`}`);
      }
      await pinned.assertUnchanged();
      let speechRanges: readonly CaptionRange[] | null = null;
      if (this.#vad !== null) {
        const vad = await this.#runner.run(buildMediaCaptionVadArgv({
          inputWavPath: pcmPath,
          runtime: this.#vad,
          threads: options.settings.threads,
        }), {
          maxOutputBytes: PROCESS_OUTPUT_BYTES,
          timeoutMs: MEDIA_CAPTION_TIMEOUT_MS,
        });
        if (vad.exitCode !== 0) {
          throw new CliError("subprocess", `Local caption voice detection failed: ${vad.stderr.trim().slice(-4_000) || `exit ${vad.exitCode}`}`);
        }
        speechRanges = parseWhisperVadSpeechSegments(vad.stdout, options.durationUs);
        await pinned.assertUnchanged();
      }
      const windows = buildMediaCaptionSpeechWindows(options.durationUs, speechRanges);
      const whisperConfig = {
          language: options.settings.language,
          minimumFillerConfidence: 0.82,
          processors: options.settings.processors,
          speechHandleUs: 0,
          threads: options.settings.threads,
          useGpu: options.settings.useGpu,
      } as const;
      let useGpu = options.settings.useGpu;
      const detectedLanguages = new Set<string>();
      const windowWords: SpeechWordInput[] = [];
      for (const [windowIndex, window] of windows.entries()) {
        const windowPrefix = `${transcriptPrefix}-${String(windowIndex)}`;
        const offsetMs = Math.floor(window.startUs / 1_000);
        const durationMs = Math.max(100, Math.ceil(window.endUs / 1_000) - offsetMs);
        const buildArgv = (gpu: boolean) => buildWhisperCppSpeechArgv({
          config: { ...whisperConfig, useGpu: gpu },
          inputWavPath: pcmPath,
          outputPrefix: windowPrefix,
          runtime: this.#whisper,
          suppressNonSpeechTokens: true,
          window: { durationMs, offsetMs },
        });
        let whisper = await this.#runner.run(buildArgv(useGpu), {
          maxOutputBytes: PROCESS_OUTPUT_BYTES,
          timeoutMs: MEDIA_CAPTION_TIMEOUT_MS,
        });
        if (whisper.exitCode !== 0 && useGpu) {
          await rm(`${windowPrefix}.json`, { force: true });
          useGpu = false;
          whisper = await this.#runner.run(buildArgv(false), {
            maxOutputBytes: PROCESS_OUTPUT_BYTES,
            timeoutMs: MEDIA_CAPTION_TIMEOUT_MS,
          });
        }
        if (whisper.exitCode !== 0) {
          throw new CliError("subprocess", `whisper.cpp auto-caption transcription failed in speech window ${String(windowIndex + 1)}: ${whisper.stderr.trim().slice(-4_000) || `exit ${whisper.exitCode}`}`);
        }
        const transcriptText = await readBoundedTranscript(`${windowPrefix}.json`);
        const parsed = parseWhisperCppWordJson(
          transcriptText,
          Math.min(Number.MAX_SAFE_INTEGER, options.durationUs + 30_000_000),
          { skipZeroDurationWords: true },
        );
        const selected = selectMediaCaptionWindowWords(parsed.words, window, speechRanges);
        if (selected.length > 0 && parsed.detectedLanguage !== null) {
          detectedLanguages.add(parsed.detectedLanguage);
        }
        windowWords.push(...selected);
      }
      const transcript = {
        detectedLanguage: detectedLanguages.size === 1 ? [...detectedLanguages][0]! : null,
        detectedLanguages: [...detectedLanguages].sort(),
        words: mergeCaptionWords(windowWords),
      } as const;
      const gpuUsed = options.settings.useGpu && useGpu && windows.length > 0;
      await pinned.assertUnchanged();

      const sampleIntervalUs = options.settings.sampleIntervalUs ?? DEFAULT_FACE_SAMPLE_INTERVAL_US;
      let frames: readonly FaceAnalyzerFrameEvent[] = [];
      let faceBackend: unknown | null = null;
      if (transcript.words.length > 0) {
        const track = await probeFaceAnalyzerVideoTrackOrdinal({
          absolutePath: inputPath,
          ffprobe: this.#ffprobe,
          runner: this.#runner,
          streamIndex: options.settings.videoStreamIndex,
        });
        await pinned.assertUnchanged();
        const maximumFrames = Math.ceil(options.durationUs / sampleIntervalUs) + 1;
        if (maximumFrames > MAXIMUM_FACE_ANALYZER_FRAMES) {
          throw new CliError("usage", "Caption face analysis exceeds its bounded frame budget; increase the sample interval.");
        }
        const face = await this.#runner.run([
          this.#faceAnalyzer,
          "--input", inputPath,
          "--video-track-ordinal", String(track.ordinal),
          "--start-us", "0",
          "--end-us", String(options.durationUs),
          "--sample-interval-us", String(sampleIntervalUs),
          "--max-faces-per-frame", "32",
          "--max-frames", String(maximumFrames),
          "--max-output-bytes", String(MAXIMUM_FACE_ANALYZER_OUTPUT_BYTES),
          "--minimum-confidence", "0.6",
        ], {
          maxOutputBytes: MAXIMUM_FACE_ANALYZER_OUTPUT_BYTES,
          timeoutMs: MEDIA_CAPTION_TIMEOUT_MS,
        });
        const parsed = parseCompletedFaceAnalyzerRun(face.stdout, {
          endUs: options.durationUs,
          maximumFacesPerFrame: 32,
          maximumFrames,
          minimumConfidence: 0.6,
          sampleIntervalUs,
          startUs: 0,
          totalVideoTracks: track.totalVideoTracks,
          videoTrackOrdinal: track.ordinal,
        });
        if (face.exitCode !== 0) {
          throw new CliError("subprocess", `Face-aware caption analysis failed: ${face.stderr.trim().slice(-4_000) || `exit ${face.exitCode}`}`);
        }
        frames = parsed.frames;
        faceBackend = parsed.started.backend;
        await pinned.assertUnchanged();
      }

      const cues = compileMediaCaptionCues(transcript.words, frames);
      const ass = cues.length === 0
        ? null
        : buildMediaCaptionAss(cues, options.settings);
      let assSha256: string | null = null;
      let assProcessPath: string | null = null;
      const descriptors = [pinned.descriptor];
      if (ass !== null) {
        const assPath = join(workDirectory, "captions.ass");
        await writeFile(assPath, ass, { encoding: "utf8", flag: "wx", mode: 0o600 });
        assSha256 = createHash("sha256").update(ass).digest("hex");
        assHandle = await open(assPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        descriptors.push(assHandle.fd);
        assProcessPath = `/dev/fd/${String(FIRST_PINNED_CHILD_DESCRIPTOR + 1)}`;
      }
      const built = buildMediaCaptionInvocation({
        assPath: assProcessPath,
        durationUs: options.durationUs,
        ffmpeg: this.#ffmpeg,
        inputPath: pinned.processPath,
        outputPath,
        settings: options.settings,
      });
      const output = await executeAtomicRender({
        argv: built.argv,
        beforePublish: pinned.assertUnchanged,
        failureLabel: "FFmpeg face-aware caption render failed",
        finalOutputPath: outputPath,
        maximumOutputBytes: options.settings.maximumOutputBytes,
        requireFreshOutput: true,
        runner: new InheritedCaptionRunner(this.#runner, descriptors),
        timeoutMs: MEDIA_CAPTION_TIMEOUT_MS,
      });
      const transcriptSha256 = createHash("sha256")
        .update(JSON.stringify(transcript))
        .digest("hex");
      return {
        ...output,
        assSha256,
        captionPlan: {
          cues,
          detectedLanguage: transcript.detectedLanguage,
          detectedLanguages: transcript.detectedLanguages,
          faceAnalysis: {
            backend: faceBackend,
            detections: frames.reduce((total, frame) => total + frame.faces.length, 0),
            frames: frames.length,
            sampleIntervalUs,
          },
          policy: {
            faceAware: true,
            maximumCaptionBottomFraction: 0.68,
            socialMetadataReservedBottomFraction: 0.32,
          },
          transcriptSha256,
          transcription: {
            gpuRequested: options.settings.useGpu,
            gpuUsed,
            voiceActivityDetection: speechRanges !== null,
            voiceActivitySegments: speechRanges?.length ?? 0,
            windows: windows.length,
          },
          words: transcript.words.length,
        },
        filterGraph: built.filterGraph,
        outputPath,
      };
    } finally {
      await assHandle?.close().catch(() => undefined);
      await pinned.close().catch(() => undefined);
      await rm(workDirectory, { force: true, recursive: true });
    }
  }
}
