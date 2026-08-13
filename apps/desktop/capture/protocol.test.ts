import { describe, expect, test } from "bun:test";
import {
  CAPTURE_HELPER_VERSION,
  CAPTURE_PROTOCOL_VERSION,
  CaptureStreamTimingSchema,
  MAX_CAPTURE_SEGMENTS,
  MAX_CAPTURE_SOURCE_ID_BYTES,
  MAX_PROTOCOL_LINE_BYTES,
  encodeCaptureEvent,
  parseCaptureEvent,
  parseCaptureEventLine,
  parseCaptureHelperProbe,
  parseCaptureInterruption,
  parseCaptureRequestLine,
} from "./protocol";

const permissions = {
  accessibility: "authorized",
  camera: "authorized",
  inputMonitoring: "authorized",
  microphone: "authorized",
  screenCapture: "authorized",
  systemAudio: "authorized",
  windowMetadata: "authorized",
} as const;

const options = {
  camera: { deviceId: "camera-1", kind: "device" },
  displays: { displayIds: ["1"], kind: "selected" },
  excludedBundleIdentifiers: ["com.hraness.transmute"],
  interactionEventProcessIdentifier: null,
  metadata: true,
  microphone: { deviceId: "mic-1", kind: "device" },
  strictSources: false,
  systemAudio: true,
  typedText: false,
  typedTextFocusIdentities: null,
} as const;

const typedTextFocusIdentity = {
  fieldId: "transmute-fixture-public-01234567-89ab-4cde-8fab-0123456789ab",
  processId: 42,
  windowId: "9001",
  windowTitle:
    "Transmute Interaction Fixture · 01234567-89ab-4cde-8fab-0123456789ab",
} as const;

const sources = {
  audio: [
    { audioSourceId: "system-audio", channels: 2, kind: "system", label: "System audio", sampleRateHz: 48_000 },
    { audioSourceId: "mic-1", channels: 1, kind: "microphone", label: "Default microphone", sampleRateHz: 48_000 },
  ],
  cameras: [{
    cameraId: "camera-1",
    frameRate: 30,
    label: "Default camera",
    pixelSize: { height: 1_080, width: 1_920 },
    position: "front",
  }],
  displays: [{
    bounds: { height: 1_080, width: 1_920, x: 0, y: 0 },
    displayId: "1",
    isPrimary: true,
    label: "Primary display",
    pixelSize: { height: 2_160, width: 3_840 },
    refreshRateHz: 60,
    scaleFactor: 2,
  }],
} as const;

function streamTiming(
  nativeStartUs: number,
  durationUs: number,
  maximumSampleDurationUs: number,
  firstPtsUs = 0,
) {
  const endPtsUs = firstPtsUs + durationUs;
  return {
    bufferCount: 2,
    clockAnchors: {
      end: { nativeTimeUs: nativeStartUs + durationUs, ptsUs: endPtsUs, uncertaintyUs: 100 },
      first: { nativeTimeUs: nativeStartUs, ptsUs: firstPtsUs, uncertaintyUs: 100 },
    },
    presentation: {
      endPtsUs,
      firstPtsUs,
      lastPtsUs: endPtsUs - maximumSampleDurationUs,
      maximumSampleDurationUs,
    },
    sampleCount: 2,
  };
}

