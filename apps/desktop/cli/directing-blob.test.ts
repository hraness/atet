import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";

import { operationApplicationContext } from "../application/operations/test-support";
import type { GatewayMediaSourceReference } from "../application/gateway-port";
import { createDirectingBlobSession, DirectingBlobReceiptSchema, type DirectingBlobOptions } from "./directing-blob";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const store = "testblobstore1234";
const credential = "example.oidc.credential";
const signingKey = "test-signing-material-never-retain";
const json = (value: unknown, status = 200) => Response.json(value, { status });

async function harness() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atet-directing-blob-"))); roots.push(root);
  const application = operationApplicationContext(root, { now: new Date() });
  const bytes = await sharp({ create: { width: 16, height: 12, channels: 3, background: "#4681bd" } }).png().toBuffer();
  await mkdir(join(root, "images")); await writeFile(join(root, "images/frame.png"), bytes);
  const source: GatewayMediaSourceReference = { path: "images/frame.png", bytes: bytes.length, sha256: hash(bytes), mediaType: "image/png", facts: { width: 16, height: 12 } };
  const calls: { url: string; method: string; headers: Headers; body?: unknown }[] = [];
  const objects = new Map<string, { data: Uint8Array; etag: string }>();
  const controls = { put: "ok" as "ok" | "lost-response" | "no-write" | "wrong-store" | "public" | "oversized", sign: "ok" as "ok" | "wrong-store" | "wildcard" | "write-access" | "long-expiry", get: "ok" as "ok" | "wrong-bytes" | "oversized" | "redirect", delete: "ok" as "ok" | "fails" | "lost-response" | "retained", publiclyReadable: false, callback: undefined as undefined | (() => Promise<void>) };
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url), method = init?.method ?? "GET", headers = new Headers(init?.headers);
    expect(init?.redirect).toBe("error"); expect(init?.signal).toBeInstanceOf(AbortSignal);
    calls.push({ url: url.href, method, headers, ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}) });
    if (url.origin === "https://vercel.com") {
      expect(headers.get("authorization")).toBe(`Bearer ${credential}`);
      expect(headers.get("x-vercel-blob-store-id")).toBe(store);
      expect(headers.get("x-api-version")).toBe("12"); expect(headers.get("x-api-blob-request-attempt")).toBe("0");
      if (method === "PUT") {
        const pathname = url.searchParams.get("pathname")!;
        expect(url.pathname).toBe("/api/blob/");
        expect(headers.get("x-vercel-blob-access")).toBe("private"); expect(headers.get("x-allow-overwrite")).toBe("0"); expect(headers.get("x-add-random-suffix")).toBe("0");
        expect(objects.has(pathname)).toBe(false);
        const receiptPath = join(application.paths.privateRoot, "directing-blob/direct_fixture/take_fixture/receipt.json");
        const receipt = DirectingBlobReceiptSchema.parse(JSON.parse(await readFile(receiptPath, "utf8")) as unknown);
        expect(receipt.entries.find(entry => entry.pathname === pathname)?.putCompletedAt).toBeUndefined();
        expect(receipt.entries.find(entry => entry.pathname === pathname)?.putStartedAt).toBeGreaterThan(0);
        await controls.callback?.();
        if (controls.put === "no-write") throw new Error(`network failure ${credential}`);
        const data = new Uint8Array(init?.body as Uint8Array), etag = `"${hash(data)}"`;
        objects.set(pathname, { data, etag });
        if (controls.put === "lost-response") throw new Error(`lost response ${credential}`);
        if (controls.put === "oversized") return new Response("x".repeat(32 * 1024 + 1));
        return json({ pathname, contentType: headers.get("x-content-type"), etag,
          url: `https://${controls.put === "wrong-store" ? "anotherstore" : store}.${controls.put === "public" ? "public" : "private"}.blob.vercel-storage.com/${pathname}` });
      }
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      if (url.pathname === "/api/blob/signed-token") {
        expect(method).toBe("POST"); expect(body.operations).toEqual(["get"]);
        expect((body.validUntil as number) - application.clock.now().getTime()).toBe(15 * 60_000);
        const validUntil = (body.validUntil as number) + (controls.sign === "long-expiry" ? 1 : 0);
        const payload = { storeId: controls.sign === "wrong-store" ? "otherstore" : store, pathname: controls.sign === "wildcard" ? "*" : body.pathname,
          operations: controls.sign === "write-access" ? ["get", "delete"] : ["get"], validUntil, iat: application.clock.now().getTime(), ownerId: "test-owner" };
        return json({ delegationToken: `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.example-signature`, clientSigningToken: signingKey, validUntil });
      }
      if (url.pathname === "/api/blob/delete") {
        expect(method).toBe("POST");
        const paths = body.urls as string[];
        expect(paths).toHaveLength(1); expect(paths[0]).toMatch(/^atet\/directing\/[a-f0-9]{32}\/[01]-/u);
        const object = objects.get(paths[0]!);
        expect(object).toBeDefined();
        expect(headers.get("x-if-match")).toBe(object!.etag);
        if (controls.delete === "fails") return json({ error: { message: credential } }, 503);
        if (controls.delete !== "retained") objects.delete(paths[0]!);
        if (controls.delete === "lost-response") throw new Error(`delete response ${credential}`);
        return json({});
      }
      throw new Error(`Unexpected API request: ${url.pathname}`);
    }
    expect(url.hostname).toBe(`${store}.private.blob.vercel-storage.com`); expect(method).toBe("GET");
    expect(headers.has("authorization")).toBe(false);
    if (url.search === "") return new Response(null, { status: controls.publiclyReadable ? 200 : 403 });
    expect(url.searchParams.get("cache")).toBe("0");
    expect(url.searchParams.has("vercel-blob-signature")).toBe(true); expect(url.searchParams.has("vercel-blob-delegation")).toBe(true);
    const object = objects.get(url.pathname.slice(1));
    if (object === undefined) return new Response(null, { status: 404 });
    if (controls.get === "redirect") return new Response(null, { status: 302, headers: { location: "https://example.com/credential-sink" } });
    const data = controls.get === "wrong-bytes" ? Buffer.alloc(object.data.length) : controls.get === "oversized" ? new Uint8Array(object.data.length + 1) : object.data;
    return new Response(new Uint8Array(data).buffer, { headers: { "content-type": "image/png", etag: object.etag, "content-length": String(data.length) } });
  }) as typeof fetch;
  const abort = new AbortController();
  const options: DirectingBlobOptions = { application, environment: { VERCEL_OIDC_TOKEN: credential, BLOB_STORE_ID: `store_${store}`, VERCEL_BLOB_API_URL: "https://example.com/credential-sink", VERCEL_BLOB_RETRIES: "100" }, directingId: "direct_fixture", attemptId: "take_fixture", signal: abort.signal, fetch: transport };
  const session = await createDirectingBlobSession(options);
  return { root, application, source, bytes, objects, calls, controls, session, options, abort };
}

