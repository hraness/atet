import { describe, expect, test } from "bun:test";

import {
  reusableSceneBatchCacheEntry,
  sceneBatchCacheKey,
  transitionSceneBatch,
  type SceneBatchCacheIdentity,
  type SceneBatchStateRecord,
} from "./scene-cache";

const identity: SceneBatchCacheIdentity = {
  inputDigest: "a".repeat(64),
  model: {
    aiSdkVersion: "5.0.0",
    gateway: "vercel-ai-gateway",
    promptSha256: "b".repeat(64),
    promptVersion: "scene-description-v1",
    requestedModel: "google/gemini-2.5-flash",
    samplingVersion: "atet-scene-sampling-v1",
  },
  samples: [
    { actualAssetTimeUs: 20, sampleId: "sample_bbbbbbbb", sha256: "d".repeat(64) },
    { actualAssetTimeUs: 10, sampleId: "sample_aaaaaaaa", sha256: "c".repeat(64) },
  ],
  sceneIds: ["scene_aaaaaaaa"],
};

const planned: SceneBatchStateRecord = {
  batchKey: "e".repeat(64),
  errorCode: null,
  imageBytes: 100,
  imageCount: 2,
  sceneIds: ["scene_aaaaaaaa"],
  state: "planned",
};

describe("scene batch cache", () => {
  test("keys all model, prompt, input, and frame identity and ignores sample input order", () => {
    const key = sceneBatchCacheKey(identity);
    expect(sceneBatchCacheKey({ ...identity, samples: [...identity.samples].reverse() })).toBe(key);
    expect(sceneBatchCacheKey({
      ...identity,
      model: { ...identity.model, promptVersion: "scene-description-v2" },
    })).not.toBe(key);
    expect(sceneBatchCacheKey({
      ...identity,
      model: { ...identity.model, aiSdkVersion: "6.0.0" },
    })).not.toBe(key);
    expect(sceneBatchCacheKey({
      ...identity,
      samples: [{ ...identity.samples[0]!, sha256: "f".repeat(64) }, identity.samples[1]!],
    })).not.toBe(key);
  });

  test("requires dispatch before a batch can complete", () => {
    const dispatching = transitionSceneBatch(planned, { kind: "dispatch" });
    expect(dispatching.state).toBe("dispatching");
    expect(transitionSceneBatch(dispatching, { kind: "complete" }).state).toBe("complete");
    expect(() => transitionSceneBatch(planned, { kind: "complete" })).toThrow("cannot transition");
  });

  test("does not automatically retry definitive or ambiguous failures", () => {
    const dispatching = transitionSceneBatch(planned, { kind: "dispatch" });
    const ambiguous = transitionSceneBatch(dispatching, {
      errorCode: "gateway-outcome-unknown",
      kind: "fail",
      outcome: "ambiguous",
    });
    expect(ambiguous).toMatchObject({ errorCode: "gateway-outcome-unknown", state: "ambiguous" });
    expect(() => transitionSceneBatch(ambiguous, { kind: "dispatch" })).toThrow("cannot transition");
    expect(transitionSceneBatch(ambiguous, {
      acknowledgement: "explicit-user-retry",
      kind: "retry",
    })).toEqual(planned);
  });

  test("reuses only an exact completed-key match", () => {
    const key = sceneBatchCacheKey(identity);
    const entry = {
      batchKey: key,
      payloadSha256: "f".repeat(64),
      schemaVersion: 1 as const,
      state: "complete" as const,
    };
    expect(reusableSceneBatchCacheEntry(key, entry)).toEqual(entry);
    expect(reusableSceneBatchCacheEntry("0".repeat(64), entry)).toBeNull();
    expect(reusableSceneBatchCacheEntry(key, null)).toBeNull();
  });
});
