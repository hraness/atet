import { z } from "zod";

import {
  CameraMoveIdSchema,
  CameraPoseSchema,
  EasingSchema,
  OverlayOperationSchema,
  SourceIntervalSchema,
} from "./edit";
import {
  AnalysisIdSchema,
  ProjectAssetIdSchema,
  ProjectAudioPresentationSchema,
  ProjectPlacementIdSchema,
  ProjectStreamIdSchema,
  ProjectVideoPresentationSchema,
  VideoProjectIdSchema,
} from "./project";
import {
  IsoTimestampSchema,
  RepositoryRelativePathSchema,
  Sha256Schema,
  type ReadonlyInferred,
} from "./recording";
import {
  CameraKeyframeSchema,
  OutputIntervalSchema,
  RenderEffectsSchema,
  Yuv420pDimensionSchema,
} from "./render";

export const PROJECT_EXPORT_PROFILE_IDS = [
  "landscape",
  "portrait",
  "square",
  "feed-portrait",
] as const;

export const ProjectExportProfileIdSchema = z.enum(
  PROJECT_EXPORT_PROFILE_IDS,
);

export const ProjectExportAspectSchema = z.enum([
  "16:9",
  "9:16",
  "1:1",
  "4:5",
]);

export const ProjectExportProfileSchema = z.strictObject({
  aspect: ProjectExportAspectSchema,
  frameRate: z.number().finite().positive().max(240),
  id: ProjectExportProfileIdSchema,
  pixelHeight: Yuv420pDimensionSchema,
  pixelWidth: Yuv420pDimensionSchema,
});

export const PROJECT_EXPORT_PROFILES = Object.freeze({
  "feed-portrait": Object.freeze(ProjectExportProfileSchema.parse({
    aspect: "4:5",
    frameRate: 30,
    id: "feed-portrait",
    pixelHeight: 1_350,
    pixelWidth: 1_080,
  })),
  landscape: Object.freeze(ProjectExportProfileSchema.parse({
    aspect: "16:9",
    frameRate: 30,
    id: "landscape",
    pixelHeight: 1_080,
    pixelWidth: 1_920,
  })),
  portrait: Object.freeze(ProjectExportProfileSchema.parse({
    aspect: "9:16",
    frameRate: 30,
    id: "portrait",
    pixelHeight: 1_920,
    pixelWidth: 1_080,
  })),
  square: Object.freeze(ProjectExportProfileSchema.parse({
    aspect: "1:1",
    frameRate: 30,
    id: "square",
    pixelHeight: 1_080,
    pixelWidth: 1_080,
  })),
} satisfies Readonly<Record<
  z.infer<typeof ProjectExportProfileIdSchema>,
  z.infer<typeof ProjectExportProfileSchema>
>>);

/**
 * Canvas geometry and render effort are independent decisions. A named
 * preview profile keeps the complete project clock and canvas aspect while
 * reducing pixels and frames; a final profile preserves its declared canvas.
 * A custom canvas is already exact, so its tier selects the encoder recipe
 * without silently rewriting caller-owned dimensions or cadence.
 */
export const PROJECT_RENDER_TIERS = ["preview", "final"] as const;

export const ProjectRenderTierSchema = z.enum(PROJECT_RENDER_TIERS);

export const ProjectRenderGeometrySchema = z.strictObject({
  frameRate: z.number().finite().positive().max(240),
  pixelHeight: Yuv420pDimensionSchema,
  pixelWidth: Yuv420pDimensionSchema,
});

export const ProjectRenderCanvasSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("profile"),
    profileId: ProjectExportProfileIdSchema,
  }),
  ProjectRenderGeometrySchema.extend({
    kind: z.literal("custom"),
  }).strict(),
]);

export const ProjectRenderTargetSchema = z.strictObject({
  canvas: ProjectRenderCanvasSchema,
  tier: ProjectRenderTierSchema,
});

