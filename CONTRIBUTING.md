# Contributing

Issues and focused pull requests are welcome. Describe the behavior that should change, include a minimal checked source or fixture when possible, and keep unrelated cleanup out of the same patch.

Install the pinned toolchain and run the complete gate:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

Use a narrower command while iterating:

```sh
bun run check:sdk
bun run check:desktop
bun run check:web
```

Parser, layout, operation, protocol, configuration, or scheduler changes need deterministic examples. Add a property test for a law, round trip, ordering rule, or arbitrary-input boundary. A shrunk property failure should become a named regression.

Keep the portable declarative graph SDK canonical in `src/code/`. The complete local host extends that fixed model under `apps/desktop/`; it does not maintain a competing graph contract. Public local-host entrypoints use `@hraness/atet/local/*`.

Generation uses Vercel AI Gateway directly. Do not add an account service, session store, custom OAuth flow, hosted proxy, billing dependency, or browser credential field. Tests must use inert credentials and controlled transports.

Do not loosen byte, path, pixel, frame, duration, process, fidelity, download, or resource-admission limits to make a fixture pass. Explain and test any deliberate limit change.

By contributing, you agree that your contribution is licensed under the MIT License.
