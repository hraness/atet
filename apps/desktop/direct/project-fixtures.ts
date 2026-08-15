import { z } from "zod";
import { SCENE_UPLOAD_POLICY } from "@hraness/atet/scene";

import {
  AudioAlignmentAnalysisV1Schema,
  AlignmentCandidateIdSchema,
  FaceAnalysisV1Schema,
  MusicAnalysisV1Schema,
  ProjectAssetV1Schema,
  ProjectCameraMoveSchema,
  ProjectEditPlanV1Schema,
  ProjectPlacementV1Schema,
  SceneAnalysisV1Schema,
  SpeechAnalysisV1Schema,
  VideoProjectV1Schema,
  type AudioAlignmentAnalysisV1,
  type FaceAnalysisV1,
  type ProjectAssetV1,
  type ProjectPlacementV1,
} from "../contracts";
import {
  applyAudioAlignmentCandidate,
  projectFillerCut,
} from "../core/alignment-apply";
import {
  assertProjectCameraMoveBindings,
  hashProjectCameraGeometry,
  hashProjectCameraSync,
} from "../core/project-camera";
import {
  hashPlacementSync,
  hashProjectEditPlan,
  hashProjectStructure,
} from "../core/project-plan";
import { projectToAssetUs } from "../core/project-time";
import { FaceFramingGapPolicySchema } from "../core/face-framing";
import { ProjectCameraCreateReceiptSchema } from "../cli/project-camera-receipt";
import { planProjectFaceCamera } from "../cli/project-face-camera";

const TIMESTAMP = "2026-07-22T16:00:00.000Z";
const PROJECT_DURATION_US = 42_000_000;
const SCREEN_DURATION_US = PROJECT_DURATION_US;
const CAMERA_A_DURATION_US = 41_200_000;
const CAMERA_B_DURATION_US = 41_700_000;

const SHA = Object.freeze({
  alignA: "1".repeat(64),
  alignB: "2".repeat(64),
  cameraA: "3".repeat(64),
  cameraB: "4".repeat(64),
  emoji: "5".repeat(64),
  face: "f".repeat(64),
  gif: "6".repeat(64),
  image: "7".repeat(64),
  music: "8".repeat(64),
  sceneCamera: "9".repeat(64),
  sceneScreen: "a".repeat(64),
  screen: "b".repeat(64),
  speech: "c".repeat(64),
  svg: "d".repeat(64),
  video: "e".repeat(64),
});

const ID = Object.freeze({
  alignA: "analysis_aligncam_a1",
  alignB: "analysis_aligncam_b1",
  assetCameraA: "asset_camera_a1",
  assetCameraB: "asset_camera_b1",
  assetScreen: "asset_screen_01",
  candidateA: "candidate_camera_a1",
  candidateAAlternate: "candidate_camera_a2",
  candidateB: "candidate_camera_b1",
  fillerContextual: "filler_context01",
  fillerMusic: "filler_music001",
  fillerSafe: "filler_safe0001",
  faceAnalysis: "analysis_facescam1",
  faceTrackA: "face_track00001",
  faceTrackB: "face_track00002",
  cameraFace: "camera_faces0001",
  cameraKenBurns: "camera_kenburns001",
  music: "analysis_music0001",
  placementCameraA: "placement_camera_a1",
  placementCameraB: "placement_camera_b1",
  placementScreen: "placement_screen01",
  project: "project_agentdemo1",
  sceneCamera: "analysis_scenecam1",
  sceneScreen: "analysis_screens01",
  speech: "analysis_speech001",
  streamCameraAAudio: "stream_cam_a_audio",
  streamCameraAVideo: "stream_cam_a_video",
  streamCameraBAudio: "stream_cam_b_audio",
  streamCameraBVideo: "stream_cam_b_video",
  streamScreenAudio: "stream_screen_audio",
  streamScreenVideo: "stream_screen_video",
});

const TOOL = Object.freeze({ name: "atet-core", profile: "direct-fixture", version: "1" });

function mediaSegment(
  durationUs: number,
  path: string,
  sha256: string,
  streamIndex: number,
  kind: "audio" | "video",
) {
  return {
    assetRange: { endUs: durationUs, startUs: 0 },
    // Both logical streams point at the same immutable MP4, so whole-file
    // integrity (including byte length) must agree across stream identities.
    bytes: 48_000_000,
    codec: kind === "video" ? "h264" : "aac",
    container: "mp4",
    fileRange: { endUs: durationUs, startUs: 0 },
    path,
    sha256,
    streamIndex,
  };
}

function importedSource(originalName: string, sourceSha256: string) {
  return { importedAt: TIMESTAMP, kind: "imported" as const, originalName, sourceSha256 };
}

function screenAsset(): ProjectAssetV1 {
  const path = "artifacts/atet/private/imports/screen-demo.mp4";
  return ProjectAssetV1Schema.parse({
    assetId: ID.assetScreen,
    createdAt: TIMESTAMP,
    durationUs: SCREEN_DURATION_US,
    label: "Laptop screen + system audio",
    role: "screen",
    source: importedSource("screen-demo.mp4", SHA.screen),
    streams: [
      {
        frameRate: 60,
        kind: "video",
        label: "Laptop display",
        pixelHeight: 1800,
        pixelWidth: 2880,
        role: "screen",
        segments: [mediaSegment(SCREEN_DURATION_US, path, SHA.screen, 0, "video")],
        streamId: ID.streamScreenVideo,
      },
      {
        channels: 2,
        kind: "audio",
        label: "System mix",
        role: "system-audio",
        sampleRateHz: 48_000,
        segments: [mediaSegment(SCREEN_DURATION_US, path, SHA.screen, 1, "audio")],
        streamId: ID.streamScreenAudio,
      },
    ],
  });
}

function cameraAsset(options: {
  readonly assetId: string;
  readonly audioRole: "dialogue" | "portable-audio";
  readonly audioStreamId: string;
  readonly durationUs: number;
  readonly label: string;
  readonly originalName: string;
  readonly path: string;
  readonly sha256: string;
  readonly videoStreamId: string;
}): ProjectAssetV1 {
  return ProjectAssetV1Schema.parse({
    assetId: options.assetId,
    createdAt: TIMESTAMP,
    durationUs: options.durationUs,
    label: options.label,
    role: "camera",
    source: importedSource(options.originalName, options.sha256),
    streams: [
      {
        frameRate: 30,
        kind: "video",
        label: `${options.label} picture`,
        pixelHeight: 2160,
        pixelWidth: 3840,
        role: "camera",
        segments: [mediaSegment(options.durationUs, options.path, options.sha256, 0, "video")],
        streamId: options.videoStreamId,
      },
      {
        channels: 2,
        kind: "audio",
        label: `${options.label} audio`,
        role: options.audioRole,
        sampleRateHz: 48_000,
        segments: [mediaSegment(options.durationUs, options.path, options.sha256, 1, "audio")],
        streamId: options.audioStreamId,
      },
    ],
  });
}

