import { expect, test } from "bun:test";

import {
  buildMediaComposeInvocation,
  parseMediaComposition,
} from "./media-compose-service";

function composition(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    kind: "transmute.media-composition",
    schemaVersion: 1,
    segments: [
      {
        endUs: 5_000_000,
        source: "clips/first $(not-a-shell).mp4",
        startUs: 1_000_000,
        transitionAfter: { durationUs: 500_000, kind: "fade" },
      },
      {
        endUs: 14_000_000,
        source: "clips/second;still-a-path.mp4",
        startUs: 10_000_000,
      },
    ],
    ...overrides,
  };
}

test("parses bounded composition defaults and builds exact chained fades", () => {
  const parsed = parseMediaComposition(composition());
  expect(parsed.output).toEqual({
    audioBitrateKbps: 192,
    encoder: "h264",
    frameRate: "30000/1001",
    height: 1_920,
    maximumBytes: 8 * 1024 * 1024 * 1024,
    videoBitrateKbps: 12_000,
    width: 1_080,
  });
  expect(parsed.transition).toEqual({ durationUs: 750_000, kind: "fade" });
  expect(parsed.segments[0]).toMatchObject({ audioStream: 0, videoStream: 0 });

  const firstPath = "/dev/fd/3";
  const secondPath = "/dev/fd/4";
  const built = buildMediaComposeInvocation({
    composition: parsed,
    ffmpeg: "/opt/tools/ffmpeg",
    inputPaths: new Map([
      [parsed.segments[0]!.source, firstPath],
      [parsed.segments[1]!.source, secondPath],
    ]),
    outputPath: "/private/output.mp4",
  });

  expect(built.durationUs).toBe(7_500_000);
  expect(built.inputSources).toEqual([
    "clips/first $(not-a-shell).mp4",
    "clips/second;still-a-path.mp4",
  ]);
  expect(built.filterGraph).toContain("trim=start=1:end=5");
  expect(built.filterGraph).toContain("atrim=start=10:end=14");
  expect(built.filterGraph).toContain(
    "xfade=transition=fade:duration=0.5:offset=3.5[compose_v1]",
  );
  expect(built.filterGraph).toContain("acrossfade=d=0.5:c1=tri:c2=tri");
  expect(built.filterGraph).not.toContain("not-a-shell");
  expect(built.filterGraph).not.toContain("still-a-path");
  expect(built.argv.filter(argument => argument === firstPath)).toHaveLength(1);
  expect(built.argv.filter(argument => argument === secondPath)).toHaveLength(1);
  expect(built.argv.slice(-2)).toEqual(["+faststart", "/private/output.mp4"]);
  expect(built.argv).toContain("libx264");
});

test("chains transition offsets against the accumulated timeline", () => {
  const source = composition({
    output: { height: 720, width: 1_280 },
    segments: [
      { endUs: 4_000_000, source: "same.mp4", startUs: 0 },
      {
        endUs: 13_000_000,
        source: "same.mp4",
        startUs: 10_000_000,
        transitionAfter: { durationUs: 250_000 },
      },
      { endUs: 23_000_000, source: "other.mp4", startUs: 20_000_000 },
    ],
    transition: { durationUs: 1_000_000 },
  });
  const parsed = parseMediaComposition(source);
  const built = buildMediaComposeInvocation({
    composition: parsed,
    ffmpeg: "ffmpeg",
    inputPaths: new Map([
      ["same.mp4", "/dev/fd/3"],
      ["other.mp4", "/dev/fd/4"],
    ]),
    outputPath: "/private/output.mp4",
  });

  expect(built.durationUs).toBe(8_750_000);
  expect(built.filterGraph).toContain("duration=1:offset=3[compose_v1]");
  expect(built.filterGraph).toContain("duration=0.25:offset=5.75[compose_v2]");
  expect(built.argv.filter(argument => argument === "/dev/fd/3")).toHaveLength(1);
});

test("uses VideoToolbox only when the manifest explicitly selects it", () => {
  const parsed = parseMediaComposition(composition({
    output: {
      encoder: "h264-videotoolbox",
      videoBitrateKbps: 15_000,
    },
  }));
  const built = buildMediaComposeInvocation({
    composition: parsed,
    ffmpeg: "ffmpeg",
    inputPaths: new Map([
      [parsed.segments[0]!.source, "/dev/fd/3"],
      [parsed.segments[1]!.source, "/dev/fd/4"],
    ]),
    outputPath: "/private/output.mp4",
  });

  expect(built.argv).toContain("h264_videotoolbox");
  expect(built.argv).toContain("15000k");
  expect(built.argv.slice(built.argv.indexOf("-allow_sw"), built.argv.indexOf("-allow_sw") + 2))
    .toEqual(["-allow_sw", "0"]);
});

test("rejects unsafe paths, invalid ranges, and impossible transitions", () => {
  expect(() => parseMediaComposition(composition({
    segments: [
      { endUs: 3_000_000, source: "/absolute.mp4", startUs: 1_000_000 },
      { endUs: 5_000_000, source: "second.mp4", startUs: 4_000_000 },
    ],
  }))).toThrow(/bounded relative path/u);
  expect(() => parseMediaComposition(composition({
    segments: [
      { endUs: 1_000_000, source: "first.mp4", startUs: 1_000_000 },
      { endUs: 5_000_000, source: "second.mp4", startUs: 4_000_000 },
    ],
  }))).toThrow(/greater than startUs/u);
  expect(() => parseMediaComposition(composition({
    segments: [
      { endUs: 2_000_000, source: "first.mp4", startUs: 1_000_000 },
      { endUs: 5_000_000, source: "second.mp4", startUs: 4_000_000 },
    ],
    transition: { durationUs: 1_000_000 },
  }))).toThrow(/shorter than both adjacent/u);
  expect(() => parseMediaComposition(composition({
    segments: [
      { endUs: 3_000_000, source: "first.mp4", startUs: 1_000_000 },
      {
        endUs: 5_000_000,
        source: "second.mp4",
        startUs: 4_000_000,
        transitionAfter: { durationUs: 100_000 },
      },
    ],
  }))).toThrow(/last segment/u);
});
