<!-- kb:context scopes/apps-desktop--a98dfc0ab16f -->
# Contents

- `contracts/`, `core/`, `application/`, `code/`, `workflows/`, `html-overlay/`, and `cli/` – recording/project contracts, local edit and renderer planning, the full host operation projection and durable workflow runtime, deterministic browser-overlay authoring, and agent command surface.
- `capture/`, `analysis/`, `runtime/`, `src/`, and `frontend/` – bounded macOS capture/Vision helpers, Bun gateway, Zig Native SDK host, and recorder UI.
- `direct/`, `assets/`, `app.zon`, and `build.zig` – deterministic scenarios, generated identity, bridge policy, and native commands.

# Guidelines

- Treat recording bundles, multi-asset projects, and immutable analysis sidecars as the primary API. The desktop renderer may issue only typed start, pause, resume, stop, and snapshot commands.
- Consume graph contracts, references, canonical identity, generic authoring, and compilation from `@hraness/atet/code`. Keep only host projection, durable scheduling, project authority, native capture, permissions, and UI adapters here; never fork the portable workflow core.
- Store recordings, projects, generated artifacts, and private metadata under `artifacts/atet/{recordings,projects,generated,private}/`. Mutation leases and other secret-free state belong in the machine-global per-user CLI state root. Read Gateway credentials directly from `AI_GATEWAY_API_KEY` or `VERCEL_OIDC_TOKEN`; never persist, log, or pass them in argv.
- Keep raw media and events immutable. Pause closes one synchronized segment and resume opens another; edits create plans and derivatives. Keep displays distinct and system audio, microphone, and webcam independently addressable.
- Map every source into one checked project clock using integer microseconds while retaining native timestamps. Reject overlapping/inverted foreign ranges and apply edits once in project time.
- Treat captured media, titles, focus, cursor, and typing evidence as sensitive. Typed-text capture is opt-in, secure fields are always suppressed, and each native permission reports an explicit state.
- Production capture must not import or execute `apps/local`; optional emoji resolves through the narrow file/provider boundary.
- Keep face detection offline in the signed Vision helper. Persist geometry and continuity IDs only, never identity, embeddings, names, crops, thumbnails, or cloud requests. Face camera moves bind immutable analysis, selected tracks, placement/geometry, and output aspect; stale evidence rejects.
- Keep planning, extraction, music analysis, transcription, and editing local. Gateway scene analysis uploads only selected bounded derived frames after `--allow-cloud-upload`. Gateway media commands upload only exact caller-named bounded media after modality acknowledgement, never a bundle, capture metadata, siblings, or reused consent.
- Discover Gateway support from the live public catalog rather than a checked adapter allowlist. Expose every matching live image, image-language, video, speech, and batch-transcription model; keep streaming-only transcription discoverable but reject it from batch commands. Validate model kind, inputs, and settings locally, reject fallback-model and duplicate sample-count fields, set client retries to zero, and never resubmit an ambiguous paid call; one Gateway request may still contain several provider attempts.
- Apply effects only through typed bounded non-destructive transforms. Use argv arrays, owned kernels, and fresh repository-local outputs; never interpolate caller text into filters or overwrite sources. Parse manifests, JSONL, native messages, tool results, and CLI edits from `unknown`.
- Keep HTML overlays deterministic and transparent: exact approved library locks, local bound assets, integer-microsecond frame time, seeded randomness, fixed browser settings, and denied ambient browser networking. Render them to verified alpha media before the ordinary overlay compositor sees them.
- Keep ordinary build, lint, typecheck, and TypeScript tests portable. Exercise ScreenCaptureKit, AVFoundation, Vision, and Zig only through explicit `*:macos` commands.
- Keep `@hraness/direct` development-only and outside production frontend, CLI, gateway, capture, Zig, and packaged graphs. Use its `tooling/*` subpaths for product-neutral browser-process, server-lease, artifact, contract-reading, and emitted-bundle mechanics.
- Keep Atet's Direct document identity, fresh-port allocation, scenarios, assertions, and artifact manifest policy product-owned. Local verification must allocate a fresh port when the requested port belongs to another process.
- Run macOS builds, packages, tests, and performance benchmarks one at a time. Zig builds must inherit the caller's worker budget through `-j`.
