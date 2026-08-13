import { randomUUID } from "node:crypto";
import { chmod, lstat, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  RenderInvocationSchema,
  type OverlayOperation,
  type RecordingManifestV1,
  type RenderInvocation,
  type RenderPlanV1,
} from "../contracts";
import { canonicalJsonSha256 } from "../core";
import { probeVisualMediaSummary } from "./analyzer";
import { inspectPngIntrinsicSize, inspectSvgIntrinsicSize } from "./asset-ingest";
import { CliError } from "./errors";
import { MAXIMUM_FILTER_GRAPH_BYTES, materializeFilterScript } from "./filter-script";
import type { ProcessRunner } from "./io";
import {
  assertAudioLoopBufferWithinLimit,
  assertVideoLoopBufferWithinLimit,
  resolveAudibleSourceRange,
} from "./overlay-playback";
import { ensurePrivateDirectory, resolveSafePath } from "./paths";
import {
  fingerprintPhysicalProjectMedia,
  resolveVerifiedProjectMedia,
} from "./project-media-integrity";

const MAX_DERIVED_OVERLAY_BYTES = 512 * 1024 * 1024;

function seconds(microseconds: number): string {
  return (microseconds / 1_000_000).toFixed(6).replace(/0+$/u, "").replace(/\.$/u, "");
}

function decimal(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(8).replace(/0+$/u, "").replace(/\.$/u, "");
}

function inputSpecifier(index: number, streamIndex: number): string {
  return `${index}:${streamIndex}`;
}

function animatedStreamSpecifier(
  inputIndex: number,
  streamType: "a" | "v",
  absoluteStreamIndex: number | null | undefined,
): string {
  return absoluteStreamIndex === null || absoluteStreamIndex === undefined
    ? `${inputIndex}:${streamType}:0`
    : inputSpecifier(inputIndex, absoluteStreamIndex);
}

function atempo(rate: number): string {
  const filters: string[] = [];
  let remaining = rate;
  while (remaining > 100) {
    filters.push("atempo=100");
    remaining /= 100;
  }
  while (remaining < 0.5) {
    filters.push("atempo=0.5");
    remaining /= 0.5;
  }
  filters.push(`atempo=${decimal(remaining)}`);
  return filters.join(",");
}

function sourceSpeed(plan: RenderPlanV1, startUs: number, endUs: number): number {
  const mapping = plan.timeMap.find(({ source }) => source.startUs <= startUs && source.endUs >= endUs);
  if (mapping === undefined) throw new CliError("invalid-data", `Render source range ${startUs}..${endUs} has no time map.`);
  return mapping.speed;
}

function localTimes(
  manifest: RecordingManifestV1,
  segment: RenderPlanV1["sourceSegments"][number],
): readonly [number, number] {
  const source = manifestSourceSegment(manifest, segment);
  return [
    source.fileRange.startUs + segment.source.startUs - source.startUs,
    source.fileRange.startUs + segment.source.endUs - source.startUs,
  ];
}

function manifestSourceSegment(
  manifest: RecordingManifestV1,
  segment: RenderPlanV1["sourceSegments"][number],
): RecordingManifestV1["tracks"][number]["segments"][number] {
  const track = manifest.tracks.find(({ trackId }) => trackId === segment.trackId);
  const source = track?.segments.find((candidate) =>
    candidate.path === segment.path
    && candidate.streamIndex === segment.streamIndex
    && candidate.startUs <= segment.source.startUs
    && candidate.endUs >= segment.source.endUs
  );
  if (source === undefined) {
    throw new CliError("invalid-data", `Render segment ${segment.path}:${segment.streamIndex} is absent from the manifest.`);
  }
  return source;
}

type RenderEasing = RenderPlanV1["cameraKeyframes"][number]["easing"];

export interface MetadataEffectRenderPlan {
  readonly cameraKeyframes: RenderPlanV1["cameraKeyframes"];
  readonly effects: RenderPlanV1["effects"];
  readonly output: RenderPlanV1["output"];
}

function easedProgress(easing: RenderEasing, progress: string): string {
  switch (easing.kind) {
    case "linear": return progress;
    case "ease-in": return `pow(${progress},2)`;
    case "ease-out": return `1-pow(1-(${progress}),2)`;
    case "ease-in-out": return `if(lt(${progress},0.5),2*pow(${progress},2),1-pow(-2*(${progress})+2,2)/2)`;
    case "spring": return `min(1,max(0,1-exp(-6*(${progress}))*cos(8*(${progress}))))`;
    case "cubic-bezier": {
      const inverse = `(1-(${progress}))`;
      return `3*pow(${inverse},2)*(${progress})*${decimal(easing.y1)}+3*(${inverse})*pow(${progress},2)*${decimal(easing.y2)}+pow(${progress},3)`;
    }
  }
}

function interpolation(
  keyframes: readonly {
    readonly easing: RenderEasing;
    readonly outputTimeUs: number;
    readonly viewport: Readonly<Record<"height" | "width" | "x" | "y", number>>;
  }[],
  field: "height" | "width" | "x" | "y",
  fallback: number,
  timeExpression = "t",
): string {
  let expression = decimal(fallback);
  for (let index = keyframes.length - 1; index > 0; index -= 1) {
    const left = keyframes[index - 1]!;
    const right = keyframes[index]!;
    if (right.outputTimeUs <= left.outputTimeUs) continue;
    const start = seconds(left.outputTimeUs);
    const end = seconds(right.outputTimeUs);
    const leftValue = left.viewport[field];
    const delta = right.viewport[field] - leftValue;
    const progress = `((${timeExpression})-${start})/(${end}-${start})`;
    const value = delta === 0
      ? decimal(leftValue)
      : `${decimal(leftValue)}+${decimal(delta)}*(${easedProgress(right.easing, progress)})`;
    expression = `if(between(${timeExpression},${start},${end}),${value},${expression})`;
  }
  return expression;
}

function groupedZoomInterpolation(
  keyframes: RenderPlanV1["cameraKeyframes"],
  field: "height" | "width" | "x" | "y",
  fallback: number,
  timeExpression: string,
): string {
  const byZoom = new Map<string, RenderPlanV1["cameraKeyframes"][number][]>();
  for (const keyframe of keyframes) {
    const group = byZoom.get(keyframe.zoomId) ?? [];
    group.push(keyframe);
    byZoom.set(keyframe.zoomId, group);
  }
  const groups = [...byZoom.entries()].map(([zoomId, group]) => ({
    group: group.sort((left, right) => left.outputTimeUs - right.outputTimeUs),
    zoomId,
  })).sort((left, right) => (
    left.group[0]!.outputTimeUs - right.group[0]!.outputTimeUs
    || left.zoomId.localeCompare(right.zoomId)
  ));

  let expression = decimal(fallback);
  for (const { group } of groups) {
    const startUs = group[0]!.outputTimeUs;
    const endUs = group.at(-1)!.outputTimeUs;
    const local = interpolation(group, field, group.at(-1)!.viewport[field], timeExpression);
    // Zoom ranges are half-open. Grouping by zoom ID prevents interpolation
    // from bridging the unzoomed gap between two independent operations.
    const active = `gte(${timeExpression},${seconds(startUs)})*lt(${timeExpression},${seconds(endUs)})`;
    expression = `if(${active},${local},${expression})`;
  }
  return expression;
}

interface ZoomGeometryExpressions {
  readonly height: string;
  readonly width: string;
  readonly x: string;
  readonly y: string;
}

function zoomGeometryExpressions(plan: MetadataEffectRenderPlan, timeExpression = "t"): ZoomGeometryExpressions | null {
  if (plan.cameraKeyframes.length === 0) return null;
  const keyframes = [...plan.cameraKeyframes].sort((left, right) => left.outputTimeUs - right.outputTimeUs);
  return {
    height: groupedZoomInterpolation(keyframes, "height", plan.output.pixelHeight, timeExpression),
    width: groupedZoomInterpolation(keyframes, "width", plan.output.pixelWidth, timeExpression),
    x: groupedZoomInterpolation(keyframes, "x", 0, timeExpression),
    y: groupedZoomInterpolation(keyframes, "y", 0, timeExpression),
  };
}

