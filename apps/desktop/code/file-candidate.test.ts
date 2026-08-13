import { describe, expect, test } from "bun:test";

import {
  WORKFLOW_FILE_CANDIDATE_VERSION,
  WorkflowFileCandidateSchema,
  fileCandidate,
} from "./file-candidate";

describe("workflow file candidates", () => {
  test("declares a progressive path without opening it", () => {
    expect(fileCandidate("fixtures/presenter.mov")).toEqual({
      kind: "file",
      path: "fixtures/presenter.mov",
      version: WORKFLOW_FILE_CANDIDATE_VERSION,
    });
  });

  test("requires complete exact integrity when either exact field is present", () => {
    expect(WorkflowFileCandidateSchema.safeParse({
      bytes: 10,
      kind: "file",
      path: "fixtures/presenter.mov",
      version: WORKFLOW_FILE_CANDIDATE_VERSION,
    }).success).toBe(false);
    expect(fileCandidate({
      bytes: 10,
      path: "fixtures/presenter.mov",
      sha256: "a".repeat(64),
    })).toMatchObject({
      bytes: 10,
      sha256: "a".repeat(64),
    });
  });
});
