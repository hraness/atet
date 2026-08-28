import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPTURE_HELPER_VERSION,
  CAPTURE_PROTOCOL_VERSION,
  encodeCaptureEvent,
  parseCaptureRequestLine,
  SegmentCompletionSchema,
  type CaptureEvent,
  type CaptureInterruption,
  type CaptureOptions,
  type CaptureRequest,
} from "../capture/protocol";
import { createNodeBundleFileSystem, loadRecordingManifest } from "../core";
import type { ProcessRunner, RunResult } from "./io";
import {
  CaptureHelperRecordingController,
  executeRecordingAction,
  parseRecordingSnapshot,
  readRepositoryRecordingState,
  type CaptureTransport,
  type CaptureTransportFactory,
  type RecordingController,
  type RecordingSnapshot,
  type RecordingStartOptions,
} from "./recording-controller";

const PERMISSIONS = {
  accessibility: "authorized",
  camera: "authorized",
  inputMonitoring: "authorized",
  microphone: "authorized",
  screenCapture: "authorized",
  systemAudio: "authorized",
  windowMetadata: "authorized",
} as const;

const PREFLIGHT_PERMISSIONS = {
  ...PERMISSIONS,
  camera: "not-determined",
  microphone: "not-determined",
} as const;

const SOURCES: Extract<CaptureEvent, { readonly event: "configured" }>["sources"] = {
  audio: [{ audioSourceId: "system-audio", channels: 2, kind: "system", label: "System", sampleRateHz: 48_000 }],
  cameras: [],
  displays: [{
    bounds: { height: 180, width: 320, x: 0, y: 0 },
    displayId: "display-primary",
    isPrimary: true,
    label: "Primary",
    pixelSize: { height: 180, width: 320 },
    refreshRateHz: 30,
    scaleFactor: 1,
  }],
};

const REPLACEMENT_SOURCES: Extract<
  CaptureEvent,
  { readonly event: "segment-started" }
>["sources"] = {
  audio: SOURCES.audio,
  cameras: SOURCES.cameras,
  displays: [{
    bounds: { height: 180, width: 320, x: 320, y: 0 },
    displayId: "display-replacement",
    isPrimary: true,
    label: "Replacement",
    pixelSize: { height: 180, width: 320 },
    refreshRateHz: 30,
    scaleFactor: 1,
  }],
};

const AVAILABLE_SOURCES: Extract<
  CaptureEvent,
  { readonly event: "configured" }
>["availableSources"] = {
  ...SOURCES,
  cameras: [{
    cameraId: "camera-available",
    frameRate: 30,
    label: "Available camera",
    pixelSize: { height: 720, width: 1_280 },
    position: "external",
  }],
};

const FRESH_AVAILABLE_SOURCES: Extract<
  CaptureEvent,
  { readonly event: "status" }
>["availableSources"] = {
  ...AVAILABLE_SOURCES,
  audio: [
    ...AVAILABLE_SOURCES.audio,
    {
      audioSourceId: "microphone-fresh",
      channels: 1,
      kind: "microphone",
      label: "Fresh microphone",
      sampleRateHz: 48_000,
    },
  ],
};

class ProbeRunner implements ProcessRunner {
  readonly #systemAudioDurationUs: number;

  constructor(systemAudioDurationUs = 1_000_000) {
    this.#systemAudioDurationUs = systemAudioDurationUs;
  }

  run(): Promise<RunResult> {
    return Promise.resolve({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({ streams: [
        {
          codec_name: "h264",
          codec_type: "video",
          duration: "1.000000",
          id: "0x1",
          index: 0,
          start_time: "0.000000",
          time_base: "1/1000000",
        },
        {
          codec_name: "aac",
          codec_type: "audio",
          duration: (this.#systemAudioDurationUs / 1_000_000).toFixed(6),
          id: "0x2",
          index: 1,
          start_time: "0.000000",
          time_base: "1/1000000",
        },
      ] }),
    });
  }
}

function streamTiming(nativeStartUs: number, durationUs: number, maximumSampleDurationUs: number) {
  const firstPtsUs = 5_000_000;
  const endPtsUs = firstPtsUs + durationUs;
  return {
    bufferCount: 30,
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
    sampleCount: 30,
  };
}

class FaultOnceProbeRunner extends ProbeRunner {
  #failed = false;

