import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import type { ApplicationContext } from "../application/context";
import { createApplicationOperationRegistry } from "../application/default-registry";
import {
  commitProjectEditsOperationDefinitionV2,
  createFacesOperationDefinition,
  createFollowFacesOperationDefinition,
  createMusicOperationDefinition,
  createProjectAutoZoomOperationDefinition,
  createProjectEditRevisionOperationDefinition,
  createProjectInactivityOperationDefinition,
  deriveEditBatchOperationDefinitionV2,
  FacesOperationOutputSchema,
  MusicOperationOutputSchema,
  ProjectAutoZoomOutputSchema,
  ProjectRenderOutputSchema,
  ProjectRenderPlanOutputSchema,
  projectRenderOperationDefinition,
  projectRenderOperationDefinitionV2,
  projectRenderPlanOperationDefinition,
  projectSnapshotOperationDefinition,
} from "../application/operations";
import {
  createOperationRecordingProjectFixture,
  OPERATION_TEST_LATER,
  operationApplicationContext,
} from "../application/operations/test-support";
import {
  ProjectEditRevisionDocumentSchema,
  ProjectEditRevisionReferenceSchema,
  ProjectRenderPlanDocumentSchema,
  ProjectRenderReceiptV2Schema,
} from "../application/receipts";
import { OperationRegistry } from "../application/registry";
import { buildFaceAnalyzer } from "../analysis/build";
import {
  CAPTURE_HELPER_VERSION,
  CAPTURE_PROTOCOL_VERSION,
  parseCaptureEvent,
  SegmentCompletionSchema,
  type CaptureOptions,
} from "../capture/protocol";
import {
  AnalysisIdSchema,
  CameraMoveIdSchema,
  FaceAnalysisV1Schema,
  FaceTrackIdSchema,
  ProjectAnalysisReferenceSchema,
  ProjectEditPlanV1Schema,
  ProjectInactivityAnalysisV1Schema,
  RecordingManifestV3Schema,
  RecordingEventV1Schema,
  VideoProjectV1Schema,
  type VideoProjectV1,
} from "../contracts";
import {
  canonicalJson,
  canonicalJsonSha256,
  createDefaultProjectEditPlan,
  createNodeBundleFileSystem,
  hashProjectStructure,
  loadRecordingManifest,
  saveProjectEditPlan,
  saveVideoProject,
} from "../core";
import { openRecording } from "../cli/bundle-service";
import { probeCapabilities } from "../cli/capabilities";
import {
  CaptureBundleWriter,
  CaptureMediaVerifier,
} from "../cli/capture-bundle";
import {
  approveWorkflowRun,
  createWorkflowRun,
  runWorkflow,
} from "../cli/workflow-runs";
import { buildFaceAnalysisReference } from "../cli/face-analysis-service";
import { BunProcessRunner } from "../cli/io";
import { DEFAULT_PROJECT_INACTIVITY_CONFIG } from "../cli/project-inactivity-service";
import {
  createProjectFromRecording,
  loadCurrentProjectPlan,
} from "../cli/project-service";
import { resolveVideoAnalysisSubject } from "../cli/scene-analysis-service";
import { planBuiltInWorkflow } from "../code/planning";
import type { SchedulerRunResult } from "../code/scheduler";
import { builtInWorkflow } from "./index";

const CAPABILITY_EXECUTABLE = Bun.which("true") ?? "/usr/bin/true";
const VIDEO_STREAM_ID = "stream_display01";
const LOCAL_PREPARATION_ALLOWLIST = new Set<string>([
  "local-media",
  "project-state",
  "recording-metadata",
  "typed-text",
  "window-metadata",
]);
const EXPLICIT_METADATA_PREPARATION = new Set<string>([
  "recording-metadata",
  "typed-text",
  "window-metadata",
]);
const FACE_TRACK_IDS = [
  FaceTrackIdSchema.parse("face_workflow_left01"),
  FaceTrackIdSchema.parse("face_workflow_right01"),
] as const;
const RENDERED_BYTES = Buffer.from(
  "deterministic polished screen demo render\n",
  "utf8",
);
const RENDERED_SHA256 = createHash("sha256")
  .update(RENDERED_BYTES)
  .digest("hex");
const REAL_FFMPEG = [
  Bun.which("ffmpeg"),
  "/opt/homebrew/bin/ffmpeg",
  "/usr/local/bin/ffmpeg",
].find((candidate): candidate is string => (
  candidate !== null && existsSync(candidate)
));
const REAL_FFPROBE = [
  Bun.which("ffprobe"),
  "/opt/homebrew/bin/ffprobe",
  "/usr/local/bin/ffprobe",
].find((candidate): candidate is string => (
  candidate !== null && existsSync(candidate)
));
const REAL_MEDIA_DURATION_US = 4_500_000;
const REAL_MEDIA_NATIVE_START_US = 10_000_000;
const REAL_WORKFLOW_NOW = new Date("2026-07-23T16:00:00.000Z");
const REAL_CAPTURE_OPTIONS = {
  camera: { kind: "disabled" },
  displays: { kind: "all" },
  excludedBundleIdentifiers: ["com.hraness.atet"],
  interactionEventProcessIdentifier: null,
  metadata: true,
  microphone: { kind: "disabled" },
  strictSources: false,
  systemAudio: true,
  typedText: false,
  typedTextFocusIdentities: null,
} as const satisfies CaptureOptions;
const REAL_CAPTURE_PERMISSIONS = {
  accessibility: "authorized",
  camera: "not-determined",
  inputMonitoring: "authorized",
  microphone: "not-determined",
  screenCapture: "authorized",
  systemAudio: "authorized",
  windowMetadata: "authorized",
} as const;
const REAL_CAPTURE_SOURCES = {
  audio: [{
    audioSourceId: "system-audio",
    channels: 2,
    kind: "system",
    label: "System audio",
    sampleRateHz: 48_000,
  }],
  cameras: [],
  displays: [{
    bounds: { height: 360, width: 640, x: 0, y: 0 },
    displayId: "display-primary",
    isPrimary: true,
    label: "Golden path display",
    pixelSize: { height: 360, width: 640 },
    refreshRateHz: 10,
    scaleFactor: 1,
  }],
} as const;

