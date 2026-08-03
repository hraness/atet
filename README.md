# Transmute

Transmute is an agent tool for generating and editing images and video. This
package is its narrower headless TypeScript toolkit and Bun CLI for turning
checked source into visual assets. It currently provides deterministic
diagrams, light and dark raster/vector exports, editable tldraw interchange,
bounded raster-to-SVG conversion, authenticated hosted image generation, typed
Bun-script workflows, semantic operation dispatch, and a local MCP server.

The package is designed to compose with editors and video renderers. A diagram, generated image, traced SVG, or `.tldr` canvas remains an ordinary media input rather than a format trapped inside the tool.

Project site: [transmute.rocks](https://transmute.rocks)

## Install

Pin the public repository to the immutable `v0.7.0` tag:

```sh
bun add --global github:hraness/transmute#v0.7.0
transmute doctor
```

For programmatic use:

```sh
bun add github:hraness/transmute#v0.7.0
```

Transmute requires Bun 1.3.14. Diagram rendering works on macOS, Linux, and Windows. Bounded VTracer execution works on macOS and Linux; Windows fails closed with `tool_platform` until its output can cross the same bounded capture path. Semantic operation and workflow resource admission is machine-global on macOS and Linux and process-local on other supported Bun platforms.

## Create a diagram

```sh
transmute diagram init diagrams/system.diagram.json
transmute diagram check diagrams/system.diagram.json --strict
transmute diagram render diagrams/system.diagram.json
```

The checked source uses `.diagram.json` version one. Each render replaces the same five derivatives:

```text
system.tldr
system.light.svg
system.dark.svg
system.light.png
system.dark.png
```

The source remains authoritative. The five outputs are replaceable and each file is published through an atomic rename. The five-file family is not a filesystem transaction.

Use this schema URL in authored files:

```json
{
  "$schema": "https://raw.githubusercontent.com/hraness/transmute/v0.7.0/schema/diagram.schema.json",
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

Array order may place shapes, but it never creates relationships. Edges stay explicit. Impossible stack constraints fail instead of silently shrinking shapes, gaps, or the canvas.

Place `transmute.config.ts`, `.mjs`, `.js`, or `.json` beside a diagram to supply local fonts, sanitized SVG icons, or theme colors. Pass `--config <path>` when configuration belongs elsewhere. MCP and semantic operations deliberately ignore executable workspace configuration.

## Vectorize a local image

```sh
transmute image vectorize input.png --output input.svg --json
transmute image vectorize input.png \
  --output input.duotone.svg \
  --duotone '#171717,#7c3aed'
```

Canonical vectorization requires no account or login and makes no discovery, OAuth, or generation request. It bounds encoded input, decoded dimensions and pixels, subprocess time, paths, emitted bytes, and measured fidelity. The output is rebuilt as inert SVG geometry; foreign tracer SVG is not passed through.

VTracer 0.6.4 downloads from a checksum-pinned official release on first use. `TRANSMUTE_VTRACER_PATH` may point to a compatible local binary, whose hash is recorded in the receipt. `TRANSMUTE_CACHE_DIR` overrides the default tool cache.

Programmatic use returns the SVG, published path, and provenance receipt:

```ts
import { vectorizeImage } from "@hraness/transmute"

const result = await vectorizeImage("input.png", {
  outputPath: "input.svg",
})

console.log(result.receipt.sourceSha256, result.receipt.svgSha256)
```

## Generate a hosted image

Hosted generation is separate from local vectorization and requires a Transmute login:

```sh
transmute auth login
transmute image generate 'one cobalt circle on white' \
  --output circle.webp
transmute auth logout
```

The CLI accepts `recraft/recraft-v4.1-utility` and `openai/gpt-image-1.5`, requests one WebP, validates its bounded base64 and media magic, and atomically publishes the selected output. Requests carry a durable suite-account `Idempotency-Key`; the client never retries an ambiguous generation request.

Discovery is pinned to `https://transmute.rocks/.well-known/transmute-cli.json`. OAuth uses authorization code with S256 PKCE and the fixed `http://127.0.0.1:49671/oauth/callback` loopback. Tokens are stored through `Bun.secrets`, never in project files or command output.

## Use semantic operations

The registry has four canonical codes:

- `transmute.diagram.check`
- `transmute.diagram.render`
- `transmute.image.vectorize`
- `transmute.image.generate`

```sh
transmute code search diagram --limit 4
transmute code execute transmute.diagram.check \
  --input '{"path":"diagrams/system.diagram.json"}'
```

Search returns bounded descriptors. Execute accepts strict JSON for an exact registered code. It does not accept source text, shell commands, dynamic imports, executable configuration, or caller-selected remote URLs. Direct SDK, CLI, and MCP execution acquires the operation's declared host-resource claims before work begins.

The same surface is available from `@hraness/transmute/operations`:

```ts
import {
  executeTransmuteOperation,
  searchTransmuteOperations,
} from "@hraness/transmute/operations"

const matches = searchTransmuteOperations("diagram")
const result = await executeTransmuteOperation("transmute.diagram.check", {
  path: "diagrams/system.diagram.json",
})
```

## Author a Bun workflow

`@hraness/transmute/workflow` composes the same fixed, typed operation registry in an ordinary Bun script. A definition parses its runtime input before work begins. Step ids are unique, execution is bounded to 64 steps by default, and the run result records completed steps in invocation order even when branches settle in a different order.

```ts
import {
  defineTransmuteWorkflow,
  runTransmuteWorkflow,
} from "@hraness/transmute/workflow"

const checkedRender = defineTransmuteWorkflow({
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
      "transmute.diagram.check",
      input,
    )
    const rendered = await workflow.operation(
      "render",
      "transmute.diagram.render",
      input,
    )
    return { checked, artifacts: rendered.artifacts }
  },
})

const result = await runTransmuteWorkflow(checkedRender, {
  path: "diagrams/system.diagram.json",
})
console.log(result.steps, result.output.artifacts)
```

See [`examples/render-workflow.ts`](examples/render-workflow.ts) for an executable script. Run it in a checkout with:

```sh
bun run examples/render-workflow.ts examples/capex-opex.diagram.json
```

Parallel branches are ordinary `Promise.all` calls around `workflow.operation(...)`. Every step code and input is validated against the fixed public operation registry before dispatch, including when a custom executor is injected. The runner drains every dispatched operation before it returns, including a branch that authored code did not await, so destructive work cannot escape a successful run. `AbortSignal` is checked before dispatch and after each built-in operation completes. Custom injected executors also receive the signal for cooperative in-flight cancellation. A failed parallel step snapshots the steps completed at that moment; already-started siblings are not implicitly cancelled and may still settle afterward. Errors thrown by authored workflow code use `WORKFLOW_FAILED` and retain the completed-step receipt.

Every semantic operation declares physical resource claims. The default
profile reserves CPU headroom and bounds local I/O, FFmpeg, video encoding,
Vision, Whisper, browser, network, paid-call, and capture work. On macOS and
Linux, independent Bun processes and Git worktrees enter the same crash-safe
FIFO admission boundary. A terminated process releases its kernel-backed
lease, while an admitted subprocess inherits the lease descriptor so it cannot
outlive the claimed capacity. Direct SDK, CLI, MCP, and workflow calls share
this boundary. Windows uses the same profile within one process.

Use `@hraness/transmute/host-resources` to inspect or inject the boundary:

```ts
import {
  createDefaultHostResourceCoordinator,
  defaultTransmuteHostResourceProfile,
} from "@hraness/transmute/host-resources"
import { runTransmuteWorkflow } from "@hraness/transmute/workflow"

const hostResourceCoordinator = createDefaultHostResourceCoordinator({
  profile: defaultTransmuteHostResourceProfile(),
})

await runTransmuteWorkflow(workflow, input, { hostResourceCoordinator })
```

`runTransmuteWorkflow` also accepts `signal` and
`waitTimeoutMilliseconds` beside the coordinator. The same three controls may
be supplied in `dependencies` when one dependency object is shared with direct
operation calls; explicit workflow-level values take precedence.

Admission cancellation applies while waiting. Once a callback owns capacity,
the coordinator retains that capacity until the callback actually settles,
even if higher-level workflow cancellation has already returned an error.
Custom executors receive the exact `hostResourceLease`; subprocess launchers
must inherit its descriptor and call `assertOwned()` before irreversible work.

Workflow modules are trusted Bun code that you explicitly import and run. The SDK does not load arbitrary paths, evaluate source strings, add operation codes, or expose the private desktop recording and editing runtime.

## Connect MCP

```sh
transmute mcp --root /absolute/path/to/workspace
```

The stdio server exposes `check_diagram`, `render_diagram`, `search_transmute`, and `execute_transmute`. File arguments are root-relative and confined to the selected workspace. Diagram source, shape count, edge count, PNG pixels, returned findings, paths, and outputs are bounded before execution. The server is a trusted local workspace boundary, not an operating-system sandbox against concurrent same-user mutation.

## Work with canvases

Diagram rendering does not require the tldraw SDK or desktop app. The generated `.tldr` file is editable interchange:

```sh
transmute canvas open diagrams/system.tldr
transmute canvas status
transmute canvas url
transmute canvas install
```

The optional installer flow resolves an official tldraw Offline release, verifies its published SHA-256 digest, and prepares the platform installer. A native `.tldraw` file is an app-owned ZIP/SQLite bundle; Transmute opens it but does not rewrite it directly.

## Install the Agent Skill

```sh
transmute skill install --target codex --scope user
transmute skill install --target agents --scope project
```

The skill keeps literal prompts, checked diagram source, rendering, vectorization, semantic operations, and review steps together. `transmute skill path` prints its packaged location.

## Graphics v0.4 compatibility

Version 0.5 folded the former `hraness/graphics` command into Transmute, and versions 0.6 and 0.7 preserve that contract unchanged. The package retains a `graphics` executable for existing automation. It preserves the v0.4 flat command grammar, `graphics.*` operation codes, JSON stdout, `graphics.config.*` discovery, `GRAPHICS_VTRACER_PATH`, `GRAPHICS_CACHE_DIR`, the `com.hraness.graphics.cli` credential entry, `hraness.graphics` cloud contract, and `search_graphics`/`execute_graphics` MCP tools.

New scripts should use the namespaced Transmute grammar. The compatibility executable intentionally continues to report `0.4.0` because it is the frozen v0.4 contract.

## Command reference

| Command | Result |
| --- | --- |
| `transmute diagram init [file]` | Create a starter without overwriting an existing file. |
| `transmute diagram check <file>` | Parse and lint a version-one diagram source. |
| `transmute diagram render <file>` | Replace `.tldr`, light/dark SVG, and light/dark PNG derivatives. |
| `transmute image vectorize <image>` | Trace one local raster to bounded inert SVG without authentication. |
| `transmute image generate <prompt>` | Generate one authenticated, validated WebP. |
| `transmute auth login|logout|status` | Manage or inspect the hosted-feature credential. |
| `transmute code search|execute` | Search or execute the fixed semantic registry. |
| `transmute mcp --root <workspace>` | Serve confined tools over stdio. |
| `transmute canvas open|status|url|install` | Inspect or use optional canvas integration. |
| `transmute skill path|install` | Locate or install the packaged Agent Skill. |
| `transmute doctor` | Report runtime, vectorizer, hosted-feature, MCP, and canvas status. |

## Development

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

`bun run check` typechecks, validates the schema and skill, runs deterministic and property tests, builds the public entrypoints, and installs the resulting archive in a clean consumer.

## License

MIT. See [NOTICE.md](NOTICE.md) for optional tldraw Offline and VTracer integration terms.