function zoomFilter(plan: MetadataEffectRenderPlan): string | null {
  // crop's width/height are configuration-time expressions in FFmpeg, so it
  // cannot execute an animated viewport. zoompan evaluates zoom and pan for
  // every input frame; d=1 preserves the existing constant-frame-rate timeline.
  const geometry = zoomGeometryExpressions(plan, `on/${decimal(plan.output.frameRate)}`);
  if (geometry === null) return null;
  return `zoompan=z='${plan.output.pixelWidth}/(${geometry.width})':x='${geometry.x}':y='${geometry.y}':d=1:s=${plan.output.pixelWidth}x${plan.output.pixelHeight}:fps=${decimal(plan.output.frameRate)}`;
}

function zoomedSpatialCoordinate(
  plan: MetadataEffectRenderPlan,
  axis: "x" | "y",
  unzoomed: string,
): string {
  const geometry = zoomGeometryExpressions(plan);
  if (geometry === null) return unzoomed;
  const offset = axis === "x" ? geometry.x : geometry.y;
  const viewportSize = axis === "x" ? geometry.width : geometry.height;
  const outputSize = axis === "x" ? plan.output.pixelWidth : plan.output.pixelHeight;
  return `((${unzoomed})-(${offset}))*${outputSize}/(${viewportSize})`;
}

function overlayAnimationDuration(animation: OverlayOperation["entrance"]): number {
  return animation.kind === "none" ? 0 : animation.durationUs;
}

function withOverlayAnimationDuration<Animation extends OverlayOperation["entrance"]>(
  animation: Animation,
  durationUs: number,
): Animation {
  if (animation.kind === "none") return animation;
  return { ...animation, durationUs };
}

function withEffectiveOverlayAnimations(
  overlay: OverlayOperation,
  visibleDurationUs: number,
): OverlayOperation {
  const entranceUs = overlayAnimationDuration(overlay.entrance);
  const exitUs = overlayAnimationDuration(overlay.exit);
  const totalUs = entranceUs + exitUs;
  if (totalUs === 0 || totalUs <= visibleDurationUs) return overlay;
  const effectiveEntranceUs = Math.floor(visibleDurationUs * entranceUs / totalUs);
  return {
    ...overlay,
    entrance: withOverlayAnimationDuration(overlay.entrance, effectiveEntranceUs),
    exit: withOverlayAnimationDuration(overlay.exit, visibleDurationUs - effectiveEntranceUs),
  };
}

function animationScale(
  overlay: OverlayOperation,
  outputStartUs: number,
  outputEndUs: number,
): string {
  let expression = decimal(overlay.scale);
  if (overlay.entrance.kind === "scale" && overlay.entrance.durationUs > 0) {
    const start = seconds(outputStartUs);
    const end = seconds(outputStartUs + overlay.entrance.durationUs);
    const from = overlay.entrance.fromScale * overlay.scale;
    const progress = `(t-${start})/(${end}-${start})`;
    expression = `if(between(t,${start},${end}),${decimal(from)}+(${decimal(overlay.scale - from)})*(${easedProgress(overlay.entrance.easing, progress)}),${expression})`;
  }
  if (overlay.exit.kind === "scale" && overlay.exit.durationUs > 0) {
    const start = seconds(outputEndUs - overlay.exit.durationUs);
    const end = seconds(outputEndUs);
    const to = overlay.exit.fromScale * overlay.scale;
    const progress = `(t-${start})/(${end}-${start})`;
    expression = `if(between(t,${start},${end}),${decimal(overlay.scale)}+(${decimal(to - overlay.scale)})*(${easedProgress(overlay.exit.easing, progress)}),${expression})`;
  }
  const motionScale = overlayMotionExpression(overlay, "scaleMultiplier", outputStartUs, outputEndUs, 1);
  return motionScale === "1" ? expression : `(${expression})*(${motionScale})`;
}

function fadeFilters(overlay: OverlayOperation, startUs: number, endUs: number): readonly string[] {
  const opacity = overlayMotionExpression(overlay, "opacityMultiplier", startUs, endUs, 1, "T");
  const mask = overlay.mask ?? { kind: "none" as const };
  const filters = ["format=rgba"];
  if (mask.kind === "none" && opacity === "1") {
    filters.push(`colorchannelmixer=aa=${decimal(overlay.opacity)}`);
  } else {
    const radius = mask.kind === "rounded-rectangle"
      ? `min(${decimal(mask.radiusPx)},min(W/2,H/2))`
      : "0";
    const maskExpression = mask.kind === "rounded-rectangle"
      ? `gt(between(X,${radius},W-${radius})+between(Y,${radius},H-${radius})+lte(pow(X-min(max(X,${radius}),W-${radius}),2)+pow(Y-min(max(Y,${radius}),H-${radius}),2),pow(${radius},2)),0)`
      : "1";
    filters.push(
      `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*${decimal(overlay.opacity)}*(${opacity})*(${maskExpression})'`,
    );
  }
  if (overlay.entrance.kind === "fade" && overlay.entrance.durationUs > 0) {
    filters.push(`fade=t=in:st=${seconds(startUs)}:d=${seconds(overlay.entrance.durationUs)}:alpha=1`);
  }
  if (overlay.exit.kind === "fade" && overlay.exit.durationUs > 0) {
    filters.push(`fade=t=out:st=${seconds(endUs - overlay.exit.durationUs)}:d=${seconds(overlay.exit.durationUs)}:alpha=1`);
  }
  return filters;
}

type OverlayMotionField = "opacityMultiplier" | "positionX" | "positionY" | "rotationOffsetDegrees" | "scaleMultiplier";

function overlayMotionValue(
  keyframe: Extract<NonNullable<OverlayOperation["motion"]>, { readonly kind: "keyframes" }>["keyframes"][number],
  field: OverlayMotionField,
): number {
  if (field === "positionX") return keyframe.positionOffset.x;
  if (field === "positionY") return keyframe.positionOffset.y;
  return keyframe[field];
}

function overlayMotionExpression(
  overlay: OverlayOperation,
  field: OverlayMotionField,
  startUs: number,
  endUs: number,
  fallback: number,
  timeExpression = "t",
): string {
  const motion = overlay.motion ?? { kind: "none" as const };
  if (motion.kind === "none" || endUs <= startUs) return decimal(fallback);
  const keyframes = motion.keyframes;
  let expression = decimal(overlayMotionValue(keyframes.at(-1)!, field));
  for (let index = keyframes.length - 1; index > 0; index -= 1) {
    const left = keyframes[index - 1]!;
    const right = keyframes[index]!;
    const leftTimeUs = startUs + Math.round((endUs - startUs) * left.offset);
    const rightTimeUs = startUs + Math.round((endUs - startUs) * right.offset);
    if (rightTimeUs <= leftTimeUs) continue;
    const leftValue = overlayMotionValue(left, field);
    const rightValue = overlayMotionValue(right, field);
    const progress = `(${timeExpression}-${seconds(leftTimeUs)})/(${seconds(rightTimeUs)}-${seconds(leftTimeUs)})`;
    const value = leftValue === rightValue
      ? decimal(leftValue)
      : `${decimal(leftValue)}+${decimal(rightValue - leftValue)}*(${easedProgress(left.easing, progress)})`;
    expression = `if(between(${timeExpression},${seconds(leftTimeUs)},${seconds(rightTimeUs)}),${value},${expression})`;
  }
  return expression;
}

function overlayGeometryFilters(
  overlay: OverlayOperation,
  outputStartUs: number,
  outputEndUs: number,
): readonly string[] {
  const filters: string[] = [];
  const crop = overlay.crop ?? { kind: "none" as const };
  if (crop.kind === "normalized-insets") {
    filters.push(
      `crop=w='iw*${decimal(1 - crop.left - crop.right)}':h='ih*${decimal(1 - crop.top - crop.bottom)}':x='iw*${decimal(crop.left)}':y='ih*${decimal(crop.top)}'`,
    );
  }
  filters.push("format=rgba");
  if (overlay.size.kind === "pixels") {
    const width = decimal(overlay.size.width);
    const height = decimal(overlay.size.height);
    const fit = overlay.fit ?? "fill";
    if (fit === "fill") {
      filters.push(`scale=${width}:${height}`);
    } else if (fit === "contain") {
      filters.push(
        `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`,
      );
    } else {
      filters.push(
        `scale=${width}:${height}:force_original_aspect_ratio=increase`,
        `crop=${width}:${height}`,
      );
    }
  }
  const scale = animationScale(overlay, outputStartUs, outputEndUs);
  filters.push(`scale=w='iw*(${scale})':h='ih*(${scale})':eval=frame`);
  filters.push(...fadeFilters(overlay, outputStartUs, outputEndUs));
  const rotationOffset = overlayMotionExpression(overlay, "rotationOffsetDegrees", outputStartUs, outputEndUs, 0);
  const rotation = rotationOffset === "0"
    ? decimal(overlay.rotationDegrees)
    : `${decimal(overlay.rotationDegrees)}+(${rotationOffset})`;
  if (rotation !== "0") {
    filters.push(`rotate='(${rotation})*PI/180':c=none:ow=rotw(iw):oh=roth(ih)`);
  }
  return filters;
}

