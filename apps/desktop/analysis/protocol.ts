import { z } from "zod";

export const FACE_ANALYZER_KIND = "transmute.face-analysis" as const;
export const LEGACY_FACE_ANALYZER_KIND = "studio.face-analysis" as const;
export const FACE_ANALYZER_SCHEMA_VERSION = 1 as const;
export const MAXIMUM_FACE_ANALYZER_LINE_BYTES = 1_048_576;
export const MAXIMUM_FACE_ANALYZER_OUTPUT_BYTES = 67_108_864;
export const MAXIMUM_FACE_ANALYZER_FRAMES = 100_000;
export const MAXIMUM_FACES_PER_FRAME = 128;

const SafeMicrosecondsSchema = z.number().int().safe().nonnegative().max(86_400_000_000);
const NormalizedValueSchema = z.number().finite().min(0).max(1);

export const FaceAnalyzerBackendSchema = z.strictObject({
  architecture: z.enum(["arm64", "x86_64"]),
  helperVersion: z.string().min(1).max(128),
  implementation: z.literal("apple-vision"),
  offline: z.literal(true),
  osBuild: z.string().min(1).max(128),
  operatingSystem: z.string().min(1).max(128),
  request: z.literal("VNDetectFaceRectanglesRequest"),
  revision: z.number().int().safe().positive(),
  runtimeVersion: z.string().min(1).max(128),
});

export const FaceAnalyzerLimitsSchema = z.strictObject({
  maximumArgumentBytes: z.number().int().safe().positive(),
  maximumArguments: z.number().int().safe().positive(),
  maximumFacesPerFrame: z.number().int().safe().positive().max(MAXIMUM_FACES_PER_FRAME),
  maximumFrames: z.number().int().safe().positive().max(MAXIMUM_FACE_ANALYZER_FRAMES),
  maximumInputBytes: z.number().int().safe().positive(),
  maximumLineBytes: z.number().int().safe().positive().max(MAXIMUM_FACE_ANALYZER_LINE_BYTES),
  maximumOutputBytes: z.number().int().safe().positive().max(MAXIMUM_FACE_ANALYZER_OUTPUT_BYTES),
  maximumTimelineUs: SafeMicrosecondsSchema,
});

export const FaceAnalyzerOrientationSchema = z.strictObject({
  encodedPixelHeight: z.number().int().safe().positive().max(16_384),
  encodedPixelWidth: z.number().int().safe().positive().max(16_384),
  mirroredHorizontally: z.boolean(),
  origin: z.literal("top-left"),
  pixelHeight: z.number().int().safe().positive().max(16_384),
  pixelWidth: z.number().int().safe().positive().max(16_384),
  preferredTransform: z.strictObject({
    a: z.number().finite(),
    b: z.number().finite(),
    c: z.number().finite(),
    d: z.number().finite(),
    tx: z.number().finite(),
    ty: z.number().finite(),
  }),
  rotationDegrees: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  sampleAspectRatio: z.strictObject({
    denominator: z.number().int().safe().positive().max(1_000_000),
    numerator: z.number().int().safe().positive().max(1_000_000),
  }),
  units: z.literal("normalized"),
  visionOrientation: z.enum([
    "up",
    "up-mirrored",
    "down",
    "down-mirrored",
    "left",
    "left-mirrored",
    "right",
    "right-mirrored",
  ]),
  xAxis: z.literal("right"),
  yAxis: z.literal("down"),
}).superRefine((orientation, context) => {
  const swapsAxes = orientation.rotationDegrees === 90 || orientation.rotationDegrees === 270;
  const expectedWidth = swapsAxes ? orientation.encodedPixelHeight : orientation.encodedPixelWidth;
  const expectedHeight = swapsAxes ? orientation.encodedPixelWidth : orientation.encodedPixelHeight;
  if (orientation.pixelWidth !== expectedWidth || orientation.pixelHeight !== expectedHeight) {
    context.addIssue({
      code: "custom",
      message: "Oriented analyzer dimensions must agree with encoded dimensions and rotation.",
    });
  }
  if (
    orientation.encodedPixelWidth * orientation.encodedPixelHeight > 134_217_728
    || orientation.pixelWidth * orientation.pixelHeight > 134_217_728
  ) {
    context.addIssue({ code: "custom", message: "Analyzer orientation exceeds the 128-megapixel safety limit." });
  }
});

export const FaceAnalyzerTrackSchema = z.strictObject({
  nominalFrameRate: z.number().finite().nonnegative().max(1_000),
  persistentTrackId: z.number().int().safe(),
  totalVideoTracks: z.number().int().safe().positive().max(64),
  videoTrackOrdinal: z.number().int().safe().nonnegative().max(63),
});

export const NormalizedFaceBoxSchema = z.strictObject({
  height: NormalizedValueSchema.refine(value => value > 0, "Face height must be positive."),
  width: NormalizedValueSchema.refine(value => value > 0, "Face width must be positive."),
  x: NormalizedValueSchema,
  y: NormalizedValueSchema,
}).superRefine((box, context) => {
  if (box.x + box.width > 1.000_001 || box.y + box.height > 1.000_001) {
    context.addIssue({ code: "custom", message: "Normalized face box must remain inside the upright frame." });
  }
});

