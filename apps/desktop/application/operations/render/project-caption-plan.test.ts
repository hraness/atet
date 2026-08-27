import { describe, expect, test } from "bun:test";

import { ProjectRenderPlanV1Schema } from "../../../contracts";
import {
  assertProjectRenderPlanComposition,
  hashProjectRenderPlanComposition,
  type ProjectCaptionCue,
} from "../../../core";
import {
  PROJECT_CAPTION_SPRITE_LIMITS,
  prepareProjectCaptionPlan,
} from "./project-caption-plan";

const SHA256 = "a".repeat(64);

function emptyPlan(durationUs: number) {
  const placeholder = ProjectRenderPlanV1Schema.parse({
    audioSlices: [],
    cameraKeyframes: [],
    cameraSegments: [],
    effects: {
      clickCues: [],
      clicks: { enabled: false },
      cursor: { enabled: false },
      cursorSamples: [],
      keystrokeCues: [],
      keystrokes: { enabled: false },
      typedText: { enabled: false },
      typingSpans: [],
    },
    kind: "atet.project-render-plan",
    output: {
      background: "#000000ff",
      durationUs,
      frameRate: 30,
      pixelHeight: 1_080,
      pixelWidth: 1_920,
    },
    overlays: [],
    planSha256: "0".repeat(64),
    projectEditPlanSha256: SHA256,
    projectId: "project_captionplan01",
    projectStructureSha256: SHA256,
    schemaVersion: 1,
    videoSlices: [],
    warnings: [],
  });
  return assertProjectRenderPlanComposition(ProjectRenderPlanV1Schema.parse({
    ...placeholder,
    planSha256: hashProjectRenderPlanComposition(placeholder),
  }));
}

function cues(count: number): readonly ProjectCaptionCue[] {
  return Array.from({ length: count }, (_, index) => ({
    lines: ["WWWWWWWWWW", "WWWWWWWWWW"],
    outputRange: { endUs: index + 1, startUs: index },
    projectRange: { endUs: index + 1, startUs: index },
    sourceWordIndices: [index],
  }));
}

function compactCues(count: number): readonly ProjectCaptionCue[] {
  return Array.from({ length: count }, (_, index) => ({
    lines: ["More is more"],
    outputRange: { endUs: index + 1, startUs: index },
    projectRange: { endUs: index + 1, startUs: index },
    sourceWordIndices: [index],
  }));
}

describe("caption sprite resource planning", () => {
  test("keeps hundreds of cues bounded without repeating a font payload", () => {
    const prepared = prepareProjectCaptionPlan({
      cues: compactCues(680),
      plan: emptyPlan(680),
      sourceSha256: "b".repeat(64),
      style: "social-block-v1",
    });
    const totalBytes = prepared.artifacts.reduce(
      (sum, artifact) => sum + Buffer.byteLength(artifact.contents, "utf8"),
      0,
    );

    expect(prepared.plan.overlays).toHaveLength(680);
    expect(prepared.artifacts.length).toBeGreaterThan(1);
    expect(totalBytes).toBeLessThan(512 * 1_024);
    expect(totalBytes).toBeLessThan(PROJECT_CAPTION_SPRITE_LIMITS.maximumTotalSvgBytes);
    for (const artifact of prepared.artifacts) {
      expect(artifact.contents).not.toContain("@font-face");
      expect(artifact.contents).not.toContain("data:font/");
      expect(artifact.contents).toContain('font-family="Nebula Sans"');
    }
  });

  test("bounds cumulative raster work before producing an unbounded overlay plan", () => {
    expect(PROJECT_CAPTION_SPRITE_LIMITS.maximumTotalPixels).toBe(
      64 * 1_024 * 1_024,
    );
    expect(() => prepareProjectCaptionPlan({
      cues: cues(2_000),
      plan: emptyPlan(2_000),
      sourceSha256: "b".repeat(64),
      style: "social-block-v1",
    })).toThrow(/cumulative raster resource bound/u);
  });
});
