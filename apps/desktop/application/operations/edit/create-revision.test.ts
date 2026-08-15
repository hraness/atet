import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FaceAnalysisV1Schema,
  ProjectAnalysisReferenceSchema,
  VideoProjectV1Schema,
} from "../../../contracts";
import {
  canonicalJsonSha256,
  loadProjectEditPlan,
  saveProjectEditPlan,
  saveVideoProject,
  sha256Hex,
} from "../../../core";
import { OperationRegistry } from "../../registry";
import {
  hashProjectGeneration,
} from "../../project-store";
import {
  ProjectEditRevisionReferenceSchema,
  ProjectEditRevisionDocumentSchema,
} from "../../receipts";
import {
  createOperationProjectFixture,
  operationApplicationContext,
} from "../test-support";
import {
  FaceFollowRevisionDraftSchema,
  createFollowFacesOperationDefinition,
} from "../derive/follow-faces";
import {
  createProjectEditRevisionOperationDefinition,
} from "./create-revision";

const FACE_ANALYSIS_SHA256 = "b".repeat(64);
const FACE_SUBJECT_SHA256 = "c".repeat(64);
const FACE_INPUT_SHA256 = "d".repeat(64);
const FACE_TRACK_ID = "face_operation01";
const FACE_ANALYSIS_ID = "analysis_operationfaces1";

function faceEvidence() {
  const analysis = FaceAnalysisV1Schema.parse({
    analysisId: FACE_ANALYSIS_ID,
    backend: {
      architecture: "arm64",
      kind: "apple-vision",
      osBuild: "25A100",
      requestRevision: 3,
      runtimeVersion: "26.0",
    },
    config: {
      sampleIntervalUs: 2_000_000,
      tracking: {
        iouWeight: 0.6,
        maximumCenterDistance: 0.5,
        maximumFacesPerFrame: 8,
        maximumGapUs: 2_500_000,
        minimumConfidence: 0.6,
        minimumIou: 0.05,
      },
    },
    coordinateSpace: {
      encodedPixelHeight: 1_080,
      encodedPixelWidth: 1_920,
      mirroredHorizontally: false,
      origin: "top-left",
      pixelHeight: 1_080,
      pixelWidth: 1_920,
      rotationDegrees: 0,
      sampleAspectRatio: { denominator: 1, numerator: 1 },
      units: "normalized",
      xAxis: "right",
      yAxis: "down",
    },
    coverage: {
      analyzedFrames: 5,
      failedFrames: 0,
      range: { endUs: 10_000_000, startUs: 0 },
      requestedFrames: 5,
    },
    createdAt: "2026-07-23T15:00:00.000Z",
    durationUs: 10_000_000,
    inputDigest: FACE_INPUT_SHA256,
    kind: "studio.face-analysis",
    privacy: {
      biometricIdentification: "not-performed",
      execution: "local-only",
      storedEvidence: "bounding-boxes-only",
      tracking: "geometry-continuity-only",
    },
    results: [
      { assetTimeUs: 1_000_000, x: 0.15 },
      { assetTimeUs: 3_000_000, x: 0.3 },
      { assetTimeUs: 5_000_000, x: 0.55 },
      { assetTimeUs: 7_000_000, x: 0.65 },
      { assetTimeUs: 8_500_000, x: 0.4 },
    ].map(sample => ({
      assetTimeUs: sample.assetTimeUs,
      detections: [{
        confidence: 0.98,
        rect: {
          height: 0.2,
          width: 0.2,
          x: sample.x,
          y: 0.22,
        },
        trackId: FACE_TRACK_ID,
      }],
      discardedDetections: 0,
      state: "analyzed" as const,
    })),
    schemaVersion: 1,
    subject: {
      assetId: "asset_operation01",
      integritySha256: FACE_SUBJECT_SHA256,
      streamId: "stream_operation01",
    },
    tool: {
      name: "atet-face-analyzer",
      profile: "offline-boxes",
      version: "0.1.0",
    },
    tracks: [{
      firstSeenAssetTimeUs: 1_000_000,
      lastSeenAssetTimeUs: 8_500_000,
      maximumObservedGapUs: 2_000_000,
      observationCount: 5,
      trackId: FACE_TRACK_ID,
    }],
  });
  const reference = ProjectAnalysisReferenceSchema.parse({
    analysisId: FACE_ANALYSIS_ID,
    analyzedFrames: 5,
    assetId: "asset_operation01",
    createdAt: analysis.createdAt,
    kind: "faces",
    localOnly: true,
    path: `analysis/faces/${FACE_ANALYSIS_ID}.json`,
    sha256: FACE_ANALYSIS_SHA256,
    streamId: "stream_operation01",
    subjectIntegritySha256: FACE_SUBJECT_SHA256,
    trackCount: 1,
  });
  if (reference.kind !== "faces") throw new TypeError("Expected face reference.");
  return { analysis, reference };
}

