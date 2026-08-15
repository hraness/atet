# Contents

- Canonical root modules – Atet CLI, imperative workflow, diagram, canvas, artifact, direct Gateway generation, operation, MCP, and desktop-integration contracts.
- `code/` – canonical portable declarative graph authoring, closed public capability projection, compiler, plan, and execution contracts.
- `vectorize/` – bounded local raster decoding, VTracer supervision, SVG sanitization, measurement, provenance, and worker isolation.
- `*.test.ts` and `*.property.test.ts` – deterministic examples, parser laws, and standalone consumer evidence.

# Guidelines

- Keep canonical implementation in this source root and expose new behavior only through `atet` commands, `atet.*` operations, the additive `./code` graph SDK, and the compatible `./workflow` SDK.
- Preserve the root module and `./workflow` v0.8 imperative APIs. Keep declarative authoring in `./code`, lower-level compiler contracts in `./code/advanced`, and testing or built-in workflow helpers outside the public export map.
- Keep the declarative SDK and portable core canonical. The complete local host consumes that graph model and owns durable media execution. The Desktop shell supplies only native capture, permissions, and UI.
- Treat explicitly imported workflow modules as trusted current-user Bun code. Compile each graph against one closed host projection and reject unsupported capabilities before executor or resource admission. Never add an open operation-registration hook.
- Keep portable source independent of repository-only packages and state, caller-selected executable code, arbitrary network URLs, and ambient credentials.
- Keep the `./workflow` compatibility surface dependency-free. It may compose only the typed public operation registry, must parse foreign input, bound step dispatch, drain dispatched operations before returning, retain completed-step receipts on failure, and must not dynamically import authored code.
- Parse every foreign value from `unknown`; bound source bytes, collections, dimensions, subprocess work, responses, and outputs before expensive or privileged work begins.
- Treat diagram and authored composition inputs as authoritative; make rendered SVG, PNG, tldraw, and vector derivatives reproducible and replaceable.
- Keep local vectorization authentication-free and network-silent. Send generation directly to the fixed Vercel AI Gateway origin using environment-only credentials, bounded responses, and `maxRetries: 0`.
- Do not add a hosted Atet API, product account, OAuth flow, credential persistence, or legacy Graphics runtime surface.
- Pair parsing and compatibility changes with examples and property laws, then run the package `check` gate and clean standalone export.
