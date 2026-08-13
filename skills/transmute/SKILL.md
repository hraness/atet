---
name: transmute
description: Create or update concise diagrams from a literal user prompt, keep checked source, generate light/dark exports, provide editable tldraw interchange, convert caller-owned raster artwork to bounded SVG, generate images directly through Vercel AI Gateway, or guide reviewed reference-image workflows for Three.js scenes and metallic logo treatments. Use for diagrams, flowcharts, maps, visual explanations, `.tldr` files, image-to-SVG conversion, image generation, low-poly or transparent 3D motion, metallic brand-symbol renders, semantic Transmute operations, or typed Bun workflows.
---

# Create clear diagrams

Use the installed `transmute` CLI as the deterministic adapter. Keep the authored
`.diagram.json` source; treat `.light.svg`, `.dark.svg`, `.light.png`,
`.dark.png`, and `.tldr` as replaceable exports.

## Follow the prompt literally

Treat the user's prompt as the complete content specification.

- Preserve supplied labels, values, relationships, relative sizes, and
  omissions.
- Add only neutral mechanics needed to draw those facts.
- Do not invent a title, subtitle, legend, annotation, example, implication,
  category, metric, tick, connector, or decorative claim.
- Do not expand a short label into a sentence. Prefer the user's own one-to-three
  word label.
- When updating, remove rejected content without replacing it with a new
  elaboration.

## Find the source

1. Read local repository instructions and look for `transmute.config.*`.
2. Search for an existing same-subject `.diagram.json` before creating one.
3. Update that source rather than editing generated images or creating a
   duplicate.
4. In a knowledge base with `info/`, use
   `info/diagrams/<slug>.diagram.json` and pair it with
   `info/notes/<slug>.md`. In a repository that still uses `kb/`, use the same
   relative paths there. Embed or link the rendered light/dark image according
   to the host's convention, and link knowledge through the note rather than
   through a binary canvas.
5. Outside a knowledge base, default to `diagrams/<slug>.diagram.json`.

## Compose the visual

Read [visual-communication.md](references/visual-communication.md) before
creating or materially redesigning a diagram.

Apply these defaults deeply:

- Use rounded rectangles for ordinary concepts. Equal roles get equal sizes,
  radii, stroke weights, icon sizes, and label treatment.
- Leave at least 96px—and preferably 120–200px—between connected shapes so
  arrows read as relationships rather than seams.
- Put icons directly inside their semantic shape. Do not place a bordered icon
  tile inside another bordered card.
- Use three to seven primary elements when the prompt permits abstraction.
- Establish a clear reading order and align peers to a shared grid.
- Use whitespace before borders, colors, or prose to separate groups.
- Use color for at most one semantic distinction. Never make arbitrary size or
  styling changes that imply a difference the prompt did not supply.
- Keep icons supportive: a label must still carry the meaning.
- Prefer one visible boundary per object and one visible stroke per axis or
  connector.

Do not “improve” literal data to satisfy these preferences. The prompt wins.

## Let deterministic layout own ordinary coordinates

Use a coordinate-free `stack` layout for one horizontal or vertical sequence:

```json
{
  "layout": {
    "type": "stack",
    "direction": "horizontal",
    "gap": 160,
    "align": "center"
  }
}
```

- Array order controls placement only. Draw an edge only when the prompt
  supplied that relationship.
- Keep stack shapes to rectangles or ellipses and omit `x` and `y`.
- Use the default 160px gap unless the prompt or publication frame requires a
  different runway.
- Switch to positioned mode for branching, non-adjacent edges, charts, free
  text, lines, or deliberately unequal placement. Do not force those meanings
  into a one-dimensional stack.
- If a stack does not fit, increase the canvas or reduce authored dimensions
  explicitly. Do not silently shrink shapes or gaps.

## Author and render

Use the public schema URL or run `transmute diagram init` for a starter:

```sh
transmute diagram check diagrams/<slug>.diagram.json --strict
transmute diagram render diagrams/<slug>.diagram.json
```

The render command overwrites the consistent same-stem exports. Inspect both
light and dark output when layout or contrast is uncertain. Address all useful
lint findings; change the source, then rerender.

If the repository uses its own font or icon package, read
[customization.md](references/customization.md). Do not add MonoLisa or another
licensed font to the repository. Default rendering uses the system sans-serif
stack.

## Provide a Vercel AI Gateway credential

Prefer a process-local environment variable. Never place a key on argv, write
it into a project file, print it, or ask Transmute to persist it:

```sh
export AI_GATEWAY_API_KEY='<value>'
```

When the workspace is linked and the user is authenticated with Vercel, prefer
`vercel env run -- <command>`. Transmute reads `AI_GATEWAY_API_KEY` first and
`VERCEL_OIDC_TOKEN` second. It has no product account, OAuth, database, or local
credential store.

## Generate one Gateway image literally

When the user explicitly asks for raster generation, preserve their
prompt rather than enriching it:

```sh
vercel env run -- transmute image generate \
  '<literal prompt>' --output path/to/image.webp
```

