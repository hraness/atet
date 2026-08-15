import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  ProjectEditPlanV1Schema,
  RepositoryRelativePathSchema,
  Sha256Schema,
  VideoProjectIdSchema,
  VideoProjectV1Schema,
  type ProjectEditPlanV1,
  type VideoProjectV1,
} from "../contracts";
import {
  canonicalJson,
  canonicalJsonSha256,
  canonicalAtetPersistenceDocument,
  hashProjectStructure,
  loadProjectEditPlan,
  loadVideoProject,
  saveImmutableText,
  saveProjectEditPlan,
  saveVideoProject,
  sha256Hex,
  type BundleFileSystem,
} from "../core";
import { CliError } from "./errors";

export const PROJECT_STATE_TRANSACTION_PATH = "state/project-transaction.json";

const TransactionIdSchema = z.string().regex(/^transaction_[a-f0-9]{32}$/u);

const GenerationReferenceSchema = z.strictObject({
  plan: z.strictObject({
    path: RepositoryRelativePathSchema,
    sha256: Sha256Schema,
  }),
  project: z.strictObject({
    path: RepositoryRelativePathSchema,
    sha256: Sha256Schema,
  }),
});

const TransactionBaseShape = {
  after: GenerationReferenceSchema,
  before: GenerationReferenceSchema,
  kind: z.union([
    z.literal("atet.project-state-transaction"),
    z.literal("transmute.project-state-transaction"),
    z.literal("studio.project-state-transaction"),
  ]),
  projectId: VideoProjectIdSchema,
  schemaVersion: z.literal(1),
  transactionId: TransactionIdSchema,
} as const;

function assertCanonicalTransactionPaths(
  transaction: Readonly<{
    after: z.infer<typeof GenerationReferenceSchema>;
    before: z.infer<typeof GenerationReferenceSchema>;
    transactionId: string;
  }>,
  context: z.RefinementCtx,
): void {
  const root = `state/transactions/${transaction.transactionId}`;
  const expected = {
    after: {
      plan: `${root}/after-plan.json`,
      project: `${root}/after-project.json`,
    },
    before: {
      plan: `${root}/before-plan.json`,
      project: `${root}/before-project.json`,
    },
  } as const;
  for (const generation of ["before", "after"] as const) {
    if (transaction[generation].plan.path !== expected[generation].plan) {
      context.addIssue({ code: "custom", message: `Project transaction ${generation} plan path is not canonical.` });
    }
    if (transaction[generation].project.path !== expected[generation].project) {
      context.addIssue({ code: "custom", message: `Project transaction ${generation} project path is not canonical.` });
    }
  }
}

export const ProjectStateTransactionV1Schema = z.discriminatedUnion("phase", [
  z.strictObject({ ...TransactionBaseShape, phase: z.literal("prepare") }),
  z.strictObject({ ...TransactionBaseShape, phase: z.literal("commit-ready") }),
  z.strictObject({
    ...TransactionBaseShape,
    active: z.enum(["before", "after"]),
    phase: z.literal("settled"),
  }),
]).superRefine((transaction, context) => {
  assertCanonicalTransactionPaths(transaction, context);
});

export type ProjectStateTransactionV1 = Readonly<z.infer<typeof ProjectStateTransactionV1Schema>>;

export const ProjectStateTransactionSettlementV1Schema = z.strictObject({
  active: z.enum(["before", "after"]),
  after: GenerationReferenceSchema,
  before: GenerationReferenceSchema,
  kind: z.union([
    z.literal("atet.project-state-transaction-settlement"),
    z.literal("transmute.project-state-transaction-settlement"),
  ]),
  projectId: VideoProjectIdSchema,
  schemaVersion: z.literal(1),
  transactionId: TransactionIdSchema,
}).superRefine(assertCanonicalTransactionPaths);

export type ProjectStateTransactionSettlementV1 = Readonly<
  z.infer<typeof ProjectStateTransactionSettlementV1Schema>
>;

export function projectStateTransactionSettlementPath(
  transactionId: string,
): string {
  return `state/transactions/${TransactionIdSchema.parse(transactionId)}/settlement.json`;
}

export function projectStateTransactionMayHaveCommitted(error: unknown): boolean {
  return error instanceof CliError
    && error.details?.projectStateTransaction === "unresolved";
}

