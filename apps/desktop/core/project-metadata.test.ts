import { describe, expect, test } from "bun:test";

import {
  EditPlanIdSchema,
  ProjectCameraMoveSchema,
  ProjectEditPlanV1Schema,
  ProjectPlacementIdSchema,
  RecordingEventV1Schema,
  RecordingManifestV1Schema,
  VideoProjectV1Schema,
  type RecordingEventV1,
  type ProjectCameraMove,
  type ProjectEditPlanV1,
  type VideoProjectV1,
} from "../contracts";
import {
  hashProjectCameraGeometry,
  hashProjectCameraSync,
} from "./project-camera";
import { createDefaultProjectEditPlan } from "./project-plan";
import { compileProjectRenderPlan } from "./project-render-plan";
import { testManifest } from "./test-support";

const NOW = "2026-07-22T12:00:00.000Z";
const HASH = "0".repeat(64);

function metadataProject(): VideoProjectV1 {
  return VideoProjectV1Schema.parse({
    analyses: [],
    assets: [{
      assetId: "asset_metadata01",
      createdAt: NOW,
      durationUs: 10_000_000,
      label: "Recorded desktop",
      role: "screen",
      source: {
        kind: "recording",
        recordingId: "rec_example001",
        trackIds: ["track_display01"],
      },
      streams: [{
        frameRate: 60,
        kind: "video",
        label: "Primary display",
        pixelHeight: 2_160,
        pixelWidth: 3_840,
        role: "screen",
        segments: [{
          assetRange: { endUs: 10_000_000, startUs: 0 },
          bytes: 100,
          codec: "h264",
          container: "mp4",
          fileRange: { endUs: 10_000_000, startUs: 0 },
          path: "artifacts/transmute/recordings/rec_example001/media/segment-1.mp4",
          sha256: HASH,
          streamIndex: 0,
        }],
        streamId: "stream_display01",
      }],
    }],
    createdAt: NOW,
    currentEditPlanPath: "edits/current.json",
    kind: "studio.video-project",
    name: "Metadata project",
    placements: [{
      assetId: "asset_metadata01",
      assetRange: { endUs: 10_000_000, startUs: 0 },
      audio: [],
      enabled: true,
      placementId: "placement_metadata01",
      sync: {
        anchors: [
          { assetTimeUs: 0, projectTimeUs: 0 },
          { assetTimeUs: 10_000_000, projectTimeUs: 10_000_000 },
        ],
        provenance: { kind: "identity" },
      },
      video: [{
        presentation: {
          blendMode: "normal",
          crop: { kind: "none" },
          enabled: true,
          fit: "fill",
          layer: 0,
          layout: { height: 1, kind: "normalized", width: 1, x: 0, y: 0 },
          opacity: 1,
        },
        streamId: "stream_display01",
      }],
    }],
    projectId: "project_metadata01",
    referencePlacementId: "placement_metadata01",
    schemaVersion: 1,
    timeline: { durationUs: 10_000_000, timebase: "microseconds" },
    updatedAt: NOW,
  });
}

function ambiguousMetadataProject(): VideoProjectV1 {
  const project = metadataProject();
  return VideoProjectV1Schema.parse({
    ...project,
    assets: project.assets.map(asset => {
      const video = asset.streams.find(stream => stream.kind === "video");
      return {
        ...asset,
        source: asset.source.kind === "recording"
          ? {
              ...asset.source,
              trackIds: [
                ...asset.source.trackIds,
                "track_display02",
              ],
            }
          : asset.source,
        streams: video === undefined
          ? asset.streams
          : [
              ...asset.streams,
              {
                ...video,
                label: "Ambiguous primary display",
                segments: video.segments.map(segment => ({
                  ...segment,
                  path: "artifacts/transmute/recordings/rec_example001/media/segment-left.mp4",
                })),
                streamId: "stream_display02",
              },
            ],
      };
    }),
    placements: project.placements.map(placement => ({
      ...placement,
      video: placement.video.flatMap(configured => [
        configured,
        {
          ...configured,
          presentation: configured.presentation.enabled
            ? {
                ...configured.presentation,
                crop: {
                  bottom: 0,
                  kind: "normalized-insets",
                  left: 0.5,
                  right: 0,
                  top: 0,
                },
                layer: configured.presentation.layer + 1,
              }
            : configured.presentation,
          streamId: "stream_display02",
        },
      ]),
    })),
  });
}

