import {
  ProjectEditPlanV1Schema,
  ProjectCameraKeyframeSchema,
  RecordingEventV1Schema,
  RecordingManifestV1Schema,
  RenderEffectsSchema,
  VideoProjectV1Schema,
  type Point,
  type ProjectCameraKeyframe,
  type ProjectCameraSegment,
  type ProjectEditPlanV1,
  type ProjectPlacementV1,
  type ProjectRenderPlanV1,
  type RecordingEventV1,
  type RecordingManifestV1,
  type Rect,
  type RenderEffects,
  type SourceInterval,
  type VideoProjectV1,
  type ZoomOperation,
} from "../contracts";
import {
  deriveTypingSpans,
  findCursorAtTime,
  findFocusedInputAtTime,
  findWindowAtTime,
  smoothAndDownsampleCursor,
} from "./events";
import {
  assertProjectCameraSpatialLayerGeometry,
  buildProjectCameraSpatialIndex,
  evaluateProjectCameraSpatialViewportAt,
  projectCameraSpatialLayer,
  projectCameraSpatialLayerAtOutputTime,
  type ProjectCameraSpatialIndex,
} from "./project-camera-spatial";
import {
  assetToProjectUs,
  mapAssetIntervalToProjectSlices,
  mapProjectIntervalToOutputSlices,
  projectToAssetUs,
  projectToOutputUs,
  type ProjectOutputTimeMap,
} from "./project-time";

export interface ProjectMetadataContext {
  readonly events: readonly RecordingEventV1[];
  readonly manifest: RecordingManifestV1;
  readonly placementId: ProjectPlacementV1["placementId"];
}

export interface CompiledProjectMetadata {
  readonly cameraKeyframes: ProjectRenderPlanV1["cameraKeyframes"];
  readonly effects: ProjectRenderPlanV1["effects"];
}

type EnabledVideoPresentation = Extract<
  ProjectPlacementV1["video"][number]["presentation"],
  { readonly enabled: true }
>;

export interface ProjectMetadataSourceLayer {
  readonly display: RecordingManifestV1["sources"]["displays"][number];
  readonly presentation: EnabledVideoPresentation;
  readonly stream: Extract<
    VideoProjectV1["assets"][number]["streams"][number],
    { readonly kind: "video" }
  >;
}

export interface ResolvedProjectMetadataSourceLayer
  extends ProjectMetadataSourceLayer {
  readonly track: Extract<
    RecordingManifestV1["tracks"][number],
    { readonly kind: "display-video" }
  >;
}

interface PixelLayout {
  readonly height: number;
  readonly width: number;
  readonly x: number;
  readonly y: number;
}

interface DisplayLayer extends ProjectMetadataSourceLayer {
  readonly layout: PixelLayout;
  readonly placement: ProjectPlacementV1;
}

interface ValidatedMetadataContext {
  readonly events: readonly RecordingEventV1[];
  readonly layers: ReadonlyMap<string, DisplayLayer>;
  readonly manifest: RecordingManifestV1;
  readonly placement: ProjectPlacementV1;
}

interface AssetOutputSlice {
  readonly asset: SourceInterval;
  readonly output: SourceInterval;
  readonly project: SourceInterval;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function pointInRect(point: Point, rect: Rect): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.width
    && point.y >= rect.y && point.y <= rect.y + rect.height;
}

function intersectRect(left: Rect, right: Rect): Rect | null {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const rightEdge = Math.min(left.x + left.width, right.x + right.width);
  const bottomEdge = Math.min(left.y + left.height, right.y + right.height);
  return rightEdge > x && bottomEdge > y
    ? { height: bottomEdge - y, width: rightEdge - x, x, y }
    : null;
}

function layoutPixels(
  presentation: EnabledVideoPresentation,
  outputWidth: number,
  outputHeight: number,
): PixelLayout {
  const value = presentation.layout.kind === "output-pixels"
    ? presentation.layout
    : {
        height: presentation.layout.height * outputHeight,
        width: presentation.layout.width * outputWidth,
        x: presentation.layout.x * outputWidth,
        y: presentation.layout.y * outputHeight,
      };
  return {
    height: Math.max(1, Math.round(value.height)),
    width: Math.max(1, Math.round(value.width)),
    x: Math.round(value.x),
    y: Math.round(value.y),
  };
}

