import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ProjectZoomOperationSchema,
  RecordingManifestV1Schema,
  VideoProjectV1Schema,
  type RecordingManifestV1,
  type VideoProjectV1,
} from "../../contracts";
import {
  createDefaultProjectEditPlan,
  loadProjectEditPlan,
  saveProjectEditPlan,
  saveRecordingManifest,
  saveVideoProject,
} from "../../core";
import { testManifest } from "../../core/test-support";
import { createApplicationOperationRegistry } from "../default-registry";
import type { OperationExecutionContext } from "../operation";
import { openProjectSnapshot } from "../project-store";
import type { OperationRegistry } from "../registry";
import {
  ProjectEditBatchSchema,
  ProjectEditBatchV2Schema,
  ManualProjectCameraMoveInputV2Schema,
  OrderedProjectEditV2Schema,
  type OrderedProjectEditV2,
  type ProjectEditBatch,
  type ProjectEditBatchV2,
} from "./derive/edit-batch";
import {
  bindProjectCommitEditsInputV2,
} from "./project/commit-edits";
import {
  OPERATION_TEST_LATER,
  createOperationProjectFixture,
  createOperationRecordingProjectFixture,
  operationApplicationContext,
} from "./test-support";

function executionContext(repositoryRoot: string): OperationExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    application: operationApplicationContext(repositoryRoot, {
      now: OPERATION_TEST_LATER,
    }),
  };
}

async function deriveV2(
  registry: OperationRegistry,
  repositoryRoot: string,
  ordered: readonly unknown[],
): Promise<ProjectEditBatchV2> {
  const result = await registry.execute(executionContext(repositoryRoot), {
    input: { ordered },
    kind: "derive.edit-batch",
    version: 2,
  });
  return ProjectEditBatchV2Schema.parse(result.output);
}

async function commitV2(
  registry: OperationRegistry,
  repositoryRoot: string,
  projectId: string,
  batch: ProjectEditBatchV2,
): Promise<void> {
  const context = executionContext(repositoryRoot);
  const snapshot = await openProjectSnapshot(
    context.application.paths.projectRoot,
    projectId,
  );
  await registry.execute(context, {
    input: {
      basis: snapshot.editBasis,
      batch,
      project: projectId,
    },
    kind: "project.commit-edits",
    version: 2,
  });
}

function zoom(
  zoomId: string,
  startUs: number,
  endUs: number,
) {
  return ProjectZoomOperationSchema.parse({
    operation: {
      displayId: "display-primary",
      easing: { kind: "ease-in-out" as const },
      enterDurationUs: 100_000,
      exitDurationUs: 100_000,
      kind: "manual" as const,
      range: { endUs, startUs },
      scale: 2,
      target: {
        kind: "point" as const,
        point: { x: 960, y: 540 },
      },
      zoomId,
    },
    placementId: "placement_operation01",
  });
}

function cameraMove(
  cameraMoveId: string,
  startUs: number,
  endUs: number,
) {
  return ManualProjectCameraMoveInputV2Schema.parse({
    cameraMoveId,
    keyframes: [{
      outgoingEasing: { kind: "ease-in-out" as const },
      pose: {
        centerX: 0.5,
        centerY: 0.5,
        space: "prepared-video-layer-normalized-v1" as const,
        zoom: 2,
      },
      projectTimeUs: startUs,
    }, {
      outgoingEasing: { kind: "linear" as const },
      pose: {
        centerX: 0.6,
        centerY: 0.5,
        space: "prepared-video-layer-normalized-v1" as const,
        zoom: 2,
      },
      projectTimeUs: endUs,
    }],
    placementId: "placement_operation01",
    projectRange: { endUs, startUs },
    streamId: "stream_operation01",
  });
}

function enabledMetadataEdit(): Extract<
  OrderedProjectEditV2,
  { readonly kind: "set-metadata-effects" }
> {
  const parsed = OrderedProjectEditV2Schema.parse({
    clicks: {
      color: "#ffcc00cc",
      durationUs: 350_000,
      enabled: true,
      radiusPx: 28,
      style: "pulse",
    },
    cursor: {
      enabled: true,
      scale: 1,
      smoothing: { algorithm: "exponential", strength: 0.7 },
      style: "captured",
    },
    keystrokes: {
      enabled: true,
      holdUs: 1_200_000,
      maxKeys: 8,
      position: "bottom-right",
      secureText: "hide",
    },
    kind: "set-metadata-effects",
    metadataPlacementId: "placement_operation01",
    typedText: {
      enabled: true,
      idleTimeoutUs: 1_000_000,
      maxCharacters: 160,
      placement: "input",
      secureText: "hide",
    },
  });
  if (parsed.kind !== "set-metadata-effects") {
    throw new Error("Metadata edit parser changed its discriminant.");
  }
  return parsed;
}

