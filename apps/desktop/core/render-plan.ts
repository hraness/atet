import {
  EditPlanV1Schema,
  type EditPlanV1,
  type SourceInterval,
  type ZoomTarget,
} from "../contracts/edit";
import {
  RecordingManifestV1Schema,
  type Point,
  type RecordingEventV1,
  type RecordingManifestV1,
  type Rect,
  type TrackId,
} from "../contracts/recording";
import { RenderPlanV1Schema, type RenderPlanV1, type RenderTypingSpan } from "../contracts/render";
import { deriveTypingSpans, findCursorAtTime, findFocusedInputAtTime, findWindowAtTime, smoothAndDownsampleCursor } from "./events";
import { hashEditPlan } from "./plan";
import { buildSourceTimeMap, mapSourceInterval, sourceToOutputUs } from "./time-map";

export interface RenderCompileOptions {
  readonly audioTrackIds: readonly TrackId[];
  readonly camera: Readonly<{ kind: "none" }>;
  readonly displayTrackId: TrackId;
  readonly frameRate: number;
  readonly pixelHeight: number;
  readonly pixelWidth: number;
}

interface DisplayTransform {
  readonly bounds: Rect;
  readonly displayId: string;
  readonly outputScaleX: number;
  readonly outputScaleY: number;
  readonly scaleFactor: number;
}

interface ResolvedZoomTarget {
  readonly scale: number;
  readonly viewport: Rect;
}

export class UnsatisfiedRenderTargetError extends Error {
  readonly sourceTimeUs: number;
  readonly target: ZoomTarget;

