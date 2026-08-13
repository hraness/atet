import { expect, test } from "bun:test";

import {
  SCENE_PROMPT_SHA256,
  SCENE_PROMPT_VERSION,
  SCENE_UPLOAD_POLICY,
  type SceneProviderRequest,
} from "@hraness/transmute/scene";

import {
  createGatewaySceneProvider,
  createFixedSceneGatewayFetch,
  VERCEL_SCENE_GATEWAY_BASE_URL,
} from "./gateway-scene-provider";
import { ActiveGatewayCredential } from "./gateway-credential";

function deferred<Value>(): Readonly<{
  promise: Promise<Value>;
  resolve(value: Value): void;
}> {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: value => resolvePromise?.(value),
  };
}

function sceneRequest(): SceneProviderRequest {
  return {
    batchKey: "a".repeat(64),
    cloudUpload: {
      acknowledgedAt: "2026-08-13T00:00:00.000Z",
      policy: SCENE_UPLOAD_POLICY,
    },
    model: "google/gemini-3-flash",
    prompt: { sha256: SCENE_PROMPT_SHA256, version: SCENE_PROMPT_VERSION },
    scenes: [{
      frames: [{
        actualAssetTimeUs: 0,
        bytes: Uint8Array.of(0xff, 0xd8, 0xff),
        mediaType: "image/jpeg",
        sampleId: "sample_deadline1",
      }],
      sceneId: "scene_deadline1",
    }],
  };
}

test("scene transport forwards a newly constructed request after one target read", async () => {
  let reads = 0;
  const hostile = {
    get url() {
      reads += 1;
      return reads === 1
        ? `${VERCEL_SCENE_GATEWAY_BASE_URL}/language-model`
        : "https://attacker.invalid/steal";
    },
  } as unknown as Request;
  const forwarded: Request[] = [];
  const gatewayFetch = createFixedSceneGatewayFetch((input) => {
    forwarded.push(input as Request);
    return Promise.resolve(new Response("{}"));
  });

  await gatewayFetch(hostile, { headers: { authorization: "Bearer secret" } });

  expect(reads).toBe(1);
  expect(forwarded).toHaveLength(1);
  expect(forwarded[0]).toBeInstanceOf(Request);
  expect(forwarded[0]?.url).toBe(`${VERCEL_SCENE_GATEWAY_BASE_URL}/language-model`);
  expect(forwarded[0]?.headers.get("authorization")).toBe("Bearer secret");
});

test("scene generation suppresses raw AI SDK warning logging before lazy loading", async () => {
  const warningGlobal = globalThis as typeof globalThis & {
    AI_SDK_LOG_WARNINGS?: false | (() => void);
  };
  const previous = warningGlobal.AI_SDK_LOG_WARNINGS;
  let suppressedAtLoad = false;
  warningGlobal.AI_SDK_LOG_WARNINGS = () => {
    throw new Error("Raw AI SDK warning logging must remain disabled.");
  };
  try {
    const provider = createGatewaySceneProvider({
      credential: new ActiveGatewayCredential(
        "AI_GATEWAY_API_KEY",
        "gateway_test_secret_value",
      ),
      loadAiSdk: () => {
        suppressedAtLoad = warningGlobal.AI_SDK_LOG_WARNINGS === false;
        return Promise.reject(new Error("loader fixture stops before dispatch"));
      },
    });
    await expect(provider.describe(sceneRequest())).rejects.toMatchObject({
      code: "gateway-unavailable",
      outcome: "definitive",
    });
    expect(suppressedAtLoad).toBe(true);
  } finally {
    if (previous === undefined) delete warningGlobal.AI_SDK_LOG_WARNINGS;
    else warningGlobal.AI_SDK_LOG_WARNINGS = previous;
  }
});

