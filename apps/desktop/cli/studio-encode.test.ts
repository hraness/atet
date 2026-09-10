import { afterEach, describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { planStudioJob, studioSourceBundleSha256 } from "../../../src/studio";
import type { ApplicationContext } from "../application/context";
import { StudioRunOutputSchema } from "../application/studio-port";
import { createNodeBundleFileSystem } from "../core/storage";
import { ensurePhysicalPrivateDirectoryWithin } from "./paths";
import { encodeStudioSequence, verifyStudioFramehash } from "./studio-encode";
import { studioBytesSha256, studioJson } from "./studio-files";
import { type StudioProcessPort, type StudioProcessResult } from "./studio-process";
import { createStudioService } from "./studio-service";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const fence = async () => {};
const finished = (stdout = ""): StudioProcessResult => ({ custody: "closed", exitCode: 0, stdout, stderr: "" });
const render = { width: 4, height: 2, frameRate: { numerator: 24000, denominator: 1001 }, startFrame: 7, endFrameExclusive: 9 };
function framehash(alpha = false, changed = false) {
  return `#format: frame checksums\n#version: 2\n#hash: SHA256\n#tb 0: 1001/24000\n#dimensions 0: 4x2\n0, 0, 0, 1, ${8 * (alpha ? 4 : 3)}, ${"a".repeat(64)}\n0, 1, 1, 1, ${8 * (alpha ? 4 : 3)}, ${(changed ? "c" : "b").repeat(64)}\n`;
}
function png(alpha: boolean, depth: 8 | 16, frame: number): Buffer {
  const crc = (data: Buffer) => { let value = 0xffffffff; for (const byte of data) { value ^= byte; for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0); } return (value ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const header = Buffer.alloc(4), checksum = Buffer.alloc(4), content = Buffer.concat([Buffer.from(type), data]); header.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(content)); return Buffer.concat([header, content, checksum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(render.width, 0); header.writeUInt32BE(render.height, 4); header[8] = depth; header[9] = alpha ? 6 : 2;
  const channels = alpha ? 4 : 3, stride = render.width * channels * depth / 8 + 1, pixels = Buffer.alloc(stride * render.height);
  for (let y = 0; y < render.height; y++) for (let x = 0; x < render.width; x++) for (let c = 0; c < channels; c++) {
    const value = c === 3 ? 30 + x * 60 : (x * 41 + y * 23 + c * 67 + frame * 53) % 256;
    const offset = y * stride + 1 + (x * channels + c) * depth / 8;
    if (depth === 16) pixels.writeUInt16BE(value * 257 + (value < 255 ? 17 : 0), offset); else pixels[offset] = value;
  }
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

async function fixture(options: { alpha?: boolean; depth?: 8 | 16; native?: boolean } = {}) {
  const alpha = options.alpha ?? false, depth = options.depth ?? 8;
  const root = await realpath(await mkdtemp(join(tmpdir(), "slopcamera-studio-encode-"))); roots.push(root);
  const privateRoot = await ensurePhysicalPrivateDirectoryWithin(root, "private");
  const jobRoot = await ensurePhysicalPrivateDirectoryWithin(privateRoot, "studio/jobs/studio_encode_fixture");
  const sourceRoot = await ensurePhysicalPrivateDirectoryWithin(jobRoot, "source"), outputRoot = await ensurePhysicalPrivateDirectoryWithin(jobRoot, "outputs");
  const sourceText = "# Retained fixture source; encoder must never execute it.\n";
  await writeFile(join(sourceRoot, "scene.py"), sourceText);
  const bundle = { kind: "slopcamera.studio-source-bundle", schemaVersion: 1, engine: "blender", entrypoint: { kind: "python", path: "scene.py" }, files: [{ path: "scene.py", bytes: Buffer.byteLength(sourceText), sha256: studioBytesSha256(sourceText) }] };
  const job = { kind: "slopcamera.studio-job", schemaVersion: 1, jobId: "studio_encode_fixture", bundleSha256: studioSourceBundleSha256(bundle), stage: "render", parameters: {}, render,
    engine: { engine: "blender", renderer: "cycles", device: "cpu", samples: 1, transparent: alpha, viewTransform: "Standard", denoise: false, seed: 0 },
    outputs: [{ kind: "sequence", id: "beauty", role: "beauty", format: "png", pathPattern: "frame_%06d.png", interpretation: { kind: "raster", semantic: "color", colorSpace: "srgb", alpha: alpha ? "straight" : "opaque", dataType: depth === 16 ? "uint16" : "uint8", channels: alpha ? ["R", "G", "B", "A"] : ["R", "G", "B"], unit: "unitless" } }],
    limits: { timeoutSeconds: 30, maximumOutputBytes: 1_048_576, maximumOutputFiles: 2 }, execution: { trust: "trusted-current-user", isolation: "none", hermetic: false } };
  const sha = "d".repeat(64), runtime = { kind: "slopcamera.studio-runtime", schemaVersion: 1, engine: "blender", tool: { name: "Blender", version: "fixture", executableSha256: sha }, driverSha256: sha,
    environment: { fingerprintSha256: sha, evidence: "observed-package-environment", hermetic: false }, capabilities: ["python-authoring", "render", "image-sequence"].map(name => ({ name, support: "available", evidence: "probe" })) };
  const plan = planStudioJob({ bundle, job, runtime });
  const frames = [];
  for (let frame = render.startFrame; frame < render.endFrameExclusive; frame++) {
    const data = png(alpha, depth, frame), path = `frame_${String(frame).padStart(6, "0")}.png`;
    await writeFile(join(outputRoot, path), data); frames.push({ outputId: "beauty", path, frame, sha256: studioBytesSha256(data), bytes: data.length, role: "beauty", format: "png" });
  }
  const document = { kind: "slopcamera.studio-receipt", schemaVersion: 1, jobId: job.jobId, attemptId: "attempt_fixture", planSha256: plan.planSha256, bundleSha256: plan.bundleSha256, jobSha256: plan.jobSha256,
    runtime: plan.runtime, runtimeSha256: plan.runtimeSha256, startedAt: "2026-09-09T00:00:00Z", finishedAt: "2026-09-09T00:00:01Z", state: "succeeded", custody: "closed", exitCode: 0, outputs: frames };
  await writeFile(join(jobRoot, "plan.json"), studioJson(plan)); await writeFile(join(jobRoot, "receipt.json"), studioJson(document));
  const fakeExe = join(root, "tool"); await writeFile(fakeExe, "#!/bin/sh\nexit 0\n"); await chmod(fakeExe, 0o700);
  const application: ApplicationContext = {
    paths: { repositoryRoot: root, desktopRoot: root, privateRoot, artifactRoot: join(root, "recordings"), projectRoot: join(root, "projects") },
    machineStateRoot: await ensurePhysicalPrivateDirectoryWithin(root, "machine"),
    hostResourceLease: { claims: [{ resource: "cpu", amount: 1 }, { resource: "video-encode", amount: 1 }], inheritedFileDescriptors: [], inheritedFileDescriptor: -1,
      profile: { id: "studio-encode-fixture", capacities: [{ resource: "cpu", limit: 1 }, { resource: "video-encode", limit: 1 }] }, ticket: "studio-encode-fixture", assertOwned: fence },
    clock: { now: () => new Date(), timestampMilliseconds: () => Date.now() }, capabilities: async () => [],
    capability: async name => ({ name, available: true, command: options.native ? `/opt/homebrew/bin/${name}` : fakeExe, version: options.native ? "native-qualification" : "fixture" }),
    runner: { run: async () => { throw new Error("Unsupervised runner forbidden."); } },
  };
  const service = createStudioService({ application, selection: { threads: 1 } });
  const calls: string[][] = [];
  let corrupt = false, fail = false, unknown = false, oversized = false;
  const process: StudioProcessPort = { run: async (argv, processOptions) => {
    calls.push([...argv]); await processOptions.onSpawn?.(12345); await processOptions.assertBudget?.();
    expect(processOptions.inheritedFileDescriptors).toEqual(application.hostResourceLease!.inheritedFileDescriptors);
    expect(processOptions.env).not.toHaveProperty("AI_GATEWAY_API_KEY");
    if (argv.includes("-count_frames")) return finished(JSON.stringify({ streams: [{ codec_type: "video", codec_name: alpha ? "qtrle" : "h264", pix_fmt: alpha ? "argb" : "gbrp", width: render.width, height: render.height, avg_frame_rate: "24000/1001", time_base: "1/24000", start_pts: 0, duration_ts: 2002, nb_read_frames: "2", color_range: "pc", color_space: "gbr", color_transfer: "iec61966-2-1", color_primaries: "bt709" }] }));
    if (argv.includes("framehash")) return finished(framehash(alpha, corrupt && !argv.includes("-framerate")));
    if (fail) return { ...finished(), exitCode: 1, failure: "timeout" };
    if (unknown) return { ...finished(), exitCode: null, custody: "unknown", failure: "descendants" };
    await writeFile(argv.at(-1)!, oversized ? Buffer.alloc(1_048_577) : "verified video fixture"); return finished();
  } };
  const input = { application, service, jobId: job.jobId, outputId: "beauty", signal: new AbortController().signal, beforePublication: fence, ...(options.native ? {} : { process }) };
  return { root, jobRoot, outputRoot, input, calls, corrupt: () => { corrupt = true; }, fail: () => { fail = true; }, unknown: () => { unknown = true; }, oversized: () => { oversized = true; } };
}

describe("retained studio sequence encoding", () => {
  test("checks every canonical frame, exact cadence, dimensions, and byte count", () => {
    const expected = verifyStudioFramehash(framehash(), render, false);
    expect(expected).toHaveLength(64);
    for (const text of [framehash().replace("0, 1, 1,", "0, 2, 2,"), framehash().replace("1001/24000", "1/24"), framehash().replace("1001/24000", "0/0"), framehash().replace("4x2", "2x4"), framehash().replace(", 24,", ", 23,"), framehash().split("\n").slice(0, -2).join("\n")]) expect(() => verifyStudioFramehash(text, render, false)).toThrow();
    expect(verifyStudioFramehash(framehash(false, true), render, false)).not.toBe(expected);
  });
  test("retains a derivative and revalidates completed replay without another encode", async () => {
    const f = await fixture(), first = await encodeStudioSequence(f.input), second = await encodeStudioSequence(f.input);
    expect(second).toEqual(first);
    expect(first.document.request.limits.maximumOutputBytes).toBe(1_048_576);
    expect(first.document.verification.frameCount).toBe(2);
    expect(f.calls.filter(argv => argv.includes("-n"))).toHaveLength(1);
    expect(f.calls.filter(argv => argv.includes("framehash"))).toHaveLength(4);
    expect(first.artifact.path).toContain("/derivatives/");
    expect((await f.input.service.inspect(f.input.jobId)).document.outputs).toHaveLength(2);
  });
  test("rejects changed decoded pixels on completed replay", async () => {
    const f = await fixture(); const first = await encodeStudioSequence(f.input); f.corrupt();
    await expect(encodeStudioSequence(f.input)).rejects.toThrow("pixels differ");
    expect(f.calls.filter(argv => argv.includes("-n"))).toHaveLength(1);
    expect(await readFile(join(f.root, first.receipt.path), "utf8")).toBe(studioJson(first.document));
  });
  test("does not publish a receipt for changed pixels or an oversized first derivative", async () => {
    for (const mode of ["corrupt", "oversized"] as const) {
      const f = await fixture(); f[mode]();
      await expect(encodeStudioSequence(f.input)).rejects.toThrow();
      const video = f.calls.find(argv => argv.includes("-n"))!.at(-1)!;
      await expect(readFile(join(video, "../receipt.json"))).rejects.toThrow();
      expect(f.calls.filter(argv => argv.includes("-n"))).toHaveLength(1);
    }
  });
  test("preserves unknown machine custody after a native descendant cannot be closed", async () => {
    const f = await fixture(); f.unknown();
    await expect(encodeStudioSequence(f.input)).rejects.toThrow("process failed");
    const activity = JSON.parse(await readFile(join(f.input.application.machineStateRoot!, "studio-native/activity.json"), "utf8"));
    expect(activity.state).toBe("unknown");
    await expect(encodeStudioSequence(f.input)).rejects.toThrow("cannot authorize another encode");
    expect(f.calls.filter(argv => argv.includes("-n"))).toHaveLength(1);
  });
  test("does not retry an interrupted encode or invent a completed receipt", async () => {
    const f = await fixture(); f.fail();
    await expect(encodeStudioSequence(f.input)).rejects.toThrow("process failed");
    await expect(encodeStudioSequence(f.input)).rejects.toThrow("cannot authorize another encode");
    expect(f.calls.filter(argv => argv.includes("-n"))).toHaveLength(1);
  });
  test("rederives an interrupted intent and verifies an existing video before recovery", async () => {
    const f = await fixture(), first = await encodeStudioSequence(f.input);
    await rm(join(f.root, first.receipt.path));
    expect(await encodeStudioSequence(f.input)).toEqual(first);
    expect(f.calls.filter(argv => argv.includes("-n"))).toHaveLength(1);
    const intent = join(f.root, first.receipt.path.replace(/receipt.json$/u, "intent.json"));
    await writeFile(intent, (await readFile(intent, "utf8")).replace("rgb8-lossless", "other-lossless"));
    await expect(encodeStudioSequence(f.input)).rejects.toThrow("intent differs");
  });
  test("rejects source tamper and unavailable host admission before native work", async () => {
    const f = await fixture();
    const { hostResourceLease: _lease, ...application } = f.input.application;
    await expect(encodeStudioSequence({ ...f.input, application })).rejects.toThrow("admitted host");
    await writeFile(join(f.outputRoot, "frame_000007.png"), png(false, 8, 99));
    await expect(encodeStudioSequence(f.input)).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
  test("records straight alpha and explicit 16-bit reduction while preserving PNG originals", async () => {
    const f = await fixture({ alpha: true, depth: 16 }), result = await encodeStudioSequence(f.input);
    expect(result.artifact.path).toEndWith(".mov");
    expect(result.document.request.conversion).toBe("ffmpeg-no-dither-uint16-to-uint8-v1");
    expect(result.document.request.profile).toBe("rgba8-lossless-qtrle-v1");
    expect((await readFile(join(f.outputRoot, "frame_000007.png")))[24]).toBe(16);
  });
  test("checks exact retained receipt references even when a host port is injected", async () => {
    const f = await fixture(), original = await f.input.service.inspect(f.input.jobId);
    const service = { inspect: async () => StudioRunOutputSchema.parse({ ...original, receipt: { ...original.receipt, path: "elsewhere.json" } }) };
    await expect(encodeStudioSequence({ ...f.input, service })).rejects.toThrow("receipt identity");
    expect(f.calls).toHaveLength(0);
  });
});

const native = process.env.SLOPCAMERA_STUDIO_ENCODE_NATIVE === "1";
describe.skipIf(!native)("native studio encode qualification", () => {
  for (const alpha of [false, true]) for (const depth of [8, 16] as const) test(`${alpha ? "RGBA" : "RGB"}${depth}: two PNGs retain exact quantized pixels and rational timing`, async () => {
    const f = await fixture({ alpha, depth, native: true });
    const original = await f.input.service.inspect(f.input.jobId);
    const result = await encodeStudioSequence(f.input).catch((error: unknown) => { if (error instanceof Error && "details" in error) throw new Error(`${error.message} ${JSON.stringify(error.details)}`); throw error; });
    expect(result.document.verification.frameCount).toBe(2);
    expect(result.artifact.bytes).toBeGreaterThan(0);
    expect(await f.input.service.inspect(f.input.jobId)).toEqual(original);
    expect(await encodeStudioSequence(f.input)).toEqual(result);
    const fs = createNodeBundleFileSystem(f.root);
    expect(await fs.inspectFile!(relative(f.root, join(f.root, result.artifact.path)), 1_048_576)).toEqual({ sha256: result.artifact.sha256, bytes: result.artifact.bytes });
  }, 30_000);
});