function anchorExpression(anchor: OverlayOperation["anchor"], axis: "x" | "y"): string {
  if (axis === "x") {
    if (anchor.endsWith("left") || anchor === "left") return "0";
    if (anchor.endsWith("right") || anchor === "right") return "W-w";
    return "(W-w)/2";
  }
  if (anchor.startsWith("top") || anchor === "top") return "0";
  if (anchor.startsWith("bottom") || anchor === "bottom") return "H-h";
  return "(H-h)/2";
}

function slideOffset(
  overlay: OverlayOperation,
  axis: "x" | "y",
  startUs: number,
  endUs: number,
): string {
  const components: string[] = [];
  for (const [animation, animationStartUs, entering] of [
    [overlay.entrance, startUs, true],
    [overlay.exit, endUs - (overlay.exit.kind === "none" ? 0 : overlay.exit.durationUs), false],
  ] as const) {
    if (animation.kind !== "slide" || animation.durationUs === 0) continue;
    const onAxis = axis === "x"
      ? animation.direction === "left" || animation.direction === "right"
      : animation.direction === "up" || animation.direction === "down";
    if (!onAxis) continue;
    const sign = animation.direction === "left" || animation.direction === "up" ? -1 : 1;
    const start = seconds(animationStartUs);
    const finish = seconds(animationStartUs + animation.durationUs);
    const startDistance = entering ? sign * animation.distancePx : 0;
    const delta = entering ? -sign * animation.distancePx : sign * animation.distancePx;
    const progress = `(t-${start})/(${finish}-${start})`;
    components.push(
      `if(between(t,${start},${finish}),${decimal(startDistance)}+${decimal(delta)}*(${easedProgress(animation.easing, progress)}),0)`,
    );
  }
  return components.length === 0 ? "0" : components.join("+");
}

function overlayPositionExpression(
  overlay: OverlayOperation,
  axis: "x" | "y",
  startUs: number,
  endUs: number,
): string {
  const field = axis === "x" ? "positionX" : "positionY";
  return `${anchorExpression(overlay.anchor, axis)}+${decimal(overlay.position[axis])}+${overlayMotionExpression(overlay, field, startUs, endUs, 0)}+${slideOffset(overlay, axis, startUs, endUs)}`;
}

const MAX_METADATA_FILTERS = 10_000;
const MAX_LOOP_VIDEO_FRAMES = 1_000_000;
const MAX_LOOP_AUDIO_SAMPLES = 10_000_000;
const MAX_METADATA_SPRITE_DIMENSION = 16_384;
const MAX_METADATA_SPRITE_AREA = 134_217_728;

function escapeDrawtext(value: string): string {
  return [...value]
    .map((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point < 32 || point === 127 ? " " : character;
    })
    .join("")
    .replaceAll("\\", "\\\\")
    .replaceAll("'", "\\'")
    .replaceAll(":", "\\:")
    .replaceAll(",", "\\,")
    .replaceAll("%", "\\%")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

function animatedVideoFilters(
  source: Extract<OverlayOperation["source"], { readonly kind: "gif" | "video" }>,
  intrinsicSize: OverlayOperation["intrinsicSize"],
  outputDurationUs: number,
  outputStartUs: number,
  frameRate: number,
): { readonly filters: readonly string[]; readonly visibleDurationUs: number } {
  const playback = source.playback;
  const availableSourceUs = playback.sourceOutUs - playback.sourceInUs;
  const requiredSourceUs = Math.ceil(outputDurationUs * playback.playbackRate);
  if (!Number.isSafeInteger(requiredSourceUs) || requiredSourceUs <= 0) {
    throw new CliError("unsupported-plan", `Overlay ${source.asset.path} has an unsupported playback duration.`);
  }
  const sourceDurationUs = Math.min(availableSourceUs, requiredSourceUs);
  const streamStartUs = playback.streamStartUs ?? 0;
  const effectiveSourceOutUs = streamStartUs + playback.sourceInUs + sourceDurationUs;
  const filters = [
    `trim=start=${seconds(streamStartUs + playback.sourceInUs)}:end=${seconds(effectiveSourceOutUs)}`,
    "setpts=PTS-STARTPTS",
    `fps=fps=${decimal(frameRate)}`,
  ];
  let visibleDurationUs = outputDurationUs;
  if (playback.endBehavior === "loop") {
    if (availableSourceUs < requiredSourceUs) {
      const frames = Math.max(1, Math.ceil(sourceDurationUs * frameRate / 1_000_000));
      if (frames > MAX_LOOP_VIDEO_FRAMES) {
        throw new CliError(
          "unsupported-plan",
          `Overlay ${source.asset.path} needs ${frames} buffered loop frames; maximum is ${MAX_LOOP_VIDEO_FRAMES}.`,
        );
      }
      assertVideoLoopBufferWithinLimit({
        frameCount: frames,
        label: `Overlay ${source.asset.path}`,
        pixelHeight: intrinsicSize.height,
        pixelWidth: intrinsicSize.width,
      });
      filters.push("format=rgba");
      filters.push(`loop=loop=-1:size=${frames}:start=0`);
    }
    filters.push(`trim=duration=${seconds(requiredSourceUs)}`);
  } else if (playback.endBehavior === "freeze-end") {
    // Pad by the full requested window before trimming. This remains correct
    // even when a decoder ends a frame early relative to container duration.
    filters.push(`tpad=stop_mode=clone:stop_duration=${seconds(requiredSourceUs)}`);
    filters.push(`trim=duration=${seconds(requiredSourceUs)}`);
  } else {
    visibleDurationUs = Math.min(outputDurationUs, sourceDurationUs / playback.playbackRate);
    filters.push(`trim=duration=${seconds(Math.min(sourceDurationUs, requiredSourceUs))}`);
  }
  filters.push(`setpts=(PTS-STARTPTS)/${decimal(playback.playbackRate)}+${seconds(outputStartUs)}/TB`);
  return { filters, visibleDurationUs };
}

function animatedAudioFilters(
  source: Extract<OverlayOperation["source"], { readonly kind: "video" }>,
  outputDurationUs: number,
  outputStartUs: number,
): {
  readonly audibleEndUs: number;
  readonly audibleStartUs: number;
  readonly filters: readonly string[];
  readonly loopDuck: {
    readonly audioDelayUs: number;
    readonly audioEndUs: number;
    readonly sourceWindowUs: number;
  } | null;
} | null {
  const playback = source.playback;
  const availableSourceUs = playback.sourceOutUs - playback.sourceInUs;
  const requiredSourceUs = Math.ceil(outputDurationUs * playback.playbackRate);
  if (!Number.isSafeInteger(requiredSourceUs) || requiredSourceUs <= 0) {
    throw new CliError("unsupported-plan", `Overlay ${source.asset.path} has an unsupported playback duration.`);
  }
  const sourceDurationUs = Math.min(availableSourceUs, requiredSourceUs);
  const streamStartUs = playback.streamStartUs ?? 0;
  const selectedSourceStartUs = streamStartUs + playback.sourceInUs;
  const audioDelayUs = Math.max(
    0,
    (playback.audioStartUs ?? streamStartUs) - selectedSourceStartUs,
  );
  const audioEndUs = Math.min(
    availableSourceUs,
    Math.max(
      0,
      (playback.audioEndUs ?? selectedSourceStartUs + availableSourceUs) - selectedSourceStartUs,
    ),
  );
  const audibleSourceRange = resolveAudibleSourceRange({
    audioDelayUs,
    audioEndUs,
    endBehavior: playback.endBehavior,
    requestedDurationUs: requiredSourceUs,
    requestedStartUs: 0,
    sourceWindowUs: availableSourceUs,
  });
  if (audibleSourceRange === null) return null;
  const audibleStartUs = outputStartUs + Math.ceil(audibleSourceRange.startUs / playback.playbackRate);
  const audibleEndUs = Math.min(
    outputStartUs + outputDurationUs,
    outputStartUs + Math.floor(audibleSourceRange.endUs / playback.playbackRate),
  );
  if (audibleEndUs <= audibleStartUs) return null;
  const effectiveSourceOutUs = selectedSourceStartUs + sourceDurationUs;
  const filters = [
    `atrim=start=${seconds(selectedSourceStartUs)}:end=${seconds(effectiveSourceOutUs)}`,
    "aresample=48000",
    "asetpts=PTS-STARTPTS",
    ...(audioDelayUs === 0 ? [] : [`adelay=${decimal(audioDelayUs / 1_000)}:all=1`]),
  ];
  if (playback.endBehavior === "loop") {
    if (availableSourceUs < requiredSourceUs) {
      const samples = Math.max(1, Math.ceil(sourceDurationUs * 48_000 / 1_000_000));
      if (samples > MAX_LOOP_AUDIO_SAMPLES) {
        throw new CliError(
          "unsupported-plan",
          `Overlay ${source.asset.path} needs ${samples} buffered loop samples; maximum is ${MAX_LOOP_AUDIO_SAMPLES}.`,
        );
      }
      assertAudioLoopBufferWithinLimit({ label: `Overlay ${source.asset.path}`, sampleCount: samples });
      if (audioEndUs < availableSourceUs) {
        filters.push(`apad=pad_dur=${seconds(availableSourceUs - audioEndUs)}`);
      }
      filters.push(`atrim=duration=${seconds(availableSourceUs)}`);
      filters.push("aformat=sample_fmts=flt:channel_layouts=stereo");
      filters.push(`aloop=loop=-1:size=${samples}`);
    }
    filters.push(`atrim=duration=${seconds(requiredSourceUs)}`);
  } else {
    filters.push(`atrim=duration=${seconds(Math.min(sourceDurationUs, requiredSourceUs))}`);
  }
  filters.push(atempo(playback.playbackRate));
  filters.push(`asetpts=PTS-STARTPTS+${seconds(outputStartUs)}/TB`);
  return {
    audibleEndUs,
    audibleStartUs,
    filters,
    loopDuck: playback.endBehavior === "loop"
      && availableSourceUs < requiredSourceUs
      && (audioDelayUs > 0 || audioEndUs < availableSourceUs)
      ? { audioDelayUs, audioEndUs, sourceWindowUs: availableSourceUs }
      : null,
  };
}

function cursorCoordinate(
  samples: RenderPlanV1["effects"]["cursorSamples"],
  axis: "x" | "y",
  hidden: number,
): string {
  if (samples.length === 0) return decimal(hidden);
  let expression = decimal(samples.at(-1)!.position[axis]);
  for (let index = samples.length - 1; index > 0; index -= 1) {
    const left = samples[index - 1]!;
    const right = samples[index]!;
    if (right.outputTimeUs <= left.outputTimeUs) continue;
    const start = seconds(left.outputTimeUs);
    const end = seconds(right.outputTimeUs);
    const delta = right.position[axis] - left.position[axis];
    const value = delta === 0
      ? decimal(left.position[axis])
      : `${decimal(left.position[axis])}+${decimal(delta)}*(t-${start})/(${end}-${start})`;
    expression = `if(between(t,${start},${end}),${value},${expression})`;
  }
  return `if(lt(t,${seconds(samples[0]!.outputTimeUs)}),${decimal(hidden)},${expression})`;
}

function cursorVisibility(
  samples: RenderPlanV1["effects"]["cursorSamples"],
  durationUs: number,
): string {
  const intervals: Array<{ readonly endUs: number; readonly startUs: number }> = [];
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]!;
    if (!sample.visible) continue;
    const endUs = samples[index + 1]?.outputTimeUs ?? durationUs;
    if (endUs <= sample.outputTimeUs) continue;
    const prior = intervals.at(-1);
    if (prior !== undefined && prior.endUs === sample.outputTimeUs) {
      intervals[intervals.length - 1] = { endUs, startUs: prior.startUs };
    } else {
      intervals.push({ endUs, startUs: sample.outputTimeUs });
    }
  }
  return intervals.length === 0
    ? "0"
    : intervals.map(({ startUs, endUs }) => `between(t,${seconds(startUs)},${seconds(endUs)})`).join("+");
}

