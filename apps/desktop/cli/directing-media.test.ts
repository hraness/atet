import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import sharp from "sharp";

import type { ApplicationContext } from "../application/context";
import { GatewayMediaSourceReferenceSchema, type GatewayMediaSourceReference } from "../application/gateway-port";
import { VideoProjectV1Schema } from "../contracts";
import { canonicalJson, sha256Hex } from "../core/canonical-json";
import { compileProjectRenderPlan } from "../core/project-render-plan";
import { createNodeBundleFileSystem, loadProjectEditPlan } from "../core/storage";
import { assembleDirectingClips, extractDirectingEndpoint, importDirectingAnchor } from "./directing-media";
import { executeAtomicRender } from "./atomic-render";
import { BunProcessRunner, type ProcessRunner } from "./io";
import { buildProjectFfmpegInvocation, reverifyProjectRenderInputs } from "./project-renderer";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const signal = () => new AbortController().signal;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const probeFixture = () => ({
  format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "1.000000", start_time: "0.000000" },
  streams: [{ index: 0, codec_type: "video", codec_name: "h264", duration: "1.000000", start_time: "0.000000", avg_frame_rate: "4/1", r_frame_rate: "4/1", width: 16, height: 12,
    pix_fmt: "yuv420p", time_base: "1/1000", color_transfer: "bt709", color_primaries: "bt709", color_space: "bt709" }],
  frames: [0, 100, 500, 900].map(value => ({ media_type: "video", stream_index: 0, width: 16, height: 12, best_effort_timestamp: value, duration: 100 })),
});
const rgbProbeFixture = () => {
  const probe = probeFixture();
  Object.assign(probe.streams[0]!, { pix_fmt: "gbrp", color_transfer: "iec61966-2-1", color_space: "gbr", color_range: "pc" });
  return probe;
};
async function fixture(options: { probe?: ReturnType<typeof probeFixture>; run?: ProcessRunner["run"] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "slopcamera-directing-media-")); roots.push(root);
  // Resolve macOS /var's canonical parent before constructing repository-relative paths.
  const { realpath } = await import("node:fs/promises");
  const repositoryRoot = await realpath(root), calls: readonly string[][] = [];
  const image = await sharp({ create: { width: 16, height: 12, channels: 3, background: "#2050dd" } }).png().toBuffer();
  const runner: ProcessRunner = { run: async (argv, runOptions) => {
    (calls as string[][]).push([...argv]);
    if (options.run !== undefined) return await options.run(argv, runOptions);
    if (argv[0] === "ffprobe") return { exitCode: 0, stdout: JSON.stringify(options.probe ?? probeFixture()), stderr: "" };
    await writeFile(argv.at(-1)!, image);
    const value = (options.probe ?? probeFixture()).frames[argv.some(arg => arg.includes("n\\,3")) ? 3 : 0]!.best_effort_timestamp;
    return { exitCode: 0, stdout: "", stderr: `[Parsed_showinfo_1 @ fixture] config in time_base: 1/1000, frame_rate: 4/1\n[Parsed_showinfo_1 @ fixture] n: 0 pts: ${value} pts_time: ${value / 1000}\n` };
  } };
  const application: ApplicationContext = {
    paths: { repositoryRoot, desktopRoot: repositoryRoot, artifactRoot: join(repositoryRoot, "artifacts/slopcamera/recordings"), privateRoot: join(repositoryRoot, "artifacts/slopcamera/private"), projectRoot: join(repositoryRoot, "artifacts/slopcamera/projects") },
    clock: { now: () => new Date("2026-09-09T00:00:00Z"), timestampMilliseconds: () => Date.parse("2026-09-09T00:00:00Z") },
    capability: async name => ({ name, available: true, command: name, version: `${name} fixture` }), capabilities: async () => [], runner,
  };
  const bytes = Buffer.from("0000ftypisom0000000000000000");
  const path = join(repositoryRoot, "source.mp4"); await writeFile(path, bytes);
  const source = GatewayMediaSourceReferenceSchema.parse({ path: "source.mp4", mediaType: "video/mp4", bytes: bytes.length, sha256: digest(bytes) });
  return { root: repositoryRoot, application, calls, source, image };
}
async function normalizationFixture(change?: (probe: ReturnType<typeof rgbProbeFixture>) => void, replaceOutput = false) {
  const derivative = Buffer.from("0000ftypisom-normalized-lossless-rgb");
  const original = probeFixture(), normalized = rgbProbeFixture();
  original.format.duration = "1.200000"; normalized.format.duration = "1.200000";
  change?.(normalized);
  const withAudio = (probe: ReturnType<typeof probeFixture>) => ({ ...probe, streams: [...probe.streams,
    { index: 1, codec_type: "audio", codec_name: "aac", start_time: "0.100000", duration: "1.100000", channels: 2, sample_rate: "48000", time_base: "1/48000" },
  ] });
  let decoderOutput = "";
  const f = await fixture({ run: async argv => {
    if (argv[0] === "ffprobe") {
      const isDerivative = (await readFile(argv.at(-1)!)).equals(derivative);
      if (isDerivative && replaceOutput) {
        await writeFile(`${decoderOutput}.replacement`, "Unrelated replacement output");
        await rename(`${decoderOutput}.replacement`, decoderOutput);
      }
      return { exitCode: 0, stderr: "", stdout: JSON.stringify(withAudio(isDerivative ? normalized : original)) };
    }
    expect(argv).toContain("libx264rgb"); expect(argv).toContain("-copyts");
    decoderOutput = argv.at(-1)!;
    await writeFile(argv.at(-1)!, derivative);
    return { exitCode: 0, stderr: "", stdout: "" };
  } });
  return { ...f, decoderOutput: () => decoderOutput };
}
async function interruptedAssemblyFixture() {
  const f = await normalizationFixture();
  const mediaRoot = join(f.root, "artifacts/slopcamera/generated/directing-media");
  const application: ApplicationContext = { ...f.application, hostResourceLease: {
    claims: [], inheritedFileDescriptor: -1, inheritedFileDescriptors: [], profile: { id: "unit-interrupt", capacities: [] }, ticket: "1",
    assertOwned: async () => {
      let entries: string[];
      try { entries = await readdir(mediaRoot); }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return; throw error; }
      if (entries.some(name => name.endsWith(".intent.json"))) throw new Error("Interrupted after intent publication");
    },
  } };
  const input = { id: "recover", title: "Recover accepted selection", recipeSha256: "a".repeat(64), clips: [{ shotId: "one", attemptId: "one", source: f.source, durationUs: 1_200_000 }] };
  await expect(assembleDirectingClips(application, input, signal())).rejects.toThrow("Interrupted after intent publication");
  const intentPath = join(mediaRoot, (await readdir(mediaRoot)).find(name => name.endsWith(".intent.json"))!);
  const intent = JSON.parse(await readFile(intentPath, "utf8")) as { project: ReturnType<typeof VideoProjectV1Schema.parse>; timing: { projectRange: { startUs: number; endUs: number } }[]; normalizations: { path: string }[] };
  const assertNoProject = async () => {
    await expect(readFile(join(f.application.paths.projectRoot, intent.project.projectId, "project.json"), "utf8")).rejects.toThrow("ENOENT");
    await expect(readFile(intentPath.replace(".intent.json", ".json"), "utf8")).rejects.toThrow("ENOENT");
  };
  await assertNoProject();
  return { ...f, input, intentPath, intent, assertNoProject };
}

