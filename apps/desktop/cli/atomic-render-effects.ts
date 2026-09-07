import { Cause, Context, Effect, Exit, Fiber, Ref } from "effect";

import {
  operationFinally,
  operationResource,
  operationValidation,
  type OperationEffectFailure,
} from "../application/operation-effects";
import { CliError, errorMessage } from "./errors";
import type { ProcessRunner, RunResult } from "./io";

export interface AtomicRenderOutput {
  readonly bytes: number;
  readonly sha256: string;
}

export interface AtomicRenderRequest {
  readonly abortSignal?: AbortSignal;
  readonly argv: readonly [string, ...string[]];
  readonly failureLabel: string;
  readonly finalOutputPath: string;
  readonly maximumOutputBytes: number;
  readonly requireFreshOutput?: boolean;
  readonly runner: ProcessRunner;
  readonly stagingDirectory?: string;
  readonly timeoutMs?: number;
}

export interface AtomicRenderStaging {
  readonly argv: readonly [string, ...string[]];
  readonly path: string;
}

export interface AtomicRenderProcess {
  /** Repeated observation joins one retained native Promise; it never dispatches again. */
  readonly result: Effect.Effect<RunResult, OperationEffectFailure>;
  abort(reason?: unknown): Effect.Effect<void, OperationEffectFailure>;
  detach(): Effect.Effect<void, OperationEffectFailure>;
}

export interface AtomicRenderPlatformService {
  stage(request: AtomicRenderRequest, companionPath?: string): Effect.Effect<AtomicRenderStaging, OperationEffectFailure>;
  start(staging: AtomicRenderStaging, request: AtomicRenderRequest): Effect.Effect<AtomicRenderProcess, OperationEffectFailure>;
  outputSize(staging: AtomicRenderStaging): Effect.Effect<number | null, OperationEffectFailure>;
  verify(staging: AtomicRenderStaging, request: AtomicRenderRequest): Effect.Effect<AtomicRenderOutput, OperationEffectFailure>;
  publish(staging: AtomicRenderStaging, request: AtomicRenderRequest): Effect.Effect<void, OperationEffectFailure>;
  invalidateCompanion(path: string): Effect.Effect<void, OperationEffectFailure>;
  cleanup(staging: AtomicRenderStaging): Effect.Effect<void, OperationEffectFailure>;
}

export class AtomicRenderPlatform extends Context.Tag("@atet/local/AtomicRenderPlatform")<
  AtomicRenderPlatform, AtomicRenderPlatformService
>() { }

export interface AtomicRenderPublication<Prepared, R> {
  prepare(output: AtomicRenderOutput): Effect.Effect<Prepared, OperationEffectFailure, R>;
  readonly companion?: {
    readonly finalPath: string;
    publish(prepared: Prepared, output: AtomicRenderOutput): Effect.Effect<void, OperationEffectFailure, R>;
  };
}

const OUTPUT_GROWTH_POLL_MILLISECONDS = 10;

function monitorOutput(
  platform: AtomicRenderPlatformService,
  staging: AtomicRenderStaging,
  request: AtomicRenderRequest,
  process: AtomicRenderProcess,
  outcome: Ref.Ref<Exit.Exit<void, OperationEffectFailure>>,
): Effect.Effect<void> {
  const poll = Effect.uninterruptible(Effect.gen(function*() {
    const size = yield* Effect.exit(platform.outputSize(staging));
    let failure: OperationEffectFailure;
    let abortReason: unknown;
    if (Exit.isFailure(size)) {
      const nativeFailure = Cause.failureOption(size.cause);
      const cause = nativeFailure._tag === "Some" ? nativeFailure.value.cause : Cause.squash(size.cause);
      failure = {
        _tag: "OperationBoundaryFailure",
        phase: "media",
        cause: new CliError("unavailable", `Renderer output could not be monitored safely: ${errorMessage(cause)}`),
        priorCause: size.cause,
      };
      abortReason = cause;
    } else if (size.value !== null && size.value > request.maximumOutputBytes) {
      failure = {
        _tag: "OperationBoundaryFailure",
        phase: "media",
        cause: new CliError(
          "invalid-data",
          `Renderer output exceeded its configured ${String(request.maximumOutputBytes)}-byte limit while encoding (${String(size.value)} bytes observed).`,
        ),
      };
      abortReason = new CliError("invalid-data", "Renderer output exceeded its configured byte limit while encoding.");
    } else {
      return false;
    }
    const stopped = yield* Effect.exit(operationFinally(Effect.fail(failure), process.abort(abortReason)));
    yield* Ref.set(outcome, stopped);
    return true;
  }));
  return Effect.catchAllCause(Effect.gen(function*() {
    while (!(yield* poll)) yield* Effect.sleep(OUTPUT_GROWTH_POLL_MILLISECONDS);
  }), cause => Cause.isInterruptedOnly(cause) ? Effect.void : Effect.gen(function*() {
    const failure: OperationEffectFailure = {
      _tag: "OperationBoundaryFailure", phase: "media", cause: Cause.squash(cause),
    };
    const stopped = yield* Effect.exit(operationFinally(Effect.fail(failure), process.abort(failure.cause)));
    yield* Ref.set(outcome, stopped);
  }));
}

