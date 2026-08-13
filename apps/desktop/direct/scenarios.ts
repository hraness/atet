import { defineDirect } from "@hraness/direct";

import {
  ALL_INPUT_SOURCES,
  AUTHORIZED_PERMISSIONS,
  TRANSMUTE_DIRECT_TIME_MS,
  createTransmuteDirectWorld,
  fixtureIdleSnapshot,
  fixturePausedSnapshot,
  fixtureRecordingSnapshot,
  parseTransmuteDirectWorld,
  runtimeSnapshot,
} from "./world";

export type TransmuteDirectRoute = "/";
export type TransmuteDirectViewport = "compact" | "wide";

export interface TransmuteScenarioMetadata {
  readonly focus: "analysis" | "capture" | "overlays" | "project" | "workflow";
  readonly group: "Analysis" | "Capture" | "Editing" | "Permissions" | "Recovery" | "Workflows";
  readonly viewport: TransmuteDirectViewport;
}

const recording = fixtureRecordingSnapshot();
const paused = fixturePausedSnapshot();
const finalized = fixtureIdleSnapshot(true);
const idle = fixtureIdleSnapshot(false);

const permissionPrompt = runtimeSnapshot(
  { lastRecording: null, state: "idle" },
  {
    permissions: {
      accessibility: "not-determined",
      camera: "not-determined",
      inputMonitoring: "not-determined",
      microphone: "not-determined",
      screenCapture: "not-determined",
      systemAudio: "not-determined",
      windowMetadata: "not-determined",
    },
    availableSources: { audioSources: [], cameras: [], displays: [] },
  },
);

const permissionDenied = runtimeSnapshot(
  { lastRecording: null, state: "idle" },
  {
    permissions: {
      ...AUTHORIZED_PERMISSIONS,
      camera: "denied",
      microphone: "denied",
    },
    availableSources: {
      audioSources: ALL_INPUT_SOURCES.audioSources.filter(({ kind }) => kind === "system"),
      cameras: [],
      displays: [...ALL_INPUT_SOURCES.displays],
    },
  },
);

const cameraDisconnection = {
  code: "camera-device-disconnected",
  nativeTimeUs: 118_000_000,
  recoverable: true,
  segmentIndex: 0,
  source: "camera",
  sourceId: "camera_facetime01",
  sourceTimeUs: 18_000_000,
} as const;

const partialSourceFailure = runtimeSnapshot(
  paused.state,
  {
    availableSources: {
      audioSources: [...ALL_INPUT_SOURCES.audioSources],
      cameras: [],
      displays: [...ALL_INPUT_SOURCES.displays],
    },
    lastInterruption: cameraDisconnection,
  },
);
const resumedAfterSourceFailure = runtimeSnapshot(
  fixtureRecordingSnapshot(18_000_000).state,
  { lastInterruption: cameraDisconnection },
);

const failed = runtimeSnapshot({
  code: "capture-session-failed",
  message: "Capture helper stopped before a recording was created.",
  recordingId: null,
  recordingPath: null,
  sourceTimeUs: null,
  state: "failed",
});

