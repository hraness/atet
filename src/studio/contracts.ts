import { z } from "zod"
import { createBoundedJsonValueSnapshot } from "../code/json-snapshot.js"
import { assertDistinctPaths, parseStudioValue, STUDIO_LIMITS, studioCompare, studioDocument, type StudioReadonly } from "./shared.js"

export { STUDIO_LIMITS } from "./shared.js"
export const StudioDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u)
export const StudioEngineSchema = z.enum(["blender", "manim", "cadquery"])
export const StudioPathSchema = z.string().min(1).max(1024).refine(path =>
  path.normalize("NFC") === path && !path.startsWith("/") && !/[\\:\u0000-\u001f\u007f]/u.test(path)
  && path.split("/").every(part => part !== "" && part !== "." && part !== ".." && !/[. ]$/u.test(part)),
"Studio paths must be normalized, contained POSIX-relative names.")
const identifier = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u)
const stableId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u)
const sourceFile = z.strictObject({ path: StudioPathSchema, sha256: StudioDigestSchema, bytes: z.number().int().safe().nonnegative().max(STUDIO_LIMITS.sourceBytes) })
const sourceBundleShape = z.strictObject({
  kind: z.literal("atet.studio-source-bundle"), schemaVersion: z.literal(1), engine: StudioEngineSchema,
  entrypoint: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("python"), path: StudioPathSchema.refine(path => path.endsWith(".py")) }), z.strictObject({ kind: z.literal("blend"), path: StudioPathSchema.refine(path => path.endsWith(".blend")) })]),
  files: z.array(sourceFile).min(1).max(STUDIO_LIMITS.sourceFiles),
}).superRefine((value, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message })
  try { assertDistinctPaths(value.files.map(file => file.path)) } catch { issue("Source paths must be distinct and cannot have file ancestors.") }
  if (value.files.reduce((total, file) => total + file.bytes, 0) > STUDIO_LIMITS.sourceBytes) issue("Source bundle exceeds four GiB.")
  if (!value.files.some(file => file.path === value.entrypoint.path && file.bytes > 0)) issue("Entrypoint must name a declared nonempty source file.")
  if (value.entrypoint.kind === "blend" && value.engine !== "blender") issue("Blend entrypoints require Blender.")
})
const sourceBundle = sourceBundleShape.transform(value => ({ ...value, files: [...value.files].sort((a, b) => studioCompare(a.path, b.path)) })).pipe(sourceBundleShape)
export const StudioSourceBundleSchema = studioDocument(sourceBundle, "studio source bundle")
export type StudioSourceBundle = StudioReadonly<z.infer<typeof StudioSourceBundleSchema>>
export const parseStudioSourceBundle = (input: unknown): StudioSourceBundle => parseStudioValue(StudioSourceBundleSchema, input)

