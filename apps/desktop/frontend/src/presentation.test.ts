import { describe, expect, test } from "bun:test";

import {
  CaptureRuntimeSnapshotSchema,
  CaptureRuntimeStateSchema,
  type CaptureRuntimeSnapshot,
  type CaptureRuntimeState,
} from "../../contracts";
import {
  commandErrorMessage,
  connectionErrorMessage,
  formatElapsed,
  presentationForSnapshot,
  presentationForState,
  sourcePresentation,
  unavailableSourceMessages,
  type RecorderAction,
} from "./presentation";

describe("recorder presentation", () => {
  test("exposes only legal controls for each authoritative state", () => {
    const cases: readonly [CaptureRuntimeState, readonly RecorderAction[]][] = [
      [CaptureRuntimeStateSchema.parse({ lastRecording: null, state: "idle" }), ["start"]],
      [CaptureRuntimeStateSchema.parse({ commandId: "command_start001", recordingPath: "artifacts/transmute/recordings/rec_pending01", state: "starting" }), []],
      [CaptureRuntimeStateSchema.parse({ recordingId: "rec_active001", recordingPath: "artifacts/transmute/recordings/rec_active001", sourceTimeUs: 5, state: "recording" }), ["pause", "stop"]],
      [CaptureRuntimeStateSchema.parse({ recordingId: "rec_active001", recordingPath: "artifacts/transmute/recordings/rec_active001", sourceTimeUs: 5, state: "paused" }), ["resume", "stop"]],
      [CaptureRuntimeStateSchema.parse({ commandId: "command_stop0001", recordingId: "rec_active001", recordingPath: "artifacts/transmute/recordings/rec_active001", sourceTimeUs: 5, state: "stopping" }), []],
      [CaptureRuntimeStateSchema.parse({ code: "capture-session-failed", message: "raw", recordingId: "rec_active001", recordingPath: "artifacts/transmute/recordings/rec_active001", sourceTimeUs: 5, state: "failed" }), ["start"]],
      [CaptureRuntimeStateSchema.parse({ code: "repository-not-configured", message: "raw", recordingId: null, recordingPath: null, sourceTimeUs: null, state: "failed" }), []],
    ];
    for (const [state, actions] of cases) expect(presentationForState(state).allowedActions).toEqual(actions);
  });

  test("formats bounded elapsed time without wall-clock dates", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(65_900_000)).toBe("01:05");
    expect(formatElapsed(3_665_000_000)).toBe("01:01:05");
  });

  test("puts permission-driven source failures beside the affected source", () => {
    const snapshot = CaptureRuntimeSnapshotSchema.parse({
      availableSources: {
        audioSources: [{ id: "audio_system01", kind: "system", label: "Mac system audio" }],
        cameras: [],
        displays: [{ id: "display_builtin01", isPrimary: true, label: "Built-in display" }],
      },
      lastInterruption: null,
      permissions: {
        accessibility: "authorized",
        camera: "unavailable",
        inputMonitoring: "authorized",
        microphone: "denied",
        screenCapture: "authorized",
        systemAudio: "authorized",
        windowMetadata: "restricted",
      },
      protocolVersion: 3,
      sources: { audioSources: [], cameras: [], displays: [] },
      state: { lastRecording: null, state: "idle" },
      updatedAt: "2026-07-22T12:00:00.000Z",
    });
    expect(sourcePresentation(snapshot)).toEqual({
      audio: "Mac system audio · Microphone (denied)",
      camera: "Camera (unavailable)",
      displayCount: 1,
      displays: "Built-in display",
      metadata: "Windows (restricted) · Cursor and clicks · Focus",
    });
    expect(unavailableSourceMessages(snapshot)).toContain("Window metadata: restricted");
  });

  test("explains an automatic pause without leaking native interruption evidence and keeps explicit resume legal", () => {
    const snapshot = interruptedSnapshot({
      code: "camera-device-disconnected",
      nativeTimeUs: 93_000_000,
      recoverable: true,
      segmentIndex: 7,
      source: "camera",
      sourceId: "camera/private-hardware-id",
      sourceTimeUs: 3_000_000,
    });

    expect(presentationForSnapshot(snapshot)).toEqual({
      allowedActions: ["resume", "stop"],
      elapsedUs: 3_000_000,
      label: "Camera disconnected — segment saved; resume when ready",
      path: "artifacts/transmute/recordings/rec_active001",
      tone: "pending",
    });
    const label = presentationForSnapshot(snapshot).label;
    expect(label).not.toContain("private-hardware-id");
    expect(label).not.toContain("93000000");
    expect(label).not.toContain("segmentIndex");
  });

  test("keeps frozen selections visible while showing fresh replacements separately", () => {
    const snapshot = interruptedSnapshot({
      code: "camera-device-disconnected",
      nativeTimeUs: 13_000_000,
      recoverable: true,
      segmentIndex: 0,
      source: "camera",
      sourceId: "camera-selected",
      sourceTimeUs: 3_000_000,
    });

    expect(sourcePresentation(snapshot)).toEqual({
      audio: "System audio · Selected microphone (not available now) · Available now: Replacement microphone",
      camera: "Selected camera (not available now) · Available now: Replacement camera",
      displayCount: 2,
      displays: "Selected display · Available now: Newly connected display",
      metadata: "Windows · Cursor and clicks · Focus",
    });
  });

  test("uses owned source-specific failure copy and never offers resume", () => {
    const paused = interruptedSnapshot({
      code: "screen-recording-failed",
      nativeTimeUs: 12_000_000,
      recoverable: false,
      segmentIndex: 0,
      source: "screen",
      sourceId: "display-private-id",
      sourceTimeUs: 2_000_000,
    });
    const snapshot = CaptureRuntimeSnapshotSchema.parse({
      ...paused,
      state: {
        code: "screen-recording-failed",
        message: "/private/native/diagnostic should stay hidden",
        recordingId: "rec_active001",
        recordingPath: "artifacts/transmute/recordings/rec_active001",
        sourceTimeUs: 2_000_000,
        state: "failed",
      },
    });

    const presentation = presentationForSnapshot(snapshot);
    expect(presentation.allowedActions).toEqual(["start"]);
    expect(presentation.label).toBe("Screen recording failed — recording stopped");
    expect(presentation.label).not.toContain("/private");
    expect(presentation.label).not.toContain("display-private-id");
  });

  test("maps untrusted command and failure diagnostics to owned UI copy", () => {
    const snapshot = CaptureRuntimeSnapshotSchema.parse({
      availableSources: {
        audioSources: [],
        cameras: [],
        displays: [],
      },
      lastInterruption: null,
      permissions: {
        accessibility: "unavailable",
        camera: "unavailable",
        inputMonitoring: "unavailable",
        microphone: "unavailable",
        screenCapture: "unavailable",
        systemAudio: "unavailable",
        windowMetadata: "unavailable",
      },
      protocolVersion: 3,
      sources: {
        audioSources: [],
        cameras: [],
        displays: [],
      },
      state: {
        code: "repository-not-configured",
        message: "Open /private/secret/repository and retry.",
        recordingId: null,
        recordingPath: null,
        sourceTimeUs: null,
        state: "failed",
      },
      updatedAt: "2026-07-22T12:00:00.000Z",
    });

    expect(presentationForSnapshot(snapshot)).toMatchObject({
      allowedActions: [],
      label: "Transmute needs a configured Transmute checkout",
    });
    expect(presentationForSnapshot(snapshot).label).not.toContain("/private/");
    const systemAudioFailure = CaptureRuntimeSnapshotSchema.parse({
      ...snapshot,
      state: {
        code: "system-audio-track-missing",
        message: "Missing track in /private/recording/display-1.mov.",
        recordingId: "rec_active001",
        recordingPath: "artifacts/transmute/recordings/rec_active001",
        sourceTimeUs: 2_000_000,
        state: "failed",
      },
    });
    expect(systemAudioFailure.lastInterruption).toBeNull();
    expect(presentationForSnapshot(systemAudioFailure)).toMatchObject({
      allowedActions: ["start"],
      label: "System audio missing — recording stopped",
    });
    expect(presentationForSnapshot(systemAudioFailure).label)
      .not.toContain("/private/");
    const incompleteRecovery = CaptureRuntimeSnapshotSchema.parse({
      ...systemAudioFailure,
      state: {
        ...systemAudioFailure.state,
        code: "capture-recovery-incomplete",
        message: "Recovery failed at /private/recording/display-1.mov.",
      },
    });
    expect(presentationForSnapshot(incompleteRecovery)).toMatchObject({
      allowedActions: [],
      label: "Recording recovery incomplete — restart Transmute to record again",
    });
    expect(presentationForSnapshot(incompleteRecovery).label)
      .not.toContain("/private/");
    expect(commandErrorMessage("required_source_unavailable", "start"))
      .toBe("A requested recording source is unavailable.");
    expect(commandErrorMessage("native_error_at_/private/path", "pause"))
      .toBe("Could not pause recording.");
    expect(connectionErrorMessage("native_error_at_/private/path"))
      .toBe("The local recorder is unavailable.");
  });
});

