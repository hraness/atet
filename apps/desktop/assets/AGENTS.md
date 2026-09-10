# Contents

- `brand-emoji/slop.camera.svg` is the original Slopcamera camera mark; `manifest.json` binds its bytes, camera emoji identity, and actual `color` variant.
- `icon.png` is its 1024-pixel desktop derivative. `brand-provenance.json` records the vector source and deterministic icon derivatives.

# Guidelines

- Keep the vector mark byte-identical to `apps/web/src/icon.svg`. Regenerate desktop and Apple icons with `bun apps/web/scripts/generate-icons.ts`; update the brand manifest digest when the SVG changes.
- Preserve historical artwork and provider evidence as historical. Do not relabel a prior raster or model output as newly authored artwork.
- Brand rendering uses the pinned local Resvg renderer, with no external resources or system fonts. Verify actual pixels and output dimensions after an artwork change.
