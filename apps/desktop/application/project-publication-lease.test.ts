import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ProjectAnalysisReferenceSchema,
  ProjectEditPlanV1Schema,
  VideoProjectV1Schema,
} from "../contracts";
import {
  loadVideoProject,
  saveProjectEditPlan,
  saveVideoProject,
} from "../core";
import { ApplicationError } from "./errors";
import {
  mergeProjectAnalysisReference,
  openLeasedProjectSnapshot,
  projectAnalysisPublicationBasis,
  withProjectPublicationLease,
} from "./project-publication-lease";
import { openProjectSnapshot } from "./project-store";
import {
  OPERATION_TEST_HASH,
  OPERATION_TEST_LATER,
  createOperationProjectFixture,
  operationApplicationContext,
} from "./operations/test-support";

function faceReference(analysisId: string) {
  return ProjectAnalysisReferenceSchema.parse({
    analysisId,
    analyzedFrames: 1,
    assetId: "asset_operation01",
    createdAt: OPERATION_TEST_LATER.toISOString(),
    kind: "faces",
    localOnly: true,
    path: `analysis/faces/${analysisId}.json`,
    sha256: OPERATION_TEST_HASH,
    streamId: "stream_operation01",
    subjectIntegritySha256: OPERATION_TEST_HASH,
    trackCount: 0,
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(next => {
    resolve = next;
  });
  return { promise, resolve };
}

test("a leased snapshot queues behind publication and binds the completed generation", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "transmute-analysis-read-lease-"));
  try {
    const fixture = await createOperationProjectFixture(repositoryRoot);
    const application = operationApplicationContext(repositoryRoot);
    const publicationEntered = deferred();
    const releasePublication = deferred();
    const nextProject = VideoProjectV1Schema.parse({
      ...fixture.project,
      updatedAt: OPERATION_TEST_LATER.toISOString(),
    });
    const nextPlan = ProjectEditPlanV1Schema.parse({
      ...fixture.plan,
      updatedAt: OPERATION_TEST_LATER.toISOString(),
    });

    const publication = withProjectPublicationLease(
      application,
      "project.commit-edits",
      { project: fixture.project.projectId },
      async () => {
        await saveVideoProject(fixture.fileSystem, nextProject);
        publicationEntered.resolve();
        await releasePublication.promise;
        await saveProjectEditPlan(fixture.fileSystem, nextPlan);
      },
    );
    await publicationEntered.promise;

    let readerSettled = false;
    const reader = openLeasedProjectSnapshot(
      application,
      fixture.project.projectId,
    ).then(
      snapshot => {
        readerSettled = true;
        return { kind: "completed" as const, snapshot };
      },
      (error: unknown) => {
        readerSettled = true;
        return { error, kind: "failed" as const };
      },
    );
    // Allow the exact-ID resolution and queue admission to finish without
    // releasing the active publication. A separate physical-lock attempt
    // would settle as a conflict during these turns.
    for (let turn = 0; turn < 32; turn += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const settledBeforePublication = readerSettled;

    releasePublication.resolve();
    await publication;
    const result = await reader;

    expect(settledBeforePublication).toBe(false);
    expect(result.kind).toBe("completed");
    if (result.kind !== "completed") throw result.error;
    expect(result.snapshot.project).toEqual(nextProject);
    expect(result.snapshot.plan).toEqual(nextPlan);
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
});

test("analysis publication rejects a structural project change", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "transmute-analysis-structure-"));
  try {
    const fixture = await createOperationProjectFixture(repositoryRoot);
    const snapshot = await openProjectSnapshot(
      fixture.projectRoot,
      fixture.project.projectId,
    );
    const changedProject = VideoProjectV1Schema.parse({
      ...fixture.project,
      placements: fixture.project.placements.map((placement, index) =>
        index === 0 ? { ...placement, enabled: false } : placement),
      updatedAt: OPERATION_TEST_LATER.toISOString(),
    });
    await saveVideoProject(fixture.fileSystem, changedProject);

    const publication = mergeProjectAnalysisReference({
      application: operationApplicationContext(repositoryRoot),
      basis: projectAnalysisPublicationBasis(snapshot),
      operation: "analysis.faces",
      project: fixture.project.projectId,
      reference: faceReference("analysis_structure01"),
    });
    expect(publication).rejects.toBeInstanceOf(ApplicationError);
    expect((await loadVideoProject(fixture.fileSystem)).analyses).toEqual([]);
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
});

test("analysis publication rejects a current edit-plan change", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "transmute-analysis-plan-"));
  try {
    const fixture = await createOperationProjectFixture(repositoryRoot);
    const snapshot = await openProjectSnapshot(
      fixture.projectRoot,
      fixture.project.projectId,
    );
    const changedPlan = ProjectEditPlanV1Schema.parse({
      ...fixture.plan,
      updatedAt: OPERATION_TEST_LATER.toISOString(),
    });
    await saveProjectEditPlan(fixture.fileSystem, changedPlan);

    const publication = mergeProjectAnalysisReference({
      application: operationApplicationContext(repositoryRoot),
      basis: projectAnalysisPublicationBasis(snapshot),
      operation: "analysis.faces",
      project: fixture.project.projectId,
      reference: faceReference("analysis_planchange01"),
    });
    expect(publication).rejects.toBeInstanceOf(ApplicationError);
    const latest = await openProjectSnapshot(
      fixture.projectRoot,
      fixture.project.projectId,
    );
    expect(latest.project.analyses).toEqual([]);
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
});

