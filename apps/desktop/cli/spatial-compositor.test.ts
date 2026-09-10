import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectRenderPlanV1Schema, ResolvedProjectVideoSliceSchema } from "../contracts/project-render";
import { hashProjectRenderPlanComposition } from "../core/project-render-plan";
import { assertSpatialCompositorCadence, spatialCompositorCadenceSha256 } from "../core/spatial-compositor";
import { buildProjectFfmpegInvocation } from "./project-renderer";
import { verifySpatialCompositorProbe, verifySpatialCompositorOutput } from "./spatial-compositor-verifier";
import { spatialFrameCount } from "../../../src/spatial-scene/time";
import { buildMetadataClickSprite, buildMetadataCursorSprite } from "./renderer";
import { BunProcessRunner } from "./io";

function fixture(durationUs = 1_000_000, numerator = 30_000, denominator = 1_001) {
  const hash = "a".repeat(64);
  const plan = ProjectRenderPlanV1Schema.parse({ kind: "slopcamera.project-render-plan", schemaVersion: 1,
    planSha256: hash, projectEditPlanSha256: hash, projectStructureSha256: hash, projectId: "project_cadence01",
    output: { background: "#000000ff", durationUs, frameRate: numerator / denominator, pixelWidth: 16, pixelHeight: 16 },
    videoSlices: [], audioSlices: [], overlays: [], cameraKeyframes: [], cameraSegments: [], warnings: [],
    effects: { clickCues: [], clicks: { enabled: false }, cursor: { enabled: false }, cursorSamples: [], keystrokeCues: [], keystrokes: { enabled: false }, typedText: { enabled: false }, typingSpans: [] } });
  plan.planSha256 = hashProjectRenderPlanComposition(plan);
  const cadence = { kind: "slopcamera.spatial-compositor-cadence" as const, schemaVersion: 1 as const,
    projectionSha256: hash, compositionPlanSha256: plan.planSha256, frameRate: { numerator, denominator }, durationUs,
    frameCount: spatialFrameCount(durationUs, { numerator, denominator }) };
  return { plan, binding: assertSpatialCompositorCadence({ cadence, cadenceSha256: spatialCompositorCadenceSha256(cadence) }, plan) };
}
function probes(durationUs = 1_000_000, numerator = 30_000, denominator = 1_001) {
  const { binding } = fixture(durationUs, numerator, denominator);
  const count = binding.cadence.frameCount;
  return { cadence: binding, expectedVideo: { pixelWidth: 16, pixelHeight: 16, pixelFormat: "yuv420p" as const },
    video: { streams: [{ codec_type: "video", codec_name: "h264", width: 16, height: 16, pix_fmt: "yuv420p", time_base: `1/${numerator}`, start_pts: 0, duration_ts: count * denominator,
      avg_frame_rate: `${numerator}/${denominator}`, r_frame_rate: `${numerator}/${denominator}`, nb_frames: String(count), nb_read_frames: String(count) }],
      frames: Array.from({ length: count }, (_, index) => ({ best_effort_timestamp: index * denominator })) },
    audio: { streams: [{ codec_type: "audio", codec_name: "aac", time_base: "1/48000", sample_rate: "48000", start_pts: 0, duration_ts: Math.round(durationUs * .048) }] } };
}

