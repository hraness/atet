import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AudioAlignmentAnalysisV1Schema,
  EditPlanIdSchema,
  MusicAnalysisV1Schema,
  ProjectAssetV1Schema,
  ProjectPlacementV1Schema,
  RecordingManifestV1Schema,
  SpeechAnalysisV1Schema,
  VideoProjectV1Schema,
  type AudioAlignmentAnalysisV1,
  type MusicAnalysisV1,
  type SpeechAnalysisV1,
} from "../contracts";
import {
  canonicalJson,
  createDefaultProjectEditPlan,
  createNodeBundleFileSystem,
  saveAnalysisArtifact,
  saveProjectEditPlan,
  saveRecordingManifest,
  saveVideoProject,
  sha256Hex,
} from "../core";
import { testManifest } from "../core/test-support";
import { alignmentInputDigest, resolveAudioAnalysisSubject } from "./audio-analysis";
import { loadCurrentPlan, openRecording } from "./bundle-service";
import { EXIT_CODE } from "./errors";
import type { CliIo, ProcessRunner } from "./io";
import type { RepositoryPaths } from "./paths";
import {
  addAssetToProject,
  createProjectFromRecording,
  openProject,
  projectAnalysisPath,
  type OpenProject,
} from "./project-service";
import { createCliTestRunner } from "./run-cli-test-helper";

const runCli = createCliTestRunner(import.meta.url);

const NOW = new Date("2026-07-22T16:00:00.000Z");
const LATER = "2026-07-22T16:01:00.000Z";
const HASH = "a".repeat(64);

interface CliResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface Fixture {
  readonly paths: RepositoryPaths;
  readonly project: OpenProject;
  readonly root: string;
}

function rejectingRunner(): ProcessRunner {
  return {
    run() {
      return Promise.reject(new Error("This safety-path test must not invoke a subprocess."));
    },
  };
}

function parseCliFailure(stderr: string): {
  readonly code: string;
  readonly details: unknown;
  readonly message: string;
} {
  const value = JSON.parse(stderr) as unknown;
  if (typeof value !== "object" || value === null || !("error" in value)) {
    throw new Error("Expected a JSON CLI error envelope.");
  }
  const error = value.error;
  if (
    typeof error !== "object"
    || error === null
    || !("code" in error)
    || typeof error.code !== "string"
    || !("message" in error)
    || typeof error.message !== "string"
  ) {
    throw new Error("Expected a structured JSON CLI error.");
  }
  return {
    code: error.code,
    details: "details" in error ? error.details : undefined,
    message: error.message,
  };
}

async function execute(paths: RepositoryPaths, argv: readonly string[]): Promise<CliResult> {
  let stderr = "";
  let stdout = "";
  const io: CliIo = {
    cwd: () => paths.repositoryRoot,
    env: {},
    now: () => NOW,
    platform: process.platform,
    stderr: value => { stderr += value; },
    stdout: value => { stdout += value; },
  };
  const exitCode = await runCli(argv, { io, paths, runner: rejectingRunner() });
  return { exitCode, stderr, stdout };
}

async function projectFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "transmute-command-safety-"));
  const paths: RepositoryPaths = {
    artifactRoot: join(root, "artifacts", "transmute", "recordings"),
    desktopRoot: join(root, "projects", "transmute", "apps", "desktop"),
    privateRoot: join(root, "artifacts", "transmute", "private"),
    projectRoot: join(root, "artifacts", "transmute", "projects"),
    repositoryRoot: root,
  };
  const recordingDirectory = join(paths.artifactRoot, "rec_example001");
  const mediaContents = "x".repeat(100);
  const mediaSha256 = sha256Hex(mediaContents);
  const manifest = RecordingManifestV1Schema.parse({
    ...testManifest(),
    tracks: testManifest().tracks.map(track => ({
      ...track,
      segments: track.segments.map(segment => ({
        ...segment,
        integrity: { bytes: 100, sha256: mediaSha256, state: "verified" },
      })),
    })),
  });
  await mkdir(join(recordingDirectory, "media"), { recursive: true });
  await Promise.all([
    writeFile(join(recordingDirectory, "media", "segment-1.mp4"), mediaContents),
    writeFile(join(recordingDirectory, "media", "segment-left.mp4"), mediaContents),
  ]);
  await saveRecordingManifest(createNodeBundleFileSystem(recordingDirectory), manifest);
  const recording = await openRecording(paths.artifactRoot, "rec_example001");
  const project = await createProjectFromRecording({
    id: "project_safety001",
    now: NOW,
    projectRoot: paths.projectRoot,
    recording,
    repositoryRoot: root,
  });
  return { paths, project, root };
}

async function addShiftedPlacement(
  open: OpenProject,
  options: { readonly unverified?: boolean } = {},
): Promise<OpenProject> {
  const reference = open.project.placements[0]!;
  const shifted = ProjectPlacementV1Schema.parse({
    ...reference,
    assetRange: { endUs: 10_000_000, startUs: 3_000_000 },
    placementId: "placement_shifted01",
    sync: {
      anchors: [
        { assetTimeUs: 3_000_000, projectTimeUs: 0 },
        { assetTimeUs: 10_000_000, projectTimeUs: 7_000_000 },
      ],
      provenance: options.unverified
        ? { kind: "unverified", reason: "insufficient-evidence" }
        : { kind: "manual", note: "test offset" },
    },
  });
  const project = VideoProjectV1Schema.parse({
    ...open.project,
    placements: [...open.project.placements, shifted],
    updatedAt: LATER,
  });
  const plan = createDefaultProjectEditPlan(
    project,
    EditPlanIdSchema.parse("plan_safetyshifted"),
    LATER,
  );
  await saveProjectEditPlan(open.fileSystem, plan);
  await saveVideoProject(open.fileSystem, project);
  return await openProject(join(open.directory.path, ".."), String(project.projectId));
}

