import { ApplicationError } from "../application/errors";
import { Cause, Deferred, Effect, Exit, Fiber, FiberId, Layer, ManagedRuntime, Scope } from "effect";

export type WorkerFailure = Readonly<{
  _tag: "WorkerBoundaryFailure";
  phase: "protocol" | "admission" | "compute" | "retirement";
  cause: unknown;
}>;

export function workerBoundary<A>(
  phase: WorkerFailure["phase"], execute: () => A | Promise<A>,
): Effect.Effect<A, WorkerFailure> {
  return Effect.tryPromise({
    try: async () => await execute(),
    catch: (cause): WorkerFailure => ({ _tag: "WorkerBoundaryFailure", phase, cause }),
  });
}

export function workerValidation<A>(
  phase: WorkerFailure["phase"], execute: () => A,
): Effect.Effect<A, WorkerFailure> {
  return Effect.try({
    try: execute,
    catch: (cause): WorkerFailure => ({ _tag: "WorkerBoundaryFailure", phase, cause }),
  });
}

export interface WorkerCompletion<A> {
  readonly await: Effect.Effect<A, WorkerFailure>;
  activate(): void;
  complete(exit: Exit.Exit<A, WorkerFailure>): void;
  fail(error: unknown): void;
  succeed(value: A): void;
}

export class WorkerEffectRuntime {
  readonly #runtime = ManagedRuntime.make(Layer.empty);
  readonly #scope = Effect.runSync(Scope.make());
  #active = 0;
  #closed = false;
  #closing: Promise<void> | undefined;
  readonly serial = Effect.unsafeMakeSemaphore(1);

  async run<A>(program: Effect.Effect<A, WorkerFailure>): Promise<A> {
    const fiber = this.fork(program);
    const exit = await this.#runtime.runPromiseExit(Fiber.join(fiber));
    if (Exit.isSuccess(exit)) return exit.value;
    const errors = [
      ...Array.from(Cause.failures(exit.cause), failure => failure.cause),
      ...Cause.defects(exit.cause),
    ];
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "Worker execution and retirement failed.");
    throw Cause.squash(exit.cause);
  }

  fork<A, E>(program: Effect.Effect<A, E>): Fiber.RuntimeFiber<A, E> {
    if (this.#closed) throw new ApplicationError("conflict", "Code-worker runtime is already closed.");
    this.#active += 1;
    try {
      const fiber = this.#runtime.runFork(program, { scope: this.#scope });
      fiber.addObserver(() => { this.#active -= 1; });
      return fiber;
    } catch (error) {
      this.#active -= 1;
      throw error;
    }
  }

  /** Reserve in native tables before activation; all contenders settle one Deferred. */
  completion<A>(timeoutMs: number, onDeadline: () => void): WorkerCompletion<A> {
    const done = Deferred.unsafeMake<A, WorkerFailure>(FiberId.none);
    let settled = false;
    let activated = false;
    const program = Deferred.await(done);
    return {
      await: program,
      activate: () => {
        if (activated || settled) return;
        activated = true;
        const watcher = this.fork(Effect.scoped(Effect.gen(function*() {
          const deadline = yield* Effect.forkScoped(Effect.zipRight(
            Effect.sleep(timeoutMs),
            Effect.sync(() => { if (!settled) onDeadline(); }),
          ));
          deadline.addObserver(exit => {
            if (Exit.isFailure(exit) && !settled) {
              settled = true;
              Deferred.unsafeDone(done, Effect.failCause(exit.cause));
            }
          });
          // The consumer owns the terminal failure; this child owns only the deadline lifetime.
          yield* Effect.asVoid(Effect.exit(program));
        })));
        watcher.addObserver(exit => {
          if (Exit.isFailure(exit) && !settled) {
            settled = true;
            Deferred.unsafeDone(done, Effect.failCause(exit.cause));
          }
        });
      },
      complete: exit => {
        if (settled) return;
        settled = true;
        Deferred.unsafeDone(done, exit);
      },
      succeed: value => {
        if (settled) return;
        settled = true;
        Deferred.unsafeDone(done, Effect.succeed(value));
      },
      fail: cause => {
        if (settled) return;
        settled = true;
        Deferred.unsafeDone(done, Effect.fail({ _tag: "WorkerBoundaryFailure", phase: "protocol", cause }));
      },
    };
  }

  alarm(timeoutMs: number, expire: () => void): () => void {
    const completion = this.completion<void>(timeoutMs, () => {
      completion.succeed(undefined);
      expire();
    });
    completion.activate();
    return () => completion.succeed(undefined);
  }

  get activeCount(): number { return this.#active; }

  close(): Promise<void> {
    this.#closed = true;
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    await this.#runtime.runPromise(Scope.close(this.#scope, Exit.void));
    await this.#runtime.dispose();
  }
}
