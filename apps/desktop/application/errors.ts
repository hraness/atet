import {
  AtetCodeError,
  asAtetCodeError,
  atetCodeErrorMessage,
  type AtetCodeErrorCode,
} from "@hraness/atet/code/advanced";

export type ApplicationErrorCode = AtetCodeErrorCode;
export type ApplicationError = AtetCodeError;

/** The complete local host and portable SDK share one error identity. */
export const ApplicationError = AtetCodeError;

export const errorMessage = atetCodeErrorMessage;

export function asApplicationError(error: unknown): ApplicationError {
  return asAtetCodeError(error);
}
