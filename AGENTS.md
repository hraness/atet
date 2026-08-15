# Contents

- `src/` – portable declarative and imperative workflow SDKs, host-resource admission, diagrams, direct Vercel AI Gateway generation, local vectorization, semantic operations, MCP, and canvas integration.
- `apps/desktop/` – the canonical `atet` CLI, complete local media host, durable scheduler, HTML and Three.js overlays, native capture helpers, frontend, and desktop shell.
- `apps/web/` – the dependency-free static `atet.sh` site, with no API, account, or credential surface.
- `packages/scene/` – the shared local scene-analysis contract.
- `src/code/` – portable declarative graph authoring, the closed public capability projection, compilation, planning, and execution contracts.
- `schema/` – version-one diagram JSON Schema.
- `skills/atet/` – the canonical Atet Agent Skill.
- `examples/` – checked diagram, configuration, and executable imperative and declarative Bun workflow examples.
- `scripts/` – schema, skill, package, release, and official-vectorizer verification.
- `dist/` and `apps/desktop/dist/cli/` – committed Bun-targeted entrypoints consumed by package and Git installs.
- `.github/workflows/` – routed SDK, local-host, static-site, macOS-native, official VTracer, and immutable release checks.
- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE`, and `NOTICE.md` – public documentation, policy, and terms.
- `package.json`, `tsconfig.json`, and `bun.lock` – standalone package and verification configuration.

# Guidelines

- Use Bun 1.3.14 and run `bun run check` before handing off a change.
- Keep `@hraness/atet` at the repository root. The root package owns both the portable SDK and canonical `atet` binary built from `apps/desktop/cli/main.ts`.
- Keep canonical commands namespaced as `atet diagram init|check|render`, `atet image generate|vectorize`, and the `code`, `mcp`, `canvas`, `skill`, and `doctor` surfaces.
- Keep local vectorization authentication-free and network-silent. Gateway generation reads `AI_GATEWAY_API_KEY` before `VERCEL_OIDC_TOKEN`, never persists credentials, pins the Gateway origin, bounds responses, and sets `maxRetries: 0`.
- Keep `/artifacts/`, `.env`, and `.env.*` ignored. Recordings, imported media, private project metadata, Gateway tokens, and provider options must never enter Git or a package artifact.
- Treat `vercel env run -- <command>` as the ergonomic local Vercel path. Never shell out to infer or scrape a token from the Vercel CLI.
- Preserve `.diagram.json` version one and the five same-stem render outputs: `.tldr`, light and dark SVG, and light and dark PNG.
- Keep one self-contained Atet identity. Version 2 retains `transmute` only as a one-major CLI bin alias and accepts only reviewed version-1 serialized identifiers at explicit compatibility boundaries. Do not retain predecessor branding, package names, source names, or runtime implementations.
- Preserve every immutable version-1 tag and Release. Never rewrite a historical tag or recreate a repository at the former GitHub path, because doing so would replace GitHub's compatibility redirect.
- Treat diagram source as authoritative and generated media as replaceable. Defaults may resolve mechanics but must not invent claims, labels, legends, relationships, or decorative meaning.
- Parse foreign values from `unknown`, keep output deterministic, and test every parser, protocol, operation, path, credential, and compatibility boundary.
- Keep semantic registries fixed and typed. Never accept source text, evaluation, dynamic imports, executable workspace configuration, shell commands, or caller-selected remote URLs.
- Preserve the root module and `./workflow` v0.8 imperative APIs. Add declarative graphs through `./code` and lower-level compiler contracts through `./code/advanced`; do not add `./code/testing` or `./code/workflows` exports.
- Treat explicitly imported workflow modules as trusted current-user Bun code. Compile graphs only against the host's closed capability projection, reject an unsupported capability before executor or resource admission, and do not add an open operation-registration hook.
- Treat the portable SDK and core as the canonical graph contract. The complete local host consumes that contract through its own closed projection and owns durable media execution. The Desktop shell adds only native capture, permissions, and UI.
- Model one project as immutable source plus explicit revisions, candidates, selections, and delivery variants. Keep ready work bounded by resource claims and serialize expensive encodes by default.
- Keep imperative workflows as explicitly imported trusted Bun modules over the fixed operation registry. Parse runtime input, bound and uniquely identify steps, drain dispatched work before returning, retain completed-step receipts on every failure path, and do not load caller-selected source paths.
- Keep semantic SDK, CLI, MCP, and workflow resource admission machine-global and crash-safe on macOS and Linux, with a truthful process-local fallback elsewhere. Preserve profile identity, FIFO admission for overlapping claims, callback-settlement ownership, and inherited lease descriptors through spawned vectorizer processes.
- Keep MCP paths root-relative and capability-small. Bound source bytes, arrays, shapes, edges, scale, pixels, findings, subprocess duration, and output bytes before execution.
- Keep vectorization fail-closed with checksum-pinned VTracer archives, inert rebuilt SVG, measured fidelity, and full provenance receipts. Do not add an embedded-raster fallback, upscaling model, or bundled commercial font.
- Treat a `v*` tag as a release request. Keep the tag equal to `v<package.json version>` on `main`, wait for read-only verification and the official VTracer matrix, and let only the dependent publisher create the immutable Release. Verify that it is non-draft and Latest before creating another tag.