function placement(options: {
  readonly asset: ProjectAssetV1;
  readonly audioStreamId: string;
  readonly layout: { readonly height: number; readonly width: number; readonly x: number; readonly y: number };
  readonly placementId: string;
  readonly videoStreamId: string;
}): ProjectPlacementV1 {
  return ProjectPlacementV1Schema.parse({
    assetId: options.asset.assetId,
    assetRange: { endUs: options.asset.durationUs, startUs: 0 },
    audio: [{
      presentation: { enabled: true, gainDb: 0, pan: 0 },
      streamId: options.audioStreamId,
    }],
    enabled: true,
    placementId: options.placementId,
    sync: {
      anchors: [
        { assetTimeUs: 0, projectTimeUs: 0 },
        { assetTimeUs: options.asset.durationUs, projectTimeUs: PROJECT_DURATION_US },
      ],
      provenance: options.asset.role === "screen"
        ? { kind: "identity" }
        : { kind: "unverified", reason: "initial-placement" },
    },
    video: [{
      presentation: {
        blendMode: "normal",
        crop: options.asset.role === "screen"
          ? { kind: "none" }
          : { bottom: 0.04, kind: "normalized-insets", left: 0.08, right: 0.08, top: 0.02 },
        enabled: true,
        fit: options.asset.role === "screen" ? "contain" : "cover",
        layer: options.asset.role === "screen" ? 0 : 10,
        layout: { kind: "normalized", ...options.layout },
        opacity: 1,
      },
      streamId: options.videoStreamId,
    }],
  });
}

function createAlignmentAnalyses(): readonly [AudioAlignmentAnalysisV1, AudioAlignmentAnalysisV1] {
  const reference = {
    assetId: ID.assetScreen,
    integritySha256: SHA.screen,
    streamId: ID.streamScreenAudio,
  };
  const common = {
    config: {
      analysisSampleRateHz: 8_000,
      maxDriftPpm: 2_000,
      minimumOverlapUs: 5_000_000,
      windowUs: 2_000_000,
    },
    createdAt: TIMESTAMP,
    kind: "atet.audio-alignment-analysis" as const,
    reference,
    schemaVersion: 1 as const,
    tool: TOOL,
  };
  const cameraA = AudioAlignmentAnalysisV1Schema.parse({
    ...common,
    analysisId: ID.alignA,
    inputDigest: SHA.alignA,
    matches: [
      { ambiguity: 0.04, confidence: 0.98, referenceAssetTimeUs: 800_000, targetAssetTimeUs: 0, windowUs: 2_000_000 },
      { ambiguity: 0.05, confidence: 0.97, referenceAssetTimeUs: 21_400_000, targetAssetTimeUs: 20_600_000, windowUs: 2_000_000 },
      { ambiguity: 0.04, confidence: 0.99, referenceAssetTimeUs: 42_000_000, targetAssetTimeUs: CAMERA_A_DURATION_US, windowUs: 2_000_000 },
    ],
    result: {
      candidates: [
        {
          ambiguity: 0.04,
          anchors: [
            { referenceAssetTimeUs: 800_000, targetAssetTimeUs: 0 },
            { referenceAssetTimeUs: 21_400_000, targetAssetTimeUs: 20_600_000 },
            { referenceAssetTimeUs: 42_000_000, targetAssetTimeUs: CAMERA_A_DURATION_US },
          ],
          autoApplicable: true,
          candidateId: ID.candidateA,
          confidence: 0.98,
          driftPpm: 0,
          initialOffsetUs: 800_000,
          maxResidualUs: 2_100,
          medianResidualUs: 900,
          overlapUs: CAMERA_A_DURATION_US,
          peakRatio: 4.8,
        },
        {
          ambiguity: 0.55,
          anchors: [
            { referenceAssetTimeUs: 1_300_000, targetAssetTimeUs: 0 },
            { referenceAssetTimeUs: 42_000_000, targetAssetTimeUs: 40_700_000 },
          ],
          autoApplicable: false,
          candidateId: ID.candidateAAlternate,
          confidence: 0.61,
          driftPpm: 0,
          initialOffsetUs: 1_300_000,
          maxResidualUs: 118_000,
          medianResidualUs: 62_000,
          overlapUs: 40_700_000,
          peakRatio: 1.15,
        },
      ],
      status: "matched",
    },
    target: {
      assetId: ID.assetCameraA,
      integritySha256: SHA.cameraA,
      streamId: ID.streamCameraAAudio,
    },
  });
  const cameraB = AudioAlignmentAnalysisV1Schema.parse({
    ...common,
    analysisId: ID.alignB,
    inputDigest: SHA.alignB,
    matches: [
      { ambiguity: 0.08, confidence: 0.95, referenceAssetTimeUs: 300_000, targetAssetTimeUs: 0, windowUs: 2_000_000 },
      { ambiguity: 0.07, confidence: 0.96, referenceAssetTimeUs: 20_150_000, targetAssetTimeUs: 19_850_000, windowUs: 2_000_000 },
      { ambiguity: 0.09, confidence: 0.94, referenceAssetTimeUs: 41_999_000, targetAssetTimeUs: CAMERA_B_DURATION_US, windowUs: 2_000_000 },
    ],
    result: {
      candidates: [{
        ambiguity: 0.08,
        anchors: [
          { referenceAssetTimeUs: 300_000, targetAssetTimeUs: 0 },
          { referenceAssetTimeUs: 20_150_000, targetAssetTimeUs: 19_850_000 },
          { referenceAssetTimeUs: 41_999_000, targetAssetTimeUs: CAMERA_B_DURATION_US },
        ],
        autoApplicable: true,
        candidateId: ID.candidateB,
        confidence: 0.95,
        driftPpm: -24,
        initialOffsetUs: 300_000,
        maxResidualUs: 3_200,
        medianResidualUs: 1_400,
        overlapUs: CAMERA_B_DURATION_US,
        peakRatio: 3.7,
      }],
      status: "matched",
    },
    target: {
      assetId: ID.assetCameraB,
      integritySha256: SHA.cameraB,
      streamId: ID.streamCameraBAudio,
    },
  });
  return [cameraA, cameraB];
}

