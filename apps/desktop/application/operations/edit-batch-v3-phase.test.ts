import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  OverlayOperationSchema,
  ProjectZoomOperationSchema,
  VideoProjectV1Schema,
  type ProjectEditPlanV1,
} from "../../contracts";
import {
  loadProjectEditPlan,
  saveVideoProject,
} from "../../core";
import { createApplicationOperationRegistry } from "../default-registry";
import { ApplicationError } from "../errors";
import type { OperationExecutionContext } from "../operation";
import { openProjectSnapshot } from "../project-store";
import type { OperationRegistry } from "../registry";
import {
  ManualProjectCameraMoveInputV2Schema,
  ProjectEditBatchInputV3Schema,
  ProjectEditBatchV2Schema,
  ProjectEditBatchV3Schema,
} from "./derive/edit-batch";
import {
  OPERATION_TEST_HASH,
  OPERATION_TEST_LATER,
  createOperationProjectFixture,
  operationApplicationContext,
} from "./test-support";

type BatchVersion = 2 | 3;

function executionContext(repositoryRoot: string): OperationExecutionContext {
  return {
    abortSignal: new AbortController().signal,
    application: operationApplicationContext(repositoryRoot, {
      now: OPERATION_TEST_LATER,
    }),
  };
}

async function commitBatch(
  registry: OperationRegistry,
  repositoryRoot: string,
  projectId: string,
  version: BatchVersion,
  ordered: readonly unknown[],
): Promise<void> {
  const context = executionContext(repositoryRoot);
  if (version === 2) {
    const derived = await registry.execute(context, {
      input: { ordered },
      kind: "derive.edit-batch",
      version: 2,
    });
    const snapshot = await openProjectSnapshot(
      context.application.paths.projectRoot,
      projectId,
    );
    await registry.execute(context, {
      input: {
        basis: snapshot.editBasis,
        batch: ProjectEditBatchV2Schema.parse(derived.output),
        project: projectId,
      },
      kind: "project.commit-edits",
      version: 2,
    });
    return;
  }

  const derived = await registry.execute(context, {
    input: { ordered },
    kind: "derive.edit-batch",
    version: 3,
  });
  const snapshot = await openProjectSnapshot(
    context.application.paths.projectRoot,
    projectId,
  );
  await registry.execute(context, {
    input: {
      basis: snapshot.editBasis,
      batch: ProjectEditBatchV3Schema.parse(derived.output),
      project: projectId,
    },
    kind: "project.commit-edits",
    version: 3,
  });
}

function preparedImageOverlay(
  overlayId: string,
  startUs: number,
  endUs: number,
) {
  return OverlayOperationSchema.parse({
    anchor: "center",
    entrance: { kind: "none" },
    exit: { kind: "none" },
    intrinsicSize: { height: 64, width: 64 },
    opacity: 1,
    overlayId,
    position: { x: 0, y: 0 },
    range: { endUs, startUs },
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
    zIndex: 1,
  });
}

function preparedZoom(
  zoomId: string,
  startUs: number,
  endUs: number,
) {
  return ProjectZoomOperationSchema.parse({
    operation: {
      displayId: "display-primary",
      easing: { kind: "ease-in-out" },
      enterDurationUs: 100_000,
      exitDurationUs: 100_000,
      kind: "manual",
      range: { endUs, startUs },
      scale: 2,
      target: {
        kind: "point",
        point: { x: 960, y: 540 },
      },
      zoomId,
    },
    placementId: "placement_operation01",
  });
}

function preparedCameraMove(
  cameraMoveId: string,
  startUs: number,
  endUs: number,
) {
  return ManualProjectCameraMoveInputV2Schema.parse({
    cameraMoveId,
    keyframes: [{
      outgoingEasing: { kind: "ease-in-out" },
      pose: {
        centerX: 0.5,
        centerY: 0.5,
        space: "prepared-video-layer-normalized-v1",
        zoom: 2,
      },
      projectTimeUs: startUs,
    }, {
      outgoingEasing: { kind: "linear" },
      pose: {
        centerX: 0.6,
        centerY: 0.5,
        space: "prepared-video-layer-normalized-v1",
        zoom: 2,
      },
      projectTimeUs: endUs,
    }],
    placementId: "placement_operation01",
    projectRange: { endUs, startUs },
    streamId: "stream_operation01",
  });
}

interface PhaseEntityScenario {
  readonly add: Readonly<Record<string, unknown>>;
  readonly ids: (plan: ProjectEditPlanV1) => readonly string[];
  readonly name: string;
  readonly remove: Readonly<Record<string, unknown>>;
}

const phaseEntities: readonly PhaseEntityScenario[] = [
  {
    add: {
      kind: "add-overlays",
      overlays: [
        preparedImageOverlay(
          "overlay_phaseboundary01",
          1_200_000,
          1_800_000,
        ),
      ],
    },
    ids: plan => plan.overlays.map(overlay => String(overlay.overlayId)),
    name: "overlay",
    remove: {
      kind: "remove-overlays",
      overlayIds: ["overlay_phaseboundary01"],
    },
  },
  {
    add: {
      kind: "add-zooms",
      zooms: [
        preparedZoom("zoom_phaseboundary01", 1_200_000, 1_800_000),
      ],
    },
    ids: plan => plan.zooms.map(zoom => String(zoom.operation.zoomId)),
    name: "zoom",
    remove: {
      kind: "remove-zooms",
      zoomIds: ["zoom_phaseboundary01"],
    },
  },
  {
    add: {
      cameraMoves: [
        preparedCameraMove(
          "camera_phaseboundary01",
          1_200_000,
          1_800_000,
        ),
      ],
      kind: "add-manual-camera-moves",
    },
    ids: plan => plan.cameraMoves.map(move => String(move.cameraMoveId)),
    name: "camera move",
    remove: {
      cameraMoveIds: ["camera_phaseboundary01"],
      kind: "remove-camera-moves",
    },
  },
];