const scenarioInputs = [
  {
    description: "The real recorder is ready, local, and defaults to every available input.",
    id: "idle-ready",
    route: "/",
    title: "Ready to record",
    world: createTransmuteDirectWorld({
      initial: idle,
      transitions: [{ command: "start", outcome: { kind: "success", snapshot: recording } }],
    }),
  },
  {
    description: "Every permission is unresolved and source discovery remains fail-closed.",
    id: "permission-prompt",
    route: "/",
    title: "Permission prompts",
    world: createTransmuteDirectWorld({
      initial: permissionPrompt,
      transitions: [{
        command: "start",
        outcome: {
          code: "permissions_required",
          kind: "error",
          message: "Grant screen, audio, camera, microphone, and metadata permissions before recording.",
          retryable: true,
          snapshot: permissionPrompt,
        },
      }],
    }),
  },
  {
    description: "Camera and microphone denial is visible without pretending those tracks exist.",
    id: "permission-denied",
    route: "/",
    title: "Optional inputs denied",
    world: createTransmuteDirectWorld({
      initial: permissionDenied,
      transitions: [{
        command: "start",
        outcome: {
          code: "required_source_unavailable",
          kind: "error",
          message: "Requested microphone access is denied.",
          retryable: true,
          snapshot: permissionDenied,
        },
      }],
    }),
  },
  {
    description: "Displays, system audio, microphone, camera, and metadata record together.",
    id: "all-input-recording",
    route: "/",
    title: "All-input recording",
    world: createTransmuteDirectWorld({
      initial: recording,
      transitions: [
        { command: "pause", outcome: { kind: "success", snapshot: paused } },
        { command: "resume", outcome: { kind: "success", snapshot: fixtureRecordingSnapshot(18_000_000) } },
        { command: "stop", outcome: { kind: "success", snapshot: finalized } },
      ],
    }),
  },
  {
    description: "Both the built-in and extended display remain visible as independent tracks.",
    id: "multiple-displays",
    route: "/",
    title: "Extended displays",
    world: createTransmuteDirectWorld({ initial: recording, transitions: [] }),
  },
  {
    description: "Pause closes a segment, resume opens another, and source time remains monotonic.",
    id: "pause-resume",
    route: "/",
    title: "Paused segment",
    world: createTransmuteDirectWorld({
      initial: paused,
      transitions: [
        { command: "resume", outcome: { kind: "success", snapshot: fixtureRecordingSnapshot(18_000_000) } },
        { command: "pause", outcome: { kind: "success", snapshot: fixturePausedSnapshot(24_000_000) } },
        { command: "stop", outcome: { kind: "success", snapshot: finalized } },
      ],
    }),
  },
  {
    description: "A live recording receives an autonomous camera-disconnection push, preserves the synchronized segment, and waits for explicit recovery.",
    id: "partial-source-failure",
    route: "/",
    title: "Camera disconnected",
    world: createTransmuteDirectWorld({
      initial: recording,
      pushes: [{
        after: "initial-snapshot",
        snapshot: partialSourceFailure,
      }],
      transitions: [
        {
          command: "resume",
          outcome: {
            kind: "success",
            snapshot: resumedAfterSourceFailure,
          },
        },
        {
          command: "stop",
          outcome: { kind: "success", snapshot: finalized },
        },
      ],
    }),
  },
  {
    description: "The finalized bundle reports its stable local path, duration, and recording ID.",
    id: "stop-finalized",
    route: "/",
    title: "Recording finalized",
    world: createTransmuteDirectWorld({ initial: finalized, transitions: [] }),
  },
  {
    description: "A settled capture failure can recover through a new production start action.",
    id: "failed-recovery",
    route: "/",
    title: "Failed then recovered",
    world: createTransmuteDirectWorld({
      initial: failed,
      transitions: [{ command: "start", outcome: { kind: "success", snapshot: recording } }],
    }),
  },
  {
    description: "One synchronized project exposes accepted audio alignment, manual camera motion, and local multi-face following.",
    id: "multi-asset-project",
    route: "/",
    title: "Synchronized multi-angle project",
    world: createTransmuteDirectWorld({ initial: finalized, transitions: [] }),
  },
  {
    description: "Local boundaries, compact scene descriptions, music structure, and filler safety stay inspectable without external execution.",
    id: "agent-analysis-ledger",
    route: "/",
    title: "Agent analysis ledger",
    world: createTransmuteDirectWorld({ initial: finalized, transitions: [] }),
  },
  {
    description: "A compiled code workflow exposes exact waves, parallel analysis, trusted computation, durable failure, scoped replay, and graph-bound run outputs.",
    id: "code-mode-workflow",
    route: "/",
    title: "Agent code-mode workflow",
    world: createTransmuteDirectWorld({ initial: finalized, transitions: [] }),
  },
  {
    description: "Image, SVG, GIF, video, and emoji layers expose composition, animation, playback, and audio controls.",
    id: "overlay-compositor",
    route: "/",
    title: "Overlay compositor controls",
    world: createTransmuteDirectWorld({ initial: finalized, transitions: [] }),
  },
] as const;

