# Contributing

Issues and focused pull requests are welcome. Describe the behavior that should change, include a minimal checked source or fixture when possible, and keep unrelated cleanup out of the same patch.

Install the pinned toolchain and run the complete gate:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

Parser, layout, operation, protocol, configuration, or compatibility changes need deterministic examples. Add a property test when the behavior is a law, round trip, ordering rule, or arbitrary-input boundary. A shrunk property failure should become a named example regression.

Do not loosen byte, path, pixel, duration, process, fidelity, or credential limits to make a fixture pass. Explain and test any deliberate limit change.

The `graphics` executable is a frozen v0.4 compatibility surface. New capabilities belong under the namespaced `transmute` grammar and `transmute.*` operation registry. Compatibility changes must prove that the old grammar, JSON output, cloud identity, credential service, configuration names, environment names, and MCP tools still behave as documented.

By contributing, you agree that your contribution is licensed under the MIT License.
