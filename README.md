# Graphics

Graphics is an open-source, Bun-first CLI and Agent Skill for small, clear
diagrams. Its executable is `graphics`. A checked `.diagram.json` file is the
source of truth. One render
produces consistent light and dark SVG/PNG images plus editable tldraw
interchange—without a browser, tldraw Desktop, or the tldraw SDK at runtime.

The project site is [hraness.graphics](https://hraness.graphics).

The defaults favor rounded peer shapes, short labels, long connectors, bare
icons, a system sans-serif font, and visual differences that correspond to real
semantic differences.

<!-- article:a-visual-grammar-for-ai-generated-diagrams:start -->
## [A visual grammar for AI-generated diagrams](<https://prmte.com/articles/a-visual-grammar-for-ai-generated-diagrams>)

> An agent can place shapes quickly, but it can also invent hierarchy, grouping, and emphasis. A small set of rules keeps the picture faithful and readable.

A diagram made by an agent often looks finished before it is clear. The boxes align, the icons match, and the arrows connect. Yet the model may have added a hierarchy that the prompt never described, made two peers different sizes, or wrapped one concept in several borders because the empty space seemed unfinished.

Those choices are not neutral decoration. A reader assumes that size, position, color, shape, and enclosure mean something. A useful visual grammar gives the agent restrained defaults for decisions the prompt leaves open. The open-source [Graphics CLI and Agent Skill](<https://github.com/hraness/graphics>) turns those defaults into a checked workflow: an authored `.diagram.json` file produces light and dark SVG and PNG images plus editable tldraw interchange. The rules remain useful without the tool; the tool makes them repeatable.

![Two columns compare accidental and deliberate diagram choices: unequal and equal peer boxes, a double-bordered and bare icon, and cramped and long arrows.](<https://prmte.com/article-diagrams/a-visual-grammar-for-ai-generated-diagrams.light.webp>)

*Equal peers, one border, and enough connector space keep a small diagram from implying more than it means.*

### Treat the prompt as the content boundary

The prompt should define the diagram’s content. An agent can arrange supplied concepts and choose neutral mechanics, but it should not add a sequence, category, legend, callout, or conclusion unless the request calls for one. This constraint matters because a plausible invented relationship is difficult to distinguish from an authored claim once it becomes a clean arrow.

Give semantic peers the same container size, corner treatment, icon scale, stroke, fill, and alignment. A larger box looks more important. A different color looks like a category. A thicker border looks selected. When the ideas are equal, their visual treatment should be equal. When one idea is more important, use one deliberate cue instead of changing every available property.

### Give relationships enough room to read

Choose one primary reading direction, then place each next step where the eye already expects to continue. Long arrows make the relationship visible as a relationship; cramped arrows look like gap markers or stray arrowheads. In PRMTE’s 1200 by 720 article frame, 120 canvas units of clear space between connected cards is a useful target. Gaps below 96 units usually look crowded. These are house measurements for this format, not universal perceptual constants.

[Larkin and Simon’s work on diagrammatic representations](<https://doi.org/10.1111/j.1551-6708.1987.tb00863.x>) explains how spatial arrangement can reduce search and keep the next inference nearby. [Purchase’s graph-layout experiment](<https://doi.org/10.1007/3-540-63938-1_67>) found edge crossings to have the strongest effect among the tested aesthetics, with bends and symmetry carrying smaller effects. The practical order follows: remove crossings first, reduce bends second, and keep the remaining path easy to trace.

### Use one border for one group

An outlined icon badge inside an outlined card creates two enclosed regions. If the diagram contains only one concept, the second boundary suggests a grouping that does not exist. Use a bare icon inside the card by default. When the glyph needs contrast, a fill-only plate preserves one outline for one semantic region.

[Stephen Palmer’s research on common regions](<https://doi.org/10.1016/0010-0285(92)90014-S>) found enclosure to be a strong perceptual grouping cue. That makes whitespace and alignment the first tools for organizing a small diagram. Add another box only when the content contains another group.

### Let icons help the label, not replace it

A familiar icon helps a new reader scan, but the short label carries the exact meaning. The paperclip can suggest a source, the book can suggest memory, and the chain can suggest links. None of those glyphs can state the article’s claim by itself. [Research on icon identification by Isherwood, McDougall, and Curry](<https://doi.org/10.1518/001872007X200102>) found familiarity and semantic distance to be strong factors in recognition.

Use one semantically close icon at a consistent scale and keep the label to a word or short phrase. A shared set such as Hugeicons gives the drawing a coherent stroke language. It does not justify adding icon badges, decorative color families, or different icon sizes to fill the canvas.

### Separate evidence from house style

[Daniel Moody’s Physics of Notations](<https://doi.org/10.1109/TSE.2009.67>) argues for semiotic clarity, perceptual discriminability, graphic economy, and visual expressiveness. In practical terms, different meanings need distinguishable representations, while repeated meanings should reuse a small visual vocabulary. A diagram spends clarity whenever it introduces a visual exception.

Rounded rectangles are PRMTE’s default for bounded concepts because they fit the publication’s visual language and are easy to recognize as peers. [Bar and Neta found that people preferred curved contours](<https://doi.org/10.1111/j.1467-9280.2006.01759.x>), but aesthetic preference is not proof of better comprehension. A conventional flowchart symbol or an explicitly requested hard corner should override the house style.

### Turn the grammar into a repeatable workflow

`graphics` keeps authored content in a checked `.diagram.json` source. `graphics check --strict` reports objective layout findings; `graphics render` atomically refreshes five same-stem outputs: editable `.tldr` interchange plus light and dark SVG and PNG images. Headless rendering needs neither tldraw Offline nor the tldraw SDK at runtime. The desktop app remains an optional editor for direct canvas work.

The project does not bundle MonoLisa or a large icon library. It defaults to the system sans-serif stack and a small built-in icon set. A local export config can point at font files you have licensed and adapt project-owned SVG geometry from Hugeicons or another set. Font bytes stay out of SVG unless embedding is explicit, so a custom visual language does not have to make the package large.

`graphics check` can test rules with objective local evidence: equal peer geometry, rounded default containers, sufficient connector runway, and no outlined badge inside an outlined card. The bundled skill carries the judgment a geometry check cannot: follow the prompt without enrichment, use icons as cues rather than claims, and review both themes at reading size. Meaning still needs human review. When a prompt intentionally breaks a default, record a rule-specific reason instead of weakening the check for every future diagram. This is the same scoping discipline described in [PRMTE’s guide to agent documentation hygiene](<https://prmte.com/articles/the-ai-codebase-agent-docs-hygiene>).

### Review the published image at reading size

A canvas can look orderly at full zoom and fail inside an article column. Check the exported image at the size and theme a reader will use. The review can stay short:

- Does the picture say only what the prompt supplied?
- Do equal ideas look equal?
- Is the first relationship easy to find and follow?
- Does every border create a real group?
- Do the labels and icons remain legible in light and dark?

When these decisions should survive the current task, keep the visual grammar in the Agent Skill, preserve the `.diagram.json` source beside its replaceable exports, and pair a knowledge-base diagram with a note. [A durable knowledge base for coding agents](<https://prmte.com/articles/a-durable-knowledge-base-is-a-write-path>) gives those rules a place to be reviewed, linked, and improved instead of rediscovered in the next prompt.
<!-- article:a-visual-grammar-for-ai-generated-diagrams:end -->

## Tell your coding agent to install it

Copy this prompt into Codex, Claude Code, or another coding agent:

```text
Install the Graphics CLI and bundled Agent Skill from
https://github.com/hraness/graphics at the immutable v0.2.0 tag. Follow the
repository README, install the skill in this agent runner's configured skills
directory, run `graphics doctor`, and verify the installation by rendering the
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
bun add --global github:hraness/graphics#v0.2.0
graphics skill install --target codex --scope user
graphics doctor
```

### Migrate from v0.1

v0.2 replaces the `@cclrte/diagram` package, `diagram` executable, and
`diagram` skill. Remove the old global package and the user-level Codex skill
before installing v0.2:

```sh
bun remove --global @cclrte/diagram
rm -rf -- "$HOME/.codex/skills/diagram"
bun add --global github:hraness/graphics#v0.2.0
graphics skill install --target codex --scope user
```

If v0.1 was installed for another runner or at project scope, run only the
matching cleanup command before installing the new skill:

```sh
rm -rf -- "$HOME/.claude/skills/diagram"
rm -rf -- "$HOME/.agents/skills/diagram"
rm -rf -- ".codex/skills/diagram"
rm -rf -- ".claude/skills/diagram"
rm -rf -- ".agents/skills/diagram"
```

Rename any local `diagram.config.*` to the matching `graphics.config.*`.
Graphics rejects a legacy-only config instead of silently rendering with
defaults.

Other supported discovery targets are `claude` and the runner-neutral
`.agents/skills` convention:

```sh
graphics skill install --target claude --scope user
graphics skill install --target agents --scope project
```

An existing skill is never replaced unless `--force` is explicit. To let a
runner handle installation itself, `graphics skill path` prints the directory
shipped inside the installed package.

Contributors can install from a checkout:

```sh
git clone https://github.com/hraness/graphics.git
cd graphics
bun install --frozen-lockfile
bun run check
bun link
```

## Render a diagram

Create a starter or author the JSON directly:

```sh
graphics init diagrams/example-flow.diagram.json
graphics check diagrams/example-flow.diagram.json --strict
graphics render diagrams/example-flow.diagram.json
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
  "$schema": "https://raw.githubusercontent.com/hraness/graphics/main/schema/diagram.schema.json",
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
graphics render examples/capex-opex.diagram.json --out-dir /tmp/graphics-example
```

## tldraw without a desktop dependency

`graphics` does not redistribute or import the tldraw SDK at runtime. It writes
the official JSON `.tldr` interchange shape—document records, native shapes,
image assets, arrows, and real arrow bindings. The development test suite uses
the upstream parser only to prove compatibility.

The new tldraw Offline application uses a different native `.tldraw` bundle:
the canvas, SQLite-backed state, assets, and optional scripts are packaged
together. That app-owned format is not a stable headless interchange contract,
so `graphics` does not rewrite it. Instead:

1. Render headlessly to `.tldr`.
2. Open the file in tldraw Offline.
3. Save the imported document as native `.tldraw` when needed.

```sh
graphics open diagrams/example-flow.tldr
```

tldraw Offline is optional and not open source. If it is absent,
`graphics desktop url` resolves the current platform asset from the
[official latest release](https://github.com/tldraw/tldraw-offline/releases/latest).
`graphics desktop install` asks before downloading, checks the SHA-256 digest
published by GitHub, and launches the installer. It uses the official
[download page](https://offline.tldraw.com) and release API rather than an
undocumented URL scheme:

```sh
graphics desktop url
graphics desktop install
```

On macOS the verified DMG is opened; on Windows the verified installer is
launched; on Linux the verified AppImage is installed at
`~/.local/bin/tldraw-offline`. Use `--download-only` to avoid launching it and
`--yes` for an intentional non-interactive install.

## Custom fonts without bundling them

No MonoLisa files—or any other commercial font files—are included. The default
is the local system sans-serif stack.

Place a `graphics.config.ts` beside a source to use your own local font:

```ts
import type { DiagramConfig } from "@cclrte/graphics"

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
graphics render diagram.json --config ./brand/graphics.config.ts
```

## Custom icon sets without bundling them

The package carries only a tiny built-in set. A local config may add or replace
icons with ordinary SVG geometry:

```ts
import type { DiagramConfig } from "@cclrte/graphics"

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
[customization reference](skills/graphics/references/customization.md).

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
| `graphics init [file]` | Create a starter source without overwriting an existing file. |
| `graphics check <file>` | Parse the source and report visual-communication lint findings. |
| `graphics render <file>` | Write light/dark SVG and PNG plus `.tldr` interchange. |
| `graphics open <file>` | Open `.tldr` or `.tldraw` in an installed tldraw Offline app. |
| `graphics doctor` | Report the headless runtime and optional desktop integration. |
| `graphics desktop status` | Report app discovery and its optional local agent server without exposing its token. |
| `graphics desktop url` | Print the current official platform asset, size, URL, and digest. |
| `graphics desktop install` | Download, verify, and prepare the official desktop app. |
| `graphics skill path` | Print the packaged Agent Skill directory. |
| `graphics skill install` | Copy the skill into a supported user or project discovery path. |

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

See [the full visual-communication reference](skills/graphics/references/visual-communication.md)
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