  override run(): Promise<RunResult> {
    if (!this.#failed) {
      this.#failed = true;
      return Promise.reject(new Error("injected capture verification failure"));
    }
    return super.run();
  }
}

type ProtocolScenario =
  | "pause-interruption"
  | "pause-finalization"
  | "pause-selected-source-drift"
  | "pause-session-before-segment"
  | "resume-completion-before-status"
  | "resume-after-auto-close"
  | "resume-after-auto-close-fatal"
  | "resume-after-auto-close-fatal-interruption"
  | "resume-after-auto-close-source-replacement"
  | "resume-after-auto-close-start-failure"
  | "resume-start-failure"
  | "resume-prepared-interruption"
  | "resume-wrong-start-frontier"
  | "start-wrong-frontier"
  | "shutdown-completion-without-session"
  | "shutdown-finalizes"
  | "shutdown-repeats-session"
  | "status-auto-pause"
  | "status-auto-pause-wrong-frontier"
  | "status-auto-stop-complete"
  | "status-completion-before-error"
  | "status-incomplete-stop"
  | "status-recording-invented-count"
  | "status-recording-monotonic"
  | "status-recording-time-regression"
  | "status-recording"
  | "status-ready"
  | "status-selected-source-drift"
  | "status-shutting-down"
  | "status-unconfigured"
  | "status-available-sources"
  | "status-repeats-session"
  | "status-resurrects-after-stop"
  | "status-session-before-paused"
  | "stop-invented-session-frontier"
  | "stream-duration-drift"
  | "stream-onset-skew"
  | "start-source-replacement"
  | undefined;

type ProtocolHelperState =
  | "paused"
  | "ready"
  | "recording"
  | "shutting-down"
  | "stopped"
  | "unconfigured";

class ProtocolTransport implements CaptureTransport {
  readonly #lines: string[] = [encodeCaptureEvent({
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
    event: "ready",
    helperVersion: CAPTURE_HELPER_VERSION,
    protocolVersion: CAPTURE_PROTOCOL_VERSION,
  })];
  #closed = false;
  #completedSegmentCount = 0;
  readonly #scenario: ProtocolScenario;
  #scenarioConsumed = false;
  #statusCallCount = 0;
  #state: ProtocolHelperState = "unconfigured";
  #lastInterruption: CaptureInterruption | null = null;
  #activeSegmentIndex: number | undefined;
  #nextSegmentIndex = 0;
  #options: CaptureOptions | undefined;
  #selectedSources = SOURCES;
  #sessionDirectory: string | undefined;
  readonly requests: CaptureRequest[] = [];

  constructor(scenario?: ProtocolScenario) {
    this.#scenario = scenario;
  }

  #error(
    request: CaptureRequest,
    code: string,
    message: string,
    recoverable: boolean,
    interruption: CaptureInterruption | null = null,
  ): void {
    this.#lines.push(encodeCaptureEvent({
      code,
      event: "error",
      interruption,
      message,
      protocolVersion: CAPTURE_PROTOCOL_VERSION,
      recoverable,
      requestId: request.requestId,
      state: this.#state,
    }));
  }

  #sessionCompleted(request: CaptureRequest) {
    return encodeCaptureEvent({
      durationUs: this.#completedSegmentCount * 1_000_000,
      event: "session-completed",
      protocolVersion: CAPTURE_PROTOCOL_VERSION,
      requestId: request.requestId,
      segmentCount: this.#completedSegmentCount,
      state: "stopped",
    });
  }

  #status(request: CaptureRequest, state: ProtocolHelperState) {
    return encodeCaptureEvent({
      activeSegmentIndex: this.#activeSegmentIndex ?? null,
      availableSources: this.#scenario === "status-available-sources"
        ? FRESH_AVAILABLE_SOURCES
        : AVAILABLE_SOURCES,
      completedSegmentCount: this.#completedSegmentCount,
      event: "status",
      lastInterruption: this.#lastInterruption,
      logicalTimeUs: this.#completedSegmentCount * 1_000_000,
      permissions: PERMISSIONS,
      protocolVersion: CAPTURE_PROTOCOL_VERSION,
      requestId: request.requestId,
      sources: this.#scenario === "status-selected-source-drift"
        ? AVAILABLE_SOURCES
        : this.#selectedSources,
      state,
    });
  }

  async #segment(
    index: number,
    sources = this.#selectedSources,
  ): Promise<Extract<CaptureEvent, { readonly event: "segment-completed" }>["segment"]> {
    const sessionDirectory = this.#sessionDirectory;
    if (sessionDirectory === undefined) throw new Error("Session directory is unavailable.");
    const primaryDisplay = sources.displays.find(({ isPrimary }) => isPrimary);
    if (primaryDisplay === undefined) throw new Error("Selected sources have no primary display.");
    const startUs = index * 1_000_000;
    const nativeStartUs = 10_000_000 + index * 2_000_000;
    const systemAudioDurationUs = this.#scenario === "stream-duration-drift" ? 900_000 : 1_000_000;
    const systemAudioNativeStartUs = nativeStartUs
      + (this.#scenario === "stream-onset-skew" ? 100_000 : 0);
    const path = `segments/${index}/display.mp4`;
    const absolute = join(sessionDirectory, path);
    await mkdir(join(sessionDirectory, `segments/${index}`), { mode: 0o700, recursive: true });
    await writeFile(absolute, `segment-${index}`, { mode: 0o600 });
    return SegmentCompletionSchema.parse({
      camera: { availability: "unavailable", reason: "disabled" },
      clock: {
        end: { nativeTimeUs: nativeStartUs + 1_000_000, sourceTimeUs: startUs + 1_000_000 },
        kind: "mach-continuous-microseconds",
        start: { nativeTimeUs: nativeStartUs, sourceTimeUs: startUs },
      },
      diagnostics: [],
      displays: [{
        containerDurationUs: 1_000_000,
        container: "mp4",
        display: {
          bounds: primaryDisplay.bounds,
          displayId: primaryDisplay.displayId,
          isPrimary: true,
          pixelHeight: primaryDisplay.pixelSize.height,
          pixelWidth: primaryDisplay.pixelSize.width,
          scaleFactor: primaryDisplay.scaleFactor,
        },
        path,
        streams: [
          {
            codec: "h264",
            mapping: "exact",
            role: "display-video",
            streamIndex: 7,
            timing: streamTiming(nativeStartUs, 1_000_000, 33_334),
            trackId: 1,
          },
          {
            channels: 2,
            codec: "aac",
            mapping: "exact",
            role: "system-audio",
            sampleRateHz: 48_000,
            streamIndex: 8,
            timing: streamTiming(systemAudioNativeStartUs, systemAudioDurationUs, 21_334),
            trackId: 2,
          },
        ],
      }],
      index,
      metadata: [],
      microphone: { availability: "unavailable", reason: "disabled" },
      sources,
    });
  }

  async write(value: string): Promise<void> {
    const request = parseCaptureRequestLine(value.trimEnd());
    this.requests.push(request);
    switch (request.command) {
      case "configure": {
        this.#options = request.options ?? (() => { throw new Error("Missing test capture options."); })();
        this.#sessionDirectory = request.sessionDirectory;
        this.#activeSegmentIndex = undefined;
        this.#completedSegmentCount = 0;
        this.#lastInterruption = null;
        this.#nextSegmentIndex = 0;
        this.#selectedSources = SOURCES;
        this.#state = "ready";
        this.#lines.push(encodeCaptureEvent({
          availableSources: AVAILABLE_SOURCES,
          event: "configured",
          lastInterruption: null,
          options: this.#options,
          permissions: PREFLIGHT_PERMISSIONS,
          protocolVersion: CAPTURE_PROTOCOL_VERSION,
          requestId: request.requestId,
          sources: SOURCES,
          state: "ready",
        }));
        return;
      }
      case "start": {
        if (this.#state !== "ready") {
          this.#error(request, "invalid-state", `Cannot start while helper state is ${this.#state}.`, true);
          return;
        }
        const index = this.#nextSegmentIndex;
        this.#nextSegmentIndex += 1;
        this.#activeSegmentIndex = index;
        this.#state = "recording";
        const selectedSources = this.#scenario === "start-source-replacement"
          ? REPLACEMENT_SOURCES
          : this.#selectedSources;
        this.#selectedSources = selectedSources;
        this.#lines.push(encodeCaptureEvent({
          event: "segment-started",
          index,
          nativeStartUs: 10_000_000 + index * 2_000_000,
          permissions: PERMISSIONS,
          protocolVersion: CAPTURE_PROTOCOL_VERSION,
          requestId: request.requestId,
          sources: selectedSources,
          startUs: (
            this.#completedSegmentCount
            + (this.#scenario === "start-wrong-frontier" ? 1 : 0)
          ) * 1_000_000,
        }));
        return;
      }
      case "resume": {
        if (
          !this.#scenarioConsumed
          && this.#scenario === "resume-prepared-interruption"
        ) {
          this.#scenarioConsumed = true;
          this.#state = "stopped";
          const interruption = {
            code: "camera-runtime-error",
            nativeTimeUs: 12_000_000,
            recoverable: false,
            segmentIndex: this.#nextSegmentIndex,
            source: "camera",
            sourceId: "camera-available",
            sourceTimeUs: this.#completedSegmentCount * 1_000_000,
          } as const;
          this.#lastInterruption = interruption;
          this.#error(
            request,
            "camera-runtime-error",
            "The selected camera was interrupted during prepared start.",
            false,
            interruption,
          );
          return;
        }
        if (
          !this.#scenarioConsumed
          && (
            this.#scenario === "resume-after-auto-close"
            || this.#scenario === "resume-after-auto-close-fatal"
            || this.#scenario === "resume-after-auto-close-fatal-interruption"
            || this.#scenario === "resume-after-auto-close-source-replacement"
            || this.#scenario === "resume-after-auto-close-start-failure"
          )
        ) {
          const completedIndex = this.#activeSegmentIndex ?? 0;
          this.#activeSegmentIndex = undefined;
          this.#completedSegmentCount += 1;
          this.#state = "paused";
          const completedSegment = await this.#segment(completedIndex);
          const interruption = this.#scenario
            === "resume-after-auto-close-fatal-interruption"
            ? {
                code: "screen-stream-stopped",
                nativeTimeUs: completedSegment.clock.end.nativeTimeUs,
                recoverable: true,
                segmentIndex: completedIndex,
                source: "screen",
                sourceId: "display-primary",
                sourceTimeUs: completedSegment.clock.end.sourceTimeUs,
              } as const
            : null;
          if (interruption !== null) this.#lastInterruption = interruption;
          this.#lines.push(encodeCaptureEvent({
            event: "segment-completed",
            interruption,
            protocolVersion: CAPTURE_PROTOCOL_VERSION,
            requestId: request.requestId,
            segment: completedSegment,
          }));
          if (
            this.#scenario === "resume-after-auto-close"
            || this.#scenario === "resume-after-auto-close-source-replacement"
          ) {
            this.#scenarioConsumed = true;
          }
        }
        if (
          !this.#scenarioConsumed
          && (
            this.#scenario === "resume-after-auto-close-fatal"
            || this.#scenario === "resume-after-auto-close-fatal-interruption"
            || this.#scenario === "resume-after-auto-close-start-failure"
          )
        ) {
          this.#scenarioConsumed = true;
          const interruption = this.#scenario
            === "resume-after-auto-close-fatal-interruption"
            ? {
                code: "camera-runtime-error",
                nativeTimeUs: 12_000_000,
                recoverable: false,
                segmentIndex: this.#nextSegmentIndex,
                source: "camera",
                sourceId: "camera-available",
                sourceTimeUs: this.#completedSegmentCount * 1_000_000,
              } as const
            : null;
          if (interruption !== null) this.#lastInterruption = interruption;
          this.#error(
            request,
            this.#scenario === "resume-after-auto-close-fatal"
              || this.#scenario === "resume-after-auto-close-fatal-interruption"
              ? "camera-runtime-error"
              : "camera-start-failed",
            "The selected camera could not start.",
            this.#scenario !== "resume-after-auto-close-fatal"
              && this.#scenario !== "resume-after-auto-close-fatal-interruption",
            interruption,
          );
          return;
        }
        if (this.#scenario === "resume-completion-before-status") {
          this.#lines.push(
            encodeCaptureEvent({
              event: "segment-completed",
              interruption: null,
              protocolVersion: CAPTURE_PROTOCOL_VERSION,
              requestId: request.requestId,
              segment: await this.#segment(this.#activeSegmentIndex ?? 0),
            }),
            this.#status(request, "paused"),
          );
          return;
        }
        if (!this.#scenarioConsumed && this.#scenario === "resume-start-failure") {
          this.#scenarioConsumed = true;
          this.#error(request, "screen-permission-denied", "Screen Recording permission was denied.", true);
          return;
        }
        if (this.#state !== "paused") {
          this.#error(request, "invalid-state", `Cannot resume while helper state is ${this.#state}.`, true);
          return;
        }
        const index = this.#nextSegmentIndex;
        this.#nextSegmentIndex += 1;
        this.#activeSegmentIndex = index;
        this.#state = "recording";
        const selectedSources = this.#scenario
          === "resume-after-auto-close-source-replacement"
          ? REPLACEMENT_SOURCES
          : this.#selectedSources;
        this.#selectedSources = selectedSources;
        this.#lines.push(encodeCaptureEvent({
          event: "segment-started",
          index,
          nativeStartUs: 10_000_000 + index * 2_000_000,
          permissions: PERMISSIONS,
          protocolVersion: CAPTURE_PROTOCOL_VERSION,
          requestId: request.requestId,
          sources: selectedSources,
          startUs: (
            this.#completedSegmentCount
            + (this.#scenario === "resume-wrong-start-frontier" ? 1 : 0)
          ) * 1_000_000,
        }));
        return;
      }
      case "pause": {
        if (this.#scenario === "pause-session-before-segment") {
          this.#lines.push(
            this.#sessionCompleted(request),
            encodeCaptureEvent({
              event: "segment-completed",
              interruption: null,
              protocolVersion: CAPTURE_PROTOCOL_VERSION,
              requestId: request.requestId,
              segment: await this.#segment(this.#activeSegmentIndex ?? 0),
            }),
          );
          return;
        }
        if (this.#scenario === "pause-finalization") {
          this.#state = "stopped";
          this.#lines.push(encodeCaptureEvent({
            code: "screen-finalization-failed",
            event: "error",
            interruption: null,
            message: "Display recording could not be finalized.",
            protocolVersion: CAPTURE_PROTOCOL_VERSION,
            recoverable: false,
            requestId: request.requestId,
            state: "stopped",
          }));
          return;
        }
        if (this.#state !== "recording" || this.#activeSegmentIndex === undefined) {
          this.#error(request, "invalid-state", `Cannot pause while helper state is ${this.#state}.`, true);
          return;
        }
        const index = this.#activeSegmentIndex;
        this.#activeSegmentIndex = undefined;
        this.#completedSegmentCount += 1;
        this.#state = "paused";
        const completed = await this.#segment(
          index,
          this.#scenario === "pause-selected-source-drift"
            ? REPLACEMENT_SOURCES
            : this.#selectedSources,
        );
        const interruption = this.#scenario === "pause-interruption"
          ? {
              code: "screen-stream-stopped",
              nativeTimeUs: completed.clock.end.nativeTimeUs,
              recoverable: true,
              segmentIndex: completed.index,
              source: "screen",
              sourceId: "display-primary",
              sourceTimeUs: completed.clock.end.sourceTimeUs,
            } as const
          : null;
        this.#lastInterruption = interruption;
        this.#lines.push(encodeCaptureEvent({
          event: "segment-completed",
          interruption,
          protocolVersion: CAPTURE_PROTOCOL_VERSION,
          requestId: request.requestId,
          segment: completed,
        }));
        return;
      }
      case "stop": {
        if (this.#state !== "ready" && this.#state !== "recording" && this.#state !== "paused") {
          this.#error(request, "invalid-state", `Cannot stop while helper state is ${this.#state}.`, true);
          return;
        }
        if (this.#state === "recording" && this.#activeSegmentIndex !== undefined) {
          const index = this.#activeSegmentIndex;
          this.#activeSegmentIndex = undefined;
          this.#completedSegmentCount += 1;
          this.#lines.push(encodeCaptureEvent({
            event: "segment-completed",
            interruption: null,
            protocolVersion: CAPTURE_PROTOCOL_VERSION,
            requestId: request.requestId,
            segment: await this.#segment(index),
          }));
        }
        this.#state = "stopped";
        if (this.#scenario === "stop-invented-session-frontier") {
          this.#lines.push(encodeCaptureEvent({
            durationUs: (this.#completedSegmentCount + 1) * 1_000_000,
            event: "session-completed",
            protocolVersion: CAPTURE_PROTOCOL_VERSION,
            requestId: request.requestId,
            segmentCount: this.#completedSegmentCount + 1,
            state: "stopped",
          }));
        } else {
          this.#lines.push(this.#sessionCompleted(request));
        }
        return;
      }
      case "shutdown": {
        if (this.#scenario === "shutdown-repeats-session" && this.#state === "stopped") {
          this.#lines.push(
            this.#sessionCompleted(request),
            encodeCaptureEvent({
              event: "shutdown",
              protocolVersion: CAPTURE_PROTOCOL_VERSION,
              requestId: request.requestId,
            }),
          );
          return;
        }
        if (this.#scenario === "shutdown-completion-without-session") {
          this.#lines.push(
            encodeCaptureEvent({
              event: "segment-completed",
              interruption: null,
              protocolVersion: CAPTURE_PROTOCOL_VERSION,
              requestId: request.requestId,
              segment: await this.#segment(this.#activeSegmentIndex ?? 0),
            }),
            encodeCaptureEvent({
              event: "shutdown",
              protocolVersion: CAPTURE_PROTOCOL_VERSION,
              requestId: request.requestId,
            }),
          );
          return;
        }
        if (this.#state === "recording" && this.#activeSegmentIndex !== undefined) {
          const index = this.#activeSegmentIndex;
          this.#activeSegmentIndex = undefined;
          this.#completedSegmentCount += 1;
          this.#lines.push(encodeCaptureEvent({
            event: "segment-completed",
            interruption: null,
            protocolVersion: CAPTURE_PROTOCOL_VERSION,
            requestId: request.requestId,
            segment: await this.#segment(index),
          }));
        }
        if (this.#state === "recording" || this.#state === "paused" || this.#state === "ready") {
          this.#state = "stopped";
          this.#lines.push(this.#sessionCompleted(request));
        }
        this.#lines.push(encodeCaptureEvent({
          event: "shutdown",
          protocolVersion: CAPTURE_PROTOCOL_VERSION,
          requestId: request.requestId,
        }));
        return;
      }
      case "snapshot":
        throw new Error(`Unexpected test request: ${request.command}`);
      case "status": {
        if (this.#scenario === "status-completion-before-error") {
          this.#lines.push(encodeCaptureEvent({
            event: "segment-completed",
            interruption: null,
            protocolVersion: CAPTURE_PROTOCOL_VERSION,
            requestId: request.requestId,
            segment: await this.#segment(this.#activeSegmentIndex ?? 0),
          }));
          this.#error(request, "screen-finalization-failed", "Injected failure after completion.", false);
          return;
        }
        if (this.#scenario === "status-session-before-paused") {
          this.#lines.push(
            this.#sessionCompleted(request),
            this.#status(request, "paused"),
          );
          return;
        }
        if (this.#scenario === "status-resurrects-after-stop" && this.#state === "stopped") {
          this.#lines.push(this.#status(request, "paused"));
          return;
        }
        if (this.#scenario === "status-repeats-session" && this.#state === "stopped") {
          this.#lines.push(
            this.#sessionCompleted(request),
            this.#status(request, "stopped"),
          );
          return;
        }
        if (
          this.#scenario === "status-recording-invented-count"
          || this.#scenario === "status-recording-monotonic"
          || this.#scenario === "status-recording-time-regression"
        ) {
          this.#statusCallCount += 1;
          let logicalTimeUs = 0;
          if (this.#scenario === "status-recording-monotonic") {
            logicalTimeUs = this.#statusCallCount * 250_000;
          } else if (this.#scenario === "status-recording-time-regression") {
            logicalTimeUs = this.#statusCallCount === 1 ? 500_000 : 250_000;
          }
          this.#lines.push(encodeCaptureEvent({
            activeSegmentIndex: this.#activeSegmentIndex ?? null,
            availableSources: SOURCES,
            completedSegmentCount: this.#completedSegmentCount
              + (this.#scenario === "status-recording-invented-count" ? 1 : 0),
            event: "status",
            lastInterruption: null,
            logicalTimeUs,
            permissions: PERMISSIONS,
            protocolVersion: CAPTURE_PROTOCOL_VERSION,
            requestId: request.requestId,
            sources: SOURCES,
            state: "recording",
          }));
          return;
        }
        if (this.#scenario === "status-recording") {
          this.#lines.push(this.#status(request, "recording"));
          return;
        }
        if (
          this.#scenario === "status-ready"
          || this.#scenario === "status-shutting-down"
          || this.#scenario === "status-unconfigured"
        ) {
          const state = this.#scenario === "status-ready"
            ? "ready"
            : this.#scenario === "status-shutting-down"
              ? "shutting-down"
              : "unconfigured";
          this.#lines.push(this.#status(request, state));
          return;
        }
        if (
          this.#scenario === "status-available-sources"
          || this.#scenario === "status-selected-source-drift"
        ) {
          this.#lines.push(this.#status(request, "recording"));
          return;
        }
        if (this.#scenario === undefined && this.#state === "stopped") {
          this.#lines.push(this.#status(request, "stopped"));
          return;
        }
        if (
          this.#scenario !== "status-auto-pause"
          && this.#scenario !== "status-auto-pause-wrong-frontier"
          && this.#scenario !== "status-auto-stop-complete"
          && this.#scenario !== "status-incomplete-stop"
        ) {
          throw new Error(`Unexpected test request: ${request.command}`);
        }
        const index = this.#activeSegmentIndex ?? 0;
        this.#activeSegmentIndex = undefined;
        this.#completedSegmentCount += 1;
        this.#lines.push(encodeCaptureEvent({
          event: "segment-completed",
          interruption: null,
          protocolVersion: CAPTURE_PROTOCOL_VERSION,
          requestId: request.requestId,
          segment: await this.#segment(index),
        }));
        if (
          this.#scenario === "status-auto-pause"
          || this.#scenario === "status-auto-pause-wrong-frontier"
        ) {
          this.#state = "paused";
          if (this.#scenario === "status-auto-pause-wrong-frontier") {
            this.#lines.push(encodeCaptureEvent({
              activeSegmentIndex: null,
              availableSources: SOURCES,
              completedSegmentCount: this.#completedSegmentCount + 1,
              event: "status",
              lastInterruption: null,
              logicalTimeUs: (this.#completedSegmentCount + 1) * 1_000_000,
              permissions: PERMISSIONS,
              protocolVersion: CAPTURE_PROTOCOL_VERSION,
              requestId: request.requestId,
              sources: SOURCES,
              state: "paused",
            }));
          } else {
            this.#lines.push(this.#status(request, "paused"));
          }
          return;
        }
        if (this.#scenario === "status-auto-stop-complete") {
          this.#state = "stopped";
          this.#lines.push(this.#sessionCompleted(request));
        }
        this.#lines.push(this.#status(request, "stopped"));
        return;
      }
    }
  }

  readLine(timeoutMs: number): Promise<string> {
    void timeoutMs;
    const line = this.#lines.shift();
    if (line === undefined) throw new Error("Fake helper has no queued response.");
    return Promise.resolve(line.trimEnd());
  }

  stderrTail(): string {
    return "";
  }

  close(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }

  get closed(): boolean {
    return this.#closed;
  }

  get configuredOptions(): CaptureOptions | undefined {
    return this.#options;
  }
}

