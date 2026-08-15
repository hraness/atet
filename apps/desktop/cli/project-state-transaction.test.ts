import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ProjectEditPlanV1Schema,
  VideoProjectV1Schema,
  type ProjectEditPlanV1,
  type VideoProjectV1,
} from "../contracts";
import {
  canonicalJson,
  canonicalJsonSha256,
  createDefaultProjectEditPlan,
  createNodeBundleFileSystem,
  hashProjectStructure,
  loadProjectEditPlan,
  loadVideoProject,
  saveProjectEditPlan,
  saveVideoProject,
  type BundleFileSystem,
} from "../core";
import { CliError } from "./errors";
import type { CliIo } from "./io";
import type { RepositoryPaths } from "./paths";
import {
  PROJECT_STATE_TRANSACTION_PATH,
  ProjectStateTransactionV1Schema,
  assertProjectStateTransactionSettled,
  commitProjectStateTransaction,
  projectStateTransactionMayHaveCommitted,
  recoverProjectStateTransaction,
} from "./project-state-transaction";
import { createCliTestRunner } from "./run-cli-test-helper";

const runCli = createCliTestRunner(import.meta.url);

const NOW = "2026-07-22T12:00:00.000Z";

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error: unknown) {
    return error;
  }
}

function fixtureProject(durationUs = 10_000_000): VideoProjectV1 {
  return VideoProjectV1Schema.parse({
    analyses: [],
    assets: [{
      assetId: "asset_fixture01",
      createdAt: NOW,
      durationUs,
      label: "Fixture",
      role: "screen",
      source: { generator: "test", generatorVersion: "1", kind: "generated", sourceSha256: "a".repeat(64) },
      streams: [{
        frameRate: 60,
        kind: "video",
        label: "Screen",
        pixelHeight: 1_080,
        pixelWidth: 1_920,
        role: "screen",
        segments: [{
          assetRange: { endUs: durationUs, startUs: 0 },
          bytes: 100,
          codec: "h264",
          container: "mp4",
          fileRange: { endUs: durationUs, startUs: 0 },
          path: "imports/a.media",
          sha256: "a".repeat(64),
          streamIndex: 0,
        }],
        streamId: "stream_fixture01",
      }],
    }],
    createdAt: NOW,
    currentEditPlanPath: "edits/current.json",
    kind: "studio.video-project",
    name: "Fixture",
    placements: [{
      assetId: "asset_fixture01",
      assetRange: { endUs: durationUs, startUs: 0 },
      audio: [],
      enabled: true,
      placementId: "placement_fixture01",
      sync: {
        anchors: [
          { assetTimeUs: 0, projectTimeUs: 0 },
          { assetTimeUs: durationUs, projectTimeUs: durationUs },
        ],
        provenance: { kind: "identity" },
      },
      video: [{
        presentation: {
          blendMode: "normal",
          crop: { kind: "none" },
          enabled: true,
          fit: "fill",
          layer: 0,
          layout: { height: 1, kind: "normalized", width: 1, x: 0, y: 0 },
          opacity: 1,
        },
        streamId: "stream_fixture01",
      }],
    }],
    projectId: "project_fixture01",
    referencePlacementId: "placement_fixture01",
    schemaVersion: 1,
    timeline: { durationUs, timebase: "microseconds" },
    updatedAt: NOW,
  });
}

function fixturePlan(project: VideoProjectV1): ProjectEditPlanV1 {
  return createDefaultProjectEditPlan(project, "plan_fixture01" as ProjectEditPlanV1["planId"], NOW);
}

function generationReference(
  transactionId: string,
  generation: "before" | "after",
  project: VideoProjectV1,
  plan: ProjectEditPlanV1,
) {
  const root = `state/transactions/${transactionId}`;
  return {
    plan: { path: `${root}/${generation}-plan.json`, sha256: canonicalJsonSha256(plan) },
    project: { path: `${root}/${generation}-project.json`, sha256: canonicalJsonSha256(project) },
  };
}

