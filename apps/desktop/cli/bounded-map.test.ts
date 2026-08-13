import { describe, expect, test } from "bun:test";

import { mapBounded } from "./bounded-map";

describe("mapBounded", () => {
  test("preserves input order while enforcing the concurrency ceiling", async () => {
    let active = 0;
    let maximumActive = 0;
    const results = await mapBounded(
      Array.from({ length: 24 }, (_, index) => index),
      4,
      async value => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise(resolve => setTimeout(resolve, (value % 3) + 1));
        active -= 1;
        return value * 2;
      },
    );
    expect(maximumActive).toBe(4);
    expect(results).toEqual(Array.from({ length: 24 }, (_, index) => index * 2));
  });

  test("rejects invalid concurrency before starting work", () => {
    let started = false;
    expect(mapBounded([1], 0, value => {
      started = true;
      return Promise.resolve(value);
    })).rejects.toThrow(/concurrency/u);
    expect(started).toBe(false);
  });
});
