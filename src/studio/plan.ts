import { z } from "zod"
import { canonicalJson } from "../code/canonical-json.js"
import { deepFreezeJson } from "../code/json-snapshot.js"
import {
  parseStudioJob, parseStudioRuntimeIdentity, parseStudioSourceBundle, StudioCapabilityNameSchema, StudioDigestSchema,
  StudioJobSchema, StudioOutputArtifactSchema, StudioRuntimeIdentitySchema, StudioSourceBundleSchema,
  type StudioJob, type StudioOutputSpec, type StudioRuntimeIdentity, type StudioSourceBundle,
} from "./contracts.js"
import { assertDistinctPaths, parseStudioValue, STUDIO_LIMITS, studioCompare, studioDocument, studioHash, studioRequire, type StudioReadonly } from "./shared.js"

export const studioSourceBundleSha256 = (input: unknown): string => studioHash("atet.studio-source-bundle/v1", parseStudioSourceBundle(input))
export const studioJobSha256 = (input: unknown): string => studioHash("atet.studio-job/v1", parseStudioJob(input))
export const studioRuntimeSha256 = (input: unknown): string => studioHash("atet.studio-runtime/v1", parseStudioRuntimeIdentity(input))

/** Resolves only the declared fixed-width frame token. It never evaluates paths or source. */
export function studioOutputPath(output: StudioOutputSpec, frame?: number): string {
  if (output.kind === "sequence") {
    studioRequire(Number.isInteger(frame) && frame! >= 0 && frame! < STUDIO_LIMITS.frameIndexExclusive, "Sequence output requires an admitted frame index.")
    return output.pathPattern.replace("%06d", String(frame).padStart(6, "0"))
  }
  studioRequire(frame === undefined, "Only sequence outputs have a frame index.")
  return output.path
}