async function addImportedVideoPlacement(open: OpenProject): Promise<OpenProject> {
  const asset = ProjectAssetV1Schema.parse({
    assetId: "asset_importedvideo01",
    createdAt: LATER,
    durationUs: 10_000_000,
    label: "Imported camera with scratch audio",
    role: "camera",
    source: {
      importedAt: LATER,
      kind: "imported",
      originalName: "imported-camera.mov",
      sourceSha256: HASH,
    },
    streams: [{
      frameRate: 30,
      kind: "video",
      label: "Imported camera video",
      pixelHeight: 1_080,
      pixelWidth: 1_920,
      role: "camera",
      segments: [{
        assetRange: { endUs: 10_000_000, startUs: 0 },
        bytes: 100,
        codec: "h264",
        container: "mov",
        fileRange: { endUs: 10_000_000, startUs: 0 },
        path: "artifacts/transmute/projects/project_safety001/imports/imported-camera.mov",
        sha256: HASH,
        streamIndex: 0,
      }],
      streamId: "stream_importedvideo01",
    }, {
      channels: 2,
      kind: "audio",
      label: "Imported camera scratch audio",
      role: "other",
      sampleRateHz: 48_000,
      segments: [{
        assetRange: { endUs: 10_000_000, startUs: 0 },
        bytes: 100,
        codec: "aac",
        container: "mov",
        fileRange: { endUs: 10_000_000, startUs: 0 },
        path: "artifacts/transmute/projects/project_safety001/imports/imported-camera.mov",
        sha256: HASH,
        streamIndex: 1,
      }],
      streamId: "stream_importedaudio01",
    }],
  });
  await addAssetToProject(open, asset, 0, new Date(LATER));
  return await openProject(join(open.directory.path, ".."), String(open.project.projectId));
}

async function markPlacementUnverified(open: OpenProject, placementId: string): Promise<OpenProject> {
  const project = VideoProjectV1Schema.parse({
    ...open.project,
    placements: open.project.placements.map(placement => placement.placementId === placementId
      ? {
          ...placement,
          sync: {
            ...placement.sync,
            provenance: { kind: "unverified", reason: "initial-placement" },
          },
        }
      : placement),
    updatedAt: LATER,
  });
  const plan = createDefaultProjectEditPlan(
    project,
    EditPlanIdSchema.parse("plan_unverifiedreference"),
    LATER,
  );
  await saveProjectEditPlan(open.fileSystem, plan);
  await saveVideoProject(open.fileSystem, project);
  return await openProject(join(open.directory.path, ".."), String(project.projectId));
}

function alignmentAnalysis(
  project: OpenProject["project"],
  options: { readonly staleSubject?: boolean } = {},
): AudioAlignmentAnalysisV1 {
  const asset = project.assets[0]!;
  const referencePlacement = project.placements.find(
    placement => placement.placementId === "placement_safety001",
  )!;
  const targetPlacement = project.placements.find(
    placement => placement.placementId === "placement_shifted01",
  )!;
  const reference = resolveAudioAnalysisSubject(
    project,
    `${asset.assetId}:stream_system001`,
  ).subject;
  const target = resolveAudioAnalysisSubject(
    project,
    `${asset.assetId}:stream_microphone01`,
  ).subject;
  const storedReference = options.staleSubject
    ? { ...reference, integritySha256: "f".repeat(64) }
    : reference;
  const config = {
    analysisSampleRateHz: 8_000,
    maxDriftPpm: 5_000,
    minimumOverlapUs: 3_000_000,
    windowUs: 5_000_000,
  } as const;
  return AudioAlignmentAnalysisV1Schema.parse({
    analysisId: "analysis_alignsafety",
    config,
    createdAt: LATER,
    inputDigest: alignmentInputDigest({
      config,
      reference: storedReference,
      referencePlacement,
      target,
      targetPlacement,
    }),
    kind: "studio.audio-alignment-analysis",
    matches: [],
    reference: storedReference,
    result: {
      candidates: [{
        ambiguity: 0,
        anchors: [
          { referenceAssetTimeUs: 0, targetAssetTimeUs: 3_000_000 },
          { referenceAssetTimeUs: 7_000_000, targetAssetTimeUs: 10_000_000 },
        ],
        autoApplicable: true,
        candidateId: "candidate_safety001",
        confidence: 0.99,
        driftPpm: 0,
        initialOffsetUs: -3_000_000,
        maxResidualUs: 0,
        medianResidualUs: 0,
        overlapUs: 7_000_000,
        peakRatio: 4,
      }],
      status: "matched",
    },
    schemaVersion: 1,
    target,
    tool: { name: "test-aligner", profile: "fixture", version: "1" },
  });
}

async function installAlignment(
  open: OpenProject,
  analysis: AudioAlignmentAnalysisV1,
): Promise<OpenProject> {
  const path = projectAnalysisPath("alignment", analysis.analysisId);
  await saveAnalysisArtifact(open.fileSystem, analysis, path);
  const project = VideoProjectV1Schema.parse({
    ...open.project,
    analyses: [{
      analysisId: analysis.analysisId,
      confidence: 0.99,
      createdAt: analysis.createdAt,
      driftPpm: 0,
      kind: "audio-alignment",
      path,
      referencePlacementId: "placement_safety001",
      sha256: sha256Hex(`${canonicalJson(analysis)}\n`),
      targetPlacementId: "placement_shifted01",
    }],
    updatedAt: LATER,
  });
  await saveVideoProject(open.fileSystem, project);
  return await openProject(join(open.directory.path, ".."), String(project.projectId));
}

