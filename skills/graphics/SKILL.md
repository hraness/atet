---
name: graphics
description: Create or update concise diagrams from a literal user prompt, keep a checked `.diagram.json` source, generate light/dark image exports, and provide editable tldraw interchange. Use for diagrams, flowcharts, maps, visual explanations, architecture overviews, bar charts, `.tldr` files, or paired knowledge-base visuals.
---

# Create clear diagrams

Use the installed `graphics` CLI as the deterministic adapter. Keep the authored
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

1. Read local repository instructions and look for `graphics.config.*`.
2. Search for an existing same-subject `.diagram.json` before creating one.
3. Update that source rather than editing generated images or creating a
   duplicate.
4. In a knowledge base with `kb/`, use
   `kb/diagrams/<slug>.diagram.json` and pair it with
   `kb/notes/<slug>.md`. Embed or link the rendered light/dark image according
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

## Author and render

Use the public schema URL or run `graphics init` for a starter:

```sh
graphics check diagrams/<slug>.diagram.json --strict
graphics render diagrams/<slug>.diagram.json
```

The render command overwrites the consistent same-stem exports. Inspect both
light and dark output when layout or contrast is uncertain. Address all useful
lint findings; change the source, then rerender.

If the repository uses its own font or icon package, read
[customization.md](references/customization.md). Do not add MonoLisa or another
licensed font to the repository. Default rendering uses the system sans-serif
stack.

## Use tldraw deliberately

The generated `.tldr` file is editable interchange and does not require the
tldraw SDK or desktop app to create. Open it in tldraw Offline when a person
wants direct canvas editing:

```sh
graphics open diagrams/<slug>.tldr
```

If the optional app is absent, `graphics desktop install` resolves the current
official release, verifies its published SHA-256 digest, and launches the
platform installer. The app imports `.tldr` as an unsaved document; save it
there to create its newer native `.tldraw` bundle. Never rewrite a native
`.tldraw` ZIP/SQLite bundle directly.

## Verify

1. Run `graphics check <source> --strict`.
2. Run `graphics render <source>`.
3. Confirm all five artifacts exist beside the source or in the requested
   output directory.
4. Inspect light and dark output at actual size.
5. Confirm peer shapes do not imply false differences.
6. Confirm connectors are long, bound to the intended shapes in `.tldr`, and
   do not cross labels.
7. If a companion note is required, confirm its path and visual reference.