  constructor(target: ZoomTarget, sourceTimeUs: number) {
    super(`Cannot resolve ${target.kind} zoom target at ${sourceTimeUs}us.`);
    this.name = "UnsatisfiedRenderTargetError";
    this.sourceTimeUs = sourceTimeUs;
    this.target = target;
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function targetViewport(
  target: Rect,
  requestedScale: number,
  options: RenderCompileOptions,
  paddingPx = 0,
): ResolvedZoomTarget {
  const aspect = options.pixelWidth / options.pixelHeight;
  const requestedWidth = options.pixelWidth / requestedScale;
  const paddedWidth = Math.min(options.pixelWidth, target.width + paddingPx * 2);
  const paddedHeight = Math.min(options.pixelHeight, target.height + paddingPx * 2);
  const width = Math.min(
    options.pixelWidth,
    Math.max(requestedWidth, paddedWidth, paddedHeight * aspect),
  );
  const height = width / aspect;
  const x = clamp(target.x + target.width / 2 - width / 2, 0, options.pixelWidth - width);
  const y = clamp(target.y + target.height / 2 - height / 2, 0, options.pixelHeight - height);
  return {
    scale: options.pixelWidth / width,
    viewport: { height, width, x, y },
  };
}

function pointViewport(point: Point, scale: number, options: RenderCompileOptions): ResolvedZoomTarget {
  return targetViewport({ height: 0, width: 0, x: point.x, y: point.y }, scale, options);
}

function pointInRect(point: Point, rect: Rect): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

function globalPointToOutput(point: Point, transform: DisplayTransform): Point {
  if (!pointInRect(point, transform.bounds)) {
    throw new Error(`Global point (${point.x}, ${point.y}) is outside selected display ${transform.displayId}.`);
  }
  return {
    x: (point.x - transform.bounds.x) * transform.scaleFactor * transform.outputScaleX,
    y: (point.y - transform.bounds.y) * transform.scaleFactor * transform.outputScaleY,
  };
}

function globalRectToOutput(rect: Rect, transform: DisplayTransform): Rect {
  const left = Math.max(rect.x, transform.bounds.x);
  const top = Math.max(rect.y, transform.bounds.y);
  const right = Math.min(rect.x + rect.width, transform.bounds.x + transform.bounds.width);
  const bottom = Math.min(rect.y + rect.height, transform.bounds.y + transform.bounds.height);
  if (right <= left || bottom <= top) {
    throw new Error(`Global rect does not intersect selected display ${transform.displayId}.`);
  }
  return {
    height: (bottom - top) * transform.scaleFactor * transform.outputScaleY,
    width: (right - left) * transform.scaleFactor * transform.outputScaleX,
    x: (left - transform.bounds.x) * transform.scaleFactor * transform.outputScaleX,
    y: (top - transform.bounds.y) * transform.scaleFactor * transform.outputScaleY,
  };
}

function tryGlobalRectToOutput(rect: Rect, transform: DisplayTransform): Rect | null {
  try {
    return globalRectToOutput(rect, transform);
  } catch {
    return null;
  }
}

function resolveTarget(
  target: ZoomTarget,
  sourceTimeUs: number,
  scale: number,
  events: readonly RecordingEventV1[],
  options: RenderCompileOptions,
  transform: DisplayTransform,
): ResolvedZoomTarget {
  if (target.kind === "rect") return targetViewport(globalRectToOutput(target.rect, transform), scale, options);
  if (target.kind === "point") return pointViewport(globalPointToOutput(target.point, transform), scale, options);
  if (target.kind === "cursor") {
    const cursor = findCursorAtTime(
      events.filter((event) => event.type !== "cursor.sample" || event.displayId === transform.displayId),
      sourceTimeUs,
      target.sampling,
    );
    if (cursor !== null && cursor.visible) {
      return pointViewport(globalPointToOutput(cursor.position, transform), scale, options);
    }
  } else if (target.kind === "window") {
    const window = findWindowAtTime(events, target.selector, sourceTimeUs);
    if (window !== null) {
      return targetViewport(globalRectToOutput(window.bounds, transform), scale, options, target.paddingPx);
    }
  } else {
    const input = findFocusedInputAtTime(events, sourceTimeUs);
    if (input !== null) {
      return targetViewport(globalRectToOutput(input.bounds, transform), scale, options, target.paddingPx);
    }
  }
  throw new UnsatisfiedRenderTargetError(target, sourceTimeUs);
}

function zoomScaleAt(
  sourceTimeUs: number,
  zoom: EditPlanV1["zooms"][number],
): number {
  const enterEndUs = zoom.range.startUs + zoom.enterDurationUs;
  const exitStartUs = zoom.range.endUs - zoom.exitDurationUs;
  if (zoom.enterDurationUs > 0 && sourceTimeUs < enterEndUs) {
    return 1 + (zoom.scale - 1) * ((sourceTimeUs - zoom.range.startUs) / zoom.enterDurationUs);
  }
  if (zoom.exitDurationUs > 0 && sourceTimeUs > exitStartUs) {
    return 1 + (zoom.scale - 1) * ((zoom.range.endUs - sourceTimeUs) / zoom.exitDurationUs);
  }
  return zoom.scale;
}

function keyframeSourceTimes(
  part: SourceInterval,
  zoom: EditPlanV1["zooms"][number],
): readonly number[] {
  const candidates = [
    part.startUs,
    zoom.range.startUs + zoom.enterDurationUs,
    zoom.range.endUs - zoom.exitDurationUs,
    part.endUs,
  ];
  return [...new Set(candidates.filter((timeUs) => timeUs >= part.startUs && timeUs <= part.endUs))]
    .sort((left, right) => left - right);
}

export function compileRenderPlan(
  manifestInput: RecordingManifestV1,
  planInput: EditPlanV1,
  events: readonly RecordingEventV1[],
  options: RenderCompileOptions,
): RenderPlanV1 {
  const manifest = RecordingManifestV1Schema.parse(manifestInput);
  const plan = EditPlanV1Schema.parse(planInput);
  if (manifest.recordingId !== plan.recordingId) throw new Error("Edit plan belongs to a different recording.");
  if (manifest.timeline.durationUs !== plan.sourceDurationUs) {
    throw new Error("Edit plan source duration differs from its recording manifest.");
  }
  if (
    !Number.isSafeInteger(options.pixelWidth)
    || options.pixelWidth <= 0
    || options.pixelWidth > 16_384
    || !Number.isSafeInteger(options.pixelHeight)
    || options.pixelHeight <= 0
    || options.pixelHeight > 16_384
    || options.pixelWidth * options.pixelHeight > 134_217_728
    || !Number.isFinite(options.frameRate)
    || options.frameRate <= 0
    || options.frameRate > 240
  ) {
    throw new RangeError("Invalid render output dimensions or frame rate.");
  }

  const timeMap = buildSourceTimeMap(plan);
  const displayTrack = manifest.tracks.find((track) => track.trackId === options.displayTrackId);
  if (displayTrack?.kind !== "display-video") throw new Error("displayTrackId must select a display-video track.");
  const display = manifest.sources.displays.find(({ displayId }) => displayId === displayTrack.source.displayId);
  if (display === undefined) throw new Error("Selected display track has no source inventory entry.");
  const audioTrackIdSet = new Set(options.audioTrackIds);
  for (const trackId of audioTrackIdSet) {
    const track = manifest.tracks.find((candidate) => candidate.trackId === trackId);
    if (track === undefined || (track.kind !== "system-audio" && track.kind !== "microphone-audio")) {
      throw new Error(`Audio selection contains a non-audio track: ${trackId}`);
    }
  }
  const camera = options.camera;
  const selectedTrackIds = new Set<TrackId>([
    options.displayTrackId,
    ...options.audioTrackIds,
  ]);
  const transform: DisplayTransform = {
    bounds: display.bounds,
    displayId: display.displayId,
    outputScaleX: options.pixelWidth / display.pixelSize.width,
    outputScaleY: options.pixelHeight / display.pixelSize.height,
    scaleFactor: display.scaleFactor,
  };
  const sourceSegments = manifest.tracks.filter(({ trackId }) => selectedTrackIds.has(trackId))
    .flatMap((track) => track.segments.flatMap((segment) => {
      const integrity = segment.integrity;
      if (integrity.state !== "verified" || integrity.bytes <= 0) {
        throw new Error(`Render source segment ${segment.segmentId} has not passed integrity verification.`);
      }
      return mapSourceInterval(timeMap, { startUs: segment.startUs, endUs: segment.endUs })
        .map(({ source, output }) => ({
          bytes: integrity.bytes,
          codec: segment.codec,
          container: segment.container,
          containerTrackIdentity: segment.containerTrackIdentity,
          kind: track.kind,
          output,
          path: segment.path,
          sha256: integrity.sha256,
          source,
          streamIndex: segment.streamIndex,
          trackId: track.trackId,
        }));
    }));

  const cameraKeyframes = plan.zooms.filter((zoom) => zoom.displayId === display.displayId)
    .flatMap((zoom) => mapSourceInterval(timeMap, zoom.range).flatMap(({ source }) => (
    keyframeSourceTimes(source, zoom).map((sourceTimeUs) => {
      const outputTimeUs = sourceToOutputUs(timeMap, sourceTimeUs);
      if (outputTimeUs === null) throw new UnsatisfiedRenderTargetError(zoom.target, sourceTimeUs);
      const target = resolveTarget(
        zoom.target,
        sourceTimeUs,
        zoomScaleAt(sourceTimeUs, zoom),
        events,
        options,
        transform,
      );
      return {
        easing: zoom.easing,
        outputTimeUs,
        scale: target.scale,
        sourceTimeUs,
        viewport: target.viewport,
        zoomId: zoom.zoomId,
      };
    })
  ))).sort((left, right) => left.outputTimeUs - right.outputTimeUs || left.zoomId.localeCompare(right.zoomId));

  const overlays = plan.overlays.flatMap((operation) => {
    const mapped = mapSourceInterval(timeMap, operation.range);
    const first = mapped[0];
    const last = mapped.at(-1);
    if (first === undefined || last === undefined) return [];
    // An overlay is an output-timeline layer. Speed and keep boundaries split
    // source media, but all retained pieces of one continuous overlay range
    // abut after cuts are removed. Coalescing them preserves one playback and
    // entrance/exit clock instead of restarting the asset at every boundary.
    return [{
      operation,
      output: { endUs: last.output.endUs, startUs: first.output.startUs },
    }];
  });

  const cursorSamples = plan.effects.cursor.enabled
    ? smoothAndDownsampleCursor(events, {
        minDistancePx: 0.5,
        minIntervalUs: Math.max(1, Math.round(1_000_000 / options.frameRate)),
        strength: plan.effects.cursor.smoothing.algorithm === "none"
          ? 0
          : plan.effects.cursor.smoothing.strength,
      }).filter((sample) => sample.displayId === display.displayId).flatMap((sample) => {
        const outputTimeUs = sourceToOutputUs(timeMap, sample.sourceTimeUs);
        return outputTimeUs === null ? [] : [{
          coordinateSpace: "output-pixels" as const,
          displayId: sample.displayId,
          outputTimeUs,
          position: globalPointToOutput(sample.position, transform),
          sourceTimeUs: sample.sourceTimeUs,
          visible: sample.visible,
        }];
      })
    : [];

  const typingSpans: RenderTypingSpan[] = [];
  if (plan.effects.typedText.enabled) {
    for (const span of deriveTypingSpans(events, plan.effects.typedText.idleTimeoutUs)) {
      for (const { source, output } of mapSourceInterval(timeMap, { startUs: span.startUs, endUs: span.endUs })) {
        const spanWindow = findWindowAtTime(events, { kind: "window-id", windowId: span.windowId }, span.startUs);
        if (spanWindow !== null && spanWindow.displayId !== display.displayId) continue;
        const renderedBounds = tryGlobalRectToOutput(span.bounds, transform);
        if (renderedBounds === null) continue;
        if (span.secure) {
          typingSpans.push({
            bounds: renderedBounds,
            endOutputUs: output.endUs,
            endSourceUs: source.endUs,
            fieldId: "[REDACTED]",
            secure: true,
            startOutputUs: output.startUs,
            startSourceUs: source.startUs,
            state: "hidden",
            windowId: span.windowId,
          });
          continue;
        }
        const updates = span.updates.flatMap((update) => {
          if (update.sourceTimeUs < source.startUs || update.sourceTimeUs >= source.endUs) return [];
          const outputTimeUs = sourceToOutputUs(timeMap, update.sourceTimeUs);
          const bounds = tryGlobalRectToOutput(update.bounds, transform);
          return outputTimeUs === null || bounds === null ? [] : [{
            ...update,
            bounds,
            coordinateSpace: "output-pixels" as const,
            outputTimeUs,
          }];
        });
        if (updates.length > 0) {
          typingSpans.push({
            endOutputUs: output.endUs,
            endSourceUs: source.endUs,
            fieldId: span.fieldId,
            secure: false,
            startOutputUs: output.startUs,
            startSourceUs: source.startUs,
            updates,
            windowId: span.windowId,
          });
        }
      }
    }
  }

  const clickCues = plan.effects.clicks.enabled
    ? events.flatMap((event) => {
        if (event.type !== "mouse.click" || event.displayId !== display.displayId) return [];
        const outputTimeUs = sourceToOutputUs(timeMap, event.sourceTimeUs);
        return outputTimeUs === null ? [] : [{
          button: event.button,
          clickCount: event.clickCount,
          coordinateSpace: "output-pixels" as const,
          displayId: event.displayId,
          outputTimeUs,
          phase: event.phase,
          position: globalPointToOutput(event.position, transform),
          sourceTimeUs: event.sourceTimeUs,
        }];
      })
    : [];

  const keystrokeCues = plan.effects.keystrokes.enabled
    ? events.flatMap((event) => {
        if (event.type !== "key.activity") return [];
        const outputTimeUs = sourceToOutputUs(timeMap, event.sourceTimeUs);
        if (outputTimeUs === null) return [];
        const activity = event.activity.kind === "printable"
          ? { kind: "printable" as const, token: "[PRINTABLE]" as const }
          : event.activity.kind === "shortcut"
            ? { keyCode: event.activity.keyCode, kind: "shortcut" as const, modifiers: event.activity.modifiers }
            : { control: event.activity.control, kind: "control" as const, modifiers: event.activity.modifiers };
        return [{
          activity,
          outputTimeUs,
          phase: event.activity.phase,
          repeat: event.activity.repeat,
          sourceTimeUs: event.sourceTimeUs,
        }];
      })
    : [];

  return RenderPlanV1Schema.parse({
    cameraKeyframes,
    composition: {
      audioTrackIds: [...options.audioTrackIds],
      baseDisplay: { displayId: display.displayId, trackId: displayTrack.trackId },
      camera,
      globalToOutput: {
        displayBoundsPoints: display.bounds,
        displayScaleFactor: display.scaleFactor,
        outputScaleX: transform.outputScaleX,
        outputScaleY: transform.outputScaleY,
        sourceSpace: "global-display-points",
        targetSpace: "output-pixels",
      },
    },
    effects: {
      clickCues,
      clicks: plan.effects.clicks,
      cursor: plan.effects.cursor,
      cursorSamples,
      keystrokes: plan.effects.keystrokes,
      keystrokeCues,
      typedText: plan.effects.typedText,
      typingSpans,
    },
    kind: "atet.render-plan",
    output: {
      durationUs: timeMap.durationUs,
      frameRate: options.frameRate,
      pixelHeight: options.pixelHeight,
      pixelWidth: options.pixelWidth,
    },
    overlays,
    planSha256: hashEditPlan(plan),
    recordingId: manifest.recordingId,
    schemaVersion: 1,
    sourceSegments,
    timeMap: timeMap.segments,
  });
}