function speechAnalysis(project: OpenProject["project"]): SpeechAnalysisV1 {
  const asset = project.assets[0]!;
  const subject = resolveAudioAnalysisSubject(
    project,
    `${asset.assetId}:stream_microphone01`,
  ).subject;
  return SpeechAnalysisV1Schema.parse({
    analysisId: "analysis_speechsafety",
    config: { language: "en", minimumFillerConfidence: 0.8, speechHandleUs: 200_000 },
    createdAt: LATER,
    durationUs: 10_000_000,
    inputDigest: HASH,
      kind: "studio.speech-analysis",
    result: {
      detectedLanguage: "en",
      fillers: [{
        acousticBoundaryConfidence: 0.99,
        autoApplicable: true,
        candidateId: "filler_safety001",
        classification: "filled-pause",
        confidence: 0.99,
        musicProtected: false,
        range: { endUs: 5_400_000, startUs: 5_000_000 },
        recommendedCut: { endUs: 5_600_000, startUs: 4_800_000 },
        text: "um",
        wordEndExclusive: 1,
        wordStart: 0,
      }],
      status: "transcribed",
      utterances: [],
      words: [{
        confidence: 0.99,
        range: { endUs: 5_400_000, startUs: 5_000_000 },
        speaker: null,
        text: "um",
        wordIndex: 0,
      }],
    },
    schemaVersion: 1,
    subject,
    tool: { name: "test-speech", profile: "fixture", version: "1" },
  });
}

function otherSpeechAnalysis(
  project: OpenProject["project"],
  status: "no-speech" | "overlap",
): SpeechAnalysisV1 {
  const asset = project.assets[0]!;
  const subject = resolveAudioAnalysisSubject(
    project,
    `${asset.assetId}:stream_system001`,
  ).subject;
  return SpeechAnalysisV1Schema.parse({
    analysisId: "analysis_speechsystem",
    config: { language: "en", minimumFillerConfidence: 0.8, speechHandleUs: 200_000 },
    createdAt: LATER,
    durationUs: 10_000_000,
    inputDigest: HASH,
      kind: "studio.speech-analysis",
    result: status === "no-speech"
      ? { detectedLanguage: null, reason: "no-speech", status: "no-speech" }
      : {
          detectedLanguage: "en",
          fillers: [],
          status: "transcribed",
          utterances: [{
            range: { endUs: 5_300_000, startUs: 5_000_000 },
            text: "keep this",
            wordEndExclusive: 1,
            wordStart: 0,
          }],
          words: [{
            confidence: 0.99,
            range: { endUs: 5_300_000, startUs: 5_000_000 },
            speaker: null,
            text: "keep this",
            wordIndex: 0,
          }],
        },
    schemaVersion: 1,
    subject,
    tool: { name: "test-speech", profile: "fixture", version: "1" },
  });
}

function musicAnalysis(
  project: OpenProject["project"],
  streamId: "stream_system001" | "stream_microphone01",
): MusicAnalysisV1 {
  const asset = project.assets[0]!;
  const subject = resolveAudioAnalysisSubject(project, `${asset.assetId}:${streamId}`).subject;
  return MusicAnalysisV1Schema.parse({
    analysisId: streamId === "stream_system001"
      ? "analysis_musicsystem"
      : "analysis_musicmicrophone",
    config: {
      hopSize: 256,
      minimumMusicUs: 500_000,
      sampleRateHz: 8_000,
      tempoWindowUs: 2_000_000,
      windowSize: 1_024,
    },
    createdAt: LATER,
    durationUs: 10_000_000,
    inputDigest: HASH,
    keyRegions: [],
    kind: "studio.music-analysis",
    musicRegions: [{ confidence: 1, range: { endUs: 8_500_000, startUs: 8_000_000 } }],
    schemaVersion: 1,
    subject,
    tempoRegions: [],
    tool: { name: "test-music", profile: "fixture", version: "1" },
  });
}

async function installSpeechAndMusic(
  open: OpenProject,
  options: { readonly music: boolean; readonly otherSpeech?: "no-speech" | "overlap" },
): Promise<OpenProject> {
  const speech = speechAnalysis(open.project);
  const speechPath = projectAnalysisPath("speech", speech.analysisId);
  await saveAnalysisArtifact(open.fileSystem, speech, speechPath);
  const analyses: Array<OpenProject["project"]["analyses"][number]> = [{
    analysisId: speech.analysisId,
    assetId: speech.subject.assetId,
    createdAt: speech.createdAt,
    fillerCount: speech.result.status === "transcribed" ? speech.result.fillers.length : 0,
    kind: "speech",
    path: speechPath,
    sha256: sha256Hex(`${canonicalJson(speech)}\n`),
    streamId: speech.subject.streamId,
    wordCount: speech.result.status === "transcribed" ? speech.result.words.length : 0,
  }];
  if (options.otherSpeech !== undefined) {
    const other = otherSpeechAnalysis(open.project, options.otherSpeech);
    const path = projectAnalysisPath("speech", other.analysisId);
    await saveAnalysisArtifact(open.fileSystem, other, path);
    analyses.push({
      analysisId: other.analysisId,
      assetId: other.subject.assetId,
      createdAt: other.createdAt,
      fillerCount: other.result.status === "transcribed" ? other.result.fillers.length : 0,
      kind: "speech",
      path,
      sha256: sha256Hex(`${canonicalJson(other)}\n`),
      streamId: other.subject.streamId,
      wordCount: other.result.status === "transcribed" ? other.result.words.length : 0,
    });
  }
  if (options.music) {
    for (const streamId of ["stream_system001", "stream_microphone01"] as const) {
      const music = musicAnalysis(open.project, streamId);
      const path = projectAnalysisPath("music", music.analysisId);
      await saveAnalysisArtifact(open.fileSystem, music, path);
      analyses.push({
        analysisId: music.analysisId,
        assetId: music.subject.assetId,
        createdAt: music.createdAt,
        keyRegions: music.keyRegions.length,
        kind: "music",
        musicRegions: music.musicRegions.length,
        path,
        sha256: sha256Hex(`${canonicalJson(music)}\n`),
        streamId: music.subject.streamId,
        tempoRegions: music.tempoRegions.length,
      });
    }
  }
  const project = VideoProjectV1Schema.parse({ ...open.project, analyses, updatedAt: LATER });
  await saveVideoProject(open.fileSystem, project);
  return await openProject(join(open.directory.path, ".."), String(project.projectId));
}

