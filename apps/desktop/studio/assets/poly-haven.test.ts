import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASSET_LIMITS, POLY_HAVEN, assetJson, downloadUrl, parseAssetSearch, parseAssetSelection, parsePolyHavenAssetPlan, planPolyHavenAsset } from "./contracts";
import { createPolyHavenNetwork, type AssetFetch } from "./network";
import { createPolyHavenAssetService, validateGltfAssetClosure } from "./poly-haven";

const roots: string[] = [];
afterEach(async () => { for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true }); });
async function root(): Promise<string> { const value = await realpath(await mkdtemp(join(tmpdir(), "atet-poly-haven-"))); roots.push(value); return value; }
const md5 = (bytes: Uint8Array): string => createHash("md5").update(bytes).digest("hex");
const hdri = Buffer.from("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 1\n\u0080\u0080\u0080\u0081", "latin1");
const source = (bytes: Uint8Array, name: string) => ({ url: `${POLY_HAVEN.download}/file/ph-assets/HDRIs/hdr/1k/${name}`, size: bytes.length, md5: md5(bytes) });
const info = { name: "Test Environment", type: 0, authors: { "Example Artist": "Photography" }, thumbnail_url: "https://cdn.polyhaven.com/asset_img/thumbs/test.png?width=256&height=256&v=abc" };
const selection = { provider: "poly-haven", assetId: "test", kind: "hdri", resolution: "1k", format: "hdr" };
function plan() { return planPolyHavenAsset(selection, { info, files: { hdri: { "1k": { hdr: source(hdri, "test_1k.hdr") } } } }); }
function fakeNetwork(bytes = hdri) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: AssetFetch = async (url, init) => {
    calls.push({ url, init });
    if (url.includes("/search?")) return Response.json({ query: "studio", type: "hdris", total: 1, results: [{ slug: "test", score: .7 }] });
    if (url.includes("/info/")) return Response.json(info);
    if (url.includes("/files/")) return Response.json({ hdri: { "1k": { hdr: source(hdri, "test_1k.hdr") } } });
    return new Response(new Uint8Array(bytes));
  };
  return { calls, fetch };
}

