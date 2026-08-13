import { describe, expect, test } from "bun:test";

import {
  EditPlanIdSchema,
  ProjectAnalysisReferenceSchema,
  VideoProjectV1Schema,
} from "../contracts";
import {
  createDefaultProjectEditPlan,
  hashProjectStructure,
} from "../core";
import {
  OPERATION_TEST_HASH,
  OPERATION_TEST_LATER,
  OPERATION_TEST_NOW,
  operationTestProject,
} from "./operations/test-support";
import {
  projectEditBasis,
  projectMatchesEditBasis,
} from "./project-store";

describe("project edit bases", () => {
  test("permit append-only analysis publication but reject rewritten prior evidence", () => {
    const project = operationTestProject();
    const plan = createDefaultProjectEditPlan(
      project,
      EditPlanIdSchema.parse("plan_basischeck01"),
      OPERATION_TEST_NOW.toISOString(),
    );
    const initialBasis = projectEditBasis(project, plan);
    const reference = ProjectAnalysisReferenceSchema.parse({
      analysisId: "analysis_basischeck01",
      audioStreams: 1,
      createdAt: OPERATION_TEST_LATER.toISOString(),
      displayStreams: 1,
      kind: "inactivity",
      path: "analysis/inactivity/analysis_basischeck01.json",
      projectStructureSha256: hashProjectStructure(project),
      recommendedRanges: 1,
      sha256: OPERATION_TEST_HASH,
    });
    const appended = VideoProjectV1Schema.parse({
      ...project,
      analyses: [reference],
      updatedAt: OPERATION_TEST_LATER.toISOString(),
    });
    expect(projectMatchesEditBasis(initialBasis, {
      editBasis: projectEditBasis(appended, plan),
      project: appended,
    })).toBeTrue();

    const appendedBasis = projectEditBasis(appended, plan);
    const rewritten = VideoProjectV1Schema.parse({
      ...appended,
      analyses: [{
        ...reference,
        sha256: "b".repeat(64),
      }],
    });
    expect(projectMatchesEditBasis(appendedBasis, {
      editBasis: projectEditBasis(rewritten, plan),
      project: rewritten,
    })).toBeFalse();
  });
});
