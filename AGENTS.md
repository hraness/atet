# Contents

- `src/` – diagram parsing and layout, rendering, local vectorization, hosted generation, semantic operations, OAuth, MCP, canvas integration, the canonical CLI, and the v0.4 graphics compatibility boundary.
- `schema/` – version-one diagram JSON Schema.
- `skills/transmute/` – the canonical Transmute Agent Skill.
- `examples/` – checked diagram and configuration examples.
- `scripts/` – schema, skill, package, release, and official-vectorizer verification.
- `dist/` – committed Bun-targeted JavaScript and declarations consumed by immutable GitHub installs.
- `.github/workflows/` – read-only branch checks, official VTracer matrix verification, and checks-gated immutable releases.
- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE`, and `NOTICE.md` – public documentation, policy, and terms.
- `package.json`, `tsconfig.json`, and `bun.lock` – standalone package and verification configuration.

# Guidelines

- Use Bun 1.3.14 and run `bun run check` before handing off a change.
- Keep canonical commands namespaced as `transmute diagram init|check|render`, `transmute image generate|vectorize`, `transmute auth login|logout|status`, and the `code`, `mcp`, `canvas`, `skill`, and `doctor` surfaces.
- Keep canonical local vectorization authentication-free and network-silent. Hosted generation remains authenticated, bounded, idempotency-keyed, and non-retried after an ambiguous dispatch.
- Preserve `.diagram.json` version one and the five same-stem render outputs: `.tldr`, light and dark SVG, and light and dark PNG.
- Preserve the `graphics` v0.4 flat grammar, JSON stdout, `graphics.*` codes, graphics configuration and environment names, old credential service and cloud contract, and graphics MCP tools inside the explicit compatibility boundary. The legacy `skill` command installs the one canonical Transmute skill.
- Treat diagram source as authoritative and generated media as replaceable. Defaults may resolve mechanics but must not invent claims, labels, legends, relationships, or decorative meaning.
- Parse foreign values from `unknown`, keep output deterministic, and test every parser, protocol, operation, path, credential, and compatibility boundary.
- Keep semantic registries fixed and typed. Never accept source text, evaluation, dynamic imports, executable workspace configuration, shell commands, or caller-selected remote URLs.
- Keep MCP paths root-relative and capability-small. Bound source bytes, arrays, shapes, edges, scale, pixels, findings, subprocess duration, and output bytes before execution.
- Keep vectorization fail-closed with checksum-pinned VTracer archives, inert rebuilt SVG, measured fidelity, and full provenance receipts. Do not add an embedded-raster fallback, upscaling model, or bundled commercial font.
- Treat a `v*` tag as a release request. Keep the tag equal to `v<package.json version>` on `main`, wait for read-only verification and the official VTracer matrix, and let only the dependent publisher create the immutable Release. Verify that it is non-draft and Latest before creating another tag.
