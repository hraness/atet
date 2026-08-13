import { z } from "zod";

import {
  FaceAnalysisFrameResultSchema,
  FaceTrackIdSchema,
  NormalizedTopLeftRectSchema,
  type FaceTrackId,
  type NormalizedTopLeftRect,
} from "../contracts/analysis";
import { SourceIntervalSchema } from "../contracts/edit";
import { MicrosecondsSchema, type ReadonlyInferred } from "../contracts/recording";

export const PreparedLayerFaceMappingSchema = z.strictObject({
  crop: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("none") }),
    z.strictObject({
      bottom: z.number().finite().min(0).max(1),
      kind: z.literal("normalized-insets"),
      left: z.number().finite().min(0).max(1),
      right: z.number().finite().min(0).max(1),
      top: z.number().finite().min(0).max(1),
    }).superRefine((crop, context) => {
      if (crop.left + crop.right >= 1 || crop.top + crop.bottom >= 1) {
        context.addIssue({ code: "custom", message: "Prepared-layer crop must leave visible source content." });
      }
    }),
  ]),
  fit: z.enum(["contain", "cover", "fill"]),
  layerPixelHeight: z.number().int().safe().positive().max(16_384),
  layerPixelWidth: z.number().int().safe().positive().max(16_384),
  sourceDisplayAspect: z.number().finite().positive().max(100),
}).superRefine((mapping, context) => {
  if (mapping.layerPixelWidth * mapping.layerPixelHeight > 134_217_728) {
    context.addIssue({ code: "custom", message: "Prepared face layer exceeds the 128-megapixel safety limit." });
  }
});

export const PreparedTrackedFaceDetectionSchema = z.strictObject({
  confidence: z.number().finite().min(0).max(1),
  rect: NormalizedTopLeftRectSchema,
  trackId: FaceTrackIdSchema,
});

export const PreparedFaceFrameSchema = z.discriminatedUnion("state", [
  z.strictObject({
    assetTimeUs: MicrosecondsSchema,
    detections: z.array(PreparedTrackedFaceDetectionSchema).max(256),
    space: z.literal("prepared-video-layer-normalized-v1"),
    state: z.literal("analyzed"),
  }),
  z.strictObject({
    assetTimeUs: MicrosecondsSchema,
    errorCode: z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/u),
    space: z.literal("prepared-video-layer-normalized-v1"),
    state: z.literal("failed"),
  }),
]);

export const FaceFramingGapPolicySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("fallback") }),
  z.strictObject({ kind: z.literal("fail") }),
  z.strictObject({
    kind: z.literal("hold"),
    maximumHoldUs: MicrosecondsSchema,
    whenExpired: z.enum(["fallback", "fail"]),
  }),
]);

export const FaceFramingConfigSchema = z.strictObject({
  gapPolicy: FaceFramingGapPolicySchema,
  headroomRatio: z.number().finite().nonnegative().max(4),
  maximumZoom: z.number().finite().min(1).max(10),
  paddingRatio: z.number().finite().nonnegative().max(4),
  requireAllSelectedFaces: z.boolean(),
  simplificationTolerance: z.number().finite().nonnegative().max(1),
  smoothingTimeUs: MicrosecondsSchema,
});

export const FaceFramingInputSchema = z.strictObject({
  config: FaceFramingConfigSchema,
  frames: z.array(PreparedFaceFrameSchema).max(250_000),
  range: SourceIntervalSchema,
  trackIds: z.array(FaceTrackIdSchema).min(1).max(64),
}).superRefine((input, context) => {
  if (new Set(input.trackIds).size !== input.trackIds.length) {
    context.addIssue({ code: "custom", message: "Face framing track IDs must be unique." });
  }
});

export const FaceFramingViewportSchema = NormalizedTopLeftRectSchema.superRefine((viewport, context) => {
  if (Math.abs(viewport.width - viewport.height) > 1e-12) {
    context.addIssue({ code: "custom", message: "Prepared-layer face viewport must be square in normalized space." });
  }
});

export const FaceFramingKeyframeSchema = z.strictObject({
  assetTimeUs: MicrosecondsSchema,
  source: z.enum(["fallback", "held", "observed"]),
  viewport: FaceFramingViewportSchema,
  visibleTrackIds: z.array(FaceTrackIdSchema).max(64),
  zoom: z.number().finite().min(1).max(10),
}).superRefine((keyframe, context) => {
  if (Math.abs(keyframe.zoom * keyframe.viewport.width - 1) > 1e-9) {
    context.addIssue({ code: "custom", message: "Face framing zoom must be the inverse viewport width." });
  }
  if (new Set(keyframe.visibleTrackIds).size !== keyframe.visibleTrackIds.length) {
    context.addIssue({ code: "custom", message: "Face framing visible track IDs must be unique." });
  }
});

