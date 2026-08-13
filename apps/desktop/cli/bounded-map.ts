import { CliError } from "./errors";

/** Map asynchronous work with a fixed process-safe concurrency ceiling. */
export async function mapBounded<Value, Result>(
  values: readonly Value[],
  concurrency: number,
  operation: (value: Value, index: number) => Promise<Result>,
): Promise<readonly Result[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) {
    throw new CliError("invalid-data", "Bounded-map concurrency must be an integer from 1 through 64.");
  }
  if (values.length === 0) return [];

  const results = new Array<Result>(values.length);
  let nextIndex = 0;
  let failed = false;
  let firstFailure: unknown;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      try {
        results[index] = await operation(values[index]!, index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstFailure = error;
        }
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => await worker(),
  ));
  if (failed) throw firstFailure;
  return results;
}
