# Atet

[![Atet: an open visual-media toolkit for agents and people](https://atet.sh/og.png)](https://atet.sh)

**Carry an idea all the way into view.**

Atet, named for Ra's solar barque, is an open-source TypeScript SDK and Bun CLI
for carrying ideas and raw assets into images, diagrams, animated loops, and
video.

The name fits the work: one vessel carries an idea from its first rough material
through rendering, review, and delivery. Atet keeps that journey inspectable,
with explicit sources, bounded execution, and editable artifacts instead of an
opaque creative endpoint.

```sh
bun add --global github:hraness/atet#v2.0.0
atet doctor
atet diagram init diagrams/system.diagram.json
atet image vectorize input.png --output input.svg --json
```

[Project site](https://atet.sh) · [Security policy](SECURITY.md) · [Architecture](docs/architecture.md)

## What Atet makes

- **Images.** Generate through Vercel AI Gateway or turn caller-owned raster
  artwork into bounded, inert SVG with an exact provenance receipt.
- **Diagrams.** Author checked JSON, then render editable tldraw interchange,
  light and dark SVG, and light and dark PNG from the same source.
- **Animated loops and video.** Compose local project graphs from imported
  media, generated candidates, HTML or Three.js overlays, audio, captions,
  camera moves, and explicit delivery variants.
- **Typed visual workflows.** Build declarative graphs or ordinary Bun
  workflows over a closed operation registry, with resource claims and durable
  receipts at every execution boundary.

## Why Atet is different

- **Local custody.** Project state, imported media, generated candidates, and
  delivery artifacts stay in caller-owned storage. Model requests go directly
  from the current process to Vercel AI Gateway.
- **Source before output.** Diagram source, scene source, workflow graphs, and
  exact references remain authoritative. Rendered media is replaceable.
- **Bounded by construction.** Parsers, paths, pixels, frames, responses,
  subprocesses, downloads, and concurrent resource claims have explicit limits.
- **Honest artifacts.** Atet records the tool, input identity, model, output,
  and verification evidence needed to understand how a result was made.
- **One visual engine.** The SDK, CLI, MCP server, complete local runtime, and
  desktop shell share the same typed contracts instead of drifting into
  separate products.

Atet complements editors, model providers, agent frameworks, and render tools.
Those systems own their interfaces and models. Atet owns the checked path from
an idea or source asset to visual-media artifacts an agent and a person can
inspect together.

## Install

Atet requires Bun 1.3.14. Pin the public repository to the immutable `v2.0.0`
tag for a global CLI install:

```sh
bun add --global github:hraness/atet#v2.0.0
atet doctor
```

Install the SDK into a Bun project with the same immutable source:

```sh
bun add github:hraness/atet#v2.0.0
```

Atet is distributed through immutable GitHub tags and Releases. It is not
published to npm.

Diagram rendering runs on macOS, Linux, and Windows. Bounded VTracer execution
runs on macOS and Linux; Windows fails closed with `tool_platform` until its
output can cross the same bounded capture path. Machine-global resource
admission is available on macOS and Linux and falls back truthfully to
process-local admission elsewhere.

## Diagrams

```sh
atet diagram init diagrams/system.diagram.json
atet diagram check diagrams/system.diagram.json --strict
atet diagram render diagrams/system.diagram.json
```

A successful render writes five same-stem outputs:

```text
system.diagram.json
system.tldr
system.light.svg
system.dark.svg
system.light.png
system.dark.png
```

The checked source uses the versioned public schema:

```json
{
  "$schema": "https://raw.githubusercontent.com/hraness/atet/v2.0.0/schema/diagram.schema.json",
  "version": 1,
  "name": "source-result",
  "canvas": { "width": 960, "height": 540 },
  "layout": {
    "type": "stack",
    "direction": "horizontal",
    "gap": 160,
    "align": "center"
  },
  "shapes": [
    { "id": "source", "type": "rect", "width": 220, "height": 140, "label": "Source" },
    { "id": "result", "type": "rect", "width": 220, "height": 140, "label": "Result" }
  ],
  "edges": [{ "id": "source-result", "from": "source", "to": "result" }]
}
```

Place `atet.config.ts`, `.mjs`, `.js`, or `.json` beside a diagram to provide
local fonts, sanitized SVG icons, or theme colors. Pass `--config <path>` when
the configuration belongs elsewhere. MCP and semantic operations never load
executable workspace configuration.

## Generate and vectorize images

Local vectorization is authentication-free and network-silent:

```sh
atet image vectorize input.png --output input.svg --json
atet image vectorize input.png \
  --output input.duotone.svg \
  --duotone '#1f2937,#f97316' \
  --json
```

Atet downloads the checksum-pinned official VTracer 0.6.4 archive on first
use. `ATET_VTRACER_PATH` can select a compatible local binary and
`ATET_CACHE_DIR` can move the tool cache. The receipt records the exact binary
hash and trace measurements.

Model-backed generation reads `AI_GATEWAY_API_KEY` before
`VERCEL_OIDC_TOKEN`, pins the Gateway origin, sets `maxRetries: 0`, and never
stores or prints either credential:

```sh
export AI_GATEWAY_API_KEY='replace-me'
atet image generate 'one cobalt circle on white' \
  --model google/gemini-3.1-flash-image-preview \
  --output circle.webp \
  --json
```

With a linked Vercel project, inject a short-lived OIDC token without creating
a project dotenv file:

```sh
vercel env run -- atet image generate \
  'one cobalt circle on white' \
  --output circle.webp \
  --json
```

## SDK and workflows

Importing an SDK entrypoint has no CLI side effect and does not inspect local
state:

```ts
import { vectorizeImage } from "@hraness/atet"

const result = await vectorizeImage("input.png", {
  outputPath: "input.svg",
})

console.log(result.receipt.sourceSha256, result.receipt.svgSha256)
```

`@hraness/atet/code` builds typed declarative graphs. It compiles each graph
against the host's closed capability projection and rejects unsupported work
before resource admission. `@hraness/atet/code/advanced` exposes lower-level
graph, compiler, plan, policy, and runner contracts without adding a mutable
operation registry.

`@hraness/atet/workflow` composes the same fixed operations in explicitly
imported Bun code. Runtime input is parsed before work starts, step identifiers
are unique, execution is bounded, and completed-step receipts survive every
failure path.

```ts
import { defineAtetWorkflow, runAtetWorkflow } from "@hraness/atet/workflow"

const checkedRender = defineAtetWorkflow({
  id: "checked-render",
  version: 1,
  parseInput(value: unknown) {
    if (typeof value !== "object" || value === null) throw new Error("input")
    const path = Reflect.get(value, "path")
    if (typeof path !== "string") throw new Error("path")
    return { path }
  },
  async run(workflow, input) {
    const checked = await workflow.operation(
      "check",
      "atet.diagram.check",
      input,
    )
    const rendered = await workflow.operation(
      "render",
      "atet.diagram.render",
      input,
    )
    return { checked, artifacts: rendered.artifacts }
  },
})

const result = await runAtetWorkflow(checkedRender, {
  path: "diagrams/system.diagram.json",
})
console.log(result.steps, result.output.artifacts)
```

The complete local runtime extends these portable contracts with immutable
source revisions, generated candidates, selections, media timelines, durable
scheduling, HTML and Three.js overlays, native capture helpers, and delivery
variants. The desktop shell adds operating-system permissions and application
UI; ordinary SDK and CLI use does not require it.

See [Architecture](docs/architecture.md) for the full boundary map.

## Semantic operations and MCP

```sh
atet operations list --json
atet code search diagram --limit 4
atet code execute atet.diagram.check \
  --input '{"path":"diagrams/system.diagram.json","strict":true}'
atet mcp --root /absolute/path/to/workspace
```

The stdio server exposes dedicated diagram tools plus `search_atet` and
`execute_atet`. File arguments are root-relative and confined to the selected
workspace. The server is a trusted local workspace boundary, not an
operating-system sandbox against concurrent same-user mutation.

## Canvases and the Agent Skill

Generated `.tldr` files are editable interchange and do not require the tldraw
SDK or desktop app to render:

```sh
atet canvas open diagrams/system.tldr
atet canvas status
atet canvas install
atet skill install --target codex --scope user
```

The optional installer resolves an official tldraw Offline release and verifies
its published SHA-256 digest. The packaged Agent Skill keeps literal prompts,
checked source, exact references, rendering, vectorization, semantic operations,
and review in one reusable workflow. `atet skill path` prints its packaged
location.

## Compatibility in version 2

Version 2 makes Atet the repository, package, SDK, skill, site, and canonical
CLI identity. The former `transmute` executable remains an alias to `atet`
through the 2.x release line so existing scripts have one major version to
migrate. Version-1 serialized operation identifiers and MCP tool names remain
accepted only as compatibility inputs; new output and documentation use Atet
identifiers. The four exact `@hraness/transmute/local/*` imports used by saved
local workflows are rewritten at load time to their Atet equivalents; newly
authored source uses only `@hraness/atet/local/*`.

Machine-local runs already in flight are the one deliberate exception. Finish
them with the 1.x host or restart them under Atet 2.x. Atet rejects predecessor
run stores before it acquires a lease or mutates state because translating
their plan hashes would also retarget staging paths and replay grants.

The immutable version-1 tags and Releases remain available in the same GitHub
repository history. GitHub redirects the former repository URL after the
rename. Do not create a new repository at that old path, because doing so would
replace GitHub's redirect.

## Limits and trust

- Generated meaning is never inferred into diagram labels, claims, legends,
  or relationships. Defaults resolve mechanics only.
- Raster and vector inputs, output pixels, arrays, frames, durations,
  subprocesses, downloads, and responses are bounded before execution.
- Explicitly imported workflow modules are trusted current-user Bun code. Atet
  does not load caller-selected modules or evaluate source strings.
- Model-backed generation sends the prompt and supplied media to Vercel AI
  Gateway and the chosen provider. Local diagram rendering and vectorization do
  not require that network authority.
- The complete local runtime treats generated media as candidates until an
  explicit selection is bound to a delivery revision.

## Development

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

`bun run check` verifies the standalone boundary, typechecks and lints the SDK
and local runtime, validates the schema and Agent Skill, runs deterministic and
property tests, builds committed entrypoints, checks the static site, and
installs the packed archive in a clean consumer.

## License

MIT. See [NOTICE.md](NOTICE.md) for tldraw Offline, VTracer, rendering, and model
integration terms.
