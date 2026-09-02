---
type: plan
area: html-overlay-creative-toolkit
status: completed
tags:
  - html-overlay
  - creative-coding
  - deterministic-rendering
---

# HTML overlay creative toolkit

## Outcome

Atet exposes a small, durable, mutually exclusive set of HTML-overlay authoring
profiles, backed by exact executable locks and one deterministic render host. It
also maintains a broader dated ecosystem compendium so creative technologists can
understand where contemporary tools fit without turning every popular library into
trusted runtime code.

The plan follows [[notes/documentation-ownership|documentation ownership]] by
keeping executable truth in types/tests and the broader synthesis in the guide,
and preserves the public/private boundaries in
[[notes/repository-seams|repository seams]].

The supported profile set grows from five to seven:

| Profile | Primary authoring job | Surface | Runtime dependency |
| --- | --- | --- | --- |
| `plain` | Document composition | DOM, CSS, SVG, native Canvas | none |
| `motion` | DOM/SVG choreography | DOM and SVG | Motion |
| `p5` | Immediate-mode 2D sketching | Canvas 2D | p5.js |
| `two` | Retained-mode vector 2D scenes | WebGL | Two.js |
| `paper-shaders` | Declarative shader treatments | WebGL | Paper Shaders |
| `three` | Retained-mode 3D scenes | WebGL 2 | Three.js |
| `vgpu` | Explicit programmable GPU work | WebGPU | vgpu |

The CLI gains `atet html catalog [--json]`; `atet html scaffold` gains `p5`
and `two`; repository documentation records included, composable, adapter-bound,
asset-runtime, and external-authoring tools.

## Context and research snapshot

Research was performed on 2026-09-01 from official project documentation,
repositories, release feeds, and package metadata. Popularity is supporting
evidence, not an inclusion gate. Libraries overlap in features, so the MECE rule is
applied to each tool's primary authoring model rather than pretending product
feature lists are disjoint.

The selected additions fill the two missing durable jobs:

- p5.js 2.3.2 provides an approachable instance-mode, immediate Canvas 2D
  sketch loop with an awaitable `redraw()` seam. The exact unmodified ESM artifact
  is 1,101,741 bytes, SHA-256
  `78062f4b654ec2d7eab8391cb9f960720e90a379789974f27b6fc4aed94fae21`,
  and package metadata declares `LGPL-2.1`.
- Two.js 0.8.24 provides a retained vector 2D scene graph with an explicit
  WebGL renderer and manual `render()` seam. The exact official module is
  522,058 bytes, SHA-256
  `0e98a999fcb47006add9425200b18fab26eb09a154665b2893371d74e0a862d4`,
  and is MIT licensed.

Both selected artifacts are self-contained according to Bun's module import scan.
Neither adds a repository package dependency.

PixiJS 8.20.1 was the preliminary retained-2D choice and was rejected during
real-browser/adversarial review. Its full ESM executes an unsafe-eval capability
check under Atet's strict CSP and installs systems backed by Pixi's global ticker.
The official CSP patch is not one self-contained ESM graph that patches the
admitted bundle. Atet keeps the CSP and single-module seam intact and documents
Pixi as a future candidate instead of weakening either gate.

### Decision matrix

