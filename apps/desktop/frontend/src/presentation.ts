import type {
  CaptureInterruption,
  CaptureRuntimeSnapshot,
  CaptureRuntimeState,
} from "../../contracts";

export type RecorderAction = "pause" | "resume" | "start" | "stop";

export interface RecorderPresentation {
  readonly allowedActions: readonly RecorderAction[];
  readonly elapsedUs: number;
  readonly label: string;
  readonly path: string | null;
  readonly tone: "active" | "failed" | "idle" | "pending";
}

export interface RecorderSourcePresentation {
  readonly audio: string;
  readonly camera: string;
  readonly displayCount: number;
  readonly displays: string;
  readonly metadata: string;
}

type PermissionState = CaptureRuntimeSnapshot["permissions"][keyof CaptureRuntimeSnapshot["permissions"]];

function unreachable(value: never): never {
  throw new Error(`Unknown recorder state: ${JSON.stringify(value)}`);
}

function interruptionReason(interruption: CaptureInterruption): string {
  switch (interruption.source) {
    case "screen":
      switch (interruption.code) {
        case "selected-display-disconnected":
          return "Selected display disconnected";
        case "screen-stream-stopped":
          return "Screen recording stopped";
        case "screen-recording-failed":
          return "Screen recording failed";
        default:
          return unreachable(interruption);
      }
    case "system-audio":
      return "System audio stopped";
    case "camera":
      switch (interruption.code) {
        case "camera-device-disconnected":
          return "Camera disconnected";
        case "camera-session-interrupted":
          return "Camera interrupted";
        case "camera-runtime-error":
        case "camera-recording-failed":
          return "Camera recording failed";
        case "camera-session-stopped":
          return "Camera stopped";
        default:
          return unreachable(interruption);
      }
    case "microphone":
      switch (interruption.code) {
        case "microphone-device-disconnected":
          return "Microphone disconnected";
        case "microphone-session-interrupted":
          return "Microphone interrupted";
        case "microphone-runtime-error":
        case "microphone-recording-failed":
          return "Microphone recording failed";
        case "microphone-session-stopped":
          return "Microphone stopped";
        default:
          return unreachable(interruption);
      }
    default:
      return unreachable(interruption);
  }
}

function failureWasSettledForRestart(code: string): boolean {
  switch (code) {
    case "capture-session-failed":
    case "selected-display-disconnected":
    case "screen-stream-stopped":
    case "screen-recording-failed":
    case "system-audio-track-missing":
    case "camera-device-disconnected":
    case "camera-session-interrupted":
    case "camera-runtime-error":
    case "camera-recording-failed":
    case "camera-session-stopped":
    case "microphone-device-disconnected":
    case "microphone-session-interrupted":
    case "microphone-runtime-error":
    case "microphone-recording-failed":
    case "microphone-session-stopped":
      return true;
    default:
      return false;
  }
}

function ownedFailureLabel(
  state: Extract<CaptureRuntimeState, { readonly state: "failed" }>,
  lastInterruption: CaptureInterruption | null,
): string {
  if (
    lastInterruption !== null
    && state.code === lastInterruption.code
  ) {
    return `${interruptionReason(lastInterruption)} — recording stopped`;
  }
  switch (state.code) {
    case "repository-not-configured":
      return "Transmute needs a configured Transmute checkout";
    case "invalid-recorder-state":
      return "The local recorder returned an invalid active state";
    case "capture-session-failed":
      return "The recording stopped after a local capture failure";
    case "capture-recovery-incomplete":
      return "Recording recovery incomplete — restart Transmute to record again";
    case "system-audio-track-missing":
      return "System audio missing — recording stopped";
    default:
      return "The local recording runtime failed";
  }
}

export function presentationForState(
  state: CaptureRuntimeState,
  lastInterruption: CaptureInterruption | null = null,
): RecorderPresentation {
  switch (state.state) {
    case "idle":
      return {
        allowedActions: ["start"],
        elapsedUs: state.lastRecording?.durationUs ?? 0,
        label: state.lastRecording === null ? "Ready to record" : "Recording saved",
        path: state.lastRecording?.recordingPath ?? null,
        tone: "idle",
      };
    case "starting":
      return {
        allowedActions: [],
        elapsedUs: 0,
        label: "Preparing every input…",
        path: state.recordingPath,
        tone: "pending",
      };
    case "recording":
      return {
        allowedActions: ["pause", "stop"],
        elapsedUs: state.sourceTimeUs,
        label: "Recording",
        path: state.recordingPath,
        tone: "active",
      };
    case "paused":
      return {
        allowedActions: ["resume", "stop"],
        elapsedUs: state.sourceTimeUs,
        label: lastInterruption === null
          ? "Paused — segment safely closed"
          : `${interruptionReason(lastInterruption)} — segment saved; resume when ready`,
        path: state.recordingPath,
        tone: "pending",
      };
    case "stopping":
      return {
        allowedActions: [],
        elapsedUs: state.sourceTimeUs,
        label: "Finalizing media and metadata…",
        path: state.recordingPath,
        tone: "pending",
      };
    case "failed":
      return {
        allowedActions: failureWasSettledForRestart(state.code)
          ? ["start"]
          : [],
        elapsedUs: state.sourceTimeUs ?? 0,
        label: ownedFailureLabel(state, lastInterruption),
        path: state.recordingPath,
        tone: "failed",
      };
    default:
      return unreachable(state);
  }
}