function streamIdForTrack(trackId: string): string {
  return `stream_${trackId.slice("track_".length)}`;
}

/**
 * Resolves the one immutable recording track that owns a display layer in a
 * project placement. A display-only zoom cannot safely persist a hidden track
 * choice, so multiple eligible tracks are rejected instead of picking one by
 * array order.
 */
export function resolveProjectMetadataSourceLayer(
  manifest: RecordingManifestV1,
  asset: VideoProjectV1["assets"][number],
  placement: ProjectPlacementV1,
  displayId: string,
): ResolvedProjectMetadataSourceLayer | null {
  if (asset.source.kind !== "recording") return null;
  const display = manifest.sources.displays.find(
    candidate => candidate.displayId === displayId,
  );
  if (display === undefined) return null;
  const candidates: ResolvedProjectMetadataSourceLayer[] = [];
  for (const track of manifest.tracks) {
    if (
      !track.enabled
      || track.kind !== "display-video"
      || track.source.displayId !== displayId
      || !asset.source.trackIds.includes(track.trackId)
    ) {
      continue;
    }
    const streamId = streamIdForTrack(track.trackId);
    const stream = asset.streams.find(
      candidate => candidate.streamId === streamId,
    );
    const configured = placement.video.find(
      candidate => candidate.streamId === streamId,
    );
    if (
      stream?.kind !== "video"
      || configured?.presentation.enabled !== true
    ) {
      continue;
    }
    candidates.push({
      display,
      presentation: configured.presentation,
      stream,
      track,
    });
  }
  if (candidates.length > 1) {
    throw new TypeError(
      `Display ${displayId} resolves to multiple enabled recording video layers.`,
    );
  }
  return candidates[0] ?? null;
}

function requiredMetadataDisplayIds(
  plan: ProjectEditPlanV1,
  placementId: ProjectPlacementV1["placementId"],
  events: readonly RecordingEventV1[],
  manifest: RecordingManifestV1,
): ReadonlySet<string> {
  const required = new Set(
    plan.zooms
      .filter(zoom => zoom.placementId === placementId)
      .map(zoom => zoom.operation.displayId),
  );
  if (plan.effects.metadataPlacementId !== placementId) return required;
  if (plan.effects.cursor.enabled) {
    for (const event of events) {
      if (event.type === "cursor.sample") required.add(event.displayId);
    }
  }
  if (plan.effects.clicks.enabled) {
    for (const event of events) {
      if (event.type === "mouse.click") required.add(event.displayId);
    }
  }
  if (!plan.effects.typedText.enabled) return required;
  const typingWindowIds = new Set<string>();
  const typingBounds: Rect[] = [];
  for (const event of events) {
    if (event.type === "typing.input") {
      typingWindowIds.add(event.input.windowId);
      typingBounds.push(event.input.bounds);
    }
    if (event.type === "focus.changed" && event.target.kind !== "none") {
      typingWindowIds.add(event.target.windowId);
      typingBounds.push(event.target.bounds);
    }
  }
  for (const event of events) {
    if (event.type === "window.snapshot") {
      for (const window of event.windows) {
        if (typingWindowIds.has(window.windowId)) {
          required.add(window.displayId);
        }
      }
    }
    if (
      event.type === "window.changed"
      && event.change.kind !== "destroyed"
      && typingWindowIds.has(event.change.window.windowId)
    ) {
      required.add(event.change.window.displayId);
    }
  }
  for (const bounds of typingBounds) {
    for (const display of manifest.sources.displays) {
      if (intersectRect(bounds, display.bounds) !== null) {
        required.add(display.displayId);
      }
    }
  }
  return required;
}

