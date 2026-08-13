import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadProjectEditPlan,
  saveProjectEditPlan,
} from "../../../core";
import { projectEditBasis } from "../../project-store";
import { ProjectEditCommitReceiptSchema } from "../../receipts";
import { OperationRegistry } from "../../registry";
import { deriveEditBatchOperationDefinition } from "../derive/edit-batch";
import { commitProjectEditsOperationDefinition } from "../project/commit-edits";
import {
  createOperationProjectFixture,
  operationApplicationContext,
} from "../test-support";
import {
  FreezeProjectEditRevisionOutputSchema,
  freezeProjectEditRevisionOperationDefinition,
} from "./freeze-revision";

describe("generic immutable project edit revisions", () => {
  test("binds independent output geometries without moving the current plan", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "transmute-freeze-revision-"),
    );
    try {
      const fixture = await createOperationProjectFixture(repositoryRoot);
      const basis = projectEditBasis(
        fixture.project,
        fixture.plan,
      );
      const registry = new OperationRegistry();
      registry.register(freezeProjectEditRevisionOperationDefinition);
      const context = {
        abortSignal: new AbortController().signal,
        application: operationApplicationContext(repositoryRoot),
      };
      const references = await Promise.all([
        [1_920, 1_080],
        [1_080, 1_080],
        [1_080, 1_920],
      ].map(async ([pixelWidth, pixelHeight]) => (
        FreezeProjectEditRevisionOutputSchema.parse((await registry.execute(
          context,
          {
            input: {
              basis,
              pixelHeight,
              pixelWidth,
              project: fixture.project.projectId,
            },
            kind: "edit.freeze-revision",
            version: 1,
          },
        )).output)
      )));

      expect(new Set(references.map(({ artifact }) => artifact.path)).size)
        .toBe(1);
      expect(new Set(references.map(
        ({ outputGeometrySha256 }) => outputGeometrySha256,
      )).size).toBe(3);
      expect(references.map(({ pixelHeight, pixelWidth }) => [
        pixelWidth,
        pixelHeight,
      ])).toEqual([
        [1_920, 1_080],
        [1_080, 1_080],
        [1_080, 1_920],
      ]);
      expect(await loadProjectEditPlan(fixture.fileSystem))
        .toEqual(fixture.plan);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  test("rejects dimensions that cannot produce yuv420p output", () => {
    expect(() => freezeProjectEditRevisionOperationDefinition.inputSchema
      .parse({
        pixelHeight: 1_079,
        pixelWidth: 1_920,
        project: "project_operation01",
      })).toThrow();
  });

  test("rejects project drift after a commit instead of freezing a later edit state", async () => {
    const repositoryRoot = await mkdtemp(
      join(tmpdir(), "transmute-freeze-commit-drift-"),
    );
    try {
      const fixture = await createOperationProjectFixture(repositoryRoot);
      const registry = new OperationRegistry();
      registry.register(deriveEditBatchOperationDefinition);
      registry.register(commitProjectEditsOperationDefinition);
      registry.register(freezeProjectEditRevisionOperationDefinition);
      const context = {
        abortSignal: new AbortController().signal,
        application: operationApplicationContext(repositoryRoot),
      };
      const batch = await registry.execute(context, {
        input: {
          ordered: [{
            kind: "cut",
            range: { endUs: 3_000_000, startUs: 2_000_000 },
          }],
        },
        kind: "derive.edit-batch",
        version: 1,
      });
      const committed = ProjectEditCommitReceiptSchema.parse((
        await registry.execute(context, {
          input: {
            basis: projectEditBasis(fixture.project, fixture.plan),
            batch: batch.output,
            project: fixture.project.projectId,
          },
          kind: "project.commit-edits",
          version: 1,
        })
      ).output);
      const current = await loadProjectEditPlan(fixture.fileSystem);
      await saveProjectEditPlan(fixture.fileSystem, {
        ...current,
        baseSpeed: 1.25,
      });

      expect(registry.execute(context, {
        input: {
          basis: committed.editBasis,
          pixelHeight: 1_080,
          pixelWidth: 1_920,
          project: fixture.project.projectId,
        },
        kind: "edit.freeze-revision",
        version: 1,
      })).rejects.toMatchObject({ code: "conflict" });
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });
});
