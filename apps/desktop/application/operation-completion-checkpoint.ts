import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  open,
  realpath,
  rm,
} from "node:fs/promises";
import {
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";

import { z } from "zod";

import { Sha256Schema } from "../contracts";
import {
  canonicalJson,
  sha256Hex,
} from "../core/canonical-json";
import { ensurePrivateDirectory } from "../cli/paths";
import { ApplicationError } from "./errors";
import type {
  OperationExecutionContext,
  OperationKind,
} from "./operation";

export const OPERATION_COMPLETION_CHECKPOINT_FILE =
  "operation-completion.v1.json";

const MAXIMUM_CHECKPOINT_BYTES = 65 * 1024 * 1024;
const OUTPUT_DIGEST_DOMAIN = "studio.workflow.operation-completion-output/v1";

const OperationCompletionCheckpointSchema = z.strictObject({
  identity: z.strictObject({
    inputSchemaId: z.string().min(1).max(256),
    kind: z.string().min(1).max(128),
    nodeKey: z.string().min(1).max(255).regex(
      /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*(?:\/[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*)*$/u,
    ),
    nodePlanSha256: Sha256Schema,
    outputSchemaId: z.string().min(1).max(256),
    runId: z.string().min(1).max(256),
    version: z.number().int().safe().positive(),
  }),
  kind: z.union([
    z.literal("atet.workflow-operation-completion"),
    z.literal("transmute.workflow-operation-completion"),
    z.literal("studio.workflow-operation-completion"),
  ]),
  output: z.unknown(),
  outputSha256: Sha256Schema,
  schemaVersion: z.literal(1),
}).superRefine((checkpoint, context) => {
  let digest: string;
  try {
    digest = operationCheckpointOutputSha256(checkpoint.output);
  } catch {
    context.addIssue({
      code: "custom",
      message: "Operation completion output must be canonical JSON.",
      path: ["output"],
    });
    return;
  }
  if (digest !== checkpoint.outputSha256) {
    context.addIssue({
      code: "custom",
      message: "Operation completion output digest does not match its payload.",
      path: ["outputSha256"],
    });
  }
});

export interface OperationCheckpointDefinitionIdentity {
  readonly inputSchemaId: string;
  readonly kind: OperationKind;
  readonly outputSchemaId: string;
  readonly version: number;
}

export interface OperationCheckpointExecutionIdentity
  extends OperationCheckpointDefinitionIdentity {
  readonly nodeKey: string;
  readonly nodePlanSha256: string;
  readonly runId: string;
}

export type OperationCompletionCheckpoint = z.infer<
  typeof OperationCompletionCheckpointSchema
>;

function operationCheckpointOutputSha256(output: unknown): string {
  return sha256Hex(
    `${OUTPUT_DIGEST_DOMAIN}\0${canonicalJson(output)}`,
  );
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === ""
    || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

async function physicalPrivateWorkspace(
  privateRootInput: string,
  workspaceInput: string,
): Promise<string> {
  await ensurePrivateDirectory(privateRootInput);
  const privateRoot = await realpath(resolve(privateRootInput));
  const workspace = resolve(workspaceInput);
  const details = await lstat(workspace).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new ApplicationError(
        "invalid-data",
        "Operation completion workspace does not exist.",
      );
    }
    throw error;
  });
  if (
    details.isSymbolicLink()
    || !details.isDirectory()
    || (details.mode & 0o077) !== 0
  ) {
    throw new ApplicationError(
      "unsafe-path",
      "Operation completion workspace must be a private physical directory.",
    );
  }
  const physical = await realpath(workspace);
  if (physical === privateRoot || !isWithin(privateRoot, physical)) {
    throw new ApplicationError(
      "unsafe-path",
      "Operation completion workspace escaped the application private root.",
    );
  }
  return physical;
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
  );
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function checkpointFor(
  identity: OperationCheckpointExecutionIdentity,
  output: unknown,
): OperationCompletionCheckpoint {
  return OperationCompletionCheckpointSchema.parse({
    identity,
    kind: "atet.workflow-operation-completion",
    output,
    outputSha256: operationCheckpointOutputSha256(output),
    schemaVersion: 1,
  });
}

