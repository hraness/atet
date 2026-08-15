import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";

import {
  MusicAnalysisV1Schema,
  ProjectAnalysisReferenceSchema,
  SpeechAnalysisV1Schema,
  VideoProjectV1Schema,
  type AnalysisSubject,
  type MusicAnalysisV1,
  type ProjectAssetV1,
  type SpeechAnalysisV1,
  type VideoProjectV1,
} from "../contracts";
import {
  analyzeSpeech,
  canonicalJson,
  canonicalJsonSha256,
  loadAnalysisArtifact,
  saveAnalysisArtifact,
  saveVideoProject,
  sha256Hex,
  type BundleFileSystem,
  type SpeechWordInput,
} from "../core";
import { CliError } from "./errors";
import type { ProcessRunner } from "./io";
import { ensurePrivateDirectory } from "./paths";
import { resolveVerifiedProjectMedia } from "./project-media-integrity";
import { projectAnalysisPath } from "./project-service";
import { resolveAudioAnalysisSubject } from "./audio-analysis";
import { assertCompleteMusicAnalysis } from "./music-analysis-service";

export const ATET_WHISPER_CPP_PROFILE = "atet-whisper-cpp-word-timestamps-v1";
export const ATET_SPEECH_PCM_PROFILE = "pcm-s16le-16000hz-mono-wav-v1";

const SPEECH_SAMPLE_RATE_HZ = 16_000;
const MAXIMUM_PCM_BYTES = 8 * 1024 * 1024 * 1024;
const MAXIMUM_JSON_BYTES = 64 * 1024 * 1024;
const MAXIMUM_WORDS = 1_000_000;
const PROCESS_OUTPUT_BYTES = 1024 * 1024;

type AudioStream = Extract<ProjectAssetV1["streams"][number], { readonly kind: "audio" }>;
export type SpeechAnalysisReference = Extract<
  VideoProjectV1["analyses"][number],
  { readonly kind: "speech" }
>;

export interface WhisperCppRuntime {
  /** A literal executable pathname or command passed directly to the process runner. */
  readonly executable: string;
  readonly modelPath: string;
  /** A caller-probed version string stored in analysis provenance. */
  readonly version: string;
}

export interface LocalSpeechAnalysisConfig {
  readonly language: string;
  readonly minimumFillerConfidence: number;
  readonly processors: number;
  readonly speechHandleUs: number;
  readonly threads: number;
  readonly useGpu: boolean;
}

export interface ParsedWhisperWordTranscript {
  readonly detectedLanguage: string | null;
  readonly words: readonly SpeechWordInput[];
}

export interface LoadedMusicProtection {
  readonly analysis: MusicAnalysisV1;
  readonly reference: Extract<VideoProjectV1["analyses"][number], { readonly kind: "music" }>;
}

export interface LocalSpeechAnalysisResult {
  readonly analysis: SpeechAnalysisV1;
  readonly analysisPath: string;
  readonly musicAnalysisId: string | null;
  readonly reference: SpeechAnalysisReference;
}

export interface RunLocalSpeechAnalysisOptions {
  readonly analysisId?: string;
  readonly config: LocalSpeechAnalysisConfig;
  readonly ffmpeg: string;
  readonly fileSystem?: BundleFileSystem;
  readonly now: Date;
  readonly project: VideoProjectV1;
  readonly projectDirectory: string;
  readonly repositoryRoot: string;
  readonly runner: ProcessRunner;
  readonly runtime: WhisperCppRuntime;
  /** `<asset-id>:<stream-id>` selected by the CLI. */
  readonly source: string;
  readonly useLatestMusicAnalysis?: boolean;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonemptyNulFree(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function normalizedLanguage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replaceAll("_", "-").toLocaleLowerCase("en-US");
  if (normalized === "auto") return normalized;
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/u.test(normalized)) return null;
  return normalized;
}

function whisperLanguage(value: unknown): string | null {
  const normalized = normalizedLanguage(value);
  return normalized === null || normalized === "auto" ? normalized : normalized.split("-")[0] ?? null;
}

