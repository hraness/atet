# diagram

`diagram` is an open-source, Bun-first CLI and Agent Skill for small, clear
diagrams. A checked `.diagram.json` file is the source of truth. One render
produces consistent light and dark SVG/PNG images plus editable tldraw
interchange—without a browser, tldraw Desktop, or the tldraw SDK at runtime.

The defaults favor rounded peer shapes, short labels, long connectors, bare
icons, a system sans-serif font, and visual differences that correspond to real
semantic differences.

## Tell your coding agent to install it

Copy this prompt into Codex, Claude Code, or another coding agent:

```text
Install the diagram CLI and bundled Agent Skill from
https://github.com/hraness/diagram at the immutable v0.1.0 tag. Follow the
repository README, install the skill in this agent runner's configured skills
directory, run `diagram doctor`, and verify the installation by rendering the
included example. Do not install tldraw Offline unless I ask to edit the canvas
in the desktop app.
```

The repository URL is enough for an agent to inspect the current instructions;
the tag keeps the installed CLI and skill on the same contract.

## Install

[Bun 1.3.14](https://bun.sh/docs/installation) is the supported runtime.

Install the immutable release and then place the bundled skill where your agent
runner discovers skills:

```sh
bun add --global github:hraness/diagram#v0.1.0
diagram skill install --target codex --scope user
diagram doctor
```

Other supported discovery targets are `claude` and the runner-neutral
`.agents/skills` convention:

```sh
diagram skill install --target claude --scope user
diagram skill install --target agents --scope project
```

An existing skill is never replaced unless `--force` is explicit. To let a
runner handle installation itself, `diagram skill path` prints the directory
shipped inside the installed package.

Contributors can install from a checkout:

```sh
git clone https://github.com/hraness/diagram.git
cd diagram
bun install --frozen-lockfile
bun run check
bun link
```

## Render a diagram

Create a starter or author the JSON directly:

```sh
diagram init diagrams/example-flow.diagram.json
diagram check diagrams/example-flow.diagram.json --strict
diagram render diagrams/example-flow.diagram.json
```

Every successful render atomically overwrites the same five derivatives:

```text
example-flow.tldr
example-flow.light.svg
example-flow.dark.svg
example-flow.light.png
example-flow.dark.png
```

The source stays readable and reviewable:

```json
{
  "$schema": "https://raw.githubusercontent.com/hraness/diagram/main/schema/diagram.schema.json",
  "version": 1,
  "name": "example-flow",
  "canvas": { "width": 960, "height": 540, "padding": 64 },
  "shapes": [
    {
      "id": "source",
      "type": "rect",
      "x": 100,
      "y": 170,
      "width": 240,
      "height": 160,
      "label": "Source",
      "icon": "document",
      "tone": "blue"
    },
    {
      "id": "result",
      "type": "rect",
      "x": 620,
      "y": 170,
      "width": 240,
      "height": 160,
      "label": "Result",
      "icon": "check",
      "tone": "green"
    }
  ],
  "edges": [{ "id": "source-result", "from": "source", "to": "result" }]
}
```

`rect`, `ellipse`, `text`, and `line` are the primitive shapes. Edges bind two
rectangles or ellipses and default to automatic edge anchors. The public
[JSON Schema](schema/diagram.schema.json) provides the complete checked
surface.

The included [CAPEX/OPEX example](examples/capex-opex.diagram.json) shows a
literal stacked comparison with one-stroke axes, no visible title, and only `$`
on the vertical axis:

```sh
diagram render examples/capex-opex.diagram.json --out-dir /tmp/diagram-example
```

## tldraw without a desktop dependency

`diagram` does not redistribute or import the tldraw SDK at runtime. It writes
the official JSON `.tldr` interchange shape—document records, native shapes,
image assets, arrows, and real arrow bindings. The development test suite uses
the upstream parser only to prove compatibility.

The new tldraw Offline application uses a different native `.tldraw` bundle:
the canvas, SQLite-backed state, assets, and optional scripts are packaged
together. That app-owned format is not a stable headless interchange contract,
so `diagram` does not rewrite it. Instead:

1. Render headlessly to `.tldr`.
2. Open the file in tldraw Offline.
3. Save the imported document as native `.tldraw` when needed.

```sh
diagram open diagrams/example-flow.tldr
```

tldraw Offline is optional and not open source. If it is absent,
`diagram desktop url` resolves the current platform asset from the
[official latest release](https://github.com/tldraw/tldraw-offline/releases/latest).
`diagram desktop install` asks before downloading, checks the SHA-256 digest
published by GitHub, and launches the installer. It uses the official
[download page](https://offline.tldraw.com) and release API rather than an
undocumented URL scheme:

```sh
diagram desktop url
diagram desktop install
```

On macOS the verified DMG is opened; on Windows the verified installer is
launched; on Linux the verified AppImage is installed at
`~/.local/bin/tldraw-offline`. Use `--download-only` to avoid launching it and
`--yes` for an intentional non-interactive install.

## Custom fonts without bundling them

No MonoLisa files—or any other commercial font files—are included. The default
is the local system sans-serif stack.

Place a `diagram.config.ts` beside a source to use your own local font:

```ts
import type { DiagramConfig } from "@cclrte/diagram"

export default {
  font: {
    family: "Your Font",
    files: [
      { path: "./fonts/YourFont-Regular.ttf", weight: 400, embed: false },
      { path: "./fonts/YourFont-Semibold.ttf", weight: 600, embed: false },
    ],
  },
} satisfies DiagramConfig
```

PNG rendering reads those files locally. `embed: false` keeps font bytes out of
the output; serve the font through the consuming website if SVG must use it.
`embed: true` makes an SVG self-contained but increases every file and is
appropriate only when the font license permits redistribution. Typography is
an export concern: editable `.tldr` remains on tldraw's normal sans font.

Pass an explicit config when it does not live beside the source:

```sh
diagram render diagram.json --config ./brand/diagram.config.ts
```

## Custom icon sets without bundling them

The package carries only a tiny built-in set. A local config may add or replace
icons with ordinary SVG geometry:

```ts
import type { DiagramConfig } from "@cclrte/diagram"

export default {
  icons: {
    inbox: {
      viewBox: "0 0 24 24",
      body:
        '<path d="M4 5h16v14H4zM4 14h4l2 2h4l2-2h4" ' +
        'fill="none" stroke="currentColor" stroke-width="1.5" ' +
        'stroke-linecap="round" stroke-linejoin="round"/>',
    },
  },
} satisfies DiagramConfig
```

For Hugeicons, Lucide, or another design-system package, keep that dependency
in the consuming repository and write a small adapter from its icon data to
`{ viewBox, body }`. `currentColor` lets one icon follow both themes. The
renderer places icons bare inside their semantic shape—there is no redundant
bordered icon tile—and the tldraw adapter stores each icon as an editable image
asset beside the card and label.

Executable SVG content, event handlers, `foreignObject`, iframes, and
`javascript:` URLs are rejected. The complete pattern is in the bundled
[customization reference](skills/diagram/references/customization.md).

## Publish images accessibly

Keep the explanatory alt text in the page or note, where it can describe the
meaning in context. Use explicit dimensions to prevent layout shift and choose
the dark source from the active color scheme:

```html
<picture>
  <source
    media="(prefers-color-scheme: dark)"
    srcset="/diagrams/example-flow.dark.png"
  />
  <img
    src="/diagrams/example-flow.light.png"
    alt="A source flows to a result."
    width="960"
    height="540"
    loading="lazy"
    decoding="async"
  />
</picture>
```

The generated SVG includes a non-visible accessible title based on the source
name, but it does not invent a visible title or explanatory copy. The consuming
page remains responsible for a literal, useful alt description and nearby
caption when one is needed.

## CLI reference

| Command | Purpose |
| --- | --- |
| `diagram init [file]` | Create a starter source without overwriting an existing file. |
| `diagram check <file>` | Parse the source and report visual-communication lint findings. |
| `diagram render <file>` | Write light/dark SVG and PNG plus `.tldr` interchange. |
| `diagram open <file>` | Open `.tldr` or `.tldraw` in an installed tldraw Offline app. |
| `diagram doctor` | Report the headless runtime and optional desktop integration. |
| `diagram desktop status` | Report app discovery and its optional local agent server without exposing its token. |
| `diagram desktop url` | Print the current official platform asset, size, URL, and digest. |
| `diagram desktop install` | Download, verify, and prepare the official desktop app. |
| `diagram skill path` | Print the packaged Agent Skill directory. |
| `diagram skill install` | Copy the skill into a supported user or project discovery path. |

## Design contract

The shipped skill encodes the visual rules rather than asking every agent to
rediscover them:

- Follow the prompt without enrichment.
- Default to rounded rectangles for concepts.
- Keep connected shapes at least 96px apart, preferably 120–200px.
- Give peers the same size and treatment unless a supplied fact differs.
- Use three to seven high-level elements when the prompt permits.
- Keep labels short and icons supportive.
- Use one visible boundary per object and one stroke per axis.
- Use whitespace and alignment before nested containers.
- Use color for one semantic distinction at a time.

See [the full visual-communication reference](skills/diagram/references/visual-communication.md)
for the perceptual rationale and review checklist.

## Develop

```sh
bun install --frozen-lockfile
bun run check
bun run example
```

The published project code is MIT and its runtime renderer, `@resvg/resvg-js`,
is MPL-2.0. The upstream tldraw SDK appears only as a development compatibility
dependency and remains under its own license. See [NOTICE.md](NOTICE.md).
