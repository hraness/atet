export type AtetCodeErrorCode =
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

export class AtetCodeError extends Error {
  readonly code: AtetCodeErrorCode
  readonly details: Readonly<Record<string, unknown>> | undefined

  constructor(
    code: AtetCodeErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
    this.name = "AtetCodeError"
    this.code = code
    this.details = details === undefined
      ? undefined
      : Object.freeze({ ...details })
  }
}

export function atetCodeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function asAtetCodeError(error: unknown): AtetCodeError {
  if (error instanceof AtetCodeError) return error
  return new AtetCodeError("internal", atetCodeErrorMessage(error))
}

/** @deprecated Use Atet names for newly authored integrations. */
export type TransmuteCodeErrorCode = AtetCodeErrorCode
/** @deprecated Use {@link AtetCodeError}. */
export { AtetCodeError as TransmuteCodeError }
/** @deprecated Use {@link atetCodeErrorMessage}. */
export const transmuteCodeErrorMessage = atetCodeErrorMessage
/** @deprecated Use {@link asAtetCodeError}. */
export const asTransmuteCodeError = asAtetCodeError
