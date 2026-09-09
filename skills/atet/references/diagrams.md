# Create and revise diagrams

Use the installed `atet` CLI as the deterministic adapter. Keep the authored
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

1. Read local repository instructions and look for `atet.config.*`.
2. Search for an existing same-subject `.diagram.json` before creating one.
3. Update that source rather than editing generated images or creating a
   duplicate.
4. Follow local vault instructions and existing diagram/note directories. Use
   `info/diagrams/<slug>.diagram.json` with `info/notes/<slug>.md` only when
   that is the established convention. A vault named `kb/` does not imply a
   nested `info/` directory. Do not invent a vault or migration layout.
5. Link the diagram through its companion note when local instructions require
   one, following the host's image-embedding convention.
6. Outside a vault, default to `diagrams/<slug>.diagram.json`.

## Compose the visual

Read [visual-communication.md](visual-communication.md) before
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
- Use one color distinction by default. A supplied system with several stable
  roles may use a small repeated semantic palette, but every role must remain
  legible through its label, icon, or position without hue.
- Keep icons supportive: a label must still carry the meaning.
- Prefer one visible boundary per object and one visible stroke per axis or
  connector.
- Box content is vertically centered as one measured icon-and-text group. Do
  not compensate with source-coordinate nudges.
- Set `labelFontSize`, `labelFontFamily`, or `labelWeight` when one box label
  needs a different treatment. Use `"fontFamily": "mono"` for a supplied
  identifier, type, or relation, not as decoration.
- Use `labelRows` for two to four supplied text roles inside one box. Each row
  can set `text`, `fontSize`, `fontFamily`, and `weight`; `labelRowGap` controls
  the measured gap. Do not combine `labelRows` with the legacy `label` fields.
- Edge labels support the same font family, size, and weight controls plus
  `labelPosition` and `labelOffset`. Keep relation labels short.
- In positioned diagrams, distribute fan-in or fan-out connectors with
  `startPosition` and `endPosition` from `0` to `1`. On left and right sides,
  zero is the top and one is the bottom. On top and bottom sides, zero is the
  left and one is the right.

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

Use the public schema URL or run `atet diagram init` for a starter:

```sh
atet diagram check diagrams/<slug>.diagram.json --strict
atet diagram render diagrams/<slug>.diagram.json
```

The render command replaces five exports whose common stem is the document’s `name`, not necessarily the input filename. `diagram init first.diagram.json` starts with `name: "example-flow"`, so its exports are `example-flow.*`. Inspect both
light and dark output when layout or contrast is uncertain. Address all useful
lint findings; change the source, then rerender.

For a directed connector, positive `bend` moves its quadratic control point to
the viewer's right side of the source-to-target chord; negative moves it left.
For a left-to-right connector, positive bends down and negative bends up. The
visible midpoint moves by half the authored bend value. Inspect branching
connectors instead of guessing their sign.

If the repository uses its own font or icon package, read
[customization.md](customization.md). Do not add MonoLisa or another
proprietary or restricted font to the repository. Default SVG rendering embeds
the bundled Nebula Sans Book and Bold faces. PNG rendering loads those exact
assets for ordinary proportional text while retaining host discovery for
explicit mono and custom font roles.


## Use tldraw deliberately

The generated `.tldr` file is editable interchange and does not require the
tldraw SDK or desktop app to create. Open it in tldraw Offline when a person
wants direct canvas editing:

```sh
atet canvas open diagrams/<slug>.tldr
```

If the optional app is absent, `atet canvas install` resolves the current
official release, verifies its published SHA-256 digest, and launches the
platform installer. The app imports `.tldr` as an unsaved document; save it
there to create its newer native `.tldraw` bundle. Never rewrite a native
`.tldraw` ZIP/SQLite bundle directly.

## Verify

1. Run `atet diagram check <source> --strict`.
2. Run `atet diagram render <source>`.
3. Confirm all five artifacts exist beside the source or in the requested
   output directory.
4. Inspect light and dark output at actual size.
5. Confirm peer shapes do not imply false differences.
6. Confirm connectors are long, bound to the intended shapes in `.tldr`, and
   do not cross labels.
7. If a companion note is required, confirm its path and visual reference.
