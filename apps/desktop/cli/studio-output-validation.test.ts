import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStudioJob, type StudioOutputArtifact } from "../../../src/studio";
import type { ApplicationContext } from "../application/context";
import { studioBytesSha256, studioJson } from "./studio-files";
import { validateStudioOutputMedia } from "./studio-output-validation";
import { NativeStudioProcess, studioChildEnvironment, type StudioProcessPort, type StudioProcessResult } from "./studio-process";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const finished = (value: unknown): StudioProcessResult => ({ custody: "closed", exitCode: 0, stdout: JSON.stringify(value), stderr: "" });

function report(options: { format?: string; rate?: { numerator: number; denominator: number }; base?: number; count?: number } = {}) {
  const rate = options.rate ?? { numerator: 24, denominator: 1 }, base = options.base ?? 24000, count = options.count ?? 4;
  return {
    format: { format_name: options.format ?? "mov,mp4,m4a,3gp,3g2,mj2" },
    streams: [{ codec_type: "video", codec_name: "h264", width: 16, height: 16, pix_fmt: "gbrp", avg_frame_rate: `${rate.numerator}/${rate.denominator}`, nb_read_frames: String(count), time_base: `1/${base}` }],
    frames: Array.from({ length: count }, (_, index) => ({ best_effort_timestamp: Math.round(index * base * rate.denominator / rate.numerator),
      pkt_duration: Math.round((index + 1) * base * rate.denominator / rate.numerator) - Math.round(index * base * rate.denominator / rate.numerator), width: 16, height: 16, pix_fmt: "gbrp" })),
  };
}

async function fixture(options: { format?: "mp4" | "mov" | "webm" | "exr" | "wav" | "usd" | "py"; count?: number; rate?: { numerator: number; denominator: number }; root?: string; native?: boolean;
  dataType?: "uint8" | "uint16" | "float32"; channels?: readonly string[]; alpha?: boolean } = {}) {
  const root = options.root ?? await realpath(await mkdtemp(join(tmpdir(), "atet-studio-output-")));
  if (options.root === undefined) roots.push(root);
  await mkdir(root, { recursive: true });
  const tool = join(root, "tool"); await writeFile(tool, "#!/bin/sh\nexit 0\n"); await chmod(tool, 0o700);
  const format = options.format ?? "mp4", rate = options.rate ?? { numerator: 24, denominator: 1 };
  const role = format === "wav" ? "audio" : format === "usd" ? "model" : format === "py" ? "native-source" : "beauty";
  const job = parseStudioJob({ kind: "atet.studio-job", schemaVersion: 1, jobId: "studio_output_fixture", bundleSha256: "a".repeat(64), stage: "render", parameters: {},
    engine: { engine: "manim", scene: "Fixture", renderer: "cairo", transparent: options.alpha ?? false },
    render: { width: 16, height: 16, frameRate: rate, startFrame: 7, endFrameExclusive: 7 + (options.count ?? 4) },
    outputs: [{ kind: "file", id: "beauty", role, format, path: `media.${format}`,
      interpretation: format === "wav" ? { kind: "audio", sampleRate: 8000, channels: 1 }
        : format === "usd" ? { kind: "model", sourceSpace: { units: "meters", upAxis: "y", handedness: "right" } }
          : format === "py" ? { kind: "native-source" }
        : { kind: "raster", semantic: "color", colorSpace: "srgb", alpha: options.alpha ? "straight" : "opaque", dataType: options.dataType ?? (format === "exr" ? "float32" : "uint8"), channels: options.channels ?? (options.alpha ? ["R", "G", "B", "A"] : ["R", "G", "B"]), unit: "unitless" } }],
    limits: { timeoutSeconds: 30, maximumOutputBytes: 1_048_576, maximumOutputFiles: 1 }, execution: { trust: "trusted-current-user", isolation: "none", hermetic: false } });
  const application: ApplicationContext = {
    paths: { repositoryRoot: root, desktopRoot: root, privateRoot: root, artifactRoot: root, projectRoot: root },
    clock: { now: () => new Date(), timestampMilliseconds: () => Date.now() }, capabilities: async () => [],
    capability: async name => ({ name, available: true, command: options.native ? "/opt/homebrew/bin/ffprobe" : tool, version: "fixture" }),
    runner: { run: async () => { throw new Error("Unexpected ordinary runner."); } },
  };
  let value: unknown = report({ rate, count: options.count ?? 4 }), result: StudioProcessResult | undefined;
  const calls: string[][] = [];
  const native = new NativeStudioProcess();
  const process: StudioProcessPort = options.native ? { run: async (argv, options) => {
    const result = await native.run(argv, options);
    if (argv[0].endsWith("ffprobe")) await writeFile(join(root, "probe.json"), studioJson({ argv, result }));
    return result;
  } } : { run: async argv => { calls.push([...argv]); return result ?? finished(value); } };
  const env = studioChildEnvironment(options.native ? "/opt/homebrew/bin/ffprobe" : tool, root, 1);
  const path = join(root, `media.${format}`);
  const run = async () => {
    const bytes = options.native || format === "usd" || format === "py" ? await readFile(path) : Buffer.from("retained fixture bytes");
    const outputs: readonly StudioOutputArtifact[] = [{ outputId: "beauty", path: `media.${format}`, format, role, bytes: bytes.length, sha256: studioBytesSha256(bytes) }];
    return await validateStudioOutputMedia({ application, process, root, job, outputs, signal: new AbortController().signal, cwd: root, env, fence: async () => {} });
  };
  return { root, path, job, calls, process, env, run, report: (input: unknown) => { value = input; }, result: (input: StudioProcessResult) => { result = input; } };
}