type EnabledCursorEffect = Extract<RenderPlanV1["effects"]["cursor"], { readonly enabled: true }>;
type EnabledClickEffect = Extract<RenderPlanV1["effects"]["clicks"], { readonly enabled: true }>;

export interface MetadataSpriteSource {
  readonly filters: readonly string[];
  readonly height: number;
  readonly width: number;
}

export interface MetadataCursorSpriteSource extends MetadataSpriteSource {
  readonly hotspotX: number;
  readonly hotspotY: number;
}

function nestedExpression(operator: "max" | "min", values: readonly string[]): string {
  const first = values[0];
  if (first === undefined) throw new Error(`Cannot build an empty ${operator} expression.`);
  return values.slice(1).reduce((expression, value) => `${operator}(${expression},${value})`, first);
}

function coverageFromMargin(margin: string): string {
  return `clip((${margin})+0.5,0,1)`;
}

function circleMask(radius: number, x = "X", y = "Y"): string {
  const distance = `hypot((${x})-(W-1)/2,(${y})-(H-1)/2)`;
  return coverageFromMargin(`${decimal(radius)}-${distance}`);
}

function ringMask(outerRadius: number, innerRadius: number, x = "X", y = "Y"): string {
  const outer = circleMask(outerRadius, x, y);
  if (innerRadius <= 0) return outer;
  const distance = `hypot((${x})-(W-1)/2,(${y})-(H-1)/2)`;
  return nestedExpression("min", [
    outer,
    coverageFromMargin(`${distance}-${decimal(innerRadius)}`),
  ]);
}

function arrowMask(
  designScale: number,
  expansion: number,
  x = "X",
  y = "Y",
): string {
  const left = 3 * designScale;
  const right = 25 * designScale;
  const upperOrigin = 2 * designScale;
  const lowerOrigin = 30 * designScale;
  const upperSlope = 17 / 22;
  const lowerSlope = 10 / 22;
  const upper = `${decimal(upperOrigin)}+${decimal(upperSlope)}*((${x})-${decimal(left)})`;
  const lower = `${decimal(lowerOrigin)}-${decimal(lowerSlope)}*((${x})-${decimal(left)})`;
  const triangleMargin = nestedExpression("min", [
    `(${x})-${decimal(left)}`,
    `${decimal(right)}-(${x})`,
    `(${y})-(${upper})`,
    `(${lower})-(${y})`,
  ]);

  const stemStartX = 11 * designScale;
  const stemStartY = 21 * designScale;
  const stemLength = Math.sqrt(245) * designScale;
  const directionX = 7 / Math.sqrt(245);
  const directionY = 14 / Math.sqrt(245);
  const relativeX = `((${x})-${decimal(stemStartX)})`;
  const relativeY = `((${y})-${decimal(stemStartY)})`;
  const projection = `${decimal(directionX)}*${relativeX}+${decimal(directionY)}*${relativeY}`;
  const perpendicular = `${decimal(directionY)}*${relativeX}-${decimal(directionX)}*${relativeY}`;
  const stemMargin = nestedExpression("min", [
    projection,
    `${decimal(stemLength)}-(${projection})`,
    `${decimal(3 * designScale)}-abs(${perpendicular})`,
  ]);
  const expandedTriangle = coverageFromMargin(`(${triangleMargin})+${decimal(expansion)}`);
  const expandedStem = coverageFromMargin(`(${stemMargin})+${decimal(expansion)}`);
  return nestedExpression("max", [expandedTriangle, expandedStem]);
}

function grayscaleGeq(innerMask: string, outerMask: string, shadowMask: string): string {
  const luminance = `255*(${innerMask})`;
  const alpha = `255*${nestedExpression("max", [outerMask, `0.3*(${shadowMask})`])}`;
  return `geq=r='${luminance}':g='${luminance}':b='${luminance}':a='${alpha}'`;
}

