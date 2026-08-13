import { z } from "zod";

import {
  IsoTimestampSchema,
  MicrosecondsSchema,
  PointSchema,
  RecordingIdSchema,
  RectSchema,
  RepositoryRelativePathSchema,
  Sha256Schema,
  type DeepReadonly,
  type ReadonlyInferred,
} from "./recording";

const EDIT_ID_SUFFIX = /^[a-z0-9][a-z0-9_-]{7,63}$/u;

function editId(prefix: string) {
  return z.string().refine(
    (value) => value.startsWith(prefix) && EDIT_ID_SUFFIX.test(value.slice(prefix.length)),
    `Expected an opaque ${prefix} identifier.`,
  );
}

export const EditPlanIdSchema = editId("plan_").brand<"EditPlanId">();
export const CameraMoveIdSchema = editId("camera_").brand<"CameraMoveId">();
export const ZoomIdSchema = editId("zoom_").brand<"ZoomId">();
export const OverlayIdSchema = editId("overlay_").brand<"OverlayId">();

export const SourceIntervalSchema = z.strictObject({
  endUs: MicrosecondsSchema,
  startUs: MicrosecondsSchema,
}).superRefine((interval, context) => {
  if (interval.endUs <= interval.startUs) {
    context.addIssue({ code: "custom", message: "Interval endUs must be greater than startUs." });
  }
});

export const EasingSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.enum(["linear", "ease-in", "ease-out", "ease-in-out", "spring"]) }),
  z.strictObject({
    kind: z.literal("cubic-bezier"),
    x1: z.number().finite().min(0).max(1),
    x2: z.number().finite().min(0).max(1),
    y1: z.number().finite(),
    y2: z.number().finite(),
  }),
]);

export const CameraPoseSchema = z.strictObject({
  centerX: z.number().finite().min(0).max(1),
  centerY: z.number().finite().min(0).max(1),
  space: z.literal("prepared-video-layer-normalized-v1"),
  zoom: z.number().finite().min(1).max(10),
}).superRefine((pose, context) => {
  const halfViewport = 1 / (2 * pose.zoom);
  if (pose.centerX < halfViewport || pose.centerX > 1 - halfViewport) {
    context.addIssue({
      code: "custom",
      message: "Camera pose centerX would move the viewport outside the prepared video layer.",
    });
  }
  if (pose.centerY < halfViewport || pose.centerY > 1 - halfViewport) {
    context.addIssue({
      code: "custom",
      message: "Camera pose centerY would move the viewport outside the prepared video layer.",
    });
  }
});

export const SpeedRangeSchema = z.strictObject({
  range: SourceIntervalSchema,
  rate: z.number().finite().positive().max(64),
});

export const WindowSelectorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("window-id"), windowId: z.string().min(1).max(256) }),
  z.strictObject({ applicationBundleId: z.string().min(1).max(512), kind: z.literal("application") }),
  z.strictObject({ kind: z.literal("frontmost") }),
]);

export const ZoomTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("rect"), rect: RectSchema }),
  z.strictObject({ kind: z.literal("point"), point: PointSchema }),
  z.strictObject({ kind: z.literal("cursor"), sampling: z.enum(["nearest", "interpolated"]) }),
  z.strictObject({ kind: z.literal("window"), paddingPx: z.number().finite().nonnegative(), selector: WindowSelectorSchema }),
  z.strictObject({ kind: z.literal("focused-input"), paddingPx: z.number().finite().nonnegative() }),
]);

const ZoomBaseShape = {
  displayId: z.string().min(1).max(256),
  easing: EasingSchema,
  enterDurationUs: MicrosecondsSchema,
  exitDurationUs: MicrosecondsSchema,
  range: SourceIntervalSchema,
  scale: z.number().finite().min(1).max(10),
  target: ZoomTargetSchema,
  zoomId: ZoomIdSchema,
} as const;

export const ManualZoomSchema = z.strictObject({
  ...ZoomBaseShape,
  kind: z.literal("manual"),
});

export const AutomaticZoomSchema = z.strictObject({
  ...ZoomBaseShape,
  confidence: z.number().finite().min(0).max(1),
  kind: z.literal("automatic"),
  reason: z.enum(["click", "focus", "typing", "window-change"]),
});