function metadataEditWith(
  effect: "cursor" | "keystrokes" | "typedText",
): Extract<
  OrderedProjectEditV2,
  { readonly kind: "set-metadata-effects" }
> {
  const disabled = {
    clicks: { enabled: false as const },
    cursor: { enabled: false as const },
    keystrokes: { enabled: false as const },
    kind: "set-metadata-effects" as const,
    metadataPlacementId: "placement_operation01",
    typedText: { enabled: false as const },
  };
  if (effect === "cursor") {
    const parsed = OrderedProjectEditV2Schema.parse({
      ...disabled,
      cursor: {
        enabled: true,
        scale: 1,
        smoothing: { algorithm: "none", strength: 0 },
        style: "captured",
      },
    });
    if (parsed.kind !== "set-metadata-effects") {
      throw new Error("Metadata edit parser changed its discriminant.");
    }
    return parsed;
  }
  if (effect === "keystrokes") {
    const parsed = OrderedProjectEditV2Schema.parse({
      ...disabled,
      keystrokes: {
        enabled: true,
        holdUs: 1_000_000,
        maxKeys: 8,
        position: "bottom-right",
        secureText: "hide",
      },
    });
    if (parsed.kind !== "set-metadata-effects") {
      throw new Error("Metadata edit parser changed its discriminant.");
    }
    return parsed;
  }
  const parsed = OrderedProjectEditV2Schema.parse({
    ...disabled,
    typedText: {
      enabled: true,
      idleTimeoutUs: 1_000_000,
      maxCharacters: 160,
      placement: "input",
      secureText: "hide",
    },
  });
  if (parsed.kind !== "set-metadata-effects") {
    throw new Error("Metadata edit parser changed its discriminant.");
  }
  return parsed;
}

