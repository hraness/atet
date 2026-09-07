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

## Project-render continuation

The next bounded phase owns `render.project` versions 1, 2 and 3 from exact input and toolchain binding through staged encoding, verified bytes, durable precommit, output/receipt publication, readback and interrupted-publication recovery. The registry already adapts its current complete Promise; the change must remove that internal Promise owner, the manual output-monitor timer/listener bookkeeping and the mutable `prepared` value passed between publication callbacks.

The implementation starts at `d64d7e4ca508743b7d69275e2a0fc061ec15d490`. The original checkout and completed worker/scheduler migration remain unchanged. One implementer owns the render continuation and focused verification; an independent reviewer freezes the interfaces below before production edits. The integrator owns the complete aggregate, generated distribution, version and delivery decisions.

### Proposed native interfaces

These local TypeScript interfaces are implementation contracts, not serialized operation or public portable SDK fields. Independent interface review accepted this contract before production edits, with the two obligations recorded below.

```ts
// The selected cause retains existing Promise rejection identity and precedence.
// Earlier execution/cleanup Causes remain private, typed evidence.
type OperationEffectFailure = Readonly<{
  _tag: "OperationBoundaryFailure";
  phase: OperationFailurePhase;
  cause: unknown;
  priorCause?: Cause.Cause<OperationEffectFailure>;
}>;

interface AtomicRenderPublication<Prepared, R> {
  prepare(output: AtomicRenderOutput):
    Effect.Effect<Prepared, OperationEffectFailure, R>;
  companion?: {
    finalPath: string;
    publish(prepared: Prepared, output: AtomicRenderOutput):
      Effect.Effect<void, OperationEffectFailure, R>;
  };
}

interface AtomicRenderProcess {
  // Every evaluation joins the same single captured ProcessRunner promise.
  readonly result: Effect.Effect<RunResult, OperationEffectFailure>;
  abort(reason?: unknown): Effect.Effect<void, OperationEffectFailure>;
  detach(): Effect.Effect<void, OperationEffectFailure>;
}

function executeAtomicRenderEffect<Prepared, R>(
  options: AtomicRenderRequest,
  publication: AtomicRenderPublication<Prepared, R>,
): Effect.Effect<
  { output: AtomicRenderOutput; prepared: Prepared },
  OperationEffectFailure,
  R | AtomicRenderPlatform
>;

interface MutationLease {
  close(): Promise<void>;
  unlinkIfOwned(): Promise<void>;
}
function acquireMutationLease(
  directory: string, options: MutationLockOptions,
): Promise<MutationLease>;

function withOutputPublicationLeaseEffect<A, R>(
  application: ApplicationContext,
  target: OutputPublicationTarget,
  use: Effect.Effect<A, OperationEffectFailure, R>,
): Effect.Effect<A, OperationEffectFailure, R>;

function reconcileProjectRenderEffect(
  application: ApplicationContext,
  input: unknown,
  execution: ProjectRenderExecutionIdentity,
  control: ProjectRenderReconciliationControl,
): Effect.Effect<ProjectRenderReconciliation>;

interface SchedulerNodePlanner {
  // Existing Promise prepare/plan/reconcile signatures remain.
  reconcileEffect?(request: NodeReconciliationRequest):
    Effect.Effect<NodeReconciliation, WorkflowFailure>;
}
```

`AtomicRenderRequest` retains the existing abort signal, invocation, runner, byte/duration limits, staging path, fresh-output mode and failure label. It excludes the two Promise publication callbacks. `AtomicRenderPlatform` supplies closed typed effects for native temporary-path admission, starting an `AtomicRenderProcess`, output-size inspection, descriptor integrity/hash/sync, output publication, companion invalidation and temporary cleanup. Starting returns a handle to one captured native runner Promise. Interruption signals abort and joins that same promise under masking before listener, temporary-file or lease cleanup; interrupting a Promise wait is not settlement evidence. The monitor is a scoped fiber whose active native stat-and-decision step settles before shutdown. The program owns monitoring and sequencing. Production supplies the native layer; deterministic tests replace that same service seam. Pure invocation generation and the descriptor hashing loop remain native helpers.

