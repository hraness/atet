import { describe, expect, test } from "bun:test";

import {
  RecordingDiagnosticSchema,
  RecordingEventV1Schema,
  RecordingManifestSchema,
  RecordingManifestV1Schema,
  RecordingManifestV2Schema,
  RecordingManifestV3Schema,
} from "./recording";
import { testManifest } from "../core/test-support";

function rawLegacyManifest() {
  const manifest = testManifest();
  if (manifest.schemaVersion !== 1) throw new Error("Expected the legacy fixture.");
  return {
    ...manifest,
    diagnostics: manifest.diagnostics.filter(({ code }) => code !== "legacy-capture-timing"),
    tracks: manifest.tracks.map(track => ({
      ...track,
      segments: track.segments.map(segment => {
        if (segment.timing.kind !== "legacy-estimate") throw new Error("Expected legacy timing.");
        const { fileRange, timing, ...identity } = segment;
        void fileRange;
        return {
          ...identity,
          nativeEndUs: timing.nativeRange.endUs,
          nativeStartUs: timing.nativeRange.startUs,
        };
      }),
    })),
  };
}

function measuredManifest() {
  const legacy = testManifest();
  if (legacy.schemaVersion !== 1) throw new Error("Expected the legacy fixture.");
  const referenceTrackId = legacy.tracks[0]!.trackId;
  return RecordingManifestV2Schema.parse({
    ...legacy,
    diagnostics: legacy.diagnostics.filter(({ code }) => code !== "legacy-capture-timing"),
    schemaVersion: 2,
    timeline: {
      durationUs: 10_000_000,
      nativeClock: {
        kind: "mach-continuous-microseconds",
        segments: [{
          index: 0,
          nativeRange: { endUs: 11_000_000, startUs: 1_000_000 },
          sourceRange: { endUs: 10_000_000, startUs: 0 },
        }],
      },
      timebase: "microseconds",
    },
    tracks: legacy.tracks.map(track => ({
      ...track,
      segments: track.segments.map(segment => ({
        ...segment,
        timing: {
          captureSegmentIndex: 0,
          durationDriftPpm: 0,
          durationDriftUs: 0,
          evidence: {
            file: {
              containerOriginPtsUs: 100_000,
              endPtsUs: 10_100_000,
              firstPtsUs: 100_000,
              spanToleranceUs: 33_334,
              tickUs: 1,
            },
            helper: {
              bufferCount: 300,
              clockAnchors: {
                end: { nativeTimeUs: 11_000_000, ptsUs: 15_000_000, uncertaintyUs: 100 },
                first: { nativeTimeUs: 1_000_000, ptsUs: 5_000_000, uncertaintyUs: 100 },
              },
              containerDurationUs: 10_000_000,
              presentation: {
                endPtsUs: 15_000_000,
                firstPtsUs: 5_000_000,
                lastPtsUs: 14_966_666,
                maximumSampleDurationUs: 33_334,
              },
              sampleCount: 300,
            },
          },
          kind: "measured",
          nativeRange: { endUs: 11_000_000, startUs: 1_000_000 },
          onsetSkewUs: 0,
          policy: "capture-sync-v1",
          presentation: {
            endPtsUs: 15_000_000,
            firstPtsUs: 5_000_000,
            lastPtsUs: 14_966_666,
          },
          referenceTrackId,
          status: "within-tolerance",
          tolerance: { durationDriftUs: 67_068, onsetSkewUs: 50_000 },
        },
      })),
    })),
  });
}

function v3Manifest() {
  const manifest = measuredManifest();
  return RecordingManifestV3Schema.parse({
    ...manifest,
    schemaVersion: 3,
  });
}

function screenInterruption(
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    code: "screen-stream-stopped",
    nativeTimeUs: 11_000_000,
    recoverable: true,
    segmentIndex: 0,
    source: "screen",
    sourceId: "display-primary",
    sourceTimeUs: 10_000_000,
    ...overrides,
  } as const;
}