test("private exact-byte hosting retains intent, limits signed GET scope, and cleans up without secrets", async () => {
  const h = await harness();
  const url = await h.session.resolveSourceUrl(h.source, h.bytes, new AbortController().signal);
  expect(url).toContain(".private.blob.vercel-storage.com/"); expect(url).toContain("vercel-blob-signature=");
  expect(h.calls.filter(call => call.method === "PUT")).toHaveLength(1);
  const beforeCleanup = await h.session.inspect();
  expect(beforeCleanup.entries[0]?.verifiedAt).toBeGreaterThan(0);
  const retained = await readFile(join(h.root, h.session.receiptPath), "utf8");
  for (const secret of [credential, signingKey, "delegationToken", "presignedUrl", "vercel-blob-signature", "vercel-blob-delegation", "https://"]) expect(retained).not.toContain(secret);
  const receipt = await h.session.cleanup(); expect(receipt.entries[0]?.cleanup).toBe("deleted"); expect(h.objects.size).toBe(0);
  const requests = h.calls.length; expect(await h.session.cleanup()).toEqual(receipt); expect(h.calls).toHaveLength(requests);
  await expect(h.session.resolveSourceUrl(h.source, h.bytes, new AbortController().signal)).rejects.toThrow("closed");
});

test("reopening a verified upload does not PUT again; inspect needs no credential", async () => {
  const h = await harness(); await h.session.resolveSourceUrl(h.source, h.bytes, new AbortController().signal);
  const reopened = await createDirectingBlobSession(h.options);
  await reopened.resolveSourceUrl(h.source, h.bytes, new AbortController().signal);
  expect(h.calls.filter(call => call.method === "PUT")).toHaveLength(1);
  const readonly = await createDirectingBlobSession({ ...h.options, environment: {} });
  expect(await readonly.inspect()).toEqual(await h.session.inspect());
  const cleanup = await readonly.cleanup(); expect(cleanup.entries[0]?.cleanup).toBe("uncertain");
  expect(h.objects.size).toBe(1);
});