function createFaceAnalysis(
  assetRange: Readonly<{ readonly endUs: number; readonly startUs: number }>,
): FaceAnalysisV1 {
  const sampleIntervalUs = Math.floor((assetRange.endUs - assetRange.startUs) / 4);
  if (sampleIntervalUs <= 0) {
    throw new Error("Direct face evidence requires a positive asset range.");
  }
  const sampleTimesUs = [
    assetRange.startUs,
    assetRange.startUs + sampleIntervalUs,
    assetRange.startUs + sampleIntervalUs * 2,
    assetRange.startUs + sampleIntervalUs * 3,
    assetRange.endUs - 100_000,
  ];
  const detections = [
    [
      { confidence: 0.98, rect: { height: 0.24, width: 0.18, x: 0.18, y: 0.2 }, trackId: ID.faceTrackA },
      { confidence: 0.96, rect: { height: 0.2, width: 0.15, x: 0.62, y: 0.26 }, trackId: ID.faceTrackB },
    ],
    [
      { confidence: 0.98, rect: { height: 0.24, width: 0.18, x: 0.23, y: 0.21 }, trackId: ID.faceTrackA },
      { confidence: 0.96, rect: { height: 0.21, width: 0.16, x: 0.58, y: 0.25 }, trackId: ID.faceTrackB },
    ],
    [
      { confidence: 0.98, rect: { height: 0.25, width: 0.19, x: 0.28, y: 0.2 }, trackId: ID.faceTrackA },
    ],
    [
      { confidence: 0.98, rect: { height: 0.24, width: 0.18, x: 0.33, y: 0.22 }, trackId: ID.faceTrackA },
      { confidence: 0.96, rect: { height: 0.2, width: 0.15, x: 0.54, y: 0.27 }, trackId: ID.faceTrackB },
    ],
    [
      { confidence: 0.98, rect: { height: 0.23, width: 0.17, x: 0.38, y: 0.23 }, trackId: ID.faceTrackA },
      { confidence: 0.96, rect: { height: 0.2, width: 0.15, x: 0.5, y: 0.28 }, trackId: ID.faceTrackB },
    ],
  ] as const;
  return FaceAnalysisV1Schema.parse({
    analysisId: ID.faceAnalysis,
    backend: {
      architecture: "arm64",
      kind: "apple-vision",
      osBuild: "25A100",
      requestRevision: 3,
      runtimeVersion: "26.0",
    },
    config: {
      sampleIntervalUs,
      tracking: {
        iouWeight: 0.6,
        maximumCenterDistance: 0.5,
        maximumFacesPerFrame: 8,
        maximumGapUs: sampleIntervalUs * 2,
        minimumConfidence: 0.8,
        minimumIou: 0.05,
      },
    },
    coordinateSpace: {
      encodedPixelHeight: 2_160,
      encodedPixelWidth: 3_840,
      mirroredHorizontally: false,
      origin: "top-left",
      pixelHeight: 2_160,
      pixelWidth: 3_840,
      rotationDegrees: 0,
      sampleAspectRatio: { denominator: 1, numerator: 1 },
      units: "normalized",
      xAxis: "right",
      yAxis: "down",
    },
    coverage: {
      analyzedFrames: sampleTimesUs.length,
      failedFrames: 0,
      range: assetRange,
      requestedFrames: sampleTimesUs.length,
    },
    createdAt: TIMESTAMP,
    durationUs: CAMERA_A_DURATION_US,
    inputDigest: SHA.face,
    kind: "atet.face-analysis",
    privacy: {
      biometricIdentification: "not-performed",
      execution: "local-only",
      storedEvidence: "bounding-boxes-only",
      tracking: "geometry-continuity-only",
    },
    results: sampleTimesUs.map((assetTimeUs, index) => ({
      assetTimeUs,
      detections: detections[index],
      discardedDetections: 0,
      state: "analyzed",
    })),
    schemaVersion: 1,
    subject: {
      assetId: ID.assetCameraA,
      integritySha256: SHA.cameraA,
      streamId: ID.streamCameraAVideo,
    },
    tool: {
      name: "atet-face-analyzer",
      profile: "offline-boxes",
      version: "fixture",
    },
    tracks: [{
      firstSeenAssetTimeUs: sampleTimesUs[0],
      lastSeenAssetTimeUs: sampleTimesUs[4],
      maximumObservedGapUs: sampleTimesUs[1]! - sampleTimesUs[0]!,
      observationCount: 5,
      trackId: ID.faceTrackA,
    }, {
      firstSeenAssetTimeUs: sampleTimesUs[0],
      lastSeenAssetTimeUs: sampleTimesUs[4],
      maximumObservedGapUs: sampleTimesUs[3]! - sampleTimesUs[1]!,
      observationCount: 4,
      trackId: ID.faceTrackB,
    }],
  });
}

function createMusicAnalysis() {
  return MusicAnalysisV1Schema.parse({
    analysisId: ID.music,
    config: { hopSize: 512, minimumMusicUs: 2_000_000, sampleRateHz: 48_000, tempoWindowUs: 8_000_000, windowSize: 2_048 },
    createdAt: TIMESTAMP,
    durationUs: PROJECT_DURATION_US,
    inputDigest: SHA.music,
    keyRegions: [
      { alternate: null, changeConfidence: null, confidence: 0.91, key: { kind: "key", mode: "major", pitchClass: 0 }, range: { endUs: 23_000_000, startUs: 4_000_000 } },
      { alternate: { confidence: 0.22, key: { kind: "key", mode: "major", pitchClass: 0 } }, changeConfidence: 0.88, confidence: 0.89, key: { kind: "key", mode: "minor", pitchClass: 9 }, range: { endUs: 31_000_000, startUs: 23_000_000 } },
    ],
    kind: "atet.music-analysis",
    musicRegions: [
      { confidence: 0.94, range: { endUs: 14_000_000, startUs: 4_000_000 } },
      { confidence: 0.97, range: { endUs: 31_000_000, startUs: 23_000_000 } },
    ],
    schemaVersion: 1,
    subject: { assetId: ID.assetScreen, integritySha256: SHA.screen, streamId: ID.streamScreenAudio },
    tempoRegions: [
      { alternatives: [{ bpm: 59, confidence: 0.27 }], beatTimesUs: [4_100_000, 4_608_475, 5_116_950], bpm: 118, changeFromPrevious: null, confidence: 0.92, meter: "4/4", range: { endUs: 27_000_000, startUs: 4_000_000 } },
      { alternatives: [{ bpm: 66, confidence: 0.19 }], beatTimesUs: [27_100_000, 27_554_545, 28_009_090], bpm: 132, changeFromPrevious: { confidence: 0.9, deltaBpm: 14 }, confidence: 0.9, meter: "4/4", range: { endUs: 31_000_000, startUs: 27_000_000 } },
    ],
    tool: { name: "atet-music", profile: "local-deterministic", version: "1" },
  });
}

function sceneAnalysis(options: {
  readonly analysisId: string;
  readonly assetId: string;
  readonly digest: string;
  readonly durationUs: number;
  readonly pathStem: string;
  readonly scenes: readonly {
    readonly contentKind: "camera" | "terminal";
    readonly endUs: number;
    readonly summary: string;
    readonly title: string;
    readonly visibleTextSummary: string;
  }[];
  readonly streamId: string;
}) {
  const samples = options.scenes.map((scene, index) => {
    const startUs = index === 0 ? 0 : options.scenes[index - 1]!.endUs;
    const actualAssetTimeUs = startUs + Math.floor((scene.endUs - startUs) / 2);
    return {
      actualAssetTimeUs,
      bytes: 92_000 + index * 1_000,
      perceptualHash: `${index + 1}`.repeat(16),
      path: `artifacts/atet/projects/${ID.project}/analysis/scenes/${options.pathStem}-${String(index + 1)}.jpg`,
      reasons: index === 0 ? ["boundary", "middle"] : ["boundary", "maximum-gap"],
      requestedAssetTimeUs: actualAssetTimeUs,
      sampleId: `sample_${options.pathStem}${String(index + 1).padStart(2, "0")}`,
      sha256: index === 0 ? SHA.sceneScreen : SHA.sceneCamera,
    };
  });
  return SceneAnalysisV1Schema.parse({
    analysisId: options.analysisId,
    batches: [],
    cloudUpload: { acknowledgedAt: TIMESTAMP, policy: SCENE_UPLOAD_POLICY },
    createdAt: TIMESTAMP,
    durationUs: options.durationUs,
    inputDigest: options.digest,
    kind: "atet.scene-analysis",
    model: {
      aiSdkVersion: "6",
      gateway: "vercel-ai-gateway",
      promptSha256: SHA.sceneScreen,
      promptVersion: "scene-v1",
      requestedModel: "google/gemini-3-flash",
      resolvedModel: null,
      samplingVersion: "local-boundaries-v1",
    },
    samples,
    scenes: options.scenes.map((scene, index) => ({
      boundaryConfidence: index === 0 ? 1 : 0.93,
      description: {
        activities: scene.contentKind === "camera" ? ["speaking to camera"] : ["editing a project", "running a CLI command"],
        contentKind: scene.contentKind,
        modelConfidence: 0.91,
        setting: scene.contentKind === "camera" ? "Desk camera angle" : "Atet terminal workspace",
        subjects: scene.contentKind === "camera" ? ["presenter"] : ["terminal", "project timeline"],
        summary: scene.summary,
        title: scene.title,
        trust: "untrusted-model-output",
        visibleTextSummary: scene.visibleTextSummary,
      },
      range: { endUs: scene.endUs, startUs: index === 0 ? 0 : options.scenes[index - 1]!.endUs },
      sampleIds: [samples[index]!.sampleId],
      sceneId: `scene_${options.pathStem}${String(index + 1).padStart(2, "0")}`,
    })),
    schemaVersion: 1,
    subjects: [{ assetId: options.assetId, integritySha256: options.digest, streamId: options.streamId }],
    usage: { inputTokens: 0, outputTokens: 0, uploadedBytes: 0, uploadedImages: 0 },
  });
}