function runMonitored(
  platform: AtomicRenderPlatformService,
  staging: AtomicRenderStaging,
  request: AtomicRenderRequest,
): Effect.Effect<RunResult, OperationEffectFailure> {
  return operationResource(
    Effect.gen(function*() {
      const settled = yield* Ref.make(false);
      const process = yield* platform.start(staging, request);
      return { process, settled };
    }),
    ({ process, settled }) => Effect.scoped(Effect.uninterruptibleMask(restore => Effect.gen(function*() {
      const monitorOutcome = yield* Ref.make<Exit.Exit<void, OperationEffectFailure>>(Exit.void);
      const monitor = yield* Effect.forkScoped(Effect.interruptible(
        monitorOutput(platform, staging, request, process, monitorOutcome),
      ));
      const observed = yield* Effect.exit(restore(process.result));
      let rendered = observed;
      if (Exit.isFailure(observed) && Cause.isInterrupted(observed.cause)) {
        // Even a failed abort cannot skip the original native process join.
        const abort = yield* Effect.exit(process.abort());
        const completion = yield* Effect.exit(process.result);
        yield* Ref.set(settled, true);
        rendered = yield* Effect.exit(operationFinally(
          observed,
          operationFinally(Effect.asVoid(completion), abort),
        ));
      } else {
        yield* Ref.set(settled, true);
      }
      const monitorStopped = yield* Fiber.interrupt(monitor);
      if (Exit.isFailure(monitorStopped) && !Cause.isInterruptedOnly(monitorStopped.cause)) {
        yield* Ref.set(monitorOutcome, Exit.fail({
          _tag: "OperationBoundaryFailure",
          phase: "media",
          cause: Cause.squash(monitorStopped.cause),
        }));
      }
      const monitored = yield* Ref.get(monitorOutcome);
      return yield* operationFinally(rendered, monitored);
    }))),
    ({ process, settled }) => operationFinally(
      Effect.gen(function*() {
        if (yield* Ref.get(settled)) return;
        // Interruption may arrive after start but before the use body begins.
        const abort = yield* Effect.exit(process.abort());
        const completion = yield* Effect.exit(process.result);
        yield* Ref.set(settled, true);
        yield* operationFinally(Effect.asVoid(completion), abort);
      }),
      process.detach(),
    ),
  );
}

/** Native staged owner; publication carries its prepared value through one masked sequence. */
export function executeAtomicRenderEffect<Prepared, R>(
  request: AtomicRenderRequest,
  publication: AtomicRenderPublication<Prepared, R>,
): Effect.Effect<
  { readonly output: AtomicRenderOutput; readonly prepared: Prepared },
  OperationEffectFailure,
  R | AtomicRenderPlatform
> {
  return Effect.gen(function*() {
    const platform = yield* AtomicRenderPlatform;
    return yield* operationResource(
      platform.stage(request, publication.companion?.finalPath),
      staging => Effect.gen(function*() {
        const result = yield* runMonitored(platform, staging, request);
        yield* operationValidation("media", () => {
          if (result.exitCode !== 0) {
            throw new CliError("subprocess", `${request.failureLabel}: ${result.stderr.trim().slice(-4_000) || `exit ${result.exitCode}`}`);
          }
        });
        const output = yield* platform.verify(staging, request);
        // The final workflow fence is inside prepare. Mask before entering it,
        // including the boundary between its successful return and precommit.
        return yield* Effect.uninterruptible(Effect.gen(function*() {
          const prepared = yield* publication.prepare(output);
          const companion = publication.companion;
          if (companion !== undefined) yield* platform.invalidateCompanion(companion.finalPath);
          yield* platform.publish(staging, request);
          if (companion !== undefined) {
            yield* Effect.catchAllCause(companion.publish(prepared, output), cause => operationFinally(
              Effect.failCause(cause), platform.invalidateCompanion(companion.finalPath),
            ));
          }
          return { output, prepared };
        }));
      }),
      staging => platform.cleanup(staging),
    );
  });
}
