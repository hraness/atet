import { randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

import {
  ProjectAssetV1Schema,
  ProjectMediaStreamSchema,
  ProjectPlacementV1Schema,
  RepositoryRelativePathSchema,
  VideoProjectIdSchema,
  VideoProjectV1Schema,
  type ProjectAssetV1,
  type ProjectEditPlanV1,
  type ProjectPlacementV1,
  type VideoProjectV1,
} from "../contracts";
import {
  CURRENT_PROJECT_EDIT_PLAN_PATH,
  canonicalJsonSha256,
  createDefaultProjectEditPlan,
  createNodeBundleFileSystem,
  hashProjectEditPlan,
  hashProjectStructure,
  rebaseProjectEditPlan,
  loadProjectEditPlan,
  loadVideoProject,
  saveProjectEditPlan,
  saveVideoProject,
  type BundleFileSystem,
} from "../core";
import type { RecordingManifestV1 } from "../contracts";
import { CliError } from "./errors";
import { ensurePrivateDirectory } from "./paths";
import {
  assertProjectStateTransactionSettled,
  commitProjectStateTransaction,
} from "./project-state-transaction";
import type { OpenRecording } from "./bundle-service";

export interface ProjectDirectory {
  readonly id: string;
  readonly modifiedAt: string;
  readonly path: string;
}

export interface OpenProject {
  readonly directory: ProjectDirectory;
  readonly fileSystem: BundleFileSystem;
  readonly project: VideoProjectV1;
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

function repositoryRelative(repositoryRoot: string, absolutePath: string): string {
  const path = relative(repositoryRoot, absolutePath);
  if (!isWithin(repositoryRoot, absolutePath) || isAbsolute(path)) {
    throw new CliError("unsafe-path", `Project media must remain inside the repository: ${absolutePath}`);
  }
  return RepositoryRelativePathSchema.parse(path);
}

export async function listProjectDirectories(projectRoot: string): Promise<readonly ProjectDirectory[]> {
  let entries;
  try {
    entries = await readdir(projectRoot, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const directories = await Promise.all(entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith("project_"))
    .map(async entry => {
      const path = join(projectRoot, entry.name);
      const details = await stat(path);
      return { id: entry.name, modifiedAt: details.mtime.toISOString(), path };
    }));
  return directories.sort((left, right) => (
    right.modifiedAt.localeCompare(left.modifiedAt) || left.id.localeCompare(right.id)
  ));
}

export async function resolveProjectDirectory(
  projectRoot: string,
  reference: string,
): Promise<ProjectDirectory> {
  if (!/^project_[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(reference)) {
    throw new CliError("usage", `Project reference must be an exact project_ ID or prefix: ${reference}`);
  }
  const projects = await listProjectDirectories(projectRoot);
  const exact = projects.find(project => project.id === reference);
  if (exact !== undefined) return exact;
  const matches = projects.filter(project => project.id.startsWith(reference));
  if (matches.length === 0) throw new CliError("not-found", `No project matches ${reference}.`);
  if (matches.length > 1) {
    throw new CliError(
      "conflict",
      `Project prefix ${reference} is ambiguous: ${matches.map(project => project.id).join(", ")}.`,
    );
  }
  return matches[0]!;
}

export async function openProject(projectRoot: string, reference: string): Promise<OpenProject> {
  const directory = await resolveProjectDirectory(projectRoot, reference);
  const fileSystem = createNodeBundleFileSystem(directory.path);
  try {
    await assertProjectStateTransactionSettled(fileSystem);
    const project = await loadVideoProject(fileSystem);
    if (project.projectId !== directory.id) {
      throw new CliError(
        "invalid-data",
        `Project directory ${directory.id} contains a manifest for ${project.projectId}.`,
      );
    }
    return { directory, fileSystem, project };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("invalid-data", `Could not load ${directory.id}/project.json: ${String(error)}`);
  }
}

function streamId(trackId: string): string {
  return `stream_${trackId.slice("track_".length)}`;
}

function resourcePath(
  repositoryRoot: string,
  recording: OpenRecording,
  path: string,
): string {
  return repositoryRelative(repositoryRoot, join(recording.directory.path, path));
}

function recordingStream(
  repositoryRoot: string,
  recording: OpenRecording,
  track: RecordingManifestV1["tracks"][number],
): ProjectAssetV1["streams"][number] {
  const segments = track.segments.map(segment => {
    if (segment.integrity.state !== "verified") {
      throw new CliError("invalid-data", `Track ${track.trackId} has unverified media.`);
    }
    return {
      assetRange: { startUs: segment.startUs, endUs: segment.endUs },
      bytes: segment.integrity.bytes,
      codec: segment.codec,
      container: segment.container,
      fileRange: segment.fileRange,
      path: resourcePath(repositoryRoot, recording, segment.path),
      sha256: segment.integrity.sha256,
      streamIndex: segment.streamIndex,
    };
  });
  if (track.kind === "display-video") {
    const source = recording.manifest.sources.displays.find(display => display.displayId === track.source.displayId)!;
    return ProjectMediaStreamSchema.parse({
      frameRate: source.refreshRateHz,
      kind: "video",
      label: track.label,
      pixelHeight: source.pixelSize.height,
      pixelWidth: source.pixelSize.width,
      role: "screen",
      segments,
      streamId: streamId(track.trackId),
    });
  }
  if (track.kind === "camera-video") {
    const source = recording.manifest.sources.cameras.find(camera => camera.cameraId === track.source.cameraId)!;
    return ProjectMediaStreamSchema.parse({
      frameRate: source.frameRate,
      kind: "video",
      label: track.label,
      pixelHeight: source.pixelSize.height,
      pixelWidth: source.pixelSize.width,
      role: "camera",
      segments,
      streamId: streamId(track.trackId),
    });
  }
  const source = recording.manifest.sources.audio.find(audio => audio.audioSourceId === track.source.audioSourceId)!;
  return ProjectMediaStreamSchema.parse({
    channels: source.channels,
    kind: "audio",
    label: track.label,
    role: track.kind === "microphone-audio" ? "microphone" : "system-audio",
    sampleRateHz: source.sampleRateHz,
    segments,
    streamId: streamId(track.trackId),
  });
}

function defaultPlacement(asset: ProjectAssetV1, placementId: string): ProjectPlacementV1 {
  let screenLayer = 0;
  let cameraLayer = 100;
  const video = asset.streams.flatMap(stream => stream.kind === "video" ? [{
    presentation: {
      blendMode: "normal" as const,
      crop: { kind: "none" as const },
      enabled: true as const,
      fit: stream.role === "screen" ? "fill" as const : "contain" as const,
      layer: stream.role === "screen" ? screenLayer++ : cameraLayer++,
      layout: stream.role === "screen"
        ? { height: 1, kind: "normalized" as const, width: 1, x: 0, y: 0 }
        : { height: 0.28, kind: "normalized" as const, width: 0.28, x: 0.7, y: 0.7 },
      opacity: 1,
    },
    streamId: stream.streamId,
  }] : []);
  const audio = asset.streams.flatMap(stream => stream.kind === "audio" ? [{
    presentation: { enabled: true as const, gainDb: 0, pan: 0 },
    streamId: stream.streamId,
  }] : []);
  return ProjectPlacementV1Schema.parse({
    assetId: asset.assetId,
    assetRange: { startUs: 0, endUs: asset.durationUs },
    audio,
    enabled: true,
    placementId,
    sync: {
      anchors: [
        { assetTimeUs: 0, projectTimeUs: 0 },
        { assetTimeUs: asset.durationUs, projectTimeUs: asset.durationUs },
      ],
      provenance: { kind: "identity" },
    },
    video,
  });
}

export interface CreateProjectOptions {
  readonly id?: string;
  readonly name?: string;
  readonly now: Date;
  readonly projectRoot: string;
  readonly recording: OpenRecording;
  readonly repositoryRoot: string;
}

export async function createProjectFromRecording(options: CreateProjectOptions): Promise<OpenProject> {
  if (options.recording.manifest.state !== "stopped") {
    throw new CliError("conflict", "Create a project only after the source recording has stopped.");
  }
  if (options.recording.manifest.timeline.durationUs <= 0) {
    throw new CliError("invalid-data", "Cannot create a project from an empty recording.");
  }
  const suffix = (options.id ?? randomUUID().replaceAll("-", "")).replace(/^project_/u, "").toLocaleLowerCase();
  const projectId = VideoProjectIdSchema.parse(`project_${suffix}`);
  const assetId = `asset_${suffix}`;
  const placementId = `placement_${suffix}`;
  const timestamp = options.now.toISOString();
  const streams = options.recording.manifest.tracks
    .filter(track => track.enabled && track.segments.length > 0)
    .map(track => recordingStream(options.repositoryRoot, options.recording, track));
  if (streams.length === 0) throw new CliError("invalid-data", "Recording has no enabled media streams.");
  const asset = ProjectAssetV1Schema.parse({
    assetId,
    createdAt: timestamp,
    durationUs: options.recording.manifest.timeline.durationUs,
    label: `Recording ${options.recording.manifest.recordingId}`,
    role: streams.some(stream => stream.kind === "video" && stream.role === "screen") ? "screen" : "other",
    source: {
      kind: "recording",
      recordingId: options.recording.manifest.recordingId,
      trackIds: options.recording.manifest.tracks.map(track => track.trackId),
    },
    streams,
  });
  const placement = defaultPlacement(asset, placementId);
  const project = VideoProjectV1Schema.parse({
    analyses: [],
    assets: [asset],
    createdAt: timestamp,
    currentEditPlanPath: CURRENT_PROJECT_EDIT_PLAN_PATH,
    kind: "atet.video-project",
    name: options.name?.trim() || `Recording ${options.recording.manifest.recordingId}`,
    placements: [placement],
    projectId,
    referencePlacementId: placement.placementId,
    schemaVersion: 1,
    timeline: { durationUs: asset.durationUs, timebase: "microseconds" },
    updatedAt: timestamp,
  });
  const plan = createDefaultProjectEditPlan(project, `plan_${suffix}` as ProjectEditPlanV1["planId"], timestamp);

  await ensurePrivateDirectory(options.projectRoot);
  const finalPath = join(await realpath(options.projectRoot), projectId);
  const temporaryPath = join(await realpath(options.projectRoot), `.creating-${projectId}-${randomUUID()}`);
  if (!isWithin(await realpath(options.projectRoot), finalPath)) {
    throw new CliError("unsafe-path", "Project destination escaped the project root.");
  }
  try {
    await mkdir(temporaryPath, { mode: 0o700 });
    const fileSystem = createNodeBundleFileSystem(temporaryPath);
    await saveProjectEditPlan(fileSystem, plan);
    await saveVideoProject(fileSystem, project);
    await rename(temporaryPath, finalPath);
  } catch (error) {
    await rm(temporaryPath, { force: true, recursive: true });
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new CliError("conflict", `Project already exists: ${projectId}`);
    }
    throw error;
  }
  return await openProject(options.projectRoot, projectId);
}

export async function loadCurrentProjectPlan(project: OpenProject): Promise<ProjectEditPlanV1> {
  try {
    await assertProjectStateTransactionSettled(project.fileSystem);
    const plan = await loadProjectEditPlan(project.fileSystem);
    if (plan.projectId !== project.project.projectId) {
      throw new CliError("invalid-data", "Current project edit plan belongs to another project.");
    }
    if (plan.projectStructureSha256 !== hashProjectStructure(project.project)) {
      throw new CliError(
        "invalid-data",
        "Current project edit plan and project.json belong to different structure generations.",
      );
    }
    return plan;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError("invalid-data", `Could not load the current project edit plan: ${String(error)}`);
  }
}

export function projectSummary(
  project: OpenProject,
  plan: ProjectEditPlanV1 | null,
): Readonly<Record<string, unknown>> {
  return {
    analyses: project.project.analyses.map(analysis => ({
      analysisId: analysis.analysisId,
      kind: analysis.kind,
      path: analysis.path,
    })),
    assets: project.project.assets.map(asset => ({
      assetId: asset.assetId,
      durationUs: asset.durationUs,
      label: asset.label,
      role: asset.role,
      streams: asset.streams.map(stream => ({ kind: stream.kind, role: stream.role, streamId: stream.streamId })),
    })),
    durationUs: project.project.timeline.durationUs,
    edit: plan === null ? null : {
      cameraMoves: plan.cameraMoves.length,
      hash: hashProjectEditPlan(plan),
      keepRanges: plan.keep.length,
      overlays: plan.overlays.length,
      planId: plan.planId,
      speedRanges: plan.speed.length,
    },
    name: project.project.name,
    path: project.directory.path,
    placements: project.project.placements.map(placement => ({
      assetId: placement.assetId,
      enabled: placement.enabled,
      placementId: placement.placementId,
      syncAnchors: placement.sync.anchors.length,
    })),
    projectId: project.project.projectId,
    updatedAt: project.project.updatedAt,
  };
}

export function projectAnalysisPath(
  kind: "alignment" | "faces" | "inactivity" | "music" | "scenes" | "speech",
  analysisId: string,
): string {
  return RepositoryRelativePathSchema.parse(`analysis/${kind}/${analysisId}.json`);
}

function nextPlacementId(project: VideoProjectV1, asset: ProjectAssetV1): string {
  const suffix = String(asset.assetId).slice("asset_".length);
  let index = 1;
  while (project.placements.some(placement => placement.placementId === `placement_${suffix}_${index}`)) {
    index += 1;
  }
  return `placement_${suffix}_${index}`;
}

function importedPlacement(
  project: VideoProjectV1,
  asset: ProjectAssetV1,
  startUs: number,
): ProjectPlacementV1 {
  if (!Number.isSafeInteger(startUs) || startUs < 0) {
    throw new CliError("usage", "Initial project placement time must be a nonnegative integer number of microseconds.");
  }
  let layer = 200;
  const audioOnlyRole = asset.role === "system-audio"
    || asset.role === "microphone"
    || asset.role === "portable-audio"
    || asset.role === "music"
    || asset.role === "dialogue";
  const video = asset.streams.flatMap(stream => stream.kind === "video" ? [{
    presentation: audioOnlyRole ? { enabled: false as const } : {
      blendMode: "normal" as const,
      crop: { kind: "none" as const },
      enabled: true as const,
      fit: "contain" as const,
      layer: layer++,
      layout: stream.role === "camera"
        ? { height: 0.28, kind: "normalized" as const, width: 0.28, x: 0.7, y: 0.7 }
        : { height: 1, kind: "normalized" as const, width: 1, x: 0, y: 0 },
      opacity: 1,
    },
    streamId: stream.streamId,
  }] : []);
  const audio = asset.streams.flatMap(stream => stream.kind === "audio" ? [{
    presentation: { enabled: true as const, gainDb: 0, pan: 0 },
    streamId: stream.streamId,
  }] : []);
  return ProjectPlacementV1Schema.parse({
    assetId: asset.assetId,
    assetRange: { startUs: 0, endUs: asset.durationUs },
    audio,
    enabled: true,
    placementId: nextPlacementId(project, asset),
    sync: {
      anchors: [
        { assetTimeUs: 0, projectTimeUs: startUs },
        { assetTimeUs: asset.durationUs, projectTimeUs: startUs + asset.durationUs },
      ],
      provenance: { kind: "unverified", reason: "initial-placement" },
    },
    video,
  });
}

export async function addAssetToProject(
  open: OpenProject,
  assetInput: ProjectAssetV1,
  startUs: number,
  now: Date,
): Promise<{ readonly plan: ProjectEditPlanV1; readonly project: VideoProjectV1; readonly placement: ProjectPlacementV1 }> {
  const asset = ProjectAssetV1Schema.parse(assetInput);
  const existing = open.project.assets.find(candidate => candidate.assetId === asset.assetId);
  if (
    existing !== undefined
    && canonicalJsonSha256(existing) !== canonicalJsonSha256(asset)
    && !isReusableImportedAsset(existing, asset)
  ) {
    throw new CliError("conflict", `Asset ID collision with different media metadata: ${asset.assetId}`);
  }
  const placement = importedPlacement(open.project, existing ?? asset, startUs);
  const endUs = placement.sync.anchors.at(-1)!.projectTimeUs;
  const timestamp = now.toISOString();
  const nextProject = VideoProjectV1Schema.parse({
    ...open.project,
    assets: existing === undefined
      ? [...open.project.assets, asset].sort((left, right) => left.assetId.localeCompare(right.assetId))
      : open.project.assets,
    placements: [...open.project.placements, placement].sort((left, right) => left.placementId.localeCompare(right.placementId)),
    timeline: {
      durationUs: Math.max(open.project.timeline.durationUs, endUs),
      timebase: "microseconds",
    },
    updatedAt: timestamp,
  });
  const priorPlan = await loadCurrentProjectPlan(open);
  const nextPlan = rebaseProjectEditPlan(open.project, nextProject, priorPlan, timestamp);
  await commitProjectStateTransaction({
    after: { plan: nextPlan, project: nextProject },
    before: { plan: priorPlan, project: open.project },
    fileSystem: open.fileSystem,
  });
  return { placement, plan: nextPlan, project: nextProject };
}

function importedAssetContentIdentity(asset: ProjectAssetV1): string | null {
  if (asset.source.kind !== "imported") return null;
  const streams = asset.streams.map(stream => {
    const segments = stream.segments.map(segment => ({
      assetRange: segment.assetRange,
      bytes: segment.bytes,
      codec: segment.codec,
      container: segment.container,
      fileRange: segment.fileRange,
      sha256: segment.sha256,
      streamIndex: segment.streamIndex,
    }));
    return stream.kind === "video" ? {
      frameRate: stream.frameRate,
      kind: stream.kind,
      pixelHeight: stream.pixelHeight,
      pixelWidth: stream.pixelWidth,
      role: stream.role,
      segments,
      streamId: stream.streamId,
    } : {
      channels: stream.channels,
      kind: stream.kind,
      role: stream.role,
      sampleRateHz: stream.sampleRateHz,
      segments,
      streamId: stream.streamId,
    };
  });
  return canonicalJsonSha256({
    assetId: asset.assetId,
    durationUs: asset.durationUs,
    role: asset.role,
    sourceSha256: asset.source.sourceSha256,
    streams,
  });
}

function isReusableImportedAsset(existing: ProjectAssetV1, candidate: ProjectAssetV1): boolean {
  const existingIdentity = importedAssetContentIdentity(existing);
  return existingIdentity !== null && existingIdentity === importedAssetContentIdentity(candidate);
}
