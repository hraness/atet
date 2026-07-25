# Contents

- `src/` – typed spec parsing, SVG/PNG rendering, `.tldr` interoperability, desktop discovery, and the CLI.
- `dist/` – committed Bun-targeted CLI and programmatic entrypoints used by immutable GitHub installs.
- `schema/` – the public JSON Schema for authored diagram specifications.
- `skills/graphics/` – the reusable Agent Skill shipped with the package.
- `examples/` – small literal specifications and optional adapter examples.
- `scripts/` – package-boundary verification.
- `.github/workflows/` – read-only branch validation and checks-gated immutable GitHub Release automation.

# Guidelines

- Keep the default runtime open source and headless. Do not add the tldraw SDK or tldraw Offline as runtime dependencies.
- Treat authored specifications as the source of truth; generated `.svg`, `.png`, and `.tldr` files are replaceable derivatives.
- Follow prompts literally. Defaults may resolve mechanics but must not add claims, labels, legends, or decorative meaning.
- Keep default fonts and icons small and redistributable. Custom commercial fonts and third-party icon packs belong in user configuration, not this repository.
- Parse foreign data from `unknown`, preserve deterministic output, and test every compatibility boundary.
- Run `bun run check` before release and commit the resulting `dist/` files with their matching source.
- Treat a `v*` tag as a release request, not a completed release. Before tagging, confirm repository-level immutable releases are enabled; use a strictly increasing stable package version, keep the tag equal to `v<package.json version>` on `main`, and let the read-only verification job complete before its write-scoped publisher creates the Release. Do not create the next tag until that workflow and Release are verified because GitHub concurrency is not a durable queue. After tagging, verify the matching non-draft immutable Release is Latest.
