export type TransmuteCodeErrorCode =
  | "usage"
  | "not-found"
  | "conflict"
  | "unavailable"
  | "unsafe-path"
  | "invalid-data"
  | "subprocess"
  | "unsupported-plan"
  | "authorization-required"
  | "cancelled"
  | "ambiguous"
  | "incompatible"
  | "internal"

export class TransmuteCodeError extends Error {
  readonly code: TransmuteCodeErrorCode
  readonly details: Readonly<Record<string, unknown>> | undefined

  constructor(
    code: TransmuteCodeErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
    this.name = "TransmuteCodeError"
    this.code = code
    this.details = details === undefined
      ? undefined
      : Object.freeze({ ...details })
  }
}

export function transmuteCodeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function asTransmuteCodeError(error: unknown): TransmuteCodeError {
  if (error instanceof TransmuteCodeError) return error
  return new TransmuteCodeError("internal", transmuteCodeErrorMessage(error))
}