describe("Poly Haven retained plans", () => {
  test("captures strict, canonical selections without invoking foreign accessors", () => {
    expect(parseAssetSearch({ provider: "poly-haven", query: " STUDIO ", type: "hdris", limit: 1 }).query).toBe("studio");
    expect(parseAssetSelection(selection).maximumTotalBytes).toBe(50 * 1024 * 1024);
    expect(() => parseAssetSelection({ ...selection, url: "https://example.com" })).toThrow();
    let reads = 0;
    expect(() => parseAssetSelection({ get provider() { reads++; return "poly-haven"; } })).toThrow();
    expect(reads).toBe(0);
    const data = { info: structuredClone(info), files: { hdri: { "1k": { hdr: source(hdri, "test_1k.hdr") } } } };
    const retained = planPolyHavenAsset(selection, data);
    data.info.name = "Changed";
    expect(retained.asset.name).toBe("Test Environment");
    expect(Object.isFrozen(retained.files)).toBe(true);
    expect(parsePolyHavenAssetPlan(JSON.parse(assetJson(retained)))).toEqual(retained);
  });

  test("rejects plan budget, receipt-shape, selection and provenance forgery", () => {
    const original = plan();
    for (const changed of [{ ...original, totalBytes: 1 }, { ...original, credit: "Not credited" }, { ...original, planSha256: "a".repeat(64) }, { ...original, extra: true }, { ...original, files: [] }]) expect(() => parsePolyHavenAssetPlan(changed)).toThrow();
    expect(() => planPolyHavenAsset({ ...selection, maximumTotalBytes: 1 }, original.snapshots)).toThrow(/budget/u);
    expect(() => planPolyHavenAsset({ ...selection, kind: "texture", format: "png", maps: ["Diffuse"] }, original.snapshots)).toThrow(/kind/u);
    expect(() => planPolyHavenAsset({ ...selection, resolution: "2k" }, original.snapshots)).toThrow(/unavailable/u);
  });

  test("fixed HTTPS URL gate rejects credentials, ports, redirects targets and path escapes", () => {
    const valid = source(hdri, "test_1k.hdr").url;
    expect(downloadUrl(valid)).toBe(valid);
    for (const url of [valid.replace("https:", "http:"), valid.replace("dl.polyhaven.org", "dl.polyhaven.org.evil.test"), valid.replace("dl.polyhaven.org", "user:secret@dl.polyhaven.org"), `${valid}?token=secret`, `${valid}#fragment`, valid.replace(".org/", ".org:444/"), valid.replace("test_1k.hdr", "%2fprivate.hdr"), valid.replace("test_1k.hdr", "../private.hdr")]) expect(() => downloadUrl(url)).toThrow();
    expect(() => planPolyHavenAsset(selection, { ...plan().snapshots, info: { ...info, thumbnail_url: "https://cdn.polyhaven.com/asset_img/thumbs/test.png?secret=credential" } })).toThrow();
  });

  test("texture maps are explicit and cannot infer scripts or archive dependencies", () => {
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const snapshots = { info: { ...info, type: 1 }, files: { Diffuse: { "1k": { png: source(png, "test_diff_1k.png") } }, Rough: { "1k": { png: source(png, "test_rough_1k.png") } } } };
    const result = planPolyHavenAsset({ ...selection, kind: "texture", format: "png", maps: ["Rough", "Diffuse"] }, snapshots);
    expect(result.files.map(file => file.map)).toEqual(["Diffuse", "Rough"]);
    expect(() => planPolyHavenAsset({ ...selection, kind: "texture", format: "png", maps: ["Diffuse", "Diffuse"] }, snapshots)).toThrow();
    expect(() => planPolyHavenAsset({ ...selection, kind: "model", format: "blend" }, snapshots)).toThrow();
    expect(() => planPolyHavenAsset({ ...selection, kind: "model", format: "gltf" }, { info: { ...info, type: 2 }, files: { gltf: { "1k": { gltf: { ...source(png, "test.gltf"), size: ASSET_LIMITS.jsonBytes + 1 } } } } })).toThrow(/four MiB/u);
  });
});

function modelFixture(document?: unknown, extra = false) {
  const geometry = Buffer.from([1, 2, 3]);
  const model = Buffer.from(JSON.stringify(document ?? { asset: { version: "2.0" }, buffers: [{ uri: "test.bin", byteLength: 3 }] }));
  const includes = { "test.bin": source(geometry, "test.bin"), ...(extra ? { "extra.bin": source(geometry, "extra.bin") } : {}) };
  const planned = planPolyHavenAsset({ ...selection, kind: "model", format: "gltf" }, { info: { ...info, type: 2 }, files: { gltf: { "1k": { gltf: { ...source(model, "test_1k.gltf"), include: includes } } } } });
  return { model, planned };
}
test("glTF admits exact local dependencies and rejects omitted, extra and hidden resources", () => {
  const fixture = modelFixture();
  expect(() => validateGltfAssetClosure(fixture.model, fixture.planned)).not.toThrow();
  const cases = [
    { asset: { version: "2.0" }, buffers: [{ uri: "https://example.com/private", byteLength: 3 }] },
    { asset: { version: "2.0" }, buffers: [{ uri: "../test.bin", byteLength: 3 }] },
    { asset: { version: "2.0" }, buffers: [{ uri: "test.bin", byteLength: 4 }] },
    { asset: { version: "2.0" }, buffers: [{ uri: "test.bin", byteLength: 3 }], extras: { uri: "test.bin" } },
    { asset: { version: "2.0" }, buffers: [{ uri: "test.bin", byteLength: 3 }], extensions: { EXT_unknown: {} } },
    { asset: { version: "2.0" }, buffers: [{ uri: "test.bin", byteLength: 3 }], extensionsUsed: ["KHR_draco_mesh_compression"] },
  ];
  for (const data of cases) { const value = modelFixture(data); expect(() => validateGltfAssetClosure(value.model, value.planned)).toThrow(); }
  const extra = modelFixture(undefined, true);
  expect(() => validateGltfAssetClosure(extra.model, extra.planned)).toThrow(/unreferenced/u);
});

