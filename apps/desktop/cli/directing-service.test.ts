import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { operationApplicationContext } from "../application/operations/test-support";
import type { ApplicationContext } from "../application/context";
import type { GatewayPortRequest, GatewayVideoOperationResult } from "../application/gateway-port";
import { canonicalJsonSha256 } from "../core/canonical-json";
import { parseCliArgs, type DirectingCommand } from "./args";
import { parseGatewayMediaCatalog, type GatewayMediaCatalogView } from "./gateway-media-catalog";
import { executeDirectingCommand, type DirectingServiceAdapters } from "./directing-service";
import { parseDirectingUsd, quoteDirectingShot } from "./directing-quote";
import { parseDirectingRecipe } from "../application/directing-plan";
import { CliError } from "./errors";
import type { DirectingBlobReceipt } from "./directing-blob";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const now = new Date("2026-09-09T12:00:00.000Z");
const hash = canonicalJsonSha256;
const shot = { id: "opening", prompt: "A brass mechanism in warm window light.", model: "minimax/minimax-h3-max", durationSeconds: 5, resolution: "480p", aspectRatio: "16:9", fps: 24 };
const recipe = () => parseDirectingRecipe({ kind: "atet.directing-recipe", schemaVersion: 1, id: "direct_fixture", title: "Fixture", shots: [shot] });
function catalog(): GatewayMediaCatalogView {
  return { source: "network", status: "fresh", snapshot: parseGatewayMediaCatalog({ data: [{
    id: shot.model, name: "H3 Max", description: "Fixture", owned_by: "minimax", type: "video", modalities: { input: ["text", "image"], output: ["video"] },
    video_capabilities: { supported_operations: ["text-to-video", "image-to-video", "first-last-frame"], supported_resolutions: ["480p", "768p"], supported_aspect_ratios: ["16:9"], supported_durations_seconds: [5], supported_fps: [24] },
    pricing: { video_duration_pricing: [{ resolution: "480p", cost_per_second: "0.025" }, { resolution: "768p", cost_per_second: "0.04" }] },
  }] }, { fetchedAt: now.toISOString() }) };
}
async function harness() {
  const root = await mkdtemp(join(tmpdir(), "atet-directing-test-")); roots.push(root);
  const source = recipe(); await writeFile(join(root, "recipe.json"), JSON.stringify(source));
  const calls = { paid: 0, endpoint: 0, assembled: 0, mode: "complete" as "complete" | "before" | "after" | "lost-completion", corruptEndpoint: false, failEndpoint: false, urlOnly: false, cleanup: 0, cleanupFails: false };
  const journal = new Map<string, { request: GatewayPortRequest; result?: GatewayVideoOperationResult }>();
  const application: ApplicationContext = { ...operationApplicationContext(root, { now }), gatewayPort: {
    prepare: async input => input.request,
    dispatch: async input => {
      await input.beforeDispatch?.();
      if (calls.mode === "before") throw new Error("invalid provider request");
      journal.set(input.requestId, { request: input.request }); calls.paid++;
      if (calls.mode === "after") throw new Error("connection interrupted");
      const result: GatewayVideoOperationResult = { operation: "video", model: input.request.request.model, requestId: input.requestId,
        outputs: [{ path: `artifacts/atet/generated/${input.requestId}.mp4`, bytes: 100, sha256: hash(input.requestId), mediaType: "video/mp4" }],
        receipt: { path: `artifacts/atet/generated/${input.requestId}.json`, bytes: 50, sha256: hash({ id: input.requestId }) } };
      await input.beforePublication(); journal.set(input.requestId, { request: input.request, result });
      if (calls.mode === "lost-completion") throw new Error("local completion lost");
      return result;
    },
    reconcile: async input => {
      const stored = journal.get(input.requestId);
      const base = { operation: input.request.operation, requestId: input.requestId };
      if (stored?.result !== undefined) return { ...base, status: "completed", result: stored.result };
      return { ...base, status: stored === undefined ? "not-dispatched" : "dispatched" };
    },
  } };
  const adapters: DirectingServiceAdapters = { catalog: { get: async () => {
    const value = catalog();
    if (!calls.urlOnly) return value;
    return { ...value, snapshot: { ...value.snapshot, models: value.snapshot.models.map(model => ({ ...model, capabilities: { ...model.capabilities, input_limits: { image: { supported_sources: ["url"] } } } })) } };
  } }, media: {
    anchor: async () => { throw new Error("unused anchor"); },
    endpoint: async (_app, video) => { calls.endpoint++; if (calls.failEndpoint) throw new Error("unsupported color metadata"); return {
      source: { ...video, facts: { durationSeconds: 5, width: 848, height: 480 } },
      image: { path: "artifacts/atet/generated/last.png", sha256: hash(calls.corruptEndpoint ? "other" : video.sha256), bytes: 50, mediaType: "image/png" },
      frameIndex: 119, pts: { value: "119", timeBaseNumerator: 1, timeBaseDenominator: 24 }, timeUs: 4_958_333,
    }; },
    assemble: async (_app, input) => {
      calls.assembled++;
      expect(Object.keys(input.clips[0]!).sort()).toEqual(["attemptId", "durationUs", "shotId", "source"]);
      return { projectId: "project_direct_fixture", projectPath: "artifacts/atet/projects/project_direct_fixture/project.json", receipt: { path: "artifacts/atet/generated/assembly.json", bytes: 1, sha256: hash(input) } };
    },
  } };
  const execute = async (...argv: string[]) => {
    const command = parseCliArgs(["direct", ...argv]);
    if (command.kind !== "directing") throw new Error("wrong parser");
    return await executeDirectingCommand(application, command, adapters);
  };
  const generate = (attempt = "take_one") => execute("generate", source.id, "--shot", "opening", "--attempt", attempt, "--allow-paid-generation");
  const state = async () => JSON.parse(await readFile(join(application.paths.privateRoot, "directing", source.id, "state.json"), "utf8")) as { attempts: { state: string }[]; budgetMicroUsd: number };
  return { root, source, calls, execute, generate, state, application, adapters, journal };
}