test("commits a structural project and edit-plan generation together", async () => {
  const root = await mkdtemp(join(tmpdir(), "atet-project-transaction-"));
  try {
    const fileSystem = createNodeBundleFileSystem(root);
    const beforeProject = fixtureProject();
    const beforePlan = fixturePlan(beforeProject);
    const afterProject = VideoProjectV1Schema.parse({
      ...beforeProject,
      name: "Updated fixture",
      timeline: { durationUs: 12_000_000, timebase: "microseconds" },
      updatedAt: "2026-07-22T12:01:00.000Z",
    });
    const afterPlan = ProjectEditPlanV1Schema.parse({
      ...beforePlan,
      keep: [{ endUs: 12_000_000, startUs: 0 }],
      projectStructureSha256: hashProjectStructure(afterProject),
      timelineDurationUs: 12_000_000,
      updatedAt: afterProject.updatedAt,
    });
    await saveVideoProject(fileSystem, beforeProject);
    await saveProjectEditPlan(fileSystem, beforePlan);

    await commitProjectStateTransaction({
      after: { plan: afterPlan, project: afterProject },
      before: { plan: beforePlan, project: beforeProject },
      fileSystem,
      transactionId: "transaction_11111111111111111111111111111111",
    });

    expect(await loadVideoProject(fileSystem)).toEqual(afterProject);
    expect(await loadProjectEditPlan(fileSystem)).toEqual(afterPlan);
    expect(ProjectStateTransactionV1Schema.parse(JSON.parse(
      await fileSystem.readText(PROJECT_STATE_TRANSACTION_PATH),
    ) as unknown)).toMatchObject({
      active: "after",
      kind: "atet.project-state-transaction",
      phase: "settled",
    });
    expect(ProjectStateTransactionV1Schema.parse({
      ...JSON.parse(await fileSystem.readText(PROJECT_STATE_TRANSACTION_PATH)) as object,
      kind: "studio.project-state-transaction",
    }).kind).toBe("studio.project-state-transaction");
    await assertProjectStateTransactionSettled(fileSystem);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("restores the prior generation when publication fails before commit-ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "atet-project-transaction-failure-"));
  try {
    const physical = createNodeBundleFileSystem(root);
    const beforeProject = fixtureProject();
    const beforePlan = fixturePlan(beforeProject);
    const afterProject = VideoProjectV1Schema.parse({
      ...beforeProject,
      name: "Unpublished generation",
      updatedAt: "2026-07-22T12:01:30.000Z",
    });
    const afterPlan = ProjectEditPlanV1Schema.parse({
      ...beforePlan,
      updatedAt: afterProject.updatedAt,
    });
    await saveVideoProject(physical, beforeProject);
    await saveProjectEditPlan(physical, beforePlan);

    let failProjectPublication = true;
    const faulting: BundleFileSystem = {
      readText: path => physical.readText(path),
      writeTextNoReplace: async (path, contents) => {
        if (physical.writeTextNoReplace === undefined) {
          throw new Error("Physical fixture does not support immutable publication.");
        }
        return await physical.writeTextNoReplace(path, contents);
      },
      writeTextAtomic: async (path, contents) => {
        if (path === "project.json" && failProjectPublication) {
          failProjectPublication = false;
          throw new Error("injected project publication failure");
        }
        await physical.writeTextAtomic(path, contents);
      },
    };

    const failure = await rejection(commitProjectStateTransaction({
      after: { plan: afterPlan, project: afterProject },
      before: { plan: beforePlan, project: beforeProject },
      fileSystem: faulting,
      transactionId: "transaction_12121212121212121212121212121212",
    }));
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("injected project publication failure");

    expect(await loadVideoProject(physical)).toEqual(beforeProject);
    expect(await loadProjectEditPlan(physical)).toEqual(beforePlan);
    expect(ProjectStateTransactionV1Schema.parse(JSON.parse(
      await physical.readText(PROJECT_STATE_TRANSACTION_PATH),
    ) as unknown)).toMatchObject({ active: "before", phase: "settled" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("marks a failed commit-ready settlement as ambiguous and preserves roll-forward evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "atet-project-transaction-ambiguous-"));
  try {
    const physical = createNodeBundleFileSystem(root);
    const beforeProject = fixtureProject();
    const beforePlan = fixturePlan(beforeProject);
    const afterProject = VideoProjectV1Schema.parse({
      ...beforeProject,
      name: "Durable next generation",
      updatedAt: "2026-07-22T12:01:45.000Z",
    });
    const afterPlan = ProjectEditPlanV1Schema.parse({
      ...beforePlan,
      updatedAt: afterProject.updatedAt,
    });
    await saveVideoProject(physical, beforeProject);
    await saveProjectEditPlan(physical, beforePlan);

    const faulting: BundleFileSystem = {
      readText: path => physical.readText(path),
      writeTextNoReplace: async (path, contents) => {
        if (physical.writeTextNoReplace === undefined) {
          throw new Error("Physical fixture does not support immutable publication.");
        }
        return await physical.writeTextNoReplace(path, contents);
      },
      writeTextAtomic: async (path, contents) => {
        if (path === PROJECT_STATE_TRANSACTION_PATH && contents.includes('"phase":"settled"')) {
          throw new Error("injected settlement failure");
        }
        await physical.writeTextAtomic(path, contents);
      },
    };
    const failure = await rejection(commitProjectStateTransaction({
      after: { plan: afterPlan, project: afterProject },
      before: { plan: beforePlan, project: beforeProject },
      fileSystem: faulting,
      transactionId: "transaction_13131313131313131313131313131313",
    }));

    expect(failure).toBeInstanceOf(CliError);
    expect(projectStateTransactionMayHaveCommitted(failure)).toBe(true);
    expect(ProjectStateTransactionV1Schema.parse(JSON.parse(
      await physical.readText(PROJECT_STATE_TRANSACTION_PATH),
    ) as unknown)).toMatchObject({ phase: "commit-ready" });
    expect(await recoverProjectStateTransaction(physical)).toBe("rolled-forward");
    expect(await loadVideoProject(physical)).toEqual(afterProject);
    expect(await loadProjectEditPlan(physical)).toEqual(afterPlan);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rolls an interrupted prepare generation back before readers can proceed", async () => {
  const root = await mkdtemp(join(tmpdir(), "atet-project-transaction-recover-"));
  try {
    const fileSystem = createNodeBundleFileSystem(root);
    const transactionId = "transaction_22222222222222222222222222222222";
    const beforeProject = fixtureProject();
    const beforePlan = fixturePlan(beforeProject);
    const afterProject = VideoProjectV1Schema.parse({
      ...beforeProject,
      name: "Interrupted next generation",
      updatedAt: "2026-07-22T12:02:00.000Z",
    });
    const afterPlan = ProjectEditPlanV1Schema.parse({ ...beforePlan, updatedAt: afterProject.updatedAt });
    const before = generationReference(transactionId, "before", beforeProject, beforePlan);
    const after = generationReference(transactionId, "after", afterProject, afterPlan);
    await saveVideoProject(fileSystem, beforeProject, before.project.path);
    await saveProjectEditPlan(fileSystem, beforePlan, before.plan.path);
    await saveVideoProject(fileSystem, afterProject, after.project.path);
    await saveProjectEditPlan(fileSystem, afterPlan, after.plan.path);
    await saveVideoProject(fileSystem, beforeProject);
    await saveProjectEditPlan(fileSystem, afterPlan);
    await fileSystem.writeTextAtomic(PROJECT_STATE_TRANSACTION_PATH, `${canonicalJson(ProjectStateTransactionV1Schema.parse({
      after,
      before,
      kind: "atet.project-state-transaction",
      phase: "prepare",
      projectId: beforeProject.projectId,
      schemaVersion: 1,
      transactionId,
    }))}\n`);

    const blocked = await rejection(assertProjectStateTransactionSettled(fileSystem));
    expect(blocked).toBeInstanceOf(CliError);
    expect(blocked).toMatchObject({ code: "conflict" });
    expect(await recoverProjectStateTransaction(fileSystem)).toBe("rolled-back");
    expect(await loadVideoProject(fileSystem)).toEqual(beforeProject);
    expect(await loadProjectEditPlan(fileSystem)).toEqual(beforePlan);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rolls a commit-ready generation forward and rejects tampered recovery evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "atet-project-transaction-forward-"));
  try {
    const fileSystem = createNodeBundleFileSystem(root);
    const transactionId = "transaction_33333333333333333333333333333333";
    const beforeProject = fixtureProject();
    const beforePlan = fixturePlan(beforeProject);
    const afterProject = VideoProjectV1Schema.parse({
      ...beforeProject,
      name: "Committed next generation",
      updatedAt: "2026-07-22T12:03:00.000Z",
    });
    const afterPlan = ProjectEditPlanV1Schema.parse({ ...beforePlan, updatedAt: afterProject.updatedAt });
    const before = generationReference(transactionId, "before", beforeProject, beforePlan);
    const after = generationReference(transactionId, "after", afterProject, afterPlan);
    await saveVideoProject(fileSystem, beforeProject, before.project.path);
    await saveProjectEditPlan(fileSystem, beforePlan, before.plan.path);
    await saveVideoProject(fileSystem, afterProject, after.project.path);
    await saveProjectEditPlan(fileSystem, afterPlan, after.plan.path);
    await saveVideoProject(fileSystem, beforeProject);
    await saveProjectEditPlan(fileSystem, beforePlan);
    await fileSystem.writeTextAtomic(PROJECT_STATE_TRANSACTION_PATH, `${canonicalJson(ProjectStateTransactionV1Schema.parse({
      after,
      before,
      kind: "atet.project-state-transaction",
      phase: "commit-ready",
      projectId: beforeProject.projectId,
      schemaVersion: 1,
      transactionId,
    }))}\n`);

    expect(await recoverProjectStateTransaction(fileSystem)).toBe("rolled-forward");
    expect(await loadVideoProject(fileSystem)).toEqual(afterProject);
    expect(await loadProjectEditPlan(fileSystem)).toEqual(afterPlan);

    const corrupted = `${canonicalJson({ ...afterProject, name: "tampered" })}\n`;
    await fileSystem.writeTextAtomic(after.project.path, corrupted);
    await fileSystem.writeTextAtomic(PROJECT_STATE_TRANSACTION_PATH, `${canonicalJson(ProjectStateTransactionV1Schema.parse({
      after,
      before,
      kind: "atet.project-state-transaction",
      phase: "commit-ready",
      projectId: beforeProject.projectId,
      schemaVersion: 1,
      transactionId,
    }))}\n`);
    const failure = await rejection(recoverProjectStateTransaction(fileSystem));
    expect(failure).toBeInstanceOf(CliError);
    expect(failure).toMatchObject({ code: "invalid-data" });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a locked project mutation recovers an interrupted generation before dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "atet-project-transaction-cli-"));
  try {
    const paths: RepositoryPaths = {
      artifactRoot: join(root, "artifacts", "atet", "recordings"),
      desktopRoot: join(root, "projects", "atet", "apps", "desktop"),
      privateRoot: join(root, "artifacts", "atet", "private"),
      projectRoot: join(root, "artifacts", "atet", "projects"),
      repositoryRoot: root,
    };
    const directory = join(paths.projectRoot, "project_fixture01");
    const fileSystem = createNodeBundleFileSystem(directory);
    const transactionId = "transaction_44444444444444444444444444444444";
    const beforeProject = fixtureProject();
    const beforePlan = fixturePlan(beforeProject);
    const afterProject = VideoProjectV1Schema.parse({
      ...beforeProject,
      name: "Interrupted mutation",
      updatedAt: "2026-07-22T12:04:00.000Z",
    });
    const afterPlan = ProjectEditPlanV1Schema.parse({ ...beforePlan, updatedAt: afterProject.updatedAt });
    const before = generationReference(transactionId, "before", beforeProject, beforePlan);
    const after = generationReference(transactionId, "after", afterProject, afterPlan);
    await saveVideoProject(fileSystem, beforeProject, before.project.path);
    await saveProjectEditPlan(fileSystem, beforePlan, before.plan.path);
    await saveVideoProject(fileSystem, afterProject, after.project.path);
    await saveProjectEditPlan(fileSystem, afterPlan, after.plan.path);
    // Simulate process death after the plan replacement but before project.json.
    await saveVideoProject(fileSystem, beforeProject);
    await saveProjectEditPlan(fileSystem, afterPlan);
    await fileSystem.writeTextAtomic(PROJECT_STATE_TRANSACTION_PATH, `${canonicalJson(ProjectStateTransactionV1Schema.parse({
      after,
      before,
      kind: "atet.project-state-transaction",
      phase: "prepare",
      projectId: beforeProject.projectId,
      schemaVersion: 1,
      transactionId,
    }))}\n`);

    const execute = async (argv: readonly string[]) => {
      let stderr = "";
      let stdout = "";
      const io: CliIo = {
        cwd: () => root,
        env: {},
        now: () => new Date(NOW),
        platform: process.platform,
        stderr: value => { stderr += value; },
        stdout: value => { stdout += value; },
      };
      const exitCode = await runCli(argv, { io, paths });
      return { exitCode, stderr, stdout };
    };

    const readOnly = await execute(["project", "inspect", "project_fixture01", "--json"]);
    expect(readOnly.exitCode).toBeGreaterThan(0);
    expect(readOnly.stderr).toContain("interrupted state transaction");

    const mutation = await execute([
      "project", "edit", "project_fixture01", "cut", "1s", "2s", "--json",
    ]);
    expect(mutation).toMatchObject({ exitCode: 0, stderr: "" });
    expect(await loadVideoProject(fileSystem)).toEqual(beforeProject);
    expect((await loadProjectEditPlan(fileSystem)).keep).toEqual([
      { endUs: 1_000_000, startUs: 0 },
      { endUs: 10_000_000, startUs: 2_000_000 },
    ]);
    const committedTransaction = ProjectStateTransactionV1Schema.parse(JSON.parse(
      await fileSystem.readText(PROJECT_STATE_TRANSACTION_PATH),
    ) as unknown);
    expect(committedTransaction).toMatchObject({
      active: "after",
      phase: "settled",
      projectId: beforeProject.projectId,
    });
    expect(committedTransaction.transactionId).not.toBe(transactionId);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
