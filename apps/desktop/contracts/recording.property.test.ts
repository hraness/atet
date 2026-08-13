import { describe, expect } from "bun:test";
import { assertProperty, fc } from "../testing/property";

import {
  CaptureInterruptionSchema,
  RecordingManifestV3Schema,
  RepositoryRelativePathSchema,
} from "./recording";

describe("repository-relative path parsing", () => {
  assertProperty(fc.property(fc.stringMatching(/^[a-z0-9_-]{1,32}$/u), (segment) => {
    expect(RepositoryRelativePathSchema.safeParse(`assets/${segment}`).success).toBe(true);
  }));

  assertProperty(fc.property(fc.string(), (suffix) => {
    expect(RepositoryRelativePathSchema.safeParse(`../${suffix}`).success).toBe(false);
    expect(RepositoryRelativePathSchema.safeParse(`/tmp/${suffix}`).success).toBe(false);
  }));
});

const PERMISSIONS = {
  accessibility: "authorized",
  camera: "authorized",
  inputMonitoring: "authorized",
  microphone: "authorized",
  screenCapture: "authorized",
  systemAudio: "authorized",
  windowMetadata: "authorized",
} as const;

function minimalV3Manifest(
  durationsUs: readonly number[],
  state: "failed" | "recording",
  interruptions: readonly unknown[],
) {
  let nativeFrontierUs = 1_000_000;
  let sourceFrontierUs = 0;
  const segments = durationsUs.map((durationUs, index) => {
    const startNativeUs = nativeFrontierUs + index;
    const startSourceUs = sourceFrontierUs;
    nativeFrontierUs = startNativeUs + durationUs;
    sourceFrontierUs += durationUs;
    return {
      index,
      nativeRange: {
        endUs: nativeFrontierUs,
        startUs: startNativeUs,
      },
      sourceRange: {
        endUs: sourceFrontierUs,
        startUs: startSourceUs,
      },
    };
  });
  return {
    capture: {
      cursor: "metadata",
      typedText: "disabled",
      windowMetadata: "titles-and-bounds",
    },
    coordinateSpace: {
      kind: "global-display-points",
      origin: "top-left",
      xAxis: "right",
      yAxis: "down",
    },
    createdAt: "2026-07-22T12:00:00.000Z",
    diagnostics: [],
    eventStreams: [],
    interruptions,
    kind: "studio.recording-bundle",
    permissions: PERMISSIONS,
    platform: { architecture: "arm64", os: "macos", osVersion: "26.0" },
    recordingId: "rec_property001",
    schemaVersion: 3,
    sources: { audio: [], cameras: [], displays: [] },
    state,
    timeline: {
      durationUs: sourceFrontierUs,
      nativeClock: {
        kind: "mach-continuous-microseconds",
        segments,
      },
      timebase: "microseconds",
    },
    tool: {
      captureVersion: "0.4.0",
      name: "studio",
      version: "0.1.0",
    },
    tracks: [],
    updatedAt: "2026-07-22T12:00:00.000Z",
  } as const;
}

describe("capture interruption frontier laws", () => {
  assertProperty(fc.property(
    fc.array(fc.integer({ max: 1_000_000, min: 1 }), {
      maxLength: 16,
      minLength: 1,
    }),
    fc.nat(),
    (durationsUs, selection) => {
      const base = minimalV3Manifest(durationsUs, "recording", []);
      const segments = base.timeline.nativeClock.segments;
      const segment = segments[selection % segments.length]!;
      const interruption = CaptureInterruptionSchema.parse({
        code: "screen-stream-stopped",
        nativeTimeUs: segment.nativeRange.endUs,
        recoverable: true,
        segmentIndex: segment.index,
        source: "screen",
        sourceId: null,
        sourceTimeUs: segment.sourceRange.endUs,
      });
      expect(RecordingManifestV3Schema.safeParse({
        ...base,
        interruptions: [interruption],
      }).success).toBe(true);
      expect(RecordingManifestV3Schema.safeParse({
        ...base,
        interruptions: [{
          ...interruption,
          sourceTimeUs: interruption.sourceTimeUs + 1,
        }],
      }).success).toBe(false);
      expect(RecordingManifestV3Schema.safeParse({
        ...base,
        interruptions: [{
          ...interruption,
          recoverable: false,
        }],
      }).success).toBe(false);
    },
  ));

  assertProperty(fc.property(
    fc.array(fc.integer({ max: 1_000_000, min: 1 }), {
      maxLength: 16,
    }),
    fc.integer({ max: 1_000_000, min: 0 }),
    (durationsUs, nativeDelayUs) => {
      const base = minimalV3Manifest(durationsUs, "failed", []);
      const last = base.timeline.nativeClock.segments.at(-1);
      const interruption = {
        code: "camera-runtime-error",
        nativeTimeUs: (last?.nativeRange.endUs ?? 0) + nativeDelayUs,
        recoverable: false,
        segmentIndex: (last?.index ?? -1) + 1,
        source: "camera",
        sourceId: "camera-property",
        sourceTimeUs: base.timeline.durationUs,
      } as const;
      expect(RecordingManifestV3Schema.safeParse({
        ...base,
        interruptions: [interruption],
      }).success).toBe(true);
      expect(RecordingManifestV3Schema.safeParse({
        ...base,
        interruptions: [interruption],
        state: "recording",
      }).success).toBe(false);
      expect(RecordingManifestV3Schema.safeParse({
        ...base,
        interruptions: [{
          ...interruption,
          recoverable: true,
        }],
      }).success).toBe(false);
    },
  ));
});
