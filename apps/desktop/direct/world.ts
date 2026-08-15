import { z } from "zod";
import { cloneJson } from "@hraness/direct/core";

import {
  type CaptureRuntimeStateSchema,
  CaptureRuntimeSnapshotSchema,
  ATET_DESKTOP_PROTOCOL_VERSION,
} from "../contracts";
import {
  createProjectEvidence,
  ProjectEvidenceSchema,
  type ProjectEvidence,
} from "./project-fixtures";
import {
  createWorkflowEvidence,
  WorkflowEvidenceSchema,
  type WorkflowEvidence,
} from "./workflow-fixtures";

export const ATET_DIRECT_WORLD_VERSION = 6 as const;
export const ATET_DIRECT_TIME_MS = Date.UTC(2026, 6, 22, 16, 0, 0);
export const ATET_DIRECT_TIMESTAMP = new Date(ATET_DIRECT_TIME_MS).toISOString();
export const ATET_FIXTURE_RECORDING_ID = "rec_demo0001";
export const ATET_FIXTURE_RECORDING_PATH = "artifacts/atet/recordings/rec_demo0001";

const TIME_RANGE_SHAPE = {
  endUs: z.number().int().safe().positive(),
  startUs: z.number().int().safe().nonnegative(),
} as const;

const AnalyzerEvidenceSchema = z.strictObject({
  ...TIME_RANGE_SHAPE,
  confidence: z.number().finite().min(0).max(1),
  kind: z.enum(["freeze", "silence"]),
});

const MetadataEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    displayId: z.string().min(1),
    kind: z.literal("cursor"),
    timeUs: z.number().int().safe().nonnegative(),
    x: z.number().finite(),
    y: z.number().finite(),
  }),
  z.strictObject({
    button: z.enum(["left", "right", "other"]),
    displayId: z.string().min(1),
    kind: z.literal("click"),
    timeUs: z.number().int().safe().nonnegative(),
    x: z.number().finite(),
    y: z.number().finite(),
  }),
  z.strictObject({
    capturedText: z.string().max(160).nullable(),
    kind: z.literal("typing"),
    phase: z.enum(["started", "updated", "stopped"]),
    secureField: z.boolean(),
    timeUs: z.number().int().safe().nonnegative(),
  }),
  z.strictObject({
    bounds: z.strictObject({
      height: z.number().finite().positive(),
      width: z.number().finite().positive(),
      x: z.number().finite(),
      y: z.number().finite(),
    }),
    displayId: z.string().min(1),
    kind: z.literal("window"),
    timeUs: z.number().int().safe().nonnegative(),
    title: z.string().min(1).max(160),
    windowId: z.string().min(1),
  }),
]);

const EditEvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...TIME_RANGE_SHAPE, kind: z.literal("cut"), reason: z.enum(["freeze", "silence", "manual"]) }),
  z.strictObject({
    ...TIME_RANGE_SHAPE,
    easing: z.enum(["linear", "ease-in-out"]),
    kind: z.literal("zoom"),
    target: z.enum(["cursor", "window", "manual"]),
  }),
  z.strictObject({ ...TIME_RANGE_SHAPE, factor: z.number().finite().positive().max(16), kind: z.literal("speed") }),
]);

const OverlayEvidenceSchema = z.strictObject({
  ...TIME_RANGE_SHAPE,
  asset: z.string().min(1).max(256),
  id: z.string().regex(/^overlay_[a-z0-9_-]{8,64}$/u),
  kind: z.enum(["image", "svg", "gif", "video", "emoji"]),
  zIndex: z.number().int().safe().min(-1024).max(1024),
});

const TransitionOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("success"), snapshot: CaptureRuntimeSnapshotSchema }),
  z.strictObject({
    code: z.string().min(1).max(128),
    kind: z.literal("error"),
    message: z.string().min(1).max(2048),
    retryable: z.boolean(),
    snapshot: CaptureRuntimeSnapshotSchema,
  }),
]);

const RuntimeTransitionSchema = z.strictObject({
  command: z.enum(["start", "pause", "resume", "stop"]),
  outcome: TransitionOutcomeSchema,
});

const RuntimePushSchema = z.strictObject({
  after: z.literal("initial-snapshot"),
  snapshot: CaptureRuntimeSnapshotSchema,
});

