import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import sharp from "sharp";
import { boundedCanonicalJsonSha256 } from "../../../src/code/canonical-json";
import { planStudioJob, studioSourceBundleSha256, type StudioOutputSpec } from "../../../src/studio";
import type { ApplicationContext } from "../application/context";
import type { MediaArtifactReference } from "../application/operations/media/shared";
import { ensurePhysicalPrivateDirectoryWithin } from "./paths";
import { verifyStudioFramehash } from "./studio-encode";
import { studioBytesSha256, studioJson } from "./studio-files";
import { createStudioService } from "./studio-service";
import { admitStudioSpatialAsset, StudioSpatialAssetReceiptSchema, type StudioSpatialAssetSelection } from "./studio-spatial-asset";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const hash = (value: unknown) => boundedCanonicalJsonSha256(value, { maximumBytes: 32 * 1024 * 1024, maximumDepth: 48, maximumValues: 1_000_000 });
const render = { width: 2, height: 1, frameRate: { numerator: 24000, denominator: 1001 }, startFrame: 7, endFrameExclusive: 9 };
const fence = async () => {};
function glb(unsupported = false): Buffer {
  const bin = Buffer.alloc(36); [0,0,0,2,0,0,0,3,0].forEach((n, i) => bin.writeFloatLE(n, i * 4));
  const document = { asset: { version: "2.0" }, buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0,0,0], max: [2,3,0] }],
    scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], ...(unsupported ? { skins: [] } : {}) };
  const raw = Buffer.from(JSON.stringify(document)), json = Buffer.alloc(Math.ceil(raw.length / 4) * 4, 32); raw.copy(json);
  const result = Buffer.alloc(28 + json.length + bin.length); result.write("glTF"); result.writeUInt32LE(2,4); result.writeUInt32LE(result.length,8);
  result.writeUInt32LE(json.length,12); result.write("JSON",16); json.copy(result,20); result.writeUInt32LE(bin.length,20 + json.length); result.write("BIN\0",24 + json.length); bin.copy(result,28 + json.length);
  return result;
}
async function fixture(kind: "image" | "sequence" | "model" = "image", options: { alpha?: boolean; unsupportedGlb?: boolean; gamma?: number } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "atet-studio-spatial-"))); roots.push(root);
  const privateRoot = await ensurePhysicalPrivateDirectoryWithin(root, "private"), jobId = "studio_asset_fixture";
  const jobRoot = await ensurePhysicalPrivateDirectoryWithin(privateRoot, `studio/jobs/${jobId}`), sourceRoot = await ensurePhysicalPrivateDirectoryWithin(jobRoot, "source"), outputRoot = await ensurePhysicalPrivateDirectoryWithin(jobRoot, "outputs");
  const authored = "raise RuntimeError('Admission must never execute source')\n";
  await writeFile(join(sourceRoot, "scene.py"), authored);
  const bundle = { kind: "atet.studio-source-bundle", schemaVersion: 1, engine: "blender", entrypoint: { kind: "python", path: "scene.py" }, files: [{ path: "scene.py", sha256: studioBytesSha256(authored), bytes: Buffer.byteLength(authored) }] };
  const alpha = options.alpha ?? false;
  const raster = { kind: "raster", colorSpace: "srgb", alpha: alpha ? "straight" : "opaque", dataType: "uint8", semantic: "color", unit: "unitless", channels: alpha ? ["R","G","B","A"] : ["R","G","B"] } as const;
  const output: StudioOutputSpec = kind === "model" ? { id: "model", kind: "file", role: "model", format: "glb", path: "city.glb", interpretation: { kind: "model", sourceSpace: { units: "millimeters", upAxis: "z", handedness: "right" } } }
    : kind === "sequence" ? { id: "beauty", kind: "sequence", role: "beauty", format: "png", pathPattern: "frame_%06d.png", interpretation: raster }
    : { id: "image", kind: "file", role: "beauty", format: "png", path: "image.png", interpretation: raster };
  const job = { kind: "atet.studio-job", schemaVersion: 1, jobId, bundleSha256: studioSourceBundleSha256(bundle), stage: "build", parameters: {}, ...(kind === "model" ? {} : { render }),
    engine: { engine: "blender", renderer: "cycles", device: "cpu", samples: 1, transparent: alpha, viewTransform: "Standard", denoise: false, seed: 0 }, outputs: [output],
    limits: { timeoutSeconds: 30, maximumOutputBytes: 1_048_576, maximumOutputFiles: 2 }, execution: { trust: "trusted-current-user", isolation: "none", hermetic: false } };
  const sha = "a".repeat(64), runtime = { kind: "atet.studio-runtime", schemaVersion: 1, engine: "blender", tool: { name: "Blender", version: "fixture", executableSha256: sha }, driverSha256: sha,
    environment: { fingerprintSha256: sha, evidence: "observed-package-environment", hermetic: false }, capabilities: ["python-authoring", "build", "image-sequence", "model-export"].map(name => ({ name, support: "available", evidence: "probe" })) };
  const plan = planStudioJob({ bundle, job, runtime });
  let bytes = kind === "model" ? glb(options.unsupportedGlb) : await sharp({ create: { width: render.width, height: render.height, channels: alpha ? 4 : 3, background: { r: 50, g: 100, b: 200, alpha: 0.5 } } }).png().toBuffer();
  if (options.gamma !== undefined) {
    const chunk = Buffer.alloc(16); chunk.writeUInt32BE(4); chunk.write("gAMA",4); chunk.writeUInt32BE(options.gamma,8);
    let crc = 0xffffffff;
    for (const byte of chunk.subarray(4,12)) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0,12);
    bytes = Buffer.concat([bytes.subarray(0,33),chunk,bytes.subarray(33)]);
  }
  const outputs = [];
  for (const frame of kind === "sequence" ? [7,8] : [undefined]) {
    const path = output.kind === "sequence" ? output.pathPattern.replace("%06d", String(frame).padStart(6,"0")) : output.path;
    await writeFile(join(outputRoot, path), bytes);
    outputs.push({ outputId: output.id, path, sha256: studioBytesSha256(bytes), bytes: bytes.length, role: output.role, format: output.format, ...(frame === undefined ? {} : { frame }) });
  }
  const document = { kind: "atet.studio-receipt", schemaVersion: 1, jobId, attemptId: "attempt_fixture", planSha256: plan.planSha256, bundleSha256: plan.bundleSha256, jobSha256: plan.jobSha256, runtime: plan.runtime, runtimeSha256: plan.runtimeSha256,
    startedAt: "2026-09-09T00:00:00Z", finishedAt: "2026-09-09T00:00:01Z", state: "succeeded", custody: "closed", exitCode: 0, outputs };
  await writeFile(join(jobRoot, "plan.json"), studioJson(plan)); await writeFile(join(jobRoot, "receipt.json"), studioJson(document));
  let calls = 0;
  const application: ApplicationContext = { paths: { repositoryRoot: root, desktopRoot: root, privateRoot, artifactRoot: join(root,"recordings"), projectRoot: join(root,"projects") },
    clock: { now: () => new Date(), timestampMilliseconds: () => Date.now() }, capabilities: async () => [], capability: async () => { calls++; throw new Error("No probing allowed"); },
    runner: { run: async () => { calls++; throw new Error("No subprocess allowed"); } } };
  const service = createStudioService({ application, selection: { threads: 1 } });
  const selection: StudioSpatialAssetSelection = { jobId, outputId: output.id, representation: "native", ...(kind === "sequence" ? { frame: 7 } : {}) };
  const input = { application, service, selection, assetId: "asset_shared", signal: new AbortController().signal, beforePublication: fence };
  return { root, jobRoot, input, plan, output, document, outputs, calls: () => calls };
}
async function retainedEncode(f: Awaited<ReturnType<typeof fixture>>, toolVersion = "fixture") {
  const native = await f.input.service.inspect(f.input.selection.jobId), alpha = f.output.interpretation.kind === "raster" && f.output.interpretation.alpha === "straight";
  const request = { kind: "atet.studio-encode-request", schemaVersion: 1, planSha256: f.plan.planSha256, nativeReceipt: native.receipt, jobId: f.plan.job.jobId, outputId: f.output.id, render,
    frames: f.outputs.map(item => ({ path: item.path, frame: item.frame!, sha256: item.sha256, bytes: item.bytes })), profile: alpha ? "rgba8-lossless-qtrle-v1" : "rgb8-lossless-h264-v1", conversion: "identity-uint8", colorSpace: "srgb", alpha: alpha ? "straight" : "opaque",
    tools: ["ffmpeg", "ffprobe"].map(name => ({ name, command: `/unused/${name}`, executablePath: `/unused/${name}`, executableSha256: "c".repeat(64), version: toolVersion, bytes: 1 })), limits: { timeoutMs: 30_000, maximumOutputBytes: 1_048_576 } };
  const requestSha256 = hash(request), directory = await ensurePhysicalPrivateDirectoryWithin(f.jobRoot, `derivatives/${requestSha256}`);
  const save = async (name: string, bytes: string): Promise<MediaArtifactReference> => { await writeFile(join(directory,name), bytes); return { path: relative(f.root,join(directory,name)), sha256: studioBytesSha256(bytes), bytes: Buffer.byteLength(bytes) }; };
  const framehash = `#hash: SHA256\n#tb 0: 1001/24000\n#dimensions 0: 2x1\n0, 0, 0, 1, ${alpha ? 8 : 6}, ${"d".repeat(64)}\n0, 1, 1, 1, ${alpha ? 8 : 6}, ${"e".repeat(64)}\n`;
  const artifact = await save(alpha ? "video.mov" : "video.mp4", "0000ftypisom-fixture");
  const probe = await save("probe.json", studioJson({ streams: [{ codec_type: "video", codec_name: alpha ? "qtrle" : "h264", pix_fmt: alpha ? "argb" : "gbrp", width: 2, height: 1, avg_frame_rate: "24000/1001", time_base: "1/24000", start_pts: 0, duration_ts: 2002, nb_read_frames: "2", ...(alpha ? {} : { color_range: "pc", color_space: "gbr", color_transfer: "iec61966-2-1", color_primaries: "bt709" }) }] }));
  const document = { kind: "atet.studio-encode-receipt", schemaVersion: 1, requestSha256, request, artifact,
    verification: { frameCount: 2, canonicalFrameSha256: verifyStudioFramehash(framehash, render, alpha), sourceFramehash: await save("source.framehash", framehash), videoFramehash: await save("video.framehash", framehash), probe } };
  await save("intent.json", studioJson({ kind: "atet.studio-encode-intent", schemaVersion: 1, requestSha256, request }));
  const receipt = await save("receipt.json", studioJson(document));
  return { directory, document, receipt };
}

