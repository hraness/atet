import type { ApplicationContext } from "./context";
import { ApplicationError } from "./errors";
import { createBoundedJsonValueSnapshot, deepFreezeJson } from "../../../src/code/json-snapshot";
import { SPATIAL_PROJECT_LIMITS, SpatialProjectHeadV2Schema } from "../contracts/spatial-project";
import { createNodeBundleFileSystem, type BundleFileSystem } from "../core/storage";
import { acquireMutationLease } from "../cli/mutation-lock";
import { assertProjectStateTransactionSettled, recoverProjectStateTransaction } from "../cli/project-state-transaction";
import { resolveProjectDirectory } from "../cli/project-service";

const queues = new Map<string, Promise<void>>();

/** Adapter-owned seams; never accepted in a serialized operation request. */
export interface SpatialProjectLeaseDependencies {
  readonly fileSystem?: (directory: string) => BundleFileSystem;
  readonly acquire?: typeof acquireMutationLease;
}

function spatialMarker(authority: unknown): boolean {
  return typeof authority === "object" && authority !== null && !Array.isArray(authority)
    && (("schemaVersion" in authority && authority.schemaVersion === 2)
      || ("kind" in authority && authority.kind === "atet.spatial-project-head"));
}

function completionEvidence(value: unknown): Readonly<Record<string, unknown>> {
  try {
    const completed = deepFreezeJson(createBoundedJsonValueSnapshot(value, SPATIAL_PROJECT_LIMITS.documentBytes,
      "spatial lease completion", { maximumDepth: 48, maximumValues: 2_000_000 }).value);
    const output = typeof completed === "object" && completed !== null && !Array.isArray(completed) && "output" in completed
      ? completed.output : completed;
    return { completed, ...(typeof output === "object" && output !== null && !Array.isArray(output)
      && "kind" in output && output.kind === "completed" ? { spatialPublication: output } : {}) };
  } catch {
    // Generic read callers may return host values. Do not serialize handles,
    // accessors or unbounded objects merely because lease cleanup failed.
    return { completionUnavailable: "The completed host value is not bounded JSON." };
  }
}

/** One existing physical lease for a V1 snapshot/migration or V2 transaction. */
export async function withSpatialProjectLease<T>(
  application: ApplicationContext,
  project: string,
  execute: (leasedApplication: ApplicationContext) => Promise<T>,
  beforeMutation?: () => Promise<void>,
  access: "read" | "mutation" = "read",
  dependencies: SpatialProjectLeaseDependencies = {},
): Promise<T> {
  if (application.spatialProjectCustody !== undefined) throw new ApplicationError("internal", "Spatial project custody cannot be nested.");
  const directory = await resolveProjectDirectory(application.paths.projectRoot, project);
  if (directory.id !== project) throw new ApplicationError("invalid-data", "Spatial operations require the exact project ID.");
  const previous = queues.get(directory.path) ?? Promise.resolve();
  const result = previous.then(async () => {
    const fileSystem = (dependencies.fileSystem ?? createNodeBundleFileSystem)(directory.path);
    const lease = await (dependencies.acquire ?? acquireMutationLease)(directory.path, {
      command: "spatial.project", label: `project ${project}`, now: application.clock.now,
    });
    let active = true;
    let completed: Readonly<Record<string, unknown>> | undefined, value: T | undefined, failed = false, failure: unknown;
    const cleanupErrors: unknown[] = [];
    const custody = {
      projectDirectory: directory.path, projectId: directory.id,
      assertHeld: async () => {
        if (!active) throw new ApplicationError("conflict", "Spatial project lease already ended.");
        await lease.assertOwned();
        await application.hostResourceLease?.assertOwned();
        await beforeMutation?.();
      },
      assertLegacyTransactionSettled: async () => {
        await custody.assertHeld();
        await assertProjectStateTransactionSettled(fileSystem);
        await custody.assertHeld();
      },
    };
    const readAuthority = async () => {
      const authority: unknown = JSON.parse(await fileSystem.readText("project.json", SPATIAL_PROJECT_LIMITS.documentBytes));
      if (typeof authority !== "object" || authority === null || !("projectId" in authority) || authority.projectId !== directory.id) {
        throw new ApplicationError("conflict", "Project authority belongs to a different directory identity.");
      }
      return authority;
    };
    const recoveryFence = async () => {
      await custody.assertHeld();
      if (spatialMarker(await readAuthority())) throw new ApplicationError("unsupported-plan", "Legacy recovery cannot replace spatial V2 authority.");
      await custody.assertHeld();
    };
    try {
      await custody.assertHeld();
      const authority = await readAuthority();
      if (spatialMarker(authority)) SpatialProjectHeadV2Schema.parse(authority);
      else if (access === "mutation") {
        if (fileSystem.writeTextAtomicGuarded === undefined || fileSystem.writeTextNoReplace === undefined) {
          throw new ApplicationError("unsupported-plan", "Spatial migration requires guarded legacy recovery storage.");
        }
        const recoveryFileSystem: BundleFileSystem = {
          ...fileSystem,
          writeTextAtomic: async (path, contents) => await fileSystem.writeTextAtomicGuarded!(path, contents, recoveryFence),
          writeTextNoReplace: async (path, contents) => await fileSystem.writeTextNoReplace!(path, contents, recoveryFence),
        };
        await recoverProjectStateTransaction(recoveryFileSystem, directory.id);
      } else await assertProjectStateTransactionSettled(fileSystem);
      await custody.assertHeld();
      value = await execute({ ...application, spatialProjectCustody: custody });
      completed = completionEvidence(value);
    } catch (error) { failed = true; failure = error; }
    finally {
      active = false;
      try { await lease.close(); } catch (error) { cleanupErrors.push(error); }
      try { await lease.unlinkIfOwned(); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length > 0) {
      throw new ApplicationError(failure instanceof ApplicationError ? failure.code : "internal",
        failed && failure instanceof Error ? failure.message : "Spatial project lease cleanup failed after execution.", {
          ...(failure instanceof ApplicationError ? failure.details : {}),
          ...completed,
          spatialLeaseCleanup: cleanupErrors.map(error => error instanceof Error ? error.message : String(error)),
          ...(failed ? { executionFailure: failure instanceof Error ? failure.message : String(failure) } : {}),
        });
    }
    if (failed) throw failure;
    return value as T;
  });
  const settled = result.then(() => undefined, () => undefined);
  queues.set(directory.path, settled);
  try { return await result; }
  finally { if (queues.get(directory.path) === settled) queues.delete(directory.path); }
}