export const ProjectRenderEncoderRecipeSchema = z.strictObject({
  audio: z.strictObject({
    bitrate: z.enum(["128k", "192k"]),
    codec: z.literal("aac"),
  }),
  container: z.strictObject({
    format: z.literal("mp4"),
    movflags: z.literal("+faststart"),
  }),
  decoderThreads: z.literal(1),
  filterComplexThreads: z.literal(1),
  filterThreads: z.literal(1),
  kind: z.union([
    z.literal("atet.project-render-encoder-recipe"),
  ]),
  schemaVersion: z.literal(1),
  tier: ProjectRenderTierSchema,
  video: z.strictObject({
    codec: z.literal("libx264"),
    crf: z.union([z.literal(18), z.literal(28)]),
    pixelFormat: z.literal("yuv420p"),
    preset: z.enum(["medium", "veryfast"]),
    threads: z.literal(1),
  }),
}).superRefine((recipe, context) => {
  const expected = recipe.tier === "preview"
    ? { audioBitrate: "128k", crf: 28, preset: "veryfast" }
    : { audioBitrate: "192k", crf: 18, preset: "medium" };
  if (
    recipe.audio.bitrate !== expected.audioBitrate
    || recipe.video.crf !== expected.crf
    || recipe.video.preset !== expected.preset
  ) {
    context.addIssue({
      code: "custom",
      message: "Project render encoder recipe does not match its declared tier.",
    });
  }
});

export const PROJECT_RENDER_ENCODER_RECIPES = Object.freeze({
  final: Object.freeze(ProjectRenderEncoderRecipeSchema.parse({
    audio: { bitrate: "192k", codec: "aac" },
    container: { format: "mp4", movflags: "+faststart" },
    decoderThreads: 1,
    filterComplexThreads: 1,
    filterThreads: 1,
    kind: "atet.project-render-encoder-recipe",
    schemaVersion: 1,
    tier: "final",
    video: {
      codec: "libx264",
      crf: 18,
      pixelFormat: "yuv420p",
      preset: "medium",
      threads: 1,
    },
  })),
  preview: Object.freeze(ProjectRenderEncoderRecipeSchema.parse({
    audio: { bitrate: "128k", codec: "aac" },
    container: { format: "mp4", movflags: "+faststart" },
    decoderThreads: 1,
    filterComplexThreads: 1,
    filterThreads: 1,
    kind: "atet.project-render-encoder-recipe",
    schemaVersion: 1,
    tier: "preview",
    video: {
      codec: "libx264",
      crf: 28,
      pixelFormat: "yuv420p",
      preset: "veryfast",
      threads: 1,
    },
  })),
} satisfies Readonly<Record<
  z.infer<typeof ProjectRenderTierSchema>,
  z.infer<typeof ProjectRenderEncoderRecipeSchema>
>>);

export function resolveProjectRenderEncoderRecipe(
  tier: z.infer<typeof ProjectRenderTierSchema>,
): z.infer<typeof ProjectRenderEncoderRecipeSchema> {
  return PROJECT_RENDER_ENCODER_RECIPES[ProjectRenderTierSchema.parse(tier)];
}

export const ProjectExportCaptionModeSchema = z.enum([
  "clean",
  "burn-in",
]);

export const ProjectExportVariantSchema = z.strictObject({
  captionMode: ProjectExportCaptionModeSchema,
  profileId: ProjectExportProfileIdSchema,
  tier: ProjectRenderTierSchema,
});

export const ProjectResolvedExportProfileSchema =
  ProjectExportProfileSchema.extend({
    tier: ProjectRenderTierSchema,
  }).strict();

export const PROJECT_PREVIEW_EXPORT_PROFILES = Object.freeze({
  "feed-portrait": Object.freeze(ProjectResolvedExportProfileSchema.parse({
    aspect: "4:5",
    frameRate: 24,
    id: "feed-portrait",
    pixelHeight: 540,
    pixelWidth: 432,
    tier: "preview",
  })),
  landscape: Object.freeze(ProjectResolvedExportProfileSchema.parse({
    aspect: "16:9",
    frameRate: 24,
    id: "landscape",
    pixelHeight: 540,
    pixelWidth: 960,
    tier: "preview",
  })),
  portrait: Object.freeze(ProjectResolvedExportProfileSchema.parse({
    aspect: "9:16",
    frameRate: 24,
    id: "portrait",
    pixelHeight: 960,
    pixelWidth: 540,
    tier: "preview",
  })),
  square: Object.freeze(ProjectResolvedExportProfileSchema.parse({
    aspect: "1:1",
    frameRate: 24,
    id: "square",
    pixelHeight: 540,
    pixelWidth: 540,
    tier: "preview",
  })),
} satisfies Readonly<Record<
  z.infer<typeof ProjectExportProfileIdSchema>,
  z.infer<typeof ProjectResolvedExportProfileSchema>
>>);

