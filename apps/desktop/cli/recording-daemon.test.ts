import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CliError } from "./errors";
import type { RecordingController, RecordingSnapshot, RecordingStartOptions } from "./recording-controller";
import {
  createSerializedRecordingDispatcher,
  handleRecordingControlSocket,
  type ControlRequest,
  type ControlResponse,
  RecordingDaemonClient,
} from "./recording-daemon";

const SNAPSHOT: RecordingSnapshot = {
  availableSources: { audio: [], cameras: [], displays: [] },
  completedSegmentCount: 0,
  effectiveConfig: null,
  lastInterruption: null,
  logicalTimeUs: 0,
  permissions: null,
  recordingId: null,
  recordingRoot: null,
  sources: { audio: [], cameras: [], displays: [] },
  state: "idle",
  updatedAt: "2026-07-22T12:00:00.000Z",
};

const START_OPTIONS = {
  camera: { kind: "default" },
  displays: { kind: "all" },
  microphone: { kind: "default" },
  strictInputs: true,
  systemAudio: true,
  typedText: false,
} satisfies RecordingStartOptions;

function statusRequest(requestId: string): ControlRequest {
  return {
    action: "status",
    nonce: "test-nonce",
    protocolVersion: 1,
    requestId,
  };
}

function startRequest(requestId: string): ControlRequest {
  return {
    action: "start",
    nonce: "test-nonce",
    options: START_OPTIONS,
    protocolVersion: 1,
    requestId,
  };
}

async function eventually(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for deterministic test state.");
}

async function cliFailure(operation: Promise<unknown>): Promise<CliError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error("Expected a CLI failure.");
}

class GatedStatusController implements RecordingController {
  active = 0;
  calls = 0;
  maxActive = 0;
  readonly #releases: Array<() => void> = [];

