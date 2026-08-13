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

export type TransmuteImageModel = string

export interface TransmuteDiagramCheckInput {
  readonly path: string
}

export interface TransmuteDiagramRenderInput extends TransmuteDiagramCheckInput {
  readonly outDirectory?: string
  readonly scale?: number
}

export interface TransmuteImageVectorizeInput {
  readonly alphaCutoff?: number
  readonly duotone?: readonly [string, string]
  readonly inputPath: string
  readonly outputPath: string
  readonly timeoutMs?: number
}

export interface TransmuteImageGenerateInput {
  readonly model: TransmuteImageModel
  readonly outputPath: string
  readonly prompt: string
}

export interface TransmuteLintFinding {
  readonly code: string
  readonly message: string
  readonly shapeIds: readonly string[]
}

export interface TransmuteDiagramCheckOutput {
  readonly configPath: null
  readonly findings: readonly TransmuteLintFinding[]
}

export interface TransmuteRenderArtifacts {
  readonly darkPng: string
  readonly darkSvg: string
  readonly lightPng: string
  readonly lightSvg: string
  readonly spec: string
  readonly tldr: string
}

export interface TransmuteDiagramRenderOutput {
  readonly artifacts: TransmuteRenderArtifacts
  readonly configPath: null
  readonly findings: readonly TransmuteLintFinding[]
}

export interface TransmuteVectorizeQualityReceipt {
  readonly alphaRmse: number
  readonly colorRmse: number
  readonly outsideAlphaRatio: number
  readonly sampleHeight: number
  readonly sampleWidth: number
  readonly supportRecall: number
}

export interface TransmuteVectorizeProvenance {
  readonly arch: string
  readonly platform: string
  readonly sharp: string
  readonly sharpVersions: Readonly<Record<string, string>>
  readonly vips: string
  readonly vtracerSha256: string
  readonly vtracerSource: "official-release" | "override"
  readonly vtracerVersion: string
}

export interface TransmuteVectorizeReceipt {
  readonly alphaCutoff: number
  readonly bytes: number
  readonly candidatesEvaluated: number
  readonly format: string
  readonly height: number
  readonly inputBytes: number
  readonly outputMode: "color" | "duotone"
  readonly pathCount: number
  readonly profile: "balanced" | "detailed" | "photo"
  readonly provenance: TransmuteVectorizeProvenance
  readonly quality: TransmuteVectorizeQualityReceipt
  readonly receiptVersion: 1
  readonly representation: "color-paths" | "alpha-mask"
  readonly sourceSha256: string
  readonly svgSha256: string
  readonly width: number
}

export interface TransmuteImageVectorizeOutput {
  readonly outputPath: string
  readonly receipt: TransmuteVectorizeReceipt
}

export interface TransmuteImageGenerateOutput {
  readonly bytes: number
  readonly mediaType: "image/jpeg" | "image/png" | "image/webp"
  readonly model: TransmuteImageModel
  readonly outputPath: string
  readonly provider: "vercel-ai-gateway"
  readonly requestId: string
  readonly sha256: string
  readonly warnings: readonly string[]
}

export const TransmuteImageModelSchema = z.string()
  .min(3)
  .max(256)
  .regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/iu) satisfies z.ZodType<TransmuteImageModel>

export const TransmuteDiagramCheckInputSchema = z.strictObject({
  path: BoundedPathSchema,
}) satisfies z.ZodType<TransmuteDiagramCheckInput>

export const TransmuteDiagramRenderInputSchema = schemaWithReadonlyOutput<
  TransmuteDiagramRenderInput
>(z.strictObject({
  outDirectory: BoundedPathSchema.optional(),
  path: BoundedPathSchema,
  scale: z.number().finite().positive().max(4).optional(),
}))

export const TransmuteImageVectorizeInputSchema = schemaWithReadonlyOutput<
  TransmuteImageVectorizeInput
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

export const TransmuteImageGenerateInputSchema = schemaWithReadonlyOutput<
  TransmuteImageGenerateInput
