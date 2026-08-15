import { randomUUID } from "node:crypto";
import { link, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  AnalysisIdSchema,
  AnalysisToolSchema,
  FaceAnalysisConfigSchema,
  FaceAnalysisV1Schema,
  ProjectAnalysisReferenceSchema,
  VideoProjectV1Schema,
  type FaceAnalysisConfig,
  type FaceAnalysisV1,
  type FaceTrackId,
  type NormalizedTopLeftRect,
  type ProjectAssetV1,
  type RawFaceDetectionFrame,
  type VideoProjectV1,
} from "../contracts";
import {
  associateFaceDetections,
  canonicalAtetPersistenceDocument,
  canonicalJson,
  canonicalJsonSha256,
  saveAnalysisArtifact,
  saveVideoProject,
  sha256Hex,
} from "../core";
import {
  MAXIMUM_FACE_ANALYZER_FRAMES,
  MAXIMUM_FACE_ANALYZER_OUTPUT_BYTES,
  parseFaceAnalyzerJsonLines,
  type FaceAnalyzerBackend,
  type FaceAnalyzerEvent,
  type FaceAnalyzerFrameEvent,
} from "../analysis/protocol";
import { CliError } from "./errors";
import type { ProcessRunner } from "./io";
import { ensurePhysicalPrivateDirectoryWithin } from "./paths";
import { resolveVerifiedProjectMedia } from "./project-media-integrity";
import { projectAnalysisPath, type OpenProject } from "./project-service";
import {
  resolveVideoAnalysisSubject,
  type ResolvedVideoAnalysisSubject,
} from "./scene-analysis-service";

type VideoStream = Extract<ProjectAssetV1["streams"][number], { readonly kind: "video" }>;
type VideoSegment = VideoStream["segments"][number];
export type FaceAnalysisReference = Extract<
  VideoProjectV1["analyses"][number],
  { readonly kind: "faces" }
>;
type StartedEvent = Extract<FaceAnalyzerEvent, { readonly event: "started" }>;
type FrameEvent = FaceAnalyzerFrameEvent;
type CompletedEvent = Extract<FaceAnalyzerEvent, { readonly event: "completed" }>;

const MAXIMUM_FFPROBE_OUTPUT_BYTES = 1_048_576;
const MAXIMUM_ANALYSIS_FRAMES = 250_000;
const MAXIMUM_TRACK_LIST_LIMIT = 1_000;

export const DEFAULT_FACE_ANALYSIS_CONFIG = FaceAnalysisConfigSchema.parse({
  sampleIntervalUs: 125_000,
  tracking: {
    iouWeight: 0.7,
    maximumCenterDistance: 0.3,
    maximumFacesPerFrame: 32,
    maximumGapUs: 500_000,
    minimumConfidence: 0.6,
    minimumIou: 0.05,
  },
}) satisfies FaceAnalysisConfig;

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

function parseFfprobeVideoStreams(output: string): readonly number[] {
  let input: unknown;
  try {
    input = JSON.parse(output) as unknown;
  } catch {
    throw new CliError("invalid-data", "FFprobe returned invalid JSON while resolving a face-analysis video track.");
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new CliError("invalid-data", "FFprobe face-analysis output must be an object.");
  }
  const streams = (input as Readonly<Record<string, unknown>>).streams;
  if (!Array.isArray(streams)) {
    throw new CliError("invalid-data", "FFprobe face-analysis output omits its stream list.");
  }
  const indexes = new Set<number>();
  const videos: number[] = [];
  for (const value of streams) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new CliError("invalid-data", "FFprobe face-analysis stream entry must be an object.");
    }
    const stream = value as Readonly<Record<string, unknown>>;
    if (!Number.isSafeInteger(stream.index) || (stream.index as number) < 0) {
      throw new CliError("invalid-data", "FFprobe face-analysis stream index is invalid.");
    }
    const index = stream.index as number;
    if (indexes.has(index)) {
      throw new CliError("invalid-data", `FFprobe repeated stream index ${index}.`);
    }
    indexes.add(index);
    if (stream.codec_type === "video") videos.push(index);
    else if (!["attachment", "audio", "data", "subtitle"].includes(String(stream.codec_type))) {
      throw new CliError("invalid-data", `FFprobe stream ${index} has an invalid codec type.`);
    }
  }
  return videos.sort((left, right) => left - right);
}

/**
 * Apple AVFoundation selects a video track by its ordinal among video tracks,
 * while project segments retain FFmpeg's absolute stream index.
 */