async function runPhaseTransition(
  version: BatchVersion,
  scenario: PhaseEntityScenario,
  transition: "add" | "remove",
): Promise<{
  readonly errorCode: ApplicationError["code"] | undefined;
  readonly plan: ProjectEditPlanV1;
}> {
  const repositoryRoot = await mkdtemp(
    join(tmpdir(), `transmute-v${version}-phase-parity-`),
  );
  try {
    const fixture = await createOperationProjectFixture(repositoryRoot);
    const registry = createApplicationOperationRegistry();
    await commitBatch(
      registry,
      repositoryRoot,
      fixture.project.projectId,
      version,
      [scenario.add],
    );
    const caught = await commitBatch(
      registry,
      repositoryRoot,
      fixture.project.projectId,
      version,
      [{
        kind: "cut",
        range: { endUs: 2_000_000, startUs: 1_000_000 },
      }, transition === "add" ? scenario.add : scenario.remove],
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    if (caught !== undefined && !(caught instanceof ApplicationError)) {
      if (caught instanceof Error) throw caught;
      throw new TypeError("Project edit rejected with a non-error value.");
    }
    return {
      errorCode: caught?.code,
      plan: await loadProjectEditPlan(fixture.fileSystem),
    };
  } finally {
    await rm(repositoryRoot, { force: true, recursive: true });
  }
}

function alternatingPhases(
  count: number,
  first: "remove" | "structural",
): readonly unknown[] {
  return Array.from({ length: count }, (_, index) => {
    const structural = (index % 2 === 0) === (first === "structural");
    return structural
      ? {
          kind: "cut",
          range: { endUs: index + 2, startUs: index + 1 },
        }
      : {
          kind: "remove-zooms",
          zoomIds: [
            `zoom_phase${String(index).padStart(8, "0")}`,
          ],
        };
  });
}

describe("project edit batch v3 normalization phases", () => {
  for (const scenario of phaseEntities) {
    test(
      `matches v2 ${scenario.name} semantics across structural/add and structural/remove boundaries`,
      async () => {
        for (const transition of ["add", "remove"] as const) {
          const [v2, v3] = await Promise.all([
            runPhaseTransition(2, scenario, transition),
            runPhaseTransition(3, scenario, transition),
          ]);
          const label = `${scenario.name} structural/${transition}`;
          expect(v3.errorCode, label).toBe(v2.errorCode);
          expect(v3.plan, label).toEqual(v2.plan);
          if (transition === "add") {
            expect(v3.errorCode, label).toBeUndefined();
            expect(scenario.ids(v3.plan), label).toEqual([]);
            expect(v3.plan.keep, label).toEqual([
              { endUs: 1_000_000, startUs: 0 },
              { endUs: 10_000_000, startUs: 2_000_000 },
            ]);
          } else {
            expect(v3.errorCode, label).toBe("not-found");
            expect(scenario.ids(v3.plan), label).toHaveLength(1);
            expect(v3.plan.keep, label).toEqual([
              { endUs: 10_000_000, startUs: 0 },
            ]);
          }
        }
      },
      30_000,
    );
  }

  test("rejects stale project structure before applying either v2 or v3 edits", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "transmute-edit-batch-stale-structure-"),
    );
    try {
      const fixture = await createOperationProjectFixture(repositoryRoot);
      const registry = createApplicationOperationRegistry();
      await saveVideoProject(fixture.fileSystem, VideoProjectV1Schema.parse({
        ...fixture.project,
        placements: fixture.project.placements.map(placement => ({
          ...placement,
          video: placement.video.map(video => ({
            ...video,
            presentation: {
              ...video.presentation,
              opacity: 0.75,
            },
          })),
        })),
      }));

      for (const version of [2, 3] as const) {
        const caught = await commitBatch(
          registry,
          repositoryRoot,
          fixture.project.projectId,
          version,
          [{
            kind: "cut",
            range: { endUs: 2_000_000, startUs: 1_000_000 },
          }],
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(caught, `v${version}`).toBeInstanceOf(ApplicationError);
        if (!(caught instanceof ApplicationError)) {
          throw new TypeError(`Expected v${version} to reject stale structure.`);
        }
        expect(caught.code, `v${version}`).toBe("invalid-data");
        expect(caught.message, `v${version}`).toMatch(/structure/u);
      }
      expect(await loadProjectEditPlan(fixture.fileSystem)).toEqual(
        fixture.plan,
      );
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("accepts at most 64 authored normalization phases", () => {
    expect(ProjectEditBatchInputV3Schema.safeParse({
      ordered: alternatingPhases(64, "structural"),
    }).success).toBe(true);
    expect(ProjectEditBatchInputV3Schema.safeParse({
      ordered: alternatingPhases(65, "structural"),
    }).success).toBe(false);
  });

  test("counts prepended cut ranges as a leading structural phase", () => {
    const cutRanges = [{ endUs: 1, startUs: 0 }];
    expect(ProjectEditBatchInputV3Schema.safeParse({
      cutRanges,
      ordered: alternatingPhases(63, "remove"),
    }).success).toBe(true);
    expect(ProjectEditBatchInputV3Schema.safeParse({
      cutRanges,
      ordered: alternatingPhases(64, "remove"),
    }).success).toBe(false);
  });
});
