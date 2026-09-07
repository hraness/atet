import { Cause, Effect, Exit } from "effect";

export type OperationFailurePhase = "input" | "execution" | "output" | "media" | "capability" | "project" | "workspace" | "publication" | "checkpoint" | "cleanup";
export type OperationEffectFailure = Readonly<{
  _tag: "OperationBoundaryFailure";
  phase: OperationFailurePhase;
  cause: unknown;
  /** Earlier native failures; never part of the public rejection or a receipt. */
  priorCause?: Cause.Cause<OperationEffectFailure>;
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

function operationCauseValue(cause: Cause.Cause<OperationEffectFailure>): unknown {
  const failures = [
    ...Array.from(Cause.failures(cause), failure => failure.cause),
    ...Cause.defects(cause),
  ];
  if (failures.length === 1) return failures[0];
  if (failures.length > 1) return new AggregateError(failures, "Operation execution and cleanup failed.");
  return Cause.squash(cause);
}

export function operationExitValue<A>(exit: Exit.Exit<A, OperationEffectFailure>): A {
  if (Exit.isSuccess(exit)) return exit.value;
  throw operationCauseValue(exit.cause);
}

/** Preserve native finally precedence without losing the earlier typed Cause. */
export function operationFinally<A, R, R2>(
  use: Effect.Effect<A, OperationEffectFailure, R>,
  release: Effect.Effect<void, OperationEffectFailure, R2>,
): Effect.Effect<A, OperationEffectFailure, R | R2> {
  return Effect.uninterruptibleMask(restore => Effect.gen(function*() {
    const result = yield* Effect.exit(restore(use));
    const cleanup = yield* Effect.exit(release);
    if (Exit.isSuccess(cleanup)) return yield* result;
    const selected = Cause.failureOption(cleanup.cause);
    const failure: OperationEffectFailure = selected._tag === "Some"
      && Array.from(Cause.failures(cleanup.cause)).length === 1
      && Array.from(Cause.defects(cleanup.cause)).length === 0
      ? Exit.isSuccess(result) ? selected.value : {
          ...selected.value,
          priorCause: selected.value.priorCause === undefined
            ? result.cause
            : Cause.sequential(result.cause, selected.value.priorCause),
        }
      : {
          _tag: "OperationBoundaryFailure",
          phase: "cleanup",
          cause: operationCauseValue(cleanup.cause),
          ...(Exit.isFailure(result) ? { priorCause: result.cause } : {}),
        };
    return yield* Effect.fail(failure);
  }));
}

/** Acquisition cannot escape before its native release has an owner. */
export function operationResource<A, B, R, R2, R3>(
  acquire: Effect.Effect<A, OperationEffectFailure, R>,
  use: (value: A) => Effect.Effect<B, OperationEffectFailure, R2>,
  release: (value: A) => Effect.Effect<void, OperationEffectFailure, R3>,
): Effect.Effect<B, OperationEffectFailure, R | R2 | R3> {
  return Effect.uninterruptibleMask(restore => Effect.gen(function*() {
    const value = yield* acquire;
    return yield* operationFinally(Effect.suspend(() => restore(use(value))), Effect.suspend(() => release(value)));
  }));
}

/** Compatibility root for a standalone operation; schedulers compose directly. */
export async function runStandaloneOperation<A>(
  program: Effect.Effect<A, OperationEffectFailure>,
): Promise<A> {
  return operationExitValue(await Effect.runPromiseExit(program));
}