export const PROJECT_FINAL_EXPORT_PROFILES = Object.freeze(
  Object.fromEntries(Object.entries(PROJECT_EXPORT_PROFILES).map(
    ([id, profile]) => [
      id,
      Object.freeze(ProjectResolvedExportProfileSchema.parse({
        ...profile,
        tier: "final",
      })),
    ],
  )) as Readonly<Record<
    z.infer<typeof ProjectExportProfileIdSchema>,
    z.infer<typeof ProjectResolvedExportProfileSchema>
  >>,
);

export const PROJECT_RENDER_PROFILES = Object.freeze({
  final: PROJECT_FINAL_EXPORT_PROFILES,
  preview: PROJECT_PREVIEW_EXPORT_PROFILES,
});

export function resolveProjectExportProfile(
  profileId: z.infer<typeof ProjectExportProfileIdSchema>,
  tier: z.infer<typeof ProjectRenderTierSchema>,
): z.infer<typeof ProjectResolvedExportProfileSchema> {
  return PROJECT_RENDER_PROFILES[tier][profileId];
}

export function resolveProjectRenderTarget(
  value: z.input<typeof ProjectRenderTargetSchema>,
): z.infer<typeof ProjectRenderGeometrySchema> {
  const target = ProjectRenderTargetSchema.parse(value);
  if (target.canvas.kind === "custom") {
    return ProjectRenderGeometrySchema.parse({
      frameRate: target.canvas.frameRate,
      pixelHeight: target.canvas.pixelHeight,
      pixelWidth: target.canvas.pixelWidth,
    });
  }
  const profile = resolveProjectExportProfile(
    target.canvas.profileId,
    target.tier,
  );
  return ProjectRenderGeometrySchema.parse({
    frameRate: profile.frameRate,
    pixelHeight: profile.pixelHeight,
    pixelWidth: profile.pixelWidth,
  });
}

export function projectExportVariantId(
  value: z.input<typeof ProjectExportVariantSchema>,
): string {
  const variant = ProjectExportVariantSchema.parse(value);
  return `${variant.tier}-${variant.profileId}-${variant.captionMode}`;
}

export const ProjectCaptionStylePresetSchema = z.enum([
  "social-block-v1",
]);

/**
 * Select one immutable local speech analysis and the exact project placement
 * whose sync map should place those words on the rendered output clock.
 */
export const ProjectCaptionRequestSchema = z.strictObject({
  analysisId: AnalysisIdSchema,
  placementId: ProjectPlacementIdSchema,
  style: ProjectCaptionStylePresetSchema.default("social-block-v1"),
});

const ResolvedSliceBaseShape = {
  assetId: ProjectAssetIdSchema,
  assetRange: SourceIntervalSchema,
  bytes: z.number().int().safe().positive(),
  codec: z.string().min(1).max(128),
  container: z.string().min(1).max(64),
  fileRange: SourceIntervalSchema,
  outputRange: OutputIntervalSchema,
  path: RepositoryRelativePathSchema,
  placementId: ProjectPlacementIdSchema,
  projectRange: SourceIntervalSchema,
  projectSpeed: z.number().finite().positive().max(64),
  sha256: Sha256Schema,
  streamId: ProjectStreamIdSchema,
  streamIndex: z.number().int().safe().nonnegative(),
} as const;

export const ResolvedProjectVideoSliceSchema = z.strictObject({
  ...ResolvedSliceBaseShape,
  kind: z.literal("video"),
  presentation: ProjectVideoPresentationSchema,
  role: z.enum(["screen", "camera", "b-roll", "other"]),
});

export const ResolvedProjectAudioSliceSchema = z.strictObject({
  ...ResolvedSliceBaseShape,
  kind: z.literal("audio"),
  presentation: ProjectAudioPresentationSchema,
  role: z.enum(["system-audio", "microphone", "portable-audio", "music", "dialogue", "other"]),
});

export const ResolvedProjectOverlaySchema = z.strictObject({
  operation: OverlayOperationSchema,
  outputRange: OutputIntervalSchema,
  playbackOffsetUs: z.number().int().safe().nonnegative(),
  projectRange: SourceIntervalSchema,
  visibleDurationUs: z.number().int().safe().positive(),
});

