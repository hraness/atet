import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DesktopEventSchema,
  DesktopResponseSchema,
  ATET_DESKTOP_PROTOCOL_VERSION,
  type CaptureDomainCommand,
  type DesktopEvent,
} from "../../contracts";
import {
  CAPTURE_HELPER_VERSION,
  CAPTURE_PROTOCOL_VERSION,
  type CaptureInterruption,
  type CaptureSourceInventory,
} from "../../capture/protocol";
import type {
  RecordingController,
  RecordingSnapshot,
  RecordingStartOptions,
} from "../../cli/recording-controller";
import { CliError } from "../../cli/errors";
import type { ProcessRunner, RunOptions, RunResult } from "../../cli/io";
import {
  type HelperProbe,
  probeCaptureHelper,
  RecordingService,
  resolveGatewayRepositoryRoot,
} from "./recording-service";

const temporaryDirectories: string[] = [];
const timestamp = "2026-07-22T12:00:00.000Z";
const emptyCaptureSources = {
  audio: [],
  cameras: [],
  displays: [],
} satisfies CaptureSourceInventory;

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolvePromise: ((value: Value) => void) | undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  };
}

const defaultCaptureSources = {
  audio: [
    {
      audioSourceId: "system",
      channels: 2,
      kind: "system",
      label: "System audio",
      sampleRateHz: 48_000,
    },
    {
      audioSourceId: "microphone",
      channels: 1,
      kind: "microphone",
      label: "Microphone",
      sampleRateHz: 48_000,
    },
  ],
  cameras: [{
    cameraId: "camera",
    frameRate: 30,
    label: "Camera",
    pixelSize: { height: 1_080, width: 1_920 },
    position: "external",
  }],
  displays: [{
    bounds: { height: 900, width: 1_440, x: 0, y: 0 },
    displayId: "display",
    isPrimary: true,
    label: "Display",
    pixelSize: { height: 1_800, width: 2_880 },
    refreshRateHz: 60,
    scaleFactor: 2,
  }],
} satisfies CaptureSourceInventory;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => await rm(path, { force: true, recursive: true })));
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atet-runtime-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "media"));
  return await realpath(root);
}

function recordingSnapshot(
  state: RecordingSnapshot["state"],
  artifactRoot: string,
  sourceTimeUs: number,
  evidence: {
    readonly availableSources: CaptureSourceInventory;
    readonly lastInterruption: CaptureInterruption | null;
    readonly sources: CaptureSourceInventory;
  },
): RecordingSnapshot {
  return {
    availableSources: evidence.availableSources,
    completedSegmentCount: state === "idle" ? 1 : 0,
    effectiveConfig: state === "idle" ? null : {
      camera: { kind: "default" },
      displays: { kind: "all" },
      metadata: true,
      microphone: { kind: "default" },
      strictInputs: false,
      systemAudio: true,
      typedText: false,
    },
    lastInterruption: evidence.lastInterruption,
    logicalTimeUs: sourceTimeUs,
    permissions: {
      accessibility: "authorized",
      camera: "authorized",
      inputMonitoring: "authorized",
      microphone: "authorized",
      screenCapture: "authorized",
      systemAudio: "authorized",
      windowMetadata: "authorized",
    },
    recordingId: state === "idle" ? "rec_fixture001" : "rec_fixture001",
    recordingRoot: join(artifactRoot, "rec_fixture001"),
    sources: evidence.sources,
    state,
    updatedAt: timestamp,
  };
}

class FakeController implements RecordingController {
  readonly artifactRoot: string;
  activeOperations = 0;
  availableSources: CaptureSourceInventory;
  closeCalls = 0;
  lastInterruption: CaptureInterruption | null = null;
  maxConcurrentOperations = 0;
  pauseFailure: Error | null = null;
  resumeCalls = 0;
  selectedSources: CaptureSourceInventory = emptyCaptureSources;
  startFailure: Error | null = null;
  readonly startOptions: RecordingStartOptions[] = [];
  state: RecordingSnapshot["state"] = "idle";
  statusCalls = 0;
  statusFailure: Error | null = null;
  statusStarted: (() => void) | null = null;
  statusWait: Promise<void> | null = null;
  sourceTimeUs = 0;

  constructor(
    artifactRoot: string,
    availableSources: CaptureSourceInventory = defaultCaptureSources,
  ) {
    this.artifactRoot = artifactRoot;
    this.availableSources = availableSources;
  }

  close(): Promise<void> {
    this.beginOperation();
    try {
      this.closeCalls += 1;
      return Promise.resolve();
    } finally {
      this.endOperation();
    }
  }

  pause(): Promise<RecordingSnapshot> {
    this.beginOperation();
    try {
      if (this.pauseFailure !== null) throw this.pauseFailure;
      if (this.state !== "recording") throw new Error("not recording");
      this.state = "paused";
      this.sourceTimeUs = 1_000_000;
      return Promise.resolve(this.snapshot());
    } finally {
      this.endOperation();
    }
  }

  resume(): Promise<RecordingSnapshot> {
    this.beginOperation();
    try {
      this.resumeCalls += 1;
      if (this.state !== "paused") throw new Error("not paused");
      const options = this.startOptions.at(-1);
      if (options !== undefined) {
        this.selectedSources = selectCaptureSources(options, this.availableSources);
      }
      this.state = "recording";
      return Promise.resolve(this.snapshot());
    } finally {
      this.endOperation();
    }
  }

  start(options: RecordingStartOptions): Promise<RecordingSnapshot> {
    this.beginOperation();
    try {
      this.startOptions.push(options);
      if (this.startFailure !== null) throw this.startFailure;
      this.selectedSources = selectCaptureSources(options, this.availableSources);
      this.lastInterruption = null;
      this.state = "recording";
      return Promise.resolve(this.snapshot());
    } finally {
      this.endOperation();
    }
  }

  async status(): Promise<RecordingSnapshot> {
    this.beginOperation();
    try {
      this.statusCalls += 1;
      const started = this.statusStarted;
      const wait = this.statusWait;
      this.statusStarted = null;
      this.statusWait = null;
      started?.();
      if (wait !== null) await wait;
      if (this.statusFailure !== null) throw this.statusFailure;
      return this.snapshot();
    } finally {
      this.endOperation();
    }
  }

  stop(): Promise<RecordingSnapshot> {
    this.beginOperation();
    try {
      this.state = "idle";
      this.sourceTimeUs = 2_000_000;
      return Promise.resolve(this.snapshot());
    } finally {
      this.endOperation();
    }
  }

  blockNextStatus(): {
    readonly release: () => void;
    readonly started: Promise<void>;
  } {
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseBlocked: () => void = () => undefined;
    this.statusWait = new Promise<void>((resolve) => {
      releaseBlocked = resolve;
    });
    this.statusStarted = markStarted;
    return {
      release: () => releaseBlocked(),
      started,
    };
  }

  private beginOperation(): void {
    this.activeOperations += 1;
    this.maxConcurrentOperations = Math.max(
      this.maxConcurrentOperations,
      this.activeOperations,
    );
  }

  private endOperation(): void {
    this.activeOperations -= 1;
  }

  private snapshot(): RecordingSnapshot {
    return recordingSnapshot(this.state, this.artifactRoot, this.sourceTimeUs, {
      availableSources: this.availableSources,
      lastInterruption: this.lastInterruption,
      sources: this.selectedSources,
    });
  }
}

