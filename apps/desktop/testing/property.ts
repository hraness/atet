import fc from "fast-check";
import type { IAsyncProperty, IProperty, Parameters } from "fast-check";

export { fc };
export type * from "fast-check";

export const propertyParameters = {
  interruptAfterTimeLimit: 10_000,
  markInterruptAsFailure: true,
  numRuns: 200,
} satisfies Parameters<unknown>;

export function assertProperty<Values>(
  property: IProperty<Values>,
  overrides: Parameters<Values> = {},
): void {
  fc.assert(property, { ...propertyParameters, ...overrides });
}

export async function assertAsyncProperty<Values>(
  property: IAsyncProperty<Values>,
  overrides: Parameters<Values> = {},
): Promise<void> {
  await fc.assert(property, { ...propertyParameters, ...overrides });
}
