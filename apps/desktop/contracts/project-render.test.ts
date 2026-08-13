import { describe, expect, test } from "bun:test";

import {
  PROJECT_EXPORT_PROFILES,
  PROJECT_FINAL_EXPORT_PROFILES,
  PROJECT_PREVIEW_EXPORT_PROFILES,
  ProjectCaptionRequestSchema,
  ProjectExportVariantSchema,
  ProjectRenderTargetSchema,
  ProjectRenderOutputPathSchema,
  ProjectRenderOutputRequestSchema,
  ProjectRenderPlanV1Schema,
  projectExportVariantId,
  resolveProjectExportProfile,
  resolveProjectRenderTarget,
} from "./project-render";
import { RenderPlanV1Schema } from "./render";

describe("libx264 yuv420p render dimensions", () => {
  test("accepts even positive recording and project output dimensions", () => {
    expect(() => RenderPlanV1Schema.shape.output.parse({
      durationUs: 1_000_000,
      frameRate: 30,
      pixelHeight: 240,
      pixelWidth: 320,
    })).not.toThrow();
    expect(() => ProjectRenderPlanV1Schema.shape.output.parse({
      background: "#000000ff",
      durationUs: 1_000_000,
      frameRate: 30,
      pixelHeight: 240,
      pixelWidth: 320,
    })).not.toThrow();
  });

  test("rejects 321 by 241 before either renderer can invoke FFmpeg", () => {
    expect(() => RenderPlanV1Schema.shape.output.parse({
      durationUs: 1_000_000,
      frameRate: 30,
      pixelHeight: 241,
      pixelWidth: 321,
    })).toThrow(/must be even/u);
    expect(() => ProjectRenderPlanV1Schema.shape.output.parse({
      background: "#000000ff",
      durationUs: 1_000_000,
      frameRate: 30,
      pixelHeight: 241,
      pixelWidth: 321,
    })).toThrow(/must be even/u);
  });
});

describe("standard project export profiles", () => {
  test("keeps the common YouTube and social geometries explicit and even", () => {
    expect(PROJECT_EXPORT_PROFILES).toEqual({
      "feed-portrait": {
        aspect: "4:5",
        frameRate: 30,
        id: "feed-portrait",
        pixelHeight: 1_350,
        pixelWidth: 1_080,
      },
      landscape: {
        aspect: "16:9",
        frameRate: 30,
        id: "landscape",
        pixelHeight: 1_080,
        pixelWidth: 1_920,
      },
      portrait: {
        aspect: "9:16",
        frameRate: 30,
        id: "portrait",
        pixelHeight: 1_920,
        pixelWidth: 1_080,
      },
      square: {
        aspect: "1:1",
        frameRate: 30,
        id: "square",
        pixelHeight: 1_080,
        pixelWidth: 1_080,
      },
    });
    expect(Object.values(PROJECT_EXPORT_PROFILES).every(Object.isFrozen)).toBe(true);
  });

  test("resolves full-length preview and final render tiers independently", () => {
    expect(PROJECT_PREVIEW_EXPORT_PROFILES).toEqual({
      "feed-portrait": {
        aspect: "4:5",
        frameRate: 24,
        id: "feed-portrait",
        pixelHeight: 540,
        pixelWidth: 432,
        tier: "preview",
      },
      landscape: {
        aspect: "16:9",
        frameRate: 24,
        id: "landscape",
        pixelHeight: 540,
        pixelWidth: 960,
        tier: "preview",
      },
      portrait: {
        aspect: "9:16",
        frameRate: 24,
        id: "portrait",
        pixelHeight: 960,
        pixelWidth: 540,
        tier: "preview",
      },
      square: {
        aspect: "1:1",
        frameRate: 24,
        id: "square",
        pixelHeight: 540,
        pixelWidth: 540,
        tier: "preview",
      },
    });
    expect(PROJECT_FINAL_EXPORT_PROFILES.landscape).toEqual({
      ...PROJECT_EXPORT_PROFILES.landscape,
      tier: "final",
    });
    for (const tier of ["preview", "final"] as const) {
      for (const profileId of Object.keys(PROJECT_EXPORT_PROFILES) as Array<
        keyof typeof PROJECT_EXPORT_PROFILES
      >) {
        const profile = resolveProjectExportProfile(profileId, tier);
        expect(profile.id).toBe(profileId);
        expect(profile.tier).toBe(tier);
        expect(profile.pixelWidth % 2).toBe(0);
        expect(profile.pixelHeight % 2).toBe(0);
        expect(Object.isFrozen(profile)).toBe(true);
      }
    }
  });

  test("keeps aspect, render tier, and caption presentation orthogonal", () => {
    const variant = ProjectExportVariantSchema.parse({
      captionMode: "burn-in",
      profileId: "portrait",
      tier: "preview",
    });
    expect(projectExportVariantId(variant)).toBe(
      "preview-portrait-burn-in",
    );
    expect(() => ProjectExportVariantSchema.parse({
      captionMode: "sidecar",
      profileId: "portrait",
      tier: "preview",
    })).toThrow();
  });

  test("resolves exact profile and custom canvas geometry", () => {
    expect(resolveProjectRenderTarget({
      canvas: { kind: "profile", profileId: "landscape" },
      tier: "preview",
    })).toEqual({
      frameRate: 24,
      pixelHeight: 540,
      pixelWidth: 960,
    });
    expect(resolveProjectRenderTarget({
      canvas: {
        frameRate: 60,
        kind: "custom",
        pixelHeight: 2_160,
        pixelWidth: 3_840,
      },
      tier: "final",
    })).toEqual({
      frameRate: 60,
      pixelHeight: 2_160,
      pixelWidth: 3_840,
    });
    expect(resolveProjectRenderTarget({
      canvas: {
        frameRate: 60,
        kind: "custom",
        pixelHeight: 2_160,
        pixelWidth: 3_840,
      },
      tier: "preview",
    })).toEqual({
      frameRate: 60,
      pixelHeight: 2_160,
      pixelWidth: 3_840,
    });
    expect(() => ProjectRenderTargetSchema.parse({
      canvas: { kind: "profile", profileId: "cinema" },
      tier: "preview",
    })).toThrow();
  });

  test("binds captions to one analysis and placement with a versioned style", () => {
    const request = ProjectCaptionRequestSchema.parse({
      analysisId: "analysis_caption0001",
      placementId: "placement_caption0001",
    });
    expect(String(request.analysisId)).toBe("analysis_caption0001");
    expect(String(request.placementId)).toBe("placement_caption0001");
    expect(request.style).toBe("social-block-v1");
    expect(() => ProjectCaptionRequestSchema.parse({
      analysisId: "analysis_caption0001",
      placementId: "placement_caption0001",
      style: "platform-current",
    })).toThrow();
  });
});

describe("workflow project render output boundary", () => {
  test("accepts only bounded final MP4 paths outside reserved render namespaces", () => {
    expect(ProjectRenderOutputRequestSchema.parse({
      maximumBytes: 512 * 1024 * 1024,
      path: "renders/social/vertical.mp4",
    })).toEqual({
      maximumBytes: 512 * 1024 * 1024,
      path: "renders/social/vertical.mp4",
    });

    for (const path of [
      "output.mp4",
      "renders/caption-assets/output.mp4",
      "renders/plans/output.mp4",
      "renders/receipts/output.mp4",
      "renders/.filter-graphs/output.mp4",
      "renders/output.mov",
      "renders/OUTPUT.MP4",
      "renders/.mp4",
    ]) {
      expect(() => ProjectRenderOutputPathSchema.parse(path)).toThrow();
    }
  });
});