function assertMetadataSpriteWithinLimit(width: number, height: number, label: string): void {
  if (
    width > MAX_METADATA_SPRITE_DIMENSION
    || height > MAX_METADATA_SPRITE_DIMENSION
    || width * height > MAX_METADATA_SPRITE_AREA
  ) {
    throw new CliError(
      "unsupported-plan",
      `${label} requires a ${width}x${height} procedural sprite, exceeding the ${MAX_METADATA_SPRITE_DIMENSION}-pixel or 128-megapixel render safety limit.`,
    );
  }
}

export function buildMetadataCursorSprite(
  cursor: Pick<EnabledCursorEffect, "scale" | "style">,
  frameRate: number,
  durationUs: number,
): MetadataCursorSpriteSource {
  if (cursor.style === "captured") {
    const height = Math.max(8, Math.min(256, Math.round(40 * cursor.scale)));
    const designScale = height / 40;
    const width = Math.max(8, Math.ceil(32 * designScale));
    const outline = Math.max(0.65, 0.9 * designScale);
    const shadowOffset = Math.max(1, 1.5 * designScale);
    const inner = arrowMask(designScale, -outline);
    const outer = arrowMask(designScale, outline);
    const shadow = arrowMask(
      designScale,
      outline,
      `(X-${decimal(shadowOffset)})`,
      `(Y-${decimal(shadowOffset)})`,
    );
    return {
      filters: [
        `color=c=black@0.0:s=${width}x${height}:r=${decimal(frameRate)}:d=${seconds(durationUs)}`,
        "format=rgba",
        grayscaleGeq(inner, outer, shadow),
      ],
      height,
      hotspotX: 3 * designScale,
      hotspotY: 2 * designScale,
      width,
    };
  }

  const size = Math.max(8, Math.min(256, Math.round(20 * cursor.scale)));
  const outerRadius = Math.max(1, (size - 1) / 2 - Math.max(1, size * 0.05));
  const shadowOffset = Math.max(1, size * 0.075);
  const shadowX = `(X-${decimal(shadowOffset)})`;
  const shadowY = `(Y-${decimal(shadowOffset)})`;
  let inner: string;
  let outer: string;
  let shadow: string;
  if (cursor.style === "ring") {
    const ringWidth = Math.max(2, size * 0.22);
    const innerRadius = Math.max(0, outerRadius - ringWidth);
    outer = ringMask(outerRadius, innerRadius);
    inner = ringMask(
      Math.max(0, outerRadius - Math.max(0.75, size * 0.055)),
      innerRadius + Math.max(0.75, size * 0.055),
    );
    shadow = ringMask(outerRadius, innerRadius, shadowX, shadowY);
  } else {
    outer = circleMask(outerRadius);
    inner = circleMask(Math.max(0, outerRadius - Math.max(1, size * 0.09)));
    shadow = circleMask(outerRadius, shadowX, shadowY);
  }
  return {
    filters: [
      `color=c=black@0.0:s=${size}x${size}:r=${decimal(frameRate)}:d=${seconds(durationUs)}`,
      "format=rgba",
      grayscaleGeq(inner, outer, shadow),
    ],
    height: size,
    hotspotX: (size - 1) / 2,
    hotspotY: (size - 1) / 2,
    width: size,
  };
}

function rgbaChannels(value: string): {
  readonly alpha: number;
  readonly blue: number;
  readonly green: number;
  readonly red: number;
} {
  if (!/^#[a-fA-F0-9]{6}(?:[a-fA-F0-9]{2})?$/u.test(value)) {
    throw new CliError("invalid-data", `Invalid metadata effect color ${JSON.stringify(value)}.`);
  }
  return {
    alpha: value.length === 9 ? Number.parseInt(value.slice(7, 9), 16) : 255,
    blue: Number.parseInt(value.slice(5, 7), 16),
    green: Number.parseInt(value.slice(3, 5), 16),
    red: Number.parseInt(value.slice(1, 3), 16),
  };
}

export function buildMetadataClickSprite(
  click: Pick<EnabledClickEffect, "color" | "radiusPx" | "style">,
  frameRate: number,
  durationUs: number,
): MetadataSpriteSource {
  const diameter = Math.max(5, Math.ceil(click.radiusPx * 2) + 4);
  assertMetadataSpriteWithinLimit(diameter, diameter, "Click highlight");
  const radius = Math.min(click.radiusPx, (diameter - 1) / 2);
  const thickness = Math.max(2, radius / 8);
  const mask = click.style === "fill"
    ? circleMask(radius)
    : ringMask(radius, Math.max(0, radius - thickness));
  const color = rgbaChannels(click.color);
  const filters = [
    `color=c=black@0.0:s=${diameter}x${diameter}:r=${decimal(frameRate)}:d=${seconds(durationUs)}`,
    "format=rgba",
    `geq=r='${color.red}':g='${color.green}':b='${color.blue}':a='${color.alpha}*(${mask})'`,
  ];
  if (click.style === "pulse") {
    const progress = `t/${seconds(durationUs)}`;
    filters.push(
      `scale=w='max(2,iw*(0.5+0.5*${progress}))':h='max(2,ih*(0.5+0.5*${progress}))':flags=bicubic:eval=frame`,
    );
    filters.push(
      `fade=t=out:st=${seconds(Math.floor(durationUs / 2))}:d=${seconds(Math.ceil(durationUs / 2))}:alpha=1`,
    );
  }
  return { filters, height: diameter, width: diameter };
}

function keystrokeLabel(cue: RenderPlanV1["effects"]["keystrokeCues"][number]): string {
  if (cue.activity.kind === "printable") return "•";
  if (cue.activity.kind === "shortcut") return [...cue.activity.modifiers, cue.activity.keyCode].join("+");
  return [...cue.activity.modifiers, cue.activity.control].join("+");
}

function metadataFilterCount(plan: MetadataEffectRenderPlan): number {
  // Cursor samples are encoded into three expressions on one overlay node.
  // Charge the node here; its serialized expression has a separate byte bound.
  return (plan.effects.cursor.enabled && plan.effects.cursorSamples.length > 0 ? 1 : 0)
    + (plan.effects.clicks.enabled ? plan.effects.clickCues.filter(({ phase }) => phase === "down").length : 0)
    + (plan.effects.keystrokes.enabled
      ? plan.effects.keystrokeCues.filter(({ phase }) => phase === "down").length
      : 0)
    + (plan.effects.typedText.enabled
      ? plan.effects.typingSpans.reduce((count, span) => count + (span.secure ? 0 : span.updates.length), 0)
      : 0);
}

