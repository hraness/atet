import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFileGatewayMediaCatalogSnapshotStore,
  createGatewayMediaCatalogCache,
  createHttpGatewayMediaCatalogTransport,
  GATEWAY_MEDIA_CATALOG_URL,
  inspectGatewayMediaModel,
  listGatewayMediaModels,
  parseGatewayMediaCatalog,
  parseGatewayMediaCatalogSnapshot,
  type GatewayCatalogRefresh,
  type GatewayCatalogValidators,
} from "./gateway-media-catalog";

const FETCHED_AT = "2026-07-23T12:00:00.000Z";

function deferred<Value>(): Readonly<{
  promise: Promise<Value>;
  reject(reason?: unknown): void;
  resolve(value: Value | PromiseLike<Value>): void;
}> {
  let rejectPromise: (reason?: unknown) => void = () => undefined;
  let resolvePromise: (value: Value | PromiseLike<Value>) => void = () => undefined;
  const promise = new Promise<Value>((resolve, reject) => {
    rejectPromise = reject;
    resolvePromise = resolve;
  });
  return {
    promise,
    reject: rejectPromise,
    resolve: resolvePromise,
  };
}

function row(
  type: "image" | "language" | "speech" | "transcription" | "video",
  id: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const outputs = type === "image"
    ? ["image"]
    : type === "video"
      ? ["video"]
      : type === "speech"
        ? ["audio"]
        : ["text"];
  return {
    created: 1,
    description: `${id} description`,
    id,
    modalities: { input: ["text"], output: outputs },
    name: id,
    object: "model",
    owned_by: id.split("/")[0],
    pricing: {},
    released: 2,
    tags: [],
    type,
    ...overrides,
  };
}

function catalogFixture(): Readonly<{ data: readonly unknown[]; object: "list" }> {
  return {
    data: [
      row("image", "bfl/flux", {
        image_capabilities: { supported_operations: ["text-to-image"] },
      }),
      row("language", "google/gemini-image", {
        modalities: { input: ["text", "image"], output: ["text", "image"] },
        supported_parameters: ["max_tokens", "temperature"],
        tags: ["image-generation", "vision"],
      }),
      row("language", "google/gemini-text"),
      row("speech", "openai/tts"),
      row("transcription", "openai/whisper", {
        modalities: { input: ["audio"], output: ["text"] },
      }),
      row("video", "google/veo", {
        video_capabilities: {
          generate_audio: true,
          supported_durations_seconds: [4, 8],
          supported_operations: ["text-to-video", "image-to-video"],
        },
      }),
    ],
    object: "list",
  };
}