function createSpeechAnalysis() {
  const words = [
    ["We", 16_900_000, 17_200_000],
    ["um", 17_400_000, 17_550_000],
    ["shipped", 17_800_000, 18_200_000],
    ["the", 21_700_000, 22_000_000],
    ["like", 22_100_000, 22_300_000],
    ["cut", 22_400_000, 22_800_000],
    ["uh", 25_000_000, 25_150_000],
    ["smoothly", 25_400_000, 25_800_000],
  ] as const;
  return SpeechAnalysisV1Schema.parse({
    analysisId: ID.speech,
    config: { language: "auto", minimumFillerConfidence: 0.8, speechHandleUs: 100_000 },
    createdAt: TIMESTAMP,
    durationUs: CAMERA_A_DURATION_US,
    inputDigest: SHA.speech,
    kind: "atet.speech-analysis",
    result: {
      detectedLanguage: "en",
      fillers: [
        {
          acousticBoundaryConfidence: 0.94,
          autoApplicable: true,
          candidateId: ID.fillerSafe,
          classification: "filled-pause",
          confidence: 0.98,
          musicProtected: false,
          range: { endUs: 17_550_000, startUs: 17_400_000 },
          recommendedCut: { endUs: 17_650_000, startUs: 17_300_000 },
          text: "um",
          wordEndExclusive: 2,
          wordStart: 1,
        },
        {
          acousticBoundaryConfidence: 0.86,
          autoApplicable: false,
          candidateId: ID.fillerContextual,
          classification: "contextual",
          confidence: 0.8,
          musicProtected: false,
          range: { endUs: 22_300_000, startUs: 22_100_000 },
          recommendedCut: null,
          text: "like",
          wordEndExclusive: 5,
          wordStart: 4,
        },
        {
          acousticBoundaryConfidence: 0.93,
          autoApplicable: false,
          candidateId: ID.fillerMusic,
          classification: "filled-pause",
          confidence: 0.97,
          musicProtected: true,
          range: { endUs: 25_150_000, startUs: 25_000_000 },
          recommendedCut: null,
          text: "uh",
          wordEndExclusive: 7,
          wordStart: 6,
        },
      ],
      status: "transcribed",
      utterances: [
        { range: { endUs: 18_200_000, startUs: 16_900_000 }, text: "We um shipped", wordEndExclusive: 3, wordStart: 0 },
        { range: { endUs: 25_800_000, startUs: 21_700_000 }, text: "the like cut uh smoothly", wordEndExclusive: 8, wordStart: 3 },
      ],
      words: words.map(([text, startUs, endUs], wordIndex) => ({
        confidence: 0.96,
        range: { endUs, startUs },
        speaker: "presenter",
        text,
        wordIndex,
      })),
    },
    schemaVersion: 1,
    subject: { assetId: ID.assetCameraA, integritySha256: SHA.cameraA, streamId: ID.streamCameraAAudio },
    tool: { name: "whisper.cpp", profile: "word-timestamps", version: "fixture" },
  });
}

function assetForOverlay(kind: "emoji" | "gif" | "image" | "svg" | "video") {
  const generated = {
    command: ["atet", "overlay", "prepare", kind],
    generator: "atet-overlay-prep",
    generatorVersion: "1",
    kind: "generated" as const,
    sourceSha256: SHA[kind],
  };
  const mediaType = kind === "emoji"
    ? "image/png"
    : kind === "image"
      ? "image/png"
      : kind === "svg"
        ? "image/svg+xml"
        : kind === "gif"
          ? "image/gif"
          : "video/mp4";
  return {
    asset: {
      bytes: kind === "video" ? 2_400_000 : 180_000,
      mediaType,
      path: `artifacts/atet/projects/${ID.project}/assets/${kind}.${kind === "image" || kind === "emoji" ? "png" : kind === "video" ? "mp4" : kind}`,
      provenance: generated,
      sha256: SHA[kind],
    },
  };
}

function animation(kind: "fade" | "none" | "scale" | "slide", exit = false) {
  if (kind === "none") return { kind } as const;
  if (kind === "fade") return { durationUs: 250_000, easing: { kind: "ease-in-out" as const }, kind };
  if (kind === "scale") return { durationUs: 300_000, easing: { kind: "spring" as const }, fromScale: exit ? 1 : 0.6, kind };
  return {
    direction: exit ? "down" as const : "up" as const,
    distancePx: 48,
    durationUs: 320_000,
    easing: { kind: "ease-out" as const },
    kind,
  };
}

function commonOverlay(options: {
  readonly endUs: number;
  readonly entrance: "fade" | "none" | "scale" | "slide";
  readonly exit: "fade" | "none" | "scale" | "slide";
  readonly id: string;
  readonly startUs: number;
  readonly zIndex: number;
}) {
  return {
    anchor: "center" as const,
    blendMode: "normal" as const,
    coordinateSpace: "output-pixels" as const,
    crop: { kind: "none" as const },
    entrance: animation(options.entrance),
    exit: animation(options.exit, true),
    fit: "contain" as const,
    intrinsicSize: { height: 360, width: 640 },
    mask: { kind: "none" as const },
    motion: { kind: "none" as const },
    opacity: 1,
    overlayId: options.id,
    position: { x: 960, y: 540 },
    range: { endUs: options.endUs, startUs: options.startUs },
    rotationDegrees: 0,
    scale: 1,
    size: { height: 360, kind: "pixels" as const, width: 640 },
    zIndex: options.zIndex,
  };
}

