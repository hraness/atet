<!-- kb:context scopes/apps-desktop-cli--62c8f275cfa9 -->
# Contents

- `main.ts` and command modules – the `atet` executable across recording/project reads, diagrams, vectorization, ingest, analysis, edits, rendering, Gateway generation, assets, and diagnostics.
- `html-overlay-renderer.ts` – deterministic transparent rendering from a freshly verified, recursively immutable Chrome-runtime tree with declared routes, full execution-integrity evidence, and bounded lease-based orphan quarantine.
- `portable-surface.ts` – routing to the canonical headless diagram/file-image parser plus non-overwriting HTML scaffolds and the project image-generation alias.
- `build-compiled.ts`, `compiled-bootstrap.ts`, and `native-media-runtime.macos.ts` – the copied-binary-tested macOS CLI build, private native-asset bootstrap, and exact embedded Sharp/libvips bridge.
- `mutation-lock.ts`, project transactions, and `project-media-integrity.ts` – physical leases, crash recovery, containment, length, and SHA-256 enforcement.
- Face-analysis/camera modules – signed local evidence, deterministic selection, camera mutation, and bounded receipts.
- Gateway modules and `media-effects-service.ts` – live catalog/settings validation, environment credential loading, bounded paid dispatch, immutable artifacts, and safe FFmpeg transforms.
- `run-cli-test-helper.ts`, colocated fixtures, and process tests – deterministic process-local CLI verification that cannot contend with production machine-wide admission.
- `compiled-portable-surface.macos.test.ts` – copied-binary proof for bundled native diagram rendering and isolated vectorization.

# Guidelines

- Default output is concise agent-readable summaries, repository-relative paths, exact next commands, and bounded rows. Every read/mutation receipt supports `--json`; JSON stdout remains machine-readable and diagnostics use stderr.
- Accept exact recording IDs or unambiguous prefixes only. Support microseconds, milliseconds, seconds, `HH:MM:SS.mmm`, and frames only with FPS. Mutations are atomic, return the plan hash, and analysis/rendering provide dry runs.
- Resolve largest faces per visible prepared-layer frame with deterministic ties; partial multi-face tracking is default and all-selected loss requires explicit policy.
- Hold the target mutation lease across the whole read–derive–persist transaction, ingest, and rollback. Structural project changes also use the persisted project-state transaction to recover `project.json` and edit-plan generations after death.
- Publish a fsynced private owner inode by no-replace hard link. A live or unprovable owner conflicts; reclaim malformed locks or abandoned temps only when old, physically unchanged, private regular files proven not open.
- Probe FFmpeg, FFprobe, whisper.cpp, Vision, and SVG rasterizers. Import external media into content-addressed project storage, never render from unbounded caller paths, verify containment/length/SHA-256 immediately before subprocess reads, and bound stream fan-out.
- Load a Gateway credential from `AI_GATEWAY_API_KEY`, falling back to `VERCEL_OIDC_TOKEN`. Keep credentials out of argv, receipts, projects, diagnostics, and logs; send them only to the fixed HTTPS Gateway origin.
- Scene analysis serializes only the selected-frame request after `--allow-cloud-upload` and uses the same direct local Gateway provider as other generation commands.
- Require `--allow-cloud-upload` for image/video and `--allow-cloud-audio-upload` for transcription. Each local input is one physical non-symlink file within bounds; never enumerate siblings. Public references require catalog permission and credential-free HTTPS with no fragments, local/private targets, or unsafe redirects.
- Validate live model kind and inputs before paid dispatch. Forward bounded settings/options exactly but reject `gateway.models` and duplicate sample counts. Persist option digest/namespaces only. Set `maxRetries` to zero, publish a pre-dispatch receipt, and never automatically resubmit ambiguity.
- Publish outputs below the ignored generated root with hashes, lengths, catalog/model revision, settings, input digests, warnings, fulfillment counts, and next commands. Bound downloads, redirects, media types, and no-replace publication. Preserve paid bytes that fail decode but emit no import command.
- Build FFmpeg effects only from typed presets with digest-pinned inputs and fresh outputs; reverify after render. Surface output-without-receipt orphans as conflicts. Import scene contracts and provider-neutral types from `@hraness/atet/scene`, never CLI-local copies.
- Route in-process CLI tests through `run-cli-test-helper.ts`. Give mutation-lock concurrency cases distinct profiles per invocation; machine-global admission behavior belongs in dedicated host-resource tests.
