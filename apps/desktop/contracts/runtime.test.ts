import { expect, test } from "bun:test";

import {
  CaptureRuntimeSnapshotSchema,
  CaptureRuntimeStateSchema,
  CaptureStartOptionsSchema,
  DesktopRequestSchema,
  LEGACY_STUDIO_DESKTOP_PROTOCOL,
  ATET_DESKTOP_PROTOCOL,
  ATET_DESKTOP_PROTOCOL_VERSION,
} from "./runtime";

test("desktop runtime writes the Atet protocol while reading the Studio protocol", () => {
  expect(ATET_DESKTOP_PROTOCOL_VERSION).toBe(3);
  const request = {
    payload: { kind: "snapshot" },
    protocol: ATET_DESKTOP_PROTOCOL,
    requestId: "request_fixture001",
  } as const;
  expect(DesktopRequestSchema.parse({
    ...request,
    protocolVersion: 3,
  }).protocol).toBe("atet.desktop");
  expect(DesktopRequestSchema.parse({
    ...request,
    protocol: LEGACY_STUDIO_DESKTOP_PROTOCOL,
    protocolVersion: 3,
  }).protocol).toBe("studio.desktop");
  expect(() => DesktopRequestSchema.parse({
    ...request,
    protocolVersion: 2,
  })).toThrow();
  expect(() => DesktopRequestSchema.parse({
    ...request,
    protocolVersion: 4,
  })).toThrow();
});

test("runtime snapshots keep selected sources, fresh availability, and interruption evidence distinct", () => {
  const snapshot = {
    availableSources: {
      audioSources: [{ id: "microphone-replacement", kind: "microphone", label: "Replacement microphone" }],
      cameras: [{ id: "camera-replacement", label: "Replacement camera" }],
      displays: [{ id: "display-primary", isPrimary: true, label: "Primary display" }],
    },
    lastInterruption: {
      code: "camera-device-disconnected",
      nativeTimeUs: 12_000_000,
      recoverable: true,
      segmentIndex: 0,
      source: "camera",
      sourceId: "camera-selected",
      sourceTimeUs: 2_000_000,
    },
    permissions: {
      accessibility: "authorized",
      camera: "authorized",
      inputMonitoring: "authorized",
      microphone: "authorized",
      screenCapture: "authorized",
      systemAudio: "authorized",
      windowMetadata: "authorized",
    },
    protocolVersion: 3,
    sources: {
      audioSources: [{ id: "microphone-selected", kind: "microphone", label: "Selected microphone" }],
      cameras: [{ id: "camera-selected", label: "Selected camera" }],
      displays: [{ id: "display-primary", isPrimary: true, label: "Primary display" }],
    },
    state: {
      recordingId: "rec_active001",
      recordingPath: "artifacts/atet/recordings/rec_active001",
      sourceTimeUs: 2_000_000,
      state: "paused",
    },
    updatedAt: "2026-07-25T12:00:00.000Z",
  } as const;

  const parsed = CaptureRuntimeSnapshotSchema.parse(snapshot);
  expect(parsed.protocolVersion).toBe(3);
  expect(parsed.sources.cameras).toEqual([
    { id: "camera-selected", label: "Selected camera" },
  ]);
  expect(parsed.availableSources.cameras).toEqual([
    { id: "camera-replacement", label: "Replacement camera" },
  ]);
  expect(parsed.lastInterruption).toEqual(snapshot.lastInterruption);
  expect(() => CaptureRuntimeSnapshotSchema.parse({
    ...snapshot,
    availableSources: undefined,
  })).toThrow();
  expect(() => CaptureRuntimeSnapshotSchema.parse({
    ...snapshot,
    lastInterruption: undefined,
  })).toThrow();
  expect(() => CaptureRuntimeSnapshotSchema.parse({
    ...snapshot,
    lastInterruption: {
      ...snapshot.lastInterruption,
      path: "/private/native/device",
    },
  })).toThrow();
});

test("start options keep recordings in the repository and typed text disabled unless enabled", () => {
  expect(CaptureStartOptionsSchema.parse({
    camera: { kind: "disabled" },
    displays: { kind: "all" },
    microphone: { kind: "default" },
    recordingDirectory: "artifacts/atet/recordings",
    systemAudio: true,
    typedText: "disabled",
    windowMetadata: "titles-and-bounds",
  }).typedText).toBe("disabled");
  expect(() => CaptureStartOptionsSchema.parse({
    camera: { kind: "disabled" },
    displays: { kind: "all" },
    microphone: { kind: "default" },
    recordingDirectory: "tmp/recordings",
    systemAudio: true,
    typedText: "disabled",
    windowMetadata: "titles-and-bounds",
  })).toThrow();
  expect(() => CaptureStartOptionsSchema.parse({
    camera: { kind: "disabled" },
    displays: { kind: "all" },
    microphone: { kind: "default" },
    recordingDirectory: "artifacts/atet/recordings",
    systemAudio: true,
    typedText: "disabled",
    windowMetadata: "bounds-only",
  })).toThrow();
});

test("start options preserve exact source IDs and reject duplicate or oversized display selections", () => {
  const selected = CaptureStartOptionsSchema.parse({
    camera: { deviceId: "camera-external", kind: "device" },
    displays: {
      displayIds: ["display-left", "display-right"],
      kind: "selected",
    },
    microphone: { deviceId: "microphone-usb", kind: "device" },
    recordingDirectory: "artifacts/atet/recordings",
    systemAudio: false,
    typedText: "disabled",
    windowMetadata: "titles-and-bounds",
  });
  expect(selected).toMatchObject({
    camera: { deviceId: "camera-external", kind: "device" },
    displays: { displayIds: ["display-left", "display-right"], kind: "selected" },
    microphone: { deviceId: "microphone-usb", kind: "device" },
  });
  expect(() => CaptureStartOptionsSchema.parse({
    ...selected,
    displays: { displayIds: ["display-left", "display-left"], kind: "selected" },
  })).toThrow(/unique/u);
  expect(() => CaptureStartOptionsSchema.parse({
    ...selected,
    displays: {
      displayIds: Array.from({ length: 17 }, (_, index) => `display-${String(index)}`),
      kind: "selected",
    },
  })).toThrow();
});

test("recording states cannot lose their active path or elapsed source time", () => {
  expect(() => CaptureRuntimeStateSchema.parse({
    recordingId: "rec_example001",
    state: "stopping",
  })).toThrow();
});