function validateConfig(config: LocalSpeechAnalysisConfig): void {
  if (normalizedLanguage(config.language) === null) {
    throw new CliError("usage", "Speech language must be auto or a BCP-47-style language tag.");
  }
  if (!Number.isSafeInteger(config.threads) || config.threads < 1 || config.threads > 256) {
    throw new CliError("usage", "whisper.cpp threads must be an integer from 1 through 256.");
  }
  if (!Number.isSafeInteger(config.processors) || config.processors < 1 || config.processors > 64) {
    throw new CliError("usage", "whisper.cpp processors must be an integer from 1 through 64.");
  }
  if (!Number.isFinite(config.minimumFillerConfidence)
    || config.minimumFillerConfidence < 0
    || config.minimumFillerConfidence > 1) {
    throw new CliError("usage", "Minimum filler confidence must be between zero and one.");
  }
  if (!Number.isSafeInteger(config.speechHandleUs) || config.speechHandleUs < 0) {
    throw new CliError("usage", "Speech handle must be a nonnegative integer number of microseconds.");
  }
}

/** Build the complete whisper.cpp argv used for word-level JSON. No shell string is constructed. */
export function buildWhisperCppSpeechArgv(options: {
  readonly config: LocalSpeechAnalysisConfig;
  readonly inputWavPath: string;
  readonly outputPrefix: string;
  readonly runtime: WhisperCppRuntime;
}): readonly [string, ...string[]] {
  validateConfig(options.config);
  for (const value of [
    options.runtime.executable,
    options.runtime.modelPath,
    options.inputWavPath,
    options.outputPrefix,
  ]) {
    if (!nonemptyNulFree(value) || value.length > 8_192) {
      throw new CliError("usage", "whisper.cpp executable, model, and media paths must be bounded, nonempty, and NUL-free.");
    }
  }
  if (!nonemptyNulFree(options.runtime.version) || options.runtime.version.length > 128) {
    throw new CliError("usage", "whisper.cpp version must be a nonempty, NUL-free string of at most 128 characters.");
  }
  const language = whisperLanguage(options.config.language);
  if (language === null) throw new CliError("usage", "Speech language is invalid.");
  return [
    options.runtime.executable,
    "--model", options.runtime.modelPath,
    "--file", options.inputWavPath,
    "--language", language,
    "--threads", String(options.config.threads),
    "--processors", String(options.config.processors),
    ...(options.config.useGpu ? [] : ["--no-gpu"]),
    "--split-on-word",
    "--max-len", "1",
    "--output-json-full",
    "--output-file", options.outputPrefix,
    "--no-prints",
  ];
}

function wordTimestampFailure(reason: string): CliError {
  return new CliError(
    "invalid-data",
    `whisper.cpp word timestamps are unavailable: ${reason}. Use a whisper.cpp build that supports full JSON word output.`,
  );
}

function boundedWordText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim();
  if (normalized.length === 0 || normalized.length > 256 || /[\r\n\0]/u.test(normalized)) return null;
  return normalized;
}

function isSpecialWhisperToken(text: string): boolean {
  const trimmed = text.trim();
  return /^\[_.*_\]$/u.test(trimmed) || /^<\|.*\|>$/u.test(trimmed);
}

function confidenceFromTokens(value: unknown, segmentText: string): number | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4_096) return null;
  const lexical: { readonly confidence: number; readonly text: string }[] = [];
  for (const token of value) {
    if (!isRecord(token) || typeof token.text !== "string") return null;
    if (isSpecialWhisperToken(token.text) || token.text.trim() === "") continue;
    if (typeof token.p !== "number" || !Number.isFinite(token.p) || token.p < 0 || token.p > 1) return null;
    lexical.push({ confidence: token.p, text: token.text });
  }
  if (lexical.length === 0) return null;
  const tokenText = lexical.map(token => token.text).join("").normalize("NFKC").replace(/\s+/gu, "");
  if (tokenText !== segmentText.replace(/\s+/gu, "")) return null;
  return Math.min(...lexical.map(token => token.confidence));
}