export const ProjectCameraKeyframeSchema = CameraKeyframeSchema.extend({
  displayId: z.string().min(1).max(256),
  layerPixelHeight: z.number().int().safe().positive().max(16_384),
  layerPixelWidth: z.number().int().safe().positive().max(16_384),
  placementId: ProjectPlacementIdSchema,
  streamId: ProjectStreamIdSchema,
}).strict().superRefine((keyframe, context) => {
  if (
    keyframe.viewport.x < 0
    || keyframe.viewport.y < 0
    || keyframe.viewport.x + keyframe.viewport.width > keyframe.layerPixelWidth + 0.001
    || keyframe.viewport.y + keyframe.viewport.height > keyframe.layerPixelHeight + 0.001
  ) {
    context.addIssue({ code: "custom", message: "Project camera viewport must remain inside its video layer." });
  }
});

export const ProjectCameraSegmentTransformSchema = z.strictObject({
  activeProjectRange: SourceIntervalSchema,
  fromPose: CameraPoseSchema,
  interpolationProjectRange: SourceIntervalSchema,
  outgoingEasing: EasingSchema,
  toPose: CameraPoseSchema,
}).superRefine((transform, context) => {
  if (
    transform.activeProjectRange.startUs < transform.interpolationProjectRange.startUs
    || transform.activeProjectRange.endUs > transform.interpolationProjectRange.endUs
  ) {
    context.addIssue({
      code: "custom",
      message: "Camera transform active project range must stay inside its interpolation range.",
    });
  }
});

export const ProjectCameraSegmentSchema = z.strictObject({
  assetRange: SourceIntervalSchema,
  cameraMoveId: CameraMoveIdSchema,
  geometrySha256: Sha256Schema,
  layerPixelHeight: z.number().int().safe().positive().max(16_384),
  layerPixelWidth: z.number().int().safe().positive().max(16_384),
  outputRange: OutputIntervalSchema,
  placementId: ProjectPlacementIdSchema,
  projectRange: SourceIntervalSchema,
  streamId: ProjectStreamIdSchema,
  syncSha256: Sha256Schema,
  transforms: z.array(ProjectCameraSegmentTransformSchema).min(1).max(4_095),
}).superRefine((segment, context) => {
  if (
    segment.transforms[0]?.activeProjectRange.startUs !== segment.projectRange.startUs
    || segment.transforms.at(-1)?.activeProjectRange.endUs !== segment.projectRange.endUs
  ) {
    context.addIssue({
      code: "custom",
      message: "Camera segment transforms must cover both segment project range endpoints.",
    });
  }
  for (let index = 1; index < segment.transforms.length; index += 1) {
    if (
      segment.transforms[index]!.activeProjectRange.startUs
      !== segment.transforms[index - 1]!.activeProjectRange.endUs
    ) {
      context.addIssue({
        code: "custom",
        message: "Camera segment transform active ranges must be ordered and contiguous.",
      });
      break;
    }
  }
});

