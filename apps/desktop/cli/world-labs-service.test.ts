import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planWorldLabsGeneration, WORLD_LABS_TEXT_CREDITS, WorldLabsProvenanceSchema } from "../application/world-labs-port";
import { createWorldLabsService, WorldLabsError } from "./world-labs-service";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "atet-world-labs-")));
  roots.push(path);
  return path;
}
const input = { attemptId: "sample-one", prompt: "A sunlit conservatory with realistic stone floors.", displayName: "Conservatory", quality: "100k" } as const;
const adapter = { grant: { allowPaidGeneration: true, budgetId: "samples", maximumCredits: 12_500 } } as const;
const pending = (operationId = "operation-one") => ({ operation_id: operationId, done: false });
const complete = (operationId = "operation-one") => ({
  operation_id: operationId, done: true, cost: { total_credits: 1_580 },
  response: {
    world_id: "world-one", model: "marble-1.1", display_name: "Conservatory",
    assets: {
      splats: { spz_urls: { "100k": "https://cdn.worldlabs.ai/world.spz?signature=private-transfer-token", "500k": "https://cdn.worldlabs.ai/world-500k.spz" }, semantics_metadata: { ground_plane_offset: -1.2, metric_scale_factor: 2.5 } },
      mesh: { collider_mesh_url: "https://cdn.worldlabs.ai/collider.glb" },
    },
  },
});
const response = (value: unknown): Response => Response.json(value);
const fakeCredential = "private-world-labs-key";
const key = async () => fakeCredential;
const fakeFetch = (fn: (url: string, init?: RequestInit) => Promise<Response>): typeof globalThis.fetch =>
  fn as unknown as typeof globalThis.fetch;
const download = async () => ({ data: new Uint8Array([1, 2, 3, 4]), mediaType: "application/octet-stream" });