export const FaceDetectionSchema = z.strictObject({
  bounds: NormalizedFaceBoxSchema,
  confidence: z.number().finite().min(0).max(1),
  detectionIndex: z.number().int().safe().nonnegative().max(MAXIMUM_FACES_PER_FRAME - 1),
});

const EventBaseShape = {
  kind: z.union([
    z.literal(FACE_ANALYZER_KIND),
    z.literal(LEGACY_FACE_ANALYZER_KIND),
  ]),
  schemaVersion: z.literal(FACE_ANALYZER_SCHEMA_VERSION),
} as const;

export const FaceAnalyzerProbeEventSchema = z.strictObject({
  ...EventBaseShape,
  backend: FaceAnalyzerBackendSchema,
  event: z.literal("probe"),
  limits: FaceAnalyzerLimitsSchema,
});

export const FaceAnalyzerStartedEventSchema = z.strictObject({
  ...EventBaseShape,
  backend: FaceAnalyzerBackendSchema,
  event: z.literal("started"),
  limits: z.strictObject({
    endUs: SafeMicrosecondsSchema,
    maximumFacesPerFrame: z.number().int().safe().positive().max(MAXIMUM_FACES_PER_FRAME),
    maximumFrames: z.number().int().safe().positive().max(MAXIMUM_FACE_ANALYZER_FRAMES),
    maximumOutputBytes: z.number().int().safe().positive().max(MAXIMUM_FACE_ANALYZER_OUTPUT_BYTES),
    minimumConfidence: z.number().finite().min(0).max(1),
    sampleIntervalUs: z.number().int().safe().positive().max(60_000_000),
    startUs: SafeMicrosecondsSchema,
  }).superRefine((limits, context) => {
    if (limits.endUs <= limits.startUs) {
      context.addIssue({ code: "custom", message: "Analyzer endUs must be greater than startUs." });
    }
  }),
  orientation: FaceAnalyzerOrientationSchema,
  track: FaceAnalyzerTrackSchema,
});

export const FaceAnalyzerFrameEventSchema = z.strictObject({
  ...EventBaseShape,
  durationUs: SafeMicrosecondsSchema.nullable(),
  event: z.literal("frame"),
  faces: z.array(FaceDetectionSchema).max(MAXIMUM_FACES_PER_FRAME),
  ptsUs: SafeMicrosecondsSchema,
  sampleIndex: z.number().int().safe().nonnegative().max(MAXIMUM_FACE_ANALYZER_FRAMES - 1),
});

export const FaceAnalyzerCompletedEventSchema = z.strictObject({
  ...EventBaseShape,
  event: z.literal("completed"),
  faceDetections: z.number().int().safe().nonnegative(),
  firstPtsUs: SafeMicrosecondsSchema.nullable(),
  framesAnalyzed: z.number().int().safe().nonnegative().max(MAXIMUM_FACE_ANALYZER_FRAMES),
  framesRead: z.number().int().safe().nonnegative(),
  lastPtsUs: SafeMicrosecondsSchema.nullable(),
});

export const FaceAnalyzerErrorEventSchema = z.strictObject({
  ...EventBaseShape,
  code: z.enum([
    "face-limit-exceeded",
    "frame-limit-exceeded",
    "frame-read-failed",
    "input-not-found",
    "input-too-large",
    "invalid-timestamp",
    "no-video-track",
    "output-limit-exceeded",
    "reader-setup-failed",
    "unsafe-input",
    "unsupported-backend",
    "unsupported-orientation",
    "usage",
    "video-track-out-of-range",
    "vision-failed",
  ]),
  event: z.literal("error"),
  message: z.string().min(1).max(1_024),
});

export const FaceAnalyzerEventSchema = z.discriminatedUnion("event", [
  FaceAnalyzerProbeEventSchema,
  FaceAnalyzerStartedEventSchema,
  FaceAnalyzerFrameEventSchema,
  FaceAnalyzerCompletedEventSchema,
  FaceAnalyzerErrorEventSchema,
]);

export type FaceAnalyzerBackend = Readonly<z.infer<typeof FaceAnalyzerBackendSchema>>;
export type FaceAnalyzerEvent = Readonly<z.infer<typeof FaceAnalyzerEventSchema>>;
export type FaceAnalyzerFrameEvent = Readonly<z.infer<typeof FaceAnalyzerFrameEventSchema>>;

export function parseFaceAnalyzerJsonLines(input: string): readonly FaceAnalyzerEvent[] {
  const bytes = new TextEncoder().encode(input).byteLength;
  if (bytes <= 0 || bytes > MAXIMUM_FACE_ANALYZER_OUTPUT_BYTES) {
    throw new RangeError(`Face analyzer output must contain 1-${MAXIMUM_FACE_ANALYZER_OUTPUT_BYTES} UTF-8 bytes.`);
  }
  const lines = input.endsWith("\n") ? input.slice(0, -1).split("\n") : input.split("\n");
  if (lines.length > MAXIMUM_FACE_ANALYZER_FRAMES + 2) {
    throw new RangeError("Face analyzer output contains too many JSONL events.");
  }
  return lines.map((line, index) => {
    if (line.length === 0 || new TextEncoder().encode(line).byteLength > MAXIMUM_FACE_ANALYZER_LINE_BYTES) {
      throw new RangeError(`Face analyzer line ${index + 1} is empty or oversized.`);
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new TypeError(`Face analyzer line ${index + 1} is not valid JSON.`);
    }
    return FaceAnalyzerEventSchema.parse(value);
  });
}