function declaration(job: StudioJob) {
  const files: { readonly id: string; readonly path: string; readonly frame?: number }[] = []
  const directories: { readonly id: string; readonly path: string }[] = []
  for (const output of job.outputs) {
    if (output.kind === "directory") directories.push({ id: output.id, path: output.path })
    else if (output.kind === "file") files.push({ id: output.id, path: output.path })
    else {
      studioRequire(job.render !== undefined, "Sequence requires a render interval.")
      for (let frame = job.render.startFrame; frame < job.render.endFrameExclusive; frame++) files.push({ id: output.id, path: studioOutputPath(output, frame), frame })
    }
  }
  studioRequire(files.length + directories.length <= job.limits.maximumOutputFiles, "Declared outputs exceed the output-file budget.")
  assertDistinctPaths([...files, ...directories].map(item => item.path))
  return { files, directories }
}
function requiredCapabilities(bundle: StudioSourceBundle, job: StudioJob): z.infer<typeof StudioCapabilityNameSchema>[] {
  const values = new Set<z.infer<typeof StudioCapabilityNameSchema>>([bundle.entrypoint.kind === "blend" ? "blend-authoring" : "python-authoring", job.stage])
  if (job.engine.engine === "blender" && job.engine.device === "gpu" && job.stage === "render") values.add("gpu-render")
  for (const output of job.outputs) {
    if (output.kind === "sequence") values.add("image-sequence")
    if (output.role === "beauty" && ["mov", "mp4", "webm"].includes(output.format)) values.add("beauty-video")
    if (output.role === "model") values.add("model-export")
    if (output.role === "auxiliary") values.add("auxiliary-passes")
    if (output.role === "simulation-cache") values.add("native-cache")
    if (output.role === "audio") values.add("audio-output")
  }
  return [...values].sort(studioCompare)
}
function derivePlan(input: { readonly bundle: StudioSourceBundle; readonly job: StudioJob; readonly runtime?: StudioRuntimeIdentity | undefined }) {
  const { bundle, job, runtime } = input
  const bundleSha256 = studioSourceBundleSha256(bundle), jobSha256 = studioJobSha256(job)
  studioRequire(bundleSha256 === job.bundleSha256, "Job does not bind the exact source bundle.")
  studioRequire(bundle.engine === job.engine.engine && (runtime === undefined || runtime.engine === bundle.engine), "Bundle, job, and runtime must use one engine.")
  studioRequire(bundle.entrypoint.kind !== "blend" || job.stage === "render", "Blend entrypoints support render stage only; explicit Python authoring owns builds and bakes.")
  const declared = declaration(job), required = requiredCapabilities(bundle, job)
  const capabilityChecks = required.map(name => ({ name, support: runtime === undefined ? "unbound" as const : runtime.capabilities.find(item => item.name === name)?.support ?? "unverified" as const }))
  const readiness = runtime === undefined ? "runtime-unbound" as const
    : capabilityChecks.some(item => item.support === "unavailable") ? "capability-unavailable" as const
    : capabilityChecks.some(item => item.support === "unverified") ? "capability-unverified" as const : "authorization-required" as const
  const body = {
    kind: "atet.studio-plan" as const, schemaVersion: 1 as const, bundle, job, ...(runtime === undefined ? {} : { runtime, runtimeSha256: studioRuntimeSha256(runtime) }),
    bundleSha256, jobSha256, sourceBytes: bundle.files.reduce((total, file) => total + file.bytes, 0),
    frameCount: job.render === undefined ? 0 : job.render.endFrameExclusive - job.render.startFrame,
    outputCount: { minimum: declared.files.length + declared.directories.length, maximum: declared.directories.length === 0 ? declared.files.length : job.limits.maximumOutputFiles },
    requiredCapabilities: required, capabilityChecks, readiness,
  }
  return { ...body, planSha256: studioHash("atet.studio-plan/v1", body) }
}
const plan = z.strictObject({
  kind: z.literal("atet.studio-plan"), schemaVersion: z.literal(1), bundle: StudioSourceBundleSchema, job: StudioJobSchema,
  runtime: StudioRuntimeIdentitySchema.optional(), runtimeSha256: StudioDigestSchema.optional(), bundleSha256: StudioDigestSchema, jobSha256: StudioDigestSchema, planSha256: StudioDigestSchema,
  sourceBytes: z.number().int().safe().nonnegative().max(STUDIO_LIMITS.sourceBytes), frameCount: z.number().int().nonnegative().max(STUDIO_LIMITS.frames),
  outputCount: z.strictObject({ minimum: z.number().int().positive().max(STUDIO_LIMITS.outputFiles), maximum: z.number().int().positive().max(STUDIO_LIMITS.outputFiles) }),
  requiredCapabilities: z.array(StudioCapabilityNameSchema).min(1).max(12),
  capabilityChecks: z.array(z.strictObject({ name: StudioCapabilityNameSchema, support: z.enum(["available", "unavailable", "unverified", "unbound"]) })).min(1).max(12),
  readiness: z.enum(["runtime-unbound", "capability-unavailable", "capability-unverified", "authorization-required"]),
}).superRefine((value, context) => {
  try {
    const derived = derivePlan({ bundle: value.bundle, job: value.job, ...(value.runtime === undefined ? {} : { runtime: value.runtime }) })
    if (canonicalJson(derived) !== canonicalJson(value)) context.addIssue({ code: "custom", message: "Studio plan differs from its canonical source, job, runtime, or admission derivation." })
  } catch (error) { context.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid studio plan." }) }
})
export const StudioPlanSchema = studioDocument(plan, "studio plan")
export type StudioPlan = StudioReadonly<z.infer<typeof StudioPlanSchema>>
export const parseStudioPlan = (input: unknown): StudioPlan => parseStudioValue(StudioPlanSchema, input)
export function planStudioJob(input: { readonly bundle: unknown; readonly job: unknown; readonly runtime?: unknown }): StudioPlan {
  const captured = parseStudioValue(studioDocument(z.strictObject({ bundle: StudioSourceBundleSchema, job: StudioJobSchema, runtime: StudioRuntimeIdentitySchema.optional() }), "studio planning input"), input)
  return parseStudioPlan(derivePlan(captured))
}

const failure = z.strictObject({ code: z.enum(["subprocess", "cancelled", "deadline", "validation", "custody", "publication", "unavailable"]), message: z.string().min(1).max(2048) })
const receiptCommon = {
  kind: z.literal("atet.studio-receipt"), schemaVersion: z.literal(1), jobId: z.string().regex(/^studio_[a-zA-Z0-9][a-zA-Z0-9_-]{0,120}$/u), attemptId: z.string().regex(/^attempt_[a-zA-Z0-9][a-zA-Z0-9_-]{0,120}$/u),
  planSha256: StudioDigestSchema, bundleSha256: StudioDigestSchema, jobSha256: StudioDigestSchema, runtime: StudioRuntimeIdentitySchema, runtimeSha256: StudioDigestSchema,
  startedAt: z.iso.datetime({ offset: true }), finishedAt: z.iso.datetime({ offset: true }), outputs: z.array(StudioOutputArtifactSchema).max(STUDIO_LIMITS.outputFiles),
}
const receiptShape = z.discriminatedUnion("state", [
  z.strictObject({ ...receiptCommon, state: z.literal("succeeded"), custody: z.literal("closed"), exitCode: z.literal(0) }),
  z.strictObject({ ...receiptCommon, state: z.literal("failed"), custody: z.literal("closed"), exitCode: z.number().int().min(-255).max(255).nullable(), failure }),
  z.strictObject({ ...receiptCommon, state: z.literal("unknown-custody"), custody: z.literal("unknown"), exitCode: z.number().int().min(-255).max(255).nullable(), failure }),
]).superRefine((value, context) => {
  if (studioRuntimeSha256(value.runtime) !== value.runtimeSha256) context.addIssue({ code: "custom", message: "Receipt runtime digest differs from its evidence." })
  if (Date.parse(value.finishedAt) < Date.parse(value.startedAt)) context.addIssue({ code: "custom", message: "Receipt finishes before it starts." })
  try { assertDistinctPaths(value.outputs.map(item => item.path)) } catch { context.addIssue({ code: "custom", message: "Receipt output paths collide." }) }
  if (value.outputs.reduce((sum, item) => sum + item.bytes, 0) > STUDIO_LIMITS.outputBytes) context.addIssue({ code: "custom", message: "Receipt exceeds the global output byte bound." })
})
const receipt = receiptShape.transform((value): z.input<typeof receiptShape> => ({ ...value, outputs: [...value.outputs].sort((a, b) => studioCompare(a.path, b.path)) })).pipe(receiptShape)
export const StudioReceiptSchema = studioDocument(receipt, "studio receipt")
export type StudioReceipt = StudioReadonly<z.infer<typeof StudioReceiptSchema>>
export const parseStudioReceipt = (input: unknown): StudioReceipt => parseStudioValue(StudioReceiptSchema, input)

/** Validates retained declarations and provenance; host code must verify actual files and native custody. */
export function validateStudioReceipt(input: { readonly plan: unknown; readonly receipt: unknown }): StudioReceipt {
  const captured = parseStudioValue(studioDocument(z.strictObject({ plan: StudioPlanSchema, receipt: StudioReceiptSchema }), "studio receipt validation input"), input)
  const { plan, receipt } = captured
  studioRequire(receipt.jobId === plan.job.jobId && receipt.planSha256 === plan.planSha256 && receipt.jobSha256 === plan.jobSha256 && receipt.bundleSha256 === plan.bundleSha256, "Receipt identity differs from the exact planned job.")
  studioRequire(plan.runtime !== undefined && receipt.runtimeSha256 === plan.runtimeSha256 && canonicalJson(receipt.runtime) === canonicalJson(plan.runtime), "Execution receipt requires the exact planned runtime binding.")
  if (receipt.state === "succeeded") studioRequire(plan.readiness === "authorization-required", "A successful receipt requires available observed runtime capabilities; consent remains host-owned.")
  studioRequire(receipt.outputs.length <= plan.job.limits.maximumOutputFiles && receipt.outputs.reduce((total, output) => total + output.bytes, 0) <= plan.job.limits.maximumOutputBytes, "Receipt exceeds the planned output budget.")
  const declared = declaration(plan.job), expected = new Map(declared.files.map(file => [file.path, file]))
  const counts = new Map<string, number>()
  for (const artifact of receipt.outputs) {
    const specification = plan.job.outputs.find(output => output.id === artifact.outputId)
    studioRequire(specification !== undefined, "Receipt contains an undeclared output ID.")
    studioRequire(artifact.role === specification.role && artifact.format === specification.format, "Receipt output role or format differs from its declaration.")
    if (specification.kind === "directory") {
      studioRequire(artifact.path.startsWith(`${specification.path}/`) && artifact.frame === undefined, "Cache artifact must be a file inside its declared directory.")
    } else {
      const wanted = expected.get(artifact.path)
      studioRequire(wanted !== undefined && wanted.id === artifact.outputId && artifact.frame === wanted.frame, "Receipt contains an undeclared file or incorrect frame index.")
      expected.delete(artifact.path)
    }
    counts.set(artifact.outputId, (counts.get(artifact.outputId) ?? 0) + 1)
  }
  if (receipt.state === "succeeded") {
    studioRequire(expected.size === 0 && declared.directories.every(directory => (counts.get(directory.id) ?? 0) > 0), "Successful receipt must cover every declared file, frame, and cache directory.")
  }
  return deepFreezeJson(receipt)
}

export function inspectStudioBundle(input: unknown) {
  const bundle = parseStudioSourceBundle(input)
  return deepFreezeJson({ engine: bundle.engine, entrypoint: bundle.entrypoint, bundleSha256: studioSourceBundleSha256(bundle), files: bundle.files.length,
    sourceBytes: bundle.files.reduce((total, file) => total + file.bytes, 0), executed: false as const, dependencyDiscovery: "explicit-files-only" as const })
}
export function inspectStudioPlan(input: unknown) {
  const plan = parseStudioPlan(input)
  return deepFreezeJson({ jobId: plan.job.jobId, stage: plan.job.stage, engine: plan.job.engine.engine, planSha256: plan.planSha256,
    sourceBytes: plan.sourceBytes, frameCount: plan.frameCount, outputCount: plan.outputCount, readiness: plan.readiness,
    capabilityChecks: plan.capabilityChecks, execution: plan.job.execution, limits: plan.job.limits, executed: false as const,
    outputs: plan.job.outputs.map(output => ({ id: output.id, role: output.role, format: output.format, kind: output.kind, path: output.kind === "sequence" ? output.pathPattern : output.path })) })
}