interface ProjectGeneration {
  readonly plan: ProjectEditPlanV1;
  readonly project: VideoProjectV1;
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function validateGeneration(input: ProjectGeneration, label: string): ProjectGeneration {
  const project = VideoProjectV1Schema.parse(input.project);
  const plan = ProjectEditPlanV1Schema.parse(input.plan);
  if (plan.projectId !== project.projectId) {
    throw new CliError("invalid-data", `${label} project state uses different project identities.`);
  }
  if (plan.projectStructureSha256 !== hashProjectStructure(project)) {
    throw new CliError("invalid-data", `${label} project state has an edit plan for another structure generation.`);
  }
  return {
    plan: canonicalAtetPersistenceDocument(plan),
    project: canonicalAtetPersistenceDocument(project),
  };
}

function referenceFor(
  transactionId: string,
  generation: "before" | "after",
  value: ProjectGeneration,
): z.infer<typeof GenerationReferenceSchema> {
  const root = `state/transactions/${transactionId}`;
  return GenerationReferenceSchema.parse({
    plan: {
      path: `${root}/${generation}-plan.json`,
      sha256: canonicalJsonSha256(value.plan),
    },
    project: {
      path: `${root}/${generation}-project.json`,
      sha256: canonicalJsonSha256(value.project),
    },
  });
}

async function readTransaction(
  fileSystem: BundleFileSystem,
): Promise<ProjectStateTransactionV1 | null> {
  let text: string;
  try {
    text = await fileSystem.readText(PROJECT_STATE_TRANSACTION_PATH);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new CliError("invalid-data", "Project state transaction marker is not valid JSON.");
  }
  const parsed = ProjectStateTransactionV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new CliError("invalid-data", `Project state transaction marker is invalid: ${parsed.error.message}`);
  }
  return parsed.data;
}

async function writeTransaction(
  fileSystem: BundleFileSystem,
  transaction: ProjectStateTransactionV1,
): Promise<void> {
  const parsed = ProjectStateTransactionV1Schema.parse({
    ...transaction,
    kind: "atet.project-state-transaction",
  });
  await fileSystem.writeTextAtomic(PROJECT_STATE_TRANSACTION_PATH, `${canonicalJson(parsed)}\n`);
}

async function saveGeneration(
  fileSystem: BundleFileSystem,
  reference: z.infer<typeof GenerationReferenceSchema>,
  generation: ProjectGeneration,
): Promise<void> {
  await saveProjectEditPlan(fileSystem, generation.plan, reference.plan.path);
  await saveVideoProject(fileSystem, generation.project, reference.project.path);
}

async function loadGeneration(
  fileSystem: BundleFileSystem,
  reference: z.infer<typeof GenerationReferenceSchema>,
  label: string,
): Promise<ProjectGeneration> {
  const [rawPlanText, rawProjectText] = await Promise.all([
    fileSystem.readText(reference.plan.path),
    fileSystem.readText(reference.project.path),
  ]);
  let rawGeneration: ProjectGeneration;
  try {
    rawGeneration = {
      plan: ProjectEditPlanV1Schema.parse(JSON.parse(rawPlanText) as unknown),
      project: VideoProjectV1Schema.parse(JSON.parse(rawProjectText) as unknown),
    };
  } catch {
    throw new CliError(
      "invalid-data",
      `${label} project transaction generation is not valid structured state.`,
    );
  }
  if (
    canonicalJsonSha256(rawGeneration.plan) !== reference.plan.sha256
    || canonicalJsonSha256(rawGeneration.project) !== reference.project.sha256
  ) {
    throw new CliError("invalid-data", `${label} project transaction generation failed its integrity check.`);
  }
  return validateGeneration(rawGeneration, label);
}