export async function probeFaceAnalyzerVideoTrackOrdinal(options: {
  readonly absolutePath: string;
  readonly ffprobe: string;
  readonly runner: ProcessRunner;
  readonly streamIndex: number;
}): Promise<{ readonly ordinal: number; readonly totalVideoTracks: number }> {
  const result = await options.runner.run([
    options.ffprobe,
    "-v", "error",
    "-show_entries", "stream=index,codec_type",
    "-of", "json",
    options.absolutePath,
  ], { maxOutputBytes: MAXIMUM_FFPROBE_OUTPUT_BYTES });
  if (result.exitCode !== 0) {
    throw new CliError(
      "subprocess",
      `FFprobe could not resolve the face-analysis video track: ${
        result.stderr.trim().slice(-4_000) || `exit ${result.exitCode}`
      }`,
    );
  }
  const videoStreams = parseFfprobeVideoStreams(result.stdout);
  const ordinal = videoStreams.indexOf(options.streamIndex);
  if (ordinal < 0) {
    throw new CliError(
      "invalid-data",
      `Project stream index ${options.streamIndex} is not a video stream in ${options.absolutePath}.`,
    );
  }
  return { ordinal, totalVideoTracks: videoStreams.length };
}

function coordinateSpace(started: StartedEvent): FaceAnalysisV1["coordinateSpace"] {
  return {
    encodedPixelHeight: started.orientation.encodedPixelHeight,
    encodedPixelWidth: started.orientation.encodedPixelWidth,
    mirroredHorizontally: started.orientation.mirroredHorizontally,
    origin: "top-left",
    pixelHeight: started.orientation.pixelHeight,
    pixelWidth: started.orientation.pixelWidth,
    rotationDegrees: started.orientation.rotationDegrees,
    sampleAspectRatio: started.orientation.sampleAspectRatio,
    units: "normalized",
    xAxis: "right",
    yAxis: "down",
  };
}

function helperFailure(events: readonly FaceAnalyzerEvent[]): Extract<
  FaceAnalyzerEvent,
  { readonly event: "error" }
> | undefined {
  return events.find((event): event is Extract<FaceAnalyzerEvent, { readonly event: "error" }> =>
    event.event === "error");
}

interface ParsedFaceAnalyzerRun {
  readonly completed: CompletedEvent;
  readonly frames: readonly FrameEvent[];
  readonly started: StartedEvent;
}

/**
 * Accept only a complete helper transcript. In particular, a started/frame/error
 * transcript never escapes as reusable partial evidence.
 */
