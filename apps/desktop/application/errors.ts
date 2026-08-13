import {
  TransmuteCodeError,
  asTransmuteCodeError,
  transmuteCodeErrorMessage,
  type TransmuteCodeErrorCode,
} from "@hraness/transmute/code/advanced";

export type ApplicationErrorCode = TransmuteCodeErrorCode;
export type ApplicationError = TransmuteCodeError;

/** The complete local host and portable SDK share one error identity. */
export const ApplicationError = TransmuteCodeError;

export const errorMessage = transmuteCodeErrorMessage;

export function asApplicationError(error: unknown): ApplicationError {
  return asTransmuteCodeError(error);
}
