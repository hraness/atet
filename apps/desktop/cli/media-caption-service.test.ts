import { expect, test } from "bun:test";

import type { FaceAnalyzerFrameEvent } from "../analysis/protocol";
import type { SpeechWordInput } from "../core";
import {
  buildMediaCaptionAss,
  buildMediaCaptionInvocation,
  buildMediaCaptionSpeechWindows,
  buildMediaCaptionVadArgv,
  compileMediaCaptionCues,
  parseWhisperVadSpeechSegments,
  removeHallucinatedTranscriptRepetition,
  removeNonDialogueTranscriptWords,
  resolveMediaCaptionDurationUs,
  selectMediaCaptionWindowWords,
  type MediaCaptionCue,
} from "./media-caption-service";

function word(text: string, startUs: number, endUs: number): SpeechWordInput {
  return { confidence: 0.95, range: { endUs, startUs }, speaker: null, text };
}

function frame(
  ptsUs: number,
  faces: readonly Readonly<{ height: number; width: number; x: number; y: number }>[],
): FaceAnalyzerFrameEvent {
  return {
    durationUs: 250_000,
    event: "frame",
    faces: faces.map((bounds, detectionIndex) => ({
      bounds,
      confidence: 0.95,
      detectionIndex,
    })),
    kind: "transmute.face-analysis",
    ptsUs,
    sampleIndex: Math.floor(ptsUs / 250_000),
    schemaVersion: 1,
  };
}

const settings = {
  audioStreamOrdinal: 0,
  encoder: "h264-videotoolbox" as const,
  frameHeight: 1_920,
  frameWidth: 1_080,
  language: "auto",
  maximumOutputBytes: 8 * 1024 * 1024 * 1024,
  processors: 1,
  threads: 4,
  useGpu: true,
  videoBitrateKbps: 16_000,
  videoStreamIndex: 0,
};

test("packs timed words and places captions away from detected people and social metadata", () => {
  const cues = compileMediaCaptionCues([
    word("This", 100_000, 300_000),
    word("is", 320_000, 450_000),
    word("the", 470_000, 600_000),
    word("long", 620_000, 800_000),
    word("zipline!", 820_000, 1_100_000),
  ], [
    frame(250_000, [{ height: 0.12, width: 0.13, x: 0.43, y: 0.34 }]),
    frame(750_000, [{ height: 0.12, width: 0.13, x: 0.43, y: 0.34 }]),
  ]);

  expect(cues).toHaveLength(2);
  expect(cues.flatMap(cue => cue.lines).join(" ")).toBe("This is the long zipline!");
  for (const cue of cues) {
    expect(cue.position.faceOverlapScore).toBe(0);
    expect([0.1, 0.26, 0.42, 0.56]).toContain(cue.position.y);
    const captionHeight = cue.lines.length === 1 ? 0.07 : 0.115;
    expect(cue.position.y + captionHeight).toBeLessThanOrEqual(0.68);
  }
});

test("writes bounded ASS data with fixed positions and neutralizes override text", () => {
  const cue: MediaCaptionCue = {
    lines: ["Say {hi}\\now"],
    position: { faceOverlapScore: 0, x: 0.5, y: 0.34 },
    range: { endUs: 2_120_000, startUs: 1_010_000 },
    sourceWordIndices: [0],
  };
  const ass = buildMediaCaptionAss([cue], settings);

  expect(ass).toContain("PlayResX: 1080");
  expect(ass).toContain("PlayResY: 1920");
  expect(ass).toContain("{\\an8\\pos(540,653)\\q2}");
  expect(ass).toContain("Say ｛hi｝＼now");
  expect(ass).not.toContain("Say {hi}");
});

test("builds a caller-text-free descriptor caption filter and explicit hardware encode", () => {
  const built = buildMediaCaptionInvocation({
    assPath: "/dev/fd/4",
    durationUs: 8_000_000,
    ffmpeg: "ffmpeg",
    inputPath: "/dev/fd/3",
    outputPath: "/private/output.mp4",
    settings,
  });

  expect(built.filterGraph).toBe("[0:v:0]subtitles=filename=/dev/fd/4[captioned_video]");
  expect(built.argv).toContain("h264_videotoolbox");
  expect(built.argv).toContain("16000k");
  expect(built.argv).toContain("0:a:0");
  expect(built.argv.slice(-2)).toEqual(["+faststart", "/private/output.mp4"]);
});

