import {
  EditPlanV1Schema,
  OverlayOperationSchema,
  SourceIntervalSchema,
  SpeedRangeSchema,
  ZoomOperationSchema,
  type EditPlanDraft,
  type EditPlanV1,
  type OverlayOperation,
  type SourceInterval,
  type SpeedRange,
  type ZoomOperation,
} from "../contracts/edit";
import type { RecordingManifestV1 } from "../contracts/recording";
import { canonicalJsonSha256 } from "./canonical-json";
import { intersectIntervals, subtractIntervals, unionIntervals } from "./intervals";

function compareRanges(
  left: { readonly range: SourceInterval },
  right: { readonly range: SourceInterval },
): number {
  return left.range.startUs - right.range.startUs || left.range.endUs - right.range.endUs;
}

function overlaySpeedRanges(
  ranges: readonly SpeedRange[],
  keep: readonly SourceInterval[],
  baseSpeed: number,
): readonly SpeedRange[] {
  let result: SpeedRange[] = [];
  for (const input of ranges) {
    const speed = SpeedRangeSchema.parse(input);
    const surviving = result.flatMap((existing) => subtractIntervals([existing.range], [speed.range])
      .map((range) => ({ range, rate: existing.rate })));
    result = [...surviving, speed];
  }

  const clipped = result.flatMap((speed) => intersectIntervals([speed.range], keep)
    .map((range) => ({ range, rate: speed.rate })))
    .filter(({ rate }) => rate !== baseSpeed)
    .sort(compareRanges);

  const merged: SpeedRange[] = [];
  for (const speed of clipped) {
    const prior = merged.at(-1);
    if (prior !== undefined && prior.rate === speed.rate && prior.range.endUs === speed.range.startUs) {
      merged[merged.length - 1] = {
        range: { startUs: prior.range.startUs, endUs: speed.range.endUs },
        rate: speed.rate,
      };
    } else {
      merged.push(speed);
    }
  }
  return merged;
}

function clipRange(range: SourceInterval, sourceDurationUs: number): SourceInterval | null {
  const startUs = Math.max(0, Math.min(sourceDurationUs, range.startUs));
  const endUs = Math.max(0, Math.min(sourceDurationUs, range.endUs));
  return endUs > startUs ? { startUs, endUs } : null;
}

function transitionDurations(
  firstUs: number,
  secondUs: number,
  durationUs: number,
): readonly [number, number] {
  const sum = firstUs + secondUs;
  if (sum <= durationUs || sum === 0) return [firstUs, secondUs];
  const first = Math.floor(durationUs * firstUs / sum);
  return [first, durationUs - first];
}

function normalizeZooms(
  zooms: readonly ZoomOperation[],
  keep: readonly SourceInterval[],
  sourceDurationUs: number,
): readonly ZoomOperation[] {
  return zooms.flatMap((candidate) => {
    const zoom = ZoomOperationSchema.parse(candidate);
    const range = clipRange(zoom.range, sourceDurationUs);
    if (range === null || intersectIntervals([range], keep).length === 0) return [];
    const [enterDurationUs, exitDurationUs] = transitionDurations(
      zoom.enterDurationUs,
      zoom.exitDurationUs,
      range.endUs - range.startUs,
    );
    return [{ ...zoom, enterDurationUs, exitDurationUs, range }];
  }).sort((left, right) => compareRanges(left, right) || left.zoomId.localeCompare(right.zoomId));
}

function animationDuration(animation: OverlayOperation["entrance"]): number {
  return animation.kind === "none" ? 0 : animation.durationUs;
}

function withAnimationDuration<Animation extends OverlayOperation["entrance"]>(
  animation: Animation,
  durationUs: number,
): Animation {
  if (animation.kind === "none") return animation;
  return { ...animation, durationUs };
}

function normalizeOverlays(
  overlays: readonly OverlayOperation[],
  keep: readonly SourceInterval[],
  sourceDurationUs: number,
): readonly OverlayOperation[] {
  return overlays.flatMap((candidate) => {
    const overlay = OverlayOperationSchema.parse(candidate);
    const range = clipRange(overlay.range, sourceDurationUs);
    if (range === null || intersectIntervals([range], keep).length === 0) return [];
    const [entranceUs, exitUs] = transitionDurations(
      animationDuration(overlay.entrance),
      animationDuration(overlay.exit),
      range.endUs - range.startUs,
    );
    return [{
      ...overlay,
      entrance: withAnimationDuration(overlay.entrance, entranceUs),
      exit: withAnimationDuration(overlay.exit, exitUs),
      range,
    }];
  }).sort((left, right) => (
    compareRanges(left, right)
    || left.zIndex - right.zIndex
    || left.overlayId.localeCompare(right.overlayId)
  ));
}