export const AtetDirectWorldSchema = z.strictObject({
  editEvidence: z.strictObject({
    analyzer: z.array(AnalyzerEvidenceSchema).max(64),
    edits: z.array(EditEvidenceSchema).max(64),
    metadata: z.array(MetadataEvidenceSchema).max(256),
    overlays: z.array(OverlayEvidenceSchema).max(64),
  }),
  runtime: z.strictObject({
    initial: CaptureRuntimeSnapshotSchema,
    pushes: z.array(RuntimePushSchema).max(8).default([]),
    transitions: z.array(RuntimeTransitionSchema).max(32),
  }),
  projectEvidence: ProjectEvidenceSchema,
  version: z.literal(ATET_DIRECT_WORLD_VERSION),
  workflowEvidence: WorkflowEvidenceSchema,
});

type JsonWorldValue<Value> = Value extends boolean | null | number | string
  ? Value
  : Value extends readonly (infer Item)[]
    ? JsonWorldValue<Item>[]
    : Value extends object
      ? { [Key in keyof Value]: JsonWorldValue<Value[Key]> }
      : never;

export type AtetDirectWorld = JsonWorldValue<z.infer<typeof AtetDirectWorldSchema>>;
export type AtetDirectWorldInput = z.input<typeof AtetDirectWorldSchema>;

export const AUTHORIZED_PERMISSIONS = Object.freeze({
  accessibility: "authorized",
  camera: "authorized",
  inputMonitoring: "authorized",
  microphone: "authorized",
  screenCapture: "authorized",
  systemAudio: "authorized",
  windowMetadata: "authorized",
} as const);

export const ALL_INPUT_SOURCES = Object.freeze({
  audioSources: [
    { id: "audio_system01", kind: "system", label: "Mac system audio" },
    { id: "audio_microphone01", kind: "microphone", label: "Atet microphone" },
  ],
  cameras: [{ id: "camera_facetime01", label: "FaceTime HD Camera" }],
  displays: [
    { id: "display_builtin01", isPrimary: true, label: "Built-in display" },
    { id: "display_atet01", isPrimary: false, label: "Atet Display" },
  ],
} as const);

export const EMPTY_INPUT_SOURCES = Object.freeze({
  audioSources: [],
  cameras: [],
  displays: [],
} as const);

export function runtimeSnapshot(
  state: z.input<typeof CaptureRuntimeStateSchema>,
  overrides: Partial<Pick<
    z.input<typeof CaptureRuntimeSnapshotSchema>,
    "availableSources" | "lastInterruption" | "permissions" | "sources" | "updatedAt"
  >> = {},
) {
  const hasSelectedSources = state.state === "recording"
    || state.state === "paused"
    || state.state === "stopping"
    || (state.state === "idle" && state.lastRecording !== null)
    || (state.state === "failed" && state.recordingId !== null);
  return CaptureRuntimeSnapshotSchema.parse({
    availableSources: overrides.availableSources ?? ALL_INPUT_SOURCES,
    lastInterruption: overrides.lastInterruption ?? null,
    permissions: overrides.permissions ?? AUTHORIZED_PERMISSIONS,
    protocolVersion: ATET_DESKTOP_PROTOCOL_VERSION,
    sources: overrides.sources ?? (
      hasSelectedSources ? ALL_INPUT_SOURCES : EMPTY_INPUT_SOURCES
    ),
    state,
    updatedAt: overrides.updatedAt ?? ATET_DIRECT_TIMESTAMP,
  });
}

export function fixtureIdleSnapshot(lastRecording: boolean) {
  return runtimeSnapshot({
    lastRecording: lastRecording
      ? {
          durationUs: 42_000_000,
          recordingId: ATET_FIXTURE_RECORDING_ID,
          recordingPath: ATET_FIXTURE_RECORDING_PATH,
        }
      : null,
    state: "idle",
  });
}

export function fixtureRecordingSnapshot(sourceTimeUs = 12_500_000) {
  return runtimeSnapshot({
    recordingId: ATET_FIXTURE_RECORDING_ID,
    recordingPath: ATET_FIXTURE_RECORDING_PATH,
    sourceTimeUs,
    state: "recording",
  });
}

export function fixturePausedSnapshot(sourceTimeUs = 18_000_000) {
  return runtimeSnapshot({
    recordingId: ATET_FIXTURE_RECORDING_ID,
    recordingPath: ATET_FIXTURE_RECORDING_PATH,
    sourceTimeUs,
    state: "paused",
  });
}

