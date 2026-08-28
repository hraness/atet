<!-- kb:context scopes/repository--cdb4ee2aea69 -->
# Contents

- `src/` – portable declarative and imperative workflow SDKs, host-resource admission, diagrams, direct Vercel AI Gateway generation, local vectorization, semantic operations, MCP, and canvas integration.
- `apps/desktop/` – the canonical `atet` CLI, complete local media host, durable scheduler, HTML and Three.js overlays, native capture helpers, frontend, and desktop shell.
- `apps/web/` – the static `atet.sh` site, with a local browser bundle and a production-only anonymous pageview boundary but no API, account, or credential surface.
- `packages/scene/` – the shared local scene-analysis contract.
- `src/code/` – portable declarative graph authoring, the closed public capability projection, compilation, planning, and execution contracts.
- `schema/` – version-one diagram JSON Schema.
- `skills/atet/` – the canonical Atet Agent Skill.
- `.agents/skills/` – portable repository orchestration and knowledge-base workflows.
- `kb/` – the Git-backed Markdown vault for rationale, evidence, maintained synthesis, plans, and scoped agent context.
- `examples/` – checked diagram, configuration, and executable imperative and declarative Bun workflow examples.
- `scripts/` – schema, skill, package, release, and official-vectorizer verification.
- `dist/` and `apps/desktop/dist/cli/` – committed Bun-targeted entrypoints consumed by package and Git installs.
- `.github/workflows/` – routed SDK, local-host, static-site, macOS-native, official VTracer, and immutable release checks.
- `docs/` – current architecture, npm publication, and Vercel provider runbooks.
- `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE`, and `NOTICE.md` – public documentation, policy, and terms.
- `WRITING.md` and `STYLE.md` – internal and public prose contracts.
- `package.json`, `tsconfig.json`, and `bun.lock` – standalone package and verification configuration.

# Guidelines