describe("Studio spatial asset admission", () => {
  test("retains exact PNG provenance and replays without source execution or tool probing", async () => {
    const f = await fixture(), first = await admitStudioSpatialAsset(f.input);
    expect(await admitStudioSpatialAsset(f.input)).toEqual(first);
    expect(first.asset.interpretation).toMatchObject({ kind: "image", width: 2, height: 1, alpha: "opaque", colorSpace: "srgb" });
    expect(first.asset.payload.sha256).toBe(f.outputs[0]!.sha256);
    expect(first.asset.provenance.receiptSha256).toBe(first.receipt.sha256);
    expect(first.binding.artifact).toEqual(first.document.artifact);
    expect(studioBytesSha256(await readFile(join(f.root,first.receipt.path)))).toBe(first.receipt.sha256);
    expect(() => StudioSpatialAssetReceiptSchema.parse({ ...first.document, payload: { ...first.document.payload, sha256: "f".repeat(64) } })).toThrow("disagree");
    expect(f.calls()).toBe(0);
  });
  test("admits GLB with explicit source coordinates and rejects unsupported skin semantics before rendering", async () => {
    const f = await fixture("model");
    expect((await admitStudioSpatialAsset(f.input)).asset.interpretation).toEqual({ kind: "gltf", format: "glb", metersPerUnit: 0.001, sourceUp: "z" });
    const invalid = await fixture("model", { unsupportedGlb: true });
    await expect(admitStudioSpatialAsset(invalid.input)).rejects.toThrow("outside atet.glb-triangles-trs-pbr-basecolor-v1");
    expect(invalid.calls()).toBe(0);
  });
  test("explicit contradictory PNG gamma rejects while the conventional sRGB tag remains supported", async () => {
    const valid = await fixture("image", { gamma: 45455 });
    expect((await admitStudioSpatialAsset(valid.input)).asset.interpretation.kind).toBe("image");
    const invalid = await fixture("image", { gamma: 100000 });
    await expect(admitStudioSpatialAsset(invalid.input)).rejects.toThrow("gamma contradicts");
  });
  test("requires an exact native frame and rejects conflicting file or video selectors", async () => {
    const f = await fixture("sequence", { alpha: true });
    expect((await admitStudioSpatialAsset(f.input)).asset.interpretation).toMatchObject({ kind: "image", alpha: "straight" });
    const selection = { ...f.input.selection }; delete selection.frame;
    await expect(admitStudioSpatialAsset({ ...f.input, selection })).rejects.toThrow("exact --frame");
    await expect(admitStudioSpatialAsset({ ...f.input, selection: { ...selection, frame: 10 } })).rejects.toThrow("exactly one");
    await expect(admitStudioSpatialAsset({ ...f.input, selection: { ...selection, representation: "encoded-video", frame: 7 } })).rejects.toThrow("complete sequence");
  });
  test.each([false,true])("admits existing encoded RGB/RGBA video with exact fractional clock, alpha=%s", async alpha => {
    const f = await fixture("sequence", { alpha }), encoded = await retainedEncode(f);
    const input = { ...f.input, selection: { jobId: f.plan.job.jobId, outputId: f.output.id, representation: "encoded-video" as const } };
    const result = await admitStudioSpatialAsset(input);
    expect(result.asset.interpretation).toEqual({ kind: "video", width: 2, height: 1, colorSpace: "srgb", alpha: alpha ? "straight" : "opaque", durationUs: 83417, frameRate: render.frameRate });
    expect(result.document.encodeReceipt).toEqual(encoded.receipt);
    expect(result.binding.artifact).toEqual(encoded.document.artifact);
    expect(await admitStudioSpatialAsset(input)).toEqual(result);
    expect(f.calls()).toBe(0);
  });
  test("missing or ambiguous derivatives never authorize encoding or an implicit latest choice", async () => {
    const f = await fixture("sequence"), input = { ...f.input, selection: { jobId: f.plan.job.jobId, outputId: f.output.id, representation: "encoded-video" as const } };
    await expect(admitStudioSpatialAsset(input)).rejects.toThrow("studio encode explicitly");
    const first = await retainedEncode(f); await retainedEncode(f,"other-tool-version");
    await expect(admitStudioSpatialAsset(input)).rejects.toThrow(first.document.requestSha256);
    expect(f.calls()).toBe(0);
  });
  test("source, receipt and pixel-evidence tampering prevent admission", async () => {
    const f = await fixture("sequence"), encoded = await retainedEncode(f), input = { ...f.input, selection: { jobId: f.plan.job.jobId, outputId: f.output.id, representation: "encoded-video" as const } };
    await writeFile(join(encoded.directory,"video.framehash"), "changed pixel evidence");
    await expect(admitStudioSpatialAsset(input)).rejects.toThrow();
    const image = await fixture(); await writeFile(join(image.jobRoot,"outputs",image.outputs[0]!.path), "changed original");
    await expect(admitStudioSpatialAsset(image.input)).rejects.toThrow();
    const native = await f.input.service.inspect(f.plan.job.jobId);
    await expect(admitStudioSpatialAsset({ ...f.input, service: { inspect: async () => ({ ...native, receipt: { ...native.receipt, sha256: "f".repeat(64) } }) } })).rejects.toThrow();
    expect(f.calls() + image.calls()).toBe(0);
  });
  test("rehashed encode metadata cannot substitute another source closure", async () => {
    const f = await fixture("sequence"), encoded = await retainedEncode(f);
    encoded.document.request.frames[0]!.sha256 = "f".repeat(64);
    encoded.document.requestSha256 = hash(encoded.document.request);
    const directory = join(f.jobRoot,"derivatives",encoded.document.requestSha256);
    await rename(encoded.directory,directory);
    await writeFile(join(directory,"receipt.json"),studioJson(encoded.document));
    await expect(admitStudioSpatialAsset({ ...f.input, selection: { jobId: f.plan.job.jobId, outputId: f.output.id, representation: "encoded-video" } })).rejects.toThrow("native sources");
    expect(f.calls()).toBe(0);
  });
  test("rechecks retained native identity and cancellation at publication", async () => {
    const f = await fixture(), native = await f.input.service.inspect(f.plan.job.jobId); let inspections = 0;
    await expect(admitStudioSpatialAsset({ ...f.input, service: { inspect: async () => ++inspections === 1 ? native : { ...native, receipt: { ...native.receipt, sha256: "e".repeat(64) } } } })).rejects.toThrow("provenance changed");
    await expect(admitStudioSpatialAsset({ ...f.input, signal: AbortSignal.abort() })).rejects.toThrow("cancelled");
    const controller = new AbortController();
    await expect(admitStudioSpatialAsset({ ...f.input, signal: controller.signal, beforePublication: async () => { controller.abort(); } })).rejects.toThrow("cancelled");
    expect(f.calls()).toBe(0);
  });
});
