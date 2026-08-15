import { describe, expect, test } from "bun:test";

import {
  EditPlanIdSchema,
  FaceAnalysisV1Schema,
  ProjectAnalysisReferenceSchema,
  ProjectEditPlanV1Schema,
  ResolvedProjectVideoSliceSchema,
  VideoProjectV1Schema,
  type FaceAnalysisV1,
  type ProjectEditPlanV1,
  type VideoProjectV1,
} from "../contracts";
import {
  compileProjectCameraSegments,
  createDefaultProjectEditPlan,
} from "../core";
import {
  planProjectFaceCamera,
  type ProjectFaceCameraOptions,
} from "./project-face-camera";

const NOW = "2026-07-22T12:00:00.000Z";
const MEDIA_HASH = "a".repeat(64);
const ANALYSIS_HASH = "b".repeat(64);
const SUBJECT_HASH = "c".repeat(64);
const INPUT_HASH = "d".repeat(64);
const TRACK_A = "face_subjecta1";
const TRACK_B = "face_subjectb1";
const TRACK_OUTSIDE_RANGE = "face_outside01";

function segment(codec: string, streamIndex: number) {
  return {
    assetRange: { endUs: 10_000_000, startUs: 0 },
    bytes: 1_024,
    codec,
    container: "mov",
    fileRange: { endUs: 10_500_000, startUs: 500_000 },
    path: "media/camera.mov",
    sha256: MEDIA_HASH,
    streamIndex,
  };
}

function faceReference() {
  return ProjectAnalysisReferenceSchema.parse({
    analysisId: "analysis_faces0001",
    analyzedFrames: 5,
    assetId: "asset_camera00001",
    createdAt: NOW,
    kind: "faces",
    localOnly: true,
    path: "analysis/faces/analysis_faces0001.json",
    sha256: ANALYSIS_HASH,
    streamId: "stream_camera_video01",
    subjectIntegritySha256: SUBJECT_HASH,
    trackCount: 3,
  });
}

function project(layoutKind: "normalized" | "output-pixels" = "normalized"): VideoProjectV1 {
  const videoPresentation = {
    blendMode: "normal" as const,
    crop: {
      bottom: 0,
      kind: "normalized-insets" as const,
      left: 0.1,
      right: 0.1,
      top: 0,
    },
    enabled: true as const,
    fit: "contain" as const,
    layer: 1,
    layout: layoutKind === "normalized"
      ? {
          height: 0.8,
          kind: "normalized" as const,
          width: 0.5,
          x: 0.1,
          y: 0.1,
        }
      : {
          height: 864,
          kind: "output-pixels" as const,
          width: 960,
          x: 100,
          y: 100,
        },
    opacity: 1,
  };
  return VideoProjectV1Schema.parse({
    analyses: [faceReference()],
    assets: [{
      assetId: "asset_camera00001",
      createdAt: NOW,
      durationUs: 10_000_000,
      label: "Camera",
      role: "camera",
      source: {
        importedAt: NOW,
        kind: "imported",
        originalName: "camera.mov",
        sourceSha256: MEDIA_HASH,
      },
      streams: [{
        frameRate: 30,
        kind: "video",
        label: "Camera video",
        pixelHeight: 1_080,
        pixelWidth: 1_920,
        role: "camera",
        segments: [segment("h264", 0)],
        streamId: "stream_camera_video01",
      }, {
        channels: 2,
        kind: "audio",
        label: "Camera audio",
        role: "other",
        sampleRateHz: 48_000,
        segments: [segment("aac", 1)],
        streamId: "stream_camera_audio01",
      }],
    }],
    createdAt: NOW,
    currentEditPlanPath: "edits/current.json",
    kind: "studio.video-project",
    name: "Face camera",
    placements: [{
      assetId: "asset_camera00001",
      assetRange: { endUs: 9_000_000, startUs: 1_000_000 },
      audio: [{
        presentation: { enabled: true, gainDb: 0, pan: 0 },
        streamId: "stream_camera_audio01",
      }],
      enabled: true,
      placementId: "placement_camera0001",
      sync: {
        anchors: [
          { assetTimeUs: 1_000_000, projectTimeUs: 2_000_000 },
          { assetTimeUs: 5_000_000, projectTimeUs: 7_000_000 },
          { assetTimeUs: 9_000_000, projectTimeUs: 12_000_000 },
        ],
        provenance: { kind: "manual", note: "Offset and drift correction" },
      },
      video: [{
        presentation: videoPresentation,
        streamId: "stream_camera_video01",
      }],
    }],
    projectId: "project_facecamera01",
    referencePlacementId: "placement_camera0001",
    schemaVersion: 1,
    timeline: { durationUs: 12_000_000, timebase: "microseconds" },
    updatedAt: NOW,
  });
}

