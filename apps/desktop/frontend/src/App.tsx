import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button, Disclosure } from "./ui";

import {
  CaptureRuntimeSnapshotSchema,
  TRANSMUTE_DESKTOP_PROTOCOL_VERSION,
  type CaptureDomainCommand,
  type CaptureRuntimeSnapshot,
} from "../../contracts";
import {
  commandErrorMessage,
  connectionErrorMessage,
  formatElapsed,
  presentationForSnapshot,
  sourcePresentation,
  unavailableSourceMessages,
  type RecorderAction,
} from "./presentation";
import {
  RuntimeBridgeCommandError,
  type RuntimeBridge,
} from "./runtime-bridge";
import {
  beginCommandFlight,
  markCommandFlight,
  type CommandFlight,
  type CommandFlightPart,
} from "./command-flight";

const EMPTY_SNAPSHOT = CaptureRuntimeSnapshotSchema.parse({
  availableSources: { audioSources: [], cameras: [], displays: [] },
  lastInterruption: null,
  permissions: {
    accessibility: "not-determined",
    camera: "not-determined",
    inputMonitoring: "not-determined",
    microphone: "not-determined",
    screenCapture: "not-determined",
    systemAudio: "not-determined",
    windowMetadata: "not-determined",
  },
  protocolVersion: TRANSMUTE_DESKTOP_PROTOCOL_VERSION,
  sources: { audioSources: [], cameras: [], displays: [] },
  state: { lastRecording: null, state: "idle" },
  updatedAt: "1970-01-01T00:00:00.000Z",
});

export interface AppProps {
  readonly bridge: RuntimeBridge | null;
  readonly now?: () => number;
}

function commandId(): string {
  return `command_${crypto.randomUUID().replaceAll("-", "")}`;
}

function commandFor(action: RecorderAction): CaptureDomainCommand {
  const id = commandId();
  if (action !== "start") return { commandId: id, kind: action };
  return {
    commandId: id,
    kind: "start",
    options: {
      camera: { kind: "default" },
      displays: { kind: "all" },
      microphone: { kind: "default" },
      recordingDirectory: "artifacts/transmute/recordings",
      systemAudio: true,
      typedText: "disabled",
      windowMetadata: "titles-and-bounds",
    },
  };
}

function sourceLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

