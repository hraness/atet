import {
  SlopcameraCodeError,
  asSlopcameraCodeError,
  slopcameraCodeErrorMessage,
  type SlopcameraCodeErrorCode,
} from "@hraness/slopcamera/code/advanced";

export type ApplicationErrorCode = SlopcameraCodeErrorCode;
export type ApplicationError = SlopcameraCodeError;

/** The complete local host and portable SDK share one error identity. */
export const ApplicationError = SlopcameraCodeError;

export const errorMessage = slopcameraCodeErrorMessage;

export function asApplicationError(error: unknown): ApplicationError {
  return asSlopcameraCodeError(error);
}
