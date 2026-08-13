import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  AnalysisIdSchema,
  AnalysisToolSchema,
  MusicAnalysisV1Schema,
  ProjectAnalysisReferenceSchema,
  VideoProjectV1Schema,
  type MusicAnalysisV1,
  type ProjectAssetV1,
  type VideoProjectV1,
} from "../contracts";
import {
  analyzeMusic,
  canonicalJson,
  canonicalJsonSha256,
  saveAnalysisArtifact,
  saveVideoProject,
  sha256Hex,
  type MonoPcm,
} from "../core";
import { decodeAlignmentPcm, resolveAudioAnalysisSubject } from "./audio-analysis";
import { CliError } from "./errors";
import type { ProcessRunner } from "./io";
import { ensurePhysicalPrivateDirectoryWithin } from "./paths";
import { projectAnalysisPath, type OpenProject } from "./project-service";

export const MUSIC_ANALYSIS_SAMPLE_RATE_HZ = 8_000;
export const DEFAULT_MAX_DECODED_MUSIC_PCM_BYTES = 128 * 1024 * 1024;

const READ_BUFFER_BYTES = 256 * 1024;
const MAXIMUM_FEATURE_WINDOW_SAMPLES = 131_072;

export const DEFAULT_MUSIC_ANALYSIS_CONFIG = {
  hopSize: 512,
  minimumMusicUs: 1_000_000,
  sampleRateHz: MUSIC_ANALYSIS_SAMPLE_RATE_HZ,
  tempoWindowUs: 20_000_000,
  windowSize: 2_048,
} as const satisfies MusicAnalysisV1["config"];

export type MusicProjectAnalysisReference = Extract<
  VideoProjectV1["analyses"][number],
  { readonly kind: "music" }
>;

type AudioStream = Extract<ProjectAssetV1["streams"][number], { readonly kind: "audio" }>;

export function assertCompleteMusicAnalysis(
  analysisInput: MusicAnalysisV1,
  stream: AudioStream,
): MusicAnalysisV1 {
  const analysis = MusicAnalysisV1Schema.parse(analysisInput);
  const expectedEndUs = stream.segments.at(-1)?.assetRange.endUs ?? 0;
  const toleranceSamples = Math.max(2, stream.segments.length * 2);
  const toleranceUs = Math.ceil(toleranceSamples * 1_000_000 / analysis.config.sampleRateHz);
  if (
    expectedEndUs <= 0
    || Math.abs(analysis.durationUs - expectedEndUs) > toleranceUs
  ) {
    throw new CliError(
      "invalid-data",
      `Music analysis ${analysis.analysisId} does not cover the complete audio-stream timeline.`,
      { actualDurationUs: analysis.durationUs, expectedEndUs, toleranceUs },
    );
  }
  return analysis;
}

export interface ReadMusicPcmOptions {
  readonly maxBytes?: number;
  readonly sampleRateHz?: number;
}

function validateReadBound(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) {
    throw new CliError("usage", "The decoded music PCM byte limit must be a safe integer of at least four.");
  }
}

function validateMusicConfig(config: MusicAnalysisV1["config"]): MusicAnalysisV1["config"] {
  for (const [label, value] of [
    ["hopSize", config.hopSize],
    ["windowSize", config.windowSize],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAXIMUM_FEATURE_WINDOW_SAMPLES) {
      throw new CliError(
        "usage",
        `Music ${label} must be a positive safe integer no greater than ${MAXIMUM_FEATURE_WINDOW_SAMPLES}.`,
      );
    }
  }
  if (config.hopSize > config.windowSize) {
    throw new CliError("usage", "Music analysis hopSize cannot exceed windowSize.");
  }
  if (!Number.isSafeInteger(config.minimumMusicUs) || config.minimumMusicUs < 0) {
    throw new CliError("usage", "Music minimumMusicUs must be a nonnegative safe integer.");
  }
  if (!Number.isSafeInteger(config.tempoWindowUs) || config.tempoWindowUs <= 0) {
    throw new CliError("usage", "Music tempoWindowUs must be a positive safe integer.");
  }
  if (config.sampleRateHz !== MUSIC_ANALYSIS_SAMPLE_RATE_HZ) {
    throw new CliError(
      "usage",
      `Music analysis must use the decoder sample rate of ${MUSIC_ANALYSIS_SAMPLE_RATE_HZ} Hz.`,
    );
  }
  return config;
}

