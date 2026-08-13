import { expect, test } from "bun:test";
import {
  FfmpegInactivityAnalyzer,
  parseFreezeDetectOutput,
  parseSilenceDetectOutput,
  probeMediaSummary,
  probeVisualMediaSummary,
} from "./analyzer";
import type { ProcessRunner, RunResult } from "./io";

class AnalyzerRunner implements ProcessRunner {
  readonly calls: Array<readonly [string, ...string[]]> = [];

  run(argv: readonly [string, ...string[]]): Promise<RunResult> {
    this.calls.push(argv);
    if (argv[0] === "ffprobe-test") {
      const visual = argv.some(argument => argument.includes("width,height"));
      return Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: visual
          ? '{"format":{"duration":"10.0","start_time":"1.0"},"streams":[{"codec_type":"video","disposition":{"attached_pic":1},"height":600,"index":0,"width":600},{"codec_type":"video","duration":"8.0","height":720,"index":9,"start_time":"1.0","width":1280},{"codec_type":"audio","index":8,"start_time":"1.0","tags":{"DURATION":"00:00:08.000000000"}},{"codec_type":"video","height":1080,"index":4,"start_time":"2.5","tags":{"DURATION":"00:00:05.000000000"},"width":1920},{"codec_type":"audio","index":7,"start_time":"4.0","tags":{"DURATION":"00:00:02.000000000"}}]}'
          : '{"format":{"duration":"5.0"},"streams":[{"codec_type":"video"},{"codec_type":"audio"}]}',
      });
    }
    if (argv.includes("-vf")) {
      return Promise.resolve({
        exitCode: 0,
        stderr: "lavfi.freezedetect.freeze_start=1.25\nlavfi.freezedetect.freeze_end=3.5",
        stdout: "",
      });
    }
    return Promise.resolve({
      exitCode: 0,
      stderr: "silence_start: 0.5\nsilence_end: 2.0 | silence_duration: 1.5",
      stdout: "",
    });
  }
}

test("parses closed and end-of-stream freeze and silence intervals", () => {
  expect(parseFreezeDetectOutput("freeze_start: 1.0\nfreeze_duration: 2.5", 10_000_000))
    .toEqual([{ endUs: 3_500_000, startUs: 1_000_000 }]);
  expect(parseSilenceDetectOutput("silence_start: 2.0", 5_000_000))
    .toEqual([{ endUs: 5_000_000, startUs: 2_000_000 }]);
});

test("probes animated media duration and audio presence in one bounded call", async () => {
  const runner = new AnalyzerRunner();
  expect(await probeMediaSummary("ffprobe-test", runner, "overlay.mp4")).toEqual({
    durationUs: 5_000_000,
    hasAudio: true,
  });
  expect(runner.calls[0]).toContain("format=duration:stream=codec_type");
});

test("probes bounded visual dimensions and rejects oversized media", async () => {
  const runner = new AnalyzerRunner();
  expect(await probeVisualMediaSummary("ffprobe-test", runner, "overlay.mp4")).toEqual({
    audioEndUs: 5_000_000,
    audioStartUs: 3_000_000,
    audioStreamIndex: 7,
    durationUs: 5_000_000,
    hasAudio: true,
    pixelHeight: 1080,
    pixelWidth: 1920,
    videoStartUs: 1_500_000,
    videoStreamIndex: 4,
  });
  expect(runner.calls[0]).toContain(
    "format=duration,start_time:stream=index,codec_type,width,height,duration,start_time:stream_disposition=attached_pic:stream_tags=duration",
  );
  expect((await probeVisualMediaSummary("ffprobe-test", runner, "overlay.mp4")).durationUs).toBe(5_000_000);
  expect(probeVisualMediaSummary("ffprobe-test", {
    run: () => Promise.resolve({
      exitCode: 0,
      stderr: "",
      stdout: '{"format":{"duration":"1"},"streams":[{"codec_type":"video","height":1,"index":0,"width":20000}]}',
    }),
  }, "huge.gif")).rejects.toThrow(/intrinsic dimensions/u);
});

test("uses the normalized format end when selected video duration metadata is absent", async () => {
  expect(await probeVisualMediaSummary("ffprobe-test", {
    run: () => Promise.resolve({
      exitCode: 0,
      stderr: "",
      stdout: '{"format":{"duration":"2.0","start_time":"-0.007"},"streams":[{"codec_type":"video","height":24,"index":2,"start_time":"0","width":32},{"codec_type":"audio","index":3,"start_time":"-0.007","tags":{"DURATION":"00:00:00.758000000"}}]}',
    }),
  }, "overlay.webm")).toEqual({
    audioEndUs: 758_000,
    audioStartUs: 0,
    audioStreamIndex: 3,
    durationUs: 1_993_000,
    hasAudio: true,
    pixelHeight: 24,
    pixelWidth: 32,
    videoStartUs: 7_000,
    videoStreamIndex: 2,
  });
});

test("maps an explicit shared-container stream index and offsets detections", async () => {
  const runner = new AnalyzerRunner();
  const analyzer = new FfmpegInactivityAnalyzer({ ffmpeg: "ffmpeg-test", ffprobe: "ffprobe-test", runner });
  expect(await analyzer.freeze("shared.mp4", 3, 1_000_000, 0.003, 7_000_000)).toEqual([
    { endUs: 10_500_000, startUs: 8_250_000 },
  ]);
  expect(await analyzer.silence("shared.mp4", 5, 500_000, 11_000_000)).toEqual([
    { endUs: 13_000_000, startUs: 11_500_000 },
  ]);
  expect(runner.calls.filter((argv) => argv[0] === "ffmpeg-test").map((argv) => {
    const mapIndex = argv.indexOf("-map");
    return argv[mapIndex + 1];
  })).toEqual(["0:3", "0:5"]);
});