export const StudioSourceSpaceSchema = z.strictObject({ units: z.enum(["meters", "millimeters", "centimeters"]), upAxis: z.enum(["x", "y", "z"]), handedness: z.enum(["right", "left"]) })
export const StudioOutputRoleSchema = z.enum(["native-source", "model", "beauty", "auxiliary", "simulation-cache", "audio"])
export const StudioOutputFormatSchema = z.enum(["py", "blend", "usd", "usda", "usdc", "glb", "step", "png", "exr", "mp4", "mov", "webm", "wav", "flac", "mp3", "cache"])
const raster = z.strictObject({
  kind: z.literal("raster"), colorSpace: z.enum(["srgb", "linear-rec709", "data", "unspecified"]), alpha: z.enum(["opaque", "straight", "premultiplied", "none"]),
  dataType: z.enum(["uint8", "uint16", "float16", "float32"]), channels: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u)).min(1).max(32),
  semantic: z.enum(["color", "depth", "normal", "object-id", "mask", "custom"]), unit: z.enum(["unitless", "meters", "millimeters", "centimeters"]),
}).superRefine((value, context) => {
  if (new Set(value.channels).size !== value.channels.length) context.addIssue({ code: "custom", message: "Raster channels must be unique." })
  if (value.semantic !== "color" && value.colorSpace !== "data") context.addIssue({ code: "custom", message: "Non-color raster passes must declare data color space." })
  if (value.semantic === "color" && value.colorSpace === "data") context.addIssue({ code: "custom", message: "Color output cannot declare data color space." })
  if (value.semantic !== "depth" && value.unit !== "unitless") context.addIssue({ code: "custom", message: "Only depth passes declare distance units." })
})
export const StudioOutputInterpretationSchema = z.discriminatedUnion("kind", [
  raster, z.strictObject({ kind: z.literal("model"), sourceSpace: StudioSourceSpaceSchema }),
  z.strictObject({ kind: z.literal("native-source") }), z.strictObject({ kind: z.literal("cache"), semantics: z.literal("opaque-native") }),
  z.strictObject({ kind: z.literal("audio"), sampleRate: z.number().int().min(8000).max(384000), channels: z.number().int().min(1).max(32) }),
])
const outputCommon = { id: stableId, role: StudioOutputRoleSchema, format: StudioOutputFormatSchema, interpretation: StudioOutputInterpretationSchema }
const pattern = z.string().max(1024).refine(value => value.split("%06d").length === 2 && !value.replace("%06d", "").includes("%") && StudioPathSchema.safeParse(value.replace("%06d", "000000")).success,
"Sequence paths require exactly one %06d placeholder in a safe relative path.")
function compatibleOutput(value: { role: z.infer<typeof StudioOutputRoleSchema>; format: z.infer<typeof StudioOutputFormatSchema>; interpretation: z.infer<typeof StudioOutputInterpretationSchema> }): boolean {
  if (value.role === "native-source") return ["py", "blend"].includes(value.format) && value.interpretation.kind === "native-source"
  if (value.role === "model") return ["blend", "usd", "usda", "usdc", "glb", "step"].includes(value.format) && value.interpretation.kind === "model"
  if (value.role === "simulation-cache") return value.format === "cache" && value.interpretation.kind === "cache"
  if (value.role === "audio") return ["wav", "flac", "mp3"].includes(value.format) && value.interpretation.kind === "audio"
  return ["png", "exr", "mp4", "mov", "webm"].includes(value.format) && value.interpretation.kind === "raster" && (value.role !== "beauty" || value.interpretation.semantic === "color")
}
export const StudioOutputSpecSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...outputCommon, kind: z.literal("file"), path: StudioPathSchema }),
  z.strictObject({ ...outputCommon, kind: z.literal("sequence"), pathPattern: pattern }),
  z.strictObject({ ...outputCommon, kind: z.literal("directory"), path: StudioPathSchema }),
]).superRefine((value, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message })
  if (!compatibleOutput(value)) issue("Output role, format, and interpretation disagree.")
  if ((value.kind === "directory") !== (value.format === "cache")) issue("Only native cache outputs use directory declarations.")
  if (value.kind === "sequence" && !["png", "exr"].includes(value.format)) issue("Numbered sequences support PNG or EXR only.")
  if (value.kind !== "directory") {
    const path = value.kind === "sequence" ? value.pathPattern : value.path
    if (!path.endsWith(`.${value.format}`) && !(value.format === "step" && path.endsWith(".stp"))) issue("Output extension must agree with its declared format.")
  }
  if (value.interpretation.kind === "raster") {
    if (value.format === "png" && !["uint8", "uint16"].includes(value.interpretation.dataType)) issue("PNG declares integer sample data.")
    if (value.format === "exr" && !["float16", "float32"].includes(value.interpretation.dataType)) issue("The admitted EXR profile declares floating point sample data.")
  }
})
export type StudioOutputSpec = StudioReadonly<z.infer<typeof StudioOutputSpecSchema>>
const frameRateShape = z.strictObject({ numerator: z.number().int().min(1).max(1_000_000), denominator: z.number().int().min(1).max(1_000_000) })
  .refine(value => value.numerator / value.denominator <= 240, "Studio cadence exceeds 240 fps.")