test("scene generation has a hard deadline and never retries an ambiguous dispatch", async () => {
  let observed: Readonly<Record<string, unknown>> | undefined;
  const provider = createGatewaySceneProvider({
    credential: new ActiveGatewayCredential(
      "AI_GATEWAY_API_KEY",
      "gateway_test_secret_value",
    ),
    loadAiSdk: () => Promise.resolve({
      Output: { object: () => ({}) },
      createGateway: () => ({ languageModel: (model: string) => model }),
      generateText: (options) => {
        observed = options;
        return new Promise(() => undefined);
      },
    }),
    timeoutMs: 10,
  });
  const request = sceneRequest();

  await expect(provider.describe(request)).rejects.toMatchObject({
    code: "gateway-outcome-unknown",
    outcome: "ambiguous",
  });
  expect(observed?.maxRetries).toBe(0);
  expect((observed?.abortSignal as AbortSignal | undefined)?.aborted).toBe(true);
});

test("scene deadline hard-settles a never-resolving SDK loader before paid dispatch", async () => {
  const loader = deferred<{
    Output: { object: () => object };
    createGateway: () => { languageModel(model: string): string };
    generateText: () => Promise<never>;
  }>();
  let createGatewayCalls = 0;
  let generateTextCalls = 0;
  const provider = createGatewaySceneProvider({
    credential: new ActiveGatewayCredential(
      "AI_GATEWAY_API_KEY",
      "gateway_test_secret_value",
    ),
    loadAiSdk: () => loader.promise,
    timeoutMs: 10,
  });
  const startedAt = performance.now();

  await expect(provider.describe(sceneRequest())).rejects.toMatchObject({
    code: "gateway-unavailable",
    outcome: "definitive",
  });
  expect(performance.now() - startedAt).toBeLessThan(1_000);
  loader.resolve({
    Output: { object: () => ({}) },
    createGateway: () => {
      createGatewayCalls += 1;
      return { languageModel: model => model };
    },
    generateText: () => {
      generateTextCalls += 1;
      return new Promise(() => undefined);
    },
  });
  await Promise.resolve();
  expect(createGatewayCalls).toBe(0);
  expect(generateTextCalls).toBe(0);
});

test("caller cancellation while the AI SDK loader is pending prevents paid scene dispatch", async () => {
  const loader = deferred<{
    Output: { object: () => object };
    createGateway: () => { languageModel(model: string): string };
    generateText: () => Promise<never>;
  }>();
  const loaderStarted = deferred<void>();
  let createGatewayCalls = 0;
  let generateTextCalls = 0;
  const provider = createGatewaySceneProvider({
    credential: new ActiveGatewayCredential(
      "AI_GATEWAY_API_KEY",
      "gateway_test_secret_value",
    ),
    loadAiSdk: async () => {
      loaderStarted.resolve(undefined);
      return await loader.promise;
    },
  });
  const controller = new AbortController();
  const pending = provider.describe(sceneRequest(), controller.signal);
  await loaderStarted.promise;
  controller.abort(new Error("cancelled while loading the AI SDK"));
  loader.resolve({
    Output: { object: () => ({}) },
    createGateway: () => {
      createGatewayCalls += 1;
      return { languageModel: (model: string) => model };
    },
    generateText: () => {
      generateTextCalls += 1;
      return new Promise(() => undefined);
    },
  });

  await expect(pending).rejects.toMatchObject({
    code: "aborted",
    outcome: "definitive",
  });
  expect(createGatewayCalls).toBe(0);
  expect(generateTextCalls).toBe(0);
});

test("an already-aborted caller never loads or dispatches the scene provider", async () => {
  let loaderCalls = 0;
  let createGatewayCalls = 0;
  let generateTextCalls = 0;
  const provider = createGatewaySceneProvider({
    credential: new ActiveGatewayCredential(
      "AI_GATEWAY_API_KEY",
      "gateway_test_secret_value",
    ),
    loadAiSdk: async () => {
      loaderCalls += 1;
      return {
        Output: { object: () => ({}) },
        createGateway: () => {
          createGatewayCalls += 1;
          return { languageModel: (model: string) => model };
        },
        generateText: async () => {
          generateTextCalls += 1;
          return {};
        },
      };
    },
  });
  const controller = new AbortController();
  controller.abort();

  await expect(provider.describe(sceneRequest(), controller.signal))
    .rejects.toMatchObject({ code: "aborted", outcome: "definitive" });
  expect(loaderCalls).toBe(0);
  expect(createGatewayCalls).toBe(0);
  expect(generateTextCalls).toBe(0);
});