export function applyMetadataEffects(
  plan: MetadataEffectRenderPlan,
  filters: string[],
  initialVideo: string,
  initialSerial: number,
): { readonly currentVideo: string; readonly serial: number } {
  const filterCount = metadataFilterCount(plan);
  if (filterCount > MAX_METADATA_FILTERS) {
    throw new CliError(
      "unsupported-plan",
      `Resolved metadata effects require ${filterCount} filter operations; maximum is ${MAX_METADATA_FILTERS}.`,
    );
  }
  let currentVideo = initialVideo;
  let serial = initialSerial;
  if (plan.effects.cursor.enabled && plan.effects.cursorSamples.length > 0) {
    const samples = [...plan.effects.cursorSamples].sort((left, right) => left.outputTimeUs - right.outputTimeUs);
    const cursorSprite = buildMetadataCursorSprite(
      plan.effects.cursor,
      plan.output.frameRate,
      plan.output.durationUs,
    );
    const sourceLabel = `cursor_source_${serial++}`;
    filters.push(`${cursorSprite.filters.join(",")}[${sourceLabel}]`);
    const nextVideo = `video_cursor_${serial++}`;
    const cursorX = cursorCoordinate(samples, "x", -10_000);
    const cursorY = cursorCoordinate(samples, "y", -10_000);
    const visibility = cursorVisibility(samples, plan.output.durationUs);
    const cursorExpressionBytes = Buffer.byteLength(`${cursorX}\0${cursorY}\0${visibility}`);
    if (cursorExpressionBytes > MAXIMUM_FILTER_GRAPH_BYTES) {
      throw new CliError(
        "unsupported-plan",
        `Resolved cursor expressions require ${cursorExpressionBytes} UTF-8 bytes; maximum is ${MAXIMUM_FILTER_GRAPH_BYTES}.`,
      );
    }
    const x = `${zoomedSpatialCoordinate(plan, "x", cursorX)}-${decimal(cursorSprite.hotspotX)}`;
    const y = `${zoomedSpatialCoordinate(plan, "y", cursorY)}-${decimal(cursorSprite.hotspotY)}`;
    filters.push(
      `[${currentVideo}][${sourceLabel}]overlay=x='${x}':y='${y}':eof_action=pass:repeatlast=0:enable='${visibility}'[${nextVideo}]`,
    );
    currentVideo = nextVideo;
  }
  if (plan.effects.clicks.enabled) {
    for (const cue of plan.effects.clickCues.filter(({ phase }) => phase === "down")) {
      const durationUs = Math.min(plan.effects.clicks.durationUs, plan.output.durationUs - cue.outputTimeUs);
      if (durationUs <= 0) continue;
      const clickSprite = buildMetadataClickSprite(
        plan.effects.clicks,
        plan.output.frameRate,
        durationUs,
      );
      const sourceLabel = `click_source_${serial++}`;
      const clickFilters = [
        ...clickSprite.filters,
        "settb=expr=1/1000000",
        `setpts=PTS-STARTPTS+${seconds(cue.outputTimeUs)}/TB`,
      ];
      filters.push(`${clickFilters.join(",")}[${sourceLabel}]`);
      const nextVideo = `video_click_${serial++}`;
      const start = seconds(cue.outputTimeUs);
      const end = seconds(cue.outputTimeUs + durationUs);
      const x = zoomedSpatialCoordinate(plan, "x", decimal(cue.position.x));
      const y = zoomedSpatialCoordinate(plan, "y", decimal(cue.position.y));
      filters.push(
        `[${currentVideo}][${sourceLabel}]overlay=x='${x}-w/2':y='${y}-h/2':eof_action=pass:repeatlast=0:enable='between(t,${start},${end})'[${nextVideo}]`,
      );
      currentVideo = nextVideo;
    }
  }
  if (plan.effects.keystrokes.enabled) {
    const keystrokes = plan.effects.keystrokes;
    const x = keystrokes.position === "bottom-left"
      ? "40"
      : keystrokes.position === "bottom-center"
        ? "(w-tw)/2"
        : "w-tw-40";
    const cues = plan.effects.keystrokeCues.filter(({ phase }) => phase === "down")
      .sort((left, right) => left.outputTimeUs - right.outputTimeUs);
    for (let index = 0; index < cues.length; index += 1) {
      const cue = cues[index]!;
      const naturalEndUs = cue.outputTimeUs + keystrokes.holdUs;
      const endUs = Math.min(plan.output.durationUs, naturalEndUs, cues[index + 1]?.outputTimeUs ?? naturalEndUs);
      if (endUs <= cue.outputTimeUs) continue;
      const label = cues.slice(0, index + 1)
        .filter((candidate) => candidate.outputTimeUs + keystrokes.holdUs > cue.outputTimeUs)
        .slice(-keystrokes.maxKeys)
        .map(keystrokeLabel)
        .join("  ");
      const nextVideo = `video_key_${serial++}`;
      filters.push(
        `[${currentVideo}]drawtext=text='${escapeDrawtext(label)}':fontcolor=white:fontsize=32:box=1:boxcolor=black@0.7:boxborderw=14:x='${x}':y='h-th-40':enable='between(t,${seconds(cue.outputTimeUs)},${seconds(endUs)})'[${nextVideo}]`,
      );
      currentVideo = nextVideo;
    }
  }
  if (plan.effects.typedText.enabled) {
    for (const span of plan.effects.typingSpans) {
      if (span.secure) continue;
      for (let index = 0; index < span.updates.length; index += 1) {
        const update = span.updates[index]!;
        const endUs = Math.min(span.endOutputUs, span.updates[index + 1]?.outputTimeUs ?? span.endOutputUs);
        if (endUs <= update.outputTimeUs) continue;
        const text = [...update.text].slice(-plan.effects.typedText.maxCharacters).join("");
        if (text === "") continue;
        const x = plan.effects.typedText.placement === "caption"
          ? "(w-tw)/2"
          : zoomedSpatialCoordinate(plan, "x", decimal(update.bounds.x + 8));
        const y = plan.effects.typedText.placement === "caption"
          ? "h-th-80"
          : zoomedSpatialCoordinate(plan, "y", decimal(update.bounds.y + 4));
        const nextVideo = `video_typing_${serial++}`;
        filters.push(
          `[${currentVideo}]drawtext=text='${escapeDrawtext(text)}':fontcolor=white:fontsize=28:box=1:boxcolor=black@0.72:boxborderw=10:x='${x}':y='${y}':enable='between(t,${seconds(update.outputTimeUs)},${seconds(endUs)})'[${nextVideo}]`,
        );
        currentVideo = nextVideo;
      }
    }
  }
  return { currentVideo, serial };
}

export interface PreparedOverlaySource {
  readonly audioStreamIndex: number | null;
  readonly overlayId: string;
  readonly path: string;
  readonly videoStreamIndex: number | null;
}

export interface RenderBuildOptions {
  readonly bundleRoot: string;
  readonly ffmpeg: string;
  readonly outputPath: string;
  readonly overlaySources: readonly PreparedOverlaySource[];
}

export interface BuiltRenderInvocation {
  readonly argv: readonly [string, ...string[]];
  readonly invocation: RenderInvocation;
}

