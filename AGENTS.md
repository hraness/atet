# Contents

- `src/` – declarative graph and imperative workflow SDKs, host-resource admission, diagram parsing and layout, rendering, local vectorization, hosted generation, semantic operations, OAuth, MCP, canvas integration, the canonical CLI, and the v0.4 graphics compatibility boundary.
- `src/code/` – portable declarative graph authoring, the closed public capability projection, compilation, planning, and execution contracts.
- `schema/` – version-one diagram JSON Schema.
- `skills/transmute/` – the canonical Transmute Agent Skill.
- `examples/` – checked diagram, configuration, and executable imperative and declarative Bun workflow examples.
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
- Preserve the root module and `./workflow` v0.8 imperative APIs. Add declarative graphs through `./code` and lower-level compiler contracts through `./code/advanced`; do not add `./code/testing` or `./code/workflows` exports.
- Treat explicitly imported workflow modules as trusted current-user Bun code. Compile graphs only against the host's closed capability projection, reject an unsupported capability before executor or resource admission, and do not add an open operation-registration hook.
- Treat the portable SDK and core as the canonical graph contract. The complete local host consumes that contract through its own closed projection and owns durable media execution. The Desktop shell adds only native capture, permissions, and UI.
- Keep imperative workflows as explicitly imported trusted Bun modules over the fixed operation registry. Parse runtime input, bound and uniquely identify steps, drain dispatched work before returning, retain completed-step receipts on every failure path, and do not load caller-selected source paths.
- Keep semantic SDK, CLI, MCP, and workflow resource admission machine-global and crash-safe on macOS and Linux, with a truthful process-local fallback elsewhere. Preserve profile identity, FIFO admission for overlapping claims, callback-settlement ownership, and inherited lease descriptors through spawned vectorizer processes.
- Keep MCP paths root-relative and capability-small. Bound source bytes, arrays, shapes, edges, scale, pixels, findings, subprocess duration, and output bytes before execution.
- Keep vectorization fail-closed with checksum-pinned VTracer archives, inert rebuilt SVG, measured fidelity, and full provenance receipts. Do not add an embedded-raster fallback, upscaling model, or bundled commercial font.
- Treat a `v*` tag as a release request. Keep the tag equal to `v<package.json version>` on `main`, wait for read-only verification and the official VTracer matrix, and let only the dependent publisher create the immutable Release. Verify that it is non-draft and Latest before creating another tag.
