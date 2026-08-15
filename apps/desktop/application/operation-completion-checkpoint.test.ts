import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import type { OperationExecutionContext } from "./operation";
import {
  OPERATION_COMPLETION_CHECKPOINT_FILE,
  readOperationCompletionCheckpoint,
  writeOperationCompletionCheckpoint,
  type OperationCheckpointExecutionIdentity,
} from "./operation-completion-checkpoint";
import { operationApplicationContext } from "./operations/test-support";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root =>
    await rm(root, { force: true, recursive: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "atet-operation-checkpoint-"));
  roots.push(root);
  const application = operationApplicationContext(root);
  const workspaceDirectory = join(
    application.paths.privateRoot,
    "workflow-runs",
    "run_checkpoint",
  );
  await mkdir(workspaceDirectory, { mode: 0o700, recursive: true });
  let publicationChecks = 0;
  const identity = {
    inputSchemaId: "studio.operation.media.color-grade.input/v1",
    kind: "media.color-grade",
    nodeKey: "polish/grade",
    nodePlanSha256: "a".repeat(64),
    outputSchemaId: "studio.operation.media.color-grade.output/v1",
    runId: "run_checkpoint",
    version: 1,
  } satisfies OperationCheckpointExecutionIdentity;
  const context = {
    abortSignal: new AbortController().signal,
    application,
    workflow: {
      beforePublication: () => {
        publicationChecks += 1;
        return Promise.resolve();
      },
      nodeKey: identity.nodeKey,
      nodePlanSha256: identity.nodePlanSha256,
      runId: identity.runId,
      workspaceDirectory,
    },
  } satisfies OperationExecutionContext;
  return {
    context,
    identity,
    publicationChecks: () => publicationChecks,
    workspaceDirectory,
  };
}

describe("operation completion checkpoints", () => {
  test("durably binds canonical output to the exact run, node, and plan", async () => {
    const value = await fixture();
    const output = { artifact: { bytes: 4, path: "media/out.mp4" } };
    await writeOperationCompletionCheckpoint(value.context, {
      inputSchemaId: value.identity.inputSchemaId,
      kind: value.identity.kind,
      outputSchemaId: value.identity.outputSchemaId,
      version: value.identity.version,
    }, output);
    const checkpoint = await readOperationCompletionCheckpoint({
      expected: value.identity,
      privateRoot: value.context.application.paths.privateRoot,
      workspaceDirectory: value.workspaceDirectory,
    });
    expect(checkpoint?.output).toEqual(output);
    expect(checkpoint?.outputSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(checkpoint?.kind).toBe("atet.workflow-operation-completion");
    expect(value.publicationChecks()).toBe(1);

    await writeOperationCompletionCheckpoint(value.context, {
      inputSchemaId: value.identity.inputSchemaId,
      kind: value.identity.kind,
      outputSchemaId: value.identity.outputSchemaId,
      version: value.identity.version,
    }, output);
    expect(value.publicationChecks()).toBe(2);

    const path = join(
      value.workspaceDirectory,
      OPERATION_COMPLETION_CHECKPOINT_FILE,
    );
    const legacySource = (await readFile(path, "utf8")).replace(
      "atet.workflow-operation-completion",
      "studio.workflow-operation-completion",
    );
    await writeFile(path, legacySource, { mode: 0o600 });
    expect((await readOperationCompletionCheckpoint({
      expected: value.identity,
      privateRoot: value.context.application.paths.privateRoot,
      workspaceDirectory: value.workspaceDirectory,
    }))?.kind).toBe("studio.workflow-operation-completion");
  });

  test("distinguishes no publication from tampered or mismatched evidence", async () => {
    const value = await fixture();
    expect(await readOperationCompletionCheckpoint({
      expected: value.identity,
      privateRoot: value.context.application.paths.privateRoot,
      workspaceDirectory: value.workspaceDirectory,
    })).toBeNull();

    await writeOperationCompletionCheckpoint(value.context, {
      inputSchemaId: value.identity.inputSchemaId,
      kind: value.identity.kind,
      outputSchemaId: value.identity.outputSchemaId,
      version: value.identity.version,
    }, { completed: true });
    const path = join(
      value.workspaceDirectory,
      OPERATION_COMPLETION_CHECKPOINT_FILE,
    );
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      output: unknown;
    };
    parsed.output = { completed: false };
    await writeFile(path, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
    expect(readOperationCompletionCheckpoint({
      expected: value.identity,
      privateRoot: value.context.application.paths.privateRoot,
      workspaceDirectory: value.workspaceDirectory,
    })).rejects.toThrow();

    const other = await fixture();
    await writeOperationCompletionCheckpoint(other.context, {
      inputSchemaId: other.identity.inputSchemaId,
      kind: other.identity.kind,
      outputSchemaId: other.identity.outputSchemaId,
      version: other.identity.version,
    }, { completed: true });
    expect(readOperationCompletionCheckpoint({
      expected: {
        ...other.identity,
        nodePlanSha256: "b".repeat(64),
      },
      privateRoot: other.context.application.paths.privateRoot,
      workspaceDirectory: other.workspaceDirectory,
    })).rejects.toMatchObject({ code: "conflict" });
  });
});
