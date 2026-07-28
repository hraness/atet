export type TransmuteCloudErrorCode =
  | "AUTHORIZATION_FAILED"
  | "AUTH_CALLBACK_UNAVAILABLE"
  | "AUTH_REQUIRED"
  | "AUTH_TIMEOUT"
  | "DISCOVERY_INVALID"
  | "DISCOVERY_UNAVAILABLE"
  | "GENERATION_FAILED"
  | "GENERATION_INVALID_RESPONSE"
  | "INVALID_ARGUMENT"
  | "OUTPUT_WRITE_FAILED"
  | "REVOCATION_FAILED"
  | "TOKEN_EXCHANGE_FAILED"
  | "TOKEN_REFRESH_FAILED"
  | "TOKEN_STORAGE_FAILED"

/**
 * A stable, redacted failure from the Transmute network boundary.
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