test("clamps caption analysis to the selected video coverage", () => {
  expect(resolveMediaCaptionDurationUs(
    119_100_000,
    { endUs: 119_085_633, startUs: 0 },
  )).toBe(119_085_633);
  expect(resolveMediaCaptionDurationUs(
    8_000_000,
    { endUs: 8_500_000, startUs: 500_000 },
  )).toBe(8_000_000);
  expect(() => resolveMediaCaptionDurationUs(
    8_000_000,
    { endUs: 500_000, startUs: 500_000 },
  )).toThrow("invalid container or video duration");
});

test("parses bounded VAD ranges and groups nearby speech into language windows", () => {
  const ranges = parseWhisperVadSpeechSegments([
    "Detected 3 speech segments:",
    "Speech segment 0: start = 142.00, end = 238.00",
    "Speech segment 1: start = 258.00, end = 453.00",
    "Speech segment 2: start = 4094.00, end = 4306.00",
  ].join("\n"), 60_000_000);
  expect(ranges).toEqual([
    { endUs: 2_380_000, startUs: 1_420_000 },
    { endUs: 4_530_000, startUs: 2_580_000 },
    { endUs: 43_060_000, startUs: 40_940_000 },
  ]);
  expect(buildMediaCaptionSpeechWindows(60_000_000, ranges)).toEqual([
    {
      acceptRange: { endUs: 7_030_000, startUs: 0 },
      endUs: 7_030_000,
      startUs: 0,
    },
    {
      acceptRange: { endUs: 45_560_000, startUs: 38_440_000 },
      endUs: 45_560_000,
      startUs: 38_440_000,
    },
  ]);
  expect(() => parseWhisperVadSpeechSegments(
    "Detected 2 speech segments:\nSpeech segment 0: start = 1.00, end = 2.00",
    60_000_000,
  )).toThrow(/declared segment count/u);
});

test("keeps only owned speech words and drops generated non-dialogue descriptions", () => {
  const window = buildMediaCaptionSpeechWindows(10_000_000, [
    { endUs: 5_000_000, startUs: 4_000_000 },
  ])[0]!;
  const selected = selectMediaCaptionWindowWords([
    word("before", 800_000, 1_000_000),
    word("Hola", 4_100_000, 4_500_000),
    word("(engine", 4_600_000, 4_900_000),
    word("revving)", 4_900_000, 5_400_000),
    word("after", 8_100_000, 8_400_000),
  ], window, [{ endUs: 5_000_000, startUs: 4_000_000 }]);
  expect(removeNonDialogueTranscriptWords(selected).map(item => item.text)).toEqual(["Hola"]);
  expect(removeHallucinatedTranscriptRepetition([
    word("7", 1_000_000, 1_400_000),
    word("7", 1_400_000, 1_800_000),
    word("7", 1_800_000, 2_200_000),
    word("7", 2_200_000, 2_600_000),
    word("7777.", 2_700_000, 2_900_000),
    word("Ready", 3_000_000, 3_400_000),
  ]).map(item => item.text)).toEqual(["Ready"]);
});

test("builds the fixed local VAD invocation without a shell", () => {
  expect(buildMediaCaptionVadArgv({
    inputWavPath: "/tmp/input.wav",
    runtime: { executable: "/tools/whisper-vad", modelPath: "/models/silero.bin" },
    threads: 8,
  })).toEqual([
    "/tools/whisper-vad",
    "--file", "/tmp/input.wav",
    "--vad-model", "/models/silero.bin",
    "--threads", "8",
    "--vad-threshold", "0.3",
    "--vad-min-speech-duration-ms", "100",
    "--vad-min-silence-duration-ms", "250",
    "--vad-max-speech-duration-s", "20",
    "--vad-speech-pad-ms", "240",
    "--no-prints",
  ]);
});
