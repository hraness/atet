---
title: Atet desktop CLI context
type: agent-context
scope: apps/desktop/cli
tags:
  - architecture
  - context-engineering
---

# Atet desktop CLI context

The desktop CLI is a bounded command surface over Atet-owned host capabilities. Its guide remains normative for parser, path, credential, subprocess, and receipt rules. Commands must reject unsupported capability or untrusted path input before execution and preserve deterministic, secret-free evidence.

The repository-wide dependency and parallel-work contract lives in [[notes/repository-seams|repository seams]].