describe("Gateway media catalog", () => {
  test("strictly classifies every media lane, including language-model image generation", () => {
    const snapshot = parseGatewayMediaCatalog(catalogFixture(), {
      fetchedAt: FETCHED_AT,
      validators: { etag: "\"catalog-v1\"" },
    });
    expect(snapshot.models.map(model => [
      model.id,
      model.kind,
      model.gatewayType,
      model.executionMode,
    ])).toEqual([
      ["bfl/flux", "image", "image", "image-model"],
      ["google/gemini-image", "image", "language", "language-image"],
      ["openai/tts", "speech", "speech", "speech-model"],
      ["openai/whisper", "transcription", "transcription", "transcription-model"],
      ["google/veo", "video", "video", "video-model"],
    ]);
    expect(listGatewayMediaModels(snapshot, { kind: "image" })).toEqual([
      {
        executionMode: "image-model",
        id: "bfl/flux",
        kind: "image",
        name: "bfl/flux",
        operations: ["text-to-image"],
      },
      {
        executionMode: "language-image",
        id: "google/gemini-image",
        kind: "image",
        name: "google/gemini-image",
        operations: [],
      },
    ]);
    expect(inspectGatewayMediaModel(snapshot, "google/gemini-image"))
      .toMatchObject({
        gatewayType: "language",
        supportedParameters: ["max_tokens", "temperature"],
      });
    expect(parseGatewayMediaCatalogSnapshot(JSON.parse(JSON.stringify(snapshot))))
      .toEqual(snapshot);
  });

  test("advertises batch and streaming transcription only where each transport is supported", () => {
    const snapshot = parseGatewayMediaCatalog({
      data: [
        row("transcription", "openai/whisper"),
        row("transcription", "openai/realtime-whisper", {
          tags: ["websocket-realtime", "websocket-transcription"],
        }),
        row("transcription", "xai/grok-voice", {
          tags: ["websocket-transcription"],
        }),
      ],
    }, { fetchedAt: FETCHED_AT });

    expect(listGatewayMediaModels(snapshot, { kind: "transcription" }).map(model => ({
      id: model.id,
      operations: model.operations,
    }))).toEqual([
      {
        id: "openai/realtime-whisper",
        operations: ["streaming-transcription"],
      },
      {
        id: "openai/whisper",
        operations: ["batch-transcription"],
      },
      {
        id: "xai/grok-voice",
        operations: ["batch-transcription", "streaming-transcription"],
      },
    ]);
  });

  test("rejects duplicate, malformed, and media-empty catalogs", () => {
    expect(() => parseGatewayMediaCatalog({
      data: [row("image", "bfl/flux"), row("video", "bfl/flux")],
    }, { fetchedAt: FETCHED_AT })).toThrow("catalog is invalid");
    expect(() => parseGatewayMediaCatalog({
      data: [row("video", "missing slash")],
    }, { fetchedAt: FETCHED_AT })).toThrow("catalog is invalid");
    expect(() => parseGatewayMediaCatalog({
      data: [row("language", "google/text")],
    }, { fetchedAt: FETCHED_AT })).toThrow("catalog is invalid");
  });

  test("single-flights, revalidates with ETag, and preserves a bounded stale last-good snapshot", async () => {
    let now = Date.parse(FETCHED_AT);
    let calls = 0;
    let mode: "fresh" | "invalid" | "offline" | "unchanged" = "fresh";
    const validators: (GatewayCatalogValidators | undefined)[] = [];
    const cache = createGatewayMediaCatalogCache({
      freshMs: 5 * 60_000,
      now: () => now,
      staleMs: 60 * 60_000,
      transport: {
        refresh: async (value) => {
          calls += 1;
          validators.push(value);
          await Promise.resolve();
          if (mode === "offline") throw new Error("offline");
          if (mode === "invalid") {
            return { payload: { data: [] }, status: "modified" };
          }
          if (mode === "unchanged") {
            return {
              status: "not-modified",
              validatedAt: new Date(now).toISOString(),
            };
          }
          return {
            fetchedAt: FETCHED_AT,
            payload: catalogFixture(),
            status: "modified",
            validators: { etag: "\"catalog-v1\"" },
          };
        },
      },
    });

    const [first, concurrent] = await Promise.all([cache.get(), cache.get()]);
    expect(first.snapshot.snapshotId).toBe(concurrent.snapshot.snapshotId);
    expect(calls).toBe(1);
    now += 6 * 60_000;
    mode = "unchanged";
    expect((await cache.get()).status).toBe("fresh");
    expect(validators.at(-1)).toEqual({ etag: "\"catalog-v1\"" });
    now += 6 * 60_000;
    mode = "invalid";
    const stale = await cache.get();
    expect(stale.status).toBe("stale");
    expect(stale.snapshot.snapshotId).toBe(first.snapshot.snapshotId);
    expect(cache.get({ freshness: "require-fresh" })).rejects
      .toThrow("catalog is invalid");
    now += 61 * 60_000;
    mode = "offline";
    expect(cache.get()).rejects.toThrow("catalog is unavailable");
  });

  test("shares the initial disk load without letting a later caller race the store", async () => {
    const snapshot = parseGatewayMediaCatalog(catalogFixture(), {
      fetchedAt: FETCHED_AT,
    });
    const stored = deferred<unknown>();
    let reads = 0;
    let refreshes = 0;
    const cache = createGatewayMediaCatalogCache({
      now: () => Date.parse(FETCHED_AT),
      snapshotStore: {
        read: () => {
          reads += 1;
          return stored.promise;
        },
        write: () => Promise.resolve(),
      },
      transport: {
        refresh: () => {
          refreshes += 1;
          return Promise.reject(new Error("unexpected refresh"));
        },
      },
    });

    const first = cache.get();
    const second = cache.get();
    expect(reads).toBe(1);
    expect(refreshes).toBe(0);
    stored.resolve(snapshot);

    expect(await first).toMatchObject({ source: "disk", status: "fresh" });
    expect(await second).toMatchObject({ source: "disk", status: "fresh" });
    expect(reads).toBe(1);
    expect(refreshes).toBe(0);
  });

  test("revalidates a future-dated stored snapshot instead of treating it as fresh", async () => {
    const currentTime = Date.parse(FETCHED_AT);
    const futureSnapshot = parseGatewayMediaCatalog(catalogFixture(), {
      fetchedAt: new Date(currentTime + 60 * 60_000).toISOString(),
    });
    let refreshes = 0;
    const cache = createGatewayMediaCatalogCache({
      now: () => currentTime,
      snapshotStore: {
        read: () => Promise.resolve(futureSnapshot),
        write: () => Promise.resolve(),
      },
      transport: {
        refresh: () => {
          refreshes += 1;
          return Promise.resolve({
            fetchedAt: FETCHED_AT,
            payload: catalogFixture(),
            status: "modified",
          });
        },
      },
    });

    expect(await cache.get({ freshness: "require-fresh" }))
      .toMatchObject({ source: "network", status: "fresh" });
    expect(refreshes).toBe(1);
  });

  test("does not return a future-dated snapshot as stale when revalidation fails", () => {
    const currentTime = Date.parse(FETCHED_AT);
    const futureSnapshot = parseGatewayMediaCatalog(catalogFixture(), {
      fetchedAt: new Date(currentTime + 60 * 60_000).toISOString(),
    });
    let refreshes = 0;
    const cache = createGatewayMediaCatalogCache({
      now: () => currentTime,
      snapshotStore: {
        read: () => Promise.resolve(futureSnapshot),
        write: () => Promise.resolve(),
      },
      transport: {
        refresh: () => {
          refreshes += 1;
          return Promise.reject(new Error("catalog is unavailable"));
        },
      },
    });

    expect(cache.get({ freshness: "allow-stale" }))
      .rejects.toThrow("catalog is unavailable");
    expect(refreshes).toBe(1);
  });

  test("shares network work while applying each caller's stale policy independently", async () => {
    const snapshot = parseGatewayMediaCatalog(catalogFixture(), {
      fetchedAt: FETCHED_AT,
    });
    const refresh = deferred<GatewayCatalogRefresh>();
    const started = deferred<void>();
    let refreshes = 0;
    const cache = createGatewayMediaCatalogCache({
      freshMs: 5 * 60_000,
      now: () => Date.parse(FETCHED_AT) + 6 * 60_000,
      snapshotStore: {
        read: () => Promise.resolve(snapshot),
        write: () => Promise.resolve(),
      },
      staleMs: 60 * 60_000,
      transport: {
        refresh: () => {
          refreshes += 1;
          started.resolve();
          return refresh.promise;
        },
      },
    });

    const allowStale = cache.get({ freshness: "allow-stale" });
    const requireFresh = cache.get({ freshness: "require-fresh" });
    await started.promise;
    expect(refreshes).toBe(1);
    refresh.reject(new Error("offline"));

    expect(await allowStale).toMatchObject({ source: "disk", status: "stale" });
    expect(requireFresh).rejects.toThrow("catalog is unavailable");
    expect(refreshes).toBe(1);
  });

  test("aborts one caller without passing its signal into shared network work", async () => {
    const refresh = deferred<GatewayCatalogRefresh>();
    const started = deferred<void>();
    const receivedSignals: (AbortSignal | undefined)[] = [];
    let refreshes = 0;
    const cache = createGatewayMediaCatalogCache({
      now: () => Date.parse(FETCHED_AT),
      transport: {
        refresh: (_validators, signal) => {
          refreshes += 1;
          receivedSignals.push(signal);
          started.resolve();
          return refresh.promise;
        },
      },
    });
    const controller = new AbortController();

    const aborted = cache.get({ signal: controller.signal });
    const surviving = cache.get();
    await started.promise;
    controller.abort(new DOMException("caller stopped", "AbortError"));

    expect(aborted).rejects.toMatchObject({
      message: "caller stopped",
      name: "AbortError",
    });
    expect(refreshes).toBe(1);
    expect(receivedSignals).toEqual([undefined]);

    refresh.resolve({
      fetchedAt: FETCHED_AT,
      payload: catalogFixture(),
      status: "modified",
    });
    expect(await surviving).toMatchObject({ source: "network", status: "fresh" });
    expect(refreshes).toBe(1);
  });

  test("persists and reloads a validated snapshot without trusting a corrupt file", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "transmute-gateway-catalog-"));
    try {
      const store = createFileGatewayMediaCatalogSnapshotStore(
        join(temporary, "private", "catalog.json"),
      );
      const snapshot = parseGatewayMediaCatalog(catalogFixture(), {
        fetchedAt: FETCHED_AT,
      });
      expect(snapshot.kind).toBe("transmute.gateway-media-catalog");
      await store.write(snapshot);
      expect(parseGatewayMediaCatalogSnapshot(await store.read())).toEqual(snapshot);
      const legacy = parseGatewayMediaCatalogSnapshot({
        ...snapshot,
        kind: "studio.gateway-media-catalog",
      });
      expect(legacy.kind).toBe("studio.gateway-media-catalog");
    } finally {
      await rm(temporary, { force: true, recursive: true });
    }
  });

  test("HTTP transport pins the public origin and sends validators only as conditional headers", async () => {
    const calls: Readonly<{ init?: RequestInit; url: string }>[] = [];
    const transport = createHttpGatewayMediaCatalogTransport({
      fetch: (input, init) => {
        const url = input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input;
        calls.push({
          ...(init === undefined ? {} : { init }),
          url,
        });
        return Promise.resolve(new Response(null, {
          headers: { etag: "\"v2\"" },
          status: 304,
        }));
      },
    });
    expect(await transport.refresh({
      etag: "\"v1\"",
      lastModified: "Thu, 23 Jul 2026 12:00:00 GMT",
    }, undefined)).toEqual({
      status: "not-modified",
      validators: { etag: "\"v2\"" },
    });
    expect(calls[0]?.url).toBe(GATEWAY_MEDIA_CATALOG_URL);
    expect(calls[0]?.init).toMatchObject({
      headers: {
        accept: "application/json",
        "if-modified-since": "Thu, 23 Jul 2026 12:00:00 GMT",
        "if-none-match": "\"v1\"",
      },
      method: "GET",
      redirect: "error",
    });
  });
});
