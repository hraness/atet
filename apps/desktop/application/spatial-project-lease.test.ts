import { expect, test } from "bun:test";
import { mkdtemp, rename, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationProjectFixture, operationApplicationContext } from "./operations/test-support";
import { withSpatialProjectLease } from "./spatial-project-lease";
import { createApplicationOperationRegistry } from "./default-registry";
import { commitProjectStateTransaction, projectStateTransactionSettlementPath } from "../cli/project-state-transaction";
import { SpatialProjectSnapshotOutputSchema } from "./operations/spatial-project";
import { acquireMutationLease } from "../cli/mutation-lock";
import type { ApplicationHostResourceLease } from "./context";
import { ApplicationError } from "./errors";

test("read-only spatial leases never recover a valid interrupted V1 journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "atet-spatial-read-lease-"));
  try {
    const f = await createOperationProjectFixture(root);
    const application = operationApplicationContext(root);
    await commitProjectStateTransaction({ fileSystem: f.fileSystem, before: { project: f.project, plan: f.plan }, after: { project: f.project, plan: f.plan }, transactionId: `transaction_${"3".repeat(32)}` });
    const journal = JSON.parse(await f.fileSystem.readText("state/project-transaction.json")) as Record<string, unknown>;
    const { active: _active, ...pending } = journal;
    await f.fileSystem.writeTextAtomic("state/project-transaction.json", JSON.stringify({ ...pending, phase: "commit-ready" }));
    const paths = ["project.json", "edits/current.json", "state/project-transaction.json"];
    const before = await Promise.all(paths.map(path => f.fileSystem.readText(path)));
    await expect(withSpatialProjectLease(application, f.project.projectId, async () => 1)).rejects.toThrow("interrupted");
    expect(await Promise.all(paths.map(path => f.fileSystem.readText(path)))).toEqual(before);
    await withSpatialProjectLease(application, f.project.projectId, async () => 1, undefined, "mutation");
    expect(JSON.parse(await f.fileSystem.readText("state/project-transaction.json")).phase).toBe("settled");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a valid migrated bundle cannot acquire authority through a different project directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "atet-spatial-directory-"));
  try {
    const f = await createOperationProjectFixture(root);
    const application = operationApplicationContext(root);
    const registry = createApplicationOperationRegistry();
    await withSpatialProjectLease(application, f.project.projectId, async leased => {
      const context = { application: leased, abortSignal: new AbortController().signal };
      const read = await registry.execute(context, { kind: "spatial.project.snapshot", version: 1, input: { project: f.project.projectId } });
      const snapshot = SpatialProjectSnapshotOutputSchema.parse(read.output);
      const mutation = await registry.execute(context, { kind: "spatial.project.migrate", version: 1, input: { project: f.project.projectId, expected: snapshot.basis, transactionId: `transaction_${"4".repeat(32)}`, scenes: [], shots: [] } });
      expect((mutation.output as { kind: string }).kind).toBe("completed");
    }, undefined, "mutation");
    const alias = "project_copied001";
    await rename(f.projectDirectory, join(f.projectRoot, alias));
    await expect(withSpatialProjectLease(application, alias, async () => 1, undefined, "mutation")).rejects.toThrow("directory identity");
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function interruptedLegacyFixture(root: string) {
  const f = await createOperationProjectFixture(root);
  const transactionId = `transaction_${"5".repeat(32)}`;
  await commitProjectStateTransaction({ fileSystem: f.fileSystem, before: { project: f.project, plan: f.plan },
    after: { project: f.project, plan: f.plan }, transactionId });
  const { active: _active, ...journal } = JSON.parse(await f.fileSystem.readText("state/project-transaction.json")) as Record<string, unknown>;
  await f.fileSystem.writeTextAtomic("state/project-transaction.json", JSON.stringify({ ...journal, phase: "commit-ready" }));
  return { ...f, transactionId };
}

const fixtureHostLease = (assertOwned: () => Promise<void>): ApplicationHostResourceLease => ({
  assertOwned, claims: [], inheritedFileDescriptor: -1, inheritedFileDescriptors: [],
  profile: { id: "spatial-lease-test", capacities: [] }, ticket: "1",
});

for (const loss of ["host", "cancellation", "v2"] as const) {
  test(`legacy recovery refuses ${loss} loss after staging and before its first authority replacement`, async () => {
    const root = await mkdtemp(join(tmpdir(), "atet-spatial-recovery-fence-"));
    try {
      const f = await interruptedLegacyFixture(root), paths = ["project.json", "edits/current.json", "state/project-transaction.json"];
      const original = await Promise.all(paths.map(path => f.fileSystem.readText(path)));
      let held = true, cancelled = false, executed = false;
      const marker = JSON.stringify({ kind: "atet.spatial-project-head", schemaVersion: 2, projectId: f.project.projectId });
      const application = { ...operationApplicationContext(root), hostResourceLease: fixtureHostLease(async () => {
        if (!held) throw new ApplicationError("conflict", "Host custody lost.");
      }) };
      await expect(withSpatialProjectLease(application, f.project.projectId, async () => { executed = true; }, async () => {
        if (cancelled) throw new ApplicationError("cancelled", "Recovery cancelled.");
      }, "mutation", { fileSystem: () => ({ ...f.fileSystem, writeTextAtomicGuarded: async (path, contents, guard) => {
        await f.fileSystem.writeTextAtomicGuarded!(path, contents, async () => {
          if (loss === "host") held = false;
          if (loss === "cancellation") cancelled = true;
          if (loss === "v2") await f.fileSystem.writeTextAtomic("project.json", marker);
          await guard();
        });
      } }) })).rejects.toThrow(loss === "host" ? "Host custody" : loss === "cancellation" ? "cancelled" : "V2 authority");
      expect(executed).toBe(false);
      expect(await Promise.all(paths.map(path => f.fileSystem.readText(path)))).toEqual(loss === "v2" ? [marker, ...original.slice(1)] : original);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test("each replacement in multi-file legacy recovery rechecks custody", async () => {
  const root = await mkdtemp(join(tmpdir(), "atet-spatial-recovery-late-fence-"));
  try {
    const f = await interruptedLegacyFixture(root), originalHead = await f.fileSystem.readText("project.json");
    const published: string[] = [];
    let held = true;
    const application = { ...operationApplicationContext(root), hostResourceLease: fixtureHostLease(async () => {
      if (!held) throw new ApplicationError("conflict", "Host custody lost before the second replacement.");
    }) };
    await expect(withSpatialProjectLease(application, f.project.projectId, async () => 1, undefined, "mutation", {
      fileSystem: () => ({ ...f.fileSystem, writeTextAtomicGuarded: async (path, contents, guard) => {
        await f.fileSystem.writeTextAtomicGuarded!(path, contents, async () => { if (published.length === 1) held = false; await guard(); });
        published.push(path);
      } }),
    })).rejects.toThrow("second replacement");
    expect(published).toEqual(["edits/current.json"]);
    expect(await f.fileSystem.readText("project.json")).toBe(originalHead);
    expect(JSON.parse(await f.fileSystem.readText("state/project-transaction.json")).phase).toBe("commit-ready");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("legacy immutable settlement publication retains the final custody fence", async () => {
  const root = await mkdtemp(join(tmpdir(), "atet-spatial-settlement-fence-"));
  try {
    const f = await interruptedLegacyFixture(root), settlement = projectStateTransactionSettlementPath(f.transactionId);
    await unlink(join(f.projectDirectory, settlement));
    let held = true;
    const application = { ...operationApplicationContext(root), hostResourceLease: fixtureHostLease(async () => {
      if (!held) throw new ApplicationError("conflict", "Host custody lost before settlement.");
    }) };
    await expect(withSpatialProjectLease(application, f.project.projectId, async () => 1, undefined, "mutation", {
      fileSystem: () => ({ ...f.fileSystem, writeTextNoReplace: async (path, contents, guard) =>
        await f.fileSystem.writeTextNoReplace!(path, contents, async () => { held = false; await guard?.(); }) }),
    })).rejects.toThrow("settlement evidence");
    await expect(f.fileSystem.readText(settlement)).rejects.toThrow();
    expect(JSON.parse(await f.fileSystem.readText("state/project-transaction.json")).phase).toBe("settled");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("lease cleanup retains the frozen completion and both cleanup errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "atet-spatial-lease-completion-"));
  try {
    const f = await createOperationProjectFixture(root), application = operationApplicationContext(root);
    const output = { kind: "completed", projectId: f.project.projectId, attempt: { path: "spatial/attempts/a.json" }, settlement: { path: "spatial/receipts/b.json" } };
    const expected = structuredClone(output);
    let savedCustody: NonNullable<typeof application.spatialProjectCustody> | undefined;
    const failure: unknown = await withSpatialProjectLease(application, f.project.projectId, async leased => {
      savedCustody = leased.spatialProjectCustody;
      return { output };
    }, undefined, "read", { acquire: async (directory, options) => {
      const lease = await acquireMutationLease(directory, options);
      return { ...lease,
        close: async () => { await lease.close(); output.attempt.path = "changed-after-completion"; throw new Error("close failed"); },
        unlinkIfOwned: async () => { await lease.unlinkIfOwned(); throw new Error("unlink failed"); },
      };
    } }).catch(error => error);
    expect(failure).toBeInstanceOf(ApplicationError);
    expect((failure as ApplicationError).details?.completed).toEqual({ output: expected });
    expect((failure as ApplicationError).details?.spatialPublication).toEqual(expected);
    expect((failure as ApplicationError).details?.spatialLeaseCleanup).toEqual(["close failed", "unlink failed"]);
    await expect(savedCustody!.assertHeld()).rejects.toThrow("already ended");
    expect(await withSpatialProjectLease(application, f.project.projectId, async () => 7)).toBe(7);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("lease cleanup preserves the original publication failure and releases after all cleanup attempts", async () => {
  const root = await mkdtemp(join(tmpdir(), "atet-spatial-lease-failure-"));
  try {
    const f = await createOperationProjectFixture(root), application = operationApplicationContext(root);
    const proof = { kind: "ambiguous", attempt: { path: "spatial/attempts/a.json" } };
    const failure: unknown = await withSpatialProjectLease(application, f.project.projectId, async () => {
      throw new ApplicationError("ambiguous", "Publication acknowledgement lost.", { spatialPublication: proof });
    }, undefined, "read", { acquire: async (directory, options) => {
      const lease = await acquireMutationLease(directory, options);
      return { ...lease, close: async () => { await lease.close(); throw new Error("close failed"); } };
    } }).catch(error => error);
    expect(failure).toBeInstanceOf(ApplicationError);
    expect((failure as ApplicationError).code).toBe("ambiguous");
    expect((failure as ApplicationError).message).toBe("Publication acknowledgement lost.");
    expect((failure as ApplicationError).details?.spatialPublication).toEqual(proof);
    expect((failure as ApplicationError).details?.spatialLeaseCleanup).toEqual(["close failed"]);
    expect(await withSpatialProjectLease(application, f.project.projectId, async () => 8)).toBe(8);
  } finally { await rm(root, { recursive: true, force: true }); }
});