export function parseCompletedFaceAnalyzerRun(
  output: string,
  expected: {
    readonly endUs: number;
    readonly maximumFacesPerFrame: number;
    readonly maximumFrames: number;
    readonly minimumConfidence: number;
    readonly sampleIntervalUs: number;
    readonly startUs: number;
    readonly totalVideoTracks: number;
    readonly videoTrackOrdinal: number;
  },
): ParsedFaceAnalyzerRun {
  let events: readonly FaceAnalyzerEvent[];
  try {
    events = parseFaceAnalyzerJsonLines(output);
  } catch (error) {
    throw new CliError(
      "invalid-data",
      `Face analyzer returned an invalid bounded JSONL transcript: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const failure = helperFailure(events);
  if (failure !== undefined) {
    throw new CliError(
      "subprocess",
      `Face analyzer failed (${failure.code}): ${failure.message}`,
      { analyzerCode: failure.code },
    );
  }
  const first = events[0];
  const last = events.at(-1);
  if (first?.event !== "started" || last?.event !== "completed") {
    throw new CliError(
      "invalid-data",
      "Face analyzer transcript must contain exactly started, frame*, completed.",
    );
  }
  const middle = events.slice(1, -1);
  if (middle.some(event => event.event !== "frame")) {
    throw new CliError(
      "invalid-data",
      "Face analyzer transcript contains an event outside started, frame*, completed.",
    );
  }
  const frames = middle as readonly FrameEvent[];
  const started = first;
  const completed = last;
  if (
    started.limits.endUs !== expected.endUs
    || started.limits.maximumFacesPerFrame !== expected.maximumFacesPerFrame
    || started.limits.maximumFrames !== expected.maximumFrames
    || started.limits.maximumOutputBytes !== MAXIMUM_FACE_ANALYZER_OUTPUT_BYTES
    || started.limits.minimumConfidence !== expected.minimumConfidence
    || started.limits.sampleIntervalUs !== expected.sampleIntervalUs
    || started.limits.startUs !== expected.startUs
    || started.track.totalVideoTracks !== expected.totalVideoTracks
    || started.track.videoTrackOrdinal !== expected.videoTrackOrdinal
  ) {
    throw new CliError("invalid-data", "Face analyzer did not honor its requested bounded invocation.");
  }
  let previousPtsUs = -1;
  let faceDetections = 0;
  for (const [index, frame] of frames.entries()) {
    if (
      frame.sampleIndex !== index
      || frame.ptsUs <= previousPtsUs
      || frame.ptsUs < expected.startUs
      || frame.ptsUs >= expected.endUs
    ) {
      throw new CliError("invalid-data", "Face analyzer returned unordered or out-of-range frame evidence.");
    }
    if (frame.faces.some((face, faceIndex) => face.detectionIndex !== faceIndex)) {
      throw new CliError("invalid-data", "Face analyzer detection indexes must be contiguous within a frame.");
    }
    previousPtsUs = frame.ptsUs;
    faceDetections += frame.faces.length;
  }
  if (
    completed.framesAnalyzed !== frames.length
    || completed.framesRead < completed.framesAnalyzed
    || completed.faceDetections !== faceDetections
    || completed.firstPtsUs !== (frames[0]?.ptsUs ?? null)
    || completed.lastPtsUs !== (frames.at(-1)?.ptsUs ?? null)
  ) {
    throw new CliError("invalid-data", "Face analyzer completion counts do not match its frame evidence.");
  }
  return { completed, frames, started };
}

function requestedMaximumFrames(segment: VideoSegment, sampleIntervalUs: number): number {
  const durationUs = segment.fileRange.endUs - segment.fileRange.startUs;
  const maximumFrames = Math.ceil(durationUs / sampleIntervalUs) + 1;
  if (maximumFrames > MAXIMUM_FACE_ANALYZER_FRAMES) {
    throw new CliError(
      "usage",
      `Face analysis segment ${segment.path} requires more than ${
        MAXIMUM_FACE_ANALYZER_FRAMES
      } bounded samples; lower --sample-fps or use shorter media segments.`,
    );
  }
  return maximumFrames;
}

async function analyzeSegment(options: {
  readonly config: FaceAnalysisConfig;
  readonly faceAnalyzer: string;
  readonly ffprobe: string;
  readonly repositoryRoot: string;
  readonly runner: ProcessRunner;
  readonly segment: VideoSegment;
}): Promise<{
  readonly backend: FaceAnalyzerBackend;
  readonly coordinateSpace: FaceAnalysisV1["coordinateSpace"];
  readonly frames: readonly RawFaceDetectionFrame[];
}> {
  const label = `Face-analysis segment ${options.segment.path}:${options.segment.streamIndex}`;
  const firstVerifiedPath = await resolveVerifiedProjectMedia({
    expected: { bytes: options.segment.bytes, sha256: options.segment.sha256 },
    label,
    path: options.segment.path,
    repositoryRoot: options.repositoryRoot,
  });
  const track = await probeFaceAnalyzerVideoTrackOrdinal({
    absolutePath: firstVerifiedPath,
    ffprobe: options.ffprobe,
    runner: options.runner,
    streamIndex: options.segment.streamIndex,
  });
  // FFprobe is a separate reader. Re-hash the physical file directly before
  // entrusting it to the signed helper, instead of reusing prior verification.
  const source = await resolveVerifiedProjectMedia({
    expected: { bytes: options.segment.bytes, sha256: options.segment.sha256 },
    label,
    path: options.segment.path,
    repositoryRoot: options.repositoryRoot,
  });
  if (source !== firstVerifiedPath) {
    throw new CliError("conflict", "Face-analysis media path changed between track probing and helper execution.");
  }
  const maximumFrames = requestedMaximumFrames(options.segment, options.config.sampleIntervalUs);
  const result = await options.runner.run([
    options.faceAnalyzer,
    "--input", source,
    "--video-track-ordinal", String(track.ordinal),
    "--start-us", String(options.segment.fileRange.startUs),
    "--end-us", String(options.segment.fileRange.endUs),
    "--sample-interval-us", String(options.config.sampleIntervalUs),
    "--max-faces-per-frame", String(options.config.tracking.maximumFacesPerFrame),
    "--max-frames", String(maximumFrames),
    "--max-output-bytes", String(MAXIMUM_FACE_ANALYZER_OUTPUT_BYTES),
    "--minimum-confidence", String(options.config.tracking.minimumConfidence),
  ], { maxOutputBytes: MAXIMUM_FACE_ANALYZER_OUTPUT_BYTES, stdin: "ignore" });
  let parsed: ParsedFaceAnalyzerRun;
  try {
    parsed = parseCompletedFaceAnalyzerRun(result.stdout, {
      endUs: options.segment.fileRange.endUs,
      maximumFacesPerFrame: options.config.tracking.maximumFacesPerFrame,
      maximumFrames,
      minimumConfidence: options.config.tracking.minimumConfidence,
      sampleIntervalUs: options.config.sampleIntervalUs,
      startUs: options.segment.fileRange.startUs,
      totalVideoTracks: track.totalVideoTracks,
      videoTrackOrdinal: track.ordinal,
    });
  } catch (error) {
    if (error instanceof CliError && error.code === "subprocess") throw error;
    if (result.exitCode !== 0) {
      throw new CliError(
        "subprocess",
        `Face analyzer exited ${result.exitCode}: ${
          result.stderr.trim().slice(-4_000) || (error instanceof Error ? error.message : String(error))
        }`,
      );
    }
    throw error;
  }
  if (result.exitCode !== 0) {
    throw new CliError(
      "subprocess",
      `Face analyzer exited ${result.exitCode} after emitting an otherwise complete transcript.`,
    );
  }
  return {
    backend: parsed.started.backend,
    coordinateSpace: coordinateSpace(parsed.started),
    frames: parsed.frames.map(frame => {
      const assetTimeUs = options.segment.assetRange.startUs
        + frame.ptsUs
        - options.segment.fileRange.startUs;
      if (
        !Number.isSafeInteger(assetTimeUs)
        || assetTimeUs < options.segment.assetRange.startUs
        || assetTimeUs >= options.segment.assetRange.endUs
      ) {
        throw new CliError("invalid-data", "Face analyzer frame PTS does not map inside its project asset segment.");
      }
      return {
        assetTimeUs,
        detections: frame.faces.map(face => ({
          confidence: face.confidence,
          rect: face.bounds,
        })),
      };
    }),
  };
}

function combineFrames(runs: readonly (readonly RawFaceDetectionFrame[])[]): readonly RawFaceDetectionFrame[] {
  const ordered = runs.flat().sort((left, right) => left.assetTimeUs - right.assetTimeUs);
  const deduplicated: RawFaceDetectionFrame[] = [];
  for (const frame of ordered) {
    const prior = deduplicated.at(-1);
    if (prior?.assetTimeUs !== frame.assetTimeUs) {
      deduplicated.push(frame);
      continue;
    }
    if (canonicalJson(prior) !== canonicalJson(frame)) {
      throw new CliError(
        "invalid-data",
        `Face analyzer returned conflicting evidence at asset time ${frame.assetTimeUs}.`,
      );
    }
  }
  if (deduplicated.length === 0) {
    throw new CliError("invalid-data", "Face analyzer did not emit any sampled video frames.");
  }
  if (deduplicated.length > MAXIMUM_ANALYSIS_FRAMES) {
    throw new CliError(
      "invalid-data",
      `Face analysis exceeds the ${MAXIMUM_ANALYSIS_FRAMES}-frame immutable evidence limit.`,
    );
  }
  return deduplicated;
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export interface AnalyzeProjectFacesOptions {
  readonly analysisId?: string;
  readonly config?: FaceAnalysisConfig;
  readonly faceAnalyzer: string;
  readonly ffprobe: string;
  readonly now: Date;
  readonly project: OpenProject;
  readonly repositoryRoot: string;
  readonly runner: ProcessRunner;
  readonly source: string;
}

export interface AnalyzedProjectFaces {
  readonly analysis: FaceAnalysisV1;
  readonly selected: ResolvedVideoAnalysisSubject;
}

/** Analyze every immutable segment locally without persisting partial results. */
export async function analyzeProjectFaces(
  options: AnalyzeProjectFacesOptions,
): Promise<AnalyzedProjectFaces> {
  const selected = resolveVideoAnalysisSubject(options.project.project, options.source);
  const analysisId = AnalysisIdSchema.parse(
    options.analysisId ?? `analysis_${randomUUID().replaceAll("-", "")}`,
  );
  if (options.project.project.analyses.some(existing => existing.analysisId === analysisId)) {
    throw new CliError("conflict", `Project analysis already exists: ${analysisId}`);
  }
  const config = FaceAnalysisConfigSchema.parse(options.config ?? DEFAULT_FACE_ANALYSIS_CONFIG);
  const estimatedFrames = selected.stream.segments.reduce(
    (total, segment) => total + requestedMaximumFrames(segment, config.sampleIntervalUs),
    0,
  );
  if (estimatedFrames > MAXIMUM_ANALYSIS_FRAMES) {
    throw new CliError(
      "usage",
      `Requested face sampling may exceed ${MAXIMUM_ANALYSIS_FRAMES} frames; lower --sample-fps.`,
    );
  }
  const runs = [];
  for (const segment of selected.stream.segments) {
    runs.push(await analyzeSegment({
      config,
      faceAnalyzer: options.faceAnalyzer,
      ffprobe: options.ffprobe,
      repositoryRoot: options.repositoryRoot,
      runner: options.runner,
      segment,
    }));
  }
  const firstRun = runs[0];
  if (firstRun === undefined) throw new CliError("invalid-data", "Video stream has no face-analysis segments.");
  for (const run of runs.slice(1)) {
    if (
      !sameCanonicalValue(run.backend, firstRun.backend)
      || !sameCanonicalValue(run.coordinateSpace, firstRun.coordinateSpace)
    ) {
      throw new CliError(
        "invalid-data",
        "Face-analysis segments disagree on their local backend or upright coordinate space.",
      );
    }
  }
  const frames = combineFrames(runs.map(run => run.frames));
  const association = associateFaceDetections(frames, config.tracking);
  const coverageRange = {
    endUs: selected.stream.segments.at(-1)!.assetRange.endUs,
    startUs: selected.stream.segments[0]!.assetRange.startUs,
  };
  const createdAt = options.now.toISOString();
  const mappedBackend = {
    architecture: firstRun.backend.architecture,
    kind: "apple-vision" as const,
    osBuild: firstRun.backend.osBuild,
    requestRevision: firstRun.backend.revision,
    runtimeVersion: firstRun.backend.runtimeVersion,
  };
  const analysis = FaceAnalysisV1Schema.parse({
    analysisId,
    backend: mappedBackend,
    config,
    coordinateSpace: firstRun.coordinateSpace,
    coverage: {
      analyzedFrames: association.results.length,
      failedFrames: 0,
      range: coverageRange,
      requestedFrames: association.results.length,
    },
    createdAt,
    durationUs: selected.asset.durationUs,
    inputDigest: canonicalJsonSha256({
      analyzer: {
        helperVersion: firstRun.backend.helperVersion,
        protocolKind: "atet.face-analysis",
        schemaVersion: 1,
      },
      backend: mappedBackend,
      config,
      subject: selected.subject,
    }),
    kind: "atet.face-analysis",
    privacy: {
      biometricIdentification: "not-performed",
      execution: "local-only",
      storedEvidence: "bounding-boxes-only",
      tracking: "geometry-continuity-only",
    },
    results: association.results,
    schemaVersion: 1,
    subject: selected.subject,
    tool: AnalysisToolSchema.parse({
      name: "atet-face-analyzer",
      profile: "apple-vision-face-rectangles-v1",
      version: firstRun.backend.helperVersion,
    }),
    tracks: association.tracks,
  });
  return { analysis, selected };
}

export interface BuildFaceProjectUpdateOptions {
  readonly analysis: FaceAnalysisV1;
  readonly analysisPath: string;
  readonly project: VideoProjectV1;
  readonly updatedAt: string;
}

export function buildFaceAnalysisReference(
  analysisInput: FaceAnalysisV1,
  analysisPath: string,
): FaceAnalysisReference {
  const analysis = FaceAnalysisV1Schema.parse(analysisInput);
  const reference = ProjectAnalysisReferenceSchema.parse({
    analysisId: analysis.analysisId,
    analyzedFrames: analysis.coverage.analyzedFrames,
    assetId: analysis.subject.assetId,
    createdAt: analysis.createdAt,
    kind: "faces",
    localOnly: true,
    path: analysisPath,
    sha256: sha256Hex(`${canonicalJson(analysis)}\n`),
    streamId: analysis.subject.streamId,
    subjectIntegritySha256: analysis.subject.integritySha256,
    trackCount: analysis.tracks.length,
  });
  if (reference.kind !== "faces") {
    throw new CliError("internal", "Face reference parsing changed its kind.");
  }
  return reference;
}

/** Build the compact project pointer for an immutable, content-addressed face sidecar. */
export function buildFaceProjectUpdate(options: BuildFaceProjectUpdateOptions): {
  readonly project: VideoProjectV1;
  readonly reference: FaceAnalysisReference;
} {
  const analysis = FaceAnalysisV1Schema.parse(options.analysis);
  if (options.project.analyses.some(existing => existing.analysisId === analysis.analysisId)) {
    throw new CliError("conflict", `Project analysis already exists: ${analysis.analysisId}`);
  }
  if (Date.parse(options.updatedAt) < Date.parse(options.project.updatedAt)) {
    throw new CliError("conflict", "The face analysis update time cannot precede the project update time.");
  }
  const reference = buildFaceAnalysisReference(analysis, options.analysisPath);
  const project = VideoProjectV1Schema.parse({
    ...options.project,
    analyses: [...options.project.analyses, reference],
    updatedAt: options.updatedAt,
  });
  return { project, reference };
}

export interface PersistedProjectFaceAnalysis extends AnalyzedProjectFaces {
  readonly analysisPath: string;
  readonly project: VideoProjectV1;
  readonly reference: FaceAnalysisReference;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function saveFaceAnalysisArtifactOnce(
  project: OpenProject,
  analysis: FaceAnalysisV1,
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
      // Hard-link installation is an atomic create-if-absent operation. Unlike
      // rename, it cannot replace prior immutable evidence.
      await link(absoluteStage, absoluteTarget);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new CliError("conflict", `Analysis artifact already exists and will not be overwritten: ${path}`);
      }
      throw error;
    }
  } finally {
    await rm(absoluteStage, { force: true });
  }
  await syncDirectory(parent);
}

export interface PublishedProjectFaceAnalysisArtifact {
  readonly analysisPath: string;
  readonly reference: FaceAnalysisReference;
}

export async function publishProjectFaceAnalysisArtifact(options: {
  readonly analysis: FaceAnalysisV1;
  readonly project: OpenProject;
}): Promise<PublishedProjectFaceAnalysisArtifact> {
  const analysis = FaceAnalysisV1Schema.parse(options.analysis);
  const analysisPath = projectAnalysisPath("faces", analysis.analysisId);
  await requireUnusedAnalysisPath(options.project, analysisPath);
  const reference = buildFaceAnalysisReference(analysis, analysisPath);
  await saveFaceAnalysisArtifactOnce(options.project, analysis, analysisPath);
  const persistedText = await options.project.fileSystem.readText(analysisPath);
  if (sha256Hex(persistedText) !== reference.sha256) {
    throw new CliError(
      "conflict",
      "Persisted face-analysis sidecar failed its content-addressed verification.",
    );
  }
  return { analysisPath, reference };
}

/**
 * Persist the complete sidecar before installing its project pointer. A failed
 * project write can leave only an unreferenced immutable sidecar, never a
 * project reference to partial evidence.
 */
export async function analyzeAndPersistProjectFaces(
  options: AnalyzeProjectFacesOptions,
): Promise<PersistedProjectFaceAnalysis> {
  const analyzed = await analyzeProjectFaces(options);
  const published = await publishProjectFaceAnalysisArtifact({
    analysis: analyzed.analysis,
    project: options.project,
  });
  const update = buildFaceProjectUpdate({
    analysis: analyzed.analysis,
    analysisPath: published.analysisPath,
    project: options.project.project,
    updatedAt: analyzed.analysis.createdAt,
  });
  const project = canonicalAtetPersistenceDocument(update.project);
  await saveVideoProject(options.project.fileSystem, project);
  return {
    ...analyzed,
    analysisPath: published.analysisPath,
    ...update,
    project,
  };
}

export interface LoadedProjectFaceAnalysis {
  readonly analysis: FaceAnalysisV1;
  readonly reference: FaceAnalysisReference;
  readonly selected: ResolvedVideoAnalysisSubject;
}

/** Load a face sidecar only after its project pointer, bytes, IDs, and current media subject agree. */
export async function loadVerifiedProjectFaceAnalysis(options: {
  readonly analysisId: string;
  readonly project: OpenProject;
}): Promise<LoadedProjectFaceAnalysis> {
  const analysisId = AnalysisIdSchema.parse(options.analysisId);
  const reference = options.project.project.analyses.find(candidate => candidate.analysisId === analysisId);
  if (reference === undefined) throw new CliError("not-found", `Unknown project analysis: ${analysisId}`);
  if (reference.kind !== "faces") {
    throw new CliError("invalid-data", `Project analysis ${analysisId} is not face evidence.`);
  }
  const expectedPath = projectAnalysisPath("faces", analysisId);
  if (reference.path !== expectedPath) {
    throw new CliError("invalid-data", `Face analysis ${analysisId} does not use its canonical sidecar path.`);
  }
  let text: string;
  try {
    text = await options.project.fileSystem.readText(reference.path);
  } catch (error) {
    if (isMissingFile(error)) {
      throw new CliError("invalid-data", `Face-analysis sidecar is missing: ${reference.path}`);
    }
    throw error;
  }
  if (sha256Hex(text) !== reference.sha256) {
    throw new CliError("invalid-data", `Face-analysis sidecar ${analysisId} failed its SHA-256 check.`);
  }
  let input: unknown;
  try {
    input = JSON.parse(text) as unknown;
  } catch {
    throw new CliError("invalid-data", `Face-analysis sidecar ${analysisId} is not valid JSON.`);
  }
  const parsed = FaceAnalysisV1Schema.safeParse(input);
  if (!parsed.success) {
    throw new CliError("invalid-data", `Face-analysis sidecar ${analysisId} is invalid: ${parsed.error.message}`);
  }
  const analysis = parsed.data;
  if (`${canonicalJson(analysis)}\n` !== text) {
    throw new CliError("invalid-data", `Face-analysis sidecar ${analysisId} is not canonical immutable JSON.`);
  }
  if (
    analysis.analysisId !== reference.analysisId
    || analysis.createdAt !== reference.createdAt
    || analysis.subject.assetId !== reference.assetId
    || analysis.subject.streamId !== reference.streamId
    || analysis.subject.integritySha256 !== reference.subjectIntegritySha256
    || analysis.coverage.analyzedFrames !== reference.analyzedFrames
    || analysis.tracks.length !== reference.trackCount
  ) {
    throw new CliError("invalid-data", `Face-analysis sidecar ${analysisId} disagrees with its project reference.`);
  }
  const selected = resolveVideoAnalysisSubject(
    options.project.project,
    `${reference.assetId}:${reference.streamId}`,
  );
  if (
    analysis.subject.integritySha256 !== selected.subject.integritySha256
    || analysis.durationUs !== selected.asset.durationUs
  ) {
    throw new CliError("conflict", `Face analysis ${analysisId} is stale for the current project media subject.`);
  }
  const firstSegment = selected.stream.segments[0]!;
  const lastSegment = selected.stream.segments.at(-1)!;
  if (
    analysis.coverage.range.startUs !== firstSegment.assetRange.startUs
    || analysis.coverage.range.endUs !== lastSegment.assetRange.endUs
    || analysis.results.some(result => !selected.stream.segments.some(segment =>
      result.assetTimeUs >= segment.assetRange.startUs && result.assetTimeUs < segment.assetRange.endUs))
  ) {
    throw new CliError("invalid-data", `Face analysis ${analysisId} does not match its stream segment coverage.`);
  }
  return { analysis, reference, selected };
}

export interface FaceTrackSummary {
  readonly firstSeenAssetTimeUs: number;
  readonly lastSeenAssetTimeUs: number;
  readonly maximumArea: number;
  readonly maximumConfidence: number;
  readonly maximumObservedGapUs: number;
  readonly meanArea: number;
  readonly meanConfidence: number;
  readonly observationCount: number;
  readonly sample: {
    readonly assetTimeUs: number;
    readonly confidence: number;
    readonly distanceUs: number;
    readonly rect: NormalizedTopLeftRect;
  } | null;
  readonly trackId: FaceTrackId;
  readonly visibleDurationUs: number;
}

export interface FaceTrackSummaryList {
  readonly analysisId: string;
  readonly atUs: number | null;
  readonly returned: number;
  readonly totalMatched: number;
  readonly tracks: readonly FaceTrackSummary[];
}

interface MutableTrackStats {
  areaSum: number;
  confidenceSum: number;
  maximumArea: number;
  maximumConfidence: number;
  observations: number;
  sample: FaceTrackSummary["sample"];
}

/**
 * Produce a token-bounded track list. With `atUs`, only tracks having nearby
 * sampled evidence within the configured continuity gap are returned.
 */
export function listFaceTrackSummaries(options: {
  readonly analysis: FaceAnalysisV1;
  readonly atUs?: number;
  readonly limit: number;
  readonly minimumConfidence: number;
  readonly minimumDurationUs: number;
}): FaceTrackSummaryList {
  const analysis = FaceAnalysisV1Schema.parse(options.analysis);
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > MAXIMUM_TRACK_LIST_LIMIT) {
    throw new CliError("usage", `Face track list limit must be from 1 through ${MAXIMUM_TRACK_LIST_LIMIT}.`);
  }
  if (!Number.isFinite(options.minimumConfidence)
    || options.minimumConfidence < 0
    || options.minimumConfidence > 1) {
    throw new CliError("usage", "Face track minimum confidence must be between zero and one.");
  }
  if (!Number.isSafeInteger(options.minimumDurationUs) || options.minimumDurationUs < 0) {
    throw new CliError("usage", "Face track minimum duration must be nonnegative integer microseconds.");
  }
  if (
    options.atUs !== undefined
    && (!Number.isSafeInteger(options.atUs) || options.atUs < 0 || options.atUs > analysis.durationUs)
  ) {
    throw new CliError("usage", "Face track inspection time must lie inside the asset timeline.");
  }
  const eligibleTracks = new Map(analysis.tracks
    .filter(track => track.lastSeenAssetTimeUs - track.firstSeenAssetTimeUs >= options.minimumDurationUs)
    .map(track => [track.trackId, track]));
  const stats = new Map<FaceTrackId, MutableTrackStats>();
  for (const result of analysis.results) {
    if (result.state !== "analyzed") continue;
    for (const detection of result.detections) {
      if (!eligibleTracks.has(detection.trackId)) continue;
      const area = detection.rect.width * detection.rect.height;
      const current = stats.get(detection.trackId) ?? {
        areaSum: 0,
        confidenceSum: 0,
        maximumArea: 0,
        maximumConfidence: 0,
        observations: 0,
        sample: null,
      };
      current.areaSum += area;
      current.confidenceSum += detection.confidence;
      current.maximumArea = Math.max(current.maximumArea, area);
      current.maximumConfidence = Math.max(current.maximumConfidence, detection.confidence);
      current.observations += 1;
      if (options.atUs !== undefined) {
        const distanceUs = Math.abs(result.assetTimeUs - options.atUs);
        if (
          distanceUs <= analysis.config.tracking.maximumGapUs
          && (
            current.sample === null
            || distanceUs < current.sample.distanceUs
            || (distanceUs === current.sample.distanceUs && result.assetTimeUs < current.sample.assetTimeUs)
          )
        ) {
          current.sample = {
            assetTimeUs: result.assetTimeUs,
            confidence: detection.confidence,
            distanceUs,
            rect: detection.rect,
          };
        }
      }
      stats.set(detection.trackId, current);
    }
  }
  const summaries = [...eligibleTracks.values()].flatMap((track): readonly FaceTrackSummary[] => {
    const trackStats = stats.get(track.trackId);
    if (
      trackStats === undefined
      || trackStats.maximumConfidence < options.minimumConfidence
      || (options.atUs !== undefined
        && (trackStats.sample === null || trackStats.sample.confidence < options.minimumConfidence))
    ) {
      return [];
    }
    return [{
      firstSeenAssetTimeUs: track.firstSeenAssetTimeUs,
      lastSeenAssetTimeUs: track.lastSeenAssetTimeUs,
      maximumArea: trackStats.maximumArea,
      maximumConfidence: trackStats.maximumConfidence,
      maximumObservedGapUs: track.maximumObservedGapUs,
      meanArea: trackStats.areaSum / trackStats.observations,
      meanConfidence: trackStats.confidenceSum / trackStats.observations,
      observationCount: track.observationCount,
      sample: trackStats.sample,
      trackId: track.trackId,
      visibleDurationUs: track.lastSeenAssetTimeUs - track.firstSeenAssetTimeUs,
    }];
  }).sort((left, right) => {
    if (options.atUs !== undefined) {
      return (
        (right.sample?.rect.width ?? 0) * (right.sample?.rect.height ?? 0)
        - (left.sample?.rect.width ?? 0) * (left.sample?.rect.height ?? 0)
        || (right.sample?.confidence ?? 0) - (left.sample?.confidence ?? 0)
        || left.trackId.localeCompare(right.trackId)
      );
    }
    return (
      right.visibleDurationUs - left.visibleDurationUs
      || right.observationCount - left.observationCount
      || right.meanArea - left.meanArea
      || left.trackId.localeCompare(right.trackId)
    );
  });
  const tracks = summaries.slice(0, options.limit);
  return {
    analysisId: analysis.analysisId,
    atUs: options.atUs ?? null,
    returned: tracks.length,
    totalMatched: summaries.length,
    tracks,
  };
}