export const AutomaticZoomPlannerConfigSchema = z.strictObject({
  enterDurationUs: MicrosecondsSchema,
  exitDurationUs: MicrosecondsSchema,
  intentMergeGapUs: MicrosecondsSchema,
  maxDurationUs: MicrosecondsSchema,
  maxScale: z.number().finite().min(1).max(10),
  minDurationUs: MicrosecondsSchema,
  postHandleUs: MicrosecondsSchema,
  preHandleUs: MicrosecondsSchema,
  scale: z.number().finite().min(1).max(10),
}).superRefine((config, context) => {
  if (config.maxDurationUs < config.minDurationUs) {
    context.addIssue({ code: "custom", message: "maxDurationUs cannot be less than minDurationUs." });
  }
});

export const ZoomOperationSchema = z.discriminatedUnion("kind", [ManualZoomSchema, AutomaticZoomSchema])
  .superRefine((zoom, context) => {
    if (zoom.enterDurationUs + zoom.exitDurationUs > zoom.range.endUs - zoom.range.startUs) {
      context.addIssue({
        code: "custom",
        message: "Zoom enter and exit durations cannot exceed the zoom range.",
      });
    }
  });

export const AssetProvenanceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("imported"),
    originalName: z.string().min(1).max(1024),
    sourceSha256: Sha256Schema,
  }),
  z.strictObject({
    command: z.array(z.string().min(1)).min(1),
    generator: z.string().min(1).max(256),
    generatorVersion: z.string().min(1).max(128),
    kind: z.literal("generated"),
    sourceSha256: Sha256Schema,
  }),
]);

function assetSchema<const MediaTypes extends readonly [string, ...string[]]>(mediaTypes: MediaTypes) {
  return z.strictObject({
    bytes: z.number().int().safe().positive(),
    mediaType: z.enum(mediaTypes),
    path: RepositoryRelativePathSchema,
    provenance: AssetProvenanceSchema,
    sha256: Sha256Schema,
  });
}

export const ImageAssetSchema = assetSchema(["image/jpeg", "image/png", "image/webp"]);
export const SvgAssetSchema = assetSchema(["image/svg+xml"]);
export const GifAssetSchema = assetSchema(["image/gif"]);
export const VideoAssetSchema = assetSchema(["video/mp4", "video/quicktime", "video/webm"]);
export const EmojiAssetSchema = assetSchema(["image/png", "image/svg+xml"]);

export const AnimatedPlaybackSchema = z.strictObject({
  audioEndUs: z.number().int().safe().min(-86_400_000_000).max(86_400_000_000).nullable().default(null),
  audioStartUs: z.number().int().safe().min(-86_400_000_000).max(86_400_000_000).default(0),
  audioStreamIndex: z.number().int().safe().nonnegative().nullable().default(null),
  endBehavior: z.enum(["hide", "loop", "freeze-end"]),
  playbackRate: z.number().finite().positive().max(64),
  sourceInUs: MicrosecondsSchema,
  sourceOutUs: MicrosecondsSchema,
  streamStartUs: z.number().int().safe().min(-86_400_000_000).max(86_400_000_000).default(0),
  videoStreamIndex: z.number().int().safe().nonnegative().nullable().default(null),
}).superRefine((playback, context) => {
  if (playback.sourceOutUs <= playback.sourceInUs) {
    context.addIssue({ code: "custom", message: "Animated sourceOutUs must be greater than sourceInUs." });
  }
  if (playback.audioEndUs !== null && playback.audioEndUs <= playback.audioStartUs) {
    context.addIssue({ code: "custom", message: "Animated audioEndUs must be greater than audioStartUs." });
  }
});

export const VideoAudioPolicySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("mute") }),
  z.strictObject({ kind: z.literal("mix"), volume: z.number().finite().min(0).max(4) }),
  z.strictObject({
    duckPrimaryTo: z.number().finite().min(0).max(1),
    kind: z.literal("duck-primary"),
    volume: z.number().finite().min(0).max(4),
  }),
]);

