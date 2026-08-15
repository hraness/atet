import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import {
  DesktopEventSchema,
  DesktopResponseSchema,
  ATET_DESKTOP_PROTOCOL_VERSION,
  type CaptureDomainCommand,
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
} from "../../cli/recording-controller";
import { HostResponseSchema } from "./host-protocol";
import { runGatewayProtocol } from "./main";
import { RecordingService } from "./recording-service";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => await rm(path, { force: true, recursive: true })));
});

async function fixture(): Promise<{ helper: string; repository: string }> {
  const repository = await mkdtemp(join(tmpdir(), "atet-gateway-integration-"));
  temporaryDirectories.push(repository);
  const desktop = join(repository, "projects", "atet", "apps", "desktop");
  await mkdir(desktop, { recursive: true });
  await writeFile(join(desktop, "package.json"), "{}\n");
  const probe = {
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
      audio: [{
        audioSourceId: "system",
        channels: 2,
        kind: "system",
        label: "System audio",
        sampleRateHz: 48_000,
      }],
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
    },
  };
  const helper = join(repository, "fake-capture-helper");
  await writeFile(helper, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(probe)}'\n`, { mode: 0o755 });
  await chmod(helper, 0o755);
  return { helper, repository };
}

function hostRequest(id: string, payload: unknown, command: "atet.runtime.dispatch" | "atet.runtime.snapshot"): string {
  return `${JSON.stringify({ command, id, payload })}\n`;
}