const coverage = [
  { claim: "Idle exposes one legal start action and the ignored recording root.", key: "runtime.idle", mode: "mixed", scenarios: ["idle-ready"] },
  { claim: "Unresolved permissions remain visible and block recording.", key: "permissions.prompt", mode: "fixture", scenarios: ["permission-prompt"] },
  { claim: "Denied optional inputs are not represented as active sources.", key: "permissions.denied", mode: "fixture", scenarios: ["permission-denied"] },
  { claim: "The default recording includes every useful source class.", key: "capture.all-input", mode: "mixed", scenarios: ["all-input-recording"] },
  { claim: "Extended displays are represented independently.", key: "capture.multidisplay", mode: "fixture", scenarios: ["multiple-displays"] },
  { claim: "Pause and resume preserve segmented source time.", key: "capture.pause-resume", mode: "mixed", scenarios: ["pause-resume", "all-input-recording"] },
  { claim: "An autonomous interrupted-pause push preserves the selected camera, shows its fresh absence, and requires explicit resume.", key: "capture.partial-source-failure", mode: "mixed", scenarios: ["partial-source-failure"] },
  { claim: "A completed Stop returns an idle snapshot with stable recording ID, path, and duration evidence.", key: "capture.finalization", mode: "mixed", scenarios: ["stop-finalized", "all-input-recording"] },
  { claim: "A settled capture failure can recover through a new start command.", key: "runtime.recovery", mode: "mixed", scenarios: ["failed-recovery"] },
  { claim: "Fixtures expose cursor, click, typing, and moving-window metadata.", key: "metadata.agent-visibility", mode: "fixture", scenarios: ["all-input-recording", "multiple-displays"] },
  { claim: "Fixtures expose bounded freeze and silence analyzer findings.", key: "analyzer.freeze-silence", mode: "fixture", scenarios: ["all-input-recording"] },
  { claim: "Fixtures expose cut, zoom, and speed edit operations.", key: "edit.cut-zoom-speed", mode: "fixture", scenarios: ["all-input-recording"] },
  { claim: "Fixtures expose image, SVG, GIF, video, and emoji overlays.", key: "overlays.all-kinds", mode: "fixture", scenarios: ["all-input-recording"] },
  { claim: "One project clock carries a screen plus two independent camera/video-and-audio placements.", key: "project.multi-asset-clock", mode: "fixture", scenarios: ["multi-asset-project"] },
  { claim: "Audio alignment retains ranked candidates and the accepted candidate is traceable to each applied sync map.", key: "alignment.candidates-accepted", mode: "fixture", scenarios: ["multi-asset-project"] },
  { claim: "Cuts and speed ranges live on project time and therefore apply to every synchronized placement.", key: "edit.global-synchronization", mode: "fixture", scenarios: ["multi-asset-project"] },
  { claim: "A manual two-keyframe camera move exposes Ken Burns-style digital pan and zoom through production camera contracts.", key: "camera.manual-pan-zoom", mode: "fixture", scenarios: ["multi-asset-project"] },
  { claim: "A production-planned face move retains explicit multi-face selection, require-all behavior, and hold-then-fallback gap provenance.", key: "camera.face-follow-provenance", mode: "fixture", scenarios: ["multi-asset-project"] },
  { claim: "Face analysis stays local and stores only bounding boxes with geometry-continuity track IDs; biometric identification is not performed.", key: "camera.face-local-privacy", mode: "fixture", scenarios: ["multi-asset-project"] },
  { claim: "Music evidence exposes presence, regional tempo, a tempo change, and musical key.", key: "analysis.music-structure", mode: "fixture", scenarios: ["agent-analysis-ledger"] },
  { claim: "PySceneDetect is named only as a compatible reference for local fixture boundaries; Direct requires neither Python nor cloud execution.", key: "analysis.scene-local-boundary", mode: "fixture", scenarios: ["agent-analysis-ledger"] },
  { claim: "Selected screen and camera frames carry compact, explicitly untrusted fixture descriptions.", key: "analysis.scene-descriptions", mode: "fixture", scenarios: ["agent-analysis-ledger"] },
  { claim: "Speech evidence distinguishes a safe synchronized filler cut from contextual and music-protected speech.", key: "analysis.filler-safety", mode: "fixture", scenarios: ["agent-analysis-ledger"] },
  { claim: "All overlay kinds expose fit, crop, mask, blend, motion, entrance/exit, playback, audio policy, and emoji-set controls.", key: "overlays.full-controls", mode: "fixture", scenarios: ["overlay-compositor"] },
  { claim: "The visible workflow graph is compiled through the production registry and compiler.", key: "workflow.production-graph", mode: "fixture", scenarios: ["code-mode-workflow"] },
  { claim: "Independent local analysis nodes share a topological wave and remain available for parallel scheduling.", key: "workflow.parallel-waves", mode: "fixture", scenarios: ["code-mode-workflow"] },
  { claim: "An interrupted trusted-code node requires an exact, attempt-scoped replay command before downstream work resumes.", key: "workflow.explicit-recovery", mode: "fixture", scenarios: ["code-mode-workflow"] },
  { claim: "Completed workflow evidence binds the production run outputs document to its exact graph-plan and output digests.", key: "workflow.bound-outputs", mode: "fixture", scenarios: ["code-mode-workflow"] },
  { claim: "Native capture behavior is proven by Swift protocol and build tests, not browser fixtures.", key: "native.capture.direct", mode: "direct", scenarios: [] },
  { claim: "Packaged Zig bridge, signatures, and resources require direct binary evidence.", key: "native.bundle.direct", mode: "direct", scenarios: [] },
] as const;