export type PreparedLayerFaceMapping = ReadonlyInferred<typeof PreparedLayerFaceMappingSchema>;
export type PreparedTrackedFaceDetection = ReadonlyInferred<typeof PreparedTrackedFaceDetectionSchema>;
export type PreparedFaceFrame = ReadonlyInferred<typeof PreparedFaceFrameSchema>;
export type FaceFramingGapPolicy = ReadonlyInferred<typeof FaceFramingGapPolicySchema>;
export type FaceFramingConfig = ReadonlyInferred<typeof FaceFramingConfigSchema>;
export type FaceFramingInput = ReadonlyInferred<typeof FaceFramingInputSchema>;
export type FaceFramingViewport = ReadonlyInferred<typeof FaceFramingViewportSchema>;
export type FaceFramingKeyframe = ReadonlyInferred<typeof FaceFramingKeyframeSchema>;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function intersectNormalizedRects(
  left: NormalizedTopLeftRect,
  right: NormalizedTopLeftRect,
): NormalizedTopLeftRect | null {
  const x = Math.max(left.x, right.x);
  const y = Math.max(left.y, right.y);
  const endX = Math.min(left.x + left.width, right.x + right.width);
  const endY = Math.min(left.y + left.height, right.y + right.height);
  if (endX <= x || endY <= y) return null;
  return NormalizedTopLeftRectSchema.parse({
    height: endY - y,
    width: endX - x,
    x,
    y,
  });
}

/**
 * Maps a canonical oriented-source face box through the exact crop and fit
 * geometry used to prepare a video layer. A fully cropped or covered box
 * returns null; a partial box is clipped to the visible prepared layer.
 */
export function mapSourceFaceRectToPreparedLayer(
  rectInput: unknown,
  mappingInput: unknown,
): NormalizedTopLeftRect | null {
  const rect = NormalizedTopLeftRectSchema.parse(rectInput);
  const mapping = PreparedLayerFaceMappingSchema.parse(mappingInput);
  const crop = mapping.crop.kind === "none"
    ? { height: 1, width: 1, x: 0, y: 0 }
    : {
      height: 1 - mapping.crop.top - mapping.crop.bottom,
      width: 1 - mapping.crop.left - mapping.crop.right,
      x: mapping.crop.left,
      y: mapping.crop.top,
    };
  const visibleSource = intersectNormalizedRects(rect, crop);
  if (visibleSource === null) return null;
  const croppedFace = {
    height: visibleSource.height / crop.height,
    width: visibleSource.width / crop.width,
    x: (visibleSource.x - crop.x) / crop.width,
    y: (visibleSource.y - crop.y) / crop.height,
  };
  const croppedDisplayAspect = mapping.sourceDisplayAspect * crop.width / crop.height;
  const layerAspect = mapping.layerPixelWidth / mapping.layerPixelHeight;

  let contentHeight = 1;
  let contentWidth = 1;
  if (mapping.fit === "contain") {
    if (croppedDisplayAspect >= layerAspect) {
      contentHeight = layerAspect / croppedDisplayAspect;
    } else {
      contentWidth = croppedDisplayAspect / layerAspect;
    }
  } else if (mapping.fit === "cover") {
    if (croppedDisplayAspect >= layerAspect) {
      contentWidth = croppedDisplayAspect / layerAspect;
    } else {
      contentHeight = layerAspect / croppedDisplayAspect;
    }
  }

  const mapped = {
    height: croppedFace.height * contentHeight,
    width: croppedFace.width * contentWidth,
    x: (1 - contentWidth) / 2 + croppedFace.x * contentWidth,
    y: (1 - contentHeight) / 2 + croppedFace.y * contentHeight,
  };
  const clippedX = clamp(mapped.x, 0, 1);
  const clippedY = clamp(mapped.y, 0, 1);
  const clippedEndX = clamp(mapped.x + mapped.width, 0, 1);
  const clippedEndY = clamp(mapped.y + mapped.height, 0, 1);
  if (clippedEndX <= clippedX || clippedEndY <= clippedY) return null;
  return NormalizedTopLeftRectSchema.parse({
    height: clippedEndY - clippedY,
    width: clippedEndX - clippedX,
    x: clippedX,
    y: clippedY,
  });
}

/**
 * Computes display aspect after encoded pixel aspect ratio and orientation are
 * applied to the coordinate provenance stored with face evidence.
 */