/**
 * Parse only the `--max-len 1 --split-on-word --output-json-full` shape.
 * Segment-level text containing more than one whitespace-delimited word is
 * rejected instead of being assigned a misleading coarse timestamp.
 */
export function parseWhisperCppWordJson(
  input: unknown,
  durationUs: number,
): ParsedWhisperWordTranscript {
  if (!Number.isSafeInteger(durationUs) || durationUs <= 0) {
    throw new CliError("invalid-data", "Speech analysis duration must be a positive integer number of microseconds.");
  }
  let value = input;
  if (typeof input === "string") {
    if (new TextEncoder().encode(input).byteLength > MAXIMUM_JSON_BYTES) {
      throw wordTimestampFailure("full JSON output exceeds the 64 MiB limit");
    }
    try {
      value = JSON.parse(input) as unknown;
    } catch {
      throw wordTimestampFailure("full JSON output is malformed");
    }
  }
  if (!isRecord(value) || !Array.isArray(value.transcription)) {
    throw wordTimestampFailure("full JSON output has no transcription array");
  }
  if (value.transcription.length > MAXIMUM_WORDS) {
    throw wordTimestampFailure("full JSON output exceeds the one-million-word limit");
  }
  const languageCandidates = [
    value.language,
    isRecord(value.result) ? value.result.language : undefined,
    isRecord(value.transcription_info) ? value.transcription_info.language : undefined,
  ].filter(candidate => candidate !== undefined);
  const languages = languageCandidates.map(candidate => normalizedLanguage(candidate));
  if (languages.some(language => language === null || language === "auto")) {
    throw wordTimestampFailure("detected language is invalid");
  }
  const uniqueLanguages = [...new Set(languages as string[])];
  if (uniqueLanguages.length > 1) throw wordTimestampFailure("detected language fields disagree");
  const words: SpeechWordInput[] = [];
  let priorEndUs = 0;
  for (const segment of value.transcription) {
    if (!isRecord(segment) || !isRecord(segment.offsets)) {
      throw wordTimestampFailure("a transcription item has no numeric offsets");
    }
    const text = boundedWordText(segment.text);
    if (text === null || /\s/u.test(text)) {
      throw wordTimestampFailure("the output contains a segment that is not one word");
    }
    const fromMs = segment.offsets.from;
    const toMs = segment.offsets.to;
    if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs)
      || (fromMs as number) < 0 || (toMs as number) <= (fromMs as number)) {
      throw wordTimestampFailure("a word has invalid millisecond offsets");
    }
    const startUs = (fromMs as number) * 1_000;
    const endUs = (toMs as number) * 1_000;
    if (!Number.isSafeInteger(startUs) || !Number.isSafeInteger(endUs)
      || startUs < priorEndUs || endUs > durationUs) {
      throw wordTimestampFailure("word offsets overlap, exceed the asset, or are not safely representable");
    }
    const confidence = confidenceFromTokens(segment.tokens, text);
    if (confidence === null) {
      throw wordTimestampFailure("a word has no matching token probability");
    }
    words.push({ confidence, range: { endUs, startUs }, speaker: null, text });
    priorEndUs = endUs;
  }
  if (words.length > 0 && uniqueLanguages[0] === undefined) {
    throw wordTimestampFailure("full JSON output does not identify the detected language");
  }
  return { detectedLanguage: uniqueLanguages[0] ?? null, words };
}

function seconds(microseconds: number): string {
  return (microseconds / 1_000_000).toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "");
}