function overlays() {
  return [
    {
      ...commonOverlay({ endUs: 7_000_000, entrance: "fade", exit: "scale", id: "overlay_image001", startUs: 1_000_000, zIndex: 20 }),
      blendMode: "overlay",
      crop: { bottom: 0.04, kind: "normalized-insets", left: 0.08, right: 0.08, top: 0.04 },
      fit: "cover",
      mask: { kind: "rounded-rectangle", radiusPx: 28 },
      motion: {
        keyframes: [
          { easing: { kind: "ease-out" }, offset: 0, opacityMultiplier: 0.3, positionOffset: { x: -80, y: 20 }, rotationOffsetDegrees: -4, scaleMultiplier: 0.85 },
          { easing: { kind: "ease-in-out" }, offset: 0.55, opacityMultiplier: 1, positionOffset: { x: 0, y: 0 }, rotationOffsetDegrees: 0, scaleMultiplier: 1 },
          { easing: { kind: "ease-in" }, offset: 1, opacityMultiplier: 0.9, positionOffset: { x: 32, y: -12 }, rotationOffsetDegrees: 2, scaleMultiplier: 1.05 },
        ],
        kind: "keyframes",
        timeline: "visible-output",
      },
      source: { ...assetForOverlay("image"), kind: "image" },
    },
    {
      ...commonOverlay({ endUs: 13_000_000, entrance: "slide", exit: "fade", id: "overlay_svg00001", startUs: 8_000_000, zIndex: 30 }),
      anchor: "bottom-right",
      blendMode: "multiply",
      position: { x: 1_690, y: 890 },
      rotationDegrees: -8,
      scale: 0.9,
      size: { height: 180, kind: "pixels", width: 320 },
      source: { ...assetForOverlay("svg"), kind: "svg" },
    },
    {
      ...commonOverlay({ endUs: 20_000_000, entrance: "scale", exit: "slide", id: "overlay_gif00001", startUs: 14_000_000, zIndex: 40 }),
      anchor: "top-left",
      position: { x: 180, y: 160 },
      size: { height: 240, kind: "pixels", width: 240 },
      source: {
        ...assetForOverlay("gif"),
        audioPolicy: { kind: "mute" },
        kind: "gif",
        playback: { endBehavior: "loop", playbackRate: 1.25, sourceInUs: 120_000, sourceOutUs: 2_400_000 },
      },
    },
    {
      ...commonOverlay({ endUs: 29_000_000, entrance: "fade", exit: "fade", id: "overlay_video001", startUs: 21_000_000, zIndex: 50 }),
      anchor: "bottom-left",
      blendMode: "screen",
      opacity: 0.92,
      position: { x: 330, y: 770 },
      size: { height: 300, kind: "pixels", width: 533 },
      source: {
        ...assetForOverlay("video"),
        audioPolicy: { duckPrimaryTo: 0.35, kind: "duck-primary", volume: 0.8 },
        kind: "video",
        playback: { endBehavior: "freeze-end", playbackRate: 0.75, sourceInUs: 500_000, sourceOutUs: 6_500_000 },
      },
    },
    {
      ...commonOverlay({ endUs: 38_000_000, entrance: "scale", exit: "slide", id: "overlay_emoji001", startUs: 34_000_000, zIndex: 60 }),
      anchor: "top-right",
      position: { x: 1_740, y: 160 },
      rotationDegrees: 12,
      scale: 1.35,
      size: { height: 160, kind: "pixels", width: 160 },
      source: {
        ...assetForOverlay("emoji"),
        kind: "emoji",
        provider: "apple-emoji-pack",
        selector: { kind: "unicode", value: "✨" },
      },
    },
  ];
}

const AcceptedAlignmentSchema = z.strictObject({
  analysisId: z.string().min(1),
  candidateId: z.string().min(1),
  placementId: z.string().min(1),
  referenceSyncSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

const FillerDecisionSchema = z.discriminatedUnion("status", [
  z.strictObject({ candidateId: z.string().min(1), projectRange: z.strictObject({ endUs: z.number().int().positive(), startUs: z.number().int().nonnegative() }), status: z.literal("projected") }),
  z.strictObject({ candidateId: z.string().min(1), reason: z.enum(["candidate-not-safe", "music-protected"]), status: z.literal("protected") }),
]);

const CameraOperationEvidenceSchema = z.discriminatedUnion("technique", [
  z.strictObject({
    gapPolicy: z.null(),
    receipt: ProjectCameraCreateReceiptSchema,
    technique: z.literal("ken-burns-digital-pan-zoom"),
  }),
  z.strictObject({
    gapPolicy: FaceFramingGapPolicySchema,
    receipt: ProjectCameraCreateReceiptSchema,
    technique: z.literal("face-follow"),
  }),
]);

export const ProjectEvidenceSchema = z.strictObject({
  acceptedAlignments: z.array(AcceptedAlignmentSchema).length(2),
  alignments: z.array(AudioAlignmentAnalysisV1Schema).length(2),
  camera: z.strictObject({
    faceAnalysis: FaceAnalysisV1Schema,
    operations: z.array(CameraOperationEvidenceSchema).length(2),
  }),
  editPlan: ProjectEditPlanV1Schema,
  fillerDecisions: z.array(FillerDecisionSchema).min(2),
  music: MusicAnalysisV1Schema,
  project: VideoProjectV1Schema,
  provenance: z.strictObject({
    descriptions: z.literal("fixture-authored-untrusted-model-output"),
    localBoundaryDetector: z.literal("PySceneDetect-compatible reference"),
    localBoundaryEvidence: z.literal("fixture"),
    pythonRuntimeRequired: z.literal(false),
    remoteExecutionRequired: z.literal(false),
  }),
  scenes: z.array(SceneAnalysisV1Schema).length(2),
  speech: SpeechAnalysisV1Schema,
}).superRefine((evidence, context) => {
  const screenAssets = evidence.project.assets.filter(asset => asset.role === "screen");
  const cameraAssets = evidence.project.assets.filter(asset => asset.role === "camera");
  if (screenAssets.length !== 1 || cameraAssets.length !== 2 || evidence.project.placements.length !== 3) {
    context.addIssue({ code: "custom", message: "Project fixture requires one screen and two camera placements." });
  }
  for (const camera of cameraAssets) {
    if (!camera.streams.some(stream => stream.kind === "video") || !camera.streams.some(stream => stream.kind === "audio")) {
      context.addIssue({ code: "custom", message: "Every fixture camera requires video and audio." });
    }
  }
  for (const accepted of evidence.acceptedAlignments) {
    const analysis = evidence.alignments.find(candidate => candidate.analysisId === accepted.analysisId);
    const placement = evidence.project.placements.find(candidate => candidate.placementId === accepted.placementId);
    const candidate = analysis?.result.status === "no-match"
      ? undefined
      : analysis?.result.candidates.find(item => item.candidateId === accepted.candidateId);
    if (
      analysis === undefined
      || candidate === undefined
      || placement?.sync.provenance.kind !== "audio-alignment"
      || placement.sync.provenance.analysisId !== analysis.analysisId
    ) {
      context.addIssue({ code: "custom", message: "Accepted alignment evidence must match an applied project sync map." });
    }
  }
  const faceReference = evidence.project.analyses.find(
    analysis => analysis.kind === "faces"
      && analysis.analysisId === evidence.camera.faceAnalysis.analysisId,
  );
  if (
    faceReference?.kind !== "faces"
    || faceReference.assetId !== evidence.camera.faceAnalysis.subject.assetId
    || faceReference.streamId !== evidence.camera.faceAnalysis.subject.streamId
    || faceReference.subjectIntegritySha256
      !== evidence.camera.faceAnalysis.subject.integritySha256
    || faceReference.localOnly !== true
  ) {
    context.addIssue({
      code: "custom",
      message: "Face camera evidence must match one local-only project analysis reference.",
    });
  }
  if (
    evidence.camera.faceAnalysis.privacy.execution !== "local-only"
    || evidence.camera.faceAnalysis.privacy.storedEvidence !== "bounding-boxes-only"
    || evidence.camera.faceAnalysis.privacy.tracking !== "geometry-continuity-only"
    || evidence.camera.faceAnalysis.privacy.biometricIdentification !== "not-performed"
  ) {
    context.addIssue({
      code: "custom",
      message: "Direct face evidence must remain local geometry without biometric identification.",
    });
  }
  if (
    evidence.editPlan.projectId !== evidence.project.projectId
    || evidence.editPlan.timelineDurationUs !== evidence.project.timeline.durationUs
    || evidence.editPlan.projectStructureSha256 !== hashProjectStructure(evidence.project)
  ) {
      context.addIssue({ code: "custom", message: "The global edit plan must target the current project clock and structure." });
  }
  for (const [index, operation] of evidence.camera.operations.entries()) {
    const move = evidence.editPlan.cameraMoves.find(
      candidate => candidate.cameraMoveId === operation.receipt.cameraMoveId,
    );
    if (
      move === undefined
      || operation.receipt.cameraMoves !== index + 1
      || operation.receipt.keyframeCount !== move.keyframes.length
      || operation.receipt.projectId !== evidence.project.projectId
      || operation.receipt.planHash !== hashProjectEditPlan({
        ...evidence.editPlan,
        cameraMoves: evidence.editPlan.cameraMoves.slice(0, index + 1),
      })
    ) {
      context.addIssue({
        code: "custom",
        message: "Camera operation receipts must match the ordered production edit plan.",
      });
      continue;
    }
    try {
      assertProjectCameraMoveBindings(evidence.project, move);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Direct camera evidence must retain current sync and prepared-layer bindings.",
      });
    }
    if (operation.technique === "ken-burns-digital-pan-zoom") {
      const firstPose = move.keyframes[0]!.pose;
      const lastPose = move.keyframes.at(-1)!.pose;
      if (
        operation.receipt.operation !== "reframe"
        || operation.receipt.selection !== null
        || move.origin.kind !== "manual"
        || move.keyframes.length !== 2
        || (
          firstPose.centerX === lastPose.centerX
          && firstPose.centerY === lastPose.centerY
        )
        || firstPose.zoom === lastPose.zoom
      ) {
        context.addIssue({
          code: "custom",
          message: "Ken Burns evidence must pan and zoom through one manual two-keyframe move.",
        });
      }
      continue;
    }
    const selection = operation.receipt.selection;
    if (
      operation.receipt.operation !== "follow-faces"
      || selection?.kind !== "explicit"
      || selection.requireAllSelected !== true
      || selection.trackIds.length < 2
      || operation.gapPolicy.kind !== "hold"
      || operation.gapPolicy.whenExpired !== "fallback"
      || operation.gapPolicy.maximumHoldUs
        !== Math.max(
          evidence.camera.faceAnalysis.config.tracking.maximumGapUs,
          1_000_000,
        )
      || move.origin.kind !== "face-analysis"
      || move.origin.analysisId !== evidence.camera.faceAnalysis.analysisId
      || move.origin.analysisSha256 !== faceReference?.sha256
      || selection.trackIds.join(",") !== move.origin.trackIds.join(",")
    ) {
      context.addIssue({
        code: "custom",
        message: "Face-follow evidence must retain explicit multi-face, require-all, and hold/fallback provenance.",
      });
    }
  }
  const overlayKinds = evidence.editPlan.overlays.map(overlay => overlay.source.kind).toSorted();
  if (overlayKinds.join(",") !== "emoji,gif,image,svg,video") {
    context.addIssue({ code: "custom", message: "Project evidence must include every overlay kind exactly once." });
  }
  if (
    !evidence.editPlan.overlays.some(overlay => overlay.motion.kind === "keyframes")
    || !evidence.editPlan.overlays.some(overlay => overlay.crop.kind !== "none")
    || !evidence.editPlan.overlays.some(overlay => overlay.mask.kind !== "none")
    || !evidence.editPlan.overlays.some(overlay => overlay.blendMode !== "normal")
    || !evidence.editPlan.overlays.some(overlay => overlay.source.kind === "video" && overlay.source.audioPolicy.kind === "duck-primary")
  ) {
    context.addIssue({ code: "custom", message: "Overlay evidence must exercise motion, crop, mask, blend, and audio ducking." });
  }
  if (evidence.scenes.some(scene => scene.usage.uploadedImages !== 0 || scene.model.resolvedModel !== null)) {
    context.addIssue({ code: "custom", message: "Direct scene evidence cannot require cloud execution." });
  }
  if (!evidence.fillerDecisions.some(item => item.status === "projected") || !evidence.fillerDecisions.some(item => item.status === "protected" && item.reason === "music-protected")) {
    context.addIssue({ code: "custom", message: "Filler evidence requires both a safe project cut and a music-protected rejection." });
  }
});