describe("recording bundle manifest", () => {
  test("accepts canonical and matching legacy product identities", () => {
    const legacy = testManifest();
    expect(RecordingManifestSchema.parse(legacy).kind).toBe("studio.recording-bundle");

    const canonical = RecordingManifestSchema.parse({
      ...legacy,
      kind: "transmute.recording-bundle",
      tool: { ...legacy.tool, name: "transmute" },
    });
    expect(canonical.kind).toBe("transmute.recording-bundle");
    expect(canonical.tool.name).toBe("transmute");

    expect(() => RecordingManifestSchema.parse({
      ...legacy,
      kind: "transmute.recording-bundle",
    })).toThrow(/same product identity/u);
  });

  test("allows shared containers when logical tracks use different stream indices", () => {
    const manifest = testManifest();
    expect(manifest.tracks.filter(({ segments }) => segments[0]?.path === "media/segment-1.mp4")).toHaveLength(3);
    expect(() => RecordingManifestV1Schema.parse(manifest)).not.toThrow();
  });

  test("rejects duplicate path and stream-index mappings", () => {
    const manifest = testManifest();
    const microphone = manifest.tracks.find(({ kind }) => kind === "microphone-audio");
    expect(microphone).toBeDefined();
    const tracks = manifest.tracks.map((track) => track.kind === "microphone-audio"
      ? { ...track, segments: track.segments.map((segment) => ({ ...segment, streamIndex: 1 })) }
      : track);
    expect(() => RecordingManifestV1Schema.parse({ ...manifest, tracks })).toThrow(/path and stream-index/u);
  });

  test("declares one global display space and retains a negative-X display", () => {
    const manifest = testManifest();
    expect(manifest.coordinateSpace).toEqual({
      kind: "global-display-points",
      origin: "top-left",
      xAxis: "right",
      yAxis: "down",
    });
    expect(manifest.sources.displays.find(({ displayId }) => displayId === "display-left")?.bounds.x).toBe(-1280);
  });

  test("rejects duplicate source inventory identities", () => {
    const manifest = testManifest();
    expect(() => RecordingManifestV1Schema.parse({
      ...manifest,
      sources: {
        ...manifest.sources,
        displays: [...manifest.sources.displays, manifest.sources.displays[0]],
      },
    })).toThrow(/Display source IDs/u);
  });

  test("defaults typed-text capture to disabled", () => {
    const manifest = testManifest();
    const capture = {
      cursor: manifest.capture.cursor,
      windowMetadata: manifest.capture.windowMetadata,
    };
    expect(RecordingManifestV1Schema.parse({ ...manifest, capture }).capture.typedText).toBe("disabled");
  });

  test("requires one primary display and verified files once stopped", () => {
    const manifest = testManifest();
    expect(() => RecordingManifestV1Schema.parse({
      ...manifest,
      sources: {
        ...manifest.sources,
        displays: manifest.sources.displays.map((display) => ({ ...display, isPrimary: false })),
      },
    })).toThrow(/exactly one primary/u);
    expect(() => RecordingManifestV1Schema.parse({
      ...manifest,
      tracks: manifest.tracks.map((track, index) => index === 0
        ? { ...track, segments: track.segments.map((segment) => ({ ...segment, integrity: { state: "pending" } })) }
        : track),
    })).toThrow(/verified integrity/u);
  });

  test("keeps event ranges inside the timeline and separate from media paths", () => {
    const manifest = testManifest();
    const eventStream = {
      endUs: manifest.timeline.durationUs,
      eventKinds: ["cursor.sample"],
      eventStreamId: "events_example01",
      integrity: { bytes: 1, sha256: "0".repeat(64), state: "verified" },
      path: "events/cursor.jsonl",
      recordCount: 1,
      startUs: 0,
    } as const;
    expect(() => RecordingManifestV1Schema.parse({
      ...manifest,
      eventStreams: [{ ...eventStream, endUs: manifest.timeline.durationUs + 1 }],
    })).toThrow(/recording timeline/u);
    expect(() => RecordingManifestV1Schema.parse({
      ...manifest,
      eventStreams: [{ ...eventStream, path: manifest.tracks[0]?.segments[0]?.path }],
    })).toThrow(/must not share/u);
  });

  test("orders paired diagnostic source-time bounds", () => {
    expect(() => RecordingDiagnosticSchema.parse({
      code: "bad-range",
      count: 1,
      firstSourceTimeUs: 20,
      lastSourceTimeUs: 10,
      level: "warning",
      message: "bad",
    })).toThrow(/cannot precede/u);
    expect(() => RecordingDiagnosticSchema.parse({
      code: "half-range",
      count: 1,
      firstSourceTimeUs: 10,
      lastSourceTimeUs: null,
      level: "warning",
      message: "bad",
    })).toThrow(/both be null/u);
  });

  test("normalizes raw v1 timing honestly and records the compatibility diagnostic", () => {
    const manifest = RecordingManifestSchema.parse(rawLegacyManifest());
    expect(manifest.schemaVersion).toBe(1);
    const segment = manifest.tracks[0]!.segments[0]!;
    expect(segment.fileRange).toEqual({ endUs: 10_000_000, startUs: 0 });
    expect(segment.timing).toEqual({
      kind: "legacy-estimate",
      nativeRange: { endUs: 11_000_000, startUs: 1_000_000 },
      reason: "recording-manifest-v1-container-duration",
    });
    expect(manifest.diagnostics.find(({ code }) => code === "legacy-capture-timing")).toMatchObject({
      count: 1,
      level: "warning",
    });
    const normalizedWithoutDiagnostic = RecordingManifestSchema.parse({
      ...manifest,
      diagnostics: [],
    });
    expect(normalizedWithoutDiagnostic.diagnostics.map(({ code }) => code))
      .toContain("legacy-capture-timing");
    expect(() => RecordingManifestSchema.parse({
      ...rawLegacyManifest(),
      diagnostics: "corrupt",
    })).toThrow();
  });

  test("round-trips a measured v2 manifest with raw helper and file evidence", () => {
    const manifest = measuredManifest();
    expect(RecordingManifestSchema.parse(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
    expect(manifest.interruptions).toEqual([]);
    expect(manifest.tracks[0]!.segments[0]!.timing).toMatchObject({
      durationDriftUs: 0,
      kind: "measured",
      onsetSkewUs: 0,
      policy: "capture-sync-v1",
      status: "within-tolerance",
    });
  });

  test("migrates v1 and v2 manifests to explicit empty interruption histories", () => {
    const { interruptions: legacyInterruptions, ...legacy } =
      rawLegacyManifest();
    void legacyInterruptions;
    expect(RecordingManifestSchema.parse(legacy).interruptions).toEqual([]);
    expect(() => RecordingManifestSchema.parse({
      ...legacy,
      interruptions: [screenInterruption()],
    })).toThrow();

    const measured = measuredManifest();
    const { interruptions: measuredInterruptions, ...rawV2 } = measured;
    void measuredInterruptions;
    expect(RecordingManifestSchema.parse(rawV2)).toMatchObject({
      interruptions: [],
      schemaVersion: 2,
    });
    expect(() => RecordingManifestV2Schema.parse({
      ...rawV2,
      interruptions: [screenInterruption()],
    })).toThrow();
  });

  test("binds v3 completed interruptions to their exact segment clock ends", () => {
    const manifest = v3Manifest();
    expect(RecordingManifestV3Schema.parse({
      ...manifest,
      interruptions: [screenInterruption()],
    }).interruptions).toEqual([screenInterruption()]);

    for (const interruption of [
      screenInterruption({ nativeTimeUs: 10_999_999 }),
      screenInterruption({ recoverable: false }),
      screenInterruption({ sourceTimeUs: 9_999_999 }),
      screenInterruption({ segmentIndex: 1 }),
    ]) {
      expect(() => RecordingManifestV3Schema.parse({
        ...manifest,
        interruptions: [interruption],
      })).toThrow(/clock end|prepared-start/u);
    }
  });

  test("allows one failed prepared-start interruption only at the persisted frontier", () => {
    const manifest = v3Manifest();
    const prepared = screenInterruption({
      nativeTimeUs: 12_000_000,
      recoverable: false,
      segmentIndex: 1,
    });
    expect(RecordingManifestV3Schema.parse({
      ...manifest,
      interruptions: [prepared],
      state: "failed",
    }).interruptions).toEqual([prepared]);

    for (const candidate of [
      { ...manifest, interruptions: [prepared], state: "recording" },
      {
        ...manifest,
        interruptions: [{ ...prepared, segmentIndex: 2 }],
        state: "failed",
      },
      {
        ...manifest,
        interruptions: [{ ...prepared, sourceTimeUs: 10_000_001 }],
        state: "failed",
      },
      {
        ...manifest,
        interruptions: [{ ...prepared, nativeTimeUs: 10_999_999 }],
        state: "failed",
      },
      {
        ...manifest,
        interruptions: [{ ...prepared, recoverable: true }],
        state: "failed",
      },
      {
        ...manifest,
        interruptions: [prepared],
        state: "failed",
        timeline: { ...manifest.timeline, durationUs: 10_000_001 },
      },
    ]) {
      expect(() => RecordingManifestV3Schema.parse(candidate))
        .toThrow(/persisted capture frontier/u);
    }
  });

  test("orders v3 interruptions and permits at most one per segment", () => {
    const manifest = v3Manifest();
    const completed = screenInterruption();
    const prepared = screenInterruption({
      code: "screen-recording-failed",
      nativeTimeUs: 12_000_000,
      recoverable: false,
      segmentIndex: 1,
    });
    expect(() => RecordingManifestV3Schema.parse({
      ...manifest,
      interruptions: [completed, prepared],
      state: "failed",
    })).not.toThrow();
    expect(() => RecordingManifestV3Schema.parse({
      ...manifest,
      interruptions: [prepared, completed],
      state: "failed",
    })).toThrow(/ordered/u);
    expect(() => RecordingManifestV3Schema.parse({
      ...manifest,
      interruptions: [completed, {
        ...completed,
        code: "screen-recording-failed",
      }],
    })).toThrow(/at most one/u);
  });

  test("permits each capture segment to name its own display timing reference", () => {
    const manifest = measuredManifest();
    const alternateReferenceTrack = manifest.tracks.find(
      track => track.kind === "display-video"
        && track.source.displayId === "display-left",
    );
    expect(alternateReferenceTrack).toBeDefined();
    const referenceTrackId = alternateReferenceTrack!.trackId;
    const tracks = manifest.tracks.map(track => ({
      ...track,
      segments: track.segments.map(segment => {
        if (segment.timing.kind !== "measured") {
          throw new Error("Expected measured timing.");
        }
        return {
          ...segment,
          timing: { ...segment.timing, referenceTrackId },
        };
      }),
    }));

    expect(() => RecordingManifestV2Schema.parse({
      ...manifest,
      tracks,
    })).not.toThrow();
  });

  test("rejects v2 timing without raw evidence or with an unknown reference track", () => {
    const manifest = measuredManifest();
    const firstTrack = manifest.tracks[0]!;
    const firstSegment = firstTrack.segments[0]!;
    if (firstSegment.timing.kind !== "measured") throw new Error("Expected measured timing.");
    const { evidence, ...summaryOnly } = firstSegment.timing;
    void evidence;
    expect(() => RecordingManifestV2Schema.parse({
      ...manifest,
      tracks: [{ ...firstTrack, segments: [{ ...firstSegment, timing: summaryOnly }] }, ...manifest.tracks.slice(1)],
    })).toThrow();
    expect(() => RecordingManifestV2Schema.parse({
      ...manifest,
      tracks: [{
        ...firstTrack,
        segments: [{
          ...firstSegment,
          timing: { ...firstSegment.timing, referenceTrackId: "track_missing001" },
        }],
      }, ...manifest.tracks.slice(1)],
    })).toThrow(/unknown track/u);
  });

  test("rejects noncontiguous or native-out-of-order v2 clock segments", () => {
    const manifest = measuredManifest();
    expect(() => RecordingManifestV2Schema.parse({
      ...manifest,
      timeline: {
        ...manifest.timeline,
        nativeClock: {
          kind: "mach-continuous-microseconds",
          segments: [
            {
              index: 0,
              nativeRange: { endUs: 6_000_000, startUs: 1_000_000 },
              sourceRange: { endUs: 5_000_000, startUs: 0 },
            },
            {
              index: 1,
              nativeRange: { endUs: 12_000_000, startUs: 7_000_000 },
              sourceRange: { endUs: 9_000_000, startUs: 4_000_000 },
            },
          ],
        },
      },
    })).toThrow(/contiguous/u);
    expect(() => RecordingManifestV2Schema.parse({
      ...manifest,
      timeline: {
        ...manifest.timeline,
        nativeClock: {
          kind: "mach-continuous-microseconds",
          segments: [
            {
              index: 0,
              nativeRange: { endUs: 6_000_000, startUs: 1_000_000 },
              sourceRange: { endUs: 5_000_000, startUs: 0 },
            },
            {
              index: 1,
              nativeRange: { endUs: 10_500_000, startUs: 5_500_000 },
              sourceRange: { endUs: 10_000_000, startUs: 5_000_000 },
            },
          ],
        },
      },
    })).toThrow(/ordered and non-overlapping/u);
  });

  test("rejects a measured status that disagrees with its explicit tolerances", () => {
    const manifest = measuredManifest();
    const firstTrack = manifest.tracks[0]!;
    const firstSegment = firstTrack.segments[0]!;
    if (firstSegment.timing.kind !== "measured") throw new Error("Expected measured timing.");
    expect(() => RecordingManifestV2Schema.parse({
      ...manifest,
      tracks: [{
        ...firstTrack,
        segments: [{
          ...firstSegment,
          timing: { ...firstSegment.timing, status: "out-of-tolerance" },
        }],
      }, ...manifest.tracks.slice(1)],
    })).toThrow(/status/u);
  });

  test("recomputes measured synchronization and binds normalized file evidence", () => {
    const manifest = measuredManifest();
    const firstTrack = manifest.tracks[0]!;
    const firstSegment = firstTrack.segments[0]!;
    if (firstSegment.timing.kind !== "measured") throw new Error("Expected measured timing.");
    const timing = firstSegment.timing;
    expect(() => RecordingManifestV2Schema.parse({
      ...manifest,
      tracks: [{
        ...firstTrack,
        segments: [{
          ...firstSegment,
          timing: { ...timing, onsetSkewUs: 1 },
        }],
      }, ...manifest.tracks.slice(1)],
    })).toThrow(/capture-timing-evidence-mismatch/u);
    expect(() => RecordingManifestV2Schema.parse({
      ...manifest,
      tracks: [{
        ...firstTrack,
        segments: [{
          ...firstSegment,
          endUs: 9_000_000,
          fileRange: { endUs: 9_000_000, startUs: 1_000_000 },
          startUs: 1_000_000,
        }],
      }, ...manifest.tracks.slice(1)],
    })).toThrow(/media placement/u);
    expect(() => RecordingManifestV2Schema.parse({
      ...manifest,
      tracks: [{
        ...firstTrack,
        segments: [{
          ...firstSegment,
          timing: {
            ...timing,
            tolerance: {
              durationDriftUs: timing.tolerance.durationDriftUs + 1,
              onsetSkewUs: timing.tolerance.onsetSkewUs,
            },
          },
        }],
      }, ...manifest.tracks.slice(1)],
    })).toThrow(/tolerances do not match/u);
    expect(() => RecordingManifestV2Schema.parse({
      ...manifest,
      tracks: [{
        ...firstTrack,
        segments: [{
          ...firstSegment,
          timing: {
            ...timing,
            evidence: {
              ...timing.evidence,
              file: {
                ...timing.evidence.file,
                spanToleranceUs: timing.evidence.file.spanToleranceUs + 10_000_000,
              },
            },
          },
        }],
      }, ...manifest.tracks.slice(1)],
    })).toThrow(/span tolerance/u);
    expect(() => RecordingManifestV2Schema.parse({
      ...manifest,
      tracks: [{
        ...firstTrack,
        segments: [{
          ...firstSegment,
          timing: {
            ...timing,
            evidence: {
              ...timing.evidence,
              helper: {
                ...timing.evidence.helper,
                clockAnchors: {
                  ...timing.evidence.helper.clockAnchors,
                  end: {
                    ...timing.evidence.helper.clockAnchors.end,
                    nativeTimeUs: timing.evidence.helper.clockAnchors.end.nativeTimeUs + 10_000,
                  },
                },
              },
            },
            nativeRange: {
              ...timing.nativeRange,
              endUs: timing.nativeRange.endUs + 10_000,
            },
          },
        }],
      }, ...manifest.tracks.slice(1)],
    })).toThrow(/mapping uncertainty/u);
    expect(() => RecordingManifestV2Schema.parse({
      ...manifest,
      tracks: [{
        ...firstTrack,
        segments: [{
          ...firstSegment,
          timing: { ...timing, captureSegmentIndex: 1 },
        }],
      }, ...manifest.tracks.slice(1)],
    })).toThrow(/unknown capture clock segment/u);
    expect(() => RecordingManifestV2Schema.parse({
      ...manifest,
      tracks: [{
        ...firstTrack,
        segments: [{
          ...firstSegment,
          timing: { ...timing, referenceTrackId: manifest.tracks[2]!.trackId },
        }],
      }, ...manifest.tracks.slice(1)],
    })).toThrow(/display-video/u);
  });
});

describe("privacy-safe metadata events", () => {
  const base = { nativeTimeUs: 2, sequence: 1, sourceTimeUs: 1, type: "typing.input" } as const;
  const bounds = { height: 20, width: 100, x: 10, y: 20 };

  test("rejects every per-keystroke secure typing marker", () => {
    expect(() => RecordingEventV1Schema.parse({
      ...base,
      input: {
        action: "redacted",
        bounds,
        fieldId: "[REDACTED]",
        secure: true,
        text: "[REDACTED]",
        windowId: "window-1",
      },
    })).toThrow();
  });

  test("rejects password length and literal secure text", () => {
    expect(() => RecordingEventV1Schema.parse({
      ...base,
      input: {
        action: "redacted",
        bounds,
        characterCount: 8,
        fieldId: "[REDACTED]",
        secure: true,
        text: "[REDACTED]",
        windowId: "window-1",
      },
    })).toThrow();
    expect(() => RecordingEventV1Schema.parse({
      ...base,
      input: {
        action: "redacted",
        bounds,
        fieldId: "[REDACTED]",
        secure: true,
        text: "hunter2",
        windowId: "window-1",
      },
    })).toThrow();
  });

  test("printable key activity cannot carry a literal", () => {
    expect(() => RecordingEventV1Schema.parse({
      activity: {
        key: "a",
        kind: "printable",
        modifiers: [],
        phase: "down",
        repeat: false,
        token: "[PRINTABLE]",
      },
      nativeTimeUs: 2,
      sequence: 1,
      sourceTimeUs: 1,
      type: "key.activity",
    })).toThrow();
  });
});