class ProtocolTransportFactory implements CaptureTransportFactory {
  readonly transport: ProtocolTransport;

  constructor(scenario?: ProtocolScenario) {
    this.transport = new ProtocolTransport(scenario);
  }

  spawn(executable: string): Promise<CaptureTransport> {
    void executable;
    return Promise.resolve(this.transport);
  }
}

class ReusableProtocolTransportFactory implements CaptureTransportFactory {
  readonly transports: ProtocolTransport[] = [];

  spawn(executable: string): Promise<CaptureTransport> {
    void executable;
    const transport = new ProtocolTransport();
    this.transports.push(transport);
    return Promise.resolve(transport);
  }
}

const START_OPTIONS = {
  camera: { kind: "disabled" as const },
  displays: { kind: "all" as const },
  microphone: { kind: "disabled" as const },
  strictInputs: false,
  systemAudio: true,
  typedText: false,
};

const FIXTURE_FOCUS_IDENTITY = {
  fieldId: "atet-fixture-public-01234567-89ab-4cde-8fab-0123456789ab",
  processId: 42,
  windowId: "9001",
  windowTitle:
    "Atet Interaction Fixture · 01234567-89ab-4cde-8fab-0123456789ab",
} as const;

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function operationFailure(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected the recording operation to fail.");
}

