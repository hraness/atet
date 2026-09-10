export type SlopcameraCodeErrorCode =
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

export class SlopcameraCodeError extends Error {
  readonly code: SlopcameraCodeErrorCode
  readonly details: Readonly<Record<string, unknown>> | undefined

  constructor(
    code: SlopcameraCodeErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
    this.name = "SlopcameraCodeError"
    this.code = code
    this.details = details === undefined
      ? undefined
      : Object.freeze({ ...details })
  }
}

export function slopcameraCodeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function asSlopcameraCodeError(error: unknown): SlopcameraCodeError {
  if (error instanceof SlopcameraCodeError) return error
  return new SlopcameraCodeError("internal", slopcameraCodeErrorMessage(error))
}