function validateContext(
  project: VideoProjectV1,
  plan: ProjectEditPlanV1,
  input: ProjectMetadataContext,
  outputWidth: number,
  outputHeight: number,
): ValidatedMetadataContext {
  const manifest = RecordingManifestV1Schema.parse(input.manifest);
  const events = input.events.map(event => RecordingEventV1Schema.parse(event));
  const placement = project.placements.find(candidate => candidate.placementId === input.placementId);
  if (placement === undefined) throw new TypeError(`Metadata context references unknown placement ${input.placementId}.`);
  const asset = project.assets.find(candidate => candidate.assetId === placement.assetId);
  if (asset?.source.kind !== "recording" || asset.source.recordingId !== manifest.recordingId) {
    throw new TypeError(`Placement ${placement.placementId} is not backed by recording ${manifest.recordingId}.`);
  }
  const layers = new Map<string, DisplayLayer>();
  for (const displayId of requiredMetadataDisplayIds(
    plan,
    placement.placementId,
    events,
    manifest,
  )) {
    const source = resolveProjectMetadataSourceLayer(
      manifest,
      asset,
      placement,
      displayId,
    );
    if (source === null) continue;
    layers.set(displayId, {
      ...source,
      layout: layoutPixels(source.presentation, outputWidth, outputHeight),
      placement,
    });
  }
  return { events, layers, manifest, placement };
}

function sourceCropGeometry(layer: ProjectMetadataSourceLayer): {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
} {
  const crop = layer.presentation.crop;
  return {
    height: layer.stream.pixelHeight * (
      crop.kind === "none" ? 1 : 1 - crop.top - crop.bottom
    ),
    left: crop.kind === "none" ? 0 : crop.left * layer.stream.pixelWidth,
    top: crop.kind === "none" ? 0 : crop.top * layer.stream.pixelHeight,
    width: layer.stream.pixelWidth * (
      crop.kind === "none" ? 1 : 1 - crop.left - crop.right
    ),
  };
}

function visibleRawPoint(
  point: Point,
  layer: ProjectMetadataSourceLayer,
): Point {
  if (!pointInRect(point, layer.display.bounds)) {
    throw new TypeError(`Metadata point is outside display ${layer.display.displayId}.`);
  }
  const raw = {
    x: (point.x - layer.display.bounds.x) * layer.display.scaleFactor,
    y: (point.y - layer.display.bounds.y) * layer.display.scaleFactor,
  };
  const geometry = sourceCropGeometry(layer);
  if (
    raw.x < geometry.left
    || raw.x > geometry.left + geometry.width
    || raw.y < geometry.top
    || raw.y > geometry.top + geometry.height
  ) {
    throw new TypeError(`Metadata point is cropped out of display ${layer.display.displayId}.`);
  }
  return raw;
}

function visibleRawRect(
  rect: Rect,
  layer: ProjectMetadataSourceLayer,
): Rect {
  const clippedToDisplay = intersectRect(rect, layer.display.bounds);
  if (clippedToDisplay === null) {
    throw new TypeError(`Metadata rectangle misses display ${layer.display.displayId}.`);
  }
  const raw = {
    height: clippedToDisplay.height * layer.display.scaleFactor,
    width: clippedToDisplay.width * layer.display.scaleFactor,
    x: (clippedToDisplay.x - layer.display.bounds.x) * layer.display.scaleFactor,
    y: (clippedToDisplay.y - layer.display.bounds.y) * layer.display.scaleFactor,
  };
  const geometry = sourceCropGeometry(layer);
  const visible = intersectRect(raw, {
    height: geometry.height,
    width: geometry.width,
    x: geometry.left,
    y: geometry.top,
  });
  if (visible === null) {
    throw new TypeError(`Metadata rectangle is cropped out of ${layer.display.displayId}.`);
  }
  return visible;
}

/**
 * Rejects static zoom targets that cannot be resolved from the selected
 * display layer. Render planning calls the same source-visibility helpers,
 * so committing an edit cannot defer a known display/crop failure to render.
 */
