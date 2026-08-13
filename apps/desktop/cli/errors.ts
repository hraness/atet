import {
  ApplicationError,
  type ApplicationErrorCode,
  errorMessage,
} from "../application/errors";

export { ApplicationError as CliError, errorMessage };
export type CliErrorCode = ApplicationErrorCode;

export const EXIT_CODE: Readonly<Record<CliErrorCode, number>> = {
  usage: 2,
  "not-found": 3,
  conflict: 4,
  unavailable: 5,
  "unsafe-path": 6,
  "invalid-data": 7,
  subprocess: 8,
  "unsupported-plan": 9,
  "authorization-required": 10,
  cancelled: 11,
  ambiguous: 12,
  incompatible: 13,
  internal: 1,
};

export function asCliError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error;
  return new ApplicationError("internal", errorMessage(error));
}
