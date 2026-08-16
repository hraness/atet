# Atet

[![Atet: agentic creative coding toolkit](https://atet.sh/og.png)](https://atet.sh)

**Agentic creative coding toolkit.**

At the beginning of time, when there was nothing but chaos, Atum existed alone
in the watery mass of Nun. A pyramid mound called Benben emerged. When the
lotus flower bloomed, Atum dawned and became Ra. Every night Ra sails in the
underworld on the solar barque Atet.

Atet is an open-source, local-first creative coding toolkit for agents. It gives
Codex, Claude, and other coding agents a checked path from an idea or source
asset to images, diagrams, animated loops, and video. The TypeScript SDK, Bun
CLI, Agent Skill, MCP server, and local runtime share one set of contracts, so
the files a person reviews are the files the tools understand.

[Install](#install-atet-for-your-agent) · [Use with an agent](#give-your-agent-a-task) · [Capabilities](#what-atet-makes) · [Architecture](#how-atet-works) · [atet.sh](https://atet.sh) · [Security](SECURITY.md)

## Install Atet for your agent

Atet requires [Bun 1.3.14 or newer](https://bun.sh). Install the CLI and its
Agent Skill from the public repository:

```sh
bun add --global github:hraness/atet
atet skill install
atet doctor
```

Run `atet doctor` from the project you want the agent to use. Start a new agent
session after installing the skill so the agent discovers it. The default
installs Atet for Codex in your user account.

Choose another agent or keep the skill inside one repository when needed:

```sh
atet skill install --target claude
atet skill install --target agents
atet skill install --scope project
```

`--scope project` uses the current directory. Pass `--project <path>` when the
target repository is elsewhere. `atet skill path` prints the packaged source
of the installed guide.

Atet is distributed directly through GitHub and is not published to npm. To
use the SDK inside a Bun project:

```sh
bun add github:hraness/atet
```

## Give your agent a task

Open a project and describe the result. Name Atet when you want the agent to
use its checked creative workflow.

> Use Atet to turn this repository architecture into a clear diagram.

> Use Atet to vectorize this mark and keep the original beside the reusable
> asset.

> Use Atet to create three image directions for this chapter and help me
> compare them.

> Use Atet to build a seamless animated loop from this reference image.

> Use Atet to review this video project and explain the next checked step.

The skill teaches the agent to find existing source, preserve the literal
request, choose a bounded capability, run the work, inspect the result, and
keep editable source when the workflow has one. You do not need to memorize
the command tree before asking for work.

### Agent operating guide

Agents working directly with the repository should follow these rules:

1. Read local repository instructions and look for existing Atet source before
   creating another copy.
2. Treat the user prompt as the content specification. Do not invent labels,
   relationships, examples, or visual claims.
3. Keep authored diagram, scene, and workflow source authoritative. Regenerate
   derived files instead of editing them by hand.
4. Use `--json` or the semantic operation registry when another program needs
   a stable result. Do not scrape human-readable terminal output.
5. Keep credentials process-local. Never put a Gateway key in a command,
   project file, receipt, or generated artifact.
6. Inspect visual output at its intended size and report useful source,
   artifact, and receipt paths.

Current machine-readable discovery:

```sh
atet --help
atet operations list --json
atet code search 'diagram' --limit 4
atet skill path
```

For a connected tool server, run `atet mcp --root /absolute/workspace`. Its
dedicated diagram tools and fixed `search_atet` / `execute_atet` registry keep
file access inside that selected workspace.

## What Atet makes

| Output | What an agent can do | Inspectable result |
| --- | --- | --- |
| Images | Generate through Vercel AI Gateway or convert caller-owned raster artwork into bounded SVG. | Image files, local vector output, and generation or provenance receipts. |
| Diagrams | Turn an explanation into checked source and render it for editing or publication. | One `.diagram.json` source, editable `.tldr`, light and dark SVG, and light and dark PNG. |
| Animated loops | Build timed HTML, SVG, shader, or Three.js scenes and render repeatable motion. | Reviewed scene source, references, preview, and final artifact. |
| Video | Compose recordings, imported media, generated candidates, audio, captions, overlays, camera moves, and delivery variants. | An immutable project revision with preview, final outputs, and receipts. |

These are four output families, not four separate products. They share the
same source, project, execution, and artifact model.

### Useful CLI examples

Create and render an editable diagram:

```sh
atet diagram init diagrams/system.diagram.json
atet diagram check diagrams/system.diagram.json --strict
atet diagram render diagrams/system.diagram.json
```

Vectorize existing artwork locally, without a credential or network request:

```sh
atet image vectorize input.png --output input.svg --json
```

Generate an image through Vercel AI Gateway:

```sh
export AI_GATEWAY_API_KEY='<value>'
atet image generate 'one cobalt circle on white' \
  --output circle.webp \
  --json
```

With a linked Vercel project, a short-lived OIDC token can stay outside project
files:

```sh
vercel env run -- atet image generate \
  'one cobalt circle on white' \
  --output circle.webp \
  --json
```

### TypeScript SDK

SDK imports have no CLI side effects and do not inspect local state:

```ts
import { vectorizeImage } from "@hraness/atet"

const result = await vectorizeImage("input.png", {
  outputPath: "input.svg",
})

console.log(result.receipt.sourceSha256, result.receipt.svgSha256)
```

Use `@hraness/atet/code` for declarative graphs,
`@hraness/atet/workflow` for explicitly imported Bun workflows, and
`@hraness/atet/local/*` for the complete local media engine. The operation
registry is closed: callers select typed capabilities rather than registering
arbitrary code at runtime.

## How Atet works

Atet has three visual primitives: a still frame, a structured scene, and a
time-based composition. Images, diagrams, loops, and videos are common outputs
built from those primitives.

The path through the system stays simple:

1. **Intent.** A person describes the result or provides source material.
2. **Plan.** The agent chooses a known Atet capability and creates or updates
   checked source when the work has one.
3. **Execution.** Atet validates inputs, coordinates local resources, and calls
   Vercel AI Gateway only when a model is required.
4. **Result.** Artifacts return to caller-owned storage with the source and
   identity needed to inspect, revise, or reproduce the work.

The portable SDK, CLI, Agent Skill, MCP server, complete local runtime, and
desktop shell use that same engine. The desktop adds native capture,
permissions, and preview UI. It does not create a separate project format.

Important design properties:

- **Caller-owned storage.** Atet has no hosted account, database, session, or
  subscription system.
- **Source before output.** Source-based work keeps its editable plan or scene;
  rendered files remain replaceable.
- **Immutable project revisions.** Creative candidates and delivery variants
  branch from an exact base rather than silently rewriting it.
- **Content-addressed reuse.** Unchanged analysis and renders can be reused by
  exact identity.
- **Bounded execution.** Inputs, pixels, frames, subprocesses, downloads,
  responses, and expensive concurrent work have explicit limits.
- **Truthful previews.** Preview and final resolve the same composition at
  different quality profiles.

Read [the architecture guide](docs/architecture.md) for the project, cache,
rendering, and network boundaries.

## Trust and network boundary

Local diagram rendering and image vectorization do not require network access.
Model-backed work sends the prompt and supplied media directly from the current
process to Vercel AI Gateway and the selected provider. Atet reads
`AI_GATEWAY_API_KEY` first or a short-lived `VERCEL_OIDC_TOKEN`; it does not
store or print either credential.

Atet validates its own capabilities, paths, and artifacts. It is not an
operating-system sandbox. Explicitly imported Bun workflows and other code a
user chooses to run retain the trust of that user account.

See [SECURITY.md](SECURITY.md) for reporting and supported-version policy, and
[NOTICE.md](NOTICE.md) for tldraw Offline, VTracer, rendering, and model
integration terms.

## Repository map

- `src/`: portable SDK, CLI adapters, semantic operations, MCP, and workflows.
- `apps/desktop/`: complete local runtime, media engine, CLI host, desktop app,
  and native capture helpers.
- `schema/` and `examples/`: public diagram schema and runnable examples.
- `skills/atet/`: the packaged Agent Skill and its focused references.
- `docs/architecture.md`: the maintained system overview.

## Development

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

The full check verifies the standalone public boundary, SDK and local runtime,
schema, Agent Skill, deterministic and property tests, generated entrypoints,
static site, and a clean packed consumer.

## License

MIT.