export function assertStaticProjectZoomTargetVisible(
  target: Extract<
    ZoomOperation["target"],
    { readonly kind: "point" | "rect" }
  >,
  layer: ProjectMetadataSourceLayer,
): void {
  if (target.kind === "point") {
    visibleRawPoint(target.point, layer);
    return;
  }
  visibleRawRect(target.rect, layer);
}

function cropGeometry(layer: DisplayLayer): {
  readonly height: number;
  readonly left: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly top: number;
  readonly translatedX: number;
  readonly translatedY: number;
  readonly width: number;
} {
  const { height, left, top, width } = sourceCropGeometry(layer);
  if (layer.presentation.fit === "fill") {
    return {
      height,
      left,
      scaleX: layer.layout.width / width,
      scaleY: layer.layout.height / height,
      top,
      translatedX: 0,
      translatedY: 0,
      width,
    };
  }
  const scale = layer.presentation.fit === "contain"
    ? Math.min(layer.layout.width / width, layer.layout.height / height)
    : Math.max(layer.layout.width / width, layer.layout.height / height);
  return {
    height,
    left,
    scaleX: scale,
    scaleY: scale,
    top,
    translatedX: (layer.layout.width - width * scale) / 2,
    translatedY: (layer.layout.height - height * scale) / 2,
    width,
  };
}

function globalPointToLayer(point: Point, layer: DisplayLayer): Point {
  const raw = visibleRawPoint(point, layer);
  const geometry = cropGeometry(layer);
  const mapped = {
    x: (raw.x - geometry.left) * geometry.scaleX + geometry.translatedX,
    y: (raw.y - geometry.top) * geometry.scaleY + geometry.translatedY,
  };
  if (!pointInRect(mapped, { height: layer.layout.height, width: layer.layout.width, x: 0, y: 0 })) {
    throw new TypeError(`Metadata point is outside the visible layer for ${layer.display.displayId}.`);
  }
  return mapped;
}

function globalRectToLayer(rect: Rect, layer: DisplayLayer): Rect {
  const visibleRaw = visibleRawRect(rect, layer);
  const geometry = cropGeometry(layer);
  const mapped = {
    height: visibleRaw.height * geometry.scaleY,
    width: visibleRaw.width * geometry.scaleX,
    x: (visibleRaw.x - geometry.left) * geometry.scaleX + geometry.translatedX,
    y: (visibleRaw.y - geometry.top) * geometry.scaleY + geometry.translatedY,
  };
  const clippedToLayer = intersectRect(mapped, { height: layer.layout.height, width: layer.layout.width, x: 0, y: 0 });
  if (clippedToLayer === null) throw new TypeError(`Metadata rectangle is outside ${layer.display.displayId}'s layer.`);
  return clippedToLayer;
}

function targetViewport(target: Rect, scale: number, layer: DisplayLayer, paddingPx = 0): Rect {
  const aspect = layer.layout.width / layer.layout.height;
  const requestedWidth = layer.layout.width / scale;
  const paddedWidth = Math.min(layer.layout.width, target.width + paddingPx * 2);
  const paddedHeight = Math.min(layer.layout.height, target.height + paddingPx * 2);
  const width = Math.min(layer.layout.width, Math.max(requestedWidth, paddedWidth, paddedHeight * aspect));
  const height = width / aspect;
  return {
    height,
    width,
    x: clamp(target.x + target.width / 2 - width / 2, 0, layer.layout.width - width),
    y: clamp(target.y + target.height / 2 - height / 2, 0, layer.layout.height - height),
  };
}