describe("capture helper request protocol", () => {
  test("parses configure from unknown and applies bounded defaults", () => {
    const request = parseCaptureRequestLine(JSON.stringify({
      command: "configure",
      protocolVersion: CAPTURE_PROTOCOL_VERSION,
      requestId: "request-1",
      sessionDirectory: "/tmp/transmute-project/artifacts/transmute/recordings/rec_00000001",
    }));
    expect(request.command).toBe("configure");
    if (request.command !== "configure") throw new Error("Expected configure request.");
    expect(request.sessionDirectory).toStartWith("/tmp/");
  });

  test("rejects unknown fields and unsafe paths", () => {
    expect(() => parseCaptureRequestLine(JSON.stringify({
      command: "start",
      protocolVersion: CAPTURE_PROTOCOL_VERSION,
      requestId: "request-1",
      shell: "rm -rf /",
    }))).toThrow();
    expect(() => parseCaptureRequestLine(JSON.stringify({
      command: "configure",
      protocolVersion: CAPTURE_PROTOCOL_VERSION,
      requestId: "request-1",
      sessionDirectory: "/tmp/../escape",
    }))).toThrow();
  });

  test("retains exact source selections and rejects duplicate or oversized display sets", () => {
    const selected = parseCaptureRequestLine(JSON.stringify({
      command: "configure",
      options,
      protocolVersion: CAPTURE_PROTOCOL_VERSION,
      requestId: "request-selected",
      sessionDirectory: "/tmp/transmute-project/artifacts/transmute/recordings/rec_selected",
    }));
    expect(selected.command === "configure" ? selected.options : null).toMatchObject({
      camera: { deviceId: "camera-1", kind: "device" },
      displays: { displayIds: ["1"], kind: "selected" },
      microphone: { deviceId: "mic-1", kind: "device" },
    });
    expect(() => parseCaptureRequestLine(JSON.stringify({
      command: "configure",
      options: {
        ...options,
        displays: { displayIds: ["1", "1"], kind: "selected" },
      },
      protocolVersion: CAPTURE_PROTOCOL_VERSION,
      requestId: "request-duplicate",
      sessionDirectory: "/tmp/transmute-project/artifacts/transmute/recordings/rec_duplicate",
    }))).toThrow(/unique/u);
    expect(() => parseCaptureRequestLine(JSON.stringify({
      command: "configure",
      options: {
        ...options,
        displays: {
          displayIds: Array.from({ length: 17 }, (_, index) => String(index + 1)),
          kind: "selected",
        },
      },
      protocolVersion: CAPTURE_PROTOCOL_VERSION,
      requestId: "request-too-many",
      sessionDirectory: "/tmp/transmute-project/artifacts/transmute/recordings/rec_too_many",
    }))).toThrow();
  });

  test("strictly binds optional typed text to complete focus identities", () => {
    const request = parseCaptureRequestLine(JSON.stringify({
      command: "configure",
      options: {
        interactionEventProcessIdentifier: typedTextFocusIdentity.processId,
        typedText: true,
        typedTextFocusIdentities: [typedTextFocusIdentity],
      },
      protocolVersion: CAPTURE_PROTOCOL_VERSION,
      requestId: "request-1",
      sessionDirectory: "/tmp/transmute-project/artifacts/transmute/recordings/rec_00000001",
    }));
    expect(request.command === "configure"
      ? request.options?.typedTextFocusIdentities
      : undefined).toEqual([typedTextFocusIdentity]);
    expect(request.command === "configure"
      ? request.options?.interactionEventProcessIdentifier
      : undefined).toBe(typedTextFocusIdentity.processId);

    for (const key of [
      "fieldId",
      "processId",
      "windowId",
      "windowTitle",
    ] as const) {
      const incomplete = Object.fromEntries(
        Object.entries(typedTextFocusIdentity)
          .filter(([candidate]) => candidate !== key),
      );
      expect(() => parseCaptureRequestLine(JSON.stringify({
        command: "configure",
        options: {
          typedText: true,
          typedTextFocusIdentities: [incomplete],
        },
        protocolVersion: CAPTURE_PROTOCOL_VERSION,
        requestId: `missing-${key}`,
        sessionDirectory:
          "/tmp/transmute-project/artifacts/transmute/recordings/rec_00000001",
      }))).toThrow();
    }
    expect(() => parseCaptureRequestLine(JSON.stringify({
      command: "configure",
      options: {
        typedText: true,
        typedTextFocusIdentities: Array.from(
          { length: 17 },
          (_, index) => ({
            ...typedTextFocusIdentity,
            windowId: String(index + 1),
          }),
        ),
      },
      protocolVersion: CAPTURE_PROTOCOL_VERSION,
      requestId: "request-1",
      sessionDirectory: "/tmp/transmute-project/artifacts/transmute/recordings/rec_00000001",
    }))).toThrow();
    expect(() => parseCaptureRequestLine(JSON.stringify({
      command: "configure",
      options: {
        typedText: true,
        typedTextFocusIdentities: [{
          ...typedTextFocusIdentity,
          fieldId: "field\0escape",
        }],
      },
      protocolVersion: CAPTURE_PROTOCOL_VERSION,
      requestId: "request-1",
      sessionDirectory: "/tmp/transmute-project/artifacts/transmute/recordings/rec_00000001",
    }))).toThrow();
    expect(() => parseCaptureRequestLine(JSON.stringify({
      command: "configure",
      options: {
        typedText: true,
        typedTextFocusIdentities: [
          typedTextFocusIdentity,
          typedTextFocusIdentity,
        ],
      },
      protocolVersion: CAPTURE_PROTOCOL_VERSION,
      requestId: "duplicate-focus",
      sessionDirectory:
        "/tmp/transmute-project/artifacts/transmute/recordings/rec_00000001",
    }))).toThrow();
    expect(() => parseCaptureRequestLine(JSON.stringify({
      command: "configure",
      options: {
        interactionEventProcessIdentifier: 0,
      },
      protocolVersion: CAPTURE_PROTOCOL_VERSION,
      requestId: "invalid-process",
      sessionDirectory:
        "/tmp/transmute-project/artifacts/transmute/recordings/rec_00000001",
    }))).toThrow();
  });

  test("bounds focus identity strings by UTF-8 bytes", () => {
    const configure = (identity: unknown) => parseCaptureRequestLine(
      JSON.stringify({
        command: "configure",
        options: {
          typedText: true,
          typedTextFocusIdentities: [identity],
        },
        protocolVersion: CAPTURE_PROTOCOL_VERSION,
        requestId: "utf8-bounds",
        sessionDirectory:
          "/tmp/transmute-project/artifacts/transmute/recordings/rec_00000001",
      }),
    );
    expect(() => configure({
      ...typedTextFocusIdentity,
      fieldId: "🦎".repeat(129),
    })).toThrow();
    expect(() => configure({
      ...typedTextFocusIdentity,
      windowTitle: "🦎".repeat(65),
    })).toThrow();
    expect(() => configure({
      ...typedTextFocusIdentity,
      windowId: "1".repeat(33),
    })).toThrow();
  });

  test("keeps the native option parser aligned to the exact tuple", async () => {
    const source = await Bun.file(
      new URL("./Protocol.swift", import.meta.url),
    ).text();
    const parser = source.indexOf(
      'if let rawFocusIdentities = object["typedTextFocusIdentities"]',
    );
    const processParser = source.indexOf(
      'object["interactionEventProcessIdentifier"]',
      parser,
    );

    expect(parser).toBeGreaterThanOrEqual(0);
    expect(processParser).toBeGreaterThan(parser);
    const focusParser = source.slice(parser, processParser);
    expect(focusParser).toContain(
      'Set(identity.keys) == ["fieldId", "processId", "windowId", "windowTitle"]',
    );
    expect(focusParser).toContain("maximumUTF8Bytes: 512");
    expect(focusParser).toContain("maximumUTF8Bytes: 32");
    expect(focusParser).toContain("maximumUTF8Bytes: 256");
    expect(focusParser).toContain("validPositiveDecimalIdentifier(windowId)");
    expect(focusParser).toContain("unique.count == identities.count");
  });

  test("bounds lines by UTF-8 bytes, not JavaScript character count", () => {
    const oversized = `"${"🦎".repeat(MAX_PROTOCOL_LINE_BYTES / 2)}"`;
    expect(() => parseCaptureRequestLine(oversized)).toThrow(`exceeds ${MAX_PROTOCOL_LINE_BYTES} bytes`);
  });
});

