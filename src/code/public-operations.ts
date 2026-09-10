import { z } from "zod"

import {
  type OperationContract,
  type OperationLifecycleKind,
  type OperationPolicy,
} from "./contracts.js"
import { utf8ByteLength } from "./json-utf8.js"

const MAX_PATH_CHARACTERS = 4_096
const MAX_PROMPT_BYTES = 32 * 1024
const MAX_GENERATED_IMAGE_BYTES = 64 * 1024 * 1024
const MAX_VECTOR_INPUT_BYTES = 16 * 1024 * 1024
const MAX_VECTOR_OUTPUT_BYTES = 2_000_000
const MAX_DIAGRAM_ARTIFACT_BYTES = 64 * 1024 * 1024

const BoundedPathSchema = z.string()
  .min(1)
  .max(MAX_PATH_CHARACTERS)
  .refine(value => !value.includes("\0"), "Paths must not contain NUL bytes.")

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const BoundedVersionStringSchema = z.string().min(1).max(256)
const NonnegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)

function schemaWithReadonlyOutput<Output>(
  schema: z.ZodType,
): z.ZodType<Output> {
  return schema as z.ZodType<Output>
}

export type SlopcameraImageModel = string

export interface SlopcameraDiagramCheckInput {
  readonly path: string
}

export interface SlopcameraDiagramRenderInput extends SlopcameraDiagramCheckInput {
  readonly outDirectory?: string
  readonly scale?: number
}

export interface SlopcameraImageVectorizeInput {
  readonly alphaCutoff?: number
  readonly duotone?: readonly [string, string]
  readonly inputPath: string
  readonly outputPath: string
  readonly timeoutMs?: number
}

export interface SlopcameraImageGenerateInput {
  readonly model: SlopcameraImageModel
  readonly outputPath: string
  readonly prompt: string
}

export interface SlopcameraLintFinding {
  readonly code: string
  readonly message: string
  readonly shapeIds: readonly string[]
}

export interface SlopcameraDiagramCheckOutput {
  readonly configPath: null
  readonly findings: readonly SlopcameraLintFinding[]
}

export interface SlopcameraRenderArtifacts {
  readonly darkPng: string
  readonly darkSvg: string
  readonly lightPng: string
  readonly lightSvg: string
  readonly spec: string
  readonly tldr: string
}

export interface SlopcameraDiagramRenderOutput {
  readonly artifacts: SlopcameraRenderArtifacts
  readonly configPath: null
  readonly findings: readonly SlopcameraLintFinding[]
}

export interface SlopcameraVectorizeQualityReceipt {
  readonly alphaRmse: number
  readonly colorRmse: number
  readonly outsideAlphaRatio: number
  readonly sampleHeight: number
  readonly sampleWidth: number
  readonly supportRecall: number
}

export interface SlopcameraVectorizeProvenance {
  readonly arch: string
  readonly platform: string
  readonly sharp: string
  readonly sharpVersions: Readonly<Record<string, string>>
  readonly vips: string
  readonly vtracerSha256: string
  readonly vtracerSource: "official-release" | "override"
  readonly vtracerVersion: string
}

export interface SlopcameraVectorizeReceipt {
  readonly alphaCutoff: number
  readonly bytes: number
  readonly candidatesEvaluated: number
  readonly format: string
  readonly height: number
  readonly inputBytes: number
  readonly outputMode: "color" | "duotone"
  readonly pathCount: number
  readonly profile: "balanced" | "detailed" | "photo"
  readonly provenance: SlopcameraVectorizeProvenance
  readonly quality: SlopcameraVectorizeQualityReceipt
  readonly receiptVersion: 1
  readonly representation: "color-paths" | "alpha-mask"
  readonly sourceSha256: string
  readonly svgSha256: string
  readonly width: number
}

export interface SlopcameraImageVectorizeOutput {
  readonly outputPath: string
  readonly receipt: SlopcameraVectorizeReceipt
}

export interface SlopcameraImageGenerateOutput {
  readonly bytes: number
  readonly mediaType: "image/jpeg" | "image/png" | "image/webp"
  readonly model: SlopcameraImageModel
  readonly outputPath: string
  readonly provider: "vercel-ai-gateway"
  readonly requestId: string
  readonly sha256: string
  readonly warnings: readonly string[]
}

export const SlopcameraImageModelSchema = z.string()
  .min(3)
  .max(256)
  .regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/iu) satisfies z.ZodType<SlopcameraImageModel>