const frameRate = frameRateShape.transform(value => { let a = value.numerator, b = value.denominator; while (b !== 0) { const remainder = a % b; a = b; b = remainder } return { numerator: value.numerator / a, denominator: value.denominator / a } }).pipe(frameRateShape)
export const StudioRenderSchema = z.strictObject({
  width: z.number().int().min(1).max(STUDIO_LIMITS.dimension), height: z.number().int().min(1).max(STUDIO_LIMITS.dimension), frameRate,
  startFrame: z.number().int().nonnegative().max(STUDIO_LIMITS.frameIndexExclusive - 1), endFrameExclusive: z.number().int().positive().max(STUDIO_LIMITS.frameIndexExclusive),
}).refine(value => value.endFrameExclusive > value.startFrame && value.endFrameExclusive - value.startFrame <= STUDIO_LIMITS.frames && value.width * value.height <= STUDIO_LIMITS.pixels,
"Render requires a bounded, nonempty half-open frame interval and pixel area.")
export const StudioEngineOptionsSchema = z.discriminatedUnion("engine", [
  z.strictObject({ engine: z.literal("blender"), renderer: z.enum(["cycles", "eevee"]), device: z.enum(["cpu", "gpu"]), samples: z.number().int().min(1).max(4096), transparent: z.boolean(), viewTransform: z.enum(["AgX", "Standard"]), denoise: z.boolean(), seed: z.number().int().min(0).max(0xffff_ffff) }),
  z.strictObject({ engine: z.literal("manim"), scene: identifier, renderer: z.literal("cairo"), transparent: z.boolean() }),
  z.strictObject({ engine: z.literal("cadquery"), exportVariable: identifier, tolerance: z.number().finite().positive().max(1), angularTolerance: z.number().finite().positive().max(Math.PI) }),
])
// Capture proves the full JSON closure; avoid a second recursive schema/type expansion.
const parameters = z.preprocess(value => value === undefined ? undefined : createBoundedJsonValueSnapshot(value, STUDIO_LIMITS.parameterBytes, "studio parameters", { maximumDepth: STUDIO_LIMITS.parameterDepth, maximumValues: STUDIO_LIMITS.parameterValues }).value, z.record(z.string(), z.unknown()))
export const StudioExecutionProfileSchema = z.strictObject({ trust: z.literal("trusted-current-user"), isolation: z.literal("none"), hermetic: z.literal(false) })
const jobShape = z.strictObject({
  kind: z.literal("atet.studio-job"), schemaVersion: z.literal(1), jobId: z.string().regex(/^studio_[a-zA-Z0-9][a-zA-Z0-9_-]{0,120}$/u), bundleSha256: StudioDigestSchema,
  stage: z.enum(["build", "bake", "render"]), parameters, engine: StudioEngineOptionsSchema, render: StudioRenderSchema.optional(),
  outputs: z.array(StudioOutputSpecSchema).min(1).max(STUDIO_LIMITS.outputSpecifications),
  limits: z.strictObject({ timeoutSeconds: z.number().int().min(1).max(STUDIO_LIMITS.timeoutSeconds), maximumOutputBytes: z.number().int().safe().min(1).max(STUDIO_LIMITS.outputBytes), maximumOutputFiles: z.number().int().min(1).max(STUDIO_LIMITS.outputFiles) }),
  execution: StudioExecutionProfileSchema,
}).superRefine((value, context) => {
  if (value.render === undefined && (value.stage === "render" && value.engine.engine !== "cadquery" || value.outputs.some(output => output.kind === "sequence" || output.interpretation.kind === "raster"))) context.addIssue({ code: "custom", message: "Raster outputs, render stage, and numbered sequences require explicit dimensions and a frame interval." })
  if (new Set(value.outputs.map(output => output.id)).size !== value.outputs.length) context.addIssue({ code: "custom", message: "Output IDs must be unique." })
  const count = value.outputs.reduce((sum, output) => sum + (output.kind === "sequence" && value.render !== undefined ? value.render.endFrameExclusive - value.render.startFrame : 1), 0)
  if (count > value.limits.maximumOutputFiles) context.addIssue({ code: "custom", message: "Declared outputs exceed the job's output-file limit." })
})
const job = jobShape.transform((value): z.input<typeof jobShape> => ({ ...value, outputs: [...value.outputs].sort((a, b) => studioCompare(a.id, b.id)) })).pipe(jobShape)
export const StudioJobSchema = studioDocument(job, "studio job")
export type StudioJob = StudioReadonly<z.infer<typeof StudioJobSchema>>
export const parseStudioJob = (input: unknown): StudioJob => parseStudioValue(StudioJobSchema, input)

export const StudioCapabilityNameSchema = z.enum(["python-authoring", "blend-authoring", "build", "bake", "render", "gpu-render", "image-sequence", "beauty-video", "model-export", "auxiliary-passes", "native-cache", "audio-output"])
const capability = z.strictObject({ name: StudioCapabilityNameSchema, support: z.enum(["available", "unavailable", "unverified"]), evidence: z.enum(["probe", "qualification"]), receiptSha256: StudioDigestSchema.optional() })
  .refine(value => value.evidence !== "qualification" || value.receiptSha256 !== undefined, "Qualification evidence requires a retained receipt digest.")
const runtimeShape = z.strictObject({
  kind: z.literal("atet.studio-runtime"), schemaVersion: z.literal(1), engine: StudioEngineSchema,
  tool: z.strictObject({ name: z.string().min(1).max(128), version: z.string().min(1).max(512), executableSha256: StudioDigestSchema }), driverSha256: StudioDigestSchema,
  environment: z.strictObject({ fingerprintSha256: StudioDigestSchema, evidence: z.literal("observed-package-environment"), hermetic: z.literal(false) }),
  capabilities: z.array(capability).max(12),
}).refine(value => new Set(value.capabilities.map(item => item.name)).size === value.capabilities.length, "Runtime capability names must be unique.")
const runtime = runtimeShape.transform(value => ({ ...value, capabilities: [...value.capabilities].sort((a, b) => studioCompare(a.name, b.name)) })).pipe(runtimeShape)
export const StudioRuntimeIdentitySchema = studioDocument(runtime, "studio runtime identity")
export type StudioRuntimeIdentity = StudioReadonly<z.infer<typeof StudioRuntimeIdentitySchema>>
export const parseStudioRuntimeIdentity = (input: unknown): StudioRuntimeIdentity => parseStudioValue(StudioRuntimeIdentitySchema, input)

export const StudioOutputArtifactSchema = z.strictObject({
  outputId: stableId, path: StudioPathSchema, sha256: StudioDigestSchema, bytes: z.number().int().safe().positive().max(STUDIO_LIMITS.outputBytes), role: StudioOutputRoleSchema, format: StudioOutputFormatSchema,
  frame: z.number().int().nonnegative().max(STUDIO_LIMITS.frameIndexExclusive - 1).optional(),
})
export type StudioOutputArtifact = StudioReadonly<z.infer<typeof StudioOutputArtifactSchema>>
