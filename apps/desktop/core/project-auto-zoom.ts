import {
  AutomaticZoomSchema,
  ProjectZoomOperationSchema,
  type AutomaticZoom,
  type ProjectPlacementV1,
  type ProjectZoomOperation,
} from "../contracts";
import { canonicalJsonSha256 } from "./canonical-json";
import { hashPlacementSync } from "./project-plan";
import { mapAssetIntervalToProjectSlices } from "./project-time";

function checkedTransitionDurations(
  zoom: AutomaticZoom,
  durationUs: number,
): { readonly enterDurationUs: number; readonly exitDurationUs: number } {
  const enterDurationUs = Math.min(
    zoom.enterDurationUs,
    Math.floor(durationUs / 2),
  );
  return {
    enterDurationUs,
    exitDurationUs: Math.min(
      zoom.exitDurationUs,
      durationUs - enterDurationUs,
    ),
  };
}

/**
 * Project recording-clock automatic zooms through one accepted placement sync
 * map. A discontinuous map produces one independently valid project zoom per
 * mapped slice, with deterministic IDs and transition durations.
 */
export function mapAutomaticZoomsToProject(
  placement: ProjectPlacementV1,
  zoomsInput: readonly AutomaticZoom[],
): readonly ProjectZoomOperation[] {
  if (placement.sync.provenance.kind === "unverified") {
    throw new TypeError(
      `Placement ${placement.placementId} has unverified synchronization.`,
    );
  }
  const zooms = zoomsInput.map(zoom => AutomaticZoomSchema.parse(zoom));
  const identity = canonicalJsonSha256({
    placementId: placement.placementId,
    syncSha256: hashPlacementSync(placement),
    zooms,
  }).slice(0, 12);
  const mapped = zooms.flatMap(zoom => (
    mapAssetIntervalToProjectSlices(placement, zoom.range).map(slice => ({
      slice,
      zoom,
    }))
  )).sort((left, right) => (
    left.slice.project.startUs - right.slice.project.startUs
    || left.zoom.displayId.localeCompare(right.zoom.displayId)
    || left.zoom.zoomId.localeCompare(right.zoom.zoomId)
  ));
  return mapped.map(({ slice, zoom }, index) => {
    const range = slice.project;
    const durations = checkedTransitionDurations(
      zoom,
      range.endUs - range.startUs,
    );
    return ProjectZoomOperationSchema.parse({
      operation: {
        ...zoom,
        ...durations,
        range,
        zoomId: `zoom_auto${identity}_${String(index + 1).padStart(4, "0")}`,
      },
      placementId: placement.placementId,
    });
  });
}
