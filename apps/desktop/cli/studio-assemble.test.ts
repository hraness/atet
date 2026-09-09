import { afterEach, describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planStudioJob, studioSourceBundleSha256 } from "../../../src/studio";
import type { ApplicationContext } from "../application/context";
import { ensurePhysicalPrivateDirectoryWithin } from "./paths";
import { assembleStudioJob } from "./studio-assemble";
import { BunProcessRunner } from "./io";
import { VideoProjectV1Schema } from "../contracts";
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
  const root = await realpath(await mkdtemp(join(tmpdir(), "atet-studio-encode-"))); roots.push(root);
  const privateRoot = await ensurePhysicalPrivateDirectoryWithin(root, "private");
  const jobRoot = await ensurePhysicalPrivateDirectoryWithin(privateRoot, "studio/jobs/studio_encode_fixture");
  const sourceRoot = await ensurePhysicalPrivateDirectoryWithin(jobRoot, "source"), outputRoot = await ensurePhysicalPrivateDirectoryWithin(jobRoot, "outputs");
  const sourceText = "# Retained fixture source; encoder must never execute it.\n";
  await writeFile(join(sourceRoot, "scene.py"), sourceText);
  const bundle = { kind: "atet.studio-source-bundle", schemaVersion: 1, engine: "blender", entrypoint: { kind: "python", path: "scene.py" }, files: [{ path: "scene.py", bytes: Buffer.byteLength(sourceText), sha256: studioBytesSha256(sourceText) }] };
  const job = { kind: "atet.studio-job", schemaVersion: 1, jobId: "studio_encode_fixture", bundleSha256: studioSourceBundleSha256(bundle), stage: "render", parameters: {}, render,
    engine: { engine: "blender", renderer: "cycles", device: "cpu", samples: 1, transparent: alpha, viewTransform: "Standard", denoise: false, seed: 0 },
    outputs: [{ kind: "sequence", id: "beauty", role: "beauty", format: "png", pathPattern: "frame_%06d.png", interpretation: { kind: "raster", semantic: "color", colorSpace: "srgb", alpha: alpha ? "straight" : "opaque", dataType: depth === 16 ? "uint16" : "uint8", channels: alpha ? ["R", "G", "B", "A"] : ["R", "G", "B"], unit: "unitless" } }],
    limits: { timeoutSeconds: 30, maximumOutputBytes: 1_048_576, maximumOutputFiles: 2 }, execution: { trust: "trusted-current-user", isolation: "none", hermetic: false } };
  const sha = "d".repeat(64), runtime = { kind: "atet.studio-runtime", schemaVersion: 1, engine: "blender", tool: { name: "Blender", version: "fixture", executableSha256: sha }, driverSha256: sha,
    environment: { fingerprintSha256: sha, evidence: "observed-package-environment", hermetic: false }, capabilities: ["python-authoring", "render", "image-sequence"].map(name => ({ name, support: "available", evidence: "probe" })) };
  const plan = planStudioJob({ bundle, job, runtime });
  const frames = [];
  for (let frame = render.startFrame; frame < render.endFrameExclusive; frame++) {
    const data = png(alpha, depth, frame), path = `frame_${String(frame).padStart(6, "0")}.png`;
    await writeFile(join(outputRoot, path), data); frames.push({ outputId: "beauty", path, frame, sha256: studioBytesSha256(data), bytes: data.length, role: "beauty", format: "png" });
  }
  const document = { kind: "atet.studio-receipt", schemaVersion: 1, jobId: job.jobId, attemptId: "attempt_fixture", planSha256: plan.planSha256, bundleSha256: plan.bundleSha256, jobSha256: plan.jobSha256,
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
    runner: options.native ? new BunProcessRunner() : { run: async argv => { calls.push([...argv]); return { exitCode: 0, stderr: "", stdout: JSON.stringify({ format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "0.084000", start_time: "0.000000" }, streams: [{ index: 0, codec_type: "video", codec_name: "h264", pix_fmt: "gbrp", width: 4, height: 2, avg_frame_rate: "24000/1001", r_frame_rate: "24000/1001", time_base: "1/24000", start_time: "0.000000", duration: "0.083417", color_transfer: "iec61966-2-1", color_primaries: "bt709", color_space: "gbr", color_range: "pc" }], frames: [0,1001].map(pts => ({ media_type: "video", stream_index: 0, width: 4, height: 2, pix_fmt: "gbrp", best_effort_timestamp: pts, duration: 1001 })) }) }; } },
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
    await writeFile(argv.at(-1)!, oversized ? Buffer.alloc(1_048_577) : "0000ftypisom0000verified-video-fixture"); return finished();
  } };
  const input = { application, service, jobId: job.jobId, outputId: "beauty", signal: new AbortController().signal, beforePublication: fence, ...(options.native ? {} : { process }) };
  return { root, jobRoot, outputRoot, input, calls, corrupt: () => { corrupt = true; }, fail: () => { fail = true; }, unknown: () => { unknown = true; }, oversized: () => { oversized = true; } };
}

