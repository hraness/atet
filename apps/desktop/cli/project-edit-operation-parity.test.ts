import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bindProjectCommitEditsInputV3,
  createApplicationOperationRegistry,
  openProjectSnapshot,
  ProjectEditBatchSchema,
  ProjectEditBatchV3Schema,
  ProjectEditCommitReceiptSchema,
  type OperationExecutionContext,
} from "../application";
import {
  createOperationProjectFixture,
  createOperationRecordingProjectFixture,
  OPERATION_TEST_LATER,
  operationApplicationContext,
} from "../application/operations/test-support";
import {
  hashProjectEditPlan,
  loadProjectEditPlan,
} from "../core";
import {
  VideoProjectV1Schema,
  type VideoProjectV1,
} from "../contracts";
import type { CliIo, ProcessRunner } from "./io";
import { createCliTestRunner } from "./run-cli-test-helper";

const runCli = createCliTestRunner(import.meta.url);

const SCENARIOS = [
  {
    cli: ["cut", "2s", "4s"],
    edit: {
      kind: "cut",
      range: { endUs: 4_000_000, startUs: 2_000_000 },
    },
    expected: {
      keep: [
        { endUs: 2_000_000, startUs: 0 },
        { endUs: 10_000_000, startUs: 4_000_000 },
      ],
      speed: [],
    },
    operation: "cut",
  },
  {
    cli: ["trim", "2s", "8s"],
    edit: {
      kind: "trim",
      range: { endUs: 8_000_000, startUs: 2_000_000 },
    },
    expected: {
      keep: [{ endUs: 8_000_000, startUs: 2_000_000 }],
      speed: [],
    },
    operation: "trim",
  },
  {
    cli: ["speed", "2s", "8s", "2"],
    edit: {
      kind: "speed",
      range: { endUs: 8_000_000, startUs: 2_000_000 },
      rate: 2,
    },
    expected: {
      keep: [{ endUs: 10_000_000, startUs: 0 }],
      speed: [{
        range: { endUs: 8_000_000, startUs: 2_000_000 },
        rate: 2,
      }],
    },
    operation: "speed",
  },
] as const;

function rejectingRunner(): ProcessRunner {
  return {
    run() {
      return Promise.reject(
        new Error("Project edit operation parity must not invoke a subprocess."),
      );
    },
  };
}

function captureIo(root: string): {
  readonly io: CliIo;
  readonly stderr: () => string;
  readonly stdout: () => string;
} {
  let stderr = "";
  let stdout = "";
  return {
    io: {
      cwd: () => root,
      env: {},
      now: () => OPERATION_TEST_LATER,
      platform: process.platform,
      stderr: value => {
        stderr += value;
      },
      stdout: value => {
        stdout += value;
      },
    },
    stderr: () => stderr,
    stdout: () => stdout,
  };
}

function recordingLayerProject(project: VideoProjectV1): VideoProjectV1 {
  return VideoProjectV1Schema.parse({
    ...project,
    assets: project.assets.map(asset => ({
      ...asset,
      streams: asset.streams.map(stream => (
        stream.kind === "video"
          ? { ...stream, streamId: "stream_display01" }
          : stream
      )),
    })),
    placements: project.placements.map(placement => ({
      ...placement,
      video: placement.video.map(configured => ({
        ...configured,
        streamId: "stream_display01",
      })),
    })),
  });
}

