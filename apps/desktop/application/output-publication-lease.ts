import {
  lstat,
  mkdir,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";

import {
  RepositoryRelativePathSchema,
  VideoProjectIdSchema,
} from "../contracts";
import { sha256Hex } from "../core/canonical-json";
import { acquireMutationLease, type MutationLease } from "../cli/mutation-lock";
import type { ApplicationContext } from "./context";
import { ApplicationError } from "./errors";
import { operationBoundary, operationFinally, operationResource, type OperationEffectFailure } from "./operation-effects";

const OUTPUT_LEASE_ROOT = "output-publication-leases";
const inProcessOutputTails = new Map<string, Promise<void>>();

export interface OutputPublicationTarget {
  readonly outputPath: string;
  readonly projectId: string;
}

async function privatePhysicalDirectory(
  path: string,
  create: boolean,
): Promise<string> {
  if (create) await mkdir(path, { mode: 0o700, recursive: true });
  const details = await lstat(path);
  if (
    details.isSymbolicLink()
    || !details.isDirectory()
    || (details.mode & 0o077) !== 0
  ) {
    throw new ApplicationError(
      "unsafe-path",
      `Output publication lease state must be a private physical directory: ${path}`,
    );
  }
  return await realpath(path);
}

async function leaseDirectory(
  application: ApplicationContext,
  target: OutputPublicationTarget,
): Promise<{
  readonly directory: string;
  readonly outputPath: string;
  readonly projectId: string;
}> {
  const projectId = VideoProjectIdSchema.parse(target.projectId);
  const outputPath = RepositoryRelativePathSchema.parse(target.outputPath);
  if (!outputPath.startsWith("renders/")) {
    throw new ApplicationError(
      "unsafe-path",
      "Workflow render outputs must remain beneath the project renders directory.",
    );
  }
  const privateRoot = await privatePhysicalDirectory(
    application.paths.privateRoot,
    true,
  );
  const rootPath = join(privateRoot, OUTPUT_LEASE_ROOT);
  await mkdir(rootPath, { mode: 0o700, recursive: true });
  const root = await privatePhysicalDirectory(rootPath, false);
  const key = sha256Hex(
    `studio.output-publication-lease/v1\0${projectId}\0${outputPath}`,
  );
  const requestedDirectory = join(root, key);
  await mkdir(requestedDirectory, { mode: 0o700, recursive: true });
  return {
    directory: await privatePhysicalDirectory(requestedDirectory, false),
    outputPath,
    projectId,
  };
}

function reserveOutputTurn(key: string): { readonly ready: Promise<void>; release(): void } {
  const previous = inProcessOutputTails.get(key) ?? Promise.resolve();
  const { promise: settled, resolve: complete } = Promise.withResolvers<void>();
  inProcessOutputTails.set(key, settled);
  let released = false;
  return {
    ready: previous,
    release: () => {
      if (released) return;
      released = true;
      if (inProcessOutputTails.get(key) === settled) inProcessOutputTails.delete(key);
      complete();
    },
  };
}

interface OutputLease extends MutationLease {
  releaseTurn(): void;
}

async function acquireOutputLease(
  application: ApplicationContext,
  target: OutputPublicationTarget,
): Promise<OutputLease> {
  const targetLease = await leaseDirectory(application, target);
  // Promise and native Effect callers reserve in the same physical-key queue.
  const turn = reserveOutputTurn(targetLease.directory);
  await turn.ready;
  try {
    const lease = await acquireMutationLease(targetLease.directory, {
      command: "workflow:render.project",
      label: `${targetLease.projectId}/${targetLease.outputPath}`,
      now: application.clock.now,
    });
    return { ...lease, releaseTurn: turn.release };
  } catch (error) {
    turn.release();
    throw error;
  }
}

export function withOutputPublicationLeaseEffect<Value, R>(
  application: ApplicationContext,
  target: OutputPublicationTarget,
  use: Effect.Effect<Value, OperationEffectFailure, R>,
): Effect.Effect<Value, OperationEffectFailure, R> {
  return operationResource(
    operationBoundary("publication", () => acquireOutputLease(application, target)),
    () => use,
    lease => operationFinally(
      operationFinally(
        operationBoundary("cleanup", () => lease.close()),
        operationBoundary("cleanup", () => lease.unlinkIfOwned()),
      ),
      Effect.sync(() => lease.releaseTurn()),
    ),
  );
}

/**
 * Serializes only publication of one exact project output. Different output
 * paths retain scheduler and process-level concurrency.
 */
export async function withOutputPublicationLease<Value>(
  application: ApplicationContext,
  target: OutputPublicationTarget,
  execute: () => Promise<Value>,
): Promise<Value> {
  const lease = await acquireOutputLease(application, target);
  try {
    return await execute();
  } finally {
    try {
      await lease.close();
    } finally {
      try {
        await lease.unlinkIfOwned();
      } finally {
        lease.releaseTurn();
      }
    }
  }
}
