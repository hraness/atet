import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AnalysisIdSchema,
  OverlayOperationSchema,
  ProjectAnalysisReferenceSchema,
  VideoProjectV1Schema,
} from "../../contracts";
import {
  canonicalJsonSha256,
  hashProjectEditPlan,
  hashProjectStructure,
  loadProjectEditPlan,
  saveProjectEditPlan,
} from "../../core";
import type { ApplicationContext } from "../context";
import { ApplicationError } from "../errors";
import { OperationRegistry } from "../registry";
import {
  hashProjectGeneration,
  openProjectSnapshot,
} from "../project-store";
import {
  createFacesOperationDefinition,
  createMusicOperationDefinition,
  createProjectInactivityOperationDefinition,
} from "./index";
import {
  ProjectEditBatchSchema,
  deriveEditBatchOperationDefinition,
} from "./derive/edit-batch";
import { commitProjectEditsOperationDefinition } from "./project/commit-edits";
import {
  ProjectSnapshotOutputSchema,
  projectSnapshotOperationDefinition,
} from "./project/snapshot";
import {
  OPERATION_TEST_HASH,
  OPERATION_TEST_LATER,
  createOperationProjectFixture,
  operationApplicationContext,
} from "./test-support";

function executionContext(
  repositoryRoot: string,
  expectedProjectGeneration?: string,
  capabilities: ApplicationContext["capabilities"] = () => Promise.resolve([]),
) {
  return {
    abortSignal: new AbortController().signal,
    application: operationApplicationContext(repositoryRoot, {
      capabilities,
      now: OPERATION_TEST_LATER,
    }),
    ...(expectedProjectGeneration === undefined
      ? {}
      : { expectedProjectGeneration }),
  };
}

function preparedImageOverlay(
  overlayId: string,
  startUs: number,
  zIndex: number,
) {
  return OverlayOperationSchema.parse({
    anchor: "center",
    entrance: { kind: "none" },
    exit: { kind: "none" },
    intrinsicSize: { height: 64, width: 64 },
    opacity: 1,
    overlayId,
    position: { x: 0, y: 0 },
    range: { endUs: startUs + 1_000_000, startUs },
    rotationDegrees: 0,
    scale: 1,
    size: { kind: "intrinsic" },
    source: {
      asset: {
        bytes: 4,
        mediaType: "image/png",
        path: `assets/${overlayId}.png`,
        provenance: {
          kind: "imported",
          originalName: `${overlayId}.png`,
          sourceSha256: OPERATION_TEST_HASH,
        },
        sha256: OPERATION_TEST_HASH,
      },
      kind: "image",
    },
    zIndex,
  });
}

