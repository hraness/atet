---
title: Canonical GitHub distribution
type: plan
area: delivery
status: in-progress
---

# Canonical GitHub distribution

## Outcome and constraints

Make immutable GitHub Releases the canonical Atet distribution. Preserve the package name, CLI, SDK exports, historical releases, dual-use declaration, and optional npm staging. npm availability and interactive promotion must not block a GitHub release. npm may mirror only the exact verified canonical archive.

Build one bounded archive from the protected annotated release tag, verify its isolated Bun and npm installations, and bind the archive, packing receipt, manifest and checksums to hosted GitHub provenance. Separate read-only product verification from attestation and publication. Preserve owner and repository identity, current-main authority and helper closure, stable ordering, native and VTracer acceptance, immutable release assets, and uncertain-write reconciliation.

## Work

1. Replace npm-dependent tag and GitHub release authority with checked source, archive and GitHub provenance authority.
2. Publish the five canonical release assets through a verified draft. Keep npm staging downstream with its existing owner, environment, configuration, intent and monotonic-version guards.
3. Document GitHub installation and updating without advertising an unpublished artifact. Preserve the verified public version independently of the candidate.
4. Review the complete impact, run focused hostile-input and lifecycle tests, the required local aggregate and native acceptance, and fresh current-head Required CI. The integration owner admits the release; verify live assets and isolated installation before claiming delivered availability.

## Recovery and validation

Never overwrite an asset, move a tag, recreate a release, or republish an npm version. Reconcile only matching Actions-authored state; ambiguous or mismatching state stops with exact evidence. Keep existing installed versions and user media unchanged.

Initial source is main `7a0bd73337db589667121ec66f59c092bc11a5da`. GitHub reports immutable public `v3.2.2`; `v3.2.3` is absent. Relevant consumers retain immutable older GitHub pins, so no coordinated consumer release is required. Existing gates remain `bun run check`, selected Required CI jobs, the five-platform official VTracer matrix and macOS shell tests/package. A site change also retains its explicit isolated install and pinned Node/Chromium preview proof.

The optional mirror retains its full source gate on the immutable artifact's source, with pinned Chromium, followed by exact canonical provenance and isolated archive installation under current-main admission helpers. Its workflow and artifact source identities stay separate so later documentation changes cannot block mirroring a verified release. The managed repository baseline was refreshed to local-efficiency 0.4.1; repo-adoption reports CURRENT.
