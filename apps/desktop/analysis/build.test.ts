import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildFaceAnalyzer,
  faceAnalyzerExecutablePath,
  resolveFaceAnalyzerPath,
  verifyFaceAnalyzerIdentity,
} from "./build";
import { parseFaceAnalyzerJsonLines } from "./protocol";

let analyzerBuild: ReturnType<typeof buildFaceAnalyzer> | undefined;

function builtAnalyzer(): ReturnType<typeof buildFaceAnalyzer> {
  analyzerBuild ??= buildFaceAnalyzer();
  return analyzerBuild;
}

async function run(
  arguments_: readonly string[],
): Promise<{ readonly exitCode: number; readonly stderr: string; readonly stdout: string }> {
  const child = Bun.spawn([...arguments_], { stderr: "pipe", stdout: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

const ffmpeg = [
  Bun.which("ffmpeg"),
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
].find((candidate): candidate is string => candidate !== null && existsSync(candidate));
const positiveFaceFixture = join(import.meta.dir, "face-positive-fixture.jpg");

describe("Apple Vision face-analyzer build boundary", () => {
  test("exports one stable ignored runtime path without compiling on import", () => {
    expect(resolveFaceAnalyzerPath()).toBe(faceAnalyzerExecutablePath);
    expect(faceAnalyzerExecutablePath).toEndWith("/analysis/dist/atet-face-analyzer");
  });

  test("ad-hoc signs the helper and exposes pinned offline backend provenance", async () => {
    if (process.platform !== "darwin") return;
    const result = await builtAnalyzer();
    expect(await verifyFaceAnalyzerIdentity(result.path)).toBeUndefined();

    const invocation = await run([result.path, "--probe"]);
    expect(invocation.exitCode).toBe(0);
    expect(invocation.stderr).toBe("");
    const events = parseFaceAnalyzerJsonLines(invocation.stdout);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.event).toBe("probe");
    if (event?.event === "probe") {
      expect(event.backend.implementation).toBe("apple-vision");
      expect(event.backend.offline).toBeTrue();
      expect(event.backend.request).toBe("VNDetectFaceRectanglesRequest");
      expect(event.backend.revision).toBeGreaterThan(0);
      expect(event.backend.architecture).toBe(process.arch === "x64" ? "x86_64" : "arm64");
      expect(event.backend.helperVersion).toMatch(/^\d+\.\d+\.\d+$/u);
      expect(event.backend.osBuild).toMatch(/^[A-Za-z0-9]+$/u);
      expect(event.backend.operatingSystem.length).toBeGreaterThan(0);
      expect(event.backend.runtimeVersion).toBe(event.backend.operatingSystem);
    }
  }, 60_000);

  test("supports bounded text and JSON capability probes", async () => {
    if (process.platform !== "darwin") return;
    const { path } = await builtAnalyzer();
    const [version, json] = await Promise.all([
      run([path, "--version"]),
      run([path, "--json"]),
    ]);

    expect(version.exitCode).toBe(0);
    expect(version.stderr).toBe("");
    expect(version.stdout).toMatch(/^atet-face-analyzer \d+\.\d+\.\d+ .{1,400}\n$/u);
    expect(new TextEncoder().encode(version.stdout).byteLength).toBeLessThanOrEqual(512);
    expect(json.exitCode).toBe(0);
    expect(parseFaceAnalyzerJsonLines(json.stdout)[0]?.event).toBe("probe");
  }, 60_000);

  test("emits one bounded protocol error for unknown arguments", async () => {
    if (process.platform !== "darwin") return;
    const { path } = await builtAnalyzer();
    const invocation = await run([path, "--not-a-real-option", "value"]);

    expect(invocation.exitCode).toBe(2);
    const events = parseFaceAnalyzerJsonLines(invocation.stdout);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("error");
    if (events[0]?.event === "error") {
      expect(events[0].code).toBe("usage");
      expect(events[0].message.length).toBeLessThanOrEqual(1_024);
    }
  }, 60_000);

  test("selects the requested video-track ordinal and reports decoded sample PTS", async () => {
    if (process.platform !== "darwin" || ffmpeg === undefined) return;
    const { path } = await builtAnalyzer();
    const directory = await mkdtemp(join(tmpdir(), "atet-face-analyzer-pts-"));
    const fixture = join(directory, "two-tracks.mov");
    try {
      const fixtureBuild = await run([
        ffmpeg,
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-f", "lavfi",
        "-i", "color=c=black:s=64x48:r=10:d=0.6",
        "-f", "lavfi",
        "-i", "color=c=white:s=64x48:r=10:d=0.4",
        "-filter_complex", "[1:v]settb=1/10000,setpts=PTS+110*N[offset]",
        "-map", "0:v:0",
        "-map", "[offset]",
        "-c:v", "mpeg4",
        "-q:v", "2",
        "-fps_mode", "passthrough",
        "-video_track_timescale", "10000",
        fixture,
      ]);
      expect(fixtureBuild.exitCode).toBe(0);

      const invocation = await run([
        path,
        "--input", fixture,
        "--video-track-ordinal", "1",
        "--start-us", "0",
        "--end-us", "600000",
        "--sample-interval-us", "1000",
        "--max-frames", "16",
        "--max-faces-per-frame", "8",
        "--max-output-bytes", "1048576",
        "--minimum-confidence", "0",
      ]);
      expect(invocation.exitCode).toBe(0);
      const events = parseFaceAnalyzerJsonLines(invocation.stdout);
      expect(events.at(0)?.event).toBe("started");
      expect(events.at(-1)?.event).toBe("completed");

      const started = events.at(0);
      if (started?.event === "started") {
        expect(started.track.totalVideoTracks).toBe(2);
        expect(started.track.videoTrackOrdinal).toBe(1);
        expect(started.orientation.origin).toBe("top-left");
        expect(started.orientation.units).toBe("normalized");
        expect(started.orientation.visionOrientation).toBe("up");
        expect(started.orientation.rotationDegrees).toBe(0);
        expect(started.orientation.mirroredHorizontally).toBeFalse();
        expect(started.orientation.sampleAspectRatio).toEqual({ denominator: 1, numerator: 1 });
      }

      const frames = events.filter(event => event.event === "frame");
      expect(frames.length).toBeGreaterThanOrEqual(3);
      expect(frames.slice(0, 3).map(frame => frame.ptsUs)).toEqual([0, 111_000, 222_000]);
      expect(frames.map(frame => frame.ptsUs)).toEqual(
        frames.map(frame => frame.ptsUs).toSorted((left, right) => left - right),
      );
      expect(frames.every(frame => frame.faces.length === 0)).toBeTrue();
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 60_000);

  test("detects every separated face in the fictional positive fixture", async () => {
    if (process.platform !== "darwin" || ffmpeg === undefined) return;
    expect(existsSync(positiveFaceFixture)).toBeTrue();
    const { path } = await builtAnalyzer();
    const directory = await mkdtemp(join(tmpdir(), "atet-face-analyzer-positive-"));
    const fixture = join(directory, "three-fictional-faces.mp4");
    try {
      const fixtureBuild = await run([
        ffmpeg,
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-loop", "1",
        "-i", positiveFaceFixture,
        "-vf", "format=yuv420p",
        "-r", "5",
        "-t", "0.8",
        "-c:v", "libx264",
        fixture,
      ]);
      expect(fixtureBuild.exitCode).toBe(0);

      const invocation = await run([
        path,
        "--input", fixture,
        "--video-track-ordinal", "0",
        "--start-us", "0",
        "--end-us", "800000",
        "--sample-interval-us", "200000",
        "--max-frames", "8",
        "--max-faces-per-frame", "8",
        "--max-output-bytes", "1048576",
        "--minimum-confidence", "0.2",
      ]);
      expect(invocation.exitCode).toBe(0);
      expect(invocation.stderr).toBe("");
      const events = parseFaceAnalyzerJsonLines(invocation.stdout);
      expect(events.at(0)?.event).toBe("started");
      expect(events.at(-1)?.event).toBe("completed");

      const frames = events.filter(event => event.event === "frame");
      expect(frames).toHaveLength(4);
      for (const frame of frames) {
        expect(frame.faces).toHaveLength(3);
        const horizontalCenters = frame.faces
          .map(({ bounds }) => bounds.x + bounds.width / 2)
          .toSorted((left, right) => left - right);
        expect(horizontalCenters[0]).toBeLessThan(0.3);
        expect(horizontalCenters[1]).toBeGreaterThan(0.35);
        expect(horizontalCenters[1]).toBeLessThan(0.65);
        expect(horizontalCenters[2]).toBeGreaterThan(0.7);
      }

      const completed = events.at(-1);
      if (completed?.event === "completed") {
        expect(completed.framesAnalyzed).toBe(frames.length);
        expect(completed.faceDetections).toBe(frames.length * 3);
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }, 60_000);
});
