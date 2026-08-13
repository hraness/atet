import {
  ProjectEditPlanV1Schema,
  ProjectRenderPlanV1Schema,
  VideoProjectV1Schema,
  type ProjectEditPlanV1,
  type ProjectRenderPlanV1,
  type ProjectPlacementV1,
  type SourceInterval,
  type VideoProjectV1,
} from "../contracts";
import { canonicalJsonSha256 } from "./canonical-json";
import { compileProjectCameraSegments } from "./project-camera";
import { compileProjectMetadata, type ProjectMetadataContext } from "./project-metadata";
import { hashProjectEditPlan, hashProjectStructure } from "./project-plan";
import {
  buildProjectOutputTimeMap,
  interpolateMicroseconds,
  mapPlacementToOutputSlices,
  mapProjectIntervalToOutputSlices,
} from "./project-time";

export interface ProjectRenderSettings {
  readonly background?: string;
  readonly frameRate?: number;
  readonly metadata?: readonly ProjectMetadataContext[];
  readonly pixelHeight?: number;
  readonly pixelWidth?: number;
}

export function hashProjectRenderPlanComposition(
  planInput: ProjectRenderPlanV1,
): string {
  const plan = ProjectRenderPlanV1Schema.parse(planInput);
  const { planSha256: _planSha256, ...body } = plan;
  void _planSha256;
  return canonicalJsonSha256(body);
}

export function assertProjectRenderPlanComposition(
  planInput: ProjectRenderPlanV1,
): ProjectRenderPlanV1 {
  const plan = ProjectRenderPlanV1Schema.parse(planInput);
  const actual = hashProjectRenderPlanComposition(plan);
  if (actual !== plan.planSha256) {
    throw new TypeError(
      `Project render plan composition hash mismatch: expected ${plan.planSha256}, received ${actual}.`,
    );
  }
  return plan;
}

function intersection(left: SourceInterval, right: SourceInterval): SourceInterval | null {
  const startUs = Math.max(left.startUs, right.startUs);
  const endUs = Math.min(left.endUs, right.endUs);
  return endUs > startUs ? { endUs, startUs } : null;
}

function mapSubrange(
  value: SourceInterval,
  input: SourceInterval,
  output: SourceInterval,
): SourceInterval {
  return {
    endUs: interpolateMicroseconds(
      value.endUs,
      input.startUs,
      input.endUs,
      output.startUs,
      output.endUs,
    ),
    startUs: interpolateMicroseconds(
      value.startUs,
      input.startUs,
      input.endUs,
      output.startUs,
      output.endUs,
    ),
  };
}

function placementSlices(
  project: VideoProjectV1,
  plan: ProjectEditPlanV1,
  placement: ProjectPlacementV1,
): {
  readonly audio: ProjectRenderPlanV1["audioSlices"];
  readonly missingCoverage: boolean;
  readonly video: ProjectRenderPlanV1["videoSlices"];
} {
  const asset = project.assets.find(candidate => candidate.assetId === placement.assetId);
  if (asset === undefined) throw new Error(`Placement ${placement.placementId} references an unknown asset.`);
  const outputMap = buildProjectOutputTimeMap(plan);
  const timelineSlices = mapPlacementToOutputSlices(placement, outputMap);
  const video: ProjectRenderPlanV1["videoSlices"][number][] = [];
  const audio: ProjectRenderPlanV1["audioSlices"][number][] = [];
  let missingCoverage = false;

  for (const timelineSlice of timelineSlices) {
    for (const configured of placement.video) {
      if (!configured.presentation.enabled) continue;
      const stream = asset.streams.find(candidate => candidate.streamId === configured.streamId);
      if (stream?.kind !== "video") throw new Error(`Placement ${placement.placementId} has an invalid video stream.`);
      let coveredUs = 0;
      for (const media of stream.segments) {
        const assetRange = intersection(timelineSlice.asset, media.assetRange);
        if (assetRange === null) continue;
        coveredUs += assetRange.endUs - assetRange.startUs;
        video.push({
          assetId: asset.assetId,
          assetRange,
          bytes: media.bytes,
          codec: media.codec,
          container: media.container,
          fileRange: mapSubrange(assetRange, media.assetRange, media.fileRange),
          kind: "video",
          outputRange: mapSubrange(assetRange, timelineSlice.asset, timelineSlice.output),
          path: media.path,
          placementId: placement.placementId,
          presentation: configured.presentation,
          projectRange: mapSubrange(assetRange, timelineSlice.asset, timelineSlice.project),
          projectSpeed: timelineSlice.speed,
          role: stream.role,
          sha256: media.sha256,
          streamId: stream.streamId,
          streamIndex: media.streamIndex,
        });
      }
      missingCoverage ||= coveredUs < timelineSlice.asset.endUs - timelineSlice.asset.startUs;
    }
    for (const configured of placement.audio) {
      if (!configured.presentation.enabled) continue;
      const stream = asset.streams.find(candidate => candidate.streamId === configured.streamId);
      if (stream?.kind !== "audio") throw new Error(`Placement ${placement.placementId} has an invalid audio stream.`);
      let coveredUs = 0;
      for (const media of stream.segments) {
        const assetRange = intersection(timelineSlice.asset, media.assetRange);
        if (assetRange === null) continue;
        coveredUs += assetRange.endUs - assetRange.startUs;
        audio.push({
          assetId: asset.assetId,
          assetRange,
          bytes: media.bytes,
          codec: media.codec,
          container: media.container,
          fileRange: mapSubrange(assetRange, media.assetRange, media.fileRange),
          kind: "audio",
          outputRange: mapSubrange(assetRange, timelineSlice.asset, timelineSlice.output),
          path: media.path,
          placementId: placement.placementId,
          presentation: configured.presentation,
          projectRange: mapSubrange(assetRange, timelineSlice.asset, timelineSlice.project),
          projectSpeed: timelineSlice.speed,
          role: stream.role,
          sha256: media.sha256,
          streamId: stream.streamId,
          streamIndex: media.streamIndex,
        });
      }
      missingCoverage ||= coveredUs < timelineSlice.asset.endUs - timelineSlice.asset.startUs;
    }
  }
  return { audio, missingCoverage, video };
}

