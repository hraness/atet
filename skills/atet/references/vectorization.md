# Vectorize raster artwork

When the user asks to convert caller-owned raster artwork to SVG, keep the
raster as the source and treat the SVG as a replaceable derivative:

```sh
atet image vectorize path/to/input.png --output path/to/input.svg --json
```

- Do not provide a credential for vectorization. The conversion keeps image bytes local; the initial tool provisioning can download a verified VTracer release.
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
`ATET_VTRACER_PATH` only for a compatible local 0.6.4 binary; Atet still
records its hash. Never add an upscaling model, embedded raster fallback, or
commercial font to make a trace pass.

Bounded vectorization is currently supported on macOS and Linux. On Windows,
report the deliberate `tool_platform` failure; do not bypass it with an
unbounded temporary output file.

