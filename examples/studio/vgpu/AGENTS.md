# Contents

- `heat-field.mjs` – explicit trusted Node command rendering a bounded illustrative energy graphic with vgpu.
- `heat-field.test.mjs` – CPU-only input, clock, energy and raster checks.
- `README.md` – pinned runtime requirements, execution and interpretation boundaries.

# Guidelines

- Keep import inert. Load native dependencies and acquire a device only inside the explicitly invoked render function.
- Use absolute rational frame times, original graphics and explicit sRGB output. Distinguish illustrative fields from physical simulation.
- Keep the runtime optional and separate from ATET's canonical renderer. Reject ambient GPU overrides and require observed hardware evidence.
- Retain failed output directories. Publish a manifest only after complete frame validation; never replace a prior run.
- Keep native qualification under the host scheduler; pure tests must run without vgpu or a GPU.