| Tool or family | Primary classification | Decision | Reason |
| --- | --- | --- | --- |
| Native DOM/CSS/SVG/Canvas | Document surface | Included as `plain` | Smallest semantic and layout foundation |
| Motion | Choreography capability | Included as compatible `motion` profile | Seekable DOM/SVG animation already integrated |
| p5.js | Immediate 2D sketch surface | Include as `p5` | Distinct creative-coding job and deterministic manual redraw seam |
| Two.js | Retained vector 2D surface | Include as `two` | Distinct retained scene-graph job with a CSP-safe manual-render seam |
| Konva and Fabric.js | Retained Canvas/editor surface | Document, do not execute | Interaction, hit testing, controls, and serialization overlap `plain`/Two without a final-render job |
| SVG.js | Native SVG helper | Document, do not execute | Native SVG plus Motion already own this seam |
| PixiJS | Retained sprite/filter surface | Defer | Exact full ESM fails strict CSP and installs ticker-backed systems |
| Paper Shaders | Declarative shader surface | Keep | High-level textures without shader engineering |
| Three.js | Retained 3D surface | Keep | Mature scene graph, cameras, materials, and model workflows |
| vgpu | Explicit GPU pipeline | Keep | WGSL, compute, and pass-level control |
| D3 | Data/geometry/layout capability | Compose with `plain` | It transforms data and DOM/SVG rather than owning a render substrate |
| GSAP and Anime.js | Choreography alternatives | Document, do not execute | Overlap Motion's role and expand trusted code without new coverage |
| Babylon.js, OGL, regl, twgl, luma.gl | 3D/GPU alternatives | Document, do not execute | Overlap Three.js or vgpu |
| Matter.js, Rapier, Cannon | Simulation capabilities | Future adapter seam | Need fixed-step reset, replay/checkpoint, and budget contracts |
| Tone.js and Meyda | Audio/signal capabilities | Separate media seam | Browser overlay rendering is intentionally muted; analysis should be declared input |
| Lottie and Rive | Authored-asset runtimes | Future asset adapter | Need validated manifests, local auxiliary assets, seek, and receipt semantics |
| Theatre.js | Timeline authoring | Future state import | Authoring state may feed adapters but is not a primary surface |
| Hydra | Live/feedback coding | Deferred adapter | Stateful history, media/network assumptions, and AGPL obligations need a distinct model |
| Spline, cables.gl, TouchDesigner, Blender, Houdini, After Effects | External authoring | Import or bake seam | Atet should ingest reviewed exports, not embed editor lifecycles |
| Phaser and game engines | Game runtime | Excluded from scaffold set | Input/audio/loop lifecycle exceeds a deterministic overlay surface |
| CanvasKit/Skia and ML runtimes | Large WASM/model runtime | Deferred boundary | Require separate binary/model, memory, portability, and receipt policy |

## Scope

- Add a typed read-only profile catalog as the sole source of scaffold metadata
  and scaffold-to-library selection.
- Add exact active p5.js and Two.js browser-library locks without loosening CSP,
  network isolation, import-map, receipt, or browser identity rules.
- Separate active authoring locks from historical receipt validation so future
  upgrades do not make old receipts unreadable.
- Add deterministic, transparent, seek-stable p5 and Two.js starters.
- Add discoverable human and JSON CLI catalog output.
- Update tests, user documentation, skill guidance, and the committed CLI bundle.
- Run focused, real-Chrome, aggregate, CI, merge, and production verification.

## Non-goals

- No framework-specific React, Vue, or Svelte renderer wrappers.
- No physics, audio, live-video, feedback, WASM asset runtime, or external editor
  is admitted to the executable allowlist in this change.
- No change to authoring input schema version 1, project graph schemas, capture,
  Gateway/provider boundaries, or ordinary overlay composition.
- No new browser flag or generic capability contract until a second real runtime
  requires one.
- No claim that SwiftShader rendering is equivalent to hardware GPU throughput.
- No automatic import of remote assets, fonts, workers, child frames, service
  workers, eval, ambient network, or CDN dependencies.

## Soundfish boundary assessment

Soundfish should not embed Atet's scaffold catalog or add a creative-runtime
dependency. Its production piano roll already projects canonical score state
into renderer-neutral frozen geometry, batches that geometry through a
constant-DOM Canvas 2D painter, keeps indexed hit testing and semantic DOM
outside the bitmap, and derives transport display from the authoritative Web
Audio clock. Motion, p5, Two.js, Paper Shaders, and Three.js would duplicate or
bypass those seams; Atet's absolute-frame vgpu adapter has the wrong clock and
browser-support contract for the live editor.

The durable cross-product seam is data: Soundfish can export its lossless
document/MIDI representation or precomputed time-indexed features, and Atet can
turn those declared inputs into offline promotional or visualizer media. A
future Soundfish GPU painter is justified only by measured Canvas 2D failure on
supported physical devices. It should begin in Soundfish Direct behind one
narrow note-bitmap painter interface, retain Canvas 2D for text, selection, hit
testing, accessibility, and fallback, share one device, and render only when
Soundfish's existing coordinator requests a paint. No Soundfish code change is
part of this delivery.

## Constraints and decisions

### Architectural layers