describe("retained directing media", () => {
  test("selects actual last VFR PTS and reuses the verified retained endpoint", async () => {
    const f = await fixture();
    const endpoint = await extractDirectingEndpoint(f.application, f.source, "last", signal());
    expect(endpoint.frameIndex).toBe(3);
    expect(endpoint.pts).toEqual({ value: "900", timeBaseNumerator: 1, timeBaseDenominator: 1000 });
    expect(endpoint.timeUs).toBe(900_000);
    expect(endpoint.source.facts).toEqual({ durationSeconds: 1, width: 16, height: 12 });
    expect(endpoint.image.facts).toEqual({ width: 16, height: 12 });
    expect(f.calls[1]).toContain("select=eq(n\\,3),showinfo,colorspace=ispace=bt709:itrc=bt709:iprimaries=bt709:irange=tv:space=bt709:trc=iec61966-2-1:primaries=bt709:range=pc:format=yuv444p,format=rgb24");
    expect(f.calls[1]).toContain("-copyts");
    expect(f.calls[1]).toContain("-protocol_whitelist");
    expect(await extractDirectingEndpoint(f.application, f.source, "last", signal())).toEqual(endpoint);
    expect(f.calls).toHaveLength(2);
    await writeFile(join(f.root, endpoint.image.path), Buffer.alloc(endpoint.image.bytes));
    await expect(extractDirectingEndpoint(f.application, f.source, "last", signal())).rejects.toThrow("SHA-256");
  });
  test("first frame is the first decoded index", async () => {
    const f = await fixture();
    expect((await extractDirectingEndpoint(f.application, f.source, "first", signal())).pts.value).toBe("0");
  });
  test("publishes retained video larger than the immutable copier chunk", async () => {
    const f = await fixture(), bytes = Buffer.allocUnsafe(2 * 1024 * 1024);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 73 + Math.floor(index / 65536)) & 255;
    Buffer.from("0000ftypisom").copy(bytes);
    await writeFile(join(f.root, f.source.path), bytes);
    const source = { ...f.source, bytes: bytes.length, sha256: digest(bytes) };
    expect((await extractDirectingEndpoint(f.application, source, "first", signal())).source.sha256).toBe(source.sha256);
  });
  test.each([2000, -100])("retains the native %s PTS origin separately from duration", async start => {
    const probe = probeFixture();
    probe.format.start_time = String(start / 1000); probe.streams[0]!.start_time = String(start / 1000);
    for (const frame of probe.frames) frame.best_effort_timestamp += start;
    const f = await fixture({ probe }), endpoint = await extractDirectingEndpoint(f.application, f.source, "first", signal());
    expect(endpoint.pts.value).toBe(String(start)); expect(endpoint.timeUs).toBe(start * 1000);
    expect(endpoint.source.facts?.durationSeconds).toBe(1);
  });
  test("rejects an extracted PTS that does not match the probe", async () => {
    const f = await fixture({ run: async argv => {
      if (argv[0] === "ffprobe") return { exitCode: 0, stdout: JSON.stringify(probeFixture()), stderr: "" };
      await writeFile(argv.at(-1)!, "wrong endpoint");
      return { exitCode: 0, stdout: "", stderr: "[Parsed_showinfo_1] config in time_base: 1/1000\n[Parsed_showinfo_1] n: 0 pts: 500" };
    } });
    await expect(extractDirectingEndpoint(f.application, f.source, "last", signal())).rejects.toThrow("exact probed");
  });
  test.each(["throw", "exit", "abort"])("cleans the settled decoder's partial file after %s", async mode => {
    const abort = new AbortController();
    const f = await fixture({ run: async argv => {
      if (argv[0] === "ffprobe") return { exitCode: 0, stdout: JSON.stringify(probeFixture()), stderr: "" };
      await writeFile(argv.at(-1)!, "partial PNG");
      if (mode === "throw") throw new Error("Decoder stopped after writing");
      if (mode === "abort") abort.abort();
      return { exitCode: mode === "exit" ? 1 : 0, stdout: "", stderr: "interrupted" };
    } });
    await expect(extractDirectingEndpoint(f.application, f.source, "last", abort.signal)).rejects.toThrow();
    const entries = await readdir(join(f.root, "artifacts/slopcamera/generated/directing-media"));
    expect(entries.some(entry => entry.startsWith(".endpoint-"))).toBe(false);
    expect(entries.some(entry => entry.endsWith(".json"))).toBe(false);
  });
  test("does not publish a PNG whose header decodes but pixel data is truncated", async () => {
    const good = await sharp({ create: { width: 16, height: 12, channels: 3, background: "blue" } }).png().toBuffer();
    const broken = good.subarray(0, good.length - 24);
    expect((await sharp(broken).metadata()).width).toBe(16);
    const f = await fixture({ run: async argv => {
      if (argv[0] === "ffprobe") return { exitCode: 0, stdout: JSON.stringify(probeFixture()), stderr: "" };
      await writeFile(argv.at(-1)!, broken);
      return { exitCode: 0, stdout: "", stderr: "[Parsed_showinfo_1] config in time_base: 1/1000\n[Parsed_showinfo_1] n: 0 pts: 900" };
    } });
    await expect(extractDirectingEndpoint(f.application, f.source, "last", signal())).rejects.toThrow();
    const entries = await readdir(join(f.root, "artifacts/slopcamera/generated/directing-media"));
    expect(entries.some(entry => entry.endsWith(".png") || entry.endsWith(".json"))).toBe(false);
  });
  test.skipIf(process.platform === "win32")("preserves primary failure and refuses cleanup of a substituted decoder output", async () => {
    let substituted = "";
    const f = await fixture({ run: async argv => {
      if (argv[0] === "ffprobe") return { exitCode: 0, stdout: JSON.stringify(probeFixture()), stderr: "" };
      substituted = argv.at(-1)!;
      await symlink(argv[argv.indexOf("-i") + 1]!, substituted);
      throw new Error("Decoder primary failure");
    } });
    try {
      await extractDirectingEndpoint(f.application, f.source, "last", signal());
      throw new Error("Expected decoder failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors.map(value => (value as Error).message)).toEqual([
        "Decoder primary failure", "Directing temporary file changed identity; retained for inspection.",
      ]);
    }
    const { lstat } = await import("node:fs/promises");
    expect((await lstat(substituted)).isSymbolicLink()).toBe(true);
  });
  test("retains the explicit SDR interpretation when 8-bit YUV color tags are missing", async () => {
    const probe = probeFixture();
    probe.streams[0]!.color_transfer = "unknown"; probe.streams[0]!.color_primaries = "unknown"; probe.streams[0]!.color_space = "unknown";
    const f = await fixture({ probe });
    await extractDirectingEndpoint(f.application, f.source, "last", signal());
    const mediaRoot = join(f.root, "artifacts/slopcamera/generated/directing-media");
    const receiptPath = (await readdir(mediaRoot)).find(path => path.startsWith("endpoint-") && path.endsWith(".json"))!;
    const receipt = JSON.parse(await readFile(join(mediaRoot, receiptPath), "utf8")) as { color: { policy: string; assumptions: string[]; observed: { pixelFormat: string } } };
    expect(receipt.color.policy).toBe("untagged-8bit-yuv-assume-bt709-v1");
    expect(receipt.color.assumptions).toEqual(["bt709-transfer", "bt709-primaries", "bt709-matrix", "limited-range"]);
    expect(receipt.color.observed.pixelFormat).toBe("yuv420p");
  });
  test.each(["hdr", "hdr-side-data", "10bit", "conflicting-matrix", "frame-range", "inverted", "dimension", "dynamic-dimension", "duration", "coverage"])("rejects unqualified %s source before extraction", async kind => {
    const probe = probeFixture();
    if (kind === "hdr") probe.streams[0]!.color_transfer = "smpte2084";
    if (kind === "hdr-side-data") Object.assign(probe.streams[0]!, { side_data_list: [{ side_data_type: "Mastering display metadata" }] });
    if (kind === "10bit") probe.streams[0]!.pix_fmt = "yuv420p10le";
    if (kind === "conflicting-matrix") probe.streams[0]!.color_space = "bt2020nc";
    if (kind === "frame-range") Object.assign(probe.frames[1]!, { color_range: "pc" });
    if (kind === "inverted") probe.frames[2]!.best_effort_timestamp = 0;
    if (kind === "dimension") probe.streams[0]!.width = 8192;
    if (kind === "dynamic-dimension") probe.frames[2]!.width = 32;
    if (kind === "duration") { probe.format.duration = "61"; probe.streams[0]!.duration = "61"; }
    if (kind === "coverage") probe.frames[3]!.duration = 200;
    const f = await fixture({ probe });
    await expect(extractDirectingEndpoint(f.application, f.source, "last", signal())).rejects.toThrow();
    expect(f.calls).toHaveLength(1);
  });
  test("verifies input before any native work and honors pre-dispatch cancellation", async () => {
    const f = await fixture();
    const abort = new AbortController(); abort.abort();
    await expect(extractDirectingEndpoint(f.application, f.source, "first", abort.signal)).rejects.toThrow("cancelled");
    await writeFile(join(f.root, f.source.path), Buffer.alloc(f.source.bytes));
    await expect(extractDirectingEndpoint(f.application, f.source, "first", signal())).rejects.toThrow("SHA-256");
    expect(f.calls).toHaveLength(0);
  });
  test("rejects a private decoder source changed by a subprocess", async () => {
    const f = await fixture({ run: async argv => {
      const source = await readFile(argv.at(-1)!);
      await writeFile(argv.at(-1)!, Buffer.alloc(source.length));
      return { exitCode: 0, stdout: JSON.stringify(probeFixture()), stderr: "" };
    } });
    await expect(extractDirectingEndpoint(f.application, f.source, "last", signal())).rejects.toThrow("SHA-256");
    expect(f.calls).toHaveLength(1);
  });
  test.skipIf(process.platform === "win32")("retains exactly one explicit image and rejects symlinks", async () => {
    const f = await fixture(); await writeFile(join(f.root, "anchor.png"), f.image);
    const reference = await importDirectingAnchor(f.application, "anchor.png", signal());
    expect(reference.sha256).toBe(digest(f.image));
    expect(reference.facts).toEqual({ width: 16, height: 12 });
    expect(await importDirectingAnchor(f.application, "anchor.png", signal())).toEqual(reference);
    await symlink(join(f.root, "anchor.png"), join(f.root, "link.png"));
    await expect(importDirectingAnchor(f.application, "link.png", signal())).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  });
  test("assembles accepted clips at exact ordered boundaries and preserves its initial receipt", async () => {
    const f = await fixture({ probe: rgbProbeFixture() });
    const input = { id: "directing_example", title: "Two directed shots", recipeSha256: "a".repeat(64), clips: [
      { shotId: "shot_one", attemptId: "attempt_one", source: f.source, durationUs: 1_000_000 },
      { shotId: "shot_two", attemptId: "attempt_two", source: f.source, durationUs: 1_000_000 },
    ] };
    const output = await assembleDirectingClips(f.application, input, signal());
    const project = VideoProjectV1Schema.parse(JSON.parse(await readFile(join(f.root, output.projectPath), "utf8")));
    expect(project.timeline.durationUs).toBe(2_000_000); expect(project.assets).toHaveLength(1);
    expect(project.placements.map(placement => placement.sync.anchors)).toEqual([
      [{ assetTimeUs: 0, projectTimeUs: 0 }, { assetTimeUs: 1_000_000, projectTimeUs: 1_000_000 }],
      [{ assetTimeUs: 0, projectTimeUs: 1_000_000 }, { assetTimeUs: 1_000_000, projectTimeUs: 2_000_000 }],
    ]);
    expect(project.placements.every(placement => placement.sync.provenance.kind === "manual")).toBe(true);
    expect(await assembleDirectingClips(f.application, input, signal())).toEqual(output);
    expect(f.calls).toHaveLength(4);
    const changed = { ...input, clips: [...input.clips].reverse() };
    expect((await assembleDirectingClips(f.application, changed, signal())).projectId).not.toBe(output.projectId);
    await writeFile(join(f.root, output.projectPath), `${JSON.stringify({ ...project, name: "User edit" })}\n`);
    await expect(assembleDirectingClips(f.application, input, signal())).rejects.toThrow("changed");
  });
  test("rejects requested durations that would silently cut or stretch the accepted clip", async () => {
    const f = await fixture();
    await expect(assembleDirectingClips(f.application, { id: "one", title: "One", recipeSha256: "b".repeat(64), clips: [{ shotId: "one", attemptId: "one", source: f.source, durationUs: 500_000 }] }, signal())).rejects.toThrow("duration differs");
  });
  test("rederives interrupted assembly with the retained timestamp and no new encode", async () => {
    const f = await interruptedAssemblyFixture();
    const later: ApplicationContext = { ...f.application, clock: { now: () => new Date("2026-09-10T12:00:00Z"), timestampMilliseconds: () => Date.parse("2026-09-10T12:00:00Z") } };
    const output = await assembleDirectingClips(later, f.input, signal());
    const project = VideoProjectV1Schema.parse(JSON.parse(await readFile(join(f.root, output.projectPath), "utf8")));
    expect(project).toEqual(f.intent.project);
    expect(project.createdAt).toBe("2026-09-09T00:00:00.000Z");
    expect(f.calls.filter(argv => argv[0] === "ffmpeg")).toHaveLength(1);
    expect(await assembleDirectingClips(later, f.input, signal())).toEqual(output);
  });
  test.each(["opacity", "timing"])("rejects %s tampering in an interrupted intent before publishing a project", async field => {
    const f = await interruptedAssemblyFixture();
    if (field === "opacity") {
      const presentation = f.intent.project.placements[0]!.video[0]!.presentation;
      if (!presentation.enabled) throw new Error("Fixture video must be enabled");
      presentation.opacity = 0;
    }
    else f.intent.timing[0]!.projectRange.endUs += 1;
    await writeFile(f.intentPath, `${JSON.stringify(f.intent)}\n`);
    await expect(assembleDirectingClips(f.application, f.input, signal())).rejects.toThrow("verified canonical derivation");
    await f.assertNoProject();
    expect(f.calls.filter(argv => argv[0] === "ffmpeg")).toHaveLength(1);
  });
  test.each(["missing-receipt", "changed-toolchain"])("refuses interrupted recovery with %s before any re-encode", async mode => {
    const f = await interruptedAssemblyFixture();
    let application = f.application;
    if (mode === "missing-receipt") await rm(join(f.root, f.intent.normalizations[0]!.path));
    else application = { ...f.application, capability: async name => ({ name, available: true, command: name, version: `${name} changed fixture` }) };
    await expect(assembleDirectingClips(application, f.input, signal())).rejects.toThrow("recovery cannot re-encode");
    await f.assertNoProject();
    expect(f.calls.filter(argv => argv[0] === "ffmpeg")).toHaveLength(1);
  });
  test("retains an sRGB lossless derivative and color receipt for ordinary assembly", async () => {
    const f = await normalizationFixture();
    const input = { id: "rgb", title: "Color interpreted clip", recipeSha256: "b".repeat(64), clips: [{ shotId: "one", attemptId: "one", source: f.source, durationUs: 1_200_000 }] };
    const output = await assembleDirectingClips(f.application, input, signal());
    const project = VideoProjectV1Schema.parse(JSON.parse(await readFile(join(f.root, output.projectPath), "utf8")));
    const segment = project.assets[0]!.streams[0]!.segments[0]!;
    expect(segment.sha256).not.toBe(f.source.sha256);
    const receipt = JSON.parse(await readFile(join(f.root, output.receipt.path), "utf8")) as { normalizations: { path: string; sha256: string }[] };
    expect(receipt.normalizations).toHaveLength(1);
    const normalizationBytes = await readFile(join(f.root, receipt.normalizations[0]!.path));
    expect(digest(normalizationBytes)).toBe(receipt.normalizations[0]!.sha256);
    const normalization = JSON.parse(normalizationBytes.toString()) as { input: GatewayMediaSourceReference; output: GatewayMediaSourceReference; codec: string };
    expect(normalization.input.sha256).toBe(f.source.sha256); expect(normalization.output.sha256).toBe(segment.sha256);
    expect(normalization.codec).toBe("libx264rgb-lossless-v1");
    expect(await assembleDirectingClips(f.application, input, signal())).toEqual(output);
    expect(f.calls.filter(argv => argv[0] === "ffmpeg")).toHaveLength(1);
    expect((await readdir(join(f.root, "artifacts/slopcamera/generated/directing-media"))).some(name => name.startsWith(".rgb-"))).toBe(false);
  });
  test.each(["timestamp", "final-duration", "frame-hdr", "frame-range", "alpha"]) ("rejects a normalized derivative with changed %s before project publication", async kind => {
    const f = await normalizationFixture(probe => {
      if (kind === "timestamp") probe.frames[1]!.best_effort_timestamp += 1;
      if (kind === "final-duration") { probe.frames[3]!.duration = 200; probe.streams[0]!.duration = "1.100000"; }
      if (kind === "frame-hdr") Object.assign(probe.frames[1]!, { color_transfer: "smpte2084" });
      if (kind === "frame-range") Object.assign(probe.frames[1]!, { color_range: "tv" });
      if (kind === "alpha") probe.streams[0]!.pix_fmt = "rgba";
    });
    await expect(assembleDirectingClips(f.application, { id: "bad-rgb", title: "Invalid derivative", recipeSha256: "b".repeat(64), clips: [{ shotId: "one", attemptId: "one", source: f.source, durationUs: 1_200_000 }] }, signal())).rejects.toThrow();
    expect((await readdir(join(f.root, "artifacts/slopcamera/generated/directing-media"))).some(name => name.startsWith(".rgb-") || name.startsWith("assembly-") && name.endsWith(".json"))).toBe(false);
  });
  test("retains a substituted regular native output and preserves the primary validation failure", async () => {
    const f = await normalizationFixture(probe => { probe.frames[1]!.best_effort_timestamp += 1; }, true);
    try {
      await assembleDirectingClips(f.application, { id: "replaced-rgb", title: "Replaced decoder output", recipeSha256: "b".repeat(64), clips: [{ shotId: "one", attemptId: "one", source: f.source, durationUs: 1_200_000 }] }, signal());
      throw new Error("Expected normalization failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).errors.map(value => (value as Error).message)).toEqual([
        "Lossless RGB derivative changed a native presentation timestamp.", "Directing temporary file changed identity; retained for inspection.",
      ]);
    }
    expect(await readFile(f.decoderOutput(), "utf8")).toBe("Unrelated replacement output");
  });
  test("cleans a partial normalization output after its native runner throws", async () => {
    const f = await fixture({ run: async argv => {
      if (argv[0] === "ffprobe") return { exitCode: 0, stderr: "", stdout: JSON.stringify(probeFixture()) };
      await writeFile(argv.at(-1)!, "Partial lossless output");
      throw new Error("Normalization native failure");
    } });
    await expect(assembleDirectingClips(f.application, { id: "partial-rgb", title: "Interrupted normalization", recipeSha256: "b".repeat(64), clips: [{ shotId: "one", attemptId: "one", source: f.source, durationUs: 1_000_000 }] }, signal())).rejects.toThrow("Normalization native failure");
    expect((await readdir(join(f.root, "artifacts/slopcamera/generated/directing-media"))).some(name => name.startsWith(".rgb-"))).toBe(false);
  });
  test("keeps accepted clip audio in the same authored project clock", async () => {
    const probe = rgbProbeFixture();
    const f = await fixture({ run: async () => ({ exitCode: 0, stderr: "", stdout: JSON.stringify({ ...probe, streams: [...probe.streams,
      { index: 1, codec_type: "audio", codec_name: "aac", start_time: "0", duration: "1", channels: 2, sample_rate: "48000", time_base: "1/48000" },
    ] }) }) });
    const result = await assembleDirectingClips(f.application, { id: "audio", title: "Directed audio", recipeSha256: "c".repeat(64), clips: [
      { shotId: "one", attemptId: "one", source: f.source, durationUs: 1_000_000 }, { shotId: "two", attemptId: "two", source: f.source, durationUs: 1_000_000 },
    ] }, signal());
    const project = VideoProjectV1Schema.parse(JSON.parse(await readFile(join(f.root, result.projectPath), "utf8")));
    expect(project.assets[0]!.streams.map(stream => stream.kind)).toEqual(["video", "audio"]);
    expect(project.placements.map(placement => placement.audio[0]!.presentation)).toEqual([{ enabled: true, gainDb: 0, pan: 0 }, { enabled: true, gainDb: 0, pan: 0 }]);
    const fs = createNodeBundleFileSystem(join(f.application.paths.projectRoot, result.projectId));
    const plan = compileProjectRenderPlan(project, await loadProjectEditPlan(fs), { pixelWidth: 16, pixelHeight: 12, frameRate: 4 });
    expect(plan.audioSlices).toHaveLength(2); expect(plan.warnings).toHaveLength(0);
  });
  test("versions video-clock cuts, floors cumulative rational boundaries, and receipts trimmed audio", async () => {
    const probe = rgbProbeFixture();
    Object.assign(probe.streams[0]!, { duration: "1.166667", time_base: "1/24000", avg_frame_rate: "24/1", r_frame_rate: "24/1" });
    probe.frames = Array.from({ length: 28 }, (_, index) => ({ media_type: "video", stream_index: 0, width: 16, height: 12, best_effort_timestamp: index * 1000, duration: 1000 }));
    probe.format.duration = "1.300000";
    const f = await fixture({ run: async () => ({ exitCode: 0, stderr: "", stdout: JSON.stringify({ ...probe, streams: [...probe.streams,
      { index: 1, codec_type: "audio", codec_name: "aac", start_time: "0", duration: "1.3", channels: 1, sample_rate: "32000", time_base: "1/32000" },
    ] }) }) });
    const input = { id: "video-clock", title: "Video-clock cuts", recipeSha256: "d".repeat(64), clips: ["one", "two", "three"].map(id => ({ shotId: id, attemptId: id, source: f.source, durationUs: 1_300_000 })) };
    const oldDigest = sha256Hex(canonicalJson({ kind: "slopcamera.directing-assembly", schemaVersion: 1, colorPolicy: "sdr-rgb-assembly-v1", input }));
    const oldProject = join(f.application.paths.projectRoot, `project_directing_${oldDigest.slice(0, 40)}`);
    await mkdir(oldProject, { recursive: true }); await writeFile(join(oldProject, "project.json"), "Retained V1 evidence");
    const output = await assembleDirectingClips(f.application, input, signal());
    const project = VideoProjectV1Schema.parse(JSON.parse(await readFile(join(f.root, output.projectPath), "utf8")));
    expect(project.timeline.durationUs).toBe(3_500_000);
    expect(project.placements.map(placement => placement.sync.anchors)).toEqual([
      [{ assetTimeUs: 0, projectTimeUs: 0 }, { assetTimeUs: 1_166_667, projectTimeUs: 1_166_666 }],
      [{ assetTimeUs: 0, projectTimeUs: 1_166_666 }, { assetTimeUs: 1_166_667, projectTimeUs: 2_333_333 }],
      [{ assetTimeUs: 0, projectTimeUs: 2_333_333 }, { assetTimeUs: 1_166_667, projectTimeUs: 3_500_000 }],
    ]);
    expect(project.assets[0]!.durationUs).toBe(1_300_000);
    expect(await readFile(join(oldProject, "project.json"), "utf8")).toBe("Retained V1 evidence");
    const receipt = JSON.parse(await readFile(join(f.root, output.receipt.path), "utf8")) as { schemaVersion: number; timingPolicy: string; timing: { sourceDurationUs: number; audio: { trimmedAfterUs: number; selectedAssetRange: { startUs: number; endUs: number } }[] }[] };
    expect(receipt.schemaVersion).toBe(2); expect(receipt.timingPolicy).toBe("video-span-floor-cumulative-v1");
    expect(receipt.timing.every(row => row.sourceDurationUs === 1_300_000 && row.audio[0]!.trimmedAfterUs === 133_333 && row.audio[0]!.selectedAssetRange.endUs === 1_166_667)).toBe(true);
    expect(await assembleDirectingClips(f.application, input, signal())).toEqual(output);
  });
});

