import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  CaptureInterruptionSchema,
  CapturePermissionsSchema,
  CaptureRuntimeSnapshotSchema,
  DesktopEventSchema,
  DesktopRequestSchema,
  DesktopResponseSchema,
  ATET_DESKTOP_PROTOCOL_VERSION,
  RecordingIdSchema,
  RepositoryRelativePathSchema,
  RuntimeSourceSummarySchema,
  type CaptureDomainCommand,
  type CaptureInterruption,
  type CaptureRuntimeSnapshot,
  type CaptureStartOptions,
  type DesktopRequest,
  type DesktopResponse,
  type DesktopEvent,
} from "../../contracts";
import {
  CaptureSourceInventorySchema,
  parseCaptureHelperProbe,
  type CaptureSourceInventory,
} from "../../capture/protocol";
import { CliError } from "../../cli/errors";
import {
  RecordingDaemonClient,
  type RecordingDaemonClientOptions,
} from "../../cli/recording-daemon";
import { BunProcessRunner, type ProcessRunner } from "../../cli/io";
import type {
  RecordingController,
  RecordingSnapshot,
  RecordingStartOptions,
} from "../../cli/recording-controller";

const unavailablePermissions = CapturePermissionsSchema.parse({
  accessibility: "unavailable",
  camera: "unavailable",
  inputMonitoring: "unavailable",
  microphone: "unavailable",
  screenCapture: "unavailable",
  systemAudio: "unavailable",
  windowMetadata: "unavailable",
});

const emptySources = RuntimeSourceSummarySchema.parse({
  audioSources: [],
  cameras: [],
  displays: [],
});
const CAPTURE_HELPER_PROBE_MAX_OUTPUT_BYTES = 64 * 1024;
const CAPTURE_HELPER_PROBE_TIMEOUT_MS = 10_000;
const inactiveAbortSignal = new AbortController().signal;

function abortError(abortSignal: AbortSignal, message: string): Error {
  return abortSignal.reason instanceof Error
    ? abortSignal.reason
    : new Error(message);
}

function throwIfAborted(abortSignal: AbortSignal, message: string): void {
  if (abortSignal.aborted) throw abortError(abortSignal, message);
}

export type RuntimeControllerFactory = (artifactRoot: string) => RecordingController;
export type HelperProbe = (abortSignal: AbortSignal) => Promise<Readonly<{
  permissions: ReturnType<typeof CapturePermissionsSchema.parse>;
  sources: ReturnType<typeof RuntimeSourceSummarySchema.parse>;
}>>;

export interface RecordingServiceOptions {
  readonly captureHelper: string;
  readonly controllerFactory?: RuntimeControllerFactory;
  readonly daemonCommand?: readonly [string, ...string[]];
  readonly emit?: (event: DesktopEvent) => Promise<void> | void;
  readonly helperProbe?: HelperProbe;
  readonly now?: () => Date;
  readonly repositoryRoot: string | null;
  readonly statusPollIntervalMs?: number;
}

class RuntimeServiceError extends Error {
  readonly code: "conflict" | "invalid-request" | "unavailable" | "internal";
  readonly retryable: boolean;

