import {
  lstat,
  mkdir,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";

import {
  RepositoryRelativePathSchema,
  VideoProjectIdSchema,
} from "../contracts";
import { sha256Hex } from "../core/canonical-json";
import { withMutationLock } from "../cli/mutation-lock";
import type { ApplicationContext } from "./context";
import { ApplicationError } from "./errors";

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

async function withInProcessOutputQueue<Value>(
  key: string,
  execute: () => Promise<Value>,
): Promise<Value> {
  const previous = inProcessOutputTails.get(key) ?? Promise.resolve();
  const result = previous.then(execute);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  inProcessOutputTails.set(key, settled);
  try {
    return await result;
  } finally {
    if (inProcessOutputTails.get(key) === settled) {
      inProcessOutputTails.delete(key);
    }
  }
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
  const lease = await leaseDirectory(application, target);
  return await withInProcessOutputQueue(lease.directory, async () =>
    await withMutationLock(lease.directory, {
      command: "workflow:render.project",
      label: `${lease.projectId}/${lease.outputPath}`,
      now: application.clock.now,
    }, execute));
}