export function faceCoordinateDisplayAspect(coordinateSpace: Readonly<{
  pixelHeight: number;
  pixelWidth: number;
  rotationDegrees: 0 | 90 | 180 | 270;
  sampleAspectRatio: Readonly<{ denominator: number; numerator: number }>;
}>): number {
  const sampleAspectRatio = coordinateSpace.sampleAspectRatio.numerator
    / coordinateSpace.sampleAspectRatio.denominator;
  const swapsAxes = coordinateSpace.rotationDegrees === 90 || coordinateSpace.rotationDegrees === 270;
  return swapsAxes
    ? coordinateSpace.pixelWidth / (coordinateSpace.pixelHeight * sampleAspectRatio)
    : (coordinateSpace.pixelWidth * sampleAspectRatio) / coordinateSpace.pixelHeight;
}

export function mapFaceResultsToPreparedLayer(
  resultsInput: unknown,
  mappingInput: unknown,
): readonly PreparedFaceFrame[] {
  const results = z.array(FaceAnalysisFrameResultSchema).max(250_000).parse(resultsInput);
  const mapping = PreparedLayerFaceMappingSchema.parse(mappingInput);
  return results.map((result): PreparedFaceFrame => {
    if (result.state === "failed") {
      return PreparedFaceFrameSchema.parse({
        assetTimeUs: result.assetTimeUs,
        errorCode: result.errorCode,
        space: "prepared-video-layer-normalized-v1",
        state: "failed",
      });
    }
    return PreparedFaceFrameSchema.parse({
      assetTimeUs: result.assetTimeUs,
      detections: result.detections.flatMap((detection) => {
        const rect = mapSourceFaceRectToPreparedLayer(detection.rect, mapping);
        return rect === null ? [] : [{ confidence: detection.confidence, rect, trackId: detection.trackId }];
      }),
      space: "prepared-video-layer-normalized-v1",
      state: "analyzed",
    });
  });
}

export function unionNormalizedFaceRects(
  rectsInput: readonly NormalizedTopLeftRect[],
): NormalizedTopLeftRect {
  const rects = z.array(NormalizedTopLeftRectSchema).min(1).max(256).parse(rectsInput);
  const x = Math.min(...rects.map(rect => rect.x));
  const y = Math.min(...rects.map(rect => rect.y));
  const endX = Math.max(...rects.map(rect => rect.x + rect.width));
  const endY = Math.max(...rects.map(rect => rect.y + rect.height));
  return NormalizedTopLeftRectSchema.parse({ height: endY - y, width: endX - x, x, y });
}

export function faceFramingViewport(
  rectsInput: readonly NormalizedTopLeftRect[],
  configInput: unknown,
): FaceFramingViewport {
  const config = FaceFramingConfigSchema.parse(configInput);
  const union = unionNormalizedFaceRects(rectsInput);
  const horizontalPadding = union.width * config.paddingRatio;
  const topPadding = union.height * (config.paddingRatio + config.headroomRatio);
  const bottomPadding = union.height * config.paddingRatio;
  const expanded = {
    height: union.height + topPadding + bottomPadding,
    width: union.width + horizontalPadding * 2,
    x: union.x - horizontalPadding,
    y: union.y - topPadding,
  };
  const side = Math.min(1, Math.max(expanded.width, expanded.height, 1 / config.maximumZoom));
  const centerX = clamp(expanded.x + expanded.width / 2, side / 2, 1 - side / 2);
  const centerY = clamp(expanded.y + expanded.height / 2, side / 2, 1 - side / 2);
  return FaceFramingViewportSchema.parse({
    height: side,
    width: side,
    x: centerX - side / 2,
    y: centerY - side / 2,
  });
}

function viewportZoom(viewport: FaceFramingViewport): number {
  return 1 / viewport.width;
}

function smoothViewport(
  prior: FaceFramingViewport,
  target: FaceFramingViewport,
  elapsedUs: number,
  smoothingTimeUs: number,
): FaceFramingViewport {
  if (smoothingTimeUs === 0 || elapsedUs <= 0) return target;
  const alpha = 1 - Math.exp(-elapsedUs / smoothingTimeUs);
  const priorCenterX = prior.x + prior.width / 2;
  const priorCenterY = prior.y + prior.height / 2;
  const targetCenterX = target.x + target.width / 2;
  const targetCenterY = target.y + target.height / 2;
  const zoom = Math.exp(
    Math.log(viewportZoom(prior))
    + alpha * (Math.log(viewportZoom(target)) - Math.log(viewportZoom(prior))),
  );
  const side = 1 / zoom;
  const centerX = clamp(priorCenterX + alpha * (targetCenterX - priorCenterX), side / 2, 1 - side / 2);
  const centerY = clamp(priorCenterY + alpha * (targetCenterY - priorCenterY), side / 2, 1 - side / 2);
  return FaceFramingViewportSchema.parse({
    height: side,
    width: side,
    x: centerX - side / 2,
    y: centerY - side / 2,
  });
}

