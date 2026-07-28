# Fonts and icon adapters

`transmute` deliberately ships no commercial font and no large icon set.

## Custom font

Create `transmute.config.ts` beside the source:

```ts
import type { DiagramConfig } from "@hraness/transmute"

export default {
  font: {
    family: "Your Font",
    files: [
      {
        path: "./fonts/YourFont-Regular.ttf",
        weight: 400,
        embed: false,
      },
      {
        path: "./fonts/YourFont-Semibold.ttf",
        weight: 600,
        embed: false,
      },
    ],
  },
} satisfies DiagramConfig
```

The PNG renderer reads those local files. With `embed: false`, SVG output names
the family but does not copy font bytes; serve the font through the website or
fall back through CSS. Set `embed: true` only when the font license permits
redistribution and self-contained SVG is worth the added file size.

Do not commit a commercial font merely because it exists on the local machine.
The editable `.tldr` interchange intentionally uses tldraw's normal sans font;
the export adapter owns custom typography.

## Custom icon

An icon definition has a view box and SVG body:

```ts
import type { DiagramConfig } from "@hraness/transmute"

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

Reference it with `"icon": "inbox"` on a rectangle or ellipse. The renderer
uses `currentColor`, so one definition works in both themes. The `.tldr`
adapter embeds the icon as an SVG image asset; the card, icon, and label remain
separate movable tldraw shapes.

To use a third-party icon package, write a small local adapter that converts the
package's data into `{ viewBox, body }`. Keep that package in the consuming
repository rather than adding it to `transmute`. Preserve the icon package's
license and attribution requirements.

Icon bodies may contain ordinary SVG geometry such as `path`, `circle`, `rect`,
`line`, `polyline`, and `polygon`. Scripts, event handlers, `foreignObject`, and
embedded web content are rejected.