export const EmojiSelectorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unicode"), value: z.string().min(1).max(64) }),
  z.strictObject({ kind: z.literal("name"), value: z.string().min(1).max(256) }),
  z.strictObject({ kind: z.literal("id"), value: z.string().regex(/^[a-f0-9]+(?:-[a-f0-9]+)*$/u) }),
]);

export const EmojiOverlaySourceSchema = z.strictObject({
  asset: EmojiAssetSchema,
  kind: z.literal("emoji"),
  provider: z.enum(["apple-emoji-pack", "brand-catalog"]),
  selector: EmojiSelectorSchema,
});

export const OverlaySourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ asset: ImageAssetSchema, kind: z.literal("image") }),
  z.strictObject({ asset: SvgAssetSchema, kind: z.literal("svg") }),
  z.strictObject({
    asset: GifAssetSchema,
    audioPolicy: z.strictObject({ kind: z.literal("mute") }),
    kind: z.literal("gif"),
    playback: AnimatedPlaybackSchema,
  }),
  z.strictObject({
    asset: VideoAssetSchema,
    audioPolicy: VideoAudioPolicySchema,
    kind: z.literal("video"),
    playback: AnimatedPlaybackSchema,
  }),
  EmojiOverlaySourceSchema,
]);

export const OverlayAnchorSchema = z.enum([
  "top-left",
  "top",
  "top-right",
  "left",
  "center",
  "right",
  "bottom-left",
  "bottom",
  "bottom-right",
]);

export const OverlaySizeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("intrinsic") }),
  z.strictObject({
    height: z.number().finite().positive().max(16_384),
    kind: z.literal("pixels"),
    width: z.number().finite().positive().max(16_384),
  }).superRefine((size, context) => {
    if (size.width * size.height > 134_217_728) {
      context.addIssue({ code: "custom", message: "Overlay pixel area exceeds the 128-megapixel safety limit." });
    }
  }),
]);

export const OverlayIntrinsicSizeSchema = z.strictObject({
  height: z.number().int().safe().positive().max(16_384),
  width: z.number().int().safe().positive().max(16_384),
}).superRefine((size, context) => {
  if (size.width * size.height > 134_217_728) {
    context.addIssue({ code: "custom", message: "Overlay intrinsic pixel area exceeds the 128-megapixel safety limit." });
  }
});

export const OverlayCropSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({
    bottom: z.number().finite().min(0).max(1),
    kind: z.literal("normalized-insets"),
    left: z.number().finite().min(0).max(1),
    right: z.number().finite().min(0).max(1),
    top: z.number().finite().min(0).max(1),
  }).superRefine((crop, context) => {
    if (crop.left + crop.right >= 1) {
      context.addIssue({ code: "custom", message: "Overlay horizontal crop insets must leave visible content." });
    }
    if (crop.top + crop.bottom >= 1) {
      context.addIssue({ code: "custom", message: "Overlay vertical crop insets must leave visible content." });
    }
  }),
]);

export const OverlayMaskSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({
    kind: z.literal("rounded-rectangle"),
    radiusPx: z.number().finite().positive().max(16_384),
  }),
]);

export const OverlayTransformKeyframeSchema = z.strictObject({
  easing: EasingSchema,
  offset: z.number().finite().min(0).max(1),
  opacityMultiplier: z.number().finite().min(0).max(1),
  positionOffset: PointSchema,
  rotationOffsetDegrees: z.number().finite().min(-3_600).max(3_600),
  scaleMultiplier: z.number().finite().positive().max(128),
});

export const OverlayMotionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({
    keyframes: z.array(OverlayTransformKeyframeSchema).min(2).max(256),
    kind: z.literal("keyframes"),
    timeline: z.literal("visible-output"),
  }).superRefine((motion, context) => {
    if (motion.keyframes[0]?.offset !== 0 || motion.keyframes.at(-1)?.offset !== 1) {
      context.addIssue({ code: "custom", message: "Overlay motion keyframes must begin at offset 0 and end at offset 1." });
    }
    for (let index = 1; index < motion.keyframes.length; index += 1) {
      if (motion.keyframes[index]!.offset <= motion.keyframes[index - 1]!.offset) {
        context.addIssue({ code: "custom", message: "Overlay motion keyframe offsets must be strictly increasing." });
        break;
      }
    }
  }),
]);