async function completeFixtureRecording(controller: CaptureHelperRecordingController): Promise<void> {
  await controller.pause();
  await controller.resume();
  await controller.stop();
}

class ActionTrackingController implements RecordingController {
  readonly calls: string[] = [];
  #snapshot: RecordingSnapshot = {
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

  close(): Promise<void> {
    this.calls.push("close");
    return Promise.resolve();
  }

  pause(): Promise<RecordingSnapshot> {
    this.calls.push("pause");
    this.#snapshot = { ...this.#snapshot, state: "paused" };
    return Promise.resolve(this.#snapshot);
  }

  resume(): Promise<RecordingSnapshot> {
    this.calls.push("resume");
    this.#snapshot = { ...this.#snapshot, state: "recording" };
    return Promise.resolve(this.#snapshot);
  }

  start(options: RecordingStartOptions): Promise<RecordingSnapshot> {
    this.calls.push("start");
    this.#snapshot = {
      ...this.#snapshot,
      effectiveConfig: { ...options, metadata: true },
      recordingId: "rec_action_tracking",
      recordingRoot: "/tmp/rec_action_tracking",
      state: "recording",
    };
    return Promise.resolve(this.#snapshot);
  }

  status(): Promise<RecordingSnapshot> {
    this.calls.push("status");
    return Promise.resolve(this.#snapshot);
  }

  stop(): Promise<RecordingSnapshot> {
    this.calls.push("stop");
    this.#snapshot = {
      ...this.#snapshot,
      effectiveConfig: null,
      recordingId: null,
      recordingRoot: null,
      state: "idle",
    };
    return Promise.resolve(this.#snapshot);
  }
}

test("dispatches recording mutations without hidden status preflights", async () => {
  const controller = new ActionTrackingController();

  await executeRecordingAction(controller, "start", START_OPTIONS);
  await executeRecordingAction(controller, "pause");
  await executeRecordingAction(controller, "resume");
  await executeRecordingAction(controller, "stop");
  await executeRecordingAction(controller, "status");

  expect(controller.calls).toEqual(["start", "pause", "resume", "stop", "status"]);
});

test("rejects resume when no recording identity exists", async () => {
  const controller = new CaptureHelperRecordingController({
    artifactRoot: join(tmpdir(), "atet-controller-unused-artifacts"),
    executable: join(tmpdir(), "atet-controller-unused-helper"),
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
  });

  try {
    expect(await operationFailure(controller.resume())).toMatchObject({
      code: "conflict",
      message: "Cannot resume while recording is idle.",
    });
  } finally {
    await controller.close();
  }
});

test("rejects an initial segment that starts beyond the empty bundle frontier", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-start-frontier-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory("start-wrong-frontier");
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    runner: new ProbeRunner(),
    transportFactory: factory,
  });
  try {
    expect(await operationFailure(controller.start(START_OPTIONS))).toMatchObject({
      code: "invalid-data",
      details: {
        recovery: {
          terminalManifestState: "failed",
        },
      },
    });
    expect(factory.transport.closed).toBeTrue();
    expect(await exists(join(artifactRoot, ".active-recording.json"))).toBeFalse();
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});

test("accepts initial segment-started sources as the authoritative resolved selection", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-start-source-replacement-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory("start-source-replacement");
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    runner: new ProbeRunner(),
    transportFactory: factory,
  });
  try {
    const started = await controller.start(START_OPTIONS);
    expect(started).toMatchObject({
      sources: REPLACEMENT_SOURCES,
      state: "recording",
    });
    expect(await loadRecordingManifest(
      createNodeBundleFileSystem(started.recordingRoot!),
    )).toMatchObject({
      sources: REPLACEMENT_SOURCES,
      state: "recording",
    });
    await completeFixtureRecording(controller);
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});

test("drives one long-lived helper through start, pause, resume, stop, and strict manifest finalization", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory();
  const observedEvents: CaptureEvent["event"][] = [];
  let isolatedObserverFailures = 0;
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    onCaptureEvent: event => {
      observedEvents.push(event.event);
      if (event.event === "configured") {
        isolatedObserverFailures += 1;
        Reflect.set(event, "requestId", "observer-mutated");
        throw new Error("observer diagnostics failed");
      }
    },
    runner: new ProbeRunner(),
    transportFactory: factory,
  });
  try {
    const started = await controller.start(START_OPTIONS);
    expect(started).toMatchObject({
      availableSources: AVAILABLE_SOURCES,
      completedSegmentCount: 0,
      lastInterruption: null,
      permissions: PERMISSIONS,
      sources: SOURCES,
      state: "recording",
    });
    expect(started.recordingRoot).not.toBeNull();
    const recordingRoot = started.recordingRoot!;
    expect(await loadRecordingManifest(createNodeBundleFileSystem(recordingRoot))).toMatchObject({
      permissions: PERMISSIONS,
      sources: SOURCES,
      state: "recording",
    });

    expect(await controller.pause()).toMatchObject({ completedSegmentCount: 1, state: "paused" });
    expect((await loadRecordingManifest(createNodeBundleFileSystem(recordingRoot))).state).toBe("paused");
    expect(await controller.resume()).toMatchObject({ state: "recording" });
    expect(await controller.stop()).toMatchObject({ completedSegmentCount: 2, state: "idle" });

    const manifest = await loadRecordingManifest(createNodeBundleFileSystem(recordingRoot));
    expect(manifest).toMatchObject({
      state: "stopped",
      timeline: { durationUs: 2_000_000 },
      tool: { name: "atet", version: "3.1.2" },
    });
    expect(manifest.tracks.map(({ kind }) => kind).sort()).toEqual(["display-video", "system-audio"]);
    expect(manifest.tracks.every(({ segments }) => segments.length === 2)).toBeTrue();
    expect(manifest.tracks.flatMap(({ segments }) => segments).map(({ streamIndex }) => streamIndex))
      .toEqual([0, 0, 1, 1]);
    expect(observedEvents).toEqual([
      "ready",
      "configured",
      "segment-started",
      "segment-completed",
      "segment-started",
      "segment-completed",
      "session-completed",
    ]);
    expect(isolatedObserverFailures).toBe(1);
    let activeStateExists = true;
    try {
      await readFile(join(artifactRoot, ".active-recording.json"));
    } catch {
      activeStateExists = false;
    }
    expect(activeStateExists).toBeFalse();
    await controller.close();
    expect(factory.transport.closed).toBeTrue();
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("persists a completion interruption before exposing the paused snapshot", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-completion-interruption-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory("pause-interruption");
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    runner: new ProbeRunner(),
    transportFactory: factory,
  });
  try {
    const started = await controller.start(START_OPTIONS);
    const paused = await controller.pause();
    const interruption = {
      code: "screen-stream-stopped",
      nativeTimeUs: 11_000_000,
      recoverable: true,
      segmentIndex: 0,
      source: "screen",
      sourceId: "display-primary",
      sourceTimeUs: 1_000_000,
    } as const;
    expect(paused).toMatchObject({
      lastInterruption: interruption,
      state: "paused",
    });
    expect(await readRepositoryRecordingState(artifactRoot)).toMatchObject({
      lastInterruption: interruption,
    });
    const manifest = await loadRecordingManifest(
      createNodeBundleFileSystem(started.recordingRoot!),
    );
    expect(manifest).toMatchObject({
      interruptions: [interruption],
      state: "paused",
    });
    expect(manifest.diagnostics.some((diagnostic) => (
      diagnostic.code === "capture-interruption-screen-stream-stopped"
      && diagnostic.count === 1
    ))).toBeTrue();
    const resumed = await controller.resume();
    expect(resumed).toMatchObject({
      lastInterruption: interruption,
      state: "recording",
    });
    expect(await readRepositoryRecordingState(artifactRoot)).toMatchObject({
      lastInterruption: interruption,
      state: "recording",
    });
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});

