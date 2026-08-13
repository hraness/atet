import { describe, expect, test } from "bun:test";

import {
  FaceFollowRequestOptionsSchema,
  FollowFacesInputSchema,
} from "./follow-faces";

const REQUEST = {
  placementId: "placement_camera01",
  projectRange: { endUs: 5_000_000, startUs: 0 },
} as const;

const OPERATION_INPUT = {
  ...REQUEST,
  analysisId: "analysis_faces0001",
  aspect: "16:9",
  project: "project_fixture",
} as const;

describe("face-follow request defaults", () => {
  test("validates zoom ordering against the effective default maximum", () => {
    expect(FaceFollowRequestOptionsSchema.safeParse({
      ...REQUEST,
      minimumZoom: 5,
    }).success).toBe(false);
    expect(FollowFacesInputSchema.safeParse({
      ...OPERATION_INPUT,
      minimumZoom: 5,
    }).success).toBe(false);
    expect(FollowFacesInputSchema.safeParse({
      ...OPERATION_INPUT,
      minimumZoom: 4,
    }).success).toBe(true);
  });

  test("validates require-all against the effective largest-face selection", () => {
    expect(FaceFollowRequestOptionsSchema.safeParse({
      ...REQUEST,
      requireAllSelectedFaces: true,
    }).success).toBe(false);
    expect(FollowFacesInputSchema.safeParse({
      ...OPERATION_INPUT,
      requireAllSelectedFaces: true,
    }).success).toBe(false);
    expect(FollowFacesInputSchema.safeParse({
      ...OPERATION_INPUT,
      requireAllSelectedFaces: true,
      selection: { kind: "all" },
    }).success).toBe(true);
  });
});