describe("project edit batch v2", () => {
  test("rejects duplicate state transitions during pure derivation", () => {
    const registry = createApplicationOperationRegistry();
    const context = executionContext("/tmp/transmute-edit-batch-v2-schema");
    expect(registry.execute(context, {
      input: {
        ordered: [{
          kind: "remove-zooms",
          zoomIds: ["zoom_duplicate01"],
        }, {
          kind: "remove-zooms",
          zoomIds: ["zoom_duplicate01"],
        }],
      },
      kind: "derive.edit-batch",
      version: 2,
    })).rejects.toThrow(/remove the same zoom ID twice/u);
    expect(registry.execute(context, {
      input: {
        ordered: [{
          cameraMoves: [
            cameraMove("camera_duplicate01", 1_000_000, 2_000_000),
          ],
          kind: "add-manual-camera-moves",
        }, {
          cameraMoves: [
            cameraMove("camera_duplicate01", 3_000_000, 4_000_000),
          ],
          kind: "add-manual-camera-moves",
        }],
      },
      kind: "derive.edit-batch",
      version: 2,
    })).rejects.toThrow(/add the same camera move ID twice/u);
    const metadata = enabledMetadataEdit();
    expect(registry.execute(context, {
      input: {
        ordered: [metadata, metadata],
      },
      kind: "derive.edit-batch",
      version: 2,
    })).rejects.toThrow(/replace metadata effects only once/u);
  });

  test("applies replacement and transient camera/zoom transitions atomically", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "transmute-edit-batch-v2-camera-"),
    );
    try {
      const fixture = await createOperationProjectFixture(repositoryRoot);
      const registry = createApplicationOperationRegistry();
      const seed = await deriveV2(registry, repositoryRoot, [{
        kind: "add-zooms",
        zooms: [zoom("zoom_replace01", 1_000_000, 2_000_000)],
      }, {
        cameraMoves: [
          cameraMove("camera_replace01", 1_000_000, 3_000_000),
        ],
        kind: "add-manual-camera-moves",
      }]);
      await commitV2(
        registry,
        repositoryRoot,
        fixture.project.projectId,
        seed,
      );
      const seeded = await loadProjectEditPlan(fixture.fileSystem);
      expect(seeded.zooms).toHaveLength(1);
      expect(seeded.cameraMoves).toHaveLength(1);
      expect(seeded.cameraMoves[0]).toMatchObject({
        cameraMoveId: "camera_replace01",
        origin: { kind: "manual" },
      });
      expect(seeded.cameraMoves[0]?.binding.geometrySha256).toHaveLength(64);
      expect(seeded.cameraMoves[0]?.binding.syncSha256).toHaveLength(64);

      const transitions = await deriveV2(registry, repositoryRoot, [{
        kind: "remove-zooms",
        zoomIds: ["zoom_replace01"],
      }, {
        kind: "add-zooms",
        zooms: [zoom("zoom_replace01", 2_000_000, 3_000_000)],
      }, {
        kind: "add-zooms",
        zooms: [zoom("zoom_transient01", 4_000_000, 5_000_000)],
      }, {
        kind: "remove-zooms",
        zoomIds: ["zoom_transient01"],
      }, {
        cameraMoveIds: ["camera_replace01"],
        kind: "remove-camera-moves",
      }, {
        cameraMoves: [
          cameraMove("camera_replace01", 1_000_000, 3_000_000),
        ],
        kind: "add-manual-camera-moves",
      }, {
        cameraMoves: [
          cameraMove("camera_transient01", 4_000_000, 6_000_000),
        ],
        kind: "add-manual-camera-moves",
      }, {
        cameraMoveIds: ["camera_transient01"],
        kind: "remove-camera-moves",
      }]);
      await commitV2(
        registry,
        repositoryRoot,
        fixture.project.projectId,
        transitions,
      );
      const replaced = await loadProjectEditPlan(fixture.fileSystem);
      expect(replaced.zooms.map(item => String(item.operation.zoomId))).toEqual([
        "zoom_replace01",
      ]);
      expect(replaced.zooms[0]?.operation.range).toEqual({
        endUs: 3_000_000,
        startUs: 2_000_000,
      });
      expect(replaced.cameraMoves.map(move => String(move.cameraMoveId))).toEqual([
        "camera_replace01",
      ]);

      const beforeFailure = replaced;
      const invalid = await deriveV2(registry, repositoryRoot, [{
        kind: "add-zooms",
        zooms: [zoom("zoom_atomic001", 6_000_000, 7_000_000)],
      }, {
        cameraMoves: [
          cameraMove("camera_atomic001", 6_000_000, 8_000_000),
        ],
        kind: "add-manual-camera-moves",
      }, {
        cameraMoveIds: ["camera_missing01"],
        kind: "remove-camera-moves",
      }]);
      expect(commitV2(
        registry,
        repositoryRoot,
        fixture.project.projectId,
        invalid,
      )).rejects.toMatchObject({ code: "not-found" });
      expect(await loadProjectEditPlan(fixture.fileSystem)).toEqual(
        beforeFailure,
      );

      const missingZoom = await deriveV2(registry, repositoryRoot, [{
        kind: "remove-zooms",
        zoomIds: ["zoom_missing01"],
      }]);
      expect(commitV2(
        registry,
        repositoryRoot,
        fixture.project.projectId,
        missingZoom,
      )).rejects.toMatchObject({ code: "not-found" });
      expect(await loadProjectEditPlan(fixture.fileSystem)).toEqual(
        beforeFailure,
      );

      const unknownLayer = await deriveV2(registry, repositoryRoot, [{
        cameraMoves: [{
          ...cameraMove("camera_unknown01", 6_000_000, 8_000_000),
          streamId: "stream_unknown01",
        }],
        kind: "add-manual-camera-moves",
      }]);
      expect(commitV2(
        registry,
        repositoryRoot,
        fixture.project.projectId,
        unknownLayer,
      )).rejects.toMatchObject({ code: "not-found" });
      expect(await loadProjectEditPlan(fixture.fileSystem)).toEqual(
        beforeFailure,
      );

      const disabledProject = VideoProjectV1Schema.parse({
        ...fixture.project,
        placements: fixture.project.placements.map(placement => ({
          ...placement,
          video: placement.video.map(video => ({
            ...video,
            presentation: { enabled: false },
          })),
        })),
      });
      const disabledPlan = createDefaultProjectEditPlan(
        disabledProject,
        fixture.plan.planId,
        OPERATION_TEST_LATER.toISOString(),
      );
      await Promise.all([
        saveProjectEditPlan(fixture.fileSystem, disabledPlan),
        saveVideoProject(fixture.fileSystem, disabledProject),
      ]);
      const disabledLayer = await deriveV2(registry, repositoryRoot, [{
        cameraMoves: [
          cameraMove("camera_disabled01", 1_000_000, 3_000_000),
        ],
        kind: "add-manual-camera-moves",
      }]);
      expect(commitV2(
        registry,
        repositoryRoot,
        fixture.project.projectId,
        disabledLayer,
      )).rejects.toMatchObject({ code: "conflict" });
      expect(await loadProjectEditPlan(fixture.fileSystem)).toEqual(
        disabledPlan,
      );
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("fails closed without a metadata binding, then commits the bound manifest", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "transmute-edit-batch-v2-metadata-"),
    );
    try {
      const fixture = await createOperationRecordingProjectFixture(
        repositoryRoot,
      );
      const registry = createApplicationOperationRegistry();
      const batch = await deriveV2(
        registry,
        repositoryRoot,
        [enabledMetadataEdit()],
      );
      const snapshot = await openProjectSnapshot(
        fixture.projectRoot,
        fixture.project.projectId,
      );
      const application = operationApplicationContext(repositoryRoot);
      const unbound = {
        basis: snapshot.editBasis,
        batch,
        project: fixture.project.projectId,
      };
      expect(registry.execute(executionContext(repositoryRoot), {
        input: unbound,
        kind: "project.commit-edits",
        version: 2,
      })).rejects.toMatchObject({ code: "incompatible" });
      expect(await loadProjectEditPlan(fixture.fileSystem)).toEqual(
        fixture.plan,
      );

      const bound = await bindProjectCommitEditsInputV2(application, unbound);
      expect(bound.metadataBinding).toMatchObject({
        placementId: "placement_operation01",
        recordingId: fixture.manifest.recordingId,
      });
      expect(bound.metadataBinding?.manifestSha256).toHaveLength(64);
      await registry.execute(executionContext(repositoryRoot), {
        input: bound,
        kind: "project.commit-edits",
        version: 2,
      });
      const expectedMetadata = enabledMetadataEdit();
      const expectedEffects = {
        clicks: expectedMetadata.clicks,
        cursor: expectedMetadata.cursor,
        keystrokes: expectedMetadata.keystrokes,
        metadataPlacementId: expectedMetadata.metadataPlacementId,
        typedText: expectedMetadata.typedText,
      };
      expect((await loadProjectEditPlan(fixture.fileSystem)).effects)
        .toEqual(expectedEffects);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("rejects manifest drift without publishing a partial plan", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "transmute-edit-batch-v2-drift-"),
    );
    try {
      const fixture = await createOperationRecordingProjectFixture(
        repositoryRoot,
      );
      const registry = createApplicationOperationRegistry();
      const batch = await deriveV2(
        registry,
        repositoryRoot,
        [metadataEditWith("cursor")],
      );
      const snapshot = await openProjectSnapshot(
        fixture.projectRoot,
        fixture.project.projectId,
      );
      const bound = await bindProjectCommitEditsInputV2(
        operationApplicationContext(repositoryRoot),
        {
          basis: snapshot.editBasis,
          batch,
          project: fixture.project.projectId,
        },
      );
      await saveRecordingManifest(fixture.recordingFileSystem, {
        ...fixture.manifest,
        updatedAt: OPERATION_TEST_LATER.toISOString(),
      });
      expect(registry.execute(executionContext(repositoryRoot), {
        input: bound,
        kind: "project.commit-edits",
        version: 2,
      })).rejects.toMatchObject({ code: "conflict" });
      expect(await loadProjectEditPlan(fixture.fileSystem)).toEqual(
        fixture.plan,
      );
      expect(
        fixture.fileSystem.readText("state/project-transaction.json"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("rejects disabled, unverified, or unauthorized metadata sources", async () => {
    const baseManifest = RecordingManifestV1Schema.parse({
      ...testManifest(),
      capture: {
        ...testManifest().capture,
        typedText: "enabled",
      },
    });
    const cases: readonly {
      readonly effect: "cursor" | "keystrokes" | "typedText";
      readonly manifest?: (manifest: RecordingManifestV1) => RecordingManifestV1;
      readonly name: string;
      readonly project?: (project: VideoProjectV1) => VideoProjectV1;
    }[] = [{
      effect: "cursor",
      name: "disabled placement",
      project: project => VideoProjectV1Schema.parse({
        ...project,
        placements: project.placements.map(placement => ({
          ...placement,
          enabled: false,
        })),
      }),
    }, {
      effect: "cursor",
      name: "unverified placement synchronization",
      project: project => VideoProjectV1Schema.parse({
        ...project,
        placements: project.placements.map(placement => ({
          ...placement,
          sync: {
            ...placement.sync,
            provenance: {
              kind: "unverified",
              reason: "initial-placement",
            },
          },
        })),
      }),
    }, {
      effect: "cursor",
      manifest: manifest => RecordingManifestV1Schema.parse({
        ...manifest,
        capture: { ...manifest.capture, cursor: "disabled" },
      }),
      name: "disabled interaction metadata capture",
    }, {
      effect: "keystrokes",
      manifest: manifest => RecordingManifestV1Schema.parse({
        ...manifest,
        permissions: {
          ...manifest.permissions,
          inputMonitoring: "denied",
        },
      }),
      name: "denied input monitoring",
    }, {
      effect: "typedText",
      manifest: manifest => RecordingManifestV1Schema.parse({
        ...manifest,
        permissions: {
          ...manifest.permissions,
          accessibility: "denied",
        },
      }),
      name: "denied accessibility",
    }, {
      effect: "typedText",
      manifest: manifest => RecordingManifestV1Schema.parse({
        ...manifest,
        capture: { ...manifest.capture, typedText: "disabled" },
      }),
      name: "disabled typed-text capture",
    }, {
      effect: "cursor",
      manifest: manifest => RecordingManifestV1Schema.parse({
        ...manifest,
        state: "recording",
      }),
      name: "active mutable recording",
    }];

    for (const testCase of cases) {
      const repositoryRoot = await mkdtemp(
        join(tmpdir(), "transmute-edit-batch-v2-capability-"),
      );
      try {
        const fixture = await createOperationRecordingProjectFixture(
          repositoryRoot,
          {
            manifest: testCase.manifest?.(baseManifest) ?? baseManifest,
            ...(testCase.project === undefined
              ? {}
              : { project: testCase.project }),
          },
        );
        const registry = createApplicationOperationRegistry();
        const batch = await deriveV2(
          registry,
          repositoryRoot,
          [metadataEditWith(testCase.effect)],
        );
        const snapshot = await openProjectSnapshot(
          fixture.projectRoot,
          fixture.project.projectId,
        );
        expect(bindProjectCommitEditsInputV2(
          operationApplicationContext(repositoryRoot),
          {
            basis: snapshot.editBasis,
            batch,
            project: fixture.project.projectId,
          },
        ), testCase.name).rejects.toMatchObject({ code: "conflict" });
        expect(await loadProjectEditPlan(fixture.fileSystem)).toEqual(
          fixture.plan,
        );
      } finally {
        await rm(repositoryRoot, { force: true, recursive: true });
      }
    }
  });

  test("clears metadata effects without loading a recording manifest", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "transmute-edit-batch-v2-clear-metadata-"),
    );
    try {
      const fixture = await createOperationProjectFixture(repositoryRoot);
      const registry = createApplicationOperationRegistry();
      const batch = await deriveV2(registry, repositoryRoot, [{
        clicks: { enabled: false },
        cursor: { enabled: false },
        keystrokes: { enabled: false },
        kind: "set-metadata-effects",
        metadataPlacementId: null,
        typedText: { enabled: false },
      }]);
      await commitV2(
        registry,
        repositoryRoot,
        fixture.project.projectId,
        batch,
      );
      expect((await loadProjectEditPlan(fixture.fileSystem)).effects).toEqual({
        clicks: { enabled: false },
        cursor: { enabled: false },
        keystrokes: { enabled: false },
        metadataPlacementId: null,
        typedText: { enabled: false },
      });
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("keeps persisted v1 derive and commit operations runnable", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "transmute-edit-batch-v1-compatibility-"),
    );
    try {
      const fixture = await createOperationProjectFixture(repositoryRoot);
      const registry = createApplicationOperationRegistry();
      const derived = await registry.execute(executionContext(repositoryRoot), {
        input: {
          ordered: [{
            kind: "cut",
            range: { endUs: 2_000_000, startUs: 1_000_000 },
          }],
        },
        kind: "derive.edit-batch",
        version: 1,
      });
      const batch: ProjectEditBatch = ProjectEditBatchSchema.parse(
        derived.output,
      );
      const snapshot = await openProjectSnapshot(
        fixture.projectRoot,
        fixture.project.projectId,
      );
      await registry.execute(executionContext(repositoryRoot), {
        input: {
          basis: snapshot.editBasis,
          batch,
          project: fixture.project.projectId,
        },
        kind: "project.commit-edits",
        version: 1,
      });
      expect((await loadProjectEditPlan(fixture.fileSystem)).keep).toEqual([
        { endUs: 1_000_000, startUs: 0 },
        { endUs: 10_000_000, startUs: 2_000_000 },
      ]);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });
});
