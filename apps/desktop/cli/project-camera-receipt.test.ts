import { describe, expect, test } from "bun:test";

import {
  ProjectCameraCreateReceiptSchema,
  ProjectCameraEditReceiptSchema,
  ProjectCameraRemoveReceiptSchema,
} from "./project-camera-receipt";

const HASH = "a".repeat(64);

function nextCommands(cameraMoveId = "camera_receipt01") {
  return {
    remove: `transmute project edit project_receipt01 camera remove ${cameraMoveId} --json`,
    show: "transmute project edit project_receipt01 camera show --json",
  };
}

describe("project camera mutation receipts", () => {
  test("returns the created move, bounded face selection, and exact next commands", () => {
    const receipt = ProjectCameraCreateReceiptSchema.parse({
      cameraMoveId: "camera_receipt01",
      cameraMoves: 3,
      keyframeCount: 12,
      nextCommands: nextCommands(),
      operation: "follow-faces",
      planHash: HASH,
      projectId: "project_receipt01",
      selection: {
        kind: "largest",
        requireAllSelected: false,
        trackIds: ["face_subjecta1", "face_subjectb1"],
      },
    });

    expect(ProjectCameraEditReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(receipt.nextCommands.remove).toContain(String(receipt.cameraMoveId));
    expect(receipt.selection?.trackIds.map(String)).toEqual(["face_subjecta1", "face_subjectb1"]);
  });

  test("keeps manual and removal receipts concise and strict", () => {
    expect(() => ProjectCameraCreateReceiptSchema.parse({
      cameraMoveId: "camera_receipt02",
      cameraMoves: 1,
      keyframeCount: 2,
      nextCommands: nextCommands("camera_receipt02"),
      operation: "push",
      planHash: HASH,
      projectId: "project_receipt01",
      selection: null,
    })).not.toThrow();

    expect(() => ProjectCameraCreateReceiptSchema.parse({
      cameraMoveId: "camera_receipt09",
      cameraMoves: 2,
      keyframeCount: 24,
      nextCommands: nextCommands("camera_receipt09"),
      operation: "path",
      planHash: HASH,
      projectId: "project_receipt01",
      selection: null,
    })).not.toThrow();

    expect(() => ProjectCameraRemoveReceiptSchema.parse({
      cameraMoveId: "camera_receipt02",
      cameraMoves: 0,
      keyframeCount: 2,
      nextCommands: {
        show: "transmute project edit project_receipt01 camera show --json",
      },
      operation: "remove",
      planHash: HASH,
      projectId: "project_receipt01",
    })).not.toThrow();

    expect(() => ProjectCameraCreateReceiptSchema.parse({
      cameraMoveId: "camera_receipt02",
      cameraMoves: 1,
      keyframeCount: 2,
      nextCommands: nextCommands("camera_receipt02"),
      operation: "push",
      planHash: HASH,
      projectId: "project_receipt01",
      selection: {
        kind: "explicit",
        requireAllSelected: false,
        trackIds: ["face_subjecta1"],
      },
    })).toThrow(/Only face-follow/u);
  });

  test("rejects plausible next commands that do not match receipt identities", () => {
    const manual = {
      cameraMoveId: "camera_receipt02",
      cameraMoves: 1,
      keyframeCount: 2,
      nextCommands: nextCommands("camera_receipt02"),
      operation: "push",
      planHash: HASH,
      projectId: "project_receipt01",
      selection: null,
    } as const;
    expect(() => ProjectCameraCreateReceiptSchema.parse({
      ...manual,
      nextCommands: {
        ...manual.nextCommands,
        remove: "transmute project edit project_receipt01 camera remove camera_other0001 --json",
      },
    })).toThrow(/exactly match/u);
    expect(() => ProjectCameraCreateReceiptSchema.parse({
      ...manual,
      nextCommands: {
        ...manual.nextCommands,
        show: "transmute project edit project_other0001 camera show --json",
      },
    })).toThrow(/exactly match/u);
    expect(() => ProjectCameraRemoveReceiptSchema.parse({
      cameraMoveId: "camera_receipt02",
      cameraMoves: 0,
      keyframeCount: 2,
      nextCommands: {
        show: "transmute project edit project_other0001 camera show --json",
      },
      operation: "remove",
      planHash: HASH,
      projectId: "project_receipt01",
    })).toThrow(/exactly match/u);
  });
});