test("decimal budgets and exact catalog duration quotes use integer microdollars", () => {
  expect(parseDirectingUsd("0.125")).toBe(125_000);
  for (const value of ["-1", "NaN", "Infinity", "0", "0.0000001", "1e2"]) expect(() => parseDirectingUsd(value)).toThrow();
  expect(quoteDirectingShot(catalog(), shot, now).costMicroUsd).toBe(125_000);
  expect(() => quoteDirectingShot(catalog(), { ...shot, durationSeconds: 6 }, now)).toThrow("supported_durations");
  expect(() => quoteDirectingShot(catalog(), shot, new Date(now.getTime() + 301_000))).toThrow("fresh");
  const ambiguous = catalog();
  const model = ambiguous.snapshot.models[0]!;
  expect(() => quoteDirectingShot({ ...ambiguous, snapshot: { ...ambiguous.snapshot, models: [{ ...model, pricing: { video_duration_pricing: [{ cost_per_second: "0.1", audio: true }] } }] } }, shot, now)).toThrow("pricing conditions");
});

test("a film retains budget, reuses completed takes, explicitly reviews and assembles", async () => {
  const h = await harness();
  await h.execute("plan", "recipe.json"); expect(h.calls.paid).toBe(0);
  await h.execute("start", "recipe.json", "--budget-usd", "0.25");
  await h.generate(); await h.generate(); expect(h.calls.paid).toBe(1);
  await expect(h.execute("assemble", h.source.id)).rejects.toThrow("accepted");
  await h.execute("review", h.source.id, "--attempt", "take_one", "--decision", "accepted", "--note", "Viewed all frames");
  await h.execute("assemble", h.source.id); expect(h.calls.assembled).toBe(1);
  await expect(h.execute("start", "recipe.json", "--budget-usd", "5")).rejects.toThrow("already has a retained budget");
  await h.generate("take_two");
  await expect(h.generate("take_three")).rejects.toThrow("remaining directing budget"); expect(h.calls.paid).toBe(2);
});

