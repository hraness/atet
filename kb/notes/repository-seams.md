---
title: Repository seams
type: concept
tags:
  - architecture
  - dependencies
  - parallel-work
---

# Repository seams

Atet is a standalone public SDK, CLI, desktop host, and static site. Its portable graph and scene contracts may be shared inside this repository, while media-host behavior, native capture, and product presentation remain Atet-owned. External Hraness code is consumed only from immutable reviewed commits or releases; Atet does not acquire Accounts, billing, or suite-auth authority.

Shared interfaces are frozen before parallel implementation lanes begin. One integration owner changes manifests, lockfiles, generated registries, or other convergence files. Consumers upgrade immutable releases independently, so no repository requires coordinated `main` branches or a sibling checkout.

All committed knowledge is public-safe and excludes credentials, private media, imported projects, provider payloads, and unpublished operating context.