export const ProjectRenderPlanV1Schema = z.strictObject({
  audioSlices: z.array(ResolvedProjectAudioSliceSchema),
  cameraKeyframes: z.array(ProjectCameraKeyframeSchema).max(100_000),
  cameraSegments: z.array(ProjectCameraSegmentSchema).max(100_000),
  effects: RenderEffectsSchema,
  kind: z.union([
    z.literal("atet.project-render-plan"),
    z.literal("studio.project-render-plan"),
  ]),
  output: z.strictObject({
    background: z.string().regex(/^#[a-fA-F0-9]{6}(?:[a-fA-F0-9]{2})?$/u),
    durationUs: z.number().int().safe().nonnegative(),
    frameRate: z.number().finite().positive().max(240),
    pixelHeight: Yuv420pDimensionSchema,
    pixelWidth: Yuv420pDimensionSchema,
  }).superRefine((output, context) => {
    if (output.pixelWidth * output.pixelHeight > 134_217_728) {
      context.addIssue({ code: "custom", message: "Project render output exceeds the 128-megapixel safety limit." });
    }
  }),
  overlays: z.array(ResolvedProjectOverlaySchema),
  planSha256: Sha256Schema,
  projectEditPlanSha256: Sha256Schema,
  projectId: VideoProjectIdSchema,
  projectStructureSha256: Sha256Schema,
  schemaVersion: z.literal(1),
  videoSlices: z.array(ResolvedProjectVideoSliceSchema),
  warnings: z.array(z.strictObject({
    code: z.enum(["unverified-sync", "disabled-placement", "missing-media-coverage"]),
    message: z.string().min(1).max(2_048),
    placementId: ProjectPlacementIdSchema,
  })),
}).superRefine((plan, context) => {
  const integrityByPath = new Map<string, { readonly bytes: number; readonly sha256: string }>();
  for (const slice of [...plan.videoSlices, ...plan.audioSlices]) {
    if (slice.outputRange.endUs > plan.output.durationUs) {
      context.addIssue({ code: "custom", message: `Slice ${slice.streamId} exceeds output duration.` });
    }
    if (
      slice.assetRange.endUs - slice.assetRange.startUs
      !== slice.fileRange.endUs - slice.fileRange.startUs
    ) {
      context.addIssue({ code: "custom", message: `Slice ${slice.streamId} asset and file durations must match.` });
    }
    const prior = integrityByPath.get(slice.path);
    if (prior !== undefined && (prior.bytes !== slice.bytes || prior.sha256 !== slice.sha256)) {
      context.addIssue({ code: "custom", message: `Slices for ${slice.path} must agree on whole-file integrity.` });
    }
    integrityByPath.set(slice.path, { bytes: slice.bytes, sha256: slice.sha256 });
  }
  if (plan.overlays.some(overlay => overlay.outputRange.endUs > plan.output.durationUs)) {
    context.addIssue({ code: "custom", message: "Resolved overlay exceeds output duration." });
  }
  if (plan.cameraKeyframes.some(keyframe => keyframe.outputTimeUs > plan.output.durationUs)) {
    context.addIssue({ code: "custom", message: "Project camera keyframe exceeds output duration." });
  }
  if (plan.cameraSegments.some(segment => segment.outputRange.endUs > plan.output.durationUs)) {
    context.addIssue({ code: "custom", message: "Project camera segment exceeds output duration." });
  }
  const cameraTransformCount = plan.cameraSegments.reduce(
    (count, segment) => count + segment.transforms.length,
    0,
  );
  if (cameraTransformCount > 100_000) {
    context.addIssue({ code: "custom", message: "Project camera segment transform limit exceeded." });
  }
  const effectTimes = [
    ...plan.effects.cursorSamples.map(sample => sample.outputTimeUs),
    ...plan.effects.clickCues.map(cue => cue.outputTimeUs),
    ...plan.effects.keystrokeCues.map(cue => cue.outputTimeUs),
    ...plan.effects.typingSpans.flatMap(span => span.secure
      ? [span.startOutputUs, span.endOutputUs]
      : [span.startOutputUs, span.endOutputUs, ...span.updates.map(update => update.outputTimeUs)]),
  ];
  if (effectTimes.some(timeUs => timeUs > plan.output.durationUs)) {
    context.addIssue({ code: "custom", message: "Resolved metadata effect exceeds output duration." });
  }
});

export const ProjectRenderInvocationSchema = z.strictObject({
  arguments: z.array(z.string()),
  executable: z.literal("ffmpeg"),
  filterGraph: z.strictObject({
    bytes: z.number().int().safe().positive().max(32 * 1024 * 1024),
    path: RepositoryRelativePathSchema,
    sha256: Sha256Schema,
  }),
  outputPath: RepositoryRelativePathSchema,
  renderPlanSha256: Sha256Schema,
});

export const ProjectRenderOutputPathSchema = RepositoryRelativePathSchema
  .refine(
    path => path.length <= 512,
    "Workflow project render output paths may contain at most 512 characters.",
  )
  .refine(
    path => {
      const segments = path.split("/");
      const leaf = segments.at(-1) ?? "";
      const reserved = new Set([
        ".filter-graphs",
        ".overlay-cache",
        ".staging",
        "caption-assets",
        "plans",
        "receipts",
      ]);
      return segments[0] === "renders"
        && segments.length >= 2
        && !reserved.has(segments[1]!.toLowerCase())
        && leaf.toLowerCase() !== ".mp4"
        && leaf.endsWith(".mp4");
    },
    "Workflow project render outputs must be final lowercase .mp4 files under a non-reserved renders/ path.",
  );

export const ProjectRenderOutputRequestSchema = z.strictObject({
  maximumBytes: z.number().int().safe().positive().max(1_099_511_627_776),
  path: ProjectRenderOutputPathSchema,
});

export const ProjectRenderSyncPolicySchema = z.enum([
  "require-verified",
  "allow-unverified",
]);

export const ProjectRenderToolIdentitySchema = z.strictObject({
  bytes: z.number().int().safe().positive().max(512 * 1024 * 1024),
  command: z.string().min(1).max(4_096).refine(
    command => !command.includes("\0"),
    "Render tool commands cannot contain NUL bytes.",
  ),
  executablePath: z.string().min(1).max(4_096).refine(
    path => path.startsWith("/") && !path.includes("\0"),
    "Render tool executable paths must be absolute and NUL-free.",
  ),
  executableSha256: Sha256Schema,
  name: z.enum(["ffmpeg", "ffprobe", "rsvg-convert"]),
  version: z.string().trim().min(1).max(300),
});

export const ProjectRenderToolchainSchema = z.strictObject({
  ffmpeg: ProjectRenderToolIdentitySchema.refine(
    identity => identity.name === "ffmpeg",
    "The FFmpeg tool identity must name ffmpeg.",
  ),
  ffprobe: ProjectRenderToolIdentitySchema.refine(
    identity => identity.name === "ffprobe",
    "The FFprobe tool identity must name ffprobe.",
  ),
  rsvgConvert: ProjectRenderToolIdentitySchema.refine(
    identity => identity.name === "rsvg-convert",
    "The SVG renderer tool identity must name rsvg-convert.",
  ).nullable(),
});

export const ProjectRenderReceiptV1Schema = z.strictObject({
  createdAt: IsoTimestampSchema,
  kind: z.union([
    z.literal("atet.project-render-receipt"),
    z.literal("studio.project-render-receipt"),
  ]),
  output: z.strictObject({
    bytes: z.number().int().safe().positive(),
    path: RepositoryRelativePathSchema,
    sha256: Sha256Schema,
  }),
  plan: z.strictObject({
    path: RepositoryRelativePathSchema,
    sha256: Sha256Schema,
  }),
  projectId: VideoProjectIdSchema,
  schemaVersion: z.literal(1),
});

export type ResolvedProjectVideoSlice = ReadonlyInferred<typeof ResolvedProjectVideoSliceSchema>;
export type ResolvedProjectAudioSlice = ReadonlyInferred<typeof ResolvedProjectAudioSliceSchema>;
export type ResolvedProjectOverlay = ReadonlyInferred<typeof ResolvedProjectOverlaySchema>;
export type ProjectCameraKeyframe = ReadonlyInferred<typeof ProjectCameraKeyframeSchema>;
export type ProjectCameraSegment = ReadonlyInferred<typeof ProjectCameraSegmentSchema>;
export type ProjectCameraSegmentTransform = ReadonlyInferred<typeof ProjectCameraSegmentTransformSchema>;
export type ProjectRenderPlanV1 = ReadonlyInferred<typeof ProjectRenderPlanV1Schema>;
export type ProjectRenderInvocation = ReadonlyInferred<typeof ProjectRenderInvocationSchema>;
export type ProjectRenderOutputPath = ReadonlyInferred<typeof ProjectRenderOutputPathSchema>;
export type ProjectRenderOutputRequest = ReadonlyInferred<typeof ProjectRenderOutputRequestSchema>;
export type ProjectRenderSyncPolicy = ReadonlyInferred<typeof ProjectRenderSyncPolicySchema>;
export type ProjectRenderToolIdentity = ReadonlyInferred<typeof ProjectRenderToolIdentitySchema>;
export type ProjectRenderToolchain = ReadonlyInferred<typeof ProjectRenderToolchainSchema>;
export type ProjectRenderReceiptV1 = ReadonlyInferred<typeof ProjectRenderReceiptV1Schema>;
export type ProjectExportProfileId = ReadonlyInferred<typeof ProjectExportProfileIdSchema>;
export type ProjectExportProfile = ReadonlyInferred<typeof ProjectExportProfileSchema>;
export type ProjectRenderTier = ReadonlyInferred<typeof ProjectRenderTierSchema>;
export type ProjectRenderEncoderRecipe = ReadonlyInferred<typeof ProjectRenderEncoderRecipeSchema>;
export type ProjectRenderGeometry = ReadonlyInferred<typeof ProjectRenderGeometrySchema>;
export type ProjectRenderCanvas = ReadonlyInferred<typeof ProjectRenderCanvasSchema>;
export type ProjectRenderTarget = ReadonlyInferred<typeof ProjectRenderTargetSchema>;
export type ProjectExportCaptionMode = ReadonlyInferred<typeof ProjectExportCaptionModeSchema>;
export type ProjectExportVariant = ReadonlyInferred<typeof ProjectExportVariantSchema>;
export type ProjectResolvedExportProfile = ReadonlyInferred<typeof ProjectResolvedExportProfileSchema>;
export type ProjectCaptionRequest = ReadonlyInferred<typeof ProjectCaptionRequestSchema>;