The existing async `executeAtomicRender` signature adapts its Promise callbacks into the native publication interface and unwraps through the existing compatibility root. The native project lifecycle composes the program directly, obtains its typed prepared receipt as a return value, and supplies its service layer at the operation boundary. No runtime is constructed inside a native lease, publication callback or reconciliation program.

The physical lease extraction hides the descriptor and snapshot behind `close` and `unlinkIfOwned`. It reuses the existing inode acquisition/reclamation algorithm. `withMutationLock` retains its native Promise facade and nested-finally close-then-conditional-unlink ordering. Output admission has one shared keyed reservation authority across its Promise and Effect entry points; extracting a native acquire/release ticket is acceptable where it preserves current queued admission without a second runtime. The Effect entry composes the critical section itself, awaits native acquisition without letting a late handle escape, and joins native settlement before release. It must not adapt the complete `use` program back into a Promise callback. The native Promise facade remains for nonmigrated callers.

`priorCause` is not added to a foreign Error, public result or durable receipt. Compatibility unwrapping still throws only the selected native rejection value, including `undefined`, `null` and `false`. A finalizer failure preserves its existing public precedence while recording the earlier full Cause internally. Existing ingest's deliberately combined-failure policy is unchanged.

The independent reviewer required two explicit implementation obligations. First, process abort is fallible: capture its Exit and still join the original retained process result even if abort fails. Second, compatibility finalization exposes exactly one selected `OperationEffectFailure` at the top-level Exit; previous Causes belong only in its private `priorCause`. Combining previous and cleanup failures as multiple top-level failures would activate the existing public AggregateError path and is forbidden for these legacy facades. Production-seam tests must assert exact primitive/Error identity, an unchanged foreign Error object, and no private sentinel in public results, receipts or projections.

Render reconciliation handles every expected native failure through its current `conflict` projection, including cancellation. The planner retains the exact `conflict` to `incompatible` mapping and separate `retry`/`completed` meanings. Its additive native slot composes in the existing workflow owner. Nonrender reconciliation may continue through the existing Promise adapter; no new runtime or broad recovery rewrite is required.

### Preservation requirements

- Keep operation kinds/versions, input/output schemas, graph/node identity, exact tool bindings, receipt/precommit/reuse bytes and public portable declaration graphs unchanged. Keep the candidate renderer ABI while output semantics remain unchanged. Preserve v1 resources and v2/v3 capacity-one `project-render` admission.
- Keep cancellation effective before the final fence. Mask interruption around the existing `beforePublication` call and through precommit/output/receipt settlement so cancellation requested inside a successful fence cannot interrupt before the next publication step. A failed fence still refuses publication. After an authoritative output, complete its prepared receipt or leave exact recoverable evidence; never rerender ambiguity.
- Preserve no-follow/path/inode/length/hash checks, private staging, fsync, no-replace publication and the exact ProcessRunner kill/reap contract. Monitor interruption is not child exit proof. The scheduler observer may time out while native work still owns physical claims.
- Preserve distinct legacy modes: recording/project CLI calls replace by rename with old-receipt invalidation and beside-output staging; media effects use fresh-output linking, pinned-input revalidation and their outer descriptor close. Do not impose workflow precommit or fresh-only output on those callers.
- Preserve candidate recovery under the output lease and legacy exact receipt recovery through its current idempotent/no-replace path. A broader locking policy is not part of this refactor.
- The physical lock is also used by project publication, portable operations and CLI dispatch. A minimal handle extraction does not migrate those workflows. Retain their Promise contracts and finalizer precedence.

### Continuation work order and verification