function selectCaptureSources(
  options: RecordingStartOptions,
  available: CaptureSourceInventory,
): CaptureSourceInventory {
  const cameraDeviceId = options.camera.kind === "device"
    ? options.camera.deviceId
    : null;
  const camera = options.camera.kind === "disabled"
    ? []
    : cameraDeviceId !== null
    ? available.cameras.filter(({ cameraId }) => cameraId === cameraDeviceId)
    : available.cameras.slice(0, 1);
  const displays = options.displays.kind === "all"
    ? [...available.displays]
    : available.displays.filter(({ displayId }) =>
        options.displays.kind === "selected"
        && options.displays.displayIds.includes(displayId)
      );
  const microphoneDeviceId = options.microphone.kind === "device"
    ? options.microphone.deviceId
    : null;
  const microphone = options.microphone.kind === "disabled"
    ? []
    : microphoneDeviceId !== null
    ? available.audio.filter(({ audioSourceId, kind }) =>
        kind === "microphone" && audioSourceId === microphoneDeviceId
      )
    : available.audio.filter(({ kind }) => kind === "microphone").slice(0, 1);
  return {
    audio: [
      ...(options.systemAudio
        ? available.audio.filter(({ kind }) => kind === "system")
        : []),
      ...microphone,
    ],
    cameras: camera,
    displays,
  };
}

function request(requestId: string, command: CaptureDomainCommand) {
  return {
    payload: { command, kind: "dispatch" },
    protocol: "studio.desktop",
    protocolVersion: ATET_DESKTOP_PROTOCOL_VERSION,
    requestId,
  } as const;
}