test("cleanup after generation cancellation has an independent signal", async () => {
  const h = await harness(); await h.session.resolveSourceUrl(h.source, h.bytes, new AbortController().signal); h.abort.abort();
  expect((await h.session.cleanup()).entries[0]?.cleanup).toBe("deleted"); expect(h.objects.size).toBe(0);
});

test("a lost PUT response is never retried and exact-byte cleanup recovers its object", async () => {
  const h = await harness(); h.controls.put = "lost-response";
  await expect(h.session.resolveSourceUrl(h.source, h.bytes, new AbortController().signal)).rejects.toThrow("uncertain");
  await expect(h.session.resolveSourceUrl(h.source, h.bytes, new AbortController().signal)).rejects.toThrow("previous upload");
  expect(h.calls.filter(call => call.method === "PUT")).toHaveLength(1);
  const receipt = await h.session.cleanup(); expect(receipt.entries[0]?.cleanup).toBe("deleted"); expect(receipt.entries[0]?.failures[0]?.phase).toBe("put");
});

test("an absent ambiguous upload remains unresolved because remote settlement is unknown", async () => {
  const h = await harness(); h.controls.put = "no-write";
  await expect(h.session.resolveSourceUrl(h.source, h.bytes, new AbortController().signal)).rejects.toThrow("uncertain");
  const receipt = await h.session.cleanup(); expect(receipt.entries[0]?.cleanup).toBe("uncertain");
  expect(h.calls.filter(call => new URL(call.url).pathname === "/api/blob/delete")).toHaveLength(0);
});

test.each(["wrong-store", "public", "oversized"] as const)("rejects %s PUT responses without returning a model URL", async mode => {
  const h = await harness(); h.controls.put = mode;
  let message = "";
  try { await h.session.resolveSourceUrl(h.source, h.bytes, new AbortController().signal); } catch (error) { message = String(error); }
  expect(message).toContain("uncertain"); expect(message).not.toContain(credential);
  expect(h.calls.filter(call => call.method === "PUT")).toHaveLength(1);
  expect(h.calls.filter(call => call.method === "GET")).toHaveLength(0);
});

test.each(["wrong-store", "wildcard", "write-access", "long-expiry"] as const)("rejects overbroad signing material: %s", async mode => {
  const h = await harness(); h.controls.sign = mode;
  await expect(h.session.resolveSourceUrl(h.source, h.bytes, new AbortController().signal)).rejects.toThrow("could not be verified");
  expect(h.calls.filter(call => call.method === "GET")).toHaveLength(0);
  const receipt = await h.session.inspect(); expect(receipt.entries[0]?.failures[0]?.phase).toBe("sign");
  expect(JSON.stringify(receipt)).not.toContain(signingKey);
});

test.each(["wrong-bytes", "oversized", "redirect"] as const)("rejects %s private GET verification and preserves cleanup evidence", async mode => {
  const h = await harness(); h.controls.get = mode;
  await expect(h.session.resolveSourceUrl(h.source, h.bytes, new AbortController().signal)).rejects.toThrow("could not be verified");
  expect((await h.session.cleanup()).entries[0]?.cleanup).toBe("uncertain");
  expect(h.calls.some(call => new URL(call.url).hostname === "example.com")).toBe(false);
});

