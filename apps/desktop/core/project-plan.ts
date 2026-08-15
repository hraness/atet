import {
  ProjectEditPlanV1Schema,
  SourceIntervalSchema,
  SpeedRangeSchema,
  type ProjectEditPlanV1,
  type ProjectPlacementV1,
  type SourceInterval,
  type VideoProjectV1,
} from "../contracts";
import { canonicalJsonSha256 } from "./canonical-json";
import { intersectIntervals, subtractIntervals, unionIntervals } from "./intervals";
import {
  assertProjectCameraMoveBindings,
  hashProjectCameraSync,
} from "./project-camera";

export function hashProjectStructure(project: VideoProjectV1): string {
  return canonicalJsonSha256({
    assets: project.assets,
    placements: project.placements,
    projectId: project.projectId,
    referencePlacementId: project.referencePlacementId,
    timeline: project.timeline,
  });
}

export function hashPlacementSync(placement: ProjectPlacementV1): string {
  return hashProjectCameraSync(placement);
}

/** Enabled placements whose project-clock mapping is not trusted for structural automation. */
export function unverifiedEnabledPlacementIds(
  project: VideoProjectV1,
): readonly ProjectPlacementV1["placementId"][] {
  return project.placements
    .filter(placement => placement.enabled && placement.sync.provenance.kind === "unverified")
    .map(placement => placement.placementId)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Bind automated global speech edits to every audible placement that was
 * considered by music and speech protection. Presentation gain does not
 * affect protection, while clock maps, enabled stream identities, and their
 * immutable media descriptions do.
 */
export function hashEnabledAudioProtectionStructure(project: VideoProjectV1): string {
  const assets = new Map(project.assets.map(asset => [asset.assetId, asset]));
  const streams = project.placements.flatMap(placement => {
    if (!placement.enabled) return [];
    const asset = assets.get(placement.assetId);
    if (asset === undefined) return [];
    return placement.audio.flatMap(configured => {
      if (!configured.presentation.enabled) return [];
      const stream = asset.streams.find(candidate => candidate.streamId === configured.streamId);
      if (stream?.kind !== "audio") return [];
      return [{
        assetId: asset.assetId,
        assetRange: placement.assetRange,
        placementId: placement.placementId,
        streamId: stream.streamId,
        streamSha256: canonicalJsonSha256({ assetDurationUs: asset.durationUs, stream }),
        sync: placement.sync,
      }];
    });
  }).sort((left, right) => (
    left.placementId.localeCompare(right.placementId)
    || left.streamId.localeCompare(right.streamId)
  ));
  return canonicalJsonSha256(streams);
}

function normalizeSpeed(
  ranges: ProjectEditPlanV1["speed"],
  keep: readonly SourceInterval[],
  baseSpeed: number,
): ProjectEditPlanV1["speed"] {
  const parsed = ranges.map(candidate => SpeedRangeSchema.parse(candidate));
  if (parsed.length === 0 || keep.length === 0) return [];

  // Later authored ranges win. Coordinate compression plus a disjoint-set
  // "next unassigned segment" index applies that precedence in reverse while
  // visiting every atomic segment at most once. The previous repeated
  // subtract/union implementation was quadratic on already-normalized plans.
  const coordinates = [...new Set([
    ...parsed.flatMap(speed => [
      speed.range.startUs,
      speed.range.endUs,
    ]),
    ...keep.flatMap(interval => [interval.startUs, interval.endUs]),
  ])].sort((left, right) => left - right);
  const coordinateIndexes = new Map(
    coordinates.map((coordinate, index) => [coordinate, index]),
  );
  const segmentRates: (number | undefined)[] = Array.from({
    length: Math.max(0, coordinates.length - 1),
  });
  const nextUnassigned = new Uint32Array(segmentRates.length + 1);
  for (let index = 0; index < nextUnassigned.length; index += 1) {
    nextUnassigned[index] = index;
  }
  const findNextUnassigned = (input: number): number => {
    let root = input;
    while (nextUnassigned[root] !== root) {
      root = nextUnassigned[root]!;
    }
    let index = input;
    while (nextUnassigned[index] !== index) {
      const next = nextUnassigned[index]!;
      nextUnassigned[index] = root;
      index = next;
    }
    return root;
  };
  const coordinateIndex = (coordinate: number): number => {
    const index = coordinateIndexes.get(coordinate);
    if (index === undefined) {
      throw new TypeError("Speed normalization lost a range boundary.");
    }
    return index;
  };
  for (let rangeIndex = parsed.length - 1; rangeIndex >= 0; rangeIndex -= 1) {
    const speed = parsed[rangeIndex]!;
    const endIndex = coordinateIndex(speed.range.endUs);
    let segmentIndex = findNextUnassigned(
      coordinateIndex(speed.range.startUs),
    );
    while (segmentIndex < endIndex) {
      segmentRates[segmentIndex] = speed.rate;
      nextUnassigned[segmentIndex] = findNextUnassigned(segmentIndex + 1);
      segmentIndex = findNextUnassigned(segmentIndex);
    }
  }

  const merged: { range: SourceInterval; rate: number }[] = [];
  let keepIndex = 0;
  for (
    let segmentIndex = 0;
    segmentIndex < segmentRates.length;
    segmentIndex += 1
  ) {
    const startUs = coordinates[segmentIndex]!;
    const endUs = coordinates[segmentIndex + 1]!;
    while (
      keepIndex < keep.length
      && keep[keepIndex]!.endUs <= startUs
    ) {
      keepIndex += 1;
    }
    const kept = keep[keepIndex];
    const rate = segmentRates[segmentIndex];
    if (
      rate === undefined
      || rate === baseSpeed
      || kept === undefined
      || kept.startUs > startUs
      || kept.endUs < endUs
    ) {
      continue;
    }
    const prior = merged.at(-1);
    if (
      prior !== undefined
      && prior.rate === rate
      && prior.range.endUs === startUs
    ) {
      merged[merged.length - 1] = {
        range: { endUs, startUs: prior.range.startUs },
        rate,
      };
    } else {
      merged.push({ range: { endUs, startUs }, rate });
    }
  }
  return merged;
}

function overlapsKeep(range: SourceInterval, keep: readonly SourceInterval[]): boolean {
  return keep.some(interval => interval.startUs < range.endUs && interval.endUs > range.startUs);
}

export function normalizeProjectEditPlan(plan: ProjectEditPlanV1): ProjectEditPlanV1 {
  const bounds = { startUs: 0, endUs: plan.timelineDurationUs };
  const keep = unionIntervals(plan.keep.map(interval => SourceIntervalSchema.parse(interval)))
    .flatMap(interval => intersectIntervals([interval], [bounds]));
  const speed = normalizeSpeed(plan.speed, keep, plan.baseSpeed);
  const overlays = plan.overlays
    .filter(overlay => overlapsKeep(overlay.range, keep))
    .sort((left, right) => (
      left.range.startUs - right.range.startUs
      || left.zIndex - right.zIndex
      || left.overlayId.localeCompare(right.overlayId)
    ));
  const zooms = plan.zooms
    .filter(zoom => overlapsKeep(zoom.operation.range, keep))
    .sort((left, right) => (
      left.operation.range.startUs - right.operation.range.startUs
      || left.placementId.localeCompare(right.placementId)
      || left.operation.zoomId.localeCompare(right.operation.zoomId)
    ));
  const cameraMoves = plan.cameraMoves
    .filter(move => overlapsKeep(move.projectRange, keep))
    .sort((left, right) => (
      left.projectRange.startUs - right.projectRange.startUs
      || left.placementId.localeCompare(right.placementId)
      || left.streamId.localeCompare(right.streamId)
      || left.cameraMoveId.localeCompare(right.cameraMoveId)
    ));
  const derivations = [...plan.derivations].sort((left, right) => (
    left.projectRange.startUs - right.projectRange.startUs
    || left.projectRange.endUs - right.projectRange.endUs
    || left.decisionId.localeCompare(right.decisionId)
  ));
  return ProjectEditPlanV1Schema.parse({
    ...plan,
    cameraMoves,
    derivations,
    keep,
    overlays,
    speed,
    zooms,
  });
}

export function createDefaultProjectEditPlan(
  project: VideoProjectV1,
  planId: ProjectEditPlanV1["planId"],
  timestamp: string,
): ProjectEditPlanV1 {
  return ProjectEditPlanV1Schema.parse({
    baseSpeed: 1,
    cameraMoves: [],
    createdAt: timestamp,
    derivations: [],
    effects: {
      clicks: { enabled: false },
      cursor: { enabled: false },
      keystrokes: { enabled: false },
      metadataPlacementId: project.referencePlacementId,
      typedText: { enabled: false },
    },
    keep: [{ startUs: 0, endUs: project.timeline.durationUs }],
    kind: "atet.project-edit-plan",
    overlays: [],
    planId,
    projectId: project.projectId,
    projectStructureSha256: hashProjectStructure(project),
    schemaVersion: 1,
    speed: [],
    timelineDurationUs: project.timeline.durationUs,
    updatedAt: timestamp,
    zooms: [],
  });
}

function requireCurrentStructure(plan: ProjectEditPlanV1, project: VideoProjectV1): void {
  if (plan.projectId !== project.projectId) throw new Error("Project edit plan belongs to another project.");
  if (plan.projectStructureSha256 !== hashProjectStructure(project)) {
    throw new Error("Project structure changed; rebase the edit plan before mutating it.");
  }
}

export function cutProjectPlan(
  project: VideoProjectV1,
  plan: ProjectEditPlanV1,
  range: SourceInterval,
  updatedAt: string,
): ProjectEditPlanV1 {
  requireCurrentStructure(plan, project);
  const cut = SourceIntervalSchema.parse(range);
  return normalizeProjectEditPlan({
    ...plan,
    keep: subtractIntervals(plan.keep, [cut]),
    updatedAt,
  });
}

export function trimProjectPlan(
  project: VideoProjectV1,
  plan: ProjectEditPlanV1,
  range: SourceInterval,
  updatedAt: string,
): ProjectEditPlanV1 {
  requireCurrentStructure(plan, project);
  const trim = SourceIntervalSchema.parse(range);
  return normalizeProjectEditPlan({
    ...plan,
    keep: intersectIntervals(plan.keep, [trim]),
    updatedAt,
  });
}

export function setProjectSpeed(
  project: VideoProjectV1,
  plan: ProjectEditPlanV1,
  range: SourceInterval,
  rate: number,
  updatedAt: string,
): ProjectEditPlanV1 {
  requireCurrentStructure(plan, project);
  const speed = SpeedRangeSchema.parse({ range, rate });
  return normalizeProjectEditPlan({ ...plan, speed: [...plan.speed, speed], updatedAt });
}

export function rebaseProjectEditPlan(
  previousProject: VideoProjectV1,
  nextProject: VideoProjectV1,
  plan: ProjectEditPlanV1,
  updatedAt: string,
): ProjectEditPlanV1 {
  requireCurrentStructure(plan, previousProject);
  if (previousProject.projectId !== nextProject.projectId) {
    throw new Error("Cannot rebase an edit plan across project identities.");
  }
  if (
    plan.derivations.some(derivation => derivation.origin.kind === "asset-analysis")
    && hashEnabledAudioProtectionStructure(previousProject)
      !== hashEnabledAudioProtectionStructure(nextProject)
  ) {
    throw new Error(
      "Analysis-derived global edits are stale after the enabled-audio protection structure changed.",
    );
  }
  for (const derivation of plan.derivations) {
    if (derivation.origin.kind === "asset-analysis") {
      const origin = derivation.origin;
      const placement = nextProject.placements.find(
        candidate => candidate.placementId === origin.placementId,
      );
      if (
        placement === undefined
        || placement.assetId !== origin.assetId
        || hashPlacementSync(placement) !== origin.syncMapSha256
      ) {
        throw new Error(
          `Analysis-derived edit ${derivation.decisionId} is stale after placement synchronization changed.`,
        );
      }
    } else if (
      derivation.origin.kind === "project-analysis"
      && derivation.origin.projectStructureSha256 !== hashProjectStructure(nextProject)
    ) {
      throw new Error(
        `Analysis-derived edit ${derivation.decisionId} is stale after the project structure changed.`,
      );
    }
  }
  for (const move of plan.cameraMoves) {
    assertProjectCameraMoveBindings(nextProject, move);
  }
  const extendsUncutTail = plan.keep.at(-1)?.endUs === previousProject.timeline.durationUs;
  const keep = nextProject.timeline.durationUs > previousProject.timeline.durationUs && extendsUncutTail
    ? [
        ...plan.keep.slice(0, -1),
        {
          startUs: plan.keep.at(-1)!.startUs,
          endUs: nextProject.timeline.durationUs,
        },
      ]
    : plan.keep.flatMap(interval => intersectIntervals([interval], [{
        startUs: 0,
        endUs: nextProject.timeline.durationUs,
      }]));
  return normalizeProjectEditPlan(ProjectEditPlanV1Schema.parse({
    ...plan,
    keep,
    projectStructureSha256: hashProjectStructure(nextProject),
    timelineDurationUs: nextProject.timeline.durationUs,
    updatedAt,
  }));
}

export function hashProjectEditPlan(plan: ProjectEditPlanV1): string {
  return canonicalJsonSha256(normalizeProjectEditPlan(plan));
}