export function compileProjectRenderPlan(
  projectInput: VideoProjectV1,
  planInput: ProjectEditPlanV1,
  settings: ProjectRenderSettings = {},
): ProjectRenderPlanV1 {
  const project = VideoProjectV1Schema.parse(projectInput);
  const plan = ProjectEditPlanV1Schema.parse(planInput);
  if (plan.projectId !== project.projectId) throw new Error("Project render plan belongs to another project.");
  const projectStructureSha256 = hashProjectStructure(project);
  if (plan.projectStructureSha256 !== projectStructureSha256) {
    throw new Error("Project structure and edit plan are out of sync.");
  }
  const outputMap = buildProjectOutputTimeMap(plan);
  const outputSettings = {
    frameRate: settings.frameRate ?? 60,
    pixelHeight: settings.pixelHeight ?? 1_080,
    pixelWidth: settings.pixelWidth ?? 1_920,
  };
  if (
    !Number.isFinite(outputSettings.frameRate)
    || outputSettings.frameRate <= 0
    || outputSettings.frameRate > 240
    || !Number.isSafeInteger(outputSettings.pixelHeight)
    || outputSettings.pixelHeight <= 0
    || outputSettings.pixelHeight > 16_384
    || !Number.isSafeInteger(outputSettings.pixelWidth)
    || outputSettings.pixelWidth <= 0
    || outputSettings.pixelWidth > 16_384
    || outputSettings.pixelWidth * outputSettings.pixelHeight > 134_217_728
  ) {
    throw new RangeError("Invalid project render output dimensions or frame rate.");
  }
  for (const placement of project.placements) {
    if (!placement.enabled) continue;
    for (const configured of placement.video) {
      const presentation = configured.presentation;
      if (!presentation.enabled || presentation.layout.kind !== "output-pixels") continue;
      if (
        presentation.layout.x + presentation.layout.width > outputSettings.pixelWidth
        || presentation.layout.y + presentation.layout.height > outputSettings.pixelHeight
      ) {
        throw new RangeError(
          `Video layout for ${placement.placementId}:${configured.streamId} exceeds the project render output.`,
        );
      }
    }
  }
  const videoSlices: ProjectRenderPlanV1["videoSlices"][number][] = [];
  const audioSlices: ProjectRenderPlanV1["audioSlices"][number][] = [];
  const warnings: ProjectRenderPlanV1["warnings"][number][] = [];
  for (const placement of project.placements) {
    if (!placement.enabled) {
      warnings.push({
        code: "disabled-placement",
        message: `Placement ${placement.placementId} is disabled and will not render.`,
        placementId: placement.placementId,
      });
      continue;
    }
    if (placement.sync.provenance.kind === "unverified") {
      warnings.push({
        code: "unverified-sync",
        message: `Placement ${placement.placementId} has not been aligned; its current timing is provisional.`,
        placementId: placement.placementId,
      });
    }
    const resolved = placementSlices(project, plan, placement);
    videoSlices.push(...resolved.video);
    audioSlices.push(...resolved.audio);
    if (resolved.missingCoverage) {
      warnings.push({
        code: "missing-media-coverage",
        message: `Placement ${placement.placementId} has a kept interval without source media.`,
        placementId: placement.placementId,
      });
    }
  }
  const overlays = plan.overlays.flatMap(operation => {
    const slices = mapProjectIntervalToOutputSlices(outputMap, operation.range);
    const visibleDurationUs = slices.reduce((sum, slice) => sum + slice.output.endUs - slice.output.startUs, 0);
    let playbackOffsetUs = 0;
    return slices.map(slice => {
      const resolved = {
        operation,
        outputRange: slice.output,
        playbackOffsetUs,
        projectRange: slice.project,
        visibleDurationUs,
      };
      playbackOffsetUs += slice.output.endUs - slice.output.startUs;
      return resolved;
    });
  });
  videoSlices.sort((left, right) => (
    left.presentation.enabled && right.presentation.enabled
      ? left.presentation.layer - right.presentation.layer
      : 0
  ) || left.outputRange.startUs - right.outputRange.startUs || left.streamId.localeCompare(right.streamId));
  audioSlices.sort((left, right) => (
    left.outputRange.startUs - right.outputRange.startUs || left.streamId.localeCompare(right.streamId)
  ));
  const cameraSegments = compileProjectCameraSegments(
    project,
    plan,
    videoSlices,
    outputSettings,
  );
  const metadata = compileProjectMetadata(
    project,
    plan,
    outputMap,
    settings.metadata ?? [],
    outputSettings,
    cameraSegments,
  );
  const body = {
    audioSlices,
    cameraKeyframes: metadata.cameraKeyframes,
    cameraSegments,
    effects: metadata.effects,
    kind: "transmute.project-render-plan" as const,
    output: {
      background: settings.background ?? "#000000ff",
      durationUs: outputMap.durationUs,
      ...outputSettings,
    },
    overlays,
    projectEditPlanSha256: hashProjectEditPlan(plan),
    projectId: project.projectId,
    projectStructureSha256,
    schemaVersion: 1 as const,
    videoSlices,
    warnings,
  };
  return ProjectRenderPlanV1Schema.parse({
    ...body,
    planSha256: canonicalJsonSha256(body),
  });
}