export async function buildFfmpegInvocation(
  manifest: RecordingManifestV1,
  plan: RenderPlanV1,
  options: RenderBuildOptions,
): Promise<BuiltRenderInvocation> {
  if (plan.output.durationUs <= 0) throw new CliError("unsupported-plan", "A zero-duration render plan cannot be encoded.");
  const orderedSegments = [...plan.sourceSegments].sort((left, right) =>
    left.output.startUs - right.output.startUs
    || left.kind.localeCompare(right.kind)
    || left.trackId.localeCompare(right.trackId)
  );
  const orderedOverlays = [...plan.overlays].sort((left, right) =>
    left.operation.zIndex - right.operation.zIndex
    || left.output.startUs - right.output.startUs
    || left.operation.overlayId.localeCompare(right.operation.overlayId)
  );
  const inputArguments: string[] = [];
  const inputIndex = new Map<RenderPlanV1["sourceSegments"][number], number>();
  const inputByPath = new Map<string, { readonly bytes: number; readonly index: number; readonly sha256: string }>();
  for (const segment of orderedSegments) {
    const source = manifestSourceSegment(manifest, segment);
    if (
      source.integrity.state !== "verified"
      || source.integrity.bytes !== segment.bytes
      || source.integrity.sha256 !== segment.sha256
    ) {
      throw new CliError("invalid-data", `Render segment integrity is stale for ${segment.path}:${segment.streamIndex}.`);
    }
    const prior = inputByPath.get(segment.path);
    if (prior !== undefined) {
      if (prior.bytes !== segment.bytes || prior.sha256 !== segment.sha256) {
        throw new CliError("invalid-data", `Render segments disagree about whole-file integrity for ${segment.path}.`);
      }
      inputIndex.set(segment, prior.index);
      continue;
    }
    const absolute = await resolveVerifiedProjectMedia({
      expected: segment,
      label: `Recording media ${segment.path}`,
      path: segment.path,
      repositoryRoot: options.bundleRoot,
    });
    const index = inputByPath.size;
    inputByPath.set(segment.path, { bytes: segment.bytes, index, sha256: segment.sha256 });
    inputIndex.set(segment, index);
    inputArguments.push("-i", absolute);
  }
  const overlayInputIndex = new Map<string, number>();
  const preparedOverlaySource = new Map<string, PreparedOverlaySource>();
  for (const overlay of orderedOverlays) {
    if (overlayInputIndex.has(overlay.operation.overlayId)) continue;
    const prepared = options.overlaySources.find(({ overlayId }) => overlayId === overlay.operation.overlayId);
    if (prepared === undefined) throw new CliError("invalid-data", `Overlay ${overlay.operation.overlayId} has no prepared source.`);
    const index = inputByPath.size + overlayInputIndex.size;
    overlayInputIndex.set(overlay.operation.overlayId, index);
    preparedOverlaySource.set(overlay.operation.overlayId, prepared);
    const source = overlay.operation.source;
    if (source.kind === "image" || source.kind === "svg" || source.kind === "emoji") {
      inputArguments.push("-loop", "1", "-i", prepared.path);
    } else {
      inputArguments.push("-i", prepared.path);
    }
  }

  const filters: string[] = [];
  const videoLayers: Array<{
    readonly endUs: number;
    readonly label: string;
    readonly startUs: number;
  }> = [];
  const audioLabels: string[] = [];
  let serial = 0;
  for (const segment of orderedSegments) {
    const index = inputIndex.get(segment)!;
    const [localStartUs, localEndUs] = localTimes(manifest, segment);
    const speed = sourceSpeed(plan, segment.source.startUs, segment.source.endUs);
    if (segment.kind === "display-video") {
      const label = `v${serial++}`;
      filters.push(
        `[${inputSpecifier(index, segment.streamIndex)}]trim=start=${seconds(localStartUs)}:end=${seconds(localEndUs)},setpts=(PTS-STARTPTS)/${decimal(speed)}+${seconds(segment.output.startUs)}/TB,scale=${plan.output.pixelWidth}:${plan.output.pixelHeight}[${label}]`,
      );
      videoLayers.push({ endUs: segment.output.endUs, label, startUs: segment.output.startUs });
    } else if (segment.kind === "system-audio" || segment.kind === "microphone-audio") {
      const label = `a${serial++}`;
      filters.push(
        `[${inputSpecifier(index, segment.streamIndex)}]atrim=start=${seconds(localStartUs)}:end=${seconds(localEndUs)},asetpts=PTS-STARTPTS,${atempo(speed)},asetpts=PTS-STARTPTS+${seconds(segment.output.startUs)}/TB[${label}]`,
      );
      audioLabels.push(label);
    }
  }
  if (videoLayers.length === 0) throw new CliError("unsupported-plan", "Selected display has no executable video segments.");
  filters.push(
    `color=c=black:s=${plan.output.pixelWidth}x${plan.output.pixelHeight}:r=${decimal(plan.output.frameRate)}:d=${seconds(plan.output.durationUs)},format=yuv420p[video_timeline]`,
  );
  let joinedVideo = "video_timeline";
  for (const layer of videoLayers) {
    const next = `video_segment_${serial++}`;
    filters.push(
      `[${joinedVideo}][${layer.label}]overlay=x=0:y=0:eof_action=pass:repeatlast=0:enable='between(t,${seconds(layer.startUs)},${seconds(layer.endUs)})'[${next}]`,
    );
    joinedVideo = next;
  }
  const zoom = zoomFilter(plan);
  let currentVideo = joinedVideo;
  if (zoom !== null) {
    filters.push(`[${currentVideo}]${zoom}[video_zoomed]`);
    currentVideo = "video_zoomed";
  }

  ({ currentVideo, serial } = applyMetadataEffects(plan, filters, currentVideo, serial));

  for (const resolved of orderedOverlays) {
    const overlay = resolved.operation;
    const index = overlayInputIndex.get(overlay.overlayId)!;
    const startUs = resolved.output.startUs;
    const endUs = resolved.output.endUs;
    const source = overlay.source;
    const prepared = preparedOverlaySource.get(overlay.overlayId)!;
    const overlayLabel = `overlay_${serial++}`;
    const chain: string[] = [];
    let visibleEndUs = endUs;
    if (source.kind === "gif" || source.kind === "video") {
      const animated = animatedVideoFilters(
        source,
        overlay.intrinsicSize,
        endUs - startUs,
        startUs,
        plan.output.frameRate,
      );
      chain.push(...animated.filters);
      visibleEndUs = startUs + animated.visibleDurationUs;
    } else {
      chain.push(`trim=duration=${seconds(endUs - startUs)}`);
      chain.push(`setpts=PTS-STARTPTS+${seconds(startUs)}/TB`);
    }
    const effectiveOverlay = withEffectiveOverlayAnimations(overlay, visibleEndUs - startUs);
    chain.push(...overlayGeometryFilters(effectiveOverlay, startUs, visibleEndUs));
    const videoStreamIndex = source.kind === "gif" || source.kind === "video"
      ? prepared.videoStreamIndex ?? source.playback.videoStreamIndex
      : null;
    filters.push(`[${animatedStreamSpecifier(index, "v", videoStreamIndex)}]${chain.join(",")}[${overlayLabel}]`);
    const nextVideo = `video_${serial++}`;
    const x = overlayPositionExpression(effectiveOverlay, "x", startUs, visibleEndUs);
    const y = overlayPositionExpression(effectiveOverlay, "y", startUs, visibleEndUs);
    const enable = `between(t,${seconds(startUs)},${seconds(visibleEndUs)})`;
    const blendMode = overlay.blendMode ?? "normal";
    if (blendMode === "normal") {
      filters.push(
        `[${currentVideo}][${overlayLabel}]overlay=x='${x}':y='${y}':eof_action=pass:repeatlast=0:enable='${enable}'[${nextVideo}]`,
      );
    } else {
      const transparent = `overlay_blend_canvas_${serial++}`;
      const positioned = `overlay_blend_positioned_${serial++}`;
      const layerColor = `overlay_blend_color_${serial++}`;
      const layerAlphaSource = `overlay_blend_alpha_source_${serial++}`;
      const layerMask = `overlay_blend_mask_${serial++}`;
      const baseBlend = `overlay_blend_base_${serial++}`;
      const baseMerge = `overlay_blend_merge_${serial++}`;
      const blended = `overlay_blend_result_${serial++}`;
      filters.push(
        `color=c=black@0:s=${plan.output.pixelWidth}x${plan.output.pixelHeight}:r=${decimal(plan.output.frameRate)}:d=${seconds(plan.output.durationUs)},format=rgba[${transparent}]`,
        `[${transparent}][${overlayLabel}]overlay=x='${x}':y='${y}':eof_action=pass:repeatlast=0:enable='${enable}'[${positioned}]`,
        `[${positioned}]format=rgba,split=2[${layerColor}][${layerAlphaSource}]`,
        `[${layerAlphaSource}]alphaextract[${layerMask}]`,
        `[${currentVideo}]split=2[${baseBlend}][${baseMerge}]`,
        `[${baseBlend}][${layerColor}]blend=all_mode=${blendMode}[${blended}]`,
        `[${baseMerge}][${blended}][${layerMask}]maskedmerge[${nextVideo}]`,
      );
    }
    currentVideo = nextVideo;
  }

  let currentPrimaryAudio: string | undefined;
  if (audioLabels.length > 0) {
    filters.push(`anullsrc=r=48000:cl=stereo:d=${seconds(plan.output.durationUs)}[audio_timeline]`);
    currentPrimaryAudio = "audio_primary";
    filters.push(
      `[audio_timeline]${audioLabels.map((label) => `[${label}]`).join("")}amix=inputs=${audioLabels.length + 1}:duration=longest:dropout_transition=0:normalize=0,atrim=duration=${seconds(plan.output.durationUs)}[${currentPrimaryAudio}]`,
    );
  }
  const overlayAudioLabels: string[] = [];
  const primaryDuckEnvelopes: { readonly condition: string; readonly target: number }[] = [];
  for (const resolved of orderedOverlays) {
    const source = resolved.operation.source;
    if (source.kind !== "video" || source.audioPolicy.kind === "mute") continue;
    const index = overlayInputIndex.get(resolved.operation.overlayId)!;
    const overlayAudio = `overlay_audio_${serial++}`;
    const volume = source.audioPolicy.volume;
    const animatedAudio = animatedAudioFilters(
      source,
      resolved.output.endUs - resolved.output.startUs,
      resolved.output.startUs,
    );
    if (animatedAudio === null) continue;
    const prepared = preparedOverlaySource.get(resolved.operation.overlayId)!;
    filters.push(
      `[${animatedStreamSpecifier(index, "a", prepared.audioStreamIndex ?? source.playback.audioStreamIndex)}]${animatedAudio.filters.join(",")},volume=${decimal(volume)}[${overlayAudio}]`,
    );
    if (source.audioPolicy.kind === "duck-primary" && currentPrimaryAudio !== undefined) {
      const duckCondition = animatedAudio.loopDuck === null
        ? `between(t,${seconds(animatedAudio.audibleStartUs)},${seconds(animatedAudio.audibleEndUs)})`
        : [
            `between(t,${seconds(resolved.output.startUs)},${seconds(resolved.output.endUs)})`,
            `gte(mod((t-${seconds(resolved.output.startUs)})*${decimal(source.playback.playbackRate)},${seconds(animatedAudio.loopDuck.sourceWindowUs)}),${seconds(animatedAudio.loopDuck.audioDelayUs)})`,
            `lt(mod((t-${seconds(resolved.output.startUs)})*${decimal(source.playback.playbackRate)},${seconds(animatedAudio.loopDuck.sourceWindowUs)}),${seconds(animatedAudio.loopDuck.audioEndUs)})`,
          ].join("*");
      primaryDuckEnvelopes.push({ condition: duckCondition, target: source.audioPolicy.duckPrimaryTo });
    }
    overlayAudioLabels.push(overlayAudio);
  }
  if (currentPrimaryAudio !== undefined && primaryDuckEnvelopes.length > 0) {
    const ducked = `audio_ducked_${serial++}`;
    const volume = primaryDuckEnvelopes
      .map(envelope => `if(${envelope.condition},${decimal(envelope.target)},1)`)
      .reduce((left, right) => `min(${left},${right})`);
    filters.push(`[${currentPrimaryAudio}]volume='${volume}':eval=frame[${ducked}]`);
    currentPrimaryAudio = ducked;
  }
  const audioMixLabels = [
    ...(currentPrimaryAudio === undefined ? [] : [currentPrimaryAudio]),
    ...overlayAudioLabels,
  ];
  let currentAudio = audioMixLabels[0];
  if (audioMixLabels.length > 1) {
    const mixed = `audio_mix_${serial++}`;
    filters.push(
      `${audioMixLabels.map(label => `[${label}]`).join("")}amix=inputs=${audioMixLabels.length}:duration=longest:dropout_transition=0:normalize=0[${mixed}]`,
    );
    currentAudio = mixed;
  }

  const outputRelative = options.outputPath.startsWith(`${options.bundleRoot}/`)
    ? options.outputPath.slice(options.bundleRoot.length + 1)
    : (() => { throw new CliError("unsafe-path", "Render output must remain inside its recording bundle."); })();
  if (!outputRelative.startsWith("renders/")) {
    throw new CliError("unsafe-path", "Render output must remain under renders/ so source media stays immutable.");
  }
  const filterGraph = await materializeFilterScript({
    graph: filters.join(";"),
    relativeDirectory: "derived/filter-graphs",
    root: options.bundleRoot,
  });
  const arguments_: string[] = [
    "-hide_banner", "-nostdin", "-y",
    ...inputArguments,
    "-filter_complex_script", filterGraph.path,
    "-map", `[${currentVideo}]`,
    ...(currentAudio === undefined ? [] : ["-map", `[${currentAudio}]`]),
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    ...(currentAudio === undefined ? [] : ["-c:a", "aac"]),
    "-t", seconds(plan.output.durationUs),
    "-movflags", "+faststart",
    options.outputPath,
  ];
  const invocation = RenderInvocationSchema.parse({
    arguments: arguments_,
    executable: "ffmpeg",
    filterGraph: {
      bytes: filterGraph.bytes,
      path: filterGraph.repositoryPath,
      sha256: filterGraph.sha256,
    },
    outputPath: outputRelative,
    renderPlanSha256: canonicalJsonSha256(plan),
  });
  return { argv: [options.ffmpeg, ...arguments_], invocation };
}