async function verifySpeechWavCoverage(
  path: string,
  assetDurationUs: number,
  segmentCount: number,
  maximumBytes: number,
): Promise<void> {
  let lexical;
  try {
    lexical = await lstat(path);
  } catch {
    throw new CliError("subprocess", "FFmpeg speech decode did not create its WAV output.");
  }
  if (
    !lexical.isFile()
    || lexical.isSymbolicLink()
    || lexical.size < 44
    || lexical.size > maximumBytes
    || !Number.isSafeInteger(lexical.size)
  ) {
    throw new CliError("invalid-data", "FFmpeg speech decode produced an unsafe or unexpectedly sized WAV output.");
  }
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.dev !== lexical.dev
      || opened.ino !== lexical.ino
      || opened.size !== lexical.size
    ) {
      throw new CliError("conflict", "Decoded speech WAV changed before validation.");
    }
    const readExactly = async (length: number, position: number): Promise<Buffer> => {
      const bytes = Buffer.allocUnsafe(length);
      const result = await handle.read(bytes, 0, length, position);
      if (result.bytesRead !== length) {
        throw new CliError("invalid-data", "Decoded speech WAV has a truncated chunk header.");
      }
      return bytes;
    };
    const header = await readExactly(12, 0);
    if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") {
      throw new CliError("invalid-data", "FFmpeg speech decode did not produce a RIFF/WAVE file.");
    }
    if (header.readUInt32LE(4) + 8 !== opened.size) {
      throw new CliError("invalid-data", "Decoded speech WAV declares an incomplete or trailing RIFF payload.");
    }
    let dataBytes: number | null = null;
    let formatValid = false;
    let position = 12;
    let chunks = 0;
    while (position + 8 <= opened.size && chunks < 256) {
      const chunk = await readExactly(8, position);
      const identifier = chunk.toString("ascii", 0, 4);
      const size = chunk.readUInt32LE(4);
      const payload = position + 8;
      const paddedEnd = payload + size + (size % 2);
      if (!Number.isSafeInteger(paddedEnd) || paddedEnd > opened.size) {
        throw new CliError("invalid-data", "Decoded speech WAV contains a truncated chunk.");
      }
      if (identifier === "fmt ") {
        if (size < 16) throw new CliError("invalid-data", "Decoded speech WAV has an incomplete format chunk.");
        const format = await readExactly(16, payload);
        formatValid = format.readUInt16LE(0) === 1
          && format.readUInt16LE(2) === 1
          && format.readUInt32LE(4) === SPEECH_SAMPLE_RATE_HZ
          && format.readUInt16LE(12) === 2
          && format.readUInt16LE(14) === 16;
      } else if (identifier === "data") {
        dataBytes = size;
      }
      position = paddedEnd;
      chunks += 1;
    }
    if (!formatValid || dataBytes === null || dataBytes % 2 !== 0) {
      throw new CliError("invalid-data", "Decoded speech WAV does not contain 16 kHz mono signed-16 PCM data.");
    }
    const expectedSamples = Math.round(assetDurationUs * SPEECH_SAMPLE_RATE_HZ / 1_000_000);
    const actualSamples = dataBytes / 2;
    const sampleTolerance = Math.max(2, segmentCount * 2);
    if (Math.abs(actualSamples - expectedSamples) > sampleTolerance) {
      throw new CliError(
        "invalid-data",
        "FFmpeg speech decode produced incomplete PCM timeline coverage.",
        { actualSamples, expectedSamples, sampleTolerance },
      );
    }
    const after = await handle.stat();
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs
    ) {
      throw new CliError("conflict", "Decoded speech WAV changed during validation.");
    }
  } finally {
    await handle.close();
  }
}