function fallbackOrThrow(
  policy: FaceFramingGapPolicy,
  assetTimeUs: number,
): "fallback" {
  if (policy.kind === "fail" || (policy.kind === "hold" && policy.whenExpired === "fail")) {
    throw new TypeError(`Selected face evidence is unavailable at asset time ${assetTimeUs}.`);
  }
  return "fallback";
}

function visibleTrackKey(keyframe: FaceFramingKeyframe): string {
  return keyframe.visibleTrackIds.join("\u0000");
}

function interpolationError(
  keyframes: readonly FaceFramingKeyframe[],
  start: number,
  end: number,
  candidate: number,
): number {
  const first = keyframes[start]!;
  const last = keyframes[end]!;
  const current = keyframes[candidate]!;
  const durationUs = last.assetTimeUs - first.assetTimeUs;
  if (durationUs <= 0) return Number.POSITIVE_INFINITY;
  const progress = (current.assetTimeUs - first.assetTimeUs) / durationUs;
  const firstCenterX = first.viewport.x + first.viewport.width / 2;
  const firstCenterY = first.viewport.y + first.viewport.height / 2;
  const lastCenterX = last.viewport.x + last.viewport.width / 2;
  const lastCenterY = last.viewport.y + last.viewport.height / 2;
  const expectedCenterX = firstCenterX + progress * (lastCenterX - firstCenterX);
  const expectedCenterY = firstCenterY + progress * (lastCenterY - firstCenterY);
  const expectedLogZoom = Math.log(first.zoom) + progress * (Math.log(last.zoom) - Math.log(first.zoom));
  const currentCenterX = current.viewport.x + current.viewport.width / 2;
  const currentCenterY = current.viewport.y + current.viewport.height / 2;
  return Math.max(
    Math.abs(currentCenterX - expectedCenterX),
    Math.abs(currentCenterY - expectedCenterY),
    Math.abs(Math.log(current.zoom) - expectedLogZoom),
  );
}

function retainSimplifiedSegment(
  keyframes: readonly FaceFramingKeyframe[],
  start: number,
  end: number,
  tolerance: number,
  retained: Set<number>,
): void {
  if (end - start <= 1) return;
  let furthestIndex = -1;
  let furthestError = -1;
  for (let index = start + 1; index < end; index += 1) {
    const error = interpolationError(keyframes, start, end, index);
    if (error > furthestError) {
      furthestError = error;
      furthestIndex = index;
    }
  }
  if (furthestIndex < 0 || furthestError <= tolerance) return;
  retained.add(furthestIndex);
  retainSimplifiedSegment(keyframes, start, furthestIndex, tolerance, retained);
  retainSimplifiedSegment(keyframes, furthestIndex, end, tolerance, retained);
}

export function simplifyFaceFramingKeyframes(
  keyframesInput: unknown,
  toleranceInput: unknown,
): readonly FaceFramingKeyframe[] {
  const keyframes = z.array(FaceFramingKeyframeSchema).max(250_002).parse(keyframesInput);
  const tolerance = z.number().finite().nonnegative().max(1).parse(toleranceInput);
  if (keyframes.length <= 2) return keyframes;
  for (let index = 1; index < keyframes.length; index += 1) {
    if (keyframes[index]!.assetTimeUs <= keyframes[index - 1]!.assetTimeUs) {
      throw new TypeError("Face framing keyframe times must increase strictly.");
    }
  }

  const mandatory = new Set<number>([0, keyframes.length - 1]);
  for (let index = 1; index < keyframes.length - 1; index += 1) {
    const prior = keyframes[index - 1]!;
    const current = keyframes[index]!;
    const next = keyframes[index + 1]!;
    if (
      current.source !== prior.source
      || current.source !== next.source
      || visibleTrackKey(current) !== visibleTrackKey(prior)
      || visibleTrackKey(current) !== visibleTrackKey(next)
    ) {
      mandatory.add(index);
    }
  }

  const boundaries = [...mandatory].sort((left, right) => left - right);
  for (let index = 1; index < boundaries.length; index += 1) {
    retainSimplifiedSegment(
      keyframes,
      boundaries[index - 1]!,
      boundaries[index]!,
      tolerance,
      mandatory,
    );
  }
  return [...mandatory].sort((left, right) => left - right).map(index => keyframes[index]!);
}