async function readCheckpointFile(
  path: string,
): Promise<OperationCompletionCheckpoint | null> {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY
        | (constants.O_NOFOLLOW ?? 0)
        | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.nlink !== 1
      || before.size < 1
      || before.size > MAXIMUM_CHECKPOINT_BYTES
      || (before.mode & 0o077) !== 0
    ) {
      throw new ApplicationError(
        "invalid-data",
        "Operation completion checkpoint is unsafe or exceeds its size bound.",
      );
    }
    const text = await handle.readFile("utf8");
    const after = await handle.stat();
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
    ) {
      throw new ApplicationError(
        "conflict",
        "Operation completion checkpoint changed while it was being read.",
      );
    }
    let input: unknown;
    try {
      input = JSON.parse(text) as unknown;
    } catch {
      throw new ApplicationError(
        "invalid-data",
        "Operation completion checkpoint is not valid JSON.",
      );
    }
    const parsed = OperationCompletionCheckpointSchema.parse(input);
    if (`${canonicalJson(parsed)}\n` !== text) {
      throw new ApplicationError(
        "invalid-data",
        "Operation completion checkpoint is not canonical immutable JSON.",
      );
    }
    return parsed;
  } finally {
    await handle.close();
  }
}

function assertCheckpointIdentity(
  actual: OperationCompletionCheckpoint["identity"],
  expected: OperationCheckpointExecutionIdentity,
): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new ApplicationError(
      "conflict",
      "Operation completion checkpoint belongs to a different exact node plan.",
      {
        actualNodePlanSha256: actual.nodePlanSha256,
        expectedNodePlanSha256: expected.nodePlanSha256,
        nodeKey: expected.nodeKey,
      },
    );
  }
}

export async function writeOperationCompletionCheckpoint(
  context: OperationExecutionContext,
  definition: OperationCheckpointDefinitionIdentity,
  output: unknown,
): Promise<void> {
  const workflow = context.workflow;
  if (workflow === undefined) return;
  const workspace = await physicalPrivateWorkspace(
    context.application.paths.privateRoot,
    workflow.workspaceDirectory,
  );
  const checkpoint = checkpointFor({
    ...definition,
    nodeKey: workflow.nodeKey,
    nodePlanSha256: workflow.nodePlanSha256,
    runId: workflow.runId,
  }, output);
  const source = `${canonicalJson(checkpoint)}\n`;
  const bytes = new TextEncoder().encode(source);
  if (bytes.byteLength > MAXIMUM_CHECKPOINT_BYTES) {
    throw new ApplicationError(
      "invalid-data",
      "Operation completion checkpoint exceeds its size bound.",
    );
  }
  await workflow.beforePublication();
  const temporary = join(
    workspace,
    `.operation-completion-${randomUUID()}.json`,
  );
  const target = join(workspace, OPERATION_COMPLETION_CHECKPOINT_FILE);
  const handle = await open(
    temporary,
    constants.O_CREAT
      | constants.O_EXCL
      | constants.O_WRONLY
      | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    try {
      await link(temporary, target);
      await syncDirectory(workspace);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      const existing = await readCheckpointFile(target);
      if (
        existing === null
        || canonicalJson(existing) !== canonicalJson(checkpoint)
      ) {
        throw new ApplicationError(
          "conflict",
          "The exact node workspace already contains a different completion checkpoint.",
        );
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readOperationCompletionCheckpoint(options: {
  readonly expected: OperationCheckpointExecutionIdentity;
  readonly privateRoot: string;
  readonly workspaceDirectory: string;
}): Promise<OperationCompletionCheckpoint | null> {
  const workspace = await physicalPrivateWorkspace(
    options.privateRoot,
    options.workspaceDirectory,
  );
  const checkpoint = await readCheckpointFile(
    join(workspace, OPERATION_COMPLETION_CHECKPOINT_FILE),
  );
  if (checkpoint === null) return null;
  assertCheckpointIdentity(checkpoint.identity, options.expected);
  return checkpoint;
}