/** Decode one logical project audio stream, preserving asset-clock gaps. */
export async function decodeSpeechWav(options: {
  readonly assetDurationUs: number;
  readonly ffmpeg: string;
  readonly outputPath: string;
  readonly repositoryRoot: string;
  readonly runner: ProcessRunner;
  readonly stream: AudioStream;
}): Promise<void> {
  if (!nonemptyNulFree(options.ffmpeg) || !nonemptyNulFree(options.outputPath)) {
    throw new CliError("usage", "FFmpeg and decoded audio paths must be nonempty and NUL-free.");
  }
  const expectedBytes = Math.ceil(options.assetDurationUs * SPEECH_SAMPLE_RATE_HZ * 2 / 1_000_000) + 1024 * 1024;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes > MAXIMUM_PCM_BYTES) {
    throw new CliError("invalid-data", "Decoded speech PCM would exceed its 8 GiB limit.");
  }
  const inputArguments: string[] = [];
  const filters: string[] = [];
  const labels: string[] = [];
  let priorEndUs = 0;
  for (const [index, segment] of options.stream.segments.entries()) {
    if (segment.assetRange.startUs > priorEndUs) {
      const gap = `gap_${index}`;
      filters.push(`anullsrc=r=${SPEECH_SAMPLE_RATE_HZ}:cl=mono:d=${seconds(segment.assetRange.startUs - priorEndUs)}[${gap}]`);
      labels.push(gap);
    }
    inputArguments.push("-i", await resolveVerifiedProjectMedia({
      expected: { bytes: segment.bytes, sha256: segment.sha256 },
      label: `Speech segment ${segment.path}:${segment.streamIndex}`,
      path: segment.path,
      repositoryRoot: options.repositoryRoot,
    }));
    const label = `speech_${index}`;
    filters.push(
      `[${index}:${segment.streamIndex}]atrim=start=${seconds(segment.fileRange.startUs)}:end=${seconds(segment.fileRange.endUs)},asetpts=PTS-STARTPTS,aresample=${SPEECH_SAMPLE_RATE_HZ},aformat=sample_fmts=s16:channel_layouts=mono[${label}]`,
    );
    labels.push(label);
    priorEndUs = segment.assetRange.endUs;
  }
  if (priorEndUs < options.assetDurationUs) {
    const gap = "gap_tail";
    filters.push(`anullsrc=r=${SPEECH_SAMPLE_RATE_HZ}:cl=mono:d=${seconds(options.assetDurationUs - priorEndUs)}[${gap}]`);
    labels.push(gap);
  }
  if (labels.length === 0) throw new CliError("invalid-data", `Audio stream ${options.stream.streamId} has no media segments.`);
  filters.push(`${labels.map(label => `[${label}]`).join("")}concat=n=${labels.length}:v=0:a=1[decoded]`);
  const result = await options.runner.run([
    options.ffmpeg,
    "-hide_banner", "-nostdin", "-y",
    ...inputArguments,
    "-filter_complex", filters.join(";"),
    "-map", "[decoded]",
    "-vn", "-c:a", "pcm_s16le", "-ac", "1", "-ar", String(SPEECH_SAMPLE_RATE_HZ),
    "-t", seconds(options.assetDurationUs),
    "-fs", String(expectedBytes),
    options.outputPath,
  ], { maxOutputBytes: PROCESS_OUTPUT_BYTES });
  if (result.exitCode !== 0) {
    throw new CliError("subprocess", `FFmpeg speech decode failed: ${result.stderr.trim().slice(-4_000) || `exit ${result.exitCode}`}`);
  }
  await verifySpeechWavCoverage(
    options.outputPath,
    options.assetDurationUs,
    options.stream.segments.length,
    expectedBytes,
  );
}

async function readBoundedOwnedText(path: string, maximumBytes: number): Promise<string> {
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size <= 0) {
      throw wordTimestampFailure("full JSON output is missing or unsafe");
    }
    if (before.size > maximumBytes) throw wordTimestampFailure("full JSON output exceeds the 64 MiB limit");
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== before.size || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw wordTimestampFailure("full JSON output changed before it could be read");
      }
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (bytes.byteLength !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
        throw wordTimestampFailure("full JSON output changed while it was being read");
      }
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw wordTimestampFailure("full JSON output is not valid UTF-8");
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw wordTimestampFailure("full JSON output could not be read safely");
  }
}