test("preserves an interrupted helper completion when media verification rejects the segment", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-rejected-interruption-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory("pause-interruption");
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    runner: new FaultOnceProbeRunner(),
    transportFactory: factory,
  });
  const interruption = {
    code: "screen-stream-stopped",
    nativeTimeUs: 11_000_000,
    recoverable: true,
    segmentIndex: 0,
    source: "screen",
    sourceId: "display-primary",
    sourceTimeUs: 1_000_000,
  } as const;
  try {
    const started = await controller.start(START_OPTIONS);
    const failure = await operationFailure(controller.pause());
    expect(failure).toMatchObject({
      code: "internal",
      details: {
        recovery: {
          controllerReusable: true,
          recordingId: started.recordingId,
          recordingRoot: started.recordingRoot,
          snapshot: {
            lastInterruption: interruption,
            logicalTimeUs: 1_000_000,
            sources: SOURCES,
          },
          terminalManifestState: "failed",
        },
      },
    });
    expect(failure.message).toContain("injected capture verification failure");

    const manifest = await loadRecordingManifest(
      createNodeBundleFileSystem(started.recordingRoot!),
    );
    expect(manifest).toMatchObject({
      eventStreams: [],
      interruptions: [interruption],
      state: "failed",
      timeline: {
        durationUs: 1_000_000,
        nativeClock: {
          segments: [{
            index: 0,
            nativeRange: { endUs: 11_000_000, startUs: 10_000_000 },
            sourceRange: { endUs: 1_000_000, startUs: 0 },
          }],
        },
      },
      tracks: [],
    });
    expect(manifest.diagnostics.filter(({ code }) =>
      code === "capture-segment-publication-failed"
    )).toHaveLength(1);
    expect(manifest.diagnostics.filter(({ code }) =>
      code === "capture-interruption-screen-stream-stopped"
    )).toHaveLength(1);
    expect(factory.transport.closed).toBeTrue();
    expect(await exists(join(artifactRoot, ".active-recording.json"))).toBeFalse();
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});

test("persists both deferred completion and prepared-start interruptions when verification fails", async () => {
  const temporary = await mkdtemp(join(
    tmpdir(),
    "atet-controller-rejected-deferred-interruptions-test-",
  ));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory(
    "resume-after-auto-close-fatal-interruption",
  );
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    runner: new FaultOnceProbeRunner(),
    transportFactory: factory,
  });
  const completionInterruption = {
    code: "screen-stream-stopped",
    nativeTimeUs: 11_000_000,
    recoverable: true,
    segmentIndex: 0,
    source: "screen",
    sourceId: "display-primary",
    sourceTimeUs: 1_000_000,
  } as const;
  const preparedStartInterruption = {
    code: "camera-runtime-error",
    nativeTimeUs: 12_000_000,
    recoverable: false,
    segmentIndex: 1,
    source: "camera",
    sourceId: "camera-available",
    sourceTimeUs: 1_000_000,
  } as const;
  try {
    const started = await controller.start(START_OPTIONS);
    const failure = await operationFailure(controller.resume());
    expect(failure).toMatchObject({
      details: {
        recovery: {
          controllerReusable: true,
          snapshot: {
            lastInterruption: preparedStartInterruption,
            logicalTimeUs: 1_000_000,
          },
          terminalManifestState: "failed",
        },
      },
    });
    expect(failure.message).toContain("injected capture verification failure");

    const manifest = await loadRecordingManifest(
      createNodeBundleFileSystem(started.recordingRoot!),
    );
    expect(manifest).toMatchObject({
      eventStreams: [],
      interruptions: [
        completionInterruption,
        preparedStartInterruption,
      ],
      state: "failed",
      timeline: {
        durationUs: 1_000_000,
        nativeClock: {
          segments: [{
            index: 0,
            nativeRange: { endUs: 11_000_000, startUs: 10_000_000 },
            sourceRange: { endUs: 1_000_000, startUs: 0 },
          }],
        },
      },
      tracks: [],
    });
    expect(manifest.diagnostics.filter(({ code }) =>
      code === "capture-segment-publication-failed"
    )).toHaveLength(1);
    expect(manifest.diagnostics.filter(({ code }) =>
      code.startsWith("capture-interruption-")
    )).toHaveLength(2);
    expect(factory.transport.closed).toBeTrue();
    expect(await exists(join(artifactRoot, ".active-recording.json"))).toBeFalse();
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});

test("records prepared-start interruption evidence before fatal resume settlement", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-prepared-interruption-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory("resume-prepared-interruption");
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    runner: new ProbeRunner(),
    transportFactory: factory,
  });
  try {
    const started = await controller.start(START_OPTIONS);
    await controller.pause();
    const failure = await operationFailure(controller.resume());
    expect(failure).toMatchObject({
      code: "subprocess",
      details: {
        helperCode: "camera-runtime-error",
        recovery: {
          recordingId: started.recordingId,
          recordingRoot: started.recordingRoot,
          snapshot: {
            lastInterruption: {
              code: "camera-runtime-error",
              sourceId: "camera-available",
              sourceTimeUs: 1_000_000,
            },
            logicalTimeUs: 1_000_000,
            sources: SOURCES,
          },
          terminalManifestState: "failed",
        },
      },
    });
    const manifest = await loadRecordingManifest(
      createNodeBundleFileSystem(started.recordingRoot!),
    );
    expect(manifest).toMatchObject({
      interruptions: [{
        code: "camera-runtime-error",
        nativeTimeUs: 12_000_000,
        recoverable: false,
        segmentIndex: 1,
        source: "camera",
        sourceId: "camera-available",
        sourceTimeUs: 1_000_000,
      }],
      state: "failed",
      timeline: { durationUs: 1_000_000 },
    });
    expect(factory.transport.closed).toBeTrue();
    expect(await exists(join(artifactRoot, ".active-recording.json"))).toBeFalse();
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});

test("rejects a genuine duplicate resume without settling or closing the active session", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-duplicate-resume-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory();
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    runner: new ProbeRunner(),
    transportFactory: factory,
  });
  try {
    const started = await controller.start(START_OPTIONS);
    expect(await operationFailure(controller.resume())).toMatchObject({
      code: "conflict",
      details: {
        helperCode: "invalid-state",
        recoverable: true,
        state: "recording",
      },
    });

    expect(factory.transport.closed).toBeFalse();
    expect(await readRepositoryRecordingState(artifactRoot)).toMatchObject({
      completedSegmentCount: 0,
      logicalTimeUs: 0,
      recordingId: started.recordingId,
      state: "recording",
    });
    expect(await loadRecordingManifest(createNodeBundleFileSystem(started.recordingRoot!))).toMatchObject({
      state: "recording",
      timeline: { durationUs: 0 },
      tracks: [],
    });

    await completeFixtureRecording(controller);
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});

test("persists deferred completion and remains resumable after a recoverable source-start failure", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-deferred-resume-failure-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory("resume-after-auto-close-start-failure");
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    runner: new ProbeRunner(),
    transportFactory: factory,
  });
  try {
    const started = await controller.start(START_OPTIONS);
    expect(await operationFailure(controller.resume())).toMatchObject({
      code: "unavailable",
      details: {
        helperCode: "camera-start-failed",
        recoverable: true,
        state: "paused",
      },
    });

    expect(factory.transport.closed).toBeFalse();
    expect(await readRepositoryRecordingState(artifactRoot)).toMatchObject({
      completedSegmentCount: 1,
      logicalTimeUs: 1_000_000,
      recordingId: started.recordingId,
      state: "paused",
    });
    const pausedManifest = await loadRecordingManifest(createNodeBundleFileSystem(started.recordingRoot!));
    expect(pausedManifest).toMatchObject({
      state: "paused",
      timeline: { durationUs: 1_000_000 },
    });
    expect(pausedManifest.tracks).toHaveLength(2);
    expect(pausedManifest.tracks.every(({ segments }) => segments.length === 1)).toBeTrue();

    await controller.resume();
    await controller.stop();
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});

test("keeps an already-paused session alive after a first-event recoverable resume failure", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-direct-resume-failure-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory("resume-start-failure");
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    runner: new ProbeRunner(),
    transportFactory: factory,
  });
  try {
    const started = await controller.start(START_OPTIONS);
    await controller.pause();
    expect(await operationFailure(controller.resume())).toMatchObject({
      code: "unavailable",
      details: {
        helperCode: "screen-permission-denied",
        recoverable: true,
        state: "paused",
      },
    });

    expect(factory.transport.closed).toBeFalse();
    expect(await readRepositoryRecordingState(artifactRoot)).toMatchObject({
      completedSegmentCount: 1,
      logicalTimeUs: 1_000_000,
      recordingId: started.recordingId,
      state: "paused",
    });
    expect(await loadRecordingManifest(createNodeBundleFileSystem(started.recordingRoot!))).toMatchObject({
      state: "paused",
      timeline: { durationUs: 1_000_000 },
    });

    await controller.resume();
    await controller.stop();
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});

