# Create and revise your first diagram

Make a two-node flow, inspect its light and dark exports, then change a label by editing its source. This lesson uses the Slopcamera source build and needs no account, paid model, browser, or tldraw installation.

Before starting, complete [source installation](../how-to/use-current-source.md), which defines the `slopcamera` command for your built checkout. Use a new empty working directory so the lesson cannot replace existing artwork.

## Create the source

```sh
mkdir slopcamera-first-diagram
cd slopcamera-first-diagram
slopcamera diagram init first.diagram.json
```

Open `first.diagram.json`. Its two shapes are named `source` and `result`, labeled **Source** and **Result**, with one directed edge. Their horizontal stack supplies the spacing; the file remains the editable source.

## Check and render it

```sh
slopcamera diagram check first.diagram.json --strict
slopcamera diagram render first.diagram.json
```

The strict check should report no findings. Rendering uses the document's `name`, `example-flow`, for its export filenames. It creates these five files beside the JSON:

- `example-flow.tldr`
- `example-flow.light.svg` and `example-flow.dark.svg`
- `example-flow.light.png` and `example-flow.dark.png`

Open both PNG files. You should see the same two boxes and connecting arrow on backgrounds suited to light and dark presentation. The `.tldr` file is editable interchange; you do not need to open it to complete the lesson.

## Change one label

In `first.diagram.json`, find the shape whose `id` is `result`. Change only its `label` from `"Result"` to `"Reviewed"`, then save the file.

```sh
slopcamera diagram check first.diagram.json --strict
slopcamera diagram render first.diagram.json
```

Open the PNG again. The right-hand box now reads **Reviewed**. The render command replaced the five exports while keeping your JSON source. Editing a PNG directly would not have preserved that relationship.

You now have one editable source and five derived outputs. For your own diagram, change the labels, shapes and relationships in that source. Use [visual communication guidance](../../skills/slopcamera/references/visual-communication.md) when the relationships become more complex, or [SDK surfaces](../reference/sdk.md) when a script should check and render it.
