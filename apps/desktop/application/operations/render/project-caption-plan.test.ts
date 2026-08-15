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

describe("caption sprite resource planning", () => {
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
