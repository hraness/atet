import { expect, test } from "bun:test";
import { Effect } from "effect";
import { WorkerEffectRuntime } from "./worker-effects";

test("reserves a completion before activation and preserves the native winner", async () => {
  const owner = new WorkerEffectRuntime();
  let expired = 0;
  const completion = owner.completion<number>(1, () => { expired += 1; });
  completion.succeed(7);
  completion.activate();
  completion.fail(new Error("late failure"));
  expect(await owner.run(completion.await)).toBe(7);
  await owner.run(Effect.sleep(5));
  expect(expired).toBe(0);
  await owner.close();
  expect(owner.activeCount).toBe(0);
});

test("a native failure cannot be overwritten by a later response", async () => {
  const owner = new WorkerEffectRuntime();
  const error = new Error("native failure");
  const completion = owner.completion<number>(100, () => completion.fail(new Error("deadline")));
  completion.activate();
  completion.fail(error);
  completion.succeed(7);
  expect(await owner.run(completion.await).catch(cause => cause)).toBe(error);
  await owner.close();
  expect(owner.activeCount).toBe(0);
});

test("closure joins deadline and observer fibers without reporting a response", async () => {
  const owner = new WorkerEffectRuntime();
  const completion = owner.completion<number>(60_000, () => completion.fail(new Error("deadline")));
  completion.activate();
  const observed = owner.run(completion.await).then(() => "success", () => "interrupted");
  await owner.close();
  expect(await observed).toBe("interrupted");
  expect(owner.activeCount).toBe(0);
});

test("a throwing deadline callback fails its consumer and leaves no deadline fibers", async () => {
  const owner = new WorkerEffectRuntime();
  const error = new Error("deadline callback failed");
  const completion = owner.completion<number>(1, () => { throw error; });
  completion.activate();
  expect(await owner.run(completion.await).catch(cause => cause)).toBe(error);
  await owner.close();
  expect(owner.activeCount).toBe(0);
});

test("post-close fork admission does not leak active accounting", async () => {
  const owner = new WorkerEffectRuntime();
  await owner.close();
  expect(() => owner.fork(Effect.void)).toThrow("runtime is already closed");
  expect(await owner.run(Effect.void).then(() => "success", () => "closed")).toBe("closed");
  expect(owner.activeCount).toBe(0);
});