test("post-dispatch failure holds budget and duplicate/resume never dispatch again", async () => {
  const h = await harness(); await h.execute("start", "recipe.json", "--budget-usd", "0.125"); h.calls.mode = "after";
  await expect(h.generate()).rejects.toThrow("may have been charged");
  expect((await h.state()).attempts[0]!.state).toBe("ambiguous");
  await expect(h.generate()).rejects.toThrow("may have been charged");
  await expect(h.execute("resume", h.source.id, "--attempt", "take_one")).rejects.toThrow("may have been charged");
  await expect(h.generate("take_two")).rejects.toThrow("remaining directing budget"); expect(h.calls.paid).toBe(1);
});

test("only proven pre-dispatch failure releases reservation and reuse remains read-only", async () => {
  const h = await harness(); await h.execute("start", "recipe.json", "--budget-usd", "0.125"); h.calls.mode = "before";
  await expect(h.generate()).rejects.toThrow("before dispatch"); expect((await h.state()).attempts[0]!.state).toBe("not-dispatched");
  h.calls.mode = "complete"; await h.generate(); expect(h.calls.paid).toBe(0);
  await h.generate("take_two"); expect(h.calls.paid).toBe(1);
});

test.each(["ambiguous", "reserved"])("a missing Gateway journal cannot release a %s reservation after restart", async retainedState => {
  const h = await harness(); await h.execute("start", "recipe.json", "--budget-usd", "0.125"); h.calls.mode = "after";
  await expect(h.generate()).rejects.toThrow("may have been charged");
  h.journal.clear();
  const path = join(h.application.paths.privateRoot, "directing", h.source.id, "state.json");
  const stored = JSON.parse(await readFile(path, "utf8"));
  stored.attempts[0].state = retainedState; delete stored.attempts[0].failure;
  await writeFile(path, JSON.stringify(stored));
  await expect(h.execute("resume", h.source.id, "--attempt", "take_one")).rejects.toThrow("may have been charged");
  await expect(h.generate("take_two")).rejects.toThrow("remaining directing budget");
  expect(h.calls.paid).toBe(1); expect((await h.state()).attempts[0]!.state).toBe("ambiguous");
});

test("a recovered completion does not cost a second call and altered endpoints cannot be accepted", async () => {
  const h = await harness(); await h.execute("start", "recipe.json", "--budget-usd", "1"); h.calls.mode = "lost-completion";
  await h.generate(); expect(h.calls.paid).toBe(1); expect((await h.state()).attempts[0]!.state).toBe("completed");
  h.calls.corruptEndpoint = true;
  await expect(h.execute("review", h.source.id, "--attempt", "take_one", "--decision", "accepted", "--note", "Checked")).rejects.toThrow("endpoint is immutable");
});

test("continuations require fresh upload consent and accepted predecessor", async () => {
  const h = await harness();
  h.source.shots.push({ ...shot, id: "next", firstFrame: { kind: "shot-end", shotId: "opening" } });
  await writeFile(join(h.root, "recipe.json"), JSON.stringify(h.source));
  await h.execute("start", "recipe.json", "--budget-usd", "1");
  await h.generate();
  await expect(h.execute("generate", h.source.id, "--shot", "next", "--attempt", "take_next", "--allow-paid-generation")).rejects.toThrow("accepted predecessor");
  await h.execute("review", h.source.id, "--attempt", "take_one", "--decision", "accepted", "--note", "Viewed");
  await expect(h.execute("generate", h.source.id, "--shot", "next", "--attempt", "take_next", "--allow-paid-generation")).rejects.toThrow("allow-cloud-upload");
  await h.execute("generate", h.source.id, "--shot", "next", "--attempt", "take_next", "--allow-paid-generation", "--allow-cloud-upload"); expect(h.calls.paid).toBe(2);
});