1. Freeze the service, publication-value, lease and reconciliation interfaces with independent review.
2. Extract the native lease and atomic platform primitives without changing their authority. Implement the Effect monitor/encoder owner and legacy facade; prove actual service-seam cancellation, limits, failure-presence and finalizer precedence.
3. Compose the complete project lifecycle and recovery, remove the superseded Promise domain owner and mutable callback receipt state, and connect the planner's native recovery slot.
4. Register exact architecture roles; verify ordinary compiler/type graphs and paired negative architecture fixtures. Keep Effect 3.22.1, the existing compiler and all package/version/release controls unchanged.
5. Run focused atomic-render, project render, output/project lease, mutation-lock, portable-operation, renderer/receipt/media-effects, planner/scheduler and native-boundary tests. Add deterministic final-fence cancellation, delayed reap/lease release, concurrent recovery, falsey native failure and combined cleanup failure cases at production seams. Existing pixel/audio recipes and native constraints remain independent assertions.
6. Record exact commands, source state and focused results here. Obtain independent source review. The integrator performs one KB refresh/check and fresh full aggregate plus applicable native/package/CI gates; this worker does not publish or start paid/live/browser workflows.

If the scoped native interfaces cannot preserve physical custody or the existing Promise exception/publication laws, stop at the reviewed source checkpoint and report the blocking contract. Do not substitute a wrapper-only migration, weaken an invariant or expand into pure project/format/render loops.

### Continuation implementation and review

The complete native render program now supplies its local application and atomic-platform services once at the operation boundary. All three operation versions use it. Candidate adoption and legacy exact-receipt recovery compose native programs; their Promise facades remain local compatibility entry points. Prepared receipt data is a typed return value, replacing mutable callback state. The shared atomic owner replaces the polling timer with a scoped monitor, captures the original process completion once, and joins active native work before listener, descriptor, temporary-file and physical-lease cleanup.

The optional planner `reconcileEffect` runs in the existing workflow owner. Custody is retained before physical host acquisition begins and until the native callback and physical release settle. The observer may still return early with a running record and a released durable run claim. Native-only planners are accepted, native dispatch wins when both slots exist, and selected methods retain their planner receiver. Neither slot changes discovery, resource vectors, portable types or durable identity.

Independent review corrected three compatibility gaps before convergence: finite descriptor verification must settle before close; planner methods must retain `this`; and concurrent native reads must preserve the first observed rejection. The existence-check groups now record first failure through an explicit Option, join all admitted reads, and keep later Causes private. They do not infer failure presence from a rejection value or choose an error by input position. Fresh publication and candidate adoption retain their different cancellation fences.

Focused evidence on the continuation includes 164 passing tests and 970 assertions across 13 affected-contract files. Two existing real-render integration cases skipped because `rsvg-convert` is unavailable; FFmpeg and FFprobe were available, and the other real FFmpeg renderer/media-effect cases passed. The selected suites cover atomic rendering, exact project recovery, mutation/output/project leases, portable operations, receipt reconciliation, application planning, scheduler ownership and workflow effects. A subsequent four-case production-lstat rerun passed after a type-only failure-branch correction, covering Error/undefined/null/false and first failures in either input position.

The existing architecture policy passed with eight tests and 38 assertions, including new negative fixtures showing that adapter role does not permit runtime construction or dropped Effects. Ordinary SDK and desktop compilers passed; the focused CLI build bundled the actual new owner and facade. Focused ESLint passed. The worker records full command/log receipts outside the repository; the root commands are:

```sh
bun run typecheck:sdk
bun run typecheck:desktop
bun run check:effect
bun run build:desktop:cli
bun test ./apps/desktop/cli/atomic-render.test.ts ./apps/desktop/cli/atomic-render-effects.test.ts ./apps/desktop/cli/mutation-lock.test.ts ./apps/desktop/cli/project-renderer.test.ts ./apps/desktop/cli/media-effects-service.test.ts ./apps/desktop/application/output-publication-lease.test.ts ./apps/desktop/application/project-publication-lease.test.ts ./apps/desktop/application/operations/atet-portable.test.ts ./apps/desktop/application/operations/render/project.test.ts ./apps/desktop/application/verified-receipt-reconciliation.test.ts ./apps/desktop/code/application-node-planner.test.ts ./apps/desktop/code/scheduler.test.ts ./apps/desktop/code/workflow-effects.test.ts
```