describe("bounded public network", () => {
  test("identifies ATET and disables credentials and redirects", async () => {
    const fake = fakeNetwork(), network = createPolyHavenNetwork(fake);
    expect(await network.file(source(hdri, "test_1k.hdr").url, hdri.length)).toEqual(hdri);
    expect(fake.calls[0]!.init.redirect).toBe("error");
    expect(fake.calls[0]!.init.credentials).toBe("omit");
    expect(new Headers(fake.calls[0]!.init.headers).get("user-agent")).toBe(POLY_HAVEN.userAgent);
  });
  test("bounds declared and streamed bytes, rejects status/redirect responses and truncated files", async () => {
    for (const response of [new Response("", { status: 302, headers: { location: "https://example.com" } }), new Response(hdri, { headers: { "content-length": "9999" } }), new Response(new Uint8Array(hdri).slice(1)), new Response(new Uint8Array(hdri.length + 1))]) {
      const network = createPolyHavenNetwork({ fetch: async () => response });
      await expect(network.file(source(hdri, "test_1k.hdr").url, hdri.length)).rejects.toThrow();
    }
    await expect(createPolyHavenNetwork(fakeNetwork()).file(source(hdri, "test_1k.hdr").url, ASSET_LIMITS.fileBytes + 1)).rejects.toThrow();
  });
  test("cancels a body that never produces bytes without waiting for its source", async () => {
    const controller = new AbortController();
    const network = createPolyHavenNetwork({ signal: controller.signal, fetch: async () => new Response(new ReadableStream({ start() { controller.abort(); } })) });
    await expect(network.file(source(hdri, "test_1k.hdr").url, hdri.length)).rejects.toThrow(/cancel/u);
  });
  test("cancellation bounds injected requests and nonsettling error-body cancellation", async () => {
    const controller = new AbortController();
    const network = createPolyHavenNetwork({ signal: controller.signal, fetch: async () => { controller.abort(); return new Promise<Response>(() => undefined); } });
    await expect(network.file(source(hdri, "test_1k.hdr").url, hdri.length)).rejects.toThrow(/cancel/u);
    const response = new Response(new ReadableStream({ cancel: () => new Promise<void>(() => undefined) }), { status: 302 });
    await expect(createPolyHavenNetwork({ fetch: async () => response }).file(source(hdri, "test_1k.hdr").url, hdri.length)).rejects.toThrow(/302/u);
  }, 1000);
});

