import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ProjectAnalysisReferenceSchema,
  RecordingEventV1Schema,
  VideoProjectV1Schema,
} from "../../../contracts";
import {
  createDefaultProjectEditPlan,
  createNodeBundleFileSystem,
  saveProjectEditPlan,
  saveRecordingManifest,
  saveVideoProject,
  hashProjectStructure,
} from "../../../core";
import { testManifest } from "../../../core/test-support";
import { openProjectSnapshot } from "../../project-store";
import { OperationRegistry } from "../../registry";
import {
  OPERATION_TEST_HASH,
  OPERATION_TEST_LATER,
  createOperationProjectFixture,
  operationApplicationContext,
} from "../test-support";
import {
  ProjectAutoZoomOutputSchema,
  bindProjectAutoZoomInput,
  createProjectAutoZoomOperationDefinition,
} from "./project-auto-zooms";

const windowSnapshot = RecordingEventV1Schema.parse({
  nativeTimeUs: 0,
  sequence: 0,
  sourceTimeUs: 0,
  type: "window.snapshot",
  windows: [{
    applicationBundleId: "com.example",
    applicationName: "Example",
    bounds: { height: 500, width: 700, x: 100, y: 100 },
    displayId: "display-primary",
    isFocused: true,
    layer: 1,
    title: { state: "available", value: "Example" },
    windowId: "window-1",
  }],
});

const focus = RecordingEventV1Schema.parse({
  nativeTimeUs: 1_000_000,
  sequence: 1,
  sourceTimeUs: 1_000_000,
  target: {
    bounds: { height: 30, width: 300, x: 200, y: 300 },
    fieldId: "field-1",
    kind: "public-input",
    role: "text-field",
    windowId: "window-1",
  },
  type: "focus.changed",
});

describe("project automatic zoom operation", () => {
  test("binds immutable recording and sync identities before mapping metadata", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "atet-auto-zoom-operation-"));
    try {
      const fixture = await createOperationProjectFixture(repositoryRoot);
      const manifest = testManifest();
      const project = VideoProjectV1Schema.parse({
        ...fixture.project,
        assets: fixture.project.assets.map(asset => ({
          ...asset,
          source: {
            kind: "recording",
            recordingId: manifest.recordingId,
            trackIds: ["track_display01", "track_system01"],
          },
        })),
      });
      await saveVideoProject(fixture.fileSystem, project);
      await saveProjectEditPlan(
        fixture.fileSystem,
        createDefaultProjectEditPlan(
          project,
          fixture.plan.planId,
          fixture.plan.createdAt,
        ),
      );
      const recordingDirectory = join(
        repositoryRoot,
        "artifacts",
        "atet",
        "recordings",
        manifest.recordingId,
      );
      await mkdir(recordingDirectory, { recursive: true });
      await saveRecordingManifest(
        createNodeBundleFileSystem(recordingDirectory),
        manifest,
      );

      const application = operationApplicationContext(repositoryRoot);
      const exactInput = await bindProjectAutoZoomInput(application, {
        project: project.projectId,
      });
      if (exactInput.binding === undefined) {
        throw new TypeError("Expected a host-bound project automatic zoom input.");
      }
      expect(exactInput.binding).toMatchObject({
        recordingId: manifest.recordingId,
        sourcePlacementId: project.referencePlacementId,
      });
      const sibling = ProjectAnalysisReferenceSchema.parse({
        analysisId: "analysis_autozoomsibling01",
        audioStreams: 1,
        createdAt: OPERATION_TEST_LATER.toISOString(),
        displayStreams: 1,
        kind: "inactivity",
        path: "analysis/inactivity/analysis_autozoomsibling01.json",
        projectStructureSha256: hashProjectStructure(project),
        recommendedRanges: 0,
        sha256: OPERATION_TEST_HASH,
      });
      await saveVideoProject(fixture.fileSystem, VideoProjectV1Schema.parse({
        ...project,
        analyses: [sibling],
        updatedAt: OPERATION_TEST_LATER.toISOString(),
      }));
      const snapshot = await openProjectSnapshot(
        application.paths.projectRoot,
        project.projectId,
      );
      const registry = new OperationRegistry();
      registry.register(createProjectAutoZoomOperationDefinition({
        loadEvents: () => Promise.resolve([windowSnapshot, focus]),
      }));
      const result = await registry.execute({
        abortSignal: new AbortController().signal,
        application,
        expectedProjectGeneration: snapshot.generation.generationSha256,
      }, {
        input: exactInput,
        kind: "analysis.project-auto-zooms",
        version: 1,
      });
      const output = ProjectAutoZoomOutputSchema.parse(result.output);
      expect(output.operations).toHaveLength(1);
      expect(output.operations[0]).toMatchObject({
        operation: {
          range: { endUs: 2_000_000, startUs: 500_000 },
          reason: "focus",
        },
        placementId: project.referencePlacementId,
      });
      expect(output.recordingManifestSha256).toBe(
        exactInput.binding.recordingManifestSha256,
      );
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });
});