These are focused worker receipts, not full integration or release evidence. The integrator still owns final KB refresh/check, the complete exact-tree aggregate, package/native/CI admission and delivery. The worker preserved pure recipes, candidate renderer ABI, schemas, package version, compiler and release controls. Scoped tests prove the owned native contracts; they do not prove that cancellation can force an arbitrary foreign Promise to settle.

### Release candidate integration

The integrated source candidate is 3.2.1. Twenty version-bearing files changed
through 23 exact version substitutions; source, native bundle, CLI, schema URL,
examples and current-provenance fixtures agree. The version-one schema content,
operation wire versions, renderer ABI, dependency versions and lockfiles remain
unchanged. New receipts carry the candidate's tool provenance. Completed receipt
validation continues to validate recorded values; it does not rewrite old data.

Active durable graphs remain bound to their exact `applicationBuild`. Both the
runtime source change and package-version change alter that identity, so an old
active graph cannot transparently resume under 3.2.1. Finish or recover it using
its exact original host, or explicitly start a new run. This preserves the
existing scheduler admission rule.

The website deploys from `main` before npm promotion may complete. Its small local
`published-release.json` therefore retains verified-public 3.2.0 while source and
native validators require candidate 3.2.1. A strict pure parser validates the
version and exact immutable Release URL before template interpolation. The
rendered HTML and agent Markdown retain their prior public version and install
targets. Nine focused tests passed with 222 assertions. The publishing runbook
requires a normal status follow-up after npm, annotated tag and immutable Release
verification; candidate preparation does not claim public availability.

Normal SDK and desktop CLI generation completed with stable source inputs.
One npm 11.19.0 measurement under Bun 1.3.14 and Node 24.20.0 produced 330 files,
3,484,863 compressed bytes and 8,822,950 payload bytes. All archive payload bytes
matched the candidate source, including the two new atomic-render modules; tests
were excluded. Existing package limits remain unchanged. This preparation does
not replace the required complete aggregate, installed-consumer smoke, native
checks or final release provenance verification.

## Media transforms continuation

Audio effects and color grading now need one native operation owner from input
and capability binding through probe, workspace, pinned-input rendering,
content-addressed output, receipt and completion checkpoint. The existing
operation kinds, schemas, media filters, encoders and publication laws remain
unchanged. Physical import staging is a separate continuation.

Both operations use `MediaTransformPlatform` for closed native boundaries. The
default renderer directly composes `LocalMediaEffectsService.renderAudioEffect`
or `renderColorEffect`, which owns the pinned input and existing atomic render
program. Its async methods remain compatibility facades for CLI consumers.
Native operation dispatch does not call those facades or construct another
runtime. The replaced operation and pinned-input `try/finally` owners are
removed.

Finite native descriptor, probe and publication work remains owned until its
original Promise settles. Interrupting a fiber cannot close an input used by a
still-running encoder or remove a workspace used by a late probe. A workspace
acquired after cancellation must still be released. Caller-supplied workflow
workspaces remain borrowed. Workspace cleanup retains the old finalizer
precedence, including primitive rejection values; earlier native Causes stay
private.

The output, receipt and checkpoint continuation retains native custody after
entry. Existing AbortSignal and fresh-publication checks still decide whether
each publication is authorized. An output whose later receipt fails remains
available as an orphan; failure does not authorize deletion or rerendering.
Receipt and checkpoint schemas, exact bytes and verified-receipt reconciliation
remain authoritative.

Focused validation must cover the real registry-to-pinned-render path, held
encoder/probe/acquisition/publication work, exact cleanup identity and retained
partial publication. Existing media filters, real FFmpeg tests, CLI commands,
reconciliation and architecture checks remain required. The integrator owns
package/version/generated convergence, one fresh aggregate and delivery.


## Physical import staging continuation (2026-09-07)

