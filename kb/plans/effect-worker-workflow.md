---
type: plan
area: code-runtime
status: in-progress
---

# Effect-owned worker workflow

## Outcome

Migrate trusted compute admission, the complete media ingestion transaction, worker protocol lifetimes, and scheduler cancellation/recovery to Effect 3.22.1. Existing Promise entry points and durable identities remain compatible.

## Scope and constraints

The local operation registry has an additive native execution slot. Discovery, portable authoring declarations, graph hashes, resource vectors, run fences, and operation schemas remain unchanged. Pure compilation and trusted user kernels stay synchronous. Typed boundary failures preserve existing public exception identity. Scope completion never proves that a subprocess has exited or that physical publication custody has ended. Foreign callbacks retain their host leases until settlement. Ambiguous paid work and trusted compute are never automatically replayed.

## Work order

1. Pin the runtime without changing the compiler, and add native operation composition with a Promise facade.
2. Migrate ingestion from acquisition through verified output, receipt, checkpoint, and workspace finalization.
3. Replace scheduler deadline/poll/race ownership and worker request/waiter ownership while preserving FIFO and physical retirement proofs.
4. Add architecture policy and paired negative fixtures to required checks. Verify local and portable declaration graphs.
5. Run focused operation, scheduler, worker, protocol, run-store, and property tests; obtain independent review. The integration owner runs the clean aggregate and documented delivery gates.

## Verification

Worker evidence will be recorded here after commands complete. Broad checks and packaging run through the installed host scheduler. Final integration and release remain the integration owner's responsibility. The stage-only npm workflow does not authorize public promotion without its human authentication step.

## Recovery

Keep the existing durable store and exact replay policy authoritative throughout migration. Revert the local runtime change as a unit if focused custody or identity proofs regress; do not reinterpret existing durable records or weaken gates. Leave unproven physical work under its existing native guardian.

## Decisions and review

The native slot is additive on local `OperationDefinition`/`RegisteredOperation` TypeScript contracts; existing local consumers keep the Promise entry point. Runtime services and native functions are absent from serialized discovery. `effect-boundary.test.ts` traces portable source/type dependencies and checks native execution versus its Promise facade.

The scheduler has one run owner, a completion queue carrying node Exits, scoped claim/replay cleanup, and retained node/custody lifetimes after early observer return. Node output validation remains an expected typed failure. The worker pool reserves FIFO admission synchronously before fiber startup; a failed first validation exposed and corrected a lazy-admission reorder. Request and diagnostic callbacks reserve tables before deadline activation. Reusable cancellation still depends on the exact native terminal/guardian policy.

Cleanup now retains execution and finalizer failures together. Claim acquisition is scoped before initial summary loading, closing the previous setup-unwind gap. A cancelled replay loader's late executor continues through the existing explicit release path. No provider invocation, identity schema, physical resource vector, or replay policy was changed.

Architecture roles deliberately include the existing native scheduler/worker adapter files because they still own subprocess, durable-store and clock boundaries. Pure native programs and registry composition cannot construct additional runtimes. The checker is the reviewed 1.3.0 foundation, including direct-generator JavaScript-catch rejection; it does not prove foreign cancellation, resource linearity, or arbitrary indirect JavaScript purity.

## Focused validation

- The converged host-scheduled worker/scheduler/owner/boundary suite passed 76 tests and 624 assertions.
- The expanded 14-file run passed the other 69 guardian/protocol, durable-store, planner, compiler/property, contract, registry, media and receipt-reconciliation tests. Its five stale-fence cleanup regressions were repaired and all are covered by the converged scheduler rerun.
- `typecheck:desktop`, `typecheck:sdk`, focused ESLint, and `check:effect` passed. The architecture fixtures passed 8 tests and 36 assertions, and the policy inspects the union of both actual TypeScript source graphs.
- Independent review identified a thrown deadline callback that could strand its Deferred and an active-counter admission gap. The deadline child is now observed, new work is refused synchronously on close, synchronous fork failures roll back accounting, and focused regressions pass.
- Fresh ownership readback distinguishes an already-lost run claim from a real cleanup failure. The original stale-fence exception remains intact; genuine cleanup failures still combine with execution failure.

The complete aggregate, built distribution convergence, package smoke, live branch-policy review, pull request, merge and stage-only release are integration-owner gates and have not been claimed by this worker. No provider calls, public package promotion, or coding-model benchmark was performed.