const gatewaySources = {
  audio: [{
    audioSourceId: "system",
    channels: 2,
    kind: "system",
    label: "System audio",
    sampleRateHz: 48_000,
  }],
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

class GatewayController implements RecordingController {
  readonly artifactRoot: string;
  availableSources: CaptureSourceInventory = gatewaySources;
  lastInterruption: CaptureInterruption | null = null;
  selectedSources: CaptureSourceInventory = {
    audio: [],
    cameras: [],
    displays: [],
  };
  state: RecordingSnapshot["state"] = "idle";
  sourceTimeUs = 0;

  constructor(artifactRoot: string) {
    this.artifactRoot = artifactRoot;
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  pause(): Promise<RecordingSnapshot> {
    this.state = "paused";
    return Promise.resolve(this.snapshot());
  }

  resume(): Promise<RecordingSnapshot> {
    this.state = "recording";
    return Promise.resolve(this.snapshot());
  }

  start(): Promise<RecordingSnapshot> {
    this.selectedSources = gatewaySources;
    this.state = "recording";
    return Promise.resolve(this.snapshot());
  }

  status(): Promise<RecordingSnapshot> {
    return Promise.resolve(this.snapshot());
  }

  stop(): Promise<RecordingSnapshot> {
    this.state = "idle";
    this.sourceTimeUs = 2_000_000;
    return Promise.resolve(this.snapshot());
  }

  private snapshot(): RecordingSnapshot {
    return {
      availableSources: this.availableSources,
      completedSegmentCount: this.state === "idle" ? 1 : 0,
      effectiveConfig: this.state === "idle" ? null : {
        camera: { kind: "default" },
        displays: { kind: "all" },
        metadata: true,
        microphone: { kind: "default" },
        strictInputs: false,
        systemAudio: true,
        typedText: false,
      },
      lastInterruption: this.lastInterruption,
      logicalTimeUs: this.sourceTimeUs,
      permissions: {
        accessibility: "authorized",
        camera: "authorized",
        inputMonitoring: "authorized",
        microphone: "authorized",
        screenCapture: "authorized",
        systemAudio: "authorized",
        windowMetadata: "authorized",
      },
      recordingId: "rec_gateway01",
      recordingRoot: join(this.artifactRoot, "rec_gateway01"),
      sources: this.selectedSources,
      state: this.state,
      updatedAt: "2026-07-22T12:00:00.000Z",
    };
  }
}

function dispatchRequest(
  requestId: string,
  command: CaptureDomainCommand,
): unknown {
  return {
    payload: { command, kind: "dispatch" },
    protocol: "studio.desktop",
    protocolVersion: ATET_DESKTOP_PROTOCOL_VERSION,
    requestId,
  };
}

async function waitForFrame(
  frames: readonly unknown[],
  predicate: (frame: unknown) => boolean,
  message: string,
): Promise<unknown> {
  const deadline = Date.now() + 1_000;
  while (true) {
    const frame = frames.find(predicate);
    if (frame !== undefined) return frame;
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

function isHostResponse(frame: unknown, id: string): boolean {
  const parsed = HostResponseSchema.safeParse(frame);
  return parsed.success && parsed.data.id === id;
}

test("gateway round-trips responses and emits raw DesktopEvent frames", async () => {
  const { helper, repository } = await fixture();
  const gateway = Bun.spawn([process.execPath, join(import.meta.dir, "main.ts")], {
    env: {
      ...process.env,
      ATET_CAPTURE_HELPER: helper,
      ATET_REPOSITORY_ROOT: repository,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = gateway.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const readLine = async (): Promise<string> => {
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        return line;
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error("Gateway stdout closed before a full frame.");
      buffer += decoder.decode(chunk.value, { stream: true });
    }
  };

  const snapshotRequest = {
    payload: { kind: "snapshot" },
    protocol: "studio.desktop",
    protocolVersion: ATET_DESKTOP_PROTOCOL_VERSION,
    requestId: "request_gateway001",
  };
  await gateway.stdin.write(hostRequest("bridge-snapshot", snapshotRequest, "atet.runtime.snapshot"));
  await gateway.stdin.flush();
  const snapshotFrame = HostResponseSchema.parse(JSON.parse(await readLine()) as unknown);
  expect(snapshotFrame.ok).toBe(true);
  if (!snapshotFrame.ok) throw new Error("Expected a successful snapshot host frame.");
  const snapshotResponse = DesktopResponseSchema.parse(snapshotFrame.result);
  expect(snapshotResponse.ok).toBe(true);
  if (snapshotResponse.ok) {
    expect(snapshotResponse.snapshot.sources.displays).toEqual([]);
    expect(snapshotResponse.snapshot.availableSources.displays).toEqual([
      { id: "display", isPrimary: true, label: "Display" },
    ]);
    expect(snapshotResponse.snapshot.lastInterruption).toBeNull();
  }

  const dispatchRequest = {
    payload: {
      command: { commandId: "command_gateway01", kind: "pause" },
      kind: "dispatch",
    },
    protocol: "studio.desktop",
    protocolVersion: ATET_DESKTOP_PROTOCOL_VERSION,
    requestId: "request_gateway002",
  };
  await gateway.stdin.write(hostRequest("bridge-dispatch", dispatchRequest, "atet.runtime.dispatch"));
  await gateway.stdin.flush();
  await gateway.stdin.end();

  expect(DesktopEventSchema.parse(JSON.parse(await readLine()) as unknown)).toEqual({
    commandId: "command_gateway01",
    kind: "command-settled",
    protocolVersion: ATET_DESKTOP_PROTOCOL_VERSION,
    status: "failed",
  });
  const dispatchFrame = HostResponseSchema.parse(JSON.parse(await readLine()) as unknown);
  expect(dispatchFrame.ok).toBe(true);
  if (!dispatchFrame.ok) throw new Error("Expected a host transport success.");
  const dispatchResponse = DesktopResponseSchema.parse(dispatchFrame.result);
  expect(dispatchResponse.ok).toBe(false);

  expect(await gateway.exited).toBe(0);
  await reader.cancel();
});

test("gateway streams an autonomous interrupted pause before serialized resume and stop responses", async () => {
  const { helper, repository } = await fixture();
  const repositoryRoot = await realpath(repository);
  const input = new PassThrough();
  const frames: unknown[] = [];
  const controllers: GatewayController[] = [];
  const gateway = runGatewayProtocol({
    createService: (emit) => new RecordingService({
      captureHelper: helper,
      controllerFactory: (artifactRoot) => {
        const controller = new GatewayController(artifactRoot);
        controllers.push(controller);
        return controller;
      },
      emit,
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
      now: () => new Date("2026-07-22T12:00:00.000Z"),
      repositoryRoot,
      statusPollIntervalMs: 5,
    }),
    input,
    writeLine: (line) => {
      frames.push(JSON.parse(line) as unknown);
      return Promise.resolve();
    },
  });
  input.write(hostRequest(
    "bridge-start",
    dispatchRequest("request_gatewaystart", {
      commandId: "command_gatewaystart",
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
    }),
    "atet.runtime.dispatch",
  ));
  const startFrame = HostResponseSchema.parse(await waitForFrame(
    frames,
    (frame) => isHostResponse(frame, "bridge-start"),
    "Gateway did not return the start response.",
  ));
  expect(startFrame.ok).toBe(true);
  if (!startFrame.ok) throw new Error("Expected a successful start host frame.");
  const startResponse = DesktopResponseSchema.parse(startFrame.result);
  expect(startResponse).toMatchObject({
    ok: true,
    snapshot: { state: { state: "recording" } },
  });

  const activeController = controllers[0];
  if (activeController === undefined) throw new Error("Expected a gateway controller.");
  activeController.state = "paused";
  activeController.sourceTimeUs = 1_000_000;
  activeController.lastInterruption = {
    code: "camera-device-disconnected",
    nativeTimeUs: 10_000_000,
    recoverable: true,
    segmentIndex: 0,
    source: "camera",
    sourceId: "camera",
    sourceTimeUs: 1_000_000,
  };
  activeController.availableSources = {
    ...gatewaySources,
    cameras: [],
  };
  const interruptedFrame = DesktopEventSchema.parse(await waitForFrame(
    frames,
    (frame) => {
      const parsed = DesktopEventSchema.safeParse(frame);
      return parsed.success
        && parsed.data.kind === "snapshot-changed"
        && parsed.data.snapshot.state.state === "paused"
        && parsed.data.snapshot.lastInterruption?.code === "camera-device-disconnected";
    },
    "Gateway did not stream the autonomous interrupted pause.",
  ));
  expect(interruptedFrame).toMatchObject({
    kind: "snapshot-changed",
    protocolVersion: ATET_DESKTOP_PROTOCOL_VERSION,
    snapshot: {
      availableSources: { cameras: [] },
      sources: { cameras: [{ id: "camera", label: "Camera" }] },
      state: { state: "paused" },
    },
  });

  input.write(hostRequest(
    "bridge-resume",
    dispatchRequest("request_gatewayresume", {
      commandId: "command_gatewayresume",
      kind: "resume",
    }),
    "atet.runtime.dispatch",
  ));
  const resumeFrame = HostResponseSchema.parse(await waitForFrame(
    frames,
    (frame) => isHostResponse(frame, "bridge-resume"),
    "Gateway did not return the resume response.",
  ));
  expect(resumeFrame.ok).toBe(true);
  if (!resumeFrame.ok) throw new Error("Expected a successful resume host frame.");
  expect(DesktopResponseSchema.parse(resumeFrame.result)).toMatchObject({
    ok: true,
    snapshot: {
      lastInterruption: { code: "camera-device-disconnected" },
      state: { state: "recording" },
    },
  });

  input.write(hostRequest(
    "bridge-stop",
    dispatchRequest("request_gatewaystop", {
      commandId: "command_gatewaystop",
      kind: "stop",
    }),
    "atet.runtime.dispatch",
  ));
  const stopFrame = HostResponseSchema.parse(await waitForFrame(
    frames,
    (frame) => isHostResponse(frame, "bridge-stop"),
    "Gateway did not return the stop response.",
  ));
  expect(stopFrame.ok).toBe(true);
  if (!stopFrame.ok) throw new Error("Expected a successful stop host frame.");
  expect(DesktopResponseSchema.parse(stopFrame.result)).toMatchObject({
    ok: true,
    snapshot: { state: { state: "idle" } },
  });

  input.end();
  await gateway;
});