1. **Host invariants:** absolute clock, seeded entropy, declared assets, offline
   routing, CSP, browser identity, alpha capture, bounds, timeouts, and receipts.
   This layer stays product-name agnostic.
2. **Executable artifacts:** exact specifier, version, URL, byte count, SHA-256,
   and license. Active locks author new work; historical locks only validate old
   evidence.
3. **Library adapters:** finish synchronous setup during registration and await
   asynchronous initialization when present, disable native loops, derive visible
   state from absolute Atet time, surface failures, and dispose resources.
4. **Scaffold recipes:** editable examples combining one primary surface with
   optional capabilities.
5. **Catalog and guide:** stable supported-profile metadata in code; wider dated
   ecosystem research in maintained documentation.

### Hard admission gates

A future executable addition must have a distinct primary authoring job, an exact
closed module graph whose admitted path is CSP-compatible, a controllable clock, seek-stable
randomness, transparent output, bounded readiness and teardown, understood license
obligations, success in the bound offline Chrome environment, and repeatable frame
digests. The documentation compendium never becomes the allowlist automatically.

### Profile registry

The registry is advisory authoring metadata, not persisted render state. Each entry
has one `kind`, one unique `primaryJob`, one `substrate`, one `clockIntegration`, an
exact library selection, a concise summary, and best-use guidance. The registry is
the sole source for CLI catalog output and scaffold library selection; HTML remains
in `scaffolds.ts`, and executable provenance remains in `libraries.ts`.

### p5 adapter invariants

- Instance mode and an Atet-owned canvas container.
- P2D only; no p5 WebGL, WebGPU, sound, loaders, compatibility add-ons, or system
  fonts in the starter.
- No Strands callback transpilation or JavaScript filter-shader loader; those
  dormant upstream paths use dynamic evaluation and remain blocked by Atet's CSP.
- Make p5's mandatory startup draw empty, then use `noLoop()` plus one awaitable
  `redraw()` from each `AtetOverlay.onFrame` call.
- Explicit logical dimensions and pixel density; transparency cleared each frame.
- Visible variation comes from absolute time and `AtetOverlay.randomFor`, never a
  mutable sequence or cumulative draw state.
- Initialization enters `AtetOverlay.ready`; `remove()` runs on `pagehide`.
- The unmodified official ESM distribution is used, with source and LGPL notice
  links in the public guide.

### Two.js adapter invariants

- Construct the explicit WebGL renderer with `autostart: false`; never call
  `play()`, use loaders, or select a backend automatically.
- Use the caller-owned canvas, fixed logical dimensions, explicit pixel ratio,
  alpha/premultiplication/preserved-buffer settings, and transparent clear color.
- Preallocate a bounded retained vector scene; keep rasterized shape appearance
  static, mutate transforms from absolute time, and execute one manual `render()`
  per Atet frame without per-frame object creation.
- Release scene resources and event bindings, remove the instance from the public
  instance registry, and intentionally lose the WebGL context on `pagehide`.

### Delivery policy

Use Bun 1.3.14. Narrow deterministic tests may run directly. The real browser suite
runs through `/Users/bg/.bun/bin/hra-host-run` on the `browser-auth` lane. The
repository aggregate gate `bun run check` runs through the same scheduler in
exclusive compute mode after convergence. Delivery uses a current-head pull request,
the repository's Required CI join, serialized merge, and production readback.

## Phase map

| Phase | Outcome | Depends on | Write scope | Parallel with |
| --- | --- | --- | --- | --- |
| 1. Research and contracts | Accepted taxonomy, locks, plan, and migration boundaries | none | `kb/plans/html-overlay-creative-toolkit.md` | none |
| 2. Catalog and provenance | One typed catalog and durable active/history lock model | 1 | `apps/desktop/html-overlay/catalog.ts`, `libraries.ts`, exports, focused tests | none; owns shared registries |
| 3. Deterministic recipes | Working p5 and Two.js scaffold documents | 2 | `scaffolds.ts`, scaffold tests | 4 after catalog API stabilizes |
| 4. Discovery and guidance | CLI catalog plus maintained ecosystem guide | 2 | portable CLI/help/tests, README/docs/skill/AGENTS, committed CLI bundle | 3 except generated bundle convergence |
| 5. Integration proof | Real-browser, operation, determinism, security, performance, and impact evidence | 3, 4 | tests and this plan's log | none |
| 6. Delivery | Green final gate, PR, CI, merge, and production verification | 5 | repository delivery state and this plan | none |