test("analysis publication preserves later sibling analyses under the original edit basis", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "transmute-analysis-sibling-"));
  try {
    const fixture = await createOperationProjectFixture(repositoryRoot);
    const snapshot = await openProjectSnapshot(
      fixture.projectRoot,
      fixture.project.projectId,
    );
    const sibling = faceReference("analysis_sibling01");
    let checks = 0;

    const publication = await mergeProjectAnalysisReference({
      application: operationApplicationContext(repositoryRoot),
      basis: projectAnalysisPublicationBasis(snapshot),
      beforePublication: async () => {
        checks += 1;
        if (checks !== 1) return;
        await saveVideoProject(fixture.fileSystem, VideoProjectV1Schema.parse({
          ...fixture.project,
          analyses: [sibling],
          updatedAt: OPERATION_TEST_LATER.toISOString(),
        }));
      },
      operation: "analysis.faces",
      project: fixture.project.projectId,
      reference: faceReference("analysis_adopted01"),
    });

    expect(checks).toBe(3);
    expect(publication.project.analyses).toEqual([
      sibling,
      faceReference("analysis_adopted01"),
    ]);
    expect((await loadVideoProject(fixture.fileSystem)).analyses)
      .toEqual(publication.project.analyses);
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
});

test("analysis publication preserves the original prior-reference commitment under the lease", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "transmute-analysis-prefix-"));
  try {
    const fixture = await createOperationProjectFixture(repositoryRoot);
    const prior = faceReference("analysis_priorreference01");
    await saveVideoProject(fixture.fileSystem, VideoProjectV1Schema.parse({
      ...fixture.project,
      analyses: [prior],
      updatedAt: OPERATION_TEST_LATER.toISOString(),
    }));
    const snapshot = await openProjectSnapshot(
      fixture.projectRoot,
      fixture.project.projectId,
    );

    const publication = mergeProjectAnalysisReference({
      application: operationApplicationContext(repositoryRoot),
      basis: projectAnalysisPublicationBasis(snapshot),
      beforePublication: async () => {
        await saveVideoProject(fixture.fileSystem, VideoProjectV1Schema.parse({
          ...snapshot.project,
          analyses: [{
            ...prior,
            sha256: "f".repeat(64),
          }],
        }));
      },
      operation: "analysis.faces",
      project: fixture.project.projectId,
      reference: faceReference("analysis_rejectedreference01"),
    });

    expect(publication).rejects.toMatchObject({ code: "conflict" });
    expect((await loadVideoProject(fixture.fileSystem)).analyses).toEqual([{
      ...prior,
      sha256: "f".repeat(64),
    }]);
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
});

test("analysis publication revalidates the workflow fence inside the publication lease", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "transmute-analysis-fence-"));
  try {
    const fixture = await createOperationProjectFixture(repositoryRoot);
    const snapshot = await openProjectSnapshot(
      fixture.projectRoot,
      fixture.project.projectId,
    );
    let checks = 0;

    const publication = mergeProjectAnalysisReference({
      application: operationApplicationContext(repositoryRoot),
      basis: projectAnalysisPublicationBasis(snapshot),
      beforePublication: () => {
        checks += 1;
        return Promise.reject(new ApplicationError(
          "cancelled",
          "The durable workflow fence is no longer current.",
        ));
      },
      operation: "analysis.faces",
      project: fixture.project.projectId,
      reference: faceReference("analysis_fenced01"),
    });

    expect(publication).rejects.toMatchObject({ code: "cancelled" });
    expect(checks).toBe(1);
    expect((await loadVideoProject(fixture.fileSystem)).analyses).toEqual([]);
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
});

test("analysis publication revalidates the workflow fence immediately before saving", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "transmute-analysis-final-fence-"));
  try {
    const fixture = await createOperationProjectFixture(repositoryRoot);
    const snapshot = await openProjectSnapshot(
      fixture.projectRoot,
      fixture.project.projectId,
    );
    let checks = 0;

    const publication = mergeProjectAnalysisReference({
      application: operationApplicationContext(repositoryRoot),
      basis: projectAnalysisPublicationBasis(snapshot),
      beforePublication: () => {
        checks += 1;
        return checks < 3
          ? Promise.resolve()
          : Promise.reject(new ApplicationError(
            "cancelled",
            "The durable workflow fence expired before the project save.",
          ));
      },
      operation: "analysis.faces",
      project: fixture.project.projectId,
      reference: faceReference("analysis_finalfence01"),
    });

    expect(publication).rejects.toMatchObject({ code: "cancelled" });
    expect(checks).toBe(3);
    expect((await loadVideoProject(fixture.fileSystem)).analyses).toEqual([]);
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
});