describe("capture interruption value protocol", () => {
  const codesBySource = {
    camera: [
      "camera-device-disconnected",
      "camera-session-interrupted",
      "camera-runtime-error",
      "camera-session-stopped",
      "camera-recording-failed",
    ],
    microphone: [
      "microphone-device-disconnected",
      "microphone-session-interrupted",
      "microphone-runtime-error",
      "microphone-session-stopped",
      "microphone-recording-failed",
    ],
    screen: [
      "selected-display-disconnected",
      "screen-stream-stopped",
      "screen-recording-failed",
    ],
    "system-audio": [
      "system-audio-track-missing",
    ],
  } as const;

  const base = {
    nativeTimeUs: 10_000_123,
    recoverable: true,
    segmentIndex: 0,
    sourceId: "source-1",
    sourceTimeUs: 2_000_123,
  } as const;

  test("parses every owned source and incident code family", () => {
    for (const [source, codes] of Object.entries(codesBySource)) {
      for (const code of codes) {
        const interruption = {
          ...base,
          code,
          source,
          sourceId: source === "system-audio" ? null : `${source}-1`,
        };
        const parsed: unknown = parseCaptureInterruption(interruption);
        expect(parsed).toEqual(interruption);
      }
    }
  });

  test("rejects every cross-family source and code pair", () => {
    const sources = Object.keys(codesBySource);
    for (const [ownedSource, codes] of Object.entries(codesBySource)) {
      for (const source of sources) {
        if (source === ownedSource) continue;
        for (const code of codes) {
          expect(() => parseCaptureInterruption({
            ...base,
            code,
            source,
          })).toThrow();
        }
      }
    }
  });

  test("rejects unknown sources, codes, fields, and non-boolean recovery state", () => {
    expect(() => parseCaptureInterruption({
      ...base,
      code: "screen-stream-stopped",
      source: "display",
    })).toThrow();
    expect(() => parseCaptureInterruption({
      ...base,
      code: "screen-output-vanished",
      source: "screen",
    })).toThrow();
    expect(() => parseCaptureInterruption({
      ...base,
      code: "screen-stream-stopped",
      nativeDetail: "localized native error",
      source: "screen",
    })).toThrow();
    expect(() => parseCaptureInterruption({
      ...base,
      code: "screen-stream-stopped",
      recoverable: "yes",
      source: "screen",
    })).toThrow();
  });

  test("bounds segment indexes and both interruption timestamps", () => {
    const valid = {
      ...base,
      code: "screen-stream-stopped",
      nativeTimeUs: Number.MAX_SAFE_INTEGER,
      segmentIndex: MAX_CAPTURE_SEGMENTS - 1,
      source: "screen",
      sourceTimeUs: Number.MAX_SAFE_INTEGER,
    } as const;
    expect(parseCaptureInterruption(valid)).toEqual(valid);

    for (const segmentIndex of [-1, MAX_CAPTURE_SEGMENTS, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseCaptureInterruption({ ...valid, segmentIndex })).toThrow();
    }
    for (const field of ["nativeTimeUs", "sourceTimeUs"] as const) {
      for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => parseCaptureInterruption({ ...valid, [field]: value })).toThrow();
      }
    }
  });

  test("requires null or a nonempty, non-NUL source ID bounded by UTF-8 bytes", () => {
    const parseWithSourceId = (sourceId: unknown) => parseCaptureInterruption({
      ...base,
      code: "camera-device-disconnected",
      source: "camera",
      sourceId,
    });
    expect(parseWithSourceId(null).sourceId).toBeNull();
    expect(parseWithSourceId("a".repeat(MAX_CAPTURE_SOURCE_ID_BYTES)).sourceId)
      .toHaveLength(MAX_CAPTURE_SOURCE_ID_BYTES);
    expect(parseWithSourceId("🦎".repeat(MAX_CAPTURE_SOURCE_ID_BYTES / 4)).sourceId)
      .toBe("🦎".repeat(MAX_CAPTURE_SOURCE_ID_BYTES / 4));
    expect(() => parseWithSourceId("")).toThrow();
    expect(() => parseWithSourceId("source\0escape")).toThrow();
    expect(() => parseWithSourceId("a".repeat(MAX_CAPTURE_SOURCE_ID_BYTES + 1))).toThrow();
    expect(() => parseWithSourceId("🦎".repeat(MAX_CAPTURE_SOURCE_ID_BYTES / 4 + 1))).toThrow();
    expect(() => parseWithSourceId(42)).toThrow();
  });
});