## Phase 1: Research and contracts

- **Status:** Done
- **Depends on:** none
- **Objective:** Commit a decision-ready taxonomy and an executable boundary based
  on current primary sources and repository behavior.
- **Scope:** Current Atet execution trace; candidate comparison; exact p5/Two.js
  module metadata; legal/provenance choice; phase plan.
- **Out of scope:** Product code edits.
- **Approach:** Compare candidates by distinct authoring role first, then hard
  security/determinism gates, then stability, documentation, adoption, size, and
  maintenance signals. Inspect exact upstream artifacts with Bun's module scanner.
- **Acceptance criteria:**
  - The seven roles are unique and cover Atet's supported authoring surfaces.
  - Included, composable, adapter-bound, asset-runtime, external-authoring, and
    excluded candidates have explicit homes.
  - Exact URLs, versions, sizes, hashes, licenses, and unresolved-import results are
    recorded for both additions.
  - Runtime, contract, operational, legal, and validation risks are explicit.
- **Validation:** Primary-source link review; `shasum -a 256` and `wc -c` on exact
  artifacts; `Bun.Transpiler.scanImports()`; independent architecture and
  adversarial reviews.

## Phase 2: Catalog and provenance

- **Status:** Done
- **Depends on:** Phase 1
- **Objective:** Make one typed, exhaustive profile registry and admit two exact
  modules without weakening historical evidence.
- **Scope:** HTML-overlay library schemas/registries, profile catalog, index exports,
  exact-selection and receipt comparison tests.
- **Out of scope:** HTML recipes and CLI output.
- **Approach:** Keep explicit literal Zod validation. Add p5 and Two.js exact locks.
  Resolve new work only from an active lock registry; validate receipts against a
  historical union. Compare renderer results against complete expected lock objects,
  not specifier order alone. Derive scaffold selections from the profile registry.
- **Acceptance criteria:**
  - Every scaffold kind has exactly one deeply frozen profile and unique primary job.
  - There is no second hand-maintained scaffold-to-library mapping.
  - Active resolution returns only current exact locks; historical validation remains
    a separate append-only seam.
  - Mutated bytes, hash, URL, version, license, or specifier fail validation.
  - No authoring schema version, network policy, CSP, or launch flag changes.
- **Validation:** Focused Bun tests for catalog, libraries, integrity, and operation
  receipt parsing/comparison.

## Phase 3: Deterministic recipes

- **Status:** Done
- **Depends on:** Phase 2
- **Objective:** Generate complete transparent p5 and Two.js documents that render
  from any requested absolute frame without hidden loops or ambient dependencies.
- **Scope:** `scaffolds.ts` and scaffold-focused tests.
- **Out of scope:** Advanced p5 renderers, Two.js assets/loaders or sprite playback,
  audio, physics, text,
  feedback, and framework bindings.
- **Approach:** Implement the adapter invariants above. Keep starter scenes bounded,
  precomputed where appropriate, aesthetically legible, and easy to replace.
- **Acceptance criteria:**
  - Both recipes import only their exact bare specifier via a local import map.
  - Synchronous setup completes during registration, asynchronous readiness is
    awaited, state is absolute-time based, clear alpha is explicit, hidden native
    loops are absent, and cleanup is installed.
  - p5 uses P2D instance mode and manual redraw; Two.js uses explicit WebGL and
    manual rendering without autostart.
  - Generated documents and library arrays are frozen and deterministic.
- **Validation:** Scaffold unit/source invariants; semantic-builder scaffold coverage;
  source-bundle rejection of direct runtime imports.

## Phase 4: Discovery and guidance

- **Status:** Done
- **Depends on:** Phase 2
- **Objective:** Make the supported set easy to choose while preserving the broader
  ecosystem research as maintained guidance.
- **Scope:** `atet html catalog [--json]`, help, tests, desktop/root documentation,
  HTML-overlay inventory, Atet skill/video guidance, ecosystem guide, CLI build.