function keyframe(
  assetTimeUs: number,
  source: FaceFramingKeyframe["source"],
  viewport: FaceFramingViewport,
  visibleTrackIds: readonly FaceTrackId[],
): FaceFramingKeyframe {
  return FaceFramingKeyframeSchema.parse({
    assetTimeUs,
    source,
    viewport,
    visibleTrackIds: [...visibleTrackIds].sort((left, right) => left.localeCompare(right)),
    zoom: viewportZoom(viewport),
  });
}

/**
 * Produces prepared-layer camera evidence. Center is smoothed linearly while
 * zoom is smoothed in log space, which makes push-ins and pull-outs perceptually
 * symmetric.
 */
export function planFaceFraming(inputValue: unknown): readonly FaceFramingKeyframe[] {
  const input = FaceFramingInputSchema.parse(inputValue);
  const frames = [...input.frames]
    .filter(frame => frame.assetTimeUs >= input.range.startUs && frame.assetTimeUs < input.range.endUs)
    .sort((left, right) => left.assetTimeUs - right.assetTimeUs);
  for (let index = 1; index < frames.length; index += 1) {
    if (frames[index]!.assetTimeUs === frames[index - 1]!.assetTimeUs) {
      throw new TypeError("Prepared face frame times must be unique.");
    }
  }
  const selectedTrackIds = [...input.trackIds].sort((left, right) => left.localeCompare(right));
  const selectedTrackIdSet = new Set(selectedTrackIds);
  const fallbackViewport = FaceFramingViewportSchema.parse({ height: 1, width: 1, x: 0, y: 0 });
  const planned: FaceFramingKeyframe[] = [];
  let lastObservedViewport: FaceFramingViewport | null = null;
  let lastObservedAssetTimeUs: number | null = null;

  for (const frame of frames) {
    const visible = frame.state === "analyzed"
      ? frame.detections
        .filter(detection => selectedTrackIdSet.has(detection.trackId))
        .sort((left, right) => left.trackId.localeCompare(right.trackId))
      : [];
    const hasRequiredFaces = visible.length > 0 && (
      !input.config.requireAllSelectedFaces || visible.length === selectedTrackIds.length
    );
    let source: FaceFramingKeyframe["source"];
    let target: FaceFramingViewport;
    if (hasRequiredFaces) {
      target = faceFramingViewport(visible.map(detection => detection.rect), input.config);
      lastObservedViewport = target;
      lastObservedAssetTimeUs = frame.assetTimeUs;
      source = "observed";
    } else if (
      input.config.gapPolicy.kind === "hold"
      && lastObservedViewport !== null
      && lastObservedAssetTimeUs !== null
      && frame.assetTimeUs - lastObservedAssetTimeUs <= input.config.gapPolicy.maximumHoldUs
    ) {
      target = lastObservedViewport;
      source = "held";
    } else {
      fallbackOrThrow(input.config.gapPolicy, frame.assetTimeUs);
      target = fallbackViewport;
      source = "fallback";
    }

    const prior = planned.at(-1);
    const viewport = source === "held" || prior === undefined
      ? target
      : smoothViewport(
        prior.viewport,
        target,
        frame.assetTimeUs - prior.assetTimeUs,
        input.config.smoothingTimeUs,
      );
    planned.push(keyframe(
      frame.assetTimeUs,
      source,
      viewport,
      visible.map(detection => detection.trackId),
    ));
  }

  if (planned.length === 0) {
    fallbackOrThrow(input.config.gapPolicy, input.range.startUs);
    planned.push(keyframe(input.range.startUs, "fallback", fallbackViewport, []));
  } else if (planned[0]!.assetTimeUs > input.range.startUs) {
    planned.unshift(keyframe(
      input.range.startUs,
      "held",
      planned[0]!.viewport,
      planned[0]!.visibleTrackIds,
    ));
  }
  if (planned.at(-1)!.assetTimeUs < input.range.endUs) {
    planned.push(keyframe(
      input.range.endUs,
      "held",
      planned.at(-1)!.viewport,
      planned.at(-1)!.visibleTrackIds,
    ));
  }
  if (planned.length === 1) {
    planned.push(keyframe(input.range.endUs, "held", planned[0]!.viewport, planned[0]!.visibleTrackIds));
  }

  return simplifyFaceFramingKeyframes(planned, input.config.simplificationTolerance);
}