test.skipIf(process.env.SLOPCAMERA_DIRECTING_MEDIA_NATIVE !== "1")("native sparse VFR endpoint pixels and accepted project render", async () => {
  const f = await fixture(), runner = new BunProcessRunner(), ffmpeg = "/opt/homebrew/bin/ffmpeg", ffprobe = "/opt/homebrew/bin/ffprobe";
  const application: ApplicationContext = { ...f.application, runner, capability: async name => ({ name, available: true, command: name === "ffmpeg" ? ffmpeg : ffprobe, version: `${name} native qualification` }) };
  const path = join(f.root, "native.mp4");
  const made = await runner.run([ffmpeg, "-v", "error", "-nostdin", "-f", "lavfi", "-i", "color=red:s=64x48:r=24:d=1", "-vf", "drawbox=color=blue:t=fill:enable='gte(t,0.5)',drawbox=x=16:y=16:w=16:h=16:color=0x808080:t=fill,select='eq(n,0)+eq(n,1)+eq(n,5)+eq(n,20)'", "-fps_mode", "vfr", "-an", "-c:v", "libx264", "-bf", "0", "-pix_fmt", "yuv420p", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-n", path], { timeoutMs: 30_000 });
  expect(made.exitCode).toBe(0);
  const bytes = await readFile(path), source: GatewayMediaSourceReference = { path: relative(f.root, path), bytes: bytes.length, sha256: digest(bytes), mediaType: "video/mp4" };
  const first = await extractDirectingEndpoint(application, source, "first", signal()), last = await extractDirectingEndpoint(application, source, "last", signal());
  expect(first.frameIndex).toBe(0); expect(last.frameIndex).toBe(3); expect(last.timeUs).toBe(833_333);
  for (const [endpoint, color] of [[first, "red"], [last, "blue"]] as const) {
    const { data, info } = await sharp(join(f.root, endpoint.image.path)).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(64); expect(info.height).toBe(48);
    expect(color === "red" ? data[0]! > data[2]! + 100 : data[2]! > data[0]! + 100).toBe(true);
  }
  const durationUs = Math.round(last.source.facts!.durationSeconds! * 1_000_000);
  const output = await assembleDirectingClips(application, { id: "native", title: "Native directed cuts", recipeSha256: "e".repeat(64), clips: [
    { shotId: "one", attemptId: "one", source: last.source, durationUs }, { shotId: "two", attemptId: "two", source: last.source, durationUs },
  ] }, signal());
  const project = VideoProjectV1Schema.parse(JSON.parse(await readFile(join(f.root, output.projectPath), "utf8")));
  const derivativeSegment = project.assets[0]!.streams[0]!.segments[0]!;
  const derivative = GatewayMediaSourceReferenceSchema.parse({ path: derivativeSegment.path, sha256: derivativeSegment.sha256, bytes: derivativeSegment.bytes, mediaType: "video/mp4" });
  expect(derivative.sha256).not.toBe(source.sha256);
  for (const [position, originalEndpoint] of [["first", first], ["last", last]] as const) {
    const endpoint = await extractDirectingEndpoint(application, derivative, position, signal());
    const originalPixels = await sharp(join(f.root, originalEndpoint.image.path)).raw().toBuffer();
    const derivativePixels = await sharp(join(f.root, endpoint.image.path)).raw().toBuffer();
    expect(derivativePixels.equals(originalPixels)).toBe(true);
  }
  const projectDirectory = join(application.paths.projectRoot, output.projectId), fs = createNodeBundleFileSystem(projectDirectory), plan = compileProjectRenderPlan(project, await loadProjectEditPlan(fs), { pixelWidth: 64, pixelHeight: 48, frameRate: 24 });
  expect(plan.warnings).toHaveLength(0);
  await mkdir(join(projectDirectory, "renders"));
  const finalOutputPath = join(projectDirectory, "renders/qualified.mp4"), built = await buildProjectFfmpegInvocation(plan, { ffmpeg, ffprobe, outputPath: finalOutputPath, projectDirectory, repositoryRoot: f.root, runner });
  const rendered = await executeAtomicRender({ argv: built.argv, finalOutputPath, failureLabel: "Directing qualification render", maximumOutputBytes: 1024 * 1024, runner, requireFreshOutput: true, beforePublish: async () => await reverifyProjectRenderInputs(built.pinnedInputs) });
  expect(rendered.bytes).toBeGreaterThan(1000);
  const renderedImage = join(f.root, "rendered-first.png");
  const decoded = await runner.run([ffmpeg, "-v", "error", "-i", finalOutputPath, "-frames:v", "1", "-vf", "format=rgb24", "-n", renderedImage], { timeoutMs: 30_000 });
  expect(decoded.exitCode).toBe(0);
  const renderedPixels = await sharp(renderedImage).raw().toBuffer(), referencePixels = await sharp(join(f.root, first.image.path)).raw().toBuffer();
  for (const pixel of [0, (24 * 64 + 24) * 3]) {
    expect(Math.max(...[0, 1, 2].map(channel => Math.abs(renderedPixels[pixel + channel]! - referencePixels[pixel + channel]!)))).toBeLessThanOrEqual(8);
  }
}, 60_000);

test.skipIf(process.env.SLOPCAMERA_DIRECTING_MEDIA_NATIVE !== "1")("native video-clock cuts remove multi-frame AAC tails without a black CFR join", async () => {
  const f = await fixture(), runner = new BunProcessRunner(), ffmpeg = "/opt/homebrew/bin/ffmpeg", ffprobe = "/opt/homebrew/bin/ffprobe";
  const application: ApplicationContext = { ...f.application, runner, capability: async name => ({ name, available: true, command: name === "ffmpeg" ? ffmpeg : ffprobe, version: `${name} native qualification` }) };
  const clips: { shotId: string; attemptId: string; source: GatewayMediaSourceReference; durationUs: number }[] = [];
  for (const [index, color] of ["red", "blue"].entries()) {
    const path = join(f.root, `${color}.mp4`);
    const made = await runner.run([ffmpeg, "-v", "error", "-nostdin", "-f", "lavfi", "-i", `color=${color}:s=64x48:r=24:d=1.16`, "-f", "lavfi", "-i", `sine=frequency=${440 + index * 440}:sample_rate=32000:duration=1.3`, "-c:v", "libx264", "-bf", "0", "-pix_fmt", "yuv420p", "-color_range", "tv", "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-c:a", "aac", "-b:a", "64k", "-n", path], { timeoutMs: 30_000 });
    expect(made.exitCode).toBe(0);
    const bytes = await readFile(path), source: GatewayMediaSourceReference = { path: relative(f.root, path), bytes: bytes.length, sha256: digest(bytes), mediaType: "video/mp4" };
    const endpoint = await extractDirectingEndpoint(application, source, "last", signal());
    expect(endpoint.frameIndex).toBe(27); expect(endpoint.timeUs).toBe(1_125_000);
    expect(endpoint.source.facts!.durationSeconds!).toBeGreaterThan(28 / 24 + 1 / 24);
    clips.push({ shotId: color, attemptId: color, source: endpoint.source, durationUs: Math.round(endpoint.source.facts!.durationSeconds! * 1_000_000) });
  }
  const output = await assembleDirectingClips(application, { id: "native-video-clock", title: "Video-clock join", recipeSha256: "f".repeat(64), clips }, signal());
  const project = VideoProjectV1Schema.parse(JSON.parse(await readFile(join(f.root, output.projectPath), "utf8")));
  expect(project.timeline.durationUs).toBe(2_333_333);
  expect(project.placements[1]!.sync.anchors[0]!.projectTimeUs).toBe(1_166_666);
  const projectDirectory = join(application.paths.projectRoot, output.projectId), fs = createNodeBundleFileSystem(projectDirectory);
  const plan = compileProjectRenderPlan(project, await loadProjectEditPlan(fs), { pixelWidth: 64, pixelHeight: 48, frameRate: 24 });
  expect(plan.warnings).toHaveLength(0); expect(plan.audioSlices).toHaveLength(2);
  expect(plan.audioSlices.map(slice => slice.assetRange.endUs)).toEqual([1_166_667, 1_166_667]);
  expect(plan.audioSlices.map(slice => slice.outputRange)).toEqual([{ startUs: 0, endUs: 1_166_666 }, { startUs: 1_166_666, endUs: 2_333_333 }]);
  await mkdir(join(projectDirectory, "renders"));
  const finalOutputPath = join(projectDirectory, "renders/qualified.mp4"), built = await buildProjectFfmpegInvocation(plan, { ffmpeg, ffprobe, outputPath: finalOutputPath, projectDirectory, repositoryRoot: f.root, runner });
  await executeAtomicRender({ argv: built.argv, finalOutputPath, failureLabel: "Video-clock qualification render", maximumOutputBytes: 1024 * 1024, runner, requireFreshOutput: true, beforePublish: async () => await reverifyProjectRenderInputs(built.pinnedInputs) });
  const inspected = await runner.run([ffprobe, "-v", "error", "-count_frames", "-show_entries", "stream=codec_type,duration,nb_read_frames", "-of", "json", finalOutputPath], { timeoutMs: 30_000 });
  expect(inspected.exitCode).toBe(0);
  const streams = (JSON.parse(inspected.stdout) as { streams: { codec_type: string; duration: string; nb_read_frames: string }[] }).streams;
  expect(Number(streams.find(stream => stream.codec_type === "video")!.nb_read_frames)).toBe(56);
  expect(Math.abs(Number(streams.find(stream => stream.codec_type === "audio")!.duration) - 56 / 24)).toBeLessThan(0.001);
  const rawPath = join(f.root, "all-rendered-frames.rgb");
  const decoded = await runner.run([ffmpeg, "-v", "error", "-i", finalOutputPath, "-map", "0:v:0", "-pix_fmt", "rgb24", "-fps_mode", "passthrough", "-f", "rawvideo", "-n", rawPath], { timeoutMs: 30_000 });
  expect(decoded.exitCode).toBe(0);
  const raw = await readFile(rawPath), frameBytes = 64 * 48 * 3;
  expect(raw.length).toBe(frameBytes * 56);
  for (let frame = 0; frame < 56; frame += 1) {
    const pixel = frame * frameBytes + (24 * 64 + 32) * 3;
    expect(Math.max(raw[pixel]!, raw[pixel + 1]!, raw[pixel + 2]!)).toBeGreaterThan(150);
    expect(frame < 28 ? raw[pixel]! > raw[pixel + 2]! + 100 : raw[pixel + 2]! > raw[pixel]! + 100).toBe(true);
  }
  for (const clip of clips) expect(digest(await readFile(join(f.root, clip.source.path)))).toBe(clip.source.sha256);
}, 60_000);
