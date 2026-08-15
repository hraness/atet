import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RecordingManifestV1Schema,
  VideoProjectV1Schema,
  type RecordingManifestV1,
  type VideoProjectV1,
} from "../../contracts";
import {
  compileProjectRenderPlan,
  loadProjectEditPlan,
  saveRecordingManifest,
} from "../../core";
import { testManifest } from "../../core/test-support";
import { createApplicationOperationRegistry } from "../default-registry";
import { ApplicationError } from "../errors";
import type { OperationExecutionContext } from "../operation";
import { openProjectSnapshot } from "../project-store";
import type { OperationRegistry } from "../registry";
import {
  ProjectEditBatchV3Schema,
  type ProjectEditBatchV3,
} from "./derive/edit-batch";
import {
  bindProjectCommitEditsInputV3,
} from "./project/commit-edits";
import {
  OPERATION_TEST_LATER,
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

async function deriveV3(
  registry: OperationRegistry,
  repositoryRoot: string,
  ordered: readonly unknown[],
): Promise<ProjectEditBatchV3> {
  const result = await registry.execute(executionContext(repositoryRoot), {
    input: { ordered },
    kind: "derive.edit-batch",
    version: 3,
  });
  return ProjectEditBatchV3Schema.parse(result.output);
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

function allRecordingLayersProject(project: VideoProjectV1): VideoProjectV1 {
  const primary = recordingLayerProject(project);
  return VideoProjectV1Schema.parse({
    ...primary,
    assets: primary.assets.map(asset => {
      const video = asset.streams.find(stream => stream.kind === "video");
      return {
        ...asset,
        streams: video === undefined
          ? asset.streams
          : [
              ...asset.streams,
              {
                ...video,
                label: "Left display",
                streamId: "stream_display02",
              },
            ],
      };
    }),
    placements: primary.placements.map(placement => ({
      ...placement,
      video: placement.video.flatMap(configured => [
        configured,
        {
          ...configured,
          presentation: configured.presentation.enabled
            ? {
                ...configured.presentation,
                layer: configured.presentation.layer + 1,
              }
            : configured.presentation,
          streamId: "stream_display02",
        },
      ]),
    })),
  });
}

function secondaryAmbiguousRecordingProject(
  project: VideoProjectV1,
): VideoProjectV1 {
  const layers = allRecordingLayersProject(project);
  return VideoProjectV1Schema.parse({
    ...layers,
    assets: layers.assets.map(asset => {
      const secondary = asset.streams.find(
        stream => stream.streamId === "stream_display02",
      );
      return {
        ...asset,
        streams: secondary === undefined
          ? asset.streams
          : [
              ...asset.streams,
              {
                ...secondary,
                label: "Duplicate left display",
                streamId: "stream_display03",
              },
            ],
      };
    }),
    placements: layers.placements.map(placement => {
      const secondary = placement.video.find(
        configured => configured.streamId === "stream_display02",
      );
      return {
        ...placement,
        video: secondary === undefined
          ? placement.video
          : [
              ...placement.video,
              {
                ...secondary,
                presentation: secondary.presentation.enabled
                  ? {
                      ...secondary.presentation,
                      layer: secondary.presentation.layer + 1,
                    }
                  : secondary.presentation,
                streamId: "stream_display03",
              },
            ],
      };
    }),
  });
}

function secondaryAmbiguousManifest(): RecordingManifestV1 {
  const manifest = testManifest();
  const secondary = manifest.tracks.find(
    track => track.trackId === "track_display02",
  );
  if (secondary?.kind !== "display-video") {
    throw new TypeError("Expected the secondary display fixture track.");
  }
  return RecordingManifestV1Schema.parse({
    ...manifest,
    tracks: [
      ...manifest.tracks,
      {
        ...secondary,
        label: "Duplicate left display",
        segments: secondary.segments.map(segment => ({
          ...segment,
          containerTrackIdentity: {
            containerTrackId: "4",
            kind: "verified",
          },
          path: "media/segment-left-duplicate.mp4",
          segmentId: "segment_video003",
        })),
        trackId: "track_display03",
      },
    ],
  });
}

function manualZoom(
  zoomId = "zoom_manual001",
  range = { endUs: 4_000_000, startUs: 2_000_000 },
) {
  return {
    easing: { kind: "ease-in-out" as const },
    enterDurationUs: 300_000,
    exitDurationUs: 300_000,
    range,
    scale: 2,
    target: {
      kind: "point" as const,
      point: { x: 960, y: 540 },
    },
    zoomId,
  };
}

describe("project edit batch v3 manual zooms", () => {
  test("registers an additive v3 union without changing the v2 schema", async () => {
    const registry = createApplicationOperationRegistry();
    const repositoryRoot = "/tmp/atet-edit-batch-v3-schema";
    const batch = await deriveV3(registry, repositoryRoot, [{
      kind: "add-manual-zooms",
      zooms: [manualZoom()],
    }]);
    expect(batch.schemaVersion).toBe(3);
    expect(batch.ordered[0]).toMatchObject({
      kind: "add-manual-zooms",
      zooms: [{ zoomId: "zoom_manual001" }],
    });
    expect(registry.execute(executionContext(repositoryRoot), {
      input: {
        ordered: [{
          kind: "add-manual-zooms",
          zooms: [manualZoom()],
        }],
      },
      kind: "derive.edit-batch",
      version: 2,
    })).rejects.toThrow();
    expect(deriveV3(registry, repositoryRoot, [{
      kind: "add-manual-zooms",
      zooms: [manualZoom()],
    }, {
      kind: "add-manual-zooms",
      zooms: [manualZoom()],
    }])).rejects.toThrow(/add the same zoom ID twice/u);
  });

  test("host-binds default placement/display identity and commits persisted zooms", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "atet-edit-batch-v3-manual-zoom-"),
    );
    try {
      const fixture = await createOperationRecordingProjectFixture(
        repositoryRoot,
        { project: allRecordingLayersProject },
      );
      const registry = createApplicationOperationRegistry();
      const batch = await deriveV3(registry, repositoryRoot, [{
        kind: "add-manual-zooms",
        zooms: [
          manualZoom(),
          {
            ...manualZoom(
              "zoom_manual002",
              { endUs: 7_000_000, startUs: 5_000_000 },
            ),
            displayId: "display-left",
            placementId: fixture.project.referencePlacementId,
            target: {
              kind: "point",
              point: { x: -640, y: 512 },
            },
          },
        ],
      }]);
      const snapshot = await openProjectSnapshot(
        fixture.projectRoot,
        fixture.project.projectId,
      );
      const unbound = {
        basis: snapshot.editBasis,
        batch,
        project: fixture.project.projectId,
      };
      expect(registry.execute(executionContext(repositoryRoot), {
        input: unbound,
        kind: "project.commit-edits",
        version: 3,
      })).rejects.toMatchObject({ code: "incompatible" });
      const bound = await bindProjectCommitEditsInputV3(
        operationApplicationContext(repositoryRoot),
        unbound,
      );
      expect(bound.manualZoomBindings).toHaveLength(2);
      const binding = bound.manualZoomBindings?.[0];
      const leftBinding = bound.manualZoomBindings?.[1];
      if (binding === undefined) {
        throw new TypeError("Expected one host-owned manual zoom binding.");
      }
      if (leftBinding === undefined) {
        throw new TypeError("Expected an explicit secondary-display binding.");
      }
      expect({
        displayId: binding.displayId,
        placementId: String(binding.placementId),
        recordingId: String(binding.recordingId),
        zoomId: String(binding.zoomId),
      }).toEqual({
        displayId: "display-primary",
        placementId: "placement_operation01",
        recordingId: fixture.manifest.recordingId,
        zoomId: "zoom_manual001",
      });
      expect(binding.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(binding.syncSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect({
        displayId: leftBinding.displayId,
        placementId: String(leftBinding.placementId),
        recordingId: String(leftBinding.recordingId),
        zoomId: String(leftBinding.zoomId),
      }).toEqual({
        displayId: "display-left",
        placementId: "placement_operation01",
        recordingId: fixture.manifest.recordingId,
        zoomId: "zoom_manual002",
      });
      expect(leftBinding.manifestSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(leftBinding.syncSha256).toMatch(/^[a-f0-9]{64}$/u);
      await registry.execute(executionContext(repositoryRoot), {
        input: bound,
        kind: "project.commit-edits",
        version: 3,
      });
      const committedZooms = (
        await loadProjectEditPlan(fixture.fileSystem)
      ).zooms.map(zoom => ({
        ...zoom,
        operation: {
          ...zoom.operation,
          zoomId: String(zoom.operation.zoomId),
        },
        placementId: String(zoom.placementId),
      }));
      expect(committedZooms).toEqual([
        {
          operation: {
            displayId: "display-primary",
            easing: { kind: "ease-in-out" },
            enterDurationUs: 300_000,
            exitDurationUs: 300_000,
            kind: "manual",
            range: { endUs: 4_000_000, startUs: 2_000_000 },
            scale: 2,
            target: { kind: "point", point: { x: 960, y: 540 } },
            zoomId: "zoom_manual001",
          },
          placementId: "placement_operation01",
        },
        {
          operation: {
            displayId: "display-left",
            easing: { kind: "ease-in-out" },
            enterDurationUs: 300_000,
            exitDurationUs: 300_000,
            kind: "manual",
            range: { endUs: 7_000_000, startUs: 5_000_000 },
            scale: 2,
            target: { kind: "point", point: { x: -640, y: 512 } },
            zoomId: "zoom_manual002",
          },
          placementId: "placement_operation01",
        },
      ]);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("requires one exact binding per zoom and rejects manifest drift atomically", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "atet-edit-batch-v3-manual-zoom-drift-"),
    );
    try {
      const fixture = await createOperationRecordingProjectFixture(
        repositoryRoot,
        { project: recordingLayerProject },
      );
      const registry = createApplicationOperationRegistry();
      const batch = await deriveV3(registry, repositoryRoot, [{
        kind: "add-manual-zooms",
        zooms: [manualZoom()],
      }]);
      const snapshot = await openProjectSnapshot(
        fixture.projectRoot,
        fixture.project.projectId,
      );
      const unbound = {
        basis: snapshot.editBasis,
        batch,
        project: fixture.project.projectId,
      };
      const bound = await bindProjectCommitEditsInputV3(
        operationApplicationContext(repositoryRoot),
        unbound,
      );
      expect(registry.execute(executionContext(repositoryRoot), {
        input: { ...bound, manualZoomBindings: [] },
        kind: "project.commit-edits",
        version: 3,
      })).rejects.toMatchObject({ code: "incompatible" });
      expect(registry.execute(executionContext(repositoryRoot), {
        input: {
          ...bound,
          manualZoomBindings: [
            ...bound.manualZoomBindings ?? [],
            {
              ...bound.manualZoomBindings?.[0],
              zoomId: "zoom_unexpected01",
            },
          ],
        },
        kind: "project.commit-edits",
        version: 3,
      })).rejects.toMatchObject({ code: "incompatible" });
      let finalGateCalls = 0;
      expect(registry.execute({
        abortSignal: new AbortController().signal,
        application: operationApplicationContext(repositoryRoot),
        workflow: {
          beforePublication: () => {
            finalGateCalls += 1;
            return finalGateCalls === 2
              ? Promise.reject(new ApplicationError(
                  "cancelled",
                  "Final publication fence was released.",
                ))
              : Promise.resolve();
          },
          nodeKey: "commit",
          nodePlanSha256: "a".repeat(64),
          runId: "run_manualzoomfinalfence01",
          workspaceDirectory: repositoryRoot,
        },
      }, {
        input: bound,
        kind: "project.commit-edits",
        version: 3,
      })).rejects.toMatchObject({ code: "cancelled" });
      expect(finalGateCalls).toBe(2);
      expect(await loadProjectEditPlan(fixture.fileSystem)).toEqual(
        fixture.plan,
      );
      expect(
        fixture.fileSystem.readText("state/project-transaction.json"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(registry.execute({
        abortSignal: new AbortController().signal,
        application: operationApplicationContext(repositoryRoot),
        workflow: {
          beforePublication: async () => {
            await saveRecordingManifest(fixture.recordingFileSystem, {
              ...fixture.manifest,
              updatedAt: OPERATION_TEST_LATER.toISOString(),
            });
          },
          nodeKey: "commit",
          nodePlanSha256: "b".repeat(64),
          runId: "run_manualzoomdrift01",
          workspaceDirectory: repositoryRoot,
        },
      }, {
        input: bound,
        kind: "project.commit-edits",
        version: 3,
      })).rejects.toMatchObject({ code: "conflict" });
      expect(await loadProjectEditPlan(fixture.fileSystem)).toEqual(
        fixture.plan,
      );
      expect(
        fixture.fileSystem.readText("state/project-transaction.json"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      let staleGateCalls = 0;
      expect(registry.execute({
        abortSignal: new AbortController().signal,
        application: operationApplicationContext(repositoryRoot),
        workflow: {
          beforePublication: () => {
            staleGateCalls += 1;
            return Promise.resolve();
          },
          nodeKey: "commit",
          nodePlanSha256: "c".repeat(64),
          runId: "run_manualzoomstale01",
          workspaceDirectory: repositoryRoot,
        },
      }, {
        input: bound,
        kind: "project.commit-edits",
        version: 3,
      })).rejects.toMatchObject({ code: "conflict" });
      expect(staleGateCalls).toBe(0);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("commits and renders a selected unique display despite unrelated secondary ambiguity", async () => {
    const repositoryRoot = await mkdtemp(join(
      tmpdir(),
      "atet-edit-batch-v3-unrelated-display-",
    ));
    try {
      const fixture = await createOperationRecordingProjectFixture(
        repositoryRoot,
        {
          manifest: secondaryAmbiguousManifest(),
          project: secondaryAmbiguousRecordingProject,
        },
      );
      const registry = createApplicationOperationRegistry();
      const batch = await deriveV3(registry, repositoryRoot, [{
        kind: "add-manual-zooms",
        zooms: [manualZoom()],
      }]);
      const snapshot = await openProjectSnapshot(
        fixture.projectRoot,
        fixture.project.projectId,
      );
      const bound = await bindProjectCommitEditsInputV3(
        operationApplicationContext(repositoryRoot),
        {
          basis: snapshot.editBasis,
          batch,
          project: fixture.project.projectId,
        },
      );
      await registry.execute(executionContext(repositoryRoot), {
        input: bound,
        kind: "project.commit-edits",
        version: 3,
      });
      const renderPlan = compileProjectRenderPlan(
        fixture.project,
        await loadProjectEditPlan(fixture.fileSystem),
        {
          frameRate: 60,
          metadata: [{
            events: [],
            manifest: fixture.manifest,
            placementId: fixture.project.referencePlacementId,
          }],
          pixelHeight: 1_080,
          pixelWidth: 1_920,
        },
      );
      expect(new Set(
        renderPlan.cameraKeyframes.map(keyframe => String(keyframe.streamId)),
      )).toEqual(new Set(["stream_display01"]));
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("rejects ranges outside the project timeline or placement sync coverage", async () => {
    const cases: readonly {
      readonly name: string;
      readonly project?: (project: VideoProjectV1) => VideoProjectV1;
      readonly range: { readonly endUs: number; readonly startUs: number };
    }[] = [{
      name: "project timeline",
      range: { endUs: 11_000_000, startUs: 9_000_000 },
    }, {
      name: "placement sync coverage",
      project: project => VideoProjectV1Schema.parse({
        ...recordingLayerProject(project),
        placements: recordingLayerProject(project).placements.map(
          placement => ({
            ...placement,
            assetRange: { endUs: 5_000_000, startUs: 0 },
            sync: {
              anchors: [
                { assetTimeUs: 0, projectTimeUs: 0 },
                { assetTimeUs: 5_000_000, projectTimeUs: 5_000_000 },
              ],
              provenance: { kind: "identity" },
            },
          }),
        ),
      }),
      range: { endUs: 6_000_000, startUs: 4_000_000 },
    }];
    for (const testCase of cases) {
      const repositoryRoot = await mkdtemp(
        join(tmpdir(), "atet-edit-batch-v3-manual-zoom-range-"),
      );
      try {
        const fixture = await createOperationRecordingProjectFixture(
          repositoryRoot,
          {
            project: project => testCase.project?.(project)
              ?? recordingLayerProject(project),
          },
        );
        const registry = createApplicationOperationRegistry();
        const batch = await deriveV3(registry, repositoryRoot, [{
          kind: "add-manual-zooms",
          zooms: [manualZoom("zoom_range0001", testCase.range)],
        }]);
        const snapshot = await openProjectSnapshot(
          fixture.projectRoot,
          fixture.project.projectId,
        );
        expect(bindProjectCommitEditsInputV3(
          operationApplicationContext(repositoryRoot),
          {
            basis: snapshot.editBasis,
            batch,
            project: fixture.project.projectId,
          },
        ), testCase.name).rejects.toMatchObject({
          code: testCase.name === "project timeline"
            ? "invalid-data"
            : "conflict",
        });
      } finally {
        await rm(repositoryRoot, { force: true, recursive: true });
      }
    }
  });

  test("rejects unsafe display, metadata, recording, and placement selectors", async () => {
    const disabledCursor = RecordingManifestV1Schema.parse({
      ...testManifest(),
      capture: {
        ...testManifest().capture,
        cursor: "disabled",
      },
    });
    const disabledWindows = RecordingManifestV1Schema.parse({
      ...testManifest(),
      capture: {
        ...testManifest().capture,
        windowMetadata: "disabled",
      },
    });
    const deniedAccessibility = RecordingManifestV1Schema.parse({
      ...testManifest(),
      permissions: {
        ...testManifest().permissions,
        accessibility: "denied",
      },
    });
    const mutableRecording = RecordingManifestV1Schema.parse({
      ...testManifest(),
      state: "recording",
    });
    const ambiguousDisplayTracks = RecordingManifestV1Schema.parse({
      ...testManifest(),
      tracks: testManifest().tracks.map(track => (
        track.trackId === "track_display02"
          ? {
              ...track,
              source: { displayId: "display-primary" },
            }
          : track
      )),
    });
    const cases: readonly {
      readonly code?: "conflict" | "invalid-data";
      readonly manifest?: RecordingManifestV1;
      readonly name: string;
      readonly project?: (project: VideoProjectV1) => VideoProjectV1;
      readonly zoom: unknown;
    }[] = [{
      name: "missing display layer",
      zoom: {
        ...manualZoom("zoom_missingdisplay01"),
        displayId: "display-missing",
      },
    }, {
      code: "invalid-data",
      name: "point outside selected display",
      zoom: {
        ...manualZoom("zoom_outsidepoint01"),
        target: {
          kind: "point",
          point: { x: 1_000_000, y: 1_000_000 },
        },
      },
    }, {
      code: "invalid-data",
      name: "rectangle cropped out of selected display",
      project: project => {
        const recording = recordingLayerProject(project);
        return VideoProjectV1Schema.parse({
          ...recording,
          placements: recording.placements.map(placement => ({
            ...placement,
            video: placement.video.map(configured => ({
              ...configured,
              presentation: configured.presentation.enabled
                ? {
                    ...configured.presentation,
                    crop: {
                      bottom: 0,
                      kind: "normalized-insets",
                      left: 0.5,
                      right: 0,
                      top: 0,
                    },
                  }
                : configured.presentation,
            })),
          })),
        });
      },
      zoom: {
        ...manualZoom("zoom_croppedrect01"),
        target: {
          kind: "rect",
          rect: { height: 100, width: 100, x: 0, y: 0 },
        },
      },
    }, {
      manifest: ambiguousDisplayTracks,
      name: "ambiguous same-display recording tracks",
      project: allRecordingLayersProject,
      zoom: manualZoom("zoom_ambiguoustrack01"),
    }, {
      manifest: disabledCursor,
      name: "cursor capture",
      zoom: {
        ...manualZoom("zoom_cursorcapture01"),
        target: { kind: "cursor", sampling: "interpolated" },
      },
    }, {
      manifest: disabledWindows,
      name: "window capture",
      zoom: {
        ...manualZoom("zoom_windowcapture01"),
        target: {
          kind: "window",
          paddingPx: 24,
          selector: { kind: "frontmost" },
        },
      },
    }, {
      manifest: deniedAccessibility,
      name: "focused input accessibility",
      zoom: {
        ...manualZoom("zoom_focusedinput01"),
        target: { kind: "focused-input", paddingPx: 24 },
      },
    }, {
      manifest: mutableRecording,
      name: "mutable recording",
      zoom: manualZoom("zoom_mutablerecording01"),
    }, {
      name: "disabled placement",
      project: project => VideoProjectV1Schema.parse({
        ...recordingLayerProject(project),
        placements: recordingLayerProject(project).placements.map(
          placement => ({ ...placement, enabled: false }),
        ),
      }),
      zoom: manualZoom("zoom_disabledplace01"),
    }, {
      name: "unverified placement synchronization",
      project: project => VideoProjectV1Schema.parse({
        ...recordingLayerProject(project),
        placements: recordingLayerProject(project).placements.map(
          placement => ({
            ...placement,
            sync: {
              ...placement.sync,
              provenance: {
                kind: "unverified",
                reason: "insufficient-evidence",
              },
            },
          }),
        ),
      }),
      zoom: manualZoom("zoom_unverifiedsync01"),
    }];
    for (const testCase of cases) {
      const repositoryRoot = await mkdtemp(
        join(tmpdir(), "atet-edit-batch-v3-manual-zoom-selector-"),
      );
      try {
        const fixture = await createOperationRecordingProjectFixture(
          repositoryRoot,
          {
            ...(testCase.manifest === undefined
              ? {}
              : { manifest: testCase.manifest }),
            project: project => testCase.project?.(project)
              ?? recordingLayerProject(project),
          },
        );
        const registry = createApplicationOperationRegistry();
        const batch = await deriveV3(registry, repositoryRoot, [{
          kind: "add-manual-zooms",
          zooms: [testCase.zoom],
        }]);
        const snapshot = await openProjectSnapshot(
          fixture.projectRoot,
          fixture.project.projectId,
        );
        expect(bindProjectCommitEditsInputV3(
          operationApplicationContext(repositoryRoot),
          {
            basis: snapshot.editBasis,
            batch,
            project: fixture.project.projectId,
          },
        ), testCase.name).rejects.toMatchObject({
          code: testCase.code ?? "conflict",
        });
        expect(await loadProjectEditPlan(fixture.fileSystem)).toEqual(
          fixture.plan,
        );
      } finally {
        await rm(repositoryRoot, { force: true, recursive: true });
      }
    }
  });
});