The default model is `recraft/recraft-v4.1-utility`. Use another bounded
`provider/model` Gateway id only when the user requests it or its behavior is
material. Vectorization remains local and authentication-free.

- Keep `.png`, `.jpg`, `.jpeg`, or `.webp` output inside the requested workspace.
- Never retry a failed generation call. The CLI itself sets `maxRetries: 0`.
- Let the CLI bound the response, validate media magic, and publish atomically.

## Use reference-led 3D and material workflows deliberately

Read [reference-led-3d.md](references/reference-led-3d.md) when the user asks to
turn a generated or supplied image into a Three.js scene, a low-poly object, a
transparent 3D loop, or a metallic logo product render.

These are complete local Code Mode host capabilities in the same open-source
project. The portable SDK retains its fixed four-operation projection; the
local host adds HTML overlays, Three.js, durable media execution, and project
rendering. The Desktop shell supplies native capture, permissions, and UI
rather than another workflow model.
In local Code Mode:

- Stage image-to-Three work as reference generation, source authoring, review,
  preview, then final render. Never send model-produced JavaScript directly to
  a semantic operation.
- Bind the exact reference artifact to the reviewed scene with
  `createThreeReferenceScaffoldInput`, even when it is not visibly composited.
- Use `createMetallicLogoImageRequest` for the reference-led square product
  treatment. Keep model selection explicit and inspect identity fidelity before
  accepting the result.
- Render full-length previews at 1x first. Raise resolution or device scale only
  after selecting the source and treatment.

## Vectorize a raster without changing its meaning

When the user asks to convert caller-owned raster artwork to SVG, keep the
raster as the source and treat the SVG as a replaceable derivative:

```sh
transmute image vectorize path/to/input.png --output path/to/input.svg --json
```

- Do not provide a credential for vectorization. The conversion is local and
  does not contact any network endpoint.
- Do not redraw, relabel, crop, recolor, or simplify the subject beyond the
  trace mechanics the command measures.
- Use `--duotone '#primary,#secondary'` only when the user explicitly asks for
  that two-color adaptation.
- Preserve the emitted receipt in task output or an adjacent provenance record
  when auditability matters.
- Do not bypass input, decoded-pixel, duration, path, byte, or fidelity gates.
- Inspect the SVG at its intended size. A successful trace is not evidence
  that an unfamiliar symbol communicates the intended concept.

VTracer downloads from its checksum-pinned official release on first use. Use
`TRANSMUTE_VTRACER_PATH` only for a compatible local 0.6.4 binary; Transmute still
records its hash. Never add an upscaling model, embedded raster fallback, or
commercial font to make a trace pass.

Bounded vectorization is currently supported on macOS and Linux. On Windows,
report the deliberate `tool_platform` failure; do not bypass it with an
unbounded temporary output file.

## Use a connected tool server narrowly

When Transmute MCP is connected, preserve the dedicated `check_diagram` and
`render_diagram` tools for simple compatibility calls. Use `search_transmute`
to discover the fixed semantic registry and `execute_transmute` with one exact
returned code and typed JSON. Continue to edit checked diagram source directly;
no tool creates or rewrites source.

- Pass only root-relative `.diagram.json` paths.
- Treat `check_diagram` as read-only.
- Treat `render_diagram` as approval to replace the five documented generated
  artifacts, never the source.
- Use the CLI rather than MCP for a source above 64 shapes or 128 edges. MCP
  returns at most 40 findings and reports when that list is truncated.
- MCP mode deliberately uses built-in themes and icons and never executes
  workspace config. Use the CLI outside MCP when a trusted local config is
  required.
- `transmute.image.vectorize` accepts root-relative input/output paths, requires
  no login, and keeps raster bytes local.
- `transmute.image.generate` requires a root-relative `.webp` output path,
  atomically writes the bounded image, and returns only redacted file/request
  metadata. Use only the two registry model IDs and do not retry it.
- Never pass source code, shell text, dynamic-import text, remote URLs, or
  unregistered operation names to semantic execution.

Without MCP, the equivalent machine-readable CLI surface is:

```sh
transmute code search '<terms>' --limit 4
transmute code execute <exact-operation-code> --input '<strict JSON object>'
```

## Use tldraw deliberately

The generated `.tldr` file is editable interchange and does not require the
tldraw SDK or desktop app to create. Open it in tldraw Offline when a person
wants direct canvas editing:

```sh
transmute canvas open diagrams/<slug>.tldr
```

If the optional app is absent, `transmute canvas install` resolves the current
official release, verifies its published SHA-256 digest, and launches the
platform installer. The app imports `.tldr` as an unsaved document; save it
there to create its newer native `.tldraw` bundle. Never rewrite a native
`.tldraw` ZIP/SQLite bundle directly.

## Verify

1. Run `transmute diagram check <source> --strict`.
2. Run `transmute diagram render <source>`.
3. Confirm all five artifacts exist beside the source or in the requested
   output directory.
4. Inspect light and dark output at actual size.
5. Confirm peer shapes do not imply false differences.
6. Confirm connectors are long, bound to the intended shapes in `.tldr`, and
   do not cross labels.
7. If a companion note is required, confirm its path and visual reference.