function analysis(): FaceAnalysisV1 {
  return FaceAnalysisV1Schema.parse({
    analysisId: "analysis_faces0001",
    backend: {
      architecture: "arm64",
      kind: "apple-vision",
      osBuild: "25A100",
      requestRevision: 3,
      runtimeVersion: "26.0",
    },
    config: {
      sampleIntervalUs: 1_000_000,
      tracking: {
        iouWeight: 0.6,
        maximumCenterDistance: 0.5,
        maximumFacesPerFrame: 8,
        maximumGapUs: 2_000_000,
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
      analyzedFrames: 5,
      failedFrames: 0,
      range: { endUs: 9_000_000, startUs: 1_000_000 },
      requestedFrames: 5,
    },
    createdAt: NOW,
    durationUs: 10_000_000,
    inputDigest: INPUT_HASH,
    kind: "studio.face-analysis",
    privacy: {
      biometricIdentification: "not-performed",
      execution: "local-only",
      storedEvidence: "bounding-boxes-only",
      tracking: "geometry-continuity-only",
    },
    results: [{
      assetTimeUs: 2_000_000,
      detections: [{
        confidence: 0.99,
        rect: { height: 0.2, width: 0.2, x: 0.2, y: 0.2 },
        trackId: TRACK_A,
      }, {
        confidence: 0.9,
        rect: { height: 0.1, width: 0.1, x: 0.65, y: 0.3 },
        trackId: TRACK_B,
      }],
      discardedDetections: 0,
      state: "analyzed",
    }, {
      assetTimeUs: 3_000_000,
      detections: [{
        confidence: 0.99,
        rect: { height: 0.2, width: 0.2, x: 0.3, y: 0.22 },
        trackId: TRACK_A,
      }, {
        confidence: 0.9,
        rect: { height: 0.1, width: 0.1, x: 0.62, y: 0.32 },
        trackId: TRACK_B,
      }],
      discardedDetections: 0,
      state: "analyzed",
    }, {
      assetTimeUs: 4_000_000,
      detections: [{
        confidence: 0.99,
        rect: { height: 0.2, width: 0.2, x: 0.55, y: 0.25 },
        trackId: TRACK_A,
      }, {
        confidence: 0.9,
        rect: { height: 0.1, width: 0.1, x: 0.72, y: 0.35 },
        trackId: TRACK_B,
      }],
      discardedDetections: 0,
      state: "analyzed",
    }, {
      assetTimeUs: 5_500_000,
      detections: [{
        confidence: 0.99,
        rect: { height: 0.2, width: 0.2, x: 0.25, y: 0.18 },
        trackId: TRACK_A,
      }, {
        confidence: 0.9,
        rect: { height: 0.1, width: 0.1, x: 0.7, y: 0.4 },
        trackId: TRACK_B,
      }],
      discardedDetections: 0,
      state: "analyzed",
    }, {
      assetTimeUs: 8_500_000,
      detections: [{
        confidence: 0.95,
        rect: { height: 0.15, width: 0.15, x: 0.4, y: 0.3 },
        trackId: TRACK_OUTSIDE_RANGE,
      }],
      discardedDetections: 0,
      state: "analyzed",
    }],
    schemaVersion: 1,
    subject: {
      assetId: "asset_camera00001",
      integritySha256: SUBJECT_HASH,
      streamId: "stream_camera_video01",
    },
    tool: {
      name: "atet-face-analyzer",
      profile: "offline-boxes",
      version: "0.1.0",
    },
    tracks: [{
      firstSeenAssetTimeUs: 8_500_000,
      lastSeenAssetTimeUs: 8_500_000,
      maximumObservedGapUs: 0,
      observationCount: 1,
      trackId: TRACK_OUTSIDE_RANGE,
    }, {
      firstSeenAssetTimeUs: 2_000_000,
      lastSeenAssetTimeUs: 5_500_000,
      maximumObservedGapUs: 1_500_000,
      observationCount: 4,
      trackId: TRACK_A,
    }, {
      firstSeenAssetTimeUs: 2_000_000,
      lastSeenAssetTimeUs: 5_500_000,
      maximumObservedGapUs: 1_500_000,
      observationCount: 4,
      trackId: TRACK_B,
    }],
  });
}

function plan(value: VideoProjectV1): ProjectEditPlanV1 {
  return createDefaultProjectEditPlan(
    value,
    EditPlanIdSchema.parse("plan_facecamera001"),
    NOW,
  );
}

function referenceFrom(value: VideoProjectV1) {
  const reference = value.analyses[0];
  if (reference?.kind !== "faces") throw new TypeError("Fixture is missing its face reference.");
  return reference;
}

function options(
  value: VideoProjectV1,
  evidence: FaceAnalysisV1,
  overrides: Partial<ProjectFaceCameraOptions> = {},
): ProjectFaceCameraOptions {
  return {
    analysis: evidence,
    cameraMoveId: "camera_follow0001",
    easing: { kind: "ease-in-out" },
    framing: "tight",
    gapPolicy: "fallback",
    headroom: 0,
    maximumZoom: 8,
    minimumZoom: 1,
    outputHeight: 1_080,
    outputWidth: 1_920,
    placementId: "placement_camera0001",
    plan: plan(value),
    project: value,
    projectRange: { endUs: 8_250_000, startUs: 3_250_000 },
    reference: referenceFrom(value),
    requireAllSelectedFaces: false,
    selection: { kind: "explicit", trackIds: [TRACK_A] },
    smoothingSeconds: 0,
    ...overrides,
  };
}

function sliceFor(
  value: VideoProjectV1,
  projectRange = { endUs: 8_250_000, startUs: 3_250_000 },
) {
  const placement = value.placements[0]!;
  const configured = placement.video[0]!;
  return ResolvedProjectVideoSliceSchema.parse({
    assetId: placement.assetId,
    assetRange: { endUs: 6_000_000, startUs: 2_000_000 },
    bytes: 1_024,
    codec: "h264",
    container: "mov",
    fileRange: { endUs: 6_500_000, startUs: 2_500_000 },
    kind: "video",
    outputRange: projectRange,
    path: "media/camera.mov",
    placementId: placement.placementId,
    presentation: configured.presentation,
    projectRange,
    projectSpeed: 1,
    role: "camera",
    sha256: MEDIA_HASH,
    streamId: configured.streamId,
    streamIndex: 0,
  });
}

describe("project face-follow camera planning", () => {
  test("maps crop and contain geometry, placement sync, and immutable provenance", () => {
    const value = project();
    const evidence = analysis();
    const result = planProjectFaceCamera(options(value, evidence));

    expect(result.selectedTrackIds.map(String)).toEqual([TRACK_A]);
    expect(result.move.projectRange).toEqual({
      endUs: 8_250_000,
      startUs: 3_250_000,
    });
    expect(result.move.keyframes[0]?.projectTimeUs).toBe(3_250_000);
    expect(result.move.keyframes.at(-1)?.projectTimeUs).toBe(8_250_000);
    expect(result.move.keyframes.map(keyframe => keyframe.projectTimeUs))
      .toContain(5_750_000);

    const firstPose = result.move.keyframes[0]!.pose;
    expect(firstPose.centerX).toBeCloseTo(0.25, 12);
    expect(firstPose.centerY).toBeCloseTo(0.34375, 12);
    expect(firstPose.zoom).toBeCloseTo(1 / 0.325, 12);
    expect(result.move.origin).toMatchObject({
      analysisId: "analysis_faces0001",
      analysisSha256: ANALYSIS_HASH,
      assetId: "asset_camera00001",
      assetRange: { endUs: 6_000_000, startUs: 2_000_000 },
      kind: "face-analysis",
      outputAspectRatio: 16 / 9,
      streamId: "stream_camera_video01",
      subjectIntegritySha256: SUBJECT_HASH,
      trackIds: [TRACK_A],
    });
  });

  test("supports explicit multi-face and all-active selection deterministically", () => {
    const value = project();
    const evidence = analysis();
    const single = planProjectFaceCamera(options(value, evidence));
    const explicitMulti = planProjectFaceCamera(options(value, evidence, {
      cameraMoveId: "camera_follow0002",
      selection: { kind: "explicit", trackIds: [TRACK_B, TRACK_A, TRACK_B] },
    }));
    const all = planProjectFaceCamera(options(value, evidence, {
      cameraMoveId: "camera_follow0003",
      selection: { kind: "all" },
    }));
    const largest = planProjectFaceCamera(options(value, evidence, {
      cameraMoveId: "camera_follow0004",
      selection: { kind: "largest" },
    }));

    expect(explicitMulti.selectedTrackIds.map(String)).toEqual([TRACK_A, TRACK_B]);
    expect(explicitMulti.move.origin.kind === "face-analysis"
      ? explicitMulti.move.origin.trackIds.map(String)
      : []).toEqual([TRACK_A, TRACK_B]);
    expect(explicitMulti.move.keyframes[0]!.pose.zoom)
      .toBeLessThan(single.move.keyframes[0]!.pose.zoom);
    expect(all.selectedTrackIds.map(String)).toEqual([TRACK_A, TRACK_B]);
    expect(all.selectedTrackIds.map(String)).not.toContain(TRACK_OUTSIDE_RANGE);
    expect(largest.selectedTrackIds.map(String)).toEqual([TRACK_A]);
  });

  test("follows the largest currently visible face with deterministic ties", () => {
    const value = project();
    const evidence = analysis();
    const dynamicallyLargest = FaceAnalysisV1Schema.parse({
      ...evidence,
      results: evidence.results.map(result => (
        result.state === "analyzed" && result.assetTimeUs === 4_000_000
          ? {
            ...result,
            detections: result.detections.map(detection => (
              detection.trackId === TRACK_B
                ? {
                  ...detection,
                  confidence: 0.99,
                  rect: { height: 0.3, width: 0.3, x: 0.6, y: 0.25 },
                }
                : detection
            )),
          }
          : result
      )),
    });
    const dynamic = planProjectFaceCamera(options(value, dynamicallyLargest, {
      cameraMoveId: "camera_dynamic001",
      selection: { kind: "largest" },
    }));

    expect(dynamic.selectedTrackIds.map(String)).toEqual([TRACK_A, TRACK_B]);
    expect(dynamic.move.origin.kind === "face-analysis"
      ? dynamic.move.origin.trackIds.map(String)
      : []).toEqual([TRACK_A, TRACK_B]);
    expect(dynamic.move.keyframes.find(
      keyframe => keyframe.projectTimeUs === 5_750_000,
    )?.pose.centerX).toBeGreaterThan(0.65);

    const tied = FaceAnalysisV1Schema.parse({
      ...evidence,
      results: evidence.results.map(result => (
        result.state !== "analyzed"
          ? result
          : {
            ...result,
            detections: result.detections.map((detection) => {
              const first = result.detections.find(candidate => candidate.trackId === TRACK_A);
              return detection.trackId === TRACK_B && first !== undefined
                ? {
                  ...detection,
                  confidence: first.confidence,
                  rect: { ...first.rect },
                }
                : detection;
            }),
          }
      )),
    });
    const deterministicTie = planProjectFaceCamera(options(value, tied, {
      cameraMoveId: "camera_tiebreak01",
      selection: { kind: "largest" },
    }));
    expect(deterministicTie.selectedTrackIds.map(String)).toEqual([TRACK_A]);

    const threeWayTie = FaceAnalysisV1Schema.parse({
      ...evidence,
      results: evidence.results.map((result) => {
        if (result.state !== "analyzed") return result;
        if (result.assetTimeUs >= 6_000_000) return { ...result, detections: [] };
        const first = result.detections.find(detection => detection.trackId === TRACK_A);
        if (first === undefined) return result;
        return {
          ...result,
          detections: [{
            confidence: first.confidence,
            rect: { ...first.rect },
            trackId: TRACK_OUTSIDE_RANGE,
          }, ...result.detections.map(detection => (
            detection.trackId === TRACK_B
              ? { ...detection, confidence: first.confidence, rect: { ...first.rect } }
              : detection
          ))],
        };
      }),
      tracks: evidence.tracks.map(track => (
        track.trackId === TRACK_OUTSIDE_RANGE
          ? {
            ...track,
            firstSeenAssetTimeUs: 2_000_000,
            lastSeenAssetTimeUs: 5_500_000,
            maximumObservedGapUs: 1_500_000,
            observationCount: 4,
          }
          : track
      )),
    });
    const deterministicThreeWayTie = planProjectFaceCamera(options(value, threeWayTie, {
      cameraMoveId: "camera_tiebreak03",
      selection: { kind: "largest" },
    }));
    expect(deterministicThreeWayTie.selectedTrackIds.map(String)).toEqual([TRACK_OUTSIDE_RANGE]);
  });

  test("keeps dynamic-largest provenance scoped to the requested asset range", () => {
    const value = project();
    const evidence = analysis();
    const outsideWinner = FaceAnalysisV1Schema.parse({
      ...evidence,
      results: evidence.results.map(result => (
        result.state === "analyzed" && result.assetTimeUs === 5_500_000
          ? {
            ...result,
            detections: result.detections.map(detection => (
              detection.trackId === TRACK_B
                ? {
                  ...detection,
                  confidence: 1,
                  rect: { height: 0.5, width: 0.5, x: 0.4, y: 0.2 },
                }
                : detection
            )),
          }
          : result
      )),
    });
    const planned = planProjectFaceCamera(options(value, outsideWinner, {
      cameraMoveId: "camera_rangeonly1",
      projectRange: { endUs: 7_000_000, startUs: 3_250_000 },
      selection: { kind: "largest" },
    }));

    expect(planned.selectedTrackIds.map(String)).toEqual([TRACK_A]);
    expect(planned.move.origin.kind === "face-analysis"
      ? planned.move.origin.trackIds.map(String)
      : []).toEqual([TRACK_A]);
  });

  test("chooses largest-visible after crop clipping, not by raw source-box area", () => {
    const value = project();
    const evidence = analysis();
    const clippedRawWinner = FaceAnalysisV1Schema.parse({
      ...evidence,
      results: evidence.results.map(result => (
        result.state !== "analyzed"
          ? result
          : {
            ...result,
            detections: result.detections.map(detection => (
              detection.trackId === TRACK_A
                ? {
                  ...detection,
                  rect: { height: 0.2, width: 0.2, x: 0, y: 0.2 },
                }
                : detection.trackId === TRACK_B
                  ? {
                    ...detection,
                    rect: { height: 0.15, width: 0.15, x: 0.5, y: 0.2 },
                  }
                  : detection
            )),
          }
      )),
    });
    const planned = planProjectFaceCamera(options(value, clippedRawWinner, {
      cameraMoveId: "camera_cropwins01",
      selection: { kind: "largest" },
    }));

    expect(0.2 * 0.2).toBeGreaterThan(0.15 * 0.15);
    expect(planned.selectedTrackIds.map(String)).toEqual([TRACK_B]);
    expect(planned.move.origin.kind === "face-analysis"
      ? planned.move.origin.trackIds.map(String)
      : []).toEqual([TRACK_B]);
    expect(planned.move.keyframes[0]?.pose.centerX).toBeGreaterThan(0.5);
  });

  test("applies the chosen gap policy when any required selected face disappears", () => {
    const value = project();
    const evidence = analysis();
    const missingOne = FaceAnalysisV1Schema.parse({
      ...evidence,
      results: evidence.results.map(result => (
        result.state === "analyzed" && result.assetTimeUs === 3_000_000
          ? {
            ...result,
            detections: result.detections.filter(detection => detection.trackId !== TRACK_B),
          }
          : result
      )),
      tracks: evidence.tracks.map(track => (
        track.trackId === TRACK_B
          ? { ...track, maximumObservedGapUs: 2_000_000, observationCount: 3 }
          : track
      )),
    });
    const base = {
      requireAllSelectedFaces: true,
      selection: { kind: "explicit" as const, trackIds: [TRACK_A, TRACK_B] },
    };

    expect(() => planProjectFaceCamera(options(value, missingOne, {
      ...base,
      cameraMoveId: "camera_requirefail",
      gapPolicy: "fail",
    }))).toThrow(/unavailable at asset time 3000000/u);

    const fallback = planProjectFaceCamera(options(value, missingOne, {
      ...base,
      cameraMoveId: "camera_requirefall",
      gapPolicy: "fallback",
    }));
    expect(fallback.move.keyframes.find(
      keyframe => keyframe.projectTimeUs === 4_500_000,
    )?.pose.zoom).toBe(1);

    const hold = planProjectFaceCamera(options(value, missingOne, {
      ...base,
      cameraMoveId: "camera_requirehold",
      gapPolicy: "hold",
    }));
    expect(hold.move.keyframes.find(
      keyframe => keyframe.projectTimeUs === 4_500_000,
    )?.pose).toEqual(hold.move.keyframes[0]?.pose);

    expect(() => planProjectFaceCamera(options(value, missingOne, {
      ...base,
      cameraMoveId: "camera_defaultpart",
      gapPolicy: "fail",
      requireAllSelectedFaces: false,
    }))).not.toThrow();
  });

  test("applies explicit gap policies and rejects out-of-bounds ranges", () => {
    const value = project();
    const evidence = analysis();
    expect(() => planProjectFaceCamera(options(value, evidence, {
      gapPolicy: "fail",
      selection: { kind: "explicit", trackIds: [TRACK_OUTSIDE_RANGE] },
    }))).toThrow(/unavailable at asset time/u);

    const fallback = planProjectFaceCamera(options(value, evidence, {
      cameraMoveId: "camera_fallback01",
      gapPolicy: "fallback",
      selection: { kind: "explicit", trackIds: [TRACK_OUTSIDE_RANGE] },
    }));
    expect(fallback.move.keyframes.every(keyframe => keyframe.pose.zoom === 1)).toBe(true);
    expect(fallback.move.keyframes[0]?.projectTimeUs).toBe(3_250_000);
    expect(fallback.move.keyframes.at(-1)?.projectTimeUs).toBe(8_250_000);

    expect(() => planProjectFaceCamera(options(value, evidence, {
      outputHeight: 16_384,
      outputWidth: 16_384,
    }))).toThrow(/dimensions/u);
    expect(() => planProjectFaceCamera(options(value, evidence, {
      projectRange: { endUs: 12_000_001, startUs: 3_250_000 },
    }))).toThrow(/exceeds the project timeline/u);
    expect(() => planProjectFaceCamera(options(value, evidence, {
      projectRange: { endUs: 4_000_000, startUs: 1_000_000 },
    }))).toThrow(/not fully covered/u);
  });

  test("rejects stale reference provenance and overlapping moves", () => {
    const value = project();
    const evidence = analysis();
    expect(() => planProjectFaceCamera(options(value, evidence, {
      reference: ProjectAnalysisReferenceSchema.parse({
        ...referenceFrom(value),
        analysisId: "analysis_other0001",
      }) as ProjectFaceCameraOptions["reference"],
    }))).toThrow(/analysis reference/u);

    const existing = planProjectFaceCamera(options(value, evidence)).move;
    const occupiedPlan = ProjectEditPlanV1Schema.parse({
      ...plan(value),
      cameraMoves: [existing],
    });
    expect(() => planProjectFaceCamera(options(value, evidence, {
      cameraMoveId: "camera_overlap001",
      plan: occupiedPlan,
    }))).toThrow(/overlaps an existing camera move/u);
  });
});

describe("face evidence project references and render bindings", () => {
  test("requires local face references to resolve to a video stream", () => {
    const reference = faceReference();
    expect(reference).toMatchObject({
      kind: "faces",
      localOnly: true,
      subjectIntegritySha256: SUBJECT_HASH,
    });
    expect(() => ProjectAnalysisReferenceSchema.parse({
      ...reference,
      localOnly: false,
    })).toThrow();

    const value = project();
    expect(() => VideoProjectV1Schema.parse({
      ...value,
      analyses: [{
        ...reference,
        streamId: "stream_camera_audio01",
      }],
    })).toThrow(/requires a video stream/u);
  });

  test("rejects normalized-layout face paths at a changed output aspect ratio", () => {
    const value = project("normalized");
    const evidence = analysis();
    const move = planProjectFaceCamera(options(value, evidence)).move;
    const withMove = ProjectEditPlanV1Schema.parse({
      ...plan(value),
      cameraMoves: [move],
    });
    const slice = sliceFor(value);

    expect(() => compileProjectCameraSegments(
      value,
      withMove,
      [slice],
      { pixelHeight: 1_080, pixelWidth: 1_920 },
    )).not.toThrow();
    expect(() => compileProjectCameraSegments(
      value,
      withMove,
      [slice],
      { pixelHeight: 1_080, pixelWidth: 1_080 },
    )).toThrow(/another render aspect ratio/u);
  });

  test("keeps pixel-layout face paths independent of output aspect ratio", () => {
    const value = project("output-pixels");
    const evidence = analysis();
    const move = planProjectFaceCamera(options(value, evidence)).move;
    expect(move.origin.kind === "face-analysis"
      ? move.origin.outputAspectRatio
      : "manual").toBeNull();
    const withMove = ProjectEditPlanV1Schema.parse({
      ...plan(value),
      cameraMoves: [move],
    });

    expect(() => compileProjectCameraSegments(
      value,
      withMove,
      [sliceFor(value)],
      { pixelHeight: 1_080, pixelWidth: 1_080 },
    )).not.toThrow();
  });
});