- **Out of scope:** CLI installation or new runtime dependencies.
- **Approach:** Emit stable registry order. Human output is concise and actionable;
  JSON output is canonical, versioned, and contains only stable public catalog fields
  plus current exact library versions. Document broader tools by seam and admission
  status with dated official links.
- **Acceptance criteria:**
  - `atet html catalog` and `--json` are deterministic and reject extra grammar.
  - Help lists all seven kinds and the catalog command.
  - Documentation gives a direct decision tree and does not imply every researched
    tool is executable or that SwiftShader is hardware-fast.
  - License/source links for p5 and license links for every selected dependency are
    discoverable.
  - The committed CLI bundle matches source.
- **Validation:** Portable-surface/help tests; documentation link and stale-token
  searches; repository CLI build/check command.

## Phase 5: Integration proof

- **Status:** Done
- **Depends on:** Phases 3 and 4
- **Objective:** Prove the expanded set preserves deterministic offline transparent
  rendering and bounded operation behavior in the real browser.
- **Scope:** Real-Chrome smoke, repeated-frame digest, alpha, blocked-network,
  operation path, bounded performance observation, change-impact review.
- **Out of scope:** Hardware-GPU benchmarking or unbound stress tests.
- **Approach:** Exercise every selected module in the exact Chrome snapshot and
  SwiftShader environment. Render both new scaffolds twice at the same frames, assert
  byte-identical digests and transparent/partial/opaque pixels, and record elapsed
  time as evidence rather than a marketing claim.
- **Acceptance criteria:**
  - Every approved scaffold imports and renders offline under existing CSP/routing.
  - New animations change across requested frames and repeat exactly across runs.
  - Every profile has a near-transparent compositing margin and visible output;
    p5 and Two contain exact transparent, partial, and opaque pixels on both
    frames, while fullscreen vgpu also has a visible center.
  - No unexpected network, timers, frames, console errors, or leaked resources occur.
  - Existing PNG-to-alpha-video operation and integrity receipt checks still pass.
  - Independent adversarial and blast-radius reviews have no unresolved blocking
    finding.
- **Validation:** `bun run verify:html-overlay:macos` via the `browser-auth` host
  lane; focused operation/integrity tests; exact-tree review.

## Phase 6: Delivery

- **Status:** Done
- **Depends on:** Phase 5
- **Objective:** Deliver the converged exact tree through every repository gate and
  verify the merged public surface.
- **Scope:** Stable 3.2.0 version alignment, aggregate validation, commit,
  current-head PR, Required CI, merge, automatic npm staging,
  deployment/production readback, plan completion.
- **Out of scope:** Bypassing reviews, policy, CI, or provider controls.
- **Approach:** Run `bun run check` through the exclusive compute lane after all
  inputs converge. Rebase only onto the current governed main, push the task branch,
  resolve required review/CI findings, merge serially, then verify main and the public
  site/CLI documentation surfaces that deploy from it.
- **Acceptance criteria:**
  - Final aggregate gate passes on the committed tree.
  - PR head is current, Required CI is green, and no unresolved review remains.
  - Merge is present on `origin/main`; applicable deployment is healthy.
  - The exact 3.2.0 package is staged by the trusted workflow. Public npm
    promotion and the matching tag occur only after the required human npm
    two-factor approval and registry readback.
  - This plan records exact commands, results, deviations, final SHA/PR, and remaining
    risks, then moves to `completed` with nonempty Result and Durable memory.
- **Validation:** `bun run check`; Git/PR/CI evidence; production HTTP and visible
  content readback where applicable.

## Validation ownership

- Catalog/library/scaffold unit tests: implementation owner, direct local lane.
- Real Chrome suite: integration owner, `browser-auth` host lane, one run owner.
- Aggregate `bun run check`: integration owner, exclusive compute host lane.
- Required CI/merge/deployment wait: one delivery owner; event-driven status checks.

## Recovery

- Exact new library artifacts remain cacheable by SHA and do not replace old locks.
- A failed new recipe can be removed by deleting its kind/profile and active lock
  while retaining any historical lock already referenced by published receipts.
- No data migration or destructive rollback is required because authoring schema v1
  and project assets are unchanged.
- If current Chrome/CSP cannot execute an artifact, stop before admission; do not
  weaken routing or execution policy to make it pass.
- If Required CI or deployment fails, repair on the task branch and rerun the same
  authoritative gate; do not merge or claim completion with partial evidence.

