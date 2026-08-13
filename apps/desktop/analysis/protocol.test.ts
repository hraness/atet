import { describe, expect, test } from "bun:test";
import {
  FACE_ANALYZER_KIND,
  FACE_ANALYZER_SCHEMA_VERSION,
  LEGACY_FACE_ANALYZER_KIND,
  MAXIMUM_FACE_ANALYZER_LINE_BYTES,
  parseFaceAnalyzerJsonLines,
} from "./protocol";

const backend = {
  architecture: "arm64",
  helperVersion: "1.0.0",
  implementation: "apple-vision",
  offline: true,
  osBuild: "24A335",
  operatingSystem: "macOS 15.0",
  request: "VNDetectFaceRectanglesRequest",
  revision: 3,
  runtimeVersion: "macOS 15.0",
} as const;

const hardLimits = {
  maximumArgumentBytes: 4_096,
  maximumArguments: 32,
  maximumFacesPerFrame: 128,
  maximumFrames: 100_000,
  maximumInputBytes: 4_398_046_511_104,
  maximumLineBytes: 1_048_576,
  maximumOutputBytes: 67_108_864,
  maximumTimelineUs: 86_400_000_000,
} as const;

function line(value: unknown): string {
  return JSON.stringify(value);
}

describe("face-analyzer JSONL protocol", () => {
  test("parses the bounded offline Apple Vision probe", () => {
    const events = parseFaceAnalyzerJsonLines(`${line({
      backend,
      event: "probe",
      kind: FACE_ANALYZER_KIND,
      limits: hardLimits,
      schemaVersion: FACE_ANALYZER_SCHEMA_VERSION,
    })}\n`);

    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("probe");
    if (events[0]?.event === "probe") {
      expect(events[0].backend).toEqual(backend);
      expect(events[0].limits).toEqual(hardLimits);
    }

    const legacy = parseFaceAnalyzerJsonLines(`${line({
      backend,
      event: "probe",
      kind: LEGACY_FACE_ANALYZER_KIND,
      limits: hardLimits,
      schemaVersion: FACE_ANALYZER_SCHEMA_VERSION,
    })}\n`);
    expect(legacy[0]?.kind).toBe("studio.face-analysis");
  });

  test("preserves real PTS and every detection in a multi-face frame", () => {
    const events = parseFaceAnalyzerJsonLines([
      line({
        backend,
        event: "started",
        kind: FACE_ANALYZER_KIND,
        limits: {
          endUs: 2_000_000,
          maximumFacesPerFrame: 8,
          maximumFrames: 20,
          maximumOutputBytes: 1_048_576,
          minimumConfidence: 0.2,
          sampleIntervalUs: 33_333,
          startUs: 1_000_000,
        },
        orientation: {
          encodedPixelHeight: 1_080,
          encodedPixelWidth: 1_920,
          mirroredHorizontally: false,
          origin: "top-left",
          pixelHeight: 1_080,
          pixelWidth: 1_920,
          preferredTransform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
          rotationDegrees: 0,
          sampleAspectRatio: { denominator: 1, numerator: 1 },
          units: "normalized",
          visionOrientation: "up",
          xAxis: "right",
          yAxis: "down",
        },
        schemaVersion: FACE_ANALYZER_SCHEMA_VERSION,
        track: {
          nominalFrameRate: 29.97,
          persistentTrackId: 2,
          totalVideoTracks: 3,
          videoTrackOrdinal: 1,
        },
      }),
      line({
        durationUs: 33_367,
        event: "frame",
        faces: [
          {
            bounds: { height: 0.3, width: 0.2, x: 0.1, y: 0.15 },
            confidence: 0.91,
            detectionIndex: 0,
          },
          {
            bounds: { height: 0.2, width: 0.15, x: 0.65, y: 0.25 },
            confidence: 0.83,
            detectionIndex: 1,
          },
        ],
        kind: FACE_ANALYZER_KIND,
        ptsUs: 1_234_567,
        sampleIndex: 0,
        schemaVersion: FACE_ANALYZER_SCHEMA_VERSION,
      }),
      line({
        event: "completed",
        faceDetections: 2,
        firstPtsUs: 1_234_567,
        framesAnalyzed: 1,
        framesRead: 1,
        kind: FACE_ANALYZER_KIND,
        lastPtsUs: 1_234_567,
        schemaVersion: FACE_ANALYZER_SCHEMA_VERSION,
      }),
    ].join("\n"));

    expect(events.map(event => event.event)).toEqual(["started", "frame", "completed"]);
    const frame = events[1];
    expect(frame?.event).toBe("frame");
    if (frame?.event === "frame") {
      expect(frame.ptsUs).toBe(1_234_567);
      expect(frame.faces).toHaveLength(2);
      expect(frame.faces.map(face => face.detectionIndex)).toEqual([0, 1]);
    }
  });

  test("rejects boxes that escape the upright normalized frame", () => {
    const malformed = line({
      durationUs: null,
      event: "frame",
      faces: [{
        bounds: { height: 0.4, width: 0.4, x: 0.7, y: 0.1 },
        confidence: 1,
        detectionIndex: 0,
      }],
      kind: FACE_ANALYZER_KIND,
      ptsUs: 1,
      sampleIndex: 0,
      schemaVersion: FACE_ANALYZER_SCHEMA_VERSION,
    });

    expect(() => parseFaceAnalyzerJsonLines(malformed)).toThrow(
      "Normalized face box must remain inside the upright frame.",
    );
  });

  test("rejects unknown terminal errors and oversized JSONL lines", () => {
    expect(() => parseFaceAnalyzerJsonLines(line({
      code: "arbitrary-error",
      event: "error",
      kind: FACE_ANALYZER_KIND,
      message: "unbounded implementation detail",
      schemaVersion: FACE_ANALYZER_SCHEMA_VERSION,
    }))).toThrow();

    const oversized = `"${"x".repeat(MAXIMUM_FACE_ANALYZER_LINE_BYTES)}"`;
    expect(() => parseFaceAnalyzerJsonLines(oversized)).toThrow("empty or oversized");
  });
});