  constructor(
    code: "conflict" | "invalid-request" | "unavailable" | "internal",
    message: string,
    retryable: boolean,
  ) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

function isInside(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

async function optionalPhysicalDirectory(path: string): Promise<boolean> {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new RuntimeServiceError(
        "unavailable",
        "Atet artifact namespaces must be physical directories.",
        false,
      );
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Selects the physical Atet artifact namespace before any recorder can write. */
export async function resolveRecordingArtifactDirectory(
  repositoryRoot: string,
  requestedDirectory: CaptureStartOptions["recordingDirectory"],
): Promise<string> {
  if (requestedDirectory !== "artifacts/atet/recordings") {
    throw new RuntimeServiceError(
      "unavailable",
      "Custom recording subdirectories are not available yet; use artifacts/atet/recordings.",
      false,
    );
  }
  const artifactNamespace = resolve(repositoryRoot, "artifacts", "atet");
  await optionalPhysicalDirectory(artifactNamespace);
  return resolve(artifactNamespace, "recordings");
}

function safeRecordingPath(repositoryRoot: string, absolutePath: string): string {
  const normalized = resolve(absolutePath);
  if (!isInside(repositoryRoot, normalized)) {
    throw new RuntimeServiceError("internal", "Recorder returned a path outside the configured checkout.", false);
  }
  return RepositoryRelativePathSchema.parse(relative(repositoryRoot, normalized).split(sep).join("/"));
}

function mapStartOptions(
  options: CaptureStartOptions,
  sources: ReturnType<typeof RuntimeSourceSummarySchema.parse>,
): RecordingStartOptions {
  if (options.displays.kind === "selected") {
    const available = new Set(sources.displays.map(({ id }) => id));
    const unknown = options.displays.displayIds.find((displayId) => !available.has(displayId));
    if (unknown !== undefined) {
      throw new RuntimeServiceError("invalid-request", `Unknown display ID: ${unknown}`, false);
    }
  }
  if (options.camera.kind === "device") {
    const deviceId = options.camera.deviceId;
    if (!sources.cameras.some(({ id }) => id === deviceId)) {
      throw new RuntimeServiceError(
        "invalid-request",
        `Unknown camera device ID: ${deviceId}`,
        false,
      );
    }
  }
  if (options.microphone.kind === "device") {
    const deviceId = options.microphone.deviceId;
    if (!sources.audioSources.some(({ id, kind }) =>
      kind === "microphone" && id === deviceId
    )) {
      throw new RuntimeServiceError(
        "invalid-request",
        `Unknown microphone device ID: ${deviceId}`,
        false,
      );
    }
  }
  return {
    camera: { ...options.camera },
    displays: options.displays.kind === "all"
      ? { kind: "all" }
      : { displayIds: [...options.displays.displayIds], kind: "selected" },
    microphone: { ...options.microphone },
    strictInputs: false,
    systemAudio: options.systemAudio,
    typedText: options.typedText === "enabled",
  };
}

function sourceSummary(
  sources: RecordingSnapshot["sources"],
): ReturnType<typeof RuntimeSourceSummarySchema.parse> {
  return RuntimeSourceSummarySchema.parse({
    audioSources: sources.audio.map(
      ({ audioSourceId, kind, label }) => ({ id: audioSourceId, kind, label }),
    ),
    cameras: sources.cameras.map(
      ({ cameraId, label }) => ({ id: cameraId, label }),
    ),
    displays: sources.displays.map(
      ({ displayId, isPrimary, label }) => ({ id: displayId, isPrimary, label }),
    ),
  });
}

function responseError(requestId: string, error: RuntimeServiceError): DesktopResponse {
  return DesktopResponseSchema.parse({
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    },
    ok: false,
    protocolVersion: ATET_DESKTOP_PROTOCOL_VERSION,
    requestId,
  });
}

function interruptionReason(interruption: CaptureInterruption): string {
  switch (interruption.code) {
  case "selected-display-disconnected":
    return "The selected display disconnected";
  case "screen-stream-stopped":
    return "Screen recording stopped";
  case "screen-recording-failed":
    return "Screen recording failed";
  case "system-audio-track-missing":
    return "System audio stopped";
  case "camera-device-disconnected":
    return "The camera disconnected";
  case "camera-session-interrupted":
    return "Camera recording was interrupted";
  case "camera-runtime-error":
  case "camera-recording-failed":
    return "Camera recording failed";
  case "camera-session-stopped":
    return "Camera recording stopped";
  case "microphone-device-disconnected":
    return "The microphone disconnected";
  case "microphone-session-interrupted":
    return "Microphone recording was interrupted";
  case "microphone-runtime-error":
  case "microphone-recording-failed":
    return "Microphone recording failed";
  case "microphone-session-stopped":
    return "Microphone recording stopped";
  }
}

function interruptionFrom(error: CliError): CaptureInterruption | null {
  const details = recordFrom(error.details);
  const captureFailure = recordFrom(details?.captureFailure);
  const captureFailureDetails = recordFrom(captureFailure?.details);
  for (const candidate of [
    details?.interruption,
    captureFailureDetails?.interruption,
  ]) {
    const parsed = CaptureInterruptionSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return null;
}

type FatalRecoveryInterruptionEvidence =
  | Readonly<{
      kind: "authoritative";
      value: CaptureInterruption | null;
    }>
  | Readonly<{
      kind: "unavailable";
    }>;

interface FatalRecoveryEvidence {
  readonly availableSources: CaptureSourceInventory | null;
  readonly controllerReusable: boolean;
  readonly lastInterruption: FatalRecoveryInterruptionEvidence;
  readonly logicalTimeUs: number | null;
  readonly permissions: ReturnType<typeof CapturePermissionsSchema.parse> | null;
  readonly recordingId: string | null;
  readonly recordingRoot: string | null;
  readonly sources: CaptureSourceInventory | null;
  readonly terminalManifestState: "failed" | "stopped" | "unsettled";
}

function recordFrom(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function nonnegativeSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function fatalRecoveryInterruptionFrom(
  snapshot: Readonly<Record<string, unknown>> | null,
): FatalRecoveryInterruptionEvidence {
  if (
    snapshot === null
    || !Object.hasOwn(snapshot, "lastInterruption")
  ) {
    return { kind: "unavailable" };
  }
  if (snapshot.lastInterruption === null) {
    return { kind: "authoritative", value: null };
  }
  const parsed = CaptureInterruptionSchema.safeParse(
    snapshot.lastInterruption,
  );
  return parsed.success
    ? { kind: "authoritative", value: parsed.data }
    : { kind: "unavailable" };
}

function fatalRecoveryFrom(error: CliError): FatalRecoveryEvidence | null {
  const recovery = recordFrom(error.details?.recovery);
  if (
    recovery === null
    || typeof recovery.controllerReusable !== "boolean"
    || (
      recovery.terminalManifestState !== "failed"
      && recovery.terminalManifestState !== "stopped"
      && recovery.terminalManifestState !== "unsettled"
    )
    || !(
      recovery.recordingId === null
      || typeof recovery.recordingId === "string"
    )
    || !(
      recovery.recordingRoot === null
      || typeof recovery.recordingRoot === "string"
    )
  ) {
    return null;
  }
  const snapshot = recordFrom(recovery?.snapshot);
  const availableSources = CaptureSourceInventorySchema.safeParse(
    snapshot?.availableSources,
  );
  const sources = CaptureSourceInventorySchema.safeParse(snapshot?.sources);
  const permissions = CapturePermissionsSchema.safeParse(snapshot?.permissions);
  return {
    availableSources: availableSources.success ? availableSources.data : null,
    controllerReusable: recovery.controllerReusable,
    lastInterruption: fatalRecoveryInterruptionFrom(snapshot),
    logicalTimeUs: nonnegativeSafeInteger(snapshot?.logicalTimeUs),
    permissions: permissions.success ? permissions.data : null,
    recordingId: typeof recovery?.recordingId === "string"
      ? recovery.recordingId
      : null,
    recordingRoot: typeof recovery?.recordingRoot === "string"
      ? recovery.recordingRoot
      : null,
    sources: sources.success ? sources.data : null,
    terminalManifestState: recovery.terminalManifestState,
  };
}

function effectiveFatalInterruption(
  direct: CaptureInterruption | null,
  recovery: FatalRecoveryEvidence | null,
): CaptureInterruption | null {
  if (direct !== null) return direct;
  return recovery?.lastInterruption.kind === "authoritative"
    ? recovery.lastInterruption.value
    : null;
}

function ownedFatalCodeFrom(error: CliError): "system-audio-track-missing" | null {
  const details = recordFrom(error.details);
  const captureFailure = recordFrom(details?.captureFailure);
  const captureFailureDetails = recordFrom(captureFailure?.details);
  const errorRecord = recordFrom(error);
  return [
    errorRecord?.code,
    details?.helperCode,
    captureFailure?.code,
    captureFailureDetails?.helperCode,
  ].some((candidate) => candidate === "system-audio-track-missing")
    ? "system-audio-track-missing"
    : null;
}

function ownedFatalFailure(
  interruption: CaptureInterruption | null,
  ownedCode: "system-audio-track-missing" | null,
  recovery: FatalRecoveryEvidence | null,
): Readonly<{ code: string; message: string }> {
  if (
    recovery !== null
    && (
      !recovery.controllerReusable
      || recovery.terminalManifestState === "unsettled"
    )
  ) {
    return {
      code: "capture-recovery-incomplete",
      message: "The recording stopped, but local recovery did not complete.",
    };
  }
  if (interruption !== null) {
    return {
      code: interruption.code,
      message: `${interruptionReason(interruption)}. The recording stopped.`,
    };
  }
  if (ownedCode === "system-audio-track-missing") {
    return {
      code: ownedCode,
      message: "System audio was missing from the finalized recording.",
    };
  }
  return {
    code: "capture-session-failed",
    message: "The recording stopped after a local capture failure.",
  };
}

function asRuntimeError(error: unknown): RuntimeServiceError {
  if (error instanceof RuntimeServiceError) return error;
  if (error instanceof CliError) {
    const recovery = fatalRecoveryFrom(error);
    const interruption = effectiveFatalInterruption(
      interruptionFrom(error),
      recovery,
    );
    const ownedFatalCode = ownedFatalCodeFrom(error);
    if (recovery !== null) {
      return new RuntimeServiceError(
        "internal",
        ownedFatalFailure(interruption, ownedFatalCode, recovery).message,
        false,
      );
    }
    if (interruption !== null || ownedFatalCode !== null) {
      return new RuntimeServiceError(
        "unavailable",
        ownedFatalFailure(interruption, ownedFatalCode, null).message,
        false,
      );
    }
    if (error.code === "conflict") {
      return new RuntimeServiceError(
        "conflict",
        "The recording command cannot run in the current recorder state.",
        false,
      );
    }
    if (error.code === "unavailable" || error.code === "subprocess") {
      return new RuntimeServiceError(
        "unavailable",
        "The local capture runtime is unavailable.",
        true,
      );
    }
    if (error.code === "usage") {
      return new RuntimeServiceError(
        "invalid-request",
        "The recording command is invalid.",
        false,
      );
    }
    if (error.code === "invalid-data") {
      return new RuntimeServiceError(
        "internal",
        "The local recorder returned invalid data.",
        false,
      );
    }
    if (error.code === "unsafe-path") {
      return new RuntimeServiceError(
        "invalid-request",
        "The recorder refused an unsafe local path.",
        false,
      );
    }
  }
  return new RuntimeServiceError("internal", "The local recording runtime failed.", false);
}

export async function probeCaptureHelper(
  executable: string,
  runner: ProcessRunner = new BunProcessRunner(),
  abortSignal: AbortSignal = inactiveAbortSignal,
): Promise<Awaited<ReturnType<HelperProbe>>> {
  throwIfAborted(abortSignal, "Capture helper capability probe was cancelled.");
  let result: Awaited<ReturnType<ProcessRunner["run"]>>;
  try {
    result = await runner.run([executable, "--json"], {
      abortSignal,
      env: { LANG: "en_US.UTF-8", PATH: "/usr/bin:/bin" },
      // One extra byte lets the caller distinguish an at-limit response from
      // bounded-tail truncation without retaining unbounded helper output.
      maxOutputBytes: CAPTURE_HELPER_PROBE_MAX_OUTPUT_BYTES + 1,
      timeoutMs: CAPTURE_HELPER_PROBE_TIMEOUT_MS,
    });
  } catch {
    throwIfAborted(abortSignal, "Capture helper capability probe was cancelled.");
    throw new RuntimeServiceError("unavailable", "The capture helper capability probe failed.", true);
  }
  throwIfAborted(abortSignal, "Capture helper capability probe was cancelled.");
  const { exitCode, stdout } = result;
  if (
    exitCode !== 0
    || Buffer.byteLength(stdout) > CAPTURE_HELPER_PROBE_MAX_OUTPUT_BYTES
  ) {
    throw new RuntimeServiceError("unavailable", "The capture helper capability probe failed.", true);
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout) as unknown;
  } catch {
    throw new RuntimeServiceError("unavailable", "The capture helper capability probe returned invalid data.", true);
  }
  const probe = parseCaptureHelperProbe(value);
  throwIfAborted(abortSignal, "Capture helper capability probe was cancelled.");
  return {
    permissions: probe.permissions,
    sources: sourceSummary(probe.availableSources),
  };
}

export class RecordingService {
  readonly #captureHelper: string;
  readonly #controllerFactory: RuntimeControllerFactory;
  readonly #emit: (event: DesktopEvent) => Promise<void> | void;
  readonly #helperProbe: HelperProbe;
  readonly #now: () => Date;
  readonly #repositoryRoot: string | null;
  readonly #statusPollIntervalMs: number;
  #activeController: RecordingController | null = null;
  #activeState: Extract<
    CaptureRuntimeSnapshot["state"],
    { readonly state: "paused" | "recording" | "stopping" }
  > | null = null;
  #closing = false;
  #failedState: Extract<
    CaptureRuntimeSnapshot["state"],
    { readonly state: "failed" }
  > | null = null;
  #inFlightCommand: string | null = null;
  #lastRecording: Extract<CaptureRuntimeSnapshot["state"], { readonly state: "idle" }>["lastRecording"] = null;
  #lastInterruption: CaptureRuntimeSnapshot["lastInterruption"] = null;
  #lastPublishedMaterial: string | null = null;
  #operationTail: Promise<void> = Promise.resolve();
  #permissions = unavailablePermissions;
  #availableSources = emptySources;
  #sources = emptySources;
  #watchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: RecordingServiceOptions) {
    this.#captureHelper = options.captureHelper;
    this.#emit = options.emit ?? (() => undefined);
    this.#repositoryRoot = options.repositoryRoot;
    this.#now = options.now ?? (() => new Date());
    const statusPollIntervalMs = options.statusPollIntervalMs ?? 250;
    this.#statusPollIntervalMs = Number.isFinite(statusPollIntervalMs)
      && statusPollIntervalMs > 0
      ? Math.max(1, Math.floor(statusPollIntervalMs))
      : 250;
    const daemonCommand = options.daemonCommand ?? [process.execPath];
    this.#controllerFactory = options.controllerFactory ?? ((artifactRoot) => new RecordingDaemonClient({
      artifactRoot,
      daemonCommand,
      helperExecutable: this.#captureHelper,
    } satisfies RecordingDaemonClientOptions));
    this.#helperProbe = options.helperProbe
      ?? (async (abortSignal) => await probeCaptureHelper(
        this.#captureHelper,
        new BunProcessRunner(),
        abortSignal,
      ));
  }

  async initialize(abortSignal: AbortSignal = inactiveAbortSignal): Promise<void> {
    this.#throwIfInitializationInactive(abortSignal);
    await this.#serialize(async () => {
      this.#throwIfInitializationInactive(abortSignal);
      try {
        await this.#refreshCapabilities(abortSignal);
      } catch {
        if (abortSignal.aborted || this.#closing) {
          this.#throwIfInitializationInactive(abortSignal);
        }
        // Startup remains available for an actionable unavailable snapshot.
      }
    });
    this.#throwIfInitializationInactive(abortSignal);
    this.#scheduleWatch();
  }

  async handle(requestValue: unknown, bridgeCommand: string): Promise<DesktopResponse> {
    let request: DesktopRequest;
    try {
      request = DesktopRequestSchema.parse(requestValue);
    } catch {
      throw new RuntimeServiceError("invalid-request", "Desktop request is invalid.", false);
    }
    if (
      (bridgeCommand === "atet.runtime.snapshot" && request.payload.kind !== "snapshot")
      || (bridgeCommand === "atet.runtime.dispatch" && request.payload.kind !== "dispatch")
    ) {
      return responseError(request.requestId, new RuntimeServiceError("invalid-request", "Bridge command and request payload disagree.", false));
    }
    try {
      const snapshot = request.payload.kind === "snapshot"
        ? await this.snapshot()
        : await this.#dispatchAndPublish(request.payload.command);
      return DesktopResponseSchema.parse({
        ok: true,
        protocolVersion: ATET_DESKTOP_PROTOCOL_VERSION,
        requestId: request.requestId,
        snapshot,
      });
    } catch (error) {
      return responseError(request.requestId, asRuntimeError(error));
    }
  }

  async snapshot(): Promise<CaptureRuntimeSnapshot> {
    return await this.#serialize(async () => await this.#snapshotNow());
  }

  async dispatch(command: CaptureDomainCommand): Promise<CaptureRuntimeSnapshot> {
    return await this.#runCommand(
      command,
      async () => await this.#execute(command),
    );
  }

  async close(): Promise<void> {
    this.#closing = true;
    if (this.#watchTimer !== null) {
      clearTimeout(this.#watchTimer);
      this.#watchTimer = null;
    }
    await this.#serialize(async () => {
      const controller = this.#activeController;
      this.#activeController = null;
      this.#activeState = null;
      if (controller === null) return;
      try {
        const snapshot = await controller.status();
        if (snapshot.state === "recording" || snapshot.state === "paused") {
          await controller.stop();
        }
      } catch {
        // Shutdown is best-effort; the recording daemon retains recovery evidence.
      } finally {
        await controller.close();
      }
    });
  }

  async #snapshotNow(): Promise<CaptureRuntimeSnapshot> {
    if (this.#repositoryRoot === null) {
      return this.#snapshotFromState({
        code: "repository-not-configured",
        message: "Repackage Atet from an Atet checkout or launch it with ATET_REPOSITORY_ROOT.",
        recordingId: null,
        recordingPath: null,
        sourceTimeUs: null,
        state: "failed",
      });
    }
    if (this.#activeController === null) {
      await this.#refreshCapabilitiesForSnapshot();
      if (this.#failedState !== null) {
        return this.#snapshotFromState(this.#failedState);
      }
      return this.#snapshotFromState({ lastRecording: this.#lastRecording, state: "idle" });
    }
    let snapshot: RecordingSnapshot;
    try {
      snapshot = await this.#activeController.status();
    } catch (error) {
      const failed = await this.#materializeFatalFailure(error);
      if (failed !== null) {
        await this.#publishSnapshotChanged(failed);
        return failed;
      }
      throw error;
    }
    if (snapshot.state === "idle") {
      this.#applyRecordingEvidence(snapshot);
      await this.#activeController.close();
      this.#activeController = null;
      this.#activeState = null;
      await this.#refreshCapabilitiesForSnapshot();
      return this.#snapshotFromState({
        lastRecording: this.#lastRecording,
        state: "idle",
      });
    }
    return this.#snapshotFromRecording(snapshot);
  }

  async #runCommand<Result>(
    command: CaptureDomainCommand,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    if (this.#inFlightCommand !== null) {
      throw new RuntimeServiceError("conflict", "Another recording command is still running.", true);
    }
    this.#inFlightCommand = command.commandId;
    try {
      return await this.#serialize(operation);
    } finally {
      this.#inFlightCommand = null;
    }
  }

  async #dispatchAndPublish(
    command: CaptureDomainCommand,
  ): Promise<CaptureRuntimeSnapshot> {
    return await this.#runCommand(command, async () => {
      try {
        const snapshot = await this.#execute(command);
        await this.#publishSnapshotChanged(snapshot, true);
        await this.#publish({
          commandId: command.commandId,
          kind: "command-settled",
          protocolVersion: ATET_DESKTOP_PROTOCOL_VERSION,
          status: "succeeded",
        });
        return snapshot;
      } catch (error) {
        const failed = await this.#materializeFatalFailure(error);
        if (failed !== null) {
          await this.#publishSnapshotChanged(failed, true);
        }
        await this.#publish({
          commandId: command.commandId,
          kind: "command-settled",
          protocolVersion: ATET_DESKTOP_PROTOCOL_VERSION,
          status: "failed",
        });
        throw error;
      }
    });
  }

  async #execute(command: CaptureDomainCommand): Promise<CaptureRuntimeSnapshot> {
    if (this.#repositoryRoot === null) {
      throw new RuntimeServiceError("unavailable", "An Atet repository checkout is not configured.", false);
    }
    switch (command.kind) {
    case "start": {
      if (this.#failedState?.code === "capture-recovery-incomplete") {
        throw new RuntimeServiceError(
          "unavailable",
          "Recording is disabled because local recovery did not complete.",
          false,
        );
      }
      if (this.#activeController !== null) {
        const existing = await this.#activeController.status();
        if (existing.state !== "idle") throw new RuntimeServiceError("conflict", "A recording is already active.", false);
        this.#applyRecordingEvidence(existing);
        await this.#activeController.close();
        this.#activeController = null;
        this.#activeState = null;
      }
      await this.#refreshCapabilities();
      const startOptions = mapStartOptions(command.options, this.#availableSources);
      const artifactRoot = await this.#resolveRecordingDirectory(command.options);
      const controller = this.#controllerFactory(artifactRoot);
      this.#activeController = controller;
      try {
        const started = await controller.start(startOptions);
        const snapshot = this.#snapshotFromRecording(started);
        if (snapshot.state.state !== "recording") {
          throw new RuntimeServiceError(
            "internal",
            "Recorder did not enter the recording state.",
            false,
          );
        }
        this.#failedState = null;
        return snapshot;
      } catch (error) {
        this.#activeController = null;
        this.#activeState = null;
        try {
          await controller.close();
        } catch {
          // The original command failure remains authoritative.
        }
        throw error;
      }
    }
    case "pause":
      return this.#snapshotFromRecording(await this.#requiredController().pause());
    case "resume":
      return this.#snapshotFromRecording(await this.#requiredController().resume());
    case "stop": {
      const controller = this.#requiredController();
      const stopped = await controller.stop();
      this.#applyRecordingEvidence(stopped);
      const recordingId = stopped.recordingId;
      const recordingRoot = stopped.recordingRoot;
      if (recordingId !== null && recordingRoot !== null) {
        this.#lastRecording = {
          durationUs: stopped.logicalTimeUs,
          recordingId: RecordingIdSchema.parse(recordingId),
          recordingPath: safeRecordingPath(this.#repositoryRoot, recordingRoot),
        };
      }
      await controller.close();
      this.#activeController = null;
      this.#activeState = null;
      return this.#snapshotFromState({ lastRecording: this.#lastRecording, state: "idle" });
    }
    }
  }

  async #refreshCapabilities(abortSignal: AbortSignal = inactiveAbortSignal): Promise<void> {
    this.#throwIfInitializationInactive(abortSignal);
    try {
      const probe = await this.#helperProbe(abortSignal);
      this.#throwIfInitializationInactive(abortSignal);
      const permissions = CapturePermissionsSchema.parse(probe.permissions);
      const sources = RuntimeSourceSummarySchema.parse(probe.sources);
      this.#throwIfInitializationInactive(abortSignal);
      this.#permissions = permissions;
      this.#availableSources = sources;
    } catch (error) {
      if (abortSignal.aborted || this.#closing) {
        this.#throwIfInitializationInactive(abortSignal);
      }
      this.#permissions = unavailablePermissions;
      this.#availableSources = emptySources;
      if (error instanceof RuntimeServiceError && error.code === "unavailable") throw error;
      throw new RuntimeServiceError("unavailable", "The capture helper capability probe failed.", true);
    }
  }

  #throwIfInitializationInactive(abortSignal: AbortSignal): void {
    if (!abortSignal.aborted && !this.#closing) return;
    if (abortSignal.aborted) throw abortError(
      abortSignal,
      "Recording service initialization was cancelled.",
    );
    throw new Error("Recording service initialization was cancelled.");
  }

  async #refreshCapabilitiesForSnapshot(): Promise<void> {
    try {
      await this.#refreshCapabilities();
    } catch {
      // Snapshot reads remain available with the cleared, unavailable
      // capability state written by #refreshCapabilities.
    }
  }

  #requiredController(): RecordingController {
    if (this.#activeController === null) {
      throw new RuntimeServiceError("conflict", "No recording is active.", false);
    }
    return this.#activeController;
  }

  async #resolveRecordingDirectory(options: CaptureStartOptions): Promise<string> {
    const requested = await resolveRecordingArtifactDirectory(
      this.#repositoryRoot!,
      options.recordingDirectory,
    );
    const allowedRoot = resolve(this.#repositoryRoot!, "artifacts");
    if (!isInside(allowedRoot, requested)) {
      throw new RuntimeServiceError("invalid-request", "Recording directory escapes the repository artifact root.", false);
    }
    const repository = await realpath(this.#repositoryRoot!);
    if (repository !== this.#repositoryRoot) {
      throw new RuntimeServiceError("unavailable", "Configured repository root is not canonical.", false);
    }
    return requested;
  }

  #snapshotFromRecording(snapshot: RecordingSnapshot): CaptureRuntimeSnapshot {
    this.#applyRecordingEvidence(snapshot);
    if (snapshot.permissions !== null) {
      const parsed = CapturePermissionsSchema.safeParse(snapshot.permissions);
      if (parsed.success) this.#permissions = parsed.data;
    }
    if (snapshot.state === "idle") return this.#snapshotFromState({ lastRecording: this.#lastRecording, state: "idle" });
    if (snapshot.recordingId === null || snapshot.recordingRoot === null || this.#repositoryRoot === null) {
      return this.#snapshotFromState({
        code: "invalid-recorder-state",
        message: "Recorder returned incomplete active state.",
        recordingId: null,
        recordingPath: null,
        sourceTimeUs: null,
        state: "failed",
      });
    }
    const state = {
      recordingId: RecordingIdSchema.parse(snapshot.recordingId),
      recordingPath: safeRecordingPath(this.#repositoryRoot, snapshot.recordingRoot),
      sourceTimeUs: snapshot.logicalTimeUs,
      state: snapshot.state,
    } as const;
    this.#activeState = state;
    return this.#snapshotFromState(state);
  }

  #applyRecordingEvidence(snapshot: RecordingSnapshot): void {
    this.#availableSources = sourceSummary(snapshot.availableSources);
    this.#lastInterruption = snapshot.lastInterruption;
    this.#sources = sourceSummary(snapshot.sources);
  }

  async #materializeFatalFailure(
    error: unknown,
  ): Promise<CaptureRuntimeSnapshot | null> {
    if (!(error instanceof CliError)) return null;
    const recovery = fatalRecoveryFrom(error);
    if (recovery === null) return null;
    const interruption = effectiveFatalInterruption(
      interruptionFrom(error),
      recovery,
    );
    const failure = ownedFatalFailure(
      interruption,
      ownedFatalCodeFrom(error),
      recovery,
    );
    if (recovery.availableSources !== null) {
      this.#availableSources = sourceSummary(recovery.availableSources);
    }
    if (recovery.sources !== null) {
      this.#sources = sourceSummary(recovery.sources);
    }
    if (recovery.permissions !== null) {
      this.#permissions = recovery.permissions;
    }
    // An explicit recovered null clears prior-session history. Missing or
    // malformed recovery evidence alone may retain the last known value.
    this.#lastInterruption = interruption
      ?? (
        recovery.lastInterruption.kind === "authoritative"
          ? null
          : this.#lastInterruption
      );

    const recoveryRecordingId = RecordingIdSchema.safeParse(recovery.recordingId);
    let recoveryRecordingPath: string | null = null;
    if (
      recovery.recordingRoot !== null
      && this.#repositoryRoot !== null
    ) {
      try {
        recoveryRecordingPath = safeRecordingPath(
          this.#repositoryRoot,
          recovery.recordingRoot,
        );
      } catch {
        // Invalid native recovery paths never cross the desktop boundary.
      }
    }
    const recoveredIdentity = recoveryRecordingId.success
      && recoveryRecordingPath !== null
      ? {
          recordingId: recoveryRecordingId.data,
          recordingPath: recoveryRecordingPath,
        }
      : null;
    const recordingId = recoveredIdentity?.recordingId
      ?? this.#activeState?.recordingId
      ?? null;
    const recordingPath = recoveredIdentity?.recordingPath
      ?? this.#activeState?.recordingPath
      ?? null;
    const failedState = CaptureRuntimeSnapshotSchema.parse({
      availableSources: this.#availableSources,
      lastInterruption: this.#lastInterruption,
      permissions: this.#permissions,
      protocolVersion: ATET_DESKTOP_PROTOCOL_VERSION,
      sources: this.#sources,
      state: {
        code: failure.code,
        message: failure.message,
        recordingId,
        recordingPath,
        sourceTimeUs: interruption?.sourceTimeUs
          ?? recovery.logicalTimeUs
          ?? this.#activeState?.sourceTimeUs
          ?? null,
        state: "failed",
      },
      updatedAt: this.#now().toISOString(),
    }).state;
    if (failedState.state !== "failed") {
      throw new RuntimeServiceError(
        "internal",
        "Fatal capture evidence did not produce a failed runtime state.",
        false,
      );
    }
    const controller = this.#activeController;
    this.#activeController = null;
    this.#activeState = null;
    this.#failedState = failedState;
    if (controller !== null) {
      try {
        await controller.close();
      } catch {
        // Recovery evidence is durable even if controller disposal also fails.
      }
    }
    return this.#snapshotFromState(failedState);
  }

  #materialFingerprint(snapshot: CaptureRuntimeSnapshot): string {
    const state = (() => {
      switch (snapshot.state.state) {
      case "recording":
      case "paused":
        return {
          recordingId: snapshot.state.recordingId,
          recordingPath: snapshot.state.recordingPath,
          state: snapshot.state.state,
        };
      case "stopping":
        return {
          commandId: snapshot.state.commandId,
          recordingId: snapshot.state.recordingId,
          recordingPath: snapshot.state.recordingPath,
          state: snapshot.state.state,
        };
      case "idle":
      case "starting":
      case "failed":
        return snapshot.state;
      }
    })();
    return JSON.stringify({
      availableSources: snapshot.availableSources,
      lastInterruption: snapshot.lastInterruption,
      permissions: snapshot.permissions,
      sources: snapshot.sources,
      state,
    });
  }

  async #publishSnapshotChanged(
    snapshot: CaptureRuntimeSnapshot,
    force = false,
  ): Promise<void> {
    const material = this.#materialFingerprint(snapshot);
    if (!force && material === this.#lastPublishedMaterial) return;
    await this.#publish({
      kind: "snapshot-changed",
      protocolVersion: ATET_DESKTOP_PROTOCOL_VERSION,
      snapshot,
    });
    this.#lastPublishedMaterial = material;
  }

  #scheduleWatch(): void {
    if (this.#closing || this.#watchTimer !== null) return;
    const timer = setTimeout(() => {
      this.#watchTimer = null;
      void this.#serialize(async () => {
        if (this.#closing || this.#activeController === null) return;
        try {
          const snapshot = await this.#snapshotNow();
          await this.#publishSnapshotChanged(snapshot);
        } catch {
          // A transient status failure must not stop later bounded polls.
        }
      }).finally(() => this.#scheduleWatch());
    }, this.#statusPollIntervalMs);
    timer.unref();
    this.#watchTimer = timer;
  }

  #serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#operationTail.then(operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #snapshotFromState(state: CaptureRuntimeSnapshot["state"]): CaptureRuntimeSnapshot {
    return CaptureRuntimeSnapshotSchema.parse({
      availableSources: this.#availableSources,
      lastInterruption: this.#lastInterruption,
      permissions: this.#permissions,
      protocolVersion: ATET_DESKTOP_PROTOCOL_VERSION,
      sources: this.#sources,
      state,
      updatedAt: this.#now().toISOString(),
    });
  }

  async #publish(event: DesktopEvent): Promise<void> {
    await this.#emit(DesktopEventSchema.parse(event));
  }
}

export async function resolveGatewayRepositoryRoot(value: string | undefined): Promise<string | null> {
  if (value === undefined || value.trim() === "") return null;
  if (!isAbsolute(value)) throw new Error("ATET_REPOSITORY_ROOT must be absolute.");
  const canonical = await realpath(value);
  if (!(await stat(canonical)).isDirectory()) {
    throw new Error("Configured Atet workspace is not a directory.");
  }
  return canonical;
}