export type ProjectEvidence = z.infer<typeof ProjectEvidenceSchema>;

export function createProjectEvidence(): ProjectEvidence {
  const screen = screenAsset();
  const cameraA = cameraAsset({
    assetId: ID.assetCameraA,
    audioRole: "dialogue",
    audioStreamId: ID.streamCameraAAudio,
    durationUs: CAMERA_A_DURATION_US,
    label: "Camera A — presenter",
    originalName: "camera-a.mp4",
    path: "artifacts/atet/private/imports/camera-a.mp4",
    sha256: SHA.cameraA,
    videoStreamId: ID.streamCameraAVideo,
  });
  const cameraB = cameraAsset({
    assetId: ID.assetCameraB,
    audioRole: "portable-audio",
    audioStreamId: ID.streamCameraBAudio,
    durationUs: CAMERA_B_DURATION_US,
    label: "Camera B — desk detail",
    originalName: "camera-b.mp4",
    path: "artifacts/atet/private/imports/camera-b.mp4",
    sha256: SHA.cameraB,
    videoStreamId: ID.streamCameraBVideo,
  });
  const screenPlacement = placement({
    asset: screen,
    audioStreamId: ID.streamScreenAudio,
    layout: { height: 1, width: 1, x: 0, y: 0 },
    placementId: ID.placementScreen,
    videoStreamId: ID.streamScreenVideo,
  });
  const cameraAPlacement = placement({
    asset: cameraA,
    audioStreamId: ID.streamCameraAAudio,
    layout: { height: 0.28, width: 0.28, x: 0.7, y: 0.68 },
    placementId: ID.placementCameraA,
    videoStreamId: ID.streamCameraAVideo,
  });
  const cameraBPlacement = placement({
    asset: cameraB,
    audioStreamId: ID.streamCameraBAudio,
    layout: { height: 0.28, width: 0.28, x: 0.02, y: 0.68 },
    placementId: ID.placementCameraB,
    videoStreamId: ID.streamCameraBVideo,
  });
  const [alignmentA, alignmentB] = createAlignmentAnalyses();
  const candidateAId = AlignmentCandidateIdSchema.parse(ID.candidateA);
  const candidateBId = AlignmentCandidateIdSchema.parse(ID.candidateB);
  const acceptedA = applyAudioAlignmentCandidate({
    analysis: alignmentA,
    candidateId: candidateAId,
    expectedReferenceSyncSha256: hashPlacementSync(screenPlacement),
    referencePlacement: screenPlacement,
    targetAssetId: cameraA.assetId,
    targetAssetRange: cameraAPlacement.assetRange,
  });
  const acceptedB = applyAudioAlignmentCandidate({
    analysis: alignmentB,
    candidateId: candidateBId,
    expectedReferenceSyncSha256: hashPlacementSync(screenPlacement),
    referencePlacement: screenPlacement,
    targetAssetId: cameraB.assetId,
    targetAssetRange: cameraBPlacement.assetRange,
  });
  if (acceptedA.status !== "applied" || acceptedB.status !== "applied") {
    throw new Error("Direct audio alignment fixtures must apply through the production mapper.");
  }
  const syncedCameraA = { ...cameraAPlacement, assetRange: acceptedA.appliedAssetRange, sync: acceptedA.sync };
  const syncedCameraB = { ...cameraBPlacement, assetRange: acceptedB.appliedAssetRange, sync: acceptedB.sync };
  const faceProjectRange = { endUs: 16_000_000, startUs: 10_000_000 };
  const faceAssetStartUs = projectToAssetUs(syncedCameraA.sync, faceProjectRange.startUs);
  const faceAssetEndUs = projectToAssetUs(syncedCameraA.sync, faceProjectRange.endUs);
  if (
    faceAssetStartUs === null
    || faceAssetEndUs === null
    || faceAssetEndUs <= faceAssetStartUs
  ) {
    throw new Error("Direct face evidence must map through the accepted camera sync.");
  }
  const faceAnalysis = createFaceAnalysis({
    endUs: faceAssetEndUs,
    startUs: faceAssetStartUs,
  });
  const music = createMusicAnalysis();
  const screenScenes = sceneAnalysis({
    analysisId: ID.sceneScreen,
    assetId: ID.assetScreen,
    digest: SHA.screen,
    durationUs: SCREEN_DURATION_US,
    pathStem: "screen",
    scenes: [
      { contentKind: "terminal", endUs: 14_000_000, summary: "The CLI creates a synchronized multi-angle project.", title: "Create project", visibleTextSummary: "atet projects create and project add" },
      { contentKind: "terminal", endUs: SCREEN_DURATION_US, summary: "The timeline applies a global cut, speed range, and overlays.", title: "Edit project", visibleTextSummary: "atet project edit, align analyze, render" },
    ],
    streamId: ID.streamScreenVideo,
  });
  const cameraScenes = sceneAnalysis({
    analysisId: ID.sceneCamera,
    assetId: ID.assetCameraA,
    digest: SHA.cameraA,
    durationUs: CAMERA_A_DURATION_US,
    pathStem: "camera",
    scenes: [
      { contentKind: "camera", endUs: 20_600_000, summary: "The presenter introduces synchronized raw capture.", title: "Presenter intro", visibleTextSummary: "" },
      { contentKind: "camera", endUs: CAMERA_A_DURATION_US, summary: "The presenter demonstrates the finished multi-angle edit.", title: "Presenter demo", visibleTextSummary: "" },
    ],
    streamId: ID.streamCameraAVideo,
  });
  const speech = createSpeechAnalysis();
  const analyses = [
    { analysisId: ID.alignA, confidence: 0.98, createdAt: TIMESTAMP, driftPpm: 0, kind: "audio-alignment", path: `artifacts/atet/projects/${ID.project}/analysis/${ID.alignA}.json`, referencePlacementId: ID.placementScreen, sha256: SHA.alignA, targetPlacementId: ID.placementCameraA },
    { analysisId: ID.alignB, confidence: 0.95, createdAt: TIMESTAMP, driftPpm: -24, kind: "audio-alignment", path: `artifacts/atet/projects/${ID.project}/analysis/${ID.alignB}.json`, referencePlacementId: ID.placementScreen, sha256: SHA.alignB, targetPlacementId: ID.placementCameraB },
    { analysisId: ID.music, assetId: ID.assetScreen, createdAt: TIMESTAMP, keyRegions: music.keyRegions.length, kind: "music", musicRegions: music.musicRegions.length, path: `artifacts/atet/projects/${ID.project}/analysis/${ID.music}.json`, sha256: SHA.music, streamId: ID.streamScreenAudio, tempoRegions: music.tempoRegions.length },
    { analysisId: ID.sceneScreen, assetId: ID.assetScreen, createdAt: TIMESTAMP, kind: "scenes", model: screenScenes.model.requestedModel, path: `artifacts/atet/projects/${ID.project}/analysis/${ID.sceneScreen}.json`, sceneCount: screenScenes.scenes.length, sha256: SHA.sceneScreen, streamIds: [ID.streamScreenVideo] },
    { analysisId: ID.sceneCamera, assetId: ID.assetCameraA, createdAt: TIMESTAMP, kind: "scenes", model: cameraScenes.model.requestedModel, path: `artifacts/atet/projects/${ID.project}/analysis/${ID.sceneCamera}.json`, sceneCount: cameraScenes.scenes.length, sha256: SHA.sceneCamera, streamIds: [ID.streamCameraAVideo] },
    { analysisId: ID.faceAnalysis, analyzedFrames: faceAnalysis.coverage.analyzedFrames, assetId: ID.assetCameraA, createdAt: TIMESTAMP, kind: "faces", localOnly: true, path: `artifacts/atet/projects/${ID.project}/analysis/${ID.faceAnalysis}.json`, sha256: SHA.face, streamId: ID.streamCameraAVideo, subjectIntegritySha256: SHA.cameraA, trackCount: faceAnalysis.tracks.length },
    { analysisId: ID.speech, assetId: ID.assetCameraA, createdAt: TIMESTAMP, fillerCount: speech.result.status === "transcribed" ? speech.result.fillers.length : 0, kind: "speech", path: `artifacts/atet/projects/${ID.project}/analysis/${ID.speech}.json`, sha256: SHA.speech, streamId: ID.streamCameraAAudio, wordCount: speech.result.status === "transcribed" ? speech.result.words.length : 0 },
  ];
  const project = VideoProjectV1Schema.parse({
    analyses,
    assets: [screen, cameraA, cameraB],
    createdAt: TIMESTAMP,
    currentEditPlanPath: `artifacts/atet/projects/${ID.project}/edits/plan_agentdemo1.json`,
    kind: "atet.video-project",
    name: "Agent demo — synchronized multi-angle",
    placements: [screenPlacement, syncedCameraA, syncedCameraB],
    projectId: ID.project,
    referencePlacementId: ID.placementScreen,
    schemaVersion: 1,
    timeline: { durationUs: PROJECT_DURATION_US, timebase: "microseconds" },
    updatedAt: TIMESTAMP,
  });
  const safeCut = projectFillerCut({
    candidateId: ID.fillerSafe,
    decisionId: "decision_fillercut1",
    expectedPlacementSyncSha256: hashPlacementSync(syncedCameraA),
    placement: syncedCameraA,
    projectMusicProtection: { complete: true, ranges: music.musicRegions.map(region => region.range) },
    speech,
  });
  const protectedCut = projectFillerCut({
    candidateId: ID.fillerMusic,
    decisionId: "decision_protected1",
    expectedPlacementSyncSha256: hashPlacementSync(syncedCameraA),
    placement: syncedCameraA,
    projectMusicProtection: { complete: true, ranges: music.musicRegions.map(region => region.range) },
    speech,
  });
  if (safeCut.status !== "projected" || protectedCut.status !== "rejected" || protectedCut.reason !== "music-protected") {
    throw new Error("Direct filler fixtures must exercise safe and music-protected production outcomes.");
  }
  const safeRange = safeCut.derivation.projectRange;
  const basePlan = ProjectEditPlanV1Schema.parse({
    baseSpeed: 1,
    cameraMoves: [],
    createdAt: TIMESTAMP,
    derivations: [
      safeCut.derivation,
      { decisionId: "decision_freezecut1", operation: "cut", origin: { kind: "manual" }, projectRange: { endUs: 33_000_000, startUs: 30_000_000 } },
      { decisionId: "decision_speedup001", operation: "speed", origin: { kind: "manual" }, projectRange: { endUs: 24_000_000, startUs: 20_000_000 } },
    ],
    effects: {
      clicks: { color: "#ff665c", durationUs: 450_000, enabled: true, radiusPx: 38, style: "pulse" },
      cursor: { enabled: true, scale: 1.15, smoothing: { algorithm: "exponential", strength: 0.72 }, style: "captured" },
      keystrokes: { enabled: true, holdUs: 900_000, maxKeys: 6, position: "bottom-right", secureText: "hide" },
      metadataPlacementId: ID.placementScreen,
      typedText: { enabled: true, idleTimeoutUs: 1_200_000, maxCharacters: 160, placement: "input", secureText: "hide" },
    },
    keep: [
      { endUs: safeRange.startUs, startUs: 0 },
      { endUs: 30_000_000, startUs: safeRange.endUs },
      { endUs: PROJECT_DURATION_US, startUs: 33_000_000 },
    ],
    kind: "atet.project-edit-plan",
    overlays: overlays(),
    planId: "plan_agentdemo1",
    projectId: ID.project,
    projectStructureSha256: hashProjectStructure(project),
    schemaVersion: 1,
    speed: [{ range: { endUs: 24_000_000, startUs: 20_000_000 }, rate: 1.75 }],
    timelineDurationUs: PROJECT_DURATION_US,
    updatedAt: TIMESTAMP,
    zooms: [{
      operation: {
        displayId: "display_builtin01",
        easing: { kind: "ease-in-out" },
        enterDurationUs: 400_000,
        exitDurationUs: 500_000,
        kind: "automatic",
        confidence: 0.96,
        range: { endUs: 16_000_000, startUs: 11_000_000 },
        reason: "typing",
        scale: 1.8,
        target: { kind: "focused-input", paddingPx: 64 },
        zoomId: "zoom_typing0001",
      },
      placementId: ID.placementScreen,
    }],
  });
  const cameraVideoStreamId = syncedCameraA.video.find(
    configured => configured.streamId === ID.streamCameraAVideo,
  )?.streamId;
  if (cameraVideoStreamId === undefined) {
    throw new Error("Direct camera placement must retain its analyzed video stream.");
  }
  const manualCameraMove = ProjectCameraMoveSchema.parse({
    binding: {
      geometrySha256: hashProjectCameraGeometry(
        project,
        syncedCameraA.placementId,
        cameraVideoStreamId,
      ),
      syncSha256: hashProjectCameraSync(syncedCameraA),
    },
    cameraMoveId: ID.cameraKenBurns,
    keyframes: [{
      outgoingEasing: { kind: "ease-in-out" },
      pose: {
        centerX: 0.5,
        centerY: 0.5,
        space: "prepared-video-layer-normalized-v1",
        zoom: 1,
      },
      projectTimeUs: 2_000_000,
    }, {
      outgoingEasing: { kind: "linear" },
      pose: {
        centerX: 0.68,
        centerY: 0.42,
        space: "prepared-video-layer-normalized-v1",
        zoom: 2.2,
      },
      projectTimeUs: 8_000_000,
    }],
    origin: { kind: "manual" },
    placementId: syncedCameraA.placementId,
    projectRange: { endUs: 8_000_000, startUs: 2_000_000 },
    streamId: cameraVideoStreamId,
  });
  assertProjectCameraMoveBindings(project, manualCameraMove);
  const manualPlan = ProjectEditPlanV1Schema.parse({
    ...basePlan,
    cameraMoves: [manualCameraMove],
  });
  const faceReference = project.analyses.find(
    analysis => analysis.kind === "faces" && analysis.analysisId === ID.faceAnalysis,
  );
  if (faceReference?.kind !== "faces") {
    throw new Error("Direct project must retain its local face-analysis reference.");
  }
  const plannedFaceCamera = planProjectFaceCamera({
    analysis: faceAnalysis,
    cameraMoveId: ID.cameraFace,
    easing: { kind: "ease-in-out" },
    framing: "group",
    gapPolicy: "hold",
    headroom: 0.15,
    maximumZoom: 4,
    minimumZoom: 1,
    outputHeight: 1_080,
    outputWidth: 1_920,
    placementId: syncedCameraA.placementId,
    plan: manualPlan,
    project,
    projectRange: faceProjectRange,
    reference: faceReference,
    requireAllSelectedFaces: true,
    selection: {
      kind: "explicit",
      trackIds: [ID.faceTrackA, ID.faceTrackB],
    },
    smoothingSeconds: 0.45,
  });
  assertProjectCameraMoveBindings(project, plannedFaceCamera.move);
  const editPlan = ProjectEditPlanV1Schema.parse({
    ...basePlan,
    cameraMoves: [manualCameraMove, plannedFaceCamera.move],
  });
  const nextCommands = (cameraMoveId: string) => ({
    remove: `atet project edit ${ID.project} camera remove ${cameraMoveId} --json`,
    show: `atet project edit ${ID.project} camera show --json`,
  });
  const manualReceipt = ProjectCameraCreateReceiptSchema.parse({
    cameraMoveId: manualCameraMove.cameraMoveId,
    cameraMoves: 1,
    keyframeCount: manualCameraMove.keyframes.length,
    nextCommands: nextCommands(manualCameraMove.cameraMoveId),
    operation: "reframe",
    planHash: hashProjectEditPlan(manualPlan),
    projectId: project.projectId,
    selection: null,
  });
  const faceReceipt = ProjectCameraCreateReceiptSchema.parse({
    cameraMoveId: plannedFaceCamera.move.cameraMoveId,
    cameraMoves: 2,
    keyframeCount: plannedFaceCamera.move.keyframes.length,
    nextCommands: nextCommands(plannedFaceCamera.move.cameraMoveId),
    operation: "follow-faces",
    planHash: hashProjectEditPlan(editPlan),
    projectId: project.projectId,
    selection: {
      kind: "explicit",
      requireAllSelected: true,
      trackIds: plannedFaceCamera.selectedTrackIds,
    },
  });
  const faceGapPolicy = FaceFramingGapPolicySchema.parse({
    kind: "hold",
    maximumHoldUs: Math.max(
      faceAnalysis.config.tracking.maximumGapUs,
      1_000_000,
    ),
    whenExpired: "fallback",
  });
  return ProjectEvidenceSchema.parse({
    acceptedAlignments: [
      { analysisId: ID.alignA, candidateId: ID.candidateA, placementId: ID.placementCameraA, referenceSyncSha256: acceptedA.referenceSyncSha256 },
      { analysisId: ID.alignB, candidateId: ID.candidateB, placementId: ID.placementCameraB, referenceSyncSha256: acceptedB.referenceSyncSha256 },
    ],
    alignments: [alignmentA, alignmentB],
    camera: {
      faceAnalysis,
      operations: [{
        gapPolicy: null,
        receipt: manualReceipt,
        technique: "ken-burns-digital-pan-zoom",
      }, {
        gapPolicy: faceGapPolicy,
        receipt: faceReceipt,
        technique: "face-follow",
      }],
    },
    editPlan,
    fillerDecisions: [
      { candidateId: ID.fillerSafe, projectRange: safeRange, status: "projected" },
      { candidateId: ID.fillerMusic, reason: "music-protected", status: "protected" },
      { candidateId: ID.fillerContextual, reason: "candidate-not-safe", status: "protected" },
    ],
    music,
    project,
    provenance: {
      descriptions: "fixture-authored-untrusted-model-output",
      localBoundaryDetector: "PySceneDetect-compatible reference",
      localBoundaryEvidence: "fixture",
      pythonRuntimeRequired: false,
      remoteExecutionRequired: false,
    },
    scenes: [screenScenes, cameraScenes],
    speech,
  });
}