## Open questions

None. New capability contracts will be proposed only when a concrete second consumer
requires them.

## Implementation log

- **2026-09-01 — Phase 1:** Traced the HTML-overlay scaffold, library,
  import-map, virtual-clock, browser-routing, alpha-encoding, integrity, receipt,
  and CLI paths. Verified the p5.js 2.3.2 and PixiJS 8.20.1 official modules by
  exact byte count, SHA-256, package license metadata, and an empty Bun module
  import scan. Independent ecosystem, architecture, and adversarial reviews all
  initially converged on adding p5 and Pixi to the executable set. The preliminary
  outcome was seven unique profiles and direct Pixi WebGL rendering; later
  adversarial and browser review below invalidated Pixi's admission.
- **2026-09-01 — Phases 2–3:** Froze the profile-catalog API and began the
  single-owner exact-lock/history implementation. In parallel, added P2D p5 and
  direct-WebGL Pixi recipes plus focused source invariants against native loops,
  mutable entropy, opaque clearing, unbounded initialization, and missing cleanup.
  Validation is pending until the shared catalog registry lands.
- **2026-09-01 — Phase 2:** Added an exhaustive compile-time profile map whose
  public array is derived in stable recommendation order. Added exact p5.js
  2.3.2 and PixiJS 8.20.1 active locks, kept the existing approved export as an
  active alias, separated append-only historical receipt validation, and changed
  operation verification to compare the complete returned locks with the active
  expected locks. Focused catalog/library/operation tests passed: 14 passed, one
  expected browser skip, zero failures; desktop TypeScript and focused ESLint
  passed in the independent implementation review.
- **2026-09-01 — Phases 3–4:** Added direct p5 P2D and Pixi WebGL recipes,
  catalog-backed scaffold selection, `atet html catalog [--json]`, strict CLI
  grammar, help, Code Mode coverage, a dated public ecosystem guide, README and
  skill guidance, and property coverage derived from the library registry. The
  latest focused run covering catalog, scaffold, CLI, semantic-builder, lock, and
  operation behavior passed 63 tests with one expected browser skip; the source
  bundler's sandbox-only boot-identity failures are queued through the required
  macOS host lane. Remaining Phase 4 work: rebuild and verify the committed CLI
  bundle.
- **2026-09-01 — Phase 5 preliminary run:** Expanded the real-Chrome all-library
  smoke to derive cases from the catalog, render two changed frames for every
  executable profile, compare complete lock results, and repeat both frames for
  exact digests. The first exclusive browser run rejected a single exact-zero
  alpha assertion that did not fit vgpu's fullscreen exponential falloff.
- **2026-09-01 — Admission deviation:** Independent implementation, ecosystem,
  and change-impact reviews found that PixiJS 8.20.1's exact full ESM performs an
  unsafe-eval check under Atet's CSP and installs ticker-backed systems. Removed
  the unshipped Pixi kind, lock, scaffold, and supported claims without retaining
  a phantom historical receipt. Selected the current Two.js 0.8.24 retained-vector
  alternative: official ESM, 522,058 bytes, SHA-256
  `0e98a999fcb47006add9425200b18fab26eb09a154665b2893371d74e0a862d4`,
  MIT, zero imports, and zero evaluation calls. The adapter selects WebGL,
  disables autostart, keeps rasterized appearance static, manually renders from
  absolute transforms, and closes scene/event/context resources. Pixi remains in
  the dated compendium as a deferred sprite/filter candidate. No CSP, routing,
  browser, or network rule changed.
- **2026-09-01 — p5 lifecycle correction:** Source review proved p5 always invokes
  one startup redraw even after `noLoop()`. The scaffold now makes that draw empty
  and wraps public `redraw()` so readiness resolves only after p5 completes its
  postdraw and finishDraw work; each Atet output frame then awaits one manual
  redraw. This avoids virtual-timer races and makes the lifecycle claim exact.
- **2026-09-01 — Adapter hardening:** Made Two.js setup and teardown synchronous,
  removed its named context-loss listener before intentional context loss, and
  narrowed every executable fetch/bundle/result boundary to active locks while
  leaving historical locks receipt-only. Made p5's Canvas 2D alpha, sRGB color
  space, desynchronization choice, and device density explicit. Extended the
  packed-consumer smoke to require catalog discovery plus working p5 and Two
  scaffold generation from the tracked CLI bundle.
