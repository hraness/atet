export const vectorizeProfileNames = ["balanced", "detailed", "photo"] as const

export type VectorizeProfile = (typeof vectorizeProfileNames)[number]
export type VectorizeRepresentation = "color-paths" | "alpha-mask"
export type VectorizeOutputMode = "color" | "duotone"
export type VectorizeInput = string | Uint8Array | ArrayBuffer

export interface VectorizeLimits {
  readonly maxDecodedPixels: number
  readonly maxDimension: number
  readonly maxDurationMs: number
  readonly maxInputBytes: number
  readonly maxOutputBytes: number
  readonly maxPaths: number
}

export interface VectorizeOptions {
  /**
   * Pixels below this alpha byte are removed before tracing. Atet also
   * evaluates an alpha-preserving candidate when the removed mass is material.
   */
  readonly alphaCutoff?: number
  /** Directory used for the checksum-pinned VTracer binary. */
  readonly cacheDirectory?: string
  /** Replace traced colors with a primary and secondary color. */
  readonly duotone?: readonly [primary: string, secondary: string]
  /**
   * Advanced host authority inherited by the isolated worker and tracer.
   * At most sixteen unique open descriptors are accepted. Values are never
   * recorded in provenance or receipts.
   */
  readonly inheritedFileDescriptors?: readonly number[]
  /** Bound a conversion more tightly than the package hard limits. */
  readonly limits?: Partial<VectorizeLimits>
  /** Atomically replace this file after every quality gate succeeds. */
  readonly outputPath?: string
}

export type VectorizeErrorCode =
  | "input_limit"
  | "invalid_input"
  | "output_limit"
  | "quality_limit"
  | "timeout"
  | "tool_download"
  | "tool_integrity"
  | "tool_platform"
  | "tool_version"
  | "trace_failed"
  | "unsafe_svg"

export class VectorizeError extends Error {
  readonly code: VectorizeErrorCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    code: VectorizeErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "VectorizeError"
    this.code = code
    this.details = details
  }
}

export interface VectorizeQualityReceipt {
  readonly alphaRmse: number
  readonly colorRmse: number
  readonly outsideAlphaRatio: number
  readonly sampleHeight: number
  readonly sampleWidth: number
  readonly supportRecall: number
}

export interface VectorizeProvenance {
  readonly arch: NodeJS.Architecture
  readonly platform: NodeJS.Platform
  readonly sharp: string
  /** Sorted version metadata reported by the loaded Sharp runtime. */
  readonly sharpVersions: Readonly<Record<string, string>>
  readonly vips: string
  readonly vtracerSha256: string
  readonly vtracerSource: "official-release" | "override"
  readonly vtracerVersion: string
}

export interface VectorizeReceipt {
  readonly alphaCutoff: number
  readonly bytes: number
  readonly candidatesEvaluated: number
  readonly format: string
  readonly height: number
  readonly inputBytes: number
  readonly outputMode: VectorizeOutputMode
  readonly pathCount: number
  readonly profile: VectorizeProfile
  readonly provenance: VectorizeProvenance
  readonly quality: VectorizeQualityReceipt
  readonly receiptVersion: 1
  readonly representation: VectorizeRepresentation
  readonly sourceSha256: string
  readonly svgSha256: string
  readonly width: number
}

export interface VectorizeResult {
  readonly outputPath: string | null
  readonly receipt: VectorizeReceipt
  readonly svg: string
}