function executionContext(
  repositoryRoot: string,
  expectedProjectGeneration: string,
) {
  return {
    abortSignal: new AbortController().signal,
    application: operationApplicationContext(repositoryRoot),
    expectedProjectGeneration,
  };
}

describe("immutable face-follow edit revisions", () => {
  test("derives and publishes independent common aspects without moving current", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-face-revisions-"));
    try {
      const fixture = await createOperationProjectFixture(repositoryRoot);
      const evidence = faceEvidence();
      const project = VideoProjectV1Schema.parse({
        ...fixture.project,
        analyses: [evidence.reference],
      });
      await saveVideoProject(fixture.fileSystem, project);
      const generation = hashProjectGeneration(project, fixture.plan);
      const registry = new OperationRegistry();
      registry.register(createFollowFacesOperationDefinition({
        loadFaceAnalysis: () => Promise.resolve(evidence),
      }));
      registry.register(createProjectEditRevisionOperationDefinition);
      const baseInput = {
        analysisId: FACE_ANALYSIS_ID,
        gapPolicy: "fallback" as const,
        placementId: "placement_operation01",
        project: project.projectId,
        projectRange: { endUs: 9_000_000, startUs: 1_000_000 },
        selection: {
          kind: "explicit" as const,
          trackIds: [FACE_TRACK_ID],
        },
        smoothingSeconds: 0,
      };

      const aspects = ["16:9", "1:1", "9:16"] as const;
      const drafts = await Promise.all(aspects.map(async aspect => (
        FaceFollowRevisionDraftSchema.parse((await registry.execute(
          executionContext(repositoryRoot, generation.generationSha256),
          {
            input: { ...baseInput, aspect },
            kind: "derive.follow-faces",
            version: 1,
          },
        )).output)
      )));
      const repeated = FaceFollowRevisionDraftSchema.parse((await registry.execute(
        executionContext(repositoryRoot, generation.generationSha256),
        {
          input: { ...baseInput, aspect: "16:9" },
          kind: "derive.follow-faces",
          version: 1,
        },
      )).output);
      expect(repeated).toEqual(drafts[0]!);
      expect(drafts.every(draft =>
        draft.kind === "atet.face-follow-edit-revision-draft"
      )).toBe(true);
      expect(new Set(drafts.map(draft => draft.planSha256)).size).toBe(3);
      expect(drafts.map(draft => [
        draft.pixelWidth,
        draft.pixelHeight,
        draft.cameraMove.origin.kind === "face-analysis"
          ? draft.cameraMove.origin.outputAspectRatio
          : null,
      ])).toEqual([
        [1_920, 1_080, 16 / 9],
        [1_080, 1_080, 1],
        [1_080, 1_920, 9 / 16],
      ]);
      expect(await loadProjectEditPlan(fixture.fileSystem)).toEqual(fixture.plan);

      const references = await Promise.all(drafts.map(async draft => (
        ProjectEditRevisionReferenceSchema.parse((await registry.execute(
          executionContext(repositoryRoot, generation.generationSha256),
          {
            input: { draft, project: project.projectId },
            kind: "edit.create-revision",
            version: 1,
          },
        )).output)
      )));
      expect(references.map(reference => reference.aspect)).toEqual([...aspects]);
      expect(references.every(reference =>
        reference.kind === "atet.project-edit-revision-reference"
      )).toBe(true);
      expect(new Set(references.map(reference => reference.artifact.path)).size)
        .toBe(3);
      expect(await loadProjectEditPlan(fixture.fileSystem)).toEqual(fixture.plan);
      for (const [index, reference] of references.entries()) {
        const publishedText = await fixture.fileSystem.readText(
          reference.artifact.path,
        );
        const published = ProjectEditRevisionDocumentSchema.parse(
          JSON.parse(publishedText) as unknown,
        );
        expect(published.kind).toBe("atet.project-edit-revision");
        expect(published.project).toEqual(project);
        expect(published.projectEditPlan).toEqual(drafts[index]!.plan);
        expect(published.projectSha256).toBe(reference.projectSha256);
        expect(published.projectEditPlanSha256)
          .toBe(reference.projectEditPlanSha256);
        expect(published.revisionSha256).toBe(reference.revisionSha256);
        expect(sha256Hex(publishedText)).toBe(reference.artifact.sha256);
        expect(new TextEncoder().encode(publishedText).byteLength)
          .toBe(reference.artifact.bytes);
      }

      const retried = await Promise.all([0, 1].map(async () => (
        ProjectEditRevisionReferenceSchema.parse((await registry.execute(
          executionContext(repositoryRoot, generation.generationSha256),
          {
            input: { draft: drafts[0], project: project.projectId },
            kind: "edit.create-revision",
            version: 1,
          },
        )).output)
      )));
      expect(retried[0]).toEqual(references[0]);
      expect(retried[1]).toEqual(references[0]);
      expect(await loadProjectEditPlan(fixture.fileSystem)).toEqual(fixture.plan);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("rejects stale bases, unrelated draft edits, and occupied revision paths", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-face-revision-conflicts-"));
    try {
      const fixture = await createOperationProjectFixture(repositoryRoot);
      const evidence = faceEvidence();
      const project = VideoProjectV1Schema.parse({
        ...fixture.project,
        analyses: [evidence.reference],
      });
      await saveVideoProject(fixture.fileSystem, project);
      const generation = hashProjectGeneration(project, fixture.plan);
      const registry = new OperationRegistry();
      registry.register(createFollowFacesOperationDefinition({
        loadFaceAnalysis: () => Promise.resolve(evidence),
      }));
      registry.register(createProjectEditRevisionOperationDefinition);
      const draft = FaceFollowRevisionDraftSchema.parse((await registry.execute(
        executionContext(repositoryRoot, generation.generationSha256),
        {
          input: {
            analysisId: FACE_ANALYSIS_ID,
            aspect: "16:9",
            gapPolicy: "fallback",
            placementId: "placement_operation01",
            project: project.projectId,
            projectRange: { endUs: 9_000_000, startUs: 1_000_000 },
            selection: { kind: "explicit", trackIds: [FACE_TRACK_ID] },
            smoothingSeconds: 0,
          },
          kind: "derive.follow-faces",
          version: 1,
        },
      )).output);

      const forgedPlan = {
        ...draft.plan,
        effects: {
          ...draft.plan.effects,
          metadataPlacementId: null,
        },
      };
      const forged = FaceFollowRevisionDraftSchema.parse({
        ...draft,
        plan: forgedPlan,
        planSha256: canonicalJsonSha256(forgedPlan),
      });
      expect(registry.execute(
        executionContext(repositoryRoot, generation.generationSha256),
        {
          input: { draft: forged, project: project.projectId },
          kind: "edit.create-revision",
          version: 1,
        },
      )).rejects.toMatchObject({ code: "conflict" });

      const reference = ProjectEditRevisionReferenceSchema.parse((await registry.execute(
        executionContext(repositoryRoot, generation.generationSha256),
        {
          input: { draft, project: project.projectId },
          kind: "edit.create-revision",
          version: 1,
        },
      )).output);
      await fixture.fileSystem.writeTextAtomic(reference.artifact.path, "{}\n");
      expect(registry.execute(
        executionContext(repositoryRoot, generation.generationSha256),
        {
          input: { draft, project: project.projectId },
          kind: "edit.create-revision",
          version: 1,
        },
      )).rejects.toThrow("different bytes");

      const changedPlan = {
        ...fixture.plan,
        updatedAt: "2026-07-23T15:02:00.000Z",
      };
      await saveProjectEditPlan(fixture.fileSystem, changedPlan);
      expect(registry.execute(
        executionContext(
          repositoryRoot,
          hashProjectGeneration(project, changedPlan).generationSha256,
        ),
        {
          input: { draft, project: project.projectId },
          kind: "edit.create-revision",
          version: 1,
        },
      )).rejects.toMatchObject({ code: "conflict" });
      expect(await loadProjectEditPlan(fixture.fileSystem)).toEqual(changedPlan);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });
});