  async status(): Promise<RecordingSnapshot> {
    this.calls += 1;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise<void>((resolve) => this.#releases.push(resolve));
    this.active -= 1;
    return SNAPSHOT;
  }

  releaseNext(): void {
    const release = this.#releases.shift();
    if (release === undefined) throw new Error("No status call is waiting.");
    release();
  }

  start(options: RecordingStartOptions): Promise<RecordingSnapshot> {
    void options;
    throw new Error("Unexpected start.");
  }

  pause(): Promise<RecordingSnapshot> {
    throw new Error("Unexpected pause.");
  }

  resume(): Promise<RecordingSnapshot> {
    throw new Error("Unexpected resume.");
  }

  stop(): Promise<RecordingSnapshot> {
    throw new Error("Unexpected stop.");
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

class GatedRecoveryFailureController implements RecordingController {
  readonly failure: CliError;
  readonly statusStarted: Promise<void>;
  startCalls = 0;
  #markStatusStarted: () => void = () => undefined;
  #releaseStatus: () => void = () => undefined;
  readonly #statusGate: Promise<void>;

  constructor(
    artifactRoot: string,
    messageBytes: number,
    poisonDetails: (details: Record<string, unknown>) => void = () => undefined,
  ) {
    this.statusStarted = new Promise<void>((resolve) => {
      this.#markStatusStarted = resolve;
    });
    this.#statusGate = new Promise<void>((resolve) => {
      this.#releaseStatus = resolve;
    });
    const details: Record<string, unknown> = {
      recovery: {
        controllerReusable: false,
        recordingId: "rec_failed001",
        recordingRoot: join(artifactRoot, "rec_failed001"),
        snapshot: {
          lastInterruption: null,
          logicalTimeUs: 1_250_000,
          permissions: null,
          sources: { audio: [], cameras: [], displays: [] },
        },
        terminalManifestState: "unsettled",
      },
    };
    poisonDetails(details);
    this.failure = new CliError(
      "internal",
      `Native failure at /private/native/secret-device ${"x".repeat(messageBytes)}`,
      details,
    );
  }

  async status(): Promise<RecordingSnapshot> {
    this.#markStatusStarted();
    await this.#statusGate;
    throw this.failure;
  }

  releaseFailure(): void {
    this.#releaseStatus();
  }

  start(options: RecordingStartOptions): Promise<RecordingSnapshot> {
    void options;
    this.startCalls += 1;
    return Promise.resolve(SNAPSHOT);
  }

  pause(): Promise<RecordingSnapshot> {
    return Promise.reject(this.failure);
  }

  resume(): Promise<RecordingSnapshot> {
    return Promise.reject(this.failure);
  }

  stop(): Promise<RecordingSnapshot> {
    return Promise.reject(this.failure);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

describe("recording control serialization", () => {
  test("serializes actions globally and deduplicates concurrent request IDs", async () => {
    const controller = new GatedStatusController();
    const dispatch = createSerializedRecordingDispatcher(controller);
    const first = dispatch(statusRequest("request-1"));
    const second = dispatch(statusRequest("request-2"));
    const duplicate = dispatch(statusRequest("request-1"));

    await eventually(() => controller.calls === 1);
    expect(controller.active).toBe(1);
    expect(controller.maxActive).toBe(1);
    controller.releaseNext();
    expect((await first).requestId).toBe("request-1");
    expect((await duplicate).requestId).toBe("request-1");

    await eventually(() => controller.calls === 2);
    expect(controller.maxActive).toBe(1);
    controller.releaseNext();
    expect((await second).requestId).toBe("request-2");
    expect(controller.calls).toBe(2);
  });

  test("retires an unusable daemon once and rejects a distinct queued start", async () => {
    const failure = new CliError(
      "internal",
      "Capture recovery was incomplete.",
      {
        recovery: {
          controllerReusable: false,
          recordingId: "rec_failed001",
          recordingRoot: "/tmp/rec_failed001",
          snapshot: {
            lastInterruption: null,
            logicalTimeUs: 1_250_000,
            permissions: null,
            sources: { audio: [], cameras: [], displays: [] },
          },
          terminalManifestState: "unsettled",
        },
      },
    );
    let releaseStatus: () => void = () => undefined;
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    let statusCalls = 0;
    let startCalls = 0;
    const controller: RecordingController = {
      close: () => Promise.resolve(),
      pause: () => Promise.reject(failure),
      resume: () => Promise.reject(failure),
      start: () => {
        startCalls += 1;
        return Promise.resolve(SNAPSHOT);
      },
      status: async () => {
        statusCalls += 1;
        await statusGate;
        throw failure;
      },
      stop: () => Promise.reject(failure),
    };
    let retirements = 0;
    const dispatch = createSerializedRecordingDispatcher(controller, {
      onControllerUnusable: () => {
        retirements += 1;
      },
    });

    const firstPromise = dispatch(statusRequest("retire-request"));
    await eventually(() => statusCalls === 1);
    const queuedStartPromise = dispatch(startRequest("queued-start"));
    let drainCompleted = false;
    const drainPromise = dispatch.drain().then(() => {
      drainCompleted = true;
    });
    await Promise.resolve();
    expect(drainCompleted).toBeFalse();
    releaseStatus();
    const first = await firstPromise;
    const queuedStart = await queuedStartPromise;
    await drainPromise;
    const duplicate = await dispatch(statusRequest("retire-request"));
    expect(first).toMatchObject({
      error: {
        details: {
          recovery: {
            controllerReusable: false,
            terminalManifestState: "unsettled",
          },
        },
      },
      ok: false,
    });
    expect(queuedStart).toMatchObject({
      error: {
        details: {
          recovery: {
            controllerReusable: false,
            terminalManifestState: "unsettled",
          },
        },
      },
      ok: false,
      requestId: "queued-start",
    });
    expect(duplicate).toEqual(first);
    expect(startCalls).toBe(0);
    expect(retirements).toBe(1);
    expect(drainCompleted).toBeTrue();
  });
});

test.skipIf(process.platform === "win32")(
  "a fragmented socket request is dispatched once even when another line follows",
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), "atet-control-test-"));
    const socketPath = join(temporary, "control.sock");
    let dispatchCount = 0;
    const dispatch = (request: ControlRequest): Promise<ControlResponse> => {
      dispatchCount += 1;
      return Promise.resolve({
        ok: true,
        protocolVersion: 1,
        requestId: request.requestId,
        snapshot: SNAPSHOT,
      });
    };
    const server = createServer((socket) => handleRecordingControlSocket(socket, dispatch, "test-nonce"));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      const request = `${JSON.stringify(statusRequest("fragmented-request"))}\n`;
      const client = createConnection(socketPath);
      client.setEncoding("utf8");
      const response = new Promise<string>((resolve, reject) => {
        let contents = "";
        client.on("data", (chunk: string) => { contents += chunk; });
        client.once("end", () => resolve(contents));
        client.once("error", reject);
      });
      await new Promise<void>((resolve, reject) => {
        client.once("connect", resolve);
        client.once("error", reject);
      });
      const midpoint = Math.floor(request.length / 2);
      client.write(request.slice(0, midpoint));
      client.write(`${request.slice(midpoint)}${request}`);