test("strict parser requires paid and review acknowledgements and exact bounded ids", async () => {
  expect(() => parseCliArgs(["direct", "generate", "direct_fixture", "--shot", "opening", "--attempt", "take_one"])).toThrow("allow-paid-generation");
  expect(() => parseCliArgs(["direct", "review", "direct_fixture", "--attempt", "take_one", "--decision", "accepted"])).toThrow("--note");
  const h = await harness();
  await expect(h.execute("inspect", "../escape")).rejects.toThrow("exact direct_");
  const command: DirectingCommand = { kind: "directing", action: "inspect", id: "direct_fixture", json: true };
  await mkdir(join(h.application.paths.privateRoot, "directing", "direct_fixture"), { recursive: true });
  await writeFile(join(h.application.paths.privateRoot, "directing", "direct_fixture", "state.json"), "{}");
  await expect(executeDirectingCommand(h.application, command, h.adapters)).rejects.toThrow();
});


test("a paid completed take can be rejected even when endpoint extraction is unsupported", async () => {
  const h = await harness(); await h.execute("start", "recipe.json", "--budget-usd", "1"); h.calls.failEndpoint = true;
  await expect(h.generate()).rejects.toThrow("unsupported color metadata");
  expect((await h.state()).attempts[0]!.state).toBe("completed");
  await h.execute("review", h.source.id, "--attempt", "take_one", "--decision", "rejected", "--note", "Unsupported local color metadata");
  expect(h.calls.paid).toBe(1);
  await expect(h.execute("review", h.source.id, "--attempt", "take_one", "--decision", "accepted", "--note", "Attempt acceptance")).rejects.toThrow("unsupported color metadata");
});


test("URL-only preflight requires hosting consent and ambiguous paid jobs keep their references", async () => {
  const h = await harness(); h.calls.urlOnly = true;
  h.source.shots[0]!.firstFrame = { kind: "image", source: { path: "artifacts/atet/generated/input.png", bytes: 50, sha256: hash("input"), mediaType: "image/png" } };
  await writeFile(join(h.root, "recipe.json"), JSON.stringify(h.source));
  await h.execute("start", "recipe.json", "--budget-usd", "1");
  const args = ["generate", h.source.id, "--shot", "opening", "--attempt", "take_hosted", "--allow-paid-generation", "--allow-cloud-upload"];
  await expect(h.execute(...args)).rejects.toThrow("allow-reference-hosting"); expect(h.calls.paid).toBe(0);
  const adapters: DirectingServiceAdapters = { ...h.adapters, createReferenceHosting: async () => ({
    receiptPath: "artifacts/atet/private/hosting.json",
    resolveSourceUrl: async () => "https://fixture.private.blob.vercel-storage.com/frame.png?signature=ephemeral",
    cleanup: async () => { h.calls.cleanup++; throw new Error("fixture cleanup must not run for a live ambiguous job"); },
    inspect: async () => { throw new Error("unused"); },
  }) };
  const command = parseCliArgs(["direct", ...args, "--allow-reference-hosting"]);
  if (command.kind !== "directing") throw new Error("parser");
  h.calls.mode = "after";
  await expect(executeDirectingCommand(h.application, command, adapters)).rejects.toThrow("may have been charged");
  expect(h.calls.paid).toBe(1); expect(h.calls.cleanup).toBe(0);
});

test("a failed hosting factory releases only a proven undispatched model reservation", async () => {
  const h = await harness(); h.calls.urlOnly = true;
  h.source.shots[0]!.firstFrame = { kind: "image", source: { path: "artifacts/atet/generated/input.png", bytes: 50, sha256: hash("input"), mediaType: "image/png" } };
  await writeFile(join(h.root, "recipe.json"), JSON.stringify(h.source));
  await h.execute("start", "recipe.json", "--budget-usd", "1");
  const command = parseCliArgs(["direct", "generate", h.source.id, "--shot", "opening", "--attempt", "take_hosted", "--allow-paid-generation", "--allow-cloud-upload", "--allow-reference-hosting"]);
  if (command.kind !== "directing") throw new Error("parser");
  await expect(executeDirectingCommand(h.application, command, { ...h.adapters, createReferenceHosting: async () => { throw new Error("missing private store"); } })).rejects.toThrow("before dispatch");
  expect((await h.state()).attempts[0]!.state).toBe("not-dispatched"); expect(h.calls.paid).toBe(0);
});