- **2026-09-01 — Real-browser convergence:** The exact-library Chrome smoke passed
  all six executable-library profiles under the unchanged CSP and offline route:
  two frames, changed animation digests, clean-run equality, p5/Two reverse-order
  equality, explicit mixed alpha, and 2x p5/Two device scale. Result: 2 passed,
  9 unrelated opt-in cases skipped, 0 failed, 72 assertions. A preliminary test
  assumption requiring an exact-zero pixel for CSS-filtered Motion was replaced
  with a substantial near-transparent perimeter check; p5 and Two retain the
  stricter exact transparent/partial/opaque assertions.
- **2026-09-01 — Soundfish assessment:** Traced Soundfish's score projection,
  Canvas 2D scene painter, hit testing/accessibility, paint coordinator, and Web
  Audio clock. Kept Atet runtimes out of that live editor. The supported seam is
  declared document/MIDI or time-indexed data into Atet; a future vgpu painter
  remains conditional on physical-device evidence and a narrow fallback-backed
  bitmap interface.
- **2026-09-01 — Release decision:** Classified the catalog, p5, and Two.js
  additions as public minor-version functionality and aligned Atet on 3.2.0.
  This also carries the previously merged but unreleased vgpu profile. The
  repository's trusted workflow may stage the exact package after merge; npm
  promotion and the `v3.2.0` tag remain behind the documented human 2FA and
  registry-verification boundary.
- **2026-09-01 — Integration proof:** Ran the complete macOS HTML-overlay verifier
  through the exclusive `browser-auth` lane. The base renderer/security matrix
  passed 9 cases with 28 assertions; the exact-library matrix passed 2 cases with
  72 assertions; and the real alpha-video/compositor operation matrix passed 6
  cases with 32 assertions. There were no failures. The run covered the unchanged
  strict CSP and offline router, deterministic repeated and reverse-order p5/Two
  frames, device scale 2, mixed alpha, visible output, bounded margins, library
  integrity, and end-to-end media publication.
- **2026-09-01 — Pre-delivery gate:** Rebuilt the SDK and tracked desktop CLI,
  refreshed the generated predecessor-identity inventory through its guarded
  updater (one expected CLI-bundle fingerprint changed), and passed the inventory
  safety suite 9/9. The exclusive-compute `bun run check` then passed the complete
  SDK, Desktop, web, standalone-boundary, release-workflow, schema, skill,
  generated-build, preview-layout, and installed-package gates. Desktop reported
  1,243 passes, 16 intentional opt-in skips, and zero failures; the packed 3.2.0
  consumer verified 325 files and generated both p5 and Two.js overlay documents.
  After the KB convergence edit, the final exact-tree `bun run check` passed the
  same complete gate again before delivery.
