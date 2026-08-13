# Contents

- `context.ts` – adapter-neutral clocks, paths, subprocess, capability, recording, and application service ports.
- `errors.ts` – the shared application failure taxonomy consumed by CLI and code-mode adapters.
- `operation.ts` – closed operation identities, policies, lifecycle contracts, and bounded summaries.
- `operation-completion-checkpoint.ts` – exact-node private completion checkpoints for interrupted receipt-backed operations.
- `html-overlay-integrity.ts` – full-runtime, browser, module, document, and resource Merkle binding for browser renders.
- `html-overlay-browser-runtime.ts` – complete browser-tree manifests, internal-symlink validation, direct native-app enforcement, bounded Google code-signature provenance, and exact capability binding.
- `registry.ts` – the versioned host-owned operation catalog and discovery surface.
- `verified-receipt-reconciliation.ts` – fail-closed recovery that rebinds checkpoints to authoritative analysis, media, and receipt evidence.
- `default-registry.ts` – the explicit production catalog assembly and injected analysis identities.
- `operation-completion-checkpoint.ts` and `verified-receipt-reconciliation.ts` – exact node-plan completion evidence and host-artifact recovery for receipt-backed operations.
- `index.ts` – the internal application-layer export surface.
- `operations/` – typed application operations extracted from CLI orchestration.
- colocated deterministic and property tests.

# Guidelines

- Keep application operations independent from CLI arguments, stdout, human formatting, and workflow graph implementation.
- Treat operation input as a request, never as authorization. Consent, credentials, confirmations, and paid-call grants arrive through a separate adapter-owned envelope.
- Parse every operation input and output through its owned schema. Keep operation kinds, versions, policies, lifecycle classes, and resource claims host-owned and exhaustive.
- Preserve authoritative analysis, render, media-effect, Gateway, and recording receipts. Workflow node receipts reference those records rather than replacing them.
- Keep project preparation on immutable snapshots. Recheck the complete project and current-plan hashes under the publication lease before committing one recoverable generation.
- Do not acquire the CLI mutation lock inside an operation invoked beneath an existing lease. Explicit publication coordinators own and pass lease context.
- Keep secrets, privileged handles, raw provider options, and credentials outside serialized operation input, output, summaries, and receipts.
