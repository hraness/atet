# HTML overlay creative toolkit

Research snapshot: 2026-09-01

Atet supports seven HTML-overlay profiles. Each profile owns one primary
authoring job, while the render host keeps one absolute clock, one declared
asset boundary, and one offline browser execution model. This division gives
creative technologists useful choices without loading several competing scene
graphs, animation loops, or GPU abstractions into every overlay.

The ecosystem tables on this page are dated research. They describe where a
tool fits; they do not grant that tool permission to execute. Only the exact
versions in [Supported and tested profiles](#supported-and-tested-profiles) are
part of Atet's executable allowlist.

## Choose a supported profile

Choose the first profile whose primary job matches the work:

1. Use `plain` for text, interface-like composition, semantic HTML, CSS, SVG,
   or a small native Canvas drawing.
2. Use `motion` when the subject is still DOM or SVG, but it needs a seekable
   entrance, exit, transition, or choreography.
3. Use `p5` when you want an immediate-mode Canvas 2D sketch whose drawing is
   recomputed for each requested frame.
4. Use `two` for a retained 2D scene made from vector shapes and groups.
5. Use `paper-shaders` for a configurable shader treatment such as a gradient,
   grain, texture, or procedural field without writing a GPU pipeline.
6. Use `three` for a retained 3D scene with cameras, lighting, materials,
   geometry, or models.
7. Use `vgpu` when the work itself is an explicit WebGPU program, including
   WGSL, compute, resources, passes, and submission.

Generate a starter without replacing an existing file:

```sh
atet html scaffold p5 --output overlay.html
```

Use `atet html catalog` for concise guidance, or
`atet html catalog --json` when another tool needs the stable profile metadata.
The catalog order is the same as the supported-profile table below.

## Supported and tested profiles

These are Atet's exact tested locks, not version ranges. The renderer serves a
verified local copy through the overlay's private origin, so authored HTML uses
only the bare specifier shown here and does not contain a CDN URL.

| Profile | Primary job | Surface and clock integration | Exact tested dependency | License |
| --- | --- | --- | --- | --- |
| `plain` | Document composition | DOM, CSS, SVG, or native Canvas; update from `AtetOverlay.onFrame` | Browser platform, no library | Not applicable |
| `motion` | DOM and SVG choreography | Atet pauses and seeks tracked animation controls before each frame | [Motion 12.42.2](https://www.npmjs.com/package/motion/v/12.42.2) | MIT |
| `p5` | Immediate-mode 2D sketching | Canvas 2D in instance mode; one empty p5 startup draw, then `noLoop()` and one awaited `redraw()` for each Atet frame | [p5.js 2.3.2](https://www.npmjs.com/package/p5/v/2.3.2) | LGPL-2.1 |
| `two` | Retained vector 2D scenes | Explicit WebGL renderer with `autostart: false`; one manual `render()` for each Atet frame | [Two.js 0.8.24](https://github.com/jonobr1/two.js/releases/tag/v0.8.24) | MIT |
| `paper-shaders` | Declarative shader treatments | WebGL shader mount; `setFrame(timeMs)` from the absolute Atet clock | [Paper Shaders 0.0.77](https://www.npmjs.com/package/%40paper-design/shaders/v/0.0.77) | Apache-2.0 |
| `three` | Retained 3D scenes | WebGL 2 scene graph; derive scene state from absolute time, then render once | [Three.js 0.185.1](https://www.npmjs.com/package/three/v/0.185.1) | MIT |
| `vgpu` | Explicit programmable GPU work | WebGPU resources, WGSL, passes, and one awaited frame submission | [vgpu 0.3.1](https://www.npmjs.com/package/vgpu/v/0.3.1) | MIT |

The `two` adapter binds Two.js's explicit
[WebGL renderer](https://two.js.org/docs/renderers/webgl/) and leaves
`autostart` disabled. Two.js documents [`render()`](https://two.js.org/docs/two/#render)
as a single scene render, while `play()` starts its own animation loop. The
starter never calls `play()` or the clock-mutating `update()` method. WebGPU
remains available through the `vgpu` profile, where it is the explicit
authoring model rather than an automatically selected backend.

p5.js is distributed under LGPL-2.1. Anyone redistributing the p5 runtime must
preserve the license and notices, identify that p5 is used, and provide the
corresponding source or another LGPL-compliant relinking path as applicable.
Atet's repository and CLI bundle do not embed the p5 module; the renderer fetches
the exact versioned upstream artifact only when a document selects `p5` and
verifies it before caching. A distributor that conveys that cached artifact or
packages it with Atet must review and satisfy the LGPL terms for that distribution.
The exact package includes the versioned
[`license.txt`](https://cdn.jsdelivr.net/npm/p5@2.3.2/license.txt); the
[p5.js 2.3.2 source release](https://github.com/processing/p5.js/releases/tag/v2.3.2)
and the [versioned package](https://www.npmjs.com/package/p5/v/2.3.2) provide
the upstream source and package metadata. The p5.js reference documents the
manual [`noLoop()`](https://p5js.org/reference/p5/noLoop/) and
[`redraw()`](https://p5js.org/reference/p5/redraw/) seam used by Atet.
Because p5 itself performs one mandatory draw after setup, the adapter makes
that startup draw empty and resolves readiness only after it completes. Every
output frame still comes from exactly one awaited manual redraw.
The complete p5 distribution also contains dormant dynamic-code paths for
Strands callbacks and JavaScript filter-shader loading. The supported P2D
starter does not invoke those capabilities; Atet's CSP continues to forbid
dynamic evaluation and fails the render if authored code reaches one of them.
This paragraph identifies the distribution boundary; it is not a substitute
for reviewing the license for a particular distribution.

Paper Shaders is Apache-2.0 and asks redistributors of its code to preserve its
included `LICENSE` and `NOTICE` files. See the official
[Paper Shaders repository](https://github.com/paper-design/shaders). Atet's
artifact receipts retain the license identity of each exact executable lock.

## Five layers keep the surface small

The HTML-overlay toolkit has five layers. Each layer has one authority and a
one-way relationship to the layer above it.

1. **Host invariants.** The render host owns the absolute clock, seeded
   entropy, declared assets, network isolation, content security policy,
   browser identity, transparent capture, resource bounds, timeouts, and
   receipts. A library cannot replace these rules.
2. **Executable artifacts.** Each admitted module has one exact specifier,
   version, byte count, SHA-256 digest, artifact URL, and license. Current locks
   author new work. Append-only historical locks validate old receipts without
   making an old version available to new work.
3. **Library adapters.** An adapter waits for initialization, disables the
   library's native loop, maps absolute Atet time to visible state, surfaces
   asynchronous errors, and releases resources.
4. **Scaffold recipes.** A recipe is an editable starting document. It combines
   one primary visual surface with optional data, geometry, simulation, signal,
   or asset inputs. It is not a generic plugin host.
5. **Catalog and guide.** The code catalog describes the seven executable
   profiles. This dated guide maps a wider ecosystem to composition, asset, or
   external-authoring seams. Documentation cannot add an executable artifact.

The layers are also a performance boundary. Atet fetches and verifies only the
exact modules declared by a document, then renders with network access denied.
There is no creative-tool mega-bundle and no automatic backend detection during
a render.

## The taxonomy is MECE by primary job

Creative libraries overlap in features. A feature checklist cannot make them
mutually exclusive: Three.js can draw flat geometry, p5 can open WebGL, and D3
can manipulate SVG. Atet instead classifies each tool by its primary authoring
job:

| Primary job | Execution model | Atet seam |
| --- | --- | --- |
| Time and choreography | Convert absolute time into values | Supported `motion` profile or a future state adapter |
| Primary visual surface | Own one DOM tree, canvas, scene graph, shader mount, or GPU pass graph | Exactly one supported profile per scaffold |
| Data, geometry, simulation, or signal production | Produce values or objects for a surface | Compose through a focused future adapter |
| Authored-artifact playback | Load and seek a validated exported animation format | Bounded asset adapter |
| Live or external authoring | Run an editor, live graph, feedback system, or desktop renderer | Import a reviewed export or bake the output |

This is mutually exclusive at the classification seam and collectively covers
the browser-oriented creative coding workflows evaluated for this snapshot.
It does not claim that a library's full feature set belongs to only one row.

## Ecosystem decisions

Where a version appears in the ecosystem tables, it is `latestObserved` on
2026-09-01. It is research metadata, not an Atet lock. A later release does not
change support until its exact artifact passes every admission gate and
replaces the tested lock through a reviewed upgrade.

### Compose later as focused capabilities

These tools add a distinct producer or authoring capability, but they should
compose with one supported surface instead of becoming another primary
scaffold.

| Tool | `latestObserved`, license, and backend | Primary job and intended seam |
| --- | --- | --- |
| [D3](https://www.npmjs.com/package/d3/v/7.9.0) | 7.9.0; ISC; ESM data transforms and DOM/SVG helpers | Data scales, layouts, shapes, and transforms for `plain`; do not use D3 transitions as a second clock. Prefer selected modules over the umbrella package. |
| [Paper.js](https://www.npmjs.com/package/paper/v/0.12.18) | 0.12.18; MIT; retained vector paths rendered to Canvas | Path construction, boolean geometry, and curve operations that can feed a Canvas surface. |
| [Rapier 2D](https://www.npmjs.com/package/%40dimforge/rapier2d/v/0.20.0) | 0.20.0; Apache-2.0; JavaScript and WASM physics | Fixed-step simulation through `@dimforge/rapier2d-deterministic-compat`, with canonical insertion order, snapshots, and replay from the nearest checkpoint. Deterministic stepping does not provide absolute seek by itself. |
| [Meyda](https://www.npmjs.com/package/meyda/v/5.6.3) | 5.6.3; MIT; browser and Node audio feature extraction | Analyze a declared audio asset before rendering and supply time-indexed features as data. Do not analyze a live microphone in the overlay. |
| [Theatre.js core](https://www.npmjs.com/package/%40theatre/core/v/0.7.2) | 0.7.2; Apache-2.0; browser property sequencing | Import authored timeline state through a future adapter that maps Atet time to `sheet.sequence.position`. |
| [deck.gl](https://www.npmjs.com/package/deck.gl/v/9.3.11) | 9.3.11; MIT; GPU data layers | Consider only for a concrete large-scale or geospatial overlay. Map tiles and remote sources must become declared local assets. |

### Add later through asset adapters

An asset runtime needs a stricter seam than a JavaScript helper. The adapter
must validate the authored file and every auxiliary asset, disable autoplay,
seek from Atet time, and prove bounded cleanup.

| Tool | `latestObserved`, license, and backend | Adapter position |
| --- | --- | --- |
| [dotLottie Web](https://www.npmjs.com/package/%40lottiefiles/dotlottie-web/v/0.80.0) | 0.80.0; MIT; ESM/CJS, Canvas and WASM | First candidate. Its direct `setFrame()` seam is a better fit than an accumulating animation loop. The adapter must fix device pixel ratio, interpolation policy, WASM, fonts, images, and animation assets. |
| [Rive Canvas](https://www.npmjs.com/package/%40rive-app/canvas/v/2.41.1) | 2.41.1; MIT; canvas-backed WASM runtime | Later candidate. The low-level API exposes delta advancement, so the adapter needs a tested reset-and-advance or snapshot strategy before arbitrary seek is safe. See Rive's [low-level runtime guidance](https://rive.app/docs/runtimes/web/low-level-api-usage) and [WASM self-hosting guidance](https://rive.app/docs/runtimes/web/preloading-wasm). |

### Keep external authoring systems external

These systems can produce valuable source material. Atet should ingest a
declared export, compiled shader, image sequence, video, geometry file, or data
track rather than embedding the editor's lifecycle.

| Tool | `latestObserved`, license, and backend | Atet boundary |
| --- | --- | --- |
| [TouchDesigner](https://derivative.ca/UserGuide/Main_Page) | 2025.33070, released 2026-07-16; proprietary desktop GPU/node system | Bake or export media, geometry, shaders, or data with provenance. The browser overlay does not run TouchDesigner. |
| [cables.gl](https://cables.gl/docs/4_export_embed/dev_embed/dev_embed) | Current web authoring service; source-visible runtime components and WebGL graph exports; no top-level license was present in the [official source repository](https://github.com/cables-gl/cables) at this snapshot | Import a reviewed, self-contained export only after its exact terms are established and a bridge removes its native loop and external requests. The official docs describe [self-contained web exports](https://cables.gl/docs/4_export_embed/dev_embed_webservers/dev_embed_webservers). |
| [Spline runtime](https://www.npmjs.com/package/%40splinetool/runtime/v/2.0.25) | 2.0.25; browser scene runtime; npm metadata declares no license | Treat Spline as an editor/export source. Do not redistribute or execute the runtime until its license and deterministic control are explicit. |
| [Hydra Synth](https://www.npmjs.com/package/hydra-synth/v/1.4.0) | 1.4.0; AGPL; WebGL/regl live coding with feedback buffers | Keep live. Feedback depends on prior frames and needs a distinct reset/checkpoint model; AGPL obligations also require separate review. |
| [Shader Park core](https://www.npmjs.com/package/shader-park-core/v/0.2.8) | 0.2.8; procedural shader DSL; package metadata says Apache-2.0 while the included license and repository say MIT | Compile or translate reviewed output into `three`, `paper-shaders`, or `vgpu`; do not add a second shader runtime. Resolve the upstream license conflict before any admission. |
| [ml5.js](https://www.npmjs.com/package/ml5/v/1.4.0) | 1.4.0; MIT; browser ML over TensorFlow.js | Run inference before rendering, close the exact model and input assets, then pass baked results into a supported profile. Camera, microphone, model-download, and device variability are not render inputs. |
| [canvas-sketch](https://github.com/mattdesl/canvas-sketch) | 0.7.8; MIT; Node/browser generative-art development and export toolkit | Keep it as an external source and export workflow. Atet already owns the final clock, frame capture, provenance, and video composition. |
| [Tweakpane](https://tweakpane.github.io/docs/) | 4.0.5; MIT; browser parameter and monitor UI | Use it while authoring, then persist selected values as declared Atet parameters. Do not render the control pane into a final overlay or let it become runtime state. |

Blender, Houdini, and After Effects belong to the same external-authoring seam.
Their exported artifacts need the same declared-asset, license, provenance, and
seek review as exports from the systems listed above.

### Decline overlapping runtime stacks

The following tools are credible, but they do not add a primary job that is
missing from the supported set.

| Primary job | Declined alternatives at this snapshot | Reason |
| --- | --- | --- |
| DOM/SVG choreography | [GSAP 3.15.0](https://www.npmjs.com/package/gsap/v/3.15.0), [Anime.js 4.5.0](https://www.npmjs.com/package/animejs/v/4.5.0) | Both can seek, but they duplicate Motion. GSAP also uses its own standard license rather than an OSI open-source license. |
| Native SVG helper | [SVG.js 3.2.8](https://www.npmjs.com/package/%40svgdotjs/svg.js/v/3.2.8) | Its dependency-free SVG manipulation surface overlaps `plain`, while Motion already provides Atet's seeked SVG-animation seam. It does not add a primary visual surface. |
| Immediate or multi-backend 2D | [q5.js 4.8.2](https://www.npmjs.com/package/q5/v/4.8.2), [Pts 0.12.9](https://www.npmjs.com/package/pts/v/0.12.9), [Rough.js 4.6.6](https://www.npmjs.com/package/roughjs/v/4.6.6) | p5 covers the sketch surface, Two.js covers retained vector 2D, and native SVG/Canvas remains available. q5's automatic WebGPU-to-Canvas fallback conflicts with Atet's pinned backend rule and its LGPL-3.0 terms need separate review. Rough.js may later be a small style helper, not a surface. |
| Retained Canvas and editor runtime | [Konva 10.3.2](https://www.npmjs.com/package/konva/v/10.3.2), [Fabric.js 7.4.0](https://www.npmjs.com/package/fabric/v/7.4.0) | Both provide retained Canvas object models centered on interactive editing, hit detection, controls, or serialization. Those workflows overlap `plain` and Two.js without adding a final-overlay job; Atet should keep editor interaction outside the deterministic render lifecycle. |
| Retained sprite and filter runtime | [PixiJS 8.20.1](https://github.com/pixijs/pixijs/releases/tag/v8.20.1) | Pixi is the stronger sprite and batching runtime, but the [full browser bundle](https://github.com/pixijs/pixijs/blob/v8.20.1/src/bundle.browser.ts) performs the check patched by its separate [unsafe-eval module](https://github.com/pixijs/pixijs/blob/v8.20.1/src/unsafe-eval/init.ts) and installs event systems backed by [EventTicker](https://github.com/pixijs/pixijs/blob/v8.20.1/src/events/EventTicker.ts). Exact-artifact audit found no single self-contained ESM that combines the main bundle and CSP patch. Reconsider only when one exact CSP-safe artifact and a ticker-free adapter pass the real-browser gate; do not weaken Atet's CSP. |
| Retained 3D | [Babylon.js 9.23.0](https://www.npmjs.com/package/%40babylonjs/core/v/9.23.0), [OGL 1.0.11](https://www.npmjs.com/package/ogl/v/1.0.11), [React Three Fiber 9.7.0](https://www.npmjs.com/package/%40react-three/fiber/v/9.7.0), [TresJS 5.8.3](https://www.npmjs.com/package/%40tresjs/core/v/5.8.3), [Threlte 8.6.0](https://www.npmjs.com/package/%40threlte/core/v/8.6.0) | They overlap Three.js. The React, Vue, and Svelte renderers also make one framework and its scheduler mandatory. |
| WebGL or typed WebGPU abstraction | [regl 2.1.1](https://www.npmjs.com/package/regl/v/2.1.1), [TWGL.js 7.0.0](https://www.npmjs.com/package/twgl.js/v/7.0.0), [TypeGPU 0.12.4](https://www.npmjs.com/package/typegpu/v/0.12.4) | Three.js and vgpu already span retained and explicit GPU work. TypeGPU remains worth observing, but Atet should not support two typed-WebGPU stacks. |
| Data chart grammar | [Observable Plot 0.6.17](https://www.npmjs.com/package/%40observablehq/plot/v/0.6.17) | It is chart-specific; selected D3 modules are the more general future data seam. |
| Physics alternatives | [Matter.js 0.20.0](https://www.npmjs.com/package/matter-js/v/0.20.0), [Planck 1.5.0](https://www.npmjs.com/package/planck/v/1.5.0), [cannon-es 0.20.0](https://www.npmjs.com/package/cannon-es/v/0.20.0) | One explicit deterministic Rapier path is easier to validate than several simulation engines. |
| Browser audio runtime | [Tone.js 15.1.22](https://www.npmjs.com/package/tone/v/15.1.22), [p5.sound 0.4.1](https://www.npmjs.com/package/p5.sound/v/0.4.1), [Essentia.js 0.1.3](https://www.npmjs.com/package/essentia.js/v/0.1.3) | The AudioContext clock, autoplay policy, and live inputs do not match the overlay render clock. Use Atet's media pipeline and precomputed features instead. Essentia.js also carries AGPL-3.0 and a large WASM payload. |
| Authored animation duplicate | [lottie-web 5.13.0](https://www.npmjs.com/package/lottie-web/v/5.13.0) | dotLottie is the preferred future packaged-asset and direct-frame seam. |
| General game runtime | [Phaser 4.2.1](https://www.npmjs.com/package/phaser/v/4.2.1) | Its input, audio, scene, physics, and timer lifecycle exceeds a deterministic overlay surface and overlaps the retained-2D surface plus a future simulation adapter. |
| Large drawing runtime | [CanvasKit WASM 0.42.0](https://www.npmjs.com/package/canvaskit-wasm/v/0.42.0) | The large JS/WASM and font closure duplicates the existing Canvas, vector, and GPU surfaces. |

## Hard admission gates

Research relevance is not an admission signal. A future executable library must
pass all of these gates:

1. **Distinct job:** It fills a primary authoring job or stable adapter seam
   that the existing set does not cover.
2. **Exact artifact:** Atet can lock one immutable browser artifact with its
   specifier, version, artifact URL, byte count, SHA-256 digest, and license.
3. **Closed module graph and CSP path:** The artifact has no undeclared imports,
   and the admitted adapter path runs under the existing content security policy
   without dynamic evaluation. Any dormant or authored eval path remains blocked
   and fails the render; it is not an allowed fallback.
4. **Controllable clock:** Native RAF, ticker, timer, transport, or autoplay can
   be disabled. Visible output is computed from absolute Atet time or from a
   documented fixed-step checkpoint/replay model.
5. **Seek-stable entropy:** Output does not depend on mutable random call order,
   ambient entropy, input devices, wall time, or prior frame order.
6. **Transparent output:** Alpha mode, premultiplication, clear behavior, color
   space, dimensions, and device scale are explicit and repeatable.
7. **Bounded lifecycle:** Synchronous setup finishes during registration; any
   asynchronous first-frame dependency enters `AtetOverlay.ready`. Failures
   propagate, per-frame work is bounded, and CPU, GPU, WASM, worker, and asset
   resources have a teardown path.
8. **Offline proof:** The exact library and all auxiliary assets render in the
   bound Chrome environment after external network access is denied.
9. **License closure:** Atet can satisfy the exact artifact's license, notice,
   source, attribution, and redistribution requirements.
10. **Repeatable evidence:** Arbitrary frame order, repeat frame digests, alpha,
    blocked-network behavior, and cleanup pass focused tests and the real-browser
    suite.

Changing the browser sandbox, allowing remote subresources, or weakening a gate
to make a library run is not an adapter.

## Deterministic adapter contract

Every profile uses the same page-visible contract:

- Finish synchronous setup while registering the document. If anything needed
  by the first frame initializes asynchronously, register that promise with
  `AtetOverlay.ready(promise)` and resolve it only after the dependency is ready.
- Register rendering with `AtetOverlay.onFrame(callback)`. The frozen frame has
  `frame`, `timeMs`, `deltaMs`, `progress`, `width`, and `height` derived from
  the declared render timing and canvas.
- Derive visible state from `timeMs`, `progress`, declared parameters, declared
  assets, and stable keyed values from `AtetOverlay.randomFor(key)`.
- Use `AtetOverlay.trackAnimation(controls)` only for an animation object that
  Atet can pause and seek through `time` or `currentTime`.
- Resolve declared assets through `AtetOverlay.asset(name)`. Do not fetch an
  authored URL, construct a CDN URL, or discover an asset during a frame.
- Release renderer, context, texture, geometry, buffer, WASM, worker, and event
  resources on `pagehide`.

Atet supplies deterministic replacements for wall-clock and scheduled browser
work, but that does not make cumulative scene mutation seek-stable. An adapter
must still produce the same pixels when frame 60 is requested first, last, or
twice. Use keyed randomness for visible choices; a mutable random sequence is
safe only during one-time construction whose call order is fixed.

Stateful simulation and feedback need a separate contract. Start from a
canonical initial state or a verified checkpoint, advance in fixed steps to the
requested frame, and prove that restore plus replay matches a clean run. Do not
pretend a `deltaMs` update loop is absolute seek.

## Offline, licensing, and performance boundaries

Offline closure includes more than the top-level JavaScript module. Declare and
hash every font, image, texture, model, worker, WASM binary, audio file, and data
file. Initialization must fail before the first output frame when the closure is
incomplete. Live camera, microphone, sensor, network, and model-download inputs
must be captured or computed before rendering.

Pin the rendering backend as well as the package. WebGL, WebGPU, native Canvas,
and software rasterizers can produce different edge pixels or shader results.
Use an exact digest only where bitwise equality is a property of the bound
browser and backend. Any cross-backend comparison needs an explicit tolerance
and must not be reported as byte-identical evidence.

Atet's macOS browser verification can use SwiftShader to prove availability,
offline routing, clock control, transparency, failure propagation, and repeated
output in the bound software-rendered environment. It makes no claim about
hardware GPU throughput, frame rate, thermals, memory bandwidth, or production
capacity. Performance decisions require a separate controlled measurement on
the target hardware and backend.

## Keep `latestObserved` separate from support

For supported libraries, the distinction was this on 2026-09-01:

| Library | Exact Atet tested lock | `latestObserved` | Support consequence |
| --- | --- | --- | --- |
| Motion | 12.42.2 | 13.1.1 | Atet continues to execute 12.42.2 until a reviewed lock upgrade passes all gates. |
| p5.js | 2.3.2 | 2.3.2 | The observed release matches the tested lock. |
| Two.js | 0.8.24 | 0.8.24 | The observed release matches the tested lock; Atet selects WebGL explicitly and leaves autostart disabled. |
| Paper Shaders | 0.0.77 | 0.0.80 | Atet continues to execute 0.0.77. The project warns that its `0.0.x` releases may be breaking, and the exact artifact's license and notices must be rechecked during an upgrade. |
| Three.js | 0.185.1 | 0.185.1 | The observed release matches the tested lock. |
| vgpu | 0.3.1 | 0.3.1 | The observed release matches the tested lock. |

Update `latestObserved` only with a dated primary source. Update an executable
lock only with the exact artifact evidence, focused adapter tests, real-browser
proof, license review, and historical-receipt compatibility required by the
admission gates.
