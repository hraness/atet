# Slopcamera

[![Slopcamera: a visual studio for coding agents](https://slopcamera.com/og.png)](https://slopcamera.com)

**Slopcamera is a local visual studio for coding agents. Author scenes, combine
generated and recorded media, and export images, diagrams, animation, and video
from retained sources.**

Describe a finished result to Codex, Claude, or another coding agent. Slopcamera gives
it a Bun CLI, TypeScript SDK, and version-matched Agent Skill to inspect sources,
direct cameras, edit a composition, and render the result. A separate MCP server
exposes a fixed diagram and image toolset. There is no Slopcamera account or hosted
project database.

[Install](#install-slopcamera) · [Make a first diagram](#make-your-first-diagram) · [Capabilities](#what-slopcamera-does) · [Documentation](docs/README.md) · [slopcamera.com](https://slopcamera.com)

## Why Slopcamera

- **Keep creative work editable.** Native scenes, portable scenes, diagrams,
  and video projects retain their own sources and settings. Rendered frames
  and portable assets are derivatives; a video of a character does not retain
  its rig.
- **Give agents explicit operations.** Inspect a project, name a camera, plan
  a render, review a candidate, and select a result. The CLI returns structured
  results and keeps operation receipts that identify inputs and outputs.
- **Revise without replacing the originals.** Normal media edits record cuts,
  timing, framing, captions, and effects as project decisions. Preview and final
  renders use the same timeline and composition.
- **Choose where computation happens.** Local rendering and editing use your
  machine. Optional model-backed work uses your Vercel AI Gateway access, with
  explicit acknowledgement before named local media is uploaded. Native Python
  authoring requires separate trust because it runs as your current user.

## Install Slopcamera

Install [Bun 1.3.14 or newer](https://bun.sh), then install the verified
[Slopcamera v3.2.4 release](https://github.com/hraness/slopcamera/releases/tag/v3.2.4)
from its canonical archive:

```sh
bun add --global https://github.com/hraness/slopcamera/releases/download/v3.2.4/hraness-slopcamera-3.2.4.tgz
slopcamera skill install --target agents
```

Contributors can build from source instead. Install Git as well, then use a new
checkout:

```sh
git clone --branch main https://github.com/hraness/slopcamera.git slopcamera-source
cd slopcamera-source
git rev-parse HEAD > ../slopcamera-source-commit.txt
bun install --frozen-lockfile --ignore-scripts
bun run build:sdk
bun run build:desktop:cli
```

Keep the checkout and recorded commit. In this shell, define the command against
that exact build:

```sh
export SLOPCAMERA_SOURCE_ROOT="$PWD"
slopcamera() { bun "$SLOPCAMERA_SOURCE_ROOT/apps/desktop/dist/cli/main.js" "$@"; }
slopcamera --help
slopcamera doctor --json
slopcamera skill install --target agents
```

Use `--target claude` for Claude Code or omit the target for Codex. Add
`--scope project` inside the target repository for a project-only skill install.
The skill comes from the same checkout as the CLI. Start a new agent session
after installation. In a later shell, restore the checkout path and function.

Native engines install separately. The [source-install guide](docs/how-to/use-current-source.md)
explains workspace placement and durable-run identity; the
[capability reference](docs/reference/capabilities.md) names runtime requirements.

<details>
<summary>Historical Atet release evidence</summary>

[Atet v3.2.3](https://github.com/hraness/atet/releases/tag/v3.2.3) and its
[original archive](https://github.com/hraness/atet/releases/download/v3.2.3/hraness-atet-3.2.3.tgz)
remain historical publication evidence. Those immutable bytes install Atet,
not Slopcamera. Renaming the repository does not create a renamed package or
change an existing release.

</details>

## Make your first diagram

After the source build above, this local task needs no model account. In a new directory,
create the included diagram, check it, and render it:

```sh
mkdir slopcamera-first
cd slopcamera-first
slopcamera diagram init first.diagram.json
slopcamera diagram check first.diagram.json --strict
slopcamera diagram render first.diagram.json
```

You now have `example-flow.tldr`, `example-flow.light.svg`,
`example-flow.dark.svg`, `example-flow.light.png`, and
`example-flow.dark.png`. Open a PNG to inspect the result. The JSON remains
editable, and the `.tldr` file is editable tldraw interchange. Rendering again
replaces those five derived files.

Follow [Your first diagram](docs/tutorials/first-diagram.md) to change a label and
see the result. For a moving 3D subject, use [Directed scenes](docs/spatial-scenes.md).
For detailed native 3D from the current source build, follow
[Your first native film](docs/tutorials/first-native-film.md).

## What Slopcamera does

### Author scenes and direct cameras

Place geometry, images, video, diagrams, and text in a portable scene. Inspect
stable part IDs, make typed edits, select a named camera, and render frames,
contact sheets, or video. The Three.js profile includes calibrated cameras,
explicit animation, supported GLB geometry, and an explicitly selected hardware
GPU path. Spark admits saved splat worlds for local camera direction.

> Create a short product reveal. Keep the model editable, orbit the camera,
> mount the product diagram on a screen in the scene, and show me contact frames
> before rendering the video.

The portable GLB profile has a defined geometry and material subset. Saved splats
capture appearance; they do not establish collision geometry or editable native
meshes. See [Directed scenes](docs/spatial-scenes.md).

### Film native worlds and educational animation

The current source build can direct Blender for detailed sets, materials,
lighting, skinned characters, cloth and liquid caches; CadQuery for parametric
solids and STEP; and Manim Community for mathematical animation. Seven editable
starters include a product, character, shaded street, cloth, liquid, CAD bracket,
and educational presenter.

> Build a shaded street with an original presenter. Explain the idea with an
> animated diagram mounted in the world, then pull the camera back into the
> city. Keep the native scenes and diagram sources for later edits.

Native source and exact job settings remain retained. Verified frames can become
an ordinary project clip. `slopcamera scene camera-track` samples an explicit
camera clock for reuse. Supported GLB derivatives and calibrated cameras can
cross between native and portable scenes; rigs, solvers, and procedural materials
remain native. Blender and Python environments are installed separately, and
source execution requires explicit current-user trust. See [Native film studio](docs/studio.md)
and [Make an educational video](docs/how-to/educational-video.md).

### Build diagrams and motion graphics

Create editable diagrams with tldraw, SVG, and PNG outputs, or turn raster artwork
into SVG locally with VTracer. Animate graphic layers with HTML, SVG, Motion,
p5, Two, Paper Shaders, or Three.js. Outputs can stand alone or join a video
project. The optional vgpu example renders programmable WebGPU passes into
retained raster frames for use on a world-space screen.

Use `slopcamera html catalog` to inspect the admitted local creative tools. The
[creative toolkit reference](docs/html-overlay-creative-toolkit.md) distinguishes
available profiles from upstream possibilities. vgpu does not enable shared GPU
textures or a Three WebGPU renderer inside the current WebGL2/Spark profile.

### Generate and direct media

Discover image, video, speech, and transcription models through your own Vercel
AI Gateway access. Generate images from text and references, add a voiceover,
transcribe sound, or create video shots using the selected model's supported
inputs. Availability and pricing come from the live catalog.

The current source build also provides `direct` shot recipes: retain a film
budget across attempts, review each take before accepting it, and use an accepted
clip's last decoded frame as the next shot's reference. Changed predecessors
invalidate affected continuations while earlier paid results remain retained.
Model continuity is reviewed, not guaranteed. Budget estimates are not a provider
billing cap.

See [Generate media](docs/how-to/generate-media.md), [Direct short generated clips](docs/directing-video.md),
and [Gateway configuration](docs/vercel.md). Generation uses caller-owned access;
uploading local references requires the matching explicit acknowledgement.

### Edit footage and deliver finished videos

Record a screen, camera, microphone, and system audio on macOS, or import existing
footage. Remove pauses and filler words, align sound, reframe speakers, zoom into
screen actions, and add captions, graphics, color, and audio treatment. Preview
candidates before selecting a result, then export clean and captioned versions
in 16:9, 9:16, 1:1, and 4:5 from the same edit.

> Edit my product demo: cut the pauses, zoom into each important click, keep the
> speaker framed, add captions and `logo.svg`, and show a preview before export.

Recording requires the corresponding macOS permissions. Input-event capture can
include clicks, cursor movement, key activity, and focused-input information;
typed-text capture is separately opt-in and secure fields are suppressed. Read
[`PRIVACY.md`](PRIVACY.md) before recording sensitive material.

Start with [Edit a video](docs/how-to/edit-video.md) or inspect a reusable recipe:

```sh
slopcamera workflows list --json
slopcamera workflows show social-variants --json
```

## How Slopcamera works

Keep the source that owns each creative decision. A native scene owns a rig or
simulation; a portable scene owns supported geometry, cameras, and media surfaces;
a diagram owns its objects and labels; a video project owns cuts and delivery.
SLOPCAMERA connects these through explicit assets and rendered derivatives.

1. **Prepare the sources.** Import footage and assets or author a scene, diagram,
   or native program. Inspect available tools before choosing an engine.
2. **Direct the result.** Name cameras, shots, timing, composition, and output
   settings. Generate missing media only when the job calls for it.
3. **Review a render.** Inspect contact frames, motion, captions, sound, and
   continuity. Preserve candidates and select the approved result.
4. **Deliver and revise.** Export the required formats and retain source paths,
   project decisions, and operation receipts for the next change.

### Instructions for coding agents

Read local project instructions and inspect sources before changing them. Use
`slopcamera --help`, `slopcamera doctor --json`, `slopcamera operations list --json`, and the
installed skill to discover the exact local surface. Agree on material output
requirements, preview substantial changes, inspect the resulting files, and
report their paths. Do not infer provider access, native trust, or model quality
from a successful plan.

[Run agent workflows](docs/how-to/run-workflows.md) covers reusable recipes,
declarative graphs, approvals, and resuming work.

## Important limitations

- **Runtime support varies.** The CLI uses Bun on macOS, Linux, and Windows;
  capture is macOS-specific. Media, browser, GPU, and native studio profiles
  have additional requirements. Use the capability reference and `slopcamera doctor`.
- **Interchange preserves a supported subset.** Native rigs and simulations do
  not become editable Three scenes by exporting a GLB. An image or video on a
  plane supplies pixels, not hidden geometry. Calibrated camera exchange does
  not match lighting, depth of field, or color treatment automatically.
- **Generated media requires review.** Models may change subject identity,
  motion, or text. Saved AI worlds are appearance assets, not validated robotics
  or reinforcement-learning environments.
- **Trusted code is not sandboxed.** Native Python and caller-authored Bun
  workflows run with the current user's access. Hashes and receipts identify
  observed inputs and outputs; they do not make arbitrary code hermetic.
- **MCP is a subset.** Its fixed tools check and render diagrams, vectorize
  images, and generate images. It does not expose every local CLI operation.

## Design and trust

There is no Slopcamera account, hosted project database, or browser generation service.
Ordinary editing and rendering remain local. Gateway generation and selected
cloud analysis use credentials from the local process and request explicit
acknowledgement before uploading named media. This website never accepts a
Gateway credential. Native Python requires separate authorization. Custom Bun
workflow modules execute when loaded, including during check and plan; review
their source first. Both have the current user's access, including potential
network access, outside the normal media-operation boundary.

Original media remains unchanged by normal edit operations. Projects retain
explicit revisions, and important operations record their inputs and outputs.
Native tools, providers, codecs, and GPU drivers can affect results, so retained
source identity alone does not promise identical pixels on another machine.

See [Architecture](docs/architecture.md), [`SECURITY.md`](SECURITY.md),
[`PRIVACY.md`](PRIVACY.md), and [`NOTICE`](NOTICE) for the detailed boundaries.

## Documentation

- **Learn:** [Your first diagram](docs/tutorials/first-diagram.md) · [Your first native film](docs/tutorials/first-native-film.md).
- **Make a result:** [Edit video](docs/how-to/edit-video.md) · [Generate media](docs/how-to/generate-media.md) · [Run workflows](docs/how-to/run-workflows.md) · [Educational video](docs/how-to/educational-video.md).
- **Look up support:** [Capabilities and release availability](docs/reference/capabilities.md) · [SDK entrypoints](docs/reference/sdk.md) · [Creative tools](docs/html-overlay-creative-toolkit.md).
- **Understand the system:** [Architecture](docs/architecture.md) · [Native studio](docs/studio.md) · [Directed scenes](docs/spatial-scenes.md).

The [documentation index](docs/README.md) connects these paths.

## For software integrations

Run this example with Bun from the source checkout after `bun run build:sdk`.
The checkout resolves its own `@hraness/slopcamera` package exports.

SDK imports do not start the CLI or inspect local project state. For example,
convert an existing local image into an SVG:

```ts
import { vectorizeImage } from "@hraness/slopcamera"

const result = await vectorizeImage("logo.png", { outputPath: "logo.svg" })
console.log(result.receipt.sourceSha256, result.receipt.svgSha256)
```

Use `@hraness/slopcamera/code` for declarative workflow graphs,
`@hraness/slopcamera/workflow` for trusted Bun workflows, and `@hraness/slopcamera/local/*`
for the local media engine. See the [SDK reference](docs/reference/sdk.md) for
entrypoint scope and execution effects.

## Verification

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

The required check covers public SDK boundaries, the local runtime, schemas,
Agent Skill, generated entrypoints, static site, deterministic and property
tests, and packed consumers. Native and provider-dependent profiles require
their corresponding external qualification; a local unit-test pass does not
establish them. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the complete gates.

## Contributing

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) and the nearest `AGENTS.md` before
changing a package or runtime boundary. Report vulnerabilities through
[`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE), with third-party notices in [`NOTICE`](NOTICE).