describe("native studio ordinary project assembly", () => {
  test("uses observed rounded container duration while cutting exact fractional video time, and reuses replay", async () => {
    const f = await fixture(), input = { ...f.input, title: "A retained native scene" };
    const first = await assembleStudioJob(input), second = await assembleStudioJob(input);
    expect(second).toEqual(first);
    expect(first.kind).toBe("atet.studio-assembly");
    expect(first.clip.sha256).toBe(first.encoded.artifact.sha256);
    const project = VideoProjectV1Schema.parse(JSON.parse(await readFile(join(f.root, first.projectPath), "utf8")));
    expect(project.assets).toHaveLength(1);
    expect(project.placements).toHaveLength(1);
    expect(project.timeline.durationUs).toBe(83416);
    expect(first.clip.facts!.durationSeconds).toBe(0.084);
    expect(project.name).toBe("A retained native scene");
    expect(f.calls.filter(argv => argv.includes("-n"))).toHaveLength(1);
    expect(f.calls.every(argv => !argv.some(arg => arg.includes("http")))).toBe(true);
  });
  test("does not overwrite a subsequently edited ordinary project", async () => {
    const f = await fixture(), first = await assembleStudioJob(f.input), path = join(f.root, first.projectPath);
    const edited = { ...JSON.parse(await readFile(path, "utf8")), name: "Later authored edit" };
    await writeFile(path, studioJson(edited));
    await expect(assembleStudioJob(f.input)).rejects.toThrow();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(edited);
    expect(f.calls.filter(argv => argv.includes("-n"))).toHaveLength(1);
  });
  test("rejects unsupported transparent assembly before any encode or project publication", async () => {
    const f = await fixture({ alpha: true });
    await expect(assembleStudioJob(f.input)).rejects.toThrow("opaque sRGB");
    expect(f.calls).toHaveLength(0);
  });
  test("checks exact output selection, safe job ID, and cancellation before effects", async () => {
    const f = await fixture();
    await expect(assembleStudioJob({ ...f.input, outputId: "unknown" })).rejects.toThrow("opaque sRGB");
    await expect(assembleStudioJob({ ...f.input, jobId: "../../elsewhere" })).rejects.toThrow("Invalid studio job");
    await expect(assembleStudioJob({ ...f.input, signal: AbortSignal.abort() })).rejects.toThrow("cancelled");
    await expect(assembleStudioJob({ ...f.input, beforePublication: async () => { throw new Error("Publication revoked"); } })).rejects.toThrow("Publication revoked");
    const controller = new AbortController();
    await expect(assembleStudioJob({ ...f.input, signal: controller.signal, beforePublication: async () => { controller.abort(); } })).rejects.toThrow("cancelled");
    expect(f.calls).toHaveLength(0);
  });
});

test.skipIf(process.env.ATET_STUDIO_ENCODE_NATIVE !== "1")("native NTSC sequence assembles using actual container coverage and exact video cut", async () => {
  const f = await fixture({ native: true });
  const first = await assembleStudioJob(f.input), second = await assembleStudioJob(f.input);
  expect(second).toEqual(first);
  const project = VideoProjectV1Schema.parse(JSON.parse(await readFile(join(f.root, first.projectPath), "utf8")));
  expect(project.timeline.durationUs).toBe(83416);
  // Native muxer versions may preserve track precision or round the movie header.
  // The portable regression above forces the rounded case; both cut by video PTS.
  expect(first.clip.facts!.durationSeconds).toBeGreaterThanOrEqual(0.083417);
  expect(first.clip.facts!.durationSeconds).toBeLessThanOrEqual(0.084417);
}, 30_000);