`media.ingest` now composes `ingestProjectMediaEffect` beneath its existing
operation owner. `MediaIngestPlatform` admits only native filesystem, descriptor,
stream, process and durability calls; its named Live Layer does not create a
runtime. The pure probe/parser and asset construction live in
`media-ingest-model.ts`. Existing CLI Promise exports remain compatible. Native
media transforms also compose the default `probeProjectMediaEffect`; injected
Promise test/host ports remain one explicit foreign boundary.

Stage acquisition owns source and temporary descriptors through their real
settlement and custody handoff. The pipeline retains Node backpressure and
partial positional writes, then rechecks the source and fsyncs the still-open
staged inode. Probe settles before cleanup; content-addressed publication is
masked across no-replace link and directory fsync/EEXIST verification. Cancellation
cannot split an admitted native call from cleanup. It cannot prove native process
exit or roll back a linked blob after a durability/acknowledgment failure. Existing
outer project leases, capability checks, receipt/checkpoint authority, parsers,
probe arguments and DTOs remain authoritative.

Three explicitly qualified robustness corrections accompany this migration.
First, source close after successful staging can no longer strand the temporary
file before the caller receives disposal custody: cleanup retains the original
source-close rejection publicly and any cleanup failure privately. Temporary
cleanup checks the captured descriptor inode; a failed exclusive open or a
substituted/ambiguous path does not authorize unlinking that entry. These are
observations under existing private-directory/lease authority, not an atomic
compare-and-unlink primitive. Ordinary failed-stage precedence remains temporary
close, removal, source close; later disposal remains last.

Second, Node callback streams treat falsey callback errors as success. The native
writer now records rejection presence separately, signals stream failure with an
actual Error, and projects the original value (including undefined/null/false).
Third, failed pipeline observation does not itself join a custom pending write.
The adapter observes the pipeline outcome, joins its admitted reader and writer,
then closes descriptors/removes staging; a selected pipeline failure stays public and a late
writer failure stays in private priorCause. The original adapter failed all four
production-seam regressions before this repair: three falsey write failures were
reported as success, and a source-stream failure closed a descriptor while a write
acknowledgment remained held. The tests use real descriptors and the actual stream,
with explicit causal gates rather than elapsed-time races. Further focused tests
identified pinned Bun's FileHandle-backed ReadStream as a second descriptor-close
owner even with autoClose disabled. The adapter now uses the same built-in 64KiB
ReadStream/backpressure with a borrowed numeric fd and explicit native read/stream
close callbacks. Stream close never closes the descriptor; the operation owner
joins any already-admitted read before closing it. Falsey read failures also keep
their original rejection rather than being treated as EOF. This is an explicit
custody repair, not a replacement streaming algorithm.

Focused convergence and independent review are recorded by the implementation
owner; the integration owner still owns the complete repository/native/package
gates and release. No historical applicationBuild receipt is promoted into proof
for this changed source.

## Version 3.2.2 candidate preparation

The complete media-transform and physical import-staging continuation is prepared as source candidate 3.2.2. The verified-public website datum, README installation commands and Agent Skill installation guidance remain at 3.2.1 until the documented immutable release sequence succeeds. Source, native-app, operation producer and public-schema URL identities advance together; the diagram wire schema stays version one. Direct remains a development-only immutable v0.7.20 dependency.

The physical import phase passed 61 focused tests with 358 assertions, desktop TypeScript, changed-file lint and the architecture gate, whose paired fixtures passed nine tests with 46 assertions. Independent review accepted the borrowed-descriptor stream adapter and causal source/read/write/cleanup regressions. Historical failed checks above remain evidence of the repaired cases. Normal generated SDK and CLI convergence, candidate identity checks, package inventory review and the complete integration gate are separate delivery requirements; this preparation does not claim those gates or a public release.

The host application-build digest changes with the production source and package identity. A plan bound to an older host build cannot silently resume under this candidate. Complete it with its exact original host or use the existing explicit restart/recovery route with normal admission and paid-attempt safeguards. Existing completed artifacts and their recorded producer identities are not rewritten.
