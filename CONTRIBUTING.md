# Contributing

Issues and focused pull requests are welcome. Describe the behavior that should change, include a minimal checked source or fixture when possible, and keep unrelated cleanup out of the same patch.

Install the pinned toolchain without dependency lifecycle scripts:

```sh
bun install --frozen-lockfile --ignore-scripts
```

Run the relevant focused local checks while iterating:

```sh
bun run check:sdk
bun run check:desktop
bun run check:web
```

After the tree converges, independently review the complete diff and its impact. Fresh complete CI may own the final source aggregate when Plan, Atet standalone boundary, Atet SDK, Atet local runtime, Atet site, Atet packed consumer, Atet macOS shell and Required all succeed. Required alone accepts routed skips; a skipped, missing, failed, cancelled or incomplete job does not qualify as complete CI. Bind the receipt to the exact PR head, the current authoritative `refs/heads/main`, the checked integration tree, and the CI run, attempt and Required job. Recheck those identities before merging; a stale PR base field is not current-main evidence.

The CI coverage contract in `scripts/release-workflow.test.ts` preserves the full source phases, their order within each job, post-build standalone scans, committed-output cleanliness, pinned browser verification and macOS acceptance. Independent jobs build disjoint outputs; the package job installs the committed SDK and CLI bytes whose reproduction the build jobs verify. Review workflow, command, test-discovery, deadline, platform or coverage changes against the prior required coverage. Editing coverage assertions cannot itself certify a reduction.

Use `bun run check` as the complete local fallback when CI is unavailable, partial, or its coverage or ordering is uncertain. Preserve explicit local, native, browser, coupled-run, installation and live acceptance, including the site's isolated install and pinned Chromium proof when its inputs change. Canonical release and optional npm-mirror workflows retain their complete gates. Diagnose observed failures or stalls even when CI passes; successful CI does not explain a local failure. Keep host and repository scheduling and process custody intact.

Parser, layout, operation, protocol, configuration, or scheduler changes need deterministic examples. Add a property test for a law, round trip, ordering rule, or arbitrary-input boundary. A shrunk property failure should become a named regression.

Keep the portable declarative graph SDK canonical in `src/code/`. The complete local host extends that fixed model under `apps/desktop/`; it does not maintain a competing graph contract. Public local-host entrypoints use `@hraness/atet/local/*`.

Generation uses Vercel AI Gateway directly. Do not add an account service, session store, custom OAuth flow, hosted proxy, billing dependency, or browser credential field. Tests must use inert credentials and controlled transports.

Do not loosen byte, path, pixel, frame, duration, process, fidelity, download, or resource-admission limits to make a fixture pass. Explain and test any deliberate limit change.

By contributing, you agree that your contribution is licensed under the MIT License.
