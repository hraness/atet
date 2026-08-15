import { randomUUID } from "node:crypto";
import { link, open, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AnalysisIdSchema,
  AnalysisSubjectSchema,
  AnalysisToolSchema,
  ProjectAnalysisReferenceSchema,
  ProjectInactivityAnalysisV1Schema,
  ProjectInactivityConfigSchema,
  VideoProjectV1Schema,
  type AnalysisSubject,
  type ProjectAssetV1,
  type ProjectInactivityAnalysisV1,
  type ProjectPlacementV1,
  type RecordingEventV1,
  type RecordingManifestV1,
  type VideoProjectV1,
} from "../contracts";
import {
  DEFAULT_MINIMUM_FREEZE_CONFIDENCE,
  canonicalAtetPersistenceDocument,
  canonicalJson,
  canonicalJsonSha256,
  hashPlacementSync,
  hashProjectStructure,
  mapAssetIntervalToProjectSlices,
  planMappedInactivityCuts,
  recordingInteractionIntervals,
  saveAnalysisArtifact,
  saveVideoProject,
  sha256Hex,
  unionIntervals,
} from "../core";
import { FfmpegInactivityAnalyzer } from "./analyzer";
import { mapBounded } from "./bounded-map";
import { loadRecordingEvents, openRecording } from "./bundle-service";
import { CliError } from "./errors";
import type { ProcessRunner } from "./io";
import { ensurePhysicalPrivateDirectoryWithin } from "./paths";
import { resolveVerifiedProjectMedia } from "./project-media-integrity";
import { projectAnalysisPath, type OpenProject } from "./project-service";

type VideoStream = Extract<ProjectAssetV1["streams"][number], { readonly kind: "video" }>;
type AudioStream = Extract<ProjectAssetV1["streams"][number], { readonly kind: "audio" }>;
export type InactivityReference = Extract<
  VideoProjectV1["analyses"][number],
  { readonly kind: "inactivity" }
>;

interface SelectedStream<Stream extends VideoStream | AudioStream> {
  readonly asset: ProjectAssetV1;
  readonly placement: ProjectPlacementV1;
  readonly stream: Stream;
  readonly subject: AnalysisSubject;
}

export type ProjectInactivityConfig = ProjectInactivityAnalysisV1["config"];

export const DEFAULT_PROJECT_INACTIVITY_CONFIG = {
  cursorMovementThresholdPx: 2,
  edgeHandleUs: 250_000,
  interactionHandleUs: 750_000,
  minimumCutUs: 3_000_000,
  minimumFreezeConfidence: DEFAULT_MINIMUM_FREEZE_CONFIDENCE,
  motionThreshold: 0.003,
  requireAudioSilence: true,
} as const satisfies ProjectInactivityConfig;

function streamSubject(asset: ProjectAssetV1, stream: VideoStream | AudioStream): AnalysisSubject {
  return AnalysisSubjectSchema.parse({
    assetId: asset.assetId,
    integritySha256: canonicalJsonSha256({ assetDurationUs: asset.durationUs, stream }),
    streamId: stream.streamId,
  });
}

function selectedStreams<Stream extends VideoStream | AudioStream>(
  project: VideoProjectV1,
  kind: Stream["kind"],
): readonly SelectedStream<Stream>[] {
  const selected: SelectedStream<Stream>[] = [];
  for (const placement of project.placements) {
    if (!placement.enabled) continue;
    const asset = project.assets.find(candidate => candidate.assetId === placement.assetId)!;
    const presentations = kind === "video" ? placement.video : placement.audio;
    for (const configured of presentations) {
      if (!configured.presentation.enabled) continue;
      const stream = asset.streams.find(candidate => candidate.streamId === configured.streamId);
      if (stream?.kind !== kind) continue;
      if (kind === "video" && stream.role !== "screen") continue;
      selected.push({
        asset,
        placement,
        stream: stream as Stream,
        subject: streamSubject(asset, stream),
      });
    }
  }
  return selected.sort((left, right) => (
    left.placement.placementId.localeCompare(right.placement.placementId)
    || left.stream.streamId.localeCompare(right.stream.streamId)
  ));
}