describe("project application operations", () => {
  test("rejects a snapshot when the project changes after plan-time binding", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-operations-snapshot-drift-"));
    try {
      const fixture = await createOperationProjectFixture(repositoryRoot);
      const planned = hashProjectGeneration(fixture.project, fixture.plan);
      await saveProjectEditPlan(fixture.fileSystem, {
        ...fixture.plan,
        updatedAt: OPERATION_TEST_LATER.toISOString(),
      });
      const registry = new OperationRegistry();
      registry.register(projectSnapshotOperationDefinition);
      expect(registry.execute(
        executionContext(repositoryRoot, planned.generationSha256),
        {
          input: { project: fixture.project.projectId },
          kind: "project.snapshot",
          version: 1,
        },
      )).rejects.toMatchObject({ code: "conflict" });
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("snapshots full canonical documents and commits one ordered checked batch", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-operations-project-"));
    try {
      const fixture = await createOperationProjectFixture(repositoryRoot);
      const registry = new OperationRegistry();
      registry.register(projectSnapshotOperationDefinition);
      registry.register(deriveEditBatchOperationDefinition);
      registry.register(commitProjectEditsOperationDefinition);

      const initialGeneration = hashProjectGeneration(fixture.project, fixture.plan);
      const snapshotResult = await registry.execute(
        executionContext(repositoryRoot, initialGeneration.generationSha256),
        {
          input: { project: fixture.project.projectId },
          kind: "project.snapshot",
          version: 1,
        },
      );
      const snapshot = ProjectSnapshotOutputSchema.parse(snapshotResult.output);
      expect(snapshot.generation).toEqual(hashProjectGeneration(
        fixture.project,
        fixture.plan,
      ));
      expect(snapshot.generation.projectSha256).toBe(
        canonicalJsonSha256(fixture.project),
      );
      expect(snapshot.generation.currentPlanSha256).toBe(
        canonicalJsonSha256(fixture.plan),
      );

      const renamed = VideoProjectV1Schema.parse({
        ...fixture.project,
        name: "A name outside the structural hash",
      });
      expect(hashProjectStructure(renamed)).toBe(hashProjectStructure(fixture.project));
      expect(hashProjectGeneration(renamed, fixture.plan).projectSha256)
        .not.toBe(snapshot.generation.projectSha256);
      expect(hashProjectGeneration(fixture.project, {
        ...fixture.plan,
        updatedAt: OPERATION_TEST_LATER.toISOString(),
      }).currentPlanSha256).not.toBe(snapshot.generation.currentPlanSha256);

      const batchResult = await registry.execute(executionContext(repositoryRoot), {
        input: {
          ordered: [
            { kind: "cut", range: { endUs: 3_000_000, startUs: 2_000_000 } },
            { kind: "speed", range: { endUs: 6_000_000, startUs: 3_000_000 }, rate: 2 },
            { kind: "trim", range: { endUs: 8_000_000, startUs: 1_000_000 } },
          ],
        },
        kind: "derive.edit-batch",
        version: 1,
      });
      const batch = ProjectEditBatchSchema.parse(batchResult.output);
      const receipt = await registry.execute(
        executionContext(repositoryRoot, snapshot.generation.generationSha256),
        {
          input: {
            basis: snapshot.editBasis,
            batch,
            project: fixture.project.projectId,
          },
          kind: "project.commit-edits",
          version: 1,
        },
      );
      expect(receipt.output).toMatchObject({
        operation: "batch",
        planId: fixture.plan.planId,
        projectId: fixture.project.projectId,
      });
      const committed = await loadProjectEditPlan(fixture.fileSystem);
      expect(committed.keep).toEqual([
        { endUs: 2_000_000, startUs: 1_000_000 },
        { endUs: 8_000_000, startUs: 3_000_000 },
      ]);
      expect(committed.speed).toEqual([{
        range: { endUs: 6_000_000, startUs: 3_000_000 },
        rate: 2,
      }]);

      expect(registry.execute(
        executionContext(repositoryRoot, snapshot.generation.generationSha256),
        {
          input: {
            basis: snapshot.editBasis,
            batch,
            project: fixture.project.projectId,
          },
          kind: "project.commit-edits",
          version: 1,
        },
      )).rejects.toMatchObject({ code: "conflict" });
      expect(await loadProjectEditPlan(fixture.fileSystem)).toEqual(committed);

      const singletonBatchResult = await registry.execute(
        executionContext(repositoryRoot),
        {
          input: {
            ordered: [{
              kind: "cut",
              range: { endUs: 5_000_000, startUs: 4_000_000 },
            }],
          },
          kind: "derive.edit-batch",
          version: 1,
        },
      );
      const singletonReceipt = await registry.execute(
        executionContext(repositoryRoot),
        {
          input: {
            basis: (
              await openProjectSnapshot(
                fixture.projectRoot,
                fixture.project.projectId,
              )
            ).editBasis,
            batch: singletonBatchResult.output,
            project: fixture.project.projectId,
          },
          kind: "project.commit-edits",
          version: 1,
        },
      );
      const singletonPlan = await loadProjectEditPlan(fixture.fileSystem);
      expect(singletonReceipt.output).toMatchObject({
        operation: "cut",
        planHash: hashProjectEditPlan(singletonPlan),
        planId: fixture.plan.planId,
        projectId: fixture.project.projectId,
      });

      expect(registry.execute(executionContext(repositoryRoot), {
        input: {
          ordered: [{
            extra: true,
            kind: "cut",
            range: { endUs: 2, startUs: 1 },
          }],
        },
        kind: "derive.edit-batch",
        version: 1,
      })).rejects.toThrow();
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("adds and removes prepared overlays through one checked transaction", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-operations-overlays-"));
    try {
      const fixture = await createOperationProjectFixture(repositoryRoot);
      const registry = new OperationRegistry();
      registry.register(deriveEditBatchOperationDefinition);
      registry.register(commitProjectEditsOperationDefinition);
      const later = preparedImageOverlay("overlay_later001", 2_000_000, 2);
      const earlier = preparedImageOverlay("overlay_earlier01", 1_000_000, 1);

      expect(registry.execute(executionContext(repositoryRoot), {
        input: {
          ordered: [{
            kind: "add-overlays",
            overlays: [earlier, earlier],
          }],
        },
        kind: "derive.edit-batch",
        version: 1,
      })).rejects.toThrow(/duplicate overlay IDs/u);
      expect(registry.execute(executionContext(repositoryRoot), {
        input: {
          ordered: [
            { kind: "add-overlays", overlays: [earlier] },
            { kind: "add-overlays", overlays: [earlier] },
          ],
        },
        kind: "derive.edit-batch",
        version: 1,
      })).rejects.toThrow(/cannot add the same overlay ID twice/u);
      const replacementSequence = await registry.execute(
        executionContext(repositoryRoot),
        {
          input: {
            ordered: [
              {
                kind: "remove-overlays",
                overlayIds: [earlier.overlayId],
              },
              { kind: "add-overlays", overlays: [earlier] },
            ],
          },
          kind: "derive.edit-batch",
          version: 1,
        },
      );
      expect(ProjectEditBatchSchema.parse(replacementSequence.output).ordered
        .map(edit => edit.kind)).toEqual([
          "remove-overlays",
          "add-overlays",
        ]);
      const transientSequence = await registry.execute(
        executionContext(repositoryRoot),
        {
          input: {
            ordered: [
              { kind: "add-overlays", overlays: [later] },
              {
                kind: "remove-overlays",
                overlayIds: [later.overlayId],
              },
            ],
          },
          kind: "derive.edit-batch",
          version: 1,
        },
      );
      expect(ProjectEditBatchSchema.parse(transientSequence.output).ordered
        .map(edit => edit.kind)).toEqual([
          "add-overlays",
          "remove-overlays",
        ]);

      const addBatch = await registry.execute(executionContext(repositoryRoot), {
        input: {
          ordered: [{
            kind: "add-overlays",
            overlays: [later, earlier],
          }],
        },
        kind: "derive.edit-batch",
        version: 1,
      });
      const initial = await openProjectSnapshot(
        fixture.projectRoot,
        fixture.project.projectId,
      );
      const addReceipt = await registry.execute(executionContext(repositoryRoot), {
        input: {
          basis: initial.editBasis,
          batch: addBatch.output,
          project: fixture.project.projectId,
        },
        kind: "project.commit-edits",
        version: 1,
      });
      expect(addReceipt.output).toMatchObject({ operation: "batch" });
      const added = await openProjectSnapshot(
        fixture.projectRoot,
        fixture.project.projectId,
      );
      expect(added.plan.overlays.map(overlay => String(overlay.overlayId))).toEqual([
        "overlay_earlier01",
        "overlay_later001",
      ]);

      const duplicateBatch = await registry.execute(executionContext(repositoryRoot), {
        input: {
          ordered: [{ kind: "add-overlays", overlays: [earlier] }],
        },
        kind: "derive.edit-batch",
        version: 1,
      });
      const duplicateError = await registry.execute(
        executionContext(repositoryRoot),
        {
          input: {
            basis: added.editBasis,
            batch: duplicateBatch.output,
            project: fixture.project.projectId,
          },
          kind: "project.commit-edits",
          version: 1,
        },
      ).catch((caught: unknown) => caught);
      expect(duplicateError).toBeInstanceOf(ApplicationError);
      if (!(duplicateError instanceof ApplicationError)) {
        throw new Error("Expected duplicate overlay conflict.");
      }
      expect(duplicateError.code).toBe("conflict");
      expect(duplicateError.message).toMatch(/Overlay ID already exists/u);
      expect((await openProjectSnapshot(
        fixture.projectRoot,
        fixture.project.projectId,
      )).plan).toEqual(added.plan);

      const unknownRemoval = await registry.execute(
        executionContext(repositoryRoot),
        {
          input: {
            ordered: [{
              kind: "remove-overlays",
              overlayIds: ["overlay_unknown01"],
            }],
          },
          kind: "derive.edit-batch",
          version: 1,
        },
      );
      const unknownRemovalError = await registry.execute(
        executionContext(repositoryRoot),
        {
          input: {
            basis: added.editBasis,
            batch: unknownRemoval.output,
            project: fixture.project.projectId,
          },
          kind: "project.commit-edits",
          version: 1,
        },
      ).catch((caught: unknown) => caught);
      expect(unknownRemovalError).toBeInstanceOf(ApplicationError);
      if (!(unknownRemovalError instanceof ApplicationError)) {
        throw new Error("Expected unknown overlay error.");
      }
      expect(unknownRemovalError.code).toBe("not-found");
      expect(unknownRemovalError.message).toMatch(/Unknown overlay/u);
      expect((await openProjectSnapshot(
        fixture.projectRoot,
        fixture.project.projectId,
      )).plan).toEqual(added.plan);

      const removeBatch = await registry.execute(executionContext(repositoryRoot), {
        input: {
          ordered: [{
            kind: "remove-overlays",
            overlayIds: [earlier.overlayId],
          }],
        },
        kind: "derive.edit-batch",
        version: 1,
      });
      await registry.execute(executionContext(repositoryRoot), {
        input: {
          basis: added.editBasis,
          batch: removeBatch.output,
          project: fixture.project.projectId,
        },
        kind: "project.commit-edits",
        version: 1,
      });
      const removed = await openProjectSnapshot(
        fixture.projectRoot,
        fixture.project.projectId,
      );
      expect(removed.plan.overlays.map(overlay => String(overlay.overlayId)))
        .toEqual(["overlay_later001"]);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });
});

test("concurrent analysis wrappers merge authoritative references without lost updates", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-operations-analysis-"));
  try {
    const fixture = await createOperationProjectFixture(repositoryRoot);
    const calls: Array<Readonly<Record<string, unknown>>> = [];
    const capabilities: ApplicationContext["capabilities"] = () => Promise.resolve([
      { available: true, command: "ffmpeg-test", name: "ffmpeg", version: "ffmpeg fixture" },
      { available: true, command: "ffprobe-test", name: "ffprobe", version: "ffprobe fixture" },
      { available: true, command: "faces-test", name: "face-analyzer", version: "faces fixture" },
    ]);
    let waitingAnalyses = 0;
    const releaseAnalysisWaiters: Array<() => void> = [];
    const waitForConcurrentAnalyses = async () => await new Promise<void>(resolve => {
      waitingAnalyses += 1;
      if (waitingAnalyses === 3) {
        for (const release of releaseAnalysisWaiters) release();
        resolve();
        return;
      }
      releaseAnalysisWaiters.push(resolve);
    });
    const inactivity = createProjectInactivityOperationDefinition({
      analyze: async options => {
        calls.push({
          analysisId: options.analysisId,
          ffmpeg: options.ffmpeg,
          ffprobe: options.ffprobe,
          now: options.now.toISOString(),
          toolVersion: options.toolVersion,
        });
        const analysisId = AnalysisIdSchema.parse(options.analysisId);
        await waitForConcurrentAnalyses();
        return {
          analysis: {
            analysisId,
            projectId: fixture.project.projectId,
            referenceRecording: null,
            result: {
              candidateCount: 2,
              protectedInteractionCount: 1,
              recommendedRanges: [{ endUs: 4_000_000, startUs: 2_000_000 }],
            },
          },
        };
      },
      publish: options => {
        const path = `analysis/inactivity/${options.analysis.analysisId}.json`;
        const reference = ProjectAnalysisReferenceSchema.parse({
          analysisId: options.analysis.analysisId,
          audioStreams: 0,
          createdAt: OPERATION_TEST_LATER.toISOString(),
          displayStreams: 1,
          kind: "inactivity",
          path,
          projectStructureSha256: hashProjectStructure(fixture.project),
          recommendedRanges: options.analysis.result.recommendedRanges.length,
          sha256: OPERATION_TEST_HASH,
        });
        if (reference.kind !== "inactivity") throw new Error("fixture reference kind changed");
        return Promise.resolve({ analysisPath: path, reference });
      },
      nextAnalysisId: () => "analysis_inactive01",
      toolVersion: "application-test",
    });
    const faces = createFacesOperationDefinition({
      analyze: async options => {
        calls.push({
          analysisId: options.analysisId,
          faceAnalyzer: options.faceAnalyzer,
          ffprobe: options.ffprobe,
          now: options.now.toISOString(),
        });
        const analysisId = AnalysisIdSchema.parse(options.analysisId);
        await waitForConcurrentAnalyses();
        return {
          analysis: {
            analysisId,
            backend: {
              architecture: "arm64",
              kind: "apple-vision",
              osBuild: "26A1",
              requestRevision: 3,
              runtimeVersion: "26.0",
            },
            coverage: {
              analyzedFrames: 3,
              failedFrames: 0,
              range: { endUs: 10_000_000, startUs: 0 },
              requestedFrames: 3,
            },
            privacy: {
              biometricIdentification: "not-performed",
              execution: "local-only",
              storedEvidence: "bounding-boxes-only",
              tracking: "geometry-continuity-only",
            },
            tracks: [],
          },
        };
      },
      publish: options => {
        const path = `analysis/faces/${options.analysis.analysisId}.json`;
        const reference = ProjectAnalysisReferenceSchema.parse({
          analysisId: options.analysis.analysisId,
          analyzedFrames: options.analysis.coverage.analyzedFrames,
          assetId: "asset_operation01",
          createdAt: OPERATION_TEST_LATER.toISOString(),
          kind: "faces",
          localOnly: true,
          path,
          sha256: OPERATION_TEST_HASH,
          streamId: "stream_operation01",
          subjectIntegritySha256: OPERATION_TEST_HASH,
          trackCount: options.analysis.tracks.length,
        });
        if (reference.kind !== "faces") throw new Error("fixture reference kind changed");
        return Promise.resolve({ analysisPath: path, reference });
      },
      nextAnalysisId: () => "analysis_faces0001",
    });
    const music = createMusicOperationDefinition({
      analyze: async options => {
        calls.push({
          analysisId: options.analysisId,
          ffmpeg: options.ffmpeg,
          now: options.now.toISOString(),
          toolVersion: options.toolVersion,
        });
        const analysisId = AnalysisIdSchema.parse(options.analysisId);
        await waitForConcurrentAnalyses();
        return {
          analysis: {
            analysisId,
            keyRegions: [],
            musicRegions: [],
            tempoRegions: [],
          },
        };
      },
      publish: options => {
        const path = `analysis/music/${options.analysis.analysisId}.json`;
        const reference = ProjectAnalysisReferenceSchema.parse({
          analysisId: options.analysis.analysisId,
          assetId: "asset_operation01",
          createdAt: OPERATION_TEST_LATER.toISOString(),
          keyRegions: options.analysis.keyRegions.length,
          kind: "music",
          musicRegions: options.analysis.musicRegions.length,
          path,
          sha256: OPERATION_TEST_HASH,
          streamId: "stream_operation02",
          tempoRegions: options.analysis.tempoRegions.length,
        });
        if (reference.kind !== "music") throw new Error("fixture reference kind changed");
        return Promise.resolve({ analysisPath: path, reference });
      },
      nextAnalysisId: () => "analysis_music0001",
      toolVersion: "application-test",
    });
    for (const definition of [inactivity, faces, music]) {
      expect(definition.policy.resources.some(
        claim => claim.resource === "project-publication",
      )).toBe(false);
    }
    const registry = new OperationRegistry();
    registry.register(inactivity);
    registry.register(faces);
    registry.register(music);
    const generation = hashProjectGeneration(fixture.project, fixture.plan);
    const initialSnapshot = await openProjectSnapshot(
      fixture.projectRoot,
      fixture.project.projectId,
    );
    const context = executionContext(
      repositoryRoot,
      generation.generationSha256,
      capabilities,
    );

    const [inactivityResult, facesResult, musicResult] = await Promise.all([
      registry.execute(context, {
        input: { project: fixture.project.projectId },
        kind: "analysis.project-inactivity",
        version: 1,
      }),
      registry.execute(context, {
        input: {
          project: fixture.project.projectId,
          source: "asset_operation01:stream_operation01",
        },
        kind: "analysis.faces",
        version: 1,
      }),
      registry.execute(context, {
        input: {
          project: fixture.project.projectId,
          source: "asset_operation01:stream_operation02",
        },
        kind: "analysis.music",
        version: 1,
      }),
    ]);

    expect(inactivityResult.output).toMatchObject({
      analysisId: "analysis_inactive01",
      evidencePath: "analysis/inactivity/analysis_inactive01.json",
      reference: {
        analysisId: "analysis_inactive01",
        kind: "inactivity",
        sha256: OPERATION_TEST_HASH,
      },
    });
    expect(facesResult.output).toMatchObject({
      analysisId: "analysis_faces0001",
      path: "analysis/faces/analysis_faces0001.json",
      reference: {
        analysisId: "analysis_faces0001",
        kind: "faces",
        sha256: OPERATION_TEST_HASH,
      },
    });
    expect(musicResult.output).toMatchObject({
      analysisId: "analysis_music0001",
      path: "analysis/music/analysis_music0001.json",
      reference: {
        analysisId: "analysis_music0001",
        kind: "music",
        sha256: OPERATION_TEST_HASH,
      },
    });
    expect(calls).toHaveLength(3);
    expect(calls).toContainEqual({
        analysisId: "analysis_inactive01",
        ffmpeg: "ffmpeg-test",
        ffprobe: "ffprobe-test",
        now: OPERATION_TEST_LATER.toISOString(),
        toolVersion: "application-test",
      });
    expect(calls).toContainEqual({
        analysisId: "analysis_faces0001",
        faceAnalyzer: "faces-test",
        ffprobe: "ffprobe-test",
        now: OPERATION_TEST_LATER.toISOString(),
      });
    expect(calls).toContainEqual({
        analysisId: "analysis_music0001",
        ffmpeg: "ffmpeg-test",
        now: OPERATION_TEST_LATER.toISOString(),
        toolVersion: "application-test",
      });
    const published = await openProjectSnapshot(
      fixture.projectRoot,
      fixture.project.projectId,
    );
    expect(published.project.analyses.map(reference => reference.analysisId).sort()).toEqual([
      AnalysisIdSchema.parse("analysis_faces0001"),
      AnalysisIdSchema.parse("analysis_inactive01"),
      AnalysisIdSchema.parse("analysis_music0001"),
    ]);
    registry.register(deriveEditBatchOperationDefinition);
    registry.register(commitProjectEditsOperationDefinition);
    const batch = await registry.execute(executionContext(repositoryRoot), {
      input: {
        ordered: [{
          kind: "cut",
          range: { endUs: 4_000_000, startUs: 2_000_000 },
        }],
      },
      kind: "derive.edit-batch",
      version: 1,
    });
    await registry.execute(executionContext(repositoryRoot), {
      input: {
        basis: initialSnapshot.editBasis,
        batch: batch.output,
        project: fixture.project.projectId,
      },
      kind: "project.commit-edits",
      version: 1,
    });
    const committed = await openProjectSnapshot(
      fixture.projectRoot,
      fixture.project.projectId,
    );
    expect(committed.project.analyses).toHaveLength(3);
    expect(committed.generation.currentPlanSha256)
      .not.toBe(generation.currentPlanSha256);
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
});

test("checked commits reject a missing typed edit basis", async () => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-operations-generation-"));
  try {
    const fixture = await createOperationProjectFixture(repositoryRoot);
    const registry = new OperationRegistry();
    registry.register(deriveEditBatchOperationDefinition);
    registry.register(commitProjectEditsOperationDefinition);
    const batchResult = await registry.execute(executionContext(repositoryRoot), {
      input: {
        ordered: [{
          kind: "cut",
          range: { endUs: 2_000_000, startUs: 1_000_000 },
        }],
      },
      kind: "derive.edit-batch",
      version: 1,
    });
    expect(registry.execute(executionContext(repositoryRoot), {
      input: {
        batch: batchResult.output,
        project: fixture.project.projectId,
      },
      kind: "project.commit-edits",
      version: 1,
    })).rejects.toThrow();
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
});
