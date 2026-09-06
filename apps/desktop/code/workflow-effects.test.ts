import { expect, test } from "bun:test";
import { Deferred, Effect } from "effect";
import { WorkflowEffectRuntime, workflowBoundary, workflowResource, workflowScoped } from "./workflow-effects";

test("scoped run setup releases its claim when initialization fails", async () => {
  const owner = new WorkflowEffectRuntime();
  const failure = new Error("summary unavailable");
  let released = 0;
  const program = workflowScoped(Effect.gen(function* () {
    yield* workflowResource(Effect.succeed("claim"), () => workflowBoundary("cleanup", () => { released += 1; }));
    return yield* workflowBoundary("authority", () => { throw failure; });
  }));
  expect(await owner.run(program).catch(error => error)).toBe(failure);
  expect(released).toBe(1);
  await owner.stop();
});

test("scoped run preserves both execution and every cleanup failure", async () => {
  const owner = new WorkflowEffectRuntime();
  const execution = new Error("execution");
  const first = new Error("first cleanup");
  const second = new Error("second cleanup");
  const seen: string[] = [];
  const program = workflowScoped(Effect.gen(function* () {
    yield* workflowResource(Effect.void, () => workflowBoundary("cleanup", () => { seen.push("first"); throw first; }));
    yield* workflowResource(Effect.void, () => workflowBoundary("cleanup", () => { seen.push("second"); throw second; }));
    return yield* workflowBoundary("authority", () => { throw execution; });
  }));
  const error = await owner.run(program).catch(error => error);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors).toEqual([execution, second, first]);
  expect(seen).toEqual(["second", "first"]);
  await owner.stop();
});

test("observer shutdown leaves foreign custody alive through its actual completion", async () => {
  const owner = new WorkflowEffectRuntime();
  const done = owner.deferred<void, never>();
  let finalized = false;
  const pending = owner.custody(Deferred.await(done).pipe(Effect.ensuring(Effect.sync(() => { finalized = true; }))));
  await owner.stop();
  expect(finalized).toBe(false);
  Deferred.unsafeDone(done, Effect.void);
  await pending;
  expect(finalized).toBe(true);
});

test("an admitted node keeps its deadline after the run observer returns", async () => {
  const owner = new WorkflowEffectRuntime();
  const deadline = owner.deferred<void, never>();
  let deadlineObserved = false;
  owner.watch(Effect.zipRight(Effect.sleep(5), Effect.sync(() => {
    deadlineObserved = true;
    Deferred.unsafeDone(deadline, Effect.void);
  })), true);
  const pending = owner.custody(Deferred.await(deadline));
  await owner.stop();
  await pending;
  // The node deadline completed under its retained owner; no runtime work is restarted.
  expect(deadlineObserved).toBe(true);
});