export const OverlayAnimationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({ durationUs: MicrosecondsSchema, easing: EasingSchema, kind: z.literal("fade") }),
  z.strictObject({
    durationUs: MicrosecondsSchema,
    easing: EasingSchema,
    fromScale: z.number().finite().nonnegative().max(32),
    kind: z.literal("scale"),
  }),
  z.strictObject({
    direction: z.enum(["up", "down", "left", "right"]),
    distancePx: z.number().finite().nonnegative().max(32_768),
    durationUs: MicrosecondsSchema,
    easing: EasingSchema,
    kind: z.literal("slide"),
  }),
]);

export const OverlayOperationSchema = z.strictObject({
  anchor: OverlayAnchorSchema,
  blendMode: z.enum(["normal", "addition", "darken", "lighten", "multiply", "overlay", "screen"]).default("normal"),
  coordinateSpace: z.literal("output-pixels").default("output-pixels"),
  crop: OverlayCropSchema.default({ kind: "none" }),
  entrance: OverlayAnimationSchema,
  exit: OverlayAnimationSchema,
  fit: z.enum(["contain", "cover", "fill"]).default("fill"),
  intrinsicSize: OverlayIntrinsicSizeSchema,
  mask: OverlayMaskSchema.default({ kind: "none" }),
  motion: OverlayMotionSchema.default({ kind: "none" }),
  opacity: z.number().finite().min(0).max(1),
  overlayId: OverlayIdSchema,
  position: PointSchema,
  range: SourceIntervalSchema,
  rotationDegrees: z.number().finite().min(-3600).max(3600),
  scale: z.number().finite().positive().max(128),
  size: OverlaySizeSchema,
  source: OverlaySourceSchema,
  zIndex: z.number().int().safe(),
}).superRefine((overlay, context) => {
  const durationUs = overlay.range.endUs - overlay.range.startUs;
  const entranceDurationUs = overlay.entrance.kind === "none" ? 0 : overlay.entrance.durationUs;
  const exitDurationUs = overlay.exit.kind === "none" ? 0 : overlay.exit.durationUs;
  if (entranceDurationUs + exitDurationUs > durationUs) {
    context.addIssue({
      code: "custom",
      message: "Overlay entrance and exit durations cannot exceed the overlay duration.",
    });
  }
  const baseSize = overlay.size.kind === "pixels" ? overlay.size : overlay.intrinsicSize;
  const animationScale = Math.max(
    1,
    overlay.entrance.kind === "scale" ? overlay.entrance.fromScale : 1,
    overlay.exit.kind === "scale" ? overlay.exit.fromScale : 1,
  );
  const motionScale = overlay.motion.kind === "keyframes"
    ? Math.max(1, ...overlay.motion.keyframes.map(keyframe => keyframe.scaleMultiplier))
    : 1;
  const maximumScale = overlay.scale * animationScale * motionScale;
  const width = Math.ceil(baseSize.width * maximumScale);
  const height = Math.ceil(baseSize.height * maximumScale);
  const canRotate = overlay.rotationDegrees !== 0 || (
    overlay.motion.kind === "keyframes"
    && overlay.motion.keyframes.some(keyframe => keyframe.rotationOffsetDegrees !== 0)
  );
  const maximumDimension = canRotate ? width + height : Math.max(width, height);
  const maximumArea = canRotate ? (width + height) ** 2 : width * height;
  if (maximumDimension > 16_384 || maximumArea > 134_217_728) {
    context.addIssue({
      code: "custom",
      message: "Overlay transforms can exceed the 16384-pixel or 128-megapixel render safety limit.",
    });
  }
});

export const CursorEffectSchema = z.discriminatedUnion("enabled", [
  z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({
    enabled: z.literal(true),
    scale: z.number().finite().positive().max(16),
    smoothing: z.strictObject({
      algorithm: z.enum(["exponential", "none"]),
      strength: z.number().finite().min(0).max(1),
    }),
    style: z.enum(["captured", "dot", "ring"]),
  }),
]);