describe("capture helper event protocol", () => {
  test("strictly parses the probe contract used by hardware verification", () => {
    const probe = parseCaptureHelperProbe({
      availableSources: sources,
      capabilities: {
        availableSources: true,
        camera: true,
        displayRecording: true,
        interruptionDiagnostics: true,
        metadata: true,
        microphone: true,
        minimumMacOSMajorVersion: 15,
        systemAudio: true,
        typedTextOptIn: true,
      },
      helperVersion: CAPTURE_HELPER_VERSION,
      permissions,
      protocolVersion: CAPTURE_PROTOCOL_VERSION,
    });
    expect(probe.protocolVersion).toBe(4);
    expect(() => parseCaptureHelperProbe({ ...probe, helperVersion: "0.3.0" }))
      .toThrow();
    expect(() => parseCaptureHelperProbe({ ...probe, protocolVersion: 3 })).toThrow();
    expect(() => parseCaptureHelperProbe({ ...probe, undeclared: true })).toThrow();
  });

  test("binds stream presentation evidence to ordered native clock anchors", () => {
    const timing = streamTiming(1_000_000, 1_000_000, 16_667, -500_000);
    expect(CaptureStreamTimingSchema.parse(timing)).toEqual(timing);
    expect(() => CaptureStreamTimingSchema.parse({
      ...timing,
      clockAnchors: {
        ...timing.clockAnchors,
        end: { ...timing.clockAnchors.end, ptsUs: timing.clockAnchors.end.ptsUs + 1 },
      },
    })).toThrow(/bind/u);
    expect(() => CaptureStreamTimingSchema.parse({
      ...timing,
      clockAnchors: {
        ...timing.clockAnchors,
        end: {
          ...timing.clockAnchors.end,
          nativeTimeUs: timing.clockAnchors.end.nativeTimeUs + 10_000,
        },
      },
    })).toThrow(/mapping uncertainty/u);
    expect(() => CaptureStreamTimingSchema.parse({ ...timing, bufferCount: 3, sampleCount: 2 }))
      .toThrow(/sampleCount/u);
  });

  test("requires source inventory in configured and status snapshots", () => {
    const configured = parseCaptureEvent({
      availableSources: sources,
      event: "configured",
      lastInterruption: null,
      options,
      permissions,
      protocolVersion: CAPTURE_PROTOCOL_VERSION,
      requestId: "request-1",
      sources,
      state: "ready",
    });
    expect(configured.event).toBe("configured");
    expect(configured).toMatchObject({
      availableSources: sources,
      lastInterruption: null,
      sources,
    });
    expect(() => parseCaptureEvent({ ...configured, availableSources: undefined }))
      .toThrow();
    expect(() => parseCaptureEvent({
      ...configured,
      lastInterruption: {
        code: "screen-stream-stopped",
        nativeTimeUs: 1,
        recoverable: true,
        segmentIndex: 0,
        source: "screen",
        sourceId: null,
        sourceTimeUs: 1,
      },
    })).toThrow(/newly configured/u);
    expect(() => parseCaptureEvent({ ...configured, sources: undefined })).toThrow();
  });

  test("carries post-request permissions and resolved sources on segment start", () => {
    const started = parseCaptureEvent({
      event: "segment-started",
      index: 0,
      nativeStartUs: 10_000_000,
      permissions,
      protocolVersion: CAPTURE_PROTOCOL_VERSION,
      requestId: "request-start",
      sources,
      startUs: 0,
    });
    expect(started).toMatchObject({ event: "segment-started", permissions, sources });
    expect(() => parseCaptureEvent({ ...started, permissions: undefined })).toThrow();
    expect(() => parseCaptureEvent({ ...started, sources: undefined })).toThrow();
  });

  test("parses finalized tracks, offsets, geometry, metadata, and diagnostics", () => {
    const event = parseCaptureEvent({
      event: "segment-completed",
      interruption: null,
      protocolVersion: CAPTURE_PROTOCOL_VERSION,
      requestId: "request-stop",
      segment: {
        camera: {
          availability: "recorded",
          containerDurationUs: 900_000,
          container: "mov",
          deviceId: "camera-1",
          label: "Default camera",
          path: "segments/segment_0001/camera_camera-1.mov",
          streams: [{
            codec: "h264",
            mapping: "exact",
            role: "camera-video",
            streamIndex: 0,
            timing: streamTiming(1_000_100, 900_000, 33_334, 2_000_000),
            trackId: 1,
          }],
        },
        clock: {
          end: { nativeTimeUs: 2_000_000, sourceTimeUs: 1_000_000 },
          kind: "mach-continuous-microseconds",
          start: { nativeTimeUs: 1_000_000, sourceTimeUs: 0 },
        },
        diagnostics: [{
          code: "audio-track-role-provisional",
          message: "Container order is provisional.",
          recoverable: true,
          source: "screen",
        }],
        displays: [{
          containerDurationUs: 1_000_000,
          container: "mp4",
          display: {
            bounds: { height: 1_080, width: 1_920, x: 0, y: 0 },
            displayId: "1",
            isPrimary: true,
            pixelHeight: 2_160,
            pixelWidth: 3_840,
            scaleFactor: 2,
          },
          path: "segments/segment_0001/display_1.mp4",
          streams: [
            {
              codec: "h264",
              mapping: "exact",
              role: "display-video",
              streamIndex: 0,
              timing: streamTiming(1_000_000, 1_000_000, 16_667, -500_000),
              trackId: 1,
            },
            {
              channels: 2,
              codec: "aac",
              mapping: "exact",
              role: "system-audio",
              sampleRateHz: 48_000,
              streamIndex: 1,
              timing: streamTiming(1_000_050, 950_000, 21_334, 3_000_000),
              trackId: 2,
            },
          ],
        }],
        index: 0,
        metadata: [{
          droppedEvents: 0,
          eventKinds: ["cursor.sample"],
          path: "events/segment_0001-cursor.jsonl",
          recordCount: 60,
        }],
        microphone: {
          availability: "recorded",
          containerDurationUs: 950_000,
          container: "m4a",
          deviceId: "microphone-1",
          label: "Default microphone",
          path: "segments/segment_0001/microphone_microphone-1.m4a",
          streams: [{
            channels: 1,
            codec: "aac",
            mapping: "exact",
            role: "microphone-audio",
            sampleRateHz: 48_000,
            streamIndex: 0,
            timing: streamTiming(1_000_050, 950_000, 21_334, 5_000_000),
            trackId: 1,
          }],
        },
        sources,
      },
    });
    expect(event.event).toBe("segment-completed");
    const encoded = encodeCaptureEvent(event);
    expect(encoded.endsWith("\n")).toBeTrue();
    expect(parseCaptureEventLine(encoded.trimEnd())).toEqual(event);
    if (event.event !== "segment-completed") {
      throw new Error("Expected segment completion.");
    }
    const interruption = {
      code: "screen-stream-stopped",
      nativeTimeUs: event.segment.clock.end.nativeTimeUs,
      recoverable: true,
      segmentIndex: event.segment.index,
      source: "screen",
      sourceId: event.segment.displays[0]!.display.displayId,
      sourceTimeUs: event.segment.clock.end.sourceTimeUs,
    } as const;
    const interrupted = parseCaptureEvent({ ...event, interruption });
    expect(
      interrupted.event === "segment-completed"
        ? interrupted.interruption
        : null,
    ).toEqual(interruption);
    for (const invalidInterruption of [
      { ...interruption, nativeTimeUs: interruption.nativeTimeUs - 1 },
      { ...interruption, recoverable: false },
      { ...interruption, segmentIndex: interruption.segmentIndex + 1 },
      { ...interruption, sourceTimeUs: interruption.sourceTimeUs - 1 },
    ]) {
      expect(() => parseCaptureEvent({
        ...event,
        interruption: invalidInterruption,
      })).toThrow(/clock-end|recoverable/u);
    }
  });

  test("requires nullable interruption evidence on errors and binds recovery state", () => {
    const error = {
      code: "screen-finalization-failed",
      event: "error",
      interruption: {
        code: "screen-recording-failed",
        nativeTimeUs: 2_000_000,
        recoverable: false,
        segmentIndex: 0,
        source: "screen",
        sourceId: "1",
        sourceTimeUs: 0,
      },
      message: "Display recording could not be finalized.",
      protocolVersion: CAPTURE_PROTOCOL_VERSION,
      recoverable: false,
      requestId: "request-error",
      state: "stopped",
    } as const;
    expect(parseCaptureEvent(error)).toEqual(error);
    expect(() => parseCaptureEvent({
      ...error,
      interruption: undefined,
    })).toThrow();
    expect(() => parseCaptureEvent({
      ...error,
      recoverable: true,
    })).toThrow(/recovery state/u);
  });

  test("rejects duration-zero recorded media and microphone roles inside display containers", () => {
    const valid = parseCaptureEvent({
      event: "segment-completed",
      interruption: null,
      protocolVersion: CAPTURE_PROTOCOL_VERSION,
      requestId: "request-stop",
      segment: {
        camera: { availability: "unavailable", reason: "disabled" },
        clock: {
          end: { nativeTimeUs: 1_010, sourceTimeUs: 1_000 },
          kind: "mach-continuous-microseconds",
          start: { nativeTimeUs: 10, sourceTimeUs: 0 },
        },
        diagnostics: [],
        displays: [{
          containerDurationUs: 1_000,
          container: "mp4",
          display: {
            bounds: { height: 1_080, width: 1_920, x: 0, y: 0 },
            displayId: "1",
            isPrimary: true,
            pixelHeight: 2_160,
            pixelWidth: 3_840,
            scaleFactor: 2,
          },
          path: "segments/segment_0001/display_1.mp4",
          streams: [{
            codec: "h264",
            mapping: "exact",
            role: "display-video",
            streamIndex: 0,
            timing: streamTiming(10, 1_000, 100),
          }],
        }],
        index: 0,
        metadata: [],
        microphone: { availability: "unavailable", reason: "disabled" },
        sources: { audio: [], cameras: [], displays: sources.displays },
      },
    });
    if (valid.event !== "segment-completed") throw new Error("Expected a segment completion fixture.");
    expect(() => parseCaptureEvent({
      ...valid,
      segment: {
        ...valid.segment,
        displays: [{ ...valid.segment.displays[0]!, containerDurationUs: 0 }],
      },
    })).toThrow();
    expect(() => parseCaptureEvent({
      ...valid,
      segment: {
        ...valid.segment,
        displays: [{
          ...valid.segment.displays[0]!,
          streams: [{
            ...valid.segment.displays[0]!.streams[0]!,
            codec: "aac",
            mapping: "provisional",
            role: "microphone-audio",
          }],
        }],
      },
    })).toThrow();
    const withUnclassified = parseCaptureEvent({
      ...valid,
      segment: {
        ...valid.segment,
        displays: [{
          ...valid.segment.displays[0]!,
          streams: [
            ...valid.segment.displays[0]!.streams,
            {
              channels: 2,
              codec: "aac",
              mapping: "provisional",
              role: "unclassified-audio",
              streamIndex: 1,
            },
          ],
        }],
      },
    });
    expect(withUnclassified.event).toBe("segment-completed");
    if (withUnclassified.event !== "segment-completed") throw new Error("Expected segment completion.");
    expect(() => parseCaptureEvent({
      ...withUnclassified,
      segment: {
        ...withUnclassified.segment,
        displays: [{
          ...withUnclassified.segment.displays[0]!,
          streams: withUnclassified.segment.displays[0]!.streams.map(stream => (
            stream.role === "unclassified-audio" ? { ...stream, timing: streamTiming(10, 1_000, 100) } : stream
          )),
        }],
      },
    })).toThrow();
    expect(() => parseCaptureEvent({
      ...valid,
      segment: {
        ...valid.segment,
        displays: [{
          ...valid.segment.displays[0]!,
          streams: [{
            codec: "h264",
            mapping: "exact",
            role: "display-video",
            streamIndex: 0,
          }],
        }],
      },
    })).toThrow();
  });

  test("rejects undeclared completion fields", () => {
    expect(() => parseCaptureEvent({
      availableSources: sources,
      event: "status",
      activeSegmentIndex: null,
      completedSegmentCount: 0,
      lastInterruption: null,
      logicalTimeUs: 0,
      permissions,
      protocolVersion: CAPTURE_PROTOCOL_VERSION,
      requestId: "request-1",
      sources,
      state: "ready",
      rawDeviceSecret: "nope",
    })).toThrow();
  });
});