describe("studio decoded output boundaries", () => {
  test("pins the declared demuxer, local file protocol, MOV references and bounded report", async () => {
    const f = await fixture(); expect(await f.run()).toMatchObject([{ validation: "decoded-video", frameCount: 4 }]);
    const argv = f.calls[0]!;
    for (const [flag, value] of [["-protocol_whitelist", "file"], ["-format_whitelist", "mov"], ["-f", "mov"], ["-enable_drefs", "0"], ["-use_absolute_path", "0"], ["-max_pixels", "33554432"], ["-of", "json=compact=1"]]) expect(argv[argv.indexOf(flag!) + 1]).toBe(value);
    expect(argv).toContain("-show_frames");
    expect(argv[argv.indexOf("-show_entries") + 1]).toContain("frame_side_data=");
  });
  test("rejects an auto-detected playlist or another container behind a video extension", async () => {
    const f = await fixture(); f.report(report({ format: "hls" })); await expect(f.run()).rejects.toThrow("container");
    f.report(report({ format: "matroska,webm" })); await expect(f.run()).rejects.toThrow("container");
  });
  test("rejects VFR timestamps even when frame count and average FPS match", async () => {
    const f = await fixture(), value = report(); value.frames[1]!.best_effort_timestamp += 100;
    f.report(value); await expect(f.run()).rejects.toThrow("rational clock");
    const invalidRate = report(); invalidRate.streams[0]!.avg_frame_rate = "0/0";
    f.report(invalidRate); await expect(f.run()).rejects.toThrow("cadence");
  });
  test("requires zero origin, increasing timestamps and every decoded frame", async () => {
    const f = await fixture(); let value = report(); value.frames.forEach(frame => frame.best_effort_timestamp += 1);
    f.report(value); await expect(f.run()).rejects.toThrow("zero-based");
    value = report(); value.frames[1]!.best_effort_timestamp = 0;
    f.report(value); await expect(f.run()).rejects.toThrow("zero-based");
    value = report(); value.frames.pop(); f.report(value); await expect(f.run()).rejects.toThrow("every decoded timestamp");
  });
  test("accepts exact NTSC clocks and bounded per-frame container quantization", async () => {
    const rate = { numerator: 24000, denominator: 1001 }, f = await fixture({ rate });
    f.report(report({ rate })); await expect(f.run()).resolves.toMatchObject([{ frameCount: 4 }]);
    f.report(report({ rate, base: 1000 })); await expect(f.run()).resolves.toMatchObject([{ frameCount: 4 }]);
    const separatelyQuantized = report({ rate, base: 1000 });
    separatelyQuantized.frames.forEach(frame => { frame.pkt_duration = 41; });
    f.report(separatelyQuantized); await expect(f.run()).resolves.toMatchObject([{ frameCount: 4 }]);
  });
  test("checks last-frame duration, conflicting durations and changing decoded dimensions", async () => {
    const f = await fixture(); let value = report(); value.frames[3]!.pkt_duration *= 2;
    f.report(value); await expect(f.run()).rejects.toThrow("end boundary");
    value = report(); Object.assign(value.frames[3]!, { duration: 2000 });
    f.report(value); await expect(f.run()).rejects.toThrow("durations disagree");
    value = report(); value.frames[2]!.width = 32;
    f.report(value); await expect(f.run()).rejects.toThrow("fixed pixel profile");
    value = report(); delete (value.frames[3] as { pkt_duration?: number }).pkt_duration;
    f.report(value); await expect(f.run()).rejects.toThrow("final decoded frame duration");
  });
  test("does not accept decoder errors or unknown process custody", async () => {
    const f = await fixture(); f.result({ ...finished(report()), stderr: "invalid packet" });
    await expect(f.run()).rejects.toThrow("fully decode");
    f.result({ ...finished(report()), custody: "unknown" }); await expect(f.run()).rejects.toThrow("fully decode");
  });
  test("only verifies observed eight-bit video and declared RGB/RGBA channels", async () => {
    for (const dataType of ["uint16", "float32"] as const) await expect((await fixture({ dataType })).run()).rejects.toThrow("8-bit RGB/RGBA");
    await expect((await fixture({ channels: ["B", "G", "R"] })).run()).rejects.toThrow("8-bit RGB/RGBA");
    const f = await fixture();
    for (const pix_fmt of ["yuv420p10le", "rgb48le", "gbrpf32le"]) {
      const value = report(); value.streams[0]!.pix_fmt = pix_fmt; value.frames.forEach(frame => { frame.pix_fmt = pix_fmt; });
      f.report(value); await expect(f.run()).rejects.toThrow("8-bit RGB/RGBA");
    }
    const alpha = await fixture({ format: "mov", alpha: true }), value = report();
    value.streams[0]!.pix_fmt = "argb"; value.frames.forEach(frame => { frame.pix_fmt = "argb"; });
    alpha.report(value); await expect(alpha.run()).resolves.toMatchObject([{ validation: "decoded-video" }]);
  });
  test("generic USD checks either USD framing while Python remains inert source bytes", async () => {
    const usd = await fixture({ format: "usd" });
    await writeFile(usd.path, "not a USD document"); await expect(usd.run()).rejects.toThrow("format framing");
    for (const text of ["#usda 1.0\ndef Xform \"fixture\" {}\n", "PXR-USDC\0retained binary framing only"]) {
      await writeFile(usd.path, text); await expect(usd.run()).resolves.toMatchObject([{ validation: "format-header" }]);
    }
    const source = await fixture({ format: "py" }); await writeFile(source.path, "raise RuntimeError('never execute')\n");
    await expect(source.run()).resolves.toMatchObject([{ validation: "inert-source" }]);
    expect(source.calls).toEqual([]);
  });
});