export const ClickEffectSchema = z.discriminatedUnion("enabled", [
  z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({
    color: z.string().regex(/^#[a-fA-F0-9]{6}(?:[a-fA-F0-9]{2})?$/u),
    durationUs: MicrosecondsSchema,
    enabled: z.literal(true),
    radiusPx: z.number().finite().positive().max(4_096),
    style: z.enum(["pulse", "ring", "fill"]),
  }),
]);

export const KeystrokeEffectSchema = z.discriminatedUnion("enabled", [
  z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({
    enabled: z.literal(true),
    holdUs: MicrosecondsSchema,
    maxKeys: z.number().int().safe().positive().max(32),
    position: z.enum(["bottom-left", "bottom-center", "bottom-right"]),
    secureText: z.literal("hide"),
  }),
]);

export const TypedTextEffectSchema = z.discriminatedUnion("enabled", [
  z.strictObject({ enabled: z.literal(false) }),
  z.strictObject({
    enabled: z.literal(true),
    idleTimeoutUs: MicrosecondsSchema,
    maxCharacters: z.number().int().safe().positive().max(4096),
    placement: z.enum(["input", "caption"]),
    secureText: z.literal("hide"),
  }),
]);

function intervalsAreNormalized(intervals: readonly { readonly startUs: number; readonly endUs: number }[]): boolean {
  let priorEnd = -1;
  for (const interval of intervals) {
    if (interval.startUs <= priorEnd) return false;
    priorEnd = interval.endUs;
  }
  return true;
}

function rangesAreOrderedAndDisjoint(
  ranges: readonly { readonly range: { readonly startUs: number; readonly endUs: number } }[],
): boolean {
  let priorEnd = -1;
  for (const { range } of ranges) {
    if (range.startUs < priorEnd) return false;
    priorEnd = range.endUs;
  }
  return true;
}

function zoomRangesAreDisjointPerDisplay(
  zooms: readonly {
    readonly displayId: string;
    readonly range: { readonly startUs: number; readonly endUs: number };
  }[],
): boolean {
  const priorEndByDisplay = new Map<string, number>();
  for (const zoom of [...zooms].sort((left, right) => (
    left.displayId.localeCompare(right.displayId)
    || left.range.startUs - right.range.startUs
    || left.range.endUs - right.range.endUs
  ))) {
    const priorEndUs = priorEndByDisplay.get(zoom.displayId);
    if (priorEndUs !== undefined && zoom.range.startUs < priorEndUs) return false;
    priorEndByDisplay.set(zoom.displayId, zoom.range.endUs);
  }
  return true;
}

function intervalIsKept(
  interval: { readonly startUs: number; readonly endUs: number },
  keep: readonly { readonly startUs: number; readonly endUs: number }[],
): boolean {
  return keep.some(({ startUs, endUs }) => startUs <= interval.startUs && endUs >= interval.endUs);
}

function intervalOverlapsKeep(
  interval: { readonly startUs: number; readonly endUs: number },
  keep: readonly { readonly startUs: number; readonly endUs: number }[],
): boolean {
  return keep.some(({ startUs, endUs }) => startUs < interval.endUs && endUs > interval.startUs);
}

export const EditPlanV1Schema = z.strictObject({
  baseSpeed: z.number().finite().positive().max(64),
  createdAt: IsoTimestampSchema,
  effects: z.strictObject({
    clicks: ClickEffectSchema,
    cursor: CursorEffectSchema,
    keystrokes: KeystrokeEffectSchema,
    typedText: TypedTextEffectSchema,
  }),
  keep: z.array(SourceIntervalSchema),
  kind: z.union([
    z.literal("transmute.edit-plan"),
    z.literal("studio.edit-plan"),
  ]),
  overlays: z.array(OverlayOperationSchema),
  planId: EditPlanIdSchema,
  recordingId: RecordingIdSchema,
  schemaVersion: z.literal(1),
  sourceDurationUs: MicrosecondsSchema,
  speed: z.array(SpeedRangeSchema),
  updatedAt: IsoTimestampSchema,
  zooms: z.array(ZoomOperationSchema),
}).superRefine((plan, context) => {
  if (Date.parse(plan.updatedAt) < Date.parse(plan.createdAt)) {
    context.addIssue({ code: "custom", message: "updatedAt cannot precede createdAt." });
  }
  if (!intervalsAreNormalized(plan.keep)) {
    context.addIssue({ code: "custom", message: "Keep intervals must be sorted, disjoint, and non-adjacent." });
  }
  if (plan.keep.some(({ endUs }) => endUs > plan.sourceDurationUs)) {
    context.addIssue({ code: "custom", message: "Keep intervals cannot exceed sourceDurationUs." });
  }
  if (!rangesAreOrderedAndDisjoint(plan.speed)) {
    context.addIssue({ code: "custom", message: "Speed ranges must be sorted and non-overlapping." });
  }
  if (plan.speed.some(({ range }) => !intervalIsKept(range, plan.keep))) {
    context.addIssue({ code: "custom", message: "Every speed range must be contained in one keep interval." });
  }
  if (plan.speed.some(({ rate }) => rate === plan.baseSpeed)) {
    context.addIssue({ code: "custom", message: "Speed ranges equal to baseSpeed are redundant." });
  }
  if (plan.zooms.some(({ range }) => !intervalOverlapsKeep(range, plan.keep))) {
    context.addIssue({ code: "custom", message: "Every zoom range must overlap kept source time." });
  }
  if (!zoomRangesAreDisjointPerDisplay(plan.zooms)) {
    context.addIssue({
      code: "custom",
      message: "Zoom ranges on the same display must not overlap; resolve manual and automatic precedence before saving.",
    });
  }
  if (plan.overlays.some(({ range }) => !intervalOverlapsKeep(range, plan.keep))) {
    context.addIssue({ code: "custom", message: "Every overlay range must overlap kept source time." });
  }
  for (const [label, ids] of [
    ["Zoom IDs", plan.zooms.map(({ zoomId }) => String(zoomId))],
    ["Overlay IDs", plan.overlays.map(({ overlayId }) => String(overlayId))],
  ] satisfies readonly (readonly [string, readonly string[]])[]) {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: `${label} must be unique.` });
    }
  }
});