function resolveZoomTarget(
  operation: ZoomOperation,
  assetTimeUs: number,
  scale: number,
  context: ValidatedMetadataContext,
  layer: DisplayLayer,
): Rect {
  const target = operation.target;
  if (target.kind === "rect") return targetViewport(globalRectToLayer(target.rect, layer), scale, layer);
  if (target.kind === "point") {
    const point = globalPointToLayer(target.point, layer);
    return targetViewport({ height: 0, width: 0, ...point }, scale, layer);
  }
  if (target.kind === "cursor") {
    const cursor = findCursorAtTime(
      context.events.filter(event => event.type !== "cursor.sample" || event.displayId === layer.display.displayId),
      assetTimeUs,
      target.sampling,
    );
    if (cursor !== null && cursor.visible) {
      const point = globalPointToLayer(cursor.position, layer);
      return targetViewport({ height: 0, width: 0, ...point }, scale, layer);
    }
  } else if (target.kind === "window") {
    const window = findWindowAtTime(context.events, target.selector, assetTimeUs);
    if (window !== null && window.displayId === layer.display.displayId) {
      return targetViewport(globalRectToLayer(window.bounds, layer), scale, layer, target.paddingPx);
    }
  } else {
    const input = findFocusedInputAtTime(context.events, assetTimeUs);
    if (input !== null) {
      return targetViewport(globalRectToLayer(input.bounds, layer), scale, layer, target.paddingPx);
    }
  }
  throw new TypeError(`Cannot resolve ${target.kind} zoom target at asset time ${assetTimeUs}.`);
}

function zoomScaleAt(projectTimeUs: number, zoom: ZoomOperation): number {
  const enterEndUs = zoom.range.startUs + zoom.enterDurationUs;
  const exitStartUs = zoom.range.endUs - zoom.exitDurationUs;
  if (zoom.enterDurationUs > 0 && projectTimeUs < enterEndUs) {
    return 1 + (zoom.scale - 1) * ((projectTimeUs - zoom.range.startUs) / zoom.enterDurationUs);
  }
  if (zoom.exitDurationUs > 0 && projectTimeUs > exitStartUs) {
    return 1 + (zoom.scale - 1) * ((zoom.range.endUs - projectTimeUs) / zoom.exitDurationUs);
  }
  return zoom.scale;
}

function zoomProjectTimes(part: SourceInterval, zoom: ZoomOperation): readonly number[] {
  return [...new Set([
    part.startUs,
    zoom.range.startUs + zoom.enterDurationUs,
    zoom.range.endUs - zoom.exitDurationUs,
    part.endUs,
  ].filter(timeUs => timeUs >= part.startUs && timeUs <= part.endUs))]
    .sort((left, right) => left - right);
}

function compileCameraKeyframes(
  plan: ProjectEditPlanV1,
  contexts: ReadonlyMap<string, ValidatedMetadataContext>,
  outputMap: ProjectOutputTimeMap,
): readonly ProjectCameraKeyframe[] {
  const keyframes = new Map<string, ProjectCameraKeyframe>();
  for (const configured of plan.zooms) {
    const context = contexts.get(configured.placementId);
    if (context === undefined) {
      throw new TypeError(`Zoom ${configured.operation.zoomId} requires metadata for ${configured.placementId}.`);
    }
    const layer = context.layers.get(configured.operation.displayId);
    if (layer === undefined) {
      throw new TypeError(`Zoom ${configured.operation.zoomId} selects an unavailable display layer.`);
    }
    for (const slice of mapProjectIntervalToOutputSlices(outputMap, configured.operation.range)) {
      for (const projectTimeUs of zoomProjectTimes(slice.project, configured.operation)) {
        const outputTimeUs = projectToOutputUs(outputMap, projectTimeUs);
        const assetTimeUs = projectToAssetUs(context.placement.sync, projectTimeUs);
        if (outputTimeUs === null || assetTimeUs === null) {
          throw new TypeError(`Zoom ${configured.operation.zoomId} cannot map its project clock.`);
        }
        const viewport = resolveZoomTarget(
          configured.operation,
          assetTimeUs,
          zoomScaleAt(projectTimeUs, configured.operation),
          context,
          layer,
        );
        const keyframe = {
          displayId: layer.display.displayId,
          easing: configured.operation.easing,
          layerPixelHeight: layer.layout.height,
          layerPixelWidth: layer.layout.width,
          outputTimeUs,
          placementId: context.placement.placementId,
          scale: layer.layout.width / viewport.width,
          sourceTimeUs: assetTimeUs,
          streamId: layer.stream.streamId,
          viewport,
          zoomId: configured.operation.zoomId,
        } satisfies ProjectCameraKeyframe;
        keyframes.set(
          `${keyframe.placementId}:${keyframe.streamId}:${keyframe.zoomId}:${keyframe.outputTimeUs}`,
          keyframe,
        );
      }
    }
  }
  return [...keyframes.values()].sort((left, right) => (
    left.outputTimeUs - right.outputTimeUs
    || left.placementId.localeCompare(right.placementId)
    || left.streamId.localeCompare(right.streamId)
    || left.zoomId.localeCompare(right.zoomId)
  ));
}

