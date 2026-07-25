# Contents

- `src/` – typed source parsing, deterministic layout, SVG/PNG rendering, bounded raster-to-SVG conversion, `.tldr` interoperability, desktop discovery, and the CLI.
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
- Keep semantic layout additive and narrow. Source order may place shapes but
  must not create edges; fail impossible constraints rather than silently
  shrinking shapes, shortening gaps, or changing supplied relationships.
- Keep raster conversion fail-closed: bound encoded input, decoded dimensions
  and pixels, duration, emitted bytes, and paths; rebuild tracer output from
  inert geometry rather than passing through foreign SVG.
- Support bounded vectorization on macOS and Linux. Keep Windows fail-closed
  with `tool_platform` until VTracer output can cross a bounded streaming
  boundary; a pinned Windows binary is not evidence that conversion is safe.
- Verify downloaded tool archives and extracted binaries by pinned SHA-256.
  Record the VTracer binary hash and the full version map reported by the
  loaded Sharp/libvips stack in conversion receipts; do not describe component
  versions as binary hashes or add an embedded-raster fallback, upscaling
  model, or bundled font.
- Keep agent tools root-relative and capability-small. MCP mode must not
  execute workspace configuration, reveal absolute paths, accept traversal or
  remote URLs, or write anything except the documented replaceable
  derivatives. It is a trusted-local-workspace tool boundary, not an operating
  system sandbox against concurrent same-user filesystem mutation.
- Enforce MCP source and raw-array complexity limits before semantic parsing,
  bound returned findings, and keep failure results compatible with declared
  success schemas by omitting structured content on errors.
- Run `bun run check` before release and commit the resulting `dist/` files with their matching source.
- Treat a `v*` tag as a release request, not a completed release. Before tagging, confirm repository-level immutable releases are enabled; use a strictly increasing stable package version, keep the tag equal to `v<package.json version>` on `main`, and let the read-only verification job complete before its write-scoped publisher creates the Release. Do not create the next tag until that workflow and Release are verified because GitHub concurrency is not a durable queue. After tagging, verify the matching non-draft immutable Release is Latest.