function startCommand(): CaptureDomainCommand {
  return {
    commandId: "command_start0001",
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
  };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

describe("recording runtime service", () => {
  test("runs the native capability probe with concurrent bounded output and a deadline", async () => {
    const calls: Array<{
      readonly argv: readonly string[];
      readonly options: RunOptions | undefined;
    }> = [];
    const runner: ProcessRunner = {
      run(
        argv: readonly [string, ...string[]],
        options?: RunOptions,
      ): Promise<RunResult> {
        calls.push({ argv, options });
        return Promise.resolve({
          exitCode: 0,
          stderr: "diagnostic".repeat(20_000),
          stdout: JSON.stringify({
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
            permissions: {
              accessibility: "authorized",
              camera: "authorized",
              inputMonitoring: "authorized",
              microphone: "authorized",
              screenCapture: "authorized",
              systemAudio: "authorized",
              windowMetadata: "authorized",
            },
            protocolVersion: CAPTURE_PROTOCOL_VERSION,
            availableSources: {
              audio: [],
              cameras: [],
              displays: [{
                bounds: { height: 900, width: 1_440, x: 0, y: 0 },
                displayId: "display",
                isPrimary: true,
                label: "Display",
                pixelSize: { height: 1_800, width: 2_880 },
                refreshRateHz: 60,
                scaleFactor: 2,
              }],
            },
          }),
        });
      },
    };

    const abortController = new AbortController();
    expect(await probeCaptureHelper(
      "/tmp/atet-capture",
      runner,
      abortController.signal,
    )).toMatchObject({
      sources: {
        displays: [{ id: "display", isPrimary: true, label: "Display" }],
      },
    });
    expect(calls).toEqual([{
      argv: ["/tmp/atet-capture", "--json"],
      options: {
        abortSignal: abortController.signal,
        env: { LANG: "en_US.UTF-8", PATH: "/usr/bin:/bin" },
        maxOutputBytes: 65_537,
        timeoutMs: 10_000,
      },
    }]);
  });

  test("rejects a capability probe response beyond the retained byte bound", () => {
    const runner: ProcessRunner = {
      run(): Promise<RunResult> {
        return Promise.resolve({
          exitCode: 0,
          stderr: "",
          stdout: " ".repeat(65_537),
        });
      },
    };

    expect(probeCaptureHelper("/tmp/atet-capture", runner))
      .rejects.toThrow("capture helper capability probe failed");
  });

  test("aborted initialization rejects late probe settlement without mutating capability state", async () => {
    const probeStarted = deferred<void>();
    const probeResult = deferred<Awaited<ReturnType<HelperProbe>>>();
    let receivedSignal: AbortSignal | undefined;
    let probeCalls = 0;
    const service = new RecordingService({
      captureHelper: "/tmp/atet-capture",
      helperProbe: (abortSignal) => {
        probeCalls += 1;
        receivedSignal = abortSignal;
        probeStarted.resolve();
        return probeResult.promise;
      },
      now: () => new Date(timestamp),
      repositoryRoot: null,
      statusPollIntervalMs: 1,
    });
    const lifecycleController = new AbortController();
    const initialization = service.initialize(lifecycleController.signal);
    await probeStarted.promise;
    expect(receivedSignal).toBe(lifecycleController.signal);

    lifecycleController.abort(new Error("test lifecycle cancellation"));
    const closing = service.close();
    probeResult.resolve({
      permissions: {
        accessibility: "authorized",
        camera: "authorized",
        inputMonitoring: "authorized",
        microphone: "authorized",
        screenCapture: "authorized",
        systemAudio: "authorized",
        windowMetadata: "authorized",
      },
      sources: {
        audioSources: [{ id: "system", kind: "system", label: "System audio" }],
        cameras: [{ id: "camera", label: "Camera" }],
        displays: [{ id: "display", isPrimary: true, label: "Display" }],
      },
    });

    const initializationError = await initialization.then(
      () => null,
      (error: unknown) => error,
    );
    expect(initializationError).toBeInstanceOf(Error);
    expect(initializationError).toHaveProperty("message", "test lifecycle cancellation");
    await closing;
    const snapshot = await service.snapshot();
    expect(probeCalls).toBe(1);
    expect(snapshot.availableSources).toEqual({
      audioSources: [],
      cameras: [],
      displays: [],
    });
    expect(Object.values(snapshot.permissions).every(
      permission => permission === "unavailable",
    )).toBe(true);
  });

  test("uses one shared controller and emits only contract-valid state events", async () => {
    const root = await repository();
    const events: DesktopEvent[] = [];
    const controllers: FakeController[] = [];
    const service = new RecordingService({
      captureHelper: "/tmp/atet-capture",
      controllerFactory: (artifactRoot) => {
        const controller = new FakeController(artifactRoot);
        controllers.push(controller);
        return controller;
      },
      emit: (event) => {
        events.push(DesktopEventSchema.parse(event));
      },
      helperProbe: () => Promise.resolve({
        permissions: {
          accessibility: "authorized",
          camera: "authorized",
          inputMonitoring: "authorized",
          microphone: "authorized",
          screenCapture: "authorized",
          systemAudio: "authorized",
          windowMetadata: "authorized",
        },
        sources: {
          audioSources: [{ id: "system", kind: "system", label: "System audio" }],
          cameras: [{ id: "camera", label: "Camera" }],
          displays: [{ id: "display", isPrimary: true, label: "Display" }],
        },
      }),
      now: () => new Date(timestamp),
      repositoryRoot: root,
    });
    await service.initialize();

    const commands: CaptureDomainCommand[] = [
      startCommand(),
      { commandId: "command_pause0001", kind: "pause" },
      { commandId: "command_resume001", kind: "resume" },
      { commandId: "command_stop00001", kind: "stop" },
    ];
    for (const [index, command] of commands.entries()) {
      const response = DesktopResponseSchema.parse(await service.handle(
        request(`request_fixture00${index + 1}`, command),
        "atet.runtime.dispatch",
      ));
      expect(response.ok).toBe(true);
    }

    expect(controllers).toHaveLength(1);
    expect(controllers[0]?.startOptions).toEqual([{
      camera: { kind: "default" },
      displays: { kind: "all" },
      microphone: { kind: "default" },
      strictInputs: false,
      systemAudio: true,
      typedText: false,
    }]);
    expect(controllers[0]?.closeCalls).toBe(1);
    expect(events).toHaveLength(8);
    expect(events.flatMap((event) => event.kind === "command-settled" ? [event.status] : []))
      .toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
    const finalSnapshot = events.filter((event) => event.kind === "snapshot-changed").at(-1);
    expect(finalSnapshot?.kind === "snapshot-changed" ? finalSnapshot.snapshot.state : null)
      .toMatchObject({ state: "idle", lastRecording: { durationUs: 2_000_000 } });
  });

  test("refreshes source IDs before start, accepts newly connected sources, and exposes the fresh inventory", async () => {
    const root = await repository();
    const controllers: FakeController[] = [];
    let probeCall = 0;
    const newlyConnectedCaptureSources = {
      audio: [
        {
          audioSourceId: "system",
          channels: 2,
          kind: "system",
          label: "System audio",
          sampleRateHz: 48_000,
        },
        {
          audioSourceId: "microphone-usb",
          channels: 2,
          kind: "microphone",
          label: "USB microphone",
          sampleRateHz: 48_000,
        },
      ],
      cameras: [{
        cameraId: "camera-external",
        frameRate: 30,
        label: "External camera",
        pixelSize: { height: 1_080, width: 1_920 },
        position: "external",
      }],
      displays: [{
        bounds: { height: 900, width: 1_440, x: 0, y: 0 },
        displayId: "display-new",
        isPrimary: true,
        label: "New display",
        pixelSize: { height: 1_800, width: 2_880 },
        refreshRateHz: 60,
        scaleFactor: 2,
      }],
    } satisfies CaptureSourceInventory;
    const service = new RecordingService({
      captureHelper: "/tmp/atet-capture",
      controllerFactory: (artifactRoot) => {
        const controller = new FakeController(
          artifactRoot,
          newlyConnectedCaptureSources,
        );
        controllers.push(controller);
        return controller;
      },
      helperProbe: () => {
        probeCall += 1;
        return Promise.resolve({
          permissions: {
            accessibility: "authorized",
            camera: "authorized",
            inputMonitoring: "authorized",
            microphone: "authorized",
            screenCapture: "authorized",
            systemAudio: "authorized",
            windowMetadata: "authorized",
          },
          sources: probeCall === 1
            ? {
                audioSources: [{ id: "system", kind: "system", label: "System audio" }],
                cameras: [],
                displays: [{ id: "display-stale", isPrimary: true, label: "Disconnected display" }],
              }
            : {
                audioSources: [
                  { id: "system", kind: "system", label: "System audio" },
                  { id: "microphone-usb", kind: "microphone", label: "USB microphone" },
                ],
                cameras: [{ id: "camera-external", label: "External camera" }],
                displays: [{ id: "display-new", isPrimary: true, label: "New display" }],
              },
        });
      },
      now: () => new Date(timestamp),
      repositoryRoot: root,
    });
    await service.initialize();

    const exactOptions = {
      camera: { deviceId: "camera-external", kind: "device" as const },
      displays: {
        displayIds: ["display-new"],
        kind: "selected" as const,
      },
      microphone: { deviceId: "microphone-usb", kind: "device" as const },
      recordingDirectory: "artifacts/atet/recordings" as const,
      systemAudio: false,
      typedText: "disabled" as const,
      windowMetadata: "titles-and-bounds" as const,
    };
    const selected = DesktopResponseSchema.parse(await service.handle(
      request("request_selected01", {
        commandId: "command_selected01",
        kind: "start",
        options: exactOptions,
      }),
      "atet.runtime.dispatch",
    ));
    expect(selected.ok).toBe(true);
    if (!selected.ok) throw new Error("Expected newly connected sources to be accepted.");
    expect(probeCall).toBe(2);
    expect(selected.snapshot.sources).toEqual({
      audioSources: [
        { id: "microphone-usb", kind: "microphone", label: "USB microphone" },
      ],
      cameras: [{ id: "camera-external", label: "External camera" }],
      displays: [{ id: "display-new", isPrimary: true, label: "New display" }],
    });
    expect(selected.snapshot.availableSources).toEqual({
      audioSources: [
        { id: "system", kind: "system", label: "System audio" },
        { id: "microphone-usb", kind: "microphone", label: "USB microphone" },
      ],
      cameras: [{ id: "camera-external", label: "External camera" }],
      displays: [{ id: "display-new", isPrimary: true, label: "New display" }],
    });
    expect(controllers).toHaveLength(1);
    expect(controllers[0]?.startOptions).toEqual([{
      camera: { deviceId: "camera-external", kind: "device" },
      displays: { displayIds: ["display-new"], kind: "selected" },
      microphone: { deviceId: "microphone-usb", kind: "device" },
      strictInputs: false,
      systemAudio: false,
      typedText: false,
    }]);
    await service.close();
  });

  test("uses active controller availability and interruption evidence instead of the startup probe", async () => {
    const root = await repository();
    const controllers: FakeController[] = [];
    let probeCall = 0;
    const service = new RecordingService({
      captureHelper: "/tmp/atet-capture",
      controllerFactory: (artifactRoot) => {
        const controller = new FakeController(artifactRoot);
        controllers.push(controller);
        return controller;
      },
      helperProbe: () => {
        probeCall += 1;
        return Promise.resolve({
          permissions: {
            accessibility: "authorized",
            camera: "authorized",
            inputMonitoring: "authorized",
            microphone: "authorized",
            screenCapture: "authorized",
            systemAudio: "authorized",
            windowMetadata: "authorized",
          },
          sources: {
            audioSources: [
              { id: "system", kind: "system", label: "System audio" },
              { id: "microphone", kind: "microphone", label: "Microphone" },
            ],
            cameras: [{ id: "camera", label: "Camera" }],
            displays: [{ id: "display", isPrimary: true, label: "Display" }],
          },
        });
      },
      now: () => new Date(timestamp),
      repositoryRoot: root,
    });
    await service.initialize();
    expect(DesktopResponseSchema.parse(await service.handle(
      request("request_active001", startCommand()),
      "atet.runtime.dispatch",
    )).ok).toBe(true);
    expect(controllers).toHaveLength(1);

    const interruption = {
      code: "camera-device-disconnected",
      nativeTimeUs: 11_000_000,
      recoverable: true,
      segmentIndex: 0,
      source: "camera",
      sourceId: "camera",
      sourceTimeUs: 1_000_000,
    } satisfies CaptureInterruption;
    controllers[0]!.availableSources = {
      audio: [
        defaultCaptureSources.audio[0]!,
        {
          audioSourceId: "microphone-replacement",
          channels: 1,
          kind: "microphone",
          label: "Replacement microphone",
          sampleRateHz: 48_000,
        },
      ],
      cameras: [{
        cameraId: "camera-replacement",
        frameRate: 30,
        label: "Replacement camera",
        pixelSize: { height: 1_080, width: 1_920 },
        position: "external",
      }],
      displays: [...defaultCaptureSources.displays],
    };
    controllers[0]!.lastInterruption = interruption;
    controllers[0]!.sourceTimeUs = 1_000_000;
    controllers[0]!.state = "paused";

    const interrupted = await service.snapshot();
    expect(probeCall).toBe(2);
    expect(interrupted.state).toMatchObject({
      sourceTimeUs: 1_000_000,
      state: "paused",
    });
    expect(interrupted.sources.cameras).toEqual([
      { id: "camera", label: "Camera" },
    ]);
    expect(interrupted.availableSources.cameras).toEqual([
      { id: "camera-replacement", label: "Replacement camera" },
    ]);
    expect(interrupted.lastInterruption).toEqual(interruption);

    const resumed = DesktopResponseSchema.parse(await service.handle(
      request("request_active002", {
        commandId: "command_resume002",
        kind: "resume",
      }),
      "atet.runtime.dispatch",
    ));
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error("Expected explicit resume to succeed.");
    expect(resumed.snapshot.sources.cameras).toEqual([
      { id: "camera-replacement", label: "Replacement camera" },
    ]);
    expect(resumed.snapshot.lastInterruption).toEqual(interruption);
    await service.close();
  });

  test("pushes material out-of-band interruptions without racing controller commands or elapsed-only noise", async () => {
    const root = await repository();
    const controllers: FakeController[] = [];
    const events: DesktopEvent[] = [];
    const service = new RecordingService({
      captureHelper: "/tmp/atet-capture",
      controllerFactory: (artifactRoot) => {
        const controller = new FakeController(artifactRoot);
        controllers.push(controller);
        return controller;
      },
      emit: (event) => {
        events.push(DesktopEventSchema.parse(event));
      },
      helperProbe: () => Promise.resolve({
        permissions: {
          accessibility: "authorized",
          camera: "authorized",
          inputMonitoring: "authorized",
          microphone: "authorized",
          screenCapture: "authorized",
          systemAudio: "authorized",
          windowMetadata: "authorized",
        },
        sources: {
          audioSources: [
            { id: "system", kind: "system", label: "System audio" },
            { id: "microphone", kind: "microphone", label: "Microphone" },
          ],
          cameras: [{ id: "camera", label: "Camera" }],
          displays: [{ id: "display", isPrimary: true, label: "Display" }],
        },
      }),
      now: () => new Date(timestamp),
      repositoryRoot: root,
      statusPollIntervalMs: 5,
    });
    await service.initialize();
    expect(DesktopResponseSchema.parse(await service.handle(
      request("request_watch0001", startCommand()),
      "atet.runtime.dispatch",
    )).ok).toBe(true);
    const controller = controllers[0];
    if (controller === undefined) throw new Error("Expected a controller.");
    const interruption = {
      code: "camera-device-disconnected",
      nativeTimeUs: 11_000_000,
      recoverable: true,
      segmentIndex: 0,
      source: "camera",
      sourceId: "camera",
      sourceTimeUs: 1_000_000,
    } satisfies CaptureInterruption;
    controller.state = "paused";
    controller.sourceTimeUs = 1_000_000;
    controller.lastInterruption = interruption;
    controller.availableSources = {
      ...defaultCaptureSources,
      cameras: [],
    };

    await waitFor(
      () => events.some((event) =>
        event.kind === "snapshot-changed"
        && event.snapshot.state.state === "paused"
        && event.snapshot.lastInterruption?.code === "camera-device-disconnected"
      ),
      "The status watcher did not push the interrupted pause.",
    );
    const interruptedEvents = events.filter(
      (event) => event.kind === "snapshot-changed",
    ).length;
    controller.sourceTimeUs = 9_000_000;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    expect(events.filter(
      (event) => event.kind === "snapshot-changed",
    )).toHaveLength(interruptedEvents);

    const blockedStatus = controller.blockNextStatus();
    await blockedStatus.started;
    const resumed = service.handle(
      request("request_watch0002", {
        commandId: "command_watch0002",
        kind: "resume",
      }),
      "atet.runtime.dispatch",
    );
    await Promise.resolve();
    expect(controller.resumeCalls).toBe(0);
    blockedStatus.release();
    expect(DesktopResponseSchema.parse(await resumed).ok).toBe(true);
    expect(controller.maxConcurrentOperations).toBe(1);

    expect(DesktopResponseSchema.parse(await service.handle(
      request("request_watch0003", {
        commandId: "command_watch0003",
        kind: "stop",
      }),
      "atet.runtime.dispatch",
    )).ok).toBe(true);
    await service.close();
    const statusCallsAfterClose = controller.statusCalls;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(controller.statusCalls).toBe(statusCallsAfterClose);
  });

  test("returns an owned source-specific failure reason without native diagnostics", async () => {
    const root = await repository();
    const controllers: FakeController[] = [];
    const service = new RecordingService({
      captureHelper: "/tmp/atet-capture",
      controllerFactory: (artifactRoot) => {
        const controller = new FakeController(artifactRoot);
        controllers.push(controller);
        return controller;
      },
      helperProbe: () => Promise.resolve({
        permissions: {
          accessibility: "authorized",
          camera: "authorized",
          inputMonitoring: "authorized",
          microphone: "authorized",
          screenCapture: "authorized",
          systemAudio: "authorized",
          windowMetadata: "authorized",
        },
        sources: {
          audioSources: [
            { id: "system", kind: "system", label: "System audio" },
            { id: "microphone", kind: "microphone", label: "Microphone" },
          ],
          cameras: [{ id: "camera", label: "Camera" }],
          displays: [{ id: "display", isPrimary: true, label: "Display" }],
        },
      }),
      now: () => new Date(timestamp),
      repositoryRoot: root,
    });
    await service.initialize();
    expect(DesktopResponseSchema.parse(await service.handle(
      request("request_failure001", startCommand()),
      "atet.runtime.dispatch",
    )).ok).toBe(true);
    expect(controllers).toHaveLength(1);

    controllers[0]!.pauseFailure = new CliError(
      "subprocess",
      "Native camera failure at /private/device/path.",
      {
        interruption: {
          code: "camera-device-disconnected",
          nativeTimeUs: 11_000_000,
          recoverable: false,
          segmentIndex: 0,
          source: "camera",
          sourceId: "camera-private-identifier",
          sourceTimeUs: 1_000_000,
        },
      },
    );
    const failed = DesktopResponseSchema.parse(await service.handle(
      request("request_failure002", {
        commandId: "command_failure02",
        kind: "pause",
      }),
      "atet.runtime.dispatch",
    ));

    expect(failed).toMatchObject({
      error: {
        code: "unavailable",
        message: "The camera disconnected. The recording stopped.",
        retryable: false,
      },
      ok: false,
    });
    if (failed.ok) throw new Error("Expected an interruption failure.");
    expect(failed.error.message).not.toContain("/private");
    expect(failed.error.message).not.toContain("camera-private-identifier");
    await service.close();
  });

  test("publishes and retains a fatal failed snapshot with exact recovery identity until a new start succeeds", async () => {
    const root = await repository();
    const controllers: FakeController[] = [];
    const events: DesktopEvent[] = [];
    let nextStartFailure: Error | null = null;
    const service = new RecordingService({
      captureHelper: "/tmp/atet-capture",
      controllerFactory: (artifactRoot) => {
        const controller = new FakeController(artifactRoot);
        controller.startFailure = nextStartFailure;
        nextStartFailure = null;
        controllers.push(controller);
        return controller;
      },
      emit: (event) => {
        events.push(DesktopEventSchema.parse(event));
      },
      helperProbe: () => Promise.resolve({
        permissions: {
          accessibility: "authorized",
          camera: "authorized",
          inputMonitoring: "authorized",
          microphone: "authorized",
          screenCapture: "authorized",
          systemAudio: "authorized",
          windowMetadata: "authorized",
        },
        sources: {
          audioSources: [
            { id: "system", kind: "system", label: "System audio" },
            { id: "microphone", kind: "microphone", label: "Microphone" },
          ],
          cameras: [{ id: "camera", label: "Camera" }],
          displays: [{ id: "display", isPrimary: true, label: "Display" }],
        },
      }),
      now: () => new Date(timestamp),
      repositoryRoot: root,
    });
    await service.initialize();
    expect(DesktopResponseSchema.parse(await service.handle(
      request("request_fatal0001", startCommand()),
      "atet.runtime.dispatch",
    )).ok).toBe(true);
    const first = controllers[0];
    if (first === undefined) throw new Error("Expected the first controller.");
    const interruption = {
      code: "camera-device-disconnected",
      nativeTimeUs: 12_000_000,
      recoverable: false,
      segmentIndex: 0,
      source: "camera",
      sourceId: "camera",
      sourceTimeUs: 1_500_000,
    } satisfies CaptureInterruption;
    first.pauseFailure = new CliError(
      "subprocess",
      "Native camera failure at /private/device/path.",
      {
        interruption,
        recovery: {
          controllerReusable: true,
          recordingId: "rec_fixture001",
          recordingRoot: join(first.artifactRoot, "rec_fixture001"),
          snapshot: {
            lastInterruption: interruption,
            logicalTimeUs: 1_500_000,
            permissions: recordingSnapshot(
              "recording",
              first.artifactRoot,
              0,
              {
                availableSources: defaultCaptureSources,
                lastInterruption: null,
                sources: first.selectedSources,
              },
            ).permissions,
            sources: first.selectedSources,
          },
          terminalManifestState: "failed",
        },
      },
    );

    const failedResponse = DesktopResponseSchema.parse(await service.handle(
      request("request_fatal0002", {
        commandId: "command_fatal0002",
        kind: "pause",
      }),
      "atet.runtime.dispatch",
    ));
    expect(failedResponse).toMatchObject({
      error: {
        message: "The camera disconnected. The recording stopped.",
      },
      ok: false,
    });
    const fatalEvents = events.slice(-2);
    expect(fatalEvents[0]).toMatchObject({
      kind: "snapshot-changed",
      snapshot: {
        lastInterruption: interruption,
        state: {
          code: "camera-device-disconnected",
          recordingId: "rec_fixture001",
          recordingPath: "artifacts/atet/recordings/rec_fixture001",
          sourceTimeUs: 1_500_000,
          state: "failed",
        },
      },
    });
    expect(fatalEvents[1]).toEqual({
      commandId: "command_fatal0002",
      kind: "command-settled",
      protocolVersion: ATET_DESKTOP_PROTOCOL_VERSION,
      status: "failed",
    });
    expect(JSON.stringify(fatalEvents)).not.toContain("/private/");
    expect(first.closeCalls).toBe(1);

    const retained = await service.snapshot();
    expect(retained).toMatchObject({
      sources: {
        cameras: [{ id: "camera", label: "Camera" }],
      },
      state: {
        recordingId: "rec_fixture001",
        recordingPath: "artifacts/atet/recordings/rec_fixture001",
        state: "failed",
      },
    });

    nextStartFailure = new CliError(
      "invalid-data",
      "Restart finalization failed at /private/restart/session.",
      {
        recovery: {
          controllerReusable: true,
          recordingId: "rec_restart001",
          recordingRoot: join(
            root,
            "artifacts",
            "atet",
            "recordings",
            "rec_restart001",
          ),
          snapshot: {
            lastInterruption: null,
            logicalTimeUs: 0,
            permissions: recordingSnapshot(
              "recording",
              join(root, "artifacts", "atet", "recordings"),
              0,
              {
                availableSources: defaultCaptureSources,
                lastInterruption: null,
                sources: defaultCaptureSources,
              },
            ).permissions,
            sources: defaultCaptureSources,
          },
          terminalManifestState: "failed",
        },
      },
    );
    const failedRestart = DesktopResponseSchema.parse(await service.handle(
      request("request_fatal0003", {
        ...startCommand(),
        commandId: "command_fatal0003",
      }),
      "atet.runtime.dispatch",
    ));
    expect(failedRestart).toMatchObject({
      error: {
        code: "internal",
        message: "The recording stopped after a local capture failure.",
      },
      ok: false,
    });
    const retainedFailedRestart = await service.snapshot();
    expect(retainedFailedRestart).toMatchObject({
      lastInterruption: null,
      state: {
        code: "capture-session-failed",
        recordingId: "rec_restart001",
        recordingPath:
          "artifacts/atet/recordings/rec_restart001",
        sourceTimeUs: 0,
        state: "failed",
      },
    });
    expect(JSON.stringify({
      response: failedRestart,
      snapshot: retainedFailedRestart,
    })).not.toContain("/private/");

    const restarted = DesktopResponseSchema.parse(await service.handle(
      request("request_fatal0004", {
        ...startCommand(),
        commandId: "command_fatal0004",
      }),
      "atet.runtime.dispatch",
    ));
    expect(restarted.ok).toBe(true);
    if (!restarted.ok) throw new Error("Expected a successful recovery start.");
    expect(restarted.snapshot.state.state).toBe("recording");
    expect(restarted.snapshot.lastInterruption).toBeNull();
    expect(controllers).toHaveLength(3);
    await service.close();
  });

  test("materializes settled verifier and source-specific asset failures without exposing raw CLI diagnostics", async () => {
    const root = await repository();
    const controllers: FakeController[] = [];
    const events: DesktopEvent[] = [];
    const service = new RecordingService({
      captureHelper: "/tmp/atet-capture",
      controllerFactory: (artifactRoot) => {
        const controller = new FakeController(artifactRoot);
        controllers.push(controller);
        return controller;
      },
      emit: (event) => {
        events.push(DesktopEventSchema.parse(event));
      },
      helperProbe: () => Promise.resolve({
        permissions: {
          accessibility: "authorized",
          camera: "authorized",
          inputMonitoring: "authorized",
          microphone: "authorized",
          screenCapture: "authorized",
          systemAudio: "authorized",
          windowMetadata: "authorized",
        },
        sources: {
          audioSources: [
            { id: "system", kind: "system", label: "System audio" },
            { id: "microphone", kind: "microphone", label: "Microphone" },
          ],
          cameras: [{ id: "camera", label: "Camera" }],
          displays: [{ id: "display", isPrimary: true, label: "Display" }],
        },
      }),
      now: () => new Date(timestamp),
      repositoryRoot: root,
    });
    await service.initialize();
    expect(DesktopResponseSchema.parse(await service.handle(
      request("request_verify001", startCommand()),
      "atet.runtime.dispatch",
    )).ok).toBe(true);
    const controller = controllers[0];
    if (controller === undefined) throw new Error("Expected a controller.");
    const recoveredVerifierInterruption = {
      code: "camera-recording-failed",
      nativeTimeUs: 12_000_000,
      recoverable: false,
      segmentIndex: 0,
      source: "camera",
      sourceId: "camera",
      sourceTimeUs: 1_200_000,
    } satisfies CaptureInterruption;
    controller.pauseFailure = new CliError(
      "invalid-data",
      "ffprobe rejected /private/recordings/secret-camera.mov.",
      {
        diagnosticCode: "capture-media-verification-failed",
        recovery: {
          controllerReusable: true,
          recordingId: "rec_fixture001",
          recordingRoot: join(controller.artifactRoot, "rec_fixture001"),
          snapshot: {
            lastInterruption: recoveredVerifierInterruption,
            logicalTimeUs: 1_250_000,
            permissions: recordingSnapshot(
              "recording",
              controller.artifactRoot,
              0,
              {
                availableSources: defaultCaptureSources,
                lastInterruption: null,
                sources: controller.selectedSources,
              },
            ).permissions,
            sources: controller.selectedSources,
          },
          terminalManifestState: "failed",
        },
      },
    );

    const response = DesktopResponseSchema.parse(await service.handle(
      request("request_verify002", {
        commandId: "command_verify002",
        kind: "pause",
      }),
      "atet.runtime.dispatch",
    ));
    expect(response).toMatchObject({
      error: {
        code: "internal",
        message: "Camera recording failed. The recording stopped.",
        retryable: false,
      },
      ok: false,
    });
    expect(events.slice(-2)).toMatchObject([{
      kind: "snapshot-changed",
      snapshot: {
        lastInterruption: recoveredVerifierInterruption,
        state: {
          code: "camera-recording-failed",
          message: "Camera recording failed. The recording stopped.",
          recordingId: "rec_fixture001",
          recordingPath: "artifacts/atet/recordings/rec_fixture001",
          sourceTimeUs: 1_200_000,
          state: "failed",
        },
      },
    }, {
      commandId: "command_verify002",
      kind: "command-settled",
      status: "failed",
    }]);
    expect(JSON.stringify({ events, response })).not.toContain("/private/");
    expect(JSON.stringify({ events, response })).not.toContain("ffprobe");
    expect(controller.closeCalls).toBe(1);
    expect(await service.snapshot()).toMatchObject({
      lastInterruption: recoveredVerifierInterruption,
      state: {
        code: "camera-recording-failed",
        sourceTimeUs: 1_200_000,
        state: "failed",
      },
    });

    const restarted = DesktopResponseSchema.parse(await service.handle(
      request("request_verify003", {
        ...startCommand(),
        commandId: "command_verify003",
      }),
      "atet.runtime.dispatch",
    ));
    expect(restarted.ok).toBeTrue();
    const second = controllers[1];
    if (second === undefined) throw new Error("Expected a restarted controller.");
    second.pauseFailure = new CliError(
      "subprocess",
      "Finalized asset /private/recordings/display-secret.mov has no audio.",
      {
        helperCode: "system-audio-track-missing",
        interruption: null,
        recovery: {
          controllerReusable: true,
          recordingId: "rec_fixture001",
          recordingRoot: join(second.artifactRoot, "rec_fixture001"),
          snapshot: {
            lastInterruption: null,
            logicalTimeUs: 2_500_000,
            permissions: recordingSnapshot(
              "recording",
              second.artifactRoot,
              0,
              {
                availableSources: defaultCaptureSources,
                lastInterruption: null,
                sources: second.selectedSources,
              },
            ).permissions,
            sources: second.selectedSources,
          },
          terminalManifestState: "failed",
        },
      },
    );
    const systemAudioResponse = DesktopResponseSchema.parse(
      await service.handle(
        request("request_verify004", {
          commandId: "command_verify004",
          kind: "pause",
        }),
        "atet.runtime.dispatch",
      ),
    );
    expect(systemAudioResponse).toMatchObject({
      error: {
        code: "internal",
        message: "System audio was missing from the finalized recording.",
        retryable: false,
      },
      ok: false,
    });
    const systemAudioEvent = events.findLast((event) =>
      event.kind === "snapshot-changed"
      && event.snapshot.state.state === "failed"
      && event.snapshot.state.code === "system-audio-track-missing"
    );
    expect(systemAudioEvent).toMatchObject({
      kind: "snapshot-changed",
      snapshot: {
        lastInterruption: null,
        state: {
          code: "system-audio-track-missing",
          message: "System audio was missing from the finalized recording.",
          recordingId: "rec_fixture001",
          recordingPath: "artifacts/atet/recordings/rec_fixture001",
          sourceTimeUs: 2_500_000,
          state: "failed",
        },
      },
    });
    expect(JSON.stringify({
      event: systemAudioEvent,
      response: systemAudioResponse,
    })).not.toContain("/private/");
    expect(second.closeCalls).toBe(1);
    const systemAudioSnapshot = await service.snapshot();
    expect(systemAudioSnapshot.lastInterruption).toBeNull();
    expect(systemAudioSnapshot.state).toMatchObject({
      code: "system-audio-track-missing",
      state: "failed",
    });

    const restartedAfterSystemAudio = DesktopResponseSchema.parse(
      await service.handle(
        request("request_verify005", {
          ...startCommand(),
          commandId: "command_verify005",
        }),
        "atet.runtime.dispatch",
      ),
    );
    expect(restartedAfterSystemAudio.ok).toBeTrue();
    if (!restartedAfterSystemAudio.ok) {
      throw new Error("Expected system-audio failure recovery.");
    }
    expect(restartedAfterSystemAudio.snapshot.lastInterruption).toBeNull();
    expect(controllers).toHaveLength(3);

    const third = controllers[2];
    if (third === undefined) throw new Error("Expected a second restarted controller.");
    third.pauseFailure = new CliError(
      "internal",
      "Finalization failed at /private/recordings/wrapped-display-secret.mov.",
      {
        captureFailure: {
          code: "system-audio-track-missing",
          details: {
            nativePath: "/private/recordings/wrapped-display-secret.mov",
          },
        },
        recovery: {
          controllerReusable: false,
          recordingId: "rec_fixture001",
          recordingRoot: join(third.artifactRoot, "rec_fixture001"),
          snapshot: {
            lastInterruption: null,
            logicalTimeUs: 3_750_000,
            permissions: recordingSnapshot(
              "recording",
              third.artifactRoot,
              0,
              {
                availableSources: defaultCaptureSources,
                lastInterruption: null,
                sources: third.selectedSources,
              },
            ).permissions,
            sources: third.selectedSources,
          },
          terminalManifestState: "failed",
        },
        recoveryErrors: [
          "manifest: could not settle /private/recordings/wrapped-display-secret.mov",
        ],
      },
    );
    const wrappedSystemAudioResponse = DesktopResponseSchema.parse(
      await service.handle(
        request("request_verify006", {
          commandId: "command_verify006",
          kind: "pause",
        }),
        "atet.runtime.dispatch",
      ),
    );
    expect(wrappedSystemAudioResponse).toMatchObject({
      error: {
        code: "internal",
        message: "The recording stopped, but local recovery did not complete.",
        retryable: false,
      },
      ok: false,
    });
    const wrappedSystemAudioSnapshot = await service.snapshot();
    expect(wrappedSystemAudioSnapshot).toMatchObject({
      lastInterruption: null,
      state: {
        code: "capture-recovery-incomplete",
        message: "The recording stopped, but local recovery did not complete.",
        recordingId: "rec_fixture001",
        recordingPath: "artifacts/atet/recordings/rec_fixture001",
        sourceTimeUs: 3_750_000,
        state: "failed",
      },
    });
    expect(JSON.stringify({
      response: wrappedSystemAudioResponse,
      snapshot: wrappedSystemAudioSnapshot,
    })).not.toContain("/private/");

    const restartedAfterWrappedSystemAudio = DesktopResponseSchema.parse(
      await service.handle(
        request("request_verify007", {
          ...startCommand(),
          commandId: "command_verify007",
        }),
        "atet.runtime.dispatch",
      ),
    );
    expect(restartedAfterWrappedSystemAudio).toMatchObject({
      error: {
        code: "unavailable",
        message: "Recording is disabled because local recovery did not complete.",
        retryable: false,
      },
      ok: false,
    });
    expect(controllers).toHaveLength(3);
    await service.close();
  });

  test("watcher preserves nested interruption evidence while blocking incomplete recovery", async () => {
    const root = await repository();
    const controllers: FakeController[] = [];
    const events: DesktopEvent[] = [];
    const service = new RecordingService({
      captureHelper: "/tmp/atet-capture",
      controllerFactory: (artifactRoot) => {
        const controller = new FakeController(artifactRoot);
        controllers.push(controller);
        return controller;
      },
      emit: (event) => {
        events.push(DesktopEventSchema.parse(event));
      },
      helperProbe: () => Promise.resolve({
        permissions: {
          accessibility: "authorized",
          camera: "authorized",
          inputMonitoring: "authorized",
          microphone: "authorized",
          screenCapture: "authorized",
          systemAudio: "authorized",
          windowMetadata: "authorized",
        },
        sources: {
          audioSources: [
            { id: "system", kind: "system", label: "System audio" },
            { id: "microphone", kind: "microphone", label: "Microphone" },
          ],
          cameras: [{ id: "camera", label: "Camera" }],
          displays: [{ id: "display", isPrimary: true, label: "Display" }],
        },
      }),
      now: () => new Date(timestamp),
      repositoryRoot: root,
      statusPollIntervalMs: 5,
    });
    await service.initialize();
    expect(DesktopResponseSchema.parse(await service.handle(
      request("request_nested001", startCommand()),
      "atet.runtime.dispatch",
    )).ok).toBe(true);
    const controller = controllers[0];
    if (controller === undefined) throw new Error("Expected a controller.");
    const interruption = {
      code: "camera-runtime-error",
      nativeTimeUs: 12_000_000,
      recoverable: false,
      segmentIndex: 0,
      source: "camera",
      sourceId: "camera",
      sourceTimeUs: 1_500_000,
    } satisfies CaptureInterruption;
    controller.statusFailure = new CliError(
      "internal",
      "Capture recovery failed at /private/native/session.",
      {
        captureFailure: {
          code: "subprocess",
          details: {
            interruption,
            nativePath: "/private/native/session",
          },
        },
        recovery: {
          controllerReusable: true,
          recordingId: "rec_fixture001",
          recordingRoot: join(controller.artifactRoot, "rec_fixture001"),
          snapshot: {
            lastInterruption: interruption,
            logicalTimeUs: 1_500_000,
            permissions: recordingSnapshot(
              "recording",
              controller.artifactRoot,
              0,
              {
                availableSources: defaultCaptureSources,
                lastInterruption: interruption,
                sources: controller.selectedSources,
              },
            ).permissions,
            sources: controller.selectedSources,
          },
          terminalManifestState: "unsettled",
        },
        recoveryErrors: ["helper: /private/native/session"],
      },
    );

    await waitFor(
      () => events.some((event) =>
        event.kind === "snapshot-changed"
        && event.snapshot.state.state === "failed"
        && event.snapshot.state.code === "capture-recovery-incomplete"
      ),
      "The watcher swallowed nested incomplete recovery evidence.",
    );
    const failed = events.findLast((event) =>
      event.kind === "snapshot-changed"
      && event.snapshot.state.state === "failed"
    );
    expect(failed).toMatchObject({
      kind: "snapshot-changed",
      snapshot: {
        lastInterruption: interruption,
        state: {
          code: "capture-recovery-incomplete",
          message: "The recording stopped, but local recovery did not complete.",
          recordingId: "rec_fixture001",
          recordingPath: "artifacts/atet/recordings/rec_fixture001",
          state: "failed",
        },
      },
    });
    expect(JSON.stringify(failed)).not.toContain("/private/");
    expect(controller.closeCalls).toBe(1);
    expect((await service.snapshot()).state.state).toBe("failed");
    await service.close();
  });

  test("refreshes idle snapshots after device hot-plug and fails soft with cleared evidence", async () => {
    const root = await repository();
    let probeCall = 0;
    const permissions = {
      accessibility: "authorized",
      camera: "authorized",
      inputMonitoring: "authorized",
      microphone: "authorized",
      screenCapture: "authorized",
      systemAudio: "authorized",
      windowMetadata: "authorized",
    } as const;
    const service = new RecordingService({
      captureHelper: "/tmp/atet-capture",
      controllerFactory: (artifactRoot) => new FakeController(artifactRoot),
      helperProbe: () => {
        probeCall += 1;
        if (probeCall === 3) return Promise.reject(new Error("probe unavailable"));
        return Promise.resolve({
          permissions,
          sources: probeCall === 1
            ? {
                audioSources: [],
                cameras: [],
                displays: [{ id: "display-stale", isPrimary: true, label: "Stale display" }],
              }
            : {
                audioSources: [{
                  id: "microphone-new",
                  kind: "microphone",
                  label: "New microphone",
                }],
                cameras: [{ id: "camera-new", label: "New camera" }],
                displays: [{ id: "display-new", isPrimary: true, label: "New display" }],
              },
        });
      },
      now: () => new Date(timestamp),
      repositoryRoot: root,
    });
    await service.initialize();

    const refreshed = await service.snapshot();
    expect(probeCall).toBe(2);
    expect(refreshed.sources).toEqual({
      audioSources: [],
      cameras: [],
      displays: [],
    });
    expect(refreshed.availableSources).toEqual({
      audioSources: [{
        id: "microphone-new",
        kind: "microphone",
        label: "New microphone",
      }],
      cameras: [{ id: "camera-new", label: "New camera" }],
      displays: [{ id: "display-new", isPrimary: true, label: "New display" }],
    });

    const unavailable = await service.snapshot();
    expect(probeCall).toBe(3);
    expect(unavailable.availableSources).toEqual({
      audioSources: [],
      cameras: [],
      displays: [],
    });
    expect(Object.values(unavailable.permissions).every(
      permission => permission === "unavailable",
    )).toBe(true);
  });

  test("does not restore stale recorder permissions after an idle snapshot refresh fails", async () => {
    const root = await repository();
    const controllers: FakeController[] = [];
    let probeCall = 0;
    const service = new RecordingService({
      captureHelper: "/tmp/atet-capture",
      controllerFactory: (artifactRoot) => {
        const controller = new FakeController(artifactRoot);
        controllers.push(controller);
        return controller;
      },
      helperProbe: () => {
        probeCall += 1;
        if (probeCall > 2) return Promise.reject(new Error("probe unavailable"));
        return Promise.resolve({
          permissions: {
            accessibility: "authorized",
            camera: "authorized",
            inputMonitoring: "authorized",
            microphone: "authorized",
            screenCapture: "authorized",
            systemAudio: "authorized",
            windowMetadata: "authorized",
          },
          sources: {
            audioSources: [],
            cameras: [],
            displays: [{ id: "display", isPrimary: true, label: "Display" }],
          },
        });
      },
      now: () => new Date(timestamp),
      repositoryRoot: root,
    });
    await service.initialize();
    const started = DesktopResponseSchema.parse(await service.handle(
      request("request_idleprobe1", startCommand()),
      "atet.runtime.dispatch",
    ));
    expect(started.ok).toBe(true);
    expect(controllers).toHaveLength(1);

    controllers[0]!.state = "idle";
    const snapshot = await service.snapshot();

    expect(probeCall).toBe(3);
    expect(controllers[0]!.closeCalls).toBe(1);
    expect(snapshot.availableSources).toEqual({
      audioSources: [],
      cameras: [],
      displays: [],
    });
    expect(snapshot.sources.displays).toEqual([
      { id: "display", isPrimary: true, label: "Display" },
    ]);
    expect(Object.values(snapshot.permissions).every(
      permission => permission === "unavailable",
    )).toBe(true);
  });

  test("fails closed and clears stale sources when the pre-start refresh fails", async () => {
    const root = await repository();
    const controllers: FakeController[] = [];
    let probeCall = 0;
    const service = new RecordingService({
      captureHelper: "/tmp/atet-capture",
      controllerFactory: (artifactRoot) => {
        const controller = new FakeController(artifactRoot);
        controllers.push(controller);
        return controller;
      },
      helperProbe: () => {
        probeCall += 1;
        if (probeCall > 1) return Promise.reject(new Error("disconnected"));
        return Promise.resolve({
          permissions: {
            accessibility: "authorized",
            camera: "authorized",
            inputMonitoring: "authorized",
            microphone: "authorized",
            screenCapture: "authorized",
            systemAudio: "authorized",
            windowMetadata: "authorized",
          },
          sources: {
            audioSources: [{ id: "system", kind: "system", label: "System audio" }],
            cameras: [],
            displays: [{ id: "display-stale", isPrimary: true, label: "Stale display" }],
          },
        });
      },
      now: () => new Date(timestamp),
      repositoryRoot: root,
    });
    await service.initialize();

    const failed = DesktopResponseSchema.parse(await service.handle(
      request("request_refreshfail", startCommand()),
      "atet.runtime.dispatch",
    ));
    expect(failed).toMatchObject({
      error: {
        code: "unavailable",
        message: "The capture helper capability probe failed.",
        retryable: true,
      },
      ok: false,
    });
    expect(controllers).toHaveLength(0);
    expect((await service.snapshot()).availableSources).toEqual({
      audioSources: [],
      cameras: [],
      displays: [],
    });
  });

  test("keeps the command concurrency gate closed while the pre-start probe is in flight", async () => {
    const root = await repository();
    let probeCall = 0;
    let refreshWaiting = false;
    let releaseRefresh: () => void = () => {
      throw new Error("The start refresh is not waiting.");
    };
    const probe = {
      permissions: {
        accessibility: "authorized",
        camera: "authorized",
        inputMonitoring: "authorized",
        microphone: "authorized",
        screenCapture: "authorized",
        systemAudio: "authorized",
        windowMetadata: "authorized",
      },
      sources: {
        audioSources: [{ id: "system", kind: "system", label: "System audio" }],
        cameras: [],
        displays: [{ id: "display", isPrimary: true, label: "Display" }],
      },
    } satisfies Awaited<ReturnType<HelperProbe>>;
    const service = new RecordingService({
      captureHelper: "/tmp/atet-capture",
      controllerFactory: (artifactRoot) => new FakeController(artifactRoot),
      helperProbe: async () => {
        probeCall += 1;
        if (probeCall === 2) {
          await new Promise<void>((resolve) => {
            refreshWaiting = true;
            releaseRefresh = resolve;
          });
        }
        return probe;
      },
      now: () => new Date(timestamp),
      repositoryRoot: root,
    });
    await service.initialize();

    const starting = service.handle(
      request("request_blocked001", startCommand()),
      "atet.runtime.dispatch",
    );
    await Promise.resolve();
    expect(probeCall).toBe(2);
    const concurrent = DesktopResponseSchema.parse(await service.handle(
      request("request_concurrent1", { commandId: "command_concurrent1", kind: "pause" }),
      "atet.runtime.dispatch",
    ));
    expect(concurrent).toMatchObject({
      error: { code: "conflict", retryable: true },
      ok: false,
    });

    expect(refreshWaiting).toBe(true);
    releaseRefresh();
    expect(DesktopResponseSchema.parse(await starting).ok).toBe(true);
    await service.close();
  });

  test("fails closed for bridge mismatches and emits a failed settlement", async () => {
    const root = await repository();
    const events: DesktopEvent[] = [];
    const service = new RecordingService({
      captureHelper: "/tmp/atet-capture",
      controllerFactory: (artifactRoot) => new FakeController(artifactRoot),
      emit: (event) => {
        events.push(event);
      },
      helperProbe: () => Promise.reject(new Error("unavailable")),
      now: () => new Date(timestamp),
      repositoryRoot: root,
    });
    await service.initialize();

    const mismatch = DesktopResponseSchema.parse(await service.handle(
      request("request_mismatch01", startCommand()),
      "atet.runtime.snapshot",
    ));
    expect(mismatch.ok).toBe(false);
    expect(events).toEqual([]);

    const failed = DesktopResponseSchema.parse(await service.handle(
      request("request_pausefail1", { commandId: "command_pausefail1", kind: "pause" }),
      "atet.runtime.dispatch",
    ));
    expect(failed.ok).toBe(false);
    expect(events).toEqual([{
      commandId: "command_pausefail1",
      kind: "command-settled",
      protocolVersion: ATET_DESKTOP_PROTOCOL_VERSION,
      status: "failed",
    }]);
  });
});

test("repository discovery canonicalizes physical project roots without requiring a tool checkout", async () => {
  const root = await repository();
  expect(await resolveGatewayRepositoryRoot(root)).toBe(root);
  expect(await resolveGatewayRepositoryRoot(undefined)).toBeNull();
  expect(await resolveGatewayRepositoryRoot(join(root, "media")))
    .toBe(await realpath(join(root, "media")));
  expect(resolveGatewayRepositoryRoot("relative/project"))
    .rejects.toThrow("must be absolute");
});
