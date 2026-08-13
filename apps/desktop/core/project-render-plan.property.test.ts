import { expect } from "bun:test";
import { assertProperty, fc } from "../testing/property";

import {
  EditPlanIdSchema,
  ProjectEditPlanV1Schema,
  VideoProjectV1Schema,
  type OverlayOperation,
  type VideoProjectV1,
} from "../contracts";
import { createDefaultProjectEditPlan } from "./project-plan";
import { compileProjectRenderPlan } from "./project-render-plan";

const HASH = "b".repeat(64);
const NOW = "2026-07-22T12:00:00.000Z";

function videoAsset(
  assetId: "asset_property_ref" | "asset_property_target",
  streamId: "stream_property_ref" | "stream_property_target",
  durationUs: number,
  role: "screen" | "camera",
) {
  return {
    assetId,
    createdAt: NOW,
    durationUs,
    label: role === "screen" ? "Reference" : "Drifting target",
    role,
    source: {
      importedAt: NOW,
      kind: "imported" as const,
      originalName: `${role}.mov`,
      sourceSha256: HASH,
    },
    streams: [{
      frameRate: 30,
      kind: "video" as const,
      label: `${role} video`,
      pixelHeight: 720,
      pixelWidth: 1_280,
      role,
      segments: [{
        assetRange: { endUs: durationUs, startUs: 0 },
        bytes: 1_024,
        codec: "h264",
        container: "mov",
        fileRange: { endUs: durationUs + 250_000, startUs: 250_000 },
        path: `fixtures/${role}.mov`,
        sha256: HASH,
        streamIndex: 0,
      }],
      streamId,
    }],
  };
}

function presentation(layer: number) {
  return {
    blendMode: "normal" as const,
    crop: { kind: "none" as const },
    enabled: true as const,
    fit: "contain" as const,
    layer,
    layout: { height: 1, kind: "normalized" as const, width: 1, x: 0, y: 0 },
    opacity: 1,
  };
}

function project(projectDurationUs: number, targetDurationUs: number): VideoProjectV1 {
  return VideoProjectV1Schema.parse({
    analyses: [],
    assets: [
      videoAsset("asset_property_ref", "stream_property_ref", projectDurationUs, "screen"),
      videoAsset("asset_property_target", "stream_property_target", targetDurationUs, "camera"),
    ],
    createdAt: NOW,
    currentEditPlanPath: "edits/current.json",
    kind: "studio.video-project",
    name: "Property render",
    placements: [{
      assetId: "asset_property_ref",
      assetRange: { endUs: projectDurationUs, startUs: 0 },
      audio: [],
      enabled: true,
      placementId: "placement_property_ref",
      sync: {
        anchors: [
          { assetTimeUs: 0, projectTimeUs: 0 },
          { assetTimeUs: projectDurationUs, projectTimeUs: projectDurationUs },
        ],
        provenance: { kind: "identity" },
      },
      video: [{ presentation: presentation(0), streamId: "stream_property_ref" }],
    }, {
      assetId: "asset_property_target",
      assetRange: { endUs: targetDurationUs, startUs: 0 },
      audio: [],
      enabled: true,
      placementId: "placement_property_target",
      sync: {
        anchors: [
          { assetTimeUs: 0, projectTimeUs: 0 },
          { assetTimeUs: targetDurationUs, projectTimeUs: projectDurationUs },
        ],
        provenance: { kind: "manual", note: "Property-test drift map" },
      },
      video: [{ presentation: presentation(1), streamId: "stream_property_target" }],
    }],
    projectId: "project_property_render",
    referencePlacementId: "placement_property_ref",
    schemaVersion: 1,
    timeline: { durationUs: projectDurationUs, timebase: "microseconds" },
    updatedAt: NOW,
  });
}

function overlay(durationUs: number): OverlayOperation {
  return {
    anchor: "center",
    coordinateSpace: "output-pixels",
    entrance: { kind: "none" },
    exit: { kind: "none" },
    intrinsicSize: { height: 64, width: 64 },
    opacity: 1,
    overlayId: "overlay_property_render",
    position: { x: 0, y: 0 },
    range: { endUs: durationUs, startUs: 0 },
    rotationDegrees: 0,
    scale: 1,
    size: { kind: "intrinsic" },
    source: {
      asset: {
        bytes: 1,
        mediaType: "image/webp",
        path: "assets/property.webp",
        provenance: { kind: "imported", originalName: "property.webp", sourceSha256: HASH },
        sha256: HASH,
      },
      kind: "image",
    },
    zIndex: 0,
  };
}

