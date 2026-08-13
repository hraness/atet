export type TransmuteCloudErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "GENERATION_FAILED"
  | "GENERATION_INVALID_RESPONSE"
  | "INVALID_ARGUMENT"
  | "OUTPUT_WRITE_FAILED"

/**
 * A stable, redacted failure from the direct Gateway boundary.
 *
 * `cause` is retained for local diagnostics but is deliberately not included
 * in the public message or CLI output.
 */
export class TransmuteCloudError extends Error {
  readonly code: TransmuteCloudErrorCode

  constructor(
    code: TransmuteCloudErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`[${code}] ${message}`, options)
    this.name = "TransmuteCloudError"
    this.code = code
  }
}