test("successor spending reverifies its accepted predecessor endpoint", async () => {
  const h = await harness();
  h.source.shots.push({ ...shot, id: "next", firstFrame: { kind: "shot-end", shotId: "opening" } });
  await writeFile(join(h.root, "recipe.json"), JSON.stringify(h.source));
  await h.execute("start", "recipe.json", "--budget-usd", "1");
  await h.generate();
  await h.execute("review", h.source.id, "--attempt", "take_one", "--decision", "accepted", "--note", "Viewed");
  const path = join(h.application.paths.privateRoot, "directing", h.source.id, "state.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  state.attempts[0].endpoint.image.sha256 = hash("substituted image");
  await writeFile(path, JSON.stringify(state));
  await expect(h.execute("generate", h.source.id, "--shot", "next", "--attempt", "take_next", "--allow-paid-generation", "--allow-cloud-upload")).rejects.toThrow("endpoint is immutable");
  expect(h.calls.paid).toBe(1);
  expect((await h.state()).attempts).toHaveLength(1);
});

test("cleanup uncertainty and endpoint failures retain private hosting recovery evidence", async () => {
  const h = await harness(); h.calls.urlOnly = true;
  const source = { path: "artifacts/atet/generated/input.png", bytes: 50, sha256: hash("input"), mediaType: "image/png" };
  h.source.shots[0]!.firstFrame = { kind: "image", source };
  await writeFile(join(h.root, "recipe.json"), JSON.stringify(h.source));
  await h.execute("start", "recipe.json", "--budget-usd", "1");
  const receipt: DirectingBlobReceipt = {
    kind: "atet.directing-blob", schemaVersion: 1, directingId: h.source.id, attemptId: "take_hosted", namespace: "a".repeat(32), storeId: "fixture", createdAt: now.getTime(), access: "private",
    notice: "Private reference hosting uses Vercel Blob operations, storage, and transfer billed separately from the Gateway generation budget. Expiring model access does not delete the stored object.",
    entries: [{ source, pathname: `atet/directing/${"a".repeat(32)}/0-${source.sha256}.png`, putStartedAt: now.getTime(), cleanup: "uncertain", failures: [] }],
  };
  const adapters: DirectingServiceAdapters = { ...h.adapters, createReferenceHosting: async () => ({
    receiptPath: "artifacts/atet/private/hosting.json", resolveSourceUrl: async () => { throw new Error("unused transport"); },
    cleanup: async () => { h.calls.cleanup++; return receipt; }, inspect: async () => receipt,
  }) };
  const command = (attempt: string) => {
    const value = parseCliArgs(["direct", "generate", h.source.id, "--shot", "opening", "--attempt", attempt, "--allow-paid-generation", "--allow-cloud-upload", "--allow-reference-hosting"]);
    if (value.kind !== "directing") throw new Error("parser"); return value;
  };
  const result = await executeDirectingCommand(h.application, command("take_hosted"), adapters) as { referenceHosting: { cleanupRequired: boolean; receiptPath: string } };
  expect(result.referenceHosting.cleanupRequired).toBe(true);
  expect(result.referenceHosting.receiptPath).toBe("artifacts/atet/private/hosting.json");
  h.calls.failEndpoint = true;
  const error = await executeDirectingCommand(h.application, command("take_hosted_two"), adapters).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(CliError);
  expect((error as CliError).details).toMatchObject({ referenceHosting: { cleanupRequired: true, cleanupCommand: `atet direct cleanup ${h.source.id} --attempt take_hosted_two --json` } });
  expect(h.calls.cleanup).toBe(2); expect(h.calls.paid).toBe(2);
  expect((await h.state()).attempts.every(attempt => attempt.state === "completed")).toBe(true);
});