export const transmuteDirect = defineDirect({
  coverage,
  defaultScenario: "idle-ready",
  parseWorld: parseTransmuteDirectWorld,
  scenarios: scenarioInputs,
});

export const transmuteScenarioCatalog = transmuteDirect.scenarios;
export const transmuteCoverageCatalog = transmuteDirect.coverage;

export const transmuteScenarioMetadata: Readonly<Record<string, TransmuteScenarioMetadata>> = Object.freeze({
  "agent-analysis-ledger": { focus: "analysis", group: "Analysis", viewport: "wide" },
  "all-input-recording": { focus: "capture", group: "Capture", viewport: "wide" },
  "code-mode-workflow": { focus: "workflow", group: "Workflows", viewport: "wide" },
  "failed-recovery": { focus: "capture", group: "Recovery", viewport: "compact" },
  "idle-ready": { focus: "capture", group: "Capture", viewport: "compact" },
  "multi-asset-project": { focus: "project", group: "Editing", viewport: "wide" },
  "multiple-displays": { focus: "capture", group: "Capture", viewport: "wide" },
  "overlay-compositor": { focus: "overlays", group: "Editing", viewport: "wide" },
  "partial-source-failure": { focus: "capture", group: "Recovery", viewport: "compact" },
  "pause-resume": { focus: "capture", group: "Capture", viewport: "compact" },
  "permission-denied": { focus: "capture", group: "Permissions", viewport: "compact" },
  "permission-prompt": { focus: "capture", group: "Permissions", viewport: "compact" },
  "stop-finalized": { focus: "capture", group: "Editing", viewport: "compact" },
});

export const TRANSMUTE_DIRECT_NOW_MS = TRANSMUTE_DIRECT_TIME_MS;