function cameraViewportAt(
  layer: DisplayLayer,
  outputTimeUs: number,
  camera: ProjectCameraSpatialIndex,
): Rect {
  return evaluateProjectCameraSpatialViewportAt(
    projectCameraSpatialLayerAtOutputTime(
      projectCameraSpatialLayer(
        camera,
        layer.placement.placementId,
        layer.stream.streamId,
      ),
      outputTimeUs,
    ),
    {
      outputTimeUs,
      pixelHeight: layer.layout.height,
      pixelWidth: layer.layout.width,
    },
  );
}

function layerPointToOutput(
  point: Point,
  layer: DisplayLayer,
  outputTimeUs: number,
  camera: ProjectCameraSpatialIndex,
): Point {
  const viewport = cameraViewportAt(
    layer,
    outputTimeUs,
    camera,
  );
  return {
    x: layer.layout.x + (point.x - viewport.x) * layer.layout.width / viewport.width,
    y: layer.layout.y + (point.y - viewport.y) * layer.layout.height / viewport.height,
  };
}

function layerRectToOutput(
  rect: Rect,
  layer: DisplayLayer,
  outputTimeUs: number,
  camera: ProjectCameraSpatialIndex,
): Rect {
  const topLeft = layerPointToOutput(rect, layer, outputTimeUs, camera);
  const viewport = cameraViewportAt(
    layer,
    outputTimeUs,
    camera,
  );
  return {
    height: rect.height * layer.layout.height / viewport.height,
    width: rect.width * layer.layout.width / viewport.width,
    x: topLeft.x,
    y: topLeft.y,
  };
}

function outputTimeForAsset(
  placement: ProjectPlacementV1,
  outputMap: ProjectOutputTimeMap,
  assetTimeUs: number,
): number | null {
  const projectTimeUs = assetToProjectUs(placement.sync, assetTimeUs);
  return projectTimeUs === null ? null : projectToOutputUs(outputMap, projectTimeUs);
}

function assetOutputSlices(
  placement: ProjectPlacementV1,
  outputMap: ProjectOutputTimeMap,
  assetRange: SourceInterval,
): readonly AssetOutputSlice[] {
  return mapAssetIntervalToProjectSlices(placement, assetRange).flatMap(mapped => (
    mapProjectIntervalToOutputSlices(outputMap, mapped.project).flatMap((slice) => {
      const startUs = projectToAssetUs(placement.sync, slice.project.startUs);
      const endUs = projectToAssetUs(placement.sync, slice.project.endUs);
      return startUs === null || endUs === null || endUs <= startUs
        ? []
        : [{ asset: { endUs, startUs }, output: slice.output, project: slice.project }];
    })
  ));
}

function contextLayerForRect(
  context: ValidatedMetadataContext,
  rect: Rect,
  sourceTimeUs: number,
  windowId?: string,
): DisplayLayer | null {
  if (windowId !== undefined) {
    const window = findWindowAtTime(context.events, { kind: "window-id", windowId }, sourceTimeUs);
    if (window !== null) return context.layers.get(window.displayId) ?? null;
  }
  return [...context.layers.values()].find(layer => intersectRect(rect, layer.display.bounds) !== null) ?? null;
}