describe("immutable acquisition", () => {
  test("describe rejects credential-bearing file URLs before exposing provider snapshots", async () => {
    const fetch: AssetFetch = async url => Response.json(url.includes("/info/") ? info : { hdri: { "1k": { hdr: { ...source(hdri, "test_1k.hdr"), url: `${source(hdri, "test_1k.hdr").url}?token=secret` } } } });
    await expect(createPolyHavenAssetService({ storageRoot: await root(), fetch }).describe("test")).rejects.toThrow(/fixed HTTPS/u);
  });
  test("search preserves provider ranking, credit, authors and canonical query", async () => {
    const fake = fakeNetwork(), service = createPolyHavenAssetService({ storageRoot: await root(), fetch: fake.fetch });
    const result = await service.search({ provider: "poly-haven", query: "STUDIO", type: "hdris", limit: 1 });
    expect(result.credit).toBe(POLY_HAVEN.credit);
    expect(result.items[0]!.authors[0]!.name).toBe("Example Artist");
    expect(fake.calls).toHaveLength(2);
  });
  test("imports exact bytes and replays offline with SHA256, source closure and CC0 scope", async () => {
    const directory = await root(), fake = fakeNetwork();
    const service = createPolyHavenAssetService({ storageRoot: directory, fetch: fake.fetch });
    const selected = await service.plan(selection), result = await service.importAsset(selected);
    expect(result.receipt.license.scope).toBe("asset-files");
    expect(result.receipt.files[0]!.sha256).toBe(createHash("sha256").update(hdri).digest("hex"));
    expect(await readFile(join(result.sourceRoot, selected.files[0]!.path))).toEqual(hdri);
    expect(result.receiptSha256).toBe(createHash("sha256").update(await readFile(join(directory, result.receiptPath))).digest("hex"));
    expect(Object.isFrozen(result.receipt.files)).toBe(true);
    const offline = createPolyHavenAssetService({ storageRoot: directory, fetch: async () => { throw new Error("unexpected network"); } });
    const reused = await offline.importAsset(selected);
    expect(reused.disposition).toBe("reused");
    expect(reused.receiptSha256).toBe(result.receiptSha256);
  });
  test("rejects changed bytes and incomplete metadata without overwriting a retained result", async () => {
    const directory = await root(), fake = fakeNetwork();
    const service = createPolyHavenAssetService({ storageRoot: directory, fetch: fake.fetch });
    const result = await service.importAsset(plan());
    const path = join(result.sourceRoot, plan().files[0]!.path);
    await writeFile(path, Buffer.alloc(hdri.length, 65));
    fake.calls.splice(0);
    await expect(service.importAsset(plan())).rejects.toThrow(/MD5/u);
    expect(fake.calls).toHaveLength(0);
    expect(await readFile(path)).toEqual(Buffer.alloc(hdri.length, 65));
  });
  test("rejects checksum mismatch, unavailable publication custody, and symlink storage", async () => {
    const directory = await root(), fake = fakeNetwork(Buffer.alloc(hdri.length, 65));
    await expect(createPolyHavenAssetService({ storageRoot: directory, fetch: fake.fetch }).importAsset(plan())).rejects.toThrow(/MD5/u);
    fake.calls.splice(0);
    await expect(createPolyHavenAssetService({ storageRoot: directory, fetch: fake.fetch, beforePublication: async () => { throw new Error("lost lease"); } }).importAsset(plan())).rejects.toThrow(/lease/u);
    expect(fake.calls).toHaveLength(0);
    const alias = join(await root(), "alias");
    await symlink(directory, alias);
    await expect(createPolyHavenAssetService({ storageRoot: alias, fetch: fake.fetch }).importAsset(plan())).rejects.toThrow(/physical/u);
  });
  test("rejects undeclared source files on completed replay", async () => {
    const directory = await root(), fake = fakeNetwork();
    const service = createPolyHavenAssetService({ storageRoot: directory, fetch: fake.fetch }), result = await service.importAsset(plan());
    await writeFile(join(result.sourceRoot, "unexpected.py"), "raise RuntimeError('must remain inert')");
    await expect(service.importAsset(plan())).rejects.toThrow(/closure/u);
  });
  test("resumes a partial closure without downloading its already verified file", async () => {
    const directory = await root(), bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    const planned = planPolyHavenAsset({ ...selection, kind: "texture", format: "png", maps: ["Diffuse", "Rough"] }, { info: { ...info, type: 1 }, files: { Diffuse: { "1k": { png: source(bytes, "test_diff_1k.png") } }, Rough: { "1k": { png: source(bytes, "test_rough_1k.png") } } } });
    let failed = false;
    const fetch: AssetFetch = async url => { if (url.endsWith("test_rough_1k.png") && !failed) { failed = true; throw new Error("interrupted transfer"); } return new Response(new Uint8Array(bytes)); };
    await expect(createPolyHavenAssetService({ storageRoot: directory, fetch }).importAsset(planned)).rejects.toThrow(/interrupted/u);
    await expect(lstat(join(directory, "imports", planned.planSha256, "receipt.json"))).rejects.toThrow();
    const requested: string[] = [];
    const result = await createPolyHavenAssetService({ storageRoot: directory, fetch: async (url, init) => { requested.push(url); return fetch(url, init); } }).importAsset(planned);
    expect(requested).toEqual([source(bytes, "test_rough_1k.png").url]);
    expect(result.receipt.files).toHaveLength(2);
  });
});