test("persists valid deferred completion but settles a nonrecoverable resume failure", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-fatal-resume-failure-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory("resume-after-auto-close-fatal");
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    runner: new ProbeRunner(),
    transportFactory: factory,
  });
  try {
    const started = await controller.start(START_OPTIONS);
    expect(await operationFailure(controller.resume())).toMatchObject({
      code: "subprocess",
      details: {
        helperCode: "camera-runtime-error",
        recoverable: false,
      },
    });
    const failedManifest = await loadRecordingManifest(createNodeBundleFileSystem(started.recordingRoot!));
    expect(failedManifest).toMatchObject({
      state: "failed",
      timeline: { durationUs: 1_000_000 },
    });
    expect(failedManifest.tracks).toHaveLength(2);
    expect(failedManifest.tracks.every(({ segments }) => segments.length === 1)).toBeTrue();
    expect(factory.transport.closed).toBeTrue();
    expect(await exists(join(artifactRoot, ".active-recording.json"))).toBeFalse();
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});

test("reconciles an auto-closed segment before resuming on the same request", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-auto-resume-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory("resume-after-auto-close");
  const observedEvents: CaptureEvent["event"][] = [];
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    onCaptureEvent: event => observedEvents.push(event.event),
    runner: new ProbeRunner(),
    transportFactory: factory,
  });
  try {
    const started = await controller.start(START_OPTIONS);
    const resumed = await executeRecordingAction(controller, "resume");

    expect(resumed).toMatchObject({
      completedSegmentCount: 1,
      logicalTimeUs: 1_000_000,
      recordingId: started.recordingId,
      state: "recording",
    });
    expect(factory.transport.requests.map(({ command }) => command)).toEqual([
      "configure",
      "start",
      "resume",
    ]);
    expect(observedEvents.slice(-2)).toEqual(["segment-completed", "segment-started"]);
    expect(await loadRecordingManifest(createNodeBundleFileSystem(started.recordingRoot!))).toMatchObject({
      state: "recording",
      timeline: { durationUs: 1_000_000 },
    });

    await controller.stop();
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});

test("atomically advances from an old completion to replacement segment-started sources", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-resume-source-replacement-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory(
    "resume-after-auto-close-source-replacement",
  );
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    runner: new ProbeRunner(),
    transportFactory: factory,
  });
  try {
    const started = await controller.start(START_OPTIONS);
    const resumed = await controller.resume();

    expect(resumed).toMatchObject({
      completedSegmentCount: 1,
      logicalTimeUs: 1_000_000,
      sources: REPLACEMENT_SOURCES,
      state: "recording",
    });
    expect(await readRepositoryRecordingState(artifactRoot)).toMatchObject({
      sources: REPLACEMENT_SOURCES,
      state: "recording",
    });
    const manifest = await loadRecordingManifest(
      createNodeBundleFileSystem(started.recordingRoot!),
    );
    if (manifest.schemaVersion !== 3) {
      throw new Error("Expected a recording manifest v3 fixture.");
    }
    expect(manifest.timeline.nativeClock.segments).toHaveLength(1);
    expect(manifest.sources.displays.map(({ displayId }) => displayId).sort())
      .toEqual(["display-primary", "display-replacement"]);

    await controller.stop();
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});

test("persists an auto-closed paused segment before publishing status", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-auto-status-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory("status-auto-pause");
  const observedEvents: CaptureEvent["event"][] = [];
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    onCaptureEvent: event => observedEvents.push(event.event),
    runner: new ProbeRunner(),
    transportFactory: factory,
  });
  try {
    const started = await controller.start(START_OPTIONS);
    const status = await controller.status();

    expect(status).toMatchObject({
      completedSegmentCount: 1,
      logicalTimeUs: 1_000_000,
      recordingId: started.recordingId,
      state: "paused",
    });
    expect(observedEvents.slice(-2)).toEqual(["segment-completed", "status"]);
    expect(await loadRecordingManifest(createNodeBundleFileSystem(started.recordingRoot!))).toMatchObject({
      state: "paused",
      timeline: { durationUs: 1_000_000 },
    });
    expect(await readRepositoryRecordingState(artifactRoot)).toMatchObject({
      completedSegmentCount: 1,
      logicalTimeUs: 1_000_000,
      state: "paused",
    });

    await controller.resume();
    await controller.stop();
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});

test("persists stopped status only after same-request session completion", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-auto-stop-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory("status-auto-stop-complete");
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    runner: new ProbeRunner(),
    transportFactory: factory,
  });
  try {
    const started = await controller.start(START_OPTIONS);
    expect(await controller.status()).toMatchObject({
      completedSegmentCount: 1,
      logicalTimeUs: 1_000_000,
      recordingId: null,
      state: "idle",
    });
    expect(await loadRecordingManifest(createNodeBundleFileSystem(started.recordingRoot!))).toMatchObject({
      state: "stopped",
      timeline: { durationUs: 1_000_000 },
    });

    await controller.close();
    expect(factory.transport.requests.map(({ command }) => command)).toEqual([
      "configure",
      "start",
      "status",
      "shutdown",
    ]);
    expect(await exists(join(artifactRoot, ".active-recording.json"))).toBeFalse();
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});

test("accepts stopped status after an earlier command proved session completion", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-proven-stop-status-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory();
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    runner: new ProbeRunner(),
    transportFactory: factory,
  });
  try {
    const started = await controller.start(START_OPTIONS);
    await controller.stop();
    expect(await controller.status()).toMatchObject({
      completedSegmentCount: 1,
      logicalTimeUs: 1_000_000,
      recordingId: null,
      state: "idle",
    });
    expect(await loadRecordingManifest(createNodeBundleFileSystem(started.recordingRoot!))).toMatchObject({
      state: "stopped",
      timeline: { durationUs: 1_000_000 },
    });
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});

test("advances live recording status monotonically without inventing completed segments", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-monotonic-status-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory("status-recording-monotonic");
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    runner: new ProbeRunner(),
    transportFactory: factory,
  });
  try {
    const started = await controller.start(START_OPTIONS);
    expect(await controller.status()).toMatchObject({
      completedSegmentCount: 0,
      logicalTimeUs: 250_000,
      recordingId: started.recordingId,
      state: "recording",
    });
    expect(await controller.status()).toMatchObject({
      completedSegmentCount: 0,
      logicalTimeUs: 500_000,
      recordingId: started.recordingId,
      state: "recording",
    });
    expect(await readRepositoryRecordingState(artifactRoot)).toMatchObject({
      completedSegmentCount: 0,
      logicalTimeUs: 500_000,
      state: "recording",
    });

    await completeFixtureRecording(controller);
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});

test("rejects recording status with an invented completed-segment count", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-status-count-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory("status-recording-invented-count");
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    runner: new ProbeRunner(),
    transportFactory: factory,
  });
  try {
    const started = await controller.start(START_OPTIONS);
    expect(await operationFailure(controller.status())).toMatchObject({
      code: "invalid-data",
      details: {
        recovery: {
          recordingId: started.recordingId,
          terminalManifestState: "failed",
        },
      },
    });
    expect(await loadRecordingManifest(createNodeBundleFileSystem(started.recordingRoot!))).toMatchObject({
      state: "failed",
      timeline: { durationUs: 0 },
      tracks: [],
    });
    expect(factory.transport.closed).toBeTrue();
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});

test("rejects recording status that regresses the prior live logical time", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-status-time-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory("status-recording-time-regression");
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    runner: new ProbeRunner(),
    transportFactory: factory,
  });
  try {
    const started = await controller.start(START_OPTIONS);
    expect(await controller.status()).toMatchObject({
      completedSegmentCount: 0,
      logicalTimeUs: 500_000,
      state: "recording",
    });
    expect(await operationFailure(controller.status())).toMatchObject({
      code: "invalid-data",
      details: {
        recovery: {
          recordingId: started.recordingId,
          terminalManifestState: "failed",
        },
      },
    });
    expect(await loadRecordingManifest(createNodeBundleFileSystem(started.recordingRoot!))).toMatchObject({
      state: "failed",
      timeline: { durationUs: 0 },
      tracks: [],
    });
    expect(factory.transport.closed).toBeTrue();
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});

test("keeps a normal recording status recording without changing its manifest phase", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-live-status-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory("status-recording");
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    runner: new ProbeRunner(),
    transportFactory: factory,
  });
  try {
    const started = await controller.start(START_OPTIONS);
    expect(await controller.status()).toMatchObject({
      completedSegmentCount: 0,
      logicalTimeUs: 0,
      recordingId: started.recordingId,
      state: "recording",
    });
    expect(await loadRecordingManifest(createNodeBundleFileSystem(started.recordingRoot!))).toMatchObject({
      state: "recording",
      timeline: { durationUs: 0 },
    });

    await completeFixtureRecording(controller);
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});

