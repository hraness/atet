import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { ProjectRenderPlanV1Schema } from "../contracts";
import type { ProcessRunner, RunResult } from "./io";
import { buildProjectFfmpegInvocation } from "./project-renderer";

const ffmpeg = Bun.which("ffmpeg");
const ffprobe = Bun.which("ffprobe");
const hash = "1".repeat(64);
const colors = { red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], yellow: [255, 255, 0], white: [255, 255, 255] } as const;

async function run(argv: readonly [string, ...string[]]): Promise<RunResult> {
  const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (exitCode !== 0) throw new Error(stderr);
  return { stdout, stderr, exitCode };
}
const runner: ProcessRunner = { run };

async function integrity(path: string) {
  const bytes = await readFile(path);
  return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}

for (const blendMode of ["normal", "multiply"] as const) {
  for (const sparse of [false, true]) {
    for (const camera of sparse ? [false] : [false, true]) {
      test.skipIf(ffmpeg === null || ffprobe === null)(`ordinary ${blendMode} slices${camera ? " with camera" : ""} preserve ${sparse ? "sparse VFR" : "coarse CFR"} frames and stop at the next cut`, async () => {
        if (ffmpeg === null || ffprobe === null) return;
        const root = await realpath(await mkdtemp(join(tmpdir(), "atet-project-slice-clock-")));
        try {
          await mkdir(join(root, "renders"));
          for (const [index, color] of [colors.red, colors.green, colors.blue].entries()) {
            await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: color[0], g: color[1], b: color[2] } } }).png().toFile(join(root, `frame_${index}.png`));
          }
          const source = join(root, "source.mp4"), next = join(root, "next.mp4");
          await run([ffmpeg, "-v", "error", "-nostdin", "-threads", "1", "-framerate", "24", "-i", join(root, "frame_%d.png"),
            ...(sparse ? ["-vf", "setpts='if(eq(N,0),0,if(eq(N,1),2,5))'", "-fps_mode", "passthrough"] : []),
            "-c:v", "libx264rgb", "-threads:v", "1", "-crf", "0", "-pix_fmt", "rgb24", "-video_track_timescale", "24", source]);
          await run([ffmpeg, "-v", "error", "-nostdin", "-f", "lavfi", "-i", "color=c=yellow:s=32x24:r=24:d=0.5", "-c:v", "libx264rgb", "-threads:v", "1", "-crf", "0", "-pix_fmt", "rgb24", "-video_track_timescale", "24", next]);
          const probed = JSON.parse((await run([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_frames", "-show_entries", "stream=time_base:frame=best_effort_timestamp,pkt_duration", "-of", "json", source])).stdout) as { streams: { time_base: string }[]; frames: { best_effort_timestamp: number }[] };
          expect(probed.streams[0]!.time_base).toBe("1/24");
          expect(probed.frames.map(frame => frame.best_effort_timestamp)).toEqual(sparse ? [0, 2, 5] : [0, 1, 2]);
          const startUs = sparse ? 0 : 166_666, durationUs = sparse ? 250_000 : 125_000, endUs = startUs + durationUs;
          const slice = async (path: string, id: string, fileDurationUs: number, outputStartUs: number, outputEndUs: number, mode: "normal" | "multiply", layer: number) => ({
            ...await integrity(join(root, path)), assetId: `asset_${id}`, placementId: `placement_${id}`, streamId: `stream_${id}`, streamIndex: 0,
            kind: "video", role: "b-roll", path, codec: "h264", container: "mov", projectSpeed: 1,
            assetRange: { startUs: 0, endUs: fileDurationUs }, fileRange: { startUs: 0, endUs: fileDurationUs },
            projectRange: { startUs: outputStartUs, endUs: outputEndUs }, outputRange: { startUs: outputStartUs, endUs: outputEndUs },
            presentation: { enabled: true, blendMode: mode, crop: { kind: "none" }, fit: "fill", layer,
              layout: { kind: "normalized", x: 0, y: 0, width: 1, height: 1 }, opacity: 1 },
          });
          const plan = ProjectRenderPlanV1Schema.parse({
            kind: "atet.project-render-plan", schemaVersion: 1, projectId: "project_sliceclock1", planSha256: hash, projectEditPlanSha256: hash, projectStructureSha256: hash,
            output: { background: "#ffffffff", durationUs: 500_000, frameRate: 24, pixelWidth: 32, pixelHeight: 24 },
            // Put the following shot underneath the tested slice so an inclusive
            // ending gate visibly spills over that next shot at an exact cut.
            videoSlices: [await slice("next.mp4", "nextclock1", 500_000 - endUs, endUs, 500_000, "normal", 0),
              await slice("source.mp4", "sourceclock1", durationUs, startUs, endUs, blendMode, 200)],
            audioSlices: [], overlays: [], cameraKeyframes: camera ? [startUs, endUs].map((outputTimeUs, index) => ({
              displayId: "display-primary", easing: { kind: "linear" }, layerPixelHeight: 24, layerPixelWidth: 32,
              outputTimeUs, placementId: "placement_sourceclock1", scale: 1, sourceTimeUs: index * durationUs,
              streamId: "stream_sourceclock1", viewport: { height: 24, width: 32, x: 0, y: 0 }, zoomId: "zoom_sliceclock1",
            })) : [], cameraSegments: [], warnings: [],
            effects: { clickCues: [], clicks: { enabled: false }, cursor: { enabled: false }, cursorSamples: [], keystrokeCues: [], keystrokes: { enabled: false }, typedText: { enabled: false }, typingSpans: [] },
          });
          const output = join(root, "renders", "test.mp4");
          const built = await buildProjectFfmpegInvocation(plan, { ffmpeg, ffprobe, outputPath: output, projectDirectory: root, repositoryRoot: root, runner });
          await run(built.argv);
          const decoded = join(root, "decoded.rgb");
          await run([ffmpeg, "-v", "error", "-nostdin", "-threads", "1", "-i", output, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgb24", decoded]);
          const pixels = await readFile(decoded);
          expect(pixels.length).toBe(12 * 32 * 24 * 3);
          const expected: (keyof typeof colors)[] = sparse
            ? ["red", "red", "green", "green", "green", "blue", "yellow", "yellow", "yellow", "yellow", "yellow", "yellow"]
            : ["white", "white", "white", "white", "red", "green", "blue", "yellow", "yellow", "yellow", "yellow", "yellow"];
          const blendReferences = new Map<string, number[]>();
          if (blendMode === "multiply") {
            // Independently identify each blend color with a zero-offset CFR
            // source. Its exact frame-aligned cuts avoid the clock under test.
            const referenceSource = join(root, "reference.mp4");
            await run([ffmpeg, "-v", "error", "-nostdin", "-threads", "1", "-framerate", "24", "-i", join(root, "frame_%d.png"),
              "-c:v", "libx264rgb", "-threads:v", "1", "-crf", "0", "-pix_fmt", "rgb24", "-video_track_timescale", "24", referenceSource]);
            const referencePlan = ProjectRenderPlanV1Schema.parse({ ...plan, cameraKeyframes: [],
              videoSlices: [await slice("next.mp4", "nextclock1", 250_000, 250_000, 500_000, "normal", 0),
                await slice("reference.mp4", "referenceclock1", 125_000, 0, 125_000, "multiply", 200)],
            });
            const referenceOutput = join(root, "renders", "reference.mp4");
            const referenceInvocation = await buildProjectFfmpegInvocation(referencePlan, { ffmpeg, ffprobe, outputPath: referenceOutput, projectDirectory: root, repositoryRoot: root, runner });
            await run(referenceInvocation.argv);
            const referenceDecoded = join(root, "reference.rgb");
            await run([ffmpeg, "-v", "error", "-nostdin", "-threads", "1", "-i", referenceOutput, "-map", "0:v:0", "-f", "rawvideo", "-pix_fmt", "rgb24", referenceDecoded]);
            const referencePixels = await readFile(referenceDecoded);
            expect(referencePixels.length).toBe(12 * 32 * 24 * 3);
            for (const [name, frame] of [["red", 0], ["green", 1], ["blue", 2], ["white", 4], ["yellow", 8]] as const) {
              const offset = (frame * 32 * 24 + 12 * 32 + 16) * 3;
              blendReferences.set(name, [referencePixels[offset]!, referencePixels[offset + 1]!, referencePixels[offset + 2]!]);
            }
            // A missing, repeated, or blank reference frame cannot bless the
            // actual output: all five independently aligned identities differ.
            const references = [...blendReferences.values()];
            for (let left = 0; left < references.length; left++) for (let right = left + 1; right < references.length; right++) {
              expect(references[left]!.reduce((sum, value, channel) => sum + Math.abs(value - references[right]![channel]!), 0)).toBeGreaterThan(25);
            }
          }
          for (const [index, name] of expected.entries()) {
            const offset = (index * 32 * 24 + 12 * 32 + 16) * 3;
            const pixel = [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!];
            const reference = blendMode === "normal" ? colors[name] : blendReferences.get(name)!;
            for (let channel = 0; channel < 3; channel++) {
              expect(Math.abs(pixel[channel]! - reference[channel]!)).toBeLessThan(12);
            }
          }
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      }, 20_000);
    }
  }
}