export async function loadProjectStateTransactionSettlement(
  fileSystem: BundleFileSystem,
  transactionId: string,
): Promise<ProjectStateTransactionSettlementV1 | null> {
  const path = projectStateTransactionSettlementPath(transactionId);
  let text: string;
  try {
    text = await fileSystem.readText(path);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new CliError(
      "invalid-data",
      `Project transaction settlement ${transactionId} is not valid JSON.`,
    );
  }
  const rawSettlement = ProjectStateTransactionSettlementV1Schema.parse(value);
  if (rawSettlement.transactionId !== TransactionIdSchema.parse(transactionId)) {
    throw new CliError(
      "invalid-data",
      `Project transaction settlement path does not match ${transactionId}.`,
    );
  }
  if (text !== `${canonicalJson(rawSettlement)}\n`) {
    throw new CliError(
      "invalid-data",
      `Project transaction settlement ${transactionId} is not canonical immutable JSON.`,
    );
  }
  const [before, after] = await Promise.all([
    loadGeneration(fileSystem, rawSettlement.before, `before ${transactionId}`),
    loadGeneration(fileSystem, rawSettlement.after, `after ${transactionId}`),
  ]);
  if (
    before.project.projectId !== rawSettlement.projectId
    || after.project.projectId !== rawSettlement.projectId
  ) {
    throw new CliError(
      "invalid-data",
      `Project transaction settlement ${transactionId} references another project.`,
    );
  }
  return ProjectStateTransactionSettlementV1Schema.parse({
    ...rawSettlement,
    kind: "atet.project-state-transaction-settlement",
  });
}

async function publishTransactionSettlement(
  fileSystem: BundleFileSystem,
  transaction: Extract<ProjectStateTransactionV1, { readonly phase: "settled" }>,
): Promise<void> {
  const settlement = ProjectStateTransactionSettlementV1Schema.parse({
    active: transaction.active,
    after: transaction.after,
    before: transaction.before,
    kind: "atet.project-state-transaction-settlement",
    projectId: transaction.projectId,
    schemaVersion: 1,
    transactionId: transaction.transactionId,
  });
  const existing = await loadProjectStateTransactionSettlement(
    fileSystem,
    transaction.transactionId,
  );
  if (existing !== null) {
    if (canonicalJson(existing) !== canonicalJson(settlement)) {
      throw new CliError(
        "invalid-data",
        `Project transaction ${transaction.transactionId} has conflicting immutable settlement evidence.`,
      );
    }
    return;
  }
  const current = validateGeneration({
    plan: await loadProjectEditPlan(fileSystem),
    project: await loadVideoProject(fileSystem),
  }, "Settled current");
  const active = transaction[transaction.active];
  const activeGeneration = await loadGeneration(
    fileSystem,
    active,
    `settled active ${transaction.transactionId}`,
  );
  if (
    canonicalJsonSha256(current.plan) !== canonicalJsonSha256(activeGeneration.plan)
    || canonicalJsonSha256(current.project) !== canonicalJsonSha256(activeGeneration.project)
  ) {
    throw new CliError(
      "invalid-data",
      `Project transaction ${transaction.transactionId} cannot prove its settled active generation.`,
    );
  }
  const contents = `${canonicalJson(settlement)}\n`;
  try {
    await saveImmutableText(
      fileSystem,
      projectStateTransactionSettlementPath(transaction.transactionId),
      contents,
      sha256Hex(contents),
    );
  } catch (error) {
    throw new CliError(
      "invalid-data",
      `Project transaction ${transaction.transactionId} could not publish immutable settlement evidence.`,
      { failure: error instanceof Error ? error.message : String(error) },
    );
  }
}

async function installGeneration(
  fileSystem: BundleFileSystem,
  generation: ProjectGeneration,
): Promise<void> {
  // The marker remains non-settled across both replacements, so unlocked readers
  // reject either intermediate pairing instead of observing a mixed generation.
  await saveProjectEditPlan(fileSystem, generation.plan);
  await saveVideoProject(fileSystem, generation.project);
}

function transactionWithPhase(
  transaction: ProjectStateTransactionV1,
  phase: "prepare" | "commit-ready",
): ProjectStateTransactionV1 {
  return ProjectStateTransactionV1Schema.parse({
    after: transaction.after,
    before: transaction.before,
    kind: "atet.project-state-transaction",
    phase,
    projectId: transaction.projectId,
    schemaVersion: transaction.schemaVersion,
    transactionId: transaction.transactionId,
  });
}

function settledTransaction(
  transaction: ProjectStateTransactionV1,
  active: "before" | "after",
): ProjectStateTransactionV1 {
  return ProjectStateTransactionV1Schema.parse({
    after: transaction.after,
    before: transaction.before,
    active,
    kind: "atet.project-state-transaction",
    phase: "settled",
    projectId: transaction.projectId,
    schemaVersion: transaction.schemaVersion,
    transactionId: transaction.transactionId,
  });
}