for (const [scenario, reportedState] of [
  ["status-ready", "ready"],
  ["status-unconfigured", "unconfigured"],
  ["status-shutting-down", "shutting-down"],
] as const) {
  test(`rejects active-session ${reportedState} status before snapshot mutation`, async () => {
    const temporary = await mkdtemp(join(
      tmpdir(),
      `atet-controller-status-${reportedState}-test-`,
    ));
    const helper = join(temporary, "atet-capture");
    const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
    const factory = new ProtocolTransportFactory(scenario);
    await writeFile(helper, "test helper", { mode: 0o700 });
    const controller = new CaptureHelperRecordingController({
      artifactRoot,
      executable: helper,
      io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
      runner: new ProbeRunner(),
      transportFactory: factory,
    });
    try {
      const started = await controller.start(START_OPTIONS);
      expect(await operationFailure(controller.status())).toMatchObject({
        code: "invalid-data",
        details: {
          recovery: {
            recordingId: started.recordingId,
            terminalManifestState: "failed",
          },
        },
      });
      expect(await loadRecordingManifest(
        createNodeBundleFileSystem(started.recordingRoot!),
      )).toMatchObject({
        sources: SOURCES,
        state: "failed",
        timeline: { durationUs: 0 },
        tracks: [],
      });
      expect(await readRepositoryRecordingState(artifactRoot)).toMatchObject({
        recordingId: null,
        state: "idle",
      });
      expect(factory.transport.closed).toBeTrue();
    } finally {
      await controller.close();
      await rm(temporary, { force: true, recursive: true });
    }
  });
}

test("refreshes available sources without changing selected sources or the raw bundle", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-available-sources-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory("status-available-sources");
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    runner: new ProbeRunner(),
    transportFactory: factory,
  });
  try {
    const started = await controller.start(START_OPTIONS);
    const status = await controller.status();
    expect(status).toMatchObject({
      availableSources: FRESH_AVAILABLE_SOURCES,
      sources: SOURCES,
      state: "recording",
    });
    const manifest = await loadRecordingManifest(
      createNodeBundleFileSystem(started.recordingRoot!),
    );
    expect(manifest.sources).toEqual(SOURCES);
    expect(manifest.sources).not.toEqual(FRESH_AVAILABLE_SOURCES);
    await completeFixtureRecording(controller);
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});

test("rejects completion source drift before persisting the segment", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-completion-source-drift-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory("pause-selected-source-drift");
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    runner: new ProbeRunner(),
    transportFactory: factory,
  });
  try {
    const started = await controller.start(START_OPTIONS);
    expect(await operationFailure(controller.pause())).toMatchObject({
      code: "invalid-data",
      details: {
        recovery: { terminalManifestState: "failed" },
      },
    });
    expect(await loadRecordingManifest(
      createNodeBundleFileSystem(started.recordingRoot!),
    )).toMatchObject({
      sources: SOURCES,
      state: "failed",
      timeline: { durationUs: 0 },
      tracks: [],
    });
    expect(factory.transport.closed).toBeTrue();
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});

test("rejects selected-source drift even when the fresh inventory is valid", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-source-drift-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory("status-selected-source-drift");
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    runner: new ProbeRunner(),
    transportFactory: factory,
  });
  try {
    const started = await controller.start(START_OPTIONS);
    expect(await operationFailure(controller.status())).toMatchObject({
      code: "invalid-data",
      details: {
        recovery: { terminalManifestState: "failed" },
      },
    });
    expect(await loadRecordingManifest(
      createNodeBundleFileSystem(started.recordingRoot!),
    )).toMatchObject({
      sources: SOURCES,
      state: "failed",
    });
    expect(factory.transport.closed).toBeTrue();
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});

test("drains completion and session events before the same shutdown acknowledgement", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-shutdown-order-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory("shutdown-finalizes");
  const observedEvents: CaptureEvent["event"][] = [];
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    onCaptureEvent: event => observedEvents.push(event.event),
    runner: new ProbeRunner(),
    transportFactory: factory,
  });
  try {
    const started = await controller.start(START_OPTIONS);
    await controller.close();

    expect(factory.transport.requests.map(({ command }) => command)).toEqual([
      "configure",
      "start",
      "shutdown",
    ]);
    expect(observedEvents.slice(-3)).toEqual([
      "segment-completed",
      "session-completed",
      "shutdown",
    ]);
    expect(await loadRecordingManifest(createNodeBundleFileSystem(started.recordingRoot!))).toMatchObject({
      state: "stopped",
      timeline: { durationUs: 1_000_000 },
    });
    expect(await exists(join(artifactRoot, ".active-recording.json"))).toBeFalse();
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});

for (const malformed of [
  {
    invoke: (controller: CaptureHelperRecordingController) => controller.pause(),
    name: "session completion before a pause segment",
    scenario: "pause-session-before-segment",
  },
  {
    invoke: (controller: CaptureHelperRecordingController) => controller.status(),
    name: "session completion followed by paused status",
    scenario: "status-session-before-paused",
  },
  {
    invoke: (controller: CaptureHelperRecordingController) => controller.status(),
    name: "stopped status without session completion",
    scenario: "status-incomplete-stop",
  },
  {
    invoke: (controller: CaptureHelperRecordingController) => controller.status(),
    name: "paused status beyond its optional completion frontier",
    scenario: "status-auto-pause-wrong-frontier",
  },
  {
    invoke: (controller: CaptureHelperRecordingController) => controller.stop(),
    name: "session completion with an invented blank tail",
    scenario: "stop-invented-session-frontier",
  },
  {
    invoke: (controller: CaptureHelperRecordingController) => controller.resume(),
    name: "the wrong suffix after resume completion",
    scenario: "resume-completion-before-status",
  },
  {
    invoke: (controller: CaptureHelperRecordingController) => controller.status(),
    name: "a failure suffix on status completion",
    scenario: "status-completion-before-error",
  },
  {
    invoke: (controller: CaptureHelperRecordingController) => controller.close(),
    name: "shutdown acknowledgement before session completion",
    scenario: "shutdown-completion-without-session",
  },
] as const) {
  test(`rejects ${malformed.name} before applying prefix evidence`, async () => {
    const temporary = await mkdtemp(join(tmpdir(), "atet-controller-malformed-sequence-test-"));
    const helper = join(temporary, "atet-capture");
    const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
    const factory = new ProtocolTransportFactory(malformed.scenario);
    await writeFile(helper, "test helper", { mode: 0o700 });
    const controller = new CaptureHelperRecordingController({
      artifactRoot,
      executable: helper,
      io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
      runner: new ProbeRunner(),
      transportFactory: factory,
    });
    try {
      const started = await controller.start(START_OPTIONS);
      expect(await operationFailure(malformed.invoke(controller))).toMatchObject({
        code: "invalid-data",
        details: {
          recovery: {
            recordingId: started.recordingId,
            recordingRoot: started.recordingRoot,
            terminalManifestState: "failed",
          },
        },
      });
      expect(await loadRecordingManifest(createNodeBundleFileSystem(started.recordingRoot!))).toMatchObject({
        state: "failed",
        timeline: { durationUs: 0 },
        tracks: [],
      });
      expect(factory.transport.closed).toBeTrue();
      expect(await exists(join(artifactRoot, ".active-recording.json"))).toBeFalse();
    } finally {
      await controller.close();
      await rm(temporary, { force: true, recursive: true });
    }
  });
}

test("rejects a resumed segment that starts beyond the persisted bundle frontier", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-resume-frontier-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory("resume-wrong-start-frontier");
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    runner: new ProbeRunner(),
    transportFactory: factory,
  });
  try {
    const started = await controller.start(START_OPTIONS);
    await controller.pause();
    expect(await operationFailure(controller.resume())).toMatchObject({
      code: "invalid-data",
      details: {
        recovery: {
          recordingId: started.recordingId,
          recordingRoot: started.recordingRoot,
          terminalManifestState: "failed",
        },
      },
    });
    expect(await loadRecordingManifest(createNodeBundleFileSystem(started.recordingRoot!))).toMatchObject({
      state: "failed",
      timeline: { durationUs: 1_000_000 },
    });
    expect(factory.transport.closed).toBeTrue();
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});

for (const terminalRegression of [
  {
    invoke: (controller: CaptureHelperRecordingController) => controller.status(),
    name: "paused resurrection after stopped status",
    scenario: "status-resurrects-after-stop",
  },
  {
    invoke: (controller: CaptureHelperRecordingController) => controller.status(),
    name: "repeated session completion before status",
    scenario: "status-repeats-session",
  },
  {
    invoke: (controller: CaptureHelperRecordingController) => controller.close(),
    name: "repeated session completion before shutdown",
    scenario: "shutdown-repeats-session",
  },
] as const) {
  test(`rejects ${terminalRegression.name}`, async () => {
    const temporary = await mkdtemp(join(tmpdir(), "atet-controller-terminal-regression-test-"));
    const helper = join(temporary, "atet-capture");
    const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
    const factory = new ProtocolTransportFactory(terminalRegression.scenario);
    await writeFile(helper, "test helper", { mode: 0o700 });
    const controller = new CaptureHelperRecordingController({
      artifactRoot,
      executable: helper,
      io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
      runner: new ProbeRunner(),
      transportFactory: factory,
    });
    try {
      const started = await controller.start(START_OPTIONS);
      await controller.stop();
      expect(await operationFailure(terminalRegression.invoke(controller))).toMatchObject({
        code: "invalid-data",
        details: {
          recovery: {
            recordingId: started.recordingId,
            recordingRoot: started.recordingRoot,
            terminalManifestState: "stopped",
          },
        },
      });
      expect(await loadRecordingManifest(createNodeBundleFileSystem(started.recordingRoot!))).toMatchObject({
        state: "stopped",
        timeline: { durationUs: 1_000_000 },
      });
      expect(factory.transport.closed).toBeTrue();
    } finally {
      await controller.close();
      await rm(temporary, { force: true, recursive: true });
    }
  });
}