const windowSnapshot = RecordingEventV1Schema.parse({
  nativeTimeUs: 0,
  sequence: 0,
  sourceTimeUs: 0,
  type: "window.snapshot",
  windows: [{
    applicationBundleId: "com.example.workflow",
    applicationName: "Workflow Fixture",
    bounds: { height: 700, width: 1_000, x: 100, y: 100 },
    displayId: "display-primary",
    isFocused: true,
    layer: 1,
    title: { state: "available", value: "Workflow Fixture" },
    windowId: "window-workflow",
  }],
});

const focus = RecordingEventV1Schema.parse({
  nativeTimeUs: 1_000_000,
  sequence: 1,
  sourceTimeUs: 1_000_000,
  target: {
    bounds: { height: 40, width: 400, x: 300, y: 350 },
    fieldId: "field-workflow",
    kind: "public-input",
    role: "text-field",
    windowId: "window-workflow",
  },
  type: "focus.changed",
});

type FaceAnalysis = z.infer<typeof FaceAnalysisV1Schema>;
type FaceReference = Extract<
  z.infer<typeof ProjectAnalysisReferenceSchema>,
  { readonly kind: "faces" }
>;

interface FaceEvidence {
  readonly analysis: FaceAnalysis;
  readonly reference: FaceReference;
}

const PolishedScreenDemoOutputSchema = z.strictObject({
  autoZooms: ProjectAutoZoomOutputSchema,
  faceFollow: z.strictObject({
    cameraMoveId: CameraMoveIdSchema,
    revision: ProjectEditRevisionReferenceSchema,
    selectedTrackIds: z.array(FaceTrackIdSchema),
  }),
  faces: FacesOperationOutputSchema,
  music: MusicOperationOutputSchema,
  render: ProjectRenderOutputSchema,
  renderPlan: ProjectRenderPlanOutputSchema,
});

const RenderProbeSchema = z.object({
  format: z.object({
    duration: z.string(),
  }),
  streams: z.array(z.object({
    channels: z.number().int().positive().optional(),
    codec_type: z.enum(["audio", "video"]),
    height: z.number().int().positive().optional(),
    width: z.number().int().positive().optional(),
  })),
});

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function captureStreamTiming(
  sampleCount: number,
  maximumSampleDurationUs: number,
) {
  return {
    bufferCount: sampleCount,
    clockAnchors: {
      end: {
        nativeTimeUs:
          REAL_MEDIA_NATIVE_START_US + REAL_MEDIA_DURATION_US,
        ptsUs: REAL_MEDIA_DURATION_US,
        uncertaintyUs: 100,
      },
      first: {
        nativeTimeUs: REAL_MEDIA_NATIVE_START_US,
        ptsUs: 0,
        uncertaintyUs: 100,
      },
    },
    presentation: {
      endPtsUs: REAL_MEDIA_DURATION_US,
      firstPtsUs: 0,
      lastPtsUs: REAL_MEDIA_DURATION_US - maximumSampleDurationUs,
      maximumSampleDurationUs,
    },
    sampleCount,
  };
}

