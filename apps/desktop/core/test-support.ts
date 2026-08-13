import {
  EditPlanIdSchema,
  RecordingManifestV1Schema,
  type EditPlanV1,
  type RecordingManifestV1,
} from "../contracts";
import { createDefaultEditPlan } from "./plan";

const NOW = "2026-07-22T12:00:00.000Z";
const HASH = "0".repeat(64);

export function testManifest(): RecordingManifestV1 {
  return RecordingManifestV1Schema.parse({
    capture: { cursor: "metadata", typedText: "disabled", windowMetadata: "titles-and-bounds" },
    coordinateSpace: { kind: "global-display-points", origin: "top-left", xAxis: "right", yAxis: "down" },
    createdAt: NOW,
    diagnostics: [],
    eventStreams: [],
    kind: "studio.recording-bundle",
    permissions: {
      accessibility: "authorized",
      camera: "authorized",
      inputMonitoring: "authorized",
      microphone: "authorized",
      screenCapture: "authorized",
      systemAudio: "authorized",
      windowMetadata: "authorized",
    },
    platform: { architecture: "arm64", os: "macos", osVersion: "26.0" },
    recordingId: "rec_example001",
    schemaVersion: 1,
    sources: {
      audio: [
        { audioSourceId: "audio-system", channels: 2, kind: "system", label: "System", sampleRateHz: 48_000 },
        { audioSourceId: "audio-mic", channels: 1, kind: "microphone", label: "Mic", sampleRateHz: 48_000 },
      ],
      cameras: [],
      displays: [
        {
          bounds: { height: 1080, width: 1920, x: 0, y: 0 },
          displayId: "display-primary",
          isPrimary: true,
          label: "Primary",
          pixelSize: { height: 2160, width: 3840 },
          refreshRateHz: 60,
          scaleFactor: 2,
        },
        {
          bounds: { height: 1024, width: 1280, x: -1280, y: 56 },
          displayId: "display-left",
          isPrimary: false,
          label: "Left",
          pixelSize: { height: 1024, width: 1280 },
          refreshRateHz: 60,
          scaleFactor: 1,
        },
      ],
    },
    state: "stopped",
    timeline: { durationUs: 10_000_000, timebase: "microseconds" },
    tool: { captureVersion: "1.0.0", name: "studio", version: "0.1.0" },
    tracks: [
      {
        enabled: true,
        kind: "display-video",
        label: "Primary",
        segments: [{
          codec: "h264",
          container: "mp4",
          containerTrackIdentity: { containerTrackId: "1", kind: "verified" },
          endUs: 10_000_000,
          integrity: { bytes: 100, sha256: HASH, state: "verified" },
          nativeEndUs: 11_000_000,
          nativeStartUs: 1_000_000,
          path: "media/segment-1.mp4",
          segmentId: "segment_video001",
          startUs: 0,
          streamIndex: 0,
        }],
        source: { displayId: "display-primary" },
        trackId: "track_display01",
      },
      {
        enabled: true,
        kind: "display-video",
        label: "Left",
        segments: [{
          codec: "h264",
          container: "mp4",
          containerTrackIdentity: { containerTrackId: "2", kind: "verified" },
          endUs: 10_000_000,
          integrity: { bytes: 100, sha256: HASH, state: "verified" },
          nativeEndUs: 11_000_000,
          nativeStartUs: 1_000_000,
          path: "media/segment-left.mp4",
          segmentId: "segment_video002",
          startUs: 0,
          streamIndex: 0,
        }],
        source: { displayId: "display-left" },
        trackId: "track_display02",
      },
      {
        enabled: true,
        kind: "system-audio",
        label: "System",
        segments: [{
          codec: "aac",
          container: "mp4",
          containerTrackIdentity: { containerTrackId: "3", kind: "verified" },
          endUs: 10_000_000,
          integrity: { bytes: 100, sha256: HASH, state: "verified" },
          nativeEndUs: 11_000_000,
          nativeStartUs: 1_000_000,
          path: "media/segment-1.mp4",
          segmentId: "segment_audio001",
          startUs: 0,
          streamIndex: 1,
        }],
        source: { audioSourceId: "audio-system" },
        trackId: "track_system001",
      },
      {
        enabled: true,
        kind: "microphone-audio",
        label: "Mic",
        segments: [{
          codec: "aac",
          container: "mp4",
          containerTrackIdentity: {
            diagnosticCode: "capture-role-only",
            expectedRole: "microphone-audio",
            kind: "provisional",
          },
          endUs: 10_000_000,
          integrity: { bytes: 100, sha256: HASH, state: "verified" },
          nativeEndUs: 11_000_000,
          nativeStartUs: 1_000_000,
          path: "media/segment-1.mp4",
          segmentId: "segment_audio002",
          startUs: 0,
          streamIndex: 2,
        }],
        source: { audioSourceId: "audio-mic" },
        trackId: "track_microphone01",
      },
    ],
    updatedAt: NOW,
  });
}

export function testPlan(): EditPlanV1 {
  return createDefaultEditPlan(testManifest(), EditPlanIdSchema.parse("plan_example001"), NOW);
}