- Use Bun 1.3.14 and run `bun run check` before handing off a change.
- Follow `WRITING.md` for internal prose and `STYLE.md` for public prose, preserving facts, exact terms, literals, quotations, links, and necessary uncertainty.
- Apply unreasonably robust programming when agent work is cheap. Prefer coherent cross-file correctness and focused deterministic evidence while treating production risk, provider coordination, rollout, and observation as real costs.
- Deliver changes to `main` through a current-head pull request. Keep the stable `Required` CI job green, resolve every review thread, and serialize merges. Human approval stays optional while one regular maintainer would otherwise self-review. Never force-push or bypass the gate.
- Keep this repository independently buildable. Never depend on sibling paths, Git submodules, or coordinated `main` branches; consume external Hraness packages only through reviewed immutable release tags or commits.
- Extract a shared package only after a second concrete consumer proves a stable product-neutral contract. Shared packages never import product code.
- Keep Atet's product and editor presentation local. Add `@hraness/ui` for portable accessible primitives or `@hraness/design-kit` for optional shared presentation only after concrete reuse warrants the dependency; domain layout and content remain Atet-owned.
- Freeze shared interfaces before parallel lanes begin. Give one integration owner manifests, lockfiles, generated registries, and other convergence files, then let consumers upgrade immutable releases independently.
- Keep mandatory edit-time rules in the closest `AGENTS.md`, current procedures in `docs/`, executable contracts in types, schemas, and tests, and rationale, evidence, synthesis, and plans in `kb/`. KB lanes run `bun run kb:check:lane`; the integrator performs one refresh and `bun run kb:check`.
- Keep `@hraness/atet` at the repository root. The root package owns both the portable SDK and canonical `atet` binary built from `apps/desktop/cli/main.ts`.
- Keep canonical commands namespaced as `atet diagram init|check|render`, `atet image generate|vectorize`, and the `code`, `mcp`, `canvas`, `skill`, and `doctor` surfaces.
- Keep local vectorization authentication-free and network-silent. Gateway generation reads `AI_GATEWAY_API_KEY` before `VERCEL_OIDC_TOKEN`, never persists credentials, pins the Gateway origin, bounds responses, and sets `maxRetries: 0`.
- Keep `/artifacts/`, `.env`, and `.env.*` ignored. Recordings, imported media, private project metadata, Gateway tokens, and provider options must never enter Git or a package artifact.
- Treat `vercel env run -- <command>` as the ergonomic local Vercel path. Never shell out to infer or scrape a token from the Vercel CLI.
- Treat Production as Atet's only durable Vercel environment. Do not create a custom environment, persistent Preview domain, or provider-authoritative Preview branch. Pull requests may use Vercel's built-in disposable Preview target, without production-only variables or another durable backend. Follow [the Vercel runbook](docs/vercel.md) and audit provider identity before changing this seam.
- Preserve `.diagram.json` version one and the five same-stem render outputs: `.tldr`, light and dark SVG, and light and dark PNG.
- Keep one self-contained Atet identity. Public APIs, serialized identifiers, source imports, configuration, and runtime surfaces use only Atet names.
- Preserve every immutable version-1 tag and Release. Never rewrite a historical tag or recreate a repository at the former GitHub path, because doing so would replace GitHub's compatibility redirect.
- Treat diagram source as authoritative and generated media as replaceable. Defaults may resolve mechanics but must not invent claims, labels, legends, relationships, or decorative meaning.
- Model invalid states out, parse foreign values from `unknown`, and keep output deterministic. Preserve readable regression examples; add property tests for laws, parsers, reducers, ordering, and round trips, and promote shrunk failures into named deterministic examples.
- Keep semantic registries fixed and typed. Never accept source text, evaluation, dynamic imports, executable workspace configuration, shell commands, or caller-selected remote URLs.
- Preserve the root module and `./workflow` v0.8 imperative APIs. Add declarative graphs through `./code` and lower-level compiler contracts through `./code/advanced`; do not add `./code/testing` or `./code/workflows` exports.
- Treat explicitly imported workflow modules as trusted current-user Bun code. Compile graphs only against the host's closed capability projection, reject an unsupported capability before executor or resource admission, and do not add an open operation-registration hook.
- Treat the portable SDK and core as the canonical graph contract. The complete local host consumes that contract through its own closed projection and owns durable media execution. The Desktop shell adds only native capture, permissions, and UI.
- Model one project as immutable source plus explicit revisions, candidates, selections, and delivery variants. Keep ready work bounded by resource claims and serialize expensive encodes by default.
- Keep imperative workflows as explicitly imported trusted Bun modules over the fixed operation registry. Parse runtime input, bound and uniquely identify steps, drain dispatched work before returning, retain completed-step receipts on every failure path, and do not load caller-selected source paths.
- Keep semantic SDK, CLI, MCP, and workflow resource admission machine-global and crash-safe on macOS and Linux, with a truthful process-local fallback elsewhere. Preserve profile identity, FIFO admission for overlapping claims, callback-settlement ownership, and inherited lease descriptors through spawned vectorizer processes.
- Keep MCP paths root-relative and capability-small. Bound source bytes, arrays, shapes, edges, scale, pixels, findings, subprocess duration, and output bytes before execution.
- Keep vectorization fail-closed with checksum-pinned VTracer archives, inert rebuilt SVG, measured fidelity, and full provenance receipts. Do not add an embedded-raster fallback, upscaling model, or bundled commercial font.
- Follow `docs/publishing.md` for the interactive npm bootstrap and later releases. Preserve `contentPolicy.class=dual-use` and the root `DISCLOSURE` in every package. After bootstrap, trust only `.github/workflows/npm-stage.yml` with `npm stage publish` permission bound to the `npm-stage` environment. Keep that environment restricted to `main` with no required deployment reviewers so its only OIDC job automatically stages the reviewed artifact after verification. Disallow traditional publishing tokens and require npm two-factor authentication for the separate public approval. Let a stable package version change on `main` start that workflow automatically; retain manual dispatch only to recover through the same fail-closed pipeline.
- Treat a `v*` tag as a release request. Publish and verify the exact npm artifact first. Keep the tag equal to `v<package.json version>` on `main`, wait for read-only source-versus-registry verification and the official VTracer matrix, and let only the dependent publisher create the immutable Release. Verify that it is non-draft and Latest before creating another tag.