function metadataEvents(): readonly RecordingEventV1[] {
  const window = {
    applicationBundleId: "com.example.Editor",
    applicationName: "Editor",
    bounds: { height: 600, width: 1_000, x: 700, y: 200 },
    displayId: "display-primary",
    isFocused: true,
    layer: 1,
    title: { state: "available", value: "Editor" },
    windowId: "window-editor",
  } as const;
  return [
    {
      nativeTimeUs: 0,
      sequence: 0,
      sourceTimeUs: 0,
      type: "window.snapshot",
      windows: [window],
    },
    {
      displayId: "display-primary",
      nativeTimeUs: 2_000_000,
      position: { x: 1_200, y: 600 },
      sequence: 1,
      sourceTimeUs: 2_000_000,
      type: "cursor.sample",
      visible: true,
    },
    {
      button: "left",
      clickCount: 1,
      displayId: "display-primary",
      nativeTimeUs: 2_000_000,
      phase: "down",
      position: { x: 1_200, y: 600 },
      sequence: 2,
      sourceTimeUs: 2_000_000,
      type: "mouse.click",
    },
    {
      activity: { kind: "printable", modifiers: [], phase: "down", repeat: false, token: "[PRINTABLE]" },
      nativeTimeUs: 2_100_000,
      sequence: 3,
      sourceTimeUs: 2_100_000,
      type: "key.activity",
    },
    {
      input: {
        action: "insert",
        bounds: { height: 40, width: 320, x: 1_100, y: 550 },
        fieldId: "field-editor",
        secure: false,
        text: "h",
        windowId: "window-editor",
      },
      nativeTimeUs: 2_200_000,
      sequence: 4,
      sourceTimeUs: 2_200_000,
      type: "typing.input",
    },
  ].map(value => RecordingEventV1Schema.parse(value));
}

function metadataEventsAt(baseTimeUs: number): readonly RecordingEventV1[] {
  return metadataEvents().map((event) => RecordingEventV1Schema.parse({
    ...event,
    nativeTimeUs: event.nativeTimeUs + baseTimeUs - 2_000_000,
    sourceTimeUs: event.sourceTimeUs === 0
      ? 0
      : event.sourceTimeUs + baseTimeUs - 2_000_000,
  }));
}

function enabledMetadataEffects(): ProjectEditPlanV1["effects"] {
  return {
    clicks: {
      color: "#ffcc00cc",
      durationUs: 350_000,
      enabled: true,
      radiusPx: 28,
      style: "pulse",
    },
    cursor: {
      enabled: true,
      scale: 1,
      smoothing: { algorithm: "none", strength: 0 },
      style: "captured",
    },
    keystrokes: { enabled: false },
    metadataPlacementId: ProjectPlacementIdSchema.parse(
      "placement_metadata01",
    ),
    typedText: {
      enabled: true,
      idleTimeoutUs: 1_000_000,
      maxCharacters: 160,
      placement: "input",
      secureText: "hide",
    },
  };
}

function cameraMove(
  project: VideoProjectV1,
  input: Readonly<{
    readonly cameraMoveId: string;
    readonly centerX: number;
    readonly origin: unknown;
  }>,
): ProjectCameraMove {
  const placement = project.placements[0]!;
  const streamId = placement.video[0]!.streamId;
  const pose = {
    centerX: input.centerX,
    centerY: 0.5,
    space: "prepared-video-layer-normalized-v1" as const,
    zoom: 2,
  };
  return ProjectCameraMoveSchema.parse({
    binding: {
      geometrySha256: hashProjectCameraGeometry(
        project,
        placement.placementId,
        streamId,
      ),
      syncSha256: hashProjectCameraSync(placement),
    },
    cameraMoveId: input.cameraMoveId,
    keyframes: [{
      outgoingEasing: { kind: "linear" },
      pose,
      projectTimeUs: 0,
    }, {
      outgoingEasing: { kind: "linear" },
      pose,
      projectTimeUs: 10_000_000,
    }],
    origin: input.origin,
    placementId: placement.placementId,
    projectRange: { endUs: 10_000_000, startUs: 0 },
    streamId,
  });
}

