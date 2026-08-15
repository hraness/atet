import type { ApplicationContext } from "./context";
import { ApplicationError } from "./errors";
import type { OperationKind } from "./operation";
import {
  ProjectAnalysisReferenceSchema,
  VideoProjectV1Schema,
  type VideoProjectV1,
} from "../contracts";
import { canonicalJson } from "../core/canonical-json";
import {
  canonicalAtetPersistenceDocument,
  createNodeBundleFileSystem,
  saveVideoProject,
} from "../core/storage";
import { withMutationLock } from "../cli/mutation-lock";
import {
  recoverProjectStateTransaction,
} from "../cli/project-state-transaction";
import { resolveProjectDirectory } from "../cli/project-service";
import {
  assertProjectEditBasis,
  openProjectSnapshot,
  type ProjectEditBasis,
  type OpenProjectSnapshot,
} from "./project-store";

const inProcessPublicationTails = new Map<string, Promise<void>>();

async function withInProcessPublicationQueue<Value>(
  key: string,
  execute: () => Promise<Value>,
): Promise<Value> {
  const previous = inProcessPublicationTails.get(key) ?? Promise.resolve();
  const result = previous.then(execute);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  inProcessPublicationTails.set(key, settled);
  try {
    return await result;
  } finally {
    if (inProcessPublicationTails.get(key) === settled) {
      inProcessPublicationTails.delete(key);
    }
  }
}

function projectReference(input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ApplicationError(
      "invalid-data",
      "A project publication operation requires an object input.",
    );
  }
  const project = (input as Readonly<Record<string, unknown>>).project;
  if (typeof project !== "string") {
    throw new ApplicationError(
      "invalid-data",
      "A project publication operation requires a project reference.",
    );
  }
  return project;
}

async function withResolvedProjectMutationLease<Value>(
  application: ApplicationContext,
  reference: string,
  command: string,
  execute: (
    directory: Awaited<ReturnType<typeof resolveProjectDirectory>>,
  ) => Promise<Value>,
): Promise<Value> {
  const directory = await resolveProjectDirectory(
    application.paths.projectRoot,
    reference,
  );
  return await withInProcessPublicationQueue(directory.path, async () =>
    await withMutationLock(directory.path, {
      command,
      label: `project ${directory.id}`,
      now: application.clock.now,
    }, async () => await execute(directory)));
}

/**
 * Bind one immutable project/plan generation while sharing the same brief
 * in-process and physical mutation lease as project publication. The lease is
 * released before any analysis work begins. Reads fail closed on an unsettled
 * transaction; only mutation owners may recover one.
 */
export async function openLeasedProjectSnapshot(
  application: ApplicationContext,
  reference: string,
): Promise<OpenProjectSnapshot> {
  return await withResolvedProjectMutationLease(
    application,
    reference,
    "workflow:project.snapshot:read",
    async directory => await openProjectSnapshot(
      application.paths.projectRoot,
      directory.id,
    ),
  );
}

/** Serialize only the checked publication phase with existing CLI mutations. */
export async function withProjectPublicationLease<Value>(
  application: ApplicationContext,
  operation: OperationKind,
  input: unknown,
  execute: () => Promise<Value>,
  beforeRecoveryMutation?: () => Promise<void>,
): Promise<Value> {
  const reference = projectReference(input);
  return await withResolvedProjectMutationLease(
    application,
    reference,
    `workflow:${operation}`,
    async directory => {
      // Transaction recovery may itself restore project or plan bytes. A
      // reconciliation caller therefore fences after acquiring the physical
      // lock and immediately before allowing that recovery write boundary.
      await beforeRecoveryMutation?.();
      await recoverProjectStateTransaction(createNodeBundleFileSystem(
        directory.path,
      ));
      return await execute();
    },
  );
}

type ProjectAnalysisReference = ReturnType<
  typeof ProjectAnalysisReferenceSchema.parse
>;

export function projectAnalysisPublicationBasis(
  snapshot: OpenProjectSnapshot,
): ProjectEditBasis {
  return snapshot.editBasis;
}

export interface MergeProjectAnalysisReferenceOptions {
  readonly application: ApplicationContext;
  /**
   * The original edit basis that authorized the analysis. Its prefix
   * commitment deliberately permits later sibling analyses while rejecting
   * removal, reordering, or replacement of any prior authority.
   */
  readonly basis: ProjectEditBasis;
  /**
   * Revalidates a durable workflow fence after waiting for the physical
   * publication lock and immediately before mutating the project document.
   */
  readonly beforePublication?: () => Promise<void>;
  readonly operation: Extract<OperationKind, `analysis.${string}`>;
  readonly project: string;
  readonly reference: ProjectAnalysisReference;
}

export async function mergeProjectAnalysisReference(
  options: MergeProjectAnalysisReferenceOptions,
): Promise<{
  readonly project: VideoProjectV1;
  readonly reference: ProjectAnalysisReference;
}> {
  const reference = ProjectAnalysisReferenceSchema.parse(options.reference);
  if (Date.parse(reference.createdAt) < Date.parse(options.basis.projectUpdatedAt)) {
    throw new ApplicationError(
      "conflict",
      "The analysis update time cannot precede the project snapshot update time.",
    );
  }
  return await withProjectPublicationLease(
    options.application,
    options.operation,
    { project: options.project },
    async () => {
      await options.beforePublication?.();
      const latest = await openProjectSnapshot(
        options.application.paths.projectRoot,
        options.project,
      );
      assertProjectEditBasis(options.basis, latest);
      const existing = latest.project.analyses.find(
        candidate => candidate.analysisId === reference.analysisId,
      );
      if (existing !== undefined) {
        if (canonicalJson(existing) !== canonicalJson(reference)) {
          throw new ApplicationError(
            "conflict",
            `Project analysis identity was published with different evidence: ${reference.analysisId}`,
          );
        }
        return { project: latest.project, reference };
      }
      const publicationSnapshot = await openProjectSnapshot(
        options.application.paths.projectRoot,
        options.project,
      );
      // Reassert the original append-only basis after the final durable
      // workflow fence. This both preserves sibling analyses that arrived
      // during recovery and makes the check the last fallible I/O before save.
      assertProjectEditBasis(options.basis, publicationSnapshot);
      const publicationExisting = publicationSnapshot.project.analyses.find(
        candidate => candidate.analysisId === reference.analysisId,
      );
      if (publicationExisting !== undefined) {
        if (canonicalJson(publicationExisting) !== canonicalJson(reference)) {
          throw new ApplicationError(
            "conflict",
            `Project analysis identity was published with different evidence: ${reference.analysisId}`,
          );
        }
        return { project: publicationSnapshot.project, reference };
      }
      const updatedAt = Date.parse(reference.createdAt)
        >= Date.parse(publicationSnapshot.project.updatedAt)
        ? reference.createdAt
        : publicationSnapshot.project.updatedAt;
      const project = canonicalAtetPersistenceDocument(VideoProjectV1Schema.parse({
        ...publicationSnapshot.project,
        analyses: [...publicationSnapshot.project.analyses, reference],
        updatedAt,
      }));
      await options.beforePublication?.();
      assertProjectEditBasis(options.basis, publicationSnapshot);
      await saveVideoProject(publicationSnapshot.openProject.fileSystem, project);
      return { project, reference };
    },
    options.beforePublication,
  );
}