function interruptedSnapshot(
  lastInterruption: NonNullable<CaptureRuntimeSnapshot["lastInterruption"]>,
): CaptureRuntimeSnapshot {
  return CaptureRuntimeSnapshotSchema.parse({
    availableSources: {
      audioSources: [
        { id: "system-audio", kind: "system", label: "System audio" },
        { id: "microphone-replacement", kind: "microphone", label: "Replacement microphone" },
      ],
      cameras: [{ id: "camera-replacement", label: "Replacement camera" }],
      displays: [
        { id: "display-selected", isPrimary: true, label: "Selected display" },
        { id: "display-new", isPrimary: false, label: "Newly connected display" },
      ],
    },
    lastInterruption,
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
      audioSources: [
        { id: "system-audio", kind: "system", label: "System audio" },
        { id: "microphone-selected", kind: "microphone", label: "Selected microphone" },
      ],
      cameras: [{ id: "camera-selected", label: "Selected camera" }],
      displays: [{ id: "display-selected", isPrimary: true, label: "Selected display" }],
    },
    state: {
      recordingId: "rec_active001",
      recordingPath: "artifacts/transmute/recordings/rec_active001",
      sourceTimeUs: 3_000_000,
      state: "paused",
    },
    updatedAt: "2026-07-25T12:00:00.000Z",
  });
}