async function detectAssetIntervals(
  selected: SelectedStream<VideoStream | AudioStream>,
  analyzer: FfmpegInactivityAnalyzer,
  repositoryRoot: string,
  config: ProjectInactivityConfig,
): Promise<readonly { readonly endUs: number; readonly startUs: number }[]> {
  const detected: Array<readonly { readonly endUs: number; readonly startUs: number }[]> = [];
  for (const segment of selected.stream.segments) {
    const sourceOffsetUs = segment.assetRange.startUs - segment.fileRange.startUs;
    const path = await resolveVerifiedProjectMedia({
      expected: { bytes: segment.bytes, sha256: segment.sha256 },
      label: `Inactivity segment ${segment.path}:${segment.streamIndex}`,
      path: segment.path,
      repositoryRoot,
    });
    const intervals = selected.stream.kind === "video"
      ? await analyzer.freeze(
          path,
          segment.streamIndex,
          config.minimumCutUs,
          config.motionThreshold,
          sourceOffsetUs,
        )
      : await analyzer.silence(
          path,
          segment.streamIndex,
          config.minimumCutUs,
          sourceOffsetUs,
        );
    detected.push(intervals.flatMap(interval => {
      const startUs = Math.max(interval.startUs, segment.assetRange.startUs, selected.placement.assetRange.startUs);
      const endUs = Math.min(interval.endUs, segment.assetRange.endUs, selected.placement.assetRange.endUs);
      return endUs > startUs ? [{ endUs, startUs }] : [];
    }));
  }
  return unionIntervals(detected.flat());
}

async function displayEvidence(
  selected: SelectedStream<VideoStream>,
  analyzer: FfmpegInactivityAnalyzer,
  repositoryRoot: string,
  config: ProjectInactivityConfig,
): Promise<ProjectInactivityAnalysisV1["displays"][number]> {
  const intervals = await detectAssetIntervals(selected, analyzer, repositoryRoot, config);
  return {
    intervals: intervals.flatMap(assetRange => (
      mapAssetIntervalToProjectSlices(selected.placement, assetRange).map(slice => ({
        assetRange: slice.asset,
        confidence: 1,
        meanFrameDifference: config.motionThreshold,
        projectRange: slice.project,
      }))
    )),
    placementAssetRange: selected.placement.assetRange,
    placementId: selected.placement.placementId,
    subject: selected.subject,
    syncMapSha256: hashPlacementSync(selected.placement),
  };
}

async function audioEvidence(
  selected: SelectedStream<AudioStream>,
  analyzer: FfmpegInactivityAnalyzer,
  repositoryRoot: string,
  config: ProjectInactivityConfig,
): Promise<ProjectInactivityAnalysisV1["audio"][number]> {
  const intervals = await detectAssetIntervals(selected, analyzer, repositoryRoot, config);
  return {
    intervals: intervals.flatMap(assetRange => (
      mapAssetIntervalToProjectSlices(selected.placement, assetRange).map(slice => ({
        assetRange: slice.asset,
        peakDb: -45,
        projectRange: slice.project,
      }))
    )),
    placementAssetRange: selected.placement.assetRange,
    placementId: selected.placement.placementId,
    subject: selected.subject,
    syncMapSha256: hashPlacementSync(selected.placement),
  };
}

export interface ProjectInactivityReferenceEvidence
  extends Pick<
    ProjectInactivityAnalysisV1,
    "interactions" | "referenceRecording"
  > {
  readonly events: readonly RecordingEventV1[];
  readonly input: unknown;
  readonly manifest: RecordingManifestV1 | null;
}