/** Read little-endian float PCM incrementally, rejecting data beyond a hard byte cap. */
export async function readMonoFloat32PcmBounded(
  path: string,
  options: ReadMusicPcmOptions = {},
): Promise<MonoPcm> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_DECODED_MUSIC_PCM_BYTES;
  const sampleRateHz = options.sampleRateHz ?? MUSIC_ANALYSIS_SAMPLE_RATE_HZ;
  validateReadBound(maxBytes);
  if (!Number.isSafeInteger(sampleRateHz) || sampleRateHz < 8_000 || sampleRateHz > 192_000) {
    throw new CliError("usage", "The decoded music PCM sample rate must be between 8,000 and 192,000 Hz.");
  }

  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const samples: number[] = [];
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  let carry = Buffer.alloc(0);
  let totalBytes = 0;
  try {
    const details = await handle.stat();
    if (!details.isFile()) throw new CliError("invalid-data", "Decoded music PCM is not a regular file.");
    if (details.size > maxBytes) {
      throw new CliError(
        "invalid-data",
        `Decoded music PCM exceeds its ${maxBytes}-byte resource bound.`,
        { bytes: details.size, maxBytes },
      );
    }

    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (result.bytesRead === 0) break;
      totalBytes += result.bytesRead;
      if (totalBytes > maxBytes) {
        throw new CliError(
          "invalid-data",
          `Decoded music PCM exceeds its ${maxBytes}-byte resource bound.`,
          { bytes: totalBytes, maxBytes },
        );
      }
      const bytes = carry.length === 0
        ? buffer.subarray(0, result.bytesRead)
        : Buffer.concat([carry, buffer.subarray(0, result.bytesRead)]);
      const usableBytes = bytes.length - bytes.length % Float32Array.BYTES_PER_ELEMENT;
      for (let offset = 0; offset < usableBytes; offset += Float32Array.BYTES_PER_ELEMENT) {
        const sample = bytes.readFloatLE(offset);
        if (!Number.isFinite(sample)) {
          throw new CliError("invalid-data", "Decoded music PCM contains a non-finite sample.");
        }
        samples.push(sample);
      }
      carry = Buffer.from(bytes.subarray(usableBytes));
    }
    if (carry.length !== 0) {
      throw new CliError("invalid-data", "Decoded music PCM ends with a partial float sample.");
    }
    if (samples.length === 0) throw new CliError("invalid-data", "Decoded music PCM is empty.");
    return { sampleRateHz, samples };
  } finally {
    await handle.close();
  }
}

export interface WithDecodedMusicPcmOptions {
  readonly ffmpeg: string;
  readonly maxDecodedPcmBytes?: number;
  readonly projectDirectory: string;
  readonly repositoryRoot: string;
  readonly runner: ProcessRunner;
  readonly stream: Parameters<typeof decodeAlignmentPcm>[4];
}

/** Decode one project audio stream and remove its temporary PCM on every callback exit path. */
export async function withDecodedMusicPcm<T>(
  options: WithDecodedMusicPcmOptions,
  callback: (pcm: MonoPcm) => Promise<T> | T,
): Promise<T> {
  const decodedPath = await decodeAlignmentPcm(
    options.projectDirectory,
    options.repositoryRoot,
    options.ffmpeg,
    options.runner,
    options.stream,
    options.maxDecodedPcmBytes ?? DEFAULT_MAX_DECODED_MUSIC_PCM_BYTES,
  );
  try {
    const pcm = await readMonoFloat32PcmBounded(decodedPath, {
      ...(options.maxDecodedPcmBytes === undefined ? {} : { maxBytes: options.maxDecodedPcmBytes }),
      sampleRateHz: MUSIC_ANALYSIS_SAMPLE_RATE_HZ,
    });
    return await callback(pcm);
  } finally {
    await rm(decodedPath, { force: true });
  }
}