export type SourceInterval = ReadonlyInferred<typeof SourceIntervalSchema>;
export type SpeedRange = ReadonlyInferred<typeof SpeedRangeSchema>;
export type CameraPose = ReadonlyInferred<typeof CameraPoseSchema>;
export type Easing = ReadonlyInferred<typeof EasingSchema>;
export type ZoomTarget = ReadonlyInferred<typeof ZoomTargetSchema>;
export type WindowSelector = ReadonlyInferred<typeof WindowSelectorSchema>;
export type ZoomOperation = ReadonlyInferred<typeof ZoomOperationSchema>;
export type AutomaticZoom = ReadonlyInferred<typeof AutomaticZoomSchema>;
export type AutomaticZoomPlannerConfig = ReadonlyInferred<typeof AutomaticZoomPlannerConfigSchema>;
export type OverlaySource = ReadonlyInferred<typeof OverlaySourceSchema>;
export type OverlayIntrinsicSize = ReadonlyInferred<typeof OverlayIntrinsicSizeSchema>;
export type EmojiOverlaySource = ReadonlyInferred<typeof EmojiOverlaySourceSchema>;
export type OverlayCrop = ReadonlyInferred<typeof OverlayCropSchema>;
export type OverlayMask = ReadonlyInferred<typeof OverlayMaskSchema>;
export type OverlayMotion = ReadonlyInferred<typeof OverlayMotionSchema>;
export type OverlayTransformKeyframe = ReadonlyInferred<typeof OverlayTransformKeyframeSchema>;
export type OverlayOperation = DeepReadonly<z.input<typeof OverlayOperationSchema>>;
export type EditPlanV1 = ReadonlyInferred<typeof EditPlanV1Schema>;
export type EditPlanDraft = DeepReadonly<z.input<typeof EditPlanV1Schema>>;
export type EmojiSelector = ReadonlyInferred<typeof EmojiSelectorSchema>;

export function parseEditPlanV1(input: unknown): EditPlanV1 {
  return EditPlanV1Schema.parse(input);
}