export async function loadProjectInactivityReferenceEvidence(
  project: VideoProjectV1,
  artifactRoot: string,
  cursorMovementThresholdPx: number,
): Promise<ProjectInactivityReferenceEvidence> {
  const placement = project.placements.find(candidate => candidate.placementId === project.referencePlacementId)!;
  const asset = project.assets.find(candidate => candidate.assetId === placement.assetId)!;
  if (asset.source.kind !== "recording") {
    return {
      events: [],
      input: null,
      interactions: [],
      manifest: null,
      referenceRecording: null,
    };
  }
  const recording = await openRecording(artifactRoot, asset.source.recordingId);
  const events = await loadRecordingEvents(recording);
  const interactions = recordingInteractionIntervals(
    events,
    cursorMovementThresholdPx,
  ).flatMap(interaction => (
    mapAssetIntervalToProjectSlices(placement, interaction.range).map(slice => ({
      assetRange: slice.asset,
      projectRange: slice.project,
      source: interaction.source,
    }))
  )).sort((left, right) => (
    left.projectRange.startUs - right.projectRange.startUs
    || left.projectRange.endUs - right.projectRange.endUs
    || left.source.localeCompare(right.source)
  ));
  return {
    events,
    input: recording.manifest.eventStreams.map(stream => ({
      endUs: stream.endUs,
      integrity: stream.integrity,
      path: stream.path,
      recordCount: stream.recordCount,
      startUs: stream.startUs,
    })),
    interactions,
    manifest: recording.manifest,
    referenceRecording: {
      assetId: asset.assetId,
      placementId: placement.placementId,
      recordingId: asset.source.recordingId,
      syncMapSha256: hashPlacementSync(placement),
    },
  };
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

export interface AnalyzeProjectInactivityOptions {
  readonly analysisId?: string;
  readonly artifactRoot: string;
  readonly config?: ProjectInactivityConfig;
  readonly ffmpeg: string;
  readonly ffprobe: string;
  readonly ffmpegVersion: string;
  readonly now: Date;
  readonly project: OpenProject;
  /**
   * A host-opened, integrity-verified metadata snapshot. Workflow execution
   * supplies this so exact-input verification and analysis consume the same
   * event bytes instead of reopening a mutable recording path.
   */
  readonly referenceEvidence?: ProjectInactivityReferenceEvidence;
  readonly repositoryRoot: string;
  readonly runner: ProcessRunner;
  readonly toolVersion: string;
}

export interface PersistedProjectInactivityAnalysis {
  readonly analysis: ProjectInactivityAnalysisV1;
  readonly analysisPath: string;
  readonly project: VideoProjectV1;
  readonly reference: InactivityReference;
}

export interface AnalyzedProjectInactivity {
  readonly analysis: ProjectInactivityAnalysisV1;
}

/** Analyze all enabled screen/audio presentations without publishing project state. */
export async function analyzeProjectInactivity(
  options: AnalyzeProjectInactivityOptions,
): Promise<AnalyzedProjectInactivity> {
  const config = ProjectInactivityConfigSchema.parse(
    options.config ?? DEFAULT_PROJECT_INACTIVITY_CONFIG,
  );
  const analysisId = AnalysisIdSchema.parse(
    options.analysisId ?? `analysis_${randomUUID().replaceAll("-", "")}`,
  );
  if (options.project.project.analyses.some(existing => existing.analysisId === analysisId)) {
    throw new CliError("conflict", `Project analysis already exists: ${analysisId}`);
  }
  if (options.now.getTime() < Date.parse(options.project.project.updatedAt)) {
    throw new CliError("conflict", "The inactivity analysis time cannot precede the project update time.");
  }
  const analysisPath = projectAnalysisPath("inactivity", analysisId);
  await requireUnusedAnalysisPath(options.project, analysisPath);

  const screens = selectedStreams<VideoStream>(options.project.project, "video");
  if (screens.length === 0) {
    throw new CliError("invalid-data", "Project has no enabled screen stream to analyze.");
  }
  const audioStreams = config.requireAudioSilence
    ? selectedStreams<AudioStream>(options.project.project, "audio")
    : [];
  const analyzer = new FfmpegInactivityAnalyzer({
    ffmpeg: options.ffmpeg,
    ffprobe: options.ffprobe,
    runner: options.runner,
  });
  const tasks: Array<
    | { readonly kind: "audio"; readonly selected: SelectedStream<AudioStream> }
    | { readonly kind: "display"; readonly selected: SelectedStream<VideoStream> }
  > = [
    ...screens.map(selected => ({ kind: "display" as const, selected })),
    ...audioStreams.map(selected => ({ kind: "audio" as const, selected })),
  ];
  const [analyzed, reference] = await Promise.all([
    mapBounded(tasks, 4, async task => task.kind === "display"
      ? {
          evidence: await displayEvidence(task.selected, analyzer, options.repositoryRoot, config),
          kind: task.kind,
        } as const
      : {
          evidence: await audioEvidence(task.selected, analyzer, options.repositoryRoot, config),
          kind: task.kind,
        } as const),
    options.referenceEvidence === undefined
      ? loadProjectInactivityReferenceEvidence(
          options.project.project,
          options.artifactRoot,
          config.cursorMovementThresholdPx,
        )
      : Promise.resolve(options.referenceEvidence),
  ]);
  const displays = analyzed.flatMap(item => item.kind === "display" ? [item.evidence] : []);
  const audio = analyzed.flatMap(item => item.kind === "audio" ? [item.evidence] : []);
  const plan = planMappedInactivityCuts({
    audioIntervals: audio.map(item => item.intervals.map(interval => interval.projectRange)),
    displayIntervals: displays.map(item => item.intervals
      .filter(interval => interval.confidence >= config.minimumFreezeConfidence)
      .map(interval => interval.projectRange)),
    interactionIntervals: reference.interactions.map(interaction => interaction.projectRange),
    sourceDurationUs: options.project.project.timeline.durationUs,
  }, {
    cursorMovementThresholdPx: config.cursorMovementThresholdPx,
    edgeHandleUs: config.edgeHandleUs,
    interactionHandleUs: config.interactionHandleUs,
    minimumCutUs: config.minimumCutUs,
    minimumFreezeConfidence: config.minimumFreezeConfidence,
    requireAudioSilence: config.requireAudioSilence,
  });
  const projectStructureSha256 = hashProjectStructure(options.project.project);
  const inputDigest = canonicalJsonSha256({
    audio: audio.map(item => ({
      placementId: item.placementId,
      subject: item.subject,
      syncMapSha256: item.syncMapSha256,
    })),
    config,
    displays: displays.map(item => ({
      placementId: item.placementId,
      subject: item.subject,
      syncMapSha256: item.syncMapSha256,
    })),
    projectStructureSha256,
    referenceEvents: reference.input,
  });
  const createdAt = options.now.toISOString();
  const analysis = ProjectInactivityAnalysisV1Schema.parse({
    analysisId,
    audio,
    config,
    createdAt,
    displays,
    durationUs: options.project.project.timeline.durationUs,
    inputDigest,
    interactions: reference.interactions,
    kind: "atet.project-inactivity-analysis",
    projectId: options.project.project.projectId,
    projectStructureSha256,
    referenceRecording: reference.referenceRecording,
    result: {
      candidateCount: plan.candidateCount,
      protectedInteractionCount: plan.protectedInteractionCount,
      recommendedRanges: plan.cuts,
    },
    schemaVersion: 1,
    tool: AnalysisToolSchema.parse({
      name: "ffmpeg-freezedetect-silencedetect",
      profile: "all-enabled-project-streams-v1",
      version: `${options.toolVersion}; ${options.ffmpegVersion}`.slice(0, 128),
    }),
  });
  return { analysis };
}

export function buildProjectInactivityAnalysisReference(
  analysisInput: ProjectInactivityAnalysisV1,
  analysisPath: string,
): InactivityReference {
  const analysis = ProjectInactivityAnalysisV1Schema.parse(analysisInput);
  const reference = ProjectAnalysisReferenceSchema.parse({
    analysisId: analysis.analysisId,
    audioStreams: analysis.audio.length,
    createdAt: analysis.createdAt,
    displayStreams: analysis.displays.length,
    kind: "inactivity",
    path: analysisPath,
    projectStructureSha256: analysis.projectStructureSha256,
    recommendedRanges: analysis.result.recommendedRanges.length,
    sha256: sha256Hex(`${canonicalJson(analysis)}\n`),
  });
  if (reference.kind !== "inactivity") {
    throw new CliError("internal", "Inactivity reference parsing changed its kind.");
  }
  return reference;
}

export function buildProjectInactivityUpdate(options: {
  readonly analysis: ProjectInactivityAnalysisV1;
  readonly analysisPath: string;
  readonly project: VideoProjectV1;
  readonly updatedAt: string;
}): {
  readonly project: VideoProjectV1;
  readonly reference: InactivityReference;
} {
  const analysis = ProjectInactivityAnalysisV1Schema.parse(options.analysis);
  if (options.project.analyses.some(existing => existing.analysisId === analysis.analysisId)) {
    throw new CliError("conflict", `Project analysis already exists: ${analysis.analysisId}`);
  }
  if (Date.parse(options.updatedAt) < Date.parse(options.project.updatedAt)) {
    throw new CliError(
      "conflict",
      "The inactivity analysis update time cannot precede the project update time.",
    );
  }
  const reference = buildProjectInactivityAnalysisReference(
    analysis,
    options.analysisPath,
  );
  const project = VideoProjectV1Schema.parse({
    ...options.project,
    analyses: [...options.project.analyses, reference],
    updatedAt: options.updatedAt,
  });
  return { project, reference };
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function saveProjectInactivityArtifactOnce(
  project: OpenProject,
  analysis: ProjectInactivityAnalysisV1,
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

export interface PublishedProjectInactivityArtifact {
  readonly analysisPath: string;
  readonly reference: InactivityReference;
}

export async function publishProjectInactivityArtifact(options: {
  readonly analysis: ProjectInactivityAnalysisV1;
  readonly project: OpenProject;
}): Promise<PublishedProjectInactivityArtifact> {
  const analysis = ProjectInactivityAnalysisV1Schema.parse(options.analysis);
  const analysisPath = projectAnalysisPath("inactivity", analysis.analysisId);
  await requireUnusedAnalysisPath(options.project, analysisPath);
  const reference = buildProjectInactivityAnalysisReference(analysis, analysisPath);
  await saveProjectInactivityArtifactOnce(options.project, analysis, analysisPath);
  const persistedText = await options.project.fileSystem.readText(analysisPath);
  if (sha256Hex(persistedText) !== reference.sha256) {
    throw new CliError(
      "conflict",
      "Persisted inactivity-analysis sidecar failed its content-addressed verification.",
    );
  }
  return { analysisPath, reference };
}

/** Analyze and persist an immutable sidecar plus its validated project reference. */
export async function analyzeAndPersistProjectInactivity(
  options: AnalyzeProjectInactivityOptions,
): Promise<PersistedProjectInactivityAnalysis> {
  const analyzed = await analyzeProjectInactivity(options);
  const published = await publishProjectInactivityArtifact({
    analysis: analyzed.analysis,
    project: options.project,
  });
  const update = buildProjectInactivityUpdate({
    analysis: analyzed.analysis,
    analysisPath: published.analysisPath,
    project: options.project.project,
    updatedAt: analyzed.analysis.createdAt,
  });
  const project = canonicalAtetPersistenceDocument(update.project);
  await saveVideoProject(options.project.fileSystem, project);
  return {
    analysis: analyzed.analysis,
    analysisPath: published.analysisPath,
    ...update,
    project,
  };
}