export function commandErrorMessage(
  code: string,
  action: RecorderAction,
): string {
  switch (code) {
    case "permissions_required":
      return "Grant screen, audio, camera, microphone, and metadata permissions before recording.";
    case "required_source_unavailable":
      return "A requested recording source is unavailable.";
    case "conflict":
      return "The recording command cannot run in the current recorder state.";
    case "unavailable":
      return "The local capture runtime is unavailable.";
    case "invalid-request":
      return "The recording request was rejected.";
    case "internal":
      return "The local recording runtime failed.";
    default:
      return `Could not ${action} recording.`;
  }
}

export function connectionErrorMessage(code: string | null): string {
  switch (code) {
    case "unavailable":
      return "The local capture runtime is unavailable.";
    case "internal":
      return "The local recording runtime failed.";
    case null:
      return "The local recorder is unavailable.";
    default:
      return "The local recorder is unavailable.";
  }
}

export function presentationForSnapshot(
  snapshot: CaptureRuntimeSnapshot,
): RecorderPresentation {
  return presentationForState(snapshot.state, snapshot.lastInterruption);
}

export function formatElapsed(microseconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(microseconds / 1_000_000));
  const hours = Math.floor(wholeSeconds / 3_600);
  const minutes = Math.floor((wholeSeconds % 3_600) / 60);
  const seconds = wholeSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function unavailableSourceMessages(snapshot: CaptureRuntimeSnapshot): readonly string[] {
  const expected: readonly [keyof CaptureRuntimeSnapshot["permissions"], string][] = [
    ["screenCapture", "Screen recording"],
    ["systemAudio", "System audio"],
    ["microphone", "Microphone"],
    ["camera", "Camera"],
    ["inputMonitoring", "Clicks and key activity"],
    ["accessibility", "Focused-input metadata"],
    ["windowMetadata", "Window metadata"],
  ];
  return expected.flatMap(([permission, label]) => {
    const state = snapshot.permissions[permission];
    return state === "authorized" ? [] : [`${label}: ${state.replaceAll("-", " ")}`];
  });
}

function permissionText(state: PermissionState): string {
  return state.replaceAll("-", " ");
}

function sourceText(
  label: string,
  permission: PermissionState,
  available: readonly string[],
): string {
  if (permission !== "authorized") return `${label} (${permissionText(permission)})`;
  return available.length === 0 ? `${label} (not found)` : available.join(" · ");
}

function usesSelectedSources(snapshot: CaptureRuntimeSnapshot): boolean {
  switch (snapshot.state.state) {
    case "recording":
    case "paused":
    case "stopping":
      return true;
    case "failed":
      return snapshot.state.recordingId !== null;
    case "idle":
    case "starting":
      return false;
    default:
      return unreachable(snapshot.state);
  }
}

function visibleSourceLabels(
  selected: readonly { readonly id: string; readonly label: string }[],
  available: readonly { readonly id: string; readonly label: string }[],
  selectedSourcesAreAuthoritative: boolean,
): readonly string[] {
  if (!selectedSourcesAreAuthoritative) {
    return selected.map(({ label }) => label);
  }
  const availableIds = new Set(available.map(({ id }) => id));
  const selectedIds = new Set(selected.map(({ id }) => id));
  const newlyAvailable = available
    .filter(({ id }) => !selectedIds.has(id))
    .map(({ label }) => label);
  return [
    ...selected.map(({ id, label }) =>
      availableIds.has(id) ? label : `${label} (not available now)`
    ),
    ...(newlyAvailable.length === 0
      ? []
      : [`Available now: ${newlyAvailable.join(" · ")}`]),
  ];
}

export function sourcePresentation(snapshot: CaptureRuntimeSnapshot): RecorderSourcePresentation {
  const selectedSourcesAreAuthoritative = usesSelectedSources(snapshot);
  const visibleSources = selectedSourcesAreAuthoritative
    ? snapshot.sources
    : snapshot.availableSources;
  const systemAudio = visibleSourceLabels(
    visibleSources.audioSources
    .filter(({ kind }) => kind === "system")
    .map(({ id, label }) => ({ id, label })),
    snapshot.availableSources.audioSources.filter(({ kind }) => kind === "system"),
    selectedSourcesAreAuthoritative,
  );
  const microphones = visibleSourceLabels(
    visibleSources.audioSources
    .filter(({ kind }) => kind === "microphone")
    .map(({ id, label }) => ({ id, label })),
    snapshot.availableSources.audioSources.filter(({ kind }) => kind === "microphone"),
    selectedSourcesAreAuthoritative,
  );
  const metadata = [
    sourceText("Windows", snapshot.permissions.windowMetadata, ["Windows"]),
    sourceText("Cursor and clicks", snapshot.permissions.inputMonitoring, ["Cursor and clicks"]),
    sourceText("Focus", snapshot.permissions.accessibility, ["Focus"]),
  ];
  return {
    audio: [
      sourceText("System audio", snapshot.permissions.systemAudio, systemAudio),
      sourceText("Microphone", snapshot.permissions.microphone, microphones),
    ].join(" · "),
    camera: sourceText(
      "Camera",
      snapshot.permissions.camera,
      visibleSourceLabels(
        visibleSources.cameras,
        snapshot.availableSources.cameras,
        selectedSourcesAreAuthoritative,
      ),
    ),
    displayCount: snapshot.availableSources.displays.length,
    displays: sourceText(
      "Displays",
      snapshot.permissions.screenCapture,
      visibleSourceLabels(
        visibleSources.displays,
        snapshot.availableSources.displays,
        selectedSourcesAreAuthoritative,
      ),
    ),
    metadata: metadata.join(" · "),
  };
}