export async function assertProjectStateTransactionSettled(
  fileSystem: BundleFileSystem,
): Promise<void> {
  const transaction = await readTransaction(fileSystem);
  if (transaction === null || transaction.phase === "settled") return;
  throw new CliError(
    "conflict",
    "The project has an interrupted state transaction. Run any mutating project command to recover it under the project lock.",
    { phase: transaction.phase, transactionId: transaction.transactionId },
  );
}

export async function recoverProjectStateTransaction(
  fileSystem: BundleFileSystem,
): Promise<"none" | "settled" | "rolled-back" | "rolled-forward"> {
  const transaction = await readTransaction(fileSystem);
  if (transaction === null) return "none";
  if (transaction.phase === "settled") {
    await publishTransactionSettlement(fileSystem, transaction);
    return "settled";
  }
  const active = transaction.phase === "prepare" ? "before" : "after";
  const generation = await loadGeneration(
    fileSystem,
    transaction[active],
    `${active} ${transaction.transactionId}`,
  );
  if (generation.project.projectId !== transaction.projectId) {
    throw new CliError("invalid-data", "Project transaction generation belongs to another project.");
  }
  await installGeneration(fileSystem, generation);
  const settled = settledTransaction(transaction, active);
  await writeTransaction(fileSystem, settled);
  if (settled.phase !== "settled") {
    throw new CliError("internal", "Project transaction settlement lost its phase.");
  }
  await publishTransactionSettlement(fileSystem, settled);
  return active === "before" ? "rolled-back" : "rolled-forward";
}

export async function commitProjectStateTransaction(options: {
  readonly after: ProjectGeneration;
  readonly before: ProjectGeneration;
  readonly fileSystem: BundleFileSystem;
  readonly transactionId?: string;
}): Promise<ProjectGeneration> {
  const before = validateGeneration(options.before, "Prior");
  const after = validateGeneration(options.after, "Next");
  if (before.project.projectId !== after.project.projectId) {
    throw new CliError("invalid-data", "Project state transaction cannot cross project identities.");
  }
  const current = validateGeneration({
    plan: await loadProjectEditPlan(options.fileSystem),
    project: await loadVideoProject(options.fileSystem),
  }, "Current");
  if (
    canonicalJsonSha256(current.plan) !== canonicalJsonSha256(before.plan)
    || canonicalJsonSha256(current.project) !== canonicalJsonSha256(before.project)
  ) {
    throw new CliError("conflict", "Project state changed before its structural transaction could begin.");
  }
  const transactionId = TransactionIdSchema.parse(
    options.transactionId ?? `transaction_${randomUUID().replaceAll("-", "")}`,
  );
  const transaction = ProjectStateTransactionV1Schema.parse({
    after: referenceFor(transactionId, "after", after),
    before: referenceFor(transactionId, "before", before),
    kind: "atet.project-state-transaction",
    phase: "prepare",
    projectId: before.project.projectId,
    schemaVersion: 1,
    transactionId,
  });

  await saveGeneration(options.fileSystem, transaction.before, before);
  await saveGeneration(options.fileSystem, transaction.after, after);
  await writeTransaction(options.fileSystem, transaction);
  let commitReady = false;
  try {
    await installGeneration(options.fileSystem, after);
    await writeTransaction(options.fileSystem, transactionWithPhase(transaction, "commit-ready"));
    commitReady = true;
    const settled = settledTransaction(transaction, "after");
    await writeTransaction(options.fileSystem, settled);
    if (settled.phase !== "settled") {
      throw new CliError("internal", "Project transaction settlement lost its phase.");
    }
    await publishTransactionSettlement(options.fileSystem, settled);
  } catch (error) {
    const active = commitReady ? "after" : "before";
    try {
      await installGeneration(options.fileSystem, active === "after" ? after : before);
      const settled = settledTransaction(transaction, active);
      await writeTransaction(options.fileSystem, settled);
      if (settled.phase !== "settled") {
        throw new CliError("internal", "Project transaction settlement lost its phase.");
      }
      await publishTransactionSettlement(options.fileSystem, settled);
    } catch (recoveryError) {
      throw new CliError(
        "invalid-data",
        `Project state transaction ${transactionId} could not settle; the next mutating project command must recover it.`,
        {
          failure: error instanceof Error ? error.message : String(error),
          projectStateTransaction: "unresolved",
          recoveryFailure: recoveryError instanceof Error ? recoveryError.message : String(recoveryError),
          transactionId,
        },
      );
    }
    if (!commitReady) throw error;
  }
  return after;
}
