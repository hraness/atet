# Atet

[![Atet: creative tools for coding agents](https://atet.sh/og.png)](https://atet.sh)

**Creative tools for coding agents.**

Atet gives Codex, Claude, and other coding agents a practical way to create
images, editable diagrams, animated loops, and video inside a project. It
includes a Bun CLI, meaning a command-line app that does the work, and an Agent
Skill that teaches the agent how to use it.

Install Atet once, open a project, and describe the result you want. Your agent
chooses the appropriate Atet command, works with the files in that project, and
shows you what it made. Atet does not require an account or upload your project
to an Atet service.

[Install](#install-atet) · [Ask for something](#ask-your-agent-to-use-atet) · [Outputs](#what-atet-can-make) · [Design](#how-atet-is-designed) · [atet.sh](https://atet.sh) · [Security](SECURITY.md)

## Install Atet

Atet requires [Bun 1.3.14 or newer](https://bun.sh). Run these commands once:

```sh
bun add --global github:hraness/atet
atet skill install
```

The first command installs the Atet command-line app. The second installs a
short guide that Codex reads when you ask it to use Atet.

Next, move into the project where you want to work and check what Atet can use
on your computer:

```sh
cd /path/to/your/project
atet doctor
```

Start a new agent session after installing the skill. The default installation
works with Codex across your user account.

For Claude Code or another agent system:

```sh
atet skill install --target claude
atet skill install --target agents
```

To install the guide only for the current repository, run this from that
repository:

```sh
atet skill install --scope project
```

Use `--project <path>` when the target repository is somewhere else.
`atet skill path` prints the packaged guide so you or your agent can inspect
the exact instructions.

Atet is distributed directly through GitHub and is not published to npm.

## Ask your agent to use Atet

Open the project that contains your source files, start a new agent session,
and mention Atet in your request. Say which file or subject to use and what you
want to receive.

> Use Atet to turn the services in this repository into a diagram I can edit
> later.

> Use Atet to convert `logo.png` into a clean SVG. Keep the original PNG
> unchanged.

> Use Atet to create three cover-image ideas for this article and show them to
> me side by side.

> Use Atet to turn `reference.png` into a seamless five-second 3D loop with a
> transparent background.

> Use Atet to render this logo as polished metal on a plain background. Keep
> the original shape recognizable.

You do not need to learn the command tree first. The installed skill tells the
agent which Atet tools exist, how to run them, and what to inspect before it
reports back.

### What happens after you ask

1. Your agent reads the Atet skill and your project instructions.
2. It looks for the source files you named and any existing Atet work for the
   same subject.
3. It chooses an Atet command that matches the request.
4. Atet checks the inputs, creates the result, and saves it in your project.
5. The agent inspects the result and tells you which files were created or
   changed.

When the work has editable source, such as a diagram or 3D scene, Atet keeps
that source alongside the rendered output. You can ask for revisions in the
same plain language.

### Instructions for coding agents

Agents using Atet should follow these rules:

1. Read the repository's local instructions before changing anything.
2. Search for existing Atet source for the same subject before creating a new
   copy.
3. Treat the user's request as the content specification. Do not invent labels,
   relationships, examples, or claims.
4. Change editable source, then regenerate derived images or video. Do not
   patch a rendered file when source exists.
5. Use `--json` when another program needs to read a command result.
6. Keep Gateway credentials in the process environment. Never put a key in a
   command, project file, log, or generated artifact.
7. Inspect visual output at the size where it will be used.
8. Report the useful source and output paths when the task is complete.

Useful discovery commands:

```sh
atet --help
atet operations list --json
atet code search 'diagram' --limit 4
atet skill path
```

For a connected MCP server, run
`atet mcp --root /absolute/path/to/workspace`. The server limits file access
to that workspace and exposes a fixed set of Atet operations rather than
running arbitrary commands supplied through MCP.

## What Atet can make

| Output | What Atet does | What you receive |
| --- | --- | --- |
| Images | Creates images through Vercel AI Gateway or converts artwork you already own into SVG locally. | The image or SVG, plus a small record of how Atet made it. |
| Diagrams | Turns an explanation or system description into an editable diagram. | One source file, an editable tldraw file, and light and dark SVG and PNG exports. |
| Animated loops | Builds repeatable motion with HTML, SVG, shaders, or Three.js. | Editable scene source, a preview, and the rendered loop. |
| Video | Combines recordings, imported media, graphics, sound, captions, and alternate formats in one project. | Project files, preview renders, and final exports. |

These are four kinds of output from one toolkit. An image can become part of a
diagram, a diagram can become part of a video, and the same project files can
be opened from the CLI, SDK, or desktop app.

### Common commands

Create and render an editable diagram:

```sh
atet diagram init diagrams/system.diagram.json
atet diagram check diagrams/system.diagram.json --strict
atet diagram render diagrams/system.diagram.json
```

Convert existing artwork to SVG on your computer, without a credential or
network request:

```sh
atet image vectorize logo.png --output logo.svg --json
```

Generate an image through your Vercel AI Gateway account:

```sh
export AI_GATEWAY_API_KEY='<value>'
atet image generate 'one cobalt circle on white' \
  --output circle.webp \
  --json
```

If the project is linked to Vercel, you can use its short-lived local
credential instead of storing a key in the project:

```sh
vercel env run -- atet image generate \
  'one cobalt circle on white' \
  --output circle.webp \
  --json
```

## How Atet is designed

Atet has several entry points, but they all use the same underlying project and
execution system:

- **Agent Skill:** a readable guide that teaches a coding agent when and how to
  use Atet.
- **CLI:** the `atet` command that agents and people run.
- **TypeScript SDK:** library functions for software that needs Atet directly.
- **MCP server:** a fixed, workspace-scoped set of tools for connected agents.
- **Local media engine:** project storage, rendering, analysis, and scheduling
  for larger media work.
- **macOS desktop app:** the same local engine with screen capture, permissions,
  previews, and a graphical interface.

The normal path through the system is straightforward:

1. **Request:** a person describes the result and points to any source files.
2. **Choose:** the agent selects a known Atet operation.
3. **Run:** Atet validates the inputs and performs the work locally, or uses
   Vercel AI Gateway when the request needs a generative model.
4. **Review:** Atet saves the files in the project and the agent inspects them
   with the person.

### Design choices

- **No Atet account:** there is no hosted project database, login, or
  subscription.
- **Local wherever possible:** diagrams, vectorization, project state, and
  deterministic rendering stay on the computer running Atet.
- **Editable work stays editable:** diagrams, scenes, and media projects keep
  their source instead of leaving only a flattened export.
- **Revisions are explicit:** alternatives and exports begin from a specific
  project state instead of silently overwriting earlier work.
- **Clear limits:** Atet checks file types, paths, dimensions,
  response sizes, process duration, and expensive concurrent work.
- **A record of what happened:** important model and media operations record the inputs
  and tool identity needed to understand how an output was produced, without
  recording credentials.
- **Preview matches final:** previews use the same timeline and composition as
  final renders at a lower quality setting.

Read [the architecture guide](docs/architecture.md) for project revisions,
caching, rendering, and network boundaries.

## For software integrations

Add the package to a Bun project:

```sh
bun add github:hraness/atet
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
`@hraness/atet/workflow` for trusted Bun workflows imported by the caller,
and `@hraness/atet/local/*` for the local media engine. Atet exposes
a fixed set of typed operations. It does not let a remote caller register and
execute arbitrary code through the operation registry.

## Network and trust

Diagram rendering and image vectorization do not need network access.
Model-backed work sends the prompt and supplied media from the current process
to Vercel AI Gateway and the selected model provider. Atet reads
`AI_GATEWAY_API_KEY` first or a short-lived `VERCEL_OIDC_TOKEN`; it does not
store or print either credential.

Atet checks the inputs accepted by its own commands. It is not an
operating-system sandbox. A Bun workflow or other project code that you
deliberately run has the same permissions as other code running under your
user account.

See [SECURITY.md](SECURITY.md) for reporting and supported-version policy, and
[NOTICE.md](NOTICE.md) for tldraw Offline, VTracer, rendering, and model
integration terms.

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