      const parsed: unknown = JSON.parse((await response).trim());
      expect(parsed).toMatchObject({ ok: true, requestId: "fragmented-request" });
      expect(dispatchCount).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(temporary, { force: true, recursive: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "serializes a bounded fallback before claiming an oversized response",
  async () => {
    const temporary = await mkdtemp(
      join(tmpdir(), "atet-control-response-fallback-test-"),
    );
    const socketPath = join(temporary, "control.sock");
    const server = createServer((socket) =>
      handleRecordingControlSocket(
        socket,
        (request) => Promise.resolve({
          ok: true,
          protocolVersion: 1,
          requestId: request.requestId,
          snapshot: {
            ...SNAPSHOT,
            updatedAt: "x".repeat(80 * 1024),
          },
        }),
        "test-nonce",
      )
    );
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      const client = createConnection(socketPath);
      client.setEncoding("utf8");
      const response = new Promise<string>((resolve, reject) => {
        let contents = "";
        client.setTimeout(1_000, () => {
          client.destroy();
          reject(new Error("Timed out waiting for the bounded fallback."));
        });
        client.on("data", (chunk: string) => {
          contents += chunk;
        });
        client.once("end", () => resolve(contents));
        client.once("error", reject);
      });
      await new Promise<void>((resolve, reject) => {
        client.once("connect", resolve);
        client.once("error", reject);
      });
      client.write(`${JSON.stringify(statusRequest("oversized-response"))}\n`);

      expect(JSON.parse((await response).trim())).toMatchObject({
        error: {
          code: "internal",
          message: "The recording control operation failed.",
        },
        ok: false,
        requestId: "oversized-response",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(temporary, { force: true, recursive: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "preserves process and focus scoping across the recording daemon boundary",
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), "atet-control-scope-test-"));
    const socketPath = join(temporary, "control.sock");
    const focusIdentity = {
      fieldId: "public-field",
      processId: 42,
      windowId: "42",
      windowTitle: "Owned interaction fixture",
    } as const;
    let received: ControlRequest | undefined;
    const dispatch = (request: ControlRequest): Promise<ControlResponse> => {
      received = request;
      return Promise.resolve({
        ok: true,
        protocolVersion: 1,
        requestId: request.requestId,
        snapshot: SNAPSHOT,
      });
    };
    const server = createServer((socket) =>
      handleRecordingControlSocket(socket, dispatch, "test-nonce")
    );
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      const client = createConnection(socketPath);
      client.setEncoding("utf8");
      const response = new Promise<string>((resolve, reject) => {
        let contents = "";
        client.on("data", (chunk: string) => { contents += chunk; });
        client.once("end", () => resolve(contents));
        client.once("error", reject);
      });
      await new Promise<void>((resolve, reject) => {
        client.once("connect", resolve);
        client.once("error", reject);
      });
      client.write(`${JSON.stringify({
        action: "start",
        nonce: "test-nonce",
        options: {
          camera: { deviceId: "camera-external", kind: "device" },
          displays: {
            displayIds: ["display-left", "display-right"],
            kind: "selected",
          },
          interactionEventProcessIdentifier: 42,
          microphone: { deviceId: "microphone-usb", kind: "device" },
          strictInputs: true,
          systemAudio: true,
          typedText: true,
          typedTextFocusIdentities: [focusIdentity],
        },
        protocolVersion: 1,
        requestId: "scoped-start",
      })}\n`);

      expect(JSON.parse((await response).trim())).toMatchObject({
        ok: true,
        requestId: "scoped-start",
      });
      expect(received).toEqual({
        action: "start",
        nonce: "test-nonce",
        options: {
          camera: { deviceId: "camera-external", kind: "device" },
          displays: {
            displayIds: ["display-left", "display-right"],
            kind: "selected",
          },
          interactionEventProcessIdentifier: 42,
          microphone: { deviceId: "microphone-usb", kind: "device" },
          strictInputs: true,
          systemAudio: true,
          typedText: true,
          typedTextFocusIdentities: [focusIdentity],
        },
        protocolVersion: 1,
        requestId: "scoped-start",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(temporary, { force: true, recursive: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "preserves non-reusable recovery disposition across the daemon client boundary",
  async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "atet-control-recovery-test-"));
    const socketPath = join(artifactRoot, ".recording-control.sock");
    const server = createServer((socket) =>
      handleRecordingControlSocket(
        socket,
        (request) => Promise.resolve({
          error: {
            code: "internal",
            details: {
              recovery: {
                controllerReusable: false,
                recordingId: "rec_failed001",
                recordingRoot: join(artifactRoot, "rec_failed001"),
                snapshot: {
                  lastInterruption: null,
                  logicalTimeUs: 1_250_000,
                  permissions: null,
                  sources: { audio: [], cameras: [], displays: [] },
                },
                terminalManifestState: "unsettled",
              },
            },
            message: "Recovery failed at /private/native/session.",
          },
          ok: false,
          protocolVersion: 1,
          requestId: request.requestId,
        }),
        "recovery-nonce",
      )
    );
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      await writeFile(join(artifactRoot, ".recording-control.json"), `${
        JSON.stringify({
          nonce: "recovery-nonce",
          pid: process.pid,
          protocolVersion: 1,
          socketPath,
          startedAt: "2026-07-22T12:00:00.000Z",
          uid: typeof process.getuid === "function" ? process.getuid() : null,
        })
      }\n`);
      const client = new RecordingDaemonClient({
        artifactRoot,
        daemonCommand: ["unused-daemon"],
        helperExecutable: "unused-helper",
        timeoutMs: 25,
      });
      try {
        await client.start({
          camera: { kind: "default" },
          displays: { kind: "all" },
          microphone: { kind: "default" },
          strictInputs: true,
          systemAudio: true,
          typedText: false,
        });
        throw new Error("Expected the daemon recovery failure.");
      } catch (error) {
        expect(error).toBeInstanceOf(CliError);
        expect(error).toMatchObject({
          code: "internal",
          details: {
            recovery: {
              controllerReusable: false,
              terminalManifestState: "unsettled",
            },
          },
        });
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(artifactRoot, { force: true, recursive: true });
    }
  },
);

for (const [name, messageBytes, poisonDetails] of [
  ["over 4 KiB", 5 * 1024, () => undefined],
  ["over 64 KiB", 80 * 1024, () => undefined],
  [
    "cyclic",
    64,
    (details: Record<string, unknown>) => {
      details.cycle = details;
    },
  ],
  [
    "BigInt",
    64,
    (details: Record<string, unknown>) => {
      details.nativeCounter = 1n;
    },
  ],
  [
    "throwing toJSON",
    64,
    (details: Record<string, unknown>) => {
      details.toJSON = () => {
        throw new Error("Native diagnostic serialization must not run.");
      };
    },
  ],
  [
    "throwing optional recovery frontier",
    64,
    (details: Record<string, unknown>) => {
      const recovery = details.recovery as Record<string, unknown>;
      const snapshot = recovery.snapshot as Record<string, unknown>;
      Object.defineProperty(snapshot, "availableSources", {
        enumerable: true,
        get: () => {
          throw new Error("Optional recovery frontier must fail soft.");
        },
      });
    },
  ],
] as const) {
  test.skipIf(process.platform === "win32")(
    `bounds ${name} native failures without losing recovery or admitting a queued start`,
    async () => {
      const artifactRoot = await mkdtemp(
        join(tmpdir(), "atet-control-bounded-recovery-test-"),
      );
      const socketPath = join(artifactRoot, ".recording-control.sock");
      const controller = new GatedRecoveryFailureController(
        artifactRoot,
        messageBytes,
        poisonDetails,
      );
      const server = createServer();
      let admittedRequests = 0;
      let retirements = 0;
      const serialized = createSerializedRecordingDispatcher(controller, {
        onControllerUnusable: () => {
          retirements += 1;
          server.close();
        },
      });
      const dispatch = (request: ControlRequest): Promise<ControlResponse> => {
        admittedRequests += 1;
        return serialized(request);
      };
      server.on("connection", (socket) =>
        handleRecordingControlSocket(socket, dispatch, "bounded-recovery-nonce")
      );
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, resolve);
        });
        const serverClosed = new Promise<void>((resolve) => {
          server.once("close", resolve);
        });
        await writeFile(join(artifactRoot, ".recording-control.json"), `${
          JSON.stringify({
            nonce: "bounded-recovery-nonce",
            pid: process.pid,
            protocolVersion: 1,
            socketPath,
            startedAt: "2026-07-22T12:00:00.000Z",
            uid: typeof process.getuid === "function" ? process.getuid() : null,
          })
        }\n`);
        const client = new RecordingDaemonClient({
          artifactRoot,
          daemonCommand: ["unused-daemon"],
          helperExecutable: "unused-helper",
          timeoutMs: 25,
        });

        const failedStatus = cliFailure(client.status());
        await controller.statusStarted;
        const blockedStart = cliFailure(client.start(START_OPTIONS));
        await eventually(() => admittedRequests === 2);
        controller.releaseFailure();

        const [statusFailure, startFailure] = await Promise.all([
          failedStatus,
          blockedStart,
        ]);
        for (const failure of [statusFailure, startFailure]) {
          expect(failure).toMatchObject({
            code: "internal",
            details: {
              recovery: {
                controllerReusable: false,
                recordingId: "rec_failed001",
                terminalManifestState: "unsettled",
              },
            },
            message: "Capture recovery was incomplete.",
          });
          expect(failure.message).not.toContain("/private/");
          expect(Buffer.byteLength(failure.message)).toBeLessThanOrEqual(4_096);
        }
        expect(controller.startCalls).toBe(0);
        expect(retirements).toBe(1);
        await serverClosed;
        await serialized.drain();
      } finally {
        if (server.listening) {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        await rm(artifactRoot, { force: true, recursive: true });
      }
    },
  );
}

test.skipIf(process.platform === "win32")(
  "recovers stale control state when a live PID has been reused but its socket is absent",
  async () => {
    const artifactRoot = await mkdtemp(join(tmpdir(), "atet-stale-control-test-"));
    const now = new Date("2026-07-22T12:00:00.000Z");
    try {
      await writeFile(join(artifactRoot, ".recording-control.json"), `${JSON.stringify({
        nonce: "stale-nonce",
        pid: process.pid,
        protocolVersion: 1,
        socketPath: join(artifactRoot, ".recording-control.sock"),
        startedAt: now.toISOString(),
        uid: typeof process.getuid === "function" ? process.getuid() : null,
      })}\n`);
      await writeFile(join(artifactRoot, ".active-recording.json"), `${JSON.stringify({
        completedSegmentCount: 1,
        effectiveConfig: {
          camera: { kind: "default" },
          displays: { kind: "all" },
          metadata: true,
          microphone: { kind: "default" },
          strictInputs: false,
          systemAudio: true,
          typedText: false,
        },
        availableSources: { audio: [], cameras: [], displays: [] },
        lastInterruption: null,
        logicalTimeUs: 1_000_000,
        permissions: {
          accessibility: "authorized",
          camera: "authorized",
          inputMonitoring: "authorized",
          microphone: "authorized",
          screenCapture: "authorized",
          systemAudio: "authorized",
          windowMetadata: "authorized",
        },
        recordingId: "rec_stale0001",
        recordingRoot: join(artifactRoot, "rec_stale0001"),
        sources: { audio: [], cameras: [], displays: [] },
        state: "paused",
        updatedAt: now.toISOString(),
      })}\n`);
      const client = new RecordingDaemonClient({
        artifactRoot,
        daemonCommand: ["unused-daemon"],
        helperExecutable: "unused-helper",
        now: () => now,
      });
      expect(await client.status()).toMatchObject({ recordingId: null, state: "idle" });
      const entries = await readdir(artifactRoot);
      expect(entries.some((entry) => entry.startsWith(".stale-recording-"))).toBeTrue();
      expect(entries).not.toContain(".recording-control.json");
      expect(entries).not.toContain(".active-recording.json");
    } finally {
      await rm(artifactRoot, { force: true, recursive: true });
    }
  },
);