test.each(["fails", "lost-response", "retained"] as const)("cleanup uncertainty remains visible when delete %s", async mode => {
  const h = await harness(); await h.session.resolveSourceUrl(h.source, h.bytes, new AbortController().signal); h.controls.delete = mode;
  const cleanup = await h.session.cleanup(); expect(cleanup.entries[0]?.cleanup).toBe("uncertain"); expect(cleanup.entries[0]?.failures.at(-1)?.phase).toBe("delete");
  expect(JSON.stringify(cleanup)).not.toContain(credential);
  h.controls.delete = "ok";
  expect((await h.session.cleanup()).entries[0]?.cleanup).toBe("deleted");
});

test("rejects changed local bytes, unretained sources, oversized sources, and nonimages before network", async () => {
  const h = await harness();
  await expect(h.session.resolveSourceUrl(h.source, Buffer.alloc(h.bytes.length), new AbortController().signal)).rejects.toThrow("exact retained");
  await expect(h.session.resolveSourceUrl({ ...h.source, path: "missing.png" }, h.bytes, new AbortController().signal)).rejects.toThrow();
  await expect(h.session.resolveSourceUrl({ ...h.source, mediaType: "text/plain" }, h.bytes, new AbortController().signal)).rejects.toThrow();
  await expect(h.session.resolveSourceUrl({ ...h.source, bytes: 30 * 1024 * 1024 + 1 }, h.bytes, new AbortController().signal)).rejects.toThrow();
  expect(h.calls).toHaveLength(0); expect((await h.session.inspect()).entries).toHaveLength(0);
});

test("store or exact object identity changes cannot expand cleanup authority", async () => {
  const h = await harness(); await h.session.resolveSourceUrl(h.source, h.bytes, new AbortController().signal);
  const opened = await createDirectingBlobSession({ ...h.options, environment: { VERCEL_OIDC_TOKEN: credential, BLOB_STORE_ID: "otherstore" } });
  expect((await opened.cleanup()).entries[0]?.cleanup).toBe("uncertain");
  const receipt = await h.session.inspect();
  receipt.entries[0]!.pathname = "someone-elses-file.png";
  await writeFile(join(h.root, h.session.receiptPath), JSON.stringify(receipt));
  await expect(h.session.cleanup()).rejects.toThrow(); expect(h.objects.size).toBe(1);
});

test("a changed remote ETag is never deleted even when the content bytes match", async () => {
  const h = await harness(); await h.session.resolveSourceUrl(h.source, h.bytes, new AbortController().signal);
  const object = [...h.objects.values()][0]!; object.etag = '"replaced-object"';
  expect((await h.session.cleanup()).entries[0]?.cleanup).toBe("uncertain");
  expect(h.calls.filter(call => new URL(call.url).pathname === "/api/blob/delete")).toHaveLength(0);
});

test("caller mutation after invocation cannot change the uploaded immutable bytes", async () => {
  const h = await harness();
  const pending = h.session.resolveSourceUrl(h.source, h.bytes, new AbortController().signal);
  h.bytes.fill(0);
  await pending;
  expect(hash([...h.objects.values()][0]!.data)).toBe(h.source.sha256);
});

test("private hostname alone is insufficient if the object is anonymously readable", async () => {
  const h = await harness(); h.controls.publiclyReadable = true;
  await expect(h.session.resolveSourceUrl(h.source, h.bytes, new AbortController().signal)).rejects.toThrow("could not be verified");
  expect((await h.session.inspect()).entries[0]?.verifiedAt).toBeUndefined();
  expect((await h.session.cleanup()).entries[0]?.cleanup).toBe("deleted");
});

test("two explicit sources bound session size and repeated sources reuse their exact object", async () => {
  const h = await harness();
  await h.session.resolveSourceUrl(h.source, h.bytes, new AbortController().signal);
  await writeFile(join(h.root, "images/second.png"), h.bytes); await writeFile(join(h.root, "images/third.png"), h.bytes);
  await h.session.resolveSourceUrl({ ...h.source, path: "images/second.png" }, h.bytes, new AbortController().signal);
  await h.session.resolveSourceUrl(h.source, h.bytes, new AbortController().signal);
  await expect(h.session.resolveSourceUrl({ ...h.source, path: "images/third.png" }, h.bytes, new AbortController().signal)).rejects.toThrow("at most two");
  expect(h.calls.filter(call => call.method === "PUT")).toHaveLength(2);
  expect((await h.session.cleanup()).entries.every(entry => entry.cleanup === "deleted")).toBe(true);
});
