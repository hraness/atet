import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  FaceAnalysisV1Schema,
  ProjectAnalysisReferenceSchema,
  VideoProjectV1Schema,
} from "../contracts";
import {
  DEFAULT_FACE_ANALYSIS_CONFIG,
  buildFaceAnalysisReference,
} from "../cli/face-analysis-service";
import { resolveVideoAnalysisSubject } from "../cli/scene-analysis-service";
import {
  canonicalJson,
  hashProjectStructure,
  saveAnalysisArtifact,
  saveVideoProject,
} from "../core";
import { openProjectSnapshot } from "./project-store";
import {
  OPERATION_TEST_HASH,
  OPERATION_TEST_LATER,
  createOperationProjectFixture,
  operationApplicationContext,
} from "./operations/test-support";
import {
  LOCAL_VERIFIED_RECEIPT_OPERATION_KINDS,
  reconcileLocalVerifiedReceiptOperation,
} from "./verified-receipt-reconciliation";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root =>
    await rm(root, { force: true, recursive: true })));
});

async function rootFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atet-receipt-recovery-"));
  roots.push(root);
  return root;
}

function reconciliationControl() {
  return {
    abortSignal: new AbortController().signal,
    beforePublication: () => Promise.resolve(),
  };
}

describe("verified-receipt reconciliation", () => {
  test("registers every local receipt-backed recovery boundary", () => {
    expect(LOCAL_VERIFIED_RECEIPT_OPERATION_KINDS).toEqual([
      "analysis.faces",
      "analysis.music",
      "analysis.project-inactivity",
      "media.audio-effects",
      "media.color-grade",
      "media.html-overlay",
      "media.ingest",
      "media.overlay",
      "atet.diagram.render",
      "atet.image.vectorize",
    ]);
  });

  test("adopts an exact canonical analysis orphan published before its project reference", async () => {
    const root = await rootFixture();
    const fixture = await createOperationProjectFixture(root);
    const application = operationApplicationContext(root);
    const workspaceDirectory = join(
      application.paths.privateRoot,
      "workflow-runs",
      "run_faces",
    );
    await mkdir(workspaceDirectory, { mode: 0o700, recursive: true });
    const analysisId = "analysis_recoveryfaces1";
    const identity = {
      inputSchemaId: "studio.operation.analysis.faces.input/v1",
      kind: "analysis.faces",
      nodeKey: "faces",
      nodePlanSha256: "a".repeat(64),
      outputSchemaId: "studio.operation.analysis.faces.output/v1",
      runId: "run_faces",
      version: 1,
    } as const;
    const initialSnapshot = await openProjectSnapshot(
      application.paths.projectRoot,
      fixture.project.projectId,
    );
    const exactInput = {
      analysisId,
      project: fixture.project.projectId,
      projectBinding: initialSnapshot.editBasis,
      source: "asset_operation01:stream_operation01",
    };
    expect(await reconcileLocalVerifiedReceiptOperation(application, {
      ...reconciliationControl(),
      exactInput,
      identity,
      workspaceDirectory,
    })).toEqual({ kind: "retry" });

    const analysis = FaceAnalysisV1Schema.parse({
      analysisId,
      backend: {
        architecture: "arm64",
        kind: "apple-vision",
        osBuild: "26A1",
        requestRevision: 3,
        runtimeVersion: "26.0",
      },
      config: DEFAULT_FACE_ANALYSIS_CONFIG,
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
        analyzedFrames: 1,
        failedFrames: 0,
        range: { endUs: 10_000_000, startUs: 0 },
        requestedFrames: 1,
      },
      createdAt: "2026-07-23T15:01:00.000Z",
      durationUs: 10_000_000,
      inputDigest: "b".repeat(64),
      kind: "studio.face-analysis",
      privacy: {
        biometricIdentification: "not-performed",
        execution: "local-only",
        storedEvidence: "bounding-boxes-only",
        tracking: "geometry-continuity-only",
      },
      results: [{
        assetTimeUs: 0,
        detections: [],
        discardedDetections: 0,
        state: "analyzed",
      }],
      schemaVersion: 1,
      subject: resolveVideoAnalysisSubject(
        fixture.project,
        exactInput.source,
      ).subject,
      tool: {
        name: "atet-face-analyzer",
        profile: "offline-boxes",
        version: "test",
      },
      tracks: [],
    });
    const path = `analysis/faces/${analysisId}.json`;
    await saveAnalysisArtifact(fixture.fileSystem, analysis, path);
    const sibling = ProjectAnalysisReferenceSchema.parse({
      analysisId: "analysis_recoverysibling1",
      audioStreams: 1,
      createdAt: OPERATION_TEST_LATER.toISOString(),
      displayStreams: 1,
      kind: "inactivity",
      path: "analysis/inactivity/analysis_recoverysibling1.json",
      projectStructureSha256: hashProjectStructure(fixture.project),
      recommendedRanges: 0,
      sha256: OPERATION_TEST_HASH,
    });
    await saveVideoProject(fixture.fileSystem, VideoProjectV1Schema.parse({
      ...fixture.project,
      analyses: [sibling],
      updatedAt: OPERATION_TEST_LATER.toISOString(),
    }));

    const recovered = await reconcileLocalVerifiedReceiptOperation(
      application,
      {
        ...reconciliationControl(),
        exactInput,
        identity,
        workspaceDirectory,
      },
    );
    expect(recovered).toMatchObject({
      kind: "completed",
      output: {
        analysisId,
        analyzedFrames: 1,
        path,
        projectId: fixture.project.projectId,
        tracks: 0,
      },
    });
    expect(
      (await openProjectSnapshot(
        application.paths.projectRoot,
        fixture.project.projectId,
      )).project.analyses,
    ).toEqual([sibling, buildFaceAnalysisReference(analysis, path)]);
    const wrongProjectBasis = await reconcileLocalVerifiedReceiptOperation(
      application,
      {
        ...reconciliationControl(),
        exactInput: {
          ...exactInput,
          projectBinding: {
            ...exactInput.projectBinding,
            currentPlanSha256: "d".repeat(64),
          },
        },
        identity,
        workspaceDirectory,
      },
    );
    expect(wrongProjectBasis).toMatchObject({ kind: "incompatible" });

    await writeFile(
      join(fixture.projectDirectory, path),
      `${canonicalJson({ ...analysis, inputDigest: "c".repeat(64) })}\n`,
    );
    const tampered = await reconcileLocalVerifiedReceiptOperation(
      application,
      {
        ...reconciliationControl(),
        exactInput,
        identity,
        workspaceDirectory,
      },
    );
    expect(tampered).toMatchObject({ kind: "incompatible" });
  });

  test("requires exact current recording evidence for inactivity recovery", async () => {
    const root = await rootFixture();
    const fixture = await createOperationProjectFixture(root);
    const application = operationApplicationContext(root);
    const workspaceDirectory = join(
      application.paths.privateRoot,
      "workflow-runs",
      "run_inactivity",
    );
    await mkdir(workspaceDirectory, { mode: 0o700, recursive: true });
    const snapshot = await openProjectSnapshot(
      application.paths.projectRoot,
      fixture.project.projectId,
    );
    const identity = {
      inputSchemaId: "studio.operation.analysis.project-inactivity.input/v1",
      kind: "analysis.project-inactivity",
      nodeKey: "inactivity",
      nodePlanSha256: "e".repeat(64),
      outputSchemaId:
        "studio.operation.analysis.project-inactivity.output/v1",
      runId: "run_inactivity",
      version: 1,
    } as const;
    const exactInput = {
      analysisId: "analysis_inactivityrecovery1",
      project: fixture.project.projectId,
      projectBinding: snapshot.editBasis,
    };

    expect(await reconcileLocalVerifiedReceiptOperation(application, {
      ...reconciliationControl(),
      exactInput,
      identity,
      workspaceDirectory,
    })).toMatchObject({ kind: "incompatible" });

    expect(await reconcileLocalVerifiedReceiptOperation(application, {
      ...reconciliationControl(),
      exactInput: {
        ...exactInput,
        recordingBinding: {
          eventsSha256: "1".repeat(64),
          eventStreamsSha256: "2".repeat(64),
          manifestSha256: "3".repeat(64),
          placementId: fixture.project.referencePlacementId,
          recordingId: "rec_inactivityrecovery1",
          syncMapSha256: "4".repeat(64),
        },
      },
      identity,
      workspaceDirectory,
    })).toMatchObject({ kind: "incompatible" });
  });
});