export interface BuildMusicProjectUpdateOptions {
  readonly analysis: MusicAnalysisV1;
  readonly analysisPath: string;
  readonly project: VideoProjectV1;
  readonly updatedAt: string;
}

export function buildMusicAnalysisReference(
  analysisInput: MusicAnalysisV1,
  analysisPath: string,
): MusicProjectAnalysisReference {
  const analysis = MusicAnalysisV1Schema.parse(analysisInput);
  const reference = ProjectAnalysisReferenceSchema.parse({
    analysisId: analysis.analysisId,
    assetId: analysis.subject.assetId,
    createdAt: analysis.createdAt,
    keyRegions: analysis.keyRegions.length,
    kind: "music",
    musicRegions: analysis.musicRegions.length,
    path: analysisPath,
    sha256: sha256Hex(`${canonicalJson(analysis)}\n`),
    streamId: analysis.subject.streamId,
    tempoRegions: analysis.tempoRegions.length,
  });
  if (reference.kind !== "music") {
    throw new CliError("internal", "Music reference parsing changed its kind.");
  }
  return reference;
}

/** Build and validate the compact project reference for an immutable music sidecar. */
export function buildMusicProjectUpdate(options: BuildMusicProjectUpdateOptions): {
  readonly project: VideoProjectV1;
  readonly reference: MusicProjectAnalysisReference;
} {
  const analysis = MusicAnalysisV1Schema.parse(options.analysis);
  if (options.project.analyses.some(existing => existing.analysisId === analysis.analysisId)) {
    throw new CliError("conflict", `Project analysis already exists: ${analysis.analysisId}`);
  }
  if (Date.parse(options.updatedAt) < Date.parse(options.project.updatedAt)) {
    throw new CliError("conflict", "The music analysis update time cannot precede the project update time.");
  }
  const reference = buildMusicAnalysisReference(analysis, options.analysisPath);
  const project = VideoProjectV1Schema.parse({
    ...options.project,
    analyses: [...options.project.analyses, reference],
    updatedAt: options.updatedAt,
  });
  return { project, reference };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function requireUnusedAnalysisPath(project: OpenProject, path: string): Promise<void> {
  try {
    await project.fileSystem.readText(path);
  } catch (error) {
    if (isMissingFile(error)) return;
    throw error;
  }
  throw new CliError("conflict", `Analysis artifact already exists and will not be overwritten: ${path}`);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function saveMusicAnalysisArtifactOnce(
  project: OpenProject,
  analysis: MusicAnalysisV1,
  path: string,
): Promise<void> {
  const parentRelative = dirname(path);
  const parent = await ensurePhysicalPrivateDirectoryWithin(project.directory.path, parentRelative);
  const stagePath = `${path}.stage-${randomUUID()}`;
  const absoluteStage = join(project.directory.path, stagePath);
  const absoluteTarget = join(project.directory.path, path);
  await saveAnalysisArtifact(project.fileSystem, analysis, stagePath);
  try {
    try {
      await link(absoluteStage, absoluteTarget);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new CliError(
          "conflict",
          `Analysis artifact already exists and will not be overwritten: ${path}`,
        );
      }
      throw error;
    }
  } finally {
    await rm(absoluteStage, { force: true });
  }
  await syncDirectory(parent);
}

export interface AnalyzeProjectMusicOptions {
  readonly analysisId?: string;
  readonly config?: MusicAnalysisV1["config"];
  readonly ffmpeg: string;
  readonly maxDecodedPcmBytes?: number;
  readonly now: Date;
  readonly project: OpenProject;
  readonly repositoryRoot: string;
  readonly runner: ProcessRunner;
  readonly source: string;
  readonly toolVersion: string;
}

export type AnalyzeAndPersistProjectMusicOptions = AnalyzeProjectMusicOptions;

export interface AnalyzedProjectMusic {
  readonly analysis: MusicAnalysisV1;
}

export interface PersistedProjectMusicAnalysis {
  readonly analysis: MusicAnalysisV1;
  readonly analysisPath: string;
  readonly project: VideoProjectV1;
  readonly reference: MusicProjectAnalysisReference;
}

/** Resolve, decode, and analyze a complete immutable music subject without publishing project state. */
export async function analyzeProjectMusic(
  options: AnalyzeProjectMusicOptions,
): Promise<AnalyzedProjectMusic> {
  const selected = resolveAudioAnalysisSubject(options.project.project, options.source);
  const analysisId = AnalysisIdSchema.parse(
    options.analysisId ?? `analysis_${randomUUID().replaceAll("-", "")}`,
  );
  if (options.project.project.analyses.some(existing => existing.analysisId === analysisId)) {
    throw new CliError("conflict", `Project analysis already exists: ${analysisId}`);
  }
  const analysisPath = projectAnalysisPath("music", analysisId);
  await requireUnusedAnalysisPath(options.project, analysisPath);

  const config = validateMusicConfig(options.config ?? DEFAULT_MUSIC_ANALYSIS_CONFIG);
  const tool = AnalysisToolSchema.parse({
    name: "transmute-music-analyzer",
    profile: "mono-pcm-spectral-v1",
    version: options.toolVersion,
  });
  const createdAt = options.now.toISOString();
  const inputDigest = canonicalJsonSha256({
    config,
    decoding: { channels: 1, format: "f32le", sampleRateHz: MUSIC_ANALYSIS_SAMPLE_RATE_HZ },
    subject: selected.subject,
  });
  const analysis = await withDecodedMusicPcm({
    ffmpeg: options.ffmpeg,
    ...(options.maxDecodedPcmBytes === undefined
      ? {}
      : { maxDecodedPcmBytes: options.maxDecodedPcmBytes }),
    projectDirectory: options.project.directory.path,
    repositoryRoot: options.repositoryRoot,
    runner: options.runner,
    stream: selected.stream,
  }, pcm => analyzeMusic({
    analysisId,
    config,
    createdAt,
    inputDigest,
    pcm,
    subject: selected.subject,
    tool,
  }));
  assertCompleteMusicAnalysis(analysis, selected.stream);
  return { analysis };
}

export interface PublishedProjectMusicAnalysisArtifact {
  readonly analysisPath: string;
  readonly reference: MusicProjectAnalysisReference;
}

export async function publishProjectMusicAnalysisArtifact(options: {
  readonly analysis: MusicAnalysisV1;
  readonly project: OpenProject;
}): Promise<PublishedProjectMusicAnalysisArtifact> {
  const analysis = MusicAnalysisV1Schema.parse(options.analysis);
  const analysisPath = projectAnalysisPath("music", analysis.analysisId);
  await requireUnusedAnalysisPath(options.project, analysisPath);
  const reference = buildMusicAnalysisReference(analysis, analysisPath);
  await saveMusicAnalysisArtifactOnce(options.project, analysis, analysisPath);
  const persistedText = await options.project.fileSystem.readText(analysisPath);
  if (sha256Hex(persistedText) !== reference.sha256) {
    throw new CliError(
      "conflict",
      "Persisted music-analysis sidecar failed its content-addressed verification.",
    );
  }
  return { analysisPath, reference };
}

/** Resolve, decode, analyze, and persist a music sidecar plus its validated project reference. */
export async function analyzeAndPersistProjectMusic(
  options: AnalyzeAndPersistProjectMusicOptions,
): Promise<PersistedProjectMusicAnalysis> {
  const analyzed = await analyzeProjectMusic(options);
  const published = await publishProjectMusicAnalysisArtifact({
    analysis: analyzed.analysis,
    project: options.project,
  });
  const update = buildMusicProjectUpdate({
    analysis: analyzed.analysis,
    analysisPath: published.analysisPath,
    project: options.project.project,
    updatedAt: analyzed.analysis.createdAt,
  });
  await saveVideoProject(options.project.fileSystem, update.project);
  return {
    analysis: analyzed.analysis,
    analysisPath: published.analysisPath,
    ...update,
  };
}