assertProperty(fc.property(
  fc.integer({ min: 100_000, max: 2_000_000 }),
  fc.integer({ min: 100_000, max: 2_000_000 }),
  fc.integer({ min: 100_000, max: 2_000_000 }),
  fc.integer({ min: 100_000, max: 2_000_000 }),
  fc.integer({ min: -50_000, max: 50_000 }),
  fc.constantFrom(0.5, 1.5, 2, 4),
  (prefixUs, cutUs, acceleratedUs, suffixUs, driftUs, speed) => {
    const projectDurationUs = prefixUs + cutUs + acceleratedUs + suffixUs;
    const targetDurationUs = projectDurationUs + driftUs;
    const acceleratedStartUs = prefixUs + cutUs;
    const acceleratedEndUs = acceleratedStartUs + acceleratedUs;
    const item = project(projectDurationUs, targetDurationUs);
    const basePlan = createDefaultProjectEditPlan(
      item,
      EditPlanIdSchema.parse("plan_property_render"),
      NOW,
    );
    const plan = ProjectEditPlanV1Schema.parse({
      ...basePlan,
      keep: [
        { endUs: prefixUs, startUs: 0 },
        { endUs: projectDurationUs, startUs: acceleratedStartUs },
      ],
      overlays: [overlay(projectDurationUs)],
      speed: [{ range: { endUs: acceleratedEndUs, startUs: acceleratedStartUs }, rate: speed }],
    });

    const render = compileProjectRenderPlan(item, plan);
    const expectedDurationUs = prefixUs + Math.max(1, Math.round(acceleratedUs / speed)) + suffixUs;
    expect(render.output.durationUs).toBe(expectedDurationUs);
    expect(render.warnings).toEqual([]);
    expect(compileProjectRenderPlan(item, plan)).toEqual(render);

    const reference = render.videoSlices.filter(slice => slice.placementId === "placement_property_ref");
    const target = render.videoSlices.filter(slice => slice.placementId === "placement_property_target");
    const sharedClock = (slice: (typeof reference)[number]) => ({
      outputRange: slice.outputRange,
      projectRange: slice.projectRange,
      projectSpeed: slice.projectSpeed,
    });
    expect(target.map(sharedClock)).toEqual(reference.map(sharedClock));

    for (const slices of [reference, target]) {
      expect(slices[0]?.outputRange.startUs).toBe(0);
      expect(slices.at(-1)?.outputRange.endUs).toBe(expectedDurationUs);
      for (let index = 0; index < slices.length; index += 1) {
        const slice = slices[index]!;
        expect(slice.outputRange.startUs).toBeGreaterThanOrEqual(0);
        expect(slice.outputRange.endUs).toBeGreaterThan(slice.outputRange.startUs);
        expect(slice.outputRange.endUs).toBeLessThanOrEqual(expectedDurationUs);
        expect(slice.assetRange.endUs).toBeGreaterThan(slice.assetRange.startUs);
        expect(slice.assetRange.startUs).toBeGreaterThanOrEqual(0);
        expect(slice.fileRange.endUs - slice.fileRange.startUs)
          .toBe(slice.assetRange.endUs - slice.assetRange.startUs);
        expect(slice.projectRange.startUs < acceleratedStartUs
          && slice.projectRange.endUs > prefixUs).toBe(false);
        if (index > 0) {
          expect(slice.outputRange.startUs).toBe(slices[index - 1]!.outputRange.endUs);
          expect(slice.assetRange.startUs).toBeGreaterThanOrEqual(slices[index - 1]!.assetRange.endUs);
        }
      }
    }

    expect(render.overlays).toHaveLength(3);
    let visibleCursorUs = 0;
    for (let index = 0; index < render.overlays.length; index += 1) {
      const resolved = render.overlays[index]!;
      expect(resolved.playbackOffsetUs).toBe(visibleCursorUs);
      expect(resolved.visibleDurationUs).toBe(expectedDurationUs);
      expect(resolved.outputRange.startUs).toBe(visibleCursorUs);
      expect(resolved.outputRange.endUs).toBeLessThanOrEqual(expectedDurationUs);
      visibleCursorUs += resolved.outputRange.endUs - resolved.outputRange.startUs;
    }
    expect(visibleCursorUs).toBe(expectedDurationUs);
  },
), { interruptAfterTimeLimit: 60_000 });
