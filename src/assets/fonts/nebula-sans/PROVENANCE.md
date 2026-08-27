# Nebula Sans provenance

- Family: Nebula Sans
- Version: 1.010
- Use: default proportional browser text and heading face
- Upstream: https://www.nebulasans.com/
- Source archive: https://www.nebulasans.com/download/NebulaSans-1.010.zip
- Retrieved: 2026-08-27
- Archive SHA-256: `a9b56ef15e24b6e8195af7457cc75f714ecf5501fc3c20a69f546c8f589e7bdb`
- License: SIL Open Font License 1.1, retained as `LICENSE.txt`

The WOFF2 and OTF files are vendored unchanged from the official archive. Nebula
Entertainment & Broadcasting LLC reserves the font name `Nebula`; this package
distributes the unmodified original files under that name.

Atet carries the unchanged Book and Bold WOFF2 and OTF files from the canonical
`@hraness/design-kit` v0.2.1 release. Resvg loads Bold OTF directly for caption
sprites with system font discovery disabled. Diagram PNG rendering loads Book
plus Bold OTF for the ordinary proportional default while retaining system font
discovery for explicit mono and custom font roles. The WOFF2 files remain
embedded in standalone diagram SVG output.
