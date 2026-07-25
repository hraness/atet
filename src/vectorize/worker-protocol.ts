import { vectorizeHardLimits } from "./limits.ts"
import {
  type VectorizeErrorCode,
  type VectorizeOptions,
  type VectorizeResult,
} from "./types.ts"

export const VECTORIZE_WORKER_PROTOCOL = 1
export const MAX_VECTORIZE_REQUEST_BYTES =
  Math.ceil(vectorizeHardLimits.maxInputBytes / 3) * 4 + 512 * 1_024
export const MAX_VECTORIZE_RESPONSE_BYTES =
  vectorizeHardLimits.maxOutputBytes * 2 + 512 * 1_024

export type VectorizeWorkerInput =
  | Readonly<{ kind: "bytes"; value: string }>
  | Readonly<{ kind: "path"; value: string }>

export interface VectorizeWorkerRequest {
  readonly input: VectorizeWorkerInput
  readonly options: VectorizeOptions
  readonly protocol: typeof VECTORIZE_WORKER_PROTOCOL
  /** Conversion-private directory created and removed by the supervisor. */
  readonly temporaryRoot: string
}

export type VectorizeWorkerResponse =
  | Readonly<{
      error: Readonly<{
        code: VectorizeErrorCode
        details: Readonly<Record<string, unknown>>
        message: string
      }>
      ok: false
      protocol: typeof VECTORIZE_WORKER_PROTOCOL
    }>
  | Readonly<{
      ok: true
      protocol: typeof VECTORIZE_WORKER_PROTOCOL
      result: VectorizeResult
    }>
