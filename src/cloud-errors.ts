export type SlopcameraCloudErrorCode =
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
export class SlopcameraCloudError extends Error {
  readonly code: SlopcameraCloudErrorCode

  constructor(
    code: SlopcameraCloudErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`[${code}] ${message}`, options)
    this.name = "SlopcameraCloudError"
    this.code = code
  }
}