describe("project metadata compilation", () => {
  test("maps recording zoom, cursor, click, keystroke, and typed text through the shared project clock", () => {
    const project = metadataProject();
    const base = createDefaultProjectEditPlan(project, EditPlanIdSchema.parse("plan_metadata01"), NOW);
    const plan = ProjectEditPlanV1Schema.parse({
      ...base,
      effects: {
        clicks: { color: "#ffcc00cc", durationUs: 350_000, enabled: true, radiusPx: 28, style: "pulse" },
        cursor: {
          enabled: true,
          scale: 1,
          smoothing: { algorithm: "exponential", strength: 0.7 },
          style: "captured",
        },
        keystrokes: {
          enabled: true,
          holdUs: 1_000_000,
          maxKeys: 8,
          position: "bottom-right",
          secureText: "hide",
        },
        metadataPlacementId: "placement_metadata01",
        typedText: {
          enabled: true,
          idleTimeoutUs: 1_000_000,
          maxCharacters: 160,
          placement: "input",
          secureText: "hide",
        },
      },
      zooms: [{
        operation: {
          displayId: "display-primary",
          easing: { kind: "ease-in-out" },
          enterDurationUs: 0,
          exitDurationUs: 0,
          kind: "manual",
          range: { endUs: 3_000_000, startUs: 1_000_000 },
          scale: 2,
          target: { kind: "point", point: { x: 1_200, y: 600 } },
          zoomId: "zoom_metadata01",
        },
        placementId: "placement_metadata01",
      }],
    });
    const focusBoundary = RecordingEventV1Schema.parse({
      nativeTimeUs: 2_400_000,
      sequence: 5,
      sourceTimeUs: 2_400_000,
      target: { kind: "none" },
      type: "focus.changed",
    });
    const render = compileProjectRenderPlan(project, plan, {
      frameRate: 60,
      metadata: [{
        events: [...metadataEvents(), focusBoundary],
        manifest: testManifest(),
        placementId: project.referencePlacementId,
      }],
      pixelHeight: 1_080,
      pixelWidth: 1_920,
    });

    expect(render.cameraKeyframes.map(keyframe => ({
      placementId: String(keyframe.placementId),
      streamId: String(keyframe.streamId),
      timeUs: keyframe.outputTimeUs,
      viewport: keyframe.viewport,
    }))).toEqual([{
      placementId: "placement_metadata01",
      streamId: "stream_display01",
      timeUs: 1_000_000,
      viewport: { height: 540, width: 960, x: 720, y: 330 },
    }, {
      placementId: "placement_metadata01",
      streamId: "stream_display01",
      timeUs: 3_000_000,
      viewport: { height: 540, width: 960, x: 720, y: 330 },
    }]);
    expect(render.effects.cursorSamples[0]?.position).toEqual({ x: 960, y: 540 });
    expect(render.effects.clickCues[0]?.position).toEqual({ x: 960, y: 540 });
    expect(render.effects.keystrokeCues[0]?.outputTimeUs).toBe(2_100_000);
    const typing = render.effects.typingSpans[0];
    expect(typing?.secure).toBe(false);
    if (typing?.secure === false) {
      expect(typing.updates[0]?.text).toBe("h");
      expect(typing.updates[0]?.bounds.x).toBe(760);
      expect(typing.updates[0]?.bounds.y).toBe(440);
      expect(typing.endSourceUs).toBe(2_400_000);
      expect(typing.endOutputUs).toBe(2_400_000);
    }
  });

  test("fails closed when a configured zoom has no recording metadata context", () => {
    const project = metadataProject();
    const base = createDefaultProjectEditPlan(project, EditPlanIdSchema.parse("plan_metadata02"), NOW);
    const plan = ProjectEditPlanV1Schema.parse({
      ...base,
      zooms: [{
        operation: {
          displayId: "display-primary",
          easing: { kind: "linear" },
          enterDurationUs: 100_000,
          exitDurationUs: 100_000,
          kind: "manual",
          range: { endUs: 2_000_000, startUs: 1_000_000 },
          scale: 2,
          target: { kind: "cursor", sampling: "interpolated" },
          zoomId: "zoom_metadata02",
        },
        placementId: "placement_metadata01",
      }],
    });
    expect(() => compileProjectRenderPlan(project, plan)).toThrow(/requires metadata/u);
  });

  test("rejects an ambiguous same-display layer instead of retargeting by track order", () => {
    const project = ambiguousMetadataProject();
    const base = createDefaultProjectEditPlan(
      project,
      EditPlanIdSchema.parse("plan_metadata03"),
      NOW,
    );
    const plan = ProjectEditPlanV1Schema.parse({
      ...base,
      zooms: [{
        operation: {
          displayId: "display-primary",
          easing: { kind: "linear" },
          enterDurationUs: 0,
          exitDurationUs: 0,
          kind: "manual",
          range: { endUs: 2_000_000, startUs: 1_000_000 },
          scale: 2,
          target: { kind: "point", point: { x: 1_200, y: 600 } },
          zoomId: "zoom_metadata03",
        },
        placementId: project.referencePlacementId,
      }],
    });
    const manifest = testManifest();
    const ambiguousManifest = RecordingManifestV1Schema.parse({
      ...manifest,
      tracks: manifest.tracks.map(track => (
        track.kind === "display-video"
        && track.trackId === "track_display02"
          ? {
              ...track,
              source: { displayId: "display-primary" },
            }
          : track
      )),
    });
    expect(() => compileProjectRenderPlan(project, plan, {
      frameRate: 60,
      metadata: [{
        events: [],
        manifest: ambiguousManifest,
        placementId: project.referencePlacementId,
      }],
      pixelHeight: 1_080,
      pixelWidth: 1_920,
    })).toThrow(/multiple enabled recording video layers/u);
  });

  test("maps cursor, click, and focused-input text through a manual camera segment", () => {
    const project = metadataProject();
    const base = createDefaultProjectEditPlan(
      project,
      EditPlanIdSchema.parse("plan_metadata04"),
      NOW,
    );
    const plan = ProjectEditPlanV1Schema.parse({
      ...base,
      cameraMoves: [cameraMove(project, {
        cameraMoveId: "camera_metadata04",
        centerX: 0.5,
        origin: { kind: "manual" },
      })],
      effects: enabledMetadataEffects(),
    });
    const render = compileProjectRenderPlan(project, plan, {
      frameRate: 60,
      metadata: [{
        events: metadataEvents(),
        manifest: testManifest(),
        placementId: project.referencePlacementId,
      }],
      pixelHeight: 1_080,
      pixelWidth: 1_920,
    });

    expect(render.cameraSegments).toHaveLength(1);
    expect(render.effects.cursorSamples[0]).toMatchObject({
      outputTimeUs: 2_000_000,
      position: { x: 1_440, y: 660 },
    });
    expect(render.effects.clickCues[0]).toMatchObject({
      outputTimeUs: 2_000_000,
      position: { x: 1_440, y: 660 },
    });
    const typing = render.effects.typingSpans[0];
    expect(typing?.secure).toBe(false);
    if (typing?.secure === false) {
      expect(typing.updates[0]).toMatchObject({
        bounds: { height: 80, width: 640, x: 1_240, y: 560 },
        outputTimeUs: 2_200_000,
      });
    }
  });

  test("uses the face-camera segment selected after a cut and speed boundary", () => {
    const project = metadataProject();
    const base = createDefaultProjectEditPlan(
      project,
      EditPlanIdSchema.parse("plan_metadata05"),
      NOW,
    );
    const placement = project.placements[0]!;
    const streamId = placement.video[0]!.streamId;
    const plan = ProjectEditPlanV1Schema.parse({
      ...base,
      cameraMoves: [cameraMove(project, {
        cameraMoveId: "camera_metadata05",
        centerX: 0.25,
        origin: {
          analysisId: "analysis_metadata05",
          analysisSha256: HASH,
          assetId: placement.assetId,
          assetRange: placement.assetRange,
          kind: "face-analysis",
          outputAspectRatio: 16 / 9,
          streamId,
          subjectIntegritySha256: HASH,
          trackIds: ["face_metadata05"],
        },
      })],
      effects: enabledMetadataEffects(),
      keep: [
        { endUs: 4_000_000, startUs: 0 },
        { endUs: 10_000_000, startUs: 6_000_000 },
      ],
      speed: [{
        range: { endUs: 4_000_000, startUs: 0 },
        rate: 2,
      }],
    });
    const render = compileProjectRenderPlan(project, plan, {
      frameRate: 60,
      metadata: [{
        events: metadataEventsAt(6_000_000),
        manifest: testManifest(),
        placementId: project.referencePlacementId,
      }],
      pixelHeight: 1_080,
      pixelWidth: 1_920,
    });

    expect(render.cameraSegments.map(segment => ({
      outputRange: segment.outputRange,
      projectRange: segment.projectRange,
    }))).toEqual([{
      outputRange: { endUs: 2_000_000, startUs: 0 },
      projectRange: { endUs: 4_000_000, startUs: 0 },
    }, {
      outputRange: { endUs: 6_000_000, startUs: 2_000_000 },
      projectRange: { endUs: 10_000_000, startUs: 6_000_000 },
    }]);
    expect(render.effects.cursorSamples[0]).toMatchObject({
      outputTimeUs: 2_000_000,
      position: { x: 2_400, y: 660 },
    });
    expect(render.effects.clickCues[0]).toMatchObject({
      outputTimeUs: 2_000_000,
      position: { x: 2_400, y: 660 },
    });
    const typing = render.effects.typingSpans[0];
    expect(typing?.secure).toBe(false);
    if (typing?.secure === false) {
      expect(typing.updates[0]).toMatchObject({
        bounds: { height: 80, width: 640, x: 2_200, y: 560 },
        outputTimeUs: 2_200_000,
      });
    }
  });
});