- **2026-09-02 — Merge and production:** Pull request
  [#61](https://github.com/hraness/atet/pull/61) passed Required CI and all five
  official VTracer targets, then merged as
  `8471d1632387e8ff90e522682a059b212c6bdee7`. Post-merge
  [CI](https://github.com/hraness/atet/actions/runs/33587896420) and
  [VTracer](https://github.com/hraness/atet/actions/runs/33587896433) were green.
  Vercel production deployment `FUoqWbWg6SDx4y2HhmoouppJvFJL` succeeded;
  `https://atet.sh/`, `https://atet.sh/index.md`, and the merged creative-toolkit
  guide returned HTTP 200 with the 3.2.0 surface. Their SHA-256 readbacks were
  `e16737ad20f11873e619ab3831aef7396a233347981e1cb4fa75dffb7104cc09`,
  `1cda03135c8cdf0fcffc95f516d0116d2f1e3f0b7a2a263c37169bf26ef6d51c`, and
  `e321aeac7051eb6a43033906a73a06c9da42b90f39832d654c06926c60ce55d8`.
- **2026-09-02 — npm publication:** Trusted
  [staging run](https://github.com/hraness/atet/actions/runs/33587896415) produced
  stage `4053394a-350b-4407-b18d-01a56de841e5`; npm's separate human security-key
  approval promoted it publicly. Independent source-versus-registry comparison
  proved byte-identical 3,481,382-byte archives and canonical identity across 325
  files and 8,762,360 unpacked bytes. The public SHA-1 is
  `93f963bf222b090e3e33fdb31a046672edbd72f5`; the public SHA-512 is
  `3249d132d4958d18dc384508f3c45d82fa7f6e2294ac89f89ff0ba03b07dbdcef39adf67f32c628ad4904c5166ec9cbf8d75a0ebb3bb098149edf76a96424af0`.
  A clean installed-package smoke passed through the heavy compute lane and
  generated both p5 and Two.js scaffolds. npm `latest` resolves to 3.2.0, and the
  SLSA attestation binds that archive to merge `8471d163` and the staging run.
- **2026-09-02 — Immutable release:** Because unrelated pull request #62 advanced
  `main` after staging, the annotated `v3.2.0` tag intentionally targets the exact
  attested ancestor `8471d163`, not the newer head. The tag-triggered
  [Release run](https://github.com/hraness/atet/actions/runs/33630775227) reran the
  complete repository gate, exact public-package comparison, five-platform
  VTracer matrix, and macOS desktop tests/package; every job passed. The dependent
  publisher created [Atet v3.2.0](https://github.com/hraness/atet/releases/tag/v3.2.0)
  as the immutable, non-draft, non-prerelease Latest release with zero assets.
- **2026-09-02 — Final adversarial review:** Independent review found no high- or
  medium-severity correctness, security, architecture, durability, taxonomy, or
  Soundfish-boundary issue. The one remaining nit is test completeness: p5 and
  Two.js cleanup is source-asserted and production browser contexts are closed,
  but the real-browser matrix does not yet instrument `pagehide` cleanup calls.

## Result

Atet 3.2.0 delivers the planned seven-profile HTML-overlay toolkit: `plain`,
`motion`, `p5`, `two`, `paper-shaders`, `three`, and `vgpu`. The runtime additions
are the exact p5.js 2.3.2 and Two.js 0.8.24 artifacts behind deterministic manual
frame adapters; the wider researched ecosystem remains documentation rather than
trusted executable code. `atet html catalog [--json]` exposes the profile model,
and packed consumers can generate and render the new starters without ambient
network access or a weakened CSP.

The delivery completed every planned gate: focused and real-browser proof, two
converged aggregate checks, Required CI, merge, post-merge checks, production
readback, trusted npm staging, human 2FA promotion, independent public-package
identity and smoke verification, the cross-platform release matrix, and immutable
GitHub Release publication. No Soundfish runtime was changed; the assessment kept
its live editor architecture intact and selected exported score/feature data as
the cross-product seam.

Remaining risk is bounded and explicit. The ecosystem snapshot will age and must
be refreshed from primary sources before support changes; hardware-GPU throughput
is unmeasured; and a later browser test may instrument p5/Two `pagehide` cleanup.
None changes current deterministic output, security, receipt compatibility, or
release correctness.

## Durable memory

- Executable profile metadata and scaffold-to-library selection are maintained in
  `apps/desktop/html-overlay/catalog.ts`; do not duplicate that mapping in CLI or
  scaffold dispatch code.
- Exact active and historical artifact truth is maintained in
  `apps/desktop/html-overlay/libraries.ts`. Active locks may author new work;
  append-only historical locks validate receipts and must not silently re-enter
  the executable set.
- Deterministic library lifecycle examples are maintained in
  `apps/desktop/html-overlay/scaffolds.ts`, with the host contract and admission
  rules explained in `docs/html-overlay-creative-toolkit.md`. Classify future
  tools by primary authoring job, keep capabilities and asset runtimes behind
  focused seams, and require exact CSP/offline/browser proof before admission.
- Publication and immutable-tag sequencing remain owned by `docs/publishing.md`
  and `.github/workflows/release.yml`: verify the public npm artifact first, then
  tag the exact attested main ancestor and let the dependent workflow publish the
  GitHub Release.
- No Soundfish documentation or code was promoted because this task changed no
  current Soundfish contract. Revisit a GPU painter only with measured physical-
  device evidence; preserve its AudioContext clock, renderer-neutral scene,
  Canvas 2D fallback, hit testing, and accessibility boundaries.
