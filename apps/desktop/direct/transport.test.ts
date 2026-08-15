import { describe, expect, test } from "bun:test";

import {
  ATET_DESKTOP_PROTOCOL,
  ATET_DESKTOP_PROTOCOL_VERSION,
} from "../contracts";
import { createRuntimeBridge } from "../frontend/src/runtime-bridge";
import { createAtetDirectSession } from "./session";

function idleSession() {
  const created = createAtetDirectSession({ kind: "scenario", scenario: "idle-ready" });
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

async function rejectionMessage(promise: PromiseLike<unknown>): Promise<string> {
  try {
    await promise;
  } catch (reason) {
    return reason instanceof Error ? reason.message : String(reason);
  }
  throw new Error("Expected the transport operation to reject.");
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

describe("deterministic recorder transport", () => {
  test("drives the real bridge from idle into an all-input recording", async () => {
    const session = idleSession();
    const harness = session.harness;
    let requests = 0;
    const bridge = createRuntimeBridge(harness.transport, {
      createRequestId: () => `request_transport${String(++requests).padStart(4, "0")}`,
    });
    const events: string[] = [];
    const unsubscribe = bridge.subscribe({
      onEvent: (event) => events.push(event.kind),
      onMalformedEvent: () => events.push("malformed"),
    });

    expect((await bridge.snapshot()).state.state).toBe("idle");
    const next = await bridge.dispatch({
      commandId: "command_transport01",
      kind: "start",
      options: {
        camera: { kind: "default" },
        displays: { kind: "all" },
        microphone: { kind: "default" },
        recordingDirectory: "artifacts/atet/recordings",
        systemAudio: true,
        typedText: "disabled",
        windowMetadata: "titles-and-bounds",
      },
    });

    expect(next.state.state).toBe("recording");
    expect(next.sources.displays).toHaveLength(2);
    expect(next.availableSources.displays).toHaveLength(2);
    expect(next.sources.audioSources.map(({ kind }) => kind).toSorted()).toEqual(["microphone", "system"]);
    expect(next.lastInterruption).toBeNull();
    expect(events).toEqual(["snapshot-changed", "command-settled"]);
    expect(harness.getSnapshot()).toMatchObject({ protocolErrors: 0, remainingTransitions: 0 });
    expect(session.probe.snapshot()).toMatchObject({
      ok: true,
      value: {
        activity: { active: 0, settled: 2, started: 2 },
        isQuiescent: true,
        violations: { blockedNetworkRequests: 0, protocolErrors: 0 },
      },
    });
    unsubscribe();
    session.dispose();
    expect(harness.getSnapshot().disposed).toBe(true);
    expect(session.signal.aborted).toBe(true);
  });

  test("rejects a command/request-kind mismatch without mutating state", async () => {
    const session = idleSession();
    const harness = session.harness;
    const response = await harness.transport.invoke("atet.runtime.dispatch", {
      payload: { kind: "snapshot" },
      protocol: ATET_DESKTOP_PROTOCOL,
      protocolVersion: ATET_DESKTOP_PROTOCOL_VERSION,
      requestId: "request_mismatch01",
    });

    expect(response).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(harness.getSnapshot()).toMatchObject({ protocolErrors: 1, remainingTransitions: 1 });
    expect(session.probe.snapshot()).toMatchObject({
      ok: true,
      value: { violations: { blockedNetworkRequests: 0, protocolErrors: 1 } },
    });
    session.dispose();
  });

  test("pushes a live recording into an interrupted pause before explicit resume and stop", async () => {
    const created = createAtetDirectSession({
      kind: "scenario",
      scenario: "partial-source-failure",
    });
    if (!created.ok) throw new Error(created.error.message);
    const session = created.value;
    let requests = 0;
    const bridge = createRuntimeBridge(session.harness.transport, {
      createRequestId: () => `request_push${String(++requests).padStart(5, "0")}`,
    });
    const snapshots: string[] = [];
    const unsubscribe = bridge.subscribe({
      onEvent: (event) => {
        if (event.kind === "snapshot-changed") {
          snapshots.push(event.snapshot.state.state);
        }
      },
      onMalformedEvent: () => snapshots.push("malformed"),
    });

    expect((await bridge.snapshot()).state.state).toBe("recording");
    await waitFor(
      () => snapshots.includes("paused"),
      "Direct did not publish the autonomous interrupted pause.",
    );
    expect(session.harness.getSnapshot()).toMatchObject({
      remainingTransitions: 2,
      snapshot: {
        lastInterruption: { code: "camera-device-disconnected" },
        state: { state: "paused" },
      },
    });
    const resumed = await bridge.dispatch({
      commandId: "command_pushresume",
      kind: "resume",
    });
    expect(resumed.state.state).toBe("recording");
    expect(resumed.lastInterruption?.code).toBe("camera-device-disconnected");
    expect((await bridge.dispatch({
      commandId: "command_pushstop00",
      kind: "stop",
    })).state.state).toBe("idle");
    expect(session.harness.getSnapshot().remainingTransitions).toBe(0);
    unsubscribe();
    session.dispose();
  });

  test("publishes in-flight bridge work and rejoins quiescence after settlement", async () => {
    const session = idleSession();
    const bridge = createRuntimeBridge(session.harness.transport, {
      createRequestId: () => "request_inflight01",
    });

    const pending = bridge.snapshot();
    expect(session.probe.snapshot()).toMatchObject({
      ok: true,
      value: {
        activity: { active: 1, settled: 0, started: 1 },
        isQuiescent: false,
      },
    });

    expect((await pending).state.state).toBe("idle");
    expect(session.probe.snapshot()).toMatchObject({
      ok: true,
      value: {
        activity: { active: 0, settled: 1, started: 1 },
        isQuiescent: true,
      },
    });
    session.dispose();
  });

  test("disposal fences queued and future work while settling leases exactly once", async () => {
    const session = idleSession();
    const bridge = createRuntimeBridge(session.harness.transport, {
      createRequestId: () => "request_dispose01",
    });

    const pending = bridge.snapshot();
    session.dispose();
    session.dispose();

    expect(await rejectionMessage(pending)).toContain("disposed");
    expect(await rejectionMessage(bridge.snapshot())).toContain("disposed");
    expect(session.probe.snapshot()).toMatchObject({
      ok: true,
      value: {
        activity: { active: 0, settled: 1, started: 1 },
        isQuiescent: true,
        remainingWork: { disposed: true },
        violations: { activityErrors: 0 },
      },
    });
    expect(session.disposalErrors()).toEqual([]);
  });
});