for (const scenario of SCENARIOS) {
  test(`project edit ${scenario.operation} matches direct application operations`, async () => {
    const [cliRoot, directRoot] = await Promise.all([
      mkdtemp(join(tmpdir(), `atet-cli-${scenario.operation}-`)),
      mkdtemp(join(tmpdir(), `atet-direct-${scenario.operation}-`)),
    ]);
    try {
      const [cliFixture, directFixture] = await Promise.all([
        createOperationProjectFixture(cliRoot),
        createOperationProjectFixture(directRoot),
      ]);
      const cliApplication = operationApplicationContext(cliRoot, {
        now: OPERATION_TEST_LATER,
      });
      const output = captureIo(cliRoot);
      const cliExitCode = await runCli(
        [
          "project",
          "edit",
          cliFixture.project.projectId,
          ...scenario.cli,
          "--json",
        ],
        {
          io: output.io,
          paths: cliApplication.paths,
          runner: rejectingRunner(),
        },
      );
      expect(cliExitCode).toBe(0);
      expect(output.stderr()).toBe("");

      const directApplication = operationApplicationContext(directRoot, {
        now: OPERATION_TEST_LATER,
      });
      const executionContext: OperationExecutionContext = {
        abortSignal: new AbortController().signal,
        application: directApplication,
      };
      const registry = createApplicationOperationRegistry();
      const derived = await registry.execute(executionContext, {
        input: { ordered: [scenario.edit] },
        kind: "derive.edit-batch",
        version: 1,
      });
      const batch = ProjectEditBatchSchema.parse(derived.output);
      const snapshot = await openProjectSnapshot(
        directApplication.paths.projectRoot,
        directFixture.project.projectId,
      );
      const committed = await registry.execute(executionContext, {
        input: {
          basis: snapshot.editBasis,
          batch,
          project: directFixture.project.projectId,
          updatedAt: OPERATION_TEST_LATER.toISOString(),
        },
        kind: "project.commit-edits",
        version: 1,
      });
      const directReceipt = ProjectEditCommitReceiptSchema.parse(
        committed.output,
      );
      const [cliPlan, directPlan] = await Promise.all([
        loadProjectEditPlan(cliFixture.fileSystem),
        loadProjectEditPlan(directFixture.fileSystem),
      ]);

      expect(cliPlan).toEqual(directPlan);
      expect({
        keep: cliPlan.keep,
        speed: cliPlan.speed,
      }).toEqual(scenario.expected);
      expect(hashProjectEditPlan(cliPlan)).toBe(directReceipt.planHash);

      const cliReceipt: unknown = JSON.parse(output.stdout());
      expect(cliReceipt).toEqual({
        operation: directReceipt.operation,
        planHash: directReceipt.planHash,
        planId: directReceipt.planId,
        projectId: directReceipt.projectId,
      });
    } finally {
      await Promise.all([
        rm(cliRoot, { force: true, recursive: true }),
        rm(directRoot, { force: true, recursive: true }),
      ]);
    }
  });
}