/** Load and integrity-check the newest music artifact for the exact current stream. */
export async function loadLatestMusicProtectionAnalysis(options: {
  readonly fileSystem: BundleFileSystem;
  readonly project: VideoProjectV1;
  readonly subject: AnalysisSubject;
}): Promise<LoadedMusicProtection | null> {
  const reference = [...options.project.analyses]
    .filter((candidate): candidate is Extract<VideoProjectV1["analyses"][number], { readonly kind: "music" }> =>
      candidate.kind === "music"
      && candidate.assetId === options.subject.assetId
      && candidate.streamId === options.subject.streamId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt)
      || String(right.analysisId).localeCompare(String(left.analysisId)))[0];
  if (reference === undefined) return null;
  let analysis: MusicAnalysisV1;
  try {
    analysis = MusicAnalysisV1Schema.parse(await loadAnalysisArtifact(options.fileSystem, reference.path));
  } catch (error) {
    throw new CliError("invalid-data", `Latest music analysis ${reference.analysisId} cannot be loaded: ${String(error)}`);
  }
  if (analysis.analysisId !== reference.analysisId
    || analysis.subject.assetId !== options.subject.assetId
    || analysis.subject.streamId !== options.subject.streamId
    || analysis.subject.integritySha256 !== options.subject.integritySha256) {
    throw new CliError("conflict", `Latest music analysis ${reference.analysisId} is stale for the selected audio stream.`);
  }
  const asset = options.project.assets.find(candidate => candidate.assetId === options.subject.assetId);
  const stream = asset?.streams.find(candidate => candidate.streamId === options.subject.streamId);
  if (stream?.kind !== "audio") {
    throw new CliError("invalid-data", `Music analysis ${reference.analysisId} has no current audio stream.`);
  }
  assertCompleteMusicAnalysis(analysis, stream);
  const artifactSha256 = sha256Hex(`${canonicalJson(analysis)}\n`);
  if (artifactSha256 !== reference.sha256) {
    throw new CliError("invalid-data", `Latest music analysis ${reference.analysisId} failed its project-reference integrity check.`);
  }
  return { analysis, reference };
}

export function createSpeechAnalysisReference(
  analysis: SpeechAnalysisV1,
  path = projectAnalysisPath("speech", analysis.analysisId),
): SpeechAnalysisReference {
  const validated = SpeechAnalysisV1Schema.parse(analysis);
  return ProjectAnalysisReferenceSchema.parse({
    analysisId: validated.analysisId,
    assetId: validated.subject.assetId,
    createdAt: validated.createdAt,
    fillerCount: validated.result.status === "transcribed" ? validated.result.fillers.length : 0,
    kind: "speech",
    path,
    sha256: sha256Hex(`${canonicalJson(validated)}\n`),
    streamId: validated.subject.streamId,
    wordCount: validated.result.status === "transcribed" ? validated.result.words.length : 0,
  }) as SpeechAnalysisReference;
}

