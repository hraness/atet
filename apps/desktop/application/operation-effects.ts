import { Cause, Effect, Exit } from "effect";

export type OperationFailurePhase = "input" | "execution" | "output" | "media" | "capability" | "project" | "workspace" | "publication" | "checkpoint" | "cleanup";
export type OperationEffectFailure = Readonly<{
  _tag: "OperationBoundaryFailure";
  phase: OperationFailurePhase;
  cause: unknown;
}>;

/** Native application ports preserve their existing public exception identity. */
export function operationBoundary<A>(
  phase: OperationFailurePhase,
  execute: () => A | Promise<A>,
): Effect.Effect<A, OperationEffectFailure> {
  return Effect.tryPromise({
    try: async () => await execute(),
    catch: (cause): OperationEffectFailure => ({ _tag: "OperationBoundaryFailure", phase, cause }),
  });
}

export function operationValidation<A>(
  phase: OperationFailurePhase,
  evaluate: () => A,
): Effect.Effect<A, OperationEffectFailure> {
  return Effect.try({
    try: evaluate,
    catch: (cause): OperationEffectFailure => ({ _tag: "OperationBoundaryFailure", phase, cause }),
  });
}

export function operationExitValue<A>(exit: Exit.Exit<A, OperationEffectFailure>): A {
  if (Exit.isSuccess(exit)) return exit.value;
  const failures = [
    ...Array.from(Cause.failures(exit.cause), failure => failure.cause),
    ...Cause.defects(exit.cause),
  ];
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Operation execution and cleanup failed.");
  throw Cause.squash(exit.cause);
}

/** Compatibility root for a standalone operation; schedulers compose directly. */
export async function runStandaloneOperation<A>(
  program: Effect.Effect<A, OperationEffectFailure>,
): Promise<A> {
  return operationExitValue(await Effect.runPromiseExit(program));
}