export function fullEditEvidence(): AtetDirectWorld["editEvidence"] {
  return {
    analyzer: [
      { confidence: 0.99, endUs: 9_000_000, kind: "freeze", startUs: 4_000_000 },
      { confidence: 0.96, endUs: 28_000_000, kind: "silence", startUs: 22_000_000 },
    ],
    edits: [
      { endUs: 9_000_000, kind: "cut", reason: "freeze", startUs: 4_000_000 },
      { easing: "ease-in-out", endUs: 16_000_000, kind: "zoom", startUs: 11_000_000, target: "window" },
      { endUs: 22_000_000, factor: 2, kind: "speed", startUs: 18_000_000 },
    ],
    metadata: [
      { displayId: "display_builtin01", kind: "cursor", timeUs: 10_000_000, x: 612, y: 404 },
      { button: "left", displayId: "display_builtin01", kind: "click", timeUs: 10_300_000, x: 630, y: 418 },
      { capturedText: "ship the clean cut", kind: "typing", phase: "updated", secureField: false, timeUs: 12_000_000 },
      { capturedText: null, kind: "typing", phase: "stopped", secureField: false, timeUs: 14_400_000 },
      {
        bounds: { height: 760, width: 1160, x: -1500, y: 90 },
        displayId: "display_atet01",
        kind: "window",
        timeUs: 11_000_000,
        title: "Terminal — atet edit",
        windowId: "window_terminal01",
      },
    ],
    overlays: [
      { asset: "assets/intro.png", endUs: 6_000_000, id: "overlay_image001", kind: "image", startUs: 1_000_000, zIndex: 10 },
      { asset: "assets/arrow.svg", endUs: 12_000_000, id: "overlay_svg00001", kind: "svg", startUs: 7_000_000, zIndex: 20 },
      { asset: "assets/reaction.gif", endUs: 18_000_000, id: "overlay_gif00001", kind: "gif", startUs: 13_000_000, zIndex: 30 },
      { asset: "assets/demo.mov", endUs: 25_000_000, id: "overlay_video001", kind: "video", startUs: 19_000_000, zIndex: 40 },
      { asset: "emoji:✨", endUs: 30_000_000, id: "overlay_emoji001", kind: "emoji", startUs: 26_000_000, zIndex: 50 },
    ],
  };
}

export function createAtetDirectWorld(
  runtime: AtetDirectWorldInput["runtime"],
  editEvidence: AtetDirectWorldInput["editEvidence"] = fullEditEvidence(),
  projectEvidence: ProjectEvidence = fullProjectEvidence(),
  workflowEvidence: WorkflowEvidence = fullWorkflowEvidence(),
): AtetDirectWorld {
  return parseAtetDirectWorld({
    editEvidence,
    projectEvidence,
    runtime,
    version: ATET_DIRECT_WORLD_VERSION,
    workflowEvidence,
  });
}

const PROJECT_EVIDENCE = createProjectEvidence();
const WORKFLOW_EVIDENCE = createWorkflowEvidence();

export function fullProjectEvidence(): ProjectEvidence {
  return structuredClone(PROJECT_EVIDENCE);
}

export function fullWorkflowEvidence(): WorkflowEvidence {
  return structuredClone(WORKFLOW_EVIDENCE);
}

export function parseAtetDirectWorld(input: unknown): AtetDirectWorld {
  const world = AtetDirectWorldSchema.parse(input);
  const ranges = [
    ...world.editEvidence.analyzer,
    ...world.editEvidence.edits,
    ...world.editEvidence.overlays,
  ];
  if (ranges.some(({ endUs, startUs }) => endUs <= startUs)) {
    throw new Error("Direct evidence ranges must have positive duration.");
  }
  const overlayKinds = world.editEvidence.overlays.map(({ kind }) => kind);
  if (new Set(overlayKinds).size !== overlayKinds.length) {
    throw new Error("Direct overlay evidence must use each overlay kind at most once.");
  }
  const cloned = cloneJson(world);
  if (!cloned.ok) throw new Error(`Direct world must remain exact JSON: ${cloned.error.message}`);
  // Zod validates the rich production contracts above; cloneJson proves and rebuilds the
  // same value at Direct's narrower recursive JSON boundary.
  return cloned.value as AtetDirectWorld;
}
