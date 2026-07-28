# Contents

- `auth.ts`, `credential-lease.ts`, `discovery.ts`, `generate.ts`, and `cloud-errors.ts` – frozen v0.4 cloud, OAuth, credential, and error contracts.
- `config.ts` and `artifacts.ts` – frozen `graphics.config.*` discovery and flat-command diagram adapter over canonical parsing and rendering engines.
- `operations.ts` – frozen `graphics.*` semantic registry over canonical render and vectorization engines plus the legacy cloud adapter.
- `mcp/` – frozen `hraness-graphics`, `search_graphics`, `execute_graphics`, check, and render protocol surface.
- `*.test.ts` – exact v0.4 identity, parser, JSON, credential, operation, and protocol compatibility evidence.

# Guidelines

- Treat this directory as a frozen compatibility quarantine. Do not add Transmute features here; add them to canonical source and expose them only through canonical `transmute` commands and `transmute.*` operations.
- Preserve the v0.4 `hraness.graphics` discovery authority, `hraness:graphics:production:v1` client, `com.hraness.graphics.cli` credential service, flat command inputs, `graphics.*` operation codes, and graphics MCP names exactly.
- Reuse canonical pure icons, linting, parsing, rendering, tldraw serialization, vectorization, and desktop integration. Duplicate only behavior whose public v0.4 identity or wire contract is irreducibly different.
- Never make compatibility a fallback for canonical Transmute failures. The `graphics` executable is the only entry into this boundary.
- Keep legacy vectorization login-gated even though canonical Transmute vectorization is local and authentication-free.
- Pair any compatibility fix with a regression that would fail against the v0.4 contract. Do not broaden accepted inputs or outputs while fixing a case.
- Remove this directory only in a deliberate major release after documented migration telemetry and a separately reviewed retirement decision.