>(z.strictObject({
  model: TransmuteImageModelSchema,
  outputPath: BoundedPathSchema.refine(
    value => /\.(?:jpe?g|png|webp)$/iu.test(value),
    "Generated image output paths must end in .png, .jpg, .jpeg, or .webp.",
  ),
  prompt: PromptSchema,
}))

export const TransmuteLintFindingSchema = z.strictObject({
  code: z.string().min(1).max(160),
  message: z.string().min(1).max(4_096),
  shapeIds: z.array(z.string().min(1).max(256)).max(4_096),
}) satisfies z.ZodType<TransmuteLintFinding>

export const TransmuteDiagramCheckOutputSchema = z.strictObject({
  configPath: z.null(),
  findings: z.array(TransmuteLintFindingSchema).max(4_096),
}) satisfies z.ZodType<TransmuteDiagramCheckOutput>

export const TransmuteRenderArtifactsSchema = z.strictObject({
  darkPng: BoundedPathSchema,
  darkSvg: BoundedPathSchema,
  lightPng: BoundedPathSchema,
  lightSvg: BoundedPathSchema,
  spec: BoundedPathSchema,
  tldr: BoundedPathSchema,
}) satisfies z.ZodType<TransmuteRenderArtifacts>

export const TransmuteDiagramRenderOutputSchema = z.strictObject({
  artifacts: TransmuteRenderArtifactsSchema,
  configPath: z.null(),
  findings: z.array(TransmuteLintFindingSchema).max(4_096),
}) satisfies z.ZodType<TransmuteDiagramRenderOutput>

export const TransmuteVectorizeQualityReceiptSchema = z.strictObject({
  alphaRmse: z.number().finite().nonnegative(),
  colorRmse: z.number().finite().nonnegative(),
  outsideAlphaRatio: z.number().finite().min(0).max(1),
  sampleHeight: PositiveSafeIntegerSchema,
  sampleWidth: PositiveSafeIntegerSchema,
  supportRecall: z.number().finite().min(0).max(1),
}) satisfies z.ZodType<TransmuteVectorizeQualityReceipt>

export const TransmuteVectorizeProvenanceSchema = z.strictObject({
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
}) satisfies z.ZodType<TransmuteVectorizeProvenance>

export const TransmuteVectorizeReceiptSchema = z.strictObject({
  alphaCutoff: z.number().int().min(1).max(64),
  bytes: NonnegativeSafeIntegerSchema.max(MAX_VECTOR_OUTPUT_BYTES),
  candidatesEvaluated: PositiveSafeIntegerSchema,
  format: z.string().min(1).max(80),
  height: PositiveSafeIntegerSchema.max(4_096),
  inputBytes: PositiveSafeIntegerSchema.max(MAX_VECTOR_INPUT_BYTES),
  outputMode: z.enum(["color", "duotone"]),
  pathCount: NonnegativeSafeIntegerSchema.max(12_000),
  profile: z.enum(["balanced", "detailed", "photo"]),
  provenance: TransmuteVectorizeProvenanceSchema,
  quality: TransmuteVectorizeQualityReceiptSchema,
  receiptVersion: z.literal(1),
  representation: z.enum(["color-paths", "alpha-mask"]),
  sourceSha256: Sha256Schema,
  svgSha256: Sha256Schema,
  width: PositiveSafeIntegerSchema.max(4_096),
}) satisfies z.ZodType<TransmuteVectorizeReceipt>

export const TransmuteImageVectorizeOutputSchema = z.strictObject({
  outputPath: BoundedPathSchema,
  receipt: TransmuteVectorizeReceiptSchema,
}) satisfies z.ZodType<TransmuteImageVectorizeOutput>

export const TransmuteImageGenerateOutputSchema = z.strictObject({
  bytes: PositiveSafeIntegerSchema.max(MAX_GENERATED_IMAGE_BYTES),
  mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  model: TransmuteImageModelSchema,
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
}) satisfies z.ZodType<TransmuteImageGenerateOutput>

export interface PortableTransmuteOperationInputMap {
  readonly "transmute.diagram.check": TransmuteDiagramCheckInput
  readonly "transmute.diagram.render": TransmuteDiagramRenderInput
  readonly "transmute.image.generate": TransmuteImageGenerateInput
  readonly "transmute.image.vectorize": TransmuteImageVectorizeInput
}