describe("project metadata and render safety", () => {
  test("persists a first-class camera push and compiles discontinuity-aware segments", async () => {
    const fixture = await projectFixture();
    try {
      const edit = await execute(fixture.paths, [
        "project", "edit", "project_safety001", "camera", "push",
        "--placement", "placement_safety001", "--stream", "stream_display01",
        "--from", "1s", "--to", "4s", "--center", "0.55,0.45", "--end-zoom", "2",
        "--json",
      ]);
      expect(edit).toMatchObject({ exitCode: 0, stderr: "" });
      const editReceipt = JSON.parse(edit.stdout) as {
        readonly cameraMoveId: string;
        readonly cameraMoves: number;
        readonly keyframeCount: number;
        readonly nextCommands: Readonly<{ readonly remove: string; readonly show: string }>;
        readonly operation: string;
        readonly selection: unknown;
      };
      expect(editReceipt).toMatchObject({
        cameraMoves: 1,
        keyframeCount: 2,
        operation: "push",
        selection: null,
      });
      expect(editReceipt.cameraMoveId).toStartWith("camera_");
      expect(editReceipt.nextCommands).toEqual({
        remove: `transmute project edit project_safety001 camera remove ${editReceipt.cameraMoveId} --json`,
        show: "transmute project edit project_safety001 camera show --json",
      });

      const render = await execute(fixture.paths, [
        "project", "render", "plan", "project_safety001", "--json",
      ]);
      expect(render).toMatchObject({ exitCode: 0, stderr: "" });
      const output = JSON.parse(render.stdout) as {
        readonly plan: {
          readonly cameraSegments: readonly {
            readonly cameraMoveId: string;
            readonly placementId: string;
            readonly streamId: string;
            readonly transforms: readonly unknown[];
          }[];
        };
      };
      expect(output.plan.cameraSegments).toHaveLength(1);
      expect(output.plan.cameraSegments[0]).toMatchObject({
        placementId: "placement_safety001",
        streamId: "stream_display01",
      });
      expect(output.plan.cameraSegments[0]?.cameraMoveId).toStartWith("camera_");
      expect(output.plan.cameraSegments[0]?.transforms).toHaveLength(1);

      const removed = await execute(fixture.paths, [
        "project", "edit", "project_safety001", "camera", "remove",
        editReceipt.cameraMoveId, "--json",
      ]);
      expect(removed).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(removed.stdout)).toMatchObject({
        cameraMoveId: editReceipt.cameraMoveId,
        cameraMoves: 0,
        keyframeCount: 2,
        nextCommands: {
          show: "transmute project edit project_safety001 camera show --json",
        },
        operation: "remove",
      });

      const human = await execute(fixture.paths, [
        "project", "edit", "project_safety001", "camera", "push",
        "--placement", "placement_safety001", "--stream", "stream_display01",
        "--from", "1s", "--to", "4s", "--center", "0.55,0.45", "--end-zoom", "2",
      ]);
      expect(human).toMatchObject({ exitCode: 0, stderr: "" });
      expect(human.stdout).toContain(`push ${editReceipt.cameraMoveId} keyframes=2`);
      expect(human.stdout).toContain(
        "show: transmute project edit project_safety001 camera show --json",
      );
      expect(human.stdout).toContain(
        `remove: transmute project edit project_safety001 camera remove ${editReceipt.cameraMoveId} --json`,
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("persists an arbitrary multi-keyframe camera path from the CLI", async () => {
    const fixture = await projectFixture();
    try {
      const edit = await execute(fixture.paths, [
        "project", "edit", "project_safety001", "camera", "path",
        "--placement", "placement_safety001", "--stream", "stream_display01",
        "--keyframe", "1s,0.5,0.5,1",
        "--keyframe", "2s,0.65,0.4,1.5",
        "--keyframe", "4s,0.35,0.55,2",
        "--json",
      ]);
      expect(edit).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(edit.stdout)).toMatchObject({
        cameraMoves: 1,
        keyframeCount: 3,
        operation: "path",
        selection: null,
      });

      const shown = await execute(fixture.paths, [
        "project", "edit", "project_safety001", "camera", "show", "--json",
      ]);
      expect(shown).toMatchObject({ exitCode: 0, stderr: "" });
      const output = JSON.parse(shown.stdout) as {
        readonly cameraMoves: readonly {
          readonly keyframes: readonly {
            readonly pose: Readonly<{ readonly centerX: number; readonly centerY: number; readonly zoom: number }>;
            readonly projectTimeUs: number;
          }[];
        }[];
      };
      expect(output.cameraMoves[0]?.keyframes).toMatchObject([
        { pose: { centerX: 0.5, centerY: 0.5, zoom: 1 }, projectTimeUs: 1_000_000 },
        { pose: { centerX: 0.65, centerY: 0.4, zoom: 1.5 }, projectTimeUs: 2_000_000 },
        { pose: { centerX: 0.35, centerY: 0.55, zoom: 2 }, projectTimeUs: 4_000_000 },
      ]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("persists a recording-backed project zoom and compiles it into the render plan", async () => {
    const fixture = await projectFixture();
    try {
      const edit = await execute(fixture.paths, [
        "project", "edit", "project_safety001", "zoom", "add",
        "--from", "1s", "--to", "3s", "--target", "point", "--point", "100,200",
        "--source-placement", "placement_safety001", "--json",
      ]);
      expect(edit).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(edit.stdout)).toMatchObject({ operation: "zoom-add", zooms: 1 });

      const render = await execute(fixture.paths, [
        "project", "render", "plan", "project_safety001", "--json",
      ]);
      expect(render).toMatchObject({ exitCode: 0, stderr: "" });
      const output = JSON.parse(render.stdout) as {
        readonly plan: {
          readonly cameraKeyframes: readonly {
            readonly displayId: string;
            readonly placementId: string;
            readonly streamId: string;
          }[];
        };
      };
      expect(output.plan.cameraKeyframes.length).toBeGreaterThan(0);
      expect(output.plan.cameraKeyframes.every(keyframe => (
        keyframe.displayId === "display-primary"
        && keyframe.placementId === "placement_safety001"
        && keyframe.streamId === "stream_display01"
      ))).toBe(true);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("rejects symlink output and plan leaves under project renders", async () => {
    const fixture = await projectFixture();
    try {
      const renders = join(fixture.project.directory.path, "renders");
      await mkdir(renders, { recursive: true });
      const protectedProjectFile = join(fixture.project.directory.path, "project.json");

      await symlink(protectedProjectFile, join(renders, "linked.mp4"));
      const outputLeaf = await execute(fixture.paths, [
        "project", "render", "plan", "project_safety001",
        "--output", "renders/linked.mp4", "--json",
      ]);
      expect(outputLeaf.exitCode).toBe(EXIT_CODE["unsafe-path"]);
      expect(JSON.parse(outputLeaf.stderr)).toMatchObject({ error: { code: "unsafe-path" } });

      await symlink(protectedProjectFile, join(renders, "safe.mp4.plan.json"));
      const planLeaf = await execute(fixture.paths, [
        "project", "render", "plan", "project_safety001",
        "--output", "renders/safe.mp4", "--json",
      ]);
      expect(planLeaf.exitCode).toBe(EXIT_CODE["unsafe-path"]);
      expect(JSON.parse(planLeaf.stderr)).toMatchObject({ error: { code: "unsafe-path" } });
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("rejects the immutable project plan path as a video output", async () => {
    const fixture = await projectFixture();
    try {
      const planned = await execute(fixture.paths, [
        "project", "render", "plan", "project_safety001", "--json",
      ]);
      expect(planned).toMatchObject({ exitCode: 0, stderr: "" });
      const planPath = (JSON.parse(planned.stdout) as { readonly planPath: string }).planPath;

      const result = await execute(fixture.paths, [
        "project", "render", "run", "project_safety001", "--output", planPath, "--json",
      ]);

      expect(result.exitCode).toBe(EXIT_CODE["unsafe-path"]);
      const failure = parseCliFailure(result.stderr);
      expect(failure.code).toBe("unsafe-path");
      expect(failure.message).toContain("reserved render-artifact subtree");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("rejects internal project render caches and non-MP4 leaves as video outputs", async () => {
    const fixture = await projectFixture();
    try {
      for (const output of [
        "renders/.overlay-cache/output.mp4",
        "renders/.filter-graphs/output.mp4",
        "renders/derived/output.mp4",
      ]) {
        const result = await execute(fixture.paths, [
          "project", "render", "run", "project_safety001", "--output", output, "--json",
        ]);
        expect(result.exitCode).toBe(EXIT_CODE["unsafe-path"]);
        expect(parseCliFailure(result.stderr).message).toContain("reserved render-artifact subtree");
      }

      const wrongExtension = await execute(fixture.paths, [
        "project", "render", "run", "project_safety001", "--output", "renders/final.json", "--json",
      ]);
      expect(wrongExtension.exitCode).toBe(EXIT_CODE.usage);
      expect(parseCliFailure(wrongExtension.stderr).message).toContain("final .mp4 file");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("preserves an existing render and sidecar when a new render is rejected", async () => {
    const fixture = await projectFixture();
    try {
      await addShiftedPlacement(fixture.project, { unverified: true });
      const renders = join(fixture.project.directory.path, "renders");
      await mkdir(renders, { recursive: true });
      const output = join(renders, "project.mp4");
      const sidecar = `${output}.plan.json`;
      await writeFile(output, "prior successful video", { mode: 0o600 });
      await writeFile(sidecar, "prior successful plan", { mode: 0o600 });

      const result = await execute(fixture.paths, [
        "project", "render", "run", "project_safety001", "--json",
      ]);

      expect(result.exitCode).toBe(EXIT_CODE.conflict);
      expect(await readFile(output, "utf8")).toBe("prior successful video");
      expect(await readFile(sidecar, "utf8")).toBe("prior successful plan");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("rejects an out-of-bounds project overlay before creating an asset", async () => {
    const fixture = await projectFixture();
    try {
      const source = join(fixture.root, "callout.png");
      const assets = join(fixture.project.directory.path, "assets");
      await writeFile(source, "not inspected because the range is invalid");

      const result = await execute(fixture.paths, [
        "project", "edit", "project_safety001", "overlay", "add",
        "--kind", "image", "--source", source,
        "--from", "9s", "--to", "11s", "--json",
      ]);

      expect(result.exitCode).toBe(EXIT_CODE.usage);
      expect(await readdir(assets).catch(() => [])).toEqual([]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
});

describe("recording inactivity safety", () => {
  test("keys recording plan and default output artifacts by the selected display composition", async () => {
    const fixture = await projectFixture();
    try {
      expect((await execute(fixture.paths, ["edit", "rec_example001", "init", "--json"])).exitCode).toBe(0);
      const primary = await execute(fixture.paths, [
        "render", "plan", "rec_example001", "--display", "display-primary", "--no-auto-inactivity", "--json",
      ]);
      const extended = await execute(fixture.paths, [
        "render", "plan", "rec_example001", "--display", "display-left", "--no-auto-inactivity", "--json",
      ]);
      expect(primary.exitCode).toBe(0);
      expect(extended.exitCode).toBe(0);
      const primaryOutput = JSON.parse(primary.stdout) as {
        readonly artifactPath: string;
        readonly defaultOutputPath: string;
        readonly display: { readonly displayId: string };
      };
      const extendedOutput = JSON.parse(extended.stdout) as typeof primaryOutput;

      expect(primaryOutput.display.displayId).toBe("display-primary");
      expect(extendedOutput.display.displayId).toBe("display-left");
      expect(primaryOutput.artifactPath).not.toBe(extendedOutput.artifactPath);
      expect(primaryOutput.defaultOutputPath).not.toBe(extendedOutput.defaultOutputPath);
      expect(JSON.parse(await readFile(
        join(fixture.paths.artifactRoot, "rec_example001", primaryOutput.artifactPath),
        "utf8",
      ))).toMatchObject({ composition: { baseDisplay: { displayId: "display-primary" } } });
      expect(JSON.parse(await readFile(
        join(fixture.paths.artifactRoot, "rec_example001", extendedOutput.artifactPath),
        "utf8",
      ))).toMatchObject({ composition: { baseDisplay: { displayId: "display-left" } } });
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("keeps recording receipts and canonical plans outside custom plan-output aliases", async () => {
    const fixture = await projectFixture();
    try {
      expect((await execute(fixture.paths, ["edit", "rec_example001", "init", "--json"])).exitCode).toBe(0);
      const recordingDirectory = join(fixture.paths.artifactRoot, "rec_example001");
      const receiptPath = "renders/final.mp4.plan.json";
      const reservedPlanPath = `renders/resolved-${"a".repeat(64)}.json`;
      await mkdir(join(recordingDirectory, "renders"), { recursive: true });
      await writeFile(join(recordingDirectory, receiptPath), "prior render receipt", { mode: 0o600 });
      await writeFile(join(recordingDirectory, reservedPlanPath), "prior canonical plan", { mode: 0o600 });

      const receiptCollision = await execute(fixture.paths, [
        "render", "plan", "rec_example001", "--no-auto-inactivity",
        "--output", receiptPath, "--json",
      ]);
      expect(receiptCollision.exitCode).toBe(EXIT_CODE["unsafe-path"]);
      expect(parseCliFailure(receiptCollision.stderr).message).toContain("video receipt");
      expect(await readFile(join(recordingDirectory, receiptPath), "utf8")).toBe("prior render receipt");

      const canonicalCollision = await execute(fixture.paths, [
        "render", "plan", "rec_example001", "--no-auto-inactivity",
        "--output", reservedPlanPath, "--json",
      ]);
      expect(canonicalCollision.exitCode).toBe(EXIT_CODE["unsafe-path"]);
      expect(parseCliFailure(canonicalCollision.stderr).message).toContain("canonical resolved-plan namespace");
      expect(await readFile(join(recordingDirectory, reservedPlanPath), "utf8")).toBe("prior canonical plan");

      const canonical = await execute(fixture.paths, [
        "render", "plan", "rec_example001", "--no-auto-inactivity", "--json",
      ]);
      expect(canonical).toMatchObject({ exitCode: 0, stderr: "" });
      const ownArtifact = (JSON.parse(canonical.stdout) as { readonly artifactPath: string }).artifactPath;
      const ownBytes = await readFile(join(recordingDirectory, ownArtifact));
      const exactOwnOutput = await execute(fixture.paths, [
        "render", "plan", "rec_example001", "--no-auto-inactivity",
        "--output", ownArtifact, "--json",
      ]);
      expect(exactOwnOutput).toMatchObject({ exitCode: 0, stderr: "" });
      expect(await readFile(join(recordingDirectory, ownArtifact))).toEqual(ownBytes);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("keeps a committed overlay asset when receipt output fails after the plan save", async () => {
    const fixture = await projectFixture();
    try {
      const initialized = await execute(fixture.paths, ["edit", "rec_example001", "init", "--json"]);
      expect(initialized.exitCode).toBe(0);
      const source = join(fixture.root, "callout.svg");
      await writeFile(source, "<svg xmlns='http://www.w3.org/2000/svg' width='32' height='24'></svg>");
      let stderr = "";
      const io: CliIo = {
        cwd: () => fixture.paths.repositoryRoot,
        env: {},
        now: () => NOW,
        platform: process.platform,
        stderr: value => { stderr += value; },
        stdout: () => { throw new Error("simulated closed stdout"); },
      };

      const exitCode = await runCli([
        "edit", "rec_example001", "overlay", "add",
        "--kind", "svg", "--source", source,
        "--from", "1s", "--to", "2s", "--json",
      ], { io, paths: fixture.paths, runner: rejectingRunner() });

      expect(exitCode).toBe(EXIT_CODE.internal);
      expect(stderr).toContain("simulated closed stdout");
      const recording = await openRecording(fixture.paths.artifactRoot, "rec_example001");
      const plan = await loadCurrentPlan(recording);
      expect(plan.overlays).toHaveLength(1);
      const asset = plan.overlays[0]!.source.asset;
      expect((await readFile(join(recording.directory.path, asset.path))).byteLength).toBe(asset.bytes);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("persists selected absolute overlay stream indices from the visual probe", async () => {
    const fixture = await projectFixture();
    try {
      expect((await execute(fixture.paths, ["edit", "rec_example001", "init", "--json"])).exitCode).toBe(0);
      const source = join(fixture.root, "cover-before-motion.webm");
      await writeFile(source, Uint8Array.from([
        0x1a, 0x45, 0xdf, 0xa3,
        ...new TextEncoder().encode("synthetic visual container"),
      ]));
      const runner: ProcessRunner = {
        run: argv => {
          subprocessCalls.push([...argv]);
          return Promise.resolve(argv.includes("-show_entries") ? {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify({
                format: { duration: "2" },
                streams: [{
                  codec_type: "video",
                  disposition: { attached_pic: 1 },
                  height: 600,
                  index: 0,
                  width: 600,
                }, {
                  codec_type: "audio",
                  index: 7,
                  tags: { DURATION: "00:00:01.000000000" },
                }, {
                  codec_type: "video",
                  height: 360,
                  index: 4,
                  tags: { DURATION: "00:00:02.000000000" },
                  width: 640,
                }],
              }),
            } : { exitCode: 0, stderr: "", stdout: "fixture tool 1.0" });
        },
      };
      const subprocessCalls: string[][] = [];
      let stderr = "";
      let stdout = "";
      const io: CliIo = {
        cwd: () => fixture.paths.repositoryRoot,
        env: {},
        now: () => NOW,
        platform: process.platform,
        stderr: value => { stderr += value; },
        stdout: value => { stdout += value; },
      };

      const exitCode = await runCli([
        "edit", "rec_example001", "overlay", "add",
        "--kind", "video", "--source", source,
        "--from", "1s", "--to", "2s",
        "--animated-audio", "mix", "--json",
      ], { io, paths: fixture.paths, runner });

      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
      expect(subprocessCalls.some(argv => (
        argv[0]?.includes("Google Chrome.app") === true
        || argv[0] === "/usr/bin/codesign"
      ))).toBe(false);
      expect(subprocessCalls.some(argv => argv.includes("-show_entries"))).toBe(true);
      expect(stdout).not.toBe("");
      const recording = await openRecording(fixture.paths.artifactRoot, "rec_example001");
      const plan = await loadCurrentPlan(recording);
      const overlay = plan.overlays[0];
      if (overlay?.source.kind !== "video") throw new Error("Expected persisted video overlay.");
      expect(overlay.source.playback).toMatchObject({ audioStreamIndex: 7, videoStreamIndex: 4 });
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("rejects edits and renders against a mutable recording before persisting a stale plan", async () => {
    const fixture = await projectFixture();
    try {
      const recordingDirectory = join(fixture.paths.artifactRoot, "rec_example001");
      await saveRecordingManifest(
        createNodeBundleFileSystem(recordingDirectory),
        { ...testManifest(), state: "paused" },
      );

      const edit = await execute(fixture.paths, ["edit", "rec_example001", "init", "--json"]);
      const render = await execute(fixture.paths, ["render", "plan", "rec_example001", "--json"]);

      expect(edit.exitCode).toBe(EXIT_CODE.conflict);
      expect(render.exitCode).toBe(EXIT_CODE.conflict);
      expect(await readdir(join(recordingDirectory, "edits")).catch(() => [])).toEqual([]);
      expect(await readdir(join(recordingDirectory, "renders")).catch(() => [])).toEqual([]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("rejects a recording that is not stopped before probing media or writing analysis", async () => {
    const fixture = await projectFixture();
    try {
      const recordingDirectory = join(fixture.paths.artifactRoot, "rec_example001");
      await saveRecordingManifest(
        createNodeBundleFileSystem(recordingDirectory),
        { ...testManifest(), state: "paused" },
      );
      const result = await execute(fixture.paths, [
        "analyze", "inactivity", "rec_example001", "--apply", "--json",
      ]);
      expect(result.exitCode).toBe(EXIT_CODE.conflict);
      const failure = parseCliFailure(result.stderr);
      expect(failure.message).toContain("requires a stopped recording");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
});

describe("project inactivity synchronization safety", () => {
  test("rejects --apply before probing when an imported placement has unverified sync", async () => {
    const fixture = await projectFixture();
    try {
      await addImportedVideoPlacement(fixture.project);
      const planPath = join(fixture.project.directory.path, "edits", "current.json");
      const beforePlan = await readFile(planPath);

      const result = await execute(fixture.paths, [
        "analyze", "inactivity", "project_safety001", "--apply", "--json",
      ]);

      expect(result.exitCode).toBe(EXIT_CODE.conflict);
      const failure = parseCliFailure(result.stderr);
      expect(failure.details).toEqual({ unverifiedPlacements: ["placement_importedvideo01_1"] });
      expect(failure.message).toContain("verified synchronization");
      expect(await readFile(planPath)).toEqual(beforePlan);
      expect(await readdir(join(fixture.project.directory.path, "analysis")).catch(() => []))
        .toEqual([]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
});

describe("alignment command safety", () => {
  test("rejects analysis between two streams on the same placement before invoking FFmpeg", async () => {
    const fixture = await projectFixture();
    try {
      const result = await execute(fixture.paths, [
        "align", "analyze", "project_safety001",
        "--reference", "asset_safety001:stream_system001",
        "--target", "asset_safety001:stream_microphone01",
        "--json",
      ]);
      expect(result.exitCode).toBe(EXIT_CODE.conflict);
      const failure = parseCliFailure(result.stderr);
      expect(failure.code).toBe("conflict");
      expect(failure.message).toContain("different placements");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("rejects a stored alignment whose subject no longer matches current stream integrity", async () => {
    const fixture = await projectFixture();
    try {
      const shifted = await addShiftedPlacement(fixture.project);
      await installAlignment(shifted, alignmentAnalysis(shifted.project, { staleSubject: true }));
      const result = await execute(fixture.paths, [
        "align", "apply", "project_safety001", "analysis_alignsafety",
        "--candidate", "candidate_safety001", "--json",
      ]);
      expect(result.exitCode).toBe(EXIT_CODE.conflict);
      const failure = parseCliFailure(result.stderr);
      expect(failure.code).toBe("conflict");
      expect(failure.message).toContain("stale");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("rejects applying an alignment through an unverified reference placement", async () => {
    const fixture = await projectFixture();
    try {
      const shifted = await addShiftedPlacement(fixture.project);
      const unverified = await markPlacementUnverified(shifted, "placement_safety001");
      await installAlignment(unverified, alignmentAnalysis(unverified.project));

      const result = await execute(fixture.paths, [
        "align", "apply", "project_safety001", "analysis_alignsafety",
        "--candidate", "candidate_safety001", "--json",
      ]);

      expect(result.exitCode).toBe(EXIT_CODE.conflict);
      const failure = parseCliFailure(result.stderr);
      expect(failure.message).toContain("unverified-reference-sync");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("rejects a valid-but-tampered alignment sidecar", async () => {
    const fixture = await projectFixture();
    try {
      const shifted = await addShiftedPlacement(fixture.project);
      const analysis = alignmentAnalysis(shifted.project);
      const installed = await installAlignment(shifted, analysis);
      await saveAnalysisArtifact(installed.fileSystem, AudioAlignmentAnalysisV1Schema.parse({
        ...analysis,
        tool: { ...analysis.tool, version: "tampered" },
      }), projectAnalysisPath("alignment", analysis.analysisId));

      const result = await execute(fixture.paths, [
        "align", "apply", "project_safety001", "analysis_alignsafety",
        "--candidate", "candidate_safety001", "--json",
      ]);
      expect(result.exitCode).toBe(EXIT_CODE["invalid-data"]);
      const failure = parseCliFailure(result.stderr);
      expect(failure.code).toBe("invalid-data");
      expect(failure.message).toContain("integrity check");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
});

describe("global filler music protection", () => {
  test("rejects a structural filler cut while an imported placement has unverified sync", async () => {
    const fixture = await projectFixture();
    try {
      await addImportedVideoPlacement(fixture.project);
      const planPath = join(fixture.project.directory.path, "edits", "current.json");
      const beforePlan = await readFile(planPath);

      const result = await execute(fixture.paths, [
        "fillers", "apply", "project_safety001", "analysis_speechsafety", "filler_safety001",
        "--placement", "placement_safety001", "--json",
      ]);

      expect(result.exitCode).toBe(EXIT_CODE.conflict);
      const failure = parseCliFailure(result.stderr);
      expect(failure.details).toEqual({ unverifiedPlacements: ["placement_importedvideo01_1"] });
      expect(failure.message).toContain("verified synchronization");
      expect(await readFile(planPath)).toEqual(beforePlan);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("fails closed when any enabled audio stream lacks a current music analysis", async () => {
    const fixture = await projectFixture();
    try {
      await installSpeechAndMusic(fixture.project, { music: false });
      const result = await execute(fixture.paths, [
        "fillers", "apply", "project_safety001", "analysis_speechsafety", "filler_safety001",
        "--placement", "placement_safety001", "--json",
      ]);
      expect(result.exitCode).toBe(EXIT_CODE.conflict);
      const failure = parseCliFailure(result.stderr);
      expect(failure.code).toBe("conflict");
      expect(failure.details).toEqual({
        missing: [
          "placement_safety001:stream_system001",
          "placement_safety001:stream_microphone01",
        ],
      });
      expect(failure.message).toContain("analyze every enabled audio stream");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("projects music ranges through every placement before deciding a global filler cut", async () => {
    const fixture = await projectFixture();
    try {
      const shifted = await addShiftedPlacement(fixture.project);
      await installSpeechAndMusic(shifted, { music: true });
      const result = await execute(fixture.paths, [
        "fillers", "apply", "project_safety001", "analysis_speechsafety", "filler_safety001",
        "--placement", "placement_safety001", "--json",
      ]);
      expect(result.exitCode).toBe(EXIT_CODE.conflict);
      const failure = parseCliFailure(result.stderr);
      expect(failure.code).toBe("conflict");
      expect(failure.message).toContain("music-protected");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("fails closed when another enabled audio stream lacks speech evidence", async () => {
    const fixture = await projectFixture();
    try {
      await installSpeechAndMusic(fixture.project, { music: true });
      const result = await execute(fixture.paths, [
        "fillers", "apply", "project_safety001", "analysis_speechsafety", "filler_safety001",
        "--placement", "placement_safety001", "--json",
      ]);

      expect(result.exitCode).toBe(EXIT_CODE.conflict);
      const failure = parseCliFailure(result.stderr);
      expect(failure.message).toContain("Speech protection is incomplete");
      expect(failure.details).toEqual({
        missing: ["placement_safety001:stream_system001"],
      });
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("rejects a global filler cut that overlaps speech on another enabled stream", async () => {
    const fixture = await projectFixture();
    try {
      await installSpeechAndMusic(fixture.project, { music: true, otherSpeech: "overlap" });
      const result = await execute(fixture.paths, [
        "fillers", "apply", "project_safety001", "analysis_speechsafety", "filler_safety001",
        "--placement", "placement_safety001", "--json",
      ]);

      expect(result.exitCode).toBe(EXIT_CODE.conflict);
      const failure = parseCliFailure(result.stderr);
      expect(failure.message).toContain("overlaps speech on another enabled audio stream");
      expect(failure.details).toMatchObject({
        overlaps: [{ placementId: "placement_safety001", streamId: "stream_system001", word: "keep this" }],
      });
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("applies a global filler cut when every other enabled stream has complete no-speech evidence", async () => {
    const fixture = await projectFixture();
    try {
      await installSpeechAndMusic(fixture.project, { music: true, otherSpeech: "no-speech" });
      const result = await execute(fixture.paths, [
        "fillers", "apply", "project_safety001", "analysis_speechsafety", "filler_safety001",
        "--placement", "placement_safety001", "--json",
      ]);

      expect(result).toMatchObject({ exitCode: 0, stderr: "" });
      expect(JSON.parse(result.stdout)).toMatchObject({
        candidateId: "filler_safety001",
        projectRange: { endUs: 5_600_000, startUs: 4_800_000 },
      });
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("rejects a filler cut when analyzed audio bytes changed before plan mutation", async () => {
    const fixture = await projectFixture();
    try {
      await installSpeechAndMusic(fixture.project, { music: true, otherSpeech: "no-speech" });
      const planPath = join(fixture.project.directory.path, "edits", "current.json");
      const beforePlan = await readFile(planPath);
      await writeFile(
        join(fixture.paths.artifactRoot, "rec_example001", "media", "segment-1.mp4"),
        "y".repeat(100),
      );

      const result = await execute(fixture.paths, [
        "fillers", "apply", "project_safety001", "analysis_speechsafety", "filler_safety001",
        "--placement", "placement_safety001", "--json",
      ]);

      expect(result.exitCode).toBe(EXIT_CODE["invalid-data"]);
      expect(parseCliFailure(result.stderr).message).toContain("SHA-256 integrity check");
      expect(await readFile(planPath)).toEqual(beforePlan);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
});