describe("World Labs paid-attempt custody", () => {
  test("planning is pure, pins private marble-1.1 text generation, and budgets panorama cost", () => {
    const plan = planWorldLabsGeneration(input);
    expect(plan.reservedCredits).toBe(1_580);
    expect(plan.request).toEqual({ display_name: "Conservatory", model: "marble-1.1", permission: { public: false }, world_prompt: { type: "text", text_prompt: input.prompt } });
    expect(plan.reproducibility).toBe("retained-assets-only");
    expect(plan.requestSha256).toHaveLength(64);
    expect(() => planWorldLabsGeneration({ ...input, seed: 12 })).toThrow();
  });

  test("journals request and reservation before one fixed-origin authenticated POST", async () => {
    const repositoryRoot = await root();
    let posts = 0;
    const service = createWorldLabsService({ repositoryRoot, loadCredential: key, fetch: fakeFetch(async (url, init) => {
      posts += 1;
      expect(url).toBe("https://api.worldlabs.ai/marble/v1/worlds:generate");
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("WLT-Api-Key")).toBe(fakeCredential);
      expect(JSON.parse(String(init?.body))).toEqual(planWorldLabsGeneration(input).request);
      const dispatch = JSON.parse(await readFile(join(repositoryRoot, "artifacts/atet/generated/worlds/attempts/sample-one/dispatch.json"), "utf8"));
      expect(dispatch.requestSha256).toBe(planWorldLabsGeneration(input).requestSha256);
      const reservation = JSON.parse(await readFile(join(repositoryRoot, "artifacts/atet/generated/worlds/budgets/samples/reservation-0.json"), "utf8"));
      expect(reservation.reservedCredits).toBe(WORLD_LABS_TEXT_CREDITS);
      return response(pending());
    }) });
    expect((await service.generate(input, adapter)).status).toBe("pending");
    await expect(service.generate(input, adapter)).rejects.toMatchObject({ code: "conflict" });
    expect(posts).toBe(1);
  });

  test("ambiguous POST never retries, releases budget, or leaks a provider error", async () => {
    const repositoryRoot = await root();
    let posts = 0;
    const service = createWorldLabsService({ repositoryRoot, loadCredential: key, fetch: fakeFetch(async () => { posts += 1; throw new Error(fakeCredential); }) });
    await expect(service.generate(input, adapter)).rejects.toMatchObject({ code: "provider-unavailable" });
    expect((await service.inspect({ attemptId: input.attemptId })).status).toBe("ambiguous");
    await expect(service.generate(input, adapter)).rejects.toMatchObject({ code: "conflict" });
    await expect(service.resume({ attemptId: input.attemptId }, { allowProviderRead: true })).rejects.toMatchObject({ code: "conflict" });
    expect(posts).toBe(1);
    expect(await readFile(join(repositoryRoot, "artifacts/atet/generated/worlds/budgets/samples/reservation-0.json"), "utf8")).not.toContain(fakeCredential);
  });

  test("concurrent attempts cannot exceed one named cumulative budget", async () => {
    const repositoryRoot = await root();
    let posts = 0;
    const service = createWorldLabsService({ repositoryRoot, loadCredential: key, fetch: fakeFetch(async () => response(pending(`operation-${++posts}`))) });
    const grant = { grant: { ...adapter.grant, maximumCredits: 2 * WORLD_LABS_TEXT_CREDITS } } as const;
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => service.generate({ ...input, attemptId: `sample-${index}` }, grant)));
    expect(posts).toBe(2);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(2);
    expect(results.filter(result => result.status === "rejected").every(result => result.reason instanceof WorldLabsError && result.reason.code === "budget-exhausted")).toBe(true);
    await expect(service.generate({ ...input, attemptId: "raise-budget" }, adapter)).rejects.toMatchObject({ code: "conflict" });
  });

  test("quarantines a higher settled price while retaining paid assets and actual cost", async () => {
    const repositoryRoot = await root();
    let posts = 0;
    const value = complete(); value.cost.total_credits = 1_900;
    const service = createWorldLabsService({ repositoryRoot, loadCredential: key, download,
      fetch: fakeFetch(async () => { posts += 1; return response(value); }),
    });
    const result = await service.generate(input, adapter);
    expect(result).toMatchObject({ status: "retained", reservedCredits: 1_580, settledCredits: 1_900, budgetQuarantined: true });
    await expect(service.generate({ ...input, attemptId: "second-world" }, adapter)).rejects.toMatchObject({ code: "price-mismatch" });
    expect((await service.resume({ attemptId: input.attemptId }, { allowProviderRead: true })).retained).toEqual(result.retained);
    expect(posts).toBe(1);
    const marker = JSON.parse(await readFile(join(repositoryRoot, "artifacts/atet/generated/worlds/budgets/samples/price-mismatch.json"), "utf8"));
    expect(marker).toMatchObject({ kind: "atet.world-labs-price-mismatch", settledCredits: 1_900, operationId: "operation-one" });
  });

  test("persists a higher known charge before failed retention and keeps future dispatch fenced", async () => {
    const repositoryRoot = await root();
    const value = complete(); value.cost.total_credits = 1_000_001;
    const service = createWorldLabsService({ repositoryRoot, loadCredential: key,
      fetch: fakeFetch(async () => response(value)), download: async () => { throw new Error("download failed"); },
    });
    await expect(service.generate(input, adapter)).rejects.toMatchObject({ code: "download-failed" });
    expect(await service.inspect({ attemptId: input.attemptId })).toMatchObject({ status: "pending", settledCredits: 1_000_001, budgetQuarantined: true });
    await expect(service.generate({ ...input, attemptId: "second-world" }, adapter)).rejects.toMatchObject({ code: "price-mismatch" });
  });

  test("retains already-known settled costs when a later completion snapshot omits them", async () => {
    const repositoryRoot = await root();
    let calls = 0, downloads = 0;
    const value = complete(); value.cost.total_credits = 1_900;
    const service = createWorldLabsService({ repositoryRoot, loadCredential: key,
      fetch: fakeFetch(async () => response(++calls === 1 ? value : { ...value, cost: null })),
      download: async () => { if (++downloads === 1) throw new Error("interrupted transfer"); return await download(); },
    });
    await expect(service.generate(input, adapter)).rejects.toMatchObject({ code: "download-failed" });
    const retained = await service.resume({ attemptId: input.attemptId }, { allowProviderRead: true });
    expect(retained).toMatchObject({ status: "retained", settledCredits: 1_900, budgetQuarantined: true });
    const provenance = WorldLabsProvenanceSchema.parse(JSON.parse(await readFile(join(repositoryRoot, retained.retained!.provenance.path), "utf8")));
    expect(provenance.settledCredits).toBe(1_900);
    const completion = JSON.parse(await readFile(join(repositoryRoot, "artifacts/atet/generated/worlds/attempts/sample-one/completion.json"), "utf8"));
    expect(completion.settledCredits).toBe(1_900);
    expect(calls).toBe(2);
  });

  test("rechecks quarantine after reservation and immediately before POST", async () => {
    const repositoryRoot = await root();
    let firstCalls = 0, secondCalls = 0, observed = false;
    const first = createWorldLabsService({ repositoryRoot, loadCredential: key, download,
      fetch: fakeFetch(async () => {
        if (++firstCalls === 1) return response(pending());
        const value = complete(); value.cost.total_credits = 1_900; return response(value);
      }),
    });
    await first.generate(input, adapter);
    const second = createWorldLabsService({ repositoryRoot, loadCredential: key, download,
      assertOwned: async () => {
        if (observed) return;
        try { await readFile(join(repositoryRoot, "artifacts/atet/generated/worlds/attempts/second-world/dispatch.json")); }
        catch { return; }
        observed = true;
        await first.resume({ attemptId: input.attemptId }, { allowProviderRead: true });
      },
      fetch: fakeFetch(async () => { secondCalls += 1; return response(pending("second-operation")); }),
    });
    await expect(second.generate({ ...input, attemptId: "second-world" }, adapter)).rejects.toMatchObject({ code: "price-mismatch" });
    expect({ firstCalls, secondCalls }).toEqual({ firstCalls: 2, secondCalls: 0 });
  });

  test("grant, credentials, and aborted dispatch fail before any paid call", async () => {
    const repositoryRoot = await root();
    let calls = 0;
    const service = createWorldLabsService({ repositoryRoot, loadCredential: async () => "", fetch: fakeFetch(async () => { calls += 1; return response(pending()); }) });
    await expect(service.generate(input, adapter)).rejects.toMatchObject({ code: "credential-unavailable" });
    await expect(service.generate(input, { grant: { ...adapter.grant, allowPaidGeneration: false as unknown as true } })).rejects.toMatchObject({ code: "permission-required" });
    await expect(service.generate(input, { ...adapter, signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "provider-unavailable" });
    expect(calls).toBe(0);
    await expect(service.inspect({ attemptId: input.attemptId })).rejects.toMatchObject({ code: "attempt-unavailable" });
  });

  test("rechecks custody after durable dispatch intent and before network mutation", async () => {
    const repositoryRoot = await root();
    let calls = 0;
    const service = createWorldLabsService({ repositoryRoot, loadCredential: key,
      assertOwned: async () => {
        try { await readFile(join(repositoryRoot, "artifacts/atet/generated/worlds/attempts/sample-one/dispatch.json")); }
        catch { return; }
        throw new Error("lease lost");
      },
      fetch: fakeFetch(async () => { calls += 1; return response(pending()); }),
    });
    await expect(service.generate(input, adapter)).rejects.toMatchObject({ code: "provider-unavailable" });
    expect(calls).toBe(0);
    expect((await service.inspect({ attemptId: input.attemptId })).status).toBe("ambiguous");
  });

  test("drains returned operation binding and known charges after cancellation under custody", async () => {
    const repositoryRoot = await root();
    const controller = new AbortController();
    let custodyAfterAbort = 0, calls = 0;
    const service = createWorldLabsService({ repositoryRoot, loadCredential: key,
      assertOwned: async () => { if (controller.signal.aborted) custodyAfterAbort += 1; },
      fetch: fakeFetch(async () => {
        calls += 1;
        controller.abort();
        // Model a complete already-buffered response racing caller cancellation.
        const value = complete(); value.cost.total_credits = 1_900;
        return response(value);
      }),
    });
    await expect(service.generate(input, { ...adapter, signal: controller.signal })).rejects.toMatchObject({ code: "provider-unavailable" });
    expect((await service.inspect({ attemptId: input.attemptId }))).toMatchObject({ status: "pending", operationId: "operation-one", reservedCredits: 1_580, settledCredits: 1_900, budgetQuarantined: true });
    expect(calls).toBe(1);
    expect(custodyAfterAbort).toBeGreaterThan(0);
  });
});