export interface PortableTransmuteOperationResultMap {
  readonly "transmute.diagram.check": TransmuteDiagramCheckOutput
  readonly "transmute.diagram.render": TransmuteDiagramRenderOutput
  readonly "transmute.image.generate": TransmuteImageGenerateOutput
  readonly "transmute.image.vectorize": TransmuteImageVectorizeOutput
}

export const PORTABLE_TRANSMUTE_OPERATION_KINDS = Object.freeze([
  "transmute.diagram.check",
  "transmute.diagram.render",
  "transmute.image.generate",
  "transmute.image.vectorize",
] as const)
export type PortableTransmuteOperationKind =
  typeof PORTABLE_TRANSMUTE_OPERATION_KINDS[number]

export interface PortableTransmuteOperationContract<
  Kind extends PortableTransmuteOperationKind,
> extends OperationContract<
    PortableTransmuteOperationInputMap[Kind],
    PortableTransmuteOperationResultMap[Kind]
  > {
  readonly inputSchema: z.ZodType<PortableTransmuteOperationInputMap[Kind]>
  readonly kind: Kind
  readonly lifecycle: OperationLifecycleKind
  readonly outputSchema: z.ZodType<PortableTransmuteOperationResultMap[Kind]>
  readonly policy: OperationPolicy
  readonly version: 2
}

function freezePolicy(policy: OperationPolicy): OperationPolicy {
  const preparation = Object.freeze([...policy.preparation])
  const resources = Object.freeze(policy.resources.map(claim => Object.freeze({ ...claim })))
  return Object.freeze({ ...policy, preparation, resources })
}

function portableContract<Kind extends PortableTransmuteOperationKind>(
  contract: PortableTransmuteOperationContract<Kind>,
): PortableTransmuteOperationContract<Kind> {
  return Object.freeze({ ...contract, policy: freezePolicy(contract.policy) })
}

export const PORTABLE_TRANSMUTE_OPERATION_CONTRACTS = Object.freeze({
  "transmute.diagram.check": portableContract({
    inputSchema: TransmuteDiagramCheckInputSchema,
    inputSchemaId: "transmute.operation.diagram.check.input/v2",
    kind: "transmute.diagram.check",
    lifecycle: "pure",
    outputSchema: TransmuteDiagramCheckOutputSchema,
    outputSchemaId: "transmute.operation.diagram.check.output/v2",
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
  "transmute.diagram.render": portableContract({
    inputSchema: TransmuteDiagramRenderInputSchema,
    inputSchemaId: "transmute.operation.diagram.render.input/v2",
    kind: "transmute.diagram.render",
    lifecycle: "local-artifact",
    outputSchema: TransmuteDiagramRenderOutputSchema,
    outputSchemaId: "transmute.operation.diagram.render.output/v2",
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
  "transmute.image.generate": portableContract({
    inputSchema: TransmuteImageGenerateInputSchema,
    inputSchemaId: "transmute.operation.image.generate.input/v2",
    kind: "transmute.image.generate",
    lifecycle: "paid-dispatch",
    outputSchema: TransmuteImageGenerateOutputSchema,
    outputSchemaId: "transmute.operation.image.generate.output/v2",
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
  "transmute.image.vectorize": portableContract({
    inputSchema: TransmuteImageVectorizeInputSchema,
    inputSchemaId: "transmute.operation.image.vectorize.input/v2",
    kind: "transmute.image.vectorize",
    lifecycle: "local-artifact",
    outputSchema: TransmuteImageVectorizeOutputSchema,
    outputSchemaId: "transmute.operation.image.vectorize.output/v2",
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
  readonly [Kind in PortableTransmuteOperationKind]: PortableTransmuteOperationContract<Kind>
}

export function isPortableTransmuteOperationKind(
  value: string,
): value is PortableTransmuteOperationKind {
  return PORTABLE_TRANSMUTE_OPERATION_KINDS.includes(
    value as PortableTransmuteOperationKind,
  )
}
