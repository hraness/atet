# Contents

- `src/` – typed spec parsing, SVG/PNG rendering, `.tldr` interoperability, desktop discovery, and the CLI.
- `dist/` – committed Bun-targeted CLI and programmatic entrypoints used by immutable GitHub installs.
- `schema/` – the public JSON Schema for authored diagram specifications.
- `skills/diagram/` – the reusable Agent Skill shipped with the package.
- `examples/` – small literal specifications and optional adapter examples.
- `scripts/` – package-boundary verification.

# Guidelines

- Keep the default runtime open source and headless. Do not add the tldraw SDK or tldraw Offline as runtime dependencies.
- Treat authored specifications as the source of truth; generated `.svg`, `.png`, and `.tldr` files are replaceable derivatives.
- Follow prompts literally. Defaults may resolve mechanics but must not add claims, labels, legends, or decorative meaning.
- Keep default fonts and icons small and redistributable. Custom commercial fonts and third-party icon packs belong in user configuration, not this repository.
- Parse foreign data from `unknown`, preserve deterministic output, and test every compatibility boundary.
- Run `bun run check` before release and commit the resulting `dist/` files with their matching source.