export function normalizeEditPlan(input: EditPlanDraft): EditPlanV1 {
  const duration = input.sourceDurationUs;
  const bounds: SourceInterval = { startUs: 0, endUs: duration };
  const keep = duration === 0
    ? []
    : unionIntervals(input.keep.map((interval) => SourceIntervalSchema.parse(interval)))
      .flatMap((interval) => intersectIntervals([interval], [bounds]));
  const baseSpeed = input.baseSpeed;
  const speed = overlaySpeedRanges(
    input.speed.map((range) => SpeedRangeSchema.parse(range)),
    keep,
    baseSpeed,
  );
  const zooms = normalizeZooms(
    input.zooms.map((zoom) => ZoomOperationSchema.parse(zoom)),
    keep,
    duration,
  );
  const overlays = normalizeOverlays(
    input.overlays.map((overlay) => OverlayOperationSchema.parse(overlay)),
    keep,
    duration,
  );
  return EditPlanV1Schema.parse({ ...input, keep, overlays, speed, zooms });
}

export function createDefaultEditPlan(
  manifest: RecordingManifestV1,
  planId: EditPlanV1["planId"],
  timestamp: string,
): EditPlanV1 {
  const durationUs = manifest.timeline.durationUs;
  return EditPlanV1Schema.parse({
    baseSpeed: 1,
    createdAt: timestamp,
    effects: {
      clicks: { enabled: false },
      cursor: { enabled: false },
      keystrokes: { enabled: false },
      typedText: { enabled: false },
    },
    keep: durationUs === 0 ? [] : [{ startUs: 0, endUs: durationUs }],
    kind: "transmute.edit-plan",
    overlays: [],
    planId,
    recordingId: manifest.recordingId,
    schemaVersion: 1,
    sourceDurationUs: durationUs,
    speed: [],
    updatedAt: timestamp,
    zooms: [],
  });
}

function mutate(
  plan: EditPlanV1,
  updatedAt: string | undefined,
  patch: Partial<Pick<EditPlanDraft, "keep" | "overlays" | "speed" | "zooms">>,
): EditPlanV1 {
  return normalizeEditPlan({ ...plan, ...patch, updatedAt: updatedAt ?? plan.updatedAt });
}

export function trimPlan(plan: EditPlanV1, range: SourceInterval, updatedAt?: string): EditPlanV1 {
  const parsedRange = SourceIntervalSchema.parse(range);
  return mutate(plan, updatedAt, { keep: intersectIntervals(plan.keep, [parsedRange]) });
}

export function cutPlan(plan: EditPlanV1, range: SourceInterval, updatedAt?: string): EditPlanV1 {
  const parsedRange = SourceIntervalSchema.parse(range);
  return mutate(plan, updatedAt, { keep: subtractIntervals(plan.keep, [parsedRange]) });
}

export function setSpeed(
  plan: EditPlanV1,
  range: SourceInterval,
  rate: number,
  updatedAt?: string,
): EditPlanV1 {
  const speed = SpeedRangeSchema.parse({ range, rate });
  return mutate(plan, updatedAt, { speed: [...plan.speed, speed] });
}

export function addZoom(plan: EditPlanV1, zoom: ZoomOperation, updatedAt?: string): EditPlanV1 {
  const parsed = ZoomOperationSchema.parse(zoom);
  if (plan.zooms.some(({ zoomId }) => zoomId === parsed.zoomId)) {
    throw new Error(`Zoom already exists: ${parsed.zoomId}`);
  }
  return mutate(plan, updatedAt, { zooms: [...plan.zooms, parsed] });
}

export function removeZoom(plan: EditPlanV1, zoomId: string, updatedAt?: string): EditPlanV1 {
  const zooms = plan.zooms.filter((zoom) => zoom.zoomId !== zoomId);
  if (zooms.length === plan.zooms.length) throw new Error(`Unknown zoom: ${zoomId}`);
  return mutate(plan, updatedAt, { zooms });
}

export function addOverlay(plan: EditPlanV1, overlay: OverlayOperation, updatedAt?: string): EditPlanV1 {
  const parsed = OverlayOperationSchema.parse(overlay);
  if (plan.overlays.some(({ overlayId }) => overlayId === parsed.overlayId)) {
    throw new Error(`Overlay already exists: ${parsed.overlayId}`);
  }
  return mutate(plan, updatedAt, { overlays: [...plan.overlays, parsed] });
}

export function removeOverlay(plan: EditPlanV1, overlayId: string, updatedAt?: string): EditPlanV1 {
  const overlays = plan.overlays.filter((overlay) => overlay.overlayId !== overlayId);
  if (overlays.length === plan.overlays.length) throw new Error(`Unknown overlay: ${overlayId}`);
  return mutate(plan, updatedAt, { overlays });
}

export function hashEditPlan(plan: EditPlanDraft): string {
  return canonicalJsonSha256(normalizeEditPlan(plan));
}