test("passes a cloned process-scoped typed-text focus identity to the helper", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-focus-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory();
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    runner: new ProbeRunner(),
    transportFactory: factory,
  });
  try {
    await controller.start({
      ...START_OPTIONS,
      interactionEventProcessIdentifier: FIXTURE_FOCUS_IDENTITY.processId,
      typedText: true,
      typedTextFocusIdentities: [FIXTURE_FOCUS_IDENTITY],
    });
    expect(factory.transport.configuredOptions).toMatchObject({
      interactionEventProcessIdentifier: FIXTURE_FOCUS_IDENTITY.processId,
      typedText: true,
      typedTextFocusIdentities: [FIXTURE_FOCUS_IDENTITY],
    });
    await completeFixtureRecording(controller);
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});

test("passes exact display, camera, and microphone selections to every helper segment", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-sources-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory();
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    runner: new ProbeRunner(),
    transportFactory: factory,
  });
  try {
    await controller.start({
      camera: { deviceId: "camera-external", kind: "device" },
      displays: { displayIds: ["display-primary"], kind: "selected" },
      microphone: { deviceId: "microphone-usb", kind: "device" },
      strictInputs: true,
      systemAudio: false,
      typedText: false,
    });
    expect(factory.transport.configuredOptions).toMatchObject({
      camera: { deviceId: "camera-external", kind: "device" },
      displays: { displayIds: ["display-primary"], kind: "selected" },
      microphone: { deviceId: "microphone-usb", kind: "device" },
      strictSources: true,
      systemAudio: false,
    });
    await completeFixtureRecording(controller);
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});

test("round-trips the exact persisted interaction and typed-text scope", () => {
  const parsed = parseRecordingSnapshot({
    availableSources: SOURCES,
    completedSegmentCount: 0,
    effectiveConfig: {
      ...START_OPTIONS,
      interactionEventProcessIdentifier: FIXTURE_FOCUS_IDENTITY.processId,
      metadata: true,
      typedText: true,
      typedTextFocusIdentities: [FIXTURE_FOCUS_IDENTITY],
    },
    lastInterruption: null,
    logicalTimeUs: 0,
    permissions: PERMISSIONS,
    recordingId: "rec_fixture",
    recordingRoot: "/tmp/rec_fixture",
    sources: SOURCES,
    state: "recording",
    updatedAt: "2026-07-22T12:00:00.000Z",
  });
  expect(parsed.effectiveConfig).toMatchObject({
    interactionEventProcessIdentifier: FIXTURE_FOCUS_IDENTITY.processId,
    typedTextFocusIdentities: [FIXTURE_FOCUS_IDENTITY],
  });
  expect(() => parseRecordingSnapshot({
    ...parsed,
    effectiveConfig: {
      ...parsed.effectiveConfig,
      typedTextFocusIdentities: [{
        ...FIXTURE_FOCUS_IDENTITY,
        fieldId: "x".repeat(513),
      }],
    },
  })).toThrow("typed-text focus identities");
});

test("marks the bundle failed and clears active state when native finalization fails", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-finalization-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory("pause-finalization");
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    runner: new ProbeRunner(),
    transportFactory: factory,
  });
  try {
    const started = await controller.start(START_OPTIONS);
    const recordingRoot = started.recordingRoot!;

    expect((await operationFailure(controller.pause())).message).toContain("Capture helper screen-finalization-failed");

    expect((await loadRecordingManifest(createNodeBundleFileSystem(recordingRoot))).state).toBe("failed");
    expect(await exists(join(artifactRoot, ".active-recording.json"))).toBeFalse();
    expect(await controller.status()).toMatchObject({ recordingId: null, state: "idle" });
    expect(factory.transport.closed).toBeTrue();
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});

for (const scenario of [
  {
    fault: "stream-onset-skew",
    name: "onset skew",
    runner: () => new ProbeRunner(),
  },
  {
    fault: "stream-duration-drift",
    name: "duration drift",
    runner: () => new ProbeRunner(900_000),
  },
] as const) {
  test(`refuses to report a stopped recording with out-of-tolerance ${scenario.name}`, async () => {
    const temporary = await mkdtemp(join(tmpdir(), "atet-controller-sync-rejection-test-"));
    const helper = join(temporary, "atet-capture");
    const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
    const factory = new ProtocolTransportFactory(scenario.fault);
    await writeFile(helper, "test helper", { mode: 0o700 });
    const controller = new CaptureHelperRecordingController({
      artifactRoot,
      executable: helper,
      io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
      runner: scenario.runner(),
      transportFactory: factory,
    });
    try {
      const started = await controller.start(START_OPTIONS);
      const recordingRoot = started.recordingRoot!;
      expect(await controller.pause()).toMatchObject({ state: "paused" });
      expect(await controller.resume()).toMatchObject({ state: "recording" });

      const failure = await operationFailure(controller.stop());
      expect(failure).toMatchObject({
        code: "invalid-data",
        details: {
          diagnosticCode: "capture-sync-publication-rejected",
          recovery: {
            recordingId: started.recordingId,
            recordingRoot,
            terminalManifestState: "failed",
          },
        },
      });
      expect(failure.message).toContain("exceeded capture synchronization tolerance");

      const manifest = await loadRecordingManifest(createNodeBundleFileSystem(recordingRoot));
      expect(manifest.state).toBe("failed");
      expect(manifest.tracks.flatMap(({ segments }) => segments).some(({ timing }) => (
        timing.kind === "measured" && timing.status === "out-of-tolerance"
      ))).toBeTrue();
      expect(manifest.diagnostics.find(({ code }) => code === "capture-sync-publication-rejected")).toMatchObject({
        code: "capture-sync-publication-rejected",
        level: "error",
      });
      expect(await exists(join(artifactRoot, ".active-recording.json"))).toBeFalse();
      expect(await controller.status()).toMatchObject({ recordingId: null, state: "idle" });
      expect(factory.transport.closed).toBeTrue();
    } finally {
      await controller.close();
      await rm(temporary, { force: true, recursive: true });
    }
  });
}

test("retires replies from a failed helper and starts cleanly after segment verification fails", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-verification-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ReusableProtocolTransportFactory();
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    runner: new FaultOnceProbeRunner(),
    transportFactory: factory,
  });
  try {
    const first = await controller.start(START_OPTIONS);
    const failedRoot = first.recordingRoot!;

    expect((await operationFailure(controller.stop())).message).toContain("injected capture verification failure");

    expect(await loadRecordingManifest(createNodeBundleFileSystem(failedRoot))).toMatchObject({
      state: "failed",
      timeline: { durationUs: 1_000_000 },
      tracks: [],
    });
    expect(factory.transports).toHaveLength(1);
    expect(factory.transports[0]?.closed).toBeTrue();
    expect(await controller.status()).toMatchObject({ recordingId: null, state: "idle" });

    const restarted = await controller.start(START_OPTIONS);
    expect(restarted.recordingRoot).not.toBe(failedRoot);
    await completeFixtureRecording(controller);
    expect((await loadRecordingManifest(createNodeBundleFileSystem(restarted.recordingRoot!))).state).toBe("stopped");
    expect(factory.transports).toHaveLength(2);
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});

test("marks a finalized segment failed when active-state persistence is unsafe", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "atet-controller-persistence-test-"));
  const helper = join(temporary, "atet-capture");
  const artifactRoot = join(temporary, "artifacts", "atet", "recordings");
  const factory = new ProtocolTransportFactory();
  await writeFile(helper, "test helper", { mode: 0o700 });
  const controller = new CaptureHelperRecordingController({
    artifactRoot,
    executable: helper,
    io: { now: () => new Date("2026-07-22T12:00:00.000Z") },
    runner: new ProbeRunner(),
    transportFactory: factory,
  });
  try {
    const started = await controller.start(START_OPTIONS);
    const recordingRoot = started.recordingRoot!;
    const activeState = join(artifactRoot, ".active-recording.json");
    await rm(activeState);
    await symlink(join(temporary, "attacker-controlled-state"), activeState);

    expect((await operationFailure(controller.pause())).message).toContain("Active recording state is a symlink");

    expect(await loadRecordingManifest(createNodeBundleFileSystem(recordingRoot))).toMatchObject({
      state: "failed",
      timeline: { durationUs: 1_000_000 },
    });
    expect(await exists(activeState)).toBeFalse();
    expect(factory.transport.closed).toBeTrue();
  } finally {
    await controller.close();
    await rm(temporary, { force: true, recursive: true });
  }
});