test("rational emitters and endpoint trim are explicit while V1 invocation bytes stay stable", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "slopcamera-spatial-cadence-")));
  try {
    await mkdir(join(root, "renders"));
    const { plan, binding } = fixture();
    const options = { ffmpeg: "/usr/bin/ffmpeg", outputPath: join(root, "renders", "out.mp4"), projectDirectory: root, repositoryRoot: root };
    const legacy = await buildProjectFfmpegInvocation(plan, options);
    const exact = await buildProjectFfmpegInvocation(plan, { ...options, spatialCadence: binding });
    const legacyAgain = await buildProjectFfmpegInvocation(plan, options);
    expect(legacyAgain.invocation).toEqual(legacy.invocation);
    const graph = await readFile(exact.argv[exact.argv.indexOf("-filter_complex_script") + 1]!, "utf8");
    expect(graph).toContain("r=30000/1001");
    expect(graph).toContain("trim=end_frame=30,settb=expr=1001/30000,setpts=N");
    expect(exact.argv).toContain("-video_track_timescale");
    expect(exact.argv[exact.argv.indexOf("-movie_timescale") + 1]).toBe("1000000");
    expect(exact.argv[exact.argv.indexOf("-enc_time_base:v") + 1]).toBe("1001:30000");
    expect(exact.argv).not.toContain("-frames:v");
    expect(exact.argv).not.toContain("-t");
    expect(legacy.argv).toContain("-t");
    expect(legacy.argv).not.toContain("-r:v");
    expect(exact.invocation.renderPlanSha256).toBe(legacy.invocation.renderPlanSha256);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test("native timing oracle checks every integer PTS, rate, count, endpoints and full audio duration", () => {
  const input = probes();
  const verified = verifySpatialCompositorProbe(input);
  expect(verified.lastPts).toBe("29029");
  expect(verified.durationTs).toBe("30030");
  expect(verified.encodedVideoDurationUs).toEqual({ numerator: "1001000", denominator: "1" });
  expect(verified.video).toEqual(input.expectedVideo);
  for (const change of [
    { avg_frame_rate: "30/1" }, { r_frame_rate: "30/1" }, { nb_frames: "29" }, { nb_read_frames: "29" },
    { start_pts: 1 }, { duration_ts: 30000 }, { time_base: "1/29999" },
  ]) expect(() => verifySpatialCompositorProbe({ ...input, video: { ...input.video, streams: [{ ...input.video.streams[0], ...change }] } })).toThrow();
  const gap = structuredClone(input); gap.video.frames[7]!.best_effort_timestamp += 1;
  expect(() => verifySpatialCompositorProbe(gap)).toThrow("frame 7");
  const truncated = structuredClone(input); truncated.audio.streams[0]!.duration_ts -= 1024;
  expect(() => verifySpatialCompositorProbe(truncated)).toThrow("audio was truncated");
});
test("correct timing cannot qualify missing or mismatched encoded dimensions and pixel format", () => {
  const input = probes();
  for (const change of [{ width: 32 }, { height: 32 }, { pix_fmt: "yuv444p" }, { width: undefined }, { height: undefined }, { pix_fmt: undefined }]) {
    expect(() => verifySpatialCompositorProbe({ ...input, video: { ...input.video, streams: [{ ...input.video.streams[0], ...change }] } })).toThrow();
  }
  let invoked = 0;
  expect(() => verifySpatialCompositorProbe({ ...input, expectedVideo: { ...input.expectedVideo, get pixelWidth() { invoked++; return 16; } } })).toThrow();
  expect(invoked).toBe(0);
});
test("half-open sample endpoints remain exact across rational rates and microsecond boundaries", () => {
  for (const [n, d] of [[24, 1], [30000, 1001], [60000, 1001], [240, 1]]) {
    for (const duration of [1, 33333, 33334, 999999, 1000000, 1001001]) {
      const input = probes(duration, n!, d!);
      // Sub-sample audio has no representable AAC duration and deliberately fails.
      if (duration === 1) expect(() => verifySpatialCompositorProbe(input)).toThrow();
      else expect(verifySpatialCompositorProbe(input).frameCount).toBe(input.cadence.cadence.frameCount);
    }
  }
});
test("malformed, unreduced and forged cadence bindings reject before native launch", async () => {
  const { binding } = fixture();
  expect(() => assertSpatialCompositorCadence({ ...binding, cadenceSha256: "b".repeat(64) })).toThrow("digest");
  expect(() => assertSpatialCompositorCadence({ ...binding, cadence: { ...binding.cadence, frameRate: { numerator: 60000, denominator: 2002 } } })).toThrow();
  let calls = 0;
  await expect(verifySpatialCompositorOutput({ cadence: { ...binding, cadenceSha256: "b".repeat(64) }, expectedVideo: probes().expectedVideo, outputPath: "/tmp/out.mp4", maximumBytes: 1024,
    ffprobe: "/usr/bin/ffprobe", signal: new AbortController().signal, runner: { run: async () => { calls++; throw new Error("Unexpected launch"); } } })).rejects.toThrow("digest");
  expect(calls).toBe(0);
});
test("metadata sprites preserve exact cadence and reject a conflicting planning ratio", () => {
  const rate = { numerator: 30000, denominator: 1001 };
  expect(buildMetadataCursorSprite({ style: "captured", scale: 1 }, 30000 / 1001, 1000000, rate).filters[0]).toContain("r=30000/1001");
  expect(buildMetadataClickSprite({ style: "pulse", radiusPx: 10, color: "#ff0000ff" }, 30000 / 1001, 1000000, rate).filters[0]).toContain("r=30000/1001");
  expect(() => buildMetadataCursorSprite({ style: "captured", scale: 1 }, 30, 1000000, rate)).toThrow("cadence");
});

test("spatial cadence resolves digest-named shot videos in project storage and retains legacy repository roots", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "slopcamera-spatial-input-root-")));
  try {
    const project = join(root, "project"); await mkdir(join(project, "renders"), { recursive: true }); await mkdir(join(project, "spatial", "outputs"), { recursive: true });
    const bytes = Buffer.from("original media bytes"), hash = createHash("sha256").update(bytes).digest("hex");
    const spatialPath = `spatial/outputs/${hash}.mov`;
    await writeFile(join(project, spatialPath), bytes); await writeFile(join(root, "legacy.mov"), bytes);
    const { plan, binding } = fixture(); const interval = { startUs: 0, endUs: 1_000_000 };
    plan.videoSlices = [spatialPath, "legacy.mov"].map((path, index) => ResolvedProjectVideoSliceSchema.parse({ assetId: `asset_media0000${index}`, assetRange: interval, bytes: bytes.length, codec: "qtrle", container: "mov",
      fileRange: interval, outputRange: interval, path, placementId: `placement_media0000${index}`, projectRange: interval, projectSpeed: 1, sha256: hash,
      streamId: `stream_media0000${index}`, streamIndex: 0, kind: "video", role: "b-roll", presentation: { enabled: true, blendMode: "normal", crop: { kind: "none" }, fit: "fill", layer: index,
        layout: { kind: "normalized", x: 0, y: 0, width: 1, height: 1 }, opacity: 1 } }));
    plan.planSha256 = hashProjectRenderPlanComposition(plan);
    const cadence = { ...binding.cadence, compositionPlanSha256: plan.planSha256 };
    const spatialCadence = assertSpatialCompositorCadence({ cadence, cadenceSha256: spatialCompositorCadenceSha256(cadence) }, plan);
    const built = await buildProjectFfmpegInvocation(plan, { ffmpeg: "/usr/bin/ffmpeg", outputPath: join(project, "renders", "out.mp4"), projectDirectory: project, repositoryRoot: root, spatialCadence });
    expect(built.pinnedInputs.map(input => input.path)).toEqual([join(project, spatialPath), join(root, "legacy.mov")]);
    expect(built.argv).toContain(join(project, spatialPath));
    const bad = { ...plan, videoSlices: plan.videoSlices.map((slice, index) => index === 0 ? { ...slice, path: `spatial/outputs/${"b".repeat(64)}.mov` } : slice) };
    bad.planSha256 = hashProjectRenderPlanComposition(bad);
    const badCadence = { ...cadence, compositionPlanSha256: bad.planSha256 };
    await expect(buildProjectFfmpegInvocation(bad, { ffmpeg: "/usr/bin/ffmpeg", outputPath: join(project, "renders", "out.mp4"), projectDirectory: project, repositoryRoot: root,
      spatialCadence: { cadence: badCadence, cadenceSha256: spatialCompositorCadenceSha256(badCadence) } })).rejects.toThrow("filename");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed timing probe waits for its sibling before returning to workspace cleanup", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "slopcamera-spatial-probe-")));
  try {
    const outputPath = join(root, "out.mp4"); await writeFile(outputPath, "verified-private-fixture");
    const input = probes();
    let release!: () => void, arrived!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { arrived = resolve; });
    let completed = false;
    const verifying = verifySpatialCompositorOutput({ cadence: input.cadence, expectedVideo: input.expectedVideo, outputPath, maximumBytes: 1024, ffprobe: "/usr/bin/ffprobe", signal: new AbortController().signal,
      runner: { run: async argv => {
        if (argv.includes("-count_frames")) return { exitCode: 1, stdout: "", stderr: "video decode failed" };
        arrived(); await pending; return { exitCode: 0, stdout: JSON.stringify(input.audio), stderr: "" };
      } } });
    const observed = verifying.then(() => { completed = true; }, error => { completed = true; throw error; });
    await entered;
    expect(completed).toBe(false);
    release();
    await expect(observed).rejects.toThrow("native verification failed");
    expect(completed).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

const ffmpeg = Bun.which("ffmpeg"), ffprobe = Bun.which("ffprobe");
test.skipIf(ffmpeg === null || ffprobe === null)("native rational endpoints preserve the last video sample and sub-millisecond AAC tail", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "slopcamera-spatial-native-cadence-")));
  try {
    await mkdir(join(root, "renders"));
    const runner = new BunProcessRunner();
    for (const [duration, n, d] of [[1_001_001, 24000, 1001], [333334, 30, 1]]) {
      const { plan, binding } = fixture(duration!, n!, d!);
      const outputPath = join(root, "renders", `${n}.mp4`);
      const built = await buildProjectFfmpegInvocation(plan, { ffmpeg: ffmpeg!, ffprobe: ffprobe!, outputPath,
        projectDirectory: root, repositoryRoot: root, runner, renderTier: "preview", spatialCadence: binding });
      const encoded = await runner.run(built.argv, { timeoutMs: 30_000, maxOutputBytes: 1024 * 1024, stdin: "ignore" });
      expect(encoded.exitCode).toBe(0);
      const verified = await verifySpatialCompositorOutput({ cadence: binding, outputPath, maximumBytes: 1024 * 1024,
        expectedVideo: { pixelWidth: plan.output.pixelWidth, pixelHeight: plan.output.pixelHeight, pixelFormat: "yuv420p" },
        ffprobe: ffprobe!, runner, signal: new AbortController().signal });
      expect(verified.frameCount).toBe(n === 24000 ? 25 : 11);
      expect(verified.lastPts).toBe(n === 24000 ? "24024" : "10");
      expect(verified.audio.durationTs).toBe(n === 24000 ? "48048" : "16000");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
