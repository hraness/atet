import { z } from "zod";

import { SpatialDigestSchema, SpatialFrameRateSchema, SpatialTimeUsSchema } from "../../../src/spatial-scene/contracts";
import { reduceSpatialFrameRate, spatialFrameCount } from "../../../src/spatial-scene/time";

export const SPATIAL_COMPOSITOR_LIMITS = Object.freeze({ frames: 864_000, probeBytes: 64 * 1024 * 1024, outputBytes: 256 * 1024 * 1024, timeoutMs: 120_000 });

/** An outer adapter preserves the meaning of all existing V1 numeric plan hashes. */
export const SpatialCompositorCadenceV1Schema = z.strictObject({
  kind: z.literal("atet.spatial-compositor-cadence"),
  schemaVersion: z.literal(1),
  projectionSha256: SpatialDigestSchema,
  compositionPlanSha256: SpatialDigestSchema,
  frameRate: SpatialFrameRateSchema,
  durationUs: SpatialTimeUsSchema.refine(value => value > 0),
  frameCount: z.number().int().positive().max(SPATIAL_COMPOSITOR_LIMITS.frames),
}).superRefine((cadence, context) => {
  const rate = reduceSpatialFrameRate(cadence.frameRate);
  // MOV video_track_timescale and FFmpeg AVRational are signed 32-bit integers.
  if (rate.numerator !== cadence.frameRate.numerator || rate.denominator !== cadence.frameRate.denominator
    || rate.numerator > 2_147_483_647 || rate.denominator > 2_147_483_647
    || rate.numerator / rate.denominator > 240
    || spatialFrameCount(cadence.durationUs, rate) !== cadence.frameCount) {
    context.addIssue({ code: "custom", message: "Compositor cadence requires a reduced, container-representable rate and exact half-open frame count." });
  }
});
export const SpatialCompositorCadenceBindingV1Schema = z.strictObject({
  cadence: SpatialCompositorCadenceV1Schema,
  cadenceSha256: SpatialDigestSchema,
});
const UnsignedIntegerString = z.string().regex(/^(?:0|[1-9][0-9]{0,24})$/u);
export const SpatialCompositorVideoProfileSchema = z.strictObject({
  pixelWidth: z.number().int().positive().max(16_384).multipleOf(2),
  pixelHeight: z.number().int().positive().max(16_384).multipleOf(2),
  pixelFormat: z.literal("yuv420p"),
}).refine(value => value.pixelWidth * value.pixelHeight <= 33_554_432, "Compositor video exceeds the admitted output pixel budget.");
export const SpatialCompositorTimingVerificationV1Schema = z.strictObject({
  kind: z.literal("atet.spatial-compositor-timing-verification"),
  schemaVersion: z.literal(1),
  cadenceSha256: SpatialDigestSchema,
  profile: z.literal("mp4-h264-cfr-integer-pts-v1"),
  video: SpatialCompositorVideoProfileSchema,
  frameRate: SpatialFrameRateSchema,
  frameCount: z.number().int().positive().max(SPATIAL_COMPOSITOR_LIMITS.frames),
  timeBase: z.strictObject({ numerator: UnsignedIntegerString, denominator: UnsignedIntegerString }),
  firstPts: UnsignedIntegerString,
  lastPts: UnsignedIntegerString,
  stepPts: UnsignedIntegerString,
  durationTs: UnsignedIntegerString,
  authoredDurationUs: SpatialTimeUsSchema,
  encodedVideoDurationUs: z.strictObject({ numerator: UnsignedIntegerString, denominator: UnsignedIntegerString }),
  audio: z.strictObject({ sampleRate: z.literal(48_000), durationTs: UnsignedIntegerString, timeBase: z.literal("1/48000"), durationToleranceSamples: z.literal(1) }),
});

export type SpatialCompositorCadenceV1 = Readonly<z.infer<typeof SpatialCompositorCadenceV1Schema>>;
export type SpatialCompositorCadenceBindingV1 = Readonly<z.infer<typeof SpatialCompositorCadenceBindingV1Schema>>;
export type SpatialCompositorTimingVerificationV1 = Readonly<z.infer<typeof SpatialCompositorTimingVerificationV1Schema>>;
export type SpatialCompositorVideoProfile = Readonly<z.infer<typeof SpatialCompositorVideoProfileSchema>>;
