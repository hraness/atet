import { describe, expect, test } from "bun:test";

import { CaptureRuntimeSnapshotSchema } from "../../contracts";
import type { NativeRuntimeTransport } from "./runtime-bridge";
import { createRuntimeBridge, RuntimeBridgeProtocolError } from "./runtime-bridge";

const snapshot = {
  availableSources: {
    audioSources: [{ id: "microphone-new", kind: "microphone", label: "New microphone" }],
    cameras: [],
    displays: [{ id: "display-primary", isPrimary: true, label: "Primary display" }],
  },
  lastInterruption: null,
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
  sources: { audioSources: [], cameras: [], displays: [] },
  state: { lastRecording: null, state: "idle" },
  updatedAt: "2026-07-22T12:00:00.000Z",
} as const;

function transport(response: unknown): NativeRuntimeTransport {
  return {
    invoke: () => Promise.resolve(response),
    on: () => () => undefined,
  };
}

describe("runtime bridge", () => {
  test("validates a correlated snapshot response", async () => {
    const bridge = createRuntimeBridge(transport({
      ok: true,
      protocolVersion: 3,
      requestId: "request_fixture001",
      snapshot,
    }), { createRequestId: () => "request_fixture001" });
    expect(await bridge.snapshot()).toEqual(snapshot);
  });

  test("fails closed on a response for another request", async () => {
    const bridge = createRuntimeBridge(transport({
      ok: true,
      protocolVersion: 3,
      requestId: "request_fixture002",
      snapshot,
    }), { createRequestId: () => "request_fixture001" });
    let failure: unknown;
    try {
      await bridge.snapshot();
    } catch (error: unknown) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(RuntimeBridgeProtocolError);
  });

  test("round-trips structured interruption evidence without accepting partial protocol-3 snapshots", async () => {
    const interrupted = {
      ...snapshot,
      lastInterruption: {
        code: "microphone-device-disconnected",
        nativeTimeUs: 15_000_000,
        recoverable: true,
        segmentIndex: 0,
        source: "microphone",
        sourceId: "microphone-selected",
        sourceTimeUs: 5_000_000,
      },
      sources: {
        audioSources: [{ id: "microphone-selected", kind: "microphone", label: "Selected microphone" }],
        cameras: [],
        displays: [{ id: "display-primary", isPrimary: true, label: "Primary display" }],
      },
      state: {
        recordingId: "rec_active001",
        recordingPath: "artifacts/atet/recordings/rec_active001",
        sourceTimeUs: 5_000_000,
        state: "paused",
      },
    } as const;
    const bridge = createRuntimeBridge(transport({
      ok: true,
      protocolVersion: 3,
      requestId: "request_fixture001",
      snapshot: interrupted,
    }), { createRequestId: () => "request_fixture001" });

    expect(await bridge.snapshot()).toEqual(
      CaptureRuntimeSnapshotSchema.parse(interrupted),
    );

    const partial = createRuntimeBridge(transport({
      ok: true,
      protocolVersion: 3,
      requestId: "request_fixture001",
      snapshot: {
        ...interrupted,
        availableSources: undefined,
      },
    }), { createRequestId: () => "request_fixture001" });
    expect(partial.snapshot()).rejects.toBeInstanceOf(RuntimeBridgeProtocolError);
  });
});