test("project zoom add and remove match host-bound v3 application operations", async () => {
  const [cliRoot, directRoot] = await Promise.all([
    mkdtemp(join(tmpdir(), "atet-cli-zoom-")),
    mkdtemp(join(tmpdir(), "atet-direct-zoom-")),
  ]);
  try {
    const [cliFixture, directFixture] = await Promise.all([
      createOperationRecordingProjectFixture(cliRoot, {
        project: recordingLayerProject,
      }),
      createOperationRecordingProjectFixture(directRoot, {
        project: recordingLayerProject,
      }),
    ]);
    const cliApplication = operationApplicationContext(cliRoot, {
      now: OPERATION_TEST_LATER,
    });
    const directApplication = operationApplicationContext(directRoot, {
      now: OPERATION_TEST_LATER,
    });
    const executionContext: OperationExecutionContext = {
      abortSignal: new AbortController().signal,
      application: directApplication,
    };
    const registry = createApplicationOperationRegistry();

    const addOutput = captureIo(cliRoot);
    const addExitCode = await runCli(
      [
        "project",
        "edit",
        cliFixture.project.projectId,
        "zoom",
        "add",
        "--from",
        "1s",
        "--to",
        "3s",
        "--target",
        "point",
        "--point",
        "100,200",
        "--json",
      ],
      {
        io: addOutput.io,
        paths: cliApplication.paths,
        runner: rejectingRunner(),
      },
    );
    expect(addExitCode).toBe(0);
    expect(addOutput.stderr()).toBe("");

    const derivedAdd = await registry.execute(executionContext, {
      input: {
        ordered: [{
          kind: "add-manual-zooms",
          zooms: [{
            easing: { kind: "ease-in-out" },
            enterDurationUs: 300_000,
            exitDurationUs: 300_000,
            range: { endUs: 3_000_000, startUs: 1_000_000 },
            scale: 2,
            target: { kind: "point", point: { x: 100, y: 200 } },
            zoomId: "zoom_manual0001",
          }],
        }],
      },
      kind: "derive.edit-batch",
      version: 3,
    });
    const directAddSnapshot = await openProjectSnapshot(
      directApplication.paths.projectRoot,
      directFixture.project.projectId,
    );
    const directAddInput = await bindProjectCommitEditsInputV3(
      directApplication,
      {
        basis: directAddSnapshot.editBasis,
        batch: ProjectEditBatchV3Schema.parse(derivedAdd.output),
        project: directFixture.project.projectId,
        updatedAt: OPERATION_TEST_LATER.toISOString(),
      },
    );
    const committedAdd = await registry.execute(executionContext, {
      input: directAddInput,
      kind: "project.commit-edits",
      version: 3,
    });
    const directAddReceipt = ProjectEditCommitReceiptSchema.parse(
      committedAdd.output,
    );
    const [cliAddedPlan, directAddedPlan] = await Promise.all([
      loadProjectEditPlan(cliFixture.fileSystem),
      loadProjectEditPlan(directFixture.fileSystem),
    ]);
    expect(cliAddedPlan).toEqual(directAddedPlan);
    expect(cliAddedPlan.zooms.map(zoom => ({
      ...zoom,
      operation: {
        ...zoom.operation,
        zoomId: String(zoom.operation.zoomId),
      },
      placementId: String(zoom.placementId),
    }))).toEqual([{
      operation: {
        displayId: "display-primary",
        easing: { kind: "ease-in-out" },
        enterDurationUs: 300_000,
        exitDurationUs: 300_000,
        kind: "manual",
        range: { endUs: 3_000_000, startUs: 1_000_000 },
        scale: 2,
        target: { kind: "point", point: { x: 100, y: 200 } },
        zoomId: "zoom_manual0001",
      },
      placementId: "placement_operation01",
    }]);
    expect(hashProjectEditPlan(cliAddedPlan)).toBe(
      directAddReceipt.planHash,
    );
    expect(JSON.parse(addOutput.stdout())).toEqual({
      effects: cliAddedPlan.effects,
      operation: "zoom-add",
      planHash: directAddReceipt.planHash,
      projectId: directFixture.project.projectId,
      zooms: 1,
    });

    const removeOutput = captureIo(cliRoot);
    const removeExitCode = await runCli(
      [
        "project",
        "edit",
        cliFixture.project.projectId,
        "zoom",
        "remove",
        "zoom_manual0001",
        "--json",
      ],
      {
        io: removeOutput.io,
        paths: cliApplication.paths,
        runner: rejectingRunner(),
      },
    );
    expect(removeExitCode).toBe(0);
    expect(removeOutput.stderr()).toBe("");

    const derivedRemove = await registry.execute(executionContext, {
      input: {
        ordered: [{
          kind: "remove-zooms",
          zoomIds: ["zoom_manual0001"],
        }],
      },
      kind: "derive.edit-batch",
      version: 3,
    });
    const directRemoveSnapshot = await openProjectSnapshot(
      directApplication.paths.projectRoot,
      directFixture.project.projectId,
    );
    const directRemoveInput = await bindProjectCommitEditsInputV3(
      directApplication,
      {
        basis: directRemoveSnapshot.editBasis,
        batch: ProjectEditBatchV3Schema.parse(derivedRemove.output),
        project: directFixture.project.projectId,
        updatedAt: OPERATION_TEST_LATER.toISOString(),
      },
    );
    const committedRemove = await registry.execute(executionContext, {
      input: directRemoveInput,
      kind: "project.commit-edits",
      version: 3,
    });
    const directRemoveReceipt = ProjectEditCommitReceiptSchema.parse(
      committedRemove.output,
    );
    const [cliRemovedPlan, directRemovedPlan] = await Promise.all([
      loadProjectEditPlan(cliFixture.fileSystem),
      loadProjectEditPlan(directFixture.fileSystem),
    ]);
    expect(cliRemovedPlan).toEqual(directRemovedPlan);
    expect(cliRemovedPlan.zooms).toEqual([]);
    expect(hashProjectEditPlan(cliRemovedPlan)).toBe(
      directRemoveReceipt.planHash,
    );
    expect(JSON.parse(removeOutput.stdout())).toEqual({
      effects: cliRemovedPlan.effects,
      operation: "zoom-remove",
      planHash: directRemoveReceipt.planHash,
      projectId: directFixture.project.projectId,
      zooms: 0,
    });
  } finally {
    await Promise.all([
      rm(cliRoot, { force: true, recursive: true }),
      rm(directRoot, { force: true, recursive: true }),
    ]);
  }
});
