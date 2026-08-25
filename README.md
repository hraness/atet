# Atet

[![Atet: AI media generation and video editing for coding agents](https://atet.sh/og.png)](https://atet.sh)

[![skills.sh](https://skills.sh/b/hraness/atet)](https://skills.sh/hraness/atet)

**AI media generation and video editing for coding agents.**

Atet lets Codex, Claude, and other coding agents generate images, video, and
voice; edit screen recordings and imported footage; add captions, graphics,
and motion; and export finished videos from the files in your project.

The toolkit runs on your computer. Its Agent Skill teaches your coding agent
how to use the Bun CLI, local media engine, and Vercel AI Gateway as one
creative workflow. Atet has no account system and does not upload a project to
an Atet service.

[Install](#install-atet) · [Try a request](#start-with-a-finished-job) · [Capabilities](#what-atet-does) · [Design](#how-atet-works) · [atet.sh](https://atet.sh) · [Security](SECURITY.md)

## Install Atet

Install the single Atet Agent Skill with either runner:

```sh
npx skills add hraness/atet
# or
bunx skills add hraness/atet
```

Start a new agent session after installing the skill. It teaches Codex, Claude
Code, Cursor, and other compatible agents how to turn a finished-media request
into checked Atet operations.

Atet requires [Bun 1.3.14 or newer](https://bun.sh). Install the current CLI,
then inspect the local media host:

```sh
bun add --global github:hraness/atet#v2.0.0
atet doctor
```

The CLI carries the guide released with that exact CLI version. Prefer the
public `skills` command for the current repository guide. Use
`atet skill install` when you specifically need the CLI's version-matched
runner installer.

Move into the project where you want Atet to work, then check the available
recording, rendering, browser, and media tools:

```sh
cd /path/to/your/project
atet doctor
```

The public `skills` command follows the scope selected in that installer. If
you instead use the CLI's version-matched guide, `atet skill install` defaults
to Codex across your user account.

For Claude Code or another system that reads Agent Skills:

```sh
atet skill install --target claude
atet skill install --target agents
```

To install the guide only for the current repository, run
`atet skill install --scope project` from that repository. Use
`--project <path>` to name a different repository. `atet skill path` prints the
packaged guide for inspection.

Atet is distributed directly through GitHub and is not published to npm.

## Start with a finished job

Open the project that contains your footage, artwork, script, or other source
files. Start a new agent session and describe the finished result. These are
the kinds of requests Atet is built to handle.

### Edit a product demo

> Use Atet to record my screen, camera, microphone, and system audio while I
> demo the app. When I stop, turn the recording into a polished two-minute
> walkthrough. Remove long pauses and filler words, zoom in when I click or
> type, keep me framed, add readable captions and `logo.svg`, and show me a
> preview before exporting the final video.

### Generate an opening sequence

> Use Atet to create three opening-shot ideas from `product.png`. Show them to
> me side by side, then animate the one I choose into a six-second widescreen
> clip. Keep the product shape, colors, and lettering recognizable.

### Add voice and deliver every format

> Use Atet to generate a calm voiceover from `script.txt`, place it over the
> approved edit, mix the music quietly underneath it, and export clean
> and captioned versions in 16:9, 9:16, 1:1, and 4:5.

### Explain a system visually

> Use Atet to turn the services in this repository into an editable diagram,
> then build a short animated version that introduces each service in order.

Name the source files, the result you want, and any details that must remain
unchanged. Your agent can inspect the current project, discover available
models, choose the necessary Atet operations, render a preview, and report the
files it created. You do not need to learn the command tree first.

## What Atet does

### Edit real video

Atet keeps video work in a project, so each change can be reviewed and revised
before export.

- Record the screen, camera, microphone, and system audio on macOS, or import
  existing video, audio, images, and graphics.
- Find silence, filler words, faces, scenes, music, clicks, cursor movement,
  keystrokes, and typed text without changing the original media.
- Cut, trim, retime, align audio, reframe the camera, follow a speaker, and add
  screen zooms where the action needs attention.
- Add images, SVG, GIFs, video, emoji, HTML, shaders, or Three.js scenes as
  overlays with controlled timing, placement, motion, and audio behavior.
- Apply captions, denoise and mix audio, adjust color, and render the same edit
  for landscape, vertical, square, and portrait delivery.
- Create several preview candidates from one frozen project, choose one, and
  promote it without overwriting the alternatives.

Built-in workflows cover talking-head cleanup, polished screen demos,
chaptered videos, creative alternatives, selection, and social variants. Run
`atet workflows list` to see the exact catalog installed on the current
machine.

### Generate the media a project is missing

Atet discovers the current image, video, speech, and transcription models
available through [Vercel AI Gateway](https://vercel.com/ai-gateway). Your
agent can then:

- generate images from text, reference images, or masks;
- generate video from text, a source image, first and last frames, or other
  visual references;
- create spoken audio from a script, with the selected voice, language, pace,
  instructions, and file format;
- transcribe audio to text, JSON, SRT, and VTT; and
- bring generated media back into a local video project for editing and
  delivery.

Local media never uploads implicitly. A command must explicitly acknowledge
any local image, video, or audio that will be sent to a model provider. Atet
uses the caller's Gateway credential, validates downloaded media, and writes
outputs and receipts under `artifacts/atet/generated/`.

### Build graphics and motion

- Turn an explanation into an editable diagram with tldraw, SVG, and PNG
  exports.
- Convert caller-owned raster artwork to SVG locally with the pinned VTracer
  runtime.
- Build deterministic animated loops and transparent video layers with HTML,
  SVG, Motion, Paper Shaders, or Three.js.
- Use an existing image as the visual reference for a reviewed 3D scene or
  branded material treatment.

An image can become a video reference, an animated scene can become an
overlay, and one approved edit can become every delivery format. The same
project is available through the Agent Skill, CLI, TypeScript SDK, MCP server,
and macOS desktop app.

## How Atet works

Atet keeps the creative process legible to both the person making a request
and the agent doing the work.

1. **Bring in the source.** Record a screen and camera, import existing media,
   or point the agent to the files already in the repository.
2. **Create what is missing.** Generate an image, video shot, voiceover, or
   transcript through the caller's Gateway account when the project needs it.
3. **Shape the edit.** The agent applies explicit operations to a local project
   while the original media remains unchanged.
4. **Review a real preview.** Preview renders use the same timeline and
   composition as the final export at a lower cost.
5. **Deliver the approved work.** Atet renders the selected project state to
   the requested aspect ratios, caption treatments, and destinations.

Project revisions are explicit. Alternatives begin from a named project state,
important operations record what produced their outputs, and repeated work can
reuse verified results. That makes the workflow inspectable without asking a
person to manage low-level media commands.

### Instructions for coding agents

Agents using Atet should follow these rules:

1. Read the repository's local instructions before changing anything.
2. Inspect the named source files and search for an existing Atet project or
   editable source for the same subject.
3. Confirm the requested result, non-negotiable details, and delivery formats.
   Ask only when a missing choice would materially change the work.
4. Discover current capabilities instead of inventing model IDs, project IDs,
   media stream IDs, or command options.
5. Preserve original media. Change project state or editable source, then
   regenerate previews and final outputs.
6. For substantial video work, render a preview before the final delivery.
7. Keep Gateway credentials in the process environment. Never put a key in a
   command, project file, log, or generated artifact.
8. Inspect visual output and report the useful source, preview, receipt, and
   final output paths.

Useful discovery commands:

```sh
atet --help
atet doctor --json
atet workflows list --json
atet ai models list --json
atet operations list --json
atet skill path
```

### Useful media commands

Inspect the current model catalog before selecting a model:

```sh
atet ai models list --type image
atet ai models list --type video
atet ai models list --type speech
atet ai models show <model-id>
```

Generate an image or a referenced video shot through Gateway:

```sh
atet ai image generate \
  --model <image-model-id> \
  --prompt-file image-brief.txt \
  --aspect-ratio 16:9

atet ai video generate \
  --model <video-model-id> \
  --prompt-file shot-brief.txt \
  --image product.png \
  --duration 6 \
  --aspect-ratio 16:9 \
  --allow-cloud-upload
```

Create a voiceover or transcript:

```sh
atet ai speech generate \
  --model <speech-model-id> \
  --text-file script.txt \
  --format wav

atet ai transcribe interview.wav \
  --model <transcription-model-id> \
  --format all \
  --allow-cloud-audio-upload
```

Inspect a local video project and the built-in editing workflows:

```sh
atet projects list --json
atet project inspect <project-id> --json
atet workflows show talking-head-cleanup --json
atet workflows show social-variants --json
```

Run `atet help ai`, `atet help project`, or `atet help workflows` for the full
current command grammar. The Agent Skill contains the decision rules an agent
needs to turn a plain-language brief into those exact commands.

For a connected MCP server, run
`atet mcp --root /absolute/path/to/workspace`. The server limits file access to
that workspace and exposes a fixed set of typed Atet operations rather than
executing arbitrary commands supplied through MCP.

## Design and trust

- **No Atet account:** there is no hosted project database, login, or
  subscription.
- **Local project authority:** source media, project state, diagrams,
  vectorization, deterministic rendering, previews, and outputs stay on the
  computer running Atet.
- **Caller-owned AI access:** model-backed work uses `AI_GATEWAY_API_KEY` or a
  short-lived `VERCEL_OIDC_TOKEN` from the current process. Atet does not store
  or print either credential.
- **Non-destructive editing:** cuts, timing, framing, overlays, and effects are
  recorded as project decisions rather than applied to the original media.
- **Preview and final agree:** both use the same timeline and composition.
- **Bounded work:** Atet checks paths, media types, decoded dimensions, byte
  limits, process duration, and expensive concurrent operations.
- **Inspectable history:** important media and model operations retain
  secret-free receipts that identify their inputs and implementation.

Read [the architecture guide](docs/architecture.md) for project revisions,
rendering, caching, workflow execution, and network boundaries. See
[SECURITY.md](SECURITY.md) for reporting and supported-version policy and
[NOTICE.md](NOTICE.md) for tldraw Offline, VTracer, rendering, and model
integration terms.

## For software integrations

Add the package to a Bun project:

```sh
bun add github:hraness/atet#v2.0.0
```

SDK imports do not start the CLI or inspect local project state:

```ts
import { vectorizeImage } from "@hraness/atet"

const result = await vectorizeImage("logo.png", {
  outputPath: "logo.svg",
})

console.log(result.receipt.sourceSha256, result.receipt.svgSha256)
```

Use `@hraness/atet/code` for declarative workflow graphs,
`@hraness/atet/workflow` for trusted Bun workflows imported by the caller, and
`@hraness/atet/local/*` for the local media engine. Atet exposes a fixed set of
typed operations. It does not let a remote caller register and execute
arbitrary code through the operation registry.

## Why the name Atet

**Agentic creative coding toolkit.**

At the beginning of time, when there was nothing but chaos, Atum existed alone
in the watery mass of Nun. A pyramid mound called Benben emerged. When the
lotus flower bloomed, Atum dawned and became Ra. Every night Ra sails in the
underworld on the solar barque Atet.

## Repository map

- `src/`: portable SDK, CLI adapters, operations, MCP, and workflows.
- `apps/desktop/`: local media engine, CLI host, desktop app, and native
  capture helpers.
- `schema/` and `examples/`: diagram schema and runnable examples.
- `skills/atet/`: the packaged Agent Skill and its focused references.
- `docs/architecture.md`: the maintained technical overview.

## Development

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

The full check verifies the standalone public boundary, SDK, local runtime,
schema, Agent Skill, generated entrypoints, static site, deterministic tests,
property tests, and a clean packed consumer.

## License

MIT.