const nativeTest = process.env.ATET_STUDIO_OUTPUT_NATIVE === "1" ? test : test.skip;
nativeTest("native declared containers and rational clocks qualify; renamed playlist stays inert", async () => {
  const root = join(process.cwd(), "artifacts", "atet", `studio-output-qualification-${Date.now()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const results = [];
  const cases = [
    { name: "mp4-rgb", format: "mp4", rate: { numerator: 24, denominator: 1 }, codec: "libx264rgb", pixels: "rgb24", alpha: false },
    { name: "mov-ntsc", format: "mov", rate: { numerator: 24000, denominator: 1001 }, codec: "libx264", pixels: "yuv420p", alpha: false },
    { name: "webm-ntsc", format: "webm", rate: { numerator: 24000, denominator: 1001 }, codec: "libvpx-vp9", pixels: "yuv420p", alpha: false },
    { name: "mov-qtrle-rgb", format: "mov", rate: { numerator: 24, denominator: 1 }, codec: "qtrle", pixels: "rgb24", alpha: false },
    { name: "mov-qtrle-alpha", format: "mov", rate: { numerator: 24, denominator: 1 }, codec: "qtrle", pixels: "argb", alpha: true },
  ] as const;
  for (const { name, format, rate, codec, pixels, alpha } of cases) {
    const f = await fixture({ root: join(root, name), format, rate, count: 8, native: true, alpha });
    const result = await f.process.run(["/opt/homebrew/bin/ffmpeg", "-v", "error", "-nostdin", "-threads", "1", "-f", "lavfi", "-i", `color=c=red@0.5:s=16x16:r=${rate.numerator}/${rate.denominator},format=rgba`, "-frames:v", "8", "-an", "-c:v", codec, "-pix_fmt", pixels, "-threads", "1", "-n", f.path], {
      cwd: f.root, env: f.env, timeoutMs: 30_000, maximumLogBytes: 1_048_576,
    });
    expect(result).toMatchObject({ exitCode: 0, custody: "closed" });
    const validation = await f.run(); results.push({ name, format, rate, bytes: (await readFile(f.path)).length, validation });
    expect(validation).toMatchObject([{ validation: "decoded-video", frameCount: 8 }]);
  }
  for (const format of ["wav", "exr"] as const) {
    const f = await fixture({ root: join(root, format), format, count: 1, native: true });
    const args = format === "wav" ? ["-f", "lavfi", "-i", "anullsrc=channel_layout=mono:sample_rate=8000", "-t", "0.1", "-c:a", "pcm_s16le"]
      : ["-f", "lavfi", "-i", "color=c=red:s=16x16:r=1", "-frames:v", "1", "-c:v", "exr", "-pix_fmt", "gbrpf32le", "-update", "1"];
    const generated = await f.process.run(["/opt/homebrew/bin/ffmpeg", "-v", "error", "-nostdin", "-threads", "1", ...args, "-threads", "1", "-n", f.path], {
      cwd: f.root, env: f.env, timeoutMs: 30_000, maximumLogBytes: 1_048_576,
    });
    expect(generated).toMatchObject({ exitCode: 0, custody: "closed" });
    const validation = await f.run(); results.push({ name: format, format, rate: { numerator: 24, denominator: 1 }, bytes: (await readFile(f.path)).length, validation });
    expect(validation).toMatchObject([{ validation: format === "wav" ? "decoded-audio" : "decoded-raster" }]);
  }
  const f = await fixture({ root: join(root, "playlist"), native: true });
  await writeFile(f.path, "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttps://example.invalid/never-request.mp4\n#EXT-X-ENDLIST\n");
  await expect(f.run()).rejects.toThrow("fully decode");
  await writeFile(join(root, "qualification.json"), studioJson({ kind: "atet.studio-output-validation-qualification", version: 1,
    validationSourceSha256: studioBytesSha256(await readFile(join(import.meta.dir, "studio-output-validation.ts"))), results, renamedPlaylistRejected: true }));
  console.log(`Studio output validation qualification: ${root}`);
}, 120_000);