describe("World Labs retained-world recovery", () => {
  test("resume polls once, retains hash-bound assets and semantics, and works offline afterward", async () => {
    const repositoryRoot = await root();
    let calls = 0, downloads = 0, credentials = 0;
    const service = createWorldLabsService({ repositoryRoot, loadCredential: async () => { credentials += 1; return fakeCredential; }, fetch: fakeFetch(async (_url, init) => {
      calls += 1;
      return response(init?.method === "POST" ? pending() : complete());
    }), download: async details => { downloads += 1; expect(details.maximumBytes).toBe(128 * 1024 * 1024); return await download(); } });
    await service.generate(input, adapter);
    const result = await service.resume({ attemptId: input.attemptId }, { allowProviderRead: true });
    expect(result.status).toBe("retained");
    expect(result.settledCredits).toBe(1_580);
    expect(result.retained?.world.semanticsMetadata).toEqual({ groundPlaneOffset: -1.2, metricScaleFactor: 2.5 });
    const provenance = await readFile(join(repositoryRoot, result.retained!.provenance.path), "utf8");
    expect(provenance).not.toContain(fakeCredential);
    expect(provenance).not.toContain("private-transfer-token");
    expect(provenance).not.toContain("https://cdn");
    expect(provenance).toContain(input.prompt);
    const parsedProvenance = WorldLabsProvenanceSchema.parse(JSON.parse(provenance));
    expect(parsedProvenance.assets.splat.sha256).toBe(result.retained!.splat.sha256);
    expect(WorldLabsProvenanceSchema.safeParse({ ...parsedProvenance, requestSha256: "a".repeat(64) }).success).toBe(false);
    expect((await service.resume({ attemptId: input.attemptId }, { allowProviderRead: true })).retained).toEqual(result.retained);
    expect((await createWorldLabsService({ repositoryRoot, loadCredential: async () => { throw new Error("offline"); } }).inspect({ attemptId: input.attemptId })).retained).toEqual(result.retained);
    expect({ calls, downloads, credentials }).toEqual({ calls: 2, downloads: 2, credentials: 2 });
    await writeFile(join(repositoryRoot, result.retained!.splat.path), "tampered");
    await expect(service.inspect({ attemptId: input.attemptId })).rejects.toThrow();
  });

  test("read-only download recovery never repeats generation", async () => {
    const repositoryRoot = await root();
    let posts = 0, gets = 0, attempts = 0;
    const service = createWorldLabsService({ repositoryRoot, loadCredential: key, fetch: fakeFetch(async (_url, init) => {
      if (init?.method === "POST") posts += 1; else gets += 1;
      return response(complete());
    }), download: async () => { if (++attempts === 1) throw new Error("expired transfer"); return await download(); } });
    await expect(service.generate(input, adapter)).rejects.toMatchObject({ code: "download-failed" });
    expect((await service.inspect({ attemptId: input.attemptId })).status).toBe("pending");
    expect((await service.resume({ attemptId: input.attemptId }, { allowProviderRead: true })).status).toBe("retained");
    expect({ posts, gets }).toEqual({ posts: 1, gets: 1 });
  });

  test("retains the first downloaded asset even when the collider transfer fails", async () => {
    const repositoryRoot = await root();
    let transfers = 0;
    const service = createWorldLabsService({ repositoryRoot, loadCredential: key,
      fetch: fakeFetch(async () => response(complete())),
      download: async () => { if (++transfers === 2) throw new Error("collider transfer failed"); return await download(); },
    });
    await expect(service.generate(input, adapter)).rejects.toMatchObject({ code: "download-failed" });
    const files = await readdir(join(repositoryRoot, "artifacts/atet/generated/worlds/attempts/sample-one"));
    expect(files.filter(path => path.endsWith(".spz"))).toHaveLength(1);
    expect(files.filter(path => path.startsWith(".download-"))).toHaveLength(0);
  });

  test("hydrates nullable operation world fields and accepts the documented id alias", async () => {
    const repositoryRoot = await root();
    const urls: string[] = [];
    const service = createWorldLabsService({ repositoryRoot, loadCredential: key, download,
      fetch: fakeFetch(async url => {
        urls.push(url);
        if (url.endsWith("worlds:generate")) return response({ ...complete(), response: { id: "world-one", model: null, display_name: null } });
        const { world_id, ...world } = complete().response;
        return response({ world: { ...world, id: world_id } });
      }),
    });
    const result = await service.generate(input, adapter);
    expect(result.retained?.world.worldId).toBe("world-one");
    const provenance = WorldLabsProvenanceSchema.parse(JSON.parse(await readFile(join(repositoryRoot, result.retained!.provenance.path), "utf8")));
    expect(provenance.worldResponseSha256).not.toBe(provenance.responseSha256);
    expect(urls).toEqual(["https://api.worldlabs.ai/marble/v1/worlds:generate", "https://api.worldlabs.ai/marble/v1/worlds/world-one"]);
  });

  test("rejects conflicting world-id aliases without hydration", async () => {
    const repositoryRoot = await root();
    let calls = 0;
    const value = complete();
    const service = createWorldLabsService({ repositoryRoot, loadCredential: key, download,
      fetch: fakeFetch(async () => { calls += 1; return response({ ...value, response: { ...value.response, id: "wrong-world" } }); }),
    });
    await expect(service.generate(input, adapter)).rejects.toMatchObject({ code: "invalid-response" });
    expect(calls).toBe(1);
  });

  test("rejects competing flat and enveloped world identities", async () => {
    const repositoryRoot = await root();
    const value = complete();
    const service = createWorldLabsService({ repositoryRoot, loadCredential: key, download,
      fetch: fakeFetch(async () => response({ ...value, response: { ...value.response, world: { ...value.response, world_id: "another-world" } } })),
    });
    await expect(service.generate(input, adapter)).rejects.toMatchObject({ code: "invalid-response" });
  });

  test("operation recovery requires separate authority and makes only GET requests", async () => {
    const repositoryRoot = await root();
    const methods: string[] = [];
    const service = createWorldLabsService({ repositoryRoot, loadCredential: key, download, fetch: fakeFetch(async (_url, init) => {
      methods.push(init?.method ?? "");
      if (init?.method === "POST") throw new Error("lost response");
      return response(complete());
    }) });
    await expect(service.generate(input, adapter)).rejects.toThrow();
    await expect(service.recover({ attemptId: input.attemptId, operationId: "operation-one" }, { allowOperationRecovery: false as unknown as true })).rejects.toMatchObject({ code: "permission-required" });
    expect((await service.recover({ attemptId: input.attemptId, operationId: "operation-one" }, { allowOperationRecovery: true })).status).toBe("retained");
    expect(methods).toEqual(["POST", "GET"]);
  });

  test("failed operations are terminal and never retried", async () => {
    const repositoryRoot = await root();
    let calls = 0;
    const service = createWorldLabsService({ repositoryRoot, loadCredential: key, fetch: fakeFetch(async () => { calls += 1; return response({ ...pending(), done: true, error: { code: 3, message: fakeCredential } }); }) });
    expect((await service.generate(input, adapter)).status).toBe("failed");
    expect((await service.resume({ attemptId: input.attemptId }, { allowProviderRead: true })).status).toBe("failed");
    expect(calls).toBe(1);
    expect(await readFile(join(repositoryRoot, "artifacts/atet/generated/worlds/attempts/sample-one/completion.json"), "utf8")).not.toContain(fakeCredential);
  });

  test.each([0, 1_580, 1_900])("retains a failed operation's reported %s credits without downloading or retrying, and quarantines overages", async settledCredits => {
    const repositoryRoot = await root();
    let posts = 0, gets = 0, downloads = 0;
    const service = createWorldLabsService({ repositoryRoot, loadCredential: key,
      fetch: fakeFetch(async (_url, init) => {
        if (init?.method === "POST") posts++; else gets++;
        return response({ ...complete(), cost: { total_credits: settledCredits }, error: { code: 3, message: fakeCredential } });
      }),
      download: async () => { downloads++; return await download(); },
    });
    const result = await service.generate(input, adapter);
    expect(result).toMatchObject({ status: "failed", operationId: "operation-one", reservedCredits: 1_580, settledCredits });
    expect(result.budgetQuarantined).toBe(settledCredits > WORLD_LABS_TEXT_CREDITS ? true : undefined);
    expect(result.retained).toBeUndefined();
    expect(await service.resume({ attemptId: input.attemptId }, { allowProviderRead: true })).toEqual(result);
    expect(await service.recover({ attemptId: input.attemptId, operationId: "operation-one" }, { allowOperationRecovery: true })).toEqual(result);
    await expect(service.generate(input, adapter)).rejects.toMatchObject({ code: settledCredits > WORLD_LABS_TEXT_CREDITS ? "price-mismatch" : "conflict" });
    if (settledCredits > WORLD_LABS_TEXT_CREDITS) await expect(service.generate({ ...input, attemptId: "second-world" }, adapter)).rejects.toMatchObject({ code: "price-mismatch" });
    const path = join(repositoryRoot, "artifacts/atet/generated/worlds/attempts/sample-one");
    const completion = await readFile(join(path, "completion.json"), "utf8");
    expect(JSON.parse(completion)).toMatchObject({ status: "failed", operationId: "operation-one", settledCredits });
    expect(completion).not.toContain(fakeCredential);
    expect(JSON.parse(await readFile(join(path, "cost.json"), "utf8"))).toEqual({ operationId: "operation-one", reservedCredits: 1_580, settledCredits });
    expect({ posts, gets, downloads }).toEqual({ posts: 1, gets: 0, downloads: 0 });
  });

  test("cancellation drains failed-operation charges and recovery retains them when the provider later omits cost", async () => {
    const repositoryRoot = await root();
    const controller = new AbortController();
    let posts = 0, gets = 0, downloads = 0, custodyAfterAbort = 0;
    const service = createWorldLabsService({ repositoryRoot, loadCredential: key,
      assertOwned: async () => { if (controller.signal.aborted) custodyAfterAbort++; },
      fetch: fakeFetch(async (_url, init) => {
        if (init?.method === "POST") { posts++; controller.abort(); } else gets++;
        return response({ ...pending(), done: true, error: { code: 3, message: fakeCredential }, cost: init?.method === "POST" ? { total_credits: 1_900 } : null });
      }),
      download: async () => { downloads++; return await download(); },
    });
    await expect(service.generate(input, { ...adapter, signal: controller.signal })).rejects.toMatchObject({ code: "provider-unavailable" });
    expect(await service.inspect({ attemptId: input.attemptId })).toMatchObject({ status: "pending", operationId: "operation-one", settledCredits: 1_900, budgetQuarantined: true });
    expect(custodyAfterAbort).toBeGreaterThan(0);
    const result = await service.resume({ attemptId: input.attemptId }, { allowProviderRead: true });
    expect(result).toMatchObject({ status: "failed", operationId: "operation-one", settledCredits: 1_900, budgetQuarantined: true });
    expect(JSON.parse(await readFile(join(repositoryRoot, "artifacts/atet/generated/worlds/attempts/sample-one/completion.json"), "utf8"))).toMatchObject({ settledCredits: 1_900 });
    expect(await service.resume({ attemptId: input.attemptId }, { allowProviderRead: true })).toEqual(result);
    await expect(service.generate({ ...input, attemptId: "second-world" }, adapter)).rejects.toMatchObject({ code: "price-mismatch" });
    expect({ posts, gets, downloads }).toEqual({ posts: 1, gets: 1, downloads: 0 });
  });

  test.each(["https://user:secret@cdn.worldlabs.ai/world.spz", "https://cdn.worldlabs.ai/world.spz#secret", "http://cdn.worldlabs.ai/world.spz", "https://cdn.worldlabs.ai:444/world.spz"])("rejects unsafe provider-returned asset URL %s", async url => {
    const repositoryRoot = await root();
    let downloads = 0;
    const value = complete(); value.response.assets.splats.spz_urls["100k"] = url;
    const service = createWorldLabsService({ repositoryRoot, loadCredential: key, fetch: fakeFetch(async () => response(value)), download: async () => { downloads += 1; return await download(); } });
    await expect(service.generate(input, adapter)).rejects.toMatchObject({ code: "invalid-response" });
    expect(downloads).toBe(0);
  });

  test("rejects private download targets with the production pinned-DNS transport", async () => {
    const repositoryRoot = await root();
    const value = complete(); value.response.assets.splats.spz_urls["100k"] = "https://127.0.0.1/world.spz";
    const service = createWorldLabsService({ repositoryRoot, loadCredential: key, fetch: fakeFetch(async () => response(value)) });
    await expect(service.generate(input, adapter)).rejects.toMatchObject({ code: "download-failed" });
  });

  test("rejects model substitution, missing quality, mismatched operation and oversized responses", async () => {
    for (const variant of ["model", "quality", "operation", "bytes"]) {
      const repositoryRoot = await root();
      let calls = 0;
      const service = createWorldLabsService({ repositoryRoot, loadCredential: key, download, fetch: fakeFetch(async () => {
        if (++calls === 1) return response(pending());
        if (variant === "bytes") return new Response("x".repeat(256 * 1024 + 1));
        const value = complete(variant === "operation" ? "wrong-operation" : undefined);
        if (variant === "model") value.response.model = "marble-1.1-plus";
        if (variant === "quality") delete (value.response.assets.splats.spz_urls as Record<string, string>)["100k"];
        return response(value);
      }) });
      await service.generate(input, adapter);
      await expect(service.resume({ attemptId: input.attemptId }, { allowProviderRead: true })).rejects.toThrow(WorldLabsError);
      expect(calls).toBe(2);
    }
  });

  test("symlinked artifact parents fail before dispatch and preserve unrelated files", async () => {
    const repositoryRoot = await root();
    const unrelated = await root();
    await symlink(unrelated, join(repositoryRoot, "artifacts"));
    let calls = 0;
    const service = createWorldLabsService({ repositoryRoot, loadCredential: key, fetch: fakeFetch(async () => { calls += 1; return response(pending()); }) });
    await expect(service.generate(input, adapter)).rejects.toMatchObject({ code: "unsafe-artifact" });
    expect(calls).toBe(0);
    expect(await readdir(unrelated)).toHaveLength(0);
  });
});
