import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  VideoProjectV1Schema,
  ZoomIdSchema,
  type VideoProjectV1,
} from "../../contracts";
import { loadProjectEditPlan } from "../../core";
import { createApplicationOperationRegistry } from "../default-registry";
import type { OperationExecutionContext } from "../operation";
import { openProjectSnapshot } from "../project-store";
import {
  deriveProjectEditBatchV3,
} from "./derive/edit-batch";
import {
  bindProjectCommitEditsInputV3,
} from "./project/commit-edits";
import {
  createOperationRecordingProjectFixture,
  operationApplicationContext,
} from "./test-support";

const MAXIMUM_BATCH_ZOOMS = 10_000;
const MAXIMUM_SYNC_ANCHORS = 4_096;
const REPRESENTATIVE_COMMIT_ZOOMS = 512;

function executionContext(repositoryRoot: string): OperationExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    application: operationApplicationContext(repositoryRoot),
  };
}

function maximumSyncRecordingProject(
  project: VideoProjectV1,
): VideoProjectV1 {
  const durationUs = project.timeline.durationUs;
  const anchors = Array.from(
    { length: MAXIMUM_SYNC_ANCHORS },
    (_, index) => {
      const timeUs = Math.floor(
        index * durationUs / (MAXIMUM_SYNC_ANCHORS - 1),
      );
      return {
        assetTimeUs: timeUs,
        projectTimeUs: timeUs,
      };
    },
  );
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
      sync: {
        anchors,
        provenance: { kind: "manual" },
      },
      video: placement.video.map(configured => ({
        ...configured,
        streamId: "stream_display01",
      })),
    })),
  });
}

test("host-binds the maximum cached zoom batch and commits a coalesced sample", async () => {
  const repositoryRoot = await mkdtemp(join(
    tmpdir(),
    "transmute-edit-batch-v3-scale-",
  ));
  try {
    const fixture = await createOperationRecordingProjectFixture(
      repositoryRoot,
      { project: maximumSyncRecordingProject },
    );
    const batch = deriveProjectEditBatchV3(Array.from(
      { length: MAXIMUM_BATCH_ZOOMS },
      (_, index) => ({
        kind: "add-manual-zooms" as const,
        zooms: [{
          easing: { kind: "linear" as const },
          enterDurationUs: 0,
          exitDurationUs: 0,
          range: { endUs: index + 2, startUs: index + 1 },
          scale: 2,
          target: {
            kind: "point" as const,
            point: { x: 960, y: 540 },
          },
          zoomId: ZoomIdSchema.parse(
            `zoom_scale${String(index).padStart(8, "0")}`,
          ),
        }],
      }),
    ));
    const snapshot = await openProjectSnapshot(
      fixture.projectRoot,
      fixture.project.projectId,
    );
    const cacheMisses: string[] = [];
    const bound = await bindProjectCommitEditsInputV3(
      operationApplicationContext(repositoryRoot),
      {
        basis: snapshot.editBasis,
        batch,
        project: fixture.project.projectId,
      },
      {
        onResolutionCacheMiss: (kind, key) => {
          cacheMisses.push(`${kind}:${key}`);
        },
      },
    );
    const bindings = bound.manualZoomBindings ?? [];
    expect(bindings).toHaveLength(MAXIMUM_BATCH_ZOOMS);
    expect(new Set(
      bindings.map(binding => binding.manifestSha256),
    ).size).toBe(1);
    expect(new Set(
      bindings.map(binding => binding.syncSha256),
    ).size).toBe(1);
    expect(new Set(
      bindings.map(binding => binding.displayId),
    )).toEqual(new Set(["display-primary"]));
    expect(cacheMisses.filter(
      miss => miss.startsWith("recording:"),
    )).toHaveLength(1);
    expect(cacheMisses.filter(
      miss => miss.startsWith("display-layer:"),
    )).toHaveLength(1);
    expect(cacheMisses.filter(
      miss => miss.startsWith("synchronization:"),
    )).toHaveLength(1);

    const commitBatch = deriveProjectEditBatchV3(
      batch.ordered.slice(0, REPRESENTATIVE_COMMIT_ZOOMS),
    );
    const commitInput = await bindProjectCommitEditsInputV3(
      operationApplicationContext(repositoryRoot),
      {
        basis: snapshot.editBasis,
        batch: commitBatch,
        project: fixture.project.projectId,
      },
    );
    await createApplicationOperationRegistry().execute(
      executionContext(repositoryRoot),
      {
        input: commitInput,
        kind: "project.commit-edits",
        version: 3,
      },
    );
    expect(
      (await loadProjectEditPlan(fixture.fileSystem)).zooms,
    ).toHaveLength(REPRESENTATIVE_COMMIT_ZOOMS);
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
}, 90_000);