export const SlopcameraDiagramCheckInputSchema = z.strictObject({
  path: BoundedPathSchema,
}) satisfies z.ZodType<SlopcameraDiagramCheckInput>

export const SlopcameraDiagramRenderInputSchema = schemaWithReadonlyOutput<
  SlopcameraDiagramRenderInput
>(z.strictObject({
  outDirectory: BoundedPathSchema.optional(),
  path: BoundedPathSchema,
  scale: z.number().finite().positive().max(4).optional(),
}))

export const SlopcameraImageVectorizeInputSchema = schemaWithReadonlyOutput<
  SlopcameraImageVectorizeInput
>(z.strictObject({
  alphaCutoff: z.number().int().min(1).max(64).optional(),
  duotone: z.tuple([
    z.string().regex(/^#[a-f0-9]{3}(?:[a-f0-9]{3})?$/iu),
    z.string().regex(/^#[a-f0-9]{3}(?:[a-f0-9]{3})?$/iu),
  ]).optional(),
  inputPath: BoundedPathSchema,
  outputPath: BoundedPathSchema.refine(
    value => value.toLowerCase().endsWith(".svg"),
    "Vector output paths must end in .svg.",
  ),
  timeoutMs: z.number().int().min(1).max(300_000).optional(),
}))

const PromptSchema = z.string().superRefine((value, context) => {
  if (utf8ByteLength(value, MAX_PROMPT_BYTES) === undefined) {
    context.addIssue({
      code: "custom",
      message: `Prompts must contain at most ${String(MAX_PROMPT_BYTES)} UTF-8 bytes.`,
    })
    return
  }
  if (value.trim().length === 0) {
    context.addIssue({ code: "custom", message: "Prompts must not be blank." })
    return
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    context.addIssue({
      code: "custom",
      message: "Prompts must not contain control characters.",
    })
  }
})

export const SlopcameraImageGenerateInputSchema = schemaWithReadonlyOutput<
  SlopcameraImageGenerateInput
>(z.strictObject({
  model: SlopcameraImageModelSchema,
  outputPath: BoundedPathSchema.refine(
    value => /\.(?:jpe?g|png|webp)$/iu.test(value),
    "Generated image output paths must end in .png, .jpg, .jpeg, or .webp.",
  ),
  prompt: PromptSchema,
}))

export const SlopcameraLintFindingSchema = z.strictObject({
  code: z.string().min(1).max(160),
  message: z.string().min(1).max(4_096),
  shapeIds: z.array(z.string().min(1).max(256)).max(4_096),
}) satisfies z.ZodType<SlopcameraLintFinding>

export const SlopcameraDiagramCheckOutputSchema = z.strictObject({
  configPath: z.null(),
  findings: z.array(SlopcameraLintFindingSchema).max(4_096),
}) satisfies z.ZodType<SlopcameraDiagramCheckOutput>

export const SlopcameraRenderArtifactsSchema = z.strictObject({
  darkPng: BoundedPathSchema,
  darkSvg: BoundedPathSchema,
  lightPng: BoundedPathSchema,
  lightSvg: BoundedPathSchema,
  spec: BoundedPathSchema,
  tldr: BoundedPathSchema,
}) satisfies z.ZodType<SlopcameraRenderArtifacts>

export const SlopcameraDiagramRenderOutputSchema = z.strictObject({
  artifacts: SlopcameraRenderArtifactsSchema,
  configPath: z.null(),
  findings: z.array(SlopcameraLintFindingSchema).max(4_096),
}) satisfies z.ZodType<SlopcameraDiagramRenderOutput>

export const SlopcameraVectorizeQualityReceiptSchema = z.strictObject({
  alphaRmse: z.number().finite().nonnegative(),
  colorRmse: z.number().finite().nonnegative(),
  outsideAlphaRatio: z.number().finite().min(0).max(1),
  sampleHeight: PositiveSafeIntegerSchema,
  sampleWidth: PositiveSafeIntegerSchema,
  supportRecall: z.number().finite().min(0).max(1),
}) satisfies z.ZodType<SlopcameraVectorizeQualityReceipt>

export const SlopcameraVectorizeProvenanceSchema = z.strictObject({
  arch: BoundedVersionStringSchema,
  platform: BoundedVersionStringSchema,
  sharp: BoundedVersionStringSchema,
  sharpVersions: z.record(
    z.string().min(1).max(128),
    BoundedVersionStringSchema,
  ),
  vips: BoundedVersionStringSchema,
  vtracerSha256: Sha256Schema,
  vtracerSource: z.enum(["official-release", "override"]),
  vtracerVersion: BoundedVersionStringSchema,
}) satisfies z.ZodType<SlopcameraVectorizeProvenance>

export const SlopcameraVectorizeReceiptSchema = z.strictObject({
  alphaCutoff: z.number().int().min(1).max(64),
  bytes: NonnegativeSafeIntegerSchema.max(MAX_VECTOR_OUTPUT_BYTES),
  candidatesEvaluated: PositiveSafeIntegerSchema,
  format: z.string().min(1).max(80),
  height: PositiveSafeIntegerSchema.max(4_096),
  inputBytes: PositiveSafeIntegerSchema.max(MAX_VECTOR_INPUT_BYTES),
  outputMode: z.enum(["color", "duotone"]),
  pathCount: NonnegativeSafeIntegerSchema.max(12_000),
  profile: z.enum(["balanced", "detailed", "photo"]),
  provenance: SlopcameraVectorizeProvenanceSchema,
  quality: SlopcameraVectorizeQualityReceiptSchema,
  receiptVersion: z.literal(1),
  representation: z.enum(["color-paths", "alpha-mask"]),
  sourceSha256: Sha256Schema,
  svgSha256: Sha256Schema,
  width: PositiveSafeIntegerSchema.max(4_096),
}) satisfies z.ZodType<SlopcameraVectorizeReceipt>

export const SlopcameraImageVectorizeOutputSchema = z.strictObject({
  outputPath: BoundedPathSchema,
  receipt: SlopcameraVectorizeReceiptSchema,
}) satisfies z.ZodType<SlopcameraImageVectorizeOutput>

export const SlopcameraImageGenerateOutputSchema = z.strictObject({
  bytes: PositiveSafeIntegerSchema.max(MAX_GENERATED_IMAGE_BYTES),
  mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  model: SlopcameraImageModelSchema,
  outputPath: BoundedPathSchema,
  provider: z.literal("vercel-ai-gateway"),
  requestId: z.string()
    .min(1)
    .max(256)
    .refine(
      value => !/[\u0000-\u001f\u007f]/u.test(value),
      "Request ids must not contain control characters.",
    ),
  sha256: Sha256Schema,
  warnings: z.array(z.string().min(1).max(256)).max(100),
}) satisfies z.ZodType<SlopcameraImageGenerateOutput>

export interface PortableSlopcameraOperationInputMap {
  readonly "slopcamera.diagram.check": SlopcameraDiagramCheckInput
  readonly "slopcamera.diagram.render": SlopcameraDiagramRenderInput
  readonly "slopcamera.image.generate": SlopcameraImageGenerateInput
  readonly "slopcamera.image.vectorize": SlopcameraImageVectorizeInput
}

export interface PortableSlopcameraOperationResultMap {
  readonly "slopcamera.diagram.check": SlopcameraDiagramCheckOutput
  readonly "slopcamera.diagram.render": SlopcameraDiagramRenderOutput
  readonly "slopcamera.image.generate": SlopcameraImageGenerateOutput
  readonly "slopcamera.image.vectorize": SlopcameraImageVectorizeOutput
}

export const PORTABLE_SLOPCAMERA_OPERATION_KINDS = Object.freeze([
  "slopcamera.diagram.check",
  "slopcamera.diagram.render",
  "slopcamera.image.generate",
  "slopcamera.image.vectorize",
] as const)
export type PortableSlopcameraOperationKind =
  typeof PORTABLE_SLOPCAMERA_OPERATION_KINDS[number]

export interface PortableSlopcameraOperationContract<
  Kind extends PortableSlopcameraOperationKind,
> extends OperationContract<
    PortableSlopcameraOperationInputMap[Kind],
    PortableSlopcameraOperationResultMap[Kind]
  > {
  readonly inputSchema: z.ZodType<PortableSlopcameraOperationInputMap[Kind]>
  readonly kind: Kind
  readonly lifecycle: OperationLifecycleKind
  readonly outputSchema: z.ZodType<PortableSlopcameraOperationResultMap[Kind]>
  readonly policy: OperationPolicy
  readonly version: 2
}

function freezePolicy(policy: OperationPolicy): OperationPolicy {
  const preparation = Object.freeze([...policy.preparation])
  const resources = Object.freeze(policy.resources.map(claim => Object.freeze({ ...claim })))
  return Object.freeze({ ...policy, preparation, resources })
}

function portableContract<Kind extends PortableSlopcameraOperationKind>(
  contract: PortableSlopcameraOperationContract<Kind>,
): PortableSlopcameraOperationContract<Kind> {
  return Object.freeze({ ...contract, policy: freezePolicy(contract.policy) })
}

export const PORTABLE_SLOPCAMERA_OPERATION_CONTRACTS = Object.freeze({
  "slopcamera.diagram.check": portableContract({
    inputSchema: SlopcameraDiagramCheckInputSchema,
    inputSchemaId: "slopcamera.operation.diagram.check.input/v2",
    kind: "slopcamera.diagram.check",
    lifecycle: "pure",
    outputSchema: SlopcameraDiagramCheckOutputSchema,
    outputSchemaId: "slopcamera.operation.diagram.check.output/v2",
    policy: {
      cache: "content-addressed",
      cancellable: false,
      effect: "local-read",
      maxDurationMs: 30_000,
      maxFanOut: 0,
      maxInputBytes: 4_096,
      maxOutputBytes: 256 * 1024,
      preparation: ["local-media"],
      resources: [
        { amount: 1, resource: "cpu" },
        { amount: 1, resource: "local-io" },
      ],
      resume: "deterministic",
    },
    version: 2,
  }),
  "slopcamera.diagram.render": portableContract({
    inputSchema: SlopcameraDiagramRenderInputSchema,
    inputSchemaId: "slopcamera.operation.diagram.render.input/v2",
    kind: "slopcamera.diagram.render",
    lifecycle: "local-artifact",
    outputSchema: SlopcameraDiagramRenderOutputSchema,
    outputSchemaId: "slopcamera.operation.diagram.render.output/v2",
    policy: {
      cache: "none",
      cancellable: false,
      effect: "local-derived-write",
      maxDurationMs: 120_000,
      maxFanOut: 5,
      maxInputBytes: 8_192,
      maxOutputBytes: 5 * MAX_DIAGRAM_ARTIFACT_BYTES,
      preparation: ["local-media"],
      resources: [
        { amount: 1, resource: "cpu" },
        { amount: 1, resource: "local-io" },
      ],
      resume: "ambiguous-after-dispatch",
    },
    version: 2,
  }),
  "slopcamera.image.generate": portableContract({
    inputSchema: SlopcameraImageGenerateInputSchema,
    inputSchemaId: "slopcamera.operation.image.generate.input/v2",
    kind: "slopcamera.image.generate",
    lifecycle: "paid-dispatch",
    outputSchema: SlopcameraImageGenerateOutputSchema,
    outputSchemaId: "slopcamera.operation.image.generate.output/v2",
    policy: {
      cache: "exact-run",
      cancellable: false,
      effect: "paid-cloud",
      maxDurationMs: 120_000,
      maxFanOut: 1,
      maxInputBytes: 16 * 1024,
      maxOutputBytes: MAX_GENERATED_IMAGE_BYTES,
      preparation: ["provider-options"],
      resources: [
        { amount: 1, resource: "local-io" },
        { amount: 1, resource: "network" },
        { amount: 1, resource: "paid-call" },
      ],
      resume: "ambiguous-after-dispatch",
    },
    version: 2,
  }),
  "slopcamera.image.vectorize": portableContract({
    inputSchema: SlopcameraImageVectorizeInputSchema,
    inputSchemaId: "slopcamera.operation.image.vectorize.input/v2",
    kind: "slopcamera.image.vectorize",
    lifecycle: "local-artifact",
    outputSchema: SlopcameraImageVectorizeOutputSchema,
    outputSchemaId: "slopcamera.operation.image.vectorize.output/v2",
    policy: {
      cache: "none",
      cancellable: false,
      effect: "local-derived-write",
      maxDurationMs: 300_000,
      maxFanOut: 1,
      maxInputBytes: MAX_VECTOR_INPUT_BYTES,
      maxOutputBytes: MAX_VECTOR_OUTPUT_BYTES,
      preparation: ["local-media"],
      resources: [
        { amount: 1, resource: "cpu" },
        { amount: 1, resource: "local-io" },
      ],
      resume: "ambiguous-after-dispatch",
    },
    version: 2,
  }),
}) satisfies {
  readonly [Kind in PortableSlopcameraOperationKind]: PortableSlopcameraOperationContract<Kind>
}

export function isPortableSlopcameraOperationKind(
  value: string,
): value is PortableSlopcameraOperationKind {
  return PORTABLE_SLOPCAMERA_OPERATION_KINDS.includes(
    value as PortableSlopcameraOperationKind,
  )
}