export default function App({ bridge, now = Date.now }: AppProps) {
  const [snapshot, setSnapshot] = useState<CaptureRuntimeSnapshot>(EMPTY_SNAPSHOT);
  const [connection, setConnection] = useState<"connecting" | "failed" | "ready">("connecting");
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState(now());
  const [pendingCommandId, setPendingCommandId] = useState<string | null>(null);
  const commandFlight = useRef<CommandFlight | null>(null);
  const mounted = useRef(true);

  const markCommandPart = useCallback((
    commandIdValue: string,
    part: CommandFlightPart,
  ) => {
    const next = markCommandFlight(
      commandFlight.current,
      commandIdValue,
      part,
    );
    commandFlight.current = next;
    if (next === null && mounted.current) setPendingCommandId(null);
  }, []);

  const refresh = useCallback(async () => {
    if (bridge === null) {
      setConnection("failed");
      setError("Open the native macOS app to use the recorder.");
      return;
    }
    try {
      const next = await bridge.snapshot();
      if (!mounted.current) return;
      setSnapshot(next);
      setConnection("ready");
      setError(null);
    } catch (reason: unknown) {
      if (!mounted.current) return;
      setConnection("failed");
      setError(connectionErrorMessage(
        reason instanceof RuntimeBridgeCommandError ? reason.code : null,
      ));
    }
  }, [bridge]);

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = bridge?.subscribe({
      onEvent(event) {
        if (event.kind === "snapshot-changed") {
          setSnapshot(event.snapshot);
          setConnection("ready");
          setError(null);
        } else {
          markCommandPart(event.commandId, "settlement");
        }
      },
      onMalformedEvent() {
        const pending = commandFlight.current;
        if (pending !== null) {
          markCommandPart(pending.commandId, "settlement");
        }
        void refresh();
      },
    }) ?? (() => undefined);
    void refresh();
    const interval = window.setInterval(() => setClock(now()), 250);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      mounted.current = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      unsubscribe();
    };
  }, [bridge, markCommandPart, now, refresh]);

  const presentation = useMemo(
    () => presentationForSnapshot(snapshot),
    [snapshot],
  );
  const elapsedUs = presentation.elapsedUs + (
    snapshot.state.state === "recording"
      ? Math.max(0, clock - Date.parse(snapshot.updatedAt)) * 1_000
      : 0
  );
  const permissionMessages = unavailableSourceMessages(snapshot);
  const sourceStatus = sourcePresentation(snapshot);
  const primaryAction = presentation.allowedActions.includes("pause")
    ? "pause"
    : presentation.allowedActions.includes("resume")
    ? "resume"
    : null;
  const controlsDisabled = connection !== "ready" || pendingCommandId !== null;

  const dispatch = useCallback(async (action: RecorderAction) => {
    if (bridge === null || !presentation.allowedActions.includes(action)) return;
    const command = commandFor(action);
    const begun = beginCommandFlight(commandFlight.current, command.commandId);
    if (!begun.started) return;
    commandFlight.current = begun.flight;
    setPendingCommandId(command.commandId);
    setError(null);
    try {
      setSnapshot(await bridge.dispatch(command));
      setConnection("ready");
    } catch (reason: unknown) {
      const message = reason instanceof RuntimeBridgeCommandError
        ? commandErrorMessage(reason.code, action)
        : commandErrorMessage("unknown", action);
      if (!(reason instanceof RuntimeBridgeCommandError)) {
        markCommandPart(command.commandId, "settlement");
      }
      await refresh();
      if (mounted.current) setError(message);
    } finally {
      markCommandPart(command.commandId, "response");
    }
  }, [bridge, markCommandPart, presentation.allowedActions, refresh]);

  return (
    <main className="recorder-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Transmute</p>
          <h1>Raw capture</h1>
        </div>
        <span className="local-badge">Local only</span>
      </header>

      <section className="recording-card" data-tone={presentation.tone}>
        <div aria-atomic="true" aria-live="polite" className="status-row" role="status">
          <span aria-hidden="true" className="status-dot" />
          <strong>{connection === "connecting" ? "Connecting…" : presentation.label}</strong>
        </div>
        <p aria-label={`Elapsed time ${formatElapsed(elapsedUs)}`} className="elapsed">{formatElapsed(elapsedUs)}</p>
        <p className="recording-path">{presentation.path ?? "artifacts/transmute/recordings/"}</p>

        <div
          aria-busy={pendingCommandId !== null}
          aria-label="Recording controls"
          className="controls"
          data-command-pending={pendingCommandId ?? "none"}
          role="group"
        >
          {presentation.allowedActions.includes("start") ? (
            <Button isDisabled={controlsDisabled} onPress={() => void dispatch("start")} type="button" variant="primary">
              Start recording
            </Button>
          ) : null}
          {primaryAction === null ? null : (
            <Button isDisabled={controlsDisabled} onPress={() => void dispatch(primaryAction)} type="button" variant="primary">
              {primaryAction === "pause" ? "Pause" : "Resume"}
            </Button>
          )}
          {presentation.allowedActions.includes("stop") ? (
            <Button isDisabled={controlsDisabled} onPress={() => void dispatch("stop")} type="button" variant="secondary">Stop</Button>
          ) : null}
        </div>
        {error === null ? null : <p className="error-message" role="alert">{error}</p>}
      </section>

      <section aria-labelledby="inputs-heading" className="inputs-card">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Default capture</p>
            <h2 id="inputs-heading">Every useful input</h2>
          </div>
          <span>{sourceLabel(sourceStatus.displayCount, "display")}</span>
        </div>
        <ul className="source-list">
          <li><span>Displays</span><strong>{sourceStatus.displays}</strong></li>
          <li><span>Audio</span><strong>{sourceStatus.audio}</strong></li>
          <li><span>Camera</span><strong>{sourceStatus.camera}</strong></li>
          <li><span>Metadata</span><strong>{sourceStatus.metadata}</strong></li>
        </ul>
        <p className="privacy-note">Typed text is off by default. Secure fields are never recorded.</p>
      </section>

      {permissionMessages.length === 0 ? null : (
        <Disclosure
          className="permissions-card"
          title={`${permissionMessages.length} permission${permissionMessages.length === 1 ? " needs" : "s need"} attention`}
        >
          <ul>{permissionMessages.map((message) => <li key={message}>{message}</li>)}</ul>
        </Disclosure>
      )}
    </main>
  );
}
