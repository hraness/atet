import { describe, expect, test } from "bun:test";

import { SceneBatchSchema } from "./analysis";

const HASH = "a".repeat(64);

function batch(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return {
    batchKey: HASH,
    errorCode: null,
    imageBytes: 1_000,
    imageCount: 2,
    sceneIds: ["scene_aaaaaaaa"],
    state: "complete",
    ...overrides,
  };
}

describe("scene analysis contracts", () => {
  test("accepts internally consistent batch lifecycle states", () => {
    expect(SceneBatchSchema.safeParse(batch()).success).toBe(true);
    expect(SceneBatchSchema.safeParse(batch({
      errorCode: "gateway-unavailable",
      state: "failed",
    })).success).toBe(true);
    expect(SceneBatchSchema.safeParse(batch({
      imageBytes: 0,
      imageCount: 0,
      state: "planned",
    })).success).toBe(true);
  });

  test("ties failure codes and materialized images to lifecycle state", () => {
    expect(SceneBatchSchema.safeParse(batch({ errorCode: "gateway-unavailable" })).success).toBe(false);
    expect(SceneBatchSchema.safeParse(batch({ errorCode: null, state: "failed" })).success).toBe(false);
    expect(SceneBatchSchema.safeParse(batch({ errorCode: null, state: "ambiguous" })).success).toBe(false);
    expect(SceneBatchSchema.safeParse(batch({ imageBytes: 0, imageCount: 0, state: "dispatching" })).success)
      .toBe(false);
    expect(SceneBatchSchema.safeParse(batch({ imageBytes: 0, imageCount: 1, state: "planned" })).success)
      .toBe(false);
  });

  test("requires unique scene IDs and bounded machine-readable failure codes", () => {
    expect(SceneBatchSchema.safeParse(batch({
      sceneIds: ["scene_aaaaaaaa", "scene_aaaaaaaa"],
    })).success).toBe(false);
    expect(SceneBatchSchema.safeParse(batch({
      errorCode: "Gateway unavailable!",
      state: "failed",
    })).success).toBe(false);
  });
});