export interface SvgPreparationOptions {
  readonly bundleRoot: string;
  readonly dryRun: boolean;
  readonly ffprobe?: string;
  readonly rsvgConvert: string | undefined;
  readonly runner: ProcessRunner;
}

export interface OverlayPreparation {
  readonly sources: readonly PreparedOverlaySource[];
  readonly steps: readonly { readonly argv: readonly string[]; readonly output: string }[];
}

export async function prepareOverlaySources(
  plan: RenderPlanV1,
  options: SvgPreparationOptions,
): Promise<OverlayPreparation> {
  const sources: PreparedOverlaySource[] = [];
  const steps: { readonly argv: readonly string[]; readonly output: string }[] = [];
  for (const resolved of plan.overlays) {
    const operation = resolved.operation;
    if (sources.some(({ overlayId }) => overlayId === operation.overlayId)) continue;
    const input = await resolveVerifiedProjectMedia({
      expected: operation.source.asset,
      label: `Overlay ${operation.overlayId}`,
      path: operation.source.asset.path,
      repositoryRoot: options.bundleRoot,
    });
    if (operation.source.asset.mediaType !== "image/svg+xml") {
      if (options.ffprobe === undefined) {
        throw new CliError("unavailable", `Overlay ${operation.overlayId} requires FFprobe dimension verification.`);
      }
      const probed = await probeVisualMediaSummary(options.ffprobe, options.runner, input);
      if (
        probed.pixelWidth !== operation.intrinsicSize.width
        || probed.pixelHeight !== operation.intrinsicSize.height
      ) {
        throw new CliError("invalid-data", `Overlay ${operation.overlayId} intrinsic dimensions do not match its media.`);
      }
      let audioStreamIndex: number | null = null;
      let videoStreamIndex: number | null = null;
      if (operation.source.kind === "gif" || operation.source.kind === "video") {
        const playback = operation.source.playback;
        if (
          playback.videoStreamIndex !== null
          && playback.videoStreamIndex !== undefined
          && playback.videoStreamIndex !== probed.videoStreamIndex
        ) {
          throw new CliError("invalid-data", `Overlay ${operation.overlayId} selected video stream does not match its media.`);
        }
        if (
          playback.audioStreamIndex !== null
          && playback.audioStreamIndex !== undefined
          && playback.audioStreamIndex !== probed.audioStreamIndex
        ) {
          throw new CliError("invalid-data", `Overlay ${operation.overlayId} selected audio stream does not match its media.`);
        }
        if (
          operation.source.kind === "video"
          && operation.source.audioPolicy.kind !== "mute"
          && probed.audioStreamIndex === null
        ) {
          throw new CliError("invalid-data", `Overlay ${operation.overlayId} requires an audio stream that is absent from its media.`);
        }
        audioStreamIndex = probed.audioStreamIndex;
        videoStreamIndex = probed.videoStreamIndex;
      }
      sources.push({ audioStreamIndex, overlayId: operation.overlayId, path: input, videoStreamIndex });
      continue;
    }
    const svgSize = await inspectSvgIntrinsicSize(input);
    if (
      svgSize.width !== operation.intrinsicSize.width
      || svgSize.height !== operation.intrinsicSize.height
    ) {
      throw new CliError("invalid-data", `Overlay ${operation.overlayId} intrinsic dimensions do not match its SVG.`);
    }
    if (options.rsvgConvert === undefined) {
      throw new CliError(
        "unavailable",
        `SVG overlay ${operation.overlayId} requires rsvg-convert; the resolved render plan was preserved.`,
      );
    }
    const derivedRoot = await resolveSafePath(options.bundleRoot, "derived/svg");
    await ensurePrivateDirectory(derivedRoot);
    const output = join(derivedRoot, `${operation.source.asset.sha256}.png`);
    if (options.dryRun) {
      const argv = [
        options.rsvgConvert,
        "--keep-aspect-ratio",
        "--width", String(svgSize.width),
        "--height", String(svgSize.height),
        "-o", output,
        input,
      ] as const;
      steps.push({ argv, output });
    } else {
      const temporary = join(
        derivedRoot,
        `.${operation.source.asset.sha256}.${randomUUID()}.tmp.png`,
      );
      const argv = [
        options.rsvgConvert,
        "--keep-aspect-ratio",
        "--width", String(svgSize.width),
        "--height", String(svgSize.height),
        "-o", temporary,
        input,
      ] as const;
      steps.push({ argv, output });
      try {
        try {
          const existing = await lstat(output);
          if (existing.isSymbolicLink() || !existing.isFile()) {
            throw new CliError("unsafe-path", `SVG derivative must be a physical regular file: ${output}`);
          }
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        }
        const result = await options.runner.run(argv);
        if (result.exitCode !== 0) {
          throw new CliError("subprocess", `rsvg-convert failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
        }
        await fingerprintPhysicalProjectMedia(temporary, MAX_DERIVED_OVERLAY_BYTES);
        const derivativeSize = await inspectPngIntrinsicSize(temporary);
        if (derivativeSize.width !== svgSize.width || derivativeSize.height !== svgSize.height) {
          throw new CliError("invalid-data", `SVG derivative dimensions do not match overlay ${operation.overlayId}.`);
        }
        await chmod(temporary, 0o600);
        await rename(temporary, output);
      } finally {
        await rm(temporary, { force: true });
      }
    }
    sources.push({ audioStreamIndex: null, overlayId: operation.overlayId, path: output, videoStreamIndex: null });
  }
  return { sources, steps };
}