/** Decode, transcribe, parse, and analyze speech while always deleting temporary media. */
export async function runLocalSpeechAnalysis(
  options: RunLocalSpeechAnalysisOptions,
): Promise<LocalSpeechAnalysisResult> {
  validateConfig(options.config);
  const selected = resolveAudioAnalysisSubject(options.project, options.source);
  if (options.useLatestMusicAnalysis && options.fileSystem === undefined) {
    throw new CliError("internal", "A bundle filesystem is required to load music protection analysis.");
  }
  const music = options.useLatestMusicAnalysis
    ? await loadLatestMusicProtectionAnalysis({
      fileSystem: options.fileSystem!,
      project: options.project,
      subject: selected.subject,
    })
    : null;
  const cacheRoot = join(options.projectDirectory, "analysis", "cache");
  await ensurePrivateDirectory(join(options.projectDirectory, "analysis"));
  await ensurePrivateDirectory(cacheRoot);
  const workDirectory = await mkdtemp(join(cacheRoot, "speech-"));
  const pcmPath = join(workDirectory, "input.wav");
  const outputPrefix = join(workDirectory, "transcript");
  try {
    await decodeSpeechWav({
      assetDurationUs: selected.asset.durationUs,
      ffmpeg: options.ffmpeg,
      outputPath: pcmPath,
      repositoryRoot: options.repositoryRoot,
      runner: options.runner,
      stream: selected.stream,
    });
    const argv = buildWhisperCppSpeechArgv({
      config: options.config,
      inputWavPath: pcmPath,
      outputPrefix,
      runtime: options.runtime,
    });
    const process = await options.runner.run(argv, { maxOutputBytes: PROCESS_OUTPUT_BYTES });
    if (process.exitCode !== 0) {
      throw new CliError(
        "subprocess",
        `whisper.cpp speech analysis failed: ${process.stderr.trim().slice(-4_000) || `exit ${process.exitCode}`}`,
      );
    }
    const transcript = parseWhisperCppWordJson(
      await readBoundedOwnedText(`${outputPrefix}.json`, MAXIMUM_JSON_BYTES),
      selected.asset.durationUs,
    );
    const analysisId = options.analysisId ?? `analysis_${randomUUID().replaceAll("-", "")}`;
    const createdAt = options.now.toISOString();
    const requestedLanguage = normalizedLanguage(options.config.language)!;
    if (requestedLanguage !== "auto" && transcript.detectedLanguage !== null
      && whisperLanguage(requestedLanguage) !== whisperLanguage(transcript.detectedLanguage)) {
      throw wordTimestampFailure("detected language does not match the requested language");
    }
    const analysis = analyzeSpeech({
      analysisId,
      config: {
        language: requestedLanguage,
        minimumFillerConfidence: options.config.minimumFillerConfidence,
        speechHandleUs: options.config.speechHandleUs,
      },
      createdAt,
      detectedLanguage: transcript.detectedLanguage
        ?? (requestedLanguage === "auto" ? "" : requestedLanguage),
      durationUs: selected.asset.durationUs,
      inputDigest: canonicalJsonSha256({
        config: options.config,
        musicAnalysisId: music?.analysis.analysisId ?? null,
        pcmProfile: ATET_SPEECH_PCM_PROFILE,
        runtime: {
          executable: canonicalJsonSha256(options.runtime.executable),
          model: canonicalJsonSha256(options.runtime.modelPath),
          version: options.runtime.version,
        },
        subject: selected.subject,
        transcript,
        whisperProfile: ATET_WHISPER_CPP_PROFILE,
      }),
      musicRegions: music?.analysis.musicRegions ?? [],
      subject: selected.subject,
      tool: {
        name: "whisper.cpp",
        profile: ATET_WHISPER_CPP_PROFILE,
        version: options.runtime.version,
      },
      words: transcript.words,
    });
    const validated = SpeechAnalysisV1Schema.parse(analysis);
    const analysisPath = projectAnalysisPath("speech", validated.analysisId);
    return {
      analysis: validated,
      analysisPath,
      musicAnalysisId: music?.analysis.analysisId ?? null,
      reference: createSpeechAnalysisReference(validated, analysisPath),
    };
  } finally {
    await rm(workDirectory, { force: true, recursive: true });
  }
}

/** Persist an already validated result and return the next validated project. */
export async function persistSpeechAnalysis(options: {
  readonly fileSystem: BundleFileSystem;
  readonly project: VideoProjectV1;
  readonly result: LocalSpeechAnalysisResult;
  readonly updatedAt?: Date;
}): Promise<VideoProjectV1> {
  const analysis = SpeechAnalysisV1Schema.parse(options.result.analysis);
  const reference = createSpeechAnalysisReference(analysis, options.result.analysisPath);
  if (canonicalJson(reference) !== canonicalJson(options.result.reference)) {
    throw new CliError("invalid-data", "Speech analysis reference does not match its validated artifact.");
  }
  const requestedTimestamp = (options.updatedAt ?? new Date(analysis.createdAt)).toISOString();
  const timestamp = requestedTimestamp.localeCompare(options.project.updatedAt) < 0
    ? options.project.updatedAt
    : requestedTimestamp;
  const nextProject = VideoProjectV1Schema.parse({
    ...options.project,
    analyses: [
      ...options.project.analyses.filter(existing => existing.analysisId !== analysis.analysisId),
      reference,
    ],
    updatedAt: timestamp,
  });
  await saveAnalysisArtifact(options.fileSystem, analysis, options.result.analysisPath);
  await saveVideoProject(options.fileSystem, nextProject);
  return nextProject;
}