async function runChecked(
  runner: BunProcessRunner,
  argv: readonly [string, ...string[]],
): Promise<{ readonly stderr: string; readonly stdout: string }> {
  const result = await runner.run(argv, {
    maxOutputBytes: 4 * 1024 * 1024,
    timeoutMs: 120_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${argv[0]} failed (${result.exitCode}): ${
        result.stderr.trim() || result.stdout.trim()
      }`,
    );
  }
  return result;
}

function exactCapabilities(): ApplicationContext["capabilities"] {
  return () => Promise.resolve([
    {
      available: true,
      command: CAPABILITY_EXECUTABLE,
      name: "face-analyzer",
      version: "face-analyzer workflow fixture",
    },
    {
      available: true,
      command: CAPABILITY_EXECUTABLE,
      name: "ffmpeg",
      version: "ffmpeg workflow fixture",
    },
    {
      available: true,
      command: CAPABILITY_EXECUTABLE,
      name: "ffprobe",
      version: "ffprobe workflow fixture",
    },
    {
      available: true,
      command: CAPABILITY_EXECUTABLE,
      name: "rsvg-convert",
      version: "rsvg-convert workflow fixture",
    },
  ]);
}

function faceAnalysis(
  project: VideoProjectV1,
  analysisId: string,
): FaceAnalysis {
  const subject = resolveVideoAnalysisSubject(
    project,
    `asset_operation01:${VIDEO_STREAM_ID}`,
  ).subject;
  const sampleTimesUs = [
    1_000_000,
    3_000_000,
    5_000_000,
    7_000_000,
    8_999_999,
  ];
  return FaceAnalysisV1Schema.parse({
    analysisId,
    backend: {
      architecture: "arm64",
      kind: "apple-vision",
      osBuild: "26A1",
      requestRevision: 3,
      runtimeVersion: "26.0",
    },
    config: {
      sampleIntervalUs: 2_000_000,
      tracking: {
        iouWeight: 0.6,
        maximumCenterDistance: 0.5,
        maximumFacesPerFrame: 8,
        maximumGapUs: 2_500_000,
        minimumConfidence: 0.6,
        minimumIou: 0.05,
      },
    },
    coordinateSpace: {
      encodedPixelHeight: 1_080,
      encodedPixelWidth: 1_920,
      mirroredHorizontally: false,
      origin: "top-left",
      pixelHeight: 1_080,
      pixelWidth: 1_920,
      rotationDegrees: 0,
      sampleAspectRatio: { denominator: 1, numerator: 1 },
      units: "normalized",
      xAxis: "right",
      yAxis: "down",
    },
    coverage: {
      analyzedFrames: sampleTimesUs.length,
      failedFrames: 0,
      range: { endUs: 10_000_000, startUs: 0 },
      requestedFrames: sampleTimesUs.length,
    },
    createdAt: OPERATION_TEST_LATER.toISOString(),
    durationUs: project.timeline.durationUs,
    inputDigest: canonicalJsonSha256({
      fixture: "polished-screen-demo",
      subject,
    }),
    kind: "atet.face-analysis",
    privacy: {
      biometricIdentification: "not-performed",
      execution: "local-only",
      storedEvidence: "bounding-boxes-only",
      tracking: "geometry-continuity-only",
    },
    results: sampleTimesUs.map((assetTimeUs, index) => ({
      assetTimeUs,
      detections: [{
        confidence: 0.99,
        rect: {
          height: 0.22,
          width: 0.18,
          x: 0.12 + index * 0.04,
          y: 0.24,
        },
        trackId: FACE_TRACK_IDS[0],
      }, {
        confidence: 0.98,
        rect: {
          height: 0.2,
          width: 0.17,
          x: 0.7 - index * 0.04,
          y: 0.26,
        },
        trackId: FACE_TRACK_IDS[1],
      }],
      discardedDetections: 0,
      state: "analyzed",
    })),
    schemaVersion: 1,
    subject,
    tool: {
      name: "atet-face-analyzer",
      profile: "offline-boxes",
      version: "workflow-fixture",
    },
    tracks: FACE_TRACK_IDS.map(trackId => ({
      firstSeenAssetTimeUs: sampleTimesUs[0],
      lastSeenAssetTimeUs: sampleTimesUs.at(-1),
      maximumObservedGapUs: 2_000_000,
      observationCount: sampleTimesUs.length,
      trackId,
    })),
  });
}

function createExecutionRegistry(project: VideoProjectV1): OperationRegistry {
  const faceAnalyses = new Map<string, FaceAnalysis>();
  const faceEvidence = new Map<string, FaceEvidence>();
  const registry = new OperationRegistry();

  registry.register(projectSnapshotOperationDefinition);
  registry.register(createProjectInactivityOperationDefinition({
    analyze: options => {
      if (options.referenceEvidence === undefined) {
        throw new TypeError(
          "Workflow inactivity analysis omitted reference evidence.",
        );
      }
      return Promise.resolve({
        analysis: {
          analysisId: AnalysisIdSchema.parse(options.analysisId),
          projectId: project.projectId,
          referenceRecording:
            options.referenceEvidence.referenceRecording,
          result: {
            candidateCount: 0,
            protectedInteractionCount: 0,
            recommendedRanges: [],
          },
        },
      });
    },
    nextAnalysisId: () => "analysis_unusedinactivity",
    publish: options => {
      const analysisPath =
        `analysis/inactivity/${options.analysis.analysisId}.json`;
      const reference = ProjectAnalysisReferenceSchema.parse({
        analysisId: options.analysis.analysisId,
        audioStreams: 1,
        createdAt: OPERATION_TEST_LATER.toISOString(),
        displayStreams: 1,
        kind: "inactivity",
        path: analysisPath,
        projectStructureSha256: hashProjectStructure(project),
        recommendedRanges:
          options.analysis.result.recommendedRanges.length,
        sha256: canonicalJsonSha256(options.analysis),
      });
      if (reference.kind !== "inactivity") {
        throw new TypeError("Expected deterministic inactivity evidence.");
      }
      return Promise.resolve({ analysisPath, reference });
    },
    toolVersion: "workflow-fixture",
  }));
  registry.register(createFacesOperationDefinition({
    analyze: options => {
      const analysis = faceAnalysis(
        project,
        AnalysisIdSchema.parse(options.analysisId),
      );
      faceAnalyses.set(analysis.analysisId, analysis);
      return Promise.resolve({ analysis });
    },
    nextAnalysisId: () => "analysis_unusedfaces0001",
    publish: options => {
      const analysis = faceAnalyses.get(options.analysis.analysisId);
      if (analysis === undefined) {
        throw new TypeError("Face publisher did not receive its analysis.");
      }
      const analysisPath = `analysis/faces/${analysis.analysisId}.json`;
      const reference = buildFaceAnalysisReference(
        analysis,
        analysisPath,
      );
      faceEvidence.set(analysis.analysisId, { analysis, reference });
      return Promise.resolve({ analysisPath, reference });
    },
  }));
  registry.register(createMusicOperationDefinition({
    analyze: options => Promise.resolve({
      analysis: {
        analysisId: AnalysisIdSchema.parse(options.analysisId),
        keyRegions: [],
        musicRegions: [],
        tempoRegions: [],
      },
    }),
    nextAnalysisId: () => "analysis_unusedmusic0001",
    publish: options => {
      const analysisPath = `analysis/music/${options.analysis.analysisId}.json`;
      const reference = ProjectAnalysisReferenceSchema.parse({
        analysisId: options.analysis.analysisId,
        assetId: "asset_operation01",
        createdAt: OPERATION_TEST_LATER.toISOString(),
        keyRegions: options.analysis.keyRegions.length,
        kind: "music",
        musicRegions: options.analysis.musicRegions.length,
        path: analysisPath,
        sha256: canonicalJsonSha256(options.analysis),
        streamId: "stream_operation02",
        tempoRegions: options.analysis.tempoRegions.length,
      });
      if (reference.kind !== "music") {
        throw new TypeError("Expected deterministic music evidence.");
      }
      return Promise.resolve({ analysisPath, reference });
    },
    toolVersion: "workflow-fixture",
  }));
  registry.register(createProjectAutoZoomOperationDefinition({
    loadEvents: () => Promise.resolve([windowSnapshot, focus]),
  }));
  registry.register(deriveEditBatchOperationDefinitionV2);
  registry.register(commitProjectEditsOperationDefinitionV2);
  registry.register(createFollowFacesOperationDefinition({
    loadFaceAnalysis: (_snapshot, analysisId) => {
      const evidence = faceEvidence.get(analysisId);
      if (evidence === undefined) {
        throw new TypeError(`Missing deterministic face evidence: ${analysisId}`);
      }
      return Promise.resolve(evidence);
    },
  }));
  registry.register(createProjectEditRevisionOperationDefinition);
  registry.register(projectRenderPlanOperationDefinition);
  registry.register(projectRenderOperationDefinition);
  registry.register(projectRenderOperationDefinitionV2);
  return registry;
}

async function runToCompletion(options: {
  readonly application: ApplicationContext;
  readonly registry: OperationRegistry;
  readonly runId: string;
  readonly store: Awaited<ReturnType<typeof createWorkflowRun>>["store"];
}): Promise<SchedulerRunResult> {
  for (let approvalCount = 0; approvalCount < 16; approvalCount += 1) {
    const result = await runWorkflow({
      application: options.application,
      jobs: 4,
      registry: options.registry,
      runId: options.runId,
      store: options.store,
    });
    if (result.pause === undefined) return result;
    if (result.pause.phase !== "preparation") {
      throw new Error(
        `Workflow unexpectedly requested ${result.pause.phase} approval for ${result.pause.nodeKey}.`,
      );
    }
    const pending = await options.store.node(
      options.runId,
      result.pause.nodeKey,
    );
    const requested = pending.preparationPlan?.requestedPreparation;
    if (
      pending.status !== "approval-required"
      || requested === undefined
      || requested.some(
        requirement => !LOCAL_PREPARATION_ALLOWLIST.has(requirement),
      )
      || !requested.some(
        requirement => EXPLICIT_METADATA_PREPARATION.has(requirement),
      )
    ) {
      throw new Error(
        `Workflow requested an unexpected preparation envelope for ${result.pause.nodeKey}.`,
      );
    }
    await approveWorkflowRun({
      application: options.application,
      nodeKey: result.pause.nodeKey,
      planHash: result.pause.planSha256,
      planKind: result.pause.phase,
      runId: options.runId,
    });
  }
  throw new Error("Workflow exceeded its deterministic approval bound.");
}

describe("polished screen demo durable execution", () => {
  test("publishes a face-derived immutable revision and deterministic render", async () => {
    const repositoryRoot = await mkdtemp(
      join(
        await realpath(tmpdir()),
        "atet-polished-demo-execution-",
      ),
    );
    try {
      const fixture = await createOperationRecordingProjectFixture(
        repositoryRoot,
      );
      const mediaBytes = Buffer.from(
        "deterministic immutable project media\n",
        "utf8",
      );
      const mediaPath = join(repositoryRoot, "fixtures", "operation.mp4");
      await mkdir(dirname(mediaPath), { recursive: true });
      await writeFile(mediaPath, mediaBytes);
      const mediaSha256 = createHash("sha256")
        .update(mediaBytes)
        .digest("hex");
      const project = VideoProjectV1Schema.parse({
        ...fixture.project,
        assets: fixture.project.assets.map(asset => ({
          ...asset,
          streams: asset.streams.map(stream => ({
            ...stream,
            ...(stream.kind === "video"
              ? { streamId: VIDEO_STREAM_ID }
              : {}),
            segments: stream.segments.map(segment => ({
              ...segment,
              bytes: mediaBytes.byteLength,
              sha256: mediaSha256,
            })),
          })),
        })),
        placements: fixture.project.placements.map(placement => ({
          ...placement,
          video: placement.video.map(configured => ({
            ...configured,
            streamId: VIDEO_STREAM_ID,
          })),
        })),
      });
      const plan = createDefaultProjectEditPlan(
        project,
        fixture.plan.planId,
        fixture.plan.createdAt,
      );
      await Promise.all([
        saveVideoProject(fixture.fileSystem, project),
        saveProjectEditPlan(fixture.fileSystem, plan),
      ]);

      let rendererCalls = 0;
      const application = {
        ...operationApplicationContext(repositoryRoot, {
          capabilities: exactCapabilities(),
          now: OPERATION_TEST_LATER,
        }),
        runner: {
          run: async (argv) => {
            rendererCalls += 1;
            expect(argv[0]).toContain("/capability-pins-v1/");
            expect(argv[0]).toEndWith("/true");
            expect(argv).toContain("-n");
            expect(argv[argv.indexOf("-preset") + 1]).toBe("medium");
            expect(argv[argv.indexOf("-crf") + 1]).toBe("18");
            expect(argv[argv.indexOf("-b:a") + 1]).toBe("192k");
            await writeFile(argv.at(-1)!, RENDERED_BYTES, { flag: "wx" });
            return { exitCode: 0, stderr: "", stdout: "" };
          },
        },
      } satisfies ApplicationContext;
      const registry = createExecutionRegistry(project);
      const workflow = builtInWorkflow("polished-screen-demo");
      if (workflow === undefined) {
        throw new TypeError("Polished screen demo is not registered.");
      }
      const planned = await planBuiltInWorkflow({
        application,
        registry,
        workflow,
        workflowInput: {
          cameraSource: `asset_operation01:${VIDEO_STREAM_ID}`,
          faceFollow: {
            framing: "group",
            gapPolicy: "fail",
            placementId: "placement_operation01",
            projectRange: { endUs: 9_000_000, startUs: 1_000_000 },
            requireAllSelectedFaces: true,
            selection: { kind: "all" },
            smoothingSeconds: 0,
          },
          musicSource: "asset_operation01:stream_operation02",
          project: project.projectId,
          render: {
            maximumBytes: 1_024 * 1_024,
            output: "renders/polished-screen-demo/final.mp4",
            syncPolicy: "require-verified",
          },
        },
      });
      const created = await createWorkflowRun({
        application,
        bundleBytes: planned.bundleBytes,
        graphPlan: planned.plan,
        registry,
        sourceLocator: "builtin:polished-screen-demo@4",
      });
      const result = await runToCompletion({
        application,
        registry,
        runId: created.runId,
        store: created.store,
      });

      if (result.summary.status !== "completed") {
        const nodes = await Promise.all(
          planned.plan.graph.nodes.map(node =>
            created.store.node(created.runId, node.key)),
        );
        throw new Error(canonicalJson(nodes.map(node => ({
          failure: node.failure ?? null,
          key: node.nodeKey,
          status: node.status,
        }))));
      }
      expect(result.summary.status).toBe("completed");
      expect(result.summary.counts).toEqual({
        cancelled: 0,
        completed: planned.plan.graph.nodes.length,
        failed: 0,
        pending: 0,
        skipped: 0,
      });
      const persisted = await created.store.outputs(created.runId);
      if (persisted === undefined) {
        throw new TypeError("Completed workflow did not persist final outputs.");
      }
      const output = PolishedScreenDemoOutputSchema.parse(persisted.outputs);
      expect(output.faceFollow.selectedTrackIds).toEqual(
        [...FACE_TRACK_IDS],
      );
      expect(output.faces.tracks).toBe(2);
      expect(output.autoZooms.operations).toHaveLength(1);
      expect(output.faceFollow.revision.analysisId)
        .toBe(output.faces.analysisId);
      expect(output.faceFollow.revision.analysisSha256)
        .toBe(output.faces.reference.sha256);
      if (output.faces.reference.kind !== "faces") {
        throw new TypeError("Workflow returned a non-face analysis reference.");
      }

      const revisionText = await fixture.fileSystem.readText(
        output.faceFollow.revision.artifact.path,
      );
      expect(createHash("sha256").update(revisionText).digest("hex"))
        .toBe(output.faceFollow.revision.artifact.sha256);
      const revision = ProjectEditRevisionDocumentSchema.parse(
        JSON.parse(revisionText) as unknown,
      );
      expect(revision.revisionSha256)
        .toBe(output.faceFollow.revision.revisionSha256);
      expect(revision.projectSha256)
        .toBe(output.faceFollow.revision.projectSha256);
      expect(revision.projectEditPlanSha256)
        .toBe(output.faceFollow.revision.projectEditPlanSha256);
      const cameraMove = revision.projectEditPlan.cameraMoves.find(
        candidate => (
          candidate.cameraMoveId === output.faceFollow.cameraMoveId
        ),
      );
      expect(cameraMove?.origin).toMatchObject({
        analysisId: output.faces.analysisId,
        analysisSha256: output.faces.reference.sha256,
        kind: "face-analysis",
        subjectIntegritySha256:
          output.faces.reference.subjectIntegritySha256,
        trackIds: [...FACE_TRACK_IDS],
      });
      expect(revision.project.analyses).toContainEqual(
        output.faces.reference,
      );

      if (project.currentEditPlanPath === null) {
        throw new TypeError("Workflow project omitted its current plan path.");
      }
      const currentPlanText = await fixture.fileSystem.readText(
        project.currentEditPlanPath,
      );
      const currentPlan = ProjectEditPlanV1Schema.parse(
        JSON.parse(currentPlanText) as unknown,
      );
      expect(currentPlan.cameraMoves).toEqual([]);
      expect(rendererCalls).toBe(1);
      expect(output.render.output).toMatchObject({
        bytes: RENDERED_BYTES.byteLength,
        path: "renders/polished-screen-demo/final.mp4",
        projectId: project.projectId,
        revisionSha256: revision.revisionSha256,
        sha256: RENDERED_SHA256,
      });
      expect(await readFile(
        join(fixture.projectDirectory, output.render.output.path),
      )).toEqual(RENDERED_BYTES);
      expect(output.renderPlan.revisionSha256)
        .toBe(revision.revisionSha256);
      expect(canonicalJson(result.summary.outputs))
        .toBe(canonicalJson(persisted.outputs));
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  }, 120_000);

  test.skipIf(
    process.platform !== "darwin"
    || REAL_FFMPEG === undefined
    || REAL_FFPROBE === undefined,
  )(
    "executes the production workflow over a verified real recording bundle",
    async () => {
      if (REAL_FFMPEG === undefined || REAL_FFPROBE === undefined) {
        throw new TypeError("Real-media tool gate was bypassed.");
      }
      const ffmpeg = REAL_FFMPEG;
      const ffprobe = REAL_FFPROBE;
      const repositoryRoot = await mkdtemp(
        join(
          await realpath(tmpdir()),
          "atet-polished-demo-real-media-",
        ),
      );
      const runner = new BunProcessRunner();
      try {
        const desktopRoot = join(import.meta.dir, "..");
        const recordingRoot = join(
          repositoryRoot,
          "artifacts",
          "atet",
          "recordings",
        );
        const recordingId = "rec_polishedreal01";
        const bundleRoot = join(recordingRoot, recordingId);
        const mediaRelative = "segments/0001/display-primary.mp4";
        const eventRelative = "events/segment-0001.jsonl";
        const mediaAbsolute = join(bundleRoot, mediaRelative);
        const eventAbsolute = join(bundleRoot, eventRelative);
        await Promise.all([
          mkdir(dirname(mediaAbsolute), { recursive: true }),
          mkdir(dirname(eventAbsolute), { recursive: true }),
        ]);

        const positiveFaceFixture = join(
          desktopRoot,
          "analysis",
          "face-positive-fixture.jpg",
        );
        const [faceAnalyzer] = await Promise.all([
          buildFaceAnalyzer(),
          runChecked(runner, [
            ffmpeg,
            "-hide_banner",
            "-loglevel", "error",
            "-y",
            "-framerate", "10",
            "-loop", "1",
            "-i", positiveFaceFixture,
            "-f", "lavfi",
            "-t", "0.25",
            "-i", "sine=frequency=440:sample_rate=48000",
            "-f", "lavfi",
            "-t", "4",
            "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
            "-f", "lavfi",
            "-t", "0.25",
            "-i", "sine=frequency=660:sample_rate=48000",
            "-filter_complex",
            [
              "[1:a]pan=stereo|c0=c0|c1=c0[tone0]",
              "[3:a]pan=stereo|c0=c0|c1=c0[tone1]",
              "[tone0][2:a][tone1]concat=n=3:v=0:a=1[a]",
            ].join(";"),
            "-map", "0:v:0",
            "-map", "[a]",
            "-t", "4.5",
            "-vf",
            "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:black",
            "-c:v", "libx264",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-ar", "48000",
            "-ac", "2",
            mediaAbsolute,
          ]),
        ]);

        const events = [
          RecordingEventV1Schema.parse({
            nativeTimeUs: REAL_MEDIA_NATIVE_START_US,
            sequence: 0,
            sourceTimeUs: 0,
            type: "window.snapshot",
            windows: [{
              applicationBundleId: "com.example.workflow",
              applicationName: "Workflow Fixture",
              bounds: { height: 300, width: 560, x: 40, y: 30 },
              displayId: "display-primary",
              isFocused: true,
              layer: 1,
              title: {
                state: "available",
                value: "Production workflow fixture",
              },
              windowId: "window-workflow",
            }],
          }),
          RecordingEventV1Schema.parse({
            nativeTimeUs: REAL_MEDIA_NATIVE_START_US + 100_000,
            sequence: 1,
            sourceTimeUs: 100_000,
            target: {
              bounds: { height: 40, width: 240, x: 200, y: 120 },
              fieldId: "field-workflow",
              kind: "public-input",
              role: "text-field",
              windowId: "window-workflow",
            },
            type: "focus.changed",
          }),
        ];
        const eventText = `${events.map(canonicalJson).join("\n")}\n`;
        await writeFile(eventAbsolute, eventText);
        const [rawSourceBefore, rawEventsBefore] = await Promise.all([
          readFile(mediaAbsolute),
          readFile(eventAbsolute),
        ]);
        const rawSourceSha256 = sha256Bytes(rawSourceBefore);
        const rawEventsSha256 = sha256Bytes(rawEventsBefore);

        const configured = parseCaptureEvent({
          availableSources: REAL_CAPTURE_SOURCES,
          event: "configured",
          lastInterruption: null,
          options: REAL_CAPTURE_OPTIONS,
          permissions: REAL_CAPTURE_PERMISSIONS,
          protocolVersion: CAPTURE_PROTOCOL_VERSION,
          requestId: "configure-polished-real",
          sources: REAL_CAPTURE_SOURCES,
          state: "ready",
        });
        if (configured.event !== "configured") {
          throw new TypeError("Expected a configured capture event.");
        }
        const writer = new CaptureBundleWriter({
          bundleRoot,
          captureOptions: REAL_CAPTURE_OPTIONS,
          configured,
          helperVersion: CAPTURE_HELPER_VERSION,
          now: () => OPERATION_TEST_LATER,
          recordingId,
          toolVersion: "atet-golden-path",
          verifier: new CaptureMediaVerifier({
            ffprobe,
            runner,
          }),
        });
        const segment = SegmentCompletionSchema.parse({
          camera: {
            availability: "unavailable",
            reason: "disabled",
          },
          clock: {
            end: {
              nativeTimeUs:
                REAL_MEDIA_NATIVE_START_US + REAL_MEDIA_DURATION_US,
              sourceTimeUs: REAL_MEDIA_DURATION_US,
            },
            kind: "mach-continuous-microseconds",
            start: {
              nativeTimeUs: REAL_MEDIA_NATIVE_START_US,
              sourceTimeUs: 0,
            },
          },
          diagnostics: [],
          displays: [{
            container: "mp4",
            containerDurationUs: REAL_MEDIA_DURATION_US,
            display: {
              bounds: REAL_CAPTURE_SOURCES.displays[0].bounds,
              displayId: "display-primary",
              isPrimary: true,
              pixelHeight: 360,
              pixelWidth: 640,
              scaleFactor: 1,
            },
            path: mediaRelative,
            streams: [{
              codec: "h264",
              mapping: "exact",
              role: "display-video",
              streamIndex: 0,
              timing: captureStreamTiming(45, 100_000),
              trackId: 1,
            }, {
              channels: 2,
              codec: "aac",
              mapping: "exact",
              role: "system-audio",
              sampleRateHz: 48_000,
              streamIndex: 1,
              timing: captureStreamTiming(212, 21_334),
              trackId: 2,
            }],
          }],
          index: 0,
          metadata: [{
            droppedEvents: 0,
            eventKinds: ["window.snapshot", "focus.changed"],
            path: eventRelative,
            recordCount: events.length,
          }],
          microphone: {
            availability: "unavailable",
            reason: "disabled",
          },
          sources: REAL_CAPTURE_SOURCES,
        });
        await writer.initialize();
        await writer.setState("recording");
        await writer.appendSegment(segment, null);
        await writer.setState("stopped", REAL_MEDIA_DURATION_US);

        const manifest = RecordingManifestV3Schema.parse(
          await loadRecordingManifest(createNodeBundleFileSystem(bundleRoot)),
        );
        expect(manifest).toMatchObject({
          recordingId,
          schemaVersion: 3,
          state: "stopped",
          timeline: { durationUs: REAL_MEDIA_DURATION_US },
        });
        expect(manifest.tracks.map(track => track.kind).sort()).toEqual([
          "display-video",
          "system-audio",
        ]);
        const publishedSegments = manifest.tracks.flatMap(
          track => track.segments,
        );
        expect(publishedSegments).toHaveLength(2);
        expect(publishedSegments.every(
          published => (
            published.containerTrackIdentity.kind === "verified"
            && published.integrity.state === "verified"
            && published.integrity.sha256 === rawSourceSha256
            && published.timing.kind === "measured"
            && published.timing.status === "within-tolerance"
          ),
        )).toBeTrue();
        expect(manifest.diagnostics.filter(
          diagnostic => diagnostic.level === "error",
        )).toEqual([]);
        expect(manifest.eventStreams).toHaveLength(1);
        expect(manifest.eventStreams[0]?.integrity).toMatchObject({
          sha256: rawEventsSha256,
          state: "verified",
        });

        const recording = await openRecording(recordingRoot, recordingId);
        const createdProject = await createProjectFromRecording({
          id: "project_polishedreal01",
          name: "Polished real-media golden path",
          now: OPERATION_TEST_LATER,
          projectRoot: join(
            repositoryRoot,
            "artifacts",
            "atet",
            "projects",
          ),
          recording,
          repositoryRoot,
        });
        const initialPlan = await loadCurrentProjectPlan(createdProject);
        expect(initialPlan.keep).toEqual([{
          endUs: REAL_MEDIA_DURATION_US,
          startUs: 0,
        }]);
        expect(createdProject.project.assets[0]?.source).toMatchObject({
          kind: "recording",
          recordingId,
        });
        const asset = createdProject.project.assets[0];
        const placement = createdProject.project.placements[0];
        const screen = asset?.streams.find(
          stream => stream.kind === "video" && stream.role === "screen",
        );
        const systemAudio = asset?.streams.find(
          stream => (
            stream.kind === "audio" && stream.role === "system-audio"
          ),
        );
        if (
          asset === undefined
          || placement === undefined
          || screen === undefined
          || systemAudio === undefined
        ) {
          throw new TypeError(
            "Recording-backed project omitted its screen or system-audio subject.",
          );
        }

        const probedCapabilities = await probeCapabilities(
          runner,
          desktopRoot,
          {
            ...process.env,
            ATET_FACE_ANALYZER: faceAnalyzer.path,
          },
        );
        for (const name of ["face-analyzer", "ffmpeg", "ffprobe"] as const) {
          expect(
            probedCapabilities.find(capability => capability.name === name),
          )
            .toMatchObject({ available: true, name });
        }
        const capabilities: Awaited<
          ReturnType<ApplicationContext["capabilities"]>
        > = probedCapabilities.map(capability => ({
            available: capability.available,
            name: capability.name,
            ...(capability.command === undefined
              ? {}
              : { command: capability.command }),
            ...(capability.reason === undefined
              ? {}
              : { reason: capability.reason }),
            ...(capability.version === undefined
              ? {}
              : { version: capability.version }),
          }));
        const application = {
          ...operationApplicationContext(repositoryRoot, {
            capabilities: () => Promise.resolve(capabilities),
            now: REAL_WORKFLOW_NOW,
          }),
          paths: {
            ...operationApplicationContext(repositoryRoot).paths,
            desktopRoot,
          },
          runner,
        } satisfies ApplicationContext;
        const registry = createApplicationOperationRegistry({
          toolVersion: "atet-golden-path",
        });
        const workflow = builtInWorkflow("polished-screen-demo");
        if (workflow === undefined) {
          throw new TypeError("Polished screen demo is not registered.");
        }
        const planned = await planBuiltInWorkflow({
          application,
          registry,
          workflow,
          workflowInput: {
            cameraSource: `${asset.assetId}:${screen.streamId}`,
            faceFollow: {
              framing: "group",
              gapPolicy: "fail",
              placementId: placement.placementId,
              projectRange: {
                endUs: REAL_MEDIA_DURATION_US,
                startUs: 0,
              },
              requireAllSelectedFaces: true,
              selection: { kind: "all" },
              smoothingSeconds: 0,
            },
            musicSource: `${asset.assetId}:${systemAudio.streamId}`,
            project: createdProject.project.projectId,
            render: {
              maximumBytes: 64 * 1024 * 1024,
              output: "renders/polished-screen-demo/real-final.mp4",
              syncPolicy: "require-verified",
            },
          },
        });
        const created = await createWorkflowRun({
          application,
          bundleBytes: planned.bundleBytes,
          graphPlan: planned.plan,
          registry,
          sourceLocator: "builtin:polished-screen-demo@4",
        });
        const result = await runToCompletion({
          application,
          registry,
          runId: created.runId,
          store: created.store,
        });
        if (result.summary.status !== "completed") {
          const nodes = await Promise.all(
            planned.plan.graph.nodes.map(node =>
              created.store.node(created.runId, node.key)),
          );
          throw new Error(canonicalJson(nodes.map(node => ({
            failure: node.failure ?? null,
            key: node.nodeKey,
            status: node.status,
          }))));
        }

        const persisted = await created.store.outputs(created.runId);
        if (persisted === undefined) {
          throw new TypeError(
            "Completed real-media workflow omitted final outputs.",
          );
        }
        const output = PolishedScreenDemoOutputSchema.parse(
          persisted.outputs,
        );
        expect(output.autoZooms.operations).toHaveLength(1);
        expect(output.autoZooms.operations[0]).toMatchObject({
          operation: { reason: "focus" },
          placementId: placement.placementId,
        });
        expect(output.autoZooms).toMatchObject({
          sourceZoomCount: 1,
          unmappedSourceZoomCount: 0,
        });
        expect(output.faces.analyzedFrames).toBeGreaterThan(0);
        expect(output.faces.tracks).toBeGreaterThan(1);
        expect(output.faceFollow.selectedTrackIds).toHaveLength(
          output.faces.tracks,
        );
        expect(new Set(output.faceFollow.selectedTrackIds).size)
          .toBe(output.faceFollow.selectedTrackIds.length);
        expect(output.faceFollow.revision.analysisId)
          .toBe(output.faces.analysisId);
        expect(output.faceFollow.revision.analysisSha256)
          .toBe(output.faces.reference.sha256);

        const revision = ProjectEditRevisionDocumentSchema.parse(
          JSON.parse(
            await createdProject.fileSystem.readText(
              output.faceFollow.revision.artifact.path,
            ),
          ) as unknown,
        );
        const inactivityReference = revision.project.analyses.find(
          reference => reference.kind === "inactivity",
        );
        if (inactivityReference?.kind !== "inactivity") {
          throw new TypeError(
            "Production workflow omitted inactivity evidence.",
          );
        }
        const inactivity = ProjectInactivityAnalysisV1Schema.parse(
          JSON.parse(
            await createdProject.fileSystem.readText(
              inactivityReference.path,
            ),
          ) as unknown,
        );
        expect(inactivity.config).toEqual(
          DEFAULT_PROJECT_INACTIVITY_CONFIG,
        );
        expect(inactivity.result.recommendedRanges).toHaveLength(1);
        const inactivityCut =
          inactivity.result.recommendedRanges[0];
        if (inactivityCut === undefined) {
          throw new TypeError("Expected one default inactivity cut.");
        }
        expect(inactivityCut.endUs - inactivityCut.startUs)
          .toBeGreaterThanOrEqual(3_000_000);
        expect(inactivityCut.endUs - inactivityCut.startUs)
          .toBeLessThan(3_500_000);
        expect(revision.projectEditPlan.keep).toHaveLength(2);
        expect(revision.projectEditPlan.zooms).toHaveLength(1);
        expect(revision.projectEditPlan.cameraMoves).toHaveLength(1);
        expect(revision.projectEditPlan.effects).toMatchObject({
          clicks: { enabled: true },
          cursor: { enabled: true },
          keystrokes: { enabled: true, secureText: "hide" },
          metadataPlacementId: placement.placementId,
          typedText: { enabled: false },
        });
        expect(
          revision.projectEditPlan.cameraMoves[0]?.origin,
        ).toMatchObject({
          analysisId: output.faces.analysisId,
          analysisSha256: output.faces.reference.sha256,
          kind: "face-analysis",
          trackIds: output.faceFollow.selectedTrackIds,
        });

        const currentPlan =
          await loadCurrentProjectPlan(createdProject);
        expect(currentPlan.cameraMoves).toEqual([]);
        expect(currentPlan.keep).toEqual(
          revision.projectEditPlan.keep,
        );
        expect(currentPlan.zooms).toEqual(
          revision.projectEditPlan.zooms,
        );

        const renderPlan = ProjectRenderPlanDocumentSchema.parse(
          JSON.parse(
            await createdProject.fileSystem.readText(
              output.renderPlan.artifact.path,
            ),
          ) as unknown,
        );
        expect(renderPlan).toMatchObject({
          renderPlanSha256: output.renderPlan.renderPlanSha256,
          revisionSha256: revision.revisionSha256,
        });
        expect(renderPlan.plan.output).toMatchObject({
          pixelHeight: 1_080,
          pixelWidth: 1_920,
        });
        expect(renderPlan.plan.output.durationUs)
          .toBeGreaterThan(0);
        expect(renderPlan.plan.output.durationUs)
          .toBeLessThan(REAL_MEDIA_DURATION_US);
        expect(renderPlan.plan.audioSlices.length).toBeGreaterThan(0);
        expect(renderPlan.plan.videoSlices.length).toBeGreaterThan(0);
        expect(renderPlan.plan.cameraSegments.length).toBeGreaterThan(0);
        expect(renderPlan.plan.warnings).toEqual([]);

        const renderedAbsolute = join(
          createdProject.directory.path,
          output.render.output.path,
        );
        const renderedBytes = await readFile(renderedAbsolute);
        expect(renderedBytes.byteLength).toBe(
          output.render.output.bytes,
        );
        expect(sha256Bytes(renderedBytes)).toBe(
          output.render.output.sha256,
        );
        const probe = RenderProbeSchema.parse(JSON.parse(
          (
            await runChecked(runner, [
              ffprobe,
              "-v", "error",
              "-show_entries",
              "format=duration:stream=codec_type,width,height,channels",
              "-of", "json",
              renderedAbsolute,
            ])
          ).stdout,
        ) as unknown);
        expect(probe.streams.some(stream => (
          stream.codec_type === "video"
          && stream.height === 1_080
          && stream.width === 1_920
        ))).toBeTrue();
        expect(probe.streams.some(stream => (
          stream.channels === 2 && stream.codec_type === "audio"
        ))).toBeTrue();
        expect(Math.abs(
          Math.round(Number(probe.format.duration) * 1_000_000)
          - renderPlan.plan.output.durationUs,
        )).toBeLessThanOrEqual(100_000);

        const receiptText =
          await createdProject.fileSystem.readText(
            output.render.receipt.path,
          );
        expect(sha256Bytes(Buffer.from(receiptText, "utf8")))
          .toBe(output.render.receipt.sha256);
        const receipt = ProjectRenderReceiptV2Schema.parse(
          JSON.parse(receiptText) as unknown,
        );
        expect(receipt).toMatchObject({
          output: output.render.output,
          receiptSha256: output.render.receipt.receiptSha256,
          revisionSha256: revision.revisionSha256,
          syncPolicy: "require-verified",
        });
        expect(receipt.plan.renderPlanSha256)
          .toBe(renderPlan.renderPlanSha256);

        const [rawSourceAfter, rawEventsAfter] = await Promise.all([
          readFile(mediaAbsolute),
          readFile(eventAbsolute),
        ]);
        expect(rawSourceAfter).toEqual(rawSourceBefore);
        expect(sha256Bytes(rawSourceAfter)).toBe(rawSourceSha256);
        expect(rawEventsAfter).toEqual(rawEventsBefore);
        expect(sha256Bytes(rawEventsAfter)).toBe(rawEventsSha256);
        expect(canonicalJson(result.summary.outputs))
          .toBe(canonicalJson(persisted.outputs));
      } finally {
        await rm(repositoryRoot, { force: true, recursive: true });
      }
    },
    180_000,
  );
});
