/** Opt-in ten-minute native timing qualification. Run through the host compute lane. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { arch, cpus, release, totalmem } from "node:os";
import { join, resolve } from "node:path";

import { BunProcessRunner } from "../cli/io";
import { buildProjectFfmpegInvocation } from "../cli/project-renderer";
import { verifySpatialCompositorOutput } from "../cli/spatial-compositor-verifier";
import { ProjectRenderPlanV1Schema } from "../contracts/project-render";
import { hashProjectRenderPlanComposition } from "../core/project-render-plan";
import { assertSpatialCompositorCadence, spatialCompositorCadenceSha256 } from "../core/spatial-compositor";
import { spatialFrameCount } from "../../../src/spatial-scene/time";

const repositoryRoot = await realpath(resolve(import.meta.dir, "../../.."));
const root = join(repositoryRoot, "artifacts", "spatial-compositor-qualification", new Date().toISOString().replaceAll(":", "-"));
await mkdir(join(root, "renders"), { recursive: true, mode: 0o700 });
const ffmpeg = Bun.which("ffmpeg") ?? "/opt/homebrew/bin/ffmpeg", ffprobe = Bun.which("ffprobe") ?? "/opt/homebrew/bin/ffprobe";
const runner = new BunProcessRunner();
const commands: { argv: readonly string[]; exitCode: number; milliseconds: number }[] = [];
const started = performance.now();
async function run(argv: readonly [string, ...string[]]) {
  const start = performance.now();
  const result = await runner.run(argv, { timeoutMs: 120_000, maxOutputBytes: 4 * 1024 * 1024, stdin: "ignore" });
  commands.push({ argv, exitCode: result.exitCode, milliseconds: performance.now() - start });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout;
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
await run([ffmpeg, "-v", "error", "-nostdin", "-f", "lavfi", "-i", "sine=frequency=997:sample_rate=48000:duration=600.1", "-c:a", "pcm_s16le", join(root, "original-tone.wav")]);
const audio = await readFile(join(root, "original-tone.wav")), sourceHash = sha256(audio);
const durationUs = 600_000_001, frameRate = { numerator: 30_000, denominator: 1_001 };
const interval = { startUs: 0, endUs: durationUs };
const plan = ProjectRenderPlanV1Schema.parse({ kind: "slopcamera.project-render-plan", schemaVersion: 1,
  planSha256: sourceHash, projectEditPlanSha256: sourceHash, projectStructureSha256: sourceHash, projectId: "project_nativespatial",
  output: { background: "#223344ff", durationUs, frameRate: frameRate.numerator / frameRate.denominator, pixelWidth: 32, pixelHeight: 24 },
  videoSlices: [], overlays: [], cameraKeyframes: [], cameraSegments: [], warnings: [],
  audioSlices: [{ assetId: "asset_originaltone", assetRange: interval, bytes: audio.length, codec: "pcm_s16le", container: "wav", fileRange: interval,
    outputRange: interval, path: "original-tone.wav", placementId: "placement_originaltone", projectRange: interval, projectSpeed: 1, sha256: sourceHash,
    streamId: "stream_originaltone", streamIndex: 0, kind: "audio", presentation: { enabled: true, gainDb: 0, pan: 0 }, role: "music" }],
  effects: { clickCues: [], clicks: { enabled: false }, cursor: { enabled: false }, cursorSamples: [], keystrokeCues: [], keystrokes: { enabled: false }, typedText: { enabled: false }, typingSpans: [] },
});
plan.planSha256 = hashProjectRenderPlanComposition(plan);
const cadence = { kind: "slopcamera.spatial-compositor-cadence" as const, schemaVersion: 1 as const,
  // This standalone native timing fixture tests an exact adapter, not a V2-authority claim.
  projectionSha256: sourceHash, compositionPlanSha256: plan.planSha256, frameRate, durationUs, frameCount: spatialFrameCount(durationUs, frameRate) };
const binding = assertSpatialCompositorCadence({ cadence, cadenceSha256: spatialCompositorCadenceSha256(cadence) }, plan);
const outputPath = join(root, "renders", "ten-minute.mp4");
const built = await buildProjectFfmpegInvocation(plan, { ffmpeg, ffprobe, outputPath, projectDirectory: root, repositoryRoot: root,
  renderTier: "preview", runner, spatialCadence: binding });
await run(built.argv);
const verified = await verifySpatialCompositorOutput({ cadence: binding, outputPath, maximumBytes: 256 * 1024 * 1024, ffprobe,
  expectedVideo: { pixelWidth: plan.output.pixelWidth, pixelHeight: plan.output.pixelHeight, pixelFormat: "yuv420p" },
  runner: { async run(argv, options) {
    const start = performance.now(), result = await runner.run(argv, options);
    commands.push({ argv, exitCode: result.exitCode, milliseconds: performance.now() - start });
    await writeFile(join(root, argv.includes("-count_frames") ? "video-probe.json" : "audio-probe.json"), result.stdout);
    return result;
  } }, signal: new AbortController().signal });
assert.equal(verified.frameCount, 17_983);
assert.equal(verified.lastPts, "17999982");
assert.equal(verified.durationTs, "18000983");
assert.equal(verified.audio.durationTs, "28800000");
const tailPath = join(root, "audible-tail.f32le");
await run([ffmpeg, "-v", "error", "-nostdin", "-i", outputPath, "-map", "0:a:0", "-af", "atrim=start=599.970001:end=599.994001", "-c:a", "pcm_f32le", "-f", "f32le", tailPath]);
const tail = await readFile(tailPath); let power = 0;
for (let index = 0; index < tail.length; index += 4) power += tail.readFloatLE(index) ** 2;
const rms = Math.sqrt(power / (tail.length / 4)); assert.ok(rms > .01, "Final authored audio must remain audible.");
const output = await readFile(outputPath);
const versions = { ffmpeg: (await run([ffmpeg, "-version"])).split("\n")[0], ffprobe: (await run([ffprobe, "-version"])).split("\n")[0], bun: Bun.version };
const report = { kind: "slopcamera.spatial-compositor-qualification", schemaVersion: 1, passed: true, versions,
  machine: { model: cpus()[0]?.model, logicalCores: cpus().length, totalMemoryBytes: totalmem(), architecture: arch(), kernelRelease: release() },
  measurements: { elapsedMilliseconds: performance.now() - started, parentProcessMemory: process.memoryUsage(), parentProcessResourceUsage: process.resourceUsage(), tailRms: rms },
  source: { bytes: audio.length, sha256: sourceHash }, output: { path: outputPath, bytes: output.length, sha256: sha256(output) },
  cadence: binding, verified, invocation: built.invocation, commands,
  limits: ["32×24 solid canvas plus original600.1s tone qualifies timing and audio, not mixed-scene visual throughput.",
    "Every video PTS and both stream endpoints are verified using integer time bases. Parent RSS is not aggregate pipeline memory; use an outer native time wrapper for its reported maximum RSS."] };
await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ passed: true, frames: verified.frameCount, report: join(root, "report.json") }, null, 2));