function compileEffects(
  plan: ProjectEditPlanV1,
  context: ValidatedMetadataContext | null,
  outputMap: ProjectOutputTimeMap,
  camera: ProjectCameraSpatialIndex,
  frameRate: number,
): RenderEffects {
  const disabledResult: RenderEffects = {
    clickCues: [],
    clicks: plan.effects.clicks,
    cursor: plan.effects.cursor,
    cursorSamples: [],
    keystrokes: plan.effects.keystrokes,
    keystrokeCues: [],
    typedText: plan.effects.typedText,
    typingSpans: [],
  };
  const enabled = plan.effects.clicks.enabled
    || plan.effects.cursor.enabled
    || plan.effects.keystrokes.enabled
    || plan.effects.typedText.enabled;
  if (!enabled) return disabledResult;
  if (context === null) throw new TypeError("Enabled project metadata effects require a recording-backed placement.");

  const cursorSamples = plan.effects.cursor.enabled
    ? smoothAndDownsampleCursor(context.events, {
        minDistancePx: 0.5,
        minIntervalUs: Math.max(1, Math.round(1_000_000 / frameRate)),
        strength: plan.effects.cursor.smoothing.algorithm === "none"
          ? 0
          : plan.effects.cursor.smoothing.strength,
      }).flatMap((sample) => {
        const outputTimeUs = outputTimeForAsset(context.placement, outputMap, sample.sourceTimeUs);
        const layer = context.layers.get(sample.displayId);
        if (outputTimeUs === null || layer === undefined) return [];
        try {
          const local = globalPointToLayer(sample.position, layer);
          return [{
            coordinateSpace: "output-pixels" as const,
            displayId: sample.displayId,
            outputTimeUs,
            position: layerPointToOutput(local, layer, outputTimeUs, camera),
            sourceTimeUs: sample.sourceTimeUs,
            visible: sample.visible,
          }];
        } catch {
          return [];
        }
      })
    : [];

  const clickCues = plan.effects.clicks.enabled
    ? context.events.flatMap((event) => {
        if (event.type !== "mouse.click") return [];
        const outputTimeUs = outputTimeForAsset(context.placement, outputMap, event.sourceTimeUs);
        const layer = context.layers.get(event.displayId);
        if (outputTimeUs === null || layer === undefined) return [];
        try {
          const local = globalPointToLayer(event.position, layer);
          return [{
            button: event.button,
            clickCount: event.clickCount,
            coordinateSpace: "output-pixels" as const,
            displayId: event.displayId,
            outputTimeUs,
            phase: event.phase,
            position: layerPointToOutput(local, layer, outputTimeUs, camera),
            sourceTimeUs: event.sourceTimeUs,
          }];
        } catch {
          return [];
        }
      })
    : [];

  const keystrokeCues = plan.effects.keystrokes.enabled
    ? context.events.flatMap((event) => {
        if (event.type !== "key.activity") return [];
        const outputTimeUs = outputTimeForAsset(context.placement, outputMap, event.sourceTimeUs);
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

  const typingSpans: RenderEffects["typingSpans"][number][] = [];
  if (plan.effects.typedText.enabled) {
    for (const span of deriveTypingSpans(context.events, plan.effects.typedText.idleTimeoutUs)) {
      const clipped = {
        endUs: Math.min(span.endUs, context.placement.assetRange.endUs),
        startUs: Math.max(span.startUs, context.placement.assetRange.startUs),
      };
      if (clipped.endUs <= clipped.startUs) continue;
      for (const slice of assetOutputSlices(context.placement, outputMap, clipped)) {
        const layer = contextLayerForRect(context, span.bounds, slice.asset.startUs, span.windowId);
        if (layer === null) continue;
        let renderedBounds: Rect;
        try {
          renderedBounds = layerRectToOutput(
            globalRectToLayer(span.bounds, layer),
            layer,
            slice.output.startUs,
            camera,
          );
        } catch {
          continue;
        }
        if (span.secure) {
          typingSpans.push({
            bounds: renderedBounds,
            endOutputUs: slice.output.endUs,
            endSourceUs: slice.asset.endUs,
            fieldId: "[REDACTED]",
            secure: true,
            startOutputUs: slice.output.startUs,
            startSourceUs: slice.asset.startUs,
            state: "hidden",
            windowId: span.windowId,
          });
          continue;
        }
        const preceding = [...span.updates].reverse().find(update => update.sourceTimeUs <= slice.asset.startUs);
        const selected = [
          ...(preceding === undefined ? [] : [{ ...preceding, sourceTimeUs: slice.asset.startUs }]),
          ...span.updates.filter(update => (
            update.sourceTimeUs >= slice.asset.startUs && update.sourceTimeUs < slice.asset.endUs
          )),
        ];
        const unique = new Map<number, typeof selected[number]>();
        for (const update of selected) unique.set(update.sourceTimeUs, update);
        const updates = [...unique.values()].flatMap((update) => {
          const outputTimeUs = outputTimeForAsset(context.placement, outputMap, update.sourceTimeUs);
          const updateLayer = contextLayerForRect(context, update.bounds, update.sourceTimeUs, span.windowId) ?? layer;
          if (outputTimeUs === null) return [];
          try {
            return [{
              bounds: layerRectToOutput(
                globalRectToLayer(update.bounds, updateLayer),
                updateLayer,
                outputTimeUs,
                camera,
              ),
              coordinateSpace: "output-pixels" as const,
              outputTimeUs,
              sourceTimeUs: update.sourceTimeUs,
              text: update.text,
            }];
          } catch {
            return [];
          }
        });
        if (updates.length > 0) {
          typingSpans.push({
            endOutputUs: slice.output.endUs,
            endSourceUs: slice.asset.endUs,
            fieldId: span.fieldId,
            secure: false,
            startOutputUs: slice.output.startUs,
            startSourceUs: slice.asset.startUs,
            updates,
            windowId: span.windowId,
          });
        }
      }
    }
  }

  return {
    ...disabledResult,
    clickCues,
    cursorSamples,
    keystrokeCues,
    typingSpans,
  };
}

export function compileProjectMetadata(
  projectInput: VideoProjectV1,
  planInput: ProjectEditPlanV1,
  outputMap: ProjectOutputTimeMap,
  inputs: readonly ProjectMetadataContext[],
  settings: { readonly frameRate: number; readonly pixelHeight: number; readonly pixelWidth: number },
  cameraSegments: readonly ProjectCameraSegment[] = [],
): CompiledProjectMetadata {
  const project = VideoProjectV1Schema.parse(projectInput);
  const plan = ProjectEditPlanV1Schema.parse(planInput);
  const contexts = new Map<string, ValidatedMetadataContext>();
  for (const input of inputs) {
    if (contexts.has(input.placementId)) throw new TypeError(`Duplicate metadata context for ${input.placementId}.`);
    contexts.set(
      input.placementId,
      validateContext(
        project,
        plan,
        input,
        settings.pixelWidth,
        settings.pixelHeight,
      ),
    );
  }
  const cameraKeyframes = compileCameraKeyframes(plan, contexts, outputMap);
  const camera = buildProjectCameraSpatialIndex({
    cameraKeyframes,
    cameraSegments,
  });
  for (const context of contexts.values()) {
    for (const layer of context.layers.values()) {
      const spatialLayer = projectCameraSpatialLayer(
        camera,
        layer.placement.placementId,
        layer.stream.streamId,
      );
      assertProjectCameraSpatialLayerGeometry(
        spatialLayer,
        layer.layout.width,
        layer.layout.height,
        `${layer.placement.placementId}:${layer.stream.streamId}`,
      );
    }
  }
  const effectContext = plan.effects.metadataPlacementId === null
    ? null
    : contexts.get(plan.effects.metadataPlacementId) ?? null;
  const effects = compileEffects(
    plan,
    effectContext,
    outputMap,
    camera,
    settings.frameRate,
  );
  return {
    cameraKeyframes: ProjectCameraKeyframeSchema.array().max(100_000).parse(cameraKeyframes),
    effects: RenderEffectsSchema.parse(effects),
  };
}
