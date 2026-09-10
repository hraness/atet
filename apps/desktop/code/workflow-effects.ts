import { Cause, Context, Deferred, Effect, Exit, Fiber, FiberId, Layer, ManagedRuntime, Ref, Scope } from "effect";

export type WorkflowFailurePhase = "admission" | "authority" | "compute" | "operation" | "monitor" | "cleanup";
export type WorkflowFailure = Readonly<{
  _tag: "WorkflowBoundaryFailure";
  phase: WorkflowFailurePhase;
  cause: unknown;
}>;

export function workflowBoundary<A>(
  phase: WorkflowFailurePhase,
  execute: () => A | Promise<A>,
): Effect.Effect<A, WorkflowFailure> {
  return Effect.tryPromise({
    try: async () => await execute(),
    catch: (cause): WorkflowFailure => ({ _tag: "WorkflowBoundaryFailure", phase, cause }),
  });
}

export function workflowValidation<A>(phase: WorkflowFailurePhase, evaluate: () => A): Effect.Effect<A, WorkflowFailure> {
  return Effect.try({ try: evaluate, catch: (cause): WorkflowFailure => ({ _tag: "WorkflowBoundaryFailure", phase, cause }) });
}

export function workflowFailure(cause: unknown, phase: WorkflowFailurePhase = "authority"): WorkflowFailure {
  return { _tag: "WorkflowBoundaryFailure", phase, cause };
}

export function workflowExitValue<A>(exit: Exit.Exit<A, WorkflowFailure>): A {
  if (Exit.isSuccess(exit)) return exit.value;
  const failures = [
    ...Array.from(Cause.failures(exit.cause), failure => failure.cause),
    ...Cause.defects(exit.cause),
  ];
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Workflow execution and cleanup failed.");
  throw Cause.squash(exit.cause);
}

class WorkflowCleanup extends Context.Tag("@slopcamera/local/WorkflowCleanup")<
  WorkflowCleanup, Ref.Ref<Cause.Cause<WorkflowFailure>>
>() { }

export function workflowResource<A>(
  acquire: Effect.Effect<A, WorkflowFailure>,
  release: (value: A) => Effect.Effect<void, WorkflowFailure>,
): Effect.Effect<A, WorkflowFailure, Scope.Scope | WorkflowCleanup> {
  return Effect.gen(function*() {
    const cleanup = yield* WorkflowCleanup;
    return yield* Effect.acquireRelease(acquire, value => Effect.flatMap(
      Effect.exit(release(value)),
      exit => Exit.isFailure(exit)
        ? Ref.update(cleanup, cause => Cause.parallel(cause, exit.cause))
        : Effect.void,
    ));
  });
}

export function workflowScoped<A>(
  program: Effect.Effect<A, WorkflowFailure, Scope.Scope | WorkflowCleanup>,
): Effect.Effect<A, WorkflowFailure> {
  return Effect.gen(function*() {
    const failures = yield* Ref.make<Cause.Cause<WorkflowFailure>>(Cause.empty);
    const result = yield* Effect.exit(Effect.scoped(Effect.provideService(program, WorkflowCleanup, failures)));
    const cleanup = yield* Ref.get(failures);
    return yield* Exit.zipLeft(result, Cause.isEmpty(cleanup) ? Exit.void : Exit.failCause(cleanup));
  });
}

/** One owner per run. Observer cancellation never serves as foreign-custody proof. */
export class WorkflowEffectRuntime {
  readonly #runtime = ManagedRuntime.make(Layer.empty);
  readonly #watchers = new Map<Fiber.RuntimeFiber<void, never>, boolean>();
  #custody = 0;
  #closing = false;
  #disposing: Promise<void> | undefined;

  async run<A>(program: Effect.Effect<A, WorkflowFailure>): Promise<A> {
    return workflowExitValue(await this.#runtime.runPromiseExit(program));
  }

  deferred<A, E>(): Deferred.Deferred<A, E> {
    return Deferred.unsafeMake<A, E>(FiberId.none);
  }

  watch(program: Effect.Effect<void>, retainUntilSettled = false): () => Promise<void> {
    const fiber = this.#runtime.runFork(program);
    this.#watchers.set(fiber, retainUntilSettled);
    fiber.addObserver(() => { this.#watchers.delete(fiber); });
    return async () => { await this.#runtime.runPromise(Effect.asVoid(Fiber.interrupt(fiber))); };
  }

  fork<A, E>(program: Effect.Effect<A, E>): Fiber.RuntimeFiber<A, E> {
    this.#custody += 1;
    const fiber = this.#runtime.runFork(program);
    fiber.addObserver(() => {
      this.#custody -= 1;
      this.#disposeWhenQuiescent();
    });
    return fiber;
  }

  /** Native host callbacks retain their own kernel/publication leases until actual settlement. */
  async custody<A>(program: Effect.Effect<A, WorkflowFailure>): Promise<A> {
    this.#custody += 1;
    try {
      return workflowExitValue(await this.#runtime.runPromiseExit(Effect.uninterruptible(program)));
    } finally {
      this.#custody -= 1;
      this.#disposeWhenQuiescent();
    }
  }

  async stop(): Promise<void> {
    await this.#runtime.runPromise(Effect.forEach(
      [...this.#watchers].filter(([, retain]) => !retain), ([fiber]) => Effect.asVoid(Fiber.interrupt(fiber)),
      { concurrency: "unbounded", discard: true },
    ));
    this.#closing = true;
    this.#disposeWhenQuiescent();
    // A timed-out foreign callback may still hold a publication or kernel lease.
    // Its continuation, not this observer shutdown, closes the runtime.
    if (this.#custody === 0) await this.#disposing;
  }

  #disposeWhenQuiescent(): void {
    if (this.#closing && this.#custody === 0 && this.#disposing === undefined) {
      this.#disposing = this.#runtime.dispose();
      // Layer.empty has no failing finalizers. Observe detached disposal anyway.
      void this.#disposing.catch(() => undefined);
    }
  }
}
